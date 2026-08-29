# Second fournisseur de plans 3D — Stages 1 & 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creuser les deux seams (fournisseur, décodeur) qui permettront de brancher un second fournisseur de photogrammétrie, et créditer les fournisseurs à l'écran — sans rien télécharger de neuf.

**Architecture:** Deux seams à deux étages distincts. Le seam *fournisseur* sort la connaissance d'Apple Flyover de `add-map-core.mjs` vers `lib/providers/flyover.mjs`, derrière un contrat `plan`/`probe`/`fetch`. Le seam *décodeur* sort le lecteur OBJ de `prep.mjs` vers `lib/decoders/obj.mjs`, derrière un contrat `sniff`/`decode`. Tout le rebuild de `prep.mjs` (rebase ENU, chunks, texture arrays, collision, spawn) reste strictement intouché.

**Tech Stack:** Node ESM, `node:assert/strict` (aucun framework de test), Vite, Three.js, sharp.

**Spec:** [docs/superpowers/specs/2026-08-29-second-fournisseur-3d-design.md](../specs/2026-08-29-second-fournisseur-3d-design.md)

## Global Constraints

- **Stages 1 et 2 ne téléchargent rien et n'ajoutent aucune dépendance.** Aucun accès réseau, aucune clé API. Le Stage 3 (Google) fait l'objet d'un plan séparé.
- **Le rebuild de `prep.mjs` ne change pas.** Rebase ECEF→ENU, chunking, texture arrays, mesh de collision, spawn : hors périmètre. Le `CLAUDE.md` l'interdit sans raison, et il n'y en a pas ici.
- **La surface publique de `add-map-core.mjs` doit rester intacte.** Ces symboles sont importés ailleurs et doivent continuer à s'importer depuis `./lib/add-map-core.mjs` : `addMap`, `planScan`, `probeCoverage`, `slugify`, `readScenes`, `writeScenes`, `dirSize`, `tileDirPath`, `tileDirName`, `parsePrepLine`, `Cancelled`, `SCENES_DIR`, `SCENES_JSON`, `FLYOVER_ROOT`. Consommateurs : `map-api-plugin.mjs`, `map-poly-selftest.mjs`, `scanner-selftest.mjs`, `gen-poly-fixture.mjs`, `add-map.mjs`.
- **`tileDirName()` est une clé de cache.** Sa sortie doit rester identique à l'octet près : si elle change, chaque scène déjà téléchargée est re-téléchargée. Elle doit aussi rester en phase avec les `fmt.Sprintf` de `cmd/export-obj/main.go` (`%f` = 6 décimales en Go).
- **Style de test de la maison :** `node:assert/strict`, un helper local `const t = (name, fn) => { fn(); n++; console.log(\`  ok  ${name}\`); };`, aucune E/S ni DOM, commentaires et noms de tests en français. Modèle : `sim/tools/rtc-selftest.mjs`.
- **Identifiant de fournisseur par défaut :** `'flyover'`. Libellé : `'Apple Flyover'`. Crédit par défaut : `['© Apple']`.
- **Version de manifest :** `2` aujourd'hui, `3` après la Task 3. Un manifest `version: 2` reste lisible sans re-préparation.
- Toutes les commandes se lancent depuis `sim/`.

---

## File Structure

**Créés :**
- `sim/tools/lib/run.mjs` — lancement de sous-processus avec relais de logs ligne à ligne + `Cancelled`. Extrait tel quel de `add-map-core.mjs`, partagé entre l'orchestrateur et les fournisseurs.
- `sim/tools/lib/providers/flyover.mjs` — tout ce que le pipeline sait d'Apple Flyover : chemins de cache, `plan`, `probe`, `fetch`, messages d'erreur de couverture.
- `sim/tools/lib/providers/index.mjs` — registre des fournisseurs ; `get(id)`, `DEFAULT_PROVIDER_ID`.
- `sim/tools/provider-selftest.mjs` — vérifie la forme du contrat et la stabilité de la clé de cache.
- `sim/src/provider-credit.js` — pur, importable navigateur *et* node : résout les lignes de crédit d'un manifest, y compris les manifests `version: 2` sans champ `provider`.
- `sim/tools/provider-credit-selftest.mjs` — tests de ce qui précède.
- `sim/tools/lib/decoders/obj.mjs` — le lecteur OBJ/MTL actuel, déplacé derrière `sniff`/`decode`.
- `sim/tools/lib/decoders/index.mjs` — sélection du décodeur par `sniff()`.

**Modifiés :**
- `sim/tools/lib/add-map-core.mjs` — ne garde que l'orchestration et `scenes.json` ; re-exporte la surface publique.
- `sim/tools/prep.mjs` — appelle le décodeur, écrit `provider` dans le manifest, passe en `version: 3`.
- `sim/src/fpvtp-osd.js` — coin `br` + `setCredit()`.
- `sim/src/style.css` — règle `#fpvtp-osd .br`.
- `sim/src/main.js` — câble le crédit après `loadManifest()`.
- `sim/package.json` — ajoute les deux selftests à `selftest:operator`.

---

## Task 1 : extraire `run()` et le fournisseur Flyover

**Files:**
- Create: `sim/tools/lib/run.mjs`
- Create: `sim/tools/lib/providers/flyover.mjs`
- Create: `sim/tools/lib/providers/index.mjs`
- Create: `sim/tools/provider-selftest.mjs`
- Modify: `sim/tools/lib/add-map-core.mjs`

**Interfaces:**
- Consumes: rien (première tâche).
- Produces:
  - `run.mjs` : `run(cmd, args, cwd, { onLog, signal }) -> Promise<void>`, `class Cancelled extends Error`
  - `providers/flyover.mjs` : `id = 'flyover'`, `label = 'Apple Flyover'`, `attribution = ['© Apple']`, `tileDirName(opts) -> Promise<string>`, `tileDirPath(opts) -> Promise<string>`, `tileIsUsable(dir) -> boolean`, `plan(opts, { signal }) -> Promise<object>`, `probe(opts, { signal }) -> Promise<{status, message, exported, undecodable}>`, `fetch(opts, { onLog, signal }) -> Promise<{tileDir, attribution, fetchedAt, stats}>`

