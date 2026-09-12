# PHASE 01 — Operator / état local-first — Design

GitHub : https://github.com/lionrayonnant/FPVThePlanet/issues/38
Milestone : P0 — boucle fonctionnelle. Label : `roadmap-da`.

Sources de vérité : `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md`
(§12–14), `sim/docs/FPVThePlanet! — DA-UX Implementation Roadmap.md`
(PHASE 1), `sim/docs/fpv-rework-architecture.md` (D2, D5, D6, §3.7, §4).

## Objectif

Introduire la notion centrale : **chaque opérateur possède sa propre
expérience.** Au premier lancement, le jeu inspecte l'environnement navigateur,
fait créer un `OPERATOR NAME`, fait définir un `CONTROL VECTOR`, puis dépose
l'opérateur sur une Home minimale. Aux lancements suivants, l'opérateur est
retrouvé sans repasser par le bootstrapping, y compris après un vidage du cache
navigateur.

## Décisions arrêtées

| # | Décision |
|---|---|
| A | L'état opérateur vit **côté serveur**, un fichier JSON par opérateur, dans `sim/operator-state/` (gitignored), via une extension de `tools/map-api-plugin.mjs` (routes `/__operator`). Reprend D2. |
| B | **Aucun champ « dernier opérateur actif » côté serveur.** L'identité du client vit dans `localStorage` (`fpvtp.operatorId`) et accompagne chaque requête. C'est ce qui permet à deux personnes de jouer en même temps sur le même serveur de dev sans se marcher dessus. |
| C | Navigateur vierge / vidé : si le serveur a exactement un opérateur → on le charge ; s'il en a plusieurs → écran `OPERATOR SELECT` ; s'il n'en a aucun → bootstrapping. |
| D | Control Vector = suite de **directions 4-way** (`up`/`right`/`down`/`left`), longueur 4–8, défaut 6. Saisie au clavier (flèches) **et** à la manette (d-pad + stick gauche). |
| E | `home.js` est un **stub jetable** : PHASE 02 le remplace par l'Operator Terminal. Il existe pour satisfaire le critère d'acceptation « → operator home ». |
| F | Reveal du bootstrapping **complet et sautable** : révélation ligne à ligne (~40 ms/ligne), quelques commentaires de crew, n'importe quelle touche saute à la fin. |
| G | **D6 tenu** : aucun module moteur touché. `npm run selftest` reste vert. |
| H | **D5 tenu** : toute chaîne visible par le joueur est en anglais, grammaire DOS/Unix. |

## Architecture

```
main.js boot flow
  loadOperator()                        ── src/operator.js
    ├─ needsBootstrap → bootstrap()     ── src/bootstrap.js  → createOperator()
    ├─ choices        → selectScreen()  ── src/home.js (OPERATOR SELECT) → selectOperator()
    └─ operator
  home()                                ── src/home.js (OPERATOR HOME), résout sur FLY
  hud.showMenu(scenes)                  ── inchangé
  setScene(slug) → boot()               ── inchangé
```

`?scene=<slug>` continue de court-circuiter menu + home, mais appelle quand même
`loadOperator()` ; si aucun opérateur n'existe, il en crée un `id: "dev"`
silencieusement pour que `operator.controlVector` soit toujours disponible.

## 1. Serveur — routes `/__operator` dans `map-api-plugin.mjs`

Nouveau groupe de routes, même schéma que `/__map-api` : middleware sur le
connect de Vite, `apply: 'serve'`, jamais dans le bundle. Base : `/__operator`.

### Stockage

- Répertoire : `sim/operator-state/`, créé à la volée (`fs.mkdirSync(recursive)`),
  ajouté à `.gitignore`.
- Un fichier par opérateur : `<id>.json`.
- `id = slugify(name) + '-' + 4 hex aléatoires`. Le `name` n'entre **jamais** dans
  un chemin. `id` est validé `^[a-z0-9]+(-[a-z0-9]+)*$` sur **chaque** route qui
  le reçoit ; tout id non conforme → 400.
- Écriture atomique : écrire `<id>.json.<pid>.tmp`, `fs.renameSync` vers
  `<id>.json`.

