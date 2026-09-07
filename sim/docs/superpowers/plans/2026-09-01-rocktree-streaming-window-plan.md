# Fenêtre de streaming rocktree + collision progressive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voler en direct sur `?live=lat,lon` : la géométrie et la collision rocktree se chargent/déchargent en continu selon la position du drone, au lieu d'une scène pré-cuite.

**Architecture:** `traverse()` et son cortège (fetchBulk/expandBulk/...) migrent hors de `google-earth.mjs` vers un module pur, réutilisable dans le navigateur. Un pool de Workers persistants (résout #170) remplace le spawn-par-nœud de `fetchNode()`. Un nouveau module de politique (`rocktree-window.js`) décide quoi charger/décharger selon la position et un rayon adaptatif dérivé de la latence réellement observée. La géodésie sphère-rocktree→ECEF WGS84→ENU local (déjà résolue côté prep par `tools/lib/decoders/rocktree.mjs`, jamais côté rendu live) est extraite dans un module pur partagé. `physics.js` apprend à ajouter/retirer des colliders trimesh un par un sur son `groundBody` déjà là. Un rappel doux circulaire (miroir de `geofence.js`, rayon au lieu de rectangle) empêche de sortir de ce qui est chargé. `main.js` gagne une entrée `?live=` volontairement minimale (pas de météo/geofence/distant-ground — hors périmètre assumé).

**Tech Stack:** JavaScript (ES modules), Web Workers, Rapier (`@dimforge/rapier3d-compat`), Three.js, `node:assert/strict` pour les selftests.

**Spec:** `docs/superpowers/specs/2026-09-01-rocktree-streaming-window-design.md`

## Global Constraints

- Aucune régression : `node tools/rocktree-selftest.mjs`, `node tools/provider-selftest.mjs`, `npm run selftest` doivent rester verts après chaque tâche qui touche du code partagé.
- Pas de dépendance npm ajoutée.
- `A_MAX` (rappel plafonné) importé de `src/geofence.js`, jamais redéfini — un seul chiffre pour toute poussée de rappel du dépôt.
- `?live=lat,lon` est un raccourci dev, PAS un nouvel écran : pas de météo, pas de `Geofence`/`DistantGround`, pas d'écran de crédit. Ce périmètre restreint est assumé par la spec, pas un oubli.
- Origine ENU fixée UNE FOIS au spawn (`lat,lon` de `?live=`) ; aucun recentrage en vol dans ce plan.
- Niveau d'octree constant (`ROCKTREE_LEVEL`), pas de sélection de LOD dynamique.

---

## Task 1 : extraire `traverse()` et son cortège dans `tools/lib/rocktree/traverse.mjs`

**Files:**
- Create: `tools/lib/rocktree/traverse.mjs`
- Modify: `tools/lib/providers/google-earth.mjs` (imports, suppression des fonctions déménagées)
- Test: `tools/rocktree-selftest.mjs`, `tools/provider-selftest.mjs` (régression, pas de nouveau test — le comportement ne change pas)

**Interfaces:**
- Produces: `_net`, `PREFIX` (ré-exporté depuis `url.mjs` pour compat), `traverse(zone, level, opts)`, `fetchBulk(bulkPath, epoch, opts)`, `expandBulk(bulk, bulkPath, box, zone, level)`, `dropFillinAncestors(nodesOut)`, `getPlanetoid(opts)`, `zoneOf(opts)`, `zoomToLevel(zoom)` — mêmes signatures qu'aujourd'hui dans `google-earth.mjs`.

- [ ] **Step 1: Confirmer par lecture ce qui déménage**

Run: `grep -n "^export function\|^function\|^async function\|^export async function" tools/lib/providers/google-earth.mjs`

Repérer les lignes de : `_net` (objet, pas une fonction — voir `export const _net`), `zoneOf`, `getPlanetoid`, `fetchBulk`, `nodeUrl` (déjà extraite, Tâche 1 de la tranche précédente — ne PAS la retoucher), `dropFillinAncestors`, `expandBulk`, `traverse`, `zoomToLevel`.

- [ ] **Step 2: Créer `tools/lib/rocktree/traverse.mjs`**

Copier telles quelles (sans changement de logique) les fonctions/constantes suivantes depuis `tools/lib/providers/google-earth.mjs` : `export const _net`, `export function zoomToLevel`, `ZOOM_TO_LEVEL` (la table dont dépend `zoomToLevel`), `MAX_NODES`, `BULK_BATCH`, `function zoneOf` (→ `export function zoneOf`), `async function getPlanetoid` (→ exportée), `async function fetchBulk` (→ exportée), `export function dropFillinAncestors`, `function expandBulk` (→ exportée), `export async function traverse`.

En tête du nouveau fichier :

```js
// Marche dans l'octree rocktree (issue #18, #153) et tout ce qui l'entoure —
// extrait de tools/lib/providers/google-earth.mjs (#168, tranche « fenêtre de
// streaming ») : ce code ne dépend de rien de Node (vérifié par grep ciblé
// avant d'écrire ce module), contrairement au fichier où il vivait, qui
// importe node:url pour son cache de préparation sur disque — sans rapport,
// mais un import ESM statique casse tout le module dans un Worker navigateur
// qu'il soit utilisé ou non. Même raison que url.mjs (nodeUrl/PREFIX) avant
// lui.
import { PREFIX } from './url.mjs';
import { parsePlanetoid, parseBulk } from './proto.mjs';
import { descendBox, boxIntersects } from './octant.mjs';
```

(Ajuster les imports relatifs de `polyHash`/`polygonBounds` si `zoneOf` en a besoin — vérifier `tools/lib/tiles.mjs` : chemin `../tiles.mjs` depuis `tools/lib/providers/`, devient `../tiles.mjs` aussi depuis `tools/lib/rocktree/` puisque les deux dossiers sont au même niveau sous `tools/lib/`.)

- [ ] **Step 3: Faire pointer `google-earth.mjs` vers le nouveau module**

Remplacer les définitions déménagées par un import :

```js
import {
	_net, zoneOf, getPlanetoid, fetchBulk, dropFillinAncestors, expandBulk,
	traverse, zoomToLevel,
} from '../rocktree/traverse.mjs';
```

Supprimer les définitions originales de ces symboles dans `google-earth.mjs`. `_net` reste utilisée par le reste du fichier exactement pareil (ex. `_cacheRootForTests`, `fetch()`) ; l'export `export const _net` que les tests mockent (`ge._net.http = ...`) doit continuer d'exister sur `google-earth.mjs` — ré-exporter :

```js
export { _net, zoneOf, getPlanetoid, dropFillinAncestors, traverse, zoomToLevel };
```

- [ ] **Step 4: Vérifier zéro régression**

Run: `node tools/rocktree-selftest.mjs`
Expected: PASS, comportement identique — ce test importe déjà `traverse`/`fetchBulk`/etc. par leurs noms, peu importe le fichier qui les définit tant que `google-earth.mjs` les ré-exporte.

Run: `node tools/provider-selftest.mjs`
Expected: PASS — exerce `ge._net.http` mocké, `ge.traverse()`, `ge.plan()`, etc. en bout en bout.

- [ ] **Step 5: Commit**

```bash
git add tools/lib/rocktree/traverse.mjs tools/lib/providers/google-earth.mjs
git commit -m "refactor(rocktree): extrait traverse()/fetchBulk()/etc. dans traverse.mjs, pur (#168, #170)"
```

---

## Task 2 : exporter `WORST_MEASURED_SPEED_MS` depuis `geofence.js`

**Files:**
- Modify: `src/geofence.js` (ajout d'une constante exportée, aucune valeur existante changée)

**Interfaces:**
- Produces: `WORST_MEASURED_SPEED_MS` (number, m/s) — consommée par la Tâche 7 (`rocktree-window.js`) pour dimensionner le rayon de streaming, sans redupliquer le chiffre mesuré par `geofence-measure.mjs`.

- [ ] **Step 1: Ajouter la constante**

Dans `src/geofence.js`, juste après la ligne `export const R_CAUTION = 138;`, ajouter :

```js

// La pire vitesse mesurée par tools/geofence-measure.mjs (race5, plein gaz à
// 85°, voir le commentaire de R_CAUTION ci-dessus) — exportée séparément
// parce que la fenêtre de streaming rocktree (#168, #170) en a besoin pour
// dimensionner son propre rayon de chargement, sur le même principe que
// R_CAUTION : la distance qu'il faut pour réagir est celle que la pire
// vitesse mesurée impose. Un seul chiffre mesuré, deux consommateurs.
export const WORST_MEASURED_SPEED_MS = 42.72;
```

- [ ] **Step 2: Vérifier**

Run: `node tools/geofence-measure.mjs 2>&1 | grep "pire vitesse"`
Expected: `pire vitesse       42.72 m/s (race5)` — confirme que la constante ajoutée à la main correspond bien à ce que le banc mesure MAINTENANT, pas une valeur périmée.

Run: `npm run selftest` (depuis `sim/`)
Expected: PASS — un export ajouté ne change aucun comportement existant.

- [ ] **Step 3: Commit**

```bash
git add src/geofence.js
git commit -m "feat(geofence): exporte WORST_MEASURED_SPEED_MS pour la fenêtre de streaming rocktree (#168)"
```

---

## Task 3 : `physics.js` — colliders progressifs par nœud

**Files:**
- Modify: `src/physics.js` (constructeur : stocker `groundBody` ; deux nouvelles méthodes)
- Test: `tools/physics-collider-selftest.mjs` (nouveau)

**Interfaces:**
- Produces: `physics.addNodeCollider(path, vertices, indices) -> void`, `physics.removeNodeCollider(path) -> void`. Lève si `path` est déjà chargé (`addNodeCollider`) ou n'existe pas (`removeNodeCollider`) — un appelant qui se trompe de discipline de suivi doit le savoir tout de suite, pas silencieusement écraser un collider.

- [ ] **Step 1: Écrire le test qui échoue**

Create: `tools/physics-collider-selftest.mjs`

```js
// Selftest des colliders rocktree progressifs (#168, #170).
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';

await initPhysics();

// Un tétraèdre minuscule et plat, loin sous le spawn : juste de quoi avoir
// un trimesh valide sans toucher au collider du drone pendant ce test.
const vertices = new Float32Array([
	-1, -100, -1,   1, -100, -1,   0, -100, 1,   0, -99, 0,
]);
const indices = new Uint32Array([0, 1, 2,  0, 1, 3,  1, 2, 3,  0, 2, 3]);

const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const phys = new Physics(emptyCollision, { x: 0, y: 0, z: 0 });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('addNodeCollider puis removeNodeCollider ne lèvent pas', () => {
	phys.addNodeCollider('306', vertices, indices);
	phys.removeNodeCollider('306');
});

t('addNodeCollider deux fois sur le même chemin lève', () => {
	phys.addNodeCollider('306', vertices, indices);
	assert.throws(() => phys.addNodeCollider('306', vertices, indices), /306/);
	phys.removeNodeCollider('306');
});

t('removeNodeCollider sur un chemin absent lève', () => {
	assert.throws(() => phys.removeNodeCollider('999'), /999/);
});

t('un collider ajouté est bien interrogeable par groundBelow()', () => {
	phys.addNodeCollider('306', vertices, indices);
	const g = phys.groundBelow(0, 0, 0);
	assert.ok(g !== null && Math.abs(g - -99.5) < 1, `ground=${g}`);
	phys.removeNodeCollider('306');
});

console.log(`physics-collider-selftest : ${n} tests ok`);
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/physics-collider-selftest.mjs`
Expected: FAIL — `phys.addNodeCollider is not a function`. Vérifier aussi que `new Physics(emptyCollision, ...)` ne lève pas déjà pour une autre raison (un trimesh à 0 sommet est un cas limite de Rapier) — si ÇA échoue, le corriger d'abord isolément avant Step 3 (accepter un trimesh de scène vide est le cas `?live=`, où il n'y a justement pas de `collision.bin`).

- [ ] **Step 3: Stocker `groundBody`, ajouter les deux méthodes**

Dans `src/physics.js`, remplacer :

```js
		const groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
		this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(collision.vertices, collision.indices)
				.setFriction(0.9)
				.setRestitution(0.15),
			groundBody,
		);
```

par :

```js
		this.groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
		this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(collision.vertices, collision.indices)
				.setFriction(0.9)
				.setRestitution(0.15),
			this.groundBody,
		);
		// Colliders rocktree progressifs (#168, #170) : un trimesh par nœud
		// reçu en vol, sur ce MÊME corps fixe — Rapier accepte plusieurs
		// colliders par corps nativement, pas besoin d'un corps par nœud.
		this._nodeColliders = new Map();
```

Puis, après la méthode `setProfile` (chercher `// Swap the airframe family` pour se repérer), ajouter :

```js
	// #168, #170 : convertit la géométrie d'UN nœud rocktree fraîchement
	// décodé en collider Rapier, sur le même groundBody que le trimesh de
	// scène (s'il existe) ou seul (mode ?live=, pas de collision.bin).
	// Mêmes réglages de friction/restitution que le trimesh de scène — un sol
	// qui se comporte pareil des deux côtés, cuit ou streamé.
	addNodeCollider(path, vertices, indices) {
		if (this._nodeColliders.has(path)) {
			throw new Error(`addNodeCollider: "${path}" est déjà chargé — removeNodeCollider() d'abord`);
		}
		const collider = this.world.createCollider(
			RAPIER.ColliderDesc.trimesh(vertices, indices)
				.setFriction(0.9)
				.setRestitution(0.15),
			this.groundBody,
		);
		this._nodeColliders.set(path, collider);
	}

	removeNodeCollider(path) {
		const collider = this._nodeColliders.get(path);
		if (!collider) throw new Error(`removeNodeCollider: "${path}" n'est pas chargé`);
		this.world.removeCollider(collider, true);
		this._nodeColliders.delete(path);
	}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/physics-collider-selftest.mjs`
Expected: PASS.

Run: `npm run selftest` (depuis `sim/`)
Expected: PASS — `groundBody` devient `this.groundBody` mais reste utilisé exactement pareil localement ; le comportement du trimesh de scène ne change pas.

- [ ] **Step 5: Ajouter au pipeline `selftest:operator` du `package.json`**

Dans `package.json`, insérer `node tools/physics-collider-selftest.mjs` dans la chaîne `selftest:operator`, juste après `node tools/geofence-selftest.mjs` (le dernier appel de la chaîne).

Run: `npm run selftest`
Expected: le nouveau test apparaît dans la sortie, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/physics.js tools/physics-collider-selftest.mjs package.json
git commit -m "feat(physics): colliders rocktree progressifs par nœud (#168, #170)"
```

