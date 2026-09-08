import * as THREE from 'three';
import { loadManifest, loadChunks, loadCollision, loadSceneList, sceneBase, setFog, setDim, setNight, setDistantGround, releaseTileMaterials } from './loader.js';
import { releaseTexturePixels } from './TileMaterial.js';
import { initPhysics, Physics } from './physics.js';
import { crashThreshold, idleThrottle } from './quad.js';
import { CHASE, chaseTarget, chaseStep } from './chase-camera.js';
import { generateEntryState } from './entry-state.js';
import { FlightController, RATE_PRESETS } from './flightController.js';
import { PROFILES, FAMILIES, nominalBuildSeed } from './drone-profiles.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Settings, loadVolume, loadBrightness, loadMusicVolume, loadLens, loadLink, loadViewRange } from './settings.js';
import * as operator from './operator.js';
import { bootstrap } from './bootstrap.js';
import { operatorSelect, operatorKey, runTerminal, archiveScreen, fetchScenes } from './terminal.js';
import { installClickFlash } from './motion.js';
import { EngineAudio } from './audio.js';
import { uiAudio } from './ui-audio.js';
import { runIntro } from './intro.js';
import { shouldPlayIntro, markIntroSeen } from '../tools/intro-model.mjs';
import { runBriefing } from './briefing.js';
import { shouldBrief, markBriefed, markFirstFlight, firstFlightPending, flightHint } from '../tools/briefing-model.mjs';
import { keyMapRows } from './key-map.js';
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
import { createRocktreeMaterial, createLiveEdgeUniforms } from './RocktreeMaterial.js';
import { worldWeather, applyWeather, applySimParams, headline, CALM } from './weather.js';
import { selectOperationMode, runBench, loadLastMode } from './bench.js';
import { benchSimParams, benchEntryRequest, benchDate } from '../tools/bench-model.mjs';
import * as session from './session.js';
import { runTargetScan } from './target-scan.js';
import { generateTargetScan, swarmChanceFor, SWARM_SIZE_MIN, SWARM_SIZE_MAX } from '../tools/target-model.mjs';
import { runHack } from './hack.js';
import { normalizeHackType } from '../tools/hack-model.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { music } from './music.js';
import { space } from './space.js';
import { flightIntensity, PHASE_INTENSITY, FADE } from '../tools/music-model.mjs';
import { droneOsdLayout } from '../tools/drone-osd-model.mjs';
import { liveAreaId } from '../tools/session-log-model.mjs';
import { DroneOsd } from './drone-osd.js';
import { FpvtpOsd } from './fpvtp-osd.js';
import { creditText } from './provider-credit.js';
import { FlightEnd, FLYING } from './flight-end.js';
import { Geofence, NOMINAL as FENCE_OK } from './geofence.js';
import { DistantGround } from './ground.js';
import { localEnuToEcef, ecefToGeodetic } from '../tools/lib/rocktree/geodesy.mjs';
import { push as rocktreeFencePush } from './rocktree-fence.js';
import { RocktreeWindow } from './rocktree-window.js';
import { warmUp as warmUpTraverseWorker } from './rocktree-traverse-client.js';
import { warmUp as warmUpNodePool } from './rocktree-worker-pool.js';
import { AmbientDrones } from './ambient-drones.js';
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
	// Dev-only override: ?family=race5 flies that drone family regardless of the
	// TARGET SCAN choice (PHASE 08). One of:
	//   freestyle5 race5 cinewhoop longrange heavy5 toothpick
	family: params.get('family'),
	// Dev : avec ?family=, la graine d'un exemplaire (livrée, châssis, portrait
	// — #285). Sans elle, ?family= reste le profil NOMINAL, gris et sans
	// portrait, comme au banc.
	build: params.get('build'),
	// Dev-only : ?hack=gnss-spoof prévisualise le motif de ce type de hack
	// avant le vol, sur les chemins qui sautent le TARGET SCAN (?scene=/?family=).
	hack: params.get('hack'),
	// Dev-only : ?date=2026-06-21T23:52:00Z fige le soleil à cet instant —
	// c'est ce qui permet de vérifier la nuit (#111) en plein jour. Une date
	// invalide donne un NaN silencieux dans sunPosition(), d'où le garde.
	// Dev-only : ?night=1 rétablit la nuit, désactivée temporairement (cf.
	// NIGHT_FLOOR_DEG dans sun.js). Se combine avec ?date= pour viser une heure.
	night: params.get('night') === '1',
	date: (() => {
		const d = params.has('date') ? new Date(params.get('date')) : null;
		return d && Number.isFinite(d.getTime()) ? d : null;
	})(),
	// Dev-only : ?live=48.8584,2.2945 vole en direct depuis rocktree, sans
	// scène pré-cuite (#168). Pas de météo/geofence/écran de crédit — voir le
	// plan d'implémentation pour ce qui est volontairement hors périmètre.
	live: params.has('live') ? params.get('live').split(',').map(Number) : null,
	// Dev-only: ?swarm=8 forces a cluster of 8 on ?scene= and ?live=, the two
	// paths that skip the TARGET SCAN and synthesise their own scan (#29).
	// Clamped to the size a real draw can produce, so the dev path never shows
	// a swarm the game itself could not.
	swarm: params.has('swarm') ? Number(params.get('swarm')) : null,
};
if (OPTS.swarm !== null && !Number.isInteger(OPTS.swarm)) {
	throw new Error(`?swarm= expects an integer — got "${params.get('swarm')}"`);
}
// The swarm a dev scan carries, or null. Same shape as the one resolveTarget()
// persists, so whatever reads it does not care where the scan came from.
const devSwarm = OPTS.swarm === null ? null : {
	size: Math.min(SWARM_SIZE_MAX, Math.max(SWARM_SIZE_MIN, OPTS.swarm)),
	doctrineSeed: `dev::swarm::${OPTS.swarm}`,
};
// `?live=foo` donnait [NaN] : origine ENU NaN, spawn NaN, requêtes rocktree sur
// une tuile inexistante — un monde silencieusement invalide où le drone dérive
// dans le vide sans le moindre message. Planter ici, tôt et lisiblement.
if (OPTS.live && (OPTS.live.length !== 2 || !OPTS.live.every(Number.isFinite))) {
	throw new Error(`?live= attend "lat,lon" numériques — reçu "${params.get('live')}"`);
}
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
// Dernier gain nuit poussé vers lens.setSensor() — pour ne pousser que les
// changements, et pour que applyTargetCamera() recompose la nuit en cours.
let lastNightGain = 0;
const settings = new Settings(document.getElementById('ui'), input);
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
// Une touche de menu pressée s'inverse un instant (issue #224).
installClickFlash();
// Construit dans le gate de chooseScene(), une fois PROFILE résolu (PHASE 08).
// Aucune ligne avant le gate ne l'utilise à l'exécution.
let controller;
// Inert until start(): no AudioContext exists before the user's first gesture.
const audio = new EngineAudio();
// L'état de l'hystérésis d'annonce du lien, conservé entre deux frames.
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
// path de nœud -> [{ colliderPath, mesh }], mode ?live= (#168). Clé le NŒUD et
// non le collider (#179) : une libération retrouvait ses sous-maillages en
// balayant TOUTE la table (copie comprise), soit O(nœuds chargés) par nœud
// libéré — quadratique sur le recentrage d'une fenêtre de plusieurs centaines.
const liveMeshes = new Map();
let liveWindow = null;          // RocktreeWindow actif en mode ?live=, sinon null
let fenceDome = null;           // FenceDome actif en mode ?live=, sinon null (#198)
let liveEdgeUniforms = null;    // uniformes partagés du fondu de bord du terrain live, sinon null (#202)

// Files du mode ?live= (#184) : les nœuds reçus/libérés attendent ici, et
// processLiveNodeWork() les traite sous un budget par frame — le travail par
// nœud est petit (~1,4 ms) mais arrive en rafales de plusieurs dizaines par
// frame, et l'exécuter à l'arrivée gelait le rendu 70-330 ms par vague.
const pendingNodeBuilds = new Map();    // path -> { matrix, meshes, sphereRadius }
const pendingNodeReleases = [];         // paths dont mesh+collider sont à retirer
// ~3 ms : ce qui tient dans une frame de 60 fps déjà occupée par la physique
// et le rendu sans la faire déborder de 16,7 ms. Une vague de 800 nœuds
// (~1,1 s de travail) s'étale ainsi sur ~5 s au lieu de geler l'image —
// le tri par distance de rocktree-window.js fait apparaître le proche d'abord.
const NODE_WORK_BUDGET_MS = 3;
// Budget adaptatif (#189) : quand la file est profonde (recentrage de
// fenêtre en vol), 3 ms/frame étalent une vague de 300 m sur 10-15 s de
// remplissage visible. 8 ms restent sous une frame de 60 fps (steps ~1,6 ms
// + rendu ~5 ms + 8 ≈ 15 ms, mesuré #187) et remplissent ~2,5× plus vite.
// Le seuil évite de payer 8 ms sur le goutte-à-goutte normal (file quasi
// vide : les nœuds arrivent au rythme du réseau).
const DEEP_QUEUE_JOBS = 50;
const DEEP_QUEUE_BUDGET_MS = 8;

// Draine les files sous budget. Les libérations d'abord : elles rendent de la
// mémoire et leur retard laisserait des meshes fantômes hors fenêtre.
function processLiveNodeWork(budgetMs = (pendingNodeBuilds.size > DEEP_QUEUE_JOBS ? DEEP_QUEUE_BUDGET_MS : NODE_WORK_BUDGET_MS)) {
	if (!liveWindow) return;
	const start = performance.now();
	while (performance.now() - start < budgetMs) {
		if (pendingNodeReleases.length > 0) {
			const path = pendingNodeReleases.shift();
			for (const { colliderPath, mesh } of liveMeshes.get(path) ?? []) {
				scene.remove(mesh);
				mesh.geometry.dispose();
				// material.dispose() ne libère pas la texture (#191) : elle pèse
				// ~580 Kio décodée (ImageBitmap) côté CPU, plus l'upload GPU — sans
				// ces deux lignes ça fuit à chaque nœud sorti de la fenêtre, donc
				// avec la distance parcourue et non la taille du monde. Le seul cas
				// sans texture est le matériau gris plat (pas de bitmap/uvs, voir
				// buildNodeMesh) : rien à fermer alors. .uniforms.uMap, pas .map :
				// createRocktreeMaterial() (#202) est un ShaderMaterial, qui n'a pas
				// le raccourci .map des matériaux standard de Three.
				const liveMap = mesh.material.uniforms?.uMap?.value;
				if (liveMap) {
					liveMap.dispose();
					liveMap.image.close();
				}
				mesh.material.dispose();
				physics.removeNodeCollider(colliderPath);
			}
			liveMeshes.delete(path);
			continue;
		}
		const next = pendingNodeBuilds.entries().next();
		if (next.done) break;
		const [path, job] = next.value;
		pendingNodeBuilds.delete(path);
		const built = buildNodeMesh(path, job.meshes);
		const entries = [];
		liveMeshes.set(path, entries);
		for (const { mesh, colliderPath, vertices, indices } of built) {
			// Le collider EN PREMIER (#179) : c'est la seule de ces étapes qui
			// puisse lever (chemin déjà chargé, trimesh refusé par Rapier). Le
			// mesh était auparavant ajouté à la scène avant elle et enregistré
			// après — une exception sur le premier sous-maillage d'un nœud
			// laissait donc un mesh dans la scène que plus rien ne libérait.
			physics.addNodeCollider(colliderPath, vertices, indices);
			scene.add(mesh);
			// Upload GPU à l'arrivée, sous CE budget, plutôt qu'au premier
			// rendu — sinon Three téléverse toutes les textures de la vague
			// dans la frame où elles deviennent visibles.
			const liveMap = mesh.material.uniforms?.uMap?.value;
			if (liveMap) renderer.initTexture(liveMap);
			entries.push({ colliderPath, mesh });
		}
	}
	// UN refit du query-BVH pour tout le lot de la frame (#187) — add/remove
	// ne le paient plus chacun. Doit rester APRÈS la boucle : groundBelow()
	// (spawn, AGL) lit le pipeline au plus tard à la frame suivante.
	physics.flushNodeColliders();
}
// Le mode d'opération de ce chargement (PHASE 26, Bible §48).
//
// FIELD est le jeu : une cible qui n'est pas à toi, un lien qui se dégrade,
// une session écrite, un crash qui perd la machine.
// BENCH est le banc : NO TARGET, NO LINK, NO HACK, NO LOSS, NOTHING LOGGED.
//
// Un objet traversé, et surtout PAS un second pipeline de boot. bootLive() a
// forké la fin de finishBoot() à la main et l'a payé trois fois (#168, #170 —
// settings.flightActive, lastTime, exposeDebugGlobal oubliés tour à tour). Le
// banc réutilise boot(slug) et bootLive() tels quels ; tout ce qu'il ajoute
// est ce drapeau et les gardes qui le lisent.
// `live` : un vol de RECONNAISSANCE en FIELD, décollé depuis le scanner sans
// rien cuire (D7 — un mode ne se donne pas son propre chemin de boot, il
// traverse celui qui existe avec un drapeau ; ici bootLive(), le même que
// ?live= et que le banc). Il ne laisse rien : ni session, ni cible, ni ligne de
// journal — un vol live ne garde aucun terrain, il ne doit donc garder aucun vol
// (§2.2, terrain persistent, flights ephemeral).
const MODE = { bench: false, live: false, config: null };
// Les rates d'un exemplaire tiré au banc, posés avant bootLive() qui construit
// son contrôleur lui-même. null en FIELD et pour ?live= : le contrôleur
// retombe alors sur RATE_PRESETS[preset], comme avant.
let benchRates = null;
// L'instant que le banc donne au soleil. Recalculé quand l'heure change, et
// pas à chaque frame : sun.update() tourne à 60 Hz et n'a pas besoin qu'on lui
// fabrique une Date soixante fois par seconde.
let benchClock = null;

// Le panneau du banc est-il ouvert par-dessus le vol ? Gèle la sim comme le
// fait le panneau Settings : on règle une machine à l'arrêt, pas en vol libre.
let benchPanelOpen = false;

