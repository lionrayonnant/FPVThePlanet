// node tools/aero-selftest.mjs — the aerodynamics of translational flight and
// of the spinning rotors themselves (issue #91).
//
// No Rapier, no scene, no browser: quad.js is pure by design (D6), so the three
// effects added for #91 can be proved in under a second, which is what makes it
// reasonable to run this after every edit instead of the minutes-long chain.
//
// The rule this file follows: assert an IDENTITY, never a recorded number. A
// test that hard-codes "thrust at 20 m/s is 1.94 N" only re-states the
// implementation and will happily go green on a sign error. Every check below
// either compares against a quantity derived independently of the code path it
// exercises, or asserts a structural property (a limit, a conservation, a
// symmetry) that a wrong implementation cannot satisfy by accident.
import {
	Propulsion, inducedVelocity, kThrustOf, kInflowOf, kLateralOf, INFLOW_K0,
	mixOf, rotorPlaneYOf, ROTOR_PLANE_Y_REF, FLAP_K, cruiseSpeedOf,
} from '../src/quad.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { FlightController, RATE_PRESETS } from '../src/flightController.js';

const DT = 1 / 250;
const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const air = (v = {}, omega = null) => ({
	v: { x: 0, y: 0, z: 0, ...v },
	omega: omega && { x: 0, y: 0, z: 0, ...omega },
	agl: null,
	shake: 0,
});

// Settle the motors at a command, then read one more step. Every check wants
// the steady state, not the spin-up transient.
function settle(profile, motors, a, steps = 600) {
	const p = new Propulsion({ profile, seed: 11 });
	let r = null;
	for (let i = 0; i < steps; i++) r = p.step(motors, a, DT);
	return { prop: p, force: { ...r.force }, torque: { ...r.torque }, thrust: [...p.thrust], omega: [...p.omega] };
}

const flat = (thr) => [thr, thr, thr, thr];

console.log('aero — translational flight and rotor precession\n');

// ---------------------------------------------------------------------------
console.log('1. translational lift generalises the axial inflow');

// The anti-double-counting check, and the reason the edgewise term had to be
// folded INTO kInflow rather than added next to it. With no edgewise speed the
// thrust must still be exactly the old formula, which is written out here from
// the exported coefficients — an expression that shares no code with step().
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const kT = kThrustOf(profile), kI = kInflowOf(profile);
		for (let n = 0; n <= 20; n++) {
			const thr = n / 20;
			for (const vy of [-9, -3, 0, 2, 7]) {
				const s = settle(profile, flat(thr), air({ y: vy }));
				const w = s.omega[0];
				// Ground effect is off (agl null) and propwash needs descent AND
				// the disc, so at vy >= 0 the expected value is the bare formula;
				// below, propwash scales it, so compare against the model's own
				// propwash rather than re-deriving that too — it is not what this
				// check is about.
				const pw = 1 - 0.22 * s.prop.propwash;
				const want = Math.max(0, kT * w * w - kI * w * vy) * pw;
				const rel = Math.abs(s.thrust[0] - want) / Math.max(1e-9, Math.abs(want));
				if (rel > worst) { worst = rel; worstAt = `${fam} thr=${thr} vy=${vy}`; }
			}
		}
	}
	check('no edgewise speed: thrust is exactly the old axial formula',
		worst < 1e-15, `worst relative error ${worst.toExponential(1)} (${worstAt})`);
}

