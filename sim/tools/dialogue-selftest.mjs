// Selftest du moteur de dialogue (PHASE 21). Aucune E/S, aucun DOM.
// Lancer : node tools/dialogue-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readFileSync as rf } from 'node:fs';
import {
	CREW, RARITY, EVENTS, SLOTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN,
	resolvePath, slotsUsed, pathsForSlots,
} from './dialogue/catalog.mjs';
import { pickInRange, nextGapMs, planExchange } from './dialogue/cadence.mjs';
import { FALLBACK } from '../src/dialogue-fallback.js';
import { render } from './dialogue/render.mjs';
import {
	rngFrom, emptyMemory, eligible, select, PAIR_COOLDOWN,
} from './dialogue/engine.mjs';
import { JENSEN_COOLDOWN as JC } from './dialogue/catalog.mjs';
import {
	args as genArgs, resolveBackend, parseEntries, BACKENDS, DEFAULT_BACKEND, DEFAULT_MODEL, DEFAULT_OLLAMA_HOST,
	nextSeq,
} from './dialogue/generate.mjs';
import { validateEntry, validateCorpus, STYLE_BANS, KNOWN_PATHS, SIGNATURE_PHRASES } from './dialogue/validate.mjs';
import { normalize, trigrams, jaccard, findDuplicates, findRepeatedLines, MIN_REPEATED_LINE_WORDS, seenLineSet, addLinesToSeen, repeatedLineIn } from './dialogue/dedupe.mjs';
import { RARITY_GUIDANCE } from './dialogue/generate.mjs';

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

// --- validation -----------------------------------------------------------------

const GOOD = {
	id: 'acquire_area/0001',
	events: ['ACQUIRE_AREA'],
	rarity: 'COMMON',
	characters: ['root', 'mikhail'],
	requires: ['weather.windMs'],
	lines: [
		{ speaker: 'root', text: '{wind} meters per second.' },
		{ speaker: 'mikhail', text: 'not with that airframe.' },
	],
};

t('validateEntry : une bonne entrée ne remonte aucun problème', () => {
	assert.deepEqual(validateEntry(GOOD), []);
});

t('validateEntry : un slot utilisé dont le chemin manque à requires est refusé', () => {
	// C'est LA règle qui rend un placeholder cassé impossible (D3).
	const bad = { ...GOOD, requires: [] };
	const problems = validateEntry(bad);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /weather\.windMs/);
});

t('validateEntry : slot inconnu du catalogue', () => {
	const bad = { ...GOOD, lines: [{ speaker: 'root', text: 'hello {banana}' }] };
	assert.ok(validateEntry(bad).some((p) => /banana/.test(p)));
});

t('validateEntry : requires vers un chemin inconnu (faute de frappe qui rendrait l\'entrée morte)', () => {
	const bad = { ...GOOD, requires: ['weather.windMS'] };
	assert.ok(validateEntry(bad).some((p) => /windMS/.test(p)));
});

t('validateEntry : locuteur hors crew, y compris vex', () => {
	assert.ok(validateEntry({ ...GOOD, characters: ['root', 'vex'],
		lines: [{ speaker: 'vex', text: 'obviously' }] }).some((p) => /vex/.test(p)));
});

t('validateEntry : un locuteur de réplique doit figurer dans characters', () => {
	const bad = { ...GOOD, lines: [{ speaker: 'cron', text: 'ok' }] };
	assert.ok(validateEntry(bad).some((p) => /cron/.test(p)));
});

t('validateEntry : phrase signature dans la bouche de son propriétaire passe', () => {
	const ok = { ...GOOD, characters: ['jensen'], requires: [],
		lines: [{ speaker: 'jensen', text: 'no comment' }] };
	assert.deepEqual(validateEntry(ok), []);
});

