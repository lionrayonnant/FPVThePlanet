# PHASE 07 — Génération des cibles (couche physique)

État : validé 2026-08-29. Périmètre de cette session = **couche physique
uniquement**. La génération de variation individuelle par cible et le câblage au
modèle de session (PHASE 06, en cours en parallèle) sont explicitement hors
périmètre — cette spec en pose le socle.

Issue : https://github.com/lionrayonnant/FPVMaps/issues/44

## Objectif

Transformer `QUAD` — aujourd'hui une constante de module figée décrivant un seul
5" freestyle — en un **profil paramétrable**, et livrer **6 familles**
d'appareils avec masses / inerties / hélices propres et **PID re-mesurés par
famille**. `npm run selftest` doit rester vert pour les 6.

## Familles — le tinywhoop, tenté puis retiré

La demande initiale était de scinder `MICRO` en tinywhoop 1S **et** toothpick
2.5". Le tinywhoop (`microwhoop`, ~34 g) a été prototypé mais **retiré** : à
cette masse les termes de couplage roll/pitch/yaw du modèle de vol
(`quad.js` + intégration Rapier), négligeables sur un 5" de 650 g, ne sont pas
calibrés — le tinywhoop ne tient pas un taux commandé (roll à +40 %, ~380 °/s de
lacet induit en tonneau). Le banc `tune-pid` le voyait propre ; le vrai sim non.
Calibrer les coefficients de couplage à l'échelle micro est un travail à part →
**issue de suivi**. `MICRO` = le `toothpick` 2.5".

Familles (6) : `freestyle5` (référence, inchangée), `race5`, `cinewhoop`,
`longrange`, `heavy5`, `toothpick` (label `MICRO`).

## Architecture

### D1 — `src/drone-profiles.js` (nouveau) : la donnée, pure

Aucune logique. Pour chaque famille, un objet profil :

- **physique** : `mass`, `radius` (= 0.15 pour toutes, cf. contrainte collider),
  `inertia {x,y,z}` (x=pitch, y=yaw, z=roll), `armX`, `armZ`, `propRadius`,
  `propInertia`, `bladeCount`, `maxThrustPerMotor`, `maxOmega`, `rpmCurve`,
  `tauSpinUp`, `tauSpinDown`, `torqueRatio`, `kAxial`, `kLateral`,
  `bodyDrag {x,y,z}`, `battery {cells, capacityMah, internalOhm, maxCurrent}`.
- **`rates`** : clé d'un preset de `RATE_PRESETS`.
- **`pid`** : `{ roll:{p,d}, pitch:{p,d}, yaw:{p,d}, torquePerMix:{roll,pitch,yaw} }`
  — **écrit par `tune-pid.mjs --write`, jamais édité à la main** (rappel
  CLAUDE.md). Le feedforward `F` reste *dérivé* à la construction :
  `F_axe = I_axe / torquePerMix[axe]`. `i` reste lié à `p` par `I_TIME`.

Chaque famille porte un commentaire « setup réel de référence » du même genre
que le bloc actuel de `quad.js` (moteur/KV/cellules/hélice/masse d'où viennent
les chiffres).

Exports : `PROFILES` (map), `FAMILIES` (clés ordonnées), `DEFAULT_FAMILY =
'freestyle5'`, `DEFAULT_PROFILE = PROFILES.freestyle5`.

**`freestyle5` reproduit les valeurs actuelles de `quad.js` au bit près.** Le
comportement de `freestyle5` après refactor doit être identique — vérifié en
comparant les `detail` numériques de `selftest` avant/après.

### D2 — `src/quad.js` : profil en argument

- `QUAD` reste exporté, `= DEFAULT_PROFILE` (rétro-compat des lecteurs de valeurs
  par défaut : `main.js`, `audio.js`, ré-export `physics.js`).
- `MOTORS`, `MIX`, `kThrust` ne sont plus des constantes de module : helpers
  `motorsOf(profile)`, `mixOf(profile)`, `kThrustOf(profile)`. `MIX` reste
  **dérivé de la géométrie moteur**, jamais écrit à la main. Exports de
  compat `MOTORS = motorsOf(QUAD)`, `MIX = mixOf(QUAD)` conservés pour les
  lecteurs par défaut (`audio.js`).
