# La couverture : une tache qui s'étend là où le drone est passé

Issue #245. Écrit le 2026-09-06.

## Ce que c'est

La carte vivante de FIELD garde la trace de ce que l'opérateur a parcouru du
monde. Une tache douce s'étend sous les trajectoires, se densifie quand on
repasse, et survit aux sessions.

Ce n'est **pas** « la zone est acquise, donc explorée » : un cadre acquis où l'on
n'a jamais volé reste vierge. Et ce n'est pas un brouillard de guerre : on marque
où le drone est **passé**, pas ce que la caméra a **vu**. La distinction est
assumée — voir « Écarté ».

## Contraintes du dépôt, vérifiées avant d'écrire

1. `OP_WRITABLE_KEYS` (`tools/map-api-plugin.mjs:98`) est une liste blanche côté
   serveur. La clé `coverage` doit y être ajoutée. Précédent : `dialogueMemory`,
   dont le commentaire dit que le serveur ne valide pas la forme **parce que le
   client la borne**. La couverture doit donc être bornée côté client, elle
   aussi, et pour la même raison.

2. **Le banc n'écrit rien** (`tools/bench-model.mjs:16` : « rien ne s'est passé
   dans le monde, donc rien n'est écrit »). BENCH n'ouvre **aucune session**
   (`main.js:2680`). En attachant la couverture au cycle de session, l'exemption
   du banc est acquise **par construction** — pas de `if (MODE.bench)` à écrire
   ni à maintenir, donc pas de garde qu'un futur chemin pourrait contourner.

3. `operator.patch()` est débouncé mais **réémet toute la valeur** à chaque
   flush (`src/operator.js:76`). Patcher en vol enverrait le blob entier
   plusieurs fois par seconde.

4. `flightTelemetry` ne garde que des agrégats (durée, distance, vitesses max).
   Il n'existe aucune trace de trajectoire : tout l'enregistrement est neuf.

## La grille

Tuiles slippy à **zoom fixe 20**, clé entière `x,y`.

Choisi plutôt qu'une grille en degrés parce que Leaflet est déjà en Web Mercator :
une cellule se projette sans conversion au rendu, et l'indexation ne se déforme
pas avec la latitude. La résolution vaut `156543.03 × cos(lat) / 2^z` m/px ; à
z=20 et 48,85° (Paris), une tuile de 256 px fait **25,2 m**. À l'équateur, 38 m.

    cellule = { x: int, y: int, w: int }   // w = passages, saturé à W_MAX

## L'enregistrement

Échantillonnage à **5 Hz**, pas à 250 : on lit la position déjà calculée par la
frame, aucun rayon, aucune allocation par pas de physique.

À chaque échantillon, on marque toutes les cellules dont le **centre** est à
moins de **R = 30 m** du point. À 25,2 m de côté, ça fait une empreinte de **4 à
5 cellules** selon où le point tombe dans sa cellule — et non les 9 d'un 3×3 :
les diagonales sont à 35,6 m et sortent du rayon. C'est la bonne approximation
d'un disque de 30 m, dont l'aire vaut 2 827 m² pour 635 m² de cellule.

Le pas de 5 Hz est dimensionné par R : à 20 m/s, deux échantillons sont distants
de 4 m, très en deçà des 30 m du disque. Aucun trou n'est possible, même à la
vitesse de pointe mesurée de la clôture de zone (42,72 m/s → 8,5 m entre deux
échantillons).

`w` sature à `W_MAX = 8` : au-delà, repasser n'assombrit plus. Sans ce plafond,
un stationnaire de deux minutes au même endroit écraserait à lui seul l'échelle
de toute la carte.

### Les deux modes, un seul chemin

La grille étant globale en lat/lon, le live marche à l'identique sans code
dédié :

- FIELD sur terrain cuit → `latLonOf(p)` (`main.js:1408`, approximation plate,
  déjà jugée suffisante sur une scène de 2 km) ;
- FIELD live → `ecefToGeodetic`, que `main.js:1591` calcule déjà pour la fenêtre
  de streaming rocktree.

L'enregistrement est gardé par `session.current()` : pas de session, pas de
couverture. C'est ce qui donne l'exemption du banc sans la nommer.

## La persistance