// The saturation is structural, not a clamp: as Vx grows, v_i falls to zero, so
// the flow deficit tends to -2*vh and the thrust gain tends to a fixed fraction
// of the static thrust. Working it through, kInflow*w*2*vh / (kThrust*w^2)
// collapses to 2*INFLOW_K0*inflowGain — every rho, every disc area and the rpm
// itself cancel. That is an identity between two independently composed
// exports and the constant at the top of quad.js, so no wiring error in step()
// can land on it by accident.
//
// The speed is absurd on purpose: this is a mathematical limit, and v_i decays
// only as vh/Vx, so reaching it to 1e-6 takes a number no drone will ever see.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const kT = kThrustOf(profile);
		const target = 1 + 2 * INFLOW_K0 * (profile.inflowGain ?? 1);
		const s = settle(profile, flat(0.6), air({ z: -1e8 }));
		const w = s.omega[0];
		const ratio = s.thrust[0] / (kT * w * w);
		const err = Math.abs(ratio - target);
		if (err > worst) { worst = err; worstAt = `${fam} ${ratio.toFixed(7)} vs ${target.toFixed(7)}`; }
	}
	check('thrust gain saturates at exactly 1 + 2*INFLOW_K0*inflowGain',
		worst < 1e-6, `worst deviation ${worst.toExponential(1)} (${worstAt})`);
}

// The algebra itself, checked against the equation it solves rather than
// against the closed form that solves it.
{
	let worst = 0;
	for (const vh of [0.5, 3, 7.16, 22, 140]) {
		for (const vx of [0, 0.01, 1, 7, 60, 500, 1e4]) {
			const vi = inducedVelocity(vh, vx * vx);
			const residual = Math.abs(vi * Math.sqrt(vx * vx + vi * vi) - vh * vh) / (vh * vh);
			if (residual > worst) worst = residual;
		}
	}
	check('the closed form satisfies the Glauert disc equation',
		worst < 1e-12, `worst residual ${worst.toExponential(1)}`);
}

// The conjugate form exists to survive Vx >> vh; prove it does.
{
	let ok = true;
	for (const vx of [1e2, 1e3, 1e4, 1e5]) {
		const vi = inducedVelocity(7.16, vx * vx);
		if (!Number.isFinite(vi) || vi < 0 || vi > 7.16) ok = false;
	}
	check('induced velocity stays finite and bounded up to Vx = 1e5 m/s', ok);
	check('no rpm means no induced velocity', inducedVelocity(0, 400) === 0);
	check('no edgewise speed returns the hover value exactly', inducedVelocity(7.16, 0) === 7.16);
}

// Monotonicity: more forward speed can only ever help a rotor at fixed rpm.
{
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		let prev = -Infinity;
		for (let v = 0; v <= 60; v += 2) {
			const t = settle(profile, flat(0.5), air({ z: -v })).thrust[0];
			if (t < prev - 1e-12) { ok = false; detail = `${fam} at ${v} m/s`; }
			prev = t;
		}
	}
	check('thrust increases monotonically with edgewise speed, 0 to 60 m/s', ok, detail);
}

// ---------------------------------------------------------------------------
console.log('\n2. rotor precession');

// Motor commands for a stick position, through the real mixer, so the
// structural claims below are made about the mixer this sim actually flies.
const cmd = (profile, thr, { roll = 0, pitch = 0, yaw = 0 } = {}) =>
	mixOf(profile).map((m) => Math.max(0, Math.min(1, thr + m.roll * roll + m.pitch * pitch + m.yaw * yaw)));

// The structural result, and the reason this effect reads as "yaw while rolling
// moves the nose" rather than as a general mush: on a symmetric X the two
// motors handed +delta carry opposite spins, and so do the two handed -delta,
// so the spins cancel exactly for roll and for pitch no matter what the rpm
// curve does to the magnitudes.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		for (const axis of ['roll', 'pitch']) {
			for (const d of [0.1, 0.25, 0.5, 0.9]) {
				for (const thr of [0.2, 0.5, 0.8]) {
					const h = Math.abs(settle(profile, cmd(profile, thr, { [axis]: d }), air()).prop.hRotor);
					if (h > worst) { worst = h; worstAt = `${fam} ${axis} ${d} @ ${thr}`; }
				}
			}
		}
	}
	check('pure roll and pure pitch carry no net rotor momentum',
		worst < 1e-18, `worst |H| ${worst.toExponential(1)} N.m.s (${worstAt})`);
}

