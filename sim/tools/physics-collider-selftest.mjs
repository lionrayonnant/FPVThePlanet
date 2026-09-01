// Selftest des colliders rocktree progressifs (#168, #170).
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';

await initPhysics();

// Un tétraèdre minuscule et plat, loin sous le spawn : juste de quoi avoir
// un trimesh valide sans toucher au collider du drone pendant ce test.
const vertices = new Float32Array([
	-1, -100, -1,   1, -100, -1,   0, -100, 1,   0, -99, 0,
]);
const indices = new Uint32Array([0, 1, 2,  0, 1, 3,  1, 2, 3,  0, 2, 3]);

const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const phys = new Physics(emptyCollision, { x: 0, y: 0, z: 0 });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('addNodeCollider puis removeNodeCollider ne lèvent pas', () => {
	phys.addNodeCollider('306', vertices, indices);
	phys.removeNodeCollider('306');
});

t('addNodeCollider deux fois sur le même chemin lève', () => {
	phys.addNodeCollider('306', vertices, indices);
	assert.throws(() => phys.addNodeCollider('306', vertices, indices), /306/);
	phys.removeNodeCollider('306');
});

t('removeNodeCollider sur un chemin absent lève', () => {
	assert.throws(() => phys.removeNodeCollider('999'), /999/);
});

t('un collider ajouté est bien interrogeable par groundBelow()', () => {
	phys.addNodeCollider('306', vertices, indices);
	const g = phys.groundBelow(0, 0, 0);
	assert.ok(g !== null && Math.abs(g - -99.5) < 1, `ground=${g}`);
	phys.removeNodeCollider('306');
});

console.log(`physics-collider-selftest : ${n} tests ok`);
