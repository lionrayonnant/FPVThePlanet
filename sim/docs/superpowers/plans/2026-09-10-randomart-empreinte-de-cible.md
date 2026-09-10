# Randomart, empreinte de la cible — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le randomart cesse d'être la signature d'une session pour devenir l'empreinte d'une CIBLE, et se montre à trois moments — le fou qui marche après `[ JACK IN ]`, l'art figé au crash, l'art de la cible dans les archives.

**Architecture:** `tools/randomart.mjs` perd `node:crypto` et s'ouvre en trois fonctions (`randomartWalk` / `randomartFrame` / `randomart`), ce qui le rend bundlable par Vite et permet d'animer la marche du fou sans écrire une seconde implémentation. Les trois points d'affichage se branchent sur des mécanismes qui existent déjà : le jeton de ligne `PORTRAIT_LINE` au crash, `sessionDetail()` dans les archives, la boucle `requestAnimationFrame` de l'écran de hack.

**Tech Stack:** JavaScript ESM pur, aucun paquet ajouté. Selftests `node:assert/strict` + `tools/lib/fake-dom.mjs`. Vite bundle `tools/*.mjs` pour le client.

**Spec:** `sim/docs/superpowers/specs/2026-09-10-randomart-empreinte-de-cible-design.md`

## Global Constraints

- Issue GitHub : **#57** sur `lionrayonnant/FPVThePlanet` (PAS l'ancien dépôt `FPVTP`, où #57 est une autre issue). Worktree `../fpvtp-randomart`, branche `randomart-empreinte-de-cible`.
- **Tout le code et les commentaires en anglais** sauf là où le fichier touché est déjà commenté en français : on suit le fichier, on ne le convertit pas. `randomart.mjs`, `hack.js`, `flight-end.js` et `fpvtp-osd.js` sont commentés en français ; `session-log-model.mjs` mélange les deux, dans ce cas écrire en anglais.
- `tools/randomart.mjs`, `tools/session-log-model.mjs` et `src/*.js` ne doivent contenir **aucune importation `node:`** : ils sont bundlés par Vite.
- Dimensions du randomart, inchangées : plateau intérieur 17 × 9, sortie 11 lignes de 19 caractères.
- **`npm run selftest:ci` se lance UNE fois, à la toute fin (Task 5), avant le push.** Chaque tâche ne lance que le selftest du module qu'elle touche — quelques secondes contre plusieurs minutes.
- Pas d'ESLint/Prettier : tabulations pour l'indentation, comme le reste du dépôt.
- Aucune valeur de PID/gain n'est touchée par ce travail.

## Structure des fichiers

| Fichier | Rôle après ce travail |
|---|---|
| `sim/tools/randomart.mjs` *(modifié)* | Feuille pure et sans dépendance : le digest, la marche du fou, le rendu d'une image partielle ou complète. |
| `sim/tools/randomart-selftest.mjs` *(créé)* | Le selftest du module seul : déterminisme, dimensions, continuité marche → image finale, absence d'importation `node:`. |
| `sim/tools/session-model.mjs` *(modifié)* | `openSession()` cesse de graver un randomart de session. |
| `sim/tools/session-log-model.mjs` *(modifié)* | `sessionDetail()` rend l'empreinte de la cible, reconstruite depuis `target.scan`. |
| `sim/src/flight-end.js` *(modifié)* | Exporte `RANDOMART_LINE` et le pose sur les trois tables. |
| `sim/src/fpvtp-osd.js` *(modifié)* | Substitue le jeton par le `<pre>` de l'empreinte, à côté du portrait. |
| `sim/src/hack.js` *(modifié)* | Phase `acquired` : le fou marche, `CONTROL ACQUIRED`, puis la promesse se résout. |
| `sim/src/style.css` *(modifié)* | Le couple portrait + empreinte de l'écran de fin, le `<pre>` de l'acquisition. |
| `sim/package.json` *(modifié)* | `selftest:operator` gagne `randomart-selftest.mjs` **et** `hack-render-selftest.mjs`, aujourd'hui orphelin. |

---

### Task 1 : le module pur

**Files:**
- Modify: `sim/tools/randomart.mjs` (réécriture complète, 67 lignes)
- Create: `sim/tools/randomart-selftest.mjs`
- Modify: `sim/tools/session-selftest.mjs:511-524` (le test randomart déménage)
- Modify: `sim/package.json` (script `selftest:operator`)

**Interfaces:**
- Consomme : rien.
- Produit :
  - `randomartWalk(seed) -> { steps: Int16Array, start: number, end: number, width: 17, height: 9 }` — `steps[i]` est l'index de case (`row * 17 + col`) visité au pas `i`, 128 pas.
  - `randomartFrame(walk, n, { title = 'FPV 06', tag = '' }) -> string` — l'art après `n` pas, 11 lignes séparées par `\n`.
  - `randomart(seed, { title, tag }) -> string` — inchangé, l'art complet.
  - `RANDOMART_DIMS = { WIDTH: 17, HEIGHT: 9, LINES: 11 }` — inchangé.

- [ ] **Step 1 : écrire le selftest qui échoue**

Créer `sim/tools/randomart-selftest.mjs` :

