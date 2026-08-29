import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadManifest, loadChunks, loadCollision, loadSceneList, setScene, setFog, setDim } from './loader.js';
import { initPhysics, Physics } from './physics.js';
import { crashThreshold, idleThrottle } from './quad.js';
import { generateEntryState } from './entry-state.js';
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
import { SunField, SKY_REF } from './sun.js';
import { Rainfall } from './rainfall.js';
import { CloudField } from './cloud.js';
import { SkyDome, CLEAR_HORIZON as SKY } from './sky.js';
import { worldWeather, applyWeather, headline, CALM } from './weather.js';
import * as session from './session.js';
import { runTargetScan } from './target-scan.js';
import { generateTargetScan } from '../tools/target-model.mjs';
import { runHack } from './hack.js';
import { normalizeHackType } from '../tools/hack-model.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { droneOsdLayout } from '../tools/drone-osd-model.mjs';
import { DroneOsd } from './drone-osd.js';
import { FpvtpOsd } from './fpvtp-osd.js';
import { FlightEnd, LANDING } from './flight-end.js';
import { runPostFlightAnalysis } from './post-flight.js';

// The whole colour pipeline is deliberately pass-through: the shader writes the
// JPEG's sRGB byte unchanged and outputColorSpace is linear. Left enabled,
// ColorManagement would convert SKY to linear on construction and that linear
// value would reach an sRGB framebuffer untouched, rendering the sky #587A9A
// instead of #9FB8CC and dragging the fog toward the same dark blue.
THREE.ColorManagement.enabled = false;

// SKY = sky.js's CLEAR_HORIZON, re-exported under its historical name: one
// definition of 0x9fb8cc instead of two.
// sun.js:skyColor() calibrates itself against SKY_REF so that a high sun,
// clear air and no cloud reproduce this exact value — importing it here
// (rather than repeating the literal) is what keeps that calibration honest:
// if this ever changes, sun.js's own bench check would start failing loudly
// instead of comparing itself to a stale copy of itself.
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
// Le dôme. scene.background reste posé au-dessus : il n'est plus jamais vu —
// le dôme couvre l'écran — mais il porte désormais la couleur d'HORIZON, que
// rainfall.js, lens.js et les tuiles lisent tous. Une seule couleur d'air.
const skyDome = new SkyDome(scene);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// The imagery already carries its own lighting and colour, so nothing should be
// re-encoded on the way to the framebuffer.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const input = new Input();
const hud = new Hud(document.getElementById('ui'));
// Les deux couches du HUD (PHASE 12). Celle de la station existe dès le départ
// et ne dépend d'aucune cible ; celle du drone appartient à la machine pilotée,
// donc elle naît à l'ouverture de session, avec sa fiche caméra.
const fpvtpOsd = new FpvtpOsd(document.getElementById('ui'));
let droneOsd = null;
let camSpec = null;
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
// Et le ciel au-dessus : quelle fraction est couverte, à quelle hauteur, et de
// combien le sol s'assombrit. Le monde le décide (#41), pas un réglage.
const cloud = new CloudField();
// Et la lumière : où est le soleil, ce que l'atmosphère lui fait, et ce que la
// caméra en fait. Construit dans boot(), une fois le manifest lu — il lui faut
// la lat/lon de la scène, et sans elle il n'existe pas plutôt que d'inventer un
// soleil. Modèle pur : il ne ré-éclaire RIEN, l'imagerie reste non éclairée.
let sun = null;
let rainfall = null;
// Le snapshot météo de la zone survolée, pour le HUD et __sim.debug().
let weather = null;

let physics = null;
// Le manifeste de la scène, hissé de boot() : l'OSD drone en tire la lat/lon.
let sceneManifest = null;
let emitter = null;
let freeCam = null;
let freeCamOn = false;
let paused = false;
// Le hack + le rituel (vector code, demo scene) tournent devant un monde déjà
// chargé et physiquement actif (#22) : sans ce gel, le drone tombe pendant que
// le joueur regarde encore l'écran d'analyse, avant d'avoir touché les sticks.
let introFrozen = false;
let crashed = false;

// Garde le [ESC] DISCONNECT (PHASE 15) idempotent : exitArmed reste vrai une
// fois posé, une touche maintenue ou un second événement ne doit pas ouvrir
// deux fois le POST-FLIGHT ANALYSIS ni déclencher deux reloads.
let exiting = false;

// PHASE 16 : levé par la touche capture, consommé une fois par frame juste
// après lens.render() — c'est cette frame-là, déjà rendue, que lens.capture()
// redessine à la résolution du capteur cible. L'OSD FPVTP! (overlay DOM
// séparé, jamais dans le canvas) n'y figure jamais.
let pendingCapture = false;

// `landing` est une copie privée de LANDING (pas la constante partagée) : son
// THR_IDLE est réécrit par boot() une fois la famille de l'appareil connue
// (idleThrottle, src/quad.js) — muter la constante exportée contaminerait les
// bancs headless qui importent LANDING pour leurs propres seuils de référence.
const flightEnd = new FlightEnd({ landing: { ...LANDING } });

