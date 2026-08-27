// Headless checks on the generated scene: geodesy, ground queries, flight
// envelope, and the collision behaviour the sim depends on.
//
//   node tools/selftest.mjs [sceneDir]

import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics, MAX_THRUST, QUAD } from '../src/physics.js';
import { FlightController, RATE_PRESETS } from '../src/flightController.js';
import { VideoLink } from '../src/link.js';

const sceneDir = path.resolve(process.argv[2] ?? 'public/scenes/tour-eiffel');
const manifest = JSON.parse(fs.readFileSync(path.join(sceneDir, 'manifest.json')));
const raw = fs.readFileSync(path.join(sceneDir, 'collision.bin'));
const vc = raw.readUInt32LE(8), ic = raw.readUInt32LE(12);
const collision = {
	vertices: new Float32Array(raw.buffer, raw.byteOffset + 16, vc * 3),
	indices: new Uint32Array(raw.buffer, raw.byteOffset + 16 + vc * 12, ic),
};

await initPhysics();
// One world only: several 3.7M-triangle trimeshes at once exhausts the wasm heap.
const phys = new Physics(collision, manifest.spawn);
const fc = new FlightController();
const STEP = 1 / 250;

// Thrust is not linear in throttle (rpm goes with cmd^0.65, thrust with rpm^2),
// so the hover stick position has to be inverted through that curve rather than
// read off a ratio. It lands around 25%, which is where a real 5" quad hovers.
const HOVER = ((QUAD.mass * 9.81) / MAX_THRUST) ** (1 / (2 * QUAD.rpmCurve));

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

function simulate({ seconds, sticks, at, velocity, mode = 'acro' }) {
	phys.reset();
	fc.setMode(mode);
	if (at) phys.body.setTranslation({ x: at[0], y: at[1], z: at[2] }, true);
	if (velocity) phys.body.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
	fc.reset();
	let maxImpact = 0;
	let peakSpin = 0;
	for (let i = 0; i < Math.round(seconds * 250); i++) {
		const s = typeof sticks === 'function' ? sticks(i * STEP) : sticks;
		const { motors } = fc.update(s, phys, STEP);
		maxImpact = Math.max(maxImpact, phys.step(motors, STEP));
		const a = phys.angularVelocity;
		peakSpin = Math.max(peakSpin, Math.hypot(a.x, a.y, a.z) * 180 / Math.PI);
	}
	const p = phys.position, v = phys.velocity, w = phys.angularVelocity;
	return { p, v, w, peakSpin, battery: phys.battery,
		speed: Math.hypot(v.x, v.y, v.z), spin: Math.hypot(w.x, w.y, w.z) * 180 / Math.PI, maxImpact };
}

console.log(`scene: ${sceneDir}`);
console.log(`origin ${manifest.origin.latitude.toFixed(5)}, ${manifest.origin.longitude.toFixed(5)}`);

console.log('\ngeometry & geodesy');
const size = manifest.bbox.max.map((v, i) => v - manifest.bbox.min[i]);
check('tile is roughly 1.2km square', size[0] > 1000 && size[0] < 1600 && size[2] > 1000 && size[2] < 1600,
	`${size[0].toFixed(0)} x ${size[2].toFixed(0)} m`);
check('origin is the Eiffel Tower area', Math.abs(manifest.origin.latitude - 48.8583) < 0.01 && Math.abs(manifest.origin.longitude - 2.297) < 0.01);

// The tallest structure in this tile is the tower; ~300m above local ground.
let top = -Infinity, tx = 0, tz = 0;
for (let i = 0; i < vc; i++) {
	const y = collision.vertices[i * 3 + 1];
	if (y > top) { top = y; tx = collision.vertices[i * 3]; tz = collision.vertices[i * 3 + 2]; }
}
const groundNearTower = phys.groundBelow(tx + 120, 350, tz + 120);
const towerHeight = top - groundNearTower;
check('Eiffel Tower is ~300m tall', towerHeight > 270 && towerHeight < 350, `${towerHeight.toFixed(0)} m`);

