# Changelog

Toutes les modifications notables de FPVThePlanet! sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
versionnage suit [SemVer](https://semver.org/lang/fr/). La source de vérité du
numéro est le champ `version` de `sim/package.json` ; chaque version publiée
porte un tag git `vX.Y.Z` et une GitHub Release.

Rubriques : `Ajouté`, `Modifié`, `Corrigé`, `Retiré`, `Déprécié`, `Sécurité`.

Ce qui précède la première version se lit dans le `git log` : le dépôt a vécu
98 commits avant d'être versionné.

Note : les numéros de build de l'écran `BUILD NOTES`
(`sim/tools/buildnotes-model.mjs`) sont du lore diégétique et n'ont aucun
rapport avec les versions ci-dessous.

## [Non publié]

### Modifié

- L'acquisition se joue maintenant en trois écrans au lieu d'un seul qui change
  de contenu : l'analyse automatique, puis `MANUAL OVERRIDE REQUIRED` et
  `[ JACK IN ]` seuls au milieu de l'écran, puis `CONTROL ACQUIRED` et
  l'empreinte de la machine qui se trace. Le geste ne partage plus son image
  avec le log qui le précède ni avec le résultat qui le suit. `[ JACK IN ]`
  passe au niveau DISPLAY, prend le focus et respire en pas pour se lire comme
  une invite en attente (#67).

- Les écrans s'enchaînent au lieu de se remplacer : un écran qui s'en va
  s'imprime à l'envers — les deux mêmes pas que l'impression d'entrée, sur la
  durée la plus courte — et le suivant n'est monté qu'ensuite. La cascade du
  second ne commence plus dans la frame où le premier disparaît. Entre deux
  écrans de terminal, seul le CONTENU s'en va — le fond noir tient jusqu'au
  démontage, sinon la scène 3D déjà chargée apparaissait le temps de la
  transition. Seul le dernier écran, celui qui donne sur le vol, emmène son
  fond avec lui. `screen()` gagne un `close()` pour ça ; `remove()` reste
  synchrone partout où l'on quitte simplement un menu. `[ JACK IN ]` récupère au passage la cascade d'impression
  dont sa propre animation le privait (#67).

- Au crash, l'empreinte de la machine perdue passe d'à côté de l'aperçu 3D à
  SOUS lui : la même machine vue de deux façons, l'une sous l'autre. Elle garde
  le corps de 22 px du reste de l'écran de fin, et ne redescend à 11 px — l'autre
  taille nette de Departure Mono — que sous 820 px de hauteur de fenêtre, où la
  colonne repousserait `[ENTER] DISCONNECT` hors de l'écran (#67).

### Corrigé

- L'écran de fin nommait `[ESC] DISCONNECT`, c'est-à-dire la seule touche que le
  navigateur peut confisquer : en pointer lock, et a fortiori en plein écran, il
  garde Échap pour rendre le curseur et ne délivre aucun `keydown` à la page. Sur
  l'écran dont la seule raison d'être est qu'on en sorte, la ligne promettait donc
  une touche qui pouvait ne jamais arriver — mesuré par `__sim.endState()`, toutes
  gardes propres, la sortie armée et le geste sans effet. Les trois tables (crash,
  sortie de zone, coupure du lien) nomment maintenant `[ENTER] DISCONNECT`. Échap
  reste acceptée en doublon silencieux, comme le clic et n'importe quel bouton de
  manette (#71).

### Ajouté

- Le randomart devient l'empreinte de la cible : une machine, un art, le même à
  chaque fois qu'on la retrouve. Il se trace sous les yeux de l'opérateur après
  `[ JACK IN ]`, se fige au crash à côté du portrait de la machine perdue, et
  signe la fiche de session dans les archives (#57).

- Bannières de marque : cinq images composées — marque, nom et accroche sur le
  fond `--black`. Celle de 1280 × 320 ouvre désormais le `README.md`, à la place
  de l'icône seule de 72 px : elle porte déjà la marque ET le nom. Celle de
  1200 × 630 devient la carte Open Graph de `sim/index.html`, avec ses métas
  `og:` et `twitter:card` — sans `og:url`, parce que `deploy/` ne fixe aucun
  domaine et qu'une URL canonique fausse vaut moins que pas d'URL. Les trois
  dernières (social preview du dépôt, bandeau large, carré) attendent un
  téléversement manuel là où elles vont. Seule la carte Open Graph entre dans
  `sim/public/` : c'est la seule qu'une page doit servir, les quatre autres
  restent dans `docs/brand/` et ne pèsent ni sur le bundle ni sur l'installeur.
  Manifeste C2PA retiré sans réencoder, comme le reste de la marque.
  `docs/marque.md` dit où va chacune.

- La marque entre au dépôt (#58). `sim/public/brand/` porte les trois SVG —
  `fpvtp-mark.svg` en `currentColor`, `fpvtp-icon.svg` sur son fond `--black`,
  `fpvtp-mark-extrude.svg` pour l'extrusion — et `png/` sept tailles de 16 à
  1024, deux fois : la marque seule et l'icône sur fond. `docs/marque.md`
  devient la source de vérité de la géométrie, des verrouillages, de la zone de
  respect et des interdits ; le README ouvre dessus.
- Les fichiers arrivaient avec un manifeste de provenance C2PA d'environ 9 Ko
  chacun — un PNG 16×16 qui pesait 6 Ko. Il est retiré sans réencoder l'image :
  dans les PNG tous les chunks hors `IHDR`/`PLTE`/`IDAT`/`IEND`/`tRNS`, dans les
  SVG le bloc `<metadata>` et l'attribut `xmlns:c2pa`. Les dix-sept fichiers
  pèsent 27 Ko au lieu de 190 (#58).

- Essaim de drones (issue #29), tranche « apparition » : un TARGET SCAN peut
  désormais tirer un *cluster* — un nœud de commandement et ses 6 à 12 unités —
  avec 10 % de chance, et de façon certaine au 3e scan si les deux premiers
  n'ont rien donné. Le cluster est toujours le signal le plus fort ; sa fiche
  pré-hack dit `EST. MESH — MULTIPLE EMITTERS`, `(STRONGEST OF GROUP)` et
  `COUNT UNKNOWN`, sans jamais révéler la machine ni la taille. Le tirage vit
  sur un flux aléatoire séparé : à `swarmChance = 0` les candidats sont
  identiques à ceux d'avant, graine par graine. La session persiste
  `target.swarm` et `target.scan.swarmAt/swarmChance`
  (`SESSION_SCHEMA_VERSION` passe à 3, sans migration : une session v2 n'a
  simplement pas d'essaim). Un cluster laissé de côté vole comme UNE unité
  ambiante. Chemin de dev : `?swarm=<n>` sur `?scene=` et `?live=`.

- Essaim de drones (issue #29), tranche « apparition à l'écran » : le cluster
  hacké vole enfin. `src/drone-shape.js` gagne deux recettes — l'unité de
  reconnaissance 3" (carènes, caméra nue, pack 3S, antenne unique, LED forte à
  l'arrière) et le nœud 6" que le joueur pilote (dôme de liaison, deux
  antennes, pack 6S) — et `src/swarm-drones.js` porte l'instance : une seule
  géométrie fusionnée et un seul matériau de corps pour toutes les unités,
  24 draw calls à douze. L'essaim se pose au début du vol, se remet sur le
  joueur au respawn et sur `__sim.teleport`, se tait au banc, et n'a aucun
  effet sur le jeu. `__sim.debug().swarm` rend `{size, doctrine, raysCast,
  blockedUnits, lagRange, drawCalls}`. `?swarm=<n>` donne maintenant vraiment
  `n` unités — et refuse tout ce qui sort de 6..12 au lieu de le rabattre en
  silence —, et `?family=swarmNode` ouvre un chemin de dev
  vers le nœud sans le faire entrer dans le tirage ordinaire.

- Essaim de drones (issue #29), tranche « le son » : l'essaim s'entend.
  `src/swarm-audio.js` ne synthétise pas douze drones — douze sinus quasi
  identiques se verrouillent en phase et donnent le son de test de synthé que
  le projet s'interdit — mais un **chœur** : trois voix proches, réassignées en
  continu aux trois unités les plus proches (gain, coupure, Doppler écrit à la
  main, détune et lent wander), plus une nappe pour tout le reste, bruit
  passe-bande étroit et trois sinus désaccordés autour de la fréquence de pale
  moyenne. 24 nœuds, le même ordre que les ambiants ; rien au-dessus de
  1,6 kHz, donc rien dans les 2–4 kHz où se fabrique la fatigue auditive.
  Surtout, le budget devient **partagé et non additionné** : un bus `others`
  (`src/audio-others.js`) reçoit ambiants et essaim et borne leur somme à
  −12 dB sous l'`idleLevel` du joueur, quelle que soit la taille de l'essaim —
  au prix d'environ 3 dB sur les ambiants, qui n'ont plus le plafond pour eux
  seuls. Silence au gel de la physique et à la mort de la liaison, envoi vers
  l'acoustique du lieu comme les ambiants.

- Essaim de drones (issue #29), tranche « le modèle de vol » : `src/swarm.js`
  fait voler la nuée sans jamais la faire traverser un mur, et **sans lancer un
  rayon pour ça**. Le principe : là où le joueur est passé est libre par
  construction, donc les unités volent dans son sillage — un anneau de 512
  positions écrit toutes les 20 ms — et le pire comportement possible est « ils
  volent en file indienne dans tes traces ». Chaque unité tient un slot
  `(retard, latéral, vertical)` lu sur la piste et rejoint par un ressort qui
  vit sur l'abscisse curviligne du sillage, ce qui rend le découplage
  impossible : à marge nulle, l'unité est exactement sur la polyligne. Un
  tourniquet de 6 rayons par frame valide les décalages latéraux, seul endroit
  où le bâti peut mordre, et la marge s'achète **par rayon vert** et non par
  seconde — sans quoi l'essaim se repliait en file en plein ciel sous 25 images
  par seconde. Bornes physiques réelles : plein manche, l'essaim décroche puis
  rattrape.

- Essaim de drones (issue #29), tranche « l'essaim entoure le joueur » : les
  doctrines étalaient jusqu'à 2 s de retard, soit 40 m de traînée à 20 m/s —
  invisible en FPV, où l'on regarde devant. Elles étalent désormais en largeur
  et en hauteur ce qu'elles étalaient en longueur, sans élargir d'un pouce la
  fenêtre avant, qui extrapole du terrain non validé. Les quatre restent
  distinctes, parce qu'elles sont le catalogue de formations à venir (#34) :
  `column` garde sa traînée, `screen` vole en écran devant. Nouveau chemin de
  dev `?swarm=<n>:<doctrine>` — sans lui, le tirage sur la plage 6..12 ne
  produit jamais `wedge` ni `screen` et trois formations sur quatre restent
  invisibles.

- Piste de vol (issue #24) : une session enregistre désormais ce qu'elle a fait,
  pas seulement ses maxima — un échantillon à 5 Hz (temps, position, altitude,
  vitesse, gaz, taux de rotation), le point de départ, les captures
  géolocalisées et l'état au moment où la liaison meurt. Écrite en une fois à la
  clôture, dans `operator-state/tracks/<opérateur>/<session>.json`, 200 pistes
  retenues par opérateur. Nouvelles routes `PUT`/`GET
  /__operator/:id/sessions/:sid/track` et `GET /__operator/:id/tracks?bbox=`
  (index décimé pour la carte) ; les sessions rendues portent `hasTrack`.
- Carte enrichie (issue #25) : une bascule `ENRICHED` en haut à droite du GLOBAL
  SCANNER pose sur la carte ce que l'opérateur y a laissé — les traces de vol en
  polylignes fines et sans couleur par vol, les captures en petits carrés qui
  deviennent des vignettes à partir du zoom 16, et une croix à chaque perte de
  liaison, datée au survol et regroupée avec un compteur tant que deux croix
  tombent à moins de 20 px. Tout est cliquable vers la fiche de session
  existante. Éteinte, la carte est exactement celle d'avant et n'émet aucune
  requête ; l'état est retenu dans les réglages de l'opérateur.

- `ARCHIVE` devient `DATA` : une page qui défile, neuf sections de graphes mono
  — `RHYTHM`, `LIFE`, `SPEED × ALTITUDE`, `HOW THEY DIED`, `STICKS`,
  `FAMILIES`, `GEOGRAPHY`, `PROFILE`, `RECORDS` — où l'opérateur lit sa propre
  façon de voler. Aucun score, aucun niveau, aucune comparaison : ce qui s'est
  passé, dessiné. Les sections qui ont besoin d'une piste de vol affichent
  `NO TRACK` tant qu'il n'y en a pas ; les autres se lisent depuis les agrégats
  de session, qui ne sont jamais jetés (#26).
- `src/graph.js`, un petit kit de dessin canvas mono (barres, nuage, escalier,
  histogramme) dans la typographie du terminal : une encre, et le magenta
  seulement sur l'élément sélectionné (#26).
- `tools/data-model.mjs` et son selftest : toutes les séries des neuf sections
  sont calculées là, l'écran n'en calcule aucune (#26).

### Modifié

- Le randomart de session (un art différent par vol) est remplacé par celui de
  la cible. Les sessions déjà écrites gardent le leur (#57).

- L'application prend la marque (#58). `sim/electron/build/icon.png` passe de 512
  à 1024 px pour l'installeur NSIS et l'AppImage, et le favicon de
  `sim/index.html` devient trois `<link>` vers `brand/png/` (16, 32, 48) au lieu
  du data URI collé en dur. La marque est une grille de pixels : les exports
  hintés restent nets là où un SVG rééchantillonné à 16 px ne l'est pas.
- Les exports matriciels reviennent dans la palette : ils étaient rendus en
  `#0a0a0a` / `#e6e3dc` quand `tokens.css` dit `--black: #0a0908` et
  `--warm-white: #ece7dd`. Les deux couleurs sont échangées à l'identique plutôt
  que l'image re-rastérisée, pour ne pas perdre le hinting (#58).

- La fiche pré-hack du `TARGET SCAN` disparaît en tant qu'écran : ce qu'elle
  portait tient sur la ligne du signal, qui gagne le device à côté du RSSI et
  du mode vidéo — `01   -57 dBm   ANALOG   CINEWHOOP`. Activer la ligne choisit
  la cible, une frappe au lieu de deux. Sur les sept champs de la fiche, quatre
  (`LOCATION KNOWN`, `DEVICE PARTIAL`, `CONTROL UNKNOWN`, `FLIGHT STATE
  UNKNOWN`) valaient la même chose pour toutes les cibles de tous les scans :
  ils décrivaient le jeu, pas le signal, et n'ont jamais départagé deux choix ;
  un cinquième, `CONDITIONS`, est déjà en tête de la liste. Les trois niveaux
  `KNOWN / EST. / UNKNOWN` de la Bible §15 survivent intacts, et un cluster
  garde ses trois mentions sans révéler ni la machine ni la taille (#49).
- Les lignes du scan sont calculées par `tools/target-model.mjs:scanLines()`,
  pas par l'écran : l'alignement des colonnes est une propriété de l'ensemble
  des candidats — sans quoi la ligne longue d'un cluster décalerait toutes les
  suivantes. Construites depuis `describeTarget()`, elles héritent de sa
  garantie, désormais vérifiée sur la chaîne réellement affichée plutôt que sur
  un objet intermédiaire : jamais la famille, jamais le type de hack, jamais le
  vrai mode vidéo d'un signal non mesuré (#49).

- Le `TARGET LOG` disparaît en tant qu'écran : ses entrées se lisent dans la
  section `FAMILIES` de `DATA`, groupées par famille de cible et rangées sous la
  survie moyenne qu'elles ont laissée (#26).
- `fpvtp.mode` resté sur `archive` retombe sur `data` : un opérateur retrouve
  son curseur là où il l'avait laissé (#26).

- La portée de vue passe de 300 m à **600 m par défaut**, et le curseur VIEW
  RANGE monte jusqu'à **2 km** au lieu de 600 m (issue #32). Ce qui le
  permet : la table `LOD_RINGS` s'arrêtait à `levelDrop: 2`, donc tout au-delà
  de 300 m était chargé au niveau 19 et la portée coûtait au carré. Elle
  descend maintenant d'un niveau par doublement de distance jusqu'à 2 km —
  1200 m coûtent 1270 nœuds au lieu de 1806, et 2000 m en coûtent 1370, soit
  +37 % par rapport aux 600 m d'avant pour 3,3× la distance. Mesuré à Paris :
  300 m → 740 nœuds, 892 textures, 64 fps ; 600 m → 1003 nœuds, 1200 textures,
  62 fps ; 2000 m → 1370 nœuds, 1635 textures, 56 fps. La couverture reste
  exacte à chaque portée (`tools/rocktree-lod-selftest.mjs` la verrouille
  désormais jusqu'à 2 km : 26 521 nœuds au niveau plein → 732 avec le LOD,
  chaque point du disque couvert exactement une fois).

- Le fondu de bord du terrain live suit désormais le rayon (un sixième,
  plafonné à 250 m) au lieu des 50 m fixes : sur un disque de 2 km, 50 m de
  frange ne se voyaient plus et le bord redevenait la coupure nette que ce
  fondu existe pour effacer. À 300 m il retrouve exactement sa valeur d'avant.

- Le pool de workers de nœuds passe de 3 à 6. Avec les anneaux prolongés, le
  goulot n'est ni le réseau ni le budget de build mais le décodage
  (580 Kio d'ImageBitmap par nœud). Mesuré en vol continu à 35 m/s, portée
  2 km : à 3 workers la file de fetchs montait à 219 nœuds en attente et le
  sol manquait 0,86 % du temps ; à 6, elle ne s'accumule plus (0) et le manque
  tombe à 0,44 %, pour 50 fps au lieu de 51.

- Un nœud que le LOD remplace par un AUTRE NIVEAU (le même sol qui passe du
  niveau 21 au 20 en s'éloignant) n'est plus retiré de la scène avant que son
  remplaçant n'y soit posé. C'est le gros du churn : à 600 m de portée, un
  recentrage change le niveau de ~124 nœuds contre ~16 qui quittent vraiment
  le disque. La fenêtre marque la libération `covered` et `main.js` la diffère
  jusqu'à ce que sa file de builds soit vide — c'est là, et pas dans la
  fenêtre, que la décision doit se prendre : la fenêtre ne connaît que ses
  fetchs, et libérer au retour du réseau (premier essai) creusait un trou PLUS
  grand qu'avant. Effet mesuré, honnêtement : le pic de sol absent passe de
  6,03/6,13 % à 5,67/5,67 % sur deux paires de passes, la moyenne reste dans
  le bruit (1,21/1,67 % contre 1,48/0,99 %). Le mécanisme supprime une classe
  de trous par construction ; son gain chiffré est faible.

### Retiré

- `faviconDataURI()` de `src/pixel-icons.js` : le favicon ne vient plus du drone
  pixel art. L'option `background` d'`iconSVG()` part avec lui — elle n'existait
  que pour ce data URI, qui ne voyait pas les `var(--…)` de la page. Les neuf
  icônes elles-mêmes restent, `drone-portrait.js` et `drone-wire-svg.js` les
  utilisent (#58).

### Corrigé

- `main` était rouge : le retrait du CONTROL VECTOR (#33) a renommé
  `tools/ritual-selftest.mjs` et `tools/ritual-bench.mjs` en
  `tools/intro-primitives-*`, mais `selftest:operator` appelait toujours les
  anciens noms. La chaîne mourait en `MODULE_NOT_FOUND` au milieu du log, après
  plusieurs minutes, et toute PR ouverte échouait avec elle. `release-selftest`
  — premier maillon de la chaîne — vérifie désormais que **chaque** chemin
  `.mjs` cité par un script de `package.json` existe, et les nomme tous d'un
  coup au lieu de laisser node buter sur le premier.

- L'écran de fin de vol pouvait devenir une impasse : ni Échap, ni Entrée, ni
  le clic, ni la manette n'en sortaient (issue #20). La sortie était en fait
  DÉJÀ partie — le geste manette « n'importe quel bouton déconnecte » (#123)
  la déclenchait dès l'armement — et elle ne revenait jamais : `finishSession()`
  posait son verrou d'idempotence AVANT les deux actes qui peuvent ne pas
  aboutir, un `flush()` réseau et la navigation. Le `catch` du flush ne voit
  qu'un rejet, jamais une promesse qui ne s'installe pas, et rien ne relevait
  le verrou : tout geste ultérieur ressortait en silence. Le verrou et ces deux
  actes vivent désormais dans `src/flight-exit.js`, pur et couvert par
  `tools/flight-exit-selftest.mjs` : le flush a un plafond (1,5 s), et une
  navigation qui n'a pas emporté la page rend le geste au joueur au bout de
  3 s plutôt que de condamner l'écran.

- Trous et z-fight dans le terrain LIVE après quelques centaines de mètres de
  vol (régression du LOD par anneaux, #22). Depuis ce LOD, l'`exclude` d'un
  nœud — les octants qu'un nœud plus fin redessine à sa place — dépend de la
  position de la fenêtre, mais `RocktreeWindow.update()` traitait un nœud déjà
  chargé comme définitif tant que son chemin restait désiré : il gardait le
  maillage construit avec l'ancien `exclude`. Le nœud fin sortait du premier
  anneau et était libéré, l'octant restait exclu chez le grossier, et plus rien
  ne le dessinait. Mesuré à Paris, rayon 600 m : 70 nœuds périmés dès le
  premier recentrage de 50 m, 171 sur 706 (500 octants troués, 108 dessinés en
  double) après 300 m de vol. Un nœud dont l'`exclude` change est désormais
  libéré et reconstruit ; le refetch ne touche pas le réseau (Cache API du
  pool, #21).

- L'« anneau qui recharge » en volant : le nœud reconstruit ci-dessus est
  désormais ÉCHANGÉ, pas libéré puis rebâti. Les libérations passant avant les
  builds, l'ancien maillage partait aussitôt et le sol manquait tout le temps
  du refetch — un anneau de terrain disparaissait à chaque recentrage, le
  temps d'une seconde. La fenêtre marque la libération `replaced` et garde le
  mesh à l'écran ; `processLiveNodeWork()` retire l'ancien dans la frame même
  où il pose le nouveau. Mesuré en jeu, saut de 80 m : pic de sol absent
  8,17 % → 1,99 % à 550 ms, et ce qui reste est du sol RÉELLEMENT neuf (la
  couronne entrante), pas un trou. Si le refetch échoue pour de bon, l'ancien
  mesh est retiré à ce moment-là plutôt que laissé orphelin.

- La PAUSE gelait le chargement du terrain. `processLiveNodeWork()` et le
  recalcul de fenêtre vivaient sous le `if (!frozen)` de la boucle de frame :
  mettre en pause arrêtait net la file de builds, et le monde restait à moitié
  construit tant qu'on ne reprenait pas — mesuré, saut dans une zone vierge :
  478 builds bloqués en file et 79 % du sol absent pendant TOUTE la pause,
  tout revenu 1,2 s après la reprise. Or c'est précisément en pause qu'on
  regarde le paysage, et qu'on le photographie : les artefacts qu'on croyait
  voir sur les captures étaient un chargement suspendu. Le streaming n'est pas
  de la simulation ; il tourne désormais aussi en pause, panneau de réglages
  ouvert et intro figée. Le filet anti-trou (#189) reste gelé, lui : il
  déclenche un respawn.

- Essaim de drones (issue #46) : **les unités étaient trop lentes pour le nœud
  que le joueur pilote.** `SWARM_UNIT.vMax` valait 24 m/s, et c'est ce nombre
  qui borne la vitesse à laquelle une unité parcourt le sillage — sous le
  plafond du `swarmNode`, mesuré au banc d'enveloppe à **33,4 m/s**, une unité
  lisait donc le sillage moins vite que le nœud ne l'écrivait, et décrochait
  **définitivement** au lieu de décrocher puis rattraper. `vMax` passe à 40 m/s,
  20 % au-dessus du plafond mesuré et honnête pour un 3" de 330 g.

  Monter ce nombre ne suffisait pas : le limiteur de pas **divisait** γ par deux
  au lieu de le chercher, et la tête de lecture ne peut pas capitaliser d'avance
  (elle est écrêtée à l'échantillon de sillage le plus récent, qui avance par
  pas de 20 ms quelle que soit la cadence). Chaque pic de cette dent de scie
  coûtait une demi-frame que les frames plates ne rendaient pas, si bien que le
  mécanisme plafonnait en réalité à 0,81 × `vMax` — 32 m/s, sous les 33,4 du
  nœud. γ est désormais cherché par dichotomie, et l'essaim suit jusqu'à 95 % de
  sa propre vitesse maximale. Écart au slot après douze secondes à 33,4 m/s :
  263 m avant, 2,93 m après.

  La vitesse de slew de l'offset est découplée de celle de l'airframe
  (`OFFSET_SLEW_MS`) : c'est une vitesse de **formation**, et sans ce plafond
  plat un airframe plus rapide traverse une rue plus vite qu'il ne devrait
  (1,54 m dans le bâti contre 0,85 m, en épingle à 60 fps). `LONG_FRAME_CEILING_M`
  passe de 4,5 à 6 m : un airframe plus rapide creuse les transitoires de repli,
  et 4,5 m ne laissait plus que 9 % de marge sur la mesure.

- Essaim de drones (issue #29) : **on ne voyait aucun drone devant soi.** Deux
  correctifs justes pris séparément se combinaient en porte à sens unique — le
  plafond de marge se paie par rayon mais se reconstitue par seconde, or les
  éclaireurs sont les seules unités testées à chaque frame, donc affamées dès
  1,3 % de rayons bloqués ; puis, à marge nulle, le repli en file les rangeait
  *derrière* le joueur. Ils ont maintenant leur propre sonde avant, tirée le
  long de la tangente pure du sillage — le volume où le joueur est sur le point
  de voler, donc l'extrapolation la plus sûre de la scène — et elle ne coûte
  **qu'un seul rayon pour tout l'essaim**, leurs segments étant colinéaires. La
  proportion d'unités effectivement devant le pilote passe de 2 % à 75 %.

### Retiré

- Le CONTROL VECTOR (issue #33) : une suite de 4 à 8 flèches que le joueur
  définissait au premier lancement et devait retaper de mémoire à **chaque**
  acquisition de cible pour terminer le hack. Le rapport qui a ouvert #33
  disait « la page de hack peut se figer et rendre confus l'utilisateur » ; la
  lecture du code donnait pire — l'écran n'écoutait que les quatre flèches, ne
  posait aucun Échap, et sa promesse n'avait pas de `reject` : un joueur qui
  avait oublié son vecteur restait bloqué **jusqu'au rechargement de la
  page**, avec toute la boucle de jeu (`fieldLoop`) suspendue derrière lui. Le
  geste ne demandait par ailleurs aucune compétence de pilotage — mémoriser un
  secret hors du jeu, payé à chaque cible.

  Remplacé par un bouton unique, `[ JACK IN ]` : ce n'est pas une invention,
  c'est l'état qui précédait le rituel, devenu définitif. `[ESC] ABORT` est
  monté dès l'affichage de l'écran de hack, utilisable pendant tout le
  chargement — abandonner résout `runHack()` en `{ aborted: true }` et
  recharge la page de zone, exactement comme l'annulation d'un TARGET SCAN.

  `src/ritual.js` et `tools/ritual-model.mjs` sont supprimés ;
  `tools/ritual-selftest.mjs` et `tools/ritual-bench.mjs` sont renommés
  `intro-primitives-selftest.mjs` et `intro-primitives-bench.mjs` — ils
  continuent de couvrir les onze primitives ASCII que `src/intro.js` exécute
  à chaque lancement du jeu, indépendamment du rituel disparu. `RITUAL` sort
  du vocabulaire sonore (`UI_EVENTS` : sept entrées, `SYSTEM`/`LINK`
  seulement) et le bloc CSS `.ritual*` disparaît ; les quatre couleurs de demo
  scene (cyan/magenta/violet/bleu électrique) n'ont plus qu'un porteur, la
  cracktro de lancement.

  Le schéma opérateur passe en **v3** : `migrate()` supprime la clé
  `controlVector` de tout état déjà écrit — la laisser dans `freshState()`
  seul l'aurait laissée survivre inerte. Côté serveur, `controlVector` sort de
  `OP_WRITABLE_KEYS` et `validateControlVector` disparaît avec son import.

## [0.3.0] - 2026-09-08

### Ajouté

- Le menu a quatre voies au lieu de deux : `FIELD`, `BENCH`, `ARCHIVE`,
  `SETTINGS`, à la racine et dans cet ordre. ARCHIVE n'est plus un lien enterré
  dans un onglet de FIELD, SETTINGS n'est plus répété à trois endroits, et
  `fpvtp.mode` retient les quatre (#6, #7).
- Un briefing de quatre écrans (`INPUT`, `THE TERMINAL`, `A SESSION`,
  `BRIEFING COMPLETE`) accueille un opérateur qui vient d'être créé, juste
  après le CONTROL VECTOR. Il énonce, il n'ordonne pas ; Échap le saute ;
  `[ CALIBRATE ]` et `[ MAP KEYS ]` ouvrent le bon onglet de `SETTINGS` et
  reviennent, et l'écran `INPUT` lit le mappage en direct. Il se rejoue par
  `SETTINGS` › `SYSTEM` › `[ REPLAY BRIEFING ]`. Le premier vol hors banc
  affiche trois lignes brèves — `THROTTLE UP`, `[TAB] SETTINGS`,
  `[HOLD K] CUT LINK`, cette dernière nommant la touche réellement liée et
  comptée depuis le décollage — puis plus jamais (#16).
- Le panneau `SETTINGS` (Tab) passe à la direction artistique du terminal :
  en-tête `FPVTP! // SETTINGS`, quatre onglets `CONTROLLER · KEYBOARD · AUDIO
  · SYSTEM`, un corps à la fois, et l'onglet ouvert est retenu pour la session.
  `KEYBOARD` liste chaque action avec ses touches et un `[ REBIND ]` : la
  touche suivante est prise, Échap annule, une touche déjà prise déclenche un
  échange annoncé sur la ligne, `[ RESET KEYS ]` remet les valeurs d'usine.
  `SYSTEM` porte la portée d'affichage (mode `?live=`), `[ RESET SETTINGS ]`
  et le numéro de version (#15).
- Les commandes clavier passent par une table remappable (`src/key-map.js`) :
  une action porte un nom (`throttleUp`, `pause`, `cutLink`…), ses touches se
  changent, et les valeurs par défaut couvrent QWERTY et AZERTY (W/Z, A/Q).
  Réglages rangés dans `fpvtp.keyMap` ; Tab, Échap et Entrée restent fixes.
- La caméra libre (`C`, une orbite qui gelait le monde) devient une bascule de
  vue `V` : FPV / CHASE. La vue CHASE est la caméra de vol reposée 1,1 m
  derrière le nez et 0,45 m au-dessus, champ plafonné à 75° et OSD de la cible
  débranché (c'est une caméra extérieure, pas le flux vidéo), la simulation
  continue de tourner derrière elle, et elle marche sur tous les chemins
  (LOCAL, LIVE, BANC). Un
  bouton `[V] FPV` / `[V] CHASE` en haut à droite de l'OSD fait le même geste
  à la souris. Chaque vol commence en FPV (#12).
- L'écran de fin de vol montre la machine perdue en 3D, celle qui volait —
  livrée, numéro et châssis compris — et on peut la tourner à la souris. Elle
  tourne seule d'un tour toutes les 24 s. Sans contexte WebGL, le portrait fil
  de fer d'avant prend le relais ; l'archive, elle, garde le SVG (#13).
- Tests couvrant qu'un vol EN DIRECT remplit bien le Session Log, le Target
  Log et le compteur OPERATOR, et n'est jamais proposé en REVISIT/RESUME (#8).

### Modifié

- FIELD ouvre sur l'onglet `LIVE`, désormais placé avant `LOCAL` : c'est la voie
  qui marche sans rien avoir téléchargé. Sur un serveur qui n'acquiert pas,
  l'onglet LOCAL est éteint et dit en trois lignes pourquoi, au lieu de laisser
  une liste vide (#6).
- La tête de FIELD ne salue plus l'opérateur (la racine le fait, une fois) et
  son pied ne compte plus rien : il dit `LOCAL INSTALLATION · BUILD n` ou
  `SHARED SERVER · BUILD n`. Les compteurs vivent dans ARCHIVE › OPERATOR (#6).
- Échap est écrit sur les écrans qui l'écoutent : `[ESC] OPERATION MODE` sous
  FIELD, BENCH et ARCHIVE, `[ESC] BACK` sur les écrans en dessous (#7).
- Le panneau `SETTINGS` prend le noir du terminal, ses filets et ses trois
  niveaux typographiques, et remplace son bouton `Close (Tab)` par la ligne de
  touches `[ESC] CLOSE · [TAB] CLOSE`. Le rappel clavier figé qui vivait sous
  `Controls` a disparu : l'onglet `KEYBOARD` le remplace, et il dit la vérité.
- L'écran affiche la vraie version du paquet (`v0.0.0`, ou `dev` hors build
  Vite) au lieu de la constante de lore `0.97b` (#9).

- **Le chargement des cartes LIVE ne refait plus la marche rocktree à chaque
  recalcul** (#21). `kh.google.com` interdit au cache HTTP de garder ses
  réponses : tous les 50 m de vol, la fenêtre de streaming redemandait les
  344 bulks d'une fenêtre de 300 m depuis la racine. La traversée est
  désormais pipelinée (16 bulks en vol, plus de lots séquentiels de 8) et
  garde ses bulks dans le worker pour toute la session ; la fenêtre ne
  désire que les nœuds dont la boîte recoupe le disque de chargement (15,7 %
  de nœuds en moins, tous dans le brouillard de bord) ; `bootLive()` lance
  la première traversée avant d'attendre Rapier et crée ses workers
  d'emblée. Mesuré, service réel, 60 ms de latence émulée par requête :
  traversée de boot 4,3 s → 2,0 s, recalcul en vol 3,5 s → 80 ms.
- **Build de production découpé et précompressé** (#21). Rapier (2 Mo de
  WASM en base64) est chargé par `import()` dans `src/physics.js` — chunk
  séparé, préchauffé pendant le terminal, le menu ne l'attend plus ; `three`
  a son propre chunk, en cache d'une version à l'autre. `npm run build`
  enchaîne `tools/precompress.mjs` (`.br`/`.gz` à côté des fichiers texte,
  4,8 Mo → 1,0 Mo) et `server/static.mjs` les sert avec `Content-Encoding`,
  `Vary`, une ETag par représentation, jamais sur un `Range`, jamais si la
  variante est plus vieille que sa source. Onze vérifications de plus dans
  `server-selftest.mjs`.
- **Niveau de détail par anneaux en LIVE** (#22) : niveau 21 jusqu'à 150 m
  du drone, 20 jusqu'à 300 m, 19 au-delà (`tools/lib/rocktree/lod.mjs`). Une
  traversée par anneau (les suivantes servies par le cache de bulks), puis un
  assemblage qui fait exclure aux nœuds grossiers les octants qu'un nœud plus
  fin dessine — chaque point du disque couvert exactement une fois, vérifié
  sur un octree synthétique jusqu'aux coutures. Mesuré, service réel : 1259 →
  740 nœuds à 300 m, 4176 → 1003 à 600 m.
- **Cache disque des réponses rocktree** (#22, `src/rocktree-cache.js`,
  Cache API) : NodeData et BulkMetadata persistent entre sessions dans les
  Workers — REDEPLOY et un second vol au même endroit ne repassent plus par
  le réseau. Jamais PlanetoidMetadata (l'epoch), jamais une réponse non-ok,
  5000 entrées au plus, fetch nu sans Cache API.

### Corrigé

- Une installation locale ne se présente plus comme un serveur partagé. Le pied
  de FIELD et l'avis de l'onglet `LOCAL` se lisaient sur le droit d'acquérir,
  fermé par défaut sur toute build distribuée : le client de bureau affichait
  donc « SHARED SERVER » et se conseillait à lui-même d'installer le client de
  bureau. `GET /__map-api/scenes` rend désormais le `mode` du serveur
  (`local` | `shared`), et c'est lui qui décide de ces deux formulations ;
  `DRAW BOX` / `DRAW SHAPE` continuent de se lire sur le droit d'acquérir.
- Le portrait de la machine manquait sur deux fins de vol sur trois — sortie de
  zone et lien coupé — et sur tout vol NOMINAL (`?family=`, `?scene=`, `?live=`,
  NOMINAL au banc), faute d'exemplaire tiré. Chaque fin porte désormais son
  portrait, et une famille sans tirage en a un déduit de son nom (#13).
- Face au soleil, l'exposition ferme moins fort : entre 55 et 75 % de son
  niveau au repos au lieu de tomber à 35 %, l'image reste pilotable (#11).

### Retiré

- Le lien `MODE` du pied de FIELD (Échap faisait déjà exactement la même chose),
  les liens `SETTINGS` du pied de FIELD, de la rangée ARCHIVE et du pied du
  banc, l'entrée `ARCHIVE` de la rangée LOCAL, la ligne `DESKTOP CLIENT
  AVAILABLE` et la mention `STREAMED NOW · NOTHING KEPT · NEEDS THE LINK` de
  l'onglet LIVE, qui était fausse : un vol en direct est archivé comme les
  autres (#6, #7).
- L'atterrissage. Un vol se termine par un crash, une sortie de zone ou le
  pilote qui coupe le lien (K maintenue) : plus de désarmement (touche J, geste
  manette), plus de verdict `LANDED`, plus d'écran `POST-FLIGHT ANALYSIS` ni de
  reprise de session. Les vieux journaux qui portent `LANDED` se relisent et
  s'affichent tels quels (#10).

## [0.1.0-beta] - 2026-09-07

### Ajouté

- `sim/server/` — le jeu démarre sans Vite (#259, tranche T1 du design de
  déploiement). `node server/index.mjs [--data <dir>] [--port 8080]
  [--host 127.0.0.1] [--mode local|shared] [--dist <dir>] [--open]`, avec les
  variables d'environnement `FPVTP_DATA_DIR`/`FPVTP_PORT`/`FPVTP_HOST`/
  `FPVTP_MODE`. `api.mjs` porte `/__operator` et `/__map-api` — les deux tables
  de routes déplacées telles quelles, aucun chemin, aucune méthode, aucun code
  de statut ni aucune forme de réponse ne changent ; `static.mjs` sert le
  `dist/` de Vite, avec `Range` (reprendre le téléchargement d'un chunk de
  scène), ETag faible, `Cache-Control: immutable` sur `/scenes/<slug>/*`, et
  **aucun repli SPA** : un fichier absent rend un 404 JSON, jamais `index.html`
  (le pendant serveur de #275). Aucune dépendance npm : du `node:http` nu.
- `sim/tools/lib/paths.mjs` — un seul module résout le répertoire de données
  (`scenes/`, `scenes.json`, `operator-state/`, `cache/google-earth/`). Sans
  `FPVTP_DATA_DIR`, il rend exactement les chemins d'aujourd'hui : `npm run dev`
  ne bouge pas d'un octet, et `FPV_OPERATOR_DIR` reste honoré.
- `sim/tools/server-selftest.mjs` (26 vérifications) et
  `sim/tools/vite-adapter-selftest.mjs`, chaînés dans `selftest:ci`.
- `LICENSE` (GNU AGPL-3.0-only) et un `README.md` à la racine : le dépôt se
  prépare à devenir public. `docs/manuel.md` reste le README technique.
- `.githooks/pre-commit` — refuse un commit signé par une adresse hors liste
  blanche. `git config core.hooksPath .githooks` l'active dans un clone.
- **Le jeu s'installe comme un jeu** (#291, tranche T2) : un installeur `.exe`
  sous Windows — entrée Menu Démarrer, désinstalleur — et une `AppImage` sous
  Linux. L'app est un seul process Electron qui démarre le serveur du jeu sur
  la boucle locale, sur un port éphémère, et ouvre une fenêtre dessus : ni
  terminal, ni navigateur à part. Les données (scènes, sessions, état
  opérateur) vivent hors du dossier du programme — `app.getPath('userData')`,
  forcé sur `%LOCALAPPDATA%` plutôt que le `%APPDATA%` itinérant par défaut —
  donc une mise à jour n'écrase rien. `electron-updater` est câblé sur un flux
  HTTP générique (le dépôt est privé : GitHub Releases demanderait un jeton à
  chaque téléchargement) dont l'adresse reste un point d'ancrage explicite tant
  que le serveur n'existe pas. Pas de macOS, pas de signature de code :
  décisions actées.
- **Une clé d'opérateur pour les serveurs partagés** (#60, tranche T3). Créer
  un opérateur produit un secret de 128 bits — base32 sans caractères ambigus,
  groupé par 4 — stocké haché en SHA-256 et rendu une seule fois. Un serveur en
  `--mode shared` le réclame en `Authorization: Bearer` sur `/__operator/:id/*`
  et `/__map-api/*` (401 sans, 403 avec une mauvaise) et ne publie plus
  d'annuaire (404 sur la liste). L'inscription reste **en libre service** —
  c'est le cas nominal sur un serveur partagé — mais plafonnée par adresse, et
  les captures d'un opérateur ont un plafond cumulé. `GET /__operator/whoami`
  retrouve un profil par sa clé depuis un autre navigateur, et
  `node server/index.mjs key <id>` en délivre une neuve : c'est la migration
  des fichiers existants et la seule voie de récupération. **Un serveur `local`
  ne lit jamais l'en-tête** : sa frontière reste le socket, `npm run dev` ne
  change pas.
- **Côté joueur, la clé se tait** : le navigateur la garde, l'inscription ne
  fait rien noter à personne, et `[ SHOW KEY ]` dans ARCHIVE > OPERATOR la rend
  le jour où l'on veut emporter son profil ailleurs — sur le modèle de
  `[ SHOW VECTOR ]`, sans jamais se confondre avec le Control Vector. Un
  serveur qui ne reconnaît pas le navigateur ouvre un écran où
  `[ NEW OPERATOR ]` est l'action principale et la saisie d'une clé la porte de
  secours.
- **`deploy/`** (#292, tranche T4) : l'unité systemd du serveur en mode partagé
  (écoute sur la boucle locale seulement, données hors du dossier du programme,
  acquisition délibérément fermée, `ProtectSystem=strict`), la configuration
  Caddy de ses deux entrées publiques — le jeu derrière TLS, et un sous-domaine
  statique et sans authentification qui distribue les installeurs et leurs
  fichiers de mise à jour — un script de livraison qui télécharge une release
  privée, bascule un lien symbolique, redémarre et vérifie que le service
  répond avant de rendre la main, en laissant la version précédente intacte
  pour un retour arrière en deux commandes, et la checklist qu'un humain suit
  une fois pour préparer une machine neuve. Rien n'est déployé : la première
  livraison reste manuelle.

### Modifié

- Dépendances remontées (PR #5, groupe `npm_and_yarn`) : sharp 0.33 → 0.35,
  Vite 5 → 6, electron-builder 25 → 26, et Electron 33 → 44 — pas 39 comme
  proposé initialement : 39 est hors de la fenêtre de support d'Electron (les
  trois derniers majeurs) et laissait ouverte l'alerte de traversée de chemin
  d'`extract-zip`. `npm audit` ne rapporte plus rien. Aucune des ruptures d'API
  de sharp 0.35 (`failOnError`, `paletteBitDepth`, `jp2k`) n'était utilisée.
- `sim/electron/main.js` suit la nouvelle signature du relais
  `console-message` : Electron ≥ 36 passe un seul objet d'événement et un
  `level` textuel, pas quatre arguments avec un niveau numérique. L'ancienne
  forme ne journalisait plus rien.
- `sim/tools/map-api-plugin.mjs` n'est plus qu'un adaptateur Vite de vingt
  lignes : il monte `createApi()` sur les middlewares du serveur de dev, avec
  son logger. Toute la logique a migré dans `sim/server/api.mjs`.
- `sim/tools/session-api-selftest.mjs` teste désormais le serveur autonome
  plutôt que Vite — il teste ce qui est livré, et il passe de 208 ms à 85 ms.
- **L'acquisition de terrain est fermée par défaut** (#60) : elle n'est active
  que si `FPVTP_ACQUIRE` vaut `1` ou `true`, et **jamais** en `--mode shared`,
  quoi qu'il arrive — deux gardes indépendantes. Fermée, elle retire
  `[ DRAW BOX ]` et `[ DRAW SHAPE ]` de l'écran et laisse l'onglet LIVE, qui
  porte déjà la boucle complète ; une ligne au pied signale alors le client de
  bureau, sans rien promettre de plus que jouer chez soi. **Conséquence pour le
  développement : `npm run dev` veut désormais `FPVTP_ACQUIRE=1` dans
  l'environnement pour retrouver `ACQUIRE AREA`.**
- **La CI vérifie le dépôt sous Windows autant que sous Linux** (#291) : la
  matrice `{ubuntu, windows}` de `ci.yml` a déjà fait tomber une comparaison de
  chemin (`provider-selftest.mjs`) et deux dépendances à la locale du système.
  Un `.gitattributes` racine impose `eol=lf` : une soixantaine de selftests
  découpent sur `\n`, et `core.autocrlf` est vrai par défaut sur les runners
  Windows.
- `sim/public/scenes.json` est committé **vide** : c'est un fichier généré, propre
  à chaque installation, et il portait trois entrées fantômes qui faisaient
  échouer `npm run selftest:scenes` et affichaient trois scènes inexistantes sur
  un clone neuf. `node tools/sync-scenes.mjs --adopt` le reconstruit depuis le
  disque.
- `tools/imagery-selftest.mjs` (16 vérifications) est enfin chaîné dans
  `selftest:operator` : il existait sans jamais tourner.
- **La release publie de quoi démarrer un serveur** : `release.yml` attache
  désormais un `fpvtp-server-<tag>-linux-x64.tar.gz` (`app/` avec `server/`,
  `tools/`, `src/`, `dist/`, plus le runtime Node de la version qui vient de
  passer les selftests) à côté de l'archive `dist` seule. C'est ce que
  `deploy/deploy.sh` installe. Aucun `npm install` sur le VPS : le serveur
  démarre sans `node_modules`, mesuré.

### Modifié

- **Le nom `fpvmaps` disparaît du dépôt**, jusqu'au préfixe des clés
  `localStorage` (`fpvmaps.` → `fpvtp.`), au nom du paquet npm (`fpvtp-sim`),
  à celui du plugin Vite (`fpvtp-map-api`) et à la métadonnée `generator` des
  `.glb` exportés. **Aucune migration** : un joueur qui met à jour repart avec
  des réglages neufs — calibrage manette, volumes, réglages d'objectif. Son
  opérateur, lui, n'est pas perdu : il vit côté serveur, et `OPERATOR SELECT`
  le repropose.
- Le README de la racine est réécrit autour de ce qu'un nouveau venu vit
  vraiment : une capture d'écran, ce qu'on peut faire **tout de suite** sur un
  clone neuf (voler en LIVE, puisqu'il n'y a aucun terrain sur disque), les
  contrôles, et les trois façons de faire tourner le jeu.
- Le dépôt est désormais `lionrayonnant/FPVThePlanet` : toutes les références
  internes, `deploy/deploy.sh` et l'unité systemd comprises, pointent dessus.

### Modifié

- **La release publie ce qu'il faut pour héberger sa propre instance.**
  L'archive `fpvtp-server-<tag>-linux-x64.tar.gz` emporte désormais `deploy/`
  (unité systemd, Caddyfile, script de livraison, checklist) et la `LICENSE` —
  que l'AGPL exige de faire accompagner le programme distribué — en plus du
  serveur, du jeu construit et d'un runtime Node. Toujours aucun `npm install`
  à faire sur la machine d'accueil. La licence voyage aussi dans l'application
  Electron (`extraResources`).
- Le corps de la GitHub Release liste maintenant les fichiers et dit lequel
  télécharger selon qu'on veut jouer ou héberger.
- Le workflow refuse de publier une archive qui ne démarre pas : le runtime
  embarqué doit résoudre `server/index.mjs` avant que l'archive soit scellée.
- L'archive `fpvtp-sim-<tag>.zip` (le `dist/` seul) disparaît : elle ne pouvait
  pas démarrer — c'est précisément ce que #259 reprochait aux « livraisons »
  d'avant.

### Modifié

- **Un seul README, à la racine.** Le dépôt en avait deux, et rien ne disait
  lequel lire : `sim/README.md` devient `docs/manuel.md` — il reste entier,
  mais ce n'est plus un README. La racine est la porte d'entrée, le manuel est
  le manuel. Les références de la documentation vivante suivent ; les plans et
  specs d'archive gardent les leurs, ils racontent ce qui a été édité ce
  jour-là.

### Corrigé

- Le scanner disait `NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP` alors que
  `[ DRAW BOX ]` et `[ DRAW SHAPE ]` sont masqués quand l'acquisition est
  fermée (#60) : il demandait l'impossible à quiconque venait d'installer le
  jeu. Il indique désormais l'onglet LIVE, qui est réellement la façon de
  décoller dans ce cas.

### Retiré

- `sim/qualite-test/` (6,3 Mo) : quatre extraits `.opus` et une page d'écoute
  A/B, procès-verbal d'un arbitrage sur les réglages de génération musicale
  (#122) — rien dans le dépôt n'y renvoyait.
- `sim/tools/area-row-measure.html` : page de mesure jetable d'une décision CSS
  déjà prise ; la mesure reste consignée dans `src/style.css`.
- `sim/vite.ngrok.config.js` : il portait en dur le nom d'hôte d'un tunnel
  personnel, et aucun script ne l'appelait. Exposer le serveur de dev passe
  désormais par le serveur autonome, qui a ses propres garde-fous.


- Apple Flyover comme fournisseur de photogrammétrie : `tools/lib/providers/
  flyover.mjs`, le dépôt `flyover-reverse-engineering/` (outil Go, jeton,
  tuiles brutes), le job CI associé, et l'option `--provider flyover` de
  `add-map`. `google-earth` — sans clé ni jeton, Node pur — est désormais le
  seul fournisseur inscrit. Les scènes déjà bakées chez Flyover gardent leur
  attribution Apple correcte (`src/provider-credit.js`) ; le contrat par
  fournisseur reste dispatché par `opts.provider` pour un futur second
  fournisseur.

### Ajouté

- Dans le champ, les cloches moteur (#286) : la pièce de livrée la plus
  proche de l'objectif n'était qu'au portrait. Elle est au niveau `onboard`
  — elle vit sous le plan d'hélice, la borne de hauteur ne la voit pas.
- Éclairage hémisphérique ciel/sol sur la machine : les dessus prennent le
  ciel, les dessous le sol. En free cam elle n'est plus une silhouette contre
  le ciel quel que soit le soleil.
- Le fil de fer ne trace plus le détail sous 200 px (`minWeight`) : moyeux,
  fixations, rubans et boîtier disparaissent au lieu de s'atténuer — à
  160 px ils faisaient une tache.
- Le `TARGET LOG` légende le portrait de la dernière cible de sa livrée, sur
  la ligne sous `LAST TARGET`.

### Corrigé

- Le banc changeait de cellule sans reconstruire le drone du joueur (#286,
  noté au HANDOFF depuis #264) : les hélices de l'ancienne machine restaient
  dans le champ. Il est reconstruit avec l'exemplaire qui vole.

- Le châssis varie par build (#285, `tools/target-frame.mjs`, `build.frame`,
  flux de graine à part) : patron `x`, `h`, `deadcat` ou `unibody` pondéré par
  famille, largeur des bras, hauteur de la cage — aux niveaux `onboard` et
  `portrait`. Les moteurs ne bougent pas (invariants de famille que la
  physique lit), la silhouette des ambiants non plus. Un bras arrive TOUJOURS
  à son moteur, et c'est un test.
- La GoPro a un objectif (#285) et son boîtier est dans la livrée : noir deux
  fois sur trois, sinon en TPU de la couleur du montage, rarement blanc.
- Le propriétaire laisse sa marque (#285) : un numéro de course sur le pack
  — trois chiffres 3×5 dessinés par le shader, lus depuis l'arrière — pour un
  peu plus d'un build sur deux, et du ruban de couleur au bout des bras pour un
  peu moins. Le ruban est dès `onboard` : les bouts de bras sont dans le champ.
  Le numéro entre dans la légende de la fiche SESSION LOG (`#042 · PROPS …`).
- Dev : `?build=<graine>` à côté de `?family=` vole un exemplaire tiré ;
  `VITE_ROCKTREE_BASE` surcharge le préfixe `kh.google.com` pour une
  vérification headless derrière un proxy.

### Modifié

- Vu EN JEU, à travers l'objectif (#285, Chromium headless sur une scène
  Google Earth) : le voile du disque d'hélice de #283 n'était qu'une ombre
  brune au bas du cadre — densifié (2,0 − 1,1·r au lieu de 1,55 − 0,85·r) ;
  la free cam recule de 0,55 m au lieu de 0,8 (à 0,8 m la machine faisait
  encore 7 % du cadre).

- Une livrée par build (#284) : chaque exemplaire a désormais SES couleurs —
  hélices, cloches moteur, TPU (fixations, conduits, brins), pack, LED — et le
  pas de son tissage carbone, tirés de la graine sur un flux à part
  (`seed::livery`), donc sans déplacer un seul tirage physique. Pondérées par
  famille : un race5 a des hélices néon huit fois sur dix, un long range des
  hélices fumées trois fois sur quatre. `tools/target-livery.mjs` est pur,
  couvert par `tools/target-livery-selftest.mjs`. Les ambiants héritent : à
  cent mètres c'est leur LED qui change, en free cam leurs hélices. Le disque
  en régime prend la couleur des pales.
- Une matière par pièce : le maillage porte une classe par sommet — carbone
  (sergé procédural en espace corps, cousu sur la pièce, qui module l'albédo
  et surtout le reflet : une mèche brille, la suivante mate), métal (reflet
  serré), plastique (hélices, TPU, pack).
- La fiche SESSION LOG légende le portrait de la livrée (`PROPS NEON GREEN ·
  BELLS GOLD · TPU ORANGE`) : le portrait reste monochrome — c'est le
  terminal —, mais la fiche dit de quelles couleurs était la machine.
- Deuxième passe sur la livrée, regardée sur 24 générations (#284) : les
  machines n'étaient plus des confettis mais pas encore des builds. Une part
  des livrées est désormais **assortie** — TPU, cloche, sangle et LED
  reprennent la teinte des hélices quand la table d'en face la connaît —, le
  boîtier de caméra est en TPU, le pack a sa sangle, la plaque sa barre de LED
  (émissive, de la couleur de la LED), et un quart des race5 vole en hélices
  **bicolores** (bout d'une autre couleur, sur les pales comme sur le disque en
  régime). Et l'**usure** : lue dans le build — âge du pack, traînée de
  montage — et jamais tirée, elle met de la poussière sous la machine, des
  éraflures, éteint le brillant et blanchit les bouts de pales. Ce qui se voit
  est ce qui se sent.

- Les frames du joueur, regardables (#283). Rendus à 160, 200 et 400 px et
  regardés, les portraits fil de fer de #264 étaient une tache : des pales en
  parallélépipèdes vrillés dont les douze arêtes se croisaient au moyeu, des
  cloches moteur qui doublaient les cylindres et traversaient le plan
  d'hélice, un stack enfermé dans la batterie. La pale est désormais une
  primitive à part entière — un planform effilé, bout arrondi, léger sabre,
  pas qui décroît de l'emplanture au bout — décrit UNE fois (`bladeOutline()`)
  et lu par le maillage Three comme par le fil de fer. Le niveau `portrait`
  gagne des moyeux, une cage de caméra sur les châssis freestyle et les
  fixations d'antenne que la spec promettait ; ses cloches portent l'hélice au
  lieu de la traverser.
- En vol, dans le champ : les pales TOURNENT au ralenti — chaque moteur
  accumule sa phase avec le pas de temps, et le vertex shader fait tourner ses
  pales autour de son axe, dans son sens — avant de s'effacer dans le disque.
  Le disque lui-même est ce qu'une caméra voit d'une hélice en régime : les
  fantômes des pales courbés par le rolling shutter, un voile plus dense au
  moyeu qu'au bout, un bord qui s'éteint en douceur, vingt-quatre côtés au
  lieu de douze.
- Un reflet sur la machine : Blinn-Phong large (une machine faite de boîtes
  n'accroche pas un reflet serré) et un liseré de contre-jour. Sans eux, à un
  mètre comme à huit centimètres, le carbone était une silhouette noire.
- Le fil de fer hiérarchise ses traits comme un dessin technique : tracé du
  lointain au proche, opacité ET épaisseur qui suivent la profondeur, et un
  poids par primitive — disques, bras et plaque en fort, moyeux et brins en
  fin. Un petit cylindre a moitié moins de côtés. Le trait de la fiche
  d'archive tient enfin le pixel (0,010 au lieu de 0,006), et la fiche se
  regarde d'un peu plus haut (28° au lieu de 22°) pour que les disques
  s'ouvrent.
- La free cam montre la machine du joueur au niveau `portrait` — pales à
  l'arrêt, cloches, moyeux — et recule de 0,8 m au lieu de 1,5 : à 1,5 m elle
  faisait 4,7 % du cadre.
- `.drone-portrait` et `.session-portrait` ont enfin leurs règles CSS.

- Une machine qui réagit au manche pendant le calibrage (#281), comme l'onglet
  Receiver de Betaflight : le pilote poussait un manche et ne voyait qu'une
  barre, rien ne disait ce que ce manche allait FAIRE au drone. C'est le fil de
  fer des portraits d'archive — la vraie recette du quad projetée en segments,
  sans Three ni WebGL. Pendant `YAW` le signal le plus écarté fait lacer la
  machine, pendant `ROLL` il l'incline, le gaz la fait monter dans le cadre, et
  `HANDS OFF` la laisse immobile parce que c'est la consigne. Un canal qui vient
  d'être attribué rejoue son geste une fois, seul : la confirmation que le
  mappage est le bon. Une fois la mesure finie elle suit les quatre manches
  calibrés — le banc d'essai vient gratuitement.
- `wireOf()` accepte une **attitude de la machine** (roulis, tangage, lacet) en
  plus de l'orbite de caméra. Attitude nulle : sortie identique au portrait
  d'archive, qui ne bouge pas.

- Calibrage automatique des radios et des manettes (#277) : un assistant guidé
  dans le panneau Tab (`CALIBRATE`) qui MESURE le périphérique au lieu de le
  deviner à partir de sa chaîne USB. Une consigne à la fois — neutre, gaz,
  lacet, tangage, roulis — d'où sortent le neutre réel de chaque axe, la course
  réelle, le bruit au repos (qui devient le deadband) et le mode de course du
  gaz, observé en lâchant le manche plutôt que déduit de la marque. Deux axes
  poussés ensemble, ou un axe déjà pris, font redemander la consigne au lieu
  d'attribuer un mappage faux en silence. `src/calibration.js` est une machine à
  états pure, couverte par `tools/calibration-selftest.mjs`.
- `node tools/sync-scenes.mjs --adopt` réenregistre dans `scenes.json` les
  scènes présentes dans `public/scenes/` mais absentes du catalogue (#275) :
  les deux dérivent dans les deux sens, l'outil ne savait retirer que les
  fantômes. Chaque entrée est reconstruite depuis le `manifest.json` de la
  scène. L'adoption est explicite : `scenes.json` est versionné.
- `npm run selftest:ci` couvre le chargeur face à un fichier absent
  (`tools/loader-guard-selftest.mjs`).

- Versionnage du dépôt (#257) : `CHANGELOG.md`, version SemVer dans
  `sim/package.json`, tags `vX.Y.Z`.
- `npm run release -- patch|minor|major|X.Y.Z` : bump de la version, datation
  de la section « Non publié », commit `chore(release)` et tag annoté. Le push
  reste manuel.
- Workflow GitHub `release.yml` : sur un tag `v*`, build du sim puis création
  de la GitHub Release, corps repris du CHANGELOG et archive `dist` attachée.
- La version est exposée au runtime : `__APP_VERSION__` injecté par Vite et
  `window.FPVTP_VERSION` dans la console au démarrage.
- `npm run selftest:release` couvre le modèle pur du versionnage.
- Intégration continue (`.github/workflows/ci.yml`) : sur push `main` et sur
  chaque pull request, `npm run selftest:ci` (~1 430 vérifications, ~2 min) et
  `npm run build` pour le sim, `go vet` / `go build` / `go test` pour
  l'exporteur. La release passe par les mêmes selftests avant de publier.
- `npm run selftest:ci` : la chaîne qui ne demande ni scène installée, ni
  réseau, ni navigateur.
- `npm run add-music` refuse une graine de base déjà présente dans
  `public/music.json` et en propose une libre (#122) : la réutiliser ne
  générait pas d'autres morceaux mais exactement les mêmes, que le worker
  sautait ensuite comme déjà présents — un échec silencieux.

### Modifié

- `tools/landing-selftest.mjs` se retire en disant `SKIP` quand la scène
  `public/scenes/tour-eiffel` (gitignorée) est absente, au lieu de casser la
  chaîne sur un `ENOENT`.

### Corrigé

- Le jitter du micro était réglé à 0,15 m au lieu des 0,3 m de la spec (#262) :
  dérivée au pas de simulation (1/60 s), la vitesse d'un jitter à 0,3 m
  d'amplitude (jusqu'à 2,1 Hz) explosait — la dérivée haute fréquence n'est
  presque pas atténuée à ce pas. `derive()` élargit maintenant sa fenêtre de
  dérivation à 0,15 s pour vel/acc d'une routine jittée (jamais pour la
  position, qui reste exacte) : l'atténuation qui en résulte à 2,1 Hz
  compense exactement le doublement de l'amplitude. Les autres routines
  (bien plus lentes que le jitter) n'y voient aucune différence mesurable.
- `operator.flush()` au unload n'avait aucune garantie (#247) : le PATCH qui
  écrit `settings`, `dialogueMemory` ou `coverage` est débouncé à 500 ms, et le
  rechargement de fin de vol (`location.href = location.pathname`) partait sans
  l'attendre. Ça marchait par coïncidence — le debounce tient dans la marge de
  1,4 à 4,6 s de la séquence de fin de vol — mais un serveur plus lent (tunnel,
  ami distant) pouvait perdre la dernière valeur en silence. `finishSession()`
  attend maintenant la résolution de `operator.flush()` avant de recharger ; un
  échec réseau est journalisé mais ne bloque plus la sortie.
- Le calibrage ne voyait pas un gaz rangé en gâchette (#279) : Firefox applique
  le `mapping: "standard"` à une Radiomaster Pocket et range son manche des gaz
  dans l'emplacement de la gâchette L2 — le gaz sort sur `buttons[6].value`,
  analogique (`0.997`, valeur qu'un bouton numérique ne peut pas rendre), et le
  quatrième axe reste mort. `calibration.js` ne lisait que `pad.axes` : la
  consigne `THROTTLE — FULL UP` ne pouvait pas aboutir, quel que soit le geste.
  Axes et boutons entrent désormais dans un vecteur unique (`padSignals()`), les
  boutons ramenés sur la course des axes — repos à `-1`, comme un manche à
  friction parqué en bas. Le remap manuel et le récapitulatif suivent, et
  nomment `btn 6` plutôt qu'un `axis 14` qui n'existe pas.
- L'assistant de calibrage restait muet devant un périphérique qui ne rapporte
  rien (#279) : un pad muet passe l'étape `HANDS OFF` *mieux* qu'un vrai — bruit
  nul, donc aucun rejet — puis laissait le pilote devant une consigne qui ne
  bougeait jamais. Après six secondes sans le moindre geste, il le dit.

- Le mappage manette n'était pas attaché au périphérique (#277) : `_savedMap`
  était un booléen global et `fpvtp.gamepadMap` une entrée unique, si bien
  qu'un remap fait pour une radio restait collé en branchant une DualShock 4 —
  dont les axes sont dans un autre ordre ET dont le gaz est en demi-course. Les
  calibrages sont désormais rangés par identifiant de périphérique.
- Une scène absente ne fait plus échouer le boot sur un `SyntaxError:
  Unexpected token '<'` (#275). Un fichier statique manquant ne rend **pas**
  404 : Vite, et tout hébergement avec un fallback SPA, rabat la requête sur
  `index.html` et répond 200 `text/html`. `res.ok` ne disait donc rien, et le
  `res.json()` suivant mourait sur `<!doctype`. Le chargeur regarde désormais le
  type de contenu, et son message nomme la scène et dit quoi lancer.
- Le garde-fou anti-scènes-fantômes de `loadSceneList()` filtre enfin quelque
  chose (#275) : il gardait toute scène dont le `HEAD` répondait `ok`, ce qui
  était **toujours** vrai — c'est lui qui laissait choisir une scène absente.

- La vue embarquée montrait la machine entière (#264) : le boîtier de caméra,
  centré sur l'oeil, plus la batterie et la GoPro derrière lui remplissaient le
  cadre — on ne voyait plus ni le monde ni ses propres hélices. Le niveau
  `onboard` ne porte plus que les quatre rotors, et `eyeOf(profile)` donne
  enfin une définition unique à la position de l'oeil.
- La borne DA ne mesurait que les disques d'hélice (#264) : les conduits, les
  bras et les moteurs étaient dans le cadre sans que rien ne les regarde.
  `tools/lens-coverage.mjs` mesure le maillage tel qu'il est affiché, et le
  selftest borne famille par famille — ce qui est garanti pour les six, c'est
  que la moitié haute du cadre reste libre.

[Non publié]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.1.0-beta...v0.3.0
[0.1.0-beta]: https://github.com/lionrayonnant/FPVThePlanet/releases/tag/v0.1.0-beta
