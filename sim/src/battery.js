// The battery pack, lifted out of quad.js unchanged.
//
// It lives on its own because it is not aerodynamics: the pack is a voltage
// source with an internal resistance and a charge counter, and quad.js only
// ever asks it for volts. quad.js re-exports it, so no importer had to move.
//
import { DEFAULT_PROFILE } from './drone-profiles.js';
import { lipoDischarge, liionDischarge, batteryDrainByDiameter } from './curves.js';

// The two discharge curves of spec §10/§11, by the name a profile asks for.
// `legacy` is the analytic curve this file used before the spec's data arrived,
// kept so a bench can prove the rest of the model did not move underneath it.
const DISCHARGE = {
	lipo: lipoDischarge,
	liion: liionDischarge,
	legacy: null,
};

export const DEFAULT_DISCHARGE = 'lipo';

// THE AXIS OF THE DISCHARGE CURVES IS CAPACITY CONSUMED, 0..1 and beyond.
// `donnees/courbes.json` labels it `capacite_restante_0_1` — remaining — and
// that label is simply wrong: the keys run 0 -> 4.2 V and 1.05 -> 0 V, which is
// a pack that empties as x grows. §11's prose ("capacité consommée") is right.
// Reading the label instead of the keys puts a full pack at 0 V.
export function cellVolts(curve, consumed) {
	return curve.eval(consumed);
}

// §10's `consommation_batterie`: a drain coefficient indexed by prop diameter
// in inches, stating that a 2" empties its pack about 6x faster per unit of
// capacity than a 10". Normalised against the 5" key so the reference build is
// unscaled and the number reads as "relative to a 5"".
//
// IT IS NOT WIRED IN BY DEFAULT, and that is a judgement call worth stating.
// This model already counts coulombs: `update()` is handed the real summed pack
// current that the four windings drew, from the torque balance in motor.js, so
// the fact that a 2" empties a pack faster is already an OUTPUT of the physics
// rather than something to be asserted on top of it. Multiplying by this
// coefficient as well would count the prop size twice. It is exported, and a
// profile can opt in with `battery.drainScale`, for the case where a family's
// pack life has to be pinned to a measured figure the physics does not reach.
// Whether a pack empties at all, anywhere in the game.
//
// FALSE, and deliberately: a sortie is not ended by its battery. The coulomb
// count below is real, measured from the winding current and covered by
// tools/motor-selftest.mjs — it is simply not consumed. Everything that makes a
// pack feel like a pack is unaffected, because all of it is sag: pull hard and
// the terminal voltage drops, the rpm droops for it, and the punch-out costs
// what it costs. What goes away is only the clock.
//
// Flipping this to true restores a bounded sortie, and the machinery is all
// still here and still tested: the two discharge curves, the capacity gauge in
// the OSD, and the BENCH panel's BATTERY toggle, which is this same switch.
export const PACK_DRAINS = false;

export function drainScaleForDiameter(inches) {
	const ref = batteryDrainByDiameter.eval(5);
	return batteryDrainByDiameter.eval(inches) / ref;
}

// Battery: a 4S 1300 mAh pack. Sag under load is not a detail — a punch-out
// pulls ~100 A and drops the pack over a volt, which is exactly the "it runs
// out of top end at the end of the pack" feeling.

export class Battery {
	constructor(spec = DEFAULT_PROFILE.battery) {
		this.cells = spec.cells;
		this.capacityMah = spec.capacityMah;
		this.internalOhm = spec.internalOhm;
		this.maxCurrent = spec.maxCurrent;   // A at four motors flat out
		// Which chemistry's discharge curve (§10). 'lipo' by default: both
		// curves put a full cell at exactly 4.2 V, the same place the analytic
		// curve started, so a full pack is bit-identical to before.
		this.chemistry = spec.dischargeCurve ?? DEFAULT_DISCHARGE;
		this.curve = DISCHARGE[this.chemistry] ?? null;
		// Opt-in multiplier on the coulomb count, see drainScaleForDiameter().
		this.drainScale = spec.drainScale > 0 ? spec.drainScale : 1;
		// Whether the pack actually empties. See PACK_DRAINS: off by default, so
		// the charge is decorative and NOTHING else changes — sag under load is
		// instantaneous and physical, so it stays. A held pack still bends when
		// you pull on it, it just never runs out. Off is also the bench's
		// BATTERY HELD (PHASE 26), which is the same switch.
		this.drain = PACK_DRAINS;
		this.reset();
	}

	// `reset()` deliberately does not touch `drain`: it is a bench setting for
	// the session, not part of the pack's state, and a respawn must not
	// silently hand the charge back to the physics.
	reset() {
		this.usedMah = 0;
		this.current = 0;
		this.voltage = this.openCircuit();
	}

	setDrain(enabled) {
		this.drain = enabled !== false;
		return this;
	}

	get soc() { return Math.max(0, 1 - this.usedMah / this.capacityMah); }

	// Capacity CONSUMED, the axis the spec's two discharge curves are keyed on.
	// Not clamped at 1 the way `soc` is: the curves carry a key at 1.05 and a
	// pack driven past its rating is a pack at 0 V, not a pack at its last key.
	get consumed() { return this.usedMah / this.capacityMah; }

	// Per-cell open-circuit voltage. The keyed curve of §11 where the profile
	// names a chemistry; the old analytic curve under 'legacy'.
	//
	// The analytic form it replaces was `3.75 + 0.45*((s-0.2)/0.8)^0.75` above
	// 20% and a straight line below — a plausible shape, but a shape, with no
	// cell behind it. The keyed curves are data: the lipo one holds 3.8-3.85
	// through the middle of the pack and then falls off a cliff at 95%, which
	// is the part a pilot actually feels, and the li-ion one sags early and then
	// holds, which is why a long-range pack behaves nothing like a race pack.
	openCircuit() {
		if (!this.curve) {
			const s = this.soc;
			const cell = s > 0.2
				? 3.75 + 0.45 * ((s - 0.2) / 0.8) ** 0.75
				: 3.4 + 0.35 * (s / 0.2);
			return cell * this.cells;
		}
		return cellVolts(this.curve, this.consumed) * this.cells;
	}

	// `current` is the real summed winding current of the four motors, from the
	// torque balance in src/motor.js. It used to be `maxCurrent * min(1,
	// load/4)` off a cube-of-rpm proxy — a second fit standing next to the
	// motor fit, with nothing tying the two together. Now the pack sags because
	// of the amps the windings are actually drawing.
	update(current, dt) {
		this.current = current;
		// The floor is on SAG, not on the pack: it stops a punch-out from
		// dragging the terminal voltage through the floor, but it must never
		// hold the pack up above its own open-circuit curve. The lipo curve
		// reaches 2.0 V per cell at 99% consumed and has to be allowed to.
		const ocv = this.openCircuit();
		const floor = Math.min(ocv, this.cells * 3.0);
		this.voltage = Math.max(floor, ocv - this.current * this.internalOhm);
		if (this.drain) this.usedMah += (this.drainScale * this.current * dt * 1000) / 3600;
		return this.voltage;
	}
}
