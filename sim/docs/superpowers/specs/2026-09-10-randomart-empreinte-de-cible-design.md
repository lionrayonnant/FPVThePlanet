# Le randomart devient l'empreinte de la cible

Issue #57. Écrit le 2026-09-10.

## Ce que c'est

Le randomart existe déjà dans le dépôt (`tools/randomart.mjs`, fou ivre façon
`ssh-keygen -lv`), mais il n'a qu'un usage et il n'est jamais montré en jeu :
le serveur en grave un par session, graîné sur `session.id`, et il ne
réapparaît que dans le texte d'une fiche d'archive. La Bible §26 en demandait
davantage — « il apparaît lors de la connexion, dans les archives, lors de
certains événements comme une reconnexion, après une acquisition » — et le
dit sans ambiguïté :

> Le Randomart n'est pas seulement décoratif : **c'est l'empreinte visuelle de
> l'expérience.**

Cette spec lui donne son objet et ses moments.

**Son objet** : une cible = une empreinte. Le randomart n'est plus la
signature d'un vol, c'est celle de la MACHINE. Graine = le `buildSeed` de
l'exemplaire, la même chaîne qui décide déjà de sa famille, de sa livrée, de
son cadre et de ses PID. Deux vols sur le même exemplaire donnent le même art :
c'est le signe qu'on le reconnaît.

**Ses moments** : trois.

- **à l'acquisition**, le fou marche sous les yeux du joueur, juste après
  `[ JACK IN ]` — l'empreinte se trace, `CONTROL ACQUIRED` tombe dessous, le
  flux vidéo prend la main ;
- **au crash**, l'art figé, à côté du portrait fil de fer : ce qu'il reste ;
- **dans les archives**, à la place du randomart de session.

## Ce que ça n'est pas

- Pas d'empreinte sur le `TARGET SCAN`. La Bible §15 tient : avant le vol on
  n'affiche QUE ce qui est réellement connu, et l'empreinte d'un exemplaire
  n'en fait pas partie. On ne choisit pas un signal sur son art.
- Pas de randomart d'opérateur (Bible §32, « futur »).
- Pas de mutation : l'art d'une cible ne change pas au fil du vol.

## A. Le module

`tools/randomart.mjs` perd `node:crypto` et s'ouvre. Trois exports au lieu
d'un :

```js
randomartWalk(seed)       // -> { steps: Int16Array, start, end, width, height }
randomartFrame(walk, n, { title, tag })   // -> string, l'art après n pas
randomart(seed, { title, tag })           // = frame(walk, walk.steps.length)
```

- `steps` est la suite des index de cases visitées par le fou, dans l'ordre,
  128 pas pour 32 octets de digest. `start` et `end` sont les index des cases
  `S` et `E` de l'art complet.
- `randomartFrame(walk, n)` compte les passages sur les `n` premiers pas, pose
  `S` sur `walk.start` et `E` sur la case du pas `n` — pas sur `walk.end`.
  Pendant la marche, `E` EST le fou : le curseur se déplace tout seul, sans
  une ligne de code de plus. À `n = steps.length`, `E` retombe sur `walk.end`
  et l'image est exactement celle d'aujourd'hui.
- `randomart()` garde sa signature et son comportement : le serveur et
  `session-log-model.mjs` n'ont rien à changer pour rendre un art fini.

### Le digest

`node:crypto` interdit au navigateur d'importer le module ; c'est la seule
raison pour laquelle l'art n'était pas déjà à l'écran. On le remplace par la
génération que tout le dépôt utilise déjà — FNV-1a puis xorshift, la fonction
`rngFrom` de `tools/target-build.mjs`, la même que `target-camera.mjs`,
`target-model.mjs` et `src/link.js`. 32 octets se tirent du flux, un par
appel, octet de poids faible.

`rngFrom` est réimporté depuis `target-build.mjs` plutôt que recopié : c'est
déjà la fonction canonique du dépôt, et `randomart.mjs` n'a pas d'autre
dépendance.

