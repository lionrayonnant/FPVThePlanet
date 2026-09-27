# Signals — Lot 1: Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OSM landmarks appear as signals on the GLOBAL SCANNER map, fetched from Overpass per tile, cached, rate-limited, and harmless when Overpass is down.

**Architecture:** A pure Node-safe model (`tools/signal-model.mjs`) turns Overpass JSON into `Signal` records and owns the tile grid, the query text, tiers, fields and the density cap. A browser client (`src/signal-source.js`) queues tile requests one at a time with an injected `fetch`, cache and timer, so it is testable in Node. A Leaflet canvas layer (`src/map-signals.js`) draws them, following `src/map-tracks.js` line for line. `src/scanner.js` wires the three together.

**Tech Stack:** plain ES modules, Node `assert/strict` selftests, Leaflet (passed as `L`), IndexedDB, Overpass API.

**Spec:** `sim/docs/superpowers/specs/2026-09-27-signals-design.md` (§1 Detection, §2 tier table, §6 Architecture). Issue #185.

## Global Constraints

- Work in the worktree `/home/user/Documents/dev/FPVThePlanet-signals`, branch `signals-design`. All paths below are relative to `sim/` unless they start with `sim/` or `../`.
- Everything in code, comments, selftest labels and file names is **English**. A file touched for other reasons leaves in English (translate its remaining French comments). `CHANGELOG.md` entries are **French**.
- Selftest style: `node:assert/strict`, a local `t(name, fn)` that prints `  ok  <name>`, no framework. Pattern: `tools/coverage-selftest.mjs`.
- Run **only the selftests of the module you touched**. Do NOT run `npm run selftest:ci` — the parent runs it once at the end.
- `L` (Leaflet) is a parameter, never an import, so modules stay importable under Node (see `src/map-tracks.js` header).
- Colours: `--warm-white` ink only on the map. No demo palette (`--cyan`, `--magenta`, `--violet`, `--electric`) — `tools/palette-selftest.mjs` fails otherwise.
- OSM text reaches the DOM only through `textContent` / canvas `fillText`, never `innerHTML` (the repo had an XSS through `?scene=`, PR #81).
- Do not confuse with `signalDensity()` in `tools/scanner-model.mjs`: that is the drone RF density of an area, unrelated.
- Overpass limits (spec §1): one request in flight, one request per tile ever (until TTL), 30-day cache, honour `Retry-After` on 429, `[timeout:25]` and an output cap in the query, no query below the minimum zoom, failure → `UNAVAILABLE`, never blocks a flight.
- Overpass answers **406** to clients without a real User-Agent (Node's default `fetch`). The browser sends one, so the game is fine; any Node probe must set `user-agent: FPVThePlanet-dev/<version> (+https://github.com/lionrayonnant/FPVThePlanet)`.
- The signal id is the **Wikidata id** (`wd:Q…`), not the OSM element: one landmark is often several OSM elements (spec §6 records it).
- Commit identity: `git config core.hooksPath .githooks` is already set in this worktree. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| Create `tools/signal-model.mjs` | Pure: tile grid, Overpass query text, OSM element → `Signal`, tier, fields, height parsing, density cap. |
| Create `tools/signal-model-selftest.mjs` | Its selftest. |
| Create `src/signal-source.js` | Tile queue against Overpass: single flight, 429 backoff, cache (IndexedDB in the browser, memory in tests), status. |
| Create `tools/signal-source-selftest.mjs` | Its selftest, fake `fetch` / cache / timer. |
| Create `src/map-signals.js` | Leaflet canvas layer drawing signals (diamond, tier ticks, name at high zoom). |
| Modify `src/scanner.js` (~l.28 imports, ~l.806 after the history block, l.877 `cleanup`, l.1244 `destroy`) | Wire source + layer + status line. |
| Modify `server/headers.mjs:68-93` | CSP `connect-src` + `https://overpass-api.de`. |
| Modify `tools/server-selftest.mjs:363-365` | Assert it. |
| Modify `package.json` (`selftest:operator`) | Chain the two new selftests. |
| Modify `../CHANGELOG.md` | Entry under `## [Non publié]`. |

---

### Task 1: `signal-model` — tile grid and Overpass query

**Files:**
- Create: `tools/signal-model.mjs`
- Test: `tools/signal-model-selftest.mjs`

**Interfaces:**
- Produces:
  - `TILE_Z = 12`, `MIN_QUERY_ZOOM = 11`, `MAX_TILES_PER_VIEW = 12`
  - `tileOf(lat, lon) -> { x, y }` (slippy tile at `TILE_Z`)
  - `tileKey({ x, y }) -> 'z12/x/y'`
  - `tileBounds({ x, y }) -> { s, w, n, e }` (degrees)
  - `tilesForView({ s, w, n, e }, zoom) -> string[] | null` — `null` when `zoom < MIN_QUERY_ZOOM` or more than `MAX_TILES_PER_VIEW` tiles
  - `overpassQuery({ s, w, n, e }) -> string`

- [ ] **Step 1: Write the failing test**

```js
// tools/signal-model-selftest.mjs
// Selftest of the signal model (issue #185, spec 2026-09-27-signals-design.md).
// No DOM, no network. Run: node tools/signal-model-selftest.mjs
import assert from 'node:assert/strict';
import {
	TILE_Z, MIN_QUERY_ZOOM, MAX_TILES_PER_VIEW,
	tileOf, tileKey, tileBounds, tilesForView, overpassQuery,
} from './signal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const EIFFEL = { lat: 48.8584, lon: 2.2945 };

t('constants from the plan, verbatim', () => {
	assert.equal(TILE_Z, 12);
	assert.equal(MIN_QUERY_ZOOM, 11);
	assert.equal(MAX_TILES_PER_VIEW, 12);
});

t('tileOf: the z12 tile of the Eiffel Tower, computed independently', () => {
	// x = floor((lon+180)/360 * 4096) = floor(2074.107) = 2074
	// y = floor((1 - ln(tan φ + sec φ)/π)/2 * 4096) = 1409
	assert.deepEqual(tileOf(EIFFEL.lat, EIFFEL.lon), { x: 2074, y: 1409 });
});

t('tileKey is stable and carries the zoom', () => {
	assert.equal(tileKey({ x: 2074, y: 1409 }), 'z12/2074/1409');
});

t('tileBounds contains the point it came from, and n > s, e > w', () => {
	const b = tileBounds(tileOf(EIFFEL.lat, EIFFEL.lon));
	assert.ok(b.n > b.s && b.e > b.w);
	assert.ok(EIFFEL.lat >= b.s && EIFFEL.lat <= b.n, JSON.stringify(b));
	assert.ok(EIFFEL.lon >= b.w && EIFFEL.lon <= b.e, JSON.stringify(b));
	// 360 / 4096 degrees wide
	assert.ok(Math.abs((b.e - b.w) - 360 / 4096) < 1e-9);
});

t('tilesForView: null below MIN_QUERY_ZOOM', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	assert.equal(tilesForView(v, MIN_QUERY_ZOOM - 1), null);
});

t('tilesForView: a small view over Paris is one or a few tiles, deduped and sorted', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	const keys = tilesForView(v, 14);
	assert.ok(Array.isArray(keys) && keys.length >= 1 && keys.length <= 4, String(keys));
	assert.deepEqual(keys, [...new Set(keys)].sort());
	assert.ok(keys.includes('z12/2074/1409'));
});

t('tilesForView: a view too wide returns null rather than flooding Overpass', () => {
	const v = { s: 48.0, w: 1.0, n: 50.0, e: 4.0 };
	assert.equal(tilesForView(v, 12), null);
});

t('tilesForView: a view across the antimeridian is handled, not inverted', () => {
	const keys = tilesForView({ s: -17.1, w: 179.95, n: -17.0, e: -179.95 }, 13);
	assert.ok(Array.isArray(keys) && keys.length >= 2 && keys.length <= 4, String(keys));
	assert.ok(keys.some((k) => k.startsWith('z12/4095/')));
	assert.ok(keys.some((k) => k.startsWith('z12/0/')));
});

t('overpassQuery: timeout, output cap, wikidata filter, the bbox in s,w,n,e order', () => {
	const q = overpassQuery({ s: 1, w: 2, n: 3, e: 4 });
	assert.match(q, /^\[out:json\]\[timeout:25\]\[maxsize:\d+\];/);
	assert.match(q, /\(1,2,3,4\)/);
	assert.match(q, /out tags center \d+;$/);
	// every clause requires a wikidata tag: the notability filter
	const clauses = q.match(/nwr\[[^;]*;|way\[[^;]*;/g);
	assert.ok(clauses.length >= 5);
	for (const c of clauses) assert.match(c, /\["wikidata"\]/, c);
});

console.log(`signal-model: ${n} ok`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/signal-model-selftest.mjs`
Expected: FAIL — `Cannot find module '.../tools/signal-model.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// tools/signal-model.mjs
// Signals (issue #185, spec 2026-09-27-signals-design.md): OSM landmarks the
// operator captures in flight. This module is pure and Node-safe — no DOM, no
// fetch — so everything that can be decided without a browser is checked in
// tools/signal-model-selftest.mjs.
//
// Not to be confused with signalDensity() in scanner-model.mjs: that is the
// drone RF density of an area.

// ---------------------------------------------------------------- tile grid
// One Overpass query per z12 tile, ever (until the cache expires). z12 is
// ~6.4 km at Paris: a city is a handful of tiles, and a query stays small.
export const TILE_Z = 12;
// Below this map zoom the view spans too many tiles to be worth querying.
export const MIN_QUERY_ZOOM = 11;
// Hard cap per view: past it, nothing is queried and the scanner says ZOOM IN.
export const MAX_TILES_PER_VIEW = 12;

const N = 2 ** TILE_Z;
const D = Math.PI / 180;

export function tileOf(lat, lon) {
	const x = Math.floor(((lon + 180) / 360) * N);
	const φ = Math.max(-85.0511, Math.min(85.0511, lat)) * D;
	const y = Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * N);
	return { x: ((x % N) + N) % N, y: Math.max(0, Math.min(N - 1, y)) };
}

export const tileKey = ({ x, y }) => `z${TILE_Z}/${x}/${y}`;

const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) / D;

export function tileBounds({ x, y }) {
	return {
		s: latOfY(y + 1), n: latOfY(y),
		w: (x / N) * 360 - 180, e: ((x + 1) / N) * 360 - 180,
	};
}

export function tilesForView({ s, w, n, e }, zoom) {
	if (!(zoom >= MIN_QUERY_ZOOM)) return null;
	const a = tileOf(n, w), b = tileOf(s, e);
	// Across the antimeridian the east edge wraps below the west one.
	const xs = [];
	if (b.x >= a.x) for (let x = a.x; x <= b.x; x++) xs.push(x);
	else { for (let x = a.x; x < N; x++) xs.push(x); for (let x = 0; x <= b.x; x++) xs.push(x); }
	const count = xs.length * (b.y - a.y + 1);
	if (count > MAX_TILES_PER_VIEW) return null;
	const keys = [];
	for (const x of xs) for (let y = a.y; y <= b.y; y++) keys.push(tileKey({ x, y }));
	return [...new Set(keys)].sort();
}

// ---------------------------------------------------------------- query
// `wikidata` on every clause is the notability filter (spec §1): it keeps the
// cathedral and drops the bench. `out tags center` gives nodes their position
// and ways/relations a centre, with no geometry to download.
const OUT_CAP = 200;
const MAXSIZE = 4 * 1024 * 1024;

export function overpassQuery({ s, w, n, e }) {
	const bb = `(${s},${w},${n},${e})`;
	return `[out:json][timeout:25][maxsize:${MAXSIZE}];(`
		+ `nwr["wikidata"]["historic"]${bb};`
		+ `nwr["wikidata"]["tourism"~"^(attraction|viewpoint)$"]${bb};`
		+ `nwr["wikidata"]["man_made"~"^(tower|lighthouse|dam)$"]${bb};`
		+ `nwr["wikidata"]["building"~"^(cathedral|church|castle)$"]${bb};`
		+ `nwr["wikidata"]["natural"="peak"]${bb};`
		+ `way["wikidata"]["bridge"]["name"]${bb};`
		+ `);out tags center ${OUT_CAP};`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/signal-model-selftest.mjs`
Expected: every line `  ok  …`, last line `signal-model: 9 ok`. If the antimeridian or Eiffel tile test fails, fix the code, not the expected values (they were computed independently).

- [ ] **Step 5: Commit**

```bash
git add tools/signal-model.mjs tools/signal-model-selftest.mjs
git commit -m "Signals: the tile grid and the Overpass query (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `signal-model` — OSM element → `Signal`, tiers, fields, density cap

**Files:**
- Modify: `tools/signal-model.mjs` (append)
- Test: `tools/signal-model-selftest.mjs` (append before the final `console.log`)

**Interfaces:**
- Consumes: `tileOf`, `tileKey` (Task 1).
- Produces:
  - `type Field = { key: string, label: string, value: string, source: 'osm' }`
  - `type Signal = { id: string /* 'wd:Q206823' — the Wikidata id, stable across OSM edits */, osm: string /* 'way/92294792' */, lat: number, lon: number, tile: string, tier: 1|2|3, rank: number, name: string, kind: string, fields: Field[], wikipedia: boolean, heightM: number|null, commons: string|null /* 'File:….jpg' */ }`
  - `rankOf(el, tags, tier, heightM) -> number` (notability, measured on the real Reims tile)
  - `parseHeightM(raw) -> number|null`
  - `signalFromElement(el) -> Signal|null`
  - `PER_TILE_CAP = 12`
  - `capPerTile(signals: Signal[], cap = PER_TILE_CAP) -> Signal[]`
  - `parseOverpass(json) -> Signal[]` (one per Wikidata id — the best-ranked element wins — capped per tile)

- [ ] **Step 1: Write the failing test**

Change the import at the top of `tools/signal-model-selftest.mjs` to:

```js
import {
	TILE_Z, MIN_QUERY_ZOOM, MAX_TILES_PER_VIEW,
	tileOf, tileKey, tileBounds, tilesForView, overpassQuery,
	parseHeightM, signalFromElement, PER_TILE_CAP, capPerTile, parseOverpass,
} from './signal-model.mjs';
```

Append before the final `console.log`:

```js
const REIMS = {
	type: 'way', id: 43263447,
	center: { lat: 49.2536, lon: 4.0340 },
	tags: {
		building: 'cathedral', name: 'Cathédrale Notre-Dame de Reims',
		wikidata: 'Q191783', wikipedia: 'fr:Cathédrale Notre-Dame de Reims',
		start_date: '1211', height: '81', heritage: '1', 'heritage:operator': 'whc',
		wikimedia_commons: 'File:Reims Cathedral.jpg',
	},
};

t('parseHeightM: metres, "m" suffix, feet, garbage', () => {
	assert.equal(parseHeightM('81'), 81);
	assert.equal(parseHeightM('81 m'), 81);
	assert.equal(parseHeightM('81.5'), 81.5);
	assert.equal(Math.round(parseHeightM("265'")), 81);
	assert.equal(Math.round(parseHeightM('265 ft')), 81);
	assert.equal(parseHeightM('tall'), null);
	assert.equal(parseHeightM(undefined), null);
	assert.equal(parseHeightM('-3'), null);
});

t('signalFromElement: Reims cathedral, every field in order', () => {
	const s = signalFromElement(REIMS);
	assert.equal(s.id, 'wd:Q191783');
	assert.equal(s.osm, 'way/43263447');
	assert.equal(s.lat, 49.2536);
	assert.equal(s.lon, 4.0340);
	assert.equal(s.tile, tileKey(tileOf(49.2536, 4.0340)));
	assert.equal(s.name, 'CATHÉDRALE NOTRE-DAME DE REIMS');
	assert.equal(s.kind, 'CATHEDRAL');
	assert.equal(s.tier, 2, 'height 81 > 50 makes it tier II');
	assert.equal(s.heightM, 81);
	assert.equal(s.wikipedia, true);
	assert.equal(s.commons, 'File:Reims Cathedral.jpg');
	assert.deepEqual(s.fields.map((f) => [f.key, f.label, f.value]), [
		['name', 'NAME', 'CATHÉDRALE NOTRE-DAME DE REIMS'],
		['type', 'TYPE', 'CATHEDRAL'],
		['built', 'BUILT', '1211'],
		['height', 'HEIGHT', '81 M'],
		['status', 'STATUS', 'UNESCO WORLD HERITAGE'],
	]);
	for (const f of s.fields) assert.equal(f.source, 'osm');
});

t('signalFromElement: a node uses lat/lon, name:en wins over name', () => {
	const s = signalFromElement({
		type: 'node', id: 7, lat: 45.83, lon: 6.86,
		tags: { natural: 'peak', name: 'Mont Blanc', 'name:en': 'Mont Blanc', wikidata: 'Q583', ele: '4806' },
	});
	assert.equal(s.id, 'wd:Q583');
	assert.equal(s.osm, 'node/7');
	assert.equal(s.lat, 45.83);
	assert.equal(s.kind, 'PEAK');
	assert.equal(s.tier, 3);
});

t('tiers: I by default, II for towers / lighthouses / height > 50, III for peak, dam, bridge', () => {
	const tier = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', ...tags } }).tier;
	assert.equal(tier({ historic: 'castle' }), 1);
	assert.equal(tier({ historic: 'castle', height: '50' }), 1, '50 is not > 50');
	assert.equal(tier({ historic: 'castle', height: '51' }), 2);
	assert.equal(tier({ man_made: 'tower' }), 2);
	assert.equal(tier({ man_made: 'lighthouse' }), 2);
	assert.equal(tier({ natural: 'peak' }), 3);
	assert.equal(tier({ man_made: 'dam' }), 3);
	assert.equal(tier({ bridge: 'yes' }), 3);
});

t('status: UNESCO only for heritage:operator=whc, PROTECTED for other heritage, absent otherwise', () => {
	const st = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'monument', ...tags } })
		.fields.find((f) => f.key === 'status')?.value ?? null;
	assert.equal(st({ heritage: '1', 'heritage:operator': 'whc' }), 'UNESCO WORLD HERITAGE');
	assert.equal(st({ heritage: '2' }), 'PROTECTED');
	assert.equal(st({}), null);
});

