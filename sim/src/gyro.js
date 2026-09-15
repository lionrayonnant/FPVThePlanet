// The gyro, between Rapier and the PID.
//
// Until this file existed, flightController.js read `state.angularVelocity`,
// un-rotated it into the body frame and handed it straight to the rate loop:
// the exact angular velocity of the rigid body, to the last bit, at the exact
// instant the loop ran. No real machine has that, and the whole second half of
// a Betaflight tune — the notches, the RPM filter, the lowpass cutoffs that
// cost phase everybody complains about — exists only because it does not.
// Filtering a perfect signal buys nothing and costs delay, so the filter chain
// upstream of this lot was, strictly, a handicap.
//
// So this is the sensor. It takes the true body rates and the rotor speeds and
// returns what a gyro bolted to that frame would report:
//
//   * broadband noise, specified as a DENSITY rather than a per-sample RMS, so
//     that raising the loop rate does not quietly change how much noise the
//     machine flies with (it changes how much of it lands above the cutoffs,
//     which is the real effect and the one worth keeping);
//   * rotor-synchronous tones — one per motor at its own shaft frequency plus
//     its second harmonic, amplitude growing with rpm squared the way an
//     unbalance force does. These are what a notch is for. Broadband noise
//     alone would have made the notch as decorative as no noise at all.
//
// Determinism: `Propulsion` is seed-deterministic by contract and
// tools/flight-replay-selftest.mjs leans on it. Everything drawn here is drawn
// from a seeded mulberry32 at construction (the per-prop unbalance) or
// integrated from it (the tone phases); nothing calls Math.random.
//
// With `gyroNoise === 0` sample() returns the input vector's components
// unchanged, bit for bit, and takes an early exit before touching the RNG.
// That is the property tools/loop-realism-selftest.mjs asserts.

import { mulberry32 } from './wind.js';

const TWO_PI = Math.PI * 2;

// gyroNoise is quoted as an RMS at this rate. A loop running faster sees the
// same noise DENSITY, i.e. a larger per-sample sigma over a wider band:
// sigma = gyroNoise * sqrt(fs / NOISE_REFERENCE_RATE). 1 kHz because that is
// the rate a Betaflight PID loop is quoted at, and the rate this lot's bench
// concluded on (tools/loop-rate-bench.mjs).
export const NOISE_REFERENCE_RATE = 1000;   // Hz

// How the noise splits. The broadband part is the sensor and the airframe's
// own hash; the synchronous part is the props. Real blackbox logs are
// dominated by the tones — that is why the RPM filter was worth inventing —
// so the tones carry the larger share here too.
const BROADBAND_FRACTION = 0.45;
const SYNC_FRACTION = 0.55;

// Second harmonic of each rotor tone, as a fraction of its fundamental. Two
// harmonics, not three: the third sits above 2 kHz for the fast families and
// no loop rate this simulator will ever run can represent it, so modelling it
// would only add an alias.
const HARMONIC_2 = 0.45;

// Per-prop unbalance spread. Each motor draws its own multiplier once, so the
// four tones are never the same height — which is what makes a notch bank of
// four separate notches worth more than one notch at the mean.
const UNBALANCE_MIN = 0.55, UNBALANCE_MAX = 1.45;

// Rotor speed at which a tone reaches its nominal amplitude. Above and below,
// amplitude follows (omega/ref)^2: an unbalance force is m*r*omega^2, and what
// the gyro picks up is that force through the frame's compliance.
//
// A HOVER, not full throttle: 1500 rad/s is ~14 300 rpm, about where a 5"
// hangs. Quoting the amplitude at full song instead made the tones a sixth of
// their nominal size at the stick a quad spends most of its life on, which is
// backwards — a blackbox log at a hover is dominated by the rotor tones, and
// that dominance is the entire reason the RPM filter was invented. The
// consequence at the other end is that a full-throttle punch is four times
// noisier than a hover, which is also what a log shows.
const OMEGA_REFERENCE = 1500;   // rad/s, ~14 300 rpm — a 5" at a hover

