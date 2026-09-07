# PHASE 12 — Double HUD + caméra de cible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Démonter le HUD unique en deux couches — un OSD drone qui appartient à
la cible et traverse la liaison, un OSD FPVTP! local qui ne traverse rien — et
donner à chaque cible sa propre caméra (champ, inclinaison, format, définition,
capteur), pour que le joueur dise « ce drone est encore différent » avant sa
première correction de manche.

**Architecture:** Deux modèles purs sans dépendance (`tools/target-camera.mjs`,
`tools/drone-osd-model.mjs`) transforment une cible en fiche caméra et en layout
d'OSD, tous deux testables en headless. `src/drone-osd.js` peint le layout dans
un canvas 2D dont la `CanvasTexture` est échantillonnée par le pass unique de
`src/lens.js`, en amont du vignettage, du capteur et du lien. `src/fpvtp-osd.js`
est un calque DOM au-dessus du canvas, jamais dégradé. `src/lens.js` gagne trois
blocs de shader : l'encadrement du format, le capteur, et le cross-color.

**Tech Stack:** JS vanilla (modules ES), three.js (déjà présent — `CanvasTexture`
et `WebGLRenderTarget` uniquement), GLSL dans le `ShaderPass` existant, Node pour
`tools/selftest.mjs`. Aucune dépendance nouvelle.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-12-double-hud-design.md`

## Global Constraints

- **Aucune dépendance nouvelle.** Ni paquet npm, ni bibliothèque de police.
- **Aucun changement au moteur physique, au contrôleur ou au modèle d'air.** La
  caméra ne touche pas au vol. `node tools/selftest.mjs` reste vert après chaque
  tâche.
- **Textes du jeu en anglais.** Issues, commits et commentaires internes en
  français (CLAUDE.md).
- **Les modèles purs (`tools/*.mjs`) n'importent rien** — ni DOM, ni three, ni
  `node:`. Ils tournent dans le navigateur via Vite et dans Node via le selftest.
- **Générateur pseudo-aléatoire :** FNV-1a puis xorshift, copié tel quel depuis
  `tools/target-model.mjs`. Même idiome partout, jamais `Math.random()` dans un
  modèle.
- **Un seul pass plein écran.** Interdiction d'ajouter un `ShaderPass` ou un
  `renderer.render()` supplémentaire : c'est l'argument d'architecture de
  `src/lens.js:8-25`.
- **Le collider reste une sphère de 0,15 m et `camera.near` reste 0.15** exactement
  (CLAUDE.md). La fiche caméra ne touche ni à l'un ni à l'autre.
- **Commits en français**, terminés par `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Insertion dans `tools/selftest.mjs` :** toujours **avant** les deux dernières
  lignes du fichier (`console.log(...)` du résumé et `process.exit(...)`).

---

### Task 1 : `tools/target-camera.mjs` — la fiche caméra

**Files:**
- Create: `sim/tools/target-camera.mjs`
- Test: `sim/tools/selftest.mjs` (nouvelle section, avant les deux dernières lignes)

**Interfaces:**
- Consumes: rien.
- Produces: `targetCamera({ seed, family }) → { fovDeg, uptiltDeg, aspect, resScale, sensor }`
  où `sensor = { grain, lift, saturation, ringing, clip, crossColor, tintHue, tintAmount }`,
  tous dans `[0, 1]`. Plus les constantes exportées `CAMERA_FAMILIES`, `RES_LOW`,
  `RES_HIGH`, et `rngFrom(seed)`.
  Consommé par la Task 9 (`main.js`) et la Task 3 (`lens.js` via `main.js`).

- [ ] **Step 1: Écrire le test qui échoue**

Dans `sim/tools/selftest.mjs`, ajouter l'import à côté de celui de `target-model.mjs` :

```js
import { targetCamera, CAMERA_FAMILIES, RES_LOW, RES_HIGH } from './target-camera.mjs';
```

Puis insérer cette section **avant les deux dernières lignes du fichier** :

```js
console.log('\ncaméra de cible');
{
	const A = targetCamera({ seed: 'alpha', family: 'freestyle5' });
	const A2 = targetCamera({ seed: 'alpha', family: 'freestyle5' });
	check('même graine, même fiche', JSON.stringify(A) === JSON.stringify(A2));

	const B = targetCamera({ seed: 'bravo', family: 'freestyle5' });
	check('deux graines, deux fiches', JSON.stringify(A) !== JSON.stringify(B));

	// 200 tirages par famille : les bornes de la table sont la cohérence
	// promise, donc elles sont vérifiées et pas seulement commentées.
	let inRange = true, sane = true;
	for (const fam of Object.keys(CAMERA_FAMILIES)) {
		const t = CAMERA_FAMILIES[fam];
		for (let i = 0; i < 200; i++) {
			const c = targetCamera({ seed: `${fam}::${i}`, family: fam });
			if (c.fovDeg < t.fovDeg[0] || c.fovDeg > t.fovDeg[1]) inRange = false;
			if (c.uptiltDeg < t.uptiltDeg[0] || c.uptiltDeg > t.uptiltDeg[1]) inRange = false;
			if (c.resScale < t.resScale[0] || c.resScale > t.resScale[1]) inRange = false;
			if (!t.aspects.includes(c.aspectName)) inRange = false;
			if (Math.abs(c.aspect - (c.aspectName === '4:3' ? 4 / 3 : 16 / 9)) > 1e-9) sane = false;
			for (const v of Object.values(c.sensor)) if (!(v >= 0 && v <= 1)) sane = false;
		}
	}
	check('toutes les familles restent dans les bornes de leur table', inRange);
	check('aspect cohérent avec aspectName, capteur borné [0,1]', sane);

	// La cohérence demandée par la DA : une bonne famille n'a jamais une
	// mauvaise caméra, et l'inverse.
	let goodLow = false, badHigh = false;
	for (let i = 0; i < 200; i++) {
		for (const fam of ['cinewhoop', 'heavy5', 'longrange']) {
			if (targetCamera({ seed: `q${i}`, family: fam }).resScale < RES_HIGH) goodLow = true;
		}
		if (targetCamera({ seed: `q${i}`, family: 'toothpick' }).resScale > RES_LOW) badHigh = true;
	}
	check('cinewhoop / heavy5 / longrange : jamais une définition basse', goodLow === false);
	check('toothpick : jamais une définition haute', badHigh === false);

	// Un toothpick est une mauvaise caméra : plus de bruit et plus de halo
	// qu'un cinewhoop, toujours, pas en moyenne.
	let worse = true;
	for (let i = 0; i < 200; i++) {
		const bad = targetCamera({ seed: `w${i}`, family: 'toothpick' }).sensor;
		const good = targetCamera({ seed: `w${i}`, family: 'cinewhoop' }).sensor;
		if (bad.grain <= good.grain || bad.ringing <= good.ringing) worse = false;
	}
	check('toothpick toujours plus bruité et plus halo qu\'un cinewhoop', worse);

	const unknown = targetCamera({ seed: 'x', family: 'inconnue' });
	check('famille inconnue : repli sur freestyle5 plutôt qu\'un plantage', unknown.fovDeg > 0);
}
```

- [ ] **Step 2: Le lancer pour vérifier qu'il échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot find module './target-camera.mjs'`.

- [ ] **Step 3: Écrire `sim/tools/target-camera.mjs`**

```js
// PHASE 12 — la caméra de la cible. Logique pure, AUCUNE dépendance : importée
// par le selftest (Node) et par le client (bundle Vite), comme
// tools/target-model.mjs.
//
// Le drone n'est pas le tien. Son champ, son inclinaison, son format, sa
// définition et son capteur sont ce qu'ils sont — c'est ce qui fait qu'un vol
// ne ressemble pas au précédent, avant même la première correction de manche.

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même géné que
// tools/target-model.mjs et src/link.js : petit, déterministe, rejouable).
export function rngFrom(seed) {
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

// Seuils de définition. Ce sont eux qui donnent un sens testable à « bonne » et
// « mauvaise » caméra : au-dessus de RES_HIGH c'est net, en dessous de RES_LOW
// les branches d'un arbre ne sont plus des branches.
export const RES_LOW = 0.6;
export const RES_HIGH = 0.8;

// La famille pose le terrain, la graine tire dedans : deux toothpick n'ont pas
// la même caméra, mais aucun toothpick n'a une bonne caméra. C'est LA table à
// régler pour le ressenti — rien d'autre dans ce fichier n'a besoin de bouger.
//
// `quality` (0..1) est l'axe unique du capteur : tout le bloc `sensor` en
// découle, pour qu'une caméra ne puisse pas être à la fois nette et bruitée.
// `aspects` est une liste avec répétitions : c'est la pondération du tirage.
export const CAMERA_FAMILIES = {
	// Faite pour filmer : douce, propre, presque droite.
	cinewhoop:  { fovDeg: [105, 125], uptiltDeg: [0, 10],  aspects: ['16:9'],                 resScale: [0.85, 1.00], quality: [0.75, 1.00] },
	// Cinéma lourd : même logique, un peu plus de champ.
	heavy5:     { fovDeg: [100, 120], uptiltDeg: [0, 15],  aspects: ['16:9'],                 resScale: [0.85, 1.00], quality: [0.70, 1.00] },
	// Longue distance : on regarde loin, donc plus serré, et le matériel est bon.
	longrange:  { fovDeg: [ 90, 110], uptiltDeg: [10, 25], aspects: ['16:9'],                 resScale: [0.80, 1.00], quality: [0.70, 1.00] },
	// Ça dépend : toute l'étendue, c'est la famille où l'on ne sait pas d'avance.
	freestyle5: { fovDeg: [100, 150], uptiltDeg: [15, 35], aspects: ['4:3', '16:9'],          resScale: [0.45, 1.00], quality: [0.25, 1.00] },
	// Course : très inclinée, latence avant image, matériel bas de gamme rapide.
	race5:      { fovDeg: [110, 140], uptiltDeg: [25, 45], aspects: ['4:3', '4:3', '16:9'],   resScale: [0.50, 0.75], quality: [0.30, 0.60] },
	// Une bouse, et c'est le sujet.
	toothpick:  { fovDeg: [110, 160], uptiltDeg: [10, 40], aspects: ['4:3'],                  resScale: [0.30, 0.50], quality: [0.00, 0.30] },
};

const FALLBACK_FAMILY = 'freestyle5';

const lerp = (rand, [lo, hi]) => lo + rand() * (hi - lo);
const mix = (a, b, t) => a + (b - a) * t;

export function targetCamera({ seed, family } = {}) {
	const table = CAMERA_FAMILIES[family] ?? CAMERA_FAMILIES[FALLBACK_FAMILY];
	const rand = rngFrom(`${seed}::camera::${family}`);

	const fovDeg = lerp(rand, table.fovDeg);
	const uptiltDeg = lerp(rand, table.uptiltDeg);
	const aspectName = table.aspects[Math.floor(rand() * table.aspects.length)];
	const resScale = lerp(rand, table.resScale);
	const q = lerp(rand, table.quality);

	// Tout le capteur descend de `q`. Écrit dans le sens « 0 = parfait » pour
	// chaque défaut, pour qu'un uniform à zéro veuille dire « rien à faire ».
	const sensor = {
		grain: mix(0.070, 0.004, q),       // bruit propre au capteur, lien parfait compris
		lift: mix(0.100, 0.004, q),        // noirs levés
		saturation: mix(0.70, 1.00, q),    // fadeur (1 = couleurs intactes)
		ringing: mix(0.90, 0.02, q),       // halo de sur-accentuation sur les contours
		clip: mix(0.80, 0.03, q),          // écrasement des hautes lumières
		// Indépendant de la qualité : c'est le décodeur, pas le capteur. À 0 la
		// caméra meurt en gris, à 1 en arc-en-ciel.
		crossColor: rand(),
		tintHue: rand(),
		tintAmount: mix(0.20, 0.01, q),
	};

	return {
		fovDeg,
		uptiltDeg,
		aspectName,
		aspect: aspectName === '4:3' ? 4 / 3 : 16 / 9,
		resScale,
		sensor,
	};
}
```

- [ ] **Step 4: Relancer le test**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`, avec la section « caméra de cible » entièrement verte.

- [ ] **Step 5: Commit**

```bash
cd sim && git add tools/target-camera.mjs tools/selftest.mjs
git commit -m "Caméra de cible : fiche tirée par famille (PHASE 12)

Champ, inclinaison, format, définition et capteur, cohérents avec la
famille : la table pose le terrain, la graine tire dedans.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2 : `tools/drone-osd-model.mjs` — le layout de l'OSD

**Files:**
- Create: `sim/tools/drone-osd-model.mjs`
- Test: `sim/tools/selftest.mjs` (nouvelle section, avant les deux dernières lignes)

**Interfaces:**
- Consumes: rien (recopie son propre `rngFrom`, pour rester sans dépendance).
- Produces: `droneOsdLayout({ seed, family, mode }) → { style, grid: {cols, rows}, font, units, craftName, elements: [{ key, col, row }] }`.
  Plus `ELEMENTS`, `ELEMENT_WIDTH`, `GPS_ELEMENTS`, `NO_GPS_FAMILIES`, `GRIDS`,
  `FONTS`, `DENSITY`. Consommé par la Task 6 (`src/drone-osd.js`) et la Task 9.

- [ ] **Step 1: Écrire le test qui échoue**

Dans `sim/tools/selftest.mjs`, ajouter l'import :

```js
import { droneOsdLayout, ELEMENTS, ELEMENT_WIDTH, GPS_ELEMENTS, GRIDS, DENSITY } from './drone-osd-model.mjs';
```

Puis insérer cette section **avant les deux dernières lignes du fichier** :

```js
console.log('\nOSD drone — layout');
{
	const A = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'ANALOG' });
	const A2 = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'ANALOG' });
	check('même graine, même layout', JSON.stringify(A) === JSON.stringify(A2));

	const B = droneOsdLayout({ seed: 'bravo', family: 'freestyle5', mode: 'ANALOG' });
	check('deux cibles, deux layouts', JSON.stringify(A) !== JSON.stringify(B));

	const dig = droneOsdLayout({ seed: 'alpha', family: 'freestyle5', mode: 'DIGITAL' });
	check('le style suit le mode vidéo de la cible, il ne se tire pas',
		A.style === 'ANALOG' && dig.style === 'DIGITAL');

	// Les grilles ne se recoupent pas : c'est ce qui rend la différence
	// analogique/numérique visible au premier coup d'œil.
	const gridKey = (g) => `${g.cols}x${g.rows}`;
	const analogGrids = new Set(GRIDS.ANALOG.map((g) => `${g[0]}x${g[1]}`));
	const digitalGrids = new Set(GRIDS.DIGITAL.map((g) => `${g[0]}x${g[1]}`));
	let gridsOk = true, boundsOk = true, placedOk = true, noOverlap = true, staplesOk = true;
	let gpsLeak = false, gpsPresent = false;
	const layouts = new Set(), fieldSets = new Set();

	for (let i = 0; i < 200; i++) {
		for (const mode of ['ANALOG', 'DIGITAL']) {
			const fam = ['freestyle5', 'race5', 'cinewhoop', 'longrange', 'heavy5'][i % 5];
			const l = droneOsdLayout({ seed: `v${i}`, family: fam, mode });
			const set = mode === 'ANALOG' ? analogGrids : digitalGrids;
			if (!set.has(gridKey(l.grid))) gridsOk = false;

			const [lo, hi] = DENSITY[mode];
			if (l.elements.length < lo || l.elements.length > hi) boundsOk = false;

			// Occupation de la grille, ligne par ligne.
			const rows = new Map();
			for (const e of l.elements) {
				if (!ELEMENTS.includes(e.key)) placedOk = false;
				const w = ELEMENT_WIDTH[e.key];
				if (e.col < 0 || e.row < 0 || e.row >= l.grid.rows || e.col + w > l.grid.cols) placedOk = false;
				const occupied = rows.get(e.row) ?? [];
				for (const [c0, c1] of occupied) if (e.col < c1 && c0 < e.col + w) noOverlap = false;
				occupied.push([e.col, e.col + w]);
				rows.set(e.row, occupied);
			}

			const keys = l.elements.map((e) => e.key);
			if (!keys.includes('BAT_V')) staplesOk = false;
			if (!keys.includes('TIMER_FLIGHT') && !keys.includes('TIMER_ON')) staplesOk = false;

			layouts.add(JSON.stringify(l));
			fieldSets.add([...keys].sort().join(','));
		}

		// Les capteurs absents suivent la famille, pas le hasard.
		const tp = droneOsdLayout({ seed: `g${i}`, family: 'toothpick', mode: 'ANALOG' });
		if (tp.elements.some((e) => GPS_ELEMENTS.includes(e.key))) gpsLeak = true;
		const lr = droneOsdLayout({ seed: `g${i}`, family: 'longrange', mode: 'DIGITAL' });
		if (lr.elements.some((e) => GPS_ELEMENTS.includes(e.key))) gpsPresent = true;
	}

	check('chaque style reste dans ses grilles, et elles ne se recoupent pas', gridsOk);
	check('la densité reste dans les bornes du style', boundsOk);
	check('tous les éléments sont connus et tiennent dans la grille', placedOk);
	check('jamais deux éléments superposés', noOverlap);
	check('BAT_V et un chronomètre sont toujours là', staplesOk);
	check('toothpick : aucun élément GPS (il n\'en a pas)', gpsLeak === false);
	check('longrange : le GPS apparaît', gpsPresent === true);

	// « Ce drone est encore différent » : mesuré, pas espéré. Sur 400 tirages,
	// des paliers bas volontairement — c'est un plancher, pas une cible.
	check('la variété est réelle : layouts distincts', layouts.size > 350, `${layouts.size}/400`);
	check('la variété est réelle : jeux d\'éléments distincts', fieldSets.size > 100, `${fieldSets.size}/400`);

	let imperial = 0;
	for (let i = 0; i < 400; i++) {
		if (droneOsdLayout({ seed: `u${i}`, family: 'freestyle5', mode: 'ANALOG' }).units === 'IMPERIAL') imperial++;
	}
	check('les unités impériales existent sans dominer', imperial > 40 && imperial < 200, `${imperial}/400`);
}
```

- [ ] **Step 2: Le lancer pour vérifier qu'il échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot find module './drone-osd-model.mjs'`.

- [ ] **Step 3: Écrire `sim/tools/drone-osd-model.mjs`**

```js
// PHASE 12 — le layout de l'OSD drone. Logique pure, AUCUNE dépendance.
//
// L'OSD appartient à la cible : il varie énormément d'une machine à l'autre,
// il peut être riche ou quasiment vide, et il est posé sur une grille de
// caractères comme un vrai OSD — pas sur des ancrages propres. C'est cette
// grille qui produit les dispositions franchement bancales du matériel réel.

export function rngFrom(seed) {
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

// Le vocabulaire réel d'un OSD Betaflight / Walksnail. La largeur est en
// caractères, y compris l'unité et le pictogramme : c'est ce qui permet de
// garantir qu'aucun élément n'en recouvre un autre.
export const ELEMENT_WIDTH = {
	BAT_V: 6, CELL_V: 6, CURRENT: 6, MAH: 7,
	ALT: 6, ALT_HOME: 7, GS: 6, VS: 6, THR: 5,
	RSSI: 6, LQ: 5, TX_POWER: 6,
	SATS: 4, LATLON: 13, HOME_DIST: 7, HOME_ARROW: 2,
	TIMER_FLIGHT: 7, TIMER_ON: 7,
	HORIZON: 13, CROSSHAIR: 3, HEADING_TAPE: 13,
	WARNINGS: 12, CRAFT_NAME: 12, ESC_TEMP: 5, EFFICIENCY: 8, VTX_CHAN: 5,
};
export const ELEMENTS = Object.keys(ELEMENT_WIDTH);

// Ce qui n'existe pas sans GPS. Une machine sans GPS ne les affiche pas —
// elle ne les affiche pas « à zéro », elle ne les a pas.
export const GPS_ELEMENTS = ['SATS', 'LATLON', 'HOME_DIST', 'HOME_ARROW', 'GS', 'EFFICIENCY'];
export const NO_GPS_FAMILIES = ['toothpick', 'race5'];

// Grilles de caractères réelles. En analogique la grille est petite, donc les
// caractères sont énormes et mangent l'image ; en HD ils sont fins et discrets.
// C'est, visuellement, la différence la plus brutale entre deux drones.
export const GRIDS = {
	ANALOG: [[30, 16], [30, 13]],   // NTSC, PAL
	DIGITAL: [[50, 18], [53, 20]],
};

export const FONTS = ['DEFAULT', 'BOLD', 'LARGE', 'CLARITY'];
export const DENSITY = { ANALOG: [3, 8], DIGITAL: [6, 14] };

// Toujours présents : un OSD sans tension ni temps n'existe pas sur du vrai
// matériel. Le chronomètre est l'un des deux, jamais les deux.
const TIMERS = ['TIMER_FLIGHT', 'TIMER_ON'];

// Noms de machine. Volontairement quelconques : ce sont des drones de gens,
// pas des vaisseaux.
const CRAFT_NAMES = [
	'HUMMEL', 'FOXEER', 'APEX5', 'NAZGUL', 'KREMOWKA', 'SPARROW',
	'TBS-ETX', 'MOJITO', 'BABYTOOTH', 'VANOVER', 'GEP-MK5', 'CADX',
];

const IMPERIAL_ODDS = 0.25;
const CRAFT_NAME_ODDS = 0.40;

// Lignes plausibles pour poser un élément : les OSD réels se serrent en haut
// et en bas et laissent le centre à l'image — mais pas toujours, et c'est le
// « pas toujours » qui fait la variété.
function candidateRows(rows, rand) {
	const band = rand();
	if (band < 0.45) return Math.floor(rand() * 3);                       // haut
	if (band < 0.90) return rows - 1 - Math.floor(rand() * 3);            // bas
	return 3 + Math.floor(rand() * Math.max(1, rows - 6));                // milieu
}

export function droneOsdLayout({ seed, family, mode } = {}) {
	const style = mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';
	const rand = rngFrom(`${seed}::osd::${family}::${style}`);

	const gridPair = GRIDS[style][Math.floor(rand() * GRIDS[style].length)];
	const grid = { cols: gridPair[0], rows: gridPair[1] };
	const font = FONTS[Math.floor(rand() * FONTS.length)];
	const units = rand() < IMPERIAL_ODDS ? 'IMPERIAL' : 'METRIC';

	const hasGps = !NO_GPS_FAMILIES.includes(family);
	const craftName = rand() < CRAFT_NAME_ODDS
		? CRAFT_NAMES[Math.floor(rand() * CRAFT_NAMES.length)]
		: null;

	// Le tirage des éléments : les indispensables d'abord, puis on pioche dans
	// ce qui reste jusqu'à la densité voulue.
	const [lo, hi] = DENSITY[style];
	const wanted = lo + Math.floor(rand() * (hi - lo + 1));

	const picked = ['BAT_V', TIMERS[Math.floor(rand() * TIMERS.length)]];
	if (craftName) picked.push('CRAFT_NAME');

	const pool = ELEMENTS.filter((k) => {
		if (picked.includes(k)) return false;
		if (k === 'CRAFT_NAME') return false;        // décidé au-dessus
		if (TIMERS.includes(k)) return false;        // un seul chronomètre
		if (!hasGps && GPS_ELEMENTS.includes(k)) return false;
		return true;
	});
	// Mélange de Fisher-Yates avec le même rand : déterministe.
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	while (picked.length < wanted && pool.length > 0) picked.push(pool.pop());

	// Placement : on tente, et on renonce si ça ne rentre pas. Un OSD réel n'a
	// pas plus de garantie que ça — ce qui ne rentre pas n'est pas affiché.
	const occupied = new Map();
	const elements = [];
	for (const key of picked) {
		const w = ELEMENT_WIDTH[key];
		if (w > grid.cols) continue;
		for (let attempt = 0; attempt < 12; attempt++) {
			const row = candidateRows(grid.rows, rand);
			const col = Math.floor(rand() * (grid.cols - w + 1));
			const spans = occupied.get(row) ?? [];
			if (spans.some(([c0, c1]) => col < c1 && c0 < col + w)) continue;
			spans.push([col, col + w]);
			occupied.set(row, spans);
			elements.push({ key, col, row });
			break;
		}
	}

	return { style, grid, font, units, craftName, elements };
}
```

- [ ] **Step 4: Relancer le test**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`, section « OSD drone — layout » entièrement verte.

> Si `la densité reste dans les bornes du style` échoue par le bas : c'est le
> placement qui renonce trop souvent. Augmenter le nombre de tentatives (12) ou
> vérifier que `candidateRows` ne retourne pas toujours la même bande. Ne PAS
> relâcher la borne du test — c'est elle qui porte la promesse.

- [ ] **Step 5: Commit**

```bash
cd sim && git add tools/drone-osd-model.mjs tools/selftest.mjs
git commit -m "OSD drone : modèle de layout sur grille de caractères (PHASE 12)

Style tiré du mode vidéo de la cible, grille, police, unités, densité et
placement tirés avec elle. Les capteurs absents suivent la famille : pas
de GPS sur un toothpick, donc pas de HOME_DIST ni de GS.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3 : `lens.js` — le format de la caméra et ses bandes noires

**Files:**
- Modify: `sim/src/lens.js` (uniforms, `main()`, `setSize`, nouvelle méthode `setCamera`)
- Modify: `sim/src/main.js` (appel de `setSize`)

**Interfaces:**
- Consumes: la fiche de la Task 1 (`aspect`, `resScale`).
- Produces: `FpvLens.setCamera({ aspect, resScale })`. `FpvLens.setSize(width, height)`
  garde sa signature ; c'est `setCamera` qui décide la taille réelle des cibles
  du composer. Consommé par la Task 9.

**Vérification :** ces tâches de shader ne se testent pas en headless. Le filet
automatique est `node tools/selftest.mjs` qui doit rester vert (il ne touche pas
au rendu), et la vérification réelle est visuelle, décrite à chaque étape.

- [ ] **Step 1: Ajouter les uniforms de cadrage**

Dans `LensShader.uniforms` (`sim/src/lens.js`, autour de la ligne 119), ajouter :

```js
		uFrame: { value: new THREE.Vector2(1, 1) },
```

Et dans les déclarations du fragment shader, à côté de `uniform float uK1, uK2, uCA, uSoft, uVignette;` :

```glsl
		uniform vec2 uFrame;
```

- [ ] **Step 2: Encadrer dans `main()`**

Remplacer les deux premières lignes de `void main()` :

```glsl
			vec2 ndc = vUv * 2.0 - 1.0;
```

par :

```glsl
			// Le capteur de la cible n'a pas forcément le format de l'écran. Une
			// caméra 4:3 sur un moniteur 16:9 laisse deux bandes noires sur les
			// côtés : c'est laid, c'est vrai, et c'est le signal le plus immédiat
			// de « cette caméra est une bouse ». Encadré et non recadré — recadrer
			// rendrait le champ, et le champ est justement ce que la cible impose.
			vec2 ndc = (vUv * 2.0 - 1.0) / uFrame;
			if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) {
				gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
				return;
			}
```

Tout ce qui suit (`q`, `r`, le barillet, l'OSD, le vignettage, le lien) travaille
désormais dans le repère du capteur, donc les bandes ne sont ni vignetées ni
bruitées : elles n'existent pas dans le signal.

- [ ] **Step 3: Dimensionner les cibles au capteur**

Remplacer la méthode `setSize` (`sim/src/lens.js:738-746`) par :

```js
	// La fiche caméra de la cible : son format et sa définition interne. Le
	// rendu se fait vraiment plus bas et remonte — une mauvaise caméra est
	// réellement moins définie, et coûte réellement moins cher à rendre,
	// exactement comme la vraie.
	setCamera({ aspect = 16 / 9, resScale = 1 } = {}) {
		this._camAspect = aspect;
		this._resScale = resScale;
		this._applySize();
	}

	setSize(width, height) {
		this._viewW = width;
		this._viewH = height;
		this._applySize();
	}

	_applySize() {
		const width = this._viewW ?? 1;
		const height = this._viewH ?? 1;
		const aspect = this._camAspect ?? 16 / 9;
		const resScale = this._resScale ?? 1;
		const ratio = this.renderer.getPixelRatio();

		// Le capteur tient dans la fenêtre sans la déborder : la dimension
		// contrainte fixe l'autre. uFrame est ce rectangle en uv d'écran, et
		// c'est lui qui produit les bandes.
		const viewAspect = width / height;
		const fitW = viewAspect > aspect ? aspect / viewAspect : 1;
		const fitH = viewAspect > aspect ? 1 : viewAspect / aspect;
		this._u.uFrame.value.set(fitW, fitH);

		// Taille réelle des cibles du composer : le capteur, à sa définition.
		const sensorH = Math.max(1, Math.round(height * fitH * resScale));
		const sensorW = Math.max(1, Math.round(sensorH * aspect));
		this.composer.setPixelRatio(ratio);
		this.composer.setSize(sensorW, sensorH);
		// gl_FragCoord counts device pixels, so this has to as well — otherwise the
		// macroblock grid is the wrong size on a HiDPI display. C'est la
		// définition du CAPTEUR : un macrobloc appartient à la vidéo, pas au
		// moniteur, donc il grossit à l'écran quand la caméra est mauvaise.
		this._u.uResolution.value.set(sensorW * ratio, sensorH * ratio);
	}
```

- [ ] **Step 4: `uAspect` devient le format du capteur**

Dans `render()` (`sim/src/lens.js:761`), remplacer :

```js
		this._u.uAspect.value = camera.aspect;
```

par :

```js
		// Le format du capteur, pas celui de la fenêtre : c'est le capteur qui
		// doit être radialement symétrique sous le barillet, pas le moniteur.
		this._u.uAspect.value = this._camAspect ?? camera.aspect;
```

- [ ] **Step 5: Vérifier**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed` (inchangé — le selftest ne rend rien).

Run: `cd sim && npm run build`
Expected: build sans erreur.

Puis, dans la console du navigateur sur `npm run dev` :

```js
__sim.lens.setCamera({ aspect: 4 / 3, resScale: 0.35 });
```

Attendu : deux bandes noires franches sur les côtés, l'image nettement moins
définie, et **le vignettage qui s'arrête au bord de l'image et pas au bord de
l'écran**. Puis `__sim.lens.setCamera({ aspect: 16/9, resScale: 1 })` pour
revenir à l'état d'origine.

> Si `__sim.lens` n'existe pas, l'exposer depuis `main.js` à côté des autres
> entrées de `window.__sim` (`sim/src/main.js:329`).

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/lens.js src/main.js
git commit -m "Objectif : format et définition du capteur de la cible (PHASE 12)

Le composer est dimensionné au capteur et non à la fenêtre ; uFrame
encadre l'image, donc une caméra 4:3 laisse de vraies bandes noires que
ni le vignettage ni le bruit ne touchent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4 : `lens.js` — le bloc capteur

**Files:**
- Modify: `sim/src/lens.js` (uniforms, fragment shader, méthode `setSensor`)

**Interfaces:**
- Consumes: `sensor` de la Task 1.
- Produces: `FpvLens.setSensor({ grain, lift, saturation, ringing, clip, tintHue, tintAmount })`.
  Consommé par la Task 9.

- [ ] **Step 1: Ajouter les uniforms**

Dans `LensShader.uniforms` :

```js
		uSensor: { value: new THREE.Vector4(0, 0, 1, 0) },   // grain, lift, saturation, ringing
		uSensor2: { value: new THREE.Vector3(0, 0, 0) },     // clip, tintHue, tintAmount
```

Dans les déclarations du fragment shader :

```glsl
		uniform vec4 uSensor;
		uniform vec3 uSensor2;
```

- [ ] **Step 2: Ajouter le bloc, entre le vignettage et le lien**

Dans `main()`, juste **après** la ligne `c *= 1.0 - uVignette * pow(r, 2.5);`
(`sim/src/lens.js:453`) et **avant** le `#if LINK_MODE == 1` qui suit :

```glsl
			// ---- le capteur de la cible ---------------------------------------
			// En amont de l'émetteur, parce que c'est l'ordre physique : ce que
			// le capteur abîme, la liaison le transporte ensuite fidèlement.
			// Une mauvaise caméra est déjà mauvaise sur un lien parfait.
			{
				float clipK = uSensor2.x;
				if (clipK > 0.0) {
					// Les hautes lumières s'écrasent tôt. Un ciel qui part en blanc
					// pur au lieu de garder ses nuages : le défaut le plus
					// reconnaissable des petites caméras.
					float knee = mix(1.0, 0.55, clipK);
					c = min(c, vec3(knee)) + (c - min(c, vec3(knee))) * (1.0 - clipK);
					c /= max(knee + (1.0 - knee) * (1.0 - clipK), 1e-4);
				}

				float ring = uSensor.w;
				if (ring > 0.0) {
					// Halo de sur-accentuation : la caméra rehausse ses contours
					// elle-même, et laisse un liseré clair d'un côté, sombre de
					// l'autre. Horizontal seulement — c'est une accentuation de
					// ligne, pas un filtre 2D.
					vec2 px = vec2(1.0) / uResolution;
					vec3 l = texture2D(tDiffuse, uvHere - vec2(px.x * 2.0, 0.0)).rgb;
					vec3 rr = texture2D(tDiffuse, uvHere + vec2(px.x * 2.0, 0.0)).rgb;
					c += (c - (l + rr) * 0.5) * ring * 1.6;
				}

				// Fadeur, puis dominante, puis noirs levés. Dans cet ordre : la
				// dominante d'un capteur est dans sa matrice de couleur, donc
				// avant le niveau de noir de son amplificateur.
				float lum = dot(c, LUMA);
				c = mix(vec3(lum), c, uSensor.z);

				float amt = uSensor2.z;
				if (amt > 0.0) {
					// Teinte simple sans conversion HSV : deux caméras ne rendent
					// pas le même vert, et une bascule vers une couleur suffit à
					// le dire.
					vec3 cast = 0.5 + 0.5 * cos(6.2831853 * (uSensor2.y + vec3(0.0, 0.33, 0.67)));
					c = mix(c, c * cast * 2.0, amt);
				}

				c = c * (1.0 - uSensor.y) + uSensor.y;

				float g = uSensor.x;
				if (g > 0.0) {
					// Bruit propre au capteur, présent même sur un lien parfait :
					// c'est ce qui distingue une mauvaise caméra d'une bonne caméra
					// mal reçue.
					float sn = hash12(gl_FragCoord.xy + uTime * 17.7);
					c += (sn - 0.5) * g;
				}
				c = clamp(c, 0.0, 1.0);
			}
```

- [ ] **Step 3: Ajouter le passeur**

Dans la classe `FpvLens`, à côté de `setRain` :

```js
	// Le capteur de la cible. Tout est à zéro par défaut, sauf la saturation :
	// un uniform à zéro doit vouloir dire « rien à faire ».
	setSensor({ grain = 0, lift = 0, saturation = 1, ringing = 0,
	            clip = 0, tintHue = 0, tintAmount = 0 } = {}) {
		this._u.uSensor.value.set(grain, lift, saturation, ringing);
		this._u.uSensor2.value.set(clip, tintHue, tintAmount);
	}
```

- [ ] **Step 4: Vérifier**

Run: `cd sim && node tools/selftest.mjs` → `all checks passed`.
Run: `cd sim && npm run build` → sans erreur.

Dans la console du navigateur :

```js
__sim.lens.setSensor({ grain: 0.07, lift: 0.10, saturation: 0.70, ringing: 0.9, clip: 0.8, tintHue: 0.15, tintAmount: 0.2 });
```

Attendu : image délavée, noirs gris, ciel qui s'écrase en blanc, liserés sur les
arêtes des bâtiments, grain permanent, dominante visible. Puis
`__sim.lens.setSensor({})` pour revenir à une image propre — et elle doit
redevenir **exactement** celle d'avant la tâche.

- [ ] **Step 5: Commit**

```bash
cd sim && git add src/lens.js
git commit -m "Objectif : bloc capteur en amont de la liaison (PHASE 12)

Grain permanent, noirs levés, fadeur, halo de sur-accentuation,
écrasement des hautes lumières et dominante. Une mauvaise caméra est déjà
mauvaise sur un lien parfait.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5 : `lens.js` — le cross-color, la panne analogique qui manquait

**Files:**
- Modify: `sim/src/lens.js` (uniform, bloc `LINK_MODE == 1`, `setSensor`)

**Interfaces:**
- Consumes: `sensor.crossColor` de la Task 1.
- Produces: `setSensor` accepte en plus `crossColor` (0..1).

**Le problème :** aujourd'hui `lens.js:503` désature quand le lien meurt — la
sous-porteuse chroma est en haut de la bande vidéo et se fait manger la
première. C'est juste, mais c'est **une seule** des deux pannes, et c'est ce qui
fait que tout glitch actuel finit en noir et blanc.

L'autre est le **cross-color** : le détail de luma fin (des branches, une
grille, un toit de tuiles) tombe dans la bande de la sous-porteuse et le
décodeur l'interprète comme de la couleur. La couleur est donc *tirée du détail
de l'image* — zéro détail, zéro couleur inventée. C'est ce qui le distingue d'un
bruit RGB, et c'est ce qui le rend crédible.

- [ ] **Step 1: Ajouter l'uniform**

Dans `LensShader.uniforms` :

```js
		uCrossColor: { value: 0 },
```

Dans les déclarations du fragment shader :

```glsl
		uniform float uCrossColor;
```

- [ ] **Step 2: Arbitrer la désaturation**

Dans le bloc `#if LINK_MODE == 1`, remplacer :

```glsl
				c = mix(c, vec3(dot(c, LUMA)), 0.85 * smoothstep(0.85, 0.05, uLink));
```

par :

```glsl
				// Les deux façons de mourir d'un décodeur composite, et chaque
				// caméra tombe quelque part entre les deux. uCrossColor à 0 :
				// la sous-porteuse est mangée, l'image part en gris. À 1 : le
				// décodeur s'accroche et confond le détail avec de la couleur.
				float fadeK = smoothstep(0.85, 0.05, uLink);
				c = mix(c, vec3(dot(c, LUMA)), 0.85 * fadeK * (1.0 - uCrossColor));
```

- [ ] **Step 3: Ajouter le cross-color, juste après**

```glsl
				// Cross-color. Passe-haut horizontal de la luma à l'échelle de la
				// sous-porteuse : le décodeur prend ce détail pour une phase de
				// chrominance. La couleur sort donc de l'image et pas d'un
				// générateur de bruit — sur un ciel uni il ne se passe
				// strictement rien, et c'est exactement ce qu'il faut.
				if (uCrossColor > 0.0) {
					vec2 sub = vec2(1.0 / uResolution.x, 0.0) * 1.5;
					float l0 = dot(texture2D(tDiffuse, WRAPX(uvHere - sub)).rgb, LUMA);
					float l1 = dot(texture2D(tDiffuse, WRAPX(uvHere)).rgb, LUMA);
					float l2 = dot(texture2D(tDiffuse, WRAPX(uvHere + sub)).rgb, LUMA);
					float hp = l1 - (l0 + l2) * 0.5;
					// La phase rampe le long de la ligne et dérive dans le temps :
					// c'est ce qui fait ramper les couleurs au lieu de les figer.
					float phase = gl_FragCoord.x * 0.7 + gl_FragCoord.y * 1.7 + uTime * 6.0;
					vec3 carrier = cos(phase + vec3(0.0, 2.094, 4.189));
					c += carrier * hp * 14.0 * uCrossColor * (0.15 + 0.85 * fadeK);
					c = clamp(c, 0.0, 1.0);
				}
```

- [ ] **Step 4: Le brancher dans `setSensor`**

Modifier la signature écrite en Task 4 :

```js
	setSensor({ grain = 0, lift = 0, saturation = 1, ringing = 0,
	            clip = 0, tintHue = 0, tintAmount = 0, crossColor = 0 } = {}) {
		this._u.uSensor.value.set(grain, lift, saturation, ringing);
		this._u.uSensor2.value.set(clip, tintHue, tintAmount);
		this._u.uCrossColor.value = crossColor;
	}
```

- [ ] **Step 5: Vérifier**

Run: `cd sim && node tools/selftest.mjs` → `all checks passed`.
Run: `cd sim && npm run build` → sans erreur.

Dans le navigateur, mode de lien ANALOG (panneau Tab), puis dans la console :

```js
__sim.lens.setSensor({ crossColor: 1 });
```

et faire descendre la qualité du lien (s'éloigner, ou baisser la sévérité du
lien dans le panneau Tab). Attendu : les zones **détaillées** (arêtes de toits,
végétation) partent en couleurs saturées qui rampent, le ciel uni ne bouge pas,
et l'image ne devient **pas** grise. Avec `crossColor: 0`, retour au noir et
blanc d'avant. C'est la comparaison qui valide la tâche, pas l'un des deux seul.

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/lens.js
git commit -m "Liaison analogique : le cross-color, deuxième façon de mourir (PHASE 12)

Le détail de luma fin tombe dans la bande de la sous-porteuse et ressort
en couleur. La couleur vient donc de l'image : un ciel uni ne bouge pas.
sensor.crossColor arbitre entre la mort en gris et la mort en arc-en-ciel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6 : `src/drone-osd.js` — le peintre

**Files:**
- Create: `sim/src/drone-osd.js`

**Interfaces:**
- Consumes: `droneOsdLayout()` (Task 2).
- Produces: `class DroneOsd { constructor(layout); get texture; update(values); commit(); dispose(); }`
  où `values = { voltageV, cellV, currentA, mahUsed, altM, agiM, groundSpeedMs,
  verticalSpeedMs, throttle01, rssiDbm, linkQuality, sats, homeDistM,
  homeBearingRad, flightSeconds, headingRad, rollRad, pitchRad, escTempC, vtxChan }`.
  Consommé par les Tasks 7 et 9.

- [ ] **Step 1: Écrire le module**

```js
// PHASE 12 — l'OSD de la cible, peint dans un canvas 2D dont la texture est
// échantillonnée par le pass unique de lens.js, en amont du vignettage, du
// capteur et de la liaison. Il traverse donc tout ce que l'image traverse.
//
// Deux responsabilités séparées, et la séparation est load-bearing :
//   update()  accumule ce qu'il y aurait à afficher, ne dessine rien ;
//   commit()  redessine, et seulement si la chaîne affichée a changé.
// C'est lens.js qui décide quand commit() a le droit de tourner — voir le gel
// numérique dans son render().

import * as THREE from 'three';

// La taille d'une cellule de la grille, en pixels de canvas. Le canvas est
// dimensionné à la GRILLE de la cible et pas à la fenêtre : une incrustation
// vidéo est à résolution fixe. C'est aussi ce qui fait qu'un OSD 30×16 est
// énorme et qu'un 50×18 est fin, sans qu'aucun code n'ait à le dire.
const CELL_W = 24;
const CELL_H = 34;

const FONT_STACK = '"DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
const FONT_SCALE = { DEFAULT: 1.0, BOLD: 1.0, LARGE: 1.18, CLARITY: 0.92 };
const FONT_WEIGHT = { DEFAULT: 500, BOLD: 800, LARGE: 700, CLARITY: 600 };

const M_TO_FT = 3.28084;
const MS_TO_KMH = 3.6;
const MS_TO_MPH = 2.23694;

const pad = (n, w) => String(n).padStart(w, ' ');

export class DroneOsd {
	constructor(layout) {
		this.layout = layout;
		this.canvas = document.createElement('canvas');
		this.canvas.width = layout.grid.cols * CELL_W;
		this.canvas.height = layout.grid.rows * CELL_H;
		this.ctx = this.canvas.getContext('2d');

		this.texture = new THREE.CanvasTexture(this.canvas);
		this.texture.minFilter = THREE.LinearFilter;
		this.texture.magFilter = THREE.LinearFilter;
		this.texture.generateMipmaps = false;
		// Le canvas est déjà en sRGB non prémultiplié ; le pipeline couleur du
		// jeu est délibérément pass-through (lens.js, HANDOFF bug #10), donc
		// rien ne doit ré-encoder ici.
		this.texture.colorSpace = THREE.NoColorSpace;

		this._values = {};
		this._painted = null;
	}

	get style() { return this.layout.style; }

	update(values) { this._values = values; }

	// Redessine si et seulement si la chaîne affichée a changé. Les valeurs sont
	// arrondies à l'affichage, donc c'est quelques repeints par seconde et pas
	// soixante.
	commit() {
		const lines = this.layout.elements.map((e) => `${e.key}:${this._text(e.key)}`).join('|');
		if (lines === this._painted) return;
		this._painted = lines;
		this._paint();
		this.texture.needsUpdate = true;
	}

	dispose() { this.texture.dispose(); }

	_text(key) {
		const v = this._values;
		const imperial = this.layout.units === 'IMPERIAL';
		const dec = this.layout.style === 'DIGITAL' ? 1 : 0;
		const n = (x, d = dec) => (Number.isFinite(x) ? x.toFixed(d) : '--');

		switch (key) {
			case 'BAT_V': return `${n(v.voltageV, 1)}V`;
			case 'CELL_V': return `${n(v.cellV, 2)}V`;
			case 'CURRENT': return `${n(v.currentA, dec)}A`;
			case 'MAH': return `${pad(Math.round(v.mahUsed ?? 0), 4)}mAh`;
			case 'ALT': return imperial
				? `${Math.round((v.agiM ?? 0) * M_TO_FT)}F`
				: `${n(v.agiM, dec)}m`;
			case 'ALT_HOME': return imperial
				? `${Math.round((v.altM ?? 0) * M_TO_FT)}F`
				: `${n(v.altM, dec)}m`;
			case 'GS': return imperial
				? `${Math.round((v.groundSpeedMs ?? 0) * MS_TO_MPH)}MPH`
				: `${Math.round((v.groundSpeedMs ?? 0) * MS_TO_KMH)}KMH`;
			case 'VS': return imperial
				? `${n((v.verticalSpeedMs ?? 0) * M_TO_FT, 0)}F/S`
				: `${n(v.verticalSpeedMs, 1)}M/S`;
			case 'THR': return `${Math.round((v.throttle01 ?? 0) * 100)}%`;
			case 'RSSI': return `${Math.round(v.rssiDbm ?? 0)}dBm`;
			case 'LQ': return `LQ${Math.round((v.linkQuality ?? 0) * 100)}`;
			case 'TX_POWER': return `${v.txPowerMw ?? 25}mW`;
			case 'SATS': return `S${pad(v.sats ?? 0, 2)}`;
			case 'LATLON': return `${(v.lat ?? 0).toFixed(4)} ${(v.lon ?? 0).toFixed(4)}`;
			case 'HOME_DIST': return imperial
				? `${Math.round((v.homeDistM ?? 0) * M_TO_FT)}F`
				: `${Math.round(v.homeDistM ?? 0)}m`;
			case 'HOME_ARROW': return ARROWS[dirIndex(v.homeBearingRad, v.headingRad)];
			case 'TIMER_FLIGHT':
			case 'TIMER_ON': return clock(v.flightSeconds ?? 0);
			case 'ESC_TEMP': return `${Math.round(v.escTempC ?? 0)}C`;
			case 'EFFICIENCY': return effText(v);
			case 'VTX_CHAN': return `F${v.vtxChan ?? 4}`;
			case 'CRAFT_NAME': return this.layout.craftName ?? '';
			case 'WARNINGS': return v.warning ?? '';
			// Éléments graphiques : rien à comparer, ils sont redessinés avec le
			// reste dès qu'un chiffre bouge.
			case 'HORIZON': return `${Math.round((v.rollRad ?? 0) * 30)}/${Math.round((v.pitchRad ?? 0) * 30)}`;
			case 'HEADING_TAPE': return String(Math.round(((v.headingRad ?? 0) * 180 / Math.PI + 360) % 360));
			case 'CROSSHAIR': return '';
			default: return '';
		}
	}

	_paint() {
		const { ctx, layout } = this;
		const { cols, rows } = layout.grid;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		const scale = FONT_SCALE[layout.font] ?? 1;
		ctx.font = `${FONT_WEIGHT[layout.font] ?? 500} ${Math.round(CELL_H * 0.72 * scale)}px ${FONT_STACK}`;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';

		// Blanc bordé de noir : c'est ce que fait un MAX7456, et c'est la seule
		// façon de rester lisible sur un ciel blanc comme sur du bitume.
		ctx.lineJoin = 'round';
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
		ctx.lineWidth = layout.style === 'ANALOG' ? 5 : 3;
		ctx.fillStyle = '#fff';

		for (const e of layout.elements) {
			const x = e.col * CELL_W;
			const y = e.row * CELL_H + CELL_H * 0.5;
			if (e.key === 'CROSSHAIR') { this._crosshair(x, y); continue; }
			if (e.key === 'HORIZON') { this._horizon(); continue; }
			const text = this._text(e.key);
			if (!text) continue;
			ctx.strokeText(text, x, y);
			ctx.fillText(text, x, y);
		}
	}

	_crosshair(x, y) {
		const { ctx } = this;
		ctx.save();
		ctx.lineWidth = 3;
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		ctx.beginPath();
		ctx.moveTo(x, y); ctx.lineTo(x + CELL_W * 3, y);
		ctx.stroke();
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.restore();
	}

	// L'horizon artificiel : deux traits qui basculent avec le roulis et
	// glissent avec le tangage, au centre de l'image. Il n'a pas de place dans
	// la grille — comme sur du vrai matériel, il est posé par-dessus.
	_horizon() {
		const { ctx } = this;
		const v = this._values;
		const cx = this.canvas.width * 0.5;
		const cy = this.canvas.height * 0.5 + (v.pitchRad ?? 0) * this.canvas.height * 0.5;
		const half = this.canvas.width * 0.22;
		const dy = Math.tan(v.rollRad ?? 0) * half;
		ctx.save();
		ctx.lineWidth = 5;
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		for (const s of [-1, 1]) {
			ctx.beginPath();
			ctx.moveTo(cx + s * half * 0.35, cy + s * dy * 0.35);
			ctx.lineTo(cx + s * half, cy + s * dy);
			ctx.stroke();
		}
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 2;
		for (const s of [-1, 1]) {
			ctx.beginPath();
			ctx.moveTo(cx + s * half * 0.35, cy + s * dy * 0.35);
			ctx.lineTo(cx + s * half, cy + s * dy);
			ctx.stroke();
		}
		ctx.restore();
	}
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

function dirIndex(bearingRad, headingRad) {
	const rel = (bearingRad ?? 0) - (headingRad ?? 0);
	return ((Math.round((rel / (Math.PI * 2)) * 8) % 8) + 8) % 8;
}

function clock(seconds) {
	const s = Math.max(0, Math.floor(seconds));
	return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function effText(v) {
	const km = (v.homeDistM ?? 0) / 1000;
	if (km < 0.01) return '---';
	return `${Math.round((v.mahUsed ?? 0) / km)}mAh/km`;
}
```

- [ ] **Step 2: Vérifier que le module se charge**

Run: `cd sim && npm run build`
Expected: build sans erreur (le module est importé à la Task 9 ; ici on vérifie
seulement qu'il ne casse pas la compilation s'il est déjà référencé).

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed` (inchangé).

- [ ] **Step 3: Commit**

```bash
cd sim && git add src/drone-osd.js
git commit -m "OSD drone : le peintre canvas et sa texture (PHASE 12)

update() accumule, commit() redessine si la chaîne affichée a changé —
la séparation existe pour que lens.js puisse geler l'OSD avec l'image.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7 : `lens.js` — composer l'OSD drone dans le pass

**Files:**
- Modify: `sim/src/lens.js` (uniform, `defines`, fragment shader, `setOsd`, `render`, `_syncDefines`)

**Interfaces:**
- Consumes: `DroneOsd` (Task 6).
- Produces: `FpvLens.setOsd(osd | null)`. Consommé par la Task 9.

- [ ] **Step 1: Uniform et define**

Dans `LensShader.defines`, ajouter `OSD: 0` :

```js
	defines: { TAPS: MAX_TAPS, LINK_MODE: LINK_OFF, DROPS: 0, GLARE: 0, OSD: 0 },
```

Dans `uniforms` :

```js
		uOsd: { value: null },
```

Dans les déclarations du fragment shader :

```glsl
		#if OSD
			uniform sampler2D uOsd;
		#endif
```

- [ ] **Step 2: Composer, avant le vignettage**

Dans `main()`, juste **avant** la ligne `c *= 1.0 - uVignette * pow(r, 2.5);` :

```glsl
			// ---- l'OSD de la cible ---------------------------------------------
			// Échantillonné à uvHere, la coordonnée déjà distordue par le
			// barillet : l'OSD subit donc l'optique gratuitement. Pas d'aberration
			// chromatique dessus — c'est une incrustation monochrome, séparer les
			// canaux n'aurait pas de sens.
			//
			// Ici et pas ailleurs : après le flou, parce que l'OSD est collé au
			// capteur et ne smeare pas quand la caméra tourne ; après les gouttes,
			// parce que l'eau est sur le verre en amont ; avant le vignettage, le
			// capteur et la liaison, parce que c'est ce qui fait que perdre le
			// lien coûte de l'information.
			#if OSD
			{
				vec4 osd = texture2D(uOsd, uvHere);
				c = mix(c, osd.rgb, osd.a);
			}
			#endif
```

- [ ] **Step 3: Le passeur et la recompilation**

Dans la classe `FpvLens`, à côté de `setSensor` :

```js
	// L'OSD est donné une fois, pas à chaque image : c'est lens qui sait quelle
	// image est gelée, donc c'est lens qui a le droit d'appeler commit().
	// setOsd(null) recompile le shader sans l'OSD — c'est le levier du A/B de
	// mesure et le repli si le coût est mauvais.
	setOsd(osd) {
		this._osd = osd ?? null;
		this._u.uOsd.value = osd ? osd.texture : null;
		this._syncDefines();
	}
```

Dans `_syncDefines()` (la méthode autour de `sim/src/lens.js:726-735`), ajouter
`OSD` à la comparaison et à l'affectation, sur le modèle exact de `GLARE` :

```js
		const osd = this._osd ? 1 : 0;
		if (taps === this._taps && defines.LINK_MODE === this._linkMode
			&& defines.DROPS === this._dropBucket && defines.GLARE === glare
			&& defines.OSD === osd) return;
		defines.OSD = osd;
```

(`defines.OSD = osd;` va à côté des autres affectations de `defines`, avant le
`needsUpdate`.)

- [ ] **Step 4: Geler l'OSD avec l'image**

Dans `render()`, juste après la ligne `this._updateDrops(frozen ? 0 : this._rain.dt);` :

```js
		// L'OSD a traversé la même liaison que l'image : sur une image perdue il
		// gèle avec elle. Le laisser se rafraîchir afficherait des chiffres à
		// jour par-dessus un monde figé — l'inverse exact de ce que le lien
		// raconte.
		if (this._osd && !frozen) this._osd.commit();
```

- [ ] **Step 5: Vérifier**

Run: `cd sim && node tools/selftest.mjs` → `all checks passed`.
Run: `cd sim && npm run build` → sans erreur.

La vérification visuelle réelle vient à la Task 9, quand `main.js` fournit un
OSD. Ici, contrôler seulement qu'avec `OSD: 0` (aucun `setOsd`) l'image est
**exactement** celle d'avant la tâche : un `#define` à zéro doit compiler le
bloc hors du shader.

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/lens.js
git commit -m "Objectif : composer l'OSD drone dans le pass unique (PHASE 12)

Un fetch de texture aux UV déjà distordues, avant vignettage, capteur et
liaison. Gelé avec l'image en mode numérique : commit() n'est appelé que
sur une image non perdue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8 : `src/fpvtp-osd.js` — la couche locale, en anglais

**Files:**
- Create: `sim/src/fpvtp-osd.js`
- Modify: `sim/src/style.css` (styles de la nouvelle couche)

**Interfaces:**
- Consumes: rien.
- Produces: `class FpvtpOsd { constructor(root); update(values); setPaused(b); setSessionStatus(text, kind); setCrashed(b); }`
  avec `values = { mode, rates, usingGamepad, fps, windMs, windRelRad, visibilityM, rssiDbm, operator, sessionSeconds, propwash }`.
  Plus `export const FPVTP_VERSION = '0.97b';`. Consommé par la Task 9.

- [ ] **Step 1: Écrire le module**

```js
// PHASE 12 — l'OSD FPVTP!, la couche locale. Injectée par notre station,
// au-dessus de l'image reçue : elle ne traverse pas la liaison, donc rien ne la
// dégrade. C'est la moitié stable du double HUD.
//
// Toujours métrique, même quand la cible affiche des pieds : c'est NOTRE
// station. Le désaccord entre les deux systèmes fait partie du propos.

// Constante de lore, pas une version de paquet.
export const FPVTP_VERSION = '0.97b';

// D'où le vent pousse, dans le repère du drone : l'index 0 est droit devant.
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

const clock = (s) => {
	const t = Math.max(0, Math.floor(s));
	return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export class FpvtpOsd {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
			<div id="fpvtp-osd" hidden>
				<div class="corner tl">
					<div id="fo-ident">FPVTP! // ${FPVTP_VERSION}</div>
					<div id="fo-operator">OPERATOR // —</div>
					<div id="fo-session">SESSION 00:00</div>
				</div>
				<div class="corner tr">
					<div id="fo-mode">ACRO</div>
					<div id="fo-rates">—</div>
					<div id="fo-input">KEYBOARD</div>
					<div id="fo-fps">—</div>
				</div>
				<div class="corner bl">
					<div id="fo-env">WIND — · VIS — · LINK —</div>
				</div>
				<div id="fo-crash" hidden>SIGNAL LOST<small>PRESS R</small></div>
				<div id="fo-pause" hidden>PAUSED<small>PRESS SPACE</small></div>
				<div id="fo-status" hidden></div>
				<div id="fo-reticle"></div>
			</div>`);

		const q = (s) => root.querySelector(s);
		this.el = {
			root: q('#fpvtp-osd'),
			operator: q('#fo-operator'),
			session: q('#fo-session'),
			mode: q('#fo-mode'),
			rates: q('#fo-rates'),
			input: q('#fo-input'),
			fps: q('#fo-fps'),
			env: q('#fo-env'),
			crash: q('#fo-crash'),
			pause: q('#fo-pause'),
			status: q('#fo-status'),
			reticle: q('#fo-reticle'),
		};
		this._frames = 0;
		this._fpsAt = performance.now();
		this._fps = 0;
	}

	show() { this.el.root.hidden = false; }
	setPaused(paused) { this.el.pause.hidden = !paused; }
	setCrashed(crashed) { this.el.crash.hidden = !crashed; }

	// Verdict de fin de session (PHASE 06). kind: 'landed' | 'lost' | null.
	setSessionStatus(text, kind = null) {
		const e = this.el.status;
		if (!text) { e.hidden = true; return; }
		e.innerHTML = text;
		if (kind) e.dataset.kind = kind; else delete e.dataset.kind;
		e.hidden = false;
	}

	get fps() { return this._fps; }

	update({ mode, rates, usingGamepad, windMs, windRelRad, visibilityM,
	         rssiDbm, operator, sessionSeconds, propwash }) {
		this.el.mode.textContent = String(mode).toUpperCase();
		if (rates) this.el.rates.textContent = rates;
		this.el.input.textContent = usingGamepad ? 'GAMEPAD' : 'KEYBOARD';
		this.el.operator.textContent = `OPERATOR // ${operator ?? '—'}`;
		this.el.session.textContent = `SESSION ${clock(sessionSeconds ?? 0)}`;

		// Une seule ligne d'environnement : trois nombres que l'opérateur lit
		// d'un coup, pas trois blocs qui se disputent un coin.
		const parts = [];
		if (Number.isFinite(windMs) && windMs >= 0.5) {
			const i = ((Math.round(((windRelRad ?? 0) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
			parts.push(`WIND ${windMs.toFixed(1)} m/s ${ARROWS[i]}`);
		} else {
			parts.push('WIND CALM');
		}
		if (Number.isFinite(visibilityM)) parts.push(`VIS ${(visibilityM / 1000).toFixed(1)} km`);
		if (Number.isFinite(rssiDbm)) parts.push(`LINK ${Math.round(rssiDbm)} dBm`);
		this.el.env.textContent = parts.join(' · ');

		// Le propwash est invisible sur un HUD immobile, donc le réticule
		// frissonne avec (repris tel quel de hud.js).
		if (propwash !== undefined) {
			this.el.reticle.style.opacity = propwash > 0.05 ? String(1 - 0.4 * propwash) : '1';
		}

		this._frames++;
		const now = performance.now();
		if (now - this._fpsAt > 500) {
			this._fps = Math.round(this._frames * 1000 / (now - this._fpsAt));
			this.el.fps.textContent = `${this._fps} fps`;
			this._frames = 0;
			this._fpsAt = now;
		}
	}
}
```

- [ ] **Step 2: Ajouter les styles**

Dans `sim/src/style.css`, à la suite des règles `.corner` existantes :

```css
/* PHASE 12 — la couche locale. Au-dessus de tout, bandes noires comprises :
   elle ne traverse pas la liaison, donc rien ne la dégrade. Le traitement
   ci-dessous est purement décoratif — il empêche seulement la couche de
   flotter au-dessus de l'image comme un overlay de navigateur. */
