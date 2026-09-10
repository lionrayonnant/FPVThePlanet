// Selftest de la machine de fin de vol (PHASE 14). Aucun DOM, aucun Rapier :
// des frames synthétiques, une horloge qu'on avance à la main.
// Lancer : node tools/flight-end-selftest.mjs
import assert from 'node:assert/strict';
import {
	FlightEnd, TIMELINE, FENCE_TIMELINE, CUT_TIMELINE,
	CUT, FLYING, CRASHING, TERMINATED, PORTRAIT_LINE, RANDOMART_LINE,
} from '../src/flight-end.js';
// Namespace import: the removal of landing (D9, 2026-09-08) is asserted on the
// module's surface itself, and a named import of a gone export would not even
// parse.
import * as mod from '../src/flight-end.js';

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

t('le portrait arrive après SESSION TERMINATED et avant la sortie', () => {
	// #264 : le jeton que src/fpvtp-osd.js remplace par le dessin de la machine
	// perdue. Sa PLACE est le sujet — après le constat, avant qu'on rende la
	// main : ce qu'il reste, pas une récompense.
	const at = (txt) => TIMELINE.lines.find(([, s]) => s === txt)?.[0];
	assert.ok(at('[PORTRAIT]') > at('SESSION TERMINATED'), 'le portrait précède la fin');
	assert.ok(at('[PORTRAIT]') <= TIMELINE.exitAt, 'le portrait arrive après la sortie');
	assert.equal(TIMELINE.exitAt, 4.6, 'la sortie a bougé : la timeline n\'est plus celle de la spec');
});

