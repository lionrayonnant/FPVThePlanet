# Soleil — position depuis lat/lon + heure, éblouissement, exposition

Spec de l'issue [#23](https://github.com/lionrayonnant/FPVTP/issues/23), volet
soleil de #19, couche de rendu rattachée à PHASE 04 (#41).

Date : 2026-08-29. Branche : `issue-23-soleil`.

---

## 1. La décision d'architecture, tranchée

L'imagerie est de la photogrammétrie **non éclairée** : l'ombrage est cuit dans
les textures (`src/TileMaterial.js:8-10`), la géométrie n'a pas d'attribut
`normal` (`src/loader.js:57-61`), et un soleil mobile double-ombrerait la ville
avec les ombres du survol d'Apple.

**On retient l'option (a) de l'issue**, confirmée par le propriétaire en
commentaire : *aucun ré-éclairage de la géométrie*. Le soleil n'existe que comme

1. une **direction** dans la scène,
2. une **couleur de ciel**,
3. un **événement optique dans la caméra** — éblouissement et exposition.

Ce qui reste explicitement hors périmètre :

- toute lumière Three.js (`DirectionalLight`, ambiante, hémisphérique),
  `scene.environment`, `renderer.shadowMap` ;
- tout calcul de normales ;
- toute dé-illumination de l'albédo dans `prep.mjs` ;
- l'affichage de la position du soleil au HUD ou au terminal (non retenu).

---

## 2. D'où vient l'heure

**De l'instant réel, et d'aucun fuseau horaire.**

La position du soleil est fonction de l'**instant UTC** et de la position
géodésique — rien d'autre. `Date.now()` fournit l'instant, `manifest.origin`
(lat/lon/altitude, déjà exact) fournit la position. Aucune base de fuseaux, aucun
réglage, aucun état persisté : c'est la même promesse que la météo de PHASE 04,
« le monde décide, on lit ».

Conséquence assumée : voler sur Tokyo un soir européen, c'est voler de nuit.
C'est le comportement correct, pas un défaut à corriger.

`dayKey()` de `tools/lib/weather.mjs` continue d'utiliser le jour civil **local**
du joueur pour le bulletin. Les deux horloges ne sont pas en conflit : l'une
date un bulletin, l'autre place un astre.

---

## 3. `src/sun.js` — le modèle, pur

Même règle et même raison que `wind.js`, `rain.js` et `fog.js` : **ni THREE, ni
DOM, ni `node:`**. C'est la moitié que `tools/selftest.mjs` peut vérifier sans
navigateur.

### 3.1 Position

Algorithme NOAA (Solar Position Calculator, dérivé de *Astronomical Algorithms*
de Meeus), précision annoncée meilleure que 0,02° sur la période qui nous
intéresse. Chaîne standard : jour julien → siècle julien → longitude moyenne →
anomalie moyenne → équation du centre → longitude vraie → longitude apparente →
obliquité corrigée → déclinaison + ascension droite → équation du temps → angle
horaire → élévation + azimut.

```js
sunPosition({ lat, lon, date = new Date() })
  -> { elevation, azimuth, declination, hourAngle }   // radians
```

