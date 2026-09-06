// node tools/onboard-drone-selftest.mjs — le drone du joueur (issue #264).
// Le maillage et la règle d'exclusivité se vérifient sans GPU.
import * as THREE from 'three';
import { PlayerDrone } from '../src/onboard-drone.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const make = (family = 'freestyle5') => {
	const seed = `player::${family}`;
	const build = targetBuild({ seed, family });
	return new PlayerDrone({
		scene: new THREE.Scene(),
		profile: build.profile,
		build,
		camera: targetCamera({ seed, family }),
	});
};

console.log('onboard-drone');
{
	const d = make();
	check('au repos : rien de visible', !d.worldVisible && !d.onboardVisible);
	d.setFreeCam(true);
	check('free cam : l\'exemplaire monde est visible', d.worldVisible);
	check('free cam : l\'embarqué est caché', !d.onboardVisible);
	d.setFreeCam(false);
	check('retour en vue pilote : le monde se cache', !d.worldVisible);
	d.dispose();
}
{
	const d = make();
	d.setFreeCam(true);
	d.update({
		dt: 1 / 60,
		position: { x: 12, y: 34, z: -56 },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		omega: [100, 100, 100, 100],
		sun: { dir: new THREE.Vector3(0, 1, 0), night: 0 },
		dim: 1,
		fogColor: 0x223344,
		fogDensity: 0.001,
		resolution: { w: 1600, h: 900 },
	});
	const p = new THREE.Vector3().setFromMatrixPosition(d.world.group.matrix);
	check('l\'exemplaire monde suit la position physique', p.distanceTo(new THREE.Vector3(12, 34, -56)) < 1e-6, `${p.toArray()}`);
	d.dispose();
}
{
	const scene = new THREE.Scene();
	const build = targetBuild({ seed: 'dispose', family: 'race5' });
	const d = new PlayerDrone({ scene, profile: build.profile, build, camera: targetCamera({ seed: 'dispose', family: 'race5' }) });
	const before = scene.children.length;
	d.dispose();
	check('dispose() retire tout de la scène', scene.children.length === 0, `${before} → ${scene.children.length}`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
