# Le drone du joueur en 3D : hélices dans le champ, free cam, portrait d'archive

Issue #264. Écrit le 2026-09-06. Suite directe de #250.

## Ce que c'est

#250 a construit une recette procédurale de quad et l'a fait voler au loin.
Cette spec la ramène sous les yeux du joueur, à trois distances :

- **dans le champ** : les hélices du drone piloté sont visibles en vol, comme
  sur n'importe quelle image FPV réelle, et leur régime est celui des vrais
  moteurs — donc le lacet, le roulis, le tangage, le retard moteur et
  l'affaissement de la batterie s'y lisent ;
- **en free cam** : la touche `C` montre enfin la machine qu'on pilote ;
- **en archive** : au crash et dans `SESSION LOG` / `TARGET LOG`, un portrait
  fil de fer vectoriel de la machine. On collectionne des drones toujours
  différents ; il fallait pouvoir les regarder.

`src/drone-mesh.js` annonçait déjà ces trois usages dans son en-tête : *« Ce
module ne sait pas qui pilote le quad : un ambiant aujourd'hui, le drone du
joueur (hélices dans le champ, épave) demain. »* C'est demain.

Ce que ça apporte, dans l'ordre : la vue FPV cesse de flotter sans référence
(pilier 4, réalisme documentaire) ; le joueur apprend la machine **par l'image**
et pas par un panneau (Bible §22, pilier 1) ; et le travail procédural de #250,
aujourd'hui invisible à 100 m, devient regardable.

## Ce que ce n'est pas

- **Pas un modèle d'auteur.** Tout reste engendré depuis `family` + `buildSeed`.
  Deux machines ne se ressemblent pas parce que la recette varie, pas parce
  qu'on a dessiné six drones.
- **Pas de dégâts.** Le portrait montre la machine telle qu'elle était, jamais
  une épave cassée. Un modèle de dégâts n'est alimenté par rien aujourd'hui ;
  c'est une issue à part.
- **Pas au TARGET SCAN.** Voir la silhouette avant le vol trahirait la famille,
  les conduits et la GoPro — c'est-à-dire une partie de ce que Bible §22 veut
  `UNKNOWN`. Décision du 2026-09-06 : le portrait n'existe qu'**après** avoir
  volé la machine.
- **Pas d'écran de collection dédié.** L'étagère, c'est le `TARGET LOG`
  existant. Un écran propre à la collection est une issue de suite si le besoin
  se confirme.
- **Pas de changement de rendu pour les ambiants.** Ils gardent la géométrie
  d'aujourd'hui, octet pour octet, par le niveau de détail `silhouette` qui est
  le défaut.

## Contraintes du dépôt, vérifiées avant d'écrire

1. **`camera.near = 0.15` est une contrainte dure, pas un réglage.**
   `main.js:86` construit la caméra à `near = 0.15` et `drone-profiles.js` le
   justifie : *« radius is 0.15 m for EVERY family: it is the collision sphere
   and camera.near is pinned to it »*. La caméra est en outre posée **au centre
   du corps** (`main.js:1762`). Tout le drone est donc dans le near plane : sans
   dispositif, il n'y a rien à afficher.

