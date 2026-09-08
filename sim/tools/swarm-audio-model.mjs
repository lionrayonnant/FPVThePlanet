// The PURE model of the swarm's voice (issue #29), and of the `others` bus
// that holds it. No Web Audio here — src/swarm-audio.js is the graph, this is
// the arithmetic, and tools/swarm-audio-selftest.mjs runs it in Node.
//
// Why a choir and not twelve drones. Twelve near-identical sines phase-lock
// and produce exactly the synth-test tone docs/handoff-archive/son.md:84-90
// forbids — the same failure the four player motors had before the detune was
// added. So the swarm is two stages: THREE near voices, continuously
// reassigned to the three nearest units, plus ONE bed for everything else,
// statistically. What the ear localises gets a voice; the rest is a texture.
//
// THE BUDGET IS SHARED, NOT ADDED. Ambients (issue #250) and swarm both enter
// a single `others` bus with a fixed ceiling: their sum is bounded at
// OTHERS.headroomDb below the player's idleLevel — the bound #250 had given
// itself for four voices. A swarm of twelve therefore cannot, by
// construction, eat the 1.6 dB of limiter headroom son.md:92-98 measured. The
// price is that the ambients lose ~3 dB compared to when they had the whole
// budget to themselves; that is what "shared" means.
//
// Every relative level below is CHOSEN, not measured, like the rest of the
// sound (son.md:106-111). No agent can listen; what is guaranteed here is the
// structure, the frequencies and the ceiling, not the taste.
import { VOICE, gainFor, bladeFreq } from './ambient-audio-model.mjs';

// ------------------------------------------------------------ the `others` bus
//
// `idleLevel` is AUDIO.idleLevel (src/audio.js), repeated here so this file
// imports nothing from src/ — the selftest asserts the two still agree.
export const OTHERS = {
	idleLevel: 0.12,
	headroomDb: -12,
	// How the ceiling is split. Chosen: the ambients keep the larger share
	// because they are the sound of the sky and exist in every flight, the
	// swarm is an event and reads on its movement as much as on its level.
	ambientShare: 0.7,
	swarmShare: 0.3,
};

export const OTHERS_CAP = OTHERS.idleLevel * Math.pow(10, OTHERS.headroomDb / 20);

// The ambients' own worst case, as #250 defined it: four voices at d0. Their
// law keeps rising below d0, but d0 is the distance the bound was written
// against (tools/ambient-audio-selftest.mjs, "quatre voix à 8 m").
export const AMBIENT_VOICES = 4;
export const AMBIENT_WORST = AMBIENT_VOICES * gainFor(VOICE.d0);

// ---------------------------------------------------------------- the swarm
export const SWARM_AUDIO = {
	nearVoices: 3,
	bedOscs: 3,
	// The bed saturates here. SwarmModel caps a swarm at 12 (MAX_SIZE), but
	// the ceiling must hold for ANY size, so the law is clamped rather than
	// left to grow — a bound that depends on a constant living in another
	// module is not a bound.
	nMax: 12,

	// Near voices: the ambients' law with the ambients' shape, own level.
	g0: 0.015,
	d0: VOICE.d0, dMax: VOICE.dMax, fadeM: VOICE.fadeM,

	// The bed. sqrt() and not n: units that are not phase-locked sum in
	// POWER, and pretending otherwise is how a swarm of twelve would end up
	// four times louder than a swarm of three instead of twice.
	bedG0: 0.006,
	bedD0: 24,          // the bed is a distant texture; it fades more slowly
	// Narrow bandpass on the noise, centred on the MEAN blade frequency, then
	// two lowpasses. bedCenterMax is the guard the spec asks for: nothing —
	// fundamental or band — may reach into 2-4 kHz, the peak of the equal
	// loudness curve and the whole reason son.md exists.
	bedQ: 6,
	bedCenterMax: 1600,
	bedLowpass: 1600, bedLowpassQ: 0.707, bedLowpassStages: 2,
	// Share of the bed that is noise rather than the three sines. Chosen.
	bedNoise: 0.55,
	// Wide and almost static: the bed is the crowd, not a source. The mean
	// azimuth barely moves it, and it moves slowly.
	bedPanScale: 0.35, bedPanTau: 1.5,

	// Detune is MANDATORY (son.md:84-90), and the wander with it: the beat
	// wanted is between ALMOST identical frequencies, not identical ones.
	detuneCents: 9,
	wanderCents: 4,
	panTau: 0.06,
};

// Base detunes, in cents, none equal to another and none symmetric with
// another — three voices at ±c and 0 would beat in a pattern.
export const NEAR_DETUNE = [7, -5, 3];
export const BED_DETUNE = [-9, 2, 8];
// Wander rates, in Hz, deliberately unrelated (no small integer ratio between
// any two): rates that share a period re-lock the choir every period.
export const NEAR_WANDER_HZ = [0.061, 0.083, 0.107];
export const BED_WANDER_HZ = [0.047, 0.071, 0.097];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The near voices' gain: g0/(1 + d/d0), faded out at dMax like the ambients.
export function nearGain(d) {
	const S = SWARM_AUDIO;
	if (d >= S.dMax) return 0;
	const fade = clamp01((S.dMax - d) / S.fadeM);
	return S.g0 / (1 + d / S.d0) * fade;
}