#fpvtp-osd {
	position: absolute;
	inset: 0;
	pointer-events: none;
	font-size: 13px;
	line-height: 1.6;
	letter-spacing: .04em;
	color: #e8f0f4;
	text-shadow: var(--shadow);
	/* Très doux, et sur la couche seule : ce n'est pas le vignettage de
	   l'objectif, qui lui est dans le shader et deux boîtes plus haut. */
	mask-image: radial-gradient(ellipse 120% 120% at 50% 50%, #000 60%, rgba(0, 0, 0, .82) 100%);
}
#fpvtp-osd .corner { position: absolute; }
#fpvtp-osd .tl { top: 12px; left: 14px; }
#fpvtp-osd .tr { top: 12px; right: 14px; text-align: right; }
#fpvtp-osd .bl { bottom: 12px; left: 14px; }
#fo-ident { color: var(--accent); }
#fo-rates, #fo-input, #fo-fps { font-size: 12px; opacity: .6; }
#fo-env { font-size: 12px; opacity: .8; }
#fo-crash, #fo-pause, #fo-status {
	position: absolute;
	left: 50%;
	top: 42%;
	transform: translate(-50%, -50%);
	text-align: center;
	font-size: 28px;
	letter-spacing: .18em;
}
#fo-crash small, #fo-pause small, #fo-status small {
	display: block;
	font-size: 12px;
	letter-spacing: .1em;
	opacity: .7;
}
#fo-reticle {
	position: absolute;
	left: 50%;
	top: 50%;
	width: 14px;
	height: 14px;
	margin: -7px 0 0 -7px;
	border: 1px solid rgba(232, 240, 244, .55);
	border-radius: 50%;
}
```

- [ ] **Step 3: Vérifier**

Run: `cd sim && npm run build` → sans erreur.
Run: `cd sim && node tools/selftest.mjs` → `all checks passed`.

- [ ] **Step 4: Commit**

```bash
cd sim && git add src/fpvtp-osd.js src/style.css
git commit -m "OSD FPVTP! : la couche locale, en anglais (PHASE 12)