// ...and yaw does, opposing the commanded direction, because the airframe's
// yaw comes from unbalancing prop drag: the motors that speed up are the ones
// spinning against the turn.
{
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const left = settle(profile, cmd(profile, 0.5, { yaw: +0.5 }), air()).prop.hRotor;
		const right = settle(profile, cmd(profile, 0.5, { yaw: -0.5 }), air()).prop.hRotor;
		if (!(left < 0 && right > 0 && Math.abs(left + right) < 0.35 * Math.abs(left))) {
			ok = false;
			detail = `${fam}: ${left.toExponential(2)} / ${right.toExponential(2)}`;
		}
	}
	check('yaw builds net rotor momentum, opposing the stick and symmetric in it', ok, detail);
}

// Wiring, isolated — and isolating it takes one deliberate step, because the
// obvious version of this check is wrong. A body roll rate omega.z also shifts
// each rotor's axial inflow by omega.z * m.x. When the four rpm are equal that
// thrust change cancels out of tx exactly (each side carries one front and one
// rear motor); but the only states with a nonzero H are the ones where the rpm
// are NOT equal, and there the cancellation leaves a residue
// kInflow*omega.z*armX*armZ*(w1 - w2 - w3 + w4), which is a real cross-coupling
// and about 5 % of the term under test. Measured the naive way, this check
// fails at 5e-2 and says nothing about whether the precession is wired right.
//
// So switch the inflow off, with a scratch profile at inflowGain 0. Thrust
// becomes kThrust*w^2 with no body-rate dependence at all, H is untouched (it
// reads the motor commands, not the air), and whatever tx then does with
// omega.z is this term alone.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = { ...PROFILES[fam], inflowGain: 0 };
		const motors = cmd(profile, 0.5, { yaw: 0.5 });
		const base = settle(profile, motors, air({}, { z: 0 }));
		for (const wz of [-14, -3, 3, 14]) {
			const s = settle(profile, motors, air({}, { z: wz }));
			const want = s.prop.hRotor * wz;
			const got = s.torque.x - base.torque.x;
			const rel = Math.abs(got - want) / Math.max(1e-12, Math.abs(want));
			if (rel > worst) { worst = rel; worstAt = `${fam} wz=${wz}`; }
		}
	}
	check('a roll rate reaches the pitch torque as exactly H*omega.z',
		worst < 1e-9, `worst relative error ${worst.toExponential(1)} (${worstAt})`);
}

// The other half of the cross product, with the opposite sign, and the same
// scratch profile for the same reason. Getting one of the two backwards passes
// the check above and fails this one.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = { ...PROFILES[fam], inflowGain: 0 };
		const motors = cmd(profile, 0.5, { yaw: 0.5 });
		const base = settle(profile, motors, air({}, { x: 0 }));
		for (const wx of [-14, -3, 3, 14]) {
			const s = settle(profile, motors, air({}, { x: wx }));
			const want = -s.prop.hRotor * wx;
			const got = s.torque.z - base.torque.z;
			const rel = Math.abs(got - want) / Math.max(1e-12, Math.abs(want));
			if (rel > worst) { worst = rel; worstAt = `${fam} wx=${wx}`; }
		}
	}
	check('a pitch rate reaches the roll torque as exactly -H*omega.x',
		worst < 1e-9, `worst relative error ${worst.toExponential(1)} (${worstAt})`);
}

