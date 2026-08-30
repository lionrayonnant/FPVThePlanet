// Headless checks on the generated scene: geodesy, ground queries, flight
// envelope, and the collision behaviour the sim depends on.
//
//   node tools/selftest.mjs [sceneDir]

import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics, MAX_THRUST, QUAD } from '../src/physics.js';
import { FlightController } from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { VideoLink } from '../src/link.js';
import { WindField, mulberry32, shearFactor, turbulenceIntensity, PROBE_COUNT, PROBE_RANGE } from '../src/wind.js';
import { RainField, dropDrift, fogRange, lensDrops, dropFootprint, LensDrops, MAX_RATE, GRAVITY } from '../src/rain.js';
import { FogField, FOG_PRESETS, rangeFor, extinctionOf, RANGE_MIN } from '../src/fog.js';
import { CloudField, baseFor, BASE_CLEAR, BASE_OVERCAST, DECK_THICKNESS, DIM_MAX } from '../src/cloud.js';
import { toSimParams, sanitize } from './lib/weather.mjs';
import { CALM as CALM_WEATHER } from '../src/weather.js';
import { createTileMaterial } from '../src/TileMaterial.js';
import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { targetCamera, CAMERA_FAMILIES, RES_LOW, RES_HIGH } from './target-camera.mjs';
import { targetBuild, thrustToWeight } from './target-build.mjs';
import {
	droneOsdLayout, ELEMENTS, ELEMENT_WIDTH, GPS_ELEMENTS, GRIDS, DENSITY,
	PANEL_MODES, ARCHETYPES, FIRMWARES, DIGITAL_TINTS, PATHOLOGIES,
} from './drone-osd-model.mjs';
import { crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT } from '../src/quad.js';
import { hoverThrottle } from '../src/flightController.js';
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rolloutSafe, generateEntryState, rngFrom } from '../src/entry-state.js';
import { Geofence, NOMINAL as GF_NOMINAL } from '../src/geofence.js';
import {
	sunPosition, sunVector, refracted, airMass,
	transmittance, skyColor, skyChroma, ambientLevel, skyLevel, sunDisc,
	SunField, REF_ELEV, REF_VIS, SKY_REF, E_MAX, nightSensor, nightAmount,
	skyNightDim,
} from '../src/sun.js';

const sceneDir = path.resolve(process.argv[2] ?? 'public/scenes/tour-eiffel');
const manifest = JSON.parse(fs.readFileSync(path.join(sceneDir, 'manifest.json')));
const raw = fs.readFileSync(path.join(sceneDir, 'collision.bin'));
const vc = raw.readUInt32LE(8), ic = raw.readUInt32LE(12);
const collision = {
	vertices: new Float32Array(raw.buffer, raw.byteOffset + 16, vc * 3),
	indices: new Uint32Array(raw.buffer, raw.byteOffset + 16 + vc * 12, ic),
};

await initPhysics();
// One world only: several 3.7M-triangle trimeshes at once exhausts the wasm heap.
// The flight checks below swap the airframe family in place (phys.setProfile).
const phys = new Physics(collision, manifest.spawn);
let fc = new FlightController();
let PROFILE = QUAD;
const STEP = 1 / 250;

// Thrust is not linear in throttle (rpm goes with cmd^0.65, thrust with rpm^2),
// so the hover stick position has to be inverted through that curve rather than
// read off a ratio. On the 5" freestyle it lands around 25%; a low-thrust
// cinewhoop or whoop sits near half stick.
const hoverStick = (p) => ((p.mass * 9.81) / (4 * p.maxThrustPerMotor)) ** (1 / (2 * p.rpmCurve));
let HOVER = hoverStick(PROFILE);

// Flat-plate terminal velocity from the profile's vertical body drag — what the
// "falling flat" check is really testing.
const AIR_DENSITY = 1.225;
const terminalFlat = (p) => Math.sqrt((p.mass * 9.81) / (0.5 * AIR_DENSITY * p.bodyDrag.y));

function useFamily(fam) {
	PROFILE = PROFILES[fam];
	phys.setProfile(PROFILE);
	fc = new FlightController({ profile: PROFILE });
	HOVER = hoverStick(PROFILE);
}

// Un EXEMPLAIRE tiré (PHASE 07, tools/target-build.mjs) plutôt que le profil
// nominal de la famille : masse, moteurs, pack et rates déviés, sur le tune
// mesuré de la famille — inchangé, c'est tout l'enjeu.
function useBuild(build) {
	PROFILE = build.profile;
	phys.setProfile(PROFILE);
	fc = new FlightController({ profile: PROFILE, rates: build.rates });
	HOVER = hoverStick(PROFILE);
}

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const CALM = { speed: 0, gust: 0, turbulence: 0 };

function simulate({ seconds, sticks, at, velocity, mode = 'acro', weather }) {
	phys.reset();
	// Explicit rather than remembered. There is one Physics instance for the
	// whole file (see above), so weather left on by one section would silently
	// move every check after it — including "holds altitude at hover throttle"
	// and "terminal velocity falling flat", which only mean anything in calm air.
	phys.setWeather(weather ?? CALM);
	fc.setMode(mode);
	if (at) phys.body.setTranslation({ x: at[0], y: at[1], z: at[2] }, true);
	if (velocity) phys.body.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
	fc.reset();
	let maxImpact = 0;
	let peakSpin = 0;
	// Le taux tenu, moyenné sur le dernier tiers du run plutôt que lu à l'instant
	// final. Un bouclage qui ondule (MICRO ondule de 16 % au nominal, les 5" de
	// 0 à 2 %) donne un échantillon instantané qui dépend de l'endroit où l'on
	// tombe dans l'ondulation : 75 % ou 135 % du même vol. La moyenne mesure ce
	// qu'on voulait mesurer, et elle est identique à l'instantané quand le
	// bouclage est propre.
	const tail = [];
	const tailFrom = seconds * (2 / 3);
	for (let i = 0; i < Math.round(seconds * 250); i++) {
		const t = i * STEP;
		const s = typeof sticks === 'function' ? sticks(t) : sticks;
		const { motors } = fc.update(s, phys, STEP);
		maxImpact = Math.max(maxImpact, phys.step(motors, STEP));
		const a = phys.angularVelocity;
		const mag = Math.hypot(a.x, a.y, a.z) * 180 / Math.PI;
		peakSpin = Math.max(peakSpin, mag);
		if (t >= tailFrom) tail.push(mag);
	}
	const p = phys.position, v = phys.velocity, w = phys.angularVelocity;
	const heldSpin = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
	return { p, v, w, peakSpin, heldSpin, battery: phys.battery,
		speed: Math.hypot(v.x, v.y, v.z), spin: Math.hypot(w.x, w.y, w.z) * 180 / Math.PI, maxImpact };
}

console.log(`scene: ${sceneDir}`);
console.log(`origin ${manifest.origin.latitude.toFixed(5)}, ${manifest.origin.longitude.toFixed(5)}`);

console.log('\ngeometry & geodesy');
const size = manifest.bbox.max.map((v, i) => v - manifest.bbox.min[i]);

// Everything below used to be written in metres sized for the 1.2 km Tour
// Eiffel tile: a -600..600 sweep, a 400 m obstruction ring, a 120 m impact run.
// On a smaller map those distances aim outside the scene and the checks fail on
// nothing — bastille (328 m across) reported 9/169 ground hits because most of
// the sweep was off the map. Radii are therefore expressed as fractions of the
// scene, and only the numbers that are genuinely about the Tour Eiffel stay
// behind REFERENCE_SCENE.
const HALF = Math.min(size[0], size[2]) / 2;
const CENTRE = { x: (manifest.bbox.min[0] + manifest.bbox.max[0]) / 2,
                 z: (manifest.bbox.min[2] + manifest.bbox.max[2]) / 2 };
// Par le NOM de la scène, pas par ses coordonnées : le corridor de Seine passe
// à 400 m de la Tour Eiffel et tombait dans un rayon en degrés.
const REFERENCE_SCENE = path.basename(sceneDir) === 'tour-eiffel';
const skipped = [];
// A check that only means something on the reference tile. Recorded rather than
// silently dropped, so the tail of the run says what was not exercised.
function checkRef(label, ok, detail) {
	if (!REFERENCE_SCENE) { skipped.push(label); return; }
	check(label, ok, detail);
}
console.log(REFERENCE_SCENE
	? '  (reference scene: Tour Eiffel — site-specific checks enabled)'
	: '  (not the reference scene: site-specific checks will be skipped)');

check('tile has plausible extents', size[0] > 100 && size[0] < 5000 && size[2] > 100 && size[2] < 5000,
	`${size[0].toFixed(0)} x ${size[2].toFixed(0)} m`);
checkRef('tile is roughly 1.2km square', size[0] > 1000 && size[0] < 1600 && size[2] > 1000 && size[2] < 1600,
	`${size[0].toFixed(0)} x ${size[2].toFixed(0)} m`);
checkRef('origin is the Eiffel Tower area',
	Math.abs(manifest.origin.latitude - 48.8583) < 0.01 && Math.abs(manifest.origin.longitude - 2.297) < 0.01);

// The tallest structure in the tile, whatever it is — the tower here, a roof
// elsewhere. Every check that needs something to fly into or hide behind aims
// at it.
let top = -Infinity, tx = 0, tz = 0;
for (let i = 0; i < vc; i++) {
	const y = collision.vertices[i * 3 + 1];
	if (y > top) { top = y; tx = collision.vertices[i * 3]; tz = collision.vertices[i * 3 + 2]; }
}
// Local ground around the landmark, not under it — under it IS the landmark.
// A ring, scaled to the scene, with the offsets that land outside discarded:
// a fixed 120 m offset falls off a 328 m map entirely.
const landmarkGround = (() => {
	const r = Math.min(120, HALF * 0.35);
	const hits = [];
	for (let a = 0; a < 8; a++) {
		const g = phys.groundBelow(tx + Math.cos(a / 8 * Math.PI * 2) * r, top + 50,
			tz + Math.sin(a / 8 * Math.PI * 2) * r, (top - manifest.bbox.min[1]) + 100);
		if (g !== null) hits.push(g);
	}
	if (!hits.length) return manifest.bbox.min[1];
	hits.sort((a, b) => a - b);
	return hits[Math.floor(hits.length / 2)];
})();
const landmarkHeight = top - landmarkGround;
check('the tile has a tallest structure standing above its ground',
	landmarkHeight > 5, `${landmarkHeight.toFixed(0)} m`);
checkRef('Eiffel Tower is ~300m tall', landmarkHeight > 270 && landmarkHeight < 350, `${landmarkHeight.toFixed(0)} m`);
// Kept under its historical name for the checks further down that read it.
const groundNearTower = landmarkGround;

console.log('\nground queries');
check('ray finds ground at spawn', phys.groundBelow(manifest.spawn.x, 350, manifest.spawn.z) !== null);
// Un rayon tiré d'au-dessus du point le plus haut doit retomber sur la
// structure elle-même, pas sur le sol qui l'entoure.
check('ray finds the tallest structure',
	(phys.groundBelow(tx, top + 50, tz) ?? -Infinity) > landmarkGround + landmarkHeight * 0.5,
	`${(phys.groundBelow(tx, top + 50, tz) ?? 0).toFixed(0)} m, ground ${landmarkGround.toFixed(0)} m`);
checkRef('ray finds the tower structure', (phys.groundBelow(tx, 350, tz) ?? 0) > 200,
	`${(phys.groundBelow(tx, 350, tz) ?? 0).toFixed(0)} m`);
// 13x13 points RÉPARTIS SUR L'EMPRISE, et non un balayage de -600 à 600 m qui
// tombait presque entièrement hors d'une petite carte. Une scène tracée au
// polygone (#30) est creuse par construction : on demande donc une couverture
// large, pas totale, et on la compare à l'occupation réelle du terrain.
let misses = 0, samples = 0;
{
	const top_ = manifest.bbox.max[1] + 50;
	const span = (manifest.bbox.max[1] - manifest.bbox.min[1]) + 100;
	for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
		const x = manifest.bbox.min[0] + ((i + 0.5) / 13) * size[0];
		const z = manifest.bbox.min[2] + ((j + 0.5) / 13) * size[2];
		samples++; if (phys.groundBelow(x, top_, z, span) === null) misses++;
	}
}
const coverage = (samples - misses) / samples;
// Ce que ce test attrape, c'est un maillage de collision absent ou mal placé,
// pas un terrain clairsemé : une scène tracée au polygone est creuse par
// construction (le corridor de Seine couvre 20 % de son emprise, et c'est
// exactement ce qu'on lui a demandé). Le seuil dit « il y a du terrain, réparti
// sur la carte », et la tuile de référence garde son exigence de couverture
// totale juste en dessous.
check('ground coverage across the tile', coverage > 0.05, `${samples - misses}/${samples} hits`);
checkRef('the reference tile is fully covered', misses === 0, `${samples - misses}/${samples} hits`);

// Flight envelope + propulsion, run for every drone family (PHASE 07). The
// thresholds are derived from each family's profile, not written flat, so a
// cinewhoop hovering at half stick or a whoop with a 4 V pack is not a failure.
// Scene-dependent checks (geodesy, collision, link, weather) stay on the
// default family only, below.
for (const fam of FAMILIES) {
	useFamily(fam);
	console.log(`\nflight envelope — ${fam}`);

	// "Still" is generous: the collider is a 0.15 m sphere for every family, so a
	// featherweight airframe on idle props can roll it a little. The check is
	// that it does not take off or wander off the map.
	const rest = simulate({ seconds: 2, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 } });
	check(`[${fam}] sits still on the ground at zero throttle`, rest.speed < 1.5, `${rest.speed.toFixed(2)} m/s`);

	const hover = simulate({ seconds: 4, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 }, at: [0, 150, 300] });
	check(`[${fam}] holds altitude at hover throttle`, Math.abs(hover.p.y - 150) < 4, `drifted ${(hover.p.y - 150).toFixed(2)} m in 4s`);

	// Climb rate is thrust-to-weight bound and, for small props, capped by the
	// inflow thrust loss — a low-TWR ducted machine genuinely climbs slowly.
	const climb = simulate({ seconds: 5, sticks: { throttle: 1, roll: 0, pitch: 0, yaw: 0 }, at: [0, 50, 300] });
	check(`[${fam}] climbs at full throttle`, climb.p.y - 50 > 25, `+${(climb.p.y - 50).toFixed(0)} m in 5s`);

	// The stick has to start centred: RC smoothing primes on its first sample.
	const commanded = fc.rates.roll.max;
	const roll = simulate({ seconds: 1.2, at: [0, 150, 300],
		sticks: (t) => ({ throttle: HOVER, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
	check(`[${fam}] reaches the commanded roll rate (${commanded} deg/s)`,
		roll.heldSpin > commanded * 0.9 && roll.peakSpin < commanded * 1.25,
		`${roll.heldSpin.toFixed(0)} deg/s held, ${roll.peakSpin.toFixed(0)} peak`);

	check(`[${fam}] hovers at a plausible stick position`, HOVER > 0.15 && HOVER < 0.62, `${(HOVER * 100).toFixed(0)}% throttle`);

	// Airmode: the flick still produces the rate with the throttle shut.
	const rollIdle = simulate({ seconds: 1.2, at: [0, 200, 300],
		sticks: (t) => ({ throttle: 0, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
	check(`[${fam}] airmode keeps roll authority at zero throttle`,
		rollIdle.heldSpin > commanded * 0.85,
		`${rollIdle.heldSpin.toFixed(0)} deg/s vs ${roll.heldSpin.toFixed(0)} at hover`);

	// Yaw has the least torque authority of the three axes (it fights prop-drag
	// torque, a fraction of thrust) against the most inertia, so it must build
	// rate visibly slower than pitch. Sampled 80 ms in, before either arrives.
	const SAMPLE_AT = 0.15 + 0.08;
	const yawRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
		sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: 0, yaw: t > 0.15 ? 1 : 0 }) });
	const pitchRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
		sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: t > 0.15 ? 1 : 0, yaw: 0 }) });
	const yawFrac = Math.abs(yawRun.w.y * 180 / Math.PI) / fc.rates.yaw.max;
	const pitchFrac = Math.abs(pitchRun.w.x * 180 / Math.PI) / fc.rates.pitch.max;
	check(`[${fam}] yaw builds rate more slowly than pitch`,
		yawFrac < pitchFrac - 0.03,
		`80 ms in: yaw at ${(yawFrac * 100).toFixed(0)}% of command, pitch at ${(pitchFrac * 100).toFixed(0)}%`);

	// Falling with the throttle shut. Airmode still holds it roughly level so it
	// presents its plate side, and slides the throttle up enough to keep
	// attitude — so the props are turning, not idling, and their descent inflow
	// plus the body drag settle it at a bounded rate. The flat-plate terminal
	// from the vertical drag is the ceiling; a light airframe sits well under it
	// because the props carry more of its weight.
	const vt = terminalFlat(PROFILE);
	const drop = simulate({ seconds: 16, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, at: [0, 600, 300] });
	check(`[${fam}] falls at a bounded rate, under the flat-plate ceiling (~${vt.toFixed(0)} m/s)`,
		drop.speed > 1 && drop.speed < vt * 1.2, `${drop.speed.toFixed(1)} m/s, ceiling ${vt.toFixed(1)}`);

	// The pack has to sag under load and drain, whatever its cell count.
	const full = 4.2 * PROFILE.battery.cells;
	const punch = simulate({ seconds: 6, sticks: { throttle: 1, roll: 0, pitch: 0, yaw: 0 }, at: [0, 100, 300] });
	check(`[${fam}] the pack sags under a full-throttle pull`,
		punch.battery.voltage < 0.97 * full && punch.battery.voltage > 3.0 * PROFILE.battery.cells,
		`${punch.battery.voltage.toFixed(2)} V of ${full.toFixed(1)} at ${punch.battery.current.toFixed(0)} A`);
	check(`[${fam}] the pack drains`, punch.battery.soc < 0.98 && punch.battery.soc > 0.3,
		`${(punch.battery.soc * 100).toFixed(0)}% left after 6 s flat out`);
}