Identité, opérateur, horloge de session, vent, visibilité, lien, plus
mode / rates / entrée / fps et les états de vol. Toujours métrique, même
quand la cible affiche des pieds : c'est notre station.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9 : Câblage — `main.js`, `hud.js`, `settings.js`

**Files:**
- Modify: `sim/src/main.js`
- Modify: `sim/src/hud.js` (retirer l'OSD de vol, garder l'écran de chargement)
- Modify: `sim/src/settings.js` (supprimer les sliders FOV / uptilt, accueillir l'aide clavier)
- Modify: `sim/src/style.css` (retirer les règles devenues mortes)

**Interfaces:**
- Consumes: `targetCamera` (T1), `droneOsdLayout` (T2), `FpvLens.setCamera` /
  `setSensor` / `setOsd` (T3, T4, T5, T7), `DroneOsd` (T6), `FpvtpOsd` (T8).
- Produces: le jeu complet. Rien en aval.

- [ ] **Step 1: Retirer l'OSD de vol de `hud.js`**

Dans `sim/src/hud.js` : supprimer le bloc `<div id="hud" hidden> … </div>` de
l'`insertAdjacentHTML`, toutes les entrées de `this.el` qui le référencent (`hud`,
`alt`, `spd`, `mode`, `src`, `fps`, `preset`, `volts`, `amps`, `battFill`,
`batt`, `windHud`, `thr`, `crash`, `pause`, `sessionStatus`, `reticle`, `rssi`),
ainsi que les méthodes `update()`, `setPaused()` et `setSessionStatus()`, et les
compteurs `_frames` / `_fpsAt`. Garder `progress`, `detail`, `show`,
`startClock`, `setStage`, `fail`, `ready`.

