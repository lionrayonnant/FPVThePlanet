// Selftest du cadrage de la mini-carte. Logique pure, aucun Leaflet.
// Lancer : node tools/map-preview-selftest.mjs
import assert from 'node:assert/strict';
import { previewBounds } from './map-preview-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('bbox : l\'emprise réellement acquise, telle quelle', () => {
	// C'est le rectangle qu'on a volé, pas un cercle autour du centre : la Home
	// et le scanner doivent montrer la même chose.
	const scene = {
		lat: 48.8499, lon: 2.3419,
		bbox: { south: 48.8483, west: 2.3385, north: 48.8516, east: 2.3453 },
	};
	assert.deepEqual(previewBounds(scene), [[48.8483, 2.3385], [48.8516, 2.3453]]);
});

t('poly : l\'emprise du tracé prime sur la bbox', () => {
	// Un tracé libre est plus fidèle que n'importe quel rectangle recalculé.
	const scene = {
		lat: 0, lon: 0,
		bbox: { south: 10, west: 10, north: 20, east: 20 },
		poly: [48.85, 2.29, 48.86, 2.29, 48.86, 2.31, 48.84, 2.30, 48.85, 2.29],
	};
	assert.deepEqual(previewBounds(scene), [[48.84, 2.29], [48.86, 2.31]]);
});

t('lat/lon seuls : un cadre au rayon d\'add-map, autour du point', () => {
	const b = previewBounds({ lat: 48.85, lon: 2.29 });
	assert.ok(b, 'un cadre');
	const [[s, w], [nn, e]] = b;
	assert.ok(s < 48.85 && nn > 48.85, 'encadre la latitude');
	assert.ok(w < 2.29 && e > 2.29, 'encadre la longitude');
	// 25 m de rayon : quelques dizaines de millionièmes de degré, pas un pays.
	assert.ok(nn - s < 0.002, `hauteur plausible, vu ${nn - s}`);
});

t('lat/lon seuls : le cadre s\'élargit en longitude vers les pôles', () => {
	// Un degré de longitude rétrécit avec le cosinus de la latitude. Sans cette
	// correction, un cadre de 25 m à Tromsø serait deux fois trop étroit au sol.
	const paris = previewBounds({ lat: 48.85, lon: 2.29 });
	const tromso = previewBounds({ lat: 69.65, lon: 18.96 });
	const width = (b) => b[1][1] - b[0][1];
	assert.ok(width(tromso) > width(paris), 'plus large en degrés au nord');
	// La hauteur, elle, ne dépend pas de la latitude.
	assert.ok(Math.abs((tromso[1][0] - tromso[0][0]) - (paris[1][0] - paris[0][0])) < 1e-9);
});

t('bbox dégénérée : on retombe sur le rayon plutôt que sur un point', () => {
	// Quatre bords égaux (vieille entrée, ou bug d'écriture) : fitBounds sur un
	// point unique zoome à l'infini. Mieux vaut le cadre de repli.
	const b = previewBounds({ lat: 48.85, lon: 2.29, bbox: { south: 48.85, west: 2.29, north: 48.85, east: 2.29 } });
	assert.ok(b[1][0] > b[0][0] && b[1][1] > b[0][1], 'un cadre non dégénéré');
});

t('ni emprise ni coordonnées : null, pas une carte inventée', () => {
	// L'appelant écrira « NO MAP FOR THIS AREA ». Un repli sur (0, 0) montrerait
	// le golfe de Guinée pour une zone parisienne — pire que pas de carte.
	assert.equal(previewBounds(null), null);
	assert.equal(previewBounds({}), null);
	assert.equal(previewBounds({ slug: 'x', name: 'X' }), null);
	assert.equal(previewBounds({ lat: 48.85 }), null, 'une seule coordonnée ne suffit pas');
	assert.equal(previewBounds({ lat: 'nord', lon: 2.29 }), null, 'une coordonnée illisible n\'est pas une coordonnée');
});

t('bbox illisible : traitée comme absente, pas propagée', () => {
	const b = previewBounds({ lat: 48.85, lon: 2.29, bbox: { south: null, west: 2, north: 49, east: 3 } });
	assert.ok(b, 'un cadre de repli');
	assert.ok(b[1][0] - b[0][0] < 0.002, 'le repli, pas la bbox cassée');
});

console.log(`\n${n} tests map-preview OK`);
