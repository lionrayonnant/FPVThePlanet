// node tools/calibration-preview-selftest.mjs — la pose de la machine pendant
// le calibrage (issue #281). Module PUR : aucun DOM, aucune horloge, donc ce
// que le pilote VOIT se vérifie sans navigateur, comme la mesure elle-même.
//
// Ce selftest ne lit aucun angle : les degrés appartiennent à la vue. Ici on
// vérifie des propriétés — pendant une consigne, SEUL le canal demandé bouge ;
// pendant « ne touche à rien », rien ne bouge ; le rejeu revient exactement à
// zéro ; et l'échelle s'adapte à la course de la radio du pilote.
import assert from 'node:assert/strict';
import { beginCalibration, feedSample, CAL_TIMING } from '../src/calibration.js';
import { calibrationPose, replayPose, completedChannels, REPLAY_MS } from '../src/calibration-preview.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const feed = (state, signals, ms, dt = 16) => {
	for (let e = 0; e < ms; e += dt) state = feedSample(state, signals, dt);
	return state;
};
const AXES = 4;
const zero = [0, 0, 0, 0];

// Un état arrêté sur la consigne `channel`, sur une radio à quatre axes centrés.
// On traverse les consignes précédentes en poussant l'axe prévu pour chacune.
const ORDER = [['throttle', 2], ['yaw', 3], ['pitch', 1], ['roll', 0]];
function upTo(channel, { course = 1 } = {}) {
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	for (const [ch, axis] of ORDER) {
		if (ch === channel) return s;
		const push = [...zero]; push[axis] = course;
		s = feed(s, push, CAL_TIMING.holdMs + 200);
		if (ch === 'throttle') {
			// Manche auto-centré : lâché, il revient — demi-course, pas de
			// consigne THROTTLE — FULL DOWN à traverser.
			s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
		} else {
			s = feed(s, zero, 200);
		}
	}
	return s;
}

const bouge = (pose) => Object.entries(pose).filter(([, v]) => Math.abs(v) > 1e-6).map(([k]) => k).sort();

t('HANDS OFF : la machine ne bouge pas, même si un signal est très écarté', () => {
	// C'est la consigne affichée. Une machine qui s'agite pendant « ne touche à
	// rien » dirait au pilote le contraire de ce qu'on lui demande.
	const s = beginCalibration(AXES);
	assert.equal(s.phase, 'rest');
	assert.deepEqual(bouge(calibrationPose({ state: s, signals: [0.9, 0, 0, 0] })), []);
});

t('pendant une consigne, SEUL le canal demandé bouge', () => {
	for (const [channel, axis] of [['yaw', 3], ['pitch', 1], ['roll', 0]]) {
		const s = upTo(channel);
		const push = [...zero]; push[axis] = 1;
		assert.deepEqual(bouge(calibrationPose({ state: s, signals: push })), [channel],
			`${channel} : un autre canal a bougé`);
	}
});

t('THROTTLE : la machine monte, et rien d\'autre ne bouge', () => {
	const s = upTo('throttle');
	assert.deepEqual(bouge(calibrationPose({ state: s, signals: [0, 0, 1, 0] })), ['throttle']);
	assert.equal(calibrationPose({ state: s, signals: zero }).throttle, 0);
});

t('un gaz INVERSÉ fait quand même monter la machine', () => {
	// Le geste demandé est « gaz en haut ». Si la radio rend un axe négatif, la
	// machine doit monter quand même : à ce stade, le sens n'est pas encore
	// mesuré, et une machine qui descend accuserait le pilote à tort.
	const s = upTo('throttle');
	assert.ok(calibrationPose({ state: s, signals: [0, 0, -1, 0] }).throttle > 0.9);
});

t('l\'échelle suit la course de CETTE radio, pas une course supposée', () => {
	// Une radio dont les endpoints ne sont pas réglés ne sort que 0.6. Le pilote
	// est pourtant à sa butée : la machine doit être à pleine inclinaison.
	const court = upTo('yaw', { course: 0.6 });
	const pose = calibrationPose({ state: court, signals: [0, 0, 0, 0.6] });
	assert.ok(pose.yaw > 0.95, `course réduite : lacet ${pose.yaw}`);
});

