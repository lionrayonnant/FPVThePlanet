# La Home et le GLOBAL SCANNER ne font plus qu'un écran

Design validé le 2026-09-05. Branche `phase-27-ui-rework`.

## Pourquoi

Bible §4, première ligne : « Le `GLOBAL SCANNER` est le menu principal après
l'initialisation. »

#208 a construit l'inverse : une Home calme avec une vignette de carte figée, et
le scanner derrière un CTA `[ GLOBAL SCANNER ]`. Ce n'était pas une erreur de
lecture — §30 dit « la Home est calme, elle ne doit pas devenir un dashboard »,
et une carte plein cadre au démarrage pouvait ressembler à un tableau de bord.
Mais §30 vise **l'empilement de panneaux froids**, pas la carte. #208 le dit
lui-même dans son propre commentaire : « la carte est là parce que c'est le
lieu, pas parce que c'est une métrique ».

Deux écrans qui portent chacun une carte, c'est deux cartes dans un jeu qui n'en
veut qu'une (§4). Et aujourd'hui, aller chercher du terrain demande de quitter
la Home pour un plein cadre — une étape de navigation pour atteindre ce que la
Bible désigne comme le menu principal.

## Ce qu'on construit

Un seul écran pour FIELD, en deux colonnes, avec **deux états** et une carte qui
ne bouge jamais entre les deux.

### État de repos

```text
┌──────────────────┐┌────────────────────────────────┐
│ FPVTP! // 0.97b  ││                                │
│ OPERATOR // NEO  ││                                │
│                  ││   carte vivante — pan, zoom,   │
│ [ FLY — PARIS ]  ││   recherche, tracé             │
│                  ││   ┌────┐        ┌──────┐       │
│ LOCAL TERRAIN    ││   │▓▓▓▓│        │▓▓▓▓▓▓│       │
│ ▏PARISTEST       ││   └────┘        └──────┘       │
│  CNAM            ││    PARISTEST      CNAM         │
│                  ││                                │
│ MORE… · ARCHIVE  ││                                │
│ MODE · SETTINGS  ││                                │
│ ──────────────── ││                                │
│ pied             ││                                │
└──────────────────┘└────────────────────────────────┘
```

### État de travail

Dessiner une boîte ou une forme remplace **la colonne gauche** par le rail du
scanner. La carte ne bouge pas d'un pixel.

```text
┌──────────────────┐┌────────────────────────────────┐
│ SEARCH LOCATION  ││   MÊME CARTE, MÊME CADRAGE     │
│ AREA ANALYSIS    ││                                │
│ SIGNAL DENSITY   ││        ┌───────────┐           │
│ COVERAGE         ││        │ ░░░░░░░░░ │  ← la zone │
│ DESIGNATION      ││        └───────────┘    tracée │
│                  ││                                │
│ [ ACQUIRE AREA ] ││                                │
│ [ FLY LIVE ]     ││                                │
│ [ CANCEL ]       ││                                │
└──────────────────┘└────────────────────────────────┘
```

`[ GLOBAL SCANNER ]` disparaît de la Home : il n'y a plus d'ailleurs où aller.

## Architecture

### On ne réécrit pas le scanner

`runScanner()` fait ~950 lignes qui marchent : sonde, plan, élagage des bandes,
SSE du job d'acquisition, KEEP/REMOVE, RTC. Le refaire serait la façon la plus
sûre de casser PHASE 05.

Ce qui change est **où il se monte**.

```
avant :  runScanner(root)
         crée <div class="scanner"> plein cadre,
         carte à gauche + <aside class="scanner-panel"> à droite

après :  runScanner({ mapHost, railHost, onDone })
         se monte dans deux hôtes fournis par l'appelant
```

`mapHost` et `railHost` sont créés par la Home. Le corps de `runScanner` est
inchangé : il continue de faire `$('.sc-…')` dans son propre sous-arbre. Seules
les deux premières lignes de montage et la résolution bougent.

**Contrainte :** la carte Leaflet doit être construite **une seule fois** et
survivre au passage repos → travail. C'est la promesse centrale de l'écran. Le
rail se démonte et se remonte ; `mapHost` ne se démonte jamais tant que la Home
vit. `map.invalidateSize()` est appelé après tout changement de largeur de
colonne, sans quoi Leaflet garde ses dimensions de montage.

### Qui possède quoi

| Unité | Responsabilité | Ne sait rien de |
|---|---|---|
| `terminal.js` (Home) | les deux colonnes, l'état repos/travail, ce que la colonne gauche montre | le pipeline d'acquisition |
| `scanner.js` | sonder, décrire, acquérir, suivre le job | la Home, ARCHIVE, le vol local |
| `mini-map.js` | monter une carte monochrome, poser des cadres | le terrain local, le scanner |
| `map-preview-model.mjs` | `previewBounds(scene)` — l'emprise d'une zone | Leaflet |

La Home passe au scanner deux hôtes et reçoit une résolution. Elle ne lit jamais
l'état interne du scanner ; le scanner n'appelle jamais la Home.

### Les zones acquises sur la carte vivante

Chaque zone du cache terrain est dessinée à sa vraie place, dans le style exact
du rectangle `snapped` du scanner — ce que la Home montre et ce que
l'acquisition avait dessiné se reconnaissent (déjà l'invariant posé par #207).

La liste et la carte désignent la même chose, **dans les deux sens** :

