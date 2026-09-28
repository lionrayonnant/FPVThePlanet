# Signals, lot 4 — the trace (design)

Issue #185. Validated with the author on 2026-09-28 (questions answered one by
one; mockup `docs/superpowers/mockups/trace-look.html`, look **A — a hairline**).

## What the player gets

A tier II or III signal is no longer captured by holding it in the frame for
5 s: it is captured by **flying a thread** laid in the air around it. Tier I is
unchanged.

| tier | trace | tolerance |
|---|---|---|
| I | none — hold in frame 5 s (today) | — |
| II | short: half a turn (orbit / spiral), or the short form of the shape | 12 m |
| III | full: 1.5 turns (orbit / spiral), or the full form of the shape | 9 m |

(First set at 5 m / 3.5 m; widened on 2026-09-28 after play: too hard to hold.)

**Shape by kind** (`signal.kind`, from OSM tags; `heightM` from OSM/Wikidata):

| shape | kinds |
|---|---|
| `spiral` — rises around it | TOWER, LIGHTHOUSE, any other built kind with heightM > 50 |
| `under` — passes under/through, then climbs out | BRIDGE, ARCH |
| `dive` — starts above, descends along the face | PEAK, VOLCANO, WATERFALL, CLIFF, DAM |
| `orbit` — level ring around it | everything else |

The same place always gives the same trace: the seed is the Wikidata id
(start angle, direction of turn), then the entry is rotated to face the side
the drone comes from **at generation time**.

## Rules

1. **Generation.** When the drone is within 300 m (horizontal) of an open,
   non-encrypted tier II/III signal, the game probes the collision world around
   it (vertical rays on a polar grid, budgeted per frame), builds the shape
   above/around the profile with a clearance margin, and validates every
   segment with `physics.obstructionBetween`. If a segment is blocked, retry
   wider/higher (3 attempts). If none works, **that signal falls back to the
   hold-in-frame capture** — never blocks.
2. **Refinement.** In LIVE, colliders refine as the drone approaches. After each
   collider flush, the unflown part of an active trace is re-validated (budgeted).
   A blocked segment ahead lifts the remaining trace by the needed height,
   blended over ~30 m — the flown part never moves.
3. **Look (A).** One thin hairline in the world (depth-tested, through the lens,
   ~2 px), yellow `--yellow` for what is left, green `--green` for what is flown;
   a small square **entry gate** at the start (yellow, green once passed). The
   trace is hidden while `lens.capture()` renders a photo. Fog-free, no glow.
4. **Following.** Enter through the gate (within tolerance of point 0). Progress
   advances along the polyline while the drone stays within tolerance and moves
   forward; it can't skip ahead (a search window of 25 m past the current
   progress). The camera may look anywhere (question 2 → A).
5. **Leaving the thread** (question 3 → C). Progress pauses. Back within 10 s:
   resume where you left. After 10 s off: the flown part cools (fades over 2 s)
   and progress resets — re-enter through the gate.
6. **Callout.** The callout headline reads `TRACE · SPIRAL · 42 %` (yellow `[*]`
   semantics as capturing) instead of the hold gauge; field reveal follows the
   trace progress. Before entering: `TRACE · SPIRAL · ENTER THE GATE`.
7. **Photo.** During the trace, when the landmark is in the frame and in line of
   sight, at most 2 Hz, the game scores the view (angle from frame centre;
   closer to centre is better) and keeps the best frame (trace hidden). That
   frame is the intercepted photo. None seen → the last frame of the trace.
8. **Uplink.** 100 % → `UPLINKED`, the card, points, as today. The stored entry
   gets `trace: '<shape>'` and `holdS` = seconds spent on the trace. The card
   and DATA show `TRACE SPIRAL · 38.2 s` instead of `HOLD 5.0 s` when `trace`
   is set.
9. **Scanner.** Signals are requested only from map zoom **13** (was 10); below,
   `ZOOM IN TO SCAN` (exists).

## What it is not

No score, no timer to beat, no ghost. The trace is the one object the game lays
in the world: an intercepted path, drawn only near an open signal, gone once
uplinked. Bible §49 records it (and the colour exception of §42 for it).

## Units

- `tools/trace-model.mjs` (pure): shape choice, shape generation from a probed
  profile, the follower (progress, gate, off-timer, reset), photo scoring.
- `src/trace-probe.js` (injected ray functions): budgeted polar probing, bridge
  axis, segment validation, re-validation and lift.
- `src/trace-line.js` (THREE): the hairline + gate, colours, fade, hide/show.
- `src/main.js`: wiring (generation trigger, follower update, callout, photo,
  uplink entry), DEV handle `__signals.trace()` / `__signals.flyTrace()`.
- Store/card/DATA: optional `trace` field.