t('validateEntry : phrase signature volée à un autre locuteur est un problème nommé', () => {
	assert.equal(SIGNATURE_PHRASES['no comment'], 'jensen');
	const bad = { ...GOOD, characters: ['root'], requires: [],
		lines: [{ speaker: 'root', text: 'no comment' }] };
	const problems = validateEntry(bad);
	assert.ok(problems.some((p) => /no comment/.test(p) && /jensen/.test(p) && /root/.test(p)),
		'doit nommer la phrase, son propriétaire et le mauvais locuteur');
});

t('validateEntry : événement et rareté inconnus', () => {
	assert.ok(validateEntry({ ...GOOD, events: ['NOPE'] }).some((p) => /NOPE/.test(p)));
	assert.ok(validateEntry({ ...GOOD, rarity: 'SOMETIMES' }).some((p) => /SOMETIMES/.test(p)));
});

t('validateEntry : réplique vide, trop longue, ou échange trop long', () => {
	assert.ok(validateEntry({ ...GOOD, lines: [{ speaker: 'root', text: '  ' }] }).length > 0);
	assert.ok(validateEntry({ ...GOOD, lines: [{ speaker: 'root', text: 'x'.repeat(120) }] }).length > 0);
	const long = { ...GOOD, lines: Array.from({ length: 9 }, () => ({ speaker: 'root', text: 'ok' })) };
	assert.ok(validateEntry(long).length > 0);
});

t('style : les interdits de la Bible sont attrapés', () => {
	const cases = [
		'the player should know',      // adresse au joueur
		'this is just a game',         // quatrième mur
		'let me prompt the LLM',       // vocabulaire IA moderne
		'to be continued',             // promesse de suite
		'you will see, later',         // promesse de suite
	];
	for (const text of cases) {
		const bad = { ...GOOD, requires: [], lines: [{ speaker: 'root', text }] };
		assert.ok(validateEntry(bad).length > 0, `non attrapé : "${text}"`);
	}
	assert.ok(STYLE_BANS.length >= 5);
	for (const b of STYLE_BANS) assert.ok(b.why && b.re instanceof RegExp);
});

t('style : "the player should know" est attrapé par la règle adresse au joueur, pas par vocabulaire', () => {
	// Confirmation que le déplacement de la règle du jeu fonctionne :
	// bans[0] attrape l'adresse directe, donc pas besoin d'une règle sur /\bplayer\b/ seul.
	const bad = { ...GOOD, requires: [], lines: [{ speaker: 'root', text: 'the player should know' }] };
	const problems = validateEntry(bad);
	assert.ok(problems.some((p) => /adresse au joueur/.test(p)), 'doit être attrapé par bans[0]');
});

t('style : le vocabulaire de jeu spécifique 1998-2003 est attrapé', () => {
	// La nouvelle règle bans[5] cible le vocabulaire impossible en 1998-2003,
	// pas les mots courants qui peuvent avoir d'autres sens (« player »).
	const gamingTerms = [
		'respawn the node',       // respawn
		'the NPC will wait',      // NPC
		'get that power-up',      // power-up
		'level up your skills',   // level up
		'high score achievement', // high score
		'improved gameplay loop', // gameplay
	];
	for (const text of gamingTerms) {
		const bad = { ...GOOD, requires: [], lines: [{ speaker: 'root', text }] };
		assert.ok(validateEntry(bad).length > 0, `doit être attrapé : "${text}"`);
	}
});

t('style : les usages légitimes du mot "player" ne sont pas rejetés', () => {
	// Regression test : la règle remplacée /\bplayer\b/i rejetait aussi « record player »,
	// « media player », « key player », etc. La nouvelle règle ne le fait pas.
	const legitimate = [
		'the record player still works',
		'a key player in the network',
		'media player on the workstation',
	];
	for (const text of legitimate) {
		const good = { ...GOOD, requires: [], lines: [{ speaker: 'root', text }] };
		const problems = validateEntry(good);
		assert.ok(!problems.some((p) => /vocabulaire de jeu vidéo/.test(p)),
			`faux positif non-fondé : "${text}"`);
	}
});

