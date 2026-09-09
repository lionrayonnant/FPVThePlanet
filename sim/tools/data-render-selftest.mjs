// Selftest de rendu des écrans FROIDS — ceux que la Home carte-first a rangés
// derrière DATA (#208, renommé par #26). Même intention que
// terminal-render-selftest.mjs : on vérifie l'ARBRE et le CÂBLAGE, pas
// l'apparence.
//
// Ces trois écrans n'étaient pas testables avant : ils se construisaient en
// innerHTML, que fake-dom refuse. Les convertir en createElement était de toute
// façon nécessaire — c'est ce qui permet à BUILD NOTES d'avoir un retrait
// suspendu par ligne.
//
// Chacun des trois tests correspond à un défaut vu au rendu réel, en Chromium
// headless piloté en CDP, sur la branche phase-27-ui-rework.
//
// Lancer : node tools/data-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async (url) => {
	if (String(url).includes('/__map-api/scenes')) {
		return { ok: true, status: 200, json: async () => ({ scenes: [] }) };
	}
	return { ok: false, status: 503, json: async () => ({}) };
};

const { dataScreen } = await import('../src/terminal.js');
const { selectOperationMode } = await import('../src/bench.js');
const { runSessionLog } = await import('../src/session-log.js');

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
// `key` : la clé d'opérateur telle que le navigateur la garde (#60). Absente
// par défaut — c'est le cas d'un serveur `local`, où elle n'existe pas.
let storedKey = null;
const api = (op) => ({
	getOperator: () => op, patch: () => {}, flush: async () => {},
	hasKey: () => Boolean(storedKey), getKey: () => storedKey,
});

// Ouvre la racine, prend la voie DATA, puis monte l'écran comme le fait la
// boucle de main.js — DATA est au même niveau que FIELD et BENCH (D3), elle
// ne se traverse plus depuis un onglet de FIELD.
//
// Rend la promesse de DATA : il FAUT la dénouer en fin de test — un écran
// laissé ouvert garde ses abonnements, et le selftest passerait sans jamais
// rendre la main.
const openData = async (op, entry) => {
	reset();
	const mode = selectOperationMode(dom.root, { last: 'data' });
	btn('DATA').click();
	assert.equal(await mode, 'data', 'la racine mène bien à DATA');
	// Enveloppée : `await` sur une async qui RENDRAIT cette promesse la
	// déballerait, et attendrait un écran qui ne se referme jamais.
	const home = dataScreen(dom.root, { api: api(op), scenes: [] });
	await tick();
	btn(entry).click();
	await tick();
	return { home };
};

// Remonte de DEPTH écrans par Échap. Le dernier referme DATA lui-même : il
// n'y a plus de bouton MODE à cliquer (D4), Échap est la remontée partout.
// Fermer compte : menu-nav.js tient un setInterval de scrutation manette que
// seul detach() arrête — un écran laissé ouvert garde le processus en vie.
const DEPTH_SOUS_ECRAN = 2;   // l'écran lui-même, puis DATA
const closeAll = async (home, depth = DEPTH_SOUS_ECRAN) => {
	for (let i = 0; i < depth; i++) { dom.key('Escape'); await tick(); await tick(); }
	await home;
};

// --- la page DATA -----------------------------------------------------------

// Les neuf sections de la spec, dans l'ordre. C'est la seule chose que ce test
// fige de l'écran : ce qu'il MONTRE et dans quel ordre — un graphe se juge à
// l'œil, une section disparue ne se juge nulle part ailleurs qu'ici.
const SECTIONS = ['RHYTHM', 'LIFE', 'SPEED × ALTITUDE', 'HOW THEY DIED',
	'STICKS', 'FAMILIES', 'GEOGRAPHY', 'PROFILE', 'RECORDS'];

await ta('data : les neuf sections, dans l\'ordre, et RECORDS au bout', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	const page = dom.root.querySelector('.data-page');
	assert.ok(page, 'la page qui défile');
	const titles = page.querySelectorAll('.data-section').map((b) => b.children[0].textContent);
	assert.deepEqual(titles, SECTIONS);
	// RECORDS garde le journal brut et tout ce qui se lit plutôt que se dessine.
	for (const entry of ['SESSION LOG', 'LAST SESSION', 'OPERATOR', 'BUILD NOTES']) {
		assert.ok(btn(entry), `« ${entry} » est dans RECORDS`);
	}
	// D2 : le TARGET LOG a été absorbé par FAMILIES — il n'a plus d'entrée.
	assert.equal(btn('TARGET LOG'), undefined, 'le TARGET LOG a disparu du menu');
	// D6 : SETTINGS est monté à la racine ; le répéter ici ferait deux portes
	// pour un seul panneau.
	assert.equal(dom.root.querySelectorAll('button').find((b) => b.textContent === 'SETTINGS'), undefined);
	// D15 : Échap est nommé, et il dit où il mène.
	const keys = dom.root.querySelector('.terminal-keys');
	assert.ok(keys, 'la ligne des touches');
	assert.equal(keys.textContent, '[ESC] OPERATION MODE');
	await closeAll(p, 1);
});