---

## Task 4 : `src/rocktree-fence.js` — rappel doux circulaire

**Files:**
- Create: `src/rocktree-fence.js`
- Test: `tools/rocktree-fence-selftest.mjs` (nouveau)

**Interfaces:**
- Consumes: `A_MAX` de `src/geofence.js`.
- Produces: `push(distanceFromCenter, trustedRadius) -> number` (accélération, m/s², 0..A_MAX). Consommée par la Tâche 10 (`main.js`).

- [ ] **Step 1: Écrire le test qui échoue**

Create: `tools/rocktree-fence-selftest.mjs`

```js
// Selftest du rappel circulaire de la fenêtre de streaming rocktree (#168).
import assert from 'node:assert/strict';
import { push } from '../src/rocktree-fence.js';
import { A_MAX } from '../src/geofence.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('dans le rayon de confiance : poussée nulle', () => {
	assert.equal(push(50, 100), 0);
	assert.equal(push(100, 100), 0);   // pile au bord : encore nulle
});

t('au-delà du rayon de confiance + RAMP_M : poussée pleine', () => {
	assert.equal(push(200, 100), A_MAX);
});

t('entre les deux : rampe linéaire continue, pas de saut', () => {
	const justInside = push(100 + 1e-6, 100);
	const justOutside = push(100 - 1e-6, 100);
	assert.ok(justInside > 0 && justInside < 0.01);
	assert.equal(justOutside, 0);
});

console.log(`rocktree-fence-selftest : ${n} tests ok`);
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-fence-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/rocktree-fence.js'`.

- [ ] **Step 3: Écrire `src/rocktree-fence.js`**

```js
// Rappel doux au bord de la fenêtre de streaming rocktree (#168, #170).
// Même forme que pushOf() dans geofence.js (rampe de 0 à A_MAX), mais
// circulaire autour d'un centre qui suit le drone plutôt que rectangulaire
// autour d'une bbox de scène fixe : geofence.js retient une carte pré-cuite
// à ses bords, celui-ci retient le drone à l'intérieur de ce qui est
// réellement chargé en ce moment.
import { A_MAX } from './geofence.js';

// CHOISI, pas mesuré — même statut que HYST_M dans geofence.js et pour la
// même raison : la largeur de rampe la plus sûre dépend de ce que le vol
// réel produit comme dépassement au bord du rayon adaptatif, qu'on ne
// connaît pas encore. À revoir une fois qu'on observe le comportement réel
// en vol.
export const RAMP_M = 20;

export function push(distanceFromCenter, trustedRadius) {
	if (distanceFromCenter <= trustedRadius) return 0;
	if (distanceFromCenter >= trustedRadius + RAMP_M) return A_MAX;
	return A_MAX * (distanceFromCenter - trustedRadius) / RAMP_M;
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-fence-selftest.mjs`
Expected: PASS.

