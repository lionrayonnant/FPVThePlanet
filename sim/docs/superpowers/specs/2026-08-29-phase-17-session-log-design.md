# PHASE 17 — Session Log / Target Log

Issue : [#54](https://github.com/lionrayonnant/FPVTP/issues/54) · label `roadmap-da` · milestone P1
Branche : `phase-17-session-log`
Sources : Bible §28 (Session Log), §29 (Terrain et mémoire), §30 (Home) ·
Roadmap PHASE 17

## Objectif

Permettre à l'opérateur de retrouver tout ce qu'il a vécu : un journal des
sessions consultable et filtrable, un détail par session, et un historique des
cibles qui reste un **historique** — jamais un stock de drones réutilisables.

Deux souches de `terminal.js` disparaissent : les entrées `SESSION LOG` et
`TARGET LOG` de la Home, et le bouton `VIEW SESSION` de l'écran LAST SESSION.

## État de départ

- `state.sessions[]` porte déjà tout ce qu'il faut : `area`, `start`/`end`,
  `result`, `flightTelemetry`, `weatherSnapshot`, `target`, `randomart`,
  `photos[]`, `comment`, `resumeCount`.
- `state.targetLog` existe dans le schéma depuis PHASE 01 et n'a **jamais** été
  écrit : il est toujours vide. `terminal-model.mjs` et `operatorSummary` en
  comptent les éléments, donc affichent toujours `0 TARGETS LOGGED`.
- Une session n'a qu'un id opaque (`tour-eiffel-a3f2`) ; la Bible affiche
  `SESSION 00421` et `TARGET 042`.
- `REVISIT AREA` **existe déjà** dans `lastSessionScreen` : il résout le slug de
  la zone vers le chemin de vol normal. Il ne rejoue rien — TARGET SCAN frais,
  météo courante, entry state neuf, terrain relu sur disque. Le critère
  d'acceptation de l'issue est donc satisfait par le chemin existant ; PHASE 17
  ne fait que l'exposer aussi depuis le journal.
- PHASE 16 stocke les captures en base64 **dans le JSON de la session**, et le
  terminal recharge l'opérateur entier (`GET /__operator/:id`) à chaque retour
  au menu. À 40 sessions × 7 captures, cette réponse pèse des dizaines de
  mégaoctets — à chaque ouverture du terminal. Dette à corriger ici, parce que
  c'est ici qu'on se met à afficher les photos.

## Décisions

### D1 — Le Target Log est dérivé des sessions

Une fonction pure reconstruit l'historique depuis les sessions qui portent une
cible. Une seule source de vérité, rien à désynchroniser, aucun chemin
d'écriture supplémentaire.

Conséquence assumée : `DELETE SESSION` efface aussi la trace de sa cible. C'est
cohérent — le log ne conserve que la trace d'une session, et la session n'existe
plus.

Conséquence sur le schéma : la clé morte `state.targetLog` est **supprimée** par
la migration plutôt que laissée en place.

### D2 — Numérotation persistée, trous assumés

Deux compteurs sur l'opérateur, `sessionSeq` et `targetSeq`. Chaque session
reçoit son `seq` à l'ouverture ; celles qui ont une cible reçoivent en plus un
`targetSeq`. Assignés une fois, jamais recyclés.

Deux compteurs et non un : le footer de la Bible §30 les compte séparément
(« 42 SESSIONS · 17 TARGETS LOGGED »), et une session ouverte sans TARGET SCAN
(chemin dev `?scene=`) ne doit pas consommer un numéro de cible.

Une reprise (`resumeSession`) conserve les deux numéros : c'est la même session.

Supprimer la session 00419 laisse un trou entre 00418 et 00420. C'est voulu : un
numéro d'affichage stable vaut mieux qu'une renumérotation qui déplace sous les
yeux de l'opérateur la session qu'il appelait 00421.

### D3 — Suppression franche

`DELETE SESSION` retire l'entrée de `state.sessions`, photos comprises. Le
terrain n'est jamais touché — symétrique de « supprimer le terrain ne supprime
pas le souvenir » (Bible §29).

Une session `PENDING` n'est pas supprimable (`409`) : elle est peut-être en vol
dans un autre onglet.

### D4 — Les `dataUrl` des photos sont élidées par défaut

`GET /__operator/:id`, et toute réponse `{ session }` des routes de session,
renvoient `photos[]` sous la forme `{ w, h, ts }` — sans `dataUrl`.

Une route dédiée, `GET /__operator/:id/sessions/:sid`, renvoie la session
complète. Seul l'écran VIEW SESSION l'appelle, une fois, à son ouverture.

Vérifié avant décision : aucun client ne lit `photos[].dataUrl` depuis le cache
opérateur. `src/session.js` n'utilise que `photos.length`
(`photoCount()`), et c'est le seul consommateur.

### D5 — Le Target Log ne connaît pas le vol

L'écran `TARGET LOG` est en lecture seule et ne reçoit aucune fonction de
navigation vers le vol. Le critère d'acceptation « aucune interaction du Target
Log ne remet un drone en vol » est appliqué par construction, pas par
discipline.

## Architecture

### `tools/session-log-model.mjs` (nouveau) — logique pure

Aucune E/S, aucun DOM, aucun `node:crypto` : importable par le client (bundlé
par Vite) comme par le selftest.

| export | rôle |
|---|---|
| `SESSION_FILTERS` | `['ALL', 'LANDED', 'CRASHED', 'WITH PHOTOS']` |
| `filterSessions(sessions, filter)` | applique un filtre ; filtre inconnu → `ALL` |
| `sessionRow(s)` | une ligne de liste, colonnes alignées |
| `sessionDetail(s)` | le bloc texte de la Bible §28 |
| `targetLogEntries(sessions)` | l'historique dérivé, plus récent d'abord |
| `stamp(iso)` | `28.08.26 / 21:42` |
| `duration(seconds)` | `18m 42s` |
| `pad(n, width)` | `00421` |
| `areaLabel(slug)` | `tour-eiffel` → `TOUR EIFFEL` |

`areaLabel` dérive le libellé du slug de la session plutôt que d'aller le
chercher dans `scenes.json` ou `terrainCache` : une session doit rester lisible
après la suppression de son terrain (Bible §29).

`sessionRow` :

```text
SESSION 00421   TOUR EIFFEL   TARGET 042   LANDED    18m 42s
```

`sessionDetail` (Bible §28) : identité et zone, cible, Randomart déjà posé par
`openSession`, `WEATHER` depuis `weatherSnapshot`, `FLIGHT` depuis
`flightTelemetry`, `CAPTURES`, `OPERATOR NOTE`. Chaque bloc absent (session sans
cible, sans météo, sans note) est simplement omis — on n'invente rien.

Une entrée de Target Log porte : `targetSeq`, la famille, le RSSI et le mode, le
`hackType`, la zone, la date, le résultat de la session, et l'id de la session
d'origine.

### `tools/operator-store.mjs` — `SCHEMA_VERSION` 1 → 2

- `freshState()` : `sessionSeq: 0`, `targetSeq: 0` ; plus de `targetLog`.
- `migrate()` : rattrape les fichiers v1 — attribue `seq` aux sessions dans
  l'ordre du tableau, `targetSeq` à celles qui ont une cible, pose les deux
  compteurs au maximum atteint, et retire `targetLog`. Idempotent.

Un fichier opérateur écrit par cette branche est refusé par `main` (`409`
« schemaVersion trop récent »). C'est le comportement voulu du mécanisme, pas un
effet de bord.

### `tools/session-model.mjs`

- `openSession()` prend `seq` et `targetSeq` et les pose sur la session.
- `validateSession()` exige `seq` entier ≥ 1 ; `targetSeq` entier ≥ 1 quand la
  session a une cible, absent sinon.
- `stripPhotoData(session)` : nouvelle fonction pure, retire les `dataUrl`.

### `tools/map-api-plugin.mjs`

| route | changement |
|---|---|
| `GET /__operator/:id` | sessions élidées (D4) |
| `POST /__operator/:id/sessions` | assigne `seq`/`targetSeq` sur une session neuve, incrémente les compteurs ; réponse élidée |
| `PATCH\|POST .../sessions/:sid` | réponse élidée |
| `PATCH .../sessions/:sid/comment` | réponse élidée |
| `POST .../sessions/:sid/photos` | réponse élidée (le client ne lit que le compte) |
| `GET .../sessions/:sid` | **nouveau** — session complète, `dataUrl` incluses |
| `DELETE .../sessions/:sid` | **nouveau** — `404` inconnue, `409` `PENDING`, sinon retire et renvoie `{ removed }` |
| `operatorSummary` | `counts.targets` dérivé |

### `src/session-log.js` (nouveau) — écrans

Gabarit `src/target-scan.js` : `screen`/`button` de `terminal.js`, curseur
`↑`/`↓`, `Entrée` pour ouvrir, `Échap` pour revenir. Aucune dépendance
Three/Rapier.

- `runSessionLog(root, operator)` — barre de filtres inline, liste filtrée,
  `Entrée` ouvre le détail. Résout `undefined` (retour) ou un slug (REVISIT
  remonté depuis le détail).
- `runSessionDetail(root, sessionId)` — `GET .../sessions/:sid`, rend
  `sessionDetail()`, affiche les vignettes, propose `REVISIT AREA` (seulement si
  la zone est encore sur disque) · `DELETE SESSION` · `BACK`.
- `runTargetLog(root, operator)` — liste dérivée, lecture seule, `BACK` (D5).

### `src/terminal.js`, `tools/terminal-model.mjs`

- Les entrées `SESSION LOG` et `TARGET LOG` de la Home appellent les vrais
  écrans ; le helper `stub()` disparaît s'il n'a plus d'appelant.
- Le `VIEW SESSION` de LAST SESSION appelle `runSessionDetail`.
- `terminalModel` compte les cibles par `targetLogEntries(sessions).length`.
- La Home est reconstruite au retour du journal : une suppression change les
  compteurs du footer.

## Vérification

### Sans navigateur

- `tools/session-log-selftest.mjs` (nouveau) : les quatre filtres, le formatage
  des lignes et du détail, les blocs omis quand la donnée manque, la dérivation
  du Target Log et son ordre, la numérotation et les trous après suppression.
- `tools/session-selftest.mjs` : `seq`/`targetSeq` posés à l'ouverture et
  conservés au `resume` ; `validateSession` sur une session sans `seq` ;
  `stripPhotoData` ; migration v1 → v2 (backfill correct, `targetLog` retiré,
  idempotence).
- `tools/session-route-selftest.mjs` : `DELETE` (`404`, `409` sur `PENDING`,
  succès), `GET .../sessions/:sid` complet, élision effective sur
  `GET /__operator/:id`.
- Chaînés dans `npm run selftest:operator`.
- `npm run selftest` et `npm run build` restent verts.

### Navigateur

Sur une scène réelle, avec un opérateur portant plusieurs sessions : les quatre
filtres, l'ouverture d'un détail avec photos, `DELETE SESSION` puis retour à la
Home avec un footer à jour et un trou de numérotation visible, `REVISIT AREA`
vers un vol sans re-téléchargement du terrain, et le Target Log sans aucun
chemin vers le vol. Console sans erreur.

## Hors périmètre

- Le tri et la recherche dans le journal : les filtres de l'issue suffisent.
- L'export d'une session ou d'une photo.
- Une galerie plein écran des captures — les vignettes du détail suffisent ici.
- Le stockage binaire des photos hors du JSON opérateur (D4 en traite le
  symptôme coûteux ; la cause reste, à traiter en PHASE 24 si elle gêne).
