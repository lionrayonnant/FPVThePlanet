# PHASE 11 — Entry State

État : validé 2026-08-29.

Issue : https://github.com/lionrayonnant/FPVTP/issues/48
Sources : Bible / Roadmap PHASE 11.

## Objectif

Après `JACK IN`, le joueur découvre un drone **déjà en vol** — jamais posé,
jamais en hover neutre. Le hack (PHASE 09/10) et l'entry state sont
indépendants : n'importe quel type de hack peut retomber sur n'importe quelle
catégorie d'entrée.

```text
60%  COMFORTABLE   altitude confortable, espace dégagé, vitesse faible/modérée
25%  ACTIVE        mouvement clair, trajectoire déjà dynamique
12%  CHALLENGING   vitesse élevée, angle, turbulence, environnement exigeant
3%   HOLY SHIT     spectaculaire, mais récupérable
```

Le générateur empêche collision immédiate, spawn dans le terrain, géométrie
impossible — vérifié par simulation avant de rendre la main. Il ne protège
**pas** contre un mauvais choix météo ou de famille de drone : un `longrange`
lourd lâché à basse altitude par grand vent peut être dur, jamais injuste.

## État du dépôt à cette date

PHASE 09 (`phase-09-hacking`) et PHASE 10 (Control Vector / rituel JACK IN) ne
sont pas mergées sur `main` ; PHASE 10 n'a même pas de branche. PHASE 11 est
donc livrée comme **module autonome**, sur le modèle PHASE 07/08 : logique pure
testable headless, câblée dès maintenant sur le point de spawn/respawn réel de
`main.js`, sans attendre l'écran JACK IN. Quand PHASE 10 existera, son rituel
appellera la même fonction — aucune API à changer.

## Décisions transverses de cette spec

- **Position libre dans la scène**, pas seulement autour de `manifest.spawn` :
  le générateur échantillonne le bbox de la scène (déjà dans `manifest.json`,
  voir D1). C'est un vrai changement de comportement — jusqu'ici la position de
  spawn est fixe et indépendante de la cible.
- **Vérification par rollout physique headless**, pas seulement géométrique :
  réutilise `Physics`/`FlightController` tels qu'ils existent (aucun second
  moteur physique), sur le modèle du dry-run de `tools/tune-pid.mjs` et de
  l'instanciation directe de `Physics` par `tools/selftest.mjs`.
- **Throttle de la fenêtre de grâce = hover, pas 0.** Le rollout de validation
  simule sticks neutres avec le throttle à la fraction hover du profil
  (`hoverThrust(profile) / maxThrust(profile)`), pas au plancher. Un drone
  « déjà en vol » a un régime déjà proche de l'équilibre avant que le joueur ne
  touche quoi que ce soit ; simuler un throttle à 0 ferait chuter tout
  COMFORTABLE en air calme et invaliderait la catégorie elle-même. C'est un
  choix de conception, pas une mesure — à revoir si le ressenti en vol dément.
- **L'état présenté au joueur est l'état initial du candidat, jamais l'état
  post-rollout.** Le rollout ne fait que juger si le candidat aurait crashé ;
  il ne fait pas avancer le temps que le joueur va vivre.

## Architecture

### D1 — `src/entry-state.js` (nouveau) : logique + orchestration

Bundlé par Vite comme le reste de `src/`. Contrairement à `target-model.mjs`,
ce module a besoin d'un monde physique réel (raycast sol/obstruction, rollout)
donc il n'est pas un module "pur" au sens de PHASE 08 — il prend `physics` en
paramètre plutôt que de le construire.

```text
CATEGORIES = ['COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT']
WEIGHTS    = [60, 25, 12, 3]

RANGES = {
  COMFORTABLE: { aglM: [15, 40], speedMs: [2, 8],   tiltDeg: [0, 10],  rateDps: [0, 30]  },
  ACTIVE:      { aglM: [8, 25],  speedMs: [8, 18],  tiltDeg: [5, 25],  rateDps: [20, 90] },
  CHALLENGING: { aglM: [3, 12],  speedMs: [18, 30], tiltDeg: [20, 50], rateDps: [60, 200]},
  HOLY_SHIT:   { aglM: [1.5, 5], speedMs: [25, 40], tiltDeg: [40, 80], rateDps: [150, 400]},
}
```

Ces plages sont des valeurs de départ tapées à la main (comme les proportions
de `target-model.mjs`), pas mesurées — à ajuster au ressenti en vol, pas au
banc. Elles ne sont pas mises à l'échelle par famille de drone (pas de
"vitesse terminale" exportée aujourd'hui) : la marge de sécurité vient du
rollout, pas des plages elles-mêmes.