// A rotor's vibration does not arrive on one axis. Each motor gets a fixed
// unit-ish direction so the tones are correlated across axes the way a real
// frame mode is, rather than three independent noises that a per-axis filter
// could average away.
const TONE_AXIS = [
	{ x: 0.62, y: 0.32, z: 0.72 },
	{ x: -0.70, y: 0.28, z: 0.66 },
	{ x: 0.68, y: -0.35, z: -0.64 },
	{ x: -0.60, y: -0.30, z: 0.74 },
];

// Box-Muller, one draw kept in reserve. Gaussian rather than uniform because
// the thing being modelled is a sum of many small contributions and because
// the RMS of a uniform draw is a number nobody can read off the constant.
class Gaussian {
	constructor(rng) { this.rng = rng; this.spare = null; }
	next() {
		if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
		let u = 0, v = 0, s = 0;
		do {
			u = this.rng() * 2 - 1;
			v = this.rng() * 2 - 1;
			s = u * u + v * v;
		} while (s === 0 || s >= 1);
		const k = Math.sqrt((-2 * Math.log(s)) / s);
		this.spare = v * k;
		return u * k;
	}
}

export class Gyro {
	// `noise` is the profile's gyroNoise: rad/s RMS at NOISE_REFERENCE_RATE.
	// 0 (every family today) makes this object a pass-through.
	constructor({ noise = 0, seed = 0x9e37 } = {}) {
		this.noise = noise;
		this.seed = seed >>> 0;
		this.out = { x: 0, y: 0, z: 0 };
		this._rng = mulberry32(this.seed);
		this._gauss = new Gaussian(this._rng);
		// Drawn once and kept: a prop's unbalance is a property of the prop, not
		// of the instant. reset() redraws from the same seed, so a reset machine
		// flies the same four props it flew before.
		this._unbalance = [0, 0, 0, 0];
		this._phase = [0, 0, 0, 0];
		this._draw();
	}

	_draw() {
		for (let i = 0; i < 4; i++) {
			this._unbalance[i] = UNBALANCE_MIN + this._rng() * (UNBALANCE_MAX - UNBALANCE_MIN);
			this._phase[i] = this._rng() * TWO_PI;
		}
	}

	reset() {
		this._rng = mulberry32(this.seed);
		this._gauss = new Gaussian(this._rng);
		this._draw();
	}

	// True body rates + rotor speeds -> what the gyro reports.
	//
	//   w           body angular velocity, rad/s, {x,y,z}
	//   rotorOmega  four shaft speeds in rad/s, or null when the caller has
	//               none (the headless benches drive the controller without a
	//               Propulsion). Without them there are no tones, only the
	//               broadband part — which is exactly the signal a loop with no
	//               RPM telemetry sees, so it is the honest degradation.
	//   dt          the loop step, seconds
	sample(w, rotorOmega, dt) {
		const out = this.out;
		// The zero-noise path. No RNG call, no phase integration, no arithmetic
		// on the components: the loop reads the same doubles it read before this
		// file existed.
		if (!(this.noise > 0) || !(dt > 0)) {
			out.x = w.x; out.y = w.y; out.z = w.z;
			return out;
		}

		const fs = 1 / dt;
		const sigma = this.noise * BROADBAND_FRACTION * Math.sqrt(fs / NOISE_REFERENCE_RATE);
		let nx = this._gauss.next() * sigma;
		let ny = this._gauss.next() * sigma;
		let nz = this._gauss.next() * sigma;

		if (rotorOmega) {
			// SYNC_FRACTION is an RMS over four tones, so each tone carries
			// 1/sqrt(4) of it: the total does not grow just because the airframe
			// has four motors rather than one.
			const per = (this.noise * SYNC_FRACTION) / 2;
			for (let i = 0; i < 4; i++) {
				const omega = rotorOmega[i];
				if (!(omega > 0)) continue;
				this._phase[i] = (this._phase[i] + omega * dt) % TWO_PI;
				const ph = this._phase[i];
				const load = (omega / OMEGA_REFERENCE) ** 2;
				const a = per * this._unbalance[i] * load;
				// The fundamental and its second harmonic, which is the pair a
				// blackbox log actually shows. Amplitudes are peak, and the RMS
				// of a sinusoid is its peak over sqrt(2) — folded into `per`
				// above rather than written here on every axis.
				const s = Math.sin(ph) + HARMONIC_2 * Math.sin(2 * ph);
				const d = TONE_AXIS[i];
				nx += a * s * d.x;
				ny += a * s * d.y;
				nz += a * s * d.z;
			}
		}

		out.x = w.x + nx;
		out.y = w.y + ny;
		out.z = w.z + nz;
		return out;
	}
}

