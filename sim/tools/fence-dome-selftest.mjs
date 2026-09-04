// Selftest des courbes pures du dôme numérique de fenêtre live (#198).
import assert from 'node:assert/strict';
import { opacityFor, glitchFor, fogDensityFor, OPACITY_FLOOR, OPACITY_CEIL, GLITCH_DECAY_S } from '../src/fence-dome.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('opacityFor : plancher au centre (ratio 0)', () => {
	assert.equal(opacityFor(0), OPACITY_FLOOR);
});

t('opacityFor : plafond au bord réel (ratio 1)', () => {
	// Tolérance flottante : OPACITY_FLOOR + (OPACITY_CEIL - OPACITY_FLOOR) * 1
	// n'est pas bit-exact à OPACITY_CEIL (arithmétique binaire).
	assert.ok(Math.abs(opacityFor(1) - OPACITY_CEIL) < 1e-9, `${opacityFor(1)} != ${OPACITY_CEIL}`);
});

t('opacityFor : croissante et continue entre les deux', () => {
	const a = opacityFor(0.25), b = opacityFor(0.5), c = opacityFor(0.75);
	assert.ok(a < b && b < c, `pas croissante : ${a}, ${b}, ${c}`);
});

t('opacityFor : clampée hors [0,1] (dépassement de fenêtre en plein churn)', () => {
	assert.equal(opacityFor(-0.3), opacityFor(0));
	assert.equal(opacityFor(1.8), opacityFor(1));
});

t('glitchFor : plein juste après un churn (t=0)', () => {
	assert.equal(glitchFor(0), 1);
});

t('glitchFor : éteint une fois la décroissance passée', () => {
	assert.equal(glitchFor(GLITCH_DECAY_S), 0);
	assert.equal(glitchFor(5), 0);
});

t('glitchFor : décroissance linéaire continue entre les deux', () => {
	const mid = glitchFor(0.6);
	assert.ok(mid > 0.49 && mid < 0.51, `attendu ~0.5, obtenu ${mid}`);
});

t('fogDensityFor : nul au centre (pas de brume par défaut)', () => {
	assert.equal(fogDensityFor(0), 0);
});

t('fogDensityFor : reste bas jusqu\'à mi-fenêtre, monte fort près du bord', () => {
	const mid = fogDensityFor(0.5), nearEdge = fogDensityFor(0.9), edge = fogDensityFor(1);
	assert.ok(mid < nearEdge && nearEdge < edge, `pas croissante : ${mid}, ${nearEdge}, ${edge}`);
	// ratio^4 : à 0.5 on n'a que 6,25 % du plafond, la brume doit rester
	// quasi imperceptible sur la moitié interne de la fenêtre.
	assert.ok(mid < edge * 0.1, `mid=${mid} devrait rester sous 10% du plafond (${edge})`);
});

t('fogDensityFor : clampée hors [0,1]', () => {
	assert.equal(fogDensityFor(-0.5), fogDensityFor(0));
	assert.equal(fogDensityFor(2), fogDensityFor(1));
});

console.log(`fence-dome-selftest : ${n} tests ok`);
