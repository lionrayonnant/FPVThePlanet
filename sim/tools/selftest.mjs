// Headless checks on the generated scene: geodesy, ground queries, flight
// envelope, and the collision behaviour the sim depends on.
//
//   node tools/selftest.mjs [sceneDir]

import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics, MAX_THRUST, QUAD } from '../src/physics.js';
import { FlightController, RATE_PRESETS } from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { VideoLink } from '../src/link.js';
import { WindField, mulberry32, shearFactor, turbulenceIntensity, PROBE_COUNT, PROBE_RANGE } from '../src/wind.js';
import { RainField, dropDrift, fogRange, lensDrops, dropFootprint, LensDrops, MAX_RATE, GRAVITY } from '../src/rain.js';
import { FogField, FOG_PRESETS, rangeFor, extinctionOf, RANGE_MIN } from '../src/fog.js';
import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT } from '../src/quad.js';

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
	for (let i = 0; i < Math.round(seconds * 250); i++) {
		const s = typeof sticks === 'function' ? sticks(i * STEP) : sticks;
		const { motors } = fc.update(s, phys, STEP);
		maxImpact = Math.max(maxImpact, phys.step(motors, STEP));
		const a = phys.angularVelocity;
		peakSpin = Math.max(peakSpin, Math.hypot(a.x, a.y, a.z) * 180 / Math.PI);
	}
	const p = phys.position, v = phys.velocity, w = phys.angularVelocity;
	return { p, v, w, peakSpin, battery: phys.battery,
		speed: Math.hypot(v.x, v.y, v.z), spin: Math.hypot(w.x, w.y, w.z) * 180 / Math.PI, maxImpact };
}

console.log(`scene: ${sceneDir}`);
console.log(`origin ${manifest.origin.latitude.toFixed(5)}, ${manifest.origin.longitude.toFixed(5)}`);

console.log('\ngeometry & geodesy');
const size = manifest.bbox.max.map((v, i) => v - manifest.bbox.min[i]);
check('tile is roughly 1.2km square', size[0] > 1000 && size[0] < 1600 && size[2] > 1000 && size[2] < 1600,
	`${size[0].toFixed(0)} x ${size[2].toFixed(0)} m`);
check('origin is the Eiffel Tower area', Math.abs(manifest.origin.latitude - 48.8583) < 0.01 && Math.abs(manifest.origin.longitude - 2.297) < 0.01);

// The tallest structure in this tile is the tower; ~300m above local ground.
let top = -Infinity, tx = 0, tz = 0;
for (let i = 0; i < vc; i++) {
	const y = collision.vertices[i * 3 + 1];
	if (y > top) { top = y; tx = collision.vertices[i * 3]; tz = collision.vertices[i * 3 + 2]; }
}
const groundNearTower = phys.groundBelow(tx + 120, 350, tz + 120);
const towerHeight = top - groundNearTower;
check('Eiffel Tower is ~300m tall', towerHeight > 270 && towerHeight < 350, `${towerHeight.toFixed(0)} m`);

console.log('\nground queries');
check('ray finds ground at spawn', phys.groundBelow(manifest.spawn.x, 350, manifest.spawn.z) !== null);
check('ray finds the tower structure', (phys.groundBelow(tx, 350, tz) ?? 0) > 200,
	`${(phys.groundBelow(tx, 350, tz) ?? 0).toFixed(0)} m`);
let misses = 0, samples = 0;
for (let x = -600; x <= 600; x += 100) for (let z = -600; z <= 600; z += 100) {
	samples++; if (phys.groundBelow(x, 350, z) === null) misses++;
}
check('ground coverage across the tile', misses === 0, `${samples - misses}/${samples} hits`);

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
	const commanded = RATE_PRESETS[fc.preset].roll.max;
	const roll = simulate({ seconds: 1.2, at: [0, 150, 300],
		sticks: (t) => ({ throttle: HOVER, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
	check(`[${fam}] reaches the commanded roll rate (${commanded} deg/s)`,
		roll.spin > commanded * 0.9 && roll.peakSpin < commanded * 1.25,
		`${roll.spin.toFixed(0)} deg/s held, ${roll.peakSpin.toFixed(0)} peak`);

	check(`[${fam}] hovers at a plausible stick position`, HOVER > 0.15 && HOVER < 0.62, `${(HOVER * 100).toFixed(0)}% throttle`);

	// Airmode: the flick still produces the rate with the throttle shut.
	const rollIdle = simulate({ seconds: 1.2, at: [0, 200, 300],
		sticks: (t) => ({ throttle: 0, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
	check(`[${fam}] airmode keeps roll authority at zero throttle`,
		rollIdle.spin > commanded * 0.85,
		`${rollIdle.spin.toFixed(0)} deg/s vs ${roll.spin.toFixed(0)} at hover`);

	// Yaw has the least torque authority of the three axes (it fights prop-drag
	// torque, a fraction of thrust) against the most inertia, so it must build
	// rate visibly slower than pitch. Sampled 80 ms in, before either arrives.
	const SAMPLE_AT = 0.15 + 0.08;
	const yawRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
		sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: 0, yaw: t > 0.15 ? 1 : 0 }) });
	const pitchRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
		sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: t > 0.15 ? 1 : 0, yaw: 0 }) });
	const yawFrac = Math.abs(yawRun.w.y * 180 / Math.PI) / RATE_PRESETS[fc.preset].yaw.max;
	const pitchFrac = Math.abs(pitchRun.w.x * 180 / Math.PI) / RATE_PRESETS[fc.preset].pitch.max;
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
const fast = simulate({ seconds: 2, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 },
	at: [towerX + 45, 120, towerZ], velocity: [-60, 0, 0] });
check('60 m/s impact does not tunnel through the tower (CCD)', fast.p.x > towerX - 25,
	`stopped at x=${fast.p.x.toFixed(1)}, tower at x=${towerX.toFixed(1)}`);
check('high-speed impact registers as a crash', fast.maxImpact > 1500, `${fast.maxImpact.toFixed(0)} N`);

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
	let blockedSamples = 0, deep = 0, total = 0;
	for (let a = 0; a < 8; a++) {
		const x = ex + Math.cos(a / 8 * Math.PI * 2) * 400;
		const z = ez + Math.sin(a / 8 * Math.PI * 2) * 400;
		const o = phys.obstructionBetween(ex, ey, ez, x, ey + 2, z);
		total++;
		if (o.blocked) blockedSamples++;
		if (o.span > 5) deep++;
	}
	check('street-level paths across the tile are obstructed', blockedSamples === total,
		`${blockedSamples}/${total} blocked`);
	check('obstruction is measured as a depth, not just a flag', deep >= total / 2,
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
		const lee = ring(25, groundNearTower + 60);
		const open = ring(400, groundNearTower + 60);
		phys.setWeather(CALM);
		check('the tower shelters the air behind it', lee > 0.15, `shelter ${lee.toFixed(2)} at 25 m`);
		check('and 400 m out over the Champ-de-Mars it does not', open < lee * 0.7,
			`shelter ${open.toFixed(2)} at 400 m`);
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

console.log('\ncrash threshold');
check('upright/flat rotation uses the flat threshold', crashThreshold({ x: 0, y: 0, z: 0, w: 1 }) === CRASH_IMPULSE_FLAT);
check('nose-down rotation uses the tighter threshold',
	crashThreshold({ x: 0.8, y: 0, z: 0, w: Math.sqrt(1 - 0.8 * 0.8) }) === CRASH_IMPULSE);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
