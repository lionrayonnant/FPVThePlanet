# Retrait du CONTROL VECTOR — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retirer entièrement le CONTROL VECTOR du jeu et terminer le hack par un bouton `[ JACK IN ]`, pour qu'aucun écran ne puisse plus piéger le joueur sans sortie.

**Architecture:** Le rituel est le seul chemin qui résout aujourd'hui la promesse de `runHack` ; la tâche 1 lui substitue un bouton et une sortie AVANT de supprimer quoi que ce soit, pour que le jeu reste jouable à chaque commit. Viennent ensuite le retrait des fichiers dédiés, puis la donnée (bootstrap, terminal, schéma opérateur, serveur), puis l'audio, puis le CSS, puis la documentation. Chaque tâche laisse `selftest:operator` vert.

**Tech Stack:** JavaScript ES modules, Vite, selftests maison en Node (`node:assert/strict`), faux DOM maison (`tools/lib/fake-dom.mjs`).

**Spec:** `sim/docs/superpowers/specs/2026-09-09-retrait-control-vector-design.md`

## Global Constraints

- Tout le code et les commentaires en **anglais** ; les messages de commit et le CHANGELOG en **français** (convention du dépôt, `CLAUDE.md`).
- Ne lancer que le selftest du module touché à chaque tâche. `npm run selftest:ci` **une seule fois**, à la toute fin (tâche 8), avant le push (`CLAUDE.md`, section CI).
- Ne jamais lancer un selftest en tâche de fond : toujours au premier plan.
- Travailler dans le worktree `.claude/worktrees/retrait-control-vector`, branche `worktree-retrait-control-vector`. Ne pas `cd` vers le dépôt principal.
- `npm install` dans `sim/` avant la première tâche si `node_modules` est absent.
- Aucun écran ne doit pouvoir exister sans sortie : c'est la règle que ce chantier écrit.
- Ne pas toucher : `CHANGELOG.md` (sections publiées), `sim/docs/superpowers/specs/2026-08-29-phase-10-*` (document historique), `tools/buildnotes-model.mjs`, `public/music.json`.

---

### Task 1: `[ JACK IN ]` remplace le rituel dans `hack.js`

Le cœur. `finish()` (`src/hack.js:196`) n'est atteignable que par `runRitual(...).then(finish, …)` (`:169`). Cette tâche lui donne un bouton et une sortie, sans encore rien supprimer : `ritual.js` reste sur le disque, simplement plus appelé. Le jeu doit être jouable au commit.

