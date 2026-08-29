# PHASE 06 — Modèle de session — Design

Issue : https://github.com/lionrayonnant/FPVMaps/issues/43
Date : 2026-08-29
Statut : validé en brainstorming, prêt pour le plan d'implémentation.

## Objectif

Créer explicitement la notion de **session** : une unité qui lie un opérateur, une
zone de terrain, une cible, un instantané météo, un intervalle temporel, un
verdict, une télémétrie agrégée et un randomart. Une session est écrite à chaque
vol, avec deux verdicts distincts (`LANDED` / `CRASHED`).

Règle directrice : **terrain persistent, flights ephemeral**. Le monde persiste,
la machine non. Un crash ne supprime jamais le terrain ; une fin propre non plus.

## Décisions de conception (brainstorming)

1. **Pas de geste d'armement au démarrage du vol.** PHASE 13 (« Première seconde
   de vol ») impose un cut direct vers un drone déjà actif. La session s'ouvre
   quand la première image de vol est prête.
2. **Verdict `LANDED` = geste de désarmement Betaflight explicite** (`throttle`
   bas + `yaw` plein gauche tenu ~0,5 s, ou touche `j`), **alors que** le drone
   est au sol et quasi immobile.
3. **Désarmement en vol** : `armed = false`, moteurs coupés, la chute suit son
   cours. C'est l'impact (`impact > CRASH_IMPULSE`, déjà détecté dans `main.js`)
   qui ferme la session en `CRASHED`. Si la chute ne produit pas d'impact (eau,
   hors map), la session reste `PENDING` et est réconciliée `CRASHED` au prochain
   chargement du terminal. Le problème d'absence de bordure de map est repoussé.
4. **Session `LANDED` ré-ouvrable** (verdict A) : plusieurs cycles
   armement/désarmement possibles, la session reste `LANDED` tant que le drone ne
   crashe pas. Un crash pendant une reprise → `CRASHED`, terminée définitivement.
   La télémétrie s'agrège sur l'ensemble des cycles. `resumeCount` compte les
   ré-ouvertures.
5. **Persistance** : session tenue en mémoire client pendant le vol.
   - `POST` à l'ouverture → squelette `PENDING` sur disque (pour matérialiser un
     `CRASHED` même si l'onglet meurt).
   - `PATCH` unique à la clôture → `end`, `result`, télémétrie agrégée, randomart.
   - Onglet fermé avant la clôture → `navigator.sendBeacon` best-effort, sinon
     réconciliation `PENDING` → `CRASHED` au prochain `GET /__operator/:id`.
   - **2 écritures réseau par vol** (ouverture + clôture), aucune pendant le vol.
6. **randomart généré dès cette phase** (drunken-bishop déterministe sur
   `sha256(sessionId)`), pour que le même art revienne à chaque reconnexion
   (exigence roadmap).
