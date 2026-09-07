# PHASE 09 — Système de hacking documentaire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire du type de hack une propriété de la cible (six familles) et
intercaler un écran `AUTOMATED ANALYSIS` entre le choix de cible et le vol, qui
se fige sur `MANUAL OVERRIDE REQUIRED` puis un bouton `[ JACK IN ]` provisoire.

**Architecture:** Le tirage du `hackType` est ajouté à la logique pure
`tools/target-model.mjs` (RNG seedé, indépendant de la famille et du RSSI) et
persisté via `resolveTarget` / `sanitizeTarget`. Un nouvel écran client
`src/hack.js` (look terminal, zéro dépendance moteur) joue le log automatique et
un motif visuel par famille de hack, puis résout sur `[ JACK IN ]`. `main.js`
l'appelle dans `chooseScene()` après `runTargetScan`. Les helpers testables
(`normalizeHackType`, lignes de log) vivent dans `tools/hack-model.mjs`.

**Tech Stack:** JS ESM natif, Vite (bundle client), Three.js/Rapier (moteur —
NON touché), `node:assert/strict` pour les selftests (logique pure, pas de DOM).

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-09-hacking-documentaire-design.md`

## Global Constraints

- Interface, logs et textes du jeu : **anglais**. Issues, commits, docs
  internes : **français**.
- Aucun élément de DA ne devient une dépendance du moteur physique.
  `src/hack.js` ne doit **jamais** importer `three`, `physics.js`, `quad.js`,
  `flightController.js`. `npm run selftest` reste vert à chaque tâche.
- Les selftests de ce repo sont de la **logique pure, aucune E/S, aucun DOM**
  (`tools/*-selftest.mjs`, pattern `node:assert/strict`). Les écrans DOM
  (`target-scan.js`, `hack.js`) ne sont pas testés unitairement — seuls leurs
  helpers purs le sont.
- Sécurité — non négociable : aucune trame, aucun outil, aucune séquence
  d'intrusion réutilisable. Le log automatique = deux lignes fixes. Les motifs
  = animations décoratives. Voir Task 6 (revue).
- Les six `HACK_TYPES`, ordre Bible §17 (verbatim, avec espaces, majuscules) :
  `COMMAND INJECTION`, `LINK HIJACK`, `TELEMETRY SPOOF`, `GNSS SPOOF`,
  `NETWORK TAKEOVER`, `FIRMWARE OVERRIDE`.
- Lignes du log automatique, verbatim Bible §18 :
  `AUTOMATED BYPASS ........ OK` / `CONTROL CHANNEL ......... READY` /
  (ligne vide) / `MANUAL OVERRIDE REQUIRED`.
- Runner selftests opérateur : `npm run selftest:operator` (enchaîne
  `target-selftest.mjs`, `session-selftest.mjs`, etc.). Runner moteur :
  `npm run selftest`.

## File Structure

| Fichier | Responsabilité | Action |
|---|---|---|
| `tools/target-model.mjs` | logique pure du scan de cible ; devient propriétaire de `HACK_TYPES` et du tirage `_hackType` | Modifier |
| `tools/hack-model.mjs` | helpers purs de l'écran de hack : `normalizeHackType`, `HACK_LOG_LINES` | Créer |
| `tools/session-model.mjs` | validation/figeage du descripteur de cible persisté ; passthrough `hackType` | Modifier |
| `tools/target-selftest.mjs` | tests du modèle de scan ; ajouts hackType | Modifier |
| `tools/hack-selftest.mjs` | tests des helpers purs de hack-model | Créer |
| `tools/session-selftest.mjs` | tests du modèle de session ; ajouts hackType | Modifier |
| `src/hack.js` | écran client `AUTOMATED ANALYSIS` : log temporisé + `[ JACK IN ]` + boucle d'animation | Créer |
| `src/hack-grammars.js` | les six motifs visuels `draw*(el,{t,seed})` + map `GRAMMARS` + `drawNeutral` | Créer |
| `src/style.css` | styles `.hack-*` | Modifier |
| `src/main.js` | câblage `runHack` dans `chooseScene`, hook debug `?hack=` | Modifier |
| `package.json` | ajouter `hack-selftest.mjs` au runner `selftest:operator` | Modifier |
| `sim/HANDOFF.md`, `sim/README.md` | état vérifié/non vérifié, section hacking | Modifier |

---

## Task 1 : `HACK_TYPES` + tirage `_hackType` + `resolveTarget`

**Files:**
- Modify: `tools/target-model.mjs`
- Test: `tools/target-selftest.mjs`

**Interfaces:**
- Consumes: rien (première tâche).
- Produces :
  - `export const HACK_TYPES: string[]` (6 entrées, ordre Bible §17).
  - `generateTargetScan({seed,count})` — chaque `candidate` porte désormais
    `_hackType: string` (∈ `HACK_TYPES`), en plus des champs existants
    (`id`, `rssiDbm`, `mode`, `_family`, `_classHint`, `_videoHint`).
  - `resolveTarget(scan, index)` — l'objet retourné porte désormais
    `hackType: string` (∈ `HACK_TYPES`), en plus de
    `{family, classHint, signal:{rssiDbm,mode}, scannedAt, intel}`.
  - `describeTarget(candidate)` — **inchangé**, ne doit jamais exposer
    `_hackType`.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `tools/target-selftest.mjs`, ajouter `HACK_TYPES` à l'import depuis
`./target-model.mjs`, puis ajouter ce bloc avant la ligne
`console.log(`\n${pass} tests target OK...`)` :

```js
// --- hackType : propriété de cible (PHASE 09)
{
	check('HACK_TYPES : 6 familles, ordre Bible §17',
		HACK_TYPES.join('|') === 'COMMAND INJECTION|LINK HIJACK|TELEMETRY SPOOF|GNSS SPOOF|NETWORK TAKEOVER|FIRMWARE OVERRIDE');

	const a = generateTargetScan({ seed: 'hack-det', count: 5 });
	const b = generateTargetScan({ seed: 'hack-det', count: 5 });
	check('_hackType déterministe par graine',
		a.candidates.map((c) => c._hackType).join(',') === b.candidates.map((c) => c._hackType).join(','));
	check('_hackType toujours dans HACK_TYPES',
		a.candidates.every((c) => HACK_TYPES.includes(c._hackType)));

	// describeTarget ne fuite jamais le hackType
	for (const cand of a.candidates) {
		check(`describeTarget(${cand.id}) sans _hackType`,
			!JSON.stringify(describeTarget(cand)).includes(cand._hackType));
	}

	// resolveTarget porte le hackType du candidat choisi
	const t = resolveTarget(a, 2);
	check('resolveTarget : hackType repris du candidat',
		t.hackType === a.candidates[2]._hackType && HACK_TYPES.includes(t.hackType));

	// indépendance famille × hackType : sur 250 graines, chaque hackType
	// apparaît avec au moins 4 familles distinctes (pas de couplage fort)
	const pairs = new Map(HACK_TYPES.map((h) => [h, new Set()]));
	// distribution : chaque hackType entre 8 % et 25 % des tirages
	const counts = new Map(HACK_TYPES.map((h) => [h, 0]));
	let total = 0;
	for (let i = 0; i < 250; i++) {
		for (const c of generateTargetScan({ seed: `dist-${i}`, count: 5 }).candidates) {
			pairs.get(c._hackType).add(c._family);
			counts.set(c._hackType, counts.get(c._hackType) + 1);
			total++;
		}
	}
	check('hackType × famille : pas de couplage fort',
		[...pairs.values()].every((set) => set.size >= 4),
		[...pairs.entries()].map(([h, s]) => `${h}:${s.size}`).join(' '));
	check('hackType : distribution ~uniforme (8–25 %)',
		[...counts.values()].every((n) => n / total >= 0.08 && n / total <= 0.25),
		[...counts.values()].map((n) => (100 * n / total).toFixed(0)).join(' '));
}
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `node tools/target-selftest.mjs`
Expected: FAIL — `HACK_TYPES` est `undefined` (import échoue → `ReferenceError`
ou `check` faux), les candidats n'ont pas `_hackType`.

- [ ] **Step 3 : Implémenter dans `tools/target-model.mjs`**

Après le bloc `export const TARGET_FAMILIES = ...` (juste sous `FAMILY_CLASS`),
ajouter :

```js
// HACK_TYPES : les six familles de hacking (PHASE 09, Bible §17). Ordre stable.
// Le type de hack est une propriété de la cible, tirée à la génération ; il ne
// détermine PAS la difficulté du vol (entry state indépendant, PHASE 11).
// Concepts documentés et crédibles ; l'interaction est une abstraction (spec
// PHASE 09, règle de sécurité).
export const HACK_TYPES = [
	'COMMAND INJECTION',
	'LINK HIJACK',
	'TELEMETRY SPOOF',
	'GNSS SPOOF',
	'NETWORK TAKEOVER',
	'FIRMWARE OVERRIDE',
];
```

Dans `generateTargetScan`, boucle `for (let i = 0; i < n; i++)`, après la ligne
`const mode = rand() < 0.5 ? videoHint : 'UNKNOWN';` ajouter :

```js
		// Tirage dédié, après `mode`, pour ne pas décaler les tirages RSSI/mode
		// d'une graine déjà utilisée. Indépendant de la famille et du signal.
		const hackType = pick(rand, HACK_TYPES);
```

et dans le `raw.push({ ... })` de cette boucle, ajouter `_hackType: hackType,` :

```js
		raw.push({ rssiDbm, mode, _family: family, _classHint: FAMILY_CLASS[family], _videoHint: videoHint, _hackType: hackType });
```

Dans `resolveTarget`, ajouter `hackType: c._hackType,` à l'objet retourné (au
même niveau que `family:` / `classHint:`).

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `node tools/target-selftest.mjs`
Expected: PASS — tous les checks, y compris le garde-fou existant
`FAMILY_CLASS couvre exactement FAMILIES` (non impacté).

- [ ] **Step 5 : Vérifier la non-régression du modèle de scan**

Run: `npm run selftest:operator`
Expected: PASS. Note : les tests de déterminisme PHASE 08 comparent des JSON
complets sur des graines de référence — ils restent verts car ils re-génèrent
la sortie à chaque exécution (pas de fixture figée sur disque). Si un test
compare à une chaîne JSON littérale codée en dur, l'ajuster pour inclure
`_hackType` (chercher `_family` dans `target-selftest.mjs` pour repérer un tel
littéral ; il n'y en a pas au moment de l'écriture du plan).

- [ ] **Step 6 : Commit**

```bash
git add tools/target-model.mjs tools/target-selftest.mjs
git commit -m "PHASE 09 — hackType : propriété de cible tirée à la génération

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2 : `sanitizeTarget` — passthrough + validation du `hackType`

**Files:**
- Modify: `tools/session-model.mjs`
- Test: `tools/session-selftest.mjs`

**Interfaces:**
- Consumes: `HACK_TYPES` depuis `./target-model.mjs` (Task 1).
- Produces: `sanitizeTarget(raw)` — l'objet nettoyé porte `hackType` :
  - `raw.hackType ∈ HACK_TYPES` → conservé tel quel.
  - `raw.hackType` absent / `null` / `undefined` → `hackType: null` (toléré :
    sessions antérieures, chemin dev `?scene=`).
  - `raw.hackType` présent mais hors `HACK_TYPES` → throw
    `Error('hackType de cible inconnu : <valeur>')`.
  - Champ placé à côté de `family` / `classHint` dans l'objet retourné.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `tools/session-selftest.mjs` : l'import ligne 11 devient
`import { TARGET_FAMILIES, HACK_TYPES } from './target-model.mjs';`.

Ajouter `hackType: HACK_TYPES[0],` à la constante `GOOD_TARGET` (après
`classHint`).

Dans le test `'openSession : porte une cible validée, conservée au resume, null si absente'`,
après `assert.equal(s.target.family, GOOD_TARGET.family);` ajouter :

```js
	assert.equal(s.target.hackType, HACK_TYPES[0]);
```

et après `assert.equal(noTarget.target, null);` — rien à ajouter (déjà couvert).

Ajouter un nouveau test après le test `'sanitizeTarget : rejette famille inconnue...'` :

```js
t('sanitizeTarget : hackType — valide conservé, inconnu rejeté, absent toléré', () => {
	const base = { family: TARGET_FAMILIES[0], signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} };

	const withHack = openSession({
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'GNSS SPOOF' },
	});
	assert.equal(withHack.target.hackType, 'GNSS SPOOF');

	const noHack = openSession({
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base },
	});
	assert.equal(noHack.target.hackType, null);

	assert.throws(() => openSession({
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'NOPE' },
	}), /hackType de cible inconnu/);
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `node tools/session-selftest.mjs`
Expected: FAIL — `s.target.hackType` est `undefined`, pas de throw sur `'NOPE'`.

- [ ] **Step 3 : Implémenter dans `tools/session-model.mjs`**

Import ligne 14 :
`import { TARGET_FAMILIES, HACK_TYPES } from './target-model.mjs';`

Dans `sanitizeTarget(raw)`, après le bloc qui valide `raw.family` et avant la
validation de `raw.signal`, ajouter :

```js
	if (raw.hackType != null && !HACK_TYPES.includes(raw.hackType)) {
		throw new Error(`hackType de cible inconnu : ${raw.hackType}`);
	}
```

Dans l'objet retourné par `sanitizeTarget`, ajouter après `classHint:` :

```js
		hackType: raw.hackType ?? null,
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `node tools/session-selftest.mjs`
Expected: PASS.

- [ ] **Step 5 : Suite complète**

Run: `npm run selftest:operator && npm run selftest`
Expected: PASS partout.

- [ ] **Step 6 : Commit**

```bash
git add tools/session-model.mjs tools/session-selftest.mjs
git commit -m "PHASE 09 — session : le hackType de cible est validé et persisté

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3 : `tools/hack-model.mjs` — helpers purs

**Files:**
- Create: `tools/hack-model.mjs`
- Create: `tools/hack-selftest.mjs`
- Modify: `package.json` (runner)

**Interfaces:**
- Consumes: `HACK_TYPES` depuis `./target-model.mjs` (Task 1).
- Produces :
  - `export const HACK_LOG_LINES: string[]` =
    `['AUTOMATED BYPASS ........ OK', 'CONTROL CHANNEL ......... READY', '', 'MANUAL OVERRIDE REQUIRED']`.
  - `export function normalizeHackType(input: string): string | null` —
    accepte `'gnss-spoof'`, `'GNSS_SPOOF'`, `'gnss spoof'`, `'GNSS SPOOF'` →
    `'GNSS SPOOF'` ; tout ce qui ne correspond à aucun `HACK_TYPES` → `null`.
  - `export { HACK_TYPES } from './target-model.mjs';` (ré-export pour que le
    client n'importe qu'un module).

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `tools/hack-selftest.mjs` :

```js
// Selftest des helpers purs de l'écran de hack (PHASE 09). Aucune E/S, aucun DOM.
// Lancer : node tools/hack-selftest.mjs
import assert from 'node:assert/strict';
import { HACK_TYPES, HACK_LOG_LINES, normalizeHackType } from './hack-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('HACK_LOG_LINES : verbatim Bible §18', () => {
	assert.deepEqual(HACK_LOG_LINES, [
		'AUTOMATED BYPASS ........ OK',
		'CONTROL CHANNEL ......... READY',
		'',
		'MANUAL OVERRIDE REQUIRED',
	]);
});

t('normalizeHackType : tolère tirets, underscores, casse, espaces', () => {
	assert.equal(normalizeHackType('GNSS SPOOF'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('gnss-spoof'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('gnss_spoof'), 'GNSS SPOOF');
	assert.equal(normalizeHackType('  Gnss   Spoof '), 'GNSS SPOOF');
	assert.equal(normalizeHackType('command-injection'), 'COMMAND INJECTION');
	assert.equal(normalizeHackType('firmware-override'), 'FIRMWARE OVERRIDE');
});

t('normalizeHackType : inconnu → null', () => {
	assert.equal(normalizeHackType('nope'), null);
	assert.equal(normalizeHackType(''), null);
	assert.equal(normalizeHackType(undefined), null);
	assert.equal(normalizeHackType('gnss'), null);
});

t('chaque HACK_TYPES a une forme slug qui round-trip', () => {
	for (const h of HACK_TYPES) {
		assert.equal(normalizeHackType(h.toLowerCase().replace(/ /g, '-')), h);
	}
});

console.log(`\n${n} tests hack OK`);
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `node tools/hack-selftest.mjs`
Expected: FAIL — `Cannot find module './hack-model.mjs'`.

- [ ] **Step 3 : Créer `tools/hack-model.mjs`**

```js
// Helpers purs de l'écran de hack (PHASE 09). Logique pure, AUCUNE dépendance
// DOM/Three — importée par le selftest et, via un bundle Vite, par src/hack.js.
// Le rendu et les motifs animés vivent dans src/hack.js ; ici, uniquement ce
// qui se teste sans navigateur.
import { HACK_TYPES } from './target-model.mjs';

export { HACK_TYPES };

// Log automatique de la phase d'analyse, verbatim Bible §18. Deux lignes fixes,
// une ligne vide, la sommation. AUCUNE commande, aucun paramètre : c'est une
// mise en scène, pas une procédure (spec PHASE 09, règle de sécurité).
export const HACK_LOG_LINES = [
	'AUTOMATED BYPASS ........ OK',
	'CONTROL CHANNEL ......... READY',
	'',
	'MANUAL OVERRIDE REQUIRED',
];

// 'gnss-spoof' | 'GNSS_SPOOF' | 'gnss spoof' -> 'GNSS SPOOF' ; sinon null.
// Utilisé par le hook debug ?hack= de main.js.
export function normalizeHackType(input) {
	if (typeof input !== 'string') return null;
	const norm = input.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
	return HACK_TYPES.includes(norm) ? norm : null;
}
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `node tools/hack-selftest.mjs`
Expected: PASS — `4 tests hack OK`.

- [ ] **Step 5 : Brancher au runner**

Dans `package.json`, script `selftest:operator`, ajouter
`&& node tools/hack-selftest.mjs` juste après `node tools/target-selftest.mjs`.

Run: `npm run selftest:operator`
Expected: PASS, `hack-selftest` inclus.

- [ ] **Step 6 : Commit**

```bash
git add tools/hack-model.mjs tools/hack-selftest.mjs package.json
git commit -m "PHASE 09 — hack-model : helpers purs (log, normalizeHackType)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4 : `src/hack.js` — écran AUTOMATED ANALYSIS (log + JACK IN, motif placeholder)

**Files:**
- Create: `src/hack.js`
- Modify: `src/style.css`

**Interfaces:**
- Consumes:
  - `screen`, `button` depuis `./terminal.js` (exports existants :
    `screen(root, cls?) -> { el, box, remove }`, `button(label, onClick, cls?)`
    — `cls === 'terminal-cta'` rend `[ LABEL ]`).
  - `HACK_TYPES`, `HACK_LOG_LINES` depuis `../tools/hack-model.mjs` (Task 3).
- Produces:
  - `export function runHack(root, { hackType, family }): Promise<void>` —
    monte l'écran, joue le log ligne à ligne (~150 ms/ligne), démarre la boucle
    d'animation du motif, ajoute `[ JACK IN ]`. Résout quand le joueur clique
    `[ JACK IN ]` ou presse Entrée. Avant de résoudre : `cancelAnimationFrame`,
    `removeEventListener('keydown', …)`, `screen.remove()`.
  - `hackType` doit être `∈ HACK_TYPES` ; si inconnu, l'écran affiche quand même
    l'en-tête tel quel et un motif neutre (ne throw pas — robustesse du hook debug).

**Interdits** (Global Constraints) : aucun `import` de `three`, `./physics.js`,
`./quad.js`, `./flightController.js`, `./main.js`.

- [ ] **Step 1 : Créer `src/hack.js` (log + JACK IN, un seul motif neutre)**

```js
// AUTOMATED ANALYSIS (PHASE 09, Bible §16–18). S'intercale entre le TARGET SCAN
// (PHASE 08) et le vol. Joue un log automatique fixe, un motif visuel propre à
// la famille de hack, puis se fige sur MANUAL OVERRIDE REQUIRED + un bouton
// [ JACK IN ] PROVISOIRE (le rituel réel — CONTROL VECTOR + QTE — est PHASE 10).
//
// Écran client pur : look terminal (screen/button de terminal.js), AUCUNE
// dépendance Three/Rapier/physics. Jamais importé par le moteur.
//
// Règle de sécurité (spec PHASE 09) : le log est deux lignes fixes, les motifs
// sont des animations décoratives. Aucune trame, aucun outil, aucune séquence
// exploitable.
import { screen, button } from './terminal.js';
import { HACK_TYPES, HACK_LOG_LINES } from '../tools/hack-model.mjs';
import { GRAMMARS, drawNeutral } from './hack-grammars.js';

const LINE_MS = 150;

// Petit hash déterministe famille -> graine cosmétique (varie le bruit d'un vol
// à l'autre, ne révèle jamais la famille au joueur).
function cosmeticSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < String(str).length; i++) {
		h ^= String(str).charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

export function runHack(root, { hackType, family } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : (hackType || 'UNKNOWN');
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);

	const s = screen(root, 'hack');
	s.box.innerHTML = `<pre class="hack-head">HACK // ${type}</pre>
<pre class="hack-log"></pre>
<pre class="hack-grammar" aria-hidden="true"></pre>`;
	const logEl = s.box.querySelector('.hack-log');
	const gramEl = s.box.querySelector('.hack-grammar');

	return new Promise((resolve) => {
		let raf = 0;
		let done = false;
		const t0 = performance.now();

		// Log ligne à ligne.
		let shown = 0;
		const tick = () => {
			if (done) return;
			shown++;
			logEl.textContent = HACK_LOG_LINES.slice(0, shown).join('\n');
			if (shown >= HACK_LOG_LINES.length) {
				logEl.classList.add('hack-log-armed'); // met MANUAL OVERRIDE en valeur (CSS)
				return;
			}
			setTimeout(tick, LINE_MS);
		};
		setTimeout(tick, LINE_MS);

		// Boucle d'animation unique du motif.
		const loop = (now) => {
			if (done) return;
			draw(gramEl, { t: (now - t0) / 1000, seed });
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);

		const finish = () => {
			if (done) return;
			done = true;
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve();
		};
		const onKey = (e) => {
			if (e.key === 'Enter') { e.preventDefault(); finish(); }
		};
		window.addEventListener('keydown', onKey);

		s.box.appendChild(button('JACK IN', finish, 'terminal-cta'));
	});
}
```

Créer aussi `src/hack-grammars.js` avec un seul motif neutre pour l'instant
(les 6 motifs sont Task 5) :

```js
// Motifs visuels par famille de hacking (PHASE 09, Bible §17). Chaque motif
// identifie sa famille SANS que le joueur ait à lire son nom (critère
// d'acceptation). Purement décoratif : la seule donnée qui entre est un `seed`
// cosmétique et un temps `t` en secondes.
//
// Contrat d'un motif : draw(el: HTMLPreElement, { t: number, seed: number }).
// Écrit dans el.textContent. Pas d'état module — tout dérive de (t, seed).

const W = 44; // largeur du champ ASCII
const H = 12; // hauteur

const frame = (rows) => rows.map((r) => r.padEnd(W).slice(0, W)).join('\n');

export function drawNeutral(el, { t }) {
	const rows = [];
	for (let y = 0; y < H; y++) {
		let row = '';
		for (let x = 0; x < W; x++) {
			row += ((x + y + Math.floor(t * 8)) % 7 === 0) ? '·' : ' ';
		}
		rows.push(row);
	}
	el.textContent = frame(rows);
}

// Rempli en Task 5. Toute clé absente retombe sur drawNeutral (voir hack.js).
export const GRAMMARS = {};
```

- [ ] **Step 2 : Styles `.hack-*` dans `src/style.css`**

Repérer un bloc d'écran terminal existant (`.terminal-box pre`, etc.) pour
rester cohérent, puis ajouter :

```css
.hack .hack-head { font-weight: 700; letter-spacing: 0.08em; margin-bottom: 0.6em; }
.hack .hack-log { min-height: 5em; white-space: pre; line-height: 1.5; }
.hack .hack-log.hack-log-armed { /* MANUAL OVERRIDE REQUIRED est la dernière ligne */ }
.hack .hack-log-armed::after {
	content: '';
}
.hack .hack-grammar {
	margin-top: 0.8em;
	line-height: 1.05;
	opacity: 0.85;
	white-space: pre;
	font-size: 0.9em;
}
```

Note : pas de glow / néon (DA §46). Pour mettre `MANUAL OVERRIDE REQUIRED` en
valeur sans le colorer, on peut simplement compter sur le fait qu'elle est la
dernière ligne du `<pre>` ; si une emphase typographique est voulue,
restructurer en Task 5 pour sortir cette ligne dans son propre nœud. Laisser
la classe `hack-log-armed` en place comme point d'accroche.

- [ ] **Step 3 : Vérif de non-régression (pas de test unitaire pour le DOM)**

Run: `npm run selftest && npm run selftest:operator`
Expected: PASS — `hack.js` / `hack-grammars.js` ne sont importés par personne
encore, aucun impact.

- [ ] **Step 4 : Vérif build (le bundle Vite doit résoudre le nouveau module)**

Run: `npm run build`
Expected: succès, pas d'erreur de résolution d'import.

- [ ] **Step 5 : Commit**

```bash
git add src/hack.js src/hack-grammars.js src/style.css
git commit -m "PHASE 09 — écran AUTOMATED ANALYSIS : log + [ JACK IN ] provisoire

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5 : Les six motifs visuels

