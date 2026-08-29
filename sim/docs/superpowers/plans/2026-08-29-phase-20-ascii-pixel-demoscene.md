# PHASE 20 — ASCII / pixel art / demo scene — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** créer le langage graphique signature (issue #57, Bible §19/§38-41) : module ASCII (info / technique / spectacle), bibliothèque pixel art (9 icônes, favicon sans emoji), complément des primitives demo scene (color flash, déformation de texte, gros ASCII art) paramétrables en durée, avec coût CPU mesuré.

**Architecture :** trois petits modules purs côté `sim/src/` (Node-safe, testables sans DOM, comme `hack-grammars.js`) : `ascii.js` (tags, chaînes techniques, police banner), `pixel-icons.js` (bitmaps + SVG), et 3 nouvelles primitives dans `hack-grammars.js`. `ritual.js` transmet la durée de la variante aux primitives. Un bench mesure le coût par frame et échoue au-delà du budget. Rien de tout cela n'est importé par le moteur ni par le HUD (garde-fou testé).

**Tech stack :** JS vanilla ES modules, selftests `node:assert/strict` (motif existant `tools/*-selftest.mjs`).

**Spec :** issue GitHub #57 · `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md` §19, §38-41 · roadmap PHASE 20.

## Global Constraints

- Interface/textes du jeu : **anglais**. Commentaires code, commits, docs : **français**.
- ❌ pas d'emoji, ❌ pas d'icônes Material Design.
- Cyan/magenta/violet/bleu électrique réservés aux événements (déjà appliqué par `src/ritual.js`, ne pas étendre).
- « Une à quatre secondes de folie, puis retour au calme » — aucune primitive demo hors événement (testé, Task 4).
- Aucun élément de DA ne devient une dépendance du moteur physique ; `npm run selftest` reste vert.
- Branche `phase-20-impl` (worktree), commits fréquents.

