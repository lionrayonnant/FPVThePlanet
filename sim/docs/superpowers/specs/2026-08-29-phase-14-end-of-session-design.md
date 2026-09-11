# PHASE 14 — Vol / crash / fin de session

État : validé 2026-08-29.

Issue : https://github.com/lionrayonnant/FPVThePlanet/issues/51
Sources : Bible / Roadmap PHASE 14.

## Objectif

Réorganiser la fin du vol. **Il n'y a pas de `GAME OVER`.**

Un crash n'est pas une défaite : c'est une machine distante qui cesse
d'émettre. L'écran meurt d'abord (dernière image, bruit, noir), le texte
arrive après, et c'est le joueur qui sort du contrôle — rien ne le sort à sa
place.

```text
LINK LOST

TARGET LOST
SESSION TERMINATED

[ESC] DISCONNECT
```

Une pose propre est l'autre fin possible — plus courte et plus calme qu'un
crash (un geste délibéré, pas une agonie), mais elle aussi séquencée dans le
temps et terminée par la même affordance :

```text
LANDING DETECTED
MOTORS DISARMED

END SESSION

[ESC] DISCONNECT
```

Le terrain reste dans les deux cas. `terrain persistent, flights ephemeral`.

## État du dépôt à cette date

Base : `origin/main` (`ea054d0`, PHASE 10 mergée). PHASE 11 (entry state),
PHASE 12 (double HUD) et PHASE 13 ne sont pas mergées et sont tenues par
d'autres sessions. PHASE 14 est donc livrée comme **module autonome** sur le
modèle PHASE 07/08/11 : logique pure testable headless, câblée sur le
`main.js` de `main`.

Ce qui existe déjà et n'est **pas** re-décidé ici :

- `main.js:CRASH_IMPULSE` (1500) et `CRASH_IMPULSE_FLAT` (2800), choisis selon
  l'assiette au moment du choc — les seuils mesurés que l'issue demande de
  réutiliser. Ils ne sont ni déplacés ni re-choisis. `FlightEnd` reçoit un
  booléen `crashed` déjà décidé : la source du seuil lui est indifférente, donc
  le `crashThreshold(rotation)` de PHASE 11 s'y substituera sans changer une
  ligne de PHASE 14.
- `session.end('CRASHED' | 'LANDED')` (PHASE 06) — la fermeture serveur de la
  session. PHASE 14 change **quand** elle est appelée, pas ce qu'elle fait.
- `link.js` / `lens.js` — le gel d'image, le bruit RF, les macroblocs, le
  fondu au noir existent déjà comme modes de dégradation du lien. PHASE 14
  n'écrit aucun nouveau shader : elle pilote ceux-là.
- `physics.js:setGroundHold()` et le critère `touchdown` de `main.js`
  (`armed && throttle < 0.06 && height < 0.6`) — le contact au sol est déjà
  détecté chaque frame pour figer le drone posé.

## Décisions transverses de cette spec

- **La fin de vol est une machine à états pure**, dans son propre module. Ni
  DOM, ni Three, ni Rapier : `main.js` l'alimente et obéit. C'est la seule
  façon de tester une séquence temporisée sans navigateur.
- **Aucun texte n'est décidé dans `main.js`.** Les lignes affichées sortent de
  la machine. `main.js` les rend.
- **`R` (respawn) disparaît du vol.** On ne fait pas réapparaître un drone
  qu'on a perdu. La touche est retirée de `input.onAction`, de l'aide HUD, et
  l'écran `#crash` (« CRASH — R pour repartir ») est supprimé : c'est
  exactement le grand écran de mort que l'issue interdit.
- **Le désarmement en l'air reste permis.** Le détecteur de pose ne bloque
  rien : il dit seulement si le drone est posé. Désarmer à 40 m reste possible
  et donne une chute, donc un crash.
- **Textes du jeu en anglais**, conformément aux décisions transverses du
  2026-08-29.

## Architecture

### D1 — `src/flight-end.js` (nouveau) : la machine à états

Module pur. Aucun import de Three, Rapier ou DOM.

