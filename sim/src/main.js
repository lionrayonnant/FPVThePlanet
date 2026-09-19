import * as THREE from 'three';
import { loadManifest, loadChunks, loadCollision, loadSceneList, sceneBase, setFog, setDim, setNight, setDistantGround, releaseTileMaterials } from './loader.js';
import { releaseTexturePixels } from './TileMaterial.js';
import { initPhysics, Physics, rotateVec } from './physics.js';
import { FIXED_STEP, MAX_STEPS_PER_FRAME, catchUpStep, parseControlRate } from './frame-pacing.js';
import { PACK_DRAINS, crashThreshold, idleThrottle, parseAeroFlag } from './quad.js';
import { CHASE, chaseTarget, chaseStep } from './chase-camera.js';
import { headingOf, bearingTo, windFromBearing, relativeBearing } from './bearing.js';
import { generateEntryState } from './entry-state.js';
import { FlightController, RATE_PRESETS } from './flightController.js';
import { PROFILES, FAMILIES, nominalBuildSeed } from './drone-profiles.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Settings, loadVolume, loadBrightness, loadMusicVolume, loadLens, loadLink, loadViewRange } from './settings.js';
import * as operator from './operator.js';
import { bootstrap } from './bootstrap.js';
import { operatorSelect, operatorKey, runTerminal, dataScreen, fetchScenes } from './terminal.js';
import { installClickFlash } from './motion.js';
import { EngineAudio } from './audio.js';
import { uiAudio } from './ui-audio.js';
import { runIntro } from './intro.js';
import { shouldPlayIntro, markIntroSeen } from '../tools/intro-model.mjs';
import { runBriefing } from './briefing.js';
import { shouldBrief, markBriefed, markFirstFlight, firstFlightPending, flightHint, keyOf } from '../tools/briefing-model.mjs';
import { keyMapRows, actionForKey } from './key-map.js';
import { FlightExit } from './flight-exit.js';
import { newLinkState, linkEvent } from '../tools/ui-audio-model.mjs';
import { FpvLens, LINK_OFF, LINK_ANALOG, LINK_DIGITAL } from './lens.js';
import { VideoLink } from './link.js';
import { RainField, dropDrift, fogRange } from './rain.js';
import { FogField } from './fog.js';
import { SunField, SKY_REF, nightSensor, NIGHT_FLOOR_DEG } from './sun.js';
import { Rainfall } from './rainfall.js';
import { CloudField } from './cloud.js';
import { SkyDome, CLEAR_HORIZON as SKY } from './sky.js';
import { FenceDome, fogDensityFor as liveFogDensityFor, CYAN as FENCE_CYAN } from './fence-dome.js';
import { GeofenceWall } from './geofence-dome.js';
import { edgeFadeForRadius, createRocktreeMaterial, createLiveEdgeUniforms } from './RocktreeMaterial.js';
import { worldWeather, applyWeather, applySimParams, headline, CALM } from './weather.js';
import { selectOperationMode, runBench, loadLastMode } from './bench.js';
import { benchSimParams, benchEntryRequest, benchDate } from '../tools/bench-model.mjs';
import { resolveBenchAirframe } from '../tools/bench-airframe.mjs';
import * as session from './session.js';
import { runTargetScan } from './target-scan.js';
import { generateTargetScan, swarmChanceFor } from '../tools/target-model.mjs';
import { parseSwarmFlag, parseSceneFlag, devFamilies } from '../tools/dev-flags.mjs';
import { runHack } from './hack.js';
import { normalizeHackType } from '../tools/hack-model.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { music } from './music.js';
import { radio } from './radio.js';
import { runJukebox } from './jukebox.js';
import { space } from './space.js';
import { flightIntensity, PHASE_INTENSITY, FADE } from '../tools/music-model.mjs';
import { droneOsdLayout } from '../tools/drone-osd-model.mjs';
import { bootFailureMessage, terrainEmptyError, NO_WEBGL2 } from '../tools/boot-failure-model.mjs';
import { liveAreaId } from '../tools/session-log-model.mjs';
import { DroneOsd } from './drone-osd.js';
import { FpvtpOsd } from './fpvtp-osd.js';
import { creditText } from './provider-credit.js';
import { FlightEnd, FLYING } from './flight-end.js';
import { Turtle, maxRollTorque } from './turtle.js';
import { Geofence, NOMINAL as FENCE_OK } from './geofence.js';
import { DistantGround } from './ground.js';
import { localEnuToEcef, ecefToGeodetic } from '../tools/lib/rocktree/geodesy.mjs';
import { push as rocktreeFencePush } from './rocktree-fence.js';
import { RocktreeWindow } from './rocktree-window.js';
import { LiveNodeQueue } from './live-node-queue.js';
import { warmUp as warmUpTraverseWorker } from './rocktree-traverse-client.js';
import { warmUp as warmUpNodePool } from './rocktree-worker-pool.js';
import { AmbientDrones } from './ambient-drones.js';
import { SwarmDrones } from './swarm-drones.js';
import { setSwarmPresent } from './audio-others.js';
import { PlayerDrone } from './onboard-drone.js';

import { APP_VERSION } from './version.js';

// Exposed on window and written once to the console: a bug report then says
// which version it is about, instead of leaving a SHA to be guessed.
window.FPVTP_VERSION = APP_VERSION;
console.info(`FPVThePlanet! ${APP_VERSION}`);

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
// The physics schedule lives in frame-pacing.js: the rule that simulated time
// must track wall-clock time is worth asserting without a browser, so it is
// stated there and tested by tools/frame-pacing-selftest.mjs. FIXED_STEP is
// the 250 Hz grid; catchUpStep() stretches it, bounded, when a frame ran long
// instead of letting the loop discard the time it could not afford — which is
// what used to run the whole simulation, gravity included, in slow motion
// below ~21 fps.
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
	// The slug rule ([a-z0-9-]+, refused otherwise) lives in tools/dev-flags.mjs,
	// where a selftest can reach it; the raw value never leaves this line.
	scene: parseSceneFlag(params.get('scene')),
	// Dev-only override: ?family=race5 flies that drone family regardless of the
	// TARGET SCAN choice (PHASE 08). One of:
	//   freestyle5 race5 cinewhoop longrange heavy5 toothpick
	family: params.get('family'),
	// Dev: with ?family=, the seed of one individual (livery, frame, portrait —
	// #285). Without it, ?family= stays the NOMINAL profile: grey and with no
	// portrait, as at the bench.
	build: params.get('build'),
	// Dev-only: ?hack=gnss-spoof previews that hack type's pattern before the
	// flight, on the paths that skip the TARGET SCAN (?scene=/?family=).
	hack: params.get('hack'),
	// Dev-only: ?date=2026-06-21T23:52:00Z pins the sun to that instant — which
	// is what makes it possible to check the night (#111) in broad daylight. An
	// invalid date gives a silent NaN inside sunPosition(), hence the guard.
	// Dev-only: ?night=1 restores the night, temporarily disabled (see
	// NIGHT_FLOOR_DEG in sun.js). Combines with ?date= to aim at an hour.
	night: params.get('night') === '1',
	date: (() => {
		const d = params.has('date') ? new Date(params.get('date')) : null;
		return d && Number.isFinite(d.getTime()) ? d : null;
	})(),
	// Dev-only: ?live=48.8584,2.2945 flies live from rocktree, with no baked
	// scene (#168). No weather/geofence/credit screen — see the implementation
	// plan for what is deliberately out of scope.
	live: params.has('live') ? params.get('live').split(',').map(Number) : null,
	// Dev-only: ?swarm=8 forces a cluster of 8 on ?scene= and ?live=, the two
	// paths that skip the TARGET SCAN and synthesise their own scan (#29).
	// ?swarm=8:wedge also pins the doctrine (column/wedge/cloud/screen) instead
	// of leaving it to the size-derived draw. The RULE (an integer in 6..12,
	// an optional known doctrine name, refused otherwise) lives in
	// tools/dev-flags.mjs, where a selftest can reach it.
	swarm: params.get('swarm'),
	// Dev-only: ?loop=1000 runs the CONTROL loop at that rate inside the
	// unchanged 250 Hz physics grid. It exists because a gyro that reports
	// rotor vibration reports it at the shaft frequency, 155-816 Hz across the
	// six families, and a 250 Hz loop cannot represent any of it — see
	// src/frame-pacing.js and tools/loop-rate-bench.mjs. The RULE (one of
	// 250/500/1000/2000/4000, refused otherwise) lives in frame-pacing.js,
	// beside the accumulator it substeps.
	loop: params.get('loop'),
	// Dev-only: ?aero=bem takes the thrust, the torque and the in-plane force
	// out of src/blade-element.js instead of the classic kThrust*w^2 model.
	// NOT TUNED — the six PID tunes belong to the default — and anything but
	// `bem` is the default, silently. The RULE (and why it falls back instead
	// of throwing) lives in src/quad.js, beside the model it selects.
	aero: params.get('aero'),
};
// Substeps of the physics step the controller runs, 1 unless ?loop= says
// otherwise. Throws on a rate the accumulator could not honour exactly.
const CONTROL_SUBSTEPS = parseControlRate(OPTS.loop);
// The rotor model every Physics built below is handed, explicitly.
const AERO_MODEL = parseAeroFlag(OPTS.aero);
// The swarm a dev scan carries, or null. Throws on anything the game itself
// could not draw — see tools/dev-flags.mjs for why it refuses instead of
// clamping.
const devSwarm = parseSwarmFlag(OPTS.swarm);
// `?live=foo` gave [NaN]: a NaN ENU origin, a NaN spawn, rocktree requests for
// a tile that does not exist — a silently invalid world where the drone drifts
// through the void with no message at all. Fail here, early and readably.
if (OPTS.live && (OPTS.live.length !== 2 || !OPTS.live.every(Number.isFinite))) {
	throw new Error(`?live= expects numeric "lat,lon" — got "${params.get('live')}"`);
}
// `?family=swarmNode&scene=<slug>&swarm=12` is the full dev path to the node;
// see tools/dev-flags.mjs for why the list is built there and not here.
const DEV_FAMILIES = devFamilies(FAMILIES);
if (OPTS.family && !DEV_FAMILIES.includes(OPTS.family)) {
	throw new Error(`unknown family: "${OPTS.family}" — ${DEV_FAMILIES.join(' ')}`);
}
// Resolved late (PHASE 08): the family comes out of the TARGET SCAN, in
// chooseScene()'s gate, before boot(). The dev ?family= override pre-fills it
// here.
let PROFILE = OPTS.family ? PROFILES[OPTS.family] : undefined;
if (params.toString()) console.log('[opts]', OPTS);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
// The dome. scene.background stays set behind it: it is never seen again — the
// dome covers the screen — but it now carries the HORIZON colour, which
// rainfall.js, lens.js and the tiles all read. One colour of air.
const skyDome = new SkyDome(scene);

// The HUD is built BEFORE the renderer, and that order is the whole point: a
// WebGLRenderer that cannot get a context throws at module top level, which
// aborts everything below it. Built afterwards, as it used to be, nothing
// existed that could put the failure on screen and the page simply stayed
// black. index.html probes for WebGL2 before the bundle even loads and paints
// its own panel; this is the second net, for a GPU that answers the probe and
// then fails anyway (a blocklisted driver, a lost context at creation).
const hud = new Hud(document.getElementById('ui'));

