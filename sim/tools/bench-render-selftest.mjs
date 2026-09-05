// Selftest des ÉCRANS du banc (PHASE 26), monté sur le faux DOM de
// tools/lib/fake-dom.mjs. Même intention que ui-audio-render-selftest.mjs :
// ce qu'on vérifie est l'ARBRE et le CÂBLAGE — quels contrôles existent, ce
// qu'ils portent, et ce qui se passe quand on les actionne. L'apparence se
// juge à l'œil, pas ici.
//
// Lancer : node tools/bench-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

// Le faux DOM doit exister AVANT l'import des modules d'écran : menu-nav.js
// s'abonne à window au chargement, et terminal.js touche document.
const dom = installFakeDom();
const { selectOperationMode, runBench, loadBenchConfig, loadLastMode } = await import('../src/bench.js');
const { MODE_SELECT, BENCH_SEAL, BENCH_STORAGE_KEY, normalizeBenchConfig } = await import('./bench-model.mjs');
const { FAMILIES, PROFILES } = await import('../src/drone-profiles.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.storage.clear(); dom.root.replaceChildren(); dom.setActive(null); };

// Combien de minuteurs sont encore armés. Le flux RTC de la racine (issue #243)
// en pose un par tick, et un écran qui part sans appeler son stop() les laisse
// battre sur un nœud détaché. On compte en RELATIF (avant/après) : d'autres
// modules arment aussi des minuteurs, et ce n'est pas eux qu'on surveille.
const _live = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
	const id = _setTimeout((...a) => { _live.delete(id); return fn(...a); }, ms, ...rest);
	_live.add(id);
	return id;
};
globalThis.clearTimeout = (id) => { _live.delete(id); return _clearTimeout(id); };
const timersAlive = () => _live.size;

// Le bouton dont le libellé contient `label`. Les CTA sont rendus « [ X ] ».
const btn = (label) => dom.root.querySelectorAll('button').find((b) => b.textContent.includes(label));
const rowOf = (key) => dom.root.querySelector(`[data-bench-key="${key}"]`);
// La ligne complète (étiquette + contrôle + valeur) qui contient ce contrôle.
const lineOf = (key) => { let e = rowOf(key); while (e && !e.classList.contains('bench-row')) e = e.parent; return e; };

// ---------------------------------------------------------------------------
// SELECT OPERATION MODE

await ta('mode select : les deux voies, avec ce que chacune coûte', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	const text = dom.root.textContent;
	assert.ok(text.includes(MODE_SELECT.title), 'le titre');
	assert.ok(btn('FIELD'), 'la voie FIELD');
	assert.ok(btn('BENCH'), 'la voie BENCH');
	for (const m of ['field', 'bench']) {
		for (const l of MODE_SELECT[m].lines) assert.ok(text.includes(l), `« ${l} » est affichée`);
	}
	btn('FIELD').click();
	assert.equal(await p, 'field');
});

await ta('mode select : le curseur se pose sur le dernier mode utilisé', async () => {
	reset();
	// Un joueur FIELD ne doit payer qu'une touche par lancement, pas un choix.
	let p = selectOperationMode(dom.root, { last: 'field' });
	assert.ok(dom.active?.textContent.includes('FIELD'), `curseur sur FIELD, pas « ${dom.active?.textContent} »`);
	btn('FIELD').click();
	await p;

	reset();
	p = selectOperationMode(dom.root, { last: 'bench' });
	assert.ok(dom.active?.textContent.includes('BENCH'), `curseur sur BENCH, pas « ${dom.active?.textContent} »`);
	btn('BENCH').click();
	assert.equal(await p, 'bench');
});

await ta('mode select : le choix est retenu pour le lancement suivant', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	btn('BENCH').click();
	await p;
	assert.equal(loadLastMode(), 'bench');
});

await ta('mode select : l\'écran est démonté derrière lui', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	btn('FIELD').click();
	await p;
	assert.equal(dom.root.children.length, 0, 'rien ne reste dans #ui');
});