**Fichiers touchés (vue d'ensemble) :**
- Create : `sim/src/ascii.js`, `sim/src/pixel-icons.js`, `sim/tools/ascii-selftest.mjs`, `sim/tools/pixel-icons-selftest.mjs`, `sim/tools/ritual-bench.mjs`
- Modify : `sim/src/hack-grammars.js`, `sim/src/ritual.js`, `sim/index.html`, `sim/package.json`, `sim/tools/ritual-selftest.mjs`, `sim/HANDOFF.md`

---

### Task 1 : `src/ascii.js` — le langage ASCII (info / technique / banner)

**Files:**
- Create: `sim/src/ascii.js`
- Test: `sim/tools/ascii-selftest.mjs`

**Interfaces:**
- Produces: `ASCII_TAGS` (`{ ok: '[+]', alert: '[!]', status: '[*]' }`), `asciiTag(kind, text) -> string`, `asciiChain(nodes: string[]) -> string`, `bigText(str) -> string[5]`, `BIG_FONT` (char → string[5], glyphes 3×5). Consommé par Task 3 (bannerBurst/textWarp) et par la PHASE 19 (passe sur les écrans, hors périmètre ici).

- [ ] **Step 1 : écrire le selftest (échoue d'abord)**

```js
// sim/tools/ascii-selftest.mjs
// Selftest du langage ASCII (PHASE 20, Bible §40). Aucune E/S, aucun DOM.
// Lancer : node tools/ascii-selftest.mjs
import assert from 'node:assert/strict';
import { ASCII_TAGS, asciiTag, asciiChain, bigText, BIG_FONT } from '../src/ascii.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('asciiTag : les trois usages information de la Bible §40', () => {
	assert.equal(asciiTag('ok', 'SIGNAL FOUND'), '[+] SIGNAL FOUND');
	assert.equal(asciiTag('alert', 'LINK LOST'), '[!] LINK LOST');
	assert.equal(asciiTag('status', 'TERRAIN READY'), '[*] TERRAIN READY');
});

t('asciiTag : kind inconnu → erreur (pas de tag silencieusement faux)', () => {
	assert.throws(() => asciiTag('info', 'X'));
});

t('asciiChain : exemple exact de la Bible §40', () => {
	assert.equal(asciiChain(['RX', 'FC', 'MOTOR']), 'RX ───┤ FC ├── MOTOR');
});

t('asciiChain : 2 nœuds et 4 nœuds restent lisibles', () => {
	assert.equal(asciiChain(['RX', 'FC']), 'RX ── FC');
	assert.equal(asciiChain(['RX', 'FC', 'ESC', 'MOTOR']), 'RX ───┤ FC ├───┤ ESC ├── MOTOR');
});

t('bigText : 5 lignes de même largeur, uniquement # et espace', () => {
	const rows = bigText('JACK IN');
	assert.equal(rows.length, 5);
	for (const r of rows) {
		assert.equal(r.length, rows[0].length);
		assert.match(r, /^[# ]*$/);
	}
});

t('BIG_FONT : chaque glyphe fait 5 lignes de 3 colonnes', () => {
	for (const [ch, glyph] of Object.entries(BIG_FONT)) {
		assert.equal(glyph.length, 5, `glyphe ${ch}`);
		for (const row of glyph) assert.equal(row.length, 3, `glyphe ${ch}`);
	}
});

t('BIG_FONT : couvre A-Z, espace, ! et -', () => {
	for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ !-') {
		assert.ok(BIG_FONT[ch], `manque ${JSON.stringify(ch)}`);
	}
});

console.log(`\n${n} tests ascii OK`);
```

- [ ] **Step 2 : vérifier l'échec**

Run: `cd sim && node tools/ascii-selftest.mjs`
Expected: FAIL (module `../src/ascii.js` introuvable)

- [ ] **Step 3 : implémenter `src/ascii.js`**

```js
// Langage ASCII signature (PHASE 20, Bible §40). Trois usages :
//   information  → asciiTag('ok'|'alert'|'status', text) : [+] / [!] / [*]
//   technique    → asciiChain(['RX','FC','MOTOR']) : RX ───┤ FC ├── MOTOR
//   demo scene   → bigText(str) : gros ASCII art, UNIQUEMENT pendant les
//                  événements (consommé par les primitives de rituel).
// Module pur, Node-safe, aucun DOM. Jamais importé par le moteur physique.

export const ASCII_TAGS = { ok: '[+]', alert: '[!]', status: '[*]' };

export function asciiTag(kind, text) {
	const tag = ASCII_TAGS[kind];
	if (!tag) throw new Error(`tag ASCII inconnu : ${kind}`);
	return `${tag} ${text}`;
}

// Chaîne technique : extrémités nues, nœuds intermédiaires en boîte ┤ X ├.
export function asciiChain(nodes) {
	if (!Array.isArray(nodes) || nodes.length === 0) return '';
	if (nodes.length === 1) return nodes[0];
	if (nodes.length === 2) return `${nodes[0]} ── ${nodes[1]}`;
	const mid = nodes.slice(1, -1).map((s) => `┤ ${s} ├`).join('───');
	return `${nodes[0]} ───${mid}── ${nodes[nodes.length - 1]}`;
}

// Police banner 3×5. Volontairement fruste : c'est du gros ASCII d'événement,
// pas une police de lecture. A-Z + espace + ! + - suffisent (vocabulaire des
// hacks + FPVTP!). Toute autre entrée retombe sur l'espace.
export const BIG_FONT = {
	A: [' # ', '# #', '###', '# #', '# #'],
	B: ['## ', '# #', '## ', '# #', '## '],
	C: [' ##', '#  ', '#  ', '#  ', ' ##'],
	D: ['## ', '# #', '# #', '# #', '## '],
	E: ['###', '#  ', '## ', '#  ', '###'],
	F: ['###', '#  ', '## ', '#  ', '#  '],
	G: [' ##', '#  ', '# #', '# #', ' ##'],
	H: ['# #', '# #', '###', '# #', '# #'],
	I: ['###', ' # ', ' # ', ' # ', '###'],
	J: ['  #', '  #', '  #', '# #', ' # '],
	K: ['# #', '# #', '## ', '# #', '# #'],
	L: ['#  ', '#  ', '#  ', '#  ', '###'],
	M: ['# #', '###', '###', '# #', '# #'],
	N: ['# #', '###', '###', '###', '# #'],
	O: [' # ', '# #', '# #', '# #', ' # '],
	P: ['## ', '# #', '## ', '#  ', '#  '],
	Q: [' # ', '# #', '# #', ' # ', '  #'],
	R: ['## ', '# #', '## ', '# #', '# #'],
	S: [' ##', '#  ', ' # ', '  #', '## '],
	T: ['###', ' # ', ' # ', ' # ', ' # '],
	U: ['# #', '# #', '# #', '# #', '###'],
	V: ['# #', '# #', '# #', '# #', ' # '],
	W: ['# #', '# #', '###', '###', '# #'],
	X: ['# #', '# #', ' # ', '# #', '# #'],
	Y: ['# #', '# #', ' # ', ' # ', ' # '],
	Z: ['###', '  #', ' # ', '#  ', '###'],
	' ': ['   ', '   ', '   ', '   ', '   '],
	'!': [' # ', ' # ', ' # ', '   ', ' # '],
	'-': ['   ', '   ', '###', '   ', '   '],
};

export function bigText(str) {
	const rows = ['', '', '', '', ''];
	for (const ch of String(str).toUpperCase()) {
		const glyph = BIG_FONT[ch] ?? BIG_FONT[' '];
		for (let i = 0; i < 5; i++) rows[i] += (rows[i] ? ' ' : '') + glyph[i];
	}
	return rows;
}
```

- [ ] **Step 4 : vérifier que le selftest passe**

Run: `cd sim && node tools/ascii-selftest.mjs`
Expected: PASS, `7 tests ascii OK`

- [ ] **Step 5 : commit**

```bash
git add sim/src/ascii.js sim/tools/ascii-selftest.mjs sim/docs/superpowers/plans/2026-08-29-phase-20-ascii-pixel-demoscene.md
git commit -m "PHASE 20 : langage ASCII (tags info, chaînes techniques, police banner)"
```

---

### Task 2 : `src/pixel-icons.js` — bibliothèque pixel art + favicon

**Files:**
- Create: `sim/src/pixel-icons.js`
- Test: `sim/tools/pixel-icons-selftest.mjs`
- Modify: `sim/index.html` (ligne 6 : favicon emoji 🚁 → drone pixel art)

**Interfaces:**
- Produces: `PIXEL_ICONS` (name → string[12], 12×12, chars `.`/`#`), `ICON_NAMES` (les 9 noms), `iconSVG(name, { color, size, background }) -> string`, `faviconDataURI() -> string`.

- [ ] **Step 1 : écrire le selftest (échoue d'abord)**

```js
// sim/tools/pixel-icons-selftest.mjs
// Selftest de la bibliothèque pixel art (PHASE 20, Bible §41). Aucune E/S DOM.
// Lancer : node tools/pixel-icons-selftest.mjs
import assert from 'node:assert/strict';
import { PIXEL_ICONS, ICON_NAMES, iconSVG, faviconDataURI } from '../src/pixel-icons.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('ICON_NAMES : exactement les 9 icônes de la Bible §41', () => {
	assert.deepEqual([...ICON_NAMES].sort(), [
		'antenna', 'battery', 'camera', 'drone', 'gps', 'link', 'map', 'radio', 'terrain',
	]);
});

t('PIXEL_ICONS : chaque icône est une grille 12×12 de . et #', () => {
	for (const name of ICON_NAMES) {
		const rows = PIXEL_ICONS[name];
		assert.equal(rows.length, 12, `${name} : 12 lignes`);
		for (const r of rows) {
			assert.equal(r.length, 12, `${name} : 12 colonnes`);
			assert.match(r, /^[.#]*$/, `${name} : uniquement . et #`);
		}
	}
});

