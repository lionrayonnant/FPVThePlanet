# JUKEBOX — la radio — design

Issue : lionrayonnant/FPVThePlanet#120

## Objectif

88 morceaux dans `public/music.json`, 8 pools, et aucun moyen de les écouter :
la sélection est déterministe sur `(pool, buildSeed)`, donc un joueur n'entend
que ce que le tirage lui donne. Le reste de la bibliothèque est invisible.

Le JUKEBOX est une **radio** : une cinquième voie à la racine, qui liste toute
la bibliothèque, joue, **enchaîne toute seule**, et **continue de jouer quand on
la quitte** — jusque dans un vol BENCH, où le joueur choisit sa bande-son avant
de décoller.

## La règle qui tient tout

**La radio n'est pas la musique du vol.** L'arc musical de la Bible §34 — la
musique sourde au HACK, le `duck()` de la culmination, l'explosion au drop,
l'intensité qui suit le pilote, la mort à l'instant du choc — appartient à
FIELD. La radio joue **à plat** (intensité 1.0, plein spectre, 0 dB).

Conséquence : tant que la radio tient l'antenne, `main.js` ne touche plus à
`music`. C'est une question de **propriété**, et elle se décline en six gardes.

La radio survit aussi en FIELD, pas seulement en BENCH : un joueur peut
l'allumer puis aller faire un vol FIELD complet. C'est ce qui rend les gardes du
hack et du rituel nécessaires.

## Périmètre

| Fichier | Rôle |
|---|---|
| `tools/jukebox-model.mjs` **(neuf)** | Pur. Construction et ordre de la bibliothèque, filtres, formatage d'une ligne, arithmétique d'index. Aucun DOM, aucun Web Audio. |
| `src/radio.js` **(neuf)** | Le séquenceur, singleton `radio`. Détient l'antenne, enchaîne, précharge le suivant, notifie ses abonnés. Survit à l'écran — c'est pourquoi il n'y vit pas. |
| `src/jukebox.js` **(neuf)** | L'écran. Une **vue** sur `radio` : il s'abonne, il redessine, il ne possède jamais la lecture. Grammaire de `src/session-log.js`. |
| `src/music.js` | Lecture non bouclée + rappel de fin, `decode()` sans état, non-marquage des récents. Défauts inchangés. |
| `tools/bench-model.mjs` | `MODES` et `MODE_SELECT` gagnent `jukebox`. |
| `src/main.js`, `src/culmination.js` | La branche de mode et les six gardes. |

Hors périmètre : le filtrage par autre chose que le pool, une file d'attente
construite à la main, un compteur de temps écoulé, la persistance du morceau
courant entre deux lancements.

## `tools/jukebox-model.mjs`

```js
buildLibrary(manifest)          // -> track[] groupé par MUSIC_POOLS puis id croissant
libraryFilters(manifest)        // -> ['ALL', ...pools NON VIDES]
formatDuration(durS)            // 84.1 -> '1:24'
shortId(id)                     // 'menu-1aec9db0' -> '1aec9db0'
jukeboxRow(track, { playing })  // '▶ MENU       · 1aec9db0 ·  1:24 ·  86 BPM'
nowPlayingLine(track)           // la ligne ON AIR, ou l'état muet
stepIndex(len, i, delta)        // circulaire, sûr sur len === 0
```

L'ordre est groupé par pool **et c'est aussi l'ordre d'enchaînement** : la radio
parcourt son pool, puis roule dans le suivant.

`libraryFilters` ne retient que les pools **présents** : `swarmNode` est déclaré
mais vide aujourd'hui, et un filtre sur lequel on tombe toujours vide est du
bruit. Il apparaîtra le jour où il aura des morceaux, sans rien changer ici.

Le préfixe `▶ ` fait **2 caractères dans les deux états** (`'▶ '` / `'  '`) et
vit **dans le libellé** : la colonne `::before` est déjà prise par le marqueur
de focus `▌` (`style.css:894`). Curseur et antenne sont deux faits distincts et
doivent se lire ensemble sans que les colonnes bougent.

## `src/radio.js`

