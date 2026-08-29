import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadManifest, loadChunks, loadCollision, loadSceneList, setScene, setFog } from './loader.js';
import { initPhysics, Physics } from './physics.js';
import { crashThreshold } from './quad.js';
import { FlightController, RATE_PRESETS } from './flightController.js';
import { PROFILES, FAMILIES } from './drone-profiles.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Settings, loadVolume, loadBrightness, loadLens, loadLink } from './settings.js';
import * as operator from './operator.js';
import { bootstrap } from './bootstrap.js';
import { operatorSelect, runTerminal } from './terminal.js';
import { EngineAudio } from './audio.js';
import { FpvLens, LINK_OFF, LINK_ANALOG, LINK_DIGITAL } from './lens.js';
import { VideoLink } from './link.js';
import { RainField, dropDrift, fogRange } from './rain.js';
import { FogField, extinctionOf } from './fog.js';
import { Rainfall } from './rainfall.js';
import { worldWeather, applyWeather, headline, CALM } from './weather.js';
import * as session from './session.js';
import { runTargetScan } from './target-scan.js';
import { generateTargetScan } from '../tools/target-model.mjs';
import { runHack } from './hack.js';
import { normalizeHackType } from '../tools/hack-model.mjs';

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
// The ground station's antenna, above whatever the pilot is standing on. The
// pilot is at the spawn point, because that is where you took off from.
const ANTENNA_HEIGHT = 1.2;

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
	// ?resume=<sessionId> : ré-ouvre une session LANDED (posé par le terminal).
	resume: params.get('resume'),
	// Dev-only override: ?family=race5 flies that drone family regardless of the
	// TARGET SCAN choice (PHASE 08). One of:
	//   freestyle5 race5 cinewhoop longrange heavy5 toothpick
	family: params.get('family'),
	// Dev-only : ?hack=gnss-spoof prévisualise le motif de ce type de hack
	// avant le vol, sur les chemins qui sautent le TARGET SCAN (?scene=/?family=).
	hack: params.get('hack'),
};
if (OPTS.family && !FAMILIES.includes(OPTS.family)) {
	throw new Error(`famille inconnue: "${OPTS.family}" — ${FAMILIES.join(' ')}`);
}
// Résolu tardivement (PHASE 08) : la famille sort du TARGET SCAN, dans le gate
// de chooseScene(), avant boot(). L'override dev ?family= le pré-remplit ici.
let PROFILE = OPTS.family ? PROFILES[OPTS.family] : undefined;
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
const hud = new Hud(document.getElementById('ui'));
const settings = new Settings(document.getElementById('ui'), input);
// Construit dans le gate de chooseScene(), une fois PROFILE résolu (PHASE 08).
// Aucune ligne avant le gate ne l'utilise à l'exécution.
let controller;
// Inert until start(): no AudioContext exists before the user's first gesture.
const audio = new EngineAudio();
// Everything the render pipeline does beyond renderer.render(). Falls back to a
// plain render when it is switched off, so the clean image stays one click away.
const lens = new FpvLens(renderer, scene);
// The RF side of the same picture: how much of the video link survives the trip
// back to the pilot. Knows nothing about rendering, and nothing about Rapier.
const link = new VideoLink();
// The weather that lands on the camera rather than on the airframe: how hard it
// is falling, how wet the front element is, how far you can see. Pure model,
// same as the two above; rainfall draws it and lens.js refracts through it.
const rain = new RainField(undefined, FOG_DENSITY);
// And the weather that is simply in the way: how far you can see. Owns the
// scene's fog density rather than sharing it — FOG_DENSITY is the clear-air
// floor it starts from and never goes below.
const fog = new FogField(undefined, FOG_DENSITY);
let rainfall = null;
// Le snapshot météo de la zone survolée, pour le HUD et __sim.debug().
let weather = null;

