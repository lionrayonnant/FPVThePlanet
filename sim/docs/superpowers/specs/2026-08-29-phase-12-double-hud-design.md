# PHASE 12 — Double HUD (spec)

Issue : [#49](https://github.com/lionrayonnant/FPVThePlanet/issues/49)
Sources : `docs/FPVThePlanet! — Art Direction & Experience Bible.md` §43 ·
`docs/FPVThePlanet! — DA-UX Implementation Roadmap.md` PHASE 12

## Objectif

Deux systèmes d'affichage indépendants dans le même flux vidéo :

```text
DRONE CAMERA → DRONE OSD → VIDEO / LINK → FPVTP OSD → LENS
```

L'OSD drone appartient à la cible et traverse la liaison : il subit le bruit,
les macroblocs, le barillet et le vignettage. L'OSD FPVTP! est injecté
localement : il ne traverse rien.

Le chevauchement des deux couches est voulu. On ne construit **pas** un système
qui essaie de les séparer proprement.

### La phrase à obtenir du joueur

> « Ce drone est encore différent. »

Elle doit tomber dans la première seconde, avant même la première correction de
manche. C'est pour ça que la phase ne s'arrête pas à l'OSD : la **caméra** de la
cible en fait partie — son champ, son inclinaison, sa définition, son format et
sa qualité de capteur sont ce qui rend deux vols immédiatement différents. Un
OSD différent sur une image identique ne suffit pas.

## Ce que fait `src/hud.js` aujourd'hui

Un seul calque DOM, en français, qui mélange sans distinction :

| Coin | Contenu |
|---|---|
| tl | `alt` (m AGL), `spd` (km/h) |
| tr | `mode`, `preset`, `src`, `fps`, `rssi`, `wind-hud` |
| bl | barre de gaz, batterie (`volts`, `soc`, `amps`) |
| br | `help` (aide clavier) |
| centre | `crash`, `pause`, `session-status`, `reticle` |

Plus l'écran de chargement, qui n'est pas concerné par cette phase (PHASE 13 le
déplace derrière le TARGET SCAN).

Aucun de ces éléments n'est dans l'image : ils sont dessinés par le navigateur
au-dessus du canvas, donc rien ne peut les dégrader.

Et la caméra est aujourd'hui **la même pour tous les drones** : un
`PerspectiveCamera(120°)` unique dans `main.js`, avec FOV et uptilt réglés par
deux sliders du panneau Tab.

## Architecture

```text
TARGET CAMERA  ← tools/target-camera.mjs : champ, uptilt, format, définition, capteur
   ↓
RenderPass (scène), rendu à la définition et au format de la cible
   ↓  ← uOsd : texture du DRONE OSD, échantillonnée aux UV distordues
LensShader : barillet · aberration · flou · voile · gouttes
   ↓                    ↓ compositing de l'OSD drone ici
             vignettage · CAPTEUR · LIEN (bruit, cross-color, macroblocs, gel) · encadrement
   ↓
canvas
   ↓  ← FPVTP OSD : calque DOM au-dessus, jamais dégradé
```

| Unité | Rôle | Dépendances |
|---|---|---|
| `tools/target-camera.mjs` | **nouveau** — logique pure : famille + graine → fiche caméra | aucune |
| `tools/drone-osd-model.mjs` | **nouveau** — logique pure : cible → *layout* OSD | aucune |
| `src/drone-osd.js` | **nouveau** — peintre canvas 2D : layout + télémétrie → `CanvasTexture` | `three` (CanvasTexture) |
| `src/fpvtp-osd.js` | **nouveau** — calque DOM local, stable, en anglais | DOM |
| `src/lens.js` | échantillonne `uOsd`, encadre, ajoute les pannes analogiques | — |
| `src/main.js` | applique la fiche caméra ; plus de sliders | — |
| `src/settings.js` | les sliders FOV / uptilt **disparaissent** | — |
| `src/hud.js` | garde l'écran de chargement ; l'OSD de vol s'en va | — |

---

# 1. La caméra de la cible

## `tools/target-camera.mjs`

Logique pure, aucune dépendance, importable par le selftest et par le client —
même contrat que `tools/target-model.mjs`.

```js
export function targetCamera({ seed, family }) → {
  fovDeg,        // champ diagonal
  uptiltDeg,     // inclinaison, dans le repère du drone
  aspect,        // 4/3 ou 16/9
  resScale,      // définition interne, fraction de la fenêtre
  sensor: {
    grain,         // bruit de capteur permanent, même lien parfait
    lift,          // noirs levés
    saturation,    // fadeur
    ringing,       // halo de sur-accentuation sur les contours
    clip,          // écrasement des hautes lumières
    crossColor,    // 0 = part en gris · 1 = part en arc-en-ciel
    tint,          // dominante, en teinte
  },
}
```

**La famille pose le terrain, la graine tire dedans.** Deux `toothpick` n'ont
pas la même caméra, mais aucun `toothpick` n'a une bonne caméra.

| Famille | Caméra | FOV | Uptilt | Format | Définition |
|---|---|---|---|---|---|
| `cinewhoop` | bonne, propre, cadrée | 105–125° | 0–10° | 16:9 | haute |
| `heavy5` | bonne, cinéma | 100–120° | 0–15° | 16:9 | haute |
| `longrange` | bonne, plutôt serrée | 90–110° | 10–25° | 16:9 | haute |
| `freestyle5` | **ça dépend** — toute l'étendue | 100–150° | 15–35° | 4:3 ou 16:9 | tout |
| `race5` | bas de gamme rapide, très inclinée | 110–140° | 25–45° | 4:3 surtout | moyenne |
| `toothpick` | mauvaise, bruitée, délavée | 110–160° | 10–40° | 4:3 | basse |

C'est la table qui porte la cohérence demandée. Elle est en dur, commentée, et
c'est un endroit sûr pour régler le ressenti sans toucher au reste.

## Définition et format

Le rendu se fait vraiment plus bas et remonte : `resScale` dimensionne la cible
du composer, pas une texture de post-traitement. Une mauvaise caméra est
réellement moins définie — les branches d'un arbre ne sont plus des branches.
Effet secondaire honnête : elle coûte moins cher à rendre, exactement comme la
vraie.

Le format est **encadré de noir**, pas recadré : une caméra 4:3 sur un écran
16:9 laisse deux bandes noires sur les côtés. C'est laid, c'est vrai, et c'est
le marqueur le plus immédiat de « cette caméra est une bouse ». Le cadre est
tracé dans le pass lentille (au-delà du rectangle actif, noir), donc l'OSD
drone, le barillet et le vignettage vivent **dans** l'image et pas sur les
bandes. L'OSD FPVTP!, lui, est au-dessus de tout, bandes comprises.

`uAspect` dans le shader devient le format de la **caméra**, pas celui de la
fenêtre : c'est le capteur qui doit être radialement symétrique, pas le moniteur.

## FOV et uptilt

Ils viennent de la fiche et **les deux sliders du panneau Tab disparaissent**.
Le drone n'est pas le tien : son champ et son inclinaison sont ce qu'ils sont.
Un `race5` à 40° d'uptilt oblige à voler vite pour que l'horizon soit à sa
place — et c'est précisément le genre de contrainte qui fait qu'un drone se
souvient.

Conséquence à ne pas rater : `rainfall.setSize(..., camera.fov)` et
`camera.aspect` sont recalculés quand la fiche est appliquée, pas seulement au
redimensionnement.

## Le capteur, avant le lien

Nouveau bloc dans le shader, **entre le vignettage et le lien** — c'est
l'ordre physique : le capteur est en amont de l'émetteur.

- `grain` : bruit permanent, présent même sur un lien parfait. Une mauvaise
  caméra est bruitée dans son propre signal.
- `lift` + `saturation` : noirs levés, couleurs fades. Le rendu « délavé » d'un
  capteur bon marché.
- `clip` : les hautes lumières s'écrasent tôt. Un ciel qui part en blanc pur au
  lieu de garder ses nuages — le défaut le plus reconnaissable des petites
  caméras, et bien visible sur les images de référence.
- `ringing` : halo clair/sombre sur les contrastes forts. La sur-accentuation
  interne des caméras analogiques bon marché.
- `tint` : dominante légère. Deux caméras ne rendent pas le même vert.

## Les deux pannes analogiques

Aujourd'hui `lens.js` ne modélise **qu'une** panne : la désaturation, parce que
la sous-porteuse chroma est en haut de la bande vidéo et se fait manger la
première. C'est juste, mais incomplet — et c'est ce qui explique que tout
glitch actuel finisse en noir et blanc.

L'autre panne est le **cross-color** : le détail de luma fin (des branches, une
grille, un toit de tuiles) tombe dans la bande de la sous-porteuse et le
décodeur l'interprète comme de la couleur. D'où l'arc-en-ciel saturé sur les
zones détaillées — pas un bruit coloré uniforme, mais une couleur *tirée du
détail de l'image*.

