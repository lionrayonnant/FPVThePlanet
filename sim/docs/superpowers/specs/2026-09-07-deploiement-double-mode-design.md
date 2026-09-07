# Déploiement en deux modes : un serveur loué, une installation chez chacun

Issue [#259](https://github.com/lionrayonnant/FPVTP/issues/259) — 2026-09-07.
Touche aussi [#60](https://github.com/lionrayonnant/FPVTP/issues/60) (PHASE 23,
isolation multi-opérateur), qui devient une tranche de ce chantier.

## Le problème

Le jeu ne tourne que sur la machine de son auteur, sous `npm run dev`.
`tools/map-api-plugin.mjs` est un plugin Vite `apply: 'serve'` : il porte
`/__operator` (l'état opérateur) et `/__map-api` (scènes, acquisition, jobs), et
il n'existe pas ailleurs. Un `dist` servi statiquement meurt au boot sur le
premier `GET /__operator`. Aucune release n'est jouable ; l'archive `dist.zip`
attachée par `release.yml` est un build qui ne démarre pas.

La cible, en deux hébergements :

1. **Serveur** — un VPS loué, plusieurs personnes y jouent depuis leur
   navigateur.
2. **Client** — n'importe qui télécharge une release GitHub et joue chez lui,
   sans ce serveur.

## Ce qui est vérifié, pas supposé

Relu dans le code le 2026-09-07 ; ce sont ces faits qui dictent la forme.

- **L'API n'a aucune dépendance à Vite.** `mapApiPlugin()` monte un
  middleware `(req, res, next)` sur `server.middlewares` ; les tables `opRoutes`
  et `routes` sont du `node:http` nu. Le seul usage de Vite dans le fichier est
  `server.config.logger`. L'extraction est un déplacement, pas une réécriture.
- **Le seul fournisseur inscrit n'a besoin de rien.** Apple Flyover (jeton,
  outil Go) a été retiré du dépôt le 2026-09-07 ; `google-earth` est le seul
  fournisseur restant, et son propre défaut (`DEFAULT_PROVIDER_ID`,
  `tools/lib/providers/index.mjs`) : du `fetch()` nu vers `kh.google.com`,
  décodage en Node (`tools/lib/decoders/rocktree.mjs`), aucun jeton, aucun Go,
  aucun HEIC. Le pipeline complet (télécharger → décoder → `prep.mjs` →
  `scenes.json`) est **du Node pur** plus deux modules natifs : `sharp`
  (planches de texture) et Rapier WASM (point de spawn). Ce constat, déjà vrai
  au moment d'écrire cette spec, est ce qui rend D1 possible sans qu'un second
  fournisseur (Go, jeton) complique la release.
- **Le client ne connaît que deux préfixes d'API** (`/__operator`,
  `/__map-api`) et des fichiers statiques : `/scenes.json`, `/scenes/<slug>/*`,
  `/dialogue/*`, `/music/*`, `/music.json`. Nominatim est appelé depuis le
  navigateur ; Open-Meteo depuis le serveur (`tools/weather-source.mjs`, sans
  clé, snapshot par zone et par jour) ; `kh.google.com` depuis le navigateur en
  mode LIVE (CORS vérifié le 2026-08-31 depuis `localhost`).
- **Les chemins sont figés sur `sim/`.** `SCENES_DIR` et `SCENES_JSON`
  pointent `public/scenes*` (`add-map-core.mjs:20-21`), `OPERATOR_DIR` est un
  sibling de `public/scenes` (redirigeable par `FPV_OPERATOR_DIR`), le cache
  Google vit dans `sim/.cache/google-earth`. Une release qui s'écrase à la mise
  à jour effacerait tout ça : les données doivent sortir du dossier du
  programme.
- **Le modèle de confiance est celui d'un localhost.** Le client choisit son
  `operatorId` dans `localStorage` et le serveur le croit (`src/operator.js`,
  en-tête du fichier : « le serveur ne décide jamais qui tu es »).
  `GET /__operator` liste tout le monde, `DELETE /__map-api/scenes/:slug`
  efface un terrain pour tous, `POST /__map-api/jobs` lance un sous-processus.
  Sur un VPS public, chacun de ces points est un problème.