let renderer;
try {
	renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (err) {
	console.error(err);
	// index.html already said it better, with instructions: leave its panel up.
	if (!window.__FPVTP_NO_WEBGL2) {
		hud.show();
		hud.fail(NO_WEBGL2);
	}
	// Rethrown on purpose. Everything below needs a renderer; carrying on would
	// only bury the readable message under a pile of null-reference noise.
	throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// The imagery already carries its own lighting and colour, so nothing should be
// re-encoded on the way to the framebuffer.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const input = new Input();
// The HUD's two layers (PHASE 12). The station's exists from the start and
// depends on no target; the drone's belongs to the machine being flown, so it
// is born when the session opens, along with its camera spec.
const fpvtpOsd = new FpvtpOsd(document.getElementById('ui'));
let droneOsd = null;
let camSpec = null;
// The last night gain pushed to lens.setSensor() — so that only changes are
// pushed, and so applyTargetCamera() can recompose the night in progress.
let lastNightGain = 0;
const settings = new Settings(document.getElementById('ui'), input);

// The ceiling on the entry draw. Bible §20 hands you a machine already in
// flight, and 3 % of the time that means 40 m/s at 80 degrees of bank one and a
// half metres off the deck. That is the intended shock with a stick in your
// hands; with four arrow keys it is a crash you were never given the means to
// avoid — the keys have no travel, so the correction the draw demands is one
// the hardware cannot express.
//
// The question is "is a pad plugged in at all", not `usingGamepad`, which only
// turns true once a stick has actually moved: this runs before the first input,
// and a pad sitting there silently is still the device this player is about to
// fly with. Same question briefingArgs() asks, for the same reason.
//
// A pad gets null — the draw is untouched, weight for weight. See
// entry-state.js:capCategory(). This is deliberately the ONLY concession the
// keyboard gets on entry: the flight mode itself stays acro for everyone, by
// decision, and the keyboard's own ramp in input.js is what makes that flyable.
function entryCategoryCap() {
	const pad = input.usingGamepad || input.getGamepad?.();
	return pad ? null : 'ACTIVE';
}
// The briefing (D16). What it shows is read LIVE from the input stack, so a
// key rebound a minute ago is the key it names. The slot is filled here, right
// after the panel is built: renderSystem() draws [ REPLAY BRIEFING ] on tab
// entry, and the panel can be opened long before any flight.
function briefingArgs() {
	// The OSD's TR corner reads `usingGamepad`, which only turns true once a
	// stick has actually MOVED. The briefing runs before any flight, so it asks
	// the weaker question: is a pad plugged in at all. A pad that is there and
	// silent is still the device this player is about to fly with.
	const pad = input.getGamepad?.() ?? null;
	return {
		input: { kind: input.usingGamepad || pad ? 'gamepad' : 'keyboard', name: pad?.id ?? '' },
		keyRows: keyMapRows(input.getKeyMap()),
		// Opens the panel on the named tab and resolves when it closes: the
		// briefing screen waits underneath rather than being torn down.
		openSettings: async (tab) => { settings.open(tab); await settings.closed(); },
		// Both Escape listeners sit on `window`: while the panel is up, the
		// Escape that closes it must not also skip the briefing behind it.
		isSettingsOpen: () => settings.settingsOpen,
	};
}
// `force` is the replay: it ignores the seen flag, which is the whole point of
// a button that says REPLAY.
async function playBriefing({ force = false } = {}) {
	if (!force && !shouldBrief(localStorage)) return;
	await runBriefing(document.getElementById('ui'), briefingArgs());
	// Marked whether it was read or skipped: a briefing you refused is a
	// briefing you were offered.
	markBriefed(localStorage);
}
settings.onReplayBriefing = async () => {
	// The panel closes first: the briefing is a full screen, not a layer over
	// the settings it just came out of.
	settings.toggleSettings(false);
	await playBriefing({ force: true });
};
// The three in-flight hints of D16 exist for ONE flight, and never at the
// bench. Armed at the start of each flight, spent when that flight ends.
let hintFlight = false;
let hintAirborneAt = null;
// A menu key pressed inverts for an instant (issue #224).
installClickFlash();
// Built in chooseScene()'s gate, once PROFILE is resolved (PHASE 08). No line
// before the gate uses it at runtime.
let controller;
// Inert until start(): no AudioContext exists before the user's first gesture.
const audio = new EngineAudio();
// The hysteresis state of the link's callouts, kept between frames.
const linkVoice = newLinkState();
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
// And the sky above: how much of it is covered, at what height, and how much
// the ground darkens. The world decides that (#41), not a setting.
const cloud = new CloudField();
// And the light: where the sun is, what the atmosphere does to it, and what the
// camera does with it. Built in boot(), once the manifest is read — it needs the
// scene's lat/lon, and without one it does not exist rather than inventing a
// sun. A pure model: it re-lights NOTHING, the imagery stays unlit.
let sun = null;
let rainfall = null;
// The weather snapshot of the area being flown, for the HUD and __sim.debug().
let weather = null;

let physics = null;
// node path -> [{ colliderPath, mesh }], ?live= mode (#168). Keyed on the NODE
// and not on the collider (#179): a release used to find its submeshes by
// sweeping the WHOLE table (copy included), i.e. O(loaded nodes) per released
// node — quadratic when recentring a window of several hundred.
const liveMeshes = new Map();
let liveWindow = null;          // the live RocktreeWindow in ?live= mode, else null
let fenceDome = null;           // the live FenceDome in ?live= mode, else null (#198)
let liveEdgeUniforms = null;    // shared uniforms for the live terrain's edge fade, else null (#202)

// The ?live= mode's queues (#184, #75): received/released nodes wait in
// LiveNodeQueue (live-node-queue.js), and processLiveNodeWork() drains them
// under a per-frame budget — the work per node is small (~1.4 ms) but arrives
// in bursts of several dozen per frame, and running it on arrival froze the
// render for 70-330 ms per wave. The order and the timing (especially of nodes
// "covered" by another level) are that module's policy, pinned down by
// tools/live-node-queue-selftest.mjs.
const liveQueue = new LiveNodeQueue();

// Removes from the scene and from Rapier everything a node had put down, and
// gives its memory back. Called by the release queue AND by the swap of a
// rebuilt node (#31) — the same work in both cases.
function disposeLiveNode(path) {
	for (const { colliderPath, mesh } of liveMeshes.get(path) ?? []) {
		scene.remove(mesh);
		mesh.geometry.dispose();
		// material.dispose() does not free the texture (#191): it weighs
		// ~580 KiB decoded (ImageBitmap) on the CPU side, plus the GPU upload —
		// without these two lines it leaks on every node that leaves the window,
		// so with the distance travelled rather than the size of the world. The
		// only case with no texture is the flat grey material (no bitmap/uvs,
		// see buildNodeMesh): nothing to close then. .uniforms.uMap, not .map:
		// createRocktreeMaterial() (#202) is a ShaderMaterial, which has none of
		// the .map shorthand of Three's standard materials.
		const liveMap = mesh.material.uniforms?.uMap?.value;
		if (liveMap) {
			liveMap.dispose();
			liveMap.image.close();
		}
		mesh.material.dispose();
		physics.removeNodeCollider(colliderPath);
	}
	liveMeshes.delete(path);
}

// Drains the queues under budget (see LiveNodeQueue for order and timing).
function processLiveNodeWork(budgetMs = liveQueue.budgetMs()) {
	if (!liveWindow) return;
	liveQueue.drain({
		budgetMs,
		pendingFetches: () => liveWindow.pendingCount(),
		dispose: disposeLiveNode,
		build: (path, job) => {
			const built = buildNodeMesh(path, job.meshes);
			// A SWAP, not a deferred replacement (#31): a node whose mesh alone
			// changes (the ring LOD's `exclude` depends on the window position)
			// stays on screen until here — the window flagged it `replaced`
			// instead of releasing it. The old one only leaves once the new one
			// is built, in the SAME frame: without that, releases running before
			// builds, a ring of ground disappeared for ~1 s on every recentring
			// (measured: 8.17 % of the ground missing at 583 ms).
			if (liveMeshes.has(path)) disposeLiveNode(path);
			const entries = [];
			liveMeshes.set(path, entries);
			for (const { mesh, colliderPath, vertices, indices } of built) {
				// The collider FIRST (#179): it is the only one of these steps
				// that can throw (path already loaded, trimesh refused by
				// Rapier). The mesh used to be added to the scene before it and
				// recorded after — so an exception on a node's first submesh
				// left a mesh in the scene that nothing would ever release.
				physics.addNodeCollider(colliderPath, vertices, indices);
				scene.add(mesh);
				// GPU upload on arrival, under THIS budget, rather than at the
				// first render — otherwise Three uploads every texture of the
				// wave in the frame where they become visible.
				const liveMap = mesh.material.uniforms?.uMap?.value;
				if (liveMap) renderer.initTexture(liveMap);
				entries.push({ colliderPath, mesh });
			}
		},
	});
	// ONE refit of the query BVH for the frame's whole batch (#187) — add/remove
	// no longer pay for it each. Must stay AFTER the drain: groundBelow() (spawn,
	// AGL) reads the pipeline by the next frame at the latest.
	physics.flushNodeColliders();
}
// This load's operation mode (PHASE 26, Bible §48).
//
// FIELD is the game: a target that is not yours, a link that degrades, a
// session written down, a crash that loses the machine.
// BENCH is the bench: NO TARGET, NO LINK, NO HACK, NO LOSS, NOTHING LOGGED.
//
// One object passed through, and emphatically NOT a second boot pipeline.
// bootLive() forked the end of finishBoot() by hand and paid for it three times
// (#168, #170 — settings.flightActive, lastTime, exposeDebugGlobal each
// forgotten in turn). The bench reuses boot(slug) and bootLive() as they are;
// all it adds is this flag and the guards that read it.
// `live`: a RECONNAISSANCE flight in FIELD, taking off from the scanner with
// nothing baked (D7 — a mode does not give itself its own boot path, it goes
// through the one that exists with a flag; here bootLive(), the same one ?live=
// and the bench use). It leaves nothing: no session, no target, no log line — a
// live flight keeps no terrain, so it must keep no flight either (§2.2, terrain
// persistent, flights ephemeral).
const MODE = { bench: false, live: false, config: null };
// The rates of an individual drawn at the bench, set before bootLive(), which
// builds its own controller. null in FIELD and for ?live=: the controller then
// falls back to RATE_PRESETS[preset], as before.
let benchRates = null;
// The throttle chain the bench's build asks for (min throttle, the three
// bands), or null for the controller's own inert DEFAULT_THROTTLE. Same rule as
// benchRates: it has to be set BEFORE any FlightController is constructed.
let benchThrottle = null;
// The identity of the machine currently flying — the hash of base, parts and
// overrides (tools/bench-airframe.mjs). The in-flight panel swaps the airframe
// when this changes. It used to compare `profile.family`, which meant a new
// seed, and now any of forty parameters, changed nothing at all in flight.
let benchIdentity = null;
// The identity of the PLANT alone, so a rate change does not rebuild the
// Propulsion — and with it the pack — for nothing.
let benchProfileIdentity = null;
// The instant the bench gives the sun. Recomputed when the time changes and not
// every frame: sun.update() runs at 60 Hz and does not need a Date manufactured
// for it sixty times a second.
let benchClock = null;

// Is the bench panel open over the flight? Freezes the sim the way the Settings
// panel does: you set up a machine at a standstill, not in free flight.
let benchPanelOpen = false;

// Applies to the living world everything the bench config decides. Called at
// boot AND on every change from the in-flight panel: it is the same path, so a
// setting behaves the same before and during a flight.
function applyBenchConfig() {
	if (!MODE.bench || !MODE.config) return;
	const c = MODE.config;
	benchClock = benchDate(c);
	applySimParams(benchSimParams(c), { physics, rain, fog, cloud, sun });

	// The airframe, hot. physics.setProfile() rebuilds the Propulsion and the
	// Rapier body's mass properties without reloading the scene; that is already
	// what tools/selftest.mjs does to walk the six families. The controller
	// follows: its PIDs are the profile's, not constants.
	//
	// Keyed on the build's IDENTITY and no longer on its family: base, bill of
	// materials and every override are in that hash (#159), so setting a gain
	// from the in-flight panel reaches the loop the same way changing family
	// does — which is the whole promise of "the same screen before and during".
	const resolved = resolveBenchAirframe(c.airframe);
	if (physics && resolved.identity !== benchIdentity) {
		const plantChanged = resolved.profileIdentity !== benchProfileIdentity;
		benchIdentity = resolved.identity;
		benchProfileIdentity = resolved.profileIdentity;
		const build = resolved.build;
		// setProfile() rebuilds the Propulsion, and a fresh Propulsion is a
		// fresh pack. So it runs only when the PLANT moved: setting a rate or a
		// throttle band must not quietly hand the charge back.
		if (plantChanged) {
			physics.setProfile(resolved.profile);
			PROFILE = physics.profile;
			audio.setProfile(physics.profile);
		}
		benchRates = resolved.rates;
		benchThrottle = resolved.throttle;
		flightBuild = build;
		controller = new FlightController({
			profile: PROFILE,
			rates: resolved.rates ?? undefined,
			throttle: resolved.throttle ?? undefined,
		});
		console.log(`[bench] airframe -> ${PROFILE.family} (${PROFILE.label}) ${resolved.identity}`);
		// The player's drone follows the airframe (#286): its props, its livery
		// and its frame are those of the individual actually flying, not of the
		// old one — without this, the old machine's props stayed in frame (noted
		// in HANDOFF since #264).
		if (plantChanged && playerDrone && camSpec) {
			lens.setOnboard(null);
			playerDrone.dispose();
			playerDrone = new PlayerDrone({ scene, profile: physics.profile, build, camera: camSpec });
			playerDrone.setChase(viewMode === 'chase');
			lens.setOnboard(viewMode === 'chase' ? null : playerDrone.onboardScene, playerDrone.onboardCamera);
		}
	}
	// physics.battery is a getter onto propulsion.battery, and setProfile()
	// rebuilds the Propulsion — hence the pack. Setting the flag again HERE,
	// after the airframe change rather than once at boot, is what stops an
	// in-flight airframe change from quietly handing the charge back.
	physics?.battery?.setDrain(PACK_DRAINS && c.battery !== 'HELD');
}

// The bench panel, opened over the flight (B key). The SAME screen as the
// pre-takeoff configuration, in `live` mode: a setting has to behave the same
// before and during, otherwise the bench lies about what it sets.
async function toggleBenchPanel() {
	if (benchPanelOpen) return;
	benchPanelOpen = true;
	// The mouse cursor belongs to the flight: without this, pointer lock eats the
	// panel's clicks and nothing can be set.
	document.exitPointerLock?.();
	try {
		MODE.config = await runBench(document.getElementById('ui'), {
			live: true,
			onChange: (c) => { MODE.config = c; applyBenchConfig(); },
		}) ?? MODE.config;
	} finally {
		benchPanelOpen = false;
		// The same reset as coming out of pause: do not replay the wall-clock gap
		// accumulated while setting things as one giant physics step.
		accumulator = 0;
		lastTime = performance.now();
	}
}

// The area's limits (#139) and what is seen beyond them. Both are born in
// finishBoot(), once the manifest's bbox is known: with no map there is neither
// a fence nor a horizon to draw.
let fence = null;
let geofenceWall = null;   // the live GeofenceWall outside ?live=/bench, else null (#199)
let distantGround = null;
// The ambient drones (issue #250): null at the bench (NO TARGET) and until the
// map is loaded. `liveBounds` is the LIVE bubble: mutated every frame, never
// replaced — the model holds the reference.
let ambient = null;
// The swarm (issue #29): null at the bench and outside a cluster. Like the
// ambients, it has no effect on the game — no Rapier body, no collision, no
// target, no wear.
let swarm = null;
// The fence the swarm reads, MUTATED every frame and never replaced: the model
// does not hold onto it. `bbox` on a baked scene, `center`/`radius` live (the
// rocktree window's circle of confidence).
const swarmFence = { bbox: null, center: null, radius: 0 };
// The clock the wake is timestamped against: monotonic seconds, frozen with the
// physics. Not performance.now() — a pause would dig a ten-second hole in the
// track, and a unit's slot is read at a past instant.
let swarmClock = 0;
const liveBounds = { center: null, trusted: 0 };
// The resolution in device pixels, for the ambients' LED billboard (the same
// trap as uResolution in lens.js). Updated in resize().
const ambientRes = { w: 1, h: 1 };
// The fence push force, written once per physics STEP rather than allocated —
// same rule as `drift` below: this runs at 250 Hz. Rapier copies the vector
// inside addForce(), nothing holds it after the step.
const _fenceForce = { x: 0, y: 0, z: 0 };
// The scene's manifest, hoisted out of boot(): the drone OSD reads its lat/lon.
let sceneManifest = null;
let emitter = null;
// armFlight()'s promise, which arms exactly once: the boot calls it, the
// startup() chain awaits it (see armFlight()).
let flightArming = null;
// The player's drone (issue #264): mounted when the flight is armed, once the
// target's camera is known — the recipe reads its uptilt. Null on the ?live=
// free-flight dev path, like the ambients: that path mounts no camera.
let playerDrone = null;
// The flight camera's field, as the onboard view copies it. Allocated once: the
// flight path allocates nothing per frame.
const playerCam = { fov: 120, aspect: 1 };
// The build drawn for THIS flight, hoisted out of the places that resolve it
// (terrain, live, bench, override). PROFILE already carries its profile; the
// recipe wants the build itself. Null when a nominal profile is flown.
let flightBuild = null;
// And its SEED, the same one the server rebuilds in resolveTarget(). The
// wireframe portrait (#264) is derived from `family` + `buildSeed` alone: that
// is also what lets an already-logged session show its machine.
let flightBuildSeed = null;
// D11 — 'fpv' (the video feed) or 'chase' (a third-person camera that follows
// the machine while the simulation keeps running). Per-flight state: every
// flight starts in FPV.
let viewMode = 'fpv';
// The smoothed chase position, kept between frames. Null means "snap on the
// next frame" — entering the view must not fly in from wherever the camera was.
let chasePos = null;
// Last usable heading. A drone pointing straight up or down has no horizontal
// nose direction; rather than snapping the camera to north, we hold the last one.
let chaseYaw = 0;
let paused = false;
// The timestamp of the REAL start of the flight (sticks live), set everywhere
// that resets lastTime for that reason. Used to ignore Space for the first
// 5 seconds: without it, a pause taken by reflex during the Control Vector
// (which freezes the world but not the keys) arrives as-is when the sticks are
// handed over, and the player lands on a paused game without meaning to.
let flightStartTime = 0;
const PAUSE_GUARD_MS = 5000;
// The hack plus the ritual (vector code, demo scene) run in front of a world
// that is already loaded and physically active (#22): without this freeze the
// drone falls while the player is still looking at the analysis screen, before
// they have touched a stick.
let introFrozen = false;
let crashed = false;

// Keeps [ENTER] DISCONNECT idempotent (PHASE 15): exitArmed stays true once
// set, so a held key or a second event must not fire two reloads.
// #20: the latch and the two acts of leaving live in src/flight-exit.js, which
// is pure and tested. Both are bounded there — a flush that never answers gives
// up, and a navigation that does not take the page away hands the gesture back
// instead of leaving the end screen inert forever.
const flightExit = new FlightExit({
	flush: () => operator.flush(),
	navigate: () => { location.href = location.pathname; },
});

// The "pad button held" state for the end-of-flight exit (issue #123). True by
// default: only a rising edge AFTER the exit is armed triggers the disconnect.
let exitPadHeld = true;

// PHASE 16: raised by the capture key, consumed once per frame right after
// lens.render() — that already-rendered frame is the one lens.capture() redraws
// at the target sensor's resolution. The FPVTP! OSD (a separate DOM overlay,
// never in the canvas) never appears in it.
let pendingCapture = false;

const flightEnd = new FlightEnd();

// Assisted turtle mode (#105). Fed INSIDE the fixed-step loop, like the area
// fence: its torque has to leave in the same step as the thrust, and its damping
// term wants the 250 Hz rather than the display rate.
const turtle = new Turtle();
// The press, set by onAction and consumed by the first fixed step that follows.
// A press is not a hold: it counts once, however many steps are in the frame.
let turtlePressed = false;
// The current profile's roll/pitch inertia as a single value: the flip turns
// about a HORIZONTAL axis, and the two inertias agree to within a few per cent
// on every family.
const flipInertia = (profile) => (profile.inertia.x + profile.inertia.z) / 2;

// The link as lens.js sees it when the machine is dead: quality 0 and frozen
// are exactly what the shader already reads as "nothing is arriving any more".
// No new picture code, only the deepest degradation mode.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };
let linkForced = false;

// The mode the player chose in the link settings, remembered so the crash
// sequence can force a degradation even if they turned the model off.
let lensLinkMode = LINK_OFF;

// The ground under the drone, one Rapier raycast per frame — physics.groundBelow
// is a full-mesh test, not something to redo twice for the same position.
// Recomputed only when physics advances; the freeze (pause, settings, intro)
// leaves the drone still, so the last value stays correct until something moves.
let groundY = null;
// The area being flown (= scene slug) and the spawn altitude, for the session.
let flyArea = null;
let flyTarget = null;
// The current flight's zone, in the shape fieldLoop() expects (#253): set as
// soon as the TARGET SCAN starts, read back by finishSession({redeploy:true}) so
// the same zone can be launched again without going through the terminal.
let lastZone = null;
let spawnY = 0;
// The full starting point, not only its altitude: the drone OSD shows a
// distance to the takeoff point, so it needs all three coordinates.
let spawnX = 0;
let spawnZ = 0;
// The flight clock, on wall-clock time: it keeps running through a pause, like
// real hardware. Primed at load so the first frames, before the session opens,
// do not read 1970.
let sessionStartedAt = Date.now();
let cameraFov = 120, cameraTilt = 25;
let accumulator = 0;
let lastTime = performance.now();

function resize() {
	// The aspect comes from the target's camera as soon as there is one: the
	// composer's target is sized to the sensor, so a scene rendered at the
	// window's aspect would be stretched inside it, on top of the black bars.
	camera.aspect = camSpec ? camSpec.aspect : innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
	ambientRes.w = renderer.domElement.width;
	ambientRes.h = renderer.domElement.height;
	lens.setSize(innerWidth, innerHeight);
	// Device pixels and the live FOV: the streaks' minimum width is measured in
	// pixels, and a CSS-pixel height would make it the wrong size on a HiDPI
	// display — the same trap uResolution has in lens.js.
	rainfall?.setSize(innerHeight * renderer.getPixelRatio(), camera.fov);
}
addEventListener('resize', resize);
resize();

// The target's camera: applied once, at the moment control is taken. It touches
// the field of view, the uptilt, the aspect, the resolution and the sensor — and
// nothing else: the flight does not depend on it.
function applyTargetCamera(spec) {
	camSpec = spec;
	cameraFov = spec.fovDeg;
	cameraTilt = spec.uptiltDeg;
	// The chase cap of V6 survives a camera swap: chase is an outside camera,
	// and it does not inherit the target's wide field just because the target
	// changed.
	camera.fov = viewMode === 'chase' ? Math.min(spec.fovDeg, CHASE.fovDeg) : spec.fovDeg;
	camera.aspect = spec.aspect;
	camera.updateProjectionMatrix();
	lens.setCamera({ aspect: spec.aspect, resScale: spec.resScale });
	lens.setSensor(nightSensor(lastNightGain, spec.sensor));
	rainfall?.setSize(innerHeight * renderer.getPixelRatio(), spec.fovDeg);
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
// Loads an area WITHOUT mounting anything into the Three scene: the meshes are
// only returned to the caller, and finishBoot() is what mounts them, once the
// area is really committed. That is what makes an orphaned preload harmless —
// the TARGET SCAN is cancellable, and going back to the zone selection lets that
// load finish quietly instead of abandoning it (see preloadFor).
async function preloadScene(slug) {
	const base = sceneBase(slug);
	const t0 = performance.now();
	hud.startClock();

	stage('manifest');
	hud.progress('READING MANIFEST…', 0.01);
	const manifest = await loadManifest(base);

	const totalMB = (manifest.chunks.reduce((s, c) => s + c.geoBytes + c.texBytes, 0)
		+ manifest.collision.bytes) / 1e6;
	hud.detail(`${totalMB.toFixed(0)} MB TO LOAD`);

	stage('rapier-init');
	hud.progress('PHYSICS INIT…', 0.02);
	await initPhysics();

	stage('chunks');
	const { meshes, timings } = await loadChunks(manifest, base,
		{ fogColor: SKY, fogDensity: FOG_DENSITY, maxChunks: OPTS.maxChunks,
		  mipmaps: OPTS.mipmaps, anisotropy: OPTS.anisotropy },
		({ bytes, totalBytes, done, total, decoding }) => {
			hud.progress(`TILES ${done}/${total}${decoding > 0 ? ` — DECODING ${decoding} SHEET(S)…` : '…'}`,
				0.02 + 0.45 * (bytes / totalBytes));
			hud.detail(`${(bytes / 1e6).toFixed(0)} / ${(totalBytes / 1e6).toFixed(0)} MB`);
		});
	console.log('chunk timings (ms):', JSON.stringify(timings));

	stage('collision-download');
	const collision = await loadCollision(manifest, base, (f, received) => {
		hud.progress('COLLISION MESH…', 0.47 + 0.28 * f);
		hud.detail(`${(received / 1e6).toFixed(0)} / ${(manifest.collision.bytes / 1e6).toFixed(0)} MB`);
	});

	return { slug, manifest, meshes, collision, t0 };
}

// The rest of boot(): needs PROFILE (the target's family, resolved by TARGET
// SCAN) to build the right airframe, but everything in here is local compute
// — no network — so it stays cheap enough to hide behind the hack/ritual
// hold that already follows TARGET SCAN. Takes preloadScene()'s return value
// (or its promise — awaited here, not by the caller) so the two stages chain
// without the caller needing to know boot() is split in two.
// Pulled out so bootLive() can call it too (#168, #170) — ?live= mode has no
// finishBoot(). The same control/debug object on both sides; some fields
// (weather, distantGround, sun, rain, fog, cloud) stay null in live mode, which
// only matters if a caller invokes debug()/teleport()/setWeather() there — no
// existing check does.
function exposeDebugGlobal() {
	window.__sim = {
		physics, controller, camera, renderer, scene, input, timeline, audio, music, space, lens, link, rain, fog, cloud, sun,
		fence, distantGround,
		// Overrides the sticks; pass null to hand control back.
		setInput: (s) => { window.__simInput = s; },
		// The live mode's queue state (#75), to measure a wave in flight.
		liveStats: () => ({ builds: liveQueue.builds.size, swaps: liveQueue.swaps.size, covered: liveQueue.covered.size, releases: liveQueue.releases.length, pending: liveWindow?.pendingCount() ?? null, edgeCenter: liveEdgeUniforms ? [liveEdgeUniforms.uWindowCenter.value.x, liveEdgeUniforms.uWindowCenter.value.y] : null, edgeRadius: liveEdgeUniforms?.uLoadRadiusM.value ?? null, edgeFade: liveEdgeUniforms?.uEdgeFadeM.value ?? null }),
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
		// A tape measure between two points of the flight. Call it once where you
		// want to measure FROM, fly, call it again: it reports the separation in
		// local ENU metres. Built to settle whether the rendered world is at
		// true scale, which is what is left once the force budget says no force
		// is holding the machine up: fly level with the foot of a landmark, call
		// it, climb level with its top, call it again. The Eiffel Tower is 330 m
		// to the tip, 276 m to the top floor, 115 m to the second.
		ruler: (() => {
			let from = null;
			return () => {
				const p = physics.position;
				if (!from) { from = { x: p.x, y: p.y, z: p.z }; return { marked: from }; }
				const dx = p.x - from.x, dy = p.y - from.y, dz = p.z - from.z;
				from = null;
				return {
					up: +dy.toFixed(1),
					horizontal: +Math.hypot(dx, dz).toFixed(1),
					straightLine: +Math.hypot(dx, dy, dz).toFixed(1),
				};
			};
		})(),
		// Where the drone's weight actually goes, in flight, over real terrain
		// and the real weather of the place. __sim.budget() starts it,
		// __sim.budget(true) reads it back. Everything is a fraction of weight
		// resolved along world +Y: thrustUp near 1 in a hover, and whatever the
		// air is carrying on top of it is the "it floats" the pilot feels.
		budget: (read = false) => (read ? physics.forceBudget() : physics.beginForceBudget()),
		// What the world said about this zone today, and what it became.
		weather: () => weather,
		// The flight session in progress (PHASE 06), or null.
		session: () => session.current(),
		// The ambient drones (issue #250), or null (bench, before the map).
		ambient: () => ambient,
		// The swarm (issue #29), or null (bench, outside a cluster, before the map).
		swarm: () => swarm,
		// Why an end-of-flight exit does not exit (#20). Everything [ESC] /
		// [ENTER], the click and the pad button depend on, in one console call
		// with the end screen up. Each field is a guard that can, on its own,
		// make the gesture inert.
		endState() {
			const map = input.getKeyMap();
			const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
			return {
				phase: flightEnd.phase,
				exitArmed: flightEnd.out.exitArmed,
				// True = an exit is already under way and every later gesture is
				// being folded into it. 'stalled' means it gave up and handed the
				// gesture back (#20).
				exiting: flightExit.busy,
				exitStage: flightExit.stage,
				operatorPending: operator.pendingCount(),
				settingsOpen: settings.settingsOpen,
				paused,
				frozen: simFrozen(),
				// Non-null = the key went off to fly an action and never reaches the
				// exit (input.js only passes it raw when NOTHING binds it).
				escapeBoundTo: actionForKey(map, 'escape'),
				enterBoundTo: actionForKey(map, 'enter'),
				tabBoundTo: actionForKey(map, 'tab'),
				keyMap: map,
				// A button held since the flight blocks the pad's rising edge.
				padHeld: exitPadHeld,
				padDown: !!pad?.buttons.some((b) => b.pressed),
				padButtonsDown: pad ? pad.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0) : null,
				activeElement: document.activeElement?.tagName ?? null,
				pointerLock: !!document.pointerLockElement,
			};
		},
		teleport(x, y, z) {
			physics.body.setTranslation({ x, y, z }, true);
			physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			flightEnd.reset();
			turtle.reset();
			fence.reset();
			// Otherwise a second crash in the same page would not force the link
			// degradation again: setLink(true) runs once per flight.
			linkForced = false;
			// An arbitrary jump would leave the ambients behind, out of the bubble.
			ambient?.reset();
			// The swarm follows the WAKE: a jump would send it straight through
			// everything between the two points. The wake is emptied and the
			// units settle back onto the player.
			swarm?.reset(physics.position);
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
					// The density actually pushed to the shader also includes the
					// ceiling (see cloud.extinctionAt in frame()): add it here so
					// the reported range matches what the picture shows once you
					// approach the ceiling. p and spawnY are already to hand
					// above, no need for another raycast.
					rangeWithRain: Math.round(fogRange(fog.density + rain.extinction + cloud.extinctionAt(p.y - spawnY))),
					density: +(fog.density).toFixed(6),
					glare: +fog.glare.toFixed(3),
				},
				cloud: {
					cloudCover: +cloud.cover.toFixed(3),
					cloudBase: Math.round(cloud.base),
					// Negative while below the ceiling, positive once inside it or
					// above. This is the number you look at when checking that a
					// whiteout arrives at the right moment.
					ceilingAGL: Math.round((physics.position.y - spawnY) - cloud.base),
				},
				// What lets the sun be checked in a real browser rather than
				// looking at a screenshot and believing it.
				sun: sun && {
					elevation: +sun.elevation.toFixed(2),
					azimuth: +sun.azimuth.toFixed(2),
					dir: { x: +sun.dir.x.toFixed(3), y: +sun.dir.y.toFixed(3), z: +sun.dir.z.toFixed(3) },
					amount: +sun.sunAmount.toFixed(3),
					visible: +sunVisible.toFixed(3),
					inFrame: +sunInFrame.toFixed(3),
					exposure: +sun.exposure.toFixed(3),
				gain: +sun.gain.toFixed(3),
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
				// What lets the fence be checked in a real browser rather than
				// looking at a screenshot and believing it.
				fence: {
					zone: fence.out.zone,
					// CAREFUL: this is NOT the distance to the edge. It is
					// min(horizontal margin, vertical margin - v.edge), and in
					// normal flight it is almost always the VERTICAL term that
					// wins.
					//
					// Measured on tour-eiffel (bbox.min.y = -30.9), at the centre
					// of the bbox, at y = 60 in ABSOLUTE coordinates: the
					// horizontal margin is 640.6 m and this field reads only
					// 98.9.
					//
					// The FRAME OF REFERENCE matters, and it has already produced
					// three different numbers for the same quantity: describing
					// the same flight as "60 m above the floor" (absolute y 29.1)
					// gives 68.0, not 98.9. Say which of the two, or quote no
					// number at all.
					//
					// The ZONE does not suffer from that mixture: it comes from
					// max(rank) of the two corridors, which stay independent.
					marginM: +fence.out.marginM.toFixed(1),
					t: +fence.out.t.toFixed(3),
					lossDb: +fence.out.lossDb.toFixed(1),
					warning: fence.out.warning,
					over: fence.out.over,
					pushMs2: +Math.hypot(fence.out.push.x, fence.out.push.y, fence.out.push.z).toFixed(2),
					corridor: fence.effectiveCorridor,
				},
				// The inhabited sky (issue #250): undefined at the bench, where
				// there are no ambients at all.
				ambient: ambient?.debug(),
				// The swarm (issue #29): undefined at the bench and outside a cluster.
				swarm: swarm?.model ? swarm.debug() : undefined,
			};
		},
	};
	window.__simInput = null;
}

// Issue #120: lens and link have no UI in the Tab panel any more — applied
// once from their stored values (see settings.js).
//
// Lifted out of finishBoot() because finishBoot() is the BAKED-scene path, and
// that made the whole video-link picture degradation — going behind a building
// and losing the picture, one of the signature things this game does — silently
// absent from LIVE and from the bench, which are the only two paths a fresh
// clone can fly. lens.js pins uLink at 1 while _linkMode is LINK_OFF, so
// nothing ever showed and nothing ever complained.
function applyLensAndLink() {
	const lensCfg = loadLens();
	const lensParams = { on: lensCfg.on, lens: lensCfg.lens, vignette: lensCfg.vignette, shutter: lensCfg.shutter / 1000 };
	lens.setEnabled(lensParams.on);
	lens.setParams(lensParams);
	lensShutter = lensParams.shutter;

	const linkCfg = loadLink();
	link.setSeverity(linkCfg.severity);
	// Remembered: the crash sequence must be able to force a degradation even if
	// the player turned the link model off.
	lensLinkMode = linkCfg.severity === 0 ? LINK_OFF
		: linkCfg.mode === 'digital' ? LINK_DIGITAL : LINK_ANALOG;
	lens.setLink({ mode: lensLinkMode, severity: linkCfg.severity });
}

// `arm` (#122, see armFlight()): who mounts the flight — the target, the
// machine's camera, its props, its OSD — and therefore WHEN. True by default,
// under the loading screen, which is the only thing covering that moment on the
// paths with no ceremony (?scene=, the ?family= override, the bench). The FIELD
// paths pass false: there, the [ JACK IN ] gesture is what arms, because nothing
// must touch the world before it and everything must be in place after it.
async function finishBoot(preloading, { arm = true } = {}) {
	const preloaded = await preloading;
	const { manifest, meshes, collision, t0 } = preloaded;

	// Mounting into the scene happens HERE and not in preloadScene(): from this
	// moment the area is committed, and there is no going back.
	sceneManifest = manifest;
	fpvtpOsd.setCredit(creditText(manifest));
	for (const m of meshes) scene.add(m);

	// In the scene, not over it: the streaks go through the RenderPass, so the
	// lens distorts, vignettes, smears and breaks them up like everything else,
	// and the city occludes them.
	rainfall = new Rainfall(scene, { sky: SKY });
	rainfall.setSize(innerHeight * renderer.getPixelRatio(), camera.fov);

	stage('collision-build');
	hud.progress('BUILDING COLLISION TREE…', 0.76);
	hud.detail(`${(manifest.collision.indexCount / 3).toLocaleString()} triangles`);
	await nextPaint();
	physics = new Physics(collision, manifest.spawn,
		{ aero: AERO_MODEL, ...(PROFILE ? { profile: PROFILE } : {}) });
	// collision.bin has been copied into WASM memory: nothing here reads its JS
	// arrays again. Give them back at once (issue #249) — otherwise the preload
	// cache would hold the whole area until the next reload, and the Rapier
	// Collider keeps a view of it on its own side.
	physics.releaseSourceArrays(collision);
	preloaded.collision = null;
	// On the paths with no target (?scene=, dev mode with no ?family=), PROFILE
	// was never resolved and Physics fell back to its default profile. Both OSD
	// layers read the profile's battery and mass every frame: adopt the one
	// actually flying here, once and for all.
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	if (OPTS.family) console.log(`[family] ${physics.profile.family} — ${physics.profile.label}`);

	// The area's limits (#139). Built BEFORE the entry point is drawn just below:
	// it is the same bbox, and entry-state.js now uses it so a flight is never
	// born inside the warning.
	//
	// FENCE OFF at the bench: an enormous fence rather than a branch inside
	// frame(). Same pattern as the ?live= mode below — the zone stays NOMINAL
	// and the push stays nil, so everything that reads fence.out (the force, the
	// OSD, the out-of-coverage end of flight) keeps working while knowing
	// nothing about the bench. The terrain still stops at the edge of the
	// acquired rectangle: that is said before takeoff, not discovered in the
	// void.
	fence = MODE.bench && !MODE.config.fence
		? new Geofence({ min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] })
		: new Geofence(manifest.bbox);
	// The digital wall (#199): only for a real map bbox — the bench's +/-1e6 bbox
	// with the fence off has nothing to visually bound, the same logic as the
	// giant fence below in ?live=/bootLive() mode.
	geofenceWall = (MODE.bench && !MODE.config.fence) ? null : new GeofenceWall(scene, manifest.bbox);
	const ec = fence.effectiveCorridor;
	console.log(`[fence] corridor ${ec.caution.toFixed(0)}/${ec.hold.toFixed(0)} m`
		+ ` (scale ${ec.scale.toFixed(2)}, half-side ${ec.halfMinM.toFixed(0)} m)`);
	// And what is seen beyond the last chunk. Mounted here, before the
	// renderer.compile() at the end of the load: its material must compile behind
	// the loading screen, not on the first frame of flight.
	//
	// One per page: finishBoot() is called once (its two callers exclude each
	// other) and changing area reloads the page. If a scene teardown ever
	// appears, it will have to dispose() THEN setDistantGround(null) —
	// loader.js's registration must not outlive the object, or
	// setFog/setNight/setDim would write to a freed material.
	//
	// The weather has not been applied at this point: these two values are the
	// clear air of the start, and the first frame rewrites both through setFog()
	// (lastDensity/lastSkyHex start at -1, so it goes through).
	distantGround = new DistantGround(scene, manifest.bbox, {
		fogColor: scene.background, fogDensity: fog.density,
	});
	setDistantGround(distantGround);

	// The ambient drones (issue #250) — never at the bench: NO TARGET.
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			bounds: { bbox: manifest.bbox, corridor: fence.effectiveCorridor },
		});
		// The swarm (issue #29), same guard: it only has units if the target
		// carries one, which setSwarm() decides below.
		swarm = new SwarmDrones({ scene });
		swarmFence.bbox = manifest.bbox;
	}

	// The entry. In FIELD it is Bible §20's weighted draw — you inherit a drone
	// already in flight and you do not choose what state it is in. At the bench
	// it is a request: your machine, your starting position.
	physics.applyEntryState(generateEntryState({
		physics,
		manifest,
		seed: Math.random().toString(16).slice(2, 12),
		maxCategory: entryCategoryCap(),
		...(MODE.bench ? benchEntryRequest(MODE.config) : {}),
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
		hud.progress(`UPLOADING TEXTURES ${i + 1}/${meshes.length}…`, 0.80 + 0.16 * (i / meshes.length));
		await nextPaint();
		renderer.initTexture(meshes[i].material.uniforms.uMap.value);
		// On the GPU, so no longer in RAM (issue #249): these pixels were the
		// page's largest memory item, and a flight page does not survive into the
		// next flight — every reload stacked one more copy of them.
		releaseTexturePixels(meshes[i].material.uniforms.uMap.value);
	}

	// compileAsync() polls the driver's KHR_parallel_shader_compile status every
	// 10ms and only resolves once it reports ready — on drivers that never flip
	// that flag it waits forever. compile() does the same work synchronously and
	// always returns, so use that instead.
	stage('shader-compile');
	hud.progress('COMPILING SHADER…', 0.95);
	await nextPaint();
	renderer.compile(scene, camera);

	// Draw one frame here so any remaining driver-side work happens behind the
	// loading screen rather than as a frozen first frame.
	stage('first-frame');
	hud.progress('FIRST FRAME…', 0.98);
	hud.detail('');
	await nextPaint();
	// The camera onto the machine, entry attitude included — the frame drawn
	// here is then the one flight starts on, and nothing has to snap into place
	// when the loading screen (or the hack screen) lets go.
	placeCamera(0);
	// Through the composer, not the renderer: otherwise the lens pass compiles its
	// shader on the first frame of flight instead of behind the loading screen.
	lens.render(camera, 1 / 60);

	stage('done');

	// The world's weather, not a setting (PHASE 04). The operator's world state
	// has already decided what the weather is over this area today; all that
	// happens here is writing the three models' parameters, which have not
	// changed. The manifest's origin is the scene's exact lat/lon, hence the same
	// zone key the terminal saw before takeoff.
	const o = manifest.origin ?? {};
	// The scene's exact lat/lon: the same one that keys the weather zone, and the
	// only thing the sun's position needs besides the instant. No time zone comes
	// into this — the sun's position is a function of the UTC instant and the
	// place, full stop.
	sun = SunField.forOrigin(o);

	// At the bench the weather does not belong to the world: it belongs to the
	// operator. That is the ONLY place in the game where this is true, and it is
	// why the sliders removed from SETTINGS in PHASE 04 do not come back into
	// SETTINGS — decision D3 holds, the bench is simply outside the world.
	//
	// No worldWeather() in this branch: no server round trip, no snapshot
	// written, no zone key touched. The bench does not consult the world and
	// leaves it nothing.
	if (MODE.bench) {
		// `weather` stays null: that is what the OSD and __sim.debug() read, and
		// there must be no forecast where there is no world.
		weather = null;
		applyBenchConfig();
		console.log('[bench] conditions', benchSimParams(MODE.config));
	} else {
		weather = await worldWeather({ lat: o.latitude, lon: o.longitude });
		const applied = applyWeather(weather, { physics, rain, fog, cloud, sun }) ?? CALM;
		if (weather) {
			console.log(`[weather] ${weather.zone} ${weather.day} (${weather.source}) — `
				+ `${headline(weather.days[0])}`, applied);
		} else {
			// A scene with no known origin: a neutral world rather than invented
			// weather.
			physics.setWeather(CALM.wind);
			rain.setParams(CALM.rain);
			fog.setParams(CALM.fog);
			cloud.setParams(CALM.cloud);
			sun?.setWeather(CALM.sun);
		}
	}

	// This area's materials have just appeared in tileMaterials (loader.js) at
	// their default values (uDim=1, uNight=0): setFog/setDim/setNight has never
	// touched them. The render loop only pushes those on CHANGE
	// (lastDensity/lastSkyHex/lastDim/lastNight below) — if the night was already
	// installed on the previous scene, the value has not changed and those
	// materials stay stuck at their defaults for ever. Invalidating the cache
	// forces the next frame to resynchronise them even when the value itself has
	// not moved since the scene before.
	lastDensity = NaN;
	lastSkyHex = NaN;
	lastDim = NaN;
	lastNight = NaN;

	settings.setAudio(loadVolume(), loadBrightness(), loadMusicVolume(), (volume, brightness, musicVolume) => {
		audio.setVolume(volume);
		audio.setBrightness(brightness);
		music.setVolume(musicVolume);
	});

	applyLensAndLink();

	// Armed under the loading screen: the target is resolved, the camera sits on
	// the machine (entry attitude included), its props are in frame and its OSD
	// is up — all of it before the screen lets go, never after. After the
	// weather, because session.open() carries its snapshot away.
	if (arm) {
		hud.progress('ACQUIRING TARGET…', 0.99);
		await nextPaint();
		await armFlight();
		// A second frame, now that the onboard pass and the OSD exist: their
		// shaders compile here, behind the loading screen, rather than on the
		// first frame of flight.
		lens.render(camera, 1 / 60);
	}

	timeline[timeline.length - 1].ms = Math.round(performance.now() - timeline[timeline.length - 1].at);
	console.table(timeline.map(s => ({ stage: s.name, ms: s.ms })));
	console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);

	exposeDebugGlobal();

	hud.ready();
	// From here the sticks fly the drone: the Settings panel opened in flight no
	// longer listens to the pad (issue #123, see settings.js).
	settings.flightActive = true;
	lastTime = performance.now();
	flightStartTime = lastTime;
	renderer.setAnimationLoop(frame);
	uiAudio.play('TERRAIN_READY');
}

