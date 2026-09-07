# PHASE 08 — Target scan / choix de cible

État : validé 2026-08-29.

Issue : https://github.com/lionrayonnant/FPVThePlanet/issues/45
Sources : Bible §15 (« Acquisition d'une cible »), §22 (« Ce qui est connu du
drone »), Roadmap PHASE 8.

## Objectif

Après l'acquisition du terrain, avant le vol : `TARGET SCAN`. Le joueur voit
plusieurs signaux et en choisit un. **Interaction courte.**

```text
TARGET SCAN
SIGNALS DETECTED

01   -54 dBm   ANALOG
02   -59 dBm   UNKNOWN
03   -67 dBm   DIGITAL
04   -71 dBm   UNKNOWN
```

Le signal choisi devient la **cible** de la session (PHASE 06,
`session.target`, aujourd'hui toujours `null`). Il porte une **famille de drone**
(PHASE 07, `src/drone-profiles.js`) qui pilotera le modèle de vol, et un
**RSSI annoncé** qui informe le lien vidéo de la session (`src/link.js`).

### Information partielle

Trois niveaux, rien d'autre (Bible §15) :

- `KNOWN` → réellement mesuré ;
- `EST.` → déduction ;
- `UNKNOWN` → véritable inconnue.

Fiche pré-hack (Bible §22) : `LOCATION KNOWN`, `SIGNAL KNOWN`,
`DEVICE PARTIAL` (classe grossière en `EST.`, jamais la famille exacte),
`VIDEO` connu ou `PARTIAL`, `CONTROL UNKNOWN`, `FLIGHT STATE UNKNOWN`.
**Ne jamais afficher caméra, rates, batterie, état de vol.**

### Critères d'acceptation (issue #45)

- Le joueur choisit sur des critères réels et incomplets, sans que le jeu lui
  dise quoi prendre.
- Aucun panneau d'analyse ne révèle par avance ce qu'on découvre en vol.
- Le RSSI annoncé a une conséquence sur le lien de la session.
- Cohérence avec la densité de signaux du Global Scanner (PHASE 3).

## Ce que PHASE 07 n'a pas fait

`phase-07-generation-cibles` s'est arrêtée à la **couche physique** (7→6
familles, profils, PID par famille) et a laissé le hook dev `?family=<nom>`
« until PHASE 08 wires target selection ». Le descripteur de cible éphémère et
la liste de signaux candidats du Roadmap PHASE 7 **n'existent pas** : les
produire fait partie de PHASE 08.

## Branche

`phase-08-target-scan` = `main` + merge `origin/phase-06-impl` + merge
`origin/phase-07-generation-cibles`. Un seul conflit de contenu (`main.js`,
clé `OPTS`), résolu en gardant `resume` (06) et `family` (07). `physics.js`,
`flightController.js` auto-mergés proprement.

**Retune collider (déjà commité, `2eefd02`)** : le collider de PHASE 06
(`restitution 0.05` / `friction 1.0`, mesuré sur `freestyle5` seul) croisé avec
le sweep 6 familles de PHASE 07 faisait déraper le `toothpick` à 1,55 m/s au sol
(> seuil `sits still` de `tools/selftest.mjs`). Re-balayé restitution×friction
contre le selftest tour-eiffel → `restitution 0.15` / `friction 1.0` : toothpick
0,99 m/s, 6 familles vertes, `a gentle landing` 483 N. 0,15 reste sans rebond.

Baseline exigée verte avant le code PHASE 08 : `npm run selftest:operator`,
`node tools/selftest.mjs public/scenes/tour-eiffel`, `npm run build`. ✅

## Approche retenue — A : modèle pur, régénération serveur par graine