console.log('\nground queries');
check('ray finds ground at spawn', phys.groundBelow(manifest.spawn.x, 350, manifest.spawn.z) !== null);
check('ray finds the tower structure', (phys.groundBelow(tx, 350, tz) ?? 0) > 200,
	`${(phys.groundBelow(tx, 350, tz) ?? 0).toFixed(0)} m`);
let misses = 0, samples = 0;
for (let x = -600; x <= 600; x += 100) for (let z = -600; z <= 600; z += 100) {
	samples++; if (phys.groundBelow(x, 350, z) === null) misses++;
}
check('ground coverage across the tile', misses === 0, `${samples - misses}/${samples} hits`);

console.log('\nflight envelope');
const rest = simulate({ seconds: 2, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 } });
check('sits still on the ground at zero throttle', rest.speed < 0.5, `${rest.speed.toFixed(2)} m/s`);

const hover = simulate({ seconds: 4, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 }, at: [0, 150, 300] });
check('holds altitude at hover throttle', Math.abs(hover.p.y - 150) < 3, `drifted ${(hover.p.y - 150).toFixed(2)} m in 4s`);

const climb = simulate({ seconds: 5, sticks: { throttle: 1, roll: 0, pitch: 0, yaw: 0 }, at: [0, 50, 300] });
check('climbs at full throttle', climb.p.y - 50 > 100, `+${(climb.p.y - 50).toFixed(0)} m in 5s`);

// The stick has to start centred: the controller's RC smoothing primes on its
// first sample, so a stick already at the stop means no smoothing ever happens.
const commanded = RATE_PRESETS[fc.preset].roll.max;
const roll = simulate({ seconds: 1.2, at: [0, 150, 300],
	sticks: (t) => ({ throttle: HOVER, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
check(`reaches the commanded roll rate (${commanded} deg/s)`,
	roll.spin > commanded * 0.93 && roll.peakSpin < commanded * 1.15,
	`${roll.spin.toFixed(0)} deg/s held, ${roll.peakSpin.toFixed(0)} peak`);

console.log('\npropulsion');
check('hovers at a realistic stick position', HOVER > 0.18 && HOVER < 0.32, `${(HOVER * 100).toFixed(0)}% throttle`);

// Airmode: the same flick must produce the same rate with the throttle shut,
// which is the whole point of sliding throttle instead of clipping the mix.
const rollIdle = simulate({ seconds: 1.2, at: [0, 200, 300],
	sticks: (t) => ({ throttle: 0, roll: t > 0.15 ? 1 : 0, pitch: 0, yaw: 0 }) });
check('airmode keeps roll authority at zero throttle',
	rollIdle.spin > commanded * 0.9,
	`${rollIdle.spin.toFixed(0)} deg/s vs ${roll.spin.toFixed(0)} at hover`);

// Anisotropic inertia: yaw carries nearly twice pitch's, against an eighth of
// the torque, so it has to be visibly the slow axis. Sampled 80 ms into the
// flick, before either axis has arrived — at 300 ms both are simply at their
// commanded rate and the difference has vanished. If this ever passes with the
// two equal, the inertia tensor has been lost somewhere.
const SAMPLE_AT = 0.15 + 0.08;
const yawRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
	sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: 0, yaw: t > 0.15 ? 1 : 0 }) });
const pitchRun = simulate({ seconds: SAMPLE_AT, at: [0, 200, 300],
	sticks: (t) => ({ throttle: HOVER, roll: 0, pitch: t > 0.15 ? 1 : 0, yaw: 0 }) });
const yawFrac = Math.abs(yawRun.w.y * 180 / Math.PI) / RATE_PRESETS[fc.preset].yaw.max;
const pitchFrac = Math.abs(pitchRun.w.x * 180 / Math.PI) / RATE_PRESETS[fc.preset].pitch.max;
check('yaw builds rate more slowly than pitch',
	yawFrac < 0.65 * pitchFrac,
	`80 ms in: yaw at ${(yawFrac * 100).toFixed(0)}% of command, pitch at ${(pitchFrac * 100).toFixed(0)}%`);

