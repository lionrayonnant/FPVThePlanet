// Selftest of the progressive rocktree colliders (#168, #170).
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';

await initPhysics();

// A tiny flat tetrahedron, far below the spawn: just enough for a valid
// trimesh without touching the drone's collider during this test.
const vertices = new Float32Array([
	-1, -100, -1,   1, -100, -1,   0, -100, 1,   0, -99, 0,
]);
const indices = new Uint32Array([0, 1, 2,  0, 1, 3,  1, 2, 3,  0, 2, 3]);

const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const phys = new Physics(emptyCollision, { x: 0, y: 0, z: 0 });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('addNodeCollider then removeNodeCollider do not throw', () => {
	phys.addNodeCollider('306', vertices, indices);
	phys.removeNodeCollider('306');
});

t('addNodeCollider twice on the same path throws', () => {
	phys.addNodeCollider('306', vertices, indices);
	assert.throws(() => phys.addNodeCollider('306', vertices, indices), /306/);
	phys.removeNodeCollider('306');
});

t('removeNodeCollider on an unknown path throws', () => {
	assert.throws(() => phys.removeNodeCollider('999'), /999/);
});

t('an added collider is queryable by groundBelow() after flushNodeColliders()', () => {
	phys.addNodeCollider('306', vertices, indices);
	// The query BVH refit is deferred (#187): add/remove no longer pay for it
	// each (~0.4 ms per operation, 164 ms in total measured over a wave of 400
	// nodes) — flushNodeColliders(), called once per drain frame, is what makes
	// the changes visible to the queries.
	phys.flushNodeColliders();
	const g = phys.groundBelow(0, 0, 0);
	assert.ok(g !== null && Math.abs(g - -99.5) < 1, `ground=${g}`);
	phys.removeNodeCollider('306');
	phys.flushNodeColliders();
	assert.equal(phys.groundBelow(0, 0, 0), null, 'a removed collider must answer no more after the flush');
});

t('flushNodeColliders() with nothing pending is a safe no-op', () => {
	phys.flushNodeColliders();
	phys.flushNodeColliders();
});

// A rocktree node whose geometry truncates away entirely at layerBounds[3]
// (#178), or whose triangles are all degenerate or excluded, arrives here with
// empty indices. RAPIER.ColliderDesc.trimesh() with 0 triangles does NOT throw
// a clean JS exception: it crashes the whole WASM module (RuntimeError:
// unreachable), seen in real flight through processLiveNodeWork().
// addNodeCollider must swallow that case without ever calling trimesh(), and
// stay symmetric with removeNodeCollider() afterwards.
t('addNodeCollider with 0 triangles never calls trimesh() and does not crash', () => {
	phys.addNodeCollider('empty-node', vertices, new Uint32Array(0));
	phys.flushNodeColliders();
	phys.removeNodeCollider('empty-node');
	phys.flushNodeColliders();
});

t('addNodeCollider with 0 triangles: the path IS loaded (a second one throws)', () => {
	phys.addNodeCollider('empty-node-2', vertices, new Uint32Array(0));
	assert.throws(() => phys.addNodeCollider('empty-node-2', vertices, new Uint32Array(0)), /empty-node-2/);
	phys.removeNodeCollider('empty-node-2');
});

// Rapier 0.20 has no queryPipeline left: flushNodeColliders() asks for the
// refit with a step of dt = 0. That is only admissible as long as the step
// advances NOTHING — this is the test that holds it to that.
t('flushNodeColliders() does not advance the world', () => {
	phys.body.setTranslation({ x: 1, y: 2, z: 3 }, true);
	phys.body.setLinvel({ x: 4, y: 5, z: 6 }, true);
	phys.body.setAngvel({ x: 0.7, y: 0.8, z: 0.9 }, true);
	phys.body.setRotation({ x: 0, y: 0.3826834, z: 0, w: 0.9238795 }, true);
	phys.addNodeCollider('no-drift', vertices, indices);
	phys.flushNodeColliders();
	const p = phys.body.translation(), v = phys.body.linvel(), a = phys.body.angvel();
	const r = phys.body.rotation();
	assert.deepEqual([p.x, p.y, p.z], [1, 2, 3], 'the flush moved the machine');
	assert.deepEqual([v.x, v.y, v.z], [4, 5, 6], 'the flush changed the velocity');
	assert.deepEqual(
		[a.x, a.y, a.z].map((c) => +c.toFixed(6)), [0.7, 0.8, 0.9],
		'the flush changed the angular velocity',
	);
	assert.deepEqual(
		[r.x, r.y, r.z, r.w].map((c) => +c.toFixed(6)),
		[0, 0.382683, 0, 0.92388],
		'the flush turned the machine',
	);
	phys.removeNodeCollider('no-drift');
	phys.flushNodeColliders();
});

console.log(`physics-collider-selftest: ${n} tests ok`);
