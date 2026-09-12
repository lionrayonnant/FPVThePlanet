// Selftest de la courbe pure de la muraille numérique de carte pré-cuite
// (#199, suivi de #198).
import assert from 'node:assert/strict';
import { wallOpacity, wallFaceLayout } from '../src/geofence-dome.js';
import { OPACITY_FLOOR, OPACITY_CEIL } from '../src/fence-dome.js';
import { nearestOnBoxSurface } from '../src/fence-field.js';

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

// --- Géométrie du mur (#107) ----------------------------------------------
//
// wallFaceLayout() décrit la géométrie, nearestOnBoxSurface() décrit où est le
// drone : si les deux ne parlent pas du même périmètre, l'anneau de ping part
// à côté du drone ou se casse en deux à un coin. C'est la seule chose que ces
// tests vérifient, et c'est la seule qui compte.

t('wallFaceLayout : les faces se suivent sans trou ni recouvrement', () => {
	const faces = wallFaceLayout(200, 200);
	for (let i = 0; i < faces.length; i++) {
		const next = faces[(i + 1) % faces.length];
		const end = faces[i].uStart + faces[i].uLength;
		const expected = i === faces.length - 1 ? 800 : next.uStart;
		assert.equal(end, expected, `face ${i} finit à ${end}, la suivante commence à ${expected}`);
	}
});

t('wallFaceLayout : la fin géométrique d\'une face est le début de la suivante', () => {
	const faces = wallFaceLayout(200, 120);
	for (let i = 0; i < faces.length; i++) {
		const next = faces[(i + 1) % faces.length];
		const endX = faces[i].start[0] + faces[i].along[0];
		const endZ = faces[i].start[1] + faces[i].along[1];
		assert.ok(Math.abs(endX - next.start[0]) < 1e-9 && Math.abs(endZ - next.start[1]) < 1e-9,
			`coin disjoint entre la face ${i} et la suivante`);
	}
});

t('wallFaceLayout : le milieu de chaque face tombe au u que trouve nearestOnBoxSurface', () => {
	// La bbox est centrée sur l'origine, donc les coordonnées locales de
	// wallFaceLayout sont aussi les coordonnées monde.
	for (const face of wallFaceLayout(200, 200)) {
		const midX = face.start[0] + face.along[0] / 2;
		const midZ = face.start[1] + face.along[1] / 2;
		// Ramené d'un mètre vers l'intérieur pour lever l'ambiguïté d'un point
		// pile sur la face.
		const inward = { x: midX * 0.99, y: 0, z: midZ * 0.99 };
		const found = nearestOnBoxSurface(inward, BBOX).u;
		const expected = face.uStart + face.uLength / 2;
		assert.ok(Math.abs(found - expected) < 1e-6, `u=${found}, attendu ${expected}`);
	}
});

t('wallFaceLayout : bbox non carrée — le périmètre reste 2*(w+d)', () => {
	const faces = wallFaceLayout(300, 100);
	const last = faces[faces.length - 1];
	assert.equal(last.uStart + last.uLength, 800);
});

console.log(`geofence-dome-selftest : ${n} tests ok`);