// ---------------------------------------------------------------------------
// Filters
//
// Everything below is what the loop does about the signal above. None of it is
// worth a single multiply while gyroNoise is 0, and all of it is bypassed on
// that path — see FilterChain.enabled.

// Direct-form-II transposed biquad notch (RBJ cookbook). Coefficients are
// recomputed only when the centre frequency or the step has actually moved, so
// a hovering machine pays four trig calls a second rather than four a step.
export class Notch {
	constructor(q = 3) {
		this.q = q;
		this.f = 0; this.dt = 0;
		this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
		this.z1 = 0; this.z2 = 0;
		this.bypass = true;
	}

	reset() { this.z1 = 0; this.z2 = 0; }

	// A notch above 0.45 * Nyquist is not a notch: its coefficients degenerate
	// and it eats the top of the band instead of a tone. Asked for one, this
	// says so by going transparent rather than by quietly wrecking the loop —
	// and that refusal is the whole content of this lot's loop-rate decision.
	// See tools/loop-rate-bench.mjs.
	setFrequency(f, dt) {
		if (!(f > 0) || !(dt > 0) || f > 0.45 / (2 * dt)) { this.bypass = true; return false; }
		// 1 % of the centre frequency: below that the coefficient change is
		// smaller than the numerical noise it would introduce.
		if (this.bypass || dt !== this.dt || Math.abs(f - this.f) > 0.01 * this.f) {
			const w0 = TWO_PI * f * dt;
			const alpha = Math.sin(w0) / (2 * this.q);
			const cos = Math.cos(w0);
			const a0 = 1 + alpha;
			this.b0 = 1 / a0;
			this.b1 = (-2 * cos) / a0;
			this.b2 = 1 / a0;
			this.a1 = (-2 * cos) / a0;
			this.a2 = (1 - alpha) / a0;
			this.f = f; this.dt = dt;
		}
		this.bypass = false;
		return true;
	}

	step(x) {
		if (this.bypass) return x;
		const y = this.b0 * x + this.z1;
		this.z1 = this.b1 * x - this.a1 * y + this.z2;
		this.z2 = this.b2 * x - this.a2 * y;
		return y;
	}
}

// Betaflight's RPM filter: one notch per motor per harmonic, centred on that
// motor's own shaft frequency, moved every step by the ESC's rpm telemetry.
// Here the telemetry is exact, which is the one place this model is kinder
// than the hardware.
export const RPM_HARMONICS = 2;
const RPM_Q = 5;
// Betaflight's rpm_filter_min_hz. A notch that follows a motor down to idle
// ends up sitting on the loop's own bandwidth and eating the tune.
const RPM_MIN_HZ = 100;