**`tileDirName` et `tileDirPath` sont asynchrones** — elles attendent `polyHash()` depuis l'ajout du tracé libre. Ne pas les « simplifier » en synchrone.

**`opts` transporte trois modes de zone mutuellement exclusifs**, à propager tels quels dans tout le contrat : `poly` (tableau plat de coordonnées), `bbox` (`{south, west, north, east}`), ou `radius` autour de `lat`/`lon`. Chacun a sa forme de clé de cache.
  - `providers/index.mjs` : `DEFAULT_PROVIDER_ID = 'flyover'`, `PROVIDERS` (objet id→module), `get(id) -> module` (lève sur id inconnu), `list() -> module[]`

- [ ] **Step 1 : écrire le test qui échoue**

Créer `sim/tools/provider-selftest.mjs` :

```js
// Selftest du contrat fournisseur (issue #18). Aucune E/S réseau, aucun DOM.
// Lancer : node tools/provider-selftest.mjs
import assert from 'node:assert/strict';
import * as registry from './lib/providers/index.mjs';
import * as flyover from './lib/providers/flyover.mjs';
import * as core from './lib/add-map-core.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
// Variante asynchrone : tileDirName attend polyHash. Même convention que
// map-poly-selftest.mjs.
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

t('registre : flyover est le fournisseur par défaut', () => {
	assert.equal(registry.DEFAULT_PROVIDER_ID, 'flyover');
	assert.equal(registry.get('flyover').id, 'flyover');
});

t('registre : un id inconnu lève une erreur nommant les ids connus', () => {
	assert.throws(() => registry.get('nope'), /nope/);
	assert.throws(() => registry.get('nope'), /flyover/);
});

t('contrat : chaque fournisseur expose la surface attendue', () => {
	for (const p of registry.list()) {
		assert.equal(typeof p.id, 'string', 'id');
		assert.equal(typeof p.label, 'string', 'label');
		assert.ok(Array.isArray(p.attribution), 'attribution est un tableau');
		assert.ok(p.attribution.length > 0, 'attribution non vide');
		for (const fn of ['tileDirPath', 'plan', 'probe', 'fetch']) {
			assert.equal(typeof p[fn], 'function', `${p.id}.${fn}`);
		}
	}
});

// La stabilité des clés de cache elles-mêmes est déjà couverte par
// map-poly-selftest.mjs (les trois formes : poly, radius, bbox), qui les importe
// depuis add-map-core.mjs. On ne la duplique pas ici : on vérifie seulement que
// l'extraction n'a pas rompu le chemin d'import ni l'asynchronisme.
await at('flyover : tileDirName reste asynchrone et traverse la ré-export', async () => {
	const direct = await flyover.tileDirName({ lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 });
	const viaCore = await core.tileDirName({ lat: 48.8582, lon: 2.297, zoom: 20, radius: 25, altitude: 20 });
	assert.equal(direct, viaCore, 'la ré-export doit rendre exactement la même clé');
	assert.equal(typeof direct, 'string');
});

await at('flyover : les trois modes de zone donnent trois clés distinctes', async () => {
	const base = { zoom: 20, altitude: 20 };
	const keys = await Promise.all([
		flyover.tileDirName({ ...base, lat: 48.8582, lon: 2.297, radius: 25 }),
		flyover.tileDirName({ ...base, bbox: { south: 48.85, west: 2.29, north: 48.86, east: 2.30 } }),
		flyover.tileDirName({ ...base, poly: [48.85, 2.29, 48.86, 2.29, 48.86, 2.30] }),
	]);
	assert.equal(new Set(keys).size, 3, `clés en collision : ${keys.join(' / ')}`);
});

console.log(`\n${n} vérifications, tout passe.`);
```

- [ ] **Step 2 : lancer le test pour vérifier qu'il échoue**

Run: `cd sim && node tools/provider-selftest.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` sur `./lib/providers/index.mjs`

- [ ] **Step 3 : extraire `run()` dans `lib/run.mjs`**

Créer `sim/tools/lib/run.mjs` en **déplaçant** deux blocs depuis `add-map-core.mjs`, commentaires d'en-tête compris, et en ajoutant `export` devant `function run` :

| Bloc | Emplacement actuel |
|---|---|
| `export class Cancelled extends Error` | `add-map-core.mjs:74` jusqu'à sa `}` fermante |
| `function run(cmd, args, cwd, { onLog, signal })` | `add-map-core.mjs:81` jusqu'à la ligne précédant `export async function planScan` (`:126`) |

C'est un déplacement littéral : ne rien réécrire, ne rien « améliorer ».

```js
// Lancement de sous-processus avec relais de logs, partagé par l'orchestrateur
// d'ajout de carte et par les modules fournisseur.
import { spawn } from 'node:child_process';

export class Cancelled extends Error {
	constructor() { super('annulé'); this.name = 'Cancelled'; }
}

// Lance une commande en relayant chaque ligne de stdout ET de stderr à onLog.
// Le Go exporter écrit toute sa progression sur stderr et réserve stdout au JSON
// de --plan, alors que prep.mjs écrit sur stdout : il faut les deux.
export function run(cmd, args, cwd, { onLog, signal }) {
	// ... corps identique à celui de add-map-core.mjs, sans modification ...
}
```

Copier le corps de `run()` à l'identique — c'est un déplacement, pas une réécriture.

- [ ] **Step 4 : créer `lib/providers/flyover.mjs`**

Déplacer depuis `add-map-core.mjs`, en conservant tous les commentaires :

