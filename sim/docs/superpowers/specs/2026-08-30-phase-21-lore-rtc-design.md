# PHASE 21 — Lore / RTC v0

Issue : [#58](https://github.com/lionrayonnant/FPVThePlanet/issues/58) · label `roadmap-da` · milestone P2
Branche : `phase-21-lore-rtc`
Sources : Bible §9 (Logs RTC), §10 (Le Crew), §11 (Language), §12 (Operator) ·
Roadmap PHASE 21

## Objectif

Donner sa personnalité au logiciel **sans créer de dette narrative**, et le
faire tenir sur la durée : un joueur qui passe des heures dans l'outil doit
continuer à découvrir des répliques qu'il n'a jamais vues.

Le moyen : un **corpus de dialogues écrit hors ligne à l'aide d'un LLM**,
livré en données statiques, puis interpolé au runtime avec le contexte réel de
la partie. Le jeu ne dépend **jamais** d'un LLM pour tourner.

Le lore reste décoratif. Un joueur qui ignore tout le RTC ne rate aucune
information de jeu, et aucune réplique ne promet une suite.

## État de départ

- `tools/rtc-model.mjs` (PHASE 05) est un **script unique de 27 lignes**,
  paramétré par `{name}` et `{tiles}` seulement, bouclé par
  `setInterval(…, 4500)` dans `src/scanner.js:662`. La boucle se voit dès
  ~2 minutes d'acquisition, et deux acquisitions différentes du même secteur
  donnent exactement le même dialogue.
- Le crew du code est `root · vex · mikhail · jensen`. La Bible §10 et l'issue
  #58 ne définissent que **root / jensen / mikhail** : `vex` est un résidu de
  l'exemple §9, jamais canonisé.
- Le seul point d'affichage est le panneau `RTC // INTERNAL` de l'écran
  d'acquisition (`.sc-rtc-block`, `src/scanner.js:159`). Aucun autre écran ne
  porte de voix.
- `tools/rtc-selftest.mjs` vérifie trois choses : déterminisme, appartenance au
  crew, remplissage des emplacements.
- Le dépôt a un motif net et sans exception : modèle pur dans `tools/*-model.mjs`,
  colle navigateur dans `src/`, selftest sans DOM branché sur
  `npm run selftest:operator`. La PHASE 21 le suit à la lettre.
- L'état opérateur vit côté serveur en JSON (D2 transverse) et `operator.patch()`
  écrit une clé de haut niveau en débounce.

## Décisions

### D1 — Le LLM est un outil d'atelier, jamais une dépendance du jeu

Le corpus est généré pendant le développement, validé, dédupliqué, relu par
échantillonnage, puis **versionné dans le dépôt**. Au runtime, le jeu ne fait
que sélectionner et interpoler.

Conséquence testée : rien sous `src/` ne peut atteindre `tools/dialogue/generate.mjs`,
et `public/dialogue/` ne contient que des données. Le selftest le vérifie —
c'est le critère d'acceptation 4 rendu exécutable plutôt que promis.

### D2 — Shards par événement, chargés à la demande, plus un pack de secours

Un `public/dialogue/manifest.json` et un fichier par catégorie d'événement. Le
scanner charge `acquire_area.json` et rien d'autre ; les catégories jamais
visitées ne coûtent rien.

Un pack de secours minuscule (quelques entrées par événement câblé) est compilé
dans le bundle : si le `fetch` échoue — build statique servi de travers, disque
lent — l'écran n'est jamais muet.

Alternatives écartées : un JSON unique importé par le bundle (5 Mo au démarrage
pour 2 % de lignes vues) ; une sélection côté serveur dans `map-api-plugin.mjs`
(casse le build statique, un aller-retour réseau par réplique).

### D3 — `requires` porte des chemins d'état, les slots en dérivent

Une entrée déclare les **chemins de contexte** dont elle a besoin
(`weather.windMs`, `target.rssiDbm`), pas des noms de slots. `catalog.mjs` tient
la table qui relie chaque slot d'affichage (`{wind}`) à son chemin et à sa
fonction de formatage.

`validate.mjs` refuse toute entrée dont un `{slot}` utilisé n'a pas son chemin
dans `requires`. Un placeholder non résolu devient **impossible par
construction** — critère d'acceptation 9 — au lieu d'être une affaire de
vigilance à l'écriture.

Corollaire : un contexte pauvre rétrécit le bassin de candidats, il ne casse
jamais un rendu.

### D4 — Le silence est un candidat comme un autre

Chaque événement déclare un `silenceWeight` qui entre dans le tirage.
`select()` peut rendre `null`, et c'est un résultat normal. Une acquisition où
le crew ne dit rien pendant une minute est une acquisition correcte, pas une
panne.

### D5 — La rareté de jensen est un mécanisme, pas une consigne d'écriture

Toute entrée où jensen parle porte un multiplicateur de poids **et** un seau de
refroidissement propre : il ne peut pas apparaître plus d'une fois toutes les
12 répliques, quelle que soit la taille du corpus et quoi qu'ait produit le LLM.

C'est la seule façon de tenir « autonomie importante, agenda inexpliqué » : son
mystère vient de sa rareté, et la rareté ne peut pas être garantie par un
prompt.

### D6 — La mémoire anti-répétition vit sur l'opérateur, sans bump de schéma

Un anneau des 256 derniers ids joués plus un compteur monotone par seau,
persistés dans une clé de haut niveau `dialogueMemory` via le `patch()`
débouncé existant — le bon coût pour une donnée cosmétique.

Pas de bump de `SCHEMA_VERSION` : une clé absente se lit comme une mémoire
vierge, ce qui est exactement le comportement correct pour un opérateur
existant. Pas de migration, pas de risque sur les états déjà sur disque.

### D7 — Crew : root / jensen / mikhail, plus une voix non humaine

`vex` est retiré du modèle et l'exemple Bible §9 est corrigé pour ne plus le
faire parler. Les interjections qui ne relèvent d'aucun des trois vont à `cron`,
un processus automatique — pas un personnage. Une voix qui n'est pas quelqu'un
ne peut par construction porter aucune intrigue.

### D8 — BUILD NOTES est rétrospectif et parle de l'outil

Une échelle de versions **écrite à la main** — le volume est trop faible et trop
curatorial pour la génération en lot. Chaque entrée porte une condition de
déblocage sur les compteurs déjà existants de l'opérateur (terrains gardés,
sessions volées, cibles scannées) ; le numéro de build affiché en pied de
terminal est celui de la plus haute entrée débloquée.

