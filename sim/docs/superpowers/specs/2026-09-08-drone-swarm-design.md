# Essaim de drones : piloter le nœud, la nuée te suit

Écrit le 2026-09-08.

## Ce que c'est

Le TARGET SCAN tombe rarement sur un **cluster** : plusieurs émetteurs sur un
même canal de contrôle. Le hacker ne donne pas un drone, il donne un **nœud de
liaison maillée** et les 6 à 12 unités qui lui obéissent. Le joueur vole le
nœud ; les unités volent autour de lui, devant, derrière, sur les côtés, et
elles s'adaptent au bâti parce qu'elles suivent **là où le joueur est passé**.

Ce que ça apporte : la seule session du jeu où l'écran est plein de machines
qui te répondent, un objet de rareté qui donne envie de rejouer, et un pilotage
inédit — le nœud est lourd, il porte son élan.

Ce que ce n'est **pas** :

- pas des objets physiques : cinématique pure, pas de corps Rapier, pas de
  collision entre unités ni avec le joueur (mêmes raisons que #250 : ~57 ms/pas
  de recalcul de propriétés de masse par corps, #184) ;
- pas un enjeu de jeu : l'essaim ne s'use pas, ne sert pas de vies de rechange,
  ne se commande pas. Le crash, la batterie et la fin de session ne changent
  pas d'une ligne ;
- pas des cibles : aucune interaction ;
- jamais au banc : `NO TARGET`.

## Décisions prises en brainstorm, avec leur raison

1. **On pilote le nœud, pas une unité.** Une unité est par définition un
   suiveur ; le nœud est ce qu'on a piraté et c'est lui qui commande. La
   fiction se referme, et le coût baisse : `swarmUnit` n'a plus besoin d'être
   pilotable, donc **une seule** famille nouvelle à tuner au banc.
2. **Évitement par le sillage**, pas par boids + champ d'occupation. Le dépôt
   tient à un raycast plein maillage par frame (`src/main.js:1641-1645`) et la
   rosette du vent en paie déjà ~208/s sur 3,7 M de triangles. Le sillage du
   joueur est libre **par construction** et coûte zéro rayon.
3. **Toutes les unités partagent une graine d'exemplaire.** Lore juste
   (matériel de série déployé par lot) et décision technique qui paie : une
   recette, une géométrie fusionnée, donc le passage ultérieur à 20–40 unités
   en `InstancedMesh` est local à `swarm-drones.js`.
4. **Budget audio partagé, pas additionné** : un bus `others` à plafond fixe où
   entrent ambiants et essaim.
5. **v1 = spectacle.** Tout enjeu (usure, vies, ordres) est hors périmètre.

## Contraintes du dépôt, vérifiées avant d'écrire

1. **Le scan est généré deux fois.** `src/target-scan.js:25` le génère côté
   client pour l'affichage ; `server/api.mjs:359` le régénère au moment du hack
   depuis `{seed, count}` seuls, puis appelle `resolveTarget()`. Toute
   probabilité qui dépendrait d'un état non transmis casserait cet accord.
   `src/ambient.js:56` le régénère une troisième fois pour les ambiants.
2. **`generateTargetScan` doit rester pure et rejouable.** #250 en dépend : les
   ambiants sont exactement les candidats `i !== index`. Un tirage inséré dans
   la boucle décalerait tous les scans existants.
3. **`INVARIANTS`** (`tools/target-build.mjs:95-98`) fige `family, label,
   rates, propRadius, bladeCount, armX, armZ, filterScale, rpmCurve, radius`
   par famille. Un build varie masse, batterie, kv, drag, rates, jamais les
   dimensions.
4. **`radius` = 0,15 m pour toute famille** : c'est la sphère de collision et
   `camera.near` y est épinglé (`physics.js`). Pas une dimension d'airframe.
5. **Les PID ne s'écrivent jamais à la main** : `node tools/tune-pid.mjs
   --write <family>` (CLAUDE.md). Une famille nouvelle naît avec le tune
   `freestyle5` et n'est correcte qu'après passage au banc.
6. **La scène n'a aucune lumière** et **le brouillard n'est pas `scene.fog`** en
   FIELD : le maillage s'éclaire lui-même et porte son extinction
   `1 − exp(−d²·z²)`. Contraintes 2 et 3 de la spec #250, déjà résolues par
   `src/drone-mesh.js` — on le réutilise tel quel.
7. **Palette** : aucun littéral de couleur hors `src/tokens.css`
   (`tools/palette-selftest.mjs` fait échouer le build). Échappatoire établie
   pour les matériaux : le doublon hex commenté.
8. **Son** : sinus seulement, détune entre voix obligatoire, rien qui renvoie
   d'énergie dans 2–4 kHz, graphe construit une fois dans `start()`, zéro
   allocation par frame, silence quand la physique est gelée
   (`docs/handoff-archive/sound.md:31-42, 66-90`). Le pire cas mesuré ne laisse
   que **1,6 dB** de marge au limiteur (`:92-98`). `EngineAudio` fait ~60
   nœuds, `AmbientAudio` ~24.
9. **Boucle de rendu** : dt clampé à 250 ms, convention `frozen ? 0 : dt`,
   **pas d'allocation par frame**, travail par frame hors de l'accumulateur à
   250 Hz (#187).
10. **Clôture** : `horizontalMargin`/`verticalMargin` (`src/geofence.js:258,
    267`) en scène pré-cuite, `nearestTrustedRadius()`
    (`src/rocktree-window.js:165`) en direct. `Geofence.update()` porte une
    hystérésis : ne pas partager une instance.
11. **Cycle de vie** : `respawn()` (`src/main.js:1340`) et `__sim.teleport`
    (`:585`) remettent les sous-systèmes à zéro ; il faut y ajouter un
    `reset()`. `bootLive()` est partagé, le garde-fou est `MODE.bench`.
12. **`geometrySafe()`** (`src/entry-state.js:240-256`) est duck-typé sur
    `{groundBelow, obstructionBetween}` et tourne en Node avec des stubs : sa
    règle « bloqué **et** épaisseur > 2 m » distingue un toit frôlé d'un mur.
    C'est la règle qu'on réutilise.
13. **`SESSION_SCHEMA_VERSION` vaut 2** (`tools/session-model.mjs:16`) et
    `sanitizeTarget()` (`:85`) jette tout champ non déclaré.

## Les machines

### `swarmNode` — ce qu'on pilote

Une 7e famille, dans `PROFILES` (`src/drone-profiles.js`), atteignable
**uniquement** par le hack d'un cluster : elle n'entre pas dans
`TARGET_FAMILIES`, sinon la rareté disparaît et un ambiant pourrait en être un.

Drone de commandement : châssis 6", dôme de liaison sur le dessus, deux
antennes, caméra nue, pas de GoPro. Lourd pour un 6" — il a de l'inertie, il ne
pivote pas comme un race, il porte son élan. Un pilotage distinct de tout ce qui
existe, entre `heavy5` et `longrange`, justifié physiquement par la radio
maillée et la batterie 6S.

Valeurs de départ, à confirmer au banc :

| champ | valeur | raison |
|---|---|---|
| `label` | `SWARM NODE` | |
| `rates` | `cinematic` | lourd, pas nerveux ; à revoir au banc |
| `mass` | 0,95 kg | 6" + dôme + 6S |
| `armX`/`armZ` | 0,090 | empattement 6" |
| `propRadius` | 0,0762 | 6" |
| `bladeCount` | 3 | |
| `maxThrustPerMotor` | 10,5 N | TWR ≈ 4,5 |
| `battery` | 6S, 2200 mAh | session moyenne, pas courte |
| `radius` | 0,15 | contrainte 4 |

Le `pid` naît sur le tune `freestyle5` et **n'est valide qu'après**
`node tools/tune-pid.mjs --write swarmNode`, exécuté et commité. Tant que ça
n'est pas fait, la famille est jouable mais pas juste, et le dire.

`targetCamera()` doit accepter la famille (`tools/target-camera.mjs`) : uptilt
modéré, c'est une machine d'observation.

### `swarmUnit` — la nuée

Jamais pilotée : **pas** d'entrée dans `PROFILES`, pas de PID, pas de tune. Une
recette géométrique et des constantes cinématiques dans `src/swarm.js`.

Quad de reconnaissance 3", ~330 g, carènes d'hélice intégrales, pas de GoPro,
caméra nue, une LED unique et forte à l'arrière. Nerveux : `twr ≈ 5`,
`vMax ≈ 24 m/s`. Le parti « reco militaire » plutôt que « drone show » est
délibéré : une machine docile aurait fait de l'événement le plus rare du jeu la
session la moins intéressante à regarder.

Constantes utiles au modèle : `propRadius = 0.038`, `bladeCount = 3`,
`armX = armZ = 0.027`, `maxOmega ≈ 4200` (fréquence de pale à `0,55·maxOmega`
≈ 1,1 kHz, sous les 2 kHz interdits), `mass = 0.33`, `bodyDrag` du toothpick
mis à l'échelle de la surface.

Toutes les unités partagent la graine `${buildSeed}::unit`, donc **une seule**
recette et une seule géométrie fusionnée.

## Le tirage, la fiche, le hack

### Signature

    generateTargetScan({ seed, count, swarmChance = SWARM_CHANCE, swarmAt })

- `swarmChance` par défaut **0,10** — un essaim toutes les ~10 sessions.
- Le tirage se fait sur un flux **séparé** `rngFrom(\`${seed}::swarm\`)`, jamais
  dans la boucle des candidats : contrainte 2. À `swarmChance = 0`, la sortie
  est **identique octet pour octet** à celle d'aujourd'hui pour toute graine.
- Le cluster est toujours **le candidat de plus fort RSSI**, donc l'index 0
  après tri. Il ne change que la famille de ce candidat, jamais l'ordre ni les
  autres.
- `swarmAt` (index ou `null`) court-circuite le tirage. C'est ce que la session
  persiste, et c'est ce qui rend la régénération des ambiants exacte.

Le candidat porte `_swarm: { size, doctrineSeed }`, `size` tiré dans **6..12**,
`_family` forcée à `swarmNode`, `_hackType` forcé à `NETWORK TAKEOVER` — type
déjà existant, dont la grammaire de rituel utilise `gridSwarm`
(`src/hack-grammars.js:378`), la grille de cellules qui s'allument en cascade.
Rien à écrire côté rituel.

`FAMILY_CLASS` ne contient pas `swarmNode` (contrainte : la famille ne doit pas
fuiter dans le bucket), donc `_classHint` serait `undefined` et
`sanitizeTarget()` casserait. Le cluster porte `_classHint = 'MESH'`, écrit en
dur au point de forçage — c'est le bucket honnête : « plusieurs émetteurs », et
il ne révèle ni la machine ni la taille.

### Garantie précoce

Le client calcule `swarmChance` depuis l'état opérateur qu'il a déjà
(`state.sessions`) : **1** si aucun essaim n'est apparu dans les 3 premiers
scans et que celui-ci est le 3e, `SWARM_CHANCE` sinon. Il transmet
`swarmChance` avec la requête de hack (`POST /:id/sessions`) pour que le
serveur régénère à l'identique ; le serveur valide `0 ≤ swarmChance ≤ 1`.

Le modèle de confiance ne bouge pas : le client choisit déjà la graine, le jeu
est local-first (Bible §33), il n'y a personne à tromper d'autre que soi.

### La fiche pré-hack

Bible §22 : trois niveaux, et un `EST.` doit resserrer sans fermer. Un essaim ne
peut pas être invisible sur la fiche — sinon la rareté n'existe qu'après coup et
le choix du joueur n'en est pas un. `describeTarget()` d'un cluster rend :

    DEVICE     EST. MESH — MULTIPLE EMITTERS
    SIGNAL     -54 dBm (STRONGEST OF GROUP)
    COUNT      UNKNOWN

Le joueur sait que c'est un groupe. Il ignore combien, quelle machine, quelle
doctrine. Et comme c'est le plus fort signal, il est en haut de la liste.

### Si le joueur ne prend pas le cluster

L'ambiant correspondant est **une seule `swarmUnit`** sur une routine ordinaire,
pas une nuée de douze au loin — ce serait un second système. Le joueur voit la
machine qu'il a laissée passer, seule. Il faut donc une entrée `swarmUnit` dans
`ROUTINES` de `src/ambient.js` (orbite basse rapide, AGL 5–25 m, 12–20 m/s,
rayon 15–25 m) et le maillage correspondant.

### Persistance

`resolveTarget()` ajoute au descripteur :

    target.swarm = { size, doctrineSeed }
    target.scan.swarmAt = <index | null>
    target.scan.swarmChance = <nombre>

`sanitizeTarget()` (`tools/session-model.mjs:85`) les garde avec validation de
forme (`size` entier 6..12, `swarmAt` entier `< count` ou `null`,
`swarmChance` dans [0,1]) ; `validateSession()` pareil.
`SESSION_SCHEMA_VERSION` passe à **3**. Une session v2 reprise n'a pas
d'essaim — honnêtement, comme une session v1 n'a pas d'ambiants.

### Chemins de dev

`?swarm=<n>` force un essaim de `n` sur `?scene=` et `?live=`, comme `?live=`
synthétise déjà un scan. BENCH : rien, par construction.

## Le sillage et le contrôleur

### Le sillage

`src/swarm.js` tient un anneau des positions du joueur : **512 entrées**,
`Float32Array` pré-allouées (`x, y, z, t`), une écriture toutes les **20 ms**.
À 20 m/s cela fait ~10 s et ~200 m de piste. Aucun rayon : là où le joueur est
passé est libre par construction.

Quand l'historique est plus court que le lag demandé (début de vol, après
`reset()`), la lecture se replie sur l'entrée la plus ancienne. Défini, testé.

### Le slot

Un membre a `(lag, latéral, vertical)`. On lit le sillage à `t_joueur − lag`
par interpolation entre les deux entrées encadrantes, puis on décale dans le
repère **de la piste à cet instant** : tangente, normale horizontale, vertical.

Deux conséquences gratuites et justes : en virage serré les unités coupent à
l'intérieur de la corde ; dans un couloir étroit elles s'alignent derrière le
joueur, parce que le décalage latéral y est réduit par le tourniquet de rayons.

Un **lag négatif** signifie « devant » et demande d'**extrapoler** la piste,
donc du terrain non validé. Il est borné à **0,4 s** (8 m à 20 m/s), son
décalage latéral plafonné à **4 m**, et il est prioritaire dans le tourniquet.

### Le rejoint

Pas de téléportation sur le slot. Chaque unité est un point matériel avec sa
vitesse, tirée vers son slot par un ressort critique de constante `tau`
(doctrine), plus une séparation courte portée entre voisins (rayon 1,5 m ;
N ≤ 12 donc ≤ 66 paires, négligeable), plus le vent lu une fois par frame sur
`physics.wind.out` avec une phase par unité, comme les ambiants.

`|v|` et `|a|` sont bornées par le TWR de `swarmUnit`
(`a_max = g·√(twr² − 1)`). Une unité ne peut pas suivre plus vite que la
machine ne vole : plein manche, **l'essaim décroche et rattrape**. C'est la
sensation recherchée, et elle est physique.

### L'attitude

Vient de l'accélération, exactement comme les ambiants. On **extrait** de
`src/ambient.js` vers `src/drone-kinematics.js` : `rngFrom`, `quatFromBasis`,
`clampToCone`, `attitudeFrom`, `clampTilt`, `tiltOf`, `lateralAccelMax`, et les
constantes `G`, `TILT_MAX_DEG`, `ATTITUDE_TAU`. `ambient.js` les réimporte ;
aucun code d'attitude en double. C'est le seul changement structurel imposé au
code existant côté modèle.

### Les doctrines

Tirées sur `doctrineSeed`. Environ **un tiers des unités devant** dans toutes
les doctrines sauf `column` — une **minorité**, et c'est délibéré : « devant »
veut dire extrapoler la piste, et c'est le seul endroit où le bâti peut mordre.
Le reste n'est pas derrière pour autant. Après le premier vol réel (« ils sont
trop loin du master, je ne les sens pas autour de moi »), les doctrines
dépensent leur budget en **largeur et en hauteur** plutôt qu'en longueur : le
`lag` est proche de zéro, donc les unités lisent le sillage là où le joueur
vient de passer — à sa hauteur, sur ses flancs, au-dessus et en dessous de lui.
Le vertical n'est pas symétrique : la caméra du nœud est cabrée de 10 à 20°,
donc une unité au-dessus est dans le champ quand son image en dessous n'y est
pas — le bas a la moitié de la portée.

