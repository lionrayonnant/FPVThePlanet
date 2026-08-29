# PHASE 10 — Control Vector + rituels

État : validé 2026-08-29. Issue : https://github.com/lionrayonnant/FPVTP/issues/47

Périmètre : remplacer le `[ JACK IN ]` provisoire de PHASE 09 (`src/hack.js`)
par le vrai rituel décrit Bible §14/18 — le joueur tape son `CONTROL VECTOR`
(fixe, propre à l'opérateur) après `MANUAL OVERRIDE REQUIRED`, puis 1 à 4
secondes de « folie demo scene » (variante V1–V4 tirée au hasard), puis
`CONTROL ACQUIRED`, puis coupure immédiate vers le vol — sans écran
intermédiaire.

## Contexte (état du code au moment de la spec)

PHASE 09 mergée (`a52e721`). `src/hack.js` joue déjà la séquence automatique
(`AUTOMATED BYPASS … OK`, `CONTROL CHANNEL … READY`, motif de famille) et
s'arrête sur `MANUAL OVERRIDE REQUIRED` + un bouton `[ JACK IN ]` qui résout
immédiatement — c'est ce bouton que PHASE 10 remplace.

L'infrastructure Control Vector existe déjà, construite avant cette session
(commits `PHASE 01 …`), en avance sur la numérotation Bible/Roadmap :

- `tools/operator-store.mjs` : `controlVector` (array de `'up'|'right'|'down'|'left'`,
  défaut `[]`), `validateControlVector`.
- `tools/map-api-plugin.mjs` : route `PATCH /__operator/:id` accepte la clé
  `controlVector` (`OP_WRITABLE_KEYS`).
- `src/operator.js` : `getOperator()`, `patch('controlVector', vec)`, `flush()`.
- `src/bootstrap.js` : `captureControlVector(root, length)` — écran de
  **définition** (`DEFINE CONTROL VECTOR`, réglage de longueur 4–8, saisie,
  `CONFIRM VECTOR`), déjà câblé au premier lancement (`bootstrap()`).
  `readGamepadDir(prev)` — lecture D-pad/stick, **privée à ce module**.
- `src/terminal.js` : `controlVectorScreen` — recall/modification depuis
  l'Operator Terminal (bullets masqués, bouton `REVEAL`).

PHASE 10 ne touche **pas** à la définition/au recall (déjà faits). Elle
ajoute l'écran qui **exige** le vecteur pendant un hack.

## Décisions actées en amont (issues de la conversation)

- Le rituel utilise le **vrai** `operator.controlVector`, pas un vecteur de
  démo séparé.
- Chemins dev (`?scene=`/`?family=`/`?hack=`) : si l'opérateur chargé a un
  `controlVector` vide (ex. `ensureDevOperator()` sans passer par le
  bootstrap), le rituel génère un vecteur de secours **à la volée pour cette
  seule exécution** (`['up','right','down','left','up','left']`) — jamais
  écrit sur l'opérateur.
- Identité sonore des rituels (Bible §36) : **hors périmètre**, follow-up
  issue.

## Architecture

### A — `tools/ritual-model.mjs` (nouveau, pur)

Même esprit que `hack-model.mjs` : logique testable sans DOM, importée par le
selftest et par `src/ritual.js`.

```js
export const RITUAL_VARIANTS = [
  { id: 'V1', ms: 1000 },
  { id: 'V2', ms: 2000 },
  { id: 'V3', ms: 3000 },
  { id: 'V4', ms: 4000 },
];

// Tirage déterministe à partir d'un seed string (même seed que hack.js pour
// que ?hack=&scene= rejoue la même variante).
export function pickVariant(seed) { … }        // -> un élément de RITUAL_VARIANTS

export const FALLBACK_VECTOR = ['up', 'right', 'down', 'left', 'up', 'left'];

// Vecteur à utiliser pour CE hack : le vecteur opérateur s'il est non vide,
// sinon FALLBACK_VECTOR. Ne modifie jamais l'opérateur.
export function ritualVector(operatorVector) { … }

// Compare l'input reçu au prochain élément attendu.
// Retourne { status: 'advance' | 'complete' | 'mismatch' }.
export function checkInput(vector, typedSoFar, input) { … }
```

`checkInput` est la seule règle de correction : préfixe strict, aucune
tolérance de "presque bon" — un mauvais input == `mismatch`, la couche DOM
vide le tampon et recommence à l'index 0 (pas de pénalité, pas de compteur
d'échecs, cf. critère d'acceptation « ce n'est pas un game over »).

### B — Primitives de culmination : extension de `src/hack-grammars.js`

Le fichier possède déjà le mini-toolkit ASCII (`frame`, `blank`, `put`, `text`,
`stroke`, `noise`, `lines`) réutilisé tel quel — pas de nouveau système de
rendu (pas de canvas), cohérence avec PHASE 09.

8 primitives, chacune `draw(el, { t, seed, accent })` où `accent` est une des
4 couleurs réservées Bible §19 (voir CSS) :

| Primitive | Effet | Familles qui la pondèrent fort |
|---|---|---|
| `scanBurst` | défilement de tokens hex/vocabulaire de la famille | COMMAND INJECTION, FIRMWARE OVERRIDE |
| `glitchShift` | tearing/offset horizontal de bandes de texte | toutes (bruit générique) |
| `pulseRing` | anneau ASCII qui s'étend depuis le centre | LINK HIJACK, NETWORK TAKEOVER |
| `gridSwarm` | grille de cellules qui s'allument en cascade | NETWORK TAKEOVER, COMMAND INJECTION |
| `waveformSpike` | spike/onde façon oscilloscope | TELEMETRY SPOOF, LINK HIJACK |
| `vectorSweep` | flèche/ligne qui balaie l'écran | GNSS SPOOF |
| `memoryScroll` | colonne d'offsets hex qui défile vite | FIRMWARE OVERRIDE |
| `chromaSplit` | dédoublement de caractères (aberration) | GNSS SPOOF, TELEMETRY SPOOF |

```js
export const RITUAL_PRIMITIVES = {
  scanBurst, glitchShift, pulseRing, gridSwarm,
  waveformSpike, vectorSweep, memoryScroll, chromaSplit,
};

// 2-3 primitives pondérées par famille (les mêmes 8 fonctions pour toutes ;
// seul le sous-ensemble + l'ordre changent). Une entrée absente retombe sur
// ['glitchShift', 'pulseRing'] (générique).
export const FAMILY_PRIMITIVES = {
  'COMMAND INJECTION': ['scanBurst', 'gridSwarm', 'glitchShift'],
  'LINK HIJACK': ['pulseRing', 'waveformSpike'],
  'TELEMETRY SPOOF': ['waveformSpike', 'chromaSplit'],
  'GNSS SPOOF': ['vectorSweep', 'chromaSplit'],
  'NETWORK TAKEOVER': ['gridSwarm', 'pulseRing'],
  'FIRMWARE OVERRIDE': ['memoryScroll', 'scanBurst'],
};
```

**Composition d'une variante** (dans `ritual.js`, pas dans les primitives
elles-mêmes — les primitives ne connaissent ni variante ni durée) : pour
`V{n}`, jouer les primitives de la famille en séquence sur la durée totale
`ms` de la variante, `n` battements (`V1` = 1 battement/primitive unique,
`V4` = 4, en re-bouclant sur la liste de 2-3 primitives de la famille si
besoin). Le tirage de variante (`pickVariant`) est indépendant du choix de
primitives (fixé par famille) : c'est le nombre de battements et le tempo qui
varient, pas l'identité visuelle — cohérent avec Bible §18 « le Vector reste
toujours le même, ce qui change est la mise en scène ».