```js
// Selftest du randomart (issue #57). Le module est une FEUILLE : aucune
// dépendance, aucun `node:` — c'est ce qui lui permet d'être importé aussi
// bien par le serveur que par le client bundlé par Vite.
// Lancer : node tools/randomart-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomart, randomartWalk, randomartFrame, RANDOMART_DIMS } from './randomart.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('déterministe : deux appels sur la même graine rendent la même image', () => {
	const a = randomart('tokyo::3', { title: 'TGT 042', tag: 'ke::3' });
	const b = randomart('tokyo::3', { title: 'TGT 042', tag: 'ke::3' });
	assert.equal(a, b);
});

t('deux exemplaires voisins d\'un même scan rendent des images différentes', () => {
	assert.notEqual(randomart('tokyo::0'), randomart('tokyo::1'));
});

t('dimensions et cadre', () => {
	const lines = randomart('tokyo::3', { title: 'TGT 042', tag: 'a1b2' }).split('\n');
	assert.equal(lines.length, RANDOMART_DIMS.LINES);
	assert.ok(lines.every((l) => l.length === RANDOMART_DIMS.WIDTH + 2));
	assert.ok(lines[0].includes('[TGT 042]'));
	assert.ok(lines[lines.length - 1].includes('a1b2'));
});

t('S et E sont posés sur l\'image complète', () => {
	const a = randomart('tokyo::3');
	assert.ok(a.includes('S'));
	assert.ok(a.includes('E'));
});

// La propriété qui rend l'animation gratuite : jouer la marche jusqu'au bout
// donne EXACTEMENT l'image que rend randomart().
t('continuité : la dernière image de la marche est l\'image complète', () => {
	const walk = randomartWalk('tokyo::3');
	const opts = { title: 'TGT 042', tag: 'a1b2' };
	assert.equal(randomartFrame(walk, walk.steps.length, opts), randomart('tokyo::3', opts));
});

t('la marche a 128 pas et son dernier pas est `end`', () => {
	const walk = randomartWalk('tokyo::3');
	assert.equal(walk.steps.length, 128);
	assert.equal(walk.end, walk.steps[walk.steps.length - 1]);
});

t('au pas 0 : le fou est au départ, S seul, aucun E', () => {
	const walk = randomartWalk('tokyo::3');
	const first = randomartFrame(walk, 0);
	assert.equal((first.match(/S/g) ?? []).length, 1);
	assert.equal(first.includes('E'), false, 'E est sous S au pas 0');
});

// Le fou EST le curseur : E se déplace pendant la marche.
t('pendant la marche, E est la case du dernier pas', () => {
	const walk = randomartWalk('tokyo::3');
	const at = (n) => {
		const rows = randomartFrame(walk, n).split('\n').slice(1, -1);
		for (let y = 0; y < rows.length; y++) {
			const x = rows[y].indexOf('E');
			if (x > 0) return (x - 1) + y * RANDOMART_DIMS.WIDTH;
		}
		return null;
	};
	assert.equal(at(40), walk.steps[39]);
	assert.equal(at(90), walk.steps[89]);
});

t('n hors bornes est ramené dans les bornes, sans lever', () => {
	const walk = randomartWalk('tokyo::3');
	assert.equal(randomartFrame(walk, -5), randomartFrame(walk, 0));
	assert.equal(randomartFrame(walk, 9999), randomartFrame(walk, walk.steps.length));
});

t('pureté : le module n\'importe rien de `node:`', () => {
	const src = readFileSync(new URL('./randomart.mjs', import.meta.url), 'utf8');
	assert.equal(/from\s+['"]node:/.test(src), false, 'importation node: interdite');
	assert.equal(/^import\s/m.test(src), false, 'le module doit rester une feuille sans dépendance');
});

console.log(`\n${n} tests OK — randomart`);
```

- [ ] **Step 2 : lancer le selftest, vérifier qu'il échoue**

```bash
cd sim && node tools/randomart-selftest.mjs
```

Attendu : ÉCHEC — `randomartWalk` / `randomartFrame` ne sont pas exportés (`SyntaxError: The requested module './randomart.mjs' does not provide an export named 'randomartWalk'`).

- [ ] **Step 3 : réécrire `sim/tools/randomart.mjs`**

Remplacer l'INTÉGRALITÉ du fichier par :

```js
// Randomart du fou ivre, déterministe sur une graine.
//
// Même algorithme que `ssh-keygen -lv` (RFC-rien, mais folklore stable) : un
// fou ivre part du centre d'un plateau 17×9, chaque paire de bits de la graine
// le pousse en diagonale, on compte les passages, on rend la carte de densité.
//
// Depuis l'issue #57 : la graine est le `buildSeed` d'un EXEMPLAIRE, pas un id
// de session. Une cible = une empreinte, la même à chaque fois qu'on la
// retrouve.
//
// Le module est une FEUILLE, sans aucune importation : c'est ce qui lui permet
// d'être appelé par le serveur (tools/session-model.mjs) comme par le client
// bundlé par Vite (src/hack.js, src/fpvtp-osd.js, tools/session-log-model.mjs,
// qui s'interdit tout `node:`). C'est aussi pourquoi `node:crypto` a disparu.

const WIDTH = 17;
const HEIGHT = 9;
const DIGEST_BYTES = 32;   // autant que le SHA-256 qu'on remplace : 128 pas
const STEPS_PER_BYTE = 4;  // 4 pas par octet, 2 bits chacun
// ' ' vide, puis densité croissante ; 'S' départ, 'E' arrivée (posés en dernier).
const SYMBOLS = [' ', '.', 'o', '+', '=', '*', 'B', 'O', 'X', '@', '%', '&', '#', '/', '^'];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift. Recopié plutôt
// qu'importé, exactement comme tools/target-camera.mjs, tools/target-model.mjs
// et src/link.js le font déjà de tools/target-build.mjs : l'importer traînerait
// PROFILES et drone-profiles.js dans le chemin du serveur pour six lignes, et
// coûterait à ce module la seule propriété qui compte ici — n'avoir aucune
// dépendance.
function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

// 32 octets tirés du flux, un par appel. Remplace le digest SHA-256 : la sortie
// n'a aucune propriété cryptographique et n'en a jamais eu besoin — ce qu'on
// demande à ces octets, c'est d'être stables et bien répartis.
function digest(seed) {
	const rand = rngFrom(`${seed}::randomart`);
	const out = new Uint8Array(DIGEST_BYTES);
	for (let i = 0; i < DIGEST_BYTES; i++) out[i] = (rand() * 256) & 0xff;
	return out;
}

// La marche, séparée du rendu (issue #57) : c'est ce qui permet d'ANIMER le
// tracé sans écrire une seconde implémentation. `steps[i]` est l'index de case
// visité au pas `i`.
export function randomartWalk(seed) {
	const bytes = digest(seed);
	const steps = new Int16Array(bytes.length * STEPS_PER_BYTE);
	let x = (WIDTH - 1) >> 1;
	let y = (HEIGHT - 1) >> 1;
	const start = y * WIDTH + x;
	let k = 0;
	for (const byte of bytes) {
		// 4 pas par octet, bit de poids faible d'abord.
		for (let s = 0; s < 8; s += 2) {
			const move = (byte >> s) & 3;
			x += (move & 1) ? 1 : -1;
			y += (move & 2) ? 1 : -1;
			if (x < 0) x = 0; else if (x >= WIDTH) x = WIDTH - 1;
			if (y < 0) y = 0; else if (y >= HEIGHT) y = HEIGHT - 1;
			steps[k++] = y * WIDTH + x;
		}
	}
	return { steps, start, end: steps[steps.length - 1], width: WIDTH, height: HEIGHT };
}

// L'image après `n` pas. `E` est posé sur la case du DERNIER pas joué, pas sur
// l'arrivée : pendant la marche, le fou est donc son propre curseur, sans une
// ligne de plus. À n = steps.length, les deux coïncident et l'image est celle
// que rend randomart().
export function randomartFrame(walk, n, { title = 'FPV 06', tag = '' } = {}) {
	const played = Math.max(0, Math.min(Math.round(n), walk.steps.length));
	const counts = new Int16Array(WIDTH * HEIGHT);
	for (let i = 0; i < played; i++) {
		const j = walk.steps[i];
		if (counts[j] < SYMBOLS.length - 1) counts[j]++;
	}
	const end = played === 0 ? walk.start : walk.steps[played - 1];

	const rows = [];
	for (let row = 0; row < HEIGHT; row++) {
		let line = '';
		for (let col = 0; col < WIDTH; col++) {
			const i = row * WIDTH + col;
			line += i === walk.start ? 'S' : i === end ? 'E' : SYMBOLS[counts[i]];
		}
		rows.push(`|${line}|`);
	}

	const t4 = String(tag).slice(-4);
	return [border(title), ...rows, border(t4)].join('\n');
}

export function randomart(seed, opts = {}) {
	const walk = randomartWalk(seed);
	return randomartFrame(walk, walk.steps.length, opts);
}

// `+--[ FPV 06 ]---+` centré sur WIDTH colonnes intérieures.
function border(label) {
	const inner = WIDTH;
	if (!label) return `+${'-'.repeat(inner)}+`;
	const text = `[${label}]`;
	if (text.length >= inner) return `+${text.slice(0, inner)}+`;
	const left = (inner - text.length) >> 1;
	const right = inner - text.length - left;
	return `+${'-'.repeat(left)}${text}${'-'.repeat(right)}+`;
}

export const RANDOMART_DIMS = { WIDTH, HEIGHT, LINES: HEIGHT + 2 };
```

