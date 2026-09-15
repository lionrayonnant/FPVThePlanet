// The gyro model and the filters that answer it (src/gyro.js).
//
// Two properties matter more than any of the numbers below.
//
//   1. With gyroNoise 0 the sensor is a pass-through, to the bit. Every family
//      in src/drone-profiles.js ships at 0, so this is the property that says
//      the lot changed nothing it was not asked to change.
//   2. With gyroNoise on, it is deterministic. `Propulsion` is seed-
//      deterministic by contract and tools/flight-replay-selftest.mjs leans on
//      it; a sensor that drew from Math.random would have quietly taken that
//      away from the whole flight stack.
import assert from 'node:assert/strict';
import {
	Gyro, Notch, RpmFilter, DynamicNotch, LoopDelay, NOISE_REFERENCE_RATE, RPM_HARMONICS,
} from '../src/gyro.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const TWO_PI = Math.PI * 2;
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const hzToOmega = (hz) => hz * TWO_PI;

// ---------------------------------------------------------------------------
// 1. The zero-noise path

t('gyroNoise 0 returns the true rates, bit for bit', () => {
	const g = new Gyro({ noise: 0 });
	const w = { x: 0.123456789012345, y: -1.7976931348623157e-3, z: 9.87654321e-7 };
	for (let i = 0; i < 100; i++) {
		const out = g.sample(w, [2000, 2100, 1900, 2050], 1 / 250);
		assert.equal(out.x, w.x);
		assert.equal(out.y, w.y);
		assert.equal(out.z, w.z);
	}
});

t('gyroNoise 0 never advances the phases either', () => {
	const g = new Gyro({ noise: 0 });
	const before = [...g._phase];
	for (let i = 0; i < 50; i++) g.sample({ x: 1, y: 2, z: 3 }, [2000, 2000, 2000, 2000], 1 / 250);
	assert.deepEqual([...g._phase], before);
});

t('a zero or negative dt is a pass-through, not a NaN', () => {
	const g = new Gyro({ noise: 0.1 });
	const w = { x: 1, y: 2, z: 3 };
	for (const dt of [0, -1 / 250, NaN]) {
		const out = g.sample(w, null, dt);
		assert.equal(out.x, 1); assert.equal(out.y, 2); assert.equal(out.z, 3);
	}
});

// ---------------------------------------------------------------------------
// 2. Determinism

t('same seed, same noise, to the bit', () => {
	const run = () => {
		const g = new Gyro({ noise: 0.08, seed: 0x1234 });
		const out = [];
		for (let i = 0; i < 500; i++) {
			const s = g.sample({ x: 0, y: 0, z: 0 }, [2000, 2100, 1900, 2050], 1 / 1000);
			out.push(s.x, s.y, s.z);
		}
		return out;
	};
	assert.deepEqual(run(), run());
});

t('different seeds give different props', () => {
	const a = new Gyro({ noise: 0.08, seed: 1 });
	const b = new Gyro({ noise: 0.08, seed: 2 });
	assert.notDeepEqual(a._unbalance, b._unbalance);
});

t('reset() puts the same four props back', () => {
	const g = new Gyro({ noise: 0.08, seed: 7 });
	const props = [...g._unbalance];
	for (let i = 0; i < 100; i++) g.sample({ x: 0, y: 0, z: 0 }, [2000, 2000, 2000, 2000], 1 / 1000);
	g.reset();
	assert.deepEqual([...g._unbalance], props);
});

// ---------------------------------------------------------------------------
// 3. The amount of noise, and what happens to it when the rate changes

t('broadband RMS is the quoted number at the reference rate', () => {
	const noise = 0.08;
	const g = new Gyro({ noise, seed: 42 });
	const xs = [];
	for (let i = 0; i < 40000; i++) {
		xs.push(g.sample({ x: 0, y: 0, z: 0 }, null, 1 / NOISE_REFERENCE_RATE).x);
	}
	// No rotors -> the broadband part alone, which is BROADBAND_FRACTION of the
	// quoted figure. 5 % is a generous band on 40 000 samples and still refuses
	// a constant that is out by a factor.
	const want = noise * 0.45;
	assert.ok(Math.abs(rms(xs) - want) / want < 0.05, `rms ${rms(xs)} want ~${want}`);
});

