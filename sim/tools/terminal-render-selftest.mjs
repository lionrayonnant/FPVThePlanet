// Selftest de l'ÉCRAN de la Home (Operator Terminal), monté sur le faux DOM de
// tools/lib/fake-dom.mjs. Même intention que bench-render-selftest.mjs : on
// vérifie l'ARBRE et le CÂBLAGE — ce que la Home montre, ce qu'elle cache, et ce
// qui se passe quand on l'actionne. L'apparence se juge à l'œil, pas ici.
//
// Ce selftest n'était pas possible avant PHASE 27 : la Home se construisait en
// innerHTML, que fake-dom refuse (« construis l'arbre avec createElement »).
//
// Lancer : node tools/terminal-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

// La Home interroge le cache terrain et la météo du monde. Ni l'un ni l'autre
// n'existe sans serveur de dev : on les remplace, pour tester l'écran et pas le
// réseau. `fetch` doit exister AVANT l'import de terminal.js.
const SCENES = [
	{ slug: 'paristest', name: 'paristest', bytes: 109e6, lat: 48.8499, lon: 2.3419,
		bbox: { south: 48.8483, west: 2.3385, north: 48.8516, east: 2.3453 } },
	{ slug: 'cnam', name: 'Conservatoire', bytes: 168e6, lat: 48.8668, lon: 2.3562,
		bbox: { south: 48.8641, west: 2.3521, north: 48.8694, east: 2.3602 } },
];
let scenesReply = SCENES;
// Le droit d'acquérir, tel que le serveur l'annonce (#60). Fermé par défaut :
// c'est l'état de toute build distribuée.
let acquireReply = false;
// Le MODE du serveur (V1) : 'local' | 'shared'. C'est lui, et non le droit
// d'acquérir, qui décide du pied et de l'avis de l'onglet LOCAL — une build
// distribuée a l'acquisition fermée et reste une installation locale.
let modeReply = 'local';
globalThis.fetch = async (url) => {
	if (String(url).includes('/__map-api/scenes')) {
		if (scenesReply === null) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ scenes: scenesReply, acquire: acquireReply, mode: modeReply }) };
	}
	// worldWeather : pas de bulletin, la ligne météo reste vide. C'est déjà le
	// comportement hors ligne, et l'écran doit tenir sans.
	return { ok: false, status: 503, json: async () => ({}) };
};

const { runTerminal, operatorKey } = await import('../src/terminal.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.root.replaceChildren(); dom.setActive(null); scenesReply = SCENES; acquireReply = false; modeReply = 'local'; };
// Le libellé exact d'abord (« MODE », « ARCHIVE »), puis le CTA entre crochets,
// et seulement ensuite un préfixe (« FLY — »). Un simple `includes` prenait la
// ligne d'une zone pour le pied de page : la météo hors ligne est seedée par
// jour, et « MODERATE WIND » contient « MODE » — le selftest bloquait certains
// jours, la ligne de zone cliquée ne résolvant jamais l'écran.
const btn = (label) => {
	const all = dom.root.querySelectorAll('button');
	return all.find((b) => b.textContent === label)
		?? all.find((b) => b.textContent === `[ ${label} ]`)
		?? all.find((b) => b.textContent.startsWith(label) || b.textContent.startsWith(`[ ${label}`));
};
const text = () => dom.root.textContent;
// L'onglet ouvert à l'entrée est LIVE (D2) : les tests qui parlent du cache
// terrain passent d'abord sur LOCAL, comme un opérateur qui a déjà acquis.
const openLocal = async () => {
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
};

// Un opérateur minimal : terminalModel() n'a besoin que de ça.
const operator = (over = {}) => ({
	name: 'neo', createdAt: '2026-09-01T10:00:00.000Z', sessions: [], ...over,
});
const api = (op) => ({ getOperator: () => op, patch: () => {}, flush: async () => {} });

// FIELD résout une forme de vol ; on la ferme par Échap pour ne rien voler.
// Il n'y a plus de bouton MODE (D4) : Échap EST la remontée, et D15 la nomme.
const close = async (p) => { dom.key('Escape'); return p; };

// --- D2 : LIVE d'abord ------------------------------------------------------
//
// CE TEST DOIT RESTER LE PREMIER : `lastTab` est une mémoire de chargement de
// page, partagée par tout ce fichier. C'est ici, et seulement ici, qu'on peut
// observer l'onglet ouvert à la PREMIÈRE entrée dans FIELD.
await ta('home : LIVE est le premier onglet, et l\'onglet ouvert', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const tabs = dom.root.querySelectorAll('.terminal-tab');
	assert.deepEqual(tabs.map((b) => b.textContent), ['LIVE', 'LOCAL'], 'LIVE en tête');
	assert.equal(tabs[0].dataset.on, 'true', 'et ouvert à l\'entrée');
	await close(p);
});

