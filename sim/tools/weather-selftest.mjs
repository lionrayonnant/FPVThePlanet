// Selftest du monde persistant / météo (PHASE 04). Aucun réseau, aucun disque :
// l'API Open-Meteo est stubbée, comme le fetch de src/operator.selftest.mjs.
// Lancer : node tools/weather-selftest.mjs
import assert from 'node:assert/strict';
import * as W from './lib/weather.mjs';
import { resolveWeather, RETRY_FALLBACK_MS, MAX_ZONES } from './weather-source.mjs';
import { MAX_RATE } from '../src/rain.js';
import { rangeFor } from '../src/fog.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const TOKYO = { lat: 35.6762, lon: 139.6503 };
const PARIS = { lat: 48.8582, lon: 2.297 };

// ---------------------------------------------------------------------------
// Clés

t('zoneKey quantifie à ~1 km et normalise la longitude', () => {
	assert.equal(W.zoneKey(35.6762, 139.6503), '35.68,139.65');
	// Deux points du même quartier : même zone.
	assert.equal(W.zoneKey(35.6762, 139.6503), W.zoneKey(35.6801, 139.6549));
	// Deux villes : jamais la même.
	assert.notEqual(W.zoneKey(TOKYO.lat, TOKYO.lon), W.zoneKey(PARIS.lat, PARIS.lon));
	// -0,00 et 0,00 sont la même zone, et 180 = -180.
	assert.equal(W.zoneKey(0, -0.001), W.zoneKey(0, 0.001));
	assert.equal(W.zoneKey(0, 180), W.zoneKey(0, -180));
	assert.throws(() => W.zoneKey(NaN, 0), /zone invalide/);
});

t('dayKey / dayAfter / dayIndex', () => {
	assert.equal(W.dayKey(new Date(2026, 7, 29, 23, 59)), '2026-08-29');
	assert.equal(W.dayAfter('2026-08-29', 0), '2026-08-29');
	assert.equal(W.dayAfter('2026-08-29', 3), '2026-09-01');
	assert.equal(W.dayAfter('2026-12-31', 1), '2027-01-01');
	// Année bissextile, pour que le décalage ne soit pas « +86400000 » naïf.
	assert.equal(W.dayAfter('2028-02-28', 1), '2028-02-29');
	assert.equal(W.dayIndex('2026-08-30') - W.dayIndex('2026-08-29'), 1);
});

// ---------------------------------------------------------------------------
// Cohérence temporelle — le cœur du critère d'acceptation

t('deux tirages du même jour sur la même zone sont identiques', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	const b = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	assert.deepEqual(a, b);
});

t('le « +1 » d\'aujourd\'hui est le « TODAY » de demain', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	const b = W.proceduralForecast({ ...TOKYO, day: '2026-08-30' });
	assert.deepEqual(a[1], b[0]);
	assert.deepEqual(a[6], b[5]);
});

t('le lendemain peut différer', () => {
	// Sur une zone, au moins un jour de la semaine change de régime : la météo
	// est cohérente, pas figée.
	const days = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	assert.ok(new Set(days.map((d) => d.regime)).size > 1);
});

t('deux zones n\'ont pas la même séquence', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' }).map((d) => d.regime);
	const b = W.proceduralForecast({ ...PARIS, day: '2026-08-29' }).map((d) => d.regime);
	assert.notDeepEqual(a, b);
});

t('la séquence n\'est pas un cycle fixe', () => {
	// Sur cinquante zones, on ne doit jamais retrouver deux fois la même suite
	// de sept régimes : l'ordre des conditions n'est pas prédéterminé.
	const seen = new Set();
	for (let i = 0; i < 50; i++) {
		const s = W.proceduralForecast({ lat: 10 + i * 1.1, lon: -30 + i * 2.3, day: '2026-08-29' })
			.map((d) => d.regime).join('|');
		seen.add(s);
	}
	assert.ok(seen.size >= 45, `${seen.size} séquences distinctes sur 50`);
});

