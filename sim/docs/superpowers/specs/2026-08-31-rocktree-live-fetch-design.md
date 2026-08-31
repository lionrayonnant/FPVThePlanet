# Rocktree en direct : fetch + décodage dans le navigateur

Issue [#168](https://github.com/lionrayonnant/FPVTP/issues/168) — 2026-08-31

Première tranche d'un projet plus large (voler n'importe où sur Terre sans
`add-map`). Ce document ne couvre QUE le fetch et le décodage d'un nœud
rocktree en direct, dans le navigateur, pendant le vol. Les autres tranches —
sélection de LOD par position de vol, origine flottante, collision progressive
par nœud, nouvelle entrée de jeu — sont hors périmètre : chacune aura son
propre cycle brainstorm → spec → plan, une fois celle-ci en place.

## Le problème

Le pipeline actuel n'a qu'un mode : tout cuire d'un coup, avant de voler.
`tools/lib/decoders/rocktree.mjs` et `tools/lib/providers/google-earth.mjs`
savent déjà parler le protocole rocktree — c'est ce que `npm run add-map`
utilise pour une carte source Google Earth (#18) — mais uniquement comme
étape de préparation, en Node, écrite une fois sur `public/scenes/<slug>/`.
Rien de tout ça ne tourne pendant le vol.

Le protocole lui-même n'a pourtant pas ce problème : rocktree EST un format de
streaming (c'est tout le sens de l'octree et de sa traversée par bulks, #153).
C'est le pipeline de ce dépôt qui l'aplatit en un bake statique.

## Ce qui est déjà vérifié, pas supposé

Deux inconnues techniques auraient pu bloquer ce projet avant même de
commencer. Les deux sont vérifiées, pas devinées :

**CORS.** `_net.http()` (`tools/lib/providers/google-earth.mjs:31`) fait un
`fetch()` nu vers `https://kh.google.com/rt/earth/…`, sans clé ni en-tête
d'auth. Testé en direct depuis un navigateur (origine `localhost:5174`, donc
différente de `kh.google.com`) le 2026-08-31 :

```
fetch('https://kh.google.com/rt/earth/PlanetoidMetadata')
→ 200, 13 octets, en-têtes lisibles (pas de réponse opaque)
  vary: Origin, X-Origin, Referer
```

`vary: Origin` : Google fait varier la réponse selon l'origine de la requête,
ce qui n'a de sens QUE si des origines différentes de `kh.google.com`
appellent déjà ce endpoint — cohérent avec leur propre visionneuse web. Pas de
proxy nécessaire.

**Portabilité du décodeur.** `tools/lib/rocktree/proto.mjs`, `unpack.mjs`,
`octant.mjs` n'importent rien de `node:*`. Mais un grep complet (pas la
première recherche, incomplète) trouve SIX appels spécifiques à `Buffer`
Node répartis sur trois fichiers :

| appel | fichier | usage |
|---|---|---|
| `buf.readDoubleLE(pos.i)` | `pb.mjs:26` | champ wire-type 1 (64 bits) |
| `buf.readFloatLE(pos.i)` | `pb.mjs:28` | champ wire-type 5 (32 bits) |
| `Buffer.alloc(0)` ×2 | `proto.mjs:43-44` | repli si le champ est absent |
| `.toString('utf8')` | `proto.mjs:85` | `parseCopyrights()`, texte des copyrights |
| `buf.readUInt16LE(0)`/`(2)` | `unpack.mjs:22` | en-tête des coordonnées de texture |
| `Buffer.from(await res.arrayBuffer())` | `google-earth.mjs:34` | retour de `_net.http()` |

`buf.subarray(...)` (wire-type 2, len-delimited) est déjà portable :
`Uint8Array.prototype.subarray` existe nativement.

## Architecture

### Les parsers deviennent runtime-agnostiques

`pb.mjs`, `proto.mjs`, `unpack.mjs` : les six appels du tableau ci-dessus sont
remplacés par leurs équivalents `DataView`/`Uint8Array`/`TextDecoder`
natifs (`new DataView(buf.buffer, ...).getFloat64(...)`, `new Uint8Array(0)`,
etc.). Un seul décodeur, deux appelants :

- `tools/prep.mjs` (Node, via `google-earth.mjs`, inchangé sinon) ;
- le nouveau chemin navigateur ci-dessous.

`tools/rocktree-selftest.mjs` (déjà là, tourne contre les fixtures figées de
`tools/testdata/rocktree/`, capture Paris epoch 1014) reste la vérification
principale : si la réécriture casse le décodage, ce selftest le dit — en
Node, sans navigateur.

### `src/rocktree-worker.js` — nouveau

