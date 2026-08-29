# Handoff — POC simulateur de drone FPV (Paris / Tour Eiffel)

État au 2026-08-27, réorganisé le 2026-08-29. Écrit pour reprendre le travail
sans redériver le contexte.

Ce fichier ne garde que **l'état courant**. Les récits de session détaillés —
pourquoi chaque sous-système est comme il est, ce qui a été mesuré, les pièges
rencontrés — sont dans `docs/handoff-archive/`. Les y lire seulement quand on
touche au sous-système concerné.

| fichier | contenu |
|---|---|
| [pipeline-cartes.md](docs/handoff-archive/pipeline-cartes.md) | GUI d'ajout de cartes, prep d'origine, passage au multi-cartes, support HEIC |
| [modele-de-vol.md](docs/handoff-archive/modele-de-vol.md) | `quad.js` / `flightController.js`, le banc `tune-pid` |
| [son.md](docs/handoff-archive/son.md) | synthèse Web Audio depuis les quatre moteurs, fatigue auditive |
| [rendu-fpv.md](docs/handoff-archive/rendu-fpv.md) | `lens.js` (optique), lien vidéo RSSI par raycast |
| [meteo.md](docs/handoff-archive/meteo.md) | vent, pluie, gouttes sur la lentille, brouillard |
| [bugs.md](docs/handoff-archive/bugs.md) | les 10 bugs du POC et la méthode qui les a trouvés |

## Statut : ça vole

Le POC fonctionne de bout en bout, vérifié à la fois en headless (SwiftShader)
et sur le vrai GPU de l'utilisateur (AMD RX 9060 XT) via MCP chrome-devtools,
manette EdgeTX réelle branchée et détectée.

Les textures étaient fausses (motifs retournés, larges plaques grises) : c'était
un seul bug, l'axe V des UV, corrigé — voir [handoff-archive/bugs.md](docs/handoff-archive/bugs.md) n°9. **La « limite connue » sur
les façades grises que décrivait une version précédente de ce document n'existe
pas** ; c'était ce bug.


## Comment reprendre

```bash
cd sim
npm install          # si node_modules absent
npm run dev           # http://localhost:5173 — terminal opérateur (PHASE 02), puis vol
                      #   ?scene=<slug> saute le terminal (dev)
npm run selftest      # 15 vérifications sans navigateur (scène tour-eiffel par défaut)
npm run selftest:operator  # état opérateur, terminal, météo du monde — pur, sans réseau
```

Deux cartes prêtes à l'emploi dans `public/scenes/` (gitignored, ~900 Mo à
deux) : `tour-eiffel` et `ile-de-la-cite-et-ile-saint-louis`. Pour en ajouter
une autre : `npm run add-map -- "Nom" <lat> <lon>` — voir `README.md` section
« Ajouter une carte » pour le détail des options et le dimensionnement de
`--radius`.

Plan d'origine (contexte de la décision d'architecture) :
`/home/user/.claude/plans/j-ai-une-carte-de-flickering-cat.md`


## Vérifié

- `npm run selftest` : **158/158 PASS** (géodésie, sol, collision/CCD, textures,
  lien vidéo, pluie/brouillard, météo, + la boucle enveloppe de vol / propulsion
  sur les six familles PHASE 07). Les deux checks textures mesurent 14,7 |dRGB|
  et 0,8 % de gris.