// How big is it, against what the machine can answer with? Precession does no
// work — tau . omega = -(omega x H) . omega is identically zero — so it can
// never feed the airframe energy; what it can do is be too large to fly
// through. The honest budget is its torque at the fastest roll the family is
// ever commanded, measured in the same units the mixer speaks, against the
// authority one mixer unit buys (torquePerMix, measured by tools/tune-pid.mjs).
// Under that ratio the rate loop trims it out, which is what a real quad does
// with it; over it, the pilot would be fighting the props instead of the air.
//
// A note on integrators, because the number below invites the question. An
// explicit step amplifies a pure rotation by sqrt(1 + (rate*dt)^2) each time,
// and the precession rate * dt is printed here for that reason. It is NOT a
// gate: the sim hands this torque to Rapier, which integrates it, and the
// closed-loop behaviour is what section 3 measures directly. The column is
// diagnostic — a family that appears there with a large product is one whose
// results from the explicit-Euler benches (this file's section 3,
// tools/tune-pid.mjs) deserve a second look.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const I = profile.inertia;
		// The worst case is full yaw at full throttle: the spins are most
		// unbalanced and fastest at the same time.
		let h = 0;
		for (const thr of [0.5, 0.8, 1.0]) {
			for (const yaw of [0.5, 1.0]) {
				h = Math.max(h, Math.abs(settle(profile, cmd(profile, thr, { yaw }), air()).prop.hRotor));
			}
		}
		const rate = RATE_PRESETS[profile.rates].roll.max * Math.PI / 180;
		const share = (h * rate) / profile.pid.torquePerMix.pitch;
		const product = (h / Math.sqrt(I.x * I.z)) * DT;
		console.log(`        ${fam.padEnd(11)} H ${h.toExponential(2)} N.m.s   ${(h * rate).toFixed(4)} N.m at ${(rate * 180 / Math.PI).toFixed(0)} deg/s = ${(share * 100).toFixed(1)}% of a mixer unit   (precession * dt ${product.toFixed(3)})`);
		if (share > worst) { worst = share; worstAt = fam; }
	}
	check('precession stays a disturbance the rate loop can trim, not one it fights',
		worst < 0.35, `worst ${(worst * 100).toFixed(1)}% of a mixer unit (${worstAt}, limit 35%)`);
}

// ---------------------------------------------------------------------------
console.log('\n3. flapback');

// The rotor plane height is one number with two consumers — the flight model
// here and the drawing in src/drone-shape.js — and a disagreement between them
// would be silent. Assert they are the same object, and that the reference
// build still sits at the height it is drawn at.
{
	check('the reference build sits at the drawn rotor plane height',
		rotorPlaneYOf(PROFILES.freestyle5) === ROTOR_PLANE_Y_REF,
		`${rotorPlaneYOf(PROFILES.freestyle5)} m`);
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const h = rotorPlaneYOf(PROFILES[fam]);
		if (!(h > 0.004 && h < 0.05)) { ok = false; detail = `${fam} ${h}`; }
	}
	check('every family carries its props a plausible height above the CG', ok, detail);
}

// Direction, on both axes and both signs. Forward is -Z, so flying forward must
// raise the nose; moving right must roll left, away from the relative wind.
// A sign error anywhere in the cross product breaks at least one of these four.
{
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const m = flat(0.5);
		const fwd = settle(profile, m, air({ z: -20 })).torque;
		const back = settle(profile, m, air({ z: +20 })).torque;
		const right = settle(profile, m, air({ x: +20 })).torque;
		const left = settle(profile, m, air({ x: -20 })).torque;
		if (!(fwd.x > 0 && back.x < 0 && right.z > 0 && left.z < 0)) {
			ok = false;
			detail = `${fam}: fwd ${fwd.x.toFixed(4)} back ${back.x.toFixed(4)} right ${right.z.toFixed(4)} left ${left.z.toFixed(4)}`;
		}
	}
	check('forward pitches up, backward pitches down, sideways rolls away from the wind', ok, detail);
}

// The hub moment on its own, against the formula it comes from, with the lever
// term switched off by a scratch profile at lateralGain 0 — same isolation
// trick as section 2, and necessary for the same reason: two mechanisms share
// this axis and only one is under test.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = { ...PROFILES[fam], lateralGain: 0 };
		const R = profile.propRadius;
		for (const mu of [0.05, 0.15, 0.25]) {
			const s0 = settle(profile, flat(0.5), air());
			const V = mu * s0.omega[0] * R;
			const s = settle(profile, flat(0.5), air({ z: -V }));
			// Recomputed from the settled state, because the rpm and the thrust
			// both move once the air is flowing.
			const muActual = V / (s.omega[0] * R);
			const want = 4 * FLAP_K * muActual * s.thrust[0] * R;
			const rel = Math.abs(s.torque.x - want) / want;
			if (rel > worst) { worst = rel; worstAt = `${fam} mu=${mu}`; }
		}
	}
	check('the hub moment is FLAP_K * mu * T * R per rotor',
		worst < 0.01, `worst relative error ${(worst * 100).toFixed(2)}% (${worstAt})`);
}

