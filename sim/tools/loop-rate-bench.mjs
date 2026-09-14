// What rate the control loop has to run at, once the gyro stops being perfect.
//
// This bench exists to settle one question with numbers instead of taste. The
// simulator's control loop runs on the physics grid, 250 Hz, so its Nyquist is
// 125 Hz. Rotor vibration — the thing a notch filter exists to remove, and the
// only reason Betaflight's filter chain is shaped the way it is — lives at the
// shaft frequency, which on these six airframes is hundreds of hertz. If those
// tones cannot be represented, then src/gyro.js's notches are decoration and
// the honest thing is to say so and delete them.
//
//   node tools/loop-rate-bench.mjs              # the whole case
//   node tools/loop-rate-bench.mjs --tones      # where the tones actually are
//   node tools/loop-rate-bench.mjs --alias      # what a 250 Hz loop hears
//   node tools/loop-rate-bench.mjs --reject     # what the notches remove, per rate
//   node tools/loop-rate-bench.mjs --cost       # what the substeps cost
//   node tools/loop-rate-bench.mjs --antigravity
//   node tools/loop-rate-bench.mjs --dmax
//   node tools/loop-rate-bench.mjs --ramp       # the noise/latency ramp
//   node tools/loop-rate-bench.mjs --margin     # how much latency each tune survives
//
// Nothing here writes into src/. Every setting it prices is a constructor
// option on FlightController, never an edit to a profile.

import { performance } from 'node:perf_hooks';
import { Propulsion } from '../src/quad.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController } from '../src/flightController.js';
import { DynamicNotch } from '../src/gyro.js';
import { CONTROL_RATES } from '../src/frame-pacing.js';