t('PIXEL_ICONS : aucune icône vide ni pleine', () => {
	for (const name of ICON_NAMES) {
		const on = PIXEL_ICONS[name].join('').split('#').length - 1;
		assert.ok(on >= 10 && on <= 100, `${name} : ${on} pixels allumés`);
	}
});

t('iconSVG : rend des rects crispEdges, pas d\'emoji', () => {
	const svg = iconSVG('drone');
	assert.match(svg, /^<svg /);
	assert.match(svg, /crispEdges/);
	assert.match(svg, /<rect /);
	assert.doesNotMatch(svg, /[\u{1F000}-\u{1FAFF}]/u);
	assert.throws(() => iconSVG('rocket'));
});

t('faviconDataURI : data URI SVG du drone', () => {
	assert.match(faviconDataURI(), /^data:image\/svg\+xml,/);
});

console.log(`\n${n} tests pixel-icons OK`);
```

- [ ] **Step 2 : vérifier l'échec**

Run: `cd sim && node tools/pixel-icons-selftest.mjs`
Expected: FAIL (module introuvable)

- [ ] **Step 3 : implémenter `src/pixel-icons.js`**

Grilles 12×12, `.` = éteint, `#` = allumé. L'exécutant peut retoucher un dessin
(dans la contrainte 12×12 / `.#` / reconnaissable au premier coup d'œil,
vérifié au navigateur en Task 5) mais part de ces bitmaps :

