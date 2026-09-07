// Pure AGC check on SunField, extracted from tools/selftest.mjs §soleil so it
// runs without an installed scene (CI has none) — D10, #11: the sun nerf must
// not silently regress in either direction.
// Run: node tools/sun-agc-selftest.mjs
import assert from 'node:assert/strict';
import { SunField, REF_VIS } from '../src/sun.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const PARIS = { lat: 48.8566, lon: 2.3522 };
// Un midi d'équinoxe à Paris : soleil haut, ciel clair.
const NOON = new Date('2026-06-21T11:52:00Z');

const settle = (field, date, sunInFrame, seconds = 20) => {
	for (let t = 0; t < seconds; t += 1 / 60) field.update(1 / 60, { date, sunInFrame });
	return field;
};

t('face au soleil : l\'exposition ferme mais reste jouable (entre 55 et 75 % du repos)', () => {
	const sun = new SunField(PARIS);
	sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
	settle(sun, NOON, 0);
	const before = sun.exposure;

	settle(sun, NOON, 1, 5);
	const closed = sun.exposure;

	assert.ok(closed < before * 0.75, `${closed.toFixed(3)} vs ${(before * 0.75).toFixed(3)} (0.75×before)`);
	assert.ok(closed > before * 0.55, `${closed.toFixed(3)} vs ${(before * 0.55).toFixed(3)} (0.55×before)`);
});

console.log(`PASS  sun-agc-selftest (${n} tests)`);