```js
export const FLYING = 'FLYING';
export const LANDING_READY = 'LANDING_READY'; // posé, encore armé
export const LANDED = 'LANDED';               // posé, désarmé
export const CRASHING = 'CRASHING';           // écran en train de mourir
export const TERMINATED = 'TERMINATED';       // séquence finie

export class FlightEnd {
  constructor(opts = {})            // seuils injectables (tests)
  get phase()                       // l'un des cinq ci-dessus
  update({ dt, armed, height, speed, angularSpeed, throttle, crashed })
  disarm()                          // geste explicite du joueur
  reset()
  get out()                         // { phase, lines, linkDead, blackout, exitArmed, closes }
}
```

`out` est le même objet muté chaque frame (comme `link.out`, `wind.out`) :

| champ | sens |
|---|---|
| `phase` | l'état courant |
| `lines` | tableau de lignes à afficher, dans l'ordre, déjà filtré par le temps |
| `linkDead` | `true` dès l'impact : le lien doit être forcé mort |
| `blackout` | 0..1, l'opacité du noir qui recouvre l'image |
| `exitArmed` | `true` quand le joueur peut sortir |
| `closes` | `'CRASHED'` / `'LANDED'` **une seule fois**, la frame où la session doit être fermée ; `null` sinon |

`closes` est un événement à consommation unique : il évite que `main.js`
appelle `session.end()` deux fois, et sort la décision de fermeture de la
boucle de rendu.

**Transitions**

```text
FLYING --crashed---------------------> CRASHING --(timeline)--> TERMINATED
FLYING --pose stable tenue T_HOLD----> LANDING_READY
LANDING_READY --pose perdue----------> FLYING
LANDING_READY --disarm()-------------> LANDED
FLYING/LANDING_READY --crashed-------> CRASHING   (prioritaire, toujours)
LANDED --------------------------------> (terminal, exitArmed)
```

`CRASHING` est absorbant vis-à-vis de la pose : une carcasse immobile au sol
n'est pas un atterrissage.

### D2 — Détection de pose (`landingDetector`, dans `flight-end.js`)

Le critère actuel de `doDisarm()` (`height < 2 && vitesse < 8`) est deviné et
trop large : à 1,8 m et 7 m/s on n'est pas posé, on rase. Il est remplacé par
un critère **tenu dans le temps**, avec hystérésis, bâti sur le `touchdown`
déjà calculé :

```text
entrée (tous vrais, maintenus T_HOLD secondes) :
    height   < H_ON        contact : la sphère de collision touche
    speed    < V_ON        vitesse linéaire
    angSpeed < W_ON        vitesse angulaire — une sphère qui roule n'est pas posée
    throttle < THR_IDLE    gaz coupés
sortie (immédiate, un seul suffit) :
    height   > H_OFF   ou   speed > V_OFF
```

Les seuils sont **mesurés** (D5), pas choisis. Le faux positif à écarter est
le **vol rasant** : c'est lui qui définit la marge, et c'est lui que le
harnais rejoue.

`LANDING_READY` affiche `LANDING DETECTED`. Le désarmement reste un geste du
joueur : `disarm()` déclenche `closes = 'LANDED'` et une séquence de fin qui
lui est propre (`LANDING_TIMELINE`, symétrique de `TIMELINE` — voir D3),
plutôt que d'afficher les quatre lignes d'un coup :

| t (s) | ce qui se passe |
|---|---|
| 0,0 | `LANDING DETECTED` et `MOTORS DISARMED` à l'écran. `closes = 'LANDED'` s'arme, vidangé à la prochaine frame (même gelée, `dt=0`). |
| 0,6 | `blackout` monte à 1 en 0,4 s, par-dessus l'image *vivante* (pas de `linkDead` : la pose ne tue pas le lien). |
| 1,4 | `END SESSION` |
| 2,2 | `[ESC] DISCONNECT`, `exitArmed = true`, phase `TERMINATED` |

`exitArmed` ne s'arme qu'à ce dernier instant : ni au moment de `disarm()`, ni
à la frame qui vidange `closes` — il faut à la fois que la fermeture de
session soit partie *et* que le joueur ait vu l'écran de fin en entier avant
qu'Échap ne le ramène au terminal.

