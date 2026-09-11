# Manuel — FPVThePlanet!

Le manuel technique : commandes, pipeline de cartes, modèle de vol, réglages.
Pour savoir ce qu'est ce projet et comment y jouer, voir le
[README](../README.md).

Toutes les commandes de ce document se lancent depuis `sim/`.

```bash
cd sim
npm run selftest           # vérifications hors-navigateur (voir la limite en bas de page)
npm run selftest:operator  # état opérateur, terminal, scanner, météo du monde
```

## Sommaire

`grep -n '^#' docs/manuel.md` pour la ligne exacte d'une section.

- Contrôles
- Ajouter une carte — depuis le jeu (GLOBAL SCANNER) · l'ancienne GUI ·
  en ligne de commande · prérequis · options · dimensionner `--radius` ·
  retoucher une carte
- Musique — le pipeline de génération · boucles · normalisation · write-once
- Supprimer une carte — quand une zone ne renvoie rien
- Le terminal opérateur
- Faire tourner le jeu sans Vite — le serveur autonome
- Le pipeline de dialogue (RTC du crew) — `dialogue:gen` · `dialogue:inspect` ·
  `dialogue:check` · les deux dos · la politique de relecture
- Cartes disponibles
- Exporter une scène en `.glb`
- Versionner et publier — l'intégration continue · couper une version
- Architecture
- Limite connue : `selftest` spécifique à la Tour Eiffel
- Détails techniques du pré-traitement — fournisseurs et décodeurs · fixtures
  rocktree · trois réglages qui comptent · sur le gris
- Le modèle de vol — le vent · la pluie · le brouillard · le son · le rendu FPV ·
  le lien vidéo · limites de zone · régler le PID

## Contrôles

**Manette / radio USB** détectée automatiquement (Mode 2 par défaut), remappable
dans **Tab** avec des barres de niveau en direct pour identifier chaque axe.
**Chrome recommandé** : la Gamepad API y est plus permissive (détection sur
simple mouvement de stick) que sur Firefox, plus strict sur le focus de
l'onglet et parfois l'appui d'un bouton avant de faire apparaître le
périphérique.

**Clavier** : `W`/`S` gaz · `A`/`D` lacet · flèches ou souris roulis-tangage ·
`R` respawn · `M` mode (acro/angle/altitude) · `C` caméra libre · `Tab` réglages.

## Ajouter une carte

