// Fuzzing the pure half of the sim: every layer that eats data it did not
// produce itself.
//
//   node tools/fuzz.mjs                  all targets, fixed seed
//   node tools/fuzz.mjs --list           what is covered
//   node tools/fuzz.mjs --only flight    one target
//   node tools/fuzz.mjs --cases 20000 --seed 7 --verbose
//   node tools/fuzz.mjs --known          the known-failure targets too
//
// The threat model, target by target, is written in each `note`. It is not
// "throw random bytes at a function": a function is only fuzzed with inputs it
// can really receive — a corrupt localStorage entry, a gamepad axis, a
// hand-edited operator file, a physics state that went to NaN after a crash —
// and only invariants it really promises are checked. Anything else produces
// findings nobody should act on.
//
// A target carrying `known: '<why>'` reproduces a defect nobody has fixed yet.
// It stays in the file — it is how the fix gets verified — but it is left OUT
// of the default run, because a red CI that is red on purpose stops being read.
// `--list` names them, `--known` runs them, `--only <name>` runs one. No target
// carries one today: the four that did were fixed, and each is now a gate in
// the default run.
//
// A target carrying `async: true` has an async check (the Worker pool) and runs
// through runTargetAsync with a smaller case count.
//
// The HTTP surface is fuzzed separately, against a real server: tools/fuzz-api.mjs.
// The rocktree decode path — the only bytes in this game a remote machine chose
// — is fuzzed in tools/fuzz-rocktree.mjs, which needs its own binary fixtures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './lib/fake-dom.mjs';
import {
	makeRng, pick, int, chance, anyValue, anyObject, anyArray, mutate,
	nearNumber, firstNonFinite, textLeak, pretty, runTarget, runTargetAsync, jsonText, NASTY_STRINGS,
} from './lib/fuzz.mjs';

// src/input.js reads `window` at import time (device mapping persisted in
// localStorage), the same reason tools/input-selftest.mjs mounts this.
installFakeDom();

const { KEY_ACTIONS, DEFAULT_KEY_MAP, loadKeyMap, actionForKey, rebind, keyLabel, keyMapRows } = await import('../src/key-map.js');
const { normalizeChannel, throttleFromCalibrated, CAL_CHANNELS } = await import('../src/calibration.js');
const { isValidCalibration, sticksFromCalibration, calStoreGet, calStoreSet, throttleFromAxis, padKind, defaultMapForKind, remapChannel, assumedCalibration, THROTTLE_MODE } = await import('../src/input.js');
const { FlightController, hoverThrottle, actualRate, RATE_PRESETS } = await import('../src/flightController.js');
const { Propulsion, Battery, crashThreshold, idleThrottle } = await import('../src/quad.js');
const { PROFILES, FAMILIES } = await import('../src/drone-profiles.js');
const { Geofence, NOMINAL, CAUTION, HOLD, LOST, horizontalMargin, verticalMargin } = await import('../src/geofence.js');
const bench = await import('./bench-model.mjs');
const airframe = await import('./bench-airframe.mjs');
const { rateFor } = await import('../src/rates.js');
const { throttleChain } = await import('../src/throttle.js');
const track = await import('./track-model.mjs');
const session = await import('./session-model.mjs');
const log = await import('./session-log-model.mjs');
const data = await import('./data-model.mjs');
const targetModel = await import('./target-model.mjs');
const hack = await import('./hack-model.mjs');
const { parseSceneFlag, parseSwarmFlag, SCENE_SLUG_RE } = await import('./dev-flags.mjs');
const scanner = await import('./scanner-model.mjs');
const weather = await import('./lib/weather.mjs');
const tiles = await import('./lib/tiles.mjs');
const { estimateCost } = await import('./lib/estimates.mjs');
const musicModel = await import('./music-model.mjs');
const jukebox = await import('./jukebox-model.mjs');
const terminal = await import('./terminal-model.mjs');
const targetBuild = await import('./target-build.mjs');
const entry = await import('../src/entry-state.js');
const fenceField = await import('../src/fence-field.js');
const { LiveNodeQueue, WAVE_STALL_MS } = await import('../src/live-node-queue.js');
const { createPool } = await import('../src/rocktree-worker-pool.js');
const lod = await import('./lib/rocktree/lod.mjs');
const grammars = await import('../src/hack-grammars.js');
const dialogueEngine = await import('./dialogue/engine.mjs');
const dialogueCatalog = await import('./dialogue/catalog.mjs');
const dialogueRender = await import('./dialogue/render.mjs');
const cadence = await import('./dialogue/cadence.mjs');
const { FALLBACK } = await import('../src/dialogue-fallback.js');

const ZONES = [NOMINAL, CAUTION, HOLD, LOST];
const MOTOR_IDLE_MAX = 1 + 1e-9;

// --- shared generators ------------------------------------------------------

// A stick set as input.js produces it: in contract.
const sanesticks = (r) => ({
	throttle: r(),
	roll: r() * 2 - 1,
	pitch: r() * 2 - 1,
	yaw: r() * 2 - 1,
});

// A stick set as a BROKEN input layer produces it: a gamepad axis that read
// NaN, a calibration whose span was zero, a stick stuck past its endpoint.
const wildSticks = (r) => ({
	throttle: nearNumber(r, 0, 1),
	roll: nearNumber(r, -1, 1),
	pitch: nearNumber(r, -1, 1),
	yaw: nearNumber(r, -1, 1),
});

const unitQuat = (r) => {
	const [a, b, c, d] = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
	const n = Math.hypot(a, b, c, d) || 1;
	return { x: a / n, y: b / n, z: c / n, w: d / n };
};

// The state Rapier hands back. `wild` covers the case the codebase already
// knows can happen: a fall through the terrain put the body at y = -2465 m
// (see the #182 guard in main.js), and worse is reachable with a NaN impulse.
const flightState = (r, wild) => ({
	rotation: wild && chance(r, 0.4) ? { x: nearNumber(r, -1, 1), y: nearNumber(r, -1, 1), z: nearNumber(r, -1, 1), w: nearNumber(r, -1, 1) } : unitQuat(r),
	angularVelocity: { x: wild ? nearNumber(r, -50, 50) : (r() - 0.5) * 40, y: wild ? nearNumber(r, -50, 50) : (r() - 0.5) * 40, z: wild ? nearNumber(r, -50, 50) : (r() - 0.5) * 40 },
	position: { x: wild ? nearNumber(r, -1e4, 1e4) : (r() - 0.5) * 600, y: wild ? nearNumber(r, -3000, 3000) : r() * 300, z: wild ? nearNumber(r, -1e4, 1e4) : (r() - 0.5) * 600 },
	velocity: { x: wild ? nearNumber(r, -80, 80) : (r() - 0.5) * 60, y: wild ? nearNumber(r, -80, 80) : (r() - 0.5) * 60, z: wild ? nearNumber(r, -80, 80) : (r() - 0.5) * 60 },
});

const someProfile = (r) => PROFILES[pick(r, FAMILIES)];

// What survives being written to a file and read back. `undefined` members,
// symbols and prototype-less objects do not.
const jsonRoundTrip = (v) => { try { return JSON.parse(jsonText(v)); } catch { return null; } };

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A ring the way the map GUI hands one to the server. The gate is
// requirePoly() in server/api.mjs, mirrored here rather than imported: the
// server file drags the whole API in, and what matters is the RULE — a ring
// that gets past it is a trace someone really drew.
// server/api.mjs:751 and its neighbour. Mirrored rather than imported, same
// reason as the ring gate below: what matters is the RULE, and importing the
// API drags the whole server in. requireAffordable() applies both — the first
// to either zone shape, the second only to a trace.
const MAX_GRID_CELLS = 4_000_000;
const MAX_POLY_WORK = 20_000_000;

// Timing a trace means RUNNING it, and a ceiling-sized trace costs a third of a
// second: five thousand of them turn an eleven-second suite into a three-minute
// one. So map-poly-cost only computes a trace that is the most expensive one it
// has accepted so far — the running record. That is deterministic (same seed,
// same records), it is O(log n) computations rather than O(n) so raising
// `--cases` does not make the target slower, and it always spends the time on
// the worst case rather than on whichever trace happened to come first: lift
// either ceiling and the records climb into the seconds, which is the finding.
const POLY_TIMED_FROM = 1_000_000;
// Never reset: one process is one run of the target.
let polyWorst = 0;

const acceptsPoly = (p) => {
	if (!Array.isArray(p) || p.length % 2 !== 0 || p.length < 6 || p.length > 400) return false;
	if (!p.every(Number.isFinite)) return false;
	const b = tiles.polygonBounds(p);
	if (b.south < -85 || b.north > 85 || b.west < -180 || b.east > 180) return false;
	if (b.south === b.north || b.west === b.east) return false;
	return b.east - b.west < 180;
};

// A trace around one point. `spanDeg` bounds how big it is; the shapes below
// are the ones leaflet-geoman really produces once a hand is on the mouse —
// a doubled vertex from a double click, three collinear points, a bow tie.
function drawnRing(r, spanDeg) {
	const lat0 = nearNumber(r, -60, 60), lon0 = nearNumber(r, -170, 170);
	const lat = Number.isFinite(lat0) ? Math.max(-80, Math.min(80, lat0)) : 48.85;
	const lon = Number.isFinite(lon0) ? Math.max(-175, Math.min(175, lon0)) : 2.29;
	const n = int(r, 3, 12);
	const ring = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		ring.push(lat + Math.cos(a) * spanDeg * (0.2 + r()), lon + Math.sin(a) * spanDeg * (0.2 + r()));
	}
	switch (int(r, 0, 4)) {
		case 0: ring.push(ring[0], ring[1]); break;                       // doubled vertex
		case 1: for (let i = 2; i < ring.length; i += 2) ring[i] = ring[0] + (i / 2) * 1e-4 * spanDeg; break;  // near-collinear
		case 2: { const i = int(r, 1, n - 1) * 2; [ring[0], ring[i]] = [ring[i], ring[0]]; break; }            // bow tie
		case 3: ring[2] = ring[0]; ring[3] = ring[1]; break;              // repeated point mid-ring
		default: break;
	}
	return ring;
}

// One day of an Open-Meteo `daily` series, as the API hands it over: numbers,
// sometimes nulls (a model that does not serve the field), sometimes a string.
const meteoValue = (r, lo, hi) => {
	switch (int(r, 0, 5)) {
		case 0: return null;
		case 1: return pick(r, [NaN, Infinity, -Infinity, -0, 1e308, -1e308]);
		case 2: return String(nearNumber(r, lo, hi));
		default: return nearNumber(r, lo, hi);
	}
};

// A day of a STORED snapshot. The world state is a JSON file on disk that no
// validator reads back (server/api.mjs GET /:id/weather serves it verbatim),
// so this is the shape a hand-edited one really has.
// A day of a STORED snapshot. `sanitize()` is the ONLY writer — every path in
// weather-source.mjs goes through it — so the file holds exactly its output,
// and inventing a shape it cannot produce would fuzz a caller that does not
// exist. What varies is what it was handed: `1e400` in a JSON payload parses
// to Infinity, an absent field arrives as undefined, a string comes through as
// a string. `date` and `confidence` are added by makeSnapshot() on top.
const rawDay = (r) => ({
	windSpeed: pick(r, [0, 3.2, 40, 120, null, undefined, '5', NaN, Infinity, -1]),
	windGust: pick(r, [0, 6, 90, null, undefined, NaN, Infinity]),
	// Finite only: what ±Infinity does here is weather-sanitize's finding, and
	// letting it through would make every target downstream report it again.
	windDir: pick(r, [0, 180, 359, 359.6, -30, 1e9, null, undefined, NaN, '90']),
	rateMmH: pick(r, [0, 0.1, 2.5, 200, null, undefined, NaN]),
	precipMm: pick(r, [0, 12, null, NaN]),
	visibilityM: pick(r, [60000, 400, 10, 1e9, null, undefined, NaN, Infinity]),
	cloudPct: pick(r, [0, 60, 100, 400, null, undefined, NaN]),
});
const storedDay = (r) => ({
	...weather.sanitize(rawDay(r)),
	date: pick(r, ['2026-09-13', '2026-09-14']),
	confidence: weather.confidence(pick(r, weather.SOURCES), int(r, 0, 8)),
});

// A live gamepad-free stub of Physics: entry-state only ever asks the world
// "is there ground at (x, z)" and "is anything between these two points".
const stubPhysics = (kind) => ({
	groundBelow: (x, _y, z) => (kind === 'solid' ? 0
		: kind === 'void' ? null
		: kind === 'corridor' ? (Math.abs(x - z) < 30 ? 0 : null)
		: (Math.abs(x % 97) < 20 ? x * 0 + 12 : null)),
	obstructionBetween: () => ({ blocked: kind === 'corridor', span: 3 }),
});

// A scene manifest as prep.mjs writes one — and as a degenerate polygon, an
// older prep or a hand edit leaves it. The SHAPE stays right (six numbers and
// a spawn): a manifest missing its bbox fails at loadManifest, long before
// anything here, and fuzzing that would fuzz a caller that does not exist.
const someManifest = (r) => {
	// Every number is FINITE: manifest.json is JSON, and prep.mjs writes metres.
	// Degenerate, inverted and absurdly large are all reachable; NaN is not.
	const metre = (lo, hi) => { const v = nearNumber(r, lo, hi); return Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0; };
	const span = () => pick(r, [1200, 600, 60, 2, 0.01, 0, 1e5]);
	const w = span(), d = span();
	const lo = metre(-50, 300), hi = metre(-50, 300);
	return {
		bbox: { min: [-w / 2, Math.min(lo, hi), -d / 2], max: [w / 2, Math.max(lo, hi), d / 2] },
		spawn: { x: metre(-w, w), y: metre(-50, 300), z: metre(-d, d) },
	};
};

// The real dialogue corpus, when it is on disk. src/dialogue.js fetches these
// shards at runtime, so fuzzing a mutation of a REAL entry is fuzzing a shard
// that half-downloaded or that an older build wrote — not an invented shape.
// Absent, the embedded fallback pack stands in and the target still runs.
const CORPUS = (() => {
	const dir = path.join(HERE, '../public/dialogue');
	try {
		return fs.readdirSync(dir)
			.filter((f) => f.endsWith('.json') && f !== 'manifest.json')
			.flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).entries ?? []);
	} catch { return []; }
})();