await ta('mode select : l\'identité est écrite au-dessus du choix', async () => {
	reset();
	// Bible §48 : « OPERATOR // NEO » puis SELECT OPERATION MODE. La racine dit
	// d'abord qui tu es. Elle reste montable sans opérateur (?scene= n'en charge
	// pas toujours un) : la ligne disparaît, l'écran ne casse pas.
	const p = selectOperationMode(dom.root, { last: 'field', operatorName: 'neo' });
	const who = dom.root.querySelector('.bench-operator');
	assert.ok(who, 'la ligne opérateur');
	assert.equal(who.textContent, 'OPERATOR // NEO', 'en capitales, comme la Home');
	btn('FIELD').click();
	await p;

	reset();
	const p2 = selectOperationMode(dom.root, { last: 'field' });
	assert.equal(dom.root.querySelector('.bench-operator'), null, 'pas de ligne vide sans opérateur');
	btn('FIELD').click();
	await p2;
});

await ta('mode select : deux colonnes, le RTC à droite des voies', async () => {
	reset();
	// Issue #243 : la racine est le SEUL écran qui porte encore un bloc RTC.
	// Le vérifier ici et pas seulement à l'œil, parce que le premier tick du
	// flux est différé de plusieurs secondes : un RTC qui n'aurait jamais été
	// monté passerait inaperçu au banc comme à l'écran pendant tout ce temps.
	const p = selectOperationMode(dom.root, { last: 'field' });
	const left = dom.root.querySelector('.terminal-left');
	const right = dom.root.querySelector('.terminal-right');
	assert.ok(left, 'la colonne des voies');
	assert.ok(right, 'la colonne du RTC');
	// Les voies sont à GAUCHE, le RTC à DROITE : c'est tout le propos de #243.
	assert.ok(left.querySelector('.bench-mode'), 'les voies sont dans la colonne gauche');
	assert.equal(right.querySelector('.bench-mode'), null, 'et pas dans celle de droite');
	assert.ok(right.querySelector('.sc-rtc'), 'le RTC est dans la colonne droite');
	btn('FIELD').click();
	assert.equal(await p, 'field');
});

await ta('mode select : le flux RTC est arrêté quand on choisit', async () => {
	reset();
	// Un minuteur qui survit à son écran rejoue un tick sur un nœud détaché à
	// chaque lancement suivant. `mount()` rend un stop() POUR ça, et pick() doit
	// l'appeler comme il appelle nav.detach().
	const before = timersAlive();
	const p = selectOperationMode(dom.root, { last: 'field' });
	assert.ok(timersAlive() > before, 'le flux a bien armé un minuteur');
	btn('FIELD').click();
	await p;
	assert.equal(timersAlive(), before, 'et il ne reste rien après le choix');
});

// ---------------------------------------------------------------------------
// L'écran du banc

const SCENES = [{ slug: 'paristest', name: 'paristest' }, { slug: 'tour-eiffel', name: 'Tour Eiffel' }];

await ta('banc : toutes les lignes sont montées et lisibles', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	for (const key of ['family', 'seed', 'terrain', 'entry', 'fence', 'time', 'wind', 'gust', 'dir', 'rain', 'fog', 'cloud', 'link', 'battery']) {
		assert.ok(rowOf(key), `la ligne ${key} existe`);
	}
	const text = dom.root.textContent;
	assert.ok(text.includes(BENCH_SEAL), 'le sceau est affiché');
	assert.ok(!/undefined|NaN|\[object/.test(text), `aucune fuite technique à l'écran :\n${text}`);
	btn('SPIN UP').click();
	await p;
});