// Terminal velocity with the props stopped: a quad falling flat is a plate,
// and this is the check that the anisotropic body drag survived.
const drop = simulate({ seconds: 12, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, at: [0, 400, 300] });
check('terminal velocity falling flat is 15-25 m/s', drop.speed > 15 && drop.speed < 25, `${drop.speed.toFixed(1)} m/s`);

// A pack has to drain, and it has to sag under load rather than sit at 16.8 V.
const punch = simulate({ seconds: 6, sticks: { throttle: 1, roll: 0, pitch: 0, yaw: 0 }, at: [0, 100, 300] });
check('the pack sags under a full-throttle pull',
	punch.battery.voltage < 16.2 && punch.battery.voltage > 13.5, `${punch.battery.voltage.toFixed(2)} V at ${punch.battery.current.toFixed(0)} A`);
check('the pack drains', punch.battery.soc < 0.95 && punch.battery.soc > 0.5, `${(punch.battery.soc * 100).toFixed(0)}% left after 6 s flat out`);

console.log('\ncollision');
const towerX = tx, towerZ = tz;
const fast = simulate({ seconds: 2, sticks: { throttle: HOVER, roll: 0, pitch: 0, yaw: 0 },
	at: [towerX + 45, 120, towerZ], velocity: [-60, 0, 0] });
check('60 m/s impact does not tunnel through the tower (CCD)', fast.p.x > towerX - 25,
	`stopped at x=${fast.p.x.toFixed(1)}, tower at x=${towerX.toFixed(1)}`);
check('high-speed impact registers as a crash', fast.maxImpact > 1500, `${fast.maxImpact.toFixed(0)} N`);

const land = simulate({ seconds: 3, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 },
	at: [manifest.spawn.x, manifest.spawn.y + 0.3, manifest.spawn.z] });
check('a gentle landing is not a crash', land.maxImpact < 1500, `${land.maxImpact.toFixed(0)} N`);