// Tout exemplaire tiré reste pilotable — PHASE 07, issue #44 : « les variations
// qui touchent masse/inertie doivent rester dans une plage où la famille reste
// stable — vérifié, pas supposé ».
//
// Ce que ce bloc prouve, et qui ne se prouve QUE sur un vrai pas de physique :
// le tune PID de la famille, mesuré sur le plant nominal et laissé intact par
// target-build.mjs, contrôle encore le plant dévié. Un tirage qui ne tiendrait
// plus son taux commandé, ou qui overshooterait, voudrait dire que les bornes
// de BUILD_BOUNDS sont trop larges — pas qu'il faut re-tuner à la volée.
//
// Échantillon volontairement petit (BUILD_SEEDS graines par famille) : chaque
// graine coûte deux vols Rapier. Les bornes analytiques, elles, sont vérifiées
// sur 500 graines par famille dans tools/target-build-selftest.mjs. Les graines
// sont fixes, donc un échec est rejouable.
const BUILD_SEEDS = 12;
for (const fam of FAMILIES) {
	console.log(`\nexemplaires tirés — ${fam}`);
	const nominal = PROFILES[fam];
	let worstHold = Infinity, worstPeak = 0, worstHoverDrift = 0;
	let holdSeed = '', peakSeed = '', hoverSeed = '';
	let minTwr = Infinity, maxTwr = -Infinity;

	for (let i = 0; i < BUILD_SEEDS; i++) {
		const seed = `selftest-build-${i}`;
		const build = targetBuild({ seed, family: fam });
		useBuild(build);
		const twr = thrustToWeight(build.profile);
		minTwr = Math.min(minTwr, twr); maxTwr = Math.max(maxTwr, twr);

		// Il tient l'altitude au stick de hover calculé pour SA masse et SES
		// moteurs : c'est le test que masse et poussée sont restées couplées.
		const hover = simulate({ seconds: 4, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 }, at: [0, 150, 300] });
		const drift = Math.abs(hover.p.y - 150);
		if (drift > worstHoverDrift) { worstHoverDrift = drift; hoverSeed = seed; }

		// Il tient SON taux de roulis commandé, sur le tune de sa famille.
		const commanded = fc.rates.roll.max;
		const roll = simulate({ seconds: 1.2, at: [0, 150, 300],
			sticks: (t) => ({ throttle: HOVER, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
		const held = roll.heldSpin / commanded, peak = roll.peakSpin / commanded;
		if (held < worstHold) { worstHold = held; holdSeed = seed; }
		if (peak > worstPeak) { worstPeak = peak; peakSeed = seed; }
	}

	// Mêmes seuils que le test de la famille nominale plus haut : un exemplaire
	// n'a droit à aucune tolérance supplémentaire.
	check(`[${fam}] tout exemplaire atteint son taux commandé`,
		worstHold > 0.9, `pire ${(worstHold * 100).toFixed(0)}% (${holdSeed})`);
	check(`[${fam}] aucun exemplaire n'overshoote`,
		worstPeak < 1.25, `pire pic ${(worstPeak * 100).toFixed(0)}% (${peakSeed})`);
	check(`[${fam}] tout exemplaire tient l'altitude à son stick de hover`,
		worstHoverDrift < 4, `pire dérive ${worstHoverDrift.toFixed(2)} m (${hoverSeed})`);
	// La famille reste la famille : la fourchette de poussée/poids de ses
	// exemplaires reste centrée sur son nominal. Une famille à variation nulle
	// (MICRO, voir FAMILY_VARIATION) rend exactement le nominal — c'est ce qu'on
	// vérifie alors, et le fait qu'elle y soit encore est le garde-fou : le jour
	// où son tune est re-mesuré et sa variation rouverte, ce check bascule.
	const twr0 = thrustToWeight(nominal);
	const varies = (targetBuild({ seed: 'selftest-build-0', family: fam }).variation ?? 1) > 0;
	check(`[${fam}] poussée/poids des exemplaires ${varies ? 'encadre le' : '= le'} nominal`,
		varies
			? (minTwr < twr0 && maxTwr > twr0 && minTwr > twr0 * 0.75 && maxTwr < twr0 * 1.35)
			: (Math.abs(minTwr - twr0) < 1e-9 && Math.abs(maxTwr - twr0) < 1e-9),
		`${minTwr.toFixed(2)}..${maxTwr.toFixed(2)} pour ${twr0.toFixed(2)}`);
}

// Back to the default family for the scene-bound checks below.
useFamily('freestyle5');

// PHASE 08 : la cible résolue désigne toujours un profil de vol réel.
{
	let okAll = true;
	for (const seed of ['t1', 't2', 't3', 't4', 't5']) {
		const scan = generateTargetScan({ seed, count: 5 });
		for (let i = 0; i < scan.candidates.length; i++) {
			if (!PROFILES[resolveTarget(scan, i).family]) okAll = false;
		}
	}
	check('toute cible résolue pointe un profil de vol', okAll);
}

console.log('\ncollision');
const towerX = tx, towerZ = tz;
// On lance le drone à MI-HAUTEUR du repère, pas à 120 m : sur une carte dont la
// plus haute structure fait 3 m, voler à 120 m passait au-dessus de tout et
// l'impact ne se produisait jamais. Le point de départ suit la même échelle.
const impactY = landmarkGround + Math.max(2, landmarkHeight * 0.5);
const impactRun = Math.min(45, HALF * 0.3);
const fast = simulate({ seconds: 2, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 },
	at: [towerX + impactRun, impactY, towerZ], velocity: [-60, 0, 0] });
check('60 m/s impact does not tunnel through the tallest structure (CCD)', fast.p.x > towerX - 25,
	`stopped at x=${fast.p.x.toFixed(1)}, structure at x=${towerX.toFixed(1)}`);
check('high-speed impact registers as a crash', fast.maxImpact > 1500,
	`${fast.maxImpact.toFixed(0)} N at y=${impactY.toFixed(0)} m`);

const land = simulate({ seconds: 3, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 },
	at: [manifest.spawn.x, manifest.spawn.y + 0.3, manifest.spawn.z] });
check('a gentle landing is not a crash', land.maxImpact < 1500, `${land.maxImpact.toFixed(0)} N`);

console.log('\nvideo link');
// The link has two halves and both are checkable without a browser: the
// geometry query in physics.js, and the pure dB model in link.js.
{
	const s = manifest.spawn;
	const ex = s.x, ey = s.y + 1.2, ez = s.z;

	// Straight up out of the spawn there is nothing but sky. If this one fails,
	// the ground station is buried and every other link reading is meaningless.
	check('clear line of sight straight up from the transmitter',
		!phys.obstructionBetween(ex, ey, ez, ex, ey + 200, ez).blocked);

	// A single sheet of terrain has a near face and no far face, so its measured
	// depth is legitimately zero — but it is still in the way. The flag and the
	// span are separate precisely so this case is not read as a clear path.
	const under = phys.obstructionBetween(ex, ey, ez, ex, ey - 30, ez);
	check('the ground counts as blocked even with no measurable depth',
		under.blocked, `span ${under.span.toFixed(1)} m`);

	// Somewhere across the tile at head height there has to be city in the way,
	// or the whole feature has nothing to react to.
	// Rayon relatif à la scène : 400 m en dur sortait d'une carte de 328 m, et
	// les rayons partaient alors dans le vide.
	const ringR = Math.min(400, HALF * 0.6);
	let blockedSamples = 0, deep = 0, total = 0;
	for (let a = 0; a < 8; a++) {
		const x = ex + Math.cos(a / 8 * Math.PI * 2) * ringR;
		const z = ez + Math.sin(a / 8 * Math.PI * 2) * ringR;
		const o = phys.obstructionBetween(ex, ey, ez, x, ey + 2, z);
		total++;
		if (o.blocked) blockedSamples++;
		if (o.span > 5) deep++;
	}
	// Une scène tracée au polygone est creuse : certaines directions sortent du
	// terrain et ne rencontrent rien, légitimement. On demande donc que la
	// majorité des chemins soient barrés, et l'unanimité sur la tuile de
	// référence, qui est un morceau de ville plein.
	// L'anneau est centré DANS le terrain, donc un rayon part toujours dans de
	// la géométrie : au moins la moitié des directions doit rencontrer quelque
	// chose. Sur une scène tracée au polygone, les autres sortent du tracé et ne
	// rencontrent légitimement rien — le corridor de Seine donne 4/8.
	check('street-level paths across the tile are obstructed', blockedSamples >= total / 2,
		`${blockedSamples}/${total} blocked`);
	checkRef('every street-level path across the reference tile is obstructed', blockedSamples === total,
		`${blockedSamples}/${total} blocked`);
	check('obstruction is measured as a depth, not just a flag', deep >= 1,
		`${deep}/${total} deeper than 5 m`);
	checkRef('most reference-tile paths are deep obstructions', deep >= total / 2,
		`${deep}/${total} deeper than 5 m`);

	// The model itself. All of these are properties, not magic numbers, so they
	// survive a retune of the dB constants.
	const link = new VideoLink();
	const settle = (opts, seconds = 10) => {
		link.reset();
		for (let i = 0; i < seconds * 60; i++) link.update({ dt: 1 / 60, ...opts });
		return link.out.quality;
	};
	const near = settle({ distance: 20, blocked: false, span: 0 });
	const far = settle({ distance: 900, blocked: false, span: 0 });
	const behind = settle({ distance: 900, blocked: true, span: 20 });
	check('a clear link close in is perfect', near > 0.99, near.toFixed(3));
	// Distance was removed from the quality budget (issue #79): flying to the far
	// side of the tile in clear air has to look exactly like hovering over the
	// pilot, so exploring the map is never punished. Distance still moves the
	// RSSI readout — that check is further down.
	check('distance alone does not degrade the picture', Math.abs(far - near) < 0.02,
		`${near.toFixed(3)} at 20 m, ${far.toFixed(3)} at 900 m`);
	check('a building is the only thing that degrades a clear-air link',
		behind < near - 0.1, `${near.toFixed(2)} clear vs ${behind.toFixed(2)} behind 20 m of building`);

	// Degraded, not dead. One building between you and the pilot has to be
	// something you can fly back out of.
	const oneBuilding = settle({ distance: 80, blocked: true, span: 12 });
	check('one building degrades the picture without killing it',
		oneBuilding > 0.4 && oneBuilding < 0.9, oneBuilding.toFixed(2));
	// Clipping the corner of a roof is not the same event as flying behind a
	// block, and the two-sided raycast exists so the model can tell them apart.
	const clipped = settle({ distance: 80, blocked: true, span: 0 });
	check('clipping an edge costs much less than going behind a building',
		clipped > oneBuilding + 0.2, `${clipped.toFixed(2)} clipped vs ${oneBuilding.toFixed(2)} behind`);

	// PHASE 08: le RSSI annoncé de la cible décale le budget. À distance et
	// obstruction égales, un signal faible arrive avec moins de marge.
	{
		const strong = new VideoLink(1);
		strong.setSignal({ rssiDbm: -54 });
		const weak = new VideoLink(1);
		weak.setSignal({ rssiDbm: -72 });
		let qs = 1, qw = 1;
		for (let i = 0; i < 600; i++) {
			qs = strong.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
			qw = weak.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
		}
		check('un signal faible dégrade le lien à distance égale', qw < qs - 0.05, `fort ${qs.toFixed(2)} vs faible ${qw.toFixed(2)}`);

		const none = new VideoLink(1);
		none.setSignal({});
		const untouched = new VideoLink(1);            // never calls setSignal
		let q0 = 1, qu = 1;
		for (let i = 0; i < 600; i++) {
			q0 = none.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
			qu = untouched.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
		}
		check('setSignal({}) est un no-op (identique à pas d\'appel)', Math.abs(q0 - qu) < 1e-9, `${q0.toFixed(3)} vs ${qu.toFixed(3)}`);
	}

	// The anti-cliff check, and the reason most of the constants are what they
	// are. The geometry is a step function — the wall is on the path or it is
	// not — so nothing but the time constants stands between a fade and a
	// switch. Fly from clear into shadow and watch every frame.
	link.reset();
	for (let i = 0; i < 600; i++) link.update({ dt: 1 / 60, distance: 80, blocked: false, span: 0 });
	const walk = [];
	for (let i = 0; i < 240; i++) {
		walk.push(link.update({ dt: 1 / 60, distance: 80, blocked: true, span: 12 }).quality);
	}
	let biggestStep = 0;
	for (let i = 1; i < walk.length; i++) biggestStep = Math.max(biggestStep, Math.abs(walk[i] - walk[i - 1]));
	// Frames spent anywhere between the two settled levels, i.e. how much of the
	// transition you actually get to see.
	const inTransition = walk.filter((q) => q > oneBuilding + 0.03 && q < walk[0] - 0.03).length;
	check('rounding a corner is a slide, not a switch', biggestStep < 0.06,
		`biggest single-frame change ${biggestStep.toFixed(3)}`);
	check('the transition is visible for long enough to read', inTransition > 12,
		`${inTransition} frames (${(inTransition / 60 * 1000).toFixed(0)} ms) in transition`);

	// And distance really has no effect anywhere along the tile — not even a
	// gentle gradient (issue #79).
	const ladder = [50, 150, 300, 450, 600, 750, 900].map((d) => settle({ distance: d, blocked: false, span: 0 }));
	const spreadAcrossTile = Math.max(...ladder) - Math.min(...ladder);
	check('distance has no effect on quality across the whole tile', spreadAcrossTile < 0.02,
		ladder.map((q) => q.toFixed(3)).join(' → '));

	// Reacquisition is deliberately slower than loss, the way a diversity
	// receiver behaves. Measured as time-to-halfway in each direction.
	const halfway = (from, to) => {
		// Where it ends up first — settle() resets, so it cannot run after the
		// starting state has been established.
		const target = settle(to);
		link.reset();
		for (let i = 0; i < 600; i++) link.update({ dt: 1 / 60, ...from });
		const start = link.out.quality;
		let frames = 0;
		while (frames < 600 && Math.abs(link.out.quality - start) < Math.abs(target - start) / 2) {
			link.update({ dt: 1 / 60, ...to });
			frames++;
		}
		return frames;
	};
	// Neither state is a clean 0/1: sitting exactly at quality 1 is a plateau
	// (the clamp itself), and a transition starting there measures the plateau,
	// not the time constant. Two shadow depths instead, both off that edge.
	const mildShadow = { distance: 120, blocked: true, span: 6 };
	const heavyShadow = { distance: 120, blocked: true, span: 20 };
	const drop = halfway(mildShadow, heavyShadow);
	const recover = halfway(heavyShadow, mildShadow);
	check('the link is lost faster than it comes back', recover > drop * 2,
		`${(drop / 60 * 1000).toFixed(0)} ms to drop, ${(recover / 60 * 1000).toFixed(0)} ms to recover`);

	// Severity is the slider, and 0 has to mean genuinely nothing.
	link.setSeverity(0);
	const off = settle({ distance: 2000, blocked: true, span: 200 });
	check('severity 0 leaves the picture untouched', off === 1, off.toFixed(3));
	link.setSeverity(1);

	// Bounded whatever it is fed: the shader multiplies by this.
	let outOfRange = 0;
	link.reset();
	for (let i = 0; i < 2000; i++) {
		const o = link.update({ dt: 1 / 60, distance: Math.random() * 3000,
			blocked: Math.random() > 0.5, span: Math.random() * 300 });
		if (!(o.quality >= 0 && o.quality <= 1)) outOfRange++;
	}
	check('quality stays inside 0..1 under any input', outOfRange === 0);

	// --- brouillage: playability bounds (issue #79) -----------------------
	// A fully jammed screen must not last, and must not re-arm straight away.
	// Obstruction alone tops out around quality 0.5, so a genuine, sustained
	// blackout needs a weak target signal stacked on top of it too — otherwise
	// these checks would pass vacuously, without ever exercising the cap.
	const jam = new VideoLink(1);
	jam.setSignal({ rssiDbm: -95 });
	const worst = { distance: 900, blocked: true, span: 300 };
	const settleJam = (opts, seconds = 10) => {
		jam.reset();
		for (let i = 0; i < seconds * 60; i++) jam.update({ dt: 1 / 60, ...opts });
		return jam.out.quality;
	};

	check('this geometry is a genuine blackout before the cap kicks in',
		settleJam(worst, 1) < 0.1, settleJam(worst, 1).toFixed(3));

	// Steady state under that worst case: the temporal cap forces a recovery, so
	// 10 s in it is heavy glitch, never a dead screen.
	check('worst-case geometry cannot hold a permanent blackout',
		settleJam(worst) > 0.15, settleJam(worst).toFixed(2));

	// Longest unbroken stretch below the blackout threshold while flying straight
	// into the worst geometry and staying there.
	jam.reset();
	let maxRun = 0, run = 0;
	for (let i = 0; i < 60 * 45; i++) {
		const q = jam.update({ dt: 1 / 60, ...worst }).quality;
		if (q < 0.1) { run++; maxRun = Math.max(maxRun, run); } else run = 0;
	}
	check('a full blackout never lasts more than a couple of seconds',
		maxRun > 0 && maxRun < 60 * 3, `${(maxRun / 60).toFixed(1)} s`);

	// After that forced recovery the picture stays flyable through the cooldown,
	// even though the geometry still says worst-case.
	jam.reset();
	for (let i = 0; i < 60 * 5; i++) jam.update({ dt: 1 / 60, ...worst });
	let minDuringCooldown = 1;
	for (let i = 0; i < 60 * 15; i++) {
		minDuringCooldown = Math.min(minDuringCooldown, jam.update({ dt: 1 / 60, ...worst }).quality);
	}
	check('after a blackout the link stays flyable through the cooldown',
		minDuringCooldown > 0.2, minDuringCooldown.toFixed(2));

	// A second blackout cannot follow straight after the first — exactly one in
	// the window, not zero (the cap never engaged) and not several (it re-armed
	// too soon).
	jam.reset();
	let blackouts = 0, wasBlack = false;
	for (let i = 0; i < 60 * 20; i++) {
		const q = jam.update({ dt: 1 / 60, ...worst }).quality;
		if (q < 0.1 && !wasBlack) blackouts++;
		wasBlack = q < 0.1;
	}
	check('blackouts cannot chain back-to-back', blackouts === 1, `${blackouts} in 20 s`);

	// Distance still moves the RSSI readout, so the HUD stays believable even
	// though the picture itself no longer cares about range.
	link.reset();
	let rNear = 0;
	for (let i = 0; i < 600; i++) rNear = link.update({ dt: 1 / 60, distance: 20, blocked: false, span: 0 }).rssiDbm;
	const qNear2 = link.out.quality;
	link.reset();
	let rFar = 0;
	for (let i = 0; i < 600; i++) rFar = link.update({ dt: 1 / 60, distance: 1500, blocked: false, span: 0 }).rssiDbm;
	const qFar2 = link.out.quality;
	check('the RSSI readout still falls off with range', rFar < rNear - 8,
		`${rNear.toFixed(0)} vs ${rFar.toFixed(0)} dBm`);
	check('while the picture itself ignores the range', Math.abs(qFar2 - qNear2) < 0.02,
		`${qNear2.toFixed(3)} vs ${qFar2.toFixed(3)}`);
}

console.log('\nwind');
// Two halves again, and both checkable without a browser: the pure field model
// in wind.js, and the ray geometry physics.js feeds it.
{
	const hoverSticks = { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 };
	const high = [manifest.spawn.x, manifest.spawn.y + 150, manifest.spawn.z];

	// Calm has to be the absence of a force, not a very small one. Every
	// envelope check above depends on it, so pin it exactly rather than within
	// an epsilon: an epsilon here means something is being added and subtracted,
	// and that something drifts.
	const noWeather = simulate({ seconds: 3, sticks: hoverSticks, at: high });
	const explicitCalm = simulate({ seconds: 3, sticks: hoverSticks, at: high, weather: CALM });
	check('calm is bit-identical to no wind at all',
		noWeather.p.x === explicitCalm.p.x && noWeather.p.y === explicitCalm.p.y
		&& noWeather.p.z === explicitCalm.p.z);

	// Hands off in a steady wind, the only horizontal force is drag, and drag
	// vanishes as the airspeed does — so ground speed asymptotes to the wind.
	// The time constant is m/(4*kLateral*omega) = 0.65/(4*5e-5*1254) = 2.6 s, so
	// 20 s is 7.7 of them: the bracket below is that convergence, not a taste.
	const drift = simulate({ seconds: 20, sticks: hoverSticks, at: high,
		weather: { speed: 8, direction: 270, gust: 0, turbulence: 0 } });
	const horiz = Math.hypot(drift.v.x, drift.v.z);
	// Against the LOCAL wind, not the 10 m figure: the quad drifted a few
	// hundred metres downwind while this ran, and the profile means the wind it
	// ends up in is not the wind it started in.
	const local = phys.wind.local;
	check('a quad hands-off drifts downwind at very nearly the wind speed',
		horiz > local * 0.85 && horiz < local * 1.1,
		`${horiz.toFixed(1)} m/s against a local ${local.toFixed(1)}`);
	check('and it drifts the way the wind is going, not against it',
		drift.v.x > 0 && Math.abs(drift.v.z) < horiz * 0.35,
		`v = (${drift.v.x.toFixed(1)}, ${drift.v.z.toFixed(1)})`);

	// The whole reason `airspeed` exists rather than reusing ground speed: the
	// wind rush in audio.js follows the air. Having reached the wind's own
	// speed, the quad is standing still relative to it.
	// Not zero: the wander keeps moving the air by a couple of m/s over tens of
	// seconds and the quad chases it with a 2.6 s time constant, so a small
	// residual is the model working, not failing. An order of magnitude down on
	// the ground speed is the property that matters.
	check('airspeed follows the air and not the ground',
		phys.airspeed < horiz * 0.15 && horiz > 7,
		`${phys.airspeed.toFixed(2)} m/s air, ${horiz.toFixed(1)} m/s ground`);

	// The axis convention, which is the single thing here that could be exactly
	// backwards while looking completely fine. Z is SOUTH, so a north wind
	// (direction 0) blows towards +Z.
	{
		const w = new WindField(1).setParams({ speed: 10, direction: 0, gust: 0, turbulence: 0 });
		check('a north wind blows south', w.nominal.z > 9.9 && Math.abs(w.nominal.x) < 0.01);
		w.setParams({ direction: 90 });
		check('an east wind blows west', w.nominal.x < -9.9 && Math.abs(w.nominal.z) < 0.01);
	}

	// The boundary layer, as properties rather than as numbers: the bracket on
	// the 100/10 ratio is the plausible Davenport roughness range (0.5 to 2 m
	// gives 1.77 to 2.43), so it survives a change of z0.
	{
		const h = [2, 5, 10, 30, 100, 300, 400].map(shearFactor);
		let rising = true;
		for (let i = 1; i < 6; i++) if (h[i] <= h[i - 1]) rising = false;
		check('wind grows with height, all the way up', rising);
		check('and stops growing above the surface layer', h[6] === h[5]);
		check('street level is genuinely sheltered', h[0] < 0.45, `${(h[0] * 100).toFixed(0)}% of the 10 m wind`);
		const ratio = h[4] / h[2];
		check('100 m carries about twice the wind of 10 m', ratio > 1.7 && ratio < 2.5, ratio.toFixed(2));
		const i10 = turbulenceIntensity(10), i100 = turbulenceIntensity(100), i300 = turbulenceIntensity(300);
		check('turbulence intensity falls with height', i10 > i100 && i100 > i300,
			`${i10.toFixed(2)} / ${i100.toFixed(2)} / ${i300.toFixed(2)}`);
		check('and is the city value at 10 m', i10 > 0.35 && i10 < 0.55, i10.toFixed(3));
	}

	// The Dryden axis ratios. These are the numbers that replaced an unsourced
	// 0.4, so they get measured rather than asserted from a comment. Over 600 s
	// with a longitudinal time constant of ~12 s there are only ~50 independent
	// samples, so the relative error on a standard deviation is 1/sqrt(2*50),
	// about 10% — which is where the brackets come from.
	{
		const w = new WindField(7).setParams({ speed: 10, direction: 270, gust: 0, turbulence: 1 });
		const dt = 1 / 250;
		let su = 0, sv = 0, sw = 0, sl = 0, n = 0;
		for (let i = 0; i < 250 * 600; i++) {
			const o = w.update(50, null, 0, dt);
			if (i < 250 * 20) continue;      // let the filters forget their zero start
			const dx = w.dirH.x, dz = w.dirH.z, L = w.local;
			const mx = o.x - dx * L, mz = o.z - dz * L;
			const u = mx * dx + mz * dz, v = -mx * dz + mz * dx;
			su += u * u; sv += v * v; sw += o.y * o.y; sl += L; n++;
		}
		su = Math.sqrt(su / n); sv = Math.sqrt(sv / n); sw = Math.sqrt(sw / n); sl /= n;
		check('turbulence is as strong as the profile says it should be',
			su / sl > 0.20 && su / sl < 0.31, `sigma_u/U = ${(su / sl).toFixed(3)}, expected ${turbulenceIntensity(50).toFixed(3)}`);
		check('lateral turbulence is 0.78 of longitudinal', sv / su > 0.65 && sv / su < 0.90, (sv / su).toFixed(3));
		check('vertical turbulence is 0.52 of longitudinal', sw / su > 0.40 && sw / su < 0.65, (sw / su).toFixed(3));
	}

	// Three gust knobs have to be three knobs: if turning one moves another's
	// measurement, they are one knob wearing three labels.
	{
		const sample = ({ rate, len, peak }) => {
			const w = new WindField(11).setParams({ speed: 10, direction: 270, turbulence: 0,
				gustRate: rate, gustDuration: len, gustPeak: peak });
			const dt = 1 / 50;
			// Arrivals are counted at the source rather than by thresholding the
			// output: at higher rates gusts overlap, and a threshold crossing then
			// counts two of them as one. The width is still measured from the
			// signal, which is the half of it a threshold does answer honestly.
			let above = false, width = 0, run = 0, events = 0, peakSeen = 0;
			const base = 10 * shearFactor(10);
			for (let i = 0; i < 50 * 600; i++) {
				const o = w.update(10, null, 0, dt);
				const extra = Math.hypot(o.x, o.z) - w.local;
				peakSeen = Math.max(peakSeen, extra);
				const on = extra > base * peak * 0.25;
				if (on && !above) run = 0;
				if (on) run += dt;
				if (!on && above) { width += run; events++; }
				above = on;
			}
			return { perMin: w.gusts / 10, meanWidth: events ? width / events : 0, peak: peakSeen };
		};
		const a = sample({ rate: 12, len: 3, peak: 0.5 });
		const b = sample({ rate: 12, len: 6, peak: 0.5 });
		const c = sample({ rate: 24, len: 3, peak: 0.5 });
		const d = sample({ rate: 12, len: 3, peak: 1.0 });
		// Poisson counting noise over N = rate*10 events is 1/sqrt(N); at 12/min
		// that is 13% at one sigma, so +/-40% is three of them.
		check('gusts arrive at the rate asked for', a.perMin > 7 && a.perMin < 17, `${a.perMin.toFixed(1)}/min`);
		check('doubling the rate doubles the arrivals', c.perMin > a.perMin * 1.5, `${c.perMin.toFixed(1)}/min`);
		check('a longer gust lasts longer', b.meanWidth > a.meanWidth * 1.5,
			`${a.meanWidth.toFixed(2)} s -> ${b.meanWidth.toFixed(2)} s`);
		check('and does not change how often they come', Math.abs(b.perMin - a.perMin) < a.perMin * 0.4,
			`${a.perMin.toFixed(1)} vs ${b.perMin.toFixed(1)}/min`);
		check('doubling the intensity doubles the peak', d.peak > a.peak * 1.6 && d.peak < a.peak * 2.5,
			`${a.peak.toFixed(1)} -> ${d.peak.toFixed(1)} m/s`);
		check('and does not change how often they come', Math.abs(d.perMin - a.perMin) < a.perMin * 0.4,
			`${a.perMin.toFixed(1)} vs ${d.perMin.toFixed(1)}/min`);
	}

	// Determinism. Without it none of the checks above are checks — they are
	// samples of a distribution that happens to have passed once.
	{
		const mk = () => new WindField(0xabc).setParams({ speed: 9, direction: 200, gust: 0.7, turbulence: 1 });
		const one = mk(), two = mk();
		let same = true;
		for (let i = 0; i < 5000; i++) {
			const a = one.update(40, null, 5, 1 / 250);
			const b = two.update(40, null, 5, 1 / 250);
			if (a.x !== b.x || a.y !== b.y || a.z !== b.z) { same = false; break; }
		}
		check('the same seed replays the same weather', same);
		one.reset();
		const three = mk();
		const a = one.update(40, null, 5, 1 / 250), b = three.update(40, null, 5, 1 / 250);
		check('and reset really does go back to the start', a.x === b.x && a.y === b.y && a.z === b.z);
	}

	// Nothing may run away, whatever the geometry says. Same shape as the link's
	// "quality stays inside 0..1" check above.
	{
		const w = new WindField(3);
		// Seeded, like everything else here: an adversarial sweep drawn fresh
		// every run reports a different worst case each time, and a bound that
		// moves is not a bound. This is the same argument that put a seed in
		// WindField in the first place.
		const rnd = mulberry32(0x9e37);
		const probe = new Float32Array(PROBE_COUNT);
		let bad = 0, worst = 0;
		for (let i = 0; i < 20000; i++) {
			if (i % 100 === 0) {
				w.setParams({ speed: rnd() * 25, direction: rnd() * 360,
					gust: rnd(), turbulence: rnd() * 2 });
			}
			for (let k = 0; k < PROBE_COUNT; k++) probe[k] = rnd() * PROBE_RANGE[k];
			const o = w.update(rnd() * 300, probe, rnd() * 40, 1 / 250);
			const m = Math.hypot(o.x, o.y, o.z);
			worst = Math.max(worst, m / Math.max(1, w.speed));
			if (!Number.isFinite(m)) bad++;
		}
		// The arithmetic worst case: the profile at 300 m (x2.48) times the
		// wander at 3 sigma (x1.15) times the terrain clamp (x1.6) is a mean of
		// 4.6, and on top of that a full gust (x1.26) and three sigma of
		// turbulence at the slider's maximum (2 x 0.8 x 3 = x4.8) — about 32 if
		// every one of them peaks on the same step on all three axes, which is
		// why the ceiling is well above what a run actually reaches. It is a
		// runaway guard, not a calibration: a feedback loop leaves it decades
		// behind, and nothing legitimate approaches it.
		check('the field stays finite and bounded under any geometry',
			bad === 0 && worst < 32, `worst |w| was ${worst.toFixed(1)}x the nominal`);
	}

	// The rays, against real geometry, through the same path the sim uses.
	// Photogrammetry of the tower is lacy, so a single ray can go straight
	// through it — average over eight bearings, the way the video link section
	// above does.
	{
		const ring = (r, y) => {
			let shelter = 0;
			for (let a = 0; a < 8; a++) {
				const ang = (a / 8) * Math.PI * 2;
				const x = tx + Math.cos(ang) * r, z = tz + Math.sin(ang) * r;
				// The sample point sits at bearing `ang` from the tower, so for the
				// tower to be upwind the air has to be blowing outward from it:
				// blowing direction (cos, sin), which is the bearing below. See the
				// (-sin, cos) convention in wind.js.
				const dir = (Math.atan2(-Math.cos(ang), Math.sin(ang)) * 180) / Math.PI;
				phys.setWeather({ speed: 10, direction: dir, gust: 0, turbulence: 0 });
				phys.wind.reset();
				// 3 s, comfortably past the 0.8 s the terrain scalars are smoothed
				// over, with the probe on its real 11-step period.
				for (let i = 0; i < 750; i++) {
					const probe = i % 11 === 0 ? phys.probeWind(x, y, z) : phys._probe;
					phys.wind.update(y, probe, 0, 1 / 250);
				}
				shelter += phys.wind.shelter;
			}
			return shelter / 8;
		};
		// Rayons et altitude relatifs au repère : à 60 m au-dessus du sol, un
		// bâtiment de 3 m n'abrite rien, et un anneau de 400 m sort d'une petite
		// carte. On sonde à mi-hauteur du repère, près puis loin.
		const leeR = Math.max(15, Math.min(25, landmarkHeight * 0.15));
		const openR = Math.min(400, HALF * 0.8);
		const probeY = groundNearTower + Math.max(5, landmarkHeight * 0.2);
		const lee = ring(leeR, probeY);
		const open = ring(openR, probeY);
		phys.setWeather(CALM);
		// Un repère trop bas n'a pas de sillage à montrer : l'assertion ne veut
		// alors rien dire, et la sauter est plus honnête que la faire échouer.
		if (landmarkHeight > 25) {
			check('the tallest structure shelters the air behind it', lee > 0.15,
				`shelter ${lee.toFixed(2)} at ${leeR.toFixed(0)} m`);
			check('and far out in the open it does not', open < lee * 0.7,
				`shelter ${open.toFixed(2)} at ${openR.toFixed(0)} m`);
		} else {
			skipped.push('the tallest structure shelters the air behind it (no structure tall enough)');
			skipped.push('and far out in the open it does not (no structure tall enough)');
		}
		// A wake is not a vacuum: the lee of a building is never still air, and a
		// model that says it is reads as a bug rather than as shelter.
		check('a wake still has air moving in it', 1 - 0.7 * lee > 0.2,
			`${((1 - 0.7 * lee) * 100).toFixed(0)}% of the free stream left`);
	}

	// Cost, measured rather than assumed. The video link already casts two rays
	// per rendered frame against this same 3.7M-triangle mesh.
	{
		const t0 = performance.now();
		for (let i = 0; i < 200; i++) phys.probeWind(manifest.spawn.x, manifest.spawn.y + 30, manifest.spawn.z);
		const per = (performance.now() - t0) / 200;
		check('a ten-ray probe is cheap enough for 20 Hz', per < 2, `${per.toFixed(3)} ms per probe`);
	}
}

console.log('\nrain');
// Everything here is the pure model in src/rain.js. What it cannot check is
// whether the drops look like water — that is a browser job, and HANDOFF says
// so. What it can check is that dry is really dry, that the intensity slider
// means what it says, and that the drops run the right way, which is the one
// thing in here that could be exactly backwards while looking perfectly normal.
{
	const FOG = 0.00085;
	const run = (field, seconds, airspeed = 0, dt = 1 / 50) => {
		let sum = 0, sumSq = 0, n = 0;
		for (let i = 0; i < Math.round(seconds / dt); i++) {
			field.update(airspeed, dt);
			sum += field.rate; sumSq += field.rate * field.rate; n++;
		}
		const mean = sum / n;
		return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
	};

	// Dry has to be bit-identical to there being no rain model at all, for the
	// same reason calm air does in the wind section: everything above this line
	// assumes a neutral world, and an epsilon here would be something added and
	// then subtracted, and that something drifts.
	{
		const dry = new RainField(1, FOG);
		let moved = false;
		for (let i = 0; i < 2000; i++) {
			dry.update(12, 1 / 50);
			if (dry.rate !== 0 || dry.wetness !== 0 || dry.fogScale !== 1) moved = true;
		}
		check('dry weather is inert', !moved && dry.visibility === Infinity);
		// And it stays inert after a shower has been and gone.
		const stopped = new RainField(1, FOG).setParams({ intensity: 0.6, variability: 0 });
		for (let i = 0; i < 1000; i++) stopped.update(0, 1 / 50);
		const wasWet = stopped.wetness;
		stopped.setParams({ intensity: 0 });
		for (let i = 0; i < 6000; i++) stopped.update(6, 1 / 50);
		check('turning the rain off gives the picture back',
			wasWet > 0.5 && stopped.wetness === 0 && stopped.fogScale === 1,
			`${wasWet.toFixed(2)} wet during, dry after`);
	}

	// The slider says an intensity and the model has to deliver it on average.
	// Averaged over seeds, not over one: the rate is correlated over a minute or
	// so, and a single run of even an hour is a handful of independent samples.
	{
		const meanOver = (variability) => {
			let acc = 0;
			for (let seed = 1; seed <= 16; seed++) {
				acc += run(new RainField(seed * 7919, FOG).setParams({ intensity: 0.1, variability }), 3000).mean;
			}
			return acc / 16 / 0.1;
		};
		const flat = meanOver(0);
		const wobbly = meanOver(0.75);
		check('a steady setting delivers exactly that rate', Math.abs(flat - 1) < 1e-9,
			`${flat.toFixed(6)} of the setting`);
		// Lognormal with the exp(-k^2/2) correction, so making the weather breathe
		// must not quietly make it rainier. It comes out a few percent under
		// because the noise is bounded at 3 sigma and the correction assumes it
		// is not — an error in the safe direction.
		check('variability moves the rate about without moving its mean',
			wobbly > 0.9 && wobbly <= 1.0, `${wobbly.toFixed(3)} of the setting at 75% variability`);
	}
	{
		const spread = (variability) => run(
			new RainField(4242, FOG).setParams({ intensity: 0.2, variability }), 6000);
		const calm = spread(0), gusty = spread(1);
		// The tolerance is the variance formula's, not the model's: at zero
		// variability every sample is the same float, and sumSq/n - mean^2
		// cancels down to its own rounding error rather than to zero.
		check('variability is what widens the spread',
			calm.sd / calm.mean < 1e-5 && gusty.sd / gusty.mean > 0.4,
			`cv ${(gusty.sd / gusty.mean).toFixed(2)} at full variability, ${(calm.sd / calm.mean).toExponential(1)} at none`);
	}

	// The published relations, spot-checked at a rate whose numbers are known:
	// 5 mm/h is a bit over a millimetre of drop falling at about 4.5 m/s, and
	// leaves you a few kilometres of visibility.
	{
		const r = new RainField(9, FOG).setParams({ intensity: 5 / MAX_RATE, variability: 0 });
		r.update(0, 1 / 50);
		check('drop size and fall speed at 5 mm/h',
			r.dropDiameter > 1.1 && r.dropDiameter < 1.4 && r.fallSpeed > 4 && r.fallSpeed < 5,
			`${r.dropDiameter.toFixed(2)} mm at ${r.fallSpeed.toFixed(2)} m/s`);
		check('concentration is hundreds of drops per cubic metre',
			r.dropsPerM3 > 150 && r.dropsPerM3 < 800, `${r.dropsPerM3.toFixed(0)} /m³`);
		check('5 mm/h leaves a few km of visibility',
			r.visibility > 3000 && r.visibility < 9000, `${(r.visibility / 1000).toFixed(1)} km`);
		// Extinctions add, so the range the pilot actually gets is the two in
		// parallel — and it has to be shorter than either.
		const combined = fogRange(FOG * r.fogScale);
		check('rain and the scene fog combine as extinctions',
			combined < fogRange(FOG) && combined < r.visibility
			&& Math.abs(1 / combined - (1 / fogRange(FOG) + 1 / r.visibility)) < 1e-9,
			`${Math.round(fogRange(FOG))} m clear + ${Math.round(r.visibility)} m rain = ${Math.round(combined)} m`);
	}

	// The lens covers itself when you sit in it and clears when you fly. This is
	// the whole reason wetness is a state and not a copy of the rate.
	{
		const hoverField = new RainField(11, FOG).setParams({ intensity: 0.8, variability: 0 });
		for (let i = 0; i < 3000; i++) hoverField.update(0, 1 / 50);
		const hovering = hoverField.wetness;
		for (let i = 0; i < 3000; i++) hoverField.update(18, 1 / 50);
		const cruising = hoverField.wetness;
		check('the lens fogs up hovering in the rain', hovering > 0.7, hovering.toFixed(2));
		check('and clears again when you fly', cruising < hovering * 0.6,
			`${hovering.toFixed(2)} -> ${cruising.toFixed(2)} at 18 m/s`);
	}

	// Where the water runs. Every sign below could be exactly backwards while
	// looking perfectly plausible, which is what happened to the updraft in the
	// wind section, so each one is stated as the thing a pilot would see.
	{
		const m = QUAD.mass, tilt = 25 * Math.PI / 180;
		const still = { x: 0, y: 0, z: 0 };
		const hover = { x: 0, y: m * GRAVITY, z: 0 };
		const d = (air, force) => dropDrift(air, force, m, tilt);

		const h = d(still, hover);
		check('a drop runs down the frame in a hover', h.y < -0.8 && Math.abs(h.x) < 1e-9,
			`(${h.x.toFixed(2)}, ${h.y.toFixed(2)}) g`);

		const fall = d(still, { x: 0, y: 0, z: 0 });
		check('and floats in free fall', Math.hypot(fall.x, fall.y) < 1e-9);

		// The one that is not obvious, and the reason this is not just "down":
		// the airflow over the glass beats gravity from a few m/s upwards, so a
		// quad on a line has the water running UP the picture.
		const slow = d({ x: 0, y: 0, z: -3 }, hover);
		const fast = d({ x: 0, y: 0, z: -15 }, hover);
		check('the airflow carries the water up the frame at speed',
			slow.y < 0 && fast.y > 1, `${slow.y.toFixed(2)} g at 3 m/s, ${fast.y.toFixed(2)} g at 15 m/s`);

		// Sideways: air coming from the drone's right pushes the water left.
		const cross = d({ x: 8, y: 0, z: 0 }, hover);
		check('a crosswind pushes the water across the glass', cross.x < -1,
			`${cross.x.toFixed(2)} g`);

		// And acceleration: shoving the quad to the right leaves the water behind.
		const accel = d(still, { x: m * 8, y: m * GRAVITY, z: 0 });
		check('accelerating right leaves the water to the left', accel.x < -0.5,
			`${accel.x.toFixed(2)} g`);
	}

	// What that water looks like once it is on the glass. The count is the
	// surprise of this section and the thing the rendering hangs off: a ten
	// millimetre window divided by a three millimetre bead is single digits, so
	// a wet lens is a handful of fat drops and never a field of them.
	{
		const dry = lensDrops(0, 1.6);
		check('a dry lens has no drops on it', dry.count === 0 && dry.beadMm === 0);

		const light = lensDrops(0.2, 1.6);
		const soaked = lensDrops(0.86, 1.6);
		check('a wet lens is a handful of drops, not a field',
			soaked.count > 4 && soaked.count < 16 && light.count < soaked.count,
			`${light.count.toFixed(1)} at 0.2 wet, ${soaked.count.toFixed(1)} at 0.86`);
		// They coalesce: the wetter it gets the bigger each bead, which is why
		// the count grows far more slowly than the water does.
		check('drops merge as the glass gets wetter',
			soaked.beadMm > light.beadMm * 1.2 && soaked.count < light.count * 4.3,
			`${light.beadMm.toFixed(2)} -> ${soaked.beadMm.toFixed(2)} mm`);

		// And what one bead does to the picture. The footprint is set by the
		// entrance pupil at least as much as by the drop, which is the whole
		// reason a millimetre of water blots out tens of degrees of view and why
		// no image of the world can survive it.
		const big = dropFootprint(3.2), small = dropFootprint(0.5);
		check('a bead blots out tens of degrees whatever its size',
			big.angle > 0.3 && small.angle > 0.15 && big.angle < small.angle * 3,
			`6x the drop, ${(big.angle / small.angle).toFixed(1)}x the footprint: `
			+ `${(big.angle * 57.3).toFixed(0)} deg for 3.2 mm, ${(small.angle * 57.3).toFixed(0)} for 0.5`);
		// The one that is geometry rather than taste: a drop narrower than the
		// pupil can only ever clip part of the cone, so it is never opaque, and
		// it has no flat core at all.
		check('a drop smaller than the pupil is never opaque',
			small.peak < 0.3 && small.core === 0 && big.peak === 1 && big.core > 0.4,
			`peak ${small.peak.toFixed(2)} small, ${big.peak.toFixed(2)} big`);
	}

	// The population on the glass: how many there are, and where they run.
	{
		const dryPop = new LensDrops(3);
		for (let i = 0; i < 500; i++) dryPop.update({ wetness: 0, dropDiameterMm: 0, dt: 1 / 50 });
		check('a dry lens draws nothing at all', dryPop.count === 0 && dryPop.drops.length === 0);

		// Hovering: the beads sit where they landed. A bead only breaks away
		// when the force beats the contact line holding it, and one g does not,
		// which is what "la majorité restent presque fixes" is in this model.
		const hover = new LensDrops(5);
		const hoverDrift = { x: 0, y: -1 };
		for (let i = 0; i < 900; i++) {
			hover.update({ wetness: 0.86, dropDiameterMm: 1.65, drift: hoverDrift, dt: 1 / 50 });
		}
		const onFrame = hover.drops.filter((d) => Math.abs(d.x) <= 1 && Math.abs(d.y) <= 1);
		check('a hovering lens holds a handful of drops in frame',
			hover.count >= 5 && hover.count <= 12 && onFrame.length >= 3,
			`${hover.count} drops, ${onFrame.length} in frame`);

		// And flying: the air pushes the water UP the picture. Same sign as the
		// dropDrift checks above, but now it has to actually move the beads.
		const fast = new LensDrops(5);
		const up = { x: 0, y: 6.2 };
		fast.update({ wetness: 0.4, dropDiameterMm: 1.65, drift: up, dt: 1 / 50 });
		const before = fast.drops.map((d) => d.y);
		for (let i = 0; i < 25; i++) {
			fast.update({ wetness: 0.4, dropDiameterMm: 1.65, drift: up, dt: 1 / 50 });
		}
		const rose = fast.drops.slice(0, before.length).filter((d, i) => d.y > before[i]).length;
		check('the water runs up the frame in fast flight',
			before.length > 0 && rose === before.length,
			`${rose}/${before.length} beads rose`);

		// A frozen picture is a picture the water is in, so dt = 0 has to stop
		// it dead. This is the trap #24 left behind, and the reason the drops
		// are a population with a dt rather than a clock in the shader.
		const held = new LensDrops(5);
		for (let i = 0; i < 200; i++) held.update({ wetness: 0.6, dropDiameterMm: 1.65, drift: up, dt: 1 / 50 });
		const frame = held.drops.map((d) => `${d.x},${d.y},${d.fade}`).join('|');
		for (let i = 0; i < 200; i++) held.update({ wetness: 0.6, dropDiameterMm: 1.65, drift: up, dt: 0 });
		check('a held frame holds the water still',
			held.drops.map((d) => `${d.x},${d.y},${d.fade}`).join('|') === frame);
	}

	// Deterministic, like the wind: the same seed replays the same weather, and
	// reset() really goes back to the start.
	{
		const a = new RainField(0xbeef, FOG).setParams({ intensity: 0.4, variability: 0.8 });
		const b = new RainField(0xbeef, FOG).setParams({ intensity: 0.4, variability: 0.8 });
		const trace = (f) => { const out = []; for (let i = 0; i < 1500; i++) { f.update(5, 1 / 50); out.push(f.rate); } return out; };
		const first = trace(a), second = trace(b);
		a.reset();
		const replay = trace(a);
		check('same seed, same weather; reset returns to the start',
			first.every((v, i) => v === second[i]) && first.every((v, i) => v === replay[i]));
	}
}

console.log('\nbrouillard');
// The scene's clear-air fog, the floor everything below starts from.
{
	const FOG = 0.00085;

	// Clear air has to be the world as it was before the fog model existed: the
	// #9fb8cc sky pixel HANDOFF calls the regression not to reopen is the sky of
	// a scene whose slider is at zero.
	{
		const f = new FogField(3, FOG);
		for (let i = 0; i < 1000; i++) f.update(1 / 50);
		check('clear air leaves the scene fog exactly where it was',
			f.density === FOG && f.range === fogRange(FOG) && f.glare === 0 && f.skyMix === 0,
			`${f.density} at ${Math.round(f.range)} m`);
		// And it does it without drawing a single random number, so a session
		// spent in clear air is bit-identical to one with no fog model in it.
		const untouched = new FogField(3, FOG);
		f.setParams({ intensity: 0.5, variability: 0.8 });
		untouched.setParams({ intensity: 0.5, variability: 0.8 });
		let same = true;
		for (let i = 0; i < 500; i++) {
			f.update(1 / 50); untouched.update(1 / 50);
			if (f.density !== untouched.density) same = false;
		}
		check('and consumes no randomness while it is off', same);
	}

	// The mapping is geometric in the range: that is the only scale on which
	// "a bit more fog" means the same thing at 2 km and at 50 m.
	{
		const r0 = rangeFor(0, FOG), r1 = rangeFor(1, FOG), rh = rangeFor(0.5, FOG);
		check('the slider spans clear air to RANGE_MIN',
			Math.abs(r0 - fogRange(FOG)) < 1e-9 && Math.abs(r1 - RANGE_MIN) < 1e-9,
			`${Math.round(r0)} m -> ${r1.toFixed(1)} m`);
		check('and it is geometric, so half the slider is the geometric mean',
			Math.abs(rh * rh - r0 * r1) < 1e-6 * r0 * r1, `${Math.round(rh)} m`);
		let monotone = true;
		for (let i = 1; i <= 100; i++) if (rangeFor(i / 100, FOG) >= rangeFor((i - 1) / 100, FOG)) monotone = false;
		check('visibility only ever shortens as the slider goes up', monotone);
	}

	// The presets are solved back from published visibility classes rather than
	// picked as round slider positions, so this is what pins them.
	{
		const named = { brume: 1200, brouillard: 500, puree: 50 };
		const off = Object.entries(named)
			.map(([k, m]) => Math.abs(rangeFor(FOG_PRESETS[k].intensity, FOG) - m) / m);
		check('the presets land on the visibilities they are named for',
			off.every(e => e < 0.01) && FOG_PRESETS.clair.intensity === 0,
			Object.entries(named).map(([k, m]) =>
				`${k} ${Math.round(rangeFor(FOG_PRESETS[k].intensity, FOG))}/${m} m`).join(', '));
	}

	// Breathing must not be thickening. Same lognormal correction as the rain,
	// and the same reason to check it: the mean is what the pilot set.
	{
		const still = new FogField(5, FOG).setParams({ intensity: 0.6, variability: 0 });
		let flat = true;
		for (let i = 0; i < 2000; i++) { still.update(1 / 50); if (still.density !== still.baseDensity * Math.pow(still.span, 0.6)) flat = false; }
		check('no variability, no breathing', flat, `${Math.round(still.range)} m`);

		// Pooled over six seeds and a hundred minutes each. That is not padding:
		// the slow band has a two-minute memory, so twenty minutes is barely ten
		// independent samples and a single seed lands anywhere between 0.8 and
		// 1.2 of the mean while the model itself is unbiased.
		const target = FOG * Math.pow(fogRange(FOG) / RANGE_MIN, 0.6) - FOG;
		let sum = 0, n = 0, min = Infinity, max = 0;
		for (const seed of [7, 11, 23, 99, 131, 257]) {
			const breathing = new FogField(seed, FOG).setParams({ intensity: 0.6, variability: 1 });
			for (let i = 0; i < 300000; i++) {
				breathing.update(1 / 50);
				sum += breathing.density - FOG; n++;
				if (breathing.range < min) min = breathing.range;
				if (breathing.range > max) max = breathing.range;
			}
		}
		check('variability moves the fog without thickening it',
			Math.abs(sum / n - target) / target < 0.03,
			`mean extinction ${(sum / n / target).toFixed(3)} of the setting`);
		check('and it does move it', max / min > 1.5,
			`${Math.round(min)} m to ${Math.round(max)} m around a ${Math.round(rangeFor(0.6, FOG))} m setting`);
	}

	// Fog and rain are two extinctions in the same air.
	{
		const f = new FogField(13, FOG).setParams({ intensity: 0.5, variability: 0 }).update(1 / 50);
		const r = new RainField(9, FOG).setParams({ intensity: 10 / MAX_RATE, variability: 0 });
		r.update(0, 1 / 50);
		const total = fogRange(f.density + extinctionOf(r.visibility));
		check('fog and rain combine as extinctions',
			total < f.range && total < r.visibility
			&& Math.abs(1 / total - (1 / f.range + 1 / r.visibility)) < 1e-9,
			`${Math.round(f.range)} m fog + ${Math.round(r.visibility)} m rain = ${Math.round(total)} m`);
		// And with the fog off, that sum is exactly the rain-only expression the
		// previous instalment shipped.
		const off = new FogField(13, FOG).update(1 / 50);
		check('fog off reproduces the rain-only density to the bit',
			off.density + extinctionOf(r.visibility) === FOG * r.fogScale);
	}

	// Turning it back down gives the picture back, and the same seed gives the
	// same weather twice.
	{
		const f = new FogField(0xf0f, FOG).setParams({ intensity: 0.8, variability: 0.7 });
		for (let i = 0; i < 1000; i++) f.update(1 / 50);
		f.setParams({ intensity: 0 }).update(1 / 50);
		check('the slider back at zero returns the scene fog exactly',
			f.density === FOG && f.glare === 0 && f.skyMix === 0);

		const a = new FogField(0x2b, FOG).setParams({ intensity: 0.5, variability: 0.9 });
		const b = new FogField(0x2b, FOG).setParams({ intensity: 0.5, variability: 0.9 });
		const trace = (g) => { const out = []; for (let i = 0; i < 1500; i++) { g.update(1 / 50); out.push(g.density); } return out; };
		const first = trace(a), second = trace(b);
		a.reset(); a.setParams({ intensity: 0.5, variability: 0.9 });
		const replay = trace(a);
		check('same seed, same fog; reset returns to the start',
			first.every((v, i) => v === second[i]) && first.every((v, i) => v === replay[i]));
	}

	// The veil and the colour hang off the same log scale as the visibility, so
	// they can never disagree with how far you can actually see.
	{
		const thin = new FogField(21, FOG).setParams({ intensity: 0.2, variability: 0 }).update(1 / 50);
		const thick = new FogField(21, FOG).setParams({ intensity: 0.9, variability: 0 }).update(1 / 50);
		check('veil and sky follow the visibility, both bounded',
			thin.glare > 0 && thin.glare < thick.glare && thick.glare <= 1
			&& thin.skyMix < thick.skyMix && thick.skyMix <= 1,
			`glare ${thin.glare.toFixed(2)} -> ${thick.glare.toFixed(2)}, ciel ${thin.skyMix.toFixed(2)} -> ${thick.skyMix.toFixed(2)}`);
	}
}

console.log('\nnuages');
{
	// D5. Un ciel clair doit être le monde tel qu'il était avant que le modèle
	// existe : la même promesse que wind.js fait au calme et fog.js à l'air
	// clair, et ce qui garde un monde neutre neutre.
	{
		const c = new CloudField(7);
		for (let i = 0; i < 1000; i++) c.update(1 / 50);
		let allZero = true;
		for (let agl = 0; agl <= 3000; agl += 25) if (c.extinctionAt(agl) !== 0) allZero = false;
		check('ciel clair : aucun assombrissement, aucune extinction, à aucune altitude',
			c.dim === 1 && c.cover === 0 && allZero, `dim ${c.dim}`);

		// Et il le fait sans tirer un seul nombre aléatoire, donc une session
		// par ciel clair est bit-identique à une session sans modèle de nuages.
		const off = new CloudField(7);
		const armed = new CloudField(7).setParams({ cover: 0.5, variability: 0.8 });
		let untouched = true;
		for (let i = 0; i < 500; i++) {
			off.update(1 / 50); armed.update(1 / 50);
			if (off.dim !== 1 || off.cover !== 0) untouched = false;
		}
		check('et il ne consomme aucune randomness tant qu\'il est éteint', untouched);
	}

	// D2. Le mapping est géométrique, comme celui de fog.js sur la portée : la
	// seule échelle sur laquelle « un peu plus bas » veut dire la même chose à
	// 1200 m et à 150 m.
	{
		check('le mapping va de BASE_CLEAR à BASE_OVERCAST',
			Math.abs(baseFor(0) - BASE_CLEAR) < 1e-9 && Math.abs(baseFor(1) - BASE_OVERCAST) < 1e-9,
			`${Math.round(baseFor(0))} m -> ${Math.round(baseFor(1))} m`);
		check('et il est géométrique, donc la moitié est la moyenne géométrique',
			Math.abs(baseFor(0.5) ** 2 - BASE_CLEAR * BASE_OVERCAST) < 1e-6 * BASE_CLEAR * BASE_OVERCAST,
			`${Math.round(baseFor(0.5))} m`);
		let monotone = true;
		for (let i = 1; i <= 100; i++) if (baseFor(i / 100) >= baseFor((i - 1) / 100)) monotone = false;
		check('le plafond ne fait que descendre quand la couverture monte', monotone);
	}

	// D1, la décision de conception que ce plan doit protéger : le plafond n'est
	// atteignable QUE par mauvais temps. Un ciel épars a une base hors de portée
	// d'un vol normal ; un ciel bouché en a une qu'on touche.
	{
		const scattered = baseFor(0.3), overcast = baseFor(0.92);
		check('un ciel épars a un plafond hors d\'atteinte (> 500 m)', scattered > 500,
			`${Math.round(scattered)} m`);
		check('un ciel bouché a un plafond atteignable (< 250 m)', overcast < 250,
			`${Math.round(overcast)} m`);
	}

	// Le whiteout. Nul loin sous la base, il mord en approche, sature dans la
	// couche, et se rouvre au-dessus — c'est la récompense de D1.
	{
		const c = new CloudField(11).setParams({ cover: 1, variability: 0 }).update(1 / 50);
		const base = c.base;
		const inside = c.extinctionAt(base + DECK_THICKNESS * 0.5);
		check('rien à voir loin sous la base', c.extinctionAt(base * 0.25) === 0);
		check('ça mord dans la couche', inside > 0.05, inside.toFixed(4));
		check('l\'approche est plus douce que l\'intérieur',
			c.extinctionAt(base - 30) > 0 && c.extinctionAt(base - 30) < inside);
		check('et on ressort au-dessus de la couche',
			c.extinctionAt(base + DECK_THICKNESS * 3) === 0);

		// Amplitude proportionnelle à la couverture, pas un seuil binaire.
		const light = new CloudField(11).setParams({ cover: 0.3, variability: 0 }).update(1 / 50);
		check('une couverture faible donne une laiteuse, pas un whiteout',
			light.extinctionAt(light.base + DECK_THICKNESS * 0.5) < inside * 0.5);
	}

	// D0. L'assombrissement est un scalaire, borné par DIM_MAX, monotone.
	{
		const full = new CloudField(13).setParams({ cover: 1, variability: 0 }).update(1 / 50);
		check('couvert plein : l\'assombrissement atteint DIM_MAX',
			Math.abs(full.dim - DIM_MAX) < 1e-9, full.dim.toFixed(3));
		let monotone = true, prev = 1;
		for (let i = 1; i <= 100; i++) {
			const f = new CloudField(13).setParams({ cover: i / 100, variability: 0 }).update(1 / 50);
			if (f.dim > prev) monotone = false;
			prev = f.dim;
		}
		check('et il ne fait que s\'assombrir quand la couverture monte', monotone);
		check('il n\'assombrit jamais au point de rendre l\'image illisible', DIM_MAX > 0.5, `${DIM_MAX}`);
	}

	// D3. La respiration ne doit pas être un épaississement : même correction
	// lognormale que rain.js et fog.js, et la même raison de la vérifier — la
	// moyenne est ce que le monde a annoncé.
	{
		const still = new CloudField(17).setParams({ cover: 0.6, variability: 0 });
		let flat = true;
		for (let i = 0; i < 2000; i++) { still.update(1 / 50); if (Math.abs(still.cover - 0.6) > 1e-12) flat = false; }
		check('pas de variabilité, pas de respiration', flat);

		// Mis en commun sur douze graines, sondé à 0,3 et pas à 0,5 : ce n'est
		// pas une commodité, c'est la seule région où la propriété testée
		// existe. À k = VAR_GAIN·variability = 0,5, clamp01 tronque la queue
		// haute de la lognormale 5 % du temps à cover = 0,5 (contre 0,4 % à
		// cover = 0,3) — la moyenne y est mécaniquement tirée vers le bas par
		// construction, pas par un défaut du modèle (cf. le check suivant, qui
		// verrouille explicitement cette troncature). La bande lente a une
		// mémoire de dix minutes, donc chaque graine de 600000 pas à 1/50 s
		// (12000 s, ~20 constantes de temps) ne fait qu'une poignée
		// d'échantillons indépendants ; l'erreur type reste de l'ordre de 0,01
		// même mise en commun sur douze graines, d'où une tolérance à 0,03
		// (~3 sigma) plutôt que 0,02 — ce n'est pas du remplissage, c'est ce
		// qu'il faut pour que la mesure veuille dire quelque chose.
		let sum = 0, n = 0;
		for (const seed of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
			const f = new CloudField(seed).setParams({ cover: 0.3, variability: 1 });
			for (let i = 0; i < 600000; i++) { f.update(1 / 50); sum += f.cover; n++; }
		}
		const mean = sum / n;
		check('la respiration ne biaise pas la couverture moyenne',
			Math.abs(mean - 0.3) < 0.03, `moyenne ${mean.toFixed(4)} pour 0.3`);

		// Et près du couvert plein, la moyenne DOIT être tirée vers le bas : le
		// clamp tronque la queue haute, parce qu'on n'est pas « plus que
		// couvert ». C'est de l'atmosphère, pas un défaut — on le verrouille
		// ici pour que personne ne « corrige » le modèle un jour en croyant
		// bien faire.
		let high = 0, hn = 0;
		for (const seed of [31, 37, 41]) {
			const f = new CloudField(seed).setParams({ cover: 0.95, variability: 1 });
			for (let i = 0; i < 300000; i++) { f.update(1 / 50); high += f.cover; hn++; }
		}
		check('près du couvert plein, le clamp tire la moyenne vers le bas',
			high / hn < 0.95, `moyenne ${(high / hn).toFixed(4)} pour 0.95`);
	}

	// Déterminisme : un respawn ne doit pas retomber au milieu du grain en
	// cours, et les checks doivent être stables plutôt que seulement plausibles.
	{
		const a = new CloudField(19).setParams({ cover: 0.7, variability: 0.6 });
		const b = new CloudField(19).setParams({ cover: 0.7, variability: 0.6 });
		let same = true;
		for (let i = 0; i < 400; i++) { a.update(1 / 50); b.update(1 / 50); if (a.cover !== b.cover) same = false; }
		a.reset(); b.reset();
		for (let i = 0; i < 400; i++) { a.update(1 / 50); b.update(1 / 50); if (a.cover !== b.cover) same = false; }
		check('même graine, même trajectoire, avant et après reset()', same);
	}

	// La couverture est une fraction : elle ne peut pas sortir de [0, 1], quelle
	// que soit la violence de la respiration.
	{
		const f = new CloudField(23).setParams({ cover: 0.95, variability: 1 });
		let inRange = true;
		for (let i = 0; i < 50000; i++) { f.update(1 / 50); if (f.cover < 0 || f.cover > 1) inRange = false; }
		check('la couverture reste une fraction, quoi qu\'il arrive', inRange);
	}

	// Le canal était déjà produit et déjà assaini ; cette partie ne fait que le
	// router. Ce qui se teste est donc le routage, pas la météo.
	{
		const clear = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 0, visibilityM: 60000 }));
		check('un ciel à 0 % donne une couverture exactement nulle', clear.cloud.cover === 0);

		const shut = toSimParams(sanitize({ cloudPct: 100, windSpeed: 0, rateMmH: 0, visibilityM: 60000 }));
		check('un ciel à 100 % donne une couverture pleine', shut.cloud.cover === 1);

		// La garde-fou de sanitize() qui existait déjà et que personne ne
		// consommait : il ne pleut pas sous un ciel bleu. Maintenant qu'on le
		// consomme, on le vérifie.
		const wet = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 4, visibilityM: 60000 }));
		check('il ne peut pas pleuvoir sous un ciel dégagé', wet.cloud.cover >= 0.7,
			wet.cloud.cover.toFixed(2));

		// Et l'autre : un ciel bouché n'est pas dégagé.
		const foggy = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 0, visibilityM: 400 }));
		check('un brouillard épais implique un ciel couvert', foggy.cloud.cover >= 0.6,
			foggy.cloud.cover.toFixed(2));

		// Un ciel épars s'agite, un couvercle d'overcast ne bouge presque plus.
		check('un ciel épars respire plus qu\'un couvercle',
			toSimParams(sanitize({ cloudPct: 30 })).cloud.variability
			> toSimParams(sanitize({ cloudPct: 95 })).cloud.variability);

		// Le monde neutre que selftest.mjs suppose doit rester neutre.
		check('CALM est un ciel parfaitement dégagé', CALM_WEATHER.cloud.cover === 0);
		const calmField = new CloudField(29).setParams(CALM_WEATHER.cloud);
		for (let i = 0; i < 200; i++) calmField.update(1 / 50);
		check('et un CloudField nourri par CALM n\'assombrit rien',
			calmField.dim === 1 && calmField.extinctionAt(150) === 0);
	}

	// D5 côté rendu : un matériau de tuile qu'on vient de créer n'assombrit
	// rien. Three tourne en node tant qu'on n'ouvre pas de contexte WebGL, donc
	// ce défaut-là se vérifie ici et pas seulement à l'œil dans le navigateur.
	{
		const m = createTileMaterial(null, 0x9fb8cc, 0.00085);
		check('un matériau de tuile neuf n\'assombrit rien', m.uniforms.uDim.value === 1);
		m.dispose();
	}

	// D5, l'invariant reformulé : le zénith gagne de la profondeur, mais la
	// couleur d'HORIZON par ciel clair reste exactement celle que la scène
	// utilisait avant qu'il y ait un ciel. C'est elle que setFog() pousse sur
	// les tuiles, donc c'est elle qui décide si la ligne d'horizon se dédouble.
	{
		const { CLEAR_HORIZON, CLEAR_ZENITH, OVERCAST_HORIZON } = await import('../src/sky.js');
		check('l\'horizon par ciel clair est exactement le SKY historique',
			CLEAR_HORIZON === 0x9fb8cc, `0x${CLEAR_HORIZON.toString(16)}`);
		// Un ciel clair est plus profond au zénith qu'à l'horizon : c'est de la
		// diffusion, pas un choix graphique. Garder le dégradé plat aurait été
		// le seul cas où le rendu serait faux.
		const lum = (h) => ((h >> 16 & 255) * 0.2126 + (h >> 8 & 255) * 0.7152 + (h & 255) * 0.0722);
		check('et le zénith clair est plus profond que son horizon',
			lum(CLEAR_ZENITH) < lum(CLEAR_HORIZON));
		check('un ciel couvert est plus terne qu\'un ciel clair',
			lum(OVERCAST_HORIZON) < lum(CLEAR_HORIZON));
	}
}