let physics = null;
let emitter = null;
let freeCam = null;
let freeCamOn = false;
let paused = false;
let crashed = false;
// La zone survolée (= slug de scène), l'id d'une session LANDED à reprendre, et
// l'altitude du spawn, pour la session.
let flyArea = null;
let resumeId = null;
let flyTarget = null;
let spawnY = 0;
let cameraFov = 120, cameraTilt = 25;
let accumulator = 0;
let lastTime = performance.now();

function resize() {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
	lens.setSize(innerWidth, innerHeight);
	// Device pixels and the live FOV: the streaks' minimum width is measured in
	// pixels, and a CSS-pixel height would make it the wrong size on a HiDPI
	// display — the same trap uResolution has in lens.js.
	rainfall?.setSize(innerHeight * renderer.getPixelRatio(), camera.fov);
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

	// In the scene, not over it: the streaks go through the RenderPass, so the
	// lens distorts, vignettes, smears and breaks them up like everything else,
	// and the city occludes them.
	rainfall = new Rainfall(scene, { sky: SKY });
	rainfall.setSize(innerHeight * renderer.getPixelRatio(), camera.fov);

	stage('collision-download');
	const collision = await loadCollision(manifest, (f, received) => {
		hud.progress('maillage de collision…', 0.47 + 0.28 * f);
		hud.detail(`${(received / 1e6).toFixed(0)} / ${(manifest.collision.bytes / 1e6).toFixed(0)} Mo`);
	});

	stage('collision-build');
	hud.progress('construction de l’arbre de collision…', 0.76);
	hud.detail(`${(manifest.collision.indexCount / 3).toLocaleString()} triangles`);
	await nextPaint();
	physics = new Physics(collision, manifest.spawn, PROFILE ? { profile: PROFILE } : {});
	audio.setProfile(physics.profile);
	if (OPTS.family) console.log(`[family] ${physics.profile.family} — ${physics.profile.label}`);

	// Where the pilot is standing, plus antenna height. A spawn under a bridge
	// or an arch would put the ground station inside geometry and leave the link
	// dead from the first frame, so look for a ceiling first and stand on top of
	// it if there is one.
	const sp = physics.spawn;
	const ceiling = physics.groundBelow(sp.x, sp.y + 40, sp.z, 40);
	emitter = {
		x: sp.x,
		y: (ceiling !== null && ceiling > sp.y + 2 ? ceiling : sp.y) + ANTENNA_HEIGHT,
		z: sp.z,
	};

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
	// Through the composer, not the renderer: otherwise the lens pass compiles its
	// shader on the first frame of flight instead of behind the loading screen.
	lens.render(camera, 1 / 60);

	stage('done');
	freeCam = new OrbitControls(camera, renderer.domElement);
	freeCam.enabled = false;
	freeCam.target.set(0, 0, 0);

	// La météo du monde, pas un réglage (PHASE 04). Le world state de l'opérateur
	// a déjà décidé du temps qu'il fait sur cette zone aujourd'hui ; on ne fait
	// qu'écrire les paramètres des trois modèles, qui n'ont pas changé.
	// L'origine du manifest est la lat/lon exacte de la scène, donc la même clé
	// de zone que celle vue par le terminal avant le décollage.
	const o = manifest.origin ?? {};
	weather = await worldWeather({ lat: o.latitude, lon: o.longitude });
	const applied = applyWeather(weather, { physics, rain, fog }) ?? CALM;
	if (weather) {
		console.log(`[weather] ${weather.zone} ${weather.day} (${weather.source}) — `
			+ `${headline(weather.days[0])}`, applied);
	} else {
		// Scène sans origine connue : monde neutre plutôt que météo inventée.
		physics.setWeather(CALM.wind);
		rain.setParams(CALM.rain);
		fog.setParams(CALM.fog);
	}

	settings.setAudio(loadVolume(), loadBrightness(), (volume, brightness) => {
		audio.setVolume(volume);
		audio.setBrightness(brightness);
	});

	settings.setLens(loadLens(), (p) => {
		lens.setEnabled(p.on);
		lens.setParams(p);
		lensShutter = p.shutter;
	});

	settings.setLink(loadLink(), (p) => {
		link.setSeverity(p.severity);
		lens.setLink({
			mode: p.severity === 0 ? LINK_OFF
				: p.mode === 'digital' ? LINK_DIGITAL : LINK_ANALOG,
			severity: p.severity,
		});
	});

	settings.setCamera(cameraFov, cameraTilt, (fov, tilt) => {
		cameraFov = fov; cameraTilt = tilt;
		camera.fov = fov;
		camera.updateProjectionMatrix();
		rainfall?.setSize(innerHeight * renderer.getPixelRatio(), fov);
	});

	timeline[timeline.length - 1].ms = Math.round(performance.now() - timeline[timeline.length - 1].at);
	console.table(timeline.map(s => ({ étape: s.name, ms: s.ms })));
	console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);

	window.__sim = {
		physics, controller, camera, renderer, scene, input, timeline, audio, lens, link, rain, fog,
		// Overrides the sticks; pass null to hand control back.
		setInput: (s) => { window.__simInput = s; },
		// Wind is off by default. setWeather({speed, direction, gust, turbulence})
		// with speed in m/s at 10 m and direction in degrees the wind comes from;
		// gustPeak / gustDuration / gustRate can be passed too, for anyone who
		// wants the three gust properties apart rather than on the one slider.
		setWeather: (w) => physics.setWeather(w),
		// The old vector form, kept for console muscle memory.
		setWind: (mean, gusts) => physics.setWind(mean, gusts),
		wind: () => physics.wind,
		// Dry by default. setRain({intensity, variability}), both 0..1;
		// intensity 1 is 25 mm/h, which is a downpour.
		setRain: (r) => rain.setParams(r),
		// Same for the fog: setFog({intensity, variability}), both 0..1.
		// These three are now the ONLY way to change the weather by hand — the
		// sliders are gone (PHASE 04) and the world decides. They exist for
		// debugging and for tuning, not as a hidden settings panel.
		setFog: (f) => fog.setParams(f),
		// What the world said about this zone today, and what it became.
		weather: () => weather,
		// La session de vol en cours (PHASE 06), ou null.
		session: () => session.current(),
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
				wind: {
					speed: +Math.hypot(physics.wind.out.x, physics.wind.out.z).toFixed(2),
					vertical: +physics.wind.out.y.toFixed(2),
					local: +physics.wind.local.toFixed(2),
					agl: +physics.wind.agl.toFixed(1),
					shelter: +physics.wind.shelter.toFixed(2),
					channel: +physics.wind.channel.toFixed(2),
					updraft: +physics.wind.updraft.toFixed(2),
					roughness: +physics.wind.roughness.toFixed(2),
					intensity: +physics.wind.intensity.toFixed(3),
				},
				family: physics.profile.family,
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
				rain: {
					mmPerHour: +rain.mmPerHour.toFixed(2),
					wetness: +rain.wetness.toFixed(3),
					dropMm: +rain.dropDiameter.toFixed(2),
					fallSpeed: +rain.fallSpeed.toFixed(2),
					// How many streaks are actually being drawn, against how many
					// the concentration asks for: the gap is the cap in
					// rainfall.js, and it is worth being able to see it.
					streaks: rainfall ? rainfall.drops : 0,
					perM3: Math.round(rain.dropsPerM3),
					// Water on the lens: how many beads the field looks through,
					// how wide they are, and which way they are being pushed.
					lensDrops: lens.dropCount,
					beadMm: +lens.beadMm.toFixed(2),
					drift: { x: +drift.x.toFixed(2), y: +drift.y.toFixed(2) },
					visibility: Math.round(Math.min(rain.visibility, 1e6)),
				},
				world: weather && {
					zone: weather.zone,
					day: weather.day,
					source: weather.source,
					regime: weather.days[0].regime,
					confidence: +weather.days[0].confidence.toFixed(2),
				},
				fog: {
					// The range the air alone gives you, the range once the rain is
					// in it too, and how much of that is coming back as veil.
					range: Math.round(fog.range),
					rangeWithRain: Math.round(fogRange(fog.density + extinctionOf(rain.visibility))),
					density: +(fog.density).toFixed(6),
					glare: +fog.glare.toFixed(3),
				},
				link: {
					quality: +link.out.quality.toFixed(3),
					rssiDbm: +link.out.rssiDbm.toFixed(1),
					lossDb: +link.out.lossDb.toFixed(1),
					distance: +linkState.distance.toFixed(1),
					blocked: linkState.blocked,
					span: +linkState.span.toFixed(1),
					// Whether the last frame was held rather than rendered. When it
					// was, the renderer.info counters above describe the lens pass
					// alone — there was no scene render to count.
					frozen: lens.frozen,
					rayMs: +linkState.rayMs.toFixed(3),
				},
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
	else if (key === 'disarm') doDisarm();
	else if (key === ' ') { event.preventDefault(); togglePause(); }
	else if (key === 'p') controller?.cyclePreset();
	else if (key === 'm') controller?.cycleMode();
	else if (key === 'c') toggleFreeCam();
	else if (key === 'tab') { event.preventDefault(); settings.toggleSettings(); }
	else if (key === 'escape' && settings.settingsOpen) settings.toggleSettings(false);
};

