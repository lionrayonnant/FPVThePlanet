// Selftest for the pure BENCH logic (PHASE 26). No I/O.
// Run: node tools/bench-selftest.mjs
import assert from 'node:assert/strict';
import {
	BENCH_DEFAULTS, BENCH_VERSION, BENCH_CREED, BENCH_SEAL, MODE_SELECT, MODES,
	ENTRY_MODES, LINK_MODES, BATTERY_MODES, HUD_MODES, LIMITS,
	normalizeBenchConfig, benchSimParams, benchEntryRequest, benchDate,
	benchRows, benchBlockers, formatClock,
	serializeBenchConfig, parseBenchConfig, BENCH_STORAGE_KEY,
} from './bench-model.mjs';
import { simParamsOf, toSimParams } from './lib/weather.mjs';
import { FAMILIES } from '../src/drone-profiles.js';
import { CATEGORIES } from '../src/entry-state.js';
import { flightLabel } from '../src/fpvtp-osd.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// ---------------------------------------------------------------------------
// Normalisation: it BRINGS BACK, it never rejects.

t('normalize: nothing at all -> the defaults', () => {
	for (const junk of [undefined, null, 0, '', 'nope', [], NaN, true]) {
		const c = normalizeBenchConfig(junk);
		assert.equal(c.version, BENCH_VERSION);
		assert.equal(c.airframe.family, BENCH_DEFAULTS.airframe.family);
		assert.equal(c.entry, BENCH_DEFAULTS.entry);
		assert.equal(c.link, BENCH_DEFAULTS.link);
	}
});

t('normalize: a corrupt config becomes playable again, without throwing', () => {
	const c = normalizeBenchConfig({
		version: 'lol', airframe: 'not-an-object', terrain: 42,
		entry: 'SUPER_HOLY_SHIT', fence: 'yes', timeMin: -900,
		weather: { windSpeed: 'beaucoup', rateMmH: Infinity, cloudPct: -40, visibilityM: null },
		link: 'TELEPATHY', battery: 42,
	});
	assert.equal(c.entry, BENCH_DEFAULTS.entry);
	assert.equal(c.fence, BENCH_DEFAULTS.fence);
	assert.equal(c.timeMin, 0);
	assert.equal(c.weather.windSpeed, BENCH_DEFAULTS.weather.windSpeed);
	assert.equal(c.weather.rateMmH, BENCH_DEFAULTS.weather.rateMmH);
	assert.equal(c.weather.cloudPct, 0);
	assert.equal(c.weather.visibilityM, BENCH_DEFAULTS.weather.visibilityM);
	assert.equal(c.link, BENCH_DEFAULTS.link);
	assert.equal(c.battery, BENCH_DEFAULTS.battery);
});

t('normalize: every numeric value is clamped to its LIMITS', () => {
	const hi = normalizeBenchConfig({
		timeMin: 99999,
		weather: { windSpeed: 900, gustFactor: 99, windDir: 725, rateMmH: 900, visibilityM: 9e9, cloudPct: 900 },
	});
	assert.equal(hi.timeMin, LIMITS.timeMin.max);
	assert.equal(hi.weather.windSpeed, LIMITS.windSpeed.max);
	assert.equal(hi.weather.gustFactor, LIMITS.gustFactor.max);
	assert.equal(hi.weather.windDir, LIMITS.windDir.max);
	assert.equal(hi.weather.rateMmH, LIMITS.rateMmH.max);
	assert.equal(hi.weather.visibilityM, LIMITS.visibilityM.max);
	assert.equal(hi.weather.cloudPct, LIMITS.cloudPct.max);

	const lo = normalizeBenchConfig({
		timeMin: -1,
		weather: { windSpeed: -5, gustFactor: 0, windDir: -90, rateMmH: -1, visibilityM: 1, cloudPct: -1 },
	});
	assert.equal(lo.timeMin, LIMITS.timeMin.min);
	assert.equal(lo.weather.windSpeed, LIMITS.windSpeed.min);
	assert.equal(lo.weather.gustFactor, LIMITS.gustFactor.min);
	assert.equal(lo.weather.windDir, LIMITS.windDir.min);
	assert.equal(lo.weather.rateMmH, LIMITS.rateMmH.min);
	assert.equal(lo.weather.visibilityM, LIMITS.visibilityM.min);
	assert.equal(lo.weather.cloudPct, LIMITS.cloudPct.min);
});