```js
// Bibliothèque pixel art (PHASE 20, Bible §41). 9 icônes 12×12, monochromes :
// la couleur vient du contexte (currentColor), jamais de l'icône. Pas d'emoji,
// pas de Material Design. Module pur, Node-safe — sert aussi à générer le
// favicon (voir faviconDataURI, collé en dur dans index.html).
export const PIXEL_ICONS = {
	drone: [
		'##........##',
		'#.#......#.#',
		'.#.#....#.#.',
		'...#.##.#...',
		'....####....',
		'...######...',
		'...######...',
		'....####....',
		'...#.##.#...',
		'.#.#....#.#.',
		'#.#......#.#',
		'##........##',
	],
	radio: [
		'.#..........',
		'.#..........',
		'.#..........',
		'.########...',
		'.#......#...',
		'.#.####.#...',
		'.#.#..#.#...',
		'.#.####.#...',
		'.#......#...',
		'.#.#.#.##...',
		'.#......#...',
		'.########...',
	],
	antenna: [
		'..#..#..#...',
		'.#...#...#..',
		'.#..###..#..',
		'.#.#.#.#.#..',
		'....###.....',
		'.....#......',
		'.....#......',
		'.....#......',
		'.....#......',
		'....###.....',
		'...#.#.#....',
		'..#######...',
	],
	battery: [
		'....####....',
		'..########..',
		'..#......#..',
		'..#...#..#..',
		'..#..##..#..',
		'..#.####.#..',
		'..#..##..#..',
		'..#..#...#..',
		'..#.#....#..',
		'..#......#..',
		'..########..',
		'............',
	],
	camera: [
		'............',
		'..###.......',
		'..###.......',
		'.##########.',
		'.#........#.',
		'.#..####..#.',
		'.#.#....#.#.',
		'.#.#....#.#.',
		'.#..####..#.',
		'.#........#.',
		'.##########.',
		'............',
	],
	gps: [
		'....####....',
		'..##....##..',
		'.#........#.',
		'.#...##...#.',
		'.#..####..#.',
		'.#...##...#.',
		'..#......#..',
		'..##....##..',
		'...#....#...',
		'....#..#....',
		'.....##.....',
		'.....##.....',
	],
	map: [
		'............',
		'.##########.',
		'.#..#....##.',
		'.#..#...#.#.',
		'.#...#..#.#.',
		'.#...#.#..#.',
		'.#..#..#..#.',
		'.#..#...#.#.',
		'.#.#....#.#.',
		'.#.#...#..#.',
		'.##########.',
		'............',
	],
	link: [
		'............',
		'.#........#.',
		'.##......##.',
		'.#.#....#.#.',
		'.#..#..#..#.',
		'.#...##...#.',
		'.#........#.',
		'.#........#.',
		'.#........#.',
		'###......###',
		'............',
		'............',
	],
	terrain: [
		'............',
		'.....#......',
		'....###.....',
		'...##.##....',
		'..##...##...',
		'.##..#..##..',
		'.#..###...#.',
		'.#.##.##..#.',
		'.#.#...#..#.',
		'.##.....###.',
		'############',
		'............',
	],
};

export const ICON_NAMES = Object.keys(PIXEL_ICONS);

// SVG inline : un rect par pixel, crispEdges pour rester net à toute taille.
export function iconSVG(name, { color = 'currentColor', size = 12, background = null } = {}) {
	const rows = PIXEL_ICONS[name];
	if (!rows) throw new Error(`icône pixel inconnue : ${name}`);
	const n = rows.length;
	let rects = background ? `<rect width="${n}" height="${n}" fill="${background}"/>` : '';
	rows.forEach((row, y) => {
		for (let x = 0; x < n; x++) {
			if (row[x] === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
		}
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" fill="${color}">${rects}</svg>`;
}

