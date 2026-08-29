# PHASE 12 — Double HUD (spec)

Issue : [#49](https://github.com/lionrayonnant/FPVTP/issues/49)
Sources : `docs/FPVThePlanet! — Art Direction & Experience Bible.md` §43 ·
`docs/FPVThePlanet! — Roadmap d'implémentation DA - UX.md` PHASE 12

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

## Architecture

```text
RenderPass (scène)
   ↓  ← uOsd : texture du DRONE OSD, échantillonnée aux UV distordues
LensShader : barillet · aberration · flou · voile · gouttes
   ↓                    ↓ compositing de l'OSD drone ici
             vignettage · LIEN (bruit, macroblocs, gel)
   ↓
canvas
   ↓  ← FPVTP OSD : calque DOM au-dessus, jamais dégradé
```

Trois unités nouvelles, une modifiée, une démontée :

| Unité | Rôle | Dépendances |
|---|---|---|
| `tools/drone-osd-model.mjs` | logique pure : cible → *layout* (style, champs, slots) | aucune |
| `src/drone-osd.js` | peintre canvas 2D : layout + télémétrie → `CanvasTexture` | `three` (CanvasTexture seulement) |
| `src/fpvtp-osd.js` | calque DOM local, stable, en anglais | DOM |
| `src/lens.js` | échantillonne `uOsd` dans le pass existant | — |
| `src/hud.js` | garde l'écran de chargement ; l'OSD de vol s'en va | — |

### Pourquoi un `sampler2D` dans le pass existant

`lens.js` documente explicitement son choix d'un pass unique : les effets de
lentille partagent une cause et sont tous fonction du rayon, donc c'est une
seule décision d'échantillonnage, pas quatre — et une chaîne de `ShaderPass`
coûterait un aller-retour lecture/écriture plein écran par maillon. Compositer
l'OSD drone dans ce pass respecte cet argument : **un fetch de texture, aucun
pass supplémentaire, aucun draw call supplémentaire.**

Les deux alternatives écartées : une scène orthographique rendue dans la cible
du composer (un draw call et un changement d'état de plus par image, et le
`RenderPass` gelé en mode digital devient délicat) ; un `ShaderPass` dédié
(exactement l'aller-retour plein écran que le fichier dit vouloir éviter).

### Où exactement, dans le shader

Après l'accumulation du flou, après le voile et les gouttes, **avant** la ligne
du vignettage et avant les blocs `LINK_MODE`.

- **Après le flou** parce que l'OSD est collé au capteur, pas au monde : il ne
  smeare pas quand la caméra tourne. Un OSD flouté par la rotation serait un
  OSD peint sur le décor.
- **Après les gouttes** parce que l'eau est sur le verre du drone et que
  l'issue ne demande que « le bruit, les macroblocs, le barillet, le
  vignettage » ; et parce qu'un OSD lavé par une goutte est illisible sans rien
  raconter de plus.
- **Avant le vignettage et le lien** parce que c'est ce que l'issue demande
  explicitement.

Le barillet est obtenu gratuitement : l'OSD est échantillonné à `uvHere`, la
coordonnée déjà distordue que le shader calcule pour la scène. Pas d'aberration
chromatique sur l'OSD (une seule coordonnée, pas trois) — l'OSD est une
incrustation monochrome, la séparation par canal n'aurait pas de sens.

> **Note de fidélité.** Sur du matériel réel, l'OSD est incrusté par le
> contrôleur de vol *après* le capteur, donc il ne subit pas l'optique. L'issue
> #49 et la Bible §43 tranchent l'inverse et la DA est validée : on implémente
> la chaîne demandée. C'est un choix de direction artistique assumé, pas un
> oubli.

Comme `uGlare` et `DROPS`, l'OSD est un `#define` : à zéro il est compilé hors
du shader. C'est ce qui donne le A/B de mesure du coût GPU, et c'est ce qui
garantit qu'un joueur sans OSD drone ne paie rien.

### Gel numérique — la subtilité load-bearing

En mode DIGITAL, `lens.render()` saute le `RenderPass` sur une image perdue et
laisse le pass lentille relire la dernière image de la scène. Si l'OSD drone
était échantillonné depuis une texture vivante, il continuerait à afficher des
chiffres à jour par-dessus un monde figé — l'inverse exact de ce que le lien
raconte.

Donc `DroneOsd` sépare deux choses :

```js
osd.update(values)   // accumule l'état à afficher, ne dessine rien
osd.commit()         // redessine le canvas si un chiffre affiché a changé,
                     // et marque la texture needsUpdate
```

et **`lens.render()` n'appelle `commit()` que sur une image non gelée**, au même
endroit qui décide `renderPass.enabled`. L'OSD gèle avec l'image parce qu'il a
traversé le même lien.

`commit()` ne redessine que si la chaîne rendue a changé : les valeurs sont
arrondies à l'affichage, donc le canvas est repeint quelques fois par seconde,
pas 60.

### Interface entre `main.js`, `lens.js` et `DroneOsd`

`FpvLens` reçoit l'OSD une fois, à la construction ou par un `setOsd(osd)`, et
non à chaque image : c'est lui qui décide quand `commit()` a le droit de
tourner, donc il doit en tenir la référence. `main.js` ne fait qu'appeler
`droneOsd.update({...})` dans la boucle, à côté de l'appel HUD actuel.
`setOsd(null)` recompile le shader sans l'OSD — c'est le levier du A/B de
mesure et le repli si la mesure est mauvaise.

Le canvas est dimensionné une fois par `DroneOsd` (taille fixe, indépendante de
la fenêtre : un OSD est une incrustation à résolution fixe sur un flux vidéo,
pas un élément d'interface qui suit le DPI). `FpvLens.setSize()` ne le touche
pas.

## `tools/drone-osd-model.mjs`

Logique pure, aucune dépendance, importable par le selftest, le client (via le
bundle Vite) et un futur usage serveur — même contrat que `tools/target-model.mjs`.

```js
export function droneOsdLayout({ seed, family, mode }) → {
  style: 'ANALOG' | 'DIGITAL',
  fields: [{ key, slot }],   // key ∈ FIELDS, slot ∈ SLOTS
}
```

- **Graine** : FNV-1a puis xorshift, la même géné que `target-model.mjs` et
  `src/link.js`. Deux cibles différentes donnent deux OSD visiblement
  différents ; le même vol rejoué donne le même OSD.
- **`style`** vient de `mode` (`target.signal.mode`), pas d'un tirage : c'est la
  cible qui est analogique ou numérique. Cela rend enfin utile un champ
  aujourd'hui stocké mais inerte — l'issue #74 reste ouverte pour le *rendu du
  lien*, qui est un autre sujet.
- **`fields`** : sous-ensemble tiré parmi `BAT ALT SPD THR GPS TIME`, avec
  `BAT` et `ALT` toujours présents (un OSD sans tension ni altitude n'existe
  pas sur du vrai matériel). Densité tirée : un OSD peut être riche ou presque
  vide.
- **`slots`** : les huit ancrages canoniques d'un OSD Betaflight (`TL TC TR ML
  MR BL BC BR`). Un champ par slot, pas deux.
- Sans cible (mode dev, `?scene=`), repli sur une graine dérivée de la famille
  du profil : il y a toujours un OSD.

### Les deux styles

| | ANALOG | DIGITAL |
|---|---|---|
| police | grille de caractères, grasse | plus fine |
| couleur | blanc bordé de noir (contour, comme un MAX7456) | blanc, ombre douce |
| densité | 2–4 champs | 4–6 champs |
| unités | entiers | une décimale |

## `src/fpvtp-osd.js`

Calque DOM au-dessus du canvas, en anglais, stable quoi qu'il arrive au lien :

```text
FPVTP! // 0.97b
OPERATOR // NEO
SESSION 18:42
WIND 2.4 m/s · VIS 14.2 km · LINK -63 dBm
```

`0.97b` est une constante de lore exportée par `fpvtp-osd.js` — `package.json`
n'a pas de champ `version` et n'en aura pas pour ça.

plus `MODE` · `RATES` · `INPUT` · `FPS`, et les états `PAUSE`, `CRASH`, le
verdict de session et le réticule.

Toutes les sources existent déjà : `link.out.rssiDbm`, `rangeFor()` de
`fog.js` pour VIS, `physics.wind.out`, `operator.getOperator()`,
`session.current()` pour l'horloge de session.

Traitement CSS léger (vignettage très doux, teinte) pour qu'il ne flotte pas
au-dessus de l'image comme un overlay de navigateur — mais aucune distorsion,
aucun bruit, aucun gel : le critère d'acceptation « perdre le lien ne dégrade
pas l'OSD FPVTP! » est alors vrai par construction, pas par réglage.

`PHOTO READY` n'est pas affiché : il n'y a pas encore de photos (PHASE 16). Pas
d'affordance qui ment.

## Partage des champs

| Champ actuel | Devient |
|---|---|
| `alt`, `spd` | OSD drone (`ALT`, `SPD`) |
| batterie `volts` / `amps` / `soc` | OSD drone (`BAT`) |
| barre de gaz | OSD drone (`THR`) |
| — | OSD drone (`GPS`, `TIME`) — nouveaux, tirés |
| `mode`, `preset` | OSD FPVTP! (`MODE`, `RATES`) |
| `src` | OSD FPVTP! (`INPUT`) |
| `fps` | OSD FPVTP! (`FPS`) |
| `rssi` | OSD FPVTP! (`LINK -xx dBm`) |
| `wind-hud` | OSD FPVTP! (`WIND`) |
| `crash`, `pause`, `session-status`, `reticle` | OSD FPVTP! |
| `help` | **sort du vol** → panneau Tab |

La ligne de partage est « qui produit l'information » : la machine distante d'un
côté, notre station de l'autre. `MODE` et `RATES` restent côté FPVTP! parce que
c'est notre contrôleur qui tourne depuis le hack. Aucun chiffre n'apparaît dans
les deux couches — perdre le lien doit coûter de l'information.

L'aide clavier quitte l'écran de vol et déménage dans le panneau Tab, qui existe
déjà : plus rien d'extra-diégétique en permanence à l'image.

## Tests

`tools/selftest.mjs`, section « double HUD », headless, sans DOM ni WebGL :

- même graine → même layout (déterminisme) ;
- deux cibles différentes → deux layouts différents (critère d'acceptation) ;
- `mode: 'ANALOG'` et `mode: 'DIGITAL'` donnent bien deux styles ;
- tous les `key` sont dans `FIELDS`, tous les `slot` dans `SLOTS` ;
- jamais deux champs dans le même slot ;
- `BAT` et `ALT` toujours présents ;
- la densité reste dans les bornes du style ;
- sans cible, le repli produit un layout valide.

Le peintre canvas, le shader et le DOM ne sont pas testés en headless — c'est de
la vérification navigateur, à faire à la main sur deux cibles différentes et en
coupant le lien.

## Coût GPU

Mesuré, pas affirmé. Protocole : même scène, même trajectoire caméra scriptée,
résolution fixe, N images ; temps d'image moyen et p95 avec l'OSD compilé dans
le shader puis compilé dehors (le `#define`). Le chiffre part dans
`sim/HANDOFF.md`.

Attendu : un fetch de texture par pixel, soit largement sous le bruit de mesure.
Si le surcoût est mesurable, on revient sur le compositing avant de continuer —
c'est ce que l'issue demande (« deux couches de plus ne doivent pas coûter des
images par seconde »).

## Hors périmètre

- Le reste du panneau Tab reste en français : la passe d'anglais globale est
  PHASE 19. Issue de suivi à ouvrir.
- Le rendu du lien piloté par le mode vidéo de la cible : issue #74.
- L'écran de chargement : PHASE 13.
- `PHOTO READY` : PHASE 16.
- Aucun changement au moteur physique, au contrôleur ou au modèle d'air.
  `npm run selftest` reste vert.