renderer.domElement.addEventListener('click', () => {
	// Safety net for ?scene=<slug>, which skips the menu and therefore skips the
	// only other user gesture we get. start() is idempotent.
	audio.start();
	if (!freeCamOn && !settings.settingsOpen) renderer.domElement.requestPointerLock();
});

// Désarmement Betaflight (PHASE 06). Au sol et à l'arrêt → pose propre → LANDED,
// le drone est conservé, la session ré-ouvrable. En l'air → la chute suit son
// cours et c'est l'impact qui fermera la session en CRASHED.
function doDisarm() {
	if (!physics || !controller.armed) return;
	controller.disarm();
	const p = physics.position;
	const g = physics.groundBelow(p.x, p.y, p.z);
	const v = physics.velocity;
	// Au sol = à portée de contact du sol, pas « parfaitement immobile » : une
	// pose sur une sphère de collision est toujours un peu vivante. On rejette
	// seulement un désarmement franchement en l'air (→ chute → CRASHED).
	const height = g === null ? Infinity : p.y - g;
	// Large : une pose par grand vent sur une sphère de collision n'est jamais
	// parfaitement calme. On ne rejette qu'un désarmement franchement en l'air.
	const onGround = height < 2 && Math.hypot(v.x, v.y, v.z) < 8;
	console.log(`[session] désarmement — sol:${onGround} (h=${height === Infinity ? '?' : height.toFixed(2)}m v=${Math.hypot(v.x, v.y, v.z).toFixed(2)}m/s)`);
	if (onGround) {
		// Le drone est posé : on le fige, il ne roule pas et ne dérive pas.
		physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		hud.setSessionStatus('TARGET STATUS<small>LANDED</small>', 'landed');
		session.end('LANDED').then((s) => s && console.log('[session] LANDED', s));
	} else {
		// Désarmé en l'air : moteurs coupés, la chute suivra son cours et
		// l'impact fermera la session en CRASHED.
		hud.setSessionStatus('DISARMED<small>en chute libre</small>', 'lost');
	}
}