const DEG = Math.PI / 180;
const ZERO = { x: 0, y: 0, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const PHYS_DT = 1 / 250;

// The noise level the ramp settles on, and the one every comparison below is
// made at. rad/s RMS at 1 kHz (src/gyro.js NOISE_REFERENCE_RATE). 0.08 rad/s is
// ~4.6 deg/s, which is a clean-but-real 5" build: a blackbox log off a quad
// with balanced props and soft mounts sits around there, and a quad with a
// chipped prop is several times worse.
const NOISE = 0.08;

// ---------------------------------------------------------------------------
// The plant. Rigid-body rotation against the real mixer and the real motor lag,
// the same shape tools/tune-pid.mjs uses — deliberately, so the numbers here
// can be read against the tune that tool produced. The one addition is that the
// rotor speeds are handed to the controller, which is what the RPM notches
// follow.
function fly({
	profile, seconds, rate, stick = () => 0, axis = 'roll', throttle = 0.35,
	gyroNoise = 0, loopDelay = 0, filters, antiGravity, dMax, seed = 0x9e37,
	record = true, cgOffset = 0,
}) {
	const dt = 1 / rate;
	const fc = new FlightController({ profile, gyroNoise, loopDelay, filters, antiGravity, dMax, seed });
	const prop = new Propulsion({ profile });
	const I = profile.inertia;
	let w = { x: 0, y: 0, z: 0 };
	const steps = Math.round(seconds / dt);
	const out = { t: [], w: [], motors: [], rotorHz: [], fc };
	// The physics integrates on its own grid; the controller substeps inside it.
	const sub = Math.max(1, Math.round(rate / 250));
	let motors = [0, 0, 0, 0];
	for (let i = 0; i < steps; i++) {
		const t = i * dt;
		const s = { throttle: typeof throttle === 'function' ? throttle(t) : throttle, roll: 0, pitch: 0, yaw: 0 };
		s[axis] = stick(t);
		const state = {
			rotation: IDENTITY, angularVelocity: w, position: ZERO, velocity: ZERO,
			rotorOmega: prop.omega,
		};
		({ motors } = fc.update(s, state, dt));
		// The timing section runs with record off: three array pushes per step
		// are not the controller's cost, and at 4 kHz they are sixteen times the
		// allocation of the 250 Hz row — which is exactly how a measurement ends
		// up saying the opposite of the truth.
		if (record) {
			out.t.push(t);
			out.w.push({ ...w });
			out.motors.push([...motors]);
			out.rotorHz.push(prop.omega[0] / (2 * Math.PI));
		}
		// One physics step per `sub` control steps: the airframe is integrated on
		// the 250 Hz grid whatever the loop does, which is the whole point of the
		// substep design.
		if ((i + 1) % sub !== 0) continue;
		const { torque, force } = prop.step(motors, { v: ZERO, omega: w, agl: null, shake: 0 }, PHYS_DT);
		// A centre of gravity `cgOffset` metres off the rotor centroid. The pitch
		// torque it produces is thrust * offset, so it GROWS with the throttle —
		// which is the whole of the anti-gravity story: punch the stick and the
		// trim the I term was holding becomes a fraction of the trim the machine
		// needs, while TPA has just cut P and D by up to 55 %. With no asymmetry
		// there is nothing for anti-gravity to fight, and the first version of
		// section E duly measured a flat zero.
		const tx = torque.x + force.y * cgOffset;
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		const g = {
			x: w.y * Iw.z - w.z * Iw.y,
			y: w.z * Iw.x - w.x * Iw.z,
			z: w.x * Iw.y - w.y * Iw.x,
		};
		w = {
			x: w.x + ((tx - g.x) / I.x) * PHYS_DT,
			y: w.y + ((torque.y - g.y) / I.y) * PHYS_DT,
			z: w.z + ((torque.z - g.z) / I.z) * PHYS_DT,
		};
	}
	return out;
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

// The quantity a pilot feels as "hot motors and a buzzing quad": how much the
// motor command moves when nothing is asking it to. Noise that the filters do
// not remove ends up here, through D, and from here it ends up as heat.
function motorRipple(trace, fromFraction = 0.4) {
	const n = trace.motors.length;
	const from = Math.floor(n * fromFraction);
	let acc = 0, cnt = 0;
	for (let m = 0; m < 4; m++) {
		const series = [];
		for (let i = from; i < n; i++) series.push(trace.motors[i][m]);
		const mean = series.reduce((a, b) => a + b, 0) / series.length;
		acc += rms(series.map((v) => v - mean));
		cnt++;
	}
	return acc / cnt;
}

// ---------------------------------------------------------------------------
// A. Where the tones are.

function tones() {
	console.log('\nA. Rotor tones against each candidate loop rate');
	console.log('   A notch is buildable only below 0.45 * Nyquist (src/gyro.js');
	console.log('   Notch.setFrequency); above that its coefficients degenerate and it');
	console.log('   eats the top of the band instead of a tone.\n');
	console.log(`   ${'rate'.padStart(6)}  Nyquist  notch ceiling`);
	for (const hz of CONTROL_RATES) {
		console.log(`   ${String(hz).padStart(6)}  ${String(hz / 2).padStart(7)}  ${(0.45 * hz / 2).toFixed(0).padStart(13)} Hz`);
	}
	console.log(`\n   ${'family'.padEnd(11)} ${'idle'.padStart(7)} ${'hover'.padStart(7)} ${'cruise'.padStart(7)} ${'full'.padStart(7)}   (Hz, fundamental)`);
	let min = Infinity, max = 0;
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const row = [];
		for (const cmd of [0.1, 0.35, 0.55, 1.0]) {
			const prop = new Propulsion({ profile: p });
			prop.primeFor(cmd);
			const hz = prop.omega[0] / (2 * Math.PI);
			row.push(hz);
			if (cmd >= 0.35) { min = Math.min(min, hz); max = Math.max(max, hz); }
		}
		console.log(`   ${f.padEnd(11)} ${row.map((v) => v.toFixed(0).padStart(7)).join(' ')}`);
	}
	console.log(`\n   In flight (hover and above) the fundamentals span ${min.toFixed(0)}-${max.toFixed(0)} Hz.`);
	for (const hz of CONTROL_RATES) {
		const ceil = 0.45 * hz / 2;
		const ok = ceil >= max ? 'every fundamental is'
			: ceil >= min ? 'only the slowest fundamentals are' : 'NOT ONE fundamental is';
		console.log(`   ${String(hz).padStart(6)} Hz loop: ceiling ${ceil.toFixed(0).padStart(4)} Hz -> ${ok} notchable` +
			`${ceil >= max ? `; 2nd harmonics need ${(2 * max / 0.45 * 2).toFixed(0)} Hz` : ''}`);
	}
}

// ---------------------------------------------------------------------------
// B. What a slow loop hears instead.

function alias() {
	console.log('\nB. A pure rotor tone, sampled at each loop rate');
	console.log('   The SDFT of src/gyro.js is asked where the tone is. A rate whose');
	console.log('   answer is not the tone is a rate that has been lied to.\n');
	console.log(`   ${'tone'.padStart(6)}  ${CONTROL_RATES.map((r) => `${r} Hz`.padStart(9)).join('')}`);
	for (const tone of [250, 333, 400, 500, 650, 800]) {
		const cells = [];
		for (const fs of CONTROL_RATES) {
			const d = new DynamicNotch();
			const dt = 1 / fs;
			for (let i = 0; i < 4096; i++) d.push(Math.sin(2 * Math.PI * tone * i * dt));
			const found = d.peakHz(fs);
			const truth = Math.abs(found - tone) < 0.05 * tone;
			cells.push(`${found.toFixed(0)}${truth ? ' ' : '*'}`.padStart(9));
		}
		console.log(`   ${String(tone).padStart(6)}  ${cells.join('')}`);
	}
	console.log('   * = aliased: the loop hears a tone that is not there, at a frequency');
	console.log('     no notch can be placed on, and the PID chases it.');
}

// ---------------------------------------------------------------------------
// C. What the conditioning chain removes, per rate.

function reject(family = DEFAULT_FAMILY) {
	const profile = PROFILES[family];
	console.log(`\nC. Noise through the loop — ${family}, gyroNoise ${NOISE} rad/s, hover stick`);
	console.log('   "ripple" is the RMS motion of the motor command with nothing asking');
	console.log('   for any: it is the noise that survived the filters, on its way to');
	console.log('   becoming heat. "active" counts the notches that could actually be');
	console.log('   built at that rate, out of the 9 one axis carries (4 motors x 2');
	console.log('   harmonics, plus the dynamic notch). "step" is a full-stick roll');
	console.log('   flick measured the way tools/tune-pid.mjs measures it, so the phase');
	console.log('   the filters cost shows up as a slower rise.\n');
	const clean = fly({ profile, seconds: 2.0, rate: 250 });
	console.log(`   a perfect gyro at 250 Hz ripples ${motorRipple(clean).toExponential(2)} — the loop is quiet because`);
	console.log('   there is nothing to be quiet about. Every row below has the noise on.\n');
	console.log(`   ${'rate'.padStart(6)}  ${'notches'.padStart(8)}  ${'active'.padStart(6)}  ${'ripple'.padStart(9)}  ${'removed'.padStart(8)}  ${'rise'.padStart(6)}  ${'over'.padStart(6)}  ${'bounce'.padStart(7)}`);
	for (const rate of CONTROL_RATES) {
		let off = null;
		for (const filters of [false, true]) {
			const opts = { gyroNoise: NOISE, filters };
			const tr = fly({ profile, seconds: 2.0, rate, ...opts });
			const r = motorRipple(tr);
			if (!filters) off = r;
			const act = filters ? activeNotches(tr.fc) : 0;
			const removed = filters ? `${(100 * (1 - r / off)).toFixed(1)}%` : '--';
			console.log(`   ${String(rate).padStart(6)}  ${(filters ? 'on' : 'off').padStart(8)}  ${String(act).padStart(6)}  ${r.toExponential(2).padStart(9)}  ${removed.padStart(8)}  ${stepOf(profile, rate, opts).join('  ')}`);
		}
	}
}

// How many of one axis' notches were left standing at the end of a run. A
// notch whose centre frequency is above 0.45 * Nyquist goes transparent rather
// than degenerate (src/gyro.js), so this counts exactly what the rate allows.
function activeNotches(fc) {
	const f = fc.pid.roll.notches;
	if (!f) return 0;
	let n = f.rpm.notches.filter((e) => !e.n.bypass).length;
	if (!f.dyn.notch.bypass) n++;
	return n;
}

// A full-stick roll flick and the stop after it: rise to 90 %, overshoot, and
// the rate still left 100 ms after the stick centres. The same three numbers
// tools/tune-pid.mjs prints, measured the same way, so a row here can be read
// against the tune that tool wrote.
const FLICK_AT = 0.15, FLICK_OFF = 0.55, BOUNCE_AT = 0.65;

function stepOf(profile, rate, opts) {
	const tr = fly({
		profile, seconds: 0.8, rate, axis: 'roll',
		stick: (t) => (t >= FLICK_AT && t < FLICK_OFF ? 1 : 0), ...opts,
	});
	const at = (t) => tr.t.findIndex((v) => v >= t);
	// -Z is roll right; the setpoint is the preset's full-stick rate.
	const hold = tr.w.slice(at(FLICK_AT), at(FLICK_OFF));
	const peak = Math.max(...hold.map((w) => Math.abs(w.z)));
	const tail = hold.slice(Math.floor(hold.length * 0.6));
	const final = tail.reduce((a, w) => a + Math.abs(w.z), 0) / tail.length;
	let rise = NaN;
	for (let i = at(FLICK_AT); i < tr.t.length; i++) {
		if (Math.abs(tr.w[i].z) >= 0.9 * final) { rise = (tr.t[i] - FLICK_AT) * 1000; break; }
	}
	const over = ((peak - final) / final) * 100;
	const bounce = (Math.abs(tr.w[at(BOUNCE_AT)].z) / final) * 100;
	return [`${rise.toFixed(0).padStart(4)}ms`, `${over.toFixed(1).padStart(5)}%`, `${bounce.toFixed(1).padStart(6)}%`];
}

// ---------------------------------------------------------------------------
// D. What the substeps cost.

function cost(family = DEFAULT_FAMILY) {
	const profile = PROFILES[family];
	console.log(`\nD. CPU — ${family}`);
	console.log('   The repo has been wrong about this before (a mode believed GPU-bound');
	console.log('   that was CPU-bound), so it is measured and not assumed. Recording is');
	console.log('   off in these runs: three array pushes per step are not the');
	console.log('   controller, and at 4 kHz they would be sixteen times the allocation');
	console.log('   of the 250 Hz row. The physics grid stays 250 Hz in every row, so the');
	console.log('   Rapier half of a step is the same work throughout and the difference');
	console.log('   below is the controller and nothing else.\n');
	// Every configuration is warmed BEFORE any of them is timed. Warming each
	// row just before its own timing is not enough: the first row still pays for
	// the shapes and the inline caches every later row then reuses, which is how
	// the first version of this table made the 250 Hz loop look dearer than the
	// 1000 Hz one.
	for (const rate of CONTROL_RATES) {
		for (const filters of [false, true]) {
			fly({ profile, seconds: 1, rate, record: false, gyroNoise: filters ? NOISE : 0, filters });
		}
	}
	const bench = (rate, opts) => {
		for (let i = 0; i < 3; i++) fly({ profile, seconds: 1, rate, record: false, ...opts });
		let best = Infinity;
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			fly({ profile, seconds: 2, rate, record: false, ...opts });
			best = Math.min(best, (performance.now() - t0) / 2);
		}
		return best;   // best of five: the floor is the work, the rest is the OS
	};
	console.log(`   ${'rate'.padStart(6)}  ${'substeps'.padStart(8)}  ${'notches'.padStart(8)}  ${'ms/simulated s'.padStart(15)}  ${'us/update'.padStart(10)}`);
	const rows = [];
	for (const rate of CONTROL_RATES) {
		for (const filters of [false, true]) {
			const ms = bench(rate, { gyroNoise: filters ? NOISE : 0, filters });
			rows.push({ rate, filters, ms });
			console.log(`   ${String(rate).padStart(6)}  ${String(rate / 250).padStart(8)}  ${(filters ? 'on' : 'off').padStart(8)}  ${ms.toFixed(2).padStart(12)} ms  ${((ms * 1000) / rate).toFixed(3).padStart(10)}`);
		}
	}
	const ref = rows.find((r) => r.rate === 250 && !r.filters).ms;
	console.log(`\n   Against the 250 Hz loop as shipped (${ref.toFixed(2)} ms per simulated second,`);
	console.log('   i.e. one real second of flight in real time):\n');
	for (const r of rows) {
		if (r.rate === 250 && !r.filters) continue;
		const d = r.ms - ref;
		console.log(`   ${String(r.rate).padStart(6)} Hz notches ${r.filters ? 'on ' : 'off'}: ` +
			`${d >= 0 ? '+' : ''}${d.toFixed(2)} ms/s  = ${(d / 10).toFixed(3)} % of one core, ` +
			`${((d / 60) / 16.7 * 100).toFixed(3)} % of a 60 fps frame`);
	}
}

