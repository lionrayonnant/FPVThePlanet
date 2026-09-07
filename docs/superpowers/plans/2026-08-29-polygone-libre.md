# Sélection par polygone libre — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de délimiter une zone d'acquisition par un polygone libre au lieu d'un seul rectangle, de bout en bout — carte, API dev, exporter Go, cache, `scenes.json`.

**Architecture:** Le prédicat « cette tuile touche-t-elle le tracé ? » existe en deux ports — Go pour l'extraction, JS pour l'affichage — parce que `tiles.mjs` est déjà, par convention du dépôt, « un portage littéral du Go (pkg/mth) ». Une fixture JSON partagée (`flyover-reverse-engineering/testdata/poly-cases.json`) est lue par un test Go et par un selftest JS : c'est le seul garde-fou contre une dérive qui, autrement, ne se verrait qu'en re-téléchargeant plusieurs gigaoctets. Le port JS est validé le premier contre des cas raisonnés à la main ; la fixture est ensuite *générée* depuis ce port validé, et le Go s'y conforme.

**Tech Stack:** Go 1.x (`pkg/mth`, `cmd/export-obj`), Node ESM (`sim/tools/`), Leaflet + Geoman (`sim/src/scanner.js`, `sim/tools/map-gui/main.js`).

**Spec:** [`docs/superpowers/specs/2026-08-29-polygone-libre-design.md`](../specs/2026-08-29-polygone-libre-design.md)

## Global Constraints

