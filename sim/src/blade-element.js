// A propeller as a blade, integrated element by element, instead of as a
// thrust coefficient.
//
// WHAT THIS REPLACES. quad.js models a rotor as
//
//   T = kThrust * omega^2 - kInflow * omega * dw     (clamped at T >= 0)
//
// a static thrust with a first-order correction for the flow through the disc.
// That form has three failures, and all three are regimes a pilot actually
// flies through:
//
//   - It cannot go negative. `Math.max(0, t)` means a prop never brakes, never
//     windmills, and a STOPPED prop vanishes aerodynamically — four 5" props
//     are 0.05 m2 of disc, and the old model gave them exactly zero drag the
//     moment they stopped turning.
//   - Its inflow term is a slope fitted around hover, so it had to be bounded
//     by hand to stop it running away in a descent (AXIAL_INFLOW_LIMIT).
//   - Its thrust and torque coefficients are constants, so nothing changes
//     with advance ratio: the prop is as efficient at 30 m/s as at rest.
//
// Blade-element momentum theory has none of those, because it does not model
// the outcome — it models the blade. Each radial station sees its own local
// airflow, gets its own angle of attack, and contributes its own lift and drag.
// Powered flight, propeller unloading at speed, windmilling, reverse flow and
// stopped-prop drag are not special cases here: they are what the same integral
// returns when the angle of attack goes where it goes.
//
// WHERE IT COMES FROM. Glauert's blade-element momentum theory with Prandtl tip
// loss, a cambered thin-aerofoil lift line, and a Viterna-style flat-plate
// extension past stall so the polars stay valid through +-180 degrees of
// incidence; the blade is integrated over azimuth as well as radius, which is
// what gives the advancing and retreating sides their own angles of attack.
// Textbook material (Glauert 1935; Leishman, *Principles of Helicopter
// Aerodynamics*, ch. 2-3); implemented here from the theory.
//
// WHAT IT IS CHECKED AGAINST. tools/uiuc-prop-validate.mjs takes the UIUC
// Propeller Data Site's wind-tunnel measurements — 187 small propellers —
// calibrates this model on ONE static point per propeller and then predicts the
// whole advance-ratio sweep. That bench is what found the two defects the next
// two comments describe, and what says they are fixed. Mean absolute error on
// CT went from 77% to 30%, and — the number that actually matters — the SIGNED
// error, which ran from -8% at J = 0.05 to -222% at J = 0.95 in one unbroken
// direction, now sits within a few percent of zero at every advance ratio. What
// is left is scatter between propellers, not a term that is missing.
//
// KNOWN LIMITS, stated before they are discovered the hard way.
//
//   - The bench is AXIAL. A wind tunnel blows along the propeller's shaft, so
//     nothing in those 16,000 points says anything about a rotor flying
//     edgewise. The azimuthal integration below is textbook and it removes a
//     defect that was unambiguous — thrust falling 44% by 40 m/s of edgewise
//     flight, where a real rotor gains — but it is verified by construction and
//     by its limits, not against measurement. Between rest and about 15 m/s it
//     predicts a shallow dip of a few percent before translational lift takes
//     over; that dip is plausible (coarse inboard sections, already stalled in
//     still air, pushed further past it as the induced velocity falls) and it
//     is unverified.
//   - Two folds survive where momentum theory stops having a solution at all:
//     the vortex-ring state in a descent near Vc/vh = -2, and the windmill
//     transition in a fast climb at low rpm. The annulus residual's first root
//     merges with its second and vanishes there, and the induced velocity steps
//     to the next one — 5% of static thrust across a 0.25 m/s change, worst
//     measured. Leishman's empirical induced-velocity fit through the
//     turbulent-wake state is the published answer, and it is a uniform-inflow
//     model, so adopting it is a restructuring rather than a patch.
//   - The lumped section drag is still solved per family against the STATIC
//     anchor, and static is the operating point this model resolves worst — the
//     whole disc is stalled there. Everything off it is a prediction made with
//     a number fixed at the one place the blade is least well described.

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

