// The swarm's voice (issue #29) — Web Audio only. The arithmetic, the levels
// and the ceiling all live in tools/swarm-audio-model.mjs; this file builds a
// graph ONCE in start() and, from then on, does nothing per frame but aim
// AudioParams. Sibling of src/ambient-audio.js, and built on it.
//
//   near i (x3)  osc(sine, f_blade, detune+wander) → gain(d) → lowpass(d, behind) → pan ─┐
//                                                                                        │
//   bed          noise → bandpass(f_mean, Q6) → lp → lp → noiseGain ┐                     ├→ out
//                3 x osc(sine, f_mean, detuned) → toneGain ─────────┴→ bedGain → bedPan ─┘
//
//   out → others.swarm (the shared ceiling, src/audio-others.js) ─┬→ engineIn()
//                                                                 └→ space.input
//
// 24 nodes, the same order as AmbientAudio (EngineAudio is ~60).
//
// Three voices and a bed rather than twelve voices: see the model's header.
// Twelve near-identical sines phase-lock into the synth-test tone
// docs/handoff-archive/son.md:84-90 forbids, and no amount of level tuning
// fixes that — it is a structural property of the signal.
//
// `destination` and `spaceInput` do not exist when SwarmDrones is built:
// ensureContext() needs a user gesture and the room acoustics are built at
// take-off. Same contract as AmbientAudio — pass them to start(), and
// update() catches a late space.input.
import {
	SWARM_AUDIO, NEAR_DETUNE, BED_DETUNE, NEAR_WANDER_HZ, BED_WANDER_HZ,
	nearGain, bedGain, bedCenter, detuneAt, centsToRatio, unitBladeFreq,
} from '../tools/swarm-audio-model.mjs';
import { VOICE, cutoffFor, dopplerFor } from '../tools/ambient-audio-model.mjs';
import { othersBus } from './audio-others.js';
import { AUDIO } from './audio.js';

function makeNoiseBuffer(ctx, seconds) {
	const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
	return buf;
}

export class SwarmAudio {
	constructor({ destination = null, spaceInput = null } = {}) {
		this._dest = destination;
		this._spaceIn = spaceInput;
		this._spaceConnected = false;
		this.ctx = null;
		this._near = [];
		this._bed = null;
		this._out = null;
		this._busIn = null;
		this._muted = false;
		this.nodesCreated = 0;
	}

	get running() { return this.ctx !== null; }

	// `destination` is engineIn(): the bus is inserted here, not by the
	// caller — every source that shares the `others` ceiling must go through
	// it and nothing else may reach engineIn() on this path.
	start(ctx, destination, spaceInput) {
		if (this.ctx) return;
		this._dest = destination ?? this._dest;
		this._spaceIn = spaceInput ?? this._spaceIn;
		if (!ctx || !this._dest) return;
		this.ctx = ctx;

		this._out = ctx.createGain();
		this._out.gain.value = 1;
		// The bus branch, kept: it is also what feeds the room acoustics, so
		// the wet carries the same trim as the dry (see _connectSpace).
		this._busIn = othersBus(ctx, this._dest).swarm;
		this._out.connect(this._busIn);
		this.nodesCreated++;

		this._noise = ctx.createBufferSource();
		this._noise.buffer = makeNoiseBuffer(ctx, 2);
		this._noise.loop = true;
		this._noise.start();
		this.nodesCreated++;

		for (let i = 0; i < SWARM_AUDIO.nearVoices; i++) {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = 1000;
			const gain = ctx.createGain(); gain.gain.value = 0;
			const low = ctx.createBiquadFilter();
			low.type = 'lowpass'; low.frequency.value = VOICE.cutNear; low.Q.value = 0.5;
			const pan = ctx.createStereoPanner();
			osc.connect(gain).connect(low).connect(pan).connect(this._out);
			osc.start();
			this.nodesCreated += 4;
			this._near.push({ osc, gain, low, pan, base: NEAR_DETUNE[i], rate: NEAR_WANDER_HZ[i], phase: i * 1.7 });
		}

		// The bed. The bandpass is narrow and the two lowpasses are the hard
		// guarantee: whatever the noise does, nothing above bedLowpass leaves
		// this branch, so nothing of the swarm ever lands in 2-4 kHz.
		const band = ctx.createBiquadFilter();
		band.type = 'bandpass'; band.frequency.value = 1100; band.Q.value = SWARM_AUDIO.bedQ;
		const lp1 = ctx.createBiquadFilter();
		lp1.type = 'lowpass'; lp1.frequency.value = SWARM_AUDIO.bedLowpass; lp1.Q.value = SWARM_AUDIO.bedLowpassQ;
		const lp2 = ctx.createBiquadFilter();
		lp2.type = 'lowpass'; lp2.frequency.value = SWARM_AUDIO.bedLowpass; lp2.Q.value = SWARM_AUDIO.bedLowpassQ;
		const noiseGain = ctx.createGain(); noiseGain.gain.value = SWARM_AUDIO.bedNoise;
		// Divided by the number of oscillators, not just by the tone share:
		// three sines CAN line up in phase, and the ceiling is only structural
		// if the worst case is the one that was budgeted. Noise + tone then
		// peak at bedGain, which is exactly what SWARM_WORST counts.
		const toneGain = ctx.createGain(); toneGain.gain.value = (1 - SWARM_AUDIO.bedNoise) / SWARM_AUDIO.bedOscs;
		const gain = ctx.createGain(); gain.gain.value = 0;
		const pan = ctx.createStereoPanner();
		this._noise.connect(band).connect(lp1).connect(lp2).connect(noiseGain).connect(gain);
		toneGain.connect(gain);
		gain.connect(pan).connect(this._out);
		this.nodesCreated += 7;
		const oscs = [];
		for (let i = 0; i < SWARM_AUDIO.bedOscs; i++) {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = 1100;
			osc.connect(toneGain);
			osc.start();
			this.nodesCreated++;
			oscs.push({ osc, base: BED_DETUNE[i], rate: BED_WANDER_HZ[i], phase: 0.9 + i * 2.3 });
		}
		this._bed = { band, lp1, lp2, noiseGain, toneGain, gain, pan, oscs };

		this._connectSpace(this._spaceIn);
	}