- **`release.yml` n'a jamais tourné**, ni la CI sur un runner (HANDOFF,
  « Versionnage du dépôt »). Rien n'a jamais été exécuté sous Windows ni macOS.

## La décision centrale — D1 : un seul serveur, deux hébergements

**Il n'y a pas de « mode statique ».** L'installation locale est le même
serveur Node que le VPS, lancé sur `127.0.0.1` et ouvert dans le navigateur de
la personne. Le client navigateur est identique dans les deux cas, au bit près.

Pourquoi pas le repli `localStorage` évoqué dans #259 :

- L'acquisition de terrain — le cœur de la boucle, « Acquire the terrain » —
  a besoin de Node de toute façon (`sharp`, `prep.mjs`, Rapier pour le spawn,
  écriture de 450 Mo par scène). Un client statique ne saurait que voler en
  LIVE : ce serait un autre jeu.
- Deux persistances (fichiers JSON côté serveur, IndexedDB côté navigateur)
  sont deux vérités à maintenir, migrer (`SCHEMA_VERSION`) et tester. Une seule
  suffit si le serveur est toujours là.
- La Bible §33 dit la cible : « chaque personne possède sa propre installation
  FPVTP! sur son ordinateur. » Une installation, pas un onglet.

Un vrai mode statique (GitHub Pages, LIVE seulement, opérateur en IndexedDB)
reste possible plus tard **sans toucher à ce design** : il s'ajouterait comme
troisième hébergement. Il est explicitement hors périmètre ici.

## Architecture

```text
                    ┌──────────────────────────────┐
                    │  sim/server/                 │
                    │  index.mjs  — CLI, démarrage │
                    │  api.mjs    — /__operator    │
                    │               /__map-api     │
                    │  static.mjs — dist/, scènes  │
                    │  auth.mjs   — mode shared    │
                    └──────┬───────────────┬───────┘
                           │               │
     ┌─────────────────────┴───┐     ┌─────┴──────────────────────┐
     │ npm run dev             │     │ node server/index.mjs      │
     │ (Vite + adaptateur      │     │ --data <dir> --mode …      │
     │  map-api-plugin.mjs,    │     │                            │
     │  ~15 lignes)            │     │  local  : chez chacun      │
     │                         │     │  shared : VPS, derrière    │
     │ inchangé pour le dev    │     │           Caddy + TLS      │
     └─────────────────────────┘     └────────────────────────────┘
```

### 1. `sim/server/` — le serveur autonome

**`server/api.mjs`.** Les deux tables de routes de `map-api-plugin.mjs`,
déplacées telles quelles, exportées comme
`createApi({ paths, mode, logger }) -> (req, res, next)`. Le plugin Vite devient
un adaptateur qui appelle `createApi()` avec `server.config.logger` et le monte
sur `server.middlewares` — c'est tout ce qu'il garde. Aucune route ne change de
chemin ni de contrat : le client ne voit pas la différence, et
`session-api-selftest.mjs` non plus.

**`server/static.mjs`.** Un serveur de fichiers écrit à la main, sans
dépendance (la règle du dépôt : « aucune dépendance serveur », en-tête de
`map-api-plugin.mjs`) :

- `dist/` à la racine ; `/scenes.json` et `/scenes/<slug>/*` depuis le
  répertoire de données, pas depuis `dist/` — `scenes.json` est **par
  installation**, il commence vide, et celui versionné dans `public/` ne sert
  qu'au dev ;
- `Range` (les chunks et la collision font des dizaines de Mo, le navigateur
  reprend un téléchargement coupé), `ETag` faible + `Cache-Control:
  public, max-age=31536000, immutable` sur `/scenes/<slug>/*` (une scène ne
  change jamais sous son slug ; `REMOVE` + réacquisition donne le même slug,
  mais le manifest est relu à chaque boot avec `no-cache`) ;
- **pas de repli SPA** : un fichier absent rend un vrai 404 JSON, jamais
  `index.html`. #275 a montré ce que coûte un hébergeur qui rabat tout sur
  `index.html` ; le garde-fou du chargeur reste, mais il n'a plus à servir ;
- types de contenu par extension pour ce que le jeu sert réellement
  (`.js .css .html .json .wasm .jpg .png .bin .opus .woff2 .svg`), rien de
  plus.

