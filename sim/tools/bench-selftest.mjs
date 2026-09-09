// Selftest de la logique pure du BENCH (PHASE 26). Aucune E/S.
// Lancer : node tools/bench-selftest.mjs
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
// Normalisation : elle RAMÈNE, elle ne rejette jamais.

t('normalize : rien du tout → les défauts', () => {
	for (const junk of [undefined, null, 0, '', 'nope', [], NaN, true]) {
		const c = normalizeBenchConfig(junk);
		assert.equal(c.version, BENCH_VERSION);
		assert.equal(c.airframe.family, BENCH_DEFAULTS.airframe.family);
		assert.equal(c.entry, BENCH_DEFAULTS.entry);
		assert.equal(c.link, BENCH_DEFAULTS.link);
	}
});

t('normalize : une config corrompue redevient jouable, sans lever', () => {
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

t('normalize : chaque valeur numérique est bornée à ses LIMITS', () => {
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

t('normalize : zéro est une valeur, pas une absence', () => {
	// Le piège de Number(null) === 0 : un vent réglé à 0 doit RESTER 0 et non
	// retomber sur le défaut, et un défaut non nul doit être remplaçable par 0.
	const c = normalizeBenchConfig({ weather: { windSpeed: 0, visibilityM: 30, cloudPct: 0 }, timeMin: 0 });
	assert.equal(c.weather.windSpeed, 0);
	assert.equal(c.weather.visibilityM, 30);
	assert.equal(c.timeMin, 0);
});

t('normalize : est idempotente', () => {
	const once = normalizeBenchConfig({ entry: 'ACTIVE', weather: { windSpeed: 7.3 }, fence: false });
	assert.deepEqual(normalizeBenchConfig(once), once);
});

t('normalize : la famille est validée contre la vraie liste quand on la fournit', () => {
	// Sans la liste, on ne sait qu'une chose : c'est une chaîne non vide.
	assert.equal(normalizeBenchConfig({ airframe: { family: 'ornithoptere' } }).airframe.family, 'ornithoptere');
	// Avec la liste, une famille disparue retombe sur le défaut — c'est ce qui
	// évite le mode d'échec connu « renommer une famille invalide l'existant ».
	const c = normalizeBenchConfig({ airframe: { family: 'ornithoptere' } }, { families: FAMILIES });
	assert.ok(FAMILIES.includes(c.airframe.family));
	assert.equal(c.airframe.family, BENCH_DEFAULTS.airframe.family);
	// Et une famille réelle passe.
	for (const f of FAMILIES) {
		assert.equal(normalizeBenchConfig({ airframe: { family: f } }, { families: FAMILIES }).airframe.family, f);
	}
});

t('normalize : NOMINAL et exemplaire', () => {
	assert.equal(normalizeBenchConfig({}).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: '' } }).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: 42 } }).airframe.seed, null);
	assert.equal(normalizeBenchConfig({ airframe: { seed: '4f2a91' } }).airframe.seed, '4f2a91');
});

// ---------------------------------------------------------------------------
// Météo : la même traduction que le monde, sans ses règles de cohérence.