t('normalize: zero is a value, not an absence', () => {
	// The Number(null) === 0 trap: a wind set to 0 must STAY 0 rather than fall
	// back to the default, and a non-zero default must be replaceable by 0.
	const c = normalizeBenchConfig({ weather: { windSpeed: 0, visibilityM: 30, cloudPct: 0 }, timeMin: 0 });
	assert.equal(c.weather.windSpeed, 0);
	assert.equal(c.weather.visibilityM, 30);
	assert.equal(c.timeMin, 0);
});

t('normalize: is idempotent', () => {
	const once = normalizeBenchConfig({ entry: 'ACTIVE', weather: { windSpeed: 7.3 }, fence: false });
	assert.deepEqual(normalizeBenchConfig(once), once);
});

t('normalize: the family is validated against the real list when it is given', () => {
	// Without the list, only one thing is known: it is a non-empty string.
	assert.equal(normalizeBenchConfig({ airframe: { family: 'ornithoptere' } }).airframe.family, 'ornithoptere');
	// With the list, a family that has gone falls back to the default — which is
	// what avoids the known failure mode "renaming a family invalidates what is
	// already stored".
	const c = normalizeBenchConfig({ airframe: { family: 'ornithoptere' } }, { families: FAMILIES });
	assert.ok(FAMILIES.includes(c.airframe.family));
	assert.equal(c.airframe.family, BENCH_DEFAULTS.airframe.family);
	// And a real family goes through.
	for (const f of FAMILIES) {
		assert.equal(normalizeBenchConfig({ airframe: { family: f } }, { families: FAMILIES }).airframe.family, f);
	}
});

t('normalize: NOMINAL and the drawn individual', () => {
	assert.equal(normalizeBenchConfig({}).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: '' } }).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: 42 } }).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: '4f2a91' } }).airframe.seed, '4f2a91');
});

t('normalize: a pre-#159 config keeps its build', () => {
	// The airframe used to be `{family, seed}`, where the PRESENCE of a seed was
	// the base. Nothing migrates by hand — the normalisation reads the old shape
	// and brings it forward, which is the whole reason there is no migration
	// table in tools/bench-model.mjs.
	const old = normalizeBenchConfig({ version: 1, airframe: { family: 'race5', seed: '4f2a91' } }, { families: FAMILIES });
	assert.equal(old.airframe.base, 'INDIVIDUAL');
	assert.equal(old.airframe.seed, '4f2a91');
	assert.deepEqual(old.airframe.overrides, {});
	const nominal = normalizeBenchConfig({ version: 1, airframe: { family: 'race5' } }, { families: FAMILIES });
	assert.equal(nominal.airframe.base, 'NOMINAL');
});

// ---------------------------------------------------------------------------
// Weather: the same translation as the world, without its coherence rules.

t('benchSimParams: at equal conditions, the bench writes what the world writes', () => {
	// The heart of the decision: at 12 m/s the bench and the world must put the
	// SAME numbers into wind.js/rain.js/fog.js, otherwise "flying at the bench"
	// says nothing about "flying for real".
	const day = { windSpeed: 12, windGust: 18, windDir: 270, rateMmH: 4, cloudPct: 80, visibilityM: 8000 };
	const world = simParamsOf(day);
	const bench = benchSimParams({
		weather: {
			windSpeed: 12, gustFactor: 18 / 12, windDir: 270,
			rateMmH: 4, cloudPct: 80, visibilityM: 8000,
		},
	});
	assert.deepEqual(bench, world);
});

