# Signals, lot 4 — the trace: implementation plan

Spec: `docs/superpowers/specs/2026-09-28-signals-traces-design.md`. Mockup:
`docs/superpowers/mockups/trace-look.html` (look A, hairline). Branch
`signals-lot4`, stacked on `signals-lot3` (PR #188). Issue #185.

## Global constraints

- Repo rules (`CLAUDE.md`): English code/comments/selftest labels; a touched
  file with French comments leaves in English; never Read `sim/public/scenes/`;
  never run `npm run selftest:ci` (CI does it) — run the module selftests only;
  new selftests chained in `sim/package.json` `selftest:operator`; selftests
  that need scene data SKIP loudly.
- Local ENU: X east, Y up, Z south. Rapier queries only through
  `src/physics.js` (add helpers there, one `RAPIER.Ray` per caller).
- Pure models in `tools/*-model.mjs` with injected dependencies; the header
  says "Pure — no DOM, no THREE, no Rapier".
- Colours from `src/palette.js` `token()` (`--yellow`, `--green`), never
  literals. The demo palette is forbidden here (palette-selftest).
- Budget: the trace work must never add more than ~40 rays per frame
  (probing + re-validation together) and allocate nothing per frame in the
  hot path (reuse vectors/arrays).
- Commits: `git add <files> && git commit -m "..." -- <files>` (parallel
  agents); subject `Signals: <what the player gets> (#185)`; end with a blank
  line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No
  Claude session links.

## Data contracts (shared by all tasks)

```js
// A trace, in local ENU metres.
{
  id,              // signal id ('wd:Q…')
  shape,           // 'orbit' | 'spiral' | 'under' | 'dive'
  points,          // Float32Array [x0,y0,z0, x1,y1,z1, …], spacing ≈ 2 m
  cum,             // Float32Array cumulative length at each point (m), cum[0] = 0
  length,          // total length (m)
  tolerance,       // 5 (tier II) or 3.5 (tier III)
}
// Follower state, returned by TraceFollower.update(...)
{ state: 'waiting'|'on'|'off'|'done', progress01, offS, flownM, fade01 }
```

## Tasks

### T1 — `tools/trace-model.mjs` (pure) + `tools/trace-selftest.mjs`

- `shapeOf(signal) -> shape` per the spec table (kind strings as produced by
  `tools/signal-model.mjs` `kindOf`; heightM > 50 for "built" kinds → spiral;
  natural kinds never spiral).
- `seedOf(id) -> [0,1)` stable hash; `turnDir(id) -> ±1`.
- `buildTrace({ signal, anchor:{x,y,z}, profile, tier, approach:{x,z} , attempt })`
  -> trace | null. `profile` = `{ rings: [{ r, heights: Float32Array(nAngles) }],
  ground, top, axis?: {dx,dz,deckY,underY} }` from T2. Shapes:
  - orbit: radius = max(outline radius where profile top is within 8 m of
    `top`) + 12 m + attempt·8 m; altitude = anchor.y + 6 m + attempt·6 m;
    arc = π (II) / 3π (III).
  - spiral: same radius rule; from ground+15 m (or the profile height at the
    radius + 6 m) up to top + 10 m; turns 0.5 (II) / 1.5 (III).
  - under (needs `axis`): a straight pass perpendicular to the deck axis at
    `underY + clearance/2` (only if clearance ≥ 8 m), 40 m before to 40 m
    after, then a climb out over the deck (II: pass only; III: pass + climb +
    return pass). No axis or clearance → orbit.
  - dive: start 40 m above `top` on the approach side, descend along the
    steepest direction of the profile staying 10 m above the probed surface
    (II: 60 m of path; III: 160 m), ending 10 m above the lowest probed point.
  Entry rotated to face `approach` (the entry is the point closest to the
  drone's side). Resample to ~2 m spacing, fill `cum`/`length`.
- `class TraceFollower({ trace, tolerance })`: `update({ dt, pos:{x,y,z} })`
  -> state object. Gate: `waiting` until within tolerance of point 0.
  Progress search window: from current index to +15 m of path; advance to the
  nearest point within tolerance that is ahead; `off` when the nearest in the
  window is beyond tolerance; `offS` accrues; at 10 s off → `fade01` runs 0→1
  over 2 s, then reset to `waiting`. `done` at ≥ 99.5 % of length. `dt = 0`
  freezes. No allocation per update.
- `photoScore({ angleDeg, los }) -> number|null` (null when out of a 35° cone or
  no LOS; else 1 − angle/35).
- Tests: shapeOf table; determinism of seeds; each shape's geometry
  (length, spacing ≈ 2 m, altitude bounds, entry facing approach); under
  without axis → orbit; follower gate, advance, no skip-ahead, pause/resume
  within 10 s, reset after 10 s + fade, done, dt=0 freeze; photoScore.

### T2 — `src/trace-probe.js` (injected rays) + `tools/trace-probe-selftest.mjs`

- `physics.js`: add `rayUp(x,y,z,max)` (upward cast, returns the hit Y or null)
  following the one-Ray-per-caller pattern. (groundBelow and
  obstructionBetween exist.)
- `class TraceProbe({ groundBelow, rayUp, obstructionBetween, raysPerFrame = 24 })`:
  - `start(anchor)` — polar grid: rings at r = 0, 10, 20, 35, 55, 80 m ×
    16 angles, from anchor.y + 300 down (`groundBelow`); `step()` spends at
    most `raysPerFrame` rays and returns the profile when complete
    (`ground` = min, `top` = max, heights per ring/angle).
  - Bridge axis (called for BRIDGE/ARCH kinds): among grid points, "deck"
    points are ≥ 4 m above the median of their ring's lowest points; PCA of
    deck points → axis; `underY` via `rayUp` from 2 m above the lowest point
    under the deck centre; clearance = deckY − underY. Missing → no axis.
  - `validate(trace, fromIndex, budget)` — checks segments with
    `obstructionBetween` (each segment inflated by checking both endpoints
    lifted ±1 m is not needed; one ray per segment), returns the first blocked
    index or −1; incremental across frames (a cursor).
  - `lift(trace, fromIndex, dy)` — raises points ≥ fromIndex by dy with a
    30 m smoothstep blend starting at fromIndex; recomputes cum/length.
- Tests with a fake world (a box building, a bridge deck over water, a cone
  peak): profile values, axis found for the bridge, blocked segment detection,
  lift keeps the flown part, budget respected (count calls).

### T3 — `src/trace-line.js` (THREE) + `tools/trace-line-selftest.mjs`

- `class TraceLine(scene)`: one `Line2` (`three/addons/lines/Line2.js`,
  `LineMaterial` linewidth ≈ 2 px, `worldUnits:false`, depthTest on,
  depthWrite off, `fog:false`, `transparent`) for the whole trace with per-vertex
  colours; a small square gate (4 `Line2` segments or one closed `Line2`
  square, 3 m side, facing the path direction at point 0).
- `show(trace)`, `setProgress(progress01, state, fade01)` — colours: flown
  (cum ≤ progress·length) green, the rest yellow; `fade01` fades the flown
  part's alpha to 0 (per-vertex alpha via colour × uniform, or a second
  material); gate green once entered. `hide()`, `setVisible(bool)` (used around
  `lens.capture()`), `setResolution(w,h)` (LineMaterial needs it), `dispose()`.
- Colours from `token('--yellow')` / `token('--green')`.
- Pure helper exported for tests: `vertexColors(cum, length, progress01,
  fade01, out)`.
- Selftest: the pure helper (split at the progress point, fade), and that
  `TraceLine` builds/disposes without throwing under a THREE stub if practical.
- palette-selftest must stay green (no demo colours).

### T4 — Scanner zoom 13 (`tools/signal-model.mjs`)

- `MIN_QUERY_ZOOM = 13`; update `tools/signal-model-selftest.mjs` (the
  constant assertion and the literal zoom-10 cases → 13), and any comment that
  says 10 (`src/map-signals.js:28`). Check `src/scanner.js` still shows
  `ZOOM IN TO SCAN` below it. Tiny task.

### T5 — Integration (`src/main.js`, `src/signal-capture.js`, callout, store, card, DATA)

- `signal-capture.js`: a target may carry `trace: true` (tier II/III with a
  live trace); such a target never fills the hold gauge (its gauge is driven
  externally: `setTraceProgress(id, p01)`), still gets focus/near/callout.
  When the trace is done main.js calls `resolveByTrace(id)` which marks it
  resolved and sets `out.uplinked` like a hold. Tests in
  `tools/signal-capture-selftest.mjs`.
- `tools/signal-callout-model.mjs`: `headline('trace', { shape, pct })` →
  `TRACE · SPIRAL · 42 %`, and `headline('trace-wait', { shape })` →
  `TRACE · SPIRAL · ENTER THE GATE`; revealCount from progress. Tests.
- `main.js`:
  - a `traces` controller: one active trace at a time — the nearest open
    tier II/III signal within 300 m that has no failed trace; probe → build →
    validate (up to 3 attempts) → `TraceLine.show`; failure → mark the signal
    `traceFailed` (falls back to hold capture for that flight).
  - after `flushNodeColliders()` (the live collider hook), re-validate the
    unflown part of the active trace (budgeted) and `lift` if blocked.
  - per frame (in `updateSignals`, only while `signalsLive()`), update the
    follower with the drone position; feed progress to capture/callout/line.
  - photo: during `on`, at most 2 Hz, if the landmark is within the 35° cone
    and LOS, score it; keep the best `lens.capture()` (trace line hidden
    during the capture) as the uplink frame.
  - uplink entry: `trace: shape`, `holdS: secondsOnTrace`.
  - disarm/flight end/bench: dispose the trace and line.
  - DEV handle: `__signals.trace()` (current trace, follower state),
    `__signals.flyTrace(speed = 8)` (teleports the drone along the active
    trace over time, for verification).
- Store (`tools/signal-store-model.mjs`): optional `trace` ∈ {orbit, spiral,
  under, dive}; validated; old entries unchanged. Card
  (`tools/signal-card-model.mjs` / `src/signal-card.js`) and DATA
  (`tools/signals-data-model.mjs`): `TRACE SPIRAL · 38.2 s` when `trace` is
  set, else `HOLD x s`. Tests.

### T6 — Docs

- Bible §49: a short sub-section *Le fil* (French): the one object the game
  lays in the world, why (a place asks for a flight, not a stare), what it is
  not (no timer, no score), and the §42 colour exception (functional yellow /
  green in the world, only near an open signal, hidden in the photo).
- CHANGELOG (French) under `[Non publié]` → `### Ajouté`: the trace; `###
  Modifié`: scan from zoom 13.
- `docs/manual.md` Signals section: the trace rules; HANDOFF: lot 4 verified /
  not verified (written at the end).

## Order

T1, T3, T4 in parallel → T2 (uses T1's profile contract) → T5 → final review →
fix wave → browser verification (fly a spiral, an orbit, a dive, a bridge if
one is in range; fallback) → T6 → PR (base `signals-lot3`).
