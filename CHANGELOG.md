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

Note : ce dépôt porte un historique réécrit et n'est pas celui contre lequel
une partie de ces entrées a été rédigée. Les numéros `(#N)` antérieurs à la
réécriture désignent des issues du dépôt qui l'a précédé : ils ne résolvent pas
ici, et les plus petits résolvent vers une issue sans rapport. Ils sont
conservés parce qu'ils sont la trace de la décision, pas un lien.

## [Non publié]

### Ajouté

- **La nomenclature devient vérifiable.** Chaque famille nomme désormais son
  moteur, son hélice et son pack par leur identifiant de catalogue
  (`motor.part`, `propPart`, `battery.part`), et `profile-schema-selftest`
  refuse une référence qui ne résout pas, un KV qui contredit son entrée, une
  diagonale d'hélice ou un pas qui ne sont pas ceux du catalogue. Le 2207 à
  2450 KV de la référence — la dernière référence du fichier qui n'était pas un
  fait — est déclaré dans `OFF_CATALOGUE_MOTORS` avec sa provenance, **pas**
  dans `SPEC_MOTORS` : ce catalogue est une transcription dont le nombre
  d'entrées est épinglé, et y ajouter une ligne serait exactement ce que cette
  vérification existe pour attraper. Rien ne bouge en vol : `freestyle5` reste
  la référence au bit près.