// Radial stations. Eight is enough for a prop this small — the integrand is
// smooth once tip loss is in — and it keeps the whole rotor under a microsecond
// in axial flight.
const ELEMENTS = 8;

// Azimuthal stations, used only when the rotor has in-plane velocity.
//
// THE DEFECT THIS EXISTS FOR. Before it, the blade elements never saw the
// edgewise flow: only the momentum balance did. The disc's mass flow rose with
// forward speed, so the induced velocity collapsed, so the sections met their
// own geometric twist head on and stalled — and a rotor that should have gained
// translational lift lost 44% of its thrust by 40 m/s of edgewise flight. That
// is not a correction that can be patched into an axial integral: it is the
// whole point of integrating over azimuth. Each station's tangential speed is
// now omega*r + vEdge*sin(psi), so the advancing side sees more dynamic
// pressure and a smaller angle of attack and the retreating side sees less of
// both, exactly as on a real rotor, and the thrust is the average over a turn.
//
// The count is chosen from the advance ratio rather than fixed, because the
// midpoint rule on a smooth periodic integrand converges fast: at mu below 0.01
// every station returns the same number to within a part in 10^4, so one
// station IS the integral and hover pays nothing for this.
const AZIMUTH_MAX = 8;
const AZIMUTH_MID = 4;
const MU_ONE_STATION = 0.01;
const MU_FOUR_STATIONS = 0.10;

// Blade root cutoff: the inner 15% is hub and has no aerofoil.
const ROOT = 0.15;

// Aerofoil. A thin-plate lift slope below stall, Viterna-style flat plate above
// it, blended across a band so the polar has no step in it. These are the
// standard values for a small propeller section; none of them is fitted to this
// simulator's behaviour.
const ALPHA_STALL = 14 * DEG;
const CL_SLOPE = 2 * Math.PI;      // per radian, thin aerofoil

// Zero-lift angle of the section, and the single most consequential number in
// this file.
//
// THE DEFECT IT EXISTS FOR. A propeller's advertised pitch is a GEOMETRIC
// pitch: the chord line's helix. twistAt() below turns it into blade angle
// exactly, which is right — and then a symmetric lift line (cl = 2*pi*sin
// alpha, zero lift at zero blade angle) makes the blade stop pulling at
// precisely the advance ratio where it stops slipping, J = p/D. Real blades do
// not. Propeller sections are CAMBERED, they lift at zero geometric incidence,
// and their aerodynamic pitch is larger than the number on the box by the
// zero-lift angle. The measured consequence, before this term existed, was a
// model that under-predicted thrust in one direction, monotonically, from
// J ~ 0.2 up: -36% by J = 0.35, past -100% by J = 0.65 — predicting a braking
// propeller where the tunnel still measured thrust. It was worst on exactly the
// propellers where it should be, the low-pitch ones: an 11x3 has a blade angle
// of 6.6 degrees at three-quarter span, so three degrees of camber is not a
// correction to it, it is half the blade.
//
// Thin-aerofoil theory (Glauert, *The Elements of Aerofoil and Airscrew
// Theory*, ch. 7) gives the zero-lift angle of a cambered section directly from
// its camber line, and -3 degrees is where a lightly cambered propeller section
// of a few percent camber sits. It is a property of the AEROFOIL, fixed once
// here for every propeller, not a per-family knob: the calibration below never
// touches it, and it is the same number for all 187 propellers on the bench.
const ALPHA_ZERO_LIFT = -3 * DEG;

