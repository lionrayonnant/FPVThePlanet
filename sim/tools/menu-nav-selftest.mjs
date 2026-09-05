// Selftest de src/menu-nav.js (issue #123). L'essentiel est de la logique pure
// sans E/S. La fin du fichier couvre en plus le CYCLE DE VIE de la pile de
// navs sur le faux DOM (issue #210) : c'est là qu'un écran retiré sans
// detach() laissait derrière lui une scrutation manette à 80 ms.
// Lancer : node tools/menu-nav-selftest.mjs
import assert from 'node:assert/strict';
import { nextIndex, stepValue, isTextEntry, isTextEntryKind } from '../src/menu-nav.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- nextIndex --------------------------------------------------------------

t('nextIndex : circule dans les deux sens', () => {
	assert.equal(nextIndex(3, 0, 1), 1);
	assert.equal(nextIndex(3, 2, 1), 0);
	assert.equal(nextIndex(3, 0, -1), 2);
});

t('nextIndex : sans focus courant, on entre par le bord d\'où vient le mouvement', () => {
	assert.equal(nextIndex(4, -1, 1), 0);
	assert.equal(nextIndex(4, -1, -1), 3);
});

t('nextIndex : liste vide -> -1 (rien à focaliser)', () => {
	assert.equal(nextIndex(0, -1, 1), -1);
	assert.equal(nextIndex(0, 0, -1), -1);
});

// --- stepValue --------------------------------------------------------------

t('stepValue : un pas dans la direction demandée', () => {
	assert.equal(stepValue({ value: 50, min: 0, max: 100, step: 1 }, 'right'), 51);
	assert.equal(stepValue({ value: 50, min: 0, max: 100, step: 1 }, 'left'), 49);
});

t('stepValue : borné aux extrémités du slider', () => {
	assert.equal(stepValue({ value: 100, min: 0, max: 100, step: 1 }, 'right'), 100);
	assert.equal(stepValue({ value: 0, min: 0, max: 100, step: 1 }, 'left'), 0);
});

t('stepValue : respecte un pas fractionnaire (obturation 0.5)', () => {
	assert.equal(stepValue({ value: 8, min: 0, max: 20, step: 0.5 }, 'right'), 8.5);
});

t('stepValue : attributs absents (NaN) -> pas de 1 sur 0..100', () => {
	assert.equal(stepValue({ value: 99.5, min: NaN, max: NaN, step: NaN }, 'right'), 100);
	assert.equal(stepValue({ value: 0.5, min: NaN, max: NaN, step: NaN }, 'left'), 0);
});

// --- isTextEntry ------------------------------------------------------------

t('isTextEntryKind : les champs où l\'on tape gardent leurs touches', () => {
	// La recherche du scanner (type=search), le nom d'opérateur (type=text) et
	// la note post-vol (textarea) doivent rester éditables (issue #123).
	assert.equal(isTextEntryKind('INPUT', 'search'), true);
	assert.equal(isTextEntryKind('INPUT', 'text'), true);
	assert.equal(isTextEntryKind('TEXTAREA', 'textarea'), true);
});

t('isTextEntryKind : slider, checkbox et bouton ne sont pas de la saisie', () => {
	// Un range focalisé doit se régler avec ←/→ dans Settings, pas absorber
	// la navigation entière.
	assert.equal(isTextEntryKind('INPUT', 'range'), false);
	assert.equal(isTextEntryKind('INPUT', 'checkbox'), false);
	assert.equal(isTextEntryKind('BUTTON', 'button'), false);
	assert.equal(isTextEntryKind('SELECT', 'select-one'), false);
});

t('isTextEntry : cible absente -> false', () => {
	assert.equal(isTextEntry(null), false);
	assert.equal(isTextEntry(undefined), false);
});

// --- cycle de vie de la pile (issue #210) ------------------------------------

// Ces tests-ci ont besoin d'un DOM : ils sont montés après les tests purs pour
// que ceux-ci restent lisibles sans harnais.
const { installFakeDom } = await import('./lib/fake-dom.mjs');
const dom = installFakeDom();
const { menuNav } = await import('../src/menu-nav.js');

// On compte les scrutations en interceptant setInterval/clearInterval plutôt
// qu'en interrogeant process._getActiveHandles() : celui-ci ne rapporte plus
// les timers sur Node 26, et le test « passait » en mesurant zéro partout.
const live = new Set();
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
globalThis.setInterval = (...a) => { const id = realSet(...a); live.add(id); return id; };
globalThis.clearInterval = (id) => { live.delete(id); return realClear(id); };
const timers = () => live.size;

const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ta('un écran RETIRÉ du DOM sans detach() ne garde pas sa scrutation', async () => {
	// Le cas de #210 : l'écran est remplacé (reset / replaceChildren) au lieu
	// d'être fermé. Personne n'appelle detach(), et le setInterval survivait —
	// assez pour bloquer une suite de selftests entière.
	const before = timers();
	const el = document.createElement('div');
	dom.root.appendChild(el);
	el.appendChild(document.createElement('button'));
	menuNav(el);
	assert.equal(timers(), before + 1, 'la scrutation est bien ouverte au montage');

	dom.root.replaceChildren();          // l'écran s'en va sans se désabonner
	await sleep(200);                    // la scrutation se ramasse elle-même
	assert.equal(timers(), before, 'plus aucune scrutation derrière un écran mort');
});

await ta('un écran seulement MASQUÉ garde sa scrutation (la liste sous sa fiche)', async () => {
	// La distinction qui rend #210 non trivial : target-scan.js masque sa liste
	// derrière la fiche (display:none) et la reprend au retour. Masqué n'est
	// pas mort — la confondre avec un retrait couperait la navigation au BACK.
	const before = timers();
	const el = document.createElement('div');
	dom.root.appendChild(el);
	el.appendChild(document.createElement('button'));
	const nav = menuNav(el);
	el.style.display = 'none';
	await sleep(200);
	assert.equal(timers(), before + 1, 'la liste masquée est toujours abonnée');
	nav.detach();
	assert.equal(timers(), before, 'et detach() la libère normalement');
	dom.root.replaceChildren();
});

globalThis.setInterval = realSet;
globalThis.clearInterval = realClear;
dom.restore();

console.log(`menu-nav-selftest: ${n} tests ok`);
