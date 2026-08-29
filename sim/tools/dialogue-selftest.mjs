// Selftest du moteur de dialogue (PHASE 21). Aucune E/S, aucun DOM.
// Lancer : node tools/dialogue-selftest.mjs
import assert from 'node:assert/strict';
import {
	CREW, RARITY, EVENTS, SLOTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN,
	resolvePath, slotsUsed, pathsForSlots,
} from './dialogue/catalog.mjs';
import { render } from './dialogue/render.mjs';
import {
	rngFrom, emptyMemory, eligible, select, PAIR_COOLDOWN,
} from './dialogue/engine.mjs';
import { JENSEN_COOLDOWN as JC } from './dialogue/catalog.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('crew : trois voix humaines plus cron, et plus de vex', () => {
	assert.deepEqual(CREW, ['root', 'jensen', 'mikhail', 'cron']);
	assert.ok(!CREW.includes('vex'), 'vex a été retiré du canon (D7)');
});

t('rareté : les poids exacts de la spec', () => {
	assert.deepEqual(RARITY, { COMMON: 100, UNCOMMON: 30, RARE: 8, VERY_RARE: 2 });
});

t('constantes : plafond de jensen et tailles de mémoire', () => {
	assert.equal(JENSEN_COOLDOWN, 12);
	assert.equal(MEMORY_RING, 256);
	assert.equal(MEMORY_SEEN, 512);
});

t('événements : chacun a un shard, un poids de silence et des cadences', () => {
	const ids = Object.keys(EVENTS);
	assert.ok(ids.length >= 19, `catalogue complet attendu, ${ids.length} trouvés`);
	for (const [id, e] of Object.entries(EVENTS)) {
		assert.equal(id, id.toUpperCase(), `${id} : les ids d'événement sont en majuscules`);
		assert.match(e.shard, /^[a-z_]+$/, `${id} : nom de shard en minuscules`);
		assert.ok(e.silenceWeight >= 0, `${id} : poids de silence`);
		assert.ok(e.gapMs[0] > 0 && e.gapMs[1] > e.gapMs[0], `${id} : écart entre échanges`);
		assert.ok(e.beatMs[0] > 0 && e.beatMs[1] > e.beatMs[0], `${id} : battement entre répliques`);
	}
});

t('événements : les catégories câblées en v1 sont présentes', () => {
	for (const id of ['AREA_SEARCH', 'PROBE_AREA', 'ACQUIRE_AREA', 'TERRAIN_PROGRESS',
		'TARGET_SCAN', 'TARGET_SELECTED', 'TARGET_ANALYSIS', 'HACK', 'MANUAL_OVERRIDE',
		'JACK_IN', 'WEATHER']) {
		assert.ok(EVENTS[id], `événement câblé manquant : ${id}`);
	}
});

t('slots : chacun déclare un chemin et un formateur', () => {
	for (const [name, s] of Object.entries(SLOTS)) {
		assert.match(name, /^[a-z_]+$/, `slot ${name} : minuscules et souligné`);
		assert.match(s.path, /^[a-zA-Z0-9_.]+$/, `slot ${name} : chemin`);
		assert.equal(typeof s.format, 'function', `slot ${name} : formateur`);
	}
});

t('resolvePath : rend null sur absent, null, NaN et chaîne vide', () => {
	const ctx = { weather: { windMs: 6, gustMs: null, tempC: NaN }, area: { name: '' } };
	assert.equal(resolvePath(ctx, 'weather.windMs'), 6);
	assert.equal(resolvePath(ctx, 'weather.gustMs'), null);
	assert.equal(resolvePath(ctx, 'weather.tempC'), null);
	assert.equal(resolvePath(ctx, 'area.name'), null);
	assert.equal(resolvePath(ctx, 'target.rssiDbm'), null);
	assert.equal(resolvePath(ctx, 'nope.nested.deep'), null);
});

t('slotsUsed : extrait les slots des répliques, sans doublon', () => {
	const entry = { lines: [
		{ speaker: 'root', text: '{wind} meters per second in {location}.' },
		{ speaker: 'mikhail', text: 'not with the {drone_type}. {wind} is a lot.' },
	] };
	assert.deepEqual(slotsUsed(entry).sort(), ['drone_type', 'location', 'wind']);
});

t('pathsForSlots : traduit les noms de slots en chemins d\'état', () => {
	assert.deepEqual(pathsForSlots(['wind']), [SLOTS.wind.path]);
	assert.deepEqual(pathsForSlots(['nope']), []);
});

