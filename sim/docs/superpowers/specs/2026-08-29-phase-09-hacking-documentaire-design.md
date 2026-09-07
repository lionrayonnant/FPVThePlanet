# PHASE 09 — Système de hacking documentaire

État : validé 2026-08-29. Issue : https://github.com/lionrayonnant/FPVThePlanet/issues/46

Périmètre : introduire les **six familles de hacking** comme abstractions de
gameplay — le `hackType` devient une propriété de la cible, et un écran
`AUTOMATED ANALYSIS` s'intercale entre le choix de cible (PHASE 08) et le vol.
La phase s'arrête sur `MANUAL OVERRIDE REQUIRED` + un bouton `[ JACK IN ]`
provisoire qui lance le vol. Le rituel réel (CONTROL VECTOR + QTE, 4 variantes,
folie demo scene) est **PHASE 10**.

## Règle de sécurité — non négociable

Les concepts et les noms sont documentés et crédibles (MAVLink non signé,
MAVLink2 Signing, spoofing GNSS sur UAV). **Les procédures interactives sont des
abstractions de gameplay.** Aucune trame, aucun outil, aucune séquence
exploitable contre du matériel réel. Ce qui est autorisé : le vocabulaire, la
grammaire visuelle, la mise en scène.

Livrable de conformité : une section « Revue de sûreté » ci-dessous + une
relecture de `git diff` avant merge confirmant qu'aucune procédure offensive
réelle n'y figure. Les motifs sont des animations décoratives ; le log
automatique est deux lignes fixes.

## Contexte (état du code au moment de la spec)

PHASE 08 mergée (`35a73dc`). Le modèle cible existe :

- `tools/target-model.mjs` — logique pure, importée par le plugin de dev, le
  selftest et le client (bundle Vite). `generateTargetScan({seed,count})` tire
  des candidats déterministes ; `describeTarget(candidate)` produit la fiche
  pré-hack (ne fuite jamais `_family`) ; `resolveTarget(scan,index)` produit le
  descripteur persisté (avec `family`, `signal`, `intel`).
- `src/target-scan.js` — écran client `runTargetScan(root,{seed,count})` →
  `{seed,count,index}`.
- `tools/session-model.mjs` — `sanitizeTarget(raw)` valide/fige la forme du
  descripteur persisté sur la session. `null` licite (chemin dev `?scene=`).
- `tools/map-api-plugin.mjs` — à l'ouverture de session, régénère le scan depuis
  `{targetSeed,targetCount,targetIndex}` et appelle `resolveTarget` : le serveur
  est la source de vérité, le client n'envoie qu'un index.
- `src/main.js` `chooseScene()` — après `runTargetScan`, résout la famille
  (`scan.candidates[choice.index]._family`) et enchaîne `boot()`. Sauté sur
  `?scene=`, `?family=` et `resume`.
- `src/link.js` — `link.setSignal({rssiDbm})` armé depuis `session.current().target`.

Le `hackType` n'existe nulle part.

## Architecture

### A — `hackType` comme propriété de cible (couche modèle, pure)

**`tools/target-model.mjs`**

- `export const HACK_TYPES = ['COMMAND INJECTION', 'LINK HIJACK', 'TELEMETRY SPOOF', 'GNSS SPOOF', 'NETWORK TAKEOVER', 'FIRMWARE OVERRIDE']`
  — ordre = ordre Bible §17.
- Dans `generateTargetScan`, chaque candidat reçoit `_hackType`, tiré par **un
  `rand()` dédié** dans la même séquence xorshift seedée `${seed}::scan` :
  `const hackType = pick(rand, HACK_TYPES);`. Placé de sorte à ne pas décaler
  les tirages existants — **ajouté en fin de boucle candidat**, après le tirage
  `mode`, pour ne pas changer la sortie RSSI/mode d'une graine donnée
  (le selftest de déterminisme PHASE 08 compare des JSON complets : ses graines
  de référence verront `_hackType` apparaître, c'est attendu et le test est
  ré-généré).
- Indépendance : `_hackType` ne lit ni `family`, ni `rssiDbm`, ni rien de
  l'entry state (PHASE 11). Un seul `rand()`, rien d'autre.
- `describeTarget` — **inchangé**. Le hack type n'est pas sur la fiche
  pré-sélection : l'archi est `TARGET → TARGET HACK TYPE → AUTOMATED ANALYSIS`,
  le type se révèle à l'entrée de l'écran de hack, pas avant.