console.log('\ntextures');
// The UV convention is the one thing here a screenshot reads as merely "a bit
// odd": OBJ puts the V origin at the bottom-left, DataArrayTexture at the top.
// Both checks below failed hard before prep.mjs started converting it.
{
	const tileDir = manifest.source;
	const mtlPath = tileDir ? path.join(tileDir, 'exp_model.mtl') : null;
	if (!mtlPath || !fs.existsSync(mtlPath)) {
		console.log(`  SKIP  needs the source tile — ${mtlPath ?? 'no manifest.source'} is not on disk`);
	} else {
		const sharp = (await import('sharp')).default;

		// Declaration order in the MTL is the layer order prep.mjs assigns.
		const jpgs = [];
		for (const line of fs.readFileSync(mtlPath, 'latin1').split('\n')) {
			const t = line.trim();
			if (t.startsWith('newmtl ')) jpgs.push(null);
			else if (t.startsWith('map_Kd ') && jpgs.length) jpgs[jpgs.length - 1] = t.slice(7).trim();
		}

		const chunk = manifest.chunks[0];
		const g = fs.readFileSync(path.join(sceneDir, chunk.geo));
		const gv = g.readUInt32LE(8), gi = g.readUInt32LE(12), layerBase = g.readUInt32LE(16);
		let o = 32;
		const pos = new Float32Array(g.buffer, g.byteOffset + o, gv * 3); o += gv * 12;
		const uv = new Float32Array(g.buffer, g.byteOffset + o, gv * 2); o += gv * 8;
		const lay = new Uint16Array(g.buffer, g.byteOffset + o, gv); o += (gv * 2 + 3) & ~3;
		const ind = new Uint32Array(g.buffer, g.byteOffset + o, gi);

		// A contiguous block of layers: neighbouring indices are neighbours on the
		// ground, which is what gives the seam check something to compare.
		const SAMPLED = Math.min(80, chunk.layerCount);
		const tex = new Map();
		for (let l = 0; l < SAMPLED; l++) {
			const img = sharp(path.join(tileDir, jpgs[layerBase + l]));
			const { width, height } = await img.metadata();
			tex.set(l, { data: await img.removeAlpha().raw().toBuffer(), w: width, h: height });
		}
		// prep.mjs bakes V top-origin, matching DataArrayTexture's flipY = false,
		// so the stored UV indexes the source JPEG's rows directly.
		const sample = (l, u, v) => {
			const t = tex.get(l);
			const x = Math.min(t.w - 1, Math.max(0, Math.round(u * (t.w - 1))));
			const y = Math.min(t.h - 1, Math.max(0, Math.round(v * (t.h - 1))));
			const i = (y * t.w + x) * 3;
			return [t.data[i], t.data[i + 1], t.data[i + 2]];
		};

		// Two materials meeting at one world point must agree on the colour there.
		// Measured 14.8 with V converted, 42.4 with it left as the OBJ wrote it.
		const byPos = new Map();
		for (let i = 0; i < gv; i++) {
			if (lay[i] >= SAMPLED) continue;
			const k = `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`;
			let a = byPos.get(k); if (!a) { a = []; byPos.set(k, a); } a.push(i);
		}
		let diff = 0, pairs = 0;
		for (const a of byPos.values()) {
			for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) {
				if (lay[a[x]] === lay[a[y]]) continue;
				const p = sample(lay[a[x]], uv[a[x] * 2], uv[a[x] * 2 + 1]);
				const q = sample(lay[a[y]], uv[a[y] * 2], uv[a[y] * 2 + 1]);
				diff += (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
				pairs++;
			}
		}
		const meanDiff = pairs ? diff / pairs : Infinity;
		check('neighbouring materials agree where they meet (UV convention)',
			pairs > 200 && meanDiff < 25,
			`${meanDiff.toFixed(1)} mean |dRGB| over ${pairs} shared vertices`);

		// Flyover pads the unused part of every patch with flat grey 128. Any real
		// quantity of it on screen means the UVs are landing in that padding.
		let grey = 0, area = 0;
		for (let t = 0; t < gi; t += 3) {
			const a = ind[t], b = ind[t + 1], c = ind[t + 2];
			if (lay[a] >= SAMPLED) continue;
			const ex = pos[b * 3] - pos[a * 3], ey = pos[b * 3 + 1] - pos[a * 3 + 1], ez = pos[b * 3 + 2] - pos[a * 3 + 2];
			const fx = pos[c * 3] - pos[a * 3], fy = pos[c * 3 + 1] - pos[a * 3 + 1], fz = pos[c * 3 + 2] - pos[a * 3 + 2];
			const w = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) / 4;
			for (let s = 0; s < 4; s++) {
				let r1 = Math.random(), r2 = Math.random();
				if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
				const u = uv[a * 2] + r1 * (uv[b * 2] - uv[a * 2]) + r2 * (uv[c * 2] - uv[a * 2]);
				const v = uv[a * 2 + 1] + r1 * (uv[b * 2 + 1] - uv[a * 2 + 1]) + r2 * (uv[c * 2 + 1] - uv[a * 2 + 1]);
				const [r, gg, bl] = sample(lay[a], u, v);
				area += w;
				if (Math.max(r, gg, bl) - Math.min(r, gg, bl) <= 6 && Math.abs((r + gg + bl) / 3 - 128) <= 8) grey += w;
			}
		}
		const greyPct = 100 * grey / area;
		check('visible surface is not sampling the grey padding', greyPct < 5,
			`${greyPct.toFixed(1)}% grey over ${area.toFixed(0)} m² sampled`);
	}
}