- `azimuth` : **horaire depuis le nord**, convention de l'issue.
- `elevation` : **géométrique**, sans réfraction. La réfraction (~0,57° à
  l'horizon) est ajoutée séparément par `refracted()` — Bennett (1982) — parce
  que ce qui intéresse le rendu, c'est le soleil qu'on **voit** ; garder les deux
  sépare l'astronomie de l'optique atmosphérique.

### 3.2 Direction dans les axes du sim

Le piège que l'issue signale, et le seul endroit où on peut se tromper
silencieusement de demi-ciel. Après `prep.mjs` : **X = est, Y = haut, Z = sud**.

```js
sunVector(azimuth, elevation) -> { x: sinA·cosE, y: sinE, z: −cosA·cosE }
```

Vérification qui doit rester dans le selftest pour toujours : **au midi solaire
dans l'hémisphère nord, `z > 0`** (le soleil est au sud, et le sud est +Z).

### 3.3 Extinction atmosphérique — trois quantités mesurées

Rien ici n'est un chiffre choisi à l'œil ; c'est ce qui permet à la couleur du
ciel d'être *dérivée* plutôt que peinte.

**Masse d'air** — Kasten & Young (1989), qui reste fini à l'horizon là où
`1/sin h` diverge :

```
m(h) = 1 / (sin h + 0.50572 · (h_deg + 6.07995)^(−1.6364))
```

`h` est l'élévation **réfractée**. Sous l'horizon, `m` n'a plus de sens et le
modèle passe la main au crépuscule (§3.5).

**Épaisseur optique Rayleigh** — Hansen & Travis (1974), τ = 0,008735·λ^(−4,08)
au niveau de la mer, λ en µm. Sur les longueurs d'onde de nos trois canaux
(R 0,610 / G 0,550 / B 0,470 µm) :

| canal | λ (µm) | τ_R |
|---|---|---|
| R | 0,610 | 0,0673 |
| G | 0,550 | 0,0975 |
| B | 0,470 | 0,1852 |

**Aérosols** — et c'est ici que le couplage avec le brouillard demandé par
l'issue tombe tout seul, **sans constante inventée**. Le bulletin donne une
visibilité en mètres ; Koschmieder donne le coefficient d'extinction horizontal
à 550 nm, `k₅₅₀ = 3.912 / V`. Une hauteur d'échelle d'aérosol de 1,2 km (valeur
usuelle des atmosphères de référence) le convertit en épaisseur optique
verticale : `τ_a(550) = k₅₅₀ · H_a`, puis Ångström `τ_a(λ) = τ_a(550) ·
(λ/0,550)^(−α)` avec α = 1,3, l'exposant continental standard.

La visibilité passée est celle de l'**air hors pluie** — exactement la même
quantité que `toSimParams()` calcule déjà pour `fog.js`, pour que la même averse
ne compte pas deux fois.

Transmittance totale du disque, par canal :

```
T(λ) = exp(−(τ_R(λ) + τ_a(λ)) · m)
```

Elle rougit et s'éteint toute seule près de l'horizon : c'est la formule qui
fait le coucher de soleil, pas une rampe de couleur.

### 3.4 Couleur du ciel — deux facteurs, et rien d'autre

```
sky(λ) ∝ T(λ, m_soleil) · (1 − exp(−τ(λ) · m_vue))
```

- Le premier facteur : la lumière qui **atteint** le volume diffusant a déjà
  traversé l'atmosphère. C'est lui qui rend le ciel orange au ras de l'horizon.
- Le second : ce que ce volume **rediffuse** vers la caméra. C'est lui qui rend
  le ciel bleu à midi.

`m_vue = 1` : la caméra regarde majoritairement vers le haut du ciel, et la
scène n'a qu'**une** couleur de ciel à donner (§4). Le résultat est normalisé
pour que la luminance soit portée par l'élévation, pas par la normalisation.

Ce modèle mono-diffusion n'a **jamais** produit exactement `#9FB8CC`, la
couleur actuelle. Le calibrage est donc explicite et vérifié : la couleur rendue
pour un soleil haut, ciel clair, sans nuage, est ajustée par un unique gain
global pour retomber sur `#9FB8CC` ± 6 par canal. Un seul chiffre à l'œil, et
c'est celui qui garantit que **rien ne change visuellement dans les conditions
où le sim tournait déjà**.

**Nuages.** `cloudPct` tire la couleur vers un gris neutre et écrase le disque.
La relation n'est pas linéaire : un ciel couvert reste lumineux, il n'est plus
directionnel. Donc :

- couleur : mélange vers un gris d'overcast avec un poids `(cloudPct/100)^1.5` ;
- disque et éblouissement : atténués par `(1 − cloudPct/100)^2`, ce qui laisse un
  soleil encore perceptible à 40 % de couverture (`CLOUD`) et rigoureusement
  rien à 100 % (`OVERCAST`).

Les deux exposants sont à l'œil, et déclarés comme tels — comme `K1`/`K2` dans
`lens.js`.

### 3.5 Crépuscule et nuit

Sous l'horizon, la diffusion simple ne décrit plus rien (la lumière vient de
l'atmosphère haute, plusieurs fois diffusée). Le modèle passe donc la main à un
fondu, mais calé sur les **seuils crépusculaires réels** plutôt que sur des
paliers ronds :

| élévation | état |
|---|---|
| > 0° | jour, modèle §3.4 |
| 0° → −6° | crépuscule civil : le ciel perd sa luminance, garde son orangé |
| −6° → −12° | nautique : bascule vers le bleu profond |
| −12° → −18° | astronomique : arrivée au ciel de nuit |
| < −18° | nuit pleine, valeur plancher |

La nuit n'est pas noire : plancher à une luminance non nulle (ciel de nuit
urbain, bleu très sombre). L'imagerie étant photographiée en plein jour, une
ville rigoureusement noire serait à la fois fausse et injouable.

