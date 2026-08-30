// node tools/space-selftest.mjs
//
// Couvre le modèle PUR de l'acoustique du lieu. Ce qui s'écoute — est-ce que
// raser un mur « fait » quelque chose — se vérifie à l'oreille, pas ici.

import { strict as assert } from 'node:assert';
import {
	acoustics, reverbParams, REVERB, SPEED_OF_SOUND,
	PROBE_H_COUNT, PROBE_UP, PROBE_DOWN, PROBE_H_RANGE,
} from './space-model.mjs';

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Fabrique une rosace : `h` pour les huit horizontaux, `up`, `down`.
const rosette = (h, up = PROBE_H_RANGE, down = 100) => {
	const a = new Float32Array(PROBE_DOWN + 1);
	for (let i = 0; i < PROBE_H_COUNT; i++) a[i] = Array.isArray(h) ? h[i] : h;
	a[PROBE_UP] = up;
	a[PROBE_DOWN] = down;
	return a;
};

const OPEN = rosette(PROBE_H_RANGE, PROBE_H_RANGE, 100);
const ALLEY = rosette([2, 30, 30, 30, 2, 30, 30, 30], 30, 3);
const BOX = rosette(3, 3, 3);

test('le plein ciel n\'est pas un lieu', () => {
	const a = acoustics(OPEN);
	assert.ok(a.enclosure < 0.05, `fermeture ${a.enclosure} en plein ciel`);
	assert.equal(a.nearestM, REVERB.openM);
});

test('une ruelle est plus fermée qu\'un ciel, moins qu\'une boîte', () => {
	const open = acoustics(OPEN).enclosure;
	const alley = acoustics(ALLEY).enclosure;
	const box = acoustics(BOX).enclosure;
	assert.ok(open < alley && alley < box, `${open} < ${alley} < ${box}`);
});

test('le mur le plus proche gagne, quelle que soit sa direction', () => {
	assert.equal(acoustics(rosette([1.5, 30, 30, 30, 30, 30, 30, 30])).nearestM, 1.5);
	assert.equal(acoustics(rosette(30, 1.5)).nearestM, 1.5, 'plafond ignoré');
	assert.equal(acoustics(rosette(30, 30, 1.5)).nearestM, 1.5, 'sol ignoré');
});

test('le rayon du bas ne fait pas d\'un vol haut un endroit fermé', () => {
	// Il porte à 400 m et sert d'altimètre au vent : le compter comme une paroi
	// ferait d'un vol à 200 m au-dessus d'un champ un lieu « fermé vers le bas ».
	const high = acoustics(rosette(PROBE_H_RANGE, PROBE_H_RANGE, 300));
	assert.equal(high.nearestM, REVERB.openM);
	assert.ok(high.enclosure < 0.05);
});

test('une rosace absente ou tronquée rend le plein ciel, pas une exception', () => {
	for (const bad of [null, undefined, new Float32Array(3), []]) {
		const a = acoustics(bad);
		assert.equal(a.enclosure, 0);
		assert.ok(Number.isFinite(a.nearestM));
	}
});

test('acoustics ne rend jamais NaN', () => {
	const nasty = rosette([NaN, Infinity, -5, 0, NaN, 1e9, -Infinity, 12], NaN, NaN);
	const a = acoustics(nasty);
	for (const [k, v] of Object.entries(a)) assert.ok(Number.isFinite(v), `${k} = ${v}`);
	const p = reverbParams(a);
	for (const [k, v] of Object.entries(p)) assert.ok(Number.isFinite(v), `${k} = ${v}`);
});

test('le pré-delay EST l\'aller-retour, pas un goût', () => {
	// C'est la grandeur qui porte toute la sensation de proximité : à un mètre
	// d'un mur la réflexion arrive en 6 ms, à vingt mètres en 117 ms.
	for (const d of [1, 3, 5, 10, 20]) {
		const { preDelayS } = reverbParams({ nearestM: d, meanM: d, enclosure: 0.5 });
		const expected = Math.min(Math.max((2 * d) / SPEED_OF_SOUND, REVERB.preDelayS[0]), REVERB.preDelayS[1]);
		assert.ok(Math.abs(preDelayS - expected) < 1e-9, `${d} m → ${preDelayS}, attendu ${expected}`);
	}
});

