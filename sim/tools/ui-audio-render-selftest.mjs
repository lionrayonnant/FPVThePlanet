// Selftest du rendu sonore d'interface (PHASE 18). Monté sur un faux
// AudioContext : ce qu'on vérifie ici est le GRAPHE et l'ORDONNANCEMENT, pas le
// timbre — le timbre se juge à l'oreille (issue #11).
// Lancer : node tools/ui-audio-render-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { UI_EVENTS, BOOT_SIGNATURE, INTRO_SCORE, INTRO_SCORE_MS, scoreFor } from './ui-audio-model.mjs';
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
	ui.setLinkQuality(0.5);
	ui.linkSilent();
	ui.armBoot();
	ui.playIntro();
	ui.skipIntro();
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

// --- culmination (#101) -------------------------------------------------------

t('playCulmination : un départ par événement de la partition, aux bons instants', () => {
	for (const family of HACK_TYPES) {
		for (const ms of [1000, 2000, 3000, 4000]) {
			const { ctx, ui } = fresh();
			ctx.currentTime = 5;
			ui.playCulmination(family, ms);
			const score = scoreFor(family, ms);
			const starts = audibleStarts(ctx);
			assert.equal(starts.length, score.length, `${family}/${ms}`);
			score.map((e) => 5 + e.atMs / 1000).sort((a, b) => a - b).forEach((want, i) => {
				assert.ok(Math.abs(starts[i] - want) < 1e-6, `${family}/${ms} événement ${i}`);
			});
		}
	}
});

t('playCulmination : tout est programmé d\'un coup, sur l\'horloge audio', () => {
	// Une culmination de 1 à 4 s doit rester juste même si une frame saute
	// pendant que la carte finit de charger : rien ne doit dépendre d'un timer.
	const { ctx, ui } = fresh();
	ui.playCulmination('NETWORK TAKEOVER', 4000);
	const starts = audibleStarts(ctx);
	assert.ok(Math.max(...starts) - Math.min(...starts) > 3.5,
		'la partition n\'est pas étalée sur toute la variante');
});

t('playCulmination : famille inconnue → silence, pas de plantage', () => {
	const { ctx, ui } = fresh();
	ui.playCulmination('PAS UNE FAMILLE', 2000);
	assert.equal(sources(ctx).length, 0);
});

t('playCulmination : sans Web Audio, silencieux et sans exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	assert.doesNotThrow(() => new UiAudio().playCulmination('LINK HIJACK', 2000));
});

// --- intro (issue #106) -------------------------------------------------------

t('playIntro : partition + résolution, programmées d\'un coup sur l\'horloge audio', () => {
	const { ctx, ui } = fresh();
	ctx.currentTime = 3;
	ui.playIntro();
	const starts = audibleStarts(ctx);
	assert.equal(starts.length, INTRO_SCORE.length + BOOT_SIGNATURE.length);
	// BOOT_SIGNATURE conclut au point de résolution : INTRO_SCORE_MS après le
	// départ de la partition, pas avant, pas dépendant d'un timer séparé.
	for (const note of BOOT_SIGNATURE) {
		const want = 3 + (INTRO_SCORE_MS + note.atMs) / 1000;
		assert.ok(starts.some((s) => Math.abs(s - want) < 1e-6),
			`note de résolution manquante à ${want}`);
	}
});

t('playIntro : sans Web Audio, silencieux et sans exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	const ui = new UiAudio();
	ui.playIntro();
	assert.equal(ui.nodesCreated, 0);
});

t('skipIntro : coupe le gain master de l\'intro et rejoue BOOT_SIGNATURE tout de suite', () => {
	const { ctx, ui } = fresh();
	ui.playIntro();
	ctx.currentTime = 1; // en pleine partition, bien avant la résolution naturelle
	ui.skipIntro();
	const master = ctx._nodes.find((node) => node.type === 'gain'
		&& node.gain.calls.some((c) => c[0] === 'linearRampToValueAtTime'));
	assert.ok(master, 'aucun gain rampé au skip');
	const ramp = master.gain.calls.at(-1);
	assert.equal(ramp[0], 'linearRampToValueAtTime');
	assert.ok(ramp[1] <= 0.001, 'le skip doit couper vers le silence, pas juste baisser');
	assert.ok(ramp[2] > 1 && ramp[2] < 1.2, 'la coupure doit être rapide, ancrée à ctx.currentTime');
	// Une signature de boot toute neuve part IMMÉDIATEMENT, à ctx.currentTime —
	// pas à l'instant de résolution déjà programmé plus tôt par playIntro().
	const starts = audibleStarts(ctx);
	for (const note of BOOT_SIGNATURE) {
		const want = 1 + note.atMs / 1000;
		assert.ok(starts.some((s) => Math.abs(s - want) < 1e-6), `note de boot manquante à ${want}`);
	}
});

t('skipIntro : sans intro en cours, joue quand même la signature de boot', () => {
	const { ctx, ui } = fresh();
	ui.skipIntro();
	assert.equal(audibleStarts(ctx).length, BOOT_SIGNATURE.length);
});

t('skipIntro : idempotent — un second appel (touche martelée, double clic) ne rejoue pas BOOT_SIGNATURE', () => {
	// Un skip est un geste qu'on martèle en pratique (clavier ou clic répété) :
	// un second appel avant que l'écran n'ait eu le temps de se démonter ne doit
	// PAS programmer une deuxième signature de boot par-dessus la première —
	// « une seule fois par chargement » (Bible §35) doit tenir même sous un
	// skip répété, pas seulement pour un skip unique. Compte les NŒUDS créés
	// plutôt que de faire correspondre des instants : à t=1s, INTRO_SCORE a
	// elle-même des notes programmées (grille de 125 ms) qui coïncideraient
	// avec un filtrage par horodatage et fausseraient le compte.
	const { ctx, ui } = fresh();
	ui.playIntro();
	ctx.currentTime = 1;
	ui.skipIntro();
	const nodesAfterFirstSkip = ctx._nodes.length;
	ctx.currentTime = 1.02; // quelques ms plus tard : la deuxième frappe du martelage
	ui.skipIntro();
	assert.equal(ctx._nodes.length, nodesAfterFirstSkip,
		'un second skip ne doit construire strictement aucun nœud — donc ne rien rejouer');
});

t('skipIntro : idempotent même sans playIntro préalable', () => {
	const { ctx, ui } = fresh();
	ui.skipIntro();
	ui.skipIntro();
	assert.equal(audibleStarts(ctx).length, BOOT_SIGNATURE.length);
});

t('playIntro : réarme le skip — une nouvelle intro peut être sautée à nouveau', () => {
	const { ctx, ui } = fresh();
	ui.playIntro();
	ui.skipIntro();
	ui.playIntro();
	const before = audibleStarts(ctx).length;
	ui.skipIntro();
	assert.equal(audibleStarts(ctx).length, before + BOOT_SIGNATURE.length,
		'un skip après un nouveau playIntro() doit rejouer BOOT_SIGNATURE');
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

console.log(`\n${n} tests OK`);
