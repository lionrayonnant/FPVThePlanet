// Selftest de rendu de l'écran de hack (src/hack.js).
//
// Il n'en existait aucun : hack-selftest.mjs ne couvre que les helpers purs, et
// la machine à états — celle qui pouvait laisser le joueur sur un écran sans
// sortie — n'était testée nulle part. C'est ce trou que l'issue #33 a trouvé.
//
// Lancer : node tools/hack-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';
import { randomart } from '../tools/randomart.mjs';

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

// La culmination (#101) s'intercale entre l'invite et le résultat. Elle se
// joue sur des frames et dure jusqu'à quatre secondes : un test la traverse
// par `__culminationTestFinish`, le même idiome que `__hackTestArm` au-dessus.
const burst = () => dom.root.querySelectorAll('.culmination-burst')[0] ?? null;

const skipCulmination = async () => {
	await tick();
	globalThis.__culminationTestFinish?.();
	await tick();
};

// L'écran est démonté quand la promesse se résout : on retient la dernière
// image de l'empreinte et le dernier texte de reprise en main au moment où
// __hackTestFinish les pose.
let lastArt = '';
let lastHandover = '';
globalThis.__hackTestObserve = (art, handover) => { lastArt = art; lastHandover = handover; };

await t('#33 : à l\'armement, un bouton JACK IN est monté', async () => {
	const [p] = await openArmed();
	assert.ok(jackIn(), 'aucun bouton JACK IN à l\'écran');
	jackIn().click();
	await skipCulmination();
	await p;
});

await t('#33 : JACK IN résout le hack et démonte l\'écran', async () => {
	const [p] = await openArmed();
	jackIn().click();
	await skipCulmination();
	const out = await p;
	assert.equal(out?.aborted, undefined, 'engager ne doit pas être un abandon');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#33 : l\'écran annonce sa sortie (D15)', async () => {
	const [p] = await openArmed();
	assert.match(dom.root.textContent, /ESC/, 'aucun indice de sortie affiché');
	jackIn().click();
	await skipCulmination();
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
	await skipCulmination();
	const out = await p;
	await tick();
	assert.equal(out?.aborted, undefined);
	assert.equal(settled, 1, 'la promesse ne doit se régler qu\'une fois');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0);
});

// ---------------------------------------------------------------------------
// L'acquisition : le fou marche APRÈS [ JACK IN ] (issue #57).

const openArmedWithSeed = async () => {
	reset();
	const p = runHack(dom.root, {
		hackType: 'GNSS SPOOF', family: 'freestyle5',
		ready: Promise.resolve(), buildSeed: 'abc123::3',
	});
	await tick();
	globalThis.__hackTestArm?.();
	await tick();
	return [p];
};

const artEl = () => dom.root.querySelectorAll('.hack-art')[0] ?? null;

await t('#57 : JACK IN ouvre la phase d\'acquisition au lieu de résoudre', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await skipCulmination();
	assert.ok(artEl(), 'aucune empreinte à l\'écran');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 1, 'écran démonté trop tôt');
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#57 : l\'empreinte atteint son image complète et CONTROL ACQUIRED tombe', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await skipCulmination();
	globalThis.__hackTestFinish?.();
	await p;
	// __hackTestFinish pose l'image finale AVANT de démonter : on la lit sur le
	// nœud détaché, que la closure du test tient encore.
	assert.equal(lastArt, randomart('abc123::3', { title: 'TGT ??', tag: 'abc123::3' }));
	assert.ok(lastHandover.includes('CONTROL ACQUIRED'));
});