**Comment la ville s'assombrit, exactement.** Pas par un facteur « nuit » posé à
la main : par l'AGC de §3.6 qui **arrive en butée**. Une caméra FPV la nuit ne
rend pas une image correctement exposée, elle rend une image sombre parce que son
gain est saturé. C'est `E_max` qui produit la nuit, et c'est le comportement de
l'objet simulé — pas un réglage esthétique de plus.

### 3.6 Exposition — un AGC, pas un correcteur de gamma

Une caméra FPV a un gain automatique. Il est modélisé **côté CPU**, dans
`sun.js`, sans aucun readback GPU — donc déterministe et vérifiable au banc.

La luminance vue par le posemètre est estimée analytiquement :

```
L = L_ciel(état du ciel)  +  W_sun · sunInFrame
```

`sunInFrame` : 0..1, calculé par `main.js` depuis l'angle entre l'axe caméra et
la direction du soleil, multiplié par l'occlusion (§5.2). Le poids `W_sun` est
grand — un disque solaire pèse plus lourd dans une moyenne pondérée que tout le
reste du cadre, et c'est précisément ce qui fait fermer le diaphragme.

Gain visé : `E* = clamp(L_cible / L, E_min, E_max)`. Puis filtre du premier
ordre **asymétrique** :

```
τ = (E* < E) ? TAU_CLOSE : TAU_OPEN      // 0,15 s / 1,2 s
```

Les caméras ferment vite et rouvrent lentement. C'est cette asymétrie, et elle
seule, qui produit la mécanique que l'issue met en avant : **on passe face au
soleil, la ville s'éteint, et elle met une seconde à revenir.**

### 3.7 API

```js
export function sunPosition({ lat, lon, date })   // { elevation, azimuth, ... }
export function refracted(elevation)              // Bennett
export function airMass(elevationRefracted)
export function transmittance(m, visibilityM)     // { r, g, b }
export function skyColor(state)                   // { r, g, b } 0..1 linéaire
export function sunVector(azimuth, elevation)     // { x, y, z } axes sim

export class SunField {
  constructor({ lat, lon })
  setWeather({ cloudPct, visibilityM })   // écrit par weather.js, cf. §6
  update(dt, { date, sunInFrame })        // avance l'AGC
  // lu chaque frame par main.js :
  //   elevation, azimuth, dir {x,y,z}
  //   sky {r,g,b}, sunColor {r,g,b}, sunIntensity 0..1
  //   exposure    (gain multiplicatif)
  get active()   // false quand le soleil ne contribue rien au shader
}
```

`active` suit la logique de `FogField.active` et de `LINK_OFF` : quand il est
faux, le bloc soleil est **compilé hors du shader**.

Mais il est faux à une condition plus étroite qu'on ne le croit d'abord : le bloc
est un no-op quand `sunIntensity × occlusion == 0` **et** `exposure == 1`. La
nuit, `sunIntensity` est nul mais l'AGC est en butée, donc `exposure < 1` et le
bloc doit rester compilé — sinon la nuit ne s'assombrirait pas. `active` est donc
faux dans deux cas seulement : pas d'origine géodésique connue (§7), et le cas de
référence calibré — soleil haut, ciel clair, sans nuage, où `L_cible` est
justement choisi pour que le gain vaille exactement 1.

C'est ce couple de calibrages (§3.4 pour la couleur, `L_cible` pour le gain) qui
tient la promesse d'identité au bit près : **dans les conditions où le sim
tournait déjà, il rend exactement la même image.**

---

## 4. La couleur du ciel cesse d'être une constante

`SKY = 0x9fb8cc` (`main.js:35`) a aujourd'hui quatre consommateurs :

| consommateur | comment |
|---|---|
| `scene.background` | `main.js:76` |
| fog des tuiles | `loader.setFog(color, density)`, uniforme `uFogColor` |
| `Rainfall` | `new Rainfall(scene, { sky: SKY })` |
| `lens.js` | `uSky`, pour les gouttes et le voile de brouillard |