await ta('data : sans piste, les sections qui en ont besoin disent NO TRACK', async () => {
	// Le critère d'acceptation de l'issue : jamais une erreur, jamais un trou
	// dans les graphes qui n'ont pas besoin d'une piste. Ici aucune route
	// `/tracks` ne répond — c'est l'état de toute build tant que #24 n'a pas
	// atterri, et c'est aussi celui d'un vol trop vieux pour être retenu (D3).
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick(); await tick();
	const page = dom.root.querySelector('.data-page');
	const sectionOf = (name) => page.querySelectorAll('.data-section')
		.find((b) => b.children[0].textContent === name);
	for (const name of ['HOW THEY DIED', 'STICKS', 'PROFILE']) {
		assert.match(sectionOf(name).textContent, /NO TRACK/, `${name} ne dit pas NO TRACK`);
	}
	// Et les cinq qui n'en ont pas besoin gardent leur relevé : les agrégats de
	// session suffisent, et ils ne sont jamais jetés.
	assert.match(sectionOf('RHYTHM').textContent, /SESSIONS PER WEEK/);
	assert.match(sectionOf('LIFE').textContent, /DURATION PER SESSION/);
	assert.doesNotMatch(sectionOf('RHYTHM').textContent, /NO TRACK/);
	await closeAll(p, 1);
});

await ta('data : FAMILIES a absorbé le TARGET LOG — une famille s\'ouvre sur ses cibles', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	const page = dom.root.querySelector('.data-page');
	const fam = () => page.querySelectorAll('.data-section').find((b) => b.children[0].textContent === 'FAMILIES');
	assert.doesNotMatch(fam().textContent, /TARGET 001/, 'fermée, la famille ne liste rien');
	const open = fam().querySelectorAll('button')[0];
	assert.ok(open, 'la famille rencontrée est un lien');
	open.click();
	await tick();
	assert.match(fam().textContent, /TARGET 001/, 'ouverte, elle liste la cible rencontrée');
	assert.match(fam().textContent, /PARISTEST/);
	// Un second clic referme : c'est un dépli, pas un écran de plus.
	fam().querySelectorAll('button')[0].click();
	await tick();
	assert.doesNotMatch(fam().textContent, /TARGET 001/);
	await closeAll(p, 1);
});

// --- ce que DATA remonte ----------------------------------------------------
//
// C'est le contrat que main.js:dataLoop() consomme (D3) : DATA résout
// VERS LE HAUT, en la forme que la boucle FIELD sait faire voler. Sans ce test,
// un REVISIT pouvait remonter un slug nu et la boucle décollait sur `undefined`.

// La zone doit être encore sur disque pour que REVISIT soit proposé : c'est le
// gate `model.areas.some(...)` de lastSessionScreen.
const INSTALLED = [{ slug: 'paristest', name: 'paristest', bytes: 109e6 }];

await ta('data : un REVISIT remonte { slug }, la forme que la boucle FIELD vole', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: INSTALLED });
	await tick();
	await tick();
	btn('LAST SESSION').click();
	await tick();
	btn('REVISIT AREA').click();
	// Un slug nu remonterait ici sans le normaliseur de done() : c'est ce que
	// rend lastSessionScreen, et ce n'est pas ce que la boucle attend.
	assert.deepEqual(await p, { slug: 'paristest' });
	assert.equal(dom.root.children.length, 0, 'et rien ne reste dans #ui');
});

await ta('data : Échap remonte null, pas undefined', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: INSTALLED });
	await tick();
	// `if (!pick) continue;` dans main.js : null et undefined y passeraient tous
	// les deux, mais la fonction promet une forme — elle la tient.
	dom.key('Escape');
	assert.equal(await p, null);
});

// --- OPERATOR ---------------------------------------------------------------

await ta('operator : le compteur de cibles vient des sessions, pas d\'une clé morte', async () => {
	// `op.targetLog` n'existe plus depuis PHASE 17 : le lire rendait toujours 0,
	// et l'écran contredisait le pied de la Home (« 9 TARGETS LOGGED ») et le
	// Target Log lui-même. Deux sessions, une seule avec cible.
	const { home } = await openData(operator({ sessions: [session(), session({ id: 'x', seq: 2, targetSeq: 0, target: null })] }), 'OPERATOR');
	const t = dom.root.textContent;
	assert.match(t, /OPERATOR \/\/ NEO/);
	assert.match(t, /SESSIONS\s+2/);
	assert.match(t, /TARGETS\s+1/, 'une seule des deux sessions a porté une cible');
	assert.doesNotMatch(t, /TARGETS\s+0/);
	await closeAll(home);
});

