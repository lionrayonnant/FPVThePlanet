# Fenêtre de streaming rocktree + collision progressive

Issue [#168](https://github.com/lionrayonnant/FPVThePlanet/issues/168) (fermée, tranche
précédente) — sous-projet suivant, 2026-09-01. Résout aussi
[#170](https://github.com/lionrayonnant/FPVThePlanet/issues/170) (Worker par nœud trop
coûteux pour du streaming continu).

Deuxième tranche du projet « voler n'importe où sur Terre sans `add-map` ».
`fetchNode()` (tranche précédente, mergée) sait fetch/décoder UN nœud déjà
connu. Cette tranche transforme ça en monde traversable : quels nœuds charger
pendant que le drone bouge, et leur donner une collision Rapier réelle.

Hors périmètre, assumé pour ce jalon (voir la discussion qui a mené à ce
document) :
- **Origine fixe au spawn.** Pas de recentrage du repère ENU en vol —
  ticket séparé quand la dérive de précision flottante se fera sentir.
- **Entrée en jeu par `?live=lat,lon`.** Pas de nouvel écran ; un paramètre
  dev, comme `?scene=` aujourd'hui.
- **Niveau d'octree fixe.** La vraie sélection de LOD par distance/altitude
  (l'ambition d'origine de #148) reste un ticket de suivi une fois qu'on
  observe le comportement réel en vol avec un niveau constant.

## Le problème

`traverse(zone, level, {signal})` (#153, dans `tools/lib/providers/
google-earth.mjs`) marche dans l'octree et rend TOUS les nœuds d'une zone
d'un coup — conçu pour le prep (`npm run add-map` : une zone fixe, tout
téléchargé une fois). Rien n'y décide quoi charger MAINTENANT selon une
position qui bouge, ni quoi décharger quand elle s'éloigne.

`physics.js` construit un seul trimesh Rapier, une fois, dans le
constructeur de `Physics` — depuis `collision.vertices`/`collision.indices`
d'un `collision.bin` déjà entièrement là. Rien n'ajoute ou ne retire un
collider en cours de vol.

Et un problème découvert en implémentant la tranche précédente : `fetchNode()`
crée et détruit un Worker module par appel (#170). Correct pour un chargement
de scène ponctuel (`loadChunks()` fait pareil), faux dès que l'appel se
répète en continu pendant le vol — le coût de démarrage du Worker dominera.

## Ce qui est déjà vérifié

**Portabilité de `traverse()` et de ce qui l'entoure.** Grep ciblé sur les
fonctions elles-mêmes (pas sur le fichier entier) : `traverse()`,
`fetchBulk()`, `expandBulk()`, `dropFillinAncestors()`, `getPlanetoid()`,
`zoneOf()`, `zoomToLevel()`, `_net` — zéro usage de `fs`/`path`/
`fileURLToPath` À L'INTÉRIEUR de ces fonctions. Elles ne dépendent de Node
QUE parce qu'elles vivent dans `google-earth.mjs`, qui importe `node:url`
en tête de fichier pour `SIM_ROOT`/`CACHE_ROOT` — sans rapport, mais un
import ESM statique casse tout le module dans un navigateur qu'il soit
utilisé ou non. Même situation que `nodeUrl()` dans la tranche précédente,
en plus large.

## Architecture

### `tools/lib/rocktree/traverse.mjs` — nouveau, extrait de `google-earth.mjs`

Déménagent, inchangés : `_net`, `traverse()`, `fetchBulk()`, `expandBulk()`,
`dropFillinAncestors()`, `getPlanetoid()`, `zoneOf()`, `zoomToLevel()`.
Importent `PREFIX` de `tools/lib/rocktree/url.mjs` (déjà là, tranche
précédente). `google-earth.mjs` les réimporte pour son usage `add-map` — le
comportement Node ne change pas, seul l'endroit où le code vit change.

### `src/rocktree-worker.js` — modifié, plus persistant

Aujourd'hui : `self.onmessage` traite UN message puis le worker est terminé
par l'appelant. Devient : chaque message porte un `id` ; le worker répond
`{ id, ok, ... }` et reste vivant pour le message suivant. Le corps du
traitement (fetch + `parseNode` + `createImageBitmap`) ne change pas — seule
la forme du message et la durée de vie changent.

### `src/rocktree-worker-pool.js` — nouveau

Un pool de taille fixe (`POOL_SIZE`, même ordre de grandeur que
`MAX_CONCURRENT = 3` dans `loader.js`) de Workers `rocktree-worker.js`,
créés une fois et jamais détruits pendant le vol. Distribue les requêtes par
`id` (compteur incrémental), une `Map<id, {resolve, reject}>` pour retrouver
la promesse en attente à la réponse. Expose :

```js
fetchNode({ path, epoch, imageryEpoch, flags }, { signal }) -> Promise<{ matrix, copyrightIds, meshes }>
```

Même signature que l'actuel `fetchNode()` de `rocktree-loader.js` — les
appelants ne changent pas. `rocktree-loader.js` devient un mince adaptateur
qui délègue au pool ; il n'ouvre plus de Worker lui-même. `signal` annule
toujours sur le fil principal (toujours pas clonable par `postMessage`),
mais annuler ne termine plus le worker (il est partagé) — juste rejeter la
promesse en attente et laisser la réponse arriver sans destinataire.

### `src/rocktree-window.js` — nouveau, la politique

État tenu : `Map<path, { status: 'pending' | 'ready', mesh, colliderPath }>`
(la clé sert aussi de handle pour `physics.removeNodeCollider()`), la
dernière position où la fenêtre a été recalculée, un historique glissant des
latences `fetchNode()` récentes (mesurées de bout en bout par l'appelant,
pas par le worker — ce qui compte pour le rayon est le temps total avant
qu'un collider soit vivant, pas le détail fetch/décode).

```js
update(dronePos)   // { lat, lon } — appelé chaque frame par main.js, no-op la plupart du temps
```

Ne fait quelque chose que si `distance(dronePos, lastComputedPos) >
REFRESH_THRESHOLD_M` :

1. `radius = p95(latencySamples) × WORST_SPEED_MS` — même formule que
   `R_CAUTION` dans `geofence.js` (`R_HOLD + délai × vitesse`), ici sans le
   terme fixe puisqu'il n'y a pas de délai de lecture d'OSD à couvrir.
   `WORST_SPEED_MS` réutilise la pire vitesse mesurée par famille
   (`geofence-measure.mjs`, race5, 42,72 m/s à 85° — voir `src/geofence.js`)
   plutôt que d'inventer un nouveau chiffre.
2. `zone = zoneOf({ lat, lon, radius })`, `level = ROCKTREE_LEVEL` (constante
   fixe, voir hors périmètre).
3. `traverse(zone, level, { signal })` → nœuds désirés.
4. Diff contre `Map` déjà chargée : `toFetch` (nouveaux), `toRelease`
   (sortis).
5. `toRelease` : si `pending`, `signal.abort()` la requête en cours ; si
   `ready`, dispose la géométrie/texture Three (mirroring
   `releaseTileMaterials`/`dropPreloadsExcept`) et `physics.
   removeNodeCollider(path)`. Retrait de la `Map` dans les deux cas.
6. `toFetch` : marqué `pending`, `fetchNode()` via le pool ; à la résolution,
   construit `BufferGeometry`/`Mesh` (même décodage que dans
   `rocktree-worker.js` aujourd'hui — pas dupliqué, voir ci-dessous),
   `physics.addNodeCollider(path, vertices, indices)`, marqué `ready`,
   échantillonne la latence observée.

`nearestTrustedRadius()` : `radius` moins une marge de sécurité — c'est ce
que lit le rappel doux ci-dessous.

### `src/physics.js` — étendu

```js
addNodeCollider(path, vertices, indices) -> void
removeNodeCollider(path) -> void
```

Une `Map<path, RAPIER.Collider>` en plus du trimesh de scène existant.
Plusieurs colliders sur le MÊME `groundBody` fixe déjà créé dans le
constructeur — Rapier le permet nativement, pas besoin d'un corps par nœud.
`addNodeCollider` : `world.createCollider(ColliderDesc.trimesh(vertices,
indices).setFriction(0.9).setRestitution(0.15), groundBody)` — mêmes
réglages que le trimesh de scène pré-cuite, pour un sol qui se comporte
pareil des deux côtés. `removeNodeCollider` : `world.removeCollider(...,
true)`.

### Le rappel doux — circulaire, pas rectangulaire

`geofence.js` gère un rectangle FIXE (la bbox d'une scène pré-cuite).
Ici le centre BOUGE avec le drone — un couloir circulaire convient mieux
qu'un rectangle recalculé sans arrêt. Nouveau, petit, pur :

```js
// src/rocktree-fence.js
import { A_MAX } from './geofence.js';

// Rampe circulaire, même forme que pushOf() dans geofence.js (nulle jusqu'à
// trustedRadius, pleine à trustedRadius + RAMP_M) mais autour d'un centre qui
// suit le drone plutôt qu'une bbox fixe.
//
// RAMP_M est CHOISI, pas mesuré — même statut que HYST_M dans geofence.js et
// pour la même raison : la largeur de rampe la plus sûre dépend de ce que le
// vol réel produit comme dépassement, qu'on ne connaît pas encore. À revoir
// une fois qu'on observe le comportement réel en vol (voir Vérification).
const RAMP_M = 20;

export function push(distanceFromCenter, trustedRadius) {
	if (distanceFromCenter <= trustedRadius) return 0;
	if (distanceFromCenter >= trustedRadius + RAMP_M) return A_MAX;
	return A_MAX * (distanceFromCenter - trustedRadius) / RAMP_M;
}
```

`distanceFromCenter` = distance entre la position courante du drone et
`windowCenter`, la position lat/lon (convertie en mètres locaux) où
`rocktree-window.js` a calculé la fenêtre pour la dernière fois — exposée
par le module (`rocktreeWindow.windowCenter`), pas recalculée ailleurs.
`trustedRadius` = `rocktreeWindow.nearestTrustedRadius()`.

Câblé dans `main.js` exactement comme `fence.out.push` l'est déjà
aujourd'hui : lu chaque pas de physique, converti en force via la masse
réelle, passé au TROISIÈME paramètre de `physics.step()` — jamais un
`addForce()` séparé (`resetForces()` l'effacerait, même contrainte que le
rappel de zone existant, `main.js:982-984`).

## Vérification

- `traverse.mjs` extrait : le selftest existant (`tools/rocktree-selftest.mjs`,
  `tools/provider-selftest.mjs`) reste la référence — aucune régression sur
  le chemin `add-map`.
- Pool de Workers : un test qui envoie plusieurs requêtes concurrentes à un
  seul pool et vérifie que chaque réponse revient à la bonne promesse (par
  `id`), sans navigateur réel nécessaire pour CE test précis (mock du
  Worker) — le comportement réseau reste vérifié en direct comme la tranche
  précédente.
- Collision progressive et rappel doux : vérification en vol réel, comme
  Tâche 8 de la tranche précédente — pas de mock sur ce qui touche
  Rapier + réseau ensemble.

## Ce que ce document n'essaie pas de résoudre

- Sélection de LOD par distance/altitude (niveau d'octree constant ici).
- Origine flottante.
- Nouvelle entrée de jeu (au-delà de `?live=lat,lon`).
- #171 (nits documentaires de la tranche précédente) — sans rapport, déjà
  son propre ticket.
