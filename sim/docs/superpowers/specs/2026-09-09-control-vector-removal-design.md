# Retrait du CONTROL VECTOR — conception

Issue #33 (point 2). Remplace la PHASE 10 de la roadmap et les sections §14 et
§18 de la Bible.

## Pourquoi

Le CONTROL VECTOR est une suite de 4 à 8 directions que le joueur définit une
seule fois, au premier lancement, et qu'il doit retaper à chaque acquisition de
cible pour terminer le hack.

Le rapport de test qui a ouvert #33 dit : « la page de hack peut se figer et
rendre confus l'utilisateur ». La lecture du code donne pire que « se figer » :

- `runRitual` n'écoute **que les quatre flèches** (`src/ritual.js:85-89`).
- `blockNav(wrap)` (`:37`) rend inertes tous les navs restés montés dessous.
- Sa promesse (`:29`) n'a **pas de `reject`** et n'est résolue que par un
  vecteur tapé entièrement et juste.
- Aucune limite de temps, aucun compteur d'essais, aucun bouton, aucun Échap.

Un joueur qui a oublié son vecteur est bloqué **jusqu'au rechargement de la
page**. L'écran est vivant, le motif s'anime : rien ne dit que c'est sans issue.
Et comme `runHack` est attendu par `fieldLoop` (`main.js:3037`), c'est toute la
boucle de jeu qui reste suspendue, `introFrozen` à `true`.

Le mécanisme demande au joueur de mémoriser un secret hors du jeu — l'écran
d'enregistrement dit littéralement `KEEP THIS VECTOR. YOU WILL NEED IT.` — et
le punit d'un blocage total s'il l'oublie. Le coût est payé à **chaque**
acquisition, pour un geste qui n'exprime aucune compétence de pilotage.

Décision : le CONTROL VECTOR sort du jeu, entièrement.

## Ce qui le remplace

Le hack se termine par un bouton unique, `[ JACK IN ]`.

Ce n'est pas une invention : c'est l'état qui précédait la PHASE 10, encore
décrit dans `docs/manual.md:842-844` — « L'écran se fige sur
`MANUAL OVERRIDE REQUIRED` + un bouton `[ JACK IN ]` **provisoire** ». Le
provisoire devient le définitif.

Deux choses existent déjà pour l'accueillir, sans site d'appel depuis le début :
les événements de dialogue `MANUAL_OVERRIDE` et `JACK_IN`
(`src/dialogue-fallback.js:167-193`, huit répliques), listés dans
`src/bench.js:83`.

Ce que le joueur gagne : un geste d'engagement conservé — l'acquisition n'est
pas une animation qu'on regarde — sans rien à mémoriser, et un écran dont on
peut sortir.

## Architecture

### `src/hack.js` — le seul point délicat

`finish()` (`hack.js:196`) est aujourd'hui atteignable **uniquement** par
`runRitual(...).then(finish, …)` (`:169`). Retirer l'appel sans le remplacer
gèle le jeu sur `MANUAL OVERRIDE REQUIRED`, sans aucune touche pour sortir :
`hack.js` ne pose aucun écouteur, `runRitual` était le seul.

`arm()` devient donc :

- `phase = 'armed'` — conservé, il pilote `.hack-log-armed` (`:120`).
- `stopHack()` — conservé, D9 : le crew se tait avant l'armement. Il reste
  idempotent avec celui de `teardown()`.
- monte un bouton `JACK IN` (`button()` de `terminal.js`, comme partout
  ailleurs) et un `keyHints([['ESC', 'ABORT']])`, puis un `menuNav` dont le
  `back` abandonne l'acquisition.
- l'activation du bouton appelle `finish()`.

`runHack` gagne donc une **seconde issue** : abandonner. Elle se résout en
`{ aborted: true }` plutôt que de rejeter — un abandon n'est pas une erreur, et
`main.js` sait déjà traiter ce cas pour le TARGET SCAN (`main.js:3002`,
`if (choice.cancelled) { introFrozen = false; continue; }`). Les quatre sites
d'appel de `runHack` (`main.js:2757, 2955, 2968, 3037`) traitent l'abandon
comme l'annulation du scan : retour au choix de zone, préchargement laissé en
cours.

