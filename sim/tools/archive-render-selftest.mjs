// Selftest de rendu des écrans FROIDS — ceux que la Home carte-first a rangés
// derrière ARCHIVE (#208). Même intention que terminal-render-selftest.mjs : on
// vérifie l'ARBRE et le CÂBLAGE, pas l'apparence.
//
// Ces trois écrans n'étaient pas testables avant : ils se construisaient en
// innerHTML, que fake-dom refuse. Les convertir en createElement était de toute
// façon nécessaire — c'est ce qui permet à BUILD NOTES d'avoir un retrait
// suspendu par ligne et au TARGET LOG de séparer son titre de sa table.
//
// Chacun des trois tests correspond à un défaut vu au rendu réel, en Chromium
// headless piloté en CDP, sur la branche phase-27-ui-rework.
//
// Lancer : node tools/archive-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async (url) => {
	if (String(url).includes('/__map-api/scenes')) {
		return { ok: true, status: 200, json: async () => ({ scenes: [] }) };
	}
	return { ok: false, status: 503, json: async () => ({}) };
};

const { runTerminal } = await import('../src/terminal.js');
const { runTargetLog } = await import('../src/session-log.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };
const btn = (label) => dom.root.querySelectorAll('button').find((b) => b.textContent.includes(label));
const tick = () => new Promise((r) => setTimeout(r, 0));

// Une session qui a porté une cible : c'est d'elle que le Target Log est
// dérivé (PHASE 17, spec D1) — il n'y a pas de stock `targetLog`.
const session = (over = {}) => ({
	id: 'paristest-0001', area: 'paristest', seq: 1, targetSeq: 1,
	target: { family: 'heavy5', rssiDbm: -56, mode: 'ANALOG' },
	start: '2026-09-04T18:00:00.000Z', end: '2026-09-04T18:07:00.000Z',
	result: 'CRASHED', photos: [], ...over,
});
const operator = (over = {}) => ({
	name: 'neo', createdAt: '2026-09-01T10:00:00.000Z', sessions: [session()], ...over,
});
const api = (op) => ({ getOperator: () => op, patch: () => {}, flush: async () => {} });

// Ouvre la Home, entre dans ARCHIVE, clique une entrée. Rend une promesse de
// vol qu'on ne dénoue jamais : on ne veut que l'arbre.
// Ouvre la Home, entre dans ARCHIVE, clique une entrée. Rend la promesse de la
// Home : il FAUT la dénouer en fin de test — un écran laissé ouvert garde ses
// abonnements, et le selftest passerait sans jamais rendre la main.
const openArchive = async (op, entry) => {
	reset();
	const home = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await tick();
	btn('ARCHIVE').click();
	await tick();
	btn(entry).click();
	await tick();
	// Enveloppée : `await` sur une async qui RENDRAIT la promesse de la Home la
	// déballerait, et attendrait une Home qui ne se referme jamais — interblocage
	// silencieux, le test ne s'affiche même pas.
	return { home };
};

// Remonte de DEPTH écrans, puis referme la Home par MODE, qui ne vole rien.
// Profondeur fixe et non « jusqu'à voir MODE » : la Home reste MONTÉE derrière
// ARCHIVE (seulement `hidden`), donc son bouton MODE est trouvable depuis
// n'importe quel sous-écran et une boucle de ce genre ne remonterait jamais.
// Fermer compte : menu-nav.js tient un setInterval de scrutation manette que
// seul detach() arrête — un écran laissé ouvert garde le processus en vie.
const DEPTH_SOUS_ECRAN = 2;   // l'écran lui-même, puis ARCHIVE
const closeAll = async (home, depth = DEPTH_SOUS_ECRAN) => {
	for (let i = 0; i < depth; i++) { dom.key('Escape'); await tick(); await tick(); }
	btn('MODE').click();
	await home;
};

// --- OPERATOR ---------------------------------------------------------------

await ta('operator : le compteur de cibles vient des sessions, pas d\'une clé morte', async () => {
	// `op.targetLog` n'existe plus depuis PHASE 17 : le lire rendait toujours 0,
	// et l'écran contredisait le pied de la Home (« 9 TARGETS LOGGED ») et le
	// Target Log lui-même. Deux sessions, une seule avec cible.
	const { home } = await openArchive(operator({ sessions: [session(), session({ id: 'x', seq: 2, targetSeq: 0, target: null })] }), 'OPERATOR');
	const t = dom.root.textContent;
	assert.match(t, /OPERATOR \/\/ NEO/);
	assert.match(t, /SESSIONS\s+2/);
	assert.match(t, /TARGETS\s+1/, 'une seule des deux sessions a porté une cible');
	assert.doesNotMatch(t, /TARGETS\s+0/);
	await closeAll(home);
});

// --- BUILD NOTES ------------------------------------------------------------

await ta('build notes : une ligne de note = un élément, pour le retrait suspendu', async () => {
	// En un seul <pre>, une note trop longue se repliait en colonne 0 et se
	// lisait comme une entrée de premier niveau. Le retrait suspendu de
	// `.terminal-note` n'est possible que si chaque ligne est son propre nœud.
	const { home } = await openArchive(operator(), 'BUILD NOTES');
	assert.match(dom.root.textContent, /BUILD NOTES/);
	const notes = dom.root.querySelectorAll('.terminal-note');
	assert.ok(notes.length > 0, 'au moins une ligne de note portée par son propre élément');
	// Aucune ligne ne doit transporter son retrait en espaces littéraux : ils ne
	// survivent pas au repli, c'est exactement le défaut qu'on corrige.
	for (const p of notes) assert.doesNotMatch(p.textContent, /^ /, 'retrait en CSS, pas en espaces');
	assert.ok(dom.root.querySelectorAll('.terminal-note-block').length > 0, 'les notes sont groupées par version');
	await closeAll(home);
});

await ta('build notes : [ BACK ] existe ET Escape en sort', async () => {
	// Seul écran de la maison qui n'appelait pas menuNav : sans curseur ni
	// clavier, et sur une liste assez longue pour passer sous la ligne de
	// flottaison, son unique BACK était hors de vue. L'écran se refermait sur
	// l'opérateur.
	const { home } = await openArchive(operator(), 'BUILD NOTES');
	assert.ok(btn('BACK'), 'un BACK');
	// `BUILD NOTES` est aussi le LIBELLÉ du lien dans ARCHIVE : on vise donc
	// `CURRENT BUILD`, que seul l'écran lui-même affiche.
	assert.match(dom.root.textContent, /CURRENT BUILD/);
	dom.key('Escape');
	await tick();
	assert.doesNotMatch(dom.root.textContent, /CURRENT BUILD/, 'Escape referme l\'écran');
	assert.match(dom.root.textContent, /LAST SESSION · SESSION LOG/, 'et rend la main à ARCHIVE');
	await closeAll(home, 1);   // l'Escape du test a déjà refermé BUILD NOTES
});

// --- TARGET LOG -------------------------------------------------------------

await ta('target log : le titre parle en DISPLAY, la table est de la donnée', async () => {
	// 97 colonnes au niveau DISPLAY ne tiennent dans aucune boîte raisonnable :
	// chaque entrée se repliait sur trois lignes et la table cessait d'en être
	// une. Le titre et le credo restent la machine qui parle ; la table descend.
	reset();
	const p = runTargetLog(dom.root, { operator: operator() });
	await tick();
	const table = dom.root.querySelector('.terminal-log');
	assert.ok(table, 'la table porte sa propre classe');
	assert.match(table.textContent, /TARGET 001/);
	assert.match(table.textContent, /PARISTEST/);
	assert.doesNotMatch(table.textContent, /TARGET LOG/, 'le titre n\'est pas dans la table');
	assert.match(dom.root.textContent, /TARGET LOG/, 'mais il est bien à l\'écran');
	assert.match(dom.root.textContent, /A TARGET IS A TRACE/);
	// On REFERME (#210) : un écran laissé monté garde son nav, sa scrutation
	// manette et son écouteur clavier, et Node ne rend jamais la main. Le
	// `reset()` du test suivant le retire du DOM, ce que menu-nav.js balaie
	// désormais tout seul — mais compter là-dessus pour le DERNIER écran de la
	// suite reviendrait à laisser le processus dépendre d'un ramassage.
	btn('BACK').click();
	await p;
});

await ta('target log : rien qui remette un drone en vol (#54)', async () => {
	reset();
	const p = runTargetLog(dom.root, { operator: operator() });
	await tick();
	const labels = dom.root.querySelectorAll('button').map((b) => b.textContent);
	assert.deepEqual(labels, ['[ BACK ]'], 'un seul bouton, et il ne vole pas');
	btn('BACK').click();
	await p;
});

await ta('target log : la dernière cible se dessine, et une entrée sans graine n\'en dessine pas', async () => {
	// « Aucune migration » (#264) : `family` et `buildSeed` sont persistés en
	// clair sur la session depuis PHASE 07, donc tout l'historique déjà
	// journalisé sait montrer sa machine. Une entrée qui n'a pas la graine — un
	// chemin dev, un override NOMINAL — ne doit ni lever, ni laisser un cadre
	// vide tenir la place.
	reset();
	const sans = runTargetLog(dom.root, { operator: operator() });
	await tick();
	assert.equal(dom.root.querySelectorAll('svg').length, 0, 'sans graine, aucun portrait');
	btn('BACK').click();
	await sans;

	reset();
	const avec = session({ target: { family: 'race5', buildSeed: 'scan-7::2' } });
	const p = runTargetLog(dom.root, { operator: operator({ sessions: [avec] }) });
	await tick();
	const svg = dom.root.querySelector('svg');
	assert.ok(svg, 'la dernière cible se dessine');
	assert.ok(svg.querySelectorAll('line').length > 60, 'trop peu de traits');
	assert.match(dom.root.textContent, /LAST TARGET/, 'et le dessin dit de quelle cible il parle');
	btn('BACK').click();
	await p;
});

// Comme bench-render-selftest : on rend les globals avant de conclure. Sans ça
// les abonnements posés par menuNav sur le faux window gardent le processus en
// vie et le test « passe » sans jamais rendre la main.
dom.restore();
console.log(`\n${n} tests archive-render OK`);
// Plus de `process.exit(0)` ici : menu-nav.js balaie désormais les navs dont
// l'écran a quitté le DOM (#210), donc plus aucune scrutation manette ne
// survit à cette suite et Node rend la main tout seul. Si ce fichier se
// remettait à pendre, c'est ce balayage qu'il faut regarder — pas rajouter la
// sortie forcée.