- **Représentation unique d'un anneau :** un `number[]` plat `[lat, lon, lat, lon, …]`, longueur paire ≥ 6, **refermé implicitement** (le dernier sommet se relie au premier ; ne jamais répéter le premier sommet en fin de liste). C'est exactement la forme de l'argument `--poly`, donc aucune couche de conversion nulle part.
- **Règle de rétention d'une tuile :** intersection. Une tuile est retenue dès que le tracé la touche, même d'un coin. La zone extraite est toujours un **sur-ensemble** de ce qui est dessiné, comme l'est déjà le rectangle arrondi sur le treillis.
- **Chaîne canonique :** `ring.map(v => v.toFixed(6)).join(',')` en JS, `strconv.FormatFloat(v, 'f', 6, 64)` joint par `","` en Go. 6 décimales, comme les `%f` existants de `exportDir`.
- **Hash de cache :** `sha256(chaîne canonique)` en hexadécimal, **12 premiers caractères**. Répertoire : `poly-<hash>-<zoom>-<tryH>`.
- **`--poly` et `--bbox` sont exclusifs.** Passer les deux est une erreur d'usage, pas une précédence silencieuse.
- **Bornes de validation :** 3 à 200 sommets ; toutes les valeurs finies ; `lat ∈ [-85, 85]`, `lon ∈ [-180, 180]` ; aire non nulle ; emprise en longitude < 180° (rejet de l'antiméridien).
- **Langue :** interface, logs du jeu et texte à l'écran en **anglais** (D5). Issues, commits, commentaires de code et documentation interne en **français**.
- `npm run selftest` et `npm run selftest:operator` restent verts à chaque tâche.
- Commits normaux sans confirmation ; jamais de force-push.

---

### Task 1: Géométrie du polygone, port JS

Le port JS d'abord, validé contre des cas raisonnés à la main. C'est lui qui servira de référence à la fixture, donc il doit être juste avant que quoi que ce soit d'autre s'appuie dessus.

**Files:**
- Modify: `sim/tools/lib/tiles.mjs` (ajouts en fin de fichier)
- Create: `sim/tools/map-poly-selftest.mjs`
- Modify: `sim/package.json:12` (chaîne `selftest:operator`)

**Interfaces:**
- Consumes: `tileGrid`, `tileTMSToLatLon`, `earthRadiusByLatitude` (déjà dans `tiles.mjs`)
- Produces:
  - `polygonBounds(ring) -> {south, west, north, east}`
  - `pointInPolygon(lat, lon, ring) -> boolean`
  - `segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) -> boolean` (x = lon, y = lat)
  - `tileIntersectsPolygon(ring, box) -> boolean`, `box = {south, west, north, east}`
  - `polygonGrid(ring, zoom) -> {...tileGrid(...), keep: Uint8Array, columns: number, masked: number}`
  - `maskKeys(grid) -> string[]` trié, éléments `"x/y"`
  - `polygonArea(ring) -> number` (m²)
  - `canonicalPoly(ring) -> string`
  - `polyHash(ring) -> Promise<string>` (12 hex)

> `polyHash` est asynchrone parce que `crypto.subtle.digest` l'est, et que `tiles.mjs` doit rester importable par le navigateur — il ne peut pas faire `import crypto from 'node:crypto'`. Les appelants Node (`add-map-core.mjs`) sont déjà `async`.

- [ ] **Step 1: Écrire le selftest qui échoue**

Créer `sim/tools/map-poly-selftest.mjs` :

```js
// Selftest de la géométrie de polygone partagée (issue #30). Aucune E/S réseau,
// aucun DOM. Lancer : node tools/map-poly-selftest.mjs
//
// Ces cas sont raisonnés à la main, pas relevés depuis l'implémentation : c'est
// ce port JS qui sert ensuite de référence à testdata/poly-cases.json, donc il
// ne peut pas se valider sur sa propre sortie.
import assert from 'node:assert/strict';
import {
	polygonBounds, pointInPolygon, segmentsIntersect, tileIntersectsPolygon,
	polygonGrid, maskKeys, polygonArea, canonicalPoly, polyHash,
	tileGrid, tileTMSToLatLon,
} from './lib/tiles.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const at = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Un carré de 0.01° autour de (48.85, 2.30).
const SQUARE = [48.845, 2.295, 48.845, 2.305, 48.855, 2.305, 48.855, 2.295];

t('polygonBounds : l\'emprise du tracé', () => {
	assert.deepEqual(polygonBounds(SQUARE),
		{ south: 48.845, west: 2.295, north: 48.855, east: 2.305 });
});

t('pointInPolygon : dedans, dehors, et le centre d\'un L est dehors', () => {
	assert.equal(pointInPolygon(48.85, 2.30, SQUARE), true);
	assert.equal(pointInPolygon(48.86, 2.30, SQUARE), false);
	// Un L dont le centre de l'emprise tombe dans l'encoche : c'est le cas qui
	// casse une sonde visant le centre de la bbox.
	const L_SHAPE = [0, 0, 0, 10, 4, 10, 4, 4, 10, 4, 10, 0];
	assert.equal(pointInPolygon(5, 5, L_SHAPE), false, 'centre de l\'emprise, hors du L');
	assert.equal(pointInPolygon(2, 2, L_SHAPE), true);
	assert.equal(pointInPolygon(8, 2, L_SHAPE), true);
});

t('segmentsIntersect : croisement, disjoint, colinéaire, touche par un bout', () => {
	assert.equal(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0), true, 'croix');
	assert.equal(segmentsIntersect(0, 0, 1, 1, 5, 5, 6, 6), false, 'disjoints');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0), true, 'colinéaires chevauchants');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 10, 0, 10, 10), true, 'bout à bout');
	assert.equal(segmentsIntersect(0, 0, 10, 0, 11, 0, 20, 0), false, 'colinéaires disjoints');
});

t('tileIntersectsPolygon : les quatre façons de se toucher', () => {
	const box = { south: 0, west: 0, north: 1, east: 1 };
	// Tuile entièrement dans le tracé : aucun sommet dans la tuile, aucune arête
	// qui la croise — seul un coin de tuile testé contre le tracé le voit.
	assert.equal(tileIntersectsPolygon([-5, -5, -5, 5, 5, 5, 5, -5], box), true, 'tuile incluse');
	// Tracé entièrement dans la tuile : symétrique.
	assert.equal(tileIntersectsPolygon([.2, .2, .2, .8, .8, .8, .8, .2], box), true, 'tracé inclus');
	// Le tracé traverse la tuile de part en part.
	assert.equal(tileIntersectsPolygon([.4, -5, .6, -5, .6, 5, .4, 5], box), true, 'traversée');
	// Le tracé ne mord que le coin nord-est.
	assert.equal(tileIntersectsPolygon([.9, .9, .9, 5, 5, 5, 5, .9], box), true, 'un coin');
	assert.equal(tileIntersectsPolygon([2, 2, 2, 3, 3, 3, 3, 2], box), false, 'à côté');
});

t('polygonGrid : la grille est celle de l\'emprise, le masque en retire des colonnes', () => {
	// Un triangle rectangle : environ la moitié de son emprise, mais la règle est
	// l'intersection, donc strictement plus que la moitié.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const box = tileGrid(polygonBounds(TRI), 20);
	assert.equal(g.cols, box.cols, 'même emprise que la bbox');
	assert.equal(g.rows, box.rows);
	assert.equal(g.keep.length, box.cols * box.rows);
	assert.ok(g.columns < box.columns, 'le masque retire des colonnes');
	assert.ok(g.columns > box.columns / 2, 'mais plus que la moitié : on arrondit vers l\'extérieur');
	assert.equal(g.columns + g.masked, box.columns, 'gardées + masquées = toute l\'emprise');
});

t('polygonGrid : un tracé plus fin qu\'une tuile rend quand même des colonnes', () => {
	// ~2 m de large au zoom 20, où la tuile fait ~25 m. Une règle « centre dans
	// le tracé » rendrait zéro ; la règle d'intersection couvre le corridor.
	const THIN = [48.8500, 2.2950, 48.8500, 2.3050, 48.85002, 2.3050, 48.85002, 2.2950];
	const g = polygonGrid(THIN, 20);
	assert.ok(g.columns >= 1, 'au moins une colonne');
	assert.equal(g.rows <= 2, true, 'une ou deux rangées, pas plus');
});

t('polygonGrid : un carré aligné sur le treillis ne garde que ses tuiles', () => {
	// On construit le tracé SUR les bords de tuiles : le résultat doit être
	// exactement le bloc de tuiles correspondant, sans rab.
	const z = 20;
	const a = tileTMSToLatLon(z, 500000, 400000);
	const b = tileTMSToLatLon(z, 500003, 400002);
	const ring = [a.lat, a.lon, a.lat, b.lon, b.lat, b.lon, b.lat, a.lon];
	const g = polygonGrid(ring, z);
	assert.equal(g.columns, g.cols * g.rows, 'aucune tuile masquée');
	assert.equal(g.masked, 0);
});

t('maskKeys : trié, une clé par tuile gardée', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const keys = maskKeys(g);
	assert.equal(keys.length, g.columns);
	assert.deepEqual(keys, [...keys].sort(), 'ordre stable');
	assert.match(keys[0], /^\d+\/\d+$/);
});

t('polygonArea : l\'aire du tracé, pas celle de l\'emprise', () => {
	const g = polygonBounds(SQUARE);
	// Le carré : son aire vaut celle de son emprise, à 0.5 % près.
	const R = 6371000, rad = Math.PI / 180;
	const expected = (0.01 * rad * R) * (0.01 * rad * R * Math.cos(48.85 * rad));
	assert.ok(Math.abs(polygonArea(SQUARE) - expected) / expected < 0.005, 'carré ≈ son emprise');
	// Le triangle rectangle : la moitié, à 1 % près.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	assert.ok(Math.abs(polygonArea(TRI) - expected / 2) / (expected / 2) < 0.01, 'triangle ≈ la moitié');
	assert.ok(polygonArea(SQUARE) > 0, 'toujours positive');
	// Le sens de parcours ne change pas l'aire.
	const REVERSED = [];
	for (let i = SQUARE.length - 2; i >= 0; i -= 2) REVERSED.push(SQUARE[i], SQUARE[i + 1]);
	assert.ok(Math.abs(polygonArea(REVERSED) - polygonArea(SQUARE)) < 1e-6, 'horaire = antihoraire');
});

t('canonicalPoly : 6 décimales, comme les %f du Go', () => {
	assert.equal(canonicalPoly([1, 2, 3, 4, 5, 6]),
		'1.000000,2.000000,3.000000,4.000000,5.000000,6.000000');
	assert.equal(canonicalPoly([48.8582001234, 2.2969876543, 1, 2, 3, 4]).split(',')[0], '48.858200');
});

await at('polyHash : 12 hex, stable, sensible au moindre sommet', async () => {
	const h = await polyHash(SQUARE);
	assert.match(h, /^[0-9a-f]{12}$/);
	assert.equal(h, await polyHash(SQUARE), 'stable');
	const moved = [...SQUARE]; moved[0] += 0.000001;
	assert.notEqual(h, await polyHash(moved), 'un micro-degré change le hash');
});

console.log(`\n${n} vérifications, tout passe.`);
```

- [ ] **Step 2: Lancer le selftest, vérifier qu'il échoue**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: FAIL — `SyntaxError: The requested module './lib/tiles.mjs' does not provide an export named 'polygonBounds'`

- [ ] **Step 3: Écrire l'implémentation**

Ajouter à la fin de `sim/tools/lib/tiles.mjs` :

```js
// ------------------------------------------------------------------ polygones
//
// Un anneau est un tableau plat [lat, lon, lat, lon, …], refermé implicitement.
// C'est exactement la forme de l'option --poly de l'exporter : une seule
// représentation du tracé, du clic de souris jusqu'à l'argv du sous-processus.
//
// Tout ce bloc a un jumeau en Go dans pkg/mth/poly.go. Les deux sont tenus
// d'accord par testdata/poly-cases.json — une dérive ne se verrait sinon qu'au
// moment où le nom du dossier de cache diverge, c'est-à-dire en re-téléchargeant
// plusieurs gigaoctets.

export function polygonBounds(ring) {
	let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
	for (let i = 0; i < ring.length; i += 2) {
		if (ring[i] < south) south = ring[i];
		if (ring[i] > north) north = ring[i];
		if (ring[i + 1] < west) west = ring[i + 1];
		if (ring[i + 1] > east) east = ring[i + 1];
	}
	return { south, west, north, east };
}

// Lancer de rayon. Le point sur une arête n'a pas de réponse stable ici — c'est
// sans conséquence : tileIntersectsPolygon teste aussi les arêtes, donc une
// tuile dont un coin est pile sur le tracé est retenue par le test de croisement.
export function pointInPolygon(lat, lon, ring) {
	const n = ring.length / 2;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const yi = ring[2 * i], xi = ring[2 * i + 1];
		const yj = ring[2 * j], xj = ring[2 * j + 1];
		if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

// x = lon, y = lat. Les cas colinéaires comptent comme une intersection : deux
// segments qui se touchent bout à bout se touchent bel et bien, et c'est ce qui
// fait qu'une tuile rasée par une arête est retenue plutôt qu'oubliée.
function cross(ax, ay, bx, by, cx, cy) {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function onSegment(ax, ay, bx, by, px, py) {
	return Math.min(ax, bx) <= px && px <= Math.max(ax, bx)
		&& Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
	const d1 = cross(cx, cy, dx, dy, ax, ay);
	const d2 = cross(cx, cy, dx, dy, bx, by);
	const d3 = cross(ax, ay, bx, by, cx, cy);
	const d4 = cross(ax, ay, bx, by, dx, dy);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
	if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
	if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
	if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
	return false;
}

// Les trois façons dont un carré et un anneau se touchent, et elles sont
// nécessaires toutes les trois : un sommet dans la tuile (tracé inclus dans la
// tuile), un coin de tuile dans le tracé (tuile incluse dans le tracé), ou une
// arête qui en croise une autre (le cas courant).
export function tileIntersectsPolygon(ring, box) {
	for (let i = 0; i < ring.length; i += 2) {
		const lat = ring[i], lon = ring[i + 1];
		if (lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east) return true;
	}
	if (pointInPolygon(box.south, box.west, ring)) return true;

	const corners = [
		[box.west, box.south], [box.east, box.south],
		[box.east, box.north], [box.west, box.north],
	];
	const n = ring.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const ay = ring[2 * j], ax = ring[2 * j + 1];
		const by = ring[2 * i], bx = ring[2 * i + 1];
		for (let k = 0; k < 4; k++) {
			const [cx, cy] = corners[k], [dx, dy] = corners[(k + 1) % 4];
			if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
		}
	}
	return false;
}

// La grille balayée pour un tracé : celle de son emprise, plus le masque des
// tuiles réellement retenues. `columns` remplace grid.columns partout où le coût
// est calculé — c'est le seul chiffre qui compte pour le téléchargement.
export function polygonGrid(ring, zoom) {
	const grid = tileGrid(polygonBounds(ring), zoom);
	const keep = new Uint8Array(grid.cols * grid.rows);
	let columns = 0;
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		const sw = tileTMSToLatLon(zoom, grid.xMin, y);
		const ne = tileTMSToLatLon(zoom, grid.xMin, y + 1);
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			const w = tileTMSToLatLon(zoom, x, y).lon;
			const e = tileTMSToLatLon(zoom, x + 1, y).lon;
			if (tileIntersectsPolygon(ring, { south: sw.lat, west: w, north: ne.lat, east: e })) {
				keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)] = 1;
				columns++;
			}
		}
	}
	return { ...grid, keep, columns, masked: grid.cols * grid.rows - columns };
}

// Les tuiles retenues, en clés « x/y » triées — la forme comparable d'un masque,
// et ce que la fixture partagée contient.
export function maskKeys(grid) {
	const keys = [];
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)]) keys.push(`${x}/${y}`);
		}
	}
	return keys.sort();
}

// Aire du tracé en m², par la formule du lacet sur une projection
// équirectangulaire locale. Sur un corridor le long d'un fleuve elle vaut deux
// ou trois fois moins que l'aire de l'emprise : afficher l'emprise comme
// « surface de la zone » serait un mensonge.
export function polygonArea(ring) {
	const b = polygonBounds(ring);
	const lat0 = (b.south + b.north) / 2;
	const R = earthRadiusByLatitude(lat0);
	const rad = Math.PI / 180;
	const kx = rad * R * Math.cos(lat0 * rad), ky = rad * R;
	const n = ring.length / 2;
	let sum = 0;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		sum += (ring[2 * j + 1] * kx) * (ring[2 * i] * ky) - (ring[2 * i + 1] * kx) * (ring[2 * j] * ky);
	}
	return Math.abs(sum) / 2;
}

// 6 décimales : c'est ce que rend le %f du Go, et c'est ce hash qui nomme le
// dossier de cache. Les deux ports doivent rendre la même chaîne au caractère près.
export function canonicalPoly(ring) {
	return Array.from(ring, (v) => v.toFixed(6)).join(',');
}

// Asynchrone parce que crypto.subtle l'est : tiles.mjs doit rester importable
// par le navigateur, il ne peut donc pas faire `import crypto from 'node:crypto'`.
export async function polyHash(ring) {
	const bytes = new TextEncoder().encode(canonicalPoly(ring));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
```

- [ ] **Step 4: Lancer le selftest, vérifier qu'il passe**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: PASS, `11 vérifications, tout passe.`

- [ ] **Step 5: Brancher le selftest sur la chaîne du projet**

Dans `sim/package.json:12`, ajouter `&& node tools/map-poly-selftest.mjs` à la fin de la valeur de `selftest:operator`.

Run: `cd sim && npm run selftest:operator`
Expected: PASS de bout en bout.

- [ ] **Step 6: Commit**

```bash
git add sim/tools/lib/tiles.mjs sim/tools/map-poly-selftest.mjs sim/package.json
git commit -m "Géométrie de polygone partagée : masque de tuiles par intersection (#30)

Une tuile est retenue dès que le tracé la touche : la zone extraite reste
un sur-ensemble de ce qui est dessiné, comme l'est déjà le rectangle
arrondi sur le treillis. Un corridor plus fin qu'une tuile reste donc
extractible, là où une règle « centre dans le tracé » rendrait zéro colonne.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Escalier et point de sonde

Deux fonctions de plus dans le même fichier, mais elles servent des consommateurs différents (le dessin, et la sonde de couverture) et méritent leur propre cycle de test.

**Files:**
- Modify: `sim/tools/lib/tiles.mjs`
- Modify: `sim/tools/map-poly-selftest.mjs`

**Interfaces:**
- Consumes: `polygonGrid`, `maskKeys`, `tileTMSToLatLon` (Task 1)
- Produces:
  - `maskOutline(grid, zoom) -> [[lat, lon], [lat, lon]][]` — les segments du contour, prêts pour un `L.polyline` multiple
  - `polygonProbePoint(ring, zoom) -> {lat, lon}` — le centre d'une tuile *retenue*, celle la plus proche du centroïde de l'emprise

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `sim/tools/map-poly-selftest.mjs`, avant la ligne `console.log` finale, et compléter l'`import` en tête avec `maskOutline, polygonProbePoint` :

```js
t('maskOutline : le contour d\'un bloc plein est son périmètre, pas ses lignes internes', () => {
	const z = 20;
	const a = tileTMSToLatLon(z, 500000, 400000);
	const b = tileTMSToLatLon(z, 500003, 400002);
	const ring = [a.lat, a.lon, a.lat, b.lon, b.lat, b.lon, b.lat, a.lon];
	const g = polygonGrid(ring, z);
	// Un bloc 3×2 plein : 3+3 segments horizontaux + 2+2 verticaux = 10.
	assert.equal(g.cols, 3);
	assert.equal(g.rows, 2);
	assert.equal(maskOutline(g, z).length, 10, 'le périmètre, pas les 12 arêtes internes');
});

t('maskOutline : un tracé masqué rend un contour plus long qu\'un rectangle', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const segs = maskOutline(g, 20);
	assert.ok(segs.length > 2 * (g.cols + g.rows), 'l\'escalier est plus long que le périmètre de l\'emprise');
	for (const s of segs) {
		assert.equal(s.length, 2);
		assert.equal(s[0].length, 2, '[lat, lon]');
	}
});

