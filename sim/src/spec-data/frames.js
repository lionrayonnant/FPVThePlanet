// Frame catalogue, spec §12.2 (donnees/chassis.json), 13 entries.
//
// HARDWARE FACTS ONLY: mass, the prop sizes the frame accepts, and where the
// camera sits. The drag coefficients (CX_face/top/side/diag, AirFrictionV1)
// are engine tuning values — ./tuning-constants.js.
//
// cameraOffset is the source engine's translation in CENTIMETRES and in ITS
// axes; this sim is metres and ENU (CLAUDE.md). Converting it is the caller's
// job, and is why it is stored verbatim rather than pre-converted.

export const SPEC_FRAMES = {
	"Tiny2": { id: "Tiny2", name: "2\" Tiny85", massG: 30, defaultPropSize: 2, minPropSize: 1.5, maxPropSize: 2, hdCamera: false, cameraOffset: { x: 0, y: 6.453125, z: -3.363037109375 } },
	"KM_2-5": { id: "KM_2-5", name: "2.5\" Kayoumini", massG: 44, defaultPropSize: 2.5, minPropSize: 2, maxPropSize: 2.509999990463257, hdCamera: false, cameraOffset: { x: 0, y: 4.478516101837158, z: -1.7927249670028687 } },
	"Racer3": { id: "Racer3", name: "3\" micro racer", massG: 110, defaultPropSize: 3, minPropSize: 2.5, maxPropSize: 3.0999999046325684, hdCamera: false, cameraOffset: { x: 0, y: 4.9013671875, z: -1.6860350370407104 } },
	"Micro3": { id: "Micro3", name: "3\" micro", massG: 148, defaultPropSize: 3, minPropSize: 2.5, maxPropSize: 3.0999999046325684, hdCamera: true, cameraOffset: { x: 0, y: 2.686522960662842, z: -2.44775390625 } },
	"Micro3_PG": { id: "Micro3_PG", name: "3\" whoop", massG: 233, defaultPropSize: 3, minPropSize: 2.5, maxPropSize: 3.0999999046325684, hdCamera: true, cameraOffset: { x: 0, y: 2.686522960662842, z: -2.44775390625 } },
	"Mini35": { id: "Mini35", name: "3.5\" mini", massG: 152, defaultPropSize: 3.5, minPropSize: 3, maxPropSize: 3.5999999046325684, hdCamera: true, cameraOffset: { x: 0, y: 2.686522960662842, z: -2.44775390625 } },
	"Mini4": { id: "Mini4", name: "4\" mini", massG: 155, defaultPropSize: 4, minPropSize: 3, maxPropSize: 4.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: 2.686522960662842, z: -2.44775390625 } },
	"racer5": { id: "racer5", name: "5\" Racer", massG: 180, defaultPropSize: 5, minPropSize: 3, maxPropSize: 5.099999904632568, hdCamera: false, cameraOffset: { x: 0, y: 4.994141101837158, z: -2.719481945037842 } },
	"Free5": { id: "Free5", name: "5\" Freestyle", massG: 280, defaultPropSize: 5, minPropSize: 3, maxPropSize: 5.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: 0.6992189884185791, z: -2.021239995956421 } },
	"KD_5": { id: "KD_5", name: "5\" Kayoudur", massG: 317, defaultPropSize: 5, minPropSize: 3, maxPropSize: 5.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: 1.5380860567092896, z: -2.705322027206421 } },
	"Free6": { id: "Free6", name: "6\" Freestyle", massG: 300, defaultPropSize: 6, minPropSize: 3, maxPropSize: 6.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: 0.6992189884185791, z: -2.021239995956421 } },
	"Light7": { id: "Light7", name: "7\" light", massG: 350, defaultPropSize: 7, minPropSize: 4.900000095367432, maxPropSize: 7.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: 0.38476601243019104, z: -2.044922113418579 } },
	"KL_7": { id: "KL_7", name: "7\" Kayouloin", massG: 420, defaultPropSize: 7, minPropSize: 4.900000095367432, maxPropSize: 7.099999904632568, hdCamera: true, cameraOffset: { x: 0, y: -1.121093988418579, z: -2.470702886581421 } },
};

export const SPEC_FRAME_IDS = Object.keys(SPEC_FRAMES);
