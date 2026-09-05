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
- **PHASE 15 — Session Complete (issue #52)**, branche `phase-15-post-flight`.
  - `tools/post-flight-model.mjs` (`analyzeFlight()`) : logique pure de
    déduction, dont l'entrée est le `flightTelemetry` OBSERVÉ pendant la
    session (PHASE 06) — **jamais** `session.target.family` (règle de
    l'issue). PROFILE : tout candidat dont le plafond de rates
    (`RATE_PRESETS` de `flightController.js`) est sous le pic observé est
    physiquement exclu (un contrôleur ne dépasse pas son propre preset) ;
    parmi les survivants, le plafond le plus serré + un signal de vitesse
    (rang par poussée/masse, `drone-profiles.js`) départagent, confidence =
    part du score du gagnant sur le total des survivants. ESTIMATED
    (mass/FOV/response) n'apparaît qu'au-delà de `MIN_ESTIMATE_S` (30 s —
    règle de l'issue : « un vol de 20 s n'estime pas la masse ») ; en dessous
    de `MIN_SIGNAL_S` (3 s), PROFILE lui-même reste `UNKNOWN`. Masse et
    RESPONSE sont réels (`mass`/`tauSpinUp` de la famille devinée) ; FOV est
    une table narrative documentée comme telle (jamais simulée — CAMERA MODEL
    reste `UNKNOWN`, le jeu ne modélise pas la caméra d'une cible).
  - `src/post-flight.js` (`runPostFlightAnalysis`), gabarit calqué sur
    `target-scan.js` : écran 1 = rapport + Randomart (déjà posé par
    `openSession`, PHASE 06) + `OPERATOR NOTE` (texte libre, sauvegardé via
    une nouvelle route `PATCH .../sessions/:id/comment` — distincte de la
    clôture, qui exige `PENDING` ; `annotateSession`/`sanitizeComment` dans
    `session-model.mjs`, plafond 400 caractères) ; écran 2 = `LOCAL TERRAIN`
    `KEEP`/`REMOVE` (Bible §29) si la zone a un terrain préparé sur disque —
    `KEEP` ne fait rien (le terrain reste tel quel), `REMOVE` appelle le
    `DELETE /__map-api/scenes/:slug` déjà existant ; la session, elle,
    n'est jamais touchée (« supprimer le terrain ne supprime pas le souvenir »).
  - Câblé dans `main.js` : à l'`[ESC] DISCONNECT` (`flightEnd.out.exitArmed`),
    `finishSession()` regarde `session.current().result` — `LANDED` ouvre le
    rapport avant le reload, `CRASHED` recharge directement (Bible §24 : pas
    de grand écran de mort). Un flag `exiting` rend la sortie idempotente.
  - **Vérifié en headless** : `tools/post-flight-selftest.mjs` (8 tests :
    seuils, exclusion physique d'un rate hors plafond, déterminisme,
    isolement à 100 % quand un seul candidat survit) ; extension de
    `session-selftest.mjs` (`sanitizeComment`/`annotateSession`, dont
    l'annotation d'une session déjà `LANDED`) ; `npm run selftest`,
    `npm run selftest:operator`, `npm run build` tous verts.
  - **Vérifié navigateur** (Chromium headless piloté en CDP brut, hors
    chrome-devtools MCP — profil déjà pris par une session sœur ; scène
    tour-eiffel réelle) : rapport rendu avec le texte exact attendu (PROFILE
    + CONFIDENCE, OBSERVED, ESTIMATED, RANDOMART), un vol de 12 s montre
    `ESTIMATED UNKNOWN` mais garde un PROFILE deviné (LONG RANGE 22 %), une
    session `CRASHED` ne remplit pas la condition d'ouverture du rapport,
    `OPERATOR NOTE` persistée côté serveur (relue via `/__operator/:id`)
    après clic `CONTINUE`, écran `LOCAL TERRAIN` affiché avec le nom/poids
    réels de la scène (652 MB), `KEEP` referme proprement sans effet — `REMOVE`
    n'a pas été cliqué en vrai (destructeur sur les ~900 Mo de scènes locales
    de l'utilisateur), seulement lu en revue de code (un seul `fetch DELETE`
    déjà couvert par la route existante). Aucune erreur console.
  - **Non vérifié** : le clic `REMOVE TERRAIN` réel (raison ci-dessus) ; le
    déclenchement de `finishSession()` par un vrai `[ESC]` en fin de vol
    piloté (vérifié uniquement par lecture de code + la même condition
    rejouée en console) ; le ressenti (longueur du texte à l'écran, lisibilité
    du Randomart en jeu).
- **PHASE 17 — Session Log / Target Log (issue #54)**, branche `phase-17-impl`.
  - Cinq décisions (spec `docs/superpowers/specs/2026-08-29-phase-17-session-log-design.md`) :
    **D1** le Target Log est **dérivé** des sessions (`targetLogEntries`,
    `tools/session-log-model.mjs`) et la clé morte `state.targetLog` — jamais
    écrite depuis PHASE 01, donc toujours vide — est retirée par la migration ;
    **D2** deux compteurs persistés `sessionSeq`/`targetSeq`, attribués à
    l'ouverture et jamais recyclés ; **D3** `DELETE SESSION` franc, `409` sur une
    session encore `PENDING`, terrain jamais touché ; **D4** les `dataUrl` des
    captures sont élidées de toutes les réponses sauf la nouvelle
    `GET /__operator/:id/sessions/:sid` ; **D5** l'écran `TARGET LOG` ne reçoit
    aucune fonction de navigation vers le vol.
  - **Changement cassant** : `SCHEMA_VERSION` 1 → 2. Un fichier opérateur écrit
    par cette branche est refusé par `main` (`409 schemaVersion trop récent`).
    La migration est **paresseuse** : `_readOperator` migre en mémoire à chaque
    lecture, le disque n'est réécrit qu'à la première mutation.
  - **Vérifié en headless** : `tools/session-log-selftest.mjs` (17 tests :
    filtres, formats, blocs omis quand la donnée manque, dérivation et ordre du
    Target Log, numérotation) ; extension de `session-selftest.mjs` (36 tests,
    dont `seq`/`targetSeq` posés à l'ouverture et conservés au `resume`,
    migration v1→v2 idempotente, trou de numérotation qui survit à la relecture,
    `stripPhotoData`, `deleteSession` 404/409) ; `terminal-selftest.mjs` (le
    compte de cibles est dérivé — la clé morte affichait **toujours**
    `0 TARGETS LOGGED`) ; **nouveau `npm run selftest:api`** (13 checks contre un
    vrai serveur de dev Vite, état opérateur sandboxé par `FPV_OPERATOR_DIR`,
    hors de la chaîne rapide car il démarre Vite). `npm run selftest`,
    `selftest:operator` et `build` verts.
  - **Vérifié sur les vraies données de l'utilisateur** (142 sessions, 63 avec
    cible, 11 captures, 14 zones — copie de travail, fichier réel jamais écrit,
    sauvegarde prise avant) :
    - migration à blanc : 142 `seq` uniques (1→142), 63 `targetSeq` uniques,
      aucune session sans cible ne porte de `targetSeq`, idempotente, et les
      142 sessions migrées passent toutes `validateSession` ;
    - **D4 mesuré** : `GET /__operator/:id` passe de **4,89 Mo à 174 Ko sur le
      fil** (×29), à chaque ouverture du terminal. Une seule fiche ouverte
      rapatrie 2,79 Mo — d'où la route dédiée.
  - **Vérifié au navigateur** (MCP chrome-devtools, serveur de dev réel) :
    footer `142 SESSIONS · 63 TARGETS LOGGED` là où la clé morte donnait `0` ;
    les quatre filtres exacts (19 LANDED / 123 CRASHED / 3 WITH PHOTOS / 142
    ALL) ; `↑`/`↓` et `Entrée` ; fiche complète (Randomart, météo, télémétrie)
    avec les **deux vraies captures chargées** (2293×1290) ; `DELETE SESSION` →
    retour à la liste sans elle, footer à `141 SESSIONS · 62 TARGETS LOGGED`,
    `TARGET 052` disparu du Target Log (conséquence directe de D1), et le trou
    de numérotation visible — `121, 120, 118, 117`, les voisins n'ont pas bougé ;
    l'écran `TARGET LOG` n'expose **qu'un seul bouton, `[ BACK ]`** (D5 vérifié
    par observation, pas seulement par construction) ; `REVISIT AREA` →
    `TARGET SCAN` frais avec la **météo courante** et **zéro requête
    d'acquisition** (`/__map-api/jobs|plan|probe` absents — second critère
    d'acceptation de l'issue). Aucune erreur ni warning console sur tout le
    parcours.
  - **Non vérifié** : le ressenti (longueur des lignes de liste sur un écran
    réel, lisibilité du détail au format du jeu) ; `409` sur une suppression de
    session `PENDING` au navigateur (l'état réel n'en contenait aucune — couvert
    par `selftest:api`) ; le parcours à la manette ; `REVISIT AREA` n'a pas été
    poussé jusqu'au vol effectif (arrêté au `TARGET SCAN`, ce qui suffit au
    critère d'acceptation : le terrain n'a pas été re-téléchargé) ; la migration
    n'a **pas** été appliquée au vrai fichier opérateur de l'utilisateur, qui
    reste en v1 jusqu'au merge.