Mettre à jour l'en-tête du fichier :

```js
// Écran de chargement. Le menu des cartes est devenu le terminal opérateur
// (terminal.js), le panneau Tab est parti dans settings.js, et l'OSD de vol
// s'est scindé en deux couches à la PHASE 12 (drone-osd.js et fpvtp-osd.js).
// Il ne reste ici que le chargement — PHASE 13 le déplacera derrière le TARGET
// SCAN.
```

`ready()` ne doit plus démasquer `#hud` : il ne masque plus que `#loading`.

- [ ] **Step 2: Supprimer les sliders FOV / uptilt et déplacer l'aide**

Dans `sim/src/settings.js` : supprimer les deux `<label>` FOV et Uptilt du
panneau (lignes 83-84), les entrées `fov`, `fovVal`, `tilt`, `tiltVal` de
`this.el`, et la méthode `setCamera(fov, tilt, onChange)` en entier.

À la place, sous le titre `<h2>Caméra</h2>`, poser la fiche en lecture et
l'aide clavier — c'est la seule chose extra-diégétique qui reste, et elle n'est
visible que sur appel du menu :

```html
				<h2>Caméra</h2>
				<div id="cam-spec" class="spec">—</div>
				<h2>Commandes</h2>
				<div id="keymap" class="spec">
					<b>W/S</b> throttle · <b>A/D</b> yaw · <b>arrows</b>/mouse roll-pitch<br>
					<b>R</b> respawn · <b>J</b> disarm · <b>M</b> mode · <b>P</b> rates<br>
					<b>C</b> free camera · <b>Space</b> pause · <b>Tab</b> settings
				</div>
```