**Files:**
- Create: `sim/tools/hack-render-selftest.mjs`
- Modify: `sim/src/hack.js` (imports l. 27-28, `arm()` l. 159-173, `finish()` l. 196-200)
- Modify: `sim/src/main.js` (les 4 sites d'appel : l. 2757, 2955, 2968, 3037)
- Modify: `sim/package.json` (ajouter le nouveau selftest à `selftest:operator`)

**Interfaces:**
- Consomme : `screen`, `button`, `keyHints` de `src/terminal.js` (signatures : `button(label, onClick, cls = 'terminal-link', title = '')`, `keyHints(pairs)` où `pairs` est un tableau de `[touche, action]`) ; `menuNav(container, { back })` de `src/menu-nav.js`.
- Produit : `runHack(root, opts)` résout désormais `{ aborted: true }` quand le joueur abandonne, et `undefined` (comme aujourd'hui) quand il engage. Les appelants doivent tester `aborted`.

- [ ] **Step 1: Écrire le selftest de rendu, qui échoue**

Créer `sim/tools/hack-render-selftest.mjs` :

```javascript
// Selftest de rendu de l'écran de hack (src/hack.js).
//
// Il n'en existait aucun : hack-selftest.mjs ne couvre que les helpers purs, et
// la machine à états — celle qui pouvait laisser le joueur sur un écran sans
// sortie — n'était testée nulle part. C'est ce trou que l'issue #33 a trouvé.
//
// Lancer : node tools/hack-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

const { runHack } = await import('../src/hack.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };

// Le hack déroule ses étapes sur des minuteurs. On ne les attend pas : le test
// pousse la machine jusqu'à l'armement en vidant la file, ce que `__hackNow`
// expose pour ce seul usage.
const openArmed = async () => {
	reset();
	const p = runHack(dom.root, { hackType: 'GNSS SPOOF', family: 'freestyle5', ready: Promise.resolve() });
	await tick();
	globalThis.__hackTestArm?.();
	await tick();
	return p;
};

const jackIn = () => dom.root.querySelectorAll('button').find((b) => b.textContent.includes('JACK IN'));

await t('#33 : à l\'armement, un bouton JACK IN est monté', async () => {
	const p = await openArmed();
	assert.ok(jackIn(), 'aucun bouton JACK IN à l\'écran');
	jackIn().click();
	await p;
});

await t('#33 : JACK IN résout le hack et démonte l\'écran', async () => {
	const p = await openArmed();
	jackIn().click();
	const out = await p;
	assert.equal(out?.aborted, undefined, 'engager ne doit pas être un abandon');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#33 : l\'écran annonce sa sortie (D15)', async () => {
	const p = await openArmed();
	assert.match(dom.root.textContent, /ESC/, 'aucun indice de sortie affiché');
	jackIn().click();
	await p;
});

await t('#33 : Échap abandonne et rend { aborted: true }', async () => {
	const p = await openArmed();
	dom.key('Escape');
	const out = await p;
	assert.deepEqual(out, { aborted: true });
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#33 : une double activation ne résout qu\'UNE fois', async () => {
	const p = await openArmed();
	const b = jackIn();
	b.click();
	b.click();
	const out = await p;
	assert.equal(out?.aborted, undefined);
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0);
});

dom.restore();
console.log(`\n${n} tests hack-render OK`);
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `node tools/hack-render-selftest.mjs`
Expected: FAIL — « aucun bouton JACK IN à l'écran » (le rituel prend encore l'écran).

- [ ] **Step 3: Remplacer `arm()` dans `src/hack.js`**

Retirer les deux imports du rituel en tête de fichier :

```javascript
// SUPPRIMER ces deux lignes (l. 27-28) :
import { runRitual } from './ritual.js';
import { ritualVector } from '../tools/ritual-model.mjs';
```

Ajouter `button` et `keyHints` à l'import de `terminal.js`, et importer `menuNav` :

```javascript
import { screen, button, keyHints } from './terminal.js';
import { menuNav } from './menu-nav.js';
```

Remplacer `arm()` (l. 159-173) par :

```javascript
		// The hack ends on a single deliberate gesture, and the screen can
		// always be left (issue #33). What stood here was the CONTROL VECTOR
		// ritual: it listened to the four arrow keys and NOTHING else, held a
		// promise with no reject, and blocked every nav still mounted beneath
		// it. A player who had forgotten the vector he registered once, at
		// first launch, was stuck until he reloaded the page — and since
		// fieldLoop awaits runHack(), the whole game loop was stuck with him.
		//
		// `[ JACK IN ]` is not new: it is what stood here before PHASE 10, and
		// the crew already has lines for MANUAL_OVERRIDE and JACK_IN waiting
		// for a call site (src/dialogue-fallback.js).
		const arm = () => {
			if (armed || done) return;
			armed = true;
			phase = 'armed';
			paint();
			// D9: the crew speaks before the handover, never during it.
			stopHack();
			s.box.appendChild(button('JACK IN', finish, 'terminal-cta'));
			// D15: Escape leaves, and the screen says so. This screen had NO
			// exit at all while the terrain loaded behind it.
			s.box.appendChild(keyHints([['ESC', 'ABORT']]));
			nav = menuNav(s.el, { back: abort });
		};
```

Déclarer `nav` avec les autres variables d'état (près de `let armed`, l. 88) :

```javascript
		let nav = null;
```

Ajouter `abort()` juste avant `finish()` (l. 196), et détacher le nav dans `teardown()` :

```javascript
		// Abandoning is not a failure: the player simply does not want this
		// target. main.js already knows this shape from the TARGET SCAN, whose
		// Escape returns { cancelled: true } and loops back to the zone.
		const abort = () => {
			if (done) return;
			teardown();
			resolve({ aborted: true });
		};
```

Dans `teardown()` (l. 183-194), ajouter avant `s.remove()` :

```javascript
			nav?.detach();
			nav = null;
```

Enfin, pour rendre l'armement atteignable en test sans attendre les minuteurs, exposer un crochet juste avant `raf = requestAnimationFrame(loop);` (l. 202) :

```javascript
		// Test-only hook (tools/hack-render-selftest.mjs): the screen walks its
		// phases on timers, and a render test has no business waiting seconds
		// for them. Nothing in the game reads this.
		globalThis.__hackTestArm = () => { timers.forEach(clearTimeout); timers.clear(); arm(); };
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `node tools/hack-render-selftest.mjs`
Expected: PASS — `5 tests hack-render OK`.

- [ ] **Step 5: Traiter l'abandon dans les 4 sites d'appel de `main.js`**

Aux lignes 2757, 2955, 2968 et 3037, `await runHack(...)` devient un résultat qu'on teste. Pour les deux chemins de jeu (l. 2955 en LIVE, l. 3037 en carte cuite), calquer sur ce que fait déjà le TARGET SCAN à la l. 3002 :

```javascript
		const hack = await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand });
		// Abandon au hack : même traitement que l'Échap du TARGET SCAN. Le
		// préchargement lancé plus haut continue en tâche de fond — il ne monte
		// rien dans la scène Three et a capturé sa propre base d'URL.
		if (hack?.aborted) {
			introFrozen = false;
			continue;
		}
```

Pour les deux chemins de dev (l. 2757 et 2968, prévisualisation `?hack=`), l'abandon n'a rien à reprendre : `await runHack(...)` suffit, la valeur est ignorée.

- [ ] **Step 6: Ajouter le selftest à la chaîne**

Dans `sim/package.json`, insérer `node tools/hack-render-selftest.mjs && ` juste après `node tools/hack-selftest.mjs && ` dans `selftest:operator`.

- [ ] **Step 7: Vérifier que rien d'autre n'a bougé**

Run: `node tools/hack-selftest.mjs && node tools/hack-render-selftest.mjs`
Expected: les deux passent.

- [ ] **Step 8: Commit**

```bash
git add sim/src/hack.js sim/src/main.js sim/tools/hack-render-selftest.mjs sim/package.json
git commit -m "feat(hack): [ JACK IN ] remplace le rituel, et l'écran a enfin une sortie (#33)"
```

---

### Task 2: Supprimer les fichiers du rituel, renommer ceux de l'intro

`ritual.js` n'est plus appelé depuis la tâche 1. Ses deux selftests ne sont **pas** supprimés : ils portent le contrat des primitives que `src/intro.js:129` exécute à chaque lancement du jeu.

**Files:**
- Delete: `sim/src/ritual.js`, `sim/tools/ritual-model.mjs`
- Rename: `sim/tools/ritual-selftest.mjs` → `sim/tools/intro-primitives-selftest.mjs`
- Rename: `sim/tools/ritual-bench.mjs` → `sim/tools/intro-primitives-bench.mjs`
- Modify: `sim/src/hack-grammars.js` (retirer `FAMILY_PRIMITIVES`, l. 513+)
- Modify: `sim/package.json`

**Interfaces:**
- Consomme : rien de la tâche 1.
- Produit : `RITUAL_PRIMITIVES` et `cosmeticSeed` restent exportés par `src/hack-grammars.js` — `src/intro.js` et `src/hack.js` en dépendent. `FAMILY_PRIMITIVES` disparaît.

- [ ] **Step 1: Vérifier qu'aucun consommateur ne reste**

Run: `grep -rn "ritual.js\|ritual-model\|FAMILY_PRIMITIVES" sim/src sim/tools`
Expected: uniquement `tools/ritual-selftest.mjs` et `tools/ritual-bench.mjs`.

- [ ] **Step 2: Renommer les deux selftests**

```bash
git mv sim/tools/ritual-selftest.mjs sim/tools/intro-primitives-selftest.mjs
git mv sim/tools/ritual-bench.mjs sim/tools/intro-primitives-bench.mjs
```

- [ ] **Step 3: Réécrire l'en-tête et le garde-fou du selftest renommé**

Dans `sim/tools/intro-primitives-selftest.mjs` : retirer l'import de `./ritual-model.mjs` et tous les tests qui le concernent (`ritualVector`, la longueur du vecteur, la comparaison de la saisie). Garder les tests des primitives — contrat `(t, seed, dur)`, borne 44×12, `RITUAL_PRIMITIVES` — et retirer `FAMILY_PRIMITIVES` de l'import.

Remplacer l'en-tête par :

```javascript
// Selftest des primitives demo scene (PHASE 20). Elles ont été écrites pour le
// rituel CONTROL VECTOR, retiré du jeu (#33) ; src/intro.js les exécute encore
// à CHAQUE lancement, et ce fichier est le seul endroit où leur contrat et leur
// budget sont vérifiés. C'est la raison pour laquelle il a été renommé plutôt
// que supprimé avec le rituel.
// Lancer : node tools/intro-primitives-selftest.mjs
```

Mettre à jour le garde-fou d'acceptation #57 (l. 123) :

```javascript
const EVENT_MODULES = new Set(['hack-grammars.js', 'intro.js']);
```

- [ ] **Step 4: Lancer les deux, vérifier qu'ils passent**

Run: `node tools/intro-primitives-selftest.mjs && node tools/intro-primitives-bench.mjs`
Expected: les deux passent.

- [ ] **Step 5: Supprimer les fichiers du rituel**

```bash
git rm sim/src/ritual.js sim/tools/ritual-model.mjs
```

- [ ] **Step 6: Retirer `FAMILY_PRIMITIVES` de `hack-grammars.js`**

Supprimer le bloc `export const FAMILY_PRIMITIVES = { … }` (l. 513+). Laisser `RITUAL_PRIMITIVES` et son nom : `src/intro.js` les nomme déjà ainsi et `style.css:1413` le documente ; renommer élargirait le diff sans rien réparer.

- [ ] **Step 7: Mettre `package.json` à jour**

Dans `selftest:operator`, remplacer `node tools/ritual-selftest.mjs` par `node tools/intro-primitives-selftest.mjs` et `node tools/ritual-bench.mjs` par `node tools/intro-primitives-bench.mjs`.

- [ ] **Step 8: Vérifier que le hack tient toujours**

Run: `node tools/hack-render-selftest.mjs && node tools/intro-primitives-selftest.mjs`
Expected: les deux passent.

- [ ] **Step 9: Commit**

```bash
git add -A sim/
git commit -m "refactor(ritual): supprimer le rituel, garder les primitives de l'intro (#33)"
```

---

### Task 3: Retirer le vecteur du bootstrap

**Files:**
- Modify: `sim/src/bootstrap.js` (supprimer `captureControlVector` l. 220-313 et `registeredScreen` l. 315-328, modifier `bootstrap()` l. 336-347 et `flushOrRetry` l. 351-365)

**Interfaces:**
- Consomme : rien.
- Produit : `src/bootstrap.js` n'exporte plus `captureControlVector`. `bootstrap()` garde sa signature.

- [ ] **Step 1: Vérifier les consommateurs de `captureControlVector`**

Run: `grep -rn "captureControlVector" sim/src sim/tools`
Expected: `src/bootstrap.js` (définition + appel) et `src/terminal.js:6,363` — ce dernier tombe en tâche 4.

- [ ] **Step 2: Supprimer les deux écrans**

Supprimer `export async function captureControlVector(...)` (l. 220-313) et `function registeredScreen(...)` (l. 315-328) en entier. Retirer les imports devenus inutiles en tête de fichier : `readGamepadDir` de `./gamepad-dir.js` s'il n'a plus d'autre usage dans le fichier — le vérifier par `grep -n "readGamepadDir" sim/src/bootstrap.js`.

- [ ] **Step 3: Réécrire la séquence de `bootstrap()`**

Remplacer les trois lignes du vecteur (l. 338-340 et 342) par rien, et commenter le retrait :

```javascript
	await hardwareScreen(root);
	await nameScreen(root, api);
	// Le CONTROL VECTOR se définissait ici (#33). Il demandait au joueur de
	// mémoriser une suite de flèches hors du jeu, et le punissait d'un blocage
	// total à chaque acquisition s'il l'oubliait. Le bootstrap passe donc de
	// quatre écrans à deux avant le briefing.
	await flushOrRetry(root, api);
```

- [ ] **Step 4: Corriger le message de `flushOrRetry`**

Le flush ne protège plus le vecteur mais le nom. Dans `flushOrRetry` (l. ~359), remplacer :

```javascript
	// SUPPRIMER : 'VECTOR NOT SAVED — RETRY'
	// AJOUTER :
	'PROFILE NOT SAVED — RETRY'
```

- [ ] **Step 5: Vérifier**

Run: `node tools/operator-selftest.mjs && node src/operator.selftest.mjs`
Expected: passent (le schéma n'a pas encore bougé).

- [ ] **Step 6: Commit**

```bash
git add sim/src/bootstrap.js
git commit -m "refactor(bootstrap): le CONTROL VECTOR ne se définit plus au premier lancement (#33)"
```

---

### Task 4: Retirer le vecteur du terminal et du briefing

**Files:**
- Modify: `sim/src/terminal.js` (supprimer `controlVectorScreen` l. 341-376, l'entrée de menu l. 787, l'import l. 6, la table `ARROW` l. 19 si elle n'a plus d'usage)
- Modify: `sim/tools/briefing-model.mjs` (l. 114)
- Modify: `sim/tools/terminal-render-selftest.mjs` (l. 110)
- Modify: `sim/tools/data-render-selftest.mjs` (l. 106, et les commentaires l. 213, 239-241)
- Modify: `sim/tools/briefing-selftest.mjs` (l. 146)

**Interfaces:**
- Consomme : `src/bootstrap.js` n'exporte plus `captureControlVector` (tâche 3).
- Produit : la liste des entrées du terminal perd `CONTROL VECTOR` ; tout ce qui vérifie cette liste en ordre doit décaler ses index.

- [ ] **Step 1: Mettre les tests à jour d'abord, et les voir échouer**

Dans `sim/tools/terminal-render-selftest.mjs:110` et `sim/tools/data-render-selftest.mjs:106`, retirer `'CONTROL VECTOR'` de la liste des entrées attendues.

Dans `sim/tools/briefing-selftest.mjs:146`, remplacer :

```javascript
	assert.deepEqual(labels.slice(0, 3), ['TARGET SCAN', 'CONTROL VECTOR', 'FLIGHT']);
```

par :

```javascript
	assert.deepEqual(labels.slice(0, 2), ['TARGET SCAN', 'FLIGHT']);
```

Run: `node tools/terminal-render-selftest.mjs`
Expected: FAIL — l'écran monte encore l'entrée `CONTROL VECTOR`.

- [ ] **Step 2: Supprimer l'écran et son entrée**

Dans `sim/src/terminal.js` : supprimer `async function controlVectorScreen(root, api)` (l. 341-376) en entier, la ligne `link(row, 'CONTROL VECTOR', …)` (l. 787), et l'import `captureControlVector` (l. 6) en gardant `bootstrap`. Vérifier par `grep -n "ARROW" sim/src/terminal.js` si la table des flèches (l. 19) a encore un usage ; la supprimer sinon.

- [ ] **Step 3: Retirer la ligne du briefing**

Dans `sim/tools/briefing-model.mjs:114`, supprimer l'entrée `['CONTROL VECTOR', 'THE ARROWS YOU REGISTERED']` du tableau de `sessionScreen()`.

- [ ] **Step 4: Vérifier**

Run: `node tools/terminal-render-selftest.mjs && node tools/data-render-selftest.mjs && node tools/briefing-selftest.mjs && node tools/briefing-render-selftest.mjs`
Expected: tous passent.

- [ ] **Step 5: Commit**

```bash
git add sim/src/terminal.js sim/tools/briefing-model.mjs sim/tools/terminal-render-selftest.mjs sim/tools/data-render-selftest.mjs sim/tools/briefing-selftest.mjs
git commit -m "refactor(terminal): l'écran CONTROL VECTOR et sa ligne de briefing disparaissent (#33)"
```

---

### Task 5: Schéma opérateur v3 et route serveur

**Files:**
- Modify: `sim/tools/operator-store.mjs` (l. 5 `SCHEMA_VERSION`, l. 30-35 `validateControlVector`, l. 43 `freshState`, l. 93 zone de `delete`)
- Modify: `sim/server/api.mjs` (l. 23 import, l. 179 `OP_WRITABLE_KEYS`, l. 264-265 validation)
- Modify: `sim/tools/operator-selftest.mjs` (l. 48, 60-62, 103)
- Modify: `sim/tools/server-selftest.mjs` (l. 359)
- Modify: `sim/tools/session-selftest.mjs` (l. 454, 478, 497, 536)
- Modify: `sim/src/operator.selftest.mjs` (l. 66, 89, 107, 111-116, 124, 131, 136)

**Interfaces:**
- Consomme : plus aucun code client n'écrit `controlVector` (tâches 3 et 4).
- Produit : `SCHEMA_VERSION === 3` ; `migrate()` supprime `controlVector` de tout état ; `validateControlVector` n'existe plus.

- [ ] **Step 1: Écrire le test de migration, le voir échouer**

Dans `sim/tools/operator-selftest.mjs`, ajouter :

```javascript
{
	// v2 → v3 : la clé morte du CONTROL VECTOR part avec la migration (#33).
	// Sans ce `delete`, le spread `...state` de migrate() la réinjecterait
	// telle quelle dans tout état déjà écrit sur disque.
	const v2 = { id: 'op1', name: 'TEST', schemaVersion: 2, controlVector: ['up', 'right', 'down', 'left'], sessions: [] };
	const m = migrate(v2);
	check('v2 → v3 : controlVector est retiré', m.controlVector === undefined, JSON.stringify(m.controlVector));
	check('v2 → v3 : schemaVersion vaut 3', m.schemaVersion === 3, String(m.schemaVersion));
	check('freshState n\'a pas de controlVector', freshState({ id: 'x' }).controlVector === undefined);
}
```

Run: `node tools/operator-selftest.mjs`
Expected: FAIL — `controlVector` survit et `schemaVersion` vaut 2.

- [ ] **Step 2: Bumper le schéma et nettoyer**

Dans `sim/tools/operator-store.mjs` :

```javascript
export const SCHEMA_VERSION = 3;
```

Retirer `controlVector: []` de `freshState()` (l. 43), supprimer `export function validateControlVector(v)` (l. 30-35) et la constante `DIRS` (l. 28) si elle n'a plus d'usage — le vérifier par `grep -n "DIRS" sim/tools/operator-store.mjs`.

Dans `migrate()`, juste après le `delete merged.targetLog;` existant :

```javascript
	// v2 → v3 : le CONTROL VECTOR a été retiré du jeu (#33). Même traitement que
	// `targetLog` — on retire la clé morte plutôt que de la traîner, sans quoi le
	// spread ci-dessus la réinjecte dans tout état déjà écrit.
	delete merged.controlVector;
```

- [ ] **Step 3: Vérifier que le test passe**

Run: `node tools/operator-selftest.mjs`
Expected: PASS.

- [ ] **Step 4: Retirer la clé côté serveur**

Dans `sim/server/api.mjs` : retirer `validateControlVector` de l'import (l. 23), retirer `'controlVector'` de `OP_WRITABLE_KEYS` (l. 179), et supprimer la branche de validation (l. 264-265). Les deux doivent tomber **ensemble** : sinon un vieux client qui patche `controlVector` reçoit une 400 opaque.

- [ ] **Step 5: Nettoyer les états littéraux des selftests**

Retirer `controlVector` des objets d'état écrits en dur dans `sim/tools/server-selftest.mjs:359`, `sim/tools/session-selftest.mjs:454,478,497,536`, `sim/src/operator.selftest.mjs:66,89,107,111-116,124,131,136`, et mettre à jour toute assertion qui le nomme (`operator-selftest.mjs:48,60-62,103`).

- [ ] **Step 6: Vérifier**

Run: `node tools/operator-selftest.mjs && node tools/server-selftest.mjs && node tools/session-selftest.mjs && node src/operator.selftest.mjs && node tools/session-api-selftest.mjs`
Expected: tous passent.

- [ ] **Step 7: Commit**

```bash
git add sim/tools/operator-store.mjs sim/server/api.mjs sim/tools/operator-selftest.mjs sim/tools/server-selftest.mjs sim/tools/session-selftest.mjs sim/src/operator.selftest.mjs
git commit -m "refactor(operator): schéma v3, la clé controlVector part à la migration (#33)"
```

---

### Task 6: Retirer `RITUAL` du vocabulaire audio

`UI_EVENTS` est verrouillé en **égalité stricte** et balayé sur tout `src/` : tout doit bouger dans le même commit, sinon la chaîne est rouge.

**Files:**
- Modify: `sim/tools/ui-audio-model.mjs` (l. 20 `UI_EVENTS`, l. 31 `UI_FAMILY`, l. 126-249 `RITUAL_SCORES`, l. 258-273 `scoreFor`, l. 280-289 `RITUAL_TENSION`, l. 293-299 `ritualTensionParams`)
- Modify: `sim/src/ui-audio.js` (l. 12 import, l. 272-277 branche `RITUAL`, l. 288-296 `playRitual`, l. 391-432 `_ensureTension`, l. 434-452 `ritualTension`, l. 454+ `killRitualTension`)
- Modify: `sim/src/audio-bus.js` (l. 11, commentaire du schéma)
- Modify: `sim/tools/ui-audio-selftest.mjs` (l. 20-36, 161-258, 302-330)
- Modify: `sim/tools/ui-audio-render-selftest.mjs` (l. 8, 65-70, 88-116, 263-322, 327-355)

**Interfaces:**
- Consomme : plus aucun appelant de `playRitual` / `ritualTension` (tâche 2 a supprimé `ritual.js`).
- Produit : `UI_EVENTS` a **sept** entrées : `['BOOT','TERRAIN_READY','TARGET_FOUND','ERROR','LINK_LOST','LINK_RESTORED','INTRO']`. `UI_FAMILY` n'a plus que les familles `SYSTEM` et `LINK`.

- [ ] **Step 1: Mettre le selftest à jour d'abord**

Dans `sim/tools/ui-audio-selftest.mjs`, remplacer l'assertion l. 20-25 :

```javascript
t('UI_EVENTS : exactement les sept événements de la spec', () => {
	assert.deepEqual(UI_EVENTS, [
		'BOOT', 'TERRAIN_READY', 'TARGET_FOUND', 'ERROR',
		'LINK_LOST', 'LINK_RESTORED', 'INTRO',
	]);
});
```

Retirer `assert.equal(UI_FAMILY.RITUAL, 'RITUAL')` (l. 35) et `'RITUAL'` de la liste des familles autorisées (l. 31). Supprimer les cinq tests des partitions (l. 161-258) et les quatre de la tension (l. 302-330), ainsi que les imports correspondants.

Run: `node tools/ui-audio-selftest.mjs`
Expected: FAIL — `UI_EVENTS` contient encore `'RITUAL'`.

- [ ] **Step 2: Retirer `RITUAL` du modèle**

Dans `sim/tools/ui-audio-model.mjs` : retirer `'RITUAL'` de `UI_EVENTS` (l. 20) et `RITUAL: 'RITUAL'` de `UI_FAMILY` (l. 31) ; supprimer `RITUAL_SCORES` (l. 126-249), `scoreFor` (l. 258-273), `RITUAL_TENSION` (l. 280-289) et `ritualTensionParams` (l. 293-299). **Garder** `PERCUSSIVE` (l. 107) : `INTRO_SCORE` s'en sert.

- [ ] **Step 3: Retirer le rituel du client audio**

Dans `sim/src/ui-audio.js` : retirer `RITUAL_TENSION, ritualTensionParams, scoreFor` de l'import (l. 12) ; supprimer la branche `if (event === 'RITUAL')` (l. 272-277), `playRitual` (l. 288-296), `_ensureTension` (l. 391-432), `ritualTension` (l. 434-452) et `killRitualTension` (l. 454+). **Garder** `_voice` et `LEVEL.ritual` : `playIntro()` les utilise.

Dans `sim/src/audio-bus.js:11`, retirer `RITUAL` de la liste des familles du commentaire.

- [ ] **Step 4: Nettoyer le selftest de rendu audio**

Dans `sim/tools/ui-audio-render-selftest.mjs` : retirer l'import `RITUAL_TENSION` (l. 8) et supprimer les blocs de tests l. 65-70, 88-116, 263-322 et 327-355.

- [ ] **Step 5: Vérifier**

Run: `node tools/ui-audio-selftest.mjs && node tools/ui-audio-render-selftest.mjs && node tools/audio-bus-selftest.mjs && node tools/music-selftest.mjs`
Expected: tous passent. `music-selftest` doit rester vert : `DUCK.ritual` est **conservé** (voir spec), seul son appelant a disparu.

- [ ] **Step 6: Commit**

```bash
git add sim/tools/ui-audio-model.mjs sim/src/ui-audio.js sim/src/audio-bus.js sim/tools/ui-audio-selftest.mjs sim/tools/ui-audio-render-selftest.mjs
git commit -m "refactor(audio): RITUAL sort du vocabulaire des huit événements (#33)"
```

---

### Task 7: CSS et Bible §19

**Files:**
- Modify: `sim/src/style.css` (supprimer l. 1261-1342, le bloc `.ritual*`)
- Modify: `sim/tools/palette-selftest.mjs` (l. 33 `EVENT_SELECTORS`)

**Interfaces:**
- Consomme : rien.
- Produit : `.intro` est le seul sélecteur portant `--cyan / --magenta / --violet / --electric`.

- [ ] **Step 1: Mettre le garde-fou à jour, le voir passer ou échouer**

Dans `sim/tools/palette-selftest.mjs:33` :

```javascript
const EVENT_SELECTORS = ['.intro'];
```

Run: `node tools/palette-selftest.mjs`
Expected: FAIL — le bloc `.ritual` est encore dans la feuille et utilise les tokens réservés.

- [ ] **Step 2: Supprimer le bloc CSS**

Supprimer `sim/src/style.css` l. 1261-1342 en entier (du commentaire `/* ---------- Rituel CONTROL VECTOR (PHASE 10) ---------- */` jusqu'à la fin de `.ritual-shake`). **Garder** `.hack-log-armed` et `.intro-burst--*`, qui portent les mêmes couleurs pour le cracktro.

- [ ] **Step 3: Vérifier**

Run: `node tools/palette-selftest.mjs && node tools/settings-render-selftest.mjs`
Expected: passent.

- [ ] **Step 4: Commit**

```bash
git add sim/src/style.css sim/tools/palette-selftest.mjs
git commit -m "refactor(css): le bloc du rituel part, l'intro garde les quatre couleurs (#33)"
```

---

### Task 8: Documentation, CHANGELOG, et la chaîne complète

Dernière tâche : c'est ici, et seulement ici, que `npm run selftest:ci` tourne.

**Files:**
- Modify: `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md`
- Modify: `sim/docs/FPVThePlanet! — Roadmap d'implémentation DA - UX.md`
- Modify: `sim/HANDOFF.md`
- Modify: `docs/manuel.md`
- Modify: `sim/docs/architecture-diagrams.md`, `sim/docs/fpv-rework-architecture.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bible**

Supprimer §14 (l. 597-643), §18 (l. 735-777) et §36 (l. 1497-1529). Recentrer §19 (l. 779-808) sur l'intro : les quatre couleurs de demo scene n'ont plus qu'un porteur, et la règle doit le dire au lieu de décrire un moment qui n'existe plus. Réécrire les onze renvois ponctuels : §17 l. 718, §26 l. 1124, §30 l. 1268, §31 l. 1318, §32 l. 1346, §33 l. 1370 et 1385, §34 l. 1415 et 1465, §46 l. 1793 et 1813. Mettre la table des matières (l. 16-17) à jour.

Ajouter dans §15 une note de révision datée, sur le modèle de celle qu'a laissée l'issue #49, expliquant que le hack se termine par `[ JACK IN ]` et pourquoi le rituel est parti.

- [ ] **Step 2: Roadmap**

Réécrire PHASE 10 (l. 672-731) : la phase devient le retrait, pas la construction. Mettre à jour les treize renvois : l. 41, 172-186, 193, 216, 663-668, 847, 1118-1124, 1221, 1352, 1396, 1495, 1516, 1531.

- [ ] **Step 3: HANDOFF**

Supprimer le bloc PHASE 10 (l. 201-236). Réécrire le bloc PHASE 20 (l. 638-705) et la section des primitives partagées (l. 1660-1673) pour ne plus parler que de l'intro. Mettre à jour les mentions ponctuelles : l. 472, 1041, 1047, 1092, 1328, 1399, 1579, 1971, 2072-2085, 2849, 2884-2885, 2900, 2907, 2924-2955.

- [ ] **Step 4: `docs/manuel.md`**

Réécrire l. 838-847 — **le passage était déjà périmé**, il décrit l'état d'avant la PHASE 10 et annonce le rituel comme à venir. Il devient la description de l'état réel : le hack s'arrête sur `MANUAL OVERRIDE REQUIRED` et un bouton `[ JACK IN ]`, avec `[ESC] ABORT` pour abandonner. Mettre à jour l. 347 et 596.

- [ ] **Step 5: Diagrammes et audit**

`sim/docs/architecture-diagrams.md` l. 24 et 194 ; `sim/docs/fpv-rework-architecture.md` l. 75, 155, 285, 296.

- [ ] **Step 6: CHANGELOG**

Ajouter sous `## [Non publié]` → `### Retiré` (créer la rubrique si absente) une entrée expliquant le retrait, ce qui le remplace, et le passage du schéma opérateur en v3.

- [ ] **Step 7: La chaîne complète, une seule fois**

Run: `npm run selftest:ci`
Expected: exit 0. Un bloc `Failed to scan for dependencies` d'esbuild en fin de `vite-adapter-selftest` est du bruit connu (issue #51), pas un échec.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 8: Vérification manuelle**

Lancer `npm run dev`, ouvrir `?scene=<slug>&hack=gnss-spoof`. Le hack doit dérouler ses étapes et s'arrêter sur un bouton `JACK IN` avec `[ESC] ABORT` — pas sur un écran mort. Échap doit revenir en arrière. Noter le résultat dans le commit.

Si aucune scène n'est installée sur la machine, le noter explicitement plutôt que de prétendre l'avoir vérifié.

- [ ] **Step 9: Commit et PR**

```bash
git add -A
git commit -m "docs: le CONTROL VECTOR sort de la Bible, de la roadmap et du manuel (#33)"
git push -u origin worktree-retrait-control-vector
gh pr create --base main --title "Retrait du CONTROL VECTOR : le hack se termine par [ JACK IN ] (#33)"
```

---

## Self-review

**Couverture du spec :** `hack.js`/`[ JACK IN ]` → tâche 1 ; fichiers dédiés et renommages → tâche 2 ; bootstrap → tâche 3 ; terminal et briefing → tâche 4 ; schéma et serveur → tâche 5 ; audio → tâche 6 ; CSS et §19 → tâche 7 ; documentation → tâche 8. Le « ce qui n'est pas fait ici » du spec (renommage de `RITUAL_PRIMITIVES`, retrait de `DUCK.ritual`) est explicitement laissé de côté en tâches 2 et 6.

**Placeholders :** aucun « TBD », aucun « gérer les cas limites ». Chaque étape de code porte le code.

**Cohérence des types :** `runHack` résout `{ aborted: true }` (tâche 1, produit) et c'est ce que testent les sites d'appel de `main.js` (tâche 1, étape 5) et le selftest de rendu. `SCHEMA_VERSION === 3` est produit en tâche 5 et vérifié dans la même tâche. `UI_EVENTS` à sept entrées est produit en tâche 6 et sa valeur exacte est écrite dans les deux endroits qui la nomment.