// Convenience wrapper for callers with nothing to hide the load behind
// (?scene=, dev ?family=): runs both halves back to back, same as
// before the PHASE 13 split.
async function boot(slug) {
	return finishBoot(preloadFor(slug));
}

// A constant octree level for this milestone (Global Constraints) — real LOD
// selection by distance/altitude stays a follow-up ticket. 21 is
// ZOOM_TO_LEVEL[20] in google-earth.mjs — the level `add-map`'s default zoom
// produces (CLAUDE.md, --zoom 20), so already the level every existing map
// routinely uses.
const ROCKTREE_LEVEL = 21;

// The attribution the live terrain carries. See the setCredit() call in
// bootLive() for why this is a literal and not creditText().
const LIVE_CREDIT = '© Google';

// The minimal boot for ?live=lat,lon (#168): no manifest, no collision.bin, no
// weather. The ENU origin is fixed ONCE here, at the spawn point — no recentring
// in flight (out of scope, see the spec).
async function bootLive([lat, lon], { arm = true } = {}) {
	// Three independent latencies, OVERLAPPED rather than added up (#21):
	// Rapier's init (a WASM chunk to load and compile), the first rocktree
	// traverse (6 sequential bulk boundaries over the network) and the creation
	// of the Workers (fetch pool + traverse: one module load each, which was
	// only paid at the first fetchNode(), so AFTER the traverse). Before this,
	// bootLive() waited for Rapier before starting anything on the network.
	//
	// The scene path calls initPhysics() inside preloadScene() (before any use
	// of Rapier/Physics) — bootLive() never goes through preloadScene(), so
	// never through that call unless it reproduces it here. Without it, `new
	// Physics(...)` fails immediately (the Rapier WASM module is not
	// initialised), before even the first network request to kh.google.com
	// (#174).
	const physicsReady = initPhysics();
	warmUpTraverseWorker();
	warmUpNodePool();

	const rocktreeWindow = new RocktreeWindow({
		level: ROCKTREE_LEVEL,
		origin: { lat, lon },
		// The view range comes from the Settings slider (#182), from the boot on
		// — starting narrow and widening a frame later would fetch the boot in
		// two waves.
		floorRadiusM: loadViewRange(),
		// The callbacks execute NOTHING (#184): they enqueue, and the real work
		// (build + Rapier bake + texture upload + dispose) is spread out by
		// processLiveNodeWork() under a per-frame budget. Measured before: each
		// node costs only ~1.4 ms, but the pool delivers dozens of them in the
		// same frame — 70 to 330 ms freezes on every wave, with an idle GPU.
		// Neither callback touches `physics`: they can therefore run while
		// Rapier is still initialising (#21).
		onNodeReady: (path, matrix, meshes, sphereRadius) => {
			// `swap`: a mesh is already on screen for this path (`replaced`, or a
			// covered one asked for again) — the swap will wait for the full wave.
			liveQueue.queueBuild(path, { matrix, meshes, sphereRadius }, { swap: liveMeshes.has(path) });
			// The "the window is moving" signal for the digital dome (#198) — at
			// the moment the node is RECEIVED, not when processLiveNodeWork()
			// builds it under budget: the latter can lag several frames behind,
			// and the perceived churn starts as soon as the network delivers.
			fenceDome?.markChurn();
		},
		onNodeReleased: (path, opts) => {
			// `replaced` (#31): the node is still wanted, only its mesh changes
			// and its replacement is already on the way. Remove NOTHING — the
			// build is what swaps, at the full wave (LiveNodeQueue, #75).
			// Otherwise the ground is missing for the whole refetch, and that is
			// the "reloading" ring seen while flying.
			if (opts?.replaced) return;
			// Replaced by another level: held on screen until the full wave, see
			// LiveNodeQueue.
			if (opts?.covered && liveMeshes.has(path)) { liveQueue.queueCovered(path); fenceDome?.markChurn(); return; }
			// Without that flag the release is outright: the queue drops any
			// pending build AND removes what is in the scene (since the swap
			// above, a path can be both at once).
			if (!liveMeshes.has(path)) { liveQueue.dropBuild(path); return; }
			liveQueue.queueRelease(path);
			fenceDome?.markChurn();
		},
	});
	// Primes the window around the spawn before the first frame: without this
	// first call the drone falls through the void until the render loop's first
	// update(). Started HERE, before waiting on Rapier, so the network works
	// while the WASM compiles; awaited further down, just before the loop that
	// watches for the ground.
	const firstWave = rocktreeWindow.update({ lat, lon });

	await physicsReady;
	const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	// A PROVISIONAL position: no terrain is loaded when Physics is constructed.
	// The real spawn point is set on the real ground further down, once the
	// column's first collider arrives (#182) — this value only survives if no
	// ground ever appears (a spawn at sea).
	physics = new Physics(emptyCollision, { x: 0, y: 80, z: 0 },
		{ aero: AERO_MODEL, ...(PROFILE ? { profile: PROFILE } : {}) });
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	// The scene path does this through applyEntryState() (finishBoot(), above) —
	// reset() is its simple case (spawn/identity/zero, already what the
	// constructor sets) but it ALSO calls
	// this.propulsion.primeFor(hoverThrottle(...)), which the constructor alone
	// does not: without it the 4 motors start at omega=0/thrust=0 ("cold") and
	// have to climb through quad.js's realistic motor lag before producing any
	// useful thrust. Measured: even at a sustained throttle of 0.85 from the
	// very first frame, the drone crashes before the motors have caught up — the
	// 80 m of margin above the ground (see the comment above) is eaten by that
	// lag, not by a flaw in the collision mesh.
	physics.reset();

	liveWindow = rocktreeWindow;
	fenceDome = new FenceDome(scene);
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			// Live: the window's circle of confidence, re-read every frame
			// (bounds is mutated, never replaced — the model holds the
			// reference).
			bounds: liveBounds,
		});
		// ?live= is a DEV shortcut: openFlightSession() returns from it
		// immediately, so nobody else would set a scan on this path.
		if (OPTS.live) ambient.setScan({ seed: `dev::${OPTS.live}`, count: 4, index: 0, ...(devSwarm ? { swarmAt: 0, swarmChance: 1, swarm: devSwarm } : {}) });
		swarm = new SwarmDrones({ scene });
		// ?live= leaves openFlightSession() before the swarm is placed: this is
		// where it happens, and only ?swarm= can place one on this path.
		// `?live=` also leaves before the bus is written, so this is where the
		// swarm's presence is set for this path too.
		if (OPTS.live) setSwarmPresent(!!devSwarm);
		if (OPTS.live && devSwarm) { swarm.setSwarm(devSwarm); swarm.reset(physics.position); }
	}
	// Local fog at the window's edge (#198, "hard cut" feedback after checking in
	// flight): live terrain has no other fog (weather is out of scope in
	// ?live=), so scene.fog is entirely free here — its density is pushed every
	// frame by fogDensityFor() below. SkyDome has fog:false and is unaffected.
	scene.fog = new THREE.FogExp2(FENCE_CYAN, 0);
	// An edge fade on THE TERRAIN ITSELF (#202, following #200: the same user
	// feedback — the loaded disc's silhouette still cut sharply against the sky
	// seen from above, because scene.fog above depends only on the DRONE's
	// position, not on whether the fragment being looked at is near the edge).
	// buildNodeMesh() reads this module scope for each new node; set BEFORE
	// RocktreeWindow can deliver its first node.
	liveEdgeUniforms = createLiveEdgeUniforms(FENCE_CYAN);
	// Reveals the "View range" slider (hidden outside live mode) and wires it up:
	// setFloorRadiusM() invalidates the window's position cache, and frame()'s
	// next update() loads the missing ring (or releases the excess) with no
	// restart.
	settings.setViewRange(loadViewRange(), (m) => rocktreeWindow.setFloorRadiusM(m));
	// The first traverse, started right at the top (#21): by here Rapier is ready
	// and the first nodes may already be queued for building.
	await firstWave;

	// Waits for the REAL GROUND before letting the drone go (#182). The ENU
	// origin sits at ellipsoid altitude 0 and the spawn at +80 m — but the
	// terrain is wherever it likes: ~175 ellipsoidal metres at Versailles (a
	// spawn 95 m BELOW the ground, an endless fall), ~79 m at the Champ de Mars
	// (1 m of margin, a 0.5 s race between the fall and the first collider — lost
	// on a cold start as soon as the boot wave grows, see the view-range slider).
	// update() above does NOT wait for the fetches: so watch for the first
	// collider in the spawn's column, then set the spawn point on it. A generous
	// timeout (cold network); past it, the old behaviour is kept rather than
	// blocking the boot for ever (a spawn at sea: no ground will ever come).
	const SPAWN_ABOVE_GROUND_M = 80;
	// The boot waits for the FULL WAVE, not only the spawn's column (#189).
	// Released at the first collider, the drone drifts during its 80 m fall and
	// sometimes lands in a hole that has not been built yet — measured at Lyon:
	// it goes under the map, then the window follows the drone underground,
	// loading and unloading for ever (the "impossible loading"). Incidentally,
	// filling in behind the loading screen at full budget (25 ms) avoids the
	// 10-90 s of drip-feed filling (3 ms/frame) in front of the player. The cap:
	// on a cold start the network can drag, so the drone is eventually released
	// rather than blocking for ever — the ground of ITS OWN column, however, is
	// still required (otherwise a spawn at sea: the old behaviour).
	const BOOT_DEADLINE_MS = 45000;
	const bootDeadline = performance.now() + BOOT_DEADLINE_MS;
	let groundHere = null;
	let waveDone = false;
	// 45 s of nothing is indistinguishable from a hung tab. The loading screen
	// already ticks a clock and names its stage; this wait had no name, so it
	// read as a freeze on every path where the screen is visible (the bench,
	// ?live=). On FIELD the hack screen covers this instead, with its own
	// "searching" phase.
	hud.startClock();
	hud.setStage('terrain');
	hud.progress('WAITING FOR TERRAIN…', 0.5);
	for (;;) {
		// The render loop has not started: nobody else drains the node queues
		// (#184) — without this call no collider would ever appear. The sort by
		// distance puts the node under the spawn in the first wave, so the ground
		// arrives first.
		processLiveNodeWork(25);
		if (groundHere === null) groundHere = physics.groundBelow(0, 3000, 0, 6000);
		waveDone = rocktreeWindow.pendingCount() === 0 && liveQueue.idle();
		if (groundHere !== null && waveDone) break;
		hud.detail(`${rocktreeWindow.pendingCount()} TILES IN FLIGHT — ${groundHere !== null ? 'GROUND FOUND' : 'NO GROUND YET'}`);
		if (performance.now() > bootDeadline) {
			// No ground under the spawn after 45 s means the flight cannot
			// happen: it used to carry on anyway, with no colliders at all, and
			// the anti-hole net then respawned the drone every two seconds into
			// an empty cyan void, for ever, with nothing on screen ever saying
			// why. Reject instead, onto the same failure screen as a blocked
			// tile server — which is the same cause most of the time.
			if (groundHere === null) {
				throw terrainEmptyError(`${rocktreeWindow.pendingCount()} fetches still in flight`);
			}
			// Ground IS there, only the outer wave is late. That flight is
			// playable: the entry draw below tightens itself to the one column
			// whose collision is guaranteed (see liveRadiusM).
			console.warn(`[rocktree] boot released at the 45 s cap — ground found, `
				+ `${rocktreeWindow.pendingCount()} fetches and ${liveQueue.builds.size} builds still in flight`);
			break;
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	hud.detail('');
	if (groundHere !== null) {
		// physics.reset() returns to the spawn AND re-primes the motors —
		// mutating spawn.y first keeps that point correct, above the real ground
		// rather than the ellipsoid, for everything that comes back to it (the R
		// key, and generateEntryState()'s fallback below if its two safety nets
		// both fail).
		physics.spawn.y = groundHere + SPAWN_ABOVE_GROUND_M;

		// The scene path draws its entry through generateEntryState() (Bible
		// §20, finishBoot() above, and its bench counterpart) — bootLive() used
		// to make do with a reset(), which ALWAYS puts down the same point,
		// motors cut, falling vertically: never the "already in flight" entry a
		// baked map gives. The same weighted draw is replayed here (and, like the
		// other two call sites, the bench override — without it a free flight on
		// live terrain silently ignored IDLE or a forced category while the same
		// setting works on a baked map), but bounded to a square inscribed in the
		// disc that has just been waited for: that is the only area whose
		// collision is really in place at this instant, unlike a baked
		// manifest.bbox which covers the whole map. Factor 0.5: the exact
		// inscribed square would be 1/sqrt(2) ~ 0.71 of the radius, and margin is
		// kept against a chunk not quite finished at the edge of the wave —
		// EXCEPT when the wave has precisely not finished (the 45 s cap reached,
		// waveDone still false): that square is no longer guaranteed at all, so
		// it falls back to the one column whose ground is required above (zero
		// radius, x=z=0).
		const liveRadiusM = waveDone ? loadViewRange() * 0.5 : 0;
		const liveManifest = {
			bbox: {
				min: [-liveRadiusM, groundHere - 50, -liveRadiusM],
				max: [liveRadiusM, groundHere + 300, liveRadiusM],
			},
			spawn: { x: 0, y: physics.spawn.y, z: 0 },
		};
		generateEntryState({
			physics, manifest: liveManifest, seed: Math.random().toString(16).slice(2, 12),
			maxCategory: entryCategoryCap(),
			...(MODE.bench ? benchEntryRequest(MODE.config) : {}),
		});
	} else {
		console.warn('[rocktree] no ground under the spawn — keeping the ellipsoidal spawn');
	}

	// The scene path sets this in finishBoot() (with an extra ceiling search for
	// spawns under a bridge — out of scope here). frame() reads emitter.x/y/z
	// with NO guard, outside the `if (!frozen)` block (obstructionBetween, for
	// the link) — left at `null` (its starting value) it throws on the very first
	// frame. If there is no collider exactly below (x=0, z=0), fall back to the
	// spawn point itself rather than null.
	emitter = { x: 0, y: (groundHere !== null ? groundHere : physics.spawn.y) + ANTENNA_HEIGHT, z: 0 };

	// The bench's conditions, in free flight (PHASE 26).
	//
	// This path does not go through finishBoot(), so nothing finishBoot() sets
	// exists here: without these three lines the WHOLE bench conditions panel
	// was silently ignored — and worse, the first time the panel was opened in
	// flight (B key) applyBenchConfig() made the weather appear all at once, in
	// the middle of the flight.
	//
	// `?live=` on its own does not change: it stays without weather or sun,
	// which is its acknowledged out-of-scope (#168). Here the lat/lon is real and
	// comes from the operator, so the sun is legitimate — it is the same
	// construction as the scene path, from the same data.
	// The same holds for FIELD reconnaissance: there the lat/lon comes from the
	// rectangle the operator has just drawn, so it is every bit as real as at the
	// bench. applyBenchConfig() stays the bench's — there is no config to apply
	// here, and it guards itself on MODE.bench.
	if (MODE.bench || MODE.live) {
		sun = SunField.forOrigin({ latitude: lat, longitude: lon });
		applyBenchConfig();
	}

	// The flight loop: frame() reads fence.*/controller.* with no guard anywhere
	// (it always assumes a complete baked scene) — so ?live= mode has to hand it
	// real instances rather than leave them null. A Geofence with an outsized
	// bbox: the REAL tested code (not a stub), but sized never to engage (scale
	// tops out at 1, and the drone never comes near an edge 1000 km away) — the
	// zone stays NOMINAL and the push stays nil. Consistent with the plan's
	// explicit out-of-scope ("no Geofence" in live mode): it exists only so
	// frame() does not crash, and it never acts.
	fence = new Geofence({ min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] });
	// `benchRates` carries the individual's rates when there is one: the bench
	// sets them from its drawn airframe, a live flight from its target (#218) —
	// bootLive() builds its own controller, so in both cases they have to be set
	// BEFORE the call. With no individual (bare ?live=), `opts.rates` is optional
	// in flightController.js and falls back to RATE_PRESETS[this.preset].
	controller = new FlightController({
		profile: PROFILE,
		rates: benchRates ?? undefined,
		throttle: benchThrottle ?? undefined,
	});

	// LEGAL, not polish. Google requires the copyright of the imagery it serves
	// to be displayed wherever that imagery is rendered, and the live terrain IS
	// Google's imagery. finishBoot() sets this from the baked manifest's own
	// provider block — but the baked path is the one a stranger cannot take: a
	// fresh clone has no terrain on disk, so LIVE is the ONLY thing it can fly,
	// and LIVE was showing Google's photogrammetry with no attribution at all.
	//
	// The literal rather than creditText(): there is no manifest here, and the
	// per-node copyrightIds that rocktree-worker.js decodes are still dropped by
	// the pool (they would need the bulk's copyright string table to become
	// text). '© Google' is what the imagery is, and it is what has to be on
	// screen; resolving the per-node ids is a refinement of a credit that is
	// now correct, not a fix for one that is missing.
	fpvtpOsd.setCredit(LIVE_CREDIT);

	// The video link's picture degradation, the lens, the shutter (#120). The
	// baked path applies these in finishBoot(); without this call LIVE and the
	// bench flew with lens.js's uLink pinned at 1 — no tearing, no dropouts,
	// none of the thing the whole link model exists to show.
	applyLensAndLink();

	audio.start();
	// The camera onto the machine before the first frame (#122), on every path and
	// whoever arms the flight. Without it it stays at the ENU origin —
	// ellipsoid altitude 0, so UNDER the terrain — and what appears is the map
	// seen from below. The scene path gets this from its own first-frame stage.
	placeCamera(0);
	// `?live=` is a dev shortcut that mounts neither target nor OSD (see
	// openFlightSession()): it only ever had its camera to place.
	if (arm) {
		if (OPTS.live) setView('fpv');
		else await armFlight();
	}
	renderer.compile(scene, camera);
	hud.ready();
	// window.__sim must exist before the first frame: it is what every browser
	// check in this repo reads (Task 11 included).
	exposeDebugGlobal();
	// Without this, frame() is never scheduled in ?live= mode — the drone never
	// flies and the screen stays frozen. A mirror of finishBoot()'s last gesture
	// on the scene path, including the two lines that precede it there and were
	// missing here:
	//  - flightActive: otherwise the Settings panel keeps eating the pad in
	//    flight (issue #123, see settings.js);
	//  - lastTime: without this reset the first frame measures dt since the
	//    module loaded (seconds), clamped to 0.25 s — a 250 ms gust of physics
	//    all at once on the very first step.
	settings.flightActive = true;
	lastTime = performance.now();
	flightStartTime = lastTime;
	renderer.setAnimationLoop(frame);
}

