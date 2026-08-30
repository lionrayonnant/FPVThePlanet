// Selftest du bus audio partagé (PHASE 18). Aucun navigateur : le graphe est
// monté sur un faux AudioContext et vérifié par introspection.
// Lancer : node tools/audio-bus-selftest.mjs
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

t('ensureContext : idempotent, un seul contexte', () => {
	bus._reset();
	let built = 0;
	bus._setContextFactory(() => { built++; return fakeAudioContext(); });
	const a = bus.ensureContext();
	const b = bus.ensureContext();
	assert.equal(built, 1);
	assert.equal(a, b);
});

t('ensureContext : reprend un contexte suspendu', () => {
	bus._reset();
	const ctx = fakeAudioContext({ state: 'suspended' });
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	assert.equal(ctx.state, 'running');
});

t('ensureContext : pas de Web Audio → null, aucune exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	assert.equal(bus.ensureContext(), null);
	assert.equal(bus.engineIn(), null);
	assert.equal(bus.uiIn(), null);
	bus.setVolume(0.5); // ne doit pas jeter
});

t('les deux entrées atteignent la destination', () => {
	const ctx = fresh();
	assert.ok(reaches(ctx, bus.engineIn().id, ctx.destination.id), 'chaîne moteur muette');
	assert.ok(reaches(ctx, bus.uiIn().id, ctx.destination.id), 'chaîne UI muette');
});

t('les deux entrées passent par le MÊME limiteur', () => {
	// C'est ce qui rend le mixage jugeable d'une oreille, rituel compris (#11).
	const ctx = fresh();
	const comps = ctx._nodes.filter((x) => x.type === 'compressor');
	assert.equal(comps.length, 1, `${comps.length} limiteurs`);
	assert.ok(reaches(ctx, bus.engineIn().id, comps[0].id));
	assert.ok(reaches(ctx, bus.uiIn().id, comps[0].id));
});

t('le volume est APRÈS le limiteur', () => {
	// Le seuil du limiteur devient indépendant de la position du slider : « le
	// mixage » désigne enfin une chose unique, quel que soit le volume d'écoute.
	const ctx = fresh();
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	bus.setVolume(0.42);
	const vol = ctx._nodes.find((x) => x.type === 'gain' && Math.abs(x.gain.value - 0.42) < 1e-9);
	assert.ok(vol, 'aucun gain à 0,42');
	assert.ok(reaches(ctx, comp.id, vol.id), 'le volume n\'est pas en aval du limiteur');
	assert.ok(!reaches(ctx, vol.id, comp.id), 'le volume est en amont du limiteur');
});

t('setVolume : borné à 0..1', () => {
	const ctx = fresh();
	bus.setVolume(5);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 1));
	bus.setVolume(-2);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 0));
});

t('EngineAudio se branche sur le bus et atteint la destination', () => {
	const ctx = fresh();
	const a = new EngineAudio();
	a.start();
	assert.ok(reaches(ctx, a.master.id, ctx.destination.id), 'la chaîne moteur est muette');
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	assert.ok(reaches(ctx, a.master.id, comp.id), 'la chaîne moteur évite le limiteur');
	// Le mute ne coupe QUE le moteur, et le volume n'est plus porté par master.
	a.setMuted(true);
	assert.equal(a.master.gain.value, 0);
	a.setMuted(false);
	assert.equal(a.master.gain.value, 1);
});

t('la musique passe par le limiteur mais pas par le lowpass `air`', () => {
	const ctx = fresh();
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	const mus = bus.musicIn();
	assert.ok(mus, 'pas d\'entrée musique');
	assert.ok(reaches(ctx, mus.id, comp.id), 'la musique évite le limiteur');
	assert.ok(reaches(ctx, mus.id, ctx.destination.id), 'la musique est muette');
	// `air` est l'excuse « on entend le drone à travers des lunettes » ; la
	// musique n'est pas dans le monde et ne doit pas le traverser.
	const air = ctx._nodes.find((x) => x.type === 'biquad' && x.frequency && x.frequency.value < 8000);
	if (air) assert.ok(!reaches(ctx, mus.id, air.id), 'la musique traverse le lowpass air');
});

t('setMusicVolume : le réglage est appliqué TEL QUEL, sans trim caché', () => {
	// Régression : il y a eu un MUSIC_TRIM à 0.7 multiplié par un slider dont le
	// défaut valait 0.7 aussi — la musique sortait à 0.49, atténuée deux fois
	// pour la même raison. La balance vit dans UN seul nombre, le défaut du
	// slider (settings.js loadMusicVolume) ; le bus ne doit rien ajouter.
	const ctx = fresh();
	for (const v of [0, 0.25, 0.7, 1]) {
		bus.setMusicVolume(v);
		assert.ok(Math.abs(bus.musicIn().gain.value - v) < 1e-9,
			`setMusicVolume(${v}) rend ${bus.musicIn().gain.value} — un trim s'est glissé dans la chaîne`);
	}
});

t('setMusicVolume : borné à 0..1', () => {
	fresh();
	bus.setMusicVolume(5);
	assert.equal(bus.musicIn().gain.value, 1);
	bus.setMusicVolume(-2);
	assert.equal(bus.musicIn().gain.value, 0);
});

t('la musique n\'est pas coupée par le mute moteur', () => {
	// L'arc musical COMMENCE sur l'écran de hack, où audio.setMuted(frozen) est
	// vrai. Une musique coupée là serait muette pendant tout son établissement.
	const ctx = fresh();
	const a = new EngineAudio();
	a.start();
	bus.setMusicVolume(0.7);
	a.setMuted(true);
	assert.equal(a.master.gain.value, 0);
	assert.ok(Math.abs(bus.musicIn().gain.value - 0.7) < 1e-9, 'le mute moteur a emporté la musique');
});

console.log(`\n${n} tests OK`);