**Files:**
- Modify: `src/hack-grammars.js`
- Modify: `src/style.css` (au besoin)

**Interfaces:**
- Consumes: le contrat `draw(el, { t, seed })` défini en Task 4.
- Produces: `GRAMMARS` peuplé pour les 6 clés de `HACK_TYPES` :
  `'COMMAND INJECTION'`, `'LINK HIJACK'`, `'TELEMETRY SPOOF'`, `'GNSS SPOOF'`,
  `'NETWORK TAKEOVER'`, `'FIRMWARE OVERRIDE'`.

Ce sont des dessins ASCII animés, ~20-30 lignes chacun, sans état module (tout
dérive de `t` et `seed`). Pas de TDD ici — le livrable est visuel, validé à
l'œil (Step final). Grammaire cible (Bible §17) :

| Clé | Motif |
|---|---|
| `COMMAND INJECTION` | lignes de « paquets » (blocs `[####]`) qui défilent de droite à gauche, par bursts ; interstices variables |
| `LINK HIJACK` | une porteuse sinusoïdale ASCII + un marqueur vertical `|` qui glisse puis se cale sur une crête (« sync ») |
| `TELEMETRY SPOOF` | trace d'oscilloscope : une courbe qui balaie l'écran, avec une portion « injectée » d'amplitude différente |
| `GNSS SPOOF` | un réticule `+` qui dérive lentement d'une position d'origine, laissant une traînée de points ; quelques flèches de vecteur |
| `NETWORK TAKEOVER` | 4-6 nœuds `(o)` reliés par des arêtes `-`/`/`/`\` ; un « front » d'illumination (`(o)` → `(●)`) se propage de nœud en nœud |
| `FIRMWARE OVERRIDE` | colonne d'offsets hexa (`0x0000:` …) avec des octets ; une ligne qui « bascule » (octets remplacés par `··`) balaie de haut en bas |

- [ ] **Step 1 : Implémenter les 6 fonctions**

Dans `src/hack-grammars.js`, écrire les 6 `draw*` puis :

```js
export const GRAMMARS = {
	'COMMAND INJECTION': drawPackets,
	'LINK HIJACK': drawCarrier,
	'TELEMETRY SPOOF': drawScope,
	'GNSS SPOOF': drawVectors,
	'NETWORK TAKEOVER': drawNodes,
	'FIRMWARE OVERRIDE': drawMemory,
};
```

Contraintes de style :
- Réutiliser `W`, `H`, `frame()`.
- Aucune fonction ne doit dépasser ~35 lignes ; si c'est le cas, extraire un
  helper local.
- Déterminisme : `draw(el, {t: 1.0, seed: 0.3})` doit toujours produire la même
  frame. Pas de `Math.random()` — utiliser une fonction de bruit de `(x, y, t,
  seed)` locale (p. ex. `Math.sin` combinés) ou un petit PRNG re-seedé à chaque
  frame depuis `seed`.
- Le nom de la famille de hack n'apparaît **jamais** dans le dessin.

- [ ] **Step 2 : Ajouter un hook de prévisualisation temporaire**

Pour valider à l'œil sans lancer tout le flux, vérifier que Task 6 câble bien
`?hack=<type>`. En attendant, on peut charger `src/hack.js` depuis la console :
documenter dans le commit qu'on prévisualise via `?hack=` (Task 6).

- [ ] **Step 3 : Vérif build**

Run: `npm run build`
Expected: succès.

Run: `npm run selftest && npm run selftest:operator`
Expected: PASS (motifs non encore câblés au moteur).

- [ ] **Step 4 : Revue visuelle (manuelle, après Task 6 pour le hook `?hack=`)**

Lancer `npm run dev`, ouvrir pour chaque type :
`http://localhost:5173/?scene=<un-slug-local>&hack=command-injection` (puis
`link-hijack`, `telemetry-spoof`, `gnss-spoof`, `network-takeover`,
`firmware-override`).
Critère : sans lire l'en-tête `HACK // …`, les six motifs sont distinguables les
uns des autres au premier coup d'œil. Sinon, itérer les `draw*`.