// ---------------------------------------------------------------------------
// Distribution — mesurée, pas devinée

t('les régimes extrêmes restent rares et le vent suit une loi plausible', () => {
	const counts = {};
	const speeds = [];
	let total = 0;
	for (let i = 0; i < 120; i++) {
		const lat = -60 + (i * 7919 % 1200) / 10;
		const lon = -180 + (i * 104729 % 3600) / 10;
		for (let d = 0; d < 120; d++) {
			const e = W.proceduralDay(lat, lon, W.dayAfter('2026-01-01', d));
			counts[e.regime] = (counts[e.regime] ?? 0) + 1;
			speeds.push(e.windSpeed);
			total++;
		}
	}
	const pct = (k) => 100 * (counts[k] ?? 0) / total;
	speeds.sort((a, b) => a - b);
	const q = (p) => speeds[Math.floor(p * speeds.length)];

	// Un coup de vent est un événement, pas un mardi sur deux.
	assert.ok(pct('GALE') + pct('STORM') < 3, `coups de vent ${(pct('GALE') + pct('STORM')).toFixed(1)} %`);
	// Il ne fait pas beau tous les jours non plus.
	assert.ok(pct('CLEAR') > 8 && pct('CLEAR') < 35, `CLEAR ${pct('CLEAR').toFixed(1)} %`);
	// Il pleut, sous une forme ou une autre, entre un jour sur cinq et un sur deux.
	const rainy = pct('LIGHT RAIN') + pct('RAIN') + pct('HEAVY RAIN') + pct('STORM');
	assert.ok(rainy > 18 && rainy < 50, `pluie ${rainy.toFixed(1)} %`);
	// Le brouillard est rare partout.
	assert.ok(pct('FOG') < 8, `FOG ${pct('FOG').toFixed(1)} %`);
	// Vent quotidien maximal : médiane autour de 5-6 m/s, 99e centile sous 20.
	assert.ok(q(0.5) > 3 && q(0.5) < 8, `médiane ${q(0.5).toFixed(1)} m/s`);
	assert.ok(q(0.99) < 20, `p99 ${q(0.99).toFixed(1)} m/s`);
	assert.ok(q(0.1) < 4, `p10 ${q(0.1).toFixed(1)} m/s`);
});

// ---------------------------------------------------------------------------
// Garde-fous

t('sanitize : la rafale encadre le vent moyen', () => {
	assert.equal(W.sanitize({ windSpeed: 10, windGust: 4 }).windGust, 10);
	assert.equal(W.sanitize({ windSpeed: 10, windGust: 99 }).windGust, 30);
});

t('sanitize : le vent chasse le brouillard, la pluie non', () => {
	// Purée de pois + tempête : impossible, le brassage mécanique la dissipe.
	const blown = W.sanitize({ windSpeed: 18, windGust: 24, visibilityM: 80 });
	assert.ok(blown.visibilityM >= 1500);
	assert.notEqual(blown.regime, 'FOG');
	// Sous la pluie, la mauvaise visibilité est de l'eau et pas une inversion :
	// elle reste.
	const wet = W.sanitize({ windSpeed: 18, windGust: 24, rateMmH: 12, visibilityM: 600 });
	assert.ok(wet.visibilityM < 1500);
});

t('sanitize : il ne pleut pas sous un ciel bleu', () => {
	const d = W.sanitize({ rateMmH: 3, cloudPct: 0 });
	assert.ok(d.cloudPct >= 70);
	assert.equal(d.regime, 'RAIN');
});

t('sanitize : la visibilité ne contredit jamais le débit de pluie', () => {
	// rain.js donne ~1,7 km à 25 mm/h ; annoncer 30 km serait un mensonge que le
	// moteur démentirait à la première image.
	const d = W.sanitize({ rateMmH: 25, visibilityM: 30000 });
	assert.ok(d.visibilityM < 2500, `${d.visibilityM} m`);
});