// Yields long enough for the loading screen to actually repaint.
function nextPaint() {
	return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}

// `action` is an ACTION ID from src/key-map.js (D13), not a key: the bindings
// live in the map, and Escape / Enter / Tab arrive raw because they stay fixed.
input.onAction = (action, event) => {
	// No respawn: a drone you have lost does not come back.
	// terrain persistent, flights ephemeral.
	//
	// Except at the bench, where there is nothing to bring back: the machine is
	// local, and putting it right is not a rewind. The key exists ONLY there —
	// FIELD gains nothing, not even an inert key to discover.
	if (MODE.bench && action === 'respawn') { respawn(); return; }
	if (MODE.bench && action === 'benchPanel') { event.preventDefault(); toggleBenchPanel(); return; }
	if (action === 'pause') { event.preventDefault(); togglePause(); }
	else if (action === 'cyclePreset') controller?.cyclePreset();
	else if (action === 'cycleMode') controller?.cycleMode();
	else if (action === 'view') setView(viewMode === 'fpv' ? 'chase' : 'fpv');
	else if (action === 'photo') pendingCapture = true;
	// Turtle mode (#105). A press, not a hold: this destroys nothing, and
	// turtle.js refuses of its own accord until the machine is on its back and
	// still — so the key is inert everywhere else. Set rather than accumulated:
	// a press during a pause must not fire when play resumes.
	else if (action === 'turtle') turtlePressed = flightEnd.phase === FLYING;
	else if (action === 'tab') { event.preventDefault(); settings.toggleSettings(); }
	else if (action === 'escape' && settings.settingsOpen) settings.toggleSettings(false);
	// The player leaves control themselves: nothing takes them out of it. Enter
	// is the key the line names (#71): under pointer lock, and all the more in
	// browser fullscreen, Escape is confiscated to hand the cursor back and never
	// delivers a keydown to the page (browser behaviour, not a bug — see the
	// click below for the same reason). Escape is still accepted as a silent
	// duplicate: it works when nothing confiscates it.
	else if ((action === 'escape' || action === 'enter') && flightEnd.out.exitArmed) finishSession();
	// #253: REDEPLOY, keyboard only (like the bench keys above) — the pad keeps
	// its "any button disconnects" gesture below. FIELD only: at the bench 'r'
	// already respawns (the guard at the very top of this handler).
	else if (action === 'respawn' && flightEnd.out.exitArmed && !flightExit.busy) finishSession({ redeploy: true });
};

// #253: the sessionStorage key carrying a REDEPLOY's zone across the page
// reload finishSession() triggers. sessionStorage and not localStorage: it must
// not survive the tab closing, and must never leak into another tab open on a
// different area.
const QUICK_RESTART_KEY = 'fpvtp.quickRestart';

function consumeQuickRestart() {
	try {
		const raw = sessionStorage.getItem(QUICK_RESTART_KEY);
		sessionStorage.removeItem(QUICK_RESTART_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

// Hand the terminal back. There is no big end screen any more (D9,
// 2026-09-08: landing is gone, and POST-FLIGHT ANALYSIS with it) — a flight
// ends in a crash, a coverage exit or a cut link, and none of those three ever
// had a debrief screen (Bible §24).
// #253: { redeploy: true } leaves the flight's zone in sessionStorage so that
// chooseScene(), after the reload, drops straight back into that zone's
// TARGET SCAN.
// #247: the debounce in operator.patch() (settings, dialogueMemory, coverage)
// has no guarantee against the reload — only a flush resolved before leaving
// has one. That flush is best-effort, and flight-exit.js is what makes
// "best-effort" true of a server that never answers, not only of one that
// refuses.
function finishSession({ redeploy = false } = {}) {
	if (flightExit.busy) return;
	// The flight is over: the flag that says "the sticks fly the machine" must
	// stop saying it. The reload clears it anyway, but Settings reads it in the
	// meantime (gamepad nav, and the REPLAY BRIEFING button of F2).
	settings.flightActive = false;
	if (redeploy && lastZone) {
		try { sessionStorage.setItem(QUICK_RESTART_KEY, JSON.stringify(lastZone)); } catch {}
	}
	flightExit.run();
}

renderer.domElement.addEventListener('click', () => {
	// Safety net for ?scene=<slug>, which skips the menu and therefore skips the
	// only other user gesture we get. start() is idempotent.
	audio.start();
	// [ENTER] DISCONNECT on a click: a click is a gesture the page is guaranteed
	// in browser fullscreen, where Escape is not (confiscated to leave fullscreen
	// itself — see the exitPointerLock comment below). A player who has just
	// crashed in fullscreen therefore always has a way out.
	if (flightEnd.out.exitArmed && !flightExit.busy) { finishSession(); return; }
	// Once the flight is over the cursor is not taken back: re-locking it would
	// hand Escape back to the browser (see the pointer lock release when the
	// session closes), and there is nothing left to fly.
	const flying = flightEnd.phase === FLYING;
	if (flying && !settings.settingsOpen) renderer.domElement.requestPointerLock();
});

// PHASE 16: reads the composer's canvas exactly as it has just been painted —
// the target sensor's resolution and aspect, the drone OSD, the link
// degradation, the rain and the fog all already in it, the FPVTP! DOM overlay
// never in it. `toBlob` reads the buffer at call time, so no
// `preserveDrawingBuffer` is needed: it is called synchronously in the same
// frame as the render, before anything else is drawn.
async function capturePhoto() {
	const cap = await lens.capture();
	if (!cap) return;

	// At the bench the image goes straight to the operator's disk and NOWHERE
	// else: no session, no server, no log. "Nothing here is logged" is about what
	// FPVTP! records, not about what you take away — and dumping a frame to a
	// file is the right gesture at a bench anyway, where a field flight writes a
	// report instead.
	// The same gesture on reconnaissance: with no session open,
	// session.capturePhoto() would have nowhere to write and would fail in
	// silence. What you take away goes to the operator's disk, as at the bench.
	if (MODE.bench || MODE.live) {
		const url = URL.createObjectURL(cap.blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
		a.click();
		// Revoked on a later turn: revoking at once would cut the URL out from
		// under the download the click has only just started.
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
		fpvtpOsd.flashCaptured(null);
		return;
	}

	const reader = new FileReader();
	reader.onload = () => {
		session.capturePhoto({ dataUrl: reader.result, w: cap.w, h: cap.h })
			.then((count) => fpvtpOsd.flashCaptured(count));
	};
	reader.readAsDataURL(cap.blob);
}

function respawn() {
	if (!physics) return;

	// terrain persistent, flights ephemeral: after a crash the drone is gone, and
	// you do not reappear on the spot — back to the terminal. In ?scene= mode
	// (dev) the local respawn is kept so as not to break the debug flow.
	//
	// And at the bench (PHASE 26), where there is nothing to lose: NO LOSS.
	// FIELD's rule is not relaxed, it simply does not apply — there is no remote
	// machine here, so no remote machine to lose.
	if (crashed && !OPTS.scene && !MODE.bench) { location.href = location.pathname; return; }
	fpvtpOsd.setSessionStatus(null);
	controller.arm();
	// In free flight there is no manifest: no bbox to draw a point from, no spawn
	// to copy. generateEntryState() would throw there on manifest.spawn.
	// physics.reset() is exactly what bootLive() uses — it returns to the spawn
	// AND re-primes the motors, which the constructor alone does not.
	if (!sceneManifest) {
		physics.reset();
	} else {
		physics.applyEntryState(generateEntryState({
			physics,
			manifest: sceneManifest,
			seed: Math.random().toString(16).slice(2, 12),
			maxCategory: entryCategoryCap(),
			...(MODE.bench ? benchEntryRequest(MODE.config) : {}),
		}));
	}
	link.reset();
	// The machine has just been put right: a flip in progress has no object any
	// more, and its torque must not survive the jump.
	turtle.reset();
	// For the HYSTERESIS, and for it alone: without this reset, zoneOf() would
	// judge the first post-respawn frame by the previous zone. The link's loss is
	// already gone — link.reset() (just above) puts _terminalLoss back to zero,
	// and fence.update() recomputes lossDb within the frame.
	fence.reset();

	// Neither model was being reset here, and both say in their own comments
	// that they should be: a respawn should not drop you back into the squall
	// or the bank that just blinded you.
	rain.reset();
	fog.reset();
	cloud.reset();

	controller.setMode(controller.mode);   // also clears the PID integrators
	input.resetKeyboardThrottle();
	crashed = false;
	// A new life starts back behind the goggles (D11): the view is a state OF
	// the flight, not of the session.
	setView('fpv');
	// The sky withdraws too: the ambients from before the respawn were born
	// around a flight point that no longer exists (issue #250).
	ambient?.reset();
	// And the swarm settles back onto the player: its wake has just been
	// invalidated by the same jump (issue #29).
	swarm?.reset(physics.position);
}

function togglePause(force) {
	// Space during the Control Vector (introFrozen) still arrives here — the
	// freeze stops the physics, not the keys. Ignoring the manual toggle over
	// that window avoids landing in a flight that is already paused.
	if (force === undefined && performance.now() - flightStartTime < PAUSE_GUARD_MS) return;
	paused = force ?? !paused;
	// Coming back should not replay the wall-clock gap as one giant physics step.
	if (!paused) { accumulator = 0; lastTime = performance.now(); }
	fpvtpOsd.setPaused(paused);
}

// D11 — the view toggle. The chase camera is the FLIGHT camera, re-placed:
// nothing is built here, so it works on every boot path (LOCAL, LIVE, BENCH)
// and the simulation keeps running behind it. That is the whole point of
// replacing the old OrbitControls free cam, which froze the world to look at it.
function setView(mode) {
	viewMode = mode === 'chase' ? 'chase' : 'fpv';
	// Snap on the next frame rather than sweeping in from the FPV position,
	// which sits inside the machine.
	chasePos = null;
	// Full machine in chase, props-in-frame onboard pass in FPV. The second
	// lens.js pass is unplugged as soon as we are no longer behind the goggles.
	playerDrone?.setChase(viewMode === 'chase');
	lens.setOnboard(viewMode === 'chase' ? null : playerDrone?.onboardScene, playerDrone?.onboardCamera);
	// V6 — the TARGET's own OSD is what its goggles show, so it belongs to the
	// video feed and to nothing else. Composited in chase it labelled an
	// outside camera with the machine's own voltage and battery bar. Same
	// exclusivity as the onboard pass, and the FPV wiring is one line below.
	lens.setOsd(viewMode === 'chase' ? null : droneOsd);
	// V6 — and neither does chase wear the target's wide lens. At the 120° the
	// flight camera carries, a 5-inch machine a metre away is a mark on the
	// sky. A cap, not a value: a narrower target keeps its own field, and the
	// flight FOV comes straight back with the goggles.
	const fov = viewMode === 'chase' ? Math.min(cameraFov, CHASE.fovDeg) : cameraFov;
	if (camera.fov !== fov) {
		camera.fov = fov;
		camera.updateProjectionMatrix();
		rainfall?.setSize(innerHeight * renderer.getPixelRatio(), fov);
	}
	// The same gesture with the mouse as with the key.
	fpvtpOsd.setView(viewMode, () => setView(viewMode === 'fpv' ? 'chase' : 'fpv'));
	// Placed at once rather than on the next physics frame: the toggle must
	// answer even while the sim is frozen (pause, settings), where the frame
	// loop skips the camera block entirely.
	placeCamera(0);
}

const _fwd = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Where the flight camera stands this frame. FPV rides the body; CHASE stands
// behind the heading and looks back at the machine — the wreck that is still
// rolling included.
function placeCamera(dt) {
	if (!physics) return;
	const p = physics.position;
	const r = physics.rotation;
	_camQ.set(r.x, r.y, r.z, r.w);
	if (viewMode === 'chase') {
		const desired = chaseTarget(p, droneYaw(_camQ));
		chasePos = chasePos ? chaseStep(chasePos, desired, dt) : desired;
		camera.position.set(chasePos.x, chasePos.y, chasePos.z);
		camera.lookAt(p.x, p.y, p.z);
	} else {
		camera.position.set(p.x, p.y, p.z);
		// Camera uptilt, applied in the drone's own frame.
		_tilt.setFromAxisAngle(X_AXIS, cameraTilt * Math.PI / 180);
		camera.quaternion.copy(_camQ).multiply(_tilt);
	}
}

// Heading of the nose about +Y, from the body quaternion. The flight camera
// looks down the body's -Z, so that axis is the nose.
function droneYaw(q) {
	_fwd.set(0, 0, -1).applyQuaternion(q);
	// Nose straight up or down: no horizontal component to read. Hold the last
	// heading instead of whipping the camera to an arbitrary one.
	if (Math.hypot(_fwd.x, _fwd.z) > 1e-4) chaseYaw = Math.atan2(_fwd.x, -_fwd.z);
	return chaseYaw;
}

// Physics does not advance when the sim is paused or the settings panel is up —
// so the motor speeds freeze and a held drone note would be worse than silence.
// CHASE view is not in that list: the simulation keeps running behind it (D11).
// Roll and pitch, for the drone OSD's artificial horizon. The heading that goes
// with them comes from src/bearing.js: every bearing this file publishes is
// built there, in one convention, rather than re-derived per readout.
function rollOf(q) {
	return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.z * q.z + q.x * q.x));
}
function pitchOf(q) {
	return Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z))));
}