| Bloc | Emplacement actuel | Devient |
|---|---|---|
| `FLYOVER_ROOT` | `:17` | `FLYOVER_ROOT` (réexporté par le core) |
| `tileDirName` (async) | `:42` | `tileDirName` |
| `tileDirPath` (async) | `:51` | `tileDirPath` |
| `tileIsUsable` | `:60` | `tileIsUsable` |
| `planScan` | `:126` | `plan` |
| `RE_EXPORTING` / `RE_EXPORTED` / `RE_UNDECODABLE` | `:147` et suivantes | privées au module |
| `probeCoverage` | `:207` | `probe` |
| bloc téléchargement de `addMap` | `:277` à `:337` env. (du `const tileDir = await tileDirPath(...)` jusqu'à la fin du `throw` de couverture) | `fetch` |

`polyHash` et `polygonProbePoint` (importés de `./tiles.mjs`) suivent le fournisseur : ils servent à `tileDirName` et à `probe`.

**`parsePrepLine` et ses expressions régulières restent dans `add-map-core.mjs`** — elles décrivent la sortie de `prep.mjs`, pas celle du fournisseur, et `scanner-selftest.mjs` les importe depuis là.

```js
// Fournisseur Apple Flyover : tout ce que le pipeline sait de C3M/C3MM vit ici.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, Cancelled } from '../run.mjs';

const SIM_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const FLYOVER_ROOT = path.resolve(SIM_ROOT, '../flyover-reverse-engineering');

export const id = 'flyover';
export const label = 'Apple Flyover';
export const attribution = ['© Apple'];

const RE_EXPORTING = /^Exporting /;
const RE_EXPORTED = /^(\d+) exported$/;
const RE_UNDECODABLE = /^(\d+) tuile\(s\) reçues mais non décodées/;

// Doit rester en phase avec les fmt.Sprintf de cmd/export-obj/main.go — c'est ce
// nom qui sert de cache : si les deux divergent, chaque run re-télécharge tout.
// %f en Go, c'est 6 décimales.
export function tileDirName({ lat, lon, zoom, radius, altitude, bbox }) {
	// ... corps identique ...
}

export function tileDirPath(opts) {
	return path.join(FLYOVER_ROOT, 'downloaded_files/obj', tileDirName(opts));
}

export function tileIsUsable(dir) {
	// ... corps identique ...
}

export async function plan(opts, { signal } = {}) {
	// ... corps de planScan, identique ...
}

export async function probe(opts, { signal } = {}) {
	// ... corps de probeCoverage, identique ...
}

// Télécharge la tuile et rend le dossier prêt pour prep.mjs. Lève si la zone
// n'est pas couverte — le message distingue « pas de couverture » de « couvert
// mais illisible », cf. HANDOFF #15.
export async function fetch(opts, { onLog, signal } = {}) {
	const { lat, lon, zoom = 20, radius = 25, altitude = 20, bbox, force = false } = opts;
	const tileDir = tileDirPath({ lat, lon, zoom, radius, altitude, bbox });
	const stats = { exported: 0, undecodable: 0 };

	if (!force && tileIsUsable(tileDir)) {
		onLog?.({ stream: 'meta', line: `\nTuile déjà téléchargée (${tileDir}), téléchargement sauté (--force pour refaire).` });
		onLog?.({ stream: 'phase', line: 'download', done: true });
	} else {
		// ... le bloc else de addMap, identique : rmSync, phase download,
		//     args go run, run() avec le compteur de hits ...
	}

	if (!tileIsUsable(tileDir)) {
		fs.rmSync(tileDir, { recursive: true, force: true });
		throw new Error(stats.undecodable > 0
			? /* ... message « couvert mais illisible », identique ... */
			: /* ... message « aucune tuile », identique ... */);
	}

	return { tileDir, attribution, fetchedAt: new Date().toISOString(), stats };
}

export { Cancelled };
```

- [ ] **Step 5 : créer le registre `lib/providers/index.mjs`**

```js
// Registre des fournisseurs de photogrammétrie. L'ordre de priorité de l'issue
// #18 est : Google > Flyover > reality meshes ouverts. Tant que Flyover est seul
// inscrit, il est le défaut.
import * as flyover from './flyover.mjs';

export const DEFAULT_PROVIDER_ID = 'flyover';

export const PROVIDERS = { [flyover.id]: flyover };

export function list() { return Object.values(PROVIDERS); }

export function get(id) {
	const p = PROVIDERS[id];
	if (!p) throw new Error(`fournisseur inconnu : ${id} (connus : ${Object.keys(PROVIDERS).join(', ')})`);
	return p;
}
```

- [ ] **Step 6 : lancer le test pour vérifier qu'il passe**

Run: `cd sim && node tools/provider-selftest.mjs`
Expected: PASS — `5 vérifications, tout passe.`

- [ ] **Step 7 : recâbler `add-map-core.mjs` sur le fournisseur**

Dans `add-map-core.mjs` : supprimer les symboles déplacés, importer le registre, et réécrire `addMap` pour déléguer le téléchargement. La surface publique est préservée par des re-exports.

```js
import { run, Cancelled } from './run.mjs';
import * as providers from './providers/index.mjs';

// Surface publique historique : map-api-plugin.mjs, map-poly-selftest.mjs,
// scanner-selftest.mjs et gen-poly-fixture.mjs importent encore ces symboles ici.
export { Cancelled };
export const FLYOVER_ROOT = providers.get('flyover').FLYOVER_ROOT;
export const tileDirName = (o) => providers.get('flyover').tileDirName(o);
export const tileDirPath = (o) => providers.get('flyover').tileDirPath(o);
export const tileIsUsable = (d) => providers.get('flyover').tileIsUsable(d);
export const planScan = (o, x) => providers.get('flyover').plan(o, x);
export const probeCoverage = (o, x) => providers.get('flyover').probe(o, x);
```

Puis, dans `addMap`, remplacer tout le bloc téléchargement (du `const tileDir = ...` jusqu'au `throw new Error(...)` de couverture) par :

```js
	const provider = providers.get(opts.provider ?? providers.DEFAULT_PROVIDER_ID);
	const { tileDir, attribution, fetchedAt, stats } = await provider.fetch(opts, { onLog, signal });
```

Le reste de `addMap` (appel à `prep.mjs`, écriture de `scenes.json`) ne bouge pas encore — la Task 3 s'en occupe.

- [ ] **Step 8 : vérifier qu'aucun consommateur n'est cassé**

Run: `cd sim && node tools/provider-selftest.mjs && node tools/map-poly-selftest.mjs && node tools/scanner-selftest.mjs`
Expected: les trois PASS.

Run: `cd sim && node -e "import('./tools/lib/add-map-core.mjs').then(m => { for (const s of ['addMap','planScan','probeCoverage','slugify','readScenes','writeScenes','dirSize','tileDirPath','tileDirName','parsePrepLine','Cancelled','SCENES_DIR','SCENES_JSON','FLYOVER_ROOT']) if (m[s] === undefined) throw new Error('manquant: '+s); console.log('surface publique intacte'); })"`
Expected: `surface publique intacte`

- [ ] **Step 9 : commit**

```bash
git add sim/tools/lib/run.mjs sim/tools/lib/providers/ sim/tools/provider-selftest.mjs sim/tools/lib/add-map-core.mjs
git commit -m "Issue #18 : extraire le fournisseur Flyover derrière un contrat plan/probe/fetch"
```

---

## Task 2 : le crédit fournisseur, côté pur

**Files:**
- Create: `sim/src/provider-credit.js`
- Create: `sim/tools/provider-credit-selftest.mjs`

**Interfaces:**
- Consumes: rien (module pur, aucune dépendance).
- Produces: `LEGACY_PROVIDER` (objet), `creditLines(manifest) -> string[]`, `creditText(manifest) -> string`

Ce module est importé par le navigateur (`main.js`) *et* par node (le selftest). Il ne doit donc toucher ni au DOM, ni au système de fichiers. Précédent dans le dépôt : `src/operator.selftest.mjs`.

- [ ] **Step 1 : écrire le test qui échoue**

Créer `sim/tools/provider-credit-selftest.mjs` :

```js
// Selftest de la résolution des crédits fournisseur (issue #18). Pur.
// Lancer : node tools/provider-credit-selftest.mjs
import assert from 'node:assert/strict';
import { creditLines, creditText, LEGACY_PROVIDER } from '../src/provider-credit.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('manifest version 3 : rend l\'attribution du fournisseur', () => {
	assert.deepEqual(
		creditLines({ version: 3, provider: { id: 'google', label: 'Google', attribution: ['© Google', '© Airbus'] } }),
		['© Google', '© Airbus']);
});

// Les scènes déjà bakées n'ont pas de champ provider et ne doivent pas être
// re-préparées juste pour gagner une ligne de crédit.
t('manifest version 2 : retombe sur Flyover sans re-préparation', () => {
	assert.deepEqual(creditLines({ version: 2, chunks: [] }), LEGACY_PROVIDER.attribution);
	assert.ok(LEGACY_PROVIDER.attribution.length > 0);
	assert.equal(LEGACY_PROVIDER.id, 'flyover');
});

t('provider sans attribution utilisable : retombe sur le défaut', () => {
	assert.deepEqual(creditLines({ version: 3, provider: { id: 'flyover', attribution: [] } }),
		LEGACY_PROVIDER.attribution);
	assert.deepEqual(creditLines({ version: 3, provider: { id: 'flyover' } }),
		LEGACY_PROVIDER.attribution);
});

t('jamais de crash sur une entrée absurde', () => {
	for (const bad of [null, undefined, {}, { provider: null }, { provider: { attribution: 'nope' } }]) {
		const out = creditLines(bad);
		assert.ok(Array.isArray(out) && out.length > 0, `entrée: ${JSON.stringify(bad)}`);
	}
});

t('les lignes sont dédupliquées en préservant l\'ordre', () => {
	assert.deepEqual(
		creditLines({ version: 3, provider: { attribution: ['© A', '© B', '© A'] } }),
		['© A', '© B']);
});

t('creditText joint sur un séparateur médian', () => {
	assert.equal(creditText({ version: 3, provider: { attribution: ['© A', '© B'] } }), '© A · © B');
});

console.log(`\n${n} vérifications, tout passe.`);
```

- [ ] **Step 2 : lancer le test pour vérifier qu'il échoue**

Run: `cd sim && node tools/provider-credit-selftest.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` sur `../src/provider-credit.js`

- [ ] **Step 3 : écrire l'implémentation minimale**

Créer `sim/src/provider-credit.js` :

```js
// Résout les lignes de crédit fournisseur d'une scène (issue #18).
//
// Google impose d'afficher les copyrights des tuiles rendues ; on applique la
// même règle à tous les fournisseurs, Flyover compris. Module pur : importé par
// l'OSD dans le navigateur et par son selftest sous node.

// Les scènes bakées avant le champ `provider` viennent toutes de Flyover. On ne
// les re-prépare pas pour si peu : elles héritent de ce défaut à la lecture.
export const LEGACY_PROVIDER = Object.freeze({
	id: 'flyover',
	label: 'Apple Flyover',
	attribution: Object.freeze(['© Apple']),
});

export function creditLines(manifest) {
	const raw = manifest?.provider?.attribution;
	const lines = (Array.isArray(raw) ? raw : [])
		.filter((s) => typeof s === 'string' && s.trim())
		.map((s) => s.trim());
	const source = lines.length ? lines : LEGACY_PROVIDER.attribution;
	return [...new Set(source)];
}

export function creditText(manifest) {
	return creditLines(manifest).join(' · ');
}
```

- [ ] **Step 4 : lancer le test pour vérifier qu'il passe**

Run: `cd sim && node tools/provider-credit-selftest.mjs`
Expected: PASS — `6 vérifications, tout passe.`

- [ ] **Step 5 : commit**

```bash
git add sim/src/provider-credit.js sim/tools/provider-credit-selftest.mjs
git commit -m "Issue #18 : résolution pure des crédits fournisseur"
```

---

## Task 3 : `provider` dans le manifest et dans scenes.json

**Files:**
- Modify: `sim/tools/prep.mjs` (bloc manifest, ~ligne 556-580 ; parsing d'arguments, ~ligne 23-38)
- Modify: `sim/tools/lib/add-map-core.mjs` (appel à `prep.mjs` et écriture de l'entrée `scenes.json`)

**Interfaces:**
- Consumes: `providers.get(id)` et le retour de `provider.fetch()` (Task 1) ; `LEGACY_PROVIDER` (Task 2).
- Produces: `manifest.json` en `version: 3` avec `provider: { id, label, attribution, fetchedAt }` ; entrées `scenes.json` avec `provider` et `fetchedAt`.

**Ne pas confondre avec la sélection du décodeur.** Le drapeau `--provider` ajouté ici porte l'*identité* à inscrire dans le manifest — qui a fourni les données, sous quel crédit. Il ne sert **pas** à choisir le décodeur : celui-ci est choisi par reniflage du dossier à la Task 5, sans drapeau. Un fournisseur et un format d'entrée sont deux choses indépendantes, et c'est précisément ce découplage qui permettra à un fournisseur servant de l'OBJ de réutiliser le décodeur OBJ sans rien déclarer.

- [ ] **Step 1 : ajouter les arguments provider à `prep.mjs`**

Dans `parseArgs` de `prep.mjs`, ajouter aux valeurs par défaut de `opts` :

```js
	const opts = { out: null, cell: 256, quality: 85,
		provider: 'flyover', providerLabel: 'Apple Flyover', attribution: [], fetchedAt: null };
```

et dans la boucle de parsing, avant le `else positional.push(a)` :

```js
		else if (a === '--provider') opts.provider = argv[++i];
		else if (a === '--provider-label') opts.providerLabel = argv[++i];
		// Répétable : une occurrence par ligne de crédit, pour ne pas avoir à
		// choisir un séparateur qui n'apparaîtra jamais dans un copyright.
		else if (a === '--attribution') opts.attribution.push(argv[++i]);
		else if (a === '--fetched-at') opts.fetchedAt = argv[++i];
```

Mettre à jour la ligne d'usage et l'en-tête de commentaire du fichier en conséquence.

- [ ] **Step 2 : écrire `provider` dans le manifest**

Dans le bloc manifest de `prep.mjs`, passer `version` à `3` et insérer le champ `provider` juste après :

```js
const manifest = {
	version: 3,
	// Qui a fourni la photogrammétrie, et sous quel crédit. Les manifests
	// version 2 n'ont pas ce champ : src/provider-credit.js les traite comme
	// du Flyover plutôt que d'imposer une re-préparation (issue #18).
	provider: {
		id: opts.provider,
		label: opts.providerLabel,
		attribution: opts.attribution.length ? opts.attribution : ['© Apple'],
		fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
	},
	source: opts.tileDir,
	// ... le reste inchangé ...
```

- [ ] **Step 3 : transmettre le fournisseur depuis `add-map-core.mjs`**

Dans `addMap`, l'appel à `prep.mjs` gagne les arguments issus de `provider.fetch()` :

```js
	const prepArgs = [
		'tools/prep.mjs', tileDir,
		'--out', outDir,
		'--cell', String(cell),
		'--quality', String(quality),
		'--provider', provider.id,
		'--provider-label', provider.label,
		'--fetched-at', fetchedAt,
	];
	for (const line of attribution) prepArgs.push('--attribution', line);
	await run('node', prepArgs, SIM_ROOT, { /* ... onLog inchangé ... */ });
```

- [ ] **Step 4 : ajouter `provider` et `fetchedAt` à l'entrée `scenes.json`**

Le schéma est additif : les entrées historiques restent valides.

```js
	const entry = {
		slug, name, lat, lon,
		...(bbox ? { bbox } : { radius }),
		zoom, altitude, cell, quality,
		// Le fournisseur et la date de fetch sont stockés pour rendre une
		// éventuelle obligation de rafraîchissement mécanisable (issue #18).
		provider: provider.id,
		fetchedAt,
		bytes: dirSize(outDir),
		createdAt: new Date().toISOString(),
	};
```

- [ ] **Step 5 : vérifier que prep écrit bien le nouveau manifest**

Le test se fait sur une scène réelle déjà téléchargée. Lister d'abord ce qui est disponible :

Run: `ls ../flyover-reverse-engineering/downloaded_files/obj/`

Puis, sur un dossier de tuiles existant (remplacer `<tileDir>`), préparer vers une sortie jetable :

Run: `cd sim && node tools/prep.mjs ../flyover-reverse-engineering/downloaded_files/obj/<tileDir> --out /tmp/prep-check --cell 128 --provider flyover --provider-label "Apple Flyover" --attribution "© Apple"`
Expected: se termine sans erreur.

Run: `node -e "const m=require('/tmp/prep-check/manifest.json'); if(m.version!==3) throw new Error('version '+m.version); if(m.provider.id!=='flyover') throw new Error('provider'); if(!m.provider.fetchedAt) throw new Error('fetchedAt'); console.log('manifest v3 ok', JSON.stringify(m.provider));"`
Expected: `manifest v3 ok {"id":"flyover",...}`

Si aucune tuile n'est disponible localement, noter ce fait et sauter à l'étape suivante — la Task 4 revérifiera le chemin complet.

- [ ] **Step 6 : commit**

```bash
git add sim/tools/prep.mjs sim/tools/lib/add-map-core.mjs
git commit -m "Issue #18 : manifest v3 avec provider, attribution et fetchedAt"
```

---

## Task 4 : la ligne de crédit sur l'OSD

**Files:**
- Modify: `sim/src/fpvtp-osd.js` (gabarit HTML du constructeur, ~ligne 22-42 ; table `this.el`, ~ligne 45-60)
- Modify: `sim/src/style.css` (après la règle `.bl`, ~ligne 68)
- Modify: `sim/src/main.js` (après `loadManifest()`, ~ligne 268)

**Interfaces:**
- Consumes: `creditText(manifest)` de `src/provider-credit.js` (Task 2) ; `manifest.provider` (Task 3).
- Produces: `FpvtpOsd.prototype.setCredit(text: string) -> void`

- [ ] **Step 1 : ajouter le coin `br` au gabarit de l'OSD**

Dans `fpvtp-osd.js`, ajouter après le bloc `<div class="corner bl">…</div>` :

```html
				<div class="corner br">
					<div id="fo-credit"></div>
				</div>
```

et dans la table `this.el` :

```js
			credit: q('#fo-credit'),
```

- [ ] **Step 2 : ajouter la méthode `setCredit`**

Dans la classe `FpvtpOsd`, à côté des autres setters :

```js
	// Crédit fournisseur. Discret et permanent : Google impose d'afficher les
	// copyrights des tuiles rendues, et on applique la même règle à tous les
	// fournisseurs. Sur la couche FPVTP!, jamais sur l'OSD du drone — c'est la
	// station qui crédite, pas l'appareil (issue #18).
	setCredit(text) {
		this.el.credit.textContent = text ?? '';
	}
```

- [ ] **Step 3 : styler le coin `br`**

Dans `style.css`, après la règle `.bl` :

```css
#fpvtp-osd .br { bottom: 12px; right: 14px; text-align: right; }
/* Le crédit fournisseur est une mention légale, pas une information de vol :
   il se tient en retrait du reste de l'OSD. */
#fo-credit { font-size: 10px; opacity: .45; letter-spacing: .04em; }
```

- [ ] **Step 4 : câbler le crédit dans `main.js`**

Ajouter à la liste d'imports :

```js
import { creditText } from './provider-credit.js';
```

et juste après `const manifest = await loadManifest();` :

```js
	fpvtpOsd.setCredit(creditText(manifest));
```

- [ ] **Step 5 : vérifier dans le navigateur**

Run: `cd sim && npm run dev`

Ouvrir la scène, entrer en vol, et confirmer que la ligne de crédit apparaît en bas à droite, discrète, et qu'elle affiche `© Apple` — y compris sur une scène `version: 2` non re-préparée, ce qui prouve le repli de la Task 2.

Vérifier aussi que le crédit ne s'affiche **pas** sur l'OSD du drone.

- [ ] **Step 6 : commit**

```bash
git add sim/src/fpvtp-osd.js sim/src/style.css sim/src/main.js
git commit -m "Issue #18 : ligne de crédit fournisseur sur l'OSD FPVTP!"
```

---

## Task 5 : extraire le décodeur OBJ (Stage 2)

**Files:**
- Create: `sim/tools/lib/decoders/obj.mjs`
- Create: `sim/tools/lib/decoders/index.mjs`
- Modify: `sim/tools/prep.mjs` (retire `Growable`, `parseMtl`, `streamObj`, `readFloats` et la passe OBJ, ~lignes 40-280)

**Interfaces:**
- Consumes: rien des tâches précédentes.
- Produces:
  - `decoders/obj.mjs` : `id = 'obj'`, `sniff(tileDir) -> boolean`, `decode(tileDir, { onLog }) -> Promise<DecodeResult>`
  - `decoders/index.mjs` : `pick(tileDir) -> decoder` (lève si aucun ne reconnaît le dossier)
  - `DecodeResult` : `{ materials, byName, vx, vy, vz, tu, tv, triByMat, vertCount, faceCount, polyFaces, unmatchedPairs, attribution }`
    - `materials` : `[{ name, texture }]` où `texture` est un chemin **absolu** ou un `Buffer` (ou `null` si le matériau n'a pas de texture)
    - `vx`/`vy`/`vz` : `Growable(Float64Array)`, coordonnées **ECEF**
    - `tu`/`tv` : `Growable(Float32Array)`, axe V **déjà inversé par le décodeur OBJ**
    - `triByMat` : par matériau, `Growable(Uint32Array)` de paires `(vIdx, uvIdx)`, 6 entrées par triangle, déjà fan-triangulé

**Attention — le piège de ce chantier.** L'inversion de l'axe V (`tv.push(1 - tmp[1])`) reste **à l'intérieur** du décodeur OBJ et ne remonte pas dans le contrat. Un futur décodeur glTF décidera pour son compte, glTF ayant déjà l'origine UV en haut à gauche. C'est le mécanisme derrière les « textures grises » de l'historique du projet ; ne pas le déplacer.

- [ ] **Step 1 : capturer la sortie de référence avant tout changement**

Le test de cette tâche est une comparaison octet pour octet avant/après. Il faut donc la référence d'abord.

Run: `ls ../flyover-reverse-engineering/downloaded_files/obj/`

Sur un dossier de tuiles existant (remplacer `<tileDir>`) :

Run: `cd sim && node tools/prep.mjs ../flyover-reverse-engineering/downloaded_files/obj/<tileDir> --out /tmp/prep-before --cell 128`
Expected: se termine sans erreur.

Run: `cd /tmp/prep-before && find . -type f | sort | xargs sha256sum > /tmp/prep-before.sha256 && wc -l /tmp/prep-before.sha256`
Expected: un nombre de lignes non nul.

Si aucune tuile n'est disponible localement, **arrêter et le signaler** : cette tâche ne peut pas être vérifiée sans données, et la livrer sans preuve irait contre l'objet même du Stage 2.

- [ ] **Step 2 : créer `lib/decoders/obj.mjs` par déplacement**

Déplacer depuis `prep.mjs`, **sans les réécrire** :

| Bloc | Emplacement actuel |
|---|---|
| `class Growable` | `prep.mjs:42` |
| `function parseMtl` | `:99` |
| `function streamObj` | `:120` |
| `function readFloats` | `:142` |
| contrôles d'existence / taille nulle des deux fichiers | `:169-181` |
| passe OBJ complète | `:194` (`// ---- pass over the OBJ`) à `:291`, juste avant `// ---- ECEF -> local ENU metres` |

La frontière est nette et déjà marquée par les deux bannières de commentaires : tout ce qui suit `// ---- ECEF -> local ENU metres` (`:293`) reste dans `prep.mjs`.

Envelopper le tout dans `decode()` :

```js
// Décodeur OBJ/MTL — le format que produit le Go exporter d'Apple Flyover.
// Extrait de prep.mjs sans modification de logique (issue #18) : tout ce qui
// suit le decode (rebase ENU, chunks, texture arrays, collision) reste dans
// prep.mjs et ne connaît pas le format d'entrée.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'obj';

export class Growable { /* ... identique ... */ }

function readFloats(/* ... */) { /* ... identique ... */ }
function parseMtl(/* ... */) { /* ... identique ... */ }
function streamObj(/* ... */) { /* ... identique ... */ }

export function sniff(tileDir) {
	return ['exp_model.obj', 'exp_model.mtl']
		.every((f) => { try { return fs.statSync(path.join(tileDir, f)).size > 0; } catch { return false; } });
}

// onLog reçoit des lignes NON horodatées, indentation comprise. C'est prep.mjs
// qui préfixe avec son stamp() : le décodeur n'emporte pas l'horloge, sinon les
// timings repartiraient à zéro et la sortie ne serait plus comparable.
export async function decode(tileDir, { onLog } = {}) {
	const log = (line) => onLog?.(line);
	const objFile = path.join(tileDir, 'exp_model.obj');
	const mtlFile = path.join(tileDir, 'exp_model.mtl');

	// ... les contrôles d'existence / taille nulle, identiques ...
	// ... parseMtl, les logs « N materials, M without a texture » ...
	// ... la passe streamObj, identique, inversion de V comprise ...

	// parseMtl rend { materials, byName } où chaque matériau porte un `.jpg`
	// relatif au tileDir. On le résout ici : prep.mjs ne connaîtra plus tileDir.
	// Renommer la déstructuration pour éviter la collision avec le résultat :
	//   const { materials: rawMaterials, byName } = parseMtl(mtlFile);
	const materials = rawMaterials.map((m) => ({
		name: m.name,
		texture: m.jpg ? path.join(tileDir, m.jpg) : null,
	}));

	return { materials, byName, vx, vy, vz, tu, tv, triByMat,
		vertCount, faceCount, polyFaces, unmatchedPairs, attribution: [] };
}
```

Conserver à l'identique les `console.log` de jalons — `parsePrepLine()` dans `add-map-core.mjs` en dépend par expression régulière (`N materials, M without a texture`, `-> N chunks of up to …`, `N vertices, N uvs, N triangles`). Les casser casse silencieusement les barres de progression de la GUI.

- [ ] **Step 3 : créer `lib/decoders/index.mjs`**

```js
// Sélection du décodeur : on renifle le dossier plutôt que de le déclarer, pour
// que prep.mjs garde sa signature CLI et reste découplé du fournisseur. Si un
// jour un fournisseur sert de l'OBJ, il réutilise ce décodeur sans rien dire.
import * as obj from './obj.mjs';

export const DECODERS = [obj];

export function pick(tileDir) {
	const d = DECODERS.find((x) => x.sniff(tileDir));
	if (!d) throw new Error(`aucun décodeur ne reconnaît ${tileDir} (connus : ${DECODERS.map((x) => x.id).join(', ')})`);
	return d;
}
```

- [ ] **Step 4 : brancher `prep.mjs` sur le décodeur**

Remplacer tout le bloc supprimé par :

```js
import { pick } from './lib/decoders/index.mjs';

const decoder = pick(opts.tileDir);
// Les lignes du décodeur arrivent nues ; c'est ici qu'elles reçoivent le stamp,
// exactement comme quand le lecteur OBJ vivait dans ce fichier.
const decoded = await decoder.decode(opts.tileDir, {
	onLog: (line) => console.log(`${stamp()} ${line}`),
});
const { materials, byName, vx, vy, vz, tu, tv, triByMat, vertCount, faceCount } = decoded;
```

Deux ajustements mécaniques dans la suite du fichier :

1. `chunkCount` et son `console.log` (`prep.mjs:191-192`) **restent dans `prep.mjs`**, pas dans le décodeur : `LAYERS_PER_CHUNK` est une constante de rebuild, et le décodeur n'a pas à la connaître. Les replacer juste après le decode, inchangés :

```js
const chunkCount = Math.ceil(materials.length / LAYERS_PER_CHUNK);
console.log(`${stamp()}   -> ${chunkCount} chunks of up to ${LAYERS_PER_CHUNK} layers`);
```

   L'ordre des lignes dans stdout est ainsi préservé (`N materials…` émis par le décodeur, puis `-> N chunks…` par prep), ce dont `parsePrepLine()` dépend pour les barres de la GUI. Le log `N materials, M without a texture` part en revanche **dans** le décodeur, et compte sur le `.jpg` brut de `parseMtl` avant le remappage vers `texture`.
2. La lecture de texture (~ligne 442) passe du chemin relatif au champ `texture` :

```js
			if (!mat.texture) return;
			// sharp() accepte indifféremment un chemin et un Buffer : un décodeur
			// à textures embarquées (glTF) n'aura donc rien à extraire sur disque.
			const cellBuf = await sharp(mat.texture)
```

`prep.mjs` devient un module top-level `await` — vérifier qu'il n'a pas besoin d'être enveloppé (il est déjà en `"type": "module"`, donc le `await` de haut niveau est valide).

- [ ] **Step 4b : appliquer la précédence d'attribution**

C'est ici que le niveau 3 de la spec prend vie : l'attribution qui vient des tuiles réellement décodées fait autorité sur celle annoncée par le fournisseur, parce qu'elle seule décrit ce qui a effectivement été cuit. Flyover rend un tableau vide et retombe donc sur `--attribution` ; un futur décodeur glTF rendra les `asset.copyright` agrégés.

Dans `prep.mjs`, juste après le decode :

```js
// Précédence d'attribution (issue #18) : ce que le décodeur a réellement lu
// dans les tuiles prime sur ce que le fournisseur a annoncé, qui prime sur le
// défaut. Le décodeur OBJ ne sait rien dire, donc Flyover s'arrête au niveau 2.
const attribution = decoded.attribution?.length ? decoded.attribution : opts.attribution;
```

et remplacer, dans le bloc manifest écrit à la Task 3 :

```js
		attribution: attribution.length ? attribution : ['© Apple'],
```

L'objet `decoded` complet est déjà conservé par l'étape précédente, donc rien d'autre à changer.

- [ ] **Step 5 : prouver que la sortie est identique**

Run: `cd sim && node tools/prep.mjs ../flyover-reverse-engineering/downloaded_files/obj/<tileDir> --out /tmp/prep-after --cell 128`
Expected: se termine sans erreur, avec les mêmes lignes de jalons qu'avant.

Run: `cd /tmp/prep-after && find . -type f | sort | xargs sha256sum > /tmp/prep-after.sha256; diff <(sed 's|/tmp/prep-before|X|' /tmp/prep-before.sha256) <(sed 's|/tmp/prep-after|X|' /tmp/prep-after.sha256) && echo "IDENTIQUE"`
Expected: `IDENTIQUE`

Une seule différence attendue et acceptable : le champ `source` du manifest, qui contient le chemin de sortie, et `provider.fetchedAt`, qui est un horodatage. Si le diff ne porte que sur `manifest.json`, comparer le reste et inspecter le manifest à la main :

Run: `diff <(python3 -c "import json;d=json.load(open('/tmp/prep-before/manifest.json'));d.pop('source',None);d.get('provider',{}).pop('fetchedAt',None);print(json.dumps(d,sort_keys=True,indent=1))") <(python3 -c "import json;d=json.load(open('/tmp/prep-after/manifest.json'));d.pop('source',None);d.get('provider',{}).pop('fetchedAt',None);print(json.dumps(d,sort_keys=True,indent=1))") && echo "MANIFEST IDENTIQUE"`
Expected: `MANIFEST IDENTIQUE`

- [ ] **Step 6 : vérifier que la scène vole toujours**

Run: `cd sim && node tools/selftest.mjs public/scenes/<slug>`
Expected: PASS

- [ ] **Step 7 : commit**

```bash
git add sim/tools/lib/decoders/ sim/tools/prep.mjs
git commit -m "Issue #18 : extraire le lecteur OBJ derrière un contrat sniff/decode"
```

---

## Task 6 : inscrire les selftests et documenter

**Files:**
- Modify: `sim/package.json` (script `selftest:operator`)
- Modify: `sim/README.md` (section pipeline de préparation)
- Modify: `sim/HANDOFF.md` (état vérifié)

**Interfaces:**
- Consumes: les selftests des Tasks 1 et 2.
- Produces: rien de programmatique.

- [ ] **Step 1 : ajouter les selftests au script**

Dans `sim/package.json`, ajouter à la fin de la chaîne `selftest:operator` :

```
 && node tools/provider-selftest.mjs && node tools/provider-credit-selftest.mjs
```

- [ ] **Step 2 : lancer toute la suite**

Run: `cd sim && npm run selftest:operator`
Expected: tous les selftests PASS, y compris les deux nouveaux.

- [ ] **Step 3 : documenter les deux seams dans le README**

Ajouter à `sim/README.md`, dans la section du pipeline de préparation :

```markdown
### Fournisseurs et décodeurs

Le pipeline a deux seams distincts, et les confondre est l'erreur à éviter :
« d'où viennent les octets » et « comment on les décode » sont deux questions
séparées.

**`tools/lib/providers/`** — d'où viennent les octets. Chaque fournisseur expose
`plan` (estimer sans télécharger), `probe` (y a-t-il vraiment de la donnée ici),
`fetch` (télécharger et rendre un dossier de tuiles), plus `tileDirPath` et son
attribution. `lib/add-map-core.mjs` ne fait plus qu'orchestrer. Seul
`flyover` est inscrit aujourd'hui ; l'ordre de priorité visé est Google >
Flyover > maillages sous licence ouverte (issue #18).

**`tools/lib/decoders/`** — comment les lire. Chaque décodeur expose `sniff`
(sais-tu lire ce dossier ?) et `decode` (rends matériaux, positions ECEF, UV et
triangles). `prep.mjs` choisit par reniflage : **aucun drapeau ne sélectionne le
décodeur**, si bien qu'un fournisseur servant de l'OBJ réutilise le décodeur OBJ
sans rien déclarer. Tout ce qui suit le decode — rebase ENU, chunks, texture
arrays, mesh de collision — ignore le format d'entrée.

> **Attention.** L'inversion de l'axe V vit **dans le décodeur OBJ**, pas dans le
> contrat partagé : OBJ met l'origine UV en bas à gauche, glTF en haut à gauche.
> Un décodeur qui hérite de cette inversion sans la mériter produit les fameuses
> « textures grises » — 21 % de la surface visible échantillonne le remplissage
> gris hors patch. Chaque décodeur tranche pour son compte.
```

- [ ] **Step 4 : mettre à jour HANDOFF.md**

Ajouter à l'état vérifié : les seams fournisseur et décodeur existent, Flyover est le seul fournisseur inscrit, le manifest est en `version: 3` avec `provider`, les manifests `version: 2` se lisent toujours sans re-préparation, et le crédit s'affiche sur l'OSD FPVTP!. Noter que le Stage 3 (Google) reste à faire et fait l'objet d'un plan séparé.

- [ ] **Step 5 : commit**

```bash
git add sim/package.json sim/README.md sim/HANDOFF.md
git commit -m "Issue #18 : inscrire les selftests fournisseur et documenter les deux seams"
```

---

## Ce que ce plan ne fait pas

- **Stage 3 (Google).** Client 3D Tiles, clé API, décodeur glTF. Plan séparé, à écrire une fois les inconnues wire levées sur un vrai `root.json` : compression Draco, système de coordonnées des transforms, structure exacte d'`asset.copyright`, propagation du paramètre de session, et calibration du seuil de `geometricError` — à mesurer sur une zone connue, pas à deviner.
- **La sélection automatique de fournisseur** (sonder Google, retomber sur Flyover). Elle n'a de sens qu'avec deux fournisseurs inscrits ; elle appartient au Stage 3.
- **Le choix du fournisseur dans la GUI d'ajout de carte.** Même raison.
