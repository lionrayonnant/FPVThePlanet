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
  prépare à devenir public. `sim/README.md` reste le README technique.
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