7. **Structure client** : module pur `session-model.mjs` + `randomart.mjs`,
   module client léger `src/session.js`, ~8 lignes ajoutées à `main.js`. Aucune
   dépendance de la DA sur le moteur physique (`flightController.js` / `quad.js`
   n'apprennent rien de la session).

## Cycle de vie

```
                 CONTROL ACQUIRED (vol démarre, drone déjà actif)
                          │
                          ▼
                  POST skeleton  ──►  session PENDING sur disque
                          │
                   ┌──────┴───────┐
        désarmement au sol    impact > CRASH_IMPULSE
        + vitesse < 0,5 m/s    (dont : désarmement en vol → chute → impact ;
                   │            onglet mort → réconciliation)
                   ▼                        │
           PATCH result=LANDED       PATCH result=CRASHED
           télémétrie + randomart    (ou réconciliation au load)
                   │                        │
        drone conservé, session      drone détruit, terrain conservé,
        ré-ouvrable (resumeCount++)  session TERMINÉE définitivement
```

- **Ouverture** : après `boot()` résolu et 1re frame prête —
  `session.open({ area, weatherSnapshot, resume })`.
- **`LANDED`** : `onAction('disarm')` → `controller.disarm()` ; `main.js` constate
  drone au sol + `speed < 0.5` → `session.end('LANDED')`.
- **`CRASHED`** : `impact > CRASH_IMPULSE` (existant `main.js:527`) →
  `session.end('CRASHED')` une seule fois.
- **Après `CRASHED`** : `respawn()` (touche `r`) ne relance plus le vol en place —
  renvoie au terminal (`location.href = '/'`). En mode `?scene=<slug>` (dev), on
  garde l'ancien `respawn()` local pour ne pas casser le flow de debug.
- **Reprise `LANDED`** : `session.open({ resume: '<sessionId>' })` → serveur
  repasse `result` à `PENDING`, garde `start` / `randomart`, `resumeCount++`,
  agrège la télémétrie par-dessus l'existante.

## Modèle de données

Élément de `operator.sessions[]` :

```jsonc
{
  "schemaVersion": 1,
  "id": "tokyo-shibuya-a1b2",         // slugify(area) + '-' + 2 octets hex
  "operatorId": "neo-3f9c",
  "area": "tokyo-shibuya-a1b2",       // slug de zone (terrainCache)
  "target": null,                     // PHASE 07 — champ réservé
  "weatherSnapshot": {                // copie figée de l'objet weather du boot()
    "zone": "35.66,139.70",
    "day": "2026-08-29",
    "source": "open-meteo",
    "regime": "CLEAR",
    "confidence": 0.94,
    "day0": { /* weather.days[0] tel quel */ }
  },
  "start": "2026-08-29T14:03:11.000Z",
  "end":   "2026-08-29T14:11:47.000Z", // null tant que PENDING
  "result": "PENDING",                 // PENDING | LANDED | CRASHED
  "flightTelemetry": {
    "durationS": 516.7,                // somme des cycles armés
    "maxSpeedMs": 27.4,
    "maxRateDps": 812,                 // max( |roll rate|, |pitch rate|, |yaw rate| )
    "maxAltitudeM": 63.1,             // au-dessus du spawn
    "distanceM": 4130                  // intégrale de la vitesse horizontale (armé)
  },
  "randomart": "+--[FPV 06]------+\n|      ...       |\n+----[a1b2]------+",
  "photos": [],                        // PHASE 15 — réservé
  "comment": null,                     // PHASE 15 — réservé
  "resumeCount": 0
}
```

### `tools/session-model.mjs` (pur, aucune E/S)

- `SESSION_SCHEMA_VERSION = 1`
- `newSessionId(area)` → `slugify(area) + '-' + randomBytes(2).toString('hex')`
- `openSession({ operatorId, area, weatherSnapshot })` → objet `PENDING`,
  `start = now`, télémétrie à zéro, `randomart` généré immédiatement, `target: null`,
  `photos: []`, `comment: null`, `resumeCount: 0`.
- `resumeSession(existing)` → `result: 'PENDING'`, `end: null`, `resumeCount++` ;
  conserve `start`, `id`, `randomart`, `flightTelemetry`.
- `closeSession(session, { result, telemetry })` → pose `end = now`, `result`,
  `flightTelemetry = mergeTelemetry(session.flightTelemetry, telemetry)`.
- `mergeTelemetry(a, b)` → `max` sur `maxSpeedMs` / `maxRateDps` / `maxAltitudeM`,
  `+` sur `durationS` / `distanceM`. Associatif.
- `sanitizeWeatherSnapshot(raw)` → ne garde que la forme connue
  (`zone`, `day`, `source`, `regime`, `confidence`, `day0`), sinon `throw`.
- `validateSession(s)` → garde-fou serveur : `id` conforme à la regex,
  `result ∈ {PENDING,LANDED,CRASHED}`, `weatherSnapshot` sain, télémétrie
  numérique finie ≥ 0.
- `reconcileStaleSessions(state)` → passe chaque session `PENDING` en `CRASHED`
  (`end = new Date().toISOString()`), renvoie `{ state, changed }`.

### `tools/randomart.mjs` (pur)

- `randomart(seed)` → drunken-bishop classique : grille 17×9, `sha256(seed)`
  parcouru 2 bits à la fois, position de départ au centre, comptage des visites,
  table de symboles standard (` .o+=*BOX@%&#/^` + `S`/`E`), rendu ASCII encadré
  `+--[FPV 06]------+` … `+----[<4 derniers hex du sessionId>]------+`.
- Déterministe : même seed → même art. Utilisé avec `seed = session.id`.

### `operator-store.mjs`

`sessions` est déjà présent (`[]`) dans `freshState()` — rien à migrer. On ajoute
seulement la validation à l'écriture serveur.

## Endpoints serveur (`tools/map-api-plugin.mjs`)

Ajoutés à `opRoutes`, mêmes conventions que l'existant (regex sur le path,
`_readOperator` / `_writeOperator` atomique tmp+rename, **aucun `await` entre
lecture et écriture** → atomique sur le thread unique de Vite).