// A music manifest as public/music.json holds one. `validateManifest` is the
// gate src/music.js runs at boot, so anything it calls clean has to render.
const musicManifest = (r) => ({
	schemaVersion: pick(r, [1, 1, 1, 0, 2, '1', null, undefined]),
	tracks: Array.from({ length: int(r, 0, 6) }, (_, i) => ({
		id: pick(r, [`menu-${i}`, `race5-${i}`, '', 42, null, 'menu-0']),
		pool: pick(r, [...musicModel.MUSIC_POOLS, 'nope', null]),
		file: pick(r, [`music/${i}.opus`, '', null, 'music/0.opus']),
		durS: pick(r, [90, 0, -1, NaN, null, 1e9, '90']),
		bpm: pick(r, [128, 0, NaN, null, '128']),
	})),
});

// Telemetry is bounded field by field since #83 (session.TELEMETRY_MAX), so the
// generator aims AT the bounds rather than away from them: a third of the
// values land just under the ceiling, a third just over it, the rest is
// ordinary flight. The clamp that used to live here is gone with the defect.
const telemetryValue = (r, k, hi) => {
	const max = session.TELEMETRY_MAX[k];
	switch (int(r, 0, 3)) {
		case 0: return nearNumber(r, max * 0.99, max);
		case 1: return nearNumber(r, max, max * 4);
		case 2: return pick(r, [max, max + 1, max - 1e-9, 1e308, Infinity, -0]);
		default: return nearNumber(r, 0, hi);
	}
};

// A session as the operator file holds one: valid shape, hostile numbers. This
// is what a text layer really sees — the file passed validateSession once, and
// then someone flew for 0 seconds, or the clock jumped.
const storedSession = (r) => ({
	id: `${pick(r, ['tour-eiffel', 'a', 'x-y-z'])}-${int(r, 4096, 65535).toString(16)}`,
	operatorId: 'neo-0000',
	// `{toString: null}` is valid JSON and breaks `String(v)` — the shape that
	// turns a named refusal into an engine TypeError.
	area: pick(r, ['tour-eiffel', 'a', '', 'ile-de-la-cite-et-ile-saint-louis', 'x'.repeat(200), { toString: null }]),
	seq: pick(r, [1, 0, -1, 99999, 1e9, 1.5, NaN]),
	targetSeq: pick(r, [1, null, undefined, 0]),
	target: chance(r, 0.5) ? null : {
		family: pick(r, [...targetModel.TARGET_FAMILIES, 'swarmNode']),
		classHint: pick(r, [null, 'MESH', '']),
		hackType: pick(r, [null, ...targetModel.HACK_TYPES]),
		signal: { rssiDbm: nearNumber(r, -120, -20), mode: pick(r, ['ANALOG', 'DIGITAL']) },
		scannedAt: null, intel: {}, scan: null, swarm: null,
	},
	weatherSnapshot: chance(r, 0.5) ? null : {
		zone: '48.86,2.29', day: '2026-08-28', source: 'open-meteo',
		regime: pick(r, ['CLEAR', 'RAIN', null, '']),
		confidence: nearNumber(r, 0, 1),
		day0: {
			regime: pick(r, ['CLEAR', null]),
			windSpeed: nearNumber(r, 0, 30), windDir: nearNumber(r, 0, 360),
			windGust: nearNumber(r, 0, 40), rateMmH: nearNumber(r, 0, 50),
			visibilityM: nearNumber(r, 0, 20000), cloudPct: nearNumber(r, 0, 100),
		},
	},
	start: pick(r, ['2026-08-28T21:42:10.000Z', '', 'not a date', null, '0000-01-01T00:00:00.000Z']),
	end: pick(r, ['2026-08-28T22:00:52.000Z', null, '']),
	result: pick(r, ['CRASHED', 'PENDING']),
	flightTelemetry: {
		durationS: telemetryValue(r, 'durationS', 3600), distanceM: telemetryValue(r, 'distanceM', 50000),
		maxSpeedMs: telemetryValue(r, 'maxSpeedMs', 60), maxRateDps: telemetryValue(r, 'maxRateDps', 2000),
		maxAltitudeM: telemetryValue(r, 'maxAltitudeM', 500),
	},
	photos: chance(r, 0.3) ? [{ w: int(r, 1, 4000), h: int(r, 1, 4000), ts: '2026-08-28T21:50:00.000Z' }] : [],
	comment: pick(r, [null, '', 'x'.repeat(400), 'note']),
	randomart: pick(r, [null, '+--[ART]--+']),
});

// --- targets ----------------------------------------------------------------