**`server/index.mjs`.** L'entrée :

```text
node server/index.mjs [--data <dir>] [--port 8080] [--host 127.0.0.1]
                      [--mode local|shared] [--open] [--dist <dir>]
```

Variables d'environnement équivalentes `FPVTP_DATA_DIR`, `FPVTP_PORT`,
`FPVTP_HOST`, `FPVTP_MODE` (l'option de ligne de commande gagne). `--open`
lance le navigateur par défaut sur l'URL, une fois le port écouté. Le serveur
écrit une ligne au démarrage : version (`package.json`), mode, répertoire de
données, URL.

**`tools/lib/paths.mjs`.** Un seul module résout le répertoire de données en
chemins concrets ; `add-map-core.mjs`, `weather-source.mjs`, `google-earth.mjs`
et l'API le lisent au lieu de leurs constantes :

```text
<data>/
  scenes/<slug>/        ← SCENES_DIR
  scenes.json           ← SCENES_JSON
  operator-state/       ← OPERATOR_DIR
  cache/google-earth/   ← cache des nœuds rocktree
```

**Sous `npm run dev`, rien ne bouge** : sans `FPVTP_DATA_DIR`, `paths.mjs` rend
exactement les chemins d'aujourd'hui (`public/scenes`, `public/scenes.json`,
`operator-state/`, `.cache/`). `FPV_OPERATOR_DIR` reste honoré comme override
du seul répertoire opérateur, parce que les selftests s'en servent. Les 142
sessions de l'utilisateur ne sont ni déplacées ni migrées par cette tranche.

Le répertoire de données par défaut de l'installation locale est celui de la
plateforme, hors du dossier du programme : `~/.local/share/fpvtp` (Linux),
`%LOCALAPPDATA%\FPVTP` (Windows) — Electron expose ça via `app.getPath('userData')`,
pas besoin de le calculer à la main. Mettre à jour l'app ne touche à rien de
ce qui compte : les données vivent ailleurs.

### 2. D2 — deux modes de confiance, `local` et `shared`

Le serveur a **un** interrupteur, et il décide de tout ce qui distingue « ma
machine » de « une machine sur Internet ».

**`local`** (défaut ; la release le force, et le serveur refuse `--host`
autre que `127.0.0.1`/`::1` sans `--mode shared`). Comportement d'aujourd'hui,
intégral : opérateurs listés, `OPERATOR SELECT`, pas de clé, `ACQUIRE AREA`
disponible — c'est le seul endroit où une nouvelle scène peut naître. La
frontière de sécurité est le socket local — la même qu'avec le serveur de dev
depuis deux mois.

**`shared`** (le VPS). **Révisé le 2026-09-07 (suite conversation) : aucune
scène ne naît jamais sur le VPS.** Ni acquise par un visiteur (le problème de
stockage d'origine — « je ne peux pas stocker les cartes de tout le monde »),
ni détachée, ni garbage-collectée : ces mécanismes, envisagés dans une version
précédente de cette section, disparaissent avec leur raison d'être. Ce qui
reste :

- **`LOCAL TERRAIN` : un petit catalogue fixe, choisi par l'opérateur du VPS
  (toi), pas par les visiteurs.** Quelques cartes (cinq-six pour commencer)
  acquises une fois — depuis une installation `local`, ou directement sur le
  VPS avec `FPVTP_MODE=local` le temps de la commande — puis servies telles
  quelles. Aucun code neuf : c'est exactement le chemin `LOCAL TERRAIN` /
  `TARGET SCAN` / hack / rituel / session / archive d'aujourd'hui, sur des
  scènes qui existent déjà. Utile en particulier à qui a une connexion trop
  faible pour LIVE (une scène pré-acquise se charge une fois puis tourne sans
  dépendre du réseau pendant le vol) — but explicite de cette conversation.
- **`GLOBAL SCANNER` → LIVE, avec la boucle complète — déjà là.** Tracer une
  zone n'ouvre plus `ACQUIRE AREA` en `shared` : ça lance un vol **LIVE** sur
  cette zone, onglet LIVE du scanner, `[ FLY LIVE ]`. Correction du
  2026-09-07 (relu dans le code après une remarque en conversation, la version
  précédente de cette section se trompait) : ce chemin porte **déjà** TARGET
  SCAN → hack → rituel → session → archive depuis l'issue #218 — `fieldLoop()`
  appelle `runTargetScan()` et `runHack()` avant `bootLive()` exactement comme
  pour une carte cuite, et `openFlightSession()` ouvre une vraie session
  (`flyArea` prend un id `live-…`, ce qui bloque REVISIT dessus à bon droit —
  on ne revisite pas un terrain qu'on n'a pas gardé). Vérifié en navigateur
  (HANDOFF, « FIELD : onglets LOCAL / LIVE », issue #222). **Aucun
  développement de jeu à faire** : il ne reste que la bascule serveur
  (paragraphe suivant), qui est de la pure infrastructure.
- **Bonus vérifié en relisant le code à cette occasion : LIVE ne coûte quasiment
  rien au serveur.** `src/rocktree-worker.js` fait son `fetch()` vers
  `kh.google.com` **directement depuis le navigateur du joueur** — le CORS en
  est vérifié (`docs/superpowers/specs/2026-08-31-rocktree-live-fetch-design.md`).
  Le gros du trafic d'un vol LIVE (la géométrie et les textures) ne transite
  jamais par le VPS ; ce dernier ne voit que les petits appels JSON
  (`/__map-api/plan`/`/probe`, `/__operator/.../sessions`, météo). Le problème
  de stockage qui a lancé cette conversation — « je ne peux pas stocker les
  cartes de tout le monde » — est donc déjà résolu par LIVE tel qu'il existe,
  sans qu'on ait rien à construire pour ça.
- **`ACQUIRE AREA` disparaît de l'écran, remplacé par l'incitation.** Le bouton
  qui écrirait une scène sur le VPS devient `[ GET THE CLIENT — KEEP THIS
  TERRAIN ]`, pointant vers la page de téléchargement (D4). Le geste que le
  joueur vient de faire (tracer CETTE zone) reste dans son contexte : c'est le
  moment précis où « pourquoi installer » a une réponse concrète, pas un
  bandeau générique ailleurs dans l'interface.
- **Clé d'opérateur** (inchangé par rapport à la version précédente) :
  `POST /__operator` génère un secret de 128 bits (`randomBytes(16)`, base32
  sans ambiguïté, groupé par 4 : `K7QP-3MZX-…`), stocké haché (SHA-256),
  rendu **une seule fois** à la création. Envoyé en `Authorization: Bearer`
  sur toutes les routes `/__operator/:id/*` et `/__map-api/*`. Mauvaise clé →
  403, absente → 401. `GET /__operator` rend 404 en `shared` (pas de liste) ;
  le client montre alors `OPERATOR KEY` (retrouver son opérateur par sa clé,
  ou `[ NEW OPERATOR ]` → bootstrap → écran qui affiche la clé une fois).
  L'écran `OPERATOR` de l'ARCHIVE la ré-affiche derrière `[ SHOW KEY ]`, comme
  `SHOW VECTOR` pour le vecteur — la Bible §33 tient, la clé reste distincte
  du Control Vector.
- **`POST /__map-api/jobs` (acquisition) refuse en `shared`.** Puisque
  `ACQUIRE AREA` n'est plus dans l'écran, la route qui écrirait une scène
  refuse aussi côté serveur (403) — la protection ne doit pas dépendre de
  l'UI seule.

**Ce qui reste réellement à faire, alors, tient dans les points ci-dessus** :
la clé d'opérateur, `ACQUIRE AREA`/`POST jobs` gatés en `shared`, le catalogue
curé (curation manuelle, aucun code), et le bouton `GET THE CLIENT`. Pas de
développement de jeu — la seule chose que ce chantier doit encore *vérifier*
(pas construire) est que la boucle LIVE, déjà correcte en `local`, se comporte
identiquement sous une session `shared` authentifiée par clé — voir la
checklist de vérification (§6).

**Une nuance à garder à l'esprit, pas un blocage.** `?live=lat,lon` (paramètre
d'URL, raccourci de **dev**) reste volontairement un vol nu — pas de cible, pas
de session, `openFlightSession()` s'arrête sur `if (OPTS.live) return;`. C'est
un chemin différent de celui du scanner (`MODE.live`/`flyChoice.live`, qui
lui ouvre bien une session) : à ne pas confondre en lisant le code, l'erreur
qui a produit la version précédente de cette section.

Ce qui ne change pas en `shared`, assumé et documenté : Nominatim est appelé
par chaque navigateur avec sa propre IP ; Open-Meteo est déjà mis en cache par
zone et par jour côté serveur. Les plafonds existants
(`readBody` 1 Mo, `PHOTO_BODY_MAX` 8 Mo, `requireBox`/`requirePoly`) restent.

**Migration des opérateurs existants.** Un fichier sans clé, lu en `shared`,
est inutilisable jusqu'à ce qu'on lui en donne une :
`node server/index.mjs key <operatorId>` en génère une, l'écrit hachée et
l'imprime une fois. C'est ainsi que les 142 sessions de l'utilisateur passent
sur le VPS : `rsync` du fichier, puis une clé.

### 3. D3 — la release est une vraie app installée, avec mise à jour automatique

**Révisé le 2026-09-07 (suite conversation) : Electron, pas un lanceur nu.**
L'exigence qui tranche : quelqu'un qui installe le jeu doit le voir comme un
jeu normal — icône, entrée dans le menu, mise à jour silencieuse — sans savoir
ce qu'est un terminal. Windows et Linux seulement (macOS explicitement hors
périmètre, décision utilisateur). Un lanceur qui ouvre le navigateur par
défaut (version précédente de cette section) ne tient pas cette promesse : pas
d'icône dédiée, pas de mise à jour automatique, l'utilisateur atterrit dans
« son » navigateur au milieu de ses onglets.

**Architecture** : Electron EST déjà Node + Chromium dans un seul binaire —
pas besoin d'embarquer un second runtime Node à côté. Le process principal
Electron (`electron/main.js`) importe et démarre directement `sim/server/`
(le même module que T1, mode `local`) dans son propre contexte Node, sur
`127.0.0.1:0` (port éphémère, pas de collision possible) ; une fois le serveur
en écoute, une `BrowserWindow` charge cette URL. Le renderer est le `dist/`
inchangé. Aucun sous-processus : un seul binaire, un seul process Node.

**Outillage** : `electron-builder` — NSIS pour Windows (`.exe` installeur,
pas juste portable : entrée Menu Démarrer, désinstalleur propre), `AppImage`
pour Linux (le plus proche d'un « télécharge et double-clique » sans gestion
de paquets — pas de `.deb` dans un premier temps, ça demanderait de maintenir
un dépôt APT). `electron-updater` gère la mise à jour : au lancement, l'app
vérifie un flux `latest.yml`/`latest-linux.yml`, télécharge en tâche de fond,
propose de redémarrer.

**`sharp` et l'ABI Electron — à vérifier, pas supposé.** Les versions
récentes de `sharp` utilisent des bindings N-API (ABI stable), qui *devraient*
fonctionner tels quels dans le Node embarqué par Electron sans recompilation —
mais ça n'a jamais été testé sur ce dépôt. Si `electron-builder` échoue à
charger `sharp` au premier build, `@electron/rebuild` est le repli connu.
Rapier (WASM pur) n'a aucun souci d'ABI, il tourne identique partout.

**Distribution — le dépôt est privé aujourd'hui, public plus tard.**
`electron-updater` sait lire un flux GitHub Releases nativement, mais un
dépôt privé demande un jeton pour tout téléchargement — inutilisable pour un
joueur non-bidouilleur. Le VPS (D4) sert donc de pont : `electron-builder`
publie vers un **provider générique** (simple HTTP), le VPS héberge
`latest.yml`/`latest-linux.yml` + les installeurs, la CI y dépose le build à
chaque release. Le jour où le dépôt devient public, c'est une ligne de config
(`provider: generic` → `provider: github`) pour repasser par GitHub Releases
directement — rien d'autre ne bouge.

**Signature de code — pas maintenant, décision utilisateur (2026-09-07).**
Sans certificat, Windows SmartScreen affiche « Windows a protégé votre
ordinateur » au premier lancement (contournable en deux clics : Informations
complémentaires → Exécuter quand même). Accepté pour l'instant ; à
reconsidérer si le frein à l'installation se révèle réel. Un certificat
(~100-400 $/an) s'ajoute à `electron-builder` sans rien changer d'autre à
cette spec.

**Ordre de grandeur** : Electron + Chromium embarqués ≈ 150-200 Mo par
plateforme, du même ordre que l'estimation précédente (runtime Node +
`node_modules`) — pas un surcoût réel.

### 4. D4 — le VPS reçoit la même archive, plus trois fichiers, plus la distribution Electron

`deploy/` à la racine du dépôt :

- **`fpvtp.service`** (systemd) : `User=fpvtp`, `WorkingDirectory=/opt/fpvtp/
  current/app`, `ExecStart=/opt/fpvtp/current/node/bin/node server/index.mjs`,
  `Environment=FPVTP_MODE=shared FPVTP_DATA_DIR=/var/lib/fpvtp
  FPVTP_HOST=127.0.0.1 FPVTP_PORT=8080 FPVTP_SCENES_MAX_GB=40`,
  `Restart=on-failure`, `ProtectSystem=strict` avec `ReadWritePaths=/var/lib/fpvtp`.
- **`Caddyfile`** : `fpvtp.example.org { reverse_proxy 127.0.0.1:8080 }`.
  Caddy gère TLS et ne tamponne pas les flux — le SSE des jobs passe sans
  réglage ; le `x-accel-buffering: no` déjà envoyé couvre nginx si le choix
  change.
- **`deploy.sh <tag>`** : télécharge l'asset `linux-x64` de la release (le
  dépôt étant privé, avec un jeton lecture seule dans `/etc/fpvtp/token`),
  décompresse dans `/opt/fpvtp/releases/<tag>`, bascule le lien
  `/opt/fpvtp/current`, `systemctl restart fpvtp`, vérifie
  `curl localhost:8080/__map-api/scenes`. Le lien précédent reste : revenir en
  arrière est un `ln -sfn` et un restart.