- **PHASE 07 — génération des cibles (couche physique)**, branche
  `phase-07-generation-cibles`, vérifié headless :
  - `src/drone-profiles.js` : 6 familles (`freestyle5` = valeurs `quad.js`
    d'origine au bit près ; `race5`, `cinewhoop`, `longrange`, `heavy5`,
    `toothpick`/label `MICRO`). `QUAD` = profil par défaut ; `quad.js`,
    `flightController.js`, `physics.js`, `audio.js`, `main.js` prennent le
    profil en argument.
  - PID **mesurés par famille** via `node tools/tune-pid.mjs --write all`
    (jamais à la main) ; `npm run tune` : 34/36 combos axe·famille dans les
    cibles strictes du banc, reste `longrange` roll/pitch à rise 74 vs
    68-71 ms (~9 %, cruiseur calme à 360 °/s).
  - `freestyle5` inchangé à la valeur près : `selftest` rend hover 24 %, roll
    822 °/s, vitesse terminale 15,4 m/s comme avant.
  - Bug du banc `tune-pid` corrigé (attitude intégrée passée au contrôleur →
    oscillation fantôme, divergente pour une boucle micro) : le banc passe
    `rotation: IDENTITY`.
  - **Non vérifié en vol piloté** : le ressenti réel de chaque famille. Le
    tinywhoop 1S a été prototypé puis **retiré** — à ~34 g le couplage
    roll/pitch/yaw du modèle n'est pas calibré ; issue de suivi.
  - **Pour tester une famille en vol** (en attendant la sélection de cible,
    PHASE 08) : `npm run dev` puis
    `http://localhost:5173/?scene=tour-eiffel&family=<nom>` avec `<nom>` =
    `freestyle5` `race5` `cinewhoop` `longrange` `heavy5` `toothpick`. Une
    famille par chargement de page (pas de bascule en vol). `__sim.debug().family`
    confirme laquelle est chargée.