t('sanitize : bornes et valeurs absurdes', () => {
	const d = W.sanitize({ windSpeed: 1e6, windGust: NaN, windDir: -30, rateMmH: -5, visibilityM: 0, cloudPct: 500 });
	assert.ok(d.windSpeed <= 40);
	assert.equal(d.windDir, 330);
	assert.equal(d.rateMmH, 0);
	assert.ok(d.visibilityM >= 30);
	assert.equal(d.cloudPct, 100);
	assert.ok(W.REGIMES.includes(d.regime));
});

t('tout jour généré passe ses propres garde-fous', () => {
	for (let i = 0; i < 60; i++) {
		const day = W.proceduralDay(-50 + i * 1.7, -170 + i * 5.3, W.dayAfter('2026-03-01', i));
		assert.deepEqual(W.sanitize(day), day, `jour ${i} instable par sanitize`);
		assert.ok(W.REGIMES.includes(day.regime));
	}
});

// ---------------------------------------------------------------------------
// Traduction vers wind.js / rain.js / fog.js

t('toSimParams reste dans les domaines des trois modèles', () => {
	for (let i = 0; i < 200; i++) {
		const d = W.proceduralDay(-60 + i * 0.6, -180 + i * 1.8, W.dayAfter('2026-05-01', i % 30));
		const p = W.toSimParams(d);
		assert.ok(p.wind.speed >= 0 && p.wind.speed <= 25);
		assert.ok(p.wind.direction >= 0 && p.wind.direction < 360);
		assert.ok(p.wind.gust >= 0 && p.wind.gust <= 1);
		assert.ok(p.wind.turbulence >= 0 && p.wind.turbulence <= 2);
		for (const k of ['rain', 'fog']) {
			assert.ok(p[k].intensity >= 0 && p[k].intensity <= 1, `${k}.intensity`);
			assert.ok(p[k].variability >= 0 && p[k].variability <= 1, `${k}.variability`);
		}
	}
});

t('un jour clair et calme donne un monde neutre', () => {
	const p = W.toSimParams({ windSpeed: 0, windGust: 0, windDir: 0, rateMmH: 0, visibilityM: 30000, cloudPct: 5 });
	assert.equal(p.wind.speed, 0);
	assert.equal(p.rain.intensity, 0);
	assert.equal(p.fog.intensity, 0);
});

t('la pluie n\'est pas comptée deux fois dans la visibilité', () => {
	// Une averse dans de l'air clair ne doit pas produire de brouillard : rain.js
	// ajoute déjà sa propre extinction par-dessus celle de fog.js.
	const d = W.sanitize({ windSpeed: 3, rateMmH: 10, visibilityM: 30000, cloudPct: 90 });
	const p = W.toSimParams(d);
	assert.ok(p.fog.intensity < 0.05, `fog ${p.fog.intensity}`);
	assert.ok(Math.abs(p.rain.intensity - 10 / MAX_RATE) < 1e-9);
});

t('une vraie nappe de brouillard arrive bien jusqu\'à fog.js', () => {
	const d = W.sanitize({ windSpeed: 1, rateMmH: 0, visibilityM: 200, cloudPct: 90 });
	assert.equal(d.regime, 'FOG');
	const p = W.toSimParams(d);
	// fog.js raisonne en portée : on retrouve les 200 m demandés.
	assert.ok(Math.abs(rangeFor(p.fog.intensity) - 200) < 5, `${rangeFor(p.fog.intensity)} m`);
});

// ---------------------------------------------------------------------------
// Open-Meteo

t('openMeteoUrl ne porte aucune clé', () => {
	const u = new URL(W.openMeteoUrl(35.6762, 139.6503));
	assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
	assert.equal(u.searchParams.get('latitude'), '35.6762');
	assert.equal(u.searchParams.get('wind_speed_unit'), 'ms');
	assert.equal(u.searchParams.get('forecast_days'), '7');
	for (const k of [...u.searchParams.keys()]) {
		assert.ok(!/key|token|apikey|secret/i.test(k), `paramètre suspect : ${k}`);
	}
});