Le déclenchement est **manuel** au départ (`ssh vps sudo deploy.sh v0.2.0`).
Une étape `deploy` dans `release.yml`, conditionnée à la présence des secrets
`DEPLOY_HOST`/`DEPLOY_KEY`, viendra quand la première livraison manuelle aura
réussi — pas avant : `release.yml` lui-même n'a encore jamais tourné.

**Distribution Electron (D3)** : un répertoire statique de plus servi par
Caddy, `updates.fpvtp.example.org` (ou un chemin sous le même domaine) —
`.exe`/`AppImage` + `latest.yml`/`latest-linux.yml`. `deploy.sh` y dépose les
artefacts du job `electron-builder` de la CI, à côté de la bascule du serveur
de jeu. Aucune authentification : ces fichiers sont ceux que n'importe qui
doit pouvoir télécharger, contrairement à l'API `/__map-api`/`/__operator`.

**Sauvegardes** : `/var/lib/fpvtp/operator-state` est petit (174 Ko par
opérateur sans les captures, quelques Mo avec) — `tar` quotidien. Les scènes
du catalogue curé (D2) sont régénérables mais longues à régénérer — `rsync`
hebdomadaire, ou rien ; leur nombre est fixe et choisi par l'opérateur, donc
aucune surveillance de croissance n'est nécessaire.