t('benchSimParams: the bench is allowed to be physically incoherent', () => {
	// sanitize() enforces "it does not rain under a blue sky": a shower pushes
	// cover up to 70 % at least. The bench must return exactly what it is
	// asked for.
	const asked = { windSpeed: 0, gustFactor: 1, windDir: 0, rateMmH: 8, cloudPct: 0, visibilityM: 25000 };
	const bench = benchSimParams({ weather: asked });
	assert.equal(bench.cloud.cover, 0, 'clear sky asked for, clear sky returned');
	assert.ok(bench.rain.intensity > 0, 'and it rains all the same');

	// The world, on the same request, corrects.
	const world = toSimParams({ windSpeed: 0, windGust: 0, windDir: 0, rateMmH: 8, cloudPct: 0, visibilityM: 25000 });
	assert.ok(world.cloud.cover >= 0.7, 'the world closes the sky again — which is right for a forecast');
});

t('benchSimParams: strong wind does not sweep away the fog that was asked for', () => {
	// sanitize()'s other rule: past 8 m/s visibility goes back up to 1500 m. At
	// the bench, "pea soup in a gale" is a legitimate request — it is exactly
	// the kind of thing you go there to test.
	const bench = benchSimParams({ weather: { windSpeed: 20, gustFactor: 1, windDir: 0, rateMmH: 0, cloudPct: 100, visibilityM: 50 } });
	assert.ok(bench.fog.intensity > 0.8, `thick fog kept — ${bench.fog.intensity.toFixed(2)}`);
	assert.equal(bench.wind.speed, 20);
});

t('benchSimParams: always returns the five blocks, whatever comes in', () => {
	for (const junk of [undefined, null, {}, { weather: null }, { weather: { windSpeed: NaN } }]) {
		const p = benchSimParams(junk);
		for (const k of ['wind', 'rain', 'fog', 'cloud', 'sun']) {
			assert.ok(p[k] && typeof p[k] === 'object', `${k} present`);
		}
		for (const v of [p.wind.speed, p.rain.intensity, p.fog.intensity, p.cloud.cover]) {
			assert.ok(Number.isFinite(v), 'no NaN comes out of the bench');
		}
	}
});

// ---------------------------------------------------------------------------
// Entry state and sun

t('benchEntryRequest: IDLE asks for the ground, the rest ask for their category', () => {
	assert.deepEqual(benchEntryRequest({ entry: 'IDLE' }), { idle: true });
	for (const c of CATEGORIES) {
		assert.deepEqual(benchEntryRequest({ entry: c }), { category: c });
	}
});

t('ENTRY_MODES: IDLE plus exactly Bible §20\'s categories', () => {
	// If a category is added to the generator, the bench must offer it —
	// otherwise it becomes the one place in the game that cannot produce it.
	assert.deepEqual(ENTRY_MODES, ['IDLE', ...CATEGORIES]);
});

t('benchDate: sets a time on the current day, not a date', () => {
	const now = new Date('2026-03-12T22:17:43.500Z');
	const d = benchDate({ timeMin: 6 * 60 + 30 }, now);
	assert.equal(d.getHours(), 6);
	assert.equal(d.getMinutes(), 30);
	assert.equal(d.getSeconds(), 0);
	assert.equal(d.getMilliseconds(), 0);
	assert.equal(d.getFullYear(), now.getFullYear());
	assert.equal(d.getMonth(), now.getMonth());
	assert.equal(d.getDate(), now.getDate());
	assert.ok(Number.isFinite(d.getTime()), 'never an invalid date — sun.js would turn it into silent NaNs');
});

t('benchDate: midnight and 23:59 both hold', () => {
	const now = new Date('2026-03-12T12:00:00Z');
	assert.equal(formatClock(0), '00:00');
	assert.equal(benchDate({ timeMin: 0 }, now).getHours(), 0);
	assert.equal(formatClock(1439), '23:59');
	assert.equal(benchDate({ timeMin: 1439 }, now).getHours(), 23);
});

