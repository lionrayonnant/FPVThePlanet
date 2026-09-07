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

### Retiré

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
  était un booléen global et `fpvmaps.gamepadMap` une entrée unique, si bien
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

[Non publié]: https://github.com/lionrayonnant/FPVTP/commits/main