- **PHASE 08 — target scan (issue #45), vérifié**, branche
  `phase-08-target-scan` = `main` + merge `phase-06-impl` + merge
  `phase-07-generation-cibles`.
  - Conflit de tuning révélé par le merge : le collider de PHASE 06 (`restitution
    0.05` / `friction 1.0`, mesuré sur `freestyle5` seul) croisé avec le sweep 6
    familles de PHASE 07 faisait déraper le `toothpick` à 1,55 m/s au sol
    (> seuil `sits still` de `selftest.mjs`). Re-balayé rest×fric contre le
    selftest tour-eiffel → **`restitution 0.15` / `friction 1.0`** : toothpick à
    0,99 m/s, toutes familles vertes, `a gentle landing` à 483 N. `physics.js`.
  - Vérifié headless : `target-selftest.mjs` (74 tests), les cas cible de
    `session-selftest.mjs` (14 tests) et `session-route-selftest.mjs` (2),
    le cas dégradation RSSI faible de `link.js` dans `selftest.mjs`, et le
    nouveau cas `toute cible résolue pointe un profil de vol` (`resolveTarget().family`
    ∈ `PROFILES`, 5 seeds × 5 candidats). `selftest:operator` +
    `selftest.mjs` (158 checks, 6 familles) + `build` tous verts sur la
    branche mergée.
  - Vérifié navigateur (MCP chrome-devtools, GPU réel, serveur de dev) :
    - `LOCAL TERRAIN` → `[ OPEN ]` : **TARGET SCAN** s'affiche, 4 signaux
      (fallback sans densité persistée), triés RSSI décroissant
      (-53/-65/-71/-72). `↑`/`↓` déplacent le curseur ; `Enter` → fiche
      pré-hack `TARGET 03 · LOCATION KNOWN · SIGNAL -71 dBm · DEVICE PARTIAL
      (EST. 5") · VIDEO PARTIAL (EST. ANALOG) · CONTROL/FLIGHT STATE UNKNOWN`
      — **aucune** famille / caméra / rates / batterie.
    - Fiche ouverte : l'écran liste passe en `display:none`, ses touches
      deviennent inertes, pas d'empilement (correctif Task 5).
    - `CONFIRM` → vol : `__sim.debug().family` = `heavy5` (candidat choisi),
      `__sim.session().target` = descripteur complet régénéré côté serveur
      (`heavy5`, signal -71 dBm ANALOG, intel figé), `__sim.debug().link.rssiDbm`
      passe de -35 (sans cible) à -56,7 — le RSSI annoncé décale bien le lien.
    - Session `LANDED` → terminal `LAST SESSION` → `RESUME SESSION` :
      **pas** de nouveau TARGET SCAN, `family` = `heavy5` (relu depuis
      `operator.sessions`), lien ré-armé à -56,6, `resumeCount` = 1.
    - `?scene=tour-eiffel` (dev) : pas de TARGET SCAN, `__sim.session().target`
      = `null`, `linkRssi` = -35. Console sans erreur ni warning sur les trois
      parcours.
  - **Non vérifié** : le ressenti de vol par famille en pilotage réel
    (déjà noté PHASE 07). Densité→count non exercée au navigateur (aucun
    terrain acquis n'avait de `signalDensity` ; fallback 4 confirmé).
  - **Changement cassant** : renommer ou retirer une famille de
    `drone-profiles.js` casse les sessions déjà stockées — `validateSession`
    → `sanitizeTarget` rejette (400) un `RESUME` dont la `target.family`
    n'existe plus, et un profil inconnu retombe silencieusement sur le
    profil par défaut.
  - **Plafond de l'archi A** : le modèle est bundlé côté client et la graine
    est tirée côté client — `_family` est lisible en devtools, les graines
    explorables hors-ligne. « Non falsifiable » vaut pour la cohérence des
    stats (le serveur fait autorité sur le candidat choisi), pas contre un
    joueur qui veut voir à travers le brouillard.
- **PHASE 09 — hacking documentaire (issue #46)**, branche `phase-09-hacking`.
  - `hackType` est une propriété de cible : `HACK_TYPES` (6 familles) dans
    `tools/target-model.mjs`, `_hackType` tiré par candidat (seedé, **indépendant**
    de la famille, du RSSI et de la difficulté du vol), sorti par `resolveTarget`
    et validé/persisté par `sanitizeTarget` (`tools/session-model.mjs`).
  - `src/hack.js` `runHack()` : écran AUTOMATED ANALYSIS, **phase automatique
    progressive** (`tools/hack-model.mjs` `hackSequence()` : tête fixe +
    2 beats propres à la famille + queue fixe, chacun avec un dwell où les
    points se remplissent avant que le verdict claque), motif ASCII animé par
    famille (`src/hack-grammars.js`, purement décoratif, aucun `Math.random`).
    Fige sur `MANUAL OVERRIDE REQUIRED` + `[ JACK IN ]` **placeholder** (Enter
    et le bouton résolvent tous deux ; armés seulement après la séquence ;
    teardown complet). Câblé dans `chooseScene` après `runTargetScan`,
    **session fraîche uniquement** (pas au `resume`). Hook debug
    `?hack=<type>` sur les chemins `?scene=` / `?family=`.
  - **Le hack couvre le chargement de fond** (retour utilisateur 2026-08-29) :
    branche session fraîche, `boot()` est lancé sans être attendu dès que le
    TARGET SCAN répond, et sa promesse passe à `runHack({ready})`. Le joueur
    regarde la phase automatique (~6 s scriptées même cache chaud : tête 1,2 s
    + 2 beats 0,85 s + queue 1,1 s + attente 0,5 s + culmination du motif
    0,6 s) pendant que la carte charge derrière ; si le chargement traîne, le
    log reste en état d'attente (points qui pulsent, motif en « recherche »)
    jusqu'à ce qu'il finisse. Au `[ JACK IN ]`, le vol est déjà prêt. Si
    `boot()` échoue pendant le hack, l'écran se démonte et l'erreur remonte à
    `hud.fail` (comme avant). Chemins `?scene=`/`?family=`/`resume` : pas de
    chargement de fond, séquence scriptée seule.
  - **Revue de sûreté faite** (git diff relu ligne à ligne, deux fois : à
    l'implémentation initiale et après l'ajout des beats). Log = uniquement les
    labels/verdicts du `hackSequence()`, testés contre une liste blanche de
    vocabulaire d'ambiance (`HACK_VOCAB`, `hack-selftest.mjs`). Aucun `draw*` ne
    décrit une étape réelle (rectangles / sinus / hex de bruit déterministe ;
    les « adresses » du dump mémoire sont un compteur qui boucle à 0xffff, les
    zones « injectées » sont des segments de sinusoïde qui rejoignent la trace
    à la culmination). Aucun outil nommé, aucun CVE / exploit / payload, aucun
    commentaire-recette. RAS.
  - **Vérifié** : `npm run selftest` (158 checks), `npm run selftest:operator`
    (dont `hack-selftest.mjs`, 8 tests), `npm run build` — tous verts. Rendu
    headless de la séquence complète (screenshots à intervalles croissants) :
    dots qui se remplissent étape par étape, verdicts qui claquent, motif qui
    culmine à l'approche de `[ JACK IN ]` (paquets qui s'alignent, porteuse qui
    verrouille en `#`, réticule GNSS qui revient à l'origine, dump mémoire qui
    se stabilise, nœuds tous tenus), `[ JACK IN ]` qui n'apparaît qu'après la
    séquence complète — les six familles vérifiées.
  - **Non vérifié** : le ressenti subjectif (durée perçue, cadence des beats,
    lisibilité sur un vrai écran) ; le clic `[ JACK IN ]` → transition vol (non
    exercé headless, mais tracé par revue de code : chemin de résolution unique) ;
    l'état d'attente (chargement plus long que la séquence scriptée) pas vu en
    vrai — seulement tracé dans le code ; `MANUAL OVERRIDE REQUIRED` n'a pas
    d'emphase typographique ; l'espacement du motif `firmware-override` est plus
    lâche que les autres (cosmétique) ; l'écran de hack n'est **pas rejoué au
    `resume`** (le `hackType` est relu du disque pour le futur TARGET LOG,
    PHASE 17, mais pas remis en scène).
  - Le rituel réel (`CONTROL VECTOR` + QTE) est PHASE 10.
- **PHASE 10 — Control Vector + rituels (issue #47)**, branche
  `phase-10-control-vector`.
  - Remplace le `[ JACK IN ]` placeholder de PHASE 09 : `src/hack.js` `arm()`
    appelle désormais `runRitual()` (`src/ritual.js`) avec le
    `operator.controlVector` courant (`ritualVector()`,
    `tools/ritual-model.mjs` — retombe sur un vecteur de secours fixe pour les
    chemins dev sans opérateur, sans jamais toucher l'opérateur réel).
  - Saisie clavier (flèches) + manette (`src/gamepad-dir.js`, extrait de
    `bootstrap.js` — même fonction, plus dupliquée). Un mauvais input à
    n'importe quel index vide le tampon et repart de zéro (`ritual-shake`,
    aucune pénalité, conforme au critère d'acceptation).
  - Culmination : `pickVariant(seed)` tire `V1..V4` (1-4 s, `tools/ritual-model.mjs`,
    même seed que le motif d'analyse → rejeu stable via `?hack=`). 8 primitives
    ASCII composables dans `src/hack-grammars.js` (`RITUAL_PRIMITIVES`),
    2-3 pondérées par famille (`FAMILY_PRIMITIVES`) — pas 24 séquences écrites
    à la main. Couleurs réservées cyan/magenta/violet/bleu électrique
    (`.ritual-burst--*`, `src/style.css`), nulle part ailleurs dans le jeu.
  - `CONTROL ACQUIRED` (400 ms fixe) puis résolution — `main.js` inchangé,
    `runHack()` résolu = vol immédiat, déjà le cas depuis PHASE 09.
  - **Vérifié** : `tools/ritual-selftest.mjs` (10 tests), `tools/hack-selftest.mjs`,
    `npm run selftest`, `session-selftest.mjs`, `operator-selftest.mjs` — tous
    verts. Vérif navigateur via MCP chrome-devtools sur les **six familles**
    (`?hack=<type>&scene=`) : saisie clavier correcte → culmination →
    `CONTROL ACQUIRED` → vol (HUD actif, sticks en main, aucun écran
    intermédiaire), aucune erreur console ; un mauvais input vide bien le
    tampon sans pénalité (vérifié sur `FIRMWARE OVERRIDE`).
  - **Non vérifié** : manette réelle (logique partagée avec `bootstrap.js`,
    déjà vérifiée en conditions réelles pour la définition du vecteur, mais pas
    rejouée ici) ; ressenti subjectif du rythme des variantes (V1 vs V4) sur un
    vrai écran ; un vrai `operator.controlVector` non vide (la vérif navigateur
    a couru sur le vecteur de secours, faute d'opérateur bootstrappé sur
    `?scene=` seul — le code passe par le même `ritualVector()`/`checkInput()`
    testés en pur par le selftest, mais pas vu bout en bout avec un opérateur
    réel).
  - Identité sonore des rituels (Bible §36) : hors périmètre, follow-up.
- **PHASE 14 — fin de vol : crash, pose, sortie manuelle** (issue #58).
  - Machine à états `flightEnd` (`src/flight-end.js`) orchestrant les trois voies
    de fermeture : crash (impact > `CRASH_IMPULSE`), pose (vitesse ≤ 0,5 m/s,
    immobilité angulaire ≤ 10 rad/s, sol contact ≥ 0,8 s), sortie manuelle
    (désarmement à la manette `j` ou `ESC`). Appel une fois par frame depuis
    `main.js` ; génère une **fenêtre temporelle unique** `out.closes` bel et bien
    lue une seule fois.
  - Séquence crash (timings mesurés sur Rapier/tour-eiffel) : dégradation d'image
    avant texte (`fadeOutFrames` = 50 ms, les ~3 premiers frames), noircissement
    (« fade out ») puis lignes : `LINK LOST` → `TARGET LOST` → `SESSION
    TERMINATED` → `[ESC] DISCONNECT`, puis sortie `main.loop()`. `R` et `ESC`
    prématuré inopérants.
  - Détection de pose (`tools/landing-model.mjs` `isLanding()`) : seuils mesurés
    en simulation Rapier, huit cas de pose réelle (rebonds, roulé) et dix cas
    faux positifs en rasant (toutes les combinaisons 3 hauteurs × 3 tangage +
    stationnaire bas). **Aucun faux positif rasant accepté**.
  - **Vérifié en headless** :
    - `tools/flight-end-selftest.mjs` : 17 tests couvrant tous les chemins (impact
      → crash, pose, pose+désarmement, redécollage, crash pendant pose,
      carcasse au sol), timing de la séquence, seuils de crash/pose, compteurs
      réinitialisés à chaque rebond, `out.closes` lu une unique fois.
    - `tools/landing-selftest.mjs` : 8 poses reconnues, 10 rasants rejetés (noms,
      durées, hauteurs mesurées). Mesures : pose depuis 1 m reconnue à t=0,82 s ;
      rasant 0,3–1 m tous rejetés.
    - `npm run selftest` reste vert (« all checks passed »), `npm run selftest:operator`
      passe l'intégralité (30 tests de tous les modules précédents + nouveaux tests
      ci-dessus). `npm run build` OK.
  - **Non vérifié** : ressenti visuel de la mort d'image (lisibilité du dégradé,
    rythme perçu de noircissement puis texte), ressenti des faux positifs en vol
    rasant réel (le critère d'acceptation de l'issue #51 demande « jamais » en
    rasant à moins d'un mètre à pleine vitesse — testé simulé, pas en vol piloté),
    geste de désarmement à la manette (logique en pur testée, l'input clavier
    couverte en PHASE 10, mais manette réelle non rejouée).
  - Structure du code : `FlightEnd` classe inerte (pas de side-effect), appelée à
    chaque frame, retourne un objet muable `out` ; `out.closes` ne s'arme que
    lorsqu'il est temps de fermer. `main.js` le lit une fois par frame et le
    traite immédiatement. Cette structure élimine les races (un `closes` ne peut
    pas être manqué ou vu deux fois).
- Rendu réel sur GPU utilisateur (RX 9060 XT, ANGLE/radeonsi) : **5 draw calls,
  3 742 191 triangles**, coût GPU **1,68 ms/frame** à 256 px (mesuré par sync
  `readPixels` ; c'était ~1 ms à 128 px). Large marge sur un budget de 10 ms.
- Chargement complet : **~2,7 s**, dont `chunks` 1,05 s, `collision-build`
  1,30 s, `gpu-upload` 0,24 s pour 1,65 Go.
- Manette EdgeTX Radiomaster Pocket détectée et mappée correctement en
  conditions réelles.
- **GLOBAL SCANNER (PHASE 03)**, vérifié en direct via MCP chrome-devtools sur
  le serveur de dev : recherche Nominatim, cadrage, rectangle Geoman, grille de
  tuiles réelle, `PROBE AREA` (plan Go + échantillon : « 27 tiles came back »),
  `ACQUIRE AREA` (pipeline complet, 100 tuiles, 9 Mo sur disque), puis `[ FLY ]`
  qui charge la carte fraîchement acquise (3 draw calls, 118 011 triangles,
  100 fps). La carte d'essai a été supprimée après coup.
- **PHASE 04 — monde persistant / météo** (issue #41), vérifié en headless
  (chromium isolé + CDP, le profil du MCP étant pris par une autre session) :
  - `npm run selftest` reste vert (« all checks passed »), `selftest:operator`
    passe 30 tests météo + les précédents ;
  - vraie acquisition Open-Meteo sur Tokyo et Paris, snapshotée dans
    `worldState.weather[zone]` ; le second appel sur la même zone le même jour
    relit le fichier sans toucher au réseau (même `fetchedAt`) ;
  - le panneau `Tab` ne contient plus que manette / caméra / objectif / lien
    vidéo / son — aucun contrôle météo, aucune clé `fpvmaps.wind*|rain|fog` ;
  - vol sur `?scene=triomphe` : `__sim.debug().world` rend
    `{zone 48.87,2.30, open-meteo, LIGHT RAIN, confiance 0,96}`, le vent à 10 m
    vaut 6,85 m/s et la pluie 0,66 mm/h, la visibilité passe de 2035 m à 1883 m ;
  - repli hors ligne : `worldWeather()` rend un bulletin `procedural`
    déterministe, identique entre deux instances du module.
- Captures MCP chrome-devtools au ras du sol (piste d'athlétisme du stade Émile
  Anthoine, Champ-de-Mars, façades) : textures à l'endroit, lisibles, aucune
  plaque grise. `take_screenshot` du MCP capture bien le canvas WebGL, contrairement
  au `page.screenshot()` de puppeteer utilisé lors de la session précédente.
- **PHASE 05 — acquisition de terrain / cache** (issue #42), vérifié en direct
  contre le vrai pipeline (petite bbox réelle, config Flyover copiée dans un
  worktree dédié, jamais commitée — gitignorée) :
  - `addMap()` découpe désormais la conversion en deux phases réelles, `decode`
    puis `rebuild` (détectées dans le stdout de `prep.mjs`, sans y toucher —
    voir `parsePrepLine` dans `tools/lib/add-map-core.mjs`) ; le scanner en
    tire quatre barres honnêtes (TERRAIN/FETCH/DECODE/REBUILD — `pipelineBars`
    dans `tools/scanner-model.mjs`), REBUILD ayant un vrai ratio de chunks,
    DECODE restant indéterminé faute de jalon intermédiaire dans le flux actuel ;
  - bug trouvé et corrigé pendant ce test : `prep.mjs` groupe ses grands nombres
    avec `toLocaleString()` sans locale explicite, donc avec le séparateur ICU
    du runtime qui l'exécute (ici une espace fine insécable U+202F, pas une
    virgule) — les regex de `parsePrepLine` acceptent maintenant les deux ;
  - deuxième bug trouvé et corrigé : une connexion SSE tardive sur un job déjà
    terminé (rechargement de page après la fin de l'acquisition) rejouait un
    `done` reconstruit à la main, sans `slug`/`bytes`/`stats` — l'écran TERRAIN
    ACQUIRED n'avait alors plus de quoi proposer KEEP/REMOVE. Le job garde
    maintenant son événement terminal réel (`job.final`) et le rejoue tel quel ;
  - `POST /__operator/:id/terrain-cache` (KEEP TERRAIN) testé en direct : relit
    `scenes.json` côté serveur (le client n'envoie que le slug), rejette un slug
    inconnu (404), écrit dans `terrainCache` de l'opérateur ; `DELETE
    /__map-api/scenes/:slug?raw=1` (REMOVE TERRAIN) réutilisé tel quel ;
  - non fait dans cette phase : les logs RTC (`tools/rtc-model.mjs`) et le
    bouton `LEAVE` (quitter l'écran d'acquisition sans l'annuler, le job
    continue côté serveur) sont écrits et couverts par selftest, mais jamais
    vus dans le navigateur — voir « Non vérifié » ci-dessous ;
  - `add-map.html` / `tools/map-gui/` n'ont pas été supprimés : ils portent
    encore `quality`/`cell`/`--force`, que le scanner n'expose pas — à trancher
    avec l'utilisateur avant de les retirer.

- **PHASE 06 — modèle de session** (issue #43), vérifié sans navigateur :
  `npm run selftest` reste vert (« all checks passed »), `selftest:operator`
  passe 11 tests session en plus des précédents, `npm run build` OK.
  - une session est tenue en mémoire client pendant le vol (`src/session.js`),
    deux écritures réseau : `POST /__operator/:id/sessions` (squelette PENDING) à
    l'ouverture, `PATCH .../sessions/:sid` (verdict + télémétrie agrégée +
    randomart) à la clôture ;
  - verdicts : `LANDED` (désarmement Betaflight `throttle` bas + `yaw` plein
    gauche 0,5 s, ou touche `j`, alors que le drone est au sol et immobile —
    drone conservé, session ré-ouvrable via LAST SESSION → RESUME SESSION) ;
    `CRASHED` (impact > `CRASH_IMPULSE`, ou désarmement en vol → chute → impact,
    ou onglet mort → réconciliation `PENDING`→`CRASHED` au `GET /__operator/:id`) ;
  - après un `CRASHED`, `r` renvoie au terminal au lieu de respawn en place
    (sauf `?scene=` dev) ;
  - logique pure dans `tools/session-model.mjs` + `tools/randomart.mjs`
    (drunken-bishop déterministe sur `sha256(sessionId)`).
  - **Non vérifié en vol réel** : ouverture/clôture de session et agrégats de
    télémétrie jamais éprouvés dans le navigateur avec un vrai vol ; le geste de
    désarmement à la manette non plus.

## Non vérifié / à faire

- **PHASE 14, en vol piloté** : ressenti du dégradé d'image avant crash (vitesse
  de noircissement), lisibilité de la séquence texte (taille, rythme), absence
  de faux positif de pose en rasant réel (vol à moins d'un mètre du sol à pleine
  vitesse — simulé OK, navigation réelle non faite). Geste de désarmement à la
  manette (clavier couvert en PHASE 10, manette réelle non testée dans ce
  contexte).
- **PHASE 05, dans le navigateur** : les quatre barres, le bloc GEOMETRY/
  TEXTURES, les barres décoratives RF ANALYSIS/TARGET SEARCH, le flux RTC et
  l'écran TERRAIN ACQUIRED → KEEP/REMOVE ont été vérifiés côté logique pure
  (`scanner-selftest.mjs`, `rtc-selftest.mjs`) et côté API (`curl` + SSE brut),
  jamais rendus à l'écran ni cliqués.
- **PHASE 05, rechargement pendant la fenêtre KEEP/REMOVE** : si la page est
  rechargée après `done` mais avant que l'opérateur choisisse KEEP ou REMOVE,
  le scanner rouvert ne rejoue pas cet écran (il ne rattrape que les jobs
  encore `running`) — le terrain reste sur disque et dans `scenes.json`, mais
  hors de `terrainCache` tant qu'il n'est pas gardé explicitement.

- **Le scanner sur une zone hors couverture Flyover** : le chemin `columns === 0`
  et le grisé des colonnes élaguées (`prunedBands`) sont testés unitairement,
  jamais vus en vrai — toutes les zones sondées à la main étaient couvertes.
- **Ressenti de pilotage réel** (l'utilisateur n'a pas encore volé "pour de
  vrai" avec retour subjectif sur l'acro, les rates, l'expo).
- **Écran de réglages manette** (Tab, remapping avec barres de niveau) —
  code écrit, jamais testé interactivement par l'utilisateur.
- Modes `angle` et `altitude` du contrôleur de vol — testés uniquement par
  construction du code, pas en vol piloté.
- L'état opérateur (`/__operator`) n'existe que sous le serveur de dev ; exposer
  ce serveur (p. ex. via `vite.ngrok.config.js`) expose aussi l'état opérateur.
- **Météo : ressenti en vol jamais éprouvé.** La chaîne est vérifiée bout en
  bout, mais personne n'a encore volé un jour de vent fort ou de brouillard réel
  pour dire si les valeurs qu'Open-Meteo renvoie donnent une expérience juste.
  C'est un arbitrage de ressenti, pas un bug — il se règle dans
  `toSimParams()` (`tools/lib/weather.mjs`), un seul endroit.
  - 2026-08-29 : premier arbitrage posé — `WIND_GAIN = 0.75` dans `src/wind.js`
    (vent ressenti à -25 %, tout suit : rafales, turbulence, updraft). La
    prévision de l'Operator Terminal (`nominal`) n'est PAS nerfée, elle reste la
    vraie météo. Valeur à réviser au premier vrai retour de pilotage.
- **HUD météo trop discret** : au lancement d'un vol on ne pense pas aux
  conditions. À rendre plus saillant sur la fiche opérateur (retour utilisateur
  2026-08-29). Non fait.
- Le bloc **Lien vidéo** est resté dans le panneau `Tab`. La Bible §31 le range
  avec la météo du côté du monde, mais l'issue #41 ne le demande pas : à sortir
  dans une phase ultérieure.

## Le seul arbitrage restant : la résolution

Ce n'est pas le gris (voir [handoff-archive/bugs.md](docs/handoff-archive/bugs.md) n°9), c'est la finesse. Mesuré sur la géométrie :
853 m² de surface par matériau pour ~50 % d'une texture 512², soit **12,6
texels/m (8 cm/texel) au plafond de la source**. Le pipeline tourne à 256 px de
cellule, soit 6,3 texels/m (16 cm/texel) pour 1,65 Go de VRAM.

Aller au natif coûte cher : chaque doublement de `--cell` quadruple la VRAM.
`--cell 512` en RGBA8 demande ~6,6 Go, ce qui passe sur 16 Go mais sans marge.
La vraie sortie serait la compression BC1 (natif à ~830 Mo de VRAM), au prix
d'un encodeur DXT1 et d'une chaîne de mips à écrire dans `prep.mjs` et de
~620 Mo de binaire à servir. À trancher seulement si 16 cm/texel gêne
réellement en vol.

## Leviers de secours si besoin

- `npm run prep:light` : cellules 128px au lieu de 256 (VRAM 1,65 Go → 413 Mo,
  résolution 6,3 → 3,2 texels/m) — à garder en réserve pour une machine plus
  faible. `--cell` accepte n'importe quelle valeur : les planches restent
  plafonnées à 4096² et le nombre de planches par chunk s'ajuste tout seul.
- Paramètres d'URL de debug (voir `src/main.js`, `OPTS`) :
  `?mipmaps=0` (coupe la génération de mipmaps), `?chunks=N` (charge N
  chunks au lieu de 5), `?aniso=0`, `?collision=0`.
- `window.__sim` dans la console navigateur : `.debug()`, `.teleport(x,y,z)`,
  `.lookAt(x,y,z)`, `.timeline`, `.physics`, `.controller`, `.input`, `.audio`,
  `.setWeather({speed, direction, gust, turbulence})`,
  `.setRain({intensity, variability})` (0..1 chacun ; intensité 1 = 25 mm/h),
  `.setFog({intensity, variability})`, `.weather()` (le snapshot du monde).
  Depuis PHASE 04 ce sont les **seuls** moyens de changer le temps qu'il fait :
  les curseurs ont disparu, le monde décide.