// Le lien vu par lens.js quand la machine est morte : quality 0 et frozen sont
// exactement ce que le shader interprète déjà comme « plus rien n'arrive ».
// Aucun code d'image nouveau, seulement le mode de dégradation le plus profond.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };
let linkForced = false;

// Le mode choisi par le joueur dans les réglages du lien, mémorisé pour que la
// séquence de crash puisse forcer une dégradation même s'il a coupé le modèle.
let lensLinkMode = LINK_OFF;

// Le sol sous le drone, un seul raycast Rapier par frame — physics.groundBelow
// est un test plein maillage, pas quelque chose à refaire deux fois pour la
// même position. Recalculé uniquement quand la physique avance ; le gel (pause,
// caméra libre, réglages) laisse le drone immobile, donc la dernière valeur
// reste correcte tant que rien n'a bougé.
let groundY = null;
// La zone survolée (= slug de scène), l'id d'une session LANDED à reprendre, et
// l'altitude du spawn, pour la session.
let flyArea = null;
let resumeId = null;
let flyTarget = null;
let spawnY = 0;
// Le point de départ complet, pas seulement son altitude : l'OSD drone affiche
// une distance au point de décollage, donc il lui faut les trois coordonnées.
let spawnX = 0;
let spawnZ = 0;
// L'horloge de vol, en horloge murale : elle continue de tourner pendant une
// pause, comme sur du vrai matériel. Amorcée au chargement pour que les
// premières images, avant l'ouverture de session, n'affichent pas 1970.
let sessionStartedAt = Date.now();
let cameraFov = 120, cameraTilt = 25;
let accumulator = 0;
let lastTime = performance.now();