- [ ] **Step 5: Ajouter au pipeline `selftest:operator`**

Insérer `node tools/rocktree-fence-selftest.mjs` dans `package.json`, juste après `node tools/physics-collider-selftest.mjs` (Tâche 3).

Run: `npm run selftest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rocktree-fence.js tools/rocktree-fence-selftest.mjs package.json
git commit -m "feat(rocktree): rappel doux circulaire au bord de la fenêtre de streaming (#168)"
```

---

## Task 5 : `src/rocktree-worker.js` — protocole persistant par `id`

**Files:**
- Modify: `src/rocktree-worker.js`

**Interfaces:**
- Produces: le worker accepte désormais PLUSIEURS messages sur sa durée de vie. Entrée : `{ id, path, epoch, imageryEpoch, flags }`. Sortie succès : `{ id, ok: true, matrix, copyrightIds, meshes }`. Sortie échec : `{ id, ok: false, error, status }`. `id` est un nombre opaque choisi par l'appelant (Tâche 6), rien ici ne le génère ni ne le valide — juste renvoyé tel quel.

Ce module n'a pas de test Node (API navigateur). Vérifié indirectement par la Tâche 6 (le pool, dont le test mock `self`/`Worker`) et en direct par la Tâche 11.

- [ ] **Step 1: Réécrire le protocole de message**

Dans `src/rocktree-worker.js`, remplacer :

```js
self.onmessage = async (e) => {
	const { path, epoch, imageryEpoch, flags } = e.data;
	try {
```

par :

```js
// Persistant (#170) : ce worker traite UN message, répond, et REVIENT
// écouter — contrairement à un usage un-coup comme celui que loadChunks()
// fait de worker.js. L'appelant (rocktree-worker-pool.js) crée un petit
// nombre de ces workers une fois pour toute la session de vol et les
// réutilise ; `id` corrèle chaque réponse à sa requête, plusieurs pouvant
// être en vol en même temps sur des workers différents du pool.
self.onmessage = async (e) => {
	const { id, path, epoch, imageryEpoch, flags } = e.data;
	try {
```

Et remplacer les deux `self.postMessage({ ok: true, ...` / `self.postMessage({ ok: false, ...` pour inclure `id` :

```js
		self.postMessage(
			{ id, ok: true, matrix: node.matrix, copyrightIds: node.copyrightIds, meshes },
			[buf.buffer, ...bitmaps],
		);
	} catch (err) {
		self.postMessage({ id, ok: false, error: String((err && err.message) || err), status: err?.status ?? null });
	}
};
```

Adapter la ligne `catch` existante en conséquence (garder le `status` déjà propagé par la tranche précédente, #171 l'a confirmé correct).

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check src/rocktree-worker.js`
Expected: pas de sortie.

- [ ] **Step 3: Commit**

```bash
git add src/rocktree-worker.js
git commit -m "feat(rocktree): worker persistant par id, remplace le protocole un-coup (#170)"
```

---

## Task 6 : `src/rocktree-worker-pool.js` — pool persistant

**Files:**
- Create: `src/rocktree-worker-pool.js`
- Modify: `src/rocktree-loader.js` (`fetchNode()` délègue au pool)

**Interfaces:**
- Produces: `fetchNode({ path, epoch, imageryEpoch, flags }, { signal }) -> Promise<{ matrix, copyrightIds, meshes }>` — MÊME signature qu'avant (Tâche 6/7 de la tranche précédente), aucun appelant existant ne change.

- [ ] **Step 1: Écrire `src/rocktree-worker-pool.js`**

```js
// Pool de Workers persistants pour fetchNode() (#170) : la fenêtre de
// streaming (rocktree-window.js) appelle fetchNode() en continu pendant le
// vol, contrairement à loadChunks() qui ne charge qu'une fois par scène —
// créer et détruire un Worker module par nœud y dominerait le coût.
//
// POOL_SIZE : même ordre de grandeur que MAX_CONCURRENT (loader.js, 3) —
// assez pour recouvrir fetch et décodage de plusieurs nœuds à la fois, pas
// assez pour saturer le réseau ou la mémoire de plusieurs onglets.
const POOL_SIZE = 3;

let nextId = 1;
let workers = null;   // Worker[], créés une seule fois, jamais détruits
let nextWorker = 0;   // round-robin
const pending = new Map();   // id -> { resolve, reject }

function ensurePool() {
	if (workers) return workers;
	workers = Array.from({ length: POOL_SIZE }, () => {
		const w = new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' });
		w.onmessage = (e) => {
			const msg = e.data;
			const p = pending.get(msg.id);
			if (!p) return;   // réponse arrivée après annulation (Step suivant) : ignorée
			pending.delete(msg.id);
			if (!msg.ok) {
				const err = new Error(msg.error);
				err.status = msg.status;
				p.reject(err);
				return;
			}
			p.resolve({ matrix: msg.matrix, copyrightIds: msg.copyrightIds, meshes: msg.meshes });
		};
		w.onerror = (e) => {
			// Une erreur de worker n'est pas corrélée à une requête précise
			// (contrairement à { ok: false } côté message) : elle peut casser
			// TOUTES les requêtes en vol sur CE worker. Rejeter celles qui
			// n'ont pas encore répondu plutôt que les laisser pendre pour
			// toujours.
			for (const [id, p] of pending) {
				p.reject(new Error(`rocktree worker: ${e.message}`));
				pending.delete(id);
			}
		};
		return w;
	});
	return workers;
}

export function fetchNode({ path, epoch, imageryEpoch, flags }, { signal } = {}) {
	if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));

	const pool = ensurePool();
	const id = nextId++;
	const worker = pool[nextWorker];
	nextWorker = (nextWorker + 1) % pool.length;

	return new Promise((resolve, reject) => {
		// L'AbortSignal ne traverse toujours pas postMessage() (non clonable,
		// même contrainte que la tranche précédente). Annuler ici NE termine
		// PLUS le worker (il est partagé, Tâche 5/6) : juste oublier la
		// requête en attente. Sa réponse, si elle arrive quand même, ne
		// trouvera plus personne dans `pending` (voir onmessage ci-dessus) et
		// sera silencieusement ignorée.
		const onAbort = () => {
			pending.delete(id);
			reject(new DOMException('aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort);

		pending.set(id, {
			resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
			reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
		});
		worker.postMessage({ id, path, epoch, imageryEpoch, flags });
	});
}
```

- [ ] **Step 2: Remplacer le contenu de `src/rocktree-loader.js`**

```js
// Adaptateur mince vers rocktree-worker-pool.js (#170) : rocktree-window.js
// (tranche suivante) n'a besoin de rien savoir du pool, juste de fetchNode().
export { fetchNode } from './rocktree-worker-pool.js';
```

(Remplace tout le fichier — le pool porte maintenant toute la logique de Worker/AbortController.)

- [ ] **Step 3: Vérifier la syntaxe**

Run: `node --check src/rocktree-worker-pool.js && node --check src/rocktree-loader.js`
Expected: pas de sortie.

- [ ] **Step 4: Commit**

```bash
git add src/rocktree-worker-pool.js src/rocktree-loader.js
git commit -m "feat(rocktree): pool de Workers persistants, fetchNode() délègue (#170)"
```

---

## Task 7 : `src/rocktree-window.js` — la politique

**Files:**
- Create: `src/rocktree-window.js`
- Test: `tools/rocktree-window-selftest.mjs` (nouveau)

**Interfaces:**
- Consumes: `traverse`, `zoneOf` de `tools/lib/rocktree/traverse.mjs` ; `fetchNode` de `src/rocktree-loader.js` ; `WORST_MEASURED_SPEED_MS` de `src/geofence.js`.
- Produces:

```js
class RocktreeWindow {
	constructor({ level, origin, onNodeReady, onNodeReleased })
	// origin: { lat, lon } — l'origine FIXE du repère ENU local (spawn), utilisée
	// pour exprimer windowCenterLocal dans le même repère que physics.position.
	update(dronePos, { signal } = {})   // { lat, lon } — no-op la plupart des appels
	nearestTrustedRadius() -> number
	get windowCenterLocal() -> { x, z } | null   // mètres locaux ENU relatifs à `origin`, null avant le premier calcul
	originEcef -> [x, y, z]   // ECEF de `origin`, calculé une fois au constructeur
	originBasis -> { east, up, south }   // repère ENU de `origin`, calculé une fois au constructeur
}
```

`onNodeReady(path, matrix, meshes, radius)` / `onNodeReleased(path)` sont les
points d'accroche que la Tâche 10 (`main.js`) utilise pour ajouter/retirer la
géométrie THREE et les colliders Rapier — ce module ne touche ni Three ni
Rapier lui-même, il ne connaît QUE la politique de quoi charger/décharger.
`matrix` (la transformation nœud->sphère de `parseNode()`) et `radius` (la
sphère de `PlanetoidMetadata`, lue une fois par le premier `traverse()` et
réutilisée ensuite — elle ne change pas en cours de vol) sont ce dont la
Tâche 9 (`buildNodeMesh`) a besoin pour situer la géométrie correctement ;
`RocktreeWindow` les fait juste transiter, il ne les interprète pas — même
discipline de frontière que pour `fetchNode()`.

- [ ] **Step 1: Écrire le test qui échoue**

Create: `tools/rocktree-window-selftest.mjs`

```js
// Selftest de la politique de fenêtre de streaming rocktree (#168), SANS
// réseau réel : traverse() et fetchNode() sont injectés (mêmes fixtures que
// tools/rocktree-selftest.mjs, capture Paris epoch 1014). traverse() rend
// { nodes, radius } — même forme que le vrai traverse() de traverse.mjs
// (radius vient de PlanetoidMetadata) — PAS un tableau nu.
import assert from 'node:assert/strict';
import { RocktreeWindow, REFRESH_THRESHOLD_M } from '../src/rocktree-window.js';

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

const ORIGIN = { lat: 48.85, lon: 2.29 };
// Deux nœuds synthétiques : la fenêtre initiale en retient un, un déplacement
// suffisant fait apparaître l'autre et disparaître le premier.
const NODE_A = { path: '3060', epoch: 1014, imageryEpoch: null, flags: 0 };
const NODE_B = { path: '3061', epoch: 1014, imageryEpoch: null, flags: 0 };
const RADIUS = 6371010;

function fakeDeps({ traverseNodes, fetchDelayMs = 0 }) {
	const fetched = [];
	const traverse = async () => ({ nodes: traverseNodes, radius: RADIUS });
	const fetchNode = async (n) => {
		fetched.push(n.path);
		if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
		return { matrix: new Float64Array(16), copyrightIds: [], meshes: [{ vertices: new Uint8Array(0), indices: new Uint8Array(0) }] };
	};
	return { traverse, fetchNode, fetched };
}

await t('premier update() : fetch le nœud désiré, onNodeReady appelé avec matrix+radius', async () => {
	const { traverse, fetchNode, fetched } = fakeDeps({ traverseNodes: [NODE_A] });
	const ready = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: (p, matrix, meshes, radius) => ready.push({ p, radius, hasMatrix: matrix.length === 16 }), onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	assert.deepEqual(fetched, ['3060']);
	assert.equal(ready.length, 1);
	assert.equal(ready[0].p, '3060');
	assert.equal(ready[0].radius, RADIUS);
	assert.ok(ready[0].hasMatrix);
});

await t('update() sous le seuil de distance ne refait rien', async () => {
	const { traverse, fetchNode, fetched } = fakeDeps({ traverseNodes: [NODE_A] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	await win.update(ORIGIN);   // même position, pile
	assert.equal(fetched.length, 1, `refetché sans avoir bougé : ${fetched}`);
});

await t('déplacement au-delà du seuil : diff correcte (nouveau fetché, ancien libéré)', async () => {
	let call = 0;
	const traverse = async () => ({ nodes: call++ === 0 ? [NODE_A] : [NODE_B], radius: RADIUS });
	const fetchNode = async (n) => ({ matrix: new Float64Array(16), copyrightIds: [], meshes: [] });
	const ready = [], released = [];
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: (p) => ready.push(p), onNodeReleased: (p) => released.push(p), _traverse: traverse, _fetchNode: fetchNode });
	await win.update(ORIGIN);
	// ~1 km plus loin en latitude — largement au-dessus de REFRESH_THRESHOLD_M
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	assert.deepEqual(ready, ['3060', '3061']);
	assert.deepEqual(released, ['3060']);
});

await t('windowCenterLocal se déplace vers le nord (z négatif, convention -Z=nord) après le second update()', async () => {
	let call = 0;
	const traverse = async () => ({ nodes: call++ === 0 ? [NODE_A] : [NODE_B], radius: RADIUS });
	const fetchNode = async () => ({ matrix: new Float64Array(16), copyrightIds: [], meshes: [] });
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: fetchNode });
	assert.equal(win.windowCenterLocal, null);
	await win.update(ORIGIN);
	assert.ok(Math.hypot(win.windowCenterLocal.x, win.windowCenterLocal.z) < 1, 'au premier update(), le centre EST l\'origine');
	await win.update({ lat: ORIGIN.lat + 1000 / 111320, lon: ORIGIN.lon });
	assert.ok(win.windowCenterLocal.z < -500, `z=${win.windowCenterLocal.z} — attendu très négatif (nord, ~1000 m)`);
});