- [ ] **Step 5 : Commit**

```bash
git add src/hack-grammars.js src/style.css
git commit -m "PHASE 09 — six motifs visuels de familles de hack

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6 : Câblage dans `chooseScene()` + hook debug `?hack=`

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes:
  - `runHack` depuis `./hack.js` (Task 4).
  - `normalizeHackType` depuis `../tools/hack-model.mjs` (Task 3).
  - Existant : `OPTS` (objet gelé construit depuis `new URLSearchParams`),
    `runTargetScan(ui, {seed,count}) -> {seed,count,index}`,
    `generateTargetScan({seed,count})`, `scan.candidates[i]._family`,
    `scan.candidates[i]._hackType` (Task 1), `chooseScene()`.
- Produces: après le TARGET SCAN d'une session fraîche, `runHack` est joué avant
  le retour de `chooseScene()`. Nouveau `OPTS.hack` (string|null).

- [ ] **Step 1 : Ajouter `hack` à `OPTS`**

Dans `src/main.js`, objet `OPTS` (autour ligne 55-67), ajouter après
`family: params.get('family'),` :

```js
	// Dev-only : ?hack=gnss-spoof prévisualise le motif de ce type de hack
	// avant le vol, sur les chemins qui sautent le TARGET SCAN (?scene=/?family=).
	hack: params.get('hack'),
