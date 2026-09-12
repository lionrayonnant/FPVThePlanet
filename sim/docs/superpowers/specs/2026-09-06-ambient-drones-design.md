# Drones ambiants : les candidats non pris du scan volent autour du joueur

Issue #250. Écrit le 2026-09-06.

## Ce que c'est

Le scan tire de deux à cinq candidats, le joueur en prend un. Les autres
existent dans la fiction et n'existent pas dans le ciel. Cette spec les y met :
pendant une session FIELD, les candidats non pris volent autour du joueur,
chacun selon une routine propre à sa famille, rendus comme de vrais quads
low-poly construits depuis leur build, avec une LED qui bat et une voix moteur
au loin.

Ce que ça apporte, dans l'ordre : le ciel est vivant ; le joueur apprend de
l'**extérieur** comment vole chaque famille (le race se couche à 60° en virage,
le cinewhoop tourne à plat autour de son sujet, le long range croise haut et
droit, le micro traîne au ras du sol) ; et la session suivante a une
continuité (« j'ai vu un heavy faire des huit sur le toit, la prochaine fois
c'est lui »).

Ce que ce n'est **pas** :

- pas des objets physiques : cinématique pure, pas de corps Rapier, pas de
  collision entre drones ni avec le joueur ;
- pas des cibles : aucune interaction, on peut les suivre et c'est tout ;
- pas des batteries : ils volent toute la session (décision du 2026-09-06) ;
- pas ancrés : ils vivent dans une **bulle** qui suit le joueur (idem) ;
- jamais au banc : `NO TARGET` — il n'y a personne au bout.

Le maillage est conçu pour servir ensuite au drone du joueur (hélices dans le
champ, épave visible, vue extérieure au banc) : une fonction qui prend une
famille et un build et rend un groupe Three.js, sans rien savoir de qui le
pilote. Ces usages ne sont pas dans cette version.

## Contraintes du dépôt, vérifiées avant d'écrire

1. **Les candidats non pris sont régénérables en session, pas au resume.**
   `flyTarget` ne garde que `{ seed, count, index }` (`src/main.js:439`, assigné
   `:2491` et `:2404`) ; `generateTargetScan({ seed, count })` est pur et
   déterministe (`tools/target-model.mjs:62-84`), donc tous les `i !== index`
   se retrouvent à l'identique. Au resume, `flyTarget` est `null`
   (`src/main.js:2658`) et la session persistée ne contient ni `seed`, ni
   `count`, ni `index` : `sanitizeTarget()` (`tools/session-model.mjs:66-86`)
   ne garde que `family, classHint, hackType, signal, scannedAt, intel` et
   **jette `buildSeed`**. Conséquence déjà présente et non liée à cette spec :
   les lectures `prev?.target?.buildSeed` (`src/main.js:2440`) et
   `tgt?.buildSeed` (`:2761`) sont toujours `undefined`, donc un resume rejoue
   le profil **nominal** de la famille, pas l'exemplaire promis par
   `tools/target-model.mjs:124-127`. Voir « Persistance ».

2. **La scène n'a aucune lumière.** Aucun `DirectionalLight`/`AmbientLight`
   dans `src/` ; tout est `ShaderMaterial` (`TileMaterial.js:32`, `ground.js:76`,
   `sky.js:77`, `fence-dome.js:88`, `geofence-dome.js:51`) ; `sun.js:9` « ne
   ré-éclaire RIEN ». Un `MeshLambertMaterial` rendrait noir. Le maillage
   s'éclaire lui-même.

3. **Le brouillard n'est pas `scene.fog` en FIELD.** L'extinction est écrite
   matériau par matériau (`loader.js:88-96`, formule
   `1 - exp(-d²·z²)` à `TileMaterial.js:122`, dupliquée à dessein dans
   `ground.js` et `RocktreeMaterial.js`). `scene.fog` n'existe qu'en
   `bootLive()` (`src/main.js:1067`), cyan, pour le bord de fenêtre. Un
   matériau qui compte sur `scene.fog` serait sans brouillard sur une scène
   pré-cuite et cyan en direct. Le maillage porte sa propre extinction, nourrie
   de la même somme que `frame()` calcule à `src/main.js:1784-1787`.

4. **Palette.** Aucun littéral de couleur hors `src/tokens.css`
   (`tools/palette-selftest.mjs` fait échouer le build). L'échappatoire
   établie pour les matériaux est le doublon hex commenté (`fence-dome.js:19`
   `CYAN = 0x4dd8e8`). La palette demo (cyan, magenta, violet, electric) est
   réservée aux rituels ; un drone ambiant est un écran quotidien.

5. **Son.** L'audio spatial qui existe est celui de l'issue #122 :
   l'**acoustique du lieu** (`src/space.js`, modèle `tools/space-model.mjs`),
   un réseau de Schroeder dont pré-delay, durée et couleur suivent la rosette
   de rayons du vent — c'est le lieu **autour de l'auditeur** ; et le
   panoramique des quatre moteurs selon leur position sur le châssis
   (`audio.js:208-210`). Il n'existe en revanche **aucun placement d'une
   source par sa position dans le monde** : ni `PannerNode`, ni atténuation
   par la distance, ni Doppler d'une source (le seul Doppler est un effet de
   bord du lissage du pré-delay, `space.js:62-66`). `space` est un singleton
   (`space.js:246`) à l'entrée publique et au `build()` idempotent ; son
   mouillé revient dans l'`air` du joueur, à dessein (« on l'entend à travers
   les mêmes lunettes »). Son `wet` est tenu 15 dB sous le sec par prudence
   (issue #122) et **non réécouté** depuis la correction de l'accumulation
   (`HANDOFF.md`, « Audio spatial »). `EngineAudio` fait ~60 nœuds. Le pire
   cas mesuré ne laisse que **1,6 dB** de marge au limiteur
   (`docs/handoff-archive/sound.md:92-98`). Règles non négociables du même
   document : sinus seulement (`:79-83`), détune entre voix obligatoire
   (`:84-90`), rien qui renvoie de l'énergie dans 2–4 kHz (`:66-75`), graphe
   construit une fois dans `start()` et zéro allocation par frame (`:31-42`),
   silence quand la physique est gelée.

6. **Boucle de rendu.** `frame()` (`src/main.js:1485-2160`) : dt de frame
   clampé à 250 ms (`:1487`), convention `frozen ? 0 : dt` (`:1679, :1922,
   :1954`), **pas d'allocation par frame** (`:1469-1471, :373-376`), travail
   par frame hors de l'accumulateur à 250 Hz (issue #187, `:1591-1597`). Le
   code commente déjà « un seul raycast plein maillage par frame »
   (`:1641-1645`) ; la rosette du vent en paie ~208/s (`physics.js:132-137`).
   Un lancer de rayon est une requête BVH sur 3,7 M de triangles.

7. **Clôture.** Scène pré-cuite : rectangle `manifest.bbox`, fonctions pures
   `horizontalMargin(p, bbox)` (`geofence.js:258`) et `verticalMargin`
   (`:267`), couloir **mis à l'échelle de la carte** (`fence.effectiveCorridor`,
   `:347-352`). `Geofence.update()` porte une hystérésis (`:239, :284-296`) :
   ne pas partager une instance entre drones. Direct : cercle autour de
   `liveWindow.windowCenterLocal` (`rocktree-window.js:188-193`),
   `nearestTrustedRadius()` = rayon chargé moins 20 m (`:165`) ; il n'existe
   pas de « terrain chargé ici ? », le test maison est
   `physics.groundBelow(...) === null` (`src/main.js:1610`).