// Applique au monde vivant tout ce que la config du banc décide. Appelée au
// boot ET à chaque changement du panneau en vol : c'est le même chemin, donc
// un réglage se comporte pareil avant et pendant le vol.
function applyBenchConfig() {
	if (!MODE.bench || !MODE.config) return;
	const c = MODE.config;
	benchClock = benchDate(c);
	applySimParams(benchSimParams(c), { physics, rain, fog, cloud, sun });

	// La cellule, à chaud. physics.setProfile() reconstruit la Propulsion et
	// les propriétés de masse du corps Rapier sans recharger la scène ; c'est
	// déjà ce que fait tools/selftest.mjs pour parcourir les six familles.
	// Le contrôleur suit : ses PID sont ceux du profil, pas des constantes.
	const build = c.airframe.seed ? targetBuild({ seed: c.airframe.seed, family: c.airframe.family }) : null;
	const profile = build ? build.profile : PROFILES[c.airframe.family];
	if (physics && profile && physics.profile?.family !== profile.family) {
		physics.setProfile(profile);
		PROFILE = physics.profile;
		audio.setProfile(physics.profile);
		controller = new FlightController({ profile: PROFILE, rates: build?.rates });
		console.log(`[bench] cellule → ${PROFILE.family} (${PROFILE.label})`);
		// Le drone du joueur suit la cellule (#286) : ses hélices, sa livrée et
		// son châssis sont ceux de l'exemplaire qui vole, pas de l'ancien —
		// sans ça, les hélices de l'ancienne machine restaient dans le champ
		// (noté au HANDOFF depuis #264).
		if (playerDrone && camSpec) {
			lens.setOnboard(null);
			playerDrone.dispose();
			playerDrone = new PlayerDrone({ scene, profile: physics.profile, build, camera: camSpec });
			playerDrone.setChase(viewMode === 'chase');
			lens.setOnboard(viewMode === 'chase' ? null : playerDrone.onboardScene, playerDrone.onboardCamera);
		}
	}
	// physics.battery est un getter vers propulsion.battery, et setProfile()
	// reconstruit la Propulsion — donc le pack. Reposer le drapeau ICI, après
	// le changement de cellule et non une seule fois au boot, est ce qui fait
	// qu'un changement de cellule en vol ne rend pas la charge en douce.
	physics?.battery?.setDrain(c.battery !== 'HELD');
}

// Le panneau du banc, ouvert par-dessus le vol (touche B). Le MÊME écran que
// la configuration d'avant décollage, en mode `live` : un réglage doit se
// comporter pareil avant et pendant, sinon le banc ment sur ce qu'il règle.
async function toggleBenchPanel() {
	if (benchPanelOpen) return;
	benchPanelOpen = true;
	// Le curseur souris appartient au vol : sans ça, le pointer lock avale les
	// clics du panneau et rien n'est réglable.
	document.exitPointerLock?.();
	try {
		MODE.config = await runBench(document.getElementById('ui'), {
			live: true,
			onChange: (c) => { MODE.config = c; applyBenchConfig(); },
		}) ?? MODE.config;
	} finally {
		benchPanelOpen = false;
		// Même recalage que la sortie de pause : ne pas rejouer l'écart
		// d'horloge accumulé pendant le réglage comme un pas de physique géant.
		accumulator = 0;
		lastTime = performance.now();
	}
}

// Les limites de la zone (#139) et ce qu'on voit au-delà. Les deux naissent
// dans finishBoot(), une fois la bbox du manifeste connue : sans carte, il n'y
// a ni clôture ni horizon à dessiner.
let fence = null;
let geofenceWall = null;   // GeofenceWall actif hors ?live=/banc, sinon null (#199)
let distantGround = null;
// Les drones ambiants (issue #250) : null au banc (NO TARGET) et tant que la
// carte n'est pas chargée. `liveBounds` est la bulle du DIRECT : muté à
// chaque frame, jamais remplacé — le modèle en garde la référence.
let ambient = null;
const liveBounds = { center: null, trusted: 0 };
// La résolution en pixels device, pour le billboard de LED des ambiants
// (même piège que uResolution dans lens.js). Mise à jour dans resize().
const ambientRes = { w: 1, h: 1 };
// La force du rappel, écrite une fois par PAS de physique plutôt qu'allouée —
// même règle que `drift` plus bas : ceci tourne à 250 Hz. Rapier recopie le
// vecteur dans addForce(), rien ne le retient après le pas.
const _fenceForce = { x: 0, y: 0, z: 0 };
// Le manifeste de la scène, hissé de boot() : l'OSD drone en tire la lat/lon.
let sceneManifest = null;
let emitter = null;
// Le drone du joueur (issue #264) : monté à l'ouverture de session, une fois la
// caméra de la cible connue — la recette lit son uptilt. Null au banc en vol
// libre ?live=, comme les ambiants : ce chemin de dev ne monte pas de caméra.
let playerDrone = null;
// Le champ de la caméra de vol, tel que la vue embarquée le recopie. Alloué une
// fois : le chemin de vol n'alloue rien par frame.
const playerCam = { fov: 120, aspect: 1 };
// The build drawn for THIS flight, hoisted out of the places that resolve it
// (terrain, live, bench, override). PROFILE already carries its profile; the
// recipe wants the build itself. Null when a nominal profile is flown.
let flightBuild = null;
// Et sa GRAINE, la même que le serveur reconstruit dans resolveTarget(). Le
// portrait fil de fer (#264) ne se déduit que de `family` + `buildSeed` : c'est
// aussi ce qui fait qu'une session déjà journalisée sait afficher sa machine.
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
// Horodatage du début RÉEL de vol (sticks actifs), posé à chaque endroit qui
// remet lastTime à zéro pour cette raison. Sert à ignorer Espace pendant les
// 5 premières secondes : sans ça, une pause prise par réflexe pendant le
// Control Vector (qui gèle le monde mais pas les touches) arrive telle
// quelle au lâcher des sticks, et le joueur atterrit sur un jeu en pause sans
// avoir voulu y entrer.
let flightStartTime = 0;
const PAUSE_GUARD_MS = 5000;
// Le hack + le rituel (vector code, demo scene) tournent devant un monde déjà
// chargé et physiquement actif (#22) : sans ce gel, le drone tombe pendant que
// le joueur regarde encore l'écran d'analyse, avant d'avoir touché les sticks.
let introFrozen = false;
let crashed = false;

// Garde le [ENTER] DISCONNECT (PHASE 15) idempotent : exitArmed reste vrai une
// fois posé, une touche maintenue ou un second événement ne doit pas ouvrir
// deux fois le POST-FLIGHT ANALYSIS ni déclencher deux reloads.
let exiting = false;

// État « bouton manette tenu » pour la sortie de fin de vol (issue #123).
// Vrai par défaut : seul un front montant APRÈS l'armement de la sortie
// déclenche la déconnexion.
let exitPadHeld = true;

// PHASE 16 : levé par la touche capture, consommé une fois par frame juste
// après lens.render() — c'est cette frame-là, déjà rendue, que lens.capture()
// redessine à la résolution du capteur cible. L'OSD FPVTP! (overlay DOM
// séparé, jamais dans le canvas) n'y figure jamais.
let pendingCapture = false;

const flightEnd = new FlightEnd();

// Le lien vu par lens.js quand la machine est morte : quality 0 et frozen sont
// exactement ce que le shader interprète déjà comme « plus rien n'arrive ».
// Aucun code d'image nouveau, seulement le mode de dégradation le plus profond.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };
let linkForced = false;

// Le mode choisi par le joueur dans les réglages du lien, mémorisé pour que la
// séquence de crash puisse forcer une dégradation même s'il a coupé le modèle.
let lensLinkMode = LINK_OFF;

// The ground under the drone, one Rapier raycast per frame — physics.groundBelow
// is a full-mesh test, not something to redo twice for the same position.
// Recomputed only when physics advances; the freeze (pause, settings, intro)
// leaves the drone still, so the last value stays correct until something moves.
let groundY = null;
// The area being flown (= scene slug) and the spawn altitude, for the session.
let flyArea = null;
let flyTarget = null;
// La zone du vol en cours, sous la forme attendue par fieldLoop() (#253) : posée
// dès que le TARGET SCAN démarre, relue par finishSession({redeploy:true}) pour
// permettre de relancer la même zone sans repasser par le terminal.
let lastZone = null;
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

// La caméra de la cible : appliquée une fois, au moment où l'on prend la main.
// Elle touche le champ, l'inclinaison, le format, la définition et le capteur —
// et rien d'autre : le vol n'en dépend pas.
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
// Charge une zone SANS rien monter dans la scène Three : les meshes sont
// seulement rendus à l'appelant, et c'est finishBoot() qui les monte, une fois
// la zone réellement engagée. C'est ce qui rend un préchargement orphelin
// inoffensif — le TARGET SCAN est annulable, et un retour au choix de zone
// laisse ce chargement finir tranquillement au lieu de l'abandonner (voir
// preloadFor).
async function preloadScene(slug) {
	const base = sceneBase(slug);
	const t0 = performance.now();
	hud.startClock();

	stage('manifest');
	hud.progress('lecture du manifest…', 0.01);
	const manifest = await loadManifest(base);

	const totalMB = (manifest.chunks.reduce((s, c) => s + c.geoBytes + c.texBytes, 0)
		+ manifest.collision.bytes) / 1e6;
	hud.detail(`${totalMB.toFixed(0)} Mo à charger`);

	stage('rapier-init');
	hud.progress('initialisation de la physique…', 0.02);
	await initPhysics();

	stage('chunks');
	const { meshes, timings } = await loadChunks(manifest, base,
		{ fogColor: SKY, fogDensity: FOG_DENSITY, maxChunks: OPTS.maxChunks,
		  mipmaps: OPTS.mipmaps, anisotropy: OPTS.anisotropy },
		({ bytes, totalBytes, done, total, decoding }) => {
			hud.progress(`tuiles ${done}/${total}${decoding > 0 ? ` — décodage de ${decoding} planche(s)…` : '…'}`,
				0.02 + 0.45 * (bytes / totalBytes));
			hud.detail(`${(bytes / 1e6).toFixed(0)} / ${(totalBytes / 1e6).toFixed(0)} Mo`);
		});
	console.log('chunk timings (ms):', JSON.stringify(timings));

	stage('collision-download');
	const collision = await loadCollision(manifest, base, (f, received) => {
		hud.progress('maillage de collision…', 0.47 + 0.28 * f);
		hud.detail(`${(received / 1e6).toFixed(0)} / ${(manifest.collision.bytes / 1e6).toFixed(0)} Mo`);
	});

	return { slug, manifest, meshes, collision, t0 };
}

// The rest of boot(): needs PROFILE (the target's family, resolved by TARGET
// SCAN) to build the right airframe, but everything in here is local compute
// — no network — so it stays cheap enough to hide behind the hack/ritual
// hold that already follows TARGET SCAN. Takes preloadScene()'s return value
// (or its promise — awaited here, not by the caller) so the two stages chain
// without the caller needing to know boot() is split in two.
// Extrait pour être appelable aussi depuis bootLive() (#168, #170) — mode
// ?live= sans finishBoot(). Même objet de contrôle/debug des deux côtés ;
// certains champs (weather, distantGround, sun, rain, fog, cloud) restent
// null en mode direct, ce qui ne pose problème que si un appelant invoque
// debug()/teleport()/setWeather() dans ce mode — aucune vérification
// existante ne le fait.
function exposeDebugGlobal() {
	window.__sim = {
		physics, controller, camera, renderer, scene, input, timeline, audio, music, space, lens, link, rain, fog, cloud, sun,
		fence, distantGround,
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
		// Les drones ambiants (issue #250), ou null (banc, avant la carte).
		ambient: () => ambient,
		teleport(x, y, z) {
			physics.body.setTranslation({ x, y, z }, true);
			physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			flightEnd.reset();
			fence.reset();
			// Sinon un second crash dans la même page ne re-forcerait pas la
			// dégradation du lien : setLink(true) ne s'exécute qu'un coup par vol.
			linkForced = false;
			// Un saut arbitraire laisserait les ambiants derrière, hors bulle.
			ambient?.reset();
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
					rangeWithRain: Math.round(fogRange(fog.density + rain.extinction + cloud.extinctionAt(p.y - spawnY))),
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
				// Ce qui permet de vérifier la clôture dans le vrai navigateur
				// plutôt que de regarder une capture et d'y croire.
				fence: {
					zone: fence.out.zone,
					// ATTENTION : ce n'est PAS la distance au bord. C'est
					// min(marge horizontale, marge verticale − v.edge), et en
					// vol normal c'est presque toujours le terme VERTICAL qui
					// sort.
					//
					// Mesuré sur tour-eiffel (bbox.min.y = −30,9), au centre de
					// la bbox, à y = 60 en coordonnées ABSOLUES : la marge
					// horizontale vaut 640,6 m et ce champ n'affiche que 98,9.
					//
					// Le REPÈRE compte, et c'est ce qui a déjà produit trois
					// chiffres différents pour la même grandeur : décrire le
					// même vol comme « 60 m au-dessus du plancher » (y absolu
					// 29,1) donne 68,0, pas 98,9. Dire lequel des deux, ou ne
					// pas citer de nombre.
					//
					// La ZONE, elle, ne souffre pas de ce mélange : elle vient
					// de max(rang) des deux couloirs, qui restent indépendants.
					marginM: +fence.out.marginM.toFixed(1),
					t: +fence.out.t.toFixed(3),
					lossDb: +fence.out.lossDb.toFixed(1),
					warning: fence.out.warning,
					over: fence.out.over,
					pushMs2: +Math.hypot(fence.out.push.x, fence.out.push.y, fence.out.push.z).toFixed(2),
					corridor: fence.effectiveCorridor,
				},
				// Le ciel habité (issue #250) : undefined au banc, où il n'y a
				// pas d'ambiants du tout.
				ambient: ambient?.debug(),
			};
		},
	};
	window.__simInput = null;
}