const OM = {
	daily: {
		time: ['2026-08-29', '2026-08-30'],
		weather_code: [61, 0],
		precipitation_sum: [6, 0],
		precipitation_hours: [3, 0],
		wind_speed_10m_max: [4.2, 1.1],
		wind_gusts_10m_max: [8.0, 2.4],
		wind_direction_10m_dominant: [210, 40],
	},
	hourly: {
		time: ['2026-08-29T00:00', '2026-08-29T01:00', '2026-08-30T00:00'],
		visibility: [8000, 6000, 24000],
		cloud_cover: [90, 100, 10],
	},
};

t('fromOpenMeteo lit le débit horaire, pas le cumul', () => {
	const days = W.fromOpenMeteo(OM);
	assert.equal(days.length, 2);
	assert.equal(days[0].date, '2026-08-29');
	assert.equal(days[0].precipMm, 6);
	assert.equal(days[0].rateMmH, 2);          // 6 mm en 3 h
	assert.equal(days[0].regime, 'RAIN');
	assert.equal(days[0].windDir, 210);
	assert.equal(days[0].cloudPct, 95);        // moyenne des heures du jour
	assert.equal(days[1].regime, 'CLEAR');
	assert.equal(days[1].rateMmH, 0);
});

t('fromOpenMeteo se rabat sur le code WMO quand la série horaire manque', () => {
	const noHourly = { daily: { ...OM.daily, weather_code: [45, 0] } };
	const days = W.fromOpenMeteo(noHourly);
	assert.ok(days[0].visibilityM < 5000);     // code 45 = brouillard
	assert.ok(days[1].cloudPct < 40);          // code 0 = ciel clair
});

t('fromOpenMeteo refuse une réponse inexploitable', () => {
	assert.throws(() => W.fromOpenMeteo({}), /inexploitable/);
	assert.throws(() => W.fromOpenMeteo({ daily: { time: [] } }), /inexploitable/);
});

// ---------------------------------------------------------------------------
// Confiance

t('la confiance décroît avec l\'échéance et avec la qualité de la source', () => {
	assert.ok(W.confidence('open-meteo', 0) > W.confidence('open-meteo', 6));
	assert.ok(W.confidence('open-meteo', 0) > W.confidence('procedural', 0));
	assert.ok(W.confidence('stale', 0) > W.confidence('procedural', 0));
	// Une barre pleine voudrait dire « certain » : aucune prévision ne l'est.
	assert.notEqual(W.confidenceBar(W.confidence('open-meteo', 0)), '█'.repeat(12));
	assert.equal(W.confidenceBar(0).length, 12);
});

// ---------------------------------------------------------------------------
// Rendu

t('formatForecast montre les six champs demandés', () => {
	const snap = W.makeSnapshot({ ...TOKYO, day: '2026-08-29', source: 'procedural',
		days: W.proceduralForecast({ ...TOKYO, day: '2026-08-29' }) });
	const txt = W.formatForecast(snap, { title: 'Tokyo' });
	assert.match(txt, /^TOKYO/);
	assert.match(txt, /\nTODAY /);
	for (let i = 1; i < 7; i++) assert.match(txt, new RegExp(`\\n\\+${i} `));
	for (const field of ['WIND', 'VIS', 'RAIN', 'FOG', 'CONFIDENCE']) {
		assert.match(txt, new RegExp(`\\n${field} `), `champ ${field} absent`);
	}
	// Le régime du jour est bien la première ligne de la prévision.
	assert.ok(txt.includes(W.headline(snap.days[0])));
});

// ---------------------------------------------------------------------------
// Bloc CONDITIONS du TARGET SCAN (issue #76)

