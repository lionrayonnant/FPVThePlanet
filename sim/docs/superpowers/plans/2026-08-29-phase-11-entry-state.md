# PHASE 11 — Entry State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `JACK IN` (and after every in-session respawn), the drone starts already in flight — never posed, never hovering neutral — drawn from a weighted category (COMFORTABLE 60% / ACTIVE 25% / CHALLENGING 12% / HOLY_SHIT 3%), with a safety net that never lets a spawn crash within one second before the player can react.

**Architecture:** A new module `src/entry-state.js` samples a candidate spawn (position anywhere in the scene's bbox, altitude/speed/attitude/rotation ranges keyed by category) and validates it two ways before accepting: geometric checks reusing `Physics.groundBelow`/`obstructionBetween`, then a 1-second headless physics rollout (neutral acro sticks, hover throttle) reusing the real `Physics`/`FlightController` — no second physics engine. `main.js` calls it at session open and on every respawn instead of `physics.reset()`. Failed candidates retry up to 20 times, then fall back to the pre-existing fixed spawn.

**Tech Stack:** Vanilla JS (ES modules), `@dimforge/rapier3d-compat` (already a dependency, no new one), Node for headless selftest scripts — same as the rest of `sim/`.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-11-entry-state-design.md`

## Global Constraints

- No new dependency. Reuse `Physics`, `FlightController`, `quad.js` exactly as they exist — the rollout is not a second physics model.
- The state the player experiences is always the candidate's **initial** sampled state, never the state after the validation rollout.
- Distribution: COMFORTABLE 60 / ACTIVE 25 / CHALLENGING 12 / HOLY_SHIT 3 (percentages), tolerance ±3 points when measured over a large sample.
- `src/entry-state.js` runs both in the browser (bundled by Vite) and in Node (selftest) — no browser-only API, no `node:` import.
- Follow existing repo idioms exactly: the seeded RNG is the FNV-1a→xorshift generator already used in `tools/target-model.mjs` and `src/link.js`; the crash-threshold logic already exists in `src/main.js` and must be extracted, not reimplemented.
- `npm run selftest` and `npm run selftest:operator` must stay green throughout — run them after every task.

---

### Task 1: Extract the crash threshold into `src/quad.js`

The crash-force threshold (used today only by `main.js`'s own crash detection) needs to be reused by the new rollout's crash check. Extract it once, use it in both places — no duplicated formula.

**Files:**
- Modify: `sim/src/quad.js` (add exports near the top, after `HOVER_THRUST`)
- Modify: `sim/src/main.js:40-43` (remove local constants), `sim/src/main.js:617-621` (use the shared helper)
- Test: `sim/tools/selftest.mjs` (new checks, appended before the final summary)

**Interfaces:**
- Produces: `CRASH_IMPULSE` (number, 1500), `CRASH_IMPULSE_FLAT` (number, 2800), `crashThreshold(rotation: {x,y,z,w}) → number` — all exported from `src/quad.js`. `rotation` is a Rapier quaternion-shaped plain object (as returned by `Physics.rotation`).

- [ ] **Step 1: Add the exports to `src/quad.js`**

Open `sim/src/quad.js`. Right after this existing block (around line 23-24):

```js
export function hoverThrust(profile = QUAD) { return profile.mass * GRAVITY; }
export const HOVER_THRUST = hoverThrust(QUAD);
```

insert:

```js

// Measured contact forces: gentle landing ~290N, 10 m/s touchdown ~1600N,
// 25 m/s into a building ~2450N. 1500 lets you land and bump walls, but calls
// slamming into something a crash.
export const CRASH_IMPULSE = 1500;
// Arrivée à plat (ventre vers le sol) : les bras et les hélices encaissent, il
// faut nettement plus pour casser. ~16 m/s de descente verticale passent.
export const CRASH_IMPULSE_FLAT = 2800;

// Un drone qui arrive à plat encaisse : bras et hélices absorbent. Nez en avant
// ou sur le dos, il casse plus facilement — le seuil suit donc l'assiette au
// moment du choc (upY proche de 1 = plat/dessus, proche de -1 = inversé).
export function crashThreshold(rotation) {
	const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
	return upY > 0.4 ? CRASH_IMPULSE_FLAT : CRASH_IMPULSE;
}
```

- [ ] **Step 2: Use the shared helper in `src/main.js`**

In `sim/src/main.js`, remove these two constants (lines 40-43):

```js
// Measured contact forces: gentle landing ~290N, 10 m/s touchdown ~1600N,
// 25 m/s into a building ~2450N. 1500 lets you land and bump walls, but calls
// slamming into something a crash.
const CRASH_IMPULSE = 1500;
// Arrivée à plat (ventre vers le sol) : les bras et les hélices encaissent, il
// faut nettement plus pour casser. ~16 m/s de descente verticale passent.
const CRASH_IMPULSE_FLAT = 2800;
```

Add `crashThreshold` to the existing `./physics.js` import line's neighbor — add a new import line right after the `import { initPhysics, Physics } from './physics.js';` line:

```js
import { crashThreshold } from './quad.js';
```

Then in the crash-detection block (around line 617-621), replace:

```js
			if (impact > 0 && !crashed) {
				const r = physics.rotation;
				const upright = (1 - 2 * (r.x * r.x + r.z * r.z)) > 0.4;
				if (impact > (upright ? CRASH_IMPULSE_FLAT : CRASH_IMPULSE)) {
```

with:

```js
			if (impact > 0 && !crashed) {
				if (impact > crashThreshold(physics.rotation)) {
```

- [ ] **Step 3: Add regression checks to `tools/selftest.mjs`**

Open `sim/tools/selftest.mjs`. Add `crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT` to the imports — change:

```js
import { generateTargetScan, resolveTarget } from './target-model.mjs';
```

to:

```js
import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT } from '../src/quad.js';
```

Right before the final two lines of the file:

```js
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

insert:

```js
console.log('\ncrash threshold');
check('upright/flat rotation uses the flat threshold', crashThreshold({ x: 0, y: 0, z: 0, w: 1 }) === CRASH_IMPULSE_FLAT);
check('nose-down rotation uses the tighter threshold',
	crashThreshold({ x: 0.8, y: 0, z: 0, w: Math.sqrt(1 - 0.8 * 0.8) }) === CRASH_IMPULSE);
```

- [ ] **Step 4: Run the selftest and confirm it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed` (same pass count as before, plus the two new PASS lines under "crash threshold").

- [ ] **Step 5: Commit**

```bash
cd sim && git add src/quad.js src/main.js tools/selftest.mjs
git commit -m "Extraire le seuil de crash dans quad.js, réutilisable hors main.js"
```

---

### Task 2: Export `hoverThrottle` from `src/flightController.js`

The entry-state rollout needs "what throttle roughly cancels gravity at the current tilt" — that function already exists privately in `flightController.js`. Export it rather than reimplementing the thrust-curve inversion a third time (one copy already exists, independently, as `hoverStick` in `tools/selftest.mjs`).

**Files:**
- Modify: `sim/src/flightController.js:366` (add `export`)
- Test: `sim/tools/selftest.mjs` (new check)

**Interfaces:**
- Produces: `hoverThrottle(profile, quaternion: {x,y,z,w}) → number` (0..1), exported from `src/flightController.js`. Already used internally by the same file's `update()` for `altitude` mode — unaffected.

- [ ] **Step 1: Add the export**

In `sim/src/flightController.js`, change (line 366):

```js
function hoverThrottle(profile, q) {
```

to:

```js
export function hoverThrottle(profile, q) {
```

- [ ] **Step 2: Add a cross-check in `tools/selftest.mjs`**

`tools/selftest.mjs` already computes an equivalent value independently as `hoverStick` (a local function near the top of the file, identity attitude only). Add an import and a check that the two agree for the identity attitude, which pins down that the export didn't change behaviour.

Change:

```js
import { crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT } from '../src/quad.js';
```

to:

```js
import { crashThreshold, CRASH_IMPULSE, CRASH_IMPULSE_FLAT } from '../src/quad.js';
import { hoverThrottle } from '../src/flightController.js';
```

In the new `'\ncrash threshold'` section added in Task 1, append:

```js
check('hoverThrottle(profile, identity) matches the local hoverStick reference',
	Math.abs(hoverThrottle(QUAD, { x: 0, y: 0, z: 0, w: 1 }) - hoverStick(QUAD)) < 1e-9);
```

- [ ] **Step 3: Run the selftest and confirm it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 4: Commit**

```bash
cd sim && git add src/flightController.js tools/selftest.mjs
git commit -m "Exporter hoverThrottle pour le rollout de l'entry state"
```

---

### Task 3: `Physics.applyEntryState()`

**Files:**
- Modify: `sim/src/physics.js` (new method, right after `reset()`)
- Test: `sim/tools/selftest.mjs` (new section)

**Interfaces:**
- Consumes: nothing new — uses `this.body`, `this.propulsion`, `this.wind` already on the instance.
- Produces: `Physics.prototype.applyEntryState({ position, quaternion, linvel, angvel })` — sets the body's kinematic state and clears propulsion/wind/ground-hold exactly like `reset()` does, but to caller-supplied position/rotation/velocities instead of `this.spawn`/identity/zero.

- [ ] **Step 1: Add the method**

In `sim/src/physics.js`, right after the closing brace of `reset()` (the method that currently reads):

```js
	reset() {
		this.body.setTranslation(this.spawn, true);
		this.body.setRotation(IDENTITY, true);
		this.body.setLinvel(ZERO, true);
		this.body.setAngvel(ZERO, true);
		this.propulsion.reset();
		this.wind.reset();
		this._agl = null;
		this._aglCounter = 0;
		this._windCounter = 6;
		this._probed = false;
		this._groundHold = false;
		this.airspeed = 0;
	}
```

insert:

```js

	// Like reset(), but to an arbitrary kinematic state instead of this.spawn /
	// identity / zero — used by the PHASE 11 entry-state generator so a session
	// can start (or a respawn can land) already in flight. this.spawn itself is
	// untouched: it stays the ground station's fixed position (see main.js's
	// `emitter`), independent of where a flight actually begins.
	applyEntryState({ position, quaternion, linvel, angvel }) {
		this.body.setTranslation(position, true);
		this.body.setRotation(quaternion, true);
		this.body.setLinvel(linvel, true);
		this.body.setAngvel(angvel, true);
		this.propulsion.reset();
		this.wind.reset();
		this._agl = null;
		this._aglCounter = 0;
		this._windCounter = 6;
		this._probed = false;
		this._groundHold = false;
		this.airspeed = 0;
	}
```

- [ ] **Step 2: Add checks to `tools/selftest.mjs`**

Add a new section right before the final summary lines (after the "crash threshold" section added in Tasks 1-2):

```js
console.log('\napplyEntryState');
{
	phys.setProfile(QUAD);
	const state = {
		position: { x: 10, y: 50, z: -20 },
		quaternion: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 }, // 45° yaw
		linvel: { x: 3, y: -1, z: 2 },
		angvel: { x: 0, y: 0, z: 1.5 },
	};
	phys.applyEntryState(state);
	const p = phys.position, r = phys.rotation, v = phys.velocity, w = phys.angularVelocity;
	check('position applied', Math.hypot(p.x - state.position.x, p.y - state.position.y, p.z - state.position.z) < 1e-6);
	check('rotation applied', Math.abs(r.w - state.quaternion.w) < 1e-6 && Math.abs(r.z - state.quaternion.z) < 1e-6);
	check('linear velocity applied', Math.hypot(v.x - state.linvel.x, v.y - state.linvel.y, v.z - state.linvel.z) < 1e-6);
	check('angular velocity applied', Math.abs(w.z - state.angvel.z) < 1e-6);
	check('battery reset to full', phys.battery.soc === 1);
	phys.reset();
}
```

- [ ] **Step 3: Run the selftest and confirm it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 4: Commit**

```bash
cd sim && git add src/physics.js tools/selftest.mjs
git commit -m "Physics.applyEntryState() — spawn à un état cinématique arbitraire"
```

---

### Task 4: `src/entry-state.js` — `pickCategory` (pure) + its selftest

The category draw needs no scene and no physics — it is pure, like `tools/target-model.mjs`. Give it its own tiny pure selftest file, chained into `selftest:operator` (which already runs every scene-independent check).

**Files:**
- Create: `sim/src/entry-state.js`
- Create: `sim/tools/entry-state-selftest.mjs`
- Modify: `sim/package.json` (`selftest:operator` script)

**Interfaces:**
- Produces: `CATEGORIES` (array of 4 strings), `WEIGHTS` (array of 4 numbers summing to 100), `rngFrom(seed) → () => number in [0,1)`, `pickCategory(rand: () => number) → one of CATEGORIES`.

- [ ] **Step 1: Write the failing test**

Create `sim/tools/entry-state-selftest.mjs`:

```js
// Checks for src/entry-state.js that need no scene/physics — the category
// draw only. The scene-dependent parts (sampleCandidate, geometrySafe,
// rolloutSafe, generateEntryState) are checked in tools/selftest.mjs, which
// already loads a real Physics instance for a real scene.
//
//   node tools/entry-state-selftest.mjs

import { CATEGORIES, WEIGHTS, rngFrom, pickCategory } from '../src/entry-state.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('entry-state: category draw');

check('weights sum to 100', WEIGHTS.reduce((a, b) => a + b, 0) === 100);
check('one weight per category', WEIGHTS.length === CATEGORIES.length);

{
	const rand = rngFrom('same-seed');
	const rand2 = rngFrom('same-seed');
	const seq1 = [rand(), rand(), rand()];
	const seq2 = [rand2(), rand2(), rand2()];
	check('same seed reproduces the same draw sequence', seq1.every((v, i) => v === seq2[i]));
}

{
	const rand = rngFrom('distribution-check');
	const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
	const N = 20000;
	for (let i = 0; i < N; i++) counts[pickCategory(rand)]++;
	for (let i = 0; i < CATEGORIES.length; i++) {
		const cat = CATEGORIES[i];
		const pct = (counts[cat] / N) * 100;
		check(`${cat} lands within ±3 points of ${WEIGHTS[i]}%`, Math.abs(pct - WEIGHTS[i]) <= 3,
			`measured ${pct.toFixed(1)}%`);
	}
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sim && node tools/entry-state-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/entry-state.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write `src/entry-state.js` (category draw only for now)**

Create `sim/src/entry-state.js`:

```js
// PHASE 11 — Entry State. After JACK IN (and after every in-session respawn)
// the drone starts already in flight: a weighted category picks how gentle or
// hairy that moment is, a candidate is sampled anywhere in the scene, and two
// safety nets (geometry, then a headless physics rollout) reject anything
// that would crash before the player can touch a stick. See
// docs/superpowers/specs/2026-08-29-phase-11-entry-state-design.md.
//
// Runs both in the browser (bundled by Vite) and in Node (selftest) — no
// browser-only API, no `node:` import.

export const CATEGORIES = ['COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const WEIGHTS = [60, 25, 12, 3];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
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

export function pickCategory(rand) {
	const r = rand() * 100;
	let acc = 0;
	for (let i = 0; i < CATEGORIES.length; i++) {
		acc += WEIGHTS[i];
		if (r < acc) return CATEGORIES[i];
	}
	return CATEGORIES[CATEGORIES.length - 1];
}
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd sim && node tools/entry-state-selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 5: Chain it into `npm run selftest:operator`**

In `sim/package.json`, change:

```json
    "selftest:operator": "node tools/operator-selftest.mjs && node tools/terminal-selftest.mjs && node tools/scanner-selftest.mjs && node tools/rtc-selftest.mjs && node tools/weather-selftest.mjs && node tools/session-selftest.mjs && node tools/target-selftest.mjs && node tools/hack-selftest.mjs && node tools/session-route-selftest.mjs && node src/operator.selftest.mjs",
```

to (appending the new script at the end):

```json
    "selftest:operator": "node tools/operator-selftest.mjs && node tools/terminal-selftest.mjs && node tools/scanner-selftest.mjs && node tools/rtc-selftest.mjs && node tools/weather-selftest.mjs && node tools/session-selftest.mjs && node tools/target-selftest.mjs && node tools/hack-selftest.mjs && node tools/session-route-selftest.mjs && node src/operator.selftest.mjs && node tools/entry-state-selftest.mjs",
```

- [ ] **Step 6: Run the full chain to verify it passes**

Run: `cd sim && npm run selftest:operator`
Expected: every step prints its own `all checks passed`, command exits 0.

- [ ] **Step 7: Commit**

```bash
cd sim && git add src/entry-state.js tools/entry-state-selftest.mjs package.json
git commit -m "Entry state : tirage de catégorie pondéré (PHASE 11)"
```

---

### Task 5: `sampleCandidate` — position, attitude, velocity from a category

**Files:**
- Modify: `sim/src/entry-state.js` (add `RANGES`, quaternion helpers, `sampleCandidate`)
- Test: `sim/tools/selftest.mjs` (new section, needs a real scene + `Physics`)

**Interfaces:**
- Consumes: `CATEGORIES`, `WEIGHTS`, `rngFrom` (Task 4); `Physics.groundBelow(x, y, z, maxDistance)` (existing).
- Produces: `RANGES` (object keyed by category → `{ aglM, speedMs, tiltDeg, rateDps }`, each a `[lo, hi]` pair); `sampleCandidate(category, manifest, physics, rand) → Candidate | null` where `Candidate = { category, position: {x,y,z}, quaternion: {x,y,z,w}, linvel: {x,y,z}, angvel: {x,y,z} }`. `manifest` is the scene manifest object (needs `.bbox.min`/`.bbox.max`, each `[x,y,z]`).

- [ ] **Step 1: Write the failing test**

Open `sim/tools/selftest.mjs`. Add the import (alongside the ones added in earlier tasks):

```js
import { CATEGORIES, RANGES, sampleCandidate, rngFrom } from '../src/entry-state.js';
```

Add a new section right before the final summary lines:

```js
console.log('\nentry state — sampleCandidate');
{
	phys.setProfile(QUAD);
	const rand = rngFrom('sample-candidate-check');
	for (const category of CATEGORIES) {
		const c = sampleCandidate(category, manifest, phys, rand);
		check(`${category}: produced a candidate inside the scene bbox`,
			c !== null
			&& c.position.x >= manifest.bbox.min[0] && c.position.x <= manifest.bbox.max[0]
			&& c.position.z >= manifest.bbox.min[2] && c.position.z <= manifest.bbox.max[2]);
		if (!c) continue;
		const ground = phys.groundBelow(c.position.x, c.position.y, c.position.z);
		const agl = ground === null ? null : c.position.y - ground;
		const [loAgl, hiAgl] = RANGES[category].aglM;
		check(`${category}: altitude above ground within its range`,
			agl !== null && agl >= loAgl - 1e-6 && agl <= hiAgl + 1e-6, `agl=${agl?.toFixed(2)}`);
		const speed = Math.hypot(c.linvel.x, c.linvel.y, c.linvel.z);
		const [loSpeed, hiSpeed] = RANGES[category].speedMs;
		check(`${category}: speed within its range`, speed >= loSpeed - 1e-6 && speed <= hiSpeed + 1e-6,
			`${speed.toFixed(1)} m/s`);
		const qLenSq = c.quaternion.x ** 2 + c.quaternion.y ** 2 + c.quaternion.z ** 2 + c.quaternion.w ** 2;
		check(`${category}: quaternion is normalised`, Math.abs(qLenSq - 1) < 1e-6);
	}
	phys.reset();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `sampleCandidate is not a function` / `RANGES is not exported` (the file doesn't have them yet).

- [ ] **Step 3: Implement `sampleCandidate` in `src/entry-state.js`**

Append to `sim/src/entry-state.js`:

```js

const DEG = Math.PI / 180;

// Starting points, hand-picked like target-model.mjs's proportions — not
// measured, tunable to feel without touching the safety net (geometrySafe /
// rolloutSafe are what actually keep every draw fair).
export const RANGES = {
	COMFORTABLE: { aglM: [15, 40], speedMs: [2, 8], tiltDeg: [0, 10], rateDps: [0, 30] },
	ACTIVE: { aglM: [8, 25], speedMs: [8, 18], tiltDeg: [5, 25], rateDps: [20, 90] },
	CHALLENGING: { aglM: [3, 12], speedMs: [18, 30], tiltDeg: [20, 50], rateDps: [60, 200] },
	HOLY_SHIT: { aglM: [1.5, 5], speedMs: [25, 40], tiltDeg: [40, 80], rateDps: [150, 400] },
};

// How far past the bbox edge sampling stays away from, so a draw never lands
// past the last chunk actually loaded.
const EDGE_MARGIN = 10;

function lerp(rand, [lo, hi]) { return lo + rand() * (hi - lo); }

function qAxisAngle(axis, angle) {
	const s = Math.sin(angle / 2);
	return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

function qMul(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

// Local copy of flightController.js's rotate(): body-frame convention X=right,
// Y=up, Z=back (forward is -Z). No shared import — this file has no
// dependency on flightController.js beyond what rolloutSafe needs later.
function qRotateVec(q, v) {
	const tx = 2 * (q.y * v.z - q.z * v.y);
	const ty = 2 * (q.z * v.x - q.x * v.z);
	const tz = 2 * (q.x * v.y - q.y * v.x);
	return {
		x: v.x + q.w * tx + (q.y * tz - q.z * ty),
		y: v.y + q.w * ty + (q.z * tx - q.x * tz),
		z: v.z + q.w * tz + (q.x * ty - q.y * tx),
	};
}

const Y_AXIS = { x: 0, y: 1, z: 0 };
const X_AXIS = { x: 1, y: 0, z: 0 };
const Z_AXIS = { x: 0, y: 0, z: 1 };

// Height of the ground at an (x, z) with no prior y guess: cast from above the
// whole loaded scene downward, all the way to below it.
function groundAt(physics, manifest, x, z) {
	const top = manifest.bbox.max[1] + 50;
	const span = (manifest.bbox.max[1] - manifest.bbox.min[1]) + 100;
	return physics.groundBelow(x, top, z, span);
}

export function sampleCandidate(category, manifest, physics, rand) {
	const ranges = RANGES[category];
	const x = lerp(rand, [manifest.bbox.min[0] + EDGE_MARGIN, manifest.bbox.max[0] - EDGE_MARGIN]);
	const z = lerp(rand, [manifest.bbox.min[2] + EDGE_MARGIN, manifest.bbox.max[2] - EDGE_MARGIN]);
	const ground = groundAt(physics, manifest, x, z);
	if (ground === null) return null;
	const y = ground + lerp(rand, ranges.aglM);

	const heading = rand() * Math.PI * 2;
	const tilt = lerp(rand, ranges.tiltDeg) * DEG;
	const tiltSplit = rand();
	const pitch = tilt * tiltSplit * (rand() < 0.5 ? -1 : 1);
	const roll = tilt * (1 - tiltSplit) * (rand() < 0.5 ? -1 : 1);

	const qYaw = qAxisAngle(Y_AXIS, heading);
	const qPitch = qAxisAngle(X_AXIS, pitch);
	const qRoll = qAxisAngle(Z_AXIS, roll);
	const qYawPitch = qMul(qYaw, qPitch);
	const quaternion = qMul(qYawPitch, qRoll);

	// Velocity follows heading+pitch (where the nose points), not the roll bank
	// on top of it — banking turns the drone without turning its velocity.
	const forward = qRotateVec(qYawPitch, { x: 0, y: 0, z: -1 });
	const speed = lerp(rand, ranges.speedMs);
	const linvel = { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed };

	// Body-frame rate split across the three axes, converted to world frame —
	// Physics.step()/Rapier expect angvel in world frame (see physics.js).
	const rateMag = lerp(rand, ranges.rateDps) * DEG;
	const split1 = rand(), split2 = rand();
	const bodyRate = {
		x: rateMag * split1 * (rand() < 0.5 ? -1 : 1),
		y: rateMag * (1 - split1) * split2 * (rand() < 0.5 ? -1 : 1),
		z: rateMag * (1 - split1) * (1 - split2) * (rand() < 0.5 ? -1 : 1),
	};
	const angvel = qRotateVec(quaternion, bodyRate);

	return { category, position: { x, y, z }, quaternion, linvel, angvel };
}
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
cd sim && git add src/entry-state.js tools/selftest.mjs
git commit -m "Entry state : sampleCandidate (position, assiette, vitesse par catégorie)"
```

---

### Task 6: `geometrySafe`

**Files:**
- Modify: `sim/src/entry-state.js` (add `geometrySafe`)
- Test: `sim/tools/selftest.mjs` (extend the "entry state" section)

**Interfaces:**
- Consumes: `Physics.groundBelow`, `Physics.obstructionBetween` (existing); a `Candidate` as produced by `sampleCandidate` (Task 5).
- Produces: `geometrySafe(candidate, physics) → boolean`.

- [ ] **Step 1: Write the failing test**

In `sim/tools/selftest.mjs`, change the import added in Task 5:

```js
import { CATEGORIES, RANGES, sampleCandidate, rngFrom } from '../src/entry-state.js';
```

to:

```js
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rngFrom } from '../src/entry-state.js';
```

Append to the `'\nentry state — sampleCandidate'` section (still inside the same block, after the per-category loop, before `phys.reset();`):

```js
	// A candidate sitting exactly on the ground (no clearance) must fail; the
	// same candidate lifted well clear of everything must pass.
	const onFloor = sampleCandidate('COMFORTABLE', manifest, phys, rand);
	const buried = { ...onFloor, position: { ...onFloor.position, y: onFloor.position.y - 1e3 } };
	check('geometrySafe rejects a position far under the terrain', geometrySafe(buried, phys) === false);
	check('geometrySafe accepts a normally-sampled COMFORTABLE candidate', geometrySafe(onFloor, phys) === true);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `geometrySafe is not a function`.

- [ ] **Step 3: Implement `geometrySafe`**

Append to `sim/src/entry-state.js`:

```js

// How far ahead along the velocity direction the obstruction check looks, and
// how much of that stretch may legitimately be "material" (a roof edge
// clipped tangentially) before it counts as a wall in the way.
const LOOKAHEAD_M = 15;
const BLOCK_SPAN_M = 2;

export function geometrySafe(candidate, physics) {
	const { position, linvel } = candidate;
	const ground = physics.groundBelow(position.x, position.y, position.z);
	if (ground === null || position.y - ground < 1) return false;

	const speed = Math.hypot(linvel.x, linvel.y, linvel.z);
	if (speed < 1e-6) return true;
	const dir = { x: linvel.x / speed, y: linvel.y / speed, z: linvel.z / speed };
	const ahead = {
		x: position.x + dir.x * LOOKAHEAD_M,
		y: position.y + dir.y * LOOKAHEAD_M,
		z: position.z + dir.z * LOOKAHEAD_M,
	};
	const o = physics.obstructionBetween(position.x, position.y, position.z, ahead.x, ahead.y, ahead.z);
	if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	return true;
}
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
cd sim && git add src/entry-state.js tools/selftest.mjs
git commit -m "Entry state : geometrySafe (sol, obstruction devant la trajectoire)"
```

---

### Task 7: `rolloutSafe`

**Files:**
- Modify: `sim/src/entry-state.js` (add `rolloutSafe`)
- Test: `sim/tools/selftest.mjs` (extend the "entry state" section)

**Interfaces:**
- Consumes: `Physics.applyEntryState` (Task 3), `hoverThrottle` (Task 2), `crashThreshold` (Task 1), `FlightController` (existing).
- Produces: `rolloutSafe(candidate, physics) → boolean`. Leaves `physics`'s body at whatever the rollout's last step landed on, **not** at `candidate`'s initial state — `generateEntryState` (Task 8) itself just returns the accepted `candidate` unchanged; it is `main.js` (Task 9) that must call `physics.applyEntryState(result)` on whatever `generateEntryState` returns before the player sees anything, which is what actually re-establishes the initial state and discards the rollout's simulated second. Without that final call, the player would see the post-rollout state instead of the sampled one.

- [ ] **Step 1: Write the failing test**

In `sim/tools/selftest.mjs`, change the import from Task 6:

```js
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rngFrom } from '../src/entry-state.js';
```

to:

```js
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rolloutSafe, rngFrom } from '../src/entry-state.js';
```

Append to the entry-state section, still before `phys.reset();`:

```js
	// A HOLY_SHIT candidate close to the ground, pointed straight down, must
	// fail the rollout even though geometrySafe alone might pass it (it only
	// looks at the instant of spawn, not one second of unattended flight).
	const divingIntoGround = {
		category: 'HOLY_SHIT',
		position: { x: onFloor.position.x, y: onFloor.position.y + 3, z: onFloor.position.z },
		quaternion: { x: 0.7071068, y: 0, z: 0, w: 0.7071068 }, // pitched straight down
		linvel: { x: 0, y: -30, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
	check('rolloutSafe rejects a fast dive straight into the ground', rolloutSafe(divingIntoGround, phys) === false);
	check('rolloutSafe accepts a normally-sampled COMFORTABLE candidate', rolloutSafe(onFloor, phys) === true);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `rolloutSafe is not a function`.

- [ ] **Step 3: Implement `rolloutSafe`**

Append to `sim/src/entry-state.js`:

```js

const NEUTRAL_STICKS = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
const ROLLOUT_SECONDS = 1.0;

// Validates a candidate by living one second with it, unattended: sticks
// neutral, throttle held at whatever cancels gravity at the current tilt (a
// drone "already in flight" is already near its own trim, not at the
// throttle floor — see the design doc's decision on this). If a contact
// force ever exceeds the game's own crash threshold during that second, the
// candidate is rejected. Reuses the real Physics/FlightController — no
// second physics model.
export function rolloutSafe(candidate, physics) {
	physics.applyEntryState(candidate);
	const profile = physics.profile;
	const controller = new FlightController({ profile });
	controller.setMode('acro');
	const dt = physics.world.timestep;
	const steps = Math.round(ROLLOUT_SECONDS / dt);
	const sticks = { ...NEUTRAL_STICKS };
	for (let i = 0; i < steps; i++) {
		sticks.throttle = hoverThrottle(profile, physics.rotation);
		const { motors } = controller.update(sticks, physics, dt);
		const impact = physics.step(motors, dt);
		if (impact > 0 && impact > crashThreshold(physics.rotation)) return false;
	}
	return true;
}
```

Add these two import lines at the very top of `sim/src/entry-state.js`, above the `export const CATEGORIES` line — this is the first task that needs any imports in this file:

```js
import { FlightController, hoverThrottle } from './flightController.js';
import { crashThreshold } from './quad.js';
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
cd sim && git add src/entry-state.js tools/selftest.mjs
git commit -m "Entry state : rolloutSafe (marge de récupération vérifiée par simulation)"
```

---

### Task 8: `generateEntryState` — orchestration, retries, fallback

**Files:**
- Modify: `sim/src/entry-state.js` (add `generateEntryState`)
- Test: `sim/tools/selftest.mjs` (extend the "entry state" section with the 100-draw acceptance criteria from the issue)

**Interfaces:**
- Consumes: `pickCategory`, `rngFrom`, `sampleCandidate`, `geometrySafe`, `rolloutSafe` (Tasks 4-7).
- Produces: `generateEntryState({ physics, manifest, seed, maxAttempts = 20 }) → Candidate`. Always returns a candidate — never `null` — falling back to a fixed, trivially-safe COMFORTABLE state anchored at `manifest.spawn` if nothing safe is found within `maxAttempts` tries.

- [ ] **Step 1: Write the failing test**

In `sim/tools/selftest.mjs`, change the import from Task 7:

```js
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rolloutSafe, rngFrom } from '../src/entry-state.js';
```

to:

```js
import { CATEGORIES, RANGES, sampleCandidate, geometrySafe, rolloutSafe, generateEntryState, rngFrom } from '../src/entry-state.js';
```

Append to the entry-state section, replacing the final `phys.reset();` with:

```js
	// Acceptance criteria from issue #48: 100 automated draws, none crash
	// unattended, none land under the terrain; category mix close to spec.
	const drawCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
	let anyCrashed = false, anyUnderground = false;
	for (let i = 0; i < 100; i++) {
		const entry = generateEntryState({ physics: phys, manifest, seed: `draw-${i}` });
		drawCounts[entry.category]++;
		if (!rolloutSafe(entry, phys)) anyCrashed = true;
		const ground = phys.groundBelow(entry.position.x, entry.position.y, entry.position.z);
		if (ground === null || entry.position.y - ground < 1) anyUnderground = true;
	}
	check('100 draws: none crash within the grace second when replayed', !anyCrashed);
	check('100 draws: none spawn under the terrain', !anyUnderground);
	console.log(`    category mix over 100 draws: ${JSON.stringify(drawCounts)}`);

	const fallback = generateEntryState({ physics: phys, manifest, seed: 'unreachable', maxAttempts: 0 });
	check('maxAttempts=0 falls back to the fixed spawn', fallback.category === 'COMFORTABLE'
		&& fallback.position.x === manifest.spawn.x && fallback.position.y === manifest.spawn.y
		&& fallback.position.z === manifest.spawn.z
		&& fallback.quaternion.w === 1 && fallback.quaternion.x === 0
		&& fallback.linvel.x === 0 && fallback.linvel.y === 0 && fallback.linvel.z === 0
		&& fallback.angvel.x === 0 && fallback.angvel.y === 0 && fallback.angvel.z === 0);

	phys.reset();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `generateEntryState is not a function`.

- [ ] **Step 3: Implement `generateEntryState`**

Append to `sim/src/entry-state.js`:

```js

const DEFAULT_MAX_ATTEMPTS = 20;

function fallbackCandidate(manifest) {
	return {
		category: 'COMFORTABLE',
		position: { ...manifest.spawn },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
}

// Never returns null: after maxAttempts unsuccessful draws it falls back to
// manifest.spawn at rest, which trivially satisfies both safety nets (it's
// exactly what physics.reset() has always spawned into).
export function generateEntryState({ physics, manifest, seed, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
	const rand = rngFrom(seed);
	const category = pickCategory(rand);
	for (let i = 0; i < maxAttempts; i++) {
		const candidate = sampleCandidate(category, manifest, physics, rand);
		if (candidate && geometrySafe(candidate, physics) && rolloutSafe(candidate, physics)) {
			return candidate;
		}
	}
	return fallbackCandidate(manifest);
}
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`. Note the printed category mix — with only 100 draws some noise versus 60/25/12/3 is expected (the ±3-point distribution check already ran on 20000 draws in Task 4's pure test); this line is for visibility, not an assertion.

- [ ] **Step 5: Run the full baseline once more**

Run: `cd sim && npm run selftest:operator && node tools/selftest.mjs && npm run build`
Expected: all green, build succeeds.

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/entry-state.js tools/selftest.mjs
git commit -m "Entry state : generateEntryState (orchestration, retries, repli garanti)"
```

---

### Task 9: Wire `main.js` — session start and every respawn use the entry state

**Files:**
- Modify: `sim/src/main.js`

**Interfaces:**
- Consumes: `generateEntryState` (Task 8), `Physics.applyEntryState` (Task 3).
- Produces: no new interface — this task only changes what `main.js` calls internally.

- [ ] **Step 1: Import `generateEntryState`**

In `sim/src/main.js`, add this import near the other local imports (right after the `crashThreshold` import added in Task 1):

```js
import { generateEntryState } from './entry-state.js';
```

- [ ] **Step 2: Keep the scene manifest reachable from `respawn()`**

`manifest` is currently a local `const` inside `boot()` (`respawn()` is a separate top-level function and cannot see it). Add a module-level holder next to the other module-level state — change:

```js
let physics = null;
let emitter = null;
```

to:

```js
let physics = null;
let sceneManifest = null;
let emitter = null;
```

Then, in `boot()`, right after:

```js
	const manifest = await loadManifest();
```

add:

```js
	sceneManifest = manifest;
```

- [ ] **Step 3: Generate the entry state at session start**

In `boot()`, right after:

```js
	physics = new Physics(collision, manifest.spawn, PROFILE ? { profile: PROFILE } : {});
	audio.setProfile(physics.profile);
	if (OPTS.family) console.log(`[family] ${physics.profile.family} — ${physics.profile.label}`);
```

add:

```js
	physics.applyEntryState(generateEntryState({
		physics,
		manifest,
		seed: Math.random().toString(16).slice(2, 12),
	}));
```

- [ ] **Step 4: Fix the first-frame camera to match the applied entry state**

The line a little further down currently places the camera at the raw scene spawn, which after Step 3 no longer matches where the drone actually is. Change:

```js
	camera.position.set(manifest.spawn.x, manifest.spawn.y, manifest.spawn.z);
```

to:

```js
	camera.position.set(physics.position.x, physics.position.y, physics.position.z);
```

(The `emitter` block just above — the ground station's antenna position — stays reading `physics.spawn`, unaffected: the pilot's own position on the ground does not move just because the drone's entry point does.)

- [ ] **Step 5: Use the entry state on every respawn**

In `respawn()`, change:

```js
	controller.arm();
	physics.reset();
	link.reset();
```

to:

```js
	controller.arm();
	physics.applyEntryState(generateEntryState({
		physics,
		manifest: sceneManifest,
		seed: Math.random().toString(16).slice(2, 12),
	}));
	link.reset();
```

- [ ] **Step 6: Run the full baseline**

Run: `cd sim && npm run selftest:operator && node tools/selftest.mjs && npm run build`
Expected: all green, build succeeds (none of these exercise `main.js`'s browser-only code paths, but they confirm nothing else broke and that the bundle still builds with the new import).

- [ ] **Step 7: Browser verification**

Run: `cd sim && npm run dev`, open `http://localhost:5173/?scene=tour-eiffel` (bypasses the terminal, boots straight to flight — see `sim/README.md`).

Check:
- The drone is already moving/tilted on the very first frame (not sitting still at the old fixed spawn).
- Press `r` several times; each respawn lands somewhere different — vary in altitude, attitude, and speed — and never drops you into the ground or into an instant, unavoidable crash.
- `window.__sim.debug()` in the console still reports sane `position`/`velocity` (no `NaN`).

- [ ] **Step 8: Commit**

```bash
cd sim && git add src/main.js
git commit -m "Câbler l'entry state PHASE 11 sur l'ouverture de session et le respawn"
```

---

## Post-plan housekeeping

- [ ] Update `sim/HANDOFF.md` with a short PHASE 11 entry (verified: `npm run selftest:operator`, `node tools/selftest.mjs`, `npm run build`, browser run with repeated respawns; not verified: real-flight feel of each category's ranges — first-pass hand-picked numbers, not measured).
- [ ] `gh issue edit 48 --repo lionrayonnant/FPVTP` — move to whatever the current review step is once this plan is fully executed; comment with the branch name (`phase-11-entry-state`) and the verification list above.
