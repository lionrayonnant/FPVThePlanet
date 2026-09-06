// Selftest des libérations mémoire d'une page de vol (issue #249).
//
// Une page de vol est rechargée à chaque vol, et le processus de rendu Chrome
// empilait les gros tampons des pages mortes jusqu'à ce que ses allocations
// échouent (trap WASM Rapier « unreachable », worker de tuile tué en silence).
// Deux tampons dominaient : les pixels des textures gardés après téléversement
// GPU, et le collision.bin retenu par le cache `_shape` du Collider Rapier.
// Ces contrôles vérifient que chacun est vraiment rendu — DÉTACHÉ, pas juste
// déréférencé — et que la physique continue de répondre après coup.
import assert from 'node:assert/strict';
import { initPhysics, Physics, detachBuffer } from '../src/physics.js';
import { createArrayTexture, releaseTexturePixels } from '../src/TileMaterial.js';

await initPhysics();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Un sol : deux triangles à y = -5 sous l'origine, dans un seul ArrayBuffer
// comme le produit loadCollision() (en-tête de 16 octets, sommets puis indices).
function makeCollision() {
	const verts = [-50, -5, -50,  50, -5, -50,  50, -5, 50,  -50, -5, 50];
	const idx = [0, 1, 2,  0, 2, 3];
	const buf = new ArrayBuffer(16 + verts.length * 4 + idx.length * 4);
	const vertices = new Float32Array(buf, 16, verts.length);
	const indices = new Uint32Array(buf, 16 + verts.length * 4, idx.length);
	vertices.set(verts); indices.set(idx);
	return { buf, vertices, indices };
}

t('detachBuffer() rend un ArrayBuffer (byteLength 0) et tolère le reste', () => {
	const buf = new ArrayBuffer(1024);
	detachBuffer(buf);
	assert.equal(buf.byteLength, 0, 'le tampon doit être détaché');
	assert.doesNotThrow(() => detachBuffer(buf), 'déjà détaché : silencieux');
	assert.doesNotThrow(() => detachBuffer(null));
	assert.doesNotThrow(() => detachBuffer(undefined));
	assert.doesNotThrow(() => detachBuffer(new ArrayBuffer(0)));
});

t('releaseSourceArrays() vide le cache _shape de Rapier et détache le collision.bin', () => {
	const c = makeCollision();
	const phys = new Physics({ vertices: c.vertices, indices: c.indices }, { x: 0, y: 10, z: 0 });
	assert.ok(phys.groundCollider, 'un trimesh non vide donne un collider de scène');
	assert.ok(phys.groundCollider._shape, 'Rapier garde bien les tableaux JS avant libération');
	phys.releaseSourceArrays({ vertices: c.vertices, indices: c.indices });
	assert.equal(phys.groundCollider._shape, null, 'le cache _shape doit être vidé');
	assert.equal(c.buf.byteLength, 0, 'le tampon du collision.bin doit être détaché');
	assert.equal(c.vertices.length, 0, 'les vues sont mortes avec lui');
});

t('la physique répond encore après releaseSourceArrays() : raycast, step, shape', () => {
	const c = makeCollision();
	const phys = new Physics({ vertices: c.vertices, indices: c.indices }, { x: 0, y: 10, z: 0 });
	phys.releaseSourceArrays({ vertices: c.vertices, indices: c.indices });
	const g = phys.groundBelow(0, 10, 0);
	assert.ok(g !== null && Math.abs(g - (-5)) < 1e-3, `le sol doit toujours répondre à -5 (reçu ${g})`);
	assert.doesNotThrow(() => phys.step([0, 0, 0, 0], 1 / 250), 'un pas de simulation passe');
	// Rapier recharge le cache à la demande depuis le WASM : la forme est bien là.
	const shape = phys.groundCollider.shape;
	assert.ok(shape && shape.indices && shape.indices.length === 6, 'collider.shape se relit depuis le WASM');
});

t('releaseSourceArrays() sans collider de scène (mode ?live=) est un no-op sûr', () => {
	const empty = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	const phys = new Physics(empty, { x: 0, y: 0, z: 0 });
	assert.equal(phys.groundCollider, null);
	assert.doesNotThrow(() => phys.releaseSourceArrays(empty));
	assert.doesNotThrow(() => phys.releaseSourceArrays(null));
});

t('releaseTexturePixels() détache les pixels et laisse une texture cohérente', () => {
	const cell = 4, layers = 2;
	const pixels = new Uint8Array(cell * cell * 4 * layers);
	const buf = pixels.buffer;
	const tex = createArrayTexture(pixels, cell, layers, { mipmaps: false });
	assert.equal(tex.image.width, cell);
	releaseTexturePixels(tex);
	assert.equal(tex.image.data, null, 'plus de pixels côté JS');
	assert.equal(buf.byteLength, 0, 'le tampon doit être détaché, pas seulement déréférencé');
	assert.equal(tex.image.width, cell, 'les dimensions restent (three les lit pour ses paramètres)');
	assert.equal(tex.image.depth, layers);
	assert.doesNotThrow(() => releaseTexturePixels(tex), 'deux fois : silencieux');
	assert.doesNotThrow(() => releaseTexturePixels(null));
	assert.doesNotThrow(() => releaseTexturePixels({}));
});

console.log(`memory-release-selftest : ${n} tests ok`);
