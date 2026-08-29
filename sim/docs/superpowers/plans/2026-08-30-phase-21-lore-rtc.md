# PHASE 21 — Lore / RTC v0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le script RTC figé de 27 lignes par un corpus de dialogues de 3000-5000 entrées écrit hors ligne à l'aide d'un LLM, livré en données statiques et interpolé au runtime avec le contexte réel de la partie.

**Architecture :** Moteur pur et sans DOM dans `tools/dialogue/` (catalogue, rendu, sélection, validation, déduplication, génération), colle navigateur mince dans `src/dialogue.js` + `src/dialogue-context.js`, corpus en shards JSON par événement sous `public/dialogue/` chargés à la demande. Le jeu ne dépend jamais d'un LLM pour tourner : la génération est un outil de développement que rien sous `src/` ne peut atteindre.

**Tech Stack :** JavaScript ESM, Node 22, `node:assert/strict` pour les selftests, `fetch` natif. **Aucune nouvelle dépendance npm.**

**Spec :** `sim/docs/superpowers/specs/2026-08-30-phase-21-lore-rtc-design.md`

**Branche :** `phase-21-lore-rtc` · worktree `wt-p21` · issue [#58](https://github.com/lionrayonnant/FPVTP/issues/58)

## Global Constraints

Ces contraintes s'appliquent à **toutes** les tâches, sans être répétées à chaque fois.

- **Langue.** Tout le texte que le joueur voit est en **anglais** (Bible §11), y compris le corpus, les BUILD NOTES et les libellés d'écran. Les commentaires de code, les noms de test et les messages de commit sont en **français** (D5 transverse).
- **Aucune nouvelle dépendance npm.** Ni pour le runtime, ni pour l'outillage de génération.
- **Motif du dépôt, sans exception.** Logique pure et testable dans `tools/`, colle navigateur dans `src/`. Chaque module pur a son `tools/<nom>-selftest.mjs` branché sur `npm run selftest:operator`.
- **Pureté.** Aucun `Math.random`, aucun `Date.now`, aucun `fetch`, aucun accès DOM dans quoi que ce soit sous `tools/dialogue/` **sauf** `generate.mjs` (outil de dev). Le hasard entre par un `rng` injecté.
- **Poids de rareté, valeurs exactes :** `COMMON` 100 · `UNCOMMON` 30 · `RARE` 8 · `VERY_RARE` 2.
- **Plafond de jensen :** au plus une apparition toutes les **12** répliques.
- **Anneau de mémoire :** les **256** derniers ids, clé opérateur de haut niveau `dialogueMemory`, **sans** bump de `SCHEMA_VERSION`.
- **Crew :** `root`, `jensen`, `mikhail`, `cron`. `vex` n'existe plus.
- **`npm run selftest` (physique) doit rester vert** à chaque commit : aucun élément de DA ne devient une dépendance du moteur de vol.
- **Deux invariants hérités de PHASE 05, non négociables :** le dialogue ne bloque jamais un bouton, une transition ou un vol ; il n'est jamais une source d'information sur l'état réel du pipeline.
- **Commits fréquents**, un par tâche au minimum, en français, terminés par `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Correction à la spec, à appliquer

La spec cite `src/entry-state.js` comme point d'appel pour l'événement `WEATHER`. **C'est une erreur** : `entry-state.js` est le générateur d'état d'entrée physique (spawn, occupancy, `sampleCandidate`), pas un écran — il n'affiche rien au joueur. La chaîne avant-vol réelle est `main.js:1343` → `runTargetScan()` → `main.js:1357` → `runHack()` → vol.

`WEATHER` est donc câblé sur l'écran **TARGET SCAN**, qui reçoit déjà `weather` et affiche déjà son `conditionsBlock`. Aucun écran n'est ajouté à la chaîne avant-vol : c'est cohérent avec « ce n'est pas un mini-jeu ». La Tâche 13 corrige la spec sur ce point.

## File Structure

| fichier | responsabilité |
|---|---|
| `tools/dialogue/catalog.mjs` | **source de vérité** : ids d'événements, cadences, `silenceWeight`, table des slots (chemin + formateur), poids de rareté, crew |
| `tools/dialogue/render.mjs` | interpolation d'une entrée avec un contexte ; jette si un `{slot}` subsiste |
| `tools/dialogue/engine.mjs` | `select()` : éligibilité, refroidissements, poids, silence ; `emptyMemory()`, `rngFrom()` |
| `tools/dialogue/cadence.mjs` | plan temporel d'un échange (écarts, battements) — pur, pour que `src/dialogue.js` n'ait aucune logique testable |
| `tools/dialogue/validate.mjs` | règles de forme, de style et de cohérence slots/`requires` sur une entrée ou un corpus |
| `tools/dialogue/dedupe.mjs` | quasi-doublons par index inversé de trigrammes + Jaccard |
| `tools/dialogue/generate.mjs` | **outil de dev** : lots LLM, `callModel()` à deux dos |
| `tools/dialogue/inspect.mjs` | **outil de dev** : tirages rendus avec contextes factices, relecture par échantillon |
| `tools/dialogue/prompts/` | bible des personnages, règles de style, brief par événement |
| `tools/dialogue-selftest.mjs` | selftest de tout ce qui précède, sans DOM |
| `tools/buildnotes-model.mjs` | échelle de versions BUILD NOTES + résolution de la build courante |
| `tools/buildnotes-selftest.mjs` | selftest des BUILD NOTES |
| `src/dialogue.js` | chargement des shards, cache d'onglet, repli, mémoire, `mount()` |
| `src/dialogue-context.js` | assemble le contexte brut depuis l'état vivant du jeu |
| `src/dialogue-fallback.js` | pack de secours minuscule compilé dans le bundle |
| `public/dialogue/manifest.json` + `<event>.json` | le corpus livré |

Fichiers **supprimés** : `tools/rtc-model.mjs`, `tools/rtc-selftest.mjs`.

Fichiers **modifiés** : `src/scanner.js`, `src/target-scan.js`, `src/hack.js`, `src/terminal.js`, `tools/terminal-model.mjs`, `src/style.css`, `package.json`, la Bible §9, `HANDOFF.md`, `README.md`.

---

### Task 1: `catalog.mjs` — la source de vérité

**Files:**
- Create: `sim/tools/dialogue/catalog.mjs`
- Create: `sim/tools/dialogue-selftest.mjs`
- Modify: `sim/package.json` (ajouter `node tools/dialogue-selftest.mjs` à `selftest:operator`)

**Interfaces:**
- Consumes: rien (première tâche).
- Produces:
  - `CREW: string[]` — `['root','jensen','mikhail','cron']`
  - `RARITY: Record<string, number>` — poids exacts
  - `JENSEN_COOLDOWN = 12`, `MEMORY_RING = 256`, `MEMORY_SEEN = 512`
  - `EVENTS: Record<string, { shard: string, silenceWeight: number, gapMs: [number,number], beatMs: [number,number] }>`
  - `SLOTS: Record<string, { path: string, format: (v:any) => string }>`
  - `resolvePath(ctx: object, path: string) => any | null`
  - `slotsUsed(entry: object) => string[]`
  - `pathsForSlots(names: string[]) => string[]`

- [ ] **Step 1: Write the failing test**

Créer `sim/tools/dialogue-selftest.mjs` :

```js
// Selftest du moteur de dialogue (PHASE 21). Aucune E/S, aucun DOM.
// Lancer : node tools/dialogue-selftest.mjs
import assert from 'node:assert/strict';
import {
	CREW, RARITY, EVENTS, SLOTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN,
	resolvePath, slotsUsed, pathsForSlots,
} from './dialogue/catalog.mjs';

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

console.log(`\n${n} vérifications, tout passe.`);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/catalog.mjs`.

- [ ] **Step 3: Write minimal implementation**

Créer `sim/tools/dialogue/catalog.mjs`. Les formateurs qui parlent météo ou drone **réutilisent** les fonctions existantes plutôt que d'inventer un second vocabulaire (spec, `src/dialogue-context.js` fournit déjà les valeurs pré-extraites, donc le catalogue ne formate que des scalaires) :

```js
// Catalogue du moteur de dialogue (PHASE 21, Bible §9-10). SOURCE DE VÉRITÉ :
// les ids d'événements, les cadences, les poids de silence, la table des slots.
// Aucun état, aucune E/S, aucun DOM. Ajouter un événement ici suffit à le rendre
// utilisable — c'est le critère d'acceptation 10 de l'issue #58.

export const CREW = ['root', 'jensen', 'mikhail', 'cron'];

// Poids de tirage. Valeurs verbatim de la spec — le selftest les fige.
export const RARITY = { COMMON: 100, UNCOMMON: 30, RARE: 8, VERY_RARE: 2 };

// jensen ne peut pas parler plus d'une fois toutes les 12 répliques (D5) : son
// mystère vient de sa rareté, et la rareté ne se garantit pas par un prompt.
export const JENSEN_COOLDOWN = 12;

// Exclusion dure sur les 256 derniers ids ; pénalité douce sur les 512 derniers
// (une entrée déjà vue mais ancienne redevient possible, jamais prioritaire).
export const MEMORY_RING = 256;
export const MEMORY_SEEN = 512;

// `gapMs` : écart entre deux échanges. `beatMs` : battement entre deux répliques
// d'un même échange — c'est ce qui fait « quelqu'un qui tape » plutôt qu'un collage.
const acq = { gapMs: [7000, 16000], beatMs: [800, 1900] };
const quick = { gapMs: [4000, 9000], beatMs: [600, 1400] };

export const EVENTS = {
	// --- câblés en v1 -------------------------------------------------------
	AREA_SEARCH:      { shard: 'area_search',      silenceWeight: 60, ...quick },
	PROBE_AREA:       { shard: 'probe_area',       silenceWeight: 45, ...quick },
	ACQUIRE_AREA:     { shard: 'acquire_area',     silenceWeight: 30, ...acq },
	TERRAIN_PROGRESS: { shard: 'terrain_progress', silenceWeight: 35, ...acq },
	TARGET_SCAN:      { shard: 'target_scan',      silenceWeight: 40, ...quick },
	TARGET_SELECTED:  { shard: 'target_selected',  silenceWeight: 35, ...quick },
	TARGET_ANALYSIS:  { shard: 'target_analysis',  silenceWeight: 40, ...quick },
	HACK:             { shard: 'hack',             silenceWeight: 45, ...quick },
	MANUAL_OVERRIDE:  { shard: 'manual_override',  silenceWeight: 55, ...quick },
	JACK_IN:          { shard: 'jack_in',          silenceWeight: 60, ...quick },
	WEATHER:          { shard: 'weather',          silenceWeight: 40, ...quick },
	// --- déclarés, sans point d'appel en v1 (critère 10) ---------------------
	BOOTSTRAP:        { shard: 'bootstrap',        silenceWeight: 50, ...quick },
	SYSTEM:           { shard: 'system',           silenceWeight: 70, ...quick },
	FLIGHT:           { shard: 'flight',           silenceWeight: 85, ...quick },
	LINK_DEGRADED:    { shard: 'link_degraded',    silenceWeight: 60, ...quick },
	LINK_RESTORED:    { shard: 'link_restored',    silenceWeight: 60, ...quick },
	CRASH:            { shard: 'crash',            silenceWeight: 35, ...quick },
	SESSION_COMPLETE: { shard: 'session_complete', silenceWeight: 30, ...quick },
	REVISIT:          { shard: 'revisit',          silenceWeight: 45, ...quick },
};

const upper = (v) => String(v).toUpperCase();
const asIs = (v) => String(v);
const round0 = (v) => String(Math.round(v));

// Chaque slot dit DE QUOI il dépend (`path`) et COMMENT il s'affiche (`format`).
// C'est ce couplage qui rend un placeholder cassé impossible : validate.mjs
// exige que le chemin de tout slot utilisé figure dans le `requires` de l'entrée.
export const SLOTS = {
	location:         { path: 'area.name',          format: upper },
	operator_name:    { path: 'operator.name',      format: upper },
	weather_summary:  { path: 'weather.summary',    format: asIs },
	wind:             { path: 'weather.windMs',     format: round0 },
	rain:             { path: 'weather.rain',       format: asIs },
	visibility:       { path: 'weather.visibility', format: asIs },
	drone_type:       { path: 'drone.label',        format: (v) => String(v).toLowerCase() },
	video_type:       { path: 'target.video',       format: upper },
	signal:           { path: 'target.rssiDbm',     format: (v) => `${Math.round(v)} dBm` },
	hack_type:        { path: 'target.hackType',    format: upper },
	target_count:     { path: 'scan.count',         format: round0 },
	terrain_size:     { path: 'terrain.tiles',      format: round0 },
	terrain_mb:       { path: 'terrain.megabytes',  format: (v) => `${Math.round(v)} MB` },
	session_duration: { path: 'session.durationS',  format: (v) => `${Math.round(v / 60)} min` },
	gpu:              { path: 'machine.gpu',        format: asIs },
	display:          { path: 'machine.display',    format: asIs },
};

// Un chemin absent, nul, NaN ou vide vaut null : c'est ce que teste l'éligibilité.
// Un contexte pauvre rétrécit le bassin de candidats, il ne casse jamais un rendu.
export function resolvePath(ctx, path) {
	let v = ctx;
	for (const key of String(path).split('.')) {
		if (v == null || typeof v !== 'object') return null;
		v = v[key];
	}
	if (v == null) return null;
	if (typeof v === 'number' && !Number.isFinite(v)) return null;
	if (typeof v === 'string' && v.trim() === '') return null;
	return v;
}

const SLOT_RE = /\{([a-z_]+)\}/g;

export function slotsUsed(entry) {
	const found = new Set();
	for (const line of entry?.lines ?? []) {
		for (const m of String(line.text ?? '').matchAll(SLOT_RE)) found.add(m[1]);
	}
	return [...found];
}

export function pathsForSlots(names) {
	return [...new Set(names.map((n) => SLOTS[n]?.path).filter(Boolean))];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : 9 vérifications, tout passe.

- [ ] **Step 5: Brancher le selftest et vérifier que rien n'est cassé**

Dans `sim/package.json`, ajouter ` && node tools/dialogue-selftest.mjs` à la fin de la chaîne `selftest:operator`, puis :

```bash
cd sim && npm run selftest:operator && npm run selftest
```

Attendu : les deux vertes (`selftest` doit annoncer 158/158 comme avant — la physique n'a pas bougé).

- [ ] **Step 6: Commit**

```bash
git add sim/tools/dialogue/catalog.mjs sim/tools/dialogue-selftest.mjs sim/package.json
git commit -m "$(printf 'PHASE 21 : catalogue du moteur de dialogue (#58)\n\nLes ids d%sévénements, les cadences, les poids de silence et la table\ndes slots. Chaque slot dit de quoi il dépend et comment il s%saffiche :\nc%sest ce couplage qui rendra un placeholder cassé impossible.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'")"
```

---

### Task 2: `render.mjs` — interpolation qui refuse de mentir

**Files:**
- Create: `sim/tools/dialogue/render.mjs`
- Modify: `sim/tools/dialogue-selftest.mjs`

**Interfaces:**
- Consumes: `SLOTS`, `resolvePath` de `catalog.mjs` (Task 1).
- Produces: `render(entry: object, ctx: object) => Array<{ speaker: string, text: string }>` — **jette** une `Error` si un `{slot}` subsiste après interpolation.

- [ ] **Step 1: Write the failing test**

Ajouter à `sim/tools/dialogue-selftest.mjs`, sous les imports existants :

```js
import { render } from './dialogue/render.mjs';
```

puis, avant la ligne `console.log` finale :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/render.mjs`.

- [ ] **Step 3: Write minimal implementation**

Créer `sim/tools/dialogue/render.mjs` :

```js
// Interpolation d'une entrée de dialogue (PHASE 21). Pur, sans DOM.
//
// La règle est volontairement brutale : si un slot ne résout pas, on JETTE. Ce
// cas ne peut se produire que sur un corpus qui n'a pas passé validate.mjs,
// donc en développement — le runtime, lui, n'appelle render() que sur des
// entrées déjà déclarées éligibles par engine.mjs. Mieux vaut une exception
// bruyante au banc qu'un « {wind} meters per second » affiché au joueur.
import { SLOTS, resolvePath } from './catalog.mjs';

export function render(entry, ctx) {
	return (entry?.lines ?? []).map((line) => {
		const text = String(line.text ?? '').replace(/\{([a-z_]+)\}/g, (whole, name) => {
			const slot = SLOTS[name];
			if (!slot) throw new Error(`slot inconnu du catalogue : {${name}} (entrée ${entry?.id})`);
			const raw = resolvePath(ctx, slot.path);
			if (raw === null) throw new Error(`slot non résolu : {${name}} → ${slot.path} (entrée ${entry?.id})`);
			return slot.format(raw);
		});
		return { speaker: line.speaker, text };
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : 13 vérifications, tout passe.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/dialogue/render.mjs sim/tools/dialogue-selftest.mjs
git commit -m "$(printf 'PHASE 21 : rendu des dialogues, qui jette plutôt que de mentir (#58)\n\nUn slot non résolu lève une exception au lieu de s%safficher. Le cas ne\npeut survenir que sur un corpus non validé, donc au banc et jamais chez\nle joueur.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'")"
```

---

### Task 3: `engine.mjs` — sélection, refroidissements, silence

C'est le cœur de la phase. Tout le reste est de la plomberie autour.

**Files:**
- Create: `sim/tools/dialogue/engine.mjs`
- Modify: `sim/tools/dialogue-selftest.mjs`

**Interfaces:**
- Consumes: `RARITY`, `EVENTS`, `JENSEN_COOLDOWN`, `MEMORY_RING`, `MEMORY_SEEN`, `resolvePath` de `catalog.mjs`.
- Produces:
  - `rngFrom(seed: string|number) => () => number` — xorshift32, même primitive que `entry-state.js:19`
  - `emptyMemory() => { ring: string[], seen: Record<string, number>, buckets: Record<string, number>, seq: number }`
  - `eligible(entry: object, ctx: object) => boolean`
  - `sinceEvent(memory: object, event: string) => number` (`Infinity` si jamais)
  - `select({ event, pool, ctx, memory, rng }) => { entry: object|null, memory: object }`
  - `PAIR_COOLDOWN = 3`
- **`select()` ne mute jamais la mémoire reçue** : elle rend une nouvelle mémoire. C'est ce qui rend les tests de distribution possibles (on rejoue avec une mémoire fraîche).

- [ ] **Step 1: Write the failing test**

Ajouter à `sim/tools/dialogue-selftest.mjs` :

```js
import {
	rngFrom, emptyMemory, eligible, sinceEvent, select, PAIR_COOLDOWN,
} from './dialogue/engine.mjs';
import { JENSEN_COOLDOWN as JC } from './dialogue/catalog.mjs';
```

et, avant le `console.log` final :

```js
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

t('sinceEvent : distance depuis la dernière prise de parole d\'un événement', () => {
	let mem = emptyMemory();
	assert.equal(sinceEvent(mem, 'ACQUIRE_AREA'), Infinity);
	const rng = rngFrom('f');
	for (let i = 0; i < 5; i++) {
		mem = select({ event: 'ACQUIRE_AREA', pool: pool(20), ctx: {}, memory: mem, rng }).memory;
	}
	assert.ok(sinceEvent(mem, 'ACQUIRE_AREA') < Infinity);
	assert.equal(sinceEvent(mem, 'HACK'), Infinity);
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/engine.mjs`.

- [ ] **Step 3: Write minimal implementation**

Créer `sim/tools/dialogue/engine.mjs` :

```js
// Sélection d'une réplique (PHASE 21). Pur : le hasard entre par `rng`, aucune
// horloge, aucune mutation de la mémoire reçue. C'est cette pureté qui rend
// mesurables la fréquence de jensen et la distribution de rareté — sans elle,
// « jensen est rare » resterait une intention.
import {
	RARITY, EVENTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN, resolvePath,
} from './catalog.mjs';

// La même paire ne peut pas enchaîner trois échanges d'affilée sans pénalité :
// root et mikhail sont majoritaires dans le corpus, sans ça ils monologuent.
export const PAIR_COOLDOWN = 3;

// Pénalité douce d'une entrée déjà vue mais sortie de l'anneau : le matériel
// jamais joué remonte, l'ancien redevient possible sans jamais être prioritaire.
const SEEN_PENALTY = 0.35;
const PAIR_PENALTY = 0.2;

// xorshift32, la même primitive que src/entry-state.js:19 — recopiée plutôt
// qu'importée : ce module doit rester sans dépendance vers src/ (qui traîne THREE).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

export function emptyMemory() {
	return { ring: [], seen: {}, buckets: {}, seq: 0 };
}

export function eligible(entry, ctx) {
	return (entry?.requires ?? []).every((path) => resolvePath(ctx, path) !== null);
}

export function sinceEvent(memory, event) {
	const at = memory?.buckets?.[`event:${event}`];
	return at == null ? Infinity : (memory.seq - at);
}

const pairKey = (entry) => `pair:${[...new Set(entry.characters ?? [])].sort().join('|')}`;

// Le compteur avance à CHAQUE tirage, y compris silencieux : les refroidissements
// se comptent en occasions de parler, pas en répliques effectivement dites.
function bump(memory) {
	return { ...memory, seq: memory.seq + 1 };
}

function commit(memory, event, entry) {
	const ring = [...memory.ring, entry.id].slice(-MEMORY_RING);
	const seen = { ...memory.seen, [entry.id]: memory.seq };
	// Élagage des « vus » : on garde les MEMORY_SEEN plus récents, sinon l'objet
	// grossit sans fin dans l'état opérateur persisté.
	const keys = Object.keys(seen);
	if (keys.length > MEMORY_SEEN) {
		keys.sort((a, b) => seen[a] - seen[b]);
		for (const k of keys.slice(0, keys.length - MEMORY_SEEN)) delete seen[k];
	}
	const buckets = {
		...memory.buckets,
		[pairKey(entry)]: memory.seq,
		[`event:${event}`]: memory.seq,
	};
	if ((entry.characters ?? []).includes('jensen')) buckets.jensen = memory.seq;
	return { ring, seen, buckets, seq: memory.seq + 1 };
}

export function select({ event, pool = [], ctx = {}, memory = emptyMemory(), rng }) {
	const ring = new Set(memory.ring);
	const jensenAt = memory.buckets?.jensen;
	const jensenBlocked = jensenAt != null && (memory.seq - jensenAt) < JENSEN_COOLDOWN;

	const candidates = [];
	for (const entry of pool) {
		if (!(entry.events ?? []).includes(event)) continue;
		if (ring.has(entry.id)) continue;
		if (!eligible(entry, ctx)) continue;
		const hasJensen = (entry.characters ?? []).includes('jensen');
		if (hasJensen && jensenBlocked) continue;

		let w = RARITY[entry.rarity] ?? 0;
		if (w <= 0) continue;
		if (memory.seen?.[entry.id] != null) w *= SEEN_PENALTY;
		const pk = pairKey(entry);
		const pairAt = memory.buckets?.[pk];
		if (pairAt != null && (memory.seq - pairAt) < PAIR_COOLDOWN) w *= PAIR_PENALTY;
		candidates.push({ entry, w });
	}

	// Le silence entre dans le tirage comme un candidat (D4) : une acquisition
	// où le crew ne dit rien pendant une minute est correcte, pas cassée.
	const silence = EVENTS[event]?.silenceWeight ?? 0;
	const total = candidates.reduce((s, c) => s + c.w, 0) + silence;
	if (total <= 0) return { entry: null, memory: bump(memory) };

	let r = rng() * total;
	for (const c of candidates) {
		r -= c.w;
		if (r < 0) return { entry: c.entry, memory: commit(memory, event, c.entry) };
	}
	return { entry: null, memory: bump(memory) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : 25 vérifications, tout passe. Si le test de distribution de rareté sort de la fourchette, **ne pas élargir la fourchette** : c'est le signe que les pénalités s'appliquent là où le test croit les avoir neutralisées — vérifier que la mémoire est bien fraîche à chaque tirage.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/dialogue/engine.mjs sim/tools/dialogue-selftest.mjs
git commit -m "$(printf 'PHASE 21 : moteur de sélection des dialogues (#58)\n\nÉligibilité par chemins de contexte, exclusion sur anneau de 256,\npénalités douces sur les vus et sur la paire de locuteurs, silence\ncandidat, plafond de jensen à une réplique sur douze.\n\nPur et sans mutation : c%sest ce qui rend la fréquence de jensen et la\ndistribution de rareté mesurables au selftest plutôt que promises.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'")"
```

---

### Task 4: `validate.mjs` — les règles rendues exécutables

**Files:**
- Create: `sim/tools/dialogue/validate.mjs`
- Modify: `sim/tools/dialogue-selftest.mjs`

**Interfaces:**
- Consumes: `CREW`, `RARITY`, `EVENTS`, `SLOTS`, `slotsUsed`, `pathsForSlots` de `catalog.mjs`.
- Produces:
  - `KNOWN_PATHS: Set<string>` — tous les `path` déclarés dans `SLOTS`
  - `STYLE_BANS: Array<{ re: RegExp, why: string }>`
  - `validateEntry(entry: object) => string[]` — liste de problèmes en français, vide si l'entrée est bonne
  - `validateCorpus(entries: object[]) => { ok: number, errors: Array<{ id: string, problem: string }> }`

- [ ] **Step 1: Write the failing test**

Ajouter à `sim/tools/dialogue-selftest.mjs` :

```js
import { validateEntry, validateCorpus, STYLE_BANS, KNOWN_PATHS } from './dialogue/validate.mjs';
```

et avant le `console.log` final :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/validate.mjs`.

- [ ] **Step 3: Write minimal implementation**

Créer `sim/tools/dialogue/validate.mjs` :

```js
// Validation d'une entrée de dialogue (PHASE 21). Ce module transforme les
// règles d'écriture de la Bible en vérifications mécaniques. C'est ce qui
// permet de relire le corpus par échantillon : tout ce qui est vérifiable
// automatiquement l'est sur 100 % des entrées, l'humain ne juge que le ton.
import { CREW, RARITY, EVENTS, SLOTS, slotsUsed, pathsForSlots } from './catalog.mjs';

export const KNOWN_PATHS = new Set(Object.values(SLOTS).map((s) => s.path));

const MAX_LINE_CHARS = 90;   // au-delà, ce n'est plus du RTC, c'est un paragraphe
const MAX_LINES = 6;

// Bible §9-§12 : le crew ne sait pas qu'il est dans un jeu, ne s'adresse jamais
// au joueur, n'explique pas le lore et ne promet aucune suite.
export const STYLE_BANS = [
	{ re: /\bthe player\b|\bthe user\b/i, why: 'adresse au joueur' },
	{ re: /\bthe game\b|\bthis is (just )?a game\b|\bfourth wall\b/i, why: 'quatrième mur' },
	{ re: /\bLLM\b|\bprompt(ing|ed)?\b|\bneural net\b|\bmachine learning\b/i, why: 'vocabulaire IA moderne' },
	{ re: /\bto be continued\b|\bnext time\b|\bmore on (that|this) later\b/i, why: 'promesse de suite' },
	{ re: /\b(you|i)('ll| will) (see|find out|know)\b|\bexplain (it )?later\b/i, why: 'promesse de suite' },
	{ re: /\bplayer\b/i, why: 'vocabulaire de jeu vidéo' },
];

export function validateEntry(entry) {
	const p = [];
	const push = (msg) => p.push(msg);

	if (!entry?.id || typeof entry.id !== 'string') push('id manquant ou non textuel');
	if (!Array.isArray(entry?.events) || entry.events.length === 0) push('events vide');
	else for (const e of entry.events) if (!EVENTS[e]) push(`événement inconnu : ${e}`);

	if (!RARITY[entry?.rarity]) push(`rareté inconnue : ${entry?.rarity}`);

	if (!Array.isArray(entry?.characters) || entry.characters.length === 0) push('characters vide');
	else for (const c of entry.characters) if (!CREW.includes(c)) push(`locuteur hors crew : ${c}`);

	const lines = entry?.lines;
	if (!Array.isArray(lines) || lines.length === 0) push('lines vide');
	else {
		if (lines.length > MAX_LINES) push(`échange trop long : ${lines.length} répliques (max ${MAX_LINES})`);
		for (const l of lines) {
			if (!CREW.includes(l?.speaker)) push(`locuteur hors crew : ${l?.speaker}`);
			else if (!(entry.characters ?? []).includes(l.speaker)) push(`locuteur absent de characters : ${l.speaker}`);
			const text = String(l?.text ?? '');
			if (text.trim() === '') push('réplique vide');
			if (text.length > MAX_LINE_CHARS) push(`réplique trop longue : ${text.length} caractères`);
			for (const ban of STYLE_BANS) if (ban.re.test(text)) push(`${ban.why} : "${text}"`);
		}
	}

	// D3 : tout slot utilisé doit avoir son chemin dans requires. Sans cette
	// règle, une entrée peut être tirée dans un contexte où son slot ne résout
	// pas — et render() jetterait au nez du joueur.
	const requires = entry?.requires ?? [];
	if (!Array.isArray(requires)) push('requires n\'est pas un tableau');
	else {
		for (const path of requires) {
			if (!KNOWN_PATHS.has(path)) push(`chemin inconnu dans requires : ${path} (l'entrée ne serait jamais éligible)`);
		}
		const used = slotsUsed(entry);
		for (const name of used) if (!SLOTS[name]) push(`slot inconnu du catalogue : {${name}}`);
		for (const path of pathsForSlots(used)) {
			if (!requires.includes(path)) push(`slot utilisé sans son chemin dans requires : ${path}`);
		}
	}
	return p;
}

export function validateCorpus(entries) {
	const errors = [];
	const seen = new Set();
	let ok = 0;
	for (const entry of entries) {
		const problems = validateEntry(entry);
		if (seen.has(entry?.id)) problems.push(`id en double : ${entry.id}`);
		seen.add(entry?.id);
		if (problems.length === 0) ok++;
		else for (const problem of problems) errors.push({ id: entry?.id ?? '(sans id)', problem });
	}
	return { ok, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/dialogue-selftest.mjs && npm run selftest:operator
```

Attendu : 36 vérifications au selftest dialogue, chaîne `selftest:operator` verte.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/dialogue/validate.mjs sim/tools/dialogue-selftest.mjs
git commit -m "$(printf 'PHASE 21 : validation du corpus de dialogues (#58)\n\nLes règles d%sécriture de la Bible deviennent mécaniques : crew fermé,\nlongueurs bornées, interdits de style, et surtout la règle D3 — tout\nslot utilisé doit avoir son chemin dans requires.\n\nC%sest ce qui permettra de relire un corpus de 5000 entrées par\néchantillon : le vérifiable est vérifié partout, l%shumain juge le ton.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'")"
```

---

### Task 5: `dedupe.mjs` — quasi-doublons à l'échelle du corpus

**Files:**
- Create: `sim/tools/dialogue/dedupe.mjs`
- Modify: `sim/tools/dialogue-selftest.mjs`

**Interfaces:**
- Consumes: rien du projet.
- Produces:
  - `normalize(text: string) => string`
  - `trigrams(text: string) => Set<string>`
  - `jaccard(a: Set, b: Set) => number`
  - `findDuplicates(entries: object[], { threshold?: number }) => Array<{ a: string, b: string, score: number }>`

**Pourquoi un index inversé.** À 5000 entrées, comparer toutes les paires fait 12,5 millions de comparaisons de `Set`. L'index inversé ne compare que les entrées qui partagent au moins un trigramme, ce qui est le voisinage réel de chaque entrée — deux répliques sans trigramme commun ne peuvent pas dépasser le seuil.

- [ ] **Step 1: Write the failing test**

```js
import { normalize, trigrams, jaccard, findDuplicates } from './dialogue/dedupe.mjs';
```

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/dedupe.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// Détection de quasi-doublons dans le corpus (PHASE 21). Trigrammes normalisés
// + Jaccard : aucune dépendance, aucun embedding. Les doublons que produit un
// LLM se ressemblent lexicalement, pas seulement sémantiquement — c'est
// suffisant, et ça reste vérifiable à la main quand un rapprochement surprend.

export function normalize(text) {
	return String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function trigrams(text) {
	const s = normalize(text);
	const out = new Set();
	for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
	return out;
}

export function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	for (const g of small) if (big.has(g)) inter++;
	return inter / (a.size + b.size - inter);
}

const entryText = (entry) => (entry.lines ?? []).map((l) => l.text).join(' ');

// Index inversé trigramme -> indices. On ne compare une entrée qu'aux entrées
// qui partagent au moins un trigramme avec elle : deux textes sans trigramme
// commun ont un Jaccard nul, les comparer serait du temps perdu.
export function findDuplicates(entries, { threshold = 0.6 } = {}) {
	const grams = entries.map((e) => trigrams(entryText(e)));
	const index = new Map();
	const out = [];

	for (let i = 0; i < entries.length; i++) {
		const neighbours = new Set();
		for (const g of grams[i]) {
			const bucket = index.get(g);
			if (bucket) for (const j of bucket) neighbours.add(j);
		}
		for (const j of neighbours) {
			const score = jaccard(grams[i], grams[j]);
			if (score >= threshold) out.push({ a: entries[j].id, b: entries[i].id, score });
		}
		for (const g of grams[i]) {
			let bucket = index.get(g);
			if (!bucket) index.set(g, (bucket = []));
			bucket.push(i);
		}
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : 42 vérifications, tout passe, et le test des 5000 entrées bien en deçà de sa borne.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/dialogue/dedupe.mjs sim/tools/dialogue-selftest.mjs
git commit -m "$(printf 'PHASE 21 : déduplication du corpus par index inversé de trigrammes (#58)\n\nÀ 5000 entrées, comparer toutes les paires fait 12,5 millions de\ncomparaisons. L%sindex inversé ne compare que les entrées partageant un\ntrigramme : deux textes disjoints ont un Jaccard nul de toute façon.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'")"
```

---

### Task 6: `cadence.mjs` + corpus de départ + pack de secours

Tâche additive : rien n'est supprimé ici, `tools/rtc-model.mjs` continue de tourner. La bascule se fait en Tâche 8, pour que l'arbre reste utilisable entre les deux.

**Files:**
- Create: `sim/tools/dialogue/cadence.mjs`
- Create: `sim/public/dialogue/manifest.json`
- Create: `sim/public/dialogue/acquire_area.json`
- Create: `sim/src/dialogue-fallback.js`
- Modify: `sim/tools/dialogue-selftest.mjs`

**Interfaces:**
- Consumes: `EVENTS` de `catalog.mjs`.
- Produces:
  - `pickInRange(range: [number,number], rng) => number`
  - `nextGapMs(event: string, rng) => number`
  - `planExchange(lines: Array<{speaker,text}>, event: string, rng) => Array<{ speaker, text, atMs }>`
  - `FALLBACK: object[]` (depuis `src/dialogue-fallback.js`) — entrées sans aucun `requires`
  - Format de shard : `{ "event": "<ID>", "entries": [ … ] }` · manifeste : `{ "version": 1, "shards": { "<ID>": "<fichier>.json" } }`

- [ ] **Step 1: Write the failing test**

```js
import { pickInRange, nextGapMs, planExchange } from './dialogue/cadence.mjs';
import { readFileSync } from 'node:fs';
```

```js
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
```

Et pour le pack de secours, dans le même fichier :

```js
import { FALLBACK } from '../src/dialogue-fallback.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/dialogue-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./dialogue/cadence.mjs`.

- [ ] **Step 3: Write `cadence.mjs`**

```js
// Cadence d'affichage d'un échange (PHASE 21). Pur : src/dialogue.js ne fait
// que poser des minuteurs sur le plan que ce module calcule — il ne reste donc
// aucune logique testable coincée derrière le DOM.
import { EVENTS } from './catalog.mjs';

const DEFAULT_GAP = [5000, 12000];
const DEFAULT_BEAT = [700, 1600];

export function pickInRange([lo, hi], rng) {
	return lo + rng() * (hi - lo);
}

export function nextGapMs(event, rng) {
	return pickInRange(EVENTS[event]?.gapMs ?? DEFAULT_GAP, rng);
}

// Les répliques d'un même échange tombent une par une, avec un battement entre
// elles : c'est ce qui fait « quelqu'un qui tape » plutôt qu'un bloc collé.
export function planExchange(lines, event, rng) {
	const beat = EVENTS[event]?.beatMs ?? DEFAULT_BEAT;
	let at = 0;
	return lines.map((line, i) => {
		if (i > 0) at += pickInRange(beat, rng);
		return { ...line, atMs: at };
	});
}
```

- [ ] **Step 4: Write the seed corpus**

Créer `sim/public/dialogue/acquire_area.json`. Ce sont les 27 lignes de `tools/rtc-model.mjs` **découpées en échanges** et **débarrassées de `vex`** : ses répliques d'exécutante passent à `mikhail`, celles qui sont purement machinales à `cron` (D7).

```json
{
  "event": "ACQUIRE_AREA",
  "entries": [
    { "id": "acquire_area/0001", "events": ["ACQUIRE_AREA"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": [],
      "lines": [{ "speaker": "root", "text": "new sector queued" },
                { "speaker": "mikhail", "text": "on it" }] },

    { "id": "acquire_area/0002", "events": ["ACQUIRE_AREA"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": ["area.name"],
      "lines": [{ "speaker": "root", "text": "{location}" },
                { "speaker": "mikhail", "text": "obviously" }] },

    { "id": "acquire_area/0003", "events": ["ACQUIRE_AREA"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": ["terrain.tiles"],
      "lines": [{ "speaker": "root", "text": "how many tiles" },
                { "speaker": "mikhail", "text": "{terrain_size}" },
                { "speaker": "root", "text": "that is a lot" },
                { "speaker": "mikhail", "text": "depends what you count" }] },

    { "id": "acquire_area/0004", "events": ["ACQUIRE_AREA"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": [],
      "lines": [{ "speaker": "mikhail", "text": "you counting drones or tiles" },
                { "speaker": "root", "text": "does it matter" },
                { "speaker": "mikhail", "text": "yes" }] },

    { "id": "acquire_area/0005", "events": ["ACQUIRE_AREA"], "rarity": "RARE",
      "characters": ["root", "jensen"], "requires": [],
      "lines": [{ "speaker": "jensen", "text": "it matters" },
                { "speaker": "root", "text": "why are you even in this channel" },
                { "speaker": "jensen", "text": "no comment" }] },

    { "id": "acquire_area/0006", "events": ["ACQUIRE_AREA", "TERRAIN_PROGRESS"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": [],
      "lines": [{ "speaker": "root", "text": "mesh is coming in fine" },
                { "speaker": "mikhail", "text": "define fine" },
                { "speaker": "root", "text": "no holes so far" },
                { "speaker": "mikhail", "text": "so far is not a guarantee" }] },

    { "id": "acquire_area/0007", "events": ["ACQUIRE_AREA"], "rarity": "COMMON",
      "characters": ["root", "mikhail"], "requires": [],
      "lines": [{ "speaker": "root", "text": "ship it when it lands" },
                { "speaker": "mikhail", "text": "no" },
                { "speaker": "root", "text": "why" },
                { "speaker": "mikhail", "text": "because it is not landed yet" },
                { "speaker": "root", "text": "fair" }] },

    { "id": "acquire_area/0008", "events": ["ACQUIRE_AREA", "TERRAIN_PROGRESS"], "rarity": "COMMON",
      "characters": ["root", "cron"], "requires": [],
      "lines": [{ "speaker": "root", "text": "textures baking" },
                { "speaker": "cron", "text": "checksum queued" }] },

    { "id": "acquire_area/0009", "events": ["ACQUIRE_AREA"], "rarity": "VERY_RARE",
      "characters": ["root", "jensen"], "requires": [],
      "lines": [{ "speaker": "jensen", "text": "watching" },
                { "speaker": "root", "text": "watching what" },
                { "speaker": "jensen", "text": "no comment" }] },

    { "id": "acquire_area/0010", "events": ["ACQUIRE_AREA", "TERRAIN_PROGRESS"], "rarity": "COMMON",
      "characters": ["cron"], "requires": [],
      "lines": [{ "speaker": "cron", "text": "cache warm" }] },

    { "id": "acquire_area/0011", "events": ["ACQUIRE_AREA"], "rarity": "UNCOMMON",
      "characters": ["root", "mikhail"], "requires": [],
      "lines": [{ "speaker": "root", "text": "ship it" },
                { "speaker": "mikhail", "text": "no" },
                { "speaker": "root", "text": "it works" },
                { "speaker": "mikhail", "text": "that is not the same thing" }] }
  ]
}
```

Créer `sim/public/dialogue/manifest.json` :

```json
{ "version": 1, "shards": { "ACQUIRE_AREA": "acquire_area.json" } }
```

- [ ] **Step 5: Write the fallback pack**

Créer `sim/src/dialogue-fallback.js`. Il est **compilé dans le bundle** : c'est le seul dialogue garanti disponible si le `fetch` d'un shard échoue (build statique servi de travers, disque lent). Aucune entrée ne demande de contexte, par construction.

```js
// Pack de secours du moteur de dialogue (PHASE 21, D2). Minuscule et sans
// aucun `requires` : c'est ce qui s'affiche quand le shard n'a pas pu être
// chargé. Un écran muet serait pire qu'un écran répétitif.
export const FALLBACK = [
	{ id: 'fallback/0001', events: ['AREA_SEARCH', 'PROBE_AREA'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'anything down there' },
	          { speaker: 'mikhail', text: 'define anything' }] },
	{ id: 'fallback/0002', events: ['ACQUIRE_AREA', 'TERRAIN_PROGRESS'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'ship it' },
	          { speaker: 'mikhail', text: 'no' }] },
	{ id: 'fallback/0003', events: ['ACQUIRE_AREA', 'TERRAIN_PROGRESS'], rarity: 'COMMON',
	  characters: ['cron'], requires: [],
	  lines: [{ speaker: 'cron', text: 'cache warm' }] },
	{ id: 'fallback/0004', events: ['TARGET_SCAN', 'TARGET_SELECTED', 'WEATHER'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'mikhail', text: 'that one is not worth the trip' },
	          { speaker: 'root', text: 'noted' }] },
	{ id: 'fallback/0005', events: ['TARGET_ANALYSIS', 'HACK', 'MANUAL_OVERRIDE', 'JACK_IN'], rarity: 'COMMON',
	  characters: ['root', 'mikhail'], requires: [],
	  lines: [{ speaker: 'root', text: 'channel is open' },
	          { speaker: 'mikhail', text: 'it is not the same thing as ready' }] },
];
```

- [ ] **Step 6: Run tests**

```bash
cd sim && node tools/dialogue-selftest.mjs && npm run selftest:operator
```

Attendu : 48 vérifications, chaîne verte. Le test « le corpus livré doit être irréprochable » est le premier à s'exécuter sur de vraies données : s'il échoue, corriger le corpus, **jamais** assouplir `validate.mjs`.

- [ ] **Step 7: Commit**

```bash
git add sim/tools/dialogue/cadence.mjs sim/public/dialogue sim/src/dialogue-fallback.js sim/tools/dialogue-selftest.mjs
git commit -m "$(printf 'PHASE 21 : cadence, corpus de départ et pack de secours (#58)\n\nLes 27 lignes du RTC v0 deviennent 11 échanges validés, vex réparti\nentre mikhail et cron. Le pack de secours, sans aucun requires, garantit\nqu%sun écran n%sest jamais muet si le shard ne se charge pas.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'")"
```

---

### Task 7: `src/dialogue.js` — chargement, mémoire, montage

**Files:**
- Create: `sim/src/dialogue.js`
- Test: manuel au navigateur en Tâche 8 (ce module est de la colle : toute sa logique testable a été poussée dans `engine.mjs` et `cadence.mjs`).

**Interfaces:**
- Consumes: `select`, `emptyMemory`, `rngFrom` de `engine.mjs` · `planExchange`, `nextGapMs` de `cadence.mjs` · `render` de `render.mjs` · `EVENTS` de `catalog.mjs` · `FALLBACK` de `dialogue-fallback.js` · `getOperator`, `patch` de `operator.js`.
- Produces:
  - `loadShard(event: string) => Promise<object[]>`
  - `mount(el: HTMLElement, { event, context }) => () => void` (la fonction rendue arrête tout)
  - `sayOnce(event: string, context: object) => Promise<Array<{speaker,text}>|null>`

- [ ] **Step 1: Write the implementation**

```js
// Colle navigateur du moteur de dialogue (PHASE 21). Tout ce qui est testable
// vit dans tools/dialogue/ ; ici il ne reste que du réseau, du DOM et des
// minuteurs.
//
// Deux invariants hérités de PHASE 05, non négociables : ce module ne bloque
// JAMAIS rien (aucun await sur son chargement dans un chemin d'interaction), et
// il n'est JAMAIS une source d'information sur l'état réel du pipeline.
import { EVENTS } from '../tools/dialogue/catalog.mjs';
import { select, emptyMemory, rngFrom } from '../tools/dialogue/engine.mjs';
import { planExchange, nextGapMs } from '../tools/dialogue/cadence.mjs';
import { render } from '../tools/dialogue/render.mjs';
import { FALLBACK } from './dialogue-fallback.js';
import { getOperator, patch } from './operator.js';

const shards = new Map();   // event -> Promise<entries[]>
let memory = null;          // hydratée à la première utilisation

// Le corpus d'un événement, chargé une fois par onglet. Un échec quel qu'il
// soit retombe sur le pack embarqué : un écran muet serait pire qu'un écran
// répétitif, et surtout une erreur réseau n'a pas le droit de casser un écran.
export function loadShard(event) {
	if (shards.has(event)) return shards.get(event);
	const file = EVENTS[event]?.shard;
	const p = (!file ? Promise.resolve([]) : fetch(`/dialogue/${file}.json`)
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
		.then((s) => (Array.isArray(s.entries) ? s.entries : [])))
		.catch(() => FALLBACK.filter((e) => e.events.includes(event)));
	shards.set(event, p);
	return p;
}

function hydrateMemory() {
	if (memory) return memory;
	const stored = getOperator()?.dialogueMemory;
	// Une clé absente se lit comme une mémoire vierge : pas de migration, pas
	// de bump de schéma, un opérateur d'avant PHASE 21 marche tel quel (D6).
	memory = (stored && Array.isArray(stored.ring)) ? stored : emptyMemory();
	return memory;
}

function persistMemory() {
	try { patch('dialogueMemory', memory); } catch { /* pas d'opérateur chargé : tant pis, c'est cosmétique */ }
}

// Un seul échange, sans minuteur : pour les écrans qui parlent une fois.
export async function sayOnce(event, context) {
	const pool = await loadShard(event);
	const mem = hydrateMemory();
	const r = select({ event, pool, ctx: context, memory: mem, rng: Math.random });
	memory = r.memory;
	persistMemory();
	if (!r.entry) return null;
	try { return render(r.entry, context); }
	catch (e) { console.warn('[dialogue] entrée non rendable, ignorée', e); return null; }
}

// Flux continu dans un <pre>. Rend un `stop()` — l'appeler est OBLIGATOIRE
// quand l'écran disparaît, sinon les minuteurs survivent à leur conteneur.
export function mount(el, { event, context }) {
	let stopped = false;
	const timers = new Set();
	const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
	const rng = Math.random;

	const append = (speaker, text) => {
		if (stopped || !el.isConnected) return;
		el.appendChild(document.createTextNode(`\n> ${speaker}\n${text}\n`));
		while (el.childNodes.length > 400) el.removeChild(el.firstChild);
		el.scrollTop = el.scrollHeight;
	};

	const tick = async () => {
		if (stopped) return;
		const ctx = typeof context === 'function' ? context() : context;
		const pool = await loadShard(event);
		if (stopped) return;
		const mem = hydrateMemory();
		const r = select({ event, pool, ctx, memory: mem, rng });
		memory = r.memory;
		persistMemory();
		if (r.entry) {
			let lines = null;
			try { lines = render(r.entry, ctx); }
			catch (e) { console.warn('[dialogue] entrée non rendable, ignorée', e); }
			if (lines) for (const l of planExchange(lines, event, rng)) later(() => append(l.speaker, l.text), l.atMs);
		}
		later(tick, nextGapMs(event, rng));
	};

	later(tick, nextGapMs(event, rng));

	return () => {
		stopped = true;
		for (const id of timers) clearTimeout(id);
		timers.clear();
	};
}
```

- [ ] **Step 2: Verify the module at least parses and imports cleanly**

```bash
cd sim && node --input-type=module -e "import('./src/dialogue-fallback.js').then(m => console.log('fallback ok', m.FALLBACK.length))"
cd sim && npm run build
```

Attendu : le build Vite passe. `src/dialogue.js` n'est encore importé par personne — c'est normal, la Tâche 8 le branche.

- [ ] **Step 3: Commit**

```bash
git add sim/src/dialogue.js
git commit -m "$(printf 'PHASE 21 : colle navigateur du moteur de dialogue (#58)\n\nChargement des shards à la demande avec repli sur le pack embarqué,\nhydratation de la mémoire depuis l%sétat opérateur sans migration, et un\nmount() qui rend un stop() — les minuteurs ne survivent pas à l%sécran.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'")"
```

---

### Task 8: `dialogue-context.js` + bascule du scanner + retrait de `rtc-model.mjs`

C'est la tâche où l'ancien RTC disparaît. Elle est atomique : le module supprimé et son unique appelant changent dans le même commit.

**Files:**
- Create: `sim/src/dialogue-context.js`
- Modify: `sim/src/scanner.js` (import ligne 21 · `.sc-rtc` lignes 662-671 · `clearInterval(rtcTimer)` lignes 703 et 713 · gabarit du panneau de recherche vers la ligne 110)
- Delete: `sim/tools/rtc-model.mjs`, `sim/tools/rtc-selftest.mjs`
- Modify: `sim/package.json` (retirer `node tools/rtc-selftest.mjs` de `selftest:operator`)

**Interfaces:**
- Consumes: `today`, `headline`, `formatVisibility` de `tools/lib/weather.mjs` · `PROFILES` de `drone-profiles.js` · `getOperator` de `operator.js`.
- Produces:
  - `machineContext() => { gpu: string|null, display: string|null }`
  - `weatherContext(snapshot) => { summary, windMs, rain, visibility } | {}`
  - `targetContext(candidate, hackType) => { video, rssiDbm, hackType } | {}`
  - `droneContext(family) => { label: string } | {}`
  - `acquisitionContext({ name, tiles, pipeline }) => object`
  - `scanContext({ scan, weather, candidate, hackType, family }) => object`

**Champs météo réels** (vérifiés dans `tools/lib/weather.mjs`) : un jour porte `regime`, `windSpeed`, `windDir`, `rateMmH`, `visibilityM`, `cloudPct`. `today(snapshot)` rend le jour courant ou `null`. `headline(day)` rend `"CLEAR / LIGHT BREEZE"`.

- [ ] **Step 1: Write `src/dialogue-context.js`**

```js
// Assemblage du contexte de dialogue (PHASE 21). Ce module ne FORMATE rien —
// le formatage appartient à la table des slots de catalog.mjs. Il ne fait que
// pré-extraire les valeurs de l'état vivant, avec une règle : ce qui n'est pas
// connu vaut `null`, ce qui rend simplement inéligibles les entrées qui en
// dépendaient. Un contexte pauvre appauvrit la conversation, il ne la casse pas.
import { today, headline, formatVisibility } from '../tools/lib/weather.mjs';
import { PROFILES } from './drone-profiles.js';
import { getOperator } from './operator.js';

// Même lecture que src/bootstrap.js:35. Silencieuse : sur un navigateur qui
// masque l'extension, on n'a pas de GPU, et c'est tout.
let machine = null;
export function machineContext() {
	if (machine) return machine;
	let gpu = null;
	try {
		const gl = document.createElement('canvas').getContext('webgl');
		const ext = gl?.getExtension('WEBGL_debug_renderer_info');
		gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
	} catch { gpu = null; }
	const display = typeof window !== 'undefined' && window.screen
		? `${window.screen.width} × ${window.screen.height}` : null;
	machine = { gpu, display };
	return machine;
}

export function weatherContext(snapshot) {
	const day = today(snapshot);
	if (!day) return {};
	return {
		summary: headline(day),
		windMs: day.windSpeed,
		// Pas de pluie -> null : les répliques sur la pluie ne sortent que
		// quand il pleut vraiment. C'est le mécanisme d'éligibilité qui fait
		// le travail d'un `if`, sans qu'aucune entrée n'ait à le savoir.
		rain: day.rateMmH >= 0.05 ? `${day.rateMmH.toFixed(1)} mm/h` : null,
		visibility: formatVisibility(day.visibilityM),
	};
}

export function targetContext(candidate, hackType = null) {
	if (!candidate) return {};
	return {
		video: candidate.mode && candidate.mode !== 'UNKNOWN' ? candidate.mode : null,
		rssiDbm: candidate.rssiDbm ?? null,
		hackType,
	};
}

export function droneContext(family) {
	const p = PROFILES[family];
	return p ? { label: p.label } : {};
}

const operatorContext = () => {
	const op = getOperator();
	return op ? { name: op.name } : {};
};

export function acquisitionContext({ name, tiles, pipeline } = {}) {
	return {
		operator: operatorContext(),
		machine: machineContext(),
		area: { name: name ?? null },
		terrain: {
			tiles: Number.isFinite(tiles) && tiles > 0 ? tiles : null,
			megabytes: Number.isFinite(pipeline?.bytes) ? pipeline.bytes / 1e6 : null,
		},
	};
}

export function scanContext({ scan, weather, candidate, hackType, family } = {}) {
	return {
		operator: operatorContext(),
		machine: machineContext(),
		weather: weatherContext(weather),
		scan: { count: scan?.candidates?.length ?? null },
		target: targetContext(candidate, hackType),
		drone: droneContext(family),
	};
}
```

> **Note pour l'implémenteur :** vérifier le nom réel du champ d'octets dans `pipeline` (émis par `tools/map-api-plugin.mjs` via l'évènement SSE `stat`, consommé dans `pipelineStats()` de `tools/scanner-model.mjs`). Si ce n'est pas `bytes`, ajuster — et si aucun total d'octets n'est disponible à ce stade, laisser `megabytes: null` : le slot `{terrain_mb}` sera simplement inéligible, ce qui est un comportement correct et non un manque.

- [ ] **Step 2: Bascule du panneau d'acquisition**

Dans `sim/src/scanner.js`, remplacer l'import ligne 21 :

```js
// avant
import { rtcScript } from '../tools/rtc-model.mjs';
// après
import { mount, sayOnce } from './dialogue.js';
import { acquisitionContext, scanContext } from './dialogue-context.js';
```

Remplacer le bloc RTC (lignes 662-671) :

```js
		// RTC : de la couleur, jamais une source d'information sur le pipeline
		// réel. Le corpus est tiré par le moteur de dialogue (PHASE 21) — le
		// contexte est une FONCTION parce que `pipeline` se remplit en cours de
		// route et que le crew doit pouvoir en parler quand il arrive.
		const stopRtc = mount(panel.querySelector('.sc-rtc'), {
			event: 'ACQUIRE_AREA',
			context: () => acquisitionContext({ name, tiles: expected, pipeline }),
		});
```

Remplacer les deux `clearInterval(rtcTimer);` (dans le gestionnaire `.sc-leave` et dans `finish()`) par `stopRtc();`. **Vérifier qu'il n'en reste aucun :**

```bash
cd sim && grep -n "rtcTimer\|rtcScript" src/scanner.js
```

Attendu : aucune sortie.

- [ ] **Step 3: Ajouter les voix de recherche et de sonde**

Dans le gabarit du panneau de recherche (près de la ligne 110, celle du bouton `[ ACQUIRE AREA ]`), ajouter le même bloc que celui déjà présent dans `JOB_PANEL` :

```html
<section class="sc-block sc-log-block sc-rtc-block">
	<pre class="sc-h">RTC // INTERNAL</pre>
	<pre class="sc-log sc-rtc"></pre>
</section>
```

Monter `AREA_SEARCH` dessus quand le panneau s'affiche, et **arrêter le montage** quand le panneau est remplacé par `JOB_PANEL` (`panel.innerHTML = JOB_PANEL` détruit le nœud, mais pas les minuteurs — c'est exactement la fuite que `stop()` existe pour éviter) :

```js
let stopSearch = null;
// … à l'affichage du panneau de recherche :
stopSearch?.();
stopSearch = mount(panel.querySelector('.sc-rtc'), {
	event: 'AREA_SEARCH',
	context: () => scanContext({}),
});
// … tout en haut de watchJob(), AVANT `panel.innerHTML = JOB_PANEL` :
stopSearch?.(); stopSearch = null;
```

Pour la sonde, un seul échange après le retour de `describe` — jamais un blocage, d'où l'absence d'`await` sur le chemin d'interaction :

```js
sayOnce('PROBE_AREA', acquisitionContext({ name: $('.sc-name').value.trim(), tiles: state.describe?.estimate?.tiles }))
	.then((lines) => {
		const el = panel.querySelector('.sc-rtc');
		if (!lines || !el) return;
		for (const l of lines) el.appendChild(document.createTextNode(`\n> ${l.speaker}\n${l.text}\n`));
		el.scrollTop = el.scrollHeight;
	});
```

- [ ] **Step 4: Retirer l'ancien RTC**

```bash
cd sim && git rm tools/rtc-model.mjs tools/rtc-selftest.mjs
```

Puis retirer ` && node tools/rtc-selftest.mjs` de `selftest:operator` dans `package.json`.

- [ ] **Step 5: Vérifier**

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
cd sim && grep -rn "rtc-model\|rtcScript" src/ tools/ package.json
```

Attendu : chaînes vertes, build OK, et **aucune** référence résiduelle.

- [ ] **Step 6: Vérification au navigateur (obligatoire — c'est le premier rendu réel)**

```bash
cd sim && npm run dev
```

Ouvrir le Global Scanner, lancer une acquisition, et vérifier :
- les répliques tombent **une par une**, pas en bloc ;
- aucun `{slot}` visible à l'écran ;
- sur une acquisition longue, aucune boucle reconnaissable ;
- **quitter l'écran en plein échange** (`LEAVE`) puis y revenir : aucune réplique ne surgit par-dessus le nouvel écran, et la console ne montre aucune erreur ;
- le job continue côté serveur pendant l'absence (invariant PHASE 05).

- [ ] **Step 7: Commit**

```bash
git add -A sim/src sim/tools sim/package.json
git commit -m "$(printf 'PHASE 21 : le scanner passe au moteur de dialogue (#58)\n\nrtc-model.mjs et son selftest disparaissent : le script figé de 27 lignes\nest remplacé par un tirage contextuel. Le contexte est une fonction, pour\nque le crew puisse parler des statistiques du pipeline à mesure.\n\nAjoute les voix AREA_SEARCH et PROBE_AREA. Chaque montage rend un stop()\nappelé quand le panneau change — les minuteurs ne survivent pas au nœud.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' )"
```

---

### Task 9: voix avant-vol — TARGET SCAN et HACK

**Files:**
- Modify: `sim/src/target-scan.js` (`runTargetScan`, ligne 16 · gabarits lignes 31 et 83)
- Modify: `sim/src/hack.js` (`runHack`, ligne 40)
- Modify: `sim/src/main.js` (lignes 1343 et 1357 : passer `family` et le candidat au contexte)
- Modify: `sim/src/style.css`

**Interfaces:**
- Consumes: `mount`, `sayOnce` de `dialogue.js` · `scanContext` de `dialogue-context.js` · `sinceEvent` de `engine.mjs`.
- Produces: aucune API nouvelle.

**Contrainte D9, non négociable.** Dans `hack.js`, le crew parle **avant** l'armement du CONTROL VECTOR, jamais pendant. Le point de bascule est `arm()` (voir le commentaire ligne 12) : appeler `stop()` juste avant de l'armer.

- [ ] **Step 1: TARGET SCAN — la liste**

**Piège à désamorcer d'abord.** Dans `runTargetScan`, `draw()` fait `s.box.innerHTML = …` **à chaque déplacement du curseur** (ligne 31). Monter le RTC dans `s.box` le détruirait à la première flèche, en laissant les minuteurs tourner sur un nœud orphelin — la fuite exacte que `stop()` existe pour éviter, mais déclenchée par une frappe et donc invisible en relecture.

Créer le bloc RTC **en dehors** de la zone redessinée : après l'appel initial à `draw()`, ajouter le nœud par `appendChild` sur `s.box`, et faire que `draw()` ne remplace plus que le `<pre>` de la liste au lieu de tout `s.box`. Vérifier ensuite qu'une dizaine de ↑/↓ laisse le RTC en place et son historique intact.

Puis monter `TARGET_SCAN` sur ce nœud, avec le contexte complet :

```js
const stopScan = mount(s.box.querySelector('.sc-rtc'), {
	event: 'TARGET_SCAN',
	context: () => scanContext({ scan, weather }),
});
```

`resolve()` doit être précédé de `stopScan()` **sur tous les chemins de sortie** (CONFIRM, BACK, et la sortie clavier). Chercher chaque `resolve(` de la fonction et vérifier qu'aucun ne s'échappe sans arrêter le montage.

- [ ] **Step 2: TARGET SCAN — la fiche, et WEATHER qui ne double pas**

À l'ouverture de la fiche (`sheet(cursor)`, ligne 83), un seul échange `TARGET_SELECTED`. La météo est déjà affichée par `conditionsBlock` sur cet écran : pour éviter que le crew la commente juste après en avoir parlé, `WEATHER` n'est tiré **que si** `TARGET_SELECTED` n'a rien dit — c'est précisément le travail de `sinceEvent`.

```js
sayOnce('TARGET_SELECTED', scanContext({ scan, weather, candidate: scan.candidates[index] }))
	.then((lines) => lines
		? paint(lines)
		: sayOnce('WEATHER', scanContext({ scan, weather })).then((w) => w && paint(w)));
```

où `paint` est ce helper local, déclaré dans la fiche :

```js
const paint = (lines) => {
	const el = s2.box.querySelector('.sc-rtc');
	if (!el) return;
	for (const l of lines) el.appendChild(document.createTextNode(`\n> ${l.speaker}\n${l.text}\n`));
	el.scrollTop = el.scrollHeight;
};
```

- [ ] **Step 3: HACK — parler avant, se taire pendant**

Dans `runHack`, monter `TARGET_ANALYSIS` pendant la séquence automatique, puis couper net :

```js
const stopHack = mount(box.querySelector('.sc-rtc'), {
	event: 'TARGET_ANALYSIS',
	context: () => scanContext({ candidate: null, hackType, family }),
});
// … juste AVANT arm() — D9 : la culmination est une seule chose à la fois.
stopHack();
```

`MANUAL_OVERRIDE` et `JACK_IN` sont déclarés au catalogue et alimentés par le corpus, mais **ne sont pas montés** : ce sont les instants du rituel, et D9 les protège. Ils restent disponibles pour un écran futur.

- [ ] **Step 4: `main.js` — passer la famille**

Ligne 1357, `runHack` reçoit déjà `family: cand._family` : rien à changer. Ligne 1343, vérifier que `scanWeather` est bien le snapshot passé à `runTargetScan` — c'est lui qui alimente `weatherContext`.

- [ ] **Step 5: CSS**

Dans `sim/src/style.css`, faire porter les règles `.sc-rtc` existantes (lignes 390-391) aux écrans de terminal, en ajoutant le sélecteur du conteneur d'écran à côté de celui du scanner. **Ne pas dupliquer les règles** : une seule langue visuelle pour toutes les voix du crew.

- [ ] **Step 6: Vérification au navigateur**

```bash
cd sim && npm run dev
```

Parcourir la chaîne complète : Global Scanner → TARGET SCAN → fiche → CONFIRM → HACK → rituel → vol.

- aucune réplique **pendant** la fenêtre de burst du rituel (D9) ;
- aucun bouton ne devient lent ou inerte à cause du RTC (invariant PHASE 05) ;
- passer très vite d'un écran à l'autre : aucune réplique retardataire ne s'affiche sur l'écran suivant ;
- aucun `{slot}` visible nulle part ;
- `npm run selftest` toujours vert.

- [ ] **Step 7: Commit**

```bash
git add sim/src
git commit -m "$(printf 'PHASE 21 : voix du crew sur les écrans avant-vol (#58)\n\nTARGET SCAN, la fiche cible et l%sanalyse du hack. La météo n%'est\ncommentée que si la cible ne l%sa pas déjà été — sinon le crew répète\nl%sécran qu%son vient de lire.\n\nRien pendant le burst du rituel (D9) : la culmination est une seule\nchose à la fois.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'" "'")"
```

---

### Task 10: `generate.mjs` + `prompts/` — l'atelier

**Correction à la spec.** La spec prévoit deux dos pour `callModel()` : l'API Messages via `fetch` si `ANTHROPIC_API_KEY` est présent, sinon `claude -p`. **On n'implémente que `claude -p`.** Trois raisons : il n'y a aucune clé dans l'environnement, donc le chemin API ne serait ni exercé ni testé ; l'écrire proprement demanderait le SDK officiel `@anthropic-ai/sdk`, ce qui contredit la contrainte « aucune nouvelle dépendance » ; et du code jamais exécuté est du code faux qui s'ignore. Une issue de suivi est ouverte en Tâche 13 pour le chemin SDK, à écrire par qui aura une clé pour le vérifier. La Tâche 13 corrige la spec.

**Forme de sortie vérifiée** (`claude -p --output-format json`, testé) : un objet avec `is_error` (booléen) et `result` (le texte de la réponse). Le prompt passe par **stdin**, pas en argument — un prompt de lot dépasse allègrement les limites d'argument.

**Files:**
- Create: `sim/tools/dialogue/generate.mjs`
- Create: `sim/tools/dialogue/inspect.mjs`
- Create: `sim/tools/dialogue/prompts/crew.md`, `prompts/style.md`, `prompts/events/<event>.md`
- Modify: `sim/package.json` (scripts `dialogue:gen`, `dialogue:check`, `dialogue:inspect`)

**Interfaces:**
- Consumes: `validateCorpus` de `validate.mjs` · `findDuplicates` de `dedupe.mjs` · `render` de `render.mjs` · `EVENTS`, `RARITY` de `catalog.mjs`.
- Produces: trois exécutables en ligne de commande. **Aucun module de `src/` ne doit jamais les importer.**

- [ ] **Step 1: Write the prompt files**

`prompts/crew.md` — la bible des personnages, en anglais (c'est le prompt d'un rédacteur anglophone) : root (tranche, concis, humour sec, décide vite), jensen (autonome, évasif, ambigu, apparaît rarement, n'explique jamais le lore de V1), mikhail (garde-fou technique, précis, factuel, contredit root ; sa nationalité n'est **pas** sa personnalité et ne doit jamais être un gimmick), cron (processus automatique, pas un personnage : constats machinaux, jamais d'opinion).

`prompts/style.md` — court, sec, technique quand il faut, parfois drôle, parfois banal, parfois étrange ; atmosphère logiciel 1998-2003 ; anglais uniquement. Et les interdits, mot pour mot ceux que `validate.mjs` sait attraper — le prompt et le validateur doivent dire la même chose, sinon on génère du rebut à la chaîne.

`prompts/events/<event>.md` — un par événement : ce qui se passe à l'écran, ce que le crew peut plausiblement en savoir, la liste des slots disponibles avec leur chemin, et **ce qu'il ne doit surtout pas dire** (par exemple : ne jamais annoncer une durée, un pourcentage ou un état réel du pipeline — invariant PHASE 05).

- [ ] **Step 2: Write `generate.mjs`**

```js
// Atelier de génération du corpus (PHASE 21). OUTIL DE DÉVELOPPEMENT : rien
// sous src/ ne doit importer ce fichier, et le selftest le vérifie. Le jeu
// livré ne contient que des données.
//
//   node tools/dialogue/generate.mjs --event ACQUIRE_AREA --count 200
//     [--batch 20] [--rarity COMMON] [--model claude-opus-5] [--dry-run]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EVENTS } from './catalog.mjs';
import { validateEntry } from './validate.mjs';
import { findDuplicates } from './dedupe.mjs';

const MODEL = 'claude-opus-5';

// Un lot impose SA distribution de formes. C'est le levier principal contre
// l'effondrement stylistique : 200 entrées demandées d'un bloc convergent vers
// le même rythme, 10 lots de formes différentes non.
const FORMS = [
	'a single deadpan one-liner from one character',
	'a two-line exchange, question then flat answer',
	'a two-line exchange where the second line disagrees',
	'a three-line exchange that ends without resolution',
	'an observation nobody answers',
	'an interruption: one character cuts the other off',
	'a technical remark that is mundane, not clever',
	'a short disagreement about whether something is correct',
	'a rare cryptic remark that explains nothing',
];

function args() {
	const a = {};
	for (let i = 2; i < process.argv.length; i++) {
		const k = process.argv[i];
		if (k.startsWith('--')) a[k.slice(2)] = process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i];
	}
	return a;
}

// Le prompt passe par stdin : un lot dépasse les limites d'argument, et une
// erreur là-dessus est silencieuse et pénible à diagnostiquer.
function callModel(prompt, model = MODEL) {
	return new Promise((resolve, reject) => {
		const p = spawn('claude', ['-p', '--output-format', 'json', '--model', model]);
		let out = '', err = '';
		p.stdout.on('data', (d) => { out += d; });
		p.stderr.on('data', (d) => { err += d; });
		p.on('close', (code) => {
			if (code !== 0) return reject(new Error(`claude a rendu ${code} : ${err.slice(0, 400)}`));
			let parsed;
			try { parsed = JSON.parse(out); } catch { return reject(new Error(`sortie illisible : ${out.slice(0, 400)}`)); }
			if (parsed.is_error) return reject(new Error(`claude en erreur : ${String(parsed.result).slice(0, 400)}`));
			resolve(String(parsed.result ?? ''));
		});
		p.stdin.end(prompt);
	});
}

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

const shardPath = (event) => new URL(`../../public/dialogue/${EVENTS[event].shard}.json`, import.meta.url);

function loadShard(event) {
	const path = shardPath(event);
	if (!existsSync(path)) return { event, entries: [] };
	return JSON.parse(readFileSync(path, 'utf8'));
}

// Le digest : les premières répliques déjà écrites pour cet événement. Assez
// pour que le modèle voie où il s'est déjà promené, assez court pour ne pas
// noyer le prompt.
const digest = (entries) => entries.slice(-160).map((e) => `- ${e.lines[0].text}`).join('\n');

function buildPrompt({ event, entries, rarity, forms, count }) {
	return [
		read('prompts/crew.md'),
		read('prompts/style.md'),
		read(`prompts/events/${EVENTS[event].shard}.md`),
		`\n# This batch\n`,
		`Write exactly ${count} dialogue entries for the event ${event}.`,
		`Every entry in this batch has rarity ${rarity}.`,
		`Use these shapes, one per entry, in order:\n${forms.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
		`\n# Already written for this event — do not go near these again\n${digest(entries) || '(nothing yet)'}`,
		`\n# Output\n`,
		'Reply with a JSON array and nothing else. No prose, no code fence.',
		'Each element: {"characters":[...],"requires":[...],"lines":[{"speaker":"...","text":"..."}]}',
		'`requires` lists the state paths of every slot used in the lines. If an entry uses no slot, `requires` is [].',
	].join('\n');
}

// Le modèle enrobe volontiers sa réponse. On récupère le premier tableau JSON.
function parseEntries(text) {
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start < 0 || end < 0) throw new Error(`aucun tableau JSON dans la réponse : ${text.slice(0, 300)}`);
	return JSON.parse(text.slice(start, end + 1));
}

async function main() {
	const a = args();
	const event = a.event;
	if (!EVENTS[event]) throw new Error(`--event manquant ou inconnu (${event})`);
	const total = Number(a.count ?? 100);
	const size = Number(a.batch ?? 20);
	const rarity = a.rarity ?? 'COMMON';
	const model = a.model ?? MODEL;

	const shard = loadShard(event);
	let seq = shard.entries.length;
	let kept = 0, rejected = 0;

	for (let done = 0; done < total; done += size) {
		const n = Math.min(size, total - done);
		const forms = Array.from({ length: n }, (_, i) => FORMS[(done + i) % FORMS.length]);
		const text = await callModel(buildPrompt({ event, entries: shard.entries, rarity, forms, count: n }), model);

		for (const raw of parseEntries(text)) {
			const entry = {
				id: `${EVENTS[event].shard}/${String(++seq).padStart(4, '0')}`,
				events: [event], rarity,
				characters: raw.characters, requires: raw.requires ?? [], lines: raw.lines,
			};
			const problems = validateEntry(entry);
			if (problems.length) { rejected++; console.warn(`  rejet ${entry.id} : ${problems[0]}`); continue; }
			shard.entries.push(entry);
			kept++;
		}
		console.log(`lot ${done / size + 1} : ${kept} gardées, ${rejected} rejetées`);
	}

	// Déduplication en dernier : une entrée peut être irréprochable et redite.
	const dups = findDuplicates(shard.entries, { threshold: 0.75 });
	const drop = new Set(dups.map((d) => d.b));
	shard.entries = shard.entries.filter((e) => !drop.has(e.id));
	console.log(`\n${kept} gardées, ${rejected} rejetées, ${drop.size} doublons écartés → ${shard.entries.length} au total`);

	// Le taux de rejet d'un lot dit quelque chose du PROMPT, pas des entrées :
	// au-delà de 5 %, on jette et on corrige le brief plutôt que de rapiécer.
	const rate = rejected / (kept + rejected || 1);
	if (rate > 0.05) console.warn(`\n⚠  taux de rejet ${(rate * 100).toFixed(1)} % — revoir prompts/events/${EVENTS[event].shard}.md avant de continuer`);

	if (a['dry-run']) { console.log('(--dry-run : rien écrit)'); return; }
	writeFileSync(shardPath(event), `${JSON.stringify(shard, null, 2)}\n`);
	console.log(`écrit : public/dialogue/${EVENTS[event].shard}.json`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: Write `inspect.mjs`**

Rend N tirages avec des contextes factices pour la relecture humaine, et sait n'échantillonner qu'une rareté :

```
node tools/dialogue/inspect.mjs --event ACQUIRE_AREA [--count 30] [--rarity RARE] [--character jensen]
```

Il charge le shard, filtre, tire un échantillon, appelle `render()` avec un contexte factice **complet** (tous les chemins renseignés, pour que toute entrée soit rendable) et imprime les échanges tels que le joueur les verrait. C'est l'outil de la politique de relecture : `--rarity RARE`, `--rarity VERY_RARE` et `--character jensen` se relisent **en entier**, le reste par échantillon de 10 %.

- [ ] **Step 4: Add npm scripts**

```json
"dialogue:gen": "node tools/dialogue/generate.mjs",
"dialogue:inspect": "node tools/dialogue/inspect.mjs",
"dialogue:check": "node tools/dialogue-selftest.mjs"
```

- [ ] **Step 5: Add the isolation test**

Dans `tools/dialogue-selftest.mjs` :

```js
import { readdirSync, readFileSync as rf } from 'node:fs';

t('isolation : aucun module de src/ n\'importe l\'outillage de génération', () => {
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
```

- [ ] **Step 6: Smoke test the pipeline**

```bash
cd sim && node tools/dialogue/generate.mjs --event ACQUIRE_AREA --count 6 --batch 6 --dry-run
```

Attendu : six entrées proposées, le compte de rejets affiché, **rien d'écrit**. Si le taux de rejet dépasse 5 % dès ce premier essai, corriger `prompts/` — pas `validate.mjs`.

- [ ] **Step 7: Commit**

```bash
git add sim/tools/dialogue sim/package.json
git commit -m "$(printf 'PHASE 21 : atelier de génération du corpus (#58)\n\ngenerate.mjs pilote claude -p par lots, chaque lot imposant sa propre\ndistribution de formes et recevant le digest de ce qui est déjà écrit —\nc%sest ce qui empêche 200 entrées de converger vers le même rythme.\n\nOutil de développement strictement isolé : un selftest vérifie qu%saucun\nmodule de src/ ne l%satteint et que public/dialogue ne porte que des\ndonnées. Le jeu livré ne dépend d%saucun LLM.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'" "'")"
```

---

### Task 11: produire et relire le corpus

Tâche longue et essentiellement non automatisable : c'est celle qui décide de la qualité perçue de toute la phase.

**Files:**
- Modify: `sim/public/dialogue/*.json`, `sim/public/dialogue/manifest.json`

- [ ] **Step 1: Générer, événement par événement**

Pour chacun des 11 événements câblés, viser 400 à 800 entrées, réparties par rareté :

```bash
cd sim
npm run dialogue:gen -- --event ACQUIRE_AREA --count 400 --rarity COMMON
npm run dialogue:gen -- --event ACQUIRE_AREA --count 150 --rarity UNCOMMON
npm run dialogue:gen -- --event ACQUIRE_AREA --count 60  --rarity RARE
npm run dialogue:gen -- --event ACQUIRE_AREA --count 20  --rarity VERY_RARE
```

Puis répéter pour `AREA_SEARCH`, `PROBE_AREA`, `TERRAIN_PROGRESS`, `TARGET_SCAN`, `TARGET_SELECTED`, `TARGET_ANALYSIS`, `HACK`, `MANUAL_OVERRIDE`, `JACK_IN`, `WEATHER`.

**Après chaque événement**, mettre à jour `manifest.json` avec le nouveau shard, et lancer `npm run dialogue:check`.

- [ ] **Step 2: Relire selon la politique**

Intégralement :

```bash
npm run dialogue:inspect -- --event <EVENT> --rarity RARE
npm run dialogue:inspect -- --event <EVENT> --rarity VERY_RARE
npm run dialogue:inspect -- --event <EVENT> --character jensen
```

Par échantillon de 10 % :

```bash
npm run dialogue:inspect -- --event <EVENT> --count 40
```

Ce qu'on cherche, et que la machine ne voit pas : une voix qui sonne faux, une blague qui insiste, un anglais qui sent la traduction, une réplique qui explique le lore, une réplique qui promet quelque chose. **Au-delà de 5 % de rejet sur un échantillon, jeter le lot entier et corriger le brief** — un lot mauvais l'est pour une raison de prompt, pas entrée par entrée.

- [ ] **Step 3: Vérifier l'ensemble**

```bash
cd sim && npm run selftest:operator && npm run selftest
```

Le test « chaque entrée du corpus est atteignable » va probablement remonter du matériel mort à ce volume : des entrées dont le `requires` ne sera jamais satisfait sur l'événement où elles sont rangées. Les **supprimer**, pas assouplir le test.

- [ ] **Step 4: Commit**

Un commit par événement plutôt qu'un seul énorme, pour que la relecture d'historique reste possible.

```bash
git add sim/public/dialogue
git commit -m "PHASE 21 : corpus ACQUIRE_AREA, 630 entrées relues (#58)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: BUILD NOTES

**Files:**
- Create: `sim/tools/buildnotes-model.mjs`
- Create: `sim/tools/buildnotes-selftest.mjs`
- Modify: `sim/src/terminal.js` (entrée de navigation + écran), `sim/tools/terminal-model.mjs` (numéro de build en pied)
- Modify: `sim/package.json` (`selftest:operator`)

**Interfaces:**
- Consumes: `STYLE_BANS` de `tools/dialogue/validate.mjs` (une seule liste d'interdits pour tout le lore).
- Produces:
  - `NOTES: Array<{ build: string, unlock: { terrains: number, sessions: number, targets: number }, lines: string[] }>`
  - `countersOf(operator: object) => { terrains: number, sessions: number, targets: number }`
  - `unlockedNotes(counters: object) => NOTES[]`
  - `currentBuild(counters: object) => string`

- [ ] **Step 1: Write the failing test**

Créer `sim/tools/buildnotes-selftest.mjs` :

```js
// Selftest des BUILD NOTES (PHASE 21, D8). Aucune E/S, aucun DOM.
// Lancer : node tools/buildnotes-selftest.mjs
import assert from 'node:assert/strict';
import { NOTES, countersOf, unlockedNotes, currentBuild } from './buildnotes-model.mjs';
import { STYLE_BANS } from './dialogue/validate.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ZERO = { terrains: 0, sessions: 0, targets: 0 };

t('NOTES : une échelle, pas un tas', () => {
	assert.ok(NOTES.length >= 8, `échelle trop courte : ${NOTES.length}`);
	for (const note of NOTES) {
		assert.match(note.build, /^\d+\.\d+\.\d+$/, `numéro de build mal formé : ${note.build}`);
		assert.ok(note.lines.length > 0);
	}
});

t('NOTES : les seuils de déblocage ne redescendent jamais', () => {
	// Sans ça, une entrée « plus haute » pourrait se débloquer avant une plus
	// basse et le numéro de build afficherait n'importe quoi.
	for (let i = 1; i < NOTES.length; i++) {
		for (const k of ['terrains', 'sessions', 'targets']) {
			assert.ok(NOTES[i].unlock[k] >= NOTES[i - 1].unlock[k],
				`${NOTES[i].build} : seuil ${k} en recul`);
		}
	}
});

t('NOTES : la première entrée est visible par un opérateur neuf', () => {
	assert.deepEqual(NOTES[0].unlock, ZERO);
	assert.equal(unlockedNotes(ZERO).length, 1);
	assert.equal(currentBuild(ZERO), NOTES[0].build);
});

t('NOTES : aucune promesse de suite, aucune adresse au joueur (D8)', () => {
	for (const note of NOTES) {
		for (const line of note.lines) {
			for (const ban of STYLE_BANS) {
				assert.ok(!ban.re.test(line), `${note.build} — ${ban.why} : "${line}"`);
			}
		}
	}
});

t('NOTES : les notes parlent de l\'outil au passé, jamais de l\'opérateur', () => {
	for (const note of NOTES) {
		for (const line of note.lines) {
			assert.ok(!/\byou\b|\byour\b/i.test(line), `${note.build} : la note s'adresse à quelqu'un — "${line}"`);
		}
	}
});

t('unlockedNotes : toujours un préfixe de l\'échelle', () => {
	const c = { terrains: 3, sessions: 12, targets: 9 };
	const got = unlockedNotes(c);
	assert.deepEqual(got, NOTES.slice(0, got.length));
	assert.equal(currentBuild(c), got.at(-1).build);
});

t('unlockedNotes : un seul compteur en retard suffit à bloquer', () => {
	const many = { terrains: 999, sessions: 999, targets: 0 };
	const all = { terrains: 999, sessions: 999, targets: 999 };
	assert.ok(unlockedNotes(many).length < unlockedNotes(all).length);
	assert.equal(unlockedNotes(all).length, NOTES.length);
});

t('countersOf : compte depuis l\'état opérateur réel, et survit à un état vide', () => {
	assert.deepEqual(countersOf(null), ZERO);
	assert.deepEqual(countersOf({}), ZERO);
	const op = {
		terrainCache: [{ slug: 'a' }, { slug: 'b' }],
		sessions: [{ target: { id: 't1' } }, { target: { id: 't2' } }, {}],
	};
	assert.deepEqual(countersOf(op), { terrains: 2, sessions: 3, targets: 2 });
});

console.log(`\n${n} vérifications, tout passe.`);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sim && node tools/buildnotes-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `./buildnotes-model.mjs`.

- [ ] **Step 3: Write `tools/buildnotes-model.mjs`**

Écrire à la main une échelle d'au moins 10 entrées, en anglais. La règle d'écriture, qui est ce qui empêche les BUILD NOTES de devenir de la dette narrative : **une note décrit l'outil, au passé, sans jamais parler de l'opérateur ni annoncer quoi que ce soit.** « fixed: tile 842 decoded twice » se débloque, ne promet rien, et ne dit rien du joueur.

```js
// BUILD NOTES (PHASE 21, D8). Une échelle écrite à la main : le volume est trop
// faible et trop curatorial pour la génération en lot.
//
// Règle d'écriture, et raison d'être du selftest : une note parle de l'OUTIL,
// AU PASSÉ. Jamais de l'opérateur, jamais d'une suite. C'est ce qui laisse le
// lore décoratif alors même que l'échelle se déverrouille au fil des sessions.

export const NOTES = [
	{ build: '0.1.0', unlock: { terrains: 0, sessions: 0, targets: 0 }, lines: [
		'first public build',
		'terrain import works. mostly',
	] },
	{ build: '0.1.4', unlock: { terrains: 1, sessions: 0, targets: 0 }, lines: [
		'fixed: tile 842 decoded twice',
		'mikhail was right',
	] },
	// … au moins 10 entrées, seuils croissants sur les trois compteurs.
];

export function countersOf(operator) {
	return {
		terrains: operator?.terrainCache?.length ?? 0,
		sessions: operator?.sessions?.length ?? 0,
		targets: (operator?.sessions ?? []).filter((s) => s?.target).length,
	};
}

const reached = (c, u) => c.terrains >= u.terrains && c.sessions >= u.sessions && c.targets >= u.targets;

// Un préfixe, jamais un filtre : les seuils étant croissants (le selftest le
// fige), la première note hors de portée arrête l'échelle. Sans ça, un trou
// dans la liste donnerait un numéro de build incohérent avec ce qui est lisible.
export function unlockedNotes(counters) {
	const out = [];
	for (const note of NOTES) {
		if (!reached(counters, note.unlock)) break;
		out.push(note);
	}
	return out.length ? out : [NOTES[0]];
}

export function currentBuild(counters) {
	return unlockedNotes(counters).at(-1).build;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sim && node tools/buildnotes-selftest.mjs
```

Attendu : 8 vérifications, tout passe.

- [ ] **Step 5: Wire the screen**

Dans `src/terminal.js`, ajouter `BUILD NOTES` à la rangée de navigation de la Home (via le `navRow` existant, ligne 30) et un écran monté avec le `screen()` maison :

```js
function buildNotesScreen(root, operator) {
	const s = screen(root);
	const c = countersOf(operator);
	s.box.innerHTML = `<pre>BUILD NOTES

CURRENT BUILD   ${currentBuild(c)}

${unlockedNotes(c).map((n) => `${n.build}\n${n.lines.map((l) => `  ${l}`).join('\n')}`).join('\n\n')}</pre>`;
	s.box.appendChild(button('BACK', () => { s.remove(); /* retour Home */ }, 'terminal-cta'));
}
```

Dans `tools/terminal-model.mjs`, ajouter le numéro de build au pied de la Home, à côté des compteurs de sessions et de cibles déjà affichés. **Étendre le selftest existant `tools/terminal-selftest.mjs`** pour couvrir ce nouveau champ, plutôt que de le laisser sans test.

- [ ] **Step 6: Wire the selftest and verify**

Ajouter ` && node tools/buildnotes-selftest.mjs` à `selftest:operator`, puis :

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
```

- [ ] **Step 7: Verify in the browser**

```bash
cd sim && npm run dev
```

- BUILD NOTES s'ouvre depuis la Home et revient proprement ;
- sur un opérateur **neuf**, une seule entrée s'affiche et le pied montre `0.1.0` ;
- sur un opérateur chargé, l'échelle est plus longue et le pied suit ;
- aucun `undefined` nulle part.

- [ ] **Step 8: Commit**

```bash
git add sim/tools/buildnotes-model.mjs sim/tools/buildnotes-selftest.mjs sim/src/terminal.js sim/tools/terminal-model.mjs sim/tools/terminal-selftest.mjs sim/package.json
git commit -m "$(printf 'PHASE 21 : écran BUILD NOTES (#58)\n\nUne échelle de versions écrite à la main, débloquée par les compteurs\nexistants de l%sopérateur. Les notes parlent de l%soutil au passé — jamais\nde l%sopérateur, jamais d%sune suite : c%sest ce qui les garde décoratives\nalors même qu%selles se déverrouillent. Le selftest fige les deux règles.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'" "'" "'" "'")"
```

---

### Task 13: documentation, corrections de spec, PR

**Files:**
- Modify: `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md` (§9)
- Modify: `sim/docs/superpowers/specs/2026-08-30-phase-21-lore-rtc-design.md`
- Modify: `sim/HANDOFF.md`, `sim/README.md`

- [ ] **Step 1: Corriger la Bible §9**

L'exemple de la section « Logs RTC » fait parler `vex`, qui n'existe plus (D7). Réécrire l'exemple avec `root` et `mikhail`, en gardant exactement le même rythme — c'est un exemple de ton, il doit rester juste.

- [ ] **Step 2: Corriger la spec sur les deux points où l'implémentation a divergé**

1. **`entry-state.js` n'est pas un écran.** Remplacer sa mention comme point d'appel de `WEATHER` par l'écran TARGET SCAN (voir « Correction à la spec » en tête de ce plan).
2. **`callModel()` n'a qu'un dos.** La spec décrit deux dos (API Messages + `claude -p`) ; seul `claude -p` est implémenté. Écrire pourquoi : pas de clé dans l'environnement, donc pas de chemin testable, et le chemin SDK contredirait la contrainte de dépendances.

Ces corrections vont **dans la spec elle-même**, pas dans une note de bas de page : la spec est un document vivant, et une spec qui ment sur le code livré est pire qu'une spec absente.

- [ ] **Step 3: HANDOFF et README**

Dans `HANDOFF.md`, un bloc PHASE 21 sous « Vérifié », qui distingue explicitement :
- **vérifié sans navigateur** : les N vérifications du selftest dialogue et des BUILD NOTES, la validation et la déduplication du corpus complet, l'isolation de l'outillage ;
- **vérifié au navigateur** : la chaîne scanner → target scan → hack, l'absence de `{slot}`, le silence pendant le rituel, l'absence de fuite de minuteur ;
- **non vérifié** : la qualité perçue du corpus sur une longue partie. C'est un jugement de ton qui demande des heures de jeu réel, exactement comme l'écoute pour PHASE 18 et l'audio de l'intro. **Le dire, ne pas le maquiller en « vérifié ».**

Dans `README.md`, une section sur le pipeline de dialogue : les trois commandes `dialogue:gen` / `dialogue:inspect` / `dialogue:check`, la politique de relecture, et la règle que le corpus livré est du **contenu versionné**, pas un artefact de build.

- [ ] **Step 4: Ouvrir les issues de suivi**

Créer une issue pour chaque chose découverte et non faite, plutôt que de laisser des TODO dans le code :

```bash
gh issue create --repo lionrayonnant/FPVTP --label roadmap-da \
  --title "Dialogue : chemin API Messages pour generate.mjs (SDK officiel)" \
  --body "generate.mjs ne pilote que \`claude -p\`. Le chemin API Messages via le SDK officiel reste à écrire par quelqu'un qui a une clé pour le vérifier — du code jamais exécuté est du code faux qui s'ignore. Voir PHASE 21, Tâche 10."

gh issue create --repo lionrayonnant/FPVTP --label roadmap-da \
  --title "Dialogue : câbler les événements de vol, crash et session complete" \
  --body "FLIGHT, LINK_DEGRADED, LINK_RESTORED, CRASH, SESSION_COMPLETE, REVISIT et BOOTSTRAP sont déclarés au catalogue et alimentés par le corpus, sans point d'appel. En câbler un est une ligne — c'est le critère d'acceptation 10 de #58."
```

- [ ] **Step 5: Vérification finale, complète**

```bash
cd sim && npm run selftest && npm run selftest:operator && npm run selftest:api && npm run build
```

Les quatre doivent être vertes. `npm run selftest` doit toujours annoncer **158/158** : si le compte a bougé, la DA a touché la physique et il faut comprendre pourquoi avant d'aller plus loin.

- [ ] **Step 6: Commit et PR**

```bash
git add -A
git commit -m "$(printf 'PHASE 21 : documentation, corrections de spec, état HANDOFF (#58)\n\nLa Bible §9 ne fait plus parler vex. La spec est corrigée sur les deux\npoints où l%simplémentation a divergé : entry-state.js n%'est pas un écran,\net callModel() n%sa qu%sun dos.\n\nHANDOFF distingue ce qui est vérifié sans navigateur, au navigateur, et\nce qui ne l%sest pas : la qualité perçue du corpus sur une longue partie\nreste un jugement de ton, pas une case cochée.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>' "'" "'" "'" "'")"

git push -u origin phase-21-lore-rtc
gh pr create --repo lionrayonnant/FPVTP --base main --title "PHASE 21 — Lore / RTC v0 (#58)" --body-file /tmp/pr-21.md
```

Rédiger `/tmp/pr-21.md` avant d'appeler la commande. Le corps doit dire, sans arrondir : ce qui est vérifié et comment, ce qui ne l'est pas, et que **le critère d'acceptation réel de cette phase — un joueur qui ignore les RTC ne rate rien, et aucun dialogue ne promet une suite — est mécaniquement garanti pour la seconde moitié (le validateur) et humainement jugé pour la première.**

---

## Self-Review

**Couverture de la spec.** Les dix décisions ont chacune leur tâche : D1 → T10 (isolation testée), D2 → T6/T7, D3 → T1/T2/T4, D4 → T3, D5 → T3, D6 → T7, D7 → T1/T6/T13, D8 → T12, D9 → T9, D10 → T8/T9. Les onze vérifications sans navigateur de la spec sont réparties sur T1-T6, T10 et T12 ; les cinq vérifications navigateur sur T8, T9 et T12.

**Deux divergences assumées**, toutes deux corrigées dans la spec en T13 : `entry-state.js` n'est pas un écran (le point d'appel `WEATHER` passe sur TARGET SCAN), et `callModel()` n'a qu'un dos (`claude -p`).

**Un raffinement par rapport à la spec** : la spec parle d'un anneau de 256. L'implémentation en a deux — 256 pour l'exclusion dure, 512 pour la pénalité douce (`MEMORY_SEEN`). Ce n'est pas une contradiction mais la façon dont « × 0,35 si déjà vue mais sortie de l'anneau » devient implémentable : il faut une mémoire plus longue que l'exclusion pour savoir qu'une entrée a déjà servi.

**Ordre des tâches.** Chaque tâche laisse l'arbre utilisable : T6 est additive, la suppression de `rtc-model.mjs` attend T8 où son unique appelant change dans le même commit.

**Le vrai risque de cette phase n'est pas technique.** Le moteur est petit et entièrement testable ; c'est T11 — écrire et relire 3000 à 5000 répliques qui sonnent juste — qui décide de tout, et c'est la seule tâche que le selftest ne peut pas juger.