Miroir de `src/worker.js` (le worker qui décode déjà les planches JPEG des
chunks pré-cuits). Reçoit `{ path, epoch, signal }`, fait le `fetch()` vers
`kh.google.com`, parse le NodeData avec les modules ci-dessus, décode la ou
les texture(s) JPEG du nœud via `createImageBitmap()` — **pas `sharp`** : le
JPEG brut extrait du protobuf va directement au décodeur JPEG natif du
navigateur, le même chemin que `worker.js` emprunte déjà pour les chunks
pré-cuits. La réparation des texels noirs (#158, qui utilise `sharp` côté
Node) reste une passe de qualité pour le bake ; elle n'est pas requise pour
qu'un nœud s'affiche et n'est pas dans ce périmètre.

### `tools/lib/rocktree/url.mjs` — nouveau, extrait de `google-earth.mjs`

`nodeUrl({ path, epoch, imageryEpoch, flags })` (aujourd'hui privée dans
`google-earth.mjs:165`) construit l'URL `NodeData` — avec la garde sur
`imageryEpoch` qui évite un `!3unull` (404 garanti, voir le commentaire en
place). Elle ne dépend de rien de Node : extraite dans ce nouveau fichier avec
`PREFIX`, importée par `google-earth.mjs` (qui perd sa copie privée) ET par
`rocktree-worker.js` ci-dessous. Un seul endroit qui sait construire cette
URL, comme pour les parsers.

### `src/rocktree-loader.js` — nouveau

Miroir de `loadChunks()` dans `loader.js`. Expose une seule fonction :

```js
fetchNode({ path, epoch, imageryEpoch, flags }, { signal }) -> Promise<{ matrix, copyrightIds, meshes }>
```

Mêmes quatre champs que `nodeUrl()` en entrée — l'appelant les a déjà
(c'est ce qu'une traversée de `BulkMetadata` produit). Sortie : exactement la
forme que `parseNode()` produit déjà (`{ matrix, copyrightIds, meshes }`,
chaque mesh portant `vertices`, `indices`, `texCoords`, `texture`), décodée
par un chemin qui tourne dans un Worker navigateur. Ce module ne sait RIEN de
la position du drone ni d'une fenêtre de streaming — ce sera le problème de
la tranche suivante. Frontière nette : testable seule, remplaçable seule.

**`signal` ne traverse PAS `postMessage()`.** Un `AbortSignal` n'est pas
clonable par l'algorithme de clonage structuré — l'envoyer à un Worker
échouerait. `rocktree-worker.js` ne connaît donc aucun signal : il reçoit
`{ path, epoch, imageryEpoch, flags }` et fait son travail sans condition.
L'annulation reste sur le fil principal, dans `rocktree-loader.js`, exactement
comme `loader.js` le fait déjà pour les chunks pré-cuits (`worker.terminate()`
dans `dropPreloadsExcept()`) : si `signal` se déclenche avant la réponse,
`fetchNode()` appelle `worker.terminate()` et rejette sans jamais avoir
prétendu transporter le signal plus loin.

**Ce que `fetchNode` NE rend PAS, volontairement :**

- **`bbox`** — dérivable par l'appelant depuis `path` seul, via
  `octant.mjs:rootOctant()`/`descendBox()`, déjà écrites et déjà pures.
  Rien à décoder pour ça ; le recalculer ici dupliquerait une fonction qui
  existe déjà.
- **« quels enfants existent »** — PAS un champ simple. Le protocole sépare
  deux mécanismes : `BulkMetadata` (`fetchBulk()`, `google-earth.mjs:155`,
  une requête séparée qui groupe plusieurs niveaux d'octree et dit quels
  chemins existent) pour savoir QUOI fetcher ensuite, et
  `layerAndOctantCounts` sur chaque mesh de `parseNode()` pour savoir quels
  octants d'UN nœud déjà reçu portent de la géométrie. La tranche suivante
  (LOD/traversée) doit porter `fetchBulk()` aussi — pas seulement
  `fetchNode()` — pour pouvoir marcher dans l'octree. Le signaler ici plutôt
  que de le découvrir en implémentant la suite.

`signal` (`AbortController`) est le motif déjà utilisé par `fetchBulk()`
(`google-earth.mjs:155`) — réutilisé tel quel. Une requête pour un nœud
devenu non pertinent (le drone s'est éloigné avant que la réponse arrive)
s'annule proprement, sans traitement spécial ici : c'est l'appelant qui décide
quand annuler.

## Vérification

- Les parsers réécrits : `node tools/rocktree-selftest.mjs` contre les
  fixtures existantes — aucune régression sur le chemin Node (`prep.mjs`).
- Le Worker + `fetch()` réel : vérifié en navigateur, comme le test CORS
  ci-dessus. Pas de mock à ce niveau — c'est justement le réseau réel qui est
  la question.

## Hors périmètre (tranches suivantes)

- Sélection de LOD / fenêtre de streaming par position, altitude, vitesse de
  vol — qui appelle `fetchNode()`, quand, à quelle profondeur d'octree.
- Origine flottante : le repère ENU local à origine fixe (CLAUDE.md) ne tient
  plus pour « voler n'importe où sur Terre ».
- Collision progressive par nœud : convertir la géométrie reçue en collider
  Rapier, l'ajouter/le retirer du monde physique.
- Nouvelle entrée de jeu : comment le joueur choisit un point de départ.