// ---------------------------------------------------------------------------
// The screen

t('benchRows: one row per setting, all of them readable', () => {
	const rows = benchRows(BENCH_DEFAULTS);
	const keys = rows.map((r) => r.key);
	// gust and dir get their own row: three wind sliders, three readouts. A
	// slider with no displayed value leaves a hole in the right-hand column and
	// cannot be set to a number.
	assert.deepEqual(keys, ['family', 'seed', 'detail', 'terrain', 'entry', 'fence', 'hud', 'time', 'wind', 'gust', 'dir', 'rain', 'fog', 'cloud', 'link', 'battery']);
	for (const r of rows) {
		assert.ok(r.label && typeof r.label === 'string', 'a label');
		assert.ok(r.value !== undefined && r.value !== null && String(r.value).length, `a value for ${r.key}`);
		assert.ok(!/undefined|NaN|null/.test(String(r.value)), `no technical leak in "${r.value}"`);
	}
});

t('benchRows: the family label comes from the caller', () => {
	// The model does not know the labels: they live in drone-profiles.js.
	const rows = benchRows({ airframe: { family: 'race5' } }, { familyLabel: () => '5" RACE' });
	assert.equal(rows.find((r) => r.key === 'family').value, '5" RACE');
});

t('benchRows: IDLE ON GROUND and HOLY SHIT read in plain words', () => {
	assert.equal(benchRows({ entry: 'IDLE' }).find((r) => r.key === 'entry').value, 'IDLE ON GROUND');
	assert.equal(benchRows({ entry: 'HOLY_SHIT' }).find((r) => r.key === 'entry').value, 'HOLY SHIT');
});

t('benchRows: cached terrain and free flight display differently', () => {
	const cached = benchRows({ terrain: { kind: 'cached', slug: 'paristest' } });
	assert.equal(cached.find((r) => r.key === 'terrain').value, 'PARISTEST');
	const live = benchRows({ terrain: { kind: 'live', lat: 48.8584, lon: 2.2945 } });
	assert.match(live.find((r) => r.key === 'terrain').value, /^LIVE 48\.8584, 2\.2945$/);
	const none = benchRows({ terrain: { kind: 'cached', slug: null } });
	assert.equal(none.find((r) => r.key === 'terrain').value, 'NONE');
});

t('benchBlockers: the bench refuses only missing terrain', () => {
	assert.deepEqual(benchBlockers({ terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] }), []);
	// D2: LIVE first — it is the one way out that asks nothing of anybody.
	assert.equal(
		benchBlockers({ terrain: { kind: 'cached', slug: null } })[0],
		'NO LOCAL TERRAIN — SWITCH TO LIVE, OR ACQUIRE ONE IN FIELD');
	assert.match(
		benchBlockers({ terrain: { kind: 'cached', slug: 'disparue' } }, { scenes: [{ slug: 'paristest' }] })[0],
		/NO LONGER ON DISK/);
	// Free flight needs no terrain on disk at all.
	assert.deepEqual(benchBlockers({ terrain: { kind: 'live' } }), []);
});

t('benchBlockers: a fence turned off on a baked scene is said before the flight', () => {
	const b = benchBlockers({ fence: false, terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] });
	assert.ok(b.some((l) => /TERRAIN ENDS AT THE EDGE/.test(l)));
	// In free flight, a fence turned off does not mean that.
	assert.deepEqual(benchBlockers({ fence: false, terrain: { kind: 'live' } }), []);
});