t('KNOWN_PATHS : dérivé du catalogue, pas une seconde liste à maintenir', () => {
	assert.ok(KNOWN_PATHS.has('weather.windMs'));
	assert.ok(!KNOWN_PATHS.has('weather.windMS'));
});

t('validateCorpus : compte les bonnes et rejette les ids en double', () => {
	const r = validateCorpus([GOOD, { ...GOOD, id: 'acquire_area/0002' }]);
	assert.equal(r.ok, 2);
	assert.equal(r.errors.length, 0);
	const dup = validateCorpus([GOOD, GOOD]);
	assert.ok(dup.errors.some((e) => /double/i.test(e.problem)));
});

t('validateEntry : une réplique qui n\'est qu\'un label de locuteur est rejetée', () => {
	// Cas mesuré : acquire_area/0651, text: "root:" — le modèle a émis un
	// label de speaker comme si c'était la réplique elle-même.
	const bad = { ...GOOD, requires: [], lines: [{ speaker: 'root', text: 'root:' }] };
	const problems = validateEntry(bad);
	assert.ok(problems.some((p) => /label de locuteur/.test(p)), 'doit être attrapé');
});

t('validateEntry : un nom de crew seul, sans ":", est aussi rejeté', () => {
	const bad = { ...GOOD, requires: [], lines: [{ speaker: 'mikhail', text: 'mikhail' }] };
	assert.ok(validateEntry(bad).some((p) => /label de locuteur/.test(p)));
	// Insensible à la casse et aux espaces autour.
	const bad2 = { ...GOOD, requires: [], lines: [{ speaker: 'mikhail', text: '  MIKHAIL  ' }] };
	assert.ok(validateEntry(bad2).some((p) => /label de locuteur/.test(p)));
});

t('validateEntry : une réplique qui mentionne un membre du crew sans être QUE son nom passe', () => {
	// Le cas qui compte : le crew s'adresse par le prénom sans arrêt. Une
	// règle trop large effacerait silencieusement du dialogue légitime.
	const legitimate = ['jensen, status?', 'ask mikhail about the ridge'];
	for (const text of legitimate) {
		const good = { ...GOOD, requires: [], lines: [{ speaker: 'root', text }] };
		const problems = validateEntry(good);
		assert.ok(!problems.some((p) => /label de locuteur/.test(p)), `faux positif non-fondé : "${text}"`);
	}
});

// --- déduplication par trigrammes -----------------------------------------------

const mk = (id, ...texts) => ({ id, lines: texts.map((text) => ({ speaker: 'root', text })) });

t('normalize : casse, ponctuation et espaces écrasés', () => {
	assert.equal(normalize('  Ship  IT, now! '), 'ship it now');
});

t('trigrams : fenêtres de trois caractères', () => {
	const g = trigrams('abcd');
	assert.deepEqual([...g].sort(), ['abc', 'bcd']);
	assert.equal(trigrams('ab').size, 0);
});

t('jaccard : identique vaut 1, disjoint vaut 0', () => {
	assert.equal(jaccard(trigrams('hello there'), trigrams('hello there')), 1);
	assert.equal(jaccard(trigrams('aaaaaa'), trigrams('bbbbbb')), 0);
	assert.equal(jaccard(new Set(), new Set()), 0);
});

t('findDuplicates : attrape le quasi-doublon, laisse le reste tranquille', () => {
	const entries = [
		mk('a', 'tile 842 is corrupt'),
		mk('b', 'tile 843 is corrupt'),          // quasi-doublon de a
		mk('c', 'the mesh has no holes so far'), // sans rapport
	];
	const dups = findDuplicates(entries, { threshold: 0.6 });
	assert.equal(dups.length, 1);
	assert.deepEqual([dups[0].a, dups[0].b].sort(), ['a', 'b']);
	assert.ok(dups[0].score >= 0.6);
});