PRNG : même idiome `rngFrom(seed)` (FNV-1a → xorshift) que `target-model.mjs`
et `link.js`, dupliqué localement plutôt qu'importé (pas de dépendance
croisée `tools/` ↔ `src/`).

```text
pickCategory(rand) → 'COMFORTABLE' | 'ACTIVE' | 'CHALLENGING' | 'HOLY_SHIT'
  tirage pondéré sur WEIGHTS

sampleCandidate(category, manifest, physics, rand) → Candidate | null
  Candidate = { position: {x,y,z}, quaternion: {x,y,z,w},
                linvel: {x,y,z}, angvel: {x,y,z}, category }

  1. (x, z) uniforme dans manifest.bbox (marge de bord ~10 m pour ne pas
     spawner hors du maillage chargé).
  2. g = physics.groundBelow(x, z) ; null → candidat rejeté (pas de sol connu
     ici, ex. bord de scène).
  3. y = g + agl tiré dans RANGES[category].aglM.
  4. cap = heading aléatoire [0, 2π) ; tilt tiré dans tiltDeg, réparti
     aléatoirement entre pitch (montée/descente) et roll (virage, cf.
     l'exemple CHALLENGING du Roadmap) plutôt que toujours en pitch pur — la
     quaternion et le vecteur vitesse partagent la même direction, pas de
     vitesse orthogonale à l'assiette.
  5. speed tiré dans speedMs ; linvel = speed * direction(heading, pitch).
  6. angvel : magnitude tirée dans rateDps (°/s → rad/s), répartie
     aléatoirement entre les 3 axes (corps), signe aléatoire par axe.

generateEntryState({ physics, manifest, seed, maxAttempts = 20 }) → Candidate
  1. rand = rngFrom(seed)
  2. category = pickCategory(rand)
  3. pour i in [0, maxAttempts) :
       c = sampleCandidate(category, manifest, physics, rand)
       si c && geometrySafe(c, physics) && rolloutSafe(c, physics) : return c
  4. repli garanti : COMFORTABLE ancré à manifest.spawn, agl bas de plage,
     vitesse/tilt/rate à zéro — trivialement sûr, identique au spawn actuel.

geometrySafe(c, physics) :
  - hauteur au sol directement sous c.position ≥ 1 m (marge sphère 0.15 m +
    coussin) — déjà garanti par construction (étape 3 ci-dessus) mais
    re-vérifié après un éventuel ajustement.
  - obstructionBetween(c.position, c.position + linvel_dir * 15m) :
    pas de `blocked` avec `span` franc (> 2 m) sur les 15 premiers mètres du
    vecteur vitesse — un survol tangent d'un rebord est accepté, un mur plein
    non.

rolloutSafe(c, physics) :
  - Snapshot de l'état réel du corps physique (position/rotation/vitesses).
  - Applique c au corps (`body.setTranslation/setRotation/setLinvel/setAngvel`).
  - Construit un `FlightController` neutre (mode 'acro', sticks à 0, throttle
    = hoverThrust(profile)/maxThrust(profile)) — profil = `physics.profile`.
  - Step 1.0 s à `physics.world.timestep` (250 pas), sticks neutres constants.
  - Échec si un impact de contact dépasse le seuil de crash partagé (D2) à
    un moment quelconque du rollout.
  - Restaure l'état réel du corps depuis le snapshot (le rollout ne doit
    laisser aucune trace sur l'état interactif).
```

### D2 — Seuil de crash partagé

`CRASH_IMPULSE` / `CRASH_IMPULSE_FLAT` sont aujourd'hui des constantes privées
de `src/main.js`. Extraites vers `src/quad.js` (où vivent déjà les autres
constantes physiques) et exportées ; `main.js` et `entry-state.js` importent
la même paire. Pas de duplication de seuil entre le jeu et le générateur.

### D3 — Câblage `src/main.js`

- `respawn()` : remplace l'appel `physics.reset()` par :
  ```js
  const entry = generateEntryState({ physics, manifest, seed: randomSeed() });
  physics.applyEntryState(entry);   // voir D4
  ```
  Le reste de `respawn()` (link/rain/fog reset, PID clear, `crashed = false`)
  est inchangé.
- Mode `?scene=` (dev) : comportement inchangé dans son intention (respawn
  local sans retour au terminal) mais passe maintenant par l'entry state comme
  le flux normal — pas de branche séparée qui resterait un spawn figé.
