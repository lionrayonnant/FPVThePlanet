// node tools/calibration-drone-render-selftest.mjs — la machine qui réagit au
// manche pendant le calibrage (issue #281), sur le faux DOM.
//
// Ce qu'on vérifie est l'ARBRE et le CÂBLAGE : qu'un manche poussé change le
// dessin, que le gaz fait monter la machine, qu'un canal fraîchement attribué
// rejoue son geste tout seul, et que la boucle s'arrête au démontage.
// L'apparence se juge à l'oeil, pas ici — la POSE, elle, est couverte sans DOM
// par tools/calibration-preview-selftest.mjs.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom({ raf: true });
const { calibrationDrone } = await import('../src/calibration-drone.js');
const { beginCalibration, feedSample, CAL_TIMING } = await import('../src/calibration.js');
const { REPLAY_MS } = await import('../src/calibration-preview.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('calibration-drone');

const AXES = 4;
const zero = [0, 0, 0, 0];
const feed = (state, signals, ms, dt = 16) => {
	for (let e = 0; e < ms; e += dt) state = feedSample(state, signals, dt);
	return state;
};

// Une sonde pilotable : on pose ce que la machine doit refléter, on pousse des
// frames, on regarde le SVG.
function probe() {
	let now = { state: null, signals: zero };
	const d = calibrationDrone({ sample: () => now });
	return {
		el: d.el,
		stop: d.stop,
		set(state, signals = zero) { now = { state, signals }; },
		tick(ms) { dom.tick(ms); },
		// Le dessin, réduit à une empreinte COURTE : six cents traits qui
		// diffèrent ne se lisent pas dans un diff de deux pages.
		lines() {
			let h = 0;
			for (const l of d.el.querySelectorAll('line')) {
				for (const a of ['x1', 'y1', 'x2', 'y2']) {
					const t = l.getAttribute(a) ?? '';
					for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
				}
			}
			return (h >>> 0).toString(16).padStart(8, '0');
		},
		lift() { return d.el.querySelector('g')?.getAttribute('transform') ?? ''; },
	};
}

t('la machine est un SVG en traits, monté sans manette', () => {
	const p = probe();
	assert.equal(p.el.tagName.toLowerCase(), 'svg');
	assert.ok(p.el.querySelectorAll('line').length > 50, 'un quad fait plus de cinquante arêtes');
	p.stop();
});

t('aucune couleur en dur : tout est currentColor', () => {
	// Même règle que les portraits d'archive et les icônes pixel : la couleur
	// vient de la feuille de style, jamais du module de dessin.
	const p = probe();
	for (const l of p.el.querySelectorAll('line')) assert.equal(l.getAttribute('stroke'), 'currentColor');
	p.stop();
});

t('un manche poussé change le dessin', () => {
	const p = probe();

	// Arrêté sur ROLL : le gaz, le lacet et le tangage sont déjà mesurés.
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	s = feed(s, [0, 0, 1, 0], CAL_TIMING.holdMs + 200);                                  // gaz
	s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
	s = feed(s, [0, 0, 0, 1], CAL_TIMING.holdMs + 200); s = feed(s, zero, 200);          // lacet
	s = feed(s, [0, 1, 0, 0], CAL_TIMING.holdMs + 200); s = feed(s, zero, 200);          // tangage
	assert.equal(s.channel, 'roll', 'le scénario doit s\'arrêter sur ROLL');

	// Manches au neutre, et le temps qu'un éventuel rejeu s'achève : c'est cette
	// frame-là qui pose la référence, pas la première.
	p.set(s, zero);
	p.tick(16);
	p.tick(REPLAY_MS + 100);
	const neutre = p.lines();

	p.set(s, [1, 0, 0, 0]);
	p.tick(16);
	assert.notEqual(p.lines(), neutre, 'le dessin n\'a pas bougé');

	// Et il revient à plat quand le manche revient : sinon la machine dériverait
	// d'une consigne à l'autre.
	p.set(s, zero);
	p.tick(16);
	assert.equal(p.lines(), neutre);
	p.stop();
});

t('HANDS OFF : un signal écarté ne fait PAS bouger la machine', () => {
	// La consigne dit « ne touche à rien » : une machine qui s'agite dirait au
	// pilote le contraire de ce qu'on lui demande.
	const p = probe();
	p.tick(0);
	const repos = p.lines();
	p.set(beginCalibration(AXES), [0.9, 0, 0, 0]);
	p.tick(16);
	assert.equal(p.lines(), repos);
	p.stop();
});

t('le gaz fait MONTER la machine dans le cadre', () => {
	const p = probe();
	p.tick(0);
	assert.match(p.lift(), /translate\(0 -?0?\.?0*\)/, `au repos : « ${p.lift()} »`);

	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	assert.equal(s.channel, 'throttle');
	p.set(s, [0, 0, 1, 0]);
	p.tick(16);
	// SVG a l'axe Y vers le bas : monter, c'est translater vers le négatif.
	const y = Number(/translate\(0 (-?[\d.]+)\)/.exec(p.lift())?.[1]);
	assert.ok(y < -0.05, `la machine devrait monter, transform = « ${p.lift()} »`);
	p.stop();
});

t('un canal fraîchement attribué rejoue son geste, manches au neutre', () => {
	// La confirmation visuelle que le mappage est le bon. Les signaux sont à
	// zéro : tout mouvement vient forcément du rejeu.
	const p = probe();

	// Avant : le gaz est mesuré, le lacet pas encore.
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	s = feed(s, [0, 0, 1, 0], CAL_TIMING.holdMs + 200);
	s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
	assert.equal(s.channel, 'yaw');
	p.set(s, zero);
	p.tick(0);
	const debut = p.lines();

	// Après : le lacet vient d'être attribué. C'est ce PASSAGE qui déclenche.
	s = feed(s, [0, 0, 0, 1], CAL_TIMING.holdMs + 200);
	assert.ok(s.channels.yaw, 'le lacet vient d\'être attribué');
	p.set(s, zero);
	p.tick(16);
	p.tick(REPLAY_MS / 2);          // milieu du rejeu : la machine est à la butée
	assert.notEqual(p.lines(), debut, 'la machine n\'a pas rejoué le geste');

	p.tick(REPLAY_MS);              // rejeu terminé : elle doit être revenue à plat
	assert.equal(p.lines(), debut, 'la machine est restée de travers après le rejeu');
	p.stop();
});

t('un périphérique DÉJÀ calibré ne rejoue rien à l\'ouverture', () => {
	// Le banc d'essai : les quatre canaux sont mesurés dès le premier
	// échantillon. Les prendre pour des nouveautés ferait rejouer quatre gestes
	// et couvrirait le manche du pilote pendant tout ce temps.
	const p = probe();
	p.tick(0);
	const repos = p.lines();
	p.set({
		phase: 'done',
		deadband: 0.02,
		channels: {
			throttle: { axis: 2, lo: 0, hi: 1 },
			yaw: { axis: 3, center: 0, span: 1, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: false },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
	}, zero);
	p.tick(16);
	assert.equal(p.lines(), repos, 'la machine a bougé alors que rien n\'a été touché');
	p.stop();
});

t('stop() coupe la boucle', () => {
	const p = probe();
	p.tick(16);
	p.stop();
	const before = dom.window.__rafCount ?? 0;
	dom.tick?.(100);
	assert.equal(dom.window.__rafCount ?? 0, before, 'la machine tourne encore après stop()');
});

t('sans rien à montrer, la machine reste à plat plutôt que de jeter', () => {
	const p = probe();
	p.tick(0);
	const repos = p.lines();
	p.set(null, []);
	p.tick(16);
	assert.equal(p.lines(), repos);
	p.stop();
});

dom.restore();
console.log(`\n${n} ok`);