// ---------------------------------------------------------------------------
// E. Anti-gravity.

function antigravity(family = DEFAULT_FAMILY) {
	const profile = PROFILES[family];
	// 5 mm: a pack strapped a little back, a GoPro on the front plate. Every
	// real quad has one and nobody flies with it at zero.
	const CG = 0.005;
	console.log(`\nE. Anti-gravity — ${family}, CoG ${CG * 1000} mm off centre, throttle punched 0.25 -> 0.95 at t = 0.6 s`);
	console.log('   The sticks ask for level flight throughout. What is measured is the');
	console.log('   pitch the machine gives away anyway. The trim torque a CoG offset');
	console.log('   needs is thrust * offset, so it grows with the punch while the I term');
	console.log('   is still holding the hover value and TPA has just cut P and D. A real');
	console.log('   quad drops its nose here; with the offset in, so does this one.\n');
	const punch = (t) => (t < 0.6 ? 0.25 : 0.95);
	console.log(`   ${'gain'.padStart(6)}  ${'peak pitch rate'.padStart(16)}  ${'pitch given away'.padStart(17)}`);
	let ref = null;
	for (const gain of [0, 1.5, 3.5, 6.0]) {
		// 0.6 s of steady flight first: without a loaded I term there is nothing
		// for the punch to disturb.
		const tr = fly({
			profile, seconds: 1.8, rate: 1000, axis: 'pitch', throttle: punch,
			stick: () => 0, antiGravity: gain, cgOffset: CG,
		});
		const from = tr.t.findIndex((t) => t >= 0.6);
		const base = tr.w[from].x;
		const peak = Math.max(...tr.w.slice(from).map((w) => Math.abs(w.x - base))) / DEG;
		// The angle actually given away: the excess rate integrated over the punch.
		let angle = 0;
		for (let i = from; i < tr.w.length; i++) angle += Math.abs(tr.w[i].x - base) / 1000;
		angle /= DEG;
		if (ref === null) ref = { peak, angle };
		const d = gain === 0 ? '' : `   ${(100 * (1 - angle / ref.angle)).toFixed(0)} % less than gain 0`;
		console.log(`   ${gain.toFixed(1).padStart(6)}  ${peak.toFixed(1).padStart(13)} d/s  ${angle.toFixed(2).padStart(13)} deg${d}`);
	}
}