- cliquer une ligne de `LOCAL TERRAIN` recadre la carte sur son emprise et
  réétiquette `[ FLY — … ]` ;
- cliquer un cadre sur la carte sélectionne la ligne correspondante.

`previewBounds()` rend déjà `null` pour une zone sans emprise connue : une telle
zone n'a pas de cadre sur la carte et reste sélectionnable par la liste seule.
Un repli sur (0, 0) montrerait le golfe de Guinée.

La liste compacte **sélectionne**, elle ne fait pas voler. `[ FLY ]` reste la
seule chose qui décolle (#123, « une seule touche pour voler »).

## Le bouton unique d'acquisition

### Ce qui existe

```text
[ PROBE AREA ]  →  verdict de couverture
[ ACQUIRE AREA ]  →  si non sondé : confirm('Acquire anyway?')  →  job
```

Le `confirm()` (`scanner.js:708`) est une **modale de navigateur** : §44 (« pas
d'UI SaaS ») et §38 la refusent, et c'est exactement le meuble de navigateur que
#205 a chassé des `<select>` et des `<input type=range>`.

### Ce qu'on fait

Un seul bouton, une seule pression dans le cas courant.

```text
[ ACQUIRE AREA ]
     ↓  PROBING        (POST /plan)
     ↓  SAMPLING       (POST /probe)
     ↓
  couverture OK        →  le job démarre immédiatement, pas de 2e pression
  rien / injoignable   →  ça s'arrête, le verdict dit pourquoi,
                          le bouton devient [ ACQUIRE ANYWAY ]
```

La deuxième pression **est** la confirmation, dans la langue du jeu. Le
`confirm()` disparaît.

Invariants conservés :

- La source reste **désignée, jamais devinée** — le bouton est fermé sans
  source, y compris sur le chemin clavier/manette.
- `plan.columns === 0` (hors couverture du fournisseur) arrête la séquence
  avant l'échantillon, comme aujourd'hui.
- Un échec de sonde n'est **pas** un verdict de couverture : `coverageLine()`
  continue de distinguer « injoignable » de « rien ici », et `[ ACQUIRE ANYWAY ]`
  s'affiche dans les deux cas — c'est à l'opérateur de décider s'il engage dix
  minutes sur une sonde qui n'a pas répondu.
- `[ FLY LIVE ]` n'est toujours conditionné qu'à une zone tracée : ni source, ni
  sonde, ni nom (#206).

### Modèle pur

L'enchaînement est décrit dans `tools/scanner-model.mjs` par une fonction pure
`acquireStep({ zone, source, name, plan, probe })` qui rend l'étape suivante et
le libellé du bouton. C'est elle que teste `scanner-selftest` ; `scanner.js` ne
fait que l'exécuter. Sans ça, la séquence n'est testable qu'avec un serveur.

## Ce qui ne change pas

Sceaux de non-régression, à vérifier explicitement :

- `tools/terminal-model.mjs` n'est pas modifié, et `model.footer` part mot pour
  mot dans le même `pre.terminal-foot`.
- `SELECT OPERATION MODE`, BENCH, et l'étanchéité du vol de banc (#194).
- ARCHIVE et tous les écrans qu'il appelle, `MORE…`, `FORECAST`.
- Les chemins `?scene=<slug>` et `?live=` sautent le terminal, inchangés.
- Un vol live en FIELD reste une reconnaissance sans session (#206).

## Fenêtres étroites

Les deux colonnes demandent de la largeur. Sous 1100 px, on empile : la carte en
haut à hauteur fixe, la colonne de texte dessous. Le rail remplace toujours le
bloc de texte, jamais la carte — la promesse « la carte ne bouge pas » tient
aussi empilée.

## Tests

`scanner-selftest` (modèle pur, sans navigateur) :

- `acquireStep` : sans zone, sans source, sans nom → le bouton est fermé et dit
  ce qui manque ;
- première pression → `PROBE` ; couverture OK → `ACQUIRE` sans pression ;
- couverture absente → arrêt, libellé `ACQUIRE ANYWAY` ;
- sonde injoignable → même arrêt, mais un détail différent (`coverageLine`
  distingue déjà les deux) ;
- `plan.columns === 0` → pas d'échantillon.

`terminal-render-selftest` (faux DOM) :

- les deux colonnes sont montées, la carte est dans la colonne de droite ;
- dessiner remplace la colonne gauche par le rail **et** laisse le nœud de la
  carte identique (`===` sur la référence du nœud) — c'est la promesse centrale ;
- annuler rend la colonne gauche, toujours sans toucher la carte ;
- la liste sélectionne et réétiquette `[ FLY ]`, elle ne résout pas ;
- `[ GLOBAL SCANNER ]` n'existe plus ;
- le pied est exactement `terminalModel().footer`.

Leaflet lui-même ne se teste qu'à l'œil : rendu en Chromium headless piloté en
CDP, comme la passe #209.

## Découpage

**Lot A — l'écran.** Deux colonnes, deux états, la carte partagée et jamais
démontée, les cadres des zones acquises, la sélection dans les deux sens, le
bouton unique d'acquisition. Jouable et testable de bout en bout.

**Lot B — l'état du monde sur la carte.** Météo réelle et densité de signal
portées sur les cadres ; la liste de gauche se vide de ses colonnes et redevient
une liste de noms. Décidé après avoir vu le lot A en vrai — « est-ce que ça
surcharge » ne se tranche qu'à l'œil.

Si le lot B dérape, le lot A est déjà dans `main`.
