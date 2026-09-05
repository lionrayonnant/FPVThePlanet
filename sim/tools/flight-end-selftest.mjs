// Selftest de la machine de fin de vol (PHASE 14). Aucun DOM, aucun Rapier :
// des frames synthétiques, une horloge qu'on avance à la main.
// Lancer : node tools/flight-end-selftest.mjs
import assert from 'node:assert/strict';
import {
	FlightEnd, TIMELINE, LANDING_TIMELINE, FENCE_TIMELINE, CUT_TIMELINE, LANDING,
	CUT, FLYING, LANDING_READY, LANDED, CRASHING, TERMINATED,
} from '../src/flight-end.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une frame de vol nominal : en l'air, armé, gaz au tiers.
const FLIGHT = { dt: 1 / 60, armed: true, height: 30, speed: 12, angularSpeed: 1, throttle: 0.35, crashed: false, outOfZone: false };
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

t('désarmement sur une pose : LANDING DETECTED / MOTORS DISARMED tout de suite, LANDED une fois', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.disarm(), true);
	assert.equal(fe.out.phase, LANDED);
	assert.equal(fe.phase, LANDED);
	// À t=0, seules les deux premières lignes de LANDING_TIMELINE sont dues —
	// END SESSION et [ESC] DISCONNECT viennent plus tard (voir le test suivant).
	assert.deepEqual(fe.out.lines, ['LANDING DETECTED', 'MOTORS DISARMED']);
	// exitArmed ne s'arme qu'à la fin de la séquence de pose, pas au moment du
	// geste ni à la frame qui vidange `closes` (correction 2, revue finale) :
	// sinon Échap pourrait sortir pendant que la fermeture de session est
	// encore en vol, ou avant que le joueur ait vu l'écran de fin.
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.out.closes, null);
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, 'LANDED');
	assert.equal(fe.out.exitArmed, false, 'closes est parti, mais la séquence de pose n\'est pas finie');
});

t('séquence de pose : les lignes apparaissent dans l\'ordre, aux instants attendus', () => {
	// Même vérification que pour TIMELINE (le crash), sur LANDING_TIMELINE : des
	// lignes qui partagent un horodatage (une ligne vide et le texte qui la
	// suit) empêchent de tester une entrée à la fois.
	const times = [...new Set(LANDING_TIMELINE.lines.map(([at]) => at))].sort((a, b) => a - b);
	for (const at of times) {
		const fresh = new FlightEnd();
		hold(fresh, LANDING.T_HOLD + 0.3);
		fresh.disarm();
		advance(fresh, at + 0.05, { armed: false });
		const expected = LANDING_TIMELINE.lines.filter(([lineAt]) => lineAt <= at + 0.05).map(([, text]) => text);
		assert.deepEqual(fresh.out.lines, expected, `à t=${at}s`);
	}
});

t('pose : exitArmed n\'est vrai qu\'à la toute fin de la séquence, TERMINATED avec', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	fe.disarm();
	assert.equal(fe.out.exitArmed, false, 'juste après disarm()');
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, 'LANDED');
	assert.equal(fe.out.exitArmed, false, 'encore faux juste après la frame qui vide closes');
	advance(fe, LANDING_TIMELINE.exitAt - 0.1, { armed: false });
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.phase, LANDED);
	advance(fe, 0.2, { armed: false });
	assert.equal(fe.out.exitArmed, true);
	assert.equal(fe.phase, TERMINATED);
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
	// dt=0 : la séquence n'a pas avancé, donc la sortie ne s'arme pas non plus
	// (correction 2) — seul `closes` doit continuer d'être vidangé quoi qu'il
	// arrive.
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.phase, LANDED);
	// Un second update(dt=0) ne rejoue pas la fermeture et n'avance rien.
	fe.update(settled({ dt: 0, armed: false }));
	assert.equal(fe.out.closes, null);
	assert.equal(fe.phase, LANDED);
});

