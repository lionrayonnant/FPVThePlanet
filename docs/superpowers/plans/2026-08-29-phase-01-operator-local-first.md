# PHASE 01 — Operator / état local-first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Au premier lancement, FPVTP! inspecte l'environnement navigateur, fait créer un `OPERATOR NAME` et un `CONTROL VECTOR`, persiste l'état côté serveur, et retrouve l'opérateur aux lancements suivants — y compris après un vidage du cache navigateur.

**Architecture:** Un fichier JSON par opérateur dans `sim/operator-state/`, servi par un nouveau groupe de routes `/__operator` greffé sur le middleware connect de Vite (`tools/map-api-plugin.mjs`, dev-only). Un module client `src/operator.js` (sans DOM) résout l'opérateur actif via un pointeur `localStorage` + repli sur la liste serveur, et écrit en différé. Deux modules d'écran jetables (`src/bootstrap.js`, `src/home.js`) montés dans `#ui`. `src/main.js` insère `loadOperator() → bootstrap()/select → home()` avant le flux de boot existant.

**Tech Stack:** Node ESM (pas de dépendance serveur, on réutilise le connect de Vite), `fs` sync + `renameSync` pour l'atomicité, Three.js/Vite côté client, `fetch` + `localStorage`, DOM vanilla. Aucune lib de test : scripts `node` autonomes avec `node:assert`.

**Spec:** `docs/superpowers/specs/2026-08-29-phase-01-operator-local-first-design.md`

## Global Constraints

- **D5 — anglais** : toute chaîne visible par le joueur est en anglais, grammaire DOS/Unix. Les commentaires de code, commits, docs restent en français.
- **D6 — moteur intouchable** : aucun de `quad.js`, `flightController.js`, `physics.js`, `wind.js`, `rain.js`, `rainfall.js`, `fog.js`, `link.js`, `lens.js`, `audio.js`, `loader.js`, `worker.js`, `TileMaterial.js`, `prep.mjs` n'est modifié. `hud.js` est appelé tel quel, pas modifié.
- `npm run selftest` (depuis `sim/`) doit rester vert à la fin de chaque tâche.
- `schemaVersion` de l'état opérateur = **1**. Jetons du Control Vector = exactement `"up"`, `"right"`, `"down"`, `"left"`. Longueur du vector : entier 4 à 8 inclus, défaut 6.
- `id` opérateur : `^[a-z0-9]+(-[a-z0-9]+)*$`, validé sur chaque route serveur qui le reçoit. Le `name` n'entre jamais dans un chemin de fichier.
- Nom d'opérateur : trimé, non vide, `≤ 24` caractères, `slugify(name)` non vide.
- Les modules d'écran montent leurs nœuds en **append** dans `#ui` et les retirent à la résolution. Ils ne touchent jamais `#ui.innerHTML` (le `Hud` a déjà construit son DOM dedans).
- Tout `localStorage` : clé `fpvmaps.operatorId`, accès enveloppé dans `try/catch`.
- Commits fréquents, un par tâche minimum. Messages de commit en français, terminés par la ligne `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

**Nouveaux fichiers**

| Fichier | Responsabilité |
|---|---|
| `sim/tools/operator-store.mjs` | Logique pure de l'état : `SCHEMA_VERSION`, `slugify`, `freshState`, `migrate`, `validateName`, `validateControlVector`, `newId`. Aucune E/S. Importé par le plugin **et** par le selftest. |
| `sim/tools/operator-selftest.mjs` | Script `node` autonome : teste `operator-store.mjs`. |
| `sim/src/operator.js` | Client : `loadOperator`, `createOperator`, `selectOperator`, `getOperator`, `patch`, `flush`, `ensureDevOperator`. Cache mémoire, écriture différée. Pas de DOM. |
| `sim/src/operator.selftest.mjs` | Script `node` autonome : teste la logique de recall de `loadOperator` avec `fetch`/`localStorage` stubbés. |
| `sim/src/bootstrap.js` | Écran plein cadre : hardware discovery → operator name → control vector → registered. Exporte `bootstrap(root, operatorApi)` et `captureControlVector(root, initial)`. |
| `sim/src/home.js` | Écrans jetables (PHASE 02 les supprime) : `operatorSelect(root, choices)`, `home(root, operatorApi)`. |

**Fichiers modifiés**

| Fichier | Modification |
|---|---|
| `sim/tools/map-api-plugin.mjs` | Groupe de routes `/__operator` + helpers d'E/S disque atomiques. |
| `sim/src/main.js` | `chooseScene()` → séquence `loadOperator → bootstrap/select → home` ; `audio.start()` déplacé. |
| `sim/src/style.css` | Bloc `#bootstrap` (écrans opérateur). |
| `sim/.gitignore` | `operator-state/`. |

---

## Task 1: Logique pure de l'état opérateur + selftest

**Files:**
- Create: `sim/tools/operator-store.mjs`
- Create: `sim/tools/operator-selftest.mjs`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `SCHEMA_VERSION` : `number` (= 1).
  - `slugify(s: string): string` — minuscules, `[a-z0-9]` + `-` de séparation, sans `-` en tête/queue, séquences de séparateurs compressées.
  - `newId(name: string): string` — `slugify(name)` + `'-'` + 4 hex aléatoires. Si `slugify(name)` est vide, lève `Error('nom inutilisable')`.
  - `validateName(raw: unknown): string` — renvoie le nom trimé si valide, sinon lève `Error` avec un des messages exacts `NAME REQUIRED` / `NAME TOO LONG` / `NAME UNUSABLE`.
  - `validateControlVector(v: unknown): string[]` — renvoie `v` si c'est un tableau de 4–8 chaînes toutes dans `{up,right,down,left}`, sinon lève `Error('control vector invalide')`.
  - `freshState({ id, name }): object` — objet d'état complet, `schemaVersion: SCHEMA_VERSION`, `createdAt` ISO, `controlVector: []`, `settings: {}`, `terrainCache: []`, `sessions: []`, `targetLog: []`, `worldState: {}`.
  - `migrate(state: object): object` — si `schemaVersion` absent ou `< SCHEMA_VERSION` : renvoie une copie normalisée (toutes les clés de `freshState` présentes, valeurs existantes conservées, `schemaVersion` porté à `SCHEMA_VERSION`). Si `schemaVersion === SCHEMA_VERSION` : renvoie une copie normalisée aussi (clés manquantes comblées). Si `schemaVersion > SCHEMA_VERSION` : lève `Error('schemaVersion trop récent')`.