Un `disarm()` hors `LANDING_READY` ne ferme rien : la machine reste en
`FLYING`, les moteurs sont coupés côté contrôleur, la chute suit son cours, et
l'impact fera le reste.

### D3 — La séquence de crash

Ordre imposé par la Bible : l'**image** meurt avant le **texte**.

| t (s) | ce qui se passe |
|---|---|
| 0,0 | impact au-delà du seuil de crash. `linkDead = true` : dernière image gelée, bruit/macroblocs au maximum. Moteurs coupés. `closes = 'CRASHED'`. Aucun texte. |
| 0,9 | `blackout` monte à 1 en 0,4 s — noir. |
| 1,6 | `LINK LOST` |
| 2,8 | `TARGET LOST` |
| 3,6 | `SESSION TERMINATED` |
| 4,6 | `[ESC] DISCONNECT`, `exitArmed = true`, phase `TERMINATED` |

Ces durées sont un choix de mise en scène, pas une mesure : elles vivent dans
un objet `TIMELINE` exporté, en haut du module, et se relisent d'un coup
d'œil. Elles sont injectables pour que les tests n'attendent pas 4,6 s.

La pose (D2) a sa propre table, `LANDING_TIMELINE`, plus courte et sans palier
intermédiaire (pas de `LINK LOST` / `TARGET LOST` : une pose ne fait pas
mourir le lien). Les deux tables sont lues par une seule fonction
d'avancement (`_advanceTimeline`, sur `this._activeTimeline`) : le mécanisme —
horloge en secondes depuis l'origine de la séquence, fondu au noir borné entre
`blackoutAt` et `blackoutAt + blackoutFade`, lignes reconstruites à chaque
frame par filtrage temporel, `exitArmed`/`TERMINATED` posés au dernier
instant — est strictement le même ; seules les valeurs et le nombre de lignes
diffèrent.

Interdits vérifiés par revue : pas de commentaire ironique, pas de musique,
pas de score, pas de récompense, pas de `GAME OVER`.

### D4 — `linkDead` : comment l'image meurt

`main.js` passe déjà `link.out` à `lens.render()`. Pendant `CRASHING`, il
passe à la place un objet mort :

```js
const linkOut = flightEnd.out.linkDead ? DEAD_LINK : link.out;
// DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true }
```

`quality: 0` et `frozen: true` sont exactement ce que `lens.js` interprète
déjà comme « le lien est mort » : gel de la dernière image en numérique, neige
et déchirure en analogique. Aucun code d'image nouveau.

Cas limite : le joueur a réglé la sévérité du lien à 0 (`LINK_OFF`), et
`lens.js` ne dessinerait alors aucune dégradation. Au premier frame de
`CRASHING`, `main.js` force donc `lens.setLink({ mode, severity: 1 })` avec le
mode courant, ou `LINK_ANALOG` si le lien était coupé. Le réglage du joueur
est restauré au retour au terminal — de toute façon la session est finie.

Le son : les moteurs sont coupés à l'impact (`controller.disarm()`), donc
`audio` s'éteint tout seul via le régime moteur. `audio.playImpact()` reste
joué. Aucune musique n'est ajoutée.

### D5 — `tools/landing-selftest.mjs` (nouveau) : mesurer les seuils

Harnais headless Rapier, sur le modèle de `tools/entry-state-selftest.mjs` et
`tools/tune-pid.mjs`. Il rejoue, sur une scène réelle, deux familles de
trajectoires :

- **poses** : descente verticale gaz coupés depuis 1 m, 3 m, 8 m ; posé sur
  pente ; posé par vent fort ; rebond sur la sphère de collision ;
- **vols rasants** (les faux positifs) : passage à 0,3 / 0,6 / 1,0 m à 5, 10 et
  20 m/s ; hover stationnaire bas ; roulé au sol sans être posé.

Pour chaque trajectoire il enregistre `(height, speed, angSpeed, throttle)` à
chaque pas, puis rapporte les distributions des deux familles. Les seuils
retenus sont posés **dans la zone de séparation observée**, et le test échoue
si un rasant déclenche la détection ou si une pose ne la déclenche pas dans
les 2 s.

