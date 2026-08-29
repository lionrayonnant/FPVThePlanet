# PHASE 18 — Audio final — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doter le jeu d'un langage sonore de trois familles — `SYSTEM`, `LINK`, `RITUAL` — qui ne sonne que sur les sept événements qui le méritent, avec une signature de boot synthétisée, six partitions de rituel écrites à la main et une porteuse de liaison vivante en vol, sans toucher à la synthèse moteur existante.

**Architecture:** Toute la logique temporelle vit dans un module pur (`tools/ui-audio-model.mjs`) testable sous Node : vocabulaire clos, table de notes du boot, six partitions en temps normalisé, hystérésis du lien. Le rendu Web Audio vit dans `src/ui-audio.js` et se branche, comme `src/audio.js`, sur un contexte et un limiteur désormais partagés (`src/audio-bus.js`). Un faux `AudioContext` (`tools/lib/fake-audio-ctx.mjs`) rend le graphe et l'ordonnancement testables headless.

**Tech Stack:** JS ES modules, Web Audio API, Vite, harnais de test en Node pur (`node:assert/strict`), pas de framework de test.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-18-audio-final-design.md`

## Global Constraints

- Tous les chemins sont relatifs à `sim/`. Toutes les commandes se lancent depuis `sim/`.
- **Textes du jeu en anglais.** Commentaires de code, commits et documentation interne en **français**.
- Aucun élément de DA ne devient une dépendance du moteur physique : `npm run selftest` doit rester vert à chaque tâche.
- `tools/ui-audio-model.mjs` n'importe **rien** : ni Web Audio, ni DOM, ni `node:`. C'est ce qui le rend testable en Node et bundlable par Vite.
- `src/ui-audio.js` n'importe ni Three, ni Rapier, ni DOM. Il n'est **jamais** importé par le moteur.
- Le vocabulaire d'événements est **clos à sept entrées**. Ajouter un son veut dire ajouter une entrée à `UI_EVENTS`, et la Tâche 5 fait échouer le selftest sinon.
- **Aucune voix, aucun narrateur, aucune commande vocale** (Bible §37). Aucun échantillon chargé : tout est synthétisé.
- Aucune musique, à aucun moment. Aucun son sur un clic, un survol, une navigation, une ouverture d'écran ou un changement de réglage.
- Les constantes de `AUDIO` dans `src/audio.js` ne sont **pas** retouchées. Les quatre constantes du limiteur déménagent telles quelles dans `audio-bus.js`.
- Style du dépôt : tabulations pour l'indentation, commentaires qui expliquent *pourquoi* et pas *quoi*.
- Seuils du lien repris de `src/link.js`, pas re-choisis : `LINK_LOST_AT = 0.10` (son `BLACKOUT_Q`), `LINK_BACK_AT = 0.30` (son `COOLDOWN_FLOOR_Q`).

---

### Task 1: `tools/ui-audio-model.mjs` — vocabulaire, signature de boot, hystérésis du lien

Le socle pur. Aucune Web Audio ici : uniquement des tables et deux fonctions.

**Files:**
- Create: `tools/ui-audio-model.mjs`
- Create: `tools/ui-audio-selftest.mjs`
- Modify: `package.json` (ajouter le selftest à `selftest:operator`)

**Interfaces:**
- Consumes: rien (premier module).
- Produces:
  - `UI_EVENTS: string[]` — exactement `['BOOT','TERRAIN_READY','TARGET_FOUND','ERROR','LINK_LOST','LINK_RESTORED','RITUAL']`.
  - `UI_FAMILY: Record<string,'SYSTEM'|'LINK'|'RITUAL'>` — la famille de chaque événement.
  - `BOOT_SIGNATURE: Array<{ atMs: number, freq: number, durS: number }>` — cinq notes.
  - `LINK_LOST_AT: 0.10`, `LINK_BACK_AT: 0.30`, `LINK_MIN_GAP_S: 3.0`.
  - `newLinkState(): { lost: boolean, sinceS: number }`.
  - `linkEvent(quality: number, dtS: number, state): 'LINK_LOST' | 'LINK_RESTORED' | null` — mute `state`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tools/ui-audio-selftest.mjs` :

```js
// Selftest du modèle sonore d'interface (PHASE 18). Aucune E/S, aucun DOM,
// aucune Web Audio. Lancer : node tools/ui-audio-selftest.mjs
import assert from 'node:assert/strict';
import {
	UI_EVENTS, UI_FAMILY, BOOT_SIGNATURE,
	LINK_LOST_AT, LINK_BACK_AT, LINK_MIN_GAP_S,
	newLinkState, linkEvent,
} from './ui-audio-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- vocabulaire clos ------------------------------------------------------

t('UI_EVENTS : exactement les sept événements de la spec', () => {
	assert.deepEqual(UI_EVENTS, [
		'BOOT', 'TERRAIN_READY', 'TARGET_FOUND', 'ERROR',
		'LINK_LOST', 'LINK_RESTORED', 'RITUAL',
	]);
});

t('UI_FAMILY : chaque événement a une famille, et seulement les trois de §34', () => {
	assert.deepEqual(Object.keys(UI_FAMILY).sort(), [...UI_EVENTS].sort());
	for (const e of UI_EVENTS) {
		assert.ok(['SYSTEM', 'LINK', 'RITUAL'].includes(UI_FAMILY[e]), e);
	}
	assert.equal(UI_FAMILY.LINK_LOST, 'LINK');
	assert.equal(UI_FAMILY.LINK_RESTORED, 'LINK');
	assert.equal(UI_FAMILY.RITUAL, 'RITUAL');
});

// --- signature de boot -----------------------------------------------------

t('BOOT_SIGNATURE : cinq notes, tututuuut tuuuuu-tuu', () => {
	assert.equal(BOOT_SIGNATURE.length, 5);
	for (const note of BOOT_SIGNATURE) {
		assert.ok(note.freq > 200 && note.freq < 5000, `hors bande ESC : ${note.freq}`);
		assert.ok(note.durS > 0.02 && note.durS < 0.6, `durée invraisemblable : ${note.durS}`);
	}
});

t('BOOT_SIGNATURE : deux groupes séparés par un seul vrai silence', () => {
	const gaps = [];
	for (let i = 1; i < BOOT_SIGNATURE.length; i++) {
		const prev = BOOT_SIGNATURE[i - 1];
		gaps.push(BOOT_SIGNATURE[i].atMs - (prev.atMs + prev.durS * 1000));
	}
	// Un unique écart > 150 ms : c'est lui qui sépare `tututuuut` de `tuuuuu-tuu`.
	assert.equal(gaps.filter((g) => g > 150).length, 1);
	assert.ok(gaps.every((g) => g >= 0), 'les notes ne se chevauchent pas');
});

t('BOOT_SIGNATURE : rythme court/court/tenu · tenu/court', () => {
	const [a, b, c, d, e] = BOOT_SIGNATURE.map((x) => x.durS);
	assert.ok(c > a * 2 && c > b * 2, 'la 3e note est tenue');
	assert.ok(d > e * 2, 'la 4e est tenue, la 5e est courte');
});

t('BOOT_SIGNATURE : le triolet monte', () => {
	assert.ok(BOOT_SIGNATURE[0].freq < BOOT_SIGNATURE[1].freq);
	assert.ok(BOOT_SIGNATURE[1].freq < BOOT_SIGNATURE[2].freq);
});

// --- hystérésis du lien ----------------------------------------------------

// Fait passer une trace de qualités dans linkEvent et rend la liste des
// annonces. dtS fixe = une frame à 60 Hz sauf indication contraire.
const run = (qualities, dtS = 1 / 60) => {
	const st = newLinkState();
	const out = [];
	for (const q of qualities) {
		const e = linkEvent(q, dtS, st);
		if (e) out.push(e);
	}
	return out;
};

t('linkEvent : seuils repris de link.js, pas re-choisis', () => {
	assert.equal(LINK_LOST_AT, 0.10);
	assert.equal(LINK_BACK_AT, 0.30);
});

t('linkEvent : un lien plein ne dit rien', () => {
	assert.deepEqual(run(Array(600).fill(1)), []);
});

t('linkEvent : une chute franche annonce LINK_LOST une seule fois', () => {
	const trace = [...Array(60).fill(1), ...Array(300).fill(0.02)];
	assert.deepEqual(run(trace), ['LINK_LOST']);
});

t('linkEvent : perte puis retour annonce les deux, dans l\'ordre', () => {
	const trace = [
		...Array(60).fill(1),
		...Array(300).fill(0.02),   // 5 s perdu : le temps de garde est passé
		...Array(300).fill(0.9),
	];
	assert.deepEqual(run(trace), ['LINK_LOST', 'LINK_RESTORED']);
});

t('linkEvent : pas de LINK_RESTORED sans LINK_LOST avant lui', () => {
	// Descend jusque dans la bande morte SANS franchir LINK_LOST_AT, puis remonte.
	const trace = [...Array(60).fill(1), ...Array(120).fill(0.15), ...Array(120).fill(0.9)];
	assert.deepEqual(run(trace), []);
});

t('linkEvent : un plateau tenu sur la frontière ne bégaie pas', () => {
	// Oscille entre les deux seuils sans jamais les franchir.
	const trace = [];
	for (let i = 0; i < 900; i++) trace.push(0.20 + 0.08 * Math.sin(i / 3));
	assert.deepEqual(run(trace), []);
});

t('linkEvent : jamais deux annonces identiques consécutives', () => {
	// Traversées franches et répétées de toute la bande, façon slalom.
	const trace = [];
	for (let k = 0; k < 12; k++) {
		for (let i = 0; i < 30; i++) trace.push(0.02);
		for (let i = 0; i < 30; i++) trace.push(0.95);
	}
	const events = run(trace);
	for (let i = 1; i < events.length; i++) {
		assert.notEqual(events[i], events[i - 1], `doublon à l'index ${i}`);
	}
});

t('linkEvent : le temps de garde étouffe une mitraillette', () => {
	// Même slalom : 12 allers-retours en 12 s, mais LINK_MIN_GAP_S vaut 3 s,
	// donc il ne peut pas en sortir 24 annonces.
	const trace = [];
	for (let k = 0; k < 12; k++) {
		for (let i = 0; i < 30; i++) trace.push(0.02);
		for (let i = 0; i < 30; i++) trace.push(0.95);
	}
	const events = run(trace);
	const spanS = trace.length / 60;
	assert.ok(events.length <= Math.ceil(spanS / LINK_MIN_GAP_S) + 1,
		`${events.length} annonces en ${spanS.toFixed(1)} s`);
});

