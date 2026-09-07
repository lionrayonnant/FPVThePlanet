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
globalThis.fetch = async (url) => {
	if (String(url).includes('/__map-api/scenes')) {
		if (scenesReply === null) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ scenes: scenesReply, acquire: acquireReply }) };
	}
	// worldWeather : pas de bulletin, la ligne météo reste vide. C'est déjà le
	// comportement hors ligne, et l'écran doit tenir sans.
	return { ok: false, status: 503, json: async () => ({}) };
};

const { runTerminal, operatorKey, operatorKeyIssued } = await import('../src/terminal.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.root.replaceChildren(); dom.setActive(null); scenesReply = SCENES; acquireReply = false; };
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

// Un opérateur minimal : terminalModel() n'a besoin que de ça.
const operator = (over = {}) => ({
	name: 'neo', createdAt: '2026-09-01T10:00:00.000Z', sessions: [], ...over,
});
const api = (op) => ({ getOperator: () => op, patch: () => {}, flush: async () => {} });

// La Home résout une forme de vol ; on la ferme par MODE pour ne rien voler.
const close = async (p) => { btn('MODE').click(); return p; };

await ta('home : la carte, puis la seule chose qui décolle', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));   // fetchScenes()
	assert.ok(dom.root.querySelector('.terminal-map'), 'le cadre de la carte');
	assert.ok(btn('FLY — PARISTEST'), 'le CTA de vol, étiqueté par la zone');
	await close(p);
});

await ta('home : le froid est derrière ARCHIVE, pas sur la Home', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(btn('ARCHIVE'), 'l\'entrée ARCHIVE');
	// C'est tout l'objet du lot : la Home ne doit plus être un tableau de bord
	// (Bible §30). Ces cinq entrées existent toujours — un cran plus bas.
	for (const gone of ['SESSION LOG', 'TARGET LOG', 'OPERATOR', 'BUILD NOTES', 'CONTROL VECTOR']) {
		assert.equal(btn(gone), undefined, `« ${gone} » n'est plus sur la Home`);
	}
	// MODE et SETTINGS restent : ils ne sont ni un lieu ni un journal.
	assert.ok(btn('SETTINGS'), 'SETTINGS reste au pied');
	await close(p);
});

await ta('home : le curseur se pose sur FLY, pas sur une zone', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
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
	dom.root.querySelectorAll('.terminal-area').find((r) => r.dataset.slug === 'cnam').click();
	await new Promise((r) => setTimeout(r, 0));
	btn('FLY —').click();
	assert.deepEqual(await p, { slug: 'cnam', resume: undefined });
	assert.equal(dom.root.children.length, 0, 'rien ne reste dans #ui');
});

await ta('home : [ FLY ] part sur la zone de la dernière session', async () => {
	reset();
	const op = operator({ sessions: [{ id: 's1', area: 'cnam', result: 'LANDED', end: '2026-09-04T12:00:00.000Z' }] });
	const p = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await new Promise((r) => setTimeout(r, 0));
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
	const expected = terminalModel({ operator: op, scenes: SCENES }).footer;
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
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(btn('FLY —'), undefined, 'rien à voler');
	assert.ok(dom.root.querySelector('.terminal-map'), "la carte est là, c'est par elle qu'on part");
	assert.ok(text().includes('NO LOCAL TERRAIN'), 'et la colonne gauche le dit');
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

await ta('home : MODE n\'apparaît que si l\'on peut remonter', async () => {
	reset();
	// ?scene= saute le choix de mode : la Home y est encore la racine, et une
	// entrée MODE y mènerait à un écran dont on ne peut pas redescendre.
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: false });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(btn('MODE'), undefined, 'pas de MODE sans back');
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
	const carte = dom.root.querySelector('.terminal-map');
	const droite = dom.root.querySelector('.terminal-right');
	dom.root.querySelectorAll('.terminal-area').at(1).click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelector('.terminal-map'), carte, 'le MÊME nœud de carte');
	assert.equal(dom.root.querySelector('.terminal-right'), droite, 'la MÊME colonne');
	await close(p);
});

// --- issue #60 : ce que le droit d'acquérir change à l'écran ----------------

await ta('home : sans droit d\'acquérir, une ligne au pied — pas un bandeau', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const hints = dom.root.querySelectorAll('.terminal-foot-hint');
	assert.equal(hints.length, 1, 'une seule ligne');
	assert.match(hints[0].textContent, /DESKTOP CLIENT/);
	// Information, pas assistance : ni bouton, ni compte à rebours, ni promesse
	// de débloquer quoi que ce soit.
	assert.equal(hints[0].querySelectorAll('button').length, 0);
	assert.doesNotMatch(hints[0].textContent, /UNLOCK|FREE|NOW|UPGRADE/i);
	await close(p);
});

await ta('home : avec le droit d\'acquérir, pas de ligne du tout', async () => {
	reset();
	acquireReply = true;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelectorAll('.terminal-foot-hint').length, 0);
	await close(p);
});

// --- OPERATOR KEY -----------------------------------------------------------

const keyApi = (over = {}) => ({
	resumeWithKey: async () => { throw new Error('bad operator key'); }, ...over,
});

await ta('operator key : un champ et deux issues — aucune liste à choisir', async () => {
	reset();
	const p = operatorKey(dom.root, keyApi());
	assert.ok(dom.root.querySelector('input'), 'le champ de la clé');
	assert.ok(btn('RESUME'), '[ RESUME ]');
	assert.ok(btn('NEW OPERATOR'), '[ NEW OPERATOR ]');
	assert.match(text(), /THIS SERVER DOES NOT KNOW YOU/);
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

await ta('your operator key : la clé en clair, et la consigne de la noter', async () => {
	reset();
	const p = operatorKeyIssued(dom.root, 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE');
	assert.match(text(), /K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE/);
	assert.match(text(), /WILL NOT BE SHOWN AGAIN/);
	btn('CONTINUE').click();
	await p;
});

console.log(`\n${n} tests terminal-render OK`);