// Favicon : drone blanc cassé sur fond sombre (palette de base, Bible §38).
export function faviconDataURI() {
	return `data:image/svg+xml,${encodeURIComponent(iconSVG('drone', { color: '#e8e6e0', size: 16, background: '#141412' }))}`;
}
```

- [ ] **Step 4 : vérifier que le selftest passe**

Run: `cd sim && node tools/pixel-icons-selftest.mjs`
Expected: PASS, `5 tests pixel-icons OK`

- [ ] **Step 5 : remplacer le favicon emoji dans `index.html`**

Générer l'URI :

```bash
cd sim && node -e "import('./src/pixel-icons.js').then(m => console.log(m.faviconDataURI()))"
```

Dans `sim/index.html`, remplacer la ligne :

```html
	<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%F0%9F%9A%81%3C/text%3E%3C/svg%3E">
```

par la sortie de la commande :

```html
	<link rel="icon" href="<SORTIE DE faviconDataURI()>">
```

(coller la valeur littérale — le favicon reste statique, pas de JS au chargement).

- [ ] **Step 6 : commit**

```bash
git add sim/src/pixel-icons.js sim/tools/pixel-icons-selftest.mjs sim/index.html
git commit -m "PHASE 20 : bibliothèque pixel art + favicon drone (fin de l'emoji)"
```

---

### Task 3 : primitives demo scene — colorFlash, textWarp, bannerBurst + durée paramétrable

**Files:**
- Modify: `sim/src/hack-grammars.js` (nouvelles primitives + `dur` sur pulseRing/vectorSweep + FAMILY_PRIMITIVES)
- Modify: `sim/src/ritual.js` (passe `dur` aux primitives)
- Test: `sim/tools/ritual-selftest.mjs` (étendu)

**Interfaces:**
- Consumes: `bigText` de `src/ascii.js` (Task 1).
- Produces: contrat de primitive étendu `draw(el, { t, seed, dur = 4 })` (`dur` = durée totale de la culmination en secondes, V1≈1 … V4≈4). `RITUAL_PRIMITIVES` gagne `colorFlash`, `textWarp`, `bannerBurst` (11 au total).

- [ ] **Step 1 : étendre le selftest (échoue d'abord)**

Dans `sim/tools/ritual-selftest.mjs`, remplacer le test `'RITUAL_PRIMITIVES : au moins les 8 primitives documentées'` par :

```js
t('RITUAL_PRIMITIVES : les 11 primitives documentées', () => {
	for (const name of [
		'scanBurst', 'glitchShift', 'pulseRing', 'gridSwarm',
		'waveformSpike', 'vectorSweep', 'memoryScroll', 'chromaSplit',
		'colorFlash', 'textWarp', 'bannerBurst',
	]) {
		assert.equal(typeof RITUAL_PRIMITIVES[name], 'function', `manque ${name}`);
	}
});

t('primitives : contrat (t, seed, dur) tenu de V1 à V4, sortie bornée 44×12', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		for (const dur of [1, 2, 3, 4]) {
			for (const tt of [0, dur * 0.5, dur - 0.016]) {
				const el = { textContent: '' };
				fn(el, { t: tt, seed: 0.37, dur });
				const rows = el.textContent.split('\n');
				assert.equal(rows.length, 12, `${name} dur=${dur} : 12 lignes`);
				for (const r of rows) assert.equal(r.length, 44, `${name} dur=${dur} : 44 colonnes`);
			}
		}
	}
});

t('primitives : dur absent → comportement par défaut (compat PHASE 10)', () => {
	for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
		const el = { textContent: '' };
		fn(el, { t: 0.5, seed: 0.37 });
		assert.ok(el.textContent.length > 0, name);
	}
});
```

Et compléter le test `FAMILY_PRIMITIVES` existant : chaque nouvelle primitive
doit être utilisée par au moins une famille :

```js
t('FAMILY_PRIMITIVES : les nouvelles primitives PHASE 20 sont composées', () => {
	const used = new Set(Object.values(FAMILY_PRIMITIVES).flat());
	for (const name of ['colorFlash', 'textWarp', 'bannerBurst']) {
		assert.ok(used.has(name), `${name} n'est composé par aucune famille`);
	}
});
```

- [ ] **Step 2 : vérifier l'échec**

Run: `cd sim && node tools/ritual-selftest.mjs`
Expected: FAIL (`manque colorFlash`)

- [ ] **Step 3 : implémenter dans `hack-grammars.js`**

En tête de la section primitives, ajouter l'import (après celui de `HACK_VOCAB`) :

```js
import { bigText } from './ascii.js';
```

Ajouter les trois primitives avant `export const RITUAL_PRIMITIVES` :

```js
// --- colorFlash : plein champ qui strobe — la teinte (cyan/magenta/…) est
// appliquée par le conteneur, la primitive ne fait que remplir/vider ---------

