# Issue #22 — Météo : nuages et ciel

État : validé 2026-08-29.

Issue : https://github.com/lionrayonnant/FPVTP/issues/22
Chapeau : #19 (support de la météo). Couche de rendu consommée par #41 (PHASE 04
— monde persistant), déjà livrée.

## Objectif

Ciel dégagé → épars → couvert → plafond bas, nuages dynamiques, évolution
progressive de la couverture pendant le vol, soleil masqué temporairement.

Ce n'est **pas** un réglage. `cloudPct` existe déjà dans le modèle météo et est
déjà assaini ; cette spec ne fait que le brancher sur le rendu. Aucun slider,
aucun preset, aucune valeur persistée : la règle de #41 tient.

## État du dépôt à cette date

- Il n'y a pas de ciel : `scene.background` est une couleur plate
  `SKY = 0x9fb8cc` (`main.js:35`, `main.js:76`), lerpée vers `RAIN_SKY` /
  `FOG_SKY` par `weatherSky()` (`main.js:575`).
- `cloudPct` est **un canal mort** : produit par `proceduralForecast()`
  (`tools/lib/weather.mjs:269`) et par l'API Open-Meteo (`:351`), assaini par
  `sanitize()` (`:144`, `:156`, `:161`), classifié par `classify()` (`:102`) —
  et consommé par **rien** côté rendu. `toSimParams()` ne l'exporte même pas.
- `three/examples/jsm/objects/Sky.js` est disponible et inutilisé. On ne s'en
  sert pas (voir « Approches écartées »).
- Caméra : FOV 120, `near` 0.15, `far` 2500 (`main.js:48`).

### Contraintes dures, héritées et non négociables ici

- La photogrammétrie est **non éclairée** : aucune lumière dans la scène,
  `TileMaterial.js` sort le texel échantillonné tel quel, la géométrie n'a **pas
  d'attribut `normal`** (`loader.js:57-61` ne pose que `position`, `uv`,
  `aLayer`), et l'ombrage d'Apple est cuit dans les textures.
