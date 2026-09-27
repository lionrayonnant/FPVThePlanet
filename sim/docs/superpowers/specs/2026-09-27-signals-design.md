# Signals — landmarks to capture, a dossier to fill, a clearance to earn — design

Date: 2026-09-27
Status: validated in brainstorm, not implemented

## Why

The game has no loop past one flight. Asked what makes them stop, the author
named two gaps: **no objective** (after the hack and the flight, nothing says
what to do next) and **no accumulation** (ten sessions or one, nothing grows).

The 2026-09-08 answer — traces (flight track, map history, DATA) — records what
the operator did but gives no reason to fly again.

### A change of rule, stated

The Bible forbids score, XP, levels, achievements, missions and rankings, and
the 2026-09-08 spec restates it. On 2026-09-27 the author **relaxed** that rule:
explicit progression is allowed **as long as it stays diegetic**; open scoring
and rankings stay out for now but the design must not close the door on them.
The Bible gets a section recording this, the way PHASE 26 (BENCH) got one —
*why a clearance exists in this universe* — rather than being contradicted
silently.

### Constraints that shaped it

- **There is no landing.** Since #10 a flight ends only by a crash or by
  leaving the zone (`src/flight-end.js`, `session.end('CRASHED')`). Every
  machine is lost. Nothing can be validated "on return".
- **Points of no interest are worthless.** A signal on an anonymous roof is not
  an objective. Only landmarks count.
- **Rocktree LIVE is the point of the game** (the whole planet is flyable), so
  the landmarks cannot be a hand-written list.

## The loop

```text
GLOBAL SCANNER shows signals around what you look at
    ↓
you draw your zone around one or several
    ↓
TARGET SCAN draws a machine from the pool your CLEARANCE opens
    ↓
JACK IN · FLY · hold a landmark in frame → fields decrypt → UPLINKED
    ↓
(more signals in the zone? how many before the machine is lost?)
    ↓
CRASH — what was UPLINKED is kept, what was not is lost
    ↓
DOSSIER fills · city coverage grows · CLEARANCE rises
    ↓
higher tiers and the machines that reach them open
```

## 1. Detection

**Source: OpenStreetMap through Overpass.** A signal is an OSM element that
carries a `wikidata` tag (the notability filter: it keeps the cathedral, drops
the bench) **and** a landmark category: `historic=*`,
`tourism=attraction|viewpoint`, `man_made=tower|lighthouse|dam`,
`building=cathedral|church|castle`, `natural=peak`, `bridge` with a name. The
exact tag set lives in `signal-model.mjs` and is measured on real tiles, not
guessed (how many signals does Paris, Reims, a Swiss valley produce).

Position comes from OSM (node, or the centroid of a way/relation). **Height is
found in flight**: a ray cast down onto the streamed mesh puts the anchor on top
of the real building. Until the tiles under it are in, the anchor sits at ground
level and rises, smoothed, when the mesh arrives.

**Where signals appear: on the world scanner, before drawing.** The player
chooses a zone *from* the signals, never discovers after an hour of
acquisition that a zone has none.

### Rate limits and failure (the public Overpass instance)

About 10 000 queries/day/IP, 2 concurrent slots, 429 on abuse.

- No query under a minimum map zoom (never a continent).
- A fixed tile grid; **one query per tile, once**.
- Persistent per-operator cache (IndexedDB), 30-day TTL — landmarks do not move.
- One query in flight at a time, debounced after map moves, backoff on 429
  honouring `Retry-After`.
- `[timeout:…]` and an output cap in the query itself.
- **Density cap per tile**: keep the most notable (has `wikipedia`, then
  height). Paris must not become hundreds of dots.
- **Failure never blocks a flight**: Overpass down → the scanner shows
  `SIGNAL SCAN UNAVAILABLE`, the game is fully playable without signals.
- Only signals **inside the zone's geofence** are live in flight; the others
  stay on the map as invitations.
- ODbL: the scanner already credits OpenStreetMap; the DOSSIER card does too.