**Ordre d'implémentation (grammaire, pas 24 séquences)** : construire d'abord
`glitchShift` + `pulseRing` (les deux génériques) et les brancher sur
`COMMAND INJECTION` avec ses 4 variantes ; une fois le rythme bon (lisible,
« ça claque »), écrire les 6 autres primitives et remplir `FAMILY_PRIMITIVES`
pour les 5 familles restantes — pas de 7ᵉ primitive écrite avant que les 2
premières ne se sentent bien.

### C — Écran client : `src/ritual.js` (nouveau)

Client pur, mêmes contraintes que `hack.js` (aucun import Three/Rapier/
physics ; jamais dans le graphe moteur ; look via `screen`/`button` de
`terminal.js`).

```js
export async function runRitual(root, { hackType, family, vector, seed }) {…}
```

Déroulé DOM :

1. Prompt : `_ _ _ _ _ _` (autant de blancs que `vector.length`), sous le
   texte déjà affiché par `hack.js` (`MANUAL OVERRIDE REQUIRED`) — `hack.js`
   monte l'écran de `ritual.js` à la place d'armer `[ JACK IN ]`.
2. **Saisie** — clavier (`ArrowUp/Right/Down/Left`) et manette (D-pad/stick,
   seuil ±0.5, même logique que `readGamepadDir`). Chaque input valide
   (`checkInput` → `advance`) échoie une flèche à la suite des précédentes.
   `mismatch` → classe CSS `.ritual-shake` sur la ligne (courte animation),
   tampon vidé, on repart de l'index 0. `complete` → passe à l'étape 3.
