# FPVThePlanet! — architecture de la refonte DA / UX

Audit de l'état du code au 2026-08-29, écrit pour la **PHASE 0** de la roadmap
(`FPVThePlanet! — Roadmap d'implémentation DA - UX.md`), avant tout changement de
gameplay. Le but est double : dire ce que le simulateur fait aujourd'hui, et dire
où chaque brique atterrit dans la boucle décrite par l'*Art Direction & Experience
Bible*.

Ce document est une source de vérité au même titre que `README.md` (pipeline) et
`HANDOFF.md` (état vérifié / non vérifié). Il ne les duplique pas : il décrit la
**couche opérateur** que la refonte ajoute par-dessus.

---

## Sommaire

1. Décisions transverses
2. Le schéma cible
3. Inventaire de l'existant (chargement de scène · pipeline d'acquisition ·
   pile de vol · météo/optique/lien · interface · crash et respawn · stockage)
4. Ce que le navigateur sait réellement (mesurable · doit rester `UNKNOWN` · stockage)
5. Ce qui change vraiment
6. Contraintes qui survivent à la refonte
7. Où sont les choses

---

## 1. Décisions transverses

Arrêtées le 2026-08-29 avec l'auteur du projet. Elles conditionnent toutes les
phases et ne doivent pas être re-tranchées issue par issue.

| # | Décision | Conséquence |
|---|---|---|
| D1 | **`npm run dev` *est* le jeu.** FPVTP! est une installation locale. | Le Global Scanner absorbe `add-map.html` ; l'acquisition lance le vrai pipeline Go/Node. Pas de build de production jouable en V1. |
| D2 | **L'état opérateur vit côté serveur**, en JSON sur disque, via une extension de `tools/map-api-plugin.mjs`. | Un seul endroit cohérent avec le terrain, survit à un vidage de cache navigateur, et rend la PHASE 23 (multi-opérateur) presque gratuite. |
| D3 | **La météo vient d'une vraie API** (Open-Meteo, sans clé), snapshotée par zone et par jour dans le world state. | Deux acquisitions rapprochées voient le même temps ; le lendemain peut différer. Repli hors ligne sur le dernier snapshot, puis sur une génération déterministe seedée. |
| D4 | **Les six familles de drones sont implémentées d'emblée**, PID re-mesurés par famille via `tools/tune-pid.mjs`. | `QUAD` devient un profil. `selftest` doit passer sur les six. |
| D5 | **Le jeu est en anglais** ; les issues, commits et docs internes restent en français. | Toute chaîne visible par le joueur est à traduire, y compris le HUD et les écrans de chargement actuels. |
| D6 | **Aucun élément de DA ne devient une dépendance du moteur physique.** | `quad.js`, `flightController.js`, `physics.js`, `wind.js`, `rain.js`, `fog.js`, `link.js` restent testables sans navigateur. |
| D7 | **Un mode de jeu ne se donne jamais son propre chemin de boot.** Il traverse ceux qui existent, avec un drapeau. | Ajoutée après PHASE 26. Voir ci-dessous. |

### D7 — pourquoi, en détail