console.log('\ncaméra de cible');
{
	const A = targetCamera({ seed: 'alpha', family: 'freestyle5' });
	const A2 = targetCamera({ seed: 'alpha', family: 'freestyle5' });
	check('même graine, même fiche', JSON.stringify(A) === JSON.stringify(A2));

	const B = targetCamera({ seed: 'bravo', family: 'freestyle5' });
	check('deux graines, deux fiches', JSON.stringify(A) !== JSON.stringify(B));

	// 200 tirages par famille : les bornes de la table sont la cohérence
	// promise, donc elles sont vérifiées et pas seulement commentées.
	let inRange = true, sane = true;
	for (const fam of Object.keys(CAMERA_FAMILIES)) {
		const t = CAMERA_FAMILIES[fam];
		for (let i = 0; i < 200; i++) {
			const c = targetCamera({ seed: `${fam}::${i}`, family: fam });
			if (c.fovDeg < t.fovDeg[0] || c.fovDeg > t.fovDeg[1]) inRange = false;
			if (c.uptiltDeg < t.uptiltDeg[0] || c.uptiltDeg > t.uptiltDeg[1]) inRange = false;
			if (c.resScale < t.resScale[0] || c.resScale > t.resScale[1]) inRange = false;
			if (!t.aspects.includes(c.aspectName)) inRange = false;
			if (Math.abs(c.aspect - (c.aspectName === '4:3' ? 4 / 3 : 16 / 9)) > 1e-9) sane = false;
			for (const v of Object.values(c.sensor)) if (!(v >= 0 && v <= 1)) sane = false;
		}
	}
	check('toutes les familles restent dans les bornes de leur table', inRange);
	check('aspect cohérent avec aspectName, capteur borné [0,1]', sane);

	// La cohérence demandée par la DA : une bonne famille n'a jamais une
	// mauvaise caméra, et l'inverse.
	let goodLow = false, badHigh = false;
	for (let i = 0; i < 200; i++) {
		for (const fam of ['cinewhoop', 'heavy5', 'longrange']) {
			if (targetCamera({ seed: `q${i}`, family: fam }).resScale < RES_HIGH) goodLow = true;
		}
		if (targetCamera({ seed: `q${i}`, family: 'toothpick' }).resScale > RES_LOW) badHigh = true;
	}
	check('cinewhoop / heavy5 / longrange : jamais une définition basse', goodLow === false);
	check('toothpick : jamais une définition haute', badHigh === false);

	// Un toothpick est une mauvaise caméra : plus de bruit et plus de halo
	// qu'un cinewhoop, toujours, pas en moyenne.
	let worse = true;
	for (let i = 0; i < 200; i++) {
		const bad = targetCamera({ seed: `w${i}`, family: 'toothpick' }).sensor;
		const good = targetCamera({ seed: `w${i}`, family: 'cinewhoop' }).sensor;
		if (bad.grain <= good.grain || bad.ringing <= good.ringing) worse = false;
	}
	check('toothpick toujours plus bruité et plus halo qu\'un cinewhoop', worse);

	const unknown = targetCamera({ seed: 'x', family: 'inconnue' });
	check('famille inconnue : repli sur freestyle5 plutôt qu\'un plantage', unknown.fovDeg > 0);
}

