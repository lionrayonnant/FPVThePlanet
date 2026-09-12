// Selftest du champ partagé des deux clôtures (#107) : la bichromie, la
// cadence du ping, les projections de surface — et, en fin de fichier, la
// compilation réelle des quatre shaders par glslangValidator quand il est là.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CYAN, MAGENTA,
	hueBiasFor, HUE_BIAS_CEIL,
	pingIntervalFor, PING_SILENCE_RATIO, PING_INTERVAL_FAR_S, PING_INTERVAL_NEAR_S,
	PingClock,
	nearestOnBoxSurface, nearestOnSphereSurface,
	FENCE_FIELD_GLSL,
} from '../src/fence-field.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- Bichromie -------------------------------------------------------------

t('hueBiasFor : cyan pur au centre de la carte', () => {
	assert.equal(hueBiasFor(0), 0);
});

t('hueBiasFor : magenta au maximum pile au bord', () => {
	assert.ok(Math.abs(hueBiasFor(1) - HUE_BIAS_CEIL) < 1e-9, `${hueBiasFor(1)} != ${HUE_BIAS_CEIL}`);
});

t('hueBiasFor : reste franchement cyan sur la moitié intérieure', () => {
	// La couleur doit DIRE la proximité : si le magenta montait linéairement,
	// il serait déjà à mi-course au milieu de la carte et ne signalerait plus
	// rien. Quadratique : 25 % du plafond à mi-chemin.
	assert.ok(hueBiasFor(0.5) < HUE_BIAS_CEIL * 0.3, `${hueBiasFor(0.5)} trop haut à mi-carte`);
});

t('hueBiasFor : croissante et clampée hors [0,1]', () => {
	const a = hueBiasFor(0.3), b = hueBiasFor(0.6), c = hueBiasFor(0.9);
	assert.ok(a < b && b < c, `pas croissante : ${a}, ${b}, ${c}`);
	assert.equal(hueBiasFor(-1), hueBiasFor(0));
	assert.equal(hueBiasFor(3), hueBiasFor(1));
});

t('CYAN et MAGENTA : la paire de la culmination, telle quelle', () => {
	assert.equal(CYAN, 0x4dd8e8);
	assert.equal(MAGENTA, 0xe34de0);
});

// --- Cadence du ping -------------------------------------------------------

t('pingIntervalFor : silence total loin du bord', () => {
	// Vu en permanence : au centre, la clôture n'a rien à dire et ne doit rien
	// faire. Un anneau qui partirait quand même finirait par lasser.
	assert.equal(pingIntervalFor(0), Infinity);
	assert.equal(pingIntervalFor(PING_SILENCE_RATIO * 0.5), Infinity);
});

t('pingIntervalFor : cadence lente dès la sortie du silence', () => {
	const justAfter = pingIntervalFor(PING_SILENCE_RATIO + 1e-6);
	assert.ok(Math.abs(justAfter - PING_INTERVAL_FAR_S) < 1e-3, `${justAfter} != ${PING_INTERVAL_FAR_S}`);
});

t('pingIntervalFor : se resserre en approchant du bord', () => {
	const mid = pingIntervalFor((PING_SILENCE_RATIO + 1) / 2);
	assert.ok(mid < PING_INTERVAL_FAR_S && mid > PING_INTERVAL_NEAR_S, `${mid} hors bornes`);
	assert.ok(Math.abs(pingIntervalFor(1) - PING_INTERVAL_NEAR_S) < 1e-9);
	assert.equal(pingIntervalFor(2), pingIntervalFor(1));
});

t('PingClock : rien ne part tant qu\'on est dans la zone de silence', () => {
	const clock = new PingClock();
	let fired = 0;
	for (let i = 0; i < 600; i++) if (clock.advance(1 / 60, 0.1)) fired++;
	assert.equal(fired, 0);
});

