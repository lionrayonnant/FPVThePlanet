// One menu direction out of a controller, for every screen menu-nav.js drives.
// PURE: it is handed the signals it needs and calls no navigator, which is what
// makes it replayable in tools/menu-nav-selftest.mjs.
//
// `axes`: { x, y } already normalised to -1..1. They are the ROLL and PITCH
// channels, read through the same calibrated path as the flight — the only two
// that self-centre on every device, a radio included. Reading axes 0 and 1 raw
// was the bug: on an EdgeTX radio in standard mapping axis 1 can be the THROTTLE
// stick, which stays where it is left, and the cursor then walked one way and
// never came back.
//
// SIGN CONVENTION: `y` is pitch, -1 with the stick pushed FORWARD (see
// GAMEPAD_MAP in input.js), and a stick pushed forward moves the cursor UP.
//
// `buttons`: the pad's button array, for the D-pad (12-15), or null when there
// is none.
//
// `prev`: the direction returned last call — anti-repeat, without which a stick
// held off centre would spam the same direction at every poll. Returns
// 'up'|'right'|'down'|'left' (a NEW direction), '__hold' (the same direction
// still held, to be ignored), or null (nothing active).
export function readGamepadDir(prev, axes = null, buttons = null) {
	const x = axes?.x ?? 0;
	const y = axes?.y ?? 0;
	const b = buttons ?? [];
	let dir = null;
	if (b[12]?.pressed || y < -0.5) dir = 'up';
	else if (b[13]?.pressed || y > 0.5) dir = 'down';
	else if (b[14]?.pressed || x < -0.5) dir = 'left';
	else if (b[15]?.pressed || x > 0.5) dir = 'right';
	return dir && dir !== prev ? dir : (dir ? '__hold' : null);
}