### Routes

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/__operator` | — | `{ operators: [{ id, name, createdAt, counts: { areas, sessions, targets } }] }` |
| `POST` | `/__operator` | `{ name }` | 201 `{ operator: <état complet> }` |
| `GET` | `/__operator/<id>` | — | `{ operator: <état complet> }` · 404 si absent |
| `PATCH` | `/__operator/<id>` | `{ key, value }` | 200 `{ operator: <état complet> }` |

- `POST` : `name` trimé ; rejet si vide, si `> 24` caractères, ou si
  `slugify(name)` est vide → 400 avec message explicite. Pas de contrôle
  d'unicité du nom (le suffixe d'`id` suffit).
- `PATCH` : `key` doit appartenir à la **liste blanche** `['controlVector',
  'settings']`. Toute autre clé → 400. `value` pour `controlVector` : tableau de
  4 à 8 chaînes parmi `up/right/down/left`, sinon 400. Écriture de la clé
  entière (pas de merge profond).
- `terrainCache`, `sessions`, `targetLog`, `worldState` : présents dans l'état,
  initialisés vides, **pas d'écriture** en PHASE 01 (routes dédiées aux phases
  suivantes).
- Limite de corps : réutiliser `readBody` existant (1 Mo).
- `counts` : `terrainCache.length`, `sessions.length`, `targetLog.length`.

### Schéma d'état — `schemaVersion: 1`

```json
{
  "schemaVersion": 1,
  "id": "neo-7f3a",
  "name": "NEO",
  "createdAt": "2026-08-29T12:34:56.000Z",
  "controlVector": ["up", "right", "down", "left", "up", "left"],
  "settings": {},
  "terrainCache": [],
  "sessions": [],
  "targetLog": [],
  "worldState": {}
}
```

- `controlVector` à la création : `[]` (défini à l'écran 3 du bootstrapping).
- `migrate(state)` côté serveur : appelé à chaque lecture de fichier.
  `schemaVersion` absent ou `1` → normalisé vers 1 (remplit les clés manquantes).
  `schemaVersion > 1` (fichier écrit par une version future) → 409 avec message,
  on ne touche pas au fichier.
- Une constante `SCHEMA_VERSION = 1` et une fonction `freshState({ id, name })`
  vivent à côté des routes.

## 2. Client — `src/operator.js`

Aucune dépendance DOM. Cache mémoire = source de lecture.

```
loadOperator() → Promise<{
  operator: State | null,
  needsBootstrap: boolean,
  choices: Array<{id,name}> | null   // renseigné seulement en cas C multi-opérateur
}>
```

Logique de `loadOperator()` :

1. `id = localStorage['fpvtp.operatorId']`.
2. Si `id` : `GET /__operator/<id>`.
   - 200 → `{ operator, needsBootstrap: false, choices: null }`.
   - 404 → l'id local est périmé : on l'efface, on retombe en 3.
3. Pas d'id (ou périmé) : `GET /__operator`.
   - 0 opérateur → `{ operator: null, needsBootstrap: true, choices: null }`.
   - 1 opérateur → `selectOperator(op.id)` puis retour `needsBootstrap: false`.
   - ≥ 2 → `{ operator: null, needsBootstrap: false, choices: [...] }`.

Autres fonctions :

- `createOperator(name)` → `POST /__operator` ; au succès :
  `localStorage['fpvtp.operatorId'] = operator.id` ; met le cache à jour ;
  renvoie l'état.
- `selectOperator(id)` → `GET /__operator/<id>` ; stocke l'id ; met le cache.
- `getOperator()` → l'état en cache (synchrone).
- `patch(key, value)` → met le cache à jour immédiatement, planifie un
  `PATCH /__operator/<id>` **différé** (~500 ms, coalescence par clé).
  Flush immédiat sur `visibilitychange` (hidden) et `beforeunload`
  (`navigator.sendBeacon` si dispo, sinon `fetch(..., { keepalive: true })`).
- `ensureDevOperator()` → pour le chemin `?scene=` : si aucun opérateur,
  `POST` avec `name: "dev"`.

Erreurs réseau : `loadOperator()` rejette ; `main.js` affiche `hud.fail()` avec
un message qui rappelle que `npm run dev` doit tourner. `patch()` qui échoue :
log console, on retente au prochain flush (le cache reste juste, la perte se
limite à un crash serveur simultané).

## 3. Bootstrapping — `src/bootstrap.js`

Module autonome. `bootstrap(root, input) → Promise<State>`. Monte un
plein-écran dans `#ui`, le retire à la résolution. Trois sous-écrans séquentiels.

### Écran 1 — HARDWARE DISCOVERY

En-tête :

```
FPVTP! // 0.97b

OPERATOR BOOTSTRAPPING
```

Inventaire **honnête** (arch doc §4). Chaque champ mesuré ; sinon `UNKNOWN`.