Une carte = une zone téléchargée (Google Earth — voir
[Fournisseurs et décodeurs](#fournisseurs-et-décodeurs)) puis convertie pour
le moteur.

### Depuis le jeu — `GLOBAL SCANNER` (voie principale)

```bash
npm run dev        # puis http://localhost:5173 → [ GLOBAL SCANNER ]
```

Le scanner est le point d'entrée mondial du jeu (PHASE 03) : on cherche un lieu
(`SEARCH LOCATION`, ou des coordonnées « lat, lon »), on cadre, on dessine la zone
— `DRAW BOX` pour un rectangle, `DRAW SHAPE` pour un tracé libre — et
`AREA ANALYSIS` affiche avant de lancer la grille de tuiles, le
nombre de requêtes, la surface, le poids estimé et la durée. `PROBE AREA`
télécharge un échantillon réel au centre de la zone — c'est la seule preuve
fiable qu'il y a de la photogrammétrie ici. `ACQUIRE AREA` lance le vrai
pipeline avec les logs en direct, et propose `[ FLY ]` à la fin.

Le fond est monochrome par défaut (`MONO`, OpenStreetMap inversé et désaturé) ;
`SAT` et `TERRAIN` sont là quand reconnaître un bâtiment ou un relief aide à
cadrer. `SIGNAL DENSITY` / `TARGETS EST.` sont des estimations d'activité radio
(Bible §6) : elles partent de la catégorie OSM d'un point de la zone et de sa
surface, sans rien tirer au sort — la génération de cibles, elle, est PHASE 7.

#### Le tracé libre

Un fleuve, une avenue, un contour de quartier ne sont pas des rectangles : les
suivre au rectangle oblige à embarquer les blocs voisins. `DRAW SHAPE` (issue #30)
délimite la zone au polygone.

**Une tuile est retenue dès que le tracé la touche, même d'un coin.** La zone
extraite est donc toujours un *sur-ensemble* de ce qui est dessiné — même règle
que le rectangle, déjà arrondi vers l'extérieur sur le treillis. Deux
conséquences voulues : ce qu'on dessine est toujours entièrement couvert, et un
corridor plus fin qu'une tuile (~25 m au zoom 20) reste extractible, là où une
règle « centre dans le tracé » lui rendrait zéro colonne.

La carte ne montre alors plus un rectangle bleu mais **l'escalier** des tuiles
retenues : la forme réellement extraite, par opposition au tracé lissé qui reste
en pointillé. Contrairement au treillis, il est dessiné à toute échelle.

`TILES` annonce le nombre de colonnes réellement balayées sur celui de l'emprise
(« 8,069 / 15,812 ») : sur un tracé, le produit `cols × rows` serait l'emprise et
laisserait croire à deux fois plus de téléchargement qu'il n'y en a.

Le prédicat « cette tuile touche-t-elle le tracé ? » vit dans
`tools/lib/tiles.mjs`, partagé par le scanner (navigateur) et l'API de dev
(Node) : `node tools/map-poly-selftest.mjs` le vérifie sur des cas raisonnés à
la main.

### L'ancienne GUI d'extraction

`http://localhost:5173/add-map.html` fait toujours la même chose, en français et
hors du jeu. Le scanner l'a absorbée ; elle disparaîtra avec la mise en scène de
l'acquisition (PHASE 5).

Le sélecteur **FOURNISSEUR** y propose `Auto` (seul `Google Earth` est inscrit
depuis le retrait d'Apple Flyover, 2026-09-07) ou `Google Earth` explicitement.

Deux choses valent d'être comprises :

- **La zone est quantifiée.** Une tuile fait environ 25 m de côté au zoom 20 ;
  la zone réellement extraite est celle dessinée arrondie au treillis. La
  carte affiche ce treillis, et le tracé dessiné reste en pointillé à côté. Sur un
  polygone, l'emprise cède la place à l'escalier des tuiles retenues.
  Ce treillis n'est pas un décor : il vient de `tileGrid()` (`tools/lib/tiles.mjs`)
  — c'est exactement la grille que l'acquisition balaiera. Le grisage d'une
  région hors couverture déclarée (`plan.pruned`) reste dans le code pour un
  futur fournisseur à régions déclarées ; `google-earth` ne le déclenche jamais
  (sa traversée `rocktree` n'a pas cette notion).
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

1. **Téléchargement** — le fournisseur (`google-earth` par défaut) traverse
   l'octree `rocktree` autour de `lat,lon` et écrit ses nœuds dans
   `sim/.cache/google-earth/<lat>-<lon>-<zoom>-<radius>-<altitude>/`.
2. **Post-traitement** — `tools/prep.mjs` convertit ce `.obj` (ECEF, un JPEG par
   matériau) en binaires prêts pour le moteur (ENU en mètres, textures
   regroupées en planches) dans `public/scenes/<slug>/`. Voir
   [Détails techniques](#détails-techniques-du-pré-traitement) pour ce que fait
   réellement cette étape et pourquoi elle est nécessaire.
3. **Enregistrement** — la carte est ajoutée à `public/scenes.json`, donc elle
   apparaît dans le menu au prochain `npm run dev` (pas besoin de relancer le
   serveur s'il tourne déjà, un simple rechargement de page suffit).

## Musique

L'arc musical (issue #122) : une bibliothèque de morceaux générés localement,
un par session, dont l'intensité suit le vol. Chaque famille de drone a son
genre — cf. Bible §34.

Les morceaux sont **commités** dans `public/music/` (Opus 96 kbps, ~1,1 Mo pour
90 s) et décrits par `public/music.json`. Le jeu se lance et se joue sans eux :
manifeste absent ou fichier manquant, il reste silencieux.

Le pipeline, dans l'ordre. Il demande une installation locale de
[Stable Audio 3](https://github.com/Stability-AI/stable-audio-3) (~10 Go avec
les poids), hors du dépôt, désignée par `FPVTP_STABLE_AUDIO` :

```bash
export FPVTP_STABLE_AUDIO=/chemin/vers/stableaudio3.0

npm run add-music -- --pool all --count 10 --seed-base v6   # → .music-staging/ (gitignoré)
npm run music-gate                                          # rejet automatique mesuré
npm run music-loop                                          # boucle + normalisation + Opus
npm run music-review                                        # écoute : o accepter, k refuser
```

**`--seed-base` est obligatoire en pratique, et c'est le piège du pipeline.**
La graine détermine les prompts *et* les identifiants : la réutiliser ne produit
pas d'autres morceaux, elle rend exactement les mêmes, que le générateur saute
ensuite comme déjà présents. On croit avoir agrandi la bibliothèque et il ne
s'est rien passé. `add-music` refuse désormais une graine déjà représentée au
manifeste et propose la suivante — prends celle qu'il donne.

`--pool` accepte `all`, une liste séparée par des virgules, ou l'une des sept
clés : `menu`, `freestyle5`, `race5`, `cinewhoop`, `longrange`, `heavy5`,
`toothpick` (les six dernières sont les familles de `src/drone-profiles.js`).
Une liste vaut mieux que plusieurs commandes : le modèle met plus longtemps à
charger qu'à générer, et un lot ne le charge qu'une fois.

Compter environ **8 s par morceau** plus 20 s de chargement. Ne pas toucher au
nombre de pas de diffusion : 8 est le régime nominal du modèle, pas un
raccourci de vitesse — le monter dégrade la sortie de plusieurs dB et la fait
partir hors-style (cf. le commentaire de `DEFAULTS` dans `tools/music-gen.mjs`).

Pour retirer des morceaux — du manifeste **et** du disque, la règle write-once
disant qu'un fichier n'est jamais réécrit, pas qu'il est éternel :

```bash
node tools/music-retire.mjs --before v6          # coup à blanc : ne garde que v6
node tools/music-retire.mjs --id <id> --apply    # ou un par un
```

Il refuse de vider un pool : un pool sans musique rendrait le jeu muet pour
toute une famille de drone.

Trois choses à savoir :

- **Stable Audio ne produit pas de boucles.** `music-loop.mjs` crossfade les
  3 dernières secondes par-dessus les 3 premières, ce qui rend les deux
  jonctions continues. La touche `l` de la revue fait entendre exactement cette
  couture.
- **Tout est normalisé à -14 LUFS**, en deux passes. C'est ce qui permet de
  calibrer le mix une seule fois pour toute la bibliothèque.
- **Write-once.** Un fichier commité n'est jamais réécrit : git ne
  delta-compresse pas l'audio et n'oublie rien. Un morceau recalé après coup est
  retiré du manifeste et supprimé, jamais régénéré sous le même nom.

Les prompts et les six axes de variation sont dans `tools/music-prompts.mjs` —
c'est la source de vérité créative, pas un détail d'implémentation.

## Supprimer une carte

```bash
npm run remove-map -- <slug>
```

Le `slug` est celui dans `public/scenes.json` (ex. `sacre-coeur`). Ça retire
l'entrée de `scenes.json` (donc la carte disparaît du menu au prochain
`npm run dev`/rechargement) et supprime `public/scenes/<slug>/`.

La tuile brute téléchargée sous `sim/.cache/google-earth/` n'est **pas**
supprimée par défaut — c'est la partie lente à retélécharger, donc `add-map`
peut la réutiliser telle quelle si la carte est rajoutée plus tard. Ajouter
`--raw` pour la supprimer aussi :

```bash
npm run remove-map -- <slug> --raw
```

### Quand une zone ne renvoie rien

Google Earth ne propose de la photogrammétrie 3D partout, mais pas à toutes
les résolutions : au niveau de zoom demandé, la traversée `rocktree` peut ne
trouver aucun nœud utilisable. `add-map` s'arrête alors avec un message
explicite (« Google Earth ne couvre pas cet endroit à ce niveau ; essaie un
zoom plus bas ») plutôt que d'écrire une carte vide.

`PROBE AREA` dans le scanner (voir plus haut) télécharge un petit échantillon
réel au centre de la zone avant de lancer l'acquisition complète — c'est la
façon de tester rapidement si un endroit est couvert.

### Prérequis

**Aucun.** Le protocole `rocktree` de `kh.google.com` ne demande ni clé ni
jeton — vérifié live sur plusieurs endpoints.

### Options

```bash
npm run add-map -- "Nom" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20]
                                      [--cell 256] [--quality 85]
                                      [--slug identifiant] [--force]
                                      [--provider google-earth]
                                      [--bbox s,w,n,e]
                                      [--poly "lat,lon lat,lon ..."]
```

| Option | Défaut | Effet |
|---|---|---|
| `--provider` | `google-earth` | Fournisseur des octets (voir [Fournisseurs et décodeurs](#fournisseurs-et-décodeurs)) — un seul inscrit aujourd'hui, mais un id invalide échoue tout de suite plutôt que de deviner. |
| `--zoom` | 20 | Niveau de zoom (~13-20), converti en niveau d'octree (`niveau = zoom + 1`, cap 22 — voir plus bas). |
| `--radius` | 25 | Rayon du scan en tuiles autour du centre. Voir plus bas pour dimensionner. |
| `--altitude` | 20 | Sans effet avec `google-earth` (hérité d'un fournisseur retiré) ; accepté pour compatibilité avec les scènes déjà enregistrées. |
| `--cell` | 256 | Taille en pixels de chaque cellule de texture. Coûte cher : chaque doublement **quadruple** la VRAM. `128` = qualité réduite mais VRAM divisée par 4 (utile sur machine modeste). |
| `--quality` | 85 | Qualité JPEG des planches de texture générées. |
| `--slug` | dérivé du nom | Identifiant de dossier (`public/scenes/<slug>/`). Auto-généré depuis le nom (accents et espaces retirés) si omis. |
| `--bbox` | — | Extrait un rectangle lat/lon explicite au lieu du carré centré. `--radius` est alors ignoré. |
| `--poly` | — | Extrait un polygone libre : seules les tuiles que le tracé touche sont balayées. Au moins 3 sommets, l'anneau se referme tout seul, les paires se séparent par un espace ou une virgule. Exclusif avec `--bbox`. |
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
node tools/prep.mjs .cache/google-earth/<dossier-tuile> \
  --out public/scenes/<slug> --cell 128
```

(`npm run add-map` fait exactement ça en interne, avec le téléchargement en plus.)

## Le terminal opérateur

`npm run dev` ouvre l'Operator Terminal (PHASE 02). `LOCAL TERRAIN` liste tout
ce qu'il y a dans `public/scenes.json` avec sa taille réelle sur disque ;
`OPEN` lance le vol. `GLOBAL SCANNER` ouvre le scanner mondial (PHASE 03, voir
« Ajouter une carte »). `SESSION LOG` et `TARGET LOG` restent des souches
jusqu'à leurs phases respectives.

Pour sauter le terminal (lien direct, dev rapide) :

```
http://localhost:5173/?scene=<slug>
http://localhost:5173/?scene=<slug>&family=freestyle5            # profil nominal, gris
http://localhost:5173/?scene=<slug>&family=freestyle5&build=g1::0 # un exemplaire tiré (#285)
```

Le `slug` est celui visible dans `public/scenes.json` ou dans le nom du
dossier `public/scenes/<slug>/`. `?family=` seul vole le profil NOMINAL de la
famille (celui du banc et de `tools/tune-pid.mjs`) ; `?build=<graine>` tire
l'exemplaire — livrée, châssis, portrait — comme le ferait un TARGET SCAN.

Vérification headless derrière un proxy qui refuse le CONNECT de Chromium :
`VITE_ROCKTREE_BASE=http://127.0.0.1:8124/rt/earth/ npx vite` fait lire le
terrain Google à un relais local (voir `tools/lib/rocktree/url.mjs`).

### Le briefing

Un opérateur qui vient d'être créé passe par un briefing de quatre écrans
(`INPUT`, `THE TERMINAL`, `A SESSION`, `BRIEFING COMPLETE`), juste après
l'enregistrement de l'opérateur (bootstrap : hardware, `OPERATOR NAME`, puis le
briefing — deux écrans avant lui depuis le retrait du CONTROL VECTOR, issue
#33). Il énonce ce qu'une chose est et ce qu'une
touche fait — jamais quoi faire — et Échap le saute d'un coup. L'écran `INPUT`
lit le mappage EN DIRECT (`src/key-map.js`) et offre `[ CALIBRATE ]` ou
`[ MAP KEYS ]`, qui ouvrent l'onglet correspondant de `SETTINGS` et reviennent.

Il se rejoue par `SETTINGS` › `SYSTEM` › `[ REPLAY BRIEFING ]`.

Deux clés `localStorage` le pilotent : `fpvtp.briefingSeen` (posée dès que le
briefing a été montré, lu ou sauté) et `fpvtp.firstFlightDone` (posée à la fin
du premier vol hors banc). Entre les deux, le premier vol affiche trois lignes
brèves — `THROTTLE UP`, `[TAB] SETTINGS`, `[HOLD K] CUT LINK` —, décidées par
`tools/briefing-model.mjs` et peintes par l'OSD. `[ RESET SETTINGS ]` efface
les clés `fpvtp.*` : le briefing rejoue, ce qui est bien ce qu'une remise à
zéro veut dire.

## Faire tourner le jeu sans Vite — le serveur autonome

`npm run dev` reste la façon de développer. Mais un `npm run build` seul ne
démarrait pas : `/__operator` et `/__map-api` n'existaient qu'en plugin Vite, et
le terminal mourait au boot sur la première requête (issue #259). `sim/server/`
est ce même serveur, sans Vite :

```bash
npm run build
node server/index.mjs --data ~/.local/share/fpvtp --dist dist --open
```

| option | défaut | env |
|---|---|---|
| `--data <dir>` | les chemins du dépôt (`public/scenes`, `operator-state/`, `.cache/`) | `FPVTP_DATA_DIR` |
| `--port <n>` | `8080` (`0` = un port libre) | `FPVTP_PORT` |
| `--host <addr>` | `127.0.0.1` | `FPVTP_HOST` |
| `--mode local\|shared` | `local` | `FPVTP_MODE` |
| `--dist <dir>` | `sim/dist` | — |
| `--open` | non | — |

L'option de ligne de commande gagne sur la variable d'environnement.

Le répertoire de données regroupe tout ce qui appartient à l'installation et
non au programme — c'est ce qui permettra à une mise à jour de ne rien écraser :

```text
<data>/
  scenes/<slug>/        les terrains acquis
  scenes.json           le catalogue, propre à cette installation
  operator-state/       les opérateurs et leurs sessions
  cache/google-earth/   les nœuds rocktree déjà téléchargés
```

`tools/lib/paths.mjs` est le seul endroit qui résout ces chemins, et **sans
`FPVTP_DATA_DIR` il rend exactement ceux d'aujourd'hui** : `npm run dev` ne
change pas de comportement. La variable est lue à l'import du module, donc elle
doit être posée avant tout — c'est ce que fait `server/index.mjs`.

Deux choses à savoir :

- **En `local`, le serveur refuse un `--host` hors de `127.0.0.1`/`::1`.** La
  frontière de sécurité est le socket local, la même qu'avec le serveur de dev.
  `--mode shared` lève le garde-fou, mais l'authentification qui va avec (clé
  d'opérateur) n'existe pas encore : voir la tranche T3 du design
  (`docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md`).
- **Aucun repli SPA.** Un fichier absent rend un vrai 404 JSON, jamais
  `index.html` : le chargeur (`src/loader.js`) distingue une scène présente
  d'une scène absente par le type de contenu, et un hébergeur qui rabat tout sur
  la page lui ment (issue #275).

`tools/map-api-plugin.mjs` n'est plus qu'un adaptateur : il monte le même
`createApi()` sur les middlewares de Vite. `tools/vite-adapter-selftest.mjs`
vérifie qu'il ne dérive pas du serveur.

## Le pipeline de dialogue (RTC du crew)

`public/dialogue/*.json` (un shard par événement, plus `manifest.json`) est du
**contenu versionné, pas un artefact de build** : il se commite comme le
reste, ne se régénère pas au lancement, et un joueur qui ignore entièrement
les RTC du crew (`root`, `jensen`, `mikhail`, le processus `cron`) ne rate
aucune information de jeu — c'est le critère d'acceptation de PHASE 21.

Trois commandes, toutes des outils de développement (rien sous `src/` ne les
importe, vérifié par `tools/dialogue-selftest.mjs`) :

```bash
npm run dialogue:gen -- --event ACQUIRE_AREA --count 200 [--batch 20] \
  [--rarity COMMON] [--backend claude|ollama] [--dry-run]
npm run dialogue:inspect -- --event ACQUIRE_AREA [--count 30] [--rarity RARE]
npm run dialogue:check     # = node tools/dialogue-selftest.mjs
```

`dialogue:gen` pilote un LLM par lot (`tools/dialogue/generate.mjs`,
`tools/dialogue/prompts/`) avec deux dos :

- `--backend claude` (par défaut) : `claude -p --output-format json`, sans
  configuration préalable ;
- `--backend ollama` : un modèle local via `http://127.0.0.1:11434` (modèle
  par défaut `batiai/qwen3.6-27b:q3`, configurable par `--ollama-host` ou
  `OLLAMA_HOST`). C'est le **chemin retenu pour la génération en lot** :
  mesuré à 4,9 s par entrée, environ 9 h pour tout le corpus, à coût nul —
  contre une estimation de 100 à 200 USD via une API hébergée pour le même
  volume.

`dialogue:inspect` rend N tirages avec des contextes factices pour la
relecture humaine. Politique de relecture : **100 % des entrées `RARE` et
`VERY_RARE`, 100 % des lignes de `jensen`**, un échantillon de **10 %** pour
le reste. Un lot qui dépasse 5 % de rejet au premier passage (style, slots,
doublons) se **régénère en entier** plutôt que de se corriger réplique par
réplique — la dérive de ton d'un lot se corrige mieux en le rejouant qu'en le
rustinant.

`dialogue:check` fait tourner `validate.mjs` (forme, `speaker` connu, slots
vs `requires`, liste noire de style — adresse au joueur, quatrième mur,
vocabulaire IA moderne, promesse de suite) et `dedupe.mjs` (quasi-doublons
par trigrammes) sur tout corpus livré.

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

## Versionner et publier

Le numéro vit dans `sim/package.json` (SemVer), les changements dans
[`CHANGELOG.md`](../CHANGELOG.md) à la racine, et chaque version publiée porte
un tag git `vX.Y.Z` et une GitHub Release.

Au fil du travail, les entrées s'ajoutent sous la section `## [Non publié]` du
CHANGELOG — rubriques `Ajouté`, `Modifié`, `Corrigé`, `Retiré`, `Déprécié`,
`Sécurité`.

### L'intégration continue

`.github/workflows/ci.yml` tourne sur chaque push vers `main` et chaque pull
request, en deux jobs :

- **sim** — `npm run selftest:ci` puis `npm run build`.

```bash
npm run selftest:ci   # ~1 430 vérifications, ~2 min — à lancer avant de pousser
```

`selftest:ci` est la chaîne qui ne demande **ni scène installée, ni réseau, ni
navigateur** : c'est ce qui la rend jouable sur un runner, où `public/scenes/`
(gitignoré, ~900 Mo) n'existe pas. Un selftest qui a besoin de données de scène
se retire en disant `SKIP` au lieu d'échouer — `tools/entry-state-selftest.mjs`
est le modèle à suivre.

Restent locaux, par nature : `npm run selftest` (rejoue la scène `tour-eiffel`)
et `npm run selftest:scenes` (compare `scenes.json` aux scènes installées sur
*cette* machine).

`selftest:ci` finit par `npm run fuzz`, la passe de fuzzing — graine fixe, donc
déterministe comme le reste de la chaîne :

```bash
npm run fuzz                    # tools/fuzz.mjs puis tools/fuzz-api.mjs
node tools/fuzz.mjs --list      # les cibles et leur modèle de menace
node tools/fuzz.mjs --only flight --cases 20000 --seed 7
node tools/fuzz-api.mjs --cases 2000     # vrai serveur, requêtes malformées
```

Elle vise ce que les selftests ne visent pas : l'entrée que personne n'a écrite
— une clé `localStorage` éditée à la main, un fichier opérateur à moitié écrit,
un axe de manette en butée, un état physique parti en NaN, un corps HTTP qui
n'est pas du JSON. Chaque cible déclare un invariant que le code promet vraiment
et le modèle de menace de son entrée ; une trouvaille se rejoue avec
`--seed <n> --cases <n>`. Le détail, et ce que la première passe a trouvé :
[`sim/docs/handoff-archive/fuzzing.md`](../sim/docs/handoff-archive/fuzzing.md).

Il n'y a **pas de déploiement continu** : le build statique ne sait pas démarrer
seul, il lui faut l'API opérateur `/__operator` que seul le serveur de dev
fournit. Voir `HANDOFF.md`, section « Versionnage du dépôt ».

### Couper une version

```bash
npm run release -- patch             # 0.1.0 → 0.1.1  (correctifs)
npm run release -- minor             # 0.1.0 → 0.2.0  (ajouts compatibles)
npm run release -- major             # 0.9.0 → 1.0.0
npm run release -- 1.2.0             # un numéro explicite
npm run release -- minor --dry-run   # dit ce qu'il ferait, n'écrit rien
```

Le script bump `package.json` et le lockfile, date la section « Non publié » et
en rouvre une vide, régénère les liens de comparaison, commit
`chore(release): vX.Y.Z` et pose un tag annoté. Il refuse un arbre de travail
sale, une section « Non publié » vide, un numéro qui ne monte pas, un tag déjà
posé.

Il ne pousse rien — le push du tag est ce qui publie :

```bash
git push -u origin <branche>
git push origin v0.1.0
```

`.github/workflows/release.yml` prend le relais : il vérifie que le tag et
`sim/package.json` disent le même numéro, rejoue `npm run selftest:ci`, build le
sim, puis crée la GitHub Release avec le corps repris du CHANGELOG
(`node tools/release-notes.mjs v0.1.0`) et `dist` en archive zip.

La version est injectée dans le build par Vite (`__APP_VERSION__`), exposée sur
`window.FPVTP_VERSION` et écrite une fois dans la console : un rapport de bug
peut nommer une version au lieu d'un SHA.

La première version n'est pas encore coupée : `package.json` est à `0.0.0`,
tout est sous « Non publié », et `npm run release -- minor` sortira `v0.1.0`.

Les numéros de build de l'écran `BUILD NOTES` (`tools/buildnotes-model.mjs`,
`0.1.0` → `0.9.0`) sont du lore diégétique : aucun rapport avec ces versions-ci.

## Architecture

```
tools/add-map.mjs     téléchargement + pré-traitement + enregistrement, en une commande
tools/prep.mjs         OBJ+MTL+JPEG -> binaires (hors ligne, par carte)
tools/selftest.mjs     vérifications géodésie / vol / collision, sans navigateur
tools/fuzz.mjs         fuzzing des modules purs (vol, état stocké, écrans)
tools/fuzz-api.mjs     fuzzing des routes HTTP contre un vrai serveur
tools/lib/fuzz.mjs     le harnais : générateurs, invariants, réduction, graines
src/loader.js          fetch + workers -> BufferGeometry & DataArrayTexture, sélection de la scène active
src/worker.js           parse le binaire, découpe la planche en layers
src/TileMaterial.js     shader GLSL3 sampler2DArray + brouillard
src/physics.js          monde Rapier, trimesh statique, corps du drone
src/flightController.js rates acro -> couple
src/input.js            Gamepad + clavier/souris
src/fog.js              modèle de visibilité : densité, respiration, voile, couleur de l'air
src/lens.js             passe plein écran : optique FPV (barillet, vignettage, flou, voile)
src/hud.js              OSD de vol + écran de chargement
src/settings.js         panneau de réglages (Tab) : manette, caméra, objectif, lien, son
src/terminal.js         Operator Terminal (Home) : LOCAL TERRAIN, FORECAST, souches
src/scanner.js          GLOBAL SCANNER : Leaflet + Geoman, recherche, zone, sonde, acquisition
src/weather.js          la météo du monde côté client : lit le snapshot, écrit vent/pluie/brouillard
tools/terminal-model.mjs logique pure du terminal (formatBytes, footer) — testée par selftest:operator
tools/scanner-model.mjs logique pure du scanner (analyse de zone, densité de signal, couverture)
tools/lib/tiles.mjs     géométrie de tuiles slippy, partagée navigateur/Node
tools/lib/weather.mjs   modèle météo pur (zones, jours, régimes, garde-fous) — navigateur ET Node
tools/weather-source.mjs acquisition Open-Meteo + cache par zone/jour dans le world state (serveur)
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

### Fournisseurs et décodeurs

Le pipeline a deux seams distincts, et les confondre est l'erreur à éviter :
« d'où viennent les octets » et « comment on les décode » sont deux questions
séparées.

**`tools/lib/providers/`** — d'où viennent les octets. Chaque fournisseur expose
`plan` (estimer sans télécharger), `probe` (y a-t-il vraiment de la donnée ici),
`fetch` (télécharger et rendre un dossier de tuiles), plus `tileDirPath` et son
attribution. `lib/add-map-core.mjs` ne fait plus qu'orchestrer ; `/plan`,
`/probe`, `fetch` et `DELETE /scenes/:slug?raw=1` dispatchent tous par
fournisseur, `add-map.mjs` et la GUI (`add-map.html`) savent tous deux
positionner `opts.provider`.

Un seul fournisseur inscrit aujourd'hui, `google-earth` : Apple Flyover, le
repli d'origine, a été retiré le 2026-09-07 (jeton et outil Go supprimés du
dépôt) :

| id | label | défaut | clé/jeton | cache brut |
|---|---|---|---|---|
| `google-earth` | Google Earth | **oui** (`DEFAULT_PROVIDER_ID`) | aucun | `sim/.cache/google-earth/<zone>/` |

`google-earth` parle le protocole interne **rocktree** de `kh.google.com` —
celui que Google Earth web lui-même utilise, pas la Photorealistic 3D Tiles
API (clé, glTF) initialement envisagée pour ce fournisseur : un HAR du trafic
réel a montré que `kh.google.com` ne demande ni clé ni paramètre de session.
Client Node natif dans `google-earth.mjs` + `decoders/rocktree.mjs`, écrits à
partir de la documentation de protocole d'`earth-reverse-engineering`
(non maintenu, sans licence — code réécrit, pas copié). Détail dans
`docs/superpowers/specs/2026-08-29-second-fournisseur-3d-design.md`
(« Amendement 2026-08-31 ») et l'entrée HANDOFF « Second fournisseur 3D ».

`--provider` (voir [Ajouter une carte](#ajouter-une-carte)) choisit
explicitement en CLI. Le contrat par fournisseur (`plan`/`probe`/`fetch`/
`tileDirPath`/attribution, `tools/lib/providers/index.mjs`) reste dispatché par
`opts.provider` pour un futur fournisseur, même si `google-earth` est seul
inscrit aujourd'hui.

**`tools/lib/decoders/`** — comment les lire. Chaque décodeur expose `sniff`
(sais-tu lire ce dossier ?) et `decode` (rends matériaux, positions ECEF, UV et
triangles). `prep.mjs` choisit par reniflage : **aucun drapeau ne sélectionne le
décodeur**, si bien qu'un fournisseur servant de l'OBJ réutilise le décodeur OBJ
sans rien déclarer. Tout ce qui suit le decode — rebase ENU, chunks, texture
arrays, mesh de collision — ignore le format d'entrée. Le décodeur `rocktree`
(sommets delta-packés, ECEF direct via `matrix_globe_from_mesh`) suit ce même
contrat ; une correction lui est propre : le globe rocktree est une **sphère**
de rayon moyen terrestre (6 371 010 m), pas l'ellipsoïde WGS84 que `prep.mjs`
attend, donc `sphereToWgs84Ecef()` reconvertit chaque sommet avant de le
pousser dans le contrat partagé (sans elle, l'origine d'une scène tombe à
~21 km du point demandé). L'inversion `1 - v` de l'axe UV (voir encart
ci-dessous) reste correcte pour `rocktree` aussi — vérifié en navigateur, pas
d'inversion supplémentaire nécessaire.

> **Attention.** L'inversion de l'axe V vit **dans le décodeur OBJ**, pas dans le
> contrat partagé : OBJ met l'origine UV en bas à gauche, glTF en haut à gauche.
> Un décodeur qui hérite de cette inversion sans la mériter produit les fameuses
> « textures grises » — 21 % de la surface visible échantillonne le remplissage
> gris hors patch. Chaque décodeur tranche pour son compte.

### Fixtures rocktree et leur régénération

`tools/testdata/rocktree/` fige un petit échantillon du protocole
(`.pb` bulks/nodes + `index.json`) depuis un HAR réel de earth.google.com
(2026-08-31, epoch racine 1014, capturé sur Paris) : `tools/rocktree-selftest.mjs`
tourne dessus hors ligne, sans réseau. Le HAR source (114 Mo) n'est **pas**
commité (gitignoré, `docs/*.har`) ; seuls les octets figés le sont. Deux
particularités à connaître avant de régénérer :

- les nœuds sont re-capturés en `!2e1` (JPEG) même si le HAR original les
  avait en `!2e6` (CRN/DXT1) — le fournisseur demande toujours du JPEG, c'est
  ce que les fixtures doivent refléter ;
- quelques bulks intermédiaires absents du HAR (cache navigateur au moment de
  la capture) ont été refetchés en live, à l'epoch de la chaîne (1014).

Pour régénérer avec un nouveau HAR :

```bash
node tools/gen-rocktree-fixture.mjs "<chemin du .har>"
```

`node tools/rocktree-calibrate.mjs [--live]` recalcule la table
`zoom ↔ niveau d'octree` (`meters_per_texel` contre la référence Flyover) ;
`--live` interroge le vrai service au lieu des fixtures — utile si la
calibration mono-latitude actuelle (mesurée sur Paris) doit être vérifiée
ailleurs sur le globe.

### Trois réglages qui comptent

- **UV en V retourné dans `prep.mjs`** — l'OBJ place l'origine UV en bas à
  gauche, `DataArrayTexture` impose `flipY = false` et met donc la ligne 0 des
  données en haut. Sans la conversion, une bonne partie de la surface visible
  échantillonne le remplissage gris hors de la zone utile de chaque imagette
  (constaté à l'origine sur les tuiles Apple Flyover, retiré depuis, mais le
  décodeur OBJ garde la correction pour tout fournisseur qui en servirait). Le
  selftest verrouille les deux symptômes (motifs retournés et plaques grises).
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

Le drone n'est pas une sphère avec une poussée : c'est un multirotor modélisé
moteur par moteur. `src/quad.js` tient la cellule et l'air (retard moteur,
poussée ∝ ω², couple de traînée d'hélice, traînée de rotor, effet de sol,
propwash, batterie qui s'affaisse sous charge et se vide) ;
`src/flightController.js` tient la partie Betaflight (actual rates, PID avec
i-term relax, TPA, feedforward, lissage RC, mixeur airmode) et ne sort que
quatre commandes moteur.

### Les six familles (PHASE 07)

`src/drone-profiles.js` décrit six familles d'appareils — masse, inertie, bras,
hélice, poussée, courbe rpm, retard moteur, coefficients aéro, pack — chacune
documentée par un commentaire « setup réel » :

`5" FREESTYLE` (référence) · `5" RACE` · `CINEWHOOP` · `LONG RANGE` ·
`HEAVY 5"` · `MICRO` (toothpick 2.5").

Le **PID est mesuré par famille**, jamais écrit à la main :
`node tools/tune-pid.mjs --write <famille|all>` balaie P/D contre l'inertie et le
retard moteur de la famille, mesure `torquePerMix`, et réécrit son bloc `pid`.
`npm run tune` en fait le rapport pour les six. `npm run selftest` passe la
boucle enveloppe de vol / propulsion sur chaque famille.

Un airframe bien plus rapide qu'un 5" (le toothpick) porte un `filterScale` qui
ouvre les filtres roll/pitch, comme un vrai build micro. `QUAD` reste le profil
par défaut (5" freestyle, valeurs d'origine inchangées).

Presets de rates, touche `P` : **cinéma** (380 °/s), **freestyle** (820 °/s),
**race** (1100 °/s), **long range** (360 °/s), **micro** (420 °/s). Chaque
famille démarre sur le sien.

Le HUD affiche la tension pack, l'état de charge et le courant : la couleur
suit la tension *par cellule sous charge*, pas l'état de charge, parce que
c'est le chiffre au ratio duquel on pilote. Sous 3,6 V/cellule elle passe à
l'orange, sous 3,4 V au rouge.

### Le scan de cibles et les familles de hack (PHASE 08–09)

Une session fraîche passe par le **TARGET SCAN** (PHASE 08) avant le vol :
`tools/target-model.mjs` tire, de façon déterministe sur la graine de session,
une liste de signaux (famille, RSSI, mode vidéo), le joueur en choisit un, et la
cible résolue est persistée sur la session.

Chaque candidat porte aussi un **`hackType`**, tiré à la génération dans
`tools/target-model.mjs` (tirage dédié, seedé, **indépendant** de la famille, du
signal et de la difficulté du vol). Six familles, concepts crédibles mais
interaction purement abstraite (`HACK_TYPES`) :

`COMMAND INJECTION` · `LINK HIJACK` · `TELEMETRY SPOOF` · `GNSS SPOOF` ·
`NETWORK TAKEOVER` · `FIRMWARE OVERRIDE`.

`sanitizeTarget` (`tools/session-model.mjs`) valide et persiste `hackType` sur la
cible. Juste après le TARGET SCAN, `src/hack.js` joue l'écran **AUTOMATED
ANALYSIS** : un log automatique fixe de quatre lignes et un motif ASCII animé
propre à la famille de hack (`src/hack-grammars.js`, purement décoratif).
L'écran s'arrête sur `MANUAL OVERRIDE REQUIRED` et un bouton `[ JACK IN ]`,
avec `[ESC] ABORT` monté dès l'affichage de l'écran — utilisable pendant tout
le chargement en arrière-plan, pas seulement une fois l'écran armé.
Activer `[ JACK IN ]` termine l'acquisition ; abandonner (Échap ou
`[ESC] ABORT`) résout `runHack()` en `{ aborted: true }` plutôt que de
rejeter, et recharge la page de zone comme le ferait l'annulation d'un TARGET
SCAN. Il n'y a plus de vecteur à retenir ni à retaper entre les deux : le
CONTROL VECTOR, qui occupait cet écran jusqu'à l'issue #33, a été retiré
entièrement (voir la note de révision de la Bible §15 et le bloc PHASE 10 de
la roadmap).

Hook de dev : `?hack=<type>` (ex. `?hack=gnss-spoof`) prévisualise un motif sur
les chemins qui court-circuitent le TARGET SCAN (`?scene=`, `?family=`).

### La météo du monde

Depuis PHASE 04 (issue #41), le temps qu'il fait n'est **pas un réglage**. Il n'y
a plus de curseur vent / pluie / brouillard dans le panneau `Tab` : la météo
appartient au monde et à la session, et chaque zone a sa propre évolution sur
sept jours glissants.

```
tools/lib/weather.mjs    le modèle pur — zones, jours, régimes, garde-fous,
                         traduction vers wind.js / rain.js / fog.js / sun.js
tools/weather-source.mjs Open-Meteo + cache par (zone, jour) dans le world state
src/weather.js           le client : demande le snapshot, écrit les paramètres
```

Le soleil (issue #23, `src/sun.js`) suit la même logique : ni panneau ni
curseur. Sa position vient de la lat/lon de la scène et de **l'heure UTC
réelle** au moment où la page tourne — il n'y a **aucun réglage d'heure**
nulle part dans l'UI, et c'est délibéré : forcer un lever ou un coucher de
soleil casserait la promesse « ce que vous voyez, c'est ce qu'il y a
maintenant » qui porte déjà la météo.

**Une zone, un jour, un bulletin.** La clé de zone est la lat/lon arrondie à
0,01° (~1,1 km) : deux emprises dessinées sur le même quartier partagent leur
météo, deux villes jamais. Le bulletin du jour est écrit dans
`worldState.weather[zone]` de l'opérateur, sur disque. **Relancer une
acquisition ne rejoue donc aucun tirage** : le serveur relit le fichier, sans
même toucher au réseau.

**La source est une vraie API.** Open-Meteo, gratuite, sans clé — l'URL ne
contient que la latitude et la longitude, il n'y a aucun secret à committer. On
lui demande `weather_code`, `precipitation_sum`, `precipitation_hours`, les
vents max et les rafales en daily, plus `visibility` et `cloud_cover` en hourly,
qu'on moyenne par jour. Le cumul quotidien divisé par le nombre d'heures de
pluie donne le **débit** en mm/h, qui est ce que `rain.js` attend — un cumul de
24 mm sur la journée n'est pas 24 mm/h.

**Trois replis, dans cet ordre**, tous testés par `tools/weather-selftest.mjs` :

1. le snapshot du jour déjà en world state — relu, jamais retiré au sort ;
2. Open-Meteo ;
3. le dernier snapshot connu, re-daté, annoncé `stale` et avec une confiance
   abaissée ;
4. une génération procédurale déterministe sur `(zone, jour)`.

Le procédural n'est pas du bruit lissé au hasard. Trois uniformes voisines dans
le temps donnent une quasi-normale ; on repasse par sa fonction de répartition
pour retrouver une **vraie** uniforme, faute de quoi 7 % des jours se collent
sur la borne et Tokyo prend une tempête par semaine. Les lois sont ensuite
calées sur leurs fréquences réelles :

| grandeur | loi | résultat mesuré sur 14 400 jours-zones |
| --- | --- | --- |
| vent quotidien max | Weibull de forme 2 (Rayleigh), échelle 3,5 à 9 selon la zone | médiane 5,7 m/s, p90 10,9, p99 15,0 |
| pluie | seuil + cumul exponentiel, étalé sur un nombre d'heures tiré à part | ~30 % de jours pluvieux |
| brouillard | seuil rare, 2 à 18 % des jours selon la zone | FOG 2,5 %, MIST 2,9 % |
| coups de vent | conséquence des deux premiers | GALE + STORM 0,7 % |

La continuité temporelle vient de l'indexation sur le **jour absolu** : chaque
jour dépend de ses deux voisins, donc le « +1 » d'aujourd'hui est exactement le
« TODAY » de demain, et la prévision ne se dément jamais le lendemain.

**Les garde-fous** (`sanitize()`) tournent avant toute classification, sur les
données de l'API comme sur celles du générateur, parce que les deux produisent
des combinaisons que l'atmosphère ne produit pas : une rafale plus faible que le
vent moyen, ou trois fois plus forte ; de la purée de pois sous une tempête (au
delà de 8 m/s le brassage mécanique décolle le brouillard en stratus) ; de la
pluie sous un ciel bleu ; une visibilité de 30 km sous 25 mm/h, alors que
`rain.js` n'en laisse que 1,7. La visibilité annoncée ne peut jamais contredire
le moteur qui va la rendre.

**La prévision** s'affiche depuis `LOCAL TERRAIN` → `FORECAST` :

```
FORECAST // TOUR EIFFEL

2026-08-29 · OPEN-METEO

TODAY  LIGHT RAIN / MODERATE WIND
+1     CLOUD / MODERATE WIND
...
+6     CLOUD / LOW WIND

WIND   7.1 m/s  G 15.1  SSW
VIS    26 km
RAIN   0.6 mm/h
FOG    NONE

CONFIDENCE ███████████░
```

L'ordre des conditions n'est pas fixe et diffère d'une zone à l'autre. La
confiance décroît avec l'échéance et part de plus bas quand la source est un
repli : une prévision inventée ne s'annonce pas aussi sûre qu'un relevé, et la
barre n'est jamais pleine.

**Pour le debug**, `window.__sim.setWeather / setRain / setFog` restent
ouverts et sont désormais le seul moyen de forcer le temps qu'il fait ;
`window.__sim.weather()` rend le snapshot en cours. `tools/selftest.mjs` suppose
un monde neutre et n'a pas changé.

### Le vent

`src/wind.js` — un champ de vent, pas un vecteur. Quatre entrées, écrites par
le monde et non par un curseur (voir « La météo du monde ») :

| entrée | unité | ce que c'est |
| --- | --- | --- |
| `speed` | m/s | vitesse **à 10 m**, la hauteur à laquelle une station météo mesure — pas la vitesse au drone |
| `direction` | ° | secteur d'**où vient** le vent, convention météo |
| `gust` | 0..1 | un nombre pour trois propriétés — intensité, durée, fréquence — voir plus bas |
| `turbulence` | 0..2 | multiplicateur sur l'intensité que le profil implique déjà, pas l'intensité elle-même |

Ces quatre valeurs se règlent encore à la main depuis la console
(`window.__sim.setWeather({...})`), ce qui est l'accès de debug et le banc de
mesure — pas un panneau caché. `tools/selftest.mjs` s'en sert pour tenir ses
trois vérifications en air calme (tenue d'altitude au stationnaire, vitesse
terminale à plat, immobilité au sol), qui n'ont de sens qu'à vent nul.

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

L'intensité va de 0 à 25 mm/h (`MAX_RATE`), parce que toutes les relations
utilisées sont publiées dans cette unité. Le diamètre médian suit Laws & Parsons
(`D = 0,89 R^0,21` mm), la vitesse de chute Atlas & Ulbrich
(`v = 3,78 D^0,67` m/s) et la concentration se déduit du contenu en eau liquide
de Marshall-Palmer. À 5 mm/h cela donne 1,25 mm tombant à 4,4 m/s, 340 gouttes
par mètre cube — ce qui est la bonne réponse, et ce qui rend l'intensité lisible
en mm/h dans la prévision plutôt qu'en pourcents.

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
pense : la prévision affiche « 500 m », pas « 33 % ». La densité exp² que
`TileMaterial.js` attend s'en déduit par `fogRange()` / `fogDensity()`
(`src/rain.js`), jamais l'inverse. La correspondance est **géométrique** entre
l'air clair de la scène et 30 m :

```
R(i) = R0 · (30 / R0)^i          R0 = fogRange(0,00085) ≈ 2035 m
```

C'est la seule échelle sur laquelle « un peu plus de brouillard » veut dire la
même chose à 2 km et à 50 m, et elle rend `i = 0` **exactement** la densité que
la scène chargeait déjà. `intensityForRange()` est l'inverse exact, et c'est par
là que la météo du monde entre : elle parle en mètres de visibilité, `fog.js`
prend une intensité. Les présets restent résolus à l'envers depuis les classes
de visibilité de l'OMM — brume 1200 m, brouillard 500 m, purée de pois 50 m.

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

### Limites de zone

La carte s'arrête. Ce qu'il y a au-delà n'a jamais été téléchargé — et la
fiction ne fait pas semblant du contraire : **la zone, c'est le rectangle que
le joueur a lui-même tracé dans le `GLOBAL SCANNER`**, et hors de lui il n'y a
pas de données, donc pas de couverture, donc pas de lien. Ce n'est pas une
portée radio : une portée radio serait un cercle centré sur le pilote, or le
point de décollage n'est pas au centre de la carte (sur `tour-eiffel` il est à
(−120, 140) dans une boîte de ±642 m). Le cercle inscrit jetterait la moitié de
la carte, le circonscrit déborderait dans le vide.

Le modèle vit dans `src/geofence.js` — ni THREE, ni Rapier, ni DOM, comme
`wind.js`, `fog.js`, `link.js` et `flight-end.js`. `main.js` en pousse la force
dans Rapier, l'avertissement dans l'OSD et la perte dans le bilan de liaison.

**Quatre anneaux**, décidés par la marge au bord (positive dedans, négative
dehors) :

| anneau | horizontal | vertical (sous `bbox.min.y`) | ce qui se passe |
|---|---|---|---|
| `NOMINAL` | marge > 113 m | au-dessus de −2 m | rien |
| `CAUTION` | 113 → 66 m | −2 → −5 m | `NO COVERAGE` clignote, l'image commence à se dégrader (8 dB) |
| `HOLD` | 66 → 0 m | −5 → −8 m | le rappel monte de 0 à 5,89 m/s², l'image continue de mourir |
| `LOST` | au-delà du bord | sous −8 m | le rappel est plein, la perte s'emballe ; à −66 m (horizontal) ou −10 m (vertical) la session se termine |

Les frontières ont 15 % d'hystérésis (`HYST`) : sans elle, un stationnaire tenu
pile sur le seuil fait strober l'avertissement — `link.js` a exactement le même
problème et exactement la même réponse.

**D'où sortent 66 et 113.** Ils sont mesurés, pas choisis :

```bash
node tools/geofence-measure.mjs                 # R_HOLD et R_CAUTION
node tools/geofence-measure.mjs --guarantee     # le couloir sous lequel la garantie tombe
node tools/geofence-selftest.mjs                # le modèle, sans navigateur
```

`R_HOLD = 66 m` est la distance d'arrêt du pilote qui **obéit** — un programme
de manche explicite (plein gaz à 42° d'assiette à l'approche, gaz ramenés et
tangage tiré à plat dès l'entrée en `HOLD`), balayé sur les six familles et
sur la bande de gaz de freinage, pire cas retenu : `heavy5`, 65,83 m. C'est un
point fixe, pas une soustraction — la rampe du rappel dépend elle-même de
`R_HOLD`. `R_CAUTION = 113 m` ajoute le temps de **lire** l'avertissement à la
vitesse maximale mesurée (30,87 m/s) : 1,5 s, soit trois clignotements à
`BLINK_PERIOD_MS`.

Le rappel plafonne à `A_MAX = 0,6 g`, soit 60 % de ce qu'un stationnaire
consomme déjà. Choisi pour ce qu'il **ne** fait **pas** : il ne dépasse pas la
poussée disponible. Lâchez les manches, vous êtes ramené ; insistez plein gaz,
vous passez — et vous perdez la session. Ce n'est pas un mur, c'est le failsafe
du drone qui se bat contre vous.

**Le couloir est borné par carte.** 113 m sur `bastille` (demi-côté 164 m)
avaleraient 89 % de la carte. `Geofence` met donc les deux seuils à l'échelle
par le **même** facteur, pour que leur rapport — et donc le temps
d'avertissement, seule raison d'être de `R_CAUTION` — survive à la réduction :

```
halfMin = min((max.x − min.x)/2, (max.z − min.z)/2)
scale   = min(1, (halfMin / 3) / R_CAUTION)
```

Le cœur volable ne descend jamais sous 67 % du plus petit côté, et les cartes
assez grandes (`scale === 1`) gardent la valeur mesurée à l'identique : **12 des
17 entrées de `public/scenes.json`**, le seul inventaire de cartes que le dépôt
suive. Les manifestes eux-mêmes (`public/scenes/`) sont gitignorés, donc un
comptage « sur les N manifestes locaux » n'est pas reproductible d'une machine
à l'autre — sur celle où ces chiffres ont été mesurés (2026-08-31, 25 dossiers,
dont 8 hors `scenes.json`), c'était 16 sur 25. Le couloir réellement
appliqué se lit sur l'instance (`fence.effectiveCorridor`) et dans la console
au chargement (`[fence] couloir …`) — c'est lui qu'il faut montrer, pas la
constante. En dessous d'un couloir `HOLD` de 50 m (`HOLD_STOP_GUARANTEE_M`,
soit un demi-côté sous ~252 m), le pilote qui obéit franchit quand même le bord
sur les familles les plus lourdes ; `npm run add-map` le dit au moment où la
carte est ajoutée. Le mode de défaillance reste doux : la pénétration
n'atteint jamais `lost`, donc la session n'est pas perdue — on paie en image,
pas en session.

**Pourquoi le couloir vertical est sous `bbox.min.y`.** Le signe est ce qui
compte le plus. Posé au-dessus, il pousserait le drone vers le haut au point le
plus bas de la carte — la surface de la Seine sur `ile-de-la-cite`, où voler à
deux mètres de l'eau est un vol parfaitement normal. Ces quatre nombres (2 / 5
/ 8 / 10 m) ne sont pas mesurés et n'ont pas à l'être : ils reposent sur un
argument géométrique — deux mètres sous la surface la plus basse de la carte,
on est forcément sous quelque chose — et ils ne sont pas mis à l'échelle, parce
qu'une petite carte n'a pas un dessous plus mince qu'une grande.

**Pourquoi la clôture a son propre canal dans `link.js`.** La perte de zone
passe par `setTerminalLoss()` et **pas** par `_loss`. La borne de jouabilité de
l'issue #79 écrête `_loss` et replaque la qualité à un plancher volable après
deux secondes d'écran noir — elle existe pour qu'on ne reste jamais coincé
aveugle **en vol**. Or sortir de la zone n'est pas voler, c'est la fin de la
session : ce canal-là est appliqué en sortie, après la borne, et ne se relève
jamais. Le budget dépensé est exactement `LOSS_DEAD − LOSS_CLEAN` = 58 dB —
ce qui emmène n'importe quel lien, si propre soit-il, de parfait à mort —
dont 8 dB avant le bord, pendant l'avertissement (`KNIFE_EDGE_DB` : « you are
told you are running out of margin before you run out »).

Au-delà du bord, `src/ground.js` pose un plan sous le maillage. Sans lui la
falaise a du **ciel** dessous, et ce n'est pas un cas limite : en air clair la
portée est d'environ 2 km pour une carte de ±642 m. Ce n'est pas une extension
du monde, c'est une plaine sous la brume — même formule de brouillard que
`TileMaterial.js`, terme à terme, sinon l'horizon se dédouble.

### Régler le PID

```bash
npm run tune                          # rapport pour les six familles
npm run tune -- toothpick              # une seule famille
npm run tune -- --sweep roll race5     # balaye P/D sur un axe d'une famille
npm run tune -- --write <famille|all>  # sweep + mesure, réécrit le bloc pid
```

Le banc intègre les équations d'Euler avec le vrai tenseur d'inertie et le vrai
retard moteur, sans Rapier ni navigateur : une passe complète prend une
seconde. Ses seuils de réussite sont dérivés de l'accélération angulaire
soutenue que la cellule peut réellement produire, pas de constantes écrites à
la main — ni un preset rapide ni une famille lente ne peut donc « échouer »
juste parce qu'on lui demande plus qu'à une autre. `--write` est **le seul**
moyen de poser un bloc `pid` dans `drone-profiles.js` : on ne tape pas de gains
à la main.
