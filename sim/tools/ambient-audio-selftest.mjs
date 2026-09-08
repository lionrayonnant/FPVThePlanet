// node tools/ambient-audio-selftest.mjs — le modèle PUR des voix ambiantes
// (issue #250) et le graphe Web Audio sur un faux contexte. Ce qui s'écoute se
// vérifie à l'oreille, pas ici.
import { strict as assert } from 'node:assert';
import {
	VOICE, gainFor, cutoffFor, dopplerFor, bladeFreq, azimuthPan, voiceParams,
} from './ambient-audio-model.mjs';
import { AmbientAudio } from '../src/ambient-audio.js';
import { AUDIO } from '../src/audio.js';
import { PROFILES } from '../src/drone-profiles.js';

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('gain décroissant, nul à 250 m', () => {
	let prev = Infinity;
	for (let d = 0; d <= 260; d += 5) { const g = gainFor(d); assert.ok(g <= prev + 1e-12, `d=${d}`); prev = g; }
	assert.equal(gainFor(250), 0);
	assert.equal(gainFor(400), 0);
	assert.ok(gainFor(8) > 0);
});

test('quatre voix à 8 m ≤ −12 dB sous idleLevel', () => {
	const sum = 4 * gainFor(8);
	assert.ok(sum <= AUDIO.idleLevel * Math.pow(10, -12 / 20) + 1e-12, `${sum} vs ${AUDIO.idleLevel * Math.pow(10, -12 / 20)}`);
});

test('coupure décroissante en distance, plus basse dans le dos', () => {
	assert.ok(Math.abs(cutoffFor(0, 0) - VOICE.cutNear) < 1);
	assert.ok(Math.abs(cutoffFor(250, 0) - VOICE.cutFar) < 1);
	assert.ok(cutoffFor(100, 0) > cutoffFor(200, 0));
	assert.ok(cutoffFor(100, 1) < cutoffFor(100, 0));
	assert.ok(Math.abs(cutoffFor(100, 1) / cutoffFor(100, 0) - VOICE.behindCut) < 1e-9);
	// Rien ne remonte : la coupure ne dépasse jamais 2600.
	for (let d = 0; d < 250; d += 10) assert.ok(cutoffFor(d, 0) <= VOICE.cutNear + 1e-9);
});

test('Doppler ±40 m/s dans ±12 %, borné', () => {
	assert.equal(dopplerFor(100, 0), 100);
	assert.ok(dopplerFor(100, 40) < 100 && dopplerFor(100, 40) > 88);
	assert.ok(dopplerFor(100, -40) > 100 && dopplerFor(100, -40) < 114);
	assert.equal(dopplerFor(100, 400), dopplerFor(100, 40));
});

test('fréquence de pale : ω = 0,55·maxOmega, +15 % en virage, pales de la famille', () => {
	const f0 = bladeFreq(PROFILES.race5, 0);
	assert.ok(Math.abs(f0 - 0.55 * PROFILES.race5.maxOmega * PROFILES.race5.bladeCount / (2 * Math.PI)) < 1e-9);
	assert.ok(Math.abs(bladeFreq(PROFILES.race5, 100) / f0 - 1.15) < 1e-9);
	assert.ok(bladeFreq(PROFILES.toothpick, 0) !== bladeFreq(PROFILES.race5, 0));
});

