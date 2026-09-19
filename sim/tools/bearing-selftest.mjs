// Selftest of src/bearing.js: the compass convention the HUD reads the world
// through. Three readouts got it wrong independently before this file existed
// — the HOME arrow, the heading tape and the wind arrow — so the cases below
// are written as what a pilot sees, not as what the trigonometry returns.
// Run: node tools/bearing-selftest.mjs
import assert from 'node:assert/strict';
import { headingOf, bearingTo, windFromBearing, relativeBearing, bearingDeg } from '../src/bearing.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A yaw-only body quaternion: rotation of phi about +Y.
const qYaw = (phi) => ({ x: 0, y: Math.sin(phi / 2), z: 0, w: Math.cos(phi / 2) });
// The four cardinal attitudes, by the yaw that produces them. Derived from the
// nose being the body's -Z: phi turns (0,0,-1) into (-sin phi, 0, -cos phi).
const NORTH = qYaw(0), EAST = qYaw(-Math.PI / 2), SOUTH = qYaw(Math.PI), WEST = qYaw(Math.PI / 2);

// The two arrow rings the HUD actually indexes with these bearings, copied
// here so a change to either is caught as a change to what the pilot sees.
const HOME_ARROWS = ['^', '^>', '>', 'v>', 'v', 'v<', '<', '^<'];        // src/drone-osd.js
const WIND_ARROWS = ['v', 'v<', '<', '^<', '^', '^>', '>', 'v>'];        // src/fpvtp-osd.js
const ring = (rel) => ((Math.round(rel / (Math.PI * 2) * 8) % 8) + 8) % 8;

t('headingOf: the nose bearing, not the quaternion yaw', () => {
	assert.equal(Math.round(bearingDeg(headingOf(NORTH))), 0);
	assert.equal(Math.round(bearingDeg(headingOf(EAST))), 90);
	assert.equal(Math.round(bearingDeg(headingOf(SOUTH))), 180);
	assert.equal(Math.round(bearingDeg(headingOf(WEST))), 270);
});

t('headingOf: bank does not move the bearing', () => {
	// 30 degrees of roll about the nose (-Z), on top of a due-east heading.
	const s = Math.sin(Math.PI / 12), c = Math.cos(Math.PI / 12);
	const roll = { x: 0, y: 0, z: -s, w: c };
	const q = {
		w: EAST.w * roll.w - EAST.x * roll.x - EAST.y * roll.y - EAST.z * roll.z,
		x: EAST.w * roll.x + EAST.x * roll.w + EAST.y * roll.z - EAST.z * roll.y,
		y: EAST.w * roll.y - EAST.x * roll.z + EAST.y * roll.w + EAST.z * roll.x,
		z: EAST.w * roll.z + EAST.x * roll.y - EAST.y * roll.x + EAST.z * roll.w,
	};
	assert.ok(Math.abs(bearingDeg(headingOf(q)) - 90) < 1e-9);
});

t('bearingTo: north is -Z, east is +X', () => {
	assert.equal(Math.round(bearingDeg(bearingTo(0, -100))), 0);
	assert.equal(Math.round(bearingDeg(bearingTo(100, 0))), 90);
	assert.equal(Math.round(bearingDeg(bearingTo(0, 100))), 180);
	assert.equal(Math.round(bearingDeg(bearingTo(-100, 0))), 270);
});

t('HOME arrow: home ahead points ahead, home behind points behind', () => {
	const arrow = (spawn, p, q) => HOME_ARROWS[ring(relativeBearing(bearingTo(spawn.x - p.x, spawn.z - p.z), headingOf(q)))];
	const here = { x: 0, z: 0 };
	// Facing north, 100 m out from a launch point due north of us.
	assert.equal(arrow({ x: 0, z: -100 }, here, NORTH), '^');
	// Same launch point, now flown past it: it is behind.
	assert.equal(arrow({ x: 0, z: 100 }, here, NORTH), 'v');
	assert.equal(arrow({ x: 100, z: 0 }, here, NORTH), '>');
	assert.equal(arrow({ x: -100, z: 0 }, here, NORTH), '<');
	// Turn the machine, not the world: home due north, nose due east.
	assert.equal(arrow({ x: 0, z: -100 }, here, EAST), '<');
	assert.equal(arrow({ x: 0, z: -100 }, here, WEST), '>');
	assert.equal(arrow({ x: 0, z: -100 }, here, SOUTH), 'v');
});

t('windFromBearing: the source, not the travel', () => {
	// Blowing east (+X) is a wind FROM the west.
	assert.equal(Math.round(bearingDeg(windFromBearing(5, 0))), 270);
	// Blowing north (-Z) is a wind FROM the south.
	assert.equal(Math.round(bearingDeg(windFromBearing(0, -5))), 180);
	assert.equal(Math.round(bearingDeg(windFromBearing(-5, 0))), 90);
	assert.equal(Math.round(bearingDeg(windFromBearing(0, 5))), 0);
});

t('WIND arrow: the glyph points where the wind pushes', () => {
	const arrow = (w, q) => WIND_ARROWS[ring(relativeBearing(windFromBearing(w.x, w.z), headingOf(q)))];
	// Facing north. A wind blowing north comes from behind and pushes forward.
	assert.equal(arrow({ x: 0, z: -5 }, NORTH), '^');
	assert.equal(arrow({ x: 0, z: 5 }, NORTH), 'v');
	// A crosswind from the LEFT pushes the machine RIGHT. This is the case the
	// mirrored formula got backwards.
	assert.equal(arrow({ x: 5, z: 0 }, NORTH), '>');
	assert.equal(arrow({ x: -5, z: 0 }, NORTH), '<');
	// Facing east: the same wind is now a tailwind, then a wind from the right.
	assert.equal(arrow({ x: 5, z: 0 }, EAST), '^');
	assert.equal(arrow({ x: 0, z: -5 }, EAST), '<');
});

t('relativeBearing: wrapped to ]-pi, pi]', () => {
	assert.equal(relativeBearing(Math.PI * 1.5, 0).toFixed(6), (-Math.PI / 2).toFixed(6));
	assert.equal(relativeBearing(-Math.PI * 1.5, 0).toFixed(6), (Math.PI / 2).toFixed(6));
	assert.equal(relativeBearing(Math.PI, 0), Math.PI);
	assert.ok(relativeBearing(3 * Math.PI, 0) > 0);
	for (let d = -720; d <= 720; d += 7) {
		const rel = relativeBearing(d * Math.PI / 180, 0);
		assert.ok(rel > -Math.PI && rel <= Math.PI, `out of range at ${d}`);
	}
});

t('bearingDeg: a compass reading, never negative', () => {
	assert.equal(bearingDeg(0), 0);
	assert.equal(Math.round(bearingDeg(-Math.PI / 2)), 270);
	assert.equal(Math.round(bearingDeg(Math.PI * 3)), 180);
	assert.ok(bearingDeg(-Math.PI * 4.5) >= 0);
});

console.log(`PASS  bearing-selftest (${n} tests)`);