- `Propulsion` : `new Propulsion({ profile = QUAD, seed = 0x5eed } = {})`.
  `this.profile`, `this._motors`, `this._mix`, `this._kThrust` en état
  d'instance ; toutes les références `QUAD.*` de `step()` deviennent
  `this.profile.*`. 3 sites d'appel adaptés : `physics.js`, `tools/tune-pid.mjs`,
  `tools/selftest.mjs`.
- `Battery` : `new Battery(profile.battery)`.
- `HOVER_THRUST` reste (= défaut) ; ajout `hoverThrust(profile)`.
- **Hors périmètre** : effet de sol (`0.18` / `0.22`) et propwash restent des
  constantes globales. Noté comme dette dans `quad.js`.

### D3 — `src/flightController.js` : PID par famille

- `new FlightController({ profile = DEFAULT_PROFILE, preset } = {})`. `preset`
  par défaut = `profile.rates`. `RATE_PRESETS` reste global et cyclable au
  clavier (`P`) — un profil ne fait que fixer le preset de départ.
- `PID` et `TORQUE_PER_MIX` figés supprimés : lus depuis `this.profile.pid`.
  `AxisPid` reçoit `{p, i: p/I_TIME, d, f}` calculés depuis le profil.
  `hoverThrottle()` prend le profil.
- `setGains` opère sur l'instance (utilisé par le sweep de `tune-pid`).
- 2 presets de rates ajoutés à `RATE_PRESETS` : `longrange` (~380 °/s, expo
  douce), `micro` (~650 °/s). Mapping famille→preset : `freestyle5→freestyle`,
  `race5→race`, `cinewhoop→cinematic`, `longrange→longrange`,
  `heavy5→cinematic`, `microwhoop→micro`, `toothpick→freestyle`.
  **Pas de randomisation de rates par cible** (bullet différée).

### D4 — consommateurs

- `physics.js` : `new Physics(collision, spawn, { ..., profile })`. Les
  `setAdditionalMassProperties` et `ColliderDesc.ball` prennent
  `profile.mass` / `profile.inertia` ; `radius` reste `0.15` en dur (jamais du
  profil, cf. `camera.near`). Propage le profil à `Propulsion` et au
  `FlightController` s'il en construit un. `MAX_THRUST`, `DRONE` : ré-exports
  de compat sur le défaut, plus helper `maxThrust(profile)`.
- `audio.js` : reçoit les moteurs / `bladeCount` / `maxThrustPerMotor` de
  l'instance `propulsion` au lieu des constantes de module.
- `main.js` : `QUAD.mass` de `dropDrift` → masse du profil actif.

### D5 — `tools/tune-pid.mjs` : mesure par famille

- `node tools/tune-pid.mjs [famille]` — rapport (défaut : toutes les familles).
- **`node tools/tune-pid.mjs --write <famille|all>`** : pour chaque axe de la
  famille, balaie P/D contre l'inertie / retard moteur / preset de rates **de
  cette famille**, retient le coût mini (fonction de coût actuelle), mesure
  `torquePerMix` (pente couple/unité-mixeur près du hover, même technique que
  `sustainedAccel`), et **réécrit le bloc `pid` de la famille dans
  `drone-profiles.js`** (remplacement de bloc délimité, valeurs formatées).
- `run()` / `metrics()` / `sustainedAccel()` / `limitsFor()` prennent un profil.
  Les seuils rise/settle sont déjà dérivés de `sustainedAccel` — marchent tels
  quels par profil.
