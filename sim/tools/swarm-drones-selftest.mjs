// node tools/swarm-drones-selftest.mjs — l'INSTANCE de l'essaim (issue #29) :
// src/swarm-drones.js, qui lie le modèle pur (src/swarm.js) aux maillages
// (src/drone-mesh.js) et parle à main.js. En Node, sans GPU : on vérifie ce que
// l'instance MONTE dans la scène et ce qu'elle en retire, pas ce que la carte
// graphique en fait. Le modèle lui-même a son propre selftest
// (tools/swarm-selftest.mjs) et n'est pas rejugé ici.
//
// Ajouter `--expose-gc` pour que le contrôle d'allocation tourne :
//   node --expose-gc tools/swarm-drones-selftest.mjs
import * as THREE from 'three';
import { SwarmDrones } from '../src/swarm-drones.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

// Rien ne bloque : le repli des unités est le métier du modèle, pas le nôtre.
const terrain = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
const fence = { bbox: { min: [-900, -50, -900], max: [900, 200, 900] }, center: null, radius: 0 };
const wind = { x: 1, y: 0, z: 0 };
const sun = { dir: { x: 0.3, y: 0.8, z: 0.5 }, ambient: 0.059, night: 0 };
const DESC = { size: 9, doctrineSeed: 'selftest::swarm' };

function makeScene() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x8899aa);
	return scene;
}

// Le joueur avance vers le nord (−Z) : le sillage a besoin d'une piste, sinon
// toutes les unités restent empilées sur le point de départ.
function stepper(s, opts = {}) {
	const player = { x: 0, y: 40, z: 0 };
	const arg = {
		dt: 0, player, time: 0, terrain, wind, fence,
		fogColor: opts.fogColor ?? 0x8899aa, fogDensity: opts.fogDensity ?? 0.003,
		sun, dim: 0.82, resolution: opts.resolution ?? { w: 1920, h: 1080 },
	};
	return (dt) => {
		arg.dt = dt;
		arg.time += dt;
		player.z -= 12 * dt;
		s.update(arg);
		return player;
	};
}

console.log('swarm-drones : construction');
{
	const scene = makeScene();
	const s = new SwarmDrones({ scene });
	check('sans essaim : update ne fait rien et ne jette pas', (stepper(s)(1 / 60), true));
	check('sans essaim : debug() vide', s.debug().size === 0 && s.debug().drawCalls === 0);
	check('sans essaim : la scène reste vide', scene.children.length === 0);

	s.setSwarm(DESC);
	check('setSwarm : un groupe par unité', scene.children.length === DESC.size, `${scene.children.length}`);
	check('setSwarm : le modèle porte la taille demandée', s.model.size === DESC.size);
	check('setSwarm : invisibles tant qu\'aucune frame ne les a posées',
		scene.children.every((g) => g.visible === false));
	// LA décision de la spec : une recette, une géométrie fusionnée, un
	// matériau de corps. C'est ce qui prépare l'InstancedMesh, et c'est ce qui
	// tient les 24 draw calls à douze.
	const bodies = scene.children.map((g) => g.children[0]);
	const leds = scene.children.map((g) => g.children[1]);
	check('toutes les unités partagent UNE géométrie',
		new Set(bodies.map((b) => b.geometry.uuid)).size === 1);
	check('toutes les unités partagent UN matériau de corps',
		new Set(bodies.map((b) => b.material.uuid)).size === 1);
	check('la LED partage sa géométrie mais pas son matériau',
		new Set(leds.map((l) => l.geometry.uuid)).size === 1
		&& new Set(leds.map((l) => l.material.uuid)).size === DESC.size);
	check('strobe distinct par unité',
		new Set(leds.map((l) => l.material.uniforms.uPhase.value)).size === DESC.size);
	check('LED forte : plus de pixels que le plancher ordinaire de 3 px',
		leds.every((l) => l.material.uniforms.uMinPx.value > 3));
	check('debug() : deux draw calls par unité', s.debug().drawCalls === 2 * DESC.size, `${s.debug().drawCalls}`);
	check('debug() : la doctrine et la plage de lag remontent',
		typeof s.debug().doctrine === 'string' && s.debug().lagRange[1] >= s.debug().lagRange[0]);
	check('debug() rend TOUJOURS le même objet', s.debug() === s.debug());

	s.setSwarm(null);
	check('setSwarm(null) : la scène est rendue', scene.children.length === 0);
	check('setSwarm(null) : debug() vide', s.debug().size === 0);
	s.dispose();
}