Les valeurs finalement retenues sont écrites dans `flight-end.js` avec, en
commentaire, la mesure qui les justifie — comme les PID.

### D6 — `tools/flight-end-selftest.mjs` (nouveau) : la machine seule

Sans Rapier. Alimente `FlightEnd` avec des frames synthétiques et vérifie :

- l'ordre et l'horodatage des lignes de la séquence de crash ;
- `closes` émis exactement une fois, jamais deux ;
- `exitArmed` faux avant la fin de la séquence ;
- un crash pendant `LANDING_READY` gagne ;
- un `disarm()` en vol ne ferme pas la session ;
- un rasant qui traverse brièvement les seuils ne fait pas `LANDING_READY` ;
- `reset()` remet tout à zéro.

Les deux harnais entrent dans `npm run selftest:operator`.

### D7 — `src/hud.js` : l'écran de fin

- Suppression de `#crash` (« CRASH — R pour repartir ») et de la mention `R`
  dans l'aide.
- Nouvel élément `#flight-end`, plein écran, noir, texte monospace centré,
  `hidden` par défaut. Il porte le `blackout` en `background: rgba(0,0,0,α)`
  et les lignes en `<div>`, une par ligne.
- Nouvelle méthode `hud.setFlightEnd({ lines, blackout })`. Tout le DOM reste
  dans `hud.js`.
- `#session-status` (le badge d'angle HUD de PHASE 06) est conservé pour le
  vol, mais n'affiche plus les textes de fin : ils appartiennent à l'écran de
  fin.

### D8 — Câblage `src/main.js`

- `input.onAction` : la branche `'r'` disparaît ; `'escape'` sort au terminal
  quand `flightEnd.out.exitArmed` (avant la branche réglages).
- `respawn()` disparaît du vol. La fonction est supprimée ; le spawn initial
  reste où il est.
- La boucle physique appelle `flightEnd.update()` une fois par frame avec les
  grandeurs déjà calculées (hauteur sol, vitesses, gaz, `impact >
  crashThreshold`).
- `flightEnd.out.closes` déclenche `session.end(...)`.
- `doDisarm()` se réduit à : `controller.disarm()` + `flightEnd.disarm()`. La
  décision « était-ce une pose ? » n'est plus prise là.
- `__sim.debug()` expose `flightEnd.out.phase` à la place du booléen
  `crashed`.

## Séquencement (ordre d'implémentation)

1. `flight-end.js` : machine à états + timeline de crash, seuils de pose en
   place mais provisoires. `tools/flight-end-selftest.mjs` vert.
2. `tools/landing-selftest.mjs` : mesure, puis seuils définitifs commités avec
   leur justification.
3. `hud.js` + `style.css` : écran de fin, suppression de `#crash` et de `R`.
4. `main.js` : câblage, suppression de `respawn()`, `DEAD_LINK`, `escape`.
5. Vérification en vol dans le navigateur : un crash, une pose, un rasant.

## Tests

- `npm run selftest` reste vert (aucun élément de DA ne devient une dépendance
  du moteur physique).
- `npm run selftest:operator` couvre les deux nouveaux harnais.
- Vérification manuelle en vol pour ce que le headless ne voit pas : le
  ressenti de la mort d'image, la lisibilité des lignes, l'absence de tout
  écran de récompense.

## Critères d'acceptation (issue #51)

- Un crash ne propose rien d'autre que de sortir : plus de `R`, plus de
  `#crash`, une seule affordance à la fin de la séquence.
- Une pose propre est reconnue sans faux positif en vol rasant, prouvé par
  `tools/landing-selftest.mjs`.
- Le seuil de crash est réutilisé, pas re-choisi.
- `link.js` et `lens.js` fournissent la perte d'image, sans code d'image
  nouveau.

## Hors périmètre

- `SESSION COMPLETE` et le rapport après-vol : PHASE 15. PHASE 14 s'arrête sur
  `END SESSION` / `[ESC] DISCONNECT` et le retour au terminal.
- Le passage complet du HUD en anglais : PHASE 19 / 25.
- L'audio de fin de vol : PHASE 18.