test('le pré-delay est borné des deux côtés', () => {
	// Trop court, une réflexion se lit comme un filtrage en peigne et pas comme
	// un lieu ; trop long, elle se détache en écho distinct.
	assert.equal(reverbParams({ nearestM: 0.01 }).preDelayS, REVERB.preDelayS[0]);
	assert.equal(reverbParams({ nearestM: 9999 }).preDelayS, REVERB.preDelayS[1]);
});

test('raser un mur s\'entend : le pré-delay chute quand on s\'approche', () => {
	let prev = Infinity;
	for (const d of [20, 10, 5, 2, 1]) {
		const { preDelayS } = reverbParams({ nearestM: d, meanM: 15, enclosure: 0.4 });
		assert.ok(preDelayS < prev, `à ${d} m le pré-delay ne descend plus`);
		prev = preDelayS;
	}
});

test('plus c\'est fermé, plus il y a de réflexions', () => {
	const open = reverbParams(acoustics(OPEN));
	const alley = reverbParams(acoustics(ALLEY));
	const box = reverbParams(acoustics(BOX));
	assert.ok(open.wet < alley.wet && alley.wet < box.wet);
	// Le plein ciel n'est pas sec pour autant : le sol renvoie toujours.
	assert.ok(open.wet > 0, 'le ciel ouvert ne doit pas être parfaitement sec');
});

test('un grand volume est plus sourd qu\'un petit', () => {
	const small = reverbParams({ nearestM: 2, meanM: 3, enclosure: 0.9 });
	const large = reverbParams({ nearestM: 2, meanM: 25, enclosure: 0.9 });
	assert.ok(large.dampHz < small.dampHz, `${large.dampHz} devrait être sous ${small.dampHz}`);
});

test('la durée suit la TAILLE du lieu, pas son degré de fermeture', () => {
	// Une cathédrale ouverte résonne plus longtemps qu'un placard fermé : si la
	// durée ne suivait que la fermeture, le placard gagnerait.
	const closet = reverbParams({ nearestM: 1, meanM: 2, enclosure: 0.95 });
	const hall = reverbParams({ nearestM: 8, meanM: 22, enclosure: 0.6 });
	assert.ok(hall.decayS > closet.decayS, `hall ${hall.decayS} vs placard ${closet.decayS}`);
});

test('tous les réglages restent dans leurs bornes, sur toute la plage', () => {
	for (let near = 0.2; near <= 40; near += 0.7) {
		for (let mean = 0.5; mean <= 40; mean += 3) {
			for (const enc of [0, 0.25, 0.5, 0.75, 1]) {
				const p = reverbParams({ nearestM: near, meanM: mean, enclosure: enc });
				assert.ok(p.preDelayS >= REVERB.preDelayS[0] && p.preDelayS <= REVERB.preDelayS[1]);
				assert.ok(p.wet >= REVERB.wet[0] && p.wet <= REVERB.wet[1]);
				assert.ok(p.dampHz >= REVERB.dampHz[0] && p.dampHz <= REVERB.dampHz[1]);
				assert.ok(p.decayS >= REVERB.decayS[0] && p.decayS <= REVERB.decayS[1]);
			}
		}
	}
});

test('les bornes sont ordonnées', () => {
	for (const k of ['preDelayS', 'wet', 'dampHz', 'decayS']) {
		assert.ok(REVERB[k][0] < REVERB[k][1], `${k} : bornes inversées`);
	}
	assert.ok(SPEED_OF_SOUND > 300 && SPEED_OF_SOUND < 400);
});

console.log(`space-selftest : ${passed} tests`);