et la méthode qui la remplit :

```js
	// La fiche de la caméra de la cible, en lecture seule. Le drone n'est pas le
	// tien : son champ et son inclinaison ne se règlent pas.
	setCameraSpec({ fovDeg, uptiltDeg, aspectName, resScale }) {
		this.el.camSpec.textContent =
			`${Math.round(fovDeg)}° FOV · ${Math.round(uptiltDeg)}° UPTILT · ${aspectName} · ${Math.round(resScale * 100)}%`;
	}
```

avec `camSpec: el.querySelector('#cam-spec'),` ajouté à `this.el`.

- [ ] **Step 3: Câbler dans `main.js`**

Imports, à côté des autres :

```js
import { targetCamera } from '../tools/target-camera.mjs';
import { droneOsdLayout } from '../tools/drone-osd-model.mjs';
import { DroneOsd } from './drone-osd.js';
import { FpvtpOsd } from './fpvtp-osd.js';
```

À côté de `const hud = new Hud(...)` :

```js
const fpvtpOsd = new FpvtpOsd(document.getElementById('ui'));
let droneOsd = null;
let camSpec = null;
```

Remplacer le bloc `settings.setCamera(cameraFov, cameraTilt, …)`
(`sim/src/main.js:296-301`) — les sliders n'existent plus — par une fonction qui
applique la fiche de la cible :