t('findDuplicates : compare l\'échange entier, pas réplique par réplique', () => {
	const entries = [mk('x', 'how long', 'three minutes'), mk('y', 'how long', 'three minutes')];
	assert.equal(findDuplicates(entries, { threshold: 0.9 }).length, 1);
});

t('findDuplicates : tient l\'échelle visée sans exploser le temps', () => {
	// 5000 entrées distinctes : l'index inversé doit rester très en deçà de la
	// comparaison de toutes les paires. Si ce test devient lent, c'est que
	// l'index n'est pas utilisé.
	const many = Array.from({ length: 5000 }, (_, i) => mk(`m/${i}`, `signal ${i} lost over sector ${i * 7}`));
	const t0 = Date.now();
	findDuplicates(many, { threshold: 0.85 });
	const ms = Date.now() - t0;
	assert.ok(ms < 20000, `déduplication trop lente : ${ms} ms sur 5000 entrées`);
});

t('findRepeatedLines : une phrase distinctive reprise dans plusieurs entrées est signalée', () => {
	const entries = [
		mk('a', 'ship the coarse pass'),
		mk('b', 'ship the coarse pass'),
		mk('c', 'the mesh has no holes so far'),
	];
	const rep = findRepeatedLines(entries);
	assert.equal(rep.length, 1);
	assert.equal(rep[0].count, 2);
	assert.equal(rep[0].text, 'ship the coarse pass');
});

t('findRepeatedLines : un battement court comme "no" repris dix fois n\'est pas signalé', () => {
	assert.ok('no'.split(' ').length < MIN_REPEATED_LINE_WORDS);
	const entries = Array.from({ length: 10 }, (_, i) => mk(`m/${i}`, 'no'));
	assert.deepEqual(findRepeatedLines(entries), []);
});

t('findRepeatedLines : le rapport nomme les entrées fautives', () => {
	const entries = [
		mk('a', 'drop the outer tiles'),
		mk('b', 'drop the outer tiles'),
		mk('c', 'drop the outer tiles'),
	];
	const rep = findRepeatedLines(entries);
	assert.equal(rep.length, 1);
	assert.deepEqual(rep[0].ids.sort(), ['a', 'b', 'c']);
});

t('seenLineSet / repeatedLineIn : filtrage à l\'accueil, incrémental', () => {
	// Simule le filtrage de generate.mjs : une formule déjà écrite dans le
	// shard chargé fait rejeter la première entrée candidate qui la reprend,
	// et l'ensemble grandit ensuite avec les entrées gardées du run.
	const shard = [mk('a', 'ship the coarse pass')];
	const seen = seenLineSet(shard);
	assert.equal(repeatedLineIn(mk('b', 'ship the coarse pass'), seen), 'ship the coarse pass');
	assert.equal(repeatedLineIn(mk('c', 'the mesh has no holes so far'), seen), null);

	// Une entrée gardée doit elle-même entrer dans l'ensemble : une formule
	// répétée DEUX FOIS dans le même run doit être attrapée à la deuxième,
	// pas seulement contre le corpus chargé au départ.
	addLinesToSeen(mk('c', 'drop the outer tiles'), seen);
	assert.equal(repeatedLineIn(mk('d', 'drop the outer tiles'), seen), 'drop the outer tiles');
});

t('RARITY_GUIDANCE : une instruction d\'écriture par palier, pas seulement un poids', () => {
	assert.deepEqual(Object.keys(RARITY_GUIDANCE), ['COMMON', 'UNCOMMON', 'RARE', 'VERY_RARE']);
	for (const text of Object.values(RARITY_GUIDANCE)) assert.ok(text.length > 20);
	// L'invariant du critère d'acceptation : VERY_RARE ne doit jamais promettre de suite.
	assert.match(RARITY_GUIDANCE.VERY_RARE, /promise|promises/i);
});

// --- cadence -----------------------------------------------------------------