await ta('banc : chaque ligne a sa conduite et sa colonne de valeur', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const rows = dom.root.querySelectorAll('.bench-row');
	assert.ok(rows.length >= 14, `au moins 14 lignes, vu ${rows.length}`);
	for (const r of rows) {
		const label = r.querySelectorAll('.bench-label');
		const lead = r.querySelectorAll('.bench-leader');
		const val = r.querySelectorAll('.bench-value');
		// Les quatre colonnes sont toujours là, même vides : c'est ce qui aligne
		// les valeurs d'un bout à l'autre. Une ligne qui saute sa valeur laisse
		// un trou, et l'œil perd la colonne.
		assert.equal(label.length, 1, `une étiquette sur « ${r.textContent} »`);
		assert.equal(lead.length, 1, `une conduite sur « ${r.textContent} »`);
		assert.equal(val.length, 1, `une valeur sur « ${r.textContent} »`);
	}
	btn('SPIN UP').click();
	await p;
});

await ta('banc : les trois curseurs de vent disent chacun ce qu\'ils règlent', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	// Le mock de la Bible §48 résume le vent sur une ligne, mais il y a trois
	// curseurs : chacun doit porter sa lecture, sinon on règle à l'aveugle.
	for (const key of ['wind', 'gust', 'dir']) {
		const v = lineOf(key).querySelector('.bench-value');
		assert.ok(v.textContent.trim().length, `la ligne ${key} affiche sa valeur`);
	}
	btn('SPIN UP').click();
	await p;
});

await ta('banc : le titre et le credo sont deux blocs distincts', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const title = dom.root.querySelector('.bench-title');
	const creed = dom.root.querySelector('.bench-creed');
	assert.ok(title && title.textContent.includes('BENCH'), 'le titre');
	// Séparés parce qu'ils ne parlent pas du même niveau : le credo n'est pas
	// une seconde ligne de titre, c'est ce que le banc dit de lui-même.
	assert.ok(creed, 'le credo a son propre bloc');
	for (const term of ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS']) {
		assert.ok(creed.textContent.includes(term), `le credo porte « ${term} »`);
	}
	assert.ok(!title.textContent.includes('NO TARGET'), 'le credo n\'est pas dans le titre');
	btn('SPIN UP').click();
	await p;
});

await ta('banc : le curseur se pose sur SPIN UP', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	// C'est ce qu'on vient chercher en rouvrant le banc sans rien changer.
	assert.equal(dom.active?.dataset.benchKey, 'spin');
	btn('SPIN UP').click();
	await p;
});

await ta('banc : changer une cellule met à jour l\'écran ET la config rendue', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const sel = rowOf('family');
	sel.value = 'race5';
	sel.onchange();
	assert.ok(lineOf('family').textContent.includes(PROFILES.race5.label), 'le libellé suit');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.airframe.family, 'race5');
});

await ta('banc : un curseur écrit une valeur, et la valeur se relit', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const wind = rowOf('wind');
	wind.value = '12';
	wind.oninput();
	assert.ok(lineOf('wind').textContent.includes('12.0 m/s'), `la ligne dit le vent — « ${lineOf('wind').textContent} »`);
	const time = rowOf('time');
	time.value = String(6 * 60 + 30);
	time.oninput();
	assert.ok(lineOf('time').textContent.includes('06:30'), `la ligne dit l'heure — « ${lineOf('time').textContent} »`);
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.weather.windSpeed, 12);
	assert.equal(cfg.timeMin, 390);
});

await ta('banc : le curseur survit au re-rendu déclenché par le réglage', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	rowOf('rain').focus();
	const before = dom.active.dataset.benchKey;
	rowOf('rain').value = '9';
	rowOf('rain').oninput();
	// Sans ce report, régler la pluie renverrait le curseur en haut de l'écran
	// à chaque cran — le banc deviendrait inutilisable au clavier.
	assert.equal(dom.active?.dataset.benchKey, before, 'le curseur est resté sur RAIN');
	btn('SPIN UP').click();
	await p;
});

await ta('banc : INDIVIDUAL tire une graine, ROLL en tire une autre', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	assert.equal(loadBenchConfig().airframe.seed, null, 'NOMINAL au départ');
	assert.ok(!rowOf('roll'), 'pas de ROLL tant qu\'on est en NOMINAL');
	const sel = rowOf('seed');
	sel.value = 'seeded';
	sel.onchange();
	const first = loadBenchConfig().airframe.seed;
	assert.ok(first, 'une graine a été tirée');
	assert.ok(rowOf('roll'), 'ROLL est apparu');
	rowOf('roll').click();
	assert.notEqual(loadBenchConfig().airframe.seed, first, 'ROLL en tire une autre');
	btn('SPIN UP').click();
	await p;
});