t('polygonProbePoint : dans le tracé même quand le centroïde ne l\'est pas', () => {
	// Un L à l'échelle d'une ville : le centre de son emprise tombe dans
	// l'encoche. Viser ce centre ferait juger une zone qu'on n'extrait pas.
	const L_SHAPE = [48.840, 2.280, 48.840, 2.320, 48.850, 2.320, 48.850, 2.290, 48.870, 2.290, 48.870, 2.280];
	const centre = { lat: 48.855, lon: 2.300 };
	assert.equal(pointInPolygon(centre.lat, centre.lon, L_SHAPE), false, 'le centroïde est bien hors du L');

	const p = polygonProbePoint(L_SHAPE, 20);
	const g = polygonGrid(L_SHAPE, 20);
	const { x, y } = latLonToTileTMS(20, p.lat, p.lon);
	assert.equal(g.keep[(y - g.yMin) * g.cols + (x - g.xMin)], 1, 'la sonde vise une tuile retenue');
});

t('polygonProbePoint : déterministe', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	assert.deepEqual(polygonProbePoint(TRI, 20), polygonProbePoint(TRI, 20));
});
```

Compléter aussi l'`import` avec `latLonToTileTMS`.

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: FAIL — `does not provide an export named 'maskOutline'`

- [ ] **Step 3: Implémenter**

Ajouter à la fin de `sim/tools/lib/tiles.mjs` :

```js
// Le contour de la zone retenue : les arêtes qu'une tuile gardée ne partage pas
// avec une autre tuile gardée. C'est l'escalier — la forme réellement extraite,
// par opposition au tracé lisse que l'utilisateur a dessiné. Rendu en segments
// plutôt qu'en anneaux cousus : Leaflet accepte un tableau de segments comme
// polyligne multiple, et recoudre des anneaux n'apporterait rien à l'écran.
export function maskOutline(grid, zoom) {
	const kept = (x, y) => x >= grid.xMin && x <= grid.xMax && y >= grid.yMin && y <= grid.yMax
		&& grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)] === 1;

	const segs = [];
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (!kept(x, y)) continue;
			const s = tileTMSToLatLon(zoom, x, y).lat, n = tileTMSToLatLon(zoom, x, y + 1).lat;
			const w = tileTMSToLatLon(zoom, x, y).lon, e = tileTMSToLatLon(zoom, x + 1, y).lon;
			if (!kept(x, y - 1)) segs.push([[s, w], [s, e]]);
			if (!kept(x, y + 1)) segs.push([[n, w], [n, e]]);
			if (!kept(x - 1, y)) segs.push([[s, w], [n, w]]);
			if (!kept(x + 1, y)) segs.push([[s, e], [n, e]]);
		}
	}
	return segs;
}

// Où sonder la couverture Flyover pour un tracé. Le centre de l'emprise ne
// convient pas : sur un croissant le long d'un fleuve, ou sur un L, il tombe
// HORS du tracé, et la sonde rendrait son verdict sur une zone qu'on n'extrait
// pas. On vise donc le centre de la tuile retenue la plus proche du centroïde.
export function polygonProbePoint(ring, zoom) {
	const grid = polygonGrid(ring, zoom);
	const b = polygonBounds(ring);
	const cLat = (b.south + b.north) / 2, cLon = (b.west + b.east) / 2;

	let best = null, bestD = Infinity;
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (!grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)]) continue;
			const lat = (tileTMSToLatLon(zoom, x, y).lat + tileTMSToLatLon(zoom, x, y + 1).lat) / 2;
			const lon = (tileTMSToLatLon(zoom, x, y).lon + tileTMSToLatLon(zoom, x + 1, y).lon) / 2;
			const d = (lat - cLat) ** 2 + (lon - cLon) ** 2;
			// Strictement inférieur : à égalité, la première tuile dans l'ordre
			// (y puis x) gagne, et la sonde reste reproductible.
			if (d < bestD) { bestD = d; best = { lat, lon }; }
		}
	}
	return best ?? { lat: cLat, lon: cLon };
}
```

- [ ] **Step 4: Lancer, vérifier que ça passe**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: PASS, 15 vérifications.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/lib/tiles.mjs sim/tools/map-poly-selftest.mjs
git commit -m "Contour en escalier et point de sonde du polygone (#30)

La sonde de couverture ne peut plus viser le centre de l'emprise : sur un
L ou un croissant, ce point est hors du tracé et jugerait une zone qu'on
n'extrait pas. Elle vise la tuile retenue la plus proche du centroïde.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Fixture partagée et port Go

Le port Go se conforme au port JS, et la fixture est ce qui les tient d'accord pour de bon.

**Files:**
- Create: `sim/tools/gen-poly-fixture.mjs`
- Create: `flyover-reverse-engineering/testdata/poly-cases.json` (généré)
- Create: `flyover-reverse-engineering/pkg/mth/poly.go`
- Create: `flyover-reverse-engineering/pkg/mth/poly_test.go`
- Modify: `sim/tools/map-poly-selftest.mjs`

**Interfaces:**
- Consumes: tout ce que produisent Tasks 1 et 2
- Produces (Go, package `mth`) :
  - `type Ring []float64`
  - `func (r Ring) Bounds() (south, west, north, east float64)`
  - `func (r Ring) ContainsPoint(lat, lon float64) bool`
  - `func (r Ring) IntersectsBox(south, west, north, east float64) bool`
  - `func (r Ring) TileKept(zoom, x, y int) bool`
  - `func (r Ring) Canonical() string`
  - `func (r Ring) Hash() string`
- Produces (fixture) : un tableau d'objets `{name, ring, zoom, bounds, columns, masked, keys, areaM2, canonical, hash}`

- [ ] **Step 1: Écrire le générateur de fixture**

Créer `sim/tools/gen-poly-fixture.mjs` :

```js
// Génère testdata/poly-cases.json depuis le port JS de la géométrie de polygone.
// Lancer : node tools/gen-poly-fixture.mjs
//
// Le sens de la manœuvre : le port JS est validé le premier, contre des cas
// raisonnés à la main dans map-poly-selftest.mjs. La fixture fige ensuite ce
// port validé, et pkg/mth/poly_test.go y conforme le Go. La fixture n'est donc
// pas « la vérité » — elle est le procès-verbal d'un port déjà vérifié, et elle
// existe pour que la dérive entre les deux se voie tout de suite plutôt qu'en
// re-téléchargeant plusieurs gigaoctets.
//
// Ne pas régénérer pour faire taire un test qui échoue : si le Go et le JS ne
// disent plus la même chose, l'un des deux a un bug.
import fs from 'node:fs';
import path from 'node:path';
import { polygonBounds, polygonGrid, maskKeys, polygonArea, canonicalPoly, polyHash } from './lib/tiles.mjs';
import { FLYOVER_ROOT } from './lib/add-map-core.mjs';

const CASES = [
	{ name: 'carré', zoom: 20, ring: [48.845, 2.295, 48.845, 2.305, 48.855, 2.305, 48.855, 2.295] },
	{ name: 'triangle rectangle', zoom: 20, ring: [48.845, 2.295, 48.845, 2.305, 48.855, 2.295] },
	{ name: 'L (centroïde hors du tracé)', zoom: 20,
	  ring: [48.840, 2.280, 48.840, 2.320, 48.850, 2.320, 48.850, 2.290, 48.870, 2.290, 48.870, 2.280] },
	{ name: 'corridor plus fin qu\'une tuile', zoom: 20,
	  ring: [48.8500, 2.2950, 48.8500, 2.3050, 48.85002, 2.3050, 48.85002, 2.2950] },
	{ name: 'corridor en diagonale', zoom: 20,
	  ring: [48.8500, 2.2950, 48.8505, 2.2950, 48.8560, 2.3050, 48.8555, 2.3050] },
	{ name: 'concave en U', zoom: 19,
	  ring: [48.840, 2.280, 48.840, 2.320, 48.845, 2.320, 48.845, 2.290, 48.860, 2.290, 48.860, 2.320, 48.865, 2.320, 48.865, 2.280] },
	{ name: 'sens horaire', zoom: 20, ring: [48.845, 2.295, 48.855, 2.295, 48.855, 2.305, 48.845, 2.305] },
	{ name: 'hémisphère sud', zoom: 20, ring: [-33.870, 151.200, -33.870, 151.215, -33.860, 151.215] },
	{ name: 'longitude négative', zoom: 20, ring: [34.050, -118.250, 34.050, -118.235, 34.060, -118.235] },
	{ name: 'zoom bas', zoom: 16, ring: [48.82, 2.26, 48.82, 2.40, 48.90, 2.40, 48.90, 2.26] },
];

const out = [];
for (const c of CASES) {
	const grid = polygonGrid(c.ring, c.zoom);
	out.push({
		name: c.name, ring: c.ring, zoom: c.zoom,
		bounds: polygonBounds(c.ring),
		grid: { xMin: grid.xMin, xMax: grid.xMax, yMin: grid.yMin, yMax: grid.yMax, cols: grid.cols, rows: grid.rows },
		columns: grid.columns,
		masked: grid.masked,
		keys: maskKeys(grid),
		areaM2: polygonArea(c.ring),
		canonical: canonicalPoly(c.ring),
		hash: await polyHash(c.ring),
	});
}

const dest = path.join(FLYOVER_ROOT, 'testdata/poly-cases.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, '\t') + '\n');
console.log(`${out.length} cas écrits dans ${dest}`);
```

- [ ] **Step 2: Générer la fixture**

Run: `cd sim && node tools/gen-poly-fixture.mjs`
Expected: `10 cas écrits dans …/flyover-reverse-engineering/testdata/poly-cases.json`

- [ ] **Step 3: Faire relire la fixture par le selftest JS**

Ajouter à `sim/tools/map-poly-selftest.mjs`, avant le `console.log` final :

```js
// La fixture est le procès-verbal du port JS validé ci-dessus. La relire ici
// fait que toute modification de tiles.mjs qui change un résultat casse ce
// selftest AVANT de casser le Go — et rappelle qu'il faut alors comprendre
// pourquoi, pas régénérer.
await at('fixture partagée : tiles.mjs est resté d\'accord avec elle', async () => {
	const fixture = JSON.parse(
		fs.readFileSync(new URL('../../flyover-reverse-engineering/testdata/poly-cases.json', import.meta.url), 'utf8'));
	assert.ok(fixture.length >= 10, 'la fixture a des cas');
	for (const c of fixture) {
		const g = polygonGrid(c.ring, c.zoom);
		assert.equal(g.columns, c.columns, `${c.name} : colonnes`);
		assert.equal(g.masked, c.masked, `${c.name} : masquées`);
		assert.deepEqual(maskKeys(g), c.keys, `${c.name} : tuiles retenues`);
		assert.deepEqual(polygonBounds(c.ring), c.bounds, `${c.name} : emprise`);
		assert.equal(canonicalPoly(c.ring), c.canonical, `${c.name} : chaîne canonique`);
		assert.equal(await polyHash(c.ring), c.hash, `${c.name} : hash`);
		assert.ok(Math.abs(polygonArea(c.ring) - c.areaM2) < 1e-6, `${c.name} : aire`);
	}
});
```

Ajouter `import fs from 'node:fs';` en tête du fichier.

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: PASS, 16 vérifications.

- [ ] **Step 4: Écrire le test Go qui échoue**

Créer `flyover-reverse-engineering/pkg/mth/poly_test.go` :

```go
package mth

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
)