Ce qui l'empêche de devenir de la dette : les notes décrivent **l'outil au
passé**, jamais le joueur et jamais une suite. Un validateur refuse toute entrée
contenant une promesse de suite — même règle que pour le corpus RTC.

### D9 — Aucune réplique pendant le burst du rituel

Le crew parle avant l'armement du CONTROL VECTOR, jamais pendant. La culmination
de PHASE 10/20 est une seule chose à la fois ; y superposer du dialogue
détruirait les deux.

### D10 — Les deux invariants de PHASE 05 sont conservés et testés

Le RTC **ne bloque jamais** un bouton, une transition ou un vol. Il n'est
**jamais** une source d'information sur l'état réel du pipeline : ce que dit
mikhail sur une tuile corrompue est du décor, jamais un diagnostic.

## Architecture

### `tools/dialogue/catalog.mjs` (nouveau) — source de vérité

- `EVENTS` : la liste complète des ids d'événements, câblés ou non —
  `BOOTSTRAP`, `SYSTEM`, `AREA_SEARCH`, `PROBE_AREA`, `ACQUIRE_AREA`,
  `TERRAIN_PROGRESS`, `TARGET_SCAN`, `TARGET_SELECTED`, `TARGET_ANALYSIS`,
  `HACK`, `MANUAL_OVERRIDE`, `JACK_IN`, `FLIGHT`, `LINK_DEGRADED`,
  `LINK_RESTORED`, `CRASH`, `SESSION_COMPLETE`, `REVISIT`, `WEATHER`.
  Chaque événement porte son `silenceWeight` et sa cadence d'affichage.