`bootLive()` (`main.js`) a recopié à la main la fin de `finishBoot()` pour se
donner un second chemin de démarrage. Il a fallu trois correctifs pour rattraper
ce qu'il avait oublié de recopier — `settings.flightActive`, `lastTime`,
`exposeDebugGlobal()` (#168, #170) — et chacun de ces oublis était invisible
jusqu'à ce qu'on tombe dessus en vol.

La leçon est générale : deux chemins de boot qui doivent rester d'accord ne le
restent pas. Un mode ajoute donc **un drapeau traversé**, jamais un pipeline
parallèle.

PHASE 26 l'applique : sur terrain caché, le banc rend exactement la forme que
rendent déjà le `resume` et l'override `?family=`, et c'est la chaîne existante
qui construit `PROFILE` et le contrôleur. Même chose pour `FENCE OFF`, qui
construit une clôture immense (motif déjà employé par `?live=`) plutôt qu'une
branche dans `frame()` : tout ce qui lit `fence.out` continue de fonctionner sans
rien savoir du banc.

Corollaire pratique : quand un mode a besoin d'une variante d'un système
existant, on **scinde ce système** plutôt que de le dupliquer. `toSimParams()`
est devenu `sanitize()` + `simParamsOf()` pour que le banc partage la traduction
météo du monde sans hériter de ses règles de cohérence — une seule traduction,
donc un banc à 12 m/s et un monde à 12 m/s se pilotent identiquement.

---

## 2. Le schéma cible

```text
CURRENT SYSTEM          ce qui existe et vole aujourd'hui
      ↓
NEW OPERATOR LAYER      identité, control vector, réglages           [PHASE 1-2]
      ↓
WORLD STATE             météo 7 jours par zone, densité de signal    [PHASE 3-4]
      ↓
AREA CACHE              terrain acquis, conservé ou supprimé         [PHASE 5]
      ↓
TARGET GENERATION       drones éphémères, six familles, hack type    [PHASE 7-9]
      ↓
SESSION                 cible + météo + télémétrie + verdict         [PHASE 6]
      ↓
FLIGHT                  entry state → vol → LANDED | CRASHED         [PHASE 11-15]
```

La règle qui tient l'ensemble :

> **The world persists. The machine doesn't.**

Le terrain est lourd, cher et conservé. Le drone est gratuit, tiré à chaque
acquisition, et perdu au crash.

---

## 3. Inventaire de l'existant

### 3.1 Chargement de scène

| Fichier | Rôle | Verdict |
|---|---|---|
| `public/scenes.json` | liste des cartes préparées ; schéma additif (`slug`, `name`, `lat`, `lon`, puis `bbox`/`radius`, `zoom`, `altitude`, `cell`, `quality`, `bytes`, `createdAt`) | **adapté** — devient l'index du cache terrain, lu par le Global Scanner |
| `src/loader.js` | `setScene(slug)` puis `loadManifest()` / `loadChunks()` / `loadCollision()` ; `setFog()` pousse la densité sur tous les matériaux | **conservé tel quel** |
| `src/worker.js` | parse la géométrie binaire `FPVG` et déballe les planches de textures en `DataArrayTexture` | **conservé tel quel** |
| `src/TileMaterial.js` | un matériau par chunk, `sampler2DArray`, brouillard exp² | **conservé tel quel** |

L'ordre `setScene()` **avant** tout `load*()` reste une contrainte dure.

Sur disque aujourd'hui : 10 zones, ~4,7 Go, de 30 Mo (`triomphe`) à 964 Mo
(`ile-de-la-cite-et-ile-saint-louis`). C'est l'ordre de grandeur que le
`LOCAL TERRAIN CACHE` doit afficher et gérer.

### 3.2 Pipeline d'acquisition

```text
lat,lon  →  cmd/export-obj (Go)  →  OBJ/MTL/JPEG  →  tools/prep.mjs
         →  public/scenes/<slug>/  →  scenes.json
```

| Fichier | Rôle | Verdict |
|---|---|---|
| `tools/lib/add-map-core.mjs` | `planScan()`, `probeCoverage()`, `addMap()`, `slugify()`, `readScenes()`/`writeScenes()`, `dirSize()` | **conservé** — c'est le moteur de `ACQUIRE AREA` |
| `tools/lib/estimates.mjs` | `tileGrid()`, `boxDimensions()`, `tileSizeMeters()`, `estimateCost()` | **conservé** — alimente `AREA ANALYSIS` (tuiles, requêtes, surface, données) |
| `tools/map-api-plugin.mjs` | API de dev sur le connect de Vite : `/describe`, `/plan`, `/probe`, `/jobs` + SSE, `/scenes` | **étendu** — accueille les routes `/__operator` (D2) |
| `tools/map-gui/main.js` + `add-map.html` | Leaflet + Geoman, recherche, rectangle, estimations, sonde, logs live | **absorbé** par le Global Scanner (PHASE 3/5) |
| `tools/prep.mjs` | ECEF→ENU, chunking, planches de textures, collision `FPVC`, `manifest.json` v2 | **conservé, à ne pas re-dériver** |

**Constat important pour la PHASE 5.** Le pipeline n'émet aujourd'hui que **deux**
phases réelles : `download` et `prep` (`onLog({stream:'phase'})` dans `addMap()`),
plus un compteur de tuiles trouvées (`stream:'progress'`). L'écran de la Bible en
montre six (`TERRAIN`, `FETCH`, `DECODE`, `REBUILD`, `RF ANALYSIS`,
`TARGET SEARCH`). Deux options, à trancher dans l'issue :

1. instrumenter `prep.mjs` pour émettre de vraies sous-phases (décodage, chunking,
   textures, collision) — plus de travail, mais les barres disent la vérité ;
2. n'afficher comme progression réelle que ce qui est mesuré, et assumer
   `RF ANALYSIS` / `TARGET SEARCH` comme des indicateurs diégétiques explicitement
   décoratifs.

La règle « utiliser autant que possible les vrais états et métriques du pipeline »
penche vers (1) pour les quatre premières barres.

### 3.3 Pile de vol — la partie à ne pas casser

```text
input.js → flightController.js → quad.js → physics.js/Rapier
```

| Fichier | Rôle | Verdict |
|---|---|---|
| `src/input.js` | sticks normalisés, mapping manette auto (EdgeTX / Xbox) + override utilisateur en localStorage | **conservé** ; la saisie du Control Vector s'y greffe |
| `src/flightController.js` | contrôleur de forme Betaflight, `RATE_PRESETS` cinematic/freestyle/race, `update() -> {motors[4]}` | **conservé**, gains re-mesurés par famille (D4) |
| `src/quad.js` | modèle physique 5" freestyle : moteurs, hélices, inflow, drag, batterie | **paramétré** — `QUAD` devient un profil (PHASE 7) |
| `src/physics.js` | Rapier, trimesh pleine résolution, CCD, `groundBelow()`, `obstructionBetween()` | **conservé** ; l'entry state réutilise ses raycasts |
| `tools/tune-pid.mjs` | mesure les gains sur le modèle | **étendu** à N profils |
| `tools/selftest.mjs` | ~40 vérifications headless (géométrie, vol, link, vent) | **généralisé** aux six familles |

L'interface « quatre sorties moteur » est volontairement étroite, pour un
remplacement futur par du SITL. La refonte DA ne doit pas l'élargir.

### 3.4 Météo, optique et lien — déjà là, à re-câbler

Ces quatre modèles sont purs (pas de THREE, pas de DOM, pas de Rapier) et
testables headless. **Ils ne sont pas réimplémentés : le world state écrit leurs
paramètres au lieu des sliders.**

Pour la météo c'est fait (PHASE 4). L'unique point de contact est
`toSimParams()` dans `tools/lib/weather.mjs` : un bulletin (m/s, mm/h, mètres de
visibilité) y devient les entrées de `wind.js` / `rain.js` / `fog.js`, en
important leurs propres constantes (`MAX_RATE`, `rainVisibility`,
`intensityForRange`) plutôt qu'en recopiant leurs relations. `src/weather.js`
pose le résultat, `tools/weather-source.mjs` interroge Open-Meteo et snapshote
par zone et par jour dans `worldState.weather`.

| Fichier | Ce qu'il modélise | Piloté aujourd'hui par | Demain |
|---|---|---|---|
| `src/wind.js` | moyenne, wander, rafales, turbulence, couche limite, abri, canalisation | ~~slider `Météo — vent`~~ → snapshot météo de la zone **(fait, PHASE 4)** | — |
| `src/rain.js` | mm/h, taille de goutte, visibilité, eau sur la lentille, dérive des billes | ~~slider `Météo — pluie`~~ → snapshot météo **(fait, PHASE 4)** | — |
| `src/rainfall.js` | les stries visibles, dans la scène (donc dans le pipeline lentille) | — | idem |
| `src/fog.js` | portée visuelle, voile, couleur de l'air | ~~slider `Météo — brouillard`~~ → snapshot météo **(fait, PHASE 4)** | — |
| `src/link.js` | bilan de liaison 5,8 GHz en dB, RSSI, qualité | slider `Lien vidéo` | qualité du link de la cible (PHASE 7/8) |
| `src/lens.js` | barillet, aberration, vignettage, flou de rotation, dégradation analogique/numérique | sliders `Objectif` | propriétés caméra de la cible |

`src/lens.js` est déjà **le pipeline de composition** décrit par la Bible §43. Il
faut y insérer deux couches (`DRONE OSD` avant la dégradation, `FPVTP OSD` après)
plutôt que d'en construire un second.

### 3.5 Interface actuelle

| Élément | Où | Verdict |
|---|---|---|
| Menu « Choisir une carte » | `Hud.showMenu()` dans `src/hud.js` | **remplacé** par l'Operator Terminal (PHASE 2) |
| Écran de chargement (étapes + horloge) | `src/hud.js` + `stage()` dans `src/main.js` | **conservé** dans l'esprit — il doit passer **derrière** le TARGET SCAN (PHASE 13) |
| HUD de vol (alt, spd, mode, batterie, RSSI, vent) | `src/hud.js` | **scindé** en OSD drone / OSD FPVTP! (PHASE 12) |
| Panneau de réglages (Tab) | `src/settings.js` (scindé en PHASE 2) | **réduit** : les six blocs météo ont disparu (PHASE 4) ; restent manette, caméra, objectif, lien vidéo, son. Le bloc lien reste à sortir |
| `?scene=<slug>` | `src/main.js` (`OPTS.scene`) | **conservé** comme raccourci de dev |
| `window.__sim` | `src/main.js` | **conservé et étendu** — c'est ce qui rend le jeu auditable depuis la console |

`src/hud.js` fait 736 lignes et mélange menu, chargement, HUD de vol et réglages.
C'est le premier fichier à découper (PHASE 2), avant d'y ajouter quoi que ce soit.

### 3.6 Crash et respawn — le changement de sens

Aujourd'hui : `CRASH_IMPULSE = 1500 N` (mesuré : atterrissage doux ~290 N,
25 m/s dans un mur ~2450 N) lève un drapeau `crashed`, et **`R` fait repartir**.