t('noise is a DENSITY: double the rate, RMS rises by sqrt(2)', () => {
	const at = (rate) => {
		const g = new Gyro({ noise: 0.08, seed: 9 });
		const xs = [];
		for (let i = 0; i < 40000; i++) xs.push(g.sample({ x: 0, y: 0, z: 0 }, null, 1 / rate).x);
		return rms(xs);
	};
	const r = at(2000) / at(1000);
	assert.ok(Math.abs(r - Math.SQRT2) < 0.05, `ratio ${r}, want sqrt(2)`);
});

t('the rotor tones grow with rpm squared', () => {
	const toneRms = (hz) => {
		const g = new Gyro({ noise: 0.08, seed: 3 });
		const w = hzToOmega(hz);
		const xs = [];
		// Long enough to average over many cycles of the slowest tone here.
		for (let i = 0; i < 40000; i++) xs.push(g.sample({ x: 0, y: 0, z: 0 }, [w, w, w, w], 1 / 8000).x);
		return rms(xs);
	};
	// Broadband is the same in both, so compare the excess over it.
	const base = toneRms(0);
	const a = Math.sqrt(Math.max(0, toneRms(200) ** 2 - base ** 2));
	const b = Math.sqrt(Math.max(0, toneRms(400) ** 2 - base ** 2));
	assert.ok(b / a > 3.4 && b / a < 4.6, `doubling the rpm multiplied the tone by ${(b / a).toFixed(2)}, want ~4`);
});

// One frequency's worth of DFT over a long record. Far more selective than the
// 64-point SDFT the dynamic notch runs live — which is the point: this asks
// whether the MODEL puts the tone where it says, not whether a short window
// can see it.
function powerAt(xs, hz, fs) {
	let re = 0, im = 0;
	for (let i = 0; i < xs.length; i++) {
		const a = (TWO_PI * hz * i) / fs;
		re += xs[i] * Math.cos(a);
		im -= xs[i] * Math.sin(a);
	}
	return (re * re + im * im) / (xs.length * xs.length);
}

t('the tone lands on the shaft frequency, and on its second harmonic', () => {
	const fs = 4000, hz = 260, w = hzToOmega(hz);
	const g = new Gyro({ noise: 0.3, seed: 5 });
	const xs = [];
	for (let i = 0; i < 40000; i++) xs.push(g.sample({ x: 0, y: 0, z: 0 }, [w, w, w, w], 1 / fs).x);
	const onTone = powerAt(xs, hz, fs);
	const harmonic = powerAt(xs, 2 * hz, fs);
	for (const off of [-140, -70, 70, 140, 500]) {
		const near = powerAt(xs, hz + off, fs);
		assert.ok(onTone > 40 * near, `${hz} Hz carries ${(onTone / near).toFixed(1)}x the power of ${hz + off} Hz`);
	}
	assert.ok(harmonic > 20 * powerAt(xs, 2 * hz + 130, fs), 'the second harmonic is not there');
	assert.ok(harmonic < onTone, 'the second harmonic should be smaller than the fundamental');
});

// ---------------------------------------------------------------------------
// 4. The notch

t('a notch removes its own frequency and leaves its neighbours', () => {
	const fs = 4000, dt = 1 / fs, f = 300;
	const through = (tone) => {
		const nn = new Notch(5);
		nn.setFrequency(f, dt);
		const out = [];
		for (let i = 0; i < 8000; i++) out.push(nn.step(Math.sin(TWO_PI * tone * i * dt)));
		return rms(out.slice(4000));
	};
	assert.ok(through(300) < 0.1, `on the notch: ${through(300)}`);
	assert.ok(through(120) > 0.6, `well below it: ${through(120)}`);
	assert.ok(through(900) > 0.6, `well above it: ${through(900)}`);
});

t('a notch above 0.45 * Nyquist refuses and goes transparent', () => {
	const dt = 1 / 250;                 // Nyquist 125 Hz, ceiling 56 Hz
	const nn = new Notch(5);
	assert.equal(nn.setFrequency(200, dt), false);
	assert.equal(nn.bypass, true);
	// Transparent means transparent: the samples come back untouched.
	for (const v of [0.5, -1.25, 1e-9]) assert.equal(nn.step(v), v);
	assert.equal(nn.setFrequency(40, dt), true);
	assert.equal(nn.bypass, false);
});