3. **Culmination** — `pickVariant(seed)` détermine `V{n}`/`ms` ; pendant `ms`,
   une seule boucle `requestAnimationFrame` invoque les primitives composées
   (section B) sur un `<pre class="ritual-burst">` plein cadre ; couleurs
   réservées appliquées via variables CSS (section D).
4. `CONTROL ACQUIRED` affiché ~400 ms (fixe, hors variante), puis
   `runRitual` résout — aucun bouton, aucune touche à presser : la coupure
   est automatique (critère d'acceptation « sticks en main, sans écran
   intermédiaire »).

`readGamepadDir` est déplacé de `src/bootstrap.js` vers un petit module
partagé `src/gamepad-dir.js` (fonction pure, aucune dépendance DOM au-delà de
`navigator.getGamepads`) ; `bootstrap.js` et `ritual.js` l'importent tous les
deux — évite de dupliquer les seuils d'axes.

### D — CSS : `src/style.css`

Nouvelles variables, portée strictement `.ritual-burst` (jamais globales —
DA §46 « pas de glow permanent », ces couleurs sont l'exception réservée
Bible §19) :

```css
.ritual-burst { --ritual-cyan: #4dd8e8; --ritual-magenta: #e34de0; --ritual-violet: #8a5cf6; --ritual-blue: #3b6cff; }
```

`.ritual-shake` : keyframe de translation horizontale courte (~200ms),
réutilisable pour tout mismatch futur ailleurs si besoin.

### E — Câblage : `src/hack.js`

Remplace la fonction `arm()` actuelle (qui posait `[ JACK IN ]` + listener
Entrée) par un appel à `runRitual` :

```js
import { runRitual } from './ritual.js';
import { ritualVector } from '../tools/ritual-model.mjs';
import { getOperator } from './operator.js';
…
const enterLock = async () => {
  if (done) return;
  phase = 'lock';
  lockT0 = nowMs();
  after(HACK_LOCK_MS, async () => {
    const vector = ritualVector(getOperator()?.controlVector);
    await runRitual(s.box, { hackType: type, family, vector, seed: family || type });
    finish();
  });
};
```

