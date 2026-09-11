// Selftest for the memory releases of a flight page (issue #249).
//
// A flight page is reloaded on every flight, and the Chrome render process
// stacked up the big buffers of dead pages until its allocations failed
// (Rapier WASM "unreachable" trap, tile worker killed silently). Two buffers
// dominated: texture pixels kept after the GPU upload, and the collision.bin
// retained by the Rapier Collider's `_shape` cache. These checks verify that
// each one is really released — DETACHED, not merely dereferenced — and that
// physics keeps answering afterwards.
import assert from 'node:assert/strict';
import { initPhysics, Physics, detachBuffer } from '../src/physics.js';
import { createArrayTexture, releaseTexturePixels } from '../src/TileMaterial.js';

await initPhysics();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A floor: two triangles at y = -5 below the origin, in a single ArrayBuffer
// as loadCollision() produces it (16-byte header, vertices then indices).
function makeCollision() {
	const verts = [-50, -5, -50,  50, -5, -50,  50, -5, 50,  -50, -5, 50];
	const idx = [0, 1, 2,  0, 2, 3];
	const buf = new ArrayBuffer(16 + verts.length * 4 + idx.length * 4);
	const vertices = new Float32Array(buf, 16, verts.length);
	const indices = new Uint32Array(buf, 16 + verts.length * 4, idx.length);
	vertices.set(verts); indices.set(idx);
	return { buf, vertices, indices };
}

t('detachBuffer() releases an ArrayBuffer (byteLength 0) and tolerates the rest', () => {
	const buf = new ArrayBuffer(1024);
	detachBuffer(buf);
	assert.equal(buf.byteLength, 0, 'the buffer must be detached');
	assert.doesNotThrow(() => detachBuffer(buf), 'already detached: silent');
	assert.doesNotThrow(() => detachBuffer(null));
	assert.doesNotThrow(() => detachBuffer(undefined));
	assert.doesNotThrow(() => detachBuffer(new ArrayBuffer(0)));
});

t('releaseSourceArrays() empties the Rapier _shape cache and detaches the collision.bin', () => {
	const c = makeCollision();
	const phys = new Physics({ vertices: c.vertices, indices: c.indices }, { x: 0, y: 10, z: 0 });
	assert.ok(phys.groundCollider, 'a non-empty trimesh yields a scene collider');
	assert.ok(phys.groundCollider._shape, 'Rapier does keep the JS arrays before release');
	phys.releaseSourceArrays({ vertices: c.vertices, indices: c.indices });
	assert.equal(phys.groundCollider._shape, null, 'the _shape cache must be emptied');
	assert.equal(c.buf.byteLength, 0, 'the collision.bin buffer must be detached');
	assert.equal(c.vertices.length, 0, 'the views died with it');
});

t('physics still answers after releaseSourceArrays(): raycast, step, shape', () => {
	const c = makeCollision();
	const phys = new Physics({ vertices: c.vertices, indices: c.indices }, { x: 0, y: 10, z: 0 });
	phys.releaseSourceArrays({ vertices: c.vertices, indices: c.indices });
	const g = phys.groundBelow(0, 10, 0);
	assert.ok(g !== null && Math.abs(g - (-5)) < 1e-3, `the floor must still answer at -5 (got ${g})`);
	assert.doesNotThrow(() => phys.step([0, 0, 0, 0], 1 / 250), 'a simulation step goes through');
	// Rapier reloads the cache on demand from the WASM: the shape is really there.
	const shape = phys.groundCollider.shape;
	assert.ok(shape && shape.indices && shape.indices.length === 6, 'collider.shape reads back from the WASM');
});

t('releaseSourceArrays() without a scene collider (?live= mode) is a safe no-op', () => {
	const empty = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	const phys = new Physics(empty, { x: 0, y: 0, z: 0 });
	assert.equal(phys.groundCollider, null);
	assert.doesNotThrow(() => phys.releaseSourceArrays(empty));
	assert.doesNotThrow(() => phys.releaseSourceArrays(null));
});

t('releaseTexturePixels() detaches the pixels and leaves a coherent texture', () => {
	const cell = 4, layers = 2;
	const pixels = new Uint8Array(cell * cell * 4 * layers);
	const buf = pixels.buffer;
	const tex = createArrayTexture(pixels, cell, layers, { mipmaps: false });
	assert.equal(tex.image.width, cell);
	releaseTexturePixels(tex);
	assert.equal(tex.image.data, null, 'no pixels left on the JS side');
	assert.equal(buf.byteLength, 0, 'the buffer must be detached, not merely dereferenced');
	assert.equal(tex.image.width, cell, 'the dimensions stay (three reads them for its parameters)');
	assert.equal(tex.image.depth, layers);
	assert.doesNotThrow(() => releaseTexturePixels(tex), 'twice: silent');
	assert.doesNotThrow(() => releaseTexturePixels(null));
	assert.doesNotThrow(() => releaseTexturePixels({}));
});

console.log(`memory-release-selftest: ${n} tests ok`);