// ---------------------------------------------------------------------------
// F. D-max.

function dmax(family = DEFAULT_FAMILY) {
	const profile = PROFILES[family];
	console.log(`\nF. D-max — ${family}, full-stick roll flick, gyroNoise ${NOISE}`);
	console.log('   D is the term that amplifies gyro noise, so a tune picks a D that is');
	console.log('   quiet at rest — and is then short of D in the flick. D-max lets it');
	console.log('   rise while the stick is moving. "ripple" is the resting cost,');
	console.log('   "bounce" the flick benefit.\n');
	console.log(`   ${'ratio'.padStart(6)}  ${'rise'.padStart(6)}  ${'over'.padStart(6)}  ${'bounce'.padStart(7)}  ${'ripple'.padStart(9)}`);
	for (const ratio of [1.0, 1.3, 1.6, 2.0]) {
		const opts = { gyroNoise: NOISE, filters: true, dMax: ratio };
		const s = stepOf(profile, 1000, opts);
		const r = motorRipple(fly({ profile, seconds: 2.0, rate: 1000, ...opts }));
		console.log(`   ${ratio.toFixed(1).padStart(6)}  ${s.join('  ')}  ${r.toExponential(2).padStart(9)}`);
	}
}

// ---------------------------------------------------------------------------
// G. The ramp. What each step of turning realism on actually costs the tune.