// polyCase est un cas de ../../testdata/poly-cases.json, généré depuis le port
// JS de la même géométrie (sim/tools/gen-poly-fixture.mjs). Ce test conforme le
// Go à ce port : les deux nomment le dossier de cache, et une divergence
// coûterait un re-téléchargement complet.
type polyCase struct {
	Name   string    `json:"name"`
	Ring   []float64 `json:"ring"`
	Zoom   int       `json:"zoom"`
	Bounds struct {
		South float64 `json:"south"`
		West  float64 `json:"west"`
		North float64 `json:"north"`
		East  float64 `json:"east"`
	} `json:"bounds"`
	Grid struct {
		XMin int `json:"xMin"`
		XMax int `json:"xMax"`
		YMin int `json:"yMin"`
		YMax int `json:"yMax"`
	} `json:"grid"`
	Columns   int      `json:"columns"`
	Masked    int      `json:"masked"`
	Keys      []string `json:"keys"`
	Canonical string   `json:"canonical"`
	Hash      string   `json:"hash"`
}

func loadCases(t *testing.T) []polyCase {
	t.Helper()
	b, err := os.ReadFile("../../testdata/poly-cases.json")
	if err != nil {
		t.Fatalf("fixture illisible : %v", err)
	}
	var cases []polyCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("fixture invalide : %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("fixture vide")
	}
	return cases
}

func TestRingBounds(t *testing.T) {
	for _, c := range loadCases(t) {
		s, w, n, e := Ring(c.Ring).Bounds()
		if s != c.Bounds.South || w != c.Bounds.West || n != c.Bounds.North || e != c.Bounds.East {
			t.Errorf("%s: bounds = %v,%v,%v,%v, want %v,%v,%v,%v",
				c.Name, s, w, n, e, c.Bounds.South, c.Bounds.West, c.Bounds.North, c.Bounds.East)
		}
	}
}

func TestRingTileMask(t *testing.T) {
	for _, c := range loadCases(t) {
		r := Ring(c.Ring)
		var keys []string
		for y := c.Grid.YMin; y <= c.Grid.YMax; y++ {
			for x := c.Grid.XMin; x <= c.Grid.XMax; x++ {
				if r.TileKept(c.Zoom, x, y) {
					keys = append(keys, fmt.Sprintf("%d/%d", x, y))
				}
			}
		}
		sort.Strings(keys)
		if len(keys) != c.Columns {
			t.Errorf("%s: %d colonnes, want %d", c.Name, len(keys), c.Columns)
		}
		want := append([]string(nil), c.Keys...)
		sort.Strings(want)
		if len(keys) == len(want) {
			for i := range keys {
				if keys[i] != want[i] {
					t.Errorf("%s: tuile %d = %s, want %s", c.Name, i, keys[i], want[i])
					break
				}
			}
		}
	}
}

func TestRingCanonicalAndHash(t *testing.T) {
	for _, c := range loadCases(t) {
		r := Ring(c.Ring)
		if got := r.Canonical(); got != c.Canonical {
			t.Errorf("%s: canonical = %q, want %q", c.Name, got, c.Canonical)
		}
		// Le hash nomme le dossier de cache : une divergence ici coûte un
		// re-téléchargement complet, silencieusement.
		if got := r.Hash(); got != c.Hash {
			t.Errorf("%s: hash = %q, want %q", c.Name, got, c.Hash)
		}
	}
}

func TestRingContainsPoint(t *testing.T) {
	// Un L dont le centre de l'emprise tombe dans l'encoche.
	l := Ring{0, 0, 0, 10, 4, 10, 4, 4, 10, 4, 10, 0}
	for _, tc := range []struct {
		lat, lon float64
		want     bool
	}{
		{2, 2, true}, {8, 2, true}, {5, 5, false}, {-1, 5, false}, {2, 12, false},
	} {
		if got := l.ContainsPoint(tc.lat, tc.lon); got != tc.want {
			t.Errorf("ContainsPoint(%v, %v) = %v, want %v", tc.lat, tc.lon, got, tc.want)
		}
	}
}

func TestRingIntersectsBox(t *testing.T) {
	for _, tc := range []struct {
		name string
		ring Ring
		want bool
	}{
		{"tuile incluse dans le tracé", Ring{-5, -5, -5, 5, 5, 5, 5, -5}, true},
		{"tracé inclus dans la tuile", Ring{.2, .2, .2, .8, .8, .8, .8, .2}, true},
		{"traversée", Ring{.4, -5, .6, -5, .6, 5, .4, 5}, true},
		{"un coin", Ring{.9, .9, .9, 5, 5, 5, 5, .9}, true},
		{"à côté", Ring{2, 2, 2, 3, 3, 3, 3, 2}, false},
	} {
		if got := tc.ring.IntersectsBox(0, 0, 1, 1); got != tc.want {
			t.Errorf("%s: IntersectsBox = %v, want %v", tc.name, got, tc.want)
		}
	}
}
```

Run: `cd flyover-reverse-engineering && go test ./pkg/mth/`
Expected: FAIL — `undefined: Ring`

- [ ] **Step 5: Écrire le port Go**

Créer `flyover-reverse-engineering/pkg/mth/poly.go` :

```go
package mth

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strconv"
	"strings"
)

// Ring is a lat/lon polygon as a flat [lat, lon, lat, lon, ...] slice, closed
// implicitly: the last vertex connects back to the first.
//
// This file is the twin of the polygon block at the end of
// sim/tools/lib/tiles.mjs. The two are held in agreement by
// testdata/poly-cases.json, checked from both sides (poly_test.go and
// sim/tools/map-poly-selftest.mjs): a drift would otherwise only surface as a
// diverging cache directory name, i.e. as several gigabytes downloaded twice.
type Ring []float64

// Bounds is the ring's lat/lon extent - the rectangle of tiles the scan sweeps
// before masking.
func (r Ring) Bounds() (south, west, north, east float64) {
	south, west = math.Inf(1), math.Inf(1)
	north, east = math.Inf(-1), math.Inf(-1)
	for i := 0; i < len(r); i += 2 {
		south, north = math.Min(south, r[i]), math.Max(north, r[i])
		west, east = math.Min(west, r[i+1]), math.Max(east, r[i+1])
	}
	return
}

// ContainsPoint is ray casting. A point exactly on an edge has no stable answer
// here, which is harmless: IntersectsBox also tests edge crossings, so a tile
// whose corner sits on the outline is kept by that test instead.
func (r Ring) ContainsPoint(lat, lon float64) bool {
	n := len(r) / 2
	inside := false
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		yi, xi := r[2*i], r[2*i+1]
		yj, xj := r[2*j], r[2*j+1]
		if (yi > lat) != (yj > lat) && lon < ((xj-xi)*(lat-yi))/(yj-yi)+xi {
			inside = !inside
		}
	}
	return inside
}

func cross(ax, ay, bx, by, cx, cy float64) float64 {
	return (bx-ax)*(cy-ay) - (by-ay)*(cx-ax)
}

func onSegment(ax, ay, bx, by, px, py float64) bool {
	return math.Min(ax, bx) <= px && px <= math.Max(ax, bx) &&
		math.Min(ay, by) <= py && py <= math.Max(ay, by)
}

// segmentsIntersect treats collinear touching as an intersection: two segments
// meeting end to end do touch, and that is what keeps a tile merely grazed by
// an edge rather than dropping it.
func segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy float64) bool {
	d1 := cross(cx, cy, dx, dy, ax, ay)
	d2 := cross(cx, cy, dx, dy, bx, by)
	d3 := cross(ax, ay, bx, by, cx, cy)
	d4 := cross(ax, ay, bx, by, dx, dy)
	if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) {
		return true
	}
	return (d1 == 0 && onSegment(cx, cy, dx, dy, ax, ay)) ||
		(d2 == 0 && onSegment(cx, cy, dx, dy, bx, by)) ||
		(d3 == 0 && onSegment(ax, ay, bx, by, cx, cy)) ||
		(d4 == 0 && onSegment(ax, ay, bx, by, dx, dy))
}

// IntersectsBox reports whether the ring touches the lat/lon rectangle at all.
// All three tests are needed: a ring vertex inside the box (ring contained in
// the tile), a box corner inside the ring (tile contained in the ring), or an
// edge crossing (the common case).
func (r Ring) IntersectsBox(south, west, north, east float64) bool {
	for i := 0; i < len(r); i += 2 {
		if r[i] >= south && r[i] <= north && r[i+1] >= west && r[i+1] <= east {
			return true
		}
	}
	if r.ContainsPoint(south, west) {
		return true
	}
	corners := [4][2]float64{{west, south}, {east, south}, {east, north}, {west, north}}
	n := len(r) / 2
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		ay, ax := r[2*j], r[2*j+1]
		by, bx := r[2*i], r[2*i+1]
		for k := 0; k < 4; k++ {
			c, d := corners[k], corners[(k+1)%4]
			if segmentsIntersect(ax, ay, bx, by, c[0], c[1], d[0], d[1]) {
				return true
			}
		}
	}
	return false
}

// TileKept reports whether the TMS tile (x, y) at this zoom is swept for this
// ring. The rule is intersection, not centre-in-polygon: the extracted area is
// always a superset of what was drawn, exactly as the drawn rectangle is
// already rounded outwards onto the tile lattice. A corridor narrower than one
// tile therefore still yields columns.
func (r Ring) TileKept(zoom, x, y int) bool {
	south, west := TileTMSToLatLon(zoom, x, y)
	north, east := TileTMSToLatLon(zoom, x+1, y+1)
	return r.IntersectsBox(south, west, north, east)
}

// Canonical is the ring as six-decimal fields joined by commas - the same
// precision as the %f used elsewhere for export directory names.
func (r Ring) Canonical() string {
	parts := make([]string, len(r))
	for i, v := range r {
		parts[i] = strconv.FormatFloat(v, 'f', 6, 64)
	}
	return strings.Join(parts, ",")
}

