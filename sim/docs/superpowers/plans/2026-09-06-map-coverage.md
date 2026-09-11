# Couverture de carte — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une tache douce s'étend sur la carte de FIELD là où le drone est réellement passé, se densifie quand on repasse, et survit aux sessions.

**Architecture:** Un module pur `src/coverage.js` (grille slippy à zoom fixe 20, empreinte de 30 m, fusion, plafond, planification du dessin) ; `session.js` accumule en mémoire à 5 Hz et écrit une seule fois à la clôture via `operator.patch('coverage', …)` ; `src/map-coverage.js` est la colle Leaflet (un calque canvas dans un pane dédié sous les cadres de zone) que `scanner.js` monte sur la carte de FIELD.

**Tech Stack:** JavaScript ES modules, Leaflet 1.9.4 (déjà dépendance), canvas 2D, selftests `node tools/*-selftest.mjs` avec `node:assert/strict`.

**Spec:** `sim/docs/superpowers/specs/2026-09-06-map-coverage-design.md`

## Global Constraints

- Tout se fait depuis `sim/` : `cd /home/user/Documents/dev/FPVTP/sim`.
- **Ne jamais toucher au serveur de dev du joueur** (vite sur `localhost:5173`, pid vivant). Aucun `npm run dev`, aucun kill. `npm run build` est autorisé (répertoire séparé).
- **Ne jamais commiter `sim/public/scenes.json`** : il est modifié dans l'arbre de travail par le joueur (carte `havre`), ce n'est pas notre travail. Toujours `git add` des chemins explicites, jamais `git add -A`.
- Indentation **tabulations** dans tout `sim/`. Commentaires en français, texte joueur en anglais.
- `src/coverage.js` est **pur** : ni THREE, ni Rapier, ni DOM, ni Leaflet — même règle que `geofence.js`, `fog.js`, `wind.js`. Il doit s'importer sous Node sans navigateur.
- Constantes de la spec, verbatim : `Z = 20`, `R_M = 30`, `W_MAX = 8`, `MAX_CELLS = 8000`, échantillonnage `SAMPLE_S = 0.2` (5 Hz).
- Forme persistée : `{ v: 1, z: 20, cells: [[x, y, w], ...] }`, clé opérateur `coverage`.
- BENCH n'écrit rien : garanti par construction (aucune session au banc) — **ne pas ajouter de `if (MODE.bench)` dans session.js**.
- Pas de `patch()` pendant le vol : une seule écriture, dans `session.end()`.
- Fin de chaque commit : `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` puis `Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8`.
- La branche est `feat/couverture-carte-245`. Elle est **empilée sur `feat/rtc-racine-toasts-243`** (PR #244, ouverte). Ne pas rebaser ; la PR #244 sera mergée avant d'ouvrir celle-ci.

---

### Task 1 : `src/coverage.js` — la grille et l'empreinte

**Files:**
- Create: `src/coverage.js`
- Create: `tools/coverage-selftest.mjs`

**Interfaces:**
- Produces:
  - `export const Z = 20, R_M = 30, W_MAX = 8, MAX_CELLS = 8000;`
  - `export function cellOf(lat, lon) → { x: int, y: int }` — tuile slippy à `Z`.
  - `export function cellCenter(x, y) → { lat, lon }` — centre géographique de la tuile.
  - `export function cellSizeM(lat) → number` — côté de la cellule en mètres à cette latitude.
  - `export function distanceM(a, b) → number` — distance plate en mètres entre deux `{lat, lon}` (équirectangulaire, suffisant à 30 m).
  - `export function stampCells(lat, lon, rM = R_M) → Array<{x, y}>` — cellules dont le **centre** est à moins de `rM` du point.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tools/coverage-selftest.mjs` :

```js
// Selftest de la couverture de carte (issue #245). Aucun DOM, aucun Leaflet :
// des lat/lon posées à la main et les formules slippy qu'on peut vérifier au
// calcul. Lancer : node tools/coverage-selftest.mjs
import assert from 'node:assert/strict';
import {
	Z, R_M, W_MAX, MAX_CELLS,
	cellOf, cellCenter, cellSizeM, distanceM, stampCells,
} from '../src/coverage.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// La Tour Eiffel, le point de référence du dépôt (public/scenes/tour-eiffel).
const EIFFEL = { lat: 48.8584, lon: 2.2945 };

t('constantes de la spec, verbatim', () => {
	assert.equal(Z, 20);
	assert.equal(R_M, 30);
	assert.equal(W_MAX, 8);
	assert.equal(MAX_CELLS, 8000);
});

t('cellOf : la tuile slippy z=20 de la Tour Eiffel, valeurs calculées à part', () => {
	// Calculées hors du module avec les formules OSM standard, pour que le test
	// ne soit pas la définition qu'il vérifie.
	assert.deepEqual(cellOf(EIFFEL.lat, EIFFEL.lon), { x: 530971, y: 360731 });
});

t('cellCenter : le centre de cette tuile retombe dans la tuile', () => {
	const c = cellCenter(530971, 360731);
	assert.ok(Math.abs(c.lat - 48.858503) < 1e-5, `lat ${c.lat}`);
	assert.ok(Math.abs(c.lon - 2.294598) < 1e-5, `lon ${c.lon}`);
	assert.deepEqual(cellOf(c.lat, c.lon), { x: 530971, y: 360731 });
});

t('cellSizeM : 25,1 m à Paris, 38,2 m à l\'équateur — la spec le dit', () => {
	assert.ok(Math.abs(cellSizeM(EIFFEL.lat) - 25.145) < 0.05, `${cellSizeM(EIFFEL.lat)}`);
	assert.ok(Math.abs(cellSizeM(0) - 38.22) < 0.05, `${cellSizeM(0)}`);
});

t('distanceM : 30 m vers l\'est font 30 m', () => {
	const east = { lat: EIFFEL.lat, lon: EIFFEL.lon + 30 / (111320 * Math.cos(EIFFEL.lat * Math.PI / 180)) };
	assert.ok(Math.abs(distanceM(EIFFEL, east) - 30) < 0.01);
	assert.equal(distanceM(EIFFEL, EIFFEL), 0);
});

t('stampCells : 4 à 5 cellules à Paris, jamais un 3×3 — les diagonales sont à 35,6 m', () => {
	// Au centre exact d'une cellule : elle-même + ses 4 voisines orthogonales.
	const c = cellCenter(530971, 360731);
	const atCentre = stampCells(c.lat, c.lon);
	assert.equal(atCentre.length, 5, `au centre : ${atCentre.length}`);
	// Toutes les cellules retenues ont leur centre à moins de R_M ; aucune
	// cellule à moins de R_M n'a été oubliée (on balaie un carré large autour).
	for (const cell of atCentre) {
		assert.ok(distanceM(c, cellCenter(cell.x, cell.y)) < R_M);
	}
	for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
		const x = 530971 + dx, y = 360731 + dy;
		const inside = distanceM(c, cellCenter(x, y)) < R_M;
		const kept = atCentre.some((k) => k.x === x && k.y === y);
		assert.equal(kept, inside, `cellule (${dx},${dy})`);
	}
	// Sur un coin de cellule : les 4 cellules qui se partagent le coin (à 17,8 m),
	// et rien d'autre (la couronne suivante est à ~40 m).
	const corner = stampCells(EIFFEL.lat, EIFFEL.lon).length;
	assert.ok(corner >= 4 && corner <= 5, `au point réel : ${corner}`);
});

t('stampCells : aucun trou le long d\'une trajectoire à 42,72 m/s échantillonnée à 5 Hz', () => {
	// La pire vitesse mesurée du dépôt (geofence.js WORST_MEASURED_SPEED_MS), un
	// pas de 0,2 s : 8,54 m entre deux échantillons, très en deçà des 30 m.
	// Chaque cellule que la ligne TRAVERSE doit être marquée par au moins un
	// échantillon.
	const speed = 42.72, dt = 0.2, steps = 40;
	const mPerDegLon = 111320 * Math.cos(EIFFEL.lat * Math.PI / 180);
	const marked = new Set();
	for (let i = 0; i <= steps; i++) {
		const lon = EIFFEL.lon + (i * speed * dt) / mPerDegLon;
		for (const c of stampCells(EIFFEL.lat, lon)) marked.add(`${c.x},${c.y}`);
	}
	// Les cellules traversées par la ligne elle-même : on échantillonne la ligne
	// tous les 2 m, bien plus fin que la cellule.
	const total = steps * speed * dt;
	for (let m = 0; m <= total; m += 2) {
		const lon = EIFFEL.lon + m / mPerDegLon;
		const c = cellOf(EIFFEL.lat, lon);
		assert.ok(marked.has(`${c.x},${c.y}`), `trou à ${m} m`);
	}
});

console.log(`\n${n} tests coverage OK`);
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run : `node tools/coverage-selftest.mjs`
Attendu : `ERR_MODULE_NOT_FOUND` sur `../src/coverage.js`.

- [ ] **Step 3 : Écrire l'implémentation minimale**

Créer `src/coverage.js` :