- [ ] **Step 1: Écrire le selftest (échoue car le module n'existe pas)**

Create `sim/tools/operator-selftest.mjs` :

```js
// Selftest de la logique pure de l'état opérateur. Aucune E/S disque.
// Lancer : node tools/operator-selftest.mjs
import assert from 'node:assert/strict';
import {
	SCHEMA_VERSION, slugify, newId, validateName,
	validateControlVector, freshState, migrate,
} from './operator-store.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('slugify normalise', () => {
	assert.equal(slugify('NEO'), 'neo');
	assert.equal(slugify('  Agent Vex 7 !! '), 'agent-vex-7');
	assert.equal(slugify('***'), '');
});

t('newId ajoute un suffixe hex', () => {
	const id = newId('Neo');
	assert.match(id, /^neo-[0-9a-f]{4}$/);
	assert.throws(() => newId('***'), /inutilisable/);
});

t('validateName', () => {
	assert.equal(validateName('  Neo  '), 'Neo');
	assert.throws(() => validateName(''), /NAME REQUIRED/);
	assert.throws(() => validateName('   '), /NAME REQUIRED/);
	assert.throws(() => validateName('x'.repeat(25)), /NAME TOO LONG/);
	assert.throws(() => validateName('***'), /NAME UNUSABLE/);
});

t('validateControlVector', () => {
	assert.deepEqual(
		validateControlVector(['up', 'right', 'down', 'left', 'up', 'left']),
		['up', 'right', 'down', 'left', 'up', 'left'],
	);
	assert.throws(() => validateControlVector(['up', 'up', 'up']), /invalide/);       // trop court
	assert.throws(() => validateControlVector(new Array(9).fill('up')), /invalide/);  // trop long
	assert.throws(() => validateControlVector(['up', 'north', 'up', 'up']), /invalide/);
	assert.throws(() => validateControlVector('uuuu'), /invalide/);
});

t('freshState est complet', () => {
	const s = freshState({ id: 'neo-1a2b', name: 'Neo' });
	assert.equal(s.schemaVersion, SCHEMA_VERSION);
	assert.equal(s.id, 'neo-1a2b');
	assert.equal(s.name, 'Neo');
	assert.deepEqual(s.controlVector, []);
	assert.deepEqual(s.settings, {});
	assert.deepEqual(s.terrainCache, []);
	assert.deepEqual(s.sessions, []);
	assert.deepEqual(s.targetLog, []);
	assert.deepEqual(s.worldState, {});
	assert.ok(!Number.isNaN(Date.parse(s.createdAt)));
});

t('migrate comble les clés manquantes', () => {
	const m = migrate({ id: 'x-1', name: 'X', controlVector: ['up', 'up', 'up', 'up'] });
	assert.equal(m.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(m.controlVector, ['up', 'up', 'up', 'up']);
	assert.deepEqual(m.sessions, []);
	assert.deepEqual(m.worldState, {});
});

t('migrate refuse une version future', () => {
	assert.throws(() => migrate({ schemaVersion: 99, id: 'x-1', name: 'X' }), /trop récent/);
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `cd sim && node tools/operator-selftest.mjs`
Expected: FAIL — `Cannot find module './operator-store.mjs'`.

- [ ] **Step 3: Écrire `operator-store.mjs`**

Create `sim/tools/operator-store.mjs` :

```js
// Logique pure de l'état opérateur (PHASE 01). Aucune E/S : importable
// aussi bien par le plugin de dev que par le selftest.
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;

export function slugify(s) {
	return String(s ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function newId(name) {
	const base = slugify(name);
	if (!base) throw new Error('nom inutilisable');
	return `${base}-${randomBytes(2).toString('hex')}`;
}

export function validateName(raw) {
	const name = String(raw ?? '').trim();
	if (!name) throw new Error('NAME REQUIRED');
	if (name.length > 24) throw new Error('NAME TOO LONG');
	if (!slugify(name)) throw new Error('NAME UNUSABLE');
	return name;
}

const DIRS = new Set(['up', 'right', 'down', 'left']);

export function validateControlVector(v) {
	if (!Array.isArray(v) || v.length < 4 || v.length > 8 || !v.every((d) => DIRS.has(d))) {
		throw new Error('control vector invalide');
	}
	return v;
}

export function freshState({ id, name }) {
	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		name,
		createdAt: new Date().toISOString(),
		controlVector: [],
		settings: {},
		terrainCache: [],
		sessions: [],
		targetLog: [],
		worldState: {},
	};
}

export function migrate(state) {
	const v = state?.schemaVersion ?? 0;
	if (v > SCHEMA_VERSION) throw new Error('schemaVersion trop récent');
	// v absent / 0 / 1 : on normalise vers la forme courante sans rien perdre.
	const base = freshState({ id: state.id, name: state.name });
	return {
		...base,
		...state,
		schemaVersion: SCHEMA_VERSION,
		createdAt: state.createdAt ?? base.createdAt,
	};
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `cd sim && node tools/operator-selftest.mjs`
Expected: PASS — `8 tests OK`.

- [ ] **Step 5: `npm run selftest` toujours vert**

Run: `cd sim && npm run selftest`
Expected: se termine sans erreur (comportement identique à avant — rien du moteur n'a changé).

- [ ] **Step 6: Commit**

```bash
git add sim/tools/operator-store.mjs sim/tools/operator-selftest.mjs
git commit -m "PHASE 01 — état opérateur : schéma, validation, migration (logique pure)" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Routes serveur `/__operator`

**Files:**
- Modify: `sim/tools/map-api-plugin.mjs`
- Modify: `sim/.gitignore`
- Test: extension de `sim/tools/operator-selftest.mjs` (E/S disque réelle dans un tmpdir)

**Interfaces:**
- Consumes: `operator-store.mjs` (Task 1) — `SCHEMA_VERSION`, `newId`, `validateName`, `validateControlVector`, `freshState`, `migrate`.
- Produces (routes HTTP, base `/__operator`, servies uniquement sous `npm run dev`) :
  - `GET /__operator` → `200 { operators: [{ id, name, createdAt, counts: { areas, sessions, targets } }] }` (tri par `createdAt` croissant).
  - `POST /__operator` `{ name }` → `201 { operator }` · `400 { error }` si nom invalide (message = message de `validateName`).
  - `GET /__operator/<id>` → `200 { operator }` · `404 { error }` si absent · `400` si `id` malformé · `409 { error }` si `migrate` refuse (version future).
  - `PATCH /__operator/<id>` `{ key, value }` → `200 { operator }` · `400` si `key` hors liste blanche `['controlVector','settings']`, si `value` de `controlVector` invalide, ou si `id` malformé · `404` si absent.
- Produces (exports du module, pour le selftest) : `_operatorStoreDir` (fonction renvoyant le chemin du répertoire, dérivée d'une constante `OPERATOR_DIR`), `_readOperator(id)`, `_writeOperator(state)`, `_listOperators()`. Préfixe `_` = surface de test, pas d'API publique.

- [ ] **Step 1: Ajouter les tests d'E/S disque au selftest**

Append to `sim/tools/operator-selftest.mjs`, avant la ligne `console.log(\`\n${n} tests OK\`)` :

```js
// --- E/S disque : on pointe le store sur un tmpdir jetable ---
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'op-store-'));
process.env.FPV_OPERATOR_DIR = tmp;                       // lu par map-api-plugin
const store = await import('./map-api-plugin.mjs');

t('write + read round-trip', () => {
	const s = freshState({ id: 'neo-aaaa', name: 'Neo' });
	store._writeOperator(s);
	const back = store._readOperator('neo-aaaa');
	assert.equal(back.name, 'Neo');
	assert.equal(back.schemaVersion, SCHEMA_VERSION);
});

t('read inconnu renvoie null', () => {
	assert.equal(store._readOperator('nope-0000'), null);
});

t('read migre un fichier v0 sur disque', () => {
	store._writeOperator({ id: 'old-bbbb', name: 'Old', controlVector: ['up', 'up', 'up', 'up'] });
	const back = store._readOperator('old-bbbb');
	assert.equal(back.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(back.sessions, []);
});

t('list trie par createdAt', () => {
	const a = freshState({ id: 'a-0001', name: 'A' }); a.createdAt = '2020-01-01T00:00:00.000Z';
	const b = freshState({ id: 'b-0002', name: 'B' }); b.createdAt = '2021-01-01T00:00:00.000Z';
	store._writeOperator(b); store._writeOperator(a);
	const ids = store._listOperators().map((o) => o.id);
	assert.ok(ids.indexOf('a-0001') < ids.indexOf('b-0002'));
});

rmSync(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `cd sim && node tools/operator-selftest.mjs`
Expected: FAIL — `store._writeOperator is not a function` (les exports `_*` n'existent pas encore).

- [ ] **Step 3: Ajouter le store disque + les routes dans `map-api-plugin.mjs`**

Dans `sim/tools/map-api-plugin.mjs` :

3a. Ajouter aux imports en tête de fichier :

```js
import os from 'node:os';
import {
	SCHEMA_VERSION, newId, validateName, validateControlVector,
	freshState, migrate,
} from './operator-store.mjs';
```

3b. Après la ligne `const BASE = '/__map-api';`, ajouter :

```js
const OP_BASE = '/__operator';

// Répertoire de l'état opérateur : sibling de public/scenes/, hors bundle,
// gitignored. FPV_OPERATOR_DIR permet au selftest de le rediriger.
const OPERATOR_DIR = process.env.FPV_OPERATOR_DIR
	|| path.resolve(SCENES_DIR, '..', '..', 'operator-state');

function ensureOperatorDir() {
	fs.mkdirSync(OPERATOR_DIR, { recursive: true });
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function _readOperator(id) {
	if (!ID_RE.test(id)) throw new Error('id invalide');
	const file = path.join(OPERATOR_DIR, `${id}.json`);
	if (!fs.existsSync(file)) return null;
	return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function _writeOperator(state) {
	if (!ID_RE.test(state.id)) throw new Error('id invalide');
	ensureOperatorDir();
	const file = path.join(OPERATOR_DIR, `${state.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	return state;
}

function _listOperators() {
	ensureOperatorDir();
	return fs.readdirSync(OPERATOR_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			try { return migrate(JSON.parse(fs.readFileSync(path.join(OPERATOR_DIR, f), 'utf8'))); }
			catch { return null; }
		})
		.filter(Boolean)
		.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function operatorSummary(s) {
	return {
		id: s.id, name: s.name, createdAt: s.createdAt,
		counts: {
			areas: s.terrainCache.length,
			sessions: s.sessions.length,
			targets: s.targetLog.length,
		},
	};
}

const OP_WRITABLE_KEYS = new Set(['controlVector', 'settings']);
```

3c. Ajouter un tableau `opRoutes` (même forme `[method, regex, handler]` que `routes`) :

```js
const opRoutes = [
	['GET', /^\/$/, async (req, res) => {
		json(res, 200, { operators: _listOperators().map(operatorSummary) });
	}],

	['POST', /^\/$/, async (req, res) => {
		const b = await readBody(req);
		let name;
		try { name = validateName(b.name); }
		catch (e) { return json(res, 400, { error: e.message }); }
		const state = freshState({ id: newId(name), name });
		_writeOperator(state);
		json(res, 201, { operator: state });
	}],

	['GET', /^\/([^/]+)$/, async (req, res, [id]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, e.message === 'id invalide' ? 400 : 409, { error: e.message });
		}
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		json(res, 200, { operator: state });
	}],

	['PATCH', /^\/([^/]+)$/, async (req, res, [id]) => {
		const b = await readBody(req);
		if (!OP_WRITABLE_KEYS.has(b.key)) {
			return json(res, 400, { error: `clé non modifiable : ${b.key}` });
		}
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, e.message === 'id invalide' ? 400 : 409, { error: e.message });
		}
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		let value = b.value;
		if (b.key === 'controlVector') {
			try { value = validateControlVector(value); }
			catch (e) { return json(res, 400, { error: e.message }); }
		}
		state[b.key] = value;
		_writeOperator(state);
		json(res, 200, { operator: state });
	}],
];
```

3d. Dans `configureServer(server)`, la fonction `server.middlewares.use(async (req, res, next) => { ... })` : au tout début, ajouter un branchement `OP_BASE` **avant** le `if (!req.url?.startsWith(BASE)) return next();` :

```js
if (req.url?.startsWith(OP_BASE)) {
	const url = new URL(req.url, 'http://localhost');
	const p = url.pathname.slice(OP_BASE.length) || '/';
	const onPath = opRoutes.filter(([, re]) => re.test(p));
	if (!onPath.length) return json(res, 404, { error: `route inconnue : ${p}` });
	const route = onPath.find(([method]) => method === req.method);
	if (!route) return json(res, 405, { error: `${req.method} non supporté sur ${p}`, allow: onPath.map(([m]) => m) });
	try {
		return await route[2](req, res, route[1].exec(p).slice(1), url);
	} catch (e) {
		server.config.logger.error(`[operator] ${p}: ${e.stack ?? e.message}`);
		return json(res, 400, { error: e.message });
	}
}
```

3e. En bas du fichier, à côté de `export { FLYOVER_ROOT };`, ajouter :

```js
export { _readOperator, _writeOperator, _listOperators, OPERATOR_DIR };
```

- [ ] **Step 4: Lancer le selftest, vérifier le succès**

Run: `cd sim && node tools/operator-selftest.mjs`
Expected: PASS — `12 tests OK`.

- [ ] **Step 5: Test HTTP manuel bout-en-bout**

```bash
cd sim && npm run dev &
sleep 3
curl -s localhost:5173/__operator
curl -s -XPOST localhost:5173/__operator -H 'content-type: application/json' -d '{"name":"Neo"}'
curl -s -XPOST localhost:5173/__operator -H 'content-type: application/json' -d '{"name":""}'      # -> 400 NAME REQUIRED
ID=$(curl -s localhost:5173/__operator | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).operators[0].id))')
curl -s -XPATCH localhost:5173/__operator/$ID -H 'content-type: application/json' -d '{"key":"controlVector","value":["up","right","down","left","up","left"]}'
curl -s -XPATCH localhost:5173/__operator/$ID -H 'content-type: application/json' -d '{"key":"sessions","value":[]}'   # -> 400 clé non modifiable
curl -s localhost:5173/__operator/$ID
ls operator-state/
kill %1
```
Expected: la création renvoie `201` avec un `operator`, le nom vide renvoie `400 {"error":"NAME REQUIRED"}`, le PATCH `controlVector` réussit, le PATCH `sessions` renvoie `400`, `operator-state/<id>.json` existe. **Supprimer `operator-state/` après le test** (`rm -rf operator-state`).

- [ ] **Step 6: gitignore**

Add to `sim/.gitignore` (nouvelle ligne) :

```
operator-state/
```

- [ ] **Step 7: Commit**

```bash
git add sim/tools/map-api-plugin.mjs sim/tools/operator-selftest.mjs sim/.gitignore
git commit -m "PHASE 01 — routes serveur /__operator : CRUD, écriture atomique, un fichier par opérateur" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Client `src/operator.js`

**Files:**
- Create: `sim/src/operator.js`
- Create: `sim/src/operator.selftest.mjs`

**Interfaces:**
- Consumes: routes `/__operator` (Task 2).
- Produces (exports de `src/operator.js`) :
  - `async loadOperator(): Promise<{ operator: object|null, needsBootstrap: boolean, choices: Array<{id,name}>|null }>` — résout l'opérateur actif :
    1. lit `localStorage['fpvmaps.operatorId']` ; si présent → `GET /__operator/<id>` ; 200 → `{ operator, needsBootstrap:false, choices:null }` ; 404 → efface la clé, continue en 2.
    2. `GET /__operator` : 0 → `{ operator:null, needsBootstrap:true, choices:null }` ; 1 → adopte (stocke l'id, refait le GET détaillé) → `{ operator, needsBootstrap:false, choices:null }` ; ≥2 → `{ operator:null, needsBootstrap:false, choices:[{id,name},...] }`.
  - `async createOperator(name: string): Promise<object>` — `POST /__operator` ; au succès stocke `fpvmaps.operatorId`, met le cache, renvoie l'état. Sur `400` lève `Error(payload.error)`.
  - `async selectOperator(id: string): Promise<object>` — `GET /__operator/<id>` ; stocke l'id, met le cache, renvoie l'état.
  - `getOperator(): object|null` — l'état en cache (synchrone).
  - `patch(key: 'controlVector'|'settings', value: any): void` — met le cache à jour tout de suite, planifie un `PATCH` différé de ~500 ms coalescé par clé.
  - `async flush(): Promise<void>` — envoie immédiatement les patchs en attente.
  - `async ensureDevOperator(): Promise<object>` — si le cache est vide et `GET /__operator` est vide, `POST {name:'dev'}` ; sinon adopte le premier. Pour le chemin `?scene=`.
  - `_setFetch(fn)`, `_setStore(obj)` — injection pour le selftest (défaut : `globalThis.fetch`, `globalThis.localStorage`).

- [ ] **Step 1: Écrire le selftest de la logique de recall**

Create `sim/src/operator.selftest.mjs` :

```js
// Selftest de la résolution d'opérateur (loadOperator) : fetch + localStorage stubbés.
// Lancer : node src/operator.selftest.mjs
import assert from 'node:assert/strict';
import * as op from './operator.js';

let n = 0;
const t = (name, fn) => fn().then(() => { n++; console.log(`  ok  ${name}`); });

function fakeStore(init = {}) {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
		_dump: () => Object.fromEntries(m),
	};
}

// routeur fetch minimal : table { 'METHOD path': () => [status, body] }
function fakeFetch(table) {
	return async (url, opts = {}) => {
		const method = opts.method ?? 'GET';
		const path = new URL(url, 'http://x').pathname;
		const key = `${method} ${path}`;
		const entry = table[key];
		if (!entry) throw new Error(`fetch non stubbé : ${key}`);
		const [status, body] = entry(opts);
		return { ok: status < 400, status, json: async () => body };
	};
}

await t('aucun opérateur → bootstrap', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'GET /__operator': () => [200, { operators: [] }] }));
	const r = await op.loadOperator();
	assert.deepEqual(r, { operator: null, needsBootstrap: true, choices: null });
});

await t('un opérateur → adopté', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'neo-1', name: 'Neo' }] }],
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator.id, 'neo-1');
	assert.equal(store.getItem('fpvmaps.operatorId'), 'neo-1');
});

