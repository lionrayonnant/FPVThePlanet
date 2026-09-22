# Picking up FPVThePlanet's flight model

State as of 2026-09-15, branch names refreshed 2026-09-19. Read this before
touching `quad.js`, `motor.js`, `flightController.js` or `drone-profiles.js`.

## Where things are

**On `main`:** PR #158 is merged. The flight model is traced onto the owner's
specification (`~/Documents/dev/SPEC_SIMULATEUR_FPV/`), with the structural
choices of its §0.4 deliberately NOT adopted — the rigid body stays, torques
come from `quad.js`, units are metres.

**On `main`:** PR #161 too — the last family whose numbers were extrapolated.
Six of six families now sit in the specification's rpm band. And PR #163: the
gyro is on, the control loop runs at 4000 Hz.

**On `main`,** two more lots that closed together (merged since this file was
written, as "Every part number resolves, one propeller was half its weight, and
the blade is wired with its switch left off"):

*The bill of materials, made checkable.* Every family names its motor,
propeller and pack by catalogue id; `propInertia` is derived by one rule
instead of chosen family by family; swarmNode's inertia is rebuilt from its
parts rather than interpolated toward a longrange that moved.
`profile-schema-selftest` now refuses a part number that does not resolve, a KV
that disagrees with its catalogue entry, a `maxCurrent` off rule 3 and a
`propInertia` off rule 5. It cost two families their rise/settle target — see
item 3, which is the finding that lot produced.

*The blade, wired and left off.* `blade-element.js` goes into `quad.js` behind
`?aero=bem`, off by default and byte-identical when off, with
`tools/aero-model-compare.mjs` putting the two models side by side. Nothing is
switched over; items 1 and 2 stay open because what blocks them is data.

## The one number that says where the model stands

```
npm run tune          # 3 of 18 axis/family combinations outside target
```

It was 4 when this work started and reached 0; it is 3 again, and the reason is
written down rather than outstanding — one is the toothpick's yaw (item 4) and
two are longrange's roll and pitch, which left the target when its rotor stopped
being half its real weight (item 3). Every spec acceptance criterion passes.

**Twice, a tune that resisted turned out to be a machine that did not exist**:
on both the toothpick and longrange, a full P/D sweep on the old airframe
reached the target at NO point on the grid. If an axis will not tune, suspect
the profile before the gains.

And once now, the reverse — which is the harder lesson. longrange's roll left
the target the moment its rotor was given its real weight, and no gain in its
class brings it back. **A target met is not evidence the machine is right, and a
target missed is not evidence it is wrong.** Check which of the two is measured
and which is derived before deciding who to believe: here `propInertia` comes
from a catalogue mass and one rule, and the rise budget comes from a formula
that does not know rotors exist.

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

1. **`blade-element.js` is wired into `quad.js`, but only behind `?aero=bem`.**
   The default path is unchanged and BYTE-identical (proved by `cmp` on the 36
   replay traces, and by a selftest that compares 400 steps element by element),
   so the six tunes still describe the machine they were measured on. What the
   flag buys is that the edgewise term is now MEASURABLE where it could not be
   verified: `tools/aero-model-compare.mjs` puts the two models side by side.
   What it says, and what has to be settled before the default could move:
   - the blade gives **14-30% less thrust at hover** than `classic`, and every
     bit of that is `propLossFactor`, which has no equivalent in blade-element
     theory (its cd0 is fixed, it cannot see Reynolds). Either that factor
     describes something real the blade should learn, or it is standing in for
     something else. Until that is answered `hoverThrottle()` — derived from the
     classic model — and `bem` cannot coexist: at the stick the controller
     computes, the machine descends.
   - the blade's H-force is **13-30% of what `kLateral` applies**. `kLateral`'s
     own comment says it carries flapback lumped in, so the gap is expected;
     which of the two is right is not established.
   - an edgewise data source, or a measured hover-to-cruise thrust curve from
     the reference build. Still the real blocker. The UIUC tunnel is axial.
   - a full PID re-sweep, and roughly 2x the flight-model CPU (measured as
     replay wall time, not profiled per step).
2. **Translational rotor moments (#91, reverted by #103): handled, by not being
   added.** The edgewise term of blade-element theory IS this mechanism, so
   adding the moments separately would count the lift dissymmetry twice. What
   #103 reverted is now understood and measured: held full roll at 26-36 m/s
   took the worst off-axis rate from 1-2 deg/s to 115-222 deg/s, and removing
   the four contributions one at a time showed the two IN-PLANE MOMENTS were
   the whole of it (hub moment alone 76, rotor-plane lever arm alone 48-71;
   translational lift 2, precession 3). `bem` does not bring them back, and not
   by luck: blade-element returns a FORCE and no moment, and `quad.js` applies
   it at the hub, exactly where `kLateral` already acted. The #103 guard is now
   run against BOTH models by `tools/aero-model-compare.mjs`, and `bem` is equal
   or better than the default on every family, both axes.
3. **Heavy rotors cannot meet the tuner's rise/settle targets, and the targets
   are the reason.** New, and it is the cost of correcting `propInertia`.
   `tools/tune-pid.mjs:limitsFor()` derives its budget from the BODY's inertia
   against sustained torque (`tPhys = rate_max / alpha`) and counts the rotor's
   own spin-up nowhere — yet that spin-up now measures 11 ms on the cinewhoop
   and **40 ms on swarmNode, 49 ms on longrange**, against rise budgets of 68
   and 72 ms. An actuator eating two thirds of the budget cannot be out-gained
   in class: longrange's roll reaches the target only at P = 0.600, a loop gain
   (`P * torquePerMix / I`) of 287 where every 5-7" family sits between 29 and
   75. Two of the eighteen combinations `npm run tune` reports are outside
   for this reason (longrange, roll and pitch), and so are swarmNode's roll and
   pitch, which that count never covered — it walks FAMILIES, and swarmNode is
   deliberately outside the roster. **Every spec acceptance criterion passes** — which is the distinction: they are outside a
   target, not out of spec. The decision is whether the budget gains a rotor
   term, or heavy rotors gain their own grid the way micros have one. It was
   deliberately NOT taken in the lot that created it: a ruler must not be
   adjusted in the change that needs it.
4. **The toothpick's yaw, and the one line of policy behind it.** Characterised
   in full in `src/drone-profiles.js`: a full sweep is overshoot at every point
   with no D (23-33%) and 450-578 ms of ringing with any D, against a 107 ms
   limit, because `filterScale` deliberately does not touch yaw and the axis
   keeps a 5"'s 90 Hz gyro and 55 Hz D-term cutoffs on a micro. That policy was
   written before the gyro had noise in it. A design decision, not a sweep.

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