t('benchSimParams : à conditions égales, le banc écrit ce que le monde écrit', () => {
	// Le cœur de la décision : à 12 m/s, le banc et le monde doivent poser les
	// MÊMES nombres dans wind.js/rain.js/fog.js, sinon « voler au banc » ne
	// dit rien de « voler pour de vrai ».
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

t('benchSimParams : le banc a le droit d\'être physiquement incohérent', () => {
	// sanitize() force « il ne pleut pas sous un ciel bleu » : une averse
	// remonte la couverture à 70 % au minimum. Le banc, lui, doit rendre
	// exactement ce qu'on lui demande.
	const asked = { windSpeed: 0, gustFactor: 1, windDir: 0, rateMmH: 8, cloudPct: 0, visibilityM: 25000 };
	const bench = benchSimParams({ weather: asked });
	assert.equal(bench.cloud.cover, 0, 'ciel dégagé demandé, ciel dégagé rendu');
	assert.ok(bench.rain.intensity > 0, 'et il pleut quand même');

	// Le monde, sur la même demande, corrige.
	const world = toSimParams({ windSpeed: 0, windGust: 0, windDir: 0, rateMmH: 8, cloudPct: 0, visibilityM: 25000 });
	assert.ok(world.cloud.cover >= 0.7, 'le monde referme le ciel — et c\'est très bien pour un bulletin');
});

t('benchSimParams : du vent fort ne balaie pas le brouillard demandé', () => {
	// L'autre règle de sanitize() : au-delà de 8 m/s la visibilité remonte à
	// 1500 m. Au banc, « purée de pois dans une tempête » est une demande
	// légitime — c'est même exactement le genre de chose qu'on va tester.
	const bench = benchSimParams({ weather: { windSpeed: 20, gustFactor: 1, windDir: 0, rateMmH: 0, cloudPct: 100, visibilityM: 50 } });
	assert.ok(bench.fog.intensity > 0.8, `brouillard épais conservé — ${bench.fog.intensity.toFixed(2)}`);
	assert.equal(bench.wind.speed, 20);
});

t('benchSimParams : rend toujours les cinq blocs, quelles que soient les entrées', () => {
	for (const junk of [undefined, null, {}, { weather: null }, { weather: { windSpeed: NaN } }]) {
		const p = benchSimParams(junk);
		for (const k of ['wind', 'rain', 'fog', 'cloud', 'sun']) {
			assert.ok(p[k] && typeof p[k] === 'object', `${k} présent`);
		}
		for (const v of [p.wind.speed, p.rain.intensity, p.fog.intensity, p.cloud.cover]) {
			assert.ok(Number.isFinite(v), 'aucun NaN ne sort du banc');
		}
	}
});

// ---------------------------------------------------------------------------
// Entry state et soleil

t('benchEntryRequest : IDLE demande le sol, les autres demandent leur catégorie', () => {
	assert.deepEqual(benchEntryRequest({ entry: 'IDLE' }), { idle: true });
	for (const c of CATEGORIES) {
		assert.deepEqual(benchEntryRequest({ entry: c }), { category: c });
	}
});

t('ENTRY_MODES : IDLE plus exactement les catégories de la Bible §20', () => {
	// Si une catégorie est ajoutée au générateur, le banc doit la proposer —
	// sinon il devient le seul endroit du jeu qui ne sait pas la produire.
	assert.deepEqual(ENTRY_MODES, ['IDLE', ...CATEGORIES]);
});

t('benchDate : règle une heure du jour courant, pas une date', () => {
	const now = new Date('2026-03-12T22:17:43.500Z');
	const d = benchDate({ timeMin: 6 * 60 + 30 }, now);
	assert.equal(d.getHours(), 6);
	assert.equal(d.getMinutes(), 30);
	assert.equal(d.getSeconds(), 0);
	assert.equal(d.getMilliseconds(), 0);
	assert.equal(d.getFullYear(), now.getFullYear());
	assert.equal(d.getMonth(), now.getMonth());
	assert.equal(d.getDate(), now.getDate());
	assert.ok(Number.isFinite(d.getTime()), 'jamais une date invalide — sun.js en ferait des NaN silencieux');
});

t('benchDate : minuit et 23:59 tiennent tous les deux', () => {
	const now = new Date('2026-03-12T12:00:00Z');
	assert.equal(formatClock(0), '00:00');
	assert.equal(benchDate({ timeMin: 0 }, now).getHours(), 0);
	assert.equal(formatClock(1439), '23:59');
	assert.equal(benchDate({ timeMin: 1439 }, now).getHours(), 23);
});

// ---------------------------------------------------------------------------
// Écran

t('benchRows : une ligne par réglage, toutes lisibles', () => {
	const rows = benchRows(BENCH_DEFAULTS);
	const keys = rows.map((r) => r.key);
	// gust et dir ont leur propre ligne : trois curseurs de vent, trois lectures.
	// Un curseur sans valeur affichée laisse un trou dans la colonne de droite et
	// ne se règle pas au chiffre.
	assert.deepEqual(keys, ['family', 'seed', 'terrain', 'entry', 'fence', 'hud', 'time', 'wind', 'gust', 'dir', 'rain', 'fog', 'cloud', 'link', 'battery']);
	for (const r of rows) {
		assert.ok(r.label && typeof r.label === 'string', 'un libellé');
		assert.ok(r.value !== undefined && r.value !== null && String(r.value).length, `une valeur pour ${r.key}`);
		assert.ok(!/undefined|NaN|null/.test(String(r.value)), `pas de fuite technique dans « ${r.value} »`);
	}
});

t('benchRows : le libellé de famille passe par l\'appelant', () => {
	// Le modèle ne connaît pas les labels : ils vivent dans drone-profiles.js.
	const rows = benchRows({ airframe: { family: 'race5' } }, { familyLabel: () => '5" RACE' });
	assert.equal(rows.find((r) => r.key === 'family').value, '5" RACE');
});

t('benchRows : IDLE ON GROUND et HOLY SHIT se lisent en clair', () => {
	assert.equal(benchRows({ entry: 'IDLE' }).find((r) => r.key === 'entry').value, 'IDLE ON GROUND');
	assert.equal(benchRows({ entry: 'HOLY_SHIT' }).find((r) => r.key === 'entry').value, 'HOLY SHIT');
});

t('benchRows : terrain caché et vol libre s\'affichent différemment', () => {
	const cached = benchRows({ terrain: { kind: 'cached', slug: 'paristest' } });
	assert.equal(cached.find((r) => r.key === 'terrain').value, 'PARISTEST');
	const live = benchRows({ terrain: { kind: 'live', lat: 48.8584, lon: 2.2945 } });
	assert.match(live.find((r) => r.key === 'terrain').value, /^LIVE 48\.8584, 2\.2945$/);
	const none = benchRows({ terrain: { kind: 'cached', slug: null } });
	assert.equal(none.find((r) => r.key === 'terrain').value, 'NONE');
});

t('benchBlockers : le banc ne refuse que le terrain absent', () => {
	assert.deepEqual(benchBlockers({ terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] }), []);
	// D2 : LIVE d'abord — c'est la seule sortie qui ne demande rien à personne.
	assert.equal(
		benchBlockers({ terrain: { kind: 'cached', slug: null } })[0],
		'NO LOCAL TERRAIN — SWITCH TO LIVE, OR ACQUIRE ONE IN FIELD');
	assert.match(
		benchBlockers({ terrain: { kind: 'cached', slug: 'disparue' } }, { scenes: [{ slug: 'paristest' }] })[0],
		/NO LONGER ON DISK/);
	// Le vol libre n'a besoin d'aucun terrain sur disque.
	assert.deepEqual(benchBlockers({ terrain: { kind: 'live' } }), []);
});

t('benchBlockers : fence coupée sur scène cuite se dit avant le vol', () => {
	const b = benchBlockers({ fence: false, terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] });
	assert.ok(b.some((l) => /TERRAIN ENDS AT THE EDGE/.test(l)));
	// En vol libre, la clôture coupée n'a pas ce sens-là.
	assert.deepEqual(benchBlockers({ fence: false, terrain: { kind: 'live' } }), []);
});

