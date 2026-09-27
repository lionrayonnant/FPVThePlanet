# Signals — Lot 2: Capture in flight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In flight, the landmarks around the take-off point are anchored on their buildings, annotated by a HUD callout (words labels, variant A), captured by holding them in the FPV frame, and each capture is stored — frame in the session, resolution in the operator state — and shows green on the scanner map.

**Architecture:** Pure, DOM-free units carry every decision (`signal-capture.js` state machine like `flight-end.js`; `signal-anchor.js` height resolution with an injected ground probe; `signal-store-model.mjs` bounded operator record; `signal-callout-model.mjs` screen layout and field reveal). Two thin browser layers draw (`signal-callout.js` DOM in the FPVTP! OSD; `map-signals.js` state colours). `main.js` is the only place that touches THREE, Rapier, the lens and the session.

**Tech Stack:** plain ES modules, Node `assert/strict` selftests, THREE (main.js only), Rapier queries via `physics.groundBelow` / `physics.obstructionBetween`.

**Spec:** `sim/docs/superpowers/specs/2026-09-27-signals-design.md` §3 (capture), §4 (callout), §6 (architecture). Lot 1 is merged into this branch's base (`signals-design`, PR #186). Issue #185.

## Decisions taken with the author (2026-09-27)

- **Active signals:** the flight asks the signal source for the tiles within `FLIGHT_RADIUS_M = 1500` of the take-off point (the fog range is ~2.3 km). Cache hits when the scanner already showed them; works for `?scene=` and `?live=` too.
- **The collected frame:** as received through the hijacked link — the existing `lens.capture()` (drone OSD, link degradation, weather included; the FPVTP! DOM overlay never is).
- **FPV only:** the gauge only fills in FPV view. In chase view the callout stays, the gauge does not move.
- **Green on the map** for a resolved signal (moved up from lot 3).
- **Clearance is lot 3:** in this lot every tier is capturable.

## Global Constraints