- `SLOTS` : chaque slot déclare `{ path, format }`. Table initiale, avec sa
  source réelle :

  | slot | chemin | source |
  |---|---|---|
  | `{location}` | `area.name` | scanner / session |
  | `{operator_name}` | `operator.name` | `operator.js` |
  | `{weather_summary}` | `weather.day0` | `headline()` de `weather-model` |
  | `{wind}` | `weather.windMs` | snapshot météo |
  | `{rain}` `{visibility}` | `weather.day0.*` | `formatVisibility()`, idem |
  | `{drone_type}` | `drone.family` | `PROFILES[…].label` |
  | `{video_type}` | `target.video` | `describeTarget()` — `ANALOG`/`DIGITAL` |
  | `{signal}` | `target.rssiDbm` | `describeTarget()` |
  | `{hack_type}` | `target.hackType` | `HACK_TYPES` |
  | `{target_count}` | `scan.count` | `generateTargetScan()` |
  | `{terrain_size}` `{terrain_mb}` | `terrain.*` | statistiques du pipeline |
  | `{gpu}` `{display}` | `machine.*` | même lecture que `bootstrap.js:35` |

  `{session_duration}` est déclaré mais sans source en v1 : ses événements
  (`SESSION_COMPLETE`) ne sont pas câblés. Les entrées qui l'exigent sont
  générables et simplement jamais éligibles — c'est le comportement voulu.
- `RARITY` : `COMMON` 100 · `UNCOMMON` 30 · `RARE` 8 · `VERY_RARE` 2.
- `CREW` : `root`, `jensen`, `mikhail`, `cron`.

### `tools/dialogue/render.mjs` (nouveau) — pur

`render(entry, ctx)` interpole les slots et **jette** si un `{…}` subsiste. Le
runtime ne rattrape pas cette exception : elle ne peut se produire que sur un
corpus qui n'a pas passé `validate.mjs`, donc en développement.

### `tools/dialogue/engine.mjs` (nouveau) — pur, `rng` injecté

`select({ event, pool, ctx, memory, rng })` :

1. bassin = entrées dont `events` contient l'événement ;
2. éligibilité = tous les chemins de `requires` résolvent à non-`null` ;
3. refroidissements = trois seaux — id d'entrée (anneau 256), paire de
   personnages, événement — plus le seau propre de jensen (D5) ;
4. poids = poids de rareté, × 0,35 si l'entrée a déjà servi mais est sortie de
   l'anneau (le matériel jamais vu remonte, sans jamais devenir impossible) ;
5. le `silenceWeight` de l'événement entre dans le tirage (D4) ;
6. rend `{ entry, memory }` ou `null`. Aucun `Math.random`, aucun `Date.now`.

### `tools/dialogue/validate.mjs` · `dedupe.mjs` · `inspect.mjs` (nouveaux)

- `validate.mjs` : forme de l'entrée, `speaker ∈ CREW`, slots vs `requires`
  (D3), longueur maximale d'une réplique, liste noire de style (adresse au
  joueur, « the player »/« the game », quatrième mur, vocabulaire IA moderne,
  promesse de suite), événements connus, rareté connue.
- `dedupe.mjs` : quasi-doublons par trigrammes normalisés (Jaccard). Aucune
  dépendance, aucun embedding — les doublons d'un LLM se ressemblent
  lexicalement, c'est suffisant et ça reste vérifiable à la main. À l'échelle
  visée, la comparaison naïve de toutes les paires est trop chère : un **index
  inversé de trigrammes** ne compare que les entrées qui partagent au moins un
  trigramme, ce qui ramène le coût au voisinage réel de chaque entrée.
- `inspect.mjs` : rend N tirages avec des contextes factices, pour la relecture
  humaine par échantillonnage. `--review` marque les entrées relues.

### `tools/dialogue/generate.mjs` + `prompts/` (nouveaux) — dev uniquement

**Correction post-implémentation.** Cette section décrivait à l'origine deux
dos pour `callModel(prompt)` : l'API Messages via `fetch` si
`ANTHROPIC_API_KEY` était présent, sinon `claude -p`. Le dos API Messages n'a
jamais été écrit : aucune clé n'existait dans l'environnement pour l'exercer,
et du code jamais exécuté est du code faux qui s'ignore — mieux vaut l'absence
qu'une fausse promesse de chemin testé (issue de suivi ouverte pour qui aura
une clé). Le SDK officiel aurait aussi introduit une dépendance, ce que la
contrainte du projet interdit sans raison forte.

Ce qui existe réellement est un drapeau `--backend claude|ollama` :

- `claude` (défaut) pilote `claude -p --output-format json` en sous-processus,
  le prompt passé par stdin pour ne pas heurter les limites d'arguments d'un
  gros lot ;
- `ollama` pilote un modèle local via `POST /api/generate` sur
  `http://127.0.0.1:11434` (configurable par `--ollama-host` ou `OLLAMA_HOST`),
  modèle par défaut `batiai/qwen3.6-27b:q3`, timeout large (10 min) car un lot
  sur un GPU domestique peut swapper la VRAM.