console.log('\nswarm-drones : la vie de l\'essaim');
{
	const scene = makeScene();
	const s = new SwarmDrones({ scene });
	s.setSwarm(DESC);
	const step = stepper(s);
	const player = step(1 / 60);
	s.reset(player);
	for (let i = 0; i < 300; i++) step(1 / 60);
	check('toutes les unités sont posées et visibles', scene.children.every((g) => g.visible));
	check('les matrices sont finies',
		scene.children.every((g) => g.matrix.elements.every(Number.isFinite)));
	check('les positions sont finies', Array.from(s.model.pos).every(Number.isFinite));
	// Elles suivent : l'essaim s'ÉTALE le long de la piste au lieu de rester
	// empilé sur le joueur, et sa queue est derrière lui. Le barycentre, lui,
	// ne dit rien — une doctrine à éclaireurs le ramène sur le joueur.
	let zMin = Infinity, zMax = -Infinity, dMax = 0;
	for (let k = 0; k < s.model.size; k++) {
		const z = s.model.pos[3 * k + 2];
		if (z < zMin) zMin = z;
		if (z > zMax) zMax = z;
		dMax = Math.max(dMax, Math.hypot(
			s.model.pos[3 * k] - player.x, s.model.pos[3 * k + 1] - player.y, z - player.z));
	}
	check('l\'essaim s\'étale le long de la piste', zMax - zMin > 5, `${(zMax - zMin).toFixed(1)} m`);
	check('sa queue traîne derrière le joueur', zMax > player.z + 1, `${(zMax - player.z).toFixed(1)} m`);
	check('et personne n\'est parti au loin', dMax < 60, `${dMax.toFixed(1)} m`);
	// reset() : le sillage se vide et tout le monde revient sur le joueur.
	s.reset(player);
	let far = 0;
	for (let k = 0; k < s.model.size; k++) {
		far = Math.max(far, Math.hypot(
			s.model.pos[3 * k] - player.x, s.model.pos[3 * k + 1] - player.y, s.model.pos[3 * k + 2] - player.z));
	}
	check('reset() repose toutes les unités sur le joueur', far < 1e-9, `${far}`);
	// Frame gelée : le modèle ne fait pas un pas, mais update() tourne quand
	// même — c'est ce que main.js fait avec `frozen ? 0 : dt`.
	const before = Array.from(s.model.pos);
	s.update({ dt: 0, player, time: 99, terrain, wind, fence, fogColor: 0x8899aa, fogDensity: 0.003, sun, dim: 1, resolution: { w: 800, h: 600 } });
	check('gelé (dt = 0) : rien ne bouge', Array.from(s.model.pos).every((v, i) => v === before[i]));
	s.dispose();
}

console.log('\nswarm-drones : dispose() libère');
{
	const scene = makeScene();
	const s = new SwarmDrones({ scene });
	s.setSwarm(DESC);
	const geo = scene.children[0].children[0].geometry;
	const mat = scene.children[0].children[0].material;
	const leds = scene.children.map((g) => g.children[1].material);
	let freedGeo = 0, freedMat = 0;
	geo.addEventListener('dispose', () => { freedGeo++; });
	mat.addEventListener('dispose', () => { freedMat++; });
	for (const l of leds) l.addEventListener('dispose', () => { freedMat++; });
	s.dispose();
	check('dispose() vide la scène', scene.children.length === 0);
	check('dispose() libère la géométrie partagée UNE fois', freedGeo === 1, `${freedGeo}`);
	check('dispose() libère le matériau de corps et chaque LED',
		freedMat === 1 + DESC.size, `${freedMat}`);
	check('dispose() : debug() retombe à vide', s.debug().size === 0);
	// Idempotent : main.js appelle dispose() au beforeunload, qui peut suivre
	// un setSwarm(null).
	check('dispose() deux fois ne jette pas', (s.dispose(), true));
}

console.log('\nswarm-drones : update() n\'alloue pas');
{
	const scene = makeScene();
	const s = new SwarmDrones({ scene });
	s.setSwarm({ size: 12, doctrineSeed: 'selftest::alloc' });
	const step = stepper(s);
	for (let i = 0; i < 400; i++) step(1 / 60);
	if (global.gc) {
		global.gc(); global.gc();
		const before = process.memoryUsage().heapUsed;
		const N = 20000;
		for (let i = 0; i < N; i++) step(1 / 60);
		global.gc(); global.gc();
		const bytes = (process.memoryUsage().heapUsed - before) / N;
		// Même barre que les ambiants : très au-dessus du bruit de JIT, très en
		// dessous de ce que coûterait un seul littéral par frame.
		check('update() ne retient rien sur 20 000 frames', bytes < 32, `${bytes.toFixed(1)} o/frame`);
	} else {
		console.log('  SKIP  contrôle d\'allocation — relancer avec --expose-gc');
	}
	s.dispose();
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