t('architect field appears when tagged, after height', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', man_made: 'tower', height: '300', architect: 'Gustave Eiffel' } });
	assert.deepEqual(s.fields.map((f) => f.key), ['name', 'type', 'height', 'architect']);
	assert.equal(s.fields[3].value, 'GUSTAVE EIFFEL');
});

t('signalFromElement rejects what cannot be a signal', () => {
	assert.equal(signalFromElement(null), null);
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { wikidata: 'Q1', historic: 'x' } }), null, 'no name');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', historic: 'x' } }), null, 'no wikidata');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1;Q2', historic: 'x' } }), null, 'not a single Q-id');
	assert.equal(signalFromElement({ type: 'way', id: 1, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'no position');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 'a', lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'NaN lat');
	assert.equal(signalFromElement({ type: 'bogus', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'unknown type');
});

t('text is sanitised: control chars stripped, length capped, markup kept inert as text', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: {
		name: '<img src=x onerror=alert(1)>\u0000\u001b' + 'A'.repeat(200), wikidata: 'Q1', historic: 'x',
	} });
	assert.ok(!/[\u0000-\u001f]/.test(s.name));
	assert.ok(s.name.length <= 60, String(s.name.length));
	// Not escaped here — it is rendered with textContent / fillText, never innerHTML.
	assert.ok(s.name.startsWith('<IMG'));
});