async function finishBoot(preloading) {
	const preloaded = await preloading;
	const { manifest, meshes, collision, t0 } = preloaded;

	// Le montage dans la scène a lieu ICI et pas dans preloadScene() : à partir
	// de cet instant la zone est engagée, on ne revient plus en arrière.
	sceneManifest = manifest;
	fpvtpOsd.setCredit(creditText(manifest));
	for (const m of meshes) scene.add(m);

	// In the scene, not over it: the streaks go through the RenderPass, so the
	// lens distorts, vignettes, smears and breaks them up like everything else,
	// and the city occludes them.
	rainfall = new Rainfall(scene, { sky: SKY });
	rainfall.setSize(innerHeight * renderer.getPixelRatio(), camera.fov);

	stage('collision-build');
	hud.progress('construction de l’arbre de collision…', 0.76);
	hud.detail(`${(manifest.collision.indexCount / 3).toLocaleString()} triangles`);
	await nextPaint();
	physics = new Physics(collision, manifest.spawn, PROFILE ? { profile: PROFILE } : {});
	// Le collision.bin a été copié dans la mémoire WASM : plus rien ici n'en
	// relit les tableaux JS. On les rend tout de suite (issue #249) — le cache
	// des préchargements retiendrait sinon la zone entière jusqu'au prochain
	// rechargement, et le Collider Rapier en garde une vue de son côté.
	physics.releaseSourceArrays(collision);
	preloaded.collision = null;
	// Sur les chemins sans cible (?scene=, mode dev sans ?family=), PROFILE n'a
	// jamais été résolu et Physics est retombé sur son profil par défaut. Les
	// deux couches d'OSD lisent la batterie et la masse du profil à chaque
	// image : on adopte ici celui qui vole réellement, une fois pour toutes.
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	if (OPTS.family) console.log(`[family] ${physics.profile.family} — ${physics.profile.label}`);

	// Les limites de la zone (#139). Construites AVANT le tirage du point
	// d'entrée juste en dessous : c'est la même bbox, et entry-state.js s'en
	// sert désormais pour ne jamais naître dans l'avertissement.
	//
	// FENCE OFF au banc : une clôture immense plutôt qu'une branche dans
	// frame(). Même motif que le mode ?live= plus bas — la zone reste toujours
	// NOMINAL et le rappel toujours nul, donc tout ce qui lit fence.out (la
	// force, l'OSD, la fin de vol hors couverture) continue de fonctionner sans
	// rien savoir du banc. Le terrain, lui, s'arrête quand même au bord du
	// rectangle acquis : c'est dit avant le décollage, pas découvert dans le vide.
	fence = MODE.bench && !MODE.config.fence
		? new Geofence({ min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] })
		: new Geofence(manifest.bbox);
	// Muraille numérique (#199) : seulement pour une vraie bbox de carte —
	// la bbox ±1e6 du banc sans clôture n'a rien à border visuellement, même
	// logique que le fence géant plus bas en mode ?live=/bootLive().
	geofenceWall = (MODE.bench && !MODE.config.fence) ? null : new GeofenceWall(scene, manifest.bbox);
	const ec = fence.effectiveCorridor;
	console.log(`[fence] couloir ${ec.caution.toFixed(0)}/${ec.hold.toFixed(0)} m`
		+ ` (échelle ${ec.scale.toFixed(2)}, demi-côté ${ec.halfMinM.toFixed(0)} m)`);
	// Et ce qu'on voit au-delà du dernier chunk. Monté ici, avant le
	// renderer.compile() de la fin du chargement : sa matière doit compiler
	// derrière l'écran de chargement, pas à la première frame de vol.
	//
	// Un seul par page : finishBoot() n'est appelé qu'une fois (ses deux
	// appelants s'excluent) et changer de zone recharge la page. Si un
	// démontage de scène apparaît un jour, il devra faire dispose() PUIS
	// setDistantGround(null) — l'enregistrement de loader.js ne doit pas
	// survivre à l'objet, setFog/setNight/setDim écriraient sur une matière
	// libérée.
	//
	// La météo n'a pas encore été appliquée à ce stade : ces deux valeurs sont
	// l'air clair du départ, et la première frame les réécrit toutes les deux
	// par setFog() (lastDensity/lastSkyHex partent à -1, donc elle passe).
	distantGround = new DistantGround(scene, manifest.bbox, {
		fogColor: scene.background, fogDensity: fog.density,
	});
	setDistantGround(distantGround);

	// Les drones ambiants (issue #250) — jamais au banc : NO TARGET.
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			bounds: { bbox: manifest.bbox, corridor: fence.effectiveCorridor },
		});
	}

	// L'entrée. En FIELD c'est le tirage pondéré de la Bible §20 — tu hérites
	// d'un drone déjà en vol et tu ne choisis pas dans quel état. Au banc, c'est
	// une demande : ta machine, ta position de départ.
	physics.applyEntryState(generateEntryState({
		physics,
		manifest,
		seed: Math.random().toString(16).slice(2, 12),
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
		hud.progress(`téléversement des textures ${i + 1}/${meshes.length}…`, 0.80 + 0.16 * (i / meshes.length));
		await nextPaint();
		renderer.initTexture(meshes[i].material.uniforms.uMap.value);
		// Sur le GPU, donc plus en RAM (issue #249) : ces pixels étaient le
		// premier poste mémoire de la page, et une page de vol ne survit pas
		// au vol suivant — chaque rechargement en empilait une copie de plus.
		releaseTexturePixels(meshes[i].material.uniforms.uMap.value);
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

	// Au banc, la météo n'appartient pas au monde : elle appartient à
	// l'opérateur. C'est le SEUL endroit du jeu où c'est vrai, et c'est
	// pourquoi les curseurs retirés de SETTINGS en PHASE 04 ne reviennent pas
	// dans SETTINGS — la décision D3 tient, le banc est simplement hors monde.
	//
	// Aucun worldWeather() dans cette branche : pas d'aller-retour serveur, pas
	// de snapshot écrit, aucune clé de zone touchée. Le banc ne consulte pas le
	// monde et ne lui laisse rien.
	if (MODE.bench) {
		// `weather` reste null : c'est ce que lisent l'OSD et __sim.debug(),
		// et il ne doit pas y avoir de bulletin là où il n'y a pas de monde.
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
			// Scène sans origine connue : monde neutre plutôt que météo inventée.
			physics.setWeather(CALM.wind);
			rain.setParams(CALM.rain);
			fog.setParams(CALM.fog);
			cloud.setParams(CALM.cloud);
			sun?.setWeather(CALM.sun);
		}
	}

	// Les matériaux de cette zone viennent d'apparaître dans tileMaterials
	// (loader.js) à leurs valeurs par défaut (uDim=1, uNight=0) : setFog/setDim/
	// setNight ne les a jamais touchés. La boucle de rendu ne les pousse que
	// sur CHANGEMENT (lastDensity/lastSkyHex/lastDim/lastNight ci-dessous) — si
	// la nuit était déjà installée à la scène précédente, la valeur n'a pas
	// changé et ces matériaux restent bloqués à leurs défauts pour toujours.
	// Invalider le cache force le prochain frame à les resynchroniser même
	// quand la valeur elle-même n'a pas bougé depuis la scène d'avant.
	lastDensity = NaN;
	lastSkyHex = NaN;
	lastDim = NaN;
	lastNight = NaN;

	settings.setAudio(loadVolume(), loadBrightness(), loadMusicVolume(), (volume, brightness, musicVolume) => {
		audio.setVolume(volume);
		audio.setBrightness(brightness);
		music.setVolume(musicVolume);
	});

	// Issue #120 : lens et link n'ont plus de UI dans le panneau Tab — appliqués
	// une fois ici depuis leurs valeurs stockées (cf. settings.js).
	const lensCfg = loadLens();
	const lensParams = { on: lensCfg.on, lens: lensCfg.lens, vignette: lensCfg.vignette, shutter: lensCfg.shutter / 1000 };
	lens.setEnabled(lensParams.on);
	lens.setParams(lensParams);
	lensShutter = lensParams.shutter;

	const linkCfg = loadLink();
	link.setSeverity(linkCfg.severity);
	// Mémorisé : la séquence de crash doit pouvoir forcer une dégradation
	// même si le joueur a coupé la modélisation du lien.
	lensLinkMode = linkCfg.severity === 0 ? LINK_OFF
		: linkCfg.mode === 'digital' ? LINK_DIGITAL : LINK_ANALOG;
	lens.setLink({ mode: lensLinkMode, severity: linkCfg.severity });


	timeline[timeline.length - 1].ms = Math.round(performance.now() - timeline[timeline.length - 1].at);
	console.table(timeline.map(s => ({ étape: s.name, ms: s.ms })));
	console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)}s`);

	exposeDebugGlobal();

	hud.ready();
	// À partir d'ici les sticks pilotent le drone : le panneau Settings ouvert
	// en vol n'écoute plus la manette (issue #123, voir settings.js).
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

// Niveau d'octree constant pour ce jalon (Global Constraints) — la vraie
// sélection de LOD par distance/altitude reste un ticket de suivi. 21 :
// ZOOM_TO_LEVEL[20] dans google-earth.mjs — le niveau que produit le zoom
// par défaut d'`add-map` (CLAUDE.md, --zoom 20), donc déjà le niveau que
// toutes les cartes existantes utilisent couramment.
const ROCKTREE_LEVEL = 21;

// Boot minimal pour ?live=lat,lon (#168) : pas de manifest, pas de
// collision.bin, pas de météo. Origine ENU fixée UNE FOIS ici, au point de
// spawn — pas de recentrage en vol (hors périmètre, voir la spec).
async function bootLive([lat, lon]) {
	// Trois latences indépendantes, RECOUVERTES plutôt qu'additionnées (#21) :
	// l'init de Rapier (chunk WASM à charger et compiler), la première
	// traversée rocktree (6 frontières de bulks séquentielles sur le réseau)
	// et la création des Workers (pool de fetch + traversée : un chargement de
	// module chacun, qui n'était payé qu'au premier fetchNode(), donc APRÈS la
	// traversée). Avant, bootLive() attendait Rapier avant de lancer quoi que
	// ce soit sur le réseau.
	//
	// Le chemin scène fait initPhysics() dans preloadScene() (avant tout usage
	// de Rapier/Physics) — bootLive() ne passe jamais par preloadScene(), donc
	// jamais par cet appel sans le reproduire ici. Sans lui, `new
	// Physics(...)` plante immédiatement (module WASM Rapier non initialisé),
	// avant même la première requête réseau vers kh.google.com (#174).
	const physicsReady = initPhysics();
	warmUpTraverseWorker();
	warmUpNodePool();

	const rocktreeWindow = new RocktreeWindow({
		level: ROCKTREE_LEVEL,
		origin: { lat, lon },
		// La distance d'affichage vient du curseur Settings (#182), dès le boot
		// — démarrer au repli puis élargir une frame plus tard fetcherait le
		// boot en deux vagues.
		floorRadiusM: loadViewRange(),
		// Les callbacks n'exécutent RIEN (#184) : ils empilent, et le travail
		// réel (build + cuisson Rapier + upload texture + dispose) est étalé
		// par processLiveNodeWork() sous un budget par frame. Mesuré avant :
		// chaque nœud ne coûte que ~1,4 ms, mais le pool en livre des dizaines
		// dans la même frame — gels de 70 à 330 ms à chaque vague, GPU oisif.
		// Ni l'un ni l'autre ne touche `physics` : ils peuvent donc courir
		// pendant que Rapier s'initialise encore (#21).
		onNodeReady: (path, matrix, meshes, sphereRadius) => {
			pendingNodeBuilds.set(path, { matrix, meshes, sphereRadius });
			// Signal "la fenêtre bouge" pour le dôme numérique (#198) — au
			// moment où le nœud est REÇU, pas où processLiveNodeWork() le
			// construit sous budget : ce dernier peut traîner plusieurs
			// frames, le churn perçu commence dès l'arrivée du réseau.
			fenceDome?.markChurn();
		},
		onNodeReleased: (path) => {
			// Un nœud libéré encore en file de build n'a jamais existé côté
			// scène/Rapier : le retirer de la file suffit — l'empiler en
			// libération créerait un dispose sans rien à disposer, et l'oubli
			// inverse (build après libération) créerait mesh + collider
			// orphelins, que plus rien ne libérerait jamais.
			if (pendingNodeBuilds.delete(path)) return;
			pendingNodeReleases.push(path);
			fenceDome?.markChurn();
		},
	});
	// Amorce la fenêtre autour du spawn avant la première frame : sans ce
	// premier appel, le drone tombe dans le vide jusqu'au premier update()
	// de la boucle de rendu. Lancée ICI, avant d'attendre Rapier, pour que le
	// réseau travaille pendant la compilation du WASM ; attendue plus bas,
	// juste avant la boucle qui guette le sol.
	const firstWave = rocktreeWindow.update({ lat, lon });

	await physicsReady;
	const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	// Position PROVISOIRE : aucun relief n'est chargé au moment de la
	// construction de Physics. Le vrai point de spawn est calé sur le sol réel
	// plus bas, une fois le premier collider de la colonne arrivé (#182) —
	// cette valeur ne survit que si aucun sol n'apparaît (spawn en mer).
	physics = new Physics(emptyCollision, { x: 0, y: 80, z: 0 }, PROFILE ? { profile: PROFILE } : {});
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	// Le chemin scène le fait via applyEntryState() (finishBoot(), plus haut) —
	// reset() en est le cas simple (spawn/identité/zéro, déjà ce que le
	// constructeur pose) mais il fait AUSSI this.propulsion.primeFor(hoverThrottle(...)),
	// ce que le constructeur seul ne fait pas : sans lui les 4 moteurs
	// démarrent à omega=0/thrust=0 (« à froid ») et doivent remonter par le
	// lag moteur réaliste de quad.js avant de produire une poussée utile.
	// Mesuré : même à throttle 0.85 soutenu dès la 1ʳᵉ frame, le drone
	// s'écrase avant que les moteurs n'aient rattrapé leur retard — la marge
	// de 80 m au-dessus du sol (commentaire ci-dessus) est mangée par ce
	// retard, pas par un défaut du maillage de collision.
	physics.reset();

	liveWindow = rocktreeWindow;
	fenceDome = new FenceDome(scene);
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			// Direct : le cercle de confiance de la fenêtre, relu à chaque frame
			// (bounds est muté, jamais remplacé — le modèle garde la référence).
			bounds: liveBounds,
		});
		// ?live= est un raccourci de DEV : openFlightSession() en sort tout de
		// suite, donc personne d'autre ne poserait de scan sur ce chemin.
		if (OPTS.live) ambient.setScan({ seed: `dev::${OPTS.live}`, count: 4, index: 0, ...(devSwarm ? { swarmAt: 0, swarmChance: 1, swarm: devSwarm } : {}) });
	}
	// Brouillard local du bord de fenêtre (#198, retour "rupture nette" après
	// vérification en vol) : le terrain live n'a aucun autre brouillard (la
	// météo est hors périmètre en ?live=), donc scene.fog est entièrement
	// libre ici — densité poussée chaque frame par fogDensityFor() plus bas.
	// SkyDome a fog:false et n'en est pas affecté.
	scene.fog = new THREE.FogExp2(FENCE_CYAN, 0);
	// Fondu de bord DU TERRAIN LUI-MÊME (#202, suite de #200 : même retour
	// utilisateur, la silhouette du disque chargé se découpait encore net
	// contre le ciel vue de haut — scene.fog ci-dessus ne dépend que de la
	// position du DRONE, pas de si le fragment regardé est près du bord).
	// buildNodeMesh() lit ce module-scope pour chaque nouveau nœud ; posé
	// AVANT que RocktreeWindow ne puisse livrer son premier nœud.
	liveEdgeUniforms = createLiveEdgeUniforms(FENCE_CYAN);
	// Révèle le curseur « View range » (caché hors mode live) et le branche :
	// setFloorRadiusM() invalide le cache de position de la fenêtre, le
	// prochain update() de frame() charge la couronne manquante (ou libère
	// l'excédent) sans redémarrage.
	settings.setViewRange(loadViewRange(), (m) => rocktreeWindow.setFloorRadiusM(m));
	// La première traversée, lancée tout en haut (#21) : d'ici, Rapier est
	// prêt et les premiers nœuds sont peut-être déjà en file de build.
	await firstWave;

	// Attend le SOL RÉEL avant de lâcher le drone (#182). L'origine ENU est à
	// l'altitude 0 de l'ellipsoïde et le spawn à +80 m — or le terrain, lui,
	// est où il veut : ~175 m ellipsoïdaux à Versailles (spawn 95 m SOUS le
	// sol, chute sans fin), ~79 m au Champ de Mars (1 m de marge, une course
	// de 0,5 s entre la chute et le premier collider — perdue à froid dès que
	// la vague de boot grossit, cf. le curseur de distance). update() ci-dessus
	// n'attend PAS les fetchs : on guette donc le premier collider dans la
	// colonne du spawn, puis on cale le point de spawn dessus. Timeout généreux
	// (réseau froid) ; au-delà, on garde l'ancien comportement plutôt que de
	// bloquer le boot pour toujours (spawn en mer : aucun sol ne viendra).
	const SPAWN_ABOVE_GROUND_M = 80;
	// Le boot attend la VAGUE COMPLÈTE, pas seulement la colonne du spawn
	// (#189). Lâché dès le premier collider, le drone dérive pendant sa chute
	// de 80 m et atterrit parfois dans un trou pas encore construit — mesuré à
	// Lyon : passage sous la carte, puis la fenêtre suit le drone sous terre
	// en chargeant/déchargeant à l'infini (le « chargement impossible »).
	// Accessoirement, remplir derrière l'écran de chargement à plein budget
	// (25 ms) évite les 10-90 s de remplissage au compte-goutte (3 ms/frame)
	// sous les yeux du joueur. Plafond : à froid le réseau peut traîner, on
	// finit par lâcher le drone plutôt que bloquer pour toujours — le sol de
	// SA colonne, lui, reste exigé (sinon spawn en mer : ancien comportement).
	const bootDeadline = performance.now() + 45000;
	let groundHere = null;
	let waveDone = false;
	for (;;) {
		// La boucle de rendu n'a pas démarré : personne d'autre ne draine les
		// files de nœuds (#184) — sans cet appel, aucun collider n'apparaîtrait
		// jamais. Le tri par distance met le nœud sous le spawn dans la
		// première vague, le sol arrive donc en premier.
		processLiveNodeWork(25);
		if (groundHere === null) groundHere = physics.groundBelow(0, 3000, 0, 6000);
		waveDone = rocktreeWindow.pendingCount() === 0
			&& pendingNodeBuilds.size === 0 && pendingNodeReleases.length === 0;
		if (groundHere !== null && waveDone) break;
		if (performance.now() > bootDeadline) {
			console.warn(`[rocktree] boot lâché au plafond de 45 s — sol ${groundHere !== null ? 'trouvé' : 'ABSENT'}, `
				+ `${rocktreeWindow.pendingCount()} fetchs et ${pendingNodeBuilds.size} builds encore en vol`);
			break;
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	if (groundHere !== null) {
		// physics.reset() renvoie au spawn ET re-prime les moteurs — muter
		// spawn.y d'abord garde ce point correct pour tout ce qui s'y ramène
		// (touche R, et le repli de generateEntryState() ci-dessous si ses
		// deux tirs de sécurité échouent) au-dessus du sol réel, pas de
		// l'ellipsoïde.
		physics.spawn.y = groundHere + SPAWN_ABOVE_GROUND_M;

		// Le chemin scène tire l'entrée par generateEntryState() (Bible §20,
		// finishBoot() plus haut, et son pendant banc à 1417) — bootLive() se
		// contentait jusqu'ici d'un reset() qui pose TOUJOURS le même point,
		// moteurs coupés, chute verticale : jamais l'entrée « déjà en vol »
		// que la carte cuite donne. On rejoue le même tirage pondéré (et,
		// comme les deux autres appels, l'override du banc — sans lui un
		// vol libre sur terrain live ignorait silencieusement IDLE/catégorie
		// forcée alors que le même réglage marche sur une carte cuite), mais
		// borné à un carré inscrit dans le disque qu'on vient d'attendre :
		// c'est la seule zone dont la collision est vraiment posée à cet
		// instant, contrairement à un manifest.bbox cuit qui couvre toute la
		// carte. Facteur 0,5 : le carré inscrit exact vaudrait 1/√2 ≈ 0,71 du
		// rayon, on se garde de la marge contre un chunk pas tout à fait fini
		// en bord de vague — SAUF si la vague n'a justement pas fini (plafond
		// de 45 s atteint, waveDone resté faux) : ce carré-là n'a plus rien
		// de garanti, on retombe alors sur la seule colonne dont le sol est
		// exigé plus haut (rayon nul, x=z=0).
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
			...(MODE.bench ? benchEntryRequest(MODE.config) : {}),
		});
	} else {
		console.warn('[rocktree] aucun sol sous le spawn — spawn ellipsoïdal conservé');
	}

	// Le chemin scène le pose dans finishBoot() (avec en plus une recherche de
	// plafond pour les spawns sous un pont — hors périmètre ici). frame() lit
	// emitter.x/y/z SANS garde, hors du bloc `if (!frozen)` (obstructionBetween
	// pour le lien) — resté à `null` (sa valeur de départ), il plante dès la
	// première frame. S'il n'y a aucun collider pile sous (x=0, z=0), retomber
	// sur le point de spawn lui-même plutôt que null.
	emitter = { x: 0, y: (groundHere !== null ? groundHere : physics.spawn.y) + ANTENNA_HEIGHT, z: 0 };

	// Les conditions du banc, en vol libre (PHASE 26).
	//
	// Ce chemin ne passe pas par finishBoot(), donc rien de ce que finishBoot()
	// pose n'existe ici : sans ces trois lignes, TOUT le panneau de conditions
	// du banc était ignoré en silence — et pire, la première ouverture du
	// panneau en vol (touche B) appelait applyBenchConfig() et faisait
	// apparaître la météo d'un coup, au milieu du vol.
	//
	// `?live=` seul ne change pas : il reste sans météo ni soleil, c'est son
	// hors-périmètre assumé (#168). Ici la lat/lon est réelle et vient de
	// l'opérateur, donc le soleil est légitime — c'est la même construction que
	// le chemin scène, à partir de la même donnée.
	// Vaut aussi pour la reconnaissance FIELD : la lat/lon y vient du rectangle
	// que l'opérateur vient de dessiner, elle est donc tout aussi réelle qu'au
	// banc. applyBenchConfig() reste au banc — il n'y a pas de config à appliquer
	// ici, et il se garde lui-même sur MODE.bench.
	if (MODE.bench || MODE.live) {
		sun = SunField.forOrigin({ latitude: lat, longitude: lon });
		applyBenchConfig();
	}

	// Boucle de vol : frame() lit fence.*/controller.* sans garde nulle part
	// (elle suppose toujours une scène pré-cuite complète) — le mode ?live=
	// doit donc lui fournir de vraies instances, pas les laisser null.
	// Geofence avec une bbox démesurée : le VRAI code testé (pas un stub),
	// mais dimensionné pour ne jamais s'engager (scale plafonne à 1, le
	// drone n'approche jamais un bord à 1000 km) — zone toujours NOMINAL,
	// push toujours nul. Cohérent avec le hors-périmètre explicite du plan
	// ("pas de Geofence" en mode direct) : elle existe juste pour ne pas
	// planter frame(), elle n'agit jamais.
	fence = new Geofence({ min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] });
	// `benchRates` porte les rates de l'exemplaire quand il y en a un : le banc
	// les pose depuis sa cellule tirée, le vol en direct depuis sa cible
	// (#218) — bootLive() construit lui-même son contrôleur, donc dans les deux
	// cas ils doivent être posés AVANT l'appel. Sans exemplaire (?live= nu),
	// `opts.rates` est optionnel dans flightController.js et retombe sur
	// RATE_PRESETS[this.preset].
	controller = new FlightController({ profile: PROFILE, rates: benchRates ?? undefined });

	audio.start();
	renderer.compile(scene, camera);
	hud.ready();
	// window.__sim doit exister avant la première frame : c'est ce que toute
	// vérification navigateur de ce dépôt lit (Tâche 11 comprise).
	exposeDebugGlobal();
	// Sans ça frame() n'est jamais programmée en mode ?live= — le drone ne
	// vole jamais, l'écran reste figé. Miroir du dernier geste de
	// finishBoot() pour le chemin scène, y compris les deux lignes qui le
	// précèdent là-bas et manquaient ici :
	//  - flightActive : sinon le panneau Settings continue de manger la manette
	//    en vol (issue #123, voir settings.js) ;
	//  - lastTime : sans ce recalage, la 1ʳᵉ frame mesure dt depuis le
	//    chargement du module (des secondes), clampé à 0,25 s — une bourrasque
	//    de physique de 250 ms d'un coup au tout premier pas.
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
	// Pas de respawn : on ne fait pas réapparaître un drone qu'on a perdu.
	// terrain persistent, flights ephemeral.
	//
	// Sauf au banc, où il n'y a rien à faire réapparaître : la machine est
	// locale, la remettre en état n'est pas un rembobinage. La touche n'existe
	// QUE là — FIELD ne gagne rien, pas même une touche inerte à découvrir.
	if (MODE.bench && action === 'respawn') { respawn(); return; }
	if (MODE.bench && action === 'benchPanel') { event.preventDefault(); toggleBenchPanel(); return; }
	if (action === 'pause') { event.preventDefault(); togglePause(); }
	else if (action === 'cyclePreset') controller?.cyclePreset();
	else if (action === 'cycleMode') controller?.cycleMode();
	else if (action === 'view') setView(viewMode === 'fpv' ? 'chase' : 'fpv');
	else if (action === 'photo') pendingCapture = true;
	else if (action === 'tab') { event.preventDefault(); settings.toggleSettings(); }
	else if (action === 'escape' && settings.settingsOpen) settings.toggleSettings(false);
	// Le joueur sort lui-même du contrôle : rien ne le sort à sa place. Entrée
	// est un doublon d'Échap plutôt que le seul chemin : en plein écran
	// navigateur, Échap est confisquée pour quitter le plein écran et ne
	// délivre jamais de keydown à la page (comportement du navigateur, pas un
	// bug — voir le clic ci-dessous pour la même raison).
	else if ((action === 'escape' || action === 'enter') && flightEnd.out.exitArmed) finishSession();
	// #253 : REDEPLOY, clavier seulement (comme les touches banc ci-dessus) —
	// la manette garde son geste « n'importe quel bouton déconnecte » plus bas.
	// FIELD only : au banc 'r' respawn déjà (garde tout en haut de ce handler).
	else if (action === 'respawn' && flightEnd.out.exitArmed && !exiting) finishSession({ redeploy: true });
};