console.log('\nvideo link');
// The link has two halves and both are checkable without a browser: the
// geometry query in physics.js, and the pure dB model in link.js.
{
	const s = manifest.spawn;
	const ex = s.x, ey = s.y + 1.2, ez = s.z;

	// Straight up out of the spawn there is nothing but sky. If this one fails,
	// the ground station is buried and every other link reading is meaningless.
	check('clear line of sight straight up from the transmitter',
		!phys.obstructionBetween(ex, ey, ez, ex, ey + 200, ez).blocked);

	// A single sheet of terrain has a near face and no far face, so its measured
	// depth is legitimately zero — but it is still in the way. The flag and the
	// span are separate precisely so this case is not read as a clear path.
	const under = phys.obstructionBetween(ex, ey, ez, ex, ey - 30, ez);
	check('the ground counts as blocked even with no measurable depth',
		under.blocked, `span ${under.span.toFixed(1)} m`);

	// Somewhere across the tile at head height there has to be city in the way,
	// or the whole feature has nothing to react to.
	let blockedSamples = 0, deep = 0, total = 0;
	for (let a = 0; a < 8; a++) {
		const x = ex + Math.cos(a / 8 * Math.PI * 2) * 400;
		const z = ez + Math.sin(a / 8 * Math.PI * 2) * 400;
		const o = phys.obstructionBetween(ex, ey, ez, x, ey + 2, z);
		total++;
		if (o.blocked) blockedSamples++;
		if (o.span > 5) deep++;
	}
	check('street-level paths across the tile are obstructed', blockedSamples === total,
		`${blockedSamples}/${total} blocked`);
	check('obstruction is measured as a depth, not just a flag', deep >= total / 2,
		`${deep}/${total} deeper than 5 m`);

	// The model itself. All of these are properties, not magic numbers, so they
	// survive a retune of the dB constants.
	const link = new VideoLink();
	const settle = (opts, seconds = 10) => {
		link.reset();
		for (let i = 0; i < seconds * 60; i++) link.update({ dt: 1 / 60, ...opts });
		return link.out.quality;
	};
	const near = settle({ distance: 20, blocked: false, span: 0 });
	const far = settle({ distance: 900, blocked: false, span: 0 });
	const behind = settle({ distance: 900, blocked: true, span: 12 });
	check('a clear link close in is perfect', near > 0.99, near.toFixed(3));
	check('quality falls with distance', far < near, `${near.toFixed(2)} at 20 m, ${far.toFixed(2)} at 900 m`);
	// The whole point of the raycast: distance alone must not be what kills the
	// picture, or there was no reason to cast a ray at all.
	check('a clear link across the whole tile is still flyable', far > 0.4, far.toFixed(2));
	check('a building costs far more than the distance to it', behind < 0.05,
		`${far.toFixed(2)} clear vs ${behind.toFixed(2)} behind 12 m of building`);

	// Reacquisition is deliberately slower than loss, the way a diversity
	// receiver behaves. Measured as time-to-halfway in each direction.
	const halfway = (from, to) => {
		// Where it ends up first — settle() resets, so it cannot run after the
		// starting state has been established.
		const target = settle(to);
		link.reset();
		for (let i = 0; i < 600; i++) link.update({ dt: 1 / 60, ...from });
		const start = link.out.quality;
		let frames = 0;
		while (frames < 600 && Math.abs(link.out.quality - start) < Math.abs(target - start) / 2) {
			link.update({ dt: 1 / 60, ...to });
			frames++;
		}
		return frames;
	};
	const clear = { distance: 120, blocked: false, span: 0 };
	const shadow = { distance: 120, blocked: true, span: 3 };
	const drop = halfway(clear, shadow);
	const recover = halfway(shadow, clear);
	check('the link is lost faster than it comes back', recover > drop * 2,
		`${(drop / 60 * 1000).toFixed(0)} ms to drop, ${(recover / 60 * 1000).toFixed(0)} ms to recover`);

	// Severity is the slider, and 0 has to mean genuinely nothing.
	link.setSeverity(0);
	const off = settle({ distance: 2000, blocked: true, span: 200 });
	check('severity 0 leaves the picture untouched', off === 1, off.toFixed(3));
	link.setSeverity(1);

	// Bounded whatever it is fed: the shader multiplies by this.
	let outOfRange = 0;
	link.reset();
	for (let i = 0; i < 2000; i++) {
		const o = link.update({ dt: 1 / 60, distance: Math.random() * 3000,
			blocked: Math.random() > 0.5, span: Math.random() * 300 });
		if (!(o.quality >= 0 && o.quality <= 1)) outOfRange++;
	}
	check('quality stays inside 0..1 under any input', outOfRange === 0);
}

