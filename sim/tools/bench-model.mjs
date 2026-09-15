// Pure BENCH logic (PHASE 26). No I/O, no DOM, no localStorage: importable by
// src/bench.js in the browser and by the selftest.
//
// ---------------------------------------------------------------------------
// What the bench is, and why it is allowed to exist inside this fiction
//
// FPVTP! is a reverse-engineering tool written by hardware hackers, and such a
// tool always has a bench: the local rig on which you test the interception
// chain against a synthetic target before pointing it at a real one. You do not
// debug your stack on a target you can burn.
//
//   NO TARGET       there is nobody at the other end — a model, not a machine
//   NO LINK         the feed comes back from your own rig
//   NO HACK         you do not break into your own bench
//   NO LOSS         nothing remote exists, so nothing can be lost
//   NOTHING LOGGED  nothing happened in the world, so nothing is written
//
// The five lines are one sentence. They are the fiction and the technical rule
// at once, and that is what keeps the bench from being an exemption: "The world
// persists. The machine doesn't." still holds, because at the bench there is
// neither world nor machine — there is a model.
//
// ---------------------------------------------------------------------------
// The normalisation rule
//
// normalize() BRINGS BACK, it never REJECTS. An out-of-range value is clamped,
// an absurd value falls back to its default, a corrupt config becomes a valid
// config again. The bench is the place without frustration: it has no right to
// refuse to open because it dislikes a key.
//
// And it does NOT apply sanitize()'s weather coherence rules (wind chases fog
// away, it does not rain under a blue sky). Those are right for a forecast and
// wrong for a bench: here, asking for a downpour under a clear sky is a
// legitimate request, and it has to arrive.

import { simParamsOf } from './lib/weather.mjs';
import {
	normalizeAirframe, airframeSummary, resolveBenchAirframe, airframeDefaults,
} from './bench-airframe.mjs';

// 2 (issue #159): the airframe stopped being `{family, seed}` and became a
// build — a base, a bill of materials, and an override map. Nothing migrates by
// hand: normalizeAirframe() reads the old shape, where the presence of a seed
// WAS the base, and brings it forward. That is the normalisation rule doing its
// job, which is why there is no migration table anywhere in this file.
export const BENCH_VERSION = 2;

// The five ways in. FIELD is the Bible's loop, BENCH is the sandbox, DATA is
// everything that is cold, JUKEBOX is the library you can finally hear, and
// SETTINGS is everything that is set once. The order is the message: fly first,
// read second, listen third, tune last (D3, D6).
//
// `archive` was renamed `data` (issue #26): the tab stopped being a shelf of
// logs and became a page that reads the operator's own flying back. A stored
// `fpvtp.mode` may still hold the old word — `loadLastMode()` in src/bench.js
// maps it here rather than dropping the cursor back on FIELD.
export const MODES = ['field', 'bench', 'data', 'jukebox', 'settings'];

// The copy of the selection screen. In English (D5), and checked by the
// selftest: it is the first thing an operator sees after their name, and it has
// to say what each way costs, not what it offers.
export const MODE_SELECT = {
	title: 'SELECT OPERATION MODE',
	// "acquire terrain" was a promise no shipped build can keep: acquisition is
	// gated behind FPVTP_ACQUIRE=1 (server/auth.mjs), which neither the desktop
	// app nor `npm run dev` sets, so DRAW BOX never appears anywhere a player
	// can reach. What FIELD actually offers is the live terrain — find a place
	// on the map, drop a pin, fly it — and that is what the line now says.
	field: {
		label: 'FIELD',
		lines: ['live terrain · find a signal', 'take a machine that is not yours'],
	},
	bench: {
		label: 'BENCH',
		lines: ['your airframe · your conditions', 'nothing to lose'],
	},
	// Two flat inventories rather than a promise: these two ways lead to what
	// they contain, and nothing there is lost or won. DATA says WHAT it holds,
	// not what it will do for you: no score, no progress, no promise (#26).
	data: {
		label: 'DATA',
		lines: ['flight records · telemetry', 'where you have been'],
	},
	// The second line is load-bearing, not flavour: a radio that keeps playing
	// after you walk out is the one thing about this way that is invisible
	// until it surprises you (issue #120).
	jukebox: {
		label: 'JUKEBOX',
		lines: ['the whole library · every pool', 'it keeps playing when you leave'],
	},
	settings: {
		label: 'SETTINGS',
		lines: ['controller · keyboard', 'audio · system'],
	},
};