// The clamp, which is what keeps a first-order-in-mu result from being asked
// about mu = 3. Past the limit the moment must stop tracking speed.
{
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const profile = { ...PROFILES[fam], lateralGain: 0 };
		// Idle rpm and a high speed puts mu far past the clamp.
		const a = settle(profile, flat(0.08), air({ z: -40 })).torque.x;
		const b = settle(profile, flat(0.08), air({ z: -80 })).torque.x;
		if (!(b < 1.6 * a)) { ok = false; detail = `${fam}: ${a.toFixed(4)} -> ${b.toFixed(4)}`; }
	}
	check('past the advance-ratio limit the hub moment stops tracking speed', ok, detail);
}

// The budget that protects playability: at the speed the airframe actually
// settles at, how much of the pitch mixer does holding attitude cost? Derived,
// not posed — the cruise speed is where the drag of a 35-degree nose-down
// attitude balances what the airframe can push through the air.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const V = cruiseSpeedOf(profile);
		const s = settle(profile, flat(0.5), air({ z: -V }));
		const share = Math.abs(s.torque.x) / profile.pid.torquePerMix.pitch;
		console.log(`        ${fam.padEnd(11)} cruise ${V.toFixed(1).padStart(5)} m/s   pitch-up ${s.torque.x.toFixed(4)} N.m = ${(share * 100).toFixed(1)}% of a mixer unit`);
		if (share > worst) { worst = share; worstAt = fam; }
	}
	check('holding attitude at cruise costs a touch of stick, not the whole axis',
		worst < 0.35, `worst ${(worst * 100).toFixed(1)}% of a mixer unit (${worstAt}, limit 35%)`);
}

// The lever must not have leaked into the thrust moments. A force along body +Y
// has no moment about a lever along +Y, so with still air and no body rate the
// roll and pitch torques have to be exactly what the arms alone give — an
// expression written here from the geometry, sharing no code with step().
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		for (const c of [[0.3, 0.6, 0.4, 0.8], [0.9, 0.1, 0.5, 0.2], [0.55, 0.55, 0.55, 0.55]]) {
			const s = settle(profile, c, air());
			const mot = [
				{ x: +profile.armX, z: +profile.armZ }, { x: +profile.armX, z: -profile.armZ },
				{ x: -profile.armX, z: +profile.armZ }, { x: -profile.armX, z: -profile.armZ },
			];
			let wx = 0, wz = 0;
			for (let i = 0; i < 4; i++) { wx += -mot[i].z * s.thrust[i]; wz += mot[i].x * s.thrust[i]; }
			const err = Math.max(Math.abs(s.torque.x - wx), Math.abs(s.torque.z - wz));
			const scale = Math.max(1e-9, Math.abs(wx), Math.abs(wz));
			if (err / scale > worst) { worst = err / scale; worstAt = `${fam} ${c}`; }
		}
	}
	check('in still air the roll and pitch torques are still the arms alone',
		worst < 1e-15, `worst relative error ${worst.toExponential(1)} (${worstAt})`);
}

// ---------------------------------------------------------------------------
console.log('\n4. held roll does not diverge off-axis (the #144 gate)');