```

- [ ] **Step 2 : Importer `runHack` et `normalizeHackType`**

Près des imports existants `import { runTargetScan } from './target-scan.js';`
et `import { generateTargetScan } from '../tools/target-model.mjs';` ajouter :

```js
import { runHack } from './hack.js';
import { normalizeHackType } from '../tools/hack-model.mjs';
```

- [ ] **Step 3 : Câbler dans la branche « session fraîche » de `chooseScene()`**

Bloc actuel (autour ligne 811-817) :

```js
	// Session fraîche → TARGET SCAN avant boot().
	const seed = Math.random().toString(16).slice(2, 12);
	const count = signalCountFor(slug);
	const scan = generateTargetScan({ seed, count });
	const choice = await runTargetScan(ui, { seed, count }); // { seed, count, index }
	const family = scan.candidates[choice.index]._family;
	return { slug, resume: undefined, target: choice, family };
```

le remplacer par :

```js
	// Session fraîche → TARGET SCAN puis AUTOMATED ANALYSIS avant boot().
	const seed = Math.random().toString(16).slice(2, 12);
	const count = signalCountFor(slug);
	const scan = generateTargetScan({ seed, count });
	const choice = await runTargetScan(ui, { seed, count }); // { seed, count, index }
	const cand = scan.candidates[choice.index];
	await runHack(ui, { hackType: cand._hackType, family: cand._family });
	return { slug, resume: undefined, target: choice, family: cand._family };