```js
// La couverture : là où le drone est passé (issue #245). Une tache sur la
// carte vivante qui s'étend sous les trajectoires, se densifie quand on repasse,
// et survit aux sessions.
//
// Ni THREE, ni Rapier, ni DOM, ni Leaflet — même règle et même raison que
// wind.js, fog.js, geofence.js : c'est la moitié que tools/coverage-selftest.mjs
// vérifie sans navigateur. Qui échantillonne en vol (session.js), qui écrit sur
// l'opérateur (session.js) et qui dessine (map-coverage.js) est ailleurs.
//
// Ce n'est PAS « la zone est acquise, donc explorée » : un cadre acquis où l'on
// n'a jamais volé reste vierge. Et ce n'est pas un brouillard de guerre : on
// marque où le drone est PASSÉ, pas ce que la caméra a VU — voir la spec pour
// ce qui a été écarté et pourquoi.

// ---------------------------------------------------------------------------
// La grille
//
// Des tuiles slippy à zoom FIXE, clé entière (x, y). Choisi plutôt qu'une grille
// en degrés parce que Leaflet est déjà en Web Mercator : une cellule se projette
// sans conversion au rendu, et l'indexation ne se déforme pas avec la latitude.
// À z=20 et 48,85° (Paris) une tuile fait 25,15 m de côté ; 38,2 m à l'équateur.
export const Z = 20;
const N = 2 ** Z;

// Le rayon de l'empreinte autour de la trajectoire, en mètres. À 25 m de
// cellule, ça fait 4 à 5 cellules par échantillon (les diagonales sont à
// 35,6 m et sortent du rayon) — la bonne approximation d'un disque de 30 m,
// dont l'aire vaut 2 827 m² pour 632 m² de cellule.
export const R_M = 30;

// Le poids sature : au-delà, repasser n'assombrit plus. Sans ce plafond, un
// stationnaire de deux minutes au même endroit écraserait à lui seul l'échelle
// de toute la carte.
export const W_MAX = 8;

// Plafond de cellules persistées, ~5 km² parcourus. UN PARI, écrit comme tel :
// il n'y a pas encore d'usage réel à mesurer. Ordre de grandeur : un vol de dix
// minutes à 15 m/s balaie 9 km de trajectoire, soit un couloir de 60 m de large,
// soit ~850 cellules à Paris. Une dizaine de vols sans recouvrement tiennent,
// bien davantage en usage réel où l'on repasse. À revoir sur des données.
export const MAX_CELLS = 8000;

const RAD = Math.PI / 180;
// Résolution Web Mercator au niveau de la mer, en m/px à z=0 pour une tuile de
// 256 px : 2π·6378137 / 256. La valeur canonique du format slippy.
const RES_Z0 = 156543.03392;

export function cellOf(lat, lon) {
	const latR = lat * RAD;
	const x = Math.floor((lon + 180) / 360 * N);
	const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * N);
	return { x, y };
}

export function cellCenter(x, y) {
	const lon = (x + 0.5) / N * 360 - 180;
	const n = Math.PI - 2 * Math.PI * (y + 0.5) / N;
	const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
	return { lat, lon };
}

export function cellSizeM(lat) {
	return RES_Z0 * Math.cos(lat * RAD) / N * 256;
}

// Distance plate. À l'échelle d'une empreinte de 30 m, la courbure ne pèse
// rien — c'est la même approximation que latLonOf() dans main.js.
export function distanceM(a, b) {
	const latM = 111320;
	const lonM = latM * Math.cos(((a.lat + b.lat) / 2) * RAD);
	const dx = (b.lon - a.lon) * lonM;
	const dy = (b.lat - a.lat) * latM;
	return Math.hypot(dx, dy);
}

// Les cellules dont le CENTRE est à moins de rM du point. On balaie un carré de
// ±k cellules autour de la cellule du point, k dimensionné par rM et la taille
// de cellule à cette latitude — +1 pour que le point posé sur un bord voie
// bien la cellule d'à côté.
export function stampCells(lat, lon, rM = R_M) {
	const at = { lat, lon };
	const c = cellOf(lat, lon);
	const k = Math.ceil(rM / cellSizeM(lat)) + 1;
	const out = [];
	for (let dx = -k; dx <= k; dx++) {
		for (let dy = -k; dy <= k; dy++) {
			const x = c.x + dx, y = c.y + dy;
			if (distanceM(at, cellCenter(x, y)) < rM) out.push({ x, y });
		}
	}
	return out;
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run : `node tools/coverage-selftest.mjs`
Attendu : `7 tests coverage OK`.

- [ ] **Step 5 : Commit**

```bash
git add src/coverage.js tools/coverage-selftest.mjs
git commit -m "$(cat <<'EOF'
feat(couverture): la grille slippy z=20 et l'empreinte de 30 m

Premier morceau de #245, pur : la tuile d'un point, le centre d'une tuile, la
taille de cellule à une latitude, et l'empreinte — les cellules dont le centre
est à moins de 30 m. Rien d'autre.

Tuiles slippy à zoom fixe plutôt qu'une grille en degrés : Leaflet est déjà en
Web Mercator, une cellule se projette sans conversion, et l'indexation ne se
déforme pas avec la latitude. 25,15 m à Paris, vérifié au calcul.

Le test de l'empreinte compte 5 cellules au centre d'une cellule et 4 sur un
coin, pas 9 : les diagonales sont à 35,6 m, hors du rayon. Et il vérifie qu'à
42,72 m/s (la pire vitesse mesurée du dépôt) échantillonnée à 5 Hz, aucune
cellule traversée n'échappe à l'empreinte.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 2 : `src/coverage.js` — le magasin : marquer, fusionner, borner, sérialiser

**Files:**
- Modify: `src/coverage.js` (ajouter à la fin)
- Modify: `tools/coverage-selftest.mjs` (ajouter avant la ligne `console.log(\`\n${n} tests coverage OK\`)`)

**Interfaces:**
- Consumes : `stampCells`, `W_MAX`, `MAX_CELLS`, `Z` de la Task 1.
- Produces :
  - `export class Coverage` avec :
    - `constructor()` — vide.
    - `static fromStored(any) → Coverage` — relit la forme persistée ; **n'importe quoi** d'invalide (undefined, null, mauvais `v`, mauvais `z`, cellules mal formées) rend une couverture vierge. Pas de migration.
    - `get size → int` — nombre de cellules.
    - `weightAt(x, y) → int` — 0 si absente.
    - `mark(lat, lon) → this` — applique l'empreinte, `w` saturé à `W_MAX`.
    - `merge(other) → Coverage` — NOUVELLE couverture, `w = min(W_MAX, wa + wb)`, ordre : les cellules de `this` d'abord (dans leur ordre), puis celles de `other` inconnues de `this`.
    - `cap(max = MAX_CELLS) → this` — évince jusqu'à `max` : poids le plus faible d'abord, puis le plus ancien (position dans l'ordre d'insertion).
    - `toStored() → { v: 1, z: 20, cells: [[x, y, w], ...] }` — dans l'ordre d'insertion.
    - `cells() → Array<{x, y, w}>` — lecture, ordre d'insertion.

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `tools/coverage-selftest.mjs`, après l'import existant, `Coverage` dans la liste importée :

```js
import {
	Z, R_M, W_MAX, MAX_CELLS,
	cellOf, cellCenter, cellSizeM, distanceM, stampCells,
	Coverage,
} from '../src/coverage.js';
```

Et avant le `console.log` final :