function respawn() {
	if (!physics) return;
	// terrain persistent, flights ephemeral : après un crash le drone a disparu,
	// on ne réapparaît pas en place — retour au terminal. En mode ?scene= (dev)
	// on garde le respawn local pour ne pas casser le flow de debug.
	if (crashed && !OPTS.scene) { location.href = location.pathname; return; }
	hud.setSessionStatus(null);
	controller.arm();
	physics.reset();
	link.reset();
	// Neither model was being reset here, and both say in their own comments
	// that they should be: a respawn should not drop you back into the squall
	// or the bank that just blinded you.
	rain.reset();
	fog.reset();
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

function togglePause(force) {
	paused = force ?? !paused;
	// Coming back should not replay the wall-clock gap as one giant physics step.
	if (!paused) { accumulator = 0; lastTime = performance.now(); }
	hud.setPaused(paused);
}

// Physics does not advance when the free camera is on, the sim is paused, or the
// settings panel is up — so the motor speeds freeze and a held drone note would
// be worse than silence.
// Heading of the nose about +Y, for the HUD's relative wind arrow. Only the yaw
// matters here: the arrow answers "which side is it pushing me from", and that
// question does not change when the quad is banked.
function yawOf(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

function simFrozen() { return freeCamOn || paused || settings.settingsOpen; }

const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
// The fog uniforms live on every chunk material, so they are written only when
// they have actually moved rather than five times a frame for no change. Both
// halves are watched: the fog can thicken without the sky changing colour once
// the mix has saturated, and the rain can recolour the sky at a density the
// fog has already settled on.
let lastDensity = -1;
let lastSkyHex = -1;
// The lens exposure, mirrored here because the streak length is that exposure
// times the relative speed — the translational half of the motion blur that the
// lens pass, which only reprojects rotation, cannot reconstruct.
let lensShutter = 0;

// Weather does not only take contrast away, it takes the blue out of the sky.
// Rain darkens it: the light is coming through cloud and water rather than
// through air. Fog does the opposite — it is bright, and it is neutral, because
// what you are looking at is the scattered light itself.
//
// The two are applied in that order, rain then fog, so that thick fog wins: at
// fifty metres of visibility the sky is the fog and nothing else. Interpolated
// on the raw bytes, because the whole colour pipeline is pass-through and a
// linear round trip here would land the sky back on HANDOFF bug #10.
const CLEAR_SKY = new THREE.Color(SKY);
const RAIN_SKY = new THREE.Color(0x8d99a2);
const FOG_SKY = new THREE.Color(0xc9d0d4);
const _sky = new THREE.Color();
function weatherSky(rainScale, fogMix) {
	// rainScale is 1 in the clear and about 2 in a downpour.
	return _sky.copy(CLEAR_SKY)
		.lerp(RAIN_SKY, Math.min(1, (rainScale - 1) * 1.2))
		.lerp(FOG_SKY, fogMix);
}
// Where a bead sitting on the front element is being pushed, in g and in the
// plane of the lens. Written once a frame into the same object rather than
// allocated, like every other per-frame vector here.
const drift = { x: 0, y: 0 };

// What the last link measurement cost and what it found, for __sim.debug().
const linkState = { distance: 0, blocked: false, span: 0, rayMs: 0 };

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;

	const sticks = window.__simInput ?? input.update(dt);

	const frozen = simFrozen();
	audio.setMuted(frozen);

	let peakImpact = 0;
	if (!frozen) {
		// Touchdown : en airmode un quad ne se pose pas tout seul — les moteurs
		// tournent au ralenti, la moindre inclinaison au contact le renvoie en
		// l'air, et une sphère de collision qui a de la vitesse angulaire roule
		// sans fin (pas de glissement au point de contact → la friction ne la
		// freine pas). Le vent, lui, continue de le pousser. Quand le pilote a
		// coupé les gaz et que le drone est au ras du sol, on coupe les moteurs
		// et physics.setGroundHold fige le reste : plus de vent, plus de dérive.
		const pp = physics.position;
		const gb = physics.groundBelow(pp.x, pp.y, pp.z);
		const touchdown = controller.armed && sticks.throttle < 0.06
			&& gb !== null && (pp.y - gb) < 0.6;
		physics.setGroundHold(touchdown);

		accumulator += dt;
		let steps = 0;
		while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
			const { motors } = controller.update(sticks, physics, FIXED_STEP);
			if (touchdown) motors.fill(0);
			const impact = physics.step(motors, FIXED_STEP);
			// Un drone qui arrive à plat encaisse : les bras fléchissent, les
			// hélices absorbent. Nez en avant ou sur le dos, il casse. Le seuil
			// de crash suit donc l'assiette au moment du choc.
			if (impact > 0 && !crashed) {
				if (impact > crashThreshold(physics.rotation)) {
					crashed = true;
					// Le drone est détruit. La session se ferme sur CRASHED — le
					// terrain, lui, reste. terrain persistent, flights ephemeral.
					hud.setSessionStatus('TARGET LOST<small>SESSION TERMINATED</small>', 'lost');
					session.end('CRASHED').then((s) => s && console.log('[session] CRASHED', s));
				}
			}
			if (impact > peakImpact) peakImpact = impact;
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
	} else if (freeCamOn) {
		freeCam.update();
	}

	// The weather on the camera. Advanced on the frame clock rather than the
	// physics step because nothing in it feeds back into the flight model — the
	// water is on the lens, not on the airframe — and because the streaks and
	// the drops are drawn once per frame whatever the physics did.
	if (!frozen) {
		rain.update(physics.airspeed, dt);
		fog.update(dt);
		// Extinctions add, so densities add. This is a strict generalisation of
		// the rain-only version it replaces: FOG_DENSITY * rain.fogScale is by
		// definition FOG_DENSITY + the rain's own extinction, so with the fog
		// slider at zero the picture is the one #24 left behind, to the bit.
		const density = fog.density + extinctionOf(rain.visibility);
		const sky = weatherSky(rain.fogScale, fog.skyMix);
		const skyHex = sky.getHex();
		if (density !== lastDensity || skyHex !== lastSkyHex) {
			lastDensity = density;
			lastSkyHex = skyHex;
			setFog(sky, density);
			// Mutated, not replaced: lens.js reads this very object every frame.
			scene.background.set(sky);
			// The streaks are lit by the sky too, and used to keep the clear-sky
			// colour whatever the weather did.
			rainfall?.setSky(scene.background);
		}
		// Light the air scatters into the barrel rather than onto the subject.
		// Zero compiles it out of the lens shader entirely.
		lens.setGlare(fog.glare);
	}
	// Zero dt while the sim is frozen, which is all it takes to stop the rain
	// dead on a picture that is not moving.
	rainfall.update({
		rain, wind: physics.wind.out, velocity: physics.velocity,
		shutter: lensShutter, dt: frozen ? 0 : dt, camera,
	});

	// And the water that landed on the glass rather than falling past it. Where
	// a bead on the lens runs is not "down the screen": it is the apparent
	// gravity — exactly minus the propulsion over the mass, since real gravity
	// and the pseudo-force cancel — plus the airflow over the glass, which wins
	// above about 6 m/s and sends the water *up* the frame. rain.js:dropDrift
	// does that; here it is only handed the drone's own state.
	dropDrift(physics.airVelocity, physics.propulsion.force, physics.profile.mass,
		cameraTilt * Math.PI / 180, drift);
	lens.setRain({
		wetness: rain.wetness,
		dropMm: rain.dropDiameter,
		drift,
		dt: frozen ? 0 : dt,
		// The sky the scene is actually using this frame, rain included: a bead
		// is a diffuser, and most of what it diffuses is that.
		sky: scene.background,
	});

	// Before the render, not after: the picture this frame draws is the picture
	// the link delivered this frame.
	const p = physics.position;
	const t0 = performance.now();
	const shadow = physics.obstructionBetween(emitter.x, emitter.y, emitter.z, p.x, p.y, p.z);
	linkState.rayMs = performance.now() - t0;
	linkState.distance = Math.hypot(p.x - emitter.x, p.y - emitter.y, p.z - emitter.z);
	linkState.blocked = shadow.blocked;
	linkState.span = shadow.span;
	link.update({ distance: linkState.distance, blocked: shadow.blocked, span: shadow.span, dt });

	// Free camera is not looking down the drone's video feed, so it gets a clean
	// picture — same reasoning as muting the motors there. The model keeps
	// running, so coming back does not start from a stale RSSI.
	lens.render(camera, dt, freeCamOn ? null : link.out);

	const v = physics.velocity;
	const ground = physics.groundBelow(p.x, p.y, p.z);
	const bat = physics.battery;

	// Télémétrie agrégée de la session (PHASE 06) : des maxima et des cumuls,
	// pas un enregistrement image par image. dt=0 quand la sim est gelée, pour
	// ne pas gonfler la durée pendant une pause.
	const av = physics.angularVelocity;
	session.feed({
		speed: Math.hypot(v.x, v.y, v.z),
		horizontalSpeed: Math.hypot(v.x, v.z),
		rateDps: Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) * 180 / Math.PI,
		altitudeAboveSpawn: p.y - spawnY,
		dt: frozen ? 0 : dt,
		armed: controller.armed,
	});

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
		link: link.out,
		wind: physics.wind.out,
		heading: yawOf(physics.rotation),
		crashed,
		usingGamepad: input.usingGamepad,
	});
	settings.updateAxisBars();

	// Once per frame, not per physics step: 250 Hz of AudioParam writes would be
	// wasted work, and setTargetAtTime interpolates between frames anyway.
	if (!frozen) {
		const prop = physics.propulsion;
		audio.update({
			omega: prop.omega,
			thrust: prop.thrust,
			airspeed: physics.airspeed,
			propwash: prop.propwash,
		});
		if (peakImpact > 0) audio.playImpact(peakImpact);
	}
}

