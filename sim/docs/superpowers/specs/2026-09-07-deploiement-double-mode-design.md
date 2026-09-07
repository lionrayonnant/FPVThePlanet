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
`~/Library/Application Support/FPVTP` (macOS), `%LOCALAPPDATA%\FPVTP`
(Windows). Décompresser la version suivante par-dessus l'ancienne ne touche à
rien de ce qui compte.

### 2. D2 — deux modes de confiance, `local` et `shared`

Le serveur a **un** interrupteur, et il décide de tout ce qui distingue « ma
machine » de « une machine sur Internet ».

**`local`** (défaut ; la release le force, et le serveur refuse `--host`
autre que `127.0.0.1`/`::1` sans `--mode shared`). Comportement d'aujourd'hui,
intégral : opérateurs listés, `OPERATOR SELECT`, pas de clé. La frontière de
sécurité est le socket local — la même qu'avec le serveur de dev depuis deux
mois.

**`shared`** (le VPS). Quatre changements, tous côté serveur sauf l'écran de
clé :

1. **Clé d'opérateur.** `POST /__operator` génère un secret de 128 bits
   (`randomBytes(16)`, base32 sans ambiguïté, groupé par 4 :
   `K7QP-3MZX-…`), stocké haché (SHA-256) dans le fichier opérateur, rendu
   **une seule fois** dans la réponse de création. Le client le garde dans
   `localStorage` à côté de `fpvmaps.operatorId` et l'envoie en
   `Authorization: Bearer` sur **toutes** les routes `/__operator/:id/*` et
   `/__map-api/*`. Mauvaise clé → 403 ; absente → 401 ; le client retombe sur
   l'écran de clé. En mode `local`, l'en-tête est ignoré.
2. **Plus de liste.** `GET /__operator` rend 404 en `shared`. Le client, sur ce
   404, ne montre pas `OPERATOR SELECT` mais **`OPERATOR KEY`** : un champ pour
   la clé (retrouver son opérateur depuis un autre navigateur), ou
   `[ NEW OPERATOR ]` → bootstrap habituel, puis un écran qui affiche la clé
   avec la consigne de la noter. L'écran `OPERATOR` de l'ARCHIVE la ré-affiche
   derrière `[ SHOW KEY ]`, comme `SHOW VECTOR` le fait pour le vecteur. La
   Bible §33 tient : le Control Vector n'est toujours pas le mécanisme de
   connexion, la clé est une chose distincte et sans rituel.
3. **`REMOVE TERRAIN` détache, il n'efface plus.** En `shared`, la route
   `DELETE /__map-api/scenes/:slug` retire le slug du `terrainCache` de
   l'appelant. Le fichier n'est effacé que par le **ramasse-miettes** : une
   scène qu'aucun opérateur ne référence depuis plus de `FPVTP_SCENES_GRACE`
   (défaut 7 jours) est supprimée, et au-delà de `FPVTP_SCENES_MAX_GB` les
   scènes non référencées partent par ancienneté. Une scène référencée n'est
   **jamais** évincée : la Bible §29 (« supprimer le terrain ne supprime pas le
   souvenir ») reste vraie, et la réciproque aussi — garder un terrain, c'est
   le tenir en vie pour tout le monde. Le texte de l'écran s'adapte
   (`DETACH` au lieu de `REMOVE` quand le serveur annonce `shared` dans
   `GET /__map-api/scenes`).
4. **File d'attente d'acquisition.** `POST /__map-api/jobs` ne rend plus 409
   quand un job tourne : il met en file (FIFO, un job actif à la fois, la
   raison de « un seul job » — saturer la même liaison — reste vraie sur un
   VPS). Chaque job porte l'`operatorId` de son auteur ; le SSE `state`
   gagne `{ queued: n }` et le rail du scanner affiche `QUEUED · 2 AHEAD`.
   `DELETE /jobs/:id` n'est permis qu'à l'auteur.

Ce qui ne change pas en `shared`, assumé et documenté : Nominatim est appelé
par chaque navigateur avec sa propre IP ; Open-Meteo est déjà mis en cache par
zone et par jour côté serveur. Les plafonds existants
(`readBody` 1 Mo, `PHOTO_BODY_MAX` 8 Mo, `requireBox`/`requirePoly`,
`intIn` sur zoom/altitude/cell) restent.