Demain : le seuil est réutilisé tel quel, mais un crash **perd la machine**.
`R` disparaît du vol. La touche de respawn n'a plus de sens dans une fiction où le
drone appartient à quelqu'un d'autre et se trouve à Tokyo.

### 3.7 Stockage actuel

Deux endroits, aucun modèle :

- **localStorage**, clés `fpvmaps.*` : `gamepadMap`, `audioVolume`, `audioBrightness`,
  `lens*`, `link*`, `wind*`, `rain*`, `fog*`. Le bouton « Réinitialiser » balaie
  tout ce qui commence par `fpvmaps.`.
- **disque**, `public/scenes/` + `public/scenes.json`, écrits par le pipeline.

La refonte ajoute un troisième : l'**état opérateur côté serveur** (D2). Les clés
`fpvmaps.*` qui relèvent vraiment du joueur (manette, audio, accessibilité)
migrent dedans ; celles qui relevaient du monde (météo, link) disparaissent.

---

## 4. Ce que le navigateur sait réellement

Le bootstrapping (Bible §13) doit produire un léger malaise — « pourquoi ce
logiciel sait ça ? » — **sans jamais simuler comme réelle une information
inaccessible**. Inventaire honnête :

### Réellement mesurable

| Champ | Source |
|---|---|
| `PLATFORM`, `BROWSER` | `navigator.userAgentData` / `userAgent` |
| `LANGUAGE` | `navigator.language` |
| `TIMEZONE` | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `DISPLAY` | `screen.width/height`, `devicePixelRatio` |
| taux de rafraîchissement | mesuré sur quelques dizaines de `requestAnimationFrame` |
| `RENDERER` | contexte `webgl2` obtenu ou non |
| `GPU` | `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL` |
| cœurs logiques | `navigator.hardwareConcurrency` |
| `INPUT` | `navigator.getGamepads()` : `id` et nombre d'axes |
| fréquence audio | `AudioContext.sampleRate` |
| `NETWORK` | `navigator.onLine` |
| `TERRAIN CACHE` | l'API serveur, qui connaît le vrai contenu de `public/scenes/` |
| quota de stockage | `navigator.storage.estimate()` |