```js
// La caméra de la cible : appliquée une fois, au moment où l'on prend la main.
// Elle touche le champ, l'inclinaison, le format, la définition et le capteur —
// et rien d'autre : le vol n'en dépend pas.
function applyTargetCamera(spec) {
	camSpec = spec;
	cameraFov = spec.fovDeg;
	cameraTilt = spec.uptiltDeg;
	camera.fov = spec.fovDeg;
	camera.aspect = spec.aspect;
	camera.updateProjectionMatrix();
	lens.setCamera({ aspect: spec.aspect, resScale: spec.resScale });
	lens.setSensor(spec.sensor);
	rainfall?.setSize(innerHeight * renderer.getPixelRatio(), spec.fovDeg);
	settings.setCameraSpec(spec);
}
```

Là où la cible est connue — dans le bloc d'ouverture de session
(`sim/src/main.js:886-901`), après `const tgt = session.current()?.target;` — et
avec un repli quand il n'y en a pas :

```js
	// La graine : la cible si on en a une, la famille du profil sinon (mode dev,
	// ?scene=). Il y a toujours une caméra et toujours un OSD.
	const seed = session.current()?.id ?? `dev::${PROFILE.family}`;
	const family = tgt?.family ?? PROFILE.family;
	const mode = tgt?.signal?.mode === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';

	applyTargetCamera(targetCamera({ seed, family }));

	droneOsd?.dispose();
	droneOsd = new DroneOsd(droneOsdLayout({ seed, family, mode }));
	lens.setOsd(droneOsd);
	fpvtpOsd.show();
	console.log(`[camera] ${camSpec.aspectName} ${Math.round(camSpec.fovDeg)}° uptilt ${Math.round(camSpec.uptiltDeg)}° res ${Math.round(camSpec.resScale * 100)}%`);
```

