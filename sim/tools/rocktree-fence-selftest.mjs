// Selftest du rappel circulaire de la fenêtre de streaming rocktree (#168).
import assert from 'node:assert/strict';
import { push } from '../src/rocktree-fence.js';
import { A_MAX } from '../src/geofence.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('dans le rayon de confiance : poussée nulle', () => {
	assert.equal(push(50, 100), 0);
	assert.equal(push(100, 100), 0);   // pile au bord : encore nulle
});

t('au-delà du rayon de confiance + RAMP_M : poussée pleine', () => {
	assert.equal(push(200, 100), A_MAX);
});

t('entre les deux : rampe linéaire continue, pas de saut', () => {
	const justInside = push(100 + 1e-6, 100);
	const justOutside = push(100 - 1e-6, 100);
	assert.ok(justInside > 0 && justInside < 0.01);
	assert.equal(justOutside, 0);
});

console.log(`rocktree-fence-selftest : ${n} tests ok`);