### Doit rester `UNKNOWN`

| Champ | Pourquoi |
|---|---|
| `AUDIO ... HEADPHONES` | le navigateur ne sait pas ce qui est branché. **L'exemple de la Bible §13 n'est pas implémentable tel quel** : afficher `HEADPHONES` serait un mensonge. `AUDIO ... 48000 Hz / 2 CH` est vrai et tout aussi inquiétant. |
| RAM physique | `navigator.deviceMemory` est arrondi grossièrement et absent de Firefox/Safari |
| VRAM | non exposée |
| modèle de CPU, nom de machine, utilisateur OS | non exposés |
| position géographique | demande un consentement explicite — hors sujet |
| `GPU` sous Firefox avec `privacy.resistFingerprinting` | l'extension peut être masquée |

Ces cases vides sont un **atout** : `UNKNOWN` est exactement le vocabulaire du
`TARGET SCAN` (§15). Le bootstrapping et la fiche cible parlent la même langue.

### Limites de stockage

- `localStorage` : ~5-10 Mo, synchrone, effacé avec les données du site.
- IndexedDB : centaines de Mo à quelques Go, mais soumis à éviction.
- **C'est une des raisons de D2** : l'état opérateur sur disque n'a aucune de ces
  limites, et les photos (PHASE 16) non plus.