// The latitude/longitude shown by the OSD of targets that have GPS. A flat
// approximation, which is more than enough over a two-kilometre scene. A scene
// with no known origin has no coordinates: the OSD then shows dashes rather than
// a plausible point off the coast of Africa.
function latLonOf(p) {
	const o = sceneManifest?.origin;
	if (!o || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) {
		return { lat: NaN, lon: NaN };
	}
	const lat = o.latitude + (-p.z) / 111320;
	return { lat, lon: o.longitude + p.x / (111320 * Math.cos(lat * Math.PI / 180)) };
}

// The drone's geographic position for coverage (issue #245), baked or live, one
// single way out: { lat, lon }, possibly NaN — session.feed() is what ignores a
// non-finite result.
//
// - baked terrain: latLonOf(), the flat approximation already judged sufficient
//   over a two-kilometre scene;
// - live: the same ENU -> ECEF -> geodetic conversion the streaming window
//   already does every frame above (#182 for the NaN guard, which lives on the
//   session side).
//
// Called ONLY at the samples (5 Hz): session.feed() receives the function, not
// the value.
function droneGeo(p) {
	if (liveWindow) {
		const ecef = localEnuToEcef(p, liveWindow.originEcef, liveWindow.originBasis);
		const g = ecefToGeodetic(...ecef);
		return { lat: g.lat, lon: g.lon };
	}
	return latLonOf(p);
}

// The view mode is NOT in here: chase view keeps the simulation running (D11).
function simFrozen() { return paused || introFrozen || settings.settingsOpen || benchPanelOpen; }

// The fog uniforms live on every chunk material, so they are written only when
// they have actually moved rather than five times a frame for no change. Both
// halves are watched: the fog can thicken without the sky changing colour once
// the mix has saturated, and the rain can recolour the sky at a density the
// fog has already settled on.
let lastDensity = -1;
// The same extinction, without the -1 sentinel: this is the one the ambient
// drones (#250) copy into their own material, which deliberately duplicates
// TileMaterial.js's formula.
let lastFogDensity = 0;
let lastSkyHex = -1;
let lastDim = 1;
let lastNight = 0;
// The lens exposure, mirrored here because the streak length is that exposure
// times the relative speed — the translational half of the motion blur that the
// lens pass, which only reprojects rotation, cannot reconstruct.
let lensShutter = 0;

// Where a bead sitting on the front element is being pushed, in g and in the
// plane of the lens. Written once a frame into the same object rather than
// allocated, like every other per-frame vector here.
const drift = { x: 0, y: 0 };
// The sun's state between frames, and the vectors reused rather than
// reallocated — the same rule as `drift` just above.
let sunVisible = 1;    // 0..1, smoothed occlusion
let sunInFrame = 0;    // 0..1, how much of the disc the light meter sees
const _sunWorld = new THREE.Vector3();
const _sunView = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camInv = new THREE.Quaternion();
const _sunColor = new THREE.Color();

// What the last link measurement cost and what it found, for __sim.debug().
const linkState = { distance: 0, blocked: false, span: 0, rayMs: 0 };

// The first flight is over the moment its session closes — whatever closed it.
// Written once: a second call is a no-op, and a bench flight never gets here.
function endOfFirstFlight() {
	if (!hintFlight) return;
	hintFlight = false;
	fpvtpOsd.setHint(null);
	markFirstFlight(localStorage);
}

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;

	// `frozen` FIRST: it governs how the inputs are read (issue #33). The
	// keyboard throttle is an integrator, and integrating it while the
	// simulation is frozen arms the drone behind the player's back — typing in
	// the remap panel was enough to run the throttle to full.
	const frozen = simFrozen();

	// The drone's OSD is mounted BEFORE the flight (armFlight()), so it is
	// already on screen under the last hack screen — which is the point: the
	// randomart fades onto it. But its clock is a wall clock, and the freeze
	// has no defined length: the [ JACK IN ] prompt waits for the player as
	// long as they want. So the start stays pinned to now for as long as the
	// freeze holds; openFlightSession() sets it one last time when control is
	// handed over. Without this the revealed OSD showed the time spent in the
	// hack, then jumped back to zero.
	if (introFrozen) sessionStartedAt = Date.now();

	const sticks = window.__simInput ?? input.update(dt, { frozen });
	audio.setMuted(frozen);

	// STREAMING is not simulation: it carries on while paused, with the settings
	// panel up or the intro frozen (#31). Under the `if (!frozen)` above, a pause
	// froze `processLiveNodeWork()`: the build queue stayed full and the world
	// stayed half built until play resumed. Measured: 478 queued builds blocked,
	// 79 % of the ground missing for the WHOLE pause, all of it back 1.2 s after
	// resuming. And a pause is exactly when you look at the landscape — and
	// photograph it. Nothing in here advances the world: the drain puts meshes
	// and colliders onto a world that is not stepping, and the window recompute
	// starts from the drone's position, which is still while paused (update()
	// returns at once under REFRESH_THRESHOLD_M). The anti-hole net (#189) does
	// stay frozen: it does a respawn, which a pause must never trigger.
	if (liveWindow) {
		// Spreads the work of received/released nodes under budget (#184).
		processLiveNodeWork();
		// Never blocks the render frame: the window recomputes in the
		// background, and the current frame flies with what is already there.
		// physics.position (local ENU metres) -> lat/lon: the exact inverse of
		// the conversion build-node.mjs does the other way.
		const dronePos = physics.position;
		const droneEcef = localEnuToEcef(dronePos, liveWindow.originEcef, liveWindow.originBasis);
		const droneGeo = ecefToGeodetic(...droneEcef);
		// A guard (#182): a degenerate position (the drone gone under the
		// terrain during a fall, measured at y=-2465 m at Versailles) makes
		// ecefToGeodetic return NaN — and update({lat:NaN}) then aborts the
		// WHOLE window in silence (a NaN zone -> 0 desired nodes -> everything
		// released), a permanent freeze of the streaming. Better to freeze the
		// WINDOW on its last sane position than to empty it.
		if (Number.isFinite(droneGeo.lat) && Number.isFinite(droneGeo.lon)) {
			// Nothing awaits this promise (that is the point: the frame does not
			// block on it) — without .catch(), a network failure or a traverse
			// that throws becomes a silent unhandled promise rejection.
			// Observability only: no retry here (follow-up ticket).
			liveWindow.update({ lat: droneGeo.lat, lon: droneGeo.lon })
				.catch((err) => console.warn('[rocktree] streaming window: recompute failed', err));
		}
	}

	let crashedThisFrame = false;
	let peakImpact = 0;
	if (!frozen) {
		// Touchdown: in airmode a quad does not settle on its own — the motors
		// idle, the slightest tilt on contact sends it back up, and a collision
		// sphere with angular velocity rolls for ever (no sliding at the contact
		// point, so friction does not slow it). The wind, meanwhile, keeps
		// pushing it. When the pilot has cut the throttle and the drone is
		// skimming the ground, the motors are cut and physics.setGroundHold
		// pins the rest: no more wind, no more drift.
		// The "throttle cut" threshold is the flown family's, not a constant:
		// see idleThrottle() in quad.js. This block survives the removal of
		// landing (D9, 2026-09-08) — it is the physical feel of resting on the
		// ground (#69), not an end of flight.
		const pp = physics.position;
		const gb = physics.groundBelow(pp.x, pp.y, pp.z);
		const touchdown = controller.armed && sticks.throttle < idleThrottle(physics.profile)
			&& gb !== null && (pp.y - gb) < 0.6;
		physics.setGroundHold(touchdown);

		accumulator += dt;
		// Normally exactly FIXED_STEP, so an unstalled frame steps the world on
		// the same 250 Hz grid it always did, bit for bit. Only once the backlog
		// exceeds what MAX_STEPS_PER_FRAME steps of 1/250 s can pay off does the
		// step stretch, and only as far as MAX_CATCHUP_STEP — see its comment.
		const h = catchUpStep(accumulator);
		let steps = 0;
		// The controller substep: `hc` is h at CONTROL_SUBSTEPS == 1, exactly,
		// so the default loop divides nothing and runs the arithmetic it always
		// ran.
		const hc = CONTROL_SUBSTEPS === 1 ? h : h / CONTROL_SUBSTEPS;
		while (accumulator >= h && steps < MAX_STEPS_PER_FRAME) {
			// Several controller iterations per physics step, on a zero-order
			// hold of the body state — which is what the hardware does too: the
			// ESC holds the last DSHOT frame for the whole interval, and the
			// airframe does not actually rotate at the frequencies the gyro
			// reports. The LAST substep's motor command is the one the physics
			// integrates; the earlier ones exist so the filters, the notches and
			// the noise live at the loop's own rate.
			let motors;
			for (let c = 0; c < CONTROL_SUBSTEPS; c++) {
				({ motors } = controller.update(sticks, physics, hc));
			}
			// Assisted turtle mode (#105). It reads the PREVIOUS frame's `stuck`
			// — flightEnd.update() runs after this loop — and that is harmless:
			// stillness is measured over four seconds, and one frame of lag does
			// not move it. Never on a wreck: a dead machine does not flip.
			const q = physics.rotation;
			const up = rotateVec(q, 0, 1, 0);
			turtle.update({
				dt: h,
				armed: controller.armed && !flightEnd.out.linkDead,
				stuck: flightEnd.out.stuck,
				pressed: turtlePressed,
				up,
				angularVelocity: physics.angularVelocity,
				inertia: flipInertia(physics.profile),
				maxTorque: maxRollTorque(physics.profile),
			});
			turtlePressed = false;
			// A flip is not a flight: the motors go quiet while the torque does
			// the work. And the ground hold releases — the damping that stops
			// the sphere rolling for ever would fight exactly the movement being
			// asked for.
			if (turtle.out.active) {
				motors.fill(0);
				physics.setGroundHold(false);
			}
			if (touchdown && !turtle.out.active) motors.fill(0);
			// The fence reads THIS step's position, and its force leaves IN this
			// step: physics.step() begins with resetForces(), so an addForce
			// called from here would be wiped without ever being integrated.
			// Hence the third parameter rather than a separate call.
			fence.update(physics.position);
			let fenceForce = null;
			// `!linkDead`: a wreck has no failsafe left. Without this the push
			// keeps shoving a disarmed drone — measured, it carried the wreck
			// from 71 m outside to 239 m inside, at 22 m/s, and dropped `over`
			// behind it (#150). The screen did not show it (linkDead forces
			// DEAD_LINK at render time), but the world did it.
			//
			// No risk of cutting the push too early: flightEnd.update() runs
			// AFTER this loop, so the frame in which the boundary is crossed
			// still applies its force, and linkDead only rises in the same frame
			// where main.js disarms the controller. One frame late, never
			// early.
			if (fence.out.zone !== FENCE_OK && !flightEnd.out.linkDead) {
				// push is an ACCELERATION (m/s^2, capped at A_MAX): Rapier wants
				// newtons, so multiply by the machine's REAL mass — not the
				// default profile's. A heavy drone is pushed back as firmly as a
				// light one.
				const a = fence.out.push, m = physics.profile.mass;
				_fenceForce.x = a.x * m; _fenceForce.y = a.y * m; _fenceForce.z = a.z * m;
				fenceForce = _fenceForce;
			}
			if (liveWindow) {
				const dronePos = physics.position;
				const centerLocal = liveWindow.windowCenterLocal;
				if (centerLocal) {
					const dist = Math.hypot(dronePos.x - centerLocal.x, dronePos.z - centerLocal.z);
					const a = rocktreeFencePush(dist, liveWindow.nearestTrustedRadius());
					if (a > 0) {
						const dx = dronePos.x - centerLocal.x, dz = dronePos.z - centerLocal.z;
						const len = Math.hypot(dx, dz) || 1;
						const m = physics.profile.mass;
						// fenceForce may already have been set by the area push
						// above (scene mode); in ?live= mode the fence is always
						// NOMINAL (no real Geofence built), so fenceForce is still
						// null here — the two pushes never add up.
						_fenceForce.x = -(dx / len) * a * m;
						_fenceForce.z = -(dz / len) * a * m;
						_fenceForce.y = 0;
						fenceForce = _fenceForce;
					}
				}
			}
			const impact = physics.step(motors, h, fenceForce,
				turtle.out.active ? turtle.out.torque : null);
			// NO LOSS (PHASE 26): at the bench an impact is still an impact — the
			// physics is not negotiable, the machine takes it, tumbles and stops.
			// But nothing is lost, so nothing dies: not the picture, not the
			// sound, not the session. One key starts you again.
			//
			// It really is FIELD's rule that does not apply, not a relaxed rule:
			// "the drone is destroyed" presupposes a remote drone that belongs to
			// somebody, and there is none here.
			if (impact > 0 && !flightEnd.out.linkDead && !crashed && !MODE.bench) {
				const r = physics.rotation;
				if (impact > crashThreshold(r)) {
					crashedThisFrame = true;
					crashed = true;
					// The drone is destroyed. The session closes on CRASHED — the
					// terrain stays. terrain persistent, flights ephemeral.
					fpvtpOsd.setSessionStatus('TARGET LOST<small>SESSION TERMINATED</small>', 'lost');
					session.end('CRASHED').then((s) => s && console.log('[session] CRASHED', s));
					endOfFirstFlight();
				}
			}
			if (impact > peakImpact) peakImpact = impact;
			accumulator -= h;
			steps++;
		}
		// The backlog outran even the stretched budget (a frame longer than
		// MAX_STEPS_PER_FRAME * MAX_CATCHUP_STEP): drop what is left rather than
		// carry it into the next frame and spiral.
		if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

		// ONCE per FRAME, outside the accumulation loop (#187): inside the loop
		// this block ran once per physics STEP — while catching up (12-15
		// steps/frame after a long frame) it executed 12-15 times in the same
		// frame. The fence push does stay per step: it depends on the position,
		// which changes at every step. The drain and the window recompute have
		// left this guard (#31): see the `if (liveWindow)` block above, outside
		// `!frozen`.
		if (liveWindow && !frozen) {
			// The anti-hole net (#189): Google Earth terrain has REAL holes —
			// missing nodes (404, a normal result of the protocol) produce no
			// geometry at all, and the water of Marseille's Vieux-Port is one
			// several hectares across. A drone that slides or flies into one
			// falls UNDER the map for ever, and the window follows it,
			// loading and unloading in a loop (measured: the "impossible
			// loading"). The criterion: a clean fall (vy < -20, ~2 s of free
			// fall) AND nothing below down to -6 km — a real valley always has
			// ground under it, a hole does not. Water therefore becomes a
			// crash-respawn, which is consistent with real FPV.
			{
				const p = physics.position;
				if (physics.body.linvel().y < -20 && physics.groundBelow(p.x, p.y + 2, p.z, 6000) === null) {
					console.warn('[rocktree] drone fell into a hole in the map (missing node) — respawn');
					physics.reset();
					flightEnd.reset();
					turtle.reset();
				}
			}
		}

		// One ground raycast per physics frame. Frozen, nothing has moved: the
		// last groundY stays correct, and there is no point redoing a full-mesh
		// test for nothing.
		const fp = physics.position;
		groundY = physics.groundBelow(fp.x, fp.y, fp.z);

		// The acoustics of the place follow the real geometry (issue #122). They
		// re-read the rosette the physics step has just cast for the wind shadow:
		// no extra rays. Frozen, nothing is touched — the place has not changed,
		// and a reverb drifting during a pause would be audible.
		space.update(physics.probe);

		placeCamera(dt);
	}

	// The player's drone (issue #264). AFTER the camera, like the ambients, and
	// BEFORE them: both are cut from the same cloth, so they may as well be lit
	// in the same breath. Frozen, dt = 0 — the shader's time does not drift
	// during a pause.
	//
	// The sun, the dimming, the fog and the resolution are EXACTLY those passed
	// to the ambients just below: a machine that darkened differently from the
	// ones around it would show.
	// Mutated, not replaced: the onboard view re-reads this field every frame.
	playerCam.fov = camera.fov;
	playerCam.aspect = camera.aspect;
	playerDrone?.update({
		dt: frozen ? 0 : dt,
		position: physics.position,
		quaternion: physics.rotation,
		omega: physics.propulsion.omega,
		camera: playerCam,
		sun, dim: cloud.dim,
		fogColor: scene.background, fogDensity: lastFogDensity,
		resolution: ambientRes,
	});

	// The ambient drones (issue #250). AFTER the camera: they are born outside
	// the frame, so the model wants THIS frame's orientation, not the previous
	// one's. Frozen, dt = 0 and the voices go quiet — but update() still runs,
	// without which setMuted() would no longer aim at any AudioParam.
	if (ambient) {
		if (liveWindow) {
			const c = liveWindow.windowCenterLocal;
			liveBounds.center = c;
			liveBounds.trusted = liveWindow.nearestTrustedRadius();
		}
		ambient.setMuted(frozen);
		ambient.update({
			dt: frozen ? 0 : dt,
			player: physics.position, playerVel: physics.velocity, camera,
			wind: physics.wind.out, rays: physics,
			top: sceneManifest ? sceneManifest.bbox.max[1] + 50 : physics.position.y + 300,
			span: sceneManifest ? (sceneManifest.bbox.max[1] - sceneManifest.bbox.min[1]) + 100 : 3000,
			fogColor: scene.background, fogDensity: lastFogDensity, sun,
			// `cloud.dim`, not `sun.ambient`: the ambients darken like the tiles
			// (setDim below). Absolute exposure is the lens AGC's business, not
			// a material's.
			dim: cloud.dim,
			resolution: ambientRes,
		});
	}

	// The swarm (issue #29). After the camera block like the ambients, and before
	// lens.render: its output goes through the lens like everything else. It
	// touches NOTHING — no Rapier body, no collision, no target, no wear; frozen,
	// dt = 0 and the model does not take a step.
	if (swarm?.model) {
		if (liveWindow) {
			swarmFence.center = liveWindow.windowCenterLocal;
			swarmFence.radius = liveWindow.nearestTrustedRadius();
		}
		if (!frozen) swarmClock += dt;
		// Frozen, dt = 0 and the voices go quiet — but update() still runs,
		// without which setMuted() would no longer aim at any AudioParam.
		swarm.setMuted(frozen);
		swarm.update({
			dt: frozen ? 0 : dt,
			player: physics.position, playerVel: physics.velocity, camera,
			time: swarmClock,
			terrain: physics, wind: physics.wind.out, fence: swarmFence,
			fogColor: scene.background, fogDensity: lastFogDensity, sun,
			dim: cloud.dim,
			resolution: ambientRes,
		});
	}

	// The end of flight decides on its own: what is shown, when the picture dies,
	// when the session closes. main.js only feeds it and obeys.
	//
	// Called OUTSIDE the frozen block (final review, fix 1): `closes` is an
	// event only the next update() drains, and if the sim freezes (C or Space)
	// right after, no unfrozen frame runs to read it. dt = 0 freezes the
	// timeline (the decision "the end sequence freezes with the sim" still
	// holds), but `closes` is drained whatever happens, on the next frame.
	const fv = physics.velocity, fw = physics.angularVelocity;
	flightEnd.update({
		dt: frozen ? 0 : dt,
		armed: controller.armed,
		speed: Math.hypot(fv.x, fv.y, fv.z),
		angularSpeed: Math.hypot(fw.x, fw.y, fw.z),
		crashed: crashedThisFrame,
		// Leaving the area: the same phase as a crash, a different text table
		// (FENCE_TIMELINE). The session verdict stays CRASHED.
		//
		// Never at the bench: the fence there warns and resists — the OSD goes to
		// CAUTION then HOLD, the push pushes — but it no longer carries out the
		// sentence. A pilot who insists gets out and finds themselves over
		// nothing, which is an honest consequence of the terrain, not a
		// punishment.
		outOfZone: MODE.bench ? false : fence.out.over,
		// Deliberately cutting the link (#216): K held for two seconds. Without
		// it, a drone stuck in a facade — neither a recognised landing nor a
		// crash — never closed its session, and NOTHING handed control back to
		// the terminal.
		//
		// Never at the bench: R there puts the machine right, there is no remote
		// machine to lose and no session to close. FIELD reconnaissance does have
		// it — it flies a real machine over real terrain.
		//
		// Read live rather than through onAction: a hold is not a press, and
		// input.js knows no game mode (so it has no business knowing this key
		// exists here and not at the bench).
		cutHeld: !MODE.bench && input.isHeld('cutLink'),
	});
	// Guarded on what the machine actually accepted (linkDead), not on
	// crashedThisFrame (final review, bonus): an impact taken after the end of
	// the flight must not replay the death of the picture over the end screen.
	if (flightEnd.out.linkDead) {
		// The drone is destroyed: the motors go quiet, so the sound does too —
		// audio.js follows the motor speeds, there is nothing to cut by hand.
		// The music follows nothing, so it is cut explicitly, here and not at
		// `closes`, so it dies AT THE MOMENT OF IMPACT, with the picture.
		// Waiting for the "LINK LOST" line (1.6 s) would leave the music playing
		// over the wreck as it rolls (issue #122).
		//
		// Except the radio (issue #120): it is not this flight's music, it is
		// what the operator put on in the background. A crash does not cut the
		// radio.
		if (!radio.owns) music.kill();
		// The acoustics go quiet with the drone. Without this call the network
		// keeps its last wet value and the energy already accumulated in its
		// loops: the noise carried on into the menus after the session ended.
		space.silence();
		// The sky goes quiet with it: no receiver, no voices (#250).
		ambient?.silence();
		// The swarm too (#29): it keeps flying, but nobody is listening any more.
		swarm?.silence();
		controller.disarm();
		// If the player had turned the link model off, they would see no
		// degradation at all. The death of the picture is not negotiable.
		if (!linkForced) {
			linkForced = true;
			lens.setLink({ mode: lensLinkMode === LINK_OFF ? LINK_ANALOG : lensLinkMode, severity: 1 });
		}
	}
	const closes = flightEnd.out.closes;
	if (closes) {
		// The music was already cut dead above (linkDead): every end of flight
		// goes through there now (D9, 2026-09-08).
		space.silence();
		session.end(closes).then((s) => s && console.log(`[session] ${closes}`, s));
		endOfFirstFlight();
		// The flight is over: the mouse is handed back. This is not comfort, it
		// is what makes [ENTER] DISCONNECT possible — under pointer lock (all the
		// more in fullscreen) the browser confiscates Escape to unlock the cursor
		// and delivers no keydown to the page. The one way out the end screen
		// offers would then be the one key that never arrives. The drone does not
		// answer any more anyway: there is nothing left to fly with the mouse.
		document.exitPointerLock?.();
	}

	// The weather on the camera. Advanced on the frame clock rather than the
	// physics step because nothing in it feeds back into the flight model — the
	// water is on the lens, not on the airframe — and because the streaks and
	// the drops are drawn once per frame whatever the physics did.