await t('plusieurs opérateurs → choices', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({
		'GET /__operator': () => [200, { operators: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, false);
	assert.equal(r.operator, null);
	assert.deepEqual(r.choices, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
});

await t('id local valide → chargé direct', async () => {
	op._setStore(fakeStore({ 'fpvmaps.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: ['up', 'up', 'up', 'up'] } }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.operator.id, 'neo-1');
	assert.equal(op.getOperator().name, 'Neo');
});

await t('id local périmé (404) → repli sur la liste', async () => {
	const store = fakeStore({ 'fpvmaps.operatorId': 'ghost-9' });
	op._setStore(store);
	op._setFetch(fakeFetch({
		'GET /__operator/ghost-9': () => [404, { error: 'nope' }],
		'GET /__operator': () => [200, { operators: [] }],
	}));
	const r = await op.loadOperator();
	assert.equal(r.needsBootstrap, true);
	assert.equal(store.getItem('fpvmaps.operatorId'), null);
});

await t('createOperator stocke l’id et met le cache', async () => {
	const store = fakeStore();
	op._setStore(store);
	op._setFetch(fakeFetch({
		'POST /__operator': () => [201, { operator: { id: 'vex-2', name: 'Vex', controlVector: [] } }],
	}));
	const s = await op.createOperator('Vex');
	assert.equal(s.id, 'vex-2');
	assert.equal(store.getItem('fpvmaps.operatorId'), 'vex-2');
	assert.equal(op.getOperator().id, 'vex-2');
});

await t('createOperator propage l’erreur 400', async () => {
	op._setStore(fakeStore());
	op._setFetch(fakeFetch({ 'POST /__operator': () => [400, { error: 'NAME REQUIRED' }] }));
	await assert.rejects(() => op.createOperator(''), /NAME REQUIRED/);
});

await t('patch + flush envoie un PATCH coalescé', async () => {
	const calls = [];
	op._setStore(fakeStore({ 'fpvmaps.operatorId': 'neo-1' }));
	op._setFetch(fakeFetch({
		'GET /__operator/neo-1': () => [200, { operator: { id: 'neo-1', name: 'Neo', controlVector: [] } }],
		'PATCH /__operator/neo-1': (opts) => { calls.push(JSON.parse(opts.body)); return [200, { operator: {} }]; },
	}));
	await op.loadOperator();
	op.patch('controlVector', ['up', 'up', 'up', 'up']);
	op.patch('controlVector', ['down', 'down', 'down', 'down']);   // écrase le précédent
	await op.flush();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { key: 'controlVector', value: ['down', 'down', 'down', 'down'] });
	assert.deepEqual(op.getOperator().controlVector, ['down', 'down', 'down', 'down']);
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `cd sim && node src/operator.selftest.mjs`
Expected: FAIL — `Cannot find module './operator.js'`.

- [ ] **Step 3: Écrire `src/operator.js`**

Create `sim/src/operator.js` :

```js
// État opérateur, côté client. Aucun DOM.
//
// L'identité du client vit dans localStorage (fpvmaps.operatorId) et accompagne
// chaque requête : c'est ce qui permet à deux personnes de jouer en même temps
// sur le même serveur de dev. Le serveur ne décide jamais « qui tu es ».
// Repli quand la clé manque (navigateur neuf ou vidé) : 1 opérateur sur disque
// → on l'adopte ; plusieurs → l'appelant montre OPERATOR SELECT.

const OP_BASE = '/__operator';
const KEY = 'fpvmaps.operatorId';
const DEBOUNCE_MS = 500;

let _fetch = (...a) => globalThis.fetch(...a);
let _store = safeStore();
export function _setFetch(fn) { _fetch = fn; }
export function _setStore(obj) { _store = obj; }

function safeStore() {
	try {
		const s = globalThis.localStorage;
		s.getItem(KEY); // déclenche le throw en navigation privée verrouillée
		return s;
	} catch {
		const m = new Map();
		return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
	}
}

let cache = null;
const pending = new Map();        // key -> value en attente d'écriture
let timer = null;

async function req(method, path, body) {
	const res = await _fetch(OP_BASE + path, body === undefined ? { method } : {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = await res.json().catch(() => ({}));
	if (!res.ok) { const e = new Error(payload.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
	return payload;
}

export function getOperator() { return cache; }

export async function loadOperator() {
	const id = _store.getItem(KEY);
	if (id) {
		try {
			cache = (await req('GET', `/${id}`)).operator;
			return { operator: cache, needsBootstrap: false, choices: null };
		} catch (e) {
			if (e.status !== 404) throw e;
			_store.removeItem(KEY);
		}
	}
	const { operators } = await req('GET', '');
	if (operators.length === 0) return { operator: null, needsBootstrap: true, choices: null };
	if (operators.length === 1) {
		return { operator: await selectOperator(operators[0].id), needsBootstrap: false, choices: null };
	}
	return { operator: null, needsBootstrap: false, choices: operators.map(({ id, name }) => ({ id, name })) };
}

export async function createOperator(name) {
	cache = (await req('POST', '', { name })).operator;
	_store.setItem(KEY, cache.id);
	return cache;
}

export async function selectOperator(id) {
	cache = (await req('GET', `/${id}`)).operator;
	_store.setItem(KEY, cache.id);
	return cache;
}

export function patch(key, value) {
	if (!cache) throw new Error('aucun opérateur chargé');
	cache[key] = value;
	pending.set(key, value);
	if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
}

export async function flush() {
	if (timer) { clearTimeout(timer); timer = null; }
	if (!cache || pending.size === 0) return;
	const entries = [...pending.entries()];
	pending.clear();
	for (const [key, value] of entries) {
		try { await req('PATCH', `/${cache.id}`, { key, value }); }
		catch (e) { console.warn('[operator] patch échoué, on retentera', e); pending.set(key, value); }
	}
}

export async function ensureDevOperator() {
	if (cache) return cache;
	const { operators } = await req('GET', '');
	return operators.length ? selectOperator(operators[0].id) : createOperator('dev');
}

if (typeof window !== 'undefined') {
	window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
	window.addEventListener('beforeunload', () => { flush(); });
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `cd sim && node src/operator.selftest.mjs`
Expected: PASS — `8 tests OK`.

- [ ] **Step 5: Commit**

```bash
git add sim/src/operator.js sim/src/operator.selftest.mjs
git commit -m "PHASE 01 — client operator.js : recall local-first, cache mémoire, écriture différée" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Écrans de bootstrapping `src/bootstrap.js` + styles

**Files:**
- Create: `sim/src/bootstrap.js`
- Modify: `sim/src/style.css`

**Interfaces:**
- Consumes: `src/operator.js` — `createOperator`, `patch`, `flush`, `getOperator`.
- Produces (exports de `src/bootstrap.js`) :
  - `async bootstrap(root: HTMLElement, api = operatorApi): Promise<object>` — monte le plein-cadre, enchaîne hardware discovery → operator name → control vector → registered, résout avec `getOperator()`. `api` injectable pour test manuel ; défaut = le module `operator.js`.
  - `async captureControlVector(root: HTMLElement, initialLength = 6): Promise<string[]>` — écrans « DEFINE CONTROL VECTOR » + « REGISTERED » seuls, renvoie le vecteur (déjà `patch`é et `flush`é par l'appelant, pas ici). Réutilisé par `home.js`.
  - `probeHardware(): Promise<Array<{ label: string, value: string }>>` — inventaire honnête (exporté pour inspection/debug).

- [ ] **Step 1: Écrire `src/bootstrap.js`**

Create `sim/src/bootstrap.js` :

```js
// Bootstrapping de l'opérateur (PHASE 01, Bible §12–14).
// Écrans plein cadre montés en APPEND dans #ui — jamais innerHTML, le HUD a
// déjà rempli ce conteneur. Tout le texte visible est en anglais (D5).
import * as operatorApi from './operator.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

// ---------- inventaire honnête (arch doc §4) ----------

async function measureRefreshHz() {
	return new Promise((resolve) => {
		const t = [];
		const tick = (now) => {
			t.push(now);
			if (t.length < 60) return requestAnimationFrame(tick);
			const deltas = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
			const median = deltas[deltas.length >> 1];
			resolve(median > 0 ? Math.round(1000 / median) : null);
		};
		requestAnimationFrame(tick);
	});
}

function gpuString() {
	try {
		const gl = document.createElement('canvas').getContext('webgl2')
			|| document.createElement('canvas').getContext('webgl');
		if (!gl) return { renderer: 'NONE', gpu: 'UNKNOWN' };
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
		const isGl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
		return { renderer: isGl2 ? 'WEBGL2' : 'WEBGL1', gpu: gpu || 'UNKNOWN' };
	} catch { return { renderer: 'UNKNOWN', gpu: 'UNKNOWN' }; }
}

function audioString() {
	try {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		const ac = new Ctx();
		const s = `${ac.sampleRate} HZ / ${ac.destination.maxChannelCount} CH`;
		ac.close();
		return s;
	} catch { return 'UNKNOWN'; }
}

async function storageString() {
	try {
		const { quota } = await navigator.storage.estimate();
		return quota ? `${(quota / 1e9).toFixed(1)} GB QUOTA` : 'UNKNOWN';
	} catch { return 'UNKNOWN'; }
}

async function terrainCacheString() {
	try {
		const r = await fetch('/__map-api/scenes');
		const { scenes } = await r.json();
		return scenes.length ? `${scenes.length} AREAS` : 'EMPTY';
	} catch { return 'UNKNOWN'; }
}

export async function probeHardware() {
	const ua = navigator.userAgentData;
	const platform = (ua?.platform || navigator.platform || 'UNKNOWN').toUpperCase();
	const brand = ua?.brands?.find((b) => !/Not.?A.?Brand/i.test(b.brand))?.brand
		|| (navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)/)?.[1])
		|| 'UNKNOWN';
	const hz = await measureRefreshHz();
	const { renderer, gpu } = gpuString();
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	return [
		{ label: 'PLATFORM', value: platform },
		{ label: 'BROWSER', value: String(brand).toUpperCase() },
		{ label: 'LANGUAGE', value: (navigator.language || 'UNKNOWN').toUpperCase() },
		{ label: 'TIMEZONE', value: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UNKNOWN').toUpperCase() },
		{ label: 'DISPLAY', value: `${screen.width} × ${screen.height} @ ${window.devicePixelRatio}x` },
		{ label: 'REFRESH', value: hz ? `${hz} HZ` : 'UNKNOWN' },
		{ label: 'RENDERER', value: renderer },
		{ label: 'GPU', value: String(gpu).toUpperCase() },
		{ label: 'CORES', value: String(navigator.hardwareConcurrency || 'UNKNOWN') },
		{ label: 'INPUT', value: pad ? `${pad.id.slice(0, 32).toUpperCase()} / ${pad.axes.length} AXES` : 'NO GAMEPAD' },
		{ label: 'AUDIO', value: audioString() },
		{ label: 'NETWORK', value: navigator.onLine ? 'ONLINE' : 'OFFLINE' },
		{ label: 'STORAGE', value: await storageString() },
		{ label: 'TERRAIN CACHE', value: await terrainCacheString() },
	];
}

// Commentaires de crew : câblés sur ce qui a été trouvé, 2 à 4 par run.
function crewNotes(rows) {
	const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	const out = [];
	const hz = parseInt(by.REFRESH, 10);
	if (hz >= 120) out.push('// root: ' + hz + 'hz', '// vex: acceptable');
	else if (hz) out.push('// root: ' + hz + 'hz', '// vex: we make do');
	if (by.INPUT === 'NO GAMEPAD') out.push('// root: no radio', '// vex: keyboard then');
	else out.push('// root: radio detected', '// vex: good');
	if (by.NETWORK === 'OFFLINE') out.push('// root: offline', '// vex: cache only');
	return out.slice(0, 4);
}

// ---------- montage d'écran ----------

function screen(root) {
	const el = document.createElement('div');
	el.className = 'bootstrap';
	el.innerHTML = '<div class="bootstrap-box"></div>';
	root.appendChild(el);
	return {
		box: el.querySelector('.bootstrap-box'),
		remove: () => el.remove(),
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function revealLines(box, lines, { interval = 40 } = {}) {
	const pre = document.createElement('pre');
	box.appendChild(pre);
	let skipped = false;
	const skip = () => { skipped = true; };
	window.addEventListener('keydown', skip, { once: true });
	box.addEventListener('click', skip, { once: true });
	for (const line of lines) {
		pre.textContent += (pre.textContent ? '\n' : '') + line;
		if (!skipped) await sleep(interval);
	}
	if (skipped) pre.textContent = lines.join('\n');
	window.removeEventListener('keydown', skip);
	return pre;
}

function dotted(label, value, width = 20) {
	return `${label} ${'.'.repeat(Math.max(3, width - label.length))} ${value}`;
}

// ---------- écran 1 : HARDWARE DISCOVERY ----------

async function hardwareScreen(root) {
	const s = screen(root);
	const rows = await probeHardware();
	const notes = crewNotes(rows);
	const lines = ['FPVTP! // 0.97b', '', 'OPERATOR BOOTSTRAPPING', ''];
	rows.forEach((r, i) => {
		lines.push(dotted(r.label, r.value));
		if (i === 5 && notes[0]) lines.push(notes[0], notes[1] ?? '');
		if (i === 9 && notes[2]) lines.push(notes[2], notes[3] ?? '');
	});
	lines.push('', 'INITIALIZATION...');
	await revealLines(s.box, lines.filter((l) => l !== undefined));
	await new Promise((resolve) => {
		const btn = button('CONTINUE', () => { s.remove(); resolve(); });
		s.box.appendChild(btn);
	});
}

function button(label, onClick) {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = `[ ${label} ]`;
	b.className = 'bootstrap-btn';
	b.onclick = onClick;
	return b;
}

// ---------- écran 2 : OPERATOR NAME ----------

async function nameScreen(root, api) {
	const s = screen(root);
	s.box.innerHTML = `
		<pre>OPERATOR NAME</pre>
		<input id="op-name" maxlength="24" autocomplete="off" spellcheck="false" placeholder="NEO">
		<div class="bootstrap-err" id="op-name-err"></div>`;
	const input = s.box.querySelector('#op-name');
	const err = s.box.querySelector('#op-name-err');
	input.focus();
	return new Promise((resolve) => {
		const submit = async () => {
			err.textContent = '';
			try {
				const state = await api.createOperator(input.value);
				s.remove();
				resolve(state);
			} catch (e) {
				err.textContent = e.message;
			}
		};
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		s.box.appendChild(button('REGISTER', submit));
	});
}

// ---------- écrans 3+4 : CONTROL VECTOR ----------

function readGamepadDir(prev) {
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	if (!pad) return null;
	const [x, y] = pad.axes;
	const b = pad.buttons;
	let dir = null;
	if (b[12]?.pressed || y < -0.5) dir = 'up';
	else if (b[13]?.pressed || y > 0.5) dir = 'down';
	else if (b[14]?.pressed || x < -0.5) dir = 'left';
	else if (b[15]?.pressed || x > 0.5) dir = 'right';
	return dir && dir !== prev ? dir : (dir ? '__hold' : null);
}

export async function captureControlVector(root, initialLength = 6) {
	const s = screen(root);
	let length = initialLength;
	let vec = [];

	const render = () => {
		s.box.innerHTML = `
			<pre>DEFINE CONTROL VECTOR

4-8 INPUTS
DEFAULT LENGTH: 6

THIS VECTOR WILL BE REQUIRED
FOR FUTURE TARGET ACQUISITIONS.
WRITE IT DOWN.</pre>
			<div class="bootstrap-row">LENGTH:
				<button type="button" data-d="-1">[ - ]</button> ${length}
				<button type="button" data-d="1">[ + ]</button></div>
			<pre class="bootstrap-vec">${
				vec.map((d) => ARROW[d]).concat(Array(length - vec.length).fill('_')).join(' ')
			}</pre>`;
		s.box.querySelectorAll('[data-d]').forEach((b) => {
			b.onclick = () => {
				length = Math.min(8, Math.max(4, length + Number(b.dataset.d)));
				vec = [];
				render();
			};
		});
		s.box.appendChild(button('DELETE', () => { vec = vec.slice(0, -1); render(); }));
		const confirm = button('CONFIRM VECTOR', () => finish());
		confirm.disabled = vec.length !== length;
		s.box.appendChild(confirm);
	};

	const add = (dir) => {
		if (vec.length >= length) return;
		vec.push(dir);
		render();
	};

	const onKey = (e) => {
		const map = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
		if (map[e.key]) { e.preventDefault(); add(map[e.key]); }
		if (e.key === 'Backspace') { vec = vec.slice(0, -1); render(); }
	};
	window.addEventListener('keydown', onKey);

	let padPrev = null;
	const padPoll = setInterval(() => {
		const d = readGamepadDir(padPrev);
		if (d === '__hold') return;
		if (d) { padPrev = d; add(d); } else { padPrev = null; }
	}, 80);

	render();

	return new Promise((resolve) => {
		function finish() {
			window.removeEventListener('keydown', onKey);
			clearInterval(padPoll);
			s.remove();
			resolve(vec.slice());
		}
	});
}

async function registeredScreen(root, vec) {
	const s = screen(root);
	s.box.innerHTML = `<pre>CONTROL VECTOR REGISTERED

${vec.map((d) => ARROW[d]).join(' ')}

KEEP THIS VECTOR.
YOU WILL NEED IT.</pre>`;
	return new Promise((resolve) => {
		s.box.appendChild(button('CONTINUE', () => { s.remove(); resolve(); }));
	});
}

// ---------- séquence complète ----------

export async function bootstrap(root, api = operatorApi) {
	await hardwareScreen(root);
	await nameScreen(root, api);
	const vec = await captureControlVector(root, 6);
	api.patch('controlVector', vec);
	await api.flush();
	await registeredScreen(root, vec);
	return api.getOperator();
}
```

- [ ] **Step 2: Ajouter les styles**

Append to `sim/src/style.css` :

```css
/* ---------- bootstrap / operator screens (PHASE 01) ---------- */

.bootstrap {
	position: fixed; inset: 0;
	display: grid; place-items: center;
	background: #0d1218;
	z-index: 11;
}
.bootstrap-box {
	width: min(560px, 86vw);
	display: flex; flex-direction: column; gap: 12px;
}
.bootstrap-box pre {
	margin: 0;
	white-space: pre-wrap;
	color: var(--ink);
}
.bootstrap-vec { font-size: 20px; letter-spacing: .12em; }
.bootstrap-row { display: flex; align-items: center; gap: 8px; }
.bootstrap-err { color: var(--accent); min-height: 1.4em; }
.bootstrap input {
	background: #0d1218; color: var(--ink);
	border: 1px solid rgba(255, 255, 255, .25);
	padding: 10px 12px; font: inherit; letter-spacing: .1em;
}
.bootstrap-btn, .bootstrap button {
	align-self: flex-start;
	padding: 10px 14px;
	background: transparent; color: var(--ink);
	border: 1px solid rgba(255, 255, 255, .25);
	font: inherit; cursor: pointer;
}
.bootstrap-btn:hover, .bootstrap button:hover:not(:disabled) {
	border-color: var(--accent); color: var(--accent);
}
.bootstrap button:disabled { opacity: .4; cursor: default; }
```

- [ ] **Step 3: Vérification manuelle dans le navigateur**

```bash
cd sim && rm -rf operator-state && npm run dev
```
Ouvrir `http://localhost:5173/?bootstrap=1` — mais le câblage `main.js` n'existe pas encore (Task 5). Vérifier au minimum que le module parse : dans la console DevTools de la page,

```js
const b = await import('/src/bootstrap.js');
console.table(await b.probeHardware());
```
Expected: un tableau de 14 lignes, valeurs plausibles, `GPU` renseigné ou `UNKNOWN`, aucune exception.

- [ ] **Step 4: Commit**

```bash
git add sim/src/bootstrap.js sim/src/style.css
git commit -m "PHASE 01 — écrans de bootstrapping : hardware discovery, operator name, control vector" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Home jetable + câblage `main.js`

**Files:**
- Create: `sim/src/home.js`
- Modify: `sim/src/main.js`

**Interfaces:**
- Consumes: `src/operator.js` (`loadOperator`, `selectOperator`, `getOperator`, `ensureDevOperator`, `patch`, `flush`), `src/bootstrap.js` (`bootstrap`, `captureControlVector`).
- Produces (exports de `src/home.js`) :
  - `async operatorSelect(root, choices: Array<{id,name}>): Promise<{ id: string }|{ create: true }>`.
  - `async home(root, api = operatorApi): Promise<void>` — résout au clic `[ FLY ]`.

- [ ] **Step 1: Écrire `src/home.js`**

Create `sim/src/home.js` :

```js
// Home minimale de l'opérateur (PHASE 01). JETABLE : PHASE 02 remplace ce
// fichier par l'Operator Terminal. Écrans montés en append dans #ui.
import * as operatorApi from './operator.js';
import { captureControlVector } from './bootstrap.js';

const ARROW = { up: '↑', right: '→', down: '↓', left: '←' };

function screen(root) {
	const el = document.createElement('div');
	el.className = 'bootstrap';
	el.innerHTML = '<div class="bootstrap-box"></div>';
	root.appendChild(el);
	return { box: el.querySelector('.bootstrap-box'), remove: () => el.remove() };
}

function button(label, onClick) {
	const b = document.createElement('button');
	b.type = 'button';
	b.textContent = `[ ${label} ]`;
	b.onclick = onClick;
	return b;
}

export async function operatorSelect(root, choices) {
	const s = screen(root);
	s.box.innerHTML = '<pre>OPERATOR SELECT</pre>';
	return new Promise((resolve) => {
		for (const c of choices) {
			s.box.appendChild(button(c.name.toUpperCase(), () => { s.remove(); resolve({ id: c.id }); }));
		}
		s.box.appendChild(button('+ NEW OPERATOR', () => { s.remove(); resolve({ create: true }); }));
	});
}

export async function home(root, api = operatorApi) {
	const s = screen(root);
	const render = () => {
		const op = api.getOperator();
		const vec = op.controlVector?.length
			? op.controlVector.map((d) => ARROW[d]).join(' ')
			: '(not set)';
		s.box.innerHTML = `<pre>OPERATOR // ${op.name.toUpperCase()}

CONTROL VECTOR   ${vec}</pre>`;
		s.box.appendChild(button('FLY', () => { s.remove(); done(); }));
		s.box.appendChild(button('CONTROL VECTOR', async () => {
			const v = await captureControlVector(root, op.controlVector?.length || 6);
			api.patch('controlVector', v);
			await api.flush();
			render();
		}));
		s.box.appendChild(button('SWITCH OPERATOR', async () => {
			const list = (await api.loadOperator()).choices
				|| [{ id: op.id, name: op.name }];
			const pick = await operatorSelect(root, list);
			if (pick.create) { const { bootstrap } = await import('./bootstrap.js'); await bootstrap(root); }
			else await api.selectOperator(pick.id);
			render();
		}));
		const foot = document.createElement('pre');
		foot.textContent = '\nFPVTP! // LOCAL INSTALLATION';
		foot.style.opacity = '.55';
		s.box.appendChild(foot);
	};
	return new Promise((resolve) => {
		function done() { resolve(); }
		render();
	});
}
```

- [ ] **Step 2: Câbler `main.js` — imports**

In `sim/src/main.js`, après la ligne d'import de `hud.js` (`import { Hud, ... } from './hud.js';`), ajouter :

```js
import * as operator from './operator.js';
import { bootstrap } from './bootstrap.js';
import { operatorSelect, home } from './home.js';
```

- [ ] **Step 3: Câbler `main.js` — remplacer `chooseScene()`**

Dans `sim/src/main.js`, remplacer la fonction `chooseScene()` (actuellement lignes ~615-624, celle qui fait `loadSceneList` + `hud.showMenu`) par :

```js
// Résout l'opérateur (bootstrapping au premier lancement), pose l'opérateur sur
// la Home, puis rend la main au choix de carte existant. ?scene=<slug> saute
// Home ET menu mais garde un opérateur en mémoire pour operator.getOperator().
async function chooseScene() {
	const ui = document.getElementById('ui');

	if (OPTS.scene) {
		await operator.ensureDevOperator();
	} else {
		const { operator: op, needsBootstrap, choices } = await operator.loadOperator();
		if (needsBootstrap) {
			await bootstrap(ui);
		} else if (choices) {
			const pick = await operatorSelect(ui, choices);
			if (pick.create) await bootstrap(ui);
			else await operator.selectOperator(pick.id);
		}
		await home(ui);            // résout au clic [ FLY ]
	}

	const scenes = await loadSceneList();
	if (scenes.length === 0) throw new Error('aucune carte : lance "npm run add-map" d’abord');
	if (OPTS.scene) {
		if (!scenes.some((s) => s.slug === OPTS.scene)) throw new Error(`carte inconnue: "${OPTS.scene}"`);
		return OPTS.scene;
	}
	return new Promise((resolve) => hud.showMenu(scenes, resolve));
}
```

- [ ] **Step 4: Câbler `main.js` — démarrage audio**

Dans `sim/src/main.js`, la chaîne `chooseScene().then((slug) => { audio.start(); setScene(slug); return boot(); })` :

- `audio.start()` reste dans ce `.then` : pour le flux normal, le clic `[ FLY ]` de la Home a déjà eu lieu (geste utilisateur), et pour `?scene=` le `.then` s'exécute sans geste — donc pour `?scene=` uniquement, ajouter un listener one-shot **avant** l'appel `chooseScene()` :

```js
// ?scene= saute Home et menu : aucun geste utilisateur n'a lieu avant boot().
// L'AudioContext exige un geste — on l'attrape au premier input.
if (OPTS.scene) {
	const kick = () => { audio.start(); };
	window.addEventListener('pointerdown', kick, { once: true });
	window.addEventListener('keydown', kick, { once: true });
}
```

Le `audio.start()` existant dans le `.then` reste (idempotent — vérifier dans `audio.js` que `start()` appelé deux fois ne casse rien ; si `EngineAudio.start` n'est pas idempotent, garder l'appel `.then` uniquement pour le cas non-`?scene=` : `if (!OPTS.scene) audio.start();`).

- [ ] **Step 5: Vérification manuelle — premier lancement complet**

```bash
cd sim && rm -rf operator-state && npm run dev
```
Naviguer sur `http://localhost:5173/`. Vérifier la séquence :
1. `OPERATOR BOOTSTRAPPING` + inventaire révélé ligne à ligne ; une touche saute au bout ; `[ CONTINUE ]`.
2. `OPERATOR NAME` : saisir vide → `NAME REQUIRED` ; saisir `Neo` → `REGISTER`.
3. `DEFINE CONTROL VECTOR` : changer la longueur, saisir 6 flèches au clavier, `[ DELETE ]` en retire une, `[ CONFIRM VECTOR ]` actif à 6/6.
4. `CONTROL VECTOR REGISTERED` avec les flèches → `[ CONTINUE ]`.
5. `OPERATOR // NEO` + control vector affiché → `[ FLY ]`.
6. Menu « Choisir une carte » habituel → la carte se charge et vole.
7. `ls operator-state/` → un `<id>.json` avec `controlVector` rempli.

- [ ] **Step 6: Vérification manuelle — relance & vidage cache**

- Recharger l'onglet → on arrive **directement** sur `OPERATOR // NEO`, pas de bootstrapping.
- DevTools → Application → Local Storage → supprimer `fpvmaps.operatorId` → recharger → toujours `OPERATOR // NEO` (1 seul opérateur sur disque, adopté).
- Créer un 2ᵉ opérateur via `[ SWITCH OPERATOR ] → + NEW OPERATOR`, nom `Vex`. Supprimer `fpvmaps.operatorId`, recharger → `OPERATOR SELECT` avec `NEO` et `VEX`.
- `?scene=<slug>` (un slug réel de `public/scenes.json`) → vol direct sans Home ni menu ; dans la console `(await import('/src/operator.js')).getOperator()` renvoie un opérateur non nul.

- [ ] **Step 7: `npm run selftest` + les deux selftests opérateur**

```bash
cd sim
npm run selftest
node tools/operator-selftest.mjs
node src/operator.selftest.mjs
```
Expected: les trois passent. Nettoyer : `rm -rf operator-state`.

- [ ] **Step 8: Commit**

```bash
git add sim/src/home.js sim/src/main.js
git commit -m "PHASE 01 — Home opérateur minimale + câblage du boot (bootstrapping → home → choix de carte)" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**

| Spec | Tâche |
|---|---|
| Décision A — état serveur, un fichier/opérateur, `sim/operator-state/`, routes `/__operator` | Task 2 |
| Décision B — pas de « dernier actif » serveur, id client en localStorage | Task 3 (`loadOperator`) |
| Décision C — 0/1/N opérateurs → bootstrap/adopt/select | Task 3 + Task 5 |
| Décision D — vector 4-way, 4–8, défaut 6, clavier + manette | Task 4 (`captureControlVector`, `readGamepadDir`) |
| Décision E — `home.js` jetable | Task 5 |
| Décision F — reveal complet sautable | Task 4 (`revealLines`) |
| Décision G — selftest vert, moteur intouché | Steps « npm run selftest » Tasks 1, 5 ; aucun module moteur dans la liste des fichiers |
| Décision H — anglais DOS/Unix | chaînes de Task 4 / Task 5 |
| §1 routes serveur + schéma + `migrate` | Task 1 (pur) + Task 2 (routes) |
| §2 client `operator.js` (loadOperator/create/select/get/patch/flush/ensureDev) | Task 3 |
| §3 bootstrapping 4 écrans + inventaire honnête §4 | Task 4 |
| §4 home minimale + operatorSelect | Task 5 |
| §5 câblage `main.js`, audio | Task 5 Steps 3–4 |
| §6 tests + scénario d'acceptation | Task 2 Step 5, Task 4 Step 3, Task 5 Steps 5–7 |
| §7 fichiers | conforme (plan ajoute `operator-store.mjs` pour isoler la logique pure — testable sans navigateur, sert D6) |
| §8 hors périmètre | rien de tout cela n'apparaît dans les tâches |

Écart assumé vs spec §7 : le plan **ne modifie pas `input.js`**. La capture manette lit `navigator.getGamepads()` directement dans `bootstrap.js` (seuil 0.5, d-pad `buttons[12..15]`), ce qui évite de toucher un module d'entrée de vol — plus sûr pour D6, un fichier de moins modifié.

**2. Placeholder scan** — aucun `TODO`/`TBD`/« handle edge cases ». Chaque step de code porte le code réel. Les steps de vérif navigateur listent les manips exactes et le résultat attendu.

**3. Type consistency** — `loadOperator` renvoie `{ operator, needsBootstrap, choices }` partout (Task 3 def, Task 5 conso). `patch(key, value)` / `flush()` cohérents Task 3 ↔ Task 4 ↔ Task 5. `captureControlVector(root, length)` → `string[]` cohérent Task 4 ↔ Task 5. Routes `_readOperator`/`_writeOperator`/`_listOperators` cohérentes Task 2 def ↔ selftest. Jetons `up/right/down/left` partout, `ARROW` map identique dans `bootstrap.js` et `home.js`.