```

- [ ] **Step 4 : Hook debug `?hack=` sur les chemins qui sautent le TARGET SCAN**

Dans `chooseScene()`, chemin `OPTS.scene` (retour ligne ~782) et chemin
`OPTS.family` (retour ligne ~807). Juste avant chacun de ces `return`, insérer :

```js
		const previewHack = normalizeHackType(OPTS.hack);
		if (previewHack) await runHack(ui, { hackType: previewHack, family: OPTS.family || undefined });
```

(Pour le chemin `OPTS.scene`, `ui` est `document.getElementById('ui')` déjà
présent en tête de `chooseScene`.)

- [ ] **Step 5 : Vérif build + selftests**

Run: `npm run build && npm run selftest && npm run selftest:operator`
Expected: PASS.

- [ ] **Step 6 : Vérif navigateur bout en bout**

`npm run dev`, puis :
1. Depuis le terminal, `GLOBAL SCANNER` ou `LOCAL TERRAIN` → choisir un terrain
   → `TARGET SCAN` → sélectionner un signal → `CONFIRM` →
   **l'écran `HACK // <TYPE>` apparaît**, le log se remplit ligne à ligne et se
   fige sur `MANUAL OVERRIDE REQUIRED`, le motif s'anime → `[ JACK IN ]` →
   le vol démarre.
