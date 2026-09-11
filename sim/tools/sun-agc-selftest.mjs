// Pure AGC check on SunField, extracted from tools/selftest.mjs §soleil so it
// runs without an installed scene (CI has none) — D10, #11: the sun nerf must
// not silently regress in either direction.
// Run: node tools/sun-agc-selftest.mjs
import assert from 'node:assert/strict';
import { SunField, REF_VIS, E_MIN, SUN_METER_WEIGHT, ambientLevel } from '../src/sun.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const PARIS = { lat: 48.8566, lon: 2.3522 };
// Un midi d'équinoxe à Paris : soleil haut, ciel clair.
const NOON = new Date('2026-06-21T11:52:00Z');

const settle = (field, date, sunInFrame, seconds = 20) => {
	for (let t = 0; t < seconds; t += 1 / 60) field.update(1 / 60, { date, sunInFrame });
	return field;
};

// La fourchette 55-75 % qu'affirmait ce test datait de #11 et a été retirée avec
// #94 : elle décrivait une caméra qui fermait pour compenser un voile que lens.js
// peint APRÈS le gain, donc qu'elle ne pouvait pas retirer. Le voile coupé, il
// n'y a plus rien à compenser, et la fermeture n'est plus qu'une réaction du
// posemètre au disque.
//
// Elle n'est pas remplacée par une autre fourchette : la valeur est DÉRIVÉE du
// poids que le disque pèse dans la mesure, donc régler SUN_METER_WEIGHT et
// oublier le test est impossible.
t('face au soleil : l\'exposition ferme d\'exactement ce que le disque pèse au posemètre', () => {
	const sun = new SunField(PARIS);
	sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
	settle(sun, NOON, 0);
	const before = sun.exposure;

	settle(sun, NOON, 1, 5);
	const closed = sun.exposure;

	// target = ambient * 1/(ambient + w*inFrame*amount), et l'exposition est
	// rapportée à l'ambiance, donc le rapport ne dépend que du poids.
	const want = 1 / (1 + SUN_METER_WEIGHT * sun.sunAmount / ambientLevel(sun.elevation, 0));
	assert.ok(Math.abs(closed / before - want) < 0.01,
		`${(closed / before).toFixed(3)} vs ${want.toFixed(3)} attendu du poids ${SUN_METER_WEIGHT}`);
	assert.ok(closed < before, `l'AGC doit encore réagir : ${closed.toFixed(3)} vs ${before.toFixed(3)}`);
});

t('face au soleil : l\'image reste largement lisible', () => {
	const sun = new SunField(PARIS);
	sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
	settle(sun, NOON, 0);
	const before = sun.exposure;
	settle(sun, NOON, 1, 5);

	// Le point de #94 : disque plein cadre, la photo ne perd plus qu'un dixième.
	assert.ok(sun.exposure > before * 0.85,
		`${(sun.exposure / before).toFixed(3)} du repos, attendu > 0.85`);
});

t('le plancher d\'exposition ne sert plus au soleil, et garde son autre métier', () => {
	// E_MIN normalise un ciel très lumineux ; s'il bornait aussi le soleil, le
	// régler pour l'un déréglerait l'autre. Au zénith, sans soleil au cadre,
	// 1/ambiance ne descend pas sous ~0,917 — donc E_MIN ne mord nulle part en
	// plein jour, ce qui est exactement ce qu'on veut de lui.
	const brightest = 1 / ambientLevel(90, 0);
	assert.ok(brightest > E_MIN,
		`1/ambiance au zénith ${brightest.toFixed(3)} doit rester au-dessus de E_MIN ${E_MIN}`);
	// Et le soleil non plus ne peut plus l'atteindre.
	const withSun = 1 / (ambientLevel(60, 0) + SUN_METER_WEIGHT);
	assert.ok(withSun > E_MIN,
		`disque plein cadre ${withSun.toFixed(3)} doit rester au-dessus de E_MIN ${E_MIN}`);
});

console.log(`PASS  sun-agc-selftest (${n} tests)`);
