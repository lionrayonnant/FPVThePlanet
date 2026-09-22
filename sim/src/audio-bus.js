// The audio context and the limiter, shared by the engine synthesis
// (src/audio.js) and the interface sound language (src/ui-audio.js).
//
// Why a single context rather than one per module: the acceptance criterion of
// PHASE 18 is "the mix is balanced by ear, ritual included" (issue #11). Two
// separate contexts would add up blindly in the sound card, with no shared
// limiter and no level reference — and "the mix" would no longer name anything
// measurable.
//
//   motors/wind/propwash/impacts → master(mute) → air(6k) ─┐
//   SYSTEM / LINK ─────────────→ uiMaster(trim) ───────────┼→ limiter → volume → destination
//   MUSIC (issue #122) ──────────→ musicMaster(vol) ────────┘
//
// Four consequences, all intended:
//   - the UI does not go through `air`: that lowpass is the excuse "you hear the
//     drone through a pair of goggles", and an interface click must snap;
//   - the UI is not cut by audio.setMuted(frozen), which is true during the
//     WHOLE hack screen — a ritual left mute exactly when it should land would
//     be the silliest bug of the phase;
//   - neither is the music, for the same reason: the musical arc BEGINS on the
//     hack screen, which is frozen;
//   - everything is limited together: a real mix, not three outputs stepping on
//     each other.

// Taken as-is from src/audio.js, where they were measured: the loudest point of
// the sim (full throttle + rush + impact) leaves ~1.6 dB of headroom, and
// detuned oscillators eventually phase-align and eat it.
const LIMIT = { threshold: -3, ratio: 20, attack: 0.003, release: 0.1 };

// Trim of the interface chain. To be balanced by ear (issue #11): UI sounds are
// rare and must carry without crushing the motors.
const UI_TRIM = 0.5;

// Engine trim. Set by ear after the music trim was removed (issue #122): the
// music carried better, but the drone noise stayed the reference and still
// covered it a little — this trim lowers the engine instead of raising the
// music again, so as not to exceed the -14 LUFS calibration of the track
// library.
//
// Second listen (issue #110): still too high. -3 dB more, i.e. 0.55 / √2. Same
// reason to lower the engine rather than raise the music — tracks come in at
// -14 LUFS and the music slider already sits at its measured default (0.7), so
// the only clean degree of freedom is here.
//
// Third listen (issue #112): -3 dB had not been enough, the step is doubled.
// -6 dB, i.e. half of 0.39. The engine now comes out ~11 dB below its original
// level; if a fourth listen asks for more, the problem is no longer the balance
// but the engine spectrum, and it is src/audio.js to look at, not this trim.
const ENGINE_TRIM = 0.20;

// No music trim, unlike UI_TRIM. That is deliberate, and it is a correction:
// there was one at 0.7, multiplied by a slider whose default was also 0.7 — the
// music therefore came out at 0.49, attenuated twice for the same reason, and
// neither number meant "the balance".
//
// A single knob from now on, whose DEFAULT is the measured balance
// (settings.js loadMusicVolume). Tracks all come in at -14 LUFS
// (tools/music-loop.mjs), so this single setting holds for the whole library —
// that is what makes calibrating once enough.
//
// Removing the trim raises the music by +3.1 dB at an identical stored setting,
// which is exactly what the first in-flight listen asked for: "the music needs
// to come up a little against the drone noise" (issue #122).

const TAU = 0.08; // volume smoothing, like AUDIO.tauMaster

let ctx = null;
let engine = null;
let ui = null;
let music = null;
let volume = null;
let factory = null;

// The last settings asked for, whether or not a context existed to receive
// them. The panel is reachable from the terminal, BEFORE the first gesture that
// authorises an AudioContext: without this memory a slider moved there was
// written to localStorage, shown on screen, and applied to nothing until the
// next boot re-emitted it. The graph is built at its stored values instead.
let volumeTarget = 1;
let musicTarget = 1;

// Injection for the tests (tools/audio-bus-selftest.mjs). In production the
// default factory is the browser constructor.
export function _setContextFactory(fn) { factory = fn; }

export function _reset() {
	ctx = engine = ui = music = volume = null;
	factory = null;
	volumeTarget = musicTarget = 1;
}

function defaultFactory() {
	const Ctx = typeof window !== 'undefined'
		? (window.AudioContext ?? window.webkitAudioContext)
		: null;
	return Ctx ? new Ctx() : null;
}

// Must be called from a user gesture: browsers refuse to start an AudioContext
// otherwise. Idempotent, and picks up a context the browser suspended behind
// our back (tab change, autoplay).
export function ensureContext() {
	if (ctx) {
		resumeQuietly();
		return ctx;
	}
	ctx = (factory ?? defaultFactory)();
	if (!ctx) return null;              // no Web Audio: we stay mute, we do not throw

	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = LIMIT.threshold;
	limiter.knee.value = 0;
	limiter.ratio.value = LIMIT.ratio;
	limiter.attack.value = LIMIT.attack;
	limiter.release.value = LIMIT.release;

	volume = ctx.createGain();
	volume.gain.value = volumeTarget;

	engine = ctx.createGain();
	engine.gain.value = ENGINE_TRIM;
	ui = ctx.createGain();
	ui.gain.value = UI_TRIM;
	music = ctx.createGain();
	music.gain.value = musicTarget;

	engine.connect(limiter);
	ui.connect(limiter);
	music.connect(limiter);
	limiter.connect(volume).connect(ctx.destination);

	resumeQuietly();
	return ctx;
}

// resume() returns a promise, and the browser REJECTS it when asked outside a
// user gesture — which happens on every load, since armBoot() tries its luck
// before the first click. Without this catch, every start leaves an "unhandled
// rejection" in the console: noise that would mask a real error the day there
// is one.
function resumeQuietly() {
	if (!ctx || ctx.state !== 'suspended') return;
	try { ctx.resume()?.catch?.(() => {}); } catch { /* nothing to do, we stay mute */ }
}

export function context() { return ctx; }
export function engineIn() { return engine; }
export function uiIn() { return ui; }
export function musicIn() { return music; }

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Music volume alone, adjustable by the player (SETTINGS). Distinct from the
// master volume: flying stays an exercise in listening to the motor, and one
// must be able to turn the music down WITHOUT turning the machine down.
export function setMusicVolume(v) {
	musicTarget = clamp01(v);
	if (!music || !ctx) return;         // remembered above, applied by ensureContext
	music.gain.setTargetAtTime(musicTarget, ctx.currentTime, TAU);
	music.gain.value = musicTarget;     // the fake context does not interpolate; the real one ignores this
}

export function setVolume(v) {
	volumeTarget = clamp01(v);
	if (!volume || !ctx) return;        // remembered above, applied by ensureContext
	volume.gain.setTargetAtTime(volumeTarget, ctx.currentTime, TAU);
	volume.gain.value = volumeTarget;   // the fake context does not interpolate; the real one ignores this
}