t('benchBlockers : un réglage sans effet en vol libre le DIT', () => {
	// Le vol libre n'a pas de manifeste, donc pas de bbox où tirer un point
	// d'entrée. Un réglage qui n'agit pas et ne l'annonce pas est pire que pas
	// de réglage : l'opérateur croirait tomber en HOLY SHIT et partirait du sol.
	for (const cat of CATEGORIES) {
		const b = benchBlockers({ entry: cat, terrain: { kind: 'live' } });
		assert.ok(b.some((l) => /IGNORED IN LIVE FLIGHT/.test(l)), `${cat} est annoncé comme ignoré`);
	}
	// IDLE, lui, est bien ce qui se passe : rien à annoncer.
	assert.deepEqual(benchBlockers({ entry: 'IDLE', terrain: { kind: 'live' } }), []);
	// Et sur terrain caché, toutes les catégories fonctionnent.
	assert.deepEqual(
		benchBlockers({ entry: 'HOLY_SHIT', terrain: { kind: 'cached', slug: 'paristest' } }, { scenes: [{ slug: 'paristest' }] }),
		[]);
});

// ---------------------------------------------------------------------------
// Persistance

t('sérialisation : aller-retour stable', () => {
	const c = normalizeBenchConfig({ entry: 'CHALLENGING', fence: false, weather: { windSpeed: 9.5, cloudPct: 60 } });
	assert.deepEqual(parseBenchConfig(serializeBenchConfig(c)), c);
});