- `resolveTarget(scan, index)` — ajoute `hackType: c._hackType` au descripteur
  retourné.

**`tools/session-model.mjs`**

- Importer `HACK_TYPES` depuis `./target-model.mjs`.
- `sanitizeTarget(raw)` : si `raw.hackType` présent, valider
  `HACK_TYPES.includes(raw.hackType)` (throw `hackType de cible inconnu : …`
  sinon) et le reporter sur l'objet nettoyé. Absent → `hackType: null` toléré
  (sessions antérieures, chemin dev). Le champ suit `family`/`classHint`.

**`tools/map-api-plugin.mjs`** — aucun changement : `resolveTarget` porte
désormais `hackType`, `sanitizeTarget` le laisse passer.

### B — Écran AUTOMATED ANALYSIS : `src/hack.js` (nouveau)

Client pur. Look terminal via `screen`/`button` exportés par `terminal.js`.
**Aucun import Three / Rapier / physics / quad / flightController.** N'est jamais
importé par le moteur — `npm run selftest` ne le voit pas.

Signature : `export function runHack(root, { hackType, family }) → Promise<void>`
résolue quand le joueur active `[ JACK IN ]` (clic ou touche Entrée). Nettoie ses
listeners et son animation avant de résoudre.

Rendu (texte anglais, D5) :

1. En-tête `HACK // ${hackType}`.
2. **Log automatique** — lignes ajoutées une à une, cadence ~150 ms, ~1,5 s
   total, mot pour mot Bible §18 :
   ```text
   AUTOMATED BYPASS ........ OK
   CONTROL CHANNEL ......... READY

   MANUAL OVERRIDE REQUIRED
   ```
   `MANUAL OVERRIDE REQUIRED` apparaît en dernier, mis en valeur (classe CSS,
   pas de couleur néon — cf. DA §46 « pas de code vert »).
3. **Motif visuel de la famille de hack** — le livrable du critère d'acceptation
   « six familles reconnaissables sans lire leur nom ». Une fonction par type
   dans une map :
   ```js
   const GRAMMARS = {
     'COMMAND INJECTION': drawPackets,   // lignes de paquets / bursts
     'LINK HIJACK':       drawCarrier,   // porteuse sinus + marqueur de sync qui se cale
     'TELEMETRY SPOOF':   drawScope,     // trace oscilloscope
     'GNSS SPOOF':        drawVectors,   // vecteurs de position / fix qui dérive
     'NETWORK TAKEOVER':  drawNodes,     // graphe de nœuds / hops de route qui s'allument
     'FIRMWARE OVERRIDE': drawMemory,    // colonne d'offsets mémoire / ligne patchée
   };
   ```
   Chaque `draw*` : ~20-30 lignes, écrit dans un `<pre class="hack-grammar">`
   (ASCII animé) ou manipule quelques nœuds DOM sous `.hack-*`. Une **seule**
   boucle `requestAnimationFrame` dans `runHack` appelle le `draw*` courant avec
   un temps `t` ; `cancelAnimationFrame` au teardown. Pas de `setInterval`
   multiples. Les motifs sont purement esthétiques : aucune donnée de la cible
   n'y transite hormis un `seed` cosmétique dérivé de `family` pour varier le
   bruit d'un vol à l'autre.
   `family` sert uniquement à teinter le motif (p. ex. densité de paquets,
   fréquence de la porteuse) — jamais à révéler la famille au joueur.
4. `[ JACK IN ]` (CTA `terminal-cta`) + touche Entrée. Placeholder du rituel
   PHASE 10.

CSS : namespace `.hack-*` dans `src/style.css`, dans l'esprit des écrans
terminal existants (monospace, pas de glow permanent).

### C — Câblage dans le flux : `src/main.js`

Dans `chooseScene()`, branche « session fraîche → TARGET SCAN » uniquement
(après `runTargetScan`, avant le `return`) :

```js
const choice = await runTargetScan(ui, { seed, count });
const cand = scan.candidates[choice.index];
await runHack(ui, { hackType: cand._hackType, family: cand._family });
return { slug, resume: undefined, target: choice, family: cand._family };
```

**Sauté** — identique aux exclusions du TARGET SCAN : `OPTS.scene`,
`OPTS.family`, `resume`. Le serveur reste la source de vérité pour le `hackType`
persisté (via `resolveTarget`) ; le client ne fait que la mise en scène.