Zéro nouvelle dépendance dans les deux cas : le premier dos est un
sous-processus CLI, le second un `fetch` HTTP nu.

Le dos local est devenu le **chemin principal pour la génération en lot** :
mesuré à **4,9 s par entrée**, soit environ **9 heures pour tout le corpus, à
coût nul** — contre une estimation de 100 à 200 USD via l'API hébergée pour le
même volume. `claude -p` reste le défaut du script (le chemin documenté sans
setup local) mais n'est plus le chemin visé pour produire les 3000 à 5000
répliques du corpus.

Trois leviers contre l'effondrement stylistique, tous dans le prompt de lot —
c'est le vrai risque du procédé, 200 entrées d'affilée convergent sinon vers le
même rythme :

- **distribution de formes** imposée par lot, tirée d'un calendrier (one-liner,
  échange à deux, à trois, observation, désaccord, interruption, remarque
  cryptique) : la diversité vient de la structure, pas des synonymes ;
- **digest de l'existant** pour cet événement (les premières répliques, pas le
  corpus entier) avec consigne de ne pas y revenir ;
- **rareté ciblée** par lot : les `VERY_RARE` sont écrites en petite série avec
  un prompt distinct, jamais piochées dans un lot commun.

`prompts/` versionne la bible des personnages, les règles de style et un brief
par événement — ce que le crew peut plausiblement savoir sur cet écran, quels
slots y sont disponibles. Le procédé est ainsi reproductible par un tiers, ce
qui est la condition pour que le pipeline soit lui-même open source.

Chaîne obligatoire : `generate → validate → dedupe → inspect`. Rien n'entre dans
`public/dialogue/` sans passer les trois.

**Volume visé en v1 : 3000 à 5000 entrées** sur les événements câblés, soit
400 à 800 par catégorie. À ce volume un joueur ne fait pas le tour du corpus,
et c'est précisément l'objectif : la nouveauté doit tenir des heures, pas une
soirée. Le runtime ne bouge pas si le corpus décuple encore.

**Politique de relecture humaine.** À cette échelle, relire chaque entrée n'a
pas de sens ; relire au hasard non plus, parce que toutes les entrées ne
coûtent pas la même chose quand elles sont ratées. La règle :

