# FPV Paris — simulateur de drone

Vol FPV dans le navigateur, au-dessus de tuiles photogrammétriques Apple
Flyover. Plusieurs cartes peuvent être téléchargées et se choisissent au
lancement dans un menu.

```bash
npm install
npm run dev       # http://localhost:5173 — choisis une carte dans le menu
npm run selftest  # vérifications hors-navigateur (voir limite en bas de page)
```

## Contrôles

**Manette / radio USB** détectée automatiquement (Mode 2 par défaut), remappable
dans **Tab** avec des barres de niveau en direct pour identifier chaque axe.

**Clavier** : `W`/`S` gaz · `A`/`D` lacet · flèches ou souris roulis-tangage ·
`R` respawn · `M` mode (acro/angle/altitude) · `C` caméra libre · `Tab` réglages.

## Ajouter une carte

Une carte = une zone téléchargée depuis Apple Flyover puis convertie pour le
moteur. Tout le pipeline tient en une commande :

```bash
npm run add-map -- "Nom affiché dans le menu" <lat> <lon>
```

Exemple, pour une zone centrée sur le Sacré-Cœur :

```bash
npm run add-map -- "Sacré-Cœur" 48.8867 2.3431
```

Ça enchaîne, dans l'ordre :

1. **Téléchargement** — lance le programme Go du dépôt
   `../flyover-reverse-engineering` (`cmd/export-obj`), qui scanne une grille de
   tuiles Flyover autour de `lat,lon` et écrit un `.obj` + JPEGs dans
   `flyover-reverse-engineering/downloaded_files/obj/<lat>-<lon>-<zoom>-<radius>-<altitude>/`.
