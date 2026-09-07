# PHASE 02 — Operator Terminal / Home — design

Issue : lionrayonnant/FPVThePlanet#39 · Milestone P0 · label `roadmap-da`

## Objectif

Remplacer le menu « Choisir une carte » (`Hud.showMenu`) par le terminal de
l'opérateur, et découper `src/hud.js` (736 l., menu + chargement + OSD + réglages)
avant d'y ajouter quoi que ce soit.

## Périmètre

Dans le périmètre :

- découpage de `hud.js` en 3 modules (terminal, réglages, OSD+chargement) ;
- Operator Terminal (Home) au contenu fixé par l'issue ;
- écrans souches nommés pour chaque entrée non encore implémentée ;
- liste `LOCAL TERRAIN` avec taille disque réelle ;
- `CONTROL VECTOR` : affichage + `SHOW VECTOR` + `REDEFINE` ;
- footer avec compteurs réels.

Hors périmètre (assumé souche) :

- Global Scanner réel → PHASE 03 ;
- écran `VIEW SESSION` → PHASE 15 ;
- écran de choix de cible dans `REVISIT AREA` → PHASE 08 ;
- Operator Randomart / avatar → PHASE 32 (emplacement réservé, non rendu) ;
- réduction du panneau réglages (retrait des blocs météo/link) → PHASE 04.

## Découpage de `hud.js`

| Fichier | Rôle | Possède le DOM |
| --- | --- | --- |
| `src/terminal.js` (nouveau) | Operator Terminal + écrans souches + `operatorSelect` ; remplace `src/home.js` **et** `Hud.showMenu` | écrans `.terminal` montés en append dans `#ui` |
| `src/settings.js` (nouveau) | classe `Settings` : `set{Camera,Lens,Link,Weather,Rain,Fog,Audio}`, `buildAxisRows`/`updateAxisBars`, `toggleSettings`, `settingsOpen` ; + exports `load{Volume,Brightness,Lens,Weather,Rain,Fog,Link}` et constantes de clés localStorage + `loadNumber`/`loadPercent` | `#settings` |
| `src/hud.js` (restant, ~200 l.) | OSD de vol : `update()`, `setPaused`, corners, crash/pause/reticle, + écran de chargement (`progress`/`detail`/`startClock`/`setStage`/`fail`/`ready`) | `#hud`, `#loading` |

- `src/home.js` supprimé.
- Markup `#menu` + `#add-map-link` supprimé ; règles CSS `#menu*` supprimées.
- L'écran de chargement **reste** dans `hud.js` : PHASE 13 le retravaille derrière
  le TARGET SCAN, le déplacer maintenant serait un déplacement refait.
- `main.js` : construit `new Hud(...)`, `new Settings(input)`, puis
  `const slug = await runTerminal(ui, { settings, opts })`. En vol, `Tab` appelle
  `settings.toggleSettings()`. `main.js` importe les `load*` depuis `./settings.js`.
- CSS : les classes `.bootstrap*` restent comme primitives « écrans opérateur »
  partagées (bootstrap + terminal). Ajout de quelques règles `.terminal` : nav en
  texte inline séparé par ` · `, pas de bordure, pas de card, pas de coin arrondi.

## Operator Terminal (Home)

La Home est calme : pas de cards, pas de grosses métriques, pas de coins arrondis.

```
FPVTP! // 0.97b
OPERATOR // <NAME>

LAST SESSION · LOCAL TERRAIN · CONTROL VECTOR
[ GLOBAL SCANNER ]
SESSION LOG · TARGET LOG · SETTINGS · OPERATOR

LOCAL INSTALLATION · OPERATOR <NAME> · N LOCAL AREAS · N SESSIONS · N TARGETS LOGGED
```

- Chaque entrée est un `<button>` rendu comme texte inline, groupes séparés par
  ` · `. `[ GLOBAL SCANNER ]` est le seul CTA encadré (priorité au chemin court).
- Emplacement futur portrait/Randomart : `<div class="op-portrait" hidden></div>`
  réservé dans le markup, jamais rempli en PHASE 02.
