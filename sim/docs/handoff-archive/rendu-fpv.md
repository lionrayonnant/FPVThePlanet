# Rendu FPV : optique et lien vidéo — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> La passe lens.js (barillet, aberration, flou de mouvement), le lien vidéo RSSI par raycast, et la recalibration du lien.
> Pour retrouver une section : `grep -n "^#" rendu-fpv.md`.

## Rendu FPV : l'optique de l'objectif (ajouté 2026-08-27)

`src/lens.js`, une seule passe plein écran entre la scène et l'écran. Barillet,
aberration chromatique latérale, mollesse des bords, vignettage et flou de
mouvement, tous ensemble. Ferme #10, moins la partie « dégradation du lien
vidéo », partie depuis dans #12 et faite (section plus bas).

Une passe et pas quatre : les quatre effets d'objectif ont la même cause
physique et s'expriment tous comme une fonction du rayon depuis le centre de
l'image. C'est **une** décision d'échantillonnage, pas quatre. Une chaîne de
quatre `ShaderPass` paierait quatre allers-retours plein écran pour les mêmes
pixels.

### Le flou de mouvement n'a pas besoin de la profondeur

C'est le point qui rendait l'issue plus facile qu'elle n'en avait l'air. Le
monde est statique et la caméra est le seul objet qui bouge, donc le flou de
rotation — le seul qui compte à 800 °/s — se reconstruit **exactement** en
reprojetant les rayons de vue à travers la rotation faite pendant la pose. Aucun
tampon de profondeur, donc la contrainte `camera.near = 0,15` ne s'applique
même pas. Ce que l'approximation laisse tomber, c'est la parallaxe de
translation.