// Hash names the export directory for a polygon scan. Twelve hex characters is
// plenty to keep two hand-drawn shapes apart, and short enough to read in a path.
func (r Ring) Hash() string {
	sum := sha256.Sum256([]byte(r.Canonical()))
	return hex.EncodeToString(sum[:])[:12]
}
```

- [ ] **Step 6: Lancer le test Go**

Run: `cd flyover-reverse-engineering && go test ./pkg/mth/ -v`
Expected: PASS — `TestRingBounds`, `TestRingTileMask`, `TestRingCanonicalAndHash`, `TestRingContainsPoint`, `TestRingIntersectsBox`.

Si `TestRingTileMask` ou `TestRingCanonicalAndHash` échoue, **ne pas régénérer la fixture** : c'est exactement la dérive que ce dispositif existe pour attraper. Comparer les deux implémentations ligne à ligne.

- [ ] **Step 7: Commit**

```bash
git add flyover-reverse-engineering/pkg/mth/poly.go flyover-reverse-engineering/pkg/mth/poly_test.go \
        flyover-reverse-engineering/testdata/poly-cases.json \
        sim/tools/gen-poly-fixture.mjs sim/tools/map-poly-selftest.mjs
git commit -m "Port Go de la géométrie de polygone, tenu par une fixture partagée (#30)

tiles.mjs et pkg/mth/poly.go nomment tous deux le dossier de cache. Une
divergence entre les deux ne se verrait qu'en re-téléchargeant plusieurs
gigaoctets : testdata/poly-cases.json est lu des deux côtés pour qu'elle
se voie au test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `export-obj --poly`

**Files:**
- Modify: `flyover-reverse-engineering/cmd/export-obj/main.go` (usage L35-53, parsing L62-123, zone de scan L156-175, boucle L210-217, `printPlan` L344-366, `scanPlan` L327-339)

**Interfaces:**
- Consumes: `mth.Ring` (Task 3)
- Produces : l'option `--poly lat,lon,lat,lon,…` ; le champ `masked` dans le JSON de `--plan` ; le répertoire `poly-<hash>-<zoom>-<tryH>`

- [ ] **Step 1: Étendre l'usage**

Dans `printUsage`, remplacer la ligne `Usage` et ajouter l'option après le bloc `--bbox` :

```go
	l.Println("Usage", os.Args[0], "[lat] [lon] [zoom] [tryXY] [tryH] [--parallel] [--bbox s,w,n,e] [--poly lat,lon,...] [--plan]")
```

```go
	l.Println("  --poly lat,lon,...  scan only the tiles a free polygon touches. The ring is")
	l.Println("                    closed implicitly; at least 3 vertices. Mutually exclusive")
	l.Println("                    with --bbox. A tile is kept as soon as the outline touches")
	l.Println("                    it, so the scanned area is always a superset of the shape.")
```

- [ ] **Step 2: Parser l'option**

Dans le pré-passage qui normalise `--bbox v` en `--bbox=v` (L62-77), traiter les deux options — remplacer `if a == "--bbox" {` par :

```go
		if a == "--bbox" || a == "--poly" {
			name := a
			if i+1 >= len(args) {
				printUsage(name + " needs a value")
			}
			i++
			a = name + "=" + args[i]
		}
```

Déclarer la variable à côté de `bbox` (L108) :

```go
	poly := mth.Ring(nil)
```

Ajouter le cas dans la boucle des options :

```go
		case strings.HasPrefix(a, "--poly="):
			poly, err = parseRing(strings.TrimPrefix(a, "--poly="))
			if err != nil {
				printUsage("Invalid --poly: " + err.Error())
			}
```

Et juste après la boucle `for _, a := range aOpt` :

```go
	// Two ways to say "scan this shape" would need a precedence rule, and a
	// silent one is worse than an error.
	if bbox.Ok && poly != nil {
		printUsage("--bbox and --poly are mutually exclusive")
	}
```

- [ ] **Step 3: Écrire `parseRing`**

À côté de `parseBox` (après L295) :

```go
// parseRing parses "lat,lon,lat,lon,..." in degrees into a closed ring. The
// closing edge is implicit, so a repeated first vertex is not expected (and
// harmlessly degenerate if given).
func parseRing(v string) (mth.Ring, error) {
	f := strings.Split(v, ",")
	if len(f)%2 != 0 {
		return nil, errors.New("expected an even number of lat,lon values")
	}
	if len(f) < 6 {
		return nil, errors.New("a polygon needs at least 3 vertices")
	}
	if len(f) > 400 {
		return nil, errors.New("at most 200 vertices")
	}
	r := make(mth.Ring, len(f))
	for i, p := range f {
		x, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return nil, fmt.Errorf("%q is not a number", p)
		}
		r[i] = x
	}
	south, west, north, east := r.Bounds()
	if south < -85 || north > 85 || west < -180 || east > 180 {
		return nil, errors.New("out of range")
	}
	if south == north || west == east {
		return nil, errors.New("polygon has zero area")
	}
	// A shape wider than half the globe is an antimeridian wrap dressed up as a
	// giant polygon. Nothing downstream handles the seam, so refuse it plainly.
	if east-west >= 180 {
		return nil, errors.New("polygon spans more than 180 degrees of longitude")
	}
	return r, nil
}
```

- [ ] **Step 4: Faire découler la zone de scan du tracé**

Après le bloc `if bbox.Ok { … }` (L160-169), ajouter :

```go
	if poly != nil {
		south, west, north, east := poly.Bounds()
		x1, y1 := mth.LatLonToTileTMS(z, south, west)
		x2, y2 := mth.LatLonToTileTMS(z, north, east)
		xMin, xMax = minMax(x1, x2)
		yMin, yMax = minMax(y1, y2)
		exportDir = fmt.Sprintf("./downloaded_files/obj/poly-%s-%d-%d", poly.Hash(), zoom, tryH)
	}
```

- [ ] **Step 5: Masquer dans la boucle de scan**

Dans la double boucle (L211-217), après le test `box.Contains` :

```go
			// Outside the drawn shape: the user's own decision, not a fact about
			// coverage. Counted apart from `skipped` so the two never read alike.
			if poly != nil && !poly.TileKept(z, xn, yn) {
				masked++
				continue
			}
```

Déclarer `masked := 0` à côté de `skipped := 0` (L208), et ajouter après la ligne `l.Println(xp, "exported")` :

```go
	if poly != nil {
		l.Printf("%d colonne(s) hors du polygone, non balayées", masked)
	}
```

- [ ] **Step 6: Reporter `masked` dans `--plan`**

Ajouter le champ à `scanPlan` (après `Pruned`) :

```go
	// Masked counts columns inside the region but outside the drawn polygon -
	// a user decision, unlike Pruned which is a fact about Flyover coverage.
	// Showing them as one number would report a perfectly covered area as
	// partly uncovered.
	Masked int `json:"masked"`
```

Changer la signature et le corps de `printPlan` :

```go
func printPlan(z, xMin, xMax, yMin, yMax, tryH int, p fly.Trigger, box fly.RegionBox, poly mth.Ring, exportDir string) {
	columns, pruned, masked := 0, 0, 0
	for xn := xMin; xn <= xMax; xn++ {
		for yn := yMin; yn <= yMax; yn++ {
			switch {
			case !box.Contains(z, yn, xn):
				pruned++
			case poly != nil && !poly.TileKept(z, xn, yn):
				masked++
			default:
				columns++
			}
		}
	}

	plan := scanPlan{
		Zoom: z, Trigger: p.Name, Region: p.Region, Version: p.Version,
		Columns: columns, Pruned: pruned, Masked: masked, Probes: columns * tryH, ExportDir: exportDir,
	}
```

Et l'appel (L174) :

```go
		printPlan(z, xMin, xMax, yMin, yMax, int(tryH), p, box, poly, exportDir)
```

- [ ] **Step 7: Compiler et vérifier `--plan` contre la fixture**

```bash
cd flyover-reverse-engineering
go vet ./... && go build ./...
go test ./pkg/mth/
```
Expected: pas d'erreur.

Puis, sur le premier cas de la fixture (le carré), vérifier que le Go annonce le même nombre de colonnes que le JS. `--plan` a besoin de `config.json` et du cache, mais n'émet aucune requête de tuile :

```bash
cd flyover-reverse-engineering
go run cmd/export-obj/main.go 48.850 2.300 20 1 20 --plan \
  --poly 48.845,2.295,48.845,2.305,48.855,2.305,48.855,2.295 2>/dev/null | python3 -m json.tool
```
Expected: `columns + masked` égal à `cols × rows` du cas « carré » de la fixture, `exportDir` finissant par le `hash` de ce cas. (`columns` peut être inférieur au `columns` de la fixture si `pruned > 0` : la région Flyover élague en plus. Vérifier alors `columns + masked + pruned`.)

- [ ] **Step 8: Vérifier la non-régression du chemin `--bbox`**

```bash
cd flyover-reverse-engineering
go run cmd/export-obj/main.go 48.850 2.300 20 1 20 --plan --bbox 48.845,2.295,48.855,2.305 2>/dev/null | python3 -m json.tool
go run cmd/export-obj/main.go 48.850 2.300 20 1 20 --plan --bbox 48.845,2.295,48.855,2.305 --poly 48.845,2.295,48.845,2.305,48.855,2.305 2>&1 | head -3
```
Expected: le premier rend un plan avec `"masked": 0` ; le second refuse avec `--bbox and --poly are mutually exclusive`.

- [ ] **Step 9: Commit**

```bash
git add flyover-reverse-engineering/cmd/export-obj/main.go
git commit -m "export-obj : option --poly, et masked distinct de pruned dans --plan (#30)

pruned dit « Flyover ne couvre pas ça », masked dit « l'utilisateur n'en a
pas voulu ». Les additionner ferait passer une zone parfaitement couverte
pour partiellement hors couverture.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `poly` de bout en bout dans le pipeline Node

**Files:**
- Modify: `sim/tools/lib/add-map-core.mjs` (`tileDirName` L38-45, `planScan` L120-141, `probeCoverage` L196-250, `addMap` L253-330)
- Modify: `sim/tools/map-poly-selftest.mjs`

**Interfaces:**
- Consumes: `polyHash`, `polygonProbePoint`, `polygonBounds`, `polygonGrid` (Tasks 1-2)
- Produces:
  - `tileDirName(opts)` accepte `{poly, zoom, altitude}` et devient **`async`**
  - `tileDirPath(opts)` devient **`async`**
  - `planScan`, `probeCoverage`, `addMap` acceptent `poly`
  - entrée `scenes.json` : `{slug, name, lat, lon, poly, zoom, altitude, cell, quality, bytes, createdAt}`

> `tileDirName` devient asynchrone parce que `polyHash` l'est. Ses trois appelants (`probeCoverage`, `addMap`, et la route `/scenes` de `map-api-plugin.mjs:498`) sont déjà dans du code `async` — il n'y a qu'à ajouter `await`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `sim/tools/map-poly-selftest.mjs`, en complétant l'import avec `import { tileDirName } from './lib/add-map-core.mjs';` :

```js
await at('tileDirName : le nom du cache, en phase avec le Sprintf du Go', async () => {
	const fixture = JSON.parse(
		fs.readFileSync(new URL('../../flyover-reverse-engineering/testdata/poly-cases.json', import.meta.url), 'utf8'));
	const c = fixture[0];
	assert.equal(await tileDirName({ poly: c.ring, zoom: 20, altitude: 20 }), `poly-${c.hash}-20-20`);
	// Les deux autres formes ne bougent pas.
	assert.equal(await tileDirName({ lat: 48.8582, lon: 2.2945, zoom: 20, radius: 25, altitude: 20 }),
		'48.858200-2.294500-20-25-20');
	assert.equal(await tileDirName({ bbox: { south: 48.845, west: 2.295, north: 48.855, east: 2.305 }, zoom: 20, altitude: 20 }),
		'bbox-48.845000-2.295000-48.855000-2.305000-20-20');
});