await ta('banc : la config persiste d\'une ouverture à l\'autre', async () => {
	reset();
	let p = runBench(dom.root, { scenes: SCENES });
	rowOf('cloud').value = '80';
	rowOf('cloud').oninput();
	const sel = rowOf('entry');
	sel.value = 'HOLY_SHIT';
	sel.onchange();
	btn('SPIN UP').click();
	await p;

	// Rouvert : on retrouve ce qu'on avait posé. Reposer douze réglages à
	// chaque lancement serait exactement la frustration que le banc supprime.
	p = runBench(dom.root, { scenes: SCENES });
	assert.equal(rowOf('cloud').value, '80');
	assert.equal(rowOf('entry').value, 'HOLY_SHIT');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.weather.cloudPct, 80);
	assert.equal(cfg.entry, 'HOLY_SHIT');
});

await ta('banc : rien de ce qui est écrit ne dit qu\'un vol a eu lieu', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	rowOf('wind').value = '7';
	rowOf('wind').oninput();
	btn('SPIN UP').click();
	await p;
	// L'invariant d'étanchéité, au niveau de ce qui touche réellement le disque.
	assert.deepEqual([...dom.storage.keys()].sort(), [BENCH_STORAGE_KEY].sort(),
		`le banc n'écrit que sa config — trouvé ${[...dom.storage.keys()]}`);
	const raw = dom.storage.get(BENCH_STORAGE_KEY);
	for (const forbidden of ['session', 'photo', 'randomart', 'result', 'landed', 'crashed']) {
		assert.ok(!raw.toLowerCase().includes(forbidden), `« ${forbidden} » n'a rien à faire là`);
	}
});

await ta('banc : BACK remonte sans rien voler', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	btn('BACK').click();
	assert.equal(await p, null);
	assert.equal(dom.root.children.length, 0, 'l\'écran est démonté');
});

await ta('banc : Échap remonte aussi', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	dom.key('Escape');
	assert.equal(await p, null);
});

// ---------------------------------------------------------------------------
// Sans terrain, et avec un terrain disparu

await ta('banc : cache vide → bascule sur le vol libre plutôt qu\'un refus', async () => {
	reset();
	const p = runBench(dom.root, { scenes: [] });
	// Le banc ne doit jamais s'ouvrir sur un mur : sans terrain sur disque, il
	// propose ce qui marche quand même.
	assert.equal(rowOf('terrain').value, 'live');
	assert.ok(rowOf('lat') && rowOf('lon'), 'les coordonnées sont éditables');
	assert.ok(!btn('SPIN UP').disabled, 'et on peut décoller');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.terrain.kind, 'live');
});

await ta('banc : un terrain disparu du disque est signalé, pas subi', async () => {
	reset();
	dom.storage.set(BENCH_STORAGE_KEY, JSON.stringify(normalizeBenchConfig({
		terrain: { kind: 'cached', slug: 'disparue' },
	})));
	const p = runBench(dom.root, { scenes: SCENES });
	// Le slug absent est remplacé par la première scène présente : on informe
	// sans bloquer, et surtout on n'ouvre pas sur un bouton mort.
	assert.equal(rowOf('terrain').value, `cached:${SCENES[0].slug}`);
	assert.ok(!btn('SPIN UP').disabled);
	btn('SPIN UP').click();
	await p;
});