- [ ] **Step 4 : lancer le selftest, vérifier qu'il passe**

```bash
cd sim && node tools/randomart-selftest.mjs
```

Attendu : `10 tests OK — randomart`.

- [ ] **Step 5 : déménager le test randomart de `session-selftest.mjs`**

Le module a maintenant son propre selftest ; `session-selftest.mjs` ne doit plus
le tester en double. Supprimer le bloc `sim/tools/session-selftest.mjs:511-524` :

```js
// ---------------------------------------------------------------------------
// randomart

t('randomart : déterministe, dimensions et cadre corrects', () => {
	...
});
```

…et l'importation devenue inutile en tête de fichier (`sim/tools/session-selftest.mjs:15`) :

```js
import { randomart, RANDOMART_DIMS } from './randomart.mjs';
```

- [ ] **Step 6 : brancher le selftest sur la chaîne**

Dans `sim/package.json`, script `selftest:operator`, insérer `node tools/randomart-selftest.mjs && ` juste **avant** `node tools/session-selftest.mjs`.

Ajouter au même endroit, juste après `node tools/hack-selftest.mjs && `, l'entrée manquante :

```
node tools/hack-render-selftest.mjs &&
```

`tools/hack-render-selftest.mjs` existe depuis #33 mais **aucun script ne l'appelle** — la CI ne l'a jamais lancé. La Task 4 s'appuie dessus ; c'est le moment de réparer ça.

- [ ] **Step 7 : vérifier les deux selftests touchés**

```bash
cd sim && node tools/randomart-selftest.mjs && node tools/session-selftest.mjs && node tools/hack-render-selftest.mjs
```

