// Motor catalogue, spec §12.2 (donnees/moteurs.json), 21 entries.
//
// HARDWARE FACTS ONLY: what a part number tells you. The engine-side tuning
// values that ship alongside these entries in the source data
// (InstantPower, MinThrottle, Low/Medium/HighThrottle) live in
// ./tuning-constants.js and must be recalibrated, not trusted.
//
// `kv` is in rpm per volt, RAW — the spec warns (§13, "erreurs classiques")
// that DroneSettings.MotorsKV is in THOUSANDS while the catalogue is in units.
// Nothing here is in thousands.

export const SPEC_MOTORS = {
	"8000-1103": { id: "8000-1103", name: "1103 - 8000kv", massG: 5, kv: 8000, propSizeMin: 1, propSizeMax: 2.5 },
	"11000-1103": { id: "11000-1103", name: "1103 - 11000kv", massG: 5, kv: 11000, propSizeMin: 1, propSizeMax: 2.5 },
	"6000-1106": { id: "6000-1106", name: "1106 - 6000kv", massG: 7, kv: 6000, propSizeMin: 1, propSizeMax: 2.5 },
	"8000-1106": { id: "8000-1106", name: "1106 - 8000kv", massG: 7, kv: 8000, propSizeMin: 1, propSizeMax: 2.5 },
	"10000-1106": { id: "10000-1106", name: "1106 - 10000kv", massG: 7, kv: 10000, propSizeMin: 1, propSizeMax: 2.5 },
	"3800-1404": { id: "3800-1404", name: "1404 - 3800kv", massG: 9, kv: 3800, propSizeMin: 3, propSizeMax: 3.5999999046325684 },
	"4150-1404": { id: "4150-1404", name: "1404 - 4150kv", massG: 9, kv: 4150, propSizeMin: 3, propSizeMax: 3.5999999046325684 },
	"4500-1404": { id: "4500-1404", name: "1404 - 4500kv", massG: 9, kv: 4500, propSizeMin: 3, propSizeMax: 3.5999999046325684 },
	"3700-1408": { id: "3700-1408", name: "1408 - 3700kv", massG: 15, kv: 3700, propSizeMin: 3, propSizeMax: 4.099999904632568 },
	"3900-1408": { id: "3900-1408", name: "1408 - 3900kv", massG: 15, kv: 3900, propSizeMin: 3, propSizeMax: 4.099999904632568 },
	"3450-1804": { id: "3450-1804", name: "1804 - 3450kv", massG: 13, kv: 3450, propSizeMin: 3, propSizeMax: 4.599999904632568 },
	"3800-1804": { id: "3800-1804", name: "1804 - 3800kv", massG: 13, kv: 3800, propSizeMin: 3, propSizeMax: 4.599999904632568 },
	"1750-2306": { id: "1750-2306", name: "2306 - 1750kv", massG: 33, kv: 1750, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"1900-2207": { id: "1900-2207", name: "2207 - 1900kv", massG: 34, kv: 1900, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"2000-2207": { id: "2000-2207", name: "2207 - 2000kv", massG: 34, kv: 2000, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"2500-2306": { id: "2500-2306", name: "2306 - 2500kv", massG: 33, kv: 2500, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"2700-2207": { id: "2700-2207", name: "2207 - 2700kv", massG: 34, kv: 2700, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"2800-2306": { id: "2800-2306", name: "2306 - 2800kv", massG: 33, kv: 2800, propSizeMin: 4.400000095367432, propSizeMax: 8 },
	"1300-2807": { id: "1300-2807", name: "2806.5 - 1300kv", massG: 47, kv: 1300, propSizeMin: 6, propSizeMax: 8.100000381469727 },
	"1500-2807": { id: "1500-2807", name: "2806.5 - 1500kv", massG: 47, kv: 1500, propSizeMin: 6, propSizeMax: 8.100000381469727 },
	"1700-2807": { id: "1700-2807", name: "2806.5 - 1700kv", massG: 47, kv: 1700, propSizeMin: 6, propSizeMax: 8.100000381469727 },
};

export const SPEC_MOTOR_IDS = Object.keys(SPEC_MOTORS);