`SKY` devient la **valeur de départ**, et `main.js` pousse chaque frame la
couleur de `SunField` vers les quatre — un seul ciel, quatre lecteurs, aucune
duplication. `Rainfall` gagne un `setSky()` s'il n'en a pas.

Un ciel qui change de couleur à chaque frame ne doit pas faire recompiler ni
réallouer quoi que ce soit : ce sont des `THREE.Color` existants qu'on écrit en
place, comme `setFog()` le fait déjà pour la densité.

---

## 5. `src/lens.js` — le bloc `#if SUN`

Tout vit dans la **passe unique**, puisque `toneMapping` est volontairement à
`NoToneMapping` (`main.js:56`).

### 5.1 Ce que le bloc dessine

Dans l'ordre optique, et placé **avant le vignettage** (le vignettage est de la
géométrie de barillet ; l'éblouissement se produit dans le barillet) et donc
bien avant tout ce qui concerne le lien vidéo :

1. **Exposition** : `c *= uExposure`. Premier, parce que c'est le capteur.
2. **Voile plein cadre** : lumière parasite qui remonte les noirs quand le
   soleil est proche du champ ou dedans. Même argument que le voile de
   brouillard déjà présent : une photo prise vers le soleil n'a pas de noir.
3. **Halo** : lobe radial autour de la position écran du soleil.
4. **Disque** : petit, à bord doux, coloré par `sunColor`, saturé au blanc au
   centre quand le soleil est haut.

Rayon, étalement et force du halo sont **à l'œil**, exactement comme `K1`, `K2`,
`CA` et `GLARE_R` : il n'y a pas d'optique à mesurer ici. Ce qui n'est pas à
l'œil, c'est qu'ils sont tous pilotés par `sunIntensity`, qui descend de la
transmittance et de `cloudPct` — donc le voile ne peut jamais contredire le
régime météo affiché au joueur.

Pas de *ghosts* / images fantômes d'objectif dans cette passe. C'est du décor
supplémentaire, pas la mécanique de l'issue, et le bloc doit rester lisible.
Suivi séparément si le résultat en manque.

### 5.2 Occlusion — le soleil ne traverse pas la Tour Eiffel

Sans ça, le disque se dessine à travers les bâtiments et tout l'effet s'effondre.

Un rayon par frame depuis le drone vers le soleil, via
`physics.obstructionBetween()` — **la méthode existe déjà** (elle sert au lien
vidéo), aucune API nouvelle. Coût négligeable : la sonde de vent tire déjà dix
rayons à 20,8 Hz.

Le résultat est lissé par un premier ordre court (~80 ms) : un rayon unique
bascule 0/1 d'une frame à l'autre en frôlant une arête, et un disque solaire qui
clignote est pire que pas de disque du tout.

L'occlusion module le disque, le halo et le terme `sunInFrame` de l'AGC — un
soleil caché derrière un immeuble ne doit pas fermer l'exposition. Elle ne
module **pas** la couleur du ciel, qui est atmosphérique et non locale.

### 5.3 Nouveaux uniformes

`uSunPos` (vec3 : position écran xy dans l'espace carré de la passe, z = devant
/ derrière), `uSunColor` (vec3), `uSunAmount` (float, intensité × occlusion),
`uExposure` (float). Un seul `#define SUN`, basculé sur `SunField.active`,
recompilé **uniquement à la traversée** — la règle que `TAPS`, `LINK_MODE`,
`DROPS` et `GLARE` suivent déjà.

`setSun({ pos, color, amount, exposure })` sur `FpvLens`, dans le style de
`setRain()` et `setGlare()`.

---

## 6. `tools/lib/weather.mjs` — un bloc de plus, au seul endroit prévu

`toSimParams()` est le seul point où le monde parle aux modèles. Il gagne :

```js
sun: { cloudPct, visibilityM: airVis }
```