2. **Le joueur a déjà les mêmes entrées qu'un ambiant.** `targetBuild({ seed,
   family })` et `targetCamera({ seed, family })` sont résolus avant le vol
   (`main.js:2578` pour le chemin cible, `main.js:327` au banc), et
   `PROFILE = physics.profile` est adopté sur tous les chemins, y compris sans
   cible (`main.js:797-801`). Aucune donnée nouvelle à faire circuler.

3. **L'uptilt appliqué à la caméra vient de `camSpec`** (`main.js:490` :
   `cameraTilt = spec.uptiltDeg`). Le montage du maillage doit venir du **même**
   objet, sinon les hélices se posent à une hauteur que rien ne contredit.

4. **L'ordre des moteurs est celui de Betaflight et il est déjà la source de
   vérité du mixeur.** `quad.js:64-71` : 1 arrière-droit `spin +1`, 2
   avant-droit `spin −1`, 3 arrière-gauche `spin −1`, 4 avant-gauche `spin +1` ;
   `mixOf()` en dérive `yaw: -m.spin` avec l'argument explicite *« derived from
   the motor geometry rather than written out, so moving a motor cannot silently
   desynchronise the controller from physics »*. La recette engendre au
   contraire ses hélices par une boucle `for sx of [-1,1] for sz of [-1,1]`,
   dont l'ordre ne coïncide pas.

5. **`physics.propulsion.omega[4]` porte déjà tout ce qu'il faut** : la courbe
   `omega = omegaMax · cmd^rpmCurve`, le retard du premier ordre avec
   `tauSpinUp ≠ tauSpinDown` (`quad.js:328-331`), et le plafond
   `omegaMax · battery.thrustScale` avec `thrustScale = voltage / (4.2·cells)`
   (`quad.js:205-207`).

6. **Le composer a deux passes et un gel.** `lens.js:786-799` : un `RenderPass`
   puis un `ShaderPass` en `renderToScreen` avec `needsSwap = false` ; le gel du
   mode DIGITAL fonctionne en **désactivant** le `RenderPass`
   (`lens.js:1101-1107`), le `readBuffer` gardant la dernière image.

7. **Une session CRASHED n'a pas d'écran de fin**, et le code l'applique :
   `post-flight.js:6-7`, *« Uniquement pour une session LANDED : une session
   CRASHED n'a pas de grand écran (Bible §24) »*.

8. **La session stocke déjà la machine, et mieux qu'espéré.** Le client envoie
   `{ targetSeed, targetCount, targetIndex }` (`session.js:47`), mais le serveur
   appelle `resolveTarget(scan, index)` (`tools/map-api-plugin.mjs:267`) et
   **persiste le résultat** : `session.target` contient `family` et `buildSeed`
   **en clair** (`tools/target-model.mjs:117-133`), plus `scan: {seed, count,
   index}`. Le portrait n'a donc rien à régénérer : deux lectures directes.
   **Aucune migration, et toutes les sessions déjà journalisées peuvent afficher
   leur machine.**

9. **Les écrans du journal sont des clients purs.** `session-log.js:1-3` :
   *« Écrans client purs : screen/button de terminal.js, aucune dépendance
   Three/Rapier »*. Rien de ce qui suit ne doit y allumer un contexte WebGL.

10. **La couleur vient du contexte.** `pixel-icons.js:1-4` : *« monochromes : la
    couleur vient du contexte (currentColor), jamais de l'icône »*. Le portrait
    fil de fer suit la même règle.

## Ce que la mesure a montré

Trois faits, obtenus en rasterisant réellement le champ (200×150 rayons, 300
builds par famille, six familles) plutôt qu'en estimant des angles. `dy` est la
hauteur de l'objectif **par rapport au plan d'hélice**.

| `dy` | couverture médiane de l'image | hauteur atteinte (0 % = bas) |
|---|---|---|
| −8 mm (état actuel) | 9,8 % (cinewhoop) → 30,9 % (toothpick) | 66 % → 100 % |
| 0 mm | 0,0 % partout | — |
| +3 mm | 3,7 % → 14,8 % | 30 % → 45 % |
| +10 mm | 12,4 % → 26,6 % | 27 % → 42 % |

1. **L'état actuel est faux et le serait visiblement.** La recette pose le
   disque à `y = 0,020` et l'objectif à `y = 0,012` : l'œil est 8 mm **sous** le
   plan d'hélice, donc le disque passe au-dessus de lui — sur le toothpick il le
   survole entièrement (100 % de la hauteur). Une image FPV réelle montre
   quelques pour cent d'hélice, confinés au bas du cadre.

   Ce n'est pas un bug : ces 8 mm n'ont jamais eu à être justes. Vus de 100 m,
   ils ne coûtent rien. La vue embarquée les rend soudain visibles.

2. **Le disque plat ne peut pas produire une vue embarquée correcte.** À
   `dy = 0` la couverture est exactement 0 % : un disque d'épaisseur nulle qui
   contient l'œil est parfaitement par la tranche. La primitive est donc soit
   invisible, soit envahissante, sans milieu — la singularité est dans la
   primitive, pas dans le réglage. **C'est ce qui impose de vraies pales au
   niveau `onboard`**, et c'est ce qui déplace la borne DA : elle porte sur le
   volume balayé par les pales, pas sur un disque.

3. **L'objectif doit être au-dessus du plan d'hélice**, comme sur un vrai
   freestyle où la caméra est dans le stack avant : la hauteur atteinte tombe de
   66-100 % à 27-45 %, c'est-à-dire que les hélices se confinent au tiers bas de
   l'image. C'est la forme qu'a le vrai médium.

## La recette : `drone-shape.js`

Trois ajouts, tous dans le module pur. Il reste sans Three, sans DOM, en
mètres, repère corps nez −Z.

### Le bloc `mount`, mesuré et jamais écrit à la main

La position de l'objectif cesse d'être `[0, 0.012, -0.55·armZ]` et devient deux
dimensions nommées par famille : hauteur au-dessus du plan d'hélice, et avancée
du stack. Elles sont écrites par `tools/tune-mount.mjs`, qui balaie et mesure
comme la sonde ci-dessus, exactement comme `tools/tune-pid.mjs --write` écrit
les blocs `pid`. L'en-tête de `drone-shape.js` porte la même mention que
`drone-profiles.js` : ce bloc n'est pas modifié à la main.

**La borne DA, chiffrée.** Mesurée sur l'enveloppe balayée (le disque), qui est
ce qu'on voit réellement comme un arc flou :

- **couverture ≤ 8 % de l'image** ;
- **rien au-dessus de 45 % de la hauteur** du cadre.

Les 45 % sortent directement de la mesure : dès que l'objectif passe au-dessus
du plan d'hélice, la hauteur atteinte tombe dans 27-45 % pour les six familles.
Les 8 % sont tenus à `dy = +3 mm` par cinq familles sur six — le toothpick y est
à 14,8 %, parce que son disque est grand devant son empattement. **C'est
précisément pourquoi le bloc est par famille et écrit par l'outil** : un chiffre
unique fixé à la main serait faux pour au moins une famille, et personne ne s'en
apercevrait.

L'outil optimise sous ces deux critères, par famille, sur toute l'étendue
d'uptilt que `targetCamera` peut tirer pour elle.

### Trois niveaux de détail

`shapeOf({ profile, build, camera, detail })` :

- `silhouette` — **le défaut**, la recette d'aujourd'hui octet pour octet. Les
  ambiants ne changent pas ;
- `onboard` — les disques deviennent `bladeCount` vraies pales (corde, vrillage,
  épaisseur), plus le capot qui masque ce qui doit l'être ;
- `portrait` — `onboard`, plus ce qui ne se voit que de près et qui distingue
  deux machines : cloches moteur, plaque découpée, stack, fixations d'antenne.

`boundingRadius` garde son sens à tous les niveaux.

### Pas de liste d'arêtes

Envisagée puis écartée à l'écriture du plan : `drone-wire.js` lit les **mêmes
primitives** que `drone-mesh.js` — une boîte donne douze arêtes, un cylindre deux
cercles et des génératrices, un disque un cercle. Une liste d'arêtes dans la
recette serait une seconde description de la même géométrie, à tenir
synchronisée pour rien.

### Des hélices engendrées depuis `motorsOf()`

Les parts `prop` cessent d'être produites par la boucle de signes et le sont
depuis `motorsOf(profile)` — même source que le mixeur et que la physique.
Chaque part porte `motor` (0-3, ordre Betaflight) et `spin` (±1).

C'est l'extension à la géométrie visible de l'argument déjà écrit dans
`quad.js` : une hélice qu'on déplace ne peut pas désynchroniser silencieusement
l'image de la physique.

**Ce que ça donne à l'image.** Les deux hélices dans le champ sont les deux
avant, donc les moteurs 2 (avant-droit, `spin −1`) et 4 (avant-gauche,
`spin +1`) — deux diagonales opposées. Avec `yaw: -m.spin` :

- **lacet à gauche** → l'avant-droite accélère, l'avant-gauche ralentit ; à
  droite, l'inverse ;
- **tangage** → les deux ensemble ;
- **roulis** → une seule.

Les deux hélices visibles sont donc un affichage direct du mixeur, chaque axe
avec sa signature propre. C'est « apprendre la machine par les sensations » sans
une ligne d'interface.

## Le vol : la vue embarquée et la free cam

### Placement, sans transformation monde

La vue embarquée vit dans une scène à part qui ne contient que le drone, avec sa
propre `PerspectiveCamera` à l'origine, `near = 0.005`, qui copie chaque image le
`fov` et l'`aspect` de la caméra de vol. Le maillage y est posé **une fois** à
`−mount`, avec l'uptilt inverse.

Rien ne bouge ensuite : les hélices sont rigides à l'objectif, donc leur place à
l'image est un fait de construction et non un calcul par image. Aucune
coordonnée monde n'entre là-dedans — la scène de vol est en ENU et peut être à
des centaines de mètres de l'origine.

**Invariant :** le `mount` et l'uptilt viennent du même `camSpec` que
`main.js:490` applique à `cameraTilt`.

### La seconde passe

Un `RenderPass(sceneEmbarquée, caméraEmbarquée)` inséré entre la passe du monde
et la passe d'objectif, en `clear: false`, avec effacement du tampon de
profondeur : rien ne peut s'interposer entre l'œil et ses propres hélices. La
cible du composer ayant `samples: 4`, les pales sont antialiasées comme le reste.

Elle est **désactivée par le même drapeau `frozen`** que la passe principale : sur
une image perdue en DIGITAL, les hélices gèlent avec l'image, sinon elles
trahissent que le monde tourne encore derrière.

Deux conséquences assumées :

- Les hélices traversent la passe d'objectif — bruit, gouttes, dégradation du
  lien. C'est correct : la caméra voit ses hélices, **puis** l'image est
  transmise. Les poser au-dessus de l'objectif les rendrait plus nettes que le
  monde, ce qui serait l'inverse du sujet.
- La reprojection d'exposition (`uReproj`) fait glisser toute l'image ; les
  hélices, rigides à l'objectif, ne le devraient pas. On accepte : corriger
  demanderait une troisième passe pour un ou deux pixels sur un filé.

Bible §27 est respectée sans rien faire : une photo est prise sur la sortie du
composer, donc les hélices sont dans les photos, comme dans toute vraie image FPV.

### La free cam

Règle unique et testable : **exactement un des deux maillages est visible, jamais
deux, jamais zéro pendant un vol.** En vue pilote, l'embarqué ; en free cam
(`freeCamOn`), un second exemplaire posé dans la scène du monde à la
transformation physique, qui reçoit soleil, brouillard et résolution par les
appels que `ambient-drones.js` fait déjà — aucun nouveau chemin d'uniformes. La
cible d'orbite suit le drone au lieu de rester sur `(0,0,0)` (`main.js:918`).

### Le régime à l'image

`physics.propulsion.omega[4]` arrive dans un `uniform vec4` ; chaque hélice lit
le sien par l'index moteur porté par la recette, et son `spin` donne le sens de
l'arc. Le fondu pales → disque se déclenche sur ω comparé au pas de temps, pas
sur les gaz — sans quoi le retard moteur, qui est le cœur du ressenti,
disparaîtrait de l'image.

Ce que ce branchement donne gratuitement : la montée en régime non linéaire au
manche, l'asymétrie emballement/ralentissement, et le plafond qui baisse en fin
de pack. **Les hélices annoncent la batterie mourante avant l'OSD.**

Précision pour ne pas promettre du faux : la vitesse air n'agit pas sur ω. Le
flux entrant (`v_i = v + ω × r`) change la poussée de chaque rotor, pas son
régime ; le régime ne suit que la commande. La vitesse du drone se lit dans les
hélices à travers ce qu'il faut commander pour la tenir.

### Repli

Sur les chemins sans cible (`?scene=`, dev sans `?family=`), `PROFILE` et
`camSpec` sont de toute façon résolus : le drone embarqué se construit avec la
graine par défaut. Aucun chemin ne se retrouve sans machine.

## Le portrait fil de fer

### `drone-wire.js`, module pur

Entrée : la recette au niveau `portrait` — dont il dérive les arêtes primitive
par primitive — et une vue (azimut, élévation). Sortie : des segments 2D dans
une boîte normalisée, chacun avec sa profondeur. La projection est
**orthographique** et il n'y a pas de distance : un portrait technique n'a pas
de perspective, et la normalisation se fait sur le `boundingRadius` de la
recette, pour qu'un toothpick reste plus petit qu'un heavy5 dans le même cadre.
Aucun Three, aucun DOM, testable en Node — même statut que
`tools/session-log-model.mjs`, qui porte déjà tout le formatage des journaux.

**Pas d'élimination des faces cachées** : les arêtes lointaines s'atténuent au
lieu de disparaître. C'est plus juste que ce que ça économise — un fil de fer
transparent est le vocabulaire des `vector animations` de PHASE 20, et une
machine qu'on voit à travers se lit mieux qu'une silhouette pleine.

### Le rendu : du SVG en ligne

Construit dans le DOM comme le reste des écrans, monochrome, la couleur venant
du contexte via `currentColor`. Aucun contexte WebGL n'est allumé dans le
terminal ; les écrans restent les clients purs qu'ils sont. Rotation lente
automatique, sans interaction, arrêtée à la fermeture de l'écran par le même
démontage que `menu-nav`.

### Les trois lieux

- **Au crash** : une entrée de plus dans `TIMELINE` (`flight-end.js:16`), après
  `SESSION TERMINATED` à 3,6 s. `flight-end.js` reste pur — la table gagne une
  ligne, le DOM dessine.
- **`SESSION LOG`**, dans la fiche de session, à côté du Randomart. Bible §26
  fait du Randomart la signature de la session ; le portrait est la signature de
  la **machine**. Les deux empreintes côte à côte.
- **`TARGET LOG`**, qui devient de fait l'étagère de la collection.

## La révision de Bible §24

§24 refuse le grand écran de mort : *« Pas de récompense. Pas de grand écran de
mort. »* Le portrait au crash est une révision délibérée de cette section,
décidée le 2026-09-06 après que l'objection a été posée et écartée.

Elle se note dans la Bible **comme §34 porte déjà « (révisé — issue #122) »**,
sinon la Bible et le code se contrediront en silence — et le commentaire de
`post-flight.js:6-7` citera cette issue à côté de §24.

Ce que la révision **ne** change **pas** : `POST-FLIGHT ANALYSIS` reste réservé
aux sessions LANDED, la musique reste coupée net au crash (#122), et la timeline
conserve ses temps. Le portrait s'ajoute après `SESSION TERMINATED` ; il ne
déplace rien.

## Persistance

Rien. Voir la contrainte 8 : `session.target.family` et `session.target.buildSeed`
sont persistés en clair par le serveur, donc le build, donc la caméra, donc la
machine — sans régénération. Aucune migration, et l'historique déjà écrit devient
consultable rétroactivement.

## Ce qu'on vérifie

Tout en Node, sans navigateur.

**`drone-shape-selftest.mjs`** (existant, étendu)
- l'hélice d'index `k` est à la position du moteur `k` de `motorsOf()`, avec son
  `spin`, pour les six familles ;
- `detail` absent ⇒ géométrie identique à celle d'aujourd'hui, part par part
  (c'est la garantie « les ambiants ne changent pas ») ;
- `onboard` et `portrait` ajoutent des parts, n'en retirent aucune, et gardent
  `boundingRadius`.

**`onboard-frame-selftest.mjs`** (neuf) — la borne DA garantie par construction
- rasterise l'enveloppe balayée, 6 familles × 300 graines — la sonde de
  conception, telle quelle ;
- affirme : couverture ≤ 8 % de l'image et rien au-dessus de 45 % de la
  hauteur, sur **toute** l'étendue d'uptilt de chaque famille ;
- c'est la sonde de conception promue en garde-fou : un `mount` qui dérive
  casse en rouge.

**`onboard-drone-selftest.mjs`** (neuf)
- exclusivité embarqué/free cam : jamais deux, jamais zéro en vol ;
- gel : `frozen` ⇒ la passe embarquée est désactivée et ω n'avance plus ;
- repli sans cible ;
- `dispose()` libère géométries et matériaux (même exigence que #250).

**Régime, contre le contrôleur réel**
- lacet seul à gauche ⇒ `omega[1] > omega[3]`, et la vitesse de rendu de
  l'hélice avant-droite est la plus haute des deux ;
- créneau de gaz ⇒ montée plus raide que la descente (asymétrie `tau`) ;
- pack vidé ⇒ plafond de régime abaissé.

**`drone-wire-selftest.mjs`** (neuf)
- déterminisme : même graine ⇒ mêmes segments ;
- les six familles se distinguent deux à deux ;
- la projection ne sort jamais de sa boîte ;
- une session sans cible n'affiche rien plutôt que de casser.

**Rendu** — un `*-render-selftest.mjs` sur le shim DOM existant, comme
`bench-render-selftest.mjs` : le SVG est bien produit, monochrome, et démonté à
la fermeture de l'écran.

Tous ajoutés à la chaîne `selftest:operator` de `package.json`.

## Découpage

1. **Lot 0 — free cam.** Le drone visible en `C`, cible d'orbite sur lui.
   Aucun obstacle : la caméra est loin. **Il n'utilise que le niveau
   `silhouette`, donc il ne dépend d'aucun autre lot** — ni du `mount`, ni des
   pales. C'est la première vraie validation visuelle du maillage hors du
   contexte ambiant lointain, et le lot A n'est sûr qu'après.
2. **Lot A — la recette et la vue embarquée.** `mount` + `tune-mount.mjs`, les
   pales, `motorsOf()`, la seconde passe, les selftests de borne et de régime.
3. **Lot B — le portrait.** `drone-wire.js`, le SVG, le crash et les deux
   journaux, la note de révision dans la Bible.

## Écarté

- **Le disque plat pour la vue embarquée** — mesuré impossible : 0 % à l'œil,
  10-31 % ailleurs.
- **Le portrait éclairé comme en vol** — met du photographique dans le terminal
  et exige une recette bien plus riche. Le fil de fer est le langage du
  terminal ; le monde et le terminal restent étanches.
- **Le portrait au TARGET SCAN** — contredit Bible §22.
- **Les dégâts / l'épave cassée** — aucun modèle de dégâts n'existe. Issue à
  part.
- **Un écran de collection dédié** — le `TARGET LOG` en tient lieu. À rouvrir si
  le besoin se confirme.
- **Le drone en 3D au banc**, qui était le lot B de l'issue #264 telle qu'elle a
  été ouverte. Écarté à la conception le 2026-09-06 : l'intention retenue est
  d'apprendre la machine par l'image et de regarder ce qu'on a volé, or au banc
  la machine est choisie et connue d'avance. L'issue doit être mise à jour.
- **Corriger le filé de reprojection sur les hélices** — une passe de plus pour
  un ou deux pixels.
- **`LineSegments` Three dans le terminal** — allumerait un contexte WebGL dans
  des écrans qui sont des clients purs, et rendrait le portrait invérifiable
  sans navigateur.