// The four lines the bench shows about itself, and the fifth one that is the
// promise of watertightness. The selftest checks they are still there: the day
// the bench writes something, that line becomes a lie.
export const BENCH_CREED = ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS'];
export const BENCH_SEAL = 'NOTHING HERE IS LOGGED.';

export const ENTRY_MODES = ['IDLE', 'COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const LINK_MODES = ['LOOPBACK', 'SIMULATED'];
export const BATTERY_MODES = ['REAL', 'HELD'];
// The drone's OSD, not FPVTP!'s (PHASE 12, the double HUD). CLEAR renders
// exactly what `droneOsdLayout()` already knows how to render — `null`, its
// NO_OSD failure mode: a machine built without an OSD, for filming. The FPVTP!
// overlay never moves: the drone does not draw it, the operator does, and it
// carries PHOTO READY and the end of the flight.
export const HUD_MODES = ['CLASSIC', 'CLEAR'];
export const TERRAIN_KINDS = ['cached', 'live'];

// Bounds. Wide on purpose — the bench is not a forecast, it has to reach the
// extremes the world would never produce two days running. The ceilings are the
// models' own, not a matter of taste: wind.js saturates past 25 m/s, rain.js
// past 60 mm/h, and fog.js does not go below 30 m of visibility.
export const LIMITS = {
	windSpeed:   { min: 0, max: 25,    step: 0.5 },
	gustFactor:  { min: 1, max: 3,     step: 0.1 },
	windDir:     { min: 0, max: 359,   step: 5 },
	rateMmH:     { min: 0, max: 60,    step: 0.5 },
	visibilityM: { min: 30, max: 25000, step: 100 },
	cloudPct:    { min: 0, max: 100,   step: 5 },
	timeMin:     { min: 0, max: 1439,  step: 15 },
	lat:         { min: -90, max: 90 },
	lon:         { min: -180, max: 180 },
};

export const BENCH_DEFAULTS = Object.freeze({
	version: BENCH_VERSION,
	airframe: airframeDefaults('freestyle5'),
	terrain: { kind: 'cached', slug: null, lat: 48.8584, lon: 2.2945 },
	entry: 'IDLE',
	fence: true,
	hud: 'CLASSIC',
	timeMin: 14 * 60 + 30,
	weather: {
		windSpeed: 0,
		gustFactor: 1,
		windDir: 0,
		rateMmH: 0,
		visibilityM: 25000,
		cloudPct: 0,
	},
	link: 'LOOPBACK',
	battery: 'REAL',
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// A number, or the default. `Number(null)` is 0 and so is `Number('')`: the
// Number.isFinite check comes AFTER the conversion so that null/''/undefined all
// fall back to the default rather than to zero.
function num(v, fallback, limit) {
	// Number() THROWS on a symbol, a bigint, and on any object with no path to
	// a primitive (`Object.create(null)`, which is what a stored config becomes
	// on some JSON paths). This function is the one that promises the caller a
	// playable config no matter what is in localStorage, so it swallows that.
	let n;
	try { n = typeof v === 'number' ? v : Number(v); } catch { return fallback; }
	if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
	return limit ? clamp(n, limit.min, limit.max) : n;
}

function oneOf(v, allowed, fallback) {
	return allowed.includes(v) ? v : fallback;
}

// Brings anything back to a playable config. Never throws.
export function normalizeBenchConfig(raw, { families = null } = {}) {
	const d = BENCH_DEFAULTS;
	const r = (raw && typeof raw === 'object') ? raw : {};
	const w = (r.weather && typeof r.weather === 'object') ? r.weather : {};
	const t = (r.terrain && typeof r.terrain === 'object') ? r.terrain : {};

	return {
		version: BENCH_VERSION,
		// The build lives in ./bench-airframe.mjs, which owns the bases, the
		// catalogue and the parameter table. `families` is passed straight
		// through: it is still the caller's real list from drone-profiles.js
		// when the caller has it, and still absent here, for the same reason as
		// before — a model that imported the families itself could let the
		// selftest lie about one that has been removed.
		airframe: normalizeAirframe(r.airframe, { families }),
		terrain: {
			kind: oneOf(t.kind, TERRAIN_KINDS, d.terrain.kind),
			slug: typeof t.slug === 'string' && t.slug ? t.slug : null,
			lat: num(t.lat, d.terrain.lat, LIMITS.lat),
			lon: num(t.lon, d.terrain.lon, LIMITS.lon),
		},
		entry: oneOf(r.entry, ENTRY_MODES, d.entry),
		fence: typeof r.fence === 'boolean' ? r.fence : d.fence,
		hud: oneOf(r.hud, HUD_MODES, d.hud),
		timeMin: Math.round(num(r.timeMin, d.timeMin, LIMITS.timeMin)),
		weather: {
			windSpeed: num(w.windSpeed, d.weather.windSpeed, LIMITS.windSpeed),
			gustFactor: num(w.gustFactor, d.weather.gustFactor, LIMITS.gustFactor),
			windDir: Math.round(num(w.windDir, d.weather.windDir, LIMITS.windDir)),
			rateMmH: num(w.rateMmH, d.weather.rateMmH, LIMITS.rateMmH),
			visibilityM: num(w.visibilityM, d.weather.visibilityM, LIMITS.visibilityM),
			cloudPct: num(w.cloudPct, d.weather.cloudPct, LIMITS.cloudPct),
		},
		link: oneOf(r.link, LINK_MODES, d.link),
		battery: oneOf(r.battery, BATTERY_MODES, d.battery),
	};
}

// ---------------------------------------------------------------------------
// Translation into the rest of the engine
//
// Nothing is reimplemented here. Each function produces the shape an existing
// system already consumes, and that is all.

// The parameters for wind.js / rain.js / fog.js / cloud.js / sun.js.
//
// Goes through simParamsOf() — the SAME translation the world uses — but
// without the sanitize() that precedes it in FIELD mode. Intended consequence:
// at 12 m/s the bench and the world write exactly the same numbers, so they fly
// the same; but the bench can ask for rain under a clear sky, and get it.
export function benchSimParams(config) {
	const c = normalizeBenchConfig(config);
	const w = c.weather;
	return simParamsOf({
		windSpeed: w.windSpeed,
		windGust: w.windSpeed * w.gustFactor,
		windDir: w.windDir,
		rateMmH: w.rateMmH,
		cloudPct: w.cloudPct,
		visibilityM: w.visibilityM,
	});
}

// The argument for generateEntryState(). `IDLE` is not one of Bible §20's
// categories: it is the fallback on the ground, the one the generator already
// uses when it has found nothing. The bench asks for it explicitly.
export function benchEntryRequest(config) {
	const c = normalizeBenchConfig(config);
	return c.entry === 'IDLE' ? { idle: true } : { category: c.entry };
}

// The sun's instant. `timeMin` is a local time on the current day: the bench
// sets a time, not a date — you want "6 in the morning", not "12 March 2003".
// The sun.js path is OPTS.date's, unchanged.
export function benchDate(config, now = new Date()) {
	const c = normalizeBenchConfig(config);
	const d = new Date(now.getTime());
	d.setHours(Math.floor(c.timeMin / 60), c.timeMin % 60, 0, 0);
	return d;
}

// ---------------------------------------------------------------------------
// Text rendering of the screen (the DOM is only a dressing over it)

export function formatClock(timeMin) {
	const m = Math.round(clamp(Number(timeMin) || 0, 0, 1439));
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatVis(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Mass and thrust-to-weight of the resolved build, as one line.
export function machineLine(airframe) {
	const { profile, derived } = resolveBenchAirframe(airframe);
	return `${Math.round(derived.massG)} g · T:W ${derived.twr.toFixed(1)} · ${profile.battery.cells}S`;
}

// The bench's rows, in display order. `value` is what reads on the right;
// `key` is what the UI uses to know what to edit.
export function benchRows(config, { familyLabel = (f) => f } = {}) {
	const c = normalizeBenchConfig(config);
	const w = c.weather;
	return [
		{ key: 'family',  label: 'AIRFRAME', value: familyLabel(c.airframe.family) },
		{ key: 'seed',    label: 'BUILD',    value: airframeSummary(c.airframe) },
		// What the build WEIGHS and whether it will leave the ground, on the
		// bench's own screen rather than two screens in. Assembling parts is
		// only worth doing if the consequence is visible while you do it, and
		// thrust-to-weight is the one number that says whether there is a
		// machine here at all.
		{ key: 'detail',  label: 'MACHINE',  value: machineLine(c.airframe) },
		{ key: 'terrain', label: 'TERRAIN',
			value: c.terrain.kind === 'live'
				? `LIVE ${c.terrain.lat.toFixed(4)}, ${c.terrain.lon.toFixed(4)}`
				: (c.terrain.slug ? c.terrain.slug.toUpperCase() : 'NONE') },
		{ key: 'entry',   label: 'ENTRY',    value: c.entry === 'IDLE' ? 'IDLE ON GROUND' : c.entry.replace('_', ' ') },
		{ key: 'fence',   label: 'FENCE',    value: c.fence ? 'ON' : 'OFF' },
		{ key: 'hud',     label: 'HUD',      value: c.hud },
		{ key: 'time',    label: 'TIME',     value: formatClock(c.timeMin) },
		// Bible §48's mock writes the wind on ONE line — but it describes a
		// screen, not controls: setting gust and direction takes three sliders.
		// Each therefore says what it does, rather than a summary on the first
		// and nothing on the other two — otherwise the value column has holes,
		// and a slider with no readout cannot be set to a number.
		{ key: 'wind',    label: 'WIND',     value: `${w.windSpeed.toFixed(1)} m/s` },
		{ key: 'gust',    label: 'GUST',     value: `×${w.gustFactor.toFixed(1)}` },
		{ key: 'dir',     label: 'FROM',     value: `${String(w.windDir).padStart(3, '0')}°` },
		{ key: 'rain',    label: 'RAIN',     value: `${w.rateMmH.toFixed(1)} mm/h` },
		{ key: 'fog',     label: 'FOG',      value: `VIS ${formatVis(w.visibilityM)}` },
		{ key: 'cloud',   label: 'CLOUD',    value: `${Math.round(w.cloudPct)} %` },
		{ key: 'link',    label: 'LINK',     value: c.link },
		{ key: 'battery', label: 'BATTERY',  value: c.battery },
	];
}

// The bench cannot take off without terrain. That is the ONLY thing it
// refuses, and it says so rather than greying out a button with no explanation.
export function benchBlockers(config, { scenes = [] } = {}) {
	const c = normalizeBenchConfig(config);
	const out = [];
	if (c.terrain.kind === 'cached') {
		// LIVE first (D2): it is the one way out that asks nothing of anybody —
		// a shared server never lets a scene land on disk.
		if (!c.terrain.slug) out.push('NO LOCAL TERRAIN — SWITCH TO LIVE, OR ACQUIRE ONE IN FIELD');
		else if (scenes.length && !scenes.some((s) => s.slug === c.terrain.slug)) {
			out.push(`TERRAIN ${c.terrain.slug.toUpperCase()} IS NO LONGER ON DISK`);
		}
	}
	// Fence off on a baked scene: that is not a bug, it is the truth of the
	// data. The terrain stops at the edge of the acquired rectangle, and that
	// has to be readable BEFORE the flight rather than discovered in the void.
	if (!c.fence && c.terrain.kind === 'cached') out.push('FENCE OFF — TERRAIN ENDS AT THE EDGE OF THE ACQUIRED AREA');
	// In free flight there is no manifest, so no bbox to draw an entry point
	// from: the drone starts on the ground, under the station. Say so rather
	// than ignoring the setting in silence — a setting that does nothing and
	// does not announce it is worse than no setting at all.
	if (c.terrain.kind === 'live' && c.entry !== 'IDLE') {
		out.push(`ENTRY ${c.entry.replace('_', ' ')} IS IGNORED IN LIVE FLIGHT — NO SURVEYED AREA TO DROP INTO`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Persistence: pure serialisation. The localStorage read/write lives in
// src/bench.js — the model has no I/O.
//
// The bench's CONFIG persists, what HAPPENED on it does not. That is no breach
// of "nothing is written": setting twelve controls again on every launch would
// be exactly the frustration the bench removes. Nothing stored here says a
// flight took place.
export const BENCH_STORAGE_KEY = 'fpvtp.bench';

export function serializeBenchConfig(config) {
	return JSON.stringify(normalizeBenchConfig(config));
}

export function parseBenchConfig(text, opts) {
	try {
		return normalizeBenchConfig(JSON.parse(text), opts);
	} catch {
		// Unreadable config: start again from the defaults, saying nothing. The
		// bench has no error screen, it has a starting state.
		return normalizeBenchConfig(null, opts);
	}
}
