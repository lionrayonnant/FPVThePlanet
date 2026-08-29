// Selftest de la machine de fin de vol (PHASE 14). Aucun DOM, aucun Rapier :
// des frames synthétiques, une horloge qu'on avance à la main.
// Lancer : node tools/flight-end-selftest.mjs
import assert from 'node:assert/strict';
import {
	FlightEnd, TIMELINE, LANDING,
	FLYING, LANDING_READY, LANDED, CRASHING, TERMINATED,
} from '../src/flight-end.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une frame de vol nominal : en l'air, armé, gaz au tiers.
const FLIGHT = { dt: 1 / 60, armed: true, height: 30, speed: 12, angularSpeed: 1, throttle: 0.35, crashed: false };
const frame = (over = {}) => ({ ...FLIGHT, ...over });

// Avance la machine de `seconds` en frames de 1/60, sans rien d'autre.
function advance(fe, seconds, over = {}) {
	const steps = Math.round(seconds * 60);
	for (let i = 0; i < steps; i++) fe.update(frame({ ...over, dt: 1 / 60 }));
}

t('au départ : en vol, rien à afficher, lien vivant', () => {
	const fe = new FlightEnd();
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.linkDead, false);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.out.closes, null);
});

t('impact : le lien meurt immédiatement, aucun texte encore', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, true);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
});

t('impact : la session se ferme sur CRASHED, une seule fois', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.closes, 'CRASHED');
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.closes, null);
	advance(fe, 6, { crashed: true });
	assert.equal(fe.out.closes, null);
});

t('séquence de crash : le noir avant le texte, puis les lignes dans l\'ordre', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));

	advance(fe, TIMELINE.blackoutAt - 0.1, { crashed: true });
	assert.equal(fe.out.blackout, 0, 'pas de noir avant blackoutAt');
	assert.deepEqual(fe.out.lines, [], 'pas de texte avant le noir');

	advance(fe, 0.1 + TIMELINE.blackoutFade + 0.05, { crashed: true });
	assert.equal(fe.out.blackout, 1, 'noir complet après le fondu');

	// Certaines lignes de TIMELINE.lines partagent un horodatage (une ligne
	// vide et le texte qui la suit, correction 6) : on ne peut donc plus
	// vérifier une entrée à la fois. On avance jusqu'à chaque instant distinct
	// et on compare à tout ce qui doit être visible à cet instant.
	const times = [...new Set(TIMELINE.lines.map(([at]) => at))].sort((a, b) => a - b);
	for (const at of times) {
		const fresh = new FlightEnd();
		fresh.update(frame({ crashed: true }));
		advance(fresh, at + 0.05, { crashed: true });
		const expected = TIMELINE.lines.filter(([lineAt]) => lineAt <= at + 0.05).map(([, text]) => text);
		assert.deepEqual(fresh.out.lines, expected, `à t=${at}s`);
	}
});

t('la sortie ne s\'arme qu\'à la fin de la séquence', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, TIMELINE.exitAt - 0.1, { crashed: true });
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.phase, CRASHING);
	advance(fe, 0.2, { crashed: true });
	assert.equal(fe.out.exitArmed, true);
	assert.equal(fe.phase, TERMINATED);
});

t('reset() ramène tout à l\'état de départ', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, 6, { crashed: true });
	fe.reset();
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.linkDead, false);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
});

t('out est le même objet à chaque frame', () => {
	const fe = new FlightEnd();
	const o = fe.out;
	fe.update(frame());
	assert.equal(fe.out, o);
});

// Une frame de drone posé : au contact, immobile, gaz coupés. Dérivée des
// seuils plutôt qu'écrite en dur — la Tâche 3 les remplace par des valeurs
// mesurées, et ces tests doivent suivre sans être réécrits.
const SETTLED = {
	dt: 1 / 60, armed: true, crashed: false,
	height: LANDING.H_ON * 0.5,
	speed: LANDING.V_ON * 0.1,
	angularSpeed: LANDING.W_ON * 0.1,
	throttle: 0,
};
const settled = (over = {}) => ({ ...SETTLED, ...over });