**Dimensionnement, à mesurer avant de louer** : une scène du catalogue curé
= ~450 Mo de disque et ~2,7 s de chargement local ; sur le fil, le premier vol
d'un visiteur sur une scène tire ces 450 Mo une fois (puis cache navigateur
`immutable`) — `× 5-6 scènes`, pas au-delà, puisque le catalogue est fixe. Le
pic mémoire de `prep.mjs` pendant `REBUILD` reste à mesurer (`export-glb`
demande 8 Go de tas, `prep` probablement moins), mais ne pèse plus sur le
dimensionnement du VPS en usage courant : `REBUILD` ne tourne qu'aux mains de
l'opérateur, quand il compose le catalogue — jamais déclenché par un visiteur
depuis que `ACQUIRE AREA` est fermé en `shared` (D2). Le mesurer avant de
curer le catalogue reste prudent, pas avant de louer le VPS.

### 5. Ce qui change côté client

Le moins possible, et rien sur les chemins de vol :

- `src/operator.js` : garde la clé (`fpvmaps.operatorKey`), l'envoie en
  `Bearer`, expose `hasKey()`. Sur 401/403, efface l'id et la clé et rend
  `{ needsKey: true }`.
- `src/main.js` `chooseScene()` : la branche `choices` gagne un cas
  `needsKey` → nouvel écran `OPERATOR KEY` dans `src/terminal.js` (même
  gabarit que `operatorSelect`). Le bootstrap gagne un dernier écran
  `YOUR OPERATOR KEY` quand la réponse de création en porte une.