console.log('\ntextures');
// The UV convention is the one thing here a screenshot reads as merely "a bit
// odd": OBJ puts the V origin at the bottom-left, DataArrayTexture at the top.
// Both checks below failed hard before prep.mjs started converting it.
{
	const tileDir = manifest.source;
	const mtlPath = tileDir ? path.join(tileDir, 'exp_model.mtl') : null;
	if (!mtlPath || !fs.existsSync(mtlPath)) {
		console.log(`  SKIP  needs the source tile — ${mtlPath ?? 'no manifest.source'} is not on disk`);
	} else {
		const sharp = (await import('sharp')).default;

		// Declaration order in the MTL is the layer order prep.mjs assigns.
		const jpgs = [];
		for (const line of fs.readFileSync(mtlPath, 'latin1').split('\n')) {
			const t = line.trim();
			if (t.startsWith('newmtl ')) jpgs.push(null);
			else if (t.startsWith('map_Kd ') && jpgs.length) jpgs[jpgs.length - 1] = t.slice(7).trim();
		}

		const chunk = manifest.chunks[0];
		const g = fs.readFileSync(path.join(sceneDir, chunk.geo));
		const gv = g.readUInt32LE(8), gi = g.readUInt32LE(12), layerBase = g.readUInt32LE(16);
		let o = 32;
		const pos = new Float32Array(g.buffer, g.byteOffset + o, gv * 3); o += gv * 12;
		const uv = new Float32Array(g.buffer, g.byteOffset + o, gv * 2); o += gv * 8;
		const lay = new Uint16Array(g.buffer, g.byteOffset + o, gv); o += (gv * 2 + 3) & ~3;
		const ind = new Uint32Array(g.buffer, g.byteOffset + o, gi);

		// A contiguous block of layers: neighbouring indices are neighbours on the
		// ground, which is what gives the seam check something to compare.
		const SAMPLED = Math.min(80, chunk.layerCount);
		const tex = new Map();
		for (let l = 0; l < SAMPLED; l++) {
			const img = sharp(path.join(tileDir, jpgs[layerBase + l]));
			const { width, height } = await img.metadata();
			tex.set(l, { data: await img.removeAlpha().raw().toBuffer(), w: width, h: height });
		}
		// prep.mjs bakes V top-origin, matching DataArrayTexture's flipY = false,
		// so the stored UV indexes the source JPEG's rows directly.
		const sample = (l, u, v) => {
			const t = tex.get(l);
			const x = Math.min(t.w - 1, Math.max(0, Math.round(u * (t.w - 1))));
			const y = Math.min(t.h - 1, Math.max(0, Math.round(v * (t.h - 1))));
			const i = (y * t.w + x) * 3;
			return [t.data[i], t.data[i + 1], t.data[i + 2]];
		};

		// Two materials meeting at one world point must agree on the colour there.
		// Measured 14.8 with V converted, 42.4 with it left as the OBJ wrote it.
		const byPos = new Map();
		for (let i = 0; i < gv; i++) {
			if (lay[i] >= SAMPLED) continue;
			const k = `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`;
			let a = byPos.get(k); if (!a) { a = []; byPos.set(k, a); } a.push(i);
		}
		let diff = 0, pairs = 0;
		for (const a of byPos.values()) {
			for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) {
				if (lay[a[x]] === lay[a[y]]) continue;
				const p = sample(lay[a[x]], uv[a[x] * 2], uv[a[x] * 2 + 1]);
				const q = sample(lay[a[y]], uv[a[y] * 2], uv[a[y] * 2 + 1]);
				diff += (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
				pairs++;
			}
		}
		const meanDiff = pairs ? diff / pairs : Infinity;
		check('neighbouring materials agree where they meet (UV convention)',
			pairs > 200 && meanDiff < 25,
			`${meanDiff.toFixed(1)} mean |dRGB| over ${pairs} shared vertices`);

		// Flyover pads the unused part of every patch with flat grey 128. Any real
		// quantity of it on screen means the UVs are landing in that padding.
		let grey = 0, area = 0;
		for (let t = 0; t < gi; t += 3) {
			const a = ind[t], b = ind[t + 1], c = ind[t + 2];
			if (lay[a] >= SAMPLED) continue;
			const ex = pos[b * 3] - pos[a * 3], ey = pos[b * 3 + 1] - pos[a * 3 + 1], ez = pos[b * 3 + 2] - pos[a * 3 + 2];
			const fx = pos[c * 3] - pos[a * 3], fy = pos[c * 3 + 1] - pos[a * 3 + 1], fz = pos[c * 3 + 2] - pos[a * 3 + 2];
			const w = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) / 4;
			for (let s = 0; s < 4; s++) {
				let r1 = Math.random(), r2 = Math.random();
				if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
				const u = uv[a * 2] + r1 * (uv[b * 2] - uv[a * 2]) + r2 * (uv[c * 2] - uv[a * 2]);
				const v = uv[a * 2 + 1] + r1 * (uv[b * 2 + 1] - uv[a * 2 + 1]) + r2 * (uv[c * 2 + 1] - uv[a * 2 + 1]);
				const [r, gg, bl] = sample(lay[a], u, v);
				area += w;
				if (Math.max(r, gg, bl) - Math.min(r, gg, bl) <= 6 && Math.abs((r + gg + bl) / 3 - 128) <= 8) grey += w;
			}
		}
		const greyPct = 100 * grey / area;
		check('visible surface is not sampling the grey padding', greyPct < 5,
			`${greyPct.toFixed(1)}% grey over ${area.toFixed(0)} m² sampled`);
	}
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