**Les cinq valeurs qui n'existent pas encore dans `main.js`.** Vérifié dans le
code : seul `yawOf` et `spawnY` existent. Ajouter, à côté de `yawOf`
(`sim/src/main.js:536`) :

```js
// Roulis et tangage, pour l'horizon artificiel de l'OSD drone. Même convention
// de quaternion que yawOf juste au-dessus.
function rollOf(q) {
	return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.z * q.z + q.x * q.x));
}
function pitchOf(q) {
	return Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z))));
}
```

À côté de `let spawnY = 0;` (`sim/src/main.js:128`) :

```js
// Le point de départ complet, pas seulement son altitude : l'OSD drone affiche
// une distance au point de décollage, donc il lui faut les trois coordonnées.
let spawnX = 0;
let spawnZ = 0;
// L'horloge de vol, en horloge murale : elle continue de tourner pendant une
// pause, comme sur du vrai matériel.
let sessionStartedAt = 0;
```

et les remplir là où `spawnY` est rempli (`sim/src/main.js:884`) :

```js
	spawnX = physics.position.x;
	spawnZ = physics.position.z;
	sessionStartedAt = Date.now();
```

**Les trois noms de propriété à ne pas inventer.** Vérifiés dans le code :

- la batterie expose `usedMah` et `capacityMah` (`src/quad.js:70,82`), **pas**
  `mahUsed` ;
- la visibilité combinée brouillard + pluie est
  `fogRange(fog.density + extinctionOf(rain.visibility))`, le motif exact déjà
  utilisé en `sim/src/main.js:409` — `fog.visibility` n'existe pas, `fog.range`
  est la portée du brouillard seul ;
- la latitude et la longitude viennent de `manifest.origin` et de la position
  locale ENU (X=est, Y=haut, Z=sud — donc le nord est `-z`) :

```js
// Latitude/longitude affichées par l'OSD des cibles qui ont un GPS. Approximation
// plate, ce qui est très largement suffisant sur une scène de deux kilomètres.
function latLonOf(p) {
	const o = sceneManifest.origin;
	const lat = o.latitude + (-p.z) / 111320;
	return { lat, lon: o.longitude + p.x / (111320 * Math.cos(lat * Math.PI / 180)) };
}
```