- **PHASE 14 — fin de vol : crash, pose, sortie manuelle** (issue #51).
  - Machine à états pure `FlightEnd` (`src/flight-end.js`, sans DOM/Three/Rapier),
    câblée dans `main.js:frame()` **hors** du bloc gelé (`if (!frozen)`) : appelée
    à chaque frame avec `dt: frozen ? 0 : dt`, pour que `out.closes` (l'événement
    à consommation unique qui déclenche `session.end()`) soit toujours vidangé
    même si la sim se fige (pause, réglages, caméra libre) entre le geste du
    joueur et sa sortie. `dt=0` fige la timeline et le compteur de pose sans
    perdre l'événement.
  - Trois voies de fermeture : crash (`crashed` déjà décidé par
    `CRASH_IMPULSE`/`CRASH_IMPULSE_FLAT` de `main.js`, réutilisés tels quels),
    pose tenue (`_advanceLanding`, hystérésis sur hauteur/vitesse/vitesse
    angulaire/gaz, seuils dans `LANDING`), sortie manuelle (`disarm()`, qui ne
    ferme la session que si la pose est reconnue — désarmer en l'air reste
    permis et donne une chute).
  - Seuils de pose mesurés (`tools/landing-selftest.mjs`, tour-eiffel,
    2026-08-29) : `H_ON=0.2`, `H_OFF=0.4`, `V_ON=0.06`, `V_OFF=0.18`,
    `W_ON=0.07`, `THR_IDLE=0.06`, `T_HOLD=0.25`. Le commentaire du code détaille
    la mesure ; `T_HOLD` n'est *pas* ce qui sépare pose et rasant (mesuré : à
    `T_HOLD` quasi nul le rebond reste écarté jusqu'à t=0,64 s et le roulé
    jusqu'à t=0,48 s) — c'est une marge de debounce choisie contre le bruit non
    modélisé, comme `TIMELINE`.
  - Séquence de pose : symétrique de la séquence de crash, mais plus courte et
    plus calme (un geste délibéré, pas une agonie). Table dédiée
    `LANDING_TIMELINE` (`src/flight-end.js`), lue par la même fonction
    d'avancement que le crash (`_advanceTimeline`, sur `this._activeTimeline`) :
    `LANDING DETECTED`/`MOTORS DISARMED` à t=0, fondu au noir de 0,6 à 1,0 s
    par-dessus l'image *vivante* (pas de `linkDead`), `END SESSION` à 1,4 s,
    `[ESC] DISCONNECT` à 2,2 s avec `exitArmed`/`TERMINATED`. Avant, les quatre
    lignes s'affichaient d'un coup et n'annonçaient jamais Échap ; `exitArmed`
    s'armait dès la frame qui vidangeait `closes`, désormais il ne s'arme qu'à
    la toute fin de cette séquence — il faut la fermeture de session partie *et*
    la séquence vue en entier.
  - Séquence de crash : mise en scène assumée comme telle (pas une mesure),
    dans `TIMELINE` (`src/flight-end.js`) : image tenue jusqu'à 0,9 s, fondu au
    noir en 0,4 s, puis `LINK LOST` (1,6 s), `TARGET LOST` (2,8 s), `SESSION
    TERMINATED` (3,6 s), `[ESC] DISCONNECT` (4,6 s, `exitArmed`). Deux lignes
    vides dans `TIMELINE.lines` (après `LINK LOST`, avant `[ESC] DISCONNECT`)
    pour respirer comme l'écran de pose. `linkDead` force `DEAD_LINK` sur
    `lens.render()` dans `main.js`, gardé sur `flightEnd.out.linkDead` (pas
    `crashedThisFrame`) pour qu'un choc encaissé après un `LANDED` ne rejoue pas
    la mort d'image par-dessus l'écran `END SESSION`.
  - **Vérifié en headless** :
    - `tools/flight-end-selftest.mjs` : 20 tests, sans DOM/Rapier — impact →
      crash, timing des lignes de crash et de pose (chacune avec ses lignes
      vides horodatées avec la ligne qui suit), `out.closes` émis une seule
      fois pour chaque cause, `exitArmed` faux juste après `disarm()`, encore
      faux juste après la frame qui vidange `closes`, vrai seulement à la fin
      de `LANDING_TIMELINE` (phase `TERMINATED`), crash pendant
      `LANDING_READY` gagne, désarmement en vol ne ferme rien,
      `update({dt:0})` après `disarm()` vidange `closes` sans avancer la
      séquence de pose ni armer `exitArmed` (le cas sim gelée), `reset()`.
    - `tools/landing-selftest.mjs` : Rapier réel sur tour-eiffel. Sept poses
      (1/3/8 m, vent de travers, rebond, roulé, **pose sur pente** — voir
      ci-dessous) toutes reconnues ; neuf rasants (3 hauteurs × 3 tangages) et
      un stationnaire bas tous rejetés, chacun assorti d'un plancher de vitesse
      et d'une bande de hauteur mesurés sur sa propre trace (pas seulement « pas
      détecté »).
    - Pose sur pente (D5 de la spec) : `height` est un raycast vertical depuis
      le centre du collider sphérique (rayon 0,15 m), donc géométriquement
      `0,15/cos θ` sous la sphère — la détection plafonnerait vers 41°
      d'inclinaison rien que sur ce critère. Mesuré sur une facette réelle de
      tour-eiffel à 30,0° : reconnue à t=2,75 s. Sondé au-delà (33-39°) : c'est
      `setGroundHold` (amortissement exponentiel, pas `H_ON`) qui bloque en
      pratique vers 30-33°, avant la limite géométrique de 41° — acté en
      commentaire dans `landing-selftest.mjs`, `H_ON` n'a pas été remonté (ça
      ne change rien au blocage réel, qui est sur `W_ON`).
    - `npm run selftest` reste vert, `npm run build` OK.
  - **Vérifié en vol piloté** (navigateur, scène tour-eiffel) :
    - séquence de crash à l'écran : image tenue 0→0,9 s, fondu au noir 0,9→1,3 s,
      `LINK LOST` 1,62 s, `TARGET LOST` 2,83 s, `SESSION TERMINATED` 3,64 s,
      `[ESC] DISCONNECT` 4,65 s ;
    - mort de l'image dès la première frame du crash : `uLink = 0`, sévérité
      forcée à 1 alors que le réglage joueur était 0,6, moteurs à zéro,
      contrôleur désarmé ;
    - pose au repos → `LANDING DETECTED`, puis `J` → `MOTORS DISARMED` /
      `END SESSION` ;
    - désarmement en l'air (16 m, 13 m/s) : rien ne se ferme, la chute suit son
      cours ;
    - vol rasant réel à 0,25 m et 15,2 m/s : aucun faux positif ;
    - `Échap` ramène au terminal depuis `TERMINATED` comme depuis `LANDED` ;
      aucune erreur console.
  - **Non vérifié** : le ressenti (rythme de la séquence de crash, lisibilité de
    `LANDING DETECTED` affiché par-dessus l'image encore vivante), et le cas du
    joueur ayant coupé la modélisation du lien (`LINK_OFF`) — `main.js` force
    `severity: 1` au premier frame de `CRASHING` dans ce cas, mais le vol
    vérifié avait le lien actif ; ce chemin n'a pas été exercé en vol.
- **PHASE 11 — Entry State (issue #48)**, branche `phase-11-entry-state`,
  mergée dans `main`.
  - Après `JACK IN` (et à chaque respawn en session), le drone démarre déjà en
    vol : `src/entry-state.js` (`generateEntryState()`) tire une catégorie
    pondérée (COMFORTABLE 60 / ACTIVE 25 / CHALLENGING 12 / HOLY_SHIT 3 %),
    échantillonne position/assiette/vitesse/rotation n'importe où dans le bbox
    de la scène, puis valide le tirage en deux temps : géométrique
    (`groundBelow`/`obstructionBetween`, réutilisés tels quels) et un rollout
    physique headless d'1 s (sticks neutres, throttle hover via
    `hoverThrottle()`, mêmes `Physics`/`FlightController` que le jeu — aucun
    second moteur physique). 20 tirages max, puis repli garanti sur l'ancien
    spawn fixe au repos.
  - `Physics.applyEntryState()` (nouveau, à côté de `reset()`) pose le corps à
    un état cinématique arbitraire ; `physics.spawn` (position du pilote au
    sol, antenne) reste inchangé — seul le point d'entrée du drone bouge.
  - `main.js` : `boot()` et `respawn()` appellent
    `physics.applyEntryState(generateEntryState({physics, manifest, seed}))` ;
    `spawnY` (télémétrie PHASE 06) reste ancré à `physics.spawn.y`, pas à la
    position d'entrée aléatoire.
  - **Vérifié headless** : `tools/entry-state-selftest.mjs` (tirage de
    catégorie pur, chaîné dans `selftest:operator`, distribution mesurée à
    ±3 points sur 20 000 tirages) ; nouvelle section `entry state` dans
    `tools/selftest.mjs` sur la scène réelle tour-eiffel (100 tirages : aucun
    ne crashe dans la seconde de grâce rejouée, aucun sous le terrain, chaque
    résultat dans la plage de sa catégorie ; repli `maxAttempts=0` vérifié).
    `npm run selftest`, `selftest:operator`, `npm run build` verts.
  - **Vérifié navigateur** (MCP chrome-devtools) : première frame de session
    et respawns répétés (`r`) atterrissent en vol (altitude/vitesse/assiette
    variées, moteurs actifs), aucun `NaN`, aucune erreur console.
  - **Non vérifié / connu, hors périmètre de cette phase** : les plages de
    valeurs par catégorie (`RANGES` dans `entry-state.js`) sont un premier
    jet tapé à la main, pas mesuré au banc — à ajuster au ressenti en vol. Le
    rollout de validation suppose un throttle hover pendant la seconde de
    grâce ; si le vrai jeu démarre au throttle 0 (position par défaut du
    stick dans `input.js`), un joueur qui ne touche pas les gaz immédiatement
    peut chuter en CHALLENGING/HOLY_SHIT (basse altitude) avant la fin de la
    seconde — tension déjà documentée dans la spec, à traiter par PHASE 10
    (rituel JACK IN) ou `input.js`, pas par ce module. Le contrôle de sécurité
    géométrique ne regarde pas la viabilité du lien vidéo au point d'entrée
    (l'émetteur reste fixe à `physics.spawn`) — un spawn éloigné avec un
    bâtiment sur la ligne de vue peut ouvrir une session sur un lien dégradé.
- **Ciel et nuages (issue #22)**, branche `issue-22-nuages-ciel`.
  - Le ciel est un dôme dégradé avec une couche nuageuse procédurale
    (`src/sky.js`, `src/cloud.js`) ; la couverture vient de `cloudPct` du world
    state (météo), pas d'un réglage manuel.
  - Plafond traversable : whiteout à l'approche, on ressort au-dessus de la
    couche. Profil d'extinction mesuré en vol à couverture 0,95 (base 136 m) :
    nul jusqu'à 50 m, 0,0068 à 100 m, 0,0658 en saturation entre 200 et 300 m,
    retombé à 0,0217 à 400 m.
  - Assombrissement global du sol **sans motif** : décision de conception, pas
    une simplification — la géométrie n'a pas de normales et les tuiles
    portent déjà l'ombrage cuit d'Apple. `DIM_MAX = 0,55`, mesuré en vol sur
    `tour-eiffel` et `notre-dame-de-la-croix`.
  - Vérifié en vol : `uHorizon`, `scene.background` et le `uFogColor` des
    matériaux de chunk portent tous exactement la même couleur — c'est ce qui
    empêche la ligne d'horizon de se dédoubler.
  - **L'invariant historique change de forme.** Il ne dit plus que le pixel de
    ciel sort à `#9fb8cc` : un dégradé change forcément le pixel du zénith,
    et c'est l'objet même de cette issue. L'invariant devient : **la couleur
    d'horizon par ciel clair vaut exactement `#9fb8cc`**, c'est elle que
    `setFog()` pousse sur les tuiles, et le zénith est délibérément plus
    profond. Vérifié en vol.
  - **Non vérifié** : le coût en fill rate du dôme à FOV 120 sur un GPU
    modeste — la vérification a tourné en rendu logiciel.
  - Le sens de dérive du vent était inversé (`_drift` accumulé avec le bon
    signe, mais le shader échantillonne `vnoise(p + uDrift·…)`, ce qui
    translate le motif à *moins* le vecteur ajouté : les nuages remontaient
    le vent). Corrigé après la revue finale, vérifié par un calcul numérique
    sur un portage JS du fbm (maximum local suivi sous un vent de nord).
    Toujours **non vérifié à l'œil**.
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

- **Le soleil** (issue #23) : `src/sun.js` (position + couleur du ciel + AGC
  `SunField`), `src/lens.js` (bloc `#if SUN` : disque, halo, voile, gain
  d'exposition), câblage `src/main.js` (occlusion via
  `physics.obstructionBetween()`, projection écran, `weatherSky()` dérive
  maintenant du soleil, `window.__sim.debug().sun`).
  - **Vérifié au banc** : `npm run selftest` — 57 checks dédiés répartis en
    quatre sections (`soleil — position`, `soleil — atmosphère et couleur du
    ciel`, `soleil — exposition (AGC) et SunField`, `soleil — traduction
    depuis le bulletin`), 258/258 au total sur la scène `tour-eiffel`.
  - **Vérifié en vol, navigateur (CDP direct sur un Chromium headless dédié,
    dev server sur le worktree `issue-23-soleil`, `?scene=tour-eiffel`,
    heure réelle 2026-08-29 ~15h40 CEST)** :
    - `window.__sim.debug().sun` existe et ses champs sont plausibles pour
      Paris à l'heure réelle : élévation ~44,8° puis en baisse au fil du test
      (cohérent avec une fin d'après-midi), `dir.z > 0` (soleil au sud), ciel
      `#a3c2e2`-`#a7c9ee` (bleu clair, cohérent avec une élévation proche
      mais pas égale à la référence de calibrage 60°).
    - **Passage 1 — soleil dans le cadre** : caméra pointée droit sur le
      soleil (rotation du corps Rapier forcée), `inFrame` monte à 0,81,
      `exposure` chute de 1 à 0,562 en ~1,5 s ; en la retournant à 180°,
      l'exposition remonte (0,562 → 0,846 → 0,90 sur les secondes
      suivantes), plus lentement que la fermeture — la mécanique décrite par
      l'issue est bien observable dans le vrai rendu.
    - **Passage 2 — soleil occulté par un bâtiment** : position/orientation
      choisies par balayage de `physics.obstructionBetween()` pour couper le
      rayon soleil sur un immeuble ; `visible` tombe de 1 à 0, `inFrame`
      retombe à 0 avec lui, et `exposure` reste quasi immobile (0,992 →
      0,995) — un soleil caché ne ferme pas le diaphragme, confirmé.
    - **Passage 3 — ciel couvert** : `window.__sim.sun.setWeather({cloudPct:
      100, visibilityM: 20000})` → `amount` tombe à 0, `active` passe à
      `false`, ciel gris clair `#cde0e4`, plus de disque.
    - **Non-régression** : à l'heure réelle du test l'élévation solaire
      (~44°) n'était pas celle du point de calibrage (`REF_ELEV = 60`), donc
      la reproduction *exacte* de `#9fb8cc` n'a pas pu être observée en
      direct (c'est couvert au banc par `soleil — exposition (AGC) et
      SunField` : `sun.exposure === 1` exactement à `REF_ELEV`/`REF_VIS`).
      Ce qui a été observé en direct : ciel clair, soleil hors cadre ⇒
      `exposure` revient à 1 et le ciel calculé (`#9eb2c0` à 44° d'élévation)
      s'approche de `#9fb8cc` dans le sens attendu par la formule. Ciel
      totalement couvert ⇒ `active` bien `false` dans le vrai rendu — le cas
      de non-régression que le code documente réellement (voir le
      commentaire au-dessus de `SunField.active` dans `sun.js` : `active` est
      vrai dès que le soleil est levé, caméra ou pas — un ciel clair de midi
      NE rend PAS `active` faux, seul un ciel totalement bouché, ou la nuit
      avec un gain resté à 1, le fait).
    - Aucune erreur console pendant le test.
  - **Non vérifié** : le ressenti d'un vol complet du lever au coucher (ça
    demande de laisser tourner des heures réelles, il n'y a délibérément
    aucun réglage d'heure) ; le pilotage manette réel des trois passages (ils
    ont été reproduits par script CDP — orientation de la caméra forcée via
    Rapier — plutôt qu'au stick, faute d'accès manette dans cet
    environnement).
- **PHASE 20 — langage ASCII / pixel art / demo scene du rituel (issue #57),
  vérifié headless + navigateur** :
  - `src/ascii.js` : `asciiTag` (3 usages info `[+]`/`[!]`/`[*]` de la Bible
    §40), `asciiChain`, `bigText`/`BIG_FONT` (police banner 5 lignes × 3
    colonnes, A-Z + espace/!/-). `tools/ascii-selftest.mjs` : 7/7 OK.
  - `src/pixel-icons.js` : 9 icônes 12×12 (`ICON_NAMES`, Bible §41), rendu
    `iconSVG` en rects `crispEdges` (aucun emoji), `faviconDataURI` — le
    favicon de `index.html` est désormais ce drone pixel art, plus l'ancien
    emoji hélicoptère. `tools/pixel-icons-selftest.mjs` : 5/5 OK.
  - `src/hack-grammars.js` / `src/ritual.js` : 3 primitives ajoutées
    (`colorFlash`, `textWarp`, `bannerBurst`) aux 8 existantes → **11
    primitives** `RITUAL_PRIMITIVES`, toutes sous contrat `{ t, seed, dur }`
    (`dur` = fenêtre visible d'un battement, pas la durée V1-V4 de la
    culmination entière ; absent, `dur` retombe sur l'ancien comportement,
    compat PHASE 10).
    `FAMILY_PRIMITIVES` couvre les 6 `HACK_TYPES`, chacune avec les nouvelles
    primitives composées quelque part dans sa liste. `tools/ritual-selftest.mjs` :
    14/14 OK, dont le garde-fou d'acceptation #57 (`RITUAL_PRIMITIVES` /
    `FAMILY_PRIMITIVES` ne sont importés que par `ritual.js` et
    `hack-grammars.js` — aucune fuite hors de l'événement de rituel).
  - **Coût mesuré** (`tools/ritual-bench.mjs`, budget 2 ms/frame, 480 frames/
    primitive) — pire cas rejoué dans ce même run : `glitchShift` à
    **0,168 ms/frame** (8,4 % du budget) ; toutes les autres primitives sous
    0,12 ms/frame. Un précédent passage (task 4) avait mesuré `scanBurst` à
    0,093 ms/frame comme pire cas — l'ordre de grandeur (quelques % du
    budget) est stable, la valeur exacte varie avec la charge machine au
    moment du bench.
  - `npm run selftest` (158/158) et `npm run selftest:operator` (chaîne
    complète, `landing-selftest.mjs` inclus une fois le lien symbolique
    `public/scenes` en place) : verts de bout en bout, PHASE 20 en queue de
    chaîne.
  - **Vérifié navigateur** (MCP indisponible — profil Chromium déjà
    verrouillé par une autre session ; piloté à la place via CDP brut sur un
    Chromium headless dédié, `--remote-debugging-port=9223`) :
    - Favicon d'onglet : le drone pixel art (`data:image/svg+xml`, rects
      `crispEdges`), plus d'emoji — vérifié sur l'écran d'accueil et pendant
      un rituel.
    - Rituel déroulé jusqu'à la culmination via `?scene=<slug>&hack=<type>`
      (raccourci dev, `src/main.js`/`normalizeHackType`) + vecteur de secours
      `FALLBACK_VECTOR` (`↑ → ↓ ← ↑ ←`) : `colorFlash` observé (fond plein qui
      strobe, ex. violet/magenta), `textWarp` observé (lignes de vocabulaire
      d'ambiance déformées en sinusoïde, ex. `OVERRIDE`/`TRACE`/`BYPASS`
      défilant), `bannerBurst` observé (texte en gros caractères ASCII, ex.
      motif `GNSS`) — les trois nouvelles primitives, chacune capturée en
      screenshot pendant sa fenêtre de burst. Les 8 primitives PHASE 10
      (`scanBurst`, `gridSwarm`, `pulseRing`, `vectorSweep`, etc.) revues au
      passage sur d'autres familles/variantes.
    - Point de méthode utile pour rejouer ceci : la variante (V1-V4, 1-4 s)
      et l'ordre des primitives sont déterministes par `seed =
      cosmeticSeed(family || hackType)` (`src/hack-grammars.js` /
      `tools/ritual-model.mjs`) — passer `&family=<nom>` en plus de `&hack=`
      change la variante sans changer le hack affiché, utile pour forcer un
      V3/V4 et voir une primitive qui n'apparaît qu'au 3e/4e battement.
      Le rituel interactif (`.ritual-prompt`) ne se monte qu'après la
      séquence scriptée d'AUTOMATED ANALYSIS (`tools/hack-model.mjs` :
      `HACK_LEAD` + 2 battements famille + `HACK_TAIL` + pauses + `HACK_HOLD_MS`
      + `HACK_LOCK_MS`, ~5,6 s nominal, plus sous charge) — envoyer les
      touches avant que `.ritual-prompt` affiche des `_` ne fait rien
      (rituel pas encore monté, événement clavier perdu).
    - Hors rituel (écran d'accueil `[ GLOBAL SCANNER ]`, vol avec `?scene=`
      seul, sans `hack=`) : aucune couleur ni flash demo scene — HUD en
      monochrome clair standard, seul artefact visible étant le liseré RGB du
      lens/link existant (préexistant, sans rapport avec le rituel).
  - **Non vérifié** : l'adoption des tags `[+]`/`[!]`/`[*]` et des icônes
    pixel art sur les écrans existants (menu, terminal, scanner…) — c'est
    la PHASE 19 (issue #56), le langage existe mais sa généralisation est
    hors périmètre de la PHASE 20. La saisie manette du rituel (`gamepad-dir.js`)
    n'a pas été rejouée en navigateur (pas d'accès manette dans cet
    environnement, comme pour PHASE 08/13). Seules 4 des 6 `HACK_TYPES` ont
    été rejouées individuellement en navigateur via `?hack=<type>`
    (`COMMAND INJECTION`, `LINK HIJACK`, `TELEMETRY SPOOF`, `GNSS SPOOF`) ;
    `NETWORK TAKEOVER` et `FIRMWARE OVERRIDE` n'ont pas été rejouées
    elles-mêmes, seules leurs primitives ont été observées en passant par
    d'autres familles.

- **Sélection par polygone libre (issue #30)** — `DRAW SHAPE` dans le GLOBAL
  SCANNER, `drawPolygon` dans `add-map.html`, `--poly` dans `export-obj` et dans
  `npm run add-map`.
  - **La règle** : une tuile est retenue dès que le tracé la touche, même d'un
    coin. La zone extraite est donc toujours un sur-ensemble du tracé, comme le
    rectangle l'est déjà du fait de l'arrondi sur le treillis. Un corridor plus
    fin qu'une tuile reste extractible.
  - **Deux ports, une fixture.** Le prédicat vit dans `pkg/mth/poly.go` et dans
    le bloc polygone de `tools/lib/tiles.mjs`. Les deux nomment le dossier de
    cache : une divergence coûterait un re-téléchargement silencieux de
    plusieurs gigaoctets. `flyover-reverse-engineering/testdata/poly-cases.json`
    est lu des deux côtés (`go test ./pkg/mth/`, `node tools/map-poly-selftest.mjs`),
    10 cas, 15 872 décisions de tuile, hash compris. Les deux ports s'accordent.
  - **Vérifié à travers le vrai binaire Go** (`--plan`, aucune requête de tuile) :
    sur le corridor en diagonale de la fixture, `columns 123`, `masked 717`,
    `pruned 0`, et `exportDir` nommé `poly-4b6f9117e786-20-20` — exactement le
    hash calculé par le port JS. `--bbox` inchangé (1350 colonnes, `masked 0`,
    même nom de dossier).
  - **Vérifié dans Chromium** (CDP, `runScanner()` monté sur une page de sonde,
    puis `add-map.html` de même), sur un tracé en L au-dessus de Paris : les deux
    écrans posent le même escalier de 504 segments, annoncent 4,87 km² et ~4 min
    pour le tracé contre 9,75 km² et ~8 min pour son emprise, et le treillis
    disparaît sous 7 px pendant que le contour reste dessiné.
  - **Deux mensonges d'écran corrigés au passage**, tous deux invisibles aux
    tests unitaires : `TILES` affichait `cols × rows`, c'est-à-dire l'emprise
    (15 812) et non ce qui est demandé (8 069) — l'économie, seule raison d'être
    du polygone, n'apparaissait nulle part ; et `surveyCentre()` interrogeait
    Nominatim au centre de l'emprise, qui sur un L tombe dans l'encoche, donc on
    décrivait un quartier qu'on n'extrait pas. La sonde de couverture avait le
    même travers et vise désormais une tuile réellement retenue.
  - **Extraction réelle faite** : `seine-iena-alma`, un corridor du pont d'Iéna
    au pont de l'Alma, 4 sommets. 134 colonnes retenues sur 696, `153 exported`,
    `562 colonne(s) hors du polygone, non balayées`, 7,3 s, 9 Mo préparés. La
    seconde acquisition du même tracé a répondu « Tuile déjà téléchargée
    (…/poly-98b6e26043ec-20-20) » et le port JS calcule `98b6e26043ec` : le
    hash du Go et celui de Node concordent en conditions réelles, pas seulement
    sur la fixture.
- **Trouvé en vérifiant, et reporté en #102** : `tools/selftest.mjs` sur cette
    scène rend 15 échecs. Dix sont pré-existants — le fichier est écrit en dur
    pour `tour-eiffel`, `bastille` en rend les mêmes. Les cinq autres sont
    réels : `sampleCandidate()` (`src/entry-state.js`) tire dans la **bbox** du
    manifeste, or un corridor n'occupe que 19 % de la sienne. Mesuré : 315
    tirages sur 400 tombent hors terrain (0/400 sur `bastille`), et 2 sessions
    sur 100 se replient sur un spawn au repos. Supportable ici, mais le budget
    de 20 tentatives vieillit mal : à 5 % de remplissage il donnerait 36 % de
    replis. La génération de cibles est peut-être logée à la même enseigne.

- **Second fournisseur 3D — Stages 1, 2 et 3 (issue #18)**. Stages 1-2 sur
  `issue-18-providers` (PR #115, mergée) ; Stage 3 sur `issue-18-google-earth`.
  - Deux seams distincts introduits dans le pipeline de préparation, à ne pas
    confondre : `tools/lib/providers/` (d'où viennent les octets — `plan`,
    `probe`, `fetch`, `tileDirName`/`tileDirPath` async, `tileIsUsable`, id/
    label/attribution) et `tools/lib/decoders/` (comment les lire — `sniff`/
    `decode`). Le registre fournisseur (`tools/lib/providers/index.mjs`,
    `DEFAULT_PROVIDER_ID`/`PROVIDERS`/`list()`/`get(id)`) et le sélecteur de
    décodeur par reniflage (`tools/lib/decoders/index.mjs` `pick(tileDir)`)
    existent tous les deux, mais **seul `flyover` est inscrit** comme
    fournisseur — pas de second fournisseur réel pour l'instant, et aucun
    drapeau `--provider` ne sélectionne le décodeur (il choisit seul par
    reniflage). `tools/lib/growable.mjs` (Growable) et `tools/lib/run.mjs`
    (runner de sous-process + `Cancelled`) sont les deux utilitaires partagés
    extraits au passage, neutres vis-à-vis des deux seams.
  - **Fait par le Stage 3** (c'était le risque signalé ci-dessus, à ne pas
    découvrir tard) : `plan`/`probe`/`fetch`/`tileDirName`/`tileDirPath`/
    `tileIsUsable` sont maintenant dispatchés par fournisseur dans
    `add-map-core.mjs` ; `add-map.mjs` et `map-api-plugin.mjs` (GUI) savent
    positionner `opts.provider`. Reste néanmoins **non traité** :
    `tools/remove-map.mjs` garde sa propre constante de cache Flyover-only
    (n'importe pas `add-map-core`) — orpheline le cache d'une scène supprimée
    si elle vient de `google-earth` ; suivi en issue de suivi à créer.
  - `manifest.json` passe en `version: 3` et porte `provider: {id, label,
    attribution, fetchedAt}`. Les manifests `version: 2` existants se
    rechargent tels quels, avec repli sur l'attribution Apple Flyover — **pas
    de re-préparation nécessaire**. `scenes.json` gagne `provider`/`fetchedAt`
    par entrée (additif, les entrées déjà là restent valides).
  - `src/provider-credit.js` (`creditLines`/`creditText`/`LEGACY_PROVIDER`) est
    pur navigateur+Node ; une ligne de crédit discrète (`#fo-credit`) s'affiche
    en bas à droite de l'OSD **`fpvtp-osd`** — jamais sur le `drone-osd`
    diégétique.
  - **Vérifié en headless** : `tools/provider-selftest.mjs` (5 tests : registre,
    id inconnu, contrat de surface, `tileDirName` async, les trois modes de
    zone) et `tools/provider-credit-selftest.mjs` (6 tests : manifest v3 avec
    attribution, manifest v2 replié sur Flyover, fournisseur sans attribution
    utilisable, jamais de crash sur une entrée absurde, dédup des lignes,
    jonction de `creditText`), les deux chaînés dans `selftest:operator`.
    `npm run selftest:operator` (dont les deux nouveaux) et `npm run selftest`
    verts.
  - **Vérifié dans un vrai navigateur** : sur `seine-iena-alma` — manifest
    `version: 2`, SANS champ `provider` (donc ce test prouve le repli sans
    re-préparation, pas le chemin v3) — la ligne de crédit `#fo-credit` rend
    « © Apple » en bas à droite, à 14 px du bord droit et 12 px du bas, les
    mêmes marges que les coins tl/tr/bl existants du HUD. Absente du
    `drone-osd` diégétique, visible seulement sur `fpvtp-osd`.
  - **Amendement du design (2026-08-31)** : le Stage 3 planifié à l'origine
    (Google Photorealistic 3D Tiles — clé API, glTF, `root.json`) n'a **pas eu
    lieu**. Le propriétaire a fourni un HAR du trafic réel d'earth.google.com :
    Google Earth web parle un protocole interne, **rocktree**
    (`kh.google.com`), pas la Map Tiles API — aucune clé, aucun paramètre de
    session. Détail dans `docs/superpowers/specs/2026-08-29-second-fournisseur-3d-design.md`,
    section « Amendement 2026-08-31 ». Client Node natif écrit dans
    `tools/lib/providers/google-earth.mjs` + `tools/lib/decoders/rocktree.mjs`
    — pas de vendoring d'`earth-reverse-engineering` (non maintenu depuis 2020,
    sans licence : il sert de documentation de protocole, le code est réécrit,
    pas copié).
  - **Stage 3 livré** : fournisseur `google-earth` inscrit et **par défaut**
    (`DEFAULT_PROVIDER_ID = 'google-earth'`), décodeur `rocktree` inscrit,
    `plan`/`probe`/`fetch`/`DELETE` dispatchés par fournisseur, sélecteur
    FOURNISSEUR dans la GUI d'ajout de carte (`add-map.html`) avec mode
    **Auto** (sonde Google Earth, puis repli Apple Flyover — y compris quand
    la sonde Google **lève** une exception, pas seulement quand elle répond
    négativement).
  - **Choix de la source dans le GLOBAL SCANNER** (`src/scanner.js`, l'écran
    qui a absorbé `add-map.html` — c'est LA voie réelle, la GUI héritée ne
    sert plus qu'au débogage). Bloc COVERAGE : `SOURCE — PICK ONE`, une rangée
    `sc-switch` alimentée par `GET /__map-api/providers` (le scanner n'écrit
    ni les ids ni les libellés). **Aucun mode automatique, rien de
    présélectionné** : PROBE et ACQUIRE restent fermés tant que l'opérateur
    n'a pas désigné une source, et changer de source invalide plan+sonde.
    `sourceChoices()`/`chosenSource()` (scanner-model, testés) portent la
    règle ; l'ordre d'AFFICHAGE suit le défaut du registre (priorité #18),
    afficher n'étant pas choisir. Le fournisseur désigné part dans `/plan`,
    `/probe` et `/jobs`.
    - **Corrigé au passage, trouvé en s'en servant** : (1) le scanner
      n'envoyait aucun `provider`, donc il acquérait déjà chez Google tout en
      écrivant « Flyover » partout — les verdicts nomment maintenant la source
      qui a répondu ; (2) `probe()` de google-earth ne rendait pas `exported`,
      d'où un « 0 tiles came back » sous un verdict « couvert » ; (3) une
      sonde qui **échoue** était rendue en `NO COVERAGE` (« rien n'est revenu
      ici »), ce qui envoyait chercher une autre zone quand il fallait réparer
      son installation — statut `error` distinct, libellé `SOURCE
      UNAVAILABLE`, message serveur réduit à sa première ligne (un panic Go
      déversait sa stack goroutine dans le panneau).
    - **Vérifié dans le navigateur** sur une zone du Champ-de-Mars : rangée à
      deux boutons, rien de présélectionné, PROBE fermé tant qu'aucune source
      n'est choisie ; GOOGLE EARTH → « 18 tiles came back … Google Earth has
      real photogrammetry here » ; bascule sur APPLE FLYOVER → verdict remis à
      UNPROBED puis, `config.json` en place, « Couvert : 23 tuile(s) » côté
      API. Un `provider` inconnu est refusé en 400 (« fournisseur inconnu :
      bidon (connus : flyover, google-earth) »).
    - **À savoir pour tester dans un worktree** : `flyover-reverse-engineering/
      config.json` (jeton Apple, gitignoré) n'existe QUE dans la copie
      principale — sans lui la sonde Apple échoue, et c'est exactement ce que
      le nouveau `SOURCE UNAVAILABLE` sert à ne plus confondre avec « pas de
      couverture ». Le copier dans le worktree suffit.
  - **Découvertes wire, mesurées (pas dans la doc de protocole tierce)** :
    - le globe rocktree est une **sphère** de rayon moyen terrestre
      (6 371 010 m), pas l'ellipsoïde WGS84 — `sphereToWgs84Ecef()` dans le
      décodeur convertit sommet par sommet ; sans elle l'origine d'une scène
      tombe à 49,05°/5151 m au lieu du point demandé (repère Paris, écart
      géocentrique/géodésique théorique).
    - `kml_bounding_box` (NodeData, champ 5) est ordonné `[west, south,
      altMin, east, north, altMax]` — pas l'ordre supposé par le plan initial.
    - les textures sont **toujours** demandées en `!2e1` (JPEG) : le HAR les
      avait capturées en `!2e6` (CRN/DXT1), mais le serveur sert bien le même
      nœud en JPEG sur simple demande — vérifié live (200, magic `ffd8`).
    - les epochs s'enchaînent par bulk le long d'une chaîne réelle (984 →
      1005 → 1013 → 1014 observés), pas un epoch unique global.
    - `zoom ↔ niveau d'octree` : `niveau = zoom + 1`, calibré sur
      `meters_per_texel` (ratio constant 1,032, log-échelle) contre la
      référence Flyover, cap à 22 (tools/rocktree-calibrate.mjs). Calibration
      **mono-latitude** (Paris) — `cos(lat)` pourrait la décaler d'un niveau
      ailleurs, non vérifié, `--live` disponible pour recalibrer au besoin.
    - `copyright_ids` (NodeData) + l'endpoint `Copyrights` donnent
      l'attribution de niveau 3 du design (celle qui vient des tuiles cuites),
      mais peut être vide pour une tuile réelle une fois les ancêtres
      hors-sujet exclus (constaté sur `ge-champ-de-mars` : `"255": ""`) — fait
      de données, pas un défaut du décodeur.
    - deux bugs de traversée/géodésie réels trouvés à la cuisson (au-delà des
      inconnues wire attendues) : ancêtres fill-in sans rapport avec la zone
      restaient inclus (bathymétrie arctique sur une tuile Paris) → filtre
      « aucun nœud retenu n'est préfixe strict d'un autre » dans
      `google-earth.mjs`. Détail complet dans `task-9-report.md`.
  - **Vérifié** : 21 tests `tools/rocktree-selftest.mjs` (fixtures HAR figées
    hors-ligne, re-capturées en JPEG) ; cuisson réelle `ge-champ-de-mars`
    (48.8582, 2.2945 — 91 nœuds retenus, 246 805 sommets, 184 000 triangles) ;
    scène chargée, pilotée et collisionnée en navigateur (`LANDING DETECTED`,
    impact + CCD, textures nettes — décision `1 - v` du décodeur OBJ confirmée
    correcte aussi pour rocktree, pas d'inversion à faire) ; crédit « © Google »
    affiché sur `fpvtp-osd` seulement ; sélecteur GUI + mode Auto vérifiés
    (« Couvert par Google Earth : 28 octant(s) au niveau 21 »).
  - **Reste ouvert / hors scope** :
    - les *reality meshes* (étage 3 du design amendé) — pas abordés ici.
    - la traversée retient par **bbox**, pas par le polygone exact tracé côté
      GUI — un sur-ensemble comme pour Flyover, non resserré.
    - ~~`octantsCovering()` énumère un chemin par variante VERTICALE~~ —
      **résolu, issue #153** (voir la section dédiée plus bas).
    - `tools/remove-map.mjs` garde un chemin de cache Flyover-only (voir
      bullet Stage 1-2 ci-dessus).
    - calibration `zoom ↔ niveau` mono-latitude (voir plus haut).
  - **Gap #110, résolu côté selftest** : `tools/selftest.mjs` skip proprement
    la vérification de convention UV quand le dossier de tuile n'a pas
    d'`exp_model.mtl` (décodeur non-OBJ), au lieu de confondre ce cas avec un
    cache purgé. La dette de fond (dernière hypothèse OBJ vivant hors des
    décodeurs) reste ; #110 documente maintenant le comportement observé, pas
    fermé pour autant.
  - **Fixtures** : `sim/tools/testdata/rocktree/` — figées depuis un HAR de
    earth.google.com (2026-08-31, epoch racine 1014) + deux requêtes live
    (bulks/planetoid/copyrights). Le HAR (114 Mo) est gitignoré
    (`docs/*.har`) ; régénération via
    `node tools/gen-rocktree-fixture.mjs "<chemin du .har>"` sur un HAR frais.

- **Traversée rocktree : marche descendante par bulks (issue #153)**, branche
  `issue-153-bulk-walk`.
  - **Le défaut** : `traverse()` énumérait d'abord toute la géométrie possible
    au niveau cible (`octantsCovering`), puis demandait aux bulks si chaque
    chemin existait. Chaque digit d'octree porte 2 bits lat/lon **et 1 bit
    vertical**, et le bit vertical ne change pas la boîte lat/lon : l'énumération
    produisait donc 2^(niveau-2) chemins par cellule réelle — **524 288 au
    niveau 21**, le zoom GUI par défaut. Google Earth étant le fournisseur par
    défaut, c'était le chemin nominal qui pendait.
  - **Le garde-fou d'alors ne pouvait rien** : il comparait un nombre de
    *colonnes* lat/lon (~4 400 pour une zone de 500 m au niveau 21) à une limite
    de 200 000, alors que le coût réel était colonnes × 2^19 ≈ 2·10⁹. Il ne se
    déclenchait jamais là où il aurait fallu.
  - **Le correctif** : on renverse. `expandBulk()` (pur, exporté, testé seul)
    part des nœuds qu'un bulk déclare, raffine la boîte digit par digit et
    élague sur la zone ; `traverse()` descend génération de bulks par génération,
    par lots parallèles de 8. Le coût suit les nœuds réellement présents.
    `descendBox()` (octant.mjs) porte la géométrie : racines à 2 digits, puis
    `childBoxes`, `null` hors géométrie.
  - **Mesuré** (Champ de Mars, zoom 20 → niveau 21, réseau réel) :

    | zone | ancien | nouveau | nœuds |
    |------|--------|---------|-------|
    | 40 m  | 5,0 s  | 0,36 s | 109 = 109 |
    | 240 m | 62,1 s | 0,57 s | 429 = 429 |
    | 1 km  | ne terminait pas (>300 s) | 2,9 s | 3 551 |

    Soit **108×** sur la zone de 240 m. Les ensembles de nœuds sont **identiques
    au chemin près** — c'est une accélération, pas un changement de sémantique,
    et le selftest le verrouille contre un oracle (l'ancien algorithme, transcrit
    dans `rocktree-selftest.mjs` et gardé là seulement).
  - `plan()` fait désormais la vraie traversée et rend le compte exact d'octants
    (aucun NodeData, seulement des BulkMetadata) au lieu d'une majoration
    géométrique. `estimateColumns()` et `MAX_FETCH_COLUMNS` sont supprimés ;
    le plafond est maintenant `MAX_NODES = 50 000`, vérifié **pendant** la marche.
  - **Vérifié** : 28 tests `tools/rocktree-selftest.mjs` ; équivalence contre
    l'oracle sur fixtures (niveaux 17 et 20) et sur réseau réel (niveau 21,
    rayons 20 et 120 m) ; bake réel `radius 150` (594 nœuds, 793 575 sommets,
    51,5 Mo) rechargé et piloté en navigateur, `selftest.mjs` de scène au vert.
  - **Le « 91 nœuds » du bake `ge-champ-de-mars`** cité plus haut était au
    **zoom 19**, pas 20 : ce n'est pas une régression face aux 429 mesurés ici.
  - **Découvert au passage, PAS corrigé ici — issue de suivi** : ~16 % de la
    surface tournée vers le ciel est noire. Cause mesurée : la traversée retient
    les **deux jumeaux verticaux** d'une même case lat/lon (mêmes digits au bit
    vertical près). Sur 58 nœuds sombres, 57 partagent leur case avec un autre
    nœud retenu, et 53 de ces cases contiennent un nœud clair ET un nœud noir —
    Google sert un placeholder de 970 octets à texture noire pour l'un des deux,
    et les deux sont dessinés. `dropFillinAncestors()` ne les voit pas : aucun
    n'est préfixe de l'autre. **Préexistant** — l'ancienne traversée retenait
    exactement les mêmes nœuds.

- **Tuiles noires rocktree : inversion V + repli d'imagerie (issue #158)**,
  branche `issue-158-imagery` (empilée sur `issue-153-bulk-walk`).
  - **La vraie cause, trouvée sur signalement utilisateur (« elles sont dans le
    mauvais sens ») : le décodeur INVERSAIT V.** `rocktree.mjs` héritait de
    `obj.mjs` un `tv = 1 - v`. Or `obj.mjs` inverse parce que le format OBJ a
    son origine en BAS-gauche ; le protocole rocktree a déjà la sienne EN HAUT.
    Toutes les tuiles Google Earth étaient donc affichées retournées depuis
    l'issue #18 — et « textures nettes » ne l'avait pas vu, une vue aérienne
    retournée restant parfaitement nette.
  - **Comment on l'établit** : en rasterisant les nœuds au sol dans les deux
    conventions. `v` direct rend une photo aérienne cohérente du Champ de Mars
    (Tour Eiffel, Seine, pont d'Iéna, bassins reconnaissables) ; `1 - v` rend
    une mosaïque brouillée. Verrouillé par un test qui mesure la SORTIE :
    `imagery-selftest` rasterise une fixture réelle dans les deux sens et
    compare le gradient spatial moyen (12,78 direct contre 17,74 inversé).
  - **Conséquence sur le diagnostic initial** : les « 19,7 % d'aire noire »
    mesurés dans #158 étaient très majoritairement un artefact de cette
    inversion — on échantillonnait le remplissage d'atlas. V corrigé, le noir
    résiduel n'est que **0,11 %** au Champ de Mars.
  - **Repli d'imagerie** (`tools/lib/rocktree/imagery.mjs`) : là où la
    photogrammétrie de Google s'arrête vraiment, une trame au sol unique
    (cellules carrées EN MÈTRES, 0,25 m, plafonnée à 4096 de côté) est peinte
    par toute l'imagerie valable — nœuds retenus d'abord, ancêtres à
    `niveau − 4` ensuite et seulement dans les vides (`onlyEmpty`) — puis
    dilatée ; chaque texel noir prend l'échantillon de la trame au même point du
    sol. Un texel non noir n'est jamais touché.
    - Piège corrigé en route, visible seulement à l'œil : peindre en
      échantillonnant la texture aux TROIS SOMMETS puis en interpolant la
      COULEUR (Gouraud) rend une mosaïque de facettes. Il faut interpoler les
      UV et échantillonner PAR CELLULE. Verrouillé par un test au damier.
  - **Mesuré sur la sortie du décodeur, V corrigé** :

    | site | sans repli | avec repli | aire perdue |
    |---|---|---|---|
    | Champ de Mars (couverture dense) | 0,11 % | **0,02 %** | 0,00 % |
    | Martignas-sur-Jalle (plus mince) | 1,82 % | **1,30 %** | 0,00 % |

    Le repli est donc un gain marginal — l'essentiel venait de l'inversion V.
    Il reste sans contrepartie mesurable (aucune aire perdue, ~2 s de cuisson,
    4-5 nœuds de plus téléchargés).
  - **Vérifié** : 16 tests `tools/imagery-selftest.mjs` ; 28 tests
    `rocktree-selftest` inchangés ; decoder/provider/map-poly au vert ; bake
    réel rechargé, et surtout la photo aérienne reconstruite **depuis les tu/tv
    émis par le décodeur** (donc ce que prep cuit) est nette et correctement
    orientée.

- **Passe d'ergonomie — navigation clavier + manette sur tous les écrans
  (issue #123)**, branche `claude/issue-123-tj720t`.
  - `src/menu-nav.js` (nouveau) : la grammaire ↑/↓ + Entrée + Échap, écrite
    deux fois indépendamment dans `session-log.js` et `target-scan.js`, est
    extraite et généralisée. Le curseur EST le focus natif (`element.focus()`) ;
    le marqueur `▌` (U+258C, natif Departure Mono) est peint par `style.css`
    sur `:focus`, l'anneau bleu système est retiré partout (`:focus { outline:
    none }` + remplacements). Pile de navs : le plus haut visible a la main ;
    `blockNav()` rend tout inerte sous un écran non-abonné. Trois contextes ne
    s'abonnent jamais : capture du CONTROL VECTOR et rituel (flèches = donnée,
    tous deux posent un `blockNav`), vol (`input.js`). Les champs de saisie
    texte gardent leurs touches (Échap excepté) — la recherche du scanner
    reste éditable. Manette : mêmes directions (`readGamepadDir`), A active le
    focalisé, B remonte, front montant avec état initial « tenu ».
  - Abonnés : tous les écrans terminal (Home, LAST SESSION, LOCAL TERRAIN,
    FORECAST, CONTROL VECTOR, OPERATOR, OPERATOR SELECT, stub), session
    log/détail/target log, target scan (liste + fiche), scanner (panneau seul,
    pas les contrôles Leaflet), settings, bootstrap (hardware/name/registered/
    retry), post-flight (note + terrain). Intro : n'importe quel bouton manette
    passe le gate puis saute le cracktro (limite : un bouton manette n'est pas
    un geste utilisateur AudioContext — intro muette jusqu'au premier vrai
    clic/touche). Fin de vol : `[ESC] DISCONNECT` répond aussi à n'importe quel
    bouton manette nouvellement pressé (`main.js`, front montant).
  - Listes du SESSION LOG et du TARGET SCAN converties de `<pre>` en vrais
    boutons (`.terminal-row`, colonne curseur réservée, `white-space: pre`,
    défilement à 55vh) : cliquables, tabulables, lisibles par une aide
    technique — `VIEW SESSION`/`SELECT` supprimés, la rangée est le bouton.
  - Settings : `.panel` en `max-height: 92vh; overflow-y: auto` (rogné sans
    recours sur 1366×768 avant) ; ↑/↓ circule, ←/→ règle le contrôle focalisé
    (range/select via événements `input`/`change` synthétiques — les `oninput`
    existants persistent sans rien savoir du module), Échap/B referme. **En
    vol, le panneau n'écoute pas la manette** (`settings.flightActive`, posé
    par `finishBoot()`) : les sticks pilotent le drone, ils déplaceraient le
    curseur et les sliders à chaque geste.
  - Affordance au repos : filet d'un pixel sous les `.terminal-link`
    (`--rule-strong`) ; entrée directe vers le vol sur la Home — CTA
    `[ FLY — <zone> ]` (zone de la dernière session encore sur disque, sinon
    première zone locale), curseur posé dessus au repos ; sans terrain, le
    scanner reste l'entrée (issue #123, point 5).
  - Confirmations ajoutées à la capture du vecteur : Entrée et bouton A
    confirment quand le vecteur est complet, B efface (mêmes conditions que le
    bouton `CONFIRM VECTOR`).
  - **Vérifié headless** : `tools/menu-nav-selftest.mjs` (10 tests, logique
    pure : index circulaire, pas de slider borné, classement saisie de texte),
    chaîné dans `selftest:operator` ; toute la chaîne `selftest:operator`
    verte (hors `landing-selftest`/`selftest`, qui exigent la scène
    tour-eiffel absente de l'environnement de la session) ; `npm run build`
    vert ; `palette-selftest` vert (aucun littéral de couleur ajouté).
  - **Vérifié navigateur** (Chromium headless + Playwright, serveur de dev,
    1366×768) : parcours intro → bootstrap complet → Home **au clavier seul**
    (gate, CONTINUE focalisé + Entrée, nom tapé + Entrée, vecteur aux flèches
    + Entrée, REGISTERED + Entrée) ; sur la Home le focus au repos est
    `[ FLY — TOUR EIFFEL ]`, `outline: none`, marqueur `▌` peint en `::before`,
    filet 1px sous les liens ; ↓ déplace le focus ; SETTINGS atteint et ouvert
    au clavier, panneau `overflow-y: auto` avec `scrollHeight 784 > clientHeight
    705`, ←/→ règle le slider volume (60→61), ↓ en sort sans le régler, Échap
    referme et la Home reprend la main. Aucune erreur console imputable.
  - **Non vérifié** : le parcours à la **manette réelle** (la logique bouton/
    direction est celle de `readGamepadDir`, déjà éprouvée en conditions
    réelles sur bootstrap/rituel, mais A/B/front montant pas rejoués avec une
    radio) ; le ressenti visuel du marqueur sur vrai écran ; le scanner et le
    vol complet (pas de scène dans l'environnement) ; le nom d'opérateur reste
    le seul moment du jeu qui exige un clavier (pas de clavier virtuel —
    assumé, à trancher si ça gêne).
- `fetchNode()` (#168) vérifiée en direct le 2026-09-01, contre
  `kh.google.com`, chemin `0370` epoch `1005` — 1 mesh, texture décodée sans
  `sharp`.
- **Fenêtre de streaming rocktree + collision progressive** (#168, #170,
  #173, #176, branche `issue-170-rocktree-window`) vérifiées en vol le
  2026-09-01 (5ᵉ tentative de Tâche 11) sur `?live=48.8578,2.2950` (~55 m de
  la Tour Eiffel) — `Worker` réel, `fetch()` réel contre `kh.google.com`,
  Rapier réel. **Les 4 tentatives précédentes n'avaient jamais fait voler le
  drone assez loin (max ~11 m) pour déclencher un second recalcul de
  fenêtre** ; une revue finale de branche a trouvé à cette occasion un bug
  d'unité dans `nearestTrustedRadius()` (ms confondues avec des s, facteur
  ~1000) qui aurait fait planter `traverse()` à CHAQUE recalcul après le
  premier — corrigé par le commit `68ea1dd` avant cette tentative. Cette 5ᵉ
  tentative vérifie donc, pour la première fois, le comportement de
  streaming LUI-MÊME (pas seulement le boot) :
  - **Boot + streaming initial** : après 5 s, 1055 nœuds rocktree chargés,
    `window.__sim.physics`/`controller` réels et pilotables. Aucune
    régression.
  - **Vol horizontal soutenu sur ≥ 200 m** : le pilotage manuel en stick
    figé (`{throttle 0.6, pitch -0.3}`, comme le suggérait le brief) s'est
    révélé insuffisant en pratique — le contrôleur est en mode taux/acro, pas
    auto-nivelant : une commande de tangage soutenue fait boucler le drone au
    lieu de tenir une assiette. Piloté via un petit asservissement
    d'assiette maison (`window.__sim` + `physics.applyEntryState`, cible
    -25°, throttle 0.80) construit pour ce test, le drone a parcouru en
    continu **plus de 450 m** en ligne droite (`hypot(x,z)`), avec 9
    recalculs consécutifs de fenêtre observés (tous les ~50 m,
    `REFRESH_THRESHOLD_M`).
  - **`windowCenterLocal` suit bien le drone** à chaque recalcul :
    `{0,0}` → `{-0.01,-49.99}` → `{-0.06,-99.96}` → `{-0.11,-149.95}` →
    `{-0.17,-199.95}` → `{-0.22,-249.93}` → `{-0.28,-299.93}` →
    `{-0.33,-349.9}` → `{-0.38,-399.88}` → `{-0.44,-449.84}`.
  - **`nearestTrustedRadius()` reste sain sur toute la durée** : 31 à 38 m
    observés (jamais des km) — le correctif du bug d'unité tient sous
    recalculs répétés, pas seulement au premier appel.
  - **`physics._nodeColliders.size` change réellement** au fil du vol,
    confirmant que la fenêtre charge ET décharge des nœuds en vol, pas
    seulement au boot : 217 → 246 → 225 → 103 → 91 → 66 → 47 → 56 → 48 → 34.
  - **Aucune erreur console sur toute la session** (~10 min réelles) —
    en particulier aucune exception `traverse()`/`MAX_NODES`.
  - **FPS de rendu très bas dans cet environnement de vérification**
    (~1,16 fps mesuré — scène lourde à 1000+ nœuds rocktree, pas
    d'accélération GPU complète), ce qui, combiné à l'accumulateur à pas
    fixe (`FIXED_STEP=1/250s`, `MAX_STEPS_PER_FRAME=12`, `main.js`), fait
    tourner le temps simulé ~18× plus lentement que le temps réel — voulu
    (anti-spirale de la mort), mais qui explique pourquoi ce vol a demandé
    plusieurs minutes réelles pour quelques dizaines de secondes simulées.
    Sans lien avec la correction du bug d'unité elle-même.
  - **Rendu regardé, pas seulement mesuré** : capture d'écran à basse
    altitude (46 m au-dessus d'un sol à 26 m) montre un relief 3D net (crête
    avec face éclairée et face à l'ombre, ombrage cohérent) — pas de terrain
    plat. Comme documenté séparément (suivi hors périmètre), les textures ne
    sont pas câblées : les faces sont en couleur unie, pas en photo. Un petit
    objet isolé flottant dans le ciel a été observé sur une capture prise à
    très haute altitude (~1000 m, hors du vol normal) — pas creusé, à noter
    si revu.
  - **Rappel doux (`rocktree-fence.js`)** : observé indirectement — la
    progression horizontale reste continue et lisse sur les intervalles où
    `distance(drone, centre) > nearestTrustedRadius()` (le rayon de confiance
    ~31-38 m est inférieur au seuil de recalcul 50 m, donc le drone en sort
    forcément avant chaque recalcul), sans à-coup ni recul visible dans la
    trajectoire enregistrée. La magnitude exacte de la poussée (`pushMs2`)
    n'a pas été journalisée pendant ce vol précis — à mesurer directement si
    un doute apparaît.
  - **Collision après crash** : déjà vérifiée en détail à la tentative
    précédente (13,5 s tenues après impact violent) ; non rejouée ici, hors
    objet de cette tentative.
  - Rapport complet (5ᵉ tentative, remplace celui de la 4ᵉ) :
    `sim/.superpowers/sdd/2026-09-01-rocktree-streaming-window-plan/task-11-report.md`.
- **Curseur « View range » + spawn calé sur le sol réel** (#182) vérifiés en
  navigateur le 2026-09-01 : curseur Settings 100–600 m (défaut 300, persisté
  `fpvmaps.viewRange`), appliqué en vol via `setFloorRadiusM()` (selftest
  fenêtre 8/8, rouge/vert). En chassant un blocage du boot à 300 m, deux
  défauts pré-existants corrigés : le spawn ellipsoïdal fixe (+80 m) mettait
  le drone SOUS le terrain à Versailles (~175 m ellipsoïdaux — chute infinie,
  `ecefToGeodetic` → NaN, streaming gelé en silence) et gagnait de justesse
  une course de 0,5 s au Champ de Mars (~79 m) ; `bootLive()` attend
  maintenant le premier collider de la colonne (timeout 20 s) et cale
  `physics.spawn` dessus, et `frame()` saute `update()` sur lat/lon non finis.
  Vérifié à froid sur Versailles-ville (spawn recalé à 198,5 m, posé à 118 m,
  1568 meshes) et Caen (1543 meshes) à 300 m.

- **Saccades du streaming corrigées** (#184) vérifiées en navigateur le
  2026-09-01. Cause racine mesurée en trois couches : (1) tout le travail
  par nœud s'exécutait à l'arrivée, en rafales de dizaines par frame ;
  (2) surtout, chaque `addNodeCollider` sur `groundBody` forçait Rapier à
  resommer les propriétés de masse de TOUS les trimesh au step suivant —
  ~57 ms PAR STEP pendant une vague, amplifié ×15 par le rattrapage de
  l'accumulateur (frames de 700-1700 ms). Correctifs : colliders de nœuds
  SANS corps parent, files build/libération drainées sous budget de 3 ms
  par frame (`processLiveNodeWork`), fetchs triés par distance au drone
  (la box voyage depuis `traverse()`), `computeVertexNormals` supprimé
  (MeshBasicMaterial, jamais lu). Mesuré après : plus aucun step > 8 ms,
  longtasks 726 → ≤ 72 ms (reste : parse de `traverse()` sur le fil
  principal, ticket de suivi avec la politique de retry des fetchs).

- **Streaming ?live= : plus aucun gel mesurable en vol** (#187, vérifié
  navigateur le 2026-09-01). Baseline : gels continus de 60-105 ms pendant
  chaque vague. Causes trouvées par ventilation instrumentée puis piles du
  profileur : (1) le build géométrique par nœud sur le fil principal →
  déplacé dans les Workers du pool (`tools/lib/rocktree/build-node.mjs`,
  selftest de PARITÉ contre le décodeur de référence sur fixtures) ;
  (2) `traverse()` sur le fil principal → Worker dédié
  (`rocktree-traverse-worker.js` + client paresseux, sûr à l'import Node) ;
  (3) SURTOUT : le drain + la géodésie + le dispatch d'update tournaient
  DANS la boucle d'accumulation physique — une fois PAR STEP, ×12-15 en
  rattrapage, ce qui entretenait la spirale → une fois par frame ;
  (4) refit du query-BVH par add/remove de collider (164 ms/vague) → un
  `flushNodeColliders()` par frame ; (5) mipmaps des tuiles live (pire item
  du budget, 4,6 ms) → coupés, `LinearFilter` (grain léger à la
  minification, pas de moiré à l'échelle d'une fenêtre ≤ 600 m — regardé ;
  réversible en une ligne) ; + `matrixAutoUpdate=false` et boundingSphere
  précalculée dans le Worker. Résultat mesuré : 3 frames > 17 ms sur 2392
  (pire 31 ms, GC) sur deux vagues aller-retour de ~600 nœuds.

- **Boot ?live= bloquant jusqu'à la vague complète + filet anti-trou**
  (#189, vérifié navigateur le 2026-09-01). Deux causes du « chargement
  impossible » : (1) le drone était lâché dès le premier collider de sa
  colonne — en dérivant il atterrissait parfois dans du terrain pas encore
  construit ; (2) surtout, le terrain Google Earth a de VRAIS trous (nœuds
  absents/404 : l'eau du Vieux-Port de Marseille) — le drone posé GLISSE
  (moteurs primés) jusqu'au trou, tombe sous la carte, et la fenêtre le
  suivait en chargeant/déchargeant à l'infini. Correctifs : bootLive()
  draine à plein budget derrière l'écran de chargement jusqu'à vague
  complète (`pendingCount()` sur RocktreeWindow, TDD ; plafond 45 s),
  budget de drain adaptatif en vol (8 ms quand la file > 50), et
  crash-respawn quand vy < −20 avec rien en dessous jusqu'à −6 km (une
  vallée a toujours du sol dessous, un trou non). Mesuré : Paris chaud boot
  complet en 8,5 s avec 1682 meshes AU décollage ; Marseille minY −28,8
  (plus jamais −500), monde stable.

## PHASE 26 — BENCH (issue #194)

Le jeu a deux voies : `SELECT OPERATION MODE` est la nouvelle racine, FIELD est
la boucle de la Bible inchangée, BENCH est le banc. Fiction et copie : Bible §48.
Contrainte d'architecture : **D7** dans `docs/fpv-rework-architecture.md`.

### Vérifié — sans navigateur

- `node tools/bench-selftest.mjs` : **27/27**. Bornes, normalisation qui ramène
  au lieu de rejeter, sérialisation, et surtout la météo — à conditions égales le
  banc écrit **exactement** ce que le monde écrit dans `wind.js`/`rain.js`/
  `fog.js` (`simParamsOf()` partagé), tout en ayant le droit d'être physiquement
  incohérent (pluie sous ciel dégagé, purée de pois dans une tempête).
- `node tools/bench-render-selftest.mjs` : **22/22**, sur le faux DOM de
  `tools/lib/fake-dom.mjs` (même intention que `fake-audio-ctx.mjs`). Les écrans
  sont réellement montés et actionnés : sliders, selects, persistance, curseur
  qui survit au re-rendu, cas dégradés, panneau en vol.
  - **Le harnais a été vérifié par mutation** : six régressions introduites
    exprès, six détectées. Un test vert du premier coup sur un harnais neuf ne
    prouve rien tant qu'on ne l'a pas vu rougir.
- `node tools/entry-state-selftest.mjs` : + 23 checks. Sans override, le tirage
  pondéré de la Bible §20 est **inchangé graine pour graine** — c'est ce qui
  garantit que FIELD ne paie rien pour l'existence du banc.
- `Battery.setDrain(false)` mesuré : 60 s plein gaz, charge à 100 %, et **1,00 V
  de sag conservé**. Le pack tenu bend toujours sous la charge, il ne se vide pas.
- `node tools/selftest.mjs public/scenes/paristest` : diff avec la ligne de base
  d'avant travaux — **aucune**.
- `npm run build` : vert.

### NON vérifié — rien de tout ça n'a été VU

Les outils navigateur n'étaient pas disponibles dans la session qui a écrit
PHASE 26. Restent donc entièrement à juger à l'écran et aux sticks :

- **L'apparence de `SELECT OPERATION MODE` et de l'écran du banc.** Ils sont
  montés et câblés, ils n'ont jamais été regardés. Le CSS (`style.css`, bloc
  `BENCH`) n'a jamais été rendu.
- **La navigation manette** sur les deux écrans. `menuNav` gère nativement
  `<select>` et `<input type=range>` aux flèches, donc ça *devrait* marcher — ce
  n'est pas une mesure.
- **Le panneau en vol (touche `B`)** : le gel de la sim, la sortie du pointer
  lock, le recalage de l'accumulateur au retour, et surtout le **changement de
  cellule à chaud** (`physics.setProfile()` en plein vol) — jamais exécuté en vol
  réel, seulement au banc headless de `selftest.mjs`.
- **Le respawn au banc (`R`)** après un choc.
- **Le dump de frame (`F`)** : le téléchargement navigateur n'a jamais été
  déclenché.
- **Le vol libre au banc** (`terrain: live`), qui hérite de l'état de `?live=` et
  donc des issues ouvertes #178, #179, #186, #191.
- **La non-régression de FIELD de bout en bout.** Prouvée par construction et par
  les selftests, pas par un parcours joué.

### Le parcours à jouer pour clore la phase

1. **FIELD non régressé** : mode select → FIELD → Home → FLY → TARGET SCAN →
   hack → rituel → vol → pose → POST-FLIGHT → note → KEEP TERRAIN → Home. La
   session doit apparaître au SESSION LOG et les compteurs du pied de page avoir
   bougé. Puis un crash : LINK LOST → TARGET LOST → sortie, **et pas de respawn**.
2. **BENCH** : mode select → BENCH → régler → SPIN UP → vol → choc → **respawn
   immédiat** → `B` → changer de famille, monter le vent, bouger l'heure, couper
   la clôture **sans redémarrer** → sortie.
3. **Étanchéité** : juste après (2), SESSION LOG, TARGET LOG et le pied de page
   sont **identiques à avant**. C'est l'assertion centrale du mode.
4. Les raccourcis dev sautent toujours le mode select : `?scene=paristest`,
   `?live=48.8584,2.2945`, `?family=race5`.

### Deux découvertes faites en mesurant la ligne de base (pas causées par PHASE 26)

- **#195** — `fog off reproduces the rain-only density to the bit` échoue sur
  `main`. Le check construit `FogField`/`RainField` isolément : aucune dépendance
  au disque, c'est un vrai écart de modèle.
- **#196** — `npm run selftest:operator` **s'arrête net** au milieu de la chaîne
  quand `public/scenes/tour-eiffel` n'est pas sur le disque, et la trentaine de
  selftests qui suivent `landing-selftest` ne tournent jamais. On croit la suite
  verte alors qu'elle n'a pas tourné. Sur cette machine il n'y a que `paristest`,
  et `public/scenes/` est gitignored.

  **Conséquence pratique pour toute reprise** : lancer
  `node tools/selftest.mjs public/scenes/<slug-présent>`, et ne pas se fier au
  code de sortie de `selftest:operator` tant que #196 n'est pas corrigée.

- **#124** (« régression : le selftest rituel est rouge sur main ») est **verte**
  aujourd'hui — l'issue est périmée, elle peut être fermée.


## PHASE 27 — FIELD est un seul écran (issues #209, #211)

Bible §4, première ligne : « Le `GLOBAL SCANNER` est le menu principal après
l'initialisation. » #208 avait construit l'inverse — une Home calme avec une
vignette figée et le scanner derrière un CTA. Le « pas un dashboard » de §30
vise l'empilement de panneaux froids, pas la carte.

FIELD est désormais **un écran, deux colonnes, deux états** : à gauche ce qu'on
lit et ce qu'on choisit, à droite le monde. Tracer une zone remplace la colonne
GAUCHE par le rail du scanner ; la carte ne bouge pas d'un pixel. `[ GLOBAL
SCANNER ]` a disparu — il n'y a plus d'ailleurs où aller.

### Vérifié — sans navigateur

- `terminal-render-selftest` : **13/13**. Dont la promesse centrale, testée sur
  la RÉFÉRENCE du nœud de carte et pas sur sa présence : un équivalent
  reconstruit serait un remontage de Leaflet.
- `archive-render-selftest` : **5/5** (nouveau). Les écrans froids que la Home
  range derrière ARCHIVE, convertis en `createElement` et donc montables sur le
  faux DOM pour la première fois.
- `scanner-selftest` : 29 → **36**, dont `acquireStep()`, l'enchaînement
  sonde → acquisition en pur.
- `session-log-selftest` : 17 → **20**, dont `fit()`.
- Chaîne `selftest:operator` : **845 assertions, 0 échec** — hors
  `landing-selftest`, qui reste rouge tant que #196 n'est pas corrigée.

### Vérifié à l'œil — Chromium headless piloté en CDP

Écran par écran, ce que #209 et #211 ont corrigé :

- Un écran plus haut que la fenêtre était **injoignable** : `.bootstrap`
  centrait puis coupait, et `html, body` sont en `overflow: hidden`. BUILD NOTES
  et TARGET LOG perdaient titre ET `[ BACK ]`.
- **BUILD NOTES était le seul écran sans `menuNav`** : Escape sans effet.
- **OPERATOR annonçait TARGETS 0** en lisant `op.targetLog`, clé supprimée par
  PHASE 17 (D1), pendant que le pied disait « 9 TARGETS LOGGED ».
- Les tables de journal cessaient d'être des tables : `padEnd()` ne coupe pas.
- L'attribution Leaflet se lisait comme un bandeau blanc de navigateur sur les
  DEUX cartes : Leaflet injecte sa feuille en `<style>` inline **à l'exécution**,
  à spécificité égale mais plus tard dans la cascade. Le `background:
  var(--scrim)` de #207 n'avait jamais rien peint.
- La mise en page de FIELD débordait sur `SELECT OPERATION MODE` et l'écran du
  banc, qui montent avec `terminal-home` pour en partager la typographie. FIELD
  a maintenant sa propre classe, `terminal-field`.

Deux manques que seul le rendu révèle :

- `DRAW BOX` vit dans le rail, caché au repos, donc **rien ne permettait de
  commencer**. D'où `[ DRAW AN AREA ]`.
- **La carte était visible mais SOURDE.** `#ui` est en `pointer-events: none` et
  seuls `button, input, select, label` reprennent la main (`style.css:87-88`).
  Une carte Leaflet est un `<div>`, ses contrôles de zoom sont des `<a>` :
  l'ancienne règle `.scanner { pointer-events: auto }` était ce qui la rendait
  manipulable, et elle a disparu avec le plein cadre. Aucun selftest de rendu ne
  pouvait l'attraper — le faux DOM ne calcule pas de style et l'arbre était
  correct. D'où le garde-fou dans `palette-selftest`, vérifié dans les deux sens.

**Piège à retenir** : tout écran plein cadre qui porte autre chose qu'un
`button`/`input`/`select`/`label` interactif doit reprendre `pointer-events`
lui-même. Le symptôme est silencieux : ça s'affiche, ça se met à jour, ça
n'écoute rien.

### Non vérifié

- **La navigation manette dans les deux colonnes.** `menuNav` est attaché à
  `s.el` pour la Home et au rail pour le scanner : deux navigations coexistent
  désormais sur le même écran, ce qui n'était jamais arrivé. Demande une manette
  réelle.
- **Le lot B** (#212) : météo et densité de signal portées sur les cadres de la
  carte. À décider après avoir vécu avec le lot A.
- **Les fenêtres étroites** (< 1100 px) : la règle d'empilement est écrite,
  jamais regardée.
- #210 : une scrutation manette peut survivre à son écran.
- #213 : deux `confirm()` subsistent (REMOVE terrain, RESET settings).
- #214 : une rangée à nom long déborde sur l'écran complet `LOCAL TERRAIN`.


## Reconnaissance FIELD : OSD et ligne HUD du banc (issue #217)

Signalé en jouant : un vol live depuis le scanner donnait le drone par défaut
**sans aucun HUD**.

`openFlightSession()` sortait sur `if (OPTS.live || MODE.live) return;`, avant
toute la section caméra + OSD. Le banc, lui, la traverse — sa seule garde est
`if (!MODE.bench)` autour de `session.open()`. La garde avait été écrite pour
`?live=`, un raccourci de **dev** où rien n'est monté ; #206 a fait de
`MODE.live` un vrai mode joueur et lui a fait hériter de la garde telle quelle.

Ce n'était **pas** la panne `NO_OSD` de `drone-osd-model.mjs` : avec la graine
`dev::<famille>`, les douze combinaisons famille × mode rendent une disposition.
Le code d'installation n'était jamais atteint.

- La reconnaissance emprunte maintenant le **chemin du banc** : tout tourne sauf
  `session.open()`. `?live=` garde sa sortie immédiate.
- Le drone d'une reconnaissance est le **tien** — pas de hack, pas de cible —
  donc graine stable et la même machine d'un vol à l'autre. C'est ce qui la
  distingue d'un vol de terrain, où la machine volée est celle de la cible.
- **`HUD : CLASSIC / CLEAR`** est une ligne du BANC. `CLEAR` coupe l'OSD du
  **drone** seulement, ce que `droneOsdLayout()` rend déjà pour `NO_OSD` — rien
  en aval n'a à connaître le réglage. L'incrustation FPVTP! ne bouge pas : elle
  porte `PHOTO READY` et la fin de vol. Une reconnaissance ne lit pas ce
  réglage : `applyBenchConfig()` se garde sur `MODE.bench`, et #194 a coûté un
  bug entier à démêler l'inverse.
- Le HUD annonçait `SESSION` sur un vol qui n'ouvre aucune session. La décision
  sort en fonction pure `flightLabel()` — invariant de fiction, pas de mise en
  forme — et dit `BENCH`, `RECON` ou `SESSION`.

### Vérifié en vol réel

Terrain Google streamé, Chromium headless piloté en CDP : l'OSD drone est dans
l'image (`00:06`, `16.8V`, `F4`), la ligne dit `RECON 00:07`, et
`operator-state/*.json` ne bouge pas d'un octet — sessions 22 → 22,
`sessionSeq` 22 → 22, `targetSeq` 10 → 10. **L'invariant de #206 tient** : une
reconnaissance n'écrit rien.

Non vérifié : `HUD CLEAR` en vol au banc (la ligne est rendue et le modèle
testé, le vol lui-même ne l'a pas été).


## Non vérifié / à faire

- **Audio spatial — acoustique du lieu** (issue #122, branche `music-prompts-v2`).
  Le monde répond : retard, quantité et couleur des réflexions suivent la
  géométrie.
  - **Aucun rayon supplémentaire.** `space.update()` relit la rosace que
    `physics.probeWind()` lance déjà une fois par pas de physique pour l'ombre
    de vent (`physics.probe`, accesseur en lecture seule ajouté pour ça).
  - **Pas de ConvolverNode, un réseau de retards.** Une réponse impulsionnelle
    est un buffer figé, or le pré-delay doit changer à chaque mètre parcouru :
    il faudrait fabriquer et échanger un buffer par frame, ce qui claque et ce
    que la discipline « aucun nœud après le démarrage » interdit. Quatre lignes
    de retard, amortissement DANS la boucle (les aigus meurent plus vite que
    les graves, comme dans une vraie pièce), 15 nœuds construits une fois.
  - **La grandeur qui porte tout est le pré-delay** : l'aller-retour du son
    jusqu'à la surface la plus proche, `2·d / 340`. C'est une mesure, pas un
    réglage, et c'est cet écart-là qu'on entend en rasant un mur — pas « il y a
    plus de réverbe ».
  - **Vérifié en Node** : `tools/space-selftest.mjs`, 14 tests ; suite complète
    verte, exit 0, 585 assertions. `createDelay` ajouté au faux contexte.
  - **Vérifié au navigateur** (CDP) : 15 nœuds au démarrage, **0 créé sur
    300 frames de vol**, aucune erreur. Plage relevée sur six géométries
    synthétiques, cible atteinte au dixième de ms : plein ciel 140 ms / wet
    0,06 → contre une façade 4,7 ms / wet 0,55.
  - **Piège de méthode, noté pour la prochaine fois** : la première mesure
    donnait 4 ms partout. La boucle de rendu appelle `space.update()` à chaque
    frame et écrasait les injections avec la géométrie réelle — le drone était
    posé au sol. Il faut neutraliser `space.update` pendant une injection.
  - **DEUX BUGS ENTENDUS EN VOL, corrigés** (branche `fix-flutter-echo`) :
    - *« Un écho infini qui devient un bruit horrible. »* Pas une divergence,
      de l'ACCUMULATION. Une réverbération se conçoit pour des transitoires ;
      un moteur de drone est un son CONTINU. Un peigne bouclé au gain g
      alimenté en continu converge vers 1/(1-g) fois son entrée — à g=0,92
      c'est ×12,5, et il y en avait quatre sommés sans compensation. Mesuré au
      navigateur, même lieu, bruit continu à -16,8 dB en entrée : la
      réverbération SEULE sortait à **-10,8 dB avec un pic à 1,28**, donc plus
      fort que ce qui l'alimentait et au-delà de la pleine échelle. Après
      correction : **-33,7 dB, pic 0,10** — 22,9 dB d'écart. Chaque peigne
      renvoie désormais son signal pondéré par (1-g)/N, ce qui rend le niveau
      du mouillé indépendant de la durée de queue.
    - *« Un tour d'hélice = un écho. »* Flutter echo : quatre peignes bouclés
      sans diffusion résonnent à 1/T, soit 23 à 51 Hz, et ce battement posé sur
      un son déjà périodique s'entend comme un bégaiement. Ajout de trois
      allpass de Schroeder EN SÉRIE après le banc de peignes. Attention :
      le BiquadFilter `allpass` de Web Audio est un allpass du second ordre, il
      déphase mais ne retarde rien — il fallait le construire à la ligne à
      retard.
    - *« Ça ne se coupe pas à la fin de session. »* `space.silence()` existait
      mais n'était appelé nulle part, et il ne coupait que le wet : l'énergie
      restait dans les boucles. Il ouvre maintenant aussi les contre-réactions,
      et il est appelé sur `linkDead` (crash) ET sur `closes === 'LANDED'`.
    - Plafond de contre-réaction 0,92 → 0,70 ; queue maximale 2,2 s → 1,1 s
      (l'ordre de grandeur d'une rue urbaine réelle) ; longueurs de peigne
      reprises sur des rapports premiers entre eux (23 : 31 : 41 : 53 ms).
    - `tools/space-render-selftest.mjs`, 10 tests, verrouille l'invariant qui
      manquait : le gain permanent du réseau doit valoir 1 quelle que soit la
      durée demandée.
  - **NON ÉCOUTÉ depuis la correction.** Les bornes de `REVERB` (quantité,
    amortissement, durée) restent raisonnées : seul le pré-delay est physique.
    Le niveau du mouillé est maintenant volontairement discret (-15 dB sous le
    sec au maximum) — après un « bruit horrible », mieux vaut pécher par
    prudence et remonter à l'oreille.

- **Qualité de génération — piste ouverte, non conclue.** La musique est jugée
  « un peu plate » à l'écoute. Mesuré : `steps` seul n'aide pas (8→50 à cfg 1
  DÉGRADE l'air de -16,7 à -19,5 dB et la largeur de -12,2 à -14,0) ; seul
  `cfg 7` améliore les deux (-13,8 et -9,3) mais sort à -5,3 LUFS avec un LRA
  de 4,4, donc déjà écrasé. **Les mesures ne distinguent pas « profondeur » de
  « saturation »** — quatre versions du même prompt égalisées à -14 LUFS
  attendent une écoute comparative. Deuxième suspect jamais testé : le limiteur
  du bus (-3 dB, 20:1, release 100 ms) est calibré pour la synthèse moteur ;
  moteur et musique se somment et tapent dedans ensemble, ce qui écrase tout et
  pompe au rythme des gaz.

- **Arc musical — issue #122** (branche `music-arc`). Renverse la règle « pas de
  musique » de PHASE 18 : la Bible §34 et la roadmap PHASE 18 ont été amendées
  dans le même mouvement, sans quoi le prochain travail audio serait reparti de
  l'ancienne règle.
  - **Architecture** : modèle pur `tools/music-model.mjs` + rendu `src/music.js`,
    comme `ui-audio-model.mjs` / `ui-audio.js`. La musique n'est **pas** un
    neuvième événement d'interface : vocabulaire toujours clos à huit entrées,
    garde-fou toujours vert, la musique a son propre bus (`musicIn`) et son
    propre volume (slider MUSIC, `fpvmaps.musicVolume`, défaut 0,7).
  - **L'arc tient dans un scalaire** `intensity` ∈ [0,1] qui pilote un lowpass
    (380 Hz → 19 kHz, en log) et un gain (-20 dB → 0 dB). MENU 0,55 · HACK 0,12
    (« la musique de la pièce d'à côté ») · DROP 1,0 en 0,4 s · vol =
    `flightIntensity(télémétrie)` avec un plancher à 0,30. Crash : coupe à
    `flightEnd.out.linkDead`, c'est-à-dire **à l'instant du choc**, avec
    l'image — pas 1,6 s plus tard à la ligne « LINK LOST ». Pose : fondu 2 s.
    POST-FLIGHT reste silencieux.
  - **Pipeline** : `npm run add-music` → `music-gate` → `music-loop` →
    `npm run music-review`. Stable Audio 3 Medium en local, chemin donné par
    `FPVTP_STABLE_AUDIO`. Staging gitignoré, seuls les `.opus` validés à
    l'oreille entrent dans `public/music/` + `public/music.json`.
  - **Vérifié en Node** : `npm run selftest:operator` vert (49 tests neufs dans
    `music-selftest.mjs`), suite complète à 489 assertions, exit 0.
  - **Vérifié au navigateur** (Chromium headless via CDP, `?scene=bastille`) :
    manifeste 21/21 servi et validé, décodage réel en stéréo 48 kHz avec des
    durées conformes au manifeste à 3 décimales, et surtout
    **`music.nodesCreated` ne bouge pas de 0 sur 450 frames de vol** —
    `play()` crée 4 nœuds, `setIntensity()` n'en crée aucun. Aucune erreur
    console.
  - **Mesures qui ont corrigé le code** (lot de calibration de 21 morceaux de
    90 s, 3 par pool) :
    - Le gate rejetait 20/21 sur des critères qui mesuraient la mauvaise chose.
      La crête d'un candidat brut n'a pas de sens (19/21 dépassent 0 dBFS en
      inter-échantillon, comportement normal d'un master fort) et
      `music-loop.mjs` la corrige de toute façon. Et le seuil d'écart RMS à
      2 dB rejetait exactement le dub techno et l'ambiance de menu — les pools
      dont l'identité EST d'être égale. Bornes recalibrées, distribution
      complète écrite dans `tools/music-gate.mjs`.
    - La normalisation par gain statique laissait la bibliothèque s'étaler de
      -14 à -17,1 LUFS (le plafond de crête plafonnait le gain sur les masters
      denses), ce qui ruinait le seul point de calibration du mix. Remplacée
      par `loudnorm` deux passes en `linear=true` : écart ramené à **0,3 dB**
      (-13,8 à -14,1 LUFS sur les 21).
  - **Plancher d'intensité relevé après écoute (0,30 → 0,62)** et lissage rendu
    ASYMÉTRIQUE (montée 0,25 s, descente 1,80 s). En FPV on coupe les gaz sans
    arrêt ; à 0,30 la musique tombait à -14 dB derrière une coupure à 1,2 kHz,
    c'est-à-dire qu'elle disparaissait à chaque geste normal de pilotage.
    Mesuré : couper les gaz à 15 m/s retirait 5,6 dB, il en retire 1,9 — et
    avec la descente lente, un chop d'une demi-seconde n'en parcourt que 24 %,
    soit 0,46 dB, inaudible. Le poids du manche est aussi passé de 0,40 à 0,25
    au profit de la vitesse : le manche est nerveux, la vitesse a de l'inertie.
  - **NON CALIBRÉ — `FLIGHT.speedRefMs`** dans `tools/music-model.mjs`. Un vol
    scripté en boucle ouverte ne produit pas de vitesses représentatives (sans
    boucle de pilotage le drone tombe : le relevé obtenu mesurait la chute
    libre, pas le vol). Se fait manche en main, pendant la séance d'écoute ; le
    snippet de console est écrit au-dessus de la constante.
  - **NON ÉCOUTÉ**, et c'est le critère d'acceptation. 21 candidats sont prêts
    dans `.music-staging/`, aucun n'est entré dans le manifeste. Rien ne doit
    être commité dans `public/music/` avant `npm run music-review`. Cette dette
    s'ajoute à celle, déjà ouverte, de PHASE 18 / #106 / #107 : le mixage
    complet (moteur + UI + rituel + musique) n'a jamais été entendu.

- **PHASE 21 — Lore / RTC v0** (issue #58). Un crew — `root` (tranche),
  `jensen` (agent double, délibérément rare), `mikhail` (garde-fou technique),
  `cron` (un processus, pas un personnage) — commente depuis un corpus écrit
  hors-ligne et interpolé avec l'état réel du jeu. `vex` est retiré du canon
  (D7) : ses lignes de la Bible §9 et du boot (`src/bootstrap.js`) sont
  réattribuées à `root`/`mikhail`/`cron`.
  - **Vérifié sans navigateur** (`node tools/dialogue-selftest.mjs` : 71
    vérifications, tout passe ; `node tools/buildnotes-selftest.mjs` : 8
    vérifications, tout passe) : le moteur de sélection (bassin, éligibilité,
    trois seaux de refroidissement, poids de rareté, rareté de jensen — jamais
    plus d'une fois toutes les 12 répliques), le rendu de slots qui jette sur
    tout `{…}` non résolu, `validateCorpus()` et `findDuplicates()` passés sur
    le shard `ACQUIRE_AREA` livré au complet (aucune erreur, aucun quasi-doublon
    au-dessus de 0,75 de Jaccard), le pack de secours embarqué (`FALLBACK`)
    valide et sans aucun `requires`, un événement câblé pour chacun des IDs de
    la v1 même sans réseau, et l'isolation de l'outillage de génération
    (`tools/dialogue/generate.mjs`, `prompts/`) : aucun module de `src/` ne
    l'importe, `public/dialogue/` ne contient que des données.
  - **Vérifié dans le navigateur** (le contrôleur a piloté un vrai Chromium) :
    le flux RTC survit à un redessin du curseur sans perdre son historique ;
    aucun `{slot}` non résolu n'apparaît sur le chemin joué ; les répliques
    arrivent une par une, jamais en bloc ; le pack de secours embarqué
    fonctionne quand le corpus réseau est indisponible. **Un défaut serveur a
    été trouvé et corrigé à cette occasion** : `dialogueMemory` était rejeté
    par la liste blanche du PATCH opérateur (`OP_WRITABLE_KEYS` dans
    `tools/map-api-plugin.mjs`), ce qui cassait silencieusement la persistance
    de la mémoire anti-répétition et produisait une boucle de retentative sans
    fin côté client. Corrigé (`dialogueMemory` ajouté à la liste blanche,
    régression couverte par `tools/session-api-selftest.mjs`).
  - **Non vérifié** : la qualité perçue du corpus sur une longue partie — un
    jugement de ton qu'aucun selftest ne mesure, exactement comme l'écoute
    pour PHASE 18 et pour l'audio de l'intro (voir plus bas). **Ce n'est pas
    vérifié, seulement écrit avec soin.** De même, le silence pendant le
    burst du rituel (D9 : `buildContext()` n'est jamais appelé pendant
    l'armement du CONTROL VECTOR) a été relu dans le code mais pas observé en
    vol — la lecture de code n'est pas une observation.
  - Dette connue, volontairement non traitée ici : `sim/public/dialogue/*.json`
    est indenté à deux espaces alors que le reste du dépôt utilise des
    tabulations — le fichier appartient à une génération de corpus en cours au
    moment de cette tâche, non touché ; suivi en issue de suivi séparée.

- **PHASE 18 — Audio final** (issue #55). Langage sonore de trois familles à
  côté de la synthèse moteur, qui est conservée telle quelle.
  - **Vérifié en Node** (`npm run selftest:operator`, 52 tests neufs répartis
    sur quatre selftests) : le vocabulaire d'événements est clos à sept
    entrées et un balayage de `src/` fait échouer le test si un huitième son
    apparaît — garde-fou lui-même vérifié en y glissant un
    `uiAudio.play('BUTTON_CLICK')`, qui a bien été attrapé. L'hystérésis du
    lien ne produit ni doublon, ni rebond sur un plateau tenu à la frontière,
    ni annonce de retour sans perte préalable. Les six partitions de rituel
    sont réellement distinctes et leur impact final tombe dans les 10 derniers
    pourcents de la variante, à V1 comme à V4.
  - **Vérifié dans le navigateur** (Chromium via CDP, `?scene=tour-eiffel`) :
    l'`AudioContext` passe bien à `running` au premier geste ; le graphe monte
    21 nœuds au boot, ce qui est exactement 5 notes de signature + `TERRAIN
    READY` + les 3 nœuds permanents de la porteuse ; **zéro nœud créé sur
    ~150 frames de vol**, donc la porteuse ne fuit pas ; les six rituels et
    les sept événements jouent sans exception ; aucune erreur console ni rejet
    non géré après une session complète, crash compris.
  - **Non vérifié — et c'est le cœur du critère d'acceptation** : *rien de
    tout cela n'a été écouté.* Le timbre de la signature de boot, la
    reconnaissabilité des six familles à l'oreille, et surtout l'équilibre du
    mixage (issue #11) restent entièrement à juger. Les niveaux livrés
    (`LEVEL` dans `src/ui-audio.js`, `UI_TRIM` dans `src/audio-bus.js`) sont un
    point de départ raisonné, **pas une mesure**. La checklist d'écoute à
    dérouler est la Tâche 7 du plan
    (`docs/superpowers/plans/2026-08-29-phase-18-audio-final.md`).
  - Changement de comportement à connaître : le volume est passé **après** le
    limiteur (il était avant). Le seuil du limiteur ne dépend donc plus de la
    position du curseur, ce qui est la condition pour que « le mixage » désigne
    une chose unique — mais cela veut dire que l'équilibre perçu à un volume
    donné a pu bouger par rapport à avant PHASE 18.

- **Intro demoscene au lancement** (issue #106) et **rituels : tension +
  explosion stéréo** (issue #107), branche `intro-rituals-audio`.
  - Intro : écran `FPVTP! // PRESS ANY KEY` (c'est lui qui débloque
    l'`AudioContext`), puis ~7 s de cracktro — logo ASCII en sinus-scroll,
    plasma/raster bars en palette demo, scrolltext greetings — et une partition
    chiptune qui **se résout sur la signature de boot existante**, donc `BOOT`
    reste joué une seule fois par chargement. Skippable à tout instant.
    `?scene=` bypasse tout et garde `armBoot()` inchangé.
  - Rituels : un riser monte pendant la saisie du vecteur
    (`uiAudio.ritualTension(k)`, branche permanente à la manière de la
    porteuse) et retombe sur une erreur ; la complétion déclenche une
    détonation en couches (sub + nouvelle voix `blast`) suivie d'éclats
    répartis dans le champ stéréo (champ `pan` → `StereoPannerNode`). La
    première moitié de chaque partition de famille est intacte : l'identité
    §36 tient, seule la queue devient explosive.
  - **Vérifié en Node** : `npm run selftest:operator` vert, 417 lignes `ok`
    (dont `intro-selftest.mjs` neuf, et le balayage du vocabulaire désormais
    clos à **huit** entrées avec `INTRO`).
  - **Vérifié dans le navigateur** (Chromium headless via CDP, port dev
    dédié) : gate → intro → démontage complet → Home ; skip immédiat même en
    martelant la touche (double `BOOT` impossible, garde aux deux niveaux) ;
    touche **maintenue** au gate qui ne saute plus l'intro (`e.repeat`, même
    convention que `src/input.js`) alors qu'une seconde frappe distincte la
    saute toujours ; `?scene=` sans intro ; aucune erreur console imputable à
    la branche.
  - **Non vérifié — et c'est le critère d'acceptation** : *rien n'a été
    écouté.* La montée de tension, la violence de l'explosion, le placement
    stéréo des éclats et le niveau de l'intro (`LEVEL.intro = 0.28`, posé par
    analogie et non mesuré) restent à juger à l'oreille, comme pour PHASE 18.
  - Polissages différés en issue de suivi : `_introMaster` jamais déconnecté,
    skip pendant la résolution qui rejoue la signature depuis la première
    note, `killRitualTension()` qui coupe sec sur un rituel abandonné.

- **PHASE 14** : le crash, la pose et le rasant ont été vérifiés en vol piloté
  (tour-eiffel) — voir le détail dans le bloc PHASE 14 ci-dessus. Restent non
  vérifiés : le ressenti (rythme de la séquence, lisibilité de `LANDING
  DETECTED` par-dessus l'image encore vivante) et le cas `LINK_OFF` (lien
  coupé par le joueur au moment du crash), non exercé en vol.
  - La nouvelle séquence de pose temporisée (`LANDING_TIMELINE`, ordonnancement
    et armement d'`exitArmed` en fin de séquence) n'est vérifiée qu'en headless
    (`tools/flight-end-selftest.mjs`, 20 tests) ; pas encore rejouée dans le
    navigateur — le rythme perçu (2,2 s, fondu à 0,6-1,0 s) et l'annonce
    `[ESC] DISCONNECT` sur une pose réelle restent à éprouver en vol piloté.
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