```js
radio.owns              // vrai du premier play() jusqu'à stop()
radio.playing           // owns && music.playing
radio.library           // track[]
radio.index             // -1 tant que rien n'a joué
radio.current           // track | null
await radio.ready()     // loadManifest + buildLibrary, mémoïsé, ne jette jamais
await radio.playAt(i)   // prend l'antenne, joue, précharge i+1
await radio.next() / prev()
radio.stop()            // rend l'antenne
radio.onChange(fn)      // -> unsubscribe
radio.onRelease(fn)     // -> unsubscribe ; appelé par stop()
radio._setMusic(m) / _reset()   // tests seulement, idiome de audio-bus._setContextFactory
```

- `playAt` appelle `music.setVolume(loadMusicVolume())` d'abord : la valeur
  stockée n'est appliquée qu'au boot de scène (`main.js:1148`), et la radio doit
  être audible quel que soit celui qui l'allume.
- Lecture : `music.play({ ready, intensity: PHASE_INTENSITY.DROP, loop: false,
  remember: false, onEnded })`.
- `onEnded` vérifie `owns` **et** un jeton monotone incrémenté par chaque
  `playAt`/`stop` avant d'enchaîner : seconde ligne de défense derrière
  `voice.retired`.
- **Précharge par `decode()`, jamais `prepare()`.** `music.pending` est un
  créneau unique partagé avec le chemin du jeu ; si la radio y touchait, un hack
  FIELD lancé pendant qu'elle joue échangerait le buffer sous elle.
- Échec de décodage (`.opus` manquant) : sauter au suivant, au plus
  `library.length` fois, puis `stop()`. Le silence ne doit jamais devenir un gel.
- `playAt` doit tolérer un `ensureContext()` à `null` (pas encore de geste
  utilisateur) et rendre `false` **sans** se déclarer propriétaire.

## `src/music.js` — le changement délicat

`play()` force `source.loop = true`, et `_retire()` est **propriétaire de
`source.onended`** — c'est là que se fait le démontage. Une source non bouclée
déclenche `onended` toute seule à la fin du buffer : c'est exactement le signal
« enchaîne ». Les deux usages se marchent dessus.

**Solution : `onended` est assigné exactement une fois, dans `play()`, et il
branche sur un drapeau `retired` porté par la voix.** `_retire()` cesse
d'écrire `onended` ; il ne fait plus que lever le drapeau, ramper et arrêter.

```js
async decode(entry)   // NEUF : le corps de prepare(), mais SANS état
async prepare(entry)  // inchangé : decode() + remplit this.pending

play({ intensity, fadeMs, ready = this.pending,
       loop = true, onEnded = null, remember = true } = {})
```

```js
const voice = { source, lowpass, gain, duck, entry, retired: false };
source.loop = loop;
source.onended = () => {
  // démontage (les 4 nœuds, buffer = null)
  if (voice.retired) return;              // remplacée en fondu : PAS une fin de morceau
  if (this.current === voice) { this.current = null; this.intensity = 0; }
  onEnded?.(voice.entry);
};
...
if (ready === this.pending) this.pending = null;   // ne consommer QUE le créneau partagé
if (remember) { … pushRecent … }
```

`_retire()` gagne `voice.retired = true` et perd son bloc `onended`.

L'arc FIELD ne bouge pas d'un pouce : avec `loop: true` par défaut, une voix de
menu ou de vol ne se termine jamais toute seule, donc `onended` ne part toujours
que du `stop()` de `_retire()`, où `retired === true` → démontage seul.

`this.current = null` dans la branche « fin naturelle » rend `music.playing`
honnête entre deux morceaux ; le garde `this.current === voice` empêche un NEXT
rapide d'annuler la voix neuve.

`remember: false` saute l'anneau des récents, qui existe pour que les tirages
**du jeu** ne se répètent pas. Sans lui, écouter vingt morceaux le remplit (12
de profondeur) et fausse durablement les tirages en vol.

## L'écran

```
JUKEBOX
88 TRACKS · 7 POOLS
▶ FREESTYLE5 · 7f99af7b ·  1:25 · 168 BPM        (ou '-- STOPPED --')

  MENU       · 1aec9db0 ·  1:24 ·  86 BPM        <- div.terminal-list
▶ MENU       · 4718abd5 ·  1:25 ·  92 BPM           de button.terminal-row
  …

ALL · MENU · FREESTYLE5 · RACE5 · …              <- filtre, boutons, Entrée
PREV · STOP · NEXT                               <- transport
[ BACK ]
[ESC] OPERATION MODE · [←/→] PREV / NEXT
```

