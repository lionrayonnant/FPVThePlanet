# Essaim de drones (issue #29)

Récit de la session du 2026-09-08/09. Le HANDOFF ne garde que l'état ; tout le
« pourquoi » est ici. À lire avant de toucher `src/swarm.js`.

## L'idée, et pourquoi elle tient

Faire voler 6 à 12 drones autour du joueur dans une ville en 3D est un problème
d'évitement à douze corps. L'approche classique — boids plus champ d'occupation
échantillonné — a été écartée : le dépôt tient déjà à un raycast plein maillage
par frame sur 3,7 M de triangles, une grille 32³ amortie périme en direct, et
une nuée qui gicle dans un mur parce que la case n'était pas remplie est très
visible.

L'idée retenue tient en une phrase : **là où le joueur est passé est libre par
construction**. Il vole, donc il n'est pas dans un mur. Sa trajectoire est un
couloir validé gratuitement, sans un seul rayon.

Conséquence qui fait tout l'intérêt de l'approche : **le pire comportement
possible est « ils volent en file indienne dans tes traces »**, jamais « ils
traversent un mur ». Le cas dégradé est bénin.

## Ce qu'on pilote

Pas une unité — le **nœud de liaison maillée**. Un suiveur n'a pas le contrôle ;
c'est le nœud qu'on a piraté. La fiction se referme et le coût baisse de moitié :
une seule famille nouvelle à tuner au banc (`swarmNode`), les unités n'étant
qu'une recette géométrique et des constantes cinématiques.

`swarmUnit` n'est **pas** dans `PROFILES`, et `swarmNode` n'est **ni** dans
`TARGET_FAMILIES` **ni** dans `FAMILY_CLASS` : sinon la rareté du cluster fuite
dans le bucket de la fiche pré-hack, et un drone ambiant pourrait en être un.
`sanitizeTarget()` autorise `swarmNode` nommément, par une constante commentée.

## Le contrôleur, et ses deux réécritures

Le slot d'une unité est `(lag, latéral, vertical)`. On lit le sillage à
`t_joueur − lag` — anneau de 512 entrées, `Float32Array`, écriture toutes les
20 ms réelles — puis on décale dans le repère **de la piste à cet instant**.

Deux comportements en tombent gratuitement : en virage serré les unités coupent
à l'intérieur de la corde, et dans un couloir étroit elles s'alignent derrière
le joueur.

**Première version, abandonnée** : ressort dans l'espace libre en 3D, plus un
« tube » rabattant l'unité près du sillage après intégration. Elle ne tenait
pas — une unité pouvait se découpler de son slot de 41 m, et le rayon
interrogeait alors une géométrie où l'unité n'était pas. Mesuré : jusqu'à 6,64 m
dans le bâti à 34 m/s, systématique dès 20 m/s.

**Version actuelle** : le ressort vit sur l'**abscisse curviligne du sillage**.
La position s'écrit `sillage(s) + repère·offset`, avec `|offset| ≤ marge`. Le
découplage devient impossible par construction ; à marge nulle l'unité est
exactement sur la polyligne du sillage. C'est ce qui rend le repli sûr **sans
aucun rayon**.

Les accélérations sont bornées par le TWR réel de la machine
(`a_max = g·√(twr² − 1)`). Plein manche, l'essaim décroche puis rattrape : c'est
physique, pas scripté. Le plafond de sensation est `SPEED_MAX = SWARM_UNIT.vMax`
— au-delà l'essaim décroche définitivement, et c'est exactement ce qui est
arrivé tant que ce nombre valait 24 (voir « La vitesse des unités » plus bas).

## Le budget de rayons — 6 par frame, et ce que ça implique

