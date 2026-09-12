// Fuzzing the pure half of the sim: every layer that eats data it did not
// produce itself.
//
//   node tools/fuzz.mjs                  all targets, fixed seed
//   node tools/fuzz.mjs --list           what is covered
//   node tools/fuzz.mjs --only flight    one target
//   node tools/fuzz.mjs --cases 20000 --seed 7 --verbose
//
// The threat model, target by target, is written in each `note`. It is not
// "throw random bytes at a function": a function is only fuzzed with inputs it
// can really receive — a corrupt localStorage entry, a gamepad axis, a
// hand-edited operator file, a physics state that went to NaN after a crash —
// and only invariants it really promises are checked. Anything else produces
// findings nobody should act on.
//
// The HTTP surface is fuzzed separately, against a real server: tools/fuzz-api.mjs.

import { installFakeDom } from './lib/fake-dom.mjs';
import {
	makeRng, pick, int, chance, anyValue, anyObject, anyArray, mutate,
	nearNumber, firstNonFinite, textLeak, pretty, runTarget, jsonText, NASTY_STRINGS,
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
const track = await import('./track-model.mjs');
const session = await import('./session-model.mjs');
const log = await import('./session-log-model.mjs');
const data = await import('./data-model.mjs');
const targetModel = await import('./target-model.mjs');
const hack = await import('./hack-model.mjs');
const { parseSceneFlag, parseSwarmFlag, SCENE_SLUG_RE } = await import('./dev-flags.mjs');

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

// Absurd but short of where the arithmetic itself gives up. Telemetry has no
// upper bound anywhere — the client sends it, validateSession only asks for
// "finite and >= 0" — so a durationS of 1e308 is storable today, and adding it
// to itself overflows: the flight can then never be closed, and the DATA screen
// reports a career of Infinity seconds. That is one finding about what the
// server agrees to store (issue #83); re-deriving it from six targets on every
// run would drown everything else. Drop this clamp when the bound lands.
const plausible = (v) => (Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : v);

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
		durationS: plausible(nearNumber(r, 0, 3600)), distanceM: plausible(nearNumber(r, 0, 50000)),
		maxSpeedMs: plausible(nearNumber(r, 0, 60)), maxRateDps: plausible(nearNumber(r, 0, 2000)),
		maxAltitudeM: plausible(nearNumber(r, -100, 500)),
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
		const signals = [];
		for (let i = 0; i < 10; i++) {
			const v = nearNumber(r, -1, 1);
			signals.push(Number.isFinite(v) ? v : 0);
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
		// Telemetry merge is associative by design (three segments, any order).
		const t = s.flightTelemetry;
		const merged = session.mergeTelemetry(session.mergeTelemetry(t, t), t);
		const bad = firstNonFinite(merged);
		if (bad) return `mergeTelemetry produced ${bad}`;
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
	for (const t of targets) console.log(`  ${t.name.padEnd(18)} ${t.note}`);
	process.exit(0);
}

const cases = Number(flag('cases', 3000));
const seed = Number(flag('seed', 0x46555A5A));   // "FUZZ"
const only = flag('only', null);
const verbose = has('verbose');
const chosen = only ? targets.filter((t) => t.name === only) : targets;

if (chosen.length === 0) {
	console.error(`unknown target "${only}" — try --list`);
	process.exit(2);
}

console.log(`fuzz: ${chosen.length} target(s), ${cases} cases each, seed 0x${seed.toString(16)}\n`);

let failed = 0;
for (const target of chosen) {
	const result = runTarget(target, { cases, seed, verbose });
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

console.log(`\n${failed === 0 ? 'no findings' : `${failed} finding(s)`} — replay with --seed 0x${seed.toString(16)} --cases ${cases}`);
process.exit(failed === 0 ? 0 : 1);