t('PingClock : un premier ping dès l\'entrée en zone active, puis à la cadence', () => {
	const clock = new PingClock();
	// L'entrée dans la zone doit se voir tout de suite — c'est l'information
	// « tu approches », elle ne peut pas attendre PING_INTERVAL_FAR_S.
	assert.equal(clock.advance(1 / 60, 1), true);
	let fired = 0;
	for (let i = 0; i < 600; i++) if (clock.advance(1 / 60, 1)) fired++;
	// 10 s à la cadence la plus serrée.
	const expected = Math.floor(10 / PING_INTERVAL_NEAR_S);
	assert.ok(Math.abs(fired - expected) <= 1, `${fired} pings, attendu ~${expected}`);
});

t('PingClock : repasser au centre réarme le premier ping', () => {
	const clock = new PingClock();
	clock.advance(1 / 60, 1);
	for (let i = 0; i < 120; i++) clock.advance(1 / 60, 0);   // retour au calme
	assert.equal(clock.advance(1 / 60, 1), true, 'le retour au bord doit reping tout de suite');
});

t('PingClock : un dt énorme (onglet en arrière-plan) ne déclenche qu\'un ping', () => {
	const clock = new PingClock();
	clock.advance(1 / 60, 1);          // consomme le premier
	let fired = 0;
	if (clock.advance(30, 1)) fired++;
	assert.equal(fired, 1, 'pas de rafale de rattrapage');
});

// --- Projections de surface ------------------------------------------------

const BBOX = { min: [-100, 0, -100], max: [100, 50, 100] };

t('nearestOnBoxSurface : la face est, et une hauteur qui suit le drone', () => {
	const s = nearestOnBoxSurface({ x: 90, y: 12, z: 0 }, BBOX);
	assert.equal(s.v, 12);
	// Périmètre 800 m, u dans [0, 800).
	assert.ok(s.u >= 0 && s.u < 800, `u=${s.u} hors périmètre`);
	assert.equal(s.perimeter, 800);
});

t('nearestOnBoxSurface : deux points proches du même bord donnent des u proches', () => {
	const a = nearestOnBoxSurface({ x: 90, y: 0, z: 10 }, BBOX);
	const b = nearestOnBoxSurface({ x: 90, y: 0, z: 20 }, BBOX);
	assert.ok(Math.abs(a.u - b.u) < 20, `u discontinu le long d'une face : ${a.u} vs ${b.u}`);
});

t('nearestOnBoxSurface : la coordonnée est continue en tournant le coin', () => {
	// Juste avant et juste après un coin, u ne doit pas sauter d'un demi-tour :
	// c'est ce qui ferait casser l'anneau en deux morceaux à l'écran.
	const before = nearestOnBoxSurface({ x: 95, y: 0, z: 99 }, BBOX);
	const after = nearestOnBoxSurface({ x: 99, y: 0, z: 95 }, BBOX);
	assert.ok(Math.abs(before.u - after.u) < 30, `saut au coin : ${before.u} vs ${after.u}`);
});

t('nearestOnBoxSurface : les quatre faces tombent dans quatre quarts distincts', () => {
	const us = [
		nearestOnBoxSurface({ x: 0, y: 0, z: -99 }, BBOX).u,
		nearestOnBoxSurface({ x: 99, y: 0, z: 0 }, BBOX).u,
		nearestOnBoxSurface({ x: 0, y: 0, z: 99 }, BBOX).u,
		nearestOnBoxSurface({ x: -99, y: 0, z: 0 }, BBOX).u,
	];
	const quarters = us.map((u) => Math.floor(u / 200));
	assert.deepEqual(quarters, [0, 1, 2, 3], `faces mal réparties : ${us}`);
});

t('nearestOnBoxSurface : bbox dégénérée (bench) ne lève pas', () => {
	const s = nearestOnBoxSurface({ x: 0, y: 0, z: 0 }, { min: [0, 0, 0], max: [0, 0, 0] });
	assert.ok(Number.isFinite(s.u) && Number.isFinite(s.v) && Number.isFinite(s.perimeter));
});

t('nearestOnSphereSurface : u/v en mètres d\'arc, périmètre = grand cercle', () => {
	const center = { x: 0, z: 0 }, radius = 100;
	const s = nearestOnSphereSurface({ x: 50, y: 0, z: 0 }, center, radius, 0);
	assert.ok(Math.abs(s.perimeter - 2 * Math.PI * radius) < 1e-6);
	assert.ok(s.u >= 0 && s.u < s.perimeter, `u=${s.u} hors périmètre`);
	assert.ok(Math.abs(s.v) < 1e-6, 'drone à l\'altitude du centre : élévation nulle');
});