Cela répare au passage la violation D15 relevée dans le même diagnostic : le
hack n'avait **aucune sortie** pendant toute la durée du chargement.

### Ce qui disparaît

| Fichier | Sort |
|---|---|
| `src/ritual.js` | supprimé |
| `tools/ritual-model.mjs` | supprimé |
| `tools/ritual-selftest.mjs` | **renommé** `intro-primitives-selftest.mjs` |
| `tools/ritual-bench.mjs` | **renommé** `intro-primitives-bench.mjs` |
| `src/hack-grammars.js` | **conservé**, amputé de `FAMILY_PRIMITIVES` |

Les deux selftests ne sont pas supprimés : ils portent le contrat
`(t, seed, dur)` des onze primitives et leur budget de 2 ms/frame — primitives
que `src/intro.js:129` continue d'exécuter à **chaque lancement du jeu**. Les
supprimer ne casserait rien immédiatement, et c'est précisément ce qui rend la
perte dangereuse. `tools/ritual-selftest.mjs:119-133` porte en plus le garde-fou
d'acceptation #57 (« pas de demo scene hors événement ») : il devient
`EVENT_MODULES = new Set(['hack-grammars.js', 'intro.js'])`.

`src/hack-grammars.js` n'est pas supprimable : il porte les six grammaires de
l'écran de hack (consommateur `src/hack.js:26`) **et** les primitives de
l'intro (`src/intro.js:16`). `RITUAL_PRIMITIVES` garde son nom — l'intro les
nomme déjà ainsi (`style.css:1413`) et le renommer ferait un diff bien plus
large que le gain.

### Le vecteur comme donnée

- **Création** : `captureControlVector` et `registeredScreen`
  (`src/bootstrap.js:220-328`) disparaissent, et l'appel dans `bootstrap()`
  (`:336-347`) avec eux. Le bootstrap passe de quatre écrans à deux avant le
  briefing.
- **`flushOrRetry`** (`:351-365`) perdait son seul `patch()`. Il est conservé
  mais son message `VECTOR NOT SAVED — RETRY` devient `PROFILE NOT SAVED —
  RETRY` : le flush du nom reste à protéger.
- **Consultation** : `controlVectorScreen` (`src/terminal.js:341-376`) et son
  entrée de menu (`:787`) disparaissent. Deux render-selftests verrouillent
  cette liste en ordre (`terminal-render-selftest.mjs:110`,
  `data-render-selftest.mjs:106`) : elles sont mises à jour, et l'index de focus
  qu'elles vérifient se décale d'un.
- **Briefing** : la ligne `['CONTROL VECTOR', 'THE ARROWS YOU REGISTERED']`
  (`tools/briefing-model.mjs:114`) disparaît de `sessionScreen()`. Le
  `deepEqual` de `briefing-selftest.mjs:146` passe à
  `['TARGET SCAN', 'FLIGHT', …]`.

### Le schéma opérateur

`SCHEMA_VERSION` passe de 2 à **3**, et `migrate()` gagne un
`delete merged.controlVector` sur le modèle de celui qui existe déjà pour
`targetLog` (`tools/operator-store.mjs:93`).

C'est nécessaire : `migrate()` fait `{...freshState(), ...state}`, donc retirer
la clé de `freshState()` seul la laisserait **survivre inerte** dans tout état
déjà écrit. Le bump assume sa conséquence — le garde-fou
`if (v > SCHEMA_VERSION) throw` (`:81`) rend un état v3 illisible par un binaire
v2. C'est la règle du dépôt, et elle est déjà payée une fois pour `targetLog`.

Côté serveur, `controlVector` sort de `OP_WRITABLE_KEYS` (`server/api.mjs:179`)
et `validateControlVector` disparaît avec son import (`:23, 264-265`). Les deux
doivent tomber **ensemble** : sinon un vieux client qui patche `controlVector`
reçoit une 400 opaque.

### L'audio

`RITUAL` sort du vocabulaire : `UI_EVENTS` et `UI_FAMILY`
(`tools/ui-audio-model.mjs:20,31`), les six `RITUAL_SCORES` (`:126-249`),
`scoreFor`, `RITUAL_TENSION`, `ritualTensionParams`, et côté client la branche
`play('RITUAL')`, `playRitual`, `_ensureTension`, `ritualTension`,
`killRitualTension` (`src/ui-audio.js:272-454`).

