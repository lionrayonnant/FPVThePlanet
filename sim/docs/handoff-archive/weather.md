# Météo : vent, pluie, gouttes, brouillard — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> Les quatre modèles purs (wind.js, rain.js, rainfall.js, fog.js) et leurs vérifications banc + vol.
> Pour retrouver une section : `grep -n "^#" weather.md`.

## Le vent (issue #20)

`src/wind.js`, sur le moule de `link.js` : modèle pur, `physics.js` lance les
rayons, `main.js` câble. Voir `docs/manual.md` pour le modèle lui-même.

**Vérifié** — 28 checks dans `tools/selftest.mjs`, section `vent` :

- l'air calme est **bit-à-bit identique** à l'absence de modèle de vent. Ce
  n'est pas de la coquetterie : les checks « tenue d'altitude », « vitesse
  terminale » et « immobilité au sol » en dépendent, et un epsilon voudrait
  dire qu'on ajoute puis retranche quelque chose, et ce quelque chose dérive ;
- convention d'axes : vent de nord → souffle vers +Z, vent d'est → vers −X.
  C'est la seule chose ici qui pouvait être exactement à l'envers en ayant
  l'air parfaitement normale ;
- profil monotone, plafonné au-dessus de 300 m, 30 % du vent au ras du sol,
  ×2 entre 10 m et 100 m ;
- rapports de Dryden **mesurés** sur 600 s : σv/σu = 0,72 et σw/σu = 0,53
  (cibles 0,78 et 0,52 ; ~10 % d'erreur d'échantillonnage attendue) ;
- les trois boutons de rafale sont bien trois : doubler la fréquence double les
  arrivées sans changer l'amplitude, allonger la durée ne change pas la
  fréquence ;
- déterminisme : même graine, même météo, et `reset()` revient au départ ;
- sillage réel contre la Tour Eiffel, moyenné sur huit azimuts ;
- coût : 0,008 ms par sonde de dix rayons.

**Mesuré au banc** (`npm run tune`, avant/après le terme ω×r et le couple
`r × F` par moteur) — tous les axes restent dans les cibles :

| | dépassement roulis freestyle | rebond lacet race | stabilisation lacet race |
| --- | --- | --- | --- |
| avant | 0,9 % | 44,1 % | 554 ms |
| après | 0,3 % | 35,7 % | 498 ms |

`BENCH_OMEGA=0 npm run tune` rejoue l'ancien comportement pour refaire la
comparaison.

**Vérifié en vol** (`?scene=tour-eiffel`, chrome-devtools) : profil 3,2 / 11,1 /
17,4 m/s à 2 / 30 / 150 m pour un réglage à 9 m/s ; abri 0,27 et −19 % de
vitesse sous le vent de la tour contre 0,01 au vent ; ascendance +5,2 m/s le
long de la face au vent ; gigue de 0,15 m/s sur une demi-seconde, donc pas de
clignotement ; 100 fps, 6 draw calls, aucune erreur console.

**Deux bugs trouvés en vol et pas au banc**, tous deux invisibles en test
synthétique :

1. un rayon vers le bas qui ne touche rien était lu comme « 400 m d'altitude »,
   ce qui servait le vent de gradient au ras du sol dès qu'on sortait de la
   tuile ou qu'on passait sous la coque. Remplacé par une navigation à
   l'estime depuis la dernière hauteur connue ;
2. l'ascendance se déclenchait **sous le vent** au lieu de la face au vent. Le
   mur qu'un drone est sur le point de heurter est sous le vent de lui, donc
   c'est le rayon 4 qui le trouve, pas le rayon 0.

**Pas vérifié** : le ressenti manche en main. Le banc dit que le modèle est
cohérent et le navigateur dit que les nombres sont les bons, mais « est-ce que
voler dans une tempête est difficile de la bonne façon » ne se mesure pas ici.

