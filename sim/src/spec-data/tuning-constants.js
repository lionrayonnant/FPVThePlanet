// TUNING VALUES, NOT FACTS. Read this header before using anything below.
//
// The spec's catalogue (§12.1, §12.2) mixes two kinds of number in the same
// record. One kind is hardware: a 1103 weighs 5 g, a 5043 is five inches
// across, a 4S pack has four cells. Those are in ./motors.js, ./propellers.js,
// ./frames.js, ./batteries.js, ./cameras.js, and they are true regardless of
// which simulator reads them.
//
// The other kind is what is here: AirGrip, InstantPower, RelativeAirSpeed,
// MinThrottle, Low/Medium/HighThrottle, the CX_* drag coefficients,
// AirFrictionV1, LinearDamp, AngleFPVCam, PID/PIDamount/PropwashAmount. Those
// are COEFFICIENTS OF THE SOURCE ENGINE'S FLIGHT MODEL. They mean something
// only inside the formulas of spec §6-§9, in that engine's units (centimetres,
// gravity through x(-100)). This sim does not use those formulas: its
// propulsion is a rotor model with measured kThrust/kInflow/kLateral and a
// motor torque balance (src/quad.js, src/motor.js), and its PID blocks are
// written by tools/tune-pid.mjs against each family's own plant, never by hand
// (CLAUDE.md).
//
// So: transcribed for completeness and for round-tripping the source data
// (criterion 1), usable as a STARTING POINT for a calibration pass, never as a
// value to paste into a profile. Anything that reads a number from this file
// and calls it physics is wrong.

// ---------------------------------------------------------------------------
// Per-preset tuning, keyed like SPEC_PRESETS in ./presets.js.
export const PRESET_TUNING = {
	"All_default": {
		linearDamp: 0.4000000059604645,
		angleFpvCam: -100,
		airGrip: 0.800000011920929,
		relativeAirSpeed: 1,
		minThrottle: 5.5,
		lowThrottle: 1,
		mediumThrottle: 1,
		highThrottle: 1,
		instantPower: 1,
		pid: 0,
		pidAmount: 0,
		propwashAmount: 0,
		physicsVersion: "V2",
		simple0Adv1: 0,
		cxFace: 0.4000000059604645,
		cxTop: 0.4000000059604645,
		cxSide: 0.4000000059604645,
		cxDiag: 0.4000000059604645,
	},
	"5free": {
		linearDamp: 0.4000000059604645,
		angleFpvCam: -100,
		airGrip: 1.4500000476837158,
		relativeAirSpeed: 1,
		minThrottle: 5.5,
		lowThrottle: 1,
		mediumThrottle: 1,
		highThrottle: 1,
		instantPower: 1,
		pid: 0,
		pidAmount: 0,
		propwashAmount: 0,
		physicsVersion: "V2",
		simple0Adv1: 0,
		cxFace: 0.4000000059604645,
		cxTop: 0.4000000059604645,
		cxSide: 0.4000000059604645,
		cxDiag: 0.4000000059604645,
	},
	"5Race": {
		linearDamp: 0.3199999928474426,
		angleFpvCam: -100,
		airGrip: 1.100000023841858,
		relativeAirSpeed: 1,
		minThrottle: 5.5,
		lowThrottle: 1,
		mediumThrottle: 1,
		highThrottle: 1,
		instantPower: 0.75,
		pid: 0,
		pidAmount: 0,
		propwashAmount: 0,
		physicsVersion: "V2",
		simple0Adv1: 0,
		cxFace: 0.4000000059604645,
		cxTop: 0.4000000059604645,
		cxSide: 0.4000000059604645,
		cxDiag: 0.4000000059604645,
	},
	"3Cinewhoop": {
		linearDamp: 0.5,
		angleFpvCam: -100,
		airGrip: 0.800000011920929,
		relativeAirSpeed: 1,
		minThrottle: 5.5,
		lowThrottle: 1,
		mediumThrottle: 1,
		highThrottle: 1,
		instantPower: 1,
		pid: 0,
		pidAmount: 0,
		propwashAmount: 0,
		physicsVersion: "V2",
		simple0Adv1: 0,
		cxFace: 0.4000000059604645,
		cxTop: 0.4000000059604645,
		cxSide: 0.4000000059604645,
		cxDiag: 0.4000000059604645,
	},
	"3free": {
		linearDamp: 0.15000000596046448,
		angleFpvCam: -100,
		airGrip: 0.800000011920929,
		relativeAirSpeed: 1,
		minThrottle: 5.5,
		lowThrottle: 1,
		mediumThrottle: 1,
		highThrottle: 1,
		instantPower: 1.7000000476837158,
		pid: 0,
		pidAmount: 0,
		propwashAmount: 0,
		physicsVersion: "V2",
		simple0Adv1: 0,
		cxFace: 0.4000000059604645,
		cxTop: 0.4000000059604645,
		cxSide: 0.4000000059604645,
		cxDiag: 0.4000000059604645,
	},
};

