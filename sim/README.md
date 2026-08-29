# FPVThePlanet! — simulateur de drone basé sur des données photogramétriques

Vol FPV dans le navigateur, au-dessus de tuiles photogrammétriques Apple
Flyover. Plusieurs cartes peuvent être téléchargées et se choisissent au
lancement depuis le terminal opérateur (`LOCAL TERRAIN`).

```bash
npm install
npm run dev       # http://localhost:5173 — terminal opérateur, puis vol
npm run selftest  # vérifications hors-navigateur (voir limite en bas de page)
npm run selftest:operator  # état opérateur (schéma, recall client) + modèle du terminal
```

## Sommaire

`grep -n '^#' README.md` pour la ligne exacte d'une section.

- Contrôles
- Ajouter une carte — par l'interface · en ligne de commande · prérequis ·
  options · dimensionner `--radius` · retoucher une carte
- Supprimer une carte — quand une zone ne renvoie rien · textures HEIC
- Le terminal opérateur
- Cartes disponibles
- Exporter une scène en `.glb`
- Architecture
- Limite connue : `selftest` spécifique à la Tour Eiffel
- Détails techniques du pré-traitement — trois réglages qui comptent · sur le gris
- Le modèle de vol — le vent · la pluie · le brouillard · le son · le rendu FPV ·
  le lien vidéo · régler le PID

## Contrôles

**Manette / radio USB** détectée automatiquement (Mode 2 par défaut), remappable
dans **Tab** avec des barres de niveau en direct pour identifier chaque axe.

**Clavier** : `W`/`S` gaz · `A`/`D` lacet · flèches ou souris roulis-tangage ·
`R` respawn · `M` mode (acro/angle/altitude) · `C` caméra libre · `Tab` réglages.

## Ajouter une carte

Une carte = une zone téléchargée depuis Apple Flyover puis convertie pour le
moteur.

### Par l'interface (voie principale)

```bash
npm run dev        # puis http://localhost:5173/add-map.html
```

On cherche un lieu, on dessine la zone au rectangle sur la carte satellite, et le
panneau affiche avant de lancer : dimensions, surface, grille de tuiles, nombre de
requêtes, poids estimé (brut et sur disque) et durée. Le bouton **Vérifier la
couverture** interroge la région Flyover puis télécharge un échantillon au centre —
c'est la seule preuve fiable qu'il y a de la photogrammétrie ici. **Extraire** lance
le pipeline avec les logs en direct, et propose à la fin d'aller voler dessus.

Deux choses valent d'être comprises :

- **La zone est quantifiée.** Flyover est servi en tuiles d'environ 25 m de côté au
  zoom 20 ; la zone réellement extraite est celle dessinée arrondie au treillis. La
  carte affiche ce treillis, et le rectangle dessiné reste en pointillé à côté.
- **Les estimations sont des fourchettes, pas des chiffres.** À nombre de colonnes
  égal, un lotissement et un quartier de tours rendent du simple au quadruple de
  données. Les constantes viennent de mesures sur les cartes existantes
  (`tools/lib/estimates.json`), pas d'un doigt mouillé.

L'interface et son API (`/__map-api`) n'existent que sous `npm run dev` : elles ne
partent pas dans `npm run build`. Il en va de même pour la couche opérateur
(`/__operator`), servie par le même plugin de dev. Comme `main.js` appelle
désormais cette couche pendant le boot, un bundle issu de `vite build` n'est pas
jouable en V1 — c'est voulu (décision D1 : `npm run dev` *est* le jeu).

### En ligne de commande

Tout le pipeline tient en une commande :

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

## Supprimer une carte

```bash
npm run remove-map -- <slug>
```

Le `slug` est celui dans `public/scenes.json` (ex. `sacre-coeur`). Ça retire
l'entrée de `scenes.json` (donc la carte disparaît du menu au prochain
`npm run dev`/rechargement) et supprime `public/scenes/<slug>/`.

La tuile brute téléchargée sous
`flyover-reverse-engineering/downloaded_files/obj/` n'est **pas** supprimée
par défaut — c'est la partie lente à retélécharger, donc `add-map` peut la
réutiliser telle quelle si la carte est rajoutée plus tard. Ajouter `--raw`
pour la supprimer aussi :

```bash
npm run remove-map -- <slug> --raw
```