t('benchBlockers: a setting with no effect in free flight SAYS SO', () => {
	// Free flight has no manifest, so no bbox to draw an entry point from. A
	// setting that does nothing and does not announce it is worse than no
	// setting: the operator would expect to drop in at HOLY SHIT and would
	// start from the ground.
	for (const cat of CATEGORIES) {
		const b = benchBlockers({ entry: cat, terrain: { kind: 'live' } });
		assert.ok(b.some((l) => /IGNORED IN LIVE FLIGHT/.test(l)), `${cat} is announced as ignored`);
	}
	// IDLE is exactly what happens: nothing to announce.
	assert.deepEqual(benchBlockers({ entry: 'IDLE', terrain: { kind: 'live' } }), []);
	// And on cached terrain, every category works.
	assert.deepEqual(
		benchBlockers({ entry: 'HOLY_SHIT', terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] }),
		[]);
});

// ---------------------------------------------------------------------------
// Persistence

t('serialisation: a stable round trip', () => {
	const c = normalizeBenchConfig({ entry: 'CHALLENGING', fence: false, weather: { windSpeed: 9.5, cloudPct: 60 } });
	assert.deepEqual(parseBenchConfig(serializeBenchConfig(c)), c);
});

t('serialisation: broken JSON starts again from the defaults, without throwing', () => {
	for (const junk of ['', '{', 'null', '[]', 'undefined', '{"weather":']) {
		assert.deepEqual(parseBenchConfig(junk), normalizeBenchConfig(null));
	}
});