function colorFlash(el, { t, seed, dur = 4 }) {
	const g = blank();
	const hz = 9;
	const step = Math.floor(t * hz + seed * 3);
	if (step % 3 !== 0) { // 2 frames pleines, 1 noire : le flash, pas un aplat
		const fill = step % 2 ? '█' : '▓';
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				if (noise(x, y, step, seed) > 0.15) g[y][x] = fill;
			}
		}
	}
	el.textContent = frame(lines(g));
}

// --- textWarp : lignes du vocabulaire d'ambiance déformées par une sinusoïde -

function textWarp(el, { t, seed, dur = 4 }) {
	const g = blank();
	for (let y = 1; y < H; y += 2) {
		const word = VOCAB[(Math.floor(noise(0, y, 0, seed) * VOCAB.length) + y) % VOCAB.length];
		const line = `${word} `.repeat(Math.ceil(W / (word.length + 1)) + 2);
		const shift = Math.round(Math.sin(t * 6 + y * 0.9 + seed * 6.28) * 5) + y * 3;
		for (let x = 0; x < W; x++) {
			const c = line[(((x + shift) % line.length) + line.length) % line.length];
			if (c !== ' ') g[y][x] = c;
		}
	}
	el.textContent = frame(lines(g));
}

// --- bannerBurst : gros ASCII art d'un mot du vocabulaire (Bible §40 : le
// gros ASCII n'existe QUE pendant les événements), jitter horizontal ---------

function bannerBurst(el, { t, seed, dur = 4 }) {
	const g = blank();
	const word = VOCAB[Math.floor(noise(1, 2, 3, seed) * VOCAB.length)];
	const rows = bigText(word.slice(0, 10));
	const y0 = Math.floor((H - rows.length) / 2);
	const jx = Math.floor(noise(Math.floor(t * 12), 0, 0, seed) * 3) - 1;
	const x0 = Math.max(0, Math.floor((W - rows[0].length) / 2) + jx);
	rows.forEach((r, i) => text(g, x0, y0 + i, r));
	el.textContent = frame(lines(g));
}
```

Paramétrer en durée les deux primitives dont le cycle interne dépasse V1
(elles ne bouclaient jamais en 1 s) — signatures et périodes :

```js
function pulseRing(el, { t, seed, dur = 4 }) {
	// ...
	const period = Math.min(1.4, dur * 0.45); // au moins 2 pulsations par culmination
	// ... (reste inchangé)
}

function vectorSweep(el, { t, seed, dur = 4 }) {
	// ...
	const period = Math.min(1.2, dur * 0.4); // au moins 2 balayages par culmination
	// ... (reste inchangé)
}
```

Mettre à jour les exports :

```js
export const RITUAL_PRIMITIVES = {
	scanBurst, glitchShift, pulseRing, gridSwarm,
	waveformSpike, vectorSweep, memoryScroll, chromaSplit,
	colorFlash, textWarp, bannerBurst,
};