// The failure this guards against is the one that pulled the 1S tinywhoop out
// of PHASE 07: hold full roll for six seconds and watch pitch and yaw walk away
// on their own. tools/selftest.mjs has the definitive version, but it needs
// Rapier and an installed scene, and the thing that diverges is a rigid-body
// phenomenon — the controller, the mixer and the propulsion, spinning in place.
// Integrate exactly that, the way tools/tune-pid.mjs does, and the gate costs a
// second and runs in CI.
//
// Precession is why this check lives in THIS file. Under a full-stick roll the
// airmode mixer saturates the motors asymmetrically, H stops being zero, and
// tx += H*omega.z becomes a pitch disturbance proportional to the roll rate —
// which is the exact shape of the #144 failure.
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function heldRoll(profile, seconds = 6, sticks = { throttle: 0.5, roll: 1, pitch: 0, yaw: 0 }) {
	const fc = new FlightController({ profile });
	const prop = new Propulsion({ profile, seed: 3 });
	const I = profile.inertia;
	let w = { x: 0, y: 0, z: 0 };
	let peakOff = 0, peakRoll = 0;
	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		const state = { rotation: IDENTITY, angularVelocity: w, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
		const { motors } = fc.update(sticks, state, DT);
		const { torque } = prop.step(motors, air({}, w), DT);
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		const gyro = {
			x: w.y * Iw.z - w.z * Iw.y,
			y: w.z * Iw.x - w.x * Iw.z,
			z: w.x * Iw.y - w.y * Iw.x,
		};
		w = {
			x: w.x + ((torque.x - gyro.x) / I.x) * DT,
			y: w.y + ((torque.y - gyro.y) / I.y) * DT,
			z: w.z + ((torque.z - gyro.z) / I.z) * DT,
		};
		// Skip the first tenth of a second: the step response itself throws a
		// legitimate transient onto the other axes.
		if (i * DT > 0.1) {
			peakOff = Math.max(peakOff, Math.abs(w.x), Math.abs(w.y));
			peakRoll = Math.max(peakRoll, Math.abs(w.z));
		}
	}
	return { peakOff, peakRoll, final: w };
}

{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const { peakOff, peakRoll } = heldRoll(profile);
		const commanded = RATE_PRESETS[profile.rates].roll.max * Math.PI / 180;
		const ratio = peakOff / commanded;
		console.log(`        ${fam.padEnd(11)} roll ${(peakRoll * 180 / Math.PI).toFixed(0).padStart(4)} deg/s   off-axis ${(peakOff * 180 / Math.PI).toFixed(0).padStart(4)} deg/s   = ${(ratio * 100).toFixed(1)}%`);
		if (ratio > worst) { worst = ratio; worstAt = fam; }
	}
	check('a held full roll leaves pitch and yaw alone, every family',
		worst < 0.25, `worst ${(worst * 100).toFixed(1)}% of commanded (${worstAt}, limit 25%)`);
}

// Roll AND yaw together is the state precession actually lives in, and the one
// worth being nervous about: H is at its largest and omega.z at its largest at
// the same moment, so the pitch disturbance H*omega.z is too. Pure roll says
// nothing about it — the check above measures exactly 0.0 % because the mixer
// keeps the spins balanced there, which is the structural result of section 2
// surviving contact with airmode.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const r = heldRoll(profile, 6, { throttle: 0.5, roll: 1, pitch: 0, yaw: 1 });
		const commanded = RATE_PRESETS[profile.rates].roll.max * Math.PI / 180;
		// Pitch only: yaw is commanded here, so its rate is not an excursion.
		const ratio = Math.abs(r.final.x) / commanded;
		const peak = Math.abs(r.final.x) * 180 / Math.PI;
		console.log(`        ${fam.padEnd(11)} roll+yaw held: pitch settles at ${peak.toFixed(1).padStart(6)} deg/s = ${(ratio * 100).toFixed(1)}%`);
		if (ratio > worst) { worst = ratio; worstAt = fam; }
	}
	check('a held roll WITH yaw settles the nose instead of walking it away',
		worst < 0.25, `worst ${(worst * 100).toFixed(1)}% of commanded (${worstAt}, limit 25%)`);
}

// ---------------------------------------------------------------------------
console.log('\n5. what the pilot actually sees');

