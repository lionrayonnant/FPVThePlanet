# PHASE 18 — Audio final

État : validé 2026-08-29.

Issue : https://github.com/lionrayonnant/FPVThePlanet/issues/55
Sources : Bible §34 (langage sonore), §35 (signature de boot), §36 (son des
rituels), §37 (pas de voix) · Roadmap PHASE 18.

## Objectif

Mettre en place le langage sonore. Le principe qui arbitre tout le reste :

> **An event that doesn't need to be heard doesn't need a sound.**

Le vol appartient aux moteurs, à l'air, à la pluie, au propwash, aux impacts
et à la radio. Pas de musique pendant le vol. `src/audio.js` **est** déjà cela
et n'est pas remplacé : cette phase ajoute à côté de lui un deuxième bus, très
peu bavard, pour les trois familles d'interface.

```text
SYSTEM  boot, terrain ready, target found, error
LINK    carrier, perte, reconnexion
RITUAL  hack
```

## État du dépôt à cette date

Base : `origin/main` (`eaba214`, PHASE 17 mergée).

Ce qui existe déjà et n'est **pas** re-décidé ici :

- `src/audio.js` — la synthèse moteur pilotée par le régime des quatre moteurs
  (issue #9). Blade-pass par moteur, bruit de bande, vent, propwash, impacts,
  limiteur, sliders volume/brillance. Conservée telle quelle. Les seules
  retouches admises sont celles du §1 ci-dessous, qui lui retirent la propriété
  de l'`AudioContext` et du limiteur sans toucher à une seule constante de
  `AUDIO`.
- `src/link.js` — `out.quality` (0..1), `out.frozen`, et l'hystérésis
  `FREEZE_ENTER` / `FREEZE_LEAVE` déjà calibrée pour ne pas stroboscoper à la
  frontière. PHASE 18 lit `quality` et n'ajoute aucun terme au bilan de liaison.
- `src/ritual.js` — la culmination demo scene, la variante `V1..V4`
  (`tools/ritual-model.mjs`) et les 400 ms muettes de `CONTROL ACQUIRED`.
  PHASE 18 sonorise cette séquence sans en changer le déroulé ni les durées.
- `src/hack-grammars.js:GRAMMARS` / `FAMILY_PRIMITIVES` — le vocabulaire visuel
  des six familles. Les identités sonores s'alignent dessus, elles ne
  réinventent pas une taxonomie.
- `src/flight-end.js:TIMELINE` — `LINK LOST` à t=1,6 s après l'impact. PHASE 18
  ne déplace pas cette ligne de texte.
- Les sliders volume / brillance de `src/settings.js`, persistés en
  `localStorage`. Aucun réglage audio nouveau n'est ajouté.

## Décisions transverses de cette spec

- **Un seul `AudioContext`, deux chaînes.** Le mixage doit pouvoir être jugé
  d'une oreille, rituel compris (#11) ; deux contextes séparés rendraient cela
  invérifiable.
- **Le vocabulaire d'événements est une liste close de sept entrées.** C'est la
  forme exécutable de « le système ne bipe pas à chaque clic » : ajouter un son
  demande d'ajouter une entrée, et le selftest refuse tout appel hors liste.
- **Toute la logique temporelle vit dans un module pur**, testable sous Node
  sans navigateur — même partage que `flight-end.js`, `link.js`, `quad.js`.
- **Aucun élément de DA ne devient une dépendance du moteur physique.**
  `npm run selftest` reste vert ; le vol se déroule à l'identique si tout le
  bus d'UI est absent.
- **§37 : aucune voix, aucun narrateur, aucune commande vocale.** Rien dans
  cette phase ne lit, ne prononce ni n'écoute quoi que ce soit.

---

## 1. `src/audio-bus.js` — le contexte et le limiteur partagés

`EngineAudio` crée aujourd'hui l'`AudioContext` dans `start()` et branche sa
chaîne sur `ctx.destination`. Deux choses l'empêchent de servir aussi l'UI :

1. Les sons d'UI arrivent **avant** lui. Le boot et le terminal se jouent bien
   avant qu'une cible ne soit choisie, donc avant l'`audio.start()` de
   `chooseScene()`.
2. `main.js` appelle `audio.setMuted(frozen)` à chaque frame, et `frozen` est
   vrai pendant tout l'écran de hack (`introFrozen`). Un rituel branché sous
   `master` serait muet exactement quand il doit frapper.

Un nouveau module possède donc le strict minimum commun :

```text
moteurs / vent / propwash / impacts → master(mute) → air(lowpass 6k) ─┐
                                                                      ├→ limiteur → volume → destination
SYSTEM / LINK / RITUAL ────────────→ uiMaster(trim) ──────────────────┘
```

Interface :

```js
ensureContext()        // idempotent, resume() un contexte suspendu, null si pas de Web Audio
context()              // l'AudioContext courant ou null
engineIn()             // GainNode d'entrée de la chaîne moteur
uiIn()                 // GainNode d'entrée de la chaîne UI
setVolume(v)           // 0..1, après le limiteur — global
```

Trois conséquences, toutes voulues :

- **L'UI ne traverse pas `air`.** Ce lowpass à 6 kHz est l'excuse « on entend le
  drone à travers une paire de lunettes » ; un click d'interface doit claquer.
  La brillance reste donc un réglage du moteur seul, ce qu'elle a toujours été.
- **L'UI n'est pas coupée par le gel du sim.** `master` continue de porter le
  mute ; `uiMaster` ne porte qu'un trim de mixage constant.
- **Le rituel est limité avec le reste.** Pendant le rituel le moteur est de
  toute façon muet, donc le limiteur ne duck rien ; en vol, `LINK_LOST` est
  assez discret pour ne pas creuser les moteurs. C'est un vrai mixage, pas deux
  sorties qui s'additionnent à l'aveugle.

Retouches à `src/audio.js`, et rien d'autre :

- `start()` → `ensureContext()` au lieu de `new Ctx()`.
- `_build()` branche `air` sur `engineIn()` au lieu de `ctx.destination`, et ne
  construit plus le `DynamicsCompressor` (il vit dans le bus).
- `setVolume(v)` délègue à `audio-bus.setVolume(v)`.
- `_applyMaster()` ne calcule plus que le mute : `target = muted ? 0 : 1`.
- `dispose()` ne ferme plus le contexte (il ne lui appartient plus) ; il
  débranche sa chaîne.

Le volume passe désormais **après** le limiteur, alors qu'il était avant. C'est
un changement de comportement assumé : le seuil du limiteur devient indépendant
de la position du slider, donc « le mixage » désigne enfin une chose unique et
mesurable, quel que soit le volume d'écoute. Les constantes de `AUDIO`
(`limitThreshold`, `limitRatio`, `limitAttack`, `limitRelease`) déménagent dans
`audio-bus.js` inchangées.

## 2. `tools/ui-audio-model.mjs` — le modèle pur

Aucune Web Audio, aucun DOM, aucun `node:`. Bundlé par Vite pour le navigateur,
importé directement par le selftest — même montage que `ritual-model.mjs` et
`hack-model.mjs`.

### 2.1 Le vocabulaire clos

```js
export const UI_EVENTS = [
  'BOOT',            // SYSTEM
  'TERRAIN_READY',   // SYSTEM
  'TARGET_FOUND',    // SYSTEM
  'ERROR',           // SYSTEM
  'LINK_LOST',       // LINK
  'LINK_RESTORED',   // LINK
  'RITUAL',          // RITUAL
];
```

Sept entrées, et le carrier continu qui n'est pas un événement mais un état
(§4). Il n'y a **pas** de son de clic, de survol, de navigation, d'ouverture
d'écran, de sélection dans une liste, de bouton, de validation de formulaire ni
de changement de réglage. La liste ci-dessus est exhaustive et le selftest la
tient (§5).

### 2.2 Le format de partition

Une partition est une liste d'événements en temps absolu (ms depuis le départ),
chacun nommant une **voix** et ses paramètres :

```js
{ at, voice, freq, dur, gain, ...params }
```

Les voix sont sept primitives de synthèse, et rien de plus :

| Voix | Ce que c'est |
|---|---|
| `click` | transitoire de bruit très court, filtré haut |
| `pulse` | sinus grave à chute de hauteur rapide |
| `bass` | grave tenu avec balayage de filtre |
| `glitch` | salve de bruit annelée / décimée |
| `sweep` | ton montant (la « montée » de §36) |
| `stab` | frappe brillante et dissonante |
| `impact` | la retombée finale : grave + bruit |
| `tone` | ton pur à enveloppe raide (signature de boot) |

Ce vocabulaire est **décoratif**. Comme pour PHASE 09/10, rien ici n'encode de
procédure, de trame ni de séquence exploitable : ce sont des enveloppes et des
fréquences.

### 2.3 La signature de boot

`tututuuut tuuuuu-tuu` — cinq notes, deux groupes :

```text
tu   tu   tuuut        tuuuuu   tuu
court court tenu   ·   tenu     court
```

Écrite comme une table de `tone`, au timbre ESC : attaque raide, aucune queue,
aucune réverbération, bande utile ~1–4 kHz — une bobine de moteur employée
comme haut-parleur ne sonne pas autrement.

Les hauteurs ne sont pas inventées : un ESC fait chanter la bobine du moteur en
la commutant à fréquence fixe, et la séquence de démarrage classique est une
montée de trois tons puis une confirmation. La table part donc du triolet
ascendant usuel (~1046 / 1318 / 1568 Hz, do-mi-sol) pour `tu tu tuuut`, puis
redescend sur la tenue et sa réponse courte pour `tuuuuu tuu`. Durées
approximatives : 70 / 70 / 220 ms, silence 180 ms, 320 / 110 ms — c'est le
rythme que l'onomatopée de §35 décrit, et c'est lui qui porte l'identité, plus
encore que les hauteurs.

Un cran de filtrage supplémentaire est appliqué à la version jouée, pour qu'elle
lise comme **un logiciel qui démarre** et non comme un drone posé devant soi :
c'est le « traitement synthétique ou filtré » que §35 autorise explicitement,
tout en conservant l'identité du motif.

**Elle ne joue qu'au boot FPVTP!**, une fois par chargement de page. Décision
arrêtée : ni à l'entrée en vol, ni au respawn, ni nulle part ailleurs. §35 le
demande pour deux raisons qui se rejoignent — « pas comme motif omniprésent »,
et « le crash n'en reprend pas le motif ». À l'entry state le drone est déjà en
l'air : il n'y a aucun armement à sonoriser, donc aucune tentation.

### 2.4 Les six partitions de rituel

Six séquences distinctes écrites à la main, une par famille de `HACK_TYPES`.
Chacune est écrite en **temps normalisé 0..1** puis mise à l'échelle de la
variante par `scoreFor()` :

```js
export function scoreFor(hackType, variantMs)  // -> [{ at, voice, ... }] en ms absolues
```

Écrire en temps normalisé est ce qui évite vingt-quatre partitions : `V1`≈1 s à
`V4`≈4 s changent la durée et l'espacement, pas la construction. L'`impact`
final est ancré à la fin de la partition quelle que soit la variante — c'est la
seule contrainte structurelle, et le selftest la vérifie.

Les identités reprennent le vocabulaire visuel déjà en place dans
`hack-grammars.js`, pour qu'une famille se reconnaisse à l'œil et à l'oreille
de la même manière :

| Famille | Grammaire visuelle | Identité sonore |
|---|---|---|
| `COMMAND INJECTION` | paquets | rafales de `click` staccato, groupées irrégulièrement |
| `LINK HIJACK` | porteuse | un `tone` porteur qu'on plie, puis qu'on capture |
| `TELEMETRY SPOOF` | oscilloscope | `pulse` modulés, wobble de filtre |
| `GNSS SPOOF` | position | paire de `tone` désaccordée qui dérive, battement |
| `NETWORK TAKEOVER` | nœuds | `click` en cascade, densité croissante |
| `FIRMWARE OVERRIDE` | mémoire | blocs de `glitch`, puis une écriture qui claque |

Toutes se terminent par `sweep` → `impact`. Aucune n'est une chanson : pas de
mesure régulière, pas de tonalité, pas de boucle (§36).

Puis **silence → moteur → vol.** Le silence n'est pas à écrire : les 400 ms de
`CONTROL ACQUIRED` (`ritual.js:ACQUIRED_MS`) sont déjà muettes et le moteur
monte quand `introFrozen` retombe. Le travail de cette phase est de **ne rien
poser dessus**.

### 2.5 L'hystérésis du lien

```js
export const LINK_LOST_AT = 0.10;     // quality en dessous de laquelle le lien est perdu
export const LINK_BACK_AT = 0.30;     // et au-dessus de laquelle il est revenu
export const LINK_MIN_GAP_S = 3.0;    // temps de garde entre deux annonces
export function linkEvent(quality, dtS, state)  // -> 'LINK_LOST' | 'LINK_RESTORED' | null
```

Deux seuils et non un : au seuil unique l'annonce bégaierait pendant qu'on
flotte sur la frontière. Les valeurs ne sont pas choisies ici, elles sont
**reprises de `link.js`**, qui les a déjà calibrées pour ce problème exact :
`LINK_LOST_AT` est son `BLACKOUT_Q` (0,10 — l'écran est effectivement mort), et
`LINK_BACK_AT` son `COOLDOWN_FLOOR_Q` (0,30 — dégagé de `FREEZE_LEAVE` à 0,28,
donc l'image ne peut plus geler quand on annonce le retour). L'annonce encadre
ainsi la panne visible au lieu de la doubler : `LINK LOST` arrive après que
l'image a commencé à mourir, `LINK RESTORED` après qu'elle est franchement
revenue.

Le temps de garde ajoute une garantie que l'hystérésis seule ne donne pas : une
traversée franche et répétée de toute la bande — ce qui arrive en slalomant
entre deux immeubles — ne doit pas se transformer en mitraillette. Trois
secondes, du même ordre que `TAU_RISE` (0,70 s) multiplié par la durée d'un
aller-retour crédible.

`state` est un objet opaque que l'appelant conserve entre deux frames ; la
fonction ne garde aucune variable de module, ce qui la rend rejouable dans le
selftest.

## 3. `src/ui-audio.js` — le rendu

Prend le bus, joue les événements du modèle. Aucun DOM, aucun Three, aucun
Rapier. Jamais importé par le moteur.

```js
export class UiAudio {
  play(event)                 // un des sept UI_EVENTS, joué tout de suite
  armBoot()                   // play('BOOT') différé jusqu'au premier geste (§3.1)
  playRitual(hackType, ms)    // programme scoreFor(hackType, ms) d'un coup
  setLinkQuality(q)           // le carrier continu, une fois par frame
  linkSilent()                // coupe le carrier (hors vol)
}
```

Chaque voix construit ses nœuds à la demande et se démonte sur `onended`, comme
le fait déjà `EngineAudio.playImpact` — c'est le seul endroit du fichier où un
nœud naît après le montage, et jamais par frame. Le carrier fait exception :
c'est une branche permanente dont seuls les `AudioParam` bougent.

Une partition de rituel est programmée **en une fois** à `startBurst()`, sur
l'horloge de l'`AudioContext` et non sur `requestAnimationFrame`. Une culmination
de 1 à 4 s doit rester rythmiquement juste même si une frame saute pendant que
la carte finit de se charger.

### 3.1 La politique de geste utilisateur

Au premier chargement d'une page, aucun geste n'a encore eu lieu et le
navigateur refuse de démarrer l'`AudioContext`. Or le boot FPVTP! est
précisément le premier écran : selon le chemin (`bootstrap`, `operatorSelect`,
ou directement `runTerminal` pour un opérateur déjà enregistré), il peut
s'écouler un temps arbitraire avant le premier clic.

`armBoot()` gère cela honnêtement :

- si le contexte démarre tout de suite, la signature joue ;
- sinon elle est **armée** sur le premier `pointerdown` / `keydown` ;
- au-delà d'une fenêtre de **20 s**, l'armement est abandonné plutôt que joué.

Une signature de démarrage qui se déclenche une minute après le démarrage n'est
plus une signature de démarrage. Mieux vaut le silence.

## 4. Câblage

| Événement | Site d'appel | Note |
|---|---|---|
| `BOOT` | `main.js`, avant `chooseScene()` | `armBoot()`, une fois par chargement |
| `TERRAIN_READY` | `main.js:finishBoot()`, à la fin | le moment où la scène est réellement jouable |
| `TARGET_FOUND` | `src/target-scan.js`, dans `sheetConfirm()` | au CONFIRM, pas à la navigation dans la liste |
| `ERROR` | `ritual.js` sur `mismatch` · `hud.fail()` · `bootstrap.js:flushOrRetry()` | |
| `RITUAL` | `src/ritual.js:startBurst()` | `playRitual(hackType, variant.ms)` |
| carrier | `main.js:frame()` | `setLinkQuality(link.out.quality)` en vol |
| `LINK_LOST` / `LINK_RESTORED` | `main.js:frame()` | via `linkEvent()`, état conservé entre frames |

Le `mismatch` du rituel est le seul endroit où le joueur se trompe, et §37 /
issue #47 rappellent que ce n'est pas un game over : l'`ERROR` y est **court et
discret**, un accusé de réception, pas une punition. Il double le
`ritual-shake` visuel qui existe déjà.

Le carrier et les deux one-shots ne vivent **que pendant le vol**. Hors vol,
`linkSilent()`.

Bénéfice obtenu par construction : les one-shots sont pilotés par
`link.out.quality` et rien d'autre, donc un crash produit un vrai effondrement
de porteuse suivi de `LINK_LOST`, environ 1,6 s avant que `flight-end.js`
n'écrive la ligne de texte. Le son précède l'image morte qui précède le texte.
Et comme le crash ne consulte jamais la table de boot, « le crash n'en reprend
pas le motif » est vrai sans qu'aucune règle n'ait à s'en souvenir.

## 5. Tests — `tools/ui-audio-selftest.mjs`

Ajouté à `selftest:operator`. Sans navigateur, sur le modèle pur seul :

1. **Vocabulaire clos.** `UI_EVENTS` a exactement sept entrées. Puis un balayage
   de `sim/src/**.js` : tout `uiAudio.play('X')` dont `X` n'est pas dans
   `UI_EVENTS` fait échouer le test. C'est la forme exécutable de « le système
   ne bipe pas à chaque clic ».
2. **Les six familles rendent.** `scoreFor(f, ms)` non vide pour les six
   `HACK_TYPES` × les quatre variantes `V1..V4`.
3. **L'impact final est ancré.** Pour chaque famille et chaque variante, le
   dernier événement est un `impact` et tombe dans les derniers pourcents de
   `variantMs`. Aucun événement ne dépasse `variantMs`.
4. **Les partitions sont distinctes.** Les six ne se réduisent pas à la même
   suite de voix — la décision « six identités » est vérifiée, pas seulement
   déclarée.
5. **Hystérésis du lien.** Sur une trace de qualité tirée d'un xorshift graine
   fixe : aucun `LINK_RESTORED` sans `LINK_LOST` avant lui, jamais deux
   identiques consécutifs, et un plateau tenu à la frontière ne produit aucune
   annonce.
6. **La signature de boot est bien formée.** Cinq notes, deux groupes séparés
   par un silence, durées court/court/tenu · tenu/court.

`npm run selftest` (le banc physique) reste vert et n'est pas touché : rien de
cette phase n'entre dans `quad.js`, `physics.js` ni `flightController.js`.

## Ce que cette phase ne fait pas

- Aucune voix, aucun narrateur, aucune commande vocale (§37).
- Aucun échantillon chargé : tout est synthétisé, donc aucune question de
  droits sur une source (contrainte explicite de l'issue).
- Aucune musique, à aucun moment, ni en vol ni dans les menus.
- Aucun réglage audio nouveau dans le panneau Tab : les deux sliders existants
  suffisent, et le volume couvre désormais les deux chaînes.
- Aucun son sur un clic, une navigation, un survol, une ouverture d'écran ou un
  changement de réglage.

## Critères d'acceptation (issue #55)

- [ ] Le mixage est équilibré à l'oreille (#11), rituel compris — vérifié dans
      le navigateur, pas sur une capture.
- [ ] Aucun son ne se déclenche sur une action qui n'en avait pas besoin —
      tenu par le test 1.
- [ ] Le crash ne reprend pas le motif de boot ; la perte de liaison reste
      réaliste ; la reconnexion a son propre son.
- [ ] Chaque type de hack a sa signature ; `V1→V4` changent durée et
      construction.
- [ ] Aucune voix.
