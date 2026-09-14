// The FPV flight-physics specification's own data, as JS modules
// (SPEC_PHYSIQUE_VOL.md §12.1 and §12.2). Nothing here is wired into the sim
// yet: it is reference data the acceptance benches measure the sim against.
//
// The split that matters, and the one the source JSON does not make:
//
//   FACTS      ./motors.js ./propellers.js ./frames.js ./batteries.js
//              ./cameras.js ./presets.js — mass, KV, diameter, pitch, cells,
//              capacity, C rating, fitment windows. True of the hardware.
//
//   TUNING     ./tuning-constants.js — AirGrip, InstantPower,
//              RelativeAirSpeed, Low/Medium/HighThrottle, CX_*, LinearDamp.
//              Coefficients of the SOURCE ENGINE's flight model, meaningful
//              only inside its formulas and its units. To be recalibrated,
//              never pasted into a profile. That file says so at length.
export * from './motors.js';
export * from './propellers.js';
export * from './frames.js';
export * from './batteries.js';
export * from './cameras.js';
export * from './presets.js';
export { PRESET_TUNING, MOTOR_TUNING, PROPELLER_TUNING, FRAME_TUNING, CAMERA_TUNING } from './tuning-constants.js';

import { SPEC_PRESETS, SPEC_PRESET_FIELD_ORDER } from './presets.js';
import { PRESET_TUNING } from './tuning-constants.js';

// Criterion 1 (§13): "the five presets load and re-serialise identically".
// Reassembles one preset into the source record, field order included, from the
// two halves it was split into. A round trip that only reads back what one
// module wrote proves nothing; this one has to put the split back together, so
// a field dropped on either side shows up as a missing key.
export function specPresetRecord(key) {
	const p = SPEC_PRESETS[key];
	const t = PRESET_TUNING[key];
	if (!p || !t) return null;
	const byField = {
		MotorsKV: p.motorsKvThousands,
		BatteryCells: p.batteryCells,
		PropellerPitch: p.propellerPitch,
		DroneMass: p.mass,
		Gravity: p.gravity,
		LinearDamp: t.linearDamp,
		AngleFPVCam: t.angleFpvCam,
		AirGrip: t.airGrip,
		RelativeAirSpeed: t.relativeAirSpeed,
		MinThrottle: t.minThrottle,
		LowThrottle: t.lowThrottle,
		MediumThrottle: t.mediumThrottle,
		HighThrottle: t.highThrottle,
		PropSize: p.propSize,
		InstantPower: t.instantPower,
		DisplayName: p.displayName,
		PID: t.pid,
		PIDamount: t.pidAmount,
		PropwashAmount: t.propwashAmount,
		PhysicsVersion: t.physicsVersion,
		Simple0_Adv1: t.simple0Adv1,
		CXFace: t.cxFace,
		CxTop: t.cxTop,
		CXSide: t.cxSide,
		CXDiag: t.cxDiag,
	};
	// Insertion order = the spec's own field order, so JSON.stringify of the
	// result is comparable key-by-key with the source.
	const out = {};
	for (const f of SPEC_PRESET_FIELD_ORDER) out[f] = byField[f];
	return out;
}

// What §12.2 says the catalogue holds. Stated here so a transcription that
// silently lost an entry fails a check instead of quietly shrinking.
export const SPEC_COUNTS = {
	presets: 5, motors: 21, propellers: 20, frames: 13, batteries: 17, cameras: 3,
};