// Le geste en vol est REFUSÉ par le module, et depuis que main.js n'appelle
// controller.disarm() qu'après un disarm() vrai, ce refus est la seule chose qui
// se produit : plus de coupure moteur ni de chute. Ce qui suit reste le contrat
// du module — si l'appareil se retrouve désarmé par un autre chemin, rien ne se
// ferme tant qu'il n'y a pas d'impact.
t('désarmement en vol : refusé, et rien ne se ferme', () => {
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

// Troisième chronologie : la sortie de zone (#139). Même mécanique que le
// crash (this._activeTimeline change de table) : les tests ci-dessous se
// concentrent donc sur ce qui diffère — quelle table, et l'arbitrage quand
// les deux causes arrivent sur la même frame.
t('sortie de zone : CRASHING, image morte, verdict CRASHED', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, true);
	assert.equal(fe.out.closes, 'CRASHED');
});

t('sortie de zone : la table de la clôture, pas celle du crash', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	advance(fe, FENCE_TIMELINE.exitAt + 0.2, { outOfZone: true });
	assert.deepEqual(
		fe.out.lines,
		FENCE_TIMELINE.lines.map(([, text]) => text),
	);
	assert.equal(fe.out.exitArmed, true);
});

t('la clôture noircit plus tôt que le crash : pas d\'épave à regarder', () => {
	assert.ok(FENCE_TIMELINE.blackoutAt < TIMELINE.blackoutAt);
});

t('la première ligne de la clôture nomme la cause', () => {
	assert.equal(FENCE_TIMELINE.lines[0][1], 'OUT OF COVERAGE');
});

t('un crash pendant une sortie de zone ne rejoue pas la séquence', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	const first = fe.out.lines.length;
	fe.update(frame({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.ok(fe.out.lines.length >= first);
	assert.equal(fe.out.closes, null, 'closes ne se déclenche qu\'une fois');
});

// Quatrième chronologie : la coupure volontaire du lien (#216). Un drone
// coincé dans une façade n'atteint jamais LANDING_READY et ne crashe pas :
// sans ce geste, la session ne se ferme jamais et rien ne rend la main au
// terminal. Le maintien vit ici plutôt que dans main.js pour que ces tests
// puissent l'avancer à la main, comme tout le reste de ce banc.
t('maintien complet : le lien est coupé, image morte, verdict CRASHED', () => {
	const fe = new FlightEnd();
	// `closes` est un événement d'une frame : on le cueille au passage plutôt
	// que de le chercher à la fin, comme le fait main.js.
	let closes = null;
	for (let i = 0; i < Math.round((CUT.HOLD_S + 0.1) * 60); i++) {
		fe.update(frame({ cutHeld: true }));
		if (fe.out.closes) closes = fe.out.closes;
	}
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, true);
	assert.equal(closes, 'CRASHED');
});

t('maintien trop court : rien ne se passe, et le compteur repart de zéro', () => {
	const fe = new FlightEnd();
	advance(fe, CUT.HOLD_S * 0.75, { cutHeld: true });
	assert.equal(fe.phase, FLYING);
	fe.update(frame({ cutHeld: false }));
	assert.equal(fe.out.cutProgress, 0, 'relâcher remet le maintien à zéro');
	// Un second maintien de la même durée ne doit pas conclure : sans remise à
	// zéro, les deux moitiés s'additionneraient et couperaient le lien.
	advance(fe, CUT.HOLD_S * 0.75, { cutHeld: true });
	assert.equal(fe.phase, FLYING);
});

t('le maintien se voit avancer : cutProgress monte de 0 à 1', () => {
	const fe = new FlightEnd();
	assert.equal(fe.out.cutProgress, 0);
	advance(fe, CUT.HOLD_S / 2, { cutHeld: true });
	assert.ok(fe.out.cutProgress > 0.4 && fe.out.cutProgress < 0.6,
		`à mi-maintien on attend ~0,5, vu ${fe.out.cutProgress}`);
});

t('coupure : la table de la coupure, pas celle du crash', () => {
	const fe = new FlightEnd();
	advance(fe, CUT.HOLD_S + 0.1, { cutHeld: true });
	advance(fe, CUT_TIMELINE.exitAt + 0.2, { cutHeld: true });
	assert.deepEqual(
		fe.out.lines,
		CUT_TIMELINE.lines.map(([, text]) => text),
	);
	assert.equal(fe.out.exitArmed, true);
});

t('la coupure noircit plus tôt que le crash : pas d\'épave à regarder', () => {
	assert.ok(CUT_TIMELINE.blackoutAt < TIMELINE.blackoutAt);
});

t('la première ligne de la coupure nomme la cause', () => {
	assert.equal(CUT_TIMELINE.lines[0][1], 'SIGNAL CUT');
});

t('un crash pendant le maintien : le crash gagne', () => {
	const fe = new FlightEnd();
	advance(fe, CUT.HOLD_S * 0.5, { cutHeld: true });
	fe.update(frame({ cutHeld: true, crashed: true }));
	assert.equal(fe.phase, CRASHING);
	advance(fe, TIMELINE.exitAt + 0.2, { cutHeld: false, crashed: true });
	assert.deepEqual(fe.out.lines, TIMELINE.lines.map(([, text]) => text));
});

t('maintien après un crash : rien ne se rejoue', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.closes, 'CRASHED');
	advance(fe, CUT.HOLD_S + 1, { cutHeld: true, crashed: false });
	assert.equal(fe.out.closes, null, 'la session ne se ferme pas deux fois');
	assert.deepEqual(fe.out.lines, TIMELINE.lines.filter(([at]) => at <= CUT.HOLD_S + 1)
		.map(([, text]) => text));
});