2. Console : vérifier `[link] target signal …` et l'absence d'erreur.
3. `?scene=<slug>&hack=firmware-override` → l'écran de hack s'affiche avant le
   vol avec le bon motif.
4. `?scene=<slug>` seul → **pas** d'écran de hack (chemin dev inchangé).
5. Recharger après un crash (`location.href = location.pathname`) → retour
   terminal propre.

Consigner le résultat dans `sim/HANDOFF.md` (Task 7).

- [ ] **Step 7 : Commit**

```bash
git add src/main.js
git commit -m "PHASE 09 — câblage AUTOMATED ANALYSIS dans le flux + hook ?hack=

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7 : Revue de sûreté + documentation

**Files:**
- Modify: `sim/HANDOFF.md`, `sim/README.md`

- [ ] **Step 1 : Revue de sûreté du diff**

Run: `git diff main...phase-09-hacking`
Relire intégralement. Confirmer, ligne à ligne :
- Le log automatique = les 4 entrées de `HACK_LOG_LINES`, rien d'autre.
- Aucun `draw*` ne décrit une étape réelle : rectangles/sinus/hex aléatoires,
  pas de trame protocolaire, pas de commande, pas d'adresse, pas d'outil nommé.
- Aucun commentaire ne donne une recette reproductible.
- Aucun texte ne référence un CVE, un exploit, un payload.
Si un doute : neutraliser (remplacer par du bruit purement graphique).

- [ ] **Step 2 : Section README**

Dans `sim/README.md`, à côté de la description du TARGET SCAN (PHASE 08),
ajouter un paragraphe : les six familles de hack (`HACK_TYPES`), le fait que
`hackType` est une propriété de cible tirée à la génération (`target-model.mjs`),
indépendante de la difficulté du vol, persistée sur la session. Mentionner le
hook `?hack=<type>` pour prévisualiser un motif, et que le rituel réel
(`CONTROL VECTOR` + QTE) est PHASE 10 — `[ JACK IN ]` est provisoire.

- [ ] **Step 3 : HANDOFF — état vérifié / non vérifié**

Dans `sim/HANDOFF.md` :
- **Vérifié** : ce qui a été cliqué en navigateur au Step 6 de Task 6.
- **Non vérifié** : ressenti de l'écran (durée, rythme du log), lisibilité des
  6 motifs sur écran réel non testée par l'utilisateur ; l'écran de hack n'est
  pas rejoué au `resume` (le `hackType` est relu du disque pour le futur TARGET
  LOG, PHASE 17, mais pas remis en scène) ; `[ JACK IN ]` est un placeholder.
- Noter que la revue de sûreté (Step 1) a été faite.

- [ ] **Step 4 : Mettre à jour l'issue**

```bash
gh issue comment 46 --repo lionrayonnant/FPVThePlanet --body "PHASE 09 implémentée sur la branche phase-09-hacking : hackType comme propriété de cible (6 familles, tirage seedé indépendant), écran AUTOMATED ANALYSIS (log Bible §18 + motif par famille) jusqu'à MANUAL OVERRIDE REQUIRED + [ JACK IN ] provisoire. Rituel réel = PHASE 10. Revue de sûreté faite (git diff relu, aucune procédure offensive réelle)."
```

- [ ] **Step 5 : Commit**

```bash
git add sim/HANDOFF.md sim/README.md
git commit -m "PHASE 09 — docs : section hacking, état HANDOFF, revue de sûreté

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6 : Finaliser la branche**