t('nearestOnSphereSurface : le drone au-dessus du centre monte en v', () => {
	const s = nearestOnSphereSurface({ x: 0, y: 60, z: 0 }, { x: 0, z: 0 }, 100, 0);
	assert.ok(s.v > 0, `v=${s.v} devrait être positif`);
});

t('nearestOnSphereSurface : drone pile au centre ne lève pas (direction dégénérée)', () => {
	const s = nearestOnSphereSurface({ x: 0, y: 0, z: 0 }, { x: 0, z: 0 }, 100, 0);
	assert.ok(Number.isFinite(s.u) && Number.isFinite(s.v));
});

// --- Contrat du GLSL partagé ----------------------------------------------

t('FENCE_FIELD_GLSL : fournit bien les entrées que les deux clôtures appellent', () => {
	for (const symbol of ['fenceField', 'fenceFbm', 'fenceWarp', 'FenceIn']) {
		assert.ok(FENCE_FIELD_GLSL.includes(symbol), `${symbol} absent du GLSL partagé`);
	}
});

t('FENCE_FIELD_GLSL : un fragment à insérer, pas un shader complet', () => {
	assert.ok(!FENCE_FIELD_GLSL.includes('#version'), 'ne doit pas porter sa propre directive de version');
	assert.ok(!/\bvoid\s+main\s*\(/.test(FENCE_FIELD_GLSL), 'ne doit pas porter de main()');
});

// --- Compilation réelle du GLSL -------------------------------------------
//
// Le reste de ce fichier teste des courbes ; ça, ça teste que les deux
// clôtures COMPILENT. Un shader ne rate pas en Node, il rate à l'écran, et
// une faute de frappe dans une chaîne GLSL ne se voit nulle part ailleurs.
//
// glslangValidator n'est pas garanti sur un runner CI : absent, on SAUTE
// bruyamment plutôt que d'échouer — même patron que
// tools/entry-state-selftest.mjs face à une scène manquante.

const validator = spawnSync('glslangValidator', ['--version'], { encoding: 'utf8' });
if (validator.error) {
	console.log('  SKIP  compilation GLSL — glslangValidator introuvable (paquet glslang)');
} else {
	// Le prologue que THREE injecte lui-même avant chaque shader WebGL2. Il
	// n'est pas exhaustif : juste ce que les deux clôtures utilisent.
	const VERTEX_PROLOGUE = [
		'#version 300 es',
		'precision highp float;',
		'uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;',
		'uniform mat3 normalMatrix;',
		'uniform vec3 cameraPosition;',
		'in vec3 position;',
		'in vec3 normal;',
	].join('\n');
	const FRAGMENT_PROLOGUE = ['#version 300 es', 'precision highp float;'].join('\n');

	const THREE = await import('three');
	const { GeofenceWall } = await import('../src/geofence-dome.js');
	const { FenceDome } = await import('../src/fence-dome.js');

	const compile = (label, stage, source) => {
		const file = join(tmpdir(), `fpvtp-fence-${label}.${stage}`);
		writeFileSync(file, source);
		const out = spawnSync('glslangValidator', [file], { encoding: 'utf8' });
		try { unlinkSync(file); } catch { /* le nettoyage n'est pas le sujet */ }
		assert.equal(out.status, 0, `${label} (${stage}) ne compile pas :\n${out.stdout}${out.stderr}`);
	};

	const scene = new THREE.Scene();
	const fences = [
		['wall', new GeofenceWall(scene, { min: [-100, 0, -100], max: [100, 50, 100] }).material],
		['dome', new FenceDome(scene).material],
	];
	for (const [label, material] of fences) {
		t(`${label} : le vertex shader compile`, () => {
			compile(label, 'vert', `${VERTEX_PROLOGUE}\n${material.vertexShader}`);
		});
		t(`${label} : le fragment shader compile`, () => {
			compile(label, 'frag', `${FRAGMENT_PROLOGUE}\n${material.fragmentShader}`);
		});
	}
}

console.log(`fence-field-selftest : ${n} tests ok`);