await t('#57 : Échap pendant l\'acquisition résout, il ne laisse personne dedans', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await skipCulmination();
	dom.key('Escape');
	const out = await p;
	assert.equal(out?.aborted, undefined, 'Échap ici saute le battement, il n\'annule rien');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

// ---------------------------------------------------------------------------
// L'invite se voit et se tait quand elle a été entendue (issue #67).

await t('#67 : l\'invite a son PROPRE écran — l\'analyse est démontée', async () => {
	const [p] = await openArmed();
	assert.equal(dom.root.querySelectorAll('.hack-log').length, 0, 'le log de l\'analyse survit sous l\'invite');
	assert.equal(dom.root.querySelectorAll('.hack-jack').length, 1, 'pas d\'écran dédié à l\'invite');
	assert.match(jackIn().className, /\bhack-cta\b/, 'le CTA du hack n\'est pas gradé');
	assert.match(jackIn().className, /\bterminal-cta\b/, '[ … ] vient de terminal-cta');
	assert.match(dom.root.textContent, /MANUAL OVERRIDE/, 'l\'invite ne dit pas ce qu\'elle demande');
	jackIn().click();
	await skipCulmination();
	await p;
});

await t('#67 : Échap sur l\'invite renonce encore — rien n\'est pris', async () => {
	const [p] = await openArmed();
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { aborted: true });
	assert.equal(dom.root.querySelectorAll('.hack-jack').length, 0, 'écran encore monté');
});

await t('#67 : le résultat a son PROPRE écran — l\'invite est démontée', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await skipCulmination();
	assert.equal(jackIn(), undefined, 'le bouton respire encore sous CONTROL ACQUIRED');
	assert.equal(dom.root.querySelectorAll('.hack-jack').length, 0, 'écran d\'invite encore monté');
	assert.equal(dom.root.querySelectorAll('.hack-acquired').length, 1, 'pas d\'écran dédié au résultat');
	assert.match(dom.root.textContent, /CONTROL ACQUIRED/);
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#57 : sans buildSeed, JACK IN résout comme avant', async () => {
	const [p] = await openArmed();   // pas de buildSeed
	jackIn().click();
	await skipCulmination();
	await p;
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0);
});

// ---------------------------------------------------------------------------
// La culmination : le geste tombe sur quelque chose (#101). Elle avait disparu
// avec la saisie du CONTROL VECTOR, laissant [ JACK IN ] couper droit au
// résultat.

await t('#101 : JACK IN ouvre la culmination AVANT le résultat', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	assert.ok(burst(), 'aucune culmination après le geste');
	assert.equal(dom.root.querySelectorAll('.hack-acquired').length, 0, 'le résultat tombe sans culmination');
	assert.equal(dom.root.querySelectorAll('.hack-jack').length, 0, 'écran d\'invite encore monté');
	globalThis.__culminationTestFinish?.();
	await tick();
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#101 : les frames dessinent le motif, borné 44×12 et coloré', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	dom.tick(16);
	const el = burst();
	const rows = el.textContent.split('\n');
	assert.equal(rows.length, 12, 'le motif ne fait pas 12 lignes');
	for (const r of rows) assert.equal(r.length, 44, 'le motif ne fait pas 44 colonnes');
	// La palette demo scene (Bible §19) est portée par le conteneur, pas par la
	// primitive : sans classe de couleur, le motif sortirait en blanc.
	assert.match(el.className, /culmination-burst--(cyan|magenta|violet|blue)/, el.className);
	await skipCulmination();
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#101 : la culmination se démonte quand elle rend la main', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await skipCulmination();
	assert.equal(burst(), null, 'la culmination survit sous le résultat');
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#101 : Échap pendant la culmination saute le battement, il n\'annule pas', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	dom.key('Escape');
	await tick();
	assert.equal(burst(), null, 'Échap laisse la culmination à l\'écran');
	assert.equal(dom.root.querySelectorAll('.hack-acquired').length, 1, 'Échap a sauté le résultat aussi');
	globalThis.__hackTestFinish?.();
	const out = await p;
	assert.equal(out?.aborted, undefined, 'le contrôle est pris : plus rien n\'annule');
});

// Une culmination démontée ne doit plus rien faire tourner derrière l'écran
// suivant : c'est exactement le riser abandonné qui hantait l'ancien rituel.
await t('#101 : démontée, elle cesse de consommer des frames', async () => {
	const [p] = await openArmed();   // sans buildSeed : rien ne tourne après elle
	jackIn().click();
	await skipCulmination();
	await p;
	const before = dom.window.__rafCount;
	dom.tick(16);
	dom.tick(16);
	assert.equal(dom.window.__rafCount, before, 'la culmination tourne encore après son démontage');
});

dom.restore();
console.log(`\n${n} tests hack-render OK`);