function resize() {
	// Le format vient de la caméra de la cible dès qu'on en a une : la cible du
	// composer est dimensionnée au capteur, donc une scène rendue au format de
	// la fenêtre y serait étirée, en plus des bandes noires.
	camera.aspect = camSpec ? camSpec.aspect : innerWidth / innerHeight;
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

// La caméra de la cible : appliquée une fois, au moment où l'on prend la main.
// Elle touche le champ, l'inclinaison, le format, la définition et le capteur —
// et rien d'autre : le vol n'en dépend pas.
function applyTargetCamera(spec) {
	camSpec = spec;
	cameraFov = spec.fovDeg;
	cameraTilt = spec.uptiltDeg;
	camera.fov = spec.fovDeg;
	camera.aspect = spec.aspect;
	camera.updateProjectionMatrix();
	lens.setCamera({ aspect: spec.aspect, resScale: spec.resScale });
	lens.setSensor(spec.sensor);
	rainfall?.setSize(innerHeight * renderer.getPixelRatio(), spec.fovDeg);
	settings.setCameraSpec(spec);
}

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

// The network-bound, family-independent half of boot(): manifest, physics
// WASM, geometry/texture chunks, collision mesh. Nothing here reads PROFILE,
// so it can start the moment a scene's slug is known — well before a target
// (and its family) has been picked — and run underneath TARGET SCAN and the
// hack ritual instead of underneath its own loading screen (PHASE 13).
async function preloadScene() {
	const t0 = performance.now();
	hud.startClock();

	stage('manifest');
	hud.progress('lecture du manifest…', 0.01);
	const manifest = await loadManifest();
	sceneManifest = manifest;

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

	return { manifest, meshes, collision, t0 };
}

// The rest of boot(): needs PROFILE (the target's family, resolved by TARGET
// SCAN) to build the right airframe, but everything in here is local compute
// — no network — so it stays cheap enough to hide behind the hack/ritual
// hold that already follows TARGET SCAN. Takes preloadScene()'s return value
// (or its promise — awaited here, not by the caller) so the two stages chain
// without the caller needing to know boot() is split in two.
async function finishBoot(preloading) {
	const { manifest, meshes, collision, t0 } = await preloading;

	stage('collision-build');
	hud.progress('construction de l’arbre de collision…', 0.76);
	hud.detail(`${(manifest.collision.indexCount / 3).toLocaleString()} triangles`);
	await nextPaint();
	physics = new Physics(collision, manifest.spawn, PROFILE ? { profile: PROFILE } : {});
	// Sur les chemins sans cible (?scene=, mode dev sans ?family=), PROFILE n'a
	// jamais été résolu et Physics est retombé sur son profil par défaut. Les
	// deux couches d'OSD lisent la batterie et la masse du profil à chaque
	// image : on adopte ici celui qui vole réellement, une fois pour toutes.
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	// La famille pilote le manche de gaz coupés (issue pose trop dure, PHASE 14) :
	// un appareil qui ne peut déjà plus tenir la moitié de son poids à ce manche
	// n'est pas en train de voler. Repris ici (pas dans flight-end.js, qui reste
	// pur) chaque fois que boot() fixe l'appareil pour la session.
	flightEnd.landing.THR_IDLE = idleThrottle(physics.profile);
	if (OPTS.family) console.log(`[family] ${physics.profile.family} — ${physics.profile.label}`);
	physics.applyEntryState(generateEntryState({
		physics,
		manifest,
		seed: Math.random().toString(16).slice(2, 12),
	}));

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
	camera.position.set(physics.position.x, physics.position.y, physics.position.z);
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
	// La lat/lon exacte de la scène : la même qui sert de clé de zone à la
	// météo, et la seule chose dont la position du soleil a besoin en plus de
	// l'instant. Aucun fuseau horaire n'entre ici — la position du soleil est
	// fonction de l'instant UTC et du lieu, point.
	sun = SunField.forOrigin(o);
	weather = await worldWeather({ lat: o.latitude, lon: o.longitude });
	const applied = applyWeather(weather, { physics, rain, fog, cloud, sun }) ?? CALM;
	if (weather) {
		console.log(`[weather] ${weather.zone} ${weather.day} (${weather.source}) — `
			+ `${headline(weather.days[0])}`, applied);
	} else {
		// Scène sans origine connue : monde neutre plutôt que météo inventée.
		physics.setWeather(CALM.wind);
		rain.setParams(CALM.rain);
		fog.setParams(CALM.fog);
		cloud.setParams(CALM.cloud);
		sun?.setWeather(CALM.sun);
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
		// Mémorisé : la séquence de crash doit pouvoir forcer une dégradation
		// même si le joueur a coupé la modélisation du lien.
		lensLinkMode = p.severity === 0 ? LINK_OFF
			: p.mode === 'digital' ? LINK_DIGITAL : LINK_ANALOG;
		lens.setLink({ mode: lensLinkMode, severity: p.severity });
	});


	timeline[timeline.length - 1].ms = Math.round(performance.now() - timeline[timeline.length - 1].at);
	console.table(timeline.map(s => ({ étape: s.name, ms: s.ms })));
	console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);

	window.__sim = {
		physics, controller, camera, renderer, scene, input, timeline, audio, lens, link, rain, fog, cloud, sun,
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
			flightEnd.reset();
			// Sinon un second crash dans la même page ne re-forcerait pas la
			// dégradation du lien : setLink(true) ne s'exécute qu'un coup par vol.
			linkForced = false;
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
				fps: fpvtpOsd.fps || null,
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
					// La densité réellement poussée au shader inclut aussi le
					// plafond (cf. cloud.extinctionAt dans frame()) : l'ajouter ici
					// pour que la portée affichée corresponde à ce que l'image
					// montre une fois qu'on approche le plafond. p et spawnY sont
					// déjà en main plus haut, pas besoin d'un nouveau raycast.
					rangeWithRain: Math.round(fogRange(fog.density + extinctionOf(rain.visibility) + cloud.extinctionAt(p.y - spawnY))),
					density: +(fog.density).toFixed(6),
					glare: +fog.glare.toFixed(3),
				},
				cloud: {
					cloudCover: +cloud.cover.toFixed(3),
					cloudBase: Math.round(cloud.base),
					// Négatif tant qu'on est sous le plafond, positif une fois dedans
					// ou au-dessus. C'est le chiffre qu'on regarde quand on vérifie
					// qu'un whiteout arrive au bon moment.
					ceilingAGL: Math.round((physics.position.y - spawnY) - cloud.base),
				},
				// Ce qui permet de vérifier le soleil dans le vrai navigateur
				// plutôt que de regarder une capture et d'y croire.
				sun: sun && {
					elevation: +sun.elevation.toFixed(2),
					azimuth: +sun.azimuth.toFixed(2),
					dir: { x: +sun.dir.x.toFixed(3), y: +sun.dir.y.toFixed(3), z: +sun.dir.z.toFixed(3) },
					amount: +sun.sunAmount.toFixed(3),
					visible: +sunVisible.toFixed(3),
					inFrame: +sunInFrame.toFixed(3),
					exposure: +sun.exposure.toFixed(3),
					ambient: +sun.ambient.toFixed(3),
					sky: '#' + scene.background.getHexString(),
					active: sun.active,
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
				flightEnd: flightEnd.out.phase,
			};
		},
	};
	window.__simInput = null;

	hud.ready();
	lastTime = performance.now();
	renderer.setAnimationLoop(frame);
}

// Convenience wrapper for callers with nothing to hide the load behind
// (?scene=, resume, dev ?family=): runs both halves back to back, same as
// before the PHASE 13 split.
async function boot() {
	return finishBoot(preloadScene());
}

// Yields long enough for the loading screen to actually repaint.
function nextPaint() {
	return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}