Implémentation : passe-haut horizontal de la luma à l'échelle de la
sous-porteuse, injecté en chrominance avec une phase qui tourne. À zéro détail,
zéro couleur inventée — c'est ce qui distingue le cross-color d'un bruit RGB, et
c'est ce qui le rend crédible.

**`sensor.crossColor` arbitre entre les deux** : à 0 la caméra part en gris, à 1
elle part en arc-en-ciel. Chaque cible tombe quelque part sur cet axe, et deux
liens qui meurent ne meurent pas de la même façon.

---

# 2. L'OSD drone

## Pipeline

Un seul `sampler2D` de plus dans `LensShader`, composé après l'accumulation du
flou, après le voile et les gouttes, **avant** le vignettage, le capteur et le
lien.

- **Après le flou** parce que l'OSD est collé au capteur, pas au monde : il ne
  smeare pas quand la caméra tourne. Un OSD flouté par la rotation serait un
  OSD peint sur le décor.
- **Après les gouttes** parce que l'eau est sur le verre du drone et que l'issue
  ne demande que « le bruit, les macroblocs, le barillet, le vignettage » ; un
  OSD lavé par une goutte est illisible sans rien raconter de plus.
- **Avant le vignettage, le capteur et le lien** parce que c'est ce que l'issue
  demande, et parce que c'est ce qui fait que perdre le lien coûte de
  l'information.