2. **Post-traitement** — `tools/prep.mjs` convertit ce `.obj` (ECEF, un JPEG par
   matériau) en binaires prêts pour le moteur (ENU en mètres, textures
   regroupées en planches) dans `public/scenes/<slug>/`. Voir
   [Détails techniques](#détails-techniques-du-pré-traitement) pour ce que fait
   réellement cette étape et pourquoi elle est nécessaire.
3. **Enregistrement** — la carte est ajoutée à `public/scenes.json`, donc elle
   apparaît dans le menu au prochain `npm run dev` (pas besoin de relancer le
   serveur s'il tourne déjà, un simple rechargement de page suffit).

Chaque étape s'affiche en direct dans le terminal (le téléchargement peut
prendre plusieurs minutes selon la taille de la zone).

### Prérequis

- **Go** installé (`go run` est utilisé directement, pas de build séparé).
- `flyover-reverse-engineering/config.json` renseigné (voir le
  [README de ce dépôt](../flyover-reverse-engineering/README.md#setup) —
  `resourceManifestURL` et `tokenP1`, à extraire une fois depuis une install
  macOS de Plans). Sans ça le téléchargement échoue immédiatement avec
  `please set values in config.json`.

### Options

```bash
npm run add-map -- "Nom" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20]
                                      [--cell 256] [--quality 85]
                                      [--slug identifiant] [--force]
```

| Option | Défaut | Effet |
|---|---|---|
| `--zoom` | 20 | Niveau de zoom Flyover (~13-20). 20 = résolution maximale, celle utilisée jusqu'ici. |
| `--radius` | 25 | Rayon du scan en tuiles autour du centre (`tryXY`). Voir plus bas pour dimensionner. |
| `--altitude` | 20 | Nombre d'index d'altitude essayés par tuile (`tryH`). 20 convient dans la quasi-totalité des cas. |
| `--cell` | 256 | Taille en pixels de chaque cellule de texture. Coûte cher : chaque doublement **quadruple** la VRAM. `128` = qualité réduite mais VRAM divisée par 4 (utile sur machine modeste). |
| `--quality` | 85 | Qualité JPEG des planches de texture générées. |
| `--slug` | dérivé du nom | Identifiant de dossier (`public/scenes/<slug>/`). Auto-généré depuis le nom (accents et espaces retirés) si omis. |
| `--force` | off | Retélécharge même si la tuile existe déjà en local. Sans cette option, un second `add-map` sur les mêmes coordonnées/zoom/radius/altitude saute le téléchargement et ne fait que reconvertir. |

### Dimensionner `--radius`

À zoom 20, une tuile fait environ **25 m de côté** au sol (à la latitude de
Paris). Le scan couvre un carré de `(2×radius + 1)` tuiles centré sur le point
donné, donc `radius × 2 × 25 m` ≈ le côté du carré couvert :

| radius | côté couvert (approx.) | usage typique |
|---|---|---|
| 25 | ~1,25 km | un monument + ses abords (Tour Eiffel) |
| 35 | ~1,75 km | zone allongée (les deux îles de la Seine) |

Un `radius` trop petit laisse des trous sur les bords de la zone survolable ;
trop grand ne coûte que du temps de téléchargement (les tuiles vides — Seine,
ciel — répondent vite et ne pèsent rien), donc dans le doute, voir large.

### Retoucher une carte déjà téléchargée

Si la tuile brute est déjà là et que seul `--cell`/`--quality` doit changer
(par exemple pour alléger la VRAM), pas besoin de retélécharger : appelle
`prep.mjs` directement sur le dossier existant :

```bash
node tools/prep.mjs ../flyover-reverse-engineering/downloaded_files/obj/<dossier-tuile> \
  --out public/scenes/<slug> --cell 128
```

(`npm run add-map` fait exactement ça en interne, avec le téléchargement en plus.)

## Le menu

`npm run dev` affiche un écran de sélection listant tout ce qu'il y a dans
`public/scenes.json`. Pour sauter le menu (lien direct, dev rapide) :

```
http://localhost:5173/?scene=<slug>
```

Le `slug` est celui visible dans `public/scenes.json` ou dans le nom du
dossier `public/scenes/<slug>/`.

## Cartes disponibles

| Nom | Slug | Coordonnées | Taille préparée |
|---|---|---|---|
| Tour Eiffel | `tour-eiffel` | 48.8582, 2.2970 | ~290 Mo |
| Île de la Cité et Île Saint-Louis | `ile-de-la-cite-et-ile-saint-louis` | 48.8534, 2.3510 | ~600 Mo |

(Cette table peut se désynchroniser de `public/scenes.json` au fil des ajouts —
ce dernier fait foi.)

## Architecture

```
tools/add-map.mjs     téléchargement + pré-traitement + enregistrement, en une commande
tools/prep.mjs         OBJ+MTL+JPEG -> binaires (hors ligne, par carte)
tools/selftest.mjs     vérifications géodésie / vol / collision, sans navigateur
src/loader.js          fetch + workers -> BufferGeometry & DataArrayTexture, sélection de la scène active
src/worker.js           parse le binaire, découpe la planche en layers
src/TileMaterial.js     shader GLSL3 sampler2DArray + brouillard
src/physics.js          monde Rapier, trimesh statique, corps du drone
src/flightController.js rates acro -> couple
src/input.js            Gamepad + clavier/souris
src/hud.js              overlay + menu de sélection de carte
```

**Physique : Rapier** (Rust/WASM). Corps rigide, collision trimesh **en pleine
résolution** sur la carte chargée, et CCD activée — à 60 m/s le drone
traverserait sinon une structure fine (ex. le treillis de la Tour Eiffel).

**Contrôleur maison**, interface volontairement étroite
(`update(sticks, state) -> {thrust, torque}`) pour rester substituable par un
pont vers Betaflight SITL. Rates acro 800 °/s avec expo, boucle proportionnelle
sur l'erreur de rate avec τ = 30 ms qui tient lieu de PID + dynamique moteur.

## Limite connue : `selftest` est encore spécifique à la Tour Eiffel

`npm run selftest` accepte un chemin de scène en argument
(`node tools/selftest.mjs public/scenes/<slug>`, défaut `tour-eiffel`), et la
plupart des checks (vol, sol, collision/CCD, convention UV) sont génériques et
passent sur n'importe quelle carte. Trois vérifications, en revanche, sont
codées en dur pour la Tour Eiffel et échoueront ailleurs par construction :
« tile is roughly 1.2km square », « origin is the Eiffel Tower area », et
« Eiffel Tower is ~300m tall ». À généraliser (bornes en fonction du
`--radius` utilisé, sans dépendance à un monument précis) si `selftest` doit
devenir un vrai gate multi-cartes.

## Détails techniques du pré-traitement

La tuile source d'une carte typique fait plusieurs centaines de Mo d'OBJ ASCII
en coordonnées ECEF, avec **un JPEG 512×512 par matériau** (des milliers) — donc
autant de draw calls et plusieurs Go de VRAM en l'état. `tools/prep.mjs`
convertit ça une fois pour toutes, par carte :

| | source | après `prep` (Tour Eiffel, `--cell 256`) |
|---|---|---|
| Géométrie | ASCII, ECEF | binaire, ENU **en mètres** |
| Textures | 1 JPEG 512² par matériau | planches 4096², cellules 256² |
| Draw calls | 1 par matériau (milliers) | **5** |
| Résolution | 12,6 texels/m (8 cm) au plafond de la source | 6,3 texels/m (16 cm) à `--cell 256` |

Chaque paquet de 1024 textures devient un `sampler2DArray` : un seul draw call
par paquet, et chaque layer garde sa propre chaîne de mipmaps (ce qu'un atlas
classique ne permettrait pas sans bavures entre tuiles voisines). Les planches
sont plafonnées à 4096², donc un paquet en occupe plusieurs — c'est ce qui
garde le pic mémoire d'un worker constant quand on augmente `--cell`.

La résolution est l'arbitrage réel de ce pipeline : la source plafonne autour
de 12,6 texels/m (mesuré : 853 m² de surface par matériau pour ~50 % d'une
texture 512²), et chaque doublement de `--cell` quadruple la VRAM. `--cell 128`
redescend à 3,2 texels/m pour environ un quart de la VRAM.

Les coordonnées passent d'ECEF à un repère local ENU en mètres (X = est,
Y = haut, Z = sud, donc −Z = nord = « devant »), ce qui rend la physique
directement crédible. Le script `center_scale_obj.js` du dépôt amont normalise
à 10 unités arbitraires et ne convient pas pour ça.

### Trois réglages qui comptent

- **UV en V retourné dans `prep.mjs`** — l'OBJ place l'origine UV en bas à
  gauche, `DataArrayTexture` impose `flipY = false` et met donc la ligne 0 des
  données en haut. Sans la conversion, une bonne partie de la surface visible
  échantillonne le remplissage gris que Flyover laisse hors de la zone utile de
  chaque imagette. Le selftest verrouille les deux symptômes (motifs retournés
  et plaques grises).
- **`camera.near = 0.15`** — la photogrammétrie empile des surfaces quasi
  coplanaires. À `near = 0.05` le depth buffer quantifie à ~40 cm à l'autre bout
  de la tuile et la ville part en éclats de z-fighting. 0,15 corrige ça et vaut
  exactement le rayon du collider, donc rien ne peut être plus près de la caméra
  sans être déjà entré en collision.
- **`resetForces()` à chaque pas** — Rapier conserve les forces utilisateur
  jusqu'à effacement explicite. Sans ça la poussée s'accumule et le drone part
  en accélération quadratique.

### Sur le gris : ce n'était pas les données

Une version précédente de ce README affirmait que Flyover laissait les façades
verticales en gris et qu'il fallait arbitrer entre cette esthétique et un autre
jeu de données. **C'était faux.** Le remplissage gris (luminance exactement 128)
occupe la marge *non utilisée* de chaque imagette ; c'est le V non retourné qui y
projetait les échantillons. Mesuré sur 125 600 m² de surface réelle (tuile Tour
Eiffel) :

| convention | gris visible | faces verticales | faces horizontales |
|---|---|---|---|
| V non retourné | 20,9 % | — | — |
| V retourné | **0,9 %** | 0,9 % | 1,0 % |

Les façades ne sont pas moins bien texturées que les toits.
