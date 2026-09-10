# Handoff — POC simulateur de drone FPV (Paris / Tour Eiffel)

État au 2026-09-06, réorganisé le 2026-08-29. Écrit pour reprendre le travail
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
| [essaim.md](docs/handoff-archive/essaim.md) | l'essaim de drones (#29) : le sillage, le budget de rayons, les éclaireurs, les cinq axes d'échantillonnage |

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
une autre : `npm run add-map -- "Nom" <lat> <lon>` — voir `docs/manuel.md` section
« Ajouter une carte » pour le détail des options et le dimensionnement de
`--radius`.

Plan d'origine (contexte de la décision d'architecture) :
`/home/user/.claude/plans/j-ai-une-carte-de-flickering-cat.md`


## Vérifié

- **Issue #26 — l'onglet `DATA`** (branche `feat/data-tab`) : `ARCHIVE` est
  renommé et devient une page qui défile, neuf sections dans l'ordre de la spec
  `docs/superpowers/specs/2026-09-08-flight-track-enriched-map-data-design.md`.
  Toutes les séries viennent de `tools/data-model.mjs` (pur, 22 tests) et tout
  le dessin de `src/graph.js`. `tools/data-render-selftest.mjs` fige l'ordre des
  sections, le `NO TRACK` des trois qui ont besoin d'une piste, et le dépli des
  cibles sous `FAMILIES` (le `TARGET LOG` a disparu en tant qu'écran).
  `npm run selftest:ci` et `npm run build` passent.
  - **Non vérifié** : le rendu réel des canvas — aucun navigateur n'a ouvert
    cette page. Le faux DOM ne donne pas de contexte 2D, donc `src/graph.js` y
    renonce silencieusement et les tests ne jugent que l'arbre.
  - **Non vérifié** : les sections `HOW THEY DIED`, `STICKS` et `PROFILE` avec
    de vraies données. Elles lisent l'index de pistes de #24, qui n'est pas
    encore fusionné : `src/track-index.js` est le seul point d'entrée, et sans
    route côté serveur il rend une liste vide.

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
  - PHASE 10 construisait puis a retiré un rituel manuel ici (`CONTROL
    VECTOR` + QTE) — voir la note sous PHASE 20 pour le retrait (issue #33).
    Ce que PHASE 09 pose reste l'état réel : `[ JACK IN ]` seul.
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
  - _Révisé 2026-09-08 — l'atterrissage a été retiré (#10) ; ce bloc est historique._
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
  - _Révisé 2026-09-08 — l'atterrissage a été retiré (#10) ; ce bloc est historique._
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
    seconde — tension déjà documentée dans la spec, à traiter par `[ JACK IN ]`
    (PHASE 10) ou `input.js`, pas par ce module. Le contrôle de sécurité
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
    vidéo / son — aucun contrôle météo, aucune clé `fpvtp.wind*|rain|fog` ;
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
- **PHASE 20 — langage ASCII / pixel art / primitives demo scene (issue #57)** :
  - `src/ascii.js` : `asciiTag` (3 usages info `[+]`/`[!]`/`[*]` de la Bible
    §40), `asciiChain`, `bigText`/`BIG_FONT` (police banner 5 lignes × 3
    colonnes, A-Z + espace/!/-). `tools/ascii-selftest.mjs` : 7/7 OK.
  - `src/pixel-icons.js` : 9 icônes 12×12 (`ICON_NAMES`, Bible §41), rendu
    `iconSVG` en rects `crispEdges` (aucun emoji), `faviconDataURI` — le
    favicon de `index.html` est ce drone pixel art. `tools/pixel-icons-selftest.mjs` :
    5/5 OK.
  - **Révisé (2026-09-09, issue #33) — les primitives ne servent plus qu'à
    l'intro.** PHASE 20 avait construit 11 primitives ASCII composables
    (`RITUAL_PRIMITIVES` dans `src/hack-grammars.js`) pour la culmination du
    rituel d'acquisition, consommées par `src/ritual.js` (retiré) et
    partagées avec `src/intro.js` depuis l'issue #124. Le rituel étant retiré,
    `intro.js` en est désormais le **seul** consommateur, à chaque lancement
    du jeu — pas seulement à l'acquisition d'une cible.
    `tools/ritual-selftest.mjs` et `tools/ritual-bench.mjs` sont renommés
    `intro-primitives-selftest.mjs` / `intro-primitives-bench.mjs` : même
    contrat `{ t, seed, dur }`, même budget 2 ms/frame ; le garde-fou
    d'acceptation #57 devient `EVENT_MODULES = new Set(['hack-grammars.js',
    'intro.js'])` (`ritual.js` disparu de la liste blanche avec lui).
    `RITUAL_PRIMITIVES` garde son nom — l'intro les nomme déjà ainsi
    (`style.css`) et renommer aurait élargi le diff sans le justifier.
  - Le détail historique de la vérification par famille de hack (six
    familles, culmination visuelle, vecteur de secours) décrivait un écran
    qui n'existe plus ; voir la note de révision de la Bible §15 et le bloc
    PHASE 10 de la roadmap pour ce qui l'a remplacé (`[ JACK IN ]`).

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

- **Apple Flyover retiré des fournisseurs (2026-09-07).** `tools/lib/providers/
  flyover.mjs` et le dépôt `flyover-reverse-engineering/` (outil Go, jeton,
  tuiles brutes) sont supprimés ; `google-earth` est désormais le seul
  fournisseur inscrit (`tools/lib/providers/index.mjs`), toujours son propre
  défaut. Le contrat par fournisseur (`plan`/`probe`/`fetch`/`tileDirPath`/
  attribution) et le dispatch par `opts.provider` restent en place, écrits pour
  un futur second fournisseur. Le décodeur OBJ (`tools/lib/decoders/obj.mjs`,
  historiquement le seul format que produisait l'exporteur Go) reste lui aussi
  en place, générique et réutilisable. Une entrée sans `provider` (schéma
  d'avant le multi-fournisseur, ou d'avant ce retrait) retombe désormais sur le
  défaut du registre plutôt que sur `'flyover'`, qui n'existe plus
  (`rawTileDirFor`/`add-map-core.mjs`). L'attribution des scènes déjà bakées
  chez Flyover (manifest sans `provider`, ou `provider.id === 'flyover'`) est
  volontairement conservée dans `src/provider-credit.js` (`LEGACY_PROVIDER`) :
  ce n'est pas un fournisseur actif, c'est la seule façon de garder
  l'attribution Apple correcte sur des scènes déjà sur disque. Le narratif
  ci-dessous (Stages 1-3, issue #18) décrit l'introduction du multi-fournisseur
  et reste tel quel comme histoire de session ; ne pas le lire comme décrivant
  l'état courant.

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
    `blockNav()` rend tout inerte sous un écran non-abonné. Deux contextes ne
    s'abonnent jamais : vol (`input.js`) et *(retiré, issue #33)* la capture
    du CONTROL VECTOR et le rituel, qui posaient tous deux un `blockNav` sans
    jamais l'ouvrir sur Échap — c'est ce trou d'entrée qui a motivé leur
    retrait. Les champs de saisie
    texte gardent leurs touches (Échap excepté) — la recherche du scanner
    reste éditable. Manette : mêmes directions (`readGamepadDir`), A active le
    focalisé, B remonte, front montant avec état initial « tenu ».
  - Abonnés : tous les écrans terminal (Home, LAST SESSION, LOCAL TERRAIN,
    FORECAST, OPERATOR, OPERATOR SELECT, stub — CONTROL VECTOR retiré, issue
    #33), session
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
  - *(retiré, issue #33)* Confirmations ajoutées à la capture du vecteur :
    Entrée et bouton A confirmaient quand le vecteur était complet, B
    effaçait — tout l'écran `CONTROL VECTOR` a disparu avec le vecteur.
  - _Révisé 2026-09-08 — l'atterrissage a été retiré (#10) ; ce bloc est historique._
  - **Vérifié headless** : `tools/menu-nav-selftest.mjs` (10 tests, logique
    pure : index circulaire, pas de slider borné, classement saisie de texte),
    chaîné dans `selftest:operator` ; toute la chaîne `selftest:operator`
    verte (hors `landing-selftest`/`selftest`, qui exigent la scène
    tour-eiffel absente de l'environnement de la session) ; `npm run build`
    vert ; `palette-selftest` vert (aucun littéral de couleur ajouté).
  - **Vérifié navigateur** (Chromium headless + Playwright, serveur de dev,
    1366×768) : parcours intro → bootstrap complet → Home **au clavier seul**
    (gate, CONTINUE focalisé + Entrée, nom tapé + Entrée — *(historique, écran
    disparu, issue #33)* vecteur aux flèches + Entrée, REGISTERED + Entrée) ;
    sur la Home le focus au repos est
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
  `fpvtp.viewRange`), appliqué en vol via `setFloorRadiusM()` (selftest
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

- **#57 — le randomart est l'empreinte de la cible.** Graine = `buildSeed` de
  l'exemplaire. Trois moments : le fou trace sur l'écran `CONTROL ACQUIRED`
  (`src/hack.js`, `runAcquired()`), art figé au crash sous l'aperçu 3D (jeton
  `RANDOMART_LINE`, les trois tables de `src/flight-end.js`), art de la cible
  dans `sessionDetail()`. `tools/randomart.mjs` est une feuille sans dépendance
  — `node:crypto` est parti, l'image d'une graine donnée a donc changé. Aucune
  archive n'a été réécrite : les sessions d'avant gardent leur champ
  `randomart`, lu en repli.

- **#67 — l'acquisition se joue en trois écrans.** `runHack()` n'est plus une
  machine à phases dans une seule boîte : `runAnalysis()` (le log, le motif,
  l'attente de `ready`), `runHandover()` (`MANUAL OVERRIDE REQUIRED` +
  `[ JACK IN ]` au niveau DISPLAY, focus pris, animation d'attente en pas,
  `.hack-cta`), `runAcquired()` (`CONTROL ACQUIRED` + l'empreinte qui se
  trace). Échap renonce sur les deux premiers, saute le battement sur le
  troisième. Le contrat rendu à `main.js` est inchangé : `{ aborted: true }`
  ou `undefined`. `tools/hack-render-selftest.mjs` : 13/13 OK.
  Enchaînement : `screen().close()` (`src/terminal.js`) imprime l'écran à
  l'envers (`exitScreen` dans `src/motion.js`, `[data-exit]` en CSS, `EXIT_MS`
  = 90 ms) et ne rend la main qu'après — les trois écrans du hack passent par
  là. Sans `matchMedia` (faux DOM) ou en mouvement réduit, la sortie est
  immédiate : les selftests de rendu enchaînent en un microtask.
  `tools/motion-selftest.mjs` : 16/16 OK.
  L'empreinte du crash est en 22 px, avec un repli à 11 px sous 820 px de
  hauteur de fenêtre (`#flight-end` ne défile pas, `exitAt` ne bouge pas).
  *Non vérifié à la main : le rendu réel des trois écrans dans le navigateur,
  et le point de bascule 820 px de l'empreinte sous l'aperçu 3D.*

## Polish pré-release (issues #6 à #16, branche pre-release-polish)

État au 2026-09-08. Spec :
`docs/superpowers/specs/2026-09-08-pre-release-polish-design.md`, plan :
`docs/superpowers/plans/2026-09-08-pre-release-polish.md`.

### Vérifié (headless)

- Huit selftests neufs chaînés dans `selftest:operator` :
  `version-selftest`, `sun-agc-selftest`, `key-map-selftest`,
  `chase-camera-selftest`, `drone-viewer-selftest`, `settings-render-selftest`,
  `briefing-selftest`, `briefing-render-selftest`. `selftest:ci` (donc
  `selftest:operator` + `selftest:api`) et `npm run build` passent.
- `landing-selftest` et `post-flight-selftest` retirés (l'atterrissage et
  l'écran `POST-FLIGHT ANALYSIS` n'existent plus).
- Les vols EN DIRECT sont bien archivés (Session Log, Target Log, compteur
  OPERATOR) et jamais proposés en REVISIT/RESUME : `session-log-selftest`.

### Non vérifié (a besoin d'un navigateur / d'une scène) — en cours au moment d'écrire

La passe visuelle est faite par un autre agent en parallèle. Reste à confirmer :

- Le menu racine à quatre entrées (`FIELD`, `BENCH`, `ARCHIVE`, `SETTINGS`).
- FIELD onglets LIVE-first et l'avis LOCAL sur un serveur partagé qui n'acquiert
  pas.
- Les lignes d'indice `[ESC]` sur les écrans qui les portent.
- Le drone 3D sur les trois écrans de fin (crash, sortie de zone, lien coupé),
  y compris le glissement à la souris avec l'amortissement à zéro.
- Le cadrage de la vue CHASE (1,6 m en arrière, 0,6 m au-dessus).
- Les onglets de SETTINGS et le rebind KEYBOARD.
- Les écrans du briefing et les trois indices du premier vol.
- L'exposition face au soleil.
- `tools/selftest.mjs` §soleil : pas testé ici, aucune scène installée sur
  cette machine.

### Décisions à relire par l'auteur

- L'atterrissage est retiré entièrement (le maintien au sol au repos reste).
- `C` (free cam) est remplacé par `V` FPV/CHASE.
- Le briefing existe (Bible §2 / Roadmap PHASE 13 révisée, notes datées).
- `rebind()` n'échange deux touches que si l'action perdante resterait sinon
  sans touche.
- Le nudge manette au stick sur le viewer 3D de fin de vol est reporté.
- La route API `/comment` n'a plus d'écrivain (#17).

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
   hack → `[ JACK IN ]` *(rituel retiré, issue #33)* → vol → pose →
   POST-FLIGHT → note → KEEP TERRAIN → Home. La
   session doit apparaître au SESSION LOG et les compteurs du pied de page avoir
   bougé. Puis un crash : LINK LOST → TARGET LOST → sortie, **et pas de respawn**.
2. **BENCH** : mode select → BENCH → régler → SPIN UP → vol → choc → **respawn
   immédiat** → `B` → changer de famille, monter le vent, bouger l'heure, couper
   la clôture **sans redémarrer** → sortie.
3. **Étanchéité** : juste après (2), SESSION LOG, TARGET LOG et le pied de page
   sont **identiques à avant**. C'est l'assertion centrale du mode.
4. Les raccourcis dev sautent toujours le mode select : `?scene=paristest`,
   `?live=48.8584,2.2945`, `?family=race5`.

### Désarmement en vol (#236)

Le geste de désarmement (gaz au plancher + yaw plein gauche 0,4 s, ou `j`) ne
s'arme plus que sur une **pose reconnue** — `flightEnd.disarm()`, c'est-à-dire
LANDING_READY : moins de 0,2 m du sol sous 0,06 m/s, tenu 0,25 s. En vol le
geste ne fait plus rien.

Il coupait les quatre moteurs, et `controller.arm()` n'étant appelé qu'au départ
d'un vol, il n'y avait aucun réarmement : la chute jusqu'à l'impact, sans message
(la branche `DISARMED / FREE FALL` n'était atteignable que depuis une pose qui
rebondit). Or le geste est une vrille à gauche moteurs coupés, une figure de
freestyle ordinaire.

`controller.disarm()` vient désormais APRÈS `flightEnd.disarm()` et non plus
avant, et le test ad hoc `height < 2 m && v < 8 m/s` qui vivait dans main.js a
disparu : LANDING_READY est la seule définition du « posé ».

**L'échappatoire d'un drone coincé n'est pas celle-ci** : c'est la coupure de
lien (`k` tenu 2 s, #216), disponible en `FLYING` comme en `LANDING_READY`, et
elle est inchangée.

### Deux découvertes faites en mesurant la ligne de base (pas causées par PHASE 26)

- **#195 / #233 — corrigée.** `fog off reproduces the rain-only density to the
  bit` comparait la somme additive `FOG + extinction(pluie)` au facteur hérité
  `FOG × rain.fogScale`, au bit près. Ce n'était pas un écart de modèle : les
  deux expressions sont algébriquement égales et ne peuvent pas s'arrondir au
  même double (~28 % des rapports pluie/scène s'écartent d'un ulp — le check
  était déjà faux au commit qui l'a écrit, 9a541e7). `rain.extinction` est
  désormais le seul chemin entre la pluie et l'air qu'elle épaissit, et
  `fogScale` en dérive au lieu de refaire le trajet par la portée. main.js lit
  ce champ au lieu de recalculer `extinctionOf(rain.visibility)` à trois
  endroits, ce qui est ce qui rend l'unicité du chemin vraie et pas seulement
  écrite. Le check porte maintenant sur trois propriétés qui peuvent
  réellement échouer (vérifié par mutation).

- **#232 — corrigée.** `[race5] sits still on the ground at zero throttle`
  sortait à 1,83 m/s. Ce n'était ni une dérive de profil ni un mauvais seuil :
  `simulate()` de `tools/selftest.mjs` n'appliquait pas la règle de pose de
  `main.js` (gaz coupés + < 0,6 m sol → moteurs à zéro et `setGroundHold`), que
  `tools/landing-selftest.mjs` applique pourtant déjà. Le banc simulait donc un
  monde d'avant le groundHold : la sphère de 0,15 m descendait la pente du spawn
  sans jamais s'arrêter, et la vitesse lue à 2 s ne mesurait que la pente
  (toothpick passait par 3,02 m/s à t=1,2 s avant de rebondir sous le seuil).
  Règle appliquée, les six familles sortent à 0,00 m/s et le seuil est passé de
  1,5 à 0,1 m/s. Comme ce zéro est désormais une conséquence de la règle, le
  contrôle vérifie aussi que la règle s'est appliquée sur les 500 pas, et la
  moitié « il ne décolle pas » — que la coupure des moteurs masquait — est
  reprise à 1,5 × le ralenti, où la règle ne s'applique plus (à 2 × le ralenti
  les six familles montent de 1,6 à 4,3 m en 2 s : le contrôle est falsifiable).
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


## FIELD : onglets LOCAL / LIVE, rail simplifié (issue #222)

Le rail de FIELD était trop fouilli. La colonne gauche est désormais : tête,
recherche (commune), deux onglets, corps, pied.

- **LOCAL** au repos : `[ FLY — <dernière zone> ]`, les 5 derniers terrains,
  `ALL TERRAIN…` (l'écran complet, inchangé), `ARCHIVE`, `[ DRAW BOX ]` /
  `[ DRAW SHAPE ]`. Une zone tracée : AREA (les deux tracés + CLEAR), SOURCE
  (Google Earth — seul fournisseur inscrit depuis le retrait d'Apple Flyover,
  2026-09-07), DESIGNATION, `[ ACQUIRE AREA ]` et **une
  ligne** `tuiles · poids · verdict` (`railLine()` dans `scanner-model.mjs`,
  testée). Les blocs AREA ANALYSIS, SIGNAL DENSITY et COVERAGE ont disparu ;
  la densité se calcule toujours en silence (KEEP, TARGET SCAN).
- **LIVE** : un clic sur la carte pose une épingle déplaçable, le rail montre
  le lieu (reverse Nominatim) et les coordonnées, `[ FLY LIVE ]` s'ouvre. Le
  point rendu à `fieldLoop()` a la même forme qu'avant (`live`, `density`,
  `place`).
- **MONO · SAT · TERRAIN** et **HIGH / MED / LOW** sont un contrôle Leaflet en
  haut à gauche de la carte ; le second se retire en LIVE.
- Le scanner n'a plus de `menuNav` à lui : c'est celui de la Home qui porte
  Échap / B (`scanner.rest()` au travail, MODE au repos, rien pendant un job).
  Le curseur initial reste sur `[ FLY ]` (`focusFirst: false`).
- **Bug corrigé** : la recherche refusait les espaces. `Input` (input.js)
  écoutait `keydown` sur `window` sans regarder la cible : Espace partait en
  `onAction(' ')` (pause + `preventDefault`). Un champ de saisie garde ses
  touches, Échap excepté — même règle que menu-nav.

Vérifié dans Chrome (MCP) : recherche « Saint Cloud », onglet LIVE → épingle →
vol en direct lancé, DRAW BOX → rail → source + nom avec espace → ACQUIRE
ouvert, Échap repose l'outil. `selftest:operator` passe hors `landing-selftest`
(rouge sur `main` aussi, scène absente).

Non vérifié : une acquisition complète depuis le nouveau rail (le job et
KEEP/REMOVE n'ont pas changé) ; le pied du rail après `done(undefined)` (BACK
après un job) laissait déjà un rail vide avant ce changement.


## Menus : terminal vivant, fond noir (issue #224)

Les menus étaient statiques et sur `--dark-grey`. Registre validé : « terminal
vivant » (Bible §45, quiet by default) — aucun cyan/magenta, glitch ni scanline.

- `src/motion.js` : `watchReveal(box)` (branché dans `screen()` de terminal.js
  et bootstrap.js) tamponne `data-reveal` + `animation-delay` sur chaque bloc de
  l'écran dans l'ordre de lecture — 90 ms de noir (lead), puis 40 ms par ligne,
  plafonné à 520 ms. Une colonne (`terminal-left`), une liste (`terminal-areas`,
  `terminal-list`) ou une rangée de liens s'ouvre sur ses lignes ; les résultats
  du scanner restent un bloc (ils se réécrivent à chaque touche). Un bloc
  ajouté après un fetch reçoit ce qui reste du lead (la Home rend sa colonne
  deux fois au montage), puis plus rien. `countUp(el)` fait rouler les entiers
  d'un texte (pied de la Home, tailles de terrain) en 360 ms après le délai de
  leur ligne, largeur conservée. `installClickFlash()` (main.js) inverse une
  touche pressée 90 ms.
- CSS : tokens `--dur-1/2/3` (90/180/360 ms), `[data-reveal]` en `steps(2)`,
  curseur ▌ qui cligne (1.1 s), encre des boutons en transition 90 ms,
  `prefers-reduced-motion` coupe tout (les helpers sautent à l'état final).
- Fond : `body`, `#loading`, `.bootstrap` et le noir de perte de signal
  (`fpvtp-osd.js`) sur `--black`, y compris l'écran de hack *(le rituel qui
  s'y montait a depuis été retiré, issue #33 ; le fond reste le même noir)* —
  un seul noir continu du crash au rapport puis à la Home. Panneaux (Settings,
  carte, champs) inchangés.
- Le point « extinction de 90 ms avant suppression d'un écran » du design est
  porté par le lead de l'écran suivant : un fondu de sortie serait invisible
  sous un écran opaque et contredirait la coupure sèche vers le vol (Bible §14).

Vérifié dans Chrome (MCP) : mode → FIELD, délais tamponnés dans l'ordre
(tête 90 → pied 520 → carte), curseur `cursor-blink` actif sur `[ FLY ]`,
`key-flash` au clic sur SETTINGS, compteur du pied roulé de 0 à sa valeur
(avec un `requestAnimationFrame` simulé : l'onglet piloté est masqué et ne
rend pas de frame). `tools/motion-selftest.mjs` (12 tests) dans
`selftest:operator`, qui passe hors `landing-selftest` (rouge sur `main` aussi).

Non vérifié à l'œil : la cascade elle-même (200 ms, hors capture), Session Log,
Target Log, post-flight, bootstrap — ils passent par le même `screen()`.

## Fin de vol : plus de retour à l'intro (issue #226)

Un crash en FIELD et la sortie Échap/Entrée rechargent la page
(`location.href = location.pathname`, main.js) ; `startup()` rejouait alors
l'intro à chaque fois. L'intro est le cracktro du lancement, pas du
rechargement : `markIntroSeen()` pose `fpvtp.introSeen` dans `sessionStorage`
(par onglet, survit au rechargement) après `runIntro()`, et
`shouldPlayIntro(OPTS, store)` (tools/intro-model.mjs, testé) saute droit à
SELECT OPERATION MODE, curseur sur le dernier mode. Le gate PRESS ANY KEY
était aussi le premier geste qui débloque l'audio : sans intro, un écouteur
`keydown`/`pointerdown` en capture, à usage unique, appelle le même
`onFirstGesture` (audio + musique de menu). `?scene=`/`?live=` inchangés.

Vérifié dans Chrome (MCP) : intro → marque posée → rechargement → SELECT
OPERATION MODE sans intro, FIELD s'ouvre (clic simulé par script : l'onglet
piloté ne recevait plus les clics de l'extension), aucune erreur. Non vérifié
à l'oreille : la musique de menu au premier clic après rechargement.

## Roulis tenu : la secousse de propwash n'était pas à l'échelle (issue #144)

Un roulis plein manche tenu faisait diverger tangage et lacet à l'échelle
MICRO — pic mesuré à 816 °/s sous un roulis pourtant correct, apparition vers
2,75 s. Le selftest ne pouvait pas le voir : son contrôle de roulis dure 1,2 s
et ne lit que la MAGNITUDE totale, que le roulis remplit à lui seul.

Ce n'était pas de la dynamique de corps rigide, contrairement à ce que l'issue
supposait. Un banc découplé (attitude figée comme dans `tune-pid`, puis
attitude intégrée) ne diverge dans AUCUN des deux cas : un roulis pur annule
`w × Iw`, et pour ce jeu d'inerties le roulis se fait autour de l'axe de plus
petite inertie, donc gyroscopiquement stable. La divergence n'apparaît qu'avec
la vraie physique, et elle est déclenchée par la descente.

La cause : dans `quad.js`, le couple de secousse de propwash valait `propwash ×
0,05` N·m — une constante ABSOLUE, identique pour toutes les machines. Rapporté
à ce que les moteurs peuvent opposer (poussée × bras), ça fait 40 % de
l'autorité d'un 5 pouces et **596 %** de celle d'un toothpick. En accélération
parasite : 895 °/s² sur freestyle5, **50 300 °/s²** sur toothpick. Aucun réglage
de PID ne rattrape une perturbation six fois supérieure à l'autorité — ce qui
explique pourquoi le balayage P/D/I/F de l'issue n'avait rien donné.

Le correctif est celui que le terme de buffet, juste en dessous dans le même
fichier, appliquait déjà : l'amplitude n'est pas une constante de goût. La
turbulence déplace une FRACTION de la poussée réellement produite, et ça agit
sur le bras. La fraction (0,402) est calibrée pour rendre exactement les
0,05 N·m historiques sur freestyle5 au vol stationnaire, donc le ressenti de
référence est conservé au centième — seule l'échelle entre familles change.

Mesuré après correctif, roulis tenu 6 s, pic hors axe : toothpick 816 → 35 °/s,
et les cinq autres familles inchangées (18-38 → 20-29 °/s). Le banc `npm run
tune` rend exactement le même verdict avant et après (2 combinaisons hors
cible) : il n'y a pas de descente sur ce banc, donc pas de propwash, donc aucun
PID à re-mesurer.

Deux contrôles ajoutés à `tools/selftest.mjs`, sur 6 s et sur le pic HORS AXE
en repère corps — les deux angles morts qui avaient laissé passer le défaut.

Conséquence pour #71 : les douze exemplaires MICRO tirés à variation PLEINE
passent désormais le contrôle de roulis (tenu 418-419 pour 420 commandés, pic
101-102 %) sans divergence sur 6 s. `FAMILY_VARIATION.toothpick = 0` n'est plus
justifié par ce défaut-là et peut être rouvert. Un profil ~34 g, lui, échoue
encore — mais pour une autre raison, lisible : il TIENT 492 °/s pour 420
commandés, c'est-à-dire un tune trop nerveux pour cette masse, pas une
divergence. C'est bien un re-mesurage de tune qu'il lui faut, ce que #71 disait
déjà.

## Les primitives demo scene ne servent plus qu'à l'intro (issues #124, #33)

Historique de la règle, dans l'ordre : PHASE 20 (#57) disait que les
primitives demo scene appartiennent au **rituel** d'acquisition et n'en
sortent pas ; `tools/ritual-selftest.mjs` le vérifiait en refusant toute
référence à `RITUAL_PRIMITIVES` / `FAMILY_PRIMITIVES` hors `ritual.js` et
`hack-grammars.js`. La PR #118 a fait piocher `src/intro.js` dedans pour son
cracktro ; l'arbitrage (#124) a été d'élargir la liste blanche — le cracktro
de lancement est un événement au sens de la Bible §19 au même titre que le
rituel, donc le même vocabulaire. `EVENT_MODULES` a tenu `ritual.js`,
`hack-grammars.js`, `intro.js`.

Le retrait du CONTROL VECTOR (issue #33) a retiré `ritual.js` de l'équation :
`src/intro.js` est désormais le **seul** consommateur, à chaque lancement du
jeu. Le selftest est renommé `tools/intro-primitives-selftest.mjs` et
`EVENT_MODULES` devient `new Set(['hack-grammars.js', 'intro.js'])`.

Ce qui n'a pas changé : tout module de `src/` autre que ceux de la liste qui
référencerait ces primitives fait toujours échouer le selftest. Élargir cette
liste reste une décision, pas un ajustement.

## Clôture de zone — geofence (issues #139, #141, #142, #143, #146, #149, #151)

Livré et mergé depuis le 2026-08-30/31, jamais consigné ici : c'est l'objet de
l'issue #193.

### Piège de nommage, à lire en premier

`geofence.js` (la clôture de zone) et `rocktree-fence.js` (la **fenêtre de
streaming rocktree**, HANDOFF:1112 « rappel doux ») n'ont **rien à voir**. Les
deux mécanismes sont indépendants, seuls leurs noms se ressemblent. Le seul lien
réel est un chiffre : `WORST_MEASURED_SPEED_MS` (42,72 m/s) est exporté par
`geofence.js` pour que la fenêtre rocktree dimensionne son rayon de chargement
sur la même mesure — un chiffre mesuré, deux consommateurs.

### Ce que c'est

La fiction n'est pas la portée radio, c'est **la zone scannée** : hors du
rectangle que le joueur a dessiné lui-même dans le Global Scanner, il n'y a pas
de données, donc pas de couverture, donc pas de lien. Quatre zones — `NOMINAL`,
`CAUTION` (averti), `HOLD` (averti et retenu), `LOST` (dehors, l'image meurt) —
horizontalement sur la bbox et verticalement **sous** `bbox.min.y`, la pire des
deux gagnant.

`src/geofence.js` est pur : ni THREE, ni Rapier, ni DOM. Qui pousse la force dans
Rapier, l'avertissement dans l'OSD et la perte dans le budget de liaison est le
problème de `main.js`.

### Ce qui est MESURÉ

Par `tools/geofence-measure.mjs` sur `public/scenes/tour-eiffel`, six familles,
re-figé le 2026-08-31 (#141, #142). Le protocole est **en ACRO** — le mode du
jeu — ce qui change tout : manches centrés, l'ACRO *tient* l'assiette au lieu de
remettre à plat, donc « obéir » doit être un programme de manche explicite, et
il est écrit en entier dans l'en-tête du module.

| constante | valeur | d'où elle vient |
|---|---|---|
| `R_HOLD` | 73 m | distance d'arrêt du pilote qui obéit, pire famille (race5, 72,26 m arrondi au mètre supérieur) |
| `R_CAUTION` | 138 m | `R_HOLD` + 1,5 s à la vitesse maximale mesurée — 3 clignotements à `BLINK_PERIOD_MS` = 500 ms |
| `WORST_MEASURED_SPEED_MS` | 42,72 m/s | race5, plein gaz à 85° d'assiette |
| `HOLD_STOP_GUARANTEE_M` | 60 m | bissection `--guarantee` : `59,433 < hold* <= 59,446`, arrondi vers le **haut** |
| `MARGIN_M` | 12 m | dispersion du point d'arrêt sur le balayage des gaz de freinage plausibles (6,69 m au pire), arrondie au mètre supérieur — constante **du banc** (`tools/geofence-measure.mjs`), pas du module ; le banc la re-mesure et refuse de livrer un chiffre si elle la dépasse |

Deux corrections de méthode, toutes deux fermées : #141 (l'approche était
plafonnée à 42° d'assiette — rien ne plafonne le tangage en ACRO, ce plafond
n'existe que pour le mode ANGLE, absent du jeu ; le balayage 42/55/70/85° change
le classement, race5 dépasse heavy5) et #142 (le pire cas de freinage
dimensionnait sur un gaz qui fait tomber l'appareil de plus de 40 m, donc sur un
pilote qui s'écrase ; il reste dans le balayage, plus dans la sélection).

`R_HOLD` n'est pas une soustraction mais un **point fixe** : la rampe du rappel
s'étale sur `R_HOLD` mètres, donc rétrécir le couloir durcit la rampe et change
la distance qu'on mesure avec. Trouvé par itération directe, famille par famille.

### Ce qui est POSÉ, pas mesuré, et pourquoi

- **Le couloir vertical** (`FLOOR_CAUTION` 2 m, `FLOOR_HOLD` 5, `FLOOR_EDGE` 8,
  `FLOOR_LOST` 10, tous **sous** `bbox.min.y`). Une distance d'arrêt n'a pas de
  sens ici : on n'arrive pas sous la dalle en fonçant, on s'y faufile. Deux
  mètres sous la surface la plus basse, on est forcément sous quelque chose — il
  n'y a aucun faux positif à écarter, donc rien à mesurer. **Le signe est ce qui
  compte le plus** : poser ce couloir au-dessus pousserait le drone vers le haut
  au point le plus bas de la carte, la Seine sur `ile-de-la-cite`, où voler à
  deux mètres de l'eau est parfaitement normal.
- **`A_MAX`**, le rappel : 60 % de ce que coûte un stationnaire. Choisi pour ce
  qu'il ne fait pas — un pilote qui insiste **doit** pouvoir passer, c'est la
  moitié du design. `R_HOLD` dimensionne le cas où on obéit, pas l'autre.
- **`HYST_M`** = 3 m, l'hystérésis. #143 l'a rendue **absolue** : c'était une
  fraction du couloir, dont la justification parlait de centimètres, et sur une
  grande carte elle pouvait laisser `NO COVERAGE` affiché jusqu'à 5,4 s après un
  retour bien à l'intérieur — un avertissement sans rien derrière. Choisie et
  non mesurée, pour la même raison qu'`A_MAX` : ce qu'elle couvre (jitter
  d'affichage, arrondi de simulation) n'a pas de protocole de mesure qui ait un
  sens. 3 m est l'unité déjà en usage dans le fichier pour « petite marge
  physique ».
- **La borne de couloir sur petite carte** : `scale = min(1, (halfMin/3) /
  R_CAUTION)`, le même facteur sur les deux seuils pour que leur **rapport**
  survive — et avec lui le temps d'avertissement, qui est tout ce que
  `R_CAUTION` apporte. Le cœur volable ne descend jamais sous 67 % du plus petit
  côté ; une grande carte garde la valeur mesurée bit pour bit. C'est une borne,
  pas une mesure : elle dit ce qu'on garde des chiffres quand la carte ne peut
  pas les payer. Une mesure par scène a été écartée parce que le banc **ne
  tourne pas** sur les petites cartes — il lui faut l'élan d'amener la famille à
  sa vitesse de pic plus le couloir d'essai devant la face.

### La garantie d'arrêt, et ce qu'elle échange

Sous `HOLD_STOP_GUARANTEE_M` de couloir effectif, le pilote qui **obéit**
franchit quand même le bord des données. C'est irréparable en gardant le design :
durcir `A_MAX` assez pour arrêter la pire famille sur une carte de poche
détruirait le « ce n'est pas un mur » qui *est* le principe de la clôture.

Ce qui rend l'échange tenable : le mode de défaillance reste doux. Tant que la
pénétration n'atteint pas `lost`, `over` reste faux et **la session n'est pas
perdue** — l'image agonise et le rappel repousse encore. On paie en image, pas en
session.

### État des cartes installées

**C'est la commande qui fait foi, jamais un chiffre recopié** — ni ici, ni dans
le commentaire du module, dont le décompte (« 9 des 24 ») date du 2026-08-31 :

```bash
node tools/geofence-check-scenes.mjs
```

Aucun décompte n'est recopié ici, et c'est délibéré : celui du commentaire de
`geofence.js` (« 9 des 24 ») est périmé, celui que cette section portait à sa
première rédaction l'a été en quelques heures — `havre` est arrivée entre-temps
et a fait passer « les deux sont sous la garantie » à faux. La liste bouge à
chaque `npm run add-map`, donc elle n'a pas sa place dans un document.

Ce qui est stable, en revanche : **une petite carte est normalement sous la
garantie**, et ce n'est pas une erreur — c'est l'échange décrit au-dessus, la
carte reste jouable. Le garde-fou de `tools/lib/add-map-core.mjs` le dit déjà au
moment de l'ajout ; la commande ci-dessus le redit pour l'existant.

`tools/lib/add-map-core.mjs` fait le même contrôle à l'ajout d'une carte, en
important la même constante — c'est ce que #146 a fermé.

### Ce qui est VÉRIFIÉ, et ce qui ne l'est pas

**Vérifié sans navigateur** — `node tools/geofence-selftest.mjs`, 32
vérifications : les quatre zones dans l'ordre sur les deux axes, la pire des deux
qui gagne, l'hystérésis (aucun aller-retour ne double une transition, #143 l'a
rendue absolue), la poussée nulle à l'entrée de HOLD et pleine au bord, sa
croissance sans à-coup et son signe rentrant sur les quatre faces, la perte de
liaison monotone sur les deux couloirs, la borne petite carte (le rapport des
seuils survit, le couloir vertical n'est **pas** touché), `FENCE_SPAN` cohérent
avec `link.js`, et #151 (tout OSD posé porte l'élément `WARNINGS`, sans quoi
`R_CAUTION` ne paierait rien).

**NON vérifié — jamais vu en vol.** Aucun commit de la clôture ne revendique de
vérification au navigateur, et je n'en ai pas fait. Ce qui reste à voir de ses
propres yeux :

- l'avertissement `NO COVERAGE` qui apparaît vraiment, à la bonne distance, et
  qui se lit avant d'être dedans ;
- le rappel qui se **sent** comme un rappel et non comme un mur ;
- la mort de l'image au franchissement, et son retrait quand on rentre ;
- le couloir vertical sous une dalle réelle ;
- le comportement sur une carte sous la garantie (les deux d'ici), là où le
  pilote qui obéit sort quand même.

#149 (spawn de repli dans la clôture) et #151 (l'élément `WARNINGS` était un
tirage, donc l'avertissement pouvait n'être affiché nulle part) sont **fermées** —
contrairement à ce que supposait #193, qui les décrivait comme ouvertes.

---

## RTC : un bloc sur la racine, des toasts ailleurs (issue #243)

Le RTC était monté sur six surfaces. Il en reste trois, et une seule est un bloc.

| écran | forme | événement |
|---|---|---|
| SELECT OPERATION MODE | bloc `RTC // INTERNAL`, colonne droite | flux mêlé des treize câblés |
| hack | toast, bas-droite | `TARGET_ANALYSIS` |
| acquisition | toast, bas-droite | `ACQUIRE_AREA` |

Retiré du panneau de recherche du scanner, de la liste et de la fiche de TARGET
SCAN, de POST-FLIGHT et de LAST SESSION.

**Un moteur, deux rendus.** La boucle de tick de `dialogue.js` (minuteur,
mémoire, cadence, `planExchange`) est factorisée dans `runStream()` et prend un
`emit`. `mount()` écrit dans un `<pre>`, `notify()` fabrique un toast. Deux
copies de cette boucle auraient divergé au premier réglage de cadence.

**`event` accepte un tableau.** La racine n'est aucun événement du catalogue, et
c'est maintenant le seul écran qui porte un bloc : sans le mélange, 1,35 Mo de
corpus généré ne serait plus lu nulle part. `RTC_EVENTS` (dans `bench.js`) est
écrite à la main et **pas** dérivée d'`EVENTS` — le catalogue déclare aussi huit
événements sans corpus ni secours (#242), et les tirer ne produirait que du
silence.

**Le toast est la seule surimpression du jeu.** Choix assumé : dans le rail du
scanner et sous la grille du hack, le RTC était un bloc de log qui grandissait et
déplaçait ce qu'on regardait. `position: fixed` et non `absolute`, pour une
raison mesurée : `.scanner-panel` et `.bootstrap` portent `overflow-y: auto`, et
un enfant absolu y suit le défilement du contenu — il serait sorti du cadre dès
que le log du pipeline s'allonge. L'appartenance du toast à son écran tient à sa
durée de vie (`stop()`), pas à sa place dans le DOM.

**Ce que ça change de nature.** Sur la racine, le crew ne commente plus l'écran
qu'on regarde : il bavarde en fond. La Bible §9 donne le RTC à l'attente, et la
racine est le seul écran où l'on n'attend rien. C'est le prix du regroupement, il
est payé sciemment.

### Deux défauts visuels trouvés à l'écran, pas au banc

Le premier était une régression que rien n'aurait attrapée sans regarder :
`.bench-modes` héritait du `padding: var(--space-5) 0` de `.bootstrap` alors que
sa boîte fait `100vh`. L'écran débordait d'exactement ce rembourrage, sortait une
barre de défilement, et on pouvait faire glisser la colonne des voies hors du
cadre. `.terminal-field` posait déjà `padding: 0; align-content: stretch;
overflow: hidden` pour cette raison précise ; `.bench-modes` le pose maintenant
aussi.

Le second : les barres de défilement étaient celles du navigateur, gris clair
avec leurs deux flèches sur un fond noir. Elles sont ramenées à un filet dans
l'encre des filets. **Piège à connaître** : depuis Chrome 121, poser
`scrollbar-width` ou `scrollbar-color` fait IGNORER tous les pseudo-éléments
`::-webkit-scrollbar`. Les écrire côte à côte donnait un pouce correctement
assourdi mais les flèches toujours là — la règle qui les retire n'était jamais
appliquée. Un `@supports selector(::-webkit-scrollbar)` sépare les deux mondes.

### Vérifié — sans navigateur

`node tools/dialogue-render-selftest.mjs` (6, nouveau) : le calque est posé sur
son hôte, il est `aria-hidden`, `stop()` le retire, aucun minuteur ne survit, et
un hôte nul est un no-op et pas une exception. `bench-render` (29, +2) : les deux
colonnes, les voies à gauche et le RTC à droite, et le flux arrêté au choix.
Les deux nouveaux contrôles de `bench-render` sont vérifiés par mutation (poser
le RTC à gauche, retirer `stopRtc()` du `pick()` : chacun rougit son contrôle).

### Vérifié à l'œil — Chrome sur le serveur de dev, 1456 × 819

- la racine en deux colonnes : filet vertical, les voies à gauche, le RTC à
  droite, **aucune barre de défilement d'écran** ;
- le journal RTC qui se remplit et défile, barre réduite à un filet sans flèches
  ni piste ;
- le toast : `position: fixed`, coin bas-droite, `z-index` 12,
  `pointer-events: none`, trois cartes empilées aux bords droits alignés au pixel
  (mesuré au `getBoundingClientRect`, l'écart apparent sur une capture JPEG étant
  un artefact de compression).

### NON vérifié — demande encore un œil

Un banc headless ne juge pas une surimpression, et le peu que j'ai pu injecter à
la main ne juge pas une durée :

- l'apparition et l'effacement en fondu, et si 6,5 s est la bonne durée ;
- la pile bornée à trois cartes sur une acquisition longue **réelle** (les trois
  cartes ci-dessus étaient injectées, pas produites par le flux) ;
- le coin bas-droite sur le hack, où la grille occupe déjà le centre ;
- la racine à d'autres largeurs, et son empilement sous 1100 px, où le RTC passe
  **sous** les voies (l'inverse de FIELD, où c'est la carte qui monte).

---

## Couverture : la tache là où le drone est passé (issue #245)

Une tache douce s'étend sur la carte de FIELD sous les trajectoires, se
densifie quand on repasse, et survit aux sessions. Ce n'est PAS « la zone est
acquise, donc explorée » : un cadre où l'on n'a jamais volé reste vierge.
Spec : `docs/superpowers/specs/2026-09-06-couverture-carte-design.md`.

**Trois contraintes du dépôt ont façonné le design, vérifiées avant d'écrire :**

- **Le banc n'écrit rien, par construction.** BENCH n'ouvre aucune session
  (`main.js:2680`) ; la couverture vit dans `session.js`, donc au banc `live`
  est null et rien n'est marqué. Aucun `if (MODE.bench)` à maintenir.
- **Une seule écriture, à la clôture.** `operator.patch()` réémet toute la
  valeur à chaque flush : patcher en vol enverrait ~160 ko plusieurs fois par
  seconde. `session.end()` fusionne, borne et patche une fois — AVANT le PATCH
  de la session, pour qu'un vol dont on perd la fiche garde sa trace.
- **`OP_WRITABLE_KEYS` est une liste blanche** (`map-api-plugin.mjs`) : `coverage`
  y est, avec le même contrat que `dialogueMemory` — pas de validation serveur
  parce que le client borne (`MAX_CELLS = 8000`, `W_MAX = 8`) et relit
  défensivement (`fromStored()` rend une couverture vierge pour tout ce qui
  n'est pas la forme attendue).

**La grille** : tuiles slippy à zoom fixe 20 — 25,15 m à Paris, parce que
Leaflet est déjà en Web Mercator. Empreinte de 30 m autour de chaque échantillon
(4 à 5 cellules, pas un 3×3 : les diagonales sont à 35,6 m), échantillonné à
5 Hz de vol armé — à 42,72 m/s ça fait 8,5 m entre deux, aucun trou possible.

**Le plafond de 8 000 cellules est un pari**, écrit comme tel dans
`coverage.js` : ~850 cellules par vol de dix minutes, donc une dizaine de vols
sans recouvrement. À revoir sur du vrai usage, pas sur une intuition.

**Perdu si l'onglet meurt** : `sendBeacon` ne fait que des POST, la couverture
voyage par PATCH. La fiche de session part, sa trace non. Assumé.

**Et fragile au rechargement** : après un vol, la Home revient par un
rechargement complet, donc le cache client ne survit pas — ce qu'on relit est
ce que le serveur a reçu. Le PATCH part grâce au debounce de 500 ms, plus court
que la séquence de fin de vol ; `beforeunload → flush()` est un filet non
garanti (fetch ordinaire, sans `keepalive`, qui ne porterait pas 160 ko). Sur
un serveur lent, la trace d'une session peut être coupée par le rechargement.
Suivi : issue sur `operator.flush()` à l'unload, qui concerne aussi `settings`
et `dialogueMemory`.

### Skin de la tache (issue #251)

Magenta au cœur, cyan sur le halo, transparent au bord (tokens `--magenta` /
`--cyan`, passés par scanner.js ; `blobStops()` dans map-coverage.js, pur et
vérifié en Node). L'alpha planifié sert aussi de curseur : passage isolé
surtout cyan, zone survolée souvent magenta au centre ; les recouvrements
s'additionnent en 'lighter' vers un violet clair. La Bible §19 réserve ces
couleurs à l'intro (au rituel d'acquisition avant son retrait, issue #33) —
choix assumé par l'auteur, validé à l'œil sur la carte FIELD le 2026-09-06.

### Vérifié — sans navigateur

`node tools/coverage-selftest.mjs` (17) : la tuile de la Tour Eiffel calculée à
part, la taille de cellule à Paris et à l'équateur, l'empreinte (5 au centre,
4 sur un coin, et aucune cellule traversée oubliée à 42,72 m/s), la saturation,
l'aller-retour de sérialisation, une douzaine de formes corrompues qui rendent
une couverture vierge, la fusion commutative sur le contenu et idempotente,
l'éviction par poids puis ancienneté, et le plan de dessin avec une projection
jouée. `session-selftest` (+4) : geo() n'est appelée qu'aux échantillons, aucun
PATCH pendant le vol, un seul à la clôture, la fusion 3 + 1, un opérateur
corrompu n'empêche pas la clôture. `session-api-selftest` (+2) : la clé fait
l'aller-retour sur disque.

`terminal-render-selftest` n'a PAS pu être joué : il pend sans sortie depuis le
passage au 2026-09-06, sur `main` comme ici, et passe sous une date figée au
2026-09-05 — issue #246, préexistante, sans rapport avec la couverture. Tant
qu'elle est ouverte, `npm run selftest:operator` s'arrête là.

### NON vérifié à l'œil — personne n'a encore vu la tache

L'extension Chrome était injoignable pendant tout le lot : la vérification
visuelle prévue (une couverture injectée dans le cache client, capture à
l'appui) n'a pas eu lieu. Un banc headless jetable a confirmé la MÉCANIQUE
(pane à z=350, canvas dimensionné au DPR, deux arcs encadrés par `lighter` /
`source-over`, encre `rgba(236, 231, 221, …)`, `refresh()` sans carte
inoffensif, `onRemove` propre) — pas le RENDU. Douceur, densité, ordre sous
les cadres et stabilité au zoom restent à voir. Recette : sur SELECT OPERATION
MODE → FIELD, injecter dans la console une couverture jouée
(`getOperator().coverage = { v: 1, z: 20, cells: [...] }`), déplacer la carte,
regarder. Recharger ensuite.

### NON vérifié — demande un vrai vol

La couverture injectée ne dit rien de la vraie : reste à voir, après un vol
FIELD réel puis un retour à la Home, que la tache est bien là où l'on a volé et
qu'elle survit à un rechargement ; qu'un vol LIVE marque au bon endroit ; que
dix sessions ne noircissent pas la carte ; et ce que vaut le plafond.

Et en suivi, une fois la tache vue :

- le clignotement au zoom : `leaflet-zoom-hide` cache le calque pendant toute
  l'animation (pas de handler `zoomanim`) — si c'est gênant, le remède est un
  handler `zoomanim`, en suivi.

## Mémoire : le boot échouait après quelques vols (issue #249)

Symptôme rapporté : « le jeu crash systématiquement au démarrage, FIELD et
LIVE ». Trois formes, toutes vues dans un même onglet Chrome au fil des
rechargements (une page de vol est rechargée à chaque vol, #226) :
`unreachable` en rouge sur l'écran de chargement (trap WASM Rapier pendant
collision-build), chargement figé à « tuiles 1/2… » sans erreur (worker de
tuile tué par manque de mémoire, Chrome ne déclenche pas `onerror`), et gels
de 30 s. Le processus de rendu atteignait 4,1 Go de RSS, `usedJSHeapSize`
1,0 → 1,9 Go sur des pages FRAÎCHES : les gros tampons des pages mortes
s'empilaient jusqu'à ce qu'une allocation échoue. Rien à voir avec les
données (selftest paristest vert, 150 graines d'état d'entrée en Node sans
trap) ni avec le vol lui-même.

Un instantané de tas (Chromium headless, CDP) a nommé les postes d'UNE page
de paristest : 398 Mo de mémoire WASM Rapier, 268 + 75 Mo de pixels de
textures gardés en JS après téléversement GPU, 36 Mo de collision.bin retenu
par le cache `_shape` du Collider Rapier. Correctifs :

- `releaseTexturePixels()` (TileMaterial.js), appelé juste après
  `renderer.initTexture()` dans `finishBoot()` : `image.data = null` puis le
  tampon est DÉTACHÉ (`structuredClone` avec transfer) pour être rendu tout de
  suite, pas au prochain GC. three ne relit les pixels qu'à un nouvel upload,
  que rien ne déclenche (pas de gestion de contexte perdu).
- `Physics.releaseSourceArrays()` : vide `groundCollider._shape` (Rapier le
  recharge à la demande, `ensureShapeIsCached`) et détache le tampon du
  collision.bin ; `finishBoot()` lâche aussi la référence du cache des
  préchargements.
- `loadChunks()` : chien de garde de 60 s de silence par worker de tuile →
  rejet avec un message explicite au lieu d'un écran figé pour toujours.
- `startup().catch` : un `WebAssembly.RuntimeError` s'affiche « physique :
  mémoire insuffisante — fermez les autres onglets du jeu, puis rechargez »
  plutôt que « unreachable ».

### Vérifié

- `node tools/memory-release-selftest.mjs` : détachement effectif, `_shape`
  vidé, raycast/step/`collider.shape` encore corrects après, no-op en ?live=.
- Chromium headless (script CDP, scratchpad de la session) sur
  `?scene=paristest`, GC forcé entre les mesures : tas JS 457 → 77 Mo, RSS du
  renderer 1004 → 648 Mo, stable sur trois rechargements.
- Chrome réel, même page, trois rechargements enchaînés : tas 77 Mo à chaque
  fois, renderer 590 → 627 Mo (avant : 4,1 Go), textures rendues normalement.

### Non vérifié / reste

- Les 398 Mo de mémoire WASM Rapier par page ne sont pas réductibles d'ici
  (un `WebAssembly.Memory` ne se détache pas) ; ils sont rendus au GC du
  document mort, ce qui a suffi dans les mesures ci-dessus.
- Le chien de garde n'a pas été vu se déclencher (il faudrait tuer un worker
  à la main) ; le message du trap WASM non plus depuis le correctif.
- Un onglet en arrière-plan n'avance pas (`nextPaint()` attend un rAF) :
  c'est normal, mais ça ressemble à un gel si on regarde `[load]` en console.

## Musique du hack/rituel trop sourde (issue #252)

Retour terrain : « la musique doit être plus forte pendant le hack/vector
code, là on entends rien ». HACK jouait à intensité 0,12 (« la pièce d'à
côté » — coupure ~607 Hz, -17,6 dB), et le rituel du Control Vector duckait
encore ce niveau à 0,25 (-12 dB de plus) : environ -30 dB cumulés, en dessous
du bruit de fond d'un casque. `tools/music-model.mjs` gardait la logique
volontairement simple (UN scalaire pour filtre + gain, calibré à l'oreille) —
le défaut était dans les VALEURS, pas dans le modèle.

- `PHASE_INTENSITY.HACK` : 0,12 → 0,28 (-14,4 dB, coupure ~1,1 kHz — reste
  nettement filtré et sous MENU 0,55 / FLOOR 0,62).
- `DUCK.ritual` : 0,25 → 0,55 (-5,2 dB au lieu de -12 pendant le rituel).
- Net au moment le plus sourd (pendant le rituel) : environ +10 dB, soit
  perceptiblement le double de volume.
- *(2026-09-09, issue #33)* Le rituel qui appelait `music.duck()` est retiré ;
  `DUCK.ritual` reste dans `tools/music-model.mjs` (nettoyage laissé à un
  suivi ultérieur) mais son seul appelant a disparu — le hack ne baisse plus
  la musique, et `music.drop()` au drop reste correct.
- `tools/music-selftest.mjs` : borne de coupure du HACK relevée de 900 Hz à
  1200 Hz en conséquence (le reste du fichier, dont le plancher de vol
  FLOOR, est inchangé). 65 tests verts.

### Non vérifié — demande une oreille

Personne n'a encore écouté le résultat en jeu. Pour écouter vite sans passer
par TARGET SCAN : `?scene=<slug>&hack=<type>` (types dans
`tools/hack-model.mjs`, ex. `?scene=paristest&hack=gnss+spoof`) déclenche
l'écran de hack directement au chargement.

## Drones ambiants (issue #250)

Les candidats du TARGET SCAN non pris volent autour du joueur pendant la
session (FIELD seulement) : un ensemble de quads sans lien, chacun sur une
routine par famille (race en virages couchés, cinewhoop nez vers son ancre,
long range en stade, micro nerveux au ras du sol), rendus en un maillage
fusionné auto-éclairé avec LED billboard et flou d'hélice, et quatre voix
audio (distance, ombre du dos, Doppler, envoi vers l'acoustique du lieu).
Implémenté sur `main`, commits `92643a1..5f071b4`.

### Vérifié — sans navigateur

- `tools/ambient-selftest.mjs` (175 checks) : ensemble des candidats non
  pris, routines par famille, courbes, bulle/ancres/validation, modèle
  d'attitude. Contient le **balayage d'inclinaison** : 6 familles × 50 graines
  × 600 frames, `tilt max ≤ 75°` par famille (mesuré : 70,0° partout où le
  plafond mord, 18,4° au cinewhoop), `race5 > 35°` de moyenne (61,1°),
  `cinewhoop < 12°` (9,5°).
- `tools/drone-shape-selftest.mjs` (69) : recette géométrique paramétrique par
  famille.
- `tools/drone-mesh-selftest.mjs` (26) : Three en Node — maillage fusionné,
  matériau auto-éclairé, LED clampée dans le vertex shader ET fondue en
  distance (`smoothstep(uFadeNear, uFadeFar, …)`), pas de lumière Three.
- `tools/ambient-audio-selftest.mjs` (13 tests) : synthèse des quatre voix
  contre un faux contexte Web Audio, envoi vers `space` branché une seule
  fois même quand `space.input` arrive après `start()`.
- `tools/ambient-drones-selftest.mjs` (26 PASS + 1 SKIP sans `--expose-gc` ;
  27 PASS avec) : l'instance branchée sur une scène et une caméra factices,
  espion sur les voix (régime établi, positions finies, dispose), `uAmbient`
  = `dim` et non `sun.ambient`. **La chaîne l'appelle avec `--expose-gc`** :
  sinon le contrôle d'allocation SKIPait toujours.
- Les cinq fichiers ci-dessus sont chaînés en queue de `npm run
  selftest:operator`, tous verts.
- Bloc scène ajouté à la fin de `tools/selftest.mjs` (« ambient drones (real
  trimesh) ») : 10 graines × 4 naissances contre le vrai trimesh, rejeu à
  257 points par courbe (9 766 points au total). Sur `havre` :
  **35/40 nés, 35/35 sans mur, 35/35 au-dessus de l'AGL de leur famille**.

**Décisions prises pendant l'implémentation, absentes de la spec/plan** :

- Profil de sol à **64 échantillons** (obstruction testée sur 16 segments) au
  lieu d'un nombre plus faible, après qu'un rejeu sur `havre` a montré un
  immeuble logé entre deux nœuds d'un profil plus grossier.
- La composante verticale des figures est contrainte **non négative** : l'AGL
  tiré pour une courbe est celui de son point le plus bas.
- Le huit (cinewhoop) est reparamétré par **abscisse curviligne C1** (Simpson
  pour la longueur, Hermite pour la position) ; les dérivées (vitesse,
  attitude) sont prises à **pas fixe 1/60**, pas au pas de rendu.
- Jitter du micro ramené à **0,15 m** (la valeur de spec, 0,3 m, cassait la
  vitesse dérivée — issue de suivi ci-dessous).
- `TILT_MAX_DEG = 70` est **imposé sur la poussée**, dans `attitudeFrom()`
  puis sur le quaternion rendu (`clampTilt()`), pas seulement borné par
  `v²/r` dans `routineFor()`. Borner l'accélération latérale ne bornait pas
  la verticale (plan incliné du loop, sinus du huit, jitter du micro à
  ~14 m/s²) : mesuré 157° sur un toothpick, 110° sur un race5, 100° sur un
  freestyle5. Et le lissage lui-même sortait du cône (le nlerp suit le plus
  court chemin en rotation, l'ensemble des attitudes sous 70° n'y est pas
  convexe) : 83,9° entre deux cibles à 70° pile. Après : ≤ 70,0° partout.
- `pickAnchor()` teste la clôture **horizontale d'abord**, le rayon de sol
  ensuite, le cône de vue en dernier — et ce dernier à la hauteur de VOL
  (`g + agl`), pas à celle de l'ancre au sol. Un slot qui ne peut pas naître
  ici ne coûte donc **aucun rayon** (mesuré : 180 → 0 rayon/s sur le cas du
  long range sur petite carte). Un slot qui échoue quand même 10 fois de
  suite se met en veille 1 s.
- Le maillage ambiant prend `cloud.dim` (l'obscurcissement des tuiles) comme
  `uAmbient`, pas `sun.ambient` (l'exposition absolue, 0,059 au couchant, que
  l'AGC de la lentille normalise pour tout le reste).
- La LED a un **fondu de distance** (120 → 220 m, soit `R_SPAWN[0]` →
  `IN_VIEW_MIN_M`) : son plancher de 3 px la rendait visible à toute
  distance, et une naissance dans le champ (≥ 220 m) comme un départ
  (≥ rLeave) allumaient donc une lumière sous les yeux du joueur.
- Le plancher de la clôture (geofence) est vérifié **à la hauteur de vol** de
  la courbe, pas au sol.
- `spawnOne` fait tourner le slot de départ à chaque appel (pas toujours le
  même index en tête).
- Les voix audio démarrent **paresseusement**, seulement quand un
  `AudioContext` existe déjà (pas de création anticipée).
- `silence()` est **verrouillé** jusqu'au prochain `reset()`/`setScan()` (un
  appel répété ne redémarre rien tant que la scène n'a pas changé).

### Non vérifié — marche à suivre pour l'opérateur, dans Chrome

Sur cette machine, `public/scenes/tour-eiffel` n'est pas installé — `npm run
selftest` (scène par défaut) échoue par `ENOENT` avant même de démarrer.
Utiliser `npm run selftest public/scenes/havre` (la seule carte installée
avec `corridor.scale = 1`) pour le bloc scène ci-dessus ; les trois autres
cartes locales (`paristest`, `conservatoire-national-des-arts-et-metiers`)
n'ont pas été essayées pour ce bloc.

```text
1. npm run dev, FIELD, une zone, TARGET SCAN avec ≥ 3 signaux, prendre un, hack, JACK IN.
2. Console : __sim.debug().ambient → count = signaux − 1, families, positions.
   Au banc : __sim.debug().ambient === undefined.
3. Regarder autour : un point qui bat (LED) doit se voir avant le corps ;
   s'en approcher à 30 m → un quad avec hélices floues, incliné dans ses virages.
   race : couché ; cinewhoop : à plat, nez vers son sujet ; long range : haut et droit ;
   micro : au ras du sol, nerveux.
4. Écoute : au casque, le passage d'un drone doit aller d'une oreille à l'autre,
   plus sourd dans le dos, glissando au passage (Doppler). Le moteur du joueur
   ne doit jamais pomper (limiteur) : si oui, baisser VOICE.g0.
5. __sim.debug().drawCalls avant/après = +2 par drone visible ; ambient.audioNodes
   constant en vol ; longtask nul (Performance panel, 30 s de vol).
6. Traverser la carte en long range : jamais de ciel vide, jamais de drone qui
   apparaît dans le champ (ambient.relocations monte, count reste = n).
7. Mode direct (LIVE) : même chose, count peut mettre quelques secondes à monter
   (terrain non chargé → spawnFailures monte puis se stabilise).
8. Resume d'une session LANDED : mêmes familles qu'à la première session.
```

Points supplémentaires à surveiller pendant ce parcours :

- **(a) Luminosité au crépuscule (`?night=1`)** : `uAmbient` reçoit désormais
  `cloud.dim`, comme les tuiles (plus `sun.ambient`). À confirmer à l'œil :
  les ambiants doivent lire comme le sol, ni plus sombres ni plus clairs.
- **(b) En `?live=`** : la densité de brouillard des ambiants peut rester à
  0 (chemin dev, terrain pas nécessairement chargé) — normal sur ce mode, pas
  un bug à signaler seul.
- **(c) Flou d'hélice** : tourne à 36 rad/s ; vérifier qu'il se lit comme un
  flou continu et non comme un strobe.
- **(d) `npm run selftest public/scenes/havre`** pour rejouer le bloc scène
  ci-dessus en un coup.

Ajouter au parcours : **(e)** regarder naître et partir un drone — aucune LED
ne doit s'allumer ni s'éteindre d'un coup dans le champ (fondu 120 → 220 m) ;
**(f)** au casque, l'envoi vers l'acoustique du lieu doit s'entendre même
quand le premier son de la session est un son d'interface (le contexte audio
naît alors avant `space.input`).

**Suites** (issues créées pendant cette tâche pour les écarts constatés en
relisant le code, non bloquantes pour la fermeture de #250) : #260 (borne
conjointe d'inclinaison) **traitée** — plafond imposé sur la poussée et sur
le quaternion rendu ; #261 (long range impossible sur petite carte)
**traitée** — rotation du curseur, plus rejet sans rayon ; #262 (tremblé du
micro à 0,15 m au lieu de 0,3 m), ouverte ; #263 (luminosité des maillages au
crépuscule) **traitée** au code (`uAmbient = cloud.dim`), reste à confirmer à
l'œil (point (a) ci-dessus).

## Le drone du joueur en 3D (issue #264)

Le quad procédural de #250 revient sous les yeux du joueur, à trois distances :
ses deux hélices avant **dans le champ** pendant le vol (seconde passe du
composer, caméra à `near = 0.005`), la **machine entière en caméra libre**
(touche `C`), et un **portrait fil de fer** en SVG au crash puis dans
`SESSION LOG` / `TARGET LOG`. Les hélices tournent au régime réel des quatre
moteurs (`physics.propulsion.omega`), lu par index moteur : le mixeur se lit
directement à l'image. Aucune migration — `session.target` porte déjà `family`
et `buildSeed` en clair, donc tout l'historique déjà journalisé sait se
dessiner. Commits `f5077b6..87c8c73`.

### Vérifié — sans navigateur

- `tools/onboard-frame-selftest.mjs` (24) : la **borne DA garantie par
  construction**, rasterisation pure sans GPU, 6 familles × 300 graines contre
  le bloc `MOUNT` tel qu'il est écrit. Mesuré : aire au pire **7,5 à 7,9 %**,
  hauteur médiane **31 à 44 %**, hauteur au pire **40 à 48 %**. Contient aussi
  l'étalonnage de la sonde (objectif exactement dans le plan d'hélice ⇒
  couverture nulle ; monotonie de l'écart au plan ; déterminisme).
- `tools/onboard-drone-selftest.mjs` (26) : **exclusivité** embarqué / free cam
  (jamais deux, jamais zéro en vol), l'œil qui retombe exactement à l'origine
  (5,2e-18), les hélices avant devant l'œil et sous l'axe optique, la caméra
  embarquée qui copie le champ de la caméra de vol, `dt = 0` qui n'avance pas le
  temps du maillage, `dispose()` qui vide la scène. Et la **boucle fermée** : le
  bord des disques projeté par la vraie caméra embarquée à travers la vraie
  matrice de montage retombe sur la mesure de la sonde à moins d'une ligne de sa
  grille, pour les six familles (p. ex. cinewhoop, sonde 45,7 % vs projeté
  46,2 %). La caméra qu'on monte est donc bien celle qu'on mesure.
- `tools/onboard-regime-selftest.mjs` (10) : **le câblage hélice ↔ moteur contre
  la physique**, pas contre le rendu. Lacet à gauche ⇒ l'avant-droite accélère
  et l'avant-gauche ralentit (3050 vs 0 rad/s), lacet à droite ⇒ l'inverse,
  tangage ⇒ les deux ensemble, roulis ⇒ en sens contraires ; montée en régime
  plus raide que la descente (+1371 puis −1231 rad/s, `tauSpinUp` 0,022 <
  `tauSpinDown` 0,045) ; pack vidé ⇒ plafond abaissé de 374 rad/s. **Correction
  de spec au passage** : la spec annonçait « roulis → une seule hélice bouge ».
  C'est faux — `mixOf()` donne `roll: ±1` aux deux avant, donc le roulis les
  sépare exactement comme le lacet (mesuré `+1080 / −1970` contre `+1080 /
  +1080` au tangage). Sur la paire visible, **seul le tangage a une signature
  propre** ; roulis et lacet partagent la leur. Corrigé dans la spec, dans la
  Bible §22 et dans le commentaire de tête du bloc 2 de ce selftest
  (`tools/onboard-regime-selftest.mjs:45`).
- `tools/drone-shape-selftest.mjs` (134, étendu) : les hélices naissent de
  `motorsOf()` — même table que le mixeur — et portent leur index moteur et leur
  `spin` ; les trois niveaux de détail ; et l'**empreinte de non-régression** :
  `shapeOf()` sans `detail` rend exactement la géométrie d'avant pour les six
  familles, donc les ambiants ne bougent pas.
- `tools/drone-mesh-selftest.mjs` (46, étendu) : les quatre régimes arrivent au
  shader, le fondu pales → disque, le soleil ramené dans le repère du modèle.
- `tools/drone-wire-selftest.mjs` (45) : la **projection fil de fer**, module
  pur sans Three ni DOM. Le test ne connaît aucune coordonnée — nombre d'arêtes
  recalculé depuis le `kind` de chaque primitive, bornes de la boîte,
  déterminisme, invariance d'échelle, sens de la profondeur, absence de NaN —
  donc il survit à un remontage de la caméra. Les six familles donnent six
  portraits distincts, de 628 à 784 segments.
- `tools/drone-portrait-render-selftest.mjs` (7) : l'**arbre SVG** sur le faux
  DOM — un SVG produit, tout en `currentColor` (aucune couleur en dur), `stop()`
  qui coupe l'animation, le dessin qui change d'une frame à l'autre sans lui,
  une famille inconnue qui ne casse pas la fiche, une session sans graine qui
  rend un blanc et non un jeton.
- `tools/archive-render-selftest.mjs` et `tools/flight-end-selftest.mjs`
  (étendus) : le portrait au `TARGET LOG` (sans graine, aucun `<svg>`), et la
  **place** du jeton `[PORTRAIT]` dans la timeline — après `SESSION TERMINATED`,
  avant qu'on rende la main, `TIMELINE.exitAt` toujours à 4,6 s.
- Les cinq nouveaux fichiers sont chaînés en queue de `npm run
  selftest:operator`, dans l'ordre du plan. La chaîne est verte (hors
  `landing-selftest.mjs`, qui échoue sur cette machine par `ENOENT` faute de
  `public/scenes/tour-eiffel` — échec d'environnement pré-existant).

### La borne DA a été révisée à la mesure

C'est la révision la plus importante de cette issue. La spec et l'issue
annonçaient « couverture ≤ 8 % de l'image, **rien au-dessus de 45 % de la
hauteur** ». Les 45 % sont **géométriquement intenables** pour freestyle5,
cinewhoop, heavy5 et toothpick : le plan d'hélice a un **horizon**, à
`(1 − tan(uptilt) / tan(champ/2)) / 2` de la hauteur du cadre — soit 50 % pour
une caméra plate. Les hélices vivent dans ce plan, elles tendent donc vers cet
horizon, et **aucune hauteur d'objectif ne les fait passer dessous** tant que
l'œil reste derrière elles. Les 45 % de la spec avaient été mesurés sur **une
graine par famille**, puis affirmés sur tout le domaine d'uptilt.

Arbitrage rendu : l'objectif **reste dans le châssis** (avancée figée au bord
avant de la plaque, `−0,55·armZ` — un objectif en porte-à-faux devant les
hélices tiendrait mieux la borne mais ne serait plus une machine crédible en
free cam ni au portrait), l'aire reste **≤ 8 %**, et la borne de hauteur devient
**≤ 50 % au pire tirage et ≤ 45 % en médiane**. La borne qui protège vraiment
l'image est celle de la surface. `tools/onboard-frame-selftest.mjs` et l'en-tête
de `tools/tune-mount.mjs` portent cette formulation ; la Bible §22 et la spec
ont été mises d'accord avec elle.

Autre correction de mesure : le tableau de l'issue #264 donnait le toothpick à
−8 mm à **30,9 %** de couverture médiane. C'est faux et hors d'atteinte — un
balayage exhaustif de son enveloppe caméra donne 20,9 % à 28,8 %, et deux
mesures indépendantes donnent **24,6 % en médiane, 28,7 % au pire**. Toutes les
autres cases du tableau se reproduisent au chiffre près. Corrigé dans
`docs/superpowers/specs/2026-09-06-drone-joueur-3d-design.md`.

### La borne ne mesurait pas ce qu'on affiche (corrigé après coup)

`tools/prop-coverage.mjs` ne rasterise que les **disques d'hélice**. L'issue en
a tiré « ≤ 8 % de l'image » comme si c'était toute la machine. C'en était une
pièce : les conduits, les bras et les moteurs occupent le cadre eux aussi.

Faute de cette mesure, **le boîtier de caméra de la recette est passé jusqu'à
l'écran**. La part `camera` est centrée exactement sur l'oeil — c'est sa
définition —, donc rendue dans la vue embarquée elle couvre tout le cadre :
mesuré, 765 rayons sur 765 bloqués, jusqu'à 100 % de la hauteur, sur les six
familles. Aucun test n'a bronché, parce qu'aucun ne regardait autre chose que
les disques. Le niveau `onboard` ne porte donc plus que les rotors.

`tools/lens-coverage.mjs` (neuf) mesure le maillage **tel qu'il est affiché** :
un rayon par pixel contre les vrais triangles fusionnés. C'est lui qui fait foi.
Ce que la machine occupe, au pire tirage de caméra :

| famille | la machine occupe | dont le carénage |
|---|---|---|
| longrange | 9 % | — |
| heavy5 | 14 % | — |
| race5 | 15 % | — |
| freestyle5 | 16 % | — |
| cinewhoop | 35 % | 19 points |
| toothpick | 44 % | 25 points |

Cette part est une **signature de famille**, pas un réglage. Avancer l'objectif
jusqu'à la lèvre du carénage fait bien tomber le cinewhoop à 10 %, mais les
hélices disparaissent avec (disques à 0,7 %, médiane nulle) — et les hélices
sont le sujet de l'issue. On ne casse pas la fonction pour tenir un nombre. Ce
qui est garanti pour les six, et testé, c'est que la **moitié haute du cadre
reste libre**.

`tools/tune-mount.mjs` cherche donc la hauteur sur les disques (le seul levier
dont ils dépendent), fige l'avancée au bord de la plaque, et **rapporte** ce que
la machine occupe sans chercher à l'optimiser. Sa règle de hauteur est
reformulée : « celle qui rend les hélices le plus présentes sous la borne » et
non « la plus grande » — la relation entre hauteur et couverture s'inverse selon
l'avancée, et l'ancienne formulation partait à la dérive dès qu'on essayait
d'avancer.

### Un bug pré-existant, corrigé au passage

`toggleFreeCam()` **n'avait jamais été écrite**, alors que `src/main.js`
l'appelait sur la touche `C` (`else if (key === 'c') toggleFreeCam();`). La
caméra libre n'a donc **jamais** fonctionné avant cette issue : chaque appui sur
`C` levait une `ReferenceError`. `OrbitControls` était bien construit, mais avec
sa cible sur `(0,0,0)` et personne pour l'activer.

### Points connus, assumés

- **`src/lens.js` n'est couvert par aucun selftest** — il n'y a pas de GPU dans
  la chaîne. La seconde passe (`setOnboard()`, `clear: false`,
  `clearDepth: true`, insérée avant la passe d'objectif) et son **gel** par le
  même drapeau que la passe principale ne sont vérifiés que **par lecture et par
  `vite build`**. Le reste du chemin embarqué (la scène, la caméra, les régimes,
  l'exclusivité) l'est bien par `onboard-drone-selftest.mjs`, qui ne passe pas
  par `lens.js`.
- **`.session-portrait` et `.drone-portrait` n'ont aucune règle dans
  `src/style.css`.** Les nœuds existent et sont monochromes par héritage
  (`currentColor`), mais leur mise en page est celle par défaut du navigateur —
  à voir à l'œil avant de décider s'il faut des règles.
- **La touche `C` reste inerte sur le chemin de dev `?live=`** : `freeCam` naît
  dans `finishBoot()`, que ce chemin ne traverse pas. `toggleFreeCam()` rend la
  main plutôt que de lever — inerte, pas fatal.
- **Le `TARGET LOG` ne montre qu'UNE machine**, la plus récente, pas une
  machine par entrée. La spec l'appelait « l'étagère de la collection » : elle
  ne l'est pas encore. À rouvrir si le besoin d'un vrai mur de machines se
  confirme (la spec avait déjà écarté un écran de collection dédié).
- **`applyBenchConfig()` peut changer la cellule à chaud sans reconstruire le
  maillage du joueur.** `physics.setProfile()` change le profil qui vole, mais
  `playerDrone` n'est construit qu'à l'ouverture de session : au banc, changer de
  famille sans relancer laisse les hélices de l'ancienne machine dans le champ.

### Vu dans le navigateur — la vue embarquée et la free cam

Vérifié sur le GPU de l'utilisateur (Chromium via MCP chrome-devtools), banc
`BENCH` sur `tour-eiffel`, freestyle5, `__sim.teleport()` + `__sim.setInput()`
pour tenir une pose stable :

- **La carrosserie a bien disparu du champ.** Sur `main` avant ce correctif, le
  boîtier de caméra et la batterie occupaient l'écran entier — c'est ce que
  montrait la capture de reproduction. Après, le monde est visible de haut en
  bas et la moitié haute du cadre est libre, comme le selftest le promet.
- **Les hélices sont là et le fondu fonctionne.** À 1 744 rad/s (`uOmega` lu à
  chaud sur le matériau embarqué, égal à `physics.propulsion.omega`) les pales
  ont cédé la place au disque ; au ralenti ce sont des pales pleines.
- **La free cam (`C`) marche** et montre la machine entière ; le retour à la vue
  embarquée aussi (`lens._onboardOn` bascule dans les deux sens).

### NON vérifié — ce qui reste à juger à l'œil

1. **La taille de la machine en free cam.** Le recul de 1,5 m
   (`FREE_CAM_BACK_M`) donne un freestyle5 dont le **châssis opaque mesure 80 px
   de large dans un cadre de 1 686 px, soit 4,7 %** (mesuré sur capture, seuil
   de luminance ; les disques d'hélice translucides élargissent un peu la
   silhouette). C'est lisible mais petit — « enfin regardable » demanderait
   sans doute un recul plus court. Le `minDistance = 0.4` n'a pas été éprouvé à
   la molette.
2. **La présence des hélices sur fond clair.** `PROP_ALPHA = 0.35` sur un
   disque au-dessus d'une ville en plein soleil passe presque inaperçu ; sur
   ciel, il se lit bien. À trancher : est-ce le comportement voulu (une hélice
   en rotation EST translucide) ou faut-il remonter l'alpha ?
3. **Le fondu à la montée en gaz** (continu ou strobe) et la **lisibilité du
   lacet** sur la paire visible : ça demande une capture vidéo, pas des images
   fixes.
4. **Le portrait.** La lisibilité à 160 px a été regardée et retravaillée
   (issue #283, ci-dessous) ; restent la vitesse de rotation (un tour en 24 s)
   et surtout **le ton** : au crash, il doit arriver comme ce qu'il reste, pas
   comme une récompense. C'est la révision de Bible §24 ; si l'effet est celui
   d'un trophée, c'est la révision qu'il faut refaire, pas le code.

```text
1. npm run dev, puis FIELD → une zone → TARGET SCAN → hack → JACK IN
   (ou ?family=<famille> pour sauter le scan et voler une famille précise :
   freestyle5, race5, cinewhoop, longrange, heavy5, toothpick).
2. En vol : regarder le bas du cadre. Deux hélices, pas quatre, confinées en
   bas. Gaz plein puis coupés : le fondu pales → disque et le retard moteur.
3. Lacet seul, à fond à gauche puis à droite : les deux hélices doivent partir
   en sens contraires, et s'inverser avec le manche. Tangage : les deux
   ensemble — c'est le seul axe qui a sa signature à lui. Roulis : en sens
   contraires aussi, comme le lacet.
4. Fin de pack : le régime plafonne plus bas — les hélices doivent l'annoncer
   avant l'OSD.
5. Touche `C` : la machine entière, éclairée comme les ambiants. Orbiter,
   zoomer à fond (on ne doit pas rentrer dedans), ressortir : les hélices
   reviennent, jamais les deux exemplaires à la fois.
6. Se crasher. Après SESSION TERMINATED, le portrait doit tourner lentement.
   Juger le ton, pas seulement le dessin.
7. SESSION LOG, ouvrir une fiche de session : le portrait sous la fiche (qui
   porte le Randomart), avant les photos. TARGET LOG : le portrait de la
   DERNIÈRE cible, en tête, légendé `LAST TARGET // …`. Une session d'avant
   #264 doit se dessiner aussi (aucune migration) ; une session sans graine ne
   doit rien montrer — ni cadre vide, ni jeton en clair.
8. Photos (touche F) : les hélices doivent y être — elles passent par
   l'objectif, donc elles sont dans la sortie du composer.
9. Mode DIGITAL, image perdue : les hélices doivent geler AVEC l'image, et non
   continuer à tourner derrière.
```


## Le visuel des frames du joueur (issue #283)

Suite de #264/#281 : la recette aux niveaux `onboard` et `portrait`, le
maillage, le fil de fer et la free cam ont été **rendus et regardés** — pas en
jeu (aucune scène sur cette machine) mais hors jeu, à géométrie et shader
identiques.

### Vérifié — rendu hors jeu, regardé

- **Fil de fer**, six familles × {160 px, 200 px, 400 px} × {fiche d'archive,
  assistant de calibrage, roulis 30°}, SVG produit par `wireOf()` et capturé
  par Chromium headless. Avant : une tache — les pales en boîtes vrillées
  (144 arêtes qui ne dessinent rien), les cloches qui doublent les moteurs
  (288 des 640 segments du freestyle étaient des cylindres de moteur). Après :
  les pales se lisent comme des pales, les disques et les bras portent le
  dessin, le détail s'efface. 610 à 756 segments par famille.
- **Vue embarquée et free cam**, WebGL via SwiftShader (`--use-angle=swiftshader`),
  `PlayerDrone` monté exactement comme dans `main.js` : les pales tournent
  avec la phase (`uPhase`, vérifié à ω = 60 rad/s, dt = 20 ms : 1,2 rad), le
  fondu vers le disque à 1 800 rad/s, le bord du disque doux, le voile plus
  dense au moyeu. Le reflet et le liseré se voient sur les flancs à un gain
  d'exposition ×3 — ce que l'AGC de la lentille fait en jeu — pas à gain 1, où
  la machine reste presque noire sur ciel clair : la couleur du carbone est
  celle de la palette, ce n'est pas un bug.
- La **silhouette des ambiants** n'a pas bougé : les six empreintes de
  `drone-shape-selftest.mjs` passent telles quelles ; la formule du disque sans
  pales est textuellement celle d'avant (les termes nouveaux sont multipliés
  par `uBlades`).
- La **borne DA** tient : `onboard-frame-selftest.mjs` et
  `onboard-drone-selftest.mjs` inchangés et verts. Le moyeu a d'ailleurs été
  retiré du niveau `onboard` pour cela — sur le toothpick (objectif à 1,5 mm du
  plan d'hélice) il montait à 51 % de la hauteur du cadre.

### NON vérifié — en jeu

1. Le rendu POV à travers la passe d'objectif (bruit, AGC, gel DIGITAL) : les
   captures ci-dessus sont sans lentille.
2. Le ralenti des pales en mouvement (strobe attendu entre 150 et 377 rad/s,
   comme sur une vraie caméra) et le rolling shutter du disque en vidéo.
3. La free cam à 0,8 m avec le vrai champ de 100 à 150° — le chiffre est un
   calcul, pas une capture.
4. Le portrait dans les trois écrans réels, avec les nouvelles règles CSS
   (`.drone-portrait`, `.session-portrait`) : rendu sur faux DOM seulement.


## Châssis par build, GoPro, marque du propriétaire — et la vérification en jeu (issue #285)

### Comment la vérification en jeu a été faite (réutilisable)

Il n'y a pas de GPU ni de scène installée sur cette machine ; il y a du réseau
vers `kh.google.com` par le proxy de la session, que Chromium ne sait pas
traverser (son CONNECT est réinitialisé). Le montage :

1. `NODE_USE_ENV_PROXY=1 node tools/add-map.mjs "Trocadero test" 48.862 2.288
   --provider google-earth --radius 12 --slug trocadero-test` — une scène de
   1,4 MB en une seconde (Node passe par le proxy). L'entrée ajoutée à
   `public/scenes.json` n'est PAS commitée.
2. Un relais HTTP local (`fetch` Node vers `kh.google.com`, CORS ouvert) et
   `VITE_ROCKTREE_BASE=http://127.0.0.1:8124/rt/earth/ npx vite` : le terrain
   live du jeu passe par lui (`tools/lib/rocktree/url.mjs`).
3. Chromium headless (`/opt/pw-browsers`, `--use-angle=swiftshader`) piloté
   par CDP depuis Node 22 (WebSocket natif, sans Playwright) :
   `Page.navigate`, `Runtime.evaluate` sur `window.__sim`, `Input.dispatchKeyEvent`
   pour `C`, `Page.captureScreenshot`. 2 à 4 fps ; le jeu tourne.
4. `?scene=trocadero-test&family=freestyle5&build=g1::0` : le chemin dev avec
   un exemplaire tiré (`?build=`, ajouté pour ça). `?live=` ne construit pas le
   drone du joueur (`openFlightSession()` en sort tout de suite) : inutile ici.

### Vu en jeu

- **POV** : les bras dans les coins bas du cadre, les disques d'hélice de la
  couleur des pales (roses sur `g1::0`) à travers l'objectif, le brouillard et
  l'AGC. Avant densification du voile, une ombre brune à peine visible.
- **Lacet** : `physics.propulsion.omega` à `[2637, 2121, 2117, 2637]` sur un
  lacet à droite — la paire avant se sépare comme le selftest le promet.
- **Free cam** (`C`) à 0,55 m : la machine occupe ~170 px sur 1 280, les
  disques translucides prennent la couleur des pales. Le corps reste une
  silhouette sombre sur ciel clair : c'est l'exposition, pas un bug.
- **Session terminée** par perte de lien (la scène est minuscule, le drone en
  sort) : la séquence de fin se joue, `[ENTER] DISCONNECT / [R] REDEPLOY`.

### NON vérifié en jeu

1. **Le portrait au crash** : aucun crash obtenu — à 4 fps le pas de temps est
   borné, la chute est lente, et la scène de 12 m de rayon est quittée avant
   l'impact (perte de lien, pas crash). Le SVG lui-même a été rendu dans un
   vrai Chromium hors jeu et le câblage est couvert par les selftests sur faux
   DOM.
2. Le sergé carbone, l'usure, le numéro et l'objectif GoPro à travers
   l'objectif de vol : la free cam en jeu est trop loin et trop sombre pour
   les lire ; ils ont été rendus et lus hors jeu (gros plans, gain ×2,5).
3. Le strobe des pales au ralenti et le rolling shutter en mouvement.

### Ce qui a été ajouté

- `tools/target-frame.mjs` + `target-frame-selftest.mjs` (46) : patrons,
  fréquences par famille à ±7 %, un bras arrive toujours à son moteur pour
  les 6 familles × 4 patrons, la silhouette ne lit pas le châssis.
- GoPro : objectif au `portrait`, boîtier dans la livrée. Propriétaire :
  numéro (autocollant, classe `STICKER` du shader, police 3×5 lue depuis
  l'arrière — rendu et lu, deux orientations fausses avant la bonne) et ruban.
- `target-livery-selftest.mjs` : 43 vérifications.


## Cloches dans le champ, hémisphère, fil de fer allégé, banc (issue #286)

- Les **cloches** passent au niveau `onboard` : dans le champ, les coins bas
  montrent la couleur du build (rendu hors jeu, g1::0 : cloches violettes sous
  les pales roses). En jeu, à travers l'objectif, elles se devinent — la
  lentille désature les coins bas.
- **Hémisphère ciel/sol** dans `DroneMaterial` (`lit = 0,45 + 0,25·(½ + ½·n.y)
  + 0,45·soleil`). Les ambiants le prennent aussi (même shader, un pixel à
  cent mètres). En jeu la free cam reste sombre contre un ciel exposé par
  l'AGC : c'est l'exposition, pas l'éclairage.
- **`minWeight`** dans `wireSvg()` ; `dronePortrait()` le pose à 0,18 sous
  200 px. Rendu à 160 px : les disques, les bras et le corps restent, le détail
  s'en va.
- **`TARGET LOG`** : la livrée sur la ligne sous `LAST TARGET`.
- **Banc** : `applyBenchConfig()` reconstruit `playerDrone` avec l'exemplaire
  qui vole. Non vérifié en jeu (le panneau du banc n'a pas été piloté).

## Une livrée par build (issue #284)

Toutes les machines étaient peintes des quatre mêmes gris de la palette. Chaque
build porte maintenant une **livrée** (`build.livery`, `tools/target-livery.mjs`)
et le maillage une **classe de matériau** par sommet (`aMat` : carbone, métal,
plastique) avec un sergé carbone procédural.

### Vérifié — sans navigateur

- `tools/target-livery-selftest.mjs` (33) : déterminisme, flux de graine à part
  (`::livery::` — le profil et les rates ne bougent pas), hex et noms valides
  sur 240 tirages, pondérations par famille tenues à ±8 % sur 400 tirages
  (race5 vif 0,85, longrange 0,25), 60 freestyle ⇒ ≥ 40 livrées distinctes,
  `liveryColors(null)` vide (les gris restent), `liveryLabel`.
- `target-build-selftest.mjs` inchangé et vert : les tirages physiques n'ont
  pas bougé.

### Vérifié — rendu hors jeu, regardé

Six builds en free cam (WebGL headless, gain ×2,2 pour simuler l'AGC) : les
livrées se distinguent au premier regard — hélices néon / cloches bleues /
pack vert, hélices fumées / cloches argent, conduits bleus sur le toothpick.
Le POV à 1 800 rad/s montre un disque de la couleur des pales.

### Deuxième passe, regardée sur 24 générations

Rendu d'une planche de 24 builds (`g1::0` à `g1::23`, familles en rotation)
avant / après. Avant : des confettis — hélices roses, TPU rouge, LED bleue sur
la même machine. Après : `MATCH` dans `target-livery.mjs` assortit TPU, cloche,
sangle et LED aux hélices pour une part des builds (55 / 35 / 60 / 45 %),
hélices bicolores (`tip`, 25 % des race5, 5 % des long range), boîtier de
caméra en TPU, sangle de pack et barre de LED émissive au niveau `portrait`,
et l'**usure** (`wearOf` dans `target-build.mjs`, lue dans `internalOhm` et
`bodyDrag`, jamais tirée) : poussière dessous, éraflures, brillant éteint,
bouts de pales blanchis. `target-livery-selftest.mjs` passe à 38
vérifications (proportions d'assortiment, bicolores, usure bornée et
monotone).

### NON vérifié

1. Le sergé carbone à l'écran : porté par le reflet (la base #121110 est trop
   sombre pour l'albédo), il ne se juge qu'en mouvement et sous le soleil du
   jeu. Même réserve pour l'usure, qui est du même ordre de finesse.
2. Les couleurs à travers l'objectif de vol (AGC, bruit, DIGITAL) — jugées
   hors lentille.
3. La légende de livrée dans la fiche SESSION LOG, rendue sur faux DOM
   seulement.

## Essaim de drones (issue #29)

Récit complet, décisions et pièges : [handoff-archive/essaim.md](docs/handoff-archive/essaim.md).
Le lire avant de toucher `src/swarm.js`.

Le TARGET SCAN tire un *cluster* dans 10 % des cas (certain au 3e scan) : le hack
donne le nœud de commandement `swarmNode`, pilotable, et 6 à 12 unités
cinématiques. L'évitement du bâti est gratuit — les unités volent dans le sillage
du joueur, libre par construction — et le pire cas dégradé est la file indienne
dans ses traces, jamais la traversée de mur.

La vitesse des unités est réglée sur le nœud (issue #46) : `SWARM_UNIT.vMax` vaut
40 m/s contre les **33,4 m/s mesurés** du `swarmNode` (`NODE_TOP_SPEED_MS`), et
γ — le limiteur de pas — est **cherché par dichotomie** au lieu d'être divisé
par deux. Sans ces deux-là, l'essaim décrochait **définitivement** dès que le
joueur poussait les gaz.

### Vérifié

- `npm run selftest:ci` vert, essaim compris. `tools/swarm-selftest.mjs` balaie
  **cinq axes** : graine, vitesse, cadence (60/30/12/4 fps), géométrie (rues et
  épingles) et **taille d'essaim** (6..12). Chacun de ces axes a, en son temps,
  révélé une pénétration que le précédent ne voyait pas — ne pas en retirer un.
- L'essaim **suit le nœud à son plafond mesuré** : plein manche de 20 à 33,4 m/s
  l'étire de 3,9 à 13,9 m hors de ses slots, et il revient à 2,93 m **pendant que
  le nœud reste à fond**. Sur le code d'avant #46 ce même nombre vaut 263 m et ne
  se stabilise pas. Le décrochage est de nouveau un transitoire, pas une porte à
  sens unique.
- La propriété centrale tient **rayons tous bloqués** : les unités se replient sur
  le sillage pur, c'est-à-dire exactement là où le joueur est passé.
- Le budget de **6 rayons/frame** est tenu pour toute taille et toute doctrine,
  vérifié indépendamment sur ~19 000 vols.
- Zéro allocation par frame, identité des tableaux préservée.
- **Au navigateur** (Chromium headless CDP, `?live=` sur Paris, vol réel) : le jeu
  tourne sans exception, l'essaim existe, les quatre doctrines sont accessibles et
  distinctes, `drawCalls` = 2 par unité, 24 nœuds audio. Les drones sont
  **visibles à l'écran** — avant le réglage « entouré », ils ne l'étaient pas.

### Non vérifié

- **Personne n'a piloté** avec, sauf un vol du propriétaire du dépôt qui a produit
  les deux retours à l'origine des tranches 7 et 8. Le pilote synthétique du banc
  monte, dérive et finit dans le décor : il prouve que rien ne casse, pas que
  c'est beau.
- **Le son n'a jamais été entendu.** Les niveaux relatifs sont choisis, non
  mesurés, comme le reste du son du projet.
- Est-ce que 44 % d'unités « de flanc » se ressentent comme « entouré » : c'est un
  pari, pas une mesure.
- Un vol de cluster est **sans musique** (issue #36, décision de DA en attente).

### Pénétrations acceptées pour la v1 — ce sont des décisions

Dans le régime écrêté (frames de 250 ms), `LONG_FRAME_CEILING_M` vaut **6 m** :
un airframe plus rapide creuse mécaniquement les transitoires de repli, et le
tirage large (48 graines, tailles 6..12, six vitesses, 4 032 vols) est passé de
3,44 m à 4,12 m en montant `vMax` de 24 à 40. Contre l'ancien plafond de 4,5 m
il ne restait que 9 % de marge — la dernière mesure avec un chiffre rond posé
dessus, exactement le mode d'échec que ce module a déjà connu deux fois.

À cadence nominale, `ACCEPTED_TIGHT_M` et `ACCEPTED_WEAVE_M` restent à **1,5 m**,
remesurés sur l'airframe à 40 m/s : 0,85 m (épingle, 60 fps), 1,23 m (épingle,
30 fps), 0,47 m et 0,84 m (slalom). Ils lisent **moins** qu'avant, pas plus.
`ACCEPTED_TIGHT_M` est la ligne que `OFFSET_SLEW_MS` rend vraie : sans ce
plafond plat sur la vitesse de l'offset, le même balayage lit 1,54 m à 60 fps et
1,80 m à 30 fps.

Les constantes qui les portent vivent dans `tools/swarm-selftest.mjs` : **leur
rôle n'est pas d'être petites, il est d'être vraies**. Une constante ajustée à 1 cm de sa mesure échoue au premier changement
de graine — c'est arrivé deux fois.

Suites ouvertes : #34 (formations commutables), #35 (détection des angles),
#36 (musique), #37 (éclaireurs), #38 (cadences dégradées et budget de rayons),
#39 (plafond du bus audio), #40 (convergence `wedge`/`cloud`).

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
    propre volume (slider MUSIC, `fpvtp.musicVolume`, défaut 0,7).
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
    handover (D9 : `buildContext()` n'est jamais appelé pendant l'armement de
    `[ JACK IN ]` — anciennement l'armement du CONTROL VECTOR, retiré depuis,
    issue #33) a été relu dans le code mais pas observé en vol — la lecture de
    code n'est pas une observation.
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
    pourcents de la variante, à V1 comme à V4. *(Le rituel — et `RITUAL`
    lui-même — a depuis été retiré du vocabulaire sonore, issue #33 ; ces
    partitions n'existent plus.)*
  - **Vérifié dans le navigateur** (Chromium via CDP, `?scene=tour-eiffel`) :
    l'`AudioContext` passe bien à `running` au premier geste ; le graphe monte
    21 nœuds au boot, ce qui est exactement 5 notes de signature + `TERRAIN
    READY` + les 3 nœuds permanents de la porteuse ; **zéro nœud créé sur
    ~150 frames de vol**, donc la porteuse ne fuit pas ; les six rituels *(alors
    existants — retirés depuis, issue #33)* et les sept événements jouent sans
    exception ; aucune erreur console ni rejet non géré après une session
    complète, crash compris.
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
  - *(retiré, issue #33)* Rituels : un riser montait pendant la saisie du
    vecteur (`uiAudio.ritualTension(k)`, branche permanente à la manière de la
    porteuse) et retombait sur une erreur ; la complétion déclenchait une
    détonation en couches (sub + voix `blast`) suivie d'éclats répartis dans
    le champ stéréo (`pan` → `StereoPannerNode`). Tout ce paragraphe décrit un
    système supprimé avec le CONTROL VECTOR : `RITUAL` est sorti du
    vocabulaire sonore (`UI_EVENTS` : sept entrées, `SYSTEM`/`LINK`), et
    `playRitual`, `_ensureTension`, `ritualTension`, `killRitualTension` sont
    partis avec lui.
  - **Vérifié en Node** : `npm run selftest:operator` vert, 417 lignes `ok`
    (dont `intro-selftest.mjs` neuf, et le balayage du vocabulaire désormais
    clos à **huit** entrées avec `INTRO` — redescendu à sept depuis, `RITUAL`
    retiré).
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
    analogie et non mesuré) restent à juger à l'oreille, comme pour PHASE 18 —
    le paragraphe rituel ci-dessus est désormais sans objet.
  - Polissages différés en issue de suivi, dont un devenu sans objet :
    `_introMaster` jamais déconnecté (toujours vrai) ; skip pendant la
    résolution qui rejoue la signature depuis la première note (toujours
    vrai) ; `killRitualTension()` qui coupait sec sur un rituel abandonné
    (sans objet, la fonction a été retirée avec le rituel).

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

- **Le scanner sur une zone hors couverture déclarée** : le chemin `columns === 0`
  et le grisé des colonnes élaguées (`prunedBands`) sont testés unitairement,
  jamais vus en vrai — toutes les zones sondées à la main étaient couvertes. Ce
  chemin visait des régions Flyover déclarées ; `google-earth`, seul fournisseur
  depuis le retrait d'Apple Flyover (2026-09-07), n'a pas cette notion et ne
  déclenche jamais `pruned > 0` — le code reste, désormais inerte, pour un futur
  fournisseur à régions déclarées.
- **Ressenti de pilotage réel** (l'utilisateur n'a pas encore volé "pour de
  vrai" avec retour subjectif sur l'acro, les rates, l'expo).
- **Écran de réglages manette** (Tab, remapping avec barres de niveau) —
  code écrit, jamais testé interactivement par l'utilisateur.
- Modes `angle` et `altitude` du contrôleur de vol — testés uniquement par
  construction du code, pas en vol piloté.
- Exposer le serveur de dev par un tunnel expose aussi l'état opérateur
  (`/__operator`). Le serveur autonome le dit autrement : en `--mode local` il
  refuse un `--host` hors de la boucle locale, et `--mode shared` réclame une
  clé d'opérateur.
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

## Versionnage du dépôt (issue #257)

SemVer dans `sim/package.json`, entrées dans `CHANGELOG.md` à la racine, tag
`vX.Y.Z` + GitHub Release par version. Mode d'emploi : `docs/manuel.md`, section
« Versionner et publier ».

### Vérifié — sans navigateur

- `npm run selftest:release` : **15/15 PASS** (bump, refus d'un numéro qui ne
  monte pas, découpe et re-rendu du CHANGELOG, régénération des liens de
  comparaison, refus d'une section « Non publié » vide ou d'un doublon).
  Également câblé en tête de `npm run selftest:operator`.
- `npm run build` avec la version injectée : `__APP_VERSION__` sort en
  `"0.0.0"` dans le bundle, `window.FPVTP_VERSION` et une ligne de console.
- `npm run release -- minor` joué **en réel dans un clone jetable** : bump
  package.json + lockfile, section datée `## [0.1.0] - 2026-09-06`, nouvelle
  section « Non publié » vide, liens régénérés, commit `chore(release): v0.1.0`,
  tag annoté `v0.1.0`, aucun push. Relancé aussitôt, il refuse (« Non publié »
  vide). `node tools/release-notes.mjs v0.1.0` rend bien le corps de la section.

### CI — vérifié en local, pas encore sur un runner

- `.github/workflows/ci.yml` : un job, `sim` (`npm run selftest:ci` +
  `npm run build`), sur push `main` et sur chaque PR. Portait aussi un job
  `flyover-reverse-engineering` (`go vet`/`go build`/`go test`) avant le retrait
  d'Apple Flyover (2026-09-07).
- `npm run selftest:ci` = `selftest:operator` + `selftest:api` : **1 430
  vérifications en 129 s**, sans scène installée, sans réseau, sans navigateur.
  Mesuré ici, sur ce dépôt, `public/scenes/` vide, après rebasage sur `main` —
  la chaîne a gagné les cinq selftests d'ambiants de #250 (`ambient`,
  `drone-shape`, `drone-mesh`, `ambient-audio`, `ambient-drones`), qui pèsent
  297 vérifications et l'essentiel de la minute supplémentaire.
  Compte = lignes `ok` (1 015) + lignes `PASS` (415) ; la mesure précédente
  (1 009 en 58 s) ne comptait que les `ok`, sur une chaîne plus courte.
  Les trois selftests `onboard-*` de #266 pèsent les 70 `PASS` de plus.
- `tools/landing-selftest.mjs` — le seul de la chaîne qui lisait une scène —
  se retire maintenant en `SKIP` quand `public/scenes/tour-eiffel` est absente.
  C'est le modèle pour tout selftest qui aurait besoin de données de scène.
- Côté Go : `go build ./...`, `go vet ./...`, `go test ./...` passent
  (1 paquet testé, `pkg/mth`) sans `config.json`, qui n'est lu qu'à l'exécution.
- `npm run selftest` et `npm run selftest:scenes` restent **hors CI** par
  nature : ils lisent `public/scenes/`. `selftest:scenes` échoue d'ailleurs ici
  (3 scènes fantômes dans `scenes.json` : `paristest`,
  `conservatoire-national-des-arts-et-metiers`, `havre`) — c'est un état local,
  `node tools/sync-scenes.mjs` le règle.
- La release rejoue exactement `selftest:ci` avant de publier : ce qui sort en
  version a passé les mêmes vérifications que la CI.

### Pas de CD, et pourquoi

Le build statique **ne sait pas démarrer seul**. `src/operator.js` charge l'état
opérateur depuis `/__operator`, une API servie par `tools/map-api-plugin.mjs`,
qui est un plugin Vite `apply: 'serve'` — il n'existe qu'en `npm run dev`. Sans
lui, `loadOperator()` jette au boot : pas de terminal, pas de vol. S'y ajoute
que `public/scenes/` (~900 Mo) n'est ni versionné ni hébergé.

Déployer demanderait donc, au choix :
1. un repli statique pour l'état opérateur (localStorage) et pour la liste des
   scènes — la voie la moins chère, et la seule qui rende GitHub Pages jouable ;
2. ou un vrai serveur qui porte `/__operator` (+ les scènes) en production.

Rien de tout ça n'est fait. Tant que ce n'est pas tranché, la « livraison »
d'une version est l'archive `dist` attachée à la GitHub Release.

**Tranché le 2026-09-07** : ni l'un ni l'autre tel quel, mais un seul serveur
Node autonome (`sim/server/`, extrait du plugin Vite) en deux hébergements —
un VPS en mode `shared` (clé d'opérateur) et une app Electron installée en mode
`local`. Le design complet, les faits vérifiés qui le dictent et les quatre
tranches sont dans
`docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md`.

**T1 livrée le 2026-09-07.** `sim/server/` existe : `api.mjs` (les deux tables
de routes, déplacées sans changer un chemin ni un code de statut), `static.mjs`
(fichiers, `Range`, ETag faible, **pas de repli SPA**), `index.mjs` (la CLI et
`startServer()`, que le process principal d'Electron démarrera en T2),
`auth.mjs` (vide, T3). `tools/lib/paths.mjs` résout le répertoire de données ;
`tools/map-api-plugin.mjs` n'est plus qu'un adaptateur Vite de vingt lignes.

**Vérifié** : `node server/index.mjs --data <tmp> --dist dist` sert le jeu sans
Vite — intro, `OPERATOR SELECT`, `SELECT OPERATION MODE`, dans Chromium, avec
un opérateur créé par `POST /__operator` sur ce même serveur (2026-09-07).
`tools/server-selftest.mjs` (26 vérifications) est chaîné dans `selftest:ci` ;
`tools/session-api-selftest.mjs` tourne désormais contre le serveur autonome
(208 ms → 85 ms), et `tools/vite-adapter-selftest.mjs` garde l'adaptateur Vite
honnête.

**Pas encore vérifié** : `Range` et le cache `immutable` sur une VRAIE scène de
450 Mo (le selftest travaille sur 4 Ko) ; le serveur sous Windows ; un vol
complet servi par le serveur autonome. Et il reste T2 (Electron), T3 (clé
d'opérateur, `FPVTP_ACQUIRE`) et T4 (VPS) avant qu'une release soit jouable
telle quelle — `npm run build` copie encore `public/scenes/` dans `dist/`
(#290).

### NON vérifié

- `.github/workflows/ci.yml` n'a **jamais tourné sur un runner** : les commandes
  sont vérifiées ici, pas l'enchaînement GitHub Actions (cache npm, versions
  d'actions, `setup-go` sur un `go.mod` en `go 1.26.5`).
- `.github/workflows/release.yml` n'a **jamais tourné** : aucun tag n'a encore
  été poussé, aucune release n'existe. La première coupe (`npm run release --
  minor` → `v0.1.0`, puis `git push origin v0.1.0`) est son premier test.
  Points à surveiller ce jour-là : le `npm ci` du runner, le `npm run build`
  sans `public/scenes/` (gitignoré), et le droit d'écriture du `GITHUB_TOKEN`
  sur les releases.
- Rien n'affiche la version **dans l'UI** : elle n'est que dans la console et
  sur `window`. À décider si l'écran BOOT ou FIELD doit la porter — sachant que
  `BUILD NOTES` occupe déjà ce registre visuel avec des numéros diégétiques.

## Calibrage automatique des radios et manettes (issue #277)

Le panneau Tab a un bouton `CALIBRATE` qui **mesure** le périphérique au lieu de
le deviner. Avant : `padKind()` lisait la chaîne USB et appliquait un des deux
profils écrits à la main ; une radio absente de la liste des marques tombait sur
un ordre d'axes faux **et** un gaz en demi-course.

`src/calibration.js` est une machine à états pure — `feedSample(state, axes,
dt)` — sans DOM ni `localStorage`, ce qui permet de rejouer du vrai matériel
dans `tools/calibration-selftest.mjs`. Elle produit `{ channels, deadband,
throttleMode }`, rangé dans `fpvtp.gamepadCal` **par `pad.id`**.

Ce que la mesure remplace, et qui était supposé :

- le **neutre** de chaque axe (supposé à 0 — faux dès qu'un gimbal dérive ou
  qu'un manche à friction est parqué ailleurs) ;
- la **course** (supposée ±1 — faux sur toute radio dont les endpoints ne sont
  pas réglés : le pilote n'avait alors jamais son plein débattement) ;
- le **deadband**, désormais le bruit relevé au repos et non `DEADBAND = 0.06` ;
- le **mode de course du gaz**, observé en lâchant le manche (revient-il au
  neutre ?) et non déduit de la marque.

L'assistant tourne sur **sa propre boucle rAF** : `renderer.setAnimationLoop`
ne démarre qu'au décollage, or le panneau Tab s'ouvre aussi depuis le terminal.

### Vérifié — sans navigateur

- `tools/calibration-selftest.mjs`, 26 vérifications, dans `selftest:ci`.
  Deux d'entre elles rejouent des séquences d'axes de vrai matériel et
  vérifient que le calibrage **retrouve exactement** les profils écrits à la
  main (`defaultMapForKind('radio')` et `defaultMapForKind('generic')`).
- `tools/input-selftest.mjs` couvre le stockage par `pad.id`, la lecture des
  sticks à travers le calibrage, et le remap manuel appliqué à un calibrage.

### Vérifié à l'œil — Chromium piloté en CDP, manette injectée

`navigator.getGamepads` remplacée dans la page, axes pilotés depuis la console.
Constaté en direct sur l'écran SELECT OPERATION MODE (donc avant `boot()`) :

- les six consignes s'enchaînent, la radio simulée finit en `full travel`
  `-1.00 → 1.00` et la DS4 simulée en `half travel` — mode **mesuré** ;
- une diagonale volontaire et un axe déjà pris font redemander la consigne,
  message jaune à l'appui ;
- le calibrage survit à un rechargement et s'applique à `input.map` ;
- **le défaut de l'issue est reproduit puis corrigé en direct** : passer à la
  DS4 ne récupère plus le calibrage de la radio, les deux coexistent dans
  `fpvtp.gamepadCal` ;
- Échap ferme le panneau et abandonne la mesure sans rien écrire ;
- cocher `inv` sur un canal calibré suit dans le calibrage et **garde** le
  neutre et la course mesurés.

### NON vérifié

- **Aucune vraie radio ni vraie DualShock 4 n'a été branchée.** Tout ce qui
  précède passe par une manette injectée : la machine à états, l'écran et le
  stockage sont vérifiés, la lecture du matériel réel ne l'est pas. C'est le
  critère d'acceptation de l'issue, et il appartient au pilote.
- Personne n'a **volé** avec un calibrage. Que la course mesurée donne un
  meilleur ressenti que la course supposée reste à sentir, pas à lire.
- Les butées des trois axes centrés sont mesurées **d'un seul côté** et
  supposées symétriques. Une radio franchement asymétrique n'est pas couverte.

## Performance du chargement LIVE et du build (issue #21)

### Vérifié — sans navigateur, réseau réel

Point de départ, mesuré depuis cette session contre `kh.google.com` (joignable) :
le service répond `cache-control: no-cache, must-revalidate`, donc le cache
HTTP du navigateur ne garde ni bulks ni nœuds — **chaque recalcul de fenêtre
(tous les 50 m de vol) refaisait la marche entière depuis la racine** ; à
Paris, 300 m au niveau 21 : 1494 nœuds, 344 bulks, 345 requêtes. Et
`zoneOf()` retient un carré là où la fenêtre est un disque partout ailleurs
(confiance, fondu de bord, dôme) : 235 de ces 1494 nœuds (15,7 %) étaient
entièrement hors du disque, fetchés, décodés, cuits en Rapier et rendus dans
le brouillard de bord.

- **`traverse()` pipelinée** (`tools/lib/rocktree/traverse.mjs`) : file sous
  plafond de concurrence (`BULK_CONCURRENCY = 16`) au lieu de générations
  synchrones découpées en lots séquentiels de 8. Même ensemble de nœuds,
  epochs et flags — vérifié sur les fixtures contre l'oracle d'énumération
  (selftest existant) ET contre le service réel (dump des 437 et 1494 chemins
  avant/après, identiques). Un test de plus force un ordre d'arrivée aléatoire
  et un plafond de 3 en vol.
- **Cache de bulks + planetoid** (`createTraverseCache()`), persistant dans
  `src/rocktree-traverse-worker.js` pour toute la session de vol. Clé
  `chemin@epoch`, 404 mémorisés, éviction par ancienneté (2000 entrées),
  planetoid gardé 10 min ; un échec réseau n'y entre jamais.
- **Disque, pas carré** : `RocktreeWindow.update()` ne désire que les nœuds
  dont la box recoupe le disque de `loadRadiusM` (`boxIntersectsDisc`).
- **`bootLive()` recouvre ses latences** : la première traversée part AVANT
  `await initPhysics()`, et les Workers (pool de fetch + traversée) sont
  créés d'emblée (`warmUp()`), plus au premier `fetchNode()`.
- **Rapier par `import()`** (`src/physics.js`) : chunk séparé de 2 Mo, chargé
  au premier `initPhysics()` et préchauffé depuis le terminal
  (`chooseScene()`). Tout usage de `RAPIER` passait déjà par `initPhysics()`.

Mesuré, service réel, avec 60 ms de latence artificielle par requête pour
émuler une connexion domestique (le lien de cette machine est trop rapide
pour être représentatif ; sans ajout : 1243 → 567 ms) :

| | avant | après |
|---|---|---|
| traversée de boot, 300 m niveau 21 | 4269 ms | 2011 ms |
| recalcul après 50 m de vol | 3521 ms, 306 bulks | 80 ms, 9 bulks (297 en cache) |
| recalcul après 100 m | — | 151 ms, 21 bulks |
| nœuds fetchés/construits/rendus par vague | 1494 | ~1259 (−15,7 %) |

Build : un chunk de 2,94 Mo (1,03 Mo gzip) → `index` 417 Ko + `three` 466 Ko
+ `rapier` 2,06 Mo (différé) ; `tools/precompress.mjs` produit `.br`/`.gz`
(4,8 Mo → 1,0 Mo brotli) que `server/static.mjs` sert (11 vérifications de
plus dans `server-selftest.mjs`, 78 au total). `npm run selftest:ci` et
`npm run build` au vert.

### Deuxième passe (issue #22) : LOD par anneaux et cache disque — vérifié sans navigateur

- **Niveau de détail par anneaux** (`tools/lib/rocktree/lod.mjs`,
  `LOD_RINGS`) : niveau plein (21) jusqu'à 150 m, 20 jusqu'à 300 m, 19
  au-delà — CHOISI sur l'argument du pixel (à 150 m en FOV FPV 1080p, un
  pixel couvre ~0,2 m au sol, le niveau 21 y est sous-pixel). Une traversée
  par anneau, en séquence du plus fin au plus grossier (les suivantes ne
  touchent que le cache de bulks : 0 requête réseau, ~30 ms), puis
  `assembleLod()` : un nœud plus grossier exclut les octants qu'un nœud plus
  fin dessine (le mécanisme `exclude` de `build-node.mjs`), dans les deux
  sens (un fill-in peu profond côté fin, raffiné côté grossier, exclut ses
  descendants). `tools/rocktree-lod-selftest.mjs` (6 tests) vérifie sur un
  octree synthétique complet que **chaque point du disque est couvert
  exactement une fois** — centres de toutes les cellules du niveau 21 plus
  des couronnes serrées à 149/150/151 et 299/300/301 m — y compris avec un
  trou et un fill-in à cheval sur la couture. Le drone reste toujours dans
  l'anneau plein : la fenêtre se recentre tous les 50 m.
- **Cache disque** (`src/rocktree-cache.js`, Cache API `caches`) dans les
  deux Workers : NodeData et BulkMetadata persistés entre sessions, clé =
  URL (epoch incluse), jamais PlanetoidMetadata, réponses non-ok jamais
  stockées, éviction par nombre d'entrées (5000, comptées toutes les 250
  écritures), dégradation en fetch nu sans Cache API (contexte non sécurisé)
  ou si `open()`/`put()` échouent. `tools/rocktree-cache-selftest.mjs`
  (6 tests) avec des doublures de `caches`/`fetch`.

Mesuré contre le service réel (Paris, `?live=48.8578,2.2950`) :

| rayon | niveau 21 seul (après #21) | LOD | dont |
|---|---|---|---|
| 300 m | 1259 nœuds | 740 | 505 @21, 235 @20 |
| 600 m | 4176 nœuds | 1003 | 505 @21, 235 @20, 263 @19 |

Soit −41 % à 300 m et −76 % à 600 m de nœuds à fetcher, décoder, cuire en
Rapier et dessiner (un draw call chacun, ~624 Kio décodés chacun). Le curseur
« View range » à 600 m, qui pesait ~2,5 Go décodés, devient tenable.

### NON vérifié — rien n'a été VU en vol

Aucun navigateur dans cette session. À juger à l'écran sur `?live=48.8578,2.2950` :
**la couture entre anneaux** (à 150 m et 300 m du centre de la fenêtre : la
texture y passe d'un coup à 2× plus grossière, la géométrie aussi — si ça se
voit, écarter les rayons de `LOD_RINGS` ou n'en garder que deux), et
**le cache disque** (DevTools → Application → Cache Storage →
`fpvtp-rocktree-v1` doit se remplir ; un REDEPLOY au même endroit doit
booter avec zéro requête `NodeData`/`BulkMetadata` dans l'onglet réseau).
Puis, comme pour #21 :
que le boot reste stable (le sol attendu, la vague complète), que le drone
ne rencontre aucun bord de terrain visible à l'intérieur du disque (le fondu
de bord commence à `loadRadiusM − 50 m`, le culling à `loadRadiusM` — il ne
devrait donc rien changer à l'image), et que les recalculs en vol soient
maintenant imperceptibles (le worker de traversée annonce `cachedBulks`
dans sa réponse, lisible dans un `console.log` temporaire si besoin). Le
préchauffage de Rapier depuis le terminal n'a pas été observé non plus :
vérifier dans l'onglet réseau que `rapier.es-*.js` se charge pendant le
terminal et pas au FLY.

## Leviers de secours si besoin

- `npm run add-map -- … --cell 128` : cellules 128px au lieu de 256 (VRAM 1,65 Go → 413 Mo,
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


## Trous du terrain LIVE — exclude périmé (issue #31, régression de #22)

### Vérifié — sans navigateur, sur les vraies données kh.google.com

Le LOD par anneaux (#22) fait dépendre l'`exclude` d'un nœud de la POSITION de
la fenêtre. `RocktreeWindow.update()` ne re-fetchait qu'un chemin absent : un
nœud déjà chargé gardait le maillage de son ancien `exclude`. Mesuré à Paris,
rayon 600 m, pas de 50 m : 70 nœuds périmés au premier recentrage, 171 sur 706
après 300 m de vol (500 octants troués, 108 dessinés en double). Un nœud dont
l'`exclude` change est désormais libéré puis reconstruit ;
`tools/rocktree-window-selftest.mjs` le verrouille.

### Vérifié — en jeu, Chromium piloté en CDP

A/B sur la MÊME instance (`?live=48.8578,2.2950`), même vol simulé par
`__sim.teleport()` en 6 sauts de 60 m, `desired == built` à chaque étape (le
pipeline de build n'est jamais en cause). Le trou est mesuré par raycast
vertical sur une grille de 8 m dans le disque chargé moins 50 m de marge —
la bounding box d'un nœud ne suffit pas, elle reste pleine quand `exclude`
retire ses triangles.

| vol | sans le correctif | avec |
|---|---|---|
| 0 m | 0 % | 0 % |
| 60 m | 8,98 % | 0 % |
| 120 m | 12,57 % | 0 % |
| 180 m | 12,17 % | 0 % |
| 240 m | 11,36 % | 0 % |
| 300 m | 10,41 % | 0 % |
| 360 m | 8,52 % | 0 % |

Jusqu'à un huitième du sol manquant sous le drone, et zéro après correctif.

Écarté au passage, chiffres à l'appui : la baisse du nombre de nœuds en
volant (740 → 430 sur ce trajet) n'est PAS une perte — c'est la densité de
l'octree qui change, `tools/lib/rocktree/traverse.mjs` rejoué à froid en Node
sur les mêmes positions rend les mêmes comptes à ±2 nœuds. Le réseau non plus
n'est pas en cause : 1003 NodeData tirés à concurrence 24 vers kh.google.com,
0 échec.

### Le churn, vu puis supprimé

Le clignotement anticipé ci-dessus existait bel et bien — vu en vol par
l'auteur (« une sorte d'anneau qui recharge la zone »), puis mesuré en
sondant toutes les 200 ms après un saut de 80 m : **8,17 % du sol absent à
583 ms**, refermé avant 1,2 s. Les libérations passent avant les builds
(`processLiveNodeWork()`), donc l'ancien maillage partait à la frame suivante
et le nouveau arrivait ~1 s plus tard.

Remède posé : l'échange. `RocktreeWindow` marque la libération
`{ replaced: true }` quand le nœud reste désiré, `main.js` ne retire alors
rien, et `disposeLiveNode()` — extrait de la file de libérations, partagé par
les deux chemins — est appelé dans la frame même où le remplaçant est
construit. Pas de collider dupliqué : le retrait précède l'ajout d'une ligne.
Le même saut de 80 m mesure **1,99 %**, et ce résidu est du sol neuf (couronne
entrante), pas un trou. Si le refetch échoue définitivement, `_giveUp()`
libère l'ancien plutôt que de le laisser orphelin.

### Non vérifié

- Le pic résiduel n'a pas été décomposé nœud par nœud entre « couronne
  entrante » (irréductible sans précharger au-delà du rayon) et un éventuel
  reste de remplacements. La mesure par saut de 60 m dans une boucle est
  bruitée : le drone chute et dérive entre deux sondes, et un saut plus court
  que `REFRESH_THRESHOLD_M` ne déclenche aucun recentrage. Seul l'A/B sur un
  même saut de 80 m est propre.

## Portée de vue et trous résiduels (issue #32)

### Vérifié — en jeu, Chromium piloté en CDP, vol continu à 35 m/s

Le trou qui restait après #31 n'en était pas un : c'était le BORD du disque
chargé, à 300 m. Les anneaux de LOD s'arrêtaient à `levelDrop: 2`, donc la
portée coûtait au carré au-delà. Table prolongée (un niveau de moins par
doublement, jusqu'à 2 km), défaut 300 → 600 m, plafond du curseur 600 → 2000 m.

| portée | nœuds | textures | fps | boot |
|---|---|---|---|---|
| 300 m | 740 | 892 | 64 | 3,5 s |
| 600 m (nouveau défaut) | 1003 | 1200 | 62 | 3,5 s |
| 2000 m (plafond) | 1370 | 1635 | 56 | 4,0 s |

Trous mesurés au raycast pendant un vol continu à 35 m/s (128 km/h), cache
API vidé, sur ~1 km :

| réglage | moyenne | pic | fetchs en attente (max) | fps min |
|---|---|---|---|---|
| 300 m, 3 workers | 0 % en régime, 4-8 % au boot | 8,3 % | — | 64 |
| 2000 m, 3 workers | 0,86 % | 2,76 % | 219 | 47 |
| 2000 m, 6 workers | **0,44 %** | 2,43 % | **0** | 50 |
| 600 m, 6 workers (défaut) | **0,54 %** | 2,62 % | **0** | 52 |

Le résidu est la couronne entrante, au BORD du disque — à 540 m ou 1,9 km du
drone, pas sous lui. `desired == built` partout ailleurs.

Ce qui a été essayé et ANNULÉ faute de gain : monter les budgets de drain
(3→5 ms, 8→16 ms, seuil 50→20). Les pics coïncidaient avec la file de FETCHS,
pas celle des builds ; le budget n'était pas le goulot, le décodage l'était —
d'où le pool à 6 workers.

### Non vérifié

- Rien de tout ça n'a été piloté à la main : le vol est simulé par
  `__sim.teleport()` en pas de 3,5 m toutes les 100 ms. Un artefact qui
  n'apparaîtrait qu'avec une trajectoire réelle (virages, montées, arrêts)
  échappe encore à la mesure.
- Les chiffres viennent d'une seule machine et d'un seul lieu (Paris, dense).
  Une machine plus faible ou une zone plus étalée déplaceraient les seuils —
  le plafond de 2 km n'a pas été éprouvé ailleurs.
- La VRAM n'est pas mesurée directement : `textures × 0,58 Mo` est une
  estimation reprise de #191 (~948 Mo à 2 km), pas une lecture GPU.

## D'où vient le rechargement permanent en vol (issue #32)

### Vérifié — décomposé nœud par nœud, Node et en jeu

« Ça recharge en permanence quand le drone bouge » : mesuré, à chaque
recentrage de 50 m sur une fenêtre de ~980 nœuds (Paris, portée 600 m) —

| cause | nœuds/recentrage |
|---|---|
| sortent vraiment du disque | 12-22 |
| entrent vraiment (terrain neuf) | 12-17 |
| **changent d'anneau LOD (même sol, autre niveau)** | **108-204** |

Et par régime, en comptant les demandes faites aux workers :

| situation | demandés | déjà traités |
|---|---|---|
| drone immobile, 8 s | 0 | 0 |
| ligne droite 600 m, zone neuve | 1817 | 180 (10 %) |
| aller-retour 120 m, zone connue | 2852 | 1513 (53 %) |

Donc : à l'arrêt rien ne charge ; en ligne droite 90 % est du terrain neuf ;
le gâchis est le va-et-vient, et le churn d'anneau.

### Ce qui a été essayé et REJETÉ, mesuré

- **Ancrer les frontières d'anneaux sur une grille** (100/200/300 m) pour
  qu'elles cessent de balayer le sol : churn 124 → 148 → 171 par recentrage.
  Pire, parce que l'ancre saute alors d'un coup et déplace toute la frontière.
- **Élargir les anneaux** (400/800/1600) : churn 198, et 2639 nœuds au lieu de
  1003. Une frontière plus lointaine est plus longue, donc balaie plus.
- **Supprimer le LOD** (tout au niveau 21 sur 600 m) : le churn d'anneau tombe
  à 1, mais 260 nœuds sortent/entrent par recentrage au lieu de 16, pour 4176
  nœuds en mémoire au lieu de 1003. Travail total par recentrage : 261 contre
  140. Deux fois pire, quatre fois plus lourd.
- **Monter les budgets de drain** : voir plus haut, aucun effet, annulé.

Conclusion : la table d'anneaux actuelle est le bon compromis. Le churn est le
prix du LOD, pas un défaut à corriger.

### Ce qui a été gardé

Ne plus retirer un nœud remplacé par un autre niveau avant que son remplaçant
soit CONSTRUIT (drapeau `covered`, différé dans `main.js` jusqu'à ce que
`pendingNodeBuilds` soit vide). Premier essai côté fenêtre, sur
`pendingCount()` : creusait un trou plus grand (3,11 % de moyenne contre
0,54 %), parce que la fenêtre ne connaît que ses fetchs et ignore la file de
builds étalée sous budget.

### Non vérifié / à savoir

- Le gain chiffré du drapeau `covered` est FAIBLE et partiellement dans le
  bruit : sur deux paires de passes appariées (même trajet, 20 échantillons),
  pic 6,03/6,13 % sans contre 5,67/5,67 % avec ; moyennes 1,21/1,67 % contre
  1,48/0,99 %. Le pic baisse de façon reproductible, la moyenne non. Le
  mécanisme est gardé parce qu'il supprime une classe de trous par
  construction, pas sur la foi d'un gain démontré.
- Le va-et-vient (53 % de nœuds redemandés) n'est PAS traité. Le remède serait
  un cache LRU de nœuds construits (~624 Kio par nœud gardé) ; il n'a pas été
  chiffré ni implémenté.
- Rien n'a été piloté à la main : tous les vols sont simulés par
  `__sim.teleport()`.
