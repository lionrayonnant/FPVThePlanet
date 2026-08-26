import { QUAD, MOTORS } from './quad.js';

// Engine sound, synthesised from the four motor speeds. Nothing is loaded: a
// quad's noise is almost entirely blade-pass tones over broadband rush, and
// both are cheaper to generate than to stream.
//
// The one thing that matters here is that each motor gets its own oscillators.
// The four speeds diverge the moment you touch a stick, and the beating between
// them is exactly what makes a quad sound like a quad rather than like a bee.
// Summing them into a single oscillator would throw away the only interesting
// part.
//
// No DOM, no Three.js, no Rapier: this file takes numbers, like quad.js.

const TWO_PI = Math.PI * 2;

// Blade-pass fundamental, in Hz, from a motor speed in rad/s. ~595 Hz at hover,
// ~1500 Hz at full throttle with the current quad.js constants.
const bladePass = (omega) => (omega / TWO_PI) * QUAD.bladeCount;

const AUDIO = {
	// Relative level of the fundamental and its first two harmonics. A lone
	// fundamental sounds like a synth test tone; the 2nd and 3rd are what make
	// it read as a machine.
	//
	// All three are sine waves, and that is the whole point: the fundamental
	// used to be a sawtooth, which already carries every harmonic up to Nyquist
	// at 1/n — so adding an explicit 2nd and 3rd on top doubled the series and
	// sprayed energy from 3 kHz to 20 kHz with nothing bounding it. Measured on
	// the master bus, 43% of the output sat in 2-4 kHz in a turn, which is the
	// peak of the ear's sensitivity curve and exactly what makes a sound
	// tiring over a session rather than merely loud. Sines give the spectrum
	// back to us: what is written here is what comes out.
	harmonics: [1.0, 0.4, 0.14],

	// Broadband hiss riding along with each motor's tones, band-passed around
	// its own blade-pass frequency so it tracks the motor instead of sitting
	// underneath as a static shhh.
	motorNoise: 0.3,
	motorNoiseQ: 1.6,

	// Per-motor lowpass. As the quad spools up the harmonics climb into the
	// harsh band, so a fixed corner is what keeps the absolute amount of energy
	// up there bounded no matter the throttle. It also has a physical excuse:
	// air absorption and the foam of a pair of goggles both roll off long
	// before this.
	motorTone: 2600,        // Hz
	motorToneQ: 0.5,        // no resonant peak at the corner, that would defeat it

	// Final safety net on the whole mix, above every branch.
	airCut: 6000,           // Hz
	airQ: 0.5,

	// Ceiling. The loudest thing the sim can produce — full throttle, full wind
	// rush, an impact on top — measures 0.83 at volume 1, so there is only
	// ~1.6 dB of headroom, and four detuned oscillators drifting against each
	// other will eventually line up in phase and eat it. Clipping at the
	// destination is the single most unpleasant thing a synth can do, so a
	// limiter sits above everything. It does nothing at all below the
	// threshold, which is where the sim normally lives.
	limitThreshold: -3,     // dB
	limitRatio: 20,
	limitAttack: 0.003,     // s
	limitRelease: 0.1,      // s

	// The brightness control multiplies both corners above. How dark is too
	// dark is the one thing no measurement here can settle — it depends on the
	// headphones and on the ear — so it is a slider rather than a constant.
	// 1.0 is what the spectral measurements above were taken at, so the range
	// is centred on it *geometrically* — sqrt(0.5 * 2.0) == 1 — otherwise the
	// middle of the slider quietly sits somewhere other than the tuning.
	brightnessRange: [0.5, 2.0],

	// Manufacturing spread, in cents. Four motors given the same command settle
	// at the *same* speed in this model, so their oscillators land on exactly
	// the same frequency and sum coherently into one pure loud tone. Real
	// motors and props never match to better than a fraction of a percent.
	// Detuning them turns that tone back into a chorus — the beating this is
	// all about is between near-identical frequencies, not identical ones.
	detune: [7, -5, 4, -8],

	// Slow wander on top, so a hover is not a dead-static drone. One LFO per
	// motor, at deliberately unrelated rates so they never lock into a pattern.
	wanderCents: 5,
	wanderHz: [0.23, 0.31, 0.19, 0.27],

	// How hard the pan is pushed. Not ±1: the pilot's ears are at the camera,
	// 8 cm from every motor, not out in the field listening to a flyby.
	pan: 0.5,

	// Per-motor gain never quite reaches zero while the prop turns — a spinning
	// motor whistles even when it is producing no useful thrust.
	idleLevel: 0.12,

	// Wind rush: band-passed noise whose centre and level climb with airspeed.
	windRef: 25,            // m/s at which the rush is at full level
	windLow: 220,           // Hz, band centre at a standstill
	windHigh: 900,          // Hz, band centre at windRef
	windLevel: 0.5,

	// Propwash is dirty low-frequency turbulence, not hiss: its own lowpassed
	// branch off the same noise source.
	propwashLevel: 0.45,
	propwashCut: 260,       // Hz

	// Smoothing time constants for setTargetAtTime. Frequency tracks fast (the
	// motors themselves have a 22 ms lag already modelled in quad.js) while
	// amplitude is a touch slower to keep frame-rate jitter from buzzing.
	tauFreq: 0.02,
	tauGain: 0.05,
	tauMaster: 0.08,

	impactRef: 1500,        // N, the crash threshold from main.js
	impactMinGap: 0.08,     // s between one-shots, so a slide is not a machine gun
	impactCut: 1400,        // Hz, a thump is not a hiss
};