**Deux fonctions de rendu, seule divergence délibérée d'avec `session-log.js`** :

- `draw(focusIdx)` bâtit l'arbre et garde `rowEls`, curseur reposé par
  `(rowEls[Math.min(focusIdx, len-1)] ?? s.box.querySelector('button'))?.focus()` ;
- `paint()` ne réécrit **que** la ligne ON AIR, le libellé PLAY/STOP et le
  préfixe des deux lignes concernées. C'est `radio.onChange` qui l'appelle :
  l'enchaînement automatique se produit pendant que l'opérateur parcourt la
  liste, et un `replaceChildren()` à ce moment-là lui arracherait le curseur des
  mains en plein défilement.

`onDir` fait la **transport** (droite → `next()`, gauche → `prev()`, `return
true`) : c'est l'idiome radio, et c'est ce que « comme une radio » veut dire. Le
filtre de pool reste donc une rangée de boutons qu'on active à Entrée.

Pas de compteur de temps écoulé, donc **aucun minuteur** : la ligne ON AIR est
statique par morceau, et un intervalle à 1 Hz serait une surface de fuite pour
zéro information que la ligne ne porte déjà.

Sortie unique et gardée : `nav?.detach(); off(); s.remove(); resolve()` — `off`
étant le désabonnement de `onChange`, faute de quoi la fermeture retient un
arbre DOM détaché pour le reste de la session. **La radio n'est pas coupée.**

## Les six gardes

| Site | Devient |
|---|---|
| `main.js:2552` arc par frame | `… && !radio.owns` — sinon les gaz filtrent la radio |
| `main.js:3389` `music.drop()` | `if (!radio.owns)` |
| `main.js:2201` `music.kill()` au crash | `if (!radio.owns)` |
| `main.js:3044` hack FIELD | la chaîne `loadManifest→prepare→play` enveloppée |
| `main.js:3151` hack FIELD | idem |
| `culmination.js:60` `music.duck()` | `if (!radio.owns)` |

Plus `startMenuMusic()` (`main.js:3264`), première ligne `if (radio.owns) return;`
— il est déjà gardé par `!music.playing`, mais ça court avec le fondu.

**Le piège, et c'est le vrai risque de cette PR** : le rituel ducke à 0,55 et
**le seul appel qui unducke est `music.drop()`** — celui qu'on vient de garder.
Garder le drop sans garder le duck laisse la radio coincée à 0,55 de gain **pour
le reste de la session** après un seul hack FIELD, sans une erreur nulle part.
Les deux gestes appartiennent au même propriétaire : ils se gardent ensemble ou
pas du tout.

`menuMusicStarted` est mémoïsé : après un `radio.stop()` les menus resteraient
muets jusqu'au rechargement. D'où `onRelease`, auquel `main.js` s'abonne une
fois pour remettre le drapeau à zéro et relancer.

## Selftests

| Fichier | Contenu |
|---|---|
| `tools/jukebox-selftest.mjs` **(neuf)** | Modèle pur : ordre stable, filtres qui sautent les pools vides, `jukeboxRow` (colonnes, préfixe de 2 caractères dans les deux états, largeur ≤ 56), `formatDuration`, `stepIndex` circulaire et sur liste vide. |
| `tools/music-render-selftest.mjs` **(neuf)** | `src/music.js` sur `fakeAudioContext()` : le défaut boucle toujours et pousse les récents ; `loop:false` + `remember:false` n'y touche pas et appelle `onEnded` **une fois** ; une voix retirée démonte **sans** `onEnded` ; `decode()` laisse `pending` à null. |
| `tools/jukebox-render-selftest.mjs` **(neuf)** | Écran + radio sur le faux DOM, `music` injecté : un clic joue avec les bonnes options ; NEXT/PREV circulent et `paint()` ne reconstruit pas ; **Échap résout et `radio.owns` reste vrai** ; après Échap l'enchaînement marche encore ; `prepare` n'est jamais appelé ; zéro minuteur net. |
| `tools/bench-selftest.mjs`, `tools/bench-render-selftest.mjs` | Mis à jour : le 5ᵉ mode casse les assertions d'ordre. |