await ta('home : la carte, puis la seule chose qui décolle', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));   // fetchScenes()
	await openLocal();
	assert.ok(dom.root.querySelector('.terminal-map'), 'le cadre de la carte');
	assert.ok(btn('FLY — PARISTEST'), 'le CTA de vol, étiqueté par la zone');
	await close(p);
});

await ta('home : FIELD ne fait plus que voler', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	// D3/D4/D6 : ARCHIVE et SETTINGS sont montés à la racine, MODE a disparu.
	// FIELD ne garde que ce qui fait décoller (Bible §30).
	for (const gone of ['SESSION LOG', 'TARGET LOG', 'OPERATOR', 'BUILD NOTES',
		'CONTROL VECTOR', 'ARCHIVE', 'SETTINGS', 'MODE']) {
		assert.equal(btn(gone), undefined, `« ${gone} » n'est plus sur FIELD`);
	}
	await close(p);
});

await ta('home : la tête ne salue plus, et le pied ne compte plus', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	// D1 : l'opérateur est salué à la racine, une fois. FIELD est un poste de
	// travail, pas un tableau de bord.
	assert.doesNotMatch(text(), /OPERATOR/, 'ni dans la tête, ni au pied');
	for (const gone of ['LOCAL AREAS', 'TARGETS LOGGED', 'SESSIONS']) {
		assert.ok(!text().includes(gone), `« ${gone} » a quitté le pied`);
	}
	await close(p);
});

await ta('home : sur un serveur PARTAGÉ, LOCAL le DIT au lieu d\'être vide', async () => {
	reset();
	modeReply = 'shared';
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	// Éteint mais sélectionnable : l'état se lit AVANT le clic, et les zones
	// pré-installées par l'hébergeur restent atteignables.
	assert.equal(local.dataset.off, 'true', 'l\'onglet est éteint');
	local.click();
	await new Promise((r) => setTimeout(r, 0));
	const notice = dom.root.querySelector('.terminal-notice');
	assert.ok(notice, 'un bloc d\'avis en tête du corps LOCAL');
	assert.match(notice.textContent, /NOT AVAILABLE ON THIS SERVER/);
	assert.match(notice.textContent, /SWITCH TO THE LIVE TAB/);
	assert.match(notice.textContent, /INSTALL THE DESKTOP CLIENT/);
	// Absorbés par l'avis : ils ne doivent plus traîner ailleurs à l'écran.
	assert.ok(!text().includes('DESKTOP CLIENT AVAILABLE'));
	assert.ok(!text().includes('SWITCH TO LIVE TO FLY'));
	assert.equal(dom.root.querySelectorAll('.terminal-foot-hint').length, 0);
	await close(p);
});

await ta('home : sur une installation locale, LOCAL n\'a rien à annoncer', async () => {
	reset();
	acquireReply = true;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	assert.equal(local.dataset.off, undefined, 'l\'onglet est allumé');
	assert.equal(dom.root.querySelector('.terminal-notice'), null);
	await close(p);
});

await ta('home : installation locale sans acquisition — ni avis, ni onglet éteint', async () => {
	// V1 : le défaut de toute build distribuée. Elle n'acquiert pas, mais elle
	// n'est pas « ce serveur » : le client de bureau ne s'annonce pas à
	// lui-même qu'il faut installer le client de bureau.
	reset();
	scenesReply = [];
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	assert.equal(local.dataset.off, undefined, 'l\'onglet reste allumé');
	local.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelector('.terminal-notice'), null, 'aucun avis de serveur partagé');
	assert.ok(!text().includes('INSTALL THE DESKTOP CLIENT'));
	assert.ok(text().includes('NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY'), 'juste le disque vide');
	assert.ok(dom.root.querySelector('.terminal-foot').textContent.startsWith('LOCAL INSTALLATION'));
	await close(p);
});