---

## 5. Ce qui change vraiment

Résumé exécutif pour qui reprend le chantier :

**Conservé sans y toucher** — `prep.mjs`, `loader.js`, `worker.js`,
`TileMaterial.js`, `physics.js`, `flightController.js`, `audio.js`, `wind.js`,
`rain.js`, `rainfall.js`, `fog.js`, `link.js`, le cœur de `lens.js`.

**Adapté** — `quad.js` (profil paramétrable), `input.js` (Control Vector),
`map-api-plugin.mjs` (routes opérateur), `map-gui/` (devient le Global Scanner),
`main.js` (la boucle de boot passe derrière la sélection de cible).

**Remplacé** — `hud.js` : éclaté en Operator Terminal, écrans de session, OSD
drone et OSD FPVTP!.

**Supprimé** — les sliders météo/link des réglages, le menu de sélection de carte,
le respawn en vol.

**Nouveau** — couche opérateur, world state, cache terrain par opérateur, modèle
de session, génération de cibles, types de hack, rituels, entry state, Randomart,
photos, journaux, RTC.

---

## 6. Contraintes qui survivent à la refonte

Rappel, parce que ce sont exactement les choses qu'une refonte d'interface casse
par distraction :

- Coordonnées locales ENU en mètres après `prep` : **X = est, Y = haut, Z = sud**.
- Collider du drone : sphère de **0,15 m**. `camera.near` vaut **exactement 0,15**.
- Amortissements linéaire et angulaire de Rapier à **zéro** : la traînée est
  calculée par `quad.js`.
- `resetForces()` / `resetTorques()` à **chaque** pas.
- L'axe V des UV est retourné dans `prep.mjs` — voir `README.md` avant de
  diagnostiquer une texture grise.
- Le pipeline couleur est **pass-through** de bout en bout
  (`THREE.ColorManagement.enabled = false`, sortie linéaire) : toute conversion
  ajoutée ici ramène le bug n°10 du `HANDOFF`.
- Les PID sont **mesurés**, pas choisis. `npm run tune`.
- Ne jamais lire `sim/public/scenes/` avec un outil de lecture de fichier.

---

## 7. Où sont les choses

- **Direction artistique** : `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md`
- **Roadmap** : `sim/docs/FPVThePlanet! — Roadmap d'implémentation DA - UX.md`
- **Ce document** : la traduction de l'une dans l'autre, côté code.
- **Suivi** : issues `PHASE 00` → `PHASE 25` sur le Project 2, label `roadmap-da`,
  milestones `P0` → `P3`.
