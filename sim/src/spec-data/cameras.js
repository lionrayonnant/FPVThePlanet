// Camera catalogue, spec §12.2 (donnees/cameras.json), 3 entries.
//
// HARDWARE FACTS ONLY: mass and where it moves the centre of gravity. The drag
// it adds (AirFrictionv1add) is an engine tuning value — ./tuning-constants.js.

export const SPEC_CAMERAS = {
	"0": { id: "0", name: "None", massG: 0, cgOffset: 0 },
	"1": { id: "1", name: "Light Action cam", massG: 80, cgOffset: 0 },
	"2": { id: "2", name: "Heavy Action cam", massG: 150, cgOffset: 0 },
};

export const SPEC_CAMERA_IDS = Object.keys(SPEC_CAMERAS);
