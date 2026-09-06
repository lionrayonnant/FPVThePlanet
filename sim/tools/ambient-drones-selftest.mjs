// node tools/ambient-drones-selftest.mjs — l'INSTANCE des drones ambiants
// (issue #250) : src/ambient-drones.js, qui lie le modèle pur, les maillages
// et les voix. En Node, sans GPU ni Web Audio — `audio-bus.context()` rend
// null tant qu'aucun geste utilisateur n'a ouvert de contexte, donc le graphe
// audio ne se construit jamais ici et c'est exactement ce qu'on veut : on
// vérifie ce que l'instance DONNE au son, pas ce que le son en fait.
//
// Ajouter `--expose-gc` pour que le contrôle d'allocation tourne :
//   node --expose-gc tools/ambient-drones-selftest.mjs
import * as THREE from 'three';
import { AmbientDrones } from '../src/ambient-drones.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

// Terrain plat à 0, rien qui bloque : les naissances ne dépendent que de la
// bulle et de la clôture, pas d'une géométrie qu'on n'a pas ici.
const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
const bounds = { bbox: { min: [-900, -50, -900], max: [900, 60, 900] }, corridor: { hold: 73 } };
const player = { x: 0, y: 40, z: 0 };
const playerVel = { x: 0, y: 0, z: 0 };
const wind = { x: 1, y: 0, z: 0 };
// `ambient` volontairement ABSURDE ici : les ambiants ne doivent PAS le lire.
// L'exposition absolue du soleil (0,059 au couchant) est le métier de l'AGC de
// la lentille ; les drones reçoivent `dim`, l'obscurcissement des tuiles.
const sun = { dir: { x: 0.3, y: 0.8, z: 0.5 }, ambient: 0.059, night: 0 };
const DIM = 0.82;

function makeScene() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x8899aa);
	return scene;
}
function makeCamera() {
	const c = new THREE.PerspectiveCamera(120, 1, 0.15, 2500);
	c.quaternion.set(0, 0, 0, 1);
	return c;
}
// L'objet d'arguments est HOISTÉ : le contrôle d'allocation plus bas mesure
// update(), pas le littéral que l'appelant construirait à chaque frame.
function stepper(a, camera, opts) {
	const arg = {
		dt: 0, player, playerVel, camera, wind, rays,
		top: 110, span: 210, fogColor: opts.fogColor, fogDensity: opts.fogDensity, sun,
		dim: opts.dim ?? DIM,
		resolution: opts.resolution,
	};
	return (dt) => { arg.dt = dt; a.update(arg); };
}

console.log('ambient-drones : construction et scan');
{
	const scene = makeScene();
	const a = new AmbientDrones({ scene, bounds });
	check('sans scan : update ne fait rien et ne jette pas',
		(stepper(a, makeCamera(), { fogColor: scene.background, fogDensity: 0, resolution: { w: 800, h: 600 } })(1 / 60), true));
	check('sans scan : debug() vide', JSON.stringify(a.debug()) === '{"count":0}', JSON.stringify(a.debug()));
	a.setScan({ seed: 'drones-a', count: 5, index: 0 });
	check('setScan : un maillage par ambiant', a.meshes.length === 4, `${a.meshes.length}`);
	check('setScan : tous montés dans la scène', scene.children.length === 4, `${scene.children.length}`);
	check('setScan : invisibles tant que personne n\'est né', a.meshes.every((m) => m.group.visible === false));
	check('setScan : strobe distinct par drone',
		new Set(a.meshes.map((m) => m.ledMaterial.uniforms.uPhase.value)).size === 4);
	a.setScan(null);
	check('setScan(null) : la scène est rendue', scene.children.length === 0 && a.meshes.length === 0);
	check('setScan(null) : debug() vide', a.debug().count === 0);
	a.dispose();
}