### Quand une zone ne renvoie rien

Apple Flyover ne propose de la photogrammétrie 3D que sur une liste de villes.
Ailleurs, l'API répond quand même — une « région » existe presque partout — mais
le scan ne trouve aucune tuile et affiche `0 exported` ; `add-map` s'arrête
alors avec un message explicite plutôt que d'écrire une carte vide.

Attention au faux négatif : `0 exported` a longtemps *aussi* été ce que
produisait une ville parfaitement couverte dont les tuiles n'étaient pas
décodables (voir « Textures HEIC » ci-dessous). Une tuile reçue mais non
décodée est désormais signalée explicitement en fin de scan — si ce message
n'apparaît pas, l'absence de couverture est réelle.

Pour tester rapidement si un endroit est couvert, sans lancer un
téléchargement complet :

```bash
cd ../flyover-reverse-engineering
go run cmd/export-obj/main.go <lat> <lon> 20 1 20 --parallel
```

Un lieu couvert renvoie des lignes `Exporting ...` dès ce rayon de 1.

### Textures HEIC : un décodeur système est requis

Les régions capturées récemment (les triggers `Reg_z9_*` auto-générés, par
opposition aux villes historiques nommées comme `'paris'`) servent leurs
textures en **HEIC** — du HEVC dans un conteneur HEIF — au lieu de JPEG. Le
format du reste de la tuile est identique ; seul l'octet de format du matériau
change (0 → 13).

Rien en aval ne sait lire du HEVC : le `sharp` embarqué dans `prep.mjs` a un
libheif compilé en AV1 uniquement, et Go n'a pas de décodeur utilisable. Le
programme Go transcode donc en JPEG au moment de l'export, ce qui garde le
contrat sur disque inchangé (OBJ + MTL + JPEG). Il lui faut pour ça **un** de
ces binaires dans le `PATH`, le premier trouvé gagne :

| Binaire | Paquet |
| --- | --- |
| `heif-convert` | `libheif` |
| `magick` | `imagemagick` |
| `ffmpeg` | `ffmpeg` |

Sans aucun des trois, l'export s'arrête avec un message le disant. Les villes
historiques (Paris, etc.) restent en JPEG et n'ont besoin de rien.

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

## Le terminal opérateur

`npm run dev` ouvre l'Operator Terminal (PHASE 02). `LOCAL TERRAIN` liste tout
ce qu'il y a dans `public/scenes.json` avec sa taille réelle sur disque ;
`OPEN` lance le vol. `GLOBAL SCANNER`, `SESSION LOG`, `TARGET LOG` sont des
souches jusqu'à leurs phases respectives.

Pour sauter le terminal (lien direct, dev rapide) :

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

## Exporter une scène en `.glb` (pour la partager)

Les binaires de `public/scenes/<slug>/` ne servent qu'au moteur d'ici. Pour
donner une scène à quelqu'un d'autre — ou l'utiliser dans Blender, Godot,
Unity (via glTFast), Unreal, three.js — il y a un exporteur vers un `.glb`
unique et autonome (géométrie + textures embarquées, aucun fichier à côté) :

```bash
npm run export-glb -- public/scenes/tour-eiffel
npm run export-glb -- public/scenes/tour-eiffel --max-tex 2048   # textures réduites
npm run export-glb -- public/scenes/tour-eiffel --unlit          # KHR_materials_unlit
```

Le `.glb` atterrit dans le dossier de la scène (donc gitignoré) sauf `--out`.

| Scène | `.glb` | Triangles | Primitives |
|---|---|---|---|
| Tour Eiffel | 203 Mo (148 Mo en `--max-tex 2048`) | 3,74 M | 19 |
| Île de la Cité | 408 Mo | 7,58 M | 38 |

`--max-tex` ne gagne que ~55 Mo parce que la géométrie domine (~120 Mo sur la
Tour Eiffel) : descendre nettement plus bas demanderait de la compression
Draco/meshopt ou de la décimation, ce que l'exporteur ne fait pas.