export const FAMILY_PRIMITIVES = {
	'COMMAND INJECTION': ['scanBurst', 'gridSwarm', 'glitchShift', 'colorFlash'],
	'LINK HIJACK': ['pulseRing', 'waveformSpike', 'colorFlash'],
	'TELEMETRY SPOOF': ['waveformSpike', 'chromaSplit', 'textWarp'],
	'GNSS SPOOF': ['vectorSweep', 'chromaSplit', 'bannerBurst'],
	'NETWORK TAKEOVER': ['gridSwarm', 'pulseRing', 'bannerBurst'],
	'FIRMWARE OVERRIDE': ['memoryScroll', 'scanBurst', 'textWarp'],
};
```

Ajuster le commentaire d'en-tête de la section (« 8 blocs » → « 11 blocs », mention du contrat `dur`).

Dans `src/ritual.js`, la boucle `loop(now)` passe la durée de la variante :

```js
primitive(burstEl, { t: elapsed / 1000, seed: numSeed, dur: variant.ms / 1000 });
```

- [ ] **Step 4 : vérifier que le selftest passe**

Run: `cd sim && node tools/ritual-selftest.mjs`
Expected: PASS (12 tests)

- [ ] **Step 5 : commit**

```bash
git add sim/src/hack-grammars.js sim/src/ritual.js sim/tools/ritual-selftest.mjs
git commit -m "PHASE 20 : primitives colorFlash/textWarp/bannerBurst + durée V1-V4 paramétrable"
```

---

### Task 4 : coût mesuré + garde-fou « rien hors événement » + câblage selftests

**Files:**
- Create: `sim/tools/ritual-bench.mjs`
- Modify: `sim/tools/ritual-selftest.mjs` (garde-fou imports)
- Modify: `sim/package.json` (chaîne `selftest:operator`)

**Interfaces:**
- Produces: `node tools/ritual-bench.mjs` — table ms/frame par primitive, exit 1 si une primitive dépasse 2 ms/frame.

- [ ] **Step 1 : garde-fou imports dans le selftest (échoue si violé — écrire, vérifier qu'il passe : c'est un invariant, pas un comportement nouveau)**

Ajouter à `sim/tools/ritual-selftest.mjs` :

```js
t('acceptation #57 : aucune primitive demo scene hors événement (seul ritual.js les importe)', () => {
	const dir = new URL('../src/', import.meta.url);
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
		if (f === 'ritual.js' || f === 'hack-grammars.js') continue;
		const src = fs.readFileSync(new URL(f, dir), 'utf8');
		assert.doesNotMatch(src, /RITUAL_PRIMITIVES|FAMILY_PRIMITIVES/,
			`${f} référence les primitives demo scene hors rituel`);
	}
});
```

avec en tête de fichier :

```js
import fs from 'node:fs';
```

Run: `cd sim && node tools/ritual-selftest.mjs` — Expected: PASS.

- [ ] **Step 2 : écrire le bench**

```js
// sim/tools/ritual-bench.mjs
// Coût CPU des primitives demo scene (PHASE 20, issue #57 : « une folie de
// 4 secondes ne doit pas retarder l'entrée en vol »). Les primitives écrivent
// du texte dans un <pre> — le coût est CPU pur (génération de chaîne), mesuré
// ici sur un faux élément. Budget : 2 ms/frame par primitive (à 60 fps la
// frame entière dispose de 16 ms, le rendu 3D est coupé pendant le rituel).
// Lancer : node tools/ritual-bench.mjs — exit 1 si budget dépassé.
import { RITUAL_PRIMITIVES } from '../src/hack-grammars.js';

const FRAMES = 480; // 2 passes de V4 à 60 fps
const BUDGET_MS = 2;
const el = { textContent: '' };
let worst = ['', 0];

console.log('primitive        ms/frame');
for (const [name, fn] of Object.entries(RITUAL_PRIMITIVES)) {
	fn(el, { t: 0, seed: 0.42, dur: 4 }); // échauffement JIT
	const t0 = performance.now();
	for (let i = 0; i < FRAMES; i++) fn(el, { t: (i / FRAMES) * 4, seed: 0.42, dur: 4 });
	const ms = (performance.now() - t0) / FRAMES;
	if (ms > worst[1]) worst = [name, ms];
	console.log(`${name.padEnd(16)} ${ms.toFixed(3)}`);
}

console.log(`\npire cas : ${worst[0]} à ${worst[1].toFixed(3)} ms/frame (budget ${BUDGET_MS} ms)`);
process.exit(worst[1] < BUDGET_MS ? 0 : 1);
```

Run: `cd sim && node tools/ritual-bench.mjs`
Expected: table + exit 0. Noter les chiffres (repris dans HANDOFF, Task 5).

- [ ] **Step 3 : câbler les selftests PHASE 20 dans `package.json`**

`ritual-selftest.mjs` n'était pas dans la chaîne (oubli PHASE 10). Dans
`sim/package.json`, ajouter à la fin de `selftest:operator` :

```text
 && node tools/ritual-selftest.mjs && node tools/ascii-selftest.mjs && node tools/pixel-icons-selftest.mjs && node tools/ritual-bench.mjs