Hook debug : `?hack=<TYPE>` dans `OPTS` (parsing comme `?family=`) — quand
présent, `chooseScene` sur le chemin `?scene=`/`?family=` monte `runHack` une
fois avec ce type avant `boot()`, pour prévisualiser un motif isolément.
Accepte le nom avec tirets ou espaces (`gnss-spoof` → `GNSS SPOOF`).

### D — Revue de sûreté (à inclure dans la spec livrée + HANDOFF)

- Le log automatique = **deux lignes fixes** + un titre. Aucune commande, aucun
  paramètre, aucune adresse.
- Les motifs = **animations décoratives** paramétrées par un seed cosmétique.
  Aucun ne décrit une étape réelle : `drawPackets` dessine des rectangles qui
  défilent, pas une trame MAVLink ; `drawMemory` affiche des offsets hexa
  aléatoires, pas un patch.
- Aucun texte du jeu ne donne une séquence reproductible.
- Contrôle avant merge : `git diff main...phase-09-hacking` relu entièrement,
  mention explicite dans le message de merge / HANDOFF que la revue a été faite.

### E — Tests

**`tools/target-selftest.mjs`** — ajouts :

- `_hackType` déterministe : même graine → même `_hackType` par candidat
  (déjà couvert par le check JSON global, mais un check nommé explicite).
- Indépendance famille : sur ~200 graines, la distribution jointe
  (famille × hackType) ne montre pas de corrélation forte — check lâche : chaque
  `hackType` apparaît avec chaque `family` au moins une fois sur l'échantillon.
- Distribution ~uniforme : sur ~600 tirages, chaque `hackType` entre 10 % et
  23 %.
- `describeTarget` ne fuite jamais `_hackType` (comme pour `_family`).
- `resolveTarget` : `HACK_TYPES.includes(t.hackType)`.
- Garde-fou de dérive : `HACK_TYPES.length === 6`.

**`tools/session-*-selftest.mjs`** — `sanitizeTarget` : un `hackType` valide est
conservé ; un `hackType` inconnu throw ; `null`/absent toléré.

**`npm run selftest`** reste vert : `src/hack.js` n'est pas dans le graphe du
moteur, aucune constante physique touchée.

**Vérif navigateur** (HANDOFF) : terrain → TARGET SCAN → AUTOMATED ANALYSIS →
`[ JACK IN ]` → vol. Les 6 motifs via `?hack=<type>&scene=<slug>`.

## Fichiers touchés

| Fichier | Nature |
|---|---|
| `tools/target-model.mjs` | `HACK_TYPES`, tirage `_hackType`, `resolveTarget` |
| `tools/session-model.mjs` | `sanitizeTarget` passthrough + validation |
| `tools/target-selftest.mjs` | tests hackType |
| `tools/session-selftest.mjs` / `session-route-selftest.mjs` | tests sanitize (selon lequel couvre `sanitizeTarget`) |
| `src/hack.js` | **nouveau** — écran + motifs |
| `src/main.js` | câblage `runHack`, hook `?hack=` |
| `src/style.css` | namespace `.hack-*` |
| `sim/HANDOFF.md`, `sim/README.md` | état vérifié/non vérifié, section hacking |
| issue #46 | statut → Done à la clôture |

## Hors périmètre (→ suites)

- **PHASE 10** : CONTROL VECTOR réel, QTE, 4 variantes de rituel par type,
  `1 à 4 s de folie demo scene`, remplacement du bouton `[ JACK IN ]`.
- **PHASE 11** : entry state (drone déjà en vol). Indépendant du `hackType` —
  garanti par le tirage séparé.
- **PHASE 17** : TARGET LOG — le `hackType` persisté sur la session l'alimentera.
- Identité sonore par type de hack (Bible §16, ligne 1411).
- `resume` d'une session LANDED ne rejoue pas l'écran de hack (comme le TARGET
  SCAN) — le `hackType` est relu du disque pour le futur log, pas remis en scène.

## Plan d'implémentation

1. **`target-model.mjs`** : `HACK_TYPES`, `_hackType` en fin de boucle candidat,
   `resolveTarget`. Ré-générer les attentes de `target-selftest.mjs`.
2. **`target-selftest.mjs`** : checks déterminisme / indépendance / distribution
   / non-fuite. Vert.