// #253 : clé sessionStorage portant la zone à rejouer d'un REDEPLOY à travers
// le rechargement de page que finishSession() déclenche. sessionStorage et non
// localStorage : ne doit pas survivre à la fermeture de l'onglet, et ne doit
// jamais fuiter vers un autre onglet ouvert sur une zone différente.
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
async function finishSession({ redeploy = false } = {}) {
	if (exiting) return;
	exiting = true;
	// The flight is over: the flag that says "the sticks fly the machine" must
	// stop saying it. The reload clears it anyway, but Settings reads it in the
	// meantime (gamepad nav, and the REPLAY BRIEFING button of F2).
	settings.flightActive = false;
	if (redeploy && lastZone) {
		try { sessionStorage.setItem(QUICK_RESTART_KEY, JSON.stringify(lastZone)); } catch {}
	}
	// #247 : le debounce de operator.patch() (settings, dialogueMemory, coverage)
	// n'a aucune garantie face à ce rechargement — seul un flush() résolu avant
	// de partir en a une. Un échec réseau ne doit pas bloquer la sortie pour
	// autant : on part quand même, comme le ferait beforeunload.
	try { await operator.flush(); } catch (e) { console.warn('[operator] flush de fin de vol échoué', e); }
	location.href = location.pathname;
}

renderer.domElement.addEventListener('click', () => {
	// Safety net for ?scene=<slug>, which skips the menu and therefore skips the
	// only other user gesture we get. start() is idempotent.
	audio.start();
	// [ENTER] DISCONNECT au clic : un clic est un geste garanti par la page en
	// plein écran navigateur, là où Échap ne l'est pas (confisquée pour quitter
	// le plein écran lui-même — voir le commentaire d'exitPointerLock plus
	// bas). Un joueur qui vient de crasher plein écran a donc toujours un
	// moyen de sortir.
	if (flightEnd.out.exitArmed && !exiting) { finishSession(); return; }
	// Une fois le vol fini, on ne reprend plus le curseur : le reverrouiller
	// reconfisquerait Échap au navigateur (voir la sortie du pointer lock à la
	// fermeture de session), et il n'y a plus rien à piloter.
	const flying = flightEnd.phase === FLYING;
	if (flying && !settings.settingsOpen) renderer.domElement.requestPointerLock();
});

