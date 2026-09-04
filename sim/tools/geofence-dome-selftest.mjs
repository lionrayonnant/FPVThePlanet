// Selftest de la courbe pure de la muraille numérique de carte pré-cuite
// (#199, suivi de #198).
import assert from 'node:assert/strict';
import { wallOpacity } from '../src/geofence-dome.js';
import { OPACITY_FLOOR, OPACITY_CEIL } from '../src/fence-dome.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const BBOX = { min: [-100, 0, -100], max: [100, 50, 100] };
const HALF_MIN = 100;   // min(200, 200) / 2

t('wallOpacity : plancher au centre de la carte', () => {
	assert.equal(wallOpacity({ x: 0, y: 10, z: 0 }, BBOX, HALF_MIN), OPACITY_FLOOR);
});

t('wallOpacity : plafond pile au bord', () => {
	const v = wallOpacity({ x: 100, y: 10, z: 0 }, BBOX, HALF_MIN);
	assert.ok(Math.abs(v - OPACITY_CEIL) < 1e-9, `${v} != ${OPACITY_CEIL}`);
});

t('wallOpacity : plafond au-delà du bord (rappel physique déjà engagé)', () => {
	const atEdge = wallOpacity({ x: 100, y: 10, z: 0 }, BBOX, HALF_MIN);
	const beyond = wallOpacity({ x: 150, y: 10, z: 0 }, BBOX, HALF_MIN);
	assert.equal(beyond, atEdge, 'ne doit pas continuer à grimper au-delà du bord');
});

t('wallOpacity : croissante en s\'approchant du bord', () => {
	const mid = wallOpacity({ x: 50, y: 10, z: 0 }, BBOX, HALF_MIN);
	const near = wallOpacity({ x: 90, y: 10, z: 90 }, BBOX, HALF_MIN);
	assert.ok(near > mid, `plus près du bord (${near}) devrait être plus opaque que le milieu (${mid})`);
});

t('wallOpacity : carte dégénérée (halfMin=0, mode bench) ne lève pas et sature au plafond', () => {
	const v = wallOpacity({ x: 0, y: 10, z: 0 }, BBOX, 0);
	assert.ok(Math.abs(v - OPACITY_CEIL) < 1e-9, `${v} != ${OPACITY_CEIL}`);
});

console.log(`geofence-dome-selftest : ${n} tests ok`);