3. **`session-model.mjs`** + son selftest : `sanitizeTarget` passthrough.
4. **`src/hack.js`** : `runHack`, log temporisé, `[ JACK IN ]`, boucle rAF, un
   `draw*` minimal par type (d'abord un placeholder commun, puis les 6 motifs).
5. **`src/style.css`** : `.hack-*`.
6. **`src/main.js`** : câblage dans `chooseScene`, hook `?hack=`.
7. **Motifs** : itérer les 6 `draw*` jusqu'à ce qu'ils soient distinguables au
   premier coup d'œil.
8. **Vérif navigateur** bout en bout + les 6 motifs.
9. **Revue de sûreté** : relire `git diff`, consigner dans HANDOFF.
10. **Docs** : HANDOFF, README, issue #46.

---

## Addendum 2026-08-29 — phase automatique progressive, couvre le chargement

Retour utilisateur après la première implémentation : la phase automatique
résolvait en ~600 ms et `[ JACK IN ]` apparaissait tout de suite. Voulu : le
joueur revient à sa chaise après l'acquisition du terrain, excité ; le piratage
le fait **attendre quelques secondes de plus**, la tension monte, `[ JACK IN ]`
apparaît, il tape (PHASE 10) et boum il vole.

### D — le hack couvre `boot()`

Aujourd'hui `chooseScene()` (dont `runHack`) **puis** `boot()` **puis** vol.
Désormais, branche session fraîche : dès la réponse du TARGET SCAN, on résout
`PROFILE` / `controller`, on appelle `setScene(slug)` et on lance **`boot()` en
tâche de fond, non attendu**. Sa promesse est passée à `runHack({ ready })`.
Le joueur regarde la phase automatique pendant que la carte charge derrière ;
au `[ JACK IN ]`, le vol est déjà prêt — le contrôle est immédiat.

- `runHack` n'arme `[ JACK IN ]` que quand **`ready` est résolu ET** la durée
  scriptée minimale est écoulée (~5 s, garantie même cache chaud).
- `ready` rejeté (échec de `boot`) → `runHack` démonte son écran et rejette →
  `.catch` externe → `hud.fail`.
- Chemins `?scene=` / `?family=` / `resume` : pas de `boot` de fond, `runHack`
  sans `ready` joue la séquence scriptée puis arme `[ JACK IN ]`.
- La barre `#loading` reste cachée derrière l'écran de hack — l'écran de hack
  EST l'écran d'attente. `boot()` appelle `hud.ready()` en fin de course, ce qui
  démarre déjà la boucle de rendu du vol **derrière** l'écran de hack ; le drone
  est au spawn, désarmé (l'entry state est PHASE 11).

### E — séquence progressive (`src/hack.js` + `tools/hack-model.mjs`)

`hackSequence(hackType)` (pur, dans `hack-model.mjs`) : une liste d'étapes
`{ label, verdict, dwellMs }`. Chaque étape affiche `LABEL ` puis des points qui
se remplissent pendant `dwellMs`, puis `verdict` claque.

- tête fixe : `AUTOMATED BYPASS … OK`
- 2 beats par famille — **vocabulaire de la grammaire visuelle uniquement**,
  aucune revendication de protocole, aucune procédure :
  - COMMAND INJECTION : `PACKET WINDOW` / `SEQUENCE ALIGNED`
  - LINK HIJACK : `CARRIER LOCK` / `TIMING SYNC`
  - TELEMETRY SPOOF : `STREAM CAPTURE` / `TRACE SHAPED`
  - GNSS SPOOF : `SOLUTION FORCED` / `POSITION HELD`
  - NETWORK TAKEOVER : `ROUTE MAPPED` / `NODES HELD`
  - FIRMWARE OVERRIDE : `REGION MAPPED` / `IMAGE STAGED`
- queue fixe : `CONTROL CHANNEL … READY`
- puis état d'attente (`…` qui pulse, motif en « recherche ») jusqu'à `ready`
- puis **culmination du motif** (~600 ms) + `MANUAL OVERRIDE REQUIRED` + `[ JACK IN ]`

### F — contrat des motifs

`draw(el, { t, seed, lock = 0 })` — `lock` va de 0 (recherche) à 1 (verrouillé).
Chaque `draw*` gagne une petite culmination (marqueur qui se fige, front qui
atteint tous les nœuds, réticule qui revient à l'origine, trace qui se calme,
paquets qui s'alignent, dump qui se stabilise). Déterministe : `lock` est un
nombre, aucune source d'aléa.

### G — sûreté

Les nouveaux `label`/`verdict` sont du vocabulaire d'ambiance, testés contre une
liste blanche de tokens dans `hack-selftest.mjs`. Aucune étape ne décrit une
opération réelle. Revue `git diff` re-passée.