Le client génère le scan (module pur bundlé par Vite), l'affiche, récupère un
**index**. `session.open()` n'envoie que `{ targetSeed, targetCount,
targetIndex }` — **jamais le descripteur**. Le serveur ré-exécute la même
génération avec la même graine, prend `[index]`, valide, stocke le descripteur
résolu dans `session.target`. Déterministe, non falsifiable, cohérent avec
`session-model.mjs` déjà partagé client/serveur.

Écartées : **B** tout-serveur (deux allers-retours pour une « interaction
courte », nouveau endpoint de lecture) ; **C** tout-client (le client devient
l'autorité sur les stats de la cible — contraire à « l'état opérateur vit côté
serveur »).

## Architecture

### D1 — `tools/target-model.mjs` (nouveau) : pur, sans dépendance

PRNG : hash FNV-1a du seed (string) → `xorshift`, idiome de `link.js`. Pas de
`node:crypto` (doit tourner dans le navigateur).

```text
FAMILY_CLASS = { freestyle5:'5"', race5:'5"', cinewhoop:'CINEWHOOP',
                 longrange:'LONG RANGE', heavy5:'5"', toothpick:'MICRO' }
TARGET_FAMILIES = Object.keys(FAMILY_CLASS)
```

`FAMILY_CLASS` est de la donnée stable dupliquée ici pour garder le modèle sans
dépendance ; un selftest vérifie `keys(FAMILY_CLASS)` ≡ `FAMILIES` de
`drone-profiles.js` (garde-fou de dérive).

```text
generateTargetScan({ seed, count }) → { seed, count, candidates: [Candidate] }

Candidate = {
  id:        '01'…'0N',                       // rang d'affichage
  rssiDbm:   number,                          // KNOWN, ~[-72,-52], triés décroissant
  mode:      'ANALOG' | 'DIGITAL' | 'UNKNOWN',// ~50 % révélé, ~50 % UNKNOWN
  _family:   ∈ TARGET_FAMILIES,               // caché jusqu'au vol
  _classHint:∈ valeurs de FAMILY_CLASS,       // EST. — le bucket, jamais la famille
  _videoHint:'ANALOG' | 'DIGITAL',            // le vrai mode, même si `mode` = UNKNOWN
}
```

- `count` : `clamp(round(densité), 2, 5)`, défaut 4 (cf. D6).
- `rssiDbm` : une base tirée par candidat dans `[-72, -52]`, liste triée
  décroissante (le plus fort en `01`, comme l'exemple Bible).
- `mode` : ~50 % affiche `_videoHint`, ~50 % `UNKNOWN`.
- `_family` : tirage uniforme sur `TARGET_FAMILIES` ; `_classHint = FAMILY_CLASS[_family]`. (Pondérer les familles serait le premier pas vers le système de rareté, explicitement hors périmètre.)

```text
describeTarget(candidate) → fiche pré-hack, SANS _family :
  { location:'KNOWN',
    signal:`${rssiDbm} dBm`,                       // KNOWN
    device:'PARTIAL',  deviceHint:_classHint,      // EST.
    video: mode === 'UNKNOWN' ? 'PARTIAL' : mode,  // + videoHint en EST. si PARTIAL
    control:'UNKNOWN', flightState:'UNKNOWN' }

resolveTarget(scan, index) → descripteur persisté :
  { family:    _family,
    classHint: _classHint,
    signal:  { rssiDbm, mode: _videoHint },        // le vrai mode
    scannedAt: ISO,
    intel: { location:'KNOWN', signal:'KNOWN', device:'PARTIAL',
             video:'EST.', control:'UNKNOWN', flightState:'UNKNOWN' } }