t('linkEvent : ne garde aucun état de module — deux runs identiques', () => {
	const trace = [...Array(60).fill(1), ...Array(300).fill(0.02), ...Array(300).fill(0.9)];
	assert.deepEqual(run(trace), run(trace));
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: FAIL — `Cannot find module './ui-audio-model.mjs'`

- [ ] **Step 3: Écrire le modèle minimal**

Créer `tools/ui-audio-model.mjs` :

```js
// Modèle du langage sonore d'interface (PHASE 18, Bible §34-36). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Importé tel quel par le selftest
// et, via un bundle Vite, par src/ui-audio.js. Le rendu vit là-bas.
//
// Règle de la phase, et raison d'être de ce fichier :
//   An event that doesn't need to be heard doesn't need a sound.

// Le vocabulaire est CLOS. Ces sept entrées sont tout ce que l'interface a le
// droit de faire entendre. Il n'y a pas de son de clic, de survol, de
// navigation, d'ouverture d'écran, de sélection ni de validation — c'est la
// forme exécutable de « le système ne bipe pas à chaque clic » (Bible §34), et
// tools/ui-audio-selftest.mjs balaie src/ pour le faire respecter.
export const UI_EVENTS = [
	'BOOT',            // SYSTEM — la signature de démarrage, une fois par chargement
	'TERRAIN_READY',   // SYSTEM — la scène est chargée et jouable
	'TARGET_FOUND',    // SYSTEM — une cible est confirmée au TARGET SCAN
	'ERROR',           // SYSTEM — accusé de réception d'une erreur, jamais une punition
	'LINK_LOST',       // LINK
	'LINK_RESTORED',   // LINK
	'RITUAL',          // RITUAL — la culmination, cf. scoreFor()
];

export const UI_FAMILY = {
	BOOT: 'SYSTEM',
	TERRAIN_READY: 'SYSTEM',
	TARGET_FOUND: 'SYSTEM',
	ERROR: 'SYSTEM',
	LINK_LOST: 'LINK',
	LINK_RESTORED: 'LINK',
	RITUAL: 'RITUAL',
};

// --- signature de boot ------------------------------------------------------

// `tututuuut tuuuuu-tuu` (Bible §35). Les hauteurs ne sont pas inventées : un
// ESC fait chanter la bobine du moteur en la commutant, et la séquence de
// démarrage classique est un triolet ascendant do-mi-sol puis une
// confirmation. Ce qui porte l'identité est le RYTHME — court, court, tenu ·
// tenu, court — plus encore que les hauteurs.
//
// Jouée UNIQUEMENT au boot FPVTP!, une fois par chargement de page. Ni à
// l'entrée en vol, ni au respawn : « pas comme motif omniprésent », et « le
// crash n'en reprend pas le motif ». À l'entry state le drone est déjà en
// l'air, il n'y a aucun armement à sonoriser.
export const BOOT_SIGNATURE = [
	{ atMs: 0, freq: 1046.50, durS: 0.070 },   // tu
	{ atMs: 110, freq: 1318.51, durS: 0.070 },   // tu
	{ atMs: 220, freq: 1567.98, durS: 0.220 },   // tuuut
	// 180 ms de silence : le seul vrai blanc du motif
	{ atMs: 620, freq: 1318.51, durS: 0.320 },   // tuuuuu
	{ atMs: 980, freq: 1046.50, durS: 0.110 },   // tuu
];

// --- hystérésis du lien -----------------------------------------------------

// Les deux seuils ne sont pas choisis ici : ils sont REPRIS de src/link.js, qui
// les a déjà calibrés pour ce problème exact. LINK_LOST_AT est son BLACKOUT_Q
// (l'écran est effectivement mort) et LINK_BACK_AT son COOLDOWN_FLOOR_Q, dégagé
// de FREEZE_LEAVE (0,28) — donc l'image ne peut plus geler au moment où on
// annonce le retour. L'annonce encadre la panne visible au lieu de la doubler.
export const LINK_LOST_AT = 0.10;
export const LINK_BACK_AT = 0.30;

// Temps de garde entre deux annonces. L'hystérésis seule ne suffit pas : une
// traversée franche et répétée de TOUTE la bande — ce qui arrive en slalomant
// entre deux immeubles — passerait les deux seuils à chaque aller-retour et
// deviendrait une mitraillette.
export const LINK_MIN_GAP_S = 3.0;

export function newLinkState() {
	return { lost: false, sinceS: LINK_MIN_GAP_S };
}

// Mute `state` et rend l'annonce à jouer, ou null. Aucune variable de module :
// deux exécutions de la même trace donnent la même chose, ce qui rend le
// selftest rejouable.
export function linkEvent(quality, dtS, state) {
	state.sinceS += dtS;
	if (state.sinceS < LINK_MIN_GAP_S) return null;
	if (!state.lost && quality < LINK_LOST_AT) {
		state.lost = true;
		state.sinceS = 0;
		return 'LINK_LOST';
	}
	if (state.lost && quality > LINK_BACK_AT) {
		state.lost = false;
		state.sinceS = 0;
		return 'LINK_RESTORED';
	}
	return null;
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: PASS — `15 tests OK`

- [ ] **Step 5: Brancher le selftest sur `selftest:operator`**

Dans `package.json`, ajouter ` && node tools/ui-audio-selftest.mjs` à la fin de la valeur du script `selftest:operator`.

Run: `cd sim && npm run selftest:operator`
Expected: PASS, toute la chaîne verte, `ui-audio-selftest` inclus.

- [ ] **Step 6: Commit**

```bash
git add sim/tools/ui-audio-model.mjs sim/tools/ui-audio-selftest.mjs sim/package.json
git commit -m "PHASE 18 : vocabulaire clos, signature de boot, hystérésis du lien"
```

---

### Task 2: Les six partitions de rituel

**Files:**
- Modify: `tools/ui-audio-model.mjs` (ajout des partitions et de `scoreFor`)
- Modify: `tools/ui-audio-selftest.mjs` (ajout des tests de partition)

**Interfaces:**
- Consumes: `HACK_TYPES` depuis `tools/target-model.mjs`.
- Produces:
  - `VOICES: string[]` — `['click','pulse','bass','glitch','sweep','stab','impact','tone']`.
  - `PERCUSSIVE: string[]` — `['click','glitch','stab']`, les voix dont la durée est fixée par leur propre enveloppe.
  - `RITUAL_SCORES: Record<string, Array<{ at: number, voice: string, freq?: number, to?: number, dur?: number, gain?: number }>>` — clés = les six `HACK_TYPES`, `at` et `dur` en unités normalisées 0..1.
  - `scoreFor(hackType: string, variantMs: number): Array<{ atMs: number, durS: number, voice: string, freq?: number, to?: number, gain?: number }>`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tools/ui-audio-selftest.mjs`, avant la ligne `console.log(...)` finale. Compléter l'import de `./ui-audio-model.mjs` en tête du fichier avec `VOICES, PERCUSSIVE, RITUAL_SCORES, scoreFor`, et ajouter `import { HACK_TYPES } from './target-model.mjs';` :

```js
// --- partitions de rituel ---------------------------------------------------

const VARIANT_MS = [1000, 2000, 3000, 4000]; // V1..V4, cf. tools/ritual-model.mjs

t('RITUAL_SCORES : une partition par famille de HACK_TYPES, et rien d\'autre', () => {
	assert.deepEqual(Object.keys(RITUAL_SCORES).sort(), [...HACK_TYPES].sort());
});

t('RITUAL_SCORES : chaque événement nomme une voix connue', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		for (const ev of score) {
			assert.ok(VOICES.includes(ev.voice), `${family} : voix inconnue ${ev.voice}`);
		}
	}
});

t('RITUAL_SCORES : temps normalisé croissant, dans [0,1]', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		for (let i = 0; i < score.length; i++) {
			assert.ok(score[i].at >= 0 && score[i].at <= 1, `${family} : at hors [0,1]`);
			if (i) assert.ok(score[i].at >= score[i - 1].at, `${family} : at non croissant`);
		}
	}
});

t('RITUAL_SCORES : les six sont réellement distinctes', () => {
	// La décision « six identités écrites à la main » est vérifiée, pas
	// seulement déclarée : deux familles ne peuvent pas rendre la même suite
	// de voix.
	const shapes = Object.entries(RITUAL_SCORES)
		.map(([f, s]) => [f, s.map((e) => e.voice).join('>')]);
	for (let i = 0; i < shapes.length; i++) {
		for (let j = i + 1; j < shapes.length; j++) {
			assert.notEqual(shapes[i][1], shapes[j][1], `${shapes[i][0]} == ${shapes[j][0]}`);
		}
	}
});

t('RITUAL_SCORES : chacune finit par une montée puis l\'impact final (§36)', () => {
	for (const [family, score] of Object.entries(RITUAL_SCORES)) {
		const voices = score.map((e) => e.voice);
		assert.equal(voices[voices.length - 1], 'impact', `${family} : pas d'impact final`);
		assert.ok(voices.includes('sweep'), `${family} : pas de montée`);
		assert.ok(voices.lastIndexOf('sweep') < voices.length - 1, `${family} : montée après l'impact`);
	}
});

t('scoreFor : rend une partition non vide pour les 6 familles × les 4 variantes', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			assert.ok(scoreFor(family, ms).length > 0, `${family} / ${ms}ms`);
		}
	}
});

t('scoreFor : rien ne dépasse la durée de la variante', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			for (const ev of scoreFor(family, ms)) {
				assert.ok(ev.atMs >= 0 && ev.atMs <= ms, `${family}/${ms} : atMs=${ev.atMs}`);
			}
		}
	}
});

t('scoreFor : l\'impact final est ancré à la fin, quelle que soit la variante', () => {
	for (const family of HACK_TYPES) {
		for (const ms of VARIANT_MS) {
			const score = scoreFor(family, ms);
			const last = score[score.length - 1];
			assert.equal(last.voice, 'impact', `${family}/${ms}`);
			// Dans les 10 derniers pourcents : la culmination tombe avec la fin
			// de la variante, elle ne flotte pas au milieu.
			assert.ok(last.atMs >= ms * 0.90, `${family}/${ms} : impact à ${last.atMs}`);
		}
	}
});

t('scoreFor : la variante change la durée, pas la construction', () => {
	for (const family of HACK_TYPES) {
		const shapes = VARIANT_MS.map((ms) => scoreFor(family, ms).map((e) => e.voice).join('>'));
		assert.equal(new Set(shapes).size, 1, `${family} : la suite de voix change avec la variante`);
	}
	// Mais l'étalement, lui, change bien.
	const spans = VARIANT_MS.map((ms) => {
		const s = scoreFor('LINK HIJACK', ms);
		return s[s.length - 1].atMs;
	});
	for (let i = 1; i < spans.length; i++) assert.ok(spans[i] > spans[i - 1]);
});

