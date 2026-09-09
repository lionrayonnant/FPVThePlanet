// Selftest de rendu de l'écran de hack (src/hack.js).
//
// Il n'en existait aucun : hack-selftest.mjs ne couvre que les helpers purs, et
// la machine à états — celle qui pouvait laisser le joueur sur un écran sans
// sortie — n'était testée nulle part. C'est ce trou que l'issue #33 a trouvé.
//
// Lancer : node tools/hack-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

// { raf: true } : contrairement à target-scan.js, hack.js pousse
// inconditionnellement requestAnimationFrame(loop) au démarrage (le motif
// visuel tourne pendant toute la séquence) — sans le polyfill, runHack()
// lève avant même d'avoir monté l'écran.
const dom = installFakeDom({ raf: true });

globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

const { runHack } = await import('../src/hack.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };

// Le hack déroule ses étapes sur des minuteurs. On ne les attend pas : le test
// pousse la machine jusqu'à l'armement en vidant la file, ce que `__hackTestArm`
// expose pour ce seul usage.
//
// Renvoyé dans un tableau, PAS directement : `p` est encore EN ATTENTE à ce
// point (armé, mais rien n'a encore cliqué JACK IN). Un `return p` depuis une
// fonction async ferait adopter cette promesse par celle d'`openArmed()` —
// `await openArmed()` bloquerait alors jusqu'à ce que `p` se résolve, ce qui
// n'arrive qu'APRÈS ce même await (le clic vient après). Un tableau n'est pas
// thenable : il traverse `await` sans être déballé.
const openArmed = async () => {
	reset();
	const p = runHack(dom.root, { hackType: 'GNSS SPOOF', family: 'freestyle5', ready: Promise.resolve() });
	await tick();
	globalThis.__hackTestArm?.();
	await tick();
	return [p];
};

const jackIn = () => dom.root.querySelectorAll('button').find((b) => b.textContent.includes('JACK IN'));

await t('#33 : à l\'armement, un bouton JACK IN est monté', async () => {
	const [p] = await openArmed();
	assert.ok(jackIn(), 'aucun bouton JACK IN à l\'écran');
	jackIn().click();
	await p;
});

await t('#33 : JACK IN résout le hack et démonte l\'écran', async () => {
	const [p] = await openArmed();
	jackIn().click();
	const out = await p;
	assert.equal(out?.aborted, undefined, 'engager ne doit pas être un abandon');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#33 : l\'écran annonce sa sortie (D15)', async () => {
	const [p] = await openArmed();
	assert.match(dom.root.textContent, /ESC/, 'aucun indice de sortie affiché');
	jackIn().click();
	await p;
});

await t('#33 : Échap abandonne et rend { aborted: true }', async () => {
	const [p] = await openArmed();
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { aborted: true });
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

// La raison d'être du chantier : le bug de l'issue #33 vivait précisément
// PENDANT le chargement ('hold'), avant que [ JACK IN ] ne soit armé — un
// `ready` qui ne se résout jamais garde le hack coincé là, exactement comme
// un terrain qui met du temps à charger derrière l'écran en jeu réel.
await t('#33 : Échap AVANT l\'armement (pendant le chargement) abandonne déjà', async () => {
	reset();
	const p = runHack(dom.root, { hackType: 'GNSS SPOOF', family: 'freestyle5', ready: new Promise(() => {}) });
	await tick();
	assert.equal(jackIn(), undefined, 'JACK IN ne doit pas encore être monté pour ce test');
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { aborted: true });
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#33 : une double activation ne résout qu\'UNE fois', async () => {
	const [p] = await openArmed();
	// Compte les RÈGLEMENTS de la promesse, pas juste sa valeur : un second
	// resolve() est silencieusement ignoré par construction, donc seul un
	// compteur d'appels distingue « le garde a tourné une fois » de « il a
	// tourné deux fois mais la seconde n'a rien changé ».
	let settled = 0;
	p.then(() => { settled++; });
	const b = jackIn();
	b.click();
	b.click();
	const out = await p;
	await tick();
	assert.equal(out?.aborted, undefined);
	assert.equal(settled, 1, 'la promesse ne doit se régler qu\'une fois');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0);
});

dom.restore();
console.log(`\n${n} tests hack-render OK`);