// La clé (#60) est un mécanisme TECHNIQUE, montré ici pour la même raison que le
// Control Vector l'est sur SON écran : parce qu'on peut vouloir la relire. Les
// deux ne se mélangent ni à l'écran ni dans le code (Bible §33) — c'est
// justement ce que ces deux tests fixent.
// La Home et DATA restent MONTÉES derrière (seulement `hidden`) : leur texte
// est dans dom.root. On ne lit donc que la boîte du dernier écran ouvert.
const topBox = () => { const b = dom.root.querySelectorAll('.terminal-box'); return b[b.length - 1]; };

await ta('operator : sans clé (serveur local), aucun SHOW KEY à l\'écran', async () => {
	storedKey = null;
	const { home } = await openData(operator(), 'OPERATOR');
	assert.equal(btn('SHOW KEY'), undefined);
	assert.doesNotMatch(topBox().textContent, /OPERATOR KEY/);
	await closeAll(home);
});

await ta('operator : avec une clé, elle est masquée jusqu\'à SHOW KEY', async () => {
	storedKey = 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE';
	const { home } = await openData(operator(), 'OPERATOR');
	assert.match(topBox().textContent, /OPERATOR KEY\s+•/, 'masquée au premier rendu');
	assert.doesNotMatch(topBox().textContent, /K7QP/);
	btn('SHOW KEY').click();
	await tick();
	assert.match(topBox().textContent, /K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE/);
	// La SEULE chose que le jeu dise jamais de la clé : l'inscription, elle, ne
	// fait rien noter à personne (amendement du 2026-09-07).
	assert.match(topBox().textContent, /THIS PROFILE LIVES IN THIS BROWSER/);
	// La clé n'a rien à voir avec le Control Vector, retiré du jeu (#33). On
	// garde l'assertion : elle verrouille que cet écran parle de la CLÉ et de
	// rien d'autre, et le mot ne doit pas revenir par une régression de copie.
	assert.doesNotMatch(topBox().textContent, /CONTROL VECTOR/);
	storedKey = null;
	await closeAll(home);
});

// --- BUILD NOTES ------------------------------------------------------------

await ta('build notes : une ligne de note = un élément, pour le retrait suspendu', async () => {
	// En un seul <pre>, une note trop longue se repliait en colonne 0 et se
	// lisait comme une entrée de premier niveau. Le retrait suspendu de
	// `.terminal-note` n'est possible que si chaque ligne est son propre nœud.
	const { home } = await openData(operator(), 'BUILD NOTES');
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
	const { home } = await openData(operator(), 'BUILD NOTES');
	assert.ok(btn('BACK'), 'un BACK');
	// `BUILD NOTES` est aussi le LIBELLÉ du lien dans RECORDS : on vise donc
	// `CURRENT BUILD`, que seul l'écran lui-même affiche.
	assert.match(dom.root.textContent, /CURRENT BUILD/);
	dom.key('Escape');
	await tick();
	assert.doesNotMatch(dom.root.textContent, /CURRENT BUILD/, 'Escape referme l\'écran');
	assert.match(dom.root.textContent, /SESSION LOG · LAST SESSION/, 'et rend la main à DATA');
	await closeAll(home, 1);   // l'Escape du test a déjà refermé BUILD NOTES
});

// --- SESSION LOG ------------------------------------------------------------

await ta('session log : Échap est nommé, comme sur tout écran qui l\'écoute', async () => {
	reset();
	const p = runSessionLog(dom.root, { operator: operator(), scenes: [] });
	await tick();
	assert.match(dom.root.textContent, /SESSION LOG/);
	assert.equal(dom.root.querySelector('.terminal-keys').textContent, '[ESC] BACK');
	btn('BACK').click();
	await p;
});

// Comme bench-render-selftest : on rend les globals avant de conclure. Sans ça
// les abonnements posés par menuNav sur le faux window gardent le processus en
// vie et le test « passe » sans jamais rendre la main.
dom.restore();
console.log(`\n${n} tests data-render OK`);
// Plus de `process.exit(0)` ici : menu-nav.js balaie désormais les navs dont
// l'écran a quitté le DOM (#210), donc plus aucune scrutation manette ne
// survit à cette suite et Node rend la main tout seul. Si ce fichier se
// remettait à pendre, c'est ce balayage qu'il faut regarder — pas rajouter la
// sortie forcée.