8. **Cycle de vie.** En FIELD, une session = une page : la fin recharge
   (`src/main.js:1247`), `finishBoot()` ne tourne qu'une fois par page
   (`:812-813`). `respawn()` (`:1340`) et `__sim.teleport` (`:585`) remettent à
   zéro fence, link, rain, fog : un sous-système doit y ajouter son `reset()`.
   `bootLive()` (`:1001`) est **partagé** entre banc libre, `?live=` et la
   reconnaissance FIELD : le garde-fou est `MODE.bench` (`:299`), pas le chemin
   de boot. Motif de `dispose()` en cinq lignes (`sky.js:281-285`).

9. **Géométrie par famille.** `INVARIANTS` (`tools/target-build.mjs:95-98`)
   fige `propRadius, bladeCount, armX, armZ` par famille : un build varie masse,
   batterie, kv, drag, rates, jamais les dimensions. `targetCamera()` donne
   `uptiltDeg` (`tools/target-camera.mjs:85-92`). Les textes de tête de
   `drone-profiles.js` (`:106-112, :144-150, :182-186, :218-224`) décrivent
   l'allure : conduits, bras de 7", GoPro nue, boom du toothpick.

10. **Filets de l'entry state.** `geometrySafe()` (`src/entry-state.js:240-256`)
    est duck-typé sur `{ groundBelow, obstructionBetween }` et tourne en Node
    avec des stubs (`tools/selftest.mjs:1976-1985`) ; sa règle « bloqué **et**
    épaisseur > 2 m » distingue un toit frôlé d'un mur. `occupancyOf()` cache
    sa grille dans un `WeakMap` jamais invalidé (`:153, :186`) : périmé en
    direct. `rolloutSafe()` téléporte **le corps du joueur** (`:269`) : interdit
    ici.

