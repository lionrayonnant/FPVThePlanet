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