if (!frozen) {
	rain.update(physics.airspeed, dt);
	fog.update(dt);
	cloud.update(dt);

	// Altitude above ground, used for the cloud ceiling. Taken relative to the
	// spawn rather than through a raycast: the local relief is negligible next to
	// the cloud base's altitude, and the raycast further down this frame has not
	// happened yet.
	const altitudeAGL = physics.position.y - spawnY;

	skyDome.setState({
		cover: cloud.cover,
		base: cloud.base,
		altitudeAGL,
		windDir: physics.wind.direction,
		windSpeed: physics.wind.speed,
		rainScale: rain.fogScale,
		fogMix: fog.skyMix,
		night: sun ? sun.night : 0,
	});

	// The extinctions add up:
	// - fog
	// - rain
	// - cloud ceiling
	//
	// Entering a cloud produces a uniform veil here, driven by the camera's
	// altitude, rather than a per-fragment computation.
	const density =
		fog.density +
		rain.extinction +
		cloud.extinctionAt(altitudeAGL);

	// The colour the dome actually produced this frame.
	const sky = skyDome.horizon;
	const skyHex = sky.getHex();

	// The sun advances on the frame clock, like the rain and the fog. None of
	// this computation feeds back into the flight model.
	if (sun) {
		// Is the sun hidden behind a building?
		// One ray is enough here: the wind probe already runs several tests at
		// ~20.8 Hz.
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

		// Smoothing, to avoid flicker when the ray grazes a building's edge.
		sunVisible +=
			((1 - blocked) - sunVisible) *
			(1 - Math.exp(-dt / 0.08));

		// The sun's direction in camera space.
		_sunWorld.set(
			sun.dir.x,
			sun.dir.y,
			sun.dir.z,
		);

		const axis = _camDir
			.set(0, 0, -1)
			.applyQuaternion(camera.quaternion);

		const cosAngle = axis.dot(_sunWorld);

		// How much of the sun is present in the field of view.
		const halfFov =
			(camera.fov * Math.PI / 180) / 2;

		const cosHalfFov = Math.cos(halfFov);

		const inFrame = Math.max(
			0,
			(cosAngle - cosHalfFov) /
			(1 - cosHalfFov),
		);

		sunInFrame = inFrame * sunVisible;

		// Night temporarily disabled (see NIGHT_FLOOR_DEG in sun.js). `?night=1`
		// restores it so it can be checked.
		sun.update(dt, {
			sunInFrame,
			// The bench's time takes the ?date= path — sun.js only knows "an
			// instant, a place", and has no business learning what a bench is.
			// benchClock is recomputed when the operator moves the slider in
			// flight, hence the variable rather than a call per frame.
			...(MODE.bench ? { date: benchClock } : OPTS.date ? { date: OPTS.date } : {}),
			...(OPTS.night ? {} : { minElevationDeg: NIGHT_FLOOR_DEG }),
		});
	}

	if (density !== lastDensity || skyHex !== lastSkyHex) {
		lastDensity = density;
		lastFogDensity = density;
		lastSkyHex = skyHex;

		setFog(sky, density);

		// Mutated, not replaced: lens.js reads this object every frame.
		scene.background.set(sky);

		// The streaks are lit by the sky too.
		rainfall?.setSky(scene.background);
	}

	// The same principle as the fog: every chunk material is not rewritten each
	// frame for a value that moves over several minutes.
	if (cloud.dim !== lastDim) {
		lastDim = cloud.dim;
		setDim(cloud.dim);
	}

	// The city lights (#112), throttled on the same principle as the fog.
	const night = sun ? sun.night : 0;
	if (night !== lastNight) {
		lastNight = night;
		setNight(night);
	}
}
		// Light the air scatters into the barrel rather than onto the subject.
		// Zero compiles it out of the lens shader entirely.
		lens.setGlare(fog.glare);
		// And the light that comes from a direction rather than from everywhere.
		// The projection is done here because main.js is the only one that knows
		// the camera; lens.js receives numbers only, as for setGlare().
		if (sun) {
			_sunView.copy(_sunWorld).applyQuaternion(_camInv.copy(camera.quaternion).invert());
			// The pass's square space: x is stretched by the aspect, exactly like
			// `base` in the shader.
			// The shader's `base` space, and not a screen space invented here.
			// lens.js:226-227 defines it: base.x = ndc.x * uAspect and
			// dir = (base.xy * uTanHalf, -1), with uTanHalf = tan(fovY/2)
			// (lens.js:761). So base = (v.x/-v.z, v.y/-v.z) / tan(fovY/2) — with
			// NO factor of 0.5 and WITHOUT multiplying by the aspect a second
			// time, which base.x's amplitude already carries. The camera looks
			// down -Z, hence the sign.
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
			// The price of high gain (starlight, #111): grain, lifted blacks,
			// desaturation, composed ON TOP OF the target's sensor. Pushed only
			// when the gain moves — by day, applyTargetCamera()'s own call stays
			// the only one that talks to setSensor().
			if (sun.gain !== lastNightGain) {
				lastNightGain = sun.gain;
				lens.setSensor(nightSensor(sun.gain, camSpec?.sensor));
			}
		}
	skyDome.update(camera, frozen ? 0 : dt);
	// The digital dome at the live window's edge (#198): only in ?live= mode,
	// outside the weather block above, which does not exist in that mode (see the
	// comment on rainfall?. just below).
	if (fenceDome) {
		fenceDome.update(frozen ? 0 : dt, {
			windowCenterLocal: liveWindow?.windowCenterLocal,
			loadRadiusM: liveWindow?.loadRadiusM(),
			dronePosLocal: physics.position,
		});
		// The terrain dissolves into fog near the real edge rather than stopping
		// dead ("hard cut" feedback after checking) — the same ratio as the
		// dome, a different curve (fogDensityFor() stays nil until halfway out,
		// unlike the dome's opacity, which stays continuously perceptible by
		// choice).
		scene.fog.density = liveFogDensityFor(fenceDome.distanceRatio);
		// An edge fade on THE TERRAIN (#202): unlike the line above (a global
		// scalar, a function of the DRONE's position), this term is PER FRAGMENT
		// and follows the window's real edge — see RocktreeMaterial.js.
		// windowCenterLocal stays null until RocktreeWindow has set its first
		// window (the very first frame); uLoadRadiusM then stays at 0, and the
		// shader already uses that as a guard (edgeFadeFor()).
		if (liveWindow?.windowCenterLocal) {
			const { x, z } = liveWindow.windowCenterLocal;
			liveEdgeUniforms.uWindowCenter.value.set(x, z);
			const liveRadius = liveWindow.loadRadiusM();
			liveEdgeUniforms.uLoadRadiusM.value = liveRadius;
			// The fringe follows the radius (#32): fixed, it vanished at 2 km.
			liveEdgeUniforms.uEdgeFadeM.value = edgeFadeForRadius(liveRadius);
		}
		liveEdgeUniforms.uFogDensity.value = scene.fog.density;
		// The terrain dissolves into the fence itself (#107): the same field, the
		// same second, the same cast as the dome — otherwise the two materials
		// drift apart and the seam shows again.
		liveEdgeUniforms.uFieldTime.value = fenceDome.fieldTime;
		liveEdgeUniforms.uHueBias.value = fenceDome.hueBias;
		liveEdgeUniforms.uEyeY.value = physics.position.y;
	}
	// The digital wall at a baked map's edge (#199): the same principle, bbox
	// geometry rather than a radius — see geofence-dome.js.
	if (geofenceWall) geofenceWall.update(frozen ? 0 : dt, physics.position);
	// Zero dt while the sim is frozen, which is all it takes to stop the rain
	// dead on a picture that is not moving.
	// `?.`: rainfall is only born in finishBoot() (the scene path) — in ?live=
	// mode (#168, #170) it stays null, out of scope like the weather (see the
	// comment on OPTS.live). Without the guard, this code — which is not behind
	// `if (!frozen)`, unlike the rest of the weather above — throws on the very
	// first frame, animation loop included (measured: Uncaught TypeError: Cannot
	// read properties of null (reading 'update') at frame()).
	rainfall?.update({
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
	// BEFORE update() and not after: update() is what reads _terminalLoss, so
	// writing it afterwards would cost a frame of lag on the degradation.
	// This channel deliberately bypasses playability bound #79: leaving the area
	// is not a nuisance you should be able to recover from, it is the end of the
	// session.
	link.setTerminalLoss(fence.out.lossDb);
	// LOOPBACK (PHASE 26): the feed crosses nothing, so nothing degrades it. The
	// model is fed all the same — zero distance, no occlusion — rather than
	// bypassed: it keeps producing a coherent `out` that the OSD and lens.js read
	// without knowing they are at the bench.
	const loopback = MODE.bench && MODE.config?.link === 'LOOPBACK';
	link.update(loopback
		? { distance: 0, blocked: false, span: 0, dt }
		: { distance: linkState.distance, blocked: shadow.blocked, span: shadow.span, dt });

	// A chase view is not the video feed, so it gets a clean picture — the link
	// model keeps running, so coming back does not start from a stale RSSI.
	const linkOut = flightEnd.out.linkDead ? DEAD_LINK : link.out;
	lens.render(camera, dt, viewMode === 'chase' ? null : linkOut);

	// Available only when what the canvas shows really is the target's feed:
	// armed, airborne, not in CHASE view, not during the link's death throes.
	// Consumed right after the render — it is that exact buffer, not a later
	// frame's, that becomes the photograph.
	const photoReady = controller.armed && !frozen && viewMode === 'fpv' && !flightEnd.out.linkDead;
	if (pendingCapture) {
		pendingCapture = false;
		if (photoReady) capturePhoto();
	}

	const v = physics.velocity;
	const bat = physics.battery;

	// The session's aggregated telemetry (PHASE 06): maxima and totals, not a
	// frame-by-frame recording. dt=0 when the sim is frozen, so a pause does not
	// inflate the duration.
	const av = physics.angularVelocity;
	// NOTHING HERE IS LOGGED: at the bench no session is open, so there is
	// nothing to feed. The guard is here rather than in session.js so the promise
	// reads at the place where it would be broken.
	if (!MODE.bench) {
		session.feed({
			speed: Math.hypot(v.x, v.y, v.z),
			horizontalSpeed: Math.hypot(v.x, v.z),
			rateDps: Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) * 180 / Math.PI,
			altitudeAboveSpawn: p.y - spawnY,
			dt: frozen ? 0 : dt,
			armed: controller.armed,
			// The track (issue #24): the only two values the aggregated telemetry
			// did not use, already computed here for the OSD and the sound.
			throttle: sticks.throttle,
			headingDeg: headingOf(physics.rotation) * 180 / Math.PI,
			// Coverage (issue #245): a function, called by session.js only when a
			// sample is due — nothing in between.
			geo: () => droneGeo(p),
		});
	}

	// The in-flight musical arc (issue #122). One call, one scalar, and
	// setIntensity only moves AudioParams: no node is created per frame. Frozen,
	// nothing is touched — the music holds its value through a pause instead of
	// falling back to the floor.
	//
	// The radio (issue #120) is outside this arc: it plays flat. Without this
	// guard, cutting the throttle would push it into the closed filter, which
	// makes no sense for a soundtrack you chose yourself.
	if (!frozen && !radio.owns && music.playing) {
		music.setIntensity(flightIntensity({
			throttle: sticks.throttle,
			speedMs: Math.hypot(v.x, v.y, v.z),
			armed: controller.armed,
		}));
	}

	// The two layers, in this order: the target's, which will go through the link
	// and the sensor, then ours, which goes through nothing.
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
		homeBearingRad: bearingTo(spawnX - p.x, spawnZ - p.z),
		headingRad: headingOf(physics.rotation),
		rollRad: rollOf(physics.rotation),
		pitchRad: pitchOf(physics.rotation),
		flightSeconds: (Date.now() - sessionStartedAt) / 1000,
		// Normalised on hover thrust and not on MAX_THRUST, which is not imported
		// into main.js: no new import for a decorative number.
		escTempC: 34 + 22 * physics.propulsion.thrust / (PROFILE.mass * 9.81),
		vtxChan: 4,
		// A real OSD's warnings are not decorative: they are what stays legible
		// when everything else is noise.
		// NO COVERAGE comes before RXLOSS: inside the warning corridor the fence
		// IS the cause of the RXLOSS, and showing the effect rather than the
		// cause would tell the pilot to come back towards... nothing.
		// Capacity first, voltage as the backstop -- which is the way round every
		// real OSD does it, and for the reason the discharge curve makes obvious:
		// a LiPo sits between 4.2 and 3.65 V for ninety percent of its charge and
		// then moves fast. Voltage therefore CANNOT warn early; measured on a
		// freestyle5 hover it fires 18 s before the pack can no longer hold the
		// machine up, and 8 s on a cinewhoop. The same flights give 49 s and 14 s
		// of notice off the capacity gauge. The pilot is not being asked to fly
		// better, only to be told in time.
		warning: bat.voltage / PROFILE.battery.cells < 3.4 ? 'LOW VOLTAGE'
			: fence.out.warning ? fence.out.warning
			: bat.soc <= 0.15 ? `BATT ${Math.max(0, Math.round(bat.soc * 100))}%`
			: link.out.quality < 0.25 ? 'RXLOSS' : '',
	});

	fpvtpOsd.update({
		mode: controller.mode,
		rates: RATE_PRESETS[controller.preset].label,
		usingGamepad: input.usingGamepad,
		windMs: Math.hypot(physics.wind.out.x, physics.wind.out.z),
		windRelRad: relativeBearing(windFromBearing(physics.wind.out.x, physics.wind.out.z), headingOf(physics.rotation)),
		// The visibility actually seen, fog AND rain: the exact same expression
		// already used above, so the two can never say different things.
		visibilityM: fogRange(fog.density + rain.extinction),
		rssiDbm: link.out.rssiDbm,
		operator: operator.getOperator()?.name,
		sessionSeconds: (Date.now() - sessionStartedAt) / 1000,
		propwash: physics.propulsion.propwash,
		bench: MODE.bench,
		live: MODE.live,
	});
	fpvtpOsd.setFlightEnd(flightEnd.out);
	// The two ways out of a stuck machine (#216, #105). The labels name the key
	// actually bound, so the live key map — re-read only on the frames that show
	// something, which is rare by nature.
	if (flightEnd.out.stuck || flightEnd.out.cutProgress > 0 || turtle.out.eligible) {
		const rows = keyMapRows(input.getKeyMap());
		fpvtpOsd.setCut(flightEnd.out, keyOf(rows, 'cutLink', 'K'));
		fpvtpOsd.setTurtle(turtle.out, keyOf(rows, 'turtle', 'T'));
	} else {
		fpvtpOsd.setCut(flightEnd.out);
		fpvtpOsd.setTurtle(turtle.out);
	}
	// D16: the first flight, and only it, gets three lines. Take-off is a
	// metre and a half above the spawn — enough that a bounce on the ground is
	// not one.
	if (hintFlight) {
		const tFlight = (Date.now() - sessionStartedAt) / 1000;
		if (hintAirborneAt === null && p.y - spawnY > 1.5) hintAirborneAt = tFlight;
		fpvtpOsd.setHint(flightHint({
			armed: controller.armed,
			airborneOnce: hintAirborneAt !== null,
			tSinceTakeoff: hintAirborneAt === null ? 0 : tFlight - hintAirborneAt,
			bench: MODE.bench,
			firstFlight: true,
			keyRows: keyMapRows(input.getKeyMap()),
		}));
	}
	fpvtpOsd.setPhotoReady(photoReady);
	settings.updateAxisBars();

	// [ENTER] DISCONNECT, radio version (issue #123): once the exit is armed the
	// flight is over — any NEWLY pressed pad button disconnects, without putting
	// the radio down. Rising edge only: a switch held since the flight, or the
	// disarm gesture, does not count.
	if (flightEnd.out.exitArmed && !flightExit.busy) {
		const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
		const down = !!pad?.buttons.some((b) => b.pressed);
		if (down && !exitPadHeld) finishSession();
		exitPadHeld = down;
	} else {
		exitPadHeld = true;
	}

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

	// The link, in flight only: a continuous carrier whose hiss follows the
	// margin, and two callouts on threshold crossings. It is the only interface
	// sound that lives during the flight.
	if (flightEnd.phase === FLYING) {
		uiAudio.setLinkQuality(link.out.quality);
		const ev = linkEvent(link.out.quality, dt, linkVoice);
		if (ev === 'LINK_LOST') uiAudio.play('LINK_LOST');
		else if (ev === 'LINK_RESTORED') uiAudio.play('LINK_RESTORED');
	} else {
		uiAudio.linkSilent();
	}
}