| Ligne | Source | `UNKNOWN` si |
|---|---|---|
| `PLATFORM` | `navigator.userAgentData.platform` \|\| parse `userAgent` | indéterminable |
| `BROWSER` | `userAgentData.brands` \|\| parse `userAgent` | indéterminable |
| `LANGUAGE` | `navigator.language` (maj.) | — |
| `TIMEZONE` | `Intl.DateTimeFormat().resolvedOptions().timeZone` (maj.) | — |
| `DISPLAY` | `screen.width × screen.height`, `× devicePixelRatio` | — |
| refresh | médiane sur ~60 `requestAnimationFrame`, arrondie | — |
| `RENDERER` | `WEBGL2` si contexte `webgl2` obtenu, sinon `WEBGL1` / `NONE` | — |
| `GPU` | `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL` | extension absente / masquée |
| `CORES` | `navigator.hardwareConcurrency` | absent |
| `INPUT` | 1er gamepad connecté : `id`, `NN AXES` ; sinon `NO GAMEPAD` | — |
| `AUDIO` | `new AudioContext()` → `sampleRate` Hz, `N CH` (`maxChannelCount`), puis `close()` | — |
| `NETWORK` | `navigator.onLine` → `ONLINE` / `OFFLINE` | — |
| `STORAGE` | `navigator.storage.estimate()` → `quota` en Go, arrondi | API absente |
| `TERRAIN CACHE` | `GET /__map-api/scenes` → `N AREAS` / `EMPTY` | serveur muet |

Jamais affichés comme réels : `HEADPHONES`, RAM physique, VRAM, modèle CPU, nom
machine, utilisateur OS, position géo. (Cf. arch doc §4 — `AUDIO ... 48000 Hz /
2 CH` est vrai et tout aussi inquiétant que `HEADPHONES`.)

**Reveal** : lignes révélées une à une, ~40 ms l'intervalle. Quelques
commentaires de crew interleavés, tirés d'une petite table câblée sur ce qui a
été trouvé, p. ex. :

```
// root: 144hz
// vex: acceptable
// root: radio detected
// vex: good
// root: no radio
// vex: keyboard then
```

(2 à 4 commentaires selon les trouvailles ; table hand-authored dans le module.)

N'importe quelle touche ou clic → tout est révélé immédiatement. Fin :
`INITIALIZATION...` puis `[ CONTINUE ]`.

### Écran 2 — OPERATOR NAME

```
OPERATOR NAME

[ NEO________________ ]

[ REGISTER ]
```

Validation inline : non vide, `≤ 24` caractères, `slugify` non vide. Erreur
affichée en `--accent` sous le champ, grammaire courte (`NAME REQUIRED`,
`NAME TOO LONG`). `REGISTER` → `createOperator(name)`. En cas d'échec réseau,
message et le bouton reste actif.

### Écran 3 — DEFINE CONTROL VECTOR

```
DEFINE CONTROL VECTOR

4-8 INPUTS
DEFAULT LENGTH: 6

THIS VECTOR WILL BE REQUIRED
FOR FUTURE TARGET ACQUISITIONS.
WRITE IT DOWN.

LENGTH: [ - ] 6 [ + ]      (4..8)

_ _ _ _ _ _

[ CONFIRM VECTOR ]
```

- Sélecteur de longueur 4–8 (défaut 6). Changer la longueur remet la saisie à
  zéro.
- Capture : flèches clavier **ou** manette. Manette : d-pad (`buttons[12..15]`)
  et stick gauche (`axes[0/1]` au-delà d'une deadzone). Réutiliser la deadzone
  et la lecture d'axes de `input.js` — exporter un helper si nécessaire, sans
  changer le comportement de vol.
- Chaque entrée remplit un `_` avec `↑ → ↓ ←`. `Backspace` / bouton
  `[ DELETE ]` retire la dernière. Anti-répétition manette : une pression =
  une entrée (front montant).
- `[ CONFIRM VECTOR ]` actif seulement quand la longueur est atteinte →
  `patch('controlVector', vector)`.

### Écran 4 — CONTROL VECTOR REGISTERED

```
CONTROL VECTOR REGISTERED

↑ → ↓ ← ↑ ←

KEEP THIS VECTOR.
YOU WILL NEED IT.

[ CONTINUE ]
```

`CONTINUE` → `bootstrap()` résout avec l'état à jour.

### Style

Nouveau bloc `#bootstrap` dans `style.css`, calqué sur `#menu` (plein écran,
`place-items: center`, fond `#0d1218`, `z-index: 10`). Réutilise `--ink`,
`--accent`, la police monospace. Colonnes alignées avec des points de conduite
(`PLATFORM ......... WIN32`) via `white-space: pre` sur un `<pre>`.

## 4. Home minimale — `src/home.js`

Deux écrans dans le même fichier (jetable, PHASE 02 le supprime).

### `operatorSelect(root, choices) → Promise<id>`

```
OPERATOR SELECT

[ NEO ]
[ VEX ]
[ + NEW OPERATOR ]
```

Un bouton par opérateur → résout l'id. `+ NEW OPERATOR` → résout une sentinelle
`{ create: true }` que `main.js` route vers `bootstrap()`.

### `home(root, operator) → Promise<void>`

```
OPERATOR // NEO

CONTROL VECTOR   ↑ → ↓ ← ↑ ←

[ FLY ]
[ CONTROL VECTOR ]
[ SWITCH OPERATOR ]

FPVTP! // LOCAL INSTALLATION
```

- `[ FLY ]` → résout (on enchaîne sur `hud.showMenu`). C'est **ce clic** qui
  démarre l'`AudioContext` (`audio.start()` déplacé ici depuis le clic menu).
- `[ CONTROL VECTOR ]` → relance l'écran 3+4 du bootstrapping (récupération /
  modification), `patch` à la confirmation, retour à la Home. C'est le
  mécanisme de récupération exigé par la Bible §14.