// The blade's drag at zero lift, solved per family (see geometryOf).
//
// Named honestly: this is NOT a clean aerofoil's Cd0, and the solved values say
// so — a 5" solves near 0.3 where a published section sits near 0.02. It is the
// LUMPED section loss, and it carries everything the blade-element model does
// not resolve: profile drag at the miserable Reynolds numbers these props
// actually work at (a 5" runs ~8e4 at full song, a 2.5" micro ~1.9e4, where
// published polars stop being relevant), hub and root drag, blade-to-blade
// interference, and for the cinewhoop the duct its own profile comment calls
// out. Left as a textbook 0.02 the model returns a figure of merit near 0.68,
// which is a large helicopter rotor; a real 5" multirotor prop measures 0.35 to
// 0.45, and that gap is what this number is.
//
// It is calibrated, not invented, and it is calibrated against a quantity the
// profile already measured. What makes it a real quantity rather than a knob is
// that it is ONE number per family fixed at ONE operating point, and everything
// else the blade does — every advance ratio, windmilling, stopped — is then
// predicted with it held fixed.
const SECTION_DRAG_DEFAULT = 0.02;
// A blade cannot be draggier than a flat plate.
const SECTION_DRAG_MAX = 1.2;
const CD_INDUCED = 0.02;           // the k in Cd = Cd0 + k*Cl^2
const CD_MAX = 1.2;                // a flat plate broadside on

// Wrap an incidence into (-pi, pi]. The azimuthal integration puts blade
// elements in reversed flow — inboard on the retreating side, where
// omega*r + vEdge*sin(psi) goes negative — and there the inflow angle is near
// +-pi, so `twist - phi` leaves the branch the polar below is written on. The
// polar is periodic in a full turn; this is what makes the code periodic too.
function wrapAngle(a) {
	let x = (a + Math.PI) % TWO_PI;
	if (x < 0) x += TWO_PI;
	return x - Math.PI;
}

// Lift and drag coefficients valid at ANY incidence, which is the whole point:
// a windmilling or stopped blade sits at 60, 90, 130 degrees of angle of
// attack, and a polar that only covers +-15 is what forces a model to clamp
// its thrust at zero and pretend.
//
// `alpha` is the GEOMETRIC angle of attack, measured from the chord line. The
// aerodynamic one is alpha - ALPHA_ZERO_LIFT, and the whole polar is written
// against that: a cambered section stalls at a fixed angle from ITS zero-lift
// line, not from its chord.
//
// Past stall this is Viterna and Corrigan's extension (1981), written out in
// full rather than approximated by a flat plate. The difference is the second
// lift term, A2 cos^2/sin, and it is not cosmetic: dropping it — which this
// file used to do, blending to a bare Cd_max/2 * sin(2 alpha) — makes lift
// collapse from 1.52 at the stall angle to 0.47 by 26 degrees, where Viterna
// holds 1.23 at 19 degrees and 1.00 at 30. A rotor blade in edgewise flight
// lives in exactly that band, so that collapse was a large part of why thrust
// fell with forward speed instead of rising.
//
// Viterna matches the linear branch AT the stall angle by construction, so
// there is no blend band and no step: A2 and B2 are solved from the linear
// values at +-ALPHA_STALL, which also carries the camber asymmetry into the
// post-stall region for free.
const CL_STALL = CL_SLOPE * Math.sin(ALPHA_STALL);
const SIN_STALL = Math.sin(ALPHA_STALL);
const COS_STALL = Math.cos(ALPHA_STALL);
const VITERNA_A1 = CD_MAX / 2;
const VITERNA_A2 = ((CL_STALL - CD_MAX * SIN_STALL * COS_STALL) * SIN_STALL)
	/ (COS_STALL * COS_STALL);
// Reversed flow runs over what is now a sharp leading edge, so the section
// keeps its shape of polar but not its effectiveness. 0.7 is the reduction the
// standard 360-degree table construction applies (Viterna and Corrigan's
// extension as tabulated by AirfoilPrep), and it is what makes the curve close:
// lift is zero broadside at 90 degrees, negative through the reversed quadrant,
// and zero again edge-on at a half turn.
const REVERSED = 0.7;

// The polar on the quarter turn it is actually defined over, 0 to 90 degrees of
// aerodynamic incidence. Everything else is this, mirrored.
function quadrant(b, cd0) {
	if (b <= ALPHA_STALL) {
		const cl = CL_SLOPE * Math.sin(b);
		return { cl, cd: cd0 + CD_INDUCED * cl * cl };
	}
	const sb = Math.sin(b);
	const cb = Math.cos(b);
	// B2 closes the drag branch on the linear one at the stall angle, exactly as
	// A2 closes the lift branch: the two halves meet, so there is no blend band
	// and no step for a flight controller to chase.
	const cdStall = cd0 + CD_INDUCED * CL_STALL * CL_STALL;
	const b2 = (cdStall - CD_MAX * SIN_STALL * SIN_STALL) / COS_STALL;
	return {
		cl: VITERNA_A1 * Math.sin(2 * b) + (VITERNA_A2 * cb * cb) / sb,
		cd: Math.max(cd0, CD_MAX * sb * sb + b2 * cb),
	};
}