t('un tracé et son emprise ne partagent pas de cache', () => {
	// Sinon un polygone reprendrait le téléchargement partiel d'un rectangle,
	// et rendrait une carte trouée sans rien dire.
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	assert.notEqual(g.columns, g.cols * g.rows);
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: FAIL — `tileDirName({poly}) === 'undefined'` ou `poly-undefined-20-20`.

- [ ] **Step 3: `tileDirName` / `tileDirPath`**

Dans `sim/tools/lib/add-map-core.mjs`, ajouter à l'import de tête :

```js
import { polyHash, polygonProbePoint } from './tiles.mjs';
```

Remplacer `tileDirName` / `tileDirPath` :

```js
// Doit rester en phase avec les fmt.Sprintf de cmd/export-obj/main.go — c'est ce
// nom qui sert de cache : si les deux divergent, chaque run re-télécharge tout.
// %f en Go, c'est 6 décimales.
//
// Asynchrone depuis le polygone : son nom est un sha256 de la chaîne canonique
// des sommets, et crypto.subtle — le seul digest disponible aussi dans le
// navigateur, où tiles.mjs doit rester importable — est asynchrone.
export async function tileDirName({ lat, lon, zoom, radius, altitude, bbox, poly }) {
	if (poly) return `poly-${await polyHash(poly)}-${zoom}-${altitude}`;
	if (bbox) {
		const { south, west, north, east } = bbox;
		return `bbox-${south.toFixed(6)}-${west.toFixed(6)}-${north.toFixed(6)}-${east.toFixed(6)}-${zoom}-${altitude}`;
	}
	return `${lat.toFixed(6)}-${lon.toFixed(6)}-${zoom}-${radius}-${altitude}`;
}

export async function tileDirPath(opts) {
	return path.join(FLYOVER_ROOT, 'downloaded_files/obj', await tileDirName(opts));
}
```

- [ ] **Step 4: Lancer, vérifier que ça passe**

Run: `cd sim && node tools/map-poly-selftest.mjs`
Expected: PASS, 18 vérifications.

- [ ] **Step 5: Faire circuler `poly` dans les trois fonctions**

Dans `planScan`, remplacer la construction des arguments :

```js
export async function planScan({ lat, lon, zoom = 20, radius = 25, altitude = 20, bbox, poly }, { signal } = {}) {
	const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--plan'];
	if (poly) args.push('--poly', poly.join(','));
	else if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
```

Dans `probeCoverage`, remplacer la signature et le calcul du centre :

```js
export async function probeCoverage({ lat, lon, zoom = 20, altitude = 20, bbox, poly }, { signal } = {}) {
	// Sur un tracé en L ou en croissant, le centre de l'emprise tombe HORS du
	// tracé : sonder là rendrait un verdict sur une zone qu'on n'extrait pas.
	// polygonProbePoint vise le centre d'une tuile réellement retenue.
	const centre = poly
		? polygonProbePoint(poly, zoom)
		: bbox
			? { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 }
			: { lat, lon };
```

La sonde reste rectangulaire (une boîte de ~3×3 tuiles autour de ce point) : le reste de la fonction ne change pas, sauf le nettoyage final, qui doit maintenant attendre le chemin :

```js
	} finally {
		// La sonde est jetable : on ne laisse pas un dossier par clic dans le cache.
		fs.rmSync(await tileDirPath({ zoom, altitude, bbox: probeBox }), { recursive: true, force: true });
	}
```

Dans `addMap`, la déstructuration, le chemin de cache, la ligne de log, les arguments et l'entrée `scenes.json` :

```js
	const { name, lat, lon, bbox, poly, zoom = 20, radius = 25, altitude = 20, cell = 256, quality = 85, force = false } = opts;
```
```js
	const tileDir = await tileDirPath({ lat, lon, zoom, radius, altitude, bbox, poly });
```
```js
	log(poly
		? `Tracé : ${poly.length / 2} sommets  zoom ${zoom}  altitudes ${altitude}`
		: bbox
			? `Zone : ${bbox.south}, ${bbox.west} → ${bbox.north}, ${bbox.east}  zoom ${zoom}  altitudes ${altitude}`
			: `Centre : ${lat}, ${lon}  zoom ${zoom}  rayon ${radius}  altitudes ${altitude}`);
```
```js
		const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--parallel'];
		if (poly) args.push('--poly', poly.join(','));
		else if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
```
```js
	const entry = {
		slug, name, lat, lon,
		...(poly ? { poly } : bbox ? { bbox } : { radius }),
		zoom, altitude, cell, quality,
		bytes: dirSize(outDir),
		createdAt: new Date().toISOString(),
	};
```

Enfin, le message d'échec « aucune tuile » mentionne `lat, lon` : pour un tracé, ces coordonnées ne sont que le point de sélection de région. Remplacer son ouverture par :

```js
			: `aucune tuile 3D ${poly ? 'dans le tracé' : `à ${lat}, ${lon}`} (zoom ${zoom}).\n` +
```

- [ ] **Step 6: Rattraper l'appelant restant de `tileDirPath`**

`sim/tools/map-api-plugin.mjs:498` construit le chemin d'une tuile depuis une entrée de scène. Remplacer le bloc par sa forme `await` et le cas `poly` :

```js
			const dir = await tileDirPath(entry.poly ? { ...entry, poly: entry.poly }
				: entry.bbox ? { ...entry, bbox: entry.bbox } : entry);
```

Vérifier que la fonction englobante est bien `async` ; si elle ne l'est pas, la rendre `async` et `await` son appel.

Run: `cd sim && grep -n "tileDirPath\|tileDirName" tools/*.mjs tools/lib/*.mjs`
Expected: tous les appels sont précédés de `await`.

- [ ] **Step 7: Vérifier que rien n'a cassé**

```bash
cd sim && node tools/map-poly-selftest.mjs && npm run selftest:operator
```
Expected: PASS partout.

- [ ] **Step 8: Commit**

```bash
git add sim/tools/lib/add-map-core.mjs sim/tools/map-api-plugin.mjs sim/tools/map-poly-selftest.mjs
git commit -m "Le pipeline d'ajout de carte accepte un tracé (#30)

tileDirName devient asynchrone : le nom du cache d'un polygone est un
sha256, et crypto.subtle — le seul digest disponible aussi côté navigateur,
où tiles.mjs doit rester importable — est asynchrone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: L'API dev accepte un tracé

**Files:**
- Modify: `sim/tools/map-api-plugin.mjs` (`requireBox` L373-385, `describe` L400-411, routes L508-556)

**Interfaces:**
- Consumes: `polygonGrid`, `polygonArea`, `polygonBounds` (Tasks 1-2), `planScan`/`probeCoverage`/`addMap` avec `poly` (Task 5)
- Produces: `/describe`, `/plan`, `/probe` et `POST /jobs` acceptent `{poly: number[]}` à la place de `{bbox}` ; la réponse de `describe` gagne `poly`, `grid.keep` (tableau `number[]` sérialisable) et `grid.masked`

- [ ] **Step 1: Valider l'entrée**

Ajouter à côté de `requireBox` :

```js
// Un tracé venu du navigateur n'est pas de confiance : les bornes ici sont les
// mêmes que celles de parseRing() dans cmd/export-obj/main.go, pour qu'un tracé
// accepté ici ne se fasse pas refuser trois appels plus loin par le Go.
function requirePoly(p) {
	if (!Array.isArray(p) || p.length % 2 !== 0) throw new Error('tracé manquant ou invalide');
	if (p.length < 6) throw new Error('un polygone a au moins 3 sommets');
	if (p.length > 400) throw new Error('au plus 200 sommets');
	if (!p.every(Number.isFinite)) throw new Error('tracé : coordonnée non numérique');
	const b = polygonBounds(p);
	if (b.south < -85 || b.north > 85 || b.west < -180 || b.east > 180) throw new Error('tracé hors limites');
	if (b.south === b.north || b.west === b.east) throw new Error('tracé d\'aire nulle');
	if (b.east - b.west >= 180) throw new Error('tracé à cheval sur l\'antiméridien');
	return p;
}

// Les routes acceptent l'une OU l'autre forme de zone. Rendre les deux serait
// ambigu ; n'en rendre aucune est l'erreur habituelle d'un appelant.
function requireZone(b) {
	if (b.poly && b.bbox) throw new Error('bbox et poly sont exclusifs');
	if (b.poly) return { poly: requirePoly(b.poly) };
	return { bbox: requireBox(b.bbox) };
}
```

Compléter l'import de `tiles.mjs`/`estimates.mjs` en tête du fichier avec `polygonBounds, polygonGrid, polygonArea`.

- [ ] **Step 2: Décrire une zone quelle que soit sa forme**

Remplacer `centreOf` et `describe` :

```js
function centreOf(zone) {
	const b = zone.poly ? polygonBounds(zone.poly) : zone.bbox;
	return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

// Décrit une zone : géométrie exacte + estimations. `columns` vient du plan Go
// quand il est fourni (il a élagué les colonnes hors couverture), sinon de la
// grille calculée localement — masque du tracé compris.
function describe(zone, zoom, altitude, planColumns) {
	const c = centreOf(zone);
	const box = zone.poly ? polygonBounds(zone.poly) : zone.bbox;
	const grid = zone.poly ? polygonGrid(zone.poly, zoom) : tileGrid(box, zoom);
	const columns = Number.isFinite(planColumns) ? planColumns : grid.columns;

	// L'aire du tracé, pas celle de son emprise : sur un corridor le long d'un
	// fleuve les deux diffèrent d'un facteur deux ou trois, et c'est cette
	// valeur-là que l'écran présente comme « surface de la zone ».
	const dimensions = boxDimensions(box);
	if (zone.poly) dimensions.area = polygonArea(zone.poly);

	return {
		box, centre: c,
		...(zone.poly ? { poly: zone.poly } : {}),
		dimensions,
		// Uint8Array ne survit pas à JSON.stringify : la carte a besoin du masque
		// pour dessiner l'escalier, on le rend donc en tableau ordinaire.
		grid: { ...grid, keep: grid.keep ? Array.from(grid.keep) : undefined, masked: grid.masked ?? 0 },
		tileMeters: tileSizeMeters(zoom, c.lat),
		estimate: estimateCost({ columns, zoom, altitude }),
	};
}
```

- [ ] **Step 3: Brancher les quatre routes**

```js
	['POST', /^\/describe$/, async (req, res) => {
		const b = await body(req);
		const zone = requireZone(b);
		json(res, 200, describe(zone, intIn(b.zoom, 13, 20, 20), intIn(b.altitude, 1, 60, 20)));
	}],
```
```js
	['POST', /^\/plan$/, async (req, res) => {
		const b = await body(req);
		const zone = requireZone(b);
		const zoom = intIn(b.zoom, 13, 20, 20), altitude = intIn(b.altitude, 1, 60, 20);
		const c = centreOf(zone);
		const plan = await planScan({ lat: c.lat, lon: c.lon, zoom, altitude, ...zone });
		json(res, 200, { plan, ...describe(zone, zoom, altitude, plan.columns) });
	}],
```
```js
	['POST', /^\/probe$/, async (req, res) => {
		const b = await body(req);
		const zone = requireZone(b);
		const c = centreOf(zone);
		json(res, 200, await probeCoverage({
			lat: c.lat, lon: c.lon, ...zone,
			zoom: intIn(b.zoom, 13, 20, 20), altitude: intIn(b.altitude, 1, 60, 20),
		}));
	}],
```

Pour `POST /jobs` (L539-556) : remplacer `const box = requireBox(b.bbox);` par `const zone = requireZone(b);`, `const c = centreOf(box)` par `const c = centreOf(zone)`, et dans l'objet passé à `startJob`, `bbox: box` par `...zone`.

- [ ] **Step 4: Vérifier à la main, serveur de dev allumé**

```bash
cd sim && npm run dev &
sleep 4
curl -s localhost:5173/__map-api/describe -H 'content-type: application/json' \
  -d '{"poly":[48.845,2.295,48.845,2.305,48.855,2.295],"zoom":20,"altitude":20}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["grid"]["columns"], d["grid"]["masked"], round(d["dimensions"]["area"]))'
curl -s localhost:5173/__map-api/describe -H 'content-type: application/json' \
  -d '{"bbox":{"south":48.845,"west":2.295,"north":48.855,"east":2.305},"zoom":20,"altitude":20}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["grid"]["columns"], round(d["dimensions"]["area"]))'
curl -s localhost:5173/__map-api/describe -H 'content-type: application/json' -d '{"poly":[1,2]}'
```
Expected: le triangle rend `columns` strictement inférieur au rectangle et `masked > 0`, avec une aire environ moitié ; le rectangle est inchangé ; le tracé à un sommet rend `{"error":"un polygone a au moins 3 sommets"}`.

Arrêter le serveur (`kill %1`).

- [ ] **Step 5: Commit**

```bash
git add sim/tools/map-api-plugin.mjs
git commit -m "/__map-api accepte un tracé partout où il acceptait une bbox (#30)

describe() rend l'aire du TRACÉ, pas celle de son emprise : sur un corridor
le long d'un fleuve les deux diffèrent d'un facteur deux ou trois, et c'est
ce chiffre que l'écran présente comme la surface de la zone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `npm run add-map -- --poly`

**Files:**
- Modify: `sim/tools/add-map.mjs` (en-tête L1-19, `parseArgs` L23-53, après `parseBox` L56-67)

**Interfaces:**
- Consumes: `addMap({poly})` (Task 5)
- Produces: l'option CLI `--poly "lat,lon lat,lon …"` (les paires séparées par des espaces *ou* des virgules)

- [ ] **Step 1: Documenter et parser**

Dans le bloc de commentaire de tête, après la ligne `--bbox` :

```
//                           [--poly "<lat>,<lon> <lat>,<lon> ..."]
```
et après le paragraphe qui explique `--bbox` :

```
// --poly extracts a free polygon instead of a rectangle: only the tiles its
// outline touches are scanned. A tile is kept as soon as the outline touches
// it, so the extracted area is always a superset of the shape. lat/lon are
// still required (they select the Flyover region); pass a point inside the shape.
```

Dans `parseArgs`, ajouter `poly: null` à `opts`, la branche d'option, et la garde d'exclusion avant le `return` :

```js
		else if (a === '--poly') opts.poly = parseRing(argv[++i]);
```
```js
	if (opts.bbox && opts.poly) {
		console.error('--bbox and --poly are mutually exclusive');
		process.exit(1);
	}
```

Compléter aussi la ligne d'usage de `console.error` avec `[--poly "lat,lon lat,lon ..."]`.

- [ ] **Step 2: Écrire `parseRing`**

Après `parseBox` :

```js
// Accepte "lat,lon lat,lon" comme "lat,lon,lat,lon" : à taper à la main les
// paires espacées se relisent, et la forme plate est celle que le Go reçoit.
function parseRing(v) {
	const n = String(v ?? '').trim().split(/[\s,]+/).map(Number);
	if (n.length < 6 || n.length % 2 !== 0 || !n.every(Number.isFinite)) {
		console.error('--poly expects at least 3 "<lat>,<lon>" pairs in degrees');
		process.exit(1);
	}
	return n;
}
```

- [ ] **Step 3: Vérifier le parsing sans rien télécharger**

```bash
cd sim
node -e '
const { execFileSync } = require("node:child_process");
try { execFileSync("node", ["tools/add-map.mjs"], { stdio: "pipe" }); } catch (e) {
  const s = e.stderr.toString();
  console.log(/--poly/.test(s) ? "ok: usage mentionne --poly" : "MANQUE --poly dans usage");
}'
node tools/add-map.mjs "X" 48.85 2.30 --bbox 48.8,2.2,48.9,2.4 --poly "48.8,2.2 48.8,2.4 48.9,2.4" 2>&1 | head -1
node tools/add-map.mjs "X" 48.85 2.30 --poly "48.8,2.2" 2>&1 | head -1
```
Expected: l'usage mentionne `--poly` ; les deux options ensemble sont refusées ; un tracé à un sommet est refusé.

- [ ] **Step 4: Commit**

```bash
git add sim/tools/add-map.mjs
git commit -m "npm run add-map : option --poly, pour que la CLI ne soit pas le parent pauvre (#30)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Le polygone dans le GLOBAL SCANNER

**Files:**
- Modify: `sim/src/scanner.js` (contrôles Geoman, `drawLattice` L233-253, `setZone` L269-286, `clearZone` L293-305, appels `/describe` L315, `/plan` L399, `/probe` L407, `/jobs` L570)
- Modify: `sim/tools/scanner-model.mjs` (ré-export, L5-7)
- Modify: `sim/tools/scanner-selftest.mjs`

**Interfaces:**
- Consumes: `maskOutline`, `polygonGrid` (Tasks 1-2) ; `/describe` rendant `grid.keep` et `grid.masked` (Task 6)
- Produces: `state.zone` remplace `state.box` — `{bbox}` ou `{poly}`, étalé tel quel dans chaque corps de requête

- [ ] **Step 1: Écrire le test de modèle qui échoue**

Ajouter à `sim/tools/scanner-selftest.mjs`, avant le `console.log` final, en complétant l'import depuis `./scanner-model.mjs` avec `maskOutline, polygonGrid` :

```js
// Le SCANNER dessine la zone RÉELLEMENT retenue, pas le tracé lissé : sur un
// polygone c'est un escalier, et il vient du même masque que le coût annoncé.
t('maskOutline : le SCANNER a accès à l\'escalier via scanner-model', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const segs = maskOutline(g, 20);
	assert.ok(segs.length > 0);
	assert.ok(g.columns < g.cols * g.rows, 'un triangle masque des colonnes');
});

t('areaAnalysis : une réponse de polygone se lit comme une réponse de rectangle', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const a = areaAnalysis({
		grid: g,
		dimensions: { width: 730, height: 1112, area: 406000 },
		tileMeters: 25.4,
		estimate: {
			probes: g.columns * 20, tiles: 100, prepBytes: 5e6, prepBytesRange: [2e6, 9e6],
			rawBytes: 2e7, totalSeconds: 300, warn: false,
		},
	});
	assert.equal(a.columns, new Intl.NumberFormat('en-US').format(g.columns));
	assert.equal(a.surface, '0.41 km²');
});
```

Run: `cd sim && node tools/scanner-selftest.mjs`
Expected: FAIL — `does not provide an export named 'maskOutline'`

- [ ] **Step 2: Ré-exporter depuis `scanner-model.mjs`**

Remplacer les lignes 5-7 de `sim/tools/scanner-model.mjs` :

```js
import {
	latticeEdges, intersectBox, tileGrid, boxDimensions, tileSizeMeters,
	polygonGrid, maskOutline, polygonBounds, polygonArea,
} from './lib/tiles.mjs';

export {
	latticeEdges, intersectBox, tileGrid, boxDimensions, tileSizeMeters,
	polygonGrid, maskOutline, polygonBounds, polygonArea,
};
```

Run: `cd sim && node tools/scanner-selftest.mjs`
Expected: PASS.

- [ ] **Step 3: Activer le tracé libre chez Geoman**

Dans `sim/src/scanner.js`, là où les contrôles Geoman sont posés, activer `drawPolygon`. Si l'écran n'appelle pas `addControls` (le tracé y est déclenché par un bouton du panneau), activer le mode par `map.pm.enableDraw('Polygon', { allowSelfIntersection: false })` sur le bouton correspondant, en miroir de ce qui existe pour `'Rectangle'`.

Run: `cd sim && grep -n "pm.addControls\|enableDraw\|drawRectangle\|drawPolygon" src/scanner.js`
Expected: le polygone est activable au même endroit que le rectangle.

- [ ] **Step 4: Remplacer `state.box` par `state.zone`**

Dans `setZone`, produire une zone selon le type de calque :

```js
	function setZone(layer) {
		if (zoneLayer && zoneLayer !== layer) map.removeLayer(zoneLayer);
		zoneLayer = layer;
		// Le tracé dessiné est un fantôme : ce qui compte, c'est la zone alignée
		// sur les tuiles — un rectangle snappé, ou l'escalier d'un polygone.
		layer.setStyle({ color: '#eaf2f8', weight: 1, dashArray: '3 4', fill: false, opacity: .5 });

		// Geoman rend un L.Rectangle pour le rectangle et un L.Polygon pour le
		// tracé libre ; le rectangle EST un polygone, donc on teste le plus
		// spécifique d'abord.
		if (layer instanceof L.Rectangle) {
			const b = layer.getBounds();
			state.zone = { bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } };
		} else {
			const ring = [];
			for (const ll of layer.getLatLngs()[0]) ring.push(ll.lat, ll.lng);
			state.zone = { poly: ring };
		}

		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		describe();
		surveyCentre();
	}