La rotation est prise sur la pose de la caméra (`q_prev⁻¹ · q_cur`, slerpée vers
l'identité par `obturation/dt`) et non sur `physics.angularVelocity` : ça marche
aussi en caméra libre, où le pas de physique est sauté. Vérifié : pas de NaN
dans `uReproj` après un passage en `C`.

### Le barillet ne demande aucun survol de champ

Le plan prévoyait d'élargir `camera.fov` pour éviter des coins noirs. Inutile :
il suffit de **normaliser le barillet au coin**, `q · (1 + k1r² + k2r⁴) / (1 + k1
+ k2)`. Le coin échantillonne alors exactement le coin rendu, tout le champ
survit à la déformation, et rien ne sort de l'image. Ce que la distorsion coûte
réellement, ce n'est pas du champ, c'est un grossissement du centre — ×1,26 au
réglage par défaut. `camera.fov` n'est pas touché, donc le curseur FOV garde son
sens et la culling reste juste.

### Ce qui a été mesuré plutôt que choisi

Fenêtre 2560×1265, RX 9060 XT, scène Tour Eiffel, `readPixels` synchrone comme
pour les mesures précédentes :

| | ms/frame |
|---|---|
| sans la passe (référence) | 1,17 |
| passe complète, 16 taps | 2,31 |
| passe à 1 tap (objectif à 0, obturation à 0) | 1,84 |

La passe coûte **1,14 ms** sur un budget de 10 ms. Deux choses que la mesure
contredit :

- **Couper le flou de mouvement ne récupère presque rien.** Les 15 taps
  supplémentaires coûtent 0,47 ms ; le reste (0,67 ms) est la passe elle-même
  plus la résolution MSAA, et se paie que le flou soit actif ou non. L'issue le
  désignait comme « le premier candidat à couper si les images chutent » —
  c'est le mauvais levier, le vrai serait de couper la passe entière.
- **8 taps ne suffisaient pas.** Un roulis à 800 °/s étale le coin sur ~160 px ;
  8 échantillons là-dedans laissent 20 px de trou et donnent des stries, pas du
  flou (capture faite, c'était net). 16 taps plus un dither par pixel
  transforment le reste en grain — ce qui, sur un retour vidéo, est la bonne
  erreur à faire.

`k1 = 0,30`, `k2 = 0,10`, aberration 0,006, mollesse 0,0035 uv et vignettage
0,55 à pleine échelle sont **choisis à l'œil**, pas mesurés sur une vraie
optique. Les valeurs par défaut (objectif 60 %, vignettage 50 %, obturation
8 ms = 1/125 s) le sont aussi.

### Vérifications navigateur (chrome-devtools MCP, scène Tour Eiffel)

- **Couleur.** Un pixel de ciel ressort à `#9fb8cc` exactement avec la passe en
  mode neutre, comme sans la passe. Depuis #21 cette valeur est celle de l'air
  clair, c'est-à-dire du curseur brouillard à zéro — qui reste le défaut.
  C'était la régression à ne pas rouvrir : la
  cible de rendu est en `UnsignedByteType` + `LinearSRGBColorSpace` et il n'y a
  **pas** d'`OutputPass` — voir bug #10 plus bas.
- **Antialiasing.** La cible est construite avec `samples: 4`. Rendre hors écran
  contourne le `antialias: true` du renderer, et les arêtes de toit crénelées
  qui en résultent se lisent comme un bug de shader alors que c'est une cible
  mal déclarée.
- **Barillet.** Capture avant/après sur l'horizon et le fût de la Tour : la
  ligne se courbe, les coins restent remplis, le contenu des coins est le même.
- **Flou.** Roulis de 800 °/s tenu sur deux frames : traînée en arc autour de
  l'axe de roulis, centre lisible, bords étalés.
- **Panneau `Tab`.** Case maîtresse coupe la passe et grise les trois curseurs ;
  les quatre réglages reviennent après rechargement.
- `__sim.debug()` : 6 draw calls (5 scène + 1 quad), 3 742 192 triangles.

### Dette connue

- `renderer.info.autoReset` est passé à `false` et `lens.render()` fait le reset
  une fois par frame. Sans ça, `info` ne décrivait plus que le quad plein écran
  (1 draw call, 1 triangle) parce qu'il se remet à zéro à chaque appel de
  `render()` et qu'il y en a deux maintenant. Tout code futur qui appelle
  `renderer.render()` hors de `lens.render()` faussera les compteurs.
- Le flou ignore la translation. À 25 m/s le long d'une façade proche, la
  parallaxe devrait baver et ne bave pas. **Non vérifié** que ça se voie en vol.
- Les coefficients d'objectif ne correspondent à aucune caméra réelle mesurée.
  Un vrai calibrage (mire, `k1`/`k2` ajustés sur une Runcam ou une DJI O3)
  serait l'étape suivante si le rendu paraît faux.

## Rendu du lien vidéo : RSSI par raycast (ajouté 2026-08-27)

Ferme #12, la moitié de #10 qui avait été mise de côté. Trois fichiers, une
direction de dépendance : `src/physics.js` mesure la géométrie, `src/link.js`
en fait des dB (aucune dépendance : ni Rapier, ni three, ni DOM — donc testable
dans `tools/selftest.mjs`), `src/lens.js` en fait une image. Arbitrage tranché
avec l'utilisateur : **les deux rendus**, analogique et numérique, au choix dans
`Tab`, et un curseur de sévérité réglé par défaut sur « rupture possible ».

### Un seul rayon ne suffisait pas, et deux non plus

Le plan disait « deux raycasts, un depuis chaque bout, l'écart est l'épaisseur
de matière ». C'est juste, et ça a quand même échoué à la première mesure : un
tir vers un point **sous le sol** rendait une épaisseur de **zéro**. Le maillage
de collision est une soupe de surfaces, pas un solide — le terrain est une
feuille unique, avec une face avant et aucune face arrière. Sa profondeur est
donc honnêtement nulle, alors même qu'il bloque tout.

D'où la forme finale : `obstructionBetween()` rend `{ blocked, span }` et pas un
seul nombre. Un immeuble a bien deux murs et rend sa vraie profondeur ; une
crête ou un toit fin rendent `blocked: true, span: 0`. Côté modèle, `blocked`
paie un terme fixe de **12 dB** — la diffraction par l'arête, qui est le vrai
mécanisme physique quand le signal contourne un obstacle sans épaisseur — et
`span` paie 8 dB/m par-dessus. Sans ce terme, voler derrière une colline
n'aurait rien coûté.

### Le gel d'image, et le piège du swapBuffers

En mode numérique, une trame sautée se fait en **ne rendant pas la scène** :
`renderPass.enabled = false`, et la passe d'objectif relit la dernière image
dans le `readBuffer` du composer. Une frame gelée coûte donc *moins* qu'une
frame normale (0,59 ms contre 1,42), ce qui est aussi vrai du vrai matériel.

Sauf que `RenderPass` écrit dans le `readBuffer` sans échanger, mais le
`ShaderPass` final a `needsSwap = true` et `EffectComposer.render()` échange
même après la dernière passe. Le `readBuffer` alterne donc d'une frame sur
l'autre, et un gel naïf rejoue l'**avant**-dernière image. Mesuré, pas déduit :

| | image tenue |
|---|---|
| `needsSwap = true` (trois.js par défaut) | l'avant-dernière |
| `needsSwap = false` (ce qu'on fait) | la dernière |

La passe finale rend à l'écran et personne ne consomme son `writeBuffer`, donc
la mettre à `false` est sans effet de bord. **Toute passe ajoutée après elle
casserait ça.**

### Le bruit analogique par ligne shredde l'image

Première version : un décalage horizontal aléatoire et indépendant par ligne.
Capture faite à qualité 0,5 — l'image était illisible, réduite en confettis,
alors que 0,5 doit être « bruité mais parfaitement volable ». La gigue de
synchro réelle est **corrélée** d'une ligne à l'autre : l'oscillateur ligne
dérive, il ne se retire pas aux dés à chaque ligne. La version qui marche est
une ondulation lente que toute l'image partage (±0,0022 uv) plus environ un
pixel de bruit réellement par ligne, les déchirures franches étant réservées à
`uLink < 0,5`.

### Ce qui a été mesuré

Fenêtre 2560×1265, RX 9060 XT, Tour Eiffel, `readPixels` synchrone, cinq
tournées entrelacées, médiane :

| | ms/frame | delta |
|---|---|---|
| sans la passe (référence) | 1,41 | — |
| passe, lien coupé (`LINK_MODE 0`) | 2,28 | +0,87 |
| passe + analogique, lien parfait | 2,40 | +0,99 |
| passe + analogique, q=0,50 | 2,35 | +0,95 |
| passe + numérique, lien parfait | 2,29 | +0,88 |
| passe + numérique, q=0,30 | 2,29 | +0,88 |
| passe + numérique, image gelée | 0,60 | −0,80 |

Le lien coûte donc **au plus 0,12 ms**, entièrement dus aux quatre taps de
chrominance de l'aspect analogique de base ; le numérique est gratuit. Les
raycasts : 0,0018 ms en vue dégagée, 0,016 ms au pire à travers 125 m de ville
— six fois un `groundBelow()`, que la boucle de rendu payait déjà chaque frame.
**Aucune cadence réduite n'était nécessaire** ; le `_aglEvery` prévu dans le
plan n'existe pas.

### Vérifications navigateur

- **Couleur.** Un pixel de ciel ressort à `#9fb8cc` *exactement* sans la passe,
  avec la passe et lien coupé, à sévérité 0, et en **numérique** à qualité 1.
  Depuis #21, à condition que le curseur brouillard soit à zéro — son défaut.
  C'est la régression de #10 à ne pas rouvrir. L'**analogique** à qualité 1 rend
  `#95acbe` — délibérément, c'est l'image lavée — et à sévérité 0,5 rend
  `#9cb4c7`, exactement le milieu, donc le curseur est bien linéaire.
- **Gel.** Tient la dernière image, la tient encore sur une deuxième frame
  gelée, reprend en direct ensuite. Test fait obturation fermée : avec le flou
  de mouvement, une même pose ne rend pas deux fois le même pixel et la
  comparaison ne veut rien dire.
- **Comportement.** 149 m au-dessus du pilote : 100 %. Coin de la tuile à 884 m
  en vue directe : 62 %. Un immeuble : ~50 %. 300 m au niveau de la rue avec
  125 m de ville en travers : 0 %.
- **Panneau `Tab`.** Section « Lien vidéo » ; le sélecteur bascule bien le
  `#define`, le curseur à 0 compile l'effet hors du shader, la case maîtresse
  « Rendu FPV » grise les deux, et les deux clés survivent au rechargement. Le
  balayage `fpvmaps.` du bouton de réinitialisation les couvre déjà.
- Aucun message d'erreur ni d'avertissement en console.

## Lien vidéo : la première calibration était injouable (corrigé 2026-08-27)

Le premier jet passait les tests et rendait le sim désagréable. Retour de
l'utilisateur, avec des captures de vrais retours analogique et numérique à
l'appui : « trop fort et injouable » par défaut, et « on a rien et d'un coup
pouf c'est brouillé ». Les deux critiques portaient sur des choses différentes
et les deux étaient justes.

### L'analogique n'a pas seulement un mode dégradé, il a un aspect

C'est la moitié qui manquait, et aucun test ne pouvait l'attraper : le premier
jet partait d'une image *parfaite* et y ajoutait du bruit quand le lien
faiblissait. Un vrai retour composite est mou, lavé et bavé en couleur **dès la
première trame** — la bande passante de chrominance vaut une fraction de celle
de luminance, donc la couleur déborde latéralement pendant que les contours
restent nets. Sans cette base, le mode analogique à plein signal était
littéralement identique au mode numérique, ce qui vide de son sens le choix
entre les deux.

Quatre taps horizontaux, hors de la boucle principale : c'est une propriété du
signal, pas de l'objectif, donc ça n'a rien à faire sur le motif
d'échantillonnage de l'objectif. Piège rencontré : quatre taps régulièrement
espacés sur 25 px forment un **peigne**, pas un flou, et sur une arête de
chrominance franche comme la Tour Eiffel contre le ciel ce peigne se lit comme
une image dédoublée. Corrigé avec le même `dither` par pixel que la boucle de
taps — exactement le remède déjà employé pour le banding du flou de mouvement.

### Le « pouf » venait du modèle, pas du shader

`8 dB/m` linéaire était la cause unique et suffisante : contourner un angle
fait passer l'épaisseur de 0 à 10+ m d'une frame à l'autre, soit **80 dB en une
marche**. Tout immeuble tuait le lien instantanément, quelle que soit sa
distance ou sa finesse. Trois changements, tous dans `link.js` :

| | avant | après |
|---|---|---|
| profondeur | 8 dB/m linéaire, plafond 60 | saturante, 38 dB d'asymptote sur 14 m |
| plage du fondu | 26 → 60 dB (34 de large) | 18 → 76 dB (58 de large) |
| constantes de temps | 0,05 s / 0,35 s | 0,30 s / 0,70 s |

La saturation fait payer l'essentiel par les premiers mètres, ce qui est aussi
plus juste : après un mur le signal est déjà dans le bruit, et le neuvième mur
ne peut plus enlever grand-chose que le deuxième n'ait déjà pris. Le fondu large
absorbe les marches que la géométrie fournit forcément. Et les constantes de
temps sont la seule chose qui sépare un fondu d'un interrupteur, puisque la
géométrie, elle, est binaire.

Résultat mesuré : contourner un angle prend **783 ms** avec un changement
maximal de **0,025 par frame** (contre trois frames avant), et la distance seule
donne une échelle continue 1,00 → 0,90 → 0,80 → 0,73 → 0,69 → 0,66 → 0,64.

Le fondu commence aussi **plus tôt** (18 dB, soit ~80 m) : il y a alors toujours
un peu de dégradation à lire, qui glisse pendant tout le vol, au lieu d'une
image parfaite jusqu'à la seconde où il n'y a plus rien. C'est ça qui rend le
lien lisible — on est prévenu qu'on manque de marge avant d'en manquer.

### Ce que les tests ne voyaient pas, et le voient maintenant

Les 11 vérifications d'origine passaient toutes sur la calibration injouable :
elles décrivaient les propriétés du modèle sans jamais décrire son **allure**.
Cinq ajouts, dont **trois échouent** sur l'ancienne calibration (vérifié en la
remettant en place, pas supposé) :

| vérification | ancienne | nouvelle |
|---|---|---|
| un immeuble dégrade sans tuer (0,25 < q < 0,75) | **0,00** | 0,49 |
| contourner un angle est un glissement (< 0,06 par frame) | **0,358** | 0,025 |
| la transition dure assez pour être lue (> 12 frames) | **2 frames** | 47 frames |
| effleurer une arête coûte moins que passer derrière | 0,88 vs 0,00 | 0,86 vs 0,49 |
| la qualité glisse continûment avec la distance | passe | passe |

Les deux dernières passaient déjà, et c'est cohérent : la falaise était
entièrement dans le terme d'occlusion, jamais dans celui de distance. Il faut
donc lire ce tableau comme disant que **trois** de ces tests auraient attrapé le
problème et que deux ne pouvaient pas.

Et le test « un immeuble coûte bien plus que la distance » a dû être **corrigé** :
son seuil (`< 0,05`) encodait précisément le comportement à supprimer. Un test
qui passe ne prouve pas que le seuil est le bon.

### Dette connue

- Les constantes du bilan de liaison (18 dB pour le début de la chute, 76 dB
  pour la rupture, 8 dB d'arête, 38 dB d'asymptote de profondeur sur 14 m) sont
  **calibrées à l'œil sur des captures**, pas mesurées sur un vrai lien : elles
  produisent le comportement voulu mais ne viennent d'aucune mesure. Idem pour
  la largeur de bave de chrominance (0,008 uv) et le contraste analogique.
- **Pas de diagramme d'antenne.** Un dipôle a un creux dans l'axe, donc voler
  juste au-dessus du pilote devrait coûter quelque chose et ne coûte rien ici.
  Suivi séparément.
- Le sol est un émetteur ponctuel sans multitrajet : pas de réflexions, pas de
  zone de Fresnel. Une arête franche donne une transition franche.
- La contrainte `needsSwap = false` de la passe finale est silencieuse : rien ne
  la vérifie au démarrage, et l'ajouter une passe après casserait le gel.

