# Picking up FPVThePlanet's flight model

State as of 2026-09-15. Read this before touching `quad.js`, `motor.js`,
`flightController.js` or `drone-profiles.js`.

## Where things are

**On `main`:** PR #158 is merged. The flight model is traced onto the owner's
specification (`~/Documents/dev/SPEC_SIMULATEUR_FPV/`), with the structural
choices of its §0.4 deliberately NOT adopted — the rigid body stays, torques
come from `quad.js`, units are metres.

**On `spec/longrange`, pushed, no PR yet:** the last family whose numbers were
extrapolated. `npm run selftest:ci` green, exit 0. Opening a PR is what starts
CI on it.

## The one number that says where the model stands

```
npm run tune          # 1 of 18 axis/family combinations outside target
```

It was 4 when this work started and 0 before the gyro was turned on; the one
that is open is the toothpick's yaw, and the two that closed before it were not
closed by tuning. **Twice now, a tune that resisted turned out to be a machine that did not
exist**: on both the toothpick and longrange, a full P/D sweep on the old
airframe reached the target at NO point on the grid. Correct the hardware and the
tuner walks straight in. If an axis will not tune, suspect the profile before the
gains.

## The three tools that make this measurable

- **`npm run replay`** — fly six fixed stick sequences through the real
  controller and real Rapier, then `--diff a.json b.json` on quantities a pilot
  recognises. This answers "what did this commit do to the flight", which
  invariant benches cannot. Determinism is proved in process, in reverse order,
  and in a fresh child process. Use it before and after anything that touches the
  plant.
- **`node tools/spec-acceptance-selftest.mjs`** — the spec's nine criteria, with
  targets **re-derived per family** and never copied. 6 of 6 families now sit in
  the rpm band.
- **`node tools/uiuc-prop-validate.mjs`** — the blade-element model against 187
  wind-tunnel propellers. **Read the signed column, not the magnitude**: a bias
  that tracks advance ratio and keeps its sign is a missing term; the magnitude
  only grows because CT goes to zero.

## What is NOT done, ranked

1. ~~**Gyro noise and the loop rate.**~~ **DONE** (branch `spec/gyro-on`). The
   loop runs at 4000 Hz, every family carries a measured `gyroNoise` and a
   0.8 ms `loopDelay`, anti-gravity is at 8.5 and the six tunes were re-swept
   against that plant by a `tune-pid.mjs` that now substeps and sees the rotor
   speeds. `npm run tune` reports **1 of 18** outside target, not 0, and the one
   is the toothpick's yaw — read its note in `src/drone-profiles.js` before
   touching it, because two of the three causes found there are not gains.
   What this left behind, ranked:
   - **The toothpick's `filterScale: 2` chain wants re-deriving at 4 kHz.** Its
     cutoffs were chosen against a 250 Hz discretisation where a PT1 at 110 Hz
     is barely resolved and lags far more than it is asked to; resolve it
     properly and the damping that lag was quietly providing is gone. The rate
     alone costs that family 5.6 points of yaw overshoot, before any noise.
   - **The toothpick's inertia breaks the perpendicular-axis bound.**
     `I_yaw / (I_pitch + I_roll)` is 0.93 on all five other families and 1.15
     there; a flat body cannot exceed 1. This is the third time an axis that
     would not tune pointed at a machine that does not exist.
   - **D-max would have to change mechanism, not ratio**, to pay. See
     `D_MAX_RATIO`'s comment.

2. **`blade-element.js` is still not wired into `quad.js`.** The axial model is
   validated on 187 propellers with no directional bias at any advance ratio;
   **everything edgewise is unverified** and the UIUC tunnel cannot see it.
   Wiring it replaces the thrust model and invalidates six tunes on the strength
   of a term no bench here can check. What is needed first: an edgewise data
   source, or a measured hover-to-cruise thrust curve from the reference build.
3. **`propInertia` is inconsistent across families** — normalised as `k·m·R²` it
   implies k from 0.17 to 0.62. Applying the reference's k moves the cinewhoop by
   2.5×, which changes spool-up and yaw. Its own lot.
4. **Translational rotor moments (#91, reverted by #103).** Same physical
   mechanism as the blade-element edgewise term — do not do both at once.
5. **`battery.maxCurrent` has no consistent convention.** The reference states
   100 A on a pack rated 195 A. Either reading makes some value in the file wrong.
6. **`freestyle5`'s 2450 KV 2207 is in no catalogue** (which has 2000 and 2700).
   It is the byte-for-byte reference and protected as such, but it is the last
   part number in the file that is not a fact.
7. **`swarmNode`'s comment is stale**: it says its inertia is "heavy5 scaled,
   interpolated toward longrange", and longrange has moved under it.

## Twenty-one defects found in the specification

All pinned by tests that fail when the spec is corrected, rather than silently
adopting the new value. They live in code comments and have not been written
back into the owner's document. The serious one is **§6.4, inverted against its
own opening sentence**: applied literally a drone loses nothing climbing and
everything falling.

## House rules that bit

- `npm run selftest:ci` ONCE, at the end, before pushing. It catches what
  per-module benches cannot: guards pinning old airframes, and a Windows-only
  ESM defect that passes on Linux. Two CI round trips were lost before doing it.
- PID values come from `tools/tune-pid.mjs --write`, never by hand. `--write all`
  deliberately excludes `freestyle5`, the reference tune.
- `tune-pid.mjs` rewrites the `pid:` blocks by a REGEX that depends on tab
  indentation. `tools/profile-schema-selftest.mjs` guards it.
- `tools/drone-shape-selftest.mjs` carries a golden geometry fingerprint per
  family. Recalculate it with the reason written down, never silently — the file
  documents four such recalculations now.
- Sub-agent parallelism is limited by FILE OWNERSHIP, not by logic.
  `flightController.js` is the bottleneck. Only the parent edits `package.json`:
  its `selftest:operator` line is one 8 kB line and two lots will conflict on it.
- Two comments in this repo asserted things that were false and hid the real
  defect underneath — `blade-element.js`'s header blamed edgewise flow for an
  axial defect, and another asserted a residual was monotone when it had three
  roots. When a defect resists, check what the comment explaining it claims.
