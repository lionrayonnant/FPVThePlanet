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
// loss, and a Viterna-style flat-plate extension of the aerofoil past stall so
// the polars stay valid through +-180 degrees of incidence. Textbook material
// (Glauert 1935; Leishman, *Principles of Helicopter Aerodynamics*, ch. 2-3);
// implemented here from the theory.
//
// KNOWN LIMIT, stated before it is discovered the hard way. The edgewise term
// below is the right momentum physics, but the blade ELEMENTS never see the
// edgewise flow — only the momentum balance does. Past an advance ratio of
// roughly 0.1 (about 10 m/s on a 5") that asymmetry shows: the induced velocity
// collapses, the sections meet their own geometric twist head on, and they
// stall, so thrust peaks and then falls where a real rotor's would flatten.
// Below that it behaves: translational lift comes out at about +10% by 10 m/s.
// Fixing it properly means integrating over azimuth, not patching this.
//
// EDGEWISE FLIGHT is carried by Glauert's momentum formula rather than by
// integrating over azimuth: the mass flow through a disc that is also moving
// sideways is set by sqrt(V_edge^2 + (V_axial + v_i)^2), not by (V_axial + v_i)
// alone, so translational lift — a rotor working better once air is flowing
// through it — falls out of the same balance. What this does NOT do is give the
// advancing and retreating blades different angles of attack, which needs an
// azimuthal integration and is a separate, much larger job. The 1/rev effects
// that come with it (flapping, the roll-pitch coupling of #91) are therefore
// still absent, and quad.js's `kLateral` rotor drag still carries the in-plane
// H-force.

const DEG = Math.PI / 180;

// Radial stations. Eight is enough for a prop this small — the integrand is
// smooth once tip loss is in — and it keeps the whole rotor under a microsecond.
const ELEMENTS = 8;

// Blade root cutoff: the inner 15% is hub and has no aerofoil.
const ROOT = 0.15;

// Aerofoil. A thin-plate lift slope below stall, Viterna-style flat plate above
// it, blended across a band so the polar has no step in it. These are the
// standard values for a small propeller section; none of them is fitted to this
// simulator's behaviour.
const ALPHA_STALL = 14 * DEG;
const BLEND = 12 * DEG;
const CL_SLOPE = 2 * Math.PI;      // per radian, thin aerofoil
// The blade's drag at zero lift, solved per family (see geometryOf).
//
// Named honestly: this is NOT a clean aerofoil's Cd0, and the solved values say
// so — 0.27 for a 5" where a published section sits near 0.02. It is the LUMPED
// section loss, and it carries everything the axial blade-element model does
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

// Lift and drag coefficients valid at ANY incidence, which is the whole point:
// a windmilling or stopped blade sits at 60, 90, 130 degrees of angle of
// attack, and a polar that only covers +-15 is what forces a model to clamp
// its thrust at zero and pretend.
export function airfoil(alpha, cd0 = SECTION_DRAG_DEFAULT) {
	const a = Math.abs(alpha);
	const clLinear = CL_SLOPE * Math.sin(alpha);
	const cdLinear = cd0 + CD_INDUCED * clLinear * clLinear;
	const clPlate = (CD_MAX / 2) * Math.sin(2 * alpha);
	const cdPlate = cd0 + CD_MAX * Math.sin(alpha) * Math.sin(alpha);
	if (a <= ALPHA_STALL) return { cl: clLinear, cd: cdLinear };
	if (a >= ALPHA_STALL + BLEND) return { cl: clPlate, cd: cdPlate };
	// Smoothstep across the stall band. A step here would be a torque
	// discontinuity the flight controller would chase.
	const x = (a - ALPHA_STALL) / BLEND;
	const w = x * x * (3 - 2 * x);
	return {
		cl: clLinear * (1 - w) + clPlate * w,
		cd: cdLinear * (1 - w) + cdPlate * w,
	};
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
// straight out of the middle number.
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
	// Bisection, not secant. Thrust is monotone in chord and the torque ratio is
	// monotone in section drag, so bisection cannot diverge; a secant step can,
	// and did — it sent the cinewhoop (whose ducted torqueRatio drives section
	// drag to its ceiling) to nearly twice its own static thrust before this was
	// written this way.
	const wantThrust = profile.maxThrustPerMotor;
	const wantRatio = profile.torqueRatio;
	const staticForces = () => rotorForces(g, profile.maxOmega, 0, 1.225);
	// Bracket first, then bisect. Neither quantity is monotone over the whole
	// range: pile on enough chord and the extra section drag eats the thrust it
	// adds, so the curve turns over. Scanning for the FIRST rising crossing
	// keeps the solve on the branch that means anything, and falling off the end
	// of the scan (the target is simply unreachable) leaves the best value found
	// rather than an arbitrary one.
	const solve = (set, read, want, lo, hi) => {
		const STEPS = 48;
		let a = lo, fa = (set(a), read());
		let bracketed = false;
		for (let i = 1; i <= STEPS; i++) {
			const b = lo * Math.pow(hi / lo, i / STEPS);
			set(b);
			const fb = read();
			if (fa < want && fb >= want) { lo = a; hi = b; bracketed = true; break; }
			a = b; fa = fb;
		}
		if (!bracketed) {
			// Unreachable in this range. Keep whichever end gets closest, and let
			// the caller's own checks say so — a ducted rotor's torque ratio is
			// not blade drag, and the model refusing to fake it is the point.
			let best = lo, err = Infinity;
			for (let i = 0; i <= STEPS; i++) {
				const v = lo * Math.pow(hi / lo, i / STEPS);
				set(v);
				const e = Math.abs(read() - want);
				if (e < err) { err = e; best = v; }
			}
			set(best);
			return;
		}
		for (let k = 0; k < 60; k++) {
			const mid = 0.5 * (lo + hi);
			set(mid);
			if (read() < want) lo = mid; else hi = mid;
		}
		set(0.5 * (lo + hi));
	};
	for (let pass = 0; pass < 40; pass++) {
		solve((v) => { g.chordScale = v; }, () => staticForces().thrust,
			wantThrust, 1e-4, 100);
		solve((v) => { g.cd0 = v; }, () => { const f = staticForces(); return f.torque / f.thrust; },
			wantRatio, 1e-4, SECTION_DRAG_MAX);
	}
	// Chord last, so static thrust is exact even when the torque ratio could not
	// be reached (a duct is not blade drag, and the model is right to refuse).
	solve((v) => { g.chordScale = v; }, () => staticForces().thrust, wantThrust, 1e-4, 100);
	return g;
}