- `src/terminal.js` : le bouton `ACQUIRE AREA` du scanner devient
  `[ GET THE CLIENT — KEEP THIS TERRAIN ]` quand `scenes` annonce
  `{ mode: 'shared' }` (voir D2) — pas un bandeau générique ailleurs dans
  l'interface, l'incitation vit au moment précis où elle répond à une envie
  réelle. Pas un mur : de l'information, pas de la pression (pilier 1 de la
  Bible, « information, not assistance »). Détail visuel exact à trancher à
  l'implémentation (T3), pas ici.
- `?scene=`, `?live=`, `?family=`, le banc : inchangés.

### 6. Vérification

**Sans navigateur, en CI** :

- `tools/server-selftest.mjs` (nouveau, dans `selftest:ci`) : démarre
  `server/index.mjs` sur le port 0 avec un `--data` temporaire et un `--dist`
  factice, puis vérifie : `/scenes.json` dynamique et vide au départ ; un
  fichier absent rend 404 JSON et jamais `text/html` (c'est #275 côté
  serveur) ; `Range` sur un fichier de scène ; `Cache-Control` immutable sur
  `/scenes/*` et `no-store` sur l'API ; en `shared` : 401 sans clé, 403 avec
  une mauvaise, 404 sur la liste, la clé rendue une fois et jamais relue en
  clair ; `POST /__map-api/jobs` refuse (403) en `shared` quelle que soit la
  clé — aucune scène ne peut naître sur ce mode, ni par erreur ni par
  contournement de l'UI ; `local` refuse `--host 0.0.0.0`.