t('commons: only a Commons file name is kept; image= is accepted only when it points at Commons', () => {
	const c = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x', ...tags } }).commons;
	assert.equal(c({ wikimedia_commons: 'File:A b.jpg' }), 'File:A b.jpg');
	assert.equal(c({ wikimedia_commons: 'Category:Stuff' }), null);
	assert.equal(c({ image: 'https://commons.wikimedia.org/wiki/File:C_d.jpg' }), 'File:C d.jpg');
	assert.equal(c({ image: 'https://example.com/x.jpg' }), null);
	assert.equal(c({}), null);
});

t('capPerTile: keeps the best-ranked per tile, id breaks ties', () => {
	const mk = (id, tile, rank) => ({ id, tile, rank });
	const list = [mk('a', 'T1', 1000), mk('b', 'T1', 1500), mk('c', 'T1', 3000), mk('d', 'T1', 1500), mk('e', 'T2', 1000)];
	const kept = capPerTile(list, 2);
	assert.deepEqual(kept.filter((s) => s.tile === 'T1').map((s) => s.id), ['c', 'b']);
	assert.deepEqual(kept.filter((s) => s.tile === 'T2').map((s) => s.id), ['e']);
	assert.equal(PER_TILE_CAP, 12);
});

t('parseOverpass: one signal per Wikidata id, drops junk, survives a malformed body', () => {
	const json = { elements: [REIMS, REIMS, { type: 'node', id: 2 }, null, 'x'] };
	const out = parseOverpass(json);
	assert.equal(out.length, 1);
	assert.equal(out[0].id, 'wd:Q191783');
	assert.deepEqual(parseOverpass(null), []);
	assert.deepEqual(parseOverpass({ elements: 'nope' }), []);
});