// The bed's gain: how many units are NOT voiced, and how far they are on
// average. Bounded for any `n` by the nMax clamp.
export function bedGain(n, dMean) {
	const S = SWARM_AUDIO;
	const extra = Math.max(0, Math.min(n, S.nMax) - S.nearVoices);
	if (extra === 0 || dMean >= S.dMax) return 0;
	const fade = clamp01((S.dMax - dMean) / S.fadeM);
	return S.bedG0 * Math.sqrt(extra) / (1 + Math.max(0, dMean) / S.bedD0) * fade;
}

// What the swarm sends into the bus BEFORE the bus trim, worst case: three
// near voices right on top of the listener plus a full bed at zero distance.
//
// The convention is PEAK, not RMS, and every branch of the graph must respect
// it: one near voice peaks at nearGain (one sine), and the bed peaks at
// bedGain (its noise share plus its three sines, which is why the tone gain is
// divided by bedOscs in src/swarm-audio.js). Anything summing above its own
// gain would make this number a wish rather than a bound.
export const SWARM_WORST = SWARM_AUDIO.nearVoices * nearGain(0) + bedGain(SWARM_AUDIO.nMax, 0);

// The two fixed trims that make the ceiling structural. Each branch is scaled
// so that its own worst case is exactly its share of the cap; the sum of the
// two worst cases is then the cap itself, whatever the swarm's size and
// wherever the units are.
export const TRIM = {
	ambient: OTHERS.ambientShare * OTHERS_CAP / AMBIENT_WORST,
	swarm: OTHERS.swarmShare * OTHERS_CAP / SWARM_WORST,
};

// The linear sum the swarm actually produces this frame, before trim.
// `dNear` holds the distances of the voiced units, shortest first.
export function swarmSum(dNear, n, dMean) {
	let s = 0;
	for (let i = 0; i < dNear.length && i < SWARM_AUDIO.nearVoices; i++) s += nearGain(dNear[i]);
	return s + bedGain(n, dMean);
}

// ------------------------------------------------------------ the reassignment
//
// THE POINT OF RANKS. Voice `i` is driven by the i-th NEAREST unit, never by a
// fixed unit. When two units swap rank their distances are equal at the
// crossing, so the sorted sequence d[0] <= d[1] <= d[2] is continuous even
// though the identities behind it jump — and so is every parameter derived
// from it. Assigning a voice to a unit and re-picking would step the gain by
// the whole difference between the two units.
//
// `out` (Int32Array, length >= nearVoices) is filled with unit indices and
// returned; nothing is allocated. Partial selection, O(n · 3).
export function rankNearest(n, dists, out) {
	const k = Math.min(SWARM_AUDIO.nearVoices, n);
	for (let r = 0; r < out.length; r++) out[r] = -1;
	for (let r = 0; r < k; r++) {
		let best = -1, bestD = Infinity;
		for (let u = 0; u < n; u++) {
			let taken = false;
			for (let p = 0; p < r; p++) if (out[p] === u) { taken = true; break; }
			if (taken) continue;
			const d = dists[u];
			if (d < bestD) { bestD = d; best = u; }
		}
		out[r] = best;
	}
	return out;
}

// ------------------------------------------------------------------ frequencies
//
// The blade frequency of a swarm unit: 0.55 · maxOmega · bladeCount / 2π,
// ~1.1 kHz for SWARM_UNIT. The ambients' law, unchanged.
export function unitBladeFreq(profile, accelMag) { return bladeFreq(profile, accelMag); }

// Detune of voice `i` at time `t`, in cents: a fixed offset plus a slow
// wander. Both mandatory; the wander is what stops three fixed offsets from
// settling into one steady chord.
export function detuneAt(base, rateHz, phase, t) {
	return base + SWARM_AUDIO.wanderCents * Math.sin(2 * Math.PI * rateHz * t + phase);
}

export const centsToRatio = (c) => Math.pow(2, c / 1200);

// The bed's bandpass centre: the mean blade frequency, capped.
export function bedCenter(fMean) {
	return Math.min(Math.max(fMean, 20), SWARM_AUDIO.bedCenterMax);
}

// ---------------------------------------------------------- the bed's spectrum
//
// Magnitude of one RBJ biquad at `f`, the same formulas BiquadFilterNode uses
// (bandpass with constant 0 dB peak gain; lowpass with Q). This is what lets
// the selftest state "no bed energy in 2-4 kHz" as a number instead of as an
// intention.
function biquadMag(type, f0, Q, f, sampleRate) {
	const w0 = 2 * Math.PI * f0 / sampleRate;
	const alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
	const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
	let b0, b1, b2;
	if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha; }
	else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
	const w = 2 * Math.PI * f / sampleRate;
	const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
	const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
	const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
	return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

// Linear magnitude of the whole bed filter chain at `f`, for a bed centred on
// `fMean`. Bandpass, then bedLowpassStages lowpasses.
export function bedResponse(f, fMean, sampleRate = 48000) {
	const S = SWARM_AUDIO;
	let m = biquadMag('bandpass', bedCenter(fMean), S.bedQ, f, sampleRate);
	for (let i = 0; i < S.bedLowpassStages; i++) m *= biquadMag('lowpass', S.bedLowpass, S.bedLowpassQ, f, sampleRate);
	return m;
}
