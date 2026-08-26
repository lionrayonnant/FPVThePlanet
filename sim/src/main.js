import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadManifest, loadChunks, loadCollision, loadSceneList, setScene } from './loader.js';
import { initPhysics, Physics } from './physics.js';
import { FlightController, RATE_PRESETS } from './flightController.js';
import { Input } from './input.js';
import { Hud } from './hud.js';

// The whole colour pipeline is deliberately pass-through: the shader writes the
// JPEG's sRGB byte unchanged and outputColorSpace is linear. Left enabled,
// ColorManagement would convert SKY to linear on construction and that linear
// value would reach an sRGB framebuffer untouched, rendering the sky #587A9A
// instead of #9FB8CC and dragging the fog toward the same dark blue.
THREE.ColorManagement.enabled = false;

const SKY = 0x9fb8cc;
const FOG_DENSITY = 0.00085;
const FIXED_STEP = 1 / 250;
const MAX_STEPS_PER_FRAME = 12;   // give up rather than spiral if a frame stalls
// Measured contact forces: gentle landing ~290N, 10 m/s touchdown ~1600N,
// 25 m/s into a building ~2450N. 1500 lets you land and bump walls, but calls
// slamming into something a crash.
const CRASH_IMPULSE = 1500;

// near matters a lot here: photogrammetry is full of near-coplanar surfaces, and
// at near=0.05 the depth buffer quantises to ~40cm at the far side of the tile,
// which shreds the city into z-fighting shards. 0.15 is both far enough to fix
// that and exactly the drone's collider radius, so nothing can ever get closer
// to the camera without having already collided.
const camera = new THREE.PerspectiveCamera(120, 1, 0.15, 2500);

// Debug switches, e.g. ?mipmaps=0&chunks=1 — for narrowing down driver stalls.
const params = new URLSearchParams(location.search);
export const OPTS = {
	mipmaps: params.get('mipmaps') !== '0',
	anisotropy: params.has('aniso') ? Number(params.get('aniso')) : 8,
	maxChunks: params.has('chunks') ? Number(params.get('chunks')) : Infinity,
	skipCollision: params.get('collision') === '0',
	scene: params.get('scene'),
};
if (params.toString()) console.log('[opts]', OPTS);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// The imagery already carries its own lighting and colour, so nothing should be
// re-encoded on the way to the framebuffer.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const input = new Input();
const hud = new Hud(document.getElementById('ui'), input);
const controller = new FlightController();

let physics = null;
let freeCam = null;
let freeCamOn = false;
let crashed = false;
let cameraFov = 120, cameraTilt = 25;
let accumulator = 0;
let lastTime = performance.now();