```js
// ---------------------------------------------------------------------------
// Le magasin

t('Coverage vierge : rien dedans, et toStored() a la forme de la spec', () => {
	const c = new Coverage();
	assert.equal(c.size, 0);
	assert.deepEqual(c.toStored(), { v: 1, z: Z, cells: [] });
});

t('mark : une empreinte, puis les poids montent et saturent à W_MAX', () => {
	const c = new Coverage();
	c.mark(EIFFEL.lat, EIFFEL.lon);
	const first = c.size;
	assert.ok(first >= 4 && first <= 5, `${first} cellules`);
	const { x, y } = cellOf(EIFFEL.lat, EIFFEL.lon);
	assert.equal(c.weightAt(x, y), 1);
	for (let i = 0; i < 50; i++) c.mark(EIFFEL.lat, EIFFEL.lon);
	assert.equal(c.size, first, 'repasser au même endroit n\'ajoute pas de cellule');
	assert.equal(c.weightAt(x, y), W_MAX, 'le poids sature');
	for (const cell of c.cells()) assert.ok(cell.w <= W_MAX);
});

t('toStored / fromStored : aller-retour exact, ordre d\'insertion conservé', () => {
	const c = new Coverage();
	c.mark(EIFFEL.lat, EIFFEL.lon);
	c.mark(EIFFEL.lat + 0.01, EIFFEL.lon);
	const stored = c.toStored();
	assert.equal(stored.v, 1);
	assert.equal(stored.z, Z);
	for (const triple of stored.cells) {
		assert.equal(triple.length, 3);
		for (const v of triple) assert.ok(Number.isInteger(v));
	}
	const back = Coverage.fromStored(JSON.parse(JSON.stringify(stored)));
	assert.deepEqual(back.toStored(), stored);
});

t('fromStored : n\'importe quoi d\'invalide se relit comme une couverture vierge', () => {
	// Pas de migration, pas de bump de schéma : un opérateur d'avant #245 marche
	// tel quel — la même promesse que dialogueMemory.
	for (const bad of [undefined, null, 42, 'x', {}, { v: 2, z: Z, cells: [] },
		{ v: 1, z: 19, cells: [] }, { v: 1, z: Z, cells: 'nope' },
		{ v: 1, z: Z, cells: [[1, 2]] }, { v: 1, z: Z, cells: [[1.5, 2, 3]] },
		{ v: 1, z: Z, cells: [[1, 2, 0]] }, { v: 1, z: Z, cells: [[1, 2, W_MAX + 1]] }]) {
		const c = Coverage.fromStored(bad);
		assert.equal(c.size, 0, `devrait être vierge pour ${JSON.stringify(bad)}`);
	}
});

t('merge : commutative sur le contenu, idempotente, poids additionnés puis saturés', () => {
	const a = new Coverage(); a.mark(EIFFEL.lat, EIFFEL.lon);
	const b = new Coverage(); b.mark(EIFFEL.lat, EIFFEL.lon); b.mark(EIFFEL.lat + 0.01, EIFFEL.lon);
	const ab = a.merge(b), ba = b.merge(a);
	// Même contenu (l'ordre peut différer, c'est celui du receveur d'abord).
	const key = (c) => c.cells().map((k) => `${k.x},${k.y}:${k.w}`).sort().join('|');
	assert.equal(key(ab), key(ba));
	const { x, y } = cellOf(EIFFEL.lat, EIFFEL.lon);
	assert.equal(ab.weightAt(x, y), 2, 'les poids s\'additionnent');
	// Idempotente : fusionner deux fois la même chose ne change rien.
	assert.equal(key(ab.merge(b)), key(ab.merge(b).merge(b)) === key(ab.merge(b)) ? key(ab.merge(b)) : '');
	// Saturation à la fusion.
	const full = new Coverage(); for (let i = 0; i < 20; i++) full.mark(EIFFEL.lat, EIFFEL.lon);
	assert.equal(full.merge(full).weightAt(x, y), W_MAX);
	// Les entrées ne sont pas modifiées : merge rend une NOUVELLE couverture.
	assert.equal(a.weightAt(x, y), 1);
});

t('cap : au-delà du plafond, les poids faibles partent d\'abord, puis les plus anciens', () => {
	const c = new Coverage();
	// 12 cellules posées à la main via fromStored : poids croissants sauf deux
	// « 1 » en tête, pour tester les deux critères.
	const cells = [];
	for (let i = 0; i < 12; i++) cells.push([1000 + i, 2000, i < 2 ? 1 : 2 + (i % 5)]);
	const cov = Coverage.fromStored({ v: 1, z: Z, cells });
	cov.cap(9);
	assert.equal(cov.size, 9);
	// Les deux « 1 » (les plus faibles) sont partis…
	assert.equal(cov.weightAt(1000, 2000), 0);
	assert.equal(cov.weightAt(1001, 2000), 0);
	// …puis, à poids égal (2), le plus ANCIEN : index 2 (w=2) avant index 7 (w=2).
	assert.equal(cov.weightAt(1002, 2000), 0);
	assert.equal(cov.weightAt(1007, 2000), 2);
	// Sous le plafond : no-op.
	const before = cov.toStored();
	cov.cap(9);
	assert.deepEqual(cov.toStored(), before);
	// Le plafond par défaut est MAX_CELLS.
	const big = new Coverage();
	const many = [];
	for (let i = 0; i < MAX_CELLS + 100; i++) many.push([i, 0, 1]);
	assert.equal(Coverage.fromStored({ v: 1, z: Z, cells: many }).cap().size, MAX_CELLS);
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run : `node tools/coverage-selftest.mjs`
Attendu : `SyntaxError: The requested module '../src/coverage.js' does not provide an export named 'Coverage'`.

- [ ] **Step 3 : Écrire l'implémentation minimale**

Ajouter à la fin de `src/coverage.js` :

```js
// ---------------------------------------------------------------------------
// Le magasin
//
// Une Map clé "x,y" → { x, y, w }, qui garde son ordre d'insertion : c'est
// l'ancienneté, dont l'éviction se sert pour départager les poids égaux.
//
// Forme persistée : { v: 1, z: 20, cells: [[x, y, w], ...] }. Un tableau de
// triplets plutôt qu'un objet indexé — moins d'octets par cellule en JSON, et
// l'ordre porte l'ancienneté. Au plafond, ~160 ko : gros pour une clé
// d'opérateur, et la raison pour laquelle session.js l'écrit UNE fois à la
// clôture et jamais en vol.
const key = (x, y) => `${x},${y}`;

export class Coverage {
	constructor() {
		this._cells = new Map();
	}

	// N'importe quoi d'invalide rend une couverture VIERGE : pas de migration,
	// pas de bump de schéma, un opérateur d'avant #245 marche tel quel — la
	// même promesse que dialogueMemory (src/dialogue.js). Une cellule mal
	// formée invalide tout : mieux vaut repartir de zéro que garder un fichier
	// à moitié lu qu'on croirait complet.
	static fromStored(stored) {
		const c = new Coverage();
		if (!stored || typeof stored !== 'object') return c;
		if (stored.v !== 1 || stored.z !== Z || !Array.isArray(stored.cells)) return c;
		const ok = (v) => Number.isInteger(v);
		for (const t of stored.cells) {
			if (!Array.isArray(t) || t.length !== 3) return new Coverage();
			const [x, y, w] = t;
			if (!ok(x) || !ok(y) || !ok(w) || w < 1 || w > W_MAX) return new Coverage();
			c._cells.set(key(x, y), { x, y, w });
		}
		return c;
	}

	get size() { return this._cells.size; }

	weightAt(x, y) { return this._cells.get(key(x, y))?.w ?? 0; }

	cells() { return [...this._cells.values()]; }

	mark(lat, lon) {
		for (const { x, y } of stampCells(lat, lon)) {
			const k = key(x, y);
			const cell = this._cells.get(k);
			if (cell) cell.w = Math.min(W_MAX, cell.w + 1);
			else this._cells.set(k, { x, y, w: 1 });
		}
		return this;
	}

	// Une NOUVELLE couverture : les deux entrées restent intactes. Les cellules
	// du receveur d'abord, dans leur ordre, puis celles de l'autre qu'il ne
	// connaissait pas — c'est ce qui fait que fusionner l'ancien opérateur avec
	// la session du jour garde l'ancienneté de l'ancien.
	merge(other) {
		const out = new Coverage();
		for (const c of this._cells.values()) out._cells.set(key(c.x, c.y), { ...c });
		for (const c of other._cells.values()) {
			const k = key(c.x, c.y);
			const mine = out._cells.get(k);
			if (mine) mine.w = Math.min(W_MAX, mine.w + c.w);
			else out._cells.set(k, { ...c });
		}
		return out;
	}

	// Évince jusqu'au plafond : ce qu'on a le moins vu s'efface avant ce qu'on
	// connaît bien, et à poids égal le plus ancien part le premier. Stable en
	// place : les survivants gardent leur ordre d'insertion.
	cap(max = MAX_CELLS) {
		const excess = this._cells.size - max;
		if (excess <= 0) return this;
		const ranked = [...this._cells.entries()]
			.map(([k, c], i) => ({ k, w: c.w, i }))
			.sort((a, b) => (a.w - b.w) || (a.i - b.i));
		for (let j = 0; j < excess; j++) this._cells.delete(ranked[j].k);
		return this;
	}