console.log('\nOSD drone — layout');
{
	const A = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'ANALOG' });
	const A2 = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'ANALOG' });
	check('même graine, même layout', JSON.stringify(A) === JSON.stringify(A2));

	const B = droneOsdLayout({ seed: 'bravo', family: 'freestyle5', mode: 'ANALOG' });
	check('deux cibles, deux layouts', JSON.stringify(A) !== JSON.stringify(B));

	const dig = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'DIGITAL' });
	check('le style suit le mode vidéo de la cible, il ne se tire pas',
		A.style === 'ANALOG' && dig.style === 'DIGITAL');

	// Les grilles ne se recoupent pas : c'est ce qui rend la différence
	// analogique/numérique visible au premier coup d'œil.
	const gridKey = (g) => `${g.cols}x${g.rows}`;
	const analogGrids = new Set(GRIDS.ANALOG.map((g) => `${g[0]}x${g[1]}`));
	const digitalGrids = new Set(GRIDS.DIGITAL.map((g) => `${g[0]}x${g[1]}`));
	let gridsOk = true, boundsOk = true, placedOk = true, noOverlap = true, staplesOk = true;
	let gpsLeak = false, gpsPresent = false;
	let panelOk = true, archetypeOk = true, firmwareOk = true, tintOk = true;
	let noOsdCount = 0, frozenCount = 0, glitchCount = 0, offsetCount = 0, drawn = 0;
	// `col`/`row` sont volontairement exclus de cette signature : ils portent une
	// entropie de placement quasi continue et indépendante du contenu (25
	// largeurs différentes, positions presque libres sur la grille), donc même un
	// contenu figé produirait presque toujours des JSON distincts rien qu'avec le
	// bruit de coordonnées. Ce qui rend un drone « visiblement différent » d'un
	// autre, c'est le style, la grille, la police, les unités, le nom de machine
	// et l'ensemble des éléments affichés — pas où chacun tombe au pixel près.
	const visibleSignatures = new Set(), fieldSets = new Set();

	for (let i = 0; i < 200; i++) {
		for (const mode of ['ANALOG', 'DIGITAL']) {
			const fam = ['freestyle5', 'race5', 'cinewhoop', 'longrange', 'heavy5'][i % 5];
			const l = droneOsdLayout({ seed: `v${i}`, family: fam, mode });
			if (l === null) { noOsdCount++; continue; }        // panne NO_OSD : rien de plus à vérifier
			drawn++;
			if (l.frozenKey) frozenCount++;
			if (l.glitchKey) glitchCount++;
			if (l.offsetCols !== 0 || l.offsetRows !== 0) offsetCount++;
			if (!PANEL_MODES.includes(l.panel)) panelOk = false;
			if (!ARCHETYPES.includes(l.archetype)) archetypeOk = false;
			if (!FIRMWARES.includes(l.firmware)) firmwareOk = false;
			if (l.style === 'DIGITAL' && !DIGITAL_TINTS.includes(l.tint)) tintOk = false;
			if (l.style === 'ANALOG' && l.tint !== '#ffffff') tintOk = false;

			const set = mode === 'ANALOG' ? analogGrids : digitalGrids;
			if (!set.has(gridKey(l.grid))) gridsOk = false;

			const [lo, hi] = DENSITY[mode];
			if (l.elements.length < lo || l.elements.length > hi) boundsOk = false;

			// Occupation de la grille, ligne par ligne.
			const rows = new Map();
			for (const e of l.elements) {
				if (!ELEMENTS.includes(e.key)) placedOk = false;
				const w = ELEMENT_WIDTH[e.key];
				if (e.col < 0 || e.row < 0 || e.row >= l.grid.rows || e.col + w > l.grid.cols) placedOk = false;
				const occupied = rows.get(e.row) ?? [];
				for (const [c0, c1] of occupied) if (e.col < c1 && c0 < e.col + w) noOverlap = false;
				occupied.push([e.col, e.col + w]);
				rows.set(e.row, occupied);
			}

			const keys = l.elements.map((e) => e.key);
			if (!keys.includes('BAT_V')) staplesOk = false;
			if (!keys.includes('TIMER_FLIGHT') && !keys.includes('TIMER_ON')) staplesOk = false;

			visibleSignatures.add(JSON.stringify({
				style: l.style, grid: l.grid, font: l.font, units: l.units,
				craftName: l.craftName, keys: [...keys].sort(),
			}));
			fieldSets.add([...keys].sort().join(','));
		}

		// Les capteurs absents suivent la famille, pas le hasard.
		const tp = droneOsdLayout({ seed: `g${i}`, family: 'toothpick', mode: 'ANALOG' });
		if (tp?.elements.some((e) => GPS_ELEMENTS.includes(e.key))) gpsLeak = true;
		const lr = droneOsdLayout({ seed: `g${i}`, family: 'longrange', mode: 'DIGITAL' });
		if (lr?.elements.some((e) => GPS_ELEMENTS.includes(e.key))) gpsPresent = true;
	}

	check('chaque style reste dans ses grilles, et elles ne se recoupent pas', gridsOk);
	check('la densité reste dans les bornes du style', boundsOk);
	check('tous les éléments sont connus et tiennent dans la grille', placedOk);
	check('jamais deux éléments superposés', noOverlap);
	check('BAT_V et un chronomètre sont toujours là', staplesOk);
	check('toothpick : aucun élément GPS (il n\'en a pas)', gpsLeak === false);
	check('longrange : le GPS apparaît', gpsPresent === true);
	check('modes de panneau, archétypes, firmwares connus', panelOk && archetypeOk && firmwareOk);
	check('teinte : blanc figé en analogique, palette numérique en HD', tintOk);

	// Les pannes (NO_OSD/FROZEN/GLITCH/OFFSET) restent des accidents rares, pas
	// la norme — un plancher ET un plafond, mesurés sur les mêmes 400 tirages.
	const total = drawn + noOsdCount;
	check('NO_OSD reste rare', noOsdCount > 0 && noOsdCount < total * 0.15, `${noOsdCount}/${total}`);
	check('FROZEN reste rare', frozenCount < drawn * 0.15, `${frozenCount}/${drawn}`);
	check('GLITCH reste rare', glitchCount < drawn * 0.20, `${glitchCount}/${drawn}`);
	check('OFFSET reste rare', offsetCount < drawn * 0.15, `${offsetCount}/${drawn}`);

	// « Ce drone est encore différent » : mesuré, pas espéré. Sur les tirages
	// non-NO_OSD (≈380/400), des paliers bas volontairement — c'est un
	// plancher, pas une cible. Le plancher garde une marge honnête (12.5%)
	// plutôt que de coller à la mesure.
	check('la variété est réelle : signatures visibles distinctes (style, grille, police, unités, nom, éléments)', visibleSignatures.size > drawn * 0.875, `${visibleSignatures.size}/${drawn}`);
	check('la variété est réelle : jeux d\'éléments distincts', fieldSets.size > 100, `${fieldSets.size}/${drawn}`);

	let imperial = 0;
	for (let i = 0; i < 400; i++) {
		if (droneOsdLayout({ seed: `u${i}`, family: 'freestyle5', mode: 'ANALOG' })?.units === 'IMPERIAL') imperial++;
	}
	check('les unités impériales existent sans dominer', imperial > 40 && imperial < 200, `${imperial}/400`);
}