// Picks which prepared map to fly before doing any of the heavy loading work.
// ?scene=<slug> skips the menu (handy for bookmarking/dev), otherwise the
// menu is shown even with a single map so "choose from a menu" always holds.
// Résout l'opérateur (bootstrapping au premier lancement), pose l'opérateur sur
// la Home, puis rend la main au choix de carte existant. ?scene=<slug> saute
// Home ET menu mais garde un opérateur en mémoire pour operator.getOperator().
// Nombre de signaux du TARGET SCAN, cohérent avec la densité affichée par le
// Global Scanner (PHASE 03/05). Le terrain acquis porte { level, range } ;
// on mappe le level normalisé (0..1, log) sur 2..5, la même échelle que le
// Global Scanner. Terrain sans densité (cache ancien, terrain local) → 4.
function signalCountFor(slug) {
	const t = operator.getOperator()?.terrainCache?.find((e) => e.slug === slug);
	const lvl = t?.signalDensity?.level;
	if (!Number.isFinite(lvl)) return 4;              // terrain sans densité (cache ancien, terrain local)
	return 2 + Math.round(Math.max(0, Math.min(1, lvl)) * 3);   // 2..5, échelle du Global Scanner
}

async function chooseScene() {
	const ui = document.getElementById('ui');

	if (OPTS.scene) {
		await operator.ensureDevOperator();
		const scenes = await loadSceneList();
		if (!scenes.some((s) => s.slug === OPTS.scene)) throw new Error(`carte inconnue: "${OPTS.scene}"`);
		const previewHack = normalizeHackType(OPTS.hack);
		if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
		return { slug: OPTS.scene, resume: OPTS.resume || undefined, target: undefined, family: OPTS.family || undefined };
	}

	const { needsBootstrap, choices } = await operator.loadOperator();
	if (needsBootstrap) {
		await bootstrap(ui);
	} else if (choices) {
		const pick = await operatorSelect(ui, choices);
		if (pick.create) await bootstrap(ui);
		else await operator.selectOperator(pick.id);
	}

	// The Operator Terminal replaces the old map menu: it resolves the slug to fly.
	const flyChoice = await runTerminal(ui, { settings });
	const { slug, resume } = flyChoice;

	if (resume) {
		// terrain persistent, flights ephemeral : une session LANDED rejoue SA
		// cible (le serveur la relit du disque). On récupère juste la famille pour
		// le PROFILE de vol.
		const prev = operator.getOperator()?.sessions?.find((s) => s.id === resume);
		return { slug, resume, target: undefined, family: prev?.target?.family ?? OPTS.family ?? undefined };
	}

	// Override dev ?family= : court-circuite le TARGET SCAN.
	if (OPTS.family) {
		const previewHack = normalizeHackType(OPTS.hack);
		if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
		return { slug, resume: undefined, target: undefined, family: OPTS.family };
	}

	// Session fraîche → TARGET SCAN, puis AUTOMATED ANALYSIS pendant que la carte
	// charge en tâche de fond : au [ JACK IN ] le contrôle est immédiat.
	const seed = Math.random().toString(16).slice(2, 12);
	const count = signalCountFor(slug);
	const scan = generateTargetScan({ seed, count });
	// La météo du monde pour cette zone, résolue avant le scan pour rendre les
	// conditions saillantes au choix de cible (issue #76). worldWeather est caché
	// par zone : boot() réutilise ce résultat sans nouvel aller-retour.
	const sc = (await loadSceneList()).find((s) => s.slug === slug);
	const scanWeather = sc ? await worldWeather({ lat: sc.lat, lon: sc.lon }) : null;
	const choice = await runTargetScan(ui, { seed, count, weather: scanWeather }); // { seed, count, index }
	const cand = scan.candidates[choice.index];

	audio.start();
	flyArea = slug;
	flyTarget = choice;
	PROFILE = PROFILES[cand._family];
	controller = new FlightController({ profile: PROFILE });
	console.log(`[target] family ${PROFILE.family} — ${PROFILE.label}`);
	setScene(slug);
	const booting = boot();
	await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting });
	return { prepared: true };
}