```

Dans `clearZone`, remplacer `state.box = state.describe = …` par `state.zone = state.describe = state.plan = state.probe = null;` et ajouter `outline.clearLayers();`.

Remplacer chaque corps de requête : `{ bbox: state.box, … }` devient `{ ...state.zone, … }` — quatre occurrences (`/describe` L315, `/plan` L399, `/probe` L407, `/jobs` L570). Remplacer aussi chaque garde `if (!state.box)` par `if (!state.zone)`.

Run: `cd sim && grep -n "state.box" src/scanner.js`
Expected: aucune occurrence.

- [ ] **Step 5: Dessiner l'escalier**

Déclarer le groupe à côté de `lattice` :

```js
	const outline = L.layerGroup().addTo(map);
```

Remplacer `drawLattice` :

```js
	// ---------------------------------------------- la grille réellement scannée
	//
	// Sous ~7 px par tuile la grille devient un aplat illisible : on ne garde
	// alors que l'emprise. La règle vaut mieux qu'un plafond arbitraire sur le
	// nombre de traits — mais le CONTOUR, lui, reste dessiné à toute échelle :
	// c'est la seule chose qui dise ce qui sera réellement extrait.
	function drawLattice() {
		lattice.clearLayers();
		outline.clearLayers();
		const grid = state.describe?.grid;
		if (!grid) return;
		const s = grid.snapped;

		// Un tracé libre ne se résume pas à son emprise : son contour est
		// l'escalier des tuiles retenues, et c'est lui qu'on montre.
		if (grid.keep) {
			map.removeLayer(snapped);
			outline.addLayer(L.polyline(
				maskOutline({ ...grid, keep: Uint8Array.from(grid.keep) }, state.zoom),
				{ color: '#6cf', weight: 1, interactive: false }));
		} else {
			snapped.setBounds([[s.south, s.west], [s.north, s.east]]).addTo(map);
		}

		const a = map.latLngToLayerPoint([s.south, s.west]);
		const b = map.latLngToLayerPoint([s.north, s.east]);
		if (Math.abs(b.x - a.x) / grid.cols < 7) return;

		const style = { color: '#6cf', weight: 1, opacity: .22, interactive: false };
		const { lons, lats } = latticeEdges(grid, state.zoom);
		for (let i = 1; i < lons.length - 1; i++) {
			lattice.addLayer(L.polyline([[s.south, lons[i]], [s.north, lons[i]]], style));
		}
		for (let j = 1; j < lats.length - 1; j++) {
			lattice.addLayer(L.polyline([[lats[j], s.west], [lats[j], s.east]], style));
		}
	}