console.log('\ncrash threshold');
check('upright/flat rotation uses the flat threshold', crashThreshold({ x: 0, y: 0, z: 0, w: 1 }) === CRASH_IMPULSE_FLAT);
check('nose-down rotation uses the tighter threshold',
	crashThreshold({ x: 0.8, y: 0, z: 0, w: Math.sqrt(1 - 0.8 * 0.8) }) === CRASH_IMPULSE);
check('hoverThrottle(profile, identity) matches the local hoverStick reference',
	Math.abs(hoverThrottle(PROFILE, { x: 0, y: 0, z: 0, w: 1 }) - hoverStick(PROFILE)) < 1e-9);

console.log('\napplyEntryState');
{
	phys.setProfile(QUAD);
	const state = {
		position: { x: 10, y: 50, z: -20 },
		quaternion: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 }, // 45° yaw
		linvel: { x: 3, y: -1, z: 2 },
		angvel: { x: 0, y: 0, z: 1.5 },
	};
	phys.applyEntryState(state);
	const p = phys.position, r = phys.rotation, v = phys.velocity, w = phys.angularVelocity;
	check('position applied', Math.hypot(p.x - state.position.x, p.y - state.position.y, p.z - state.position.z) < 1e-6);
	check('rotation applied', Math.abs(r.w - state.quaternion.w) < 1e-6 && Math.abs(r.z - state.quaternion.z) < 1e-6);
	check('linear velocity applied', Math.hypot(v.x - state.linvel.x, v.y - state.linvel.y, v.z - state.linvel.z) < 1e-6);
	check('angular velocity applied', Math.abs(w.z - state.angvel.z) < 1e-6);
	check('battery reset to full', phys.battery.soc === 1);

	// PHASE 13 — Première seconde de vol : le drone entre déjà en vol, les
	// moteurs ne doivent pas repartir de zéro (props visuellement à l'arrêt,
	// audio silencieux sur la première image malgré une vitesse déjà réelle).
	const cmd = hoverThrottle(phys.profile, state.quaternion);
	const expectedOmega = phys.profile.maxOmega * Math.pow(cmd, phys.profile.rpmCurve);
	check('propulsion primed: omega matches hoverThrottle at the entry quaternion, not zero',
		phys.propulsion.omega.every((w) => Math.abs(w - expectedOmega) < 1e-6),
		`omega=${phys.propulsion.omega.map((x) => x.toFixed(1))}`);
	check('propulsion primed: thrust is nonzero on every motor',
		phys.propulsion.thrust.every((t) => t > 0),
		`thrust=${phys.propulsion.thrust.map((x) => x.toFixed(1))}`);

	phys.reset();
	// Un respawn statique (retour à spawn, à l'identité) reprend aussi déjà en
	// régime plutôt qu'à l'arrêt complet, pour la même raison.
	const cmdReset = hoverThrottle(phys.profile, { x: 0, y: 0, z: 0, w: 1 });
	const expectedOmegaReset = phys.profile.maxOmega * Math.pow(cmdReset, phys.profile.rpmCurve);
	check('reset(): propulsion also primed at hover, not zeroed',
		phys.propulsion.omega.every((w) => Math.abs(w - expectedOmegaReset) < 1e-6),
		`omega=${phys.propulsion.omega.map((x) => x.toFixed(1))}`);
}