```
POST /__operator/:id/sessions
  body { area, weatherSnapshot }        → openSession(), state.sessions.push(), write → 201 { session }
  body { resume: "<sessionId>" }        → retrouve la session, exige result === 'LANDED',
                                          resumeSession() en place, write → 201 { session }

PATCH /__operator/:id/sessions/:sid
  body { result: "LANDED"|"CRASHED", telemetry: {...} }
  → closeSession() (merge des agrégats), write → 200 { session }
  → 404 si sid inconnu
  → 409 si la session est déjà terminale (LANDED/CRASHED) — la reprise passe
    obligatoirement par POST .../sessions { resume }, jamais par ce PATCH
```

- Validation systématique via `validateSession()` ; `weatherSnapshot` filtré par
  `sanitizeWeatherSnapshot()` → 400 si malformé.
- `sessions` et `worldState` restent **hors de `OP_WRITABLE_KEYS`** : le client ne
  peut pas écraser `sessions` via le `PATCH /__operator/:id` générique, seulement
  via ces routes dédiées.
- **Réconciliation** : pas de route dédiée. Le handler `GET /__operator/:id`
  appelle `reconcileStaleSessions(state)` et réécrit si `changed`. (Le terminal
  recharge l'opérateur à chaque retour au menu.)

## Client

### `src/session.js` (aucun DOM, aucun Three)

```
open({ area, weatherSnapshot, resume })  → POST ; stocke { session, id } en mémoire
feed(sample)                             → agrège en mémoire (aucun réseau)
end(result)                              → PATCH unique (result + télémétrie) ; vide l'état
beacon(result)                           → navigator.sendBeacon best-effort
current()                                → session en mémoire ou null
```

`feed({ speed, horizontalSpeed, rateDps, altitudeAboveSpawn, dt, armed })` :

- `durationS += dt` **seulement si `armed`**
- `distanceM += horizontalSpeed * dt` **seulement si `armed`**
- `maxSpeedMs = Math.max(maxSpeedMs, speed)`
- `maxRateDps = Math.max(maxRateDps, rateDps)` (`rateDps` = max des 3 axes déjà calculé côté appelant)
- `maxAltitudeM = Math.max(maxAltitudeM, altitudeAboveSpawn)`

Réseau : **2 fonctions ajoutées à `src/operator.js`** — `postSession(body)` et
`patchSession(sid, body)` — qui réutilisent `req()`, `cache`, `cache.id`.
`session.js` ne parle jamais directement à `fetch`.

### `src/main.js` (≈ 8 lignes)

- Après `boot()` + 1re frame : `await session.open({ area: slug, weatherSnapshot: sanitizeWeatherSnapshot(weather), resume: OPTS.resume })`.
  `OPTS.resume` vient de `?resume=<sessionId>` (posé par le terminal pour la reprise).
- Dans `frame()` : `session.feed({ ... , armed: controller.armed, dt })`.
  Valeurs mesurées depuis `physics` (vitesse, position) et le gyro (rates).
- Détection crash existante → `if (!crashed) { crashed = true; session.end('CRASHED'); }`.
- `onAction('disarm')` → `controller.disarm()` ; puis si drone au sol
  (`physics` contact) et `speed < 0.5` → `session.end('LANDED')`.
- `respawn()` : si `crashed` et hors mode `?scene=` → `location.href = '/'`.
  Sinon comportement actuel.
- `beforeunload` : `if (session.current()?.result === 'PENDING') session.beacon('CRASHED')`.

### Désarmement — `src/input.js` + `src/flightController.js`

- `input.js` : nouvelle détection combo `sticks.throttle < 0.05 && sticks.yaw < -0.9`
  tenu 0,5 s → `this.onAction('disarm', evt)`. La touche `j` déclenche la même
  action (équivalent clavier, throttle réel absent).
- `flightController.js` : méthode `disarm()` → `this.armed = false`. Le mixer coupe
  déjà les moteurs quand `!this.armed` (ligne ~307). Aucune logique de session ici.
- `armed` est déjà un champ public en lecture.

## Tests & vérification

### `npm run selftest` (15 checks navigateur-less)

Inchangé — PHASE 06 ne touche ni la physique ni la géodésie. Doit rester 15/15.

### `tools/session-selftest.mjs` (nouveau, branché dans `npm run selftest:operator`)

Pur, sans réseau ni navigateur :

- **session-model** : forme de `openSession()` ; `closeSession()` fait `max` sur
  les maxima et `+` sur durée/distance ; `resumeSession()` incrémente
  `resumeCount`, conserve `start` / `randomart`, remet `result: PENDING` ;
  `validateSession()` rejette `weatherSnapshot` malformé, `result` inconnu,
  `id` hors regex ; `sanitizeWeatherSnapshot()` filtre les clés inconnues.
- **`mergeTelemetry()`** : associatif sur un exemple à 3 segments.
- **`randomart()`** : déterministe (même seed → même art) ; seeds différents →
  arts différents ; dimensions et cadre corrects.
- **`reconcileStaleSessions()`** : `PENDING` → `CRASHED` + `end` posé ; session
  terminale intacte ; flag `changed` correct.
- **agrégateur client** (`session.js` avec `_setFetch` injecté, comme
  `operator.selftest.mjs`) : `feed()` n'accumule durée/distance que si `armed` ;
  `open()` + `end()` font exactement 1 POST + 1 PATCH avec les bons corps.

### Vérification live (MCP chrome-devtools, GPU réel)

1. Vol normal → poser → combo désarmement → `TARGET STATUS: LANDED` →
   `operator-state/<id>.json` : 1 session `LANDED`, télémétrie non nulle, randomart.
2. Nouveau vol même zone → crash mur → `SESSION TERMINATED` → 2e session
   `CRASHED` ; `r` renvoie au terminal.
3. Reprise de la session `LANDED` depuis LAST SESSION → même `sessionId`,
   `resumeCount: 1`, télémétrie cumulée.
4. Fermer l'onglet en plein vol → recharger le terminal → session réconciliée
   `CRASHED`.
5. Deux opérateurs en parallèle (NEO / VEX, tous deux sur Tokyo) → aucune session
   ne fuite d'un fichier opérateur à l'autre.

## Hors périmètre (phases ultérieures)

- `target` : rempli par PHASE 07.
- `photos`, `comment`, écrans SESSION LOG / post-flight analysis : PHASE 15.
- Bordure de map / drone hors zone sans impact : phase ultérieure.
- Geste d'armement / entry state / première seconde de vol : PHASE 11 + 13.
- `KEEP TERRAIN` / `REMOVE TERRAIN` après session : PHASE 15 (la suppression du
  terrain ne supprime pas la session).

## Fichiers touchés

| Fichier | Nature |
|---|---|
| `sim/tools/session-model.mjs` | nouveau — logique pure |
| `sim/tools/randomart.mjs` | nouveau — drunken-bishop pur |
| `sim/tools/session-selftest.mjs` | nouveau — tests |
| `sim/tools/map-api-plugin.mjs` | +2 routes, réconciliation dans le GET |
| `sim/tools/operator-selftest.mjs` (ou le runner `selftest:operator`) | branche le nouveau selftest |
| `sim/src/session.js` | nouveau — module client |
| `sim/src/operator.js` | +`postSession()` / `patchSession()` |
| `sim/src/main.js` | ~8 lignes : open / feed / end / respawn / beforeunload |
| `sim/src/input.js` | détection combo désarmement + touche `j` |
| `sim/src/flightController.js` | méthode `disarm()` |
| `sim/src/terminal.js` | LAST SESSION / SESSION LOG : bouton reprise → `?resume=` |
| `sim/package.json` | éventuel script si `selftest:operator` n'agrège pas déjà |
| `sim/HANDOFF.md` | état vérifié PHASE 06 |