```

Run: `cd sim && npm run selftest:operator`
Expected: toute la chaîne passe.

- [ ] **Step 4 : commit**

```bash
git add sim/tools/ritual-bench.mjs sim/tools/ritual-selftest.mjs sim/package.json
git commit -m "PHASE 20 : bench de coût des primitives + garde-fou hors-événement + câblage selftests"
```

---

### Task 5 : vérification navigateur + docs + PR

**Files:**
- Modify: `sim/HANDOFF.md`
- (vérification : `npm run dev` + chrome-devtools MCP)

- [ ] **Step 1 : selftest complet**

Run: `cd sim && npm run selftest && npm run selftest:operator`
Expected: tout vert (aucune dépendance moteur ajoutée).

- [ ] **Step 2 : vérification navigateur en vraie session**

Lancer `npm run dev`, ouvrir le jeu via chrome-devtools MCP
(mémoire projet : `--executablePath=/usr/bin/chromium` ; si le profil est
verrouillé, piloter un Chromium à soi via CDP). Vérifier :

1. le favicon de l'onglet est le drone pixel art (plus d'hélicoptère emoji) ;
2. dérouler un hack complet jusqu'au rituel (`?scene=<slug>` + flux normal),
   déclencher plusieurs seeds (recharger) pour voir au moins une fois
   `colorFlash`, `textWarp`, `bannerBurst` — familles GNSS SPOOF / TELEMETRY
   SPOOF / LINK HIJACK les garantissent ;
3. hors rituel (menu, scanner, vol) : aucun flash, aucune couleur demo scene ;
4. screenshot d'une culmination pour trace.

Expected: les trois nouvelles primitives lisibles et « 1-4 s de folie puis
retour au calme » respecté.

- [ ] **Step 3 : mettre à jour `sim/HANDOFF.md`**

Section PHASE 20 (état vérifié uniquement) : modules `ascii.js` /
`pixel-icons.js`, 11 primitives, contrat `dur`, chiffres du bench
(ms/frame mesurés), favicon remplacé, garde-fou imports. Mentionner que la
passe d'adoption des tags `[+]/[!]/[*]` sur les écrans existants relève de la
PHASE 19 (issue #56) — le langage existe, la généralisation est hors périmètre.

- [ ] **Step 4 : commit + push + PR**

```bash
git add sim/HANDOFF.md
git commit -m "PHASE 20 : état vérifié dans le HANDOFF"
git push -u origin phase-20-impl
gh pr create --repo lionrayonnant/FPVTP --base main --head phase-20-impl \
  --title "PHASE 20 — ASCII / pixel art / demo scene" \
  --body "Closes #57 ... (résumé, chiffres bench, screenshot)"
```

Puis cocher les cases de l'issue #57 (elles sont couvertes : composition via
FAMILY_PRIMITIVES, durée via dur, coût via ritual-bench) et passer l'issue
Done au merge.

---

## Self-review (fait à l'écriture du plan)

- **Couverture spec :** ASCII 3 usages → Task 1 ; pixel art 9 icônes + favicon → Task 2 ; primitives 6 catégories (bursts=scanBurst ✓ existant, scan patterns=gridSwarm ✓, signal waves=pulseRing/waveformSpike ✓, vector animations=vectorSweep ✓, color flashes=colorFlash ✚, text deformation=textWarp/bannerBurst ✚) → Task 3 ; durée V1-V4 → Task 3 ; coût mesuré → Task 4 ; « 25ᵉ rituel sans nouvelle séquence » → grammaire FAMILY_PRIMITIVES inchangée dans son principe (testée) ; « aucune primitive hors événement » → garde-fou Task 4 + vérif navigateur Task 5.
- **Types cohérents :** `bigText` (Task 1) consommé par `bannerBurst` (Task 3) ; contrat `{ t, seed, dur }` identique selftest/bench/ritual.js.
- **Hors périmètre assumé :** adoption des tags sur les écrans existants (PHASE 19, #56) ; usage des icônes pixel dans les écrans (PHASE 19) ; sons des rituels (PHASE 18).