// A couple of seconds of white noise, looped. One buffer feeds every noise
// branch — they differ only in their filters.
function makeNoiseBuffer(ctx, seconds) {
	const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
	return buf;
}

// A short noise burst with an exponential decay, for impacts.
function makeImpactBuffer(ctx, seconds) {
	const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) {
		const t = i / d.length;
		d[i] = (Math.random() * 2 - 1) * Math.exp(-6 * t);
	}
	return buf;
}

export class EngineAudio {
	constructor() {
		this.ctx = null;
		this.volume = 1;
		this.brightness = 0.5;     // 0..1 slider position, 0.5 == neutral
		this.muted = false;
		this.nodesCreated = 0;     // watched in the browser to prove nothing leaks
		this._masterTarget = 0;
		this._motors = [];
		this._lastImpactAt = -1;
	}

	get running() { return this.ctx !== null && this.ctx.state === 'running'; }

	// Must be called from a user gesture: browsers refuse to start an
	// AudioContext otherwise. Idempotent, and resumes a context the browser
	// suspended behind our back (tab switch, autoplay policy).
	start() {
		if (this.ctx) {
			if (this.ctx.state === 'suspended') this.ctx.resume();
			return;
		}
		const Ctx = window.AudioContext ?? window.webkitAudioContext;
		if (!Ctx) return;                       // no Web Audio: stay silent, don't throw
		const ctx = this.ctx = new Ctx();
		this._masterTarget = 0;
		this._build(ctx);
		if (ctx.state === 'suspended') ctx.resume();
	}