function resize() {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

// Stage-by-stage so a long load always shows what it is doing and how long that
// step has taken. Timings are also logged, which is how you find the slow part.
const timeline = [];
function stage(name) {
	const t = performance.now();
	const prev = timeline[timeline.length - 1];
	if (prev) {
		prev.ms = Math.round(t - prev.at);
		console.log(`[load] ${prev.name}: ${prev.ms} ms`);
	}
	timeline.push({ name, at: t });
	hud.setStage(name);
	return t;
}

async function boot() {
	const t0 = performance.now();
	hud.startClock();

	stage('manifest');
	hud.progress('lecture du manifest…', 0.01);
	const manifest = await loadManifest();

	const totalMB = (manifest.chunks.reduce((s, c) => s + c.geoBytes + c.texBytes, 0)
		+ manifest.collision.bytes) / 1e6;
	hud.detail(`${totalMB.toFixed(0)} Mo à charger`);

	stage('rapier-init');
	hud.progress('initialisation de la physique…', 0.02);
	await initPhysics();

	stage('chunks');
	const { meshes, timings } = await loadChunks(manifest,
		{ fogColor: SKY, fogDensity: FOG_DENSITY, maxChunks: OPTS.maxChunks,
		  mipmaps: OPTS.mipmaps, anisotropy: OPTS.anisotropy },
		({ bytes, totalBytes, done, total, decoding }) => {
			hud.progress(`tuiles ${done}/${total}${decoding > 0 ? ` — décodage de ${decoding} planche(s)…` : '…'}`,
				0.02 + 0.45 * (bytes / totalBytes));
			hud.detail(`${(bytes / 1e6).toFixed(0)} / ${(totalBytes / 1e6).toFixed(0)} Mo`);
		});
	for (const m of meshes) scene.add(m);
	console.log('chunk timings (ms):', JSON.stringify(timings));

	stage('collision-download');
	const collision = await loadCollision(manifest, (f, received) => {
		hud.progress('maillage de collision…', 0.47 + 0.28 * f);
		hud.detail(`${(received / 1e6).toFixed(0)} / ${(manifest.collision.bytes / 1e6).toFixed(0)} Mo`);
	});

	stage('collision-build');
	hud.progress('construction de l’arbre de collision…', 0.76);
	hud.detail(`${(manifest.collision.indexCount / 3).toLocaleString()} triangles`);
	await nextPaint();
	physics = new Physics(collision, manifest.spawn);

	// Textures only reach the GPU on first use. Doing it here, one chunk at a
	// time, turns an invisible multi-second freeze into visible progress.
	stage('gpu-upload');
	hud.detail('');
	for (let i = 0; i < meshes.length; i++) {
		hud.progress(`téléversement des textures ${i + 1}/${meshes.length}…`, 0.80 + 0.16 * (i / meshes.length));
		await nextPaint();
		renderer.initTexture(meshes[i].material.uniforms.uMap.value);
	}

	// compileAsync() polls the driver's KHR_parallel_shader_compile status every
	// 10ms and only resolves once it reports ready — on drivers that never flip
	// that flag it waits forever. compile() does the same work synchronously and
	// always returns, so use that instead.
	stage('shader-compile');
	hud.progress('compilation du shader…', 0.95);
	await nextPaint();
	renderer.compile(scene, camera);

	// Draw one frame here so any remaining driver-side work happens behind the
	// loading screen rather than as a frozen first frame.
	// Draw one frame here so any remaining driver-side work happens behind the
	// loading screen rather than as a frozen first frame.
	stage('first-frame');
	hud.progress('premier rendu…', 0.98);
	hud.detail('');
	await nextPaint();
	camera.position.set(manifest.spawn.x, manifest.spawn.y, manifest.spawn.z);
	renderer.render(scene, camera);

	stage('done');
	freeCam = new OrbitControls(camera, renderer.domElement);
	freeCam.enabled = false;
	freeCam.target.set(0, 0, 0);

	hud.setWind((mean, gusts) => physics.setWind(mean, gusts));

	hud.setCamera(cameraFov, cameraTilt, (fov, tilt) => {
		cameraFov = fov; cameraTilt = tilt;
		camera.fov = fov;
		camera.updateProjectionMatrix();
	});

	timeline[timeline.length - 1].ms = Math.round(performance.now() - timeline[timeline.length - 1].at);
	console.table(timeline.map(s => ({ étape: s.name, ms: s.ms })));
	console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);

	window.__sim = {
		physics, controller, camera, renderer, scene, input, timeline,
		// Overrides the sticks; pass null to hand control back.
		setInput: (s) => { window.__simInput = s; },
		// Wind is off by default. setWind({x,y,z} m/s, gustStrength m/s).
		setWind: (mean, gusts) => physics.setWind(mean, gusts),
		teleport(x, y, z) {
			physics.body.setTranslation({ x, y, z }, true);
			physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			crashed = false;
		},
		// Points the camera at a target from the drone's current position.
		lookAt(x, y, z) {
			const p = physics.position;
			camera.position.set(p.x, p.y, p.z);
			camera.lookAt(x, y, z);
			camera.updateMatrixWorld();
			renderer.render(scene, camera);
		},
		debug() {
			const p = physics.position, v = physics.velocity;
			const ground = physics.groundBelow(p.x, p.y, p.z);
			return {
				drawCalls: renderer.info.render.calls,
				triangles: renderer.info.render.triangles,
				programs: renderer.info.programs.length,
				textures: renderer.info.memory.textures,
				geometries: renderer.info.memory.geometries,
				fps: Number(hud.el.fps.textContent.replace(/\D/g, '')) || null,
				position: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
				speed: +Math.hypot(v.x, v.y, v.z).toFixed(2),
				groundBelow: ground === null ? null : +ground.toFixed(2),
				altitudeAGL: ground === null ? null : +(p.y - ground).toFixed(2),
				mode: controller.mode,
				preset: controller.preset,
				motors: [...controller.motors].map((m) => +m.toFixed(3)),
				rpm: physics.propulsion.rpm.map((r) => Math.round(r)),
				battery: {
					volts: +physics.battery.voltage.toFixed(2),
					amps: +physics.battery.current.toFixed(1),
					soc: +physics.battery.soc.toFixed(3),
				},
				propwash: +physics.propulsion.propwash.toFixed(2),
				crashed,
			};
		},
	};
	window.__simInput = null;

	hud.ready();
	lastTime = performance.now();
	renderer.setAnimationLoop(frame);
}