console.log('\nambient-drones : les uniformes du monde atteignent les drones À NAÎTRE');
{
	// LE piège : `_lastFog`/`_lastRes` sont verrouillés GLOBALEMENT (on n'écrit
	// que sur changement), mais les maillages, eux, naissent un par frame. Si
	// l'écriture était réservée aux vivants, un drone né après le dernier
	// changement de météo volerait sans perspective aérienne et avec une LED
	// calibrée pour la résolution par défaut (1920×1080), pour toujours.
	const scene = makeScene();
	const camera = makeCamera();
	const a = new AmbientDrones({ scene, bounds });
	a.setScan({ seed: 'drones-b', count: 5, index: 0 });
	const res = { w: 2560, h: 1440 };
	const step = stepper(a, camera, { fogColor: scene.background, fogDensity: 0.004, resolution: res });
	step(1 / 60);
	check('une seule naissance à la première frame', a.model.count === 1, `${a.model.count}`);
	const fogOk = a.meshes.every((m) => m.material.uniforms.uFogDensity.value === 0.004
		&& m.ledMaterial.uniforms.uFogDensity.value === 0.004
		&& m.material.uniforms.uFogColor.value.getHex() === 0x8899aa);
	check('brouillard écrit sur les QUATRE maillages, pas seulement le vivant', fogOk,
		a.meshes.map((m) => m.material.uniforms.uFogDensity.value).join(' '));
	const resOk = a.meshes.every((m) => m.ledMaterial.uniforms.uResolution.value.x === 2560
		&& m.ledMaterial.uniforms.uResolution.value.y === 1440);
	check('résolution écrite sur les QUATRE maillages', resOk,
		a.meshes.map((m) => m.ledMaterial.uniforms.uResolution.value.x).join(' '));
	// Et le verrou tient : la météo ne change plus, les trois autres naissent.
	for (let i = 0; i < 6; i++) step(1 / 60);
	check('les quatre sont nés', a.model.count === 4, `${a.model.count}`);
	check('nés APRÈS le dernier changement, ils ont quand même le brouillard',
		a.meshes.every((m) => m.material.uniforms.uFogDensity.value === 0.004));
	check('visibles = vivants', a.meshes.every((m, k) => m.group.visible === (a.model.alive[k] === 1)));
	// uAmbient = `dim` (l'obscurcissement des tuiles), PAS `sun.ambient`
	// (l'exposition absolue, 0,059 au couchant, que l'AGC de la lentille
	// normalise pour tout le reste) : sinon les ambiants sont noirs dès qu'on
	// sort du plein midi.
	check('uAmbient = dim, pas sun.ambient',
		a.meshes.every((m) => m.material.uniforms.uAmbient.value === DIM),
		a.meshes.map((m) => m.material.uniforms.uAmbient.value).join(' '));
	// La LED s'éteint avec la distance : sans ce fondu, le plancher de 3 px
	// fait naître et partir les drones en ALLUMANT une lumière.
	check('LED : fondu de distance calé sur la bulle',
		a.meshes.every((m) => m.ledMaterial.uniforms.uFadeFar.value <= 220
			&& m.ledMaterial.uniforms.uFadeNear.value < m.ledMaterial.uniforms.uFadeFar.value),
		a.meshes.map((m) => `${m.ledMaterial.uniforms.uFadeNear.value}→${m.ledMaterial.uniforms.uFadeFar.value}`).join(' '));
	// Un nouveau scan repart de maillages neufs : les verrous doivent s'invalider.
	a.setScan({ seed: 'drones-c', count: 5, index: 1 });
	check('nouveau scan : maillages neufs sans uniformes du monde',
		a.meshes.every((m) => m.material.uniforms.uFogDensity.value === 0));
	stepper(a, camera, { fogColor: scene.background, fogDensity: 0.004, resolution: res })(1 / 60);
	check('nouveau scan : la première frame les réécrit',
		a.meshes.every((m) => m.material.uniforms.uFogDensity.value === 0.004
			&& m.ledMaterial.uniforms.uResolution.value.x === 2560));
	a.dispose();
}

console.log('\nambient-drones : le silence du lien mort est VERROUILLÉ');
{
	// `AmbientAudio.silence()` ne rampe qu'une fois ; update() revise les gains
	// à chaque frame et `frozen` reste faux pendant que l'épave roule. Sans
	// verrou, le ciel se rallumait à la frame suivante.
	const scene = makeScene();
	const a = new AmbientDrones({ scene, bounds });
	a.setScan({ seed: 'drones-d', count: 5, index: 0 });
	// Espion sur ce que l'instance DONNE au son : le contrat public de
	// AmbientAudio.update(voices) est « voices[i] = descripteur ou null ».
	let last = null;
	a.audio.update = (v) => { last = v.slice(); };
	const step = stepper(a, makeCamera(), { fogColor: scene.background, fogDensity: 0.002, resolution: { w: 1600, h: 900 } });
	for (let i = 0; i < 6; i++) step(1 / 60);
	check('en vol : une voix par drone vivant', last.filter(Boolean).length === a.model.count, `${last.filter(Boolean).length}/${a.model.count}`);
	a.silence();
	step(1 / 60);
	check('silence() : plus aucune voix', last.every((v) => v === null));
	for (let i = 0; i < 30; i++) step(1 / 60);
	check('silence() tient 30 frames plus tard (l\'épave roule)', last.every((v) => v === null));
	check('silence() : les drones restent VISIBLES (c\'est le son qui meurt)',
		a.meshes.some((m) => m.group.visible));
	a.reset();
	for (let i = 0; i < 6; i++) step(1 / 60);
	check('reset() lève le verrou', last.some((v) => v !== null));
	a.silence();
	step(1 / 60);
	a.setScan({ seed: 'drones-e', count: 5, index: 0 });
	a.audio.update = (v) => { last = v.slice(); };
	for (let i = 0; i < 6; i++) step(1 / 60);
	check('setScan() lève le verrou', last.some((v) => v !== null));
	a.dispose();
}

console.log('\nambient-drones : update() n\'alloue pas');
{
	const scene = makeScene();
	const a = new AmbientDrones({ scene, bounds });
	a.setScan({ seed: 'drones-f', count: 5, index: 0 });
	const step = stepper(a, makeCamera(), { fogColor: scene.background, fogDensity: 0.003, resolution: { w: 1920, h: 1080 } });
	for (let i = 0; i < 400; i++) step(1 / 60);
	check('régime établi : les quatre volent', a.model.count === 4, `${a.model.count}`);
	check('positions finies', Array.from(a.model.pos).every(Number.isFinite));
	if (global.gc) {
		global.gc(); global.gc();
		const before = process.memoryUsage().heapUsed;
		const N = 20000;
		for (let i = 0; i < N; i++) step(1 / 60);
		global.gc(); global.gc();
		const bytes = (process.memoryUsage().heapUsed - before) / N;
		// 32 o/frame : très au-dessus du bruit de JIT mesuré (~2,5 o), très en
		// dessous du littéral d'arguments du modèle (~90 o) qu'on a hoisté.
		check('update() ne retient rien sur 20 000 frames', bytes < 32, `${bytes.toFixed(1)} o/frame`);
	} else {
		console.log('  SKIP  contrôle d\'allocation — relancer avec --expose-gc');
	}
	a.dispose();
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