test('azimut : droite → pan +, derrière → behind 1, continu au zénith', () => {
	const cam = { fx: 0, fz: -1, rx: 1, rz: 0 };   // regarde −Z, droite = +X
	assert.ok(azimuthPan(10, 0, cam).pan > 0.5);
	assert.ok(azimuthPan(-10, 0, cam).pan < -0.5);
	assert.ok(Math.abs(azimuthPan(0, -10, cam).pan) < 1e-9 && azimuthPan(0, -10, cam).behind === 0);
	assert.ok(azimuthPan(0, 10, cam).behind > 0.99);
	// Zénith : relX = relZ = 0 → pan 0, behind 0, pas de NaN.
	const z = azimuthPan(0, 0, cam);
	assert.equal(z.pan, 0); assert.equal(z.behind, 0);
	// `out` optionnel : muté et rendu, y compris sur le chemin du zénith —
	// l'appel par frame de src/ambient-drones.js n'alloue rien.
	const out = { pan: 9, behind: 9 };
	const r = azimuthPan(10, 0, cam, out);
	assert.equal(r, out);
	assert.ok(out.pan > 0.5 && out.behind === 0);
	assert.equal(azimuthPan(0, 0, cam, out), out);
	assert.equal(out.pan, 0); assert.equal(out.behind, 0);
});

test('voiceParams mute out sans allouer', () => {
	const out = { gain: 0, cutoff: 0, freq: 0, pan: 0 };
	const r = voiceParams({ d: 50, behind: 0.3, pan: 0.2, vRadial: 5, accelMag: 10, profile: PROFILES.cinewhoop, detune: 4 }, out);
	assert.equal(r, out);
	assert.ok(out.gain > 0 && out.cutoff > 0 && out.freq > 0);
	// Détune : 4 cents = ×2^(4/1200).
	const base = voiceParams({ d: 50, behind: 0.3, pan: 0.2, vRadial: 5, accelMag: 10, profile: PROFILES.cinewhoop, detune: 0 }, { gain: 0, cutoff: 0, freq: 0, pan: 0 });
	assert.ok(Math.abs(out.freq / base.freq - Math.pow(2, 4 / 1200)) < 1e-9);
});

// Les trois nœuds du bus `others` (src/audio-others.js, issue #29), bâtis une
// fois par contexte au premier branchement d'une voix.
const BUS_NODES = 3;

// ----------------------------------------------------------------- Web Audio
// Faux contexte : compte les nœuds, garde les AudioParams, ne joue rien.
function fakeContext() {
	let created = 0;
	const param = (v) => ({ value: v, setTargetAtTime(t) { this.value = t; }, setValueAtTime(t) { this.value = t; } });
	// `targets` : les nœuds vers lesquels celui-ci a été branché. connect()
	// rend sa CIBLE, comme la vraie Web Audio — sinon les chaînes
	// `a.connect(b).connect(c)` brancheraient tout sur `a`.
	const node = (extra = {}) => {
		created++;
		return { targets: [], connect(t) { this.targets.push(t); return t; }, disconnect() {}, start() {}, stop() {}, ...extra };
	};
	return {
		currentTime: 0, sampleRate: 48000, state: 'running',
		get created() { return created; },
		createGain: () => node({ gain: param(1) }),
		createOscillator: () => node({ type: 'sine', frequency: param(440), detune: param(0) }),
		createBiquadFilter: () => node({ type: 'lowpass', frequency: param(1000), Q: param(1) }),
		createStereoPanner: () => node({ pan: param(0) }),
		createBufferSource: () => node({ buffer: null, loop: false }),
		createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
		createDelay: () => node({ delayTime: param(0) }),
		createDynamicsCompressor: () => node({ threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0) }),
		destination: {},
	};
}

test('graphe : construit une fois, 6 nœuds par voix + bruit partagé, aucun nœud après', () => {
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const spaceIn = ctx.createGain();
	const a = new AmbientAudio({ destination: dest, spaceInput: spaceIn });
	a.start(ctx);
	const after = ctx.created;
	assert.ok(after >= 2 + 4 * 6 && after <= 2 + 4 * 6 + 3 + BUS_NODES, `${after} nœuds`);
	const voices = [
		{ d: 30, behind: 0, pan: 0.1, vRadial: 2, accelMag: 5, profile: PROFILES.race5 },
		null, null, null,
	];
	for (let i = 0; i < 300; i++) a.update(voices, i / 60);
	assert.equal(ctx.created, after, 'un nœud a été créé pendant update');
	a.silence();
	a.dispose();
	assert.equal(ctx.created, after);
});