## 2. Tiers, clearance, coverage

Each signal gets a **tier**, computed from its tags:

| Tier | Examples | What it asks |
|---|---|---|
| I | church, castle, low monument | get close |
| II | tower, spire, lighthouse (`height` > 50 m) | climb, hold a frame at altitude |
| III | peak (`natural=peak` + wikidata), dam, bridge | go far: long range, wind, relief |

**CLEARANCE 0 → 2**, derived from resolved signals (weighted by tier). **Never
stored**: always recomputed from `signals.resolved`, so a rule change never
leaves a stale rank behind. Three steps, because there are three things to
open — a rank with steps that open nothing is decoration.

Each step opens **both** a tier and the machines that reach it — the TARGET
SCAN draw stays random, its **pool** widens:

| Clearance | Tiers | Pool |
|---|---|---|
| 0 | I | cinewhoop, toothpick, freestyle5 |
| 1 | I, II | + race5 |
| 2 | I, II, III | + longrange, heavy5 |

The resolution counts that reach each step are set in `signal-model.mjs` and
checked by the calibration below (a step must be reachable in a handful of
sessions in one well-covered city).

A signal above the operator's clearance is visible, marked `ENCRYPTED ·
CLEARANCE n`, annotated in flight, not capturable.

**Coverage per city** (`REIMS 3/7`, the city from the Nominatim reverse the
scanner already does) is the collection meter — and the hook a score or
ranking would plug into later (option 3, not in this design).

## 3. Capture in flight

**Condition**: the anchor inside a **±12° cone** around the camera axis, at
**30–250 m** (farther for tier III), line of sight clear (Rapier ray from the
drone to the anchor).

**Hold 6 s, cumulative.** Losing the frame drains the gauge slowly, it does not
reset it: a bad pass costs seconds, not the capture.

**At 100 % — UPLINKED**: the frame is grabbed **without the HUD**, the signal is
written to the operator state immediately (the fiction: the data leaves over the
hijacked link the moment it is captured), a short `UPLINKED` cue plays.

**Crash mid-capture**: what has not reached UPLINKED is lost. What has, is
kept. The stake of a flight becomes *how many signals before the machine is
lost*.

Several signals per flight are allowed. A resolved signal stays annotated
(green, complete) and is not captured again.

**The numbers (12°, 6 s, 30–250 m) are starting points, not a tuning.** A
calibration tool replays real flight tracks (`tools/track-model.mjs`) against
the capture machine and checks that every family can capture what its
clearance opens — the same discipline as `npm run tune`.

## 4. The HUD callout

Validated on a mockup (brainstorm, 2026-09-27), **field labels: words**
(variant A), not pictograms.

The anchor (OSM position + raycast height) is projected every frame. A leader
line runs from it to a mono callout in the existing HUD grammar (PHASE 12).

| State | Look |
|---|---|
| in range (~400 m, inside the fog range) | `SIGNAL` + distance, name scrambled, neutral ink |
| capturing | orange frame, gauge, fields **decrypt one by one** |
| UPLINKED | green frame, full gauge, every field in clear, screen corners flash |
| encrypted | `ENCRYPTED · CLEARANCE n`, no gauge |
| out of frame | collapses to an edge chevron `SIGNAL 260 M ▶` |

Fields, in order, only those OSM has: `NAME` (`name`, `name:en`), `TYPE`
(`historic=castle` → `CASTLE`), `BUILT` (`start_date`), `HEIGHT` (`height`),
`ARCHITECT` (`architect`), `STATUS` (`heritage`, UNESCO). The callout sizes to
the lines present — the Eiffel Tower has ten, a village chapel may have one.

Colours are the functional ones only (`--orange` happening now, `--green`
acquired). No demo palette.

## 5. The DOSSIER

What is collected is **the operator's own frame**, grabbed at 100 % — it always
exists and it is unique to that flight.

A card per resolved signal: the frame, the name and fields, `UPLINKED` date,
machine family, hold time, distance, the ODbL credit.

**Reference photo, when OSM has one**: a `wikimedia_commons` tag, or an `image`
tag pointing at Commons (any other host is ignored). Shown small next to the
frame, with **author and licence** fetched from the Commons API at capture
time and stored with the resolution. Absent tag → no reference, the card is
complete without it.

The DOSSIER grid shows resolved signals by their frame, known-but-unresolved
ones as a scrambled name and a distance. It is a terminal tab next to DATA.

## 6. Architecture

Follows the repo's patterns: pure models in `tools/*-model.mjs` with their own
selftest, operator state served by `server/api.mjs`, DOM-free state machines
like `src/flight-end.js`.

### New

- **`tools/signal-model.mjs`** (pure, Node-safe) — OSM element → `Signal { id:
  'osm:way/123', lat, lon, tier, name, fields[], commons? }`; tier rules; tile
  grid keys; density cap and ranking; clearance from resolutions; the
  clearance → tiers + families table.
  - **`fields` is an ordered list of `{ key, label, value, source }`**, source
    `'osm'` today. Wikidata (short description, reliable figures) is left out
    of V1 on purpose; adding it later means adding rows with `source:
    'wikidata'`, nothing else changes.
- **`src/signal-source.js`** — the Overpass client: tile queue, single flight,
  backoff, IndexedDB cache, `UNAVAILABLE` state. `fetch` injected so the
  selftest runs without network.
- **`src/signal-capture.js`** — pure state machine: `update({ camPose, signals,
  los, dt })` → per-signal state and gauge, and a consume-once `uplinked`
  event (same drain discipline as `FlightEnd.closes`).
- **`src/signal-callout.js`** — HUD layer: projection, leader, callout,
  chevron, raycast height with smoothing.

### Changed

- `src/scanner.js` / `src/map-layers.js` — the signals layer (resolved,
  open, encrypted).
- `tools/target-model.mjs` — the draw pool filtered by clearance.
- `tools/session-model.mjs` / `server/api.mjs` — resolutions in the operator
  state: `signals.resolved[id] = { at, sessionId, family, holdS, distM, frame,
  commons? }`. The frame reuses photo storage and is stripped from the heavy
  operator reads the way `stripOperatorPhotoData` already does.
- Terminal — the DOSSIER tab; the operator header shows `CLEARANCE n · k
  SIGNALS`.
- `server/headers.mjs` — CSP: `connect-src` + `https://overpass-api.de
  https://commons.wikimedia.org`, `img-src` + `https://upload.wikimedia.org`.
- Bible — the section recording the relaxed rule (see *A change of rule*).

### Tests

- `signal-model-selftest` — tag → tier, density cap, clearance table, field
  ordering, malformed OSM input.
- `signal-source-selftest` — fake `fetch`: tile dedup, single flight, 429 +
  `Retry-After`, cache TTL, failure → `UNAVAILABLE`.
- `signal-capture-selftest` — cone, range, LOS, cumulative hold and drain,
  crash before UPLINKED, encrypted, already resolved.
- `signal-callout-selftest` — projection, off-screen chevron, field
  reveal order.
- `tools/signal-calibrate.mjs` — replays tracks per family (local, needs
  recorded tracks, **skips loudly** without them).
- All but the calibration join `selftest:ci`: no network, no scene.

## Lots

Each lot is playable on its own.

1. **Detection** — `signal-model`, `signal-source`, scanner layer, CSP.
2. **Capture** — `signal-capture`, `signal-callout`, UPLINKED written to the
   operator state, calibration.
3. **Accumulation** — DOSSIER, clearance, city coverage, draw pool, Commons
   reference, Bible section.

## Out of scope

- Wikidata enrichment (the format is ready for it).
- Scores, timed challenges, rankings, cross-operator sharing — the door is
  open (each UPLINKED carries hold time and distance), not walked through.
- 3D objects in the world for signals (rejected on 2026-09-08 for the same
  reason as wrecks: barely visible in flight).