## D'où ils viennent

    ambiants = scan.candidates.filter((c, i) => i !== index)
    n = count - 1 ∈ [1, 4]

Chaque ambiant est un candidat complet : `_family`, `rssiDbm`, `_videoHint`, et
sa graine d'exemplaire `${scan.seed}::${i}` — la même que `resolveTarget()`
donnerait s'il avait été pris (`tools/target-model.mjs:129`). On en tire
`targetBuild({ seed, family })` pour la masse, le TWR et la batterie, et
`targetCamera({ seed, family })` pour l'inclinaison de la caméra. Les tirages
propres à l'ambiant (ancre, phase, LED, détune) partent d'un flux **séparé**,
`rngFrom(\`${seed}::ambient\`)`, pour ne décaler aucun tirage existant
(convention des suffixes `::build`, `::camera`, `::scan`).

Le drone que le joueur pilote **n'est pas** dans la liste : il est déjà dans
le ciel, c'est la caméra.

Chemins sans scan :

- `?scene=<slug>` (dev) et `?live=lat,lon` (dev) : on synthétise
  `{ seed: \`dev::${slug|lat,lon}\`, count: 4, index: 0 }` pour que le dev voie
  trois ambiants. Ce n'est pas une session, rien n'est écrit.
- BENCH : rien, par construction (`if (MODE.bench)` au point de création).
- Reconnaissance FIELD (`MODE.live`) : le scan existe (`src/main.js:2382`),
  chemin normal.

## La bulle

Deux rayons autour du joueur, en mètres horizontaux :

    R_SPAWN  = [120, 250]   couronne où un drone naît
    R_LEAVE  = 320          au-delà, son ancre est abandonnée

Sur un écran 1920 px à FOV 120, un quad de 25 cm à 250 m fait 0,55 px : une
naissance à cette distance est invisible même de face. On la place quand même
**hors du champ** (produit scalaire entre la direction du drone et l'axe caméra
inférieur à `cos(FOV/2 + 15°)`), et si elle tombe dans le champ, seulement
au-delà de 220 m, par sécurité. Les naissances n'ont lieu que sur une frame
**non gelée** : avant, la caméra n'est pas encore posée sur le drone
(`src/main.js:1654-1660` est dans le bloc `!frozen`) et « hors champ » ne
voudrait rien dire. La première frame de vol en fait naître un, la suivante un
autre : le ciel est peuplé en quatre frames, toutes hors champ. Un drone
dont l'ancre passe `R_LEAVE` disparaît sans transition : à 320 m et 0,4 px,
personne ne le voit partir, et une animation de départ serait du travail pour
un événement que l'œil ne perçoit pas. Sa famille renaît aussitôt dans la
couronne. La population est **constante** : ce sont toujours les mêmes
signaux, retrouvés un peu plus loin.

L'hystérésis est dans l'écart entre 250 et 320 : un joueur qui fait
l'aller-retour à la frontière ne fait pas clignoter un drone.

**Bornage par la clôture.** L'ancre et toute la trajectoire doivent tenir :

- scène pré-cuite : `horizontalMargin(p, bbox) ≥ corridor.hold + r_routine`
  et `p.y ≥ bbox.min[1] + 5` (au-dessus de `FLOOR_HOLD`) ;
