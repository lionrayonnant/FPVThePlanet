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

### Bannières

Les images composées — la marque, le nom et une accroche sur le fond `--black`.
Elles vivent à deux endroits, et la frontière est celle du navigateur :
`docs/brand/` pour celles que personne ne sert (dépôt, réseaux, téléversements à
la main), `sim/public/brand/` pour la seule qu'une page doit livrer, la carte
Open Graph.

| fichier | dimensions | destination |
|---|---|---|
| `docs/brand/fpvtp-readme-1280x320.png` | 1280 × 320 | en-tête de `README.md` |
| `docs/brand/fpvtp-github-social-1280x640.png` | 1280 × 640 | *social preview* du dépôt — GitHub → Settings → Social preview, à la main |
| `docs/brand/fpvtp-wide-1500x500.png` | 1500 × 500 | bandeau de profil d'un réseau social, à la main |
| `docs/brand/fpvtp-square-1080.png` | 1080 × 1080 | avatar, vignette carrée, à la main |
| `sim/public/brand/fpvtp-og-1200x630.png` | 1200 × 630 | carte Open Graph d'une instance déployée, servie par la page |

Les accroches (`POINT AT A CITY, FLY IT`, `IT'S NOT A LEVEL. IT'S TOKYO.`) sont
composées dans l'image : rien ne les relit, les changer demande un ré-export.
Comme le reste de la marque, les fichiers sont arrivés avec un manifeste C2PA —
chunks `caBX` et `deBG`, 5,8 Ko par image — retiré sans réencoder, même règle
que ci-dessous.

### Où la marque est employée

| chemin | source |
|---|---|
| en-tête de `README.md` | `docs/brand/fpvtp-readme-1280x320.png` — la bannière porte déjà la marque ET le nom, elle a remplacé l'icône seule qui était là |
| cracktro de lancement (`sim/src/intro.js`) | verrouillage empilé, tracé module par module pendant la phase `reveal`. La géométrie est recopiée dans `sim/tools/brand-mark-model.mjs` — le premier écran du jeu ne peut pas dépendre d'un fetch — et `sim/tools/brand-mark-selftest.mjs` lit le SVG et le motif ci-dessus pour interdire à cette copie de dériver |
| favicon de `sim/index.html` (16, 32, 48) | référence directement `sim/public/brand/png/` |
| `og:image` de `sim/index.html` | `sim/public/brand/fpvtp-og-1200x630.png` — chemin **relatif à la racine**, et pas d'`og:url` : `deploy/` ne fixe aucun domaine, et une URL canonique fausse vaut moins que pas d'URL du tout. Le jour où un domaine est arrêté, poser `og:url` et passer l'image en absolu |
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

Le cracktro est le premier endroit où cet interdit mord vraiment : la marque y
tient l'écran pendant que la phase plasma flambe en cyan, magenta, violet et
bleu. `.intro-lockup` pose `color: var(--ink)` sur le conteneur du
verrouillage, précisément pour que rien de la demo ne puisse redescendre
dessus.

## Ce que la grille produit ailleurs

Le cadre interrompu **est** le panneau : titre dans l'interruption du bord
supérieur, traits de 1 px (`--rule-w`), angles droits. Le motif tuilé à 8 %
d'encre donne la trame des écrans calmes ; ses 25 bits lus en ligne donnent un
séparateur ; les mêmes modules pleins ou vides donnent les barres de progression
de `ACQUIRE AREA` (Bible §8).
