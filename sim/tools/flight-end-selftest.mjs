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

	const seen = [];
	for (const [at, text] of TIMELINE.lines) {
		const fresh = new FlightEnd();
		fresh.update(frame({ crashed: true }));
		advance(fresh, at + 0.05, { crashed: true });
		seen.push(text);
		assert.deepEqual(fresh.out.lines, seen, `à t=${at}s`);
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

console.log(`\n${n} tests OK`);