t('pickInRange : reste dans la fourchette', () => {
	const rng = rngFrom('c');
	for (let i = 0; i < 200; i++) {
		const v = pickInRange([100, 300], rng);
		assert.ok(v >= 100 && v <= 300, `hors fourchette : ${v}`);
	}
});

t('nextGapMs : suit la cadence déclarée par l\'événement', () => {
	const rng = rngFrom('g');
	const [lo, hi] = EVENTS.ACQUIRE_AREA.gapMs;
	for (let i = 0; i < 100; i++) {
		const v = nextGapMs('ACQUIRE_AREA', rng);
		assert.ok(v >= lo && v <= hi);
	}
	assert.ok(nextGapMs('NOT_AN_EVENT', rng) > 0, 'un événement inconnu ne doit pas rendre NaN');
});

t('planExchange : première réplique à 0, les suivantes espacées et croissantes', () => {
	const lines = [
		{ speaker: 'root', text: 'how long' },
		{ speaker: 'mikhail', text: 'three minutes' },
		{ speaker: 'root', text: 'you said two' },
	];
	const plan = planExchange(lines, 'ACQUIRE_AREA', rngFrom('p'));
	assert.equal(plan.length, 3);
	assert.equal(plan[0].atMs, 0);
	for (let i = 1; i < plan.length; i++) {
		assert.ok(plan[i].atMs > plan[i - 1].atMs, 'les répliques doivent tomber une par une');
	}
	assert.deepEqual(plan.map((l) => l.speaker), ['root', 'mikhail', 'root']);
});

t('corpus livré : le shard ACQUIRE_AREA passe validation et déduplication', () => {
	const shard = JSON.parse(readFileSync(new URL('../public/dialogue/acquire_area.json', import.meta.url)));
	assert.equal(shard.event, 'ACQUIRE_AREA');
	assert.ok(shard.entries.length >= 10, `corpus de départ trop maigre : ${shard.entries.length}`);
	const r = validateCorpus(shard.entries);
	assert.deepEqual(r.errors, [], 'le corpus livré doit être irréprochable');
	assert.deepEqual(findDuplicates(shard.entries, { threshold: 0.75 }), []);
});

t('manifeste : chaque shard annoncé existe et déclare son propre événement', () => {
	const manifest = JSON.parse(readFileSync(new URL('../public/dialogue/manifest.json', import.meta.url)));
	for (const [event, file] of Object.entries(manifest.shards)) {
		assert.ok(EVENTS[event], `manifeste : événement inconnu ${event}`);
		const shard = JSON.parse(readFileSync(new URL(`../public/dialogue/${file}`, import.meta.url)));
		assert.equal(shard.event, event, `${file} : l'événement déclaré ne correspond pas au manifeste`);
	}
});

t('pack de secours : valide, et surtout sans aucun requires', () => {
	assert.deepEqual(validateCorpus(FALLBACK).errors, []);
	for (const e of FALLBACK) {
		assert.deepEqual(e.requires, [], `${e.id} : le secours doit rendre sans contexte du tout`);
	}
	// Chaque événement câblé en v1 doit avoir de quoi parler même sans réseau.
	for (const id of ['AREA_SEARCH', 'PROBE_AREA', 'ACQUIRE_AREA', 'TERRAIN_PROGRESS',
		'TARGET_SCAN', 'TARGET_SELECTED', 'TARGET_ANALYSIS', 'HACK', 'MANUAL_OVERRIDE',
		'JACK_IN', 'WEATHER']) {
		assert.ok(FALLBACK.some((e) => e.events.includes(id)), `aucun secours pour ${id}`);
	}
});

// --- isolation de l'atelier de génération (D1) -----------------------------