Les quatre doctrines restent **distinctes et assumées** : elles deviennent le
catalogue de formations commutables en vol (#34). `column` est celle qui traîne
encore, exprès — c'est le « mode traînée », et il ne se lit comme un choix que
parce que les trois autres enveloppent.

| doctrine | plage de lag | latéral | vertical | `tau` | ce qu'on voit |
|---|---|---|---|---|---|
| `column` | −0,25 à 1,1 s | ±2,5 m | ±1,5 m | 0,25 s | la file : ils enfilent tes portes, deux éclaireurs devant |
| `wedge` | −0,4 à 0,45 s | ±9 m | ±3 m | 0,35 s | le V dont tu es le sommet : les bras s'ouvrent sur tes flancs |
| `cloud` | −0,4 à 0,5 s | ±9 m | ±6 m | 0,80 s | la bulle : la plus haute, la plus molle, tu es dedans |
| `screen` | −0,4 à 0,18 s | ±12 m | ±1,5 m | 0,50 s | l'écran : une ligne large et plate, de front avec toi |

La mesure de cette sensation vit dans `tools/swarm-selftest.mjs` (bloc « the
pilot is INSIDE his swarm »), lue à travers la caméra du nœud : fraction des
unités à moins de 25 m, fraction dans le champ, fraction **de flanc** (60 à
120° de la tangente) et dispersion des azimuts.

### Le budget de rayons

Le décalage latéral est le seul endroit où le bâti peut mordre. Un tourniquet
global de **6 rayons par frame** (360/s, du même ordre que la rosette du vent)
parcourt les unités : pour l'unité du tour, un `obstructionBetween` entre sa
position et son slot, règle de `geometrySafe` (`blocked && span > 2 m`). Une
unité **devant** est testée à chaque tour ; une unité derrière une fois sur
trois.

Une unité bloquée voit sa marge latérale décroître vers 0 en **0,3 s** : elle
se replie sur le sillage pur, c'est-à-dire exactement là où le joueur est passé.
La marge repousse en **1,5 s** quand le rayon repasse au vert.

Le cas dégradé est bénin, et c'est ce qui rend l'approche solide : **le pire
comportement possible est « ils volent en file indienne dans tes traces »**.
Jamais « ils traversent un mur ».

### Clôture

Le sillage est dans la clôture par construction (le joueur y est tenu). Seuls
les décalages peuvent en sortir : on les rabat avec `horizontalMargin`/
`verticalMargin` en scène pré-cuite, avec `nearestTrustedRadius()` en direct.
Aucune instance de `Geofence` partagée (contrainte 10) : le test est fait avec
les fonctions pures.

## Le maillage

Réutilisation directe de #250 : `src/drone-shape.js` gagne deux recettes,
`src/drone-mesh.js` ne change pas.

- `swarmUnit` : plaque, 4 bras courts, 4 moteurs, 4 disques, **carènes**
  (anneau r = 1,12·propRadius comme le cinewhoop), caméra nue, batterie 3S,
  antenne unique, **LED forte** à l'arrière. ~300 triangles.
- `swarmNode` : plaque 6", bras longs, 4 moteurs, 4 disques, **dôme** sur le
  dessus (demi-sphère basse résolution), **deux antennes**, caméra nue,
  batterie 6S. Visible depuis la nuée, jamais depuis la caméra du joueur (c'est
  lui qu'on pilote) — sauf en fin de vol 3D et au banc.

Toutes les unités partagent une géométrie ; 12 unités = 24 draw calls avec les
LED. L'instanciation (2 draw calls) est **hors périmètre** mais l'architecture
la prépare : le tableau de maillages est privé à `SwarmDrones`.

Couleurs via `token('--dark-grey')` etc. (`src/palette.js:31-42`), jamais de
littéral. La sortie traverse `lens.render` comme tout le reste.

## Le son

`src/swarm-audio.js`, deux étages construits une fois dans `start()`.

Douze voix individuelles sont exclues, et pas seulement pour le coût : douze
sinus quasi identiques se verrouillent en phase et produisent exactement le son
de test de synthé que `sound.md:84-90` interdit. Un essaim ne sonne pas comme
douze drones, il sonne comme un **chœur**.

- **3 voix proches**, réassignées en continu aux 3 unités les plus proches — le
  seul endroit où l'oreille localise vraiment. Chaîne validée de
  `ambient-audio.js` : sinus à `f_blade`, gain `g0/(1 + d/8)`, passe-bas
  fonction de la distance et de l'ombre du dos (× 0,6 derrière), `StereoPanner`
  équi-puissance lissé (τ = 60 ms), Doppler écrit à la main
  (`f·c/(c + v_r)`, `c = 343`, borné ±40 m/s ; jamais le Doppler du
  `PannerNode`, retiré de la spec). Détune par voix dans ±9 cents plus wander
  lent, obligatoire.
- **une nappe** pour les autres, statistiquement : bruit passe-bande étroit plus
  3 sinus désaccordés autour de la fréquence de pale **moyenne**, panoramique
  large et quasi statique, niveau fonction du nombre d'unités et de leur
  distance moyenne. C'est elle qui fait la nuée.

~24 nœuds, le même ordre que l'ambiant. Fréquence de pale ≈ 1,1 kHz, passe-bande
de la nappe plafonné à **1,6 kHz** : rien n'entre dans 2–4 kHz, ni en
fondamental ni en bande.

**Le budget est partagé, pas additionné.** On introduit un unique bus `others` à
plafond fixe, où la somme ambiants + essaim est bornée à **−12 dB sous
l'`idleLevel` du joueur** — la borne que #250 s'était donnée pour quatre voix.
Un essaim de douze ne peut donc pas, par construction, manger la marge de 1,6 dB
du limiteur. C'est une petite modification de `ambient-audio.js` (router vers le
bus au lieu de `engineIn()` directement, `src/ambient-audio.js:88`) et c'est la
**seule** chose que l'essaim change dans du code son existant.

Envoi vers `space.input` comme les ambiants, à gain égal au sec : l'essaim
résonne dans la cour où il passe. `setMuted(frozen)`, silence sur `linkDead`.
Niveaux relatifs **choisis et non mesurés**, dit dans le code, comme le reste du
son (`sound.md:106-111`).

## Les modules

    src/drone-kinematics.js  pur : attitude, tilt, quaternions, rng (EXTRAIT d'ambient.js)
    src/swarm.js             pur : sillage, slots, doctrines, contrôleur, budget de rayons
    src/swarm-drones.js      l'instance : maillages, lie le modèle à main.js
    src/swarm-audio.js       Web Audio : 3 voix + nappe
    src/drone-shape.js       + recettes swarmUnit et swarmNode
    src/ambient-audio.js     modifié : route vers le bus `others`
    src/ambient.js           modifié : réimporte drone-kinematics, + routine swarmUnit
    src/drone-profiles.js    + famille swarmNode
    tools/target-model.mjs   + tirage du cluster, fiche MESH, persistance
    tools/session-model.mjs  + validation, schéma v3
    server/api.mjs           + swarmChance dans la requête de hack

Les essaims et les ambiants **coexistent** : le candidat pris est le cluster,
les autres restent des ambiants. Deux systèmes frères qui partagent le maillage,
l'audio et le budget de rayons — pas un système qui change de mode.
`ambient.js` fait 741 lignes, est validé, et a `MAX_DRONES = 4` en dur : on ne
le transforme pas en module bimodal.

`SwarmDrones` est créé dans `finishBoot()` et dans `bootLive()` sous
`if (!MODE.bench)`, comme `AmbientDrones`. Dans `frame()`, après le bloc caméra
et avant `lens.render`, à côté de `ambient?.update(...)`. `respawn()` et
`__sim.teleport` appellent `swarm.reset()` (le sillage se vide, les unités se
reposent autour du joueur). `dispose()` en cinq lignes.

## Ce qu'on vérifie

### Sans navigateur

`tools/swarm-selftest.mjs`, stubs `{groundBelow, obstructionBetween}` (motif
`tools/entry-state-selftest.mjs:62-64`), ajouté à `selftest:ci` :

- **déterminisme** : même `{seed, size, doctrineSeed}` → mêmes slots, même
  doctrine, mêmes détunes ;
- **sillage** : anneau qui ne réalloue jamais ; lecture à `t − lag` exacte aux
  bornes ; repli défini quand l'historique est plus court que le lag ;
- **la propriété centrale** : sur une piste joueur rejouée à travers un stub de
  terrain, aucune unité n'est jamais à l'intérieur d'un obstacle — **y compris
  quand tous les rayons sont forcés à « bloqué »**. Le repli sur le sillage pur
  doit tenir tout seul ;
- **bornes physiques** : `|v|`, `|a|` ≤ ce que le TWR de `swarmUnit` autorise ;
  tilt ≤ 70° ; l'essaim décroche quand le joueur dépasse sa vitesse max et se
  recolle ensuite ;
- **extrapolation** : `wedge`/`cloud`/`screen` bornées à 0,4 s, latéral ≤ 4 m
  devant, priorité de tourniquet vérifiée (une unité devant testée à chaque
  tour) ;
- **budget** : ≤ 6 rayons/frame quels que soient taille et doctrine ;
  `update()` n'alloue rien sur 1000 pas (mêmes références de tableaux) ;
- **clôture** : aucune unité hors bbox + couloir en pré-cuit, hors cercle de
  confiance en direct ;
- **scan** : `swarmChance = 0` → aucun cluster **et candidats identiques à
  aujourd'hui, graine par graine** (la non-régression qui compte le plus) ;
  `swarmChance = 1` → cluster présent, index 0, `size` dans 6..12, famille
  `swarmNode`, `NETWORK TAKEOVER` forcé ; `swarmAt` court-circuite le tirage ;
  garantie du 3e scan ; aller-retour `sanitizeTarget`/`validateSession` en v3 ;
  session v2 sans essaim ;
- **profils** : `swarmNode` respecte `INVARIANTS`, `radius === 0.15`,
  `FAMILY_CLASS` ne le contient pas, `TARGET_FAMILIES` non plus ;
- **audio** (modèle pur, sans `AudioContext`) : somme essaim + ambiants ≤ le
  plafond du bus quelle que soit la taille ; aucune énergie de la nappe dans
  2–4 kHz ; détunes distincts ; réassignation des 3 voix continue — pas de saut
  de gain quand deux unités échangent leur rang.

### Avec scène réelle

Un bloc dans `tools/selftest.mjs` (Physics réel, tour-eiffel) : 20 essaims sur
20 graines pilotés le long d'une trajectoire enregistrée à travers la tour,
rejeu de `obstructionBetween` sur toutes les positions d'unité — zéro
pénétration.

### Au navigateur

Marche à suivre livrée avec le code : `__sim.debug().swarm` rend
`{size, doctrine, raysCast, blockedUnits, lagRange, drawCalls}` ; longtask nul
en vol ; nœuds audio constants après `start()` ; et le contrôle qualité qui ne
s'automatise pas — est-ce qu'on a envie de le revoir.

## Écarté

- **Corps Rapier par unité** — #184, et une collision entre unités n'apporte
  rien ici.
- **Boids + champ d'occupation échantillonné** — une grille 32³ remplie en
  amortissant ~30 rayons/frame périme en direct, coûte de la mémoire, et une
  nuée qui gicle dans un mur parce que la case n'était pas remplie est très
  visible. Nettement plus de dev pour un gain que le joueur, concentré sur son
  propre vol, verra peu.
- **Un `EngineAudio` par unité** — 720 nœuds pour des détails inaudibles à 30 m.
- **HRTF / binaural** — inaudible sur une source de deux pixels.
- **Piloter une unité** — un suiveur n'a pas le contrôle ; c'est le nœud qu'on a
  piraté.
- **Instanciation 20–40 unités** — l'architecture la prépare (géométrie unique
  partagée), on ne la fait pas en v1.
- **Essaim ambiant complet** si le cluster n'est pas pris — une seule unité
  suffit à faire regretter.
- **Usure, vies de rechange, ordres donnés à l'essaim, points d'essaim sur la
  carte du scanner** — chacun a sa place plus tard ; aucun n'est nécessaire pour
  que voler dans une nuée soit ce qu'on vient chercher.
