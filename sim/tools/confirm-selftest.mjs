// Selftest du geste de confirmation du terminal (src/confirm-button.js, #213).
//
// Il remplace les deux derniers confirm() de navigateur — REMOVE TERRAIN et
// RESET SETTINGS. Ce qui compte : la PREMIÈRE pression ne détruit rien, la
// DEUXIÈME oui, et un bouton armé ne le reste pas indéfiniment.
//
// Lancer : node tools/confirm-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';
import { nextConfirmState, confirmLabel, CONFIRM_TIMEOUT_MS } from '../src/confirm-button.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// --- l'automate, sans DOM ----------------------------------------------------

t('nextConfirmState : une pression sur un bouton neutre ARME, sans agir', () => {
	assert.deepEqual(nextConfirmState(false), { armed: true, fire: false });
});

t('nextConfirmState : une pression sur un bouton armé AGIT, et désarme', () => {
	assert.deepEqual(nextConfirmState(true), { armed: false, fire: true });
});

t('confirmLabel : le libellé armé dit ce qui va se passer', () => {
	assert.equal(confirmLabel('[ REMOVE TERRAIN ]'), '[ REMOVE TERRAIN ] — CONFIRM');
});

// --- le câblage, sur le faux DOM --------------------------------------------

const dom = installFakeDom();
const { armConfirm } = await import('../src/confirm-button.js');

const mkButton = (label) => {
	const b = document.createElement('button');
	b.textContent = label;
	dom.root.appendChild(b);
	return b;
};

await ta('la première pression ne détruit rien et réétiquette le bouton', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; });
	b.click();
	assert.equal(fired, 0, 'rien n\'est parti sur la première pression');
	assert.equal(b.textContent, '[ REMOVE TERRAIN ] — CONFIRM');
});

await ta('la deuxième pression agit, une seule fois', async () => {
	let fired = 0;
	const b = mkButton('[ RESET ]');
	armConfirm(b, () => { fired++; });
	b.click();
	b.click();
	assert.equal(fired, 1, 'l\'action part exactement une fois');
	assert.equal(b.textContent, '[ RESET ]', 'et le bouton est revenu au neutre');
});

await ta('une troisième pression réarme au lieu de refaire', async () => {
	// Sans le retour au neutre, un bouton resté armé transformerait la pression
	// suivante — venue pour tout autre chose — en seconde destruction.
	let fired = 0;
	const b = mkButton('[ RESET ]');
	armConfirm(b, () => { fired++; });
	b.click(); b.click(); b.click();
	assert.equal(fired, 1, 'toujours une seule action');
	assert.equal(b.textContent, '[ RESET ] — CONFIRM', 'la troisième réarme');
});

await ta('quitter le bouton le désarme (souris comme focus)', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; });
	b.click();
	b.dispatchEvent({ type: 'mouseleave' });
	assert.equal(b.textContent, '[ REMOVE TERRAIN ]', 'le curseur parti, le bouton se désarme');
	b.click();
	assert.equal(fired, 0, 'la pression suivante réarme, elle ne détruit pas');
});

await ta('l\'armement retombe tout seul après le délai', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; }, { timeoutMs: 30 });
	b.click();
	assert.equal(b.textContent, '[ REMOVE TERRAIN ] — CONFIRM');
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(b.textContent, '[ REMOVE TERRAIN ]', 'revenu au neutre sans intervention');
	b.click();
	assert.equal(fired, 0, 'et une pression distraite ne détruit rien');
});

await ta('le délai par défaut laisse le temps de lire, sans être une éternité', async () => {
	assert.ok(CONFIRM_TIMEOUT_MS >= 2000 && CONFIRM_TIMEOUT_MS <= 10000, `délai déraisonnable : ${CONFIRM_TIMEOUT_MS}`);
});

await ta('le détachement rend le bouton inerte', async () => {
	let fired = 0;
	const b = mkButton('[ RESET ]');
	const off = armConfirm(b, () => { fired++; });
	off();
	b.click(); b.click();
	assert.equal(fired, 0, 'plus rien ne part');
	assert.equal(b.textContent, '[ RESET ]');
});

dom.restore();
console.log(`\n${n} tests confirm OK`);