- npm : `tune` inchangé (rapport). `--write` invoqué à la main, pas de script.
- **`filterScale`** (champ profil optionnel, défaut 1) : multiplie les fréquences
  de coupure des filtres roll/pitch (gyro, D, FF, lissage RC) pour un airframe
  bien plus rapide que le 5" — le `toothpick` tourne à 2.0×, comme un vrai build
  micro. **Le yaw garde la chaîne de référence** (boucle limitée par le temps
  moteur, l'ouvrir la fait osciller).
- **Bug du banc corrigé** : `run()` passait l'attitude intégrée au contrôleur
  alors que le repère du banc EST le repère corps et `w` est déjà en corps — le
  contrôleur dé-rotait un taux corps par un grand angle et poursuivait
  l'oscillation fantôme. Bénin pour le 5", divergent pour une boucle micro.
  Le banc passe maintenant `rotation: IDENTITY`.
- Sweep en **2 passes** (les boucles inter-axes se couplent), garde de qualité
  sur overshoot/settle/rise dans la sélection, préférence P bas à coût égal.

### D6 — `tools/selftest.mjs` : les 6 familles

- Les checks **de vol** passent dans `for (const family of FAMILIES)`, préfixés
  par le nom de famille, seuils **dérivés du profil** :
  - pose au sol à gaz zéro ; tenue d'altitude au hover ; montée plein gaz ;
  - taux de roulis atteint = `RATE_PRESETS[profile.rates].roll.max` ;
  - position manche hover = `((mg)/(4·maxThrustPerMotor))^(1/(2·rpmCurve))`,
    vérifiée dans une bande plausible par famille ;
  - airmode garde l'autorité roulis à gaz zéro ;
  - lacet monte moins vite que le tangage ;
  - vitesse terminale à plat ≈ `√(mg / (½·ρ·bodyDrag.y))` à ±40 % ;
  - la batterie sag sous charge et se décharge.
- Les checks **liés à la scène** (taille tuile, tour, rayons sol, CCD, crash,
  lien vidéo, météo) restent uniques, sur `freestyle5`.
- `npm run selftest` doit finir vert pour les 7 familles.

## Familles — chiffres

> Table de **proposition initiale**. Les valeurs réellement livrées ont bougé
> pendant l'implémentation (échelle des `kAxial`/`kLateral` sur l'aire du disque,
> inerties micro quasi-symétriques pitch/roll, poussées ajustées, `microwhoop`
> retiré). **`src/drone-profiles.js` fait foi** — chaque famille y est
> documentée par un commentaire « setup réel ».

Toutes : `radius = 0.15`. Inertie `{x:pitch, y:yaw, z:roll}`.

| param | freestyle5 (réf.) | race5 | cinewhoop | longrange | heavy5 | microwhoop | toothpick |
|---|---|---|---|---|---|---|---|
| setup | 2207/2450KV 4S, 5×4.3×3 | 2207/2650KV 6S, 5×4.9×3 | 1404/3800KV 4S, 3" tri caréné, GoPro | 2806.5/1300KV 6S, 7×4×3 | 2207/1960KV 6S, 5×4.3×3 + GoPro | 0802/22000KV 1S, 40 mm tri caréné | 1102/11000KV 2S, 2.5" bi |
| mass (kg) | 0.65 | 0.55 | 0.60 | 0.92 | 0.85 | 0.032 | 0.075 |
| inertia x (pitch) | 0.0032 | 0.0027 | 0.0022 | 0.0078 | 0.0050 | 8.0e-6 | 2.6e-5 |
| inertia y (yaw) | 0.0058 | 0.0049 | 0.0040 | 0.0140 | 0.0090 | 1.4e-5 | 4.6e-5 |
| inertia z (roll) | 0.0030 | 0.0025 | 0.0021 | 0.0072 | 0.0047 | 7.5e-6 | 2.4e-5 |
| armX = armZ (m) | 0.078 | 0.074 | 0.060 | 0.105 | 0.080 | 0.026 | 0.038 |
| propRadius (m) | 0.0635 | 0.0635 | 0.0381 | 0.0889 | 0.0635 | 0.0200 | 0.0318 |
| propInertia (kg·m²) | 4.0e-6 | 3.6e-6 | 1.8e-6 | 1.1e-5 | 4.0e-6 | 2.0e-8 | 2.0e-7 |
| bladeCount | 3 | 3 | 3 | 3 | 3 | 3 | 2 |
| maxThrustPerMotor (N) | 10.0 | 12.5 | 4.1 | 9.5 | 10.5 | 0.16 | 0.72 |
| maxOmega (rad/s) | 3140 | 3560 | 4200 | 2450 | 3000 | 5200 | 4600 |
| rpmCurve | 0.65 | 0.65 | 0.62 | 0.66 | 0.65 | 0.60 | 0.62 |
| tauSpinUp (s) | 0.022 | 0.020 | 0.026 | 0.032 | 0.024 | 0.008 | 0.010 |
| tauSpinDown (s) | 0.045 | 0.042 | 0.052 | 0.068 | 0.048 | 0.020 | 0.024 |
| torqueRatio (m) | 0.019 | 0.018 | 0.024 | 0.021 | 0.019 | 0.020 | 0.018 |
| kAxial | 3.0e-5 | 3.0e-5 | 4.5e-5 | 5.5e-5 | 3.2e-5 | 3.5e-5 | 3.0e-5 |
| kLateral | 5.0e-5 | 4.6e-5 | 1.0e-4 | 8.0e-5 | 5.2e-5 | 6.0e-5 | 4.4e-5 |
| bodyDrag x/z | 0.010 | 0.009 | 0.030 | 0.012 | 0.011 | 0.0006 | 0.0018 |
| bodyDrag y | 0.028 | 0.025 | 0.045 | 0.040 | 0.032 | 0.0011 | 0.0050 |
| battery cells | 4 | 6 | 4 | 6 | 6 | 1 | 2 |
| battery capacityMah | 1300 | 1300 | 1100 | 3000 | 1300 | 300 | 300 |
| battery internalOhm | 0.010 | 0.012 | 0.014 | 0.010 | 0.011 | 0.080 | 0.050 |
| battery maxCurrent (A) | 100 | 115 | 70 | 90 | 100 | 8 | 15 |