// PHASE 16 : lit le canvas du composer tel qu'il vient d'être peint —
// résolution/ratio du capteur cible, OSD drone, dégradation du lien, pluie et
// brouillard tous déjà dedans, l'overlay DOM FPVTP! jamais dedans. `toBlob`
// lit le buffer au moment de l'appel, pas besoin de `preserveDrawingBuffer` :
// appelé synchrone dans la même frame que le rendu, avant tout autre dessin.
async function capturePhoto() {
	const cap = await lens.capture();
	if (!cap) return;

	// Au banc, l'image part directement sur le disque de l'opérateur et NULLE
	// PART ailleurs : ni session, ni serveur, ni journal. « Nothing here is
	// logged » parle de ce que FPVTP! enregistre, pas de ce que tu emportes —
	// et dumper une frame dans un fichier est de toute façon le geste juste au
	// banc, là où le vol de terrain rédige un rapport.
	// Même geste en reconnaissance : sans session ouverte, session.capturePhoto()
	// n'aurait nulle part où écrire et échouerait en silence. Ce qu'on emporte
	// part sur le disque de l'opérateur, comme au banc.
	if (MODE.bench || MODE.live) {
		const url = URL.createObjectURL(cap.blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
		a.click();
		// Révoqué au tour suivant : révoquer tout de suite couperait l'URL
		// sous le téléchargement que le clic vient à peine de démarrer.
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

	// terrain persistent, flights ephemeral : après un crash le drone a disparu,
	// on ne réapparaît pas en place — retour au terminal. En mode ?scene= (dev)
	// on garde le respawn local pour ne pas casser le flow de debug.
	//
	// Et au banc (PHASE 26), où il n'y a rien à perdre : NO LOSS. La règle de
	// FIELD n'est pas assouplie, elle ne s'applique simplement pas — il n'y a
	// aucune machine distante ici, donc aucune machine distante à perdre.
	if (crashed && !OPTS.scene && !MODE.bench) { location.href = location.pathname; return; }
	fpvtpOsd.setSessionStatus(null);
	controller.arm();
	// En vol libre il n'y a pas de manifeste : ni bbox pour tirer un point, ni
	// spawn à recopier. generateEntryState() y planterait sur manifest.spawn.
	// physics.reset() est exactement ce que bootLive() utilise — il renvoie au
	// spawn ET re-prime les moteurs, ce que le constructeur seul ne fait pas.
	if (!sceneManifest) {
		physics.reset();
	} else {
		physics.applyEntryState(generateEntryState({
			physics,
			manifest: sceneManifest,
			seed: Math.random().toString(16).slice(2, 12),
			...(MODE.bench ? benchEntryRequest(MODE.config) : {}),
		}));
	}
	link.reset();
	// Pour l'HYSTÉRÉSIS, et pour elle seule : sans ce reset, zoneOf() jugerait
	// la première frame d'après-respawn à l'aune de la zone d'avant. La perte
	// sur le lien, elle, est déjà partie — link.reset() (juste au-dessus) remet
	// _terminalLoss à zéro, et fence.update() recalcule lossDb dans la frame.
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
	// Le ciel se retire aussi : les ambiants d'avant le respawn étaient nés
	// autour d'un point de vol qui n'existe plus (issue #250).
	ambient?.reset();
}

function togglePause(force) {
	// Espace pendant le Control Vector (introFrozen) arrive quand même ici —
	// le gel arrête la physique, pas les touches. Ignorer la bascule
	// manuelle sur cette fenêtre évite d'atterrir en vol déjà en pause.
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

// La position géographique du drone pour la couverture (issue #245), cuit ou
// live, un seul chemin de sortie : { lat, lon }, éventuellement NaN — c'est
// session.feed() qui ignore un résultat non fini.
//
// - terrain cuit : latLonOf(), l'approximation plate déjà jugée suffisante sur
//   une scène de deux kilomètres ;
// - live : la même conversion ENU → ECEF → géodésique que la fenêtre de
//   streaming fait déjà chaque frame plus haut (#182 pour la garde NaN, qui
//   vit côté session).
//
// Appelée SEULEMENT aux échantillons (5 Hz) : session.feed() reçoit la fonction,
// pas la valeur.
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
// La même extinction, sans le sentinel -1 : c'est elle que les drones ambiants
// (#250) recopient dans leur propre matériau, qui duplique délibérément la
// formule de TileMaterial.js.
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
		let steps = 0;
		while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
			const { motors } = controller.update(sticks, physics, FIXED_STEP);
			if (touchdown) motors.fill(0);
			// La clôture lit la position de CE pas, et sa force part DANS ce
			// pas : physics.step() commence par resetForces(), un addForce
			// appelé d'ici serait effacé sans jamais être intégré. D'où le
			// troisième paramètre plutôt qu'un appel séparé.
			fence.update(physics.position);
			let fenceForce = null;
			// `!linkDead` : une épave n'a plus de failsafe. Sans ça le rappel
			// continue de pousser un drone désarmé — mesuré, il ramenait
			// l'épave de 71 m dehors à 239 m dedans, à 22 m/s, et faisait
			// retomber `over` derrière elle (#150). L'écran ne le montrait pas
			// (linkDead force DEAD_LINK au rendu), mais le monde le faisait.
			//
			// Aucun risque de couper le rappel trop tôt : flightEnd.update()
			// tourne APRÈS cette boucle, donc la frame où l'on franchit
			// applique encore sa force, et linkDead ne se lève que dans la
			// même frame où main.js désarme le contrôleur. En retard d'une
			// frame, jamais en avance.
			if (fence.out.zone !== FENCE_OK && !flightEnd.out.linkDead) {
				// push est une ACCÉLÉRATION (m/s², plafonnée à A_MAX) : Rapier
				// veut des newtons, donc × la masse réelle de l'appareil — pas
				// celle du profil par défaut. Un drone lourd est rappelé aussi
				// fermement qu'un léger.
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
						// fenceForce peut déjà être posé par le rappel de zone
						// ci-dessus (mode scène) ; en mode ?live= fence est toujours
						// NOMINAL (pas de Geofence construite), donc fenceForce est
						// encore null ici — les deux rappels ne se cumulent jamais.
						_fenceForce.x = -(dx / len) * a * m;
						_fenceForce.z = -(dz / len) * a * m;
						_fenceForce.y = 0;
						fenceForce = _fenceForce;
					}
				}
			}
			const impact = physics.step(motors, FIXED_STEP, fenceForce);
			// NO LOSS (PHASE 26) : au banc le choc reste un choc — la physique
			// ne se négocie pas, la machine encaisse, culbute et s'arrête. Mais
			// rien n'est perdu, donc rien ne meurt : ni l'image, ni le son, ni
			// la session. On repart d'une touche.
			//
			// C'est bien la règle de FIELD qui ne s'applique pas, et non une
			// règle assouplie : « le drone est détruit » suppose un drone
			// distant qui appartient à quelqu'un, et il n'y en a aucun ici.
			if (impact > 0 && !flightEnd.out.linkDead && !crashed && !MODE.bench) {
				const r = physics.rotation;
				if (impact > crashThreshold(r)) {
					crashedThisFrame = true;
					crashed = true;
					// Le drone est détruit. La session se ferme sur CRASHED — le
					// terrain, lui, reste. terrain persistent, flights ephemeral.
					fpvtpOsd.setSessionStatus('TARGET LOST<small>SESSION TERMINATED</small>', 'lost');
					session.end('CRASHED').then((s) => s && console.log('[session] CRASHED', s));
					endOfFirstFlight();
				}
			}
			if (impact > peakImpact) peakImpact = impact;
			accumulator -= FIXED_STEP;
			steps++;
		}
		if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

		// Travail de streaming UNE fois par FRAME, hors de la boucle
		// d'accumulation (#187) : logé dans la boucle, il tournait une fois par
		// STEP physique — en rattrapage (12-15 steps/frame après une frame
		// longue), 12-15 budgets de drain de 3 ms s'empilaient dans la même
		// frame (40-80 ms mesurés), ce qui entretenait la spirale que le budget
		// devait justement empêcher. La poussée de clôture, elle, reste par
		// step : elle dépend de la position, qui change à chaque step.
		if (liveWindow && !frozen) {
			// Filet anti-trou (#189) : le terrain Google Earth a de VRAIS trous —
			// les nœuds absents (404, résultat normal du protocole) ne produisent
			// aucune géométrie, l'eau du Vieux-Port de Marseille en est un de
			// plusieurs hectares. Un drone qui y glisse ou y vole tombe SOUS la
			// carte pour toujours, et la fenêtre le suit en chargeant/déchargeant
			// en boucle (mesuré : le « chargement impossible »). Critère : chute
			// franche (vy < −20, ~2 s de chute libre) ET rien en dessous jusqu'à
			// −6 km — une vraie vallée a toujours du sol dessous, pas un trou.
			// L'eau devient donc un crash-respawn, cohérent avec le FPV réel.
			{
				const p = physics.position;
				if (physics.body.linvel().y < -20 && physics.groundBelow(p.x, p.y + 2, p.z, 6000) === null) {
					console.warn('[rocktree] drone tombé dans un trou de la carte (nœud absent) — respawn');
					physics.reset();
					flightEnd.reset();
				}
			}
			// Étale le travail des nœuds reçus/libérés sous budget (#184).
			processLiveNodeWork();
			// Ne bloque jamais la frame de rendu : la fenêtre se recalcule en
			// tâche de fond, la frame courante vole avec ce qui est déjà là.
			// physics.position (mètres ENU locaux) -> lat/lon : inverse exact
			// de la conversion que build-node.mjs fait dans l'autre sens.
			const dronePos = physics.position;
			const droneEcef = localEnuToEcef(dronePos, liveWindow.originEcef, liveWindow.originBasis);
			const droneGeo = ecefToGeodetic(...droneEcef);
			// Garde (#182) : une position dégénérée (drone passé sous le terrain
			// pendant une chute, mesuré à y=−2465 m à Versailles) fait rendre
			// NaN à ecefToGeodetic — et update({lat:NaN}) avorte alors TOUTE la
			// fenêtre en silence (zone NaN → 0 nœud désiré → tout libéré), un
			// gel permanent du streaming. Mieux vaut geler la FENÊTRE sur sa
			// dernière position saine que la vider.
			if (Number.isFinite(droneGeo.lat) && Number.isFinite(droneGeo.lon)) {
				// Rien n'attend cette promesse (c'est le but : la frame ne bloque
				// pas dessus) — sans .catch(), un échec réseau ou un traverse qui
				// lève devient une unhandled promise rejection silencieuse.
				// Observabilité seulement : pas de retry ici (ticket de suivi).
				liveWindow.update({ lat: droneGeo.lat, lon: droneGeo.lon })
					.catch((err) => console.warn('[rocktree] fenêtre de streaming : échec du recalcul', err));
			}
		}

		// Un seul raycast de sol par frame de physique. Gelé, rien n'a bougé :
		// la dernière valeur de groundY reste correcte, inutile de refaire un
		// test plein maillage pour rien.
		const fp = physics.position;
		groundY = physics.groundBelow(fp.x, fp.y, fp.z);

		// L'acoustique du lieu suit la géométrie réelle (issue #122). Elle relit
		// la rosace que le pas de physique vient de lancer pour l'ombre de vent :
		// aucun rayon supplémentaire. Gelé, on ne touche à rien — le lieu n'a
		// pas changé, et une réverbération qui dérive pendant une pause
		// s'entendrait.
		space.update(physics.probe);

		placeCamera(dt);
	}

	// Le drone du joueur (issue #264). APRÈS la caméra, comme les ambiants, et
	// AVANT eux : les deux exemplaires sont du même bois, autant les éclairer
	// dans le même souffle. Gelé, dt = 0 — le temps du shader ne dérive pas
	// pendant une pause.
	//
	// Le soleil, l'obscurcissement, le brouillard et la résolution sont
	// EXACTEMENT ceux passés aux ambiants juste en dessous : une machine qui
	// s'assombrirait autrement que celles qui l'entourent se verrait.
	// Muté, pas remplacé : la vue embarquée relit ce champ à chaque frame.
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

	// Les drones ambiants (issue #250). APRÈS la caméra : ils naissent hors du
	// champ, donc le modèle veut l'orientation de CETTE frame, pas celle de la
	// précédente. Gelé, dt = 0 et les voix se taisent — mais update() tourne
	// quand même, sans quoi setMuted() ne viserait plus aucun AudioParam.
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
			// `cloud.dim`, pas `sun.ambient` : les ambiants s'assombrissent
			// comme les tuiles (setDim plus bas). L'exposition absolue est le
			// métier de l'AGC de la lentille, pas celui d'un matériau.
			dim: cloud.dim,
			resolution: ambientRes,
		});
	}

	// La fin de vol décide seule : ce qui s'affiche, quand l'image meurt, quand
	// la session se ferme. main.js ne fait que l'alimenter et obéir.
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
		// Sortie de zone : même phase que le crash, autre table de texte
		// (FENCE_TIMELINE). Le verdict de session reste CRASHED.
		//
		// Jamais au banc : la clôture y avertit et résiste — l'OSD passe en
		// CAUTION puis HOLD, le rappel pousse — mais elle n'exécute plus. Un
		// pilote qui insiste sort et se retrouve au-dessus de rien, ce qui est
		// une conséquence honnête du terrain, pas une sanction.
		outOfZone: MODE.bench ? false : fence.out.over,
		// La coupure volontaire du lien (#216) : K tenue deux secondes. Sans
		// elle, un drone coincé dans une façade — ni pose reconnue, ni crash —
		// ne fermait jamais sa session, et RIEN ne rendait la main au terminal.
		//
		// Jamais au banc : R y remet la machine en état, il n'y a aucune
		// machine distante à perdre ni aucune session à clore. La reconnaissance
		// FIELD, elle, l'a — elle vole une vraie machine sur un vrai terrain.
		//
		// Lue en direct plutôt que par onAction : un maintien n'est pas un
		// appui, et input.js ne connaît aucun mode de jeu (il n'a donc pas à
		// savoir que cette touche existe ici et pas au banc).
		cutHeld: !MODE.bench && input.isHeld('cutLink'),
	});
	// Gardé sur ce que la machine a réellement accepté (linkDead), pas sur
	// crashedThisFrame (final review, bonus): an impact taken after the end of
	// the flight must not replay the death of the picture over the end screen.
	if (flightEnd.out.linkDead) {
		// Le drone est détruit : les moteurs se taisent, donc le son aussi —
		// audio.js suit le régime moteur, il n'y a rien à couper à la main.
		// La musique, elle, ne suit rien : on la coupe explicitement, ici et
		// pas à `closes`, pour qu'elle meure À L'INSTANT DU CHOC, avec l'image.
		// Attendre la ligne « LINK LOST » (1,6 s) laisserait la musique jouer
		// par-dessus l'épave qui roule (issue #122).
		music.kill();
		// L'acoustique se tait avec le drone. Sans cet appel le réseau garde sa
		// dernière valeur de wet et l'énergie déjà accumulée dans ses boucles :
		// le bruit continuait dans les menus après la fin de session.
		space.silence();
		// Le ciel se tait avec elle : plus de récepteur, plus de voix (#250).
		ambient?.silence();
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
		// The music was already cut dead above (linkDead): every end of flight
		// goes through there now (D9, 2026-09-08).
		space.silence();
		session.end(closes).then((s) => s && console.log(`[session] ${closes}`, s));
		endOfFirstFlight();
		// Le vol est fini : on rend la souris. Ce n'est pas du confort, c'est ce
		// qui rend [ENTER] DISCONNECT possible — en pointer lock (a fortiori en
		// plein écran), le navigateur confisque Échap pour déverrouiller le
		// curseur et ne délivre aucun keydown à la page. La seule sortie que
		// l'écran de fin propose serait alors la seule touche qui n'arrive
		// jamais. Le drone ne répond plus de toute façon : il n'y a plus rien à
		// piloter à la souris.
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
		night: sun ? sun.night : 0,
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
		rain.extinction +
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

		// Nuit désactivée temporairement (cf. NIGHT_FLOOR_DEG dans sun.js).
		// `?night=1` la rétablit pour la vérifier.
		sun.update(dt, {
			sunInFrame,
			// L'heure du banc emprunte le chemin de ?date= — sun.js ne connaît
			// que « un instant, un lieu », et n'a pas à apprendre ce qu'est un
			// banc. benchClock est recalculé quand l'opérateur bouge le curseur
			// en vol, d'où la variable plutôt qu'un appel par frame.
			...(MODE.bench ? { date: benchClock } : OPTS.date ? { date: OPTS.date } : {}),
			...(OPTS.night ? {} : { minElevationDeg: NIGHT_FLOOR_DEG }),
		});
	}

	if (density !== lastDensity || skyHex !== lastSkyHex) {
		lastDensity = density;
		lastFogDensity = density;
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

	// Les lumières de la ville (#112), même principe throttlé que le fondu.
	const night = sun ? sun.night : 0;
	if (night !== lastNight) {
		lastNight = night;
		setNight(night);
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
			// Le prix du haut gain (starlight, #111) : grain, noirs levés,
			// désaturation, composés PAR-DESSUS le capteur de la cible. Poussé
			// seulement quand le gain bouge — le jour, l'appliquant de
			// applyTargetCamera() reste le seul à parler à setSensor().
			if (sun.gain !== lastNightGain) {
				lastNightGain = sun.gain;
				lens.setSensor(nightSensor(sun.gain, camSpec?.sensor));
			}
		}
	skyDome.update(camera, frozen ? 0 : dt);
	// Dôme numérique du bord de fenêtre live (#198) : uniquement en mode
	// ?live=, hors du bloc météo ci-dessus qui n'existe pas dans ce mode
	// (voir le commentaire sur rainfall?. juste en dessous).
	if (fenceDome) {
		fenceDome.update(frozen ? 0 : dt, {
			windowCenterLocal: liveWindow?.windowCenterLocal,
			loadRadiusM: liveWindow?.loadRadiusM(),
			dronePosLocal: physics.position,
		});
		// Le terrain se dissout dans le brouillard près du vrai bord plutôt
		// que de s'arrêter net (retour "rupture nette" après vérification) —
		// même ratio que le dôme, courbe différente (fogDensityFor() reste
		// nulle jusqu'à mi-fenêtre, contrairement à l'opacité du dôme qui
		// reste perceptible en continu par choix).
		scene.fog.density = liveFogDensityFor(fenceDome.distanceRatio);
		// Fondu de bord DU TERRAIN (#202) : contrairement à la ligne
		// ci-dessus (scalaire global, fonction de la position du DRONE), ce
		// terme est PAR FRAGMENT et suit le vrai bord de la fenêtre — voir
		// RocktreeMaterial.js. windowCenterLocal reste null tant que
		// RocktreeWindow n'a pas posé sa première fenêtre (tout premier
		// frame) ; uLoadRadiusM reste alors à 0, et le shader s'en sert déjà
		// comme garde (edgeFadeFor()).
		if (liveWindow?.windowCenterLocal) {
			const { x, z } = liveWindow.windowCenterLocal;
			liveEdgeUniforms.uWindowCenter.value.set(x, z);
			liveEdgeUniforms.uLoadRadiusM.value = liveWindow.loadRadiusM();
		}
		liveEdgeUniforms.uFogDensity.value = scene.fog.density;
	}
	// Muraille numérique du bord de carte pré-cuite (#199) : même principe,
	// géométrie de bbox plutôt que de rayon — voir geofence-dome.js.
	if (geofenceWall) geofenceWall.update(frozen ? 0 : dt, physics.position);
	// Zero dt while the sim is frozen, which is all it takes to stop the rain
	// dead on a picture that is not moving.
	// `?.` : rainfall ne naît que dans finishBoot() (chemin scène) — en mode
	// ?live= (#168, #170) il reste null, hors périmètre comme la météo (voir
	// le commentaire sur OPTS.live). Sans la garde, ce code non protégé par
	// `if (!frozen)` (contrairement au reste de la météo, cf. plus haut) plante
	// dès la première frame, animation loop comprise (mesuré : Uncaught
	// TypeError: Cannot read properties of null (reading 'update') at frame()).
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
	// AVANT update() et pas après : c'est update() qui lit _terminalLoss, donc
	// l'écrire ensuite coûterait une frame de retard sur la dégradation.
	// Ce canal court-circuite délibérément la borne de jouabilité #79 : sortir
	// de la zone n'est pas une nuisance dont on doit pouvoir se relever, c'est
	// la fin de la session.
	link.setTerminalLoss(fence.out.lossDb);
	// LOOPBACK (PHASE 26) : le flux ne traverse rien, donc rien ne le dégrade.
	// On nourrit quand même le modèle — distance nulle, aucune occultation —
	// plutôt que de le contourner : il continue de produire un `out` cohérent
	// que l'OSD et lens.js lisent sans savoir qu'on est au banc.
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

	// Télémétrie agrégée de la session (PHASE 06) : des maxima et des cumuls,
	// pas un enregistrement image par image. dt=0 quand la sim est gelée, pour
	// ne pas gonfler la durée pendant une pause.
	const av = physics.angularVelocity;
	// NOTHING HERE IS LOGGED : au banc il n'y a pas de session ouverte, donc
	// rien à nourrir. Le garde est ici plutôt que dans session.js pour que la
	// promesse se lise à l'endroit où elle serait rompue.
	if (!MODE.bench) {
		session.feed({
			speed: Math.hypot(v.x, v.y, v.z),
			horizontalSpeed: Math.hypot(v.x, v.z),
			rateDps: Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) * 180 / Math.PI,
			altitudeAboveSpawn: p.y - spawnY,
			dt: frozen ? 0 : dt,
			armed: controller.armed,
			// La piste (issue #24) : les deux seules valeurs que la télémétrie
			// agrégée n'utilisait pas, déjà calculées ici pour l'OSD et le son.
			throttle: sticks.throttle,
			headingDeg: yawOf(physics.rotation) * 180 / Math.PI,
			// La couverture (issue #245) : une fonction, appelée par session.js
			// seulement quand un échantillon est dû — rien entre deux.
			geo: () => droneGeo(p),
		});
	}

	// L'arc musical en vol (issue #122). Un seul appel, un seul scalaire, et
	// setIntensity ne déplace que des AudioParams : aucun nœud n'est créé par
	// frame. Gelé, on ne touche à rien — la musique tient sa valeur pendant une
	// pause au lieu de retomber au plancher.
	if (!frozen && music.playing) {
		music.setIntensity(flightIntensity({
			throttle: sticks.throttle,
			speedMs: Math.hypot(v.x, v.y, v.z),
			armed: controller.armed,
		}));
	}

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
		// NO COVERAGE passe devant RXLOSS : en zone d'avertissement la clôture
		// EST la cause du RXLOSS, et afficher l'effet plutôt que la cause
		// dirait au pilote de revenir vers… rien.
		warning: bat.voltage / PROFILE.battery.cells < 3.4 ? 'LOW VOLTAGE'
			: fence.out.warning ? fence.out.warning
			: link.out.quality < 0.25 ? 'RXLOSS' : '',
	});

	fpvtpOsd.update({
		mode: controller.mode,
		rates: RATE_PRESETS[controller.preset].label,
		usingGamepad: input.usingGamepad,
		windMs: Math.hypot(physics.wind.out.x, physics.wind.out.z),
		windRelRad: Math.atan2(physics.wind.out.x, physics.wind.out.z) - yawOf(physics.rotation),
		// La visibilité réellement vue, brouillard ET pluie : le motif exact déjà
		// employé en main.js:409, pour que les deux ne disent jamais deux choses.
		visibilityM: fogRange(fog.density + rain.extinction),
		rssiDbm: link.out.rssiDbm,
		operator: operator.getOperator()?.name,
		sessionSeconds: (Date.now() - sessionStartedAt) / 1000,
		propwash: physics.propulsion.propwash,
		bench: MODE.bench,
		live: MODE.live,
	});
	fpvtpOsd.setFlightEnd(flightEnd.out);
	fpvtpOsd.setCut(flightEnd.out);
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

	// [ENTER] DISCONNECT, version radio (issue #123) : une fois la sortie armée le
	// vol est fini — n'importe quel bouton de manette NOUVELLEMENT pressé
	// déconnecte, sans poser la radio. Front montant seulement : un inter tenu
	// depuis le vol ou le geste de désarmement ne compte pas.
	if (flightEnd.out.exitArmed && !exiting) {
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

	// La liaison, en vol seulement : une porteuse continue dont le souffle suit
	// la marge, et deux annonces sur franchissement de seuil. C'est le seul son
	// d'interface qui vit pendant le vol.
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
// Résout l'opérateur (bootstrapping au premier lancement), pose l'opérateur sur
// la Home, puis rend la main au choix de carte existant. ?scene=<slug> saute
// Home ET menu mais garde un opérateur en mémoire pour operator.getOperator().
// Nombre de signaux du TARGET SCAN, cohérent avec la densité affichée par le
// Global Scanner (PHASE 03/05). Le terrain acquis porte { level, range } ;
// on mappe le level normalisé (0..1, log) sur 2..5, la même échelle que le
// Global Scanner. Terrain sans densité (cache ancien, terrain local) → 4.
// Enveloppe THREE de la sortie de fetchNode() (#168, #187). Depuis #187 tout
// le calcul (ECEF→ENU, strip→triangles, UV normalisés, boundingSphere) est
// fait dans le Worker par tools/lib/rocktree/build-node.mjs — chaque mesh
// arrive avec positions/uvs/indices déjà transférables ; il ne reste ici que
// ce qui exige le fil principal : objets THREE et matériau. Un nœud peut
// porter plusieurs meshes — chacun devient son propre THREE.Mesh ET son
// propre collider (`${path}#${i}` : addNodeCollider() suit une clé, pas un
// nœud).
function buildNodeMesh(path, meshes) {
	const built = [];
	meshes.forEach((m, i) => {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
		geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
		if (m.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
		// boundingSphere du Worker (même algorithme que computeBoundingSphere) :
		// sinon Three la calcule PARESSEUSEMENT au premier frustum culling de
		// chaque mesh — un parcours O(n) par mesh, en pleine vague, pile quand
		// la frame est déjà chargée (#187).
		geometry.boundingSphere = new THREE.Sphere(
			new THREE.Vector3(...m.boundingSphere.center), m.boundingSphere.radius,
		);

		let material;
		if (m.bitmap && m.uvs) {
			const texture = new THREE.CanvasTexture(m.bitmap);
			// PAS d'inversion de V et flipY coupé : le protocole rocktree a son
			// origine UV en HAUT-gauche (mesuré sur #158, voir le commentaire du
			// décodeur de référence) — c'est la convention d'une image telle que
			// createImageBitmap() la stocke. Le flipY par défaut de CanvasTexture
			// remettrait l'origine en bas et retournerait chaque tuile.
			texture.flipY = false;
			// Pas de mipmaps sur les tuiles live (#187) : leur génération à
			// l'upload était le pire item du budget de drain (4,6 ms pour une
			// 512², mesuré) — et le niveau d'octree constant fait que la
			// minification reste modérée (la tuile la plus lointaine de la
			// fenêtre de 600 m max est à ~2-3× sa taille écran, pas ~100×).
			// Vérifié à l'image : pas de moiré notable à distance de fenêtre.
			texture.generateMipmaps = false;
			texture.minFilter = THREE.LinearFilter;
			material = createRocktreeMaterial(liveEdgeUniforms, { map: texture });
		} else {
			material = createRocktreeMaterial(liveEdgeUniforms, { color: 0x808080 });
		}
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `rocktree-${path}-${i}`;
		// Terrain statique en repère ENU local : la matrice est l'identité et ne
		// changera jamais — sans ce flag, Three recompose la matrice de ~1600
		// meshes à CHAQUE updateMatrixWorld de frame (#187).
		mesh.matrixAutoUpdate = false;
		mesh.updateMatrix();
		built.push({ mesh, colliderPath: `${path}#${i}`, vertices: m.positions, indices: m.indices });
	});
	return built;
}

// Une ligne de console par exemplaire. C'est du debug, pas de l'UI : le joueur
// n'apprend la masse et le pack de sa cible qu'en vol (PHASE 08 : la fiche
// pré-hack les donne UNKNOWN).
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

// La même échelle, à partir du NIVEAU nu. Un vol en direct n'a pas d'entrée de
// cache terrain — sa densité vient du relevé que le scanner vient de faire sur
// la zone tracée, et voyage avec le point (#218). Les deux chemins doivent
// compter les signaux pareil, sinon le TARGET SCAN ne dit pas la même chose que
// le GLOBAL SCANNER qui vient de l'annoncer.
function signalCountFrom(level) {
	if (!Number.isFinite(level)) return 4;            // pas de densité connue (cache ancien, terrain local)
	// 4..5 : au moins 3 ambiants (count - 1), jamais deux (issue #250, retour
	// opérateur — un ciel à un seul ambiant se voyait vide).
	return 4 + Math.round(Math.max(0, Math.min(1, level)));
}

// Un préchargement par zone, conservé d'un passage au TARGET SCAN à l'autre.
// Revenir en arrière puis revenir sur la même zone ne rejoue donc aucun
// téléchargement : Monaco pèse 510 Mo et ~4,6 s en local, bien plus sur un
// vrai réseau. Sûr parce que preloadScene() ne monte rien dans la scène et
// capture sa propre base d'URL — deux zones peuvent charger en parallèle sans
// se marcher dessus.
const preloads = new Map();

function preloadFor(slug) {
	let p = preloads.get(slug);
	if (!p) {
		p = preloadScene(slug);
		// Un préchargement abandonné qui échoue ne doit pas remonter en
		// « unhandled rejection » : celui qui l'attend vraiment verra l'erreur,
		// les autres non.
		p.catch(() => {});
		preloads.set(slug, p);
	}
	return p;
}

// Les meshes préchargés retiennent leurs planches de texture (~135 Mo par
// zone) : dès qu'une zone est engagée, les autres n'ont plus de raison d'être
// et sont libérées. Elles ne sont dans aucune scène — il suffit de rendre la
// mémoire.
function dropPreloadsExcept(keepSlug) {
	for (const [slug, p] of preloads) {
		if (slug === keepSlug) continue;
		preloads.delete(slug);
		p.then((loaded) => {
			const meshes = loaded.meshes ?? [];
			// #147 : sans ce retrait, tileMaterials (loader.js) gardait ces
			// matières vivantes malgré dispose() ci-dessous — dispose() ne libère
			// que le GPU, pas le buffer de pixels JS que uMap.value référence.
			releaseTileMaterials(meshes.map((m) => m.material));
			for (const m of meshes) {
				m.geometry.dispose();
				m.material.uniforms?.uMap?.value?.dispose();
				m.material.dispose();
			}
			console.log(`[load] préchargement abandonné libéré: ${slug}`);
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
		return null;   // pas de slug : le reste du pipeline scène ne doit pas s'exécuter
	}

	if (OPTS.scene) {
		await operator.ensureDevOperator();
		const scenes = await loadSceneList();
		if (!scenes.some((s) => s.slug === OPTS.scene)) throw new Error(`carte inconnue: "${OPTS.scene}"`);
		const previewHack = normalizeHackType(OPTS.hack);
		if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
		return { slug: OPTS.scene, target: undefined, family: OPTS.family || undefined };
	}

	// Le bootstrap, inchangé (issue #60) : la clé rendue par la création part dans
	// localStorage sans un écran de plus. ARCHIVE > OPERATOR > [ SHOW KEY ] est le
	// chemin, délibéré, du jour où l'on veut emporter son profil ailleurs.
	// The briefing runs INSIDE the bootstrap, right after the control vector is
	// registered — the only moment where a player has just been made and has
	// not yet chosen anything.
	const register = () => bootstrap(ui, undefined, { briefing: () => playBriefing() });

	const { needsBootstrap, choices, needsKey } = await operator.loadOperator();
	if (needsKey) {
		// Un serveur `shared` qui ne nous reconnaît pas : pas de liste où se
		// choisir, une clé à présenter ou un nouvel opérateur à créer.
		const r = await operatorKey(ui);
		if (r?.create) await register();
	} else if (needsBootstrap) {
		await register();
	} else if (choices) {
		const pick = await operatorSelect(ui, choices);
		if (pick.create) await register();
		else await operator.selectOperator(pick.id);
	}

	// Rapier (chunk WASM séparé depuis #21, voir physics.js) se charge et se
	// compile PENDANT que le joueur lit le terminal : au premier FLY il est
	// déjà là. Sans attente ni conséquence en cas d'échec ici — preloadScene()
	// et bootLive() refont l'appel (même promesse mémorisée) et, eux, en
	// rendent compte.
	initPhysics().catch(() => {});

	// Pas de démarrage de musique ici : c'est startup(), dans le geste du PRESS
	// ANY KEY, qui s'en charge. Un appel de plus ici tournerait au chargement,
	// AVANT tout geste : il consommerait le garde de startMenuMusic() et
	// lancerait la source sur un contexte encore suspendu, laissant le geste
	// suivant sans rien à démarrer.

	// #253 : REDEPLOY a laissé la zone du dernier vol dans sessionStorage avant
	// de recharger la page. Si elle est là, on saute SELECT OPERATION MODE et le
	// terminal pour retomber directement dans le TARGET SCAN de cette zone.
	//
	// Un échec (zone disparue, carte introuvable) recharge la page plutôt que de
	// retomber dans le terminal DANS CE MÊME chargement : fieldLoop() a pu poser
	// introFrozen/MODE.live/flyArea/flyTarget/PROFILE avant d'échouer (ex. runHack()
	// rejette — voir hack.js, « Rejetée -> on démonte et on propage »), et rien ne
	// les nettoie ici. Un rechargement retombe sur un module tout neuf ; consumeQuickRestart()
	// a déjà vidé sessionStorage, donc ce rechargement atterrit bien sur le terminal
	// normal, pas sur un nouvel essai de la même zone en boucle.
	const quickRestart = consumeQuickRestart();
	if (quickRestart) {
		try {
			const choice = await fieldLoop(ui, { quickRestart });
			if (choice) return choice;
		} catch (err) {
			console.warn('[field] REDEPLOY : zone indisponible, rechargement', err);
			location.href = location.pathname;
			return new Promise(() => {}); // la navigation est en cours ; ne rien rendre entre-temps
		}
	}

	// Boucle de MODE (PHASE 26). La racine du jeu est désormais SELECT
	// OPERATION MODE ; la Home de FIELD est un cran plus bas et peut donc
	// remonter ici. Les deux boucles rendent `null` pour dire « je remonte »,
	// et n'importe quoi d'autre pour dire « on vole ».
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

		// ARCHIVE resolves UPWARDS: a REVISIT is a flight, and it enters the
		// FIELD loop exactly like a choice made on the FIELD screen. Escape at
		// the TARGET SCAN therefore falls back to FIELD, not to the logs — it
		// is the same area, and that is where it is flown again.
		if (mode === 'archive') {
			const pick = await archiveLoop(ui);
			if (!pick) continue;
			const choice = await fieldLoop(ui, { quickRestart: pick });
			if (choice) return choice;
			continue;
		}

		const choice = mode === 'bench' ? await benchLoop(ui) : await fieldLoop(ui);
		if (choice) return choice;
	}
}

// ARCHIVE from the root (D3). Yields { slug } when the operator asked to fly
// an area again, null when they go back up.
async function archiveLoop(ui) {
	const scenes = await fetchScenes();
	return archiveScreen(ui, { api: operator, scenes });
}

// La boucle FIELD : le jeu de la Bible, inchangé. Extraite telle quelle de
// chooseScene() pour que le banc puisse vivre à côté sans s'y mêler.
//
// Rend la forme de vol, ou null pour remonter au choix de mode.
async function fieldLoop(ui, { quickRestart = null } = {}) {
	// Boucle du choix de zone : Échap au TARGET SCAN revient ici. Rien n'est
	// démonté et rien n'est rechargé — c'est ce qui permet à l'ambiance du
	// terminal de continuer sans la moindre coupure, et au préchargement de la
	// zone qu'on vient de quitter de rester acquis.
	for (;;) {
		// #253 : REDEPLOY reste sur la même zone — on rejoue le choix déjà connu
		// UNE fois plutôt que de rouvrir le terminal. Consommé immédiatement :
		// un Échap au TARGET SCAN qui suit doit retomber sur le terminal normal,
		// pas rejouer la même zone en boucle.
		const flyChoice = quickRestart ?? await runTerminal(ui, { back: true });
		quickRestart = null;
		// Échap sur la Home : on remonte au choix de mode. La Home n'est plus la
		// racine depuis PHASE 26, et il faut pouvoir repartir au banc sans
		// recharger la page.
		if (!flyChoice) return null;

		// Posée dès la zone connue (avant TARGET SCAN, avant tout écran qui peut
		// planter) : un REDEPLOY qui suit ce vol rejouera CETTE zone.
		lastZone = flyChoice.live
			? { live: flyChoice.live, place: flyChoice.place, density: flyChoice.density }
			: { slug: flyChoice.slug };

		// Vol en direct : EXACTEMENT le pipeline d'une carte cuite — TARGET SCAN,
		// cible, exemplaire, musique, hack, rituel du Control Vector. Seul le
		// terrain diffère : il est streamé au lieu d'être lu du disque.
		//
		// #206 avait tranché l'inverse (« ni TARGET SCAN, ni hack, ni rituel »)
		// au motif que les cibles sont un attribut d'une zone RELEVÉE. C'était
		// une erreur de lecture du code : le relevé, le scanner vient de le
		// faire — `lastDensity` est la densité de signal calculée sur la zone
		// tracée, depuis Nominatim. Elle voyage désormais avec le point, et il
		// n'y a rien à inventer. Sans cette chaîne, tout vol en direct rendait
		// la même cellule freestyle et le même OSD, puisque rien ne tirait ni
		// famille ni exemplaire.
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

			// Échap au TARGET SCAN : retour au choix de zone. Rien n'a encore été
			// monté — contrairement au chemin cuit, bootLive() n'est appelé
			// qu'APRÈS le choix, parce qu'il MONTE la scène là où preloadScene()
			// se contente de télécharger. L'annuler laisserait un terrain vivant
			// sans vol.
			if (choice.cancelled) {
				MODE.live = false;
				introFrozen = false;
				continue;
			}

			const cand = scan.candidates[choice.index];
			audio.start();
			// Une zone en direct n'a pas de slug sur le disque. On lui en forge un,
			// préfixé `live-` : il nomme la session au journal sans jamais pouvoir
			// se confondre avec une zone acquise, donc REVISIT ne proposera jamais
			// de retourner sur un terrain qu'on n'a pas gardé.
			flyArea = liveAreaId(flyChoice.place, lat, lon);
			flyTarget = choice;
			const buildSeed = `${seed}::${choice.index}`;
			const build = targetBuild({ seed: buildSeed, family: cand._family });
			// AVANT bootLive(), qui construit sa physique avec `PROFILE` s'il est
			// posé — c'est déjà ce que fait le vol libre du banc.
			PROFILE = build.profile;
			flightBuild = build;
			flightBuildSeed = buildSeed;
			benchRates = build.rates;
			logBuild(build);
			console.log(`[field] vol en direct → ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
			const booting = bootLive(flyChoice.live);

			await music.loadManifest();
			await music.prepare(music.trackForFamily(cand._family, buildSeed));
			music.play({ intensity: PHASE_INTENSITY.HACK, fadeMs: FADE.menuToHack });
			// Le terrain se streame DERRIÈRE l'écran de hack, exactement comme la
			// scène cuite se charge derrière lui : c'est à ça que sert cet écran.
			await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand });
			introFrozen = false;
			accumulator = 0;
			lastTime = performance.now();
			flightStartTime = lastTime;
			return { prepared: true };
		}

		const { slug } = flyChoice;

		// Override dev ?family= : court-circuite le TARGET SCAN.
		if (OPTS.family) {
			const previewHack = normalizeHackType(OPTS.hack);
			if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
			// Pas de buildSeed : l'override dev vole le profil NOMINAL de la famille.
			// C'est ce qui garde ?family=freestyle5 identique au banc et à la
			// référence de tools/tune-pid.mjs. `?build=<graine>` (#285) tire un
			// exemplaire — pour vérifier en jeu ce qu'un build a de particulier.
			return { slug, target: undefined, family: OPTS.family, buildSeed: OPTS.build || undefined };
		}

		// Session fraîche → TARGET SCAN, puis AUTOMATED ANALYSIS pendant que la carte
		// charge en tâche de fond : au [ JACK IN ] le contrôle est immédiat. Le slug
		// est déjà connu ici (le TARGET SCAN choisit une cible dans cette carte, pas
		// la carte elle-même) : preloadScene() démarre tout de suite, pour courir
		// derrière le TARGET SCAN entier et pas seulement derrière l'attente de
		// l'AUTOMATED ANALYSIS (PHASE 13, issue #50).
		introFrozen = true;
		const preloading = preloadFor(slug);

		const seed = Math.random().toString(16).slice(2, 12);
		const count = signalCountFor(slug);
		const swarmChance = swarmChanceFor(operator.getOperator()?.sessions);
		const scan = generateTargetScan({ seed, count, swarmChance });
		// La météo du monde pour cette zone, résolue avant le scan pour rendre les
		// conditions saillantes au choix de cible (issue #76). worldWeather est caché
		// par zone : boot() réutilise ce résultat sans nouvel aller-retour.
		const sc = (await loadSceneList()).find((s) => s.slug === slug);
		const scanWeather = sc ? await worldWeather({ lat: sc.lat, lon: sc.lon }) : null;
		const choice = await runTargetScan(ui, { seed, count, weather: scanWeather, swarmChance }); // { seed, count, index, swarmChance, swarmAt } | { cancelled }

		// Échap au TARGET SCAN : retour au choix de zone, sans rien casser. Le
		// préchargement lancé plus haut CONTINUE en tâche de fond : il ne touche
		// pas à la scène Three (preloadScene ne monte rien) et il a capturé sa
		// propre base d'URL, donc il ne peut ni corrompre ni être corrompu par le
		// chargement d'une autre zone. Revenir sur cette même zone le retrouvera
		// tel quel, souvent déjà fini.
		if (choice.cancelled) {
			introFrozen = false;
			continue;
		}

		// La zone est engagée : les autres préchargements ne serviront plus.
		dropPreloadsExcept(slug);

		const cand = scan.candidates[choice.index];

		audio.start();
		flyArea = slug;
		flyTarget = choice;
		// L'exemplaire (PHASE 07). La graine est celle que le serveur reconstruira
		// dans resolveTarget() — le drone que tu voles est celui que le monde a tiré,
		// pas un que le client s'est inventé.
		const buildSeed = `${seed}::${choice.index}`;
		const build = targetBuild({ seed: buildSeed, family: cand._family });
		PROFILE = build.profile;
		flightBuild = build;
		flightBuildSeed = buildSeed;
		controller = new FlightController({ profile: PROFILE, rates: build.rates });
		logBuild(build);
		const booting = finishBoot(preloading);
		// Le morceau se décode PENDANT l'AUTOMATED ANALYSIS, en parallèle du
		// chargement de la scène : au drop le buffer doit déjà être là. Le tirage
		// est déterministe sur buildSeed — reprendre une session, c'est reprendre ce
		// drone ET sa musique.
		//
		// L'écran ne nomme toujours pas la famille : la musique est le premier
		// indice sensoriel, pas une révélation. « You don't read the drone. You
		// feel it. »
		await music.loadManifest();
		await music.prepare(music.trackForFamily(cand._family, buildSeed));
		music.play({ intensity: PHASE_INTENSITY.HACK, fadeMs: FADE.menuToHack });
		await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand });
		// Le rituel a rendu la main : ne pas rejouer l'écart d'horloge accumulé
		// pendant le hack comme un unique pas de physique géant.
		introFrozen = false;
		accumulator = 0;
		lastTime = performance.now();
		flightStartTime = lastTime;
		return { prepared: true };
	}
}

// La boucle BENCH (PHASE 26). Rend la forme de vol, ou null pour remonter.
//
// Beaucoup plus courte que fieldLoop(), et c'est le sujet : il n'y a ni scan,
// ni cible, ni hack, ni rituel, ni musique de tension à installer. On règle,
// on décolle. Le banc n'a pas de cérémonie parce qu'il n'y a personne à
// surprendre au bout.
async function benchLoop(ui) {
	const scenes = await loadSceneList().catch(() => []);
	const config = await runBench(ui, { scenes });
	if (!config) return null;

	MODE.bench = true;
	MODE.config = config;
	const family = config.airframe.family;

	// Hidden terrain: we yield EXACTLY the shape the ?family= override already
	// yields, and the startup() chain builds PROFILE and the controller as
	// usual. Nothing is duplicated here — a build (buildSeed) goes through
	// targetBuild() like a real target, NOMINAL flies the reference profile,
	// the one of the tune-pid bench.
	if (config.terrain.kind === 'cached') {
		return { slug: config.terrain.slug, target: undefined, family, buildSeed: config.airframe.seed ?? undefined };
	}

	// Vol libre : bootLive() construit lui-même sa physique et son contrôleur,
	// donc PROFILE et les rates doivent être posés AVANT l'appel — c'est ce que
	// fait déjà ?live= via l'override ?family=.
	const build = config.airframe.seed ? targetBuild({ seed: config.airframe.seed, family }) : null;
	PROFILE = build ? build.profile : PROFILES[family];
	flightBuild = build;
	// D12: NOMINAL has no drawn build, but it does have a machine — its
	// family's nominal seed gives it a portrait without touching the flown
	// profile, which stays the reference of tools/tune-pid.mjs.
	flightBuildSeed = build ? config.airframe.seed : nominalBuildSeed(PROFILE.family);
	benchRates = build?.rates ?? null;
	if (build) logBuild(build);
	else console.log(`[bench] ${PROFILE.family} — ${PROFILE.label} (nominal)`);
	audio.start();
	await bootLive([config.terrain.lat, config.terrain.lon]);
	return { prepared: true };
}

// ?scene= saute Home et menu : aucun geste utilisateur n'a lieu avant boot().
// L'AudioContext exige un geste — on l'attrape au premier input. armBoot()
// reste EXACTEMENT le chemin d'avant (PHASE 18) : ce bypass sert au dev et aux
// bookmarks, il n'a pas à voir un cracktro de 7 s à chaque rechargement.
//
// Sans ?scene=, l'intro (issue #106) remplace armBoot() : c'est elle qui joue
// BOOT_SIGNATURE à sa résolution (ou immédiatement, si skip), donc jamais les
// deux — un seul motif de démarrage par chargement de page, jamais un
// doublon. Elle passe AVANT la résolution de l'opérateur/Home.
if (OPTS.scene || OPTS.live) {
	uiAudio.armBoot();
	const kick = () => { audio.start(); };
	window.addEventListener('pointerdown', kick, { once: true });
	window.addEventListener('keydown', kick, { once: true });
}

// Ambiance du terminal (issue #122). Le pool `menu` n'est pas un drone : c'est
// le lieu où l'on est assis, avant. Elle doit sonner dès le PRESS ANY KEY de
// l'intro — ce geste est le premier de la page, donc le premier instant où le
// navigateur laisse démarrer l'AudioContext — et non seulement une fois le
// cracktro fini et l'opérateur choisi.
//
// D'où deux temps séparés : le décodage n'a besoin d'aucun geste et tourne
// pendant l'intro ; la lecture, elle, part DANS le geste. Sans cette
// séparation on attendrait le fetch + decode à l'instant précis où l'on veut
// entendre quelque chose.
//
// Câblé ici plutôt que dans intro.js / terminal.js : les écrans restent des
// clients purs, sans dépendance audio.
let menuMusicReady = null;
let menuMusicStarted = false;

function prepareMenuMusic() {
	// La graine change à chaque chargement — le terminal n'a pas de buildSeed à
	// respecter, et deux sessions de suite ne doivent pas ouvrir sur le même
	// morceau.
	menuMusicReady ??= music.loadManifest().then(() =>
		music.prepare(music.trackForMenu(Math.random().toString(16).slice(2, 12))));
	return menuMusicReady;
}

async function startMenuMusic() {
	if (menuMusicStarted) return;
	menuMusicStarted = true;
	// Le volume musique du joueur n'est appliqué qu'au boot de la scène
	// (settings.setAudio), bien après le menu : sans ça la musique du terminal
	// entrerait à fond alors que le réglage stocké dit autre chose.
	music.setVolume(loadMusicVolume());
	const ready = await prepareMenuMusic();
	// Le terminal est peut-être déjà passé : on ne démarre que s'il est encore
	// là, sinon la musique de menu s'inviterait par-dessus le hack.
	if (ready && !music.playing) music.play({ intensity: PHASE_INTENSITY.MENU });
}

async function startup() {
	// Synchrone dans le handler du geste : c'est ce qui autorise
	// l'AudioContext. La lecture, elle, peut arriver après.
	const onFirstGesture = () => { audio.start(); startMenuMusic(); };
	const store = globalThis.sessionStorage;
	if (shouldPlayIntro(OPTS, store)) {
		// Décodage lancé avant l'intro, lecture déclenchée par son gate.
		prepareMenuMusic();
		await runIntro(document.getElementById('ui'), { onFirstGesture });
		markIntroSeen(store);
	} else if (!OPTS.scene && !OPTS.live) {
		// Rechargement de fin de vol (issue #226) : l'intro a déjà été vue dans
		// cet onglet, on saute droit à SELECT OPERATION MODE. Le gate PRESS ANY
		// KEY était aussi le premier geste qui débloque l'audio : sans lui, c'est
		// la première touche ou le premier clic du menu qui le fournit.
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
		// ?live= : bootLive() a déjà tout fait à l'intérieur de chooseScene()
		// (pas de manifest à charger, pas de TARGET SCAN) — chooseScene()
		// renvoie null pour le dire (#168), rien de plus à faire ici.
		if (choice === null) return;
		// Session fraîche : PROFILE / controller / boot() ont déjà été
		// lancés dans chooseScene() et le hack a couvert le chargement.
		if (choice.prepared) return;
		hud.show();
		const { slug, target, family, buildSeed } = choice;
		flyArea = slug;
		flyTarget = target || null;
		// Keeps the ?family= override when the scan gave no family. With a
		// buildSeed we fly the build; without one (dev override) it is the
		// family's nominal profile.
		const build = family && buildSeed ? targetBuild({ seed: buildSeed, family }) : null;
		PROFILE = build ? build.profile : family ? PROFILES[family] : PROFILE;
		flightBuild = build;
		// D12: same rule as at the bench. `?family=` without `?build=`,
		// `?scene=` without a TARGET SCAN and the bench's hidden terrain all
		// fly a nominal profile — they now keep a portrait all the same.
		flightBuildSeed = build ? buildSeed : nominalBuildSeed(PROFILE?.family);
		controller = new FlightController(
			PROFILE ? { profile: PROFILE, rates: build?.rates } : undefined,
		);
		if (build) logBuild(build);
		else if (PROFILE) console.log(`[target] family ${PROFILE.family} — ${PROFILE.label} (nominal)`);
		return boot(slug);
	})
	.then(openFlightSession)
	.catch((err) => {
		console.error(err);
		hud.show();
		uiAudio.play('ERROR');
		hud.fail(bootFailureMessage(err));
	});

// Le message qu'affiche l'écran de chargement quand le boot échoue. Un trap
// WASM de Rapier (« RuntimeError: unreachable ») n'est pas une exception JS
// avec un sens lisible : dans les faits (issue #249) c'est une allocation qui a
// échoué parce que le processus de rendu n'a plus de mémoire — d'autres onglets
// du jeu, ou plusieurs vols enchaînés dans le même onglet. On le dit, et on dit
// quoi faire, plutôt que d'afficher « unreachable ».
function bootFailureMessage(err) {
	if (err instanceof WebAssembly.RuntimeError) {
		return 'physique : mémoire insuffisante — fermez les autres onglets du jeu, puis rechargez';
	}
	return err.message;
}

// Ouvre la session dès que la première image de vol est prête (PHASE 06). La
// météo est déjà résolue par boot(). Une ouverture qui échoue ne bloque pas le
// vol — la session est du décor, pas une dépendance du moteur.
async function openFlightSession() {
	// `return;` dans le `.then((choice) => { if (choice === null) return; ... })`
	// juste au-dessus ne coupe QUE ce callback, pas la chaîne : `.then(openFlightSession)`
	// s'exécute quand même avec `undefined` (mesuré — #168, #170). En mode
	// ?live=, bootLive() a déjà tout ouvert (pas de session serveur, pas de
	// caméra de cible, droneOsd reste null — voir le commentaire sur OPTS.live) ;
	// sans cette garde, session.open() échoue silencieusement (aucun opérateur
	// chargé) puis applyTargetCamera()/droneOsdLayout() réécrivent un état que
	// bootLive() avait délibérément laissé de côté.
	// `?live=` est un raccourci de DEV : rien n'y est monté, pas même une
	// caméra. Il garde donc sa sortie immédiate.
	//
	// `MODE.live` ne l'est plus. #206 en a fait un vrai mode joueur — une
	// reconnaissance FIELD — et lui a fait hériter de cette garde telle quelle.
	// Conséquence non vue : la section caméra + OSD plus bas ne tournait JAMAIS,
	// donc une reconnaissance volait la machine par défaut SANS AUCUN OSD. Un
	// drone a un OSD ; l'absence d'OSD est un choix qui se pose au banc
	// (ligne HUD), pas un accident du chemin live (#217).
	//
	// La reconnaissance emprunte désormais le chemin du BANC : tout tourne, sauf
	// session.open(). C'est le chemin éprouvé, on ne s'en fabrique pas un
	// deuxième.
	// Dev-only ?live= shortcut. A LIVE flight chosen from the terminal opens a session below (#218).
	// Every flight starts in FPV (D11), this path included.
	if (OPTS.live) { setView('fpv'); return; }
	// Le drop. La musique passe du filtre fermé de l'écran de hack au plein
	// spectre : c'est la décharge, et c'est le seul moment de l'arc qui doit
	// s'entendre comme un événement plutôt que comme une dérive.
	music.drop();
	spawnY = physics.spawn.y;
	spawnX = physics.spawn.x;
	spawnZ = physics.spawn.z;
	sessionStartedAt = Date.now();
	// D16 : briefed, never flown, not the bench — the only flight that gets the
	// three hints.
	hintFlight = !MODE.bench && firstFlightPending(localStorage);
	hintAirborneAt = null;
	fpvtpOsd.setHint(null);
	// Résolue dans le try, lue après : une ouverture de session ratée ne doit
	// pas laisser le vol sans caméra ni sans OSD.
	let tgt = null;
	// NOTHING HERE IS LOGGED. C'est LE point d'étanchéité du banc : aucune
	// session n'est ouverte, donc rien n'est jamais posté, rien n'apparaît au
	// SESSION LOG ni au TARGET LOG, aucun Randomart n'est tiré et les
	// compteurs du pied de page de la Home ne bougent pas — ce dont dépend
	// l'échelle BUILD NOTES, qui compte des sessions.
	//
	// Tout ce qui suit (caméra, OSD drone, OSD FPVTP!) continue de tourner :
	// une machine de banc a une caméra et un OSD comme les autres. Le chemin
	// est celui qu'emprunte déjà une ouverture de session ratée, où `tgt`
	// reste null — il est éprouvé, on ne s'en fabrique pas un deuxième.
	try {
		// Le banc reste étanche. Le vol EN DIRECT, lui, ouvre bien une session
		// depuis #218 : il a une cible, un exemplaire et un hack comme un vol de
		// terrain, donc il laisse la même trace. Sa zone est préfixée `live-`,
		// ce qui rend REVISIT impossible dessus — on ne revisite pas un terrain
		// qu'on n'a pas gardé.
		if (!MODE.bench) {
			await session.open({
				area: flyArea,
				weatherSnapshot: session.snapshotWeather(weather),
				target: flyTarget || undefined,
			});
			// The resolved target arms the video link with the opposing signal's RSSI.
			tgt = session.current()?.target;
			if (tgt?.family && PROFILE && tgt.family !== PROFILE.family) {
				console.warn(`[target] famille serveur ${tgt.family} ≠ profil client ${PROFILE.family} — skew de version ?`);
			}
			// Le serveur régénère le scan et donc le buildSeed. S'ils divergent,
			// le drone volé n'est pas celui enregistré : ça ne casse pas le vol,
			// mais l'archive mentirait, donc on le dit.
			if (tgt?.buildSeed && flyTarget && tgt.buildSeed !== `${flyTarget.seed}::${flyTarget.index}`) {
				console.warn(`[target] buildSeed serveur ${tgt.buildSeed} ≠ client ${flyTarget.seed}::${flyTarget.index}`);
			}
			if (tgt?.signal) {
				link.setSignal({ rssiDbm: tgt.signal.rssiDbm });
				console.log(`[link] target signal ${tgt.signal.rssiDbm} dBm (${tgt.signal.mode})`);
				// Issue #74 : la cible pilote le RENDU du lien, pas seulement son
				// RSSI. Une cible DIGITAL s'affichait en macroblocs analogiques si
				// le curseur du joueur était sur analogique.
				//
				// Deux précisions qui comptent :
				//
				// - `signal.mode` porte `_videoHint`, qui vaut toujours ANALOG ou
				//   DIGITAL. Le `UNKNOWN` que la fiche affiche parfois est ce
				//   qu'on a RÉVÉLÉ au joueur, pas ce que la cible est. Le rendu
				//   montre donc ce que la fiche taisait — c'est voulu : on
				//   reconnaît un lien numérique en le regardant.
				// - la sévérité reste au joueur. À severity 0 il a coupé la
				//   modélisation du lien, et une cible n'a pas à la rallumer : on
				//   reste LINK_OFF. Le réglage garde aussi le mode sur le chemin
				//   dev sans cible (?scene=), où ce bloc ne s'exécute pas.
				if (lensLinkMode !== LINK_OFF) {
					const m = String(tgt.signal.mode ?? '').toUpperCase();
					if (m === 'DIGITAL' || m === 'ANALOG') {
						lensLinkMode = m === 'DIGITAL' ? LINK_DIGITAL : LINK_ANALOG;
						lens.setLink({ mode: lensLinkMode, severity: loadLink().severity });
						console.log(`[link] rendu ${m} imposé par la cible`);
					}
				}
			}
		}
	} catch (e) {
		console.warn('[session] ouverture échouée, ce vol ne sera pas enregistré', e);
	}

	// La graine : la cible si on en a une, l'exemplaire du banc s'il y en a un,
	// la famille du profil sinon (mode dev, ?scene=). Il y a toujours une
	// caméra et toujours un OSD.
	//
	// L'exemplaire du banc entre ici pour que INDIVIDUAL veuille dire quelque
	// chose de bout en bout : deux tirages de la même famille doivent différer
	// par leur caméra et leur OSD, pas seulement par leurs rates.
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

	applyTargetCamera(targetCamera({ seed, family }));

	// Le drone du joueur (issue #264) — ICI et pas dans boot() : la recette lit
	// l'uptilt de la caméra de la cible, qui vient d'être résolue à la ligne
	// au-dessus. Le profil est celui qui VOLE (physics.profile), pas `PROFILE` :
	// un changement de cellule au banc passe par physics.setProfile().
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
	// La panne NO_OSD (voir drone-osd-model.mjs) renvoie null : certaines
	// cibles n'ont simplement pas d'OSD, ou le leur est éteint/HS.
	// HUD CLEAR au banc : une machine montée sans OSD, pour filmer (#217). On
	// ne tire pas de disposition du tout — c'est exactement l'état que
	// `droneOsdLayout()` rend déjà pour sa panne NO_OSD, donc rien en aval n'a
	// à connaître ce réglage. Le réglage est du BANC : une reconnaissance FIELD
	// ne le lit pas, elle a toujours son OSD.
	const hudClear = MODE.bench && MODE.config?.hud === 'CLEAR';
	const osdLayout = hudClear ? null : droneOsdLayout({ seed, family, mode });
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
	// Le `droneOsd?.dispose()` d'openFlightSession() est un DÉBUT de vol, pas
	// un démontage : les ambiants n'y ont rien à faire. Le seul démontage de
	// page est ici (issue #250).
	ambient?.dispose();
	lens.setOnboard(null);
	playerDrone?.dispose();
	playerDrone = null;
});