	// The whole graph, once. After this nothing is constructed per frame — only
	// AudioParams move — which is what keeps the GC out of the render loop.
	_build(ctx) {
		this.master = ctx.createGain();
		this.master.gain.value = 0;             // faded in on the first update

		// Everything leaves through here. Nothing in a real cockpit reaches the
		// pilot with its top octave intact, and a synthesis that does is the
		// one that gives you a headache.
		this.air = ctx.createBiquadFilter();
		this.air.type = 'lowpass';
		this.air.frequency.value = AUDIO.airCut;
		this.air.Q.value = AUDIO.airQ;

		this.limiter = ctx.createDynamicsCompressor();
		this.limiter.threshold.value = AUDIO.limitThreshold;
		this.limiter.knee.value = 0;
		this.limiter.ratio.value = AUDIO.limitRatio;
		this.limiter.attack.value = AUDIO.limitAttack;
		this.limiter.release.value = AUDIO.limitRelease;

		this.master.connect(this.air).connect(this.limiter).connect(ctx.destination);

		this.noiseBuffer = makeNoiseBuffer(ctx, 2);
		this.impactBuffer = makeImpactBuffer(ctx, 0.15);

		this.noise = ctx.createBufferSource();
		this.noise.buffer = this.noiseBuffer;
		this.noise.loop = true;

		for (let i = 0; i < MOTORS.length; i++) {
			const out = ctx.createGain();
			out.gain.value = 0;

			const pan = ctx.createStereoPanner();
			// Motor x is the body's right axis, so the sign alone places it.
			pan.pan.value = Math.sign(MOTORS[i].x) * AUDIO.pan;
			out.connect(pan).connect(this.master);

			// The tones go through their own lowpass; the noise band below is
			// already band-limited around the blade-pass frequency and does not
			// need it.
			const tone = ctx.createBiquadFilter();
			tone.type = 'lowpass';
			tone.frequency.value = AUDIO.motorTone;
			tone.Q.value = AUDIO.motorToneQ;
			tone.connect(out);

			// One wander LFO per motor, feeding every harmonic's detune so they
			// drift together and the harmonic ratios stay exact.
			const lfo = ctx.createOscillator();
			lfo.frequency.value = AUDIO.wanderHz[i];
			const lfoGain = ctx.createGain();
			lfoGain.gain.value = AUDIO.wanderCents;
			lfo.connect(lfoGain);
			lfo.start();

			const oscs = AUDIO.harmonics.map((level, h) => {
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.value = 1;
				osc.detune.value = AUDIO.detune[i];
				lfoGain.connect(osc.detune);
				const g = ctx.createGain();
				g.gain.value = level;
				osc.connect(g).connect(tone);
				osc.start();
				return osc;
			});

			const band = ctx.createBiquadFilter();
			band.type = 'bandpass';
			band.Q.value = AUDIO.motorNoiseQ;
			band.frequency.value = 1000;
			const bandGain = ctx.createGain();
			bandGain.gain.value = AUDIO.motorNoise;
			this.noise.connect(band).connect(bandGain).connect(out);

			this._motors.push({ out, oscs, band, pan, tone });
		}

		// Wind rush.
		this.windBand = ctx.createBiquadFilter();
		this.windBand.type = 'bandpass';
		this.windBand.Q.value = 0.7;
		this.windBand.frequency.value = AUDIO.windLow;
		this.windGain = ctx.createGain();
		this.windGain.gain.value = 0;
		this.noise.connect(this.windBand).connect(this.windGain).connect(this.master);

		// Propwash: the same noise, low-passed, which is what turbulent air off
		// your own props actually sounds like from inside it.
		this.washFilter = ctx.createBiquadFilter();
		this.washFilter.type = 'lowpass';
		this.washFilter.frequency.value = AUDIO.propwashCut;
		this.washGain = ctx.createGain();
		this.washGain.gain.value = 0;
		this.noise.connect(this.washFilter).connect(this.washGain).connect(this.master);

		// Impact one-shots land here so they bypass the per-motor panning.
		this.impactBus = ctx.createGain();
		this.impactBus.gain.value = 1;
		this.impactBus.connect(this.master);

		this.noise.start();
		this.nodesCreated++;                    // the looping noise source
		this.setBrightness(this.brightness);    // a value may have been set pre-start()
	}