t('scoreFor : les voix percussives gardent leur durée propre, les tenues s\'étirent', () => {
	const short = scoreFor('FIRMWARE OVERRIDE', 1000);
	const long = scoreFor('FIRMWARE OVERRIDE', 4000);
	for (let i = 0; i < short.length; i++) {
		if (PERCUSSIVE.includes(short[i].voice)) {
			assert.equal(short[i].durS, long[i].durS, 'un glitch dure autant à V1 qu\'à V4');
		} else {
			assert.ok(long[i].durS > short[i].durS, `${short[i].voice} devrait s'étirer`);
		}
	}
});

t('scoreFor : famille inconnue → partition vide plutôt qu\'un plantage', () => {
	assert.deepEqual(scoreFor('PAS UNE FAMILLE', 2000), []);
});
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: FAIL — `SyntaxError` ou `VOICES is not defined` (les symboles n'existent pas encore).

- [ ] **Step 3: Écrire les partitions**

Ajouter à la fin de `tools/ui-audio-model.mjs` :

```js
// --- partitions de rituel (Bible §36) ---------------------------------------

// Les voix. Vocabulaire DÉCORATIF : ce sont des enveloppes et des fréquences,
// rien qui encode une procédure — même règle de sécurité qu'en PHASE 09/10.
export const VOICES = ['click', 'pulse', 'bass', 'glitch', 'sweep', 'stab', 'impact', 'tone'];

// Les voix dont l'enveloppe est fixée par le rendu et non par la partition : un
// click dure ce que dure un click, à V1 comme à V4. Les autres s'étirent avec
// la variante, ce qui fait qu'un V4 respire au lieu d'être un V1 clairsemé.
export const PERCUSSIVE = ['click', 'glitch', 'stab'];

// Six séquences écrites à la main, une par famille — pas une grammaire
// pondérée. Les identités reprennent le vocabulaire visuel déjà en place dans
// src/hack-grammars.js, pour qu'une famille se reconnaisse à l'œil et à
// l'oreille de la même manière.
//
// `at` et `dur` sont en unités NORMALISÉES 0..1 : c'est ce qui évite d'écrire
// vingt-quatre partitions. scoreFor() les met à l'échelle de la variante.
// Aucune n'est une chanson : pas de mesure régulière, pas de tonalité, pas de
// boucle.
export const RITUAL_SCORES = {
	// paquets — rafales de clicks staccato, groupées irrégulièrement
	'COMMAND INJECTION': [
		{ at: 0.00, voice: 'click', freq: 4200 },
		{ at: 0.03, voice: 'click', freq: 3800 },
		{ at: 0.06, voice: 'click', freq: 4400 },
		{ at: 0.16, voice: 'click', freq: 3600 },
		{ at: 0.19, voice: 'click', freq: 4100 },
		{ at: 0.28, voice: 'click', freq: 4600 },
		{ at: 0.31, voice: 'click', freq: 3900 },
		{ at: 0.34, voice: 'click', freq: 4300 },
		{ at: 0.37, voice: 'click', freq: 4000 },
		{ at: 0.50, voice: 'pulse', freq: 90, dur: 0.10 },
		{ at: 0.58, voice: 'click', freq: 4500 },
		{ at: 0.61, voice: 'click', freq: 4200 },
		{ at: 0.64, voice: 'click', freq: 3700 },
		{ at: 0.74, voice: 'stab', freq: 1400 },
		{ at: 0.82, voice: 'sweep', freq: 220, to: 1800, dur: 0.11 },
		{ at: 0.93, voice: 'impact', freq: 52, dur: 0.07 },
	],
	// porteuse — un ton qu'on plie, puis qu'on capture
	'LINK HIJACK': [
		{ at: 0.00, voice: 'tone', freq: 880, dur: 0.30 },
		{ at: 0.22, voice: 'bass', freq: 55, dur: 0.40 },
		{ at: 0.34, voice: 'tone', freq: 880, to: 660, dur: 0.28 },
		{ at: 0.50, voice: 'glitch', freq: 1200 },
		{ at: 0.56, voice: 'tone', freq: 660, to: 1320, dur: 0.22 },
		{ at: 0.70, voice: 'pulse', freq: 70, dur: 0.09 },
		{ at: 0.80, voice: 'sweep', freq: 300, to: 2200, dur: 0.13 },
		{ at: 0.93, voice: 'impact', freq: 48, dur: 0.07 },
	],
	// oscilloscope — pulses modulés, wobble de filtre
	'TELEMETRY SPOOF': [
		{ at: 0.00, voice: 'pulse', freq: 120, dur: 0.09 },
		{ at: 0.10, voice: 'pulse', freq: 105, dur: 0.09 },
		{ at: 0.20, voice: 'pulse', freq: 135, dur: 0.09 },
		{ at: 0.30, voice: 'bass', freq: 62, dur: 0.26 },
		{ at: 0.38, voice: 'pulse', freq: 95, dur: 0.07 },
		{ at: 0.46, voice: 'pulse', freq: 150, dur: 0.07 },
		{ at: 0.55, voice: 'glitch', freq: 900 },
		{ at: 0.62, voice: 'pulse', freq: 110, dur: 0.06 },
		{ at: 0.68, voice: 'pulse', freq: 175, dur: 0.06 },
		{ at: 0.78, voice: 'sweep', freq: 260, to: 1600, dur: 0.14 },
		{ at: 0.93, voice: 'impact', freq: 50, dur: 0.07 },
	],
	// position — paire désaccordée qui dérive, battement qui s'élargit
	'GNSS SPOOF': [
		{ at: 0.00, voice: 'tone', freq: 440, dur: 0.50 },
		{ at: 0.02, voice: 'tone', freq: 443, dur: 0.48 },
		{ at: 0.34, voice: 'tone', freq: 440, dur: 0.40 },
		{ at: 0.36, voice: 'tone', freq: 451, dur: 0.38 },
		{ at: 0.58, voice: 'bass', freq: 48, dur: 0.30 },
		{ at: 0.66, voice: 'tone', freq: 440, dur: 0.26 },
		{ at: 0.68, voice: 'tone', freq: 468, dur: 0.24 },
		{ at: 0.80, voice: 'sweep', freq: 200, to: 1400, dur: 0.13 },
		{ at: 0.93, voice: 'impact', freq: 44, dur: 0.07 },
	],
	// nœuds — clicks en cascade, densité croissante
	'NETWORK TAKEOVER': [
		{ at: 0.00, voice: 'click', freq: 2600 },
		{ at: 0.14, voice: 'click', freq: 2900 },
		{ at: 0.18, voice: 'click', freq: 3100 },
		{ at: 0.30, voice: 'click', freq: 3300 },
		{ at: 0.33, voice: 'click', freq: 2800 },
		{ at: 0.36, voice: 'click', freq: 3500 },
		{ at: 0.46, voice: 'pulse', freq: 80, dur: 0.10 },
		{ at: 0.52, voice: 'click', freq: 3700 },
		{ at: 0.54, voice: 'click', freq: 3200 },
		{ at: 0.56, voice: 'click', freq: 3900 },
		{ at: 0.58, voice: 'click', freq: 3400 },
		{ at: 0.60, voice: 'click', freq: 4100 },
		{ at: 0.70, voice: 'bass', freq: 44, dur: 0.30 },
		{ at: 0.80, voice: 'sweep', freq: 180, to: 2000, dur: 0.13 },
		{ at: 0.93, voice: 'impact', freq: 40, dur: 0.07 },
	],
	// mémoire — blocs glitchés, puis une écriture qui claque
	'FIRMWARE OVERRIDE': [
		{ at: 0.00, voice: 'glitch', freq: 1500 },
		{ at: 0.14, voice: 'glitch', freq: 1100 },
		{ at: 0.24, voice: 'bass', freq: 38, dur: 0.34 },
		{ at: 0.34, voice: 'glitch', freq: 1800 },
		{ at: 0.48, voice: 'glitch', freq: 700 },
		{ at: 0.52, voice: 'glitch', freq: 2100 },
		{ at: 0.62, voice: 'stab', freq: 1900 },
		{ at: 0.70, voice: 'glitch', freq: 1300 },
		{ at: 0.82, voice: 'sweep', freq: 150, to: 2400, dur: 0.11 },
		{ at: 0.93, voice: 'impact', freq: 36, dur: 0.07 },
	],
};

// Durée d'enveloppe des voix percussives, en secondes. Fixe : un click ne
// s'étire pas parce que la variante est plus longue.
const PERCUSSIVE_DUR_S = { click: 0.02, glitch: 0.09, stab: 0.14 };

// Met une partition à l'échelle de la variante (V1≈1000 ms … V4≈4000 ms, cf.
// tools/ritual-model.mjs). La variante change la durée et l'étalement, jamais
// la suite de voix — c'est exactement ce que demande la Bible §36.
export function scoreFor(hackType, variantMs) {
	const score = RITUAL_SCORES[hackType];
	if (!score) return [];
	return score.map((ev) => ({
		atMs: ev.at * variantMs,
		durS: PERCUSSIVE.includes(ev.voice)
			? PERCUSSIVE_DUR_S[ev.voice]
			: (ev.dur ?? 0.1) * (variantMs / 1000),
		voice: ev.voice,
		freq: ev.freq,
		to: ev.to,
		gain: ev.gain,
	}));
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: PASS — 26 tests OK.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/ui-audio-model.mjs sim/tools/ui-audio-selftest.mjs
git commit -m "PHASE 18 : six partitions de rituel, une par famille de hack"
```

---

### Task 3: `tools/lib/fake-audio-ctx.mjs` — rendre le graphe testable headless

Sans ce faux contexte, tout `src/ui-audio.js` et toute la refonte du bus seraient « vérifiés » en cliquant dans un navigateur. Ce module rend le graphe et l'ordonnancement assertables sous Node.

**Files:**
- Create: `tools/lib/fake-audio-ctx.mjs`
- Modify: `tools/ui-audio-selftest.mjs` (tests du faux contexte lui-même)

**Interfaces:**
- Consumes: rien.
- Produces:
  - `fakeAudioContext(opts?: { sampleRate?: number, state?: string }): FakeCtx`.
  - `FakeCtx` expose l'API Web Audio utilisée par le dépôt (`createGain`, `createOscillator`, `createBiquadFilter`, `createStereoPanner`, `createDynamicsCompressor`, `createBufferSource`, `createBuffer`, `destination`, `currentTime`, `state`, `resume()`, `close()`) plus l'introspection `_nodes: FakeNode[]` et `_conns: Array<[number, number|string]>`.
  - `FakeNode` : `{ id, type, connect(dst), disconnect(), started, stopped, onended, ...params }`. Chaque `AudioParam` est `{ value, calls: Array<[string, ...number]> }`.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `tools/ui-audio-selftest.mjs` (et l'import `import { fakeAudioContext } from './lib/fake-audio-ctx.mjs';` en tête) :

```js
// --- faux AudioContext ------------------------------------------------------

t('fakeAudioContext : les nœuds créés sont recensés et connectables', () => {
	const ctx = fakeAudioContext();
	const g = ctx.createGain();
	const o = ctx.createOscillator();
	o.connect(g).connect(ctx.destination);
	assert.equal(ctx._nodes.length, 3); // destination + gain + oscillateur
	assert.ok(ctx._conns.some(([from, to]) => from === o.id && to === g.id));
	assert.ok(ctx._conns.some(([from, to]) => from === g.id && to === ctx.destination.id));
});

t('fakeAudioContext : les AudioParam enregistrent leurs automations', () => {
	const ctx = fakeAudioContext();
	const g = ctx.createGain();
	g.gain.setValueAtTime(0, 0);
	g.gain.linearRampToValueAtTime(1, 0.5);
	assert.equal(g.gain.calls.length, 2);
	assert.equal(g.gain.calls[1][0], 'linearRampToValueAtTime');
});

t('fakeAudioContext : start/stop d\'une source sont horodatés', () => {
	const ctx = fakeAudioContext();
	const src = ctx.createBufferSource();
	src.start(1.25);
	src.stop(1.75);
	assert.equal(src.started, 1.25);
	assert.equal(src.stopped, 1.75);
});

t('fakeAudioContext : on peut connecter vers un AudioParam', () => {
	const ctx = fakeAudioContext();
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.connect(g.gain);
	assert.ok(ctx._conns.some(([from, to]) => from === o.id && to === 'param:gain'));
});
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: FAIL — `Cannot find module './lib/fake-audio-ctx.mjs'`

- [ ] **Step 3: Écrire le faux contexte**

Créer `tools/lib/fake-audio-ctx.mjs` :

```js
// Faux AudioContext, juste assez complet pour les modules audio du dépôt
// (PHASE 18). Il n'émet aucun son : il RECENSE. Ce qu'on veut pouvoir affirmer
// sous Node, sans navigateur :
//   - le graphe est branché jusqu'à la destination (un `connect` oublié est
//     silencieux dans une vraie Web Audio, et donc invisible à l'oreille comme
//     au débogueur) ;
//   - une partition est programmée aux bons instants ;
//   - rien ne fuit : tout nœud one-shot finit disconnect().
//
// Aucune dépendance. Ne sert qu'aux tests.

function makeParam(name, value) {
	return {
		_param: `param:${name}`,
		value,
		calls: [],
		setValueAtTime(v, t) { this.value = v; this.calls.push(['setValueAtTime', v, t]); return this; },
		linearRampToValueAtTime(v, t) { this.value = v; this.calls.push(['linearRampToValueAtTime', v, t]); return this; },
		exponentialRampToValueAtTime(v, t) { this.value = v; this.calls.push(['exponentialRampToValueAtTime', v, t]); return this; },
		setTargetAtTime(v, t, tau) { this.value = v; this.calls.push(['setTargetAtTime', v, t, tau]); return this; },
		cancelScheduledValues(t) { this.calls.push(['cancelScheduledValues', t]); return this; },
	};
}

export function fakeAudioContext({ sampleRate = 48000, state = 'running' } = {}) {
	const nodes = [];
	const conns = [];
	let nextId = 0;

	const node = (type, extra = {}) => {
		const n = {
			id: ++nextId,
			type,
			disconnected: false,
			connect(dst) {
				conns.push([this.id, dst.id ?? dst._param ?? 'unknown']);
				return dst;
			},
			disconnect() { this.disconnected = true; },
			...extra,
		};
		nodes.push(n);
		return n;
	};

	const source = (type, extra = {}) => node(type, {
		started: null,
		stopped: null,
		onended: null,
		start(t = 0) { this.started = t; },
		stop(t = 0) { this.stopped = t; },
		...extra,
	});

	const ctx = {
		sampleRate,
		state,
		currentTime: 0,
		createGain: () => node('gain', { gain: makeParam('gain', 1) }),
		createOscillator: () => source('oscillator', {
			type: 'sine',
			frequency: makeParam('frequency', 440),
			detune: makeParam('detune', 0),
		}),
		createBiquadFilter: () => node('biquad', {
			type: 'lowpass',
			frequency: makeParam('frequency', 350),
			Q: makeParam('Q', 1),
			gain: makeParam('gain', 0),
		}),
		createStereoPanner: () => node('panner', { pan: makeParam('pan', 0) }),
		createDynamicsCompressor: () => node('compressor', {
			threshold: makeParam('threshold', -24),
			knee: makeParam('knee', 30),
			ratio: makeParam('ratio', 12),
			attack: makeParam('attack', 0.003),
			release: makeParam('release', 0.25),
		}),
		createBufferSource: () => source('bufferSource', {
			buffer: null,
			loop: false,
			playbackRate: makeParam('playbackRate', 1),
			detune: makeParam('detune', 0),
		}),
		createBuffer: (channels, length, rate) => ({
			numberOfChannels: channels,
			length,
			sampleRate: rate,
			getChannelData: () => new Float32Array(length),
		}),
		resume() { this.state = 'running'; return Promise.resolve(); },
		close() { this.state = 'closed'; return Promise.resolve(); },
		_nodes: nodes,
		_conns: conns,
	};
	ctx.destination = node('destination');
	return ctx;
}

// Vrai si `from` atteint `to` en suivant les connexions. Le test utile n'est
// pas « le nœud existe » mais « le son sort ».
export function reaches(ctx, from, to, seen = new Set()) {
	if (from === to) return true;
	if (seen.has(from)) return false;
	seen.add(from);
	return ctx._conns
		.filter(([a]) => a === from)
		.some(([, b]) => typeof b === 'number' && reaches(ctx, b, to, seen));
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: PASS — 30 tests OK.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/lib/fake-audio-ctx.mjs sim/tools/ui-audio-selftest.mjs
git commit -m "PHASE 18 : faux AudioContext, pour tester le graphe sans navigateur"
```

---

### Task 4: `src/audio-bus.js` — contexte et limiteur partagés

**Files:**
- Create: `src/audio-bus.js`
- Modify: `src/audio.js` (`start`, `_build`, `setVolume`, `_applyMaster`, `dispose`)
- Create: `tools/audio-bus-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `fakeAudioContext`, `reaches` (Tâche 3) pour les tests.
- Produces (`src/audio-bus.js`) :
  - `ensureContext(): AudioContext | null` — idempotent, `resume()` un contexte suspendu, `null` si pas de Web Audio.
  - `context(): AudioContext | null`.
  - `engineIn(): GainNode | null` — entrée de la chaîne moteur.
  - `uiIn(): GainNode | null` — entrée de la chaîne d'interface.
  - `setVolume(v: number): void` — 0..1, appliqué **après** le limiteur.
  - `_setContextFactory(fn): void` — injection du faux contexte pour les tests. `fn` est appelée sans argument et rend un `AudioContext`.
  - `_reset(): void` — pour les tests.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tools/audio-bus-selftest.mjs` :

```js
// Selftest du bus audio partagé (PHASE 18). Aucun navigateur : le graphe est
// monté sur un faux AudioContext et vérifié par introspection.
// Lancer : node tools/audio-bus-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const fresh = () => {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return ctx;
};

t('ensureContext : idempotent, un seul contexte', () => {
	bus._reset();
	let built = 0;
	bus._setContextFactory(() => { built++; return fakeAudioContext(); });
	const a = bus.ensureContext();
	const b = bus.ensureContext();
	assert.equal(built, 1);
	assert.equal(a, b);
});

t('ensureContext : reprend un contexte suspendu', () => {
	bus._reset();
	const ctx = fakeAudioContext({ state: 'suspended' });
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	assert.equal(ctx.state, 'running');
});

t('ensureContext : pas de Web Audio → null, aucune exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	assert.equal(bus.ensureContext(), null);
	assert.equal(bus.engineIn(), null);
	assert.equal(bus.uiIn(), null);
	bus.setVolume(0.5); // ne doit pas jeter
});

t('les deux entrées atteignent la destination', () => {
	const ctx = fresh();
	assert.ok(reaches(ctx, bus.engineIn().id, ctx.destination.id), 'chaîne moteur muette');
	assert.ok(reaches(ctx, bus.uiIn().id, ctx.destination.id), 'chaîne UI muette');
});

t('les deux entrées passent par le MÊME limiteur', () => {
	// C'est ce qui rend le mixage jugeable d'une oreille, rituel compris (#11).
	const ctx = fresh();
	const comps = ctx._nodes.filter((x) => x.type === 'compressor');
	assert.equal(comps.length, 1, `${comps.length} limiteurs`);
	assert.ok(reaches(ctx, bus.engineIn().id, comps[0].id));
	assert.ok(reaches(ctx, bus.uiIn().id, comps[0].id));
});

t('le volume est APRÈS le limiteur', () => {
	// Le seuil du limiteur devient indépendant de la position du slider : « le
	// mixage » désigne enfin une chose unique, quel que soit le volume d'écoute.
	const ctx = fresh();
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	bus.setVolume(0.42);
	const vol = ctx._nodes.find((x) => x.type === 'gain' && Math.abs(x.gain.value - 0.42) < 1e-9);
	assert.ok(vol, 'aucun gain à 0,42');
	assert.ok(reaches(ctx, comp.id, vol.id), 'le volume n\'est pas en aval du limiteur');
	assert.ok(!reaches(ctx, vol.id, comp.id), 'le volume est en amont du limiteur');
});

t('setVolume : borné à 0..1', () => {
	const ctx = fresh();
	bus.setVolume(5);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 1));
	bus.setVolume(-2);
	assert.ok(ctx._nodes.some((x) => x.type === 'gain' && x.gain.value === 0));
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `cd sim && node tools/audio-bus-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/audio-bus.js'`

- [ ] **Step 3: Écrire le bus**

Créer `src/audio-bus.js` :

```js
// Le contexte audio et le limiteur, partagés par la synthèse moteur
// (src/audio.js) et le langage sonore d'interface (src/ui-audio.js).
//
// Pourquoi un seul contexte plutôt qu'un par module : le critère d'acceptation
// de PHASE 18 est « le mixage est équilibré à l'oreille, rituel compris »
// (issue #11). Deux contextes séparés s'additionneraient à l'aveugle dans la
// carte son, sans limiteur commun ni référence de niveau — et « le mixage » ne
// désignerait plus rien de mesurable.
//
//   moteurs/vent/propwash/impacts → master(mute) → air(6k) ─┐
//                                                            ├→ limiteur → volume → destination
//   SYSTEM / LINK / RITUAL ──────→ uiMaster(trim) ───────────┘
//
// Trois conséquences, toutes voulues :
//   - l'UI ne traverse pas `air` : ce lowpass est l'excuse « on entend le drone
//     à travers une paire de lunettes », et un click d'interface doit claquer ;
//   - l'UI n'est pas coupée par audio.setMuted(frozen), qui est vrai pendant
//     TOUT l'écran de hack — un rituel muet exactement quand il doit frapper
//     serait le bug le plus bête de la phase ;
//   - le rituel est limité avec le reste : un vrai mixage, pas deux sorties qui
//     se marchent dessus.

// Reprises telles quelles de src/audio.js, où elles étaient mesurées : le point
// le plus fort du sim (plein gaz + rush + impact) laisse ~1,6 dB de marge, et
// des oscillateurs désaccordés finissent par se mettre en phase et la manger.
const LIMIT = { threshold: -3, ratio: 20, attack: 0.003, release: 0.1 };

// Trim de la chaîne d'interface. À équilibrer à l'oreille (issue #11) : les
// sons d'UI sont rares et doivent porter sans écraser les moteurs.
const UI_TRIM = 0.5;

const TAU = 0.08; // lissage du volume, comme AUDIO.tauMaster

let ctx = null;
let engine = null;
let ui = null;
let volume = null;
let factory = null;

// Injection pour les tests (tools/audio-bus-selftest.mjs). En production la
// fabrique par défaut est le constructeur du navigateur.
export function _setContextFactory(fn) { factory = fn; }

export function _reset() {
	ctx = engine = ui = volume = null;
	factory = null;
}

function defaultFactory() {
	const Ctx = typeof window !== 'undefined'
		? (window.AudioContext ?? window.webkitAudioContext)
		: null;
	return Ctx ? new Ctx() : null;
}

// Doit être appelé depuis un geste utilisateur : les navigateurs refusent de
// démarrer un AudioContext autrement. Idempotent, et reprend un contexte que
// le navigateur a suspendu dans notre dos (changement d'onglet, autoplay).
export function ensureContext() {
	if (ctx) {
		if (ctx.state === 'suspended') ctx.resume();
		return ctx;
	}
	ctx = (factory ?? defaultFactory)();
	if (!ctx) return null;              // pas de Web Audio : on reste muet, on ne jette pas

	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = LIMIT.threshold;
	limiter.knee.value = 0;
	limiter.ratio.value = LIMIT.ratio;
	limiter.attack.value = LIMIT.attack;
	limiter.release.value = LIMIT.release;

	volume = ctx.createGain();
	volume.gain.value = 1;

	engine = ctx.createGain();
	engine.gain.value = 1;
	ui = ctx.createGain();
	ui.gain.value = UI_TRIM;

	engine.connect(limiter);
	ui.connect(limiter);
	limiter.connect(volume).connect(ctx.destination);

	if (ctx.state === 'suspended') ctx.resume();
	return ctx;
}

export function context() { return ctx; }
export function engineIn() { return engine; }
export function uiIn() { return ui; }

export function setVolume(v) {
	if (!volume || !ctx) return;
	const target = v < 0 ? 0 : v > 1 ? 1 : v;
	volume.gain.setTargetAtTime(target, ctx.currentTime, TAU);
	volume.gain.value = target;   // le faux contexte n'interpole pas ; le vrai ignore
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `cd sim && node tools/audio-bus-selftest.mjs`
Expected: PASS — 7 tests OK.

- [ ] **Step 5: Brancher `src/audio.js` sur le bus**

Cinq modifications, et rien d'autre. Aucune constante de `AUDIO` ne bouge, sauf les quatre du limiteur qui sont **supprimées** (elles vivent dans `audio-bus.js`).

1. En tête du fichier, ajouter l'import :

```js
import { ensureContext, engineIn, setVolume as setBusVolume } from './audio-bus.js';
```

2. Dans `AUDIO`, supprimer les quatre lignes `limitThreshold`, `limitRatio`, `limitAttack`, `limitRelease` et le bloc de commentaire « Ceiling. … » qui les précède, en le remplaçant par :

```js
	// Le limiteur et le plafond vivent dans src/audio-bus.js : ils sont partagés
	// avec la chaîne d'interface, pour que le mixage soit une chose unique.
```

3. Remplacer le corps de `start()` par :

```js
	start() {
		if (this.ctx) {
			if (this.ctx.state === 'suspended') this.ctx.resume();
			return;
		}
		const ctx = ensureContext();
		if (!ctx) return;                       // no Web Audio: stay silent, don't throw
		this.ctx = ctx;
		this._masterTarget = 0;
		this._build(ctx);
	}
```

4. Dans `_build()`, supprimer la construction du `limiter` et remplacer la ligne de branchement

```js
		this.master.connect(this.air).connect(this.limiter).connect(ctx.destination);
```

par

```js
		// Le limiteur et le volume sont en aval, dans le bus partagé.
		this.master.connect(this.air).connect(engineIn());
```

5. Remplacer `setVolume`, `_applyMaster` et `dispose` par :

```js
	setVolume(v) {
		this.volume = Math.min(Math.max(v, 0), 1);
		setBusVolume(this.volume);
	}

	// Ne porte plus que le mute : le volume est global et vit dans le bus, en
	// aval du limiteur. Ramped rather than suspended: free camera is toggled
	// often enough that a hard cut would click every time.
	_applyMaster() {
		if (!this.ctx || !this.master) return;
		const target = this.muted ? 0 : 1;
		if (target === this._masterTarget) return;
		this._masterTarget = target;
		this.master.gain.setTargetAtTime(target, this.ctx.currentTime, AUDIO.tauMaster);
	}

	// Ne ferme PAS le contexte : il ne lui appartient plus, l'interface s'en
	// sert encore. On se contente de débrancher la chaîne moteur.
	dispose() {
		if (!this.ctx) return;
		this.master?.disconnect();
		this.ctx = null;
		this._motors = [];
	}
```

- [ ] **Step 6: Vérifier que la chaîne moteur passe toujours**

Ajouter `import { EngineAudio } from '../src/audio.js';` aux imports en tête de `tools/audio-bus-selftest.mjs`, puis ce test avant le `console.log` final :

```js
t('EngineAudio se branche sur le bus et atteint la destination', () => {
	const ctx = fresh();
	const a = new EngineAudio();
	a.start();
	assert.ok(reaches(ctx, a.master.id, ctx.destination.id), 'la chaîne moteur est muette');
	const comp = ctx._nodes.find((x) => x.type === 'compressor');
	assert.ok(reaches(ctx, a.master.id, comp.id), 'la chaîne moteur évite le limiteur');
	// Le mute ne coupe QUE le moteur, et le volume n'est plus porté par master.
	a.setMuted(true);
	assert.equal(a.master.gain.value, 0);
	a.setMuted(false);
	assert.equal(a.master.gain.value, 1);
});
```

`src/audio.js` importe `src/quad.js`, qui est du calcul pur sans DOM ni Rapier : l'import statique passe sous Node.

Run: `cd sim && node tools/audio-bus-selftest.mjs`
Expected: PASS — 8 tests OK.

- [ ] **Step 7: Brancher sur `selftest:operator` et vérifier le banc physique**

Dans `package.json`, ajouter ` && node tools/audio-bus-selftest.mjs` au script `selftest:operator`.

Run: `cd sim && npm run selftest:operator && npm run build`
Expected: PASS des deux ; le build Vite ne signale aucun import manquant.

Run: `cd sim && npm run selftest`
Expected: PASS — le banc physique est vert, comme avant.

- [ ] **Step 8: Commit**

```bash
git add sim/src/audio-bus.js sim/src/audio.js sim/tools/audio-bus-selftest.mjs sim/package.json
git commit -m "PHASE 18 : contexte et limiteur partagés entre moteur et interface"
```

---

### Task 5: `src/ui-audio.js` — le rendu des voix

**Files:**
- Create: `src/ui-audio.js`
- Create: `tools/ui-audio-render-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ensureContext`, `uiIn`, `context` (Tâche 4) ; `UI_EVENTS`, `BOOT_SIGNATURE`, `scoreFor` (Tâches 1-2) ; `fakeAudioContext`, `reaches` (Tâche 3).
- Produces:
  - `class UiAudio`
    - `new UiAudio()`
    - `play(event: string): void` — un des sept `UI_EVENTS`. Un nom hors liste jette (`Error`), pour que la faute se voie au développement et non à l'oreille.
    - `armBoot(): void` — joue `BOOT` tout de suite si le contexte démarre, sinon l'arme sur le premier geste, avec abandon au-delà de `BOOT_ARM_WINDOW_S`.
    - `playRitual(hackType: string, variantMs: number): void`
    - `setLinkQuality(q: number): void`
    - `linkSilent(): void`
    - `get nodesCreated(): number` — compteur, pour prouver que rien ne fuit.
  - `BOOT_ARM_WINDOW_S: 20`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tools/ui-audio-render-selftest.mjs` :

```js
// Selftest du rendu sonore d'interface (PHASE 18). Monté sur un faux
// AudioContext : ce qu'on vérifie ici est le GRAPHE et l'ORDONNANCEMENT, pas le
// timbre — le timbre se juge à l'oreille (issue #11).
// Lancer : node tools/ui-audio-render-selftest.mjs
import assert from 'node:assert/strict';
import { fakeAudioContext, reaches } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { UI_EVENTS, scoreFor, BOOT_SIGNATURE } from './ui-audio-model.mjs';
import { HACK_TYPES } from './target-model.mjs';
import { UiAudio } from '../src/ui-audio.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const fresh = () => {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return { ctx, ui: new UiAudio() };
};

const sources = (ctx) => ctx._nodes.filter((x) => x.started !== undefined && x.started !== null);

t('play : les sept événements produisent du son et atteignent la destination', () => {
	for (const ev of UI_EVENTS) {
		const { ctx, ui } = fresh();
		ui.play(ev);
		const srcs = sources(ctx);
		assert.ok(srcs.length > 0, `${ev} : aucune source démarrée`);
		for (const s of srcs) {
			assert.ok(reaches(ctx, s.id, ctx.destination.id), `${ev} : source ${s.id} muette`);
		}
	}
});

t('play : un nom hors du vocabulaire clos jette', () => {
	const { ui } = fresh();
	assert.throws(() => ui.play('BUTTON_CLICK'), /BUTTON_CLICK/);
	assert.throws(() => ui.play('HOVER'), /HOVER/);
});

t('play : sans Web Audio, silencieux et sans exception', () => {
	bus._reset();
	bus._setContextFactory(() => null);
	const ui = new UiAudio();
	for (const ev of UI_EVENTS) ui.play(ev);
	ui.playRitual('LINK HIJACK', 2000);
	ui.setLinkQuality(0.5);
	ui.linkSilent();
	ui.armBoot();
});

t('BOOT : cinq notes, aux instants de BOOT_SIGNATURE', () => {
	const { ctx, ui } = fresh();
	ctx.currentTime = 10;
	ui.play('BOOT');
	const starts = sources(ctx).map((s) => s.started).sort((a, b) => a - b);
	assert.equal(starts.length, BOOT_SIGNATURE.length);
	BOOT_SIGNATURE.forEach((note, i) => {
		assert.ok(Math.abs(starts[i] - (10 + note.atMs / 1000)) < 1e-6,
			`note ${i} : ${starts[i]} au lieu de ${10 + note.atMs / 1000}`);
	});
});

t('playRitual : un départ par événement de la partition, aux bons instants', () => {
	for (const family of HACK_TYPES) {
		for (const ms of [1000, 2000, 3000, 4000]) {
			const { ctx, ui } = fresh();
			ctx.currentTime = 5;
			ui.playRitual(family, ms);
			const score = scoreFor(family, ms);
			const starts = sources(ctx).map((s) => s.started).sort((a, b) => a - b);
			assert.equal(starts.length, score.length, `${family}/${ms}`);
			score.map((e) => 5 + e.atMs / 1000).sort((a, b) => a - b).forEach((want, i) => {
				assert.ok(Math.abs(starts[i] - want) < 1e-6, `${family}/${ms} événement ${i}`);
			});
		}
	}
});

t('playRitual : tout est programmé d\'un coup, sur l\'horloge audio', () => {
	// Une culmination de 1 à 4 s doit rester juste même si une frame saute
	// pendant que la carte finit de charger : rien ne doit dépendre d'un timer.
	const { ctx, ui } = fresh();
	ui.playRitual('NETWORK TAKEOVER', 4000);
	const starts = sources(ctx).map((s) => s.started);
	assert.ok(Math.max(...starts) - Math.min(...starts) > 3.5,
		'la partition n\'est pas étalée sur toute la variante');
});

t('playRitual : famille inconnue → silence, pas de plantage', () => {
	const { ctx, ui } = fresh();
	ui.playRitual('PAS UNE FAMILLE', 2000);
	assert.equal(sources(ctx).length, 0);
});

t('les one-shots se démontent : onended débranche tout', () => {
	const { ctx, ui } = fresh();
	// On ne regarde que les nœuds nés de CET appel : le bus a monté les siens
	// avant, et ils sont permanents.
	const before = ctx._nodes.length;
	ui.play('TARGET_FOUND');
	const created = ctx._nodes.slice(before);
	const srcs = created.filter((x) => x.started !== undefined && x.started !== null);
	assert.ok(srcs.length > 0, 'aucune source créée');
	for (const s of srcs) {
		assert.equal(typeof s.onended, 'function', 'source sans onended : ça fuit');
		s.onended();
	}
	for (const node of created) {
		assert.ok(node.disconnected, `nœud ${node.type} #${node.id} non débranché : ça fuit`);
	}
});

