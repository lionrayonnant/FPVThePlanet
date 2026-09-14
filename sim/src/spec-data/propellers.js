// Propeller catalogue, spec §12.2 (donnees/helices.json), 20 entries.
//
// HARDWARE FACTS ONLY. AirGrip / RelativeAirSpeed / InstantPower are engine
// tuning values and live in ./tuning-constants.js.
//
// Diameter and pitch are in INCHES, as the part number reads them (a "5043"
// is 5.0 x 4.3). quad.js works in metres: multiply by 0.0254.

export const SPEC_PROPELLERS = {
	"2023": { id: "2023", name: "2\" 2023", massG: 1, diameterIn: 2, pitchIn: 2.299999952316284 },
	"2040": { id: "2040", name: "2\" 2040", massG: 1, diameterIn: 2, pitchIn: 4 },
	"2520": { id: "2520", name: "2.5\" 2520", massG: 1, diameterIn: 2.5, pitchIn: 2 },
	"2521": { id: "2521", name: "2.5\" 2521", massG: 1, diameterIn: 2.5, pitchIn: 2.0999999046325684 },
	"3020": { id: "3020", name: "3\" 3020", massG: 2, diameterIn: 3, pitchIn: 2 },
	"3028": { id: "3028", name: "3\" 3028", massG: 2, diameterIn: 3, pitchIn: 2.799999952316284 },
	"3140": { id: "3140", name: "3\" 3140", massG: 2, diameterIn: 3, pitchIn: 4 },
	"3520": { id: "3520", name: "3.5\" 3520", massG: 2, diameterIn: 3.5, pitchIn: 2 },
	"3630": { id: "3630", name: "3.5\" 3630", massG: 2, diameterIn: 3.5, pitchIn: 3 },
	"4025": { id: "4025", name: "4\" 4025", massG: 2, diameterIn: 4, pitchIn: 2.5 },
	"4052": { id: "4052", name: "4\" 4052", massG: 2, diameterIn: 4, pitchIn: 5.199999809265137 },
	"5043": { id: "5043", name: "5\" 5043", massG: 4, diameterIn: 5, pitchIn: 4.300000190734863 },
	"5129": { id: "5129", name: "5\" 5129", massG: 4, diameterIn: 5, pitchIn: 2.9000000953674316 },
	"5136": { id: "5136", name: "5\" 5136 freestyle", massG: 4, diameterIn: 5, pitchIn: 3.5999999046325684 },
	"5146": { id: "5146", name: "5\" 5146 race", massG: 4, diameterIn: 5, pitchIn: 4.599999904632568 },
	"6030": { id: "6030", name: "6\" 6030", massG: 7, diameterIn: 6, pitchIn: 3 },
	"6045": { id: "6045", name: "6\" 6045", massG: 7, diameterIn: 6, pitchIn: 4.5 },
	"7037": { id: "7037", name: "7\" 7037", massG: 8, diameterIn: 7, pitchIn: 3.5999999046325684 },
	"7050": { id: "7050", name: "7\" 7050", massG: 8, diameterIn: 7, pitchIn: 5 },
	"7055": { id: "7055", name: "7\" 7055", massG: 8, diameterIn: 7, pitchIn: 5.5 },
};

export const SPEC_PROPELLER_IDS = Object.keys(SPEC_PROPELLERS);

export const INCH = 0.0254;
