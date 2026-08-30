// Selftest de la logique pure de src/menu-nav.js (issue #123). Aucune E/S,
// aucun DOM : seuls les helpers exportés sans dépendance navigateur sont
// couverts — la pile de navs et la manette se vérifient au navigateur.
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

console.log(`menu-nav-selftest: ${n} tests ok`);