input.onAction = (key, event) => {
	// Pas de respawn : on ne fait pas réapparaître un drone qu'on a perdu.
	// terrain persistent, flights ephemeral.
	if (key === 'disarm') doDisarm();
	else if (key === ' ') { event.preventDefault(); togglePause(); }
	else if (key === 'p') controller?.cyclePreset();
	else if (key === 'm') controller?.cycleMode();
	else if (key === 'c') toggleFreeCam();
	else if (key === 'f') pendingCapture = true;
	else if (key === 'tab') { event.preventDefault(); settings.toggleSettings(); }
	else if (key === 'escape' && settings.settingsOpen) settings.toggleSettings(false);
	// Le joueur sort lui-même du contrôle : rien ne le sort à sa place, et rien
	// d'autre n'est proposé.
	else if (key === 'escape' && flightEnd.out.exitArmed) finishSession();
};

// POST-FLIGHT ANALYSIS (PHASE 15, Bible §25) avant de rendre la main au
// terminal — seulement pour une session posée (LANDED) : un crash n'a pas de
// grand écran (Bible §24). `session.current()` porte déjà le verdict fermé :
// par construction `exitArmed` n'apparaît qu'après la séquence de fin de vol
// (1,4-4,6 s selon LANDING_TIMELINE/TIMELINE dans flight-end.js), largement
// assez pour que le PATCH de clôture ait eu le temps de revenir du serveur
// de dev local.
async function finishSession() {
	if (exiting) return;
	exiting = true;
	const s = session.current();
	if (s?.result === 'LANDED') {
		await runPostFlightAnalysis(document.getElementById('ui'), s);
	}
	location.href = location.pathname;
}

renderer.domElement.addEventListener('click', () => {
	// Safety net for ?scene=<slug>, which skips the menu and therefore skips the
	// only other user gesture we get. start() is idempotent.
	audio.start();
	if (!freeCamOn && !settings.settingsOpen) renderer.domElement.requestPointerLock();
});

// PHASE 16 : lit le canvas du composer tel qu'il vient d'être peint —
// résolution/ratio du capteur cible, OSD drone, dégradation du lien, pluie et
// brouillard tous déjà dedans, l'overlay DOM FPVTP! jamais dedans. `toBlob`
// lit le buffer au moment de l'appel, pas besoin de `preserveDrawingBuffer` :
// appelé synchrone dans la même frame que le rendu, avant tout autre dessin.
async function capturePhoto() {
	const cap = await lens.capture();
	if (!cap) return;
	const reader = new FileReader();
	reader.onload = () => {
		session.capturePhoto({ dataUrl: reader.result, w: cap.w, h: cap.h })
			.then((count) => fpvtpOsd.flashCaptured(count));
	};
	reader.readAsDataURL(cap.blob);
}

// Désarmement Betaflight. Le geste reste celui du joueur ; c'est la machine de
// fin de vol qui sait si le drone était posé. Désarmer en l'air est permis : la
// chute suit son cours, et c'est l'impact qui conclut.
function doDisarm() {
	if (!physics || !controller.armed) return;
	controller.disarm();

	if (!flightEnd.disarm()) return;

	const p = physics.position;
	const g = physics.groundBelow(p.x, p.y, p.z);
	const v = physics.velocity;

	// Au sol = à portée de contact du sol, pas « parfaitement immobile » : une
	// pose sur une sphère de collision est toujours un peu vivante. On rejette
	// seulement un désarmement franchement en l'air (→ chute → CRASHED).
	const height = g === null ? Infinity : p.y - g;
	const onGround = height < 2 && Math.hypot(v.x, v.y, v.z) < 8;

	console.log(
		`[session] désarmement — sol:${onGround} ` +
		`(h=${height === Infinity ? '?' : height.toFixed(2)}m ` +
		`v=${Math.hypot(v.x, v.y, v.z).toFixed(2)}m/s)`
	);

	if (onGround) {
		// Posé : on le fige, il ne roule pas et ne dérive pas.
		physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		fpvtpOsd.setSessionStatus('TARGET STATUS<small>LANDED</small>', 'landed');
		session.end('LANDED').then((s) => s && console.log('[session] LANDED', s));
	} else {
		// Désarmé en l'air : moteurs coupés, la chute suivra son cours et
		// l'impact fermera la session en CRASHED.
		fpvtpOsd.setSessionStatus('DISARMED<small>FREE FALL</small>', 'lost');
	}
}

function respawn() {
	if (!physics) return;

	// terrain persistent, flights ephemeral : après un crash le drone a disparu,
	// on ne réapparaît pas en place — retour au terminal. En mode ?scene= (dev)
	// on garde le respawn local pour ne pas casser le flow de debug.
	if (crashed && !OPTS.scene) { location.href = location.pathname; return; }
	fpvtpOsd.setSessionStatus(null);
	controller.arm();
	physics.applyEntryState(generateEntryState({
		physics,
		manifest: sceneManifest,
		seed: Math.random().toString(16).slice(2, 12),
	}));
	link.reset();

	// Neither model was being reset here, and both say in their own comments
	// that they should be: a respawn should not drop you back into the squall
	// or the bank that just blinded you.
	rain.reset();
	fog.reset();
	cloud.reset();

	controller.setMode(controller.mode);   // also clears the PID integrators
	input.resetKeyboardThrottle();
	crashed = false;
}