**Migration des opérateurs existants.** Un fichier sans clé, lu en `shared`,
est inutilisable jusqu'à ce qu'on lui en donne une :
`node server/index.mjs key <operatorId>` en génère une, l'écrit hachée et
l'imprime une fois. C'est ainsi que les 142 sessions de l'utilisateur passent
sur le VPS : `rsync` du fichier, puis une clé.

### 3. D3 — la release est une archive par plateforme, sans prérequis

Un joueur ne doit rien installer. Ni Node, ni Go, ni `npm install`.

**Contenu de `fpvtp-vX.Y.Z-<plateforme>.zip`** :

```text
fpvtp-v0.2.0-linux-x64/
  FPVTP.sh            (ou FPVTP.cmd / FPVTP.command)
  node/               runtime Node officiel, ~50 Mo (tarball nodejs.org)
  app/
    dist/             npm run build
    server/
    tools/            prep.mjs, lib/, decoders, providers, *-model.mjs
    node_modules/     --omit=dev, installé SUR la plateforme cible
    package.json
  README.txt          trois lignes : double-clic, l'URL, où sont les données
```

`FPVTP.sh` fait `exec "$DIR/node/bin/node" "$DIR/app/server/index.mjs" --open
"$@"`. Le `.cmd` Windows et le `.command` macOS font pareil. Pas de Node SEA,
pas de `pkg`, pas d'Electron : `sharp` est un addon natif et ces outils le
gèrent mal ; un tarball Node à côté de l'application est la solution la plus
bête et la plus sûre.

**Pourquoi une matrice de plateformes** : `sharp` tire son binaire par
dépendance optionnelle `@img/sharp-<os>-<cpu>` au moment de `npm ci`. Le
`node_modules` doit donc être installé sur la plateforme visée (ou avec
`--os --cpu`, plus fragile). `release.yml` gagne un job matriciel
`{ubuntu-latest, windows-latest, macos-latest (arm64), macos-13 (x64)}` qui
fait `npm ci --omit=dev`, télécharge le tarball Node correspondant, assemble
l'archive et l'attache à la release. Le job existant (selftests + build) reste
en amont et fournit `dist/` une seule fois.

**Ordre de grandeur** : `dist/` ≈ 80 Mo (dont 77 Mo de musique), Node ≈ 50 Mo,
`node_modules` prod (three, rapier, sharp, leaflet, geoman) ≈ 40 Mo. Archive
≈ 170 Mo, loin de la limite de 2 Go par asset.

**Mise à jour** : décompresser la nouvelle version, lancer. Les données sont
ailleurs. Un `BUILD NOTES` qui annoncerait `UPDATE AVAILABLE` en interrogeant
l'API GitHub Releases est une idée pour plus tard, pas pour ce chantier — le
dépôt est privé, l'API demande un jeton.

### 4. D4 — le VPS reçoit la même archive, plus trois fichiers

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

**Sauvegardes** : `/var/lib/fpvtp/operator-state` est petit (174 Ko par
opérateur sans les captures, quelques Mo avec) — `tar` quotidien. Les scènes
sont régénérables mais longues à régénérer — `rsync` hebdomadaire, ou rien, au
choix du propriétaire ; le ramasse-miettes n'y touche jamais tant qu'elles
sont référencées.

**Dimensionnement, à mesurer avant de louer** : une scène = ~450 Mo de disque
et ~2,7 s de chargement local ; sur le fil, le premier vol d'un opérateur
sur une scène tire ces 450 Mo une fois (puis cache navigateur `immutable`).
Le pic mémoire de `prep.mjs` pendant `REBUILD` n'est **pas connu** — `export-glb`
demande 8 Go de tas, `prep` probablement moins, mais personne ne l'a mesuré.
Un VPS à 2 Go peut tuer l'acquisition en OOM : mesurer `prep.mjs` sur
`paristest` avec `/usr/bin/time -v` **avant** de choisir la taille du VPS.

### 5. Ce qui change côté client

Le moins possible, et rien sur les chemins de vol :