Attendu : les trois passent. (`session-selftest.mjs` ne doit plus mentionner randomart ; `hack-render-selftest.mjs` doit passer tel quel, il n'a pas encore été touché.)

- [ ] **Step 8 : commit**

```bash
git add sim/tools/randomart.mjs sim/tools/randomart-selftest.mjs sim/tools/session-selftest.mjs sim/package.json
git commit -m "Le randomart devient une feuille pure et sa marche s'ouvre (#57)"
```

---

### Task 2 : les archives

**Files:**
- Modify: `sim/tools/session-log-model.mjs:142-156` (`sessionDetail`)
- Modify: `sim/tools/session-model.mjs:13` et `:183` (`openSession`)
- Modify: `sim/tools/session-log-selftest.mjs`

**Interfaces:**
- Consomme : `randomart(seed, { title, tag })` de la Task 1.
- Produit : `sessionDetail(s)` rend un bloc `RANDOMART` graîné sur la cible ; les sessions neuves n'ont plus de champ `randomart`.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à la fin de `sim/tools/session-log-selftest.mjs`, avant la ligne de total :

```js
// ---------------------------------------------------------------------------
// RANDOMART : l'empreinte de la CIBLE, pas celle de la session (issue #57).

const withTarget = (over = {}) => ({
	id: 'tokyo-0001', seq: 1, area: 'tokyo', result: 'CRASHED',
	start: '2026-09-10T10:00:00.000Z', flightTelemetry: {}, photos: [],
	targetSeq: 42,
	target: {
		family: 'freestyle5', signal: { rssiDbm: -60, mode: 'ANALOG' }, intel: {},
		scan: { seed: 'abc123', count: 5, index: 3, swarmAt: null, swarmChance: 0.1 },
	},
	...over,
});

t('#57 : le détail grave l\'empreinte de la cible', () => {
	const out = sessionDetail(withTarget());
	assert.ok(out.includes('RANDOMART'));
	assert.ok(out.includes(randomart('abc123::3', { title: 'TGT 042', tag: 'abc123::3' })));
});

t('#57 : deux sessions sur le MÊME exemplaire rendent la même empreinte', () => {
	const a = sessionDetail(withTarget({ id: 'tokyo-0001', seq: 1 }));
	const b = sessionDetail(withTarget({ id: 'tokyo-0009', seq: 9 }));
	const art = randomart('abc123::3', { title: 'TGT 042', tag: 'abc123::3' });
	assert.ok(a.includes(art) && b.includes(art));
});

t('#57 : deux exemplaires différents rendent des empreintes différentes', () => {
	// Comparé à titre ÉGAL : sans ça le test passerait pour la mauvaise raison
	// (un titre `FPV 06` par défaut ne se trouve évidemment pas dans une fiche
	// titrée `TGT 042`), et ne dirait rien de la graine.
	const other = withTarget();
	other.target = { ...other.target, scan: { ...other.target.scan, index: 4 } };
	const artOf = (i) => randomart(`abc123::${i}`, { title: 'TGT 042', tag: `abc123::${i}` });
	assert.ok(sessionDetail(withTarget()).includes(artOf(3)));
	assert.equal(sessionDetail(withTarget()).includes(artOf(4)), false);
	assert.ok(sessionDetail(other).includes(artOf(4)));
});

t('#57 : une session d\'avant, sans cible, garde son randomart écrit', () => {
	const old = withTarget({ target: null, targetSeq: null, randomart: '+--[OLD]--+' });
	const out = sessionDetail(old);
	assert.ok(out.includes('RANDOMART'));
	assert.ok(out.includes('+--[OLD]--+'));
});

t('#57 : sans cible ni randomart écrit, aucun bloc RANDOMART', () => {
	const bare = withTarget({ target: null, targetSeq: null });
	assert.equal(sessionDetail(bare).includes('RANDOMART'), false);
});
```

…et l'importation en tête du fichier :

```js
import { randomart } from './randomart.mjs';
```

- [ ] **Step 2 : lancer, vérifier l'échec**

```bash
cd sim && node tools/session-log-selftest.mjs
```

Attendu : ÉCHEC sur `#57 : le détail grave l'empreinte de la cible` — `sessionDetail` rend encore `s.randomart` (absent ici), donc pas de bloc `RANDOMART`.

- [ ] **Step 3 : implémenter dans `session-log-model.mjs`**

Ajouter l'importation en tête de fichier, sous celle de `./lib/weather.mjs` :

```js
import { randomart } from './randomart.mjs';
```

Ajouter la fonction juste au-dessus de `sessionDetail` :

```js
// L'empreinte de la CIBLE (issue #57). La graine est le `buildSeed` de
// l'exemplaire, que `sanitizeTarget` ne stocke PAS : il stocke `scan { seed,
// index }` précisément pour qu'on le reconstruise « sans le stocker deux fois »
// (commentaire de resolveTarget). Aucune migration, donc : les sessions déjà
// écrites contiennent déjà de quoi dessiner leur cible.
//
// Repli sur `s.randomart` : une session d'avant #57 — ou une session ouverte
// sans TARGET SCAN, qui n'a pas de cible du tout — garde l'art qu'elle a
// toujours affiché. On ne réécrit aucune archive.
function randomartBlock(s) {
	const scan = s?.target?.scan;
	if (scan?.seed != null && Number.isInteger(scan.index)) {
		const seed = `${scan.seed}::${scan.index}`;
		const title = s?.targetSeq ? `TGT ${pad(s.targetSeq, 3)}` : 'TGT ??';
		return ['RANDOMART', randomart(seed, { title, tag: seed })];
	}
	return s?.randomart ? ['RANDOMART', s.randomart] : null;
}
```

Puis, dans `sessionDetail`, remplacer la ligne :

```js
		s?.randomart ? ['RANDOMART', s.randomart] : null,
```

par :

```js
		randomartBlock(s),
```

- [ ] **Step 4 : implémenter dans `session-model.mjs`**

Supprimer la ligne `sim/tools/session-model.mjs:183` :

```js
		randomart: randomart(id, { tag: id.slice(-4) }),
```

…et l'importation `sim/tools/session-model.mjs:13` :

```js
import { randomart } from './randomart.mjs';
```

`validateSession` n'exige pas ce champ : il n'y a rien d'autre à toucher.

- [ ] **Step 5 : lancer, vérifier que ça passe**

```bash
cd sim && node tools/session-log-selftest.mjs && node tools/session-selftest.mjs
```

Attendu : les deux passent. `session-selftest.mjs` couvre `openSession` — si une assertion y attend encore un champ `randomart`, la supprimer (c'est le comportement voulu, pas une régression).

- [ ] **Step 6 : commit**

```bash
git add sim/tools/session-log-model.mjs sim/tools/session-model.mjs sim/tools/session-log-selftest.mjs sim/tools/session-selftest.mjs
git commit -m "Les archives lisent l'empreinte de la cible, plus celle de la session (#57)"
```

---

### Task 3 : le crash

**Files:**
- Modify: `sim/src/flight-end.js` (export `RANDOMART_LINE`, les trois tables)
- Modify: `sim/src/fpvtp-osd.js:157-175` et `:307-322`
- Modify: `sim/src/style.css:280-297`
- Modify: `sim/tools/flight-end-selftest.mjs`

**Interfaces:**
- Consomme : `randomart(seed, { title, tag })` de la Task 1 ; `this._target.buildSeed`, déjà posé par `fpvtpOsd.setTarget()` (`src/main.js:3489`).
- Produit : `RANDOMART_LINE` exporté par `src/flight-end.js`, présent sur `TIMELINE`, `FENCE_TIMELINE` et `CUT_TIMELINE`.

**Note :** aucun nouveau branchement n'est nécessaire. `setTarget({ family, buildSeed, cameraSeed })` porte déjà la graine jusqu'à l'OSD — c'est de là que le portrait se dessine.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à `sim/tools/flight-end-selftest.mjs`, avant la ligne de total, et étendre l'importation en tête avec `RANDOMART_LINE` :

```js
// ---------------------------------------------------------------------------
// L'empreinte de la machine perdue (issue #57).

t('#57 : le jeton d\'empreinte est sur les trois tables, avec le portrait', () => {
	for (const table of [TIMELINE, FENCE_TIMELINE, CUT_TIMELINE]) {
		const art = table.lines.find(([, text]) => text === RANDOMART_LINE);
		const portrait = table.lines.find(([, text]) => text === PORTRAIT_LINE);
		assert.ok(art, 'aucune ligne d\'empreinte');
		assert.equal(art[0], portrait[0], 'l\'empreinte doit tomber avec le portrait');
	}
});

t('#57 : la sortie ne recule sur aucune des trois tables', () => {
	assert.equal(TIMELINE.exitAt, 4.6);
	assert.equal(FENCE_TIMELINE.exitAt, 3.0);
	assert.equal(CUT_TIMELINE.exitAt, 3.0);
});

t('#57 : après un crash, l\'empreinte est écrite avec le portrait', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, 4.2);
	assert.ok(fe.out.lines.includes(RANDOMART_LINE));
	assert.ok(fe.out.lines.includes(PORTRAIT_LINE));
});
```

- [ ] **Step 2 : lancer, vérifier l'échec**

```bash
cd sim && node tools/flight-end-selftest.mjs
```

Attendu : ÉCHEC à l'importation — `does not provide an export named 'RANDOMART_LINE'`.

- [ ] **Step 3 : implémenter dans `src/flight-end.js`**

Sous la définition de `PORTRAIT_LINE`, ajouter :

```js
// Le jeton de l'empreinte (#57). Même mécanique que PORTRAIT_LINE : ce module
// ne connaît que du texte, c'est src/fpvtp-osd.js qui remplace le jeton par
// l'art de la machine perdue. Il tombe TOUJOURS avec le portrait — une machine
// perdue est perdue de la même façon, quelle que soit la fin.
export const RANDOMART_LINE = '[RANDOMART]';
```

Puis, dans les trois tables, ajouter la ligne juste après celle du portrait, au MÊME horodatage :

- `TIMELINE.lines` : `[4.0, RANDOMART_LINE],` après `[4.0, PORTRAIT_LINE],`
- `FENCE_TIMELINE.lines` : `[2.4, RANDOMART_LINE],` après `[2.4, PORTRAIT_LINE],`
- `CUT_TIMELINE.lines` : `[2.4, RANDOMART_LINE],` après `[2.4, PORTRAIT_LINE],`

Ne toucher à aucun `exitAt`.

- [ ] **Step 4 : lancer, vérifier que ça passe**

```bash
cd sim && node tools/flight-end-selftest.mjs
```

Attendu : tous les tests passent.

- [ ] **Step 5 : rendre l'empreinte dans `src/fpvtp-osd.js`**

Étendre l'importation en tête (`src/fpvtp-osd.js:8`) :

```js
import { PORTRAIT_LINE, RANDOMART_LINE } from './flight-end.js';
import { randomart } from '../tools/randomart.mjs';
```

À côté de `_portraitNode()` / `_dropPortrait()`, ajouter :

```js
	// L'empreinte de la machine perdue (#57). Fabriquée une seule fois, comme
	// le portrait : la séquence de fin reconstruit ses lignes à chaque ligne
	// qui apparaît. Sans exemplaire connu, la ligne retombe sur un blanc —
	// jamais sur son jeton, qui n'est pas fait pour être lu.
	//
	// Le titre est `TGT ??` et non un numéro : `targetSeq` est attribué par le
	// serveur et le client ne le connaît pas ici. Le numéro est ce que
	// l'archive sait, pas ce que l'opérateur sait en vol.
	_randomartNode() {
		if (!this._randomart && this._target?.buildSeed) {
			const pre = document.createElement('pre');
			pre.className = 'flight-end-art';
			pre.setAttribute('aria-hidden', 'true');
			pre.textContent = randomart(this._target.buildSeed, {
				title: 'TGT ??', tag: this._target.buildSeed,
			});
			this._randomart = pre;
		}
		return this._randomart ?? null;
	}
