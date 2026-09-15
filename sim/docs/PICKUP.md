# Picking up `spec/integration` (PR #158)

Written for whoever resumes this. Fifteen commits, CI green, not merged.

## What this branch is

The owner wrote a flight-physics specification — `~/Documents/dev/SPEC_SIMULATEUR_FPV/`,
800 normative lines plus a parts catalogue — and asked for the sim's physics to
be traced onto it. Nine lots, integrated and flown.

**The previous PICKUP.md is obsolete and its open items are closed.** For the
record, because two of them were wrong rather than merely done:

- "Fly it" — flown, in `?live=`. The feel changes are measured, not guessed.
- "Run the propeller validation" — run, and it found a defect in `blade-element.js`
  that the file's own header misattributed. See below.
- "A hover sits at 0.342, right on TPA_BREAK, unexamined" — examined and closed.
  It is what a 6.3:1 machine does; `race5` at 9.27:1 hovers at 0.227. Not a symptom.
- "race5 and toothpick carry data that is not theirs" — true, and it was four
  families, not two. Fixed.

## Start here

```bash
npm run dev            # then ?live=48.8584,2.2945&family=toothpick
npm run replay         # the new one: fly a fixed stick sequence, diff two versions
npm run tune           # report only, never --write by hand
```

`npm run replay -- --all --family all --quiet --out a.json`, then the same on
another version, then `--diff a.json b.json`. That answers "what did this commit
do to the flight", which nothing here could answer before.

## What is NOT done, ranked

1. **`blade-element.js` is still not wired into `quad.js`**, and should not be
   yet. The axial model is validated on 187 measured propellers with no
   directional bias at any advance ratio. **Everything edgewise is unverified** —
   the UIUC tunnel blows along the shaft and cannot see it. Wiring it replaces
   the thrust model and invalidates six PID tunes on the strength of a term no
   bench here can check. What is needed first: an edgewise data source, or a
   measured hover-to-cruise thrust curve from the reference build.
2. **The gyro noise is 0 and the notch is not built.** Turning them on means
   raising the control loop rate, and the two go together with a re-sweep. The
   measurement is already done: a notch degenerates above 0.45 of Nyquist (56 Hz
   at 250 Hz) and rotor fundamentals run 155–816 Hz in flight, so at this rate
   the notch is not weak, it is absent. `?loop=<hz>` accepts 250/500/1000/2000/4000.
   Cost measured at 0.065% of a core for 1 kHz. **Watch the toothpick**: it has
   no delay margin left, already 10.1% overshoot from the noise alone.
3. **`longrange` is the last family carrying data that is not its own.** It is
   the only one still outside the rpm band, its 7x4x3 propeller does not exist
   in the catalogue, and a catalogue bill of materials comes to 1.04 kg against
   the profile's 0.92. Its two tune misses are a consequence, not a cause —
   the same shape as the toothpick before it was fixed. Fixing it moves `mass`,
   so `inertia` has to be recomputed.
4. **D-max is off (1.0) and that is deliberate.** Measured, it is a loss on the
   tune as it stands: it buys a lower resting D, and the resting D here was
   chosen against a silent gyro. It pays only after item 2.
5. **`propInertia` is inconsistent across families** — normalised as `k·m·R²` it
   implies k from 0.17 to 0.62. Applying the reference's k would change the
   cinewhoop by 2.5×, which moves spool-up and yaw. Its own lot.
6. **Translational rotor moments (#91, reverted by #103)** remain out. Same
   physical mechanism as the blade-element edgewise term — do not do both at
   once, or two corrections of one phenomenon will fight.
7. **`battery.maxCurrent` has no consistent convention.** The reference states
   100 A on a pack rated 195 A. Either reading makes some value in the file wrong.

## Twenty-one defects found in the specification

All pinned by tests that fail when the spec is corrected, rather than silently
adopting the new value. Report them upstream; the serious one is **§6.4, which
is inverted against its own opening sentence** — applied literally, a drone
loses nothing climbing and everything falling.

## House rules that bit during this work

- `npm run selftest:ci` ONCE, at the end, before pushing. It caught three guards
  pinning the old airframes and a Windows-only ESM path defect that passes on
  Linux. Per-module benches do not see those.
- PID values are written by `tools/tune-pid.mjs --write`, never by hand.
  `--write all` deliberately excludes `freestyle5`, the reference tune.
- `tune-pid.mjs` rewrites the `pid:` blocks of `drone-profiles.js` by REGEX that
  depends on tab indentation. `tools/profile-schema-selftest.mjs` guards it.
- A file touched for any reason leaves in English.
- One worktree per lot, and never two agents in one file. The parallelism here
  was limited by file ownership, not by logic.