- `runTerminal()` résout `{ slug }` quand l'opérateur choisit une zone à survoler
  (via `LOCAL TERRAIN`, `LAST SESSION → REVISIT AREA`). Résout aussi si
  `opts.scene` est fourni sans jamais monter d'écran.

## Navigation

| Entrée | Comportement PHASE 02 |
| --- | --- |
| `LOCAL TERRAIN` | liste depuis `GET /__map-api/scenes` : `NAME  ····  <taille lisible>  [ OPEN ]`. `OPEN` → résout `{ slug }` → FLY. Liste vide → `NO LOCAL TERRAIN` + `[ OPEN ACQUISITION ]`. Remplace `Hud.showMenu`. |
| `LAST SESSION` | dernier élément de `operator.sessions` ; sinon `LAST SESSION — NONE YET`. Boutons `VIEW SESSION` (souche) et `REVISIT AREA` → résout `{ slug }` de l'area de la session. |
| `CONTROL VECTOR` | vecteur masqué par défaut ; `SHOW VECTOR` le révèle ; `REDEFINE` → `captureControlVector(root, len)` (déjà dans `bootstrap.js`) → `patch('controlVector', v)` → `flush()`. |
| `GLOBAL SCANNER` | souche : `GLOBAL SCANNER — PHASE 3` + `[ OPEN ACQUISITION ]` (lien `add-map.html`) + `[ BACK ]`. |
| `SESSION LOG` | souche : `SESSION LOG — NO SESSIONS YET` + `[ BACK ]`. |
| `TARGET LOG` | souche : `TARGET LOG — NO TARGETS LOGGED` + `[ BACK ]`. |
| `SETTINGS` | `settings.toggleSettings(true)` (même panneau que `Tab` en vol). |
| `OPERATOR` | nom, `createdAt`, compteurs, `[ SWITCH OPERATOR ]` (logique existante : `listOperators` → `operatorSelect` → `selectOperator`/`bootstrap`). Zone portrait réservée. |

`?scene=<slug>` : inchangé. `main.js:624` court-circuite déjà le terminal ;
`runTerminal` ne monte aucun écran dans ce cas.

## Serveur

Aucun changement. `GET /__operator/:id` renvoie déjà l'état complet
(`sessions`, `targetLog`). Le compteur `N LOCAL AREAS` vient de
`/__map-api/scenes` (le `terrainCache` opérateur n'est peuplé qu'à partir de
PHASE 05/13). Footer : areas depuis map-api, sessions/targets depuis l'état
opérateur, assemblés côté client.

## Données & logique pure

`tools/terminal-model.mjs` (nouveau, aucune E/S, aucun DOM) :

- `formatBytes(n)` → `"1.2 GB"` / `"340 MB"` / `"—"` pour `null`/`0` ;
- `terminalModel({ operator, scenes })` → `{ operatorName, footer, areas:[{slug,name,size}], lastSession }`.

Le terminal DOM consomme uniquement ce modèle.

## Cas limites

- `scenes` vide et pas d'opérateur en cache : terminal s'affiche quand même,
  `LOCAL TERRAIN` guide vers l'acquisition. `main.js` ne doit plus jeter
  « aucune carte » avant le terminal (il jette encore après, si `?scene=` pointe
  vers un slug inconnu).
- `/__map-api/scenes` injoignable : `LOCAL TERRAIN` affiche `TERRAIN CACHE UNREACHABLE` + `[ BACK ]`, footer affiche `? LOCAL AREAS`.
- opérateur sans `controlVector` : `CONTROL VECTOR` affiche `(not set)` + `REDEFINE`.

## Tests

- `tools/terminal-selftest.mjs` (nouveau) : TDD de `formatBytes` et
  `terminalModel` (bornes, liste vide, dernière session absente). Ajouté au
  script `selftest:operator`.
- Écrans DOM : vérification manuelle via `npm run dev` (même approche que
  `bootstrap.js` / `home.js`, aucun harnais DOM au repo).
- `npm run selftest` (moteur) doit rester vert : le terminal ne touche pas le
  moteur physique.

## Suivi (issues à créer sur le Project 2)

- `VIEW SESSION screen` — dépend PHASE 15 ;
- `Écran de choix de cible dans REVISIT AREA` — dépend PHASE 08.