- Worktree `/home/user/Documents/dev/FPVThePlanet-signals2`, branch `signals-lot2` (stacked on `signals-design`). Paths are relative to `sim/` unless they start with `sim/` or `../`.
- English in code, comments, selftest labels, file names. A file you touch leaves in English (translate its remaining French comments — `src/session.js`, `src/operator.js`, `tools/ui-audio-model.mjs` are partly French: translate only the comments of the functions you touch, plus the file header if you touch the file). `CHANGELOG.md` entries in French.
- Selftests: `node:assert/strict`, local `t(name, fn)` printing `  ok  <name>`. Run only the selftests of the module you touched; never `npm run selftest:ci` (the CI runs it on the PR).
- Pure modules take no THREE, no Rapier, no DOM (pattern: `src/flight-end.js` + `tools/flight-end-selftest.mjs`).
- OSM text reaches the DOM only through `textContent` (PR #81).
- Colours: functional only — `--orange` capturing (happening now), `--green` uplinked/resolved, `--yellow` an open signal on the map. No demo palette (`tools/palette-selftest.mjs`). CSS spacing through tokens (`--space-*`), no bare px in padding/margin/gap.
- Numbers are starting points from the spec (12°, 6 s, 30–250 m): keep them as named constants in one place; do not hand-tune them.
- Commits end with a `Co-Authored-By:` trailer naming the model that wrote them.

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/signal-source.js` | Shared singleton `sharedSignalSource()` + listener set `subscribe(fn)`. |
| Modify `tools/signal-model.mjs` | `tilesAround(lat, lon, radiusM)`, `distanceM(a, b)`. |
| Modify `src/scanner.js` | Use `sharedSignalSource()` + `subscribe`. |
| Create `src/signal-capture.js` | Pure capture state machine. |
| Create `tools/signal-capture-selftest.mjs` | Its selftest. |
| Create `src/signal-anchor.js` | Pure anchor-height resolution (injected ground probe). |
| Create `tools/signal-anchor-selftest.mjs` | Its selftest. |
| Create `tools/signal-store-model.mjs` | Bounded `signals` operator record. |
| Create `tools/signal-store-selftest.mjs` | Its selftest. |
| Modify `server/api.mjs:180` + `tools/session-api-selftest.mjs` | `signals` writable. |
| Modify `src/map-signals.js` | Resolved signals drawn green. |
| Create `tools/signal-callout-model.mjs` | Pure: screen placement, edge chevron, field reveal, scramble. |
| Create `tools/signal-callout-selftest.mjs` | Its selftest. |
| Create `src/signal-callout.js` | DOM layer inside `#fpvtp-osd`. |
| Modify `src/style.css` | Callout styles. |
| Modify `src/main.js` | Wiring. |
| Modify `package.json` | Chain the new selftests into `selftest:operator`. |
| Modify `../CHANGELOG.md` | Entry. |

---

### Task 1: A shared signal source, and the tiles around a point

**Files:**
- Modify: `tools/signal-model.mjs`, `tools/signal-model-selftest.mjs`, `src/signal-source.js`, `tools/signal-source-selftest.mjs`, `src/scanner.js`

**Interfaces:**
- Produces:
  - `distanceM({lat, lon}, {lat, lon}) -> number` (haversine, metres)
  - `tilesAround(lat, lon, radiusM) -> string[]` — every z12 tile key whose bounds come within `radiusM` of the point, nearest first, the point's own tile first.
  - `createSignalSource(...)` result gains `subscribe(fn) -> unsubscribe` (all listeners called on every change). The writable `onChange` property is REMOVED.
  - `sharedSignalSource() -> source` — one per page, created lazily with the IndexedDB cache and the 40 s fetch timeout now in `scanner.js`.

- [ ] **Step 1: Failing tests**

Append to `tools/signal-model-selftest.mjs` (add `distanceM, tilesAround` to its import):

```js
t('distanceM: Eiffel Tower to Notre-Dame is ~4.1 km', () => {
	const d = distanceM({ lat: 48.8584, lon: 2.2945 }, { lat: 48.8530, lon: 2.3499 });
	assert.ok(Math.abs(d - 4090) < 60, String(d));
});

t('tilesAround: own tile first, every tile within the radius, none farther', () => {
	const p = { lat: 48.8584, lon: 2.2945 };
	const keys = tilesAround(p.lat, p.lon, 1500);
	assert.equal(keys[0], tileKey(tileOf(p.lat, p.lon)));
	assert.equal(new Set(keys).size, keys.length);
	assert.ok(keys.length >= 1 && keys.length <= 9, String(keys.length));
	for (const k of keys) {
		const [, x, y] = k.split('/').map(Number);
		const b = tileBounds({ x, y });
		// nearest point of the tile to p
		const near = { lat: Math.max(b.s, Math.min(b.n, p.lat)), lon: Math.max(b.w, Math.min(b.e, p.lon)) };
		assert.ok(distanceM(p, near) <= 1500 + 1, k);
	}
	assert.deepEqual(tilesAround(p.lat, p.lon, 0), [tileKey(tileOf(p.lat, p.lon))]);
});
```

Append to `tools/signal-source-selftest.mjs`:

```js
await t('subscribe: every listener hears every change; unsubscribe stops it', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	let a = 0, b = 0;
	const offA = src.subscribe(() => a++);
	src.subscribe(() => b++);
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.ok(a >= 1 && b >= 1 && a === b, `a=${a} b=${b}`);
	offA();
	const before = a;
	src.request(['z12/2075/1409']);
	await src.idle();
	assert.equal(a, before);
	assert.ok(b > before);
});

await t('a listener that throws does not stop the others', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	let heard = 0;
	src.subscribe(() => { throw new Error('boom'); });
	src.subscribe(() => heard++);
	// The source warns about the throwing listener; keep the test output clean.
	const warn = console.warn;
	let warned = 0;
	console.warn = () => { warned++; };
	try {
		src.request(['z12/2074/1409']);
		await src.idle();
	} finally { console.warn = warn; }
	assert.ok(heard >= 1);
	assert.ok(warned >= 1);
});
```

Replace the existing test `'onChange fires when signals or status change'` by the same scenario using `subscribe` (count ≥ 2). Remove every other use of `onChange` in the selftest (the constructor option is gone).

- [ ] **Step 2: Run, see them fail** — `node tools/signal-model-selftest.mjs; node tools/signal-source-selftest.mjs`

- [ ] **Step 3: Implement**

`tools/signal-model.mjs`, after `tileBounds`:

```js
const R_EARTH = 6371008.8;

export function distanceM(a, b) {
	const dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2;
	return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The tiles a flight needs: every z12 tile that comes within `radiusM` of the
// take-off point, its own tile first, then by distance. The flight asks for
// these once at spawn (spec §1: only the zone's signals are live in flight).
export function tilesAround(lat, lon, radiusM) {
	const c = tileOf(lat, lon);
	const own = tileKey(c);
	const out = [{ key: own, d: 0 }];
	const R = 3; // z12 tiles are >= ~4 km wide below 60° N: 3 rings cover any radius we use
	for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
		if (!dx && !dy) continue;
		const x = (((c.x + dx) % N) + N) % N, y = c.y + dy;
		if (y < 0 || y >= N) continue;
		const b = tileBounds({ x, y });
		const near = { lat: Math.max(b.s, Math.min(b.n, lat)), lon: Math.max(b.w, Math.min(b.e, lon)) };
		const d = distanceM({ lat, lon }, near);
		if (d <= radiusM) out.push({ key: tileKey({ x, y }), d });
	}
	return out.sort((p, q) => p.d - q.d || (p.key < q.key ? -1 : 1)).map((t) => t.key);
}
```

`src/signal-source.js`: replace the single `onChange` with a listener set. In `createSignalSource`, drop the `onChange` parameter and write:

```js
	const listeners = new Set();
	const emit = () => {
		for (const fn of listeners) {
			try { fn(); } catch (e) { console.warn('[signals] listener failed', e); }
		}
	};
```

and replace every `api.onChange()` by `emit()`. Add to the returned object:

```js
		// Several consumers now: the scanner map and the flight. Each keeps the
		// unsubscribe it was given and calls it when it goes away.
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
```

At the end of the file:

```js
// One source per page: the scanner and the flight share its memory, its
// queue and its IndexedDB cache. Created on first use — Node imports this
// module in selftests and must not touch indexedDB or AbortSignal.timeout.
let shared = null;
export function sharedSignalSource() {
	return shared ??= createSignalSource({
		// A stuck Overpass request must not stay in flight forever: the timeout
		// aborts, which lands in the source's catch → UNAVAILABLE + cooldown.
		fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(40_000) }),
		cache: idbCache(),
	});
}
```

`src/scanner.js`: remove the module-level `let signalSource = null;` and its comment; import `sharedSignalSource` instead of `createSignalSource, idbCache`; in the signals block replace the `signalSource ??= createSignalSource({...})` + `signalSource.onChange = onSignals` lines by

```js
	const signalSource = sharedSignalSource();
	const offSignals = signalSource.subscribe(() => { signalsLayer.refresh(); renderSignalsStatus(); });
	renderSignalsStatus();
```

(`signalSource` becomes a local const declared BEFORE `createSignalsLayer` / `renderSignalsStatus` use it — move the line up so the layer's `getSignals: () => signalSource.signals()` needs no `?.`.) In `cleanup()` replace the `onChange` reset by `offSignals();`.

- [ ] **Step 4: Green** — `node tools/signal-model-selftest.mjs && node tools/signal-source-selftest.mjs && node tools/scanner-selftest.mjs`

- [ ] **Step 5: Commit** — `Signals: one source for the page, with listeners, and the tiles around a take-off point (#185)`

---

### Task 2: The capture state machine

**Files:**
- Create: `src/signal-capture.js`
- Test: `tools/signal-capture-selftest.mjs`

**Interfaces:**
- Produces (`src/signal-capture.js`):
  - Constants: `CONE_DEG = 12`, `HOLD_S = 6`, `DRAIN_RATE = 1 / 3` (gauge seconds lost per second out of frame), `RANGE_M = { 1: [30, 250], 2: [30, 250], 3: [30, 450] }`, `SHOW_M = 400` (callout appears), `FOCUS_SWITCH_S = 0.5`.
  - `class SignalCapture`:
    - `setTargets(list)` — `list: Array<{ id, tier, pos: {x,y,z} | null, resolved: boolean }>`; keeps existing gauges for ids still present.
    - `markResolved(id)`.
    - `update({ dt, cam: { x, y, z, fx, fy, fz }, fpv, los })` — `fx,fy,fz` the unit forward vector; `los(target) -> boolean` called at most once per update, only for the focus candidate. Returns `this.out`.
    - `out = { rows: Array<{ id, dist, angleDeg, state, gauge }>, focus: id | null, uplinked: id | null }`. `state ∈ 'hidden' | 'near' | 'capturing' | 'held' | 'resolved'`: `hidden` beyond `SHOW_M` or no pos; `near` shown, not being captured; `capturing` the focus with the gauge rising; `held` a partially filled gauge not rising (out of frame / blocked / chase view) — drains; `resolved` done. `gauge` 0..1. `uplinked` is set on the update the gauge reaches 1 and cleared on the next `update` (consume-once, like `FlightEnd.out.closes`).

Rules:
1. Distance = straight-line camera → anchor. Angle = angle between `cam.f*` and the camera → anchor direction.
2. Candidates: not resolved, `pos` known, `RANGE_M[tier][0] <= dist <= RANGE_M[tier][1]`, `angle <= CONE_DEG`. Focus = the candidate with the smallest angle; keep the previous focus while it stays a candidate unless another has been strictly better for `FOCUS_SWITCH_S` (no flicker between two close landmarks).
3. The focus gauge rises by `dt / HOLD_S` only if `fpv && los(focus)`. Every other non-resolved gauge drains by `dt * DRAIN_RATE / HOLD_S`, floored at 0.
4. `dt <= 0` changes nothing (frozen sim), but `uplinked` is still cleared (drained).
5. Reaching 1 → state `resolved`, gauge 1, `out.uplinked = id`, focus released.

- [ ] **Step 1: Failing test** — `tools/signal-capture-selftest.mjs`:

```js
// Selftest of the capture state machine (issue #185, spec §3). No DOM, no
// THREE, no Rapier: synthetic camera poses and a clock advanced by hand.
// Run: node tools/signal-capture-selftest.mjs
import assert from 'node:assert/strict';
import { SignalCapture, CONE_DEG, HOLD_S, DRAIN_RATE, RANGE_M, SHOW_M } from '../src/signal-capture.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Camera at the origin looking north (-Z is north in local ENU: Z = south).
const camAt = (x = 0, y = 0, z = 0, fx = 0, fy = 0, fz = -1) => ({ x, y, z, fx, fy, fz });
const target = (id, pos, tier = 1, resolved = false) => ({ id, tier, pos, resolved });
const run = (sc, seconds, args, step = 0.05) => {
	let last = null;
	for (let s = 0; s < seconds - 1e-9; s += step) {
		sc.update({ dt: step, ...args });
		if (sc.out.uplinked) last = sc.out.uplinked;
	}
	return last;
};
const row = (sc, id) => sc.out.rows.find((r) => r.id === id);

t('constants from the spec', () => {
	assert.equal(CONE_DEG, 12);
	assert.equal(HOLD_S, 6);
	assert.equal(DRAIN_RATE, 1 / 3);
	assert.deepEqual(RANGE_M[1], [30, 250]);
	assert.equal(SHOW_M, 400);
});

t('held dead ahead for 6 s in FPV with a clear line: UPLINKED once, then resolved', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const args = { cam: camAt(), fpv: true, los: () => true };
	assert.equal(run(sc, HOLD_S - 0.2, args), null);
	assert.equal(row(sc, 'a').state, 'capturing');
	assert.equal(run(sc, 0.4, args), 'a');
	assert.equal(row(sc, 'a').state, 'resolved');
	sc.update({ dt: 0.05, ...args });
	assert.equal(sc.out.uplinked, null, 'consume-once');
	assert.equal(run(sc, 10, args), null, 'never twice');
});

t('outside the cone, too close, too far, or hidden: never captured', () => {
	const args = { cam: camAt(), fpv: true, los: () => true };
	const off = new SignalCapture();
	// 13° to the east at 100 m
	off.setTargets([target('a', { x: Math.tan(13 * Math.PI / 180) * 100, y: 0, z: -100 })]);
	assert.equal(run(off, 10, args), null);
	assert.equal(row(off, 'a').state, 'near');
	const close = new SignalCapture();
	close.setTargets([target('a', { x: 0, y: 0, z: -20 })]);
	assert.equal(run(close, 10, args), null);
	const far = new SignalCapture();
	far.setTargets([target('a', { x: 0, y: 0, z: -300 })]);
	assert.equal(run(far, 10, args), null);
	assert.equal(row(far, 'a').state, 'near', 'shown at 300 m, not capturable');
	const hidden = new SignalCapture();
	hidden.setTargets([target('a', { x: 0, y: 0, z: -500 })]);
	sc_update(hidden, args);
	assert.equal(row(hidden, 'a').state, 'hidden');
});
function sc_update(sc, args) { sc.update({ dt: 0.05, ...args }); }

t('tier III reaches farther', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('peak', { x: 0, y: 0, z: -400 }, 3)]);
	assert.equal(run(sc, HOLD_S + 0.2, { cam: camAt(), fpv: true, los: () => true }), 'peak');
});

t('chase view or a blocked line: the gauge does not rise, and drains slowly', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	run(sc, 3, { cam: camAt(), fpv: true, los: () => true });
	const g = row(sc, 'a').gauge;
	assert.ok(Math.abs(g - 0.5) < 0.02, String(g));
	run(sc, 3, { cam: camAt(), fpv: false, los: () => true });
	assert.equal(row(sc, 'a').state, 'held');
	assert.ok(Math.abs(row(sc, 'a').gauge - (0.5 - 3 * DRAIN_RATE / HOLD_S)) < 0.02);
	run(sc, 1, { cam: camAt(), fpv: true, los: () => false });
	assert.ok(row(sc, 'a').gauge < 0.34);
});

t('a bad pass costs seconds, not the capture (cumulative hold)', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const on = { cam: camAt(), fpv: true, los: () => true };
	const away = { cam: camAt(0, 0, 0, 1, 0, 0), fpv: true, los: () => true };
	run(sc, 4, on);
	run(sc, 1.5, away);
	// 4 s held, 0.5 s lost: 2.5 s more is not enough, 2.6 s... is.
	assert.equal(run(sc, 2.4, on), null);
	assert.equal(run(sc, 0.3, on), 'a');
});

t('frozen (dt 0): nothing moves, uplinked still drains', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const args = { cam: camAt(), fpv: true, los: () => true };
	run(sc, HOLD_S + 0.1, args);
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 }, 1, true), target('b', { x: 0, y: 0, z: -120 })]);
	run(sc, 2, args);
	const g = row(sc, 'b').gauge;
	sc.update({ dt: 0, ...args });
	assert.equal(row(sc, 'b').gauge, g);
});

t('the focus is the target nearest the axis, los asked only for it, no flicker', () => {
	const sc = new SignalCapture();
	sc.setTargets([
		target('left', { x: -Math.tan(5 * Math.PI / 180) * 100, y: 0, z: -100 }),
		target('right', { x: Math.tan(4 * Math.PI / 180) * 100, y: 0, z: -100 }),
	]);
	const asked = [];
	sc.update({ dt: 0.05, cam: camAt(), fpv: true, los: (tg) => { asked.push(tg.id); return true; } });
	assert.equal(sc.out.focus, 'right');
	assert.deepEqual(asked, ['right']);
	// Turn 1.5° left: left is now at 3.5°, right at 5.5° — the focus holds for FOCUS_SWITCH_S.
	const yaw = -1.5 * Math.PI / 180;
	const turned = camAt(0, 0, 0, Math.sin(yaw), 0, -Math.cos(yaw));
	sc.update({ dt: 0.2, cam: turned, fpv: true, los: () => true });
	assert.equal(sc.out.focus, 'right');
	run(sc, 0.5, { cam: turned, fpv: true, los: () => true });
	assert.equal(sc.out.focus, 'left');
});

t('setTargets keeps the gauges of ids still present, drops the others', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	run(sc, 3, { cam: camAt(), fpv: true, los: () => true });
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 }), target('b', null)]);
	sc.update({ dt: 0.05, cam: camAt(), fpv: false, los: () => true });
	assert.ok(row(sc, 'a').gauge > 0.45);
	assert.equal(row(sc, 'b').state, 'hidden', 'no anchor yet');
});

t('markResolved: a signal resolved elsewhere stops at once', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	sc.markResolved('a');
	assert.equal(run(sc, 10, { cam: camAt(), fpv: true, los: () => true }), null);
	assert.equal(row(sc, 'a').state, 'resolved');
});

console.log(`signal-capture: ${n} ok`);
```

- [ ] **Step 2: Run** — `node tools/signal-capture-selftest.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/signal-capture.js`:

```js
// Signal capture in flight (issue #185, spec §3): hold a landmark in the FPV
// frame, the gauge fills, at 100 % it is UPLINKED. Pure — no THREE, no
// Rapier, no DOM — so it is checked with synthetic poses
// (tools/signal-capture-selftest.mjs). main.js feeds it the camera pose and a
// line-of-sight probe, and drains `out.uplinked` like FlightEnd.out.closes.
//
// The numbers are the spec's starting points, kept here and nowhere else.
export const CONE_DEG = 12;
export const HOLD_S = 6;
// Out of frame the gauge drains at a third of the rate it fills: a bad pass
// costs seconds, not the capture.
export const DRAIN_RATE = 1 / 3;
export const RANGE_M = { 1: [30, 250], 2: [30, 250], 3: [30, 450] };
// The callout appears inside this distance (it is inside the fog range).
export const SHOW_M = 400;
// Another candidate must be strictly nearer the axis this long to take the
// focus: two landmarks side by side must not make the gauge flicker.
export const FOCUS_SWITCH_S = 0.5;

const COS_CONE = Math.cos(CONE_DEG * Math.PI / 180);

export class SignalCapture {
	constructor() {
		this._targets = [];
		this._gauge = new Map();
		this._resolved = new Set();
		this._focus = null;
		this._challenger = null;
		this._challengeS = 0;
		this.out = { rows: [], focus: null, uplinked: null };
	}

	setTargets(list) {
		this._targets = Array.isArray(list) ? list.filter((t) => t && t.id) : [];
		const ids = new Set(this._targets.map((t) => t.id));
		for (const id of [...this._gauge.keys()]) if (!ids.has(id)) this._gauge.delete(id);
		for (const t of this._targets) if (t.resolved) this._resolved.add(t.id);
		if (this._focus && !ids.has(this._focus)) this._focus = null;
	}

	markResolved(id) {
		this._resolved.add(id);
		if (this._focus === id) this._focus = null;
	}

	update({ dt, cam, fpv, los }) {
		const o = this.out;
		o.uplinked = null;
		const rows = [];
		let best = null;
		for (const t of this._targets) {
			const r = { id: t.id, dist: Infinity, angleDeg: 180, state: 'hidden', gauge: this._gauge.get(t.id) ?? 0 };
			rows.push(r);
			if (this._resolved.has(t.id)) { r.state = 'resolved'; r.gauge = 1; }
			if (!t.pos) continue;
			const dx = t.pos.x - cam.x, dy = t.pos.y - cam.y, dz = t.pos.z - cam.z;
			const dist = Math.hypot(dx, dy, dz);
			r.dist = dist;
			const cos = dist > 1e-6 ? (dx * cam.fx + dy * cam.fy + dz * cam.fz) / dist : 1;
			r.angleDeg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
			if (r.state === 'resolved') continue;
			if (dist > SHOW_M && !(t.tier === 3 && dist <= RANGE_M[3][1])) continue;
			r.state = r.gauge > 0 ? 'held' : 'near';
			const [lo, hi] = RANGE_M[t.tier] ?? RANGE_M[1];
			if (dist >= lo && dist <= hi && cos >= COS_CONE && (!best || r.angleDeg < best.row.angleDeg)) {
				best = { t, row: r };
			}
		}

		// Focus with hysteresis.
		const cur = rows.find((r) => r.id === this._focus && r.state !== 'resolved');
		const curIsCandidate = cur && best && this._isCandidate(cur);
		if (!best) {
			this._focus = null; this._challenger = null; this._challengeS = 0;
		} else if (!this._focus || !curIsCandidate) {
			this._focus = best.t.id; this._challenger = null; this._challengeS = 0;
		} else if (best.t.id !== this._focus) {
			if (this._challenger === best.t.id) this._challengeS += Math.max(0, dt);
			else { this._challenger = best.t.id; this._challengeS = Math.max(0, dt); }
			if (this._challengeS >= FOCUS_SWITCH_S) { this._focus = best.t.id; this._challenger = null; this._challengeS = 0; }
		} else {
			this._challenger = null; this._challengeS = 0;
		}
		o.focus = this._focus;

		if (dt > 0) {
			const focusT = this._targets.find((t) => t.id === this._focus);
			const rising = focusT && fpv && los(focusT);
			for (const r of rows) {
				if (r.state === 'resolved' || r.state === 'hidden') continue;
				let g = this._gauge.get(r.id) ?? 0;
				if (r.id === this._focus && rising) {
					g = Math.min(1, g + dt / HOLD_S);
					r.state = 'capturing';
				} else {
					g = Math.max(0, g - dt * DRAIN_RATE / HOLD_S);
					r.state = g > 0 ? 'held' : 'near';
				}
				this._gauge.set(r.id, g);
				r.gauge = g;
				if (g >= 1) {
					this._resolved.add(r.id);
					r.state = 'resolved';
					o.uplinked = r.id;
					this._focus = null;
					o.focus = null;
				}
			}
		} else if (this._focus) {
			const r = rows.find((x) => x.id === this._focus);
			if (r && r.gauge > 0) r.state = 'held';
		}
		o.rows = rows;
		return o;
	}

	_isCandidate(r) {
		const t = this._targets.find((x) => x.id === r.id);
		if (!t || !t.pos) return false;
		const [lo, hi] = RANGE_M[t.tier] ?? RANGE_M[1];
		return r.dist >= lo && r.dist <= hi && r.angleDeg <= CONE_DEG;
	}
}
```

Note on the focus rule: `los` is called once per update, only for the focus — the frame budget holds whatever the number of landmarks.

- [ ] **Step 4: Green** — `node tools/signal-capture-selftest.mjs` → `signal-capture: 10 ok`. If a test disagrees with the code, the RULES above are the authority: fix the code, not the rule; if a test itself contradicts the rules, fix the test and say so in the report.

- [ ] **Step 5: Commit** — `Signals: the capture state machine — hold it in frame, it uplinks (#185)`

---

### Task 3: Anchors on the real building

**Files:**
- Create: `src/signal-anchor.js`, `tools/signal-anchor-selftest.mjs`

**Interfaces:**
- Produces:
  - `RING_M = 12`, `RING_N = 8`, `ABOVE_M = 3`, `PROBE_FROM_M = 600`, `RETRY_S = 0.5`, `RISE_TAU_S = 0.4`
  - `class SignalAnchors({ toLocal: (lat, lon) -> {x, z}, ground: (x, z, fromY) -> y | null })`
    - `set(signals)` — `Signal[]` from the model; creates an anchor per id (x, z from `toLocal`, y unknown).
    - `update(dt)` — for anchors without a surface, probes at most `PROBE_BUDGET = 4` per call, round-robin, each anchor at most every `RETRY_S`; the probe samples the centre and `RING_N` points on a circle of `RING_M`, takes the HIGHEST hit (the spire, not the courtyard); target y = max + `ABOVE_M`. Once found, the displayed y eases towards the target (`y += (target - y) * (1 - exp(-dt / RISE_TAU_S))`); re-probes every 5 s so a mesh that streamed in higher is taken into account (target only rises, never falls).
    - `pos(id) -> {x, y, z} | null` — null until the first hit (an unstreamed tile: no anchor, the callout stays hidden rather than lying about the height).

- [ ] **Step 1: Failing test** — `tools/signal-anchor-selftest.mjs`:

```js
// Selftest of the signal anchors (issue #185, spec §1: "height is found in
// flight"). The ground probe is a function of (x, z): no Rapier.
// Run: node tools/signal-anchor-selftest.mjs
import assert from 'node:assert/strict';
import { SignalAnchors, RING_M, ABOVE_M, RETRY_S } from '../src/signal-anchor.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const toLocal = (lat, lon) => ({ x: lon * 1000, z: -lat * 1000 });
const sig = (id, lat, lon) => ({ id, lat, lon });
const settle = (a, s) => { for (let i = 0; i < s * 20; i++) a.update(0.05); };

t('no hit yet: no anchor; the tile streams in: the anchor appears and rises', () => {
	let streamed = false;
	const a = new SignalAnchors({ toLocal, ground: () => (streamed ? 40 : null) });
	a.set([sig('a', 0, 0)]);
	settle(a, 2);
	assert.equal(a.pos('a'), null);
	streamed = true;
	settle(a, 3);
	const p = a.pos('a');
	assert.ok(p && Math.abs(p.y - (40 + ABOVE_M)) < 0.5, JSON.stringify(p));
});

t('the highest sample of the ring wins: the spire, not the courtyard', () => {
	// A spire 5 m east of the centre, inside RING_M.
	const ground = (x, z) => (Math.hypot(x - 5, z) < RING_M * 0.6 ? 80 : 10);
	const a = new SignalAnchors({ toLocal, ground });
	a.set([sig('a', 0, 0)]);
	settle(a, 3);
	assert.ok(Math.abs(a.pos('a').y - (80 + ABOVE_M)) < 0.5);
});

t('x and z come from toLocal', () => {
	const a = new SignalAnchors({ toLocal, ground: () => 0 });
	a.set([sig('a', 0.001, 0.002)]);
	settle(a, 1);
	assert.deepEqual([a.pos('a').x, a.pos('a').z], [2, -1]);
});

t('probing is budgeted and retried no faster than RETRY_S', () => {
	let calls = 0;
	const a = new SignalAnchors({ toLocal, ground: () => { calls++; return null; } });
	a.set(Array.from({ length: 20 }, (_, i) => sig(`s${i}`, i, i)));
	a.update(0.05);
	assert.ok(calls <= 4 * 9, `first frame: ${calls} probes`);
	calls = 0;
	for (let i = 0; i < 20; i++) a.update(0.05); // 1 s
	// 20 anchors, each at most once per RETRY_S, 9 samples each
	assert.ok(calls <= Math.ceil(1 / RETRY_S + 1) * 20 * 9, String(calls));
});

t('a higher mesh later raises the anchor; a lower one never lowers it', () => {
	let h = 20;
	const a = new SignalAnchors({ toLocal, ground: () => h });
	a.set([sig('a', 0, 0)]);
	settle(a, 2);
	h = 60;
	settle(a, 7);
	assert.ok(a.pos('a').y > 60);
	h = 5;
	settle(a, 7);
	assert.ok(a.pos('a').y > 60);
});

t('set() replaces the list; unknown ids read null', () => {
	const a = new SignalAnchors({ toLocal, ground: () => 1 });
	a.set([sig('a', 0, 0)]);
	settle(a, 1);
	a.set([sig('b', 0, 0)]);
	assert.equal(a.pos('a'), null);
	assert.equal(a.pos('nope'), null);
});

console.log(`signal-anchor: ${n} ok`);
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `src/signal-anchor.js`:

```js
// Where a signal sits in the 3D world (issue #185, spec §1): OSM gives lat/lon,
// the height is found in flight by probing the streamed mesh. Pure: the probe
// is injected (main.js passes physics.groundBelow), so it is checked without
// Rapier in tools/signal-anchor-selftest.mjs.
//
// A landmark's OSM point is often its centroid — a cathedral's is over the
// nave, a castle's over the courtyard. The probe samples a ring and keeps the
// HIGHEST hit: the callout belongs on the spire, not in the yard.
export const RING_M = 12;
export const RING_N = 8;
export const ABOVE_M = 3;
export const PROBE_FROM_M = 600;
export const RETRY_S = 0.5;
export const RISE_TAU_S = 0.4;
const PROBE_BUDGET = 4;
const REPROBE_S = 5;

export class SignalAnchors {
	constructor({ toLocal, ground }) {
		this._toLocal = toLocal;
		this._ground = ground;
		this._list = [];
		this._by = new Map();
		this._cursor = 0;
	}

	set(signals) {
		this._list = [];
		this._by = new Map();
		for (const s of signals ?? []) {
			const p = this._toLocal(s.lat, s.lon);
			if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
			const a = { id: s.id, x: p.x, z: p.z, y: null, target: null, wait: 0 };
			this._list.push(a);
			this._by.set(s.id, a);
		}
		this._cursor = 0;
	}

	update(dt) {
		for (const a of this._list) {
			a.wait -= dt;
			if (a.y !== null && a.target !== null) a.y += (a.target - a.y) * (1 - Math.exp(-dt / RISE_TAU_S));
		}
		let budget = PROBE_BUDGET;
		for (let i = 0; i < this._list.length && budget > 0; i++) {
			const a = this._list[(this._cursor + i) % this._list.length];
			if (a.wait > 0) continue;
			budget--;
			const top = this._probe(a.x, a.z);
			if (top === null) { a.wait = RETRY_S; continue; }
			const target = top + ABOVE_M;
			if (a.target === null || target > a.target) a.target = target;
			if (a.y === null) a.y = a.target;
			a.wait = REPROBE_S;
		}
		if (this._list.length) this._cursor = (this._cursor + PROBE_BUDGET) % this._list.length;
	}

	pos(id) {
		const a = this._by.get(id);
		return a && a.y !== null ? { x: a.x, y: a.y, z: a.z } : null;
	}

	_probe(x, z) {
		let top = this._ground(x, z, PROBE_FROM_M);
		for (let k = 0; k < RING_N; k++) {
			const th = (k / RING_N) * Math.PI * 2;
			const h = this._ground(x + Math.cos(th) * RING_M, z + Math.sin(th) * RING_M, PROBE_FROM_M);
			if (h !== null && (top === null || h > top)) top = h;
		}
		return top;
	}
}
```

- [ ] **Step 4: Green** — `node tools/signal-anchor-selftest.mjs` → `signal-anchor: 6 ok`.

- [ ] **Step 5: Commit** — `Signals: anchors found on the streamed mesh, on the spire not in the yard (#185)`

---

### Task 4: What an operator has resolved — stored, and green on the map

**Files:**
- Create: `tools/signal-store-model.mjs`, `tools/signal-store-selftest.mjs`
- Modify: `server/api.mjs:170-180`, `tools/session-api-selftest.mjs` (near l.189), `src/map-signals.js`, `src/scanner.js`

**Interfaces:**
- Produces (`tools/signal-store-model.mjs`):
  - `MAX_RESOLVED = 5000`
  - `fromStored(value) -> { resolved: { [id]: Entry } }` — anything malformed reads as empty; entries failing validation are dropped.
  - `Entry = { at: number, name: string, lat: number, lon: number, tier: 1|2|3, family: string|null, holdS: number, distM: number, sessionId: string|null, photo: number|null }` (`photo` = index of the frame in that session's photos).
  - `withResolved(store, id, entry) -> store` — new object; keeps the FIRST resolution of an id (never overwritten); past `MAX_RESOLVED` drops the oldest (`at`).
  - `resolvedIds(store) -> Set<string>`
- `server/api.mjs`: `signals` joins `OP_WRITABLE_KEYS`, with the same comment contract as `coverage` (bounded client-side, no image bytes — the frame lives in the session's photos).
- `createSignalsLayer(L, { getSignals, getResolved = () => null, ink, resolvedInk, white })`: a signal whose id is in `getResolved()` is drawn with `resolvedInk` (the scanner passes `--green`).

- [ ] **Step 1: Failing tests** — `tools/signal-store-selftest.mjs`:

```js
// Selftest of the operator's resolved-signals record (issue #185).
// Run: node tools/signal-store-selftest.mjs
import assert from 'node:assert/strict';
import { MAX_RESOLVED, fromStored, withResolved, resolvedIds } from './signal-store-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const entry = (at, extra = {}) => ({ at, name: 'X', lat: 49.25, lon: 4.03, tier: 1, family: 'cinewhoop', holdS: 6.1, distM: 142, sessionId: 's1', photo: 0, ...extra });

t('garbage reads as empty', () => {
	for (const v of [undefined, null, 3, 'x', [], { resolved: 'x' }]) assert.deepEqual(fromStored(v), { resolved: {} });
});

t('valid entries survive, malformed ones are dropped', () => {
	const s = fromStored({ resolved: {
		'wd:Q1': entry(1),
		'wd:Q2': { at: 'x' },
		'not-an-id': entry(2),
		'wd:Q3': entry(3, { tier: 9 }),
		'wd:Q4': entry(4, { photo: null, sessionId: null, family: null }),
	} });
	assert.deepEqual(Object.keys(s.resolved).sort(), ['wd:Q1', 'wd:Q4']);
});

t('withResolved keeps the first resolution and returns a new object', () => {
	const a = withResolved(fromStored(null), 'wd:Q1', entry(10));
	const b = withResolved(a, 'wd:Q1', entry(20));
	assert.equal(b.resolved['wd:Q1'].at, 10);
	assert.notEqual(a, fromStored(null));
	assert.deepEqual([...resolvedIds(b)], ['wd:Q1']);
});

t('past MAX_RESOLVED the oldest goes', () => {
	let s = fromStored(null);
	for (let i = 0; i < MAX_RESOLVED + 3; i++) s = withResolved(s, `wd:Q${i + 1}`, entry(i));
	assert.equal(Object.keys(s.resolved).length, MAX_RESOLVED);
	assert.equal(s.resolved['wd:Q1'], undefined);
	assert.ok(s.resolved[`wd:Q${MAX_RESOLVED + 3}`]);
});

t('text is capped and control characters stripped', () => {
	const s = withResolved(fromStored(null), 'wd:Q1', entry(1, { name: 'A\u0000' + 'B'.repeat(200) }));
	assert.ok(s.resolved['wd:Q1'].name.length <= 60);
	assert.ok(!/\u0000/.test(s.resolved['wd:Q1'].name));
});

console.log(`signal-store: ${n} ok`);
```

In `tools/session-api-selftest.mjs`, next to the `coverage` PATCH round-trip (~l.189), add the same round-trip for `{ key: 'signals', value: { resolved: {} } }` expecting 200 and the value read back.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `tools/signal-store-model.mjs`:

```js
// The signals an operator has resolved (issue #185, spec §6), stored under the
// operator's `signals` key. Bounded here, on the client side — the server does
// not validate writable keys (server/api.mjs, OP_WRITABLE_KEYS). No image
// bytes: the frame lives in the session's photos, an entry only points at it.
export const MAX_RESOLVED = 5000;
const TEXT_MAX = 60;
const ID_RE = /^wd:Q\d+$/;

const text = (v) => (typeof v === 'string'
	? Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, TEXT_MAX).join('')
	: null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function entryOf(e) {
	if (!e || typeof e !== 'object') return null;
	const at = num(e.at), lat = num(e.lat), lon = num(e.lon), holdS = num(e.holdS), distM = num(e.distM);
	if (at === null || lat === null || lon === null || holdS === null || distM === null) return null;
	if (![1, 2, 3].includes(e.tier)) return null;
	const photo = e.photo === null || e.photo === undefined ? null : (Number.isInteger(e.photo) && e.photo >= 0 ? e.photo : null);
	return {
		at, name: text(e.name) ?? '', lat, lon, tier: e.tier,
		family: text(e.family), holdS, distM,
		sessionId: text(e.sessionId), photo,
	};
}

export function fromStored(value) {
	const out = { resolved: {} };
	const r = value && typeof value === 'object' && !Array.isArray(value) ? value.resolved : null;
	if (!r || typeof r !== 'object' || Array.isArray(r)) return out;
	for (const [id, e] of Object.entries(r)) {
		if (!ID_RE.test(id)) continue;
		const v = entryOf(e);
		if (v) out.resolved[id] = v;
	}
	return out;
}

export function withResolved(store, id, entry) {
	const base = fromStored(store);
	if (!ID_RE.test(id) || base.resolved[id]) return base;
	const e = entryOf(entry);
	if (!e) return base;
	base.resolved[id] = e;
	const ids = Object.keys(base.resolved);
	if (ids.length > MAX_RESOLVED) {
		ids.sort((a, b) => base.resolved[a].at - base.resolved[b].at);
		for (const old of ids.slice(0, ids.length - MAX_RESOLVED)) delete base.resolved[old];
	}
	return base;
}

export const resolvedIds = (store) => new Set(Object.keys(fromStored(store).resolved));
```

`server/api.mjs`: add after the `coverage` paragraph:

```js
// `signals` (issue #185): the landmarks the operator has resolved. Same
// contract as coverage — bounded client-side (MAX_RESOLVED in
// tools/signal-store-model.mjs, whose fromStored() drops anything malformed),
// no image bytes (the frame is a session photo, the entry only points at it).
```

and `const OP_WRITABLE_KEYS = new Set(['settings', 'dialogueMemory', 'coverage', 'signals']);`

`src/map-signals.js`: accept `getResolved = () => null` and `resolvedInk = '#7aa96b'`; in `_redraw`, compute `const done = getResolved?.() ?? null;` and for each point choose `const c = done && done.has(s.id) ? resolvedInk : ink;` — halo gradient AND core use `c` (the white pinpoint stays). Keep one gradient per point (already the case).

`src/scanner.js`: import `resolvedIds` from `../tools/signal-store-model.mjs`; pass to the layer `getResolved: () => resolvedIds(operatorApi.getOperator()?.signals), resolvedInk: token('--green') || '#7aa96b'`. The status line becomes `SIGNALS: n · k RESOLVED` when k > 0 (k = resolved ids among the loaded signals).

- [ ] **Step 4: Green** — `node tools/signal-store-selftest.mjs && node tools/session-api-selftest.mjs && node tools/server-selftest.mjs && node tools/scanner-selftest.mjs && node tools/palette-selftest.mjs && node -e "import('./src/map-signals.js').then(m => console.log(typeof m.createSignalsLayer))"`

- [ ] **Step 5: Commit** — `Signals: what an operator resolved is kept, and shows green on the scanner (#185)`

---

### Task 5: The HUD callout

**Files:**
- Create: `tools/signal-callout-model.mjs`, `tools/signal-callout-selftest.mjs`, `src/signal-callout.js`
- Modify: `src/style.css` (next to the `#fpvtp-osd` rules, ~l.175-200)

**Interfaces:**
- Produces (`tools/signal-callout-model.mjs`, pure):
  - `placeCallout({ ndcX, ndcY, behind }, { w, h }, { boxW = 230, boxH = 110, margin = 24 }) -> { onScreen, ax, ay, bx, by, edge: null | { x, y, angleDeg } }` — `ax, ay` the anchor in px; `bx, by` the box's top-left, placed up-right of the anchor (`ax + 60, ay - 70 - boxH/2`), flipped left when it would overflow the right edge, clamped vertically inside the viewport. `onScreen` false when `behind` or the anchor is outside `[-1, 1]²`; then `edge` is the point where the ray from the screen centre towards the anchor (reversed when `behind`) leaves the viewport shrunk by `margin`, and `angleDeg` its direction (0 = right, 90 = down).
  - `revealCount(nFields, gauge, state) -> number` — `resolved` → all; `near`/`hidden` → 0; otherwise `Math.floor(gauge * (nFields + 1))` capped at `nFields` (the name comes first, the last field at ~full gauge).
  - `scramble(text, seed) -> string` — same length, every non-space replaced by a glyph of `░▒▓█` chosen by a deterministic hash of `(seed, index)`; `seed` changes ~8×/s in the DOM layer so it shimmers without `Math.random` in the model.
  - `headline(state) -> { word, tone }` — `near`/`held` → `SIGNAL`/`'dim'`, `capturing` → `CAPTURING`/`'orange'`, `resolved` → `UPLINKED`/`'green'`.
- `src/signal-callout.js`: `class SignalCallout(root)` builds `<div id="fo-signal">` inside `#fpvtp-osd` with an SVG leader line, a box (`.hd` headline + distance, `.gauge` 12 cells, rows of `NAME/TYPE/BUILT/HEIGHT/ARCHITECT/STATUS` from `signal.fields` — labels are the field `label`s, words, variant A), and an edge chevron. `render({ signal, row, placed, now })` or `render(null)` to hide. Everything written with `textContent` / `setAttribute`.

- [ ] **Step 1: Failing test** — `tools/signal-callout-selftest.mjs`:

```js
// Selftest of the HUD callout's pure layout (issue #185, spec §4).
// Run: node tools/signal-callout-selftest.mjs
import assert from 'node:assert/strict';
import { placeCallout, revealCount, scramble, headline } from './signal-callout-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const VP = { w: 1600, h: 900 };

t('an anchor on screen: px position, box up-right, inside the viewport', () => {
	const p = placeCallout({ ndcX: 0, ndcY: 0, behind: false }, VP, {});
	assert.equal(p.onScreen, true);
	assert.deepEqual([p.ax, p.ay], [800, 450]);
	assert.ok(p.bx > p.ax && p.by < p.ay);
	assert.equal(p.edge, null);
});

t('near the right edge the box flips left; near the top it is clamped down', () => {
	const p = placeCallout({ ndcX: 0.95, ndcY: 0.98, behind: false }, VP, {});
	assert.ok(p.bx + 230 <= VP.w, String(p.bx));
	assert.ok(p.bx < p.ax);
	assert.ok(p.by >= 0);
});

t('off screen to the right: an edge chevron on the right border pointing right', () => {
	const p = placeCallout({ ndcX: 3, ndcY: 0, behind: false }, VP, { margin: 24 });
	assert.equal(p.onScreen, false);
	assert.ok(Math.abs(p.edge.x - (VP.w - 24)) < 1 && Math.abs(p.edge.y - 450) < 1);
	assert.ok(Math.abs(p.edge.angleDeg) < 1);
});

t('behind the camera: the chevron points the other way', () => {
	const p = placeCallout({ ndcX: 0.5, ndcY: 0, behind: true }, VP, { margin: 24 });
	assert.equal(p.onScreen, false);
	assert.ok(p.edge.x < VP.w / 2, 'reversed: the left side');
});

t('revealCount: name first, all at 100 %, nothing when merely near, all when resolved', () => {
	assert.equal(revealCount(5, 0, 'near'), 0);
	assert.equal(revealCount(5, 0.2, 'capturing'), 1);
	assert.equal(revealCount(5, 0.99, 'capturing'), 5);
	assert.equal(revealCount(5, 0.5, 'held'), 3);
	assert.equal(revealCount(5, 0, 'resolved'), 5);
	assert.equal(revealCount(0, 1, 'capturing'), 0);
});

t('scramble: same length, spaces kept, deterministic per seed, changes with the seed', () => {
	const s = 'NOTRE DAME';
	assert.equal(scramble(s, 1).length, s.length);
	assert.equal(scramble(s, 1)[5], ' ');
	assert.equal(scramble(s, 1), scramble(s, 1));
	assert.notEqual(scramble(s, 1), scramble(s, 2));
	assert.ok(/^[░▒▓█ ]+$/.test(scramble(s, 7)));
});

t('headline: words and functional tones', () => {
	assert.deepEqual(headline('near'), { word: 'SIGNAL', tone: 'dim' });
	assert.deepEqual(headline('held'), { word: 'SIGNAL', tone: 'dim' });
	assert.deepEqual(headline('capturing'), { word: 'CAPTURING', tone: 'orange' });
	assert.deepEqual(headline('resolved'), { word: 'UPLINKED', tone: 'green' });
});

console.log(`signal-callout: ${n} ok`);
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `tools/signal-callout-model.mjs`:

```js
// The HUD callout's pure half (issue #185, spec §4): where the box goes, how
// much of it is decrypted, what the headline says. No DOM — the DOM layer is
// src/signal-callout.js.

export function placeCallout({ ndcX, ndcY, behind }, { w, h }, { boxW = 230, boxH = 110, margin = 24 } = {}) {
	const ax = (ndcX + 1) / 2 * w;
	const ay = (1 - ndcY) / 2 * h;
	const onScreen = !behind && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;
	if (!onScreen) {
		let dx = ax - w / 2, dy = ay - h / 2;
		if (behind) { dx = -dx; dy = -dy; }
		if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = h; // dead behind: point down
		const hw = w / 2 - margin, hh = h / 2 - margin;
		const k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
		return {
			onScreen: false, ax, ay, bx: 0, by: 0,
			edge: { x: w / 2 + dx * k, y: h / 2 + dy * k, angleDeg: Math.atan2(dy, dx) * 180 / Math.PI },
		};
	}
	let bx = ax + 60;
	if (bx + boxW > w - margin) bx = ax - 60 - boxW;
	let by = ay - 70 - boxH / 2;
	by = Math.max(margin, Math.min(h - margin - boxH, by));
	return { onScreen: true, ax, ay, bx, by, edge: null };
}

export function revealCount(nFields, gauge, state) {
	if (state === 'resolved') return nFields;
	if (state !== 'capturing' && state !== 'held') return 0;
	return Math.min(nFields, Math.floor(gauge * (nFields + 1)));
}

const GLYPHS = '░▒▓█';
export function scramble(text, seed) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		if (text[i] === ' ') { out += ' '; continue; }
		let x = (seed * 374761393 + i * 668265263) >>> 0;
		x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
		out += GLYPHS[(x ^ (x >>> 16)) & 3];
	}
	return out;
}

export function headline(state) {
	if (state === 'capturing') return { word: 'CAPTURING', tone: 'orange' };
	if (state === 'resolved') return { word: 'UPLINKED', tone: 'green' };
	return { word: 'SIGNAL', tone: 'dim' };
}
```

`src/signal-callout.js`:

```js
// The HUD callout (issue #185, spec §4): a leader line from the landmark to a
// mono box, in the FPVTP! OSD — the local layer, which does not cross the
// link, so the callout never degrades with the video. Layout decisions are in
// tools/signal-callout-model.mjs; here there is only DOM. OSM text is written
// with textContent (PR #81).
import { revealCount, scramble, headline } from '../tools/signal-callout-model.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const CELLS = 12;

export class SignalCallout {
	constructor(root) {
		const el = document.createElement('div');
		el.id = 'fo-signal';
		el.hidden = true;
		const svg = document.createElementNS(SVG, 'svg');
		svg.setAttribute('class', 'fo-signal-lead');
		const line = document.createElementNS(SVG, 'line');
		const dot = document.createElementNS(SVG, 'rect');
		dot.setAttribute('width', '8'); dot.setAttribute('height', '8');
		svg.append(line, dot);
		const box = document.createElement('div');
		box.className = 'fo-signal-box';
		const hd = document.createElement('div'); hd.className = 'hd';
		const word = document.createElement('span');
		const dist = document.createElement('span'); dist.className = 'dist';
		hd.append(word, dist);
		const gauge = document.createElement('div'); gauge.className = 'gauge';
		const cells = Array.from({ length: CELLS }, () => gauge.appendChild(document.createElement('i')));
		const rows = document.createElement('div'); rows.className = 'rows';
		box.append(hd, gauge, rows);
		const chev = document.createElement('div');
		chev.className = 'fo-signal-chev';
		chev.hidden = true;
		el.append(svg, box);
		root.append(el, chev);
		Object.assign(this, { el, svg, line, dot, box, word, dist, gauge, cells, rows, chev, _rowsFor: null });
	}

	render(view) {
		if (!view) { this.el.hidden = true; this.chev.hidden = true; return; }
		const { signal, row, placed, now } = view;
		const { word, tone } = headline(row.state);
		if (!placed.onScreen) {
			this.el.hidden = true;
			this.chev.hidden = false;
			this.chev.dataset.tone = tone;
			this.chev.textContent = `SIGNAL ${Math.round(row.dist)} M ▶`;
			this.chev.style.left = `${placed.edge.x}px`;
			this.chev.style.top = `${placed.edge.y}px`;
			this.chev.style.transform = `translate(-50%, -50%) rotate(${placed.edge.angleDeg}deg)`;
			return;
		}
		this.chev.hidden = true;
		this.el.hidden = false;
		this.el.dataset.tone = tone;
		this.line.setAttribute('x1', placed.ax); this.line.setAttribute('y1', placed.ay);
		this.line.setAttribute('x2', placed.bx); this.line.setAttribute('y2', placed.by + 10);
		this.dot.setAttribute('x', placed.ax - 4); this.dot.setAttribute('y', placed.ay - 4);
		this.box.style.left = `${placed.bx}px`;
		this.box.style.top = `${placed.by}px`;
		this.word.textContent = word;
		this.dist.textContent = `${Math.round(row.dist)} M`;
		const lit = Math.round(row.gauge * CELLS);
		this.gauge.hidden = row.state === 'near';
		this.cells.forEach((c, i) => { c.className = i < lit ? 'on' : ''; });
		if (this._rowsFor !== signal.id) {
			this.rows.replaceChildren(...signal.fields.map((f) => {
				const r = document.createElement('div');
				const k = document.createElement('span'); k.className = 'k'; k.textContent = f.label;
				const v = document.createElement('span'); v.className = 'v';
				r.append(k, v);
				return r;
			}));
			this._rowsFor = signal.id;
		}
		const shown = revealCount(signal.fields.length, row.gauge, row.state);
		const seed = Math.floor(now * 8);
		signal.fields.forEach((f, i) => {
			const v = this.rows.children[i].lastChild;
			const clear = i < shown;
			v.textContent = clear ? f.value : scramble(f.value, seed + i);
			v.dataset.clear = String(clear);
		});
	}
}
```

`src/style.css` — next to the `#fpvtp-osd` rules:

```css
#fo-signal { position: absolute; inset: 0; pointer-events: none; }
#fo-signal .fo-signal-lead { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
#fo-signal .fo-signal-lead line { stroke: var(--dim); stroke-width: 1; }
#fo-signal .fo-signal-lead rect { fill: none; stroke: var(--dim); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; transform: rotate(45deg); }
#fo-signal .fo-signal-box {
	position: absolute; min-width: 190px; max-width: 280px;
	padding: var(--space-1) var(--space-2);
	background: rgba(10, 9, 8, .72); border: 1px solid var(--rule-strong);
	font: var(--fs-micro) / 1.5 var(--font-ui); letter-spacing: .06em; color: var(--ink);
}
#fo-signal .hd { display: flex; justify-content: space-between; gap: var(--space-2); font-weight: 500; letter-spacing: var(--track-ui); }
#fo-signal .hd .dist { color: var(--dim); }
#fo-signal .gauge { display: flex; gap: 2px; margin-block: var(--space-1); }
#fo-signal .gauge i { flex: 1; height: 5px; background: var(--grey); }
#fo-signal .rows .k { display: inline-block; width: 7.5em; color: var(--faint); }
#fo-signal .rows .v[data-clear="false"] { color: var(--faint); font-family: var(--font-ascii); }
#fo-signal[data-tone="orange"] .fo-signal-box { border-color: var(--orange); }
#fo-signal[data-tone="orange"] .hd span:first-child, #fo-signal[data-tone="orange"] .gauge i.on { color: var(--orange); background-color: var(--orange); }
#fo-signal[data-tone="orange"] .hd span:first-child { background: none; }
#fo-signal[data-tone="orange"] .fo-signal-lead line, #fo-signal[data-tone="orange"] .fo-signal-lead rect { stroke: var(--orange); }
#fo-signal[data-tone="green"] .fo-signal-box { border-color: var(--green); }
#fo-signal[data-tone="green"] .hd span:first-child { color: var(--green); }
#fo-signal[data-tone="green"] .gauge i.on { background: var(--green); }
#fo-signal[data-tone="green"] .fo-signal-lead line, #fo-signal[data-tone="green"] .fo-signal-lead rect { stroke: var(--green); }
.fo-signal-chev { position: absolute; pointer-events: none; font: 500 var(--fs-micro) var(--font-ui); letter-spacing: .12em; color: var(--dim); white-space: nowrap; }
.fo-signal-chev[data-tone="orange"] { color: var(--orange); }
```

If `tools/palette-selftest.mjs` rejects a value (bare px in `gap`, `height`, `min-width`…), switch to the nearest token (`--space-*`) or the existing pattern it accepts, and say so in the report.

- [ ] **Step 4: Green** — `node tools/signal-callout-selftest.mjs && node tools/palette-selftest.mjs && node -e "import('./src/signal-callout.js').then(m => console.log(typeof m.SignalCallout))"`

- [ ] **Step 5: Commit** — `Signals: the HUD callout — anchored, decrypting, words for labels (#185)`

---

### Task 6: Wire the flight, verify it flying, changelog

**Files:**
- Modify: `src/main.js`, `package.json` (`selftest:operator`: chain `signal-capture`, `signal-anchor`, `signal-store`, `signal-callout` selftests right after `signal-source-selftest`), `../CHANGELOG.md`

**Interfaces:** consumes everything above; `session.current()`, `session.capturePhoto({dataUrl,w,h}) -> count`, `lens.capture() -> {blob,w,h}`, `physics.groundBelow(x, y, z, maxDistance)`, `physics.obstructionBetween(ax..bz) -> {blocked}`, `uiAudio.play('TARGET_FOUND')`, `operator.patch/getOperator`, `droneGeo`, `liveWindow.originEcef/originBasis`, `sceneManifest.origin`.

- [ ] **Step 1: Geo → local.** Next to `droneGeo()` (~l.2058), add its inverse:

```js
// lat/lon -> local ENU {x, z}: the inverse of droneGeo(), for signals (#185).
// Live: through ECEF, like the streaming window. Baked: the inverse of the
// flat latLonOf(). null when the scene has no origin.
function localOfGeo(lat, lon) {
	if (liveWindow) {
		const e = geodeticToEcef(lat, lon, 0);
		const p = ecefToLocalEnu(e, liveWindow.originEcef, liveWindow.originBasis);
		return { x: p.x, z: p.z };
	}
	const o = sceneManifest?.origin;
	if (!o || !Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) return null;
	return { x: (lon - o.longitude) * 111320 * Math.cos(lat * Math.PI / 180), z: -(lat - o.latitude) * 111320 };
}
```

Check `tools/lib/rocktree/geodesy.mjs` for the exact signatures of `geodeticToEcef` and `ecefToLocalEnu` (argument order, degrees vs radians, return shape `{x,y,z}` vs array) and adapt the two calls; add them to the import at l.69. `ecefToLocalEnu` must return the same ENU axes as `physics.position` (X east, Y up, Z south) — verify against how `rocktree-window.js:215-219` uses it and against `localEnuToEcef(p, …)` in `droneGeo`. Write a 3-line check in the report: `localOfGeo(droneGeo(p))` ≈ `p` for a live flight position (evaluate in the browser console during Step 5).

- [ ] **Step 2: Module state.** Near `flightEnd = new FlightEnd()` (~l.694):

```js
import { sharedSignalSource } from './signal-source.js';
import { tilesAround } from '../tools/signal-model.mjs';
import { SignalCapture } from './signal-capture.js';
import { SignalAnchors } from './signal-anchor.js';
import { SignalCallout } from './signal-callout.js';
import { placeCallout } from '../tools/signal-callout-model.mjs';
import { withResolved, resolvedIds } from '../tools/signal-store-model.mjs';
```

(imports go at the top of the file with the others), and near `flightEnd`:

```js
// Signals in flight (#185): the landmarks within FLIGHT_RADIUS_M of the
// take-off point, anchored, captured by holding them in the FPV frame.
const FLIGHT_RADIUS_M = 1500;
const signalCapture = new SignalCapture();
const signalAnchors = new SignalAnchors({
	toLocal: (lat, lon) => localOfGeo(lat, lon),
	ground: (x, z, fromY) => physics?.groundBelow(x, fromY, z, fromY + 200) ?? null,
});
const signalCallout = new SignalCallout(document.getElementById('fpvtp-osd'));
let flightSignals = [];          // Signal[] live in this flight
let offFlightSignals = null;     // unsubscribe from the shared source
let signalHome = null;           // { lat, lon } take-off point
```

- [ ] **Step 3: Arm at spawn, disarm at the end.** Find the single place both baked and live flights reach once the drone is placed and the ENU origin is fixed (the Explore map: origin fixed once at spawn, `main.js:1408` comment; `bootLive()` for live; the scene boot for baked). There, call:

```js
function armSignals() {
	disarmSignals();
	if (MODE.bench) return;
	const home = droneGeo(physics.position);
	if (!Number.isFinite(home.lat) || !Number.isFinite(home.lon)) return;
	signalHome = home;
	const src = sharedSignalSource();
	const refresh = () => {
		const done = resolvedIds(operator.getOperator()?.signals);
		flightSignals = src.signals().filter((s) => distanceM(home, s) <= FLIGHT_RADIUS_M);
		signalAnchors.set(flightSignals);
		signalCapture.setTargets(flightSignals.map((s) => ({ id: s.id, tier: s.tier, pos: null, resolved: done.has(s.id) })));
	};
	offFlightSignals = src.subscribe(refresh);
	src.request(tilesAround(home.lat, home.lon, FLIGHT_RADIUS_M));
	refresh();
}
function disarmSignals() {
	offFlightSignals?.();
	offFlightSignals = null;
	flightSignals = [];
	signalAnchors.set([]);
	signalCapture.setTargets([]);
	signalCallout.render(null);
}
```

(import `distanceM` from `../tools/signal-model.mjs` too.) Call `disarmSignals()` wherever the flight is torn down (session finish / back to terminal — the same place the OSD is hidden, `fpvtpOsd.setSessionStatus(null)` ~l.1895 is a hint).

- [ ] **Step 4: Per frame.** In `frame()`, right before `flightEnd.update(...)` (~l.2473), after the physics/crash block:

```js
	if (flightSignals.length) {
		signalAnchors.update(frozen ? 0 : dt);
		const targets = flightSignals.map((s) => ({ id: s.id, tier: s.tier, pos: signalAnchors.pos(s.id) }));
		// positions change as anchors resolve; resolved flags are kept inside
		for (const t of targets) t.resolved = false;
		signalCapture.setTargets(targets);
		_sigFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
		const cam = { x: camera.position.x, y: camera.position.y, z: camera.position.z, fx: _sigFwd.x, fy: _sigFwd.y, fz: _sigFwd.z };
		const out = signalCapture.update({
			dt: frozen || flightEnd.phase !== FLYING ? 0 : dt,
			cam,
			fpv: viewMode === 'fpv',
			// Stop the line 6 m short of the anchor: the anchor sits on the
			// building's own surface, which would otherwise always "block" it.
			los: (t) => {
				const dx = t.pos.x - cam.x, dy = t.pos.y - cam.y, dz = t.pos.z - cam.z;
				const d = Math.hypot(dx, dy, dz), k = Math.max(0, (d - 6) / d);
				return !physics.obstructionBetween(cam.x, cam.y, cam.z, cam.x + dx * k, cam.y + dy * k, cam.z + dz * k).blocked;
			},
		});
		if (out.uplinked) onSignalUplinked(out.uplinked);
		renderSignalCallout(out);
	}
```

`SignalCapture.setTargets` keeps its own resolved set (Task 2: `setTargets` only ADDS resolved ids from the list, `markResolved` too), so passing `resolved: false` every frame does not un-resolve anything. Declare `const _sigFwd = new THREE.Vector3();` near `_fwd` (~l.1988).

```js
function renderSignalCallout(out) {
	// The callout follows the focus; without one, the nearest shown signal.
	const rows = out.rows.filter((r) => r.state !== 'hidden');
	const row = rows.find((r) => r.id === out.focus) ?? rows.sort((a, b) => a.dist - b.dist)[0];
	if (!row) { signalCallout.render(null); return; }
	const signal = flightSignals.find((s) => s.id === row.id);
	const pos = signalAnchors.pos(row.id);
	if (!signal || !pos) { signalCallout.render(null); return; }
	_sigNdc.set(pos.x, pos.y, pos.z).project(camera);
	const behind = _sigNdc.z > 1;
	const vp = renderer.domElement.getBoundingClientRect();
	const placed = placeCallout({ ndcX: _sigNdc.x, ndcY: _sigNdc.y, behind }, { w: vp.width, h: vp.height }, {});
	signalCallout.render({ signal, row, placed, now: performance.now() / 1000 });
}
```

(`const _sigNdc = new THREE.Vector3();` next to `_sigFwd`.)

```js
async function onSignalUplinked(id) {
	const s = flightSignals.find((x) => x.id === id);
	if (!s) return;
	uiAudio.play('TARGET_FOUND');
	const pos = signalAnchors.pos(id);
	const dist = pos ? Math.hypot(pos.x - camera.position.x, pos.y - camera.position.y, pos.z - camera.position.z) : 0;
	let photo = null;
	const live = session.current();
	if (live) {
		const cap = await lens.capture();
		if (cap) {
			const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(cap.blob); });
			const count = await session.capturePhoto({ dataUrl, w: cap.w, h: cap.h });
			if (count > 0) photo = count - 1;
			fpvtpOsd.flashCaptured(count);
		}
	}
	const op = operator.getOperator();
	if (op) {
		operator.patch('signals', withResolved(op.signals, id, {
			at: Date.now(), name: s.name, lat: s.lat, lon: s.lon, tier: s.tier,
			family: PROFILE?.family ?? null, holdS: 6, distM: Math.round(dist),
			sessionId: live?.id ?? null, photo,
		}));
	}
}
```

Adapt `PROFILE?.family` to however main.js names the current airframe family (grep `family` near the TARGET SCAN / `setProfile`), and `live?.id` to the session's id field (`session.current()` returns the session object — check its id key in `tools/session-model.mjs` `openSession`). `holdS` is `HOLD_S` from `signal-capture.js` (import it rather than writing 6).

- [ ] **Step 5: Fly it (browser).** `npm run dev` (background), Chrome via the chrome-devtools MCP in an isolated context. Physical gamepads on this machine drift and drive the menus — stub them first with `evaluate_script`: `navigator.getGamepads = () => []`. Path: scanner → LIVE → pin on Paris (Les Invalides, 48.8566, 2.3125) → TARGET SCAN → hack → fly. Check, with screenshots in the report:
  1. A callout appears on a landmark within ~400 m (e.g. the Invalides dome), anchored on it (not at ground level once the tiles are in).
  2. Turning away shows the edge chevron.
  3. Holding it in the FPV frame fills the orange gauge and decrypts fields one by one; 6 s later `UPLINKED`, green, the TARGET_FOUND cue, the photo flash.
  4. Chase view: the gauge does not rise.
  5. Back on the scanner: that landmark is green, status `· 1 RESOLVED`.
  6. Console: no errors; `localOfGeo(droneGeo(p))` ≈ `p`.
  Flying manually through the MCP may be impractical; if so, drive it from the console: after take-off, set the drone pose next to the landmark (look for the existing debug/teleport or `physics` pose setter; if none, report steps 1-4 as NOT RUN rather than inventing a hook) — and say exactly which steps were observed.

- [ ] **Step 6: Changelog** — under `## [Non publié]` → `### Ajouté`, after the lot 1 entry:

```markdown
- **Capturer un signal en vol.** Autour du point de décollage, chaque lieu
  notable porte un cartouche ancré sur le bâtiment réel. Le garder dans le
  cadre en FPV remplit une jauge et déchiffre ses champs OpenStreetMap un à un ;
  à 100 %, `UPLINKED` : l'image interceptée rejoint les photos de la session,
  et le lieu passe au vert sur le scanner. Un crash ne perd que ce qui n'était
  pas encore transmis. Deuxième lot de #185.
```

- [ ] **Step 7: Chain selftests, commit** — `package.json` as above; run all new selftests plus `scanner`, `palette`, `server`, `session-api`. Commit `Signals: capture in flight — the callout, the gauge, UPLINKED, green on the map (#185)`.

## Out of scope (recorded)

- The capture calibration tool that replays flight tracks per family (spec §3): the constants stay the spec's starting points until it exists.
- DOSSIER, clearance, the draw pool, the Commons reference photo, the Bible section: lot 3.
- A dedicated `UPLINKED` cue: `TARGET_FOUND` is reused (the UI sound vocabulary is closed on purpose).
