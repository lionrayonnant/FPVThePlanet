# Sélection par polygone libre — design

Issue : [#30](https://github.com/lionrayonnant/FPVThePlanet/issues/30) · milestone P3 · rattachée à PHASE 03 — Global Scanner (#40).

## Le problème

L'acquisition d'une carte ne sait dessiner qu'un rectangle. Un fleuve, une
avenue, un contour de quartier ne sont pas des rectangles : les suivre oblige
aujourd'hui à embarquer les blocs voisins. Sur une zone qui coûte des gigaoctets
et des dizaines de minutes, ce n'est pas une coquetterie de cadrage — c'est la
moitié du téléchargement qui part dans du bâti dont on ne volera jamais.

## Le parti pris

**La zone extraite reste un sur-ensemble de ce qui est dessiné.** Aujourd'hui le
rectangle dessiné est arrondi *vers l'extérieur* sur le treillis de tuiles ; le
polygone suit la même règle : une tuile est retenue dès que le tracé la touche,
même d'un coin. Deux conséquences voulues :

- ce qu'on dessine est toujours entièrement couvert, sans exception à expliquer ;
- un corridor plus fin qu'une tuile (~25 m au zoom 20) reste extractible, alors
  qu'une règle « centre dans le tracé » lui rendrait zéro colonne.

Le prix est un peu de rab en bordure. C'est le bon prix : l'alternative est une
carte avec des trous là où l'utilisateur croyait avoir tracé.

## Architecture

Le prédicat géométrique existe en deux exemplaires — Go pour l'extraction, JS
pour l'affichage — parce que c'est déjà la convention du dépôt : `tiles.mjs`
s'annonce comme « un portage littéral du Go (pkg/mth) ». L'alternative (calculer
le masque en JS et passer au Go une liste de colonnes) rétrograderait
`export-obj` au rang d'exécutant alors qu'il est maintenu ici comme outil à part
entière.

La dérive entre les deux ports est le vrai risque : elle ne se verrait qu'au
moment où le nom du dossier de cache diverge, c'est-à-dire en re-téléchargeant
plusieurs gigaoctets. D'où **une fixture JSON partagée**, seule source de vérité,
lue par les deux runtimes.

```
testdata/poly-cases.json          ← les cas et leurs résultats attendus
        ├── pkg/mth/poly_test.go            (Go)
        └── sim/tools/map-poly-selftest.mjs (JS)
```

### 1. Géométrie partagée

Nouveau `pkg/mth/poly.go`, et les mêmes fonctions dans `sim/tools/lib/tiles.mjs` :

| Fonction | Rôle |
|---|---|
| `pointInPolygon(lat, lon, ring)` | ray casting, anneau refermé implicitement |
| `segmentsIntersect(a, b, c, d)` | croisement de deux segments |
| `tileIntersectsPolygon(ring, tileBox)` | un sommet dans la tuile, ou un coin dans le tracé, ou une arête qui croise |
| `polygonBounds(ring)` | emprise, d'où découle le rectangle balayé |
| `polygonGrid(ring, zoom)` | la grille de l'emprise + masque des tuiles retenues + `columns` |
| `polygonArea(ring)` | shoelace en projection équirectangulaire locale |

`maskOutline(grid, zoom)` (JS seulement, c'est du dessin) rend l'escalier
des tuiles retenues : les arêtes qu'une tuile gardée ne partage pas avec une
autre tuile gardée.

**`dimensions.area` devient l'aire du tracé, pas celle de l'emprise.** Sur un
corridor le long d'un fleuve les deux diffèrent d'un facteur deux ou trois ;
laisser le compteur de km² sur l'emprise en ferait un mensonge.

### 2. Exporter Go

`--poly s,w,s,w,…` — une suite de paires lat,lon, anneau refermé implicitement.
Exclusif avec `--bbox`. Le rectangle balayé vient de l'emprise du tracé, et une
colonne n'est sondée que si sa tuile intersecte le tracé.

`--plan` gagne **`masked`**, distinct de `pruned` :

- `pruned` = hors de l'emprise déclarée de la région Flyover (`meta_region`) ;
- `masked` = dans l'emprise, mais hors du tracé de l'utilisateur.

Deux raisons opposées de ne rien télécharger — l'une est un fait sur le monde,
l'autre est une décision de l'utilisateur. Les confondre à l'écran donnerait un
« hors couverture » mensonger sur une zone parfaitement couverte.

`exportDir` devient `poly-<sha256[:12]>-<zoom>-<tryH>`, le hash portant sur la
chaîne canonique des sommets (6 décimales, comme les `%f` existants).

### 3. Node

`poly` traverse `tileDirName`, `planScan`, `probeCoverage` et `addMap`
(`sim/tools/lib/add-map-core.mjs`), plus la validation d'entrée de
`sim/tools/map-api-plugin.mjs` (3 à 200 sommets, finis, dans les bornes, aire non
nulle, pas de franchissement de l'antiméridien).

**La sonde de couverture change de point de visée.** Elle prend aujourd'hui le
centre de la bbox ; sur un croissant le long d'un fleuve ce centre tombe *hors*
du tracé, et la sonde rendrait un verdict sur une zone qu'on n'extrait pas. Elle
visera le centre de la tuile retenue la plus proche du centroïde.

`scenes.json` gagne `poly` en additif à côté de `bbox` — le schéma reste
rétro-compatible, `lat/lon` reste le centroïde pour que les repères de carte ne
bougent pas.

### 4. Les deux écrans

`add-map.html` (GUI de dev, #26) et le GLOBAL SCANNER (`src/scanner.js`,
PHASE 03) parlent au même `/__map-api` et reçoivent le même câblage :
`drawPolygon: true` chez Geoman, `allowSelfIntersection: false`, et le rectangle
bleu « zone retenue » remplacé par l'escalier des tuiles gardées. Les lignes de
treillis et la règle des 7 px ne changent pas.

Tout le reste — colonnes, poids, durée, sonde, lancement — découle déjà de
`columns` et suit sans qu'on y touche.

> Note : la décision transverse du 2026-08-29 prévoit que le Global Scanner
> absorbe `add-map.html`. Tant que les deux existent, les deux ont le polygone ;
> le jour de l'absorption, le câblage de `add-map.html` disparaît avec le fichier.

### 5. CLI

`npm run add-map -- "Nom" --poly "lat,lon lat,lon …"`, pour que la ligne de
commande ne devienne pas le parent pauvre.

## Tests

- `pkg/mth/poly_test.go` et `sim/tools/map-poly-selftest.mjs` sur la fixture
  commune. Cas dégénérés inclus : tracé plus fin qu'une tuile, forme en L (dont
  le centroïde est hors du tracé — c'est le cas qui casse la sonde), triangle
  dont l'emprise est trois fois l'aire, antiméridien (rejeté explicitement).
- Le hash de `exportDir` entre dans la fixture : c'est le point où une divergence
  coûte un re-téléchargement complet.
- `sim/tools/scanner-selftest.mjs` étendu au masque et à l'escalier.
- `npm run selftest` reste vert.
- Vérification manuelle : un corridor le long de la Seine, extraction réelle.

## Hors périmètre

Trous (anneaux intérieurs), multi-polygones, et l'édition sommet par sommet
au-delà de ce que Geoman donne gratuitement.