export class RpmFilter {
	constructor() {
		this.notches = [];
		for (let m = 0; m < 4; m++) {
			for (let h = 1; h <= RPM_HARMONICS; h++) this.notches.push({ m, h, n: new Notch(RPM_Q) });
		}
	}
	reset() { for (const e of this.notches) e.n.reset(); }
	step(x, rotorOmega, dt) {
		if (!rotorOmega) return x;
		let y = x;
		for (const e of this.notches) {
			// Magnitude: in Acro3D a rotor turns backwards, and a shaft spinning
			// the other way vibrates at the same frequency. Without the abs the
			// notch is handed a negative centre frequency and goes transparent at
			// exactly the moment the machine is inverted and needs it most. Taken
			// here rather than in physics.js, whose `rotorOmega` getter returns
			// the live array on purpose and must not allocate a copy per step.
			const f = (Math.abs(rotorOmega[e.m]) / TWO_PI) * e.h;
			if (f < RPM_MIN_HZ) { e.n.bypass = true; continue; }
			e.n.setFrequency(f, dt);
			y = e.n.step(y);
		}
		return y;
	}
}

// ---------------------------------------------------------------------------
// Dynamic notch.
//
// The RPM filter knows where the rotor tones are because it is told. The
// dynamic notch has to find out — which is what earns it the peak that is NOT
// a rotor tone: a frame resonance, a loose arm, a soft mount. Betaflight uses
// a sliding DFT for this, and so does this: a 64-point SDFT per axis, updated
// one sample at a time by the recursion
//
//   X_k <- e^{j.2pi.k/N} . (r.X_k + x_new - r^N . x_old)
//
// with r slightly below 1 so a coefficient error cannot accumulate forever.
// The peak is searched every SDFT_ANALYSE samples rather than every sample:
// the tone it is chasing moves with the throttle, not with the step.
const SDFT_N = 64;
const SDFT_BINS = 31;           // 1..31; bin 0 is DC and 32 is Nyquist
const SDFT_DAMP = 0.999;
const SDFT_ANALYSE = 16;
const DYN_Q = 3.5;
const DYN_MIN_HZ = 80;
// How fast the notch is allowed to walk to a newly found peak. A notch that
// teleports is a notch that clicks.
const DYN_SLEW = 0.15;

export class DynamicNotch {
	constructor() {
		this.re = new Float64Array(SDFT_BINS + 1);
		this.im = new Float64Array(SDFT_BINS + 1);
		this.hist = new Float64Array(SDFT_N);
		this.head = 0;
		this.count = 0;
		this.notch = new Notch(DYN_Q);
		this.centre = 0;
		this.cosk = new Float64Array(SDFT_BINS + 1);
		this.sink = new Float64Array(SDFT_BINS + 1);
		for (let k = 0; k <= SDFT_BINS; k++) {
			this.cosk[k] = Math.cos((TWO_PI * k) / SDFT_N);
			this.sink[k] = Math.sin((TWO_PI * k) / SDFT_N);
		}
		this.rN = SDFT_DAMP ** SDFT_N;
	}

	reset() {
		this.re.fill(0); this.im.fill(0); this.hist.fill(0);
		this.head = 0; this.count = 0; this.centre = 0;
		this.notch.reset(); this.notch.bypass = true;
	}

	push(x) {
		const old = this.hist[this.head];
		this.hist[this.head] = x;
		this.head = (this.head + 1) % SDFT_N;
		const delta = x - this.rN * old;
		for (let k = 1; k <= SDFT_BINS; k++) {
			const r = SDFT_DAMP * this.re[k] + delta;
			const i = SDFT_DAMP * this.im[k];
			this.re[k] = r * this.cosk[k] - i * this.sink[k];
			this.im[k] = r * this.sink[k] + i * this.cosk[k];
		}
		this.count++;
	}