await t('nearestTrustedRadius() décroît quand la latence observée augmente', async () => {
	const { traverse } = fakeDeps({ traverseNodes: [NODE_A] });
	const slow = fakeDeps({ traverseNodes: [NODE_A], fetchDelayMs: 5 }).fetchNode;
	const win = new RocktreeWindow({ level: 21, origin: ORIGIN, onNodeReady: () => {}, onNodeReleased: () => {}, _traverse: traverse, _fetchNode: slow });
	const r0 = win.nearestTrustedRadius();   // avant toute mesure : valeur de repli
	await win.update(ORIGIN);
	// Une seule mesure ne doit pas faire s'effondrer le rayon de repli à zéro.
	assert.ok(win.nearestTrustedRadius() > 0);
	assert.ok(r0 > 0);
});

console.log(`rocktree-window-selftest : ${n} tests ok`);
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-window-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/rocktree-window.js'`.

- [ ] **Step 3: Écrire `src/rocktree-window.js`**

```js
// Politique de la fenêtre de streaming rocktree (#168) : quels nœuds charger
// ou décharger selon la position de vol. Ne touche NI Three NI Rapier — ça,
// c'est le problème de l'appelant (main.js, Tâche 9), via onNodeReady()/
// onNodeReleased(). Même frontière que fetchNode() dans la tranche
// précédente : testable seule, remplaçable seule.
import { traverse as realTraverse, zoneOf } from '../tools/lib/rocktree/traverse.mjs';
import { fetchNode as realFetchNode } from './rocktree-loader.js';
import { WORST_MEASURED_SPEED_MS } from './geofence.js';
import { geodeticToEcef, enuBasis, ecefToLocalEnu } from '../tools/lib/rocktree/geodesy.mjs';

// Recalcule la fenêtre après ce déplacement. CHOISI, pas mesuré — un ordre de
// grandeur raisonnable pour ce premier jalon, à affiner une fois qu'on
// observe le comportement réel en vol (comme RAMP_M dans rocktree-fence.js).
export const REFRESH_THRESHOLD_M = 50;

// Rayon de repli avant toute mesure de latence réelle — CHOISI, la première
// fenêtre doit bien démarrer avec quelque chose.
const FALLBACK_RADIUS_M = 200;

// Nombre d'échantillons de latence gardés pour le p95 glissant.
const LATENCY_SAMPLES = 20;

const M_PER_DEG_LAT = 111320;

function metersBetween(a, b) {
	const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
	const dLon = (a.lon - b.lon) * M_PER_DEG_LAT * Math.cos((a.lat / 180) * Math.PI);
	return Math.hypot(dLat, dLon);
}

function p95(samples) {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

export class RocktreeWindow {
	constructor({ level, origin, onNodeReady, onNodeReleased, _traverse = realTraverse, _fetchNode = realFetchNode }) {
		this._level = level;
		this._origin = origin;
		this._originEcef = geodeticToEcef(origin.lat, origin.lon, 0);
		this._originBasis = enuBasis(origin.lat, origin.lon);
		this._onNodeReady = onNodeReady;
		this._onNodeReleased = onNodeReleased;
		this._traverse = _traverse;
		this._fetchNode = _fetchNode;
		this._nodes = new Map();   // path -> { status: 'pending'|'ready', controller }
		this._lastPos = null;
		this._latencies = [];
		// La sphère rocktree (PlanetoidMetadata) : lue une fois par le premier
		// traverse() réussi, jamais recalculée ensuite — elle ne change pas en
		// cours de vol. `radius`, ici, veut TOUJOURS dire cette sphère ; le
		// rayon de CHARGEMENT (mètres autour du drone) est nommé `loadRadiusM`
		// partout dans cette classe pour ne jamais confondre les deux — même
		// unité, sens totalement différent.
		this._sphereRadius = null;
		this.windowCenterLocal = null;
		// Exposées (pas seulement _originEcef/_originBasis) : main.js
		// (Tâche 10) en a besoin pour buildNodeMesh(), et les recalculer là-bas
		// depuis les mêmes lat/lon donnerait le même résultat au prix d'un appel
		// dupliqué — autant réutiliser celui déjà fait ici.
		this.originEcef = this._originEcef;
		this.originBasis = this._originBasis;
	}

	nearestTrustedRadius() {
		const latency = p95(this._latencies);
		const loadRadiusM = latency == null ? FALLBACK_RADIUS_M : latency * WORST_MEASURED_SPEED_MS;
		return loadRadiusM;
	}

	async update(dronePos) {
		if (this._lastPos && metersBetween(dronePos, this._lastPos) < REFRESH_THRESHOLD_M) return;
		this._lastPos = dronePos;

		const loadRadiusM = this.nearestTrustedRadius();
		const zone = zoneOf({ lat: dronePos.lat, lon: dronePos.lon, radius: loadRadiusM });
		const { nodes, radius: sphereRadius } = await this._traverse(zone, this._level, {});
		this._sphereRadius = sphereRadius;
		const desired = new Map(nodes.map((n) => [n.path, n]));

		// Centre de la fenêtre en mètres locaux ENU (repère de physics.position,
		// origine fixée au spawn) : c'est ce que la Tâche 10 lit pour le rappel
		// doux, distance(drone, centre) vs nearestTrustedRadius().
		const centerEcef = geodeticToEcef(dronePos.lat, dronePos.lon, 0);
		const local = ecefToLocalEnu(centerEcef, this._originEcef, this._originBasis);
		this.windowCenterLocal = { x: local.x, z: local.z };

		for (const path of this._nodes.keys()) {
			if (desired.has(path)) continue;
			const entry = this._nodes.get(path);
			if (entry.status === 'pending') entry.controller.abort();
			else this._onNodeReleased(path);
			this._nodes.delete(path);
		}

		for (const [path, meta] of desired) {
			if (this._nodes.has(path)) continue;
			const controller = new AbortController();
			this._nodes.set(path, { status: 'pending', controller });
			const t0 = performance.now();
			this._fetchNode(meta, { signal: controller.signal })
				.then((result) => {
					if (!this._nodes.has(path)) return;   // libéré entre-temps
					this._latencies.push(performance.now() - t0);
					if (this._latencies.length > LATENCY_SAMPLES) this._latencies.shift();
					this._nodes.set(path, { status: 'ready' });
					this._onNodeReady(path, result.matrix, result.meshes, this._sphereRadius);
				})
				.catch(() => {
					// 404/410 (nœud absent, normal pour le protocole) ou abort :
					// dans les deux cas, rien à afficher. this._nodes est déjà
					// nettoyé par la boucle de libération ci-dessus si c'était un
					// abort ; sinon on le retire ici.
					this._nodes.delete(path);
				});
		}
	}
}
```

