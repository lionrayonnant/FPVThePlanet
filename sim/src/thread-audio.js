// The sound of the thread (issue #185 lot 4), played from the pure targets of
// tools/thread-audio-model.mjs on the shared interface bus (src/audio-bus.js):
// the master volume and the limiter apply, the engine's `air` lowpass and its
// frozen mute do not — main.js passes `live` instead (frozen or disarmed:
// silent).
//
// Timbre: a triangle and a sine a few cents apart (a slow beat, the drift of an
// analog link), a breath of band-passed static, all through one lowpass that
// opens with the progress. Synthesised, nothing loaded.
//
// Built once per audio context, on the first sound: afterwards only AudioParams
// move, and only when a target changes. The gate tick is a one-shot that
// disconnects itself (the src/ui-audio.js idiom). No context yet (no gesture):
// nothing, no throw. A suspended context takes the params as they come.
import { context, uiIn } from './audio-bus.js';
import { ThreadVoice, THREAD_AUDIO } from '../tools/thread-audio-model.mjs';

const DETUNE_CENTS = 9;     // ~1 Hz beat at 196 Hz
const STATIC_LEVEL = 0.25;  // the static under the tone
const STATIC_Q = 2;

export class ThreadAudio {
	constructor() {
		this.voice = new ThreadVoice();
		this.nodesCreated = 0;
		this._ctx = null;
		this._g = null;          // { out, lp, a, b, band }
		this._noise = null;
		this._last = { gain: 0, freq: 0, cutoff: 0 };
	}

	// Once per frame. follower: the TraceFollower's out, or null. live: not
	// frozen, armed, in flight.
	update(follower, live) {
		const o = this.voice.update(follower, live);
		const ctx = context();
		if (!ctx) return;
		if (this._ctx !== ctx) { this._g = null; this._noise = null; this._ctx = ctx; this._last.gain = 0; }
		if (!this._g && o.gain === 0 && !o.tick) return;
		const g = this._g ?? this._build(ctx);
		const t = ctx.currentTime, L = this._last;
		// Out of silence, the pitch and the filter jump to their place before
		// the swell: no glide heard from wherever the last trace left them.
		const from0 = L.gain === 0 && o.gain > 0;
		const move = (param, v) => {
			if (from0) { param.cancelScheduledValues(t); param.setValueAtTime(v, t); } else param.setTargetAtTime(v, t, o.tau);
		};
		if (from0 || Math.abs(o.freq - L.freq) > L.freq * 0.002) {
			move(g.a.frequency, o.freq);
			move(g.b.frequency, o.freq);
			L.freq = o.freq;
		}
		if (from0 || Math.abs(o.cutoff - L.cutoff) > L.cutoff * 0.002) {
			move(g.lp.frequency, o.cutoff);
			move(g.band.frequency, o.cutoff * 0.8);
			L.cutoff = o.cutoff;
		}
		if (o.gain !== L.gain) { g.out.gain.setTargetAtTime(o.gain, t, o.tau); L.gain = o.gain; }
		if (o.tick) this._tick(ctx, t);
	}

	silence() { this.update(null, false); }

	_noiseBuffer(ctx) {
		if (!this._noise) {
			const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
			const d = buf.getChannelData(0);
			for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
			this._noise = buf;
		}
		return this._noise;
	}

	_build(ctx) {
		const A = THREAD_AUDIO;
		const out = ctx.createGain();
		out.gain.value = 0;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = A.cutLo;
		lp.Q.value = 0.7;
		lp.connect(out).connect(uiIn());
		const a = ctx.createOscillator();
		a.type = 'triangle';
		a.frequency.value = A.baseHz;
		const b = ctx.createOscillator();
		b.type = 'sine';
		b.frequency.value = A.baseHz;
		b.detune.value = DETUNE_CENTS;
		a.connect(lp);
		b.connect(lp);
		const src = ctx.createBufferSource();
		src.buffer = this._noiseBuffer(ctx);
		src.loop = true;
		const band = ctx.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = A.cutLo * 0.8;
		band.Q.value = STATIC_Q;
		const staticGain = ctx.createGain();
		staticGain.gain.value = STATIC_LEVEL;
		src.connect(band).connect(staticGain).connect(lp);
		a.start(); b.start(); src.start();
		this.nodesCreated += 7;
		this._g = { out, lp, a, b, band };
		this._last.gain = 0; this._last.freq = A.baseHz; this._last.cutoff = A.cutLo;
		return this._g;
	}

	// The gate: a faint click of static, 30 ms.
	_tick(ctx, t) {
		const { freq, durS, level } = THREAD_AUDIO.tick;
		const src = ctx.createBufferSource();
		src.buffer = this._noiseBuffer(ctx);
		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = freq;
		bp.Q.value = 3;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(level, t + 0.002);
		g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
		src.connect(bp).connect(g).connect(uiIn());
		src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
		src.start(t);
		src.stop(t + durS + 0.02);
		this.nodesCreated += 3;
	}
}