// Thrust and torque for one rotor, in newtons and N.m.
//
// `omega`    rad/s, always >= 0 here: the spin direction is the caller's
//            bookkeeping, not the blade's.
// `vAxial`   the rotor's velocity through the air along its own thrust axis,
//            positive climbing. Descending is negative, and there is nothing
//            special about it in this file.
// `vEdge`    the in-plane component, which only enters the momentum balance
//            (Glauert). It is what makes a rotor in forward flight need less
//            induced velocity for the same thrust.
//
// Thrust comes back NEGATIVE when the blade is being driven by the air rather
// than driving it — a windmilling prop really does pull backwards — and a
// stopped rotor still returns the drag of four stalled blades sitting in the
// flow. Neither was expressible before.
export function rotorForces(g, omega, vAxial, rho = 1.225, vEdge = 0) {
	let thrust = 0;
	let torque = 0;
	const w = Math.abs(omega);
	for (let i = 0; i < ELEMENTS; i++) {
		const r = g.r[i];
		const uT = w * r;
		const chord = g.chord[i] * g.chordScale;
		// Induced velocity, from the momentum balance on this annulus. It is
		// solved only where momentum theory HAS a solution: a rotor that is
		// barely turning, or that the air is driving, is not an actuator disc,
		// and forcing the equation there is how a model ends up with an
		// unbounded inflow correction it has to clamp by hand. Where it does not
		// apply, the blade simply sees the freestream — which for a stopped prop
		// is not an approximation, it is the exact situation.
		// Induced velocity, by BISECTION rather than fixed-point iteration.
		//
		// The residual is monotone, which is what makes this safe: raise vi and
		// the blade element sees more inflow, less angle of attack and makes
		// LESS thrust, while the momentum balance through the annulus demands
		// MORE. One crossing, always, so bisection cannot miss it and cannot
		// oscillate.
		//
		// A relaxed fixed point was tried first and is why this comment exists.
		// It left the solve short of convergence at some operating points, and a
		// half-converged induced velocity does not fail loudly — it puts steps in
		// the thrust surface. Thrust stopped being monotone in blade chord
		// (2.22 N, then 2.09, then 5.51 on the cinewhoop), which broke the
		// calibration above and would have arrived in flight as noise nobody
		// could have traced back to here.
		//
		// Solved only where momentum theory HAS a solution. A rotor that is
		// barely turning, or that the air is driving, is not an actuator disc,
		// and forcing the equation there is how a model ends up with an
		// unbounded inflow correction it has to clamp by hand. Where it does not
		// apply the blade simply sees the freestream — which for a stopped prop
		// is not an approximation, it is the exact situation.
		let vi = 0;
		if (uT > 0.5) {
			const residual = (v) => {
				const uP = vAxial + v;
				const phi = Math.atan2(uP, uT);
				const F = tipLoss(g.blades, r / g.R, phi);
				const { cl, cd } = airfoil(g.twist[i] - phi, g.cd0);
				const u2 = uT * uT + uP * uP;
				const be = g.blades * 0.5 * rho * u2 * chord
					* (cl * Math.cos(phi) - cd * Math.sin(phi)) * g.dr;
				// Glauert: the mass flow is set by the TOTAL velocity at the disc,
				// so translational lift falls out of the same balance.
				const flow = Math.sqrt(vEdge * vEdge + uP * uP);
				const mom = 4 * Math.PI * rho * r * F * g.dr * flow * v;
				return be - mom;
			};
			if (residual(0) > 0) {
				// Bracket upwards until the momentum side wins, then bisect. The
				// tip speed is a hard ceiling: no annulus induces more flow than
				// the blade is moving.
				let hi = 1;
				while (hi < uT && residual(hi) > 0) hi *= 2;
				let lo = 0;
				for (let k = 0; k < 14; k++) {
					const mid = 0.5 * (lo + hi);
					if (residual(mid) > 0) lo = mid; else hi = mid;
				}
				vi = 0.5 * (lo + hi);
			}
		}
		const uP = vAxial + vi;
		const phi = Math.atan2(uP, uT);
		const { cl, cd } = airfoil(g.twist[i] - phi, g.cd0);
		const u2 = uT * uT + uP * uP;
		const q = 0.5 * rho * u2 * chord * g.dr * g.blades;
		thrust += q * (cl * Math.cos(phi) - cd * Math.sin(phi));
		torque += q * r * (cl * Math.sin(phi) + cd * Math.cos(phi));
	}
	return { thrust, torque };
}