```

Compléter l'import de tête de `scanner.js` avec `maskOutline`.

- [ ] **Step 6: Vérifier à l'écran**

`npm run dev`, ouvrir le GLOBAL SCANNER, tracer un polygone en L au-dessus de Paris. Attendu :

- le tracé dessiné reste en pointillé pâle ;
- l'escalier bleu des tuiles retenues épouse le L, encoche comprise ;
- le nombre de colonnes est inférieur à celui du rectangle englobant, et la surface aussi ;
- `PROBE` rend un verdict (le point sondé est dans le L) ;
- un rectangle se comporte exactement comme avant.

Run: `cd sim && npm run selftest:operator`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sim/src/scanner.js sim/tools/scanner-model.mjs sim/tools/scanner-selftest.mjs
git commit -m "GLOBAL SCANNER : tracé libre et contour en escalier (#30)

state.box devient state.zone — {bbox} ou {poly} — étalé tel quel dans
chaque requête, plutôt qu'un second champ à tenir en phase partout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Le polygone dans `add-map.html`

Même câblage, dans la GUI de dev. Le fichier est destiné à être absorbé par le SCANNER, mais tant qu'il existe il ne doit pas rester en retrait.

**Files:**
- Modify: `sim/tools/map-gui/main.js` (state L18-25, contrôles L36-42, `setZone` L54-70, `clearZone` L75-91, `drawLattice` L100-129, `describe` L146-160, `renderZone` L182-224, `/plan` et `/probe` L336-361, `/jobs` L376-390)
- Modify: `sim/tools/map-gui/style.css` (si l'escalier a besoin de son propre trait)

**Interfaces:**
- Consumes: identiques à Task 8
- Produces: `state.zone` remplace `state.box` dans la GUI

- [ ] **Step 1: Activer le tracé libre**

Dans `map.pm.addControls`, `drawPolygon: false` devient `drawPolygon: true`.

- [ ] **Step 2: `state.zone` et l'escalier**

`state.box` devient `state.zone` (initialisé à `null`). Dans `setZone`, la même distinction `L.Rectangle` / `L.Polygon` qu'en Task 8, Step 4 :

```js
	if (layer instanceof L.Rectangle) {
		const b = layer.getBounds();
		state.zone = { bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } };
	} else {
		const ring = [];
		for (const ll of layer.getLatLngs()[0]) ring.push(ll.lat, ll.lng);
		state.zone = { poly: ring };
	}
```

Activer l'édition sans auto-intersection à la création, comme le fait déjà le SCANNER :

```js
map.on('pm:create', (e) => {
	setZone(e.layer);
	e.layer.pm.enable({ allowSelfIntersection: false });
	e.layer.on('pm:edit pm:dragend', () => setZone(e.layer));
});
```

Ajouter `const outline = L.layerGroup().addTo(map);` à côté de `lattice`, importer `maskOutline` depuis `../lib/tiles.mjs`, et dans `drawLattice(grid)` remplacer l'appel `snapped.setBounds(...).addTo(map)` par la même branche `grid.keep` qu'en Task 8, Step 5. Vider `outline` dans `clearZone` et en tête de `drawLattice`.

- [ ] **Step 3: Étaler la zone dans les requêtes**

Remplacer `{ bbox: state.box, … }` par `{ ...state.zone, … }` dans `describe()`, `$('check').onclick` (`/plan` puis `/probe`) et `$('launch').onclick` (`/jobs`). Remplacer les gardes `!state.box` par `!state.zone`, et `const hasBox = !!state.box;` par `const hasZone = !!state.zone;` (avec ses deux usages).

- [ ] **Step 4: Dire les colonnes masquées dans le relevé**

Dans `renderZone(d)`, la ligne `g-cols` annonce `cols × rows = columns`, ce qui devient faux dès qu'il y a un masque. Remplacer :

```js
		'g-cols': d.grid.masked
			? `${grid.cols} × ${grid.rows} − ${nf.format(d.grid.masked)} = ${nf.format(grid.columns)}`
			: `${grid.cols} × ${grid.rows} = ${nf.format(grid.columns)}`,
```

Run: `cd sim && grep -n "state.box" tools/map-gui/main.js`
Expected: aucune occurrence.

- [ ] **Step 5: Vérifier à l'écran**

`npm run dev`, ouvrir `http://localhost:5173/add-map.html`, tracer un polygone le long d'un boulevard. Attendu : l'escalier suit le tracé, `g-cols` montre la soustraction, la surface est celle du tracé, le rectangle est inchangé.

- [ ] **Step 6: Commit**

```bash
git add sim/tools/map-gui/main.js sim/tools/map-gui/style.css
git commit -m "add-map.html : tracé libre, escalier, et le compte des colonnes masquées (#30)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation et extraction réelle

Rien n'est fini tant qu'une vraie carte n'est pas sortie du tuyau.

**Files:**
- Modify: `docs/manuel.md`
- Modify: `sim/HANDOFF.md`
- Modify: `flyover-reverse-engineering/README.md`

- [ ] **Step 1: Extraire une carte pour de vrai**

Tracer, dans le GLOBAL SCANNER, un corridor le long de la Seine (quelques centaines de mètres de large sur un kilomètre ou deux), vérifier la couverture, lancer l'acquisition, puis voler dessus.

À vérifier, dans l'ordre :

```bash
cd flyover-reverse-engineering && ls -d downloaded_files/obj/poly-* && du -sh downloaded_files/obj/poly-*
cd ../sim && python3 -c "
import json; s=json.load(open('public/scenes.json'))
e=[x for x in s if 'poly' in x][-1]
print(e['slug'], len(e['poly'])//2, 'sommets', e['bytes'])"
node tools/selftest.mjs public/scenes/<slug>
```

Attendu : un dossier `poly-<hash>-20-20`, une entrée `scenes.json` avec `poly`, le selftest de scène vert, et la scène volable via `?scene=<slug>`.

Relancer l'acquisition **une seconde fois** sur le même tracé : le log doit dire « Tuile déjà téléchargée » — c'est la preuve que le hash de `tileDirName` et celui du Go concordent en conditions réelles, ce que la fixture ne peut vérifier que sur le papier.

- [ ] **Step 2: Documenter**

Dans `docs/manuel.md`, à la section de l'ajout de cartes : l'option `--poly` de `npm run add-map`, la règle de rétention (intersection, la zone extraite est un sur-ensemble du tracé), et le fait que le tracé libre est disponible dans le GLOBAL SCANNER comme dans `add-map.html`.

Dans `flyover-reverse-engineering/README.md` : l'option `--poly` de `export-obj`, son exclusivité avec `--bbox`, le champ `masked` de `--plan` et ce qui le distingue de `pruned`, et le nommage `poly-<hash>-<zoom>-<tryH>` du répertoire d'export.

Dans `sim/HANDOFF.md`, section « vérifié » : le polygone libre, avec le slug de la carte réellement extraite à l'étape 1 comme preuve.

- [ ] **Step 3: Vérification finale**

```bash
cd flyover-reverse-engineering && go vet ./... && go test ./...
cd ../sim && npm run selftest && npm run selftest:operator
```
Expected: tout vert.

- [ ] **Step 4: Commit et pousser**

```bash
git add docs/manuel.md sim/HANDOFF.md flyover-reverse-engineering/README.md sim/public/scenes.json
git commit -m "Documente le tracé libre, et une carte extraite pour de vrai (#30)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin poly-selection
gh pr create --title "Ajout de cartes : sélection par polygone libre (#30)" \
  --body "Ferme #30.

Une tuile est retenue dès que le tracé la touche : la zone extraite reste un
sur-ensemble de ce qui est dessiné, comme l'est déjà le rectangle arrondi sur
le treillis. Un corridor plus fin qu'une tuile reste donc extractible.

Le prédicat vit en deux ports (pkg/mth/poly.go, sim/tools/lib/tiles.mjs) tenus
d'accord par testdata/poly-cases.json, lu des deux côtés : une divergence nomme
un autre dossier de cache et ne se verrait sinon qu'en re-téléchargeant.

--plan distingue \\\`masked\\\` (hors tracé) de \\\`pruned\\\` (hors couverture Flyover), et la
sonde vise une tuile réellement retenue plutôt que le centre de l'emprise, qui
sur un L tombe hors du tracé.

Carte extraite pour de vrai : <slug>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 5: Fermer l'issue**

Commenter sur #30 ce qui a été livré et les partis pris (règle d'intersection, `masked` vs `pruned`, sonde recentrée sur une tuile retenue), fermer l'issue, passer l'élément de projet en `Done`.