	toStored() {
		return { v: 1, z: Z, cells: [...this._cells.values()].map((c) => [c.x, c.y, c.w]) };
	}
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run : `node tools/coverage-selftest.mjs`
Attendu : `13 tests coverage OK`.

- [ ] **Step 5 : Commit**

```bash
git add src/coverage.js tools/coverage-selftest.mjs
git commit -m "$(cat <<'EOF'
feat(couverture): le magasin — marquer, fusionner, borner, sérialiser

La classe Coverage de #245 : une Map ordonnée de cellules, où l'ordre
d'insertion EST l'ancienneté. mark() applique l'empreinte et sature à W_MAX ;
merge() rend une nouvelle couverture, receveur d'abord pour garder l'ancienneté
de l'opérateur face à la session du jour ; cap() évince les poids faibles puis
les plus anciens ; toStored()/fromStored() font l'aller-retour sur la forme de
la spec.

fromStored() rend une couverture VIERGE pour tout ce qui n'est pas exactement
la forme attendue — v, z, chaque triplet, chaque borne de poids. Pas de
migration : un opérateur d'avant cette issue se relit tel quel, la promesse
qu'a déjà faite dialogueMemory.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 3 : `src/coverage.js` — planifier le dessin, sans Leaflet

**Files:**
- Modify: `src/coverage.js` (ajouter à la fin)
- Modify: `tools/coverage-selftest.mjs`

**Interfaces:**
- Consumes : `Coverage`, `cellCenter`, `W_MAX`.
- Produces :
  - `export const BLOB_RADIUS_CELLS = 1.6;` — rayon du dégradé en cellules (spec).
  - `export const ALPHA_MIN = 0.06, ALPHA_MAX = 0.16;` — alpha d'un dégradé à w=1 et w=W_MAX.
  - `export function planDraw(coverage, project, size) → Array<{ cx, cy, r, alpha }>` où :
    - `project(lat, lon) → { x, y }` en pixels conteneur,
    - `size = { w, h }` en pixels,
    - une cellule est retenue si son centre projeté tombe dans `[-r, w + r] × [-r, h + r]`,
    - `r = BLOB_RADIUS_CELLS × (taille projetée d'une cellule en px)`, mesurée en projetant le centre de la cellule ET le centre de sa voisine `x+1`,
    - `alpha = ALPHA_MIN + (ALPHA_MAX − ALPHA_MIN) × (w − 1) / (W_MAX − 1)`.

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à l'import `BLOB_RADIUS_CELLS, ALPHA_MIN, ALPHA_MAX, planDraw`, puis avant le `console.log` final :

```js
// ---------------------------------------------------------------------------
// Planifier le dessin — sans Leaflet, avec une projection linéaire jouée

t('planDraw : une cellule visible devient un disque au bon endroit, au bon rayon', () => {
	const cov = Coverage.fromStored({ v: 1, z: Z, cells: [[530971, 360731, 1]] });
	// Projection jouée : 10 px par cellule, origine au centre de la cellule.
	const c0 = cellCenter(530971, 360731), c1 = cellCenter(530972, 360731);
	const pxPerDegLon = 10 / (c1.lon - c0.lon);
	const pxPerDegLat = -10 / (cellCenter(530971, 360730).lat - c0.lat); // y vers le bas
	const project = (lat, lon) => ({ x: 100 + (lon - c0.lon) * pxPerDegLon, y: 100 - (lat - c0.lat) * pxPerDegLat });
	const plan = planDraw(cov, project, { w: 200, h: 200 });
	assert.equal(plan.length, 1);
	assert.ok(Math.abs(plan[0].cx - 100) < 1e-6 && Math.abs(plan[0].cy - 100) < 1e-6);
	assert.ok(Math.abs(plan[0].r - 10 * BLOB_RADIUS_CELLS) < 1e-6, `r=${plan[0].r}`);
	assert.ok(Math.abs(plan[0].alpha - ALPHA_MIN) < 1e-9, 'w=1 → ALPHA_MIN');
});

t('planDraw : l\'alpha monte linéairement avec le poids jusqu\'à ALPHA_MAX', () => {
	const cells = [];
	for (let w = 1; w <= W_MAX; w++) cells.push([530971 + w, 360731, w]);
	const cov = Coverage.fromStored({ v: 1, z: Z, cells });
	const project = (lat, lon) => ({ x: 100, y: 100 });
	const plan = planDraw(cov, project, { w: 200, h: 200 });
	assert.equal(plan.length, W_MAX);
	assert.ok(Math.abs(plan[0].alpha - ALPHA_MIN) < 1e-9);
	assert.ok(Math.abs(plan[W_MAX - 1].alpha - ALPHA_MAX) < 1e-9);
	for (let i = 1; i < plan.length; i++) assert.ok(plan[i].alpha > plan[i - 1].alpha);
});

t('planDraw : hors du cadre (au-delà du rayon), on ne dessine pas', () => {
	const cov = Coverage.fromStored({ v: 1, z: Z, cells: [[530971, 360731, 1], [530971, 360732, 1]] });
	// Première cellule loin dehors, seconde juste au bord (dans la marge r).
	let call = 0;
	const project = () => (call++ % 2 === 0 ? { x: -500, y: -500 } : { x: 205, y: 100 });
	// Chaque cellule projette deux fois (centre + voisine) : on rend la même
	// réponse pour les deux appels d'une cellule.
	const plan = planDraw(cov, (lat, lon) => {
		const i = Math.floor(call++ / 2);
		return i === 0 ? { x: -500, y: -500 } : { x: 205, y: 100 };
	}, { w: 200, h: 200 });
	// La première est hors cadre. La seconde est à 5 px du bord : gardée si
	// r >= 5 — or r vaut 0 quand centre et voisine projettent au même point, et
	// alors elle est hors cadre aussi. Ce qu'on vérifie : rien n'est dessiné
	// franchement dehors, et rien ne plante.
	assert.ok(plan.length <= 1);
	for (const p of plan) assert.ok(p.cx > -p.r && p.cx < 200 + p.r);
});

t('planDraw : une couverture vide rend un plan vide, quelle que soit la projection', () => {
	assert.deepEqual(planDraw(new Coverage(), () => ({ x: 0, y: 0 }), { w: 10, h: 10 }), []);
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run : `node tools/coverage-selftest.mjs`
Attendu : `does not provide an export named 'planDraw'`.

- [ ] **Step 3 : Écrire l'implémentation minimale**

Ajouter à la fin de `src/coverage.js` :

```js
// ---------------------------------------------------------------------------
// Planifier le dessin
//
// La partie du rendu qui se teste sans Leaflet : quelles cellules sont
// visibles, où, à quel rayon, à quel alpha. map-coverage.js ne fait plus que
// tracer ce plan sur un canvas. `project` est la projection lat/lon → pixels
// conteneur que Leaflet fournit (map.latLngToContainerPoint), passée en
// fonction pour rester pur ici.
//
// Chaque cellule devient un dégradé radial de 1,6 cellule de rayon, accumulé
// en 'lighter' par le dessinateur : les voisines se recouvrent et se fondent,
// c'est ce qui fait une tache et non une grille. L'alpha suit le poids : plus
// on repasse, plus c'est dense — jusqu'à W_MAX, où ça sature.
export const BLOB_RADIUS_CELLS = 1.6;
export const ALPHA_MIN = 0.06;
export const ALPHA_MAX = 0.16;

export function planDraw(coverage, project, size) {
	const out = [];
	for (const { x, y, w } of coverage.cells()) {
		const c = cellCenter(x, y);
		const p = project(c.lat, c.lon);
		// La taille projetée de la cellule : la distance au centre de la voisine.
		// Mesurée par cellule et non une fois pour toutes, parce que Mercator
		// étire avec la latitude et qu'une tache peut couvrir un pays.
		const q = project(cellCenter(x + 1, y).lat, cellCenter(x + 1, y).lon);
		const r = Math.hypot(q.x - p.x, q.y - p.y) * BLOB_RADIUS_CELLS;
		if (p.x < -r || p.x > size.w + r || p.y < -r || p.y > size.h + r) continue;
		const alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * (w - 1) / (W_MAX - 1);
		out.push({ cx: p.x, cy: p.y, r, alpha });
	}
	return out;
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run : `node tools/coverage-selftest.mjs`
Attendu : `17 tests coverage OK`.

- [ ] **Step 5 : Commit**

```bash
git add src/coverage.js tools/coverage-selftest.mjs
git commit -m "$(cat <<'EOF'
feat(couverture): planifier le dessin sans Leaflet

planDraw() dit quelles cellules sont visibles, où, à quel rayon et à quel
alpha, à partir d'une projection passée en fonction. C'est la moitié du rendu
qu'un banc peut vérifier : la colle Leaflet ne fera plus que tracer ce plan.

Le rayon est mesuré par cellule en projetant aussi la voisine, parce que
Mercator étire avec la latitude et qu'une tache peut couvrir un pays. L'alpha
est linéaire dans le poids, de ALPHA_MIN à w=1 jusqu'à ALPHA_MAX à W_MAX.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 4 : `session.js` — accumuler à 5 Hz, écrire une fois à la clôture

**Files:**
- Modify: `src/session.js`
- Modify: `tools/session-selftest.mjs`

**Interfaces:**
- Consumes : `Coverage` (Task 2), `operator.getOperator()`, `operator.patch(key, value)`, `operator.flush()` (existants).
- Produces :
  - `feed()` accepte un champ supplémentaire `geo` : **une fonction** `() => ({ lat, lon })` (ou `null`). Appelée seulement quand un échantillon est dû, pour que la conversion de coordonnées ne coûte rien entre deux échantillons. Un résultat non fini est ignoré.
  - `export const SAMPLE_S = 0.2;`
  - `export function coverage() → Coverage | null` — la couverture de la session en cours (lecture, pour les tests et le debug).
  - `end()` fusionne `Coverage.fromStored(operator.getOperator()?.coverage)` avec celle de la session, `cap()`, et `operator.patch('coverage', merged.toStored())` — **seulement si la session a marqué au moins une cellule**.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `tools/session-selftest.mjs`, étendre `stubOperator` pour accepter le `PATCH /__operator/:id` (clé `coverage`) : remplacer

```js
		if (/\/sessions\/[^/]+$/.test(url)) {
			return json({ session: { id: 'paris-0000', result: body.result, flightTelemetry: body.telemetry } });
		}
		throw new Error(`fetch non stubbé : ${method} ${url}`);
```

par

```js
		if (/\/sessions\/[^/]+$/.test(url)) {
			return json({ session: { id: 'paris-0000', result: body.result, flightTelemetry: body.telemetry } });
		}
		// La couverture (issue #245) : PATCH de la clé opérateur à la clôture.
		if (method === 'PATCH' && /\/__operator\/[^/]+$/.test(url)) {
			calls._operator = { ...(calls._operator ?? {}), [body.key]: body.value };
			return json({ operator: { id: 'neo-0000', ...calls._operator } });
		}
		throw new Error(`fetch non stubbé : ${method} ${url}`);
```

Puis ajouter, après le test `'feed n'accumule durée/distance que si armed ; open+end = 1 POST + 1 PATCH'` (donc après sa ligne `});`), et avant tout autre test :

```js
// ---------------------------------------------------------------------------
// La couverture (issue #245) : accumulée à 5 Hz en mémoire, écrite UNE fois.

const EIFFEL = { lat: 48.8584, lon: 2.2945 };

await ta('couverture : rien n\'est écrit pendant le vol, une seule écriture à la clôture', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });

	// Une seconde de vol armé à 60 Hz, position fixe : 5 échantillons attendus.
	let geoCalls = 0;
	const geo = () => { geoCalls++; return EIFFEL; };
	for (let i = 0; i < 60; i++) {
		session.feed({ speed: 1, horizontalSpeed: 1, rateDps: 0, altitudeAboveSpawn: 5, dt: 1 / 60, armed: true, geo });
	}
	assert.equal(geoCalls, 5, 'geo() n\'est appelée qu\'aux échantillons, pas à chaque frame');
	assert.ok(session.coverage().size >= 4, 'la couverture de la session a des cellules');
	assert.equal(calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url)).length, 0,
		'aucune écriture opérateur pendant le vol');

	await session.end('LANDED');
	await op.flush();
	const patches = calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	assert.equal(patches.length, 1, 'une seule écriture, à la clôture');
	assert.equal(patches[0].body.key, 'coverage');
	const stored = patches[0].body.value;
	assert.equal(stored.v, 1);
	assert.equal(stored.z, 20);
	assert.ok(stored.cells.length >= 4);
	// Le poids : 5 échantillons au même endroit → 5 sur la cellule du point.
	const centre = stored.cells.find(([x, y]) => x === 530971 && y === 360731);
	assert.ok(centre, 'la cellule de la Tour Eiffel est écrite');
	assert.equal(centre[2], 5);
});

await ta('couverture : désarmé ou gelé, on n\'échantillonne pas ; geo non fini ignoré', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 60; i++) {
		session.feed({ dt: 1 / 60, armed: false, geo: () => EIFFEL });   // posé
		session.feed({ dt: 0, armed: true, geo: () => EIFFEL });          // gelé
	}
	assert.equal(session.coverage().size, 0);
	for (let i = 0; i < 60; i++) {
		session.feed({ dt: 1 / 60, armed: true, geo: () => ({ lat: NaN, lon: 2 }) });
	}
	assert.equal(session.coverage().size, 0, 'une position dégénérée ne marque rien');
	await session.end('LANDED');
	await op.flush();
	assert.equal(calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url)).length, 0,
		'une session qui n\'a rien marqué n\'écrit pas la clé');
});

await ta('couverture : la clôture FUSIONNE avec ce que l\'opérateur avait déjà, puis borne', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	// L'opérateur arrive avec une couverture antérieure : la Tour Eiffel à w=3.
	op.getOperator().coverage = { v: 1, z: 20, cells: [[530971, 360731, 3]] };
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) {
		session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });   // 12 frames = 1 échantillon
	}
	await session.end('LANDED');
	await op.flush();
	const patch = calls.find((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	const centre = patch.body.value.cells.find(([x, y]) => x === 530971 && y === 360731);
	assert.equal(centre[2], 4, '3 (avant) + 1 (cette session)');
	// Et la clé est aussi à jour dans le cache client, sans attendre le réseau.
	assert.equal(op.getOperator().coverage.cells.find(([x, y]) => x === 530971 && y === 360731)[2], 4);
});

await ta('couverture : une couverture opérateur corrompue n\'empêche pas la clôture', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	op.getOperator().coverage = 'n\'importe quoi';
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });
	const s = await session.end('LANDED');
	assert.ok(s, 'la session se ferme');
	await op.flush();
	const patch = calls.find((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	assert.ok(patch, 'et la couverture repart de la session seule');
	assert.equal(patch.body.value.cells.find(([x, y]) => x === 530971 && y === 360731)[2], 1);
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run : `node tools/session-selftest.mjs`
Attendu : `TypeError: session.coverage is not a function` (ou `geoCalls` = 0).

- [ ] **Step 3 : Écrire l'implémentation minimale**

Dans `src/session.js` :

1. Après `import * as operator from './operator.js';` ajouter :

```js
import { Coverage } from './coverage.js';

// La couverture (issue #245) s'échantillonne à 5 Hz, pas à la frame : à
// 42,72 m/s — la pire vitesse mesurée du dépôt — deux échantillons sont à
// 8,5 m, très en deçà des 30 m de l'empreinte. Aucun trou possible, et
// rien à faire entre deux échantillons.
export const SAMPLE_S = 0.2;
```

2. Remplacer la ligne `let live = null; // { id, session, tel, closed }` par :

```js
let live = null; // { id, session, tel, closed, cov, sinceSample }
```

3. Dans `open()`, remplacer `live = { id: session.id, session, tel: zeroTel(), closed: false };` par :

```js
	live = { id: session.id, session, tel: zeroTel(), closed: false, cov: new Coverage(), sinceSample: 0 };
```

4. Après `export function current() { return live?.session ?? null; }` ajouter :

```js
// La couverture de la session en cours (issue #245), pour les bancs et le debug.
export function coverage() { return live?.cov ?? null; }
```

5. Remplacer la signature et le corps de `feed()` par :

```js
// Appelé une fois par frame. N'agrège durée et distance que quand le drone est
// armé — un drone posé et désarmé ne « vole » pas.
//
// `geo` (issue #245) : une FONCTION qui rend { lat, lon }, pas la valeur. Elle
// n'est appelée qu'aux échantillons (5 Hz), pour que la conversion ENU → lat/lon
// ne coûte rien entre deux. Un résultat non fini est ignoré : une position
// dégénérée (drone passé sous le terrain pendant une chute, #182) ne doit pas
// marquer une cellule au large de l'Afrique.
export function feed({ speed = 0, horizontalSpeed = 0, rateDps = 0, altitudeAboveSpawn = 0, dt = 0, armed = false, geo = null } = {}) {
	if (!live || live.closed) return;
	const t = live.tel;
	// Rien ne compte quand le drone est désarmé : ni la durée, ni la distance,
	// ni les pics — un drone posé qui rebondit sur sa sphère de collision n'est
	// pas en train de « voler à 2000 °/s ».
	if (!armed) return;
	if (dt > 0) {
		t.durationS += dt;
		t.distanceM += Math.max(0, horizontalSpeed) * dt;
		// dt = 0 quand la sim est gelée : on n'échantillonne pas en pause.
		live.sinceSample += dt;
		if (geo && live.sinceSample >= SAMPLE_S) {
			live.sinceSample = 0;
			const g = geo();
			if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) live.cov.mark(g.lat, g.lon);
		}
	}
	if (speed > t.maxSpeedMs) t.maxSpeedMs = speed;
	if (rateDps > t.maxRateDps) t.maxRateDps = rateDps;
	if (altitudeAboveSpawn > t.maxAltitudeM) t.maxAltitudeM = altitudeAboveSpawn;
}
```

6. Dans `end()`, remplacer :

```js
	const { id, tel } = live;
	try {
		const session = await operator.patchSession(id, { result, telemetry: round(tel) });
		live.session = session;
		return session;
	} catch (e) {
```

par :

```js
	const { id, tel } = live;
	// La couverture s'écrit ICI et une seule fois (issue #245). operator.patch()
	// est débouncé mais réémet toute la valeur à chaque flush : patcher en vol
	// enverrait le blob entier plusieurs fois par seconde. Et c'est ce qui a du
	// sens : le monde retient ce qu'une session a FAIT, pas ce qu'elle fait.
	//
	// Le banc n'arrive jamais ici : il n'ouvre aucune session, donc `live` est
	// null et feed() ne marque rien. NOTHING LOGGED est acquis par construction,
	// sans garde à maintenir.
	//
	// Avant le PATCH de la session : si celui-ci échoue, la couverture est
	// quand même dans le cache client et partira au prochain flush — un vol
	// dont on perd la fiche ne doit pas aussi perdre sa trace sur la carte.
	flushCoverage();
	try {
		const session = await operator.patchSession(id, { result, telemetry: round(tel) });
		live.session = session;
		return session;
	} catch (e) {
```

7. Après la fonction `end()` (avant `// Envoyé ... beacon`), ajouter :

```js
// Fusionne la couverture de la session avec celle de l'opérateur, borne, et
// pose la clé dans le cache client via patch() — écrite au prochain flush
// (debounce, visibilitychange ou beforeunload). Une session qui n'a rien marqué
// n'écrit rien : pas de clé posée pour rien sur un opérateur qui n'en avait pas.
//
// La couverture opérateur est relue par fromStored(), qui rend une couverture
// vierge pour tout ce qui n'est pas exactement la forme attendue : un fichier
// corrompu repart de la session seule plutôt que de bloquer la clôture.
function flushCoverage() {
	if (!live || live.cov.size === 0) return;
	try {
		const before = Coverage.fromStored(operator.getOperator()?.coverage);
		const merged = before.merge(live.cov).cap();
		operator.patch('coverage', merged.toStored());
	} catch (e) {
		console.warn('[session] couverture non écrite (cosmétique)', e);
	}
}
```

8. Dans `beacon()`, ajouter avant `try {` :

```js
	// sendBeacon ne fait que des POST, et la couverture voyage par un PATCH de
	// clé opérateur : la trace de CETTE session est perdue si l'onglet meurt.
	// Assumé (spec #245) — la fiche de session, elle, part bien.
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run : `node tools/session-selftest.mjs`
Attendu : `40 tests session OK` (36 + 4). Vérifier aussi que le process **se termine** (aucun timer de debounce orphelin — les tests appellent `op.flush()` qui les vide).

Run : `node tools/coverage-selftest.mjs` — inchangé, `17 tests coverage OK`.

- [ ] **Step 5 : Commit**

```bash
git add src/session.js tools/session-selftest.mjs
git commit -m "$(cat <<'EOF'
feat(couverture): la session échantillonne à 5 Hz et écrit une fois à la clôture

feed() accepte `geo`, une FONCTION qui rend { lat, lon } : appelée seulement
quand un échantillon est dû (SAMPLE_S = 0,2 s de vol armé), pour que la
conversion ENU → lat/lon ne coûte rien entre deux. Un résultat non fini est
ignoré — une position dégénérée (#182) ne marque pas une cellule au large de
l'Afrique. Gelé (dt = 0) ou désarmé, on n'échantillonne pas.

end() fusionne la couverture de la session avec celle de l'opérateur, borne, et
pose la clé par operator.patch() — AVANT le PATCH de la session, pour qu'un vol
dont on perd la fiche ne perde pas aussi sa trace. Une seule écriture : patch()
réémet toute la valeur à chaque flush, patcher en vol enverrait le blob entier
plusieurs fois par seconde. Une session qui n'a rien marqué n'écrit rien.

Le banc n'arrive jamais là : il n'ouvre aucune session, `live` est null, feed()
ne marque rien. NOTHING LOGGED par construction, sans garde à maintenir.

sendBeacon ne fait que des POST : si l'onglet meurt, la trace de cette session
est perdue. Assumé, et écrit à côté du beacon.

Le test vérifie que geo() n'est appelée que 5 fois pour 60 frames, qu'aucun
PATCH opérateur ne part pendant le vol, qu'un seul part à la clôture avec la
forme de la spec, que la fusion additionne 3 + 1, et qu'un opérateur corrompu
n'empêche pas la clôture.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 5 : `main.js` — fournir la position géographique, cuit et live

**Files:**
- Modify: `src/main.js` (autour de la ligne 1408 `function latLonOf(p)` et de la ligne 2003 `session.feed({`)

**Interfaces:**
- Consumes : `session.feed({ ..., geo })` (Task 4) ; `latLonOf(p)`, `liveWindow`, `localEnuToEcef`, `ecefToGeodetic` (existants dans main.js).
- Produces : `function droneGeo(p) → { lat, lon }` (peut être NaN) — interne à main.js.

- [ ] **Step 1 : Vérifier l'état de départ**

Run : `grep -n "geo:" src/main.js`
Attendu : aucune ligne (le champ n'existe pas encore).

Run : `grep -n "^function latLonOf" src/main.js` → une ligne, ~1408.
Run : `grep -n "^\tif (!MODE.bench) {$" src/main.js` → une ligne, ~2003, immédiatement suivie de `\t\tsession.feed({`.

- [ ] **Step 2 : Ajouter `droneGeo()` juste après `latLonOf()`**

Après la fermeture `}` de `function latLonOf(p) { ... }`, insérer :

```js
// La position géographique du drone pour la couverture (issue #245), cuit ou
// live, un seul chemin de sortie : { lat, lon }, éventuellement NaN — c'est
// session.feed() qui ignore un résultat non fini.
//
// - terrain cuit : latLonOf(), l'approximation plate déjà jugée suffisante sur
//   une scène de deux kilomètres ;
// - live : la même conversion ENU → ECEF → géodésique que la fenêtre de
//   streaming fait déjà chaque frame plus haut (#182 pour la garde NaN, qui
//   vit côté session).
//
// Appelée SEULEMENT aux échantillons (5 Hz) : session.feed() reçoit la fonction,
// pas la valeur.
function droneGeo(p) {
	if (liveWindow) {
		const ecef = localEnuToEcef(p, liveWindow.originEcef, liveWindow.originBasis);
		const g = ecefToGeodetic(...ecef);
		return { lat: g.lat, lon: g.lon };
	}
	return latLonOf(p);
}
```

- [ ] **Step 3 : Passer `geo` à `session.feed()`**

Remplacer (indentation : tabulations) :

```js
	if (!MODE.bench) {
		session.feed({
			speed: Math.hypot(v.x, v.y, v.z),
			horizontalSpeed: Math.hypot(v.x, v.z),
			rateDps: Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) * 180 / Math.PI,
			altitudeAboveSpawn: p.y - spawnY,
			dt: frozen ? 0 : dt,
			armed: controller.armed,
		});
	}
```

par :

```js
	if (!MODE.bench) {
		session.feed({
			speed: Math.hypot(v.x, v.y, v.z),
			horizontalSpeed: Math.hypot(v.x, v.z),
			rateDps: Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) * 180 / Math.PI,
			altitudeAboveSpawn: p.y - spawnY,
			dt: frozen ? 0 : dt,
			armed: controller.armed,
			// La couverture (issue #245) : une fonction, appelée par session.js
			// seulement quand un échantillon est dû — rien entre deux.
			geo: () => droneGeo(p),
		});
	}
```

- [ ] **Step 4 : Vérifier que ça charge et que ça construit**

Run : `npm run build 2>&1 | tail -2`
Attendu : `✓ built in …s`, aucune erreur.

Run : `node tools/selftest.mjs public/scenes/paristest 2>&1 | tail -1`
Attendu : `all checks passed` (main.js n'est pas chargé par ce banc, mais on vérifie qu'aucun import cassé ne s'est glissé dans src/).

- [ ] **Step 5 : Commit**

```bash
git add src/main.js
git commit -m "$(cat <<'EOF'
feat(couverture): main.js fournit la position géographique, cuit et live

droneGeo(p) rend { lat, lon } par un seul chemin de sortie : latLonOf() sur
terrain cuit, la conversion ENU → ECEF → géodésique de la fenêtre rocktree en
live. Passée à session.feed() comme FONCTION : session.js ne l'appelle qu'aux
échantillons, la frame ne paie rien.

Le garde MODE.bench qui entoure déjà feed() reste — et il est redondant pour la
couverture, qui est déjà exemptée par construction (aucune session au banc).
Deux ceintures valent mieux qu'une quand la promesse s'appelle NOTHING LOGGED.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 6 : le serveur accepte la clé `coverage`

**Files:**
- Modify: `tools/map-api-plugin.mjs:92-98`
- Modify: `tools/session-api-selftest.mjs` (après le bloc `dialogueMemory fait l'aller-retour sur disque`)

**Interfaces:**
- Produces : `PATCH /__operator/:id` avec `{ key: 'coverage', value }` → 200, et la valeur fait l'aller-retour sur disque.

- [ ] **Step 1 : Écrire le test qui échoue**

Dans `tools/session-api-selftest.mjs`, après :

```js
	const reread = await call('GET', `/__operator/${id}`);
	check('dialogueMemory fait l\'aller-retour sur disque',
		JSON.stringify(reread.body.operator.dialogueMemory) === JSON.stringify(memory));
```

ajouter :

```js
	// `coverage` (issue #245) : même contrat que dialogueMemory — acceptée,
	// persistée, et bornée côté client seulement (cap() dans src/coverage.js).
	const coverage = { v: 1, z: 20, cells: [[530971, 360731, 3], [530972, 360731, 1]] };
	const covPatched = await call('PATCH', `/__operator/${id}`, { key: 'coverage', value: coverage });
	check('PATCH coverage : acceptée et persistée',
		covPatched.status === 200 && covPatched.body.operator.coverage !== undefined);
	const covReread = await call('GET', `/__operator/${id}`);
	check('coverage fait l\'aller-retour sur disque',
		JSON.stringify(covReread.body.operator.coverage) === JSON.stringify(coverage));
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run : `node tools/session-api-selftest.mjs 2>&1 | grep -i "coverage\|FAIL"`
Attendu : `FAIL  PATCH coverage : acceptée et persistée` (le serveur rend 400 « clé non modifiable : coverage »).

- [ ] **Step 3 : Ajouter la clé à la liste blanche**

Dans `tools/map-api-plugin.mjs`, remplacer :

```js
// entrées, table de 512 vus, dans tools/dialogue/engine.mjs).
const OP_WRITABLE_KEYS = new Set(['controlVector', 'settings', 'dialogueMemory']);
```

par :

```js
// entrées, table de 512 vus, dans tools/dialogue/engine.mjs).
//
// `coverage` (issue #245) : là où le drone est passé, en cellules slippy z=20.
// Même contrat que dialogueMemory — écrite par operator.patch() une fois par
// session (src/session.js), cosmétique, sans validation de forme ici parce que
// bornée côté client : MAX_CELLS = 8000 et W_MAX = 8 dans src/coverage.js, et
// fromStored() y rend une couverture vierge pour tout ce qui n'est pas la
// forme attendue. Un opérateur sans cette clé se relit comme une carte vierge.
const OP_WRITABLE_KEYS = new Set(['controlVector', 'settings', 'dialogueMemory', 'coverage']);
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run : `node tools/session-api-selftest.mjs 2>&1 | tail -3`
Attendu : la dernière ligne annonce le total sans `FAIL`, et les deux nouvelles lignes `ok  PATCH coverage…` / `ok  coverage fait l'aller-retour…` apparaissent (`grep coverage`).

- [ ] **Step 5 : Commit**

```bash
git add tools/map-api-plugin.mjs tools/session-api-selftest.mjs
git commit -m "$(cat <<'EOF'
feat(couverture): le serveur accepte la clé opérateur `coverage`

OP_WRITABLE_KEYS est une liste blanche : sans cette ligne, le PATCH de la
clôture de session rend 400 et la trace n'est jamais écrite — exactement le bug
qu'a connu dialogueMemory, et exactement le test qui l'a attrapé, rejoué ici
pour la nouvelle clé.

Même contrat que dialogueMemory : pas de validation de forme côté serveur PARCE
QUE le client borne (MAX_CELLS, W_MAX) et relit défensivement (fromStored).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 7 : `src/map-coverage.js` — le calque Leaflet, et son montage sur la carte de FIELD

**Files:**
- Create: `src/map-coverage.js`
- Modify: `src/scanner.js` (imports ~ligne 13-28 ; après `const areaFrames = L.layerGroup().addTo(map);` ~ligne 278 ; dans l'objet rendu ~ligne 1112-1123)
- Modify: `src/terminal.js:799` (après `scanner.setAreaFrames(...)`)
- Modify: `src/style.css` (à côté de `.map-mono`, ~ligne 713)

**Interfaces:**
- Consumes : `Coverage.fromStored`, `planDraw` (Tasks 2-3) ; `operatorApi.getOperator()` (déjà importé dans scanner.js) ; `token('--warm-white')` (déjà importé).
- Produces :
  - `export function createCoverageLayer(L, { getCoverage, color }) → L.Layer` avec, en plus de l'API Leaflet, une méthode `refresh()` qui relit `getCoverage()` et redessine.
  - `runScanner()` rend en plus `refreshCoverage()`.

- [ ] **Step 1 : Écrire `src/map-coverage.js`**

```js
// La couverture sur la carte (issue #245) : la colle Leaflet. Tout ce qui se
// calcule sans navigateur — quelles cellules, où, à quel rayon, à quel alpha —
// est dans src/coverage.js (planDraw) et vérifié là ; ici il ne reste qu'un
// canvas et le cycle de vie d'un calque.
//
// Un pane dédié, sous les vecteurs : la tache est un FOND, pas un objet qu'on
// désigne. overlayPane est à 400 et porte les cadres de zone (SVG) ; tilePane
// à 200. À 350 le canvas passe au-dessus des tuiles et sous les cadres, sans
// dépendre de l'ordre dans lequel Leaflet a créé son renderer SVG.
//
// `L` est reçu en paramètre et non importé : le module reste importable sous
// Node pour les bancs (Leaflet touche `window` au chargement).
const PANE = 'coverage';
const PANE_Z = 350;

export function createCoverageLayer(L, { getCoverage, color = '#ece7dd', planDraw }) {
	const rgb = hexToRgb(color);

	const Layer = L.Layer.extend({
		onAdd(map) {
			this._map = map;
			if (!map.getPane(PANE)) {
				map.createPane(PANE).style.zIndex = String(PANE_Z);
			}
			const canvas = L.DomUtil.create('canvas', 'map-coverage leaflet-zoom-hide', map.getPane(PANE));
			this._canvas = canvas;
			this._ctx = canvas.getContext('2d');
			map.on('moveend zoomend viewreset resize', this._redraw, this);
			this._redraw();
		},

		onRemove(map) {
			map.off('moveend zoomend viewreset resize', this._redraw, this);
			L.DomUtil.remove(this._canvas);
			this._canvas = null;
			this._ctx = null;
			this._map = null;
		},

		// Relit la couverture (celle de l'opérateur peut avoir changé après un
		// vol) et redessine. Inoffensif hors carte.
		refresh() { if (this._map) this._redraw(); },

		_redraw() {
			const map = this._map, canvas = this._canvas, ctx = this._ctx;
			if (!map || !canvas) return;
			const size = map.getSize();
			// Le canvas suit la taille du conteneur et se repositionne sur le
			// coin haut-gauche du conteneur dans le repère du calque : c'est ce
			// qui le garde en place pendant un déplacement de carte.
			const dpr = window.devicePixelRatio || 1;
			if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
				canvas.width = size.x * dpr;
				canvas.height = size.y * dpr;
				canvas.style.width = `${size.x}px`;
				canvas.style.height = `${size.y}px`;
			}
			L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, size.x, size.y);

			const cov = getCoverage();
			if (!cov || cov.size === 0) return;
			const project = (lat, lon) => {
				const p = map.latLngToContainerPoint([lat, lon]);
				return { x: p.x, y: p.y };
			};
			const plan = planDraw(cov, project, { w: size.x, h: size.y });

			// 'lighter' additionne : deux dégradés qui se recouvrent font une
			// zone plus dense, et c'est exactement « plus tu repasses, plus c'est
			// dense ». Le rayon minimal de 1,5 px garde un point visible au zoom
			// monde, où une cellule est sous-pixel.
			ctx.globalCompositeOperation = 'lighter';
			for (const { cx, cy, r, alpha } of plan) {
				const rr = Math.max(1.5, r);
				const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
				g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
				g.addColorStop(1, `rgba(${rgb}, 0)`);
				ctx.fillStyle = g;
				ctx.beginPath();
				ctx.arc(cx, cy, rr, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalCompositeOperation = 'source-over';
		},
	});

	return new Layer();
}

// '#ece7dd' → '236, 231, 221'. Les tokens du dépôt sont en hex 6 chiffres.
function hexToRgb(hex) {
	const h = hex.replace('#', '');
	const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
	return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
```

- [ ] **Step 2 : Vérifier que le module charge sous Node**

Run : `node -e "import('./src/map-coverage.js').then(m => console.log(typeof m.createCoverageLayer))"`
Attendu : `function`.

- [ ] **Step 3 : Monter le calque dans `scanner.js`**

1. Imports : après `import { previewBounds } from '../tools/map-preview-model.mjs';` ajouter :

```js
import { Coverage, planDraw } from './coverage.js';
import { createCoverageLayer } from './map-coverage.js';
```

2. Après `const areaFrames = L.layerGroup().addTo(map);` (et avant le commentaire `// Dessine le cadre de chaque zone du cache.`), ajouter :

```js
	// La couverture (issue #245) : là où le drone est passé, sous les cadres.
	// Relue dans le cache opérateur à chaque redraw — operator.patch() y écrit
	// de façon synchrone à la clôture d'une session, donc la Home qui suit un
	// vol voit la tache sans attendre le réseau.
	const coverage = createCoverageLayer(L, {
		color: token('--warm-white'),
		planDraw,
		getCoverage: () => Coverage.fromStored(operatorApi.getOperator()?.coverage),
	}).addTo(map);
```

3. Dans l'objet rendu par `runScanner()`, après la ligne `busy: () => !!state.jobId,` ajouter :

```js
		// Redessine la tache depuis le cache opérateur (issue #245) — la Home
		// l'appelle quand elle relit les zones, au même moment que setAreaFrames.
		refreshCoverage: () => coverage.refresh(),
```

- [ ] **Step 4 : Appeler le rafraîchissement depuis `terminal.js`**

Dans `src/terminal.js`, remplacer :

```js
			scanner.setMode(tab);
			scanner.setAreaFrames(Array.isArray(scenes) ? scenes : []);
```

par :

```js
			scanner.setMode(tab);
			scanner.setAreaFrames(Array.isArray(scenes) ? scenes : []);
			scanner.refreshCoverage();
```

Puis chercher les autres appels : `grep -n "setAreaFrames" src/terminal.js`. Pour chaque autre occurrence de `scanner?.setAreaFrames(...)`, ajouter juste après, avec la même garde optionnelle : `scanner?.refreshCoverage();`.

- [ ] **Step 5 : Le CSS**

Dans `src/style.css`, juste après la ligne `.map-mono { position: relative; background: var(--dark-grey); }`, ajouter :

```css
/* La tache de couverture (issue #245) : un canvas dans son pane, sous les
   cadres de zone. `pointer-events: none` parce que c'est un fond — la carte
   dessous doit rester déplaçable et les cadres cliquables. Le flou finit de
   fondre les dégradés en tache ; il est petit parce que les cellules sont
   déjà des dégradés radiaux qui se recouvrent. Non filtré par `.sc-invert` /
   `.sc-gray`, qui ne portent que sur la couche de tuiles : l'encre reste
   celle du terminal. */
.map-coverage { pointer-events: none; filter: blur(1.5px); }
```

- [ ] **Step 6 : Construire et lancer les bancs qui touchent ces écrans**

Run : `npm run build 2>&1 | tail -1` → `✓ built`.
Run : `node tools/scanner-selftest.mjs 2>&1 | tail -1` → `38 vérifications, tout passe.`
Run : `node tools/terminal-render-selftest.mjs 2>&1 | grep -v Warning | tail -1` → `13 tests terminal-render OK`.
Run : `node tools/coverage-selftest.mjs 2>&1 | tail -1` → `17 tests coverage OK`.

- [ ] **Step 7 : Voir la tache — sur le serveur de dev du joueur, sans le toucher**

Le serveur vite tourne déjà sur `http://localhost:5173` et recharge tout seul. Ouvrir cette URL dans Chrome (outils `mcp__claude-in-chrome__*`), passer l'intro, arriver sur SELECT OPERATION MODE → FIELD. Dans la console de la page, injecter une couverture de test **sans rien persister** :

```js
// Dans la console : une tache jouée autour de la Tour Eiffel, w croissant,
// posée sur le cache client seulement (pas de patch, rien n'est écrit).
const op = (await import('/src/operator.js')).getOperator();
const cells = [];
for (let dx = -8; dx <= 8; dx++) for (let dy = -3; dy <= 3; dy++) {
	const w = Math.max(1, Math.min(8, 8 - Math.round(Math.hypot(dx / 2, dy))));
	cells.push([530971 + dx, 360731 + dy, w]);
}
op.coverage = { v: 1, z: 20, cells };
```

Puis cliquer le cadre `paristest` sur la carte (ou zoomer sur Paris) et prendre une capture. Attendu : une traînée douce, plus dense au centre, **sous** les cadres blancs, qui suit la carte au déplacement et ne bouge pas pendant le zoom. Recharger la page ensuite pour effacer l'injection (le cache client seul a été touché).

Enregistrer la capture avec `save_to_disk: true` et noter son chemin dans HANDOFF (Task 8).

- [ ] **Step 8 : Commit**

```bash
git add src/map-coverage.js src/scanner.js src/terminal.js src/style.css
git commit -m "$(cat <<'EOF'
feat(couverture): le calque Leaflet, monté sous les cadres de la carte de FIELD

map-coverage.js ne fait que tracer le plan de planDraw() sur un canvas : un
dégradé radial par cellule, accumulé en 'lighter' pour que repasser densifie,
un léger flou CSS pour finir de fondre. Tout ce qui se calcule sans navigateur
est resté dans coverage.js, où le banc le vérifie.

Un pane dédié à z=350 : au-dessus des tuiles (200), sous les cadres de zone
(overlayPane, 400) — la tache est un fond, pas un objet. `L` est reçu en
paramètre pour que le module s'importe sous Node.

Le calque relit le cache opérateur à chaque redraw : operator.patch() y écrit
de façon synchrone à la clôture, donc la Home qui suit un vol voit la tache
sans attendre le réseau. refreshCoverage() est appelé là où setAreaFrames l'est.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

### Task 8 : la chaîne de tests, HANDOFF, et la PR

**Files:**
- Modify: `package.json` (script `selftest:operator`)
- Modify: `HANDOFF.md` (nouvelle section avant `## Non vérifié / à faire`)

- [ ] **Step 1 : Chaîner le nouveau banc**

Dans `package.json`, dans la valeur de `"selftest:operator"`, remplacer :

```
node tools/session-selftest.mjs && node tools/target-selftest.mjs
```

par :

```
node tools/session-selftest.mjs && node tools/coverage-selftest.mjs && node tools/target-selftest.mjs
```

Run : `node -e "JSON.parse(require('fs').readFileSync('package.json'))" && echo ok` → `ok`.

- [ ] **Step 2 : La section HANDOFF**

Insérer dans `HANDOFF.md`, juste avant la ligne `## Non vérifié / à faire`, en remplaçant `<chemin-capture>` par le chemin réel de la capture de la Task 7 :

```markdown
## Couverture : la tache là où le drone est passé (issue #245)

Une tache douce s'étend sur la carte de FIELD sous les trajectoires, se
densifie quand on repasse, et survit aux sessions. Ce n'est PAS « la zone est
acquise, donc explorée » : un cadre où l'on n'a jamais volé reste vierge.
Spec : `docs/superpowers/specs/2026-09-06-map-coverage-design.md`.

**Trois contraintes du dépôt ont façonné le design, vérifiées avant d'écrire :**

- **Le banc n'écrit rien, par construction.** BENCH n'ouvre aucune session
  (`main.js:2680`) ; la couverture vit dans `session.js`, donc au banc `live`
  est null et rien n'est marqué. Aucun `if (MODE.bench)` à maintenir.
- **Une seule écriture, à la clôture.** `operator.patch()` réémet toute la
  valeur à chaque flush : patcher en vol enverrait ~160 ko plusieurs fois par
  seconde. `session.end()` fusionne, borne et patche une fois — AVANT le PATCH
  de la session, pour qu'un vol dont on perd la fiche garde sa trace.
- **`OP_WRITABLE_KEYS` est une liste blanche** (`map-api-plugin.mjs`) : `coverage`
  y est, avec le même contrat que `dialogueMemory` — pas de validation serveur
  parce que le client borne (`MAX_CELLS = 8000`, `W_MAX = 8`) et relit
  défensivement (`fromStored()` rend une couverture vierge pour tout ce qui
  n'est pas la forme attendue).

**La grille** : tuiles slippy à zoom fixe 20 — 25,15 m à Paris, parce que
Leaflet est déjà en Web Mercator. Empreinte de 30 m autour de chaque échantillon
(4 à 5 cellules, pas un 3×3 : les diagonales sont à 35,6 m), échantillonné à
5 Hz de vol armé — à 42,72 m/s ça fait 8,5 m entre deux, aucun trou possible.

**Le plafond de 8 000 cellules est un pari**, écrit comme tel dans
`coverage.js` : ~850 cellules par vol de dix minutes, donc une dizaine de vols
sans recouvrement. À revoir sur du vrai usage, pas sur une intuition.

**Perdu si l'onglet meurt** : `sendBeacon` ne fait que des POST, la couverture
voyage par PATCH. La fiche de session part, sa trace non. Assumé.

### Vérifié — sans navigateur

`node tools/coverage-selftest.mjs` (17) : la tuile de la Tour Eiffel calculée à
part, la taille de cellule à Paris et à l'équateur, l'empreinte (5 au centre,
4 sur un coin, et aucune cellule traversée oubliée à 42,72 m/s), la saturation,
l'aller-retour de sérialisation, une douzaine de formes corrompues qui rendent
une couverture vierge, la fusion commutative sur le contenu et idempotente,
l'éviction par poids puis ancienneté, et le plan de dessin avec une projection
jouée. `session-selftest` (+4) : geo() n'est appelée qu'aux échantillons, aucun
PATCH pendant le vol, un seul à la clôture, la fusion 3 + 1, un opérateur
corrompu n'empêche pas la clôture. `session-api-selftest` (+2) : la clé fait
l'aller-retour sur disque.

### Vérifié à l'œil — Chrome sur le serveur de dev, couverture INJECTÉE

Capture : `<chemin-capture>`. Une tache jouée autour de la Tour Eiffel, posée
dans le cache client seulement : elle est douce, plus dense au centre, sous les
cadres, suit la carte au déplacement et ne bouge pas au zoom.

### NON vérifié — demande un vrai vol

La couverture injectée ne dit rien de la vraie : reste à voir, après un vol
FIELD réel puis un retour à la Home, que la tache est bien là où l'on a volé et
qu'elle survit à un rechargement ; qu'un vol LIVE marque au bon endroit ; que
dix sessions ne noircissent pas la carte ; et ce que vaut le plafond.
```

- [ ] **Step 3 : Tout relancer**

Run : `npm run build 2>&1 | tail -1` → `✓ built`.
Run : `for t in coverage session scanner terminal-render bench-render dialogue-render; do node tools/$t-selftest.mjs 2>&1 | grep -v Warning | tail -1; done` → six lignes vertes.
Run : `node tools/session-api-selftest.mjs 2>&1 | tail -1` → aucun `FAIL`.
Run : `node tools/selftest.mjs public/scenes/paristest 2>&1 | tail -1` → `all checks passed`.
Run : `git status --short` → seul `sim/public/scenes.json` doit rester non stagé (il ne nous appartient pas).

- [ ] **Step 4 : Commit**

```bash
git add package.json HANDOFF.md
git commit -m "$(cat <<'EOF'
docs(couverture): chaîner le banc, consigner l'état vérifié et non vérifié

coverage-selftest rejoint selftest:operator juste après session-selftest.

HANDOFF sépare ce qu'un banc prouve (la grille, l'empreinte, la saturation, la
fusion, l'éviction, le plan de dessin, la clôture qui écrit une fois), ce qu'un
œil a vu (une tache INJECTÉE, qui ne dit rien de la vraie), et ce qu'il reste
à voir : un vol réel, un vol live, dix sessions, et ce que vaut le plafond.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
git push -u origin feat/couverture-carte-245
```

- [ ] **Step 5 : La PR — après que #244 est mergée**

Vérifier d'abord : `gh pr view 244 --json state | jq -r .state`. Si `OPEN`, **s'arrêter et le dire** : cette branche est empilée sur #244, la PR contiendrait ses commits. Une fois `MERGED` :

```bash
gh pr create --title "feat(couverture): la tache là où le drone est passé" --body "$(cat <<'EOF'
Ferme #245. Spec : `sim/docs/superpowers/specs/2026-09-06-map-coverage-design.md`.

Une tache douce s'étend sur la carte de FIELD là où le drone est réellement passé, se densifie quand on repasse, et survit aux sessions — en terrain cuit comme en vol live. Ce n'est **pas** « la zone est acquise, donc explorée ».

## Trois contraintes du dépôt, vérifiées avant d'écrire

- **Le banc n'écrit rien, par construction.** BENCH n'ouvre aucune session ; la couverture vit dans `session.js`. Aucun `if (MODE.bench)` à maintenir.
- **Une seule écriture, à la clôture.** `operator.patch()` réémet toute la valeur à chaque flush — patcher en vol enverrait ~160 ko plusieurs fois par seconde.
- **`OP_WRITABLE_KEYS` est une liste blanche** : `coverage` y entre avec le contrat de `dialogueMemory`, bornée côté client (`MAX_CELLS = 8000`, `W_MAX = 8`) et relue défensivement.

## Le design

Tuiles slippy à zoom fixe 20 (25,15 m à Paris) parce que Leaflet est déjà en Web Mercator. Empreinte de 30 m — 4 à 5 cellules, pas un 3×3 — à 5 Hz de vol armé. Un module pur (`coverage.js`) porte grille, magasin et plan de dessin ; `map-coverage.js` ne fait que tracer ce plan sur un canvas dans un pane à z=350, sous les cadres de zone.

**Le plafond de 8 000 cellules est un pari**, écrit comme tel : à revoir sur du vrai usage.

## Vérification

`coverage-selftest` (17, nouveau), `session-selftest` (+4), `session-api-selftest` (+2), `scanner`, `terminal-render`, `bench-render`, `dialogue-render`, `selftest` sur `paristest`, `npm run build`.

**À l'œil**, une couverture **injectée** dans le cache client (capture dans HANDOFF). **Non vérifié** : un vol réel, un vol live, dix sessions, le plafond — écrit dans HANDOFF.

> `public/scenes.json` (carte `havre`) reste hors de cette PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DDH8brdg8VcVMF2icSctz8
EOF
)"
```

---

## Auto-revue du plan

**Couverture de la spec.** Grille z=20 → Task 1 ; empreinte 30 m et 5 Hz → Tasks 1 et 4 ; saturation W_MAX, fusion, plafond, sérialisation, lecture défensive → Task 2 ; les deux modes par un seul chemin → Task 5 ; écriture unique dans `session.end()` et exemption du banc par construction → Task 4 ; `OP_WRITABLE_KEYS` → Task 6 ; rendu canvas 'lighter', pane sous les cadres, flou, jamais interactif → Tasks 3 et 7 ; perte au `beacon` documentée → Task 4 ; vérification à l'œil et HANDOFF → Tasks 7 et 8. Hors périmètre respecté : rien sur #212, rien sur l'effacement.

**Types et noms.** `Coverage.fromStored / toStored / mark / merge / cap / cells / size / weightAt` sont les mêmes de la Task 2 à la Task 7. `planDraw(coverage, project, size)` rend `{cx, cy, r, alpha}` en Task 3 et est consommé tel quel en Task 7. `feed({ geo })` reçoit une fonction en Task 4 et main.js passe `() => droneGeo(p)` en Task 5. `refreshCoverage()` est défini en Task 7 et appelé au même endroit.

**Un point d'attention pour l'exécutant de la Task 3.** Le troisième test (`hors du cadre`) est délibérément tolérant (`plan.length <= 1`) parce qu'une projection jouée constante donne un rayon nul ; il vérifie l'absence de plantage et de dessin franchement hors cadre, pas une frontière au pixel. Ne pas le « durcir » sans une projection linéaire réelle comme dans le premier test.