t('chaque table de fin porte exactement un portrait', () => {
	// D12 : le portrait n'était sur la table du crash. Une sortie de zone ou un
	// lien coupé perdaient la machine sans jamais la montrer.
	for (const [name, table] of [['TIMELINE', TIMELINE], ['FENCE_TIMELINE', FENCE_TIMELINE], ['CUT_TIMELINE', CUT_TIMELINE]]) {
		const found = table.lines.filter(([, s]) => s === PORTRAIT_LINE);
		assert.equal(found.length, 1, `${name} porte ${found.length} portraits`);
		// Même place que sur la table du crash : 0,4 s après le constat, et
		// avant que la sortie s'arme. Le noir est monté, le texte est écrit, la
		// machine apparaît dessus.
		const terminated = table.lines.find(([, s]) => s === 'SESSION TERMINATED')[0];
		assert.equal(found[0][0], terminated + 0.4, `${name} : le portrait n'est pas 0,4 s après SESSION TERMINATED`);
		assert.ok(found[0][0] < table.exitAt, `${name} : le portrait arrive après la sortie`);
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

// Une frame de drone au sol, gaz au ralenti : ce que le code appelait « une
// pose » avant que l'atterrissage disparaisse (D9, 2026-09-08). Il n'y a plus
// de verdict pour cet état — seulement le rappel qui dit comment en sortir.
const GROUNDED = {
	dt: 1 / 60, armed: true, crashed: false,
	height: 0.1, speed: 0.01, angularSpeed: 0.01, throttle: 0,
};

function hold(fe, seconds, over = {}) {
	const steps = Math.round(seconds * 60);
	for (let i = 0; i < steps; i++) fe.update({ ...GROUNDED, ...over, dt: 1 / 60 });
}

// Le contrat qui remplace l'atterrissage : le module ne connaît plus que le
// vol, l'agonie et la fin. Un vol se termine par un crash, une sortie de zone
// ou une coupure volontaire — jamais par une pose.
t('plus aucune pose dans la surface du module', () => {
	assert.equal(typeof mod.LANDED, 'undefined');
	assert.equal(typeof mod.LANDING_READY, 'undefined');
	assert.equal(typeof mod.LANDING, 'undefined');
	assert.equal(typeof mod.LANDING_TIMELINE, 'undefined');
	assert.equal(typeof new FlightEnd().disarm, 'undefined');
});

t('un drone au sol gaz coupés reste en vol : plus de verdict pour ça', () => {
	const fe = new FlightEnd();
	hold(fe, 5);
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.closes, null);
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

t('#71: every end screen names ENTER, never ESC', () => {
	// Measured, not preferred: pointer lock and browser fullscreen confiscate
	// Escape and deliver no keydown, so the one screen whose only purpose is to
	// be left must name the key that always arrives. Escape stays wired in
	// main.js as a silent duplicate; it is just not what the line promises.
	for (const tl of [TIMELINE, FENCE_TIMELINE, CUT_TIMELINE]) {
		const lines = tl.lines.map(([, text]) => text);
		assert.ok(lines.includes('[ENTER] DISCONNECT'), 'the disconnect line names ENTER');
		assert.ok(lines.includes('[R] REDEPLOY'), 'and REDEPLOY sits next to it');
		assert.ok(!lines.some((l) => l.includes('[ESC]')), 'no line names ESC');
	}
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
// coincé dans une façade — ou simplement posé au sol — ne crashe pas : sans ce
// geste, la session ne se ferme jamais et rien ne rend la main au terminal. Le maintien vit ici plutôt que dans main.js pour que ces tests
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

// Le rappel est désormais la SEULE issue d'un drone au sol : sans pose, un
// quad posé gaz coupés ne finit rien tout seul. Il doit donc s'afficher là où
// il ne s'affichait pas avant — sur une pose parfaite.
t('coincé : un drone posé gaz coupés voit le rappel, il n\'a plus d\'autre sortie', () => {
	const fe = new FlightEnd();
	hold(fe, CUT.STUCK_S + 0.2);
	assert.equal(fe.phase, FLYING);
	assert.equal(fe.out.stuck, true);
});

t('cuttable : vrai en vol, faux une fois la fin engagée', () => {
	const fe = new FlightEnd();
	fe.update(frame());
	assert.equal(fe.out.cuttable, true);
	// La frame de l'impact est encore lue en vol (le maintien est évalué avant
	// la transition) ; c'est la suivante qui n'a plus rien à couper.
	fe.update(frame({ crashed: true }));
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.cuttable, false);
});

// ---------------------------------------------------------------------------
// L'empreinte de la machine perdue (issue #57).

t('#57 : le jeton d\'empreinte est sur les trois tables, avec le portrait', () => {
	for (const table of [TIMELINE, FENCE_TIMELINE, CUT_TIMELINE]) {
		const art = table.lines.find(([, text]) => text === RANDOMART_LINE);
		const portrait = table.lines.find(([, text]) => text === PORTRAIT_LINE);
		assert.ok(art, 'aucune ligne d\'empreinte');
		assert.equal(art[0], portrait[0], 'l\'empreinte doit tomber avec le portrait');
	}
});

t('#57 : la sortie ne recule sur aucune des trois tables', () => {
	assert.equal(TIMELINE.exitAt, 4.6);
	assert.equal(FENCE_TIMELINE.exitAt, 3.0);
	assert.equal(CUT_TIMELINE.exitAt, 3.0);
});

t('#57 : après un crash, l\'empreinte est écrite avec le portrait', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, 4.2);
	assert.ok(fe.out.lines.includes(RANDOMART_LINE));
	assert.ok(fe.out.lines.includes(PORTRAIT_LINE));
});

// #67 : SOUS l'aperçu 3D, pas à côté. Le placement est du CSS, mais l'ordre
// des lignes est ce qui le rend possible — l'empreinte doit venir APRÈS le
// portrait dans la table, sans quoi elle se dessinerait au-dessus.
t('#67 : l\'empreinte vient après le portrait sur les trois tables', () => {
	for (const table of [TIMELINE, FENCE_TIMELINE, CUT_TIMELINE]) {
		const texts = table.lines.map(([, text]) => text);
		assert.ok(texts.indexOf(RANDOMART_LINE) > texts.indexOf(PORTRAIT_LINE),
			'l\'empreinte doit se poser sous l\'aperçu, donc après lui');
	}
});

console.log(`\n${n} tests OK`);