// Yields long enough for the loading screen to actually repaint.
function nextPaint() {
	return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}

input.onAction = (key, event) => {
	if (key === 'r') respawn();
	else if (key === 'p') controller.cyclePreset();
	else if (key === 'm') controller.cycleMode();
	else if (key === 'c') toggleFreeCam();
	else if (key === 'tab') { event.preventDefault(); hud.toggleSettings(); }
	else if (key === 'escape' && hud.settingsOpen) hud.toggleSettings(false);
};

renderer.domElement.addEventListener('click', () => {
	if (!freeCamOn && !hud.settingsOpen) renderer.domElement.requestPointerLock();
});

function respawn() {
	if (!physics) return;
	physics.reset();
	controller.setMode(controller.mode);   // also clears the PID integrators
	input.resetKeyboardThrottle();
	crashed = false;
}

function toggleFreeCam() {
	if (!freeCam) return;
	freeCamOn = !freeCamOn;
	freeCam.enabled = freeCamOn;
	if (freeCamOn) {
		document.exitPointerLock();
		const p = physics.position;
		freeCam.target.set(p.x, p.y, p.z);
		camera.position.set(p.x + 60, p.y + 40, p.z + 60);
		freeCam.update();
	}
}

const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;

	const sticks = window.__simInput ?? input.update(dt);

	if (!freeCamOn) {
		accumulator += dt;
		let steps = 0;
		while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
			const { motors } = controller.update(sticks, physics, FIXED_STEP);
			const impact = physics.step(motors, FIXED_STEP);
			if (impact > CRASH_IMPULSE) crashed = true;
			accumulator -= FIXED_STEP;
			steps++;
		}
		if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

		const p = physics.position;
		const r = physics.rotation;
		camera.position.set(p.x, p.y, p.z);
		_q.set(r.x, r.y, r.z, r.w);
		// Camera uptilt, applied in the drone's own frame.
		_tilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), cameraTilt * Math.PI / 180);
		camera.quaternion.copy(_q).multiply(_tilt);
	} else {
		freeCam.update();
	}

	renderer.render(scene, camera);

	const v = physics.velocity;
	const p = physics.position;
	const ground = physics.groundBelow(p.x, p.y, p.z);
	const bat = physics.battery;
	hud.update({
		altitude: ground === null ? null : p.y - ground,
		speed: Math.hypot(v.x, v.y, v.z),
		throttle: sticks.throttle,
		mode: freeCamOn ? 'caméra libre' : controller.mode,
		preset: RATE_PRESETS[controller.preset].label,
		voltage: bat.voltage,
		soc: bat.soc,
		amps: bat.current,
		propwash: physics.propulsion.propwash,
		crashed,
		usingGamepad: input.usingGamepad,
	});
}

// Picks which prepared map to fly before doing any of the heavy loading work.
// ?scene=<slug> skips the menu (handy for bookmarking/dev), otherwise the
// menu is shown even with a single map so "choose from a menu" always holds.
async function chooseScene() {
	const scenes = await loadSceneList();
	if (scenes.length === 0) throw new Error('aucune carte : lance "npm run add-map" d’abord');

	if (OPTS.scene) {
		if (!scenes.some((s) => s.slug === OPTS.scene)) {
			throw new Error(`carte inconnue: "${OPTS.scene}"`);
		}
		return OPTS.scene;
	}
	return new Promise((resolve) => hud.showMenu(scenes, resolve));
}

chooseScene()
	.then((slug) => {
		setScene(slug);
		return boot();
	})
	.catch((err) => {
		console.error(err);
		hud.fail(err.message);
	});
