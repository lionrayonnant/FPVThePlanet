# Flight track, enriched map, DATA tab — design

Date: 2026-09-08
Status: validated, not implemented

## Why

The game is coherent but has no reason to come back. The chosen answer is not
scoring, missions or achievements — the Bible forbids all three (§2.1
"information, not assistance", §24 no reward after a crash, §30 the Home is not
a dashboard). The answer is **traces**: the world keeps what the operator did in
it, and the operator can read their own flying back.

Three pieces, in dependency order:

1. **Flight track** — record what a session actually did, not just its maxima.
2. **Enriched map** — the existing GLOBAL SCANNER map shows those traces.
3. **DATA tab** — `ARCHIVE` becomes `DATA`, a readable set of mono graphs.

Piece 1 is a prerequisite for 2 and 3: none of the interesting graphs, and none
of the map overlays beyond what already exists, can be drawn from the aggregates
stored today.

## What exists today

- `src/session.js` aggregates in memory `durationS, distanceM, maxSpeedMs,
  maxRateDps, maxAltitudeM` and sends them once at close. `SAMPLE_S = 0.2`
  (5 Hz) already drives coverage sampling and already resolves `{ lat, lon }`
  through the `geo` callback (issue #245).
- `src/coverage.js` — slippy cells at z=20, weight saturating at `W_MAX = 8`,
  `MAX_CELLS = 8000`, persisted per operator under the `coverage` key, drawn by
  `src/map-coverage.js` in a dedicated Leaflet pane (`PANE_Z = 350`).
- `src/scanner.js` — the one map (Bible §4). Layer switch and detail switch are
  a `L.control({ position: 'topleft' })` box (`sc-map-controls`).
- Sessions live inside the operator JSON (`server/api.mjs`,
  `P.OPERATOR_DIR/<id>.json`), photos included as base64 `dataUrl`. Photos carry
  `{ dataUrl, w, h, ts }` — **no position**.
- `OP_WRITABLE_KEYS = controlVector, settings, dialogueMemory, coverage`.
- `ARCHIVE` is a root mode (`tools/bench-model.mjs: MODES`), holding LAST
  SESSION, SESSION LOG, TARGET LOG, CONTROL VECTOR, OPERATOR, BUILD NOTES.
- BENCH never opens a session, so nothing here can leak into it (PHASE 26).

## Decisions

- **D1 — Personal only.** The enriched map shows the current operator's own
  traces. No cross-operator overlay, no ME/ALL switch. Keeps PHASE 23
  (multiplayer isolation) untouched and dodges the privacy question. Revisitable
  later; the data model does not need to anticipate it beyond already carrying
  `operatorId` on each session.
- **D2 — TARGET LOG is absorbed.** The families graph in DATA replaces the
  screen. Clicking a family expands the targets met in that family. `runTargetLog`
  and its route out of the menu are removed; `targetLogEntries()` stays, it is
  the data source of the graph and of the Home counters.
- **D3 — 200 tracks retained per operator.** Beyond that, oldest tracks are
  dropped; the session and its aggregates survive. Historical graphs stay
  complete, only per-flight detail is lost. ~15 kB per track → ~3 MB ceiling.
- **D4 — One track write per session, at close.** Not streamed. A dead tab loses
  its track, keeps its session (the existing stale reconciliation still applies).
  The `beacon()` path stays aggregates-only: a 15 kB beacon is not worth the
  risk of losing the whole close.
- **D5 — Tracks are stored beside the operator file, not inside it.** The
  operator JSON is read and rewritten on every session event; growing it by
  3 MB of track data would make every write quadratic. Tracks go in
  `P.OPERATOR_DIR/tracks/<operatorId>/<sessionId>.json`.
- **D6 — No new "explored" concept.** Coverage stays what it is. Tracks are a
  second, finer layer over the same idea; they do not replace it and the
  coverage stain is still drawn when ENRICHED is off.

## 1. Flight track

### Sampling

`session.feed()` already runs every frame and crosses a 5 Hz boundary for
coverage. At each of those boundaries, when `armed`, push one sample:

| field | unit | encoding |
| --- | --- | --- |
| `t` | s since session start | ×10, integer, delta |
| `lat`, `lon` | degrees | ×1e5 (≈1 m), integer, delta |
| `alt` | m above spawn | ×10, integer, delta |
| `spd` | m/s | ×10, integer |
| `thr` | 0..1 stick | ×100, integer |
| `rate` | deg/s, magnitude | integer |

Serialized as parallel arrays of deltas, not an array of objects. A 5 min flight
is 1500 samples ≈ 15 kB of JSON. A hard cap of `MAX_SAMPLES = 18000` (one hour
armed) truncates rather than grows without bound; truncation is recorded as
`truncated: true` and shown as such.

`thr` and `rate` require `session.feed()` to receive the stick values, which it
does not today. `main.js` already has them at the call site (`src/main.js:2322`);
pass `throttle` alongside the existing fields.

### Events on the track

Three point events, stored separately from the sample arrays because they are
sparse and each carries its own payload:

- `photos[]` — one entry per capture: `{ i, lat, lon, heading }` where `i` is
  the index into the session's `photos[]` array. Written at capture time into
  the in-memory track, flushed with the rest at close. This is what geotags
  photos; `sanitizePhoto` is **not** changed, the position lives on the track so
  that dropping a track never invalidates a photo.
- `end` — `{ lat, lon, alt, spd, result }`, the state at the moment the link
  died. Drawn as the loss cross on the map, and the source of the "what killed
  it" scatter.
- `start` — `{ lat, lon }`, the JACK IN point.

### Storage and API

New model module `tools/track-model.mjs`, pure, Node-importable, no DOM:
`encodeTrack(samples, events)`, `decodeTrack(stored)`, `validateTrack()`,
`pruneTracks(list, keep = 200)`. Selftest `tools/track-selftest.mjs` runs in CI
(no scene data, no network, no browser) and must round-trip encode/decode within
the quantization error.

Server routes in `server/api.mjs`:

- `PUT /:operatorId/sessions/:sessionId/track` — writes the track file. Rejects
  a track for a session that does not exist. Body cap sized like the photo
  route, not the default. Runs `pruneTracks` after write. Idempotent: a second
  PUT replaces.
- `GET /:operatorId/sessions/:sessionId/track` — one track, decoded.
- `GET /:operatorId/tracks?bbox=` — the index the map needs: for every retained
  track, a decimated polyline (Douglas-Peucker to ~100 points), the start point,
  the end event, and the photo points. Never the full sample arrays. Optional
  bbox filter so the world view does not ship everything.

`OP_WRITABLE_KEYS` is untouched — tracks are not written through the generic
operator-state route, they have their own.

Sessions gain a derived boolean `hasTrack` in list responses so the UI can say
`NO TRACK` on old flights without a second request.

### Client

`src/session.js` owns the in-memory track exactly as it owns `cov` today, and
flushes it in `end()` after `patchSession` succeeds. A failed track write logs
and is swallowed: losing the track must never cost the session.

## 2. Enriched map

### The control

One toggle, top right of the scanner map, its own
`L.control({ position: 'topright' })` (the corner is free today). Label
`ENRICHED: OFF` / `ENRICHED: ON`, same `sc-switch` typography as the layer
switch. State persists in operator `settings`, which is already writable.

Off, the map is exactly today's map, coverage stain included. On, it adds, in a
pane above coverage:

- **Tracks** — decimated polylines, thin, warm white at low alpha. Overlapping
  flights build density naturally; no per-flight color.
- **Photos** — small squares at their recorded position. At z ≥ 16 they become
  thumbnails. Click opens the existing session detail sheet at that photo.
- **Losses** — a cross at each `end` point, with its date on hover. When two
  crosses fall within 20 px at the current zoom, they collapse into one mark
  carrying a count. This is the answer to "a heavily flown area becomes a mess":
  the map declusters as you zoom, never before.

Everything is click-through to `runSessionDetail()`; the enriched map creates no
new detail UI.

### Data flow

The scanner fetches `/tracks` once when ENRICHED is first switched on, caches it
for the life of the screen, and refilters on move. No fetch while the toggle is
off — the quiet default costs nothing.

## 3. DATA tab

### Naming

`tools/bench-model.mjs`:

```
data: {
  label: 'DATA',
  lines: ['flight records · telemetry', 'where you have been'],
},
```

`MODES` becomes `['field', 'bench', 'data', 'settings']`. `fpvtp.mode` may hold
the old value `archive`; `loadLastMode()` maps it to `data` rather than falling
back, so an existing player's cursor lands where they left it. The bench model
selftest covers the copy, as it does today.

### The screen

`archiveScreen()` becomes `dataScreen()` in `src/terminal.js`: one scrolling
page, mono, no cards, no giant numbers, no rounded corners (Bible §44). Sections
in order, each a `<pre>` title plus one canvas:

1. **RHYTHM** — sessions per week over the last twelve, character bars. The only
   graph about real time. It is what makes coming back visible.
2. **LIFE** — duration per session in chronological order, one bar each.
3. **SPEED × ALTITUDE** — scatter over all flights with a track. The shape of a
   flying style: low and fast, or high and slow.
4. **HOW THEY DIED** — scatter of altitude against speed at the `end` event.
5. **STICKS** — histogram of throttle and of rotation rate.
6. **FAMILIES** — bar per target family, mean survival on it. Clicking a family
   expands the targets met, which is what the TARGET LOG used to be (D2).
7. **GEOGRAPHY** — areas, countries, cumulative distance, plus a link that
   reopens the scanner with ENRICHED on.
8. **PROFILE** — altitude against time for the selected flight, photos marked on
   the curve. Defaults to the last flight with a track.
9. **RECORDS** — the current SESSION LOG, unchanged, as the raw log at the
   bottom, followed by LAST SESSION, CONTROL VECTOR, OPERATOR, BUILD NOTES.

### Rendering

New module `src/graph.js`: a small mono canvas drawing kit — `bars()`,
`scatter()`, `steps()`, `histogram()`, axes and ticks in the terminal
typography, one ink color plus magenta for the selected item only (§19: no
permanent cyan/magenta). Pure drawing, no data knowledge.

New module `tools/data-model.mjs`: turns sessions plus track index into the
series each section needs. Pure, Node-importable, covered by
`tools/data-model-selftest.mjs` in CI. The UI computes nothing.

Sessions without a track render their sections with `NO TRACK` in place of the
curve, never an error and never a gap in the graphs that do not need one.

## Non-goals

Explicitly out of scope, recorded so they are not re-litigated:

- No score, XP, level, achievement, badge, daily objective, ranking or
  comparison with other operators.
- No 3D wreck objects in the world. Losses are map data (the user's call: a mesh
  would barely be seen in flight and costs far more than a cross on a map).
- No replayable 3D trajectory.
- No operator-profile rework; the OPERATOR screen stays as it is.
- No change to BENCH. It opens no session, writes no track, and none of the
  above may appear there.
- No modern-dashboard vocabulary anywhere in DATA.

## Risks

- **Track size on a shared server.** 200 tracks × ~15 kB × N operators. The
  existing `checkOperatorQuota` must count the tracks directory, otherwise the
  quota becomes a lie.
- **Map density.** The clustering threshold (20 px) is a guess, like `MAX_CELLS`
  was. Write it as a guess and revisit on real data.
- **Sampling cost.** Track sampling rides on the existing 5 Hz boundary, so it
  adds an array push, not a timer. Verify with the existing perf selftest that
  frame time is unchanged.

## Sequence

1. Flight track — model, server routes, client recording, selftests.
2. Enriched map — the toggle and the three overlays.
3. DATA tab — rename, graph kit, data model, the nine sections.

Each is its own issue on Project 2.
