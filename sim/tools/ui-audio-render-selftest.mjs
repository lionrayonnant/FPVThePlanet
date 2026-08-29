// Selftest du rendu sonore d'interface (PHASE 18). Monté sur un faux
// AudioContext : ce qu'on vérifie ici est le GRAPHE et l'ORDONNANCEMENT, pas le
// timbre — le timbre se juge à l'oreille (issue #11).
// Lancer : node tools/ui-audio-render-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { UI_EVENTS, scoreFor, BOOT_SIGNATURE, RITUAL_TENSION } from './ui-audio-model.mjs';
import { HACK_TYPES } from './target-model.mjs';
import { UiAudio } from '../src/ui-audio.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const fresh = () => {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return { ctx, ui: new UiAudio() };
};

const sources = (ctx) => ctx._nodes.filter((x) => x.started !== undefined && x.started !== null);

// Une source qui ne rejoint pas la destination n'est pas forcément un bug : un
// modulateur en anneau alimente un AudioParam et n'a rien à faire dans le
// chemin audio. Ce qu'on refuse, c'est une source qui ne fait NI l'un NI
// l'autre — celle-là est un `connect` oublié, muet et invisible.
const feedsParam = (ctx, id) => ctx._conns.some(([a, b]) => a === id && typeof b === 'string');

// Les sources réellement dans le chemin audio : une par événement de partition.
// Un glitch en démarre deux (le bruit et son modulateur), et seul le bruit
// compte comme « un son joué ».
const audibleStarts = (ctx) => sources(ctx)
	.filter((s) => reaches(ctx, s.id, ctx.destination.id))
	.map((s) => s.started)
	.sort((a, b) => a - b);

t('play : les sept événements produisent du son et atteignent la destination', () => {
	for (const ev of UI_EVENTS) {
		const { ctx, ui } = fresh();
		ui.play(ev);
		const srcs = sources(ctx);
		assert.ok(srcs.length > 0, `${ev} : aucune source démarrée`);
		const audible = srcs.filter((s) => reaches(ctx, s.id, ctx.destination.id));
		assert.ok(audible.length > 0, `${ev} : rien n'atteint la destination`);
		for (const s of srcs) {
			assert.ok(reaches(ctx, s.id, ctx.destination.id) || feedsParam(ctx, s.id),
				`${ev} : source ${s.id} ni audible ni modulatrice — connect oublié`);
		}
	}
});

t('play : un nom hors du vocabulaire clos jette', () => {
	const { ui } = fresh();
	assert.throws(() => ui.play('BUTTON_CLICK'), /BUTTON_CLICK/);
	assert.throws(() => ui.play('HOVER'), /HOVER/);
});

t('play : sans Web Audio, silencieux et sans exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	const ui = new UiAudio();
	for (const ev of UI_EVENTS) ui.play(ev);
	ui.playRitual('LINK HIJACK', 2000);
	ui.setLinkQuality(0.5);
	ui.linkSilent();
	ui.ritualTension(0.5);
	ui.ritualTension(0);
	ui.killRitualTension();
	ui.armBoot();
});

t('BOOT : cinq notes, aux instants de BOOT_SIGNATURE', () => {
	const { ctx, ui } = fresh();
	ctx.currentTime = 10;
	ui.play('BOOT');
	const starts = audibleStarts(ctx);
	assert.equal(starts.length, BOOT_SIGNATURE.length);
	BOOT_SIGNATURE.forEach((note, i) => {
		assert.ok(Math.abs(starts[i] - (10 + note.atMs / 1000)) < 1e-6,
			`note ${i} : ${starts[i]} au lieu de ${10 + note.atMs / 1000}`);
	});
});

t('playRitual : un départ par événement de la partition, aux bons instants', () => {
	for (const family of HACK_TYPES) {
		for (const ms of [1000, 2000, 3000, 4000]) {
			const { ctx, ui } = fresh();
			ctx.currentTime = 5;
			ui.playRitual(family, ms);
			const score = scoreFor(family, ms);
			const starts = audibleStarts(ctx);
			assert.equal(starts.length, score.length, `${family}/${ms}`);
			score.map((e) => 5 + e.atMs / 1000).sort((a, b) => a - b).forEach((want, i) => {
				assert.ok(Math.abs(starts[i] - want) < 1e-6, `${family}/${ms} événement ${i}`);
			});
		}
	}
});