// Picks which prepared map to fly before doing any of the heavy loading work.
// ?scene=<slug> skips the menu (handy for bookmarking/dev), otherwise the
// menu is shown even with a single map so "choose from a menu" always holds.
// Resolves the operator (bootstrapping on a first launch), puts the operator on
// the Home, then hands back to the existing map selection. ?scene=<slug> skips
// both Home AND menu but keeps an operator in memory for
// operator.getOperator().
// The TARGET SCAN's signal count, consistent with the density the Global Scanner
// shows (PHASE 03/05). Acquired terrain carries { level, range }; the normalised
// level (0..1, log) is mapped onto 2..5, the same scale as the Global Scanner.
// Terrain with no density (an old cache, local terrain) -> 4.
// A THREE wrapper around fetchNode()'s output (#168, #187). Since #187 the whole
// computation (ECEF->ENU, strip->triangles, normalised UVs, boundingSphere) is
// done in the Worker by tools/lib/rocktree/build-node.mjs — each mesh arrives
// with transferable positions/uvs/indices; all that is left here is what demands
// the main thread: THREE objects and a material. A node can carry several
// meshes — each becomes its own THREE.Mesh AND its own collider
// (`${path}#${i}`: addNodeCollider() tracks a key, not a node).
function buildNodeMesh(path, meshes) {
	const built = [];
	meshes.forEach((m, i) => {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
		geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
		if (m.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
		// The Worker's boundingSphere (the same algorithm as
		// computeBoundingSphere): otherwise Three computes it LAZILY at each
		// mesh's first frustum culling — an O(n) pass per mesh, in the middle of
		// a wave, exactly when the frame is already loaded (#187).
		geometry.boundingSphere = new THREE.Sphere(
			new THREE.Vector3(...m.boundingSphere.center), m.boundingSphere.radius,
		);

		let material;
		if (m.bitmap && m.uvs) {
			const texture = new THREE.CanvasTexture(m.bitmap);
			// NO V inversion and flipY off: the rocktree protocol has its UV
			// origin at the TOP-left (measured in #158, see the reference
			// decoder's comment) — that is the convention of an image as
			// createImageBitmap() stores it. CanvasTexture's default flipY would
			// put the origin back at the bottom and turn every tile over.
			texture.flipY = false;
			// No mipmaps on live tiles (#187): generating them at upload was the
			// worst item in the drain budget (4.6 ms for a 512^2, measured) — and
			// the constant octree level keeps minification moderate (the furthest
			// tile of a 600 m window is at ~2-3x its screen size, not ~100x).
			// Checked on the picture: no notable moire at window range.
			texture.generateMipmaps = false;
			texture.minFilter = THREE.LinearFilter;
			material = createRocktreeMaterial(liveEdgeUniforms, { map: texture });
		} else {
			material = createRocktreeMaterial(liveEdgeUniforms, { color: 0x808080 });
		}
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `rocktree-${path}-${i}`;
		// Static terrain in the local ENU frame: the matrix is the identity and
		// will never change — without this flag, Three recomposes the matrix of
		// ~1600 meshes at EVERY frame's updateMatrixWorld (#187).
		mesh.matrixAutoUpdate = false;
		mesh.updateMatrix();
		built.push({ mesh, colliderPath: `${path}#${i}`, vertices: m.positions, indices: m.indices });
	});
	return built;
}

// One console line per individual. This is debug, not UI: the player only
// learns their target's mass and pack in flight (PHASE 08: the pre-hack sheet
// gives them as UNKNOWN).
function logBuild(build) {
	const { spec, profile } = build;
	console.log(
		`[target] family ${profile.family} — ${profile.label} · ${spec.massG} g · `
		+ `${spec.capacityMah} mAh ${spec.cells}S · TWR ${spec.twr.toFixed(1)} · `
		+ `rates ${spec.rateMaxDeg} deg/s`,
	);
}

function signalCountFor(slug) {
	const t = operator.getOperator()?.terrainCache?.find((e) => e.slug === slug);
	return signalCountFrom(t?.signalDensity?.level);
}

// The same scale, from the bare LEVEL. A live flight has no terrain cache entry
// — its density comes from the survey the scanner has just made of the drawn
// area, and travels with the pin (#218). The two paths must count signals the
// same way, otherwise the TARGET SCAN does not say what the GLOBAL SCANNER has
// just announced.
function signalCountFrom(level) {
	if (!Number.isFinite(level)) return 4;            // no known density (old cache, local terrain)
	// 4..5: at least 3 ambients (count - 1), never two (issue #250, operator
	// feedback — a sky with a single ambient read as empty).
	return 4 + Math.round(Math.max(0, Math.min(1, level)));
}

// One preload per area, kept from one pass through the TARGET SCAN to the next.
// Going back and then returning to the same area therefore replays no download:
// Monaco weighs 510 MB and ~4.6 s locally, far more on a real network. Safe
// because preloadScene() mounts nothing into the scene and captures its own URL
// base — two areas can load in parallel without treading on each other.
const preloads = new Map();

function preloadFor(slug) {
	let p = preloads.get(slug);
	if (!p) {
		p = preloadScene(slug);
		// An abandoned preload that fails must not surface as an "unhandled
		// rejection": whoever really awaits it will see the error, the others
		// will not.
		p.catch(() => {});
		preloads.set(slug, p);
	}
	return p;
}

// Preloaded meshes hold on to their texture sheets (~135 MB per area): as soon
// as one area is committed, the others have no reason to exist and are freed.
// They are in no scene — giving the memory back is all it takes.
function dropPreloadsExcept(keepSlug) {
	for (const [slug, p] of preloads) {
		if (slug === keepSlug) continue;
		preloads.delete(slug);
		p.then((loaded) => {
			const meshes = loaded.meshes ?? [];
			// #147: without this removal, tileMaterials (loader.js) kept these
			// materials alive despite the dispose() below — dispose() only frees
			// the GPU, not the JS pixel buffer uMap.value references.
			releaseTileMaterials(meshes.map((m) => m.material));
			for (const m of meshes) {
				m.geometry.dispose();
				m.material.uniforms?.uMap?.value?.dispose();
				m.material.dispose();
			}
			console.log(`[load] abandoned preload freed: ${slug}`);
		}, () => {});
	}
}

async function chooseScene() {
	const ui = document.getElementById('ui');

	if (OPTS.live) {
		// D12: this path draws no build, and it returns BEFORE the branch of
		// startup() that sets the seed. Without it, the end of a ?live= flight
		// had no machine to show.
		flightBuildSeed = nominalBuildSeed(PROFILE?.family);
		await bootLive(OPTS.live);
		return null;   // no slug: the rest of the scene pipeline must not run
	}

	if (OPTS.scene) {
		await operator.ensureDevOperator();
		const scenes = await loadSceneList();
		if (!scenes.some((s) => s.slug === OPTS.scene)) throw new Error(`unknown map: "${OPTS.scene}"`);
		const previewHack = normalizeHackType(OPTS.hack);
		if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
		return { slug: OPTS.scene, target: undefined, family: OPTS.family || undefined };
	}

	// The bootstrap, unchanged (issue #60): the key returned by the creation goes
	// into localStorage with no extra screen. ARCHIVE > OPERATOR > [ SHOW KEY ]
	// is the deliberate path for the day you want to take your profile
	// elsewhere.
	// The briefing runs INSIDE the bootstrap, right after the control vector is
	// registered — the only moment where a player has just been made and has
	// not yet chosen anything.
	const register = () => bootstrap(ui, undefined, { briefing: () => playBriefing() });

	const { needsBootstrap, choices, needsKey } = await operator.loadOperator();
	if (needsKey) {
		// A `shared` server that does not recognise us: no list to choose from,
		// either a key to present or a new operator to create.
		const r = await operatorKey(ui);
		if (r?.create) await register();
	} else if (needsBootstrap) {
		await register();
	} else if (choices) {
		const pick = await operatorSelect(ui, choices);
		if (pick.create) await register();
		else await operator.selectOperator(pick.id);
	}

	// Rapier (a separate WASM chunk since #21, see physics.js) loads and compiles
	// WHILE the player reads the terminal: by the first FLY it is already there.
	// Nothing waits on it and a failure here has no consequence — preloadScene()
	// and bootLive() make the call again (the same memoised promise) and they do
	// report it.
	initPhysics().catch(() => {});

	// No music start here: startup() does it, inside the PRESS ANY KEY gesture.
	// One more call here would run at load time, BEFORE any gesture: it would
	// consume startMenuMusic()'s guard and start the source on a context that is
	// still suspended, leaving the next gesture with nothing to start.

	// #253: REDEPLOY left the last flight's zone in sessionStorage before
	// reloading the page. If it is there, SELECT OPERATION MODE and the terminal
	// are skipped and we drop straight back into that zone's TARGET SCAN.
	//
	// A failure (the zone gone, the map not found) reloads the page rather than
	// falling back into the terminal WITHIN THIS SAME load: fieldLoop() may have
	// set introFrozen/MODE.live/flyArea/flyTarget/PROFILE before failing (for
	// example runHack() rejecting — see hack.js, "Rejected -> tear down and
	// propagate"), and nothing cleans them up here. A reload lands on a brand new
	// module; consumeQuickRestart() has already emptied sessionStorage, so that
	// reload really does land on the normal terminal, not on another attempt at
	// the same zone in a loop.
	const quickRestart = consumeQuickRestart();
	if (quickRestart) {
		try {
			const choice = await fieldLoop(ui, { quickRestart });
			if (choice) return choice;
		} catch (err) {
			console.warn('[field] REDEPLOY: zone unavailable, reloading', err);
			location.href = location.pathname;
			return new Promise(() => {}); // navigation is under way; return nothing in the meantime
		}
	}

	// The MODE loop (PHASE 26). The game's root is now SELECT OPERATION MODE;
	// FIELD's Home is one level below and can therefore come back up here. Both
	// loops return `null` to mean "I am going back up", and anything else to mean
	// "we are flying".
	for (;;) {
		const mode = await selectOperationMode(ui, {
			last: loadLastMode(),
			operatorName: operator.getOperator()?.name ?? null,
		});

		// SETTINGS is not a path: it is a panel, the same one Tab opens in
		// flight. selectOperationMode() has already torn the root down by
		// resolving — the panel therefore opens alone, and the loop draws a
		// fresh root on close. That is what we want here: the root re-reads
		// `fpvtp.mode` and the operator name, which the panel may just have
		// changed.
		if (mode === 'settings') {
			settings.toggleSettings(true);
			await settings.closed();
			continue;
		}

		// JUKEBOX leads nowhere: you listen, you go back up. And the radio does
		// not come back up with you — it keeps playing through the menus and into
		// the flight that follows (issue #120).
		if (mode === 'jukebox') {
			await runJukebox(ui);
			continue;
		}

		// DATA resolves UPWARDS: a REVISIT is a flight, and it enters the
		// FIELD loop exactly like a choice made on the FIELD screen. Escape at
		// the TARGET SCAN therefore falls back to FIELD, not to the logs — it
		// is the same area, and that is where it is flown again.
		if (mode === 'data') {
			const pick = await dataLoop(ui);
			if (!pick) continue;
			const choice = await fieldLoop(ui, { quickRestart: pick });
			if (choice) return choice;
			continue;
		}

		const choice = mode === 'bench' ? await benchLoop(ui) : await fieldLoop(ui);
		if (choice) return choice;
	}
}

// DATA from the root (D3). Yields { slug } when the operator asked to fly
// an area again, null when they go back up.
async function dataLoop(ui) {
	const scenes = await fetchScenes();
	return dataScreen(ui, { api: operator, scenes });
}

// The FIELD loop: the Bible's game, unchanged. Extracted as-is from
// chooseScene() so the bench can live alongside it without mixing in.
//
// Returns the flight's shape, or null to go back up to the mode selection.
async function fieldLoop(ui, { quickRestart = null } = {}) {
	// The zone selection loop: Escape at the TARGET SCAN comes back here. Nothing
	// is torn down and nothing is reloaded — that is what lets the terminal's
	// ambience carry on without the slightest break, and the preload of the area
	// just left stay acquired.
	for (;;) {
		// #253: REDEPLOY stays on the same area — the already-known choice is
		// replayed ONCE rather than reopening the terminal. Consumed immediately:
		// an Escape at the TARGET SCAN that follows must fall back to the normal
		// terminal, not replay the same area in a loop.
		const flyChoice = quickRestart ?? await runTerminal(ui, { back: true });
		quickRestart = null;
		// Escape on the Home: go back up to the mode selection. The Home has not
		// been the root since PHASE 26, and it must be possible to head back to
		// the bench without reloading the page.
		if (!flyChoice) return null;

		// Set as soon as the area is known (before TARGET SCAN, before any screen
		// that can fail): a REDEPLOY after this flight will replay THIS area.
		lastZone = flyChoice.live
			? { live: flyChoice.live, place: flyChoice.place, density: flyChoice.density }
			: { slug: flyChoice.slug };

		// A live flight: EXACTLY the pipeline of a baked map — TARGET SCAN,
		// target, individual, music, hack, the Control Vector ritual. Only the
		// terrain differs: it is streamed instead of read from disk.
		//
		// #206 had decided the opposite ("no TARGET SCAN, no hack, no ritual") on
		// the grounds that targets are an attribute of a SURVEYED area. That was
		// a misreading of the code: the scanner has just done the survey —
		// `lastDensity` is the signal density computed over the drawn area, from
		// Nominatim. It now travels with the pin, and there is nothing to invent.
		// Without this chain, every live flight produced the same freestyle
		// airframe and the same OSD, since nothing drew a family or an
		// individual.
		if (flyChoice.live) {
			MODE.live = true;
			introFrozen = true;
			const [lat, lon] = flyChoice.live;

			const seed = Math.random().toString(16).slice(2, 12);
			const count = signalCountFrom(flyChoice.density);
			// The early guarantee (issue #29), read off the operator state the
			// client already holds. It goes to the server with the hack request,
			// because only that makes the server's regeneration identical.
			const swarmChance = swarmChanceFor(operator.getOperator()?.sessions);
			const scan = generateTargetScan({ seed, count, swarmChance });
			const scanWeather = await worldWeather({ lat, lon });
			const choice = await runTargetScan(ui, { seed, count, weather: scanWeather, swarmChance });

			// Escape at the TARGET SCAN: back to the zone selection. Nothing has
			// been mounted yet — unlike the baked path, bootLive() is only called
			// AFTER the choice, because it MOUNTS the scene where preloadScene()
			// merely downloads. Cancelling it would leave live terrain with no
			// flight.
			if (choice.cancelled) {
				MODE.live = false;
				introFrozen = false;
				continue;
			}

			const cand = scan.candidates[choice.index];
			audio.start();
			// A live area has no slug on disk. One is forged for it, prefixed
			// `live-`: it names the session in the log without ever being
			// confusable with an acquired area, so REVISIT will never offer to go
			// back to terrain that was not kept.
			flyArea = liveAreaId(flyChoice.place, lat, lon);
			flyTarget = choice;
			const buildSeed = `${seed}::${choice.index}`;
			const build = targetBuild({ seed: buildSeed, family: cand._family });
			// BEFORE bootLive(), which builds its physics with `PROFILE` if it is
			// set — which is already what the bench's free flight does.
			PROFILE = build.profile;
			flightBuild = build;
			flightBuildSeed = buildSeed;
			benchRates = build.rates;
			logBuild(build);
			console.log(`[field] live flight -> ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
			// `arm: false`: the [ JACK IN ] gesture is what arms the flight, not
			// the boot — see armFlight() and runHack()'s `commit` below.
			const booting = bootLive(flyChoice.live, { arm: false });

			// The music loads BEHIND the hack screen (issue #33), not in front of
			// it. Awaiting it left the screen EMPTY — the TARGET SCAN torn down,
			// the hack not yet mounted, the loading HUD hidden — for as long as
			// it took to download and decode a whole track: the player pressed
			// Enter and nothing happened. The same principle as bootLive(), which
			// overlaps its three latencies instead of adding them up. The hack
			// lasts several seconds at minimum: the music slides inside it, which
			// is where it belongs anyway — it is the machine's first sensory clue,
			// not a prerequisite for the screen.
			// Not when the radio holds the antenna (issue #120): the player chose
			// their soundtrack, and the hack does not fade it away from them.
			if (!radio.owns) {
				music.loadManifest()
					.then(() => music.prepare(music.trackForFamily(cand._family, buildSeed)))
					.then(() => music.play({ intensity: PHASE_INTENSITY.HACK, fadeMs: FADE.menuToHack }))
					.catch((err) => console.warn('[music] hack track unavailable', err));
			}
			// The terrain streams BEHIND the hack screen, exactly as a baked scene
			// loads behind it: that is what this screen is for.
			const hack = await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand, buildSeed, commit: armFlight });
			// Abandoning at the hack: unlike the TARGET SCAN's Escape just above,
			// `booting` has already mounted the live terrain into the scene
			// (bootLive() is deliberately placed BEFORE the target choice, where
			// preloadScene() merely downloads) — there is no going back within
			// this same load. The same treatment as REDEPLOY when runHack() ends
			// badly (see above, "A failure ... reloads the page"):
			// introFrozen/MODE.live/flyArea/flyTarget/PROFILE are already set and
			// nothing cleans them up here, so we start clean rather than replay
			// the same area on a memoised preload.
			if (hack?.aborted) {
				location.href = location.pathname;
				return new Promise(() => {}); // navigation is under way; return nothing in the meantime
			}
			introFrozen = false;
			accumulator = 0;
			lastTime = performance.now();
			flightStartTime = lastTime;
			return { prepared: true };
		}

		const { slug } = flyChoice;

		// The dev ?family= override: short-circuits the TARGET SCAN.
		if (OPTS.family) {
			const previewHack = normalizeHackType(OPTS.hack);
			if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
			// No buildSeed: the dev override flies the family's NOMINAL profile.
			// That is what keeps ?family=freestyle5 identical to the bench and to
			// tools/tune-pid.mjs's reference. `?build=<seed>` (#285) draws an
			// individual — to check in game what is particular about a build.
			return { slug, target: undefined, family: OPTS.family, buildSeed: OPTS.build || undefined };
		}

		// A fresh session -> TARGET SCAN, then AUTOMATED ANALYSIS while the map
		// loads in the background: at [ JACK IN ] control is immediate. The slug is
		// already known here (the TARGET SCAN picks a target within this map, not
		// the map itself): preloadScene() starts at once, so it runs behind the
		// whole TARGET SCAN and not only behind the AUTOMATED ANALYSIS's wait
		// (PHASE 13, issue #50).
		introFrozen = true;
		const preloading = preloadFor(slug);

		const seed = Math.random().toString(16).slice(2, 12);
		const count = signalCountFor(slug);
		const swarmChance = swarmChanceFor(operator.getOperator()?.sessions);
		const scan = generateTargetScan({ seed, count, swarmChance });
		// The world's weather for this area, resolved before the scan so the
		// conditions are salient at the target choice (issue #76). worldWeather is
		// cached per zone: boot() reuses this result with no extra round trip.
		const sc = (await loadSceneList()).find((s) => s.slug === slug);
		const scanWeather = sc ? await worldWeather({ lat: sc.lat, lon: sc.lon }) : null;
		const choice = await runTargetScan(ui, { seed, count, weather: scanWeather, swarmChance }); // { seed, count, index, swarmChance, swarmAt } | { cancelled }

		// Escape at the TARGET SCAN: back to the zone selection, breaking nothing.
		// The preload started above CARRIES ON in the background: it does not touch
		// the Three scene (preloadScene mounts nothing) and it captured its own URL
		// base, so it can neither corrupt nor be corrupted by another area's load.
		// Coming back to this same area will find it as it was, often already
		// finished.
		if (choice.cancelled) {
			introFrozen = false;
			continue;
		}

		// The area is committed: the other preloads will never be used.
		dropPreloadsExcept(slug);

		const cand = scan.candidates[choice.index];

		audio.start();
		flyArea = slug;
		flyTarget = choice;
		// The individual (PHASE 07). The seed is the one the server will rebuild in
		// resolveTarget() — the drone you fly is the one the world drew, not one the
		// client invented for itself.
		const buildSeed = `${seed}::${choice.index}`;
		const build = targetBuild({ seed: buildSeed, family: cand._family });
		PROFILE = build.profile;
		flightBuild = build;
		flightBuildSeed = buildSeed;
		controller = new FlightController({ profile: PROFILE, rates: build.rates });
		logBuild(build);
		// `arm: false`: the same rule as the live path just above, the [ JACK IN ]
		// gesture arms the flight (see runHack()'s `commit`).
		const booting = finishBoot(preloading, { arm: false });
		// The track decodes DURING the AUTOMATED ANALYSIS, in parallel with the
		// scene's load: at the drop the buffer has to be there already. The draw is
		// deterministic on buildSeed — resuming a session means resuming that drone
		// AND its music.
		//
		// The screen still does not name the family: the music is the first sensory
		// clue, not a revelation. "You don't read the drone. You feel it."
		// The music loads BEHIND the hack screen (issue #33), not in front of it.
		// Awaiting it left the screen EMPTY — the TARGET SCAN torn down, the hack
		// not yet mounted, the loading HUD hidden — for as long as it took to
		// download and decode a whole track: the player pressed Enter and nothing
		// happened. The same principle as bootLive(), which overlaps its three
		// latencies instead of adding them up. The hack lasts several seconds at
		// minimum: the music slides inside it, which is where it belongs anyway —
		// it is the machine's first sensory clue, not a prerequisite for the
		// screen.
		// Not when the radio holds the antenna (issue #120): the player chose their
		// soundtrack, and the hack does not fade it away from them.
		if (!radio.owns) {
			music.loadManifest()
				.then(() => music.prepare(music.trackForFamily(cand._family, buildSeed)))
				.then(() => music.play({ intensity: PHASE_INTENSITY.HACK, fadeMs: FADE.menuToHack }))
				.catch((err) => console.warn('[music] hack track unavailable', err));
		}
		const hack = await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand, buildSeed, commit: armFlight });
		// Abandoning at the hack: `booting` (finishBoot()) has already mounted the
		// terrain into the scene — "Mounting into the scene happens HERE and not in
		// preloadScene(): from this moment the area is committed, and there is no
		// going back" (see finishBoot()). Replaying the same area would hand back
		// the memoised preload (preloadFor()'s `preloads` cache): `finishBoot()`
		// has already emptied its `collision` (`preloaded.collision = null`, right
		// after `new Physics(collision, ...)`) — a second pass would call it with
		// `null` and crash. The same treatment as REDEPLOY when runHack() ends
		// badly (see above, "A failure ... reloads the page"): start clean rather
		// than try to carry on within this same load.
		if (hack?.aborted) {
			location.href = location.pathname;
			return new Promise(() => {}); // navigation is under way; return nothing in the meantime
		}
		// [ JACK IN ] has handed control back: do not replay the wall-clock gap
		// accumulated during the hack as one giant physics step.
		introFrozen = false;
		accumulator = 0;
		lastTime = performance.now();
		flightStartTime = lastTime;
		return { prepared: true };
	}
}

// The BENCH loop (PHASE 26). Returns the flight's shape, or null to go back up.
//
// Far shorter than fieldLoop(), and that is the point: there is no scan, no
// target, no hack, no ritual, no tension music to install. You set things up and
// you take off. The bench has no ceremony because there is nobody at the other
// end to surprise.
async function benchLoop(ui) {
	const scenes = await loadSceneList().catch(() => []);
	const config = await runBench(ui, { scenes });
	if (!config) return null;

	MODE.bench = true;
	MODE.config = config;

	// The machine, resolved ONCE and for both terrains (#159). It used to be
	// handed to the startup() chain as a `{family, buildSeed}` pair and rebuilt
	// there — a shape that can say NOMINAL and INDIVIDUAL and nothing else, so a
	// catalogue build or a single typed gain would have been silently dropped on
	// the way to a baked scene.
	const resolved = resolveBenchAirframe(config.airframe);
	PROFILE = resolved.profile;
	flightBuild = resolved.build;
	// D12: NOMINAL and CUSTOM have no drawn build, but they do have a machine —
	// the family's nominal seed gives them a portrait without touching the flown
	// profile, which stays the reference of tools/tune-pid.mjs.
	flightBuildSeed = resolved.build ? config.airframe.seed : nominalBuildSeed(PROFILE.family);
	benchRates = resolved.rates;
	benchThrottle = resolved.throttle;
	benchIdentity = resolved.identity;
	benchProfileIdentity = resolved.profileIdentity;
	if (resolved.build) logBuild(resolved.build);
	else console.log(`[bench] ${PROFILE.family} — ${PROFILE.label} (${config.airframe.base} ${resolved.identity})`);

	// Hidden terrain: the startup() chain takes it from here, boots the baked
	// scene and builds the controller off the PROFILE just set. No family and no
	// buildSeed go back with it — there is nothing left for it to re-derive.
	if (config.terrain.kind === 'cached') {
		return { slug: config.terrain.slug, target: undefined };
	}

	// Free flight: bootLive() builds its own physics and its own controller, so
	// PROFILE and the rates have to be set BEFORE the call — which is what ?live=
	// already does through the ?family= override.
	audio.start();
	await bootLive([config.terrain.lat, config.terrain.lon]);
	return { prepared: true };
}

// ?scene= skips Home and menu: no user gesture happens before boot(). The
// AudioContext demands a gesture — it is caught on the first input. armBoot()
// stays EXACTLY the previous path (PHASE 18): this bypass is for dev and for
// bookmarks, and has no business watching a 7 s cracktro on every reload.
//
// Without ?scene=, the intro (issue #106) replaces armBoot(): it is what plays
// BOOT_SIGNATURE when it resolves (or immediately, if skipped), so never both —
// one startup motif per page load, never a duplicate. It comes BEFORE the
// operator/Home resolution.
if (OPTS.scene || OPTS.live) {
	uiAudio.armBoot();
	const kick = () => { audio.start(); };
	window.addEventListener('pointerdown', kick, { once: true });
	window.addEventListener('keydown', kick, { once: true });
}

// The terminal's ambience (issue #122). The `menu` pool is not a drone: it is
// the place you are sitting in, beforehand. It must sound from the intro's PRESS
// ANY KEY on — that gesture is the page's first, hence the first instant the
// browser will let an AudioContext start — and not only once the cracktro is
// over and the operator chosen.
//
// Hence two separate beats: the decoding needs no gesture and runs during the
// intro; the playback leaves INSIDE the gesture. Without that separation we
// would be waiting on the fetch + decode at the exact instant we want to hear
// something.
//
// Wired here rather than in intro.js / terminal.js: the screens stay pure
// clients, with no audio dependency.
let menuMusicReady = null;
let menuMusicStarted = false;

function prepareMenuMusic() {
	// The seed changes on every load — the terminal has no buildSeed to respect,
	// and two sessions in a row must not open on the same track.
	menuMusicReady ??= music.loadManifest().then(() =>
		music.prepare(music.trackForMenu(Math.random().toString(16).slice(2, 12))));
	return menuMusicReady;
}

async function startMenuMusic() {
	// The radio wins (issue #120). The `!music.playing` guard below is not
	// enough: it races with the radio's fade, during which `music.playing` can be
	// briefly false.
	if (radio.owns) return;
	if (menuMusicStarted) return;
	menuMusicStarted = true;
	// The player's music volume is only applied at the scene's boot
	// (settings.setAudio), long after the menu: without this the terminal's music
	// would come in at full while the stored setting says otherwise.
	music.setVolume(loadMusicVolume());
	const ready = await prepareMenuMusic();
	// The terminal may already be gone: only start if it is still there,
	// otherwise the menu music would invite itself over the hack.
	if (ready && !music.playing) music.play({ intensity: PHASE_INTENSITY.MENU });
}

// The radio hands the antenna back: the terminal gets its music again (issue
// #120). `menuMusicStarted` is memoised so it only plays once per load —
// without this rearm, cutting the radio would leave the menus silent until the
// next reload. The seed starts over too: picking up exactly the boot's track
// would sound like a stutter.
radio.onRelease(() => {
	menuMusicStarted = false;
	menuMusicReady = null;
	startMenuMusic().catch(() => { /* the menu music is never critical */ });
});

async function startup() {
	// Synchronous inside the gesture's handler: that is what authorises the
	// AudioContext. The playback itself can arrive later.
	const onFirstGesture = () => { audio.start(); startMenuMusic(); };
	const store = globalThis.sessionStorage;
	if (shouldPlayIntro(OPTS, store)) {
		// Decoding starts before the intro; playback is triggered by its gate.
		prepareMenuMusic();
		await runIntro(document.getElementById('ui'), { onFirstGesture });
		markIntroSeen(store);
	} else if (!OPTS.scene && !OPTS.live) {
		// The end-of-flight reload (issue #226): the intro has already been seen
		// in this tab, so we go straight to SELECT OPERATION MODE. The PRESS ANY
		// KEY gate was also the first gesture that unblocks the audio: without
		// it, the menu's first key or first click provides it.
		prepareMenuMusic();
		const once = (e) => {
			if (e?.repeat) return;
			window.removeEventListener('keydown', once, true);
			window.removeEventListener('pointerdown', once, true);
			try { onFirstGesture(); } catch (err) { console.warn('[startup]', err); }
		};
		window.addEventListener('keydown', once, { capture: true });
		window.addEventListener('pointerdown', once, { capture: true });
	}
	return chooseScene();
}

startup()
	.then((choice) => {
		// Still inside the menu button's click, which is the user gesture the
		// browser's autoplay policy demands before an AudioContext will run.
		audio.start();
		// ?live=: bootLive() has already done everything inside chooseScene() (no
		// manifest to load, no TARGET SCAN) — chooseScene() returns null to say
		// so (#168), and there is nothing more to do here.
		if (choice === null) return;
		// A fresh session: PROFILE / controller / boot() were already started
		// inside chooseScene(), and the hack covered the load.
		if (choice.prepared) return;
		hud.show();
		const { slug, target, family, buildSeed } = choice;
		flyArea = slug;
		flyTarget = target || null;
		// The bench has already resolved its machine in benchLoop(), base and
		// bill of materials and overrides together (#159), and sends back no
		// family and no buildSeed: this path can express neither, and rebuilding
		// from them would quietly fly a different quad.
		if (!MODE.bench) {
			// Keeps the ?family= override when the scan gave no family. With a
			// buildSeed we fly the build; without one (dev override) it is the
			// family's nominal profile.
			const build = family && buildSeed ? targetBuild({ seed: buildSeed, family }) : null;
			PROFILE = build ? build.profile : family ? PROFILES[family] : PROFILE;
			flightBuild = build;
			// D12: same rule as at the bench. `?family=` without `?build=` and
			// `?scene=` without a TARGET SCAN fly a nominal profile — they now
			// keep a portrait all the same.
			flightBuildSeed = build ? buildSeed : nominalBuildSeed(PROFILE?.family);
			if (build) logBuild(build);
			else if (PROFILE) console.log(`[target] family ${PROFILE.family} — ${PROFILE.label} (nominal)`);
		}
		controller = new FlightController({
			...(PROFILE ? {
				profile: PROFILE,
				rates: benchRates ?? flightBuild?.rates,
				throttle: benchThrottle ?? undefined,
			} : {}),
		});
		return boot(slug);
	})
	.then(openFlightSession)
	.catch((err) => {
		console.error(err);
		hud.show();
		uiAudio.play('ERROR');
		hud.fail(bootFailureMessage(err));
	});

// The message the loading screen shows when the boot fails lives in
// tools/boot-failure-model.mjs: it is pure text mapping, and the failure paths
// it covers (a blocked tile server, a refused WASM chunk, a dead GPU) are
// exactly the ones that cannot be reproduced on the machine the game is written
// on — so they get a selftest rather than a hope.

// THE HANDOVER: what is left to do once the last hack screen has given control
// back — the drop, and the flight clock. Everything else — the open session
// (PHASE 06), the target's camera, the props, the OSD — was armed DURING the
// load by armFlight(), just below.
async function openFlightSession() {
	// The `return;` in the `.then((choice) => { if (choice === null) return; ... })`
	// just above cuts ONLY that callback, not the chain: `.then(openFlightSession)`
	// runs all the same with `undefined` (measured — #168, #170). In ?live= mode
	// bootLive() has already opened everything (no server session, no target
	// camera, droneOsd stays null — see the comment on OPTS.live); without this
	// guard session.open() fails silently (no operator loaded) and then
	// applyTargetCamera()/droneOsdLayout() overwrite a state bootLive()
	// deliberately left aside.
	// `?live=` is a DEV shortcut: nothing is mounted on it, not even a camera. So
	// it keeps its immediate return.
	//
	// `MODE.live` no longer is one. #206 made it a real player mode — FIELD
	// reconnaissance — and had it inherit this guard as-is. The unforeseen
	// consequence: the camera + OSD section below NEVER ran, so a reconnaissance
	// flew the default machine WITH NO OSD AT ALL. A drone has an OSD; going
	// without one is a choice you make at the bench (the HUD row), not an
	// accident of the live path (#217).
	//
	// Reconnaissance now takes the BENCH's path: everything runs, except
	// session.open(). That is the proven path, and we do not build ourselves a
	// second one.
	// Dev-only ?live= shortcut. A LIVE flight chosen from the terminal opens a session below (#218).
	// Every flight starts in FPV (D11), this path included.
	if (OPTS.live) { setView('fpv'); return; }
	// Already armed by the boot — behind the loading screen, or behind the hack
	// screen, which awaits this very promise. Awaiting it here all the same is
	// what guarantees that no path can ever fly without a camera or without an
	// OSD, however it reached the flight.
	await armFlight();
	// The drop. The music goes from the hack screen's closed filter to full
	// spectrum: that is the release, and it is the only moment of the arc that
	// must be heard as an event rather than as a drift.
	//
	// Nothing to release if the radio is playing (issue #120): it is already at
	// full spectrum and it was never ducked — culmination.js skips its duck for
	// the same reason. The two gestures go together.
	if (!radio.owns) music.drop();
	// The flight clock starts HERE and not at the arming: between the two sits
	// the [ JACK IN ] prompt, which has no duration — the player can stare at
	// it for a minute. frame() keeps this clock pinned for the whole freeze
	// (introFrozen), so that the OSD already mounted under the last hack screen
	// reads 0 there rather than the time spent in front of the prompt.
	sessionStartedAt = Date.now();
	// D16: briefed, never flown, not the bench — the only flight that gets the
	// three hints.
	hintFlight = !MODE.bench && firstFlightPending(localStorage);
	hintAirborneAt = null;
	fpvtpOsd.setHint(null);
}

// Everything the FIRST VISIBLE frame of a flight must already carry (#122): the
// resolved target, the machine's camera, its props in frame and its OSD.
//
// This used to run after the last hack screen had faded INTO the video feed,
// and session.open() is a server round trip: the randomart gave way to a bare
// map, seen from a camera still sitting at the ENU origin (under the ground on
// the live path), with no OSD at all, and the drone popped in a beat later.
// CONTROL ACQUIRED now hands over straight to the machine's own OSD.
//
// Two call sites, and the split is the whole point:
//
//   - on FIELD, the `commit` of runHack() — the [ JACK IN ] gesture. Not the
//     boot: every screen before that gesture still aborts, and abandoning a
//     hack must leave NOTHING behind, least of all a session on the server.
//     The culmination and the machine's print cover the round trip.
//   - everywhere else (?scene=, the dev ?family= override, the bench), the
//     boot itself, under the loading screen, which is what covers it there.
//
// Idempotent: openFlightSession() awaits it either way, and one of the two has
// always already run.
function armFlight() {
	flightArming ??= armFlightOnce();
	return flightArming;
}

async function armFlightOnce() {
	spawnY = physics.spawn.y;
	spawnX = physics.spawn.x;
	spawnZ = physics.spawn.z;
	// Resolved inside the try, read afterwards: a failed session open must not
	// leave the flight without a camera or without an OSD.
	let tgt = null;
	// NOTHING HERE IS LOGGED. This is THE bench's point of watertightness: no
	// session is opened, so nothing is ever posted, nothing appears in the
	// SESSION LOG or the TARGET LOG, no Randomart is drawn and the counters in
	// the Home's footer do not move — which the BUILD NOTES scale depends on,
	// since it counts sessions.
	//
	// Everything that follows (camera, drone OSD, FPVTP! OSD) still runs: a bench
	// machine has a camera and an OSD like any other. The path is the one a
	// failed session open already takes, where `tgt` stays null — it is proven,
	// and we do not build ourselves a second one.
	try {
		// The bench stays watertight. A LIVE flight, however, does open a session
		// since #218: it has a target, an individual and a hack like a field
		// flight, so it leaves the same trace. Its area is prefixed `live-`,
		// which makes REVISIT impossible on it — you do not revisit terrain you
		// did not keep.
		if (!MODE.bench) {
			await session.open({
				area: flyArea,
				weatherSnapshot: session.snapshotWeather(weather),
				target: flyTarget || undefined,
			});
			// The resolved target arms the video link with the opposing signal's RSSI.
			tgt = session.current()?.target;
			if (tgt?.family && PROFILE && tgt.family !== PROFILE.family) {
				console.warn(`[target] server family ${tgt.family} != client profile ${PROFILE.family} — version skew?`);
			}
			// The server regenerates the scan and hence the buildSeed. If they
			// diverge, the drone being flown is not the one recorded: that does
			// not break the flight, but the archive would lie, so we say so.
			if (tgt?.buildSeed && flyTarget && tgt.buildSeed !== `${flyTarget.seed}::${flyTarget.index}`) {
				console.warn(`[target] server buildSeed ${tgt.buildSeed} != client ${flyTarget.seed}::${flyTarget.index}`);
			}
			if (tgt?.signal) {
				link.setSignal({ rssiDbm: tgt.signal.rssiDbm });
				console.log(`[link] target signal ${tgt.signal.rssiDbm} dBm (${tgt.signal.mode})`);
				// Issue #74: the target drives the link's RENDERING, not only its
				// RSSI. A DIGITAL target used to show analogue macroblocks if the
				// player's setting was on analogue.
				//
				// Two points that matter:
				//
				// - `signal.mode` carries `_videoHint`, which is always ANALOG or
				//   DIGITAL. The `UNKNOWN` the sheet sometimes shows is what was
				//   REVEALED to the player, not what the target is. So the
				//   rendering shows what the sheet withheld — deliberately: you
				//   recognise a digital link by looking at it.
				// - the severity stays the player's. At severity 0 they turned the
				//   link model off, and a target has no business turning it back
				//   on: we stay LINK_OFF. The setting also keeps the mode on the
				//   dev path with no target (?scene=), where this block does not
				//   run.
				if (lensLinkMode !== LINK_OFF) {
					const m = String(tgt.signal.mode ?? '').toUpperCase();
					if (m === 'DIGITAL' || m === 'ANALOG') {
						lensLinkMode = m === 'DIGITAL' ? LINK_DIGITAL : LINK_ANALOG;
						lens.setLink({ mode: lensLinkMode, severity: loadLink().severity });
						console.log(`[link] ${m} rendering imposed by the target`);
					}
				}
			}
		}
	} catch (e) {
		console.warn('[session] open failed, this flight will not be recorded', e);
	}

	// The seed: the target if there is one, the bench's individual if there is
	// one, the profile's family otherwise (dev mode, ?scene=). There is always a
	// camera and always an OSD.
	//
	// The bench's individual comes in here so that INDIVIDUAL means something end
	// to end: two draws of the same family must differ in their camera and their
	// OSD, not only in their rates.
	const benchSeed = MODE.bench && MODE.config?.airframe.seed
		? `bench::${MODE.config.airframe.seed}` : null;
	const seed = session.current()?.id ?? benchSeed ?? `dev::${PROFILE.family}`;
	const family = tgt?.family ?? PROFILE.family;
	const mode = tgt?.signal?.mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';

	// The ambients (issue #250): the client's scan (a fresh session), or the one
	// the persisted session kept (schema v2), or a dev scan under ?scene=, or
	// nothing.
	ambient?.setScan(
		flyTarget ?? tgt?.scan ?? (OPTS.scene && !MODE.bench
			? { seed: `dev::${flyArea}`, count: 4, index: 0, ...(devSwarm ? { swarmAt: 0, swarmChance: 1, swarm: devSwarm } : {}) }
			: null),
	);

	// The swarm (issue #29): the one the resolved target carries, or the one
	// `?swarm=` set on a dev path. Nothing at all otherwise — a cluster comes up
	// one session in ten. The target comes BEFORE the flag: a server session that
	// draws a cluster overrides `?swarm=n`, exactly as `ambient.setScan()` just
	// above prefers the session's scan to the dev scan. The flag is a shortcut
	// for the paths that have no session, not an override of what the server
	// resolved.
	const flightSwarm = tgt?.swarm ?? devSwarm ?? null;
	// The `others` bus (src/audio-others.js): ONE write per flight, here, because
	// here is where it is known. With no swarm the ambients get the whole ceiling
	// — their level from #250 — instead of reserving, in nine flights out of ten,
	// a share nobody will take. With a swarm, the shared portion, which is what
	// makes the ceiling structural.
	setSwarmPresent(!!(swarm && flightSwarm));
	swarm?.setSwarm(flightSwarm);
	swarm?.reset(physics.position);

	applyTargetCamera(targetCamera({ seed, family }));

	// The player's drone (issue #264) — HERE and not in boot(): the recipe reads
	// the uptilt of the target's camera, which was resolved on the line above.
	// The profile is the one that FLIES (physics.profile), not `PROFILE`: an
	// airframe change at the bench goes through physics.setProfile().
	lens.setOnboard(null);
	playerDrone?.dispose();
	playerDrone = new PlayerDrone({
		scene,
		profile: physics.profile,
		build: flightBuild,
		camera: camSpec,
	});
	// The station follows the same build (#264): that is where the end of the
	// flight draws its portrait from. The server is authoritative when it has
	// answered — it is the one that drew the target; otherwise the client seed,
	// which is the same.
	//
	// D12: there are ALWAYS both. The family is read off the physics, which
	// never flies without a profile, and a nominal flight carries its family's
	// nominal seed — the end screen no longer loses the machine for want of a
	// draw.
	const shownFamily = tgt?.family ?? physics.profile.family;
	fpvtpOsd.setTarget({
		family: shownFamily,
		buildSeed: tgt?.buildSeed ?? flightBuildSeed ?? nominalBuildSeed(shownFamily),
		// The SAME seed as the target camera just above and as PlayerDrone: the
		// machine on the end screen wears the pod that flew, not a second
		// draw.
		cameraSeed: seed,
	});
	// The props in frame: the composer's second pass, its camera at near = 5 mm.
	// Unplugged in CHASE view — the same rule of exclusivity. Every flight
	// starts in FPV (D11): setView() plugs both passes back in.
	setView('fpv');

	droneOsd?.dispose();
	// The NO_OSD failure (see drone-osd-model.mjs) returns null: some targets
	// simply have no OSD, or theirs is switched off or broken.
	// HUD CLEAR at the bench: a machine built without an OSD, for filming (#217).
	// No layout is drawn at all — that is exactly the state `droneOsdLayout()`
	// already returns for its NO_OSD failure, so nothing downstream has to know
	// about this setting. The setting is the BENCH's: FIELD reconnaissance does
	// not read it, it always has its OSD.
	const hudClear = MODE.bench && MODE.config?.hud === 'CLEAR';
	const osdLayout = hudClear ? null : droneOsdLayout({ seed, family, mode });
	droneOsd = osdLayout ? new DroneOsd(osdLayout) : null;
	lens.setOsd(droneOsd);
	fpvtpOsd.show();
	console.log(`[camera] ${camSpec.aspectName} ${Math.round(camSpec.fovDeg)}° uptilt ${Math.round(camSpec.uptiltDeg)}° res ${Math.round(camSpec.resScale * 100)}%`);
}

// The tab closed mid-flight: best-effort to make the CRASHED real. If that
// fails (a genuine browser crash), the server's reconciliation handles it on the
// terminal's next load.
window.addEventListener('beforeunload', () => {
	if (session.current()?.result === 'PENDING') session.beacon('CRASHED');
	// openFlightSession()'s `droneOsd?.dispose()` is the START of a flight, not
	// a teardown: the ambients have no business there. The only page teardown is
	// here (issue #250).
	ambient?.dispose();
	swarm?.dispose();
	lens.setOnboard(null);
	playerDrone?.dispose();
	playerDrone = null;
});