// --- D15 : Échap est nommé --------------------------------------------------

await ta('home : Échap est écrit, et il dit où il mène', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const keys = dom.root.querySelector('.terminal-keys');
	assert.ok(keys, 'la ligne des touches');
	assert.equal(keys.textContent, '[ESC] OPERATION MODE');
	await close(p);
});

await ta('home : le curseur se pose sur FLY, pas sur une zone', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	// « Une seule touche pour voler » (issue #123). La carte n'est pas focusable,
	// donc rien ne doit s'intercaler entre l'ouverture et le décollage.
	assert.ok(dom.active?.textContent.includes('FLY —'), `curseur sur FLY, pas « ${dom.active?.textContent} »`);
	await close(p);
});

await ta('home : choisir une zone recadre et réétiquette, mais ne vole pas', async () => {
	reset();
	let resolved = false;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	p.then(() => { resolved = true; });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.ok(btn('FLY — PARISTEST'), 'au départ, la première zone');

	dom.root.querySelectorAll('.terminal-area').find((r) => r.dataset.slug === 'cnam').click();
	await new Promise((r) => setTimeout(r, 0));

	assert.ok(btn('FLY — CONSERVATOIRE'), 'le CTA suit la sélection');
	// Le point du lot 4 : un seul axe. La liste choisit, [ FLY ] décolle.
	assert.equal(resolved, false, 'sélectionner une zone ne fait pas voler');
	await close(p);
});

await ta('home : la zone volée est celle qui est sélectionnée', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	dom.root.querySelectorAll('.terminal-area').find((r) => r.dataset.slug === 'cnam').click();
	await new Promise((r) => setTimeout(r, 0));
	btn('FLY —').click();
	assert.deepEqual(await p, { slug: 'cnam' });
	assert.equal(dom.root.children.length, 0, 'rien ne reste dans #ui');
});

await ta('home : [ FLY ] part sur la zone de la dernière session', async () => {
	reset();
	const op = operator({ sessions: [{ id: 's1', area: 'cnam', result: 'CRASHED', end: '2026-09-04T12:00:00.000Z' }] });
	const p = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	// Revenir sur le même territoire est le geste courant (Bible §7) : il ne doit
	// pas coûter une sélection de plus.
	assert.ok(btn('FLY — CONSERVATOIRE'), 'la zone de la dernière session');
	await close(p);
});

await ta('home : le pied est exactement celui du modèle', async () => {
	reset();
	const op = operator();
	const p = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const { terminalModel } = await import('./terminal-model.mjs');
	const expected = terminalModel({ operator: op, scenes: SCENES, shared: false }).footer;
	const foot = dom.root.querySelector('.terminal-foot');
	// Les compteurs du pied sont le sceau de non-régression de BENCH et du vol
	// live : ils doivent rester mot pour mot ceux du modèle.
	assert.equal(foot.textContent, expected);
	await close(p);
});

await ta('home : sans terrain, la carte reste l\'entrée', async () => {
	// Depuis #211 il n'y a plus de CTA [ GLOBAL SCANNER ] : la carte du scanner
	// EST la colonne de droite, et on part en chercher en traçant dessus. La
	// colonne gauche doit donc le dire, sinon un opérateur neuf ne voit qu'un
	// écran vide à côté d'une carte.
	reset();
	scenesReply = [];
	acquireReply = true;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(btn('FLY —'), undefined, 'rien à voler');
	assert.ok(dom.root.querySelector('.terminal-map'), "la carte est là, c'est par elle qu'on part");
	assert.ok(text().includes('NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP'), 'et la colonne gauche le dit');
	assert.equal(btn('ALL TERRAIN…'), undefined, 'pas de ALL TERRAIN… sur une liste vide');
	await close(p);
});

await ta('home : cache injoignable — la Home monte quand même', async () => {
	reset();
	scenesReply = null;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(dom.root.querySelector('.terminal-right'), 'l\'écran tient');
	assert.ok(dom.root.querySelector('.terminal-foot'), 'le pied aussi');
	await close(p);
});