La couverture s'accumule **en mémoire** pendant le vol et n'est écrite **qu'une
fois**, à la clôture, depuis `session.end()` (`src/session.js:82`) — le seul
entonnoir des trois `session.end()` de `main.js`. `session.beacon()` (mort de
l'onglet) fait de même dans la limite de ce qu'un `sendBeacon` permet.

C'est aussi ce qui a du sens du point de vue du monde : il retient ce qu'une
session a fait, pas ce qu'elle est en train de faire.

Clé opérateur `coverage`, forme :

    { v: 1, z: 20, cells: [[x, y, w], ...] }

Un tableau de triplets plutôt qu'un objet indexé : moins d'octets par cellule en
JSON, et l'ordre porte l'ancienneté, ce dont l'éviction se sert.

### La borne

Plafond `MAX_CELLS = 8000`, soit environ 5 km² parcourus. Au-delà, on évite
d'abord les poids les plus faibles, l'ancienneté départageant : ce qu'on a le
moins vu s'efface avant ce qu'on connaît bien.

**Ce chiffre est un pari, et il doit être écrit comme tel dans le code.** Il n'y
a pas encore d'usage réel à mesurer. Ordre de grandeur qui l'a produit : un vol
de dix minutes à 15 m/s balaie 9 km de trajectoire, soit un couloir de 60 m de
large — 540 000 m² pour des cellules de 635 m², soit environ **850 cellules**.
Le plafond tient donc une dizaine de vols sans
recouvrement, et bien davantage en usage réel où l'on repasse. À revoir sur des
données, pas sur une intuition.

Au plafond, le blob fait de l'ordre de **160 ko** de JSON — un triplet
`[1048575,1048575,8],` coûte une vingtaine de caractères, et les index à z=20
montent à sept chiffres. C'est gros pour une clé
d'opérateur, et c'est la raison pour laquelle il est écrit une fois par session
et non en continu.

## Le rendu

Un calque Leaflet dédié, en canvas, redessiné sur `moveend` / `zoomend`.

Chaque cellule visible devient un dégradé radial de rayon `1,6 × la taille de
cellule à l'écran`, d'alpha proportionnel à `w / W_MAX`, accumulé en
`globalCompositeOperation = 'lighter'`. Un léger flou CSS finit de fondre les
bords. Le résultat : les passages se rejoignent en tache, et repasser densifie.

Pas d'index grossier en v1. Le plafond de 8 000 cellules garantit qu'on peut
toutes les dessiner même au zoom monde, où elles sont sous-pixel et où le flou
les fond en traînée — un canvas encaisse 8 000 dégradés sans effort.

Le calque vit sur la carte de FIELD (`terminal-map`, montée par
`runScanner()`), sous les cadres de zone : la tache est un fond, pas un objet
qu'on désigne. Elle n'est jamais interactive.

## Les fichiers

| fichier | rôle |
|---|---|
| `src/coverage.js` | **pur** : maths de cellule, empreinte, fusion, plafond, sérialisation. Ni THREE, ni Rapier, ni DOM, ni Leaflet — même règle que `geofence.js`, `fog.js`, `wind.js` |
| `tools/coverage-selftest.mjs` | le banc de ce qui précède |
| `src/map-coverage.js` | la colle Leaflet : le calque canvas et son cycle de vie |
| `src/main.js` | l'échantillonnage à 5 Hz dans la frame |
| `src/session.js` | l'écriture à la clôture |
| `src/scanner.js` | monte le calque sur la carte |
| `tools/map-api-plugin.mjs` | `coverage` rejoint `OP_WRITABLE_KEYS` |

## Vérification

**Sans navigateur**, dans `tools/coverage-selftest.mjs` :

- la cellule d'un point connu est celle qu'on attend, et le tour lat/lon →
  cellule → bornes est cohérent ;
- l'empreinte à 30 m couvre 3×3 cellules à Paris et ne laisse aucun trou le long
  d'une trajectoire échantillonnée à 5 Hz jusqu'à 42,72 m/s (la pire vitesse
  mesurée du dépôt) ;
- `w` sature à `W_MAX` et ne le dépasse jamais ;
- la fusion de deux couvertures est commutative et idempotente ;
- au-delà de `MAX_CELLS`, l'éviction retire bien les poids les plus faibles
  d'abord, et le résultat reste sous le plafond ;
- une couverture absente ou corrompue se relit comme une couverture vierge — pas
  de migration, pas de bump de schéma, un opérateur d'avant cette issue marche
  tel quel (même promesse que `dialogueMemory`).

**Ce qui demandera un œil**, et sera écrit dans HANDOFF plutôt que prétendu
vérifié : que la tache ressemble à une tache et pas à une grille floue, qu'elle
ne noircit pas la carte au bout de dix sessions, et qu'elle reste lisible sous
les cadres de zone.

## Écarté

- **Ce que la caméra a vu.** Plus juste — monter révèle large, raser révèle
  étroit — mais il faut des rayons en vol, et `physics.probeWind()` en tire déjà
  une rosace par pas de physique. Le budget est déjà dépensé ailleurs.
- **Stocker les trajectoires simplifiées et rasteriser au rendu.** Croît sans
  borne, et donne une trace, pas une tache.
- **Un bitmap par tuile de 10 km.** 8 ko par tuile même pour trois cellules :
  pire pour un usage épars, qui est le cas réel.
- **Une grille en degrés.** Se déforme avec la latitude et demande une
  conversion à chaque projection, là où Mercator est déjà la langue de Leaflet.

## Hors périmètre

- Le contenu d'origine de #212 : la météo et la densité de signal portées sur le
  cadre des zones. Autre sujet, autre PR, #212 reste ouverte.
- Afficher la couverture ailleurs que sur la carte de FIELD.
- Effacer ou remettre à zéro la couverture depuis une interface.
