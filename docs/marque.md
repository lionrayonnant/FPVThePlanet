# La marque FPVTP!

Le symbole est un **cadre interrompu** et une **grille de 5 × 5 modules**. Il ne
dessine rien : c'est un randomart, la signature de session déjà décrite
Bible §26, figée en un motif unique. Il n'a pas d'autre lecture, et c'est
voulu — Bible §1, un artefact plutôt qu'une illustration.

## Géométrie

Tout est posé sur une grille de 100 unités, 16 modules de 6,25.

- cadre : 6 unités d'épaisseur, sur les quatre côtés ;
- interruption : 28 unités de large, centrée, au bord supérieur — c'est là que
  le titre s'inscrit dans un panneau ;
- motif : 5 × 5 cellules de 13, pas de 15,2, décalage de 12 ;
- cellules pleines, par ligne :

```text
. # . . #
# # . # #
. # # # .
# . # . .
# # . . #
```

19 rectangles pleins au total, aucun trait, aucun arrondi, aucun chevauchement.
Le fichier est donc directement extrudable pour une impression 3D
(`fpvtp-mark-extrude.svg`).

## Fichiers

| fichier | usage |
|---|---|
| `sim/public/brand/fpvtp-mark.svg` | `fill="currentColor"` — hérite la couleur du contexte, aucun littéral |
| `sim/public/brand/fpvtp-icon.svg` | icône d'application, fond `--black` inclus |
| `sim/public/brand/fpvtp-mark-extrude.svg` | extrusion 3D, noir sur transparent |

### Exports matriciels

`sim/public/brand/png/` porte 16, 32, 48, 128, 256, 512 et 1024 px de deux
choses : `fpvtp-mark-<taille>-transparent.png`, la marque seule, et
`fpvtp-icon-<taille>.png`, la marque sur son fond `--black`.

Ces exports sont **hintés** : à 16 px, chaque module tombe sur un pixel entier,
là où la grille du SVG (pas de 15,2 sur 100 unités) donnerait de l'antialiasing.
C'est pour ça qu'ils existent plutôt que de laisser le navigateur rééchantillonner
`fpvtp-icon.svg`. Recopier depuis ici, ne pas ré-exporter.

### Où la marque est employée

| chemin | source |
|---|---|
| favicon de `sim/index.html` (16, 32, 48) | référence directement `sim/public/brand/png/` |
| `sim/electron/build/icon.png` | copie de `png/fpvtp-icon-1024.png` — electron-builder l'empaquette dans l'installeur NSIS et l'AppImage |

### Sur les fichiers eux-mêmes

Ils sont arrivés avec un manifeste de provenance C2PA d'environ 9 Ko chacun,
d'où un PNG 16×16 qui pesait 6 Ko. Il a été retiré sans réencoder l'image : dans
les PNG, tous les chunks hors `IHDR`/`PLTE`/`IDAT`/`IEND`/`tRNS` ; dans les SVG,
le bloc `<metadata>` et l'attribut `xmlns:c2pa`. À refaire si un fichier est
ré-exporté un jour.

Le SVG de la marque n'introduit **aucune couleur** : il prend celle de son
parent, donc `var(--ink)` partout où l'interface l'emploie. La palette reste
celle de `sim/src/tokens.css`, seule source — `tools/palette-selftest.mjs`
continue de faire foi.

## Verrouillages

```text
HORIZONTAL COURT   [symbole]  FPVTP!            usage par défaut
HORIZONTAL LONG    [symbole]  FPVThePlanet!     première mention, en-têtes, dépôt
EMPILÉ             [symbole]                    splash, boot, formats carrés
                   F P V T P !
```

Écart symbole / nom : 1 module. Le nom ne se coupe jamais sur deux lignes.
Le nom est en `--font-ui` (IBM Plex Mono 500), interlettré `--track-ui` dans le
verrouillage empilé, `--track-data` dans les deux horizontaux.

**Zone de respect :** 4 modules sur les quatre côtés. Rien n'y entre, pas même
la règle d'un panneau.

**Tailles minimales :** symbole seul 16 px, verrouillage court 96 px de large,
verrouillage long 200 px. Sous 16 px le cadre se referme visuellement : utiliser
la version en réserve (plaque pleine, motif creusé).

**Interdits :** pas de couleur d'état ni de couleur demo sur la marque, y
compris pendant un rituel — le cyan et le magenta appartiennent à l'écran, pas
au logo (Bible §19). Pas de rotation, pas de contour, pas d'ombre, pas de motif
substitué.

## Ce que la grille produit ailleurs

Le cadre interrompu **est** le panneau : titre dans l'interruption du bord
supérieur, traits de 1 px (`--rule-w`), angles droits. Le motif tuilé à 8 %
d'encre donne la trame des écrans calmes ; ses 25 bits lus en ligne donnent un
séparateur ; les mêmes modules pleins ou vides donnent les barres de progression
de `ACQUIRE AREA` (Bible §8).