t('maintien après une pose : la pose reste la pose', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.disarm(), true);
	advance(fe, CUT.HOLD_S + 0.1, { cutHeld: true });
	assert.notEqual(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, false, 'une pose ne tue pas l\'image');
	assert.equal(fe.out.cutProgress, 0, 'plus rien à couper');
});

t('sim gelée : un maintien n\'avance pas pendant la pause', () => {
	const fe = new FlightEnd();
	for (let i = 0; i < 600; i++) fe.update(frame({ dt: 0, cutHeld: true }));
	assert.equal(fe.phase, FLYING);
	assert.equal(fe.out.cutProgress, 0);
});

t('reset() oublie un maintien en cours', () => {
	const fe = new FlightEnd();
	advance(fe, CUT.HOLD_S * 0.9, { cutHeld: true });
	fe.reset();
	assert.equal(fe.out.cutProgress, 0);
	advance(fe, CUT.HOLD_S * 0.9, { cutHeld: true });
	assert.equal(fe.phase, FLYING);
});

// Le rappel « tu peux couper » : conditionnel, contrairement au geste. Un faux
// négatif ne bloque donc personne — il prive seulement d'un rappel.
t('coincé : armé et immobile assez longtemps sans pose reconnue', () => {
	const fe = new FlightEnd();
	assert.equal(fe.out.stuck, false);
	// Coincé dans une façade : haut (donc pas de pose possible), immobile, gaz mis.
	const wedged = { height: 18, speed: 0.05, angularSpeed: 0.01, throttle: 0.4 };
	advance(fe, CUT.STUCK_S + 0.2, wedged);
	assert.equal(fe.out.stuck, true);
});

t('coincé : un vol normal ne l\'est jamais', () => {
	const fe = new FlightEnd();
	advance(fe, CUT.STUCK_S + 5);
	assert.equal(fe.out.stuck, false);
});

t('coincé : un drone qui repart cesse de l\'être', () => {
	const fe = new FlightEnd();
	const wedged = { height: 18, speed: 0.05, angularSpeed: 0.01, throttle: 0.4 };
	advance(fe, CUT.STUCK_S + 0.2, wedged);
	assert.equal(fe.out.stuck, true);
	fe.update(frame());
	assert.equal(fe.out.stuck, false);
});

t('coincé : une pose reconnue n\'est pas un blocage', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + CUT.STUCK_S + 1);
	assert.equal(fe.phase, LANDING_READY);
	assert.equal(fe.out.stuck, false);
});

console.log(`\n${n} tests OK`);