t('setLinkQuality : une seule branche permanente, aucun nœud par appel', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(0.9);
	const after1 = ctx._nodes.length;
	for (let i = 0; i < 600; i++) ui.setLinkQuality(0.5 + 0.4 * Math.sin(i / 20));
	assert.equal(ctx._nodes.length, after1, 'le carrier crée des nœuds par frame');
});

t('setLinkQuality : la porteuse atteint la destination et suit la qualité', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(1);
	const carrier = ctx._nodes.find((x) => x.type === 'gain' && x.gain.calls.length > 0);
	assert.ok(carrier, 'aucun gain automatisé pour la porteuse');
	assert.ok(reaches(ctx, carrier.id, ctx.destination.id));
	const before = carrier.gain.value;
	ui.setLinkQuality(0.05);
	assert.notEqual(carrier.gain.value, before, 'la porteuse ne suit pas la qualité');
});

t('linkSilent : coupe la porteuse sans démonter la branche', () => {
	const { ctx, ui } = fresh();
	ui.setLinkQuality(0.8);
	const count = ctx._nodes.length;
	ui.linkSilent();
	assert.equal(ctx._nodes.length, count);
});

t('armBoot : contexte vivant → la signature part tout de suite', () => {
	const { ctx, ui } = fresh();
	ui.armBoot();
	assert.equal(sources(ctx).length, BOOT_SIGNATURE.length);
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `cd sim && node tools/ui-audio-render-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/ui-audio.js'`

- [ ] **Step 3: Écrire le rendu**

Créer `src/ui-audio.js` :

```js
// Le rendu du langage sonore d'interface (PHASE 18, Bible §34-36). Prend le bus
// partagé (src/audio-bus.js) et joue ce que décrit le modèle pur
// (tools/ui-audio-model.mjs). Aucun DOM au-delà des deux écouteurs de geste,
// aucun Three, aucun Rapier : JAMAIS importé par le moteur.
//
// Tout est synthétisé, rien n'est chargé : aucune question de droits sur une
// source, et le tout pèse ce que pèse ce fichier.
//
// Aucune voix, aucun narrateur, aucune commande vocale (Bible §37).
import { ensureContext, context, uiIn } from './audio-bus.js';
import { UI_EVENTS, BOOT_SIGNATURE, scoreFor } from '../tools/ui-audio-model.mjs';

// Au-delà de cette fenêtre, une signature de démarrage armée est ABANDONNÉE
// plutôt que jouée : un son de boot qui part une minute après le boot n'est
// plus un son de boot. Mieux vaut le silence.
export const BOOT_ARM_WINDOW_S = 20;

// Niveaux relatifs des familles. Rares et brefs : ils doivent porter sans
// écraser les moteurs. À équilibrer à l'oreille (issue #11).
const LEVEL = {
	boot: 0.30,
	system: 0.22,
	link: 0.26,
	ritual: 0.34,
	carrier: 0.06,      // un lit, pas un événement
};

const CARRIER_HZ = 320;       // bande de la porteuse : là où un récepteur siffle
const CARRIER_TAU = 0.25;     // lissage, du même ordre que link.js:NOISE_TAU

export class UiAudio {
	constructor() {
		this._carrier = null;
		this._noise = null;
		this._bootArmedAt = null;
		this._bootHandler = null;
		this.nodesCreated = 0;
	}

	// --- primitives ---------------------------------------------------------

	// Deux secondes de bruit blanc bouclé : une seule source alimente toutes les
	// branches bruitées, qui ne diffèrent que par leurs filtres. Même idiome que
	// src/audio.js.
	_noiseBuffer(ctx) {
		// Mémorisé AVEC son contexte : un AudioBuffer né d'un autre contexte est
		// refusé à la lecture, et le cas se produit dès qu'un test remonte le bus.
		if (!this._noiseBuf || this._noiseCtx !== ctx) {
			const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
			const d = buf.getChannelData(0);
			for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
			this._noiseBuf = buf;
			this._noiseCtx = ctx;
		}
		return this._noiseBuf;
	}

	// Un one-shot : construit ses nœuds, se démonte sur onended. C'est le seul
	// endroit de ce fichier où un nœud naît après le montage, et jamais par
	// frame — la porteuse, elle, est permanente.
	_shot(ctx, at, durS, build) {
		const out = ctx.createGain();
		out.connect(uiIn());
		const parts = [out];
		const src = build(out, parts);
		if (!src) return;
		src.start(at);
		src.stop(at + durS + 0.05);
		src.onended = () => { for (const p of parts) p.disconnect(); src.disconnect(); };
		this.nodesCreated += parts.length + 1;
	}

	// Enveloppe percussive commune : attaque immédiate, décroissance
	// exponentielle. `exponentialRampToValueAtTime` ne peut pas viser zéro.
	_env(param, at, durS, peak) {
		param.setValueAtTime(0.0001, at);
		param.exponentialRampToValueAtTime(peak, at + 0.002);
		param.exponentialRampToValueAtTime(0.0001, at + durS);
	}

	// Une voix de la partition, à l'instant absolu `at` de l'horloge audio.
	_voice(ctx, ev, at, level) {
		const { voice, durS } = ev;
		const gain = level * (ev.gain ?? 1);

		if (voice === 'click') {
			this._shot(ctx, at, durS, (out, parts) => {
				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = ev.freq ?? 3500;
				bp.Q.value = 2.5;
				const src = ctx.createBufferSource();
				src.buffer = this._noiseBuffer(ctx);
				src.connect(bp).connect(out);
				this._env(out.gain, at, durS, gain);
				parts.push(bp);
				return src;
			});
			return;
		}

		if (voice === 'glitch') {
			// Bruit annelé : un oscillateur module l'amplitude d'une bande de
			// bruit. C'est la façon la plus courte d'obtenir « numérique cassé »
			// sans charger un échantillon.
			this._shot(ctx, at, durS, (out, parts) => {
				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = ev.freq ?? 1400;
				bp.Q.value = 6;
				const ring = ctx.createGain();
				ring.gain.value = 0;
				const mod = ctx.createOscillator();
				mod.type = 'square';
				mod.frequency.value = 70;
				mod.connect(ring.gain);
				mod.start(at);
				mod.stop(at + durS + 0.05);
				const src = ctx.createBufferSource();
				src.buffer = this._noiseBuffer(ctx);
				src.connect(bp).connect(ring).connect(out);
				this._env(out.gain, at, durS, gain);
				parts.push(bp, ring, mod);
				return src;
			});
			return;
		}

		if (voice === 'impact') {
			// La retombée : un grave qui chute. Elle ne reprend AUCUN élément de
			// la signature de boot (Bible §35).
			//
			// `_shot` démarre et arrête la source qu'on lui rend : ne PAS appeler
			// start() ici en plus, un double start() jette InvalidStateError.
			const total = durS * 3;
			this._shot(ctx, at, total, (out, parts) => {
				const lp = ctx.createBiquadFilter();
				lp.type = 'lowpass';
				lp.frequency.value = 900;
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.setValueAtTime((ev.freq ?? 45) * 3, at);
				osc.frequency.exponentialRampToValueAtTime(ev.freq ?? 45, at + total * 0.7);
				osc.connect(lp).connect(out);
				this._env(out.gain, at, total, gain * 1.4);
				parts.push(lp);
				return osc;
			});
			return;
		}

		// Voix à oscillateur : tone, pulse, bass, sweep, stab.
		this._shot(ctx, at, durS, (out, parts) => {
			const osc = ctx.createOscillator();
			osc.type = voice === 'stab' ? 'sawtooth' : voice === 'bass' ? 'triangle' : 'sine';
			const f0 = ev.freq ?? 440;
			osc.frequency.setValueAtTime(f0, at);
			if (voice === 'sweep') {
				osc.frequency.exponentialRampToValueAtTime(ev.to ?? f0 * 4, at + durS);
			} else if (voice === 'pulse') {
				osc.frequency.exponentialRampToValueAtTime(Math.max(f0 * 0.4, 20), at + durS);
			} else if (ev.to) {
				osc.frequency.exponentialRampToValueAtTime(ev.to, at + durS);
			}
			const lp = ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = voice === 'bass' ? 400 : 7000;
			osc.connect(lp).connect(out);
			this._env(out.gain, at, durS, gain);
			parts.push(lp);
			return osc;
		});
	}

	// --- API ----------------------------------------------------------------

	play(event) {
		// Le vocabulaire est clos : une faute se voit au développement, pas à
		// l'oreille trois semaines plus tard.
		if (!UI_EVENTS.includes(event)) {
			throw new Error(`[ui-audio] événement hors vocabulaire : ${event}`);
		}
		const ctx = ensureContext();
		if (!ctx) return;
		const t0 = ctx.currentTime;

		if (event === 'BOOT') {
			// Un cran de filtrage de plus que le timbre ESC brut, pour lire comme
			// un logiciel qui démarre plutôt qu'un drone posé devant soi — le
			// « traitement synthétique ou filtré » que la Bible §35 autorise.
			for (const note of BOOT_SIGNATURE) {
				this._voice(ctx, { voice: 'tone', freq: note.freq, durS: note.durS },
					t0 + note.atMs / 1000, LEVEL.boot);
			}
			return;
		}
		if (event === 'TERRAIN_READY') {
			this._voice(ctx, { voice: 'tone', freq: 660, to: 990, durS: 0.16 }, t0, LEVEL.system);
			return;
		}
		if (event === 'TARGET_FOUND') {
			this._voice(ctx, { voice: 'click', freq: 3200, durS: 0.02 }, t0, LEVEL.system);
			this._voice(ctx, { voice: 'tone', freq: 1320, durS: 0.10 }, t0 + 0.05, LEVEL.system);
			return;
		}
		if (event === 'ERROR') {
			// Court et bas. Un accusé de réception, pas une punition : le rituel
			// n'a ni pénalité ni compteur (Bible §14, issue #47).
			this._voice(ctx, { voice: 'tone', freq: 180, durS: 0.09 }, t0, LEVEL.system);
			return;
		}
		if (event === 'LINK_LOST') {
			// Réaliste : la porteuse s'effondre, elle ne joue pas une mélodie.
			this._voice(ctx, { voice: 'glitch', freq: 800, durS: 0.09 }, t0, LEVEL.link);
			this._voice(ctx, { voice: 'pulse', freq: 130, durS: 0.22 }, t0 + 0.06, LEVEL.link);
			return;
		}
		if (event === 'LINK_RESTORED') {
			// Son PROPRE, pas l'inverse du précédent (Bible §35).
			this._voice(ctx, { voice: 'tone', freq: 520, to: 780, durS: 0.13 }, t0, LEVEL.link);
			return;
		}
		if (event === 'RITUAL') {
			// Le rituel réel passe par playRitual() ; ce chemin n'existe que pour
			// que les sept entrées du vocabulaire soient toutes jouables.
			this.playRitual('LINK HIJACK', 2000);
		}
	}

	// Programmée D'UN COUP sur l'horloge de l'AudioContext, jamais sur
	// requestAnimationFrame : une culmination de 1 à 4 s doit rester
	// rythmiquement juste même si une frame saute pendant que la carte finit de
	// se charger.
	playRitual(hackType, variantMs) {
		const ctx = ensureContext();
		if (!ctx) return;
		const t0 = ctx.currentTime;
		for (const ev of scoreFor(hackType, variantMs)) {
			this._voice(ctx, ev, t0 + ev.atMs / 1000, LEVEL.ritual);
		}
	}

	// --- porteuse -----------------------------------------------------------

	// Branche permanente : seuls les AudioParam bougent. Appelée une fois par
	// frame de vol, elle ne doit jamais construire de nœud.
	_ensureCarrier(ctx) {
		if (this._carrier) return this._carrier;
		const src = ctx.createBufferSource();
		src.buffer = this._noiseBuffer(ctx);
		src.loop = true;
		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = CARRIER_HZ;
		bp.Q.value = 1.2;
		const g = ctx.createGain();
		g.gain.value = 0;
		src.connect(bp).connect(g).connect(uiIn());
		src.start();
		this.nodesCreated += 3;
		this._carrier = { src, bp, gain: g };
		return this._carrier;
	}

	// La marge qui fond s'entend avant d'être perdue, comme le fade visuel : le
	// souffle monte quand la qualité descend.
	setLinkQuality(q) {
		const ctx = context();
		if (!ctx) return;
		const c = this._ensureCarrier(ctx);
		const k = Math.min(Math.max(q, 0), 1);
		const t = ctx.currentTime;
		c.gain.gain.setTargetAtTime(LEVEL.carrier * (1 - k), t, CARRIER_TAU);
		c.bp.frequency.setTargetAtTime(CARRIER_HZ * (0.6 + 0.8 * k), t, CARRIER_TAU);
	}

	// Hors vol. Coupe sans démonter : la branche resservira au vol suivant.
	linkSilent() {
		const ctx = context();
		if (!ctx || !this._carrier) return;
		this._carrier.gain.gain.setTargetAtTime(0, ctx.currentTime, CARRIER_TAU);
	}

	// --- boot ---------------------------------------------------------------

	// Au premier chargement d'une page aucun geste n'a eu lieu, et le navigateur
	// refuse de démarrer l'AudioContext. Or le boot FPVTP! est précisément le
	// premier écran : selon le chemin (bootstrap, sélection d'opérateur, ou
	// directement le terminal), il peut s'écouler un temps arbitraire avant le
	// premier clic.
	armBoot() {
		const ctx = ensureContext();
		if (ctx && ctx.state === 'running') { this.play('BOOT'); return; }
		if (this._bootHandler) return;
		this._bootArmedAt = Date.now();
		this._bootHandler = () => {
			this._disarmBoot();
			if ((Date.now() - this._bootArmedAt) / 1000 > BOOT_ARM_WINDOW_S) return;
			const c = ensureContext();
			if (c) this.play('BOOT');
		};
		if (typeof window === 'undefined') return;
		window.addEventListener('pointerdown', this._bootHandler, { once: true });
		window.addEventListener('keydown', this._bootHandler, { once: true });
	}

	_disarmBoot() {
		if (typeof window === 'undefined' || !this._bootHandler) return;
		window.removeEventListener('pointerdown', this._bootHandler);
		window.removeEventListener('keydown', this._bootHandler);
		this._bootHandler = null;
	}
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `cd sim && node tools/ui-audio-render-selftest.mjs`
Expected: PASS — 12 tests OK.

- [ ] **Step 5: Brancher sur `selftest:operator`**

Dans `package.json`, ajouter ` && node tools/ui-audio-render-selftest.mjs` au script `selftest:operator`.

Run: `cd sim && npm run selftest:operator && npm run build`
Expected: PASS des deux.

- [ ] **Step 6: Commit**

```bash
git add sim/src/ui-audio.js sim/tools/ui-audio-render-selftest.mjs sim/package.json
git commit -m "PHASE 18 : rendu des voix SYSTEM / LINK / RITUAL"
```

---

### Task 6: Câblage, et le test qui interdit de biper à chaque clic

**Files:**
- Modify: `src/main.js` (instance partagée, `armBoot`, `TERRAIN_READY`, la porteuse et les deux one-shots dans `frame()`, `ERROR` sur `hud.fail`)
- Modify: `src/ritual.js` (`RITUAL` à `startBurst`, `ERROR` sur `mismatch`)
- Modify: `src/target-scan.js` (`TARGET_FOUND` au CONFIRM)
- Modify: `src/bootstrap.js` (`ERROR` sur échec d'écriture du vecteur)
- Modify: `tools/ui-audio-selftest.mjs` (le balayage de `src/`)

**Interfaces:**
- Consumes: `UiAudio` (Tâche 5), `newLinkState`, `linkEvent`, `UI_EVENTS` (Tâche 1).
- Produces: `src/ui-audio.js` exporte en plus `export const uiAudio = new UiAudio();` — l'instance unique partagée par tous les écrans, sur le modèle de `const audio = new EngineAudio()` dans `main.js`.

- [ ] **Step 1: Écrire le test qui échoue — le vocabulaire est tenu**

Ajouter à `tools/ui-audio-selftest.mjs`, avant le `console.log` final (et `import { readFileSync, readdirSync } from 'node:fs';` — c'est un test, il a le droit de lire le disque ; le modèle, lui, n'importe toujours rien) :

```js
// --- « le système ne bipe pas à chaque clic » -------------------------------

t('aucun appel play() hors du vocabulaire clos dans src/', () => {
	// La forme exécutable de Bible §34. Ajouter un son demande d'ajouter une
	// entrée à UI_EVENTS — ce qui est exactement la friction voulue.
	const dir = new URL('../src/', import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
	const bad = [];
	for (const f of files) {
		const text = readFileSync(new URL(f, dir), 'utf8');
		for (const m of text.matchAll(/uiAudio\.play\(\s*(['"`])([^'"`]*)\1/g)) {
			if (!UI_EVENTS.includes(m[2])) bad.push(`${f} : ${m[2]}`);
		}
	}
	assert.deepEqual(bad, [], `appels hors vocabulaire :\n${bad.join('\n')}`);
});

t('aucun play() dynamique dans src/ : le vocabulaire doit rester vérifiable', () => {
	// uiAudio.play(someVariable) échapperait au test ci-dessus. Interdit : les
	// sept événements sont écrits en toutes lettres sur le site d'appel.
	const dir = new URL('../src/', import.meta.url);
	const bad = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
		const text = readFileSync(new URL(f, dir), 'utf8');
		for (const m of text.matchAll(/uiAudio\.play\(\s*([^'"`\s)])/g)) {
			bad.push(`${f} : play(${m[1]}…)`);
		}
	}
	assert.deepEqual(bad, [], `appels dynamiques :\n${bad.join('\n')}`);
});
```

- [ ] **Step 2: Lancer le test, vérifier qu'il passe déjà (aucun appel n'existe encore)**

Run: `cd sim && node tools/ui-audio-selftest.mjs`
Expected: PASS — le test est vert sur zéro appel. Il devient utile aux steps suivants ; c'est un garde-fou, pas une spécification de comportement.

- [ ] **Step 3: Exporter l'instance partagée**

À la fin de `src/ui-audio.js`, ajouter :

```js
// L'instance unique. Les écrans (ritual.js, target-scan.js, bootstrap.js)
// l'importent directement plutôt que de se la faire passer : ce sont des
// écrans clients, pas des sous-systèmes du moteur, et la faire circuler dans
// six signatures n'achèterait rien.
export const uiAudio = new UiAudio();
```

- [ ] **Step 4: Câbler `src/target-scan.js` — TARGET FOUND**

Ajouter l'import en tête :

```js
import { uiAudio } from './ui-audio.js';
```

Dans `sheetConfirm`, jouer le son **au CONFIRM** et pas à la navigation dans la liste — le curseur qui descend n'est pas un événement :

```js
			sheetConfirm = () => {
				if (done) return;
				done = true;
				uiAudio.play('TARGET_FOUND');
				s2.remove();
				finish(index);
			};
```

- [ ] **Step 5: Câbler `src/ritual.js` — RITUAL et ERROR**

Ajouter l'import en tête :

```js
import { uiAudio } from './ui-audio.js';
```

Dans `onInput`, sur `mismatch`, juste après `typed = [];` :

```js
				uiAudio.play('ERROR');
```

Dans `startBurst`, avant `raf = requestAnimationFrame(loop);` :

```js
			// Programmée d'un coup sur l'horloge audio : le rythme ne doit pas
			// dépendre des frames, que le chargement de la carte peut faire sauter.
			uiAudio.playRitual(hackType, variant.ms);
```

Ne **rien** ajouter dans `finishBurst` : les 400 ms de `CONTROL ACQUIRED` sont le silence de `silence → moteur → vol`.

- [ ] **Step 6: Câbler `src/bootstrap.js` — ERROR**

Ajouter l'import en tête :

```js
import { uiAudio } from './ui-audio.js';
```

Dans `flushOrRetry`, dans le `catch`, avant la création de l'écran :

```js
		catch {
			uiAudio.play('ERROR');
```

- [ ] **Step 7: Câbler `src/main.js` — boot, terrain, porteuse, lien**

1. Ajouter aux imports :

```js
import { uiAudio } from './ui-audio.js';
import { newLinkState, linkEvent } from '../tools/ui-audio-model.mjs';
```

2. À côté de `const audio = new EngineAudio();` (ligne ~119), ajouter :

```js
// L'état de l'hystérésis d'annonce du lien, conservé entre deux frames.
const linkVoice = newLinkState();
```

3. Juste avant l'appel `chooseScene()` (ligne ~1330, avant le bloc `if (OPTS.scene)`), armer la signature :

```js
// Le boot FPVTP!, une fois par chargement. Au premier chargement aucun geste
// n'a encore eu lieu : armBoot() attend le premier, et renonce au-delà de sa
// fenêtre plutôt que de jouer une signature de démarrage hors contexte.
uiAudio.armBoot();
```

4. À la fin de `finishBoot()`, après `renderer.setAnimationLoop(frame);` :

```js
	uiAudio.play('TERRAIN_READY');
```

5. Dans `frame()`, juste après le bloc `if (peakImpact > 0) audio.playImpact(peakImpact);` :

```js
	// La liaison, en vol seulement : une porteuse continue dont le souffle suit
	// la marge, et deux annonces sur franchissement de seuil. C'est le seul son
	// d'interface qui vit pendant le vol.
	if (flightEnd.phase === FLYING || flightEnd.phase === LANDING_READY) {
		uiAudio.setLinkQuality(link.out.quality);
		const ev = linkEvent(link.out.quality, dt, linkVoice);
		if (ev === 'LINK_LOST') uiAudio.play('LINK_LOST');
		else if (ev === 'LINK_RESTORED') uiAudio.play('LINK_RESTORED');
	} else {
		uiAudio.linkSilent();
	}
```

Vérifier que `FLYING` et `LANDING_READY` sont bien déjà importés depuis `./flight-end.js` en tête de `main.js` (ils le sont, `main.js` les utilise déjà dans le gestionnaire de clic du canvas). Sinon, les ajouter à l'import existant.

6. Dans le `.catch()` de la chaîne `chooseScene()`, avant `hud.fail(err.message)` :

```js
		uiAudio.play('ERROR');
```

- [ ] **Step 8: Lancer toute la batterie**

Run: `cd sim && npm run selftest:operator`
Expected: PASS — dont les deux tests de vocabulaire, qui voient maintenant de vrais appels et les valident.

Run: `cd sim && npm run build`
Expected: PASS — aucun import circulaire ni manquant.

Run: `cd sim && npm run selftest`
Expected: PASS — le banc physique est vert. Rien de cette phase n'est entré dans `quad.js`, `physics.js` ni `flightController.js`.

- [ ] **Step 9: Commit**

```bash
git add sim/src/ui-audio.js sim/src/main.js sim/src/ritual.js sim/src/target-scan.js sim/src/bootstrap.js sim/tools/ui-audio-selftest.mjs
git commit -m "PHASE 18 : câblage des sept événements, et le test qui tient le vocabulaire"
```

---

### Task 7: Vérification navigateur et équilibrage du mixage

Les six tâches précédentes prouvent que le graphe est branché et que les partitions tombent juste. Elles ne prouvent **rien** sur le timbre ni sur l'équilibre : c'est une question d'oreille, et c'est le critère d'acceptation de l'issue.

**Files:**
- Modify: `src/ui-audio.js` (les constantes `LEVEL`, après écoute)
- Modify: `src/audio-bus.js` (`UI_TRIM`, après écoute)
- Modify: `HANDOFF.md`

- [ ] **Step 1: Lancer le jeu**

Run: `cd sim && npm run dev`

Ouvrir le navigateur sur l'URL servie. **Ne pas** utiliser `?scene=` : c'est le chemin dev, qui saute le boot et le rituel.

- [ ] **Step 2: Vérifier chaque événement, dans l'ordre du jeu**

Cocher un par un, à l'oreille :

- [ ] La signature de boot part au premier clic, et **une seule fois** par chargement. Le motif s'entend comme `tututuuut tuuuuu-tuu`.
- [ ] Naviguer dans le terminal, ouvrir les réglages, bouger les curseurs : **aucun son**. C'est le critère « le système ne bipe pas à chaque clic », vérifié comme le joueur le vérifierait.
- [ ] `TARGET SCAN` : monter et descendre dans la liste ne fait aucun bruit ; seul le CONFIRM sonne.
- [ ] `AUTOMATED ANALYSIS` : le log défile en silence ; `TERRAIN READY` sonne quand la carte a fini de charger.
- [ ] Rituel : taper un mauvais vecteur donne un `ERROR` court et bas, sans dramatisation.
- [ ] Rituel : la culmination sonne, et **le moteur est muet pendant** (`audio.setMuted(frozen)` doit encore marcher).
- [ ] `CONTROL ACQUIRED` : 400 ms de **silence**, puis le moteur monte. C'est le `silence → moteur → vol`.
- [ ] En vol : la porteuse est présente mais sous les moteurs ; s'éloigner ou passer derrière un immeuble la fait monter avant que l'image ne se dégrade.
- [ ] Perdre le lien franchement : `LINK LOST`. Revenir : `LINK RESTORED`, un son **différent**, pas l'inverse du précédent.
- [ ] Crasher : impact, effondrement de porteuse, `LINK LOST` — et **aucune reprise du motif de boot**.

- [ ] **Step 3: Rejouer les six familles de hack**

Le chemin `?hack=<type>&scene=<slug>` rejoue un hack précis (voir `normalizeHackType` et `OPTS.hack` dans `main.js`). Écouter les six et vérifier qu'elles se distinguent à l'oreille :

```text
?hack=command-injection   ?hack=link-hijack       ?hack=telemetry-spoof
?hack=gnss-spoof          ?hack=network-takeover  ?hack=firmware-override
```

- [ ] Les six sont reconnaissables les unes des autres.
- [ ] Chacune finit par une montée puis un impact.
- [ ] Une variante longue (V4) respire ; elle ne sonne pas comme une V1 clairsemée.

- [ ] **Step 4: Équilibrer**

Ajuster `UI_TRIM` dans `src/audio-bus.js` et les cinq niveaux de `LEVEL` dans `src/ui-audio.js` jusqu'à ce que l'ensemble tienne à volume d'écoute normal, moteurs compris. Les valeurs livrées par les tâches précédentes sont un point de départ, pas une mesure — c'est le seul endroit de cette phase où le jugement remplace un test, et l'issue #11 l'assume.

Vérifier dans la console que le limiteur n'écrase pas le rituel : `window.__sim.debug()` donne l'état du sim, et un rituel qui fait « pomper » les moteurs veut dire que `LEVEL.ritual` est trop haut.

- [ ] **Step 5: Confirmer qu'aucun nœud ne fuit**

Dans la console, après une session complète (boot, scan, hack, rituel, vol, crash) :

```js
window.__sim.audio.nodesCreated
```

Puis relancer un vol et vérifier que le compteur ne croît pas **par frame**. Un carrier correct crée trois nœuds une fois pour toutes.

- [ ] **Step 6: Mettre `HANDOFF.md` à jour**

Ajouter une section décrivant l'état vérifié : ce qui a été entendu, à quelles valeurs de `LEVEL` / `UI_TRIM` l'équilibre a été jugé bon, et ce qui reste non vérifié. Suivre le ton du fichier : **vérifié** et **non vérifié** séparés, aucune affirmation sans écoute derrière.

- [ ] **Step 7: Commit**

```bash
git add sim/src/ui-audio.js sim/src/audio-bus.js sim/HANDOFF.md
git commit -m "PHASE 18 : mixage équilibré à l'oreille, état vérifié au HANDOFF"
```

---

## Vérification finale

- [ ] `cd sim && npm run selftest:operator` — vert, les quatre nouveaux selftests inclus.
- [ ] `cd sim && npm run selftest` — le banc physique est vert et inchangé.
- [ ] `cd sim && npm run build` — vert.
- [ ] Les dix cases d'écoute de la Tâche 7 Step 2 sont cochées.
- [ ] `git log --oneline` montre sept commits, un par tâche.
- [ ] Ouvrir la PR contre `main`, fermer l'issue #55, passer l'item du Projet 2 en `Done`.