function togglePause(force) {
	paused = force ?? !paused;
	// Coming back should not replay the wall-clock gap as one giant physics step.
	if (!paused) { accumulator = 0; lastTime = performance.now(); }
	fpvtpOsd.setPaused(paused);
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

// Roulis et tangage, pour l'horizon artificiel de l'OSD drone. Même convention
// de quaternion que yawOf juste au-dessus.
function rollOf(q) {
	return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.z * q.z + q.x * q.x));
}
function pitchOf(q) {
	return Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z))));
}

// Latitude/longitude affichées par l'OSD des cibles qui ont un GPS. Approximation
// plate, ce qui est très largement suffisant sur une scène de deux kilomètres.
// Une scène sans origine connue n'a pas de coordonnées : l'OSD affiche alors
// des tirets plutôt qu'un point plausible au large de l'Afrique.
function latLonOf(p) {
	const o = sceneManifest?.origin;
	if (!o || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) {
		return { lat: NaN, lon: NaN };
	}
	const lat = o.latitude + (-p.z) / 111320;
	return { lat, lon: o.longitude + p.x / (111320 * Math.cos(lat * Math.PI / 180)) };
}

function simFrozen() { return freeCamOn || paused || introFrozen || settings.settingsOpen; }

const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
// The fog uniforms live on every chunk material, so they are written only when
// they have actually moved rather than five times a frame for no change. Both
// halves are watched: the fog can thicken without the sky changing colour once
// the mix has saturated, and the rain can recolour the sky at a density the
// fog has already settled on.
let lastDensity = -1;
let lastSkyHex = -1;
let lastDim = 1;
// The lens exposure, mirrored here because the streak length is that exposure
// times the relative speed — the translational half of the motion blur that the
// lens pass, which only reprojects rotation, cannot reconstruct.
let lensShutter = 0;

// Where a bead sitting on the front element is being pushed, in g and in the
// plane of the lens. Written once a frame into the same object rather than
// allocated, like every other per-frame vector here.
const drift = { x: 0, y: 0 };
// L'état du soleil entre deux frames, et les vecteurs réutilisés plutôt que
// réalloués — même règle que `drift` juste au-dessus.
let sunVisible = 1;    // 0..1, occlusion lissée
let sunInFrame = 0;    // 0..1, ce que le posemètre voit du disque
const _sunWorld = new THREE.Vector3();
const _sunView = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camInv = new THREE.Quaternion();
const _sunColor = new THREE.Color();