- direct : `hypot(p.x - c.x, p.z - c.z) + r_routine ≤ nearestTrustedRadius()`
  avec `c = windowCenterLocal` ; tant que `windowCenterLocal` est `null`,
  pas de naissance.

Sur une petite carte, la couronne se resserre : `R_SPAWN.max` devient
`min(250, halfMin - corridor.hold)` et `R_LEAVE` suit à `+70`. Si la carte ne
peut pas loger la couronne minimale (120 m), les drones naissent où ils
peuvent dans la clôture et ne quittent jamais : `R_LEAVE = ∞`.

En direct, la même règle s'applique au cercle de confiance, et elle mord
souvent : `FALLBACK_RADIUS_M = 200` (`rocktree-window.js:24`) donne un rayon
de confiance de **180 m** par défaut, sous les 250 m de la couronne.
`R_SPAWN.max = min(250, nearestTrustedRadius() − r_routine)`, relu à chaque
naissance parce que le rayon est adaptatif (`:128-138`). Un drone dont le
terrain se décharge derrière le joueur continue sa courbe pré-validée
au-dessus de rien : le terrain n'est plus dessiné non plus, et `R_LEAVE` le
rattrape.

## Les routines

Chaque famille a **une** routine, calculée sur le terrain réel autour d'une
ancre. Une routine est une courbe paramétrique `p(t)` autour de l'ancre `A`,
qu'on échantillonne, jamais une simulation.

| famille | routine | AGL | vitesse | rayon |
|---|---|---|---|---|
| `race5` | tours serrés, plan incliné, sens tiré | 3–10 m | 15–22 m/s | 12–20 m |
| `freestyle5` | huit horizontal avec un sinus vertical (±8 m) | 10–40 m | 12–18 m/s | 18–28 m |
| `heavy5` | même huit, plus lent, sans le sinus | 10–30 m | 9–14 m/s | 22–30 m |
| `cinewhoop` | orbite plate autour d'une structure, **nez vers l'ancre** | 15–30 m | 3–6 m/s | 10–25 m |
| `longrange` | croisière rectiligne, demi-tour au bord de la bulle | 60–120 m | 18–26 m/s | demi-tour 120 m |
| `toothpick` | orbite basse au ras du sol, bruit de trajectoire | 1–5 m | 2–5 m/s | 4–8 m |

Les plages sont choisies à l'oreille de pilote, pas mesurées, comme
`RANGES` de l'entry state (`src/entry-state.js:47-49`) ; le filet est ce qui
rend chaque tirage juste, pas la plage.

**Le TWR borne le virage.** L'accélération latérale d'un quad est bornée par sa
poussée : `a_max = g · √(twr² − 1)`. Avec `twr` du build
(`targetBuild().spec.twr`), on plafonne la vitesse tirée pour que
`v²/r ≤ 0,6 · a_max`. Un race à TWR 8 se couche ; un cinewhoop à TWR 2,8 ne
peut pas, et c'est exact. C'est le seul point où le build change la routine, et
il est physique.

**Le cinewhoop regarde son sujet.** Sa caméra pointe vers l'ancre pendant
l'orbite (lacet vers `A`), quand tous les autres volent nez dans la vitesse.
C'est ce qu'un cinewhoop fait, et ça se voit de loin.

**Le micro tremble.** Sa trajectoire ajoute une somme de trois sinus
d'amplitude 0,3 m et de fréquences 0,7 / 1,3 / 2,1 Hz, phases tirées. Le
`filterScale: 2.0` de la famille (`drone-profiles.js`) dit déjà que cette
machine est nerveuse.

**Le long range fait demi-tour au bord.** Sa ligne droite est un segment entre
deux points de la bulle ; arrivé au bout, un arc de 120 m le ramène. Son ancre
est le milieu du segment, donc `R_LEAVE` s'applique comme aux autres.

### Choix de l'ancre et validation

Une ancre est tirée dans la couronne, hors champ, dans la clôture. Puis :