await ta('banc : en vol libre, un ENTRY sans effet est annoncé à l\'écran', async () => {
	reset();
	const p = runBench(dom.root, { scenes: [] });   // cache vide → vol libre
	assert.equal(rowOf('terrain').value, 'live');
	const sel = rowOf('entry');
	sel.value = 'HOLY_SHIT';
	sel.onchange();
	// Sans cet avertissement, l'opérateur croirait tomber en HOLY SHIT et
	// partirait du sol sans jamais comprendre pourquoi.
	assert.match(dom.root.textContent, /IGNORED IN LIVE FLIGHT/);
	// Mais ça reste un avertissement : on décolle quand même.
	assert.ok(!btn('SPIN UP').disabled);
	sel.value = 'IDLE';
	sel.onchange();
	assert.ok(!/IGNORED IN LIVE FLIGHT/.test(dom.root.textContent), 'IDLE n\'a rien à annoncer');
	btn('SPIN UP').click();
	await p;
});

await ta('banc : FENCE OFF prévient que le terrain s\'arrête au bord', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const sel = rowOf('fence');
	sel.value = 'off';
	sel.onchange();
	assert.match(dom.root.textContent, /TERRAIN ENDS AT THE EDGE/,
		'la conséquence se lit AVANT le décollage, pas dans le vide');
	// Mais ça n'interdit rien : le banc informe, il ne verrouille pas.
	assert.ok(!btn('SPIN UP').disabled);
	btn('SPIN UP').click();
	await p;
});

// ---------------------------------------------------------------------------
// Le panneau en vol

await ta('panneau en vol : chaque changement part tout de suite', async () => {
	reset();
	const seen = [];
	const p = runBench(dom.root, { scenes: SCENES, live: true, onChange: (c) => seen.push(c) });
	rowOf('wind').value = '15';
	rowOf('wind').oninput();
	rowOf('cloud').value = '50';
	rowOf('cloud').oninput();
	assert.equal(seen.length, 2, 'deux changements, deux applications');
	assert.equal(seen[1].weather.windSpeed, 15);
	assert.equal(seen[1].weather.cloudPct, 50);
	btn('RESUME').click();
	await p;
});

await ta('panneau en vol : pas de terrain, et RESUME au lieu de SPIN UP', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	// Changer de terrain voudrait dire recharger la scène, donc quitter le vol.
	// Le montrer grisé serait pire que ne pas le montrer.
	assert.ok(!rowOf('terrain'), 'la ligne TERRAIN est absente');
	assert.ok(!btn('BACK'), 'et BACK aussi : on ne « remonte » pas depuis un vol');
	assert.ok(btn('RESUME'), 'le CTA reprend le vol');
	// La cellule, elle, reste réglable à chaud.
	assert.ok(rowOf('family'), 'la cellule reste réglable');
	btn('RESUME').click();
	await p;
});

await ta('panneau en vol : Échap reprend le vol, il n\'annule rien', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	rowOf('rain').value = '4';
	rowOf('rain').oninput();
	dom.key('Escape');
	const cfg = await p;
	// Tout a déjà été appliqué au fil de l'eau : Échap ne peut pas « annuler »,
	// et rendre null ferait perdre la config à l'appelant.
	assert.ok(cfg, 'une config est rendue');
	assert.equal(cfg.weather.rateMmH, 4);
});

await ta('panneau en vol : RESET BENCH repart des défauts et l\'applique', async () => {
	reset();
	const seen = [];
	let p = runBench(dom.root, { scenes: SCENES, live: true, onChange: (c) => seen.push(c) });
	rowOf('wind').value = '20';
	rowOf('wind').oninput();
	btn('RESET BENCH').click();
	assert.equal(seen.at(-1).weather.windSpeed, 0, 'le reset est appliqué, pas seulement affiché');
	btn('RESUME').click();
	await p;
});

// ---------------------------------------------------------------------------
// Robustesse

await ta('banc : une config corrompue sur disque n\'empêche pas d\'ouvrir', async () => {
	reset();
	dom.storage.set(BENCH_STORAGE_KEY, '{ ceci n\'est pas du json');
	const p = runBench(dom.root, { scenes: SCENES });
	assert.ok(rowOf('spin'), 'l\'écran est monté quand même');
	assert.ok(!btn('SPIN UP').disabled, 'et il décolle');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.ok(FAMILIES.includes(cfg.airframe.family));
});

dom.restore();
console.log(`\n${n} tests bench-render OK`);