Le barillet est gratuit : l'OSD est échantillonné à `uvHere`, la coordonnée déjà
distordue calculée pour la scène. Pas d'aberration chromatique dessus — une
seule coordonnée, pas trois : l'OSD est une incrustation monochrome.

Pas de pass supplémentaire, pas de draw call supplémentaire : un fetch de
texture. C'est ce que `lens.js` documente vouloir — les alternatives (scène
orthographique dans la cible du composer, `ShaderPass` dédié) coûtent
respectivement un changement d'état par image et un aller-retour plein écran.

Comme `uGlare` et `DROPS`, l'OSD est un `#define` : à zéro il est compilé hors
du shader. C'est le levier du A/B de mesure et le repli si la mesure est mauvaise.

> **Note de fidélité.** Sur du matériel réel, l'OSD est incrusté par le
> contrôleur de vol *après* le capteur, donc il ne subit pas l'optique. L'issue
> #49 et la Bible §43 tranchent l'inverse et la DA est validée : on implémente
> la chaîne demandée. Choix assumé, pas oubli.

## Gel numérique — la subtilité load-bearing

En mode DIGITAL, `lens.render()` saute le `RenderPass` sur une image perdue et
relit la dernière image de la scène. Si l'OSD était échantillonné depuis une
texture vivante, il afficherait des chiffres à jour par-dessus un monde figé —
l'inverse de ce que le lien raconte.

```js
osd.update(values)   // accumule l'état, ne dessine rien
osd.commit()         // redessine si un chiffre affiché a changé, needsUpdate
```

`lens.render()` n'appelle `commit()` que sur une image non gelée, au même
endroit qui décide `renderPass.enabled`. L'OSD gèle avec l'image parce qu'il a
traversé le même lien.

`commit()` ne repeint que si la chaîne rendue a changé : les valeurs sont
arrondies à l'affichage, donc quelques repeints par seconde, pas 60.

## Interface entre `main.js`, `lens.js` et `DroneOsd`

`FpvLens` reçoit l'OSD une fois (`setOsd(osd)`) et non à chaque image : c'est
lui qui sait quelle image est gelée, donc c'est lui qui tient la référence.
`main.js` appelle `droneOsd.update({...})` dans la boucle, à côté de l'appel HUD
actuel. `setOsd(null)` recompile le shader sans l'OSD : levier de mesure et repli.

Le canvas de l'OSD est dimensionné à la **grille de caractères** de la cible,
pas à la fenêtre — une incrustation vidéo est à résolution fixe. `setSize()` ne
le touche pas.

## `tools/drone-osd-model.mjs`

```js
export function droneOsdLayout({ seed, family, mode }) → {
  style,        // 'ANALOG' | 'DIGITAL'
  grid,         // { cols, rows } — 30×16 en analogique NTSC, 50×18 en HD
  font,         // 'DEFAULT' | 'BOLD' | 'LARGE' | 'CLARITY'
  units,        // 'METRIC' | 'IMPERIAL'
  craftName,    // bannière, ou null
  elements: [{ key, col, row }],
}
```