const targets = [

{
	name: 'keymap',
	note: 'localStorage fpvtp.keyMap — the player can edit it, and an old build wrote a different shape',
	gen(r, i) {
		if (i % 4 === 0) return { raw: jsonText(anyValue(r, 3)) };
		if (i % 4 === 1) return { raw: anyValue(r, 3) };
		if (i % 4 === 2) return { raw: mutate(r, DEFAULT_KEY_MAP) };
		return { raw: mutate(r, DEFAULT_KEY_MAP), rebindTo: pick(r, [...KEY_ACTIONS.map((a) => a.id), 'nope', '', null]), key: anyValue(r, 1) };
	},
	check({ raw, rebindTo, key }) {
		const map = loadKeyMap(raw);
		// Contract: a corrupt entry can never keep the sim from booting, and it
		// can never leave an action unreachable.
		for (const action of KEY_ACTIONS) {
			const keys = map[action.id];
			if (!Array.isArray(keys)) return `loadKeyMap dropped ${action.id}`;
			if (keys.length === 0) return `${action.id} left with no key`;
			if (keys.some((k) => typeof k !== 'string' || k.length === 0)) return `${action.id} holds a non-key: ${pretty(keys)}`;
			if (keys.some((k) => k !== k.toLowerCase())) return `${action.id} holds an unnormalized key: ${pretty(keys)}`;
		}
		const rows = keyMapRows(map);
		if (rows.length !== KEY_ACTIONS.length) return 'keyMapRows lost a row';
		for (const row of rows) {
			if (row.keys.some((k) => typeof k !== 'string' || k.length === 0)) return `keyLabel produced an empty label in ${row.id}`;
		}
		if (actionForKey(map, key) !== null && !KEY_ACTIONS.some((a) => a.id === actionForKey(map, key))) return 'actionForKey invented an action';
		if (rebindTo !== undefined) {
			const { map: next } = rebind(map, rebindTo, key);
			// The documented promise of rebind(): nobody can ever be stranded.
			for (const action of KEY_ACTIONS) {
				if (!Array.isArray(next[action.id]) || next[action.id].length === 0) return `rebind stranded ${action.id}`;
			}
		}
		return null;
	},
},

{
	name: 'calibration',
	note: 'localStorage fpvtp.calibration + live gamepad axes — what the sticks are computed from',
	gen(r) {
		const channel = () => ({ axis: int(r, 0, 8), center: nearNumber(r, -1, 1), span: nearNumber(r, 0, 2), invert: chance(r, 0.5) });
		const cal = {
			throttleMode: pick(r, ['full', 'half']),
			// Past 1 on purpose: the rescaling below the deadband divides by
			// (1 - deadband).
			deadband: nearNumber(r, 0, 1.2),
			channels: {
				throttle: { axis: int(r, 0, 8), lo: nearNumber(r, -1, 1), hi: nearNumber(r, -1, 1) },
				yaw: channel(), pitch: channel(), roll: channel(),
			},
		};
		// Axis values as navigator.getGamepads() reports them: doubles, usually
		// -1..1, sometimes past the endpoint on an uncalibrated radio. Finite,
		// though — a NaN axis is not something hardware produces, and what the
		// controller does with one is covered by flight-recovery instead.
		// Bounded, too: the Gamepad API defines an axis as a double in [-1, 1]
		// and a badly scaled driver overshoots it by a little. It does not
		// report 1e308 — and one of those makes an accepted calibration whose
		// travel overflows to Infinity read NaN, which is a finding about a
		// caller that cannot exist.
		const signals = [];
		for (let i = 0; i < 10; i++) {
			const v = nearNumber(r, -1, 1);
			signals.push(Number.isFinite(v) ? Math.max(-4, Math.min(4, v)) : 0);
		}
		return { cal, signals };
	},
	check({ cal, signals }) {
		// Only calibrations the app itself accepts are checked: isValidCalibration
		// is the gate between the stored file and the flight.
		if (!isValidCalibration(cal)) return null;
		const sticks = sticksFromCalibration(signals, cal);
		const bad = firstNonFinite(sticks);
		if (bad) return `accepted calibration yields a non-finite stick: ${bad}`;
		if (sticks.throttle < 0 || sticks.throttle > 1) return `throttle out of 0..1: ${sticks.throttle}`;
		for (const axis of ['roll', 'pitch', 'yaw']) {
			if (sticks[axis] < -1 || sticks[axis] > 1) return `${axis} out of -1..1: ${sticks[axis]}`;
		}
		return null;
	},
},

{
	name: 'input-helpers',
	note: 'gamepad identification and manual remapping — ids and axis indices come from the browser',
	gen(r) {
		return {
			id: chance(r, 0.5) ? pick(r, NASTY_STRINGS) : `${pick(r, ['Xbox', 'Sony', 'FrSky', ''])} ${int(r, 0, 9999)}`,
			axis: pick(r, [0, 3, -1, 99, 1.5, NaN, undefined]),
			invert: anyValue(r, 0),
			channel: pick(r, ['throttle', 'yaw', 'pitch', 'roll', 'nope']),
			v: nearNumber(r, -1, 1),
			// Only the two real modes: throttleModeForKind() is the only producer,
			// and it returns one of these two. Feeding 'nope' would fuzz a caller
			// that does not exist.
			mode: pick(r, [THROTTLE_MODE.radio, THROTTLE_MODE.gamepad]),
			store: chance(r, 0.5) ? anyObject(r, 2) : null,
			padId: chance(r, 0.5) ? pick(r, NASTY_STRINGS) : 'pad',
		};
	},
	check({ id, axis, invert, channel, v, mode, store, padId }) {
		const kind = padKind(id);
		if (typeof kind !== 'string') return `padKind returned ${pretty(kind)}`;
		const t = throttleFromAxis(v, mode);
		// A NaN axis is the input layer's problem, not this function's; anything
		// finite in must stay inside 0..1.
		if (Number.isFinite(v) && !(t >= 0 && t <= 1)) return `throttleFromAxis(${v}) = ${t}`;
		const map = defaultMapForKind(kind);
		const cal = assumedCalibration(map, mode);
		if (!isValidCalibration(cal)) return 'assumedCalibration built a calibration the app itself rejects';
		if (CAL_CHANNELS.includes(channel)) {
			const next = remapChannel(cal, channel, axis, invert);
			// A remap must never produce a calibration that fails the gate: the
			// player would silently lose every measured endpoint.
			if (Number.isFinite(axis) && !isValidCalibration(next)) return `remapChannel(${channel}, ${axis}) produced an invalid calibration`;
		}
		if (calStoreGet(store, padId) !== null && !isValidCalibration(calStoreGet(store, padId))) return 'calStoreGet handed back a calibration it should have rejected';
		const stored = calStoreSet(store, padId, cal);
		if (calStoreGet(stored, padId) === null) return 'a calibration written by calStoreSet does not read back';
		return null;
	},
},

{
	name: 'flight',
	note: 'flightController.js under in-contract sticks/state — the loop main.js runs 250x a second',
	gen(r) {
		const frames = [];
		const n = int(r, 1, 60);
		for (let i = 0; i < n; i++) frames.push({ sticks: sanesticks(r), state: flightState(r, false) });
		return {
			family: pick(r, FAMILIES),
			preset: pick(r, [...Object.keys(RATE_PRESETS), undefined]),
			mode: pick(r, ['acro', 'angle', 'altitude']),
			// main.js fixes the step at 1/250; entry-state and the bench use their
			// own. Everything here is a step a caller in the repo really passes.
			dt: pick(r, [1 / 250, 1 / 500, 1 / 120, 1 / 60, 0.25 / 60]),
			frames,
		};
	},
	check({ family, preset, mode, dt, frames }) {
		const fc = new FlightController({ profile: PROFILES[family], preset });
		fc.setMode(mode);
		for (const [i, f] of frames.entries()) {
			const out = fc.update(f.sticks, f.state, dt);
			const bad = firstNonFinite(out);
			if (bad) return `frame ${i}: ${bad}`;
			for (const m of out.motors) {
				if (!(m >= 0 && m <= MOTOR_IDLE_MAX)) return `frame ${i}: motor out of 0..1 (${m})`;
			}
			if (!(out.throttle >= -1e-9)) return `frame ${i}: negative throttle ${out.throttle}`;
		}
		return null;
	},
},

{
	name: 'flight-recovery',
	note: 'one bad frame (NaN stick or NaN body state) must not kill the controller for the rest of the flight',
	gen(r) {
		return {
			family: pick(r, FAMILIES),
			mode: pick(r, ['acro', 'angle', 'altitude']),
			dt: 1 / 250,
			bad: { sticks: wildSticks(r), state: flightState(r, true) },
			// How long the poisoned frame is followed by clean ones. A filter that
			// took a NaN never lets go, so even 500 clean frames do not help — which
			// is exactly the difference this target measures.
			clean: int(r, 50, 200),
			after: sanesticks(r),
		};
	},
	check({ family, mode, dt, bad, clean, after }) {
		const fc = new FlightController({ profile: PROFILES[family] });
		fc.setMode(mode);
		const state = flightState(makeRng(1), false);
		for (let i = 0; i < 20; i++) fc.update(after, state, dt);
		fc.update(bad.sticks, bad.state, dt);
		let out = null;
		for (let i = 0; i < clean; i++) out = fc.update(after, state, dt);
		const poison = firstNonFinite(out);
		if (poison) return `${clean} clean frames after one bad frame, still ${poison}`;
		return null;
	},
},

{
	name: 'quad',
	note: 'quad.js air model — motors from the mixer, air state from physics.js',
	gen(r) {
		const steps = [];
		const n = int(r, 1, 40);
		for (let i = 0; i < n; i++) {
			steps.push({
				motors: [r(), r(), r(), r()],
				air: {
					v: { x: (r() - 0.5) * 80, y: (r() - 0.5) * 80, z: (r() - 0.5) * 80 },
					omega: { x: (r() - 0.5) * 60, y: (r() - 0.5) * 60, z: (r() - 0.5) * 60 },
					// null is the documented "unknown" — the ray found nothing below.
					agl: chance(r, 0.2) ? null : r() * 120,
					shake: r() * 12,
				},
			});
		}
		return { family: pick(r, FAMILIES), dt: pick(r, [1 / 250, 1 / 500, 1 / 60]), steps };
	},
	check({ family, dt, steps }) {
		const prop = new Propulsion({ profile: PROFILES[family] });
		// `iLimit` is Infinity when a family has opted out of the ESC current
		// ceiling (src/motor.js), which every family does today. It is a sentinel
		// in a constants object, not state, and step() returns the instance those
		// constants hang off — so the walker reaches it. Swapped for a finite
		// stand-in here rather than exempted by path, so a NEW infinity anywhere
		// under `_motor` still fails.
		if (prop._motor && prop._motor.iLimit === Infinity) prop._motor = { ...prop._motor, iLimit: 1e9 };
		for (const [i, s] of steps.entries()) {
			const out = prop.step(s.motors, s.air, dt);
			const bad = firstNonFinite(out);
			if (bad) return `step ${i}: ${bad}`;
			if (!(prop.battery.soc >= 0 && prop.battery.soc <= 1)) return `step ${i}: soc = ${prop.battery.soc}`;
			if (!(prop.battery.voltage > 0)) return `step ${i}: voltage = ${prop.battery.voltage}`;
			for (const w of prop.omega) if (!(w >= 0)) return `step ${i}: negative rotor speed ${w}`;
		}
		return null;
	},
},

{
	name: 'quad-helpers',
	note: 'the per-family derivations — a profile is data, and crashThreshold reads a quaternion straight from Rapier',
	gen(r) {
		return {
			family: pick(r, FAMILIES),
			rotation: chance(r, 0.5) ? unitQuat(r) : { x: nearNumber(r, -1, 1), y: nearNumber(r, -1, 1), z: nearNumber(r, -1, 1), w: nearNumber(r, -1, 1) },
			stick: nearNumber(r, -1, 1),
			rates: pick(r, Object.values(RATE_PRESETS)).roll,
			load: nearNumber(r, 0, 4),
			dt: pick(r, [1 / 250, 1 / 60, 0]),
		};
	},
	check({ family, rotation, stick, rates, load, dt }) {
		const profile = PROFILES[family];
		const th = crashThreshold(rotation);
		if (!Number.isFinite(th) || th <= 0) return `crashThreshold = ${th}`;
		const idle = idleThrottle(profile);
		if (!(idle > 0 && idle < 1)) return `idleThrottle(${family}) = ${idle}`;
		const hover = hoverThrottle(profile, rotation);
		if (Number.isFinite(rotation.x + rotation.y + rotation.z + rotation.w) && !(hover >= 0 && hover <= 1)) return `hoverThrottle = ${hover}`;
		if (Number.isFinite(stick)) {
			const rate = actualRate(stick, rates);
			if (!Number.isFinite(rate)) return `actualRate(${stick}) = ${rate}`;
		}
		const bat = new Battery(profile.battery);
		if (Number.isFinite(load) && Number.isFinite(dt)) {
			bat.update(Math.max(0, load), Math.max(0, dt));
			if (!(bat.voltage > 0) || !(bat.soc >= 0 && bat.soc <= 1)) return `battery went to voltage ${bat.voltage}, soc ${bat.soc}`;
		}
		return null;
	},
},

{
	name: 'geofence',
	note: 'geofence.js against a manifest bbox — the bbox is JSON on disk, and a degenerate map must not break the fence',
	gen(r) {
		// Degenerate on purpose — a zero span, an inverted box, a map a metre
		// wide — but always six real numbers: that is what prep.mjs writes into
		// manifest.json, and a bbox with a hole in it is a different bug report
		// (see the fuzz notes on a corrupt manifest).
		const span = () => pick(r, [1200, 600, 60, 2, 0, -50, 1e6]);
		// Metres, as prep.mjs writes them and as Rapier reports a position.
		// Bounded well past anything a map or a fall produces, but short of the
		// range where the subtraction itself overflows: `min.y = 1e308` and a
		// drone at -1e308 make a margin of -Infinity, which is arithmetic
		// breaking down rather than the fence doing so.
		const metres = (lo, hi) => { const v = nearNumber(r, lo, hi); return Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0; };
		const alt = () => metres(-50, 400);
		const bbox = {
			min: [-span() / 2, alt(), -span() / 2],
			max: [span() / 2, alt(), span() / 2],
		};
		const path = [];
		const n = int(r, 1, 40);
		for (let i = 0; i < n; i++) path.push({ x: metres(-800, 800), y: metres(-200, 600), z: metres(-800, 800) });
		return { bbox, path };
	},
	check({ bbox, path }) {
		const fence = new Geofence(bbox);
		for (const [i, p] of path.entries()) {
			if (!Number.isFinite(p.x + p.y + p.z)) continue;   // a NaN position is main.js's guard (#182)
			const out = fence.update(p);
			if (!ZONES.includes(out.zone)) return `step ${i}: unknown zone ${pretty(out.zone)}`;
			const bad = firstNonFinite(out.push);
			if (bad) return `step ${i}: push ${bad}`;
			if (!Number.isFinite(out.lossDb) || out.lossDb < 0) return `step ${i}: lossDb = ${out.lossDb}`;
			// `t` is signed by design — negative deep inside the map, over 1 past
			// the edge (main.js reads how far past). Only NaN is a defect, and
			// only a map with a real corridor can be asked for a finite one: a
			// zero-size bbox collapses caution and lost onto each other, and the
			// division that measures progress has nothing to divide by.
			if (Number.isNaN(out.t)) return `step ${i}: t = NaN`;
			const corridor = Math.min(bbox.max[0] - bbox.min[0], bbox.max[2] - bbox.min[2]);
			if (corridor > 0 && !Number.isFinite(out.t)) return `step ${i}: t = ${out.t}`;
			if (!Number.isFinite(out.marginM) && Number.isFinite(p.y) && corridor > 0) return `step ${i}: marginM = ${out.marginM}`;
			if (Number.isNaN(out.marginM)) return `step ${i}: marginM = NaN`;
			if (typeof out.over !== 'boolean') return `step ${i}: over = ${pretty(out.over)}`;
			// The recall force is what pushes the drone back; an unbounded one
			// would fling it across the map in a single step.
			const mag = Math.hypot(out.push.x, out.push.y, out.push.z);
			if (mag > 100) return `step ${i}: recall acceleration ${mag.toFixed(1)} m/s² (over 10 g)`;
		}
		return null;
	},
},

{
	name: 'bench-airframe',
	note: 'the bench build (#159) — a base, a bill of materials and 45 typed parameters, documented as "brings back, never rejects"',
	gen(r, i) {
		// Three sources, because the three failure modes are different: junk
		// from disk, a plausible config with one field mutated, and an override
		// map full of values nobody should be able to type.
		if (i % 3 === 0) return anyValue(r, 3);
		if (i % 3 === 1) return mutate(r, bench.BENCH_DEFAULTS.airframe, 3);
		const overrides = {};
		for (const key of [...airframe.PARAMS.keys()]) {
			if (r() < 0.75) continue;
			overrides[key] = anyValue(r, 2);
		}
		return { family: FAMILIES[Math.floor(r() * FAMILIES.length)], base: ['NOMINAL', 'INDIVIDUAL', 'CUSTOM', 'MAGIC'][Math.floor(r() * 4)], overrides };
	},
	check(raw) {
		const a = airframe.normalizeAirframe(raw, { families: FAMILIES });
		if (!FAMILIES.includes(a.family)) return `unknown family ${pretty(a.family)}`;
		if (!airframe.BUILD_BASES.includes(a.base)) return `unknown base ${pretty(a.base)}`;
		// Idempotence: the normalizer runs again on its own output at every read.
		// A fixed point is what keeps a stored build from drifting.
		const again = airframe.normalizeAirframe(a, { families: FAMILIES });
		if (JSON.stringify(again) !== JSON.stringify(a)) return 'normalizeAirframe is not idempotent';

		// A resolvable build, always: the screen has no error state.
		const res = airframe.resolveBenchAirframe(a);
		const bad = firstNonFinite(res.profile);
		if (bad) return `resolved profile holds ${bad}`;
		if (!(res.profile.mass > 0)) return `mass ${pretty(res.profile.mass)}`;
		if (!(res.profile.inertia.x > 0 && res.profile.inertia.y > 0 && res.profile.inertia.z > 0)) {
			return 'an inertia reached zero — a body Rapier cannot rotate';
		}
		if (res.rates) {
			for (const axis of ['roll', 'pitch', 'yaw']) {
				for (const stick of [-1, 0, 1]) {
					const deg = rateFor(stick, res.rates[axis]);
					if (!Number.isFinite(deg)) return `rateFor(${stick}, ${axis}) = ${pretty(deg)}`;
				}
			}
		}
		if (res.throttle) {
			for (const u of [0, 0.5, 1]) {
				const out = throttleChain(u, res.throttle);
				if (!Number.isFinite(out)) return `throttleChain(${u}) = ${pretty(out)}`;
			}
		}
		const derivedBad = firstNonFinite(res.derived);
		if (derivedBad) return `the readout holds ${derivedBad}`;
		// What the two screens print, in full.
		const leak = textLeak([
			airframe.airframeSummary(a),
			...airframe.buildWarnings(a.parts ?? airframe.defaultParts(a.family), a.family),
			...[...airframe.PARAMS.values()].map((param) => airframe.formatParam(param.key, airframe.paramValue(param.key, {
				profile: res.profile, rates: res.ratesView, rateFamily: res.rateFamily,
			}))),
		]);
		if (leak) return `airframe screen ${leak}`;
		// And the identity is a hash, not an accident: same build, same hash.
		if (airframe.airframeIdentity(a) !== res.identity) return 'identity is not stable';
		return null;
	},
},

{
	name: 'bench-config',
	note: 'localStorage fpvtp.bench — the sandbox config, documented as "never throws, always playable"',
	gen(r, i) {
		if (i % 3 === 0) return { raw: jsonText(anyValue(r, 3)), text: true };
		if (i % 3 === 1) return { raw: mutate(r, bench.BENCH_DEFAULTS, 3) };
		return { raw: anyValue(r, 3) };
	},
	check({ raw, text }) {
		const config = text ? bench.parseBenchConfig(raw, { families: FAMILIES }) : bench.normalizeBenchConfig(raw, { families: FAMILIES });
		const bad = firstNonFinite(config);
		if (bad) return `normalized config holds ${bad}`;
		if (!FAMILIES.includes(config.airframe.family)) return `unknown family ${pretty(config.airframe.family)}`;
		if (!bench.ENTRY_MODES.includes(config.entry)) return `unknown entry ${pretty(config.entry)}`;
		// Idempotence: the normalizer is run again on its own output on every
		// read. A fixed point is what keeps a stored config from drifting.
		const again = bench.normalizeBenchConfig(config, { families: FAMILIES });
		if (JSON.stringify(again) !== JSON.stringify(config)) return 'normalizeBenchConfig is not idempotent';
		// And everything downstream of it must survive it.
		const params = bench.benchSimParams(config);
		const paramBad = firstNonFinite(params);
		if (paramBad) return `benchSimParams holds ${paramBad}`;
		// The BUILD row is skipped: its value is the seed string the player chose,
		// and a player who names a build "undefined" gets to read it back.
		const rows = bench.benchRows(config);
		const leak = textLeak(rows.filter((row) => row.key !== 'seed').map((row) => row.value ?? ''));
		if (leak) return `benchRows ${leak}`;
		bench.benchBlockers(config, { scenes: [] });
		bench.benchDate(config, new Date(0));
		if (bench.serializeBenchConfig(config).length === 0) return 'serializeBenchConfig produced nothing';
		return null;
	},
},

{
	name: 'track',
	note: 'flight tracks — written by the browser, stored as a file, read back by the server and the map',
	gen(r, i) {
		const samples = [];
		const n = int(r, 0, 30);
		for (let k = 0; k < n; k++) {
			samples.push({
				t: nearNumber(r, 0, 3600), lat: nearNumber(r, -90, 90), lon: nearNumber(r, -180, 180),
				alt: nearNumber(r, -500, 3000), spd: nearNumber(r, 0, 60),
				thr: nearNumber(r, 0, 1), rate: nearNumber(r, 0, 2000),
			});
		}
		const events = {
			start: chance(r, 0.5) ? { lat: nearNumber(r, -90, 90), lon: nearNumber(r, -180, 180) } : anyValue(r, 1),
			end: chance(r, 0.5) ? { lat: nearNumber(r, -90, 90), lon: nearNumber(r, -180, 180), alt: nearNumber(r, -100, 900), spd: nearNumber(r, 0, 60), result: pick(r, ['CRASHED', 'LOST', 'nope']) } : anyValue(r, 1),
			photos: chance(r, 0.5) ? [{ i: int(r, 0, 100), lat: nearNumber(r, -90, 90), lon: nearNumber(r, -180, 180), heading: nearNumber(r, -720, 720) }] : anyValue(r, 1),
		};
		// Every other case fuzzes the READ side instead: a stored file mutated
		// the way a truncated write or an older build would leave it. Through a
		// JSON round-trip, because that is what the file IS — a symbol or a
		// prototype-less object cannot be in one, and fuzzing the validator with
		// values JSON cannot carry only reports on a caller that does not exist.
		const stored = i % 2 === 1 ? jsonRoundTrip(mutate(r, track.encodeTrack(samples, events), 3)) : null;
		return { samples, events, stored };
	},
	check({ samples, events, stored }) {
		if (stored) {
			// The read side is allowed to reject — it must never accept garbage
			// and then hand back numbers that are not numbers.
			let decoded;
			try { decoded = track.decodeTrack(stored); } catch (err) {
				// A TypeError is the engine complaining, not the validator
				// refusing: the caller gets "Cannot convert object to primitive
				// value" where it needed "unknown version".
				if (err instanceof TypeError) return `decodeTrack refused with an engine error instead of naming the problem: ${err.message}`;
				if (err instanceof Error && err.message.startsWith('track')) return null;
				return `decodeTrack threw something other than a track error: ${err?.name}: ${err?.message}`;
			}
			const bad = firstNonFinite(decoded);
			if (bad) return `decodeTrack accepted a file and produced ${bad}`;
			return null;
		}
		const encoded = track.encodeTrack(samples, events);
		// The write side's contract: whatever it is handed, what it produces is
		// a file the read side accepts. Anything else is a track lost on disk.
		try { track.validateTrack(encoded); } catch (err) {
			return `encodeTrack produced a file validateTrack rejects: ${err.message}`;
		}
		const decoded = track.decodeTrack(encoded);
		const bad = firstNonFinite(decoded);
		if (bad) return `round-trip produced ${bad}`;
		const entry = track.trackIndexEntry(encoded, { sessionId: 'x-0000' });
		const entryBad = firstNonFinite(entry);
		if (entryBad) return `trackIndexEntry holds ${entryBad}`;
		const bounds = track.trackBounds(entry);
		if (bounds && firstNonFinite(bounds)) return `trackBounds holds ${firstNonFinite(bounds)}`;
		const line = track.decimate(decoded.samples.map((s) => [s.lat, s.lon]), 20);
		if (line.length > Math.max(2, 20)) return `decimate returned ${line.length} points for a budget of 20`;
		return null;
	},
},

{
	name: 'session-store',
	note: 'the operator file — hand-editable JSON the server validates before it trusts it',
	gen(r, i) {
		const s = storedSession(r);
		return {
			session: i % 3 === 0 ? mutate(r, s, 3) : s,
			photo: chance(r, 0.5) ? { dataUrl: pick(r, ['data:image/jpeg;base64,AAA=', 'javascript:x', '', 'data:text/html,x']), w: pick(r, [4, 0, -1, 1.5]), h: pick(r, [4, 0, 1e9]) } : anyValue(r, 2),
			comment: anyValue(r, 1),
			state: { sessions: [s], sessionSeq: int(r, 0, 10) },
			now: pick(r, [Date.now(), 0, -1, NaN, 1e15]),
		};
	},
	check({ session: s, photo, comment, state, now }) {
		// The sanitizers are the gate: they either throw a real Error or return
		// a shape the rest of the server can trust. Nothing in between.
		for (const [name, fn, arg] of [
			['sanitizeWeatherSnapshot', session.sanitizeWeatherSnapshot, s.weatherSnapshot],
			['sanitizeTarget', session.sanitizeTarget, s.target],
			['sanitizePhoto', session.sanitizePhoto, photo],
			['sanitizeComment', session.sanitizeComment, comment],
		]) {
			try { fn(arg); } catch (err) {
				if (!(err instanceof Error) || !err.message) return `${name} threw a useless error: ${pretty(err)}`;
				// The gate names the field that is wrong. An engine TypeError
				// means it tripped over the value instead of refusing it, and
				// that message is what the API hands the player.
				if (err instanceof TypeError) return `${name} refused with an engine error: ${err.message}`;
			}
		}
		let valid = true;
		try { session.validateSession(s); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `validateSession threw a useless error: ${pretty(err)}`;
			if (err instanceof TypeError) return `validateSession refused with an engine error: ${err.message}`;
			valid = false;
		}
		if (valid) {
			// A session the server accepted must survive the two things it then
			// does to it: strip the photo payloads, and close it.
			const stripped = session.stripPhotoData(s);
			if (stripped.photos.some((p) => 'dataUrl' in p)) return 'stripPhotoData left a dataUrl on the wire';
			if (s.result === 'PENDING') {
				const closed = session.closeSession(s, { result: 'CRASHED', telemetry: s.flightTelemetry });
				try { session.validateSession(closed); } catch (err) {
					return `closeSession produced a session validateSession rejects: ${err.message}`;
				}
			}
		}
		// Telemetry merge is associative by design (three segments, any order),
		// and since #83 it saturates rather than overflowing: whatever three
		// segments say, the result is still a telemetry the validator accepts —
		// otherwise the flight could never be closed.
		const t = s.flightTelemetry;
		const merged = session.mergeTelemetry(session.mergeTelemetry(t, t), t);
		const bad = firstNonFinite(merged);
		if (bad) return `mergeTelemetry produced ${bad}`;
		for (const [k, max] of Object.entries(session.TELEMETRY_MAX)) {
			if (!(merged[k] >= 0 && merged[k] <= max)) return `mergeTelemetry produced ${k} = ${pretty(merged[k])}, over ${max}`;
		}
		if (Number.isFinite(now)) session.reconcileStaleSessions(state, now);
		return null;
	},
},

{
	name: 'session-log',
	note: 'the terminal screens — every line a player reads about a stored flight',
	gen(r) {
		const sessions = [];
		const n = int(r, 0, 6);
		for (let i = 0; i < n; i++) sessions.push(storedSession(r));
		return { sessions, filter: pick(r, [...log.SESSION_FILTERS, 'NOPE', null]), width: pick(r, [40, 80, 1, 0, -5]) };
	},
	check({ sessions, filter, width }) {
		const kept = log.filterSessions(sessions, filter);
		if (!Array.isArray(kept)) return 'filterSessions did not return a list';
		for (const s of kept) {
			// A row is one line of the log screen. NaN in it means a number got
			// through the formatter untouched.
			const row = log.sessionRow(s);
			const leak = textLeak(row);
			if (leak) return `sessionRow ${leak}`;
			const detail = log.sessionDetail(s);
			const detailLeak = textLeak(detail);
			if (detailLeak) return `sessionDetail ${detailLeak}`;
		}
		const entries = log.targetLogEntries(sessions);
		for (const e of entries) {
			const leak = textLeak(log.targetRow(e));
			if (leak) return `targetRow ${leak}`;
		}
		if (Number.isFinite(width) && width > 0) {
			const cut = log.fit('abcdefghij', width);
			if (cut.length > width) return `fit(${width}) returned ${cut.length} characters`;
		}
		return null;
	},
},

{
	name: 'data-screen',
	note: 'the DATA tab — twelve series computed from whatever the operator file holds',
	gen(r) {
		const sessions = [];
		for (let i = 0, n = int(r, 0, 8); i < n; i++) sessions.push(storedSession(r));
		const tracks = sessions.filter(() => chance(r, 0.6)).map((s) => ({
			sessionId: s.id,
			n: int(r, 0, 200),
			bounds: [[nearNumber(r, -90, 90), nearNumber(r, -180, 180)], [nearNumber(r, -90, 90), nearNumber(r, -180, 180)]],
			line: [[nearNumber(r, -90, 90), nearNumber(r, -180, 180)]],
			end: chance(r, 0.5) ? { lat: nearNumber(r, -90, 90), lon: nearNumber(r, -180, 180), alt: nearNumber(r, 0, 500), spd: nearNumber(r, 0, 60), result: 'CRASHED' } : null,
		}));
		return { sessions, tracks, now: pick(r, [Date.UTC(2026, 8, 1), 0, 1e14]) };
	},
	check({ sessions, tracks, now }) {
		const model = data.dataModel({ sessions, tracks, now });
		const bad = firstNonFinite(model);
		if (bad) return `dataModel holds ${bad}`;
		const leak = textLeak(model);
		if (leak) return `dataModel ${leak}`;
		return null;
	},
},

{
	name: 'target-scan',
	note: 'TARGET SCAN — a scan is drawn from a seed, and a stored one is resolved back by index',
	gen(r) {
		return {
			// A seed and a chance only ever reach the generator through
			// sanitizeScan, which already rejects an empty seed and a chance
			// outside 0..1 — so fuzzing those two is fuzzing the wrong layer.
			// `count` and `index` are NOT filtered there: they are clamped here.
			seed: chance(r, 0.5) ? pick(r, NASTY_STRINGS.filter((x) => x.length > 0)) : `zone-${int(r, 0, 1e6)}`,
			count: pick(r, [2, 3, 4, 5, 0, 99, -1, 1.5, NaN, undefined]),
			swarmChance: pick(r, [0, 1, r(), 0.1]),
			index: pick(r, [0, 1, 4, -1, 99, 1.5, NaN]),
			hackType: pick(r, [...targetModel.HACK_TYPES, 'nope', '', null]),
			sessions: Array.from({ length: int(r, 0, 12) }, () => storedSession(r)),
		};
	},
	check({ seed, count, swarmChance, index, hackType, sessions }) {
		if (typeof seed !== 'string') return null;
		const scan = targetModel.generateTargetScan({ seed, count, swarmChance });
		if (!Array.isArray(scan.candidates) || scan.candidates.length < 2 || scan.candidates.length > 5) {
			return `scan holds ${scan.candidates?.length} candidates`;
		}
		// Same seed, same scan: a scan is replayed from the operator file every
		// time the log is opened, and it must not drift.
		const again = targetModel.generateTargetScan({ seed, count, swarmChance });
		if (JSON.stringify(again) !== JSON.stringify(scan)) return 'generateTargetScan is not deterministic for one seed';
		const leak = textLeak(targetModel.scanLines(scan.candidates));
		if (leak) return `scanLines ${leak}`;
		for (const c of scan.candidates) {
			const described = targetModel.describeTarget(c);
			const dLeak = textLeak(described);
			if (dLeak) return `describeTarget ${dLeak}`;
		}
		// An index outside the scan is rejected by sanitizeScan long before this,
		// so the contract here is only "say so loudly, never invent a target".
		try {
			const resolved = targetModel.resolveTarget(scan, index);
			if (resolved && !resolved.family) return 'resolveTarget returned something that is not a target';
		} catch (err) {
			if (!(err instanceof Error) || !err.message) return `resolveTarget threw a useless error: ${pretty(err)}`;
		}
		const chance2 = targetModel.swarmChanceFor(sessions);
		if (!(chance2 >= 0 && chance2 <= 1)) return `swarmChanceFor = ${chance2}`;
		// null is the documented answer for "not a hack type I know".
		const normalized = hack.normalizeHackType(hackType);
		if (normalized !== null && !targetModel.HACK_TYPES.includes(normalized)) return `normalizeHackType invented ${pretty(normalized)}`;
		const ms = hack.hackSequenceMs(normalized);
		if (!Number.isFinite(ms) || ms <= 0) return `hackSequenceMs(${pretty(normalized)}) = ${ms}`;
		return null;
	},
},

{
	name: 'scanner',
	note: 'GLOBAL SCANNER — Nominatim, the provider registry and the probe answer to the acquisition screen; none of those three is ours',
	gen(r) {
		// A Nominatim hit as `format=jsonv2` renders one, then bent. The
		// provider is reachable and well-behaved on most runs; the point of the
		// target is the run where it is not.
		const hit = {
			name: pick(r, ['Tokyo', '', '\u00cele de la Cit\u00e9', 42, null, { toString: null }]),
			display_name: pick(r, ['Tokyo, Japan, 100-0001', '', ...NASTY_STRINGS.slice(0, 4), { toString: null }, ['a']]),
			addresstype: pick(r, ['city', 'neighbourhood', 'building', 'nope', null, { toString: null }]),
			type: pick(r, ['administrative', null]),
			category: pick(r, ['boundary', 'place', null]),
		};
		const probeStatus = pick(r, ['ok', 'none', 'undecodable', 'error', 'nope', null]);
		return {
			hit: chance(r, 0.35) ? mutate(r, hit, 2) : hit,
			areaKm2: pick(r, [12.4, 0, -1, 1e9, NaN, Infinity, null]),
			// /__map-api/describe: ours, but an older build's answer and a
			// truncated one both reach the same screen.
			describe: chance(r, 0.4) ? anyValue(r, 2) : mutate(r, {
				grid: { cols: int(r, 1, 60), rows: int(r, 1, 60), columns: int(r, 1, 3600), masked: chance(r, 0.5) },
				estimate: {
					probes: int(r, 1, 5000), prepBytes: int(r, 0, 4e9),
					prepBytesRange: [int(r, 0, 1e9), int(r, 0, 4e9)],
					rawBytes: int(r, 0, 4e9), totalSeconds: int(r, 0, 90000), warn: chance(r, 0.3),
				},
				dimensions: { area: nearNumber(r, 0, 5e6), width: int(r, 1, 4000), height: int(r, 1, 4000) },
				tileMeters: nearNumber(r, 1, 500),
			}, 2),
			// The exporter's answer. `message` is a Go panic on a bad day.
			probe: chance(r, 0.4) ? null : {
				status: probeStatus,
				exported: pick(r, [12, 0, -1, NaN, null, { toString: null }]),
				undecodable: pick(r, [3, 0, null]),
				message: pick(r, ['open ./config.json: no such file\ngoroutine 1 [running]:\n…', '', null, 42, { toString: null }, 'x'.repeat(5000)]),
			},
			plan: chance(r, 0.5) ? null : {
				trigger: pick(r, ['jp', '', null, { toString: null }]),
				columns: pick(r, [120, 0, -1, NaN]),
				pruned: pick(r, [0, 40, -1, NaN]),
			},
			provider: pick(r, [{ id: 'google', label: 'Google Earth' }, { id: 'x' }, null, { label: { toString: null } }]),
			registry: chance(r, 0.3) ? anyValue(r, 2) : { providers: [{ id: 'google', label: 'Google Earth' }, null, { label: 'no id' }], default: pick(r, ['google', 'gone', null]) },
			name: pick(r, ['Tokyo', '', '   ', '\u00cele de la Cit\u00e9', '🛸', { toString: null }, 42, null, 'A'.repeat(400)]),
			zone: chance(r, 0.5) ? null : { bbox: { south: 48.8, north: 48.9, west: 2.2, east: 2.4 } },
			phase: pick(r, ['download', 'decode', 'rebuild', 'prep', 'nope', null, { toString: null }, 7]),
		};
	},
	check(c) {
		// Every one of these formats a value that came from outside. The
		// contract is the same for all of them: a string for the screen, or a
		// named refusal — never an engine TypeError, which is what `String(v)`
		// on `{"toString": null}` raises (issue #85).
		const designation = scanner.designationFrom(c.hit);
		if (typeof designation !== 'string') return `designationFrom returned ${pretty(designation)}`;
		const slug = scanner.slugify(designation);
		if (!/^[a-z0-9-]*$/.test(slug)) return `slugify produced ${pretty(slug)}`;

		const label = scanner.phaseLabel(c.phase);
		if (typeof label !== 'string') return `phaseLabel returned ${pretty(label)}`;

		const d = scanner.signalDensity({ place: c.hit, areaKm2: c.areaKm2 });
		if (typeof d.known !== 'boolean') return `signalDensity.known = ${pretty(d.known)}`;
		const dLeak = textLeak(d);
		if (dLeak) return `signalDensity ${dLeak}`;

		// areaAnalysis is fed our own /describe, so the shape is usually right.
		// What it must not do is take the screen down when it is not.
		const a = scanner.areaAnalysis(c.describe);
		if (a !== null && typeof a.columns !== 'string') return `areaAnalysis.columns = ${pretty(a.columns)}`;

		// The verdict line is read by an operator deciding whether to spend ten
		// minutes acquiring: it must always say something.
		const v = scanner.coverageLine({ plan: c.plan, probe: c.probe, provider: c.provider });
		if (typeof v.label !== 'string' || !v.label) return `coverageLine gave no label: ${pretty(v)}`;
		const rail = scanner.railLine({ describe: c.describe, plan: c.plan, probe: c.probe, provider: c.provider });
		if (typeof rail.text !== 'string' || !rail.text) return `railLine gave no text: ${pretty(rail)}`;
		// A Go panic dump must not reach the rail whole.
		if (rail.detail.length > 4096) return `railLine detail is ${rail.detail.length} chars long`;

		const choices = scanner.sourceChoices(c.registry);
		if (!Array.isArray(choices)) return `sourceChoices returned ${pretty(choices)}`;
		if (choices.some((p) => !p?.id)) return 'sourceChoices kept a provider without an id';

		// The button is the end of the chain: whatever came in, it names one
		// action and one reason.
		const step = scanner.acquireStep({ zone: c.zone, source: c.provider, name: c.name, plan: c.plan, probe: c.probe });
		if (typeof step.label !== 'string' || !step.label) return `acquireStep gave no label: ${pretty(step)}`;
		if (step.disabled && !step.why) return 'acquireStep disabled the button without saying why';
		if (!['probe', 'acquire', null].includes(step.action)) return `acquireStep invented action ${pretty(step.action)}`;
		return null;
	},
},

{
	name: 'url-flags',
	note: 'the ?scene=/?swarm=/?family= query flags — the only input that reaches the sim from a link someone else wrote',
	gen(r) {
		return {
			scene: chance(r, 0.5) ? pick(r, NASTY_STRINGS) : `${pick(r, ['tour-eiffel', 'a-b', 'A', '../x'])}${chance(r, 0.3) ? '/../..' : ''}`,
			swarm: chance(r, 0.5) ? pick(r, NASTY_STRINGS) : `${int(r, -2, 20)}${chance(r, 0.5) ? `:${pick(r, ['wedge', 'cloud', 'nope', ''])}` : ''}`,
		};
	},
	check({ scene, swarm }) {
		// A slug becomes a URL prefix (loader.sceneBase) and used to become
		// innerHTML on the boot failure path, so what comes out of the parser
		// is the whole guarantee: a slug, or a refusal.
		let slug = null;
		try { slug = parseSceneFlag(scene); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `parseSceneFlag threw a useless error: ${pretty(err)}`;
			// The raw value must not ride along inside the message: that message
			// is displayed.
			if (scene.length > 2 && err.message.includes(scene)) return 'the refusal echoes the raw ?scene= value back';
			return null;
		}
		if (slug !== null) {
			if (!SCENE_SLUG_RE.test(slug)) return `parseSceneFlag accepted ${pretty(slug)}`;
			// What loader.sceneBase() interpolates it into. Checked here rather
			// than by importing the loader, which drags three.js in for a
			// template string.
			const base = `/scenes/${slug}/`;
			if (base.includes('..') || base.includes('//') || encodeURIComponent(slug) !== slug) {
				return `the slug does not survive becoming a URL: ${base}`;
			}
		}
		let descriptor = null;
		try { descriptor = parseSwarmFlag(swarm); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `parseSwarmFlag threw a useless error: ${pretty(err)}`;
			return null;
		}
		if (descriptor) {
			// The flag's own rule: refuse what the game cannot produce, never
			// silently clamp to something the player did not ask for.
			if (!Number.isInteger(descriptor.size) || descriptor.size < 6 || descriptor.size > 12) {
				return `parseSwarmFlag produced a swarm of ${pretty(descriptor.size)}`;
			}
			if (typeof descriptor.doctrineSeed !== 'string' || !descriptor.doctrineSeed) return 'parseSwarmFlag produced an empty doctrine seed';
		}
		return null;
	},
},

{
	name: 'weather-source',
	note: 'the api.open-meteo.com answer — a third party\'s JSON that the server turns into wind, rain and fog',
	gen(r, i) {
		const n = int(r, 0, 9);
		const time = Array.from({ length: n }, (_, k) => `2026-09-${String(1 + k).padStart(2, '0')}`);
		const hourlyTimes = [];
		const visibility = [];
		const cloud = [];
		for (const d of time) {
			for (let h = 0; h < 3; h++) {
				hourlyTimes.push(`${d}T${String(h).padStart(2, '0')}:00`);
				visibility.push(meteoValue(r, 0, 60000));
				cloud.push(meteoValue(r, 0, 100));
			}
		}
		const payload = {
			daily: {
				time,
				weather_code: time.map(() => pick(r, [0, 1, 3, 45, 61, 95, 999, null])),
				precipitation_sum: time.map(() => meteoValue(r, 0, 80)),
				precipitation_hours: time.map(() => meteoValue(r, 0, 24)),
				wind_speed_10m_max: time.map(() => meteoValue(r, 0, 45)),
				wind_gusts_10m_max: time.map(() => meteoValue(r, 0, 70)),
				// Finite: what ±Infinity does to a bearing is weather-sanitize's
				// finding, and leaving it here would make this target report it on
				// every run instead of the twenty other things it watches.
				wind_direction_10m_dominant: time.map(() => pick(r, [0, 90, 359, 359.7, -45, 1e9, null, '180'])),
			},
			// Not every model serves the hourly series — that absence is the
			// documented fallback path, so a third of the cases take it.
			hourly: chance(r, 0.33) ? undefined : { time: hourlyTimes, visibility, cloud_cover: cloud },
		};
		return {
			payload: i % 3 === 0 ? jsonRoundTrip(mutate(r, payload, 3)) : payload,
			lat: nearNumber(r, -85, 85), lon: nearNumber(r, -180, 180),
			day: pick(r, ['2026-09-13', '2026-01-01', '2027-03-02']),
		};
	},
	check({ payload, lat, lon, day }) {
		let days;
		try { days = weather.fromOpenMeteo(payload); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `fromOpenMeteo threw a useless error: ${pretty(err)}`;
			// A TypeError here means it tripped over a value rather than refusing
			// it — nonprimitive-json owns that one (`String(hourly.time[i])` on a
			// `{"toString": null}`), so it is not reported twice.
			if (err instanceof TypeError && !/primitive value/.test(err.message)) {
				return `fromOpenMeteo refused with an engine error: ${err.message}`;
			}
			return null;
		}
		// Everything below is what sanitize() promises: the ranges the terminal,
		// wind.js, rain.js and fog.js are all written against.
		for (const [i, d] of days.entries()) {
			// A bearing that ARRIVED non-finite is weather-sanitize's finding —
			// `1e400` in a JSON body parses to Infinity, and Infinity % 360 is
			// NaN. It is masked here so this target keeps watching the other
			// twenty things instead of reporting that one on every run.
			const rawDir = Number(payload?.daily?.wind_direction_10m_dominant?.[i]);
			const dirOk = Number.isFinite(rawDir);
			const bad = firstNonFinite({ ...d, date: 0, windDir: dirOk ? d.windDir : 0 });
			if (bad) return `day ${i}: ${bad}`;
			if (!weather.REGIMES.includes(d.regime)) return `day ${i}: unknown regime ${pretty(d.regime)}`;
			if (!(d.windSpeed >= 0 && d.windSpeed <= 40)) return `day ${i}: windSpeed ${d.windSpeed}`;
			if (!(d.windGust >= d.windSpeed)) return `day ${i}: gust ${d.windGust} under a mean of ${d.windSpeed}`;
			if (dirOk && (!Number.isInteger(d.windDir) || d.windDir < 0 || d.windDir > 359)) {
				return `day ${i}: windDir ${pretty(d.windDir)}`;
			}
			if (!(d.rateMmH >= 0 && d.rateMmH <= 60)) return `day ${i}: rateMmH ${d.rateMmH}`;
			if (!(d.cloudPct >= 0 && d.cloudPct <= 100)) return `day ${i}: cloudPct ${d.cloudPct}`;
			if (!(d.visibilityM >= 30 && d.visibilityM <= 60000)) return `day ${i}: visibilityM ${d.visibilityM}`;
			// What the flight model is handed. A non-finite wind speed is a drone
			// that leaves the map on the first step.
			const sim = weather.toSimParams({ ...d, windDir: dirOk ? d.windDir : 0 });
			const simBad = firstNonFinite(sim);
			if (simBad) return `day ${i}: toSimParams holds ${simBad}`;
			for (const k of ['rain', 'fog', 'cloud']) {
				const v = k === 'cloud' ? sim.cloud.cover : sim[k].intensity;
				if (!(v >= 0 && v <= 1)) return `day ${i}: sim.${k} out of 0..1 (${v})`;
			}
		}
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;   // zoneKey's own gate, checked by the route
		const snap = weather.makeSnapshot({ lat, lon, day, source: 'open-meteo', days });
		for (const d of snap.days) if (!(d.confidence >= 0 && d.confidence <= 1)) return `confidence ${d.confidence}`;
		// The server re-dates its own snapshot on every offline day. What it
		// wrote, it has to be able to read back.
		const kept = weather.restale(snap, '2027-01-01');
		if (kept && kept.days.some((d) => !(d.confidence >= 0 && d.confidence <= 1))) return 'restale produced a confidence outside 0..1';
		return null;
	},
},

{
	name: 'weather-sanitize',
	note: 'weather.sanitize() — the single point where an Open-Meteo answer and the generator are made physically possible, before anything classifies them or sends them to wind.js/rain.js/fog.js',
	gen(r) {
		// Exactly what a `daily` entry can carry once JSON.parse is done with it:
		// `1e400` is Infinity, an absent field is undefined, a model that serves
		// strings serves strings.
		return { day: rawDay(r), dir: pick(r, [Infinity, -Infinity, 1e400, NaN, null, 0, 359, -720, 1e308]) };
	},
	check({ day, dir }) {
		const d = weather.sanitize({ ...day, windDir: dir });
		// Its whole job. Everything downstream — classify(), simParamsOf(),
		// compassPoint() on the WEATHER screen — is written against these ranges
		// and none of them checks again.
		const bad = firstNonFinite(d);
		if (bad) return `sanitize left ${bad}`;
		if (!Number.isInteger(d.windDir) || d.windDir < 0 || d.windDir > 359) return `sanitize produced windDir ${pretty(d.windDir)}`;
		if (!weather.REGIMES.includes(d.regime)) return `sanitize produced regime ${pretty(d.regime)}`;
		// Idempotent, because the file is re-read and re-sanitized on every boot.
		const again = weather.sanitize(d);
		if (JSON.stringify(again) !== JSON.stringify(d)) return 'sanitize is not idempotent';
		return null;
	},
},

{
	name: 'weather-store',
	note: 'the world-state snapshot in the operator file — hand-editable, served verbatim by GET /:id/weather and read by the WEATHER screen',
	// The CONTAINER is left alone — zone/day/source/days are what every version
	// of makeSnapshot() has written, and inventing a `days: null` would fuzz a
	// file nobody produces. What varies is what is INSIDE a day: a field an
	// older schema did not have, and a non-finite one, which the server really
	// does store today (see the weather-source finding on windDir).
	gen(r) {
		return {
			snap: {
				zone: '48.86,2.29',
				lat: nearNumber(r, -85, 85), lon: nearNumber(r, -180, 180),
				day: pick(r, ['2026-09-13', '2026-01-01']),
				source: pick(r, weather.SOURCES),
				fetchedAt: '2026-09-13T10:00:00.000Z',
				days: Array.from({ length: int(r, 0, 4) }, () => storedDay(r)),
			},
			day: pick(r, ['2026-09-14', '2027-01-01']),
		};
	},
	check({ snap, day }) {
		// 1. What the SERVER does with it on the offline path (weather-source.mjs
		//    step 3). It must refuse or re-date, never take the route down.
		let kept = null;
		try { kept = weather.restale(snap, day); } catch (err) {
			return `restale threw on a stored snapshot: ${err?.name}: ${err?.message}`;
		}
		// 2. What the TERMINAL does with it. Every one of these is a line a
		//    player reads; none of them may be an engine error or say NaN.
		for (const s of [snap, kept].filter(Boolean)) {
			let text;
			try { text = weather.formatForecast(s, { title: 'LOCAL' }); } catch (err) {
				return `formatForecast threw on a stored snapshot: ${err?.name}: ${err?.message}`;
			}
			const leak = textLeak(text);
			if (leak) return `formatForecast ${leak}`;
			for (const [name, fn] of [['dayRows', weather.dayRows], ['conditionsBlock', weather.conditionsBlock], ['conditionsLine', weather.conditionsLine]]) {
				let out;
				try { out = fn(s); } catch (err) { return `${name} threw: ${err?.name}: ${err?.message}`; }
				const l = textLeak(out);
				if (l) return `${name} ${l}`;
			}
			const t = weather.today(s);
			const sev = weather.severity(t);
			if (!['nominal', 'watch', 'marginal', 'nogo'].includes(sev)) return `severity invented ${pretty(sev)}`;
			// Only when there IS a day: formatForecast answers 'NO FORECAST'
			// without ever drawing a bar, so an empty window is not this
			// function's problem.
			if (t) {
				const bar = weather.confidenceBar(t.confidence);
				if (typeof bar !== 'string' || bar.length !== 12) return `confidenceBar produced ${pretty(bar)}`;
			}
		}
		return null;
	},
},

{
	name: 'map-poly',
	note: 'tiles.mjs behind requirePoly() — the trace a player draws in the GLOBAL SCANNER, sent to POST /__map-api/describe',
	gen(r) {
		// Small on purpose: this target measures CORRECTNESS. What a big-but-legal
		// trace costs is a separate finding, and its own target (map-poly-cost).
		return { ring: drawnRing(r, pick(r, [0.0005, 0.002, 0.01])), zoom: int(r, 13, 20) };
	},
	check({ ring, zoom }) {
		// intIn(b.zoom, 13, 20, 20) in server/api.mjs: nothing else ever reaches
		// these functions, and the shrinker loves to hand them a null.
		if (!Number.isInteger(zoom) || zoom < 13 || zoom > 20) return null;
		if (!acceptsPoly(ring)) return null;   // the server refuses it before any of this
		// What a BIG trace costs is map-poly-cost's finding, and the shrinker
		// walks straight into it: running polygonGrid on one here would be
		// committing the denial of service this file is meant to report.
		const cells = tiles.tileGrid(tiles.polygonBounds(ring), zoom);
		if (cells.cols * cells.rows > 2e5) return null;
		const b = tiles.polygonBounds(ring);
		if (firstNonFinite(b)) return `polygonBounds holds ${firstNonFinite(b)}`;
		if (!(b.south <= b.north && b.west <= b.east)) return `polygonBounds came out inverted: ${pretty(b)}`;
		const area = tiles.polygonArea(ring);
		if (!(area >= 0)) return `polygonArea = ${area}`;
		const grid = tiles.polygonGrid(ring, zoom);
		if (!Number.isInteger(grid.columns) || grid.columns < 0 || grid.columns > grid.cols * grid.rows) {
			return `polygonGrid kept ${pretty(grid.columns)} of ${grid.cols * grid.rows} tiles`;
		}
		// The mask is what the map draws and what the exporter downloads. The two
		// counts have to be the same number, or the escalier on screen is not the
		// zone that gets extracted.
		if (tiles.maskKeys(grid).length !== grid.columns) return `maskKeys says ${tiles.maskKeys(grid).length}, columns says ${grid.columns}`;
		if (grid.masked !== grid.cols * grid.rows - grid.columns) return 'masked and columns do not add up to the grid';
		for (const seg of tiles.maskOutline(grid, zoom)) {
			if (firstNonFinite(seg)) return `maskOutline holds ${firstNonFinite(seg)}`;
		}
		// The probe point decides where the coverage question is asked. A point
		// outside the trace answers about a zone nobody is extracting.
		const probe = tiles.polygonProbePoint(ring, zoom);
		if (probe) {
			if (firstNonFinite(probe)) return `polygonProbePoint holds ${firstNonFinite(probe)}`;
			// Against the SNAPPED box, not the trace: the probe is the centre of
			// a kept tile, and extraction is quantised to tiles — a tile that
			// straddles the edge legitimately has its centre just outside.
			const s = grid.snapped;
			if (probe.lat < s.south || probe.lat > s.north || probe.lon < s.west || probe.lon > s.east) {
				return `polygonProbePoint fell outside the grid it came from: ${pretty(probe)} not in ${pretty(s)}`;
			}
		} else if (grid.columns > 0) {
			return 'polygonProbePoint found nothing although the grid kept tiles';
		}
		// The cache directory is named after this string, and a Go port has to
		// produce the same one. Six decimals, nothing else.
		const canon = tiles.canonicalPoly(ring);
		if (!/^-?\d+\.\d{6}(,-?\d+\.\d{6})*$/.test(canon)) return `canonicalPoly produced ${pretty(canon)}`;
		const est = estimateCost({ columns: grid.columns, zoom, altitude: 20 });
		const estBad = firstNonFinite(est);
		if (estBad) return `estimateCost holds ${estBad}`;
		if (!(est.totalSeconds >= 0)) return `estimateCost.totalSeconds = ${est.totalSeconds}`;
		return null;
	},
},

{
	name: 'map-poly-cost',
	note: 'the COST of a trace requireZone()/requireAffordable() accept — POST /__map-api/describe is documented "callable on every mouse move" and the scanner does exactly that',
	gen(r) {
		// Ring size matters as much as ring extent here, so both are drawn.
		const n = pick(r, [3, 12, 60, 200]);
		const ring = drawnRing(r, pick(r, [0.002, 0.02, 0.2, 2, 20]));
		while (ring.length < n * 2) ring.push(ring[ring.length - 2] + 1e-5, ring[ring.length - 1] + 1e-5);
		return { ring: ring.slice(0, n * 2), zoom: int(r, 13, 20) };
	},
	check({ ring, zoom }) {
		if (!Number.isInteger(zoom) || zoom < 13 || zoom > 20) return null;
		if (!acceptsPoly(ring)) return null;
		// tileGrid() is pure arithmetic and allocates nothing — the same call
		// requireAffordable() makes before it decides.
		const b = tiles.polygonBounds(ring);
		const grid = tiles.tileGrid(b, zoom);
		const cells = grid.cols * grid.rows;
		const vertices = ring.length / 2;
		// polygonGrid() runs tileIntersectsPolygon() once per cell, and that
		// walks the WHOLE ring: the cost is cells x vertices, not cells. Both
		// ceilings refuse before anything is allocated, so a ring past either of
		// them is never computed — here or on the server.
		const work = cells * vertices;
		if (cells > MAX_GRID_CELLS || work > MAX_POLY_WORK) return null;
		// Everything left is a trace the server really accepts and really
		// computes, so this target really computes it, and times it. That is the
		// invariant, and it is why this is a gate rather than a restatement of
		// the ceiling: whatever gets past requireAffordable() has to be fast
		// enough for a route the scanner calls on mouse move. Remove either
		// ceiling and the traces that come back in are computed here, where they
		// take seconds. The budget is deliberately loose — 2e7 units measured
		// ~0.36 s here — because a CI runner under load is slower than a
		// workstation, and what would be a regression is a trace costing SECONDS,
		// not tens of milliseconds more.
		if (work < POLY_TIMED_FROM || work <= polyWorst) return null;
		polyWorst = work;
		const t0 = performance.now();
		const full = tiles.polygonGrid(ring, zoom);
		const ms = performance.now() - t0;
		if (ms > 3000) {
			return `a trace the server accepts took ${ms.toFixed(0)} ms to describe`
				+ ` (${cells.toExponential(2)} cells x ${vertices} vertices at zoom ${zoom},`
				+ ` ${(b.north - b.south).toFixed(3)}° by ${(b.east - b.west).toFixed(3)}°)`;
		}
		// And it has to be the grid it was counted from: requireAffordable()
		// budgets on tileGrid(), polygonGrid() is what actually runs.
		if (full.cols !== grid.cols || full.rows !== grid.rows) {
			return `polygonGrid swept ${full.cols}x${full.rows} where the guard budgeted ${grid.cols}x${grid.rows}`;
		}
		return null;
	},
},

{
	name: 'music-manifest',
	note: 'public/music.json, fetched at boot — validateManifest() is the gate, and anything it calls clean has to reach the jukebox',
	// Missing fields, wrong pools, duplicate ids, absurd durations: the ways a
	// generation run or a hand edit really leaves this file. The one shape left
	// out is a field whose value is an OBJECT — that is music-manifest-types's
	// finding, and letting it through here would report the same defect twice.
	gen(r, i) {
		const m = musicManifest(r);
		if (i % 3 === 0) for (const t of m.tracks) delete t[pick(r, ['id', 'pool', 'file', 'durS', 'bpm'])];
		return {
			manifest: m,
			pool: pick(r, [...musicModel.MUSIC_POOLS, 'nope', null]),
			seed: pick(r, ['flight-1', '', '🛸']),
			recent: Array.from({ length: int(r, 0, 20) }, () => pick(r, ['menu-0', 'race5-1', null, ''])),
			filter: pick(r, ['ALL', 'menu', 'nope', null]),
		};
	},
	check({ manifest, pool, seed, recent, filter }) {
		let problems;
		try { problems = musicModel.validateManifest(manifest); } catch (err) {
			return `validateManifest threw instead of reporting: ${err?.name}: ${err?.message}`;
		}
		if (!Array.isArray(problems)) return `validateManifest returned ${pretty(problems)}`;
		if (problems.some((p) => typeof p !== 'string' || !p)) return `validateManifest reported ${pretty(problems)}`;
		// A manifest it refuses leaves the game silent, by design: nothing
		// downstream ever sees it, so nothing downstream is checked with it.
		if (problems.length > 0) return null;

		const library = jukebox.buildLibrary(manifest);
		if (library.length !== (manifest.tracks?.length ?? 0)) return 'buildLibrary lost a track the validator kept';
		// Sorting has to be a total order: the list must not move under the
		// cursor between two renders of the same library.
		const again = jukebox.buildLibrary(manifest).map((t) => t.id);
		if (JSON.stringify(again) !== JSON.stringify(library.map((t) => t.id))) return 'buildLibrary is not stable for one manifest';
		const rows = library.map((t, i) => jukebox.jukeboxRow(t, { playing: i === 0 }));
		const rowLeak = textLeak(rows);
		if (rowLeak) return `jukeboxRow ${rowLeak}`;
		if (textLeak(jukebox.nowPlayingLine(library[0] ?? null))) return `nowPlayingLine ${textLeak(jukebox.nowPlayingLine(library[0] ?? null))}`;
		if (textLeak(jukebox.librarySummary(library))) return `librarySummary ${textLeak(jukebox.librarySummary(library))}`;
		if (!jukebox.libraryFilters(library).includes('ALL')) return 'libraryFilters dropped ALL';
		if (!Array.isArray(jukebox.filterLibrary(library, filter))) return 'filterLibrary did not return a list';
		for (const d of [-1, 0, 1]) {
			const i = jukebox.stepIndex(library.length, -1, d);
			if (library.length > 0 && !(i >= 0 && i < library.length)) return `stepIndex(${library.length}, -1, ${d}) = ${i}`;
		}
		// The radio: same manifest, same pool, same seed, same track. A session
		// resumed has to resume its music too.
		const t1 = musicModel.pickTrack(manifest, pool, seed, recent);
		const t2 = musicModel.pickTrack(manifest, pool, seed, recent);
		if (t1 !== t2) return 'pickTrack is not deterministic for one (pool, seed, recent)';
		if (t1 && t1.pool !== pool) return `pickTrack returned a ${pretty(t1.pool)} track for pool ${pretty(pool)}`;
		const next = musicModel.pushRecent(recent, t1?.id);
		if (next.length > musicModel.RECENT_LIMIT) return `pushRecent grew to ${next.length}`;
		return null;
	},
},

{
	name: 'entry-state',
	note: 'PHASE 13 entry draw against manifest.json — the bbox is JSON fetched at boot, and a polygon-traced or hand-edited scene makes it degenerate',
	gen(r) {
		return {
			manifest: someManifest(r),
			kind: pick(r, ['solid', 'void', 'corridor', 'patchy']),
			category: pick(r, [...entry.CATEGORIES, 'NOPE', null]),
			seed: pick(r, ['zone-1', '', '🛸', 'x'.repeat(200)]),
			draws: int(r, 1, 12),
		};
	},
	check({ manifest, kind, category, seed, draws }) {
		const physics = stubPhysics(kind);   // fresh each case: occupancyOf caches on the instance
		const rect = entry.insetRect(manifest);
		if (firstNonFinite(rect)) return `insetRect holds ${firstNonFinite(rect)}`;
		if (!(rect.x0 <= rect.x1 && rect.z0 <= rect.z1)) return `insetRect came out inverted: ${pretty(rect)}`;
		const grid = entry.occupancyOf(physics, manifest);
		if (!(grid.cells.length > 0)) return 'occupancyOf left no cell to draw in';
		if (!Number.isInteger(grid.cols) || grid.cols < 1 || !Number.isInteger(grid.rows) || grid.rows < 1) {
			return `occupancyOf built a ${pretty(grid.cols)}x${pretty(grid.rows)} grid`;
		}
		const rand = entry.rngFrom(seed);
		const cat = entry.resolveCategory(category, rand);
		if (!entry.CATEGORIES.includes(cat)) return `resolveCategory invented ${pretty(cat)}`;
		for (let i = 0; i < draws; i++) {
			const c = entry.sampleCandidate(cat, manifest, physics, rand);
			if (c === null) continue;            // "no ground here" is the documented answer
			const bad = firstNonFinite({ position: c.position, quaternion: c.quaternion, linvel: c.linvel, angvel: c.angvel });
			if (bad) return `sampleCandidate holds ${bad}`;
			const q = Math.hypot(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w);
			if (Math.abs(q - 1) > 1e-6) return `sampleCandidate produced a quaternion of norm ${q}`;
			if (typeof entry.geometrySafe(c, physics) !== 'boolean') return 'geometrySafe did not answer yes or no';
		}
		// The last resort. It is what a flight starts from when twenty draws
		// missed, so it may never be non-finite, whatever the manifest says.
		const back = entry.fallbackCandidate(manifest, physics);
		const backBad = firstNonFinite(back.position);
		if (backBad) return `fallbackCandidate holds ${backBad}`;
		if (back.position.x < rect.x0 - 1e-6 || back.position.x > rect.x1 + 1e-6
			|| back.position.z < rect.z0 - 1e-6 || back.position.z > rect.z1 + 1e-6) {
			return `fallbackCandidate landed outside its own inset rect: ${pretty(back.position)}`;
		}
		return null;
	},
},

{
	name: 'fence-field',
	note: 'the fence surface projection — the bbox is manifest JSON, the drone position comes straight from Rapier and can be far outside it',
	gen(r) {
		const span = () => pick(r, [1200, 600, 60, 2, 0, 1e5]);
		const w = span(), d = span();
		const p = () => { const v = nearNumber(r, -3000, 3000); return Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0; };
		return {
			bbox: { min: [-w / 2, 0, -d / 2], max: [w / 2, 200, d / 2] },
			pos: { x: p(), y: p(), z: p() },
			centre: { x: p(), z: p() },
			radius: pick(r, [300, 1, 0, -50, 1e6]),
			// A distance ratio is (distance to the fence / corridor half-width),
			// and geofence.js has guaranteed it finite since the zero-width map
			// fix. Under, over and at the ends are reachable; NaN is not.
			ratios: Array.from({ length: int(r, 1, 20) }, () => { const v = nearNumber(r, 0, 1); return Number.isFinite(v) ? v : 0; }),
			dt: pick(r, [1 / 60, 1 / 250, 0, 5, 1e4]),
		};
	},
	check({ bbox, pos, centre, radius, ratios, dt }) {
		const box = fenceField.nearestOnBoxSurface(pos, bbox);
		if (firstNonFinite(box)) return `nearestOnBoxSurface holds ${firstNonFinite(box)}`;
		// `u` is a surface coordinate the shader wraps on `perimeter`. Outside
		// [0, perimeter) the ring tears at the seam.
		if (!(box.perimeter >= 0)) return `perimeter = ${box.perimeter}`;
		if (box.perimeter > 0 && !(box.u >= 0 && box.u < box.perimeter)) return `u = ${box.u} outside a perimeter of ${box.perimeter}`;
		const sph = fenceField.nearestOnSphereSurface(pos, centre, radius);
		if (Number.isFinite(radius) && firstNonFinite(sph)) return `nearestOnSphereSurface holds ${firstNonFinite(sph)}`;
		const clock = new fenceField.PingClock();
		let fired = 0;
		for (const ratio of ratios) {
			const bias = fenceField.hueBiasFor(ratio);
			if (!(bias >= 0 && bias <= fenceField.HUE_BIAS_CEIL)) return `hueBiasFor(${ratio}) = ${bias}`;
			const iv = fenceField.pingIntervalFor(ratio);
			if (Number.isNaN(iv) || iv <= 0) return `pingIntervalFor(${ratio}) = ${iv}`;
			if (Number.isFinite(dt) && clock.advance(dt, ratio) === true) fired++;
		}
		// A dt spike (a tab back from the background) must not fire a burst of
		// catch-up rings: the clock resets rather than subtracting.
		if (fired > ratios.length) return `PingClock fired ${fired} times in ${ratios.length} frames`;
		return null;
	},
},

{
	name: 'live-queue',
	note: 'LiveNodeQueue — what the streaming window queued and released, in the order a recentring in flight really produces',
	gen(r) {
		const paths = Array.from({ length: int(r, 1, 8) }, (_, i) => `306040607163${i}`);
		const ops = [];
		for (let i = 0, n = int(r, 1, 60); i < n; i++) {
			ops.push({
				kind: pick(r, ['build', 'swap', 'release', 'covered', 'drop', 'drain']),
				path: pick(r, paths),
				// pendingFetches() is the window's own count; it drops to zero when
				// the wave lands, and a recentring puts it back up.
				pending: pick(r, [0, 0, 1, 40, 300]),
				// A frame's clock. 0 is what a stubbed or coarse timer gives.
				step: pick(r, [0, 0.2, 1, 4, 20]),
			});
		}
		return { ops, budget: pick(r, [3, 8, 0, 1e6]) };
	},
	check({ ops, budget }) {
		const q = new LiveNodeQueue();
		const live = new Set();      // what is on screen
		let clock = 0;
		let work = 0;
		for (const op of ops) {
			switch (op.kind) {
				case 'build': q.queueBuild(op.path, { p: op.path }); break;
				case 'swap': q.queueBuild(op.path, { p: op.path }, { swap: true }); break;
				case 'release': q.queueRelease(op.path); break;
				case 'covered': q.queueCovered(op.path); break;
				case 'drop': q.dropBuild(op.path); break;
				default: {
					// Bounded on purpose: drain() is a `while` on a clock, and a
					// clock that never advances is exactly what a stubbed timer or
					// a coarsened performance.now() gives.
					const before = work;
					q.drain({
						budgetMs: budget,
						pendingFetches: () => op.pending,
						build: (p, job) => { work++; if (job?.p !== p) throw new Error('drain built a job under the wrong path'); live.add(p); },
						dispose: (p) => { work++; live.delete(p); },
						now: () => (clock += op.step),
					});
					if (work - before > 100000) return 'drain did not stop under its budget';
					break;
				}
			}
			if (q.builds.size + q.swaps.size + q.releases.length + q.covered.size > 4 * ops.length) return 'a queue grew past what was ever pushed into it';
			if (typeof q.idle() !== 'boolean') return 'idle() did not answer yes or no';
			if (!(q.budgetMs() > 0)) return `budgetMs() = ${q.budgetMs()}`;
		}
		// Everything queued must be drainable: what is left over is a node that
		// stays on screen with nothing left to remove it, or a hole.
		let guard = 0;
		while (!q.idle()) {
			if (++guard > 10000) return 'the queue never drains, even with no fetch in flight';
			q.drain({ budgetMs: 1e6, pendingFetches: () => 0, build: (p) => live.add(p), dispose: (p) => live.delete(p), now: () => (clock += 0.001) });
		}
		return null;
	},
},

{
	name: 'lod-window',
	note: 'the LOD ring assembly — the node lists come from traverse() over BulkMetadata that kh.google.com served',
	gen(r) {
		const digits = () => Array.from({ length: int(r, 2, 8) }, () => int(r, 0, 7)).join('');
		const box = () => {
			const s = nearNumber(r, -80, 80), w = nearNumber(r, -170, 170);
			const h = Math.abs(nearNumber(r, 0, 2)) || 0.01;
			return Number.isFinite(s) && Number.isFinite(w) ? { s, n: s + h, w, e: w + h } : null;
		};
		const rings = [];
		for (const spec of lod.ringsFor(pick(r, [150, 600, 2000, 0, -10, 1e6]), int(r, 2, 22))) {
			rings.push({
				...spec,
				nodes: Array.from({ length: int(r, 0, 12) }, () => ({
					path: digits(), box: chance(r, 0.15) ? null : box(), exclude: chance(r, 0.3) ? [int(r, 0, 7)] : undefined,
				})),
			});
		}
		return { rings, centre: { lat: nearNumber(r, -85, 85), lon: nearNumber(r, -180, 180) } };
	},
	check({ rings, centre }) {
		for (const ring of rings) {
			if (!(ring.radiusM >= 0)) return `ringsFor produced a radius of ${ring.radiusM}`;
			if (!Number.isInteger(ring.level) || ring.level < 14) return `ringsFor produced level ${pretty(ring.level)}`;
		}
		if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return null;   // the window's own gate (?live= refuses a NaN pair)
		// The union over every ring: which occurrence of a path survives the disc
		// tests is assembleLod's business, so any exclusion traverse() attached
		// to any of them counts as "not this module's doing".
		const given = new Map();
		for (const ring of rings) {
			for (const n of ring.nodes) {
				if (!given.has(n.path)) given.set(n.path, new Set());
				for (const d of n.exclude ?? []) given.get(n.path).add(d);
			}
		}
		const out = lod.assembleLod(rings, centre);
		const kept = new Set(out.map((n) => n.path));
		const seen = new Set();
		for (const n of out) {
			// One path, one node. Two nodes for the same path is the same ground
			// drawn twice, which is the z-fight this module exists to remove.
			if (seen.has(n.path)) return `assembleLod kept ${n.path} twice`;
			seen.add(n.path);
			if (!Array.isArray(n.exclude)) return `exclude is ${pretty(n.exclude)}`;
			if (n.exclude.some((d) => !Number.isInteger(d) || d < 0 || d > 7)) return `exclude holds a non-octant: ${pretty(n.exclude)}`;
			if (new Set(n.exclude).size !== n.exclude.length) return `exclude repeats an octant: ${pretty(n.exclude)}`;
			// Only the octants THIS module added: what traverse() already put on
			// the node is its own decision, and asserting on it would be checking
			// the generator. An octant assembleLod excludes with nothing finer
			// drawing it is a hole — the sky through the ground.
			for (const d of n.exclude) {
				if (given.get(n.path)?.has(d)) continue;
				if (![...kept].some((p) => p.startsWith(n.path + d) && p !== n.path)) {
					return `assembleLod made ${n.path} exclude octant ${d} with nothing finer covering it`;
				}
			}
			// And the reverse: a retained node whose parent is also retained must
			// have that parent excluding the octant that leads to it.
			for (let len = 1; len < n.path.length; len++) {
				const ancestor = out.find((o) => o.path === n.path.slice(0, len));
				if (ancestor && !ancestor.exclude.includes(Number(n.path[len]))) {
					return `${ancestor.path} and ${n.path} both draw octant ${n.path[len]}`;
				}
			}
		}
		const d = lod.metersBetween(centre, { lat: centre.lat + 0.001, lon: centre.lon });
		if (!(d >= 0)) return `metersBetween = ${d}`;
		return null;
	},
},

{
	name: 'terminal-screen',
	note: 'the FIELD header — /__map-api/scenes answers from a scenes.json that add-map, remove-map and sync-scenes all write, and that drifts from disk',
	// The operator half of this screen is fuzzed by operator-file, which
	// reproduces an unfixed defect and is therefore out of the default run.
	// Here the operator is well-formed and the SCENE LIST is what is hostile:
	// `null` is what the client sees when the route is unreachable, and a
	// scene whose bytes are missing or absurd is what a drifted scenes.json
	// gives (the route computes them from disk when the file has none).
	gen(r) {
		return {
			operator: {
				id: 'neo-0000',
				name: pick(r, ['NEO', '', 'x'.repeat(400), '🛸', 'a b c']),
				sessions: Array.from({ length: int(r, 0, 4) }, () => storedSession(r)),
				terrainCache: Array.from({ length: int(r, 0, 3) }, () => ({ slug: 'tour-eiffel' })),
			},
			scenes: chance(r, 0.25) ? null : Array.from({ length: int(r, 0, 5) }, () => ({
				slug: pick(r, ['tour-eiffel', '', 'a-b']),
				name: pick(r, ['Tour Eiffel', '', '\u00cele de la Cit\u00e9', 'x'.repeat(300)]),
				bytes: pick(r, [1234567, 0, -1, NaN, null, undefined, 1e18, '5']),
			})),
			shared: chance(r, 0.5),
		};
	},
	check({ operator, scenes, shared }) {
		const model = terminal.terminalModel({ operator, scenes, shared });
		if (typeof model.operatorName !== 'string' || !model.operatorName) return `operatorName = ${pretty(model.operatorName)}`;
		if (typeof model.footer !== 'string' || !model.footer) return `footer = ${pretty(model.footer)}`;
		// The footer is two words and a build number; nothing about a broken
		// operator file may show up in it.
		if (textLeak(model.footer)) return `footer ${textLeak(model.footer)}`;
		if (!Array.isArray(model.areas)) return `areas = ${pretty(model.areas)}`;
		for (const a of model.areas) {
			if (typeof a.size !== 'string') return `area size = ${pretty(a.size)}`;
			if (textLeak(a.size)) return `formatBytes ${textLeak(a.size)}`;
		}
		for (const n of [NaN, Infinity, -1, 0, 1e18, -0]) {
			const s = terminal.formatBytes(n);
			if (typeof s !== 'string' || textLeak(s)) return `formatBytes(${n}) = ${pretty(s)}`;
		}
		return null;
	},
},

{
	name: 'nonprimitive-json',
	// One target for one defect class, across every place this session found a
	// new instance of it. `{"toString": null}` is valid JSON: JSON.parse builds
	// it happily, and `String()` on it raises "Cannot convert object to
	// primitive value" — an engine TypeError where the code meant to name a
	// field. Three sources, all of them things the game reads and does not
	// write: the operator file on disk, public/music.json over HTTP, and the
	// Open-Meteo answer.
	note: 'every remaining `String(v)` over JSON the game did not write — the operator file, public/music.json and the api.open-meteo.com body',
	gen(r) {
		// Every one of these survives JSON.parse — that is the point.
		const hostile = () => pick(r, [{ toString: null }, [], { a: 1 }, { toString: 3 }]);
		return {
			where: pick(r, ['operator', 'music', 'open-meteo']),
			operator: {
				id: 'neo-0000',
				// Valid JSON, every one of them, and none is a string.
				name: pick(r, ['NEO', '', null, 42, hostile(), true]),
				sessions: pick(r, [[], null, false, 0, 'two', { length: 2 }, [null]]),
				terrainCache: pick(r, [[], null, 3, {}]),
			},
			manifest: {
				schemaVersion: pick(r, [1, hostile()]),
				tracks: [{ id: pick(r, ['menu-0', hostile()]), pool: pick(r, ['menu', hostile()]), file: 'music/0.opus', durS: 90, bpm: 128 }],
			},
			payload: { daily: { time: ['2026-09-13'], weather_code: [0], precipitation_sum: [0], precipitation_hours: [0], wind_speed_10m_max: [4], wind_gusts_10m_max: [6], wind_direction_10m_dominant: [180] },
				hourly: { time: [pick(r, ['2026-09-13T00:00', hostile()])], visibility: [20000], cloud_cover: [10] } },
		};
	},
	check({ where, operator, manifest, payload }) {
		if (where === 'operator') {
			// FIELD is the first screen after boot. Whatever the file holds, it
			// has to mount — the six sibling formatters already learned that.
			let model;
			try { model = terminal.terminalModel({ operator, scenes: null }); } catch (err) {
				return `terminalModel threw on a stored operator: ${err?.name}: ${err?.message}`;
			}
			if (typeof model.operatorName !== 'string') return `operatorName = ${pretty(model.operatorName)}`;
			if (textLeak(model.footer)) return `footer ${textLeak(model.footer)}`;
			return null;
		}
		if (where === 'music') {
			// The gate is documented to RETURN its problems; a hostile value
			// makes it throw them instead, out of the template literal that was
			// about to name the offending field.
			let problems;
			try { problems = musicModel.validateManifest(manifest); } catch (err) {
				return `validateManifest threw instead of reporting: ${err?.name}: ${err?.message}`;
			}
			if (problems.length > 0) return null;   // refused: the game goes silent, by design
			try { jukebox.buildLibrary(manifest); } catch (err) {
				return `validateManifest called this manifest clean and buildLibrary then threw ${err?.name}: ${err?.message}`;
			}
			return null;
		}
		// dailyMean() puts hourly.time[i] through asText() before
		// .startsWith(day). The answer is a third party's, and the refusal the
		// server logs should say "unusable Open-Meteo answer", not name a JS
		// conversion.
		try { weather.fromOpenMeteo(payload); } catch (err) {
			if (err instanceof TypeError) return `fromOpenMeteo refused with an engine error: ${err.message}`;
		}
		return null;
	},
},

{
	name: 'drone-build',
	note: '?build=<seed> — an arbitrary string from a crafted link that decides the mass, the thrust and the rates actually flown',
	gen(r) {
		return {
			seed: chance(r, 0.5) ? pick(r, NASTY_STRINGS.filter((s) => s.length > 0)) : `${int(r, 0, 1e9)}`,
			family: pick(r, FAMILIES),
		};
	},
	check({ seed, family }) {
		let b;
		try { b = targetBuild.targetBuild({ seed, family }); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `targetBuild threw a useless error: ${pretty(err)}`;
			return null;   // `seed requis` on a falsy seed is the documented refusal
		}
		const bad = firstNonFinite(b.profile);
		if (bad) return `the flown profile holds ${bad}`;
		const base = PROFILES[family];
		// What defines the family never moves: a link may hand you a worn pack,
		// not a different airframe.
		for (const k of targetBuild.INVARIANTS) {
			if (JSON.stringify(b.profile[k]) !== JSON.stringify(base[k])) return `?build= changed ${k}, which is a family invariant`;
		}
		const within = (v, [lo, hi], label) => (v >= lo - 1e-9 && v <= hi + 1e-9 ? null : `${label} = ${v}, outside [${lo}, ${hi}]`);
		const B = targetBuild.BUILD_BOUNDS;
		for (const [got, bounds, label] of [
			[b.profile.mass / base.mass, B.mass, 'mass factor'],
			[b.profile.maxOmega / base.maxOmega, B.kv, 'kv factor'],
			[b.profile.torqueRatio / base.torqueRatio, B.torqueRatio, 'torqueRatio factor'],
			[b.profile.bodyDrag.x / base.bodyDrag.x, B.bodyDrag, 'bodyDrag factor'],
			[b.profile.battery.capacityMah / base.battery.capacityMah, B.capacity, 'capacity factor'],
			[b.profile.battery.internalOhm / base.battery.internalOhm, B.internalOhm, 'internalOhm factor'],
		]) {
			const hit = within(got, bounds, label);
			if (hit) return hit;
		}
		if (!(targetBuild.thrustToWeight(b.profile) > 1)) return `thrust/weight = ${targetBuild.thrustToWeight(b.profile)} — this build cannot take off`;
		if (!(b.livery.wear >= 0 && b.livery.wear <= 1)) return `wear = ${b.livery.wear}`;
		const rateBad = firstNonFinite(b.rates);
		if (rateBad) return `rates hold ${rateBad}`;
		// Same seed, same machine: the server and the client build the same one.
		if (JSON.stringify(targetBuild.targetBuild({ seed, family })) !== JSON.stringify(b)) return 'targetBuild is not deterministic for one seed';
		return null;
	},
},

{
	name: 'dialogue',
	note: 'the RTC crew — /dialogue/<event>.json is fetched at runtime, and the anti-repetition memory lives in the hand-editable operator file',
	// The pool is REAL entries. A shard that half-downloaded is not JSON and
	// falls back to the embedded pack (src/dialogue.js catches it), and the
	// corpus itself is gated by tools/dialogue/validate.mjs — so a shard whose
	// entries have the wrong TYPES is a shape nothing produces. What a shard
	// really varies by is which entries it holds and in what order, and that is
	// what is drawn here. The hostility lives in `ctx` (live flight numbers,
	// which really do go non-finite) and in `memory` (the operator file).
	gen(r, i) {
		const pool = CORPUS.length ? CORPUS : FALLBACK;
		const entries = [];
		for (let k = 0, n = int(r, 0, 12); k < n; k++) entries.push(pool[int(r, 0, pool.length - 1)]);
		return {
			event: pick(r, [...Object.keys(dialogueCatalog.EVENTS), 'NOPE', '']),
			entries,
			// Live flight numbers. resolvePath() is documented to turn a NaN into
			// null (i.e. into ineligibility), which is exactly the promise here.
			ctx: {
				operator: { name: pick(r, ['NEO', '', null, 42]) },
				machine: { gpu: pick(r, ['Apple M2', null]), display: pick(r, ['2560 \u00d7 1440', null]) },
				area: { name: pick(r, ['tour-eiffel', '', null, { toString: null }]) },
				weather: { summary: pick(r, ['CLEAR / CALM', null]), windMs: pick(r, [4, 0, NaN, Infinity, null]), rain: pick(r, ['2.0 mm/h', null]), visibility: pick(r, ['10 km', null]) },
				scan: { count: pick(r, [4, 0, NaN, null]) },
				target: { video: pick(r, ['ANALOG', null]), rssiDbm: pick(r, [-70, NaN, null]), hackType: pick(r, ['GNSS SPOOF', null]) },
				drone: { label: pick(r, ['freestyle 5"', null]) },
				terrain: { tiles: pick(r, [1200, 0, NaN, null]), megabytes: pick(r, [340, Infinity, null]) },
				session: { durationS: pick(r, [600, NaN, null]) },
			},
			memory: i % 2 === 0 ? dialogueEngine.emptyMemory() : {
				ring: Array.from({ length: int(r, 0, 40) }, () => pick(r, ['hack/0001', '', null])),
				seen: chance(r, 0.5) ? {} : anyObject(r, 1),
				buckets: chance(r, 0.5) ? {} : { jensen: pick(r, [0, -1, NaN, 'x']) },
				seq: pick(r, [0, 5, -1, NaN, '3', 1e15]),
			},
			rounds: int(r, 1, 12),
		};
	},
	check({ event, entries, ctx, memory, rounds }) {
		let mem = memory;
		const rng = makeRng(7);
		for (let i = 0; i < rounds; i++) {
			let r2;
			try { r2 = dialogueEngine.select({ event, pool: entries, ctx, memory: mem, rng }); } catch (err) {
				return `select threw on a stored memory: ${err?.name}: ${err?.message}`;
			}
			if (!r2 || typeof r2 !== 'object') return `select returned ${pretty(r2)}`;
			mem = r2.memory;
			if (!Array.isArray(mem.ring)) return `select produced a memory whose ring is ${pretty(mem.ring)}`;
			// The memory is written back to the operator file on every line. An
			// unbounded one grows that file for ever.
			if (mem.ring.length > dialogueCatalog.MEMORY_RING) return `the memory ring grew to ${mem.ring.length}`;
			if (Object.keys(mem.seen ?? {}).length > dialogueCatalog.MEMORY_SEEN + 1) return `the seen map grew to ${Object.keys(mem.seen).length}`;
			if (!r2.entry) continue;
			// render() is documented to throw on a corpus validate.mjs never saw,
			// and both call sites catch it. What it must NOT do is succeed and put
			// a NaN in front of the player.
			let lines;
			try { lines = dialogueRender.render(r2.entry, ctx); } catch (err) {
				if (!(err instanceof Error) || !err.message) return `render threw a useless error: ${pretty(err)}`;
				continue;
			}
			// Against the TEMPLATE, not in the absolute: a crew member is allowed
			// to say the word "undefined" (target_scan.json line 5464 does), and
			// what matters is whether the interpolation put one there.
			for (const [k, l] of lines.entries()) {
				const before = String(r2.entry.lines?.[k]?.text ?? '');
				const leak = textLeak(l.text);
				if (leak && !textLeak(before)) return `render turned ${pretty(before)} into ${pretty(l.text)}`;
			}
			const beats = cadence.planExchange(lines, event, rng);
			let last = -1;
			for (const b of beats) {
				if (!Number.isFinite(b.atMs) || b.atMs < last) return `planExchange produced ${pretty(b.atMs)} after ${last}`;
				last = b.atMs;
			}
			if (!Number.isFinite(cadence.nextGapMs(event, rng))) return 'nextGapMs is not a delay';
		}
		return null;
	},
},

{
	name: 'hack-pattern',
	note: 'the ASCII grammars — t is (now - start)/1000 and survives a backgrounded tab, dur is variant.ms / variant.beats',
	gen(r) {
		return {
			name: pick(r, [...Object.keys(grammars.GRAMMARS), ...Object.keys(grammars.RITUAL_PRIMITIVES)]),
			// performance.now() is monotonic, so t never goes backwards; a tab
			// left in the background for a day is how it gets large.
			t: pick(r, [0, 0.5, 3.2, 1e4, 1e9, 86400]),
			seed: grammars.cosmeticSeed(pick(r, ['zone-1', '', '🛸', 'x'.repeat(300)])),
			lock: pick(r, [0, 0.5, 1, -1, 2, undefined]),
			dur: pick(r, [4, 1, 0.2, 0, undefined]),
		};
	},
	check({ name, t, seed, lock, dur }) {
		const draw = grammars.GRAMMARS[name] ?? grammars.RITUAL_PRIMITIVES[name];
		if (typeof draw !== 'function') return null;
		const el = { textContent: '' };
		draw(el, { t, seed, lock, dur });
		const text = el.textContent;
		if (typeof text !== 'string') return `${name} wrote ${pretty(text)} into the element`;
		// The field is a fixed 44x12 block. A row that is short or long shifts
		// every row under it, and the screen is monospace and framed.
		const rows = text.split('\n');
		if (rows.length !== 12) return `${name} drew ${rows.length} rows instead of 12`;
		for (const [i, row] of rows.entries()) {
			if ([...row].length !== 44) return `${name} row ${i} is ${[...row].length} characters wide, not 44`;
		}
		const leak = textLeak(text);
		if (leak) return `${name} ${leak}`;
		// Same (t, seed): same frame. The pattern is redrawn every animation
		// frame and must not flicker between two identical ones.
		const el2 = { textContent: '' };
		draw(el2, { t, seed, lock, dur });
		if (el2.textContent !== text) return `${name} is not deterministic for one (t, seed)`;
		return null;
	},
},

{
	name: 'worker-pool',
	async: true,
	note: 'the rocktree Worker pool — a wave in flight, cancelled halfway, with the answers coming back out of order',
	gen(r) {
		const size = int(r, 1, 4);
		const maxInFlight = int(r, 1, 5);
		return {
			size, maxInFlight,
			jobs: int(r, 1, 24),
			// Which requests the window abandons at the next recentring, and when.
			abortAt: Array.from({ length: int(r, 0, 8) }, () => int(r, 0, 23)),
			// The order the workers answer in, and what they answer.
			shuffle: chance(r, 0.5),
			failures: Array.from({ length: int(r, 0, 6) }, () => int(r, 0, 23)),
			workerError: chance(r, 0.2),
			// Answers to ids nobody asked for: a stale worker from a previous wave.
			ghosts: int(r, 0, 3),
		};
	},
	async check({ size, maxInFlight, jobs, abortAt, shuffle, failures, workerError, ghosts }) {
		if (!(jobs > 0)) return null;
		const workers = [];
		const pool = createPool({ size, maxInFlight, makeWorker: () => { const w = { posted: [], postMessage(m) { this.posted.push(m); } }; workers.push(w); return w; } });
		const aborts = new Set(abortAt.filter((i) => Number.isInteger(i) && i >= 0 && i < jobs));
		const failed = new Set(failures.filter((i) => Number.isInteger(i)));
		const closed = [];
		const settled = new Array(jobs).fill(null);
		const controllers = [];
		for (let i = 0; i < jobs; i++) {
			const ctrl = new AbortController();
			controllers.push(ctrl);
			pool.fetchNode({ path: `3060${i}`, epoch: 1014 }, { signal: ctrl.signal })
				.then(() => { settled[i] = 'ok'; }, (e) => { settled[i] = e?.name === 'AbortError' ? 'abort' : 'error'; });
		}
		// Never more in flight than the pool says it allows: the cap is what keeps
		// six workers from decoding 640 MB of ImageBitmap at once.
		for (const w of workers) {
			if (w.posted.length > maxInFlight) return `a worker was handed ${w.posted.length} requests for a cap of ${maxInFlight}`;
		}
		if (pool.stats().inFlight > size * maxInFlight) return `stats() reports ${pool.stats().inFlight} in flight, over a capacity of ${size * maxInFlight}`;
		for (const i of aborts) controllers[i]?.abort();
		// Answer everything that was ever posted, in whatever order, twice for
		// some: a shared worker can answer after the request was abandoned.
		const answer = (w, msg) => w.onmessage?.({ data: msg });
		// Until the pool stops posting: a response frees a slot, which posts the
		// next queued job, which needs answering in its turn. The cap is only
		// there so a target bug cannot spin.
		for (let round = 0; round < 200 && workers.some((w) => w.posted.length); round++) {
			for (const w of workers) {
				const posted = shuffle ? [...w.posted].reverse() : [...w.posted];
				w.posted = [];
				for (const req of posted) {
					const id = req.id;
					if (failed.has(id % 24)) answer(w, { id, ok: false, error: 'node 404', status: 404 });
					else answer(w, { id, ok: true, matrix: new Float64Array(16), copyrightIds: [], meshes: [{ bitmap: { close() { closed.push(id); } } }] });
				}
			}
			for (let g = 0; g < ghosts; g++) answer(workers[0], { id: -1 - g, ok: true, meshes: [{ bitmap: { close() { closed.push(-1); } } }] });
			if (workerError && round === 2) workers[0]?.onerror?.({ message: 'out of memory' });
		}
		if (workers.some((w) => w.posted.length)) return 'the pool kept posting after every answer was delivered';
		await Promise.resolve();
		await new Promise((res) => setImmediate(res));
		// Nothing may be left hanging: a promise that never settles is a node
		// the window waits on for ever, and the wave never completes.
		const pendingIdx = settled.findIndex((s, i) => s === null && !aborts.has(i));
		if (pendingIdx >= 0) return `request ${pendingIdx} never settled`;
		for (const i of aborts) if (settled[i] !== 'abort' && settled[i] !== null) return `an aborted request settled as ${settled[i]}`;
		const stats = pool.stats();
		if (stats.queued !== 0) return `${stats.queued} job(s) left in the queue with every answer delivered`;
		if (stats.inFlight !== 0) return `${stats.inFlight} request(s) still counted in flight with every answer delivered`;
		return null;
	},
},

];

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

