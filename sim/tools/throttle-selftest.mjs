// The throttle chain (src/throttle.js): the §4.1 mapping and the §6.2 band
// weighting of the throttle travel.
//
// The load-bearing test is the first one. This lot wires a shaping chain in
// front of a throttle that thousands of flights were tuned against, and the
// only acceptable default is one that does not move a single bit. Everything
// after it checks that the bands do what §6.2 says once a player moves them.
import assert from 'node:assert/strict';
import {
	throttleChain, throttleWeight, throttleBands, shapedThrottle,
	throttleFromSpecAxis, map, DEFAULT_THROTTLE,
} from '../src/throttle.js';
import { throttleShape5in } from '../src/curves.js';
import { FlightController } from '../src/flightController.js';
import { PROFILES } from '../src/drone-profiles.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const sweep = (steps = 2001) => Array.from({ length: steps }, (_, i) => i / (steps - 1));

t('the default chain is the identity, bit for bit', () => {
	// Bands 1/1/1, MinThrottle 0, no shape curve: today's throttle, untouched.
	for (const s of sweep(4001)) {
		assert.equal(throttleChain(s), s, `stick ${s}`);
		assert.equal(throttleChain(s, DEFAULT_THROTTLE), s, `stick ${s}`);
	}
	// And the stick contract is still enforced at the edges.
	assert.equal(throttleChain(-0.4), 0);
	assert.equal(throttleChain(1.7), 1);
	assert.equal(throttleChain(NaN), 0);
});

t('the controller flying its defaults commands exactly the stick it was given', () => {
	// The identity where it matters: through FlightController.update(), not just
	// through the module. Acro, so the altitude solver is out of the way.
	const fc = new FlightController({ profile: PROFILES.freestyle5, mode: 'acro' });
	const state = {
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		angularVelocity: { x: 0, y: 0, z: 0 },
		position: { x: 0, y: 5, z: 0 },
		velocity: { x: 0, y: 0, z: 0 },
	};
	for (const s of sweep(201)) {
		const out = fc.update({ throttle: s, roll: 0, pitch: 0, yaw: 0 }, state, 1 / 500);
		assert.equal(out.throttle, s, `stick ${s}`);
	}
});

t('at 1/1/1 the three bands sum to exactly one everywhere — §6.2 partitions unity', () => {
	for (const u of sweep(2001)) {
		const b = throttleBands(u, DEFAULT_THROTTLE);
		assert.ok(Math.abs(b.low + b.medium + b.high - 1) < 1e-12, `u=${u}: ${JSON.stringify(b)}`);
		assert.equal(throttleWeight(u, DEFAULT_THROTTLE), 1, `u=${u}`);
	}
});

t('the three bands at mid-stick are what the formula predicts', () => {
	// u = 0.5 is the one point where §6.2 is fully determined by inspection:
	// high = map(0.5, 0.5..1 -> 0..1) = 0, low = map(0.5, 0..0.5 -> 1..0) = 0,
	// medium = map(0, 0..0.5 -> 1..0) = 1. So the weight is MediumThrottle alone.
	const cfg = { ...DEFAULT_THROTTLE, low: 0.3, medium: 1.4, high: 2.2 };
	const b = throttleBands(0.5, cfg);
	assert.equal(b.high, 0);
	assert.equal(b.low, 0);
	assert.equal(b.medium, 1.4);
	assert.equal(throttleWeight(0.5, cfg), 1.4);
	// A quarter stick: low = 0.5 x Low, medium = 0.5 x Medium, high = 0.
	const q = throttleBands(0.25, cfg);
	assert.ok(Math.abs(q.low - 0.5 * 0.3) < 1e-12);
	assert.ok(Math.abs(q.medium - 0.5 * 1.4) < 1e-12);
	assert.equal(q.high, 0);
	// Three quarters: medium = 0.5 x Medium, high = 0.5 x High, low = 0.
	const h = throttleBands(0.75, cfg);
	assert.equal(h.low, 0);
	assert.ok(Math.abs(h.medium - 0.5 * 1.4) < 1e-12);
	assert.ok(Math.abs(h.high - 0.5 * 2.2) < 1e-12);
});

t('each band only touches its own end of the travel', () => {
	const only = (k) => ({ ...DEFAULT_THROTTLE, low: 0, medium: 0, high: 0, [k]: 1 });
	// Low is dead at and above mid stick, High is dead at and below it.
	for (const u of [0.5, 0.6, 0.8, 1]) assert.equal(throttleWeight(u, only('low')), 0, `low @ ${u}`);
	for (const u of [0, 0.2, 0.4, 0.5]) assert.equal(throttleWeight(u, only('high')), 0, `high @ ${u}`);
	assert.equal(throttleWeight(0, only('low')), 1);
	assert.equal(throttleWeight(1, only('high')), 1);
	// Medium peaks at mid and is dead at both stops.
	assert.equal(throttleWeight(0.5, only('medium')), 1);
	assert.equal(throttleWeight(0, only('medium')), 0);
	assert.equal(throttleWeight(1, only('medium')), 0);
});