function hold(fe, seconds, over = {}) {
	const steps = Math.round(seconds * 60);
	for (let i = 0; i < steps; i++) fe.update(settled({ ...over, dt: 1 / 60 }));
}

t('pose : rien avant T_HOLD, LANDING DETECTED après', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD - 0.2);
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	hold(fe, 0.4);
	assert.equal(fe.phase, LANDING_READY);
	assert.deepEqual(fe.out.lines, ['LANDING DETECTED']);
});

t('vol rasant : sous la hauteur mais trop vite → jamais de détection', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { height: LANDING.H_ON * 0.5, speed: LANDING.V_ON + 5 });
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
});

t('gaz remis : la pose ne compte pas', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { throttle: 0.4 });
	assert.equal(fe.phase, FLYING);
});

t('sphère qui roule : la vitesse angulaire empêche la détection', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { angularSpeed: LANDING.W_ON + 1 });
	assert.equal(fe.phase, FLYING);
});

t('touchers successifs : le compteur repart de zéro à chaque rebond', () => {
	const fe = new FlightEnd();
	for (let i = 0; i < 6; i++) {
		hold(fe, LANDING.T_HOLD * 0.6);
		hold(fe, 0.2, { height: LANDING.H_OFF + 2, speed: 4 });
	}
	assert.equal(fe.phase, FLYING);
});

t('redécollage : LANDING_READY est perdu dès que le drone repart', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.phase, LANDING_READY);
	fe.update(settled({ height: LANDING.H_OFF + 1 }));
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
});

t('désarmement sur une pose : MOTORS DISARMED, END SESSION, LANDED une fois', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.disarm(), true);
	assert.equal(fe.out.phase, LANDED);
	assert.equal(fe.phase, LANDED);
	assert.deepEqual(fe.out.lines, ['LANDING DETECTED', 'MOTORS DISARMED', '', 'END SESSION']);
	// exitArmed ne s'arme qu'à la frame qui vidange réellement `closes`, pas au
	// moment du geste (correction 1, revue finale) : sinon Échap pourrait
	// sortir pendant que la fermeture de session est encore en vol.
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.out.closes, null);
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, 'LANDED');
	assert.equal(fe.out.exitArmed, true);
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, null);
	assert.equal(fe.out.exitArmed, true);
});

t('LANDED : update(dt=0) vidange closes sans avancer la machine (sim gelée)', () => {
	// Chemin réel du bug (correction 1) : se poser, puis geler la sim (caméra
	// libre / pause) avant qu'une frame non gelée n'ait lu `closes`. main.js
	// appelle désormais flightEnd.update() même gelé, avec dt=0.
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	fe.disarm();
	assert.equal(fe.out.closes, null, 'pas encore vidangé avant le premier update()');
	fe.update(settled({ dt: 0, armed: false }));
	assert.equal(fe.out.closes, 'LANDED');
	assert.equal(fe.out.exitArmed, true);
	assert.equal(fe.phase, LANDED);
	// Un second update(dt=0) ne rejoue pas la fermeture et n'avance rien.
	fe.update(settled({ dt: 0, armed: false }));
	assert.equal(fe.out.closes, null);
	assert.equal(fe.phase, LANDED);
});

t('désarmement en vol : rien ne se ferme, la chute suit son cours', () => {
	const fe = new FlightEnd();
	fe.update(frame());
	assert.equal(fe.disarm(), false);
	assert.equal(fe.phase, FLYING);
	fe.update(frame({ armed: false }));
	assert.equal(fe.out.closes, null);
	fe.update(frame({ armed: false, crashed: true }));
	assert.equal(fe.out.closes, 'CRASHED');
});

t('crash pendant LANDING_READY : le crash gagne', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.phase, LANDING_READY);
	fe.update(settled({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.closes, 'CRASHED');
	assert.deepEqual(fe.out.lines, []);
});

t('une carcasse immobile au sol n\'est pas un atterrissage', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	hold(fe, 3, { crashed: true });
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.disarm(), false);
});

console.log(`\n${n} tests OK`);
