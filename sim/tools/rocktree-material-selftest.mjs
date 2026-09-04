// Selftest de la courbe pure du fondu de bord du terrain live (#202, suite
// de #200 — même bug, fenêtre circulaire mobile au lieu d'une bbox fixe).
import assert from 'node:assert/strict';
import { edgeFadeFor, EDGE_FADE_M } from '../src/RocktreeMaterial.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const CENTER = [0, 0];
const RADIUS = 300;

t('edgeFadeFor : nul au centre de la fenêtre', () => {
	assert.equal(edgeFadeFor([0, 0], CENTER, RADIUS, EDGE_FADE_M), 0);
});

t('edgeFadeFor : nul tant qu\'on est à plus de EDGE_FADE_M du bord', () => {
	assert.equal(edgeFadeFor([0, RADIUS - EDGE_FADE_M - 1], CENTER, RADIUS, EDGE_FADE_M), 0);
});

t('edgeFadeFor : plafond pile au bord réel', () => {
	assert.equal(edgeFadeFor([RADIUS, 0], CENTER, RADIUS, EDGE_FADE_M), 1);
});

t('edgeFadeFor : plafond au-delà du bord (ne redescend pas)', () => {
	const atEdge = edgeFadeFor([RADIUS, 0], CENTER, RADIUS, EDGE_FADE_M);
	const beyond = edgeFadeFor([RADIUS * 1.5, 0], CENTER, RADIUS, EDGE_FADE_M);
	assert.equal(beyond, atEdge);
});

t('edgeFadeFor : croissante en s\'approchant du bord', () => {
	const mid = edgeFadeFor([0, RADIUS - EDGE_FADE_M / 2], CENTER, RADIUS, EDGE_FADE_M);
	const near = edgeFadeFor([0, RADIUS - EDGE_FADE_M / 4], CENTER, RADIUS, EDGE_FADE_M);
	assert.ok(near > mid, `plus près du bord (${near}) devrait être plus fondu que le milieu de la bande (${mid})`);
});

t('edgeFadeFor : centré n\'importe où, pas seulement à l\'origine', () => {
	const v = edgeFadeFor([100, 50], [100, 50 - RADIUS], RADIUS, EDGE_FADE_M);
	assert.equal(v, 1, 'directement sur le cercle de rayon RADIUS autour du centre déplacé');
});

t('edgeFadeFor : fenêtre pas encore posée (loadRadiusM=0) — aucun fondu, pas l\'inverse', () => {
	assert.equal(edgeFadeFor([1e6, 1e6], CENTER, 0, EDGE_FADE_M), 0);
});

console.log(`rocktree-material-selftest : ${n} tests ok`);