```

`describeTarget` ne doit **jamais** exposer `_family` — un selftest le vérifie
sur toute la sortie sérialisée.

### D2 — `tools/session-model.mjs`

- `sanitizeTarget(raw)` (nouveau) : `raw == null` → `null` ; sinon forme
  contrôlée — `family ∈ TARGET_FAMILIES`, `signal.rssiDbm` fini `< 0`,
  `signal.mode ∈ {ANALOG, DIGITAL}`, `intel` objet. Throw si malformé.
- `openSession({ operatorId, area, weatherSnapshot, target })` : accepte
  `target` optionnel, stocke `sanitizeTarget(target) ?? null`.
- `validateSession` : si `s.target != null`, `sanitizeTarget(s.target)` (throw).
- `resumeSession` : inchangé — le spread conserve `target`.
- **Pas de bump de `SESSION_SCHEMA_VERSION`** : le champ `target: null` existe
  déjà dans le squelette, les sessions sur disque sont compatibles.

### D3 — `tools/map-api-plugin.mjs` — `POST /:id/sessions`

Branche fraîche (pas `b.resume`) :

```text
si b.targetSeed :
  scan   = generateTargetScan({ seed: b.targetSeed, count: b.targetCount })
  index  = b.targetIndex ; 400 si hors [0, scan.candidates.length[
  target = resolveTarget(scan, index)
sinon :
  target = null   (+ console.warn — garde le chemin dev ?scene= et les tests)
session = validateSession(openSession({ operatorId, area, weatherSnapshot, target }))
```

Branche `resume` : inchangée (la cible est déjà sur la session stockée). Une
session `resume` avec un `targetSeed` dans le body → ignoré.

### D4 — `src/session.js` (client)

`open({ area, weatherSnapshot, resume, target })` où `target = { seed, count,
index }`. Body :

```text
resume ? { resume }
       : { area, weatherSnapshot,
           targetSeed: target?.seed, targetCount: target?.count, targetIndex: target?.index }
```

### D5 — `src/target-scan.js` (nouveau) : l'écran

`screen` et `button` deviennent **exportés** de `src/terminal.js` (une seule
source du look terminal) ; `navRow` reste privé.

```text
runTargetScan(root, { seed, count }) → Promise<{ seed, count, index }>
```

- Génère via `generateTargetScan`, affiche `TARGET SCAN / SIGNALS DETECTED` +
  la liste (`01   -54 dBm   ANALOG`…).
- Navigation : `↑`/`↓` + `Entrée`, ou clic. Curseur `>` sur la ligne active.
- Sélection → fiche `describeTarget` (les lignes `KNOWN`/`EST.`/`UNKNOWN`) +
  `CONFIRM` / `BACK`. Deux frappes, pas plus.
- **Aucun** élément ne montre famille / caméra / rates / batterie.

### D6 — Densité (cohérence Global Scanner)

`scanner-model.signalDensity()` renvoie `{ level, range: [lo, hi] }`. PHASE 05 ne
le persiste pas → **petit ajout PHASE 05** :

- `scanner.js` : à l'acquisition (`ACQUIRE AREA`), joindre
  `{ level, range }` de `signalDensity()` à l'entrée écrite dans `terrainCache`.
- `operator-store.mjs` : accepter/valider ce champ `signalDensity` sur l'entrée
  terrain (forme : `{ level:number, range:[number,number] }` ou absent).
- `main.js` : lire la densité du terrain courant →
  `count = clamp(round((lo + hi) / 2), 2, 5)`. Absente (cache ancien, terrain
  local sans acquisition) → `count = 4`.

### D7 — `src/link.js`

```js
setSignal({ rssiDbm } = {}) {
  // Le RSSI annoncé = niveau de lien propre de cette cible à D0 : un émetteur /
  // une antenne plus faibles démarrent le budget avec moins de marge. Additif
  // en dB, comme tous les autres termes ici.
  this._baseLoss = Number.isFinite(rssiDbm) ? Math.max(0, RSSI_REF_DBM - rssiDbm) : 0;
}
```

`update()` : `const target = (spread + shadow + this._baseLoss) * this.severity;`
`_baseLoss` initialisé à `0` au constructeur, **non touché par `reset()`** (c'est
une propriété de la cible, elle survit à un respawn dans la session).

### D8 — `src/main.js`

Avant `boot()`, dans le gate `.then(({ slug, resume }) => …)` :

```text
si !resume && !OPTS.family :
  seed  = hex aléatoire
  count = depuis la densité du terrain (D6), défaut 4
  scan  = generateTargetScan({ seed, count })
  choice = await runTargetScan(root, { seed, count })       // { seed, count, index }
  _family = scan.candidates[choice.index]._family            // connu tout de suite
```

- `PROFILE` : `resume` → `PROFILES[session.current().target.family]` (disque) ;
  sinon `_family` ci-dessus ; sinon `OPTS.family` (override dev) ; sinon `undefined`.
- `controller` : passe de `const` top-level à `let`, construit dans le gate une
  fois `PROFILE` connu (aujourd'hui `new FlightController(PROFILE ? {profile} :
  undefined)` en tête de module — à différer). `Physics(collision, spawn,
  {profile: PROFILE})` est déjà dans `boot()`.
- `session.open({ area, weatherSnapshot, resume, target: choice })` reste **après**
  le chargement météo (placement PHASE 06) ; le serveur régénère la copie
  autoritative (même graine → identique au choix client).
- Après `session.open` : `link.setSignal({ rssiDbm: session.current().target.signal.rssiDbm })`.
- `?family=` conservé en **override dev seul** (saute le scan).

### D9 — `src/terminal.js`

Aucun changement de flux : le scan vit dans `main.js`. Seul ajout : `export`
sur `screen` et `button` (repris par `target-scan.js`).

## Séquencement (ordre d'implémentation)

1. `tools/target-model.mjs` + `tools/target-selftest.mjs` (TDD).
2. `session-model.mjs` (`sanitizeTarget`, `openSession`, `validateSession`) +
   extension `session-selftest.mjs`.
3. `map-api-plugin.mjs` `POST /:id/sessions`.
4. `link.js` `setSignal` + cas selftest (RSSI faible → chute mesurable de
   `link.out.quality` à distance/obstruction fixes).
5. D6 : persistance densité (scanner.js, operator-store.mjs).
6. `terminal.js` exports + `src/target-scan.js`.
7. `session.js` (client) + `main.js` câblage (PROFILE différé, scan, link).
8. Vérif : `selftest:operator`, `selftest.mjs`, `build`, run navigateur.

## Tests

- **`tools/target-selftest.mjs`** (nouveau, chaîné dans `selftest:operator`) :
  déterminisme graine (même seed → mêmes candidats) ; `count` clampé `[2,5]` ;
  `describeTarget` ne contient jamais `_family` (scan sur la sortie sérialisée) ;
  `resolveTarget` passe `validateSession` ; `keys(FAMILY_CLASS)` ≡ `FAMILIES`.
- **`session-selftest.mjs`** : `open` avec `target` valide → stocké ; `resume`
  conserve `target` ; `target` malformé rejeté (400 côté route, throw côté modèle).
- **`tools/selftest.mjs`** : une famille cible vole (profil appliqué via la
  cible, pas `?family=`) ; RSSI faible dégrade `link.out.quality` à
  distance/obstruction fixes vs RSSI fort.
- **`npm run build`** propre (`target-scan.js` bundlé).
- Run navigateur : scan → sélection → vol de la famille choisie ; `resume` d'une
  session `LANDED` rejoue la même cible sans re-scan.

## Hors périmètre

- Système de hack (PHASE 9+) — la fiche pré-hack ne révèle que
  `KNOWN`/`PARTIAL`/`UNKNOWN`.
- Target Log UI (PHASE 17) — mais `session.target` en est le socle de données.
- Révélation caméra / FOV / rates / batterie / état de vol.
- Système de rareté (`COMMON`/`RARE`/…) — ce sont des machines, pas du loot.
- Calibrage du couplage micro (tinywhoop retiré en PHASE 07) — issue de suivi
  existante.