t('isolation : aucun module de src/ n\'importe l\'outillage de génération', () => {
	// readdirSync non récursif : src/ est plat aujourd'hui (aucun sous-dossier).
	// Si ça change, ce test doit devenir récursif pour continuer à tout couvrir.
	const dir = new URL('../src/', import.meta.url);
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.js')) continue;
		const code = rf(new URL(f, dir), 'utf8');
		assert.ok(!/dialogue\/(generate|inspect)\.mjs/.test(code),
			`${f} importe l'outillage de génération — le jeu ne doit dépendre d'aucun LLM (D1)`);
	}
});

t('isolation : public/dialogue ne contient que des données', () => {
	for (const f of readdirSync(new URL('../public/dialogue/', import.meta.url))) {
		assert.match(f, /\.json$/, `public/dialogue contient autre chose que des données : ${f}`);
	}
});

// --- backend local (Ollama) : arguments et sélection (D1, sans modèle) -----

t('args : lit les paires --clé valeur', () => {
	const a = genArgs(['node', 'generate.mjs', '--event', 'ACQUIRE_AREA', '--count', '6', '--batch', '6']);
	assert.equal(a.event, 'ACQUIRE_AREA');
	assert.equal(a.count, '6');
	assert.equal(a.batch, '6');
});

t('args : un drapeau sans valeur (fin de ligne) devient true', () => {
	const a = genArgs(['node', 'generate.mjs', '--event', 'X', '--dry-run']);
	assert.equal(a['dry-run'], true);
});

t('args : un drapeau suivi d\'un autre --clé devient true, pas la clé suivante', () => {
	const a = genArgs(['node', 'generate.mjs', '--dry-run', '--backend', 'ollama']);
	assert.equal(a['dry-run'], true);
	assert.equal(a.backend, 'ollama');
});

t('resolveBackend : claude par défaut, rien ne change pour un usage existant', () => {
	assert.equal(DEFAULT_BACKEND, 'claude');
	const r = resolveBackend({}, {});
	assert.equal(r.backend, 'claude');
	assert.equal(r.model, DEFAULT_MODEL.claude);
});

t('resolveBackend : ollama choisit le modèle et l\'hôte mesurés par défaut', () => {
	const r = resolveBackend({ backend: 'ollama' }, {});
	assert.equal(r.backend, 'ollama');
	assert.equal(r.model, 'batiai/qwen3.6-27b:q3');
	assert.equal(r.host, DEFAULT_OLLAMA_HOST);
	assert.equal(r.host, 'http://127.0.0.1:11434');
});

t('resolveBackend : --model et --ollama-host l\'emportent sur les défauts', () => {
	const r = resolveBackend({ backend: 'ollama', model: 'autre-modele', 'ollama-host': 'http://box:9999' }, {});
	assert.equal(r.model, 'autre-modele');
	assert.equal(r.host, 'http://box:9999');
});

t('resolveBackend : OLLAMA_HOST de l\'environnement sert si --ollama-host est absent', () => {
	const r = resolveBackend({ backend: 'ollama' }, { OLLAMA_HOST: 'http://env-host:11434' });
	assert.equal(r.host, 'http://env-host:11434');
});

t('resolveBackend : un backend inconnu échoue clairement', () => {
	assert.throws(() => resolveBackend({ backend: 'mistral' }, {}), /backend inconnu/);
});

t('resolveBackend : le backend claude ne porte aucun hôte, même si OLLAMA_HOST est défini', () => {
	const r = resolveBackend({}, { OLLAMA_HOST: 'http://env-host:11434' });
	assert.equal(r.backend, 'claude');
	assert.equal(r.model, DEFAULT_MODEL.claude);
	assert.equal(r.host, undefined, 'claude ne lit jamais host : un OLLAMA_HOST de l\'environnement ne doit pas s\'y retrouver');
});

t('BACKENDS : exactement claude et ollama', () => {
	assert.deepEqual(BACKENDS, ['claude', 'ollama']);
});

t('nextSeq : continue au-dessus du plus grand id existant, pas du compte', () => {
	// Un tableau qui a perdu des entrées (dédoublonnage) doit repartir du plus
	// haut numéro jamais délivré, jamais de sa longueur actuelle.
	const entries = [
		{ id: 'acquire_area/0001' },
		{ id: 'acquire_area/0585' },
		{ id: 'acquire_area/0042' },
	];
	assert.equal(nextSeq(entries), 585);
});