// The moment above is invisible in flight, and deliberately so: in acro the
// rate loop commands zero pitch RATE and rejects a steady pitching moment
// completely — that is its job. "At 20 m/s the craft pitches up" is therefore
// false by construction, and a test asserting it would measure noise.
//
// What IS visible is what the controller has to do to keep holding attitude:
// the front motors run lower than the rear ones. That trim is the signature,
// and it is compared against a moment computed from momentum theory rather
// than against a recorded number.
{
	let worst = 0, worstAt = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const trimAt = (V) => {
			const fc = new FlightController({ profile });
			const prop = new Propulsion({ profile, seed: 5 });
			const I = profile.inertia;
			let w = { x: 0, y: 0, z: 0 };
			let sum = 0, n = 0;
			const steps = 750;
			for (let i = 0; i < steps; i++) {
				const state = { rotation: IDENTITY, angularVelocity: w, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
				const { motors } = fc.update({ throttle: 0.5, roll: 0, pitch: 0, yaw: 0 }, state, DT);
				const { torque } = prop.step(motors, air({ z: -V }, w), DT);
				const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
				w = {
					x: w.x + ((torque.x - (w.y * Iw.z - w.z * Iw.y)) / I.x) * DT,
					y: w.y + ((torque.y - (w.z * Iw.x - w.x * Iw.z)) / I.y) * DT,
					z: w.z + ((torque.z - (w.x * Iw.y - w.y * Iw.x)) / I.z) * DT,
				};
				// Last third only: the loop needs time to find the trim.
				if (i > (2 * steps) / 3) {
					// Front pair minus rear pair. Motor order is Betaflight's:
					// 1 rear right, 2 front right, 3 rear left, 4 front left.
					sum += (motors[1] + motors[3]) / 2 - (motors[0] + motors[2]) / 2;
					n++;
				}
			}
			return sum / n;
		};
		const V = cruiseSpeedOf(profile);
		const still = trimAt(0);
		const fast = trimAt(V);
		// Nose-down, unmistakably, and still leaving most of the motor range to
		// fly with. A trim that ate half the range would mean the pilot spends
		// the axis holding the attitude instead of steering with it.
		const ok = Math.abs(still) < 0.005 && fast < -0.002 && fast > -0.35;
		console.log(`        ${fam.padEnd(11)} cruise ${V.toFixed(1).padStart(5)} m/s   trim at rest ${still.toFixed(5)}   at cruise ${fast.toFixed(5)}`);
		if (!ok) { worst = 1; worstAt = `${fam} (${still.toFixed(5)} / ${fast.toFixed(5)})`; }
	}
	check('holding attitude at cruise costs nose-down trim, nothing at rest, and never the axis',
		worst === 0, worstAt && `${worstAt} did not`);
}

// And the lift, end to end: the same stick lifts harder in translation, so the
// stick that hovers has to come DOWN as the air starts flowing. Compared
// against the closed form inverted through the thrust curve — the two sides
// share no code path.
{
	let ok = true, detail = '';
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const hover = ((profile.mass * GRAVITY) / (4 * profile.maxThrustPerMotor)) ** (1 / (2 * profile.rpmCurve));
		// What stick holds the same total thrust at 20 m/s? Bisect on the model.
		const V = cruiseSpeedOf(profile);
		const totalAt = (stick, v) => settle(profile, flat(stick), air({ z: -v })).force.y;
		const want = totalAt(hover, 0);
		let lo = 0, hi = hover;
		for (let i = 0; i < 40; i++) {
			const mid = (lo + hi) / 2;
			if (totalAt(mid, V) < want) lo = mid; else hi = mid;
		}
		const stick20 = (lo + hi) / 2;
		if (!(stick20 < hover - 0.005)) { ok = false; detail = `${fam}: ${stick20.toFixed(4)} vs hover ${hover.toFixed(4)}`; }
	}
	check('the stick that holds a hover comes down once the air is flowing', ok, detail);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