t('playRitual : tout est programmé d\'un coup, sur l\'horloge audio', () => {
	// Une culmination de 1 à 4 s doit rester juste même si une frame saute
	// pendant que la carte finit de charger : rien ne doit dépendre d'un timer.
	const { ctx, ui } = fresh();
	ui.playRitual('NETWORK TAKEOVER', 4000);
	const starts = audibleStarts(ctx);
	assert.ok(Math.max(...starts) - Math.min(...starts) > 3.5,
		'la partition n\'est pas étalée sur toute la variante');
});

t('playRitual : famille inconnue → silence, pas de plantage', () => {
	const { ctx, ui } = fresh();
	ui.playRitual('PAS UNE FAMILLE', 2000);
	assert.equal(sources(ctx).length, 0);
});

t('les one-shots se démontent : onended débranche tout', () => {
	const { ctx, ui } = fresh();
	// On ne regarde que les nœuds nés de CET appel : le bus a monté les siens
	// avant, et ils sont permanents.
	const before = ctx._nodes.length;
	ui.play('TARGET_FOUND');
	const created = ctx._nodes.slice(before);
	const srcs = created.filter((x) => x.started !== undefined && x.started !== null);
	assert.ok(srcs.length > 0, 'aucune source créée');
	for (const s of srcs) {
		assert.equal(typeof s.onended, 'function', 'source sans onended : ça fuit');
		s.onended();
	}
	for (const node of created) {
		assert.ok(node.disconnected, `nœud ${node.type} #${node.id} non débranché : ça fuit`);
	}
});

t('setLinkQuality : une seule branche permanente, aucun nœud par appel', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(0.9);
	const after1 = ctx._nodes.length;
	for (let i = 0; i < 600; i++) ui.setLinkQuality(0.5 + 0.4 * Math.sin(i / 20));
	assert.equal(ctx._nodes.length, after1, 'le carrier crée des nœuds par frame');
});

t('setLinkQuality : la porteuse atteint la destination et suit la qualité', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(1);
	const carrier = ctx._nodes.find((x) => x.type === 'gain' && x.gain.calls.length > 0);
	assert.ok(carrier, 'aucun gain automatisé pour la porteuse');
	assert.ok(reaches(ctx, carrier.id, ctx.destination.id));
	const before = carrier.gain.value;
	ui.setLinkQuality(0.05);
	assert.notEqual(carrier.gain.value, before, 'la porteuse ne suit pas la qualité');
});

t('linkSilent : coupe la porteuse sans démonter la branche', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(0.8);
	const count = ctx._nodes.length;
	ui.linkSilent();
	assert.equal(ctx._nodes.length, count);
});

t('armBoot : contexte vivant → la signature part tout de suite', () => {
	const { ctx, ui } = fresh();
	ui.armBoot();
	assert.equal(audibleStarts(ctx).length, BOOT_SIGNATURE.length);
});

// --- tension du rituel -------------------------------------------------------

t('ritualTension : k=0 avant toute frappe ne construit rien', () => {
	const { ctx, ui } = fresh();
	const baseline = ctx._nodes.length;
	ui.ritualTension(0);
	assert.equal(ctx._nodes.length, baseline, 'ritualTension(0) construit une branche pour rien');
});

t('ritualTension : une seule branche permanente, aucun nœud par appel ensuite', () => {
	const { ctx, ui } = fresh();
	ui.ritualTension(0.1);
	const after1 = ctx._nodes.length;
	for (let i = 0; i < 200; i++) ui.ritualTension(Math.abs(Math.sin(i / 10)));
	assert.equal(ctx._nodes.length, after1, 'la branche de tension crée des nœuds par appel');
});

t('ritualTension : la porteuse de tension atteint la destination', () => {
	const { ctx, ui } = fresh();
	ui.ritualTension(0.5);
	const gainNode = ctx._nodes.find((n) => n.type === 'gain'
		&& n.gain.calls.some((c) => c[0] === 'setTargetAtTime'));
	assert.ok(gainNode, 'aucun gain automatisé pour la tension');
	assert.ok(reaches(ctx, gainNode.id, ctx.destination.id));
});

