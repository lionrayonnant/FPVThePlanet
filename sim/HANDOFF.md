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

## Non vérifié / à faire

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