- `[ SWITCH OPERATOR ]` → `operatorSelect` puis rechargement de la Home avec le
  nouvel opérateur (ou `bootstrap()` si `+ NEW`).

Style : réutilise `#bootstrap` (ou un `#home` quasi identique).

## 5. `main.js` — câblage

`chooseScene()` devient une séquence `async` :

```
const { operator, needsBootstrap, choices } = await loadOperator();
let op = operator;
if (OPTS.scene) {                       // fast-path dev inchangé
  op = op ?? await ensureDevOperator();
} else {
  if (needsBootstrap)      op = await bootstrap(ui, input);
  else if (choices) {
    const pick = await operatorSelect(ui, choices);
    op = pick.create ? await bootstrap(ui, input) : await selectOperator(pick);
  }
  await home(ui, op);                   // résout sur FLY
}
// … puis flux existant : loadSceneList → hud.showMenu → setScene → boot
```

- `operator` (l'état) est exposé au reste de l'app via l'import de `operator.js`
  (`getOperator()`), pas passé en paramètre partout.
- `audio.start()` : retiré du `onclick` de `hud.showMenu`, appelé au clic
  `[ FLY ]` de la Home (toujours dans un geste utilisateur). Le chemin `?scene=`
  saute Home **et** menu : pour lui, un listener global one-shot
  (`pointerdown`/`keydown`) démarre l'audio au premier geste.

## 6. Tests & vérif

- `npm run selftest` : **inchangé**, doit rester vert (aucun module moteur
  touché).
- Nouveau `tools/operator-selftest.mjs` : teste `freshState`, `migrate`
  (v-absent → v1, v1 → v1, v2 → rejet), et la validation `controlVector`
  (longueur, jetons). Lancé à la main (`node tools/operator-selftest.mjs`) ;
  pas d'ajout au script `selftest` (hors périmètre).
- Vérif manuelle scénario complet (critères d'acceptation de l'issue) :
  1. `operator-state/` vide → `npm run dev` → hardware discovery → name →
     control vector → registered → operator home.
  2. Recharger l'onglet → retombe sur operator home, pas de bootstrapping.
  3. Vider les données du site (localStorage) → recharger → l'opérateur est
     retrouvé (1 seul sur disque) ou `OPERATOR SELECT` (plusieurs).
  4. Deux navigateurs, deux opérateurs créés → chacun garde le sien en
     parallèle.
  5. `?scene=<slug>` → vol direct, `getOperator().controlVector` disponible.

## 7. Fichiers

**Nouveaux**
- `sim/src/operator.js`
- `sim/src/bootstrap.js`
- `sim/src/home.js`
- `sim/tools/operator-selftest.mjs`
- `sim/operator-state/` (créé au runtime, gitignored)

**Modifiés**
- `sim/tools/map-api-plugin.mjs` — groupe de routes `/__operator`, `freshState`,
  `migrate`, `SCHEMA_VERSION`
- `sim/src/main.js` — flux de boot
- `sim/src/style.css` — `#bootstrap` / `#home`
- `sim/src/input.js` — export d'un helper de lecture direction manette si besoin
  (sans changer le vol)
- `sim/.gitignore` — `operator-state/`

**Intacts** — tous les modules moteur (`quad.js`, `flightController.js`,
`physics.js`, `wind.js`, `rain.js`, `rainfall.js`, `fog.js`, `link.js`,
`lens.js`, `audio.js`, `loader.js`, `worker.js`, `TileMaterial.js`, `prep.mjs`),
`hud.js` (appelé tel quel).

## 8. Hors périmètre (issues de suivi si besoin)

- Operator Terminal complet (PHASE 02).
- Randomart, avatar (PHASE 02+).
- Migration des clés `fpvtp.*` (manette/audio/accessibilité) vers
  `settings` de l'opérateur — commence ici la structure, la migration réelle
  est portée par les phases réglages.
- Routes `terrainCache` / `sessions` / `targetLog` / `worldState` (phases
  dédiées).
- QTE / rituels du Control Vector (PHASE 10).