t('ritualTension : monte avec k, puis retombe avec un lissage différent sur mismatch', () => {
	const { ctx, ui } = fresh();
	ui.ritualTension(1);
	const gainNode = ctx._nodes.find((n) => n.type === 'gain'
		&& n.gain.calls.some((c) => c[0] === 'setTargetAtTime'));
	const riseCall = gainNode.gain.calls.at(-1);
	assert.equal(riseCall[0], 'setTargetAtTime');
	assert.equal(riseCall[3], RITUAL_TENSION.tau, 'la montée doit utiliser tau');
	ui.ritualTension(0);
	const fallCall = gainNode.gain.calls.at(-1);
	assert.equal(fallCall[3], RITUAL_TENSION.fallTau, 'la chute doit utiliser fallTau');
	assert.notEqual(riseCall[3], fallCall[3], 'montée et chute doivent différer');
});

t('killRitualTension : coupe la branche, rien ne fuit', () => {
	const { ctx, ui } = fresh();
	ui.ritualTension(0.6);
	const srcs = ctx._nodes.filter((n) => n.started !== undefined && n.started !== null);
	assert.ok(srcs.length > 0, 'aucune source créée par ritualTension');
	ui.killRitualTension();
	assert.ok(srcs.every((s) => s.stopped !== null), 'une source de la tension tourne encore');
	assert.ok(srcs.every((s) => s.disconnected), 'une source de la tension n\'a pas été débranchée');
});

t('killRitualTension : un rituel abandonné ne reconstruit rien tant qu\'aucune flèche n\'a été tapée', () => {
	const { ctx, ui } = fresh();
	ui.ritualTension(0.4);
	ui.killRitualTension();
	const after = ctx._nodes.length;
	ui.ritualTension(0); // simule un teardown qui rappelle par prudence
	assert.equal(ctx._nodes.length, after, 'ritualTension(0) reconstruit après killRitualTension');
});

t('killRitualTension : sans effet si la tension n\'a jamais été construite', () => {
	const { ui } = fresh();
	ui.killRitualTension(); // ne doit pas jeter
});

// --- explosion en couches stéréo ---------------------------------------------

t('playRitual : chaque shrapnel panoramisé crée un StereoPannerNode réglé sur son pan', () => {
	const { ctx, ui } = fresh();
	const family = 'COMMAND INJECTION';
	ui.playRitual(family, 3000);
	const score = scoreFor(family, 3000).filter((e) => typeof e.pan === 'number');
	const panners = ctx._nodes.filter((n) => n.type === 'panner');
	assert.equal(panners.length, score.length, 'pas un panner par événement panoramisé');
	const pans = panners.map((p) => p.pan.value).sort((a, b) => a - b);
	const want = score.map((e) => e.pan).sort((a, b) => a - b);
	assert.deepEqual(pans, want, 'les valeurs de pan ne correspondent pas à la partition');
	for (const p of panners) {
		assert.ok(reaches(ctx, p.id, ctx.destination.id), 'un shrapnel panoramisé n\'atteint pas la destination');
	}
});

t('playRitual : le souffle (blast) atteint la destination pour les six familles', () => {
	for (const family of Object.keys({
		'COMMAND INJECTION': 0, 'LINK HIJACK': 0, 'TELEMETRY SPOOF': 0,
		'GNSS SPOOF': 0, 'NETWORK TAKEOVER': 0, 'FIRMWARE OVERRIDE': 0,
	})) {
		const { ctx, ui } = fresh();
		ui.playRitual(family, 2000);
		const blastAt = scoreFor(family, 2000).find((e) => e.voice === 'blast').atMs / 1000;
		const blastSrc = sources(ctx).find((s) => Math.abs(s.started - blastAt) < 1e-6);
		assert.ok(blastSrc, `${family} : aucune source de blast à l'instant attendu`);
		assert.ok(reaches(ctx, blastSrc.id, ctx.destination.id), `${family} : le blast n'atteint pas la destination`);
	}
});

console.log(`\n${n} tests OK`);