Le décalage latéral est le seul endroit où le bâti peut mordre. Un tourniquet
global de 6 rayons/frame (~360/s, l'ordre de grandeur de la rosette du vent)
parcourt les unités, avec la règle de `geometrySafe` : bloqué **et** épaisseur
> 2 m, ce qui distingue un toit frôlé d'un mur.

Trois choses ont été apprises douloureusement :

1. **La marge s'achète par rayon vert, pas par seconde.** Ni le temps ni la
   distance ne distinguent « cadence lente » de « frame lente » ; seule la
   densité de rayons par mètre le fait. Avant ce changement, l'essaim se
   repliait en file **en plein ciel** sous 25 fps (marge 0,95 → 0,38).
2. **Un plafond AIMD** sur la marge (chute multiplicative quand le rayon est
   rouge, remontée additive) supprime une oscillation de la boucle
   repli/redéploiement contre les murs. Sans lui, `n = 8` donnait 2,94 m dans le
   bâti là où `n = 12` donnait 0,43 m.
3. **Le budget étant par frame, la taille de l'essaim est un axe de risque** :
   12 est la taille la plus *sûre*, et c'était longtemps la seule testée.

## Les éclaireurs, et le bug qui les a fait disparaître

Un `lag` négatif signifie « devant » et demande d'**extrapoler** la piste, donc
du terrain non validé. C'est borné à 0,4 s et 4 m de décalage latéral. Ces
unités-là sont la seule population que la garantie du sillage **ne couvre pas**,
par construction (issue #37).

Un vol réel a révélé qu'on ne voyait **aucun drone devant soi**. Cause :
effondrement en deux étages, né de l'interaction de deux correctifs dont aucun
n'était fautif seul.

- **Étage 1** : le plafond AIMD est chargé **par rayon** et reconstitué **par
  seconde**. Or les éclaireurs sont les seules unités tirées à chaque frame
  (60/s) contre 20/s pour les autres. Leur point de rupture est à **1,3 %** de
  rayons bloqués, contre 4 % pour une unité arrière — une vraie ville est très
  au-delà.
- **Étage 2** : à marge nulle, `fileLag` étant positif, un éclaireur affamé
  n'est pas « au niveau du nœud », il est 1,5 à 5 m **derrière**.

Le repli en file venait d'un tour antérieur et était **délibéré** (empiler
quatre machines au même endroit aurait été pire) ; à l'époque, la marge nulle
n'était qu'un transitoire. Le plafond AIMD l'a rendue permanente, transformant
un repli passager en porte à sens unique.

**Le correctif** : séparer la sonde avant de la sonde latérale. La sonde avant
suit la **tangente pure du sillage, décalage latéral nul** — le volume où le
joueur est sur le point de voler, statistiquement l'extrapolation la plus sûre
de la scène. Les trois correctifs évidents (charger le backoff au prorata du
temps, plafonner `fileLag`, reconstituer par rayon vert) ont tous été mesurés et
**cassent la sûreté** ; ils sont documentés dans le rapport de tranche.

Détail élégant : la sonde avant ne coûte **qu'un seul rayon pour tout
l'essaim**. Tous les éclaireurs extrapolent depuis le même échantillon le long
de la même tangente, donc leurs segments sont colinéaires et le plus long
contient les autres — vérifié à 4,3e-14 m près sur 852 908 slots. La
colinéarité est **instantanée** : entre deux tirs, la tête d'anneau bouge et la
tangente tourne.

## « Entouré », pas « suivi »

Le premier vol réel a donné le retour qui a le plus changé la fonctionnalité :
« les drones sont trop loin du master, je ne les sens pas autour de moi ;
j'imaginais que le joueur soit **entouré** de son essaim, pas qu'il le suive. »

La spec était écrite autour de « la nuée te suit », et le sillage est par nature
**derrière**. Les doctrines étalaient jusqu'à 2,0 s de `lag`, soit 40 m en
arrière à 20 m/s — en FPV, invisible.

Le levier n'est **pas** d'envoyer plus d'unités devant : ça coûterait la
sûreté. C'est le `lag` proche de zéro avec du décalage latéral et vertical
généreux. Une unité à `lag ≈ 0` lit le sillage à la position actuelle du joueur :
elle est à sa hauteur, décalée de 8 m sur sa gauche. Les doctrines étalaient en
longueur ce qu'il fallait étaler en largeur et en hauteur.

Effet mesuré au navigateur : `lagRange` de `cloud` passe de `[-0,34 ; +1,73]` à
`[-0,34 ; +0,44]`, et là où la référence ne montrait **aucun** drone à l'écran,
on en voit quatre.

Coût connu, accepté : un essaim plus large sollicite davantage le décalage
latéral. Le solde est nettement **positif** aux cadences visées (slalom 60 fps
1,83 → 0,88 m) et **négatif** de 0,5 à 1,0 m à 12 et 4 fps (issue #38).

## La vitesse des unités (issue #46)

Retour de vol du propriétaire : « les drones de l'essaim sont trop lents par
rapport au master ». C'était un nombre, et il tenait à la phrase ci-dessus :
`SPEED_MAX` borne la vitesse à laquelle la tête de lecture d'une unité parcourt
le sillage. Une unité plus lente que le nœud lit donc le sillage moins vite que
le nœud ne l'écrit, **tant que le joueur vole** : ce n'est pas un décrochage
transitoire, c'est un décrochage permanent. `vMax` valait 24 ; le `swarmNode`
plafonne à **33,4 m/s**, mesuré au banc d'enveloppe de `tools/selftest.mjs`
(30,0 à 45°, 31,5 à 60°, 32,5 à 70°, 33,4 à 80°, atteint en trois secondes) et
encore 24,9 m/s en mode angle, dont l'assiette est bridée à 42°.

**`vMax` passe à 40 m/s** — 20 % au-dessus du plafond mesuré, et honnête pour
l'airframe (un 3" de 330 g fait 130 à 160 km/h en palier). `NODE_TOP_SPEED_MS`
est exporté pour que le selftest s'appuie sur un nombre qui a une provenance.
`twr` reste à 5 et `maxOmega` à 4200 : balayés, sans effet mesurable, et
`maxOmega` n'est pas une vitesse mais la fréquence de pale dont dépend le son.
`bodyDrag` est par surface frontale : l'airframe n'est pas devenu plus propre,
il a plus de puissance.

### Ce que `vMax` seul ne suffisait pas à corriger — γ était *divisé*, pas cherché

Monter `vMax` n'a pas suffi, et la raison est plus intéressante que le nombre.
Le limiteur de pas essayait γ = 1, puis 1/2, puis 1/4 : quand une frame
demandait 1 % de plus que ce que l'airframe a, l'unité prenait **la moitié** de
ce à quoi elle avait droit.

Ça fuit parce que **la tête de lecture ne peut pas capitaliser** : `sNew` est
écrêté à l'échantillon de sillage le plus récent, qui avance par pas de
`WAKE_DT_S` quelle que soit la cadence. Une unité qui lit près de la tête reçoit
donc une demande **en dents de scie** — rien entre deux écritures, tout un
échantillon sur la frame qui suit. La moyenne tient dans `SPEED_MAX` ; le pic
non, et chaque pic coûtait une demi-frame d'avance que les frames plates ne
pouvaient pas rendre. Le déficit s'accumule tant que le nœud vole.

Mesuré, douze graines × tailles 6/9/12 × 30/60/120 fps, ligne droite en ciel
clair, pire écart au slot après vingt secondes :

| vitesse du nœud | γ divisé | γ cherché |
|---|---|---|
| 30 m/s | 2,47 m | 2,47 m |
| **33,4 m/s** | **59,28 m** | **2,59 m** |
| 36 m/s | 114,95 m | 2,91 m |
| 38 m/s | 140,40 m | 3,57 m |
| 39 m/s | 178,73 m | 12,64 m |

Le vrai plafond du mécanisme était donc **0,81 × `SPEED_MAX`**, soit 32 m/s sur
un airframe à 40 — sous les 33,4 du nœud. Monter `vMax` seul n'aurait fait que
déplacer ce nombre. γ est maintenant **cherché par dichotomie** (sept
bissections, γ à 1/128 près), et l'essaim suit jusqu'à 95 % de `SPEED_MAX`.

Un piège dans le correctif, trouvé à la mesure : quand **aucun** γ ne convient
— la discontinuité de queue, où c'est l'ancre elle-même qui saute — il faut
placer l'unité au plus petit γ **essayé**, pas à γ = 0. L'écrêtage de position
qui suit remet le pas à l'échelle : à γ = 0 il n'a aucune direction, l'unité
s'arrête net et `sNew` reste hors de portée à chaque frame suivante. Un `wedge`
s'est figé à un angle droit et se retrouvait 59 m derrière dix secondes plus
tard.

### `OFFSET_SLEW_MS` : l'offset slalome à une vitesse de formation

`SPEED_MAX` était lu deux fois : par la tête de lecture **et** par la vitesse de
l'offset. Un budget partagé corrige la première moitié (la vitesse monde d'une
unité est celle du point de sillage **plus** celle de l'offset, donc écrêter
l'offset à `SPEED_MAX` autorisait un total de 46 m/s sur un airframe qui en vole
24). La seconde moitié demande un plafond **plat** : dans une épingle, la tête
de lecture décroche, le budget se rouvre au-delà de 24 m/s précisément sur la
frame où la doctrine change de côté, et l'offset traverse la rue.

C'est une vitesse de **formation**, pas la vitesse de l'airframe, et toute la
matrice de pénétration est calibrée dessus. Mesuré sur le tirage large
(24 graines, tailles 6..12, 12/15/22 m/s, 3 024 vols par cadence) :

| | avec `OFFSET_SLEW_MS` | budget seul |
|---|---|---|
| épingle 60 fps | 0,85 m | 1,54 m |
| épingle 30 fps | 1,23 m | 1,80 m |
| slalom 60 fps | 0,47 m | 0,77 m |
| slalom 30 fps | 0,84 m | 0,83 m |

Le slalom ne bouge pas, et c'est le point : le plafond de slew concerne la
**traversée** d'une géométrie que les rayons n'ont pas ré-autorisée, et un
slalom ne demande jamais à l'offset de traverser.

### Ce que la montée de `vMax` a coûté aux constantes

Comme prévu, un airframe plus rapide creuse mécaniquement les transitoires de
repli. Sur un tirage assez large pour avoir une distribution (48 graines,
tailles 6..12, 12/15/18/22/26/30 m/s, 4 032 vols), l'épingle sous frames de
250 ms passe de **3,44 m** (airframe à 24) à **4,12 m** (airframe à 40), contre
un plafond de 4,5 m : 9 % de marge, c'est-à-dire la dernière mesure avec un
chiffre rond posé dessus — le mode d'échec que ce fichier documente déjà deux
fois. `LONG_FRAME_CEILING_M` passe donc à **6 m**, le tiers de marge que 4,5
avait sur 3,41 quand il a été posé.

`ACCEPTED_TIGHT_M` et `ACCEPTED_WEAVE_M` restent à 1,5 m : remesurés sur le même
tirage à 12/15/22 m/s, ils lisent 0,85 / 1,23 m (épingle) et 0,47 / 0,84 m
(slalom) — **sous** ce qu'ils lisaient avant, pas au-dessus.

Et le tirage de l'épingle aux cadences nominales passe de la rotation à huit
graines au tirage large à 24, comme le slalom : la propriété que tient
`OFFSET_SLEW_MS` est une propriété d'**épingle**, et la graine qui la révèle
(`c-39`, un `wedge`) n'est pas dans les huit que cette case tirait. Une
assertion qu'un défaut peut contourner n'est pas une assertion.

### Ce qui distingue le correctif d'un essaim aimanté

L'ancienne assertion « décroche puis rattrape » **passait sur le code cassé** :
elle tenait le nœud à 34 m/s (décrochage : vrai même quand il est définitif),
puis l'arrêtait (rattrapage : vrai parce que le nœud ne vole plus). Ce qui
sépare les deux, c'est **rattraper pendant que le nœud est toujours à fond**.
Sur le tirage du test (72 vols par ligne), écart au slot après douze secondes à
33,4 m/s :

| | départ 20 m/s | départ arrêté |
|---|---|---|
| `vMax` 24 (avant #46) | 263,51 m | 253,35 m |
| `vMax` 40, γ divisé | 17,58 m | 32,16 m |
| `vMax` 40, γ cherché | 2,93 m | 2,43 m |

La première ligne ne se stabilise pas : elle croît tant que le nœud vole, et le
vol n'est simplement pas assez long pour montrer jusqu'où. Plein manche coûte
toujours 3,9 à 18,9 m d'étirement — le décrochage est bien là, il est
redevenu **transitoire**.

## Le son : un chœur, pas douze drones

Douze voix individuelles sont exclues, et pas pour le coût : douze sinus quasi
identiques se **verrouillent en phase** et produisent exactement le son de test
de synthé que `son.md` interdit. Un essaim sonne comme un chœur — 3 voix
proches réassignées en continu aux 3 unités les plus proches, plus une nappe
statistique pour le reste.

Et la contrainte qui protège le mixage : le budget est **partagé, pas
additionné**. Un bus `others` reçoit ambiants et essaim et borne leur somme à
−12 dB sous l'`idleLevel` du joueur. Un essaim de douze ne peut donc pas, par
construction, manger la marge de 1,6 dB du limiteur. Le prix : les ambiants
perdent 3,06 dB, ce qui est l'arithmétique exacte de la part 0,7 qui leur reste.

Deux limites écrites dans le code et sorties en issue #39 : la borne ambiante
est une **convention** (4 voix à 8 m) et non un supremum, et le retour de
réverbération est **à côté** du plafond, pas dedans.

## Ce que la méthode a coûté, et pourquoi

Le modèle a demandé **cinq tours de correctifs**, plus deux tranches nées d'un
vol réel. Chaque relecture a trouvé le trou d'échantillonnage de la précédente,
et toujours sur un **axe neuf** :

| tour | axe découvert | ce qu'il cachait |
|---|---|---|
| 1 | la vitesse | pénétration systématique dès 20 m/s |
| 2 | la cadence | l'épingle sous frame de 250 ms |
| 3 | la graine | une régression nominale à 60 fps |
| 4 | la géométrie | épingle serrée et rue étroite |
| 5 | **la taille de l'essaim** | `n = 8` trois fois pire que `n = 12` |

La leçon, si on retouche ce module : **une matrice de test qui ne balaie pas les
cinq axes ne prouve rien**. Et une borne calibrée sur ce qu'on a mesuré n'est
pas une borne — celle du tour 3 affirmait une propriété du mécanisme que le
mécanisme n'avait pas, parce qu'elle oubliait le tourniquet.

Deux relectures se sont trompées, et c'est utile de le savoir : l'une a inventé
une régression à 15 fps qui n'était qu'un sous-échantillon à six graines
(1,42 contre 1,43 m sur 24 graines) ; une autre a retiré des lignes de test sur
une justification qui mélangeait deux dénominateurs. Les deux ont été corrigées
par la mesure suivante.

## Pénétrations acceptées pour la v1 — décisions, pas mesures

- **~3 m** dans le régime écrêté (frames de 250 ms) pour toute taille ≠ 12 :
  l'image est déjà saccadée, l'essaim revient en place à la frame suivante.
- **~2,3 m** à cadence nominale sur un slalom serré mais volable.
- La règle `span > 2 m` sous-détecte les **angles** de pâté de maisons (sonde
  diagonale) : issue #35, non corrigée parce que la règle est partagée avec le
  reste du jeu.

Ces nombres sont dans `tools/swarm-selftest.mjs` sous forme de constantes
nommées. **Leur rôle n'est pas d'être petits, il est d'être vrais** : une
constante ajustée à 1 cm de sa mesure échoue au premier changement de graine.

## Chemins de dev

    ?live=<lat>,<lon>&swarm=<n>&family=swarmNode
    ?swarm=<n>:<doctrine>      column | wedge | cloud | screen

`?swarm=<n>` seul tire la doctrine sur la taille — et sur la plage utile 6..12
cela donne six fois `cloud` et une fois `column`, jamais `wedge` ni `screen`.
Ce n'est pas un biais du tirage (1264/1214/1273/1249 sur 5000 graines) mais de
la malchance sur sept valeurs ; d'où la syntaxe explicite, sans laquelle
personne ne peut voir trois des quatre formations.

Jamais au banc : `MODE.bench` exclut l'essaim par construction.