t('nextSeq : un shard élagué (moins d\'entrées que le plus haut id) n\'entre pas en collision', () => {
	// Simule le cas réel : 566 entrées en tableau, mais le plus haut id est
	// 0585 (des doublons ont été retirés en aval). Le prochain id délivré doit
	// être 0586, jamais un id déjà présent dans le tableau.
	const entries = Array.from({ length: 10 }, (_, i) => ({ id: `acquire_area/${String(i + 576).padStart(4, '0')}` }));
	const seq = nextSeq(entries);
	assert.equal(seq, 585);
	const next = `acquire_area/${String(seq + 1).padStart(4, '0')}`;
	assert.ok(!entries.some((e) => e.id === next), 'le prochain id ne doit collisionner avec aucun id existant');
});

t('nextSeq : shard vide démarre à zéro', () => {
	assert.equal(nextSeq([]), 0);
});

t('nextSeq : robuste à un id qui ne se termine pas par des chiffres', () => {
	assert.equal(nextSeq([{ id: 'acquire_area/xxxx' }, { id: 'acquire_area/0012' }]), 12);
});

t('parseEntries : tableau JSON nu', () => {
	assert.deepEqual(parseEntries('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
});

t('parseEntries : tableau enrobé de prose avant et après', () => {
	const text = 'Voici le résultat :\n[{"a":1}]\nVoilà, terminé.';
	assert.deepEqual(parseEntries(text), [{ a: 1 }]);
});

t('parseEntries : tableau dans un bloc de code ```json', () => {
	const text = 'Sure, here it is:\n```json\n[{"a":1},{"a":2}]\n```\nLet me know if you need more.';
	assert.deepEqual(parseEntries(text), [{ a: 1 }, { a: 2 }]);
});

t('parseEntries : tableau dans un bloc de code sans langage', () => {
	const text = '```\n[{"a":1}]\n```';
	assert.deepEqual(parseEntries(text), [{ a: 1 }]);
});

t('parseEntries : ne se fait pas piéger par un crochet dans la prose de fin', () => {
	// Un modèle local ajoute volontiers une phrase de clôture ; si elle contient
	// elle-même un crochet après le tableau réel, un simple lastIndexOf(']')
	// couperait le JSON au mauvais endroit.
	const text = '[{"a":1}]\n(généré comme demandé [voir consignes])';
	assert.deepEqual(parseEntries(text), [{ a: 1 }]);
});

t('parseEntries : ne se fait pas piéger par un crochet dans la prose de préface', () => {
	// Symétrique du cas précédent : une préface du genre « using the format
	// like [role, text], here is the batch: [...] » place un crochet qui
	// s'équilibre avant le vrai tableau. Un modèle local préface au moins
	// aussi souvent qu'il conclut.
	const text = 'Using the format like [role, text], here is the batch: [{"a":1},{"a":2}]';
	assert.deepEqual(parseEntries(text), [{ a: 1 }, { a: 2 }]);
});

t('parseEntries : ne se fait pas piéger par un crochet à l\'intérieur d\'une réplique', () => {
	const text = '[{"lines":[{"speaker":"root","text":"check [redacted] now"}]}]';
	assert.deepEqual(parseEntries(text), [{ lines: [{ speaker: 'root', text: 'check [redacted] now' }] }]);
});

t('parseEntries : aucun tableau dans la réponse échoue clairement', () => {
	assert.throws(() => parseEntries('je ne peux pas répondre à ça.'), /aucun tableau JSON/);
});

t('parseEntries : tableau non refermé échoue clairement', () => {
	assert.throws(() => parseEntries('[{"a":1}'), /non refermé/);
});

console.log(`\n${n} vérifications, tout passe.`);