`performance.now()` est global dans un navigateur ; en Node (pour ce selftest), disponible via `perf_hooks` implicitement globalisé depuis Node 16 — vérifier à Step 4 que ça tourne tel quel sans import supplémentaire.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `node tools/rocktree-window-selftest.mjs`
Expected: PASS. Si `performance is not defined` : ajouter `import { performance } from 'node:perf_hooks';` en tête de `rocktree-window.js` — Node l'expose globalement depuis la version 16, mais le confirmer plutôt que le supposer (`node --version` dans ce projet, `.nvmrc` ou `package.json engines` s'il y en a un).

- [ ] **Step 5: Ajouter au pipeline `selftest:operator`**

Insérer `node tools/rocktree-window-selftest.mjs` dans `package.json`, après `node tools/rocktree-fence-selftest.mjs` (Tâche 4).

Run: `npm run selftest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rocktree-window.js tools/rocktree-window-selftest.mjs package.json
git commit -m "feat(rocktree): fenêtre de streaming — politique de charge/décharge par position (#168)"
```

---

## Task 8 : `tools/lib/rocktree/geodesy.mjs` — sphère rocktree → ECEF WGS84 → local ENU

**Découvert en écrivant la Tâche 9 (pas anticipé par la spec) :** la
géométrie d'un nœud rocktree n'est PAS directement en ECEF exploitable.
`tools/lib/decoders/rocktree.mjs` (le décodeur Node déjà utilisé par
`add-map`, qui bake déjà des cartes source Google Earth) montre la chaîne
complète : sommets bruts → `node.matrix` → point sur une SPHÈRE (pas
l'ellipsoïde WGS84) → correction sphère→ellipsoïde (`sphereToWgs84Ecef`,
qui existe précisément parce qu'une lecture naïve sphère-comme-ellipsoïde a
mesuré 5 km d'erreur sur #18 Task 9) → ECEF WGS84 vrai. Rien de tout ça
n'était câblé dans les Tâches 7/9 telles qu'écrites au premier passage.

**Files:**
- Create: `tools/lib/rocktree/geodesy.mjs`
- Modify: `tools/lib/decoders/rocktree.mjs` (réimporte au lieu de redéfinir)
- Test: `tools/rocktree-geodesy-selftest.mjs` (nouveau)

**Interfaces:**
- Produces: `sphereToWgs84Ecef(x, y, z, radius) -> [x, y, z]`, `ecefToGeodetic(x, y, z) -> { lat, lon, alt }` (degrés), `geodeticToEcef(latDeg, lonDeg, alt = 0) -> [x, y, z]` (nouveau — n'existait nulle part : `prep.mjs` n'en a jamais eu besoin, ses origines viennent déjà en ECEF de la source Flyover), `enuBasis(latDeg, lonDeg) -> { east, up, south }`, `ecefToLocalEnu(ecef, originEcef, basis) -> { x, y, z }`, `localEnuToEcef({x, y, z}, originEcef, basis) -> [x, y, z]` (l'inverse — nécessaire à Tâche 10 pour reconvertir `physics.position` en lat/lon chaque frame).
- Consumed by: Tâche 9 (`buildNodeMesh`) et Tâche 10 (`bootLive`, pour l'origine du spawn ET la reconversion position->lat/lon à chaque frame).

**Ne touche PAS `tools/prep.mjs`.** CLAUDE.md : « Do not re-derive or
replace its ECEF→ENU… logic without reason. » `prep.mjs` garde sa propre
`ecefToGeodetic`/`enuBasis` privées, inchangées — ce module est un chemin
INDÉPENDANT pour le rendu live, pas un remplacement du pipeline de prep. La
petite duplication de formule (WGS84, une douzaine de lignes bien connues)
est délibérée et moins risquée qu'importer/coupler au module protégé.

- [ ] **Step 1: Écrire le test qui échoue**

Create: `tools/rocktree-geodesy-selftest.mjs`

```js
// Selftest de la géodésie rocktree live (#168) : sphère -> ECEF WGS84 ->
// géodésique, et son inverse pour l'origine du spawn.
import assert from 'node:assert/strict';
import { sphereToWgs84Ecef, ecefToGeodetic, geodeticToEcef, enuBasis, ecefToLocalEnu, localEnuToEcef } from './lib/rocktree/geodesy.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('geodeticToEcef -> ecefToGeodetic fait un aller-retour (Tour Eiffel, alt 0)', () => {
	const lat = 48.8584, lon = 2.2945;
	const [x, y, z] = geodeticToEcef(lat, lon, 0);
	const back = ecefToGeodetic(x, y, z);
	assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${back.lat} vs ${lat}`);
	assert.ok(Math.abs(back.lon - lon) < 1e-6, `lon ${back.lon} vs ${lon}`);
	assert.ok(Math.abs(back.alt) < 1e-3, `alt ${back.alt}`);
});

t('geodeticToEcef -> ecefToGeodetic fait un aller-retour (altitude non nulle)', () => {
	const lat = 40.0, lon = -3.0, alt = 650;
	const [x, y, z] = geodeticToEcef(lat, lon, alt);
	const back = ecefToGeodetic(x, y, z);
	assert.ok(Math.abs(back.alt - alt) < 1e-3, `alt ${back.alt} vs ${alt}`);
});

