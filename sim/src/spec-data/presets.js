// The five reference flight presets, spec §12.1 (donnees/presets_vol.json).
// They are the spec's own test set: §13 criterion 1 is that they load and
// re-serialise identically, which tools/spec-data-selftest.mjs checks against
// the source JSON when it is reachable.
//
// HARDWARE FACTS ONLY here. Every field of a preset that is a TUNING value —
// AirGrip, InstantPower, RelativeAirSpeed, LinearDamp, MinThrottle,
// Low/Medium/HighThrottle, the CX_* drag coefficients, the PID block — lives in
// ./tuning-constants.js under PRESET_TUNING, keyed the same way.
//
// UNITS, and the trap the spec itself flags (§13, "erreurs classiques"):
// `motorsKvThousands` is verbatim the source field `MotorsKV`, which is in
// THOUSANDS of rpm per volt. Use motorKv() to get rpm/V. propSize and
// propellerPitch are inches. mass is kg. gravity is m/s², positive.

export const SPEC_PRESETS = {
	"All_default": {
		key: "All_default",
		displayName: "All default",
		motorsKvThousands: 1.75,
		batteryCells: 6,
		propSize: 5,
		propellerPitch: 4.300000190734863,
		mass: 0.7149999737739563,
		gravity: 9.819999694824219,
	},
	"5free": {
		key: "5free",
		displayName: "5\" freestyle",
		motorsKvThousands: 1.75,
		batteryCells: 6,
		propSize: 5,
		propellerPitch: 3.700000047683716,
		mass: 0.7149999737739563,
		gravity: 9.819999694824219,
	},
	"5Race": {
		key: "5Race",
		displayName: "5\" race",
		motorsKvThousands: 1.899999976158142,
		batteryCells: 6,
		propSize: 5,
		propellerPitch: 4.300000190734863,
		mass: 0.7149999737739563,
		gravity: 9.819999694824219,
	},
	"3Cinewhoop": {
		key: "3Cinewhoop",
		displayName: "3\" cinewhoop",
		motorsKvThousands: 1.600000023841858,
		batteryCells: 6,
		propSize: 3,
		propellerPitch: 3,
		mass: 0.7149999737739563,
		gravity: 9.819999694824219,
	},
	"3free": {
		key: "3free",
		displayName: "3\" freestyle",
		motorsKvThousands: 1.7000000476837158,
		batteryCells: 6,
		propSize: 3,
		propellerPitch: 3,
		mass: 0.7149999737739563,
		gravity: 9.819999694824219,
	},
};

export const SPEC_PRESET_KEYS = Object.keys(SPEC_PRESETS);

// rpm per volt, the unit every motor datasheet uses and the one the catalogue
// in ./motors.js is written in.
export function motorKv(preset) { return preset.motorsKvThousands * 1000; }

// Field order of the source records, needed to re-serialise byte-for-byte
// (criterion 1). Verbatim `champs_ordonnes` from presets_vol.json.
export const SPEC_PRESET_FIELD_ORDER = [
 "MotorsKV",
 "BatteryCells",
 "PropellerPitch",
 "DroneMass",
 "Gravity",
 "LinearDamp",
 "AngleFPVCam",
 "AirGrip",
 "RelativeAirSpeed",
 "MinThrottle",
 "LowThrottle",
 "MediumThrottle",
 "HighThrottle",
 "PropSize",
 "InstantPower",
 "DisplayName",
 "PID",
 "PIDamount",
 "PropwashAmount",
 "PhysicsVersion",
 "Simple0_Adv1",
 "CXFace",
 "CxTop",
 "CXSide",
 "CXDiag"
];