await ta('home : sans remontée possible, aucune touche n\'est annoncée', async () => {
	reset();
	// ?scene= saute le choix de mode : FIELD y est encore la racine, et
	// annoncer « [ESC] OPERATION MODE » y promettrait un écran qui n'existe pas.
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: false });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.equal(dom.root.querySelector('.terminal-keys'), null, 'pas de ligne de touches sans back');
	assert.equal(btn('MODE'), undefined, 'et toujours pas de MODE');
	btn('FLY —').click();
	await p;
});

// --- FIELD est un seul écran (#211) -----------------------------------------

await ta('home : deux colonnes, et la carte est dans celle de droite', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const left = dom.root.querySelector('.terminal-left');
	const right = dom.root.querySelector('.terminal-right');
	assert.ok(left, 'la colonne des menus');
	assert.ok(right, 'la colonne du monde');
	assert.ok(right.querySelector('.terminal-map'), 'la carte est à droite');
	assert.equal(left.querySelector('.terminal-map'), null, 'et pas à gauche');
	await close(p);
});

await ta('home : [ GLOBAL SCANNER ] a disparu — il n\'y a plus d\'ailleurs où aller', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.equal(btn('GLOBAL SCANNER'), undefined);
	assert.ok(btn('FLY —'), 'FLY reste la seule chose qui décolle');
	await close(p);
});

await ta('home : la carte SURVIT au re-rendu de la colonne gauche', async () => {
	// C'est la promesse centrale de l'écran. Si ce test tombe, la fusion n'a plus
	// d'intérêt : autant garder deux écrans. On compare la RÉFÉRENCE du nœud, pas
	// sa présence — un équivalent reconstruit serait un remontage de Leaflet.
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	const carte = dom.root.querySelector('.terminal-map');
	const droite = dom.root.querySelector('.terminal-right');
	dom.root.querySelectorAll('.terminal-area').at(1).click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelector('.terminal-map'), carte, 'le MÊME nœud de carte');
	assert.equal(dom.root.querySelector('.terminal-right'), droite, 'la MÊME colonne');
	await close(p);
});

// --- OPERATOR KEY -----------------------------------------------------------

const keyApi = (over = {}) => ({
	resumeWithKey: async () => { throw new Error('bad operator key'); }, ...over,
});

await ta('operator key : NEW OPERATOR d\'abord, la clé en secours — et rien à choisir', async () => {
	reset();
	const p = operatorKey(dom.root, keyApi());
	const buttons = dom.root.querySelectorAll('button');
	// L'ORDRE est le message : le cas nominal sur un serveur partagé, c'est
	// quelqu'un qui arrive et repart avec un profil.
	assert.equal(buttons[0].textContent, '[ NEW OPERATOR ]', 'le premier bouton de l\'écran');
	assert.ok(dom.root.querySelector('input'), 'le champ de la clé, plus bas');
	// RESUME n'est pas un CTA : entrer une clé est une porte de secours.
	assert.equal(btn('RESUME').className, 'terminal-link');
	assert.match(text(), /THIS SERVER DOES NOT KNOW THIS BROWSER/);
	btn('NEW OPERATOR').click();
	assert.deepEqual(await p, { create: true });
});

await ta('operator key : une clé valide rend l\'opérateur', async () => {
	reset();
	const seen = [];
	const p = operatorKey(dom.root, keyApi({
		resumeWithKey: async (k) => { seen.push(k); return { id: 'neo-1', name: 'Neo' }; },
	}));
	dom.root.querySelector('input').value = 'K7QP-3MZX';
	btn('RESUME').click();
	const r = await p;
	assert.deepEqual(seen, ['K7QP-3MZX']);
	assert.equal(r.operator.id, 'neo-1');
});

await ta('operator key : une clé refusée laisse l\'écran ouvert et le dit', async () => {
	reset();
	const p = operatorKey(dom.root, keyApi());
	dom.root.querySelector('input').value = 'FAUSSE';
	btn('RESUME').click();
	await new Promise((r) => setTimeout(r, 0));
	assert.match(text(), /UNKNOWN KEY/);
	assert.ok(dom.root.querySelector('input'), 'l\'écran est toujours là');
	btn('NEW OPERATOR').click();
	await p;
});

console.log(`\n${n} tests terminal-render OK`);