```

Dans `setTarget()`, à côté de `this._dropPortrait();`, ajouter `this._randomart = null;`.
Dans le constructeur, à côté de `this._portrait = null;`, ajouter `this._randomart = null;`.
Dans `_dropPortrait()`, ajouter `this._randomart = null;`.

Dans `setFlightEnd()`, remplacer le corps du `map` par :

```js
			e.replaceChildren(...lines.map((text) => {
				// Ni le portrait ni l'empreinte ne sont du texte : ce sont deux
				// dessins de la machine. Faute d'exemplaire connu, la ligne
				// retombe sur un blanc — jamais sur son jeton, qui n'est pas
				// fait pour être lu.
				if (text === PORTRAIT_LINE) {
					const node = this._portraitNode();
					if (node) return node;
				}
				if (text === RANDOMART_LINE) {
					const node = this._randomartNode();
					if (node) return node;
				}
				const d = document.createElement('div');
				d.textContent = (text === PORTRAIT_LINE || text === RANDOMART_LINE) ? '' : text;
				return d;
			}));
```

- [ ] **Step 6 : le CSS, dans `sim/src/style.css`**

Sous le bloc `#flight-end div:empty { height: .6em; }`, ajouter :

```css
/* #57 — l'empreinte de la machine perdue, à CÔTÉ du portrait et non dessous :
   onze lignes d'ASCII empilées sous le dessin pousseraient [ESC] DISCONNECT
   hors de l'écran, et exitAt ne bouge pas. `order` suffit à les apparier :
   les deux jetons tombent au même horodatage, donc les deux nœuds arrivent
   côte à côte dans la colonne flex, et `flex-flow: row wrap` sur le parent
   n'est pas envisageable — il casserait les lignes de texte. On les sort donc
   du flux vertical en les collant l'un à l'autre. */
#flight-end .flight-end-art {
	margin: 0;
	font-family: var(--font-ascii);
	font-size: var(--fs-display-s);
	line-height: 1.05;
	letter-spacing: 0;          /* l'ASCII n'est pas de la DISPLAY tracked */
	text-transform: none;
	white-space: pre;
	color: var(--dim);
	opacity: .8;
}
/* Le couple portrait + empreinte. Sous 720 px l'empreinte repasse dessous :
   à cette largeur elle ne tient plus à côté du dessin. */
@media (min-width: 720px) {
	#flight-end .drone-viewer,
	#flight-end .drone-portrait { margin-right: 1.2em; }
	#flight-end .drone-viewer + .flight-end-art,
	#flight-end .drone-portrait + .flight-end-art {
		position: absolute;
		left: 50%; margin-left: 6em;
		top: 50%; transform: translateY(-50%);
	}
}
```

- [ ] **Step 7 : vérifier le rendu de l'OSD**