export function airfoil(alpha, cd0 = SECTION_DRAG_DEFAULT) {
	const ae = wrapAngle(alpha - ALPHA_ZERO_LIFT);
	const a = Math.abs(ae);
	const sign = ae < 0 ? -1 : 1;
	if (a <= HALF_PI) {
		const q = quadrant(a, cd0);
		return { cl: sign * q.cl, cd: q.cd };
	}
	// Past broadside the flow comes over the trailing edge: same polar, mirrored
	// about 90 degrees, lift reversed and reduced.
	const q = quadrant(Math.PI - a, cd0);
	return { cl: -sign * REVERSED * q.cl, cd: q.cd };
}

// Chord distribution, as a fraction of radius. Rounded peak around 60% span and
// tapering to the tip, which is what a small injection-moulded prop looks like.
// Its SCALE is the one calibrated quantity in this file (see geometryOf); the
// shape is a modelling choice, stated here rather than buried.
function chordShape(x) {
	return Math.sin(Math.PI * Math.pow(x, 0.7));
}

// Geometric twist, from the prop's own pitch. This is not a fit: a propeller's
// pitch IS the axial distance one turn would advance it if it did not slip, so
// the blade angle at radius r is exactly atan(pitch / 2*pi*r). "5x4.3x3" on the
// box is a 5 inch diameter, a 4.3 inch pitch and 3 blades, and the twist falls
// straight out of the middle number. What the box does NOT say is where the
// chord line's zero lift is; that is ALPHA_ZERO_LIFT above, and it is the
// difference between geometric and aerodynamic pitch.
export function twistAt(pitch, r) {
	return Math.atan2(pitch, 2 * Math.PI * r);
}

// Prandtl's tip loss factor: near the tip the flow leaks around the blade and
// that station lifts less than a two-dimensional section would.
function tipLoss(bladeCount, x, phi) {
	if (x >= 1) return 1e-3;              // at the tip itself, nothing lifts
	const s = Math.abs(Math.sin(phi));
	// f = B(1-x) / (2x sin(phi)), and F = (2/pi) acos(exp(-f)). As sin(phi) -> 0
	// the exponent runs away, exp(-f) -> 0, and F -> 1: a disc with no inflow
	// angle has NO tip loss. Returning a small number here instead — which is
	// what this function used to do — inverted the factor exactly where it
	// matters most, and it put a 1000x error in the denominator of the induced
	// velocity on the first iteration of every solve.
	if (s < 1e-6) return 1;
	const f = (bladeCount * (1 - x)) / (2 * x * s);
	const e = Math.exp(-f);
	if (e >= 1) return 1e-3;
	return Math.max(1e-3, (2 / Math.PI) * Math.acos(e));
}