const snapWith = (day) => W.makeSnapshot({
	...TOKYO, day: '2026-08-29', source: 'procedural',
	days: [W.sanitize({ ...W.proceduralForecast({ ...TOKYO, day: '2026-08-29' })[0], ...day })],
});

t('conditionsBlock : trois champs, pas d\'alerte par temps calme', () => {
	const b = W.conditionsBlock(snapWith({
		windSpeed: 2, windGust: 3, windDir: 315, rateMmH: 0, visibilityM: 40000,
	}));
	const txt = b.join('\n');
	assert.equal(b[0], 'CONDITIONS');
	assert.match(txt, /\nWIND +2\.0 m\/s +NW +LOW WIND/);
	assert.match(txt, /\nRAIN +NONE/);
	assert.match(txt, /\nVISIBILITY +40 km/);
	assert.ok(!txt.includes('MARGINAL'), 'pas d\'alerte par temps calme');
});

t('conditionsBlock : alerte quand le régime est marginal', () => {
	const b = W.conditionsBlock(snapWith({
		windSpeed: 12, windGust: 18, windDir: 90, rateMmH: 0, visibilityM: 20000,
	}));
	const txt = b.join('\n');
	assert.ok(txt.includes('>>> MARGINAL CONDITIONS'));
	assert.match(txt, /STRONG WIND/);
});

t('conditionsBlock / conditionsLine : null sans snapshot', () => {
	assert.equal(W.conditionsBlock(null), null);
	assert.equal(W.conditionsLine(undefined), null);
});

t('conditionsLine : résumé d\'une ligne, préfixe si marginal', () => {
	const calm = W.conditionsLine(snapWith({
		windSpeed: 2, windGust: 3, rateMmH: 0, visibilityM: 40000,
	}));
	assert.equal(calm, 'LOW WIND · VIS 40 km');
	const bad = W.conditionsLine(snapWith({
		windSpeed: 12, windGust: 18, rateMmH: 3, visibilityM: 6000,
	}));
	assert.match(bad, /^>>> /);
	assert.ok(bad.includes('RAIN'));
});

// ---------------------------------------------------------------------------
// Résolution serveur : cache, repli, éviction

const okFetch = (calls) => async () => {
	calls.n++;
	return { ok: true, json: async () => OM };
};
const deadFetch = (calls) => async () => { calls.n++; throw new Error('offline'); };

await ta('une acquisition écrit le snapshot, la suivante le relit', async () => {
	const world = {};
	const calls = { n: 0 };
	const a = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch(calls) });
	assert.equal(a.changed, true);
	assert.equal(a.snapshot.source, 'open-meteo');
	assert.equal(calls.n, 1);

	// Immédiatement après : aucun appel réseau, aucun nouveau tirage.
	const b = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch(calls) });
	assert.equal(calls.n, 1, 'le réseau a été rappelé');
	assert.equal(b.changed, false);
	assert.deepEqual(b.snapshot, a.snapshot);
	assert.deepEqual(Object.keys(world.weather), [W.zoneKey(TOKYO.lat, TOKYO.lon)]);
});