t('serialisation: nothing stored says a flight took place', () => {
	// The watertightness invariant, at model level: the bench's config
	// persists, what happened on it does not. No session, photo, counter or
	// timestamp key may appear here.
	const txt = serializeBenchConfig(normalizeBenchConfig({ entry: 'ACTIVE' }));
	for (const forbidden of ['session', 'photo', 'randomart', 'flight', 'count', 'seq', 'result', 'landed', 'crashed']) {
		assert.ok(!txt.toLowerCase().includes(forbidden), `"${forbidden}" has no business in the bench config`);
	}
	// And no timestamp: `createdAt`, `fetchedAt`, `startedAt`... Searched on the
	// original case, because in lowercase the pattern would catch "lat".
	assert.ok(!/[a-z]At"/.test(txt), `a timestamp leaked into the bench config: ${txt}`);
	assert.equal(BENCH_STORAGE_KEY, 'fpvtp.bench', 'the fpvtp. prefix: resetting the settings must take it along');
});

// ---------------------------------------------------------------------------
// The copy

// D3/D6: DATA, JUKEBOX and SETTINGS come up at the root, under FIELD and BENCH.
// The order is the message — you fly first, then you read, then you listen, and
// you set things last.
t('MODE_SELECT: five ways, named, in English', () => {
	assert.deepEqual(MODES, ['field', 'bench', 'data', 'jukebox', 'settings']);
	assert.equal(MODE_SELECT.field.label, 'FIELD');
	// FIELD must not offer to acquire terrain: acquisition is closed in every
	// distributed build (server/auth.mjs needs FPVTP_ACQUIRE=1, which nothing
	// shipped sets), so the old wording sent a first-time player looking for a
	// button that does not exist. The line names the live terrain instead.
	assert.deepEqual(MODE_SELECT.field.lines, ['live terrain · find a signal', 'take a machine that is not yours']);
	assert.ok(!/acquire/i.test(MODE_SELECT.field.lines.join(' ')), 'FIELD does not promise an acquisition that is gated shut');
	assert.equal(MODE_SELECT.bench.label, 'BENCH');
	// Issue #26: ARCHIVE became DATA, and the copy says what you read there —
	// flight records, not a promise of progression.
	assert.equal(MODE_SELECT.data.label, 'DATA');
	assert.deepEqual(MODE_SELECT.data.lines, ['flight records · telemetry', 'where you have been']);
	assert.equal(MODE_SELECT.archive, undefined, 'the old entry does not survive the rename');
	// Issue #120: the JUKEBOX's second line warns that the radio does not stop
	// at the door. It is the only way to know before finding out.
	assert.equal(MODE_SELECT.jukebox.label, 'JUKEBOX');
	assert.ok(MODE_SELECT.jukebox.lines[1].includes('keeps playing'));
	assert.equal(MODE_SELECT.settings.label, 'SETTINGS');
	// Two lines under each way: what it holds, in two beats.
	for (const m of MODES) assert.equal(MODE_SELECT[m].lines.length, 2, `${m} has two lines`);
	for (const m of MODES) {
		assert.ok(MODE_SELECT[m].lines.length >= 1);
		for (const l of MODE_SELECT[m].lines) {
			// D5: the game is in English. An accent here is a forgotten French.
			assert.ok(!/[\u00c0-\u00ff]/i.test(l), `"${l}" is not English`);
		}
	}
	assert.ok(!/[\u00c0-\u00ff]/i.test(MODE_SELECT.title));
});

t('BENCH_CREED: the four absences, and the seal', () => {
	assert.deepEqual(BENCH_CREED, ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS']);
	assert.equal(BENCH_SEAL, 'NOTHING HERE IS LOGGED.');
	for (const l of [...BENCH_CREED, BENCH_SEAL]) assert.ok(!/[\u00c0-\u00ff]/i.test(l));
});

t('the exposed enumerations are non-empty and free of duplicates', () => {
	for (const [name, list] of Object.entries({ MODES, ENTRY_MODES, LINK_MODES, BATTERY_MODES })) {
		assert.ok(list.length > 1, `${name} offers a choice`);
		assert.equal(new Set(list).size, list.length, `${name} has no duplicate`);
	}
});

// --- HUD : clear / classic (#217) -------------------------------------------

t('hud: CLASSIC by default — a drone has an OSD', () => {
	assert.equal(BENCH_DEFAULTS.hud, 'CLASSIC');
	assert.deepEqual(HUD_MODES, ['CLASSIC', 'CLEAR']);
});

t('hud: an unknown value falls back to the default, it breaks nothing', () => {
	// Same rule as link and battery: normalizeBenchConfig BRINGS BACK instead of
	// rejecting — a config off the disk must never stop you from flying.
	assert.equal(normalizeBenchConfig({ hud: 'HOLOGRAM' }).hud, 'CLASSIC');
	assert.equal(normalizeBenchConfig({ hud: null }).hud, 'CLASSIC');
	assert.equal(normalizeBenchConfig({ hud: 'CLEAR' }).hud, 'CLEAR');
});

t('hud: the bench row says its value', () => {
	const rows = benchRows(normalizeBenchConfig({ hud: 'CLEAR' }));
	const row = rows.find((r) => r.key === 'hud');
	assert.ok(row, 'the row exists');
	assert.equal(row.label, 'HUD');
	assert.equal(row.value, 'CLEAR');
});

t('hud: survives a round trip to disk', () => {
	const c = normalizeBenchConfig({ hud: 'CLEAR' });
	assert.equal(parseBenchConfig(serializeBenchConfig(c)).hud, 'CLEAR');
});

// --- what the flight line announces (#217, #206) ----------------------------

t('flightLabel: the line says what you are flying on, not what you assume', () => {
	// The bench opens nothing and counts nothing — "NOTHING HERE IS LOGGED".
	assert.equal(flightLabel({ bench: true, sessionSeconds: 34 }), 'BENCH');
	// Streamed terrain (#218): it is a session like any other, but the terrain
	// is not on disk — no fence, the ground arrives in flight. The line says
	// so.
	assert.equal(flightLabel({ live: true, sessionSeconds: 34 }), 'LIVE 00:34');
	// An acquired area.
	assert.equal(flightLabel({ sessionSeconds: 34 }), 'SESSION 00:34');
});

t('flightLabel: the bench wins, and a missing duration breaks nothing', () => {
	assert.equal(flightLabel({ bench: true, live: true }), 'BENCH');
	assert.equal(flightLabel({}), 'SESSION 00:00');
	assert.equal(flightLabel({ live: true, sessionSeconds: null }), 'LIVE 00:00');
});

console.log(`\n${n} tests bench OK`);