// The blade, resolved once per airframe. `chordScale` is solved so that the
// rotor makes exactly the profile's `maxThrustPerMotor` at `maxOmega` in still
// air — the same trick motor.js uses for winding resistance, and for the same
// reason: the airframe's anchor points stay authoritative, and this file adds
// no free parameter beyond the one that calibration pins.
//
// Torque is then a PREDICTION rather than an input. The profile's stored
// `torqueRatio` has no say in it, which makes it a check: see
// tools/blade-element-selftest.mjs.
export function geometryOf(profile) {
	const R = profile.propRadius;
	const g = {
		R,
		blades: profile.bladeCount,
		pitch: profile.propPitch,
		chordScale: 1,
		cd0: SECTION_DRAG_DEFAULT,
		r: new Float64Array(ELEMENTS),
		dr: (R * (1 - ROOT)) / ELEMENTS,
		chord: new Float64Array(ELEMENTS),
		twist: new Float64Array(ELEMENTS),
	};
	for (let i = 0; i < ELEMENTS; i++) {
		const x = ROOT + ((i + 0.5) * (1 - ROOT)) / ELEMENTS;
		g.r[i] = x * R;
		g.chord[i] = chordShape(x) * R;
		g.twist[i] = twistAt(profile.propPitch, g.r[i]);
	}
	// TWO anchors, two unknowns. The profile states what this rotor makes at
	// maxOmega (`maxThrustPerMotor`) and what that costs in torque
	// (`torqueRatio`), both measured; chord scale and section drag are solved so
	// the blade reproduces BOTH. Off that one operating point — every advance
	// ratio, every descent, windmilling, stopped — the model is then predicting
	// rather than reproducing, which is the entire reason for having it.
	//
	// NESTED, not alternating. Solving one unknown and then the other in turn is
	// what this used to do, and on the reference family it settled into a limit
	// cycle 4% off both anchors: chord and section drag each move the OTHER's
	// target, so a Gauss-Seidel sweep between them has no reason to contract.
	// Here the chord solve is INSIDE the section-drag solve, so the outer solve
	// always reads a torque ratio taken at the right thrust, and it is a plain
	// one-dimensional bisection on a quantity that rises with section drag.
	//
	// (The limit cycle had a second, deeper cause — a discontinuous induced
	// velocity, see rotorForces — and it is fixed there. The two together are
	// what made the anchors unreachable; nesting alone would not have done it.)
	const wantThrust = profile.maxThrustPerMotor;
	const wantRatio = profile.torqueRatio;
	const staticForces = () => rotorForces(g, profile.maxOmega, 0, 1.225);
	// Bracket first, then bisect. Neither quantity is monotone over the whole
	// range: pile on enough chord and the extra section drag eats the thrust it
	// adds, so the curve turns over. Scanning for the FIRST rising crossing
	// keeps the solve on the branch that means anything, and falling off the end
	// of the scan (the target is simply unreachable) leaves the best value found
	// rather than an arbitrary one.
	const solve = (set, read, want, lo, hi, steps = 60) => {
		const STEPS = 48;
		const lo0 = lo, hi0 = hi;
		let a = lo, fa = (set(a), read());
		let bracketed = false;
		for (let i = 1; i <= STEPS; i++) {
			const b = lo0 * Math.pow(hi0 / lo0, i / STEPS);
			set(b);
			const fb = read();
			if (fa < want && fb >= want) { lo = a; hi = b; bracketed = true; break; }
			a = b; fa = fb;
		}
		if (!bracketed) {
			// Unreachable in this range. Keep whichever end gets closest, and let
			// the caller's own checks say so — a ducted rotor's torque ratio is
			// not blade drag, and the model refusing to fake it is the point.
			let best = lo0, err = Infinity;
			for (let i = 0; i <= STEPS; i++) {
				const v = lo0 * Math.pow(hi0 / lo0, i / STEPS);
				set(v);
				const e = Math.abs(read() - want);
				if (e < err) { err = e; best = v; }
			}
			set(best);
			return false;
		}
		for (let k = 0; k < steps; k++) {
			const mid = 0.5 * (lo + hi);
			set(mid);
			if (read() < want) lo = mid; else hi = mid;
		}
		set(0.5 * (lo + hi));
		return true;
	};
	const solveChord = () => solve((v) => { g.chordScale = v; },
		() => staticForces().thrust, wantThrust, 1e-4, 100);
	// Outer unknown: section drag. Reading it means re-solving the chord first,
	// so every value the outer bisection compares is taken on the thrust anchor.
	solve(
		(v) => { g.cd0 = v; solveChord(); },
		() => { const f = staticForces(); return f.torque / f.thrust; },
		wantRatio, 1e-4, SECTION_DRAG_MAX,
	);
	// Chord last, so static thrust is exact even when the torque ratio could not
	// be reached (a duct is not blade drag, and the model is right to refuse).
	solveChord();
	return g;
}