t('the RPM filter follows the motors, and refuses below its floor', () => {
	const fs = 4000, dt = 1 / fs, hz = 300, w = hzToOmega(hz);
	const f = new RpmFilter();
	assert.equal(f.notches.length, 4 * RPM_HARMONICS);
	const out = [];
	for (let i = 0; i < 8000; i++) out.push(f.step(Math.sin(TWO_PI * hz * i * dt), [w, w, w, w], dt));
	assert.ok(rms(out.slice(4000)) < 0.15, `tone survived at ${rms(out.slice(4000))}`);

	// A motor at 40 Hz puts its fundamental AND its second harmonic below
	// RPM_MIN_HZ: every notch for it is bypassed rather than parked on the
	// loop's own bandwidth.
	const slow = hzToOmega(40);
	f.step(0, [slow, slow, slow, slow], dt);
	assert.ok(f.notches.every((e) => e.n.bypass));
});

t('the dynamic notch finds a tone nobody told it about', () => {
	const fs = 4000, dt = 1 / fs, hz = 210;
	const d = new DynamicNotch();
	const out = [];
	for (let i = 0; i < 20000; i++) out.push(d.step(Math.sin(TWO_PI * hz * i * dt), dt));
	assert.ok(Math.abs(d.centre - hz) < 0.02 * hz, `settled on ${d.centre.toFixed(0)} Hz, tone at ${hz} Hz`);
	// The input is a unit sine, RMS 0.707. Measured over the last quarter, once
	// the SDFT has found the tone and the notch has walked onto it.
	const left = rms(out.slice(15000));
	assert.ok(left < 0.05, `the tone is still at RMS ${left.toFixed(3)} against 0.707 in`);
});

t('a 250 Hz loop cannot build a single rotor notch — the whole lot\'s finding', () => {
	const dt = 1 / 250;
	const f = new RpmFilter();
	// A hovering 5": ~200 Hz shaft, well above the 56 Hz ceiling at this rate.
	const w = hzToOmega(200);
	for (let i = 0; i < 100; i++) f.step(Math.random(), [w, w, w, w], dt);
	assert.ok(f.notches.every((e) => e.n.bypass), 'a notch was built above 0.45 * Nyquist');
	// And at 1 kHz the fundamentals come back.
	const g = new RpmFilter();
	for (let i = 0; i < 100; i++) g.step(Math.random(), [w, w, w, w], 1 / 1000);
	assert.equal(g.notches.filter((e) => !e.n.bypass).length, 4, 'the four fundamentals should be notchable at 1 kHz');
});

// ---------------------------------------------------------------------------
// 5. The delay line

t('zero delay hands back the very object it was given', () => {
	const d = new LoopDelay(0);
	const w = { x: 1, y: 2, z: 3 };
	assert.equal(d.step(w, 1 / 250), w);
});

t('a delay of n steps returns the sample from n steps ago', () => {
	const dt = 1 / 1000;
	for (const steps of [1, 2, 5]) {
		const d = new LoopDelay(steps * dt);
		const seen = [];
		for (let i = 0; i < 20; i++) seen.push(d.step({ x: i, y: -i, z: 2 * i }, dt).x);
		for (let i = steps; i < 20; i++) assert.equal(seen[i], i - steps, `delay ${steps}, step ${i}`);
	}
});

t('the delay is quantised to whole steps, rounded not floored', () => {
	const dt = 1 / 1000;
	// 0.4 ms at a 1 ms step is better served by no delay than by a whole one.
	const a = new LoopDelay(0.0004); a.step({ x: 1, y: 0, z: 0 }, dt);
	assert.equal(a.n, 0);
	const b = new LoopDelay(0.0006); b.step({ x: 1, y: 0, z: 0 }, dt);
	assert.equal(b.n, 1);
});

t('the delay resizes when the step stretches, and stays that many seconds', () => {
	const d = new LoopDelay(0.004);
	d.step({ x: 0, y: 0, z: 0 }, 1 / 1000);
	assert.equal(d.n, 4);
	d.step({ x: 0, y: 0, z: 0 }, 1 / 250);
	assert.equal(d.n, 1);
});

console.log(`gyro-selftest : ${n} tests ok`);