t('sphereToWgs84Ecef : un point sur la sphère de rayon connu se corrige vers l\'ellipsoïde', () => {
	// Rayon mesuré (radius de PlanetoidMetadata, capture Paris) : 6 371 010 m.
	// Un point exactement SUR cette sphère à l'équateur, longitude 0.
	const radius = 6371010;
	const [x, y, z] = sphereToWgs84Ecef(radius, 0, 0, radius);
	const g = ecefToGeodetic(x, y, z);
	// À l'équateur, l'ellipsoïde WGS84 a un rayon équatorial de 6 378 137 m —
	// PLUS GRAND que la sphère rocktree (6 371 010 m) : un point sur la sphère
	// est donc SOUS l'ellipsoïde à cette latitude, altitude négative.
	assert.ok(g.alt < 0, `alt ${g.alt} — attendue négative à l'équateur`);
	assert.ok(Math.abs(g.lat) < 1e-6);
});

t('ecefToLocalEnu : le point origine se projette sur (0,0,0)', () => {
	const origin = geodeticToEcef(48.8584, 2.2945, 0);
	const basis = enuBasis(48.8584, 2.2945);
	const local = ecefToLocalEnu(origin, origin, basis);
	assert.ok(Math.hypot(local.x, local.y, local.z) < 1e-6);
});

t('ecefToLocalEnu : un point 100 m plein est se projette sur x≈100, y≈0, z≈0', () => {
	const lat = 48.8584, lon = 2.2945;
	const origin = geodeticToEcef(lat, lon, 0);
	const basis = enuBasis(lat, lon);
	// Déplacement approximatif de 100 m est, en degrés de longitude, à cette latitude.
	const dLon = (100 / (111320 * Math.cos((lat * Math.PI) / 180)));
	const east100 = geodeticToEcef(lat, lon + dLon, 0);
	const local = ecefToLocalEnu(east100, origin, basis);
	assert.ok(Math.abs(local.x - 100) < 1, `x=${local.x}`);
	assert.ok(Math.abs(local.y) < 1, `y=${local.y}`);
	assert.ok(Math.abs(local.z) < 1, `z=${local.z}`);
});

t('localEnuToEcef -> ecefToLocalEnu fait un aller-retour', () => {
	const lat = 48.8584, lon = 2.2945;
	const origin = geodeticToEcef(lat, lon, 0);
	const basis = enuBasis(lat, lon);
	const local = { x: 123.4, y: 56.7, z: -89.0 };
	const ecef = localEnuToEcef(local, origin, basis);
	const back = ecefToLocalEnu(ecef, origin, basis);
	assert.ok(Math.abs(back.x - local.x) < 1e-6, `x ${back.x} vs ${local.x}`);
	assert.ok(Math.abs(back.y - local.y) < 1e-6, `y ${back.y} vs ${local.y}`);
	assert.ok(Math.abs(back.z - local.z) < 1e-6, `z ${back.z} vs ${local.z}`);
});

console.log(`rocktree-geodesy-selftest : ${n} tests ok`);
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node tools/rocktree-geodesy-selftest.mjs`
Expected: FAIL — `Cannot find module './lib/rocktree/geodesy.mjs'`.

- [ ] **Step 3: Écrire `tools/lib/rocktree/geodesy.mjs`**

```js
// Géodésie du rendu rocktree en direct (#168). Chemin INDÉPENDANT de
// tools/prep.mjs, délibérément — CLAUDE.md protège la géodésie de prep.mjs
// (« do not re-derive or replace… without reason ») et prep.mjs n'a de toute
// façon jamais eu besoin de geodeticToEcef (ses origines viennent déjà en
// ECEF de la source Flyover). sphereToWgs84Ecef et ecefToGeodetic sont la
// même formule que tools/lib/decoders/rocktree.mjs (déplacées ici pour être
// réutilisées côté rendu live sans importer un fichier qui tire `sharp`).

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

// Un nœud rocktree place ses sommets sur une SPHÈRE de rayon `radius`
// (PlanetoidMetadata, voir getPlanetoid() dans traverse.mjs), pas
// l'ellipsoïde WGS84 — les deux sont proches mais pas identiques, l'écart
// mesuré est de plusieurs kilomètres si on les confond (issue #18 Task 9).
export function sphereToWgs84Ecef(x, y, z, radius) {
	const r = Math.hypot(x, y, z);
	const lat = Math.asin(z / r), lon = Math.atan2(y, x);
	const alt = r - radius;
	const sl = Math.sin(lat), cl = Math.cos(lat);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
	return [
		(n + alt) * cl * Math.cos(lon),
		(n + alt) * cl * Math.sin(lon),
		(n * (1 - WGS84_E2) + alt) * sl,
	];
}