Graine FNV-1a + xorshift, la même géné que `target-model.mjs` et `src/link.js`.
Deux cibles différentes donnent deux OSD visiblement différents ; le même vol
rejoué donne le même OSD.

### Ce qui varie

**Le style** vient de `target.signal.mode` — c'est la cible qui est analogique
ou numérique, ça ne se tire pas. Cela rend enfin utile un champ aujourd'hui
stocké mais inerte (#74 reste ouverte pour le *rendu du lien*).

**La grille** change la taille apparente des caractères : un OSD 30×16 sur du
NTSC est énorme et mange l'image ; un 50×18 en HD est fin et discret. C'est,
visuellement, la différence la plus brutale entre deux drones.

**Les unités** : métrique ou impérial. Sur les images de référence, une caméra
affiche `1561F` et `9866F` — des pieds. Un joueur qui lit `43 MPH` puis
`134 km/h` au vol suivant sait immédiatement qu'il a changé de machine.

**La densité** : de 3 à 14 éléments. Un OSD peut être quasiment vide (deux
chiffres dans un coin) ou saturé au point de gêner. Les deux existent, et les
deux doivent apparaître.

**Le catalogue d'éléments**, tiré du vrai vocabulaire Betaflight / Walksnail :

```text
BAT_V  CELL_V  CURRENT  MAH  ALT  ALT_HOME  GS  VS  THR  RSSI  LQ  TX_POWER
SATS  LATLON  HOME_DIST  HOME_ARROW  TIMER_FLIGHT  TIMER_ON  HORIZON
CROSSHAIR  HEADING_TAPE  WARNINGS  CRAFT_NAME  ESC_TEMP  EFFICIENCY  VTX_CHAN
```

`BAT_V` et un chronomètre sont toujours là — un OSD sans tension ni temps
n'existe pas sur du vrai matériel. Le reste est tiré.

**Les capteurs absents suivent la famille, pas le hasard** : un `toothpick` n'a
pas de GPS, donc pas de `SATS`, pas de `HOME_DIST`, pas de `LATLON`, pas de
`GS`. Un `longrange` les a tous et les affiche. C'est la même cohérence que la
table des caméras : la famille pose le terrain, la graine tire dedans.

**Le placement** est une grille de caractères, pas huit ancrages : les vrais OSD
posent leurs éléments n'importe où, et c'est ce qui produit les dispositions
franchement bancales des images de référence. Contrainte : deux éléments ne se
recouvrent pas dans la grille. Rien n'empêche en revanche l'OSD drone de
recouvrir l'OSD FPVTP! — c'est même le sujet de la phase.

### Les deux styles

| | ANALOG | DIGITAL |
|---|---|---|
| grille | 30×16 (NTSC) ou 30×13 (PAL) | 50×18 ou 53×20 |
| couleur | blanc bordé de noir, comme un MAX7456 | blanc, ombre douce |
| densité | 3–8 éléments | 6–14 éléments |
| chiffres | entiers | une décimale |
| dégradation | subit tout le bloc analogique | macroblocs et gel |

---

# 3. L'OSD FPVTP!

Calque DOM au-dessus du canvas, en anglais, stable quoi qu'il arrive au lien :

```text
FPVTP! // 0.97b
OPERATOR // NEO
SESSION 18:42
WIND 2.4 m/s · VIS 14.2 km · LINK -63 dBm
```

plus `MODE` · `RATES` · `INPUT` · `FPS`, et les états `PAUSE`, `CRASH`, le
verdict de session et le réticule.

`0.97b` est une constante de lore exportée par `fpvtp-osd.js` — `package.json`
n'a pas de champ `version` et n'en aura pas pour ça.

Toutes les sources existent : `link.out.rssiDbm`, `rangeFor()` de `fog.js` pour
VIS, `physics.wind.out`, `operator.getOperator()`, `session.current()`.

Traitement CSS léger (vignettage très doux, teinte) pour qu'il ne flotte pas
au-dessus de l'image comme un overlay de navigateur — mais aucune distorsion,
aucun bruit, aucun gel : le critère « perdre le lien ne dégrade pas l'OSD
FPVTP! » est vrai par construction, pas par réglage.

Toujours en métrique, quelles que soient les unités de la cible : c'est **notre**
station. Le contraste entre un OSD drone en pieds et notre `VIS 14.2 km` fait
partie du propos — deux systèmes qui ne se sont pas mis d'accord.

`PHOTO READY` n'est pas affiché : il n'y a pas encore de photos (PHASE 16). Pas
d'affordance qui ment.

## Partage des champs

| Champ actuel | Devient |
|---|---|
| `alt`, `spd` | OSD drone (`ALT`, `GS`) |
| batterie `volts` / `amps` / `soc` | OSD drone (`BAT_V`, `CURRENT`, `MAH`) |
| barre de gaz | OSD drone (`THR`) |
| `mode`, `preset` | OSD FPVTP! (`MODE`, `RATES`) |
| `src` | OSD FPVTP! (`INPUT`) |
| `fps` | OSD FPVTP! (`FPS`) |
| `rssi` | OSD FPVTP! (`LINK -xx dBm`) |
| `wind-hud` | OSD FPVTP! (`WIND`) |
| `crash`, `pause`, `session-status`, `reticle` | OSD FPVTP! |
| `help` | **sort du vol** → panneau Tab |

La ligne de partage est « qui produit l'information » : la machine distante d'un
côté, notre station de l'autre. `MODE` et `RATES` restent côté FPVTP! parce que
c'est notre contrôleur qui tourne depuis le hack. Aucun chiffre n'apparaît des
deux côtés — perdre le lien doit coûter de l'information.

Nuance assumée : certaines cibles n'affichent pas `ALT`. Le joueur vole alors
sans altitude, et c'est une caractéristique de cette machine, pas un bug.

L'aide clavier quitte l'écran de vol pour le panneau Tab : plus rien
d'extra-diégétique en permanence à l'image.

---

# 4. Tests

`tools/selftest.mjs`, headless, sans DOM ni WebGL. Les deux modèles sont purs,
donc entièrement testables.

**`target-camera.mjs`**
- même graine → même fiche ;
- deux graines → deux fiches différentes ;
- pour chaque famille, 200 tirages restent dans les bornes de la table ;
- `cinewhoop`, `heavy5` et `longrange` ne produisent **jamais** une définition
  basse ; `toothpick` n'en produit **jamais** une haute (c'est la cohérence
  demandée, elle mérite un test, pas un commentaire) ;