console.log('\nentry state — sampleCandidate');
{
	phys.setProfile(QUAD);
	const rand = rngFrom('sample-candidate-check');
	for (const category of CATEGORIES) {
		const c = sampleCandidate(category, manifest, phys, rand);
		check(`${category}: produced a candidate inside the scene bbox`,
			c !== null
			&& c.position.x >= manifest.bbox.min[0] && c.position.x <= manifest.bbox.max[0]
			&& c.position.z >= manifest.bbox.min[2] && c.position.z <= manifest.bbox.max[2]);
		if (!c) continue;
		const ground = phys.groundBelow(c.position.x, c.position.y, c.position.z);
		const agl = ground === null ? null : c.position.y - ground;
		const [loAgl, hiAgl] = RANGES[category].aglM;
		check(`${category}: altitude above ground within its range`,
			agl !== null && agl >= loAgl - 1e-6 && agl <= hiAgl + 1e-6, `agl=${agl?.toFixed(2)}`);
		const speed = Math.hypot(c.linvel.x, c.linvel.y, c.linvel.z);
		const [loSpeed, hiSpeed] = RANGES[category].speedMs;
		check(`${category}: speed within its range`, speed >= loSpeed - 1e-6 && speed <= hiSpeed + 1e-6,
			`${speed.toFixed(1)} m/s`);
		const qLenSq = c.quaternion.x ** 2 + c.quaternion.y ** 2 + c.quaternion.z ** 2 + c.quaternion.w ** 2;
		check(`${category}: quaternion is normalised`, Math.abs(qLenSq - 1) < 1e-6);
	}
	// A candidate sitting exactly on the ground (no clearance) must fail; the
	// same candidate lifted well clear of everything must pass.
	const onFloor = sampleCandidate('COMFORTABLE', manifest, phys, rand);
	const buried = { ...onFloor, position: { ...onFloor.position, y: onFloor.position.y - 1e3 } };
	check('geometrySafe rejects a position far under the terrain', geometrySafe(buried, phys) === false);
	check('geometrySafe accepts a normally-sampled COMFORTABLE candidate', geometrySafe(onFloor, phys) === true);

	// geometrySafe's obstruction-rejection branch needs a real wall ahead to
	// trigger — the tour-eiffel lattice is too thin/sparse to reliably produce
	// one (see physics.js's own note on photogrammetry meshes being a "surface
	// soup" with legitimately-zero span for thin structures). A stub isolates
	// the branch logic from scene geometry.
	const wallStub = {
		groundBelow: () => onFloor.position.y - 5, // plenty of clearance
		obstructionBetween: () => ({ blocked: true, span: 5 }),
	};
	const clipStub = {
		groundBelow: () => onFloor.position.y - 5,
		obstructionBetween: () => ({ blocked: true, span: 0.5 }),
	};
	check('geometrySafe rejects when a real wall (span > 2m) is ahead', geometrySafe(onFloor, wallStub) === false);
	check('geometrySafe accepts a tangential clip (span <= 2m)', geometrySafe(onFloor, clipStub) === true);

	// A HOLY_SHIT candidate close to the ground, pointed straight down, must
	// fail the rollout even though geometrySafe alone might pass it (it only
	// looks at the instant of spawn, not one second of unattended flight).
	const groundUnderFloor = phys.groundBelow(onFloor.position.x, onFloor.position.y, onFloor.position.z);
	const divingIntoGround = {
		category: 'HOLY_SHIT',
		position: { x: onFloor.position.x, y: groundUnderFloor + 3, z: onFloor.position.z },
		quaternion: { x: 0.7071068, y: 0, z: 0, w: 0.7071068 }, // pitched straight down
		linvel: { x: 0, y: -30, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
	check('rolloutSafe rejects a fast dive straight into the ground', rolloutSafe(divingIntoGround, phys) === false);
	check('rolloutSafe accepts a normally-sampled COMFORTABLE candidate', rolloutSafe(onFloor, phys) === true);

	// Acceptance criteria from issue #48: 100 automated draws, none crash
	// unattended, none land under the terrain; category mix close to spec.
	const drawCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
	let anyCrashed = false, anyUnderground = false, anyOutOfRange = false;
	// Le point d'entrée ne doit JAMAIS naître dans la clôture (#139) : un vol
	// qui commence sur « NO COVERAGE » est un vol qu'on n'a pas voulu. Une
	// seule instance, remise à zéro avant chaque test — sans quoi l'hystérésis
	// de zoneOf() ferait dépendre un tirage du précédent.
	const entryFence = new Geofence(manifest.bbox);
	let fenced = null;
	for (let i = 0; i < 100; i++) {
		const entry = generateEntryState({ physics: phys, manifest, seed: `draw-${i}` });
		drawCounts[entry.category]++;
		entryFence.reset();
		entryFence.update(entry.position);
		if (entryFence.out.zone !== GF_NOMINAL && !fenced) {
			fenced = { i, zone: entryFence.out.zone, m: entryFence.out.marginM };
		}
		if (!rolloutSafe(entry, phys)) anyCrashed = true;
		const ground = phys.groundBelow(entry.position.x, entry.position.y, entry.position.z);
		if (ground === null || entry.position.y - ground < 1) anyUnderground = true;
		if (ground !== null) {
			const agl = entry.position.y - ground;
			const speed = Math.hypot(entry.linvel.x, entry.linvel.y, entry.linvel.z);
			const [loAgl, hiAgl] = RANGES[entry.category].aglM;
			const [loSpeed, hiSpeed] = RANGES[entry.category].speedMs;
			if (agl < loAgl - 1e-6 || agl > hiAgl + 1e-6 || speed < loSpeed - 1e-6 || speed > hiSpeed + 1e-6) anyOutOfRange = true;
		}
	}
	check('100 draws: none crash within the grace second when replayed', !anyCrashed);
	check('100 tirages : aucun point d’entrée ne naît dans la clôture (#139)', fenced === null,
		fenced && `tirage ${fenced.i} : ${fenced.zone} à ${fenced.m.toFixed(1)} m`);
	check('100 draws: none spawn under the terrain', !anyUnderground);
	check('100 draws: each returned entry matches its own category\'s AGL/speed range', !anyOutOfRange);
	console.log(`    category mix over 100 draws: ${JSON.stringify(drawCounts)}`);

	// La marge au bord gouverne le TIRAGE, pas le filet de sécurité : on la
	// balaie donc là où elle agit, et large. 10 000 appels à
	// generateEntryState() rejoueraient jusqu'à 20 s de physique à 250 Hz
	// chacun ; sampleCandidate() ne coûte qu'un rayon de sol, et les 100
	// tirages complets ci-dessus couvrent déjà la chaîne de bout en bout.
	{
		const rand = rngFrom('fence-margin');
		let worst = null;
		for (let i = 0; i < 10000 && worst === null; i++) {
			const c = sampleCandidate(CATEGORIES[i % CATEGORIES.length], manifest, phys, rand);
			if (!c) continue;
			entryFence.reset();
			entryFence.update(c.position);
			if (entryFence.out.zone !== GF_NOMINAL) {
				worst = { i, zone: entryFence.out.zone, m: entryFence.out.marginM };
			}
		}
		check('10 000 tirages : aucun candidat ne naît dans la clôture (#139)', worst === null,
			worst && `tirage ${worst.i} : ${worst.zone} à ${worst.m.toFixed(1)} m`);
	}

	const fallback = generateEntryState({ physics: phys, manifest, seed: 'unreachable', maxAttempts: 0 });
	check('maxAttempts=0 falls back to the fixed spawn', fallback.category === 'COMFORTABLE'
		&& fallback.position.x === manifest.spawn.x && fallback.position.y === manifest.spawn.y
		&& fallback.position.z === manifest.spawn.z
		&& fallback.quaternion.w === 1 && fallback.quaternion.x === 0
		&& fallback.linvel.x === 0 && fallback.linvel.y === 0 && fallback.linvel.z === 0
		&& fallback.angvel.x === 0 && fallback.angvel.y === 0 && fallback.angvel.z === 0);

	phys.reset();
}

console.log('\nsoleil — position');
{
	const R2D = 180 / Math.PI;
	// L'obliquité de l'écliptique : ce qui rend les attentes ci-dessous
	// analytiques et non des sorties du code recopiées.
	const OBLIQUITY = 23.44;

	// Balaye une journée UTC minute par minute et rend le maximum d'élévation.
	// C'est le midi solaire, sans avoir à connaître le fuseau du lieu.
	function noon(lat, lon, dayISO) {
		let best = -Infinity, at = null;
		for (let m = 0; m < 1440; m++) {
			const d = new Date(`${dayISO}T00:00:00Z`);
			d.setUTCMinutes(m);
			const p = sunPosition({ lat, lon, date: d });
			if (p.elevation > best) { best = p.elevation; at = d; }
		}
		return { elevationDeg: best * R2D, at };
	}

	const PARIS = { lat: 48.8566, lon: 2.3522 };
	const TOKYO = { lat: 35.6762, lon: 139.6503 };
	const SYDNEY = { lat: -33.8688, lon: 151.2093 };

	// Au solstice, l'élévation méridienne vaut 90° − |latitude − déclinaison|,
	// et la déclinaison vaut ±l'obliquité. Aucune table à consulter.
	const cases = [
		['Paris, solstice d\'été', PARIS, '2026-06-21', 90 - Math.abs(PARIS.lat - OBLIQUITY)],
		['Paris, solstice d\'hiver', PARIS, '2026-12-21', 90 - Math.abs(PARIS.lat + OBLIQUITY)],
		['Tokyo, solstice d\'été', TOKYO, '2026-06-21', 90 - Math.abs(TOKYO.lat - OBLIQUITY)],
		['Sydney, solstice de décembre', SYDNEY, '2026-12-21', 90 - Math.abs(SYDNEY.lat + OBLIQUITY)],
	];
	for (const [label, place, day, expected] of cases) {
		const n = noon(place.lat, place.lon, day);
		check(`${label} : élévation méridienne`, Math.abs(n.elevationDeg - expected) < 0.3,
			`${n.elevationDeg.toFixed(2)}° vs ${expected.toFixed(2)}°`);
	}

	// À l'équinoxe la déclinaison est nulle, donc l'élévation méridienne vaut
	// 90° − latitude quelle que soit la longitude.
	const eq = noon(PARIS.lat, PARIS.lon, '2026-03-20');
	check('Paris, équinoxe : élévation méridienne = 90° − latitude',
		Math.abs(eq.elevationDeg - (90 - PARIS.lat)) < 0.3,
		`${eq.elevationDeg.toFixed(2)}° vs ${(90 - PARIS.lat).toFixed(2)}°`);

	// LE piège de l'issue. Z est le SUD après prep.mjs : au midi solaire dans
	// l'hémisphère nord le soleil est plein sud, donc z > 0 et x ≈ 0. Se
	// tromper de signe ici mettrait silencieusement le soleil dans le mauvais
	// demi-ciel, et rien d'autre ne l'attraperait.
	{
		const p = sunPosition({ lat: PARIS.lat, lon: PARIS.lon, date: eq.at });
		const v = sunVector(p.azimuth, p.elevation);
		check('convention d\'axes : midi solaire au nord ⇒ le soleil est au sud (z > 0)',
			v.z > 0.5 && Math.abs(v.x) < 0.05, `z=${v.z.toFixed(3)} x=${v.x.toFixed(3)}`);
		check('azimut au midi solaire ≈ 180° (plein sud)',
			Math.abs(p.azimuth * R2D - 180) < 1, `${(p.azimuth * R2D).toFixed(2)}°`);
		check('le vecteur solaire est unitaire',
			Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9);
	}
	{
		const n = noon(SYDNEY.lat, SYDNEY.lon, '2026-12-21');
		const p = sunPosition({ lat: SYDNEY.lat, lon: SYDNEY.lon, date: n.at });
		const v = sunVector(p.azimuth, p.elevation);
		check('hémisphère sud : midi solaire ⇒ le soleil est au nord (z < 0)',
			v.z < -0.05, `z=${v.z.toFixed(3)}`);
	}

	// Réfraction : elle relève le soleil, d'environ un demi-degré à l'horizon,
	// et de presque rien au zénith.
	check('la réfraction relève le soleil à l\'horizon d\'environ 0,5°',
		refracted(0) - 0 > 0.4 && refracted(0) - 0 < 0.7, `${(refracted(0)).toFixed(3)}°`);
	check('la réfraction est négligeable au zénith',
		Math.abs(refracted(90) - 90) < 0.01, `${refracted(90).toFixed(4)}°`);

	// Masse d'air : 1 au zénith par définition, ~2 à 30°, et FINIE à l'horizon —
	// c'est tout l'intérêt de Kasten & Young sur 1/sin h, qui y diverge.
	check('masse d\'air = 1 au zénith', Math.abs(airMass(90) - 1) < 0.002, airMass(90).toFixed(4));
	check('masse d\'air ≈ 2 à 30° d\'élévation', Math.abs(airMass(30) - 2) < 0.02, airMass(30).toFixed(3));
	check('masse d\'air finie et < 40 à l\'horizon',
		Number.isFinite(airMass(0)) && airMass(0) > 30 && airMass(0) < 40, airMass(0).toFixed(2));
	check('la masse d\'air croît quand le soleil descend',
		airMass(10) > airMass(30) && airMass(30) > airMass(60));
}

console.log('\nsoleil — atmosphère et couleur du ciel');
{
	const byte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
	const hex = (c) => (byte(c.r) << 16) | (byte(c.g) << 8) | byte(c.b);
	const CLEAR = REF_VIS;

	// LE check de non-régression visuelle. Le modèle mono-diffusion ne retombe
	// pas spontanément sur la couleur que le sim utilise depuis toujours : une
	// balance des blancs constante l'y ramène, et c'est ce qui garantit que ce
	// ticket ne change RIEN dans les conditions où le sim tournait déjà.
	const ref = skyColor(REF_ELEV, CLEAR, 0);
	check('calibrage : soleil haut, ciel clair, sans nuage ⇒ exactement SKY',
		hex(ref) === SKY_REF,
		`#${hex(ref).toString(16).padStart(6, '0')} vs #${SKY_REF.toString(16)}`);
	check('la référence n\'est pas saturée (il reste de la marge en haut)',
		ref.r < 1 && ref.g < 1 && ref.b < 1);

	// Régression du 2e passage de revue : `rel` (le rapport ciel/sol comprimé)
	// est un facteur SCALAIRE, donc un clamp01 par canal après coup était ce
	// qui faisait déraper la teinte — chaque canal saturait à une élévation
	// différente selon sa magnitude de départ. Une élévation de mi-journée
	// d'hiver plausible (17,7°, le zénith de solstice à Paris) et une
	// élévation basse mais franchement diurne (15°) doivent donc encore lire
	// bleu, pas vert : c'est un contrôle en OCTETS, pas en ratio, parce que
	// c'est au niveau de l'octet que le bug se voyait.
	{
		const mid1 = skyColor(17.7, CLEAR, 0), mid2 = skyColor(15, CLEAR, 0);
		check('17,7° (solstice d\'hiver à Paris) : le bleu n\'est pas sous le rouge',
			mid1.b >= mid1.r, `${mid1.r.toFixed(3)} ${mid1.g.toFixed(3)} ${mid1.b.toFixed(3)}`);
		check('15° : le bleu n\'est pas sous le rouge',
			mid2.b >= mid2.r, `${mid2.r.toFixed(3)} ${mid2.g.toFixed(3)} ${mid2.b.toFixed(3)}`);
	}
	{
		const glow = skyColor(5, CLEAR, 0);
		const byte5 = [byte(glow.r), byte(glow.g), byte(glow.b)];
		check('5° : aucun canal ne sature à 0 ni à 255 (pas de clamp dur)',
			byte5.every((v) => v > 0 && v < 255), byte5.join(' '));
	}

	// À midi le ciel est bleu : c'est Rayleigh, et ça doit sortir du modèle et
	// non d'une couleur choisie.
	check('soleil haut : le ciel est bleu (b > g > r)',
		ref.b > ref.g && ref.g > ref.r,
		`${ref.r.toFixed(3)} ${ref.g.toFixed(3)} ${ref.b.toFixed(3)}`);

	// Et au ras de l'horizon il ne l'est plus : la lumière qui atteint le volume
	// diffusant a traversé 30 masses d'air et n'a plus de bleu à donner.
	const low = skyColor(2, CLEAR, 0);
	check('soleil rasant : le ciel bascule au chaud (r > b)', low.r > low.b,
		`${low.r.toFixed(3)} ${low.g.toFixed(3)} ${low.b.toFixed(3)}`);
	check('la bascule est monotone entre 60° et 2°', (() => {
		// La chaleur doit DÉCROÎTRE quand le soleil monte, donc en balayant les
		// élévations croissantes chaque valeur doit être sous la précédente.
		let prev = Infinity, ok = true;
		for (const e of [2, 5, 10, 20, 40, 60]) {
			const c = skyColor(e, CLEAR, 0);
			const warmth = c.r / Math.max(1e-6, c.b);
			if (warmth > prev) ok = false;
			prev = warmth;
		}
		return ok;
	})());

	// Transmittance : le disque rougit parce que le bleu part en premier.
	{
		const high = transmittance(airMass(refracted(60)), CLEAR);
		const graze = transmittance(airMass(refracted(2)), CLEAR);
		check('la transmittance décroît quand le soleil descend', graze[1] < high[1],
			`${graze[1].toFixed(4)} < ${high[1].toFixed(4)}`);
		check('le rougissement croît quand le soleil descend',
			graze[0] / graze[2] > high[0] / high[2],
			`${(graze[0] / graze[2]).toFixed(1)} > ${(high[0] / high[2]).toFixed(2)}`);
		check('la transmittance reste dans 0..1', high.concat(graze).every((v) => v >= 0 && v <= 1));
	}

	// Niveaux : 1 à la référence, décroissants, jamais nuls (le plancher de nuit
	// est ce qui rend la nuit jouable, et il est assumé comme tel).
	check('les niveaux valent 1 à la référence',
		Math.abs(ambientLevel(REF_ELEV, 0) - 1) < 1e-9 && Math.abs(skyLevel(REF_ELEV, 0) - 1) < 1e-9);
	check('l\'ambiance décroît quand le soleil descend',
		ambientLevel(60, 0) > ambientLevel(20, 0) && ambientLevel(20, 0) > ambientLevel(2, 0));
	check('l\'ambiance atteint un plancher sous l\'horizon et n\'y descend plus',
		ambientLevel(-20, 0) === ambientLevel(-40, 0) && ambientLevel(-20, 0) > 0,
		ambientLevel(-20, 0).toFixed(4));
	check('le ciel reste plus lumineux que le sol quand le soleil est bas',
		skyLevel(5, 0) / ambientLevel(5, 0) > 1.5,
		(skyLevel(5, 0) / ambientLevel(5, 0)).toFixed(2));

	// Nuit : le ciel repasse au bleu profond, il n'est ni noir ni orange.
	const night = skyChroma(-20, CLEAR, 0);
	check('nuit pleine : le ciel est bleu, pas orange', night[2] > night[0],
		`${night[0].toFixed(3)} ${night[1].toFixed(3)} ${night[2].toFixed(3)}`);
	check('nuit pleine : le ciel n\'est pas noir', skyLevel(-20, 0) > 0.02);

	// Couplages exigés par l'issue : le soleil ne peut pas contredire le régime
	// météo affiché au joueur.
	const clearDisc = sunDisc(40, CLEAR, 0);
	check('ciel couvert à 100 % : plus de disque du tout', sunDisc(40, CLEAR, 100).amount === 0);
	check('ciel couvert à 40 % (régime CLOUD) : le soleil est atténué sans disparaître', (() => {
		const a = sunDisc(40, CLEAR, 40).amount;
		return a > 0.1 * clearDisc.amount && a < 0.8 * clearDisc.amount;
	})(), `${sunDisc(40, CLEAR, 40).amount.toFixed(3)} vs ${clearDisc.amount.toFixed(3)}`);
	check('brouillard à 500 m : le disque est éteint',
		sunDisc(40, 500, 0).amount < 0.02 * clearDisc.amount,
		sunDisc(40, 500, 0).amount.toExponential(2));
	check('le disque rougit quand le soleil descend', (() => {
		const h = sunDisc(60, CLEAR, 0).color, l = sunDisc(3, CLEAR, 0).color;
		return l.r / Math.max(1e-6, l.b) > h.r / Math.max(1e-6, h.b);
	})());
	check('sous l\'horizon il n\'y a plus de disque', sunDisc(-1, CLEAR, 0).amount === 0);

	// Le brouillard blanchit le ciel : c'est la diffusion multiple, et c'est ce
	// qui empêche le modèle mono-diffusion de rendre un ciel noir dans la purée.
	{
		const c = skyChroma(40, 300, 0);
		const spread = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
		check('purée de pois : le ciel devient neutre, pas noir', spread < 0.05, spread.toFixed(4));
	}

	// Déterminisme : aucun état caché, aucun PRNG. Deux appels identiques
	// rendent la même chose au bit près.
	check('skyColor est pur', (() => {
		const a = skyColor(17, 8000, 33), b = skyColor(17, 8000, 33);
		return a.r === b.r && a.g === b.g && a.b === b.b;
	})());

	// skyColor reste dans 0..1 sur toute une plage de conditions : soleil haut,
	// rasant, nuit pleine, avec couverture nuageuse ou brouillard.
	check('skyColor reste dans 0..1 sur tous les régimes', (() => {
		const testCases = [
			// [élévation, visibilité, couverture nuageuse]
			[60, REF_VIS, 0],     // soleil haut, clair, sans nuage
			[2, REF_VIS, 0],      // soleil rasant, clair (celui qui débordait avant)
			[-20, REF_VIS, 0],    // nuit pleine
			[40, 500, 0],         // brouillard épais
			[20, REF_VIS, 100],   // très couvert
			[5, 500, 80],         // combinaison : brouillard + couverture
		];
		for (const [elev, vis, cloud] of testCases) {
			const c = skyColor(elev, vis, cloud);
			if (!(c.r >= 0 && c.r <= 1 && c.g >= 0 && c.g <= 1 && c.b >= 0 && c.b <= 1)) {
				return false;
			}
		}
		return true;
	})());
}

console.log('\nsoleil — exposition (AGC) et SunField');
{
	const PARIS = { lat: 48.8566, lon: 2.3522 };
	// Un midi d'équinoxe à Paris : soleil haut, ciel clair. C'est le point de
	// calibrage, et le seul instant où le sim doit rendre EXACTEMENT l'image
	// qu'il rendait avant ce ticket.
	const NOON = new Date('2026-06-21T11:52:00Z');
	const MIDNIGHT = new Date('2026-06-21T23:52:00Z');

	const settle = (field, date, sunInFrame, seconds = 20) => {
		for (let t = 0; t < seconds; t += 1 / 60) field.update(1 / 60, { date, sunInFrame });
		return field;
	};

	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('midi d\'été à Paris : le soleil est haut', sun.elevation > 55,
			`${sun.elevation.toFixed(1)}°`);
		check('et au sud : le vecteur pointe vers +Z', sun.dir.z > 0.3, sun.dir.z.toFixed(3));
		check('l\'exposition au repos par ciel clair et soleil haut est ~1',
			Math.abs(sun.exposure - 1) < 0.02, sun.exposure.toFixed(4));
	}

	// L'asymétrie de l'AGC : c'est ELLE, et rien d'autre, qui produit la
	// mécanique que l'issue met en avant — on passe face au soleil, la ville
	// s'éteint, et elle met une seconde à revenir.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		const before = sun.exposure;

		// Fermeture : le soleil entre dans le cadre. On enregistre la trajectoire
		// pour mesurer le temps de mi-course une fois le palier connu — le seuil
		// n'est plus un pourcentage fixe de `before` (le nerf de l'issue #92 a
		// relevé le plancher E_MIN, donc le palier n'est plus assez loin de
		// before/2 pour que ce seuil-là reste un repère fiable).
		const closeTrace = [];
		for (let t = 0; t < 5; t += 1 / 60) {
			sun.update(1 / 60, { date: NOON, sunInFrame: 1 });
			closeTrace.push([t, sun.exposure]);
		}
		const closed = sun.exposure;
		check('le soleil dans le cadre ferme l\'exposition', closed < before * 0.4,
			`${closed.toFixed(3)} vs ${before.toFixed(3)}`);
		const closeMid = (before + closed) / 2;
		const closeTime = (closeTrace.find(([, e]) => e < closeMid) || [])[0] ?? null;
		check('la fermeture est rapide (moins de 0,5 s pour parcourir la moitié du palier)',
			closeTime !== null && closeTime < 0.5, `${closeTime?.toFixed(2)} s`);

		// Réouverture : le soleil sort du cadre.
		const openTrace = [];
		for (let t = 0; t < 10; t += 1 / 60) {
			sun.update(1 / 60, { date: NOON, sunInFrame: 0 });
			openTrace.push([t, sun.exposure]);
		}
		const openMid = (closed + before) / 2;
		const openTime = (openTrace.find(([, e]) => e > openMid) || [])[0] ?? null;
		check('la réouverture est lente (plus de 0,5 s pour parcourir la moitié du palier)',
			openTime !== null && openTime > 0.5, `${openTime?.toFixed(2)} s`);
		check('la caméra ferme nettement plus vite qu\'elle ne rouvre',
			openTime > closeTime * 3, `${openTime?.toFixed(2)} s vs ${closeTime?.toFixed(2)} s`);
		check('et elle finit par revenir là où elle était',
			Math.abs(sun.exposure - before) < 0.02);
	}

	// La nuit sort de l'AGC arrivé en butée, pas d'un facteur « nuit ». Depuis
	// l'issue #111, la caméra est une starlight : sous l'ancienne butée E_MAX,
	// elle passe en régime haut gain — l'image de nuit remonte à une moitié de
	// la luminance de jour, et le prix se paie en grain, via `gain` (0..1) que
	// main.js pousse vers le bloc capteur de lens.js.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, MIDNIGHT, 0, 60);
		check('minuit : le soleil est sous l\'horizon', sun.elevation < 0,
			`${sun.elevation.toFixed(1)}°`);
		check('minuit : le disque est éteint', sun.sunAmount === 0);
		check('nuit pleine : l\'image est pilotable (45 à 60 % du jour)',
			sun.exposure > 0.45 && sun.exposure < 0.60, sun.exposure.toFixed(3));
		check('nuit pleine : le haut gain est à fond', sun.gain > 0.8,
			sun.gain.toFixed(3));
		check('nuit pleine : le ciel reste bleu', sun.sky.b > sun.sky.r,
			`${sun.sky.r.toFixed(3)} ${sun.sky.g.toFixed(3)} ${sun.sky.b.toFixed(3)}`);
	}

	// La profondeur de nuit (#112) : le même seuil crépusculaire que skyChroma,
	// exposé pour que TileMaterial (uNight) et le halo du dôme ne réinventent
	// pas un deuxième crépuscule qui contredirait le ciel.
	{
		check('jour plein : nightAmount vaut 0', nightAmount(30) === 0);
		check('nuit pleine : nightAmount vaut 1', nightAmount(-17.7) === 1);
		check('le crépuscule est entre les deux',
			nightAmount(-8) > 0 && nightAmount(-8) < 1, nightAmount(-8).toFixed(3));
		let prevN = -1, monoN = true;
		for (let e = 10; e >= -20; e -= 1) {
			const n = nightAmount(e);
			if (n < 0 || n > 1 || n < prevN - 1e-9) monoN = false;
			prevN = n;
		}
		check('nightAmount monte de façon monotone quand le soleil descend', monoN);
		check('et SunField la porte : nuit pleine', (() => {
			const s = new SunField(PARIS);
			s.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
			settle(s, MIDNIGHT, 0, 60);
			return s.night === 1;
		})());
	}

	// La nuit NOIRE (#112, retour de vol) : le ciel du soir descend, tient un
	// plateau toute la nuit astronomique, et remonte à l'aube. La courbe est
	// nightAmount() sur l'élévation solaire — pas une horloge : le plateau EST
	// la nuit pleine, et sa longueur suit la saison toute seule. skyNightDim()
	// la traduit en luminosité de dôme : 1 le jour, quasi noir sur le plateau.
	{
		const at = (iso) => {
			const s = new SunField(PARIS);
			s.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
			settle(s, new Date(iso), 0, 30);
			return s;
		};
		check('en soirée, le ciel descend : 21h30Z plus sombre que 20h30Z',
			skyNightDim(at('2026-06-21T21:30:00Z').night)
			< skyNightDim(at('2026-06-21T20:30:00Z').night));
		// Le plateau : au cœur de la nuit, la luminosité ne bouge plus.
		const plateau = ['22:45', '23:52', '01:00'].map(
			(t) => skyNightDim(at(`2026-06-21T${t}:00Z`).night));
		check('le plateau tient sur le cœur de la nuit',
			Math.max(...plateau) - Math.min(...plateau) < 0.01,
			plateau.map((d) => d.toFixed(3)).join(' '));
		check('et il est quasi noir (moins de 8 % du jour)',
			Math.max(...plateau) < 0.08, Math.max(...plateau).toFixed(3));
		// L'aube : ça remonte, jusqu'à revenir exactement à 1 en plein jour.
		check('à l\'aube, le ciel remonte',
			skyNightDim(at('2026-06-22T03:40:00Z').night) > Math.max(...plateau));
		check('et le jour plein revient à exactement 1',
			skyNightDim(at('2026-06-22T11:52:00Z').night) === 1);
	}

	// La traduction du haut gain en capteur : c'est elle que main.js pousse
	// vers lens.setSensor(). À gain nul elle rend le capteur de la cible tel
	// quel (l'appel par frame ne change alors rien du tout) ; à gain plein le
	// grain domine n'importe quel mauvais capteur, les noirs montent, la
	// couleur s'en va en partie — le look starlight.
	{
		const base = { grain: 0.03, lift: 0.02, saturation: 0.9, ringing: 0.5,
			clip: 0.4, tintHue: 0.3, tintAmount: 0.1, crossColor: 0.7 };
		const same = nightSensor(0, base);
		check('gain nul : le capteur de la cible passe tel quel',
			Object.keys(base).every((k) => same[k] === base[k]));
		const full = nightSensor(1, base);
		check('gain plein : le grain domine un mauvais capteur (> 0,10)',
			full.grain > 0.10, full.grain.toFixed(3));
		check('gain plein : les noirs montent', full.lift > base.lift,
			full.lift.toFixed(3));
		check('gain plein : la couleur s\'éteint en partie mais pas toute',
			full.saturation < base.saturation && full.saturation > 0.3,
			full.saturation.toFixed(3));
		check('le reste du capteur n\'est pas touché',
			full.ringing === base.ringing && full.clip === base.clip
			&& full.tintHue === base.tintHue && full.tintAmount === base.tintAmount
			&& full.crossColor === base.crossColor);
		check('sans capteur de base, le profil nuit tient seul',
			nightSensor(1).grain > 0.10 && nightSensor(0).saturation === 1);
	}

	// Le haut gain est un régime de NUIT : nul en plein jour, et il monte de
	// façon monotone pendant que le soir tombe — pas de pompage de grain.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('midi : aucun haut gain, donc aucun grain', sun.gain === 0,
			sun.gain.toFixed(3));

		// Le soir du solstice à Paris, du soleil encore levé à la nuit pleine.
		const dusk = ['19:00', '20:30', '21:30', '22:30', '23:52'].map(
			(t) => new Date(`2026-06-21T${t}:00Z`));
		let prev = -1, monotone = true;
		const gains = [];
		for (const date of dusk) {
			const s = new SunField(PARIS);
			s.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
			settle(s, date, 0, 60);
			gains.push(s.gain);
			if (s.gain < prev - 1e-9) monotone = false;
			prev = s.gain;
		}
		check('le haut gain monte de façon monotone au crépuscule', monotone,
			gains.map((g) => g.toFixed(2)).join(' → '));
	}

	// dt = 0 fige le modèle. Même règle que setRain() dans lens.js : il n'y a
	// pas d'horloge interne qu'on pourrait oublier d'arrêter (#24).
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		const held = sun.exposure;
		for (let i = 0; i < 100; i++) sun.update(0, { date: NOON, sunInFrame: 1 });
		check('dt = 0 fige l\'AGC', sun.exposure === held);
	}

	// L'exposition reste bornée quoi qu'on lui envoie : elle multiplie l'image
	// entière, un débordement serait un écran blanc.
	{
		const sun = new SunField(PARIS);
		let outOfRange = 0;
		for (const cloud of [0, 50, 100]) {
			for (const vis of [200, 5000, 25000]) {
				sun.setWeather({ cloudPct: cloud, visibilityM: vis });
				for (const h of [0, 6, 12, 18]) {
					const d = new Date(`2026-06-21T${String(h).padStart(2, '0')}:00:00Z`);
					for (const f of [0, 0.3, 1]) {
						settle(sun, d, f, 5);
						if (!(sun.exposure > 0) || sun.exposure > E_MAX) outOfRange++;
					}
				}
			}
		}
		check('l\'exposition reste bornée sur toute la combinatoire', outOfRange === 0,
			`${outOfRange} débordement(s)`);
	}

	// Le no-op. Attention à ce qui est testé ici : `active` dit « le soleil
	// change quelque chose à l'image », et il est VRAI dès que le soleil est
	// levé, caméra ou pas — SunField ne connaît pas la caméra. Le vrai test de
	// no-op du shader vit dans lens.setSun(), qui seul sait si le soleil est
	// devant l'objectif.
	//
	// Ce qui doit être exact ici, c'est le calibrage de l'exposition : par ciel
	// clair, soleil haut et hors cadre, le gain vaut 1 et l'image est celle que
	// le sim rendait avant ce ticket.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('calibrage : soleil haut, ciel clair, hors cadre ⇒ gain exactement 1',
			sun.exposure === 1, sun.exposure.toFixed(6));
		check('mais il y a bien un soleil dans le ciel', sun.sunAmount > 0.5,
			sun.sunAmount.toFixed(3));

		// Le seul cas où le bloc est vraiment un no-op : plus de disque du tout,
		// et un gain encore à 1.
		sun.setWeather({ cloudPct: 100, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('couvert total, soleil haut : le bloc est un no-op',
			sun.active === false, `expo=${sun.exposure.toFixed(4)} amount=${sun.sunAmount}`);

		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, MIDNIGHT, 0, 60);
		check('la nuit, le bloc reste actif (sinon la nuit ne s\'assombrirait pas)',
			sun.active === true && sun.sunAmount === 0);
	}

	// Sans coordonnées, pas de soleil inventé.
	check('une zone sans lat/lon ne construit pas de soleil',
		SunField.forOrigin({}) === null && SunField.forOrigin({ latitude: 1, longitude: 2 }) !== null);
}