- Touche `r` (respawn manuel) : même chemin.
- Ouverture de session (premier vol, avant tout respawn) : même appel, exécuté
  juste après `new Physics(...)` dans `boot()`, avant la première frame rendue
  — le joueur ne voit jamais l'état `manifest.spawn` brut.

### D4 — `src/physics.js`

Nouvelle méthode, à côté de `reset()` :

```js
applyEntryState({ position, quaternion, linvel, angvel }) {
  this.body.setTranslation(position, true);
  this.body.setRotation(quaternion, true);
  this.body.setLinvel(linvel, true);
  this.body.setAngvel(angvel, true);
  this.propulsion.reset();
  this.wind.reset();
  this._agl = null; this._aglCounter = 0; this._windCounter = 6;
  this._probed = false; this._groundHold = false; this.airspeed = 0;
}
```

Reprend le corps de `reset()` sans forcer `IDENTITY`/`ZERO` ni relire
`this.spawn`. `reset()` reste tel quel (encore utilisé par le constructeur et
par tout appelant qui veut explicitement le spawn figé, ex. bancs de test
existants qui ne doivent pas changer de comportement).

### D5 — `tools/entry-state-selftest.mjs` (nouveau)

Sur le modèle de `tools/selftest.mjs` : lit `collision.bin` + `manifest.json`
d'une scène réelle (`tour-eiffel` par défaut) via `fs`, instancie `Physics`.

- 100 tirages `generateEntryState` (graines différentes déterministes) :
  - aucun ne finit en crash dans la seconde de rollout (déjà garanti par
    construction, ce test vérifie l'absence de régression / de bug dans le
    rollout lui-même en le rejouant une seconde fois côté test) ;
  - aucun `position.y` sous le sol local (`groundBelow` au point exact) ;
  - `category` mesurée sur un grand échantillon (ex. 5000 tirages, sans
    rollout pour la vitesse) proche de 60/25/12/3 (tolérance ±3 points).
- Cas repli : force `maxAttempts = 0` → vérifie que le résultat est le
  candidat de repli ancré à `manifest.spawn`.
- Chaîné dans `npm run selftest` (comme le reste des checks scène-dépendants).

## Séquencement (ordre d'implémentation)

1. `src/quad.js` : extraire `CRASH_IMPULSE`/`CRASH_IMPULSE_FLAT`, `main.js`
   importe au lieu de définir (aucun changement de comportement, à vérifier
   par `selftest.mjs` avant de continuer).
2. `src/physics.js` : `applyEntryState()`.
3. `src/entry-state.js` : `pickCategory`, `sampleCandidate`, `geometrySafe`,
   `rolloutSafe`, `generateEntryState` (TDD, dans cet ordre).
4. `tools/entry-state-selftest.mjs`.
5. Câblage `main.js` (D3).
6. Vérif : `npm run selftest`, `npm run selftest:operator`, `npm run build`,
   run navigateur (JACK IN dev via `?scene=`, plusieurs respawns `r`,
   observer les 4 catégories apparaître).

## Tests

- **`tools/entry-state-selftest.mjs`** : voir D5.
- **`tools/selftest.mjs`** : inchangé dans ses assertions existantes (le
  spawn de test lui-même reste `manifest.spawn` via `reset()`, pas affecté par
  D3) ; vérifie en plus que `CRASH_IMPULSE`/`CRASH_IMPULSE_FLAT` importés de
  `quad.js` valent les mêmes constantes qu'avant l'extraction.
- **Run navigateur** : respawns répétés affichent des positions/assiettes
  variées, jamais de spawn dans le sol ni de crash instantané non provoqué.

## Hors périmètre

- L'écran JACK IN lui-même et son rituel (PHASE 10) — ce module expose juste
  la fonction qu'il appellera.
- Mise à l'échelle des plages par famille de drone (pas de "vitesse
  terminale" exportée aujourd'hui) — issue de suivi si le ressenti par famille
  le justifie.
- Biais géométrique explicite "proche d'un obstacle" pour CHALLENGING/HOLY
  SHIT (la spec s'appuie sur le rejet du rollout plutôt que sur un
  échantillonnage dirigé) — peut être affiné plus tard sans changer l'API.
- Lien avec la position de la cible choisie au TARGET SCAN (PHASE 08) —
  aujourd'hui la cible ne porte pas de position dans le monde ; hors périmètre
  tant que ce n'est pas le cas.
