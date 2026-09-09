// Selftest de rendu de l'écran TARGET SCAN (src/target-scan.js).
//
// Depuis l'issue #49 la fiche pré-hack n'existe plus : la liste est le seul
// écran, et activer une ligne CHOISIT la cible. Les tests suivent ce
// déplacement — le défaut de l'issue #73 n'est plus « deux fiches s'empilent »
// mais « une frappe qui arrive deux fois résout deux fois », qui est le même
// bug sous sa forme restante et reste couvert ici.
//
// On vérifie l'ARBRE et le CÂBLAGE, pas l'apparence — même intention que
// data-render-selftest.mjs.
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

await t('la liste monte un bouton par signal détecté', async () => {
	const p = open();
	await tick();
	assert.equal(rows().length, 4, 'quatre signaux, quatre boutons');
	assert.match(dom.root.textContent, /TARGET SCAN/);
	assert.match(dom.root.textContent, /SIGNALS DETECTED/);
	dom.key('Escape');
	await p;
});

await t('#49 : la ligne porte le signal, le mode vidéo ET le device', async () => {
	// Ce qui remplace la fiche doit être RÉELLEMENT lisible sur la ligne, pas
	// seulement présent dans l'objet que rend scanLines().
	const p = open();
	await tick();
	for (const row of rows()) {
		assert.match(row.textContent, /-\d+ dBm/, `signal absent de « ${row.textContent} »`);
		assert.match(row.textContent, /ANALOG|DIGITAL|UNKNOWN/, `mode absent de « ${row.textContent} »`);
		// Le device est le seul champ qui n'a pas de forme fixe ; ce qui se
		// vérifie ici est qu'il RESTE quelque chose après les trois autres.
		const rest = row.textContent.replace(/^\s*\d+\s+-\d+ dBm[^A-Z]*/, '')
			.replace(/^(ANALOG|DIGITAL|UNKNOWN)\s*/, '');
		assert.ok(rest.trim().length > 0, `device absent de « ${row.textContent} »`);
	}
	// Et plus aucun des champs constants que la fiche répétait.
	const text = dom.root.textContent;
	for (const gone of ['LOCATION', 'FLIGHT STATE', 'CONTROL', 'PARTIAL', 'CONFIRM']) {
		assert.ok(!text.includes(gone), `« ${gone} » survit à la suppression de la fiche`);
	}
	dom.key('Escape');
	await p;
});

await t('activer une ligne rend le signal choisi et démonte tout', async () => {
	const p = open();
	await tick();
	rows()[2].click();
	const choice = await p;
	assert.equal(choice.index, 2, 'l\'index rendu est celui du signal activé');
	assert.ok(choice.seed, 'la graine du scan revient avec le choix');
	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'plus rien à l\'écran');
});

await t('#73 : une frappe qui arrive deux fois ne choisit qu\'UNE fois', async () => {
	// L'héritier direct du défaut de l'issue #73. Sans fiche il n'y a plus rien
	// à empiler, mais les deux chemins d'activation existent toujours : sans
	// garde, l'écran se démonterait deux fois et le second démontage
	// travaillerait sur un arbre déjà retiré.
	const p = open();
	await tick();
	const row = rows()[0];
	row.click();
	row.click();            // la frappe qui arrivait deux fois
	const choice = await p;
	assert.equal(choice.index, 0, 'le premier choix est celui qui compte');
	assert.equal(dom.root.querySelectorAll('.terminal-row').length, 0, 'écran démonté une seule fois');
});

await t('#29 : la ligne d\'un cluster dit MESH, GROUP et COUNT — et rien de plus', async () => {
	// swarmChance 1 : le cluster est le plus fort signal, donc la première ligne.
	reset();
	const p = runTargetScan(dom.root, { seed: 'render::swarm', count: 4, swarmChance: 1 });
	await tick();
	const first = rows()[0].textContent;
	assert.match(first, /-\d+ dBm \(STRONGEST OF GROUP\)/);
	assert.match(first, /MESH — MULTIPLE EMITTERS/);
	assert.match(first, /COUNT UNKNOWN/);
	assert.ok(!first.includes('swarmNode'), 'la ligne ne nomme jamais la famille');
	// Les cibles ordinaires du même scan ne parlent d'aucun groupe.
	for (const row of rows().slice(1)) {
		assert.ok(!row.textContent.includes('COUNT'), `COUNT sur une cible ordinaire : « ${row.textContent} »`);
		assert.ok(!row.textContent.includes('GROUP'), `GROUP sur une cible ordinaire : « ${row.textContent} »`);
	}
	dom.key('Escape');
	await p;
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