// What the last link measurement cost and what it found, for __sim.debug().
const linkState = { distance: 0, blocked: false, span: 0, rayMs: 0 };

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;

	const sticks = window.__simInput ?? input.update(dt);

	const frozen = simFrozen();
	audio.setMuted(frozen);

	let crashedThisFrame = false;
	let peakImpact = 0;
	if (!frozen) {
		// Touchdown : en airmode un quad ne se pose pas tout seul — les moteurs
		// tournent au ralenti, la moindre inclinaison au contact le renvoie en
		// l'air, et une sphère de collision qui a de la vitesse angulaire roule
		// sans fin (pas de glissement au point de contact → la friction ne la
		// freine pas). Le vent, lui, continue de le pousser. Quand le pilote a
		// coupé les gaz et que le drone est au ras du sol, on coupe les moteurs
		// et physics.setGroundHold fige le reste : plus de vent, plus de dérive.
		// Le seuil de « gaz coupés » (flightEnd.landing.THR_IDLE) est celui de la
		// famille en vol, pas une constante : voir idleThrottle() dans quad.js.
		const pp = physics.position;
		const gb = physics.groundBelow(pp.x, pp.y, pp.z);
		const touchdown = controller.armed && sticks.throttle < flightEnd.landing.THR_IDLE
			&& gb !== null && (pp.y - gb) < 0.6;
		physics.setGroundHold(touchdown);

		accumulator += dt;
		let steps = 0;
		while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
			const { motors } = controller.update(sticks, physics, FIXED_STEP);
			if (touchdown) motors.fill(0);
			const impact = physics.step(motors, FIXED_STEP);
			if (impact > 0 && !flightEnd.out.linkDead && !crashed) {
				const r = physics.rotation;
				if (impact > crashThreshold(r)) {
					crashedThisFrame = true;
					crashed = true;
					// Le drone est détruit. La session se ferme sur CRASHED — le
					// terrain, lui, reste. terrain persistent, flights ephemeral.
					fpvtpOsd.setSessionStatus('TARGET LOST<small>SESSION TERMINATED</small>', 'lost');
					session.end('CRASHED').then((s) => s && console.log('[session] CRASHED', s));
				}
			}
			if (impact > peakImpact) peakImpact = impact;
			accumulator -= FIXED_STEP;
			steps++;
		}
		if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

		// Un seul raycast de sol par frame de physique. Gelé, rien n'a bougé :
		// la dernière valeur de groundY reste correcte, inutile de refaire un
		// test plein maillage pour rien.
		const fp = physics.position;
		groundY = physics.groundBelow(fp.x, fp.y, fp.z);

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

	// La fin de vol décide seule : ce qui s'affiche, quand l'image meurt, quand
	// la session se ferme. main.js ne fait que l'alimenter et obéir.
	//
	// Appelé HORS du bloc gelé (revue finale, correction 1) : flightEnd.disarm()
	// arme un événement `closes` que seul le prochain update() vidange. Si la
	// sim se fige (C ou Espace) entre le désarmement et Échap, aucune frame
	// non gelée ne tournait plus pour lire cet événement — une pose propre
	// était alors comptée CRASHED par le beacon `beforeunload`. dt=0 fige la
	// timeline et le compteur de pose (la décision « la séquence de fin se
	// fige avec la sim » reste vraie), mais `closes` est désormais vidangé
	// quoi qu'il arrive, dès la prochaine frame.
	const fePos = physics.position;
	const fv = physics.velocity, fw = physics.angularVelocity;
	flightEnd.update({
		dt: frozen ? 0 : dt,
		armed: controller.armed,
		height: groundY === null ? Infinity : fePos.y - groundY,
		speed: Math.hypot(fv.x, fv.y, fv.z),
		angularSpeed: Math.hypot(fw.x, fw.y, fw.z),
		throttle: sticks.throttle,
		crashed: crashedThisFrame,
	});
	// Gardé sur ce que la machine a réellement accepté (linkDead), pas sur
	// crashedThisFrame (bonus, revue finale) : un choc encaissé après un
	// LANDED (le vent repousse un drone désarmé) ne doit pas rejouer la mort
	// de l'image par-dessus l'écran END SESSION.
	if (flightEnd.out.linkDead) {
		// Le drone est détruit : les moteurs se taisent, donc le son aussi —
		// audio.js suit le régime moteur, il n'y a rien à couper à la main.
		controller.disarm();
		// Si le joueur avait coupé la modélisation du lien, il ne verrait
		// aucune dégradation. La mort de l'image ne se négocie pas.
		if (!linkForced) {
			linkForced = true;
			lens.setLink({ mode: lensLinkMode === LINK_OFF ? LINK_ANALOG : lensLinkMode, severity: 1 });
		}
	}
	const closes = flightEnd.out.closes;
	if (closes) {
		session.end(closes).then((s) => s && console.log(`[session] ${closes}`, s));
	}

	// The weather on the camera. Advanced on the frame clock rather than the
	// physics step because nothing in it feeds back into the flight model — the
	// water is on the lens, not on the airframe — and because the streaks and
	// the drops are drawn once per frame whatever the physics did.