Utiliser la skill `superpowers:finishing-a-development-branch` : suite verte
(`npm run selftest && npm run selftest:operator && npm run build`), puis
décider push / PR / merge avec l'utilisateur.

---

## Self-Review

**Spec coverage :**
- Règle de sécurité → Task 6 (log fixe), Task 5 (motifs décoratifs), Task 7
  Step 1 (revue). ✅
- A — `HACK_TYPES` + `_hackType` tiré à la génération, indépendant → Task 1. ✅
- A — `describeTarget` inchangé / pas de fuite → Task 1 Step 1 (tests). ✅
- A — `resolveTarget` porte `hackType` → Task 1. ✅
- A — `sanitizeTarget` passthrough + validation → Task 2. ✅
- A — `map-api-plugin.mjs` aucun changement → confirmé (rien dans les tâches). ✅
- B — `src/hack.js`, `runHack(root,{hackType,family})`, log temporisé,
  `MANUAL OVERRIDE REQUIRED`, `[ JACK IN ]` + Entrée, boucle rAF unique,
  teardown → Task 4. ✅
- B — motif par famille, map `GRAMMARS`, une boucle, `.hack-*` CSS,
  `family` teinte seulement → Task 4 + Task 5. ✅
- C — câblage `chooseScene` après `runTargetScan`, exclusions
  `?scene=`/`?family=`/`resume`, hook `?hack=` → Task 6. ✅