function ramp(family = DEFAULT_FAMILY) {
	const profile = PROFILES[family];
	console.log(`\nG. The ramp — ${family} at 1000 Hz, one setting at a time`);
	console.log('   Every row is a full-stick roll flick. The tune in');
	console.log('   src/drone-profiles.js was swept against row 1; the further a row is');
	console.log('   from it, the more of a re-sweep the setting owes.\n');
	const rows = [
		['0. as shipped, 250 Hz', 250, {}],
		['1. 1000 Hz, no noise', 1000, {}],
		['2. + gyroNoise 0.04', 1000, { gyroNoise: 0.04, filters: true }],
		['3. + gyroNoise 0.08', 1000, { gyroNoise: NOISE, filters: true }],
		['4. + notches off', 1000, { gyroNoise: NOISE, filters: false }],
		['5. 0.08 + delay 1 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.001 }],
		['6. 0.08 + delay 2 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.002 }],
		['7. 0.08 + delay 3 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.003 }],
		['8. 0.08 + delay 4 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.004 }],
		['9. 0.08 + delay 6 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.006 }],
		['10. 0.08 + delay 8 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.008 }],
		['11. 0.08 + delay 12 ms', 1000, { gyroNoise: NOISE, filters: true, loopDelay: 0.012 }],
	];
	console.log(`   ${''.padEnd(24)} ${'rise'.padStart(6)}  ${'over'.padStart(6)}  ${'bounce'.padStart(7)}  ${'ripple'.padStart(9)}`);
	for (const [label, rate, opts] of rows) {
		const s = stepOf(profile, rate, opts);
		const r = motorRipple(fly({ profile, seconds: 2.0, rate, ...opts }));
		console.log(`   ${label.padEnd(24)} ${s.join('  ')}  ${r.toExponential(2).padStart(9)}`);
	}
}

// ---------------------------------------------------------------------------
// H. Delay margin.
//
// How much latency each family's tune survives. This is the number that says
// what `loopDelay` is allowed to become: the tune in src/drone-profiles.js was
// swept at zero delay, and every millisecond added eats phase margin it never
// had to spare.
//
// The criterion is tools/tune-pid.mjs's own: overshoot past 10 % is a tune
// nobody would fly, whatever else it does well.
const OVERSHOOT_LIMIT = 10;

function margin() {
	console.log('\nH. How much loop latency each family\'s tune survives');
	console.log(`   The stop criterion is tools/tune-pid.mjs's: overshoot past ${OVERSHOOT_LIMIT} % on a`);
	console.log('   full-stick roll flick. At 1000 Hz, noise on, notches on.\n');
	console.log(`   ${'family'.padEnd(11)}  ${'last good delay'.padStart(15)}  ${'overshoot there'.padStart(15)}  ${'first bad'.padStart(9)}`);
	for (const f of FAMILIES) {
		const profile = PROFILES[f];
		let last = null, lastOver = 0, bad = null, badOver = 0;
		for (const ms of [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32]) {
			const over = Number(stepOf(profile, 1000, {
				gyroNoise: NOISE, filters: true, loopDelay: ms / 1000,
			})[1].replace('%', ''));
			if (!Number.isFinite(over) || over > OVERSHOOT_LIMIT) { bad = ms; badOver = over; break; }
			last = ms; lastOver = over;
		}
		// A family that fails at 0 ms has no latency budget at all: the NOISE
		// alone already put it past the limit, before any delay was added. Saying
		// "0 ms" would read as "it survives none", which is true but hides that
		// the tune is already out at this noise level.
		if (last === null) {
			console.log(`   ${f.padEnd(11)}  ${'none'.padStart(15)}  ${'--'.padStart(15)}  ${'0 ms'.padStart(9)}   ! ${badOver.toFixed(1)} % at zero delay: the noise alone is over the limit`);
			continue;
		}
		console.log(`   ${f.padEnd(11)}  ${`${last} ms`.padStart(15)}  ${`${lastOver.toFixed(1)} %`.padStart(15)}  ${(bad === null ? '> 32 ms' : `${bad} ms`).padStart(9)}`);
	}
	console.log('\n   A real 5" running Betaflight at 1 kHz sits at 2-4 ms of loop-to-motor');
	console.log('   latency end to end, most of it ESC and filter group delay that');
	console.log('   src/motor.js and the PT1 chain already model. What `loopDelay` is for');
	console.log('   is the REST: the link, the scheduler, the sampling jitter.');
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const family = argv.find((a) => FAMILIES.includes(a)) ?? DEFAULT_FAMILY;
const only = argv.filter((a) => a.startsWith('--'));
const want = (flag) => only.length === 0 || only.includes(flag);

if (want('--tones')) tones();
if (want('--alias')) alias();
if (want('--reject')) reject(family);
if (want('--cost')) cost(family);
if (want('--antigravity')) antigravity(family);
if (want('--dmax')) dmax(family);
if (want('--ramp')) ramp(family);
if (want('--margin')) margin();