// ---------------------------------------------------------------------------
// Per-motor tuning (source moteurs.json).
export const MOTOR_TUNING = {
	"8000-1103": { instantPower: 0.4000000059604645, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"11000-1103": { instantPower: 0.6000000238418579, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"6000-1106": { instantPower: 1, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"8000-1106": { instantPower: 0.699999988079071, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"10000-1106": { instantPower: 0.800000011920929, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"3800-1404": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"4150-1404": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"4500-1404": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"3700-1408": { instantPower: 0.6499999761581421, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"3900-1408": { instantPower: 0.6499999761581421, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"3450-1804": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"3800-1804": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"1750-2306": { instantPower: 0.4000000059604645, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"1900-2207": { instantPower: 0.550000011920929, minThrottle: 5.5, lowThrottle: 0.949999988079071, mediumThrottle: 0.949999988079071, highThrottle: 1.0499999523162842 },
	"2000-2207": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 0.949999988079071, mediumThrottle: 0.949999988079071, highThrottle: 1.0800000429153442 },
	"2500-2306": { instantPower: 0.5, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"2700-2207": { instantPower: 0.6000000238418579, minThrottle: 5.5, lowThrottle: 0.949999988079071, mediumThrottle: 0.949999988079071, highThrottle: 1.034999966621399 },
	"2800-2306": { instantPower: 0.550000011920929, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"1300-2807": { instantPower: 0, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"1500-2807": { instantPower: 0, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
	"1700-2807": { instantPower: 0.20000000298023224, minThrottle: 5.5, lowThrottle: 1, mediumThrottle: 1, highThrottle: 1 },
};

// ---------------------------------------------------------------------------
// Per-propeller tuning (source helices.json).
export const PROPELLER_TUNING = {
	"2023": { airGrip: 0.6000000238418579, relativeAirSpeed: 1, instantPower: 0.4000000059604645 },
	"2040": { airGrip: 0.800000011920929, relativeAirSpeed: 1, instantPower: 0.4000000059604645 },
	"2520": { airGrip: 0.4000000059604645, relativeAirSpeed: 1.100000023841858, instantPower: 0.4000000059604645 },
	"2521": { airGrip: 0.4000000059604645, relativeAirSpeed: 1.0800000429153442, instantPower: 0.30000001192092896 },
	"3020": { airGrip: 1, relativeAirSpeed: 1, instantPower: 0.949999988079071 },
	"3028": { airGrip: 1.2999999523162842, relativeAirSpeed: 1, instantPower: 0.3499999940395355 },
	"3140": { airGrip: 1.5, relativeAirSpeed: 1, instantPower: 0.4000000059604645 },
	"3520": { airGrip: 0.800000011920929, relativeAirSpeed: 1, instantPower: 0.5 },
	"3630": { airGrip: 0.800000011920929, relativeAirSpeed: 1, instantPower: 0.5 },
	"4025": { airGrip: 0.800000011920929, relativeAirSpeed: 1, instantPower: 0.5 },
	"4052": { airGrip: 0.699999988079071, relativeAirSpeed: 1, instantPower: 0.5 },
	"5043": { airGrip: 0.6000000238418579, relativeAirSpeed: 1, instantPower: 0.5 },
	"5129": { airGrip: 1, relativeAirSpeed: 1, instantPower: 0.6000000238418579 },
	"5136": { airGrip: 0.4000000059604645, relativeAirSpeed: 1, instantPower: 0.5 },
	"5146": { airGrip: 0.8500000238418579, relativeAirSpeed: 1, instantPower: 0.75 },
	"6030": { airGrip: 0.6000000238418579, relativeAirSpeed: 1, instantPower: 0.5 },
	"6045": { airGrip: 0.6000000238418579, relativeAirSpeed: 1, instantPower: 0 },
	"7037": { airGrip: 0.25, relativeAirSpeed: 1, instantPower: 0 },
	"7050": { airGrip: 0.25, relativeAirSpeed: 1, instantPower: 0 },
	"7055": { airGrip: 0.25, relativeAirSpeed: 1, instantPower: 0 },
};

// ---------------------------------------------------------------------------
// Per-frame tuning (source chassis.json). CX_* are the four drag coefficients
// of the source engine's box model; AirFrictionV1 belongs to its older V1
// physics path.
export const FRAME_TUNING = {
	"Tiny2": { cxFace: 0.44999998807907104, cxTop: 0.3199999928474426, cxSide: 0.4000000059604645, cxDiag: 0.4000000059604645, airFrictionV1: 0.5 },
	"KM_2-5": { cxFace: 0.5440000295639038, cxTop: 0.37299999594688416, cxSide: 0.46799999475479126, cxDiag: 0.4230000078678131, airFrictionV1: 0.3799999952316284 },
	"Racer3": { cxFace: 0.38999998569488525, cxTop: 0.3700000047683716, cxSide: 0.3700000047683716, cxDiag: 0.3700000047683716, airFrictionV1: 0.3499999940395355 },
	"Micro3": { cxFace: 0.4000000059604645, cxTop: 0.3799999952316284, cxSide: 0.3799999952316284, cxDiag: 0.3799999952316284, airFrictionV1: 0.4099999964237213 },
	"Micro3_PG": { cxFace: 0.3799999952316284, cxTop: 0.36000001430511475, cxSide: 0.36000001430511475, cxDiag: 0.33000001311302185, airFrictionV1: 0.47999998927116394 },
	"Mini35": { cxFace: 0.4000000059604645, cxTop: 0.3799999952316284, cxSide: 0.3799999952316284, cxDiag: 0.3799999952316284, airFrictionV1: 0.4000000059604645 },
	"Mini4": { cxFace: 0.41999998688697815, cxTop: 0.3799999952316284, cxSide: 0.3799999952316284, cxDiag: 0.3799999952316284, airFrictionV1: 0.3799999952316284 },
	"racer5": { cxFace: 0.3400000035762787, cxTop: 0.3199999928474426, cxSide: 0.3199999928474426, cxDiag: 0.3199999928474426, airFrictionV1: 0.3199999928474426 },
	"Free5": { cxFace: 0.41999998688697815, cxTop: 0.3799999952316284, cxSide: 0.3799999952316284, cxDiag: 0.3799999952316284, airFrictionV1: 0.3799999952316284 },
	"KD_5": { cxFace: 0.41999998688697815, cxTop: 0.3799999952316284, cxSide: 0.3799999952316284, cxDiag: 0.3799999952316284, airFrictionV1: 0.38999998569488525 },
	"Free6": { cxFace: 0.3700000047683716, cxTop: 0.3499999940395355, cxSide: 0.3499999940395355, cxDiag: 0.3499999940395355, airFrictionV1: 0.3499999940395355 },
	"Light7": { cxFace: 0.3499999940395355, cxTop: 0.36000001430511475, cxSide: 0.36000001430511475, cxDiag: 0.33000001311302185, airFrictionV1: 0.33000001311302185 },
	"KL_7": { cxFace: 0.3199999928474426, cxTop: 0.33000001311302185, cxSide: 0.3400000035762787, cxDiag: 0.3100000023841858, airFrictionV1: 0.38999998569488525 },
};

// ---------------------------------------------------------------------------
// Per-camera tuning (source cameras.json).
export const CAMERA_TUNING = {
	"0": { airFrictionV1Add: 0 },
	"1": { airFrictionV1Add: 0.019999999552965164 },
	"2": { airFrictionV1Add: 0.029999999329447746 },
};