const ENTRY = { id: 'x/1', lines: [
	{ speaker: 'root', text: '{wind} meters per second in {location}.' },
	{ speaker: 'mikhail', text: 'not with the {drone_type}.' },
] };
const CTX = { weather: { windMs: 6.4 }, area: { name: 'tokyo' }, drone: { label: 'CINEWHOOP' } };

t('render : interpole et formate chaque slot', () => {
	assert.deepEqual(render(ENTRY, CTX), [
		{ speaker: 'root', text: '6 meters per second in TOKYO.' },
		{ speaker: 'mikhail', text: 'not with the cinewhoop.' },
	]);
});

t('render : texte sans slot rendu tel quel', () => {
	const plain = { id: 'x/2', lines: [{ speaker: 'mikhail', text: 'that is not the same thing' }] };
	assert.deepEqual(render(plain, {}), [{ speaker: 'mikhail', text: 'that is not the same thing' }]);
});

t('render : jette plutôt que d\'afficher un slot non résolu', () => {
	assert.throws(() => render(ENTRY, { area: { name: 'tokyo' } }), /wind/,
		'un contexte incomplet doit exploser en développement, jamais s\'afficher au joueur');
});

t('render : jette sur un slot inconnu du catalogue', () => {
	const bad = { id: 'x/3', lines: [{ speaker: 'root', text: 'hello {nonexistent}' }] };
	assert.throws(() => render(bad, {}), /nonexistent/);
});

// --- moteur de sélection ----------------------------------------------------

// Bassin synthétique : `n` entrées COMMON entre root et mikhail, plus ce qu'on
// lui ajoute. Aucune ne demande de contexte, pour isoler ce qu'on mesure.
const pool = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
	id: `t/${i}`, events: ['ACQUIRE_AREA'], rarity: 'COMMON',
	characters: ['root', 'mikhail'], requires: [],
	lines: [{ speaker: 'root', text: 'ok' }], ...over,
}));

const FULL = { weather: { windMs: 6 }, area: { name: 'tokyo' } };

t('eligible : un chemin manquant rend l\'entrée inéligible', () => {
	const e = { requires: ['weather.windMs', 'target.rssiDbm'] };
	assert.equal(eligible(e, FULL), false);
	assert.equal(eligible({ requires: ['weather.windMs'] }, FULL), true);
	assert.equal(eligible({ requires: [] }, {}), true);
	assert.equal(eligible({}, {}), true);
});

t('select : déterministe à graine et mémoire égales', () => {
	const p = pool(50);
	const a = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: emptyMemory(), rng: rngFrom('s') });
	const b = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: emptyMemory(), rng: rngFrom('s') });
	assert.equal(a.entry?.id, b.entry?.id);
});

t('select : aucune répétition à l\'intérieur de l\'anneau', () => {
	const p = pool(300, { rarity: 'COMMON' });
	let mem = emptyMemory();
	const rng = rngFrom('ring');
	const seen = [];
	for (let i = 0; i < 250; i++) {
		const r = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: mem, rng });
		mem = r.memory;
		if (r.entry) seen.push(r.entry.id);
	}
	assert.equal(new Set(seen).size, seen.length, 'un id est ressorti avant de quitter l\'anneau');
	assert.ok(seen.length > 100, `trop de silences : ${seen.length} répliques sur 250 tirages`);
});

t('select : jensen reste sous son plafond', () => {
	const p = [...pool(200), ...pool(200).map((e, i) => ({
		...e, id: `j/${i}`, characters: ['root', 'jensen'],
	}))];
	let mem = emptyMemory();
	const rng = rngFrom('jensen');
	const at = [];
	for (let i = 0; i < 1000; i++) {
		const r = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: mem, rng });
		mem = r.memory;
		if (r.entry?.characters.includes('jensen')) at.push(i);
	}
	for (let i = 1; i < at.length; i++) {
		assert.ok(at[i] - at[i - 1] >= JC, `jensen deux fois à ${at[i - 1]} et ${at[i]}, plafond ${JC}`);
	}
	assert.ok(at.length > 0, 'jensen ne doit pas être muet non plus');
});

