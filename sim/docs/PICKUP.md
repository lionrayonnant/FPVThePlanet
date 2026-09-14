# Picking up `claude/drone-gravity-fix-ofdhrh`

Written for whoever resumes this — a person or an agent. Nine commits, not
merged, no pull request. Start with `npm run resume` from `sim/`.

## The one thing that matters most

**Nothing on this branch has been flown in a browser.** Every number in every
commit message is bench measurement on the pure model. The session that
produced it had no browser and no network access to the reference data, and
those two gaps are what block almost every open item below.

So: fly it first, before writing any more physics.

```bash
npm run dev        # then ?scene=<slug> to skip the terminal
```

and in the console, during the flight that feels wrong:

```js
__sim.budget()        // start
// ... 30 s ...
__sim.budget(true)    // read back
```

Everything it prints is a fraction of the airframe's weight along world +Y.
`__sim.ruler()` measures between two points of a flight (call it twice) and
exists to settle whether the rendered world is at true scale — fly level with
the foot of a landmark, call it, climb level with its top, call it again.

## How this branch came about

Reported as "the drone's gravity is wrong", then "it floats, it is too light,
everywhere". Five measured defects were found and fixed. The pilot's verdict
after the first four was "better, but not striking", which is itself the most
useful datum on this branch: each fix was deliberately calibrated to preserve
the reference airframe's feel, so by construction none of them could move it
much — and all four were in the DESCENT branch, while the report said
everywhere.

A force budget was then built to stop guessing. Flown for 83 s it returned
`thrustUp 0.983`, ground effect 0, vortex ring −0.0005, **wind 0** — which
killed the leading suspect (terrain updraft) outright and said no anomalous
force is holding the machine up. That points away from the flight model and
toward the rendered world's scale, which is what `__sim.ruler()` is for.

## What is on it

| commit | what |
|---|---|
| Gravity stopped whenever the render slowed down | `Physics.step()` ignored its own `dt` for Rapier; the frame loop discarded elapsed time below ~21 fps |
| The drone refused to fall | The axial inflow term was an unbounded first-order slope: 1.23× weight of braking at 25 m/s of descent |
| The vortex ring state never let go | Absolute m/s thresholds shared by every family, and it saturated for ever instead of ending at the windmill brake boundary |
| Motors are a torque balance now | `src/motor.js` — back-EMF, winding current, `J·dω/dt = Q_motor − Q_prop`. Replaced three fitted constants per family |
| Measure where the weight actually goes | `Physics.beginForceBudget()` / `forceBudget()`, `__sim.budget()` |
| The force budget exonerates the flight model | The 83 s flight above, plus `__sim.ruler()` |
| A propeller as a blade | `src/blade-element.js` — BEMT. **Not wired in** |
| Validate against measured propellers | `tools/uiuc-prop-validate.mjs` |

## Open items, ranked

1. **Fly it.** Everything else is downstream of this.

2. **Run the propeller validation.** `npm run resume` fetches the UIUC database
   and runs it. The blade-element model is currently *calibrated* on two
   anchors per family and *validated* against nothing. This is the test that
   says whether it is right: calibrate on one static point, predict the whole
   advance-ratio sweep, compare to the tunnel. BEMT with a generic aerofoil is
   usually quoted at 10–20 % on CT for props this small. Well over that means
   the model is wrong, and the shape of the error against J says where.

3. **Two known defects in `blade-element.js`**, both in its header:
   - the joint chord/section-drag solve settles into a limit cycle on
     `freestyle5` — the *reference* family — leaving it ~4 % off both anchors.
     Pinned by a selftest so it cannot quietly get worse.
   - edgewise flight past an advance ratio of ~0.1 makes thrust fall where a
     real rotor's would flatten, because the blade elements never see the
     edgewise flow. Fixing it properly means integrating over azimuth.

4. **Do not wire `blade-element.js` into `quad.js` until 2 and 3 are settled.**
   It replaces the core of the model, invalidates all six PID tunes (re-run
   `node tools/tune-pid.mjs --write all`, never hand-edit), and obsoletes four
   `aero-selftest` guards.

5. **`race5` and `toothpick` carry data that is not theirs.** The motor model
   exposed it: both come out at 48–51 % of no-load rpm, and the toothpick
   implies ~11 A a motor where a real 1102 pulls 5–7. Their numbers were scaled
   from `freestyle5`, never measured. The visible cost today: the tuner reports
   4 axis/family combinations outside target where it reported 2 before, and
   both new ones are the toothpick's roll and pitch. Needs real bench numbers
   for a 2.5" micro. Worth an issue.

6. **A hover now sits at 0.342 stick, right on `TPA_BREAK` (0.35)**, where
   throttle-dependent gain attenuation starts. Unexamined.

7. **Still missing from the flight model**, in rough order of what a pilot
   would notice: the blade flapping moment (issue #91, reverted by #103); gyro
   noise, the Betaflight filter chain and loop latency, so the controller still
   reads perfect body rates; anti-gravity, I-term relax and D-max; ESC current
   limits.

## Tools that would move this fastest

- **Betaflight itself** (`github.com/betaflight/betaflight`) is GPL-3.0, which
  is licence-compatible with this repository's AGPL-3.0 — so its algorithms can
  be *ported* with attribution and notices, not just imitated. That is not true
  of the Nexus mod that prompted the blade-element work, which is why that was
  implemented from published theory (Glauert, Leishman) instead.
- **A Betaflight blackbox log from a real quad.** Gyro, rpm, throttle,
  accelerometer. Replay the same sticks through the sim and compare. It is the
  only thing that turns "asserts invariants" into "measures an error".
- **A flight-replay regression harness.** The selftests here assert invariants,
  and invariants could not tell anyone that four correct fixes would barely
  change the feel. Fly a fixed stick sequence, record the trajectory, diff it
  between versions.

## House rules that bit during this work

- `npm run selftest:ci` runs ONCE, at the end. Per-module benches
  (`node tools/<module>-selftest.mjs`) are what you run while working.
- PID values are written by `tools/tune-pid.mjs --write`, never by hand.
- A file touched for any reason leaves in English.
- A selftest that needs data the repo does not carry must SKIP loudly, not
  fail. `tools/uiuc-prop-validate.mjs` follows that.
