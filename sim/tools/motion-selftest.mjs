// Selftest de la logique pure de src/motion.js (issue #224) : la cascade de
// révélation et le défilement des chiffres se vérifient hors navigateur sur
// le faux DOM ; le rendu se juge à l'œil (npm run dev).
// Lancer : node tools/motion-selftest.mjs
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

installFakeDom();
const { revealDelays, revealTargets, reveal, interpolateNumbers, revealDelayOf, watchReveal, LEAD_MS, exitScreen, EXIT_MS } = await import('../src/motion.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// --- revealDelays -----------------------------------------------------------

t('revealDelays : lead, puis un pas par élément', () => {
	assert.deepEqual(revealDelays(4, { lead: 90, step: 40, cap: 600 }), [90, 130, 170, 210]);
});

t('revealDelays : plafonné — une longue liste ne fait pas attendre', () => {
	const d = revealDelays(50, { lead: 0, step: 40, cap: 400 });
	assert.equal(d.length, 50);
	assert.equal(d[49], 400);
	assert.equal(d[10], 400);
	assert.equal(d[9], 360);
});

t('revealDelays : liste vide', () => {
	assert.deepEqual(revealDelays(0, {}), []);
});

// --- revealTargets ----------------------------------------------------------

const el = (tag, cls = '', ...kids) => {
	const e = document.createElement(tag);
	e.className = cls;
	kids.forEach((k) => e.appendChild(k));
	return e;
};

t('revealTargets : les enfants directs, et les lignes des listes à leur place', () => {
	const rowA = el('button', 'terminal-area');
	const rowB = el('button', 'terminal-area');
	const list = el('div', 'terminal-areas', rowA, rowB);
	const head = el('pre');
	const foot = el('pre', 'terminal-foot');
	const box = el('div', 'bootstrap-box', head, list, foot);
	assert.deepEqual(revealTargets(box), [head, rowA, rowB, foot]);
});

t('revealTargets : une colonne ouverte s\'ouvre récursivement, une liste du scanner reste un bloc', () => {
	const r1 = el('button', 'sc-result');
	const results = el('div', 'sc-results', r1);
	const a = el('button', 'terminal-link');
	const navRow = el('div', 'terminal-nav', a);
	const left = el('div', 'terminal-left', el('pre'), navRow, results);
	const right = el('div', 'terminal-right');
	const box = el('div', 'bootstrap-box', left, right);
	const got = revealTargets(box);
	assert.equal(got.length, 4);
	assert.equal(got[1], a);
	assert.equal(got[2], results);
	assert.equal(got[3], right);
});

t('revealTargets : les nœuds texte sont ignorés', () => {
	const box = el('div', 'bootstrap-box', el('pre'));
	box.appendChild(document.createTextNode(' · '));
	assert.equal(revealTargets(box).length, 1);
});

// --- reveal -----------------------------------------------------------------

t('reveal : tamponne un délai croissant, et ne repasse pas sur un élément déjà tamponné', () => {
	const a = el('pre');
	const b = el('pre');
	const box = el('div', 'bootstrap-box', a, b);
	reveal(box, { lead: 90, step: 40, cap: 600 });
	assert.equal(a.dataset.reveal, '90');
	assert.equal(b.dataset.reveal, '130');
	assert.equal(a.style.animationDelay, '90ms');
	const c = el('pre');
	box.appendChild(c);
	reveal(box, { lead: 90, step: 40, cap: 600 });
	assert.equal(a.dataset.reveal, '90', 'inchangé');
	assert.equal(c.dataset.reveal, '90', 'nouvelle fournée : nouvelle impression');
});

t('revealDelayOf : remonte au bloc tamponné le plus proche, 0 sans bloc', () => {
	const span = el('span');
	const row = el('button', 'terminal-area', span);
	row.dataset.reveal = '170';
	const box = el('div', 'bootstrap-box', el('div', 'terminal-areas', row));
	assert.equal(revealDelayOf(span), 170);
	assert.equal(revealDelayOf(el('span')), 0);
});

t('watchReveal : le lead vaut pour la première fournée non vide, puis plus', async () => {
	const box = el('div', 'bootstrap-box');
	watchReveal(box);
	await Promise.resolve();            // microtask : boîte vide, rien tamponné
	const a = el('pre');
	box.appendChild(a);
	await Promise.resolve();            // sans MutationObserver ici : on rappelle reveal à la main
	reveal(box);                        // première impression → lead
	assert.equal(a.dataset.reveal, String(LEAD_MS));
});

// --- interpolateNumbers -----------------------------------------------------

t('interpolateNumbers : chaque entier roule vers sa valeur, le reste du texte est intact', () => {
	const s = '3 LOCAL AREAS\n42 SESSIONS\n412 MB';
	assert.equal(interpolateNumbers(s, 0), '0 LOCAL AREAS\n 0 SESSIONS\n  0 MB');
	assert.equal(interpolateNumbers(s, 1), s);
	assert.equal(interpolateNumbers(s, 0.5), '2 LOCAL AREAS\n21 SESSIONS\n206 MB');
});

t('interpolateNumbers : les décimales et la version ne bougent pas', () => {
	assert.equal(interpolateNumbers('FPVTP! // 0.97b', 0.3), 'FPVTP! // 0.97b');
	assert.equal(interpolateNumbers('1.8 GB', 0.5), '1.8 GB');
});

t('interpolateNumbers : la largeur est conservée pour ne pas faire sauter la ligne', () => {
	assert.equal(interpolateNumbers('412 MB', 0), '  0 MB');
	assert.equal(interpolateNumbers('42 SESSIONS', 0.1), ' 4 SESSIONS');
});

// --- exitScreen (#67) -------------------------------------------------------
//
// Le faux DOM n'a pas de matchMedia : c'est exactement le cas « aucun moteur
// d'animation derrière le marqueur », où la sortie doit être immédiate — sans
// quoi chaque enchaînement d'écrans coûterait 90 ms à tous les selftests de
// rendu. On stimule ensuite le cas navigateur en posant un faux matchMedia.

await at('exitScreen : sans matchMedia, la sortie est immédiate et ne marque rien', async () => {
	const el = document.createElement('div');
	await exitScreen(el);
	assert.equal(el.dataset.exit, undefined, 'rien à animer, donc rien à marquer');
});

await at('exitScreen : en navigateur, l\'écran est marqué puis la promesse rend la main', async () => {
	globalThis.matchMedia = () => ({ matches: false });
	try {
		const el = document.createElement('div');
		const p = exitScreen(el, { ms: 1 });
		assert.equal(el.dataset.exit, '1', 'l\'écran sortant n\'est pas marqué');
		await p;
	} finally { delete globalThis.matchMedia; }
});

await at('exitScreen : en mouvement réduit, immédiat — rien à regarder s\'éteindre', async () => {
	globalThis.matchMedia = () => ({ matches: true });
	try {
		const el = document.createElement('div');
		await exitScreen(el);
		assert.equal(el.dataset.exit, undefined);
	} finally { delete globalThis.matchMedia; }
});

t('EXIT_MS : la sortie est plus courte que l\'entrée — un écran s\'éteint plus vite', () => {
	assert.ok(EXIT_MS <= LEAD_MS, 'la sortie ne doit pas coûter plus que le noir d\'entrée');
});

console.log(`motion-selftest: ${n} ok`);