t('sérialisation : du JSON cassé repart des défauts, sans lever', () => {
	for (const junk of ['', '{', 'null', '[]', 'undefined', '{"weather":']) {
		assert.deepEqual(parseBenchConfig(junk), normalizeBenchConfig(null));
	}
});

t('sérialisation : rien de ce qui est stocké ne dit qu\'un vol a eu lieu', () => {
	// L'invariant d'étanchéité, au niveau du modèle : la config du banc
	// persiste, ce qui s'y est passé non. Aucune clé de session, de photo, de
	// compteur ou d'horodatage ne doit apparaître ici.
	const txt = serializeBenchConfig(normalizeBenchConfig({ entry: 'ACTIVE' }));
	for (const forbidden of ['session', 'photo', 'randomart', 'flight', 'count', 'seq', 'result', 'landed', 'crashed']) {
		assert.ok(!txt.toLowerCase().includes(forbidden), `« ${forbidden} » n'a rien à faire dans la config du banc`);
	}
	// Et aucun horodatage : `createdAt`, `fetchedAt`, `startedAt`… Cherché sur
	// la casse d'origine, parce qu'en minuscules le motif attraperait « lat ».
	assert.ok(!/[a-z]At"/.test(txt), `un horodatage a fuité dans la config du banc : ${txt}`);
	assert.equal(BENCH_STORAGE_KEY, 'fpvtp.bench', 'préfixe fpvtp. : le reset des réglages doit l\'emporter avec lui');
});

// ---------------------------------------------------------------------------
// La copie

// D3/D6 : DATA et SETTINGS montent à la racine, sous FIELD et BENCH. L'ordre
// est le message — on vole d'abord, on consulte ensuite, on règle en dernier.
t('MODE_SELECT : quatre voies, nommées, en anglais', () => {
	assert.deepEqual(MODES, ['field', 'bench', 'data', 'settings']);
	assert.equal(MODE_SELECT.field.label, 'FIELD');
	assert.equal(MODE_SELECT.bench.label, 'BENCH');
	// Issue #26 : ARCHIVE est devenu DATA, et la copie dit ce qu'on y lit —
	// des relevés de vol, pas une promesse de progression.
	assert.equal(MODE_SELECT.data.label, 'DATA');
	assert.deepEqual(MODE_SELECT.data.lines, ['flight records · telemetry', 'where you have been']);
	assert.equal(MODE_SELECT.archive, undefined, 'l\'ancienne entrée ne survit pas au renommage');
	assert.equal(MODE_SELECT.settings.label, 'SETTINGS');
	// Deux lignes sous chaque voie : ce qu'elle contient, en deux temps.
	for (const m of MODES) assert.equal(MODE_SELECT[m].lines.length, 2, `${m} a deux lignes`);
	for (const m of MODES) {
		assert.ok(MODE_SELECT[m].lines.length >= 1);
		for (const l of MODE_SELECT[m].lines) {
			// D5 : le jeu est en anglais. Un accent ici est un français oublié.
			assert.ok(!/[éèêàçùîôû]/i.test(l), `« ${l} » n'est pas de l'anglais`);
		}
	}
	assert.ok(!/[éèêàçùîôû]/i.test(MODE_SELECT.title));
});

t('BENCH_CREED : les quatre absences, et le sceau', () => {
	assert.deepEqual(BENCH_CREED, ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS']);
	assert.equal(BENCH_SEAL, 'NOTHING HERE IS LOGGED.');
	for (const l of [...BENCH_CREED, BENCH_SEAL]) assert.ok(!/[éèêàçùîôû]/i.test(l));
});

t('les énumérations exposées sont non vides et sans doublon', () => {
	for (const [name, list] of Object.entries({ MODES, ENTRY_MODES, LINK_MODES, BATTERY_MODES })) {
		assert.ok(list.length > 1, `${name} propose un choix`);
		assert.equal(new Set(list).size, list.length, `${name} sans doublon`);
	}
});

// --- HUD : clear / classic (#217) -------------------------------------------

t('hud : CLASSIC par défaut — un drone a un OSD', () => {
	assert.equal(BENCH_DEFAULTS.hud, 'CLASSIC');
	assert.deepEqual(HUD_MODES, ['CLASSIC', 'CLEAR']);
});

t('hud : une valeur inconnue retombe sur le défaut, elle ne casse rien', () => {
	// Même règle que link et battery : normalizeBenchConfig RAMÈNE au lieu de
	// rejeter — une config venue du disque ne doit jamais empêcher de voler.
	assert.equal(normalizeBenchConfig({ hud: 'HOLOGRAM' }).hud, 'CLASSIC');
	assert.equal(normalizeBenchConfig({ hud: null }).hud, 'CLASSIC');
	assert.equal(normalizeBenchConfig({ hud: 'CLEAR' }).hud, 'CLEAR');
});

t('hud : la ligne du banc dit sa valeur', () => {
	const rows = benchRows(normalizeBenchConfig({ hud: 'CLEAR' }));
	const row = rows.find((r) => r.key === 'hud');
	assert.ok(row, 'la ligne existe');
	assert.equal(row.label, 'HUD');
	assert.equal(row.value, 'CLEAR');
});

t('hud : survit à un aller-retour disque', () => {
	const c = normalizeBenchConfig({ hud: 'CLEAR' });
	assert.equal(parseBenchConfig(serializeBenchConfig(c)).hud, 'CLEAR');
});

// --- ce que la ligne de vol annonce (#217, #206) ----------------------------

t('flightLabel : la ligne dit sur quoi on vole, pas ce qu\'on croit', () => {
	// Le banc n'ouvre rien et ne compte rien — « NOTHING HERE IS LOGGED ».
	assert.equal(flightLabel({ bench: true, sessionSeconds: 34 }), 'BENCH');
	// Terrain streamé (#218) : c'est une session comme une autre, mais le
	// terrain n'est pas sur le disque — pas de clôture, le relief arrive en
	// vol. La ligne le signale.
	assert.equal(flightLabel({ live: true, sessionSeconds: 34 }), 'LIVE 00:34');
	// Zone acquise.
	assert.equal(flightLabel({ sessionSeconds: 34 }), 'SESSION 00:34');
});

t('flightLabel : le banc l\'emporte, et l\'absence de durée ne casse rien', () => {
	assert.equal(flightLabel({ bench: true, live: true }), 'BENCH');
	assert.equal(flightLabel({}), 'SESSION 00:00');
	assert.equal(flightLabel({ live: true, sessionSeconds: null }), 'LIVE 00:00');
});

console.log(`\n${n} tests bench OK`);