t('rien ne sort jamais des bornes', () => {
	const s = upTo('roll');
	for (const v of [-3, -1, 0, 1, 3]) {
		const pose = calibrationPose({ state: s, signals: [v, 0, 0, 0] });
		for (const [k, x] of Object.entries(pose)) {
			assert.ok(Number.isFinite(x), `${k} n'est pas fini`);
			assert.ok(x >= (k === 'throttle' ? 0 : -1) && x <= 1, `${k} = ${x}`);
		}
	}
});

t('le rejeu part de zéro, culmine, et revient EXACTEMENT à zéro', () => {
	// S'il ne revenait pas à zéro, la machine resterait de travers après la
	// confirmation et le pilote lirait une inclinaison qu'il n'a pas demandée.
	assert.deepEqual(bouge(replayPose('roll', 0)), []);
	assert.ok(replayPose('roll', REPLAY_MS / 2).roll > 0.9);
	assert.deepEqual(bouge(replayPose('roll', REPLAY_MS)), []);
	assert.deepEqual(bouge(replayPose('roll', REPLAY_MS * 3)), []);
});

t('un rejeu en cours prend la main sur les manches', () => {
	// Le pilote tient encore son manche quand la confirmation démarre : c'est le
	// geste REJOUÉ qu'il doit voir, pas le sien.
	const s = upTo('yaw');
	const pose = calibrationPose({ state: s, signals: [0, 0, 0, 1], replay: { channel: 'roll', elapsedMs: REPLAY_MS / 2 } });
	assert.deepEqual(bouge(pose), ['roll']);
});

t('CALIBRATED : les quatre manches pilotent la machine', () => {
	// Le banc d'essai, gratuit : une fois la mesure finie, la machine suit le
	// calibrage qu'on vient d'écrire.
	let s = upTo('roll');
	s = feed(s, [1, 0, 0, 0], CAL_TIMING.holdMs + 200);
	assert.equal(s.phase, 'done', 'le scénario doit aboutir');
	assert.ok(calibrationPose({ state: s, signals: [1, 0, 0, 0] }).roll > 0.9);
	assert.ok(calibrationPose({ state: s, signals: [0, 0, 1, 0] }).throttle > 0.9);
	assert.deepEqual(bouge(calibrationPose({ state: s, signals: zero })), []);
});

t('sans état, la pose est neutre plutôt qu\'une exception', () => {
	// Le panneau peint avant que l\'assistant ne démarre.
	assert.deepEqual(bouge(calibrationPose()), []);
	assert.deepEqual(bouge(calibrationPose({ state: null, signals: [1, 1, 1, 1] })), []);
});

t('un canal ne rejoue son geste qu\'une fois sa mesure TERMINÉE', () => {
	// Le gaz entre dans `channels` dès que son plafond est mesuré, mais il reste
	// en cours tant que son mode de course n'est pas décidé. Le rejouer à ce
	// moment ferait bouger la machine pendant qu'on demande au pilote de LÂCHER.
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	assert.deepEqual(completedChannels(s), []);

	s = feed(s, [0, 0, 1, 0], CAL_TIMING.holdMs + 200);
	assert.equal(s.phase, 'throttle-release');
	assert.ok(s.channels.throttle, 'le plafond est mesuré');
	assert.deepEqual(completedChannels(s), [], 'mais le gaz n\'est pas fini');

	s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
	assert.deepEqual(completedChannels(s), ['throttle'], 'le mode de course décidé : fini');

	s = feed(s, [0, 0, 0, 1], CAL_TIMING.holdMs + 200);
	assert.deepEqual(completedChannels(s), ['throttle', 'yaw']);
});

t('completedChannels ne jette pas sur un état vide', () => {
	assert.deepEqual(completedChannels(), []);
	assert.deepEqual(completedChannels(beginCalibration(AXES)), []);
});

console.log(`\ncalibration-preview: ${n} tests ok`);