`s.box` reste monté (le motif de fond de `hack-grammars.js` peut continuer à
tourner en arrière-plan pendant le rituel, ou être caché — détail
d'implémentation, sans impact sur le contrat). `finish()` inchangé : démonte
et résout la promesse de `runHack`, donc `main.js` n'a **aucun changement** —
`await runHack(ui, …)` résolu = vol immédiat, déjà le cas depuis PHASE 09.

`family` peut être `undefined` sur les chemins `?scene=`/`?hack=` seuls (sans
`?family=`) : `FAMILY_PRIMITIVES` retombe sur le générique
`['glitchShift', 'pulseRing']` dans ce cas, comme toute famille absente de la
table.

### F — Revue de sûreté

- Aucune primitive ne dessine de commande, tension, séquence protocolaire
  réelle — uniquement du bruit ASCII animé et du vocabulaire déjà en liste
  blanche (`HACK_VOCAB`) pour `scanBurst`/`memoryScroll`.
- Le vecteur n'est jamais loggué en clair côté client au-delà de son propre
  écho pendant la saisie (déjà le comportement de `captureControlVector`).
- `git diff` relu avant merge.

## Tests

**`tools/ritual-selftest.mjs`** (nouveau) :

- `pickVariant(seed)` déterministe (même seed → même variante) et couvre les
  4 variantes sur un échantillon de seeds.
- `ritualVector([])` → `FALLBACK_VECTOR` ; `ritualVector(['up','up'])` → le
  vecteur passé, inchangé.
- `checkInput` : préfixe correct → `advance` puis `complete` au dernier ;
  mauvais input à n'importe quel index → `mismatch`.
- `FAMILY_PRIMITIVES` : chaque famille de `HACK_TYPES` a une entrée, chaque
  primitive citée existe dans `RITUAL_PRIMITIVES`.

`npm run selftest` reste vert : `ritual.js` n'est pas dans le graphe moteur.

**Vérif navigateur** (HANDOFF) : terrain → TARGET SCAN → AUTOMATED ANALYSIS →
`MANUAL OVERRIDE REQUIRED` → saisie vecteur (clavier) → mismatch volontaire
(vérifier le shake + reset) → saisie correcte → culmination → `CONTROL
ACQUIRED` → vol, sticks actifs sans écran intermédiaire. Les 6 familles via
`?hack=<type>&scene=<slug>` (vecteur de secours puisque `?scene=` seul).
Manette si disponible.

## Fichiers touchés

| Fichier | Nature |
|---|---|
| `tools/ritual-model.mjs` | **nouveau** — variantes, vecteur de secours, validation de saisie |
| `tools/ritual-selftest.mjs` | **nouveau** |
| `src/hack-grammars.js` | 8 primitives + `RITUAL_PRIMITIVES`/`FAMILY_PRIMITIVES` |
| `src/ritual.js` | **nouveau** — écran de saisie + culmination |
| `src/gamepad-dir.js` | **nouveau** — extrait de `bootstrap.js` |
| `src/bootstrap.js` | importe `gamepad-dir.js` au lieu de sa fonction privée |
| `src/hack.js` | `enterLock`/`arm` → appelle `runRitual` |
| `src/style.css` | `.ritual-*`, variables couleur réservées |
| `sim/HANDOFF.md` | état vérifié/non vérifié |
| issue #47 | statut → Done à la clôture |

## Hors périmètre (→ suites)

- Identité sonore par type de hack + rituel (Bible §36).
- `DEFINE CONTROL VECTOR` / recall / modification : déjà livrés, PHASE 10 n'y
  touche pas.
- Manette : axes uniquement testés en logique ; validation matérielle réelle
  laissée à la vérif navigateur (pas de mock de `Gamepad` dans le selftest,
  comme `bootstrap.js` aujourd'hui).

## Plan d'implémentation

1. `tools/ritual-model.mjs` + `ritual-selftest.mjs` : variantes, vecteur de
   secours, `checkInput`. Vert.
2. `src/hack-grammars.js` : `glitchShift` + `pulseRing`, brancher sur
   `COMMAND INJECTION`, itérer au ressenti.
3. `src/gamepad-dir.js` : extraire de `bootstrap.js`, re-brancher.
4. `src/ritual.js` : saisie (clavier d'abord) + culmination avec les 2
   primitives + `CONTROL ACQUIRED`.
5. `src/hack.js` : câblage `runRitual`, retirer l'ancien `[ JACK IN ]`.
6. Vérif navigateur bout en bout sur `COMMAND INJECTION` seul.
7. 6 primitives restantes + `FAMILY_PRIMITIVES` pour les 5 autres familles.
8. Manette : brancher dans `ritual.js`, vérif navigateur avec manette si
   disponible.
9. CSS : `.ritual-shake`, couleurs réservées, revue DA (pas de glow permanent
   ailleurs).
10. Revue de sûreté, HANDOFF, issue #47.