**Reste ouvert** : l'issue chapeau #19 garde deux volets — nuages (#22) et
soleil (#23). Le fait transverse qui les décide : la photogrammétrie est **non
éclairée**, son ombrage est cuit dans les textures, et un soleil mobile
double-ombrerait la ville.

## La pluie (issue #24)

`src/rain.js` (modèle pur, sans THREE) + `src/rainfall.js` (les stries) +
`loader.setFog()` pour la visibilité. Voir `docs/manual.md` pour le modèle.

**Vérifié au banc** — 17 checks, section `pluie` de `tools/selftest.mjs` :

- le temps sec est **inerte**, au sens strict : aucun filtre n'avance, aucun
  nombre aléatoire n'est tiré, `fogScale` vaut exactement 1. Même promesse que
  l'air calme pour le vent, et pour la même raison ;
- couper la pluie **rend l'image** : `fogScale` revient à 1 et la lentille
  sèche. C'est le bug qu'un `return` trop tôt aurait laissé passer ;
- variabilité 0 → le taux vaut **exactement** le réglage ; variabilité 75 % →
  0,94 fois le réglage en moyenne d'ensemble sur 16 graines. Le déficit est réel
  et va dans le bon sens : la correction lognormale suppose un bruit gaussien et
  le nôtre est borné à 3 σ ;
- relations publiées vérifiées à 5 mm/h : 1,25 mm à 4,4 m/s, 338 gouttes/m³,
  5,7 km de visibilité, et les extinctions s'ajoutent bien en parallèle ;
- la lentille se couvre en stationnaire (0,83) et se dégage en vol (0,24 à
  18 m/s) ;
- les quatre signes de `dropDrift`, qui sont la seule chose ici qui pouvait être
  exactement à l'envers en ayant l'air normale.

**Vérifié en vol** (`?scene=tour-eiffel`, chrome-devtools, DOM en direct) :
100 fps, **+1 draw call**, 5 200 stries à 12,5 mm/h ; le vent de #20 incline
bien les stries et allonge la strie (0,030 → 0,051 m à 18 m/s) ; la pause
**arrête la pluie net** (`uOffset` figé) et la reprise repart ; le ciel passe de
`#9FB8CC` à `#8D99A2` et le brouillard de 0,00085 à 0,00186 sous l'averse, puis
revient exactement à ses valeurs claires — donc pas de retour du bug #10.

**Le bug qui a coûté le plus de temps, et qui est silencieux** : la strie est un
billboard reconstruit intégralement en espace vue dans le vertex shader, donc
son enroulement dépend du sens dans lequel la goutte passe devant la caméra. Il
sort **dos à la caméra**, et avec le `FrontSide` par défaut *chaque* strie est
culled — sans erreur, sans warning, avec le draw call bien émis et les 56 000
triangles bien comptés dans `renderer.info`. Un `side: DoubleSide` le corrige.
Une géométrie qui se compte mais ne se voit pas, c'est le culling de faces, pas
le shader.

**Assumé et non physique** : `STREAK_WIDTH_GAIN` dans `rainfall.js`. À taille
réelle, la profondeur optique du champ proche est sous le pourcent et une strie
fait un tiers de pixel — le résultat honnête est qu'on ne voit rien. Seule la
largeur est exagérée, jamais l'opacité, et le nombre est divisé par le même
facteur. Le PSF du capteur, le flou de mise au point à un mètre et le glint de
la goutte, qui sont les trois vraies raisons pour lesquelles on voit la pluie
sur une vraie vidéo, ne sont pas modélisés.

**Pas fait, et pourquoi** :

- **sol mouillé, réflexions, éclairage d'averse** → issue #29, bloquée par le
  même arbitrage éclairage que #22 et #23 ;
- la pluie **n'attaque pas le lien vidéo** : à 5,8 GHz l'atténuation sur 500 m
  est négligeable, et l'inventer serait faux.

**Pas vérifié** : le ressenti. Voler dans une averse est-il difficile de la
bonne façon, et la baisse de visibilité est-elle gênante au bon endroit — ça ne
se mesure pas ici.


## Les gouttes sur la lentille (issue #28)

Le troisième volet de la pluie, sorti de #24 après deux rendus rejetés à l'œil
(réfraction, puis taches blanches opaques). `lensDrops()`, `dropFootprint()` et
`LensDrops` dans `src/rain.js` ; le rendu dans le bloc `#if DROPS` de
`src/lens.js`.

**Ce qui a débloqué la chose**, et qui explique du même coup pourquoi les deux
tentatives précédentes ne pouvaient pas marcher : ce n'est pas une question de
mise au point mais de **quels rayons la bille touche**. Chaque point du hublot
est traversé par tout le cône que la pupille d'entrée accepte, donc une bille de
diamètre D à un recul s intervient sur la convolution de la bille par la
pupille — un disque angulaire de (D + A)/s, à cœur plat sur (D − A)/s. Trois
conséquences, et les trois étaient demandées dans #28 :

- l'empreinte est **grande et ne dépend presque pas de la taille de la goutte** :
  six fois la goutte donne 2,8 fois l'empreinte. Un millimètre d'eau, trente
  degrés d'image ;
- une goutte **plus petite que la pupille n'est jamais opaque**, quelle que soit
  sa taille, parce qu'elle ne peut que rogner une partie du cône. C'est
  « certaines presque invisibles, d'autres beaucoup plus présentes », et c'est
  de la géométrie, pas une opacité tirée au hasard ;
- le bord doux vient gratuitement, et sa douceur est le diamètre de la pupille.

**Le nombre qui surprend** : un hublot de dix millimètres divisé par une bille
de trois en fait **moins d'une dizaine**. Une lentille mouillée, ce sont sept ou
huit grosses taches, jamais un champ. D'où une liste d'uniformes et pas un champ
procédural — et donc aucune grille, qui était le défaut de la tentative 2.

**Les deux erreurs faites en route**, notées parce qu'elles se ressemblent :

1. **échantillonner le disque au lieu du cône.** L'étendue du disque est la
   convolution ci-dessus ; son *contenu* vient de tout ce que la bille diffuse,
   qui est bien plus large. Sampler le disque donne l'image de derrière, floue,
   c'est-à-dire une bavure. C'est `DROP_BLUR` et `DROP_SKY` ;
2. **le blanc écrit comme du blanc.** Le retour du pilote après la première
   passe était « trop grise, blanc terne mais blanc ». Décaler l'échantillon
   vers le haut ne va chercher le ciel que s'il y en a juste au-dessus, alors
   que l'hémisphère de collecte d'une bille est dominé par le ciel où que la
   caméra pointe. La moyenne est donc mélangée vers **la couleur de ciel que la
   scène utilise déjà** (`rainSky()`, celle du fond et du brouillard) : rien
   n'est inventé, une goutte ne peut pas être plus claire que le ciel qu'elle
   tient, et devant le ciel elle reste exactement invisible. Même argument que
   le `LIFT` de `rainfall.js` ;
3. **le bord lumineux écrit comme un gain.** Multiplier ce qui est déjà là
   dessine un anneau bien visible sur un ciel uniforme, alors que concentrer une
   lumière identique dans toutes les directions ne change rien. Le rim est donc
   écrit comme une **collecte plus large** : lumineux devant une façade parce
   qu'il va chercher plus loin dans le ciel, exactement invisible devant le ciel.

**Une chaîne de mips sur la cible du composer**, et c'est le seul changement que
les gouttes imposent au reste : la moyenne large est bruitée si on la prend avec
une poignée de taps — ça sortait en grain, pas en eau. Un niveau de mip *est*
cette moyenne, pondérée correctement et pour un tap. Rien d'autre dans la passe
ne demande de niveau biaisé.

**Le piège de #24 est dissous plutôt que corrigé** : la population est en JS et
avance sur un `dt`, donc un `dt` nul l'arrête net. Il n'y a pas de seconde
horloge à oublier, et `uDropTime` n'existe pas.

**Vérifié au banc** — 10 checks de plus dans la section `pluie` : compte et
taille contre l'humidité, coalescence, les deux propriétés de l'empreinte,
lentille sèche inerte, stationnaire qui garde ses gouttes en cadre, eau qui
remonte le cadre en vol rapide, image gelée qui fige l'eau.

**Vérifié en vol** (`?scene=tour-eiffel`, chrome-devtools, DOM en direct) :
100 fps et 7 draw calls sous l'averse ; cinq gouttes à 0,64 d'humidité pour des
billes de 3,7 mm ; la pause fige les gouttes et le `Espace` les relance ; en
numérique, **345 images gelées d'affilée sans que l'eau bouge d'un pixel** ;
couper la pluie ramène `DROPS` à 0, donc au shader d'avant, octet pour octet.

**Pas vérifié, et c'est la seule spec qui compte** : l'œil du pilote. La densité,
la distribution de tailles et la durée de vie sont exactement ce que #28 disait
qu'il resterait à trouver, et les constantes de `lens.js` sont groupées en haut
du fichier pour être bougées ensemble.



## Le brouillard (issue #21)

`src/fog.js` (modèle pur, sans THREE) + `loader.setFog()` pour la densité et la
couleur + le voile d'objectif dans `src/lens.js`. Voir `docs/manual.md` pour le
modèle. `TileMaterial.js` **n'a pas été touché** : l'extinction exp² qui y était
déjà suffit tant qu'il n'y a pas de terme d'altitude.

Le choix qui structure tout le reste : l'unité exposée est une **distance**, et
la correspondance curseur → portée est **géométrique** entre l'air clair de la
scène (≈ 2035 m) et 30 m. C'est ce qui rend `i = 0` exactement la densité que la
scène chargeait déjà, donc l'air clair bit-identique à un monde sans modèle de
brouillard — la même promesse que l'air calme et le temps sec, et la raison pour
laquelle la régression `#9fb8cc` tient telle quelle.

Deuxième choix : brouillard et pluie **s'additionnent en extinctions** plutôt
que de se multiplier en facteurs. `FOG_DENSITY × rain.fogScale` est par
définition `FOG_DENSITY + extinction de la pluie`, donc le bloc de #24 est
remplacé par une généralisation stricte et le check « les extinctions
s'ajoutent » de la section `pluie` reste vrai sans être touché.

**Vérifié au banc** — 14 checks, section `brouillard` de `tools/selftest.mjs`,
et surtout : **toutes les sections existantes sortent octet pour octet
identiques** à `HEAD` (diff contre un worktree propre). C'est le vrai test de la
neutralité, plus que les checks eux-mêmes.

- l'air clair ne bouge rien et **ne tire aucun nombre aléatoire** ;
- la loi est géométrique (la moitié du curseur est la moyenne géométrique) et
  monotone sur les 101 positions ;
- les présets tombent à 1 % près sur les visibilités dont ils portent le nom ;
- variabilité 0 → densité rigoureusement constante ; variabilité 1 → moyenne
  d'extinction à 1,005 du réglage sur six graines × 100 min ;
- fog off reproduit `FOG_DENSITY × rain.fogScale` **au bit** ;
- redescendre le curseur rend l'image, et la même graine rejoue le même temps.

Le check de moyenne a d'abord échoué à 0,825 sur **une** graine × 20 min. Ce
n'était pas un biais : la bande lente a deux minutes de mémoire, donc vingt
minutes font une dizaine d'échantillons indépendants et une graine seule se
balade entre 0,8 et 1,2. Mesuré sur 4 graines × 200 min : 1,04 / 0,96 / 1,12 /
0,99. Le modèle est non biaisé, c'était le test qui était sous-échantillonné.

**Vérifié en vol** (`?scene=tour-eiffel`, chrome-devtools, DOM en direct, aucune
erreur ni warning console) :

- curseur à 0, passe neutre, lien coupé : `#9fb8cc` **exact**, trois lectures
  d'affilée, et `GLARE` vaut 0 dans les `defines` — le voile est compilé dehors ;
- 500 m : la ville lointaine se dissout, l'horizon rejoint le fond **sans
  couture au bord de tuile**, la Tour proche reste nette ;
- 162 m à 52 m AGL : la Tour s'efface vers le haut, le sol sous elle reste
  lisible, et il n'y a de noir nulle part dans l'image — c'est ce que le voile
  fait ;
- 50 m : ciel `#c9d0d4`, pixel rendu `#c4cbcd` ;
- retour à 0 : `#9fb8cc` exact et `GLARE` revenu à 0 ;
- brouillard 500 m + averse 3390 m → 436 m, soit exactement les deux en
  parallèle, et le ciel s'arrête entre le gris de pluie et le blanc de
  brouillard ;
- panneau : les quatre présets s'allument bien, l'étiquette affiche « air clair
  / 1,2 km / 505 m / 50 m », et les réglages sont retenus.

**Choisi à l'œil et non mesuré** : `GLARE_R = 0,06`, `GLARE_MIX = 0,35`,
`GLARE_SKY = 0,45` dans `lens.js`, et `FOG_SKY = #c9d0d4` dans `main.js`. Il n'y
a pas d'optique réelle à laquelle les caler, exactement comme `K1`/`K2`/`CA`.
Ce qui n'est **pas** à l'œil : le voile et la couleur sont pilotés par la même
échelle log que la visibilité, donc ils ne peuvent pas raconter autre chose que
ce qu'on voit.

**Deux effets de bord assumés, hors du périmètre de l'issue mais dans son
chemin** :

- `rainfall.setSky()` — les stries gardaient la couleur de ciel dégagé quelle
  que soit la météo, parce que `uColor` était figé à la construction. Le
  brouillard rendait le défaut criant ;
- `respawn()` appelait `physics.reset()` et `link.reset()` mais ni
  `rain.reset()` ni `fog.reset()`, alors que les deux modèles documentent dans
  leur propre commentaire qu'un respawn ne doit pas vous relâcher dans le grain
  qui vient de vous aveugler. Les deux sont appelés maintenant.

**Pas fait, et c'est une issue à part** : la **brume au sol**, le brouillard de
vallée et la variation de visibilité avec l'altitude. Ils demandent une position
monde en varying dans le fragment shader de `TileMaterial.js` et l'intégrale
analytique du brouillard de hauteur — c'est un travail de shader, pas de
modèle. Le halo directionnel autour du soleil attend #23 : la scène est non
éclairée, il n'y a pas de source à laquelle accrocher un halo.

**Pas vérifié** : le ressenti, comme pour la pluie. Que 500 m soit le bon
« brouillard » et 50 m la bonne « purée » vient des classes OMM, pas d'un vol.
Un point à surveiller : à variabilité élevée la respiration peut passer sous les
30 m nominaux (mesuré : 28 m autour d'un réglage à 162 m). C'est physique — un
banc plus épais que la moyenne — mais à intensité 1 **et** variabilité 1 ça
devient injouable. Aucun garde-fou n'a été mis : les deux curseurs sont un choix
du pilote.