await ta('hors ligne sans rien en cache : procédural déterministe', async () => {
	const calls = { n: 0 };
	const w1 = {}, w2 = {};
	const a = await resolveWeather(w1, { ...PARIS, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	const b = await resolveWeather(w2, { ...PARIS, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	assert.equal(a.snapshot.source, 'procedural');
	assert.deepEqual(a.snapshot.days, b.snapshot.days);
});

await ta('hors ligne avec un snapshot de la veille : dernier connu, re-daté', async () => {
	const world = {};
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch({ n: 0 }) });
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-30', fetchImpl: deadFetch({ n: 0 }) });
	assert.equal(r.snapshot.source, 'stale');
	assert.equal(r.snapshot.day, '2026-08-30');
	// La fenêtre a glissé d'un jour, elle n'a pas été rejouée.
	assert.equal(r.snapshot.days[0].date, '2026-08-30');
	assert.ok(r.snapshot.days[0].confidence < W.confidence('open-meteo', 0));
});

await ta('un repli laisse retenter le réseau, un relevé non', async () => {
	const world = {};
	const calls = { n: 0 };
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	const before = calls.n;
	// Tout de suite après : on ne martèle pas l'API.
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	assert.equal(calls.n, before);
	// Un quart d'heure plus tard : nouvelle tentative, et cette fois ça répond.
	const later = Date.now() + RETRY_FALLBACK_MS + 1000;
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', now: later, fetchImpl: okFetch(calls) });
	assert.equal(calls.n, before + 1);
	assert.equal(r.snapshot.source, 'open-meteo');
});

await ta('le world state ne collectionne pas les zones', async () => {
	const world = {};
	for (let i = 0; i < MAX_ZONES + 12; i++) {
		await resolveWeather(world, { lat: 10 + i * 0.5, lon: 20 + i * 0.5, day: '2026-08-29', fetchImpl: deadFetch({ n: 0 }) });
	}
	assert.equal(Object.keys(world.weather).length, MAX_ZONES);
});

await ta('la date qui fait foi est celle de l\'API, pas celle du serveur', async () => {
	// Le joueur peut être à cheval sur un fuseau : Open-Meteo date ses jours dans
	// celui de la zone (timezone=auto), et c'est cette date qu'on garde.
	const world = {};
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-28', fetchImpl: okFetch({ n: 0 }) });
	assert.equal(r.snapshot.day, '2026-08-29');
});

// ---------------------------------------------------------- sévérité (PHASE 19)

t('severity : chaque régime en a une, et une seule des quatre', () => {
	const levels = new Set(['nominal', 'watch', 'marginal', 'nogo']);
	for (const regime of W.REGIMES) {
		const s = W.severity({ regime, windSpeed: 0 });
		assert.ok(levels.has(s), `${regime} : sévérité inconnue « ${s} »`);
	}
});

t('severity : ce que la Bible §14 appelle marginal ne passe jamais pour nominal', () => {
	// Le même jeu de régimes que celui qui déclenche « >>> MARGINAL CONDITIONS »
	// dans formatForecast : les deux ne doivent pas pouvoir diverger.
	for (const regime of ['WINDY', 'GALE', 'STORM', 'HEAVY RAIN', 'RAIN', 'FOG']) {
		const s = W.severity({ regime, windSpeed: 0 });
		assert.ok(s === 'marginal' || s === 'nogo',
			`${regime} est marginal pour formatForecast mais « ${s} » pour severity`);
	}
	const gale = { day: '2026-08-29', source: 'test', days: [W.sanitize({ windSpeed: 20 })] };
	assert.equal(gale.days[0].regime, 'GALE');
	assert.ok(W.conditionsLine(gale).startsWith('>>> '));
	assert.equal(W.severity(gale.days[0]), 'nogo');
});

t('severity : on ne sort pas par coup de vent ni par tempête', () => {
	assert.equal(W.severity({ regime: 'GALE', windSpeed: 20 }), 'nogo');
	assert.equal(W.severity({ regime: 'STORM', windSpeed: 20 }), 'nogo');
});

t('severity : un ciel calme sur un vent déjà soutenu reste une information', () => {
	// classify ne bascule sur WINDY qu'à 9 m/s ; ça se sent dès 6.
	assert.equal(W.severity({ regime: 'CLEAR', windSpeed: 2 }), 'nominal');
	assert.equal(W.severity({ regime: 'CLEAR', windSpeed: 7 }), 'watch');
	assert.equal(W.severity({ regime: 'OVERCAST', windSpeed: 8 }), 'watch');
});

t('severity : pas de snapshot, pas de couleur', () => {
	assert.equal(W.severity(null), 'nominal');
	assert.equal(W.severity(undefined), 'nominal');
});

console.log(`\n${n} tests météo OK`);