- `src/operator.js` : garde la clé (`fpvmaps.operatorKey`), l'envoie en
  `Bearer`, expose `hasKey()`. Sur 401/403, efface l'id et la clé et rend
  `{ needsKey: true }`.
- `src/main.js` `chooseScene()` : la branche `choices` gagne un cas
  `needsKey` → nouvel écran `OPERATOR KEY` dans `src/terminal.js` (même
  gabarit que `operatorSelect`). Le bootstrap gagne un dernier écran
  `YOUR OPERATOR KEY` quand la réponse de création en porte une.
- `src/terminal.js` : `REMOVE` devient `DETACH` quand `scenes` annonce
  `{ mode: 'shared' }` ; le rail du scanner affiche la position en file.
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
  clair ; `DETACH` ne supprime pas le dossier, le ramasse-miettes le fait
  après la grâce et pas avant ; la file FIFO ; `local` refuse `--host 0.0.0.0`.
- `tools/session-api-selftest.mjs` bascule de `createServer` Vite sur
  `server/index.mjs` : il teste ce qui est livré, et la CI n'a plus à
  démarrer Vite (plus rapide). Un check de fumée garde l'adaptateur Vite
  honnête : `npm run dev` répond sur `/__map-api/scenes`.
- `ci.yml` gagne une matrice `{ubuntu, windows, macos}` sur `selftest:ci` +
  `build`. C'est ce qui débusquera les chemins Windows dans `prep.mjs`,
  `add-map-core.mjs` et `run.mjs` (`spawn` de `node`, séparateurs,
  `toLocaleString`) **avant** qu'un joueur ne les trouve.

**À l'écran, à faire par l'utilisateur** — c'est le critère d'acceptation, et
aucun selftest ne le remplace :

1. Décompresser l'archive de sa plateforme, double-cliquer, voir le
   navigateur s'ouvrir, jouer le parcours FIELD complet du HANDOFF (mode
   select → ACQUIRE AREA sur une petite zone Google → TARGET SCAN → hack →
   rituel → vol → pose → POST-FLIGHT → KEEP → SESSION LOG). Fermer, relancer,
   retrouver la session.
2. Sur le VPS : créer un opérateur, noter la clé, ouvrir un navigateur privé,
   entrer la clé, retrouver le même opérateur. Un second opérateur ne voit
   pas le premier. Un vol LIVE depuis le domaine réel — le CORS de
   `kh.google.com` n'a été vérifié que depuis `localhost`.

### 7. Tranches, chacune livrable seule

| # | tranche | ferme |
|---|---|---|
| T1 | `server/` + `paths.mjs` + adaptateur Vite + `server-selftest` ; `session-api-selftest` sur le serveur autonome | #259 (le build démarre seul) |
| T2 | matrice de release, runtime Node embarqué, lanceurs, matrice d'OS en CI | la release est jouable |
| T3 | mode `shared` : clé, écran `OPERATOR KEY`, `DETACH` + ramasse-miettes, file | #60 (PHASE 23) |
| T4 | `deploy/` + première livraison manuelle sur le VPS | le serveur existe |

T1 et T2 ne changent rien au comportement du jeu. T3 est la seule tranche
qui touche des écrans. T1 → T2 → T4 suffit à un « serveur pour les amis » en
mode `local` derrière un tunnel, comme aujourd'hui avec ngrok — mais **pas**
exposé sur Internet : le serveur refuse `--host 0.0.0.0` sans `--mode shared`,
et c'est voulu.

## Ce qui n'est pas dans ce design

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

- `sharp` dans un `node_modules` embarqué par plateforme : plausible, jamais
  fait ici. Premier point à tester de T2, sur les quatre archives.
- Windows et macOS n'ont **jamais** exécuté ce dépôt. La matrice d'OS en CI
  est là pour ça ; s'attendre à des correctifs de chemins dans `prep.mjs`.
- Le pic mémoire de `prep.mjs` (voir §4) — à mesurer avant de louer.
- Le CORS de `kh.google.com` depuis un vrai domaine.
- Le `Range` et le cache `immutable` sur 450 Mo de scène : le comportement du
  cache navigateur au-delà de son quota n'a pas été regardé.
- `release.yml` et `ci.yml` n'ont toujours pas tourné sur un runner.