// Trimmed from the real Overpass answer for the Reims z12 tile (2026-09-27,
// 86 elements). The cathedral is there twice — a node tagged
// archaeological_site and the building way — and a statue and a boundary
// stone sit next to the palace and the basilica. The ranking must put the
// three monuments first and keep the cathedral's BUILDING.
const REIMS_TILE = [
	{ type: 'node', id: 1071213823, lat: 49.2570619, lon: 4.0341304, tags: { name: "Jeanne d'Arc", wikidata: 'Q2963048', wikipedia: 'fr:Chevauchée vers Reims', historic: 'memorial' } },
	{ type: 'node', id: 4253229600, lat: 49.2512625, lon: 3.9849493, tags: { name: 'Borne Vauthier', wikidata: 'Q2495007', wikipedia: 'fr:Bornes Vauthier', historic: 'memorial' } },
	{ type: 'node', id: 7388163831, lat: 49.2535616, lon: 4.033298, tags: { name: 'Cathédrale de Reims', wikidata: 'Q206823', wikipedia: 'fr:Cathédrale Notre-Dame de Reims', historic: 'archaeological_site' } },
	{ type: 'way', id: 92294792, center: { lat: 49.2537686, lon: 4.033823 }, tags: { name: 'Cathédrale Notre-Dame', wikidata: 'Q206823', wikipedia: 'fr:Cathédrale Notre-Dame de Reims', building: 'cathedral', tourism: 'attraction', heritage: '2' } },
	{ type: 'way', id: 92296301, center: { lat: 49.2532652, lon: 4.0343524 }, tags: { name: 'Palais du Tau', wikidata: 'Q578771', wikipedia: 'fr:Palais du Tau (Reims)', building: 'yes', historic: 'palace', tourism: 'museum' } },
	{ type: 'way', id: 92309276, center: { lat: 49.243071, lon: 4.0418455 }, tags: { name: 'Basilique Saint-Remi', wikidata: 'Q334233', wikipedia: 'fr:Basilique Saint-Remi de Reims', building: 'church', tourism: 'attraction', heritage: '2' } },
];