	// Once per rendered frame — not per physics step. Reading the speeds at
	// frame rate and letting setTargetAtTime interpolate is both cheaper and
	// smoother than trying to push 250 Hz of updates through AudioParams.
	update({ omega, thrust, airspeed = 0, propwash = 0 }) {
		if (!this.ctx || !this.master) return;
		const t = this.ctx.currentTime;

		for (let i = 0; i < this._motors.length; i++) {
			const m = this._motors[i];
			const f = bladePass(omega[i]);

			for (let h = 0; h < m.oscs.length; h++) {
				m.oscs[h].frequency.setTargetAtTime(Math.max(f * (h + 1), 1), t, AUDIO.tauFreq);
			}
			m.band.frequency.setTargetAtTime(Math.max(f, 20), t, AUDIO.tauFreq);

			// Level follows thrust, not the motor command: a motor unloaded in a
			// dive is quieter than the same command in a climb, which is half of
			// why a punch-out sounds like one.
			const load = Math.min(thrust[i] / QUAD.maxThrustPerMotor, 1);
			const spinning = omega[i] > 1 ? AUDIO.idleLevel : 0;
			const level = Math.max(Math.pow(Math.max(load, 0), 0.6), spinning);
			m.out.gain.setTargetAtTime(level / MOTORS.length, t, AUDIO.tauGain);
		}

		const wind = Math.min(airspeed / AUDIO.windRef, 1);
		this.windBand.frequency.setTargetAtTime(
			AUDIO.windLow + (AUDIO.windHigh - AUDIO.windLow) * wind, t, AUDIO.tauGain);
		this.windGain.gain.setTargetAtTime(wind * wind * AUDIO.windLevel, t, AUDIO.tauGain);

		this.washGain.gain.setTargetAtTime(propwash * AUDIO.propwashLevel, t, AUDIO.tauGain);

		this._applyMaster();
	}

	// The only place a node is built after start(), and only on a contact —
	// never per frame. It disposes of itself when the burst finishes.
	playImpact(force) {
		if (!this.ctx || !this.impactBus || this.muted) return;
		const t = this.ctx.currentTime;
		if (t - this._lastImpactAt < AUDIO.impactMinGap) return;
		this._lastImpactAt = t;

		const src = this.ctx.createBufferSource();
		src.buffer = this.impactBuffer;

		const lp = this.ctx.createBiquadFilter();
		lp.type = 'lowpass';
		// A hard hit is brighter than a scrape.
		const hardness = Math.min(force / AUDIO.impactRef, 1);
		lp.frequency.value = AUDIO.impactCut * (0.4 + 0.6 * hardness);

		const g = this.ctx.createGain();
		// Contact force spans two orders of magnitude between a scrape and a
		// crash; a log law keeps the quiet end audible without deafening.
		g.gain.value = Math.min(Math.log10(1 + 9 * hardness), 1);

		src.connect(lp).connect(g).connect(this.impactBus);
		src.onended = () => { src.disconnect(); lp.disconnect(); g.disconnect(); };
		src.start();
		this.nodesCreated += 3;
	}

	// Slider position 0..1 to a multiplier on every lowpass corner. Log-spaced,
	// because pitch and brightness are both perceived that way: a linear sweep
	// would do nothing for half its travel and everything in the last quarter.
	setBrightness(b) {
		this.brightness = Math.min(Math.max(b, 0), 1);
		if (!this.ctx) return;
		const [lo, hi] = AUDIO.brightnessRange;
		const k = lo * Math.pow(hi / lo, this.brightness);
		const t = this.ctx.currentTime;
		this.air.frequency.setTargetAtTime(AUDIO.airCut * k, t, AUDIO.tauGain);
		for (const m of this._motors) {
			m.tone.frequency.setTargetAtTime(AUDIO.motorTone * k, t, AUDIO.tauGain);
		}
	}

	setVolume(v) {
		this.volume = Math.min(Math.max(v, 0), 1);
		this._applyMaster();
	}

	// Ramped rather than suspended: free camera is toggled often enough that a
	// hard cut would click every time.
	setMuted(muted) {
		this.muted = muted;
		this._applyMaster();
	}

	// Only schedules when the target actually moves. update() calls this every
	// frame so the master still comes up if the volume was set before start(),
	// and re-arming the same ramp 60 times a second would just pile up
	// automation events for nothing.
	_applyMaster() {
		if (!this.ctx || !this.master) return;
		const target = this.muted ? 0 : this.volume;
		if (target === this._masterTarget) return;
		this._masterTarget = target;
		this.master.gain.setTargetAtTime(target, this.ctx.currentTime, AUDIO.tauMaster);
	}

	dispose() {
		if (!this.ctx) return;
		this.ctx.close();
		this.ctx = null;
		this._motors = [];
	}
}