// ?scene= saute Home et menu : aucun geste utilisateur n'a lieu avant boot().
// L'AudioContext exige un geste — on l'attrape au premier input.
if (OPTS.scene) {
	const kick = () => { audio.start(); };
	window.addEventListener('pointerdown', kick, { once: true });
	window.addEventListener('keydown', kick, { once: true });
}

chooseScene()
	.then((choice) => {
		// Still inside the menu button's click, which is the user gesture the
		// browser's autoplay policy demands before an AudioContext will run.
		audio.start();
		// Session fraîche : PROFILE / controller / setScene / boot() ont déjà été
		// lancés dans chooseScene() et le hack a couvert le chargement.
		if (choice.prepared) return;
		hud.show();
		const { slug, resume, target, family } = choice;
		flyArea = slug;
		resumeId = resume || null;
		flyTarget = target || null;
		// Garde l'override ?family= si le scan/resume n'a pas donné de famille.
		PROFILE = family ? PROFILES[family] : PROFILE;
		controller = new FlightController(PROFILE ? { profile: PROFILE } : undefined);
		if (PROFILE) console.log(`[target] family ${PROFILE.family} — ${PROFILE.label}`);
		setScene(slug);
		return boot();
	})
	.then(openFlightSession)
	.catch((err) => {
		console.error(err);
		hud.show();
		hud.fail(err.message);
	});