t('real Reims tile: the monuments outrank the statue and the stone, the cathedral keeps its building', () => {
	const out = parseOverpass({ elements: REIMS_TILE });
	assert.equal(out.length, 5, 'the cathedral node and way are one signal');
	assert.deepEqual(out.slice(0, 3).map((s) => s.id), ['wd:Q206823', 'wd:Q334233', 'wd:Q578771']);
	const cathedral = out[0];
	assert.equal(cathedral.osm, 'way/92294792');
	assert.equal(cathedral.kind, 'CATHEDRAL');
	assert.equal(cathedral.name, 'CATHÉDRALE NOTRE-DAME');
	for (const s of out.slice(3)) assert.equal(s.kind, 'MEMORIAL');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/signal-model-selftest.mjs`
Expected: FAIL — `SyntaxError: The requested module './signal-model.mjs' does not provide an export named 'parseHeightM'`

- [ ] **Step 3: Write minimal implementation**

Append to `tools/signal-model.mjs`:

```js
// ---------------------------------------------------------------- signals
const TEXT_MAX = 60;

// OSM text goes to the HUD and the map. Stripped of control characters and
// capped here; it is ALWAYS rendered as text (textContent / fillText), which
// is what makes markup in a tag inert.
function clean(v) {
	if (typeof v !== 'string') return null;
	const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
	return s ? s.slice(0, TEXT_MAX).toUpperCase() : null;
}

export function parseHeightM(raw) {
	if (typeof raw !== 'string') return null;
	const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft|')?$/i);
	if (!m) return null;
	const v = Number(m[1]) * (m[2] && m[2].toLowerCase() !== 'm' ? 0.3048 : 1);
	return v > 0 ? v : null;
}

// The TYPE line, in precedence order: the most specific tag wins.
function kindOf(tags) {
	if (tags.natural === 'peak') return 'PEAK';
	if (tags.man_made === 'dam') return 'DAM';
	if (tags.bridge) return 'BRIDGE';
	if (tags.man_made === 'lighthouse') return 'LIGHTHOUSE';
	if (tags.man_made === 'tower') return 'TOWER';
	if (tags.building && tags.building !== 'yes') return clean(tags.building.replace(/_/g, ' '));
	if (tags.historic && tags.historic !== 'yes') return clean(tags.historic.replace(/_/g, ' '));
	if (tags.tourism) return clean(tags.tourism.replace(/_/g, ' '));
	return 'LANDMARK';
}

// Spec §2: I get close, II climb and hold at altitude, III go far.
function tierOf(tags, heightM) {
	if (tags.natural === 'peak' || tags.man_made === 'dam' || tags.bridge) return 3;
	if (tags.man_made === 'tower' || tags.man_made === 'lighthouse' || (heightM !== null && heightM > 50)) return 2;
	return 1;
}

function statusOf(tags) {
	if (!tags.heritage) return null;
	return tags['heritage:operator'] === 'whc' ? 'UNESCO WORLD HERITAGE' : 'PROTECTED';
}

function commonsOf(tags) {
	const wc = typeof tags.wikimedia_commons === 'string' ? tags.wikimedia_commons.trim() : '';
	if (/^File:.+/.test(wc)) return wc;
	const img = typeof tags.image === 'string' ? tags.image.trim() : '';
	const m = img.match(/^https:\/\/commons\.wikimedia\.org\/wiki\/(File:.+)$/);
	if (m) return decodeURIComponent(m[1]).replace(/_/g, ' ');
	return null;
}

// Fields are an ordered list, not an object: the callout shows them in this
// order, and a later source (Wikidata) adds rows with its own `source` without
// changing anything here (spec §6).
const field = (key, label, value) => (value ? { key, label, value, source: 'osm' } : null);

const TYPES = new Set(['node', 'way', 'relation']);

export function signalFromElement(el) {
	if (!el || typeof el !== 'object' || !TYPES.has(el.type) || !Number.isFinite(el.id)) return null;
	const tags = el.tags && typeof el.tags === 'object' ? el.tags : null;
	if (!tags || typeof tags.wikidata !== 'string' || !tags.wikidata) return null;
	const name = clean(tags['name:en']) ?? clean(tags.name);
	if (!name) return null;
	const lat = Number(el.lat ?? el.center?.lat), lon = Number(el.lon ?? el.center?.lon);
	if (el.lat === undefined && el.center === undefined) return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	const heightM = parseHeightM(tags.height);
	const kind = kindOf(tags);
	const builtRaw = typeof tags.start_date === 'string' ? tags.start_date : null;
	const fields = [
		field('name', 'NAME', name),
		field('type', 'TYPE', kind),
		field('built', 'BUILT', clean(builtRaw)),
		field('height', 'HEIGHT', heightM !== null ? `${Math.round(heightM)} M` : null),
		field('architect', 'ARCHITECT', clean(tags.architect)),
		field('status', 'STATUS', statusOf(tags)),
	].filter(Boolean);
	const wikidata = tags.wikidata.trim();
	if (!/^Q\d+$/.test(wikidata)) return null;
	const tier = tierOf(tags, heightM);
	return {
		id: `wd:${wikidata}`,
		osm: `${el.type}/${el.id}`,
		lat, lon,
		tile: tileKey(tileOf(lat, lon)),
		tier,
		rank: rankOf(el, tags, tier, heightM),
		name, kind, fields,
		wikipedia: typeof tags.wikipedia === 'string' && tags.wikipedia.length > 0,
		heightM,
		commons: commonsOf(tags),
	};
}

// ---------------------------------------------------------------- density
// Paris must not become hundreds of dots (spec §1). Measured on the real Reims
// tile (86 elements, 2026-09-27): nearly everything is tier I, so the tier
// alone ranks nothing. What separates the cathedral from a plaque is the kind
// of place, its heritage level, a Wikipedia article, tourism=attraction, and
// whether OSM draws it as a building (way/relation) or a point (node).
export const PER_TILE_CAP = 12;

const MAJOR = new Set(['cathedral', 'castle', 'palace', 'fort', 'tower', 'lighthouse', 'monastery', 'basilica', 'dam']);
const MINOR = new Set(['church', 'chapel', 'city_gate', 'museum', 'ruins', 'abbey', 'bridge', 'peak']);

export function rankOf(el, tags, tier, heightM) {
	const kinds = [tags.building, tags.historic, tags.man_made, tags.natural, tags.tourism, tags.bridge ? 'bridge' : null];
	const kind = kinds.some((k) => MAJOR.has(k)) ? 300 : kinds.some((k) => MINOR.has(k)) ? 150 : 0;
	const h = tags['heritage:operator'] === 'whc' || tags.heritage === '1' ? 200
		: tags.heritage === '2' ? 100 : tags.heritage ? 50 : 0;
	return tier * 1000 + kind + h
		+ (typeof tags.wikipedia === 'string' && tags.wikipedia ? 100 : 0)
		+ (tags.tourism === 'attraction' ? 80 : 0)
		+ (el.type === 'node' ? 0 : 100)
		+ Math.min(heightM ?? 0, 300) / 3;
}

const byRank = (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function capPerTile(signals, cap = PER_TILE_CAP) {
	const byTile = new Map();
	for (const s of signals) {
		if (!byTile.has(s.tile)) byTile.set(s.tile, []);
		byTile.get(s.tile).push(s);
	}
	const out = [];
	for (const list of byTile.values()) out.push(...list.sort(byRank).slice(0, cap));
	return out;
}

// One landmark is often several OSM elements (Reims cathedral: a node AND the
// building way). They share a Wikidata id, which is the signal's identity; the
// best-ranked element carries it.
export function parseOverpass(json) {
	const els = Array.isArray(json?.elements) ? json.elements : [];
	const best = new Map();
	for (const el of els) {
		const s = signalFromElement(el);
		if (!s) continue;
		const cur = best.get(s.id);
		if (!cur || byRank(s, cur) < 0) best.set(s.id, s);
	}
	return capPerTile([...best.values()]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/signal-model-selftest.mjs`
Expected: `signal-model: 21 ok`

- [ ] **Step 5: Commit**

```bash
git add tools/signal-model.mjs tools/signal-model-selftest.mjs
git commit -m "Signals: OSM elements become signals, with a tier, fields and a density cap (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `signal-source` — the Overpass client

**Files:**
- Create: `src/signal-source.js`
- Test: `tools/signal-source-selftest.mjs`

**Interfaces:**
- Consumes: `tileBounds`, `overpassQuery`, `parseOverpass`, `tilesForView` from `tools/signal-model.mjs`.
- Produces:
  - `ENDPOINT = 'https://overpass-api.de/api/interpreter'`, `CACHE_TTL_MS = 30 * 24 * 3600 * 1000`, `DEFAULT_RETRY_S = 60`
  - `memoryCache() -> { get(key): Promise<{ at, signals }|null>, set(key, value): Promise<void> }`
  - `idbCache(name = 'fpvtp-signals') -> same interface` (browser; falls back to `memoryCache()` if IndexedDB throws)
  - `createSignalSource({ fetch, cache, now = Date.now, schedule = setTimeout, onChange = () => {} })` returning:
    - `request(tileKeys: string[]) -> void` — enqueue tiles not loaded, not queued, not in flight
    - `signals() -> Signal[]` — every loaded signal, deduped by id
    - `status() -> 'idle' | 'loading' | 'unavailable' | 'waiting'` (`waiting` = backing off after 429)
    - `idle() -> Promise<void>` — resolves when the queue is empty and nothing is in flight (tests)
    - `onChange` — a writable property; the scanner reassigns it per mount

- [ ] **Step 1: Write the failing test**

```js
// tools/signal-source-selftest.mjs
// Selftest of the Overpass client (issue #185). Fake fetch, memory cache, a
// manual timer: no network, no browser. Run: node tools/signal-source-selftest.mjs
import assert from 'node:assert/strict';
import { createSignalSource, memoryCache, CACHE_TTL_MS, DEFAULT_RETRY_S, ENDPOINT } from '../src/signal-source.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const REIMS = {
	type: 'way', id: 43263447, center: { lat: 49.2536, lon: 4.0340 },
	tags: { building: 'cathedral', name: 'Cathédrale Notre-Dame de Reims', wikidata: 'Q191783' },
};
const okBody = (els) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ elements: els }) });

// A fetch that records calls and tracks concurrency.
function fakeFetch(respond) {
	const calls = [];
	let inFlight = 0, maxInFlight = 0;
	const fn = async (url, init) => {
		calls.push({ url, init });
		inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
		try { await new Promise((r) => setImmediate(r)); return await respond(calls.length, url, init); }
		finally { inFlight--; }
	};
	return { fn, calls, max: () => maxInFlight };
}

// A timer the test advances by hand.
function manualTimer() {
	const pending = [];
	const schedule = (fn, ms) => { pending.push({ fn, ms }); return pending.length; };
	const fire = () => { const p = pending.splice(0); for (const x of p) x.fn(); return p; };
	return { schedule, fire, pending };
}

await t('constants', () => {
	assert.equal(ENDPOINT, 'https://overpass-api.de/api/interpreter');
	assert.equal(CACHE_TTL_MS, 30 * 24 * 3600 * 1000);
	assert.equal(DEFAULT_RETRY_S, 60);
});

await t('one POST per tile, form-encoded, never two in flight', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/2074/1409', 'z12/2075/1409', 'z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 2);
	assert.equal(f.max(), 1);
	assert.equal(f.calls[0].url, ENDPOINT);
	assert.equal(f.calls[0].init.method, 'POST');
	assert.match(String(f.calls[0].init.body), /^data=/);
	assert.equal(src.status(), 'idle');
});

await t('a tile already loaded is never asked again', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/2074/1409']);
	await src.idle();
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 1);
});

await t('signals() dedups the same landmark returned by two tiles', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/1/1', 'z12/1/2']);
	await src.idle();
	assert.equal(src.signals().length, 1);
});

await t('a fresh cache entry answers without fetch; an expired one refetches', async () => {
	const cache = memoryCache();
	let now = 1_000_000;
	await cache.set('z12/2074/1409', { at: now, signals: [{ id: 'osm:way/1', tile: 'z12/2074/1409' }] });
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache, now: () => now + CACHE_TTL_MS - 1 });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 0);
	assert.equal(src.signals()[0].id, 'osm:way/1');

	const src2 = createSignalSource({ fetch: f.fn, cache, now: () => now + CACHE_TTL_MS + 1 });
	src2.request(['z12/2074/1409']);
	await src2.idle();
	assert.equal(f.calls.length, 1);
	assert.equal((await cache.get('z12/2074/1409')).signals[0].id, 'wd:Q191783');
});

await t('429: waits Retry-After seconds, then retries the same tile', async () => {
	const tm = manualTimer();
	const f = fakeFetch((i) => i === 1
		? { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '7' : null) }, json: async () => ({}) }
		: okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), schedule: tm.schedule });
	src.request(['z12/2074/1409']);
	await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.equal(src.status(), 'waiting');
	assert.equal(tm.pending.length, 1);
	assert.equal(tm.pending[0].ms, 7000);
	tm.fire();
	await src.idle();
	assert.equal(f.calls.length, 2);
	assert.equal(src.status(), 'idle');
	assert.equal(src.signals().length, 1);
});

await t('429 without Retry-After uses DEFAULT_RETRY_S', async () => {
	const tm = manualTimer();
	const f = fakeFetch(() => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), schedule: tm.schedule });
	src.request(['z12/1/1']);
	for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
	assert.equal(tm.pending[0].ms, DEFAULT_RETRY_S * 1000);
});

await t('a network error or a 5xx marks UNAVAILABLE, caches nothing, and a later request retries', async () => {
	const cache = memoryCache();
	let fail = true;
	const f = fakeFetch(() => { if (fail) throw new Error('offline'); return okBody([REIMS]); });
	const src = createSignalSource({ fetch: f.fn, cache });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.status(), 'unavailable');
	assert.equal(await cache.get('z12/2074/1409'), null);
	fail = false;
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.status(), 'idle');
	assert.equal(src.signals().length, 1);

	const f5 = fakeFetch(() => ({ ok: false, status: 504, headers: { get: () => null }, json: async () => ({}) }));
	const s5 = createSignalSource({ fetch: f5.fn, cache: memoryCache() });
	s5.request(['z12/1/1']);
	await s5.idle();
	assert.equal(s5.status(), 'unavailable');
});

await t('onChange fires when signals or status change', async () => {
	let changes = 0;
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), onChange: () => changes++ });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.ok(changes >= 2, `changes=${changes}`); // loading, then loaded
});

await t('a cache that throws does not break the source', async () => {
	const bad = { get: async () => { throw new Error('idb blocked'); }, set: async () => { throw new Error('idb blocked'); } };
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: bad });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.signals().length, 1);
});

console.log(`signal-source: ${n} ok`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/signal-source-selftest.mjs`
Expected: FAIL — `Cannot find module '.../src/signal-source.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/signal-source.js
// The Overpass client for signals (issue #185, spec §1). Everything the
// browser would own — fetch, cache, timer — is injected, so the queue logic is
// checked in Node (tools/signal-source-selftest.mjs).
//
// The public Overpass instance allows ~10 000 queries/day/IP and 2 concurrent
// slots. The rules that keep us far from both: one request in flight, one
// request per tile until the cache expires, Retry-After honoured on 429.
// Failure never blocks anything: the scanner shows UNAVAILABLE and the game
// plays without signals.
import { tileBounds, overpassQuery, parseOverpass } from '../tools/signal-model.mjs';

export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
// Landmarks do not move.
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_RETRY_S = 60;

export function memoryCache() {
	const m = new Map();
	return {
		get: async (k) => m.get(k) ?? null,
		set: async (k, v) => { m.set(k, v); },
	};
}

// One object store, keyed by tile. Any IndexedDB failure (private window,
// blocked storage) degrades to a memory cache for this page's life.
export function idbCache(name = 'fpvtp-signals') {
	const STORE = 'tiles';
	let dbP = null;
	const open = () => dbP ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(name, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	const fallback = memoryCache();
	const tx = async (mode, fn) => {
		const db = await open();
		return new Promise((resolve, reject) => {
			const r = fn(db.transaction(STORE, mode).objectStore(STORE));
			r.onsuccess = () => resolve(r.result ?? null);
			r.onerror = () => reject(r.error);
		});
	};
	return {
		get: (k) => tx('readonly', (s) => s.get(k)).catch(() => fallback.get(k)),
		set: (k, v) => tx('readwrite', (s) => s.put(v, k)).then(() => {}).catch(() => fallback.set(k, v)),
	};
}

const tileOfKey = (key) => {
	const [, x, y] = key.split('/').map(Number);
	return { x, y };
};

export function createSignalSource({
	fetch: fetchFn,
	cache = memoryCache(),
	now = Date.now,
	schedule = setTimeout,
	onChange = () => {},
} = {}) {
	const loaded = new Map();     // tileKey -> Signal[]
	const queue = [];             // tileKeys waiting
	let busy = false;             // a request (or a backoff) is running
	let state = 'idle';
	let idleWaiters = [];

	// Reassignable: the source outlives a scanner mount, each mount plugs its
	// own listener in (src/scanner.js).
	const api = { onChange };
	const setState = (s) => { if (s !== state) { state = s; api.onChange(); } };
	const settle = () => {
		if (busy || queue.length) return;
		const w = idleWaiters; idleWaiters = [];
		for (const r of w) r();
	};

	async function fromCache(key) {
		try {
			const hit = await cache.get(key);
			if (hit && Array.isArray(hit.signals) && now() - hit.at < CACHE_TTL_MS) return hit.signals;
		} catch { /* a broken cache is a missing cache */ }
		return null;
	}

	async function pump() {
		if (busy) return;
		const key = queue.shift();
		if (key === undefined) { settle(); return; }
		busy = true;
		try {
			const cached = await fromCache(key);
			if (cached) {
				loaded.set(key, cached);
				api.onChange();
			} else {
				setState('loading');
				const res = await fetchFn(ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: `data=${encodeURIComponent(overpassQuery(tileBounds(tileOfKey(key))))}`,
				});
				if (res.status === 429) {
					const s = Number(res.headers?.get?.('retry-after'));
					const waitMs = (Number.isFinite(s) && s > 0 ? s : DEFAULT_RETRY_S) * 1000;
					queue.unshift(key);
					setState('waiting');
					// `busy` stays true through the wait: nothing else may start.
					schedule(() => { busy = false; pump(); }, waitMs);
					return;
				}
				if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
				const signals = parseOverpass(await res.json());
				loaded.set(key, signals);
				try { await cache.set(key, { at: now(), signals }); } catch { /* see fromCache */ }
				setState('idle');
				api.onChange();
			}
		} catch {
			// Not cached, not marked loaded: a later request() retries it.
			setState('unavailable');
		}
		busy = false;
		pump();
	}

	return Object.assign(api, {
		request(keys) {
			for (const k of keys ?? []) {
				if (typeof k !== 'string' || loaded.has(k) || queue.includes(k)) continue;
				queue.push(k);
			}
			pump();
		},
		signals() {
			const byId = new Map();
			for (const list of loaded.values()) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
			return [...byId.values()];
		},
		status: () => state,
		idle: () => new Promise((r) => { idleWaiters.push(r); settle(); }),
	});
}
```


- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/signal-source-selftest.mjs`
Expected: `signal-source: 10 ok`. If the 429 test flakes on the number of `setImmediate` ticks, replace the three awaits by a loop `for (let i = 0; i < 6 && src.status() !== 'waiting'; i++) await new Promise((r) => setImmediate(r));` — the assertion stays `status() === 'waiting'`.

- [ ] **Step 5: Commit**

```bash
git add src/signal-source.js tools/signal-source-selftest.mjs
git commit -m "Signals: the Overpass client — one tile at a time, cached 30 days, Retry-After honoured (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `map-signals` — the scanner layer, and its pure placement helper

**Files:**
- Create: `src/map-signals.js`
- Test: `tools/signal-model-selftest.mjs` (append — the layer's pure helper lives in the model)
- Modify: `tools/signal-model.mjs` (append `signalsInView`, `LABEL_ZOOM`)

**Interfaces:**
- Consumes: `Signal` (Task 2).
- Produces:
  - `LABEL_ZOOM = 15`
  - `signalsInView(signals, { minLat, maxLat, minLon, maxLon }) -> Signal[]` (handles the antimeridian when `minLon > maxLon`)
  - `createSignalsLayer(L, { getSignals: () => Signal[], ink = '#ece7dd' }) -> L.Layer` with `refresh()`

- [ ] **Step 1: Write the failing test**

Add `signalsInView, LABEL_ZOOM` to the selftest's import list, then append:

```js
t('signalsInView: bbox filter, antimeridian-aware', () => {
	const s = (id, lat, lon) => ({ id, lat, lon });
	const list = [s('a', 48.86, 2.29), s('b', 10, 10), s('c', -17, 179.99), s('d', -17, -179.99)];
	assert.deepEqual(signalsInView(list, { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 }).map((x) => x.id), ['a']);
	assert.deepEqual(signalsInView(list, { minLat: -18, maxLat: -16, minLon: 179.9, maxLon: -179.9 }).map((x) => x.id), ['c', 'd']);
	assert.equal(LABEL_ZOOM, 15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/signal-model-selftest.mjs`
Expected: FAIL — `does not provide an export named 'signalsInView'`

- [ ] **Step 3: Write minimal implementation**

Append to `tools/signal-model.mjs`:

```js
// ---------------------------------------------------------------- map
// Names are drawn only from this zoom on: below it they overlap into noise.
export const LABEL_ZOOM = 15;

export function signalsInView(signals, { minLat, maxLat, minLon, maxLon }) {
	const wraps = minLon > maxLon;
	return signals.filter((s) => s.lat >= minLat && s.lat <= maxLat
		&& (wraps ? (s.lon >= minLon || s.lon <= maxLon) : (s.lon >= minLon && s.lon <= maxLon)));
}
```

Create `src/map-signals.js`, modelled on `src/map-tracks.js`:

```js
// The signals overlay on the scanner (issue #185, spec §1): landmarks the
// operator can go and capture. Same split as map-tracks.js — what can be
// decided without a browser lives in tools/signal-model.mjs; here there is a
// canvas and a layer lifecycle. `L` is a parameter so the module stays
// importable under Node.
import { signalsInView, LABEL_ZOOM } from '../tools/signal-model.mjs';

// Above the tracks (360): a signal is a place to go, it reads over where you
// have been. Below overlayPane (400) and the area frames you designate.
const PANE = 'signals';
const PANE_Z = 370;

// Warm white only (Bible §38). Tier reads as ticks under the diamond, not as
// colour: colour is reserved for state, which lot 3 brings (resolved,
// encrypted).
const R = 5;
const ALPHA = 0.9;

export function createSignalsLayer(L, { getSignals, ink = '#ece7dd' } = {}) {
	const Layer = L.Layer.extend({
		onAdd(map) {
			this._map = map;
			if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
			const canvas = L.DomUtil.create('canvas', 'map-signals leaflet-zoom-hide', map.getPane(PANE));
			canvas.style.pointerEvents = 'none';
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

		refresh() { if (this._map) this._redraw(); },

		_redraw() {
			const map = this._map, canvas = this._canvas, ctx = this._ctx;
			if (!map || !canvas) return;
			const size = map.getSize();
			const dpr = window.devicePixelRatio || 1;
			const bw = Math.round(size.x * dpr), bh = Math.round(size.y * dpr);
			if (canvas.width !== bw || canvas.height !== bh) {
				canvas.width = bw;
				canvas.height = bh;
				canvas.style.width = `${size.x}px`;
				canvas.style.height = `${size.y}px`;
			}
			L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, size.x, size.y);

			const all = getSignals?.() ?? [];
			if (!all.length) return;
			const b = map.getBounds();
			const visible = signalsInView(all, {
				minLat: b.getSouth(), maxLat: b.getNorth(),
				minLon: b.getWest(), maxLon: b.getEast(),
			});
			const labels = map.getZoom() >= LABEL_ZOOM;
			ctx.globalAlpha = ALPHA;
			ctx.strokeStyle = ink;
			ctx.fillStyle = ink;
			ctx.lineWidth = 1.5;
			ctx.font = '10px "IBM Plex Mono", monospace';
			ctx.textBaseline = 'middle';
			for (const s of visible) {
				const p = map.latLngToContainerPoint([s.lat, s.lon]);
				const x = Math.round(p.x) + 0.5, y = Math.round(p.y) + 0.5;
				ctx.beginPath();
				ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y);
				ctx.closePath();
				ctx.stroke();
				for (let i = 0; i < s.tier; i++) ctx.fillRect(x - 4 + i * 3, y + R + 3, 2, 2);
				// fillText, never innerHTML: OSM text is data (PR #81).
				if (labels) ctx.fillText(s.name, x + R + 4, y);
			}
			ctx.globalAlpha = 1;
		},
	});
	return new Layer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/signal-model-selftest.mjs && node -e "import('./src/map-signals.js').then(m => { if (typeof m.createSignalsLayer !== 'function') process.exit(1); console.log('map-signals imports under Node'); })"`
Expected: `signal-model: 22 ok` then `map-signals imports under Node`.

- [ ] **Step 5: Commit**

```bash
git add tools/signal-model.mjs tools/signal-model-selftest.mjs src/map-signals.js
git commit -m "Signals: the scanner layer (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the scanner, open the CSP, chain the selftests

**Files:**
- Modify: `src/scanner.js` — import (~l.28), new block right after the FLIGHT HISTORY block (after the line `if (settings.flightHistoryMap ?? settings.enrichedMap) setHistory(true, { persist: false });`, ~l.859), `cleanup()` (l.877), `destroy` (l.1244)
- Modify: `server/headers.mjs:68-72` (comment) and `:93` (`connect-src`)
- Modify: `tools/server-selftest.mjs:363-365`
- Modify: `package.json` (`selftest:operator`)
- Modify: `src/style.css` (status line style)

**Interfaces:**
- Consumes: `createSignalSource`, `idbCache` (Task 3); `createSignalsLayer` (Task 4); `tilesForView` (Task 1).
- Produces: nothing new for later lots except the module-level `signalSource` in `scanner.js` (lot 2 will read `signalSource.signals()` when a zone is flown).

- [ ] **Step 1: Write the failing test (CSP)**

In `tools/server-selftest.mjs`, replace lines 363-365:

```js
		check('… whose connect-src allows the terrain, the search and the landmark signals',
			/connect-src [^;]*https:\/\/kh\.google\.com/.test(csp)
			&& /connect-src [^;]*https:\/\/nominatim\.openstreetmap\.org/.test(csp)
			&& /connect-src [^;]*https:\/\/overpass-api\.de/.test(csp));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/server-selftest.mjs`
Expected: FAIL on `… whose connect-src allows the terrain, the search and the landmark signals`.

- [ ] **Step 3: Open the CSP**

In `server/headers.mjs`, the comment block (l.68-72) becomes:

```js
//   connect-src  kh.google.com (the terrain, tools/lib/rocktree/url.mjs),
//                Nominatim (search, src/scanner.js) and Overpass (the
//                landmark signals, src/signal-source.js). Open-Meteo is NOT
//                here: the client asks /__operator/:id/weather and the server
//                does that call. VITE_ROCKTREE_BASE can point the terrain at a
//                local relay, which is dev-only and not served by this server.
```

and line 93:

```js
	"connect-src 'self' https://kh.google.com https://nominatim.openstreetmap.org https://overpass-api.de",
```

Run: `node tools/server-selftest.mjs`
Expected: PASS.

- [ ] **Step 4: Wire the scanner**

In `src/scanner.js`, next to `import { createTracksLayer } from './map-tracks.js';` add:

```js
import { createSignalsLayer } from './map-signals.js';
import { createSignalSource, idbCache } from './signal-source.js';
import { tilesForView } from '../tools/signal-model.mjs';
```

Next to the module-level `lastView` declaration (search `let lastView`), add:

```js
// One source for the page's life, like lastView: its memory and its queue
// survive the scanner being unmounted and remounted, and the IndexedDB cache
// survives the page. Created lazily — Node imports this module in selftests.
let signalSource = null;
```

Right after the FLIGHT HISTORY restore line (`if (settings.flightHistoryMap ?? settings.enrichedMap) setHistory(true, { persist: false });`) insert:

```js
	// ------------------------------------------------------------ signals
	// Landmarks to capture (issue #185). Always on: they are the reason to
	// pick a zone. Asked tile by tile after the map settles; a status line
	// says when the view is too wide or Overpass is away. Nothing here ever
	// blocks drawing a zone or taking off.
	const signalsStatus = document.createElement('div');
	signalsStatus.className = 'sc-signals-status';
	const signalsCtl = L.control({ position: 'topright' });
	signalsCtl.onAdd = () => {
		const box = L.DomUtil.create('div', 'sc-map-controls sc-signals-controls');
		box.appendChild(signalsStatus);
		L.DomEvent.disableClickPropagation(box);
		return box;
	};
	signalsCtl.addTo(map);

	const signalsLayer = createSignalsLayer(L, {
		getSignals: () => signalSource?.signals() ?? [],
		ink: token('--warm-white') || '#ece7dd',
	});
	signalsLayer.addTo(map);

	let signalsTooWide = false;
	function renderSignalsStatus() {
		const st = signalSource?.status() ?? 'idle';
		signalsStatus.textContent = signalsTooWide ? 'SIGNALS: ZOOM IN TO SCAN'
			: st === 'unavailable' ? 'SIGNAL SCAN UNAVAILABLE'
			: st === 'loading' || st === 'waiting' ? 'SIGNALS: SCANNING…'
			: `SIGNALS: ${signalSource?.signals().length ?? 0}`;
		signalsStatus.dataset.state = signalsTooWide ? 'wide' : st;
	}

	signalSource ??= createSignalSource({
		fetch: (...a) => fetch(...a),
		cache: idbCache(),
	});
	// The source outlives this mount; its onChange is this mount's.
	const onSignals = () => { signalsLayer.refresh(); renderSignalsStatus(); };
	signalSource.onChange = onSignals;

	let signalsTimer = null;
	const SIGNALS_DEBOUNCE_MS = 600;
	function askSignals() {
		clearTimeout(signalsTimer);
		signalsTimer = setTimeout(() => {
			const b = map.getBounds();
			const keys = tilesForView({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }, map.getZoom());
			signalsTooWide = keys === null;
			if (keys) signalSource.request(keys);
			renderSignalsStatus();
		}, SIGNALS_DEBOUNCE_MS);
	}
	map.on('moveend zoomend', askSignals);
	askSignals();
```

In `cleanup()` (l.877), add before `for (const h of hosts) h.replaceChildren();`:

```js
		clearTimeout(signalsTimer);
		if (signalSource && signalSource.onChange === onSignals) signalSource.onChange = () => {};
```

`cleanup` is declared after the signals block, as a function declaration, so `signalsTimer` and `onSignals` are in scope. `destroy` already calls `cleanup()` then `map.remove()`, which drops the Leaflet listeners and the layer — no change needed at l.1244.

In `src/style.css`, next to the existing `.sc-history-controls` rule (search it), add:

```css
.sc-signals-status {
	font: var(--fs-micro) var(--font-ui);
	letter-spacing: var(--track-ui);
	color: var(--dim);
	padding: 4px 8px;
}
.sc-signals-status[data-state="unavailable"] { color: var(--yellow); }
```

- [ ] **Step 5: Chain the selftests**

In `package.json`, in `selftest:operator`, right after `node tools/scanner-selftest.mjs &&`, insert:

```
node tools/signal-model-selftest.mjs && node tools/signal-source-selftest.mjs && 
```

Run: `node tools/signal-model-selftest.mjs && node tools/signal-source-selftest.mjs && node tools/scanner-selftest.mjs && node tools/server-selftest.mjs && node tools/palette-selftest.mjs`
Expected: all pass.

- [ ] **Step 6: Translate what this task touched**

`src/scanner.js` and `server/headers.mjs` are touched: translate any remaining French comment in them to English (repo Language rule). Check: `grep -n -P "[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|une|est|pas)\b" src/scanner.js server/headers.mjs` — translate the comment hits only (not string literals shown to the player, which are already English).

- [ ] **Step 7: Commit**

```bash
git add src/scanner.js src/style.css server/headers.mjs tools/server-selftest.mjs package.json
git commit -m "Signals: on the scanner, with the CSP open to Overpass (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Verify in the browser, measure the density, changelog

**Files:**
- Modify: `../CHANGELOG.md`
- Possibly modify: `tools/signal-model.mjs` (`PER_TILE_CAP`, query clauses) if the measurement says so

- [ ] **Step 1: Run the game**

Run (from `sim/`): `npm run dev` (background). Open the printed URL in Chrome (chrome-devtools MCP), go to the terminal → scanner.

- [ ] **Step 2: Check the behaviour**

For each, take a screenshot and read the console:
1. World view (zoom < 11): status `SIGNALS: ZOOM IN TO SCAN`, no request to overpass-api.de in the network panel.
2. Search `Reims`, zoom 13: status goes `SCANNING…` then `SIGNALS: n` with n > 0; the cathedral diamond is on it; at zoom 15 its name is drawn.
3. Pan back and forth over the same tiles: no new Overpass request (network panel).
4. Reload the page, return to Reims: no Overpass request (IndexedDB cache).
5. Block `overpass-api.de` in devtools (network request blocking), pan to an unvisited city: status `SIGNAL SCAN UNAVAILABLE` in yellow; drawing a zone still works.
6. Console: no CSP report mentioning overpass.

- [ ] **Step 3: Measure the density (spec §1: "measured on real tiles, not guessed")**

With the browser on Paris centre, Reims, and a Swiss valley (e.g. Lauterbrunnen), read `SIGNALS: n` for a zoom-13 view of each. Record the three numbers in the commit message. If Paris shows so many diamonds at zoom 13 that they overlap into a blob, lower `PER_TILE_CAP` (Task 2) and re-run `node tools/signal-model-selftest.mjs` after updating its `PER_TILE_CAP` assertion; if the Swiss valley shows 0, check which clause should have matched (peaks need `wikidata` — note it, do not widen the filter without asking).

- [ ] **Step 4: Changelog**

Under `## [Non publié]` → `### Ajouté` in `../CHANGELOG.md`, add:

```markdown
- **Des signaux sur le scanner.** Les monuments et lieux notables
  d'OpenStreetMap (ceux qui portent un identifiant Wikidata) apparaissent sur
  la carte comme des losanges, avec leur niveau en points. Ils sont demandés à
  Overpass tuile par tuile, une seule requête à la fois, et gardés 30 jours en
  cache. Si Overpass ne répond pas, le scanner l'affiche et le jeu reste
  jouable. C'est le premier lot de #185 : la capture en vol vient ensuite.
```

- [ ] **Step 5: Commit and push**

```bash
git add ../CHANGELOG.md tools/signal-model.mjs tools/signal-model-selftest.mjs
git commit -m "Signals: changelog, density measured on Paris / Reims / Lauterbrunnen (#185)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

The parent (not a subagent) then runs `npm run selftest:ci` once, before opening the PR.