t('raising a band raises the commanded throttle over that band alone', () => {
	const hot = { ...DEFAULT_THROTTLE, high: 1.5 };
	assert.equal(throttleChain(0.3, hot), throttleChain(0.3));          // untouched below mid
	assert.equal(throttleChain(0.5, hot), throttleChain(0.5));          // and at mid
	assert.ok(throttleChain(0.7, hot) > throttleChain(0.7));            // lifted above it
	const cold = { ...DEFAULT_THROTTLE, low: 0.5 };
	assert.ok(throttleChain(0.2, cold) < throttleChain(0.2));
	assert.equal(throttleChain(0.6, cold), throttleChain(0.6));
});

t('equal bands scale the whole travel by that gain', () => {
	// The partition-of-unity shortcut in throttleWeight() has to agree with the
	// literal three-band sum, not merely be faster than it.
	for (const g of [0, 0.5, 1, 1.25, 2]) {
		const cfg = { ...DEFAULT_THROTTLE, low: g, medium: g, high: g };
		for (const u of sweep(401)) {
			const b = throttleBands(u, cfg);
			assert.ok(Math.abs(b.low + b.medium + b.high - g) < 1e-12, `g=${g} u=${u}`);
			assert.equal(throttleWeight(u, cfg), g, `g=${g} u=${u}`);
		}
	}
});

t('MinThrottle lifts the floor of the travel by MinThrottle/80 — §4.1 as written', () => {
	// Percent in, and §4.1 divides by 80 rather than 100: the spec's own 5.5%
	// becomes a 6.875% floor. Pinned so the divergence from §6.1 (x 0.01) stays
	// visible instead of being silently "fixed" later.
	const cfg = { ...DEFAULT_THROTTLE, minThrottle: 5.5 };
	assert.ok(Math.abs(shapedThrottle(0, cfg) - 5.5 / 80) < 1e-15);
	assert.equal(shapedThrottle(1, cfg), 1);
	// Linear between the two, since no shape curve is set.
	assert.ok(Math.abs(shapedThrottle(0.5, cfg) - (5.5 / 80 + 0.5 * (1 - 5.5 / 80))) < 1e-15);
	// The floor reaches the commanded throttle: the motors never idle at zero.
	assert.ok(throttleChain(0, cfg) > 0);
});

t('the shape curve is applied after the mapping, and only when one is set', () => {
	const cfg = { ...DEFAULT_THROTTLE, shape: throttleShape5in };
	// §11: forme_gaz_5pouces is 0 -> 0, 0.5 -> 0.42, 1 -> 1. Its whole point is
	// that mid stick is NOT half throttle.
	assert.equal(shapedThrottle(0, cfg), 0);
	assert.ok(Math.abs(shapedThrottle(0.5, cfg) - 0.42) < 1e-12);
	assert.equal(shapedThrottle(1, cfg), 1);
	assert.ok(shapedThrottle(0.5, cfg) < 0.5);
	// Monotone over the travel, and still inside [0, 1].
	let prev = -1;
	for (const u of sweep(401)) {
		const v = throttleChain(u, cfg);
		assert.ok(v >= prev - 1e-12 && v >= 0 && v <= 1, `u=${u} -> ${v}`);
		prev = v;
	}
	// With a floor as well, the curve is evaluated on the mapped throttle.
	const floored = { ...cfg, minThrottle: 5.5 };
	assert.equal(shapedThrottle(0, floored), throttleShape5in.eval(5.5 / 80));
});

t('the output stays inside [0, 1] whatever the bands ask for', () => {
	const wild = { minThrottle: 20, low: 3, medium: 4, high: 5, shape: throttleShape5in };
	for (const u of sweep(401)) {
		const v = throttleChain(u, wild);
		assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), `u=${u} -> ${v}`);
	}
});

t('map() is the bounded remap of §0.3', () => {
	assert.equal(map(0.5, 0, 1, 10, 20), 15);
	assert.equal(map(-3, 0, 1, 10, 20), 10);      // saturates low
	assert.equal(map(7, 0, 1, 10, 20), 20);       // saturates high
	assert.equal(map(0.75, 1, 0, 0, 1), 0.25);    // reversed source range
	assert.equal(map(NaN, 0, 1, 10, 20), 10);
});

t('a caller holding the spec\'s -1..1 axis lands on the same throttle', () => {
	assert.equal(throttleFromSpecAxis(-1), 0);
	assert.equal(throttleFromSpecAxis(0), 0.5);
	assert.equal(throttleFromSpecAxis(1), 1);
	assert.equal(throttleFromSpecAxis(-4), 0);
});

console.log(`throttle-selftest : ${n} tests ok`);