**Conséquence assumée** : le digest change, donc un `randomart(seed)` ne rend
plus la même image qu'avant pour la même graine. Ça ne se voit nulle part —
les arts déjà écrits sur disque étaient graînés sur `session.id`, et on cesse
justement de les regarder (§C). Aucune archive n'est réécrite.

### Selftest

`tools/randomart-selftest.mjs`, nouveau, appelé par la chaîne `selftest:ci` :

- déterminisme : deux appels sur la même graine donnent la même chaîne ;
- deux graines voisines (`x::0`, `x::1`) donnent des arts différents ;
- dimensions : 11 lignes, 19 colonnes, cadre `+--[ TGT 042 ]---+` centré ;
- continuité : `randomartFrame(walk, walk.steps.length)` est exactement
  `randomart(seed)` ;
- `randomartFrame(walk, 0)` ne contient qu'un `S`, et `E` est sur la même
  case ;
- pureté : le fichier ne contient aucune importation `node:`.

Les assertions de `tools/session-selftest.mjs` sur le randomart suivent le
déplacement plutôt que d'être dupliquées.

## B. Les trois moments

### 1. L'acquisition — le fou marche

`src/hack.js`. Aujourd'hui `[ JACK IN ]` appelle `finish()`, qui démonte
l'écran et résout la promesse ; `main.js` enchaîne sur le vol. On insère une
phase entre les deux.

Nouvelle phase `acquired`, entre le geste et `resolve()` :

1. le bouton `[ JACK IN ]` disparaît, la boîte du motif de famille se vide ;
2. le fou marche, `RANDOMART_WALK_MS = 1000` ms, à la cadence de la boucle
   `requestAnimationFrame` déjà en place — `randomartFrame(walk, n)` avec
   `n = round(steps.length * t / RANDOMART_WALK_MS)`, écrit dans le même
   `<pre>` que le motif ;
3. l'art se fige ; `CONTROL ACQUIRED` s'écrit dessous en DISPLAY (Bible §39 :
   la graisse est réservée à `FPVTP!`, `TARGET ACQUIRED`, `JACK IN` — c'est
   le même registre) ;
4. `RANDOMART_HOLD_MS = 700` ms de tenue, puis `teardown()` + `resolve()`.

Le geste garde son sens : `[ JACK IN ]` est ce que fait l'opérateur,
`CONTROL ACQUIRED` est ce qui en résulte. L'ordre est celui-là et pas
l'inverse.

Deux garde-fous, dictés par l'historique du dépôt (#33 : l'écran de hack dont
on ne sortait pas ; #20 : le verrou de sortie qui ne se relevait pas) :

- `nav` reste monté pendant `acquired`, et Échap **saute** la phase :
  `teardown()` + `resolve()` immédiats. Le battement ne peut retenir
  personne. Ce n'est pas un `abort()` — le contrôle est pris, on ne revient
  pas au scan.
- Un seul minuteur porte la sortie de la phase, et il résout dans tous les
  cas. `reducedMotion()` (`src/motion.js`) pose l'art fini et n'attend que
  `RANDOMART_HOLD_MS`.

`main.js` n'est pas touché : il `await runHack()` déjà, il verra seulement une
résolution 1,7 s plus tard.

`globalThis.__hackTestArm` gagne un jumeau `__hackTestFinish` sur le même
modèle — un test de rendu n'a pas à attendre des secondes pour voir la phase.

`tools/hack-render-selftest.mjs` couvre : la phase existe, l'art atteint son
image finale, `CONTROL ACQUIRED` est présent, Échap résout, la promesse est
toujours résolue.

### 2. Le crash — ce qu'il reste

`src/flight-end.js` exporte déjà `PORTRAIT_LINE`, un jeton de ligne que
`src/fpvtp-osd.js` remplace par le dessin de la machine. On ajoute
`RANDOMART_LINE` sur exactement le même principe : le module reste pur, il ne
connaît que du texte.

Le jeton est posé au MÊME horodatage que `PORTRAIT_LINE` sur les trois tables
— `TIMELINE` (4,0 s), `FENCE_TIMELINE` (2,4 s), `CUT_TIMELINE` (2,4 s). Les
trois fins montrent la même chose : une machine perdue est perdue pareil.