	// The loudest bin, refined by a parabolic fit on its two neighbours so the
	// notch can land between bins — at 64 points and a 1 kHz loop a bin is
	// 15.6 Hz wide, which is wider than the notch itself.
	peakHz(fs) {
		let best = 0, bestMag = 0;
		const minBin = Math.max(1, Math.ceil((DYN_MIN_HZ * SDFT_N) / fs));
		for (let k = minBin; k <= SDFT_BINS; k++) {
			const m = this.re[k] * this.re[k] + this.im[k] * this.im[k];
			if (m > bestMag) { bestMag = m; best = k; }
		}
		if (best === 0) return 0;
		let bin = best;
		if (best > 1 && best < SDFT_BINS) {
			// Jacobsen's estimator, on the COMPLEX bins rather than a parabola
			// through their magnitudes. The parabola is the obvious thing and it
			// is biased: on a 64-point rectangular window a 210 Hz tone came back
			// as 195 Hz, 7 % low, which put the notch a bandwidth away from the
			// thing it was meant to remove and left two thirds of it standing.
			//   d = -Re[ (X[k+1] - X[k-1]) / (2X[k] - X[k-1] - X[k+1]) ]
			const l = best - 1, c = best, r = best + 1;
			const nr = this.re[r] - this.re[l], ni = this.im[r] - this.im[l];
			const dr = 2 * this.re[c] - this.re[l] - this.re[r];
			const di = 2 * this.im[c] - this.im[l] - this.im[r];
			const den = dr * dr + di * di;
			if (den > 0) {
				const real = (nr * dr + ni * di) / den;
				bin += Math.max(-0.5, Math.min(0.5, -real));
			}
		}
		return (bin * fs) / SDFT_N;
	}

	step(x, dt) {
		this.push(x);
		if (this.count >= SDFT_N && this.count % SDFT_ANALYSE === 0) {
			const f = this.peakHz(1 / dt);
			if (f > 0) this.centre = this.centre === 0 ? f : this.centre + (f - this.centre) * DYN_SLEW;
		}
		if (this.centre > 0) this.notch.setFrequency(this.centre, dt);
		return this.notch.step(x);
	}
}

// One axis' worth of gyro conditioning: RPM notches, then the dynamic notch.
// Ordered that way on purpose — with the rotor tones already gone, the peak
// the SDFT finds is the one nobody told the loop about.
export class AxisFilter {
	constructor() {
		this.rpm = new RpmFilter();
		this.dyn = new DynamicNotch();
	}
	reset() { this.rpm.reset(); this.dyn.reset(); }
	step(x, rotorOmega, dt) {
		return this.dyn.step(this.rpm.step(x, rotorOmega, dt), dt);
	}
}

// ---------------------------------------------------------------------------

// Pure loop latency: gyro sample in at t, the same sample out at t + delay.
//
// It sits on the SENSOR and not on the motor command because the loop's phase
// margin only knows the total delay around it, and one three-component delay
// line on the way in is cheaper and far easier to reason about than four on
// the way out — where it would also have had to argue with the mixer's airmode
// rescaling, which is a function of the CURRENT throttle and must not be fed a
// stale one.
//
// The delay is quantised to whole steps, which is what it is on a real machine
// too: the loop is a sampled system and a sample cannot arrive half-late. A
// zero delay costs one branch and copies nothing.
export class LoopDelay {
	constructor(seconds = 0) {
		this.seconds = seconds;
		this.n = 0;
		this.buf = null;
		this.i = 0;
		this.out = { x: 0, y: 0, z: 0 };
	}

	// Sized against the step it is actually running at, and resized if the step
	// changes (frame-pacing.js stretches it under load). Rounding, not ceil: a
	// requested delay of 0.4 steps is better served by no delay than by a whole
	// one, and `loopDelay` is a physical number, not a step count.
	_size(dt) {
		const n = Math.max(0, Math.round(this.seconds / dt));
		if (n === this.n && this.buf) return;
		this.n = n;
		this.buf = n > 0 ? new Float64Array(n * 3) : null;
		this.i = 0;
	}

	reset() { if (this.buf) this.buf.fill(0); this.i = 0; }

	step(w, dt) {
		if (!(this.seconds > 0) || !(dt > 0)) return w;
		this._size(dt);
		if (this.n === 0) return w;
		const b = this.buf, o = this.i * 3;
		this.out.x = b[o]; this.out.y = b[o + 1]; this.out.z = b[o + 2];
		b[o] = w.x; b[o + 1] = w.y; b[o + 2] = w.z;
		this.i = (this.i + 1) % this.n;
		return this.out;
	}
}