Ce qu'il traduit, et le seul point non trivial : `prep.mjs` empile 1024
textures de patch par chunk dans des sheets de `DataArrayTexture` et range
`(uv, layer)` par sommet. glTF n'a pas de texture-array — chaque sheet devient
donc une texture 2D ordinaire et l'index de layer est replié dans l'UV
(cellule `(col,row)` d'une grille `cellsPerRow`). C'est sans perte uniquement
parce que tous les UV sources tiennent dans `[0,1]` — aucun patch ne déborde
de sa cellule (vérifié : 0 coordonnée hors bornes sur 1,4 M).

Les coordonnées, elles, passent telles quelles : `prep.mjs` sort déjà des
mètres ENU en X=est, Y=haut, Z=sud, soit exactement le repère de glTF
(main droite, Y up). Pas de conversion d'axes, donc pas d'échelle ni de
rotation à corriger à l'import — 1 unité = 1 mètre.

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
src/fog.js              modèle de visibilité : densité, respiration, voile, couleur de l'air
src/lens.js             passe plein écran : optique FPV (barillet, vignettage, flou, voile)
src/hud.js              OSD de vol + écran de chargement
src/settings.js         panneau de réglages (Tab) : manette, caméra, objectif, lien, météo, son
src/terminal.js         Operator Terminal (Home) : LOCAL TERRAIN, CONTROL VECTOR, souches
tools/terminal-model.mjs logique pure du terminal (formatBytes, footer) — testée par selftest:operator
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
passent sur n'importe quelle carte. **Cinq** vérifications, en revanche, sont
codées en dur pour la Tour Eiffel et échouent ailleurs par construction (relevé
du 2026-08-27 sur une carte de 328 x 276 m) :

- « tile is roughly 1.2km square »
- « Eiffel Tower is ~300m tall »
- « ray finds the tower structure »
- « ground coverage across the tile » (grille de sondage dimensionnée pour 1,2 km)
- « high-speed impact registers as a crash » (le point d'impact vise la tour)

À généraliser (bornes déduites de la zone réellement extraite, sans dépendance à
un monument précis) si `selftest` doit devenir un vrai gate multi-cartes — voir
l'issue #4. En attendant, sur une carte autre que la Tour Eiffel, seuls ces cinq
échecs sont attendus : tout autre échec est un vrai problème.

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

## Le modèle de vol

Le drone n'est pas une sphère avec une poussée : c'est un 5 pouces modélisé
moteur par moteur. `src/quad.js` tient la cellule et l'air (retard moteur,
poussée ∝ ω², couple de traînée d'hélice, traînée de rotor, effet de sol,
propwash, batterie 4S qui s'affaisse sous charge et se vide) ;
`src/flightController.js` tient la partie Betaflight (actual rates, PID avec
i-term relax, TPA, feedforward, lissage RC, mixeur airmode) et ne sort que
quatre commandes moteur.

Trois presets de rates, touche `P` : **cinéma** (380 °/s), **freestyle**
(820 °/s), **race** (1100 °/s).

Le HUD affiche la tension pack, l'état de charge et le courant : la couleur
suit la tension *par cellule sous charge*, pas l'état de charge, parce que
c'est le chiffre au ratio duquel on pilote. Sous 3,6 V/cellule elle passe à
l'orange, sous 3,4 V au rouge.

### Le vent

`src/wind.js` — un champ de vent, pas un vecteur. Quatre réglages dans le
panneau `Tab`, section **Météo — vent**, plus quatre préréglages calés sur
l'échelle de Beaufort :

| réglage | par défaut | ce qu'il fait |
| --- | --- | --- |
| Vent | 0 m/s | vitesse **à 10 m**, la hauteur à laquelle une station météo mesure — pas la vitesse au drone |
| Direction | tirée une fois | secteur d'**où vient** le vent, convention météo. Le bouton `↻` retire au sort |
| Rafales | 0 % | un curseur pour trois propriétés — intensité, durée, fréquence — voir plus bas |
| Turbulences | 100 % | multiplicateur sur l'intensité que le profil implique déjà, pas l'intensité elle-même |

Par défaut le vent est nul, et pas par timidité : trois vérifications de
`tools/selftest.mjs` (tenue d'altitude au stationnaire, vitesse terminale à
plat, immobilité au sol) n'ont de sens qu'en air calme, et un simulateur qui
pousse le drone de côté avant qu'on ait touché un curseur a l'air cassé. La
direction, elle, est tirée au sort **une fois** puis conservée : le hasard est
là pour qu'on n'ait pas toujours le même vent arrière dans la même rue, ce qui
est une raison de varier d'un pilote à l'autre, pas d'un rechargement au
suivant.

**Quatre couches**, chacune dans sa bande de fréquence, parce qu'elles ont des
causes différentes : le **moyen** (le gradient de pression), la **dérive** lente
sur des dizaines de secondes, les **rafales** discrètes de quelques secondes, et
la **turbulence** au dixième de seconde. La version précédente repliait les
trois dernières sur un seul passe-bas, ce qui ne sait exprimer que « à quel
point » et jamais « à quelle fréquence » ni « pendant combien de temps ».

**Le profil de couche limite** est la loi logarithmique, avec une longueur de
rugosité de 1 m (classe Davenport « centre-ville »). Conséquence directe en
vol : à 2 m du sol il ne reste que 30 % du vent annoncé, à 100 m il y en a le
double. Monter change la donne. La loi log est préférée à la loi puissance
parce qu'elle donne **gratuitement** l'intensité turbulente — σu/U = 1/ln(z/z0),
soit 0,43 à 10 m et 0,22 à 100 m — au lieu de la faire choisir.

**La turbulence** est un modèle de Dryden : trois axes générés dans un repère
lié au vent puis tournés dans le monde, avec les rapports mesurés en couche de
surface σu:σv:σw = 1:0,78:0,52. La constante de temps est L/V où V est la
vitesse d'advection — l'hypothèse de turbulence gelée de Taylor, sans laquelle
le champ se figerait dès qu'on s'arrête en stationnaire. Elle donne aussi, sans
qu'on l'ait demandé, « l'air est plus sale quand on va vite » : les mêmes
tourbillons arrivent plus tôt.

**Les rafales** sont des arrivées de Poisson avec l'enveloppe en 1−cosinus de
la MIL-F-8785C. Intensité, durée et fréquence sont trois paramètres réellement
indépendants ; le curseur unique parcourt une ligne à travers les trois, parce
que c'est ainsi que le temps se dégrade — de l'air plus agité veut dire des
rafales plus fortes, plus sèches **et** plus fréquentes. Le triplet complet reste
accessible via `window.__sim.setWeather({gustPeak, gustDuration, gustRate})`.

**L'interaction avec le relief** est une rosette de dix rayons lancée à 20,8 Hz
depuis `physics.js` — l'ordre de grandeur que le lien vidéo dépense déjà contre
le même maillage. Le rayon 0 pointe toujours au vent, ce qui fait que « est-ce
que quelque chose m'abrite » est toujours la même question sur le même rayon.
En sortent quatre grandeurs : l'**abri** derrière un obstacle (jusqu'à −70 %,
jamais 100 % — le sillage d'un bâtiment n'est pas de l'air immobile), la
**canalisation** dans une rue alignée avec le vent (+45 %), l'**ascendance** le
long d'une façade au vent (soaring dynamique compris), et la **rugosité** qui
monte l'intensité turbulente près de la géométrie. Rien n'est un drapeau :
chaque rayon donne une rampe `1 − d/R` et le tout est lissé sur 0,8 s, pour la
même raison que dans `link.js` — la photogrammétrie est une soupe de surfaces,
les rayons scintillent, et un drapeau transformerait ce scintillement en
interrupteur.

Le vent agit **par les hélices**, pas comme une force unique sur le châssis :
chaque rotor voit sa propre vitesse air, `v + ω × r`. Rouler vers la droite
fait monter les moteurs de gauche, qui voient donc plus d'air et perdent de la
poussée — un amortissement aérodynamique que le modèle n'avait pas, et qui
sort de la géométrie sans qu'aucun coefficient ait été inventé. Le HUD affiche
le vent **relatif au nez** : ce qu'on veut savoir en ligne, ce n'est pas un cap
absolu, c'est de quel côté ça pousse.

### La pluie

`src/rain.js` est le modèle, `src/rainfall.js` le rendu — même découpe que le
vent, et pour la même raison : la moitié modèle n'importe ni THREE ni le DOM, ce
qui la rend vérifiable dans `tools/selftest.mjs`. Trois choses en sortent : les
stries dans l'air, la baisse de visibilité, et les gouttes sur la lentille.

Le curseur va de 0 à 25 mm/h, parce que toutes les relations utilisées sont
publiées dans cette unité. Le diamètre médian suit Laws & Parsons
(`D = 0,89 R^0,21` mm), la vitesse de chute Atlas & Ulbrich
(`v = 3,78 D^0,67` m/s) et la concentration se déduit du contenu en eau liquide
de Marshall-Palmer. À 5 mm/h cela donne 1,25 mm tombant à 4,4 m/s, 340 gouttes
par mètre cube — ce qui est la bonne réponse, et ce qui rend l'intensité lisible
en mm/h dans le panneau plutôt qu'en pourcents.

L'intensité **respire** : le taux de pluie est lognormal, avec la correction
`exp(-k²/2)` qui garantit que monter la variabilité fait aller et venir l'averse
sans la rendre plus forte en moyenne. Deux bandes, une de 70 s et une de 14 s :
un grain à l'intérieur d'une averse.

La **visibilité** vient du coefficient d'extinction `σ = 0,21 R^0,74` par km et
de Koschmieder — 5,6 km à 5 mm/h, 1,7 km à 25. Les extinctions s'ajoutent, donc
la portée finale est celle-là en parallèle avec le brouillard de l'air, décrit
plus bas : `loader.setFog()` bouge densité et couleur à chaud, et le brouillard
a repris ce même point d'entrée plutôt que d'en créer un second.

Les **stries** sont de la géométrie dans la scène, pas un calque : une
`InstancedBufferGeometry` de quads dans une boîte de 4 m qui suit la caméra,
donc dessinée par le `RenderPass` et donc soumise au barillet, au vignettage, au
flou et à la dégradation du lien comme le reste — et occultée par la ville. Les
positions sont enroulées modulo la boîte dans le vertex shader : rien n'est
jamais réengendré, le CPU écrit un `vec3` par frame. La strie s'oriente sur la
vitesse de la goutte **relative au drone** et sa longueur est cette vitesse fois
le temps d'exposition, le même curseur d'obturation que le HUD règle déjà : le
flou de translation est précisément celui que la passe lens ne reconstruit pas,
et une strie de pluie est ce flou-là.

Quatre mètres et pas plus, parce qu'au-delà une goutte est plus fine qu'un pixel
et cesse d'être une strie : ce qui lui arrive est de l'extinction, et
l'extinction c'est le brouillard ci-dessus. Le près en géométrie, le loin en
brouillard, et aucun des deux ne fait le travail de l'autre.

Un point est **assumé et non physique**, `STREAK_WIDTH_GAIN` : à taille réelle,
la profondeur optique du champ proche est sous le pourcent et une strie fait un
tiers de pixel de large — la réponse est juste et inutilisable. La largeur
dessinée est donc exagérée, l'opacité **jamais** (elle se calcule toujours sur le
vrai diamètre), et le nombre de stries est divisé par le même facteur pour que
la surface d'écran couverte reste celle que la concentration demande.

Les gouttes **sur** la lentille ne sont pas là : voir issue #28. Le modèle l'est
déjà (`RainField.wetness`, `dropDrift`), c'est le rendu qui reste à trouver.


#### Les gouttes sur la lentille

Une caméra FPV a un hublot plat quelques millimètres devant l'objectif, et c'est
là que l'eau se pose. Deux nombres de la **caméra** — pas de la météo — décident
alors presque tout : la pupille d'entrée (≈ 1 mm) et ce recul (≈ 8 mm).

Ce qui compte n'est pas la mise au point mais **quels rayons la bille touche**.
Chaque point du hublot est traversé par tout le cône que la pupille accepte, donc
une bille de diamètre `D` à un recul `s` intervient sur la convolution de la
bille par la pupille : un disque angulaire de `(D + A)/s`, à cœur plat sur
`(D − A)/s`. Il en découle, sans rien ajuster, que l'empreinte est **grande et
presque indépendante de la taille de la goutte** (six fois la goutte, 2,8 fois
l'empreinte), qu'une goutte **plus petite que la pupille n'est jamais opaque**
puisqu'elle ne peut que rogner une partie du cône, et que le bord est doux de la
largeur de la pupille. C'est aussi pourquoi la réfraction — une image nette,
seulement déplacée — ne pouvait pas ressembler à quoi que ce soit.

Le compte tombe de la même chaîne : `wetness` **est** la fraction mouillée (le
dépôt dans `RainField.update()` est proportionnel au verre nu restant), donc le
nombre de billes est cette fraction du hublot divisée par l'aire d'une bille.
Dix millimètres de hublot sur quatre de bille, cela fait **une poignée de
gouttes** : une lentille mouillée, ce sont cinq grosses taches. C'est la
raison pour laquelle `LensDrops` est une liste d'uniformes et pas un champ
procédural — et donc pourquoi rien ne lit comme une grille.

Ce que la goutte **montre** est une autre taille que ce qu'elle **couvre** : la
première vient du cône entier où la bille diffuse, bien plus large que le disque,
et biaisée vers le haut du cadre parce que dehors c'est le ciel qui domine ce
cône. D'où le comportement voulu : pâle devant une façade, invisible devant le
ciel. Cette moyenne large est prise dans la chaîne de mips de la cible du
composer — c'est le seul changement que les gouttes imposent au reste de la
passe, et il est là parce qu'une poignée de taps sur autant d'image donne du
grain et pas de l'eau.

Le **ruissellement** suit `dropDrift()`, qui n'est pas « vers le bas » : c'est la
pesanteur apparente (exactement `-force/masse`) plus la traînée du flux d'air,
qui l'emporte dès ~6 m/s — l'eau remonte donc le cadre en vol rapide. Une bille
ne part que quand la force bat la ligne de contact qui la retient, un seuil en
`1/D²` : les grosses courent, les petites ne bougent jamais, sans aucun drapeau
« celle-ci est mobile ». Elle se réaccroche au défaut suivant environ une largeur
de bille plus loin, ce qui donne le mouvement saccadé. **Rien ne dessine de
traînée** : c'est la traînée qui faisait lire l'ancienne tentative comme une
rayure sur l'objectif.

### Le brouillard

`src/fog.js` — le modèle, sans THREE ni DOM comme le vent et la pluie ; le
shader de tuile fait l'extinction, `loader.setFog()` la pose sur les N matériaux
de chunk, `src/lens.js` dessine le voile.

L'unité est une **distance**, parce que c'est celle dans laquelle un pilote
pense : le panneau affiche « 500 m », pas « 33 % ». La densité exp² que
`TileMaterial.js` attend s'en déduit par `fogRange()` / `fogDensity()`
(`src/rain.js`), jamais l'inverse. La correspondance est **géométrique** entre
l'air clair de la scène et 30 m :

```
R(i) = R0 · (30 / R0)^i          R0 = fogRange(0,00085) ≈ 2035 m
```

C'est la seule échelle sur laquelle « un peu plus de brouillard » veut dire la
même chose à 2 km et à 50 m, et elle rend `i = 0` **exactement** la densité que
la scène chargeait déjà. Les présets sont résolus à l'envers depuis les classes
de visibilité de l'OMM — brume 1200 m, brouillard 500 m, purée de pois 50 m —
et ne tombent donc pas sur des positions rondes du curseur.

Comme la pluie, le brouillard **respire** : deux bandes d'Ornstein-Uhlenbeck de
120 s et 25 s (un banc de brouillard bouge en minutes, pas en secondes) et la
même correction lognormale `exp(-k²/2)`, appliquée à **l'extinction ajoutée** et
non à la portée — les extinctions sont ce qui s'additionne. Monter la
variabilité fait donc aller et venir la visibilité sans épaissir l'air en
moyenne, ce que `tools/selftest.mjs` vérifie sur six graines et dix heures
cumulées : sur vingt minutes une seule graine se balade entre 0,8 et 1,2 de la
moyenne alors que le modèle est non biaisé.

Brouillard et pluie **s'additionnent en extinctions**, ce qui est une
généralisation stricte de ce que #24 avait posé : `FOG_DENSITY × rain.fogScale`
est par définition `FOG_DENSITY + l'extinction de la pluie`, donc curseur
brouillard à zéro l'image est celle d'avant, au bit près.

Le **ciel** suit, sinon le bord de tuile cesse de se dissoudre dans le fond. Il
part du bleu-gris clair, s'assombrit sous la pluie (la lumière traverse de l'eau
et du nuage) puis blanchit sous le brouillard (ce qu'on regarde *est* la lumière
diffusée) — dans cet ordre, pour qu'à cinquante mètres de visibilité le ciel
soit le brouillard et rien d'autre. Interpolé sur les octets bruts : voir le
bug #10 du HANDOFF.

La **diffusion de la lumière** est rendue comme un **voile d'objectif** dans
`src/lens.js` : six taps sur une spirale large, au niveau de mip correspondant,
mélangés au ciel, ajoutés puis renormalisés par `1 + k`. Ajoutés et non fondus,
parce que le voile est de la lumière qui arrive — c'est ce qui lève les noirs,
et c'est pourquoi une photo prise dans le brouillard n'a pas de noir. La
division est l'exposition que la caméra aurait reprise, et elle empêche le ciel
d'écrêter. `uGlare` à zéro **compile l'effet hors du shader**, comme `LINK_OFF`.

Deux choses ne sont **pas** ici et sont des issues à part : la brume au sol et la
variation avec l'altitude, qui demandent une position monde dans le fragment
shader de `TileMaterial.js`, et le halo directionnel autour du soleil, qui
demande un soleil (#23).

### Le son

Rien n'est chargé : `src/audio.js` synthétise tout en Web Audio depuis les
quatre régimes moteur. Chaque moteur a ses propres oscillateurs, accordés sur sa
fréquence de passage de pale (≈ 530 Hz au stationnaire, ≈ 1420 Hz à fond), plus
ses harmoniques et du bruit large bande ; les quatre sont panoramiqués selon
leur position sur la cellule. Les régimes divergent dès qu'on met du manche, et
c'est ce battement entre eux qui fait le son d'un quad en virage — les fusionner
en un seul oscillateur perdrait exactement ce qui vaut le coup.

S'y ajoutent le souffle aérodynamique (indexé sur la vitesse *air*, donc plus
discret vent arrière), le propwash en descente, et un bruit d'impact dont le
niveau suit la force de contact.

Le spectre est borné volontairement : sinus plutôt que dents de scie, passe-bas
par moteur et passe-bas général, et un limiteur au-dessus de tout. Une synthèse
qui laisse filer son énergie dans 2–8 kHz est épuisante au bout de dix minutes,
et c'est précisément la bande où l'oreille est la plus sensible. Les quatre
moteurs sont aussi légèrement désaccordés entre eux : à commande égale le modèle
leur donne le même régime exact, et quatre oscillateurs rigoureusement cohérents
sonnent comme un synthé, pas comme un quad.

Volume et **timbre** dans le panneau `Tab`, retenus d'une session à l'autre ;
le timbre déplace les deux coupures de ×0,5 à ×2 autour du réglage mesuré, à
régler selon le casque. Son coupé en caméra libre. Le son démarre au clic sur `OPEN` dans le terminal
(ou au premier geste quand `?scene=` saute le terminal) : les navigateurs
refusent de faire du bruit avant un geste de l'utilisateur.

### Le rendu FPV

Une caméra rectilinéaire parfaite ne ressemble pas à un retour vidéo FPV, et
c'est ce que corrige `src/lens.js` : une seule passe plein écran qui fait le
barillet, l'aberration chromatique latérale, la mollesse des bords, le
vignettage et le flou de mouvement.

Trois réglages dans le panneau `Tab`, section **Objectif**, retenus d'une
session à l'autre :

| réglage | par défaut | ce qu'il fait |
|---|---|---|
| **Rendu FPV** | activé | l'interrupteur maître : décoché, l'image redevient celle d'avant, ce qui est la seule façon honnête de comparer |
| **Objectif** | 60 % | barillet, aberration chromatique et mollesse des bords ensemble — c'est le même bout de verre, les séparer laisserait construire une optique qui n'existe pas |
| **Vignettage** | 50 % | l'assombrissement des coins |
| **Obturation** | 8 ms | le temps de pose, donc la longueur de la traînée ; 0 coupe le flou |

Le barillet est normalisé au coin : il ne mange pas de champ de vision, il
grossit le centre (×1,26 par défaut). Le curseur FOV garde donc exactement le
sens qu'il avait.

Le flou de mouvement ne lit pas la profondeur. Le monde est statique et la
caméra est la seule chose qui bouge, donc le flou de rotation se reconstruit en
reprojetant les rayons de vue à travers la rotation faite pendant la pose — ce
qui rend le flou juste sans toucher à `camera.near`. La parallaxe de translation
est la part qui manque.

Coût mesuré sur la Tour Eiffel en 2560×1265 : **1,14 ms/frame** sur un budget de
10 ms. Contrairement à ce qu'on pourrait croire, baisser l'obturation ne
récupère que 0,47 ms de ce total ; si les images chutent, c'est la case
**Rendu FPV** qu'il faut décocher, pas le flou.

### Le lien vidéo

Le retour vidéo arrive par la radio, et la radio ne passe pas à travers les
immeubles. `src/link.js` calcule un bilan de liaison en dB entre le drone et le
pilote — qui se tient au point de décollage — et `src/lens.js` en fait une
image dégradée, en fin de chaîne, après l'objectif.

**L'analogique a un aspect même à plein signal.** C'est le point le plus
important et le moins évident : un retour composite n'est pas une image propre
qui casse ensuite, il est dès la première trame mou, lavé et bavé en couleur.
La bande passante de chrominance vaut une fraction de celle de luminance, donc
la couleur déborde latéralement pendant que les contours restent nets. C'est ça
qui fait « retour FPV » plutôt que « moteur de rendu qui bugue » — la
dégradation vient **par-dessus**. Le mode numérique, lui, est propre : à lien
parfait il rend un pixel de ciel à `#9fb8cc` exact, comme sans l'effet.

Ce qui pilote la dégradation est **la distance et l'occlusion**, la seconde
comptant plus que la première. La qualité glisse continûment avec la distance
(1,00 à 50 m → 0,80 à 300 m → 0,64 à 900 m) : il y a donc toujours quelque
chose à lire, plutôt qu'une image parfaite jusqu'à l'instant où elle disparaît.
Un immeuble entre vous et le pilote descend à ~0,50 — nettement dégradé,
parfaitement volable. Seul un vol bas et lointain à travers tout un quartier
coupe vraiment le lien.

L'occlusion est mesurée par **deux raycasts**, un depuis chaque bout : le
premier impact à l'aller dit où la matière commence, le premier impact au
retour dit où elle finit, et l'écart est l'épaisseur à traverser. Un seul rayon
ne dirait que « quelque chose bloque », et effleurer l'angle d'un toit (0,86)
deviendrait aussi grave que passer derrière un pâté de maisons (0,50). Coût
mesuré : 0,002 à 0,016 ms par frame selon ce que le rayon traverse.

L'atténuation par la profondeur **sature** au lieu d'être linéaire, et les
constantes de temps sont lentes (0,30 s à la chute, 0,70 s à la remontée). Les
deux servent la même chose : la géométrie est une marche d'escalier — le mur
est sur le trajet ou il n'y est pas — donc sans ça le lien est un interrupteur
et pas un fondu. Passer un angle prend maintenant ~780 ms à l'écran.

Deux réglages dans le panneau `Tab`, section **Lien vidéo** :

| réglage | par défaut | ce qu'il fait |
|---|---|---|
| **Rendu** | Analogique | *Analogique* : bave de chrominance et image lavée en permanence, puis grain, désaturation, décrochage de lignes, barre de synchro et enfin neige. On voit le lien s'affaiblir. *Numérique* (DJI/HDZero) : net jusqu'au seuil, puis macroblocs, quantification et gel d'image. Ça tient, puis ça tombe |
| **Dégradation** | 100 % | à la fois l'agressivité de la chute et la force de l'aspect analogique de base ; à 0 % l'effet est compilé hors du shader |

Le RSSI est affiché en haut à droite, sinon une image qui se désagrège se lit
comme un bug de rendu plutôt que comme une information.

Coût mesuré : **1,0 ms/frame au pire** sur un budget de 10, dont 0,12 ms pour
les quatre taps de chrominance de l'analogique. Une image gelée coûte 0,60 ms
au lieu de 1,41 : elle n'est pas rendue du tout, seulement réaffichée.

### Régler le PID

```bash
npm run tune                  # temps de montée / dépassement / stabilisation / rebond
npm run tune -- --sweep roll  # balaye P et D sur un axe et classe par coût
```

Le banc intègre les équations d'Euler avec le vrai tenseur d'inertie et le vrai
retard moteur, sans Rapier ni navigateur : une passe complète prend une
seconde. Ses seuils de réussite sont dérivés de l'accélération angulaire
soutenue que la cellule peut réellement produire, pas de constantes écrites à
la main — un preset ne peut donc pas « échouer » simplement parce qu'il demande
plus de taux qu'un autre.