`src/fpvtp-osd.js` rend les deux jetons **côte à côte** : portrait à gauche,
empreinte à droite, dans un conteneur en ligne. C'est ce qui empêche onze
lignes d'ASCII de pousser `[ESC] DISCONNECT` hors de l'écran — la hauteur du
bloc reste celle du portrait, et **`exitAt` ne bouge sur aucune des trois
tables**. Sous le seuil où les deux ne tiennent pas côte à côte, l'empreinte
passe sous le portrait ; c'est du CSS, pas une seconde table.

Art figé, aucune marche : ici l'empreinte n'est pas une révélation, c'est une
pierre. L'apparition est celle des autres lignes, `src/motion.js` s'en charge
déjà.

La graine est celle du vol en cours, que `main.js` construit déjà
(`main.js:2981`, `const buildSeed = \`${seed}::${choice.index}\``) pour bâtir
l'exemplaire ; elle transite par `fpvtpOsd` comme le portrait.

`tools/flight-end-selftest.mjs` : le jeton est présent sur les trois tables,
au bon horodatage, et `exitAt` est inchangé.

### 3. Les archives

`tools/session-log-model.mjs`, `sessionDetail()`. Le bloc `RANDOMART` lit
désormais l'empreinte de la cible :

```js
targetArt(s)   // randomart(`${scan.seed}::${scan.index}`, { title: `TGT ${seq}`, tag })
```

`sanitizeTarget()` ne stocke pas `buildSeed` — il stocke `scan { seed, count,
index }`, précisément pour que le client puisse reconstruire la graine « sans
la stocker deux fois » (commentaire de `resolveTarget`). L'archive la
reconstruit de la même façon. **Aucun changement de schéma, aucune migration
de données.**

`session-model.mjs:openSession()` cesse de graver `randomart: randomart(id,
…)`. Le champ disparaît des sessions neuves — `validateSession` ne l'exigeait
pas, il n'y a rien à y toucher.

Repli : une session écrite avant cette spec n'a pas forcément de `target`
(une session ouverte sans TARGET SCAN n'en a pas). `sessionDetail()` rend
alors `s.randomart` tel quel s'il existe, et rien sinon. Une archive ancienne
continue d'afficher l'art qu'elle a toujours affiché.

`tools/session-log-selftest.mjs` : une session avec cible rend l'art de la
cible, deux sessions sur le même exemplaire rendent le MÊME art, une session
ancienne sans cible rend son `s.randomart`, une session sans ni l'un ni
l'autre ne rend pas de bloc `RANDOMART`.

## Titre et tag

`+--[ TGT 042 ]---+` en haut, les quatre derniers caractères du `buildSeed`
en bas. `042` est le `targetSeq` de la session, le numéro d'affichage que le
serveur attribue et fige. Hors archive — à l'acquisition et au crash — le
numéro n'est pas encore connu du client au moment où l'art se dessine : le
titre est alors `TGT ??`, et c'est juste. Le numéro est ce que l'archive sait,
pas ce que l'opérateur sait en vol.

## Ce que ça change dans les docs

- Bible §26 : la section décrit un randomart « associé à la session / cible ».
  Elle est resserrée sur la cible, et la liste des apparitions devient celle
  qui est réellement implémentée. La Bible est validée et ne se re-litige pas,
  mais elle laissait ici les deux lectures ouvertes ; #57 tranche.
- `sim/HANDOFF.md` : les trois moments passent en « vérifié » à la relecture.

## Ordre d'implémentation

1. `tools/randomart.mjs` + `tools/randomart-selftest.mjs` — le module pur,
   testé seul, avant tout affichage.
2. Les archives (`session-log-model.mjs`, `session-model.mjs`) — le moment
   sans mise en scène, celui qui valide la graine.
3. Le crash (`flight-end.js`, `fpvtp-osd.js`) — l'art figé.
4. L'acquisition (`hack.js`) — la marche, la seule vraie animation.

Chaque étape ne lance que le selftest du module qu'elle touche. La chaîne
`npm run selftest:ci` tourne UNE fois, à la toute fin, avant le push.