- `tools/session-api-selftest.mjs` bascule de `createServer` Vite sur
  `server/index.mjs` : il teste ce qui est livré, et la CI n'a plus à
  démarrer Vite (plus rapide). Un check de fumée garde l'adaptateur Vite
  honnête : `npm run dev` répond sur `/__map-api/scenes`.
- `ci.yml` gagne une matrice `{ubuntu, windows}` sur `selftest:ci` + `build`.
  C'est ce qui débusquera les chemins Windows dans `prep.mjs`,
  `add-map-core.mjs` et `run.mjs` (`spawn` de `node`, séparateurs,
  `toLocaleString`) **avant** qu'un joueur ne les trouve.

**À l'écran, à faire par l'utilisateur** — c'est le critère d'acceptation, et
aucun selftest ne le remplace :

1. Installer via l'installeur `.exe` (Windows) ou l'`AppImage` (Linux), lancer
   depuis le menu Démarrer / en double-cliquant, voir la fenêtre s'ouvrir
   directement sur le terminal opérateur (pas de navigateur à part, pas
   d'écran de terminal visible), jouer le parcours FIELD complet du HANDOFF
   (mode select → ACQUIRE AREA sur une petite zone Google → TARGET SCAN →
   hack → rituel → vol → pose → POST-FLIGHT → KEEP → SESSION LOG). Fermer,
   relancer, retrouver la session.
2. Publier une version `vX.Y.1` après la `vX.Y.0` installée : l'app détecte,
   télécharge et propose le redémarrage sans repasser par un téléchargement
   manuel.
3. Sur le VPS : créer un opérateur, noter la clé, ouvrir un navigateur privé,
   entrer la clé, retrouver le même opérateur. Un second opérateur ne voit
   pas le premier. `LOCAL TERRAIN` ne montre que le catalogue curé, jamais
   `ACQUIRE AREA` (le bouton dit `GET THE CLIENT`, cliquer dessus ne déclenche
   aucune requête d'acquisition). Un vol LIVE tracé sur le scanner rend la
   boucle complète — TARGET SCAN, hack, rituel, session archivée à la fin —
   depuis le domaine réel ; le CORS de `kh.google.com` n'a été vérifié que
   depuis `localhost`.

### 7. Tranches, chacune livrable seule

| # | tranche | ferme |
|---|---|---|
| T1 | `server/` + `paths.mjs` + adaptateur Vite + `server-selftest` ; `session-api-selftest` sur le serveur autonome | #259 (le build démarre seul) |
| T2 | `electron/main.js`, `electron-builder` (NSIS + AppImage), `electron-updater`, matrice Windows/Linux en CI et en release | l'app s'installe et se met à jour toute seule |
| T3 | mode `shared` : clé, écran `OPERATOR KEY`, `ACQUIRE AREA`/`POST jobs` refusés (403) + bouton `GET THE CLIENT`, catalogue curé (aucun code de jeu neuf — LIVE porte déjà la boucle complète depuis #218, il ne reste que la vérifier sous `shared`) | #60 (PHASE 23) |
| T4 | `deploy/` + distribution Electron (D3) + première livraison manuelle sur le VPS | le serveur existe et sert les installeurs |

T1, T2 et T3 ne changent rien au comportement du jeu — T3 gate une seule
fonctionnalité (`ACQUIRE AREA`) et ajoute un bouton, LIVE fonctionnant déjà
tel quel. Aucune tranche de ce chantier ne touche à la logique du jeu
lui-même. T1 → T2 → T4 suffit à un « serveur pour les amis » en mode `local`
derrière un tunnel, comme aujourd'hui avec ngrok — mais **pas**
exposé sur Internet : le serveur refuse `--host 0.0.0.0` sans `--mode shared`,
et c'est voulu.

## Ce qui n'est pas dans ce design

- macOS. Décision utilisateur (2026-09-07) : Windows et Linux seulement.
- La signature de code (Windows). Décision utilisateur (2026-09-07) : acceptée
  pour l'instant, l'avertissement SmartScreen reste. Un certificat s'ajoute à
  `electron-builder` sans toucher au reste de cette spec, le jour où le besoin
  se fait sentir.
- Un mode statique sans serveur (GitHub Pages, LIVE seul) — troisième
  hébergement possible plus tard, voir D1.
- Le partage de scènes entre installations (« scene packs » exportables) :
  l'acquisition Google étant gratuite et sans jeton, chacun réacquiert.
  `export-glb` existe pour partager une scène hors du jeu.
- Des comptes, des mots de passe, une récupération de clé perdue. Une clé
  perdue est un opérateur perdu, comme un fichier `operator-state` effacé
  aujourd'hui — le propriétaire du VPS peut en régénérer une avec la commande
  `key`, c'est la seule voie.
- Multi-joueur en vol, classement, quoi que ce soit de social (§46, « PLUS
  TARD »).

## Non vérifié, et ce qu'il faudra regarder en premier

- `sharp` sous le Node embarqué par Electron (bindings N-API, censés être
  ABI-stables) : plausible, jamais testé ici. Premier point de T2 ; repli
  connu si ça échoue, `@electron/rebuild`.
- Windows n'a **jamais** exécuté ce dépôt. La matrice Windows/Linux en CI est
  là pour ça ; s'attendre à des correctifs de chemins dans `prep.mjs`.
- Le cycle `electron-updater` complet (publier v+1, l'app la détecte, la
  télécharge, redémarre dessus) contre un provider générique auto-hébergé —
  jamais fait, à vérifier avant d'annoncer « mise à jour automatique » comme
  acquis.
- Le pic mémoire de `prep.mjs` (voir §4) — à mesurer avant de composer le
  catalogue curé.
- **LIVE sous une session `shared` authentifiée par clé** : la boucle
  (TARGET SCAN/hack/session/archive) est vérifiée en `local` (#218, #222),
  jamais avec l'en-tête `Authorization: Bearer` d'une session `shared` —
  premier point à rejouer une fois T3 posée.
- Le CORS de `kh.google.com` depuis un vrai domaine.
- Le `Range` et le cache `immutable` sur 450 Mo de scène : le comportement du
  cache navigateur au-delà de son quota n'a pas été regardé.
- `release.yml` et `ci.yml` n'ont toujours pas tourné sur un runner.