- **BENCH : la machine exacte** (#159). L'aéronef du banc n'est plus un menu
  déroulant sur six familles, c'est un montage. Une BASE — `NOMINAL`, un
  exemplaire tiré (`INDIVIDUAL`), ou `CUSTOM`, assemblé depuis le catalogue de
  la spec (21 moteurs, 20 hélices, 13 châssis, 17 packs, 3 caméras) — et,
  par-dessus, 45 paramètres réglables au chiffre près : masse, inerties, bras,
  hélice, moteur, pack, traînée, PID, rates, courbe de gaz, bruit gyro, latence
  de boucle. La dérivation CUSTOM n'invente rien : elle applique les quatre
  règles déjà écrites en tête de `drone-profiles.js`. `NOMINAL` sans réglage
  reste **exactement** le profil de référence — la fonctionnalité est inerte
  tant qu'on n'y touche pas.
- **La radio se règle en vol, au banc** (#159). `ON AIR`, le pool, le morceau et
  le transport dans le panneau de vol du banc : le jukebox continuait de jouer
  après qu'on en sortait, mais plus rien n'y donnait accès une fois en l'air.
  Au banc seulement — en FIELD la musique est l'arc de la Bible §34.

### Modifié

- **`propInertia` est dérivé au lieu d'être choisi.** Normalisé en
  `k = I / (m * R^2)`, le fichier impliquait un k de 0,115 à 0,620 sur sept
  pièces qui sont le même objet moulé à des tailles différentes. Une hélice est
  géométriquement auto-similaire : pales effilées portant leur masse en dedans,
  sur un moyeu à rayon quasi nul. La tige uniforme donne 1/3, l'effilement et
  le moyeu ramènent dans 0,2–0,3, et la référence mesure 0,248 — c'est la
  constante, et la masse vient du catalogue. Le nombre de pales n'entre pas, et
  c'est un résultat : 4 g pour un 5", 7 g pour un 6" et 2 g pour un 3" sont des
  masses de tripale et ces familles volent en tripale ; 8 g pour un 7" et 1 g
  pour un 2,5" sont des masses de **bipale** (un 7" tripale pèse 11-12 g) et ces
  familles volent en bipale. Chaque masse du catalogue est déjà celle de
  l'hélice embarquée. Corrections : cinewhoop −60 %, toothpick −17 %, race5
  +11 %, swarmNode +46 %, longrange **+115 %** — cette dernière parce que son
  commentaire comptait le nombre de pales deux fois, en partant d'un 1,1e-5
  deviné pour un 7" tripale puis en le multipliant par 2/3, alors que les 8 g du
  catalogue sont déjà la bipale. `freestyle5` et `heavy5` ne bougent pas d'un
  bit, les six séquences de `npm run replay` le confirment.
- **L'inertie de `swarmNode` est reconstruite à partir de ses pièces.** Elle
  était « heavy5 mise à l'échelle, interpolée vers longrange », et longrange a
  bougé sous elle (0,92 → 1,05 kg, tripale → bipale de catalogue, inertie
  refaite). Une interpolation ne vaut que ses extrémités : elle est remplacée
  par le modèle que longrange documente — quatre masses ponctuelles aux coins
  plus une boîte équivalente calibrée sur freestyle5 —, qui reproduit ses deux
  points de calibration à 0,3 %. Résultat 11 à 13 % plus bas, et un rapport
  `I_lacet/(I_tangage+I_roulis)` de 0,942 qui la remet dans la bande où sont les
  six autres au lieu de 0,920 toute seule. Le départ connu est écrit : ~170 g de
  radio maillée sont au mât, au-dessus du centre de masse, et la boîte les
  répartit.
- **Les six réglages PID sont rebalayés**, plus celui de swarmNode, contre les
  nouvelles inerties. `freestyle5` et `heavy5` en ressortent identiques.

### Corrigé

- **La convention de `battery.maxCurrent` est tranchée et épinglée.** Le champ
  est documenté « A aux quatre moteurs plein gaz », donc le **tirage** du build ;
  la note du pack, elle, vaut `capacité * C` — pour le `4s-1300` de la
  référence, 195 A contre les 100 A du tirage. Les deux nombres sont vrais et ne
  sont pas la même grandeur, et c'est cette ambiguïté qui faisait passer le
  champ pour incohérent. La règle 3 du fichier donne le tirage, les sept
  familles la respectent à mieux que 1 %, et un test le vérifie — avec un second
  qui compare au plafond du pack. À savoir en le lisant : **aucune physique ne
  lit `maxCurrent`**, le pack s'affaisse sur le vrai courant de bobinage issu de
  la balance de couple de `motor.js`. C'est un chiffre de fiche technique, ce
  qui est précisément pourquoi il lui faut un test et pas un lecteur.

### Ajouté
- **`?aero=bem` : l'hélice en théorie de l'élément de pale, éteinte par
  défaut.** `src/blade-element.js` existait, validé sur 187 hélices de
  soufflerie, et n'était branché nulle part : le câbler remplace le modèle de
  poussée et invalide six réglages sur la foi d'un terme edgewise qu'aucun banc
  d'ici ne peut vérifier — la soufflerie UIUC souffle dans l'axe. Il est donc
  câblé derrière un drapeau, plombé comme `?loop=`, et le chemin par défaut est
  **identique au bit près** : `cmp` ne trouve pas un octet d'écart sur les 36
  traces de `npm run replay`, et un selftest compare 400 pas élément par élément
  entre le défaut, `aero:'classic'` explicite et un drapeau inconnu. Ce que le
  drapeau achète, c'est que le terme edgewise devienne **mesurable** à défaut
  d'être vérifiable : `tools/aero-model-compare.mjs` met les deux modèles côte à
  côte — poussée, couple et force en plan, du stationnaire à la croisière, plus
  la garde de #103 jouée contre les deux. Ce qu'il dit : la lame rend 14 à 30 %
  de poussée en moins au stationnaire, et tout cet écart est `propLossFactor`,
  qui n'a pas d'équivalent en théorie de l'élément de pale ; sa force en plan
  vaut 13 à 30 % de ce qu'applique `kLateral`, dont le commentaire dit
  justement qu'il contient le flapback groupé. Rien n'est basculé, et
  `sim/docs/PICKUP.md` écrit ce qu'il faudrait pour pouvoir le faire.
- **Les moments rotor translationnels (#91, révoqués par #103) sont traités en
  n'étant pas ajoutés.** Le terme edgewise de la lame *est* ce mécanisme ; les
  ajouter en plus aurait compté la dissymétrie de portance deux fois. Ce que
  #103 avait révoqué est maintenant compris et chiffré — roulis plein tenu à
  26-36 m/s faisait passer le pire taux hors axe de 1-2 deg/s à 115-222, et les
  deux **moments** en plan en sont la totalité (moment de moyeu seul 76, bras de
  levier du plan rotor seul 48-71 ; portance translationnelle 2, précession 3).
  Le mode `bem` ne les réintroduit pas, et pas par chance : la lame renvoie une
  **force** et aucun moment, appliquée au moyeu là où `kLateral` agissait déjà.
  La garde est désormais jouée contre les deux modèles, et `bem` est partout
  égal ou meilleur que le défaut.

- **Le gyroscope est allumé, et la boucle de contrôle tourne à 4000 Hz.** Les six
  familles portent un `gyroNoise` mesuré — dérivé de l'unbalance ISO 1940 d'un
  rotor, `m_helice * bras / I_roulis`, ancré à 0,20 rad/s sur la freestyle5 — et
  un `loopDelay` de 0,8 ms (capteur, ordonnanceur, ESC : ce que ni `motor.js` ni
  la chaîne PT1 ne modélise déjà). Le contrôleur sous-échantillonne seize fois
  dans le pas physique, qui reste à 250 Hz : c'est la première cadence où le
  plafond du notch (0,45 de Nyquist, 900 Hz) couvre **toutes** les fondamentales
  rotor, 157 à 816 Hz. Les secondes harmoniques restent hors de portée du notch
  dynamique — il faudrait 7253 Hz — et c'est le filtre RPM qui les prend, parce
  qu'on lui donne le régime au lieu de le lui faire chercher. Coût mesuré, à
  chaud : 3,71 ms par seconde simulée, soit +0,35 % d'un cœur. La chaîne de
  conditionnement retire 15 à 36 % de l'ondulation moteur au repos selon la
  famille. Anti-gravity à 8,5, ancré sur le rapport de poussée d'une remise de
  gaz (−21 % d'assiette concédée). D-max reste à 1,0, et la raison a changé :
  rebalayé à quatre rapports, il ne fait pas bouger l'ondulation au repos d'un
  chiffre, parce qu'il est piloté par la vitesse de consigne, nulle en
  stationnaire — il ne peut donc pas acheter le D bas qui justifie le mécanisme.
- **`tools/tune-pid.mjs` balaye la machine qu'on vole.** Il sous-échantillonne à
  la cadence de `frame-pacing.js` et reçoit les régimes rotor, donc les notches
  et le bruit existent pendant le balayage. Sa porte de sélection est désormais
  celle du rapport : elle tolérait 5 % de dépassement sur le temps de montée et
  15 % sur la stabilisation, ce qui est une machine à choisir des réglages que le
  rapport signale ensuite. Les six réglages sont rebalayés ; il reste **1
  combinaison sur 18** hors cible, le lacet de la toothpick, et c'est un résultat
  documenté dans `src/drone-profiles.js`, pas un réglage inachevé.

### Corrigé

- **La boucle GPS perdait son terme dérivé à 4000 Hz.** Elle lit une *position*,
  qui ne bouge que sur la grille physique : sous-échantillonnée, on lui présentait
  seize fois les mêmes trois nombres et sa dérivée valait zéro sur celui dont la
  sortie compte. Elle tourne maintenant à sa propre cadence de navigation, comme
  une vraie boucle de nav tourne au rythme des fixes. Retour de 20 m sur la
  freestyle5 : 5,2 % de dépassement au lieu de 28,2 %.

- **Modes Acro3D et GPS.** Gaz bidirectionnel — poussée inversée, mixeur signé,
  `stepMotor` bidirectionnel — et maintien de position qui produit une *assiette*
  confiée à l'auto-nivellement existant, sur le précédent du mode angle : pas de
  second contrôleur, un seul réglage. Retour au point depuis 2, 20 et 60 m sur
  les six familles en 9 à 17 s, un seul dépassement, moins d'1 cm de dérive
  d'altitude.
- **Un gyroscope, et la mesure qui dit quand l'allumer** (`src/gyro.js`). Bruit
  large bande exprimé en densité, tons synchrones du rotor, notch dynamique,
  filtre RPM, ligne à retard, anti-gravity, D-max. **Tout est livré inerte** et
  c'est prouvé : 36 traces de rejeu identiques à l'octet, rapport du tuner
  inchangé. Le chiffre qui décide : un notch dégénère au-delà de 0,45 de
  Nyquist, soit 56 Hz à 250 Hz, alors que les fondamentales rotor vont de 155 à
  816 Hz en vol — à cette cadence le notch n'est pas faible, il est absent.
  `?loop=<hz>` existe pour mesurer le jour où le bruit s'allumera.
- **Harnais de rejeu de vol** (`npm run replay`). Six séquences de manches fixées
  volées à travers le vrai contrôleur et le vrai Rapier, puis différenciées sur
  des grandeurs qu'un pilote reconnaît. Déterminisme prouvé en processus, en
  ordre inverse et en processus neuf.

- **Modèle de vol calqué sur la spécification de vol.** Cinq familles de rates
  des firmwares du commerce au lieu d'une seule (`src/rates.js`), pondération de
  la course de gaz en trois bandes (`src/throttle.js`), courbes de réponse à
  clés (`src/curves.js`), densité de l'air prise par altitude (`src/air.js`),
  catalogue de pièces en données (`src/spec-data/`). Tout est inerte par défaut :
  les rates restent ACTUAL, les bandes à 1/1/1, et un banc le prouve à l'égalité
  flottante exacte sur un balayage de 4001 points.
- **Les neuf critères d'acceptation en banc** (`tools/spec-acceptance-selftest.mjs`),
  avec des cibles re-dérivées par famille plutôt que recopiées. Le critère 4
  passe et retrouve le chiffre de la spécification par un autre chemin : à 8:1
  le stationnaire demande 27,6 % de manche, la spec annonce « ≈30 % ».
- **Limite de courant ESC par moteur** et les deux courbes de décharge, lipo et
  li-ion (`src/battery.js`, sorti de `quad.js`).

### Modifié

- **Quatre familles de drones portaient les chiffres du 5" freestyle.** Le
  fichier l'admettait en commentaire. Une famille sur six seulement était dans la
  bande de régime attendue, et un micro 2,5" sortait à 3,08:1 de rapport
  poussée/poids là où un vrai est à 4-6. Chaque nombre dérive désormais de trois
  règles ancrées sur la machine de référence, et les pièces viennent d'un
  catalogue. Cinq familles sur six dans la bande, rapports poussée/poids en
  classe partout. Conséquence : le toothpick était **impossible à régler**, aucun
  point de la grille P/D n'atteignait la cible ; sur la machine corrigée le
  tuner y va directement, et les combinaisons hors cible passent de 4 à 2.
- **La courbe de poussée se courbe.** Les pertes d'hélice atteignent le modèle :
  manche de stationnaire −10,7 % sur le 5" freestyle, −14,1 % sur le race,
  **plein gaz inchangé** (vitesse de pointe 142,4 → 142,3 km/h).
- **Le modèle d'hélice par éléments de pale, réparé.** L'en-tête accusait
  l'écoulement de travers ; la soufflerie UIUC souffle le long de l'arbre, le
  défaut était purement axial. La vraie cause était une ligne de portance
  symétrique — une vraie pale est cambrée. Erreur moyenne sur 187 hélices
  82,7 % → 31,1 %, et le biais signé qui atteignait −222 % revient à quelques
  pourcents partout. Le cycle limite est résolu : le résidu de vitesse induite
  avait trois racines, ce qu'un commentaire affirmant l'inverse cachait.
- **Le drone a du poids au stationnaire.** Le poids est majoré de 7 à 15 % à
  vitesse verticale nulle et revient à 1,0 en descente rapide — une force
  explicite avec son poste au budget, jamais le `g` de Rapier. C'est la réponse
  au rapport « ça flotte, c'est trop léger, partout » que le budget de forces
  n'avait pas su expliquer. `hoverThrottle()` en tient compte, sinon le maintien
  d'altitude coulait de 2 m/s.
- **La batterie ne borne plus la sortie** (`PACK_DRAINS`, `src/battery.js`). Le
  pack ne se vide pas : une exploration ne s'arrête pas sur une panne sèche. Rien
  d'autre ne change, parce que tout ce qui fait qu'un pack se sent est du sag —
  tire 90 A et la tension tombe encore de 0,225 V/cellule, le régime fléchit, le
  punch-out coûte ce qu'il coûte. Seule l'horloge disparaît. Le compteur de
  coulombs, les deux courbes de décharge et l'interrupteur BATTERY du banc
  restent en place et testés.
- **L'alerte batterie est passée de la tension à la capacité**, pour le jour où
  cet interrupteur rebascule : un LiPo reste entre 4,2 et 3,65 V pendant 90 % de
  sa charge, donc la tension ne peut pas prévenir tôt — elle laissait 18 s avant
  la panne sur un 5", 8 s sur un cinewhoop, contre 49 et 14 pour la capacité. Le
  coude de la courbe de décharge est adouci pour la même raison.
- **Les pertes d'hélice s'appliquent à la pale, pas au KV.** Les deux courbes de
  perte corrigent `kThrust`, pas le régime : un KV est une propriété du
  bobinage, il ignore quelle hélice y est boulonnée.
- **Effet de sol** : la force échelonne désormais avec la taille d'hélice et la
  tension par cellule, la décroissance mesurée reste exponentielle.

### Modifié

- **README : en-tête de présentation et soutien remonté en haut.** Bannière,
  badges (release, CI, licence, Discussions) et liens de navigation dans un
  bloc centré ; la section « Support » et ses adresses crypto passent juste
  sous l'en-tête au lieu d'être en bas de page. Les commandes sont regroupées
  dans un tableau, chaque adresse précédée de sa marque (Cake Wallet, Monero,
  Bitcoin).

### Ajouté

- **Journal d'accès Caddy, adresses masquées.** `deploy/Caddyfile` ne portait
  aucune directive `log` : Caddy ne journalisait donc que ses erreurs, et
  `journalctl -u caddy` ne disait rien du trafic malgré ce qu'affirmait
  `deploy/README.md`. Le bloc ajouté écrit en JSON vers journald et tronque
  chaque adresse à un /24 (IPv6 : /48), pour mesurer le volume sans retenir
  personne. `deploy/README.md` gagne les commandes de comptage (chemins les
  plus demandés, blocs distincts, opérateurs et vols enregistrés).

- `sim/tools/export-support-marks.mjs` : exporte les trois marques de pourboire
  de `src/pixel-icons.js` en SVG autonomes (`docs/brand/mark-*.svg`) pour le
  README, avec un mode `--check` contre la dérive.

### Retiré

- **Le mode ENRICHED de la carte du SCANNER** (#160). Les joueurs ne le
  comprenaient pas : le mot ne dit rien, et ce qu'il ajoutait par-dessus les
  traces — les captures posées sur la carte, l'étiquette au survol d'une perte,
  le clic qui ouvrait la fiche de vol — passait inaperçu. Le calque garde les
  traces laissées au sol et les croix de perte, rien d'autre : il est purement
  visuel, plus rien n'y est cliquable. Le bouton devient
  `FLIGHT HISTORY: ON/OFF`, afficher ou masquer l'historique de vol ; OFF reste
  la carte d'aujourd'hui au bit près et ne déclenche aucune requête, et le choix
  des opérateurs qui avaient ENRICHED activé est repris. Le lien mort
  `OPEN MAP — ENRICHED` de l'onglet DATA part avec.

## [1.1.0] - 2026-09-13

Ce que la première mise en ligne réelle a trouvé. La 1.0.0 a été taguée avant
qu'une instance publique existe : tout ce qui suit a été découvert en la
déployant pour de bon, et rien de tout cela ne pouvait l'être autrement.

### Modifié

- **Les moteurs sont un bilan de couple, plus un ajustement de courbe.**
  `omega = omegaMax * cmd^rpmCurve` suivi d'un retard du premier ordre, c'était
  TROIS constantes ajustées par famille (`rpmCurve`, `tauSpinUp`,
  `tauSpinDown`) pour un seul mécanisme — et étant ajustées, elles pouvaient
  tout absorber : aucune combinaison n'était jamais fausse, donc rien n'était
  vérifiable. Nouveau `sim/src/motor.js` : force contre-électromotrice
  `e = Ke·omega`, courant `i = (duty·V − e)/R`, couple `Ke·(i − i0)`, et le
  bilan `J·domega/dt = Q_moteur − Q_hélice`. Tout ce que les trois constantes
  encodaient en tombe : la forme du régime en fonction du manche (la racine
  d'une quadratique, dont l'exposant 0,65 était l'approximation — c'est
  pourquoi il tenait entre 0,5 et 1), l'asymétrie montée/descente (mesurée
  désormais à 24 ms contre 36 ms, contre 22/45 ms posés à la main), le pack qui
  sagge, et le courant — qui était un SECOND ajustement à côté du premier.
  Les trois constantes disparaissent des profils, remplacées par
  `motor: { kv, noLoadCurrent }` pris du moteur que chaque famille nommait déjà
  en commentaire ; la résistance n'est pas stockée mais **dérivée de maxOmega**,
  donc le régime de pointe — et avec lui la poussée, le rapport poussée-poids
  et la vitesse max — reste autoritatif, au chiffre près, pour les six
  familles. Deux erreurs physiques corrigées au passage : le manche de
  stationnaire s'inverse maintenant par le vrai bilan et non par
  `cmd^(2·rpmCurve)` (0,245 → 0,342 sur freestyle5, plus proche des ~30 % d'un
  vrai 5" en 6:1), et le courant PACK n'est pas le courant BOBINAGE — un ESC est
  un hacheur, le pack ne fournit que la fraction `duty`, ce qui ramène le
  stationnaire d'un 5" de 34 A à **12 A**, ce que tire réellement un 650 g.
  PID réécrits par `tools/tune-pid.mjs --write all`, jamais à la main.

### Corrigé

- **Le régime d'anneau tourbillonnaire ne lâchait jamais, et ignorait la
  taille des hélices.** Deux défauts dans `propwash`. Ses seuils étaient en
  m/s ABSOLUS, identiques pour les six familles — exactement l'erreur que
  `kAxial` avait déjà commise (issue #71) : la vitesse induite vh va de
  5,3 m/s (toothpick) à 11,5 m/s (cinewhoop), donc un seuil fixe à 2 m/s
  faisait entrer en VRS à 0,38 vh sur une machine et 0,17 vh sur une autre,
  un facteur 2,2 sur un seuil censé être une propriété de l'écoulement. Pire,
  la courbe SATURAIT et y restait : passé 8 m/s de descente le disque était
  maintenu en VRS plein, à 20 comme à 40 m/s. Or aucun anneau ne peut exister
  là-bas — au-delà de Vd = 2·vh le rotor est en **moulinet**, écoulement
  établi et lisse. C'est une BANDE, pas une rampe. Elle est désormais exprimée
  en unités de vh, ses extrémités calées pour reproduire exactement l'onset et
  le pic mesurés de `freestyle5` sur son propre vh de 7,17 m/s (2 et 8 m/s →
  0,279 et 1,116 vh) : la machine de référence garde son ressenti au
  centième, chaque autre famille culmine enfin à SON régime. Trois gardes
  structurelles dans `tools/aero-selftest.mjs` (zéro au stationnaire, zéro
  au-delà du moulinet, un seul pic par famille).

- **Le drone refusait de tomber : plus il descendait vite, plus il poussait
  fort.** Signalé comme « le drone flotte, il est trop léger ». Le terme
  d'inflow axial de `quad.js` est une pente au PREMIER ORDRE — le commentaire
  qui le dérive le dit — mais il était appliqué sans borne. En descente rapide
  il était donc évalué jusqu'à Vc/vh = −3,5, plusieurs fois au-delà de ce qu'un
  développement linéaire peut prétendre, et la conséquence partait à l'envers :
  à manche de stationnaire tenu, `freestyle5` produisait 0,92 × son poids à
  8 m/s de descente mais **1,23 ×** à 25 m/s. Le `propwash`, qui porte le régime
  d'anneau tourbillonnaire, saturait dès 8 m/s et ne pouvait plus rien y
  opposer. Le terme axial s'arrête désormais à la frontière du **moulinet**
  (Vc = −2·vh) — pas un nombre choisi : c'est là que la théorie de la quantité
  de mouvement admet de nouveau une solution. Seul le côté descente est borné :
  stationnaire, montée et portance translationnelle passent **au bit près**
  (montée plein gaz : 31,928 m/s avant comme après). Deux gardes dans
  `tools/aero-selftest.mjs`, dont l'invariant structurel « au-delà de la
  frontière, tomber plus vite n'achète jamais plus de poussée ».

- **La gravité s'arrêtait dès que le rendu ralentissait.** Deux défauts
  indépendants, tous les deux dans l'horloge et aucun dans le modèle de vol.
  D'abord, `Physics.step(motors, dt)` ignorait son `dt` côté Rapier : le moteur
  intégrait toujours `world.timestep`, donc la cellule avançait de `dt` pendant
  que la gravité, les vitesses et les contacts avançaient de 1/250 s — un pas de
  1/50 s tombait au **cinquième de g**. Ensuite, la boucle de frame n'achetait
  au plus que 12 pas de 1/250 s, soit 48 ms de monde par frame, et **jetait** le
  reste de l'accumulateur : en dessous de ~21 fps toute la simulation passait au
  ralenti (48 % du temps réel à 10 fps, 3 % pendant les stalls de streaming de
  700-1700 ms déjà documentés). Le symptôme visible étant un drone qui reste
  suspendu au lieu de tomber, le défaut se lisait comme une gravité cassée. Le
  pas est désormais **étiré** (borné à 1/60 s) au lieu d'être abandonné : le
  coût d'un rattrapage reste plafonné à 12 pas — la raison d'être du plafond —
  mais le monde avance bien du temps réellement écoulé, jusqu'à 200 ms par
  frame. Une machine qui tient la cadence tourne exactement sur la grille 250 Hz
  d'avant, au bit près. Nouveau `sim/src/frame-pacing.js` et
  `tools/frame-pacing-selftest.mjs` (9 tests, dans la chaîne CI).

- **Le curseur disparaissait dès qu'un clic tombait à côté d'un bouton.** Le
  curseur EST le focus natif du navigateur : cliquer sur le fond d'un écran, un
  titre ou une ligne de texte le fait perdre, plus rien ne porte le marqueur ▌
  et Entrée n'active plus rien. Il fallait une flèche — qui repartait du haut de
  la liste — ou Échap pour ressortir et revenir. Le focus est désormais **reposé
  là où il était**, sur `focusout` plutôt qu'en bloquant le `mousedown` : la
  sélection à la souris reste possible, et on sélectionne à la main dans ces
  écrans (une adresse de paiement, une ligne de journal). Sortir d'un champ de
  saisie reste une intention : le curseur repart alors du premier contrôle sur
  lequel on peut appuyer, sans y être renvoyé.

  Deux déclencheurs, parce qu'un seul navigateur ne suffit pas à prouver un
  correctif de focus : Chrome ne déplace le focus qu'une fois, au `mousedown`,
  et `focusout` y suffisait ; **Firefox** défocalise au `mousedown` PUIS
  réattribue le focus à la fin du clic — le rétablissement, différé d'un tour,
  tombait entre les deux et le clic le défaisait. L'écouteur `click`, qui passe
  après toute la séquence souris, est celui qui tient dans cet ordre-là. Les
  deux sont sans effet quand le focus est déjà quelque part dans l'écran.

- **JUKEBOX, onglet ALL : les lignes étaient écrasées à 6,5 px.** Les 143
  morceaux étaient bien là, dans l'ordre, avec le bon texte, et aucun n'était
  lisible. Un `flex-direction: column` avec un `max-height` ne déborde pas dans
  sa barre de défilement : par défaut il **rétrécit** ses enfants jusqu'à ce que
  tout rentre. En dessous d'une vingtaine d'éléments rien ne bouge — d'où un
  filtre par pool parfait et un seul onglet cassé. La même forme existait quatre
  fois (les deux listes, le panneau des réglages, la page DATA) ;
  `tools/list-layout-selftest.mjs` refuse désormais une cinquième qui
  l'oublierait.

- **La carte de l'onglet LIVE ne s'affichait plus** : toutes les tuiles
  OpenStreetMap revenaient en 403 « Access blocked ». L'en-tête
  `Referrer-Policy: no-referrer`, ajouté par la passe de sécurité de la 1.0.0,
  retirait le `Referer` des requêtes de tuiles — or la politique d'usage d'OSM
  exige un `Referer` ou un User-Agent qui identifie l'application, et un
  navigateur n'envoie qu'un User-Agent générique. Remplacé par
  `strict-origin-when-cross-origin`, qui garde l'intention : le même-origine
  conserve l'URL complète, donc le slug de scène et la graine de build ne
  sortent toujours pas, et OSM reçoit l'origine nue dont il a besoin.

  Invisible en développement, parce que Vite ne sert aucun de ces en-têtes :
  seule une vraie mise en production pouvait le montrer. **Concerne aussi les
  applications de bureau 1.0.0**, qui embarquent le même serveur.
- `deploy.sh` téléchargeait les métadonnées JSON de l'asset au lieu de
  l'archive, et `tar` échouait sur « not in gzip format ». `gh_api` pose
  `Accept: application/vnd.github+json` et la fonction de téléchargement en
  ajoutait un second en `application/octet-stream` : curl envoie les deux,
  GitHub honore le premier. Le script passe maintenant par
  `browser_download_url`, qui sert les octets sans négociation de contenu —
  possible parce que le dépôt est public. Il vérifie en plus que le fichier
  reçu est bien une archive, et affiche ses premiers octets sinon.
- Caddy journalise vers journald au lieu d'un fichier. `output file` imposait
  de créer `/var/log/caddy` à la main, entre deux étapes précises, et refusait
  quand même de démarrer le service alors que le répertoire appartenait bien à
  `caddy` et y était inscriptible. Une ligne de configuration pour un mode de
  panne spécifique à la plateforme : `journalctl -u caddy -f` donne les mêmes
  accès et laisse la rotation au système.

### Modifié

- `deploy/README.md` : la checklist supposait un shell root sans jamais dire
  comment en obtenir un, alors qu'aucun hébergeur ne donne root — la première
  commande échouait après avoir eu l'air de fonctionner. Le piège du tube est
  signalé avec (`sudo` doit élever `gpg` et `tee`, pas `curl`).
- La consigne de durcissement SSH nommait le fichier
  `sshd_config.d/99-hardening.conf`. `sshd` applique la **première** définition
  qu'il lit et parcourt les extraits dans l'ordre lexical — l'inverse de la
  convention systemd. Les images cloud Ubuntu livrent un `50-cloud-init.conf`
  avec `PasswordAuthentication yes`, qui gagnait : le fichier de durcissement
  existait, disait la bonne chose, et ne faisait rien. Renommé en `01-`, et la
  vérification lit désormais `sshd -T` plutôt que le fichier.
- `README.md` : la construction de l'app de bureau réclame `npm run build`
  d'abord. `electron-builder` empaquette `dist/` tel quel sans jamais le
  reconstruire, et `dist/` est gitignoré, donc changer de branche puis
  empaqueter livrait la nouvelle coquille Electron autour de l'ancien jeu.
- Le crédit d'imagerie Google descend au **bas** de la colonne FIELD, avec les
  autres mentions légales — licence, sources — au lieu d'être coincé entre le
  rail LIVE et ce qui décolle, où il se lisait comme une étape du parcours.
  Toujours sur LIVE seulement : le terrain déjà sur le disque a emporté son
  crédit avec lui.
### Ajouté

- **Un pourboire, en trois marques.** Le pied de page de FIELD porte les logos
  Cake Wallet, Bitcoin et Monero, dessinés dans la grille 12×12 du jeu, sous une
  ligne qui dit à quoi ça sert. Chacun ouvre une petite fenêtre par-dessus FIELD
  — la carte, l'épingle et la zone choisie restent exactement où elles étaient.
  Un logo se reconnaît avant de se lire, ce qu'un bouton « SUPPORT » ne faisait
  pas, et un pot à pourboires n'a pas besoin de tout le cadre pour dire une seule
  chose.

  Trois adresses — Monero, Bitcoin en paiement silencieux (BIP352), Bitcoin
  classique, les deux dernières dans la même fenêtre puisque c'est une seule
  décision pour qui donne — plus une poignée Cake lisible, `fpvtp@cake.cash`,
  la seule ligne qu'un humain peut retenir ou dicter : quatre-vingt-quinze
  caractères de base58 ne sont pas une interface. Chaque adresse est affichée
  **en entier**, jamais tronquée, et copiable d'un bouton qui dit s'il a réussi.

  Crypto uniquement : tous les rails fiat vérifient l'identité du bénéficiaire,
  ce que ce projet ne propose pas, et une page de paiement à l'état civil
  déferait le pseudonyme que le dépôt tient partout ailleurs. La fenêtre ne le
  dit pas — expliquer l'absence de bouton carte transforme une petite offre en
  plaidoirie ; c'est le README qui porte le raisonnement.

  Les adresses vivent dans un module pur, `tools/support-model.mjs`, pour une
  raison précise : `tools/support-selftest.mjs` les revérifie **par checksum à
  chaque passage de CI** — bech32 et bech32m pour Bitcoin, Keccak-256 pour
  Monero, l'implémentation étant elle-même contrôlée sur le vecteur de test
  officiel avant qu'on lui fasse confiance. Une coquille dans une légende est
  embarrassante ; une coquille dans une adresse envoie l'argent d'un inconnu là
  où personne ne pourra jamais le dépenser, et le dépôt comme les binaires la
  porteraient pour la durée de la version.
- **Le jeu dit où sont ses sources.** Sous le pied de page de FIELD, une
  catégorie à part — « SOURCE · LEAVE A STAR ON GITHUB », le logo GitHub et
  `AGPL-3.0` —, cliquable, et la même marque discrète dans l'OSD en vol.
  Ce n'est pas de la promotion : l'article 13 de l'AGPL exige qu'un joueur qui
  interagit avec le programme **à travers un réseau** se voie offrir les sources
  correspondantes — or sur l'instance de quelqu'un d'autre, il ne voit jamais le
  dépôt, ni le fichier `LICENSE`, ni le README. L'offre doit être dans le
  programme.

  Les icônes viennent du jeu lui-même : `src/pixel-icons.js` (PHASE 20, Bible
  §41) existait depuis longtemps et n'était branché à rien ; c'est son premier
  usage. La bibliothèque gagne quatre marques — GitHub, Bitcoin, Monero, un
  gâteau pour Cake Wallet — dessinées pour survivre à douze pixels : la
  silhouette pour GitHub, le ₿ sans sa pièce, l'anneau et le M de Monero. Le
  mot est ce qu'on décode, la marque est ce qu'on reconnaît. En vol elle n'est
  **pas**
  cliquable : le vol capture le pointeur, une cible dans l'image serait un
  piège ; c'est le pied de page du terminal qui porte le lien.
- `deploy/README.md` gagne une section « Hardening the machine » : SSH par
  clés, restriction du port 22, `fail2ban`, mises à jour automatiques, et le
  mode SSL à vérifier derrière un CDN. Le service était déjà bien confiné par
  son unité systemd ; la machine, elle, n'était couverte nulle part.

## [1.0.0] - 2026-09-13

Première version publique. Le jeu existait déjà en 0.3.0 ; ce qui change ici,
c'est qu'il est fait pour être rencontré par quelqu'un d'autre que son auteur.

- On vole au-dessus d'une vraie ville, dans le navigateur, en photogrammétrie
  Google Earth diffusée pendant le vol. Aucun terrain à télécharger d'abord :
  on clique un point sur la carte, on vole quinze secondes plus tard, et les
  tuiles vont directement de Google au navigateur du joueur sans passer par un
  serveur.
- **Le clavier est jouable.** Sans manette, le vol démarre en angle et les axes
  montent progressivement ; une manette reçoit toujours de l'acro inchangé.
- Un navigateur sans WebGL2, un serveur de tuiles bloqué, un délai dépassé :
  les trois disent maintenant ce qui se passe au lieu d'une page noire, d'une
  impasse ou d'un vide infini.
- Une passe de sécurité complète, avec exploits reproduits : évasion par lien
  symbolique, injection HTML stockée, limite d'inscription contournable,
  routes non bornées, allocation pilotée par le réseau, et deux portes
  Electron.
- L'imagerie Google est créditée sur le chemin que tout le monde emprunte.
  Elle ne l'était pas.
- Les surfaces publiques — README, workflows, notes de version, manuel,
  serveur, outils — sont en anglais.
- 2 700 vérifications automatiques et une passe de fuzzing à graine fixe dans
  la même chaîne, exécutée avant chaque publication.

Le détail, rubrique par rubrique.

### Ajouté

- **Un navigateur sans WebGL2 dit pourquoi**, au lieu d'une page noire sans un
  mot. three r170 demande un contexte `webgl2` et rien d'autre, et
  `WebGLRenderer` lève au niveau module : `main.js` était interrompu avant même
  que le Hud qui aurait pu le signaler existe. La sonde vit maintenant dans
  `index.html`, en script classique, avant le module — sans bundle, sans
  feuille de style, sans police, styles en ligne : quoi qu'il ait échoué plus
  bas, ces mots arrivent à l'écran. Elle nomme les quatre choses qui règlent
  vraiment le problème.
- L'écran d'échec a une sortie : `[ RELOAD ]`, Échap et Entrée. Il n'en avait
  aucune, ce qui faisait de tout blocage de `kh.google.com` — un bloqueur de
  publicité, un VPN, un proxy d'entreprise — la fin de la visite. Le message
  nomme désormais cette cause au lieu de se taire.
- Les fichiers qu'un dépôt public doit avoir : `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, un gabarit de pull request, une
  configuration de gabarits d'issue qui ferme l'issue vide et route les
  questions vers Discussions et les vulnérabilités vers le formulaire privé,
  et `dependabot.yml`.
- Nouveaux selftests : `first-run-selftest.mjs` (18 vérifications, dont
  l'exécution de la vraie sonde d'`index.html`), `rocktree-unpack-selftest.mjs`
  et le modèle pur `boot-failure-model.mjs`.


- Une passe de **fuzzing**, `npm run fuzz` (`sim/tools/fuzz.mjs` pour les
  modules purs, `sim/tools/fuzz-api.mjs` pour les routes HTTP contre un vrai
  serveur, harnais partagé dans `sim/tools/lib/fuzz.mjs`). Seize cibles, chacune
  avec l'invariant qu'elle vérifie et le modèle de menace de son entrée ; graine
  fixe, donc rejouable et intégrée à `selftest:ci`. Ce qu'elle a trouvé est dans
  `sim/docs/handoff-archive/fuzzing.md`.
- Bibliothèque musicale : 143 pistes au lieu de 73. Chaque pool double à peu
  près, et le drone d'essaim reçoit enfin le sien, `swarmNode`, 10 pistes. Aucune
  piste retirée.
- Dialogue : un nouveau lot d'environ 100 répliques par shard sur les onze
  événements, soit 1 100 entrées de plus.
- JUKEBOX (#120), cinquième voie à la racine : la bibliothèque musicale entière,
  enfin écoutable. Jusqu'ici un morceau ne s'entendait que si le tirage le
  donnait — déterministe sur la famille et la graine du drone — et tout le reste
  restait invisible. C'est une radio et pas un lecteur : elle enchaîne toute
  seule, et elle **continue de jouer quand on la quitte**, dans les menus comme
  en vol. On choisit sa bande-son, puis on décolle avec.

  Elle n'est pas la musique du vol pour autant. L'arc du hack — la musique
  sourde, le duck du rituel, l'explosion au drop, l'intensité qui suit le
  pilote, la mort au choc — appartient à FIELD et ne bouge pas d'un pouce
  lorsque la radio est éteinte. Quand elle joue, elle joue à plat et le vol ne
  la touche plus : ni filtre aux gaz, ni coupure au crash.

- Un pool musical pour SWARM NODE (#116). La 7ᵉ famille — le nœud de
  commandement d'un essaim — était absente de `MUSIC_POOLS` : le vol le plus
  rare du jeu était aussi le seul à se jouer en silence. Son noyau est une
  techno dure menée par le kick, hoover gras en lead, sèche et proche ; à
  Carpenter elle emprunte l'ossature — ostinato mineur figé sur une pédale de
  basse immobile — et non le timbre. 132-142 BPM.

- Mode turtle (#105). Une machine sur le dos n'avait qu'une issue depuis D9 :
  couper le lien et la perdre. Une touche — `T` par défaut, remappable comme les
  autres — la remet à l'endroit, et la ligne `[T] TURTLE` s'affiche à l'écran
  dès que la machine est immobile ET sur le dos, au-dessus du rappel
  `[HOLD K] CUT LINK` : des deux issues, celle qui rend la machine se lit avant
  celle qui la perd. Le retournement est assisté plutôt que piloté aux moteurs
  inversés (pas de `motors[4]` signé, pas de modèle de pale inversée), mais son
  couple est plafonné à ce que deux moteurs de l'appareil peuvent réellement
  produire, et il s'arrête seul — assiette rétablie, ou délai dépassé.


- La culmination du hack est de retour (#101). Le retrait du CONTROL VECTOR
  (#33) avait supprimé `src/ritual.js` en entier, alors que le problème tenait
  à la moitié haute du fichier : la saisie d'un vecteur mémorisé hors du jeu,
  qui bloquait un joueur l'ayant oublié. La culmination qui suivait est partie
  avec elle, et `[ JACK IN ]` coupait droit au résultat.
  Elle revient seule, sur son propre écran entre l'invite et `CONTROL
  ACQUIRED` : `src/culmination.js`, une à quatre secondes plein écran
  (variante V1–V4 tirée sur la graine de la cible,
  `tools/culmination-model.mjs`), les primitives demo scene pondérées par
  famille (`FAMILY_PRIMITIVES`, revenu dans `src/hack-grammars.js`), les quatre
  couleurs d'événement, un coup à chaque battement, et la signature sonore de
  la famille (`CULMINATION_SCORES` / `scoreFor` dans
  `tools/ui-audio-model.mjs`, `uiAudio.playCulmination()`) pendant que la
  musique se retire. Rien à presser : elle démarre seule, rend la main seule,
  Échap saute le battement. `prefers-reduced-motion` la réduit à un seul
  battement sans flash.
  Ce qui ne revient pas : la saisie du vecteur, son riser (`ritualTension`) et
  le blocage qu'ils portaient. La Bible §19 compte donc à nouveau deux porteurs
  de la palette demo scene, l'intro et la culmination, ce que vérifient
  `tools/palette-selftest.mjs` et `tools/intro-primitives-selftest.mjs`.

- Le modèle de vol connaît maintenant le vol en translation (#91). Trois
  mécanismes qui manquaient, et que tout pilote ressent :
  - **Portance de translation** : en avançant, le rotor s'échappe de son propre
    flux induit et gagne en rendement — +21 % de poussée à 20 m/s sur le 5"
    de référence. Ce n'est pas un terme de plus : `kInflow` EST déjà la pente
    d'inflow de la théorie du disque, et le nouveau calcul la GÉNÉRALISE, en
    forme fermée (Glauert), sans itération à 250 Hz. L'air calme et le vol
    purement vertical restent identiques au bit près, et la branche de descente
    est laissée telle quelle : entre −2·vh et 0 la théorie n'a pas de solution
    du tout, et ce régime est déjà modélisé empiriquement comme propwash.
  - ~~**Flapback**~~ : ajouté puis **retiré avant publication** (#103, voir
    Corrigé plus haut) — les deux moments qu'il apportait rendaient l'appareil
    impilotable en vitesse.
  - **Précession des rotors** : un lacet pendant un roulis déplace le nez.
    Complémentaire du terme d'inertie d'hélice déjà présent en lacet, pas
    redondant : l'un a besoin que le régime CHANGE, l'autre seulement qu'il ne
    soit pas nul.
  Aucun nouveau réglage par famille : tout se dérive de la géométrie et des
  coefficients existants.
- `sim/tools/aero-selftest.mjs` : banc sans Rapier, sans scène et sans
  navigateur, dans la chaîne CI, qui affirme des identités et jamais des
  nombres relevés — le résidu de Glauert, la limite de saturation contre la
  constante d'inflow elle-même, le câblage exact de la précession avec l'inflow
  coupé pour l'isoler. Il porte aussi une version headless de la porte
  anti-divergence sous roulis tenu, qui exigeait Rapier et une scène installée.
- `node tools/tune-pid.mjs --cruise` fait voler le banc en avant, à la vitesse
  d'équilibre propre à chaque famille, et juge un candidat sur le PIRE des deux
  régimes. Les PID livrés ne changent pas : au point de fonctionnement du banc
  le plant n'a pas bougé — `npm run tune` est identique au bit près — donc le
  tune reste exactement aussi mesuré qu'avant.


- La marque entre dans le jeu (#73). `docs/brand.md` réservait depuis toujours
  le verrouillage empilé — le symbole, puis `F P V T P !` dessous — au « splash,
  boot » ; il n'avait jamais été posé, et la marque ne sortait que du favicon et
  de la carte Open Graph. Elle tient maintenant le cracktro de lancement, et
  elle s'y **trace module par module** : le cadre d'abord, parce que le cadre
  EST le panneau, puis les quatorze cellules en ordre de lecture, puis le nom
  s'inscrit dessous. La marque est un randomart figé (`brand.md`) et un
  randomart, dans ce jeu, ça se trace (#57).
- Tout tient dans la phase `reveal` de l'intro : aucune durée nouvelle,
  `tools/intro-model.mjs` ne bouge pas, et le selftest refuse un tracé qui
  déborderait sur la plasma. Le sinus-scroll ne possède plus que la phase
  `plasma` — pendant `reveal` et à la résolution le verrouillage est immobile et
  exact, c'est-à-dire juste aux deux moments où l'œil le lit.
- La marque ne prend **jamais** une couleur demo, pas même sous la plasma : le
  cyan et le magenta appartiennent à l'écran, pas au logo (`brand.md`,
  « Interdits »). Sa zone de respect est opaque pour la même raison — sans ça
  les chiffres de la plasma venaient jusque contre ses modules.
- `tools/brand-mark-model.mjs` porte la géométrie, parce que le premier écran du
  jeu ne peut pas dépendre d'un fetch. C'est une copie, et
  `tools/brand-mark-selftest.mjs` est ce qui l'empêche de dériver : il lit
  `public/brand/fpvtp-mark.svg` et le motif de `docs/brand.md`, et exige que
  les trois décrivent la même marque.


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
  `docs/brand.md` dit où va chacune.

- La marque entre au dépôt (#58). `sim/public/brand/` porte les trois SVG —
  `fpvtp-mark.svg` en `currentColor`, `fpvtp-icon.svg` sur son fond `--black`,
  `fpvtp-mark-extrude.svg` pour l'extrusion — et `png/` sept tailles de 16 à
  1024, deux fois : la marque seule et l'icône sur fond. `docs/brand.md`
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

- **Le brouillage du lien vidéo est nettement adouci**, analogique et digital.
  Il ne l'était pas trop par nature : il ne s'appliquait simplement jamais en
  LIVE — `bootLive()` n'appelait pas `setLink()`, donc `_linkMode` restait à
  `LINK_OFF`. Le câbler a rendu visibles des valeurs calibrées à une époque où
  personne ne volait dessus.

  Le vrai moteur n'était pas l'obstruction mais le RSSI annoncé de la cible :
  tirée entre -52 et -72 dBm contre une référence de -35, la plus faible
  démarrait 37 dB dans le rouge avant le moindre bâtiment, et se retrouvait
  dégradée en stationnaire à découvert. `BASE_LOSS_WEIGHT` en retient désormais
  la moitié. La bande de dégradation part de 22 dB au lieu de 18,
  l'obstruction plafonne à 34 dB au lieu de 38, et la diffraction à 7 au lieu
  de 8. `LOSS_CLEAN` et `LOSS_DEAD` bougent **ensemble** : `geofence.js` code en
  dur `FENCE_SPAN = 58` et suppose que c'est exactement leur écart, sans quoi
  sortir de la zone ne coupe plus le lien.

  Résultat mesuré, par cible et par obstacle — à découvert 1,00 quelle que soit
  la cible ; derrière un mur de 3 m, 0,76 à 0,97 ; derrière un immeuble de
  30 m, 0,36 à 0,57. Côté digital, seule la sévérité *après* la falaise est
  réduite (fraction de blocs, déplacement, quantification, coutures) ; le seuil
  d'entrée reste à 0,60, sa valeur d'origine.
- Le serveur sait identifier un joueur derrière un CDN (`FPVTP_TRUST_CF_IP=1`,
  lecture de `CF-Connecting-IP`). Sans ça, mettre le domaine derrière Cloudflare
  — ce qu'on veut faire, la bande passante étant du statique immuable — écrasait
  tous les visiteurs sur les adresses de l'edge : la limite de cinq inscriptions
  par heure et par adresse devenait cinq pour Internet entier. Le drapeau est
  **volontairement opt-in** : cet en-tête n'est digne de confiance que si
  l'origine n'accepte que le CDN, et `deploy/README.md` porte la règle de
  pare-feu qui rend cela vrai.

- **Le clavier est jouable.** Il ne l'était pas : manches binaires — une tape
  valait 820 °/s — et un état d'entrée qui pouvait larguer le joueur à 40 m/s
  et 80° d'inclinaison. Les axes clavier montent maintenant sur 150 ms et
  atteignent toujours la butée si on tient, et le tirage d'entrée est plafonné
  en l'absence de manette. **L'acro reste le mode par défaut pour tout le
  monde** : la rampe est ce qui le rend tenable sans manche, pas un changement
  de mode. **Aucun gain PID, aucune constante mesurée, aucun rayon de collision
  n'a bougé** : c'est de la mise en forme d'entrée.
- Le dépôt est public, donc les deux bascules que cela impliquait : le flux de
  mise à jour passe de `provider: generic` sur un domaine placeholder à
  `provider: github`, et `deploy/deploy.sh` n'exige plus de jeton — une Release
  publique se télécharge sans authentification, le jeton ne fait plus que
  relever la limite d'appels.
- Les surfaces publiques sont en anglais : les workflows CI (leurs noms
  s'affichent sur chaque vérification de pull request), le corps des notes de
  version, `deploy/`, le hook de commit, `docs/manual.md`, `docs/brand.md`,
  `sim/server/`, les outils en ligne de commande, et `sim/src/main.js` avec ses
  quelque 1 280 lignes de commentaires.
- Trois actions destructrices demandaient un seul clic, dont une qui efface
  des centaines de mégaoctets de terrain. `REMOVE` devient
  `[ REMOVE TERRAIN ]` — nommé pour ce qu'il détruit — et les trois réclament
  une seconde pression.
- Contraste : `--faint` portait de l'information de 11-13 px à 3,04:1, sous le
  seuil AA. Il passe à 4,98:1 — et à .53 plutôt qu'au .55 que l'audit
  proposait, parce que .55 donne 5,27:1 et entre en collision avec
  `--light-grey` à 5,26:1, aplatissant la hiérarchie que ces deux jetons
  servent à exprimer. `--red` et `--rule-strong` suivent, le second passant le
  seuil de 3:1 des bordures d'interface.
- Le panneau RÉGLAGES portait encore les contrôles du système — sélecteurs
  arrondis, flèches natives, cases à cocher colorées — à côté des contrôles du
  banc aplatis depuis longtemps. Cinq traitements d'état vide deviennent un
  seul.


- Le `README.md` est réécrit : court, en anglais, et c'est désormais la porte
  d'entrée publique du projet (#96, #97). `docs/manual.md` reste la
  documentation technique.
- Les fichiers de documentation prennent des noms anglais, et la règle
  « anglais » devient **per-fichier** (#88) : un fichier qu'on touche pour une
  autre raison en ressort en anglais. La passe unique avait été écartée — elle
  serait entrée en conflit avec toutes les branches ouvertes.
- `npm run add-music` passe par `uv run` au lieu de deviner un chemin `.venv`
  (#64) : la génération ne dépendait plus de l'endroit où l'environnement Python
  s'était installé.
- Les PNG de `sim/docs/diagrams/` sont régénérés (#98), en accord avec les blocs
  mermaid qui les accompagnent.
- `tools/dialogue/generate.mjs` écrit les shards en tabulations, comme le corpus
  depuis sa réindentation : une génération ne réécrit plus tout le fichier.
- `[T] TURTLE` et `[HOLD K] CUT LINK` s'affichent après 1,5 s d'immobilité au
  lieu de 4 (#114). Les deux lisent le même `stuck` : une machine coincée
  proposait sa sortie trop tard pour qu'on croie encore qu'il y en avait une.

- Le moteur est baissé de 9 dB au total par rapport à la musique (#110, #112).
  Le trim moteur passe de 0.55 à 0.39 puis à 0.20 : après #122, le bruit du
  drone écrasait encore les morceaux, et -3 dB n'ont pas suffi. On baisse le
  moteur plutôt que de remonter la musique, dont le calibrage -14 LUFS est la
  référence de toute la bibliothèque.

- Les deux clôtures — la muraille du bord de carte (`geofence-dome.js`) et le
  dôme de fenêtre live (`fence-dome.js`) — partagent désormais un champ commun
  (`src/fence-field.js`) : une masse organique cyan/magenta à la place des
  lignes de scan (#107). Signalé au jeu : « les rayons se voient un peu trop ».
  Les bandes horizontales se projetaient en éventail depuis le point de fuite
  dès qu'on longeait le mur ; le motif est maintenant un fbm à domaine déformé,
  ses veines suivent les lignes de niveau du champ et n'ont donc aucune
  direction privilégiée. S'y ajoutent un Fresnel (discrète de face, franche en
  rasant), une bande qui suit la hauteur d'œil, une dominante qui glisse du
  cyan vers le magenta en approchant du bord, et un anneau qui part du point
  le plus proche du drone à cadence croissante — silence complet au centre.
- En mode `?live=`, le terrain lointain ne se dissout plus dans un cyan plat
  mais dans ce même champ (#107) : la brume prend ses paquets et ses filaments
  magenta, et la masse éclaircit sa densité par endroits, si bien que le
  terrain reparaît dans les trouées — jamais l'inverse : la brume n'est au pire
  jamais plus épaisse qu'avant. La nappe est échantillonnée à la position monde du
  fragment — pas projetée sur le dôme, ce qui recréait un éventail de rayons —
  et à deux octaves plutôt que trois, le détail fin n'étant jamais résolu sur
  une brume vue en enfilade.

- **Une passe de cohérence visuelle sur tout le jeu** (#133 à #140). Le système
  était sain — `tokens.css` fait autorité et `palette-selftest` tenait — mais
  presque toute la dérive vivait hors de sa portée : dans le JS, dans le HTML,
  dans les valeurs non-couleur et dans les chaînes affichées.

  L'écran de chargement **parle anglais** : neuf étapes, l'unité `Mo`, les trois
  erreurs de `loader.js` qui s'affichent telles quelles, et `lang`. Le preset de
  rates que l'OSD annonce à chaque vol s'appelait « cinéma ».

  La **marque n'a plus qu'une composition** (`src/brand-lockup.js`) : le boot
  écrivait le nom long en Departure Mono capitalisée, soit « FPVTHEPLANET! »,
  que `docs/brand.md` n'autorise nulle part.

  Les **états** cessent de changer de sens d'un écran à l'autre : une seule
  opacité désactivée au lieu de trois, un bouton de panneau qui s'inverse comme
  le même bouton ailleurs, un focus qui est le marqueur ▌ et rien d'autre, et le
  périphérique actif qui ne porte plus exactement l'encre du survol.

  Le **mouvement** rentre dans les trois durées, deux cadences entretenues
  rejoignent les jetons, et le mouvement réduit couvre enfin les trois
  animations infinies et l'impression ligne à ligne du bootstrap et du BRIEFING.

  Les **crochets** ne veulent plus dire trois choses : `[ LABEL ]` un bouton,
  `[LABEL]` une touche, et c'est tout. Les infobulles natives disparaissent, et
  les symboles SI passent en minuscules.

  **Toute valeur typographique sort de l'échelle** : le corps du jeu était à
  14px, quinze tailles et cinq interlettrages étaient écrits en clair, une
  trentaine d'espacements étaient magiques.

  Un **seul montage d'écran** (`src/screen.js`) au lieu de deux, dont un seul
  avait gagné l'impression inverse de #67 ; cinq plans d'empilement nommés ; et
  le CSS mort s'en va.

  Enfin, `palette-selftest` **voit ses angles morts** : la palette demo atteinte
  par `token()`, les échelles écrites en pixels, et le français dans une chaîne
  affichée.


- Le soleil ne mange plus l'image (#94). Face à lui on ne voyait presque plus
  rien, et la raison n'était pas « c'était trop fort » : trois termes
  s'empilaient sur les mêmes pixels et **deux d'entre eux se combattaient**. Le
  halo et le voile sont peints APRÈS le gain d'exposition — il le faut, sinon la
  caméra s'auto-atténuerait son propre soleil — donc l'AGC ne pouvait pas les
  reprendre : il ne pouvait qu'assombrir tout le reste en essayant. Les noirs
  montaient à 0,27 près du soleil pendant que l'image tombait à 60 % de sa
  luminance, et le contraste utile disparaissait exactement là où le pilote
  regarde. Un premier passage (#11) avait rogné les deux sans voir qu'ils
  tiraient en sens inverse.
  Seul le terme additif pouvait trancher, puisqu'il est celui que rien ne
  rattrape : halo 0,9 → 0,12, voile 0,14 → 0,03, disque ×1,6 → ×0,8. Et le
  posemètre desserré en face (poids du disque 1,5 → 0,11) — moins de lumière
  parasite à compenser, donc moins besoin de fermer. C'est ce poids qui bouge et
  non `E_MIN`, parce que `E_MIN` a un autre métier (il normalise un ciel très
  lumineux) et parce qu'une butée écrase la rampe : la fermeture reste
  progressive sur toute la traversée du cadre, elle ne va simplement plus aussi
  loin. Le soleil reste un événement optique — un disque net, un reste de halo —
  mais il ne fait plus mur. Contraste près du soleil ×3, image loin de lui 50 %
  plus claire.


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


- Le nom, sur le cracktro, passe de la display à `--font-ui` interlettré
  `--track-ui` : c'est la composition que `docs/brand.md` impose au
  verrouillage empilé, et la marque n'a qu'une composition (#73).


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

### Corrigé

- Le `README.md` indiquait `npx electron-builder` seul pour construire l'app de
  bureau. La commande empaquette `dist/` tel qu'elle le trouve sans jamais le
  reconstruire, et `dist/` est gitignoré : changer de branche puis empaqueter
  livrait la nouvelle coquille Electron autour de l'ancien jeu. Constaté en
  pratique. Le workflow de release, lui, a toujours construit avant.

- **L'imagerie Google n'était créditée nulle part sur le seul chemin qu'un
  inconnu emprunte.** `setCredit()` n'était appelé que depuis le chemin des
  scènes installées : le vol LIVE — la seule chose qu'un clone frais sache
  faire — affichait la photogrammétrie de Google sans attribution. C'est une
  obligation, pas une politesse. Créditée maintenant en vol et sur l'onglet
  LIVE avant le décollage, avec le même littéral des deux côtés.
- Un délai silencieux de 45 s finissait dans un vide infini : son expiration
  partait dans la console, le vol démarrait sans collisionneurs, et la boucle
  de réapparition tournait pour toujours dans du cyan vide. L'attente est
  visible pendant qu'elle a lieu, et l'échéance sans sol est une erreur avec un
  message.
- La dégradation du lien vidéo ne s'enclenchait pas hors du chemin des scènes
  installées : LIVE et BENCH perdaient silencieusement une signature de l'image.
- L'écran du scanner mentait. Sa ligne de touches annonçait
  `[ESC] OPERATION MODE` pendant le tracé, alors qu'Échap repose l'outil, et
  pendant un travail, alors qu'Échap ne fait rien. L'audit la croyait absente ;
  elle était présente et fausse, ce qui est pire.
- L'avis d'instance partagée disait d'installer le client de bureau pour
  acquérir du terrain. Electron démarre le serveur en mode `local` et ne pose
  pas davantage le drapeau d'acquisition : c'était une consigne d'aller là où
  cela échoue aussi. La ligne FIELD proposait la même chose.
- Le `README.md` annonçait « ~1 200 vérifications » là où la chaîne en compte
  2 723, disait que `R` fait réapparaître la machine — c'est faux en FIELD, et
  volontairement — et invitait aux contributions sans lier quoi que ce soit.
- La section non publiée de ce fichier avait accumulé quinze titres de
  rubrique, `Ajouté` quatre fois. `release-notes.mjs` la recopie telle quelle
  dans le corps de la Release : les notes de la 1.0.0 l'auraient dit quatre
  fois.


- `music/heavy5-4436683e.opus` est restauré (#126). Le manifeste le référençait
  encore : une piste de la famille `heavy5` manquait à l'installation, et le
  tirage qui tombait dessus jouait dans le vide.
- **La télémétrie n'avait aucune borne supérieure : une session pouvait être
  stockée sans jamais pouvoir être close** (#83). `validateSession()` ne
  demandait que « fini et >= 0 », et la valeur vient du navigateur : un
  `durationS` de 1e308 passait, puis `1e308 + 1e308` débordait à `Infinity` à la
  fusion — le verdict était refusé et le vol restait `PENDING` pour toujours ;
  l'écran DATA, lui, annonçait une carrière d'`Infinity` secondes. Chaque champ
  a désormais son plafond (`sim/tools/lib/telemetry-bounds.mjs`), la fusion
  sature au lieu de déborder, et l'écran DATA applique les mêmes bornes à la
  lecture — le fichier d'opérateur reste éditable à la main.
- **Un corps de requête trop gros recevait une coupure de connexion au lieu
  d'une réponse** (#84). `readBody()` détruisait la socket dès le dépassement du
  plafond, donc le 400 que la route envoyait ensuite partait dans le vide : le
  client lisait `ECONNRESET` et la GUI affichait « erreur réseau » là où le
  serveur voulait dire « corps trop gros ». Il répond maintenant 413 puis
  continue de lire et de jeter le reste quelques instants — une socket détruite
  alors que des octets sont encore en vol envoie un RST, et le client jette la
  réponse qu'il avait déjà reçue. C'est le `lingering_close` de nginx, borné en
  octets et en temps ; le corps n'est toujours jamais analysé.
- **Le GLOBAL SCANNER mourait sur une réponse de fournisseur mal formée**
  (#85). `String(v)` n'est pas total et `Math.round(v)` non plus : sept appels
  passent par `asText()`/`asNumber()`, `areaAnalysis()` ne déréférence plus une
  réponse `/describe` tronquée, `DENSITY['__proto__']` ne rend plus
  « ~NaN–NaN DRONES », et un panic Go du sous-processus n'arrive plus entier
  sur le rail. Une cible `scanner` a été ajoutée à `npm run fuzz`.
- **Une seule frame invalide tuait le contrôleur de vol pour de bon.** Les
  filtres de `AxisPid` sont des moyennes glissantes : un manche non fini — un
  calibrage cassé — ou un état physique parti en NaN les empoisonnait
  définitivement, et les moteurs restaient à NaN bien après le retour à la
  normale. En mode `altitude`, `holdAltitude` faisait la même chose. Les manches
  sont désormais bornés à l'entrée, un pas de PID non fini réinitialise ses
  propres filtres, et le mixer refuse un gaz non fini (`clamp()` ne retient pas
  un NaN : toute comparaison avec NaN est fausse).

- **Une piste pouvait être écrite sans pouvoir être relue.** La quantification
  multiplie (`lat × 1e5`) : une valeur absurde mais finie débordait à l'infini
  et `validateTrack()` refusait alors le fichier que `encodeTrack()` venait
  d'écrire. Le vol était perdu à la lecture.

- **`String(v)` n'est pas total, et six endroits le supposaient.**
  `{"area": {"toString": null}}` est du JSON valide et fait lever `String()` :
  le journal des sessions mourait en affichant un vol stocké, et
  `validateSession` répondait un message du moteur au lieu de nommer le champ.
  Nouveau `sim/tools/lib/as-text.mjs`, utilisé par `slugify`, `areaLabel`,
  `fit`, `familyLabel`, les validateurs de session et de piste.

- **`keyLabel()` rendait des propriétés héritées.** Une touche stockée valant
  `constructor` faisait afficher `function Object() { [native code] }` dans les
  réglages. Lecture en propriété propre, comme `PROFILES[family]`.

- **Un `deadband` stocké à 1 rendait NaN manche en butée** :
  `normalizeChannel()` divise par `1 - deadband`. `isValidCalibration()`, la
  porte entre le fichier et les moteurs, exige maintenant `0 <= deadband < 1`.

- **Un couloir de largeur nulle divisait par zéro** dans `progress()`
  (`geofence.js`), et `main.js` fait monter la perte d'image sur ce nombre.

- **`normalizeBenchConfig()` promettait de ne jamais lever, et levait** :
  `Number()` lève sur un symbole, un bigint, et sur un objet sans chemin vers
  une primitive.

- **`mergeTelemetry(null, …)` était un TypeError** : un paramètre par défaut ne
  couvre que `undefined`, et `"flightTelemetry": null` tient dans un fichier
  JSON — `closeSession()` mourait dessus au lieu de fermer le vol.

- **`MAX SPEED Infinity m/s` sur le détail d'une session.** JSON n'a pas de
  littéral Infinity, mais `1e400` en produit un, et `(v ?? 0).toFixed(1)`
  l'imprimait. Une télémétrie non finie s'affiche maintenant `—`.

- Le randomart rend la main au drone, et à rien d'autre (#122). Signalé au jeu :
  après l'empreinte de `CONTROL ACQUIRED`, l'écran montrait la carte — vue de
  DESSOUS en reconnaissance FIELD — puis le drone apparaissait un battement plus
  tard. Tout ce qui se voit d'un vol était monté APRÈS la résolution du hack,
  donc après le fondu qui emmène son fond noir : la caméra de la cible, les
  hélices dans le cadre, la disposition de l'OSD et son allumage attendaient un
  `session.open()` — un aller-retour serveur. Et `bootLive()` ne posait jamais sa
  caméra, restée à l'origine ENU, soit l'altitude 0 de l'ellipsoïde : sous le
  terrain, d'où la carte vue de dessous. Le vol s'arme désormais pendant que
  quelque chose le couvre encore : au geste `[ JACK IN ]` sur FIELD — jamais au
  boot, parce que tous les écrans d'avant le geste peuvent encore renoncer et que
  renoncer ne doit rien laisser derrière, pas même une session `PENDING` —, sous
  l'écran de chargement partout ailleurs. La caméra se pose sur la machine,
  assiette d'entrée comprise, dans les deux moitiés de boot.

- Le flapback de #91 rendait l'appareil impilotable, il est retiré (#103).
  Signalé au jeu : le drone part en vrille et ne se rattrape pas. Sur un banc
  6 DOF headless, plein manche de roulis ou de lacet à 26-36 m/s, l'écart
  hors-axe passait de 1-2 °/s avant #91 à **115-222 °/s**. Les coupables sont
  les deux MOMENTS en plan — le moment de moyeu (`FLAP_K`) et le bras du plan
  d'hélice (`ROTOR_PLANE_Y_REF`) — et non la portance de translation (2 °/s) ni
  la précession (3 °/s), qui restent. Dès que l'appareil ne vole pas le long de
  son axe de roulis, un moment proportionnel à la vitesse air balaie tangage et
  roulis à la fréquence de l'entrée, et la boucle de taux ne peut pas le
  rejeter.
  La porte qui manquait est en place : la section 4 de `tools/aero-selftest.mjs`
  tenait l'appareil **en air calme**, où tout #91 vaut identiquement zéro ; elle
  le tient désormais **en vol**, à deux fois la vitesse de croisière de chaque
  famille. Elle mesurait 79 % du taux commandé avant le correctif, 1,9 % après.
  `npm run tune` reste identique au bit près, le banc tournant à vitesse nulle.
  L'issue #91 rouvre sur la seule question du flapback, dont le double comptage
  probable — image battante pour la force, image rigide pour le moment — reste à
  trancher.


- L'écran de fin nommait `[ESC] DISCONNECT`, c'est-à-dire la seule touche que le
  navigateur peut confisquer : en pointer lock, et a fortiori en plein écran, il
  garde Échap pour rendre le curseur et ne délivre aucun `keydown` à la page. Sur
  l'écran dont la seule raison d'être est qu'on en sorte, la ligne promettait donc
  une touche qui pouvait ne jamais arriver — mesuré par `__sim.endState()`, toutes
  gardes propres, la sortie armée et le geste sans effet. Les trois tables (crash,
  sortie de zone, coupure du lien) nomment maintenant `[ENTER] DISCONNECT`. Échap
  reste acceptée en doublon silencieux, comme le clic et n'importe quel bouton de
  manette (#71).
- En vol live, le terrain se rechargeait à vue et se trouait à chaque recentrage
  de fenêtre (tous les 50 m). Mesuré à 24 m/s au Champ de Mars : jusqu'à 7 % du
  sol absent à chaque vague, par trois chemins — les nœuds « couverts » par un
  autre niveau étaient libérés une frame après le recentrage (la file de builds
  est vide à cet instant, les fetchs de la vague n'ayant pas encore répondu), un
  nœud dont le refetch était encore en vol tombait dans la libération sèche s'il
  changeait de niveau, et un nœud grossier rebâti avec un octant en moins
  arrivait du cache avant l'enfant fin qui redessine cet octant. Règle unique
  maintenant (`src/live-node-queue.js`) : l'ancienne image reste intacte jusqu'à
  ce que la nouvelle soit complète — plus rien en vol ni en file — puis on
  échange ; soupape à 15 s si le réseau ne suit pas. Un refetch qui échoue
  garde le mesh périmé au lieu de le retirer. Mesuré après : 0 trou sur 239
  échantillons et 1,3 km, pour ~30 % de meshes en plus en pointe pendant une
  vague — moins optimisé, jamais troué (#75).


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

- `faviconDataURI()` de `src/pixel-icons.js` : le favicon ne vient plus du drone
  pixel art. L'option `background` d'`iconSVG()` part avec lui — elle n'existait
  que pour ce data URI, qui ne voyait pas les `var(--…)` de la page. Les neuf
  icônes elles-mêmes restent, `drone-portrait.js` et `drone-wire-svg.js` les
  utilisent (#58).


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

- Le **scrolltext du cracktro** : la ligne de greetings qui défilait en bas de
  l'intro disparaît. Le logo, la plasma et la résolution restent inchangés.

### Sécurité

- **Passe de sécurité complète avant la 1.0.0.** Un audit du dépôt a produit
  des exploits reproduits, pas des hypothèses ; ce qui suit est ce qu'il a
  fermé.
- Le serveur de fichiers pouvait être quitté par lien symbolique. `safeJoin`
  était purement lexical : `../` était refusé, un lien ne l'était pas, et un
  `scenes/<slug>/pwn.json` pointant sur `/etc/passwd` était servi en 200. Le
  chemin réel est désormais résolu et vérifié dans la racine avant toute
  ouverture. Les racines sont résolues une fois et mises en cache — ce n'est
  pas une optimisation : `/opt/fpvtp/current` est lui-même un lien, et une
  résolution naïve aurait refusé toutes les requêtes légitimes du VPS. Coût
  mesuré : 6,8 µs sur une requête de 0,86 ms.
- La limite d'inscription se contournait. `clientIp()` lisait le PREMIER saut
  de `X-Forwarded-For`, or Caddy AJOUTE l'adresse réelle à ce que le client a
  envoyé : la première valeur était donc celle du client, changeable à volonté.
  Sur une instance publique, cette limite est la seule qui existe. C'est le
  dernier saut qui est lu maintenant, et le `Caddyfile` retire en plus
  l'en-tête que le client aurait posé.
- Trois routes de l'API carte étaient du travail non borné, sans verrou ni
  compteur. `describe`, `plan` et `probe` acceptaient un polygone de 180° sur
  170° : un degré au zoom 20 coûtait 388 ms et 17 Mo de réponse, quatre degrés
  7,8 s — et le serveur est mono-processus, donc un appelant bloquait tous les
  joueurs. Elles refusent maintenant avant d'allouer, avec un plafond tiré de
  ce que `add-map` demande réellement.
- Le décodeur rocktree allouait ce que le réseau lui disait d'allouer. Huit
  octets d'entrée réclamaient 8 Gio et occupaient le fil 73 s — et ce module
  tourne aussi dans le worker du navigateur sur le chemin `?live=` : la cible
  était la machine du joueur. Toute longueur lue dans le flux est désormais
  bornée par ce que le tampon peut contenir.
- Une injection HTML stockée vivait dans l'origine qui détient la clé
  d'opérateur. Un commentaire de session et un régime météo entraient sans
  échappement dans le détail de session, et un nom de scène — rempli
  automatiquement depuis un `display_name` de Nominatim, donc depuis la
  réponse HTTP d'un tiers — dans l'écran météo. Sur une instance partagée, le
  commentaire d'un joueur s'affiche chez un autre opérateur. Les trois passent
  maintenant par le DOM, et `sanitizeWeatherSnapshot` choisit les clés qu'elle
  connaît au lieu de recopier ce qui arrive.
- Aucun en-tête de sécurité n'était envoyé. `sim/server/headers.mjs` les pose
  au centre, avant que l'API et le serveur de fichiers voient la requête :
  `nosniff`, refus d'encadrement, aucun référent, isolation d'ouvrant. La CSP
  est en **Report-Only** volontairement — ses directives sont tirées de ce que
  le code charge vraiment, mais aucun navigateur n'a pu les confirmer ici, et
  `index.html` porte un script en ligne délibéré (la sonde WebGL2, dont le
  métier est justement d'écrire à l'écran quand le bundle échoue). Passer en
  application est documenté dans le fichier.
- Electron confiait au système n'importe quelle URI produite par le renderer.
  `shell.openExternal` n'avait aucune liste blanche de schéma et il n'y avait
  aucun garde de navigation : `contextIsolation` contient bien un renderer
  compromis, `openExternal` est un trou qui en sort. Liste blanche https, http
  et mailto, navigation épinglée à l'origine de l'application, refus
  d'attacher une webview que le jeu n'embarque pas.
- `FPVTP_UPDATE_URL` pouvait rétrograder le flux de mise à jour vers n'importe
  quoi, avec téléchargement automatique et sans signature nulle part. C'était
  sans conséquence tant que le flux était un placeholder ; le passage à
  `provider: github` a rendu le mécanisme actif. HTTPS, ou pas de mise à jour.

- L'API du jeu regarde maintenant d'où vient la requête, en `local` comme en
  `shared` (#79). En `local` elle n'a pas de clé — la frontière est le socket
  local — et n'importe quelle page visitée pendant un `npm run dev` pouvait
  donc écrire dedans (requête simple, sans preflight), voire tout lire par
  rebinding DNS : profils, sessions, captures, catalogue de scènes, et
  jusqu'à la suppression d'un terrain de plusieurs heures. `/__operator` et
  `/__map-api` exigent désormais un `Host` de boucle locale en `local`, et
  refusent toute méthode écrivante qui se présente cross-site (`Origin`,
  `Sec-Fetch-Site`) ; un corps qui n'est pas `application/json` est refusé
  avec.
- En `shared`, une clé d'opérateur ne suffit plus à supprimer une scène pour
  tout le monde (#78). L'inscription étant libre et sans rôle ni propriétaire,
  n'importe quel joueur inscrit pouvait effacer un terrain de l'instance —
  sans moyen de le reconstruire, l'acquisition étant fermée en `shared`.
  `DELETE /__map-api/scenes/:slug` et `DELETE /__map-api/jobs/:id` rendent
  maintenant 403 en `shared`, comme `POST /jobs` : une instance partagée sert
  le LIVE, elle ne se fait pas défaire par ses visiteurs.
- Le paramètre `?scene=` n'atteint plus l'écran de chargement tel quel. Un
  slug inconnu était repris dans le message « carte inconnue », que
  `hud.fail()` écrivait via `innerHTML` : un lien forgé exécutait du balisage
  dans l'origine du jeu pour tout joueur déjà inscrit, avec la clé d'opérateur
  lisible depuis `localStorage`. Le slug est maintenant validé au chargement
  (`[a-z0-9-]+`, la règle du serveur), et l'écran de chargement n'écrit plus
  que du texte.

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
  prépare à devenir public. `docs/manual.md` reste le README technique.
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
  lequel lire : `sim/README.md` devient `docs/manual.md` — il reste entier,
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

[Non publié]: https://github.com/lionrayonnant/FPVThePlanet/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/lionrayonnant/FPVThePlanet/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.1.0-beta...v0.3.0
[0.1.0-beta]: https://github.com/lionrayonnant/FPVThePlanet/releases/tag/v0.1.0-beta