t('select : la distribution suit les poids de rareté', () => {
	// Mémoire fraîche à chaque tirage : on isole les poids des refroidissements.
	const p = [...pool(20), ...pool(20).map((e, i) => ({ ...e, id: `r/${i}`, rarity: 'VERY_RARE' }))];
	const rng = rngFrom('rarity');
	let common = 0, rare = 0;
	for (let i = 0; i < 20000; i++) {
		const r = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: emptyMemory(), rng });
		if (!r.entry) continue;
		if (r.entry.rarity === 'COMMON') common++; else rare++;
	}
	const ratio = common / rare; // attendu ~50 (100 vs 2, effectifs égaux)
	assert.ok(ratio > 30 && ratio < 90, `rapport COMMON/VERY_RARE hors fourchette : ${ratio.toFixed(1)}`);
});

t('select : le silence est un résultat normal, pas une panne', () => {
	const rng = rngFrom('silence');
	let nulls = 0;
	for (let i = 0; i < 2000; i++) {
		const r = select({ event: 'ACQUIRE_AREA', pool: pool(20), ctx: {}, memory: emptyMemory(), rng });
		if (!r.entry) nulls++;
	}
	assert.ok(nulls > 0, 'le silenceWeight de ACQUIRE_AREA doit produire des silences');
	assert.ok(nulls < 2000, 'mais pas que des silences');
});

t('select : bassin vide ou entièrement inéligible → null, jamais d\'exception', () => {
	const r1 = select({ event: 'ACQUIRE_AREA', pool: [], ctx: {}, memory: emptyMemory(), rng: rngFrom('a') });
	assert.equal(r1.entry, null);
	const hard = pool(10, { requires: ['target.rssiDbm'] });
	const r2 = select({ event: 'ACQUIRE_AREA', pool: hard, ctx: {}, memory: emptyMemory(), rng: rngFrom('b') });
	assert.equal(r2.entry, null);
	const r3 = select({ event: 'NOT_AN_EVENT', pool: pool(10), ctx: {}, memory: emptyMemory(), rng: rngFrom('c') });
	assert.equal(r3.entry, null);
});

t('select : un silence ne consomme pas l\'anneau', () => {
	// Un bassin entièrement inéligible ne peut produire que des silences ; si
	// l'anneau grossissait quand même, il finirait par tout exclure pour rien.
	let mem = emptyMemory();
	const rng = rngFrom('d');
	for (let i = 0; i < 50; i++) {
		mem = select({ event: 'ACQUIRE_AREA', pool: pool(5, { requires: ['nope.nope'] }), ctx: {}, memory: mem, rng }).memory;
	}
	assert.equal(mem.ring.length, 0);
	assert.equal(mem.seq, 50, 'le compteur avance quand même : les refroidissements sont en tirages, pas en répliques');
});

t('select : la mémoire reçue n\'est jamais mutée', () => {
	const mem = emptyMemory();
	const before = JSON.stringify(mem);
	select({ event: 'ACQUIRE_AREA', pool: pool(20), ctx: {}, memory: mem, rng: rngFrom('e') });
	assert.equal(JSON.stringify(mem), before);
});

t('select : l\'anneau et la liste des vus restent bornés', () => {
	const p = pool(2000);
	let mem = emptyMemory();
	const rng = rngFrom('bound');
	for (let i = 0; i < 1500; i++) {
		mem = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: mem, rng }).memory;
	}
	assert.ok(mem.ring.length <= 256, `anneau non borné : ${mem.ring.length}`);
	assert.ok(Object.keys(mem.seen).length <= 512, `vus non bornés : ${Object.keys(mem.seen).length}`);
});

t('PAIR_COOLDOWN : la même paire ne monopolise pas la conversation', () => {
	// Deux paires disponibles, la première bien plus nombreuse : sans pénalité de
	// paire elle raflerait presque tout. On vérifie que l'autre respire.
	const p = [
		...pool(100),
		...pool(10).map((e, i) => ({ ...e, id: `m/${i}`, characters: ['mikhail', 'cron'] })),
	];
	let mem = emptyMemory();
	const rng = rngFrom('pair');
	let other = 0, total = 0;
	for (let i = 0; i < 600; i++) {
		const r = select({ event: 'ACQUIRE_AREA', pool: p, ctx: {}, memory: mem, rng });
		mem = r.memory;
		if (!r.entry) continue;
		total++;
		if (r.entry.characters.includes('cron')) other++;
	}
	assert.ok(other / total > 0.02, `la paire minoritaire est étouffée : ${other}/${total}`);
	assert.ok(PAIR_COOLDOWN >= 2);
});

console.log(`\n${n} vérifications, tout passe.`);