test('graphe : sinus seulement, détunes distincts', () => {
	const ctx = fakeContext();
	const a = new AmbientAudio({ destination: ctx.createGain(), spaceInput: ctx.createGain() });
	a.start(ctx);
	assert.ok(a._voices.every((v) => v.osc.type === 'sine'));
	const det = a._voices.map((v) => v.detuneCents);
	assert.equal(new Set(det).size, 4);
	assert.ok(det.every((c) => Math.abs(c) <= VOICE.detuneCents));
});

test('voix nulle → gain 0 ; muted → gain 0 partout', () => {
	const ctx = fakeContext();
	const a = new AmbientAudio({ destination: ctx.createGain(), spaceInput: ctx.createGain() });
	a.start(ctx);
	a.update([{ d: 30, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: PROFILES.race5 }, null, null, null], 1);
	assert.ok(a._voices[0].gain.gain.value > 0);
	assert.equal(a._voices[1].gain.gain.value, 0);
	a.setMuted(true);
	a.update([{ d: 30, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: PROFILES.race5 }, null, null, null], 2);
	assert.equal(a._voices[0].gain.gain.value, 0);
});

test('start(ctx, dest2, space2) : override après construction sans destination', () => {
	const ctx = fakeContext();
	const dest2 = ctx.createGain();
	const space2 = ctx.createGain();
	const a = new AmbientAudio();
	a.start(ctx, dest2, space2);
	const after = ctx.created;
	assert.ok(after >= 2 + 4 * 6 && after <= 2 + 4 * 6 + 3 + BUS_NODES, `${after} nœuds`);
	assert.equal(a._dest, dest2);
	assert.equal(a._spaceIn, space2);
});

test('space : l\'envoi se branche même quand space.input arrive APRÈS start()', () => {
	// ensureContext() ouvre le contexte au premier son d'interface, donc
	// AmbientAudio démarre ; `space.input` n'est bâti qu'à EngineAudio.start().
	// Sans rattrapage, l'envoi vers l'acoustique du lieu était perdu pour toute
	// la session et les ambiants sonnaient à sec, hors du lieu.
	const ctx = fakeContext();
	const a = new AmbientAudio({ destination: ctx.createGain() });   // pas de spaceInput
	a.start(ctx);
	const spaceIn = ctx.createGain();
	assert.ok(a._voices.every((v) => !v.pan.targets.includes(spaceIn)), 'branché trop tôt');
	const nodesAfterStart = ctx.created;
	const silent = [null, null, null, null];
	a.update(silent, 0, spaceIn);
	const sends = () => a._voices.map((v) => v.pan.targets.filter((t) => t === spaceIn).length);
	assert.deepEqual(sends(), [1, 1, 1, 1], 'envoi non branché');
	// … et UNE seule fois, quoi qu'il arrive ensuite.
	for (let i = 1; i < 50; i++) a.update(silent, i / 60, spaceIn);
	assert.deepEqual(sends(), [1, 1, 1, 1], 'branché plusieurs fois');
	assert.equal(ctx.created, nodesAfterStart, 'un nœud a été créé pendant update');
	// Un spaceInput toujours absent ne casse rien.
	const b = new AmbientAudio({ destination: ctx.createGain() });
	b.start(ctx);
	b.update(silent, 0, null);
	assert.equal(b._spaceConnected, false);
});

test('space : fourni à start(), branché une fois et pas deux', () => {
	const ctx = fakeContext();
	const spaceIn = ctx.createGain();
	const a = new AmbientAudio({ destination: ctx.createGain(), spaceInput: spaceIn });
	a.start(ctx);
	assert.ok(a._voices.every((v) => v.pan.targets.filter((t) => t === spaceIn).length === 1));
	a.update([null, null, null, null], 0, spaceIn);
	assert.ok(a._voices.every((v) => v.pan.targets.filter((t) => t === spaceIn).length === 1));
});

console.log(`ambient-audio: ${passed} tests OK`);
