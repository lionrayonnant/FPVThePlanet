# Support d'un second fournisseur de plans 3D — design

Issue : [#18](https://github.com/lionrayonnant/FPVThePlanet/issues/18) · Milestone P3 · 2026-08-29

## Objectif

Couvrir plus de zones, avec de meilleurs graphismes et des tuiles plus récentes,
en ajoutant un second fournisseur de photogrammétrie à côté d'Apple Flyover.

L'issue demande deux choses : arbitrer l'ordre de priorité entre fournisseurs,
puis implémenter en conséquence. Ce document tranche les deux.

## La contrainte qui structure tout

Les *Map Tiles API Policies* de Google interdisent explicitement ce que fait le
pipeline FPVTP : « you must not pre-fetch, index, store, or cache any Content »,
plus une interdiction séparée de la « geodata extraction » et des « offline
uses ». Or FPVTP télécharge une fois, cuit le résultat dans
`sim/public/scenes/<slug>/`, et le sert indéfiniment.

C'est une situation différente d'Apple Flyover, qui n'expose aucune API publique
dont le projet aurait accepté les conditions. Google en expose une, avec clé et
facturation.

**Le propriétaire du projet déclare disposer d'un accord couvrant le stockage.**
Ce design part de cette base et garde donc Google sur le chemin « bake ». Les
conséquences pratiques : on stocke la date de fetch et la version du fournisseur
pour qu'une éventuelle obligation de rafraîchissement soit mécanisable plus tard,
et on affiche l'attribution.

L'attribution n'est pas négociée à la baisse : la doc Google impose un moteur
de rendu « that supports the display of copyright attribution ». Décision retenue :
**une ligne discrète sur la couche `fpvtp-osd`, appliquée uniformément à tous les
fournisseurs** — Flyover compris, qui n'est crédité nulle part aujourd'hui.
L'OSD in-fiction du drone (`drone-osd.js`) ne porte rien : c'est le « logiciel »
qui crédite, pas l'appareil.

## Ordre de priorité retenu

1. **Google Photorealistic 3D Tiles** — meilleure couverture (49 pays, 2500+
   villes), imagerie la plus récente. Devient le fournisseur par défaut une fois
   le Stage 3 livré.
2. **Apple Flyover** — conservé en repli. Gratuit, déjà fonctionnel, et il couvre
   des endroits que Google ne couvre pas. C'est aussi l'implémentation de
   référence du seam.
3. **Reality meshes sous licence ouverte** — Helsinki (CC-BY 4.0, maillage
   photogrammétrique texturé téléchargeable en OBJ et 3D Tiles), PLATEAU (Japon,
   CityGML). Opportuniste, ville par ville, mais quasi gratuit à brancher une
   fois le seam en place.
4. **OSM + drapé d'orthophoto** — hors scope. Couverture mondiale mais qualité
   graphique incompatible avec la DA ; c'est un autre produit.

À l'ajout d'une carte, la sélection sonde Google d'abord et retombe sur Flyover
en l'absence de couverture. C'est ce qui sert directement l'objectif « couvrir
plus de zones ».

## Architecture

Deux seams distincts, à deux étages différents du pipeline. Les confondre est
l'erreur à éviter : « d'où viennent les octets » et « comment on les décode »
sont deux questions séparées.

### Seam 1 — le fournisseur (`sim/tools/lib/providers/`)

Aujourd'hui `add-map-core.mjs` code en dur `go run cmd/export-obj/main.go` dans
trois fonctions (`planScan`, `probeCoverage`, `addMap`), plus la disposition du
cache dans `tileDirName`/`tileDirPath`, plus des messages d'erreur qui nomment
Apple Flyover.

Chaque fournisseur devient un module exposant :

```js
export const id = 'flyover';               // clé stable, stockée dans les manifests
export const label = 'Apple Flyover';
export const attribution = ['© Apple'];    // défaut ; fetch() peut l'affiner

export function tileDirPath(opts) -> string
export async function plan(opts, { signal }) -> { columns, region, coverage, ... }
export async function probe(opts, { signal })
    -> { status: 'ok' | 'none' | 'undecodable', message, ... }
export async function fetch(opts, { onLog, signal })
    -> { tileDir, attribution: string[], fetchedAt: string }
```

`add-map-core.mjs` ne garde que l'orchestration : choisir le fournisseur,
appeler `fetch`, appeler `prep.mjs`, écrire `scenes.json`.

Les messages d'erreur « hors couverture » descendent dans le fournisseur, où ils
peuvent être justes. Le message actuel sur les tuiles C3M non décodables est
spécifique à Flyover et n'a aucun sens pour Google.

### Seam 2 — le décodeur (`sim/tools/lib/decoders/`)

`prep.mjs` sépare déjà, en pratique, un étage *decode* d'un étage *rebuild* —
`parsePrepLine()` dans `add-map-core.mjs` distingue littéralement les deux
phases. Le seam consiste à rendre cette séparation explicite.

Tout ce qui suit le decode (rebase ECEF→ENU, chunking, texture arrays, mesh de
collision, spawn) ne consomme que ces structures, et **ne change pas** :

```js
export function sniff(tileDir) -> boolean     // ce décodeur sait-il lire ce dossier ?
export async function decode(tileDir, { onLog }) -> {
    materials,   // [{ name, texture }] — texture : chemin relatif ou Buffer
    byName,      // Map<string, number>
    vx, vy, vz,  // Growable(Float64Array) — ECEF
    tu, tv,      // Growable(Float32Array) — UV, axe V déjà inversé
    triByMat,    // par matériau : Growable(Uint32Array), paires (vIdx, uvIdx),
                 // 6 entrées par triangle, déjà fan-triangulé
    vertCount, faceCount,
    attribution, // string[] agrégé et dédupliqué
}
```

Le lecteur OBJ actuel (`parseMtl` + `streamObj` + le parseur de faces au niveau
octet, lignes ~100-280) devient `decoders/obj.mjs`, **déplacé sans être
réécrit**. Un `decoders/gltf.mjs` le rejoint au Stage 3.

`prep.mjs` choisit le décodeur en appelant `sniff()` sur le `tileDir`, et prend
le premier qui reconnaît le dossier — **aucun drapeau ne sélectionne le
décodeur**. Le fournisseur et le format d'entrée restent ainsi découplés : si un
jour un fournisseur sert de l'OBJ, il réutilise le décodeur OBJ sans rien
déclarer.

À distinguer de l'*identité* du fournisseur, que `prep.mjs` reçoit bien en
argument (`--provider`, `--provider-label`, `--attribution`, `--fetched-at`)
parce qu'il doit l'inscrire dans le manifest. Recevoir « qui a fourni les
données » et déduire « comment les lire » sont deux choses séparées.

**D'où vient l'attribution, précisément.** Trois niveaux, du plus faible au plus
fort, chacun écrasant le précédent :

1. `provider.attribution` — constante du module, filet de sécurité (« © Apple »).
2. La valeur rendue par `provider.fetch()` — si le fournisseur apprend quelque
   chose au téléchargement.
3. La valeur rendue par `decoder.decode()` — **fait autorité quand elle est non
   vide**, car c'est la seule qui vient des tuiles réellement cuites. C'est le
   niveau qui porte les `asset.copyright` par tuile de Google, agrégés et
   dédupliqués.

Flyover s'arrête au niveau 1, Google ira jusqu'au niveau 3.

Deux points d'attention relevés dans le code existant :

- L'inversion de l'axe V (`tv.push(1 - tmp[1])`) est une conversion
  OBJ→moteur documentée dans `docs/manual.md` ; elle reste **dans le décodeur
  OBJ**, pas dans le contrat partagé. Un décodeur glTF devra décider de son
  propre chef, glTF ayant déjà l'origine UV en haut à gauche — donc
  vraisemblablement pas d'inversion. C'est le piège le plus probable de ce
  chantier (cf. les « textures grises » de l'historique).
- Les textures : le chemin OBJ fait `sharp(path.join(tileDir, mat.jpg))`
  (ligne ~443). `sharp()` accepte indifféremment un chemin ou un Buffer, donc
  `mat.texture` peut porter l'un ou l'autre et le glTF (textures embarquées)
  n'impose aucune extraction sur disque.

### Schémas

`manifest.json` passe en `version: 3` et gagne :

```json
"provider": { "id": "google", "label": "Google Photorealistic 3D Tiles",
              "attribution": ["..."], "fetchedAt": "2026-08-29T..." }
```

Le viewer lit `provider.attribution` pour la ligne d'OSD. Les manifests
`version: 2` existants sont traités comme `provider.id = "flyover"` avec
l'attribution par défaut du module — aucune re-préparation n'est nécessaire.

Les entrées de `scenes.json` gagnent `provider` et `fetchedAt`, dans le même
esprit additif que le schéma actuel : les entrées historiques restent valides.

## Découpage

Le risque de ce chantier n'est pas le choix d'architecture, c'est de livrer
quatre nouveautés d'un coup (abstraction fournisseur, client 3D Tiles avec clé
et facturation, décodeur glTF, UI d'attribution) sans pouvoir dire laquelle a
cassé. D'où trois étages indépendamment vérifiables.

### Stage 1 — creuser le seam fournisseur, à un seul fournisseur

Extraire `providers/flyover.mjs`, ajouter `provider` aux deux schémas, ajouter
la ligne d'attribution sur `fpvtp-osd` pour tous les fournisseurs.

*Rien de neuf ne se télécharge.* Aucune dépendance externe, aucune clé.

**Vérification** : `npm run selftest` sur une scène déjà bakée passe à
l'identique ; une scène `version: 2` non re-préparée se charge et affiche le
crédit Flyover.

### Stage 2 — expliciter le seam décodeur

Déplacer le lecteur OBJ dans `decoders/obj.mjs` derrière le contrat ci-dessus.

**Vérification** : re-préparer une scène existante produit une sortie
**identique octet pour octet** à l'actuelle. C'est un refactor pur, et ce test
le prouve. Toujours aucune dépendance externe.

### Stage 3 — le fournisseur Google

Client 3D Tiles (`root.json` → traversée par `geometricError` → fetch des glTF),
clé API dans un fichier de config gitignoré, sur le modèle du jeton Apple
existant. Puis `decoders/gltf.mjs`, qui alimente le contrat du Stage 2.

**Vérification** : une scène Google se charge, vole, entre en collision, et
affiche l'attribution agrégée.

Les Stages 1 et 2 peuvent atterrir avant même que la clé Google soit branchée.

## Inconnues à lever au Stage 3

Ces points ne changent pas la structure du design, mais devront être vérifiés
sur pièce plutôt que supposés :

- La doc publique de Google ne spécifie pas le détail wire : compression Draco
  éventuelle, système de coordonnées exact des transforms de tuiles, structure
  précise de `asset.copyright`. À constater sur un vrai `root.json`.
- Le paramètre de session : la doc mentionne « at least three hours of tile
  requests » après une requête de tileset racine, sans détailler sa propagation
  aux URI enfants.
- Le choix du niveau de LOD à cuire. 3D Tiles est un arbre hiérarchique ;
  traverser jusqu'à un seuil de `geometricError` est l'analogue du `--zoom`
  actuel, mais la correspondance exacte est à calibrer sur une zone connue —
  mesurée, pas devinée.
- Ce que l'accord dit précisément d'une obligation de rafraîchissement. Le
  design stocke `fetchedAt` pour rendre la question traitable ; il ne la tranche
  pas.

## Hors scope

- Le chemin streaming temps réel (tuiles jamais persistées). L'accord le rend
  inutile, et il demanderait des colliders Rapier construits et détruits à la
  volée — un sous-système à part entière.
- OSM/procédural.
- Toute migration des scènes existantes : elles restent valides telles quelles.

---

## Amendement 2026-08-31 — le Stage 3 passe par le protocole Earth interne

Le propriétaire a fourni une capture HAR du trafic réel de earth.google.com
(1499 NodeData + 240 BulkMetadata complets). Elle change la voie du Stage 3 :
**pas de Map Tiles API, pas de clé, pas de glTF**. Google Earth web parle son
protocole interne « rocktree », le même que documente
`earth-reverse-engineering` (retroplasma — l'auteur de
`flyover-reverse-engineering` que ce dépôt embarque). La posture est donc
identique à celle de Flyover : un protocole interne sans API souscrite. Les
sections « clé API », « décodeur glTF » et « inconnues à lever sur un vrai
root.json » ci-dessus sont caduques.

### Constaté sur pièce (HAR du 2026-08-31 + deux requêtes live)

- Endpoints : `https://kh.google.com/rt/earth/PlanetoidMetadata`,
  `BulkMetadata/pb=!1m2!1s{octant}!2u{epoch}`,
  `NodeData/pb=!1m2!1s{octant}!2u{epoch}!2e{fmt}[!3u{epochImagerie}]!4b0`,
  `Copyrights/pb=!1u{epoch}`. Aucun jeton, aucun paramètre de session —
  vérifié live (PlanetoidMetadata et Copyrights répondent à nu).
- Epoch racine live : 1014, cohérent avec le HAR. `!2e1` = textures **JPEG
  256×256 embarquées** dans le protobuf — `sharp()` les lit en Buffer,
  chemin déjà prévu par prep.mjs.
- NodeData décodé sur un échantillon du HAR : champ 1 =
  `matrix_globe_from_mesh`, 16 doubles — les sommets (uint8 delta-packés)
  se transforment **directement en ECEF**, exactement ce que le contrat
  décodeur demande (vx/vy/vz Float64 ECEF).
- Attribution par tuile : `NodeData.copyright_ids` + le endpoint `Copyrights`
  (368 entrées id→texte, ex. « Image © 2026 Maxar Technologies ») — le
  niveau 3 du design (l'attribution qui vient des tuiles cuites) est
  réellement implémentable, ce que la Map Tiles API ne garantissait pas mieux.
- Le format de maillage complet (delta-packing, strip d'indices en varints,
  layer_bounds, masque d'octant, OBB, normales) est documenté par le proto et
  le client C++ de `earth-reverse-engineering`. **Ce dépôt n'a pas de licence :
  il sert de documentation de protocole, le code est réécrit, pas copié** —
  son `decode-resource.js` embarque d'ailleurs le décodeur minifié de Google
  lui-même, inutilisable directement.

### Décisions

- **Client Node natif** dans `sim/tools/lib/providers/` + un
  `decoders/rocktree.mjs` — pas de vendoring d'`earth-reverse-engineering`
  (non maintenu depuis 2020, sans licence, sortie OBJ intermédiaire inutile
  quand le contrat décodeur veut de l'ECEF que le protocole donne déjà).
- Le fournisseur s'appelle **`google-earth`** (label « Google Earth ») : le
  manifest dit d'où viennent les octets, et ce ne sont pas ceux de la
  Photorealistic 3D Tiles API.
- Le HAR fournit des **fixtures hors-ligne** pour développer le décodeur en
  TDD sans toucher aux serveurs ; un petit sous-ensemble est figé dans
  `sim/tools/testdata/rocktree/` (le HAR de 114 Mo, lui, ne rentre pas dans
  git).
- L'analogue du `--zoom` est le **niveau d'octree** (les chemins d'octant du
  HAR font 14-16 caractères sur Paris) ; la correspondance zoom↔niveau se
  calibre sur `meters_per_texel` des BulkMetadata d'une zone connue —
  mesurée, pas devinée.
- Le cache brut va dans `sim/.cache/google-earth/<dossier-par-zone>/`
  (gitignoré), symétrique du `downloaded_files/obj/` de Flyover.
- `fetchedAt` : date du téléchargement réel ; sur cache hit, mtime de
  l'index du dossier — même règle que Flyover.
