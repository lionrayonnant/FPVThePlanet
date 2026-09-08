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

### Ajouté

- Un briefing de quatre écrans (`INPUT`, `THE TERMINAL`, `A SESSION`,
  `BRIEFING COMPLETE`) accueille un opérateur qui vient d'être créé, juste
  après le CONTROL VECTOR. Il énonce, il n'ordonne pas ; Échap le saute ;
  `[ CALIBRATE ]` et `[ MAP KEYS ]` ouvrent le bon onglet de `SETTINGS` et
  reviennent, et l'écran `INPUT` lit le mappage en direct. Il se rejoue par
  `SETTINGS` › `SYSTEM` › `[ REPLAY BRIEFING ]`. Le premier vol hors banc
  affiche trois lignes brèves — `THROTTLE UP`, `[TAB] SETTINGS`,
  `[HOLD K] CUT LINK` — puis plus jamais (#16).

- Le panneau `SETTINGS` (Tab) passe à la direction artistique du terminal :
  en-tête `FPVTP! // SETTINGS`, quatre onglets `CONTROLLER · KEYBOARD · AUDIO
  · SYSTEM`, un corps à la fois, et l'onglet ouvert est retenu pour la session.
  `KEYBOARD` liste chaque action avec ses touches et un `[ REBIND ]` : la
  touche suivante est prise, Échap annule, une touche déjà prise déclenche un
  échange annoncé sur la ligne, `[ RESET KEYS ]` remet les valeurs d'usine.
  `SYSTEM` porte la portée d'affichage (mode `?live=`), `[ RESET SETTINGS ]`
  et le numéro de version (#15).
- Tests couvrant qu'un vol EN DIRECT remplit bien le Session Log, le Target
  Log et le compteur OPERATOR, et n'est jamais proposé en REVISIT/RESUME (#8).
- Les commandes clavier passent par une table remappable (`src/key-map.js`) :
  une action porte un nom (`throttleUp`, `pause`, `cutLink`…), ses touches se
  changent, et les valeurs par défaut couvrent QWERTY et AZERTY (W/Z, A/Q).
  Réglages rangés dans `fpvtp.keyMap` ; Tab, Échap et Entrée restent fixes.
- L'écran de fin de vol montre la machine perdue en 3D, celle qui volait —
  livrée, numéro et châssis compris — et on peut la tourner à la souris. Elle
  tourne seule d'un tour toutes les 24 s. Sans contexte WebGL, le portrait fil
  de fer d'avant prend le relais ; l'archive, elle, garde le SVG (#13).

### Modifié

- Le panneau `SETTINGS` prend le noir du terminal, ses filets et ses trois
  niveaux typographiques, et remplace son bouton `Close (Tab)` par la ligne de
  touches `[ESC] CLOSE · [TAB] CLOSE`. Le rappel clavier figé qui vivait sous
  `Controls` a disparu : l'onglet `KEYBOARD` le remplace, et il dit la vérité.

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

### Modifié

- Le menu a quatre voies au lieu de deux : `FIELD`, `BENCH`, `ARCHIVE`,
  `SETTINGS`, à la racine et dans cet ordre. ARCHIVE n'est plus un lien enterré
  dans un onglet de FIELD, SETTINGS n'est plus répété à trois endroits, et
  `fpvtp.mode` retient les quatre (#6, #7).
- FIELD ouvre sur l'onglet `LIVE`, désormais placé avant `LOCAL` : c'est la voie
  qui marche sans rien avoir téléchargé. Sur un serveur qui n'acquiert pas,
  l'onglet LOCAL est éteint et dit en trois lignes pourquoi, au lieu de laisser
  une liste vide (#6).
- La tête de FIELD ne salue plus l'opérateur (la racine le fait, une fois) et
  son pied ne compte plus rien : il dit `LOCAL INSTALLATION · BUILD n` ou
  `SHARED SERVER · BUILD n`. Les compteurs vivent dans ARCHIVE › OPERATOR (#6).
- Échap est écrit sur les écrans qui l'écoutent : `[ESC] OPERATION MODE` sous
  FIELD, BENCH et ARCHIVE, `[ESC] BACK` sur les écrans en dessous (#7).
- La caméra libre (`C`, une orbite qui gelait le monde) devient une bascule de
  vue `V` : FPV / CHASE. La vue CHASE est la caméra de vol reposée 1,6 m
  derrière le nez et 0,6 m au-dessus, la simulation continue de tourner
  derrière elle, et elle marche sur tous les chemins (LOCAL, LIVE, BANC). Un
  bouton `[V] FPV` / `[V] CHASE` en haut à droite de l'OSD fait le même geste
  à la souris. Chaque vol commence en FPV (#12).
- L'écran affiche la vraie version du paquet (`v0.0.0`, ou `dev` hors build
  Vite) au lieu de la constante de lore `0.97b` (#9).

### Corrigé

- Le portrait de la machine manquait sur deux fins de vol sur trois — sortie de
  zone et lien coupé — et sur tout vol NOMINAL (`?family=`, `?scene=`, `?live=`,
  NOMINAL au banc), faute d'exemplaire tiré. Chaque fin porte désormais son
  portrait, et une famille sans tirage en a un déduit de son nom (#13).

- Face au soleil, l'exposition ferme moins fort : entre 55 et 75 % de son
  niveau au repos au lieu de tomber à 35 %, l'image reste pilotable (#11).

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

[Non publié]: https://github.com/lionrayonnant/FPVThePlanet/compare/v0.1.0-beta...HEAD
[0.1.0-beta]: https://github.com/lionrayonnant/FPVThePlanet/releases/tag/v0.1.0-beta