- **100 % des `RARE` et `VERY_RARE`**, et **100 % des répliques de jensen** —
  petit volume, impact maximal. Ce sont les lignes qu'un joueur remarque, celles
  qui donnent l'impression d'avoir vu quelque chose ; une seule qui sonne faux
  ou qui promet une suite abîme tout le dispositif (D5, critère d'acceptation
  de l'issue).
- **échantillon de 10 % des `COMMON` et `UNCOMMON`**, tiré par `inspect.mjs`.
  Si le taux de rejet d'un échantillon dépasse 5 %, le lot entier est jeté et
  regénéré plutôt que rapiécé : un lot mauvais l'est pour une raison de prompt,
  pas entrée par entrée.

`validate.mjs` et `dedupe.mjs` restent exhaustifs, eux — c'est ce qui rend la
relecture par échantillon défendable : tout ce qui est mécaniquement
vérifiable l'est sur 100 % du corpus, et l'humain ne juge que le ton.

### `src/dialogue.js` (nouveau) — colle navigateur

- charge un shard à la demande, le met en cache pour l'onglet, retombe sur le
  pack de secours en cas d'échec ;
- hydrate la mémoire depuis `operator.dialogueMemory`, la republie en `patch()` ;
- `mount(el, { event, context })` → `stop()`. Écart aléatoire borné entre deux
  échanges ; les répliques d'un même échange tombent une par une avec un temps
  de battement, pour que ça se lise comme quelqu'un qui tape.

### `src/dialogue-context.js` (nouveau)

`buildContext()` assemble l'objet de contexte brut depuis ce qui est vivant à
l'instant de l'appel : opérateur, scène, scan/cible, profil de drone, snapshot
météo, machine. Aucun calcul, aucune mise en forme — le formatage appartient à
`catalog.mjs`, qui réutilise `headline()`, `windLabel()`, `formatVisibility()`
et les `label` de `drone-profiles` pour que le crew et le HUD ne décrivent
jamais la même météo avec deux vocabulaires différents.

### `tools/buildnotes-model.mjs` + écran BUILD NOTES (nouveaux)

Modèle pur : l'échelle de versions, les conditions de déblocage, la résolution
« quelle est la build courante pour cet opérateur ». L'écran est monté depuis la
navigation du terminal, dans le style des écrans existants.

### Fichiers modifiés

- `tools/rtc-model.mjs` : **supprimé**. Ses 27 lignes deviennent les premières
  entrées `ACQUIRE_AREA` du corpus ; les répliques de `vex` sont réattribuées
  à `cron` ou à mikhail selon le ton, jamais conservées telles quelles.
- `tools/rtc-selftest.mjs` : remplacé par `tools/dialogue-selftest.mjs`.
- `src/scanner.js` : le `setInterval` RTC laisse place à `mount()`. Les écrans
  de recherche et de sonde reçoivent `AREA_SEARCH` / `PROBE_AREA`.
- `src/target-scan.js`, `src/hack.js` : un emplacement réutilisant le style
  `.sc-rtc`, et le respect de D9.

  **Correction post-implémentation.** Une version antérieure de cette section
  citait `src/entry-state.js` comme point d'appel de l'événement `WEATHER`.
  Ce fichier n'est pas un écran : c'est le générateur d'état de spawn de la
  couche physique (PHASE 11, tirage pondéré + double filet de sécurité avant
  le premier stick touché) et il ne connaît rien du moteur de dialogue.
  `WEATHER` est câblé dans `src/target-scan.js` (écran TARGET SCAN, voir
  `sayOnce('WEATHER', scanContext({ scan, weather }))`).
- `src/terminal.js`, `tools/terminal-model.mjs` : entrée `BUILD NOTES` et
  numéro de build en pied.
- `package.json` : `dialogue-selftest.mjs` et `buildnotes-selftest.mjs` dans
  `selftest:operator`.
- Bible §9 : l'exemple corrigé pour ne plus faire parler `vex`.

## Vérification

### Sans navigateur (`npm run selftest:operator`)

1. aucun placeholder non résolu sur N tirages × M contextes, dont des contextes
   volontairement pauvres (ni météo, ni cible, ni machine) ;
2. chaque entrée du corpus livré est atteignable par au moins un contexte —
   pas de matériel mort ;
3. le refroidissement empêche effectivement une répétition immédiate, sur une
   longue série de tirages ;
4. la fréquence de jensen reste sous son plafond sur 1000 tirages ;
5. chaque `speaker` du corpus appartient au crew ;
6. la distribution de rareté observée suit les poids déclarés ;
7. `select()` rend `null` à une fréquence cohérente avec `silenceWeight` ;
8. le corpus livré passe `validate.mjs` et `dedupe.mjs` en intégralité, et
   `dedupe.mjs` termine en un temps raisonnable sur le corpus complet ;
9. `public/dialogue/` ne contient que des données, et aucun module de `src/`
   n'importe `tools/dialogue/generate.mjs` (D1) ;
10. BUILD NOTES : monotonie des déblocages, aucune promesse de suite,
    résolution correcte de la build courante à compteurs nuls ;
11. `npm run selftest` reste vert — aucun élément de DA n'a touché la physique.

### Navigateur

- une acquisition longue ne montre aucune boucle visible et aucune répétition
  immédiate ;
- quitter l'écran d'acquisition en plein dialogue n'interrompt pas le job et
  ne laisse aucun minuteur derrière ;
- le RTC des écrans avant-vol ne retarde ni ne bloque aucun bouton ;
- rien ne s'affiche pendant la fenêtre de burst du rituel (D9) ;
- BUILD NOTES s'ouvre et se ferme depuis le terminal, sur un opérateur neuf
  comme sur un opérateur chargé.

## Hors périmètre

- Les points d'appel de vol, crash, session complete et revisite : les
  événements sont déclarés, le câblage viendra quand on le voudra — une ligne
  chacun, c'est le critère d'acceptation 10.
- Les accroches lore du dépôt open source (commits, docs, commentaires de
  code) : c'est la PHASE 22 ([#59](https://github.com/lionrayonnant/FPVThePlanet/issues/59)).
- Toute forme de génération LLM au runtime, de storytelling procédural, de
  progression narrative ou de personnage autonome. Le lore reste décoratif.
- Les embeddings pour la déduplication sémantique : les trigrammes suffisent au
  volume visé ; si un corpus futur les demande, ce sera une décision séparée.
