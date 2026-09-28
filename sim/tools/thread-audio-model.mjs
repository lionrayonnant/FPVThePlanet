// The sound of the thread (issue #185 lot 4): what the trace follower's state
// sounds like. Pure — the targets only; src/thread-audio.js plays them.
//
// LINK family (Bible §34): the signal's own carrier, heard while the drone
// rides its path. Not an event, not music: a quiet bed that opens with the
// progress, drops to a whisper off the thread, decays when the thread cools,
// and a faint tick at the gate. Silent while frozen (pause, settings) or
// disarmed, and gone at the uplink — TARGET_FOUND takes over.

export const THREAD_AUDIO = {
	level: 0.05,          // on the thread; the link carrier peaks at 0.06
	heldLevel: 0.018,     // off it: a whisper (−9 dB) — the progress waits
	baseHz: 196,          // at the gate…
	topHz: 294,           // …a fourth up at the end
	cutLo: 500,           // lowpass at the gate (Hz)…
	cutHi: 2400,          // …open at the end
	heldCut: 320,         // off: muffled
	coolOctaves: 1,       // the cool-down slides the pitch down an octave
	tauOn: 0.15,          // swell in
	tauCut: 0.04,         // the short soft cut
	tauCool: 0.2,         // follows the 2 s fade, frame by frame
	tauStop: 0.03,        // pause, uplink, crash: gone at once, no click
	tick: { freq: 2600, durS: 0.03, level: 0.1 },
};

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

// Targets for one state. follower: the TraceFollower's out, or null (no
// trace, or it just ended). live: transmitting (not frozen, armed).
export function threadTargets(follower, live, out = {}) {
	const A = THREAD_AUDIO;
	const s = follower?.state;
	const p = clamp01(follower?.progress01 ?? 0);
	out.freq = A.baseHz * Math.pow(A.topHz / A.baseHz, p);
	out.cutoff = A.cutLo * Math.pow(A.cutHi / A.cutLo, p);
	if (!live || (s !== 'on' && s !== 'off')) {
		out.gain = 0; out.tau = A.tauStop;
	} else if (s === 'on') {
		out.gain = A.level; out.tau = A.tauOn;
	} else if (!(follower.fade01 > 0)) {
		out.gain = A.heldLevel; out.cutoff = A.heldCut; out.tau = A.tauCut;
	} else {
		const k = clamp01(follower.fade01);
		out.gain = A.heldLevel * (1 - k);
		out.freq *= Math.pow(2, -A.coolOctaves * k);
		out.cutoff = A.heldCut;
		out.tau = A.tauCool;
	}
	return out;
}

// Frame to frame: the targets, and the gate tick on the waiting → on edge
// (entering the gate, first time or after a reset; a resume from `off` is not
// a gate). Allocates nothing per update.
export class ThreadVoice {
	constructor() {
		this.out = { gain: 0, freq: THREAD_AUDIO.baseHz, cutoff: THREAD_AUDIO.cutLo, tau: THREAD_AUDIO.tauStop, tick: false };
		this._prev = null;
	}

	update(follower, live) {
		const o = this.out;
		const f0 = o.freq, c0 = o.cutoff;
		threadTargets(follower, live, o);
		// Going silent, the pitch and the filter stay put: a glide under the
		// fade-out would chirp (the uplink drops from the top of the rise).
		if (o.gain === 0 && o.tau === THREAD_AUDIO.tauStop) { o.freq = f0; o.cutoff = c0; }
		const s = follower?.state ?? null;
		o.tick = !!live && this._prev === 'waiting' && s === 'on';
		// Frozen, the state does not move: keep the edge for the thawed frame.
		if (live || s === null) this._prev = s;
		return o;
	}
}