```bash
cd sim && node tools/flight-end-selftest.mjs && node tools/drone-portrait-render-selftest.mjs && node tools/memory-release-selftest.mjs
```

Attendu : les trois passent. `memory-release-selftest.mjs` est celui qui attrape un nœud retenu — c'est pour ça que `_randomart` est remis à `null` dans `_dropPortrait()`.

- [ ] **Step 8 : commit**

```bash
git add sim/src/flight-end.js sim/src/fpvtp-osd.js sim/src/style.css sim/tools/flight-end-selftest.mjs
git commit -m "Au crash, l'empreinte de la machine perdue à côté de son portrait (#57)"
```

---

### Task 4 : l'acquisition, le fou qui marche

**Files:**
- Modify: `sim/src/hack.js`
- Modify: `sim/src/main.js:3008` et `:3113` (passer `buildSeed`)
- Modify: `sim/src/style.css`
- Modify: `sim/tools/hack-render-selftest.mjs`

**Interfaces:**
- Consomme : `randomartWalk(seed)` et `randomartFrame(walk, n, opts)` de la Task 1 ; `reducedMotion()` de `src/motion.js`.
- Produit : `runHack(root, { hackType, family, ready, candidate, buildSeed })` — `buildSeed` est optionnel ; sans lui, la phase `acquired` est SAUTÉE et `[ JACK IN ]` résout comme aujourd'hui (c'est le cas des chemins d'aperçu `?hack=`).
- Produit : `globalThis.__hackTestFinish()` — crochet de test, vide la file de minuteurs et résout la phase `acquired` immédiatement.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à `sim/tools/hack-render-selftest.mjs`, avant la ligne de total :

```js
// ---------------------------------------------------------------------------
// L'acquisition : le fou marche APRÈS [ JACK IN ] (issue #57).

const openArmedWithSeed = async () => {
	reset();
	const p = runHack(dom.root, {
		hackType: 'GNSS SPOOF', family: 'freestyle5',
		ready: Promise.resolve(), buildSeed: 'abc123::3',
	});
	await tick();
	globalThis.__hackTestArm?.();
	await tick();
	return [p];
};

const artEl = () => dom.root.querySelectorAll('.hack-art')[0] ?? null;

await t('#57 : JACK IN ouvre la phase d\'acquisition au lieu de résoudre', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	assert.ok(artEl(), 'aucune empreinte à l\'écran');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 1, 'écran démonté trop tôt');
	globalThis.__hackTestFinish?.();
	await p;
});

await t('#57 : l\'empreinte atteint son image complète et CONTROL ACQUIRED tombe', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	globalThis.__hackTestFinish?.();
	await p;
	// __hackTestFinish pose l'image finale AVANT de démonter : on la lit sur le
	// nœud détaché, que la closure du test tient encore.
	assert.equal(lastArt, randomart('abc123::3', { title: 'TGT ??', tag: 'abc123::3' }));
	assert.ok(lastHandover.includes('CONTROL ACQUIRED'));
});

await t('#57 : Échap pendant l\'acquisition résout, il ne laisse personne dedans', async () => {
	const [p] = await openArmedWithSeed();
	jackIn().click();
	await tick();
	dom.key('Escape');
	const out = await p;
	assert.equal(out?.aborted, undefined, 'Échap ici saute le battement, il n\'annule rien');
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0, 'écran encore monté');
});

await t('#57 : sans buildSeed, JACK IN résout comme avant', async () => {
	const [p] = await openArmed();   // pas de buildSeed
	jackIn().click();
	await p;
	assert.equal(dom.root.querySelectorAll('.hack-head').length, 0);
});
```

Pour que les deux lectures d'après-démontage soient possibles, ajouter en haut du fichier, sous `const jackIn = ...` :

```js
// L'écran est démonté quand la promesse se résout : on retient la dernière
// image de l'empreinte et le dernier texte de reprise en main au moment où
// __hackTestFinish les pose.
let lastArt = '';
let lastHandover = '';
globalThis.__hackTestObserve = (art, handover) => { lastArt = art; lastHandover = handover; };
```

…et l'importation `import { randomart } from '../tools/randomart.mjs';` en tête.

`dom.key('Escape')` est le mécanisme qu'emploient déjà les tests `#33` du même fichier (`tools/hack-render-selftest.mjs:72` et `:87`) ; `tools/lib/fake-dom.mjs:287` l'expose.

- [ ] **Step 2 : lancer, vérifier l'échec**

```bash
cd sim && node tools/hack-render-selftest.mjs
```

Attendu : ÉCHEC sur `#57 : JACK IN ouvre la phase d'acquisition` — `artEl()` rend `null`, `[ JACK IN ]` démonte encore l'écran immédiatement.

- [ ] **Step 3 : implémenter la phase `acquired` dans `src/hack.js`**

Étendre les importations en tête :

```js
import { randomartWalk, randomartFrame } from '../tools/randomart.mjs';
import { reducedMotion } from './motion.js';
```

Ajouter les deux durées à côté des autres constantes du fichier, juste sous les importations :

```js
// Mise en scène, pas mesure (comme les tables de src/flight-end.js).
// L'empreinte se trace, puis on la regarde une demi-seconde avant que le flux
// vidéo prenne la main.
const ART_WALK_MS = 1000;
const ART_HOLD_MS = 700;
```

Changer la signature :

```js
export function runHack(root, { hackType, family, ready, candidate = null, buildSeed = null } = {}) {
```

Monter le `<pre>` de l'empreinte à côté des autres, après `gramEl` :

```js
	// L'empreinte de la cible (#57), vide jusqu'à l'acquisition.
	const artEl = document.createElement('pre');
	artEl.className = 'hack-art';
	artEl.setAttribute('aria-hidden', 'true');
	artEl.hidden = true;
	s.box.append(headEl, logEl, handoverEl, gramEl, artEl);
```

(remplacer la ligne `s.box.append(headEl, logEl, handoverEl, gramEl);` existante)

Étendre le commentaire de `phase` et ajouter l'état :

```js
		// phase : 'run' séquence en cours · 'hold' attente du chargement ·
		//         'lock' culmination du motif · 'armed' [ JACK IN ] disponible ·
		//         'acquired' l'empreinte se trace, le contrôle est pris (#57)
		let phase = 'run';
		let lockT0 = 0;
		let walk = null;
		let artT0 = 0;
```