TWR statique visé (`4·Fmax/mg`) : freestyle5 6.3 · race5 9.3 · cinewhoop 2.8 ·
longrange 4.2 · heavy5 5.0 · microwhoop 2.0 · toothpick 3.9.

> Ces valeurs sont des points de départ physiquement plausibles, pas des
> mesures de banc. Les PID les prennent comme plant et sont mesurés dessus. Si
> une famille sort des cibles `tune-pid` de façon irrécupérable, c'est le profil
> qu'on ajuste, pas le PID à la main.

## Plan d'implémentation

1. **`drone-profiles.js`** avec les 7 profils ; `pid` initialisé en copiant le
   tune `freestyle5` actuel pour les 3 axes (placeholder, re-mesuré à l'étape 5).
2. **`quad.js`** : helpers `motorsOf/mixOf/kThrustOf/hoverThrust`, `Propulsion`
   et `Battery` paramétrés, exports de compat. `npm run selftest` doit rester
   identique (profil défaut).
3. **`flightController.js`** : PID depuis le profil, presets `longrange`/`micro`,
   `FlightController({profile,preset})`. Vérifier `freestyle5` inchangé.
4. **`physics.js` / `audio.js` / `main.js`** : propagation du profil.
5. **`tune-pid.mjs`** : profil en argument, `--write <famille|all>`. Lancer
   `--write all`, commiter les `pid` mesurés.
6. **`selftest.mjs`** : boucle 7 familles, seuils dérivés. Itérer profils/rates
   jusqu'à vert partout.
7. Mettre à jour `issue #44` (écart 6→7), `HANDOFF.md`, `README.md` (section
   modèle de vol / familles), `docs/handoff-archive/modele-de-vol.md`.

## État final d'implémentation (2026-08-29)

- 6 familles dans `src/drone-profiles.js`. `freestyle5` = valeurs `quad.js`
  d'origine au bit près, comportement `selftest` identique (hover 24 %, roll
  822 °/s, vitesse terminale 15,4 m/s).
- `npm run selftest` : **155/155 vert**, incluant la boucle enveloppe de vol /
  propulsion sur les 6 familles.
- `node tools/tune-pid.mjs` : 34/36 combos axe·famille dans les cibles strictes
  du banc. Restent **longrange roll & pitch** à rise 74 ms vs limite 68-71 ms
  (~9 % ; preset cruiseur calme à 360 °/s, imperceptible). PID des 5 familles
  non-référence tous mesurés par `--write` et commités.
- `microwhoop` (tinywhoop 1S) **retiré** — cf. section « Familles » plus haut.

## Hors périmètre (suites)

- **Tinywhoop / échelle micro** : calibrer les termes de couplage
  roll/pitch/yaw du modèle de vol pour une masse ~30-40 g, puis réintroduire
  `microwhoop`. → issue de suivi.
- Variation individuelle par cible (rates, caméra, FOV, vidéo, batterie, masse,
  qualité link) + vérification des plages de stabilité — dépend de PHASE 06.
- Critère « deux 5" Race tirés au hasard = deux expériences distinctes » : le
  socle (profil clonable + plages vérifiables) est ici ; le tirage est en aval.
- Effet de sol / propwash paramétrables par famille (caréné ≠ ouvert).
- `longrange` rise : élargir la grille P du banc ou revoir l'autorité du profil
  si le ressenti le demande.
