// Compass bearings, in the one convention the rest of the world uses: degrees
// (here radians) clockwise from north, north being -Z.
//
// Pure: no THREE, no Rapier, no DOM. It takes a plain {x,y,z,w} quaternion and
// plain scalars, so tools/bearing-selftest.mjs can pin every case headlessly.
//
// WHY THIS FILE EXISTS. Coordinates after prep are local ENU metres — X=east,
// Y=up, Z=SOUTH — so north is -Z, and every bearing has a minus sign in it
// that is easy to drop. Three HUD readouts had dropped it, each in a different
// way, and each stayed plausible enough to survive:
//
//   - the HOME arrow read atan2(dx, dz) instead of atan2(dx, -dz), which
//     mirrors north and south: home straight ahead was drawn as an arrow
//     pointing straight back. Left and right came out right, which is exactly
//     why nobody caught it.
//   - the heading tape published the quaternion's yaw about +Y, which is the
//     NEGATIVE of the heading: nose due east read 270, nose due west read 090.
//   - the HUD's wind arrow mirrored left and right, so a crosswind from the
//     left was drawn as pushing the machine left instead of right.
//
// The three call sites each did their own trigonometry. Now they do not: a
// bearing is built here or it is not built at all.

// The heading of the nose, clockwise from north.
//
// The flight camera looks down the body's -Z, so that axis is the nose. A
// rotation of +phi about +Y turns (0,0,-1) into (-sin phi, 0, -cos phi), whose
// bearing is -phi: the yaw read off the quaternion and the heading differ by a
// sign. That sign is the whole reason this function is not inlined.
//
// Only the yaw is read. A bearing does not change when the quad is banked.
export function headingOf(q) {
	return -Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

// The bearing of a displacement given in scene metres: east along X, SOUTH
// along Z. `bearingTo(target.x - here.x, target.z - here.z)`.
export function bearingTo(dEast, dSouth) {
	return Math.atan2(dEast, -dSouth);
}

// The bearing the wind comes FROM, given the velocity it blows along (the
// vector WindField publishes). A wind blowing towards the east comes from the
// west: the two bearings are opposite, and the HUD wants the one a pilot
// names, which is the source.
export function windFromBearing(windEast, windSouth) {
	return Math.atan2(-windEast, windSouth);
}

// A bearing seen from the cockpit: 0 straight ahead, +pi/2 to the right,
// wrapped to ]-pi, pi]. Both arguments are absolute bearings.
export function relativeBearing(bearing, heading) {
	const rel = (bearing - heading) % (Math.PI * 2);
	if (rel > Math.PI) return rel - Math.PI * 2;
	if (rel <= -Math.PI) return rel + Math.PI * 2;
	return rel;
}

// A bearing as a compass reading in [0, 360[ — what a heading tape prints.
export function bearingDeg(bearing) {
	return ((bearing * 180 / Math.PI) % 360 + 360) % 360;
}