if (has('list')) {
	console.log('fuzz targets:\n');
	for (const t of targets) console.log(`  ${t.known ? '!' : ' '} ${t.name.padEnd(18)} ${t.note}`);
	const known = targets.filter((t) => t.known);
	if (known.length) {
		console.log('\n! = known failure: registered, reproduces an unfixed defect, and left OUT of the');
		console.log('    default run so it does not break CI. Run one with --only <name>, or all with --known.');
		for (const t of known) console.log(`      ${t.name}: ${t.known}`);
	}
	process.exit(0);
}

const cases = Number(flag('cases', 3000));
const seed = Number(flag('seed', 0x46555A5A));   // "FUZZ"
const only = flag('only', null);
const verbose = has('verbose');
// A target that reproduces a defect nobody has fixed yet still belongs in the
// file — it is how the fix gets verified — but it cannot be what CI runs.
// `--only <name>` and `--known` are the two ways back in.
const chosen = only ? targets.filter((t) => t.name === only) : targets.filter((t) => has('known') || !t.known);

if (chosen.length === 0) {
	console.error(`unknown target "${only}" — try --list`);
	process.exit(2);
}

console.log(`fuzz: ${chosen.length} target(s), ${cases} cases each, seed 0x${seed.toString(16)}\n`);

let failed = 0;
for (const target of chosen) {
	const result = target.async
		? await runTargetAsync(target, { cases: Math.min(cases, 400), seed, verbose })
		: runTarget(target, { cases, seed, verbose });
	const mark = result.failures.length === 0 ? ' ok ' : 'FAIL';
	console.log(`  ${mark}  ${target.name.padEnd(18)} ${String(result.ms).padStart(6)} ms`);
	for (const f of result.failures) {
		failed++;
		console.log(`        ${f.kind}: ${f.detail}`);
		console.log(`        seen in ${f.count ?? 1} case(s), smallest input (case ${f.case}):`);
		console.log(`          ${pretty(f.input)}`);
		if (f.stack && verbose) console.log(f.stack.split('\n').slice(1, 4).map((l) => `        ${l.trim()}`).join('\n'));
	}
}

const skipped = only ? [] : targets.filter((t) => t.known && !chosen.includes(t));
if (skipped.length) console.log(`\nskipped (known failure): ${skipped.map((t) => t.name).join(', ')} — run with --known`);
console.log(`\n${failed === 0 ? 'no findings' : `${failed} finding(s)`} — replay with --seed 0x${seed.toString(16)} --cases ${cases}`);
process.exit(failed === 0 ? 0 : 1);