- `aspect` ∈ {4/3, 16/9}, tous les champs `sensor` dans [0, 1].

**`drone-osd-model.mjs`**
- même graine → même layout ; deux cibles → deux layouts différents ;
- `ANALOG` et `DIGITAL` ne partagent aucune grille, et chaque style reste dans
  ses bornes de densité (3–8 et 6–14 : elles se chevauchent, l'affirmer disjoint
  serait faux) ;
- tous les `key` sont dans le catalogue, tous les placements dans la grille ;
- jamais deux éléments superposés ;
- `BAT_V` et un chronomètre toujours présents ;
- `toothpick` ne produit jamais un élément GPS ; `longrange` en produit ;
- sur 200 tirages, la variété est réelle : le nombre de layouts distincts et
  d'ensembles d'éléments distincts est au-dessus d'un plancher. C'est le seul
  test qui vérifie vraiment « ce drone est encore différent », donc il est écrit
  comme une mesure et pas comme une intention.

Le peintre canvas, le shader et le DOM ne sont pas testables en headless :
vérification navigateur à la main, sur au moins trois familles opposées
(`toothpick`, `cinewhoop`, `race5`), lien sain puis lien coupé.

---

# 5. Coût GPU

Mesuré, pas affirmé. Protocole : même scène, même trajectoire caméra scriptée,
définition fixe, N images ; temps d'image moyen et p95 dans quatre
configurations — sans OSD ni capteur, OSD seul, capteur seul, les deux. Les
chiffres partent dans `sim/HANDOFF.md`.

Attendu : l'OSD est un fetch de texture, le bloc capteur quelques opérations
scalaires, le cross-color une poignée de taps horizontaux — donc sous le bruit
de mesure. La définition réduite des mauvaises caméras *rend* du budget.

Si le surcoût est mesurable, on revient sur le compositing avant de continuer :
c'est ce que l'issue demande (« deux couches de plus ne doivent pas coûter des
images par seconde »).

---

# 6. Hors périmètre

- Le reste du panneau Tab reste en français : la passe d'anglais globale est
  PHASE 19. Issue de suivi à ouvrir.
- Le rendu du lien piloté par le mode vidéo de la cible : issue #74.
- L'écran de chargement : PHASE 13.
- `PHOTO READY` : PHASE 16.
- Aucun changement au moteur physique, au contrôleur ou au modèle d'air. La
  caméra ne touche pas au vol : `npm run selftest` reste vert.