`UI_EVENTS` est verrouillé en **égalité stricte** sur ses huit entrées
(`ui-audio-selftest.mjs:20-25`) et balayé sur tout `src/` : le vocabulaire, la
famille, la liste `['SYSTEM','LINK','RITUAL']` (`:31`), `src/audio-bus.js:11` et
Bible §34 doivent bouger dans le **même** commit, sinon la chaîne est rouge.

`music.duck()` perd son seul appelant (`ritual.js:109`). `DUCK.ritual`
(`tools/music-model.mjs:89`) et `unduck` sont conservés : le hack ne baisse plus
la musique, mais `music.drop()` (`main.js:3261`) reste correct et l'`unduck`
devient un no-op inoffensif. Le retrait de la constante est laissé à un
nettoyage ultérieur — la toucher élargirait le diff sans rien réparer.

### Le CSS et la Bible §19

Le bloc `.ritual*` (`style.css:1261-1342`) disparaît, `.hack-log-armed` et
`.intro-burst--*` restent.

`palette-selftest.mjs:33` perd `.ritual` de `EVENT_SELECTORS`, et il ne reste
que `.intro` pour justifier `--cyan / --magenta / --violet / --electric` dans
`tokens.css`.

**C'est une décision de direction artistique à assumer explicitement dans la
Bible §19** : les quatre couleurs de demo scene, réservées « aux événements
décisifs », n'ont plus qu'un porteur — l'intro, qui ne se joue qu'une fois par
lancement. §19 se recentre sur l'intro plutôt que de laisser une règle qui
décrit un moment qui n'existe plus.

## Documentation

- **Bible** : §14 (l. 597-643) et §18 (l. 735-777) supprimées, §36 (l.
  1497-1529) supprimée, §19 recentrée sur l'intro, et onze passages ponctuels
  (§17 l. 718, §26 l. 1124, §30 l. 1268, §31 l. 1318, §32 l. 1346, §33 l. 1370
  et 1385, §34 l. 1415 et 1465, §46 l. 1793 et 1813) réécrits. La table des
  matières suit.
- **Roadmap** : PHASE 10 (l. 672-731) devient le retrait, et les treize renvois
  (l. 41, 172-186, 193, 216, 663-668, 847, 1118-1124, 1221, 1352, 1396, 1495,
  1516, 1531) sont mis à jour.
- **HANDOFF** : le bloc PHASE 10 (l. 201-236) disparaît, le bloc PHASE 20 (l.
  638-705) et la section des primitives partagées (l. 1660-1673) sont réécrits
  pour ne plus parler que de l'intro.
- **`docs/manual.md`** : l. 838-847 réécrit — le passage était **déjà périmé**,
  il décrit l'état d'avant la PHASE 10. Plus l. 347 et 596.
- **Non touchés** : `CHANGELOG.md` (historique), les specs
  `superpowers/specs/2026-08-29-phase-10-*` (document historique), les notes de
  build (`buildnotes-model.mjs:34`), et `public/music.json` (« ritual horns »
  est un texte de prompt de génération, sans rapport).

## Ce qui n'est pas fait ici

- Le renommage de `RITUAL_PRIMITIVES` en `INTRO_PRIMITIVES` : diff large, gain
  cosmétique.
- Le retrait de `DUCK.ritual`.
- La question de savoir si l'acquisition mérite un jour un autre geste de
  compétence. `[ JACK IN ]` est un engagement, pas une épreuve ; si un jour on
  veut une épreuve, elle devra tenir la règle qu'on vient d'écrire — **aucun
  écran sans sortie**.

## Vérification

- `tools/hack-selftest.mjs` gagne la couverture qui manquait : il ne montait
  jamais `runHack()`. Un `hack-render-selftest.mjs` vérifie que le bouton
  `JACK IN` apparaît, qu'il résout, qu'Échap abandonne et rend
  `{ aborted: true }`, et qu'une double activation ne résout qu'une fois.
- `npm run selftest:ci` en fin de chantier, une seule fois.
- À la main : `?scene=<slug>&hack=<type>` doit dérouler le hack et s'arrêter sur
  un bouton, pas sur un écran mort.