`sceneManifest` est le manifeste de la scène ; s'il n'est pas déjà une variable
de module dans `main.js`, l'y hisser depuis `boot()` (une seule ligne : `let
sceneManifest = null;` en tête, `sceneManifest = manifest;` dans `boot()`).

Remplacer l'appel `hud.update({...})` (`sim/src/main.js:731-745`) par les deux
appels des deux couches :

```js
	const here = latLonOf(p);
	droneOsd?.update({
		voltageV: bat.voltage,
		cellV: bat.voltage / PROFILE.battery.cells,
		currentA: bat.current,
		mahUsed: bat.usedMah,
		altM: p.y - spawnY,
		agiM: ground === null ? null : p.y - ground,
		groundSpeedMs: Math.hypot(v.x, v.z),
		verticalSpeedMs: v.y,
		throttle01: sticks.throttle,
		rssiDbm: link.out.rssiDbm,
		linkQuality: link.out.quality,
		sats: 12,
		lat: here.lat,
		lon: here.lon,
		homeDistM: Math.hypot(p.x - spawnX, p.z - spawnZ),
		homeBearingRad: Math.atan2(spawnX - p.x, spawnZ - p.z),
		headingRad: yawOf(physics.rotation),
		rollRad: rollOf(physics.rotation),
		pitchRad: pitchOf(physics.rotation),
		flightSeconds: (Date.now() - sessionStartedAt) / 1000,
		// Normalisé sur la poussée de vol stationnaire et pas sur MAX_THRUST, qui
		// n'est pas importé dans main.js : pas d'import nouveau pour un chiffre
		// décoratif.
		escTempC: 34 + 22 * physics.propulsion.thrust / (PROFILE.mass * 9.81),
		vtxChan: 4,
		// Les avertissements d'un OSD réel ne sont pas décoratifs : ils sont ce
		// qui reste lisible quand tout le reste est bruité.
		warning: bat.voltage / PROFILE.battery.cells < 3.4 ? 'LOW VOLTAGE'
			: link.out.quality < 0.25 ? 'RXLOSS' : '',
	});

	fpvtpOsd.update({
		mode: freeCamOn ? 'FREE CAM' : controller.mode,
		rates: RATE_PRESETS[controller.preset].label,
		usingGamepad: input.usingGamepad,
		windMs: Math.hypot(physics.wind.out.x, physics.wind.out.z),
		windRelRad: Math.atan2(physics.wind.out.x, physics.wind.out.z) - yawOf(physics.rotation),
		// La visibilité réellement vue, brouillard ET pluie : le motif exact déjà
		// employé en main.js:409, pour que les deux ne disent jamais deux choses.
		visibilityM: fogRange(fog.density + extinctionOf(rain.visibility)),
		rssiDbm: link.out.rssiDbm,
		operator: operator.getOperator()?.name,
		sessionSeconds: (Date.now() - sessionStartedAt) / 1000,
		propwash: physics.propulsion.propwash,
	});
	fpvtpOsd.setCrashed(crashed);
```

Remplacer enfin les trois appels restants :
- `hud.setPaused(paused)` → `fpvtpOsd.setPaused(paused)` ;
- `hud.setSessionStatus(...)` (trois occurrences : lignes 481, 486, 496, 624) →
  `fpvtpOsd.setSessionStatus(...)`, avec les textes traduits :
  `'TARGET STATUS<small>LANDED</small>'`, `'DISARMED<small>FREE FALL</small>'`,
  `'TARGET LOST<small>SESSION TERMINATED</small>'` ;
- `Number(hud.el.fps.textContent...)` (ligne 354) → `fpvtpOsd.fps`.

- [ ] **Step 4: Nettoyer le CSS mort**

Dans `sim/src/style.css`, supprimer les règles qui ne visent plus rien :
`#hud`, `#alt`, `#spd`, `#mode`, `#preset`, `#src`, `#fps`, `#rssi`,
`#wind-hud`, `#batt`, `#batt-fill`, `#thr-fill`, `.throttle`, `#help`,
`#crash`, `#pause`, `#session-status`, `#reticle`. Garder `.corner` si l'écran
de chargement l'utilise encore ; sinon la supprimer aussi.

Ajouter la règle du bloc `.spec` du panneau Tab :

```css
.panel .spec { font-size: 12px; opacity: .7; line-height: 1.7; margin-bottom: 10px; }
.panel .spec b { color: var(--accent); font-weight: 600; }
```

- [ ] **Step 5: Vérifier**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

Run: `cd sim && npm run build`
Expected: build sans erreur, et **aucun avertissement d'import non résolu**.

Puis `npm run dev`, et vérifier dans le navigateur, en vol :

1. les deux couches sont là et **se chevauchent** par endroits — c'est voulu ;
2. couper le lien (s'éloigner, ou monter la sévérité dans le panneau Tab) :
   l'OSD drone se bruite, se macrobloque et gèle ; l'OSD FPVTP! **ne bouge pas
   d'un pixel** ;
3. relancer trois sessions sur trois cibles de familles différentes : trois
   images visiblement différentes (format, définition, champ, inclinaison) et
   trois OSD visiblement différents ;
4. `Tab` : le champ, l'uptilt, le format et la définition sont affichés en
   lecture, l'aide clavier est là, **et il n'y a plus aucun slider de caméra** ;
5. aucune erreur dans la console.

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/main.js src/hud.js src/settings.js src/style.css
git commit -m "Double HUD : câblage des deux couches (PHASE 12)

hud.js ne garde que l'écran de chargement. La caméra et l'OSD de la cible
sont appliqués à l'ouverture de session ; les sliders FOV/uptilt
disparaissent au profit d'une fiche en lecture, et l'aide clavier quitte
l'écran de vol pour le panneau Tab.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10 : Mesurer le coût GPU

**Files:**
- Create: `sim/tools/measure-osd-cost.md` (protocole et résultats)
- Modify: `sim/HANDOFF.md`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: des chiffres. L'issue #49 demande « coût GPU mesuré » : sans les
  chiffres la phase n'est pas finie.

- [ ] **Step 1: Exposer les leviers de mesure**

Vérifier que `window.__sim` expose `lens`. Sinon, l'ajouter à côté des autres
entrées (`sim/src/main.js:329`). Les quatre configurations se pilotent depuis la
console :

```js
// A — référence : ni OSD ni capteur
__sim.lens.setOsd(null); __sim.lens.setSensor({});
// B — OSD seul
__sim.lens.setOsd(__sim.droneOsd); __sim.lens.setSensor({});
// C — capteur seul
__sim.lens.setOsd(null); __sim.lens.setSensor(__sim.camSpec.sensor);
// D — les deux
__sim.lens.setOsd(__sim.droneOsd); __sim.lens.setSensor(__sim.camSpec.sensor);
```

Exposer `droneOsd` et `camSpec` sur `window.__sim` pour que ce soit possible.

- [ ] **Step 2: Mesurer**

Même scène, même trajectoire (caméra libre immobile, pour que la mesure porte
sur le pass et pas sur le pilotage), résolution fixe, 600 images par
configuration. Coller dans la console :

```js
window.__measure = async (frames = 600) => {
	const t = [];
	let last = performance.now();
	await new Promise((done) => {
		const tick = () => {
			const now = performance.now();
			t.push(now - last);
			last = now;
			if (t.length < frames) requestAnimationFrame(tick); else done();
		};
		requestAnimationFrame(tick);
	});
	t.sort((a, b) => a - b);
	const mean = t.reduce((s, x) => s + x, 0) / t.length;
	return { mean: +mean.toFixed(3), p95: +t[Math.floor(t.length * 0.95)].toFixed(3) };
};
```

et lancer `await __measure()` après chaque configuration A → D.

- [ ] **Step 3: Écrire les résultats**

Créer `sim/tools/measure-osd-cost.md` avec le protocole ci-dessus, la machine et
le GPU utilisés, la définition de fenêtre, et le tableau des quatre mesures
(moyenne et p95).

Reporter la conclusion dans `sim/HANDOFF.md`, section vérifiée, en une ligne
factuelle du type : « PHASE 12 — surcoût mesuré du double OSD et du bloc capteur :
+X,XX ms/image en moyenne (mesuré le 2026-08-29, <GPU>, 1920×1080). »

**Si le surcoût dépasse 0,5 ms/image**, ne pas conclure : l'issue demande que
deux couches de plus ne coûtent pas des images par seconde. Ouvrir une issue de
suivi avec les chiffres et le dire dans le rapport — ne pas « arrondir » la
mesure vers le bas.

- [ ] **Step 4: Commit**

```bash
cd sim && git add tools/measure-osd-cost.md HANDOFF.md
git commit -m "Double HUD : coût GPU mesuré (PHASE 12)

Quatre configurations, 600 images chacune, moyenne et p95. Protocole et
chiffres dans tools/measure-osd-cost.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11 : Documentation et suivi

**Files:**
- Modify: `sim/HANDOFF.md`
- Modify: `docs/manuel.md` (si les commandes ou les modules y sont listés)

- [ ] **Step 1: Mettre `HANDOFF.md` à jour**

Section vérifiée : ce qui a été constaté dans le navigateur (les deux couches,
la dégradation asymétrique, trois cibles trois images). Section non vérifiée :
ce qui ne l'a pas été. Ne pas écrire « fonctionne » pour ce qui n'a pas été vu
tourner.

- [ ] **Step 2: Ouvrir les issues de suivi**

```bash
gh issue create --repo lionrayonnant/FPVThePlanet \
  --title "Panneau Tab : passer les libellés en anglais" \
  --label roadmap-da \
  --body "PHASE 12 a mis les deux couches d'OSD en anglais, mais le panneau Tab (Manette, Caméra, Objectif, Lien vidéo, Son) est resté en français. La passe d'anglais globale est PHASE 19 (#56) ; cette issue est le rappel du reliquat laissé par PHASE 12."
```

Et, **seulement si la mesure de la Task 10 a dépassé 0,5 ms/image**, une issue
de performance avec les chiffres.

- [ ] **Step 3: Commit et fermeture**

```bash
cd sim && git add HANDOFF.md README.md
git commit -m "PHASE 12 — documentation du double HUD

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Pousser la branche, ouvrir la PR vers `main`, et fermer #49 une fois la PR
mergée (le passage à Done sur le Project 2 suit la fermeture).

---

## Notes pour l'exécutant

**Conflit de merge attendu.** `tools/selftest.mjs` est aussi modifié par la
branche `phase-11-entry-state`, qui ajoute sa propre section au même endroit
(avant les deux dernières lignes). Le conflit est mécanique : garder les deux
sections, l'une après l'autre. Ne pas résoudre en supprimant l'une des deux.

**Ce qui n'est pas testable en headless.** Les Tasks 3 à 9 touchent au shader et
au DOM. Le filet automatique est `node tools/selftest.mjs`, qui doit rester vert
parce qu'il ne rend rien — il ne prouve donc **pas** que le rendu est correct. Ce
qui le prouve est la vérification navigateur écrite dans chaque tâche. Ne pas la
sauter et ne pas la déclarer faite sans l'avoir faite.

**Le repli.** Si le coût mesuré est mauvais, `setOsd(null)` recompile le shader
sans l'OSD et le jeu reste jouable. C'est pour ça que l'OSD est un `#define` et
pas un uniform.