	// The send into the room acoustics (#122), branched ONCE, as soon as the
	// node exists — it can appear after start(), exactly like the ambients'.
	// Taken AFTER the bus trim and at the same gain as the dry path: the swarm
	// resonates in the courtyard it flies through, and its reverb return is
	// inside the shared ceiling instead of beside it.
	_connectSpace(node) {
		if (this._spaceConnected || !node || !this._busIn) return;
		this._busIn.connect(node);
		this._spaceIn = node;
		this._spaceConnected = true;
	}

	setMuted(m) { this._muted = !!m; }

	// Once per frame, `state` pre-allocated and owned by the caller:
	//   count      units alive
	//   nearCount  how many of the near voices are fed (0..3)
	//   near[i]    { d, behind, pan, vRadial, accelMag } for the i-th NEAREST
	//              unit — a RANK, never a unit id (see the model's header)
	//   dMean      mean distance of the units the bed stands for
	//   accelMean  mean |a| of those units, for the bed's centre frequency
	//   bedPan     the swarm's mean azimuth
	//   profile    the airframe (SWARM_UNIT)
	// `spaceInput` is re-read every frame, a property read, no allocation.
	update(state, now, spaceInput) {
		if (!this.ctx) return;
		if (!this._spaceConnected && spaceInput) this._connectSpace(spaceInput);
		const t = now ?? this.ctx.currentTime;
		const off = this._muted || !state || state.count <= 0;

		for (let i = 0; i < this._near.length; i++) {
			const v = this._near[i];
			const src = off || i >= state.nearCount ? null : state.near[i];
			if (!src) { v.gain.gain.setTargetAtTime(0, t, AUDIO.tauGain); continue; }
			const cents = detuneAt(v.base, v.rate, v.phase, t);
			// Doppler written by hand: f·c/(c + v_r), never the PannerNode's.
			const f = dopplerFor(unitBladeFreq(state.profile, src.accelMag), src.vRadial) * centsToRatio(cents);
			v.gain.gain.setTargetAtTime(nearGain(src.d), t, AUDIO.tauGain);
			v.low.frequency.setTargetAtTime(cutoffFor(src.d, src.behind), t, AUDIO.tauFreq);
			v.osc.frequency.setTargetAtTime(Math.max(f, 1), t, AUDIO.tauFreq);
			// tau = 60 ms on the pan is not cosmetic: a rank swap moves the
			// gain continuously (both units are at the same distance) but NOT
			// the azimuth, and this is what keeps that from clicking.
			v.pan.pan.setTargetAtTime(src.pan, t, SWARM_AUDIO.panTau);
		}

		const bed = this._bed;
		if (off) { bed.gain.gain.setTargetAtTime(0, t, AUDIO.tauGain); return; }
		const fMean = bedCenter(unitBladeFreq(state.profile, state.accelMean));
		bed.gain.gain.setTargetAtTime(bedGain(state.count, state.dMean), t, AUDIO.tauGain);
		bed.band.frequency.setTargetAtTime(fMean, t, AUDIO.tauFreq);
		for (let i = 0; i < bed.oscs.length; i++) {
			const o = bed.oscs[i];
			o.osc.frequency.setTargetAtTime(fMean * centsToRatio(detuneAt(o.base, o.rate, o.phase, t)), t, AUDIO.tauFreq);
		}
		// Wide and almost static: the bed is the crowd, not a source.
		bed.pan.pan.setTargetAtTime(state.bedPan * SWARM_AUDIO.bedPanScale, t, SWARM_AUDIO.bedPanTau);
	}

	silence() {
		if (!this.ctx) return;
		const t = this.ctx.currentTime;
		for (const v of this._near) v.gain.gain.setTargetAtTime(0, t, 0.05);
		this._bed.gain.gain.setTargetAtTime(0, t, 0.05);
	}

	dispose() {
		if (!this.ctx) return;
		try {
			for (const v of this._near) { v.osc.stop(); v.osc.disconnect(); v.gain.disconnect(); v.low.disconnect(); v.pan.disconnect(); }
			const b = this._bed;
			for (const o of b.oscs) { o.osc.stop(); o.osc.disconnect(); }
			b.band.disconnect(); b.lp1.disconnect(); b.lp2.disconnect();
			b.noiseGain.disconnect(); b.toneGain.disconnect(); b.gain.disconnect(); b.pan.disconnect();
			this._noise.stop(); this._noise.disconnect();
			this._out.disconnect();
		} catch { /* already torn down */ }
		this._near = []; this._bed = null; this._out = null; this._busIn = null;
		this.ctx = null; this._spaceConnected = false;
	}
}