// ECEF WGS84 -> géodésique (Bowring), en DEGRÉS (pas radians — cohérent avec
// zoneOf()/traverse.mjs qui prennent déjà lat/lon en degrés).
export function ecefToGeodetic(x, y, z) {
	const p = Math.hypot(x, y);
	const th = Math.atan2(z * WGS84_A, p * WGS84_B);
	const lat = Math.atan2(z + WGS84_EP2 * WGS84_B * Math.sin(th) ** 3, p - WGS84_E2 * WGS84_A * Math.cos(th) ** 3);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
	return { lat: (lat * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI, alt: p / Math.cos(lat) - n };
}

// Géodésique -> ECEF WGS84. N'existait nulle part dans ce dépôt avant #168 :
// nécessaire pour situer l'origine du spawn ?live=lat,lon en ECEF, point de
// départ du repère local.
export function geodeticToEcef(latDeg, lonDeg, alt = 0) {
	const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
	const sl = Math.sin(lat), cl = Math.cos(lat);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
	return [
		(n + alt) * cl * Math.cos(lon),
		(n + alt) * cl * Math.sin(lon),
		(n * (1 - WGS84_E2) + alt) * sl,
	];
}

// Repère tangent local à (lat, lon), convention three.js Y-up — MÊME
// convention que prep.mjs (X=est, Y=haut, Z=sud), dupliquée à dessein (voir
// l'en-tête de ce fichier) plutôt qu'importée.
export function enuBasis(latDeg, lonDeg) {
	const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
	const sla = Math.sin(lat), cla = Math.cos(lat);
	const slo = Math.sin(lon), clo = Math.cos(lon);
	return {
		east: [-slo, clo, 0],
		up: [cla * clo, cla * slo, sla],
		south: [sla * clo, sla * slo, -cla],
	};
}

export function ecefToLocalEnu(ecef, originEcef, basis) {
	const d = [ecef[0] - originEcef[0], ecef[1] - originEcef[1], ecef[2] - originEcef[2]];
	const dot = (v, w) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
	return { x: dot(d, basis.east), y: dot(d, basis.up), z: dot(d, basis.south) };
}

// Inverse de ecefToLocalEnu : reconstruit le point ECEF depuis des mètres
// locaux ENU. `basis` est orthonormée (est/haut/sud sont perpendiculaires
// entre eux et de norme 1 — vrai par construction dans enuBasis()), donc la
// reconstruction est une simple combinaison linéaire, pas une inversion de
// matrice.
export function localEnuToEcef({ x, y, z }, originEcef, basis) {
	return [
		originEcef[0] + x * basis.east[0] + y * basis.up[0] + z * basis.south[0],
		originEcef[1] + x * basis.east[1] + y * basis.up[1] + z * basis.south[1],
		originEcef[2] + x * basis.east[2] + y * basis.up[2] + z * basis.south[2],
	];
}
```

- [ ] **Step 4: Faire pointer `tools/lib/decoders/rocktree.mjs` vers le nouveau module**

Dans `tools/lib/decoders/rocktree.mjs`, remplacer les définitions locales de `sphereToWgs84Ecef` et `ecefToGeodetic` (voir l'en-tête du fichier, juste après les imports) par :

```js
import { sphereToWgs84Ecef, ecefToGeodetic } from '../rocktree/geodesy.mjs';
```

Supprimer les constantes `WGS84_A`/`WGS84_F`/`WGS84_B`/`WGS84_E2`/`WGS84_EP2` locales à ce fichier si plus rien d'autre ne les utilise après ce retrait (vérifier par grep avant de les enlever).

- [ ] **Step 5: Vérifier que tout passe**

Run: `node tools/rocktree-geodesy-selftest.mjs`
Expected: PASS.

Run: `node tools/decoder-selftest.mjs` (exerce `tools/lib/decoders/rocktree.mjs`, y compris `sphereToWgs84Ecef`/`ecefToGeodetic` via `loadMeshes()`)
Expected: PASS — aucune régression sur le chemin de prep déjà utilisé pour Nantes/Caen/Versailles.

- [ ] **Step 6: Ajouter au pipeline `selftest:operator`**

Insérer `node tools/rocktree-geodesy-selftest.mjs` dans `package.json`, après `node tools/rocktree-window-selftest.mjs` (Tâche 7).

Run: `npm run selftest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tools/lib/rocktree/geodesy.mjs tools/lib/decoders/rocktree.mjs tools/rocktree-geodesy-selftest.mjs package.json
git commit -m "refactor(rocktree): extrait la géodésie sphère->ECEF->ENU, ajoute geodeticToEcef (#168)"
```

---

## Task 9 : `main.js` — construction Three depuis un nœud rocktree

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Produces: une fonction locale `buildNodeMesh(path, matrix, meshes, sphereRadius, originEcef, basis)` qui convertit la sortie de `RocktreeWindow.onNodeReady` en `THREE.Mesh[]` ajoutés à la scène (déjà dans le repère ENU local, mètres, origine du spawn), et retourne les `{vertices, indices}` par mesh pour `physics.addNodeCollider()`.

Ce n'est pas un module séparé : c'est le câblage entre `RocktreeWindow` (Tâche 7, qui ne connaît ni Three ni Rapier) et le reste de `main.js`. Colocalisé avec la Tâche 10 (l'entrée `?live=`) qui l'appelle — les deux modifient le même fichier, une seule tâche les sépare parce que celle-ci est mécanique (conversion de données) et l'autre est du câblage de flux (spawn, boucle de jeu).

**La chaîne de transformation, dans l'ordre** (voir Tâche 8, découverte en écrivant cette tâche) : sommets bruts uint8 (`unpackVertices`) → appliquer `matrix` (nœud->sphère) → `sphereToWgs84Ecef` (sphère->ellipsoïde WGS84, PAS un no-op — voir Tâche 8) → `ecefToLocalEnu` (ECEF->mètres locaux, origine du spawn). Sauter une étape produirait une géométrie qui compile et s'affiche, mais au mauvais endroit — le genre d'erreur qu'aucun test de structure n'attrape, seul le rendu réel le montre (vérifié Tâche 11).

- [ ] **Step 1: Écrire `buildNodeMesh`**

Dans `src/main.js`, ajouter près des autres fonctions de construction de scène (chercher `function logBuild` pour se repérer, ajouter juste avant) :

```js
// Convertit la sortie de fetchNode() (matrix/copyrightIds/meshes, forme de
// parseNode()) en meshes THREE affichables + géométrie de collision brute,
// pour un nœud rocktree reçu en vol (#168). Un nœud rocktree peut porter
// plusieurs meshes (voir tools/lib/rocktree/proto.mjs:parseMesh) — chacun
// devient son propre THREE.Mesh ET son propre appel à
// physics.addNodeCollider(), avec un chemin de collider dérivé (`${path}#${i}`)
// puisque addNodeCollider() suit un collider par CLÉ, pas par nœud.
//
// matrix (node.matrix) place les sommets sur une SPHÈRE, pas l'ellipsoïde
// WGS84 (voir Tâche 8) — sphereToWgs84Ecef() est la correction, PAS une
// formalité : l'omettre a mesuré 5 km d'erreur sur #18 Task 9.
function buildNodeMesh(path, matrix, meshes, sphereRadius, originEcef, basis) {
	const ma = matrix;
	const built = [];
	meshes.forEach((m, i) => {
		const { xyz, count } = unpackVertices(m.vertices);
		const positions = new Float32Array(count * 3);
		for (let v = 0; v < count; v++) {
			const x = xyz[v * 3], y = xyz[v * 3 + 1], z = xyz[v * 3 + 2];
			const ecef = sphereToWgs84Ecef(
				x * ma[0] + y * ma[4] + z * ma[8] + ma[12],
				x * ma[1] + y * ma[5] + z * ma[9] + ma[13],
				x * ma[2] + y * ma[6] + z * ma[10] + ma[14],
				sphereRadius,
			);
			const local = ecefToLocalEnu(ecef, originEcef, basis);
			positions[v * 3] = local.x; positions[v * 3 + 1] = local.y; positions[v * 3 + 2] = local.z;
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		const strip = unpackIndices(m.indices);
		// Triangle strip -> triangles indépendants : trois sommets consécutifs
		// du strip forment un triangle, en alternant le sens tous les deux pas
		// (convention triangle strip standard).
		const idx = new Uint32Array((strip.length - 2) * 3);
		for (let s = 0; s + 2 < strip.length; s++) {
			if (s % 2 === 0) { idx[s * 3] = strip[s]; idx[s * 3 + 1] = strip[s + 1]; idx[s * 3 + 2] = strip[s + 2]; }
			else { idx[s * 3] = strip[s + 1]; idx[s * 3 + 1] = strip[s]; idx[s * 3 + 2] = strip[s + 2]; }
		}
		geometry.setIndex(new THREE.BufferAttribute(idx, 1));
		geometry.computeVertexNormals();

		const material = m.bitmap
			? new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(m.bitmap) })
			: new THREE.MeshBasicMaterial({ color: 0x808080 });
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `rocktree-${path}-${i}`;
		built.push({ mesh, colliderPath: `${path}#${i}`, vertices: positions, indices: idx });
	});
	return built;
}
```

Ajouter les imports nécessaires en tête de fichier, à côté des autres imports `tools/` déjà présents dans `main.js` (voir `target-model.mjs` importé plus haut pour le motif) :

```js
import { unpackVertices, unpackIndices } from '../tools/lib/rocktree/unpack.mjs';
import { sphereToWgs84Ecef, ecefToLocalEnu } from '../tools/lib/rocktree/geodesy.mjs';
```

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check src/main.js`
Expected: pas de sortie. (Ce check ne peut PAS s'exécuter — `main.js` est du code navigateur de bout en bout — il vérifie seulement la syntaxe.)

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(rocktree): buildNodeMesh(), convertit un nœud rocktree en géométrie THREE (#168)"
```

---

## Task 10 : `main.js` — entrée `?live=lat,lon`

**Files:**
- Modify: `src/main.js`

**Périmètre volontairement restreint** (voir Global Constraints) : pas de météo, pas de `Geofence`/`DistantGround`, pas d'écran de crédit, pas d'AUTOMATED ANALYSIS. Le but est un drone qui vole sur un flux rocktree en direct, pas une parité complète avec le boot d'une scène pré-cuite. `finishBoot()` existant n'est PAS réutilisé : il suppose `manifest.bbox` (pour `Geofence`/`DistantGround`) et un `collision.bin` déjà entièrement là (pour `generateEntryState`), aucun des deux n'existant en mode direct.

**Interfaces:**
- Consumes: `RocktreeWindow` (Tâche 7), `buildNodeMesh` (Tâche 9), `geodeticToEcef`/`enuBasis` (Tâche 8), `physics.addNodeCollider`/`removeNodeCollider` (Tâche 3), `push`/`rocktree-fence.js` (Tâche 4).

- [ ] **Step 1: Ajouter `OPTS.live`**

Dans `src/main.js`, dans l'objet `OPTS` (chercher `export const OPTS = {`), ajouter :

```js
	// Dev-only : ?live=48.8584,2.2945 vole en direct depuis rocktree, sans
	// scène pré-cuite (#168). Pas de météo/geofence/écran de crédit — voir le
	// plan d'implémentation pour ce qui est volontairement hors périmètre.
	live: params.has('live') ? params.get('live').split(',').map(Number) : null,
```

- [ ] **Step 2: Écrire `bootLive()`**

Ajouter, juste après la fonction `boot(slug)` existante :

```js
// Niveau d'octree constant pour ce jalon (Global Constraints) — la vraie
// sélection de LOD par distance/altitude reste un ticket de suivi. 21 :
// ZOOM_TO_LEVEL[20] dans google-earth.mjs — le niveau que produit le zoom
// par défaut d'`add-map` (CLAUDE.md, --zoom 20), donc déjà le niveau que
// toutes les cartes existantes utilisent couramment.
const ROCKTREE_LEVEL = 21;

// Boot minimal pour ?live=lat,lon (#168) : pas de manifest, pas de
// collision.bin, pas de météo. Origine ENU fixée UNE FOIS ici, au point de
// spawn — pas de recentrage en vol (hors périmètre, voir la spec).
async function bootLive([lat, lon]) {
	const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	// Spawn à 80 m au-dessus du point demandé : aucun relief n'est encore
	// chargé au moment de la construction de Physics (le premier nœud rocktree
	// arrive de façon asynchrone, après), donc pas de hauteur de terrain
	// connaissable ici. 80 m est CHOISI — assez pour dominer un immeuble
	// parisien courant, à revoir si un terrain plus haut est visé.
	physics = new Physics(emptyCollision, { x: 0, y: 80, z: 0 }, PROFILE ? { profile: PROFILE } : {});
	PROFILE = physics.profile;
	audio.setProfile(physics.profile);
	flightEnd.landing.THR_IDLE = idleThrottle(physics.profile);

	const rocktreeWindow = new RocktreeWindow({
		level: ROCKTREE_LEVEL,
		origin: { lat, lon },
		onNodeReady: (path, matrix, meshes, sphereRadius) => {
			const built = buildNodeMesh(path, matrix, meshes, sphereRadius, rocktreeWindow.originEcef, rocktreeWindow.originBasis);
			for (const { mesh, colliderPath, vertices, indices } of built) {
				scene.add(mesh);
				physics.addNodeCollider(colliderPath, vertices, indices);
				liveMeshes.set(colliderPath, mesh);
			}
		},
		onNodeReleased: (path) => {
			for (const [colliderPath, mesh] of [...liveMeshes.entries()]) {
				if (!colliderPath.startsWith(`${path}#`)) continue;
				scene.remove(mesh);
				mesh.geometry.dispose();
				mesh.material.dispose();
				physics.removeNodeCollider(colliderPath);
				liveMeshes.delete(colliderPath);
			}
		},
	});
	liveWindow = rocktreeWindow;
	// Amorce la fenêtre autour du spawn avant la première frame : sans ce
	// premier appel, le drone tombe dans le vide jusqu'au premier update()
	// de la boucle de rendu.
	await rocktreeWindow.update({ lat, lon });

	audio.start();
	renderer.compile(scene, camera);
	hud.hide();
}
```

Déclarer `liveMeshes` et `liveWindow` près des autres variables de session (chercher `let physics` pour se repérer, ajouter à côté) :

```js
const liveMeshes = new Map();   // colliderPath -> THREE.Mesh, mode ?live= (#168)
let liveWindow = null;          // RocktreeWindow actif en mode ?live=, sinon null
```

- [ ] **Step 3: Câbler le rappel doux et `rocktreeWindow.update()` dans la boucle de vol**

Dans la boucle de physique de `main.js` (chercher `fence.update(physics.position);`, la boucle qui applique déjà le rappel de zone existant), ajouter juste après le bloc `if (fence.out.zone !== FENCE_OK && !flightEnd.out.linkDead) { ... }` (avant `const impact = physics.step(...)`) :

```js
			if (liveWindow) {
				const dronePos = physics.position;
				const centerLocal = liveWindow.windowCenterLocal;
				if (centerLocal) {
					const dist = Math.hypot(dronePos.x - centerLocal.x, dronePos.z - centerLocal.z);
					const a = rocktreeFencePush(dist, liveWindow.nearestTrustedRadius());
					if (a > 0) {
						const dx = dronePos.x - centerLocal.x, dz = dronePos.z - centerLocal.z;
						const len = Math.hypot(dx, dz) || 1;
						const m = physics.profile.mass;
						// fenceForce peut déjà être posé par le rappel de zone
						// ci-dessus (mode scène) ; en mode ?live= fence est toujours
						// NOMINAL (pas de Geofence construite), donc fenceForce est
						// encore null ici — les deux rappels ne se cumulent jamais.
						_fenceForce.x = -(dx / len) * a * m;
						_fenceForce.z = -(dz / len) * a * m;
						_fenceForce.y = 0;
						fenceForce = _fenceForce;
					}
				}
				// Ne bloque jamais la frame de rendu : la fenêtre se recalcule en
				// tâche de fond, la frame courante vole avec ce qui est déjà là.
				// physics.position (mètres ENU locaux) -> lat/lon : inverse exact
				// de la conversion que buildNodeMesh fait dans l'autre sens
				// (Tâche 8/9), pas une formule ad hoc.
				const droneEcef = localEnuToEcef(dronePos, liveWindow.originEcef, liveWindow.originBasis);
				const droneGeo = ecefToGeodetic(...droneEcef);
				liveWindow.update({ lat: droneGeo.lat, lon: droneGeo.lon });
			}
```

Ajouter l'import `push` renommé pour éviter la collision avec le rappel de zone existant, et la géodésie inverse :

```js
import { push as rocktreeFencePush } from './rocktree-fence.js';
import { RocktreeWindow } from './rocktree-window.js';
import { localEnuToEcef, ecefToGeodetic } from '../tools/lib/rocktree/geodesy.mjs';
```

- [ ] **Step 4: Brancher `?live=` sur le point d'entrée**

Dans `chooseScene()` (ou l'équivalent qui décide du premier écran — chercher `if (OPTS.scene)`), ajouter avant ce bloc :

```js
	if (OPTS.live) {
		await bootLive(OPTS.live);
		return null;   // pas de slug : le reste du pipeline scène ne doit pas s'exécuter
	}
```

Vérifier l'appelant de `chooseScene()` (probablement dans une fonction `startup()` ou similaire) : un retour `null` doit court-circuiter proprement tout ce qui suit (chargement de scène, TARGET SCAN) sans lever. Si l'appelant ne gère pas un retour `null` aujourd'hui, ajouter la garde à cet endroit précis plutôt que de complexifier `chooseScene()`.

- [ ] **Step 5: Vérifier la syntaxe**

Run: `node --check src/main.js`
Expected: pas de sortie.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat(main): entrée ?live=lat,lon, vol direct sur rocktree streamé (#168)"
```

---

## Task 11 : vérification en direct dans le navigateur

**Files:** aucun fichier modifié — vérification uniquement.

Comme la tranche précédente (Tâche 8 de son plan), rien ici ne se laisse vérifier par un test Node : Worker réel, `fetch()` réel, Rapier réel, tous ensemble.

- [ ] **Step 1: Démarrer un serveur de dev dédié à ce worktree**

```bash
ln -sf ~/dev/FPVThePlanet/sim/node_modules node_modules
ln -sf ~/dev/FPVThePlanet/sim/public/scenes public/scenes
npx vite --port 5176 &
```

Attendre `curl -sI http://localhost:5176/` → `200 OK`.

- [ ] **Step 2: Ouvrir `?live=` sur un point réel**

Avec un outil de contrôle navigateur (chrome-devtools MCP, comme les tranches précédentes) : `navigate_page` vers `http://localhost:5176/?live=48.8584,2.2945` (Tour Eiffel — zone dont la capture rocktree existe déjà dans `sim/.cache/google-earth/`, donc les epochs ont de bonnes chances d'être encore valides).

- [ ] **Step 3: Observer, sur plusieurs secondes**

```js
async () => {
	await new Promise((r) => setTimeout(r, 5000));
	const sim = window.__sim;
	return {
		hasPhysics: !!sim?.physics,
		nodeMeshCount: sim?.scene?.children.filter((c) => c.name?.startsWith('rocktree-')).length ?? 0,
		position: sim?.physics ? { x: sim.physics.position.x, y: sim.physics.position.y, z: sim.physics.position.z } : null,
	};
}
```

Expected : `nodeMeshCount > 0` — au moins un nœud rocktree affiché après 5 s. Si 0, vérifier la console (`list_console_messages`) pour un 404 d'epoch périmé — même diagnostic que Tâche 8 Step 4 de la tranche précédente (repartir de `PlanetoidMetadata` pour un epoch frais).

- [ ] **Step 4: Piloter et vérifier la collision**

Envoyer des sticks vers l'avant (`window.__sim.setInput({throttle: 0.6, pitch: -0.3, roll: 0, yaw: 0})`), attendre quelques secondes, vérifier que `physics.position.y` reste au-dessus du sol rocktree (ne traverse pas silencieusement un nœud sans collider) — comparer à un `physics.groundBelow(x, y, z)` juste en dessous de la position courante.

- [ ] **Step 5: Nettoyer**

```bash
pkill -f "vite --port 5176"
```

- [ ] **Step 6: Consigner dans HANDOFF.md**

Ligne dans la section état vérifié : fenêtre de streaming + collision progressive (#168, #170) vérifiées en vol le `<date>`, `?live=<lat>,<lon>`, `<nodeMeshCount>` nœud(s) affiché(s) après 5 s, collision tenue pendant `<durée>` de vol piloté.

- [ ] **Step 7: Commit**

```bash
git add sim/HANDOFF.md
git commit -m "docs(rocktree): fenêtre de streaming + collision progressive vérifiées en vol (#168, #170)"
```