// Ouvre la session dès que la première image de vol est prête (PHASE 06). La
// météo est déjà résolue par boot(). Une ouverture qui échoue ne bloque pas le
// vol — la session est du décor, pas une dépendance du moteur.
async function openFlightSession() {
	spawnY = physics.position.y;
	try {
		await session.open({
			area: flyArea,
			weatherSnapshot: session.snapshotWeather(weather),
			resume: resumeId || OPTS.resume || undefined,
			target: flyTarget || undefined,
		});
		// La cible résolue (scan frais ou relue du disque au resume) arme le lien
		// vidéo avec le RSSI du signal adverse.
		const tgt = session.current()?.target;
		if (tgt?.family && PROFILE && tgt.family !== PROFILE.family) {
			console.warn(`[target] famille serveur ${tgt.family} ≠ profil client ${PROFILE.family} — skew de version ?`);
		}
		if (tgt?.signal) {
			link.setSignal({ rssiDbm: tgt.signal.rssiDbm });
			console.log(`[link] target signal ${tgt.signal.rssiDbm} dBm (${tgt.signal.mode})`);
		}
	} catch (e) {
		console.warn('[session] ouverture échouée, ce vol ne sera pas enregistré', e);
	}
}

// Onglet fermé en plein vol : best-effort pour matérialiser le CRASHED. Si ça
// rate (vrai crash navigateur), la réconciliation serveur s'en charge au
// prochain chargement du terminal.
window.addEventListener('beforeunload', () => {
	if (session.current()?.result === 'PENDING') session.beacon('CRASHED');
});