- `ColorManagement.enabled = false` et `NoToneMapping` (HANDOFF bug #10). Toutes
  les couleurs sont écrites en sRGB et sortent telles quelles. Le shader du dôme
  ne quitte jamais l'espace sRGB : il n'y a donc rien à convertir, et rien à
  recalibrer.
- Le collider du drone reste une sphère de rayon 0,15 m ; cette spec ne touche
  pas à la physique du vol.

## Décisions transverses de cette spec

### D0 — Pas d'ombres de nuages projetées au sol

Tranché avec le propriétaire du dépôt, qui l'avait soulevé en commentaire de
l'issue : les tuiles portent déjà des ombres cuites, un motif projeté par-dessus
les contredirait. Le volet « ombres portées » du titre de l'issue est donc livré
sous la forme d'un **assombrissement global sans motif** : un seul scalaire,
aucune structure spatiale, rien qui puisse entrer en conflit avec l'ombrage
d'Apple.

Ce n'est pas un repli. Le scalaire respire (D3), et un assombrissement qui
respire *est* le soleil qui passe derrière un nuage — ce que l'issue demande
sous « soleil masqué temporairement ». Le volet est donc réellement couvert, et
**#23 (soleil) n'est pas un prérequis**.

### D1 — Le plafond est traversable

La base des nuages est à une altitude atteignable quand la couverture est forte.
En s'en approchant, la visibilité s'effondre (whiteout) ; en la traversant, on
débouche au-dessus de la couche.

Conséquence assumée et voulue : **le plafond n'est atteignable que par mauvais
temps.** Les altitudes de base viennent des vraies classes météo (D2), donc par
ciel épars la base est à ~800 m et on ne la touchera jamais. Le whiteout
n'existe que quand le monde a décidé qu'il était bouché. Ce n'est pas un effet
qu'on va chercher, c'est une contrainte qu'on subit — la règle de #41.

Ça referme aussi la boucle avec `sanitize()`, qui force déjà `cloudPct >= 60`
sous 1000 m de visibilité : brouillard au sol et plafond bas arrivent ensemble
parce que dans l'atmosphère ils arrivent ensemble.

### D2 — Les altitudes de base sont météo, pas inventées

Ancrage sur les classes observées, pas sur des positions rondes :

| Régime                              | Couverture | Base AGL    |
|-------------------------------------|------------|-------------|
| Cumulus de beau temps               | 20-40 %    | 600-1200 m  |
| Stratocumulus                       | 60-90 %    | 300-900 m   |
| Stratus bouché / plafond bas        | > 90 %     | 100-300 m   |

Mapping **géométrique** de `BASE_CLEAR = 1500 m` à couverture nulle vers
`BASE_OVERCAST = 120 m` à couverture pleine — géométrique parce que c'est la
seule échelle sur laquelle « un peu plus bas » veut dire la même chose à 1200 m
et à 150 m, exactement l'argument que `fog.js` fait pour la portée.

### D3 — La couverture respire, elle n'est pas figée sur la journée

Le snapshot donne **une** valeur par jour. L'« évolution progressive de la
couverture » de l'issue vient donc d'un modèle temporel local, sur le mécanisme
de `FogField` : deux bandes d'Ornstein-Uhlenbeck, renormalisées à variance
unité, et un jitter **lognormal** `exp(k·n − k²/2)` de moyenne unité — pour que
monter la variabilité fasse aller et venir la couverture sans monter sa moyenne
en douce.

Échelles de temps : `TAU_SLOW = 600 s`, `TAU_FAST = 150 s`. Ce sont les échelles
des nuages, pas celles du brouillard (`fog.js` : 120 / 25). Un vol dure quelques
minutes, donc on voit une fraction de cycle : ça évolue, ça ne clignote pas.

### D4 — `scene.background` survit et change de sens

Le dôme couvre l'écran, donc `scene.background` n'est jamais vu. On le **garde
quand même**, et il prend le sens de « la couleur de l'horizon ».

Raison : il est lu par `rainfall.setSky()` (`main.js:671`), par le voile de
`lens.js` (`main.js:699`) et par le HUD. En lui donnant la couleur d'horizon du
dôme, **`rainfall.js` et `lens.js` ne sont pas touchés du tout** et continuent de
lire la bonne valeur. C'est aussi ce qu'exige le fondu des tuiles : `setFog()`
reçoit cette même couleur, donc une tuile lointaine se fond dans l'horizon du
dôme au lieu de se fondre dans une couleur qui n'y est plus, et la ligne
d'horizon ne se dédouble pas.

### D5 — Air clair bit-identique

`cover === 0` doit être bit-identique à l'absence totale de modèle **du côté du
modèle** : `dim` exactement 1, `extinctionAt()` exactement 0 à toute altitude,
aucun tirage aléatoire consommé, aucun filtre avancé, densité de nuage
exactement 0 dans le shader. C'est la promesse que `wind.js` fait au calme,
`rain.js` au temps sec et `fog.js` à l'air clair, et c'est ce qui garde
`tools/selftest.mjs` vert sur un monde neutre.

**Ce que D5 ne dit pas.** L'invariant historique « le pixel de ciel sort
`#9fb8cc` » (HANDOFF, la régression à ne pas rouvrir) **ne peut pas** survivre
tel quel : remplacer une couleur plate par un dégradé change le pixel du zénith,
et c'est précisément l'objet de l'issue. L'invariant est donc reformulé, pas
abandonné :

> La couleur d'**horizon** par ciel clair reste exactement `#9fb8cc`. Le zénith
> gagne de la profondeur.

C'est la bonne lecture de la régression d'origine, qui portait sur l'accord
entre le fondu des tuiles et le fond — des façades grises sur un fond qui ne
leur correspond pas. Cet accord est ce que D4 protège explicitement, et il est
**renforcé**, pas affaibli : `setFog()` et `scene.background` reçoivent tous les
deux la couleur d'horizon du dôme. Un ciel clair a d'ailleurs son zénith plus
profond que son horizon — garder le dégradé plat au ciel clair aurait été le
seul cas où le rendu serait faux.

### D6 — Le nombre qui n'est pas décidé d'avance

L'amplitude maximale d'assombrissement (`DIM_MAX`) **n'est pas posée par cette
spec**. La radiométrie dit qu'un ciel couvert laisse passer 15-30 % de
l'éclairement du ciel clair ; l'appliquer casserait l'image, parce que la
photogrammétrie est cuite avec un éclairage ensoleillé, qu'on ne peut pas la
ré-éclairer, et qu'on vole *à* cette texture. La contrainte réelle est la
lisibilité, pas l'éclairement.

Le code partira d'une valeur de départ documentée comme provisoire, et elle sera
**calibrée en vol dans le navigateur** avant d'être figée. La valeur retenue et
la façon dont elle a été mesurée sont notées dans le commit et dans HANDOFF.

## Architecture

Découpage strictement calqué sur l'existant : un modèle pur, un rendu.
`rain.js` (modèle) / `rainfall.js` (rendu) ; `fog.js` (modèle) / `lens.js`
(rendu). Ici : `cloud.js` (modèle) / `sky.js` (rendu).

### `src/cloud.js` (nouveau) — le modèle

Pas de THREE, pas de DOM. C'est la moitié que `tools/selftest.mjs` peut
vérifier, même règle et même raison que `wind.js`, `rain.js` et `fog.js`.

```js
class CloudField {
  constructor(seed, ...)      // déterministe, comme FogField
  setParams({ cover, variability })
  get active()                // cover > 0
  reset()                     // déterministe : un respawn ne retombe pas
                              // au milieu du grain en cours
  update(dt)

  // lus chaque frame par main.js :
  cover        // 0..1, la couverture effective de cette frame, respiration incluse
  base         // mètres AGL, l'altitude de la base
  dim          // 0..1, l'assombrissement du sol (1 = pas d'assombrissement)

  extinctionAt(altitudeAGL)   // le whiteout, dans les unités du shader
}
```

`extinctionAt()` rend une extinction, dans les mêmes unités que
`fog.extinctionOf()` — parce que **les extinctions s'additionnent**, ce qui est
déjà l'argument par lequel `main.js:660` ajoute la pluie au brouillard. Elle est
exactement 0 loin sous la base, monte en approche, et sature dans la couche.
Son amplitude est proportionnelle à la couverture, pas un seuil binaire : à 0,3
c'est une laiteuse en approche, à 0,95 c'est un vrai whiteout.

### `src/sky.js` (nouveau) — le rendu

Le dôme et son shader. Sphère `BackSide` de **rayon 1**, recollée sur la position
caméra chaque frame, `depthTest: false`, `depthWrite: false`,
`frustumCulled = false`, rendue en premier. Rayon 1 et depth désactivé rendent
`near`/`far` hors sujet : rien ne peut clipper, et le dôme ne consomme pas de
budget de profondeur.

```js
class SkyDome {
  constructor(scene, { sky })       // sky = la couleur de ciel clair existante
  setState({ cover, base, altitudeAGL, wind, rainScale, fogMix })
  get horizon()                     // THREE.Color — voir D4
  update(camera, dt)                // recolle le dôme, avance la dérive
  dispose()
}
```

**Dégradé.** Zénith → horizon, les deux couleurs pilotées par la couverture
(bleu franc → blanc laiteux → gris plomb — `cover` est déjà le 0..1 dont la
couleur a besoin, il n'y a donc pas d'équivalent du `skyMix` de `fog.js` ici),
puis passées dans les lerps existants
vers `RAIN_SKY` / `FOG_SKY`. `weatherSky()` **gagne la couverture en entrée**, il
n'est pas remplacé : une seule fonction décide encore de la couleur de l'air.

**Couche nuageuse.** Pour une direction de vue `d`, plan horizontal à
`h = base − altitudeAGL` :

```
t = h / d.y ;  p = camXZ + d.xz · t ;  densité = FBM(p · échelle + dérive)
```

- FBM 4-5 octaves, bruit haché, **aucune texture, aucun asset**.
- La couverture pilote un seuil :
  `densité = smoothstep(1 − cover − w, 1 − cover + w, fbm)`.
- **Dérive** : offset sur les coordonnées, pris sur la direction et la vitesse du
  vent (`physics.wind`) — c'est la connexion à #20 que l'issue demande. Un
  **second offset plus lent sur les octaves hautes**, pour que les nuages se
  déforment au lieu de translater en bloc.
- **Couleur** : lerp blanc → gris par la densité, donc les paquets épais sont
  plus sombres. Pas d'éclairage, pas de normale — une corrélation
  densité/luminosité, ce qui suffit à les lire comme volumiques.

Deux cas limites traités plutôt qu'ignorés :

- **`d.y → 0`** (regard vers l'horizon) : le point d'impact part à l'infini.
  Fondu sur les derniers degrés. C'est aussi ce que fait l'atmosphère — les
  nuages se compriment en bande à l'horizon — donc la dégénérescence numérique
  et le rendu correct sont le même geste.
- **`h < 0`** (on est passé au-dessus de la couche) : on échantillonne vers le
  bas au lieu du haut. Ça coûte un signe, et c'est la récompense de D1 : on perce
  l'overcast et on débouche dessus.

Sous l'horizon (`d.y < 0` et `h > 0`) : pas de nuages, juste la couleur de
l'air ; les tuiles couvrent cette zone de toute façon.

### `src/TileMaterial.js` — un uniforme

`uDim`, scalaire, multiplie le texel. Défaut `1.0` : bit-identique à aujourd'hui
(D5). C'est le seul changement, et il ne réintroduit aucun modèle d'éclairage —
`TileMaterial.js` continue de ne rien savoir des normales.

### `src/loader.js` — un setter

`setDim(dim)`, exactement sur le modèle de `setFog(color, density)` (`loader.js:40`) :
il parcourt les matériaux de chunk et pousse l'uniforme.

### `tools/lib/weather.mjs` — le canal manquant

`toSimParams()` gagne un troisième canal :

```js
cloud: { cover: d.cloudPct / 100, variability }
```

`variability` suit la même logique que le brouillard : un ciel épars s'agite, un
couvercle d'overcast ne bouge presque plus — donc elle décroît avec la
couverture. Aucune constante nouvelle n'est inventée du côté du modèle météo :
`cloudPct` est déjà produit, déjà borné, déjà cohérent avec la pluie et la
visibilité par `sanitize()`.

### `src/weather.js` — le câblage

`applyWeather()` gagne `cloud?.setParams(p.cloud)`, à côté de `physics`, `rain`
et `fog`. `CALM` gagne `cloud: { cover: 0, variability: 0.5 }`, pour que le monde
neutre de `selftest.mjs` reste neutre.

### `src/main.js` — l'assemblage

- `cloud = new CloudField(undefined)` à côté de `rain` et `fog`.
- `sky = new SkyDome(scene, { sky: SKY })`.
- Dans la boucle, à côté de `fog.update(dt)` : `cloud.update(dt)`.
- La densité de la ligne 660 devient
  `fog.density + extinctionOf(rain.visibility) + cloud.extinctionAt(altitudeAGL)`.
  L'altitude sol est déjà calculée (`main.js:360`).
- `setFog(sky.horizon, density)` et `scene.background.set(sky.horizon)` (D4).
- `setDim(cloud.dim)`.
- La détection de changement `lastDensity` / `lastSkyHex` est **conservée** :
  on ne retouche pas chaque matériau à chaque frame. `lastDim` s'y ajoute sur le
  même modèle.
- `window.__sim` : `cloud` exposé en debug à côté de `fog` et `rain`, et le bloc
  d'état gagne couverture, base et altitude relative au plafond.

Piloter l'extinction par l'altitude de la **caméra** plutôt que par fragment est
une approximation. Elle est juste ici : entrer dans un nuage *est* un voile
uniforme, il n'y a pas de gradient à voir depuis l'intérieur. Et elle coûte zéro,
puisqu'elle réutilise le terme de densité qui est déjà poussé une fois par frame.

## Approches écartées

- **Ombres de nuages projetées** (bruit défilant échantillonné en (x, z) monde
  dans le fragment shader de tuile). Écartée par D0. C'était le « point dur »
  décrit dans l'issue ; il disparaît avec la décision.
- **Plan de nuages en géométrie** plutôt qu'analytique dans le shader du dôme.
  Géométriquement plus honnête quand on monte dedans, mais un plan a des bords :
  soit il est immense, soit on voit sa tranche à l'horizon. Il faut le fondre
  dans le dôme, gérer le tri alpha contre le brouillard, et payer une draw call
  de plus — pour le même résultat visuel.
- **Raymarch volumétrique.** Vraie densité 3D, vraie parallaxe, le plus beau. À
  FOV 120 on est déjà limité par le fill rate, et ce n'est pas le chantier où
  dépenser ça.
- **`three/examples/jsm/objects/Sky.js` (Preetham).** Physiquement plus juste et
  ça préparerait #23, mais il suppose du tone mapping et de la gestion de
  couleur — ici les deux sont désactivés (HANDOFF bug #10). Il faudrait le
  recalibrer à la main, ce qui annule l'avantage d'utiliser du code tout fait.

## Vérification

### Headless — `tools/selftest.mjs`

`cloud.js` étant pur, il part dans `selftest.mjs` à côté du bloc `fog`, écrit en
TDD (tests d'abord) :

- le ciel clair est **bit-identique** à l'absence de modèle : `dim === 1`
  exactement, `extinctionAt()` rend exactement 0 à toute altitude, aucun tirage
  aléatoire consommé, aucun filtre avancé (D5) ;
- la base **descend de façon monotone** quand la couverture monte ;
- la base « épars » (~30 %) est hors d'atteinte d'un vol normal, la base
  « couvert » (> 90 %) est atteignable (D1/D2) ;
- `extinctionAt()` est nulle loin sous la base, croît en approche, sature dans
  la couche ;
- `reset()` est déterministe : deux champs de même graine donnent la même
  trajectoire ;
- la respiration **ne biaise pas la moyenne** — la propriété de moyenne unité du
  lognormal, mesurée sur une longue série, comme `fog.js` et `rain.js` le font
  déjà (D3) ;
- le monde neutre `CALM` reste neutre bout en bout.

### En vol — navigateur

Le rendu ne se teste pas en headless. Vérification dans le navigateur
(chrome-devtools), et c'est là que se fait la calibration de D6 :

- pas de régression sur un monde neutre : la couleur d'**horizon** sort toujours
  `#9fb8cc` et l'image au sol est strictement inchangée (`dim === 1`). Le zénith
  est plus profond — c'est voulu, voir D5 ;
- la ligne d'horizon ne se dédouble pas — le fondu des tuiles et l'horizon du
  dôme se rejoignent (D4) ;
- les nuages dérivent dans le sens du vent et se déforment ;
- l'approche du plafond par overcast donne bien un whiteout, et le traverser
  débouche au-dessus de la couche ;
- **calibration de `DIM_MAX`** : la valeur la plus forte qui garde la
  photogrammétrie lisible en vol. Mesurée, notée, puis figée.

## Ce que cette spec ne fait pas

- Aucun soleil, aucune position solaire, aucun éblouissement — c'est #23, et D0
  établit que #22 ne l'attend pas.
- Aucune ombre portée avec motif — D0.
- Aucun changement à la physique du vol : le plafond change la **visibilité**,
  pas l'aérodynamique. Un éventuel effet du plafond sur l'air (inversion,
  turbulence sous la couche) serait une issue de suivi, pas celle-ci.
- Aucun réglage utilisateur. Le monde décide.