1. `groundBelow(x, top, z, span)` depuis le haut de la bbox (copie de
   `groundAt`, `src/entry-state.js:127-131`, privé). `null` → rejet (en
   direct, c'est « pas chargé »).
2. La courbe est échantillonnée en **16 points**. À chaque point, un
   `groundBelow` ; le point doit être à `≥ AGL.min` de la famille au-dessus, et
   la hauteur de la courbe **suit** les hauteurs échantillonnées (interpolation
   linéaire entre échantillons) : le micro épouse le relief, le long range ne
   bouge pas.
3. Entre échantillons consécutifs, `obstructionBetween` avec la règle de
   `geometrySafe` : rejet si `blocked && span > 2 m`.
4. Trois rejets consécutifs → on retire au hasard une autre ancre ; dix → on
   attend une seconde et on recommence (le terrain arrive peut-être).

Coût : 1 + 16 + 2·16 = **49 rayons par candidat**, à la naissance seulement,
**un candidat par frame** au plus. Un ciel de quatre drones coûte quatre
frames de 49 rayons au démarrage, puis rien : en vol, la courbe est
pré-validée et **aucun rayon n'est lancé**. Aucune validation ne tourne dans
l'accumulateur à 250 Hz.

### Cinématique et attitude

    p(t)  position sur la courbe
    v(t)  dérivée (différence centrée, h = 1/60 s)
    a(t)  seconde dérivée

L'attitude vient du mouvement, pas d'un contrôleur : un quad incline sa
poussée dans `a + g − a_drag`, avec `a_drag = bodyDrag · |v_air| · v_air / m`
et `v_air = v − wind`. Le vent est lu une fois par frame sur `physics.wind.out`
(`wind.js:398`, déjà calculé pour le joueur) et appliqué avec une phase par
drone : les ambiants se **penchent dans le vent** avec le drag de leur
famille, sans rosette de rayons. L'axe **Y** du corps (le haut du quad) =
direction de poussée normalisée ; le lacet = cap de `v` (ou vers `A` pour le
cinewhoop) ; le roulis en découle. Un lissage exponentiel à τ = 80 ms évite les sauts aux
changements de segment.

Les positions, vitesses et quaternions vivent dans des `Float64Array`
pré-allouées de taille 4 ; `update()` ne crée rien.

## Le maillage paramétrique

Deux modules, même découpe que partout : la **recette** est pure et testée sans
navigateur, l'**assemblage** Three.js est dans le client.

`src/drone-shape.js` (pur) : `shapeOf(profile, build, camera) → parts`. Une
liste de primitives en mètres, dans le repère du corps :

| pièce | dimension | source |
|---|---|---|
| plaque centrale | `L = 1.1·armZ, l = 0.8·armX, h = 6 mm` (heavy : 10 mm) | `armX/armZ` |
| 4 bras | du centre à `(±armX, ±armZ)`, section 8 mm ; toothpick : bras nus 5 mm | `armX/armZ` |
| 4 moteurs | cylindre r = 0.18·propRadius, h = 12 mm | `propRadius` |
| 4 disques d'hélice | r = propRadius, translucides | `propRadius` |
| conduits | anneau r = 1.12·propRadius, h = 0.5·propRadius | cinewhoop, toothpick |
| caméra | boîte 19×19×10 mm à l'avant, inclinée de `uptiltDeg` | `targetCamera` |
| batterie | boîte sur le dessus, `L = 20 mm · cells`, section 35×25 mm | `build.spec.cells` |
| GoPro | boîte 40×30×25 mm sur l'avant du dessus | cinewhoop ; freestyle/heavy si `mass > 1.05 × nominal` |
| antenne | tige 3 mm, 60 mm, arrière | tous ; long range : 2 |
| LED | point à l'arrière | tous |

Le long range se reconnaît à ses bras de 7" (`armX` 0,105 contre 0,078), le
micro à sa taille (empattement 76 mm) et ses deux pales, le cinewhoop à ses
conduits. Deux builds d'une même famille diffèrent par la batterie, la GoPro et
la caméra : c'est ce que le build sait varier, et rien d'autre (contrainte 9).

`src/drone-mesh.js` (Three.js) : `buildDroneMesh(parts) → { mesh, led, dispose }`.
Une seule `BufferGeometry` fusionnée (plaque, bras, moteurs, conduits, caméra,
batterie, antenne ≈ 300 triangles) avec **couleurs par sommet** tirées de la
rampe : carbone `--dark-grey`, moteurs et caméra `--grey`, disques
`--light-grey` à 35 % d'alpha (alpha par sommet, `transparent: true`,
`depthWrite` gardé : à cette taille un tri des disques ne s'y verrait pas),
LED `--warm-white`. Un `ShaderMaterial` maison, motif `ground.js` :

- éclairage à la main : `0.55 + 0.45 · max(0, n · sunDir)` par `sun.dir`,
  multiplié par `sun.ambient` ; la nuit suit `setNight` comme les tuiles ;
- extinction `1 − exp(−d²·z²)` vers `uFogColor`, mêmes uniformes et même
  cadence d'écriture que `loader.setFog` (throttle sur changement) ;
- disques d'hélice : un `uTime` fait tourner un bruit radial dans le disque,
  effet de flou d'hélice sans géométrie animée ;
- la LED est un second maillage, un quad billboard **additif** dont la taille
  est clampée en pixels dans le vertex shader (min 3 px), avec un motif de
  strobe par drone (période 1,2 s, rapport tiré) : elle se voit avant le drone,
  comme une vraie.

Deux draw calls par drone, huit au pire ; `matrixAutoUpdate = false`, matrice
écrite à la main depuis les tableaux pré-alloués ; `frustumCulled = true` avec
une sphère de rayon `2·propRadius + hypot(armX, armZ)`. `dispose()` en cinq
lignes. Aucun registre de module : le tableau des maillages appartient à
l'instance `AmbientDrones`.

La couleur en JS passe par `token('--dark-grey')` etc. (`src/palette.js:31-42`)
au moment de construire la géométrie, pas par des littéraux.

Toute la sortie du rendu traverse `lens.render` (`lens.js:1080`) : les
ambiants reçoivent barillet, aberration, AGC, grain et dégradation du lien sans
rien faire.

## Le son

`src/ambient-audio.js`, une classe `AmbientAudio` avec **quatre voix construites
une fois** dans `start()` (une par ambiant possible), inactives à gain zéro :

    osc(sine, f_blade)  ──┐
    noise ─ bandpass ─────┼→ gain(distance) → lowpass(distance, dos) → panner ─┬→ engineIn()
                                                                              └→ space.input

Six nœuds par voix, vingt-quatre en tout, plus un `BufferSource` de bruit
partagé.

**Ce que #122 a décidé, et pourquoi ça ne s'applique pas ici.**
`tools/space-model.mjs:6-14` explique l'absence de panner : les moteurs du
joueur sont solidaires de sa tête, une source immobile par rapport à
l'auditeur n'a rien à spatialiser, et c'est ce que le monde **renvoie** qui
donne la proximité. Un drone ambiant est exactement le cas inverse : une
source qui **bouge** par rapport à l'auditeur. Le placement de source est donc
justifié pour lui, et il complète l'acoustique du lieu au lieu de la
contredire : le sec est placé, et le lieu autour de l'auditeur le renvoie comme
il renvoie les moteurs du joueur. D'où l'envoi vers `space.input` (entrée
publique, `build()` idempotent : on ne reconstruit rien), à un gain égal au
sec, le `wet` de `space` faisant le niveau. Un race qui passe dans la même cour
que toi y résonne.

Le placement est volontairement **léger** : quatre indices, tous physiques,
aucun HRTF.

- `f_blade = ω · bladeCount / 2π`, avec `ω = 0.55 · maxOmega` en croisière,
  modulé de ±15 % par `|a|` (le moteur monte en virage) ;
- **détune** par voix, tiré dans ±9 cents, et un wander lent comme
  `AUDIO.wanderHz` : quatre voix qui se verrouillent en phase feraient le son
  de test de synthé que `sound.md:84-90` interdit ;
- gain `g = g0 / (1 + d/8)` avec `g0` tel que la somme des quatre voix au plus
  près (`d = 8 m`) reste **12 dB sous** l'`idleLevel` du joueur : la marge de
  1,6 dB du limiteur n'est pas à nous ; zéro au-delà de 250 m ;
- passe-bas : `f_c = 2600 Hz` à 0 m → `800 Hz` à 250 m, en log de la
  distance (l'air absorbe les aigus), **× 0,6 quand la source est dans le
  dos** (ombre de la tête, lissée sur l'azimut) : c'est l'indice devant/derrière
  qu'un panoramique seul ne donne pas ; rien ne revient dans la bande 2–4 kHz ;
- Doppler écrit **à la main** sur `osc.frequency` :
  `f · c / (c + v_r)`, `c = 343`, `v_r` vitesse radiale relative au joueur,
  bornée à ±40 m/s ; jamais le Doppler du `PannerNode`, retiré de la spec ;
- panoramique `StereoPanner` équi-puissance sur l'azimut dans le repère
  caméra, lissé (τ = 60 ms) pour qu'un passage au-dessus ne saute pas d'une
  oreille à l'autre (le `PannerNode` HRTF coûte et n'apporte rien à 2 px) ;
- `update()` une fois par frame, `setTargetAtTime` avec les τ de `AUDIO` ;
  `setMuted(frozen)` comme `EngineAudio` ; silence sur `linkDead` (le retour
  vidéo est mort, le son aussi).

Niveaux relatifs **choisis, pas mesurés**, comme le reste du son
(`sound.md:106-111`) ; on le dit dans le code.

## Intégration dans `main.js`

    src/ambient.js         pur : bulle, ancres, routines, cinématique, attitude
    src/drone-shape.js     pur : recette géométrique
    src/drone-mesh.js      Three.js : assemblage, matériau, LED
    src/ambient-audio.js   Web Audio : quatre voix
    src/ambient-drones.js  l'instance : lie les quatre, parle à main.js

`AmbientDrones` est créé dans `finishBoot()` à côté de `distantGround`
(`src/main.js:822`) et dans `bootLive()` à côté de `fenceDome` (`:1061`), les
deux fois sous `if (!MODE.bench)`. Il reçoit `{ scene, physics, fenceBounds,
scan, sun }` avec `scan = { seed, count, index }` et `fenceBounds` soit
`{ bbox, corridor }` (scène pré-cuite) soit `{ liveWindow }` (direct, sans
manifest).

Dans `frame()`, **après** le bloc caméra (`:1654-1660`) et avant
`lens.render` (`:2014`), à côté de `skyDome.update` :

    ambient?.update({
      dt: frozen ? 0 : dt,
      player: physics.position, playerVel: physics.velocity, camera,
      wind: physics.wind.out, fogDensity, sun,
    });

`fogDensity` est la somme déjà calculée à `:1784-1787`, remontée dans une
variable de module au lieu d'être recalculée.

- `respawn()` (`:1340`) et `__sim.teleport` (`:585`) appellent
  `ambient.reset()` : la bulle se recentre, les drones renaissent hors champ.
- `flightEnd.out.linkDead` (`:1711`) : `ambient.audio.silence()`. Les
  maillages continuent de voler — l'écran est mort, mais s'il ne l'était pas,
  les autres n'ont aucune raison de s'arrêter.
- `window.__sim.ambient` et `__sim.debug().ambient` :
  `{ count, families, positions, relocations, raysCast, spawnFailures }`,
  renseignés avant la première frame (`:1185-1187`).
- `dispose()` existe et est appelé avec `droneOsd?.dispose()` (`:2811`) ; en
  FIELD la page se recharge de toute façon.

## Persistance

Pour qu'un resume rejoue **les mêmes ambiants**, la session doit garder le
scan. On ajoute au descripteur de cible :

    target.scan = { seed, count, index }

- `resolveTarget()` le remplit (il a `scan` et `index` sous la main) ;
- `sanitizeTarget()` (`tools/session-model.mjs:78-85`) le garde, avec
  validation de forme (`seed` chaîne non vide, `count` entier 2..5, `index`
  entier `< count`) ; `validateSession()` (`:244-272`) pareil ;
- `SESSION_SCHEMA_VERSION` passe à **2** ; une session v1 n'a pas de `scan` :
  au resume, **pas d'ambiants**, honnêtement, plutôt qu'un tirage inventé.

Au passage, et parce que c'est le même champ, `buildSeed` est reconstruit côté
client depuis `scan` (`${seed}::${index}`) : le resume rejoue enfin
**l'exemplaire** et non le nominal (contrainte 1). Ce n'est pas un effet de
bord, c'est la promesse de `tools/target-model.mjs:124-127` tenue.

## Ce qu'on vérifie

**Sans navigateur** — `tools/ambient-selftest.mjs`, ajouté à
`selftest:operator`, stubs `{ groundBelow, obstructionBetween }` comme
`tools/entry-state-selftest.mjs:62-64` :

- déterminisme : même `{ seed, count, index }` → mêmes familles, mêmes ancres,
  mêmes phases ;
- `n = count − 1`, familles = celles des candidats non pris, le pris absent ;
- toute ancre dans la couronne, hors du cône caméra donné ;
- toute courbe : 16 échantillons au-dessus du sol stub de `≥ AGL.min`, dans le
  rectangle (bbox + couloir) **et** dans le cercle (centre + rayon de
  confiance) selon le mode ; sol `null` → aucune naissance ;
- vitesse dans la plage de la famille ; `v²/r ≤ 0,6·g·√(twr²−1)` ;
- angle d'inclinaison dérivé ≤ 75° sur toute la courbe, et cohérent avec `a`
  (race couché, cinewhoop < 12°) ;
- relocalisation : joueur déplacé de 400 m → toutes les ancres > `R_LEAVE`
  sont renées dans la couronne, hors champ ; déplacé de 60 m → aucune ;
- petite carte (halfMin 90 m) : couronne resserrée, `R_LEAVE = ∞`, aucune
  ancre hors clôture ;
- `update()` n'alloue pas : mêmes références de tableaux avant et après 1000
  pas ;
- recette : le long range a des disques de 88,9 mm, le micro deux pales et un
  empattement 76 mm, le cinewhoop des conduits, un build lourd une GoPro ;
  même build → même recette ;
- audio (modèle pur, sans `AudioContext`) : gain décroissant en `d`, nul à
  250 m, somme des quatre à 8 m ≤ −12 dB sous `idleLevel` ; passe-bas
  décroissant, et plus bas dans le dos qu'en face à distance égale ; azimut
  continu au passage du zénith ; Doppler à ±40 m/s dans ±12 % ; détunes
  distincts ; l'envoi vers `space` égal au sec (le faux contexte de
  `tools/space-selftest.mjs` a déjà `createDelay`).

**Avec la scène** — un bloc dans `tools/selftest.mjs` (Physics réel,
tour-eiffel) : 40 naissances sur 40 graines, toutes validées contre le vrai
trimesh ; aucune ne coupe un mur (rejeu de `obstructionBetween` sur 64 points).

**Au navigateur**, par l'opérateur lui-même dans Chrome, avec une marche à
suivre livrée avec le code : `__sim.debug().ambient.count === count−1` en
FIELD, `undefined` au banc ; `drawCalls` monte de `2·n` ; regarder à 30 m,
100 m, 250 m que la LED se voit avant le corps ; nœuds audio constants après
`start()` ; longtask nul en vol (les naissances sont réparties une par frame).

## Écarté

- **Corps Rapier pour les ambiants.** Un corps de plus par drone recalcule les
  propriétés de masse (~57 ms/pas, #184) et une collision drone-drone
  n'apporte rien à cette version.
- **`MeshLambertMaterial` / `scene.fog`.** Contraintes 2 et 3.
- **Un `EngineAudio` par drone.** 240 nœuds et quatre buffers de bruit pour
  un son qui, à 30 m et plus, n'a plus aucun des détails que cette classe
  existe pour produire. Contrainte 5.
- **HRTF / binaural.** Coûteux, et inaudible sur une source de deux pixels ;
  les quatre indices (azimut, distance, ombre du dos, Doppler) suffisent, et
  chacun est une mesure.
- **Doppler du `PannerNode`.** Retiré de la spec Web Audio ; à la main.
- **Sprites.** Le maillage sert ensuite au drone du joueur ; un sprite non.
- **Autonomie et ancres fixes.** Décision du 2026-09-06 : le ciel ne se vide
  pas, la bulle suit.
- **Animation de départ à `R_LEAVE`.** 0,4 px : on ne fabrique pas un
  événement que l'œil ne voit pas.
- **Points mobiles sur la carte du scanner, channel scan sur la vidéo
  analogique des autres, fantômes de ses propres vols, collision.** Chacun a sa
  place plus tard ; aucun n'est nécessaire pour que le ciel soit vivant.