if (!frozen) {
	rain.update(physics.airspeed, dt);
	fog.update(dt);
	cloud.update(dt);

	// Altitude au-dessus du sol, utilisée pour le plafond nuageux.
	// On la prend par rapport au spawn plutôt que via un raycast :
	// le relief local est négligeable devant l'altitude de la base des nuages,
	// et le raycast plus bas dans cette frame n'a pas encore eu lieu.
	const altitudeAGL = physics.position.y - spawnY;

	skyDome.setState({
		cover: cloud.cover,
		base: cloud.base,
		altitudeAGL,
		windDir: physics.wind.direction,
		windSpeed: physics.wind.speed,
		rainScale: rain.fogScale,
		fogMix: fog.skyMix,
	});

	// Les extinctions s'additionnent :
	// - brouillard
	// - pluie
	// - plafond nuageux
	//
	// Entrer dans un nuage produit ici un voile uniforme piloté par
	// l'altitude de la caméra, plutôt qu'un calcul par fragment.
	const density =
		fog.density +
		extinctionOf(rain.visibility) +
		cloud.extinctionAt(altitudeAGL);

	// Couleur réellement produite par le dôme cette frame.
	const sky = skyDome.horizon;
	const skyHex = sky.getHex();

	// Le soleil avance avec l'horloge de la frame, comme la pluie et
	// le brouillard. Rien de ce calcul ne redescend dans le modèle de vol.
	if (sun) {
		// Le soleil est-il masqué par un bâtiment ?
		// Un seul rayon suffit ici : la sonde de vent effectue déjà
		// plusieurs tests à ~20,8 Hz.
		const sp = physics.position;
		const far = 2000;

		const blocked = physics.obstructionBetween(
			sp.x,
			sp.y,
			sp.z,
			sp.x + sun.dir.x * far,
			sp.y + sun.dir.y * far,
			sp.z + sun.dir.z * far,
		).blocked ? 1 : 0;

		// Lissage pour éviter le clignotement lorsque le rayon frôle
		// l'arête d'un bâtiment.
		sunVisible +=
			((1 - blocked) - sunVisible) *
			(1 - Math.exp(-dt / 0.08));

		// Direction du soleil dans l'espace caméra.
		_sunWorld.set(
			sun.dir.x,
			sun.dir.y,
			sun.dir.z,
		);

		const axis = _camDir
			.set(0, 0, -1)
			.applyQuaternion(camera.quaternion);

		const cosAngle = axis.dot(_sunWorld);

		// Fraction de présence du soleil dans le champ de vision.
		const halfFov =
			(camera.fov * Math.PI / 180) / 2;

		const cosHalfFov = Math.cos(halfFov);

		const inFrame = Math.max(
			0,
			(cosAngle - cosHalfFov) /
			(1 - cosHalfFov),
		);

		sunInFrame = inFrame * sunVisible;

		sun.update(dt, { sunInFrame });
	}

	if (density !== lastDensity || skyHex !== lastSkyHex) {
		lastDensity = density;
		lastSkyHex = skyHex;

		setFog(sky, density);

		// Muté, pas remplacé : lens.js lit cet objet à chaque frame.
		scene.background.set(sky);

		// Les streaks sont eux aussi éclairés par le ciel.
		rainfall?.setSky(scene.background);
	}

	// Même principe que pour le fondu : on ne retouche pas tous les
	// matériaux de chunk à chaque frame pour une valeur qui évolue
	// sur plusieurs minutes.
	if (cloud.dim !== lastDim) {
		lastDim = cloud.dim;
		setDim(cloud.dim);
	}
}
		// Light the air scatters into the barrel rather than onto the subject.
		// Zero compiles it out of the lens shader entirely.
		lens.setGlare(fog.glare);
		// Et la lumière qui vient d'une direction plutôt que de partout. La
		// projection est faite ici parce que main.js est le seul à connaître la
		// caméra ; lens.js ne reçoit que des nombres, comme pour setGlare().
		if (sun) {
			_sunView.copy(_sunWorld).applyQuaternion(_camInv.copy(camera.quaternion).invert());
			// Espace carré de la passe : x est étiré par l'aspect, exactement
			// comme `base` dans le shader.
			// L'espace `base` du shader, et pas un espace écran inventé ici.
			// lens.js:226-227 le définit : base.x = ndc.x · uAspect et
			// dir = (base.xy · uTanHalf, −1), avec uTanHalf = tan(fovY/2)
			// (lens.js:761). Donc base = (v.x/−v.z, v.y/−v.z) / tan(fovY/2) —
			// SANS facteur 0,5 et SANS multiplier une seconde fois par l'aspect,
			// qui est déjà porté par l'amplitude de base.x. La caméra regarde
			// vers −Z, d'où le signe.
			const front = _sunView.z < 0;
			const tanHalf = Math.tan(camera.fov * Math.PI / 360);
			const invZ = 1 / Math.max(1e-4, -_sunView.z);
			lens.setSun({
				x: (_sunView.x * invZ) / tanHalf,
				y: (_sunView.y * invZ) / tanHalf,
				front,
				color: _sunColor.setRGB(sun.sunColor.r, sun.sunColor.g, sun.sunColor.b),
				amount: sun.sunAmount * sunVisible,
				exposure: sun.exposure,
			});
		}
	skyDome.update(camera, frozen ? 0 : dt);
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
	const linkOut = flightEnd.out.linkDead ? DEAD_LINK : link.out;
	lens.render(camera, dt, freeCamOn ? null : linkOut);

	// Disponible seulement quand ce que montre le canvas est vraiment le flux
	// de la cible : armé, en vol, pas en caméra libre, pas pendant l'agonie du
	// lien. Consommé tout de suite après le rendu — c'est ce buffer précis, pas
	// celui d'une frame suivante, qui devient la photo.
	const photoReady = controller.armed && !frozen && !freeCamOn && !flightEnd.out.linkDead;
	if (pendingCapture) {
		pendingCapture = false;
		if (photoReady) capturePhoto();
	}

	const v = physics.velocity;
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

	// Les deux couches, dans cet ordre : celle de la cible, qui traversera la
	// liaison et le capteur, puis la nôtre, qui ne traverse rien.
	const here = latLonOf(p);
	droneOsd?.update({
		voltageV: bat.voltage,
		cellV: bat.voltage / PROFILE.battery.cells,
		currentA: bat.current,
		mahUsed: bat.usedMah,
		socPercent: bat.soc * 100,
		altM: p.y - spawnY,
		agiM: groundY === null ? null : p.y - groundY,
		groundSpeedMs: Math.hypot(v.x, v.z),
		verticalSpeedMs: v.y,
		throttle01: sticks.throttle,
		rssiDbm: link.out.rssiDbm,
		linkQuality: link.out.quality,
		sats: 12,
		lat: here.lat,
		lon: here.lon,
		homeDistM: Math.hypot(p.x - spawnX, p.z - spawnZ),
		homeBearingRad: Math.atan2(spawnX - p.x, spawnZ - p.z),
		headingRad: yawOf(physics.rotation),
		rollRad: rollOf(physics.rotation),
		pitchRad: pitchOf(physics.rotation),
		flightSeconds: (Date.now() - sessionStartedAt) / 1000,
		// Normalisé sur la poussée de vol stationnaire et pas sur MAX_THRUST, qui
		// n'est pas importé dans main.js : pas d'import nouveau pour un chiffre
		// décoratif.
		escTempC: 34 + 22 * physics.propulsion.thrust / (PROFILE.mass * 9.81),
		vtxChan: 4,
		// Les avertissements d'un OSD réel ne sont pas décoratifs : ils sont ce
		// qui reste lisible quand tout le reste est bruité.
		warning: bat.voltage / PROFILE.battery.cells < 3.4 ? 'LOW VOLTAGE'
			: link.out.quality < 0.25 ? 'RXLOSS' : '',
	});

	fpvtpOsd.update({
		mode: freeCamOn ? 'FREE CAM' : controller.mode,
		rates: RATE_PRESETS[controller.preset].label,
		usingGamepad: input.usingGamepad,
		windMs: Math.hypot(physics.wind.out.x, physics.wind.out.z),
		windRelRad: Math.atan2(physics.wind.out.x, physics.wind.out.z) - yawOf(physics.rotation),
		// La visibilité réellement vue, brouillard ET pluie : le motif exact déjà
		// employé en main.js:409, pour que les deux ne disent jamais deux choses.
		visibilityM: fogRange(fog.density + extinctionOf(rain.visibility)),
		rssiDbm: link.out.rssiDbm,
		operator: operator.getOperator()?.name,
		sessionSeconds: (Date.now() - sessionStartedAt) / 1000,
		propwash: physics.propulsion.propwash,
	});
	fpvtpOsd.setFlightEnd(flightEnd.out);
	fpvtpOsd.setPhotoReady(photoReady);
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
	// charge en tâche de fond : au [ JACK IN ] le contrôle est immédiat. Le slug
	// est déjà connu ici (le TARGET SCAN choisit une cible dans cette carte, pas
	// la carte elle-même) : preloadScene() démarre tout de suite, pour courir
	// derrière le TARGET SCAN entier et pas seulement derrière l'attente de
	// l'AUTOMATED ANALYSIS (PHASE 13, issue #50).
	setScene(slug);
	introFrozen = true;
	const preloading = preloadScene();

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
	const booting = finishBoot(preloading);
	await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting });
	// Le rituel a rendu la main : ne pas rejouer l'écart d'horloge accumulé
	// pendant le hack comme un unique pas de physique géant.
	introFrozen = false;
	accumulator = 0;
	lastTime = performance.now();
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
	spawnY = physics.spawn.y;
	spawnX = physics.spawn.x;
	spawnZ = physics.spawn.z;
	sessionStartedAt = Date.now();
	// Résolue dans le try, lue après : une ouverture de session ratée ne doit
	// pas laisser le vol sans caméra ni sans OSD.
	let tgt = null;
	try {
		await session.open({
			area: flyArea,
			weatherSnapshot: session.snapshotWeather(weather),
			resume: resumeId || OPTS.resume || undefined,
			target: flyTarget || undefined,
		});
		// La cible résolue (scan frais ou relue du disque au resume) arme le lien
		// vidéo avec le RSSI du signal adverse.
		tgt = session.current()?.target;
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

	// La graine : la cible si on en a une, la famille du profil sinon (mode dev,
	// ?scene=). Il y a toujours une caméra et toujours un OSD.
	const seed = session.current()?.id ?? `dev::${PROFILE.family}`;
	const family = tgt?.family ?? PROFILE.family;
	const mode = tgt?.signal?.mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';

	applyTargetCamera(targetCamera({ seed, family }));

	droneOsd?.dispose();
	// La panne NO_OSD (voir drone-osd-model.mjs) renvoie null : certaines
	// cibles n'ont simplement pas d'OSD, ou le leur est éteint/HS.
	const osdLayout = droneOsdLayout({ seed, family, mode });
	droneOsd = osdLayout ? new DroneOsd(osdLayout) : null;
	lens.setOsd(droneOsd);
	fpvtpOsd.show();
	console.log(`[camera] ${camSpec.aspectName} ${Math.round(camSpec.fovDeg)}° uptilt ${Math.round(camSpec.uptiltDeg)}° res ${Math.round(camSpec.resScale * 100)}%`);
}

// Onglet fermé en plein vol : best-effort pour matérialiser le CRASHED. Si ça
// rate (vrai crash navigateur), la réconciliation serveur s'en charge au
// prochain chargement du terminal.
window.addEventListener('beforeunload', () => {
	if (session.current()?.result === 'PENDING') session.beacon('CRASHED');
});