`airVis` est la visibilité **hors pluie** déjà calculée dans la fonction pour
`fog.js`, réutilisée telle quelle. `applyWeather()` gagne un `sun?.setWeather(p.sun)`
à côté des trois existants. `CALM` de `weather.js` gagne le bloc correspondant
(ciel dégagé, visibilité d'air clair).

Aucune autre modification du modèle météo : il n'apprend pas l'heure, il ne
produit pas de série horaire. Le soleil lit le bulletin du jour, comme les trois
autres.

---

## 7. `src/main.js` — le câblage

Une instance de `SunField` construite avec `manifest.origin.latitude/longitude`,
après `loadManifest()`. Pas d'origine connue ⇒ pas de `SunField` ⇒ le ciel reste
la constante et le bloc shader reste compilé dehors.

Par frame :

1. `sun.update(dt, { sunInFrame })` — `sunInFrame` depuis l'angle caméra/soleil
   et l'occlusion lissée ;
2. pousser `sun.sky` vers les quatre consommateurs (§4) ;
3. projeter `sun.dir` dans l'espace vue, puis dans l'espace de la passe ;
4. `lens.setSun(...)`.

`window.__sim.debug()` gagne un bloc `sun` : élévation, azimut, masse d'air,
exposition, occlusion, couleur du ciel. C'est ce qui permet de vérifier dans le
vrai navigateur au lieu de regarder une capture et d'y croire.

Le `dt` passé est **celui de l'appelant, déjà mis à zéro quand le sim est gelé** :
même règle et même piège que `setRain()`, qui n'a délibérément pas d'horloge à
lui (#24 y avait perdu du temps).

---

## 8. Vérification

### 8.1 `tools/selftest.mjs`, nouvelle section — écrite avant le code (TDD)

Les valeurs de référence sont **analytiquement dérivables**, pas des sorties du
code recopiées en attentes :

| ce qui est vérifié | attendu |
|---|---|
| élévation max au solstice d'été | `90° − \|lat − 23,44°\|`, à 0,3° près (Paris, Tokyo) |
| élévation max au solstice d'hiver | `90° − \|lat + 23,44°\|`, à 0,3° près |
| équinoxe, midi solaire | déclinaison ≈ 0°, élévation ≈ `90° − lat` |
| équinoxe, lever/coucher | azimut ≈ 90° / 270°, à 1,5° près |
| **convention d'axes** | midi solaire, hémisphère nord ⇒ `dir.z > 0` et `\|dir.x\|` petit |
| hémisphère sud | midi solaire ⇒ `dir.z < 0` |
| masse d'air | 1,00 au zénith ; ≈ 2 à 30° ; finie et < 40 à 0° |
| rougeur | `T_r/T_b` croît strictement quand l'élévation baisse |
| ciel | bleu à midi (`b > g > r`), et l'écart se réduit au ras de l'horizon |
| calibrage | soleil haut, ciel clair, 0 % de nuage ⇒ `#9FB8CC` ± 6 par canal |
| couplage brouillard | visibilité 500 m ⇒ `sunIntensity` très inférieur à 25 km |
| couplage nuages | `cloudPct = 100` ⇒ `sunIntensity == 0` |
| nuit | élévation < −18° ⇒ `sunIntensity == 0`, ciel au plancher, AGC en butée `E_max` |
| no-op | soleil haut + ciel clair + 0 % nuage ⇒ `exposure == 1` et `active == false` |
| AGC | fermeture ≈ 8× plus rapide que l'ouverture ; gain borné ; `dt = 0` fige |
| déterminisme | même instant + même zone ⇒ même état, au bit près |

### 8.2 Dans le vrai navigateur

`npm run dev`, chrome-devtools MCP, en lisant `window.__sim.debug().sun` — pas
une capture d'écran interprétée. Trois passages : soleil dans le champ (le
cadre se ferme, la ville revient en ~1 s), soleil derrière un bâtiment (le
disque disparaît, l'exposition ne bouge pas), jour `OVERCAST` (aucun disque, ciel
gris, éblouissement nul).

### 8.3 Non-régression

`npm run selftest` doit rester vert dans son intégralité — en particulier les
deux checks de texture, qui mesurent la couleur rendue et attraperaient un ciel
mal calibré.

---

## 9. Découpage

1. `src/sun.js` : position, réfraction, masse d'air, vecteur — et leurs checks.
2. `src/sun.js` : transmittance, couleur du ciel, calibrage, nuages, crépuscule.
3. `src/sun.js` : `SunField` et l'AGC.
4. `tools/lib/weather.mjs` + `src/weather.js` : le bloc `sun`.
5. `src/lens.js` : uniformes, `setSun()`, bloc `#if SUN`.
6. `src/main.js` : câblage, ciel dynamique vers les quatre consommateurs, debug.
7. Vérification navigateur, HANDOFF, README.

Chaque étape laisse `npm run selftest` vert.
