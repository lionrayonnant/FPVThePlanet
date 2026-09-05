// Selftest de rendu de l'écran TARGET SCAN (src/target-scan.js).
//
// Il couvre le défaut de l'issue #73 : quand la même frappe atteignait à la
// fois le bouton focalisé et un second chemin d'activation, `sheet()` était
// appelée deux fois et DEUX fiches s'empilaient sur la liste. C'était
// récupérable (BACK deux fois), mais l'écran mentait sur l'endroit où on se
// trouve, et la deuxième fiche gardait ses abonnements.
//
// On vérifie l'ARBRE et le CÂBLAGE, pas l'apparence — même intention que
// archive-render-selftest.mjs.
//
// Lancer : node tools/target-scan-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

const { runTargetScan } = await import('../src/target-scan.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };

// Un écran TARGET SCAN monté sur une graine fixe : la liste est reproductible.
const open = () => {
	reset();
	const p = runTargetScan(dom.root, { seed: 'selftest::73', count: 4 });
	return p;
};

const rows = () => dom.root.querySelectorAll('.terminal-row');
const sheets = () => dom.root.querySelectorAll('button').filter((b) => b.textContent.includes('CONFIRM'));

await t('la liste monte un bouton par signal détecté', async () => {
	const p = open();
	await tick();
	assert.equal(rows().length, 4, 'quatre signaux, quatre boutons');
	assert.match(dom.root.textContent, /TARGET SCAN/);
	assert.match(dom.root.textContent, /SIGNALS DETECTED/);
	dom.key('Escape');
	await p;
});

await t('#73 : deux activations du même signal n\'empilent qu\'UNE fiche', async () => {
	// Le cœur de l'issue. Avant la garde, le second appel construisait un
	// second écran fiche par-dessus le premier — deux CONFIRM à l'écran.
	const p = open();
	await tick();
	const row = rows()[0];
	row.click();
	await tick();
	assert.equal(sheets().length, 1, 'une fiche après la première activation');

	row.click();            // la frappe qui arrivait deux fois
	await tick();
	assert.equal(sheets().length, 1, 'toujours UNE fiche après la seconde');

	dom.key('Escape');      // un seul BACK doit suffire à revenir à la liste
	await tick();
	assert.equal(sheets().length, 0, 'la fiche est refermée');
	assert.equal(rows().length, 4, 'et la liste a repris la main');
	dom.key('Escape');
	await p;
});

await t('#73 : rouvrir une fiche reste possible après un BACK', async () => {
	// La garde ne doit pas coincer l'écran dans l'état « fiche » : c'est le
	// risque d'un drapeau posé sans être rendu.
	const p = open();
	await tick();
	rows()[0].click();
	await tick();
	dom.key('Escape');
	await tick();
	rows()[1].click();
	await tick();
	assert.equal(sheets().length, 1, 'la seconde fiche s\'ouvre normalement');
	dom.key('Escape');
	await tick();
	dom.key('Escape');
	await p;
});

await t('CONFIRM rend le signal choisi et démonte tout', async () => {
	const p = open();
	await tick();
	rows()[2].click();
	await tick();
	dom.root.querySelectorAll('button').find((b) => b.textContent.includes('CONFIRM')).click();
	const choice = await p;
	assert.equal(choice.index, 2, 'l\'index rendu est celui du signal activé');
	assert.ok(choice.seed, 'la graine du scan revient avec le choix');
	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'plus rien à l\'écran');
});

await t('Échap sur la liste annule sans choisir', async () => {
	const p = open();
	await tick();
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { cancelled: true });
});

dom.restore();
console.log(`\n${n} tests target-scan-render OK`);