// How many azimuthal stations this operating point needs. One when the rotor is
// effectively in axial flight, where every station returns the same number and
// the integral is the integrand.
const SIN_TABLE = (() => {
	const t = [];
	for (const n of [1, AZIMUTH_MID, AZIMUTH_MAX]) {
		const a = new Float64Array(n);
		for (let j = 0; j < n; j++) a[j] = Math.sin(((j + 0.5) * TWO_PI) / n);
		t[n] = a;
	}
	return t;
})();

function azimuthCount(w, R, vEdge) {
	const tip = w * R;
	if (!(vEdge > 0) || !(tip > 1e-6)) return 1;
	const mu = vEdge / tip;
	if (mu < MU_ONE_STATION) return 1;
	return mu < MU_FOUR_STATIONS ? AZIMUTH_MID : AZIMUTH_MAX;
}

// Thrust and torque for one rotor, in newtons and N.m.
//
// `omega`    rad/s, always >= 0 here: the spin direction is the caller's
//            bookkeeping, not the blade's.
// `vAxial`   the rotor's velocity through the air along its own thrust axis,
//            positive climbing. Descending is negative, and there is nothing
//            special about it in this file.
// `vEdge`    the in-plane component. It enters the momentum balance (Glauert)
//            AND every blade element's own tangential speed, which is what
//            gives the advancing and retreating sides different angles of
//            attack.
//
// Thrust comes back NEGATIVE when the blade is being driven by the air rather
// than driving it — a windmilling prop really does pull backwards — and a
// stopped rotor still returns the drag of four stalled blades sitting in the
// flow. Neither was expressible before.
//
// What this still does NOT return is the 1/rev content that azimuthal
// integration makes available: the in-plane H-force and the flapping moments
// (the roll-pitch coupling of #91). Only the mean over a turn comes out here,
// and quad.js's `kLateral` still carries the in-plane force.
export function rotorForces(g, omega, vAxial, rho = 1.225, vEdge = 0) {
	let thrust = 0;
	let torque = 0;
	const w = Math.abs(omega);
	const az = azimuthCount(w, g.R, vEdge);
	// Midpoint rule over one revolution. The offset matters: with psi sampled at
	// the half-steps the sin term sums to zero exactly for any even count, so
	// the edgewise flow adds nothing at first order and what survives is the
	// genuine second-order effect.
	const SIN_PSI = SIN_TABLE[az];
	for (let i = 0; i < ELEMENTS; i++) {
		const r = g.r[i];
		const chord = g.chord[i] * g.chordScale;
		const twist = g.twist[i];
		const uT0 = w * r;
		const x = r / g.R;
		const k = 0.5 * rho * chord * g.dr * g.blades;
		// Blade-element load on this annulus, averaged over a revolution, for a
		// trial induced velocity.
		//
		// Tip loss is taken ONCE per annulus, at the azimuthal mean tangential
		// speed, rather than at every station: it is the annulus's own
		// correction on the momentum side, it varies only at second order over a
		// revolution, and it is the one transcendental in this loop.
		const bladeLoad = (v, out) => {
			const uP = vAxial + v;
			let t = 0, q = 0;
			for (let j = 0; j < az; j++) {
				const uT = uT0 + vEdge * SIN_PSI[j];
				const u2 = uT * uT + uP * uP;
				const u = Math.sqrt(u2);
				// cos phi and sin phi are the velocity components themselves; only
				// the angle of attack actually needs the arctangent.
				const cosPhi = u > 0 ? uT / u : 1;
				const sinPhi = u > 0 ? uP / u : 0;
				const { cl, cd } = airfoil(twist - Math.atan2(uP, uT), g.cd0);
				const qq = k * u2;
				t += qq * (cl * cosPhi - cd * sinPhi);
				q += qq * (cl * sinPhi + cd * cosPhi);
			}
			out.thrust = t / az;
			out.torque = (q / az) * r;
			out.F = tipLoss(g.blades, x, Math.atan2(uP, uT0));
			return out;
		};
		const load = { thrust: 0, torque: 0, F: 1 };
		// Induced velocity, from the momentum balance on this annulus. Solved
		// only where momentum theory HAS a solution: a rotor that is barely
		// turning, or that the air is driving, is not an actuator disc, and
		// forcing the equation there is how a model ends up with an unbounded
		// inflow correction it has to clamp by hand. Where it does not apply the
		// blade simply sees the freestream — which for a stopped prop is not an
		// approximation, it is the exact situation.
		//
		// FIRST root, found by scanning, not by bisecting an assumed-monotone
		// residual. This is the second defect the UIUC bench found, and it was
		// hiding under a comment in this file that claimed the residual was
		// monotone. It is not. An inboard station on a coarse blade — 33 degrees
		// of twist at a quarter span on the reference 5" — sits past stall in
		// still air, so more inflow UNSTALLS it and makes MORE thrust before it
		// makes less. The residual therefore has a hump, and at the calibration
		// point of the reference family it had THREE roots: 11.8, 16.0 and
		// 21.4 m/s. A doubling bracket picked whichever one the sampling
		// happened to straddle, so a 0.1% change in blade chord moved the
		// induced velocity by a factor of two and the rotor's thrust by 9%. That
		// step is what the calibration above was cycling on: bisection cannot
		// hit a target that jumps across it.
		//
		// The physical root is the lowest one. It is the first stable
		// equilibrium the disc reaches coming up from zero inflow, and taking it
		// makes the thrust surface single-valued and smooth in every parameter —
		// which the selftest asserts directly, since a surface with a step in it
		// is what ruined the calibration and would have arrived in flight as
		// noise nobody could trace back to here.
		let vi = 0;
		if (uT0 > 0.5) {
			const residual = (v) => {
				bladeLoad(v, load);
				// Glauert: the mass flow is set by the TOTAL velocity at the disc,
				// so translational lift falls out of the same balance.
				const uP = vAxial + v;
				const flow = Math.sqrt(vEdge * vEdge + uP * uP);
				return load.thrust - 4 * Math.PI * rho * r * load.F * g.dr * flow * v;
			};
			if (residual(0) > 0) {
				// Scan up for the FIRST sign change, over a range momentum theory
				// itself sets rather than over the tip speed.
				//
				// The scan has to be fine enough not to step over a root pair, and
				// scanning to the tip speed wastes almost every sample: a 5" rotor
				// induces 10 or 20 m/s where its tip moves at 200. Setting the
				// annulus's momentum term equal to its zero-inflow blade load gives
				// the scale of the answer directly — v ~ sqrt(T / 4 pi rho r F dr),
				// the standard momentum estimate — and in a descent the induced
				// velocity has to clear the descent rate as well before the flow
				// through the disc turns round. Three times the larger of the two
				// is a ceiling with room in it, and the same number of samples then
				// lands where the roots actually are.
				const SCAN = 32;
				const wake = 4 * Math.PI * rho * r * load.F * g.dr;
				const vRef = Math.max(
					Math.sqrt(Math.abs(load.thrust) / Math.max(wake, 1e-9)),
					Math.abs(vAxial),
					0.5,
				);
				const ceiling = Math.min(3 * vRef, Math.max(uT0, 3 * vRef));
				let lo = 0, hi = 0, found = false;
				for (let k = 1; k <= SCAN; k++) {
					const v = (ceiling * k) / SCAN;
					if (residual(v) <= 0) { lo = (ceiling * (k - 1)) / SCAN; hi = v; found = true; break; }
				}
				if (!found) {
					// No crossing below the estimate. The residual does go negative
					// eventually — pile on enough inflow and the section is a flat
					// plate edge-on while the momentum term grows without bound — so
					// keep doubling rather than clamping at an arbitrary ceiling.
					lo = ceiling;
					hi = ceiling * 2;
					for (let k = 0; k < 24 && residual(hi) > 0; k++) { lo = hi; hi *= 2; }
				}
				for (let k = 0; k < 24; k++) {
					const mid = 0.5 * (lo + hi);
					if (residual(mid) > 0) lo = mid; else hi = mid;
				}
				vi = 0.5 * (lo + hi);
			}
		}
		bladeLoad(vi, load);
		thrust += load.thrust;
		torque += load.torque;
	}
	return { thrust, torque };
}