Dans `paint()`, corriger la ligne de la reprise en main pour qu'elle couvre la
nouvelle phase — sans ça `CONTROL ACQUIRED` serait posé puis immédiatement
caché par la frame suivante :

```js
			handoverEl.hidden = !(phase === 'lock' || phase === 'armed' || phase === 'acquired');
```

Puis ajouter à la fin de `paint()`, avant l'accolade fermante :

```js
			// #57 : pendant 'acquired', le log et le motif se taisent, l'empreinte
			// se trace. `randomartFrame` pose E sur la case du dernier pas : le fou
			// est son propre curseur.
			if (phase === 'acquired') {
				const n = walk.steps.length * (reducedMotion() ? 1
					: clamp01((nowMs() - artT0) / ART_WALK_MS));
				artEl.textContent = randomartFrame(walk, n, { title: 'TGT ??', tag: buildSeed });
			}
```

Dans la boucle d'animation, cesser de dessiner le motif une fois le contrôle
pris — il est caché, le redessiner à 60 Hz ne sert à rien :

```js
		const loop = () => {
			if (done) return;
			if (phase !== 'acquired') draw(gramEl, { t: nowMs() / 1000, seed, lock: lockLevel() });
			paint();
			raf = requestAnimationFrame(loop);
		};
```

Remplacer `finish` par le couple suivant (le bouton continue d'appeler `finish`) :

```js
		// #57 — le battement d'acquisition. `[ JACK IN ]` est le GESTE ;
		// `CONTROL ACQUIRED` est son RÉSULTAT, et il vient après. Le motif de la
		// famille cède la place à l'empreinte de la machine, qui se trace, puis
		// le flux vidéo prend la main.
		//
		// Sans `buildSeed` — les chemins d'aperçu `?hack=` — il n'y a pas de
		// machine à graver : on résout directement, comme avant #57.
		const finish = () => {
			if (done) return;
			if (!buildSeed) { handOver(); return; }
			phase = 'acquired';
			artT0 = nowMs();
			walk = randomartWalk(buildSeed);
			artEl.hidden = false;
			gramEl.hidden = true;
			handoverEl.textContent = 'CONTROL ACQUIRED';
			paint();
			after(reducedMotion() ? ART_HOLD_MS : ART_WALK_MS + ART_HOLD_MS, handOver);
		};

		// La sortie de la phase, et le seul point qui résout. Appelé par le
		// minuteur, par Échap (qui SAUTE le battement — le contrôle est pris, on
		// ne revient pas au scan) et par le crochet de test.
		const handOver = () => {
			if (done) return;
			// L'empreinte est POSÉE dans son état final avant le démontage. Sauter
			// le battement — Échap, ou le crochet de test — ne doit pas laisser une
			// image à moitié tracée comme dernière chose à l'écran.
			if (phase === 'acquired') {
				artEl.textContent = randomartFrame(walk, walk.steps.length, { title: 'TGT ??', tag: buildSeed });
			}
			globalThis.__hackTestObserve?.(artEl.textContent, handoverEl.textContent);
			teardown();
			resolve();
		};
```

Dans `abort()`, ajouter la garde qui distingue les deux Échap :

```js
		const abort = () => {
			if (done) return;
			// #57 : une fois le contrôle pris, Échap ne renvoie plus au scan — il
			// saute le battement. Le geste est fait, il n'y a rien à annuler.
			if (phase === 'acquired') { handOver(); return; }
			teardown();
			resolve({ aborted: true });
		};
```

Ajouter le crochet de test à côté de `__hackTestArm`, et l'effacer dans `teardown()` :

```js
		globalThis.__hackTestFinish = () => { timers.forEach(clearTimeout); timers.clear(); handOver(); };
```

Dans `teardown()`, sous `delete globalThis.__hackTestArm;` :

```js
			delete globalThis.__hackTestFinish;
```

Note : `handOver` est déclaré par `const` APRÈS `finish` mais n'est appelé qu'au clic — la zone morte temporelle est déjà passée. Même schéma que `finish`/`teardown` aujourd'hui.

- [ ] **Step 4 : passer `buildSeed` depuis `src/main.js`**

Aux deux appels de vol réel — `src/main.js:3008` et `src/main.js:3113` — ajouter le champ. Les deux ont déjà `const buildSeed = ...` quelques lignes plus haut :

```js
			const hack = await runHack(ui, { hackType: cand._hackType, family: cand._family, ready: booting, candidate: cand, buildSeed });
```

Ne PAS toucher les deux appels d'aperçu (`src/main.js:2800` et `:3034`) : sans `buildSeed`, la phase est sautée, ce qui est le comportement voulu pour `?hack=`.

- [ ] **Step 5 : le CSS**

Dans `sim/src/style.css`, sous le bloc `.hack .hack-handover`, ajouter :

```css
/* #57 — l'empreinte de la cible, à l'acquisition. Même grille pixel que la
   grammaire du hack qu'elle remplace : c'est de l'ASCII, pas de la DISPLAY,
   donc pas d'interlettrage. */
.hack .hack-art {
	margin: .8em 0 0;
	font-family: var(--font-ascii);
	font-size: var(--fs-display-s);
	line-height: 1.05;
	letter-spacing: 0;
	white-space: pre;
	color: var(--warm-white);
}
```

- [ ] **Step 6 : lancer, vérifier que ça passe**

```bash
cd sim && node tools/hack-render-selftest.mjs
```

Attendu : tous les tests passent, y compris ceux de #33 déjà présents. **Si l'ancien test `#33 : JACK IN résout le hack et démonte l'écran` échoue**, c'est attendu : il utilise `openArmed()` sans `buildSeed`, donc la phase est sautée et il doit continuer de passer tel quel. S'il échoue quand même, c'est un vrai bug de la garde `if (!buildSeed)` — le corriger, ne pas modifier le test.

- [ ] **Step 7 : commit**

```bash
git add sim/src/hack.js sim/src/main.js sim/src/style.css sim/tools/hack-render-selftest.mjs
git commit -m "Après JACK IN, le fou trace l'empreinte et CONTROL ACQUIRED tombe (#57)"
```

---

### Task 5 : docs, changelog, chaîne complète, PR

**Files:**
- Modify: `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md` (§26)
- Modify: `sim/HANDOFF.md`
- Modify: `CHANGELOG.md` (racine du dépôt)

- [ ] **Step 1 : resserrer la Bible §26**

Dans `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md`, remplacer le corps de la section `# 26. Randomart` par :

```markdown
# 26. Randomart

Le Randomart est inspiré du concept SSH.

Il est associé à la **cible** : une machine = une empreinte. La graine est
celle de l'exemplaire, celle-là même qui décide de sa famille, de sa livrée,
de son cadre et de ses PID. Retrouver la même machine, c'est retrouver le même
art.

Il apparaît :

- **à l'acquisition** : après `[ JACK IN ]`, le fou trace l'empreinte sous les
  yeux de l'opérateur, puis `CONTROL ACQUIRED` ;
- **au crash** : figé, à côté du portrait de la machine perdue ;
- **dans les archives** : dans la fiche de session, à la place du randomart de
  session, qui a disparu.

Il n'apparaît PAS sur le `TARGET SCAN` : avant le vol, on n'affiche que ce qui
est réellement connu (§15), et l'empreinte d'un exemplaire n'en fait pas
partie. On ne choisit pas un signal sur son art.

Le Randomart n'est pas seulement décoratif :

> **c'est l'empreinte visuelle de l'expérience.**

*(Révision 2026-09-10, issue #57 : la section décrivait un art « associé à la
session / cible » et laissait les deux lectures ouvertes. Elle est tranchée
sur la cible, et la liste des apparitions est celle qui est implémentée.)*
```

Corriger aussi la ligne `- Randomart ;` de la liste §28 (les champs d'une fiche
de session) si elle laisse entendre qu'il s'agit d'un art de session.

- [ ] **Step 2 : `sim/HANDOFF.md`**

Ajouter à la section des éléments vérifiés, dans le style des entrées voisines :

```markdown
- **#57 — le randomart est l'empreinte de la cible.** Graine = `buildSeed` de
  l'exemplaire. Trois moments : le fou trace après `[ JACK IN ]` (`src/hack.js`,
  phase `acquired`), art figé au crash à côté du portrait (jeton
  `RANDOMART_LINE`, les trois tables de `src/flight-end.js`), art de la cible
  dans `sessionDetail()`. `tools/randomart.mjs` est une feuille sans dépendance
  — `node:crypto` est parti, l'image d'une graine donnée a donc changé. Aucune
  archive n'a été réécrite : les sessions d'avant gardent leur champ
  `randomart`, lu en repli. *Non vérifié à la main : le rendu côte à côte
  portrait + empreinte sous 720 px de large.*
```

- [ ] **Step 3 : `CHANGELOG.md`**

Sous `## [Non publié]`, dans la sous-section `### Ajouté` (la créer si elle
n'existe pas) :

```markdown
- Le randomart devient l'empreinte de la cible : une machine, un art, le même à
  chaque fois qu'on la retrouve. Il se trace sous les yeux de l'opérateur après
  `[ JACK IN ]`, se fige au crash à côté du portrait de la machine perdue, et
  signe la fiche de session dans les archives (#57).
```

Et dans `### Modifié` :

```markdown
- Le randomart de session (un art différent par vol) est remplacé par celui de
  la cible. Les sessions déjà écrites gardent le leur (#57).
```

- [ ] **Step 4 : la chaîne complète, UNE fois**

```bash
cd sim && npm run selftest:ci
```

Attendu : la chaîne entière passe (~2 min). C'est le seul lancement de
`selftest:ci` de tout ce travail.

- [ ] **Step 5 : le build**

```bash
cd sim && npm run build
```

Attendu : succès. C'est ce qui prouve que `tools/randomart.mjs` est réellement
bundlable — un `node:crypto` résiduel se verrait ici.

- [ ] **Step 6 : commit et push**

```bash
git add sim/docs sim/HANDOFF.md CHANGELOG.md
git commit -m "Bible §26, HANDOFF et changelog : l'empreinte est celle de la cible (#57)"
git push -u origin randomart-empreinte-de-cible
```

- [ ] **Step 7 : ouvrir la PR**

```bash
gh pr create --repo lionrayonnant/FPVThePlanet \
  --title "Le randomart devient l'empreinte de la cible (#57)" \
  --body "$(cat <<'BODY'
Ferme #57.

Le randomart existait mais ne se montrait nulle part : le serveur en gravait un
par session, graîné sur `session.id`, visible seulement dans le texte d'une
fiche d'archive. Il devient l'empreinte de la CIBLE — une machine, un art — et
se montre à trois moments.

- **`tools/randomart.mjs`** perd `node:crypto` et devient une feuille sans
  dépendance, donc bundlable par Vite. Il s'ouvre en trois fonctions : la
  marche du fou est séparée du rendu, ce qui rend l'animation gratuite.
- **À l'acquisition** : `[ JACK IN ]` ouvre une phase `acquired`, le fou trace
  l'empreinte, `CONTROL ACQUIRED` tombe, le flux vidéo prend la main. Échap y
  saute le battement — personne ne reste derrière cet écran.
- **Au crash** : jeton `RANDOMART_LINE` au même horodatage que le portrait, sur
  les trois tables. `exitAt` ne bouge sur aucune.
- **Dans les archives** : `sessionDetail()` reconstruit la graine depuis
  `target.scan`, que `sanitizeTarget` stocke déjà pour ça. Aucune migration ;
  les sessions d'avant gardent leur champ `randomart`, lu en repli.

Au passage : `tools/hack-render-selftest.mjs` existait depuis #33 mais aucun
script ne l'appelait — il entre dans `selftest:operator`.

Spec : `sim/docs/superpowers/specs/2026-09-10-randomart-empreinte-de-cible-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 8 : passer l'issue en revue**

Ne PAS fermer #57 à la main : la PR le fait à la fusion. Vérifier seulement que
l'item du Project 2 est bien celui du dépôt `FPVThePlanet` (id
`PVTI_lAHOBlam-M4Bhk9azg6Rgkk`), pas celui de l'ancien `FPVTP`.

---

## Ce que ce plan ne fait pas

- Aucune empreinte sur le `TARGET SCAN` (Bible §15).
- Aucun randomart d'opérateur (Bible §32, « futur »).
- Aucune migration des sessions déjà sur disque.
- Aucune valeur de PID/gain touchée.
