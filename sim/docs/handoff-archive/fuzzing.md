# Fuzzing — what it is, what it found

Session of 2026-09-11. Added `sim/tools/fuzz.mjs` (pure modules),
`sim/tools/fuzz-api.mjs` (the HTTP surface, against a real server) and the
shared harness `sim/tools/lib/fuzz.mjs`. Both run in `npm run fuzz`, which
`selftest:ci` now includes.

## The idea

The selftests check what the code is supposed to do with the input it expects.
Fuzzing checks what it does with input nobody wrote a test for: a hand-edited
`localStorage` key, a half-written operator file, a gamepad axis at its stop, a
body state that went to NaN after a crash, an HTTP body that is not JSON.

It is property-based, not random clicking. Each target states an invariant the
code really promises — "never throws", "every number is finite", "no line a
player reads says NaN", "what the writer produces, the reader accepts" — and
the harness hunts for a counter-example, then shrinks it to something readable.
Everything is seeded: a finding replays with `--seed <n> --cases <n>`, and the
fixed default seed is what makes it a CI gate rather than a lottery.

**The threat model is per target, and it matters more than the generator.**
A function is only fed input it can really receive. `generateTargetScan()` is
not fuzzed with an out-of-range `swarmChance`, because `sanitizeScan()` is the
only way in and it rejects one; the validator gets fuzzed instead. A target
that ignores this produces findings nobody should act on, which is worse than
no fuzzing at all — every target's `note` says where its input comes from.

```bash
npm run fuzz                      # both, fixed seed, what CI runs
node tools/fuzz.mjs --list        # the targets and their threat models
node tools/fuzz.mjs --only flight --cases 20000 --seed 7 --verbose
node tools/fuzz-api.mjs --cases 2000
```

## What it found

Sixteen targets over the flight stack, the stored state, the terminal screens
and the HTTP routes. Everything below was found by the fuzzer, not by reading.

### Fixed

1. **One bad frame killed the flight controller for good.**
   `AxisPid` is a chain of running averages (`y += (x - y) * k`). Feed it one
   non-finite value — a stick from a broken calibration, a body state Rapier
   blew up on — and `y` is NaN forever: the motors stay NaN for the rest of the
   session, long after the input recovers. In `altitude` mode the same thing
   happened through `holdAltitude`, which outlives the frame that set it.
   Fixed at three points in `flightController.js`: the sticks are clamped at
   the documented boundary, a PID step that computes a non-finite output resets
   its own filters, and the mixer refuses a non-finite throttle. `clamp()` is
   not a guard here — every comparison against NaN is false, so NaN walks
   straight through it.

2. **A track could be written and never read back.** `encodeTrack()` accepted
   any finite sample, but quantization *multiplies* (`lat × 1e5`), so an absurd
   value overflowed to Infinity on the wire and `validateTrack()` then refused
   the file `encodeTrack()` had just written. The flight was lost at read time.
   A sample is now only storable if what lands on the wire is a safe integer.

3. **`String(v)` is not total, and six places assumed it was.**
   `{"area": {"toString": null}}` is valid JSON. `String()` on it throws
   `TypeError: Cannot convert object to primitive value`, so the session log
   died rendering a stored flight, and `validateSession` answered with an
   engine message instead of naming the field. Now `tools/lib/as-text.mjs`,
   used by `slugify`, `areaLabel`, `fit`, `familyLabel`, the session and track
   validators, and the row formatters.

4. **`KEY_LABELS[key]` returned inherited properties.** A stored key of
   `constructor` made `keyLabel()` hand the Settings screen
   `function Object() { [native code] }`; `__proto__` and `toString` likewise.
   Own-property lookup now. Same shape in `PROFILES[family]`, fixed with it.

5. **A stored `deadband: 1` read NaN at full stick.** `normalizeChannel()`
   rescales the travel left over the deadband, i.e. divides by `1 - deadband`.
   The live calibration clamps the value, but `isValidCalibration()` — the gate
   between the stored file and the motors — accepted any finite number. It now
   requires `0 <= deadband < 1`.

6. **A zero-width corridor divided by zero.** `progress()` in `geofence.js`
   returned NaN for a map with no extent, and `main.js` ramps the image loss on
   that number.

7. **`normalizeBenchConfig()` promised never to throw, and threw.** `Number()`
   throws on a symbol, a bigint, and on an object with no path to a primitive.

8. **`mergeTelemetry(null, …)` was a TypeError.** A default parameter only
   covers `undefined`, and `"flightTelemetry": null` is something a JSON file
   can hold — `closeSession()` died on it instead of closing the flight.

9. **`MAX SPEED Infinity m/s` on the session detail screen.** JSON has no
   Infinity literal, but `1e400` parses to one, and `(v ?? 0).toFixed(1)`
   prints it. Non-finite telemetry now renders as `—`.

### Left open, filed as issues

- **Telemetry has no upper bound** (#83). The client sends it and `validateSession`
  only asks for "finite and >= 0", so a `durationS` of 1e308 is storable
  today — and adding it to itself overflows: the session can then never be
  closed (`closeSession` produces something the validator refuses) and the DATA
  screen reports a career of Infinity seconds. Picking the bound is a product
  decision, not a fuzzing one.
- **An oversized body gets a connection reset, not a 400** (#84). `readBody()`
  destroys the request as soon as it passes the cap, so the answer never
  arrives. Only abusive bodies reach it — photos and tracks have the 8 MB cap —
  and holding the connection open to answer politely is what an abusive body
  wants, so it is a deliberate trade-off to confirm rather than a bug to fix
  blind.
- **`scanner-model.mjs` has the same `String(v)` pattern** (#85) over provider JSON
  (Nominatim, the imagery providers). Not fuzzed here — that surface needs a
  fake provider first — but it is the same defect as finding 3.

### What held up

The HTTP surface, over thousands of malformed requests: no 5xx, no answer that
is not JSON, no leaked filesystem path or stack frame, no file outside the data
directory, no prototype pollution, and the operator file still parseable after
every one of them. The id regexes (`ID_RE`, `SESSION_ID_RE`) stop every
traversal attempt before it reaches a path. `?scene=` and `?swarm=` refuse
everything they cannot honour and never echo the raw value back into a message.
`quad.js` stayed finite and in range under every in-contract input; so did the
mixer, the battery and the geofence.

## Adding a target

A target is `{ name, note, gen(rnd, index), check(input) }`. `check` returns a
string naming the broken invariant, or `null`. Write the `note` first: it is
where the input comes from, and it decides what the generator is allowed to
produce. Then state an invariant the code actually promises — a target that
asserts something the code never claimed just files noise against its author.
