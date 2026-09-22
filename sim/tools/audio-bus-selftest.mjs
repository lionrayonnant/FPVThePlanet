// Selftest of the shared audio bus (PHASE 18). No browser: the graph is mounted
// on a fake AudioContext and checked by introspection.
// Run: node tools/audio-bus-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { EngineAudio } from '../src/audio.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const fresh = () => {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return ctx;
};

t('ensureContext: idempotent, a single context', () => {
	bus._reset();
	let built = 0;
	bus._setContextFactory(() => { built++; return fakeAudioContext(); });
	const a = bus.ensureContext();
	const b = bus.ensureContext();
	assert.equal(built, 1);
	assert.equal(a, b);
});

t('ensureContext: resumes a suspended context', () => {
	bus._reset();
	const ctx = fakeAudioContext({ state: 'suspended' });
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	assert.equal(ctx.state, 'running');
});

t('ensureContext: no Web Audio → null, no exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	assert.equal(bus.ensureContext(), null);
	assert.equal(bus.engineIn(), null);
	assert.equal(bus.uiIn(), null);
	bus.setVolume(0.5); // must not throw
});

t('both inputs reach the destination', () => {
	const ctx = fresh();
	assert.ok(reaches(ctx, bus.engineIn().id, ctx.destination.id), 'engine chain is mute');
	assert.ok(reaches(ctx, bus.uiIn().id, ctx.destination.id), 'UI chain is mute');
});

t('both inputs go through the SAME limiter', () => {
	// This is what makes the mix judgeable by ear, ritual included (#11).
	const ctx = fresh();
	const comps = ctx._nodes.filter((x) => x.type === 'compressor');
	assert.equal(comps.length, 1, `${comps.length} limiters`);
	assert.ok(reaches(ctx, bus.engineIn().id, comps[0].id));
	assert.ok(reaches(ctx, bus.uiIn().id, comps[0].id));
});

t('the volume is AFTER the limiter', () => {
	// The limiter threshold becomes independent of the slider position: "the
	// mix" finally names a single thing, whatever the listening volume.
	const ctx = fresh();
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	bus.setVolume(0.42);
	const vol = ctx._nodes.find((x) => x.type === 'gain' && Math.abs(x.gain.value - 0.42) < 1e-9);
	assert.ok(vol, 'no gain at 0.42');
	assert.ok(reaches(ctx, comp.id, vol.id), 'the volume is not downstream of the limiter');
	assert.ok(!reaches(ctx, vol.id, comp.id), 'the volume is upstream of the limiter');
});

t('setVolume: clamped to 0..1', () => {
	const ctx = fresh();
	bus.setVolume(5);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 1));
	bus.setVolume(-2);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 0));
});

t('a setting made BEFORE the context survives it', () => {
	// The regression: the panel is reachable from the terminal, before the
	// gesture that authorises an AudioContext. setVolume/setMusicVolume used to
	// return silently there, so the graph came up at 1 and the slider only took
	// effect at the next hack, which re-emitted it.
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.setVolume(0.3);
	bus.setMusicVolume(0.2);
	assert.equal(bus.context(), null, 'the context must not be built by a slider');
	bus.ensureContext();
	const vol = ctx._nodes.find((x) => x.type === 'gain' && Math.abs(x.gain.value - 0.3) < 1e-9);
	assert.ok(vol, 'the master volume came up at its default, the setting was lost');
	assert.ok(Math.abs(bus.musicIn().gain.value - 0.2) < 1e-9,
		'the music volume came up at its default, the setting was lost');
});

t('EngineAudio plugs into the bus and reaches the destination', () => {
	const ctx = fresh();
	const a = new EngineAudio();
	a.start();
	assert.ok(reaches(ctx, a.master.id, ctx.destination.id), 'the engine chain is mute');
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	assert.ok(reaches(ctx, a.master.id, comp.id), 'the engine chain dodges the limiter');
	// Mute cuts ONLY the engine, and the volume no longer rides on master.
	a.setMuted(true);
	assert.equal(a.master.gain.value, 0);
	a.setMuted(false);
	assert.equal(a.master.gain.value, 1);
});

t('the music goes through the limiter but not through the `air` lowpass', () => {
	const ctx = fresh();
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	const mus = bus.musicIn();
	assert.ok(mus, 'no music input');
	assert.ok(reaches(ctx, mus.id, comp.id), 'the music dodges the limiter');
	assert.ok(reaches(ctx, mus.id, ctx.destination.id), 'the music is mute');
	// `air` is the "you hear the drone through goggles" excuse; the music is not
	// in the world and must not go through it.
	const air = ctx._nodes.find((x) => x.type === 'biquad' && x.frequency && x.frequency.value < 8000);
	if (air) assert.ok(!reaches(ctx, mus.id, air.id), 'the music goes through the air lowpass');
});

t('setMusicVolume: the setting is applied AS IS, with no hidden trim', () => {
	// Regression: there was a MUSIC_TRIM at 0.7 multiplied by a slider whose
	// default was 0.7 too — the music came out at 0.49, attenuated twice for the
	// same reason. The balance lives in ONE number, the slider default
	// (settings.js loadMusicVolume); the bus must add nothing.
	fresh();
	for (const v of [0, 0.25, 0.7, 1]) {
		bus.setMusicVolume(v);
		assert.ok(Math.abs(bus.musicIn().gain.value - v) < 1e-9,
			`setMusicVolume(${v}) yields ${bus.musicIn().gain.value} — a trim slipped into the chain`);
	}
});

t('setMusicVolume: clamped to 0..1', () => {
	fresh();
	bus.setMusicVolume(5);
	assert.equal(bus.musicIn().gain.value, 1);
	bus.setMusicVolume(-2);
	assert.equal(bus.musicIn().gain.value, 0);
});

t('the music is not cut by the engine mute', () => {
	// The musical arc BEGINS on the hack screen, where audio.setMuted(frozen) is
	// true. Music cut there would be silent for the whole of its establishment.
	fresh();
	const a = new EngineAudio();
	a.start();
	bus.setMusicVolume(0.7);
	a.setMuted(true);
	assert.equal(a.master.gain.value, 0);
	assert.ok(Math.abs(bus.musicIn().gain.value - 0.7) < 1e-9, 'the engine mute took the music with it');
});

console.log(`\n${n} tests OK`);
