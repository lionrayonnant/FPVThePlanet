// Selftest of the thread's sound (issue #185 lot 4): the pure targets
// (tools/thread-audio-model.mjs), then the graph on a fake AudioContext
// (src/thread-audio.js) — built once, reaching the destination, silent when
// frozen, one tick per gate, nothing without a context.
// Run: node tools/thread-audio-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { threadTargets, ThreadVoice, THREAD_AUDIO as A } from './thread-audio-model.mjs';
import { ThreadAudio } from '../src/thread-audio.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const f = (state, progress01 = 0, fade01 = 0) => ({ state, progress01, fade01 });

t('targets: on the thread, audible, pitch and filter open with the progress', () => {
	const a = threadTargets(f('on', 0), true), b = threadTargets(f('on', 0.5), true), c = threadTargets(f('on', 1), true);
	assert.equal(a.gain, A.level);
	assert.equal(a.freq, A.baseHz);
	assert.ok(Math.abs(c.freq - A.topHz) < 1e-9 && Math.abs(c.cutoff - A.cutHi) < 1e-9);
	assert.ok(a.freq < b.freq && b.freq < c.freq && a.cutoff < b.cutoff && b.cutoff < c.cutoff);
	assert.ok(A.topHz / A.baseHz < 1.6, 'a slow rise, not a sweep');
});

t('targets: off, a whisper, muffled, cut fast; the cool-down decays and slides down', () => {
	const off = threadTargets(f('off', 0.4), true);
	assert.equal(off.gain, A.heldLevel);
	assert.ok(A.heldLevel < A.level / 2);
	assert.equal(off.cutoff, A.heldCut);
	assert.ok(off.tau < 0.1, 'a short cut');
	const on = threadTargets(f('on', 0.4), true);
	const half = threadTargets(f('off', 0.4, 0.5), true), end = threadTargets(f('off', 0.4, 1), true);
	assert.ok(half.gain < off.gain && half.gain > 0);
	assert.equal(end.gain, 0);
	assert.ok(half.freq < on.freq && end.freq < half.freq);
	assert.ok(Math.abs(end.freq - on.freq / 2) < 1e-9, 'an octave down at the reset');
});

t('targets: silent frozen, disarmed, waiting, done, or without a trace', () => {
	assert.equal(threadTargets(f('on', 0.5), false).gain, 0);
	for (const s of ['waiting', 'done']) assert.equal(threadTargets(f(s), true).gain, 0);
	assert.equal(threadTargets(null, true).gain, 0);
	assert.equal(threadTargets(null, true).tau, A.tauStop);
});

t('voice: one tick at the gate, none on a resume; frozen keeps the edge', () => {
	const v = new ThreadVoice();
	assert.equal(v.update(f('waiting'), true).tick, false);
	assert.equal(v.update(f('on'), true).tick, true);
	assert.equal(v.update(f('on'), true).tick, false);
	assert.equal(v.update(f('off'), true).tick, false);
	assert.equal(v.update(f('on'), true).tick, false, 'a resume is not a gate');
	v.update(f('waiting'), true);
	// Entered on a frame then frozen: no tick while frozen, the tick when it thaws.
	assert.equal(v.update(f('on'), false).tick, false);
	assert.equal(v.update(f('on'), true).tick, true);
	// After the trace is gone and a new one laid.
	v.update(null, false);
	v.update(f('waiting'), true);
	assert.equal(v.update(f('on'), true).tick, true);
	assert.equal(v.update(f('on'), true), v.out, 'reuses its output');
});

t('voice: going silent keeps the pitch and the filter (no chirp under the fade)', () => {
	const v = new ThreadVoice();
	v.update(f('waiting'), true);
	const top = { ...v.update(f('on', 0.99), true) };
	const gone = v.update(null, true);
	assert.equal(gone.gain, 0);
	assert.equal(gone.freq, top.freq);
	assert.equal(gone.cutoff, top.cutoff);
	// The cool-down, though, slides down on purpose.
	v.update(f('on', 0.5), true);
	assert.ok(v.update(f('off', 0.5, 0.5), true).freq < top.freq);
});

const fresh = (state = 'running') => {
	bus._reset();
	const ctx = fakeAudioContext({ state });
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return { ctx, a: new ThreadAudio() };
};
const started = (ctx) => ctx._nodes.filter((x) => x.started !== undefined && x.started !== null);

t('render: nothing built before the thread sounds; built once, reaching the destination', () => {
	const { ctx, a } = fresh();
	const before = ctx._nodes.length;
	a.update(f('waiting'), true);
	a.silence();
	assert.equal(ctx._nodes.length, before, 'waiting builds nothing');
	a.update(f('on', 0.1), true);
	const built = ctx._nodes.length;
	const srcs = started(ctx);
	assert.ok(srcs.length >= 3);
	for (const s of srcs.filter((x) => x.type !== 'bufferSource' || x.loop)) assert.ok(reaches(ctx, s.id, ctx.destination.id), `source ${s.id} silent`);
	assert.ok(reaches(ctx, a._g.out.id, bus.uiIn().id), 'through the interface bus (volume, limiter)');
	for (let i = 0; i < 300; i++) a.update(f(i % 2 ? 'on' : 'off', i / 300), true);
	// Only the gate tick may add nodes: none here (no waiting → on edge).
	assert.equal(ctx._nodes.length, built, 'no node per frame');
});

t('render: params move only when a target changes', () => {
	const { a } = fresh();
	a.update(f('on', 0.3), true);
	const calls = a._g.out.gain.calls.length, fcalls = a._g.a.frequency.calls.length;
	for (let i = 0; i < 100; i++) a.update(f('on', 0.3), true);
	assert.equal(a._g.out.gain.calls.length, calls);
	assert.equal(a._g.a.frequency.calls.length, fcalls);
	a.update(f('off', 0.3), true);
	assert.equal(a._g.out.gain.value, A.heldLevel);
	a.update(f('on', 0.3), false);
	assert.equal(a._g.out.gain.value, 0, 'frozen: silent');
});

t('render: out of silence the pitch jumps, then glides with the progress', () => {
	const { a } = fresh();
	a.update(f('waiting'), true);
	a.update(f('on', 0.9), true);
	a.update(null, true);
	a.update(f('waiting'), true);
	a.update(f('on', 0), true);
	const last = a._g.a.frequency.calls.at(-1);
	assert.deepEqual(last.slice(0, 2), ['setValueAtTime', A.baseHz], 'set, not glided from the old top');
	a.update(f('on', 0.2), true);
	assert.equal(a._g.a.frequency.calls.at(-1)[0], 'setTargetAtTime');
});

t('render: the gate tick is a one-shot that cleans up', () => {
	const { ctx, a } = fresh();
	a.update(f('waiting'), true);
	a.update(f('on'), true);
	const shots = started(ctx).filter((s) => s.type === 'bufferSource' && !s.loop);
	assert.equal(shots.length, 1);
	assert.ok(reaches(ctx, shots[0].id, ctx.destination.id));
	assert.ok(shots[0].stopped > shots[0].started);
	shots[0].onended();
	assert.ok(shots[0].disconnected);
});

t('render: no context, or a suspended one, never throws', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	const a = new ThreadAudio();
	a.update(f('waiting'), true); a.update(f('on', 0.5), true); a.silence();
	const { ctx, a: b } = fresh('suspended');
	ctx.resume = () => Promise.reject(new Error('no gesture'));
	b.update(f('waiting'), true); b.update(f('on', 0.5), true); b.silence();
	assert.equal(b._g.out.gain.value, 0);
});

console.log(`thread-audio: ${n} ok`);