console.log('\nsoleil — traduction depuis le bulletin');
{
	// La couverture passe telle quelle : c'est déjà la grandeur que sun.js veut.
	const overcast = toSimParams(sanitize({
		windSpeed: 2, windGust: 3, windDir: 180, rateMmH: 0, visibilityM: 20000, cloudPct: 95,
	}));
	check('la couverture nuageuse arrive jusqu\'au soleil', overcast.sun.cloudPct === 95,
		String(overcast.sun.cloudPct));

	// LA règle : la visibilité passée au soleil est celle de l'air HORS pluie,
	// exactement celle que fog.js reçoit. Sinon la même averse compterait deux
	// fois — une fois dans le brouillard, une fois dans l'extinction du disque.
	const rainy = toSimParams(sanitize({
		windSpeed: 4, windGust: 6, windDir: 200, rateMmH: 6, precipMm: 12,
		visibilityM: 3000, cloudPct: 90,
	}));
	// L'air seul voit plus loin que l'air + la pluie : si les deux sont égaux,
	// c'est que l'averse a été comptée deux fois.
	const rainyTotal = sanitize({
		windSpeed: 4, windGust: 6, windDir: 200, rateMmH: 6, precipMm: 12,
		visibilityM: 3000, cloudPct: 90,
	}).visibilityM;
	check('sous la pluie, le soleil reçoit la visibilité de l\'air, meilleure que la totale',
		rainy.sun.visibilityM > rainyTotal * 1.05,
		`air ${Math.round(rainy.sun.visibilityM)} m vs totale ${Math.round(rainyTotal)} m`);
	check('la visibilité transmise est finie et positive',
		Number.isFinite(rainy.sun.visibilityM) && rainy.sun.visibilityM > 0);

	// Le brouillard, lui, arrive bien jusqu'au soleil.
	const foggy = toSimParams(sanitize({
		windSpeed: 1, windGust: 1, windDir: 0, rateMmH: 0, visibilityM: 400, cloudPct: 80,
	}));
	check('un vrai brouillard réduit la visibilité vue par le soleil',
		foggy.sun.visibilityM < 1000, `${Math.round(foggy.sun.visibilityM)} m`);
}

// Ce qui n'a pas été exercé se dit : un test sauté en silence se lit comme un
// test réussi, et c'est précisément ce qui rendait ce banc trompeur ailleurs
// que sur la Tour Eiffel.
if (skipped.length) {
	console.log(`\n${skipped.length} check(s) skipped — not the reference scene:`);
	for (const label of skipped) console.log(`  SKIP  ${label}`);
}
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