- D — revue de sûreté (spec + HANDOFF) → Task 7. ✅
- E — tests `target-selftest` (déterminisme, indépendance, distribution,
  non-fuite, `resolveTarget`) → Task 1 ; `sanitizeTarget` → Task 2 ;
  `npm run selftest` vert → Steps de vérif de chaque tâche ; vérif navigateur +
  `?hack=` → Task 6 Step 6. ✅
- Fichiers touchés de la spec : tous couverts. `src/link.js` : la spec le liste
  au contexte mais n'y prescrit aucun changement (le RSSI est déjà câblé PHASE
  08) — aucune tâche, correct.
- Hors périmètre (PHASE 10 ritual, PHASE 11 entry state, PHASE 17 log, son) →
  aucune tâche, correct.

**Placeholder scan :** les `draw*` de Task 5 sont décrits par un tableau de
grammaire + contraintes précises (déterminisme, taille, pas de `Math.random`,
helpers `W/H/frame`) plutôt que du code complet — c'est un livrable visuel
itératif assumé, borné par le critère d'acceptation du Step 4. Le reste du plan
porte le code réel. Pas de « TBD » / « handle edge cases » / test sans code.

**Type consistency :** `runHack(root, { hackType, family })` identique Task 4/6.
`GRAMMARS` / `drawNeutral` importés de `./hack-grammars.js` (Task 4 crée,
Task 5 peuple). `normalizeHackType` signature identique Task 3/6.
`HACK_LOG_LINES` (4 entrées) identique Task 3/4. `_hackType` (candidat) vs
`hackType` (descriptor résolu / persisté) : distinction tenue partout —
underscore = interne au scan, sans underscore = sorti par `resolveTarget`.
`HACK_TYPES` défini Task 1 dans `target-model.mjs`, ré-exporté par
`hack-model.mjs` Task 3, importé par `session-model.mjs` Task 2.
