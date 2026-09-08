# Pre-release polish — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the sixteen decisions of the pre-release polish spec on branch `pre-release-polish`, each one covered by a selftest that runs in `npm run selftest:ci`.

**Architecture:** Every feature keeps the repo's split "pure model in a `.js`/`.mjs` module with no DOM, a render/wire function that only paints, a selftest on the model plus one on the fake DOM (`tools/lib/fake-dom.mjs`)". Terminal screens are built from `button()` / `navRow()` / `menuNav()` in `terminal.js`; flight overlays live in `fpvtp-osd.js` and are decided in `flight-end.js`; input goes `input.js → onAction(name)` into `main.js`.

**Tech Stack:** Vite, Three.js (OrbitControls from `three/examples/jsm`), Rapier, plain DOM, Node `assert` selftests chained in `sim/package.json:selftest:operator`.

**Spec:** `sim/docs/superpowers/specs/2026-09-08-pre-release-polish-design.md` — read it first, every task references its decision number (D1…D16).

## Global Constraints

- All code, comments, copy and docs in English (CLAUDE.md). On-screen copy is UPPERCASE terminal style like the existing screens.
- No new npm dependency.
- Never `Read` anything under `sim/public/scenes/`.
- `npm run selftest:ci` (from `sim/`) must pass before every commit that touches a selftest chain; run the individual selftest of the task for the red/green cycle.
- New selftests are appended to `selftest:operator` in `sim/package.json`.
- No demo palette colours (`--cyan/--magenta/--violet/--electric`) on daily screens: `tools/palette-selftest.mjs` enforces it.
- Commit messages follow the repo style (`feat(scope): …`, `fix(scope): …`, `docs: …`, `refactor(scope): …`) and end with the Co-Authored-By / Claude-Session trailer given by the session.
- Every task adds its line under `## [Non publié]` in `CHANGELOG.md` (root), French rubric headings as they are (`Ajouté`, `Modifié`, `Corrigé`, `Retiré`), entry text in the CHANGELOG's existing language (French).
- GitHub issue for each task is given; move it to In Progress when starting, close it when the task is merged on the branch (`gh issue close N`).

## Dependency order

```
T1 version (#9)       ─┐
T2 sun (#11)           ├─ independent, can run in parallel (disjoint files)
T3 live archive (#8)  ─┘
T4 landing removal (#10)         ← before anything else touching main.js / input.js / flight-end.js
T5 key map model + input (#14)   ← after T4
T6 chase view (#12)              ← after T5 (uses action `view`)
T7 drone viewer at flight end (#13) ← after T4
T8 terminal restructure (#6, #7) ← after T1 (version line) and T4 (RESUME button gone)
T9 settings panel with tabs (#15) ← after T5, T8
T10 briefing (#16)               ← after T9 (REPLAY BRIEFING button), T5 (key map rows)
T11 docs, changelog, visual pass, PR
```

---

### Task 1: The real version on screen (D8, #9)

**Files:**
- Create: `sim/src/version.js`
- Modify: `sim/src/main.js:65-69`, `sim/src/fpvtp-osd.js:14,45`, `sim/src/bootstrap.js:161`, `sim/src/terminal.js:694`
- Test: `sim/tools/version-selftest.mjs` (new)

**Interfaces:**
- Produces: `export const APP_VERSION` (string, `'dev'` outside Vite), `export function versionLine()` → `` `FPVTP! // v${APP_VERSION}` `` (returns `FPVTP! // dev` when `APP_VERSION === 'dev'`, no `v`).

- [ ] Write `tools/version-selftest.mjs` with two tests: `versionLineFor('0.0.0') === 'FPVTP! // v0.0.0'`, `versionLineFor('dev') === 'FPVTP! // dev'`. Export a pure `versionLineFor(v)` from `version.js` and have `versionLine()` call it with `APP_VERSION`. Run it, see it fail (module missing).
- [ ] Create `src/version.js`; make the test pass.
- [ ] Replace the three literals: `fpvtp-osd.js` deletes `FPVTP_VERSION` and prints `versionLine()` in `#fo-ident`; `bootstrap.js:161` and `terminal.js:694` use `versionLine()`. `main.js` imports `APP_VERSION` for `window.FPVTP_VERSION` and the console line. `grep -rn "0.97b" src tools` must only hit `motion.js` and `motion-selftest.mjs`.
- [ ] Chain the selftest in `package.json`; run `npm run selftest:ci`; commit `feat(version): the package version replaces the 0.97b lore constant on screen`.

### Task 2: The sun darkens less (D10, #11)

**Files:**
- Modify: `sim/src/sun.js:437,445`, `sim/src/lens.js:122`, `sim/tools/selftest.mjs` §soleil (around line 2376)

- [ ] In `tools/selftest.mjs` §soleil, change the closing assertion to a two-sided bound: after `sunInFrame = 1` settles, `exposure < 0.75 × before` **and** `exposure > 0.55 × before`. Run `node tools/selftest.mjs` only if a scene is installed; otherwise the AGC block is pure — check whether it is reachable without a scene. If the §soleil block needs a scene, extract the AGC assertions into `tools/sun-agc-selftest.mjs` (pure, `SunField` only) and chain it. Run: must fail on the old constants (0.35 floor closes below 0.55).
- [ ] `sun.js`: `E_MIN = 0.60`, `SUN_METER_WEIGHT = 1.5`, update the comments with "revised 2026-09-08: playable against the sun". `lens.js`: `SUN_VEIL = 0.14`.
- [ ] Run the selftest green; commit `fix(sun): the iris closes less — playable while facing the sun`.

### Task 3: Prove LIVE flights fill the archives (D7, #8)

**Files:**
- Modify: `sim/tools/session-log-selftest.mjs`, `sim/src/main.js:2999-3057` (comment only), `sim/src/session-log.js` / `tools/session-log-model.mjs` only if a bug appears

- [ ] Add tests to `session-log-selftest.mjs` using the model's existing fixtures: a session `{ area: liveAreaId('Paris', 48.85, 2.35), result: 'CRASHED', target: {...} }` with `areas: []` → appears in the SESSION LOG rows, in the TARGET LOG rows, is counted by the OPERATOR model (`sessions.length`), its row label shows `PARIS` (or whatever the model derives from `live-Paris`), and the row exposes neither `revisit` nor `resume`. Run; fix the model/render only if something is actually wrong.
- [ ] Add a one-line comment above `if (OPTS.live) return;` in `openFlightSession()`: `// Dev-only ?live= shortcut. A LIVE flight chosen from the terminal opens a session below (#218).`
- [ ] Commit `test(session-log): live flights are logged, counted and never revisitable`.

### Task 4: Remove landing (D9, #10)

**Files:**
- Modify: `sim/src/flight-end.js`, `sim/src/main.js`, `sim/src/input.js`, `sim/src/terminal.js:373-377`, `sim/src/session-log.js:265`, `sim/tools/session-model.mjs`, `sim/tools/session-log-model.mjs`, `sim/server/api.mjs` (comments), `sim/src/style.css:201`, `sim/src/fpvtp-osd.js:177`, `sim/src/music.js:185`, `sim/src/physics.js:425` (comment), `sim/package.json`, `CLAUDE.md:136`, `docs/manuel.md:512`, docs notes
- Delete: `sim/src/post-flight.js`, `sim/tools/post-flight-model.mjs`, `sim/tools/post-flight-selftest.mjs`, `sim/tools/landing-selftest.mjs`
- Test: `sim/tools/flight-end-selftest.mjs`, `sim/tools/session-log-selftest.mjs`, `sim/tools/session-api-selftest.mjs`

**Interfaces:**
- Produces: `FlightEnd` phases are `FLYING | CRASHING | TERMINATED`; `flightEnd.update(...)` keeps `out.cuttable`, `out.stuck`, `out.exitArmed`, `out.lines`; `closes` is only ever `'CRASHED'`. `SESSION_RESULTS` for new sessions = `['CRASHED']` (plus whatever "open" value exists). `IDLE_THROTTLE` exported from `flight-end.js` is gone; the physics ground-hold reads `idleThrottle(profile)` directly (already imported in `main.js`).

- [ ] Tests first: in `flight-end-selftest.mjs` delete the landing tests (`:123-210`), add: "a grounded quad under idle throttle for `STUCK_S` still raises `out.stuck` (the K reminder survives the removal)"; "there is no `LANDING_READY`/`LANDED` export" (`assert.equal(typeof mod.LANDED, 'undefined')`). In `session-log-selftest.mjs` and `session-api-selftest.mjs` drop the LANDED/resume cases and add "an old session file with `result: 'LANDED'` still renders a row (no crash, no migration)". Run: red.
- [ ] `flight-end.js`: remove per spec D9; move the stuck logic from `_advanceLanding()` into `update()` so it runs whenever `phase === FLYING`. Keep `V_STUCK`, `W_STUCK`, `STUCK_S` and give `V_STUCK`'s comment its own justification (it referenced `LANDING.V_ON`).
- [ ] `main.js`: remove `doDisarm`, the `disarm` action, `flightEnd.landing.THR_IDLE = …` (three sites), `LANDING`/`LANDING_READY` imports, the `LANDED` branch of `finishSession()` (so `runPostFlightAnalysis` and the `post-flight.js` import go), `closes === 'LANDED'` music fade, `?resume=` option, `setSessionStatus('TARGET STATUS…LANDED')`. The `touchdown` block keeps its behaviour with `idleThrottle(physics.profile)` in place of `flightEnd.landing.THR_IDLE`. Fix the two `phase === FLYING || phase === LANDING_READY` conditions to `phase === FLYING`.
- [ ] `input.js`: remove the `j` key branch and the gamepad disarm gesture (`:708-717` and the stick-hold detection around `:805`); remove `'disarm'` from any action list.
- [ ] Session layer: `session-model.mjs` (`SESSION_RESULTS`, `resumeSession()`, `closeSession` verdict check), `session-log-model.mjs` (`SESSION_FILTERS`, filter case), `session-log.js:265` credo → `A CRASHED TARGET IS LOST. THE LOG IS WHAT REMAINS.`, `terminal.js:373-377` RESUME button and the `{ slug, resume }` propagation (leave `slug` REVISIT). `server/api.mjs` comments. Reading old `LANDED` sessions must still work (test above).
- [ ] Delete the four files; remove `post-flight-selftest.mjs` and `landing-selftest.mjs` from `selftest:operator`; `style.css` `[data-kind="landed"]`, `fpvtp-osd.js:177` comment, `music.js` `FADE.landed`, `physics.js:425` comment.
- [ ] Docs: CLAUDE.md and `docs/manuel.md` now cite `tools/entry-state-selftest.mjs` as the SKIP pattern. Add dated notes (not rewrites): Bible near line 1038/1060/1768, Roadmap PHASE 14 §Landing (`:926-929`), `fpv-rework-architecture.md:85` — "Revised 2026-09-08 — landing removed; a flight ends by crash, geofence exit or the pilot cutting the link (hold K)." CHANGELOG `Retiré`.
- [ ] `npm run selftest:ci` green; commit `refactor(flight): remove landing — a flight ends by crash, fence or a cut link`.

### Task 5: Remappable key map — model and input wiring (D13, #14)

**Files:**
- Create: `sim/src/key-map.js`, `sim/tools/key-map-selftest.mjs`
- Modify: `sim/src/input.js:337-378,802-881`, `sim/src/main.js:1330-1349,1948`

**Interfaces:**
- Produces from `key-map.js` (pure, no DOM, no storage):
  ```js
  export const KEY_ACTIONS = [ { id:'throttleUp', label:'THROTTLE UP', group:'flight', hold:true }, … ]
  // ids: throttleUp throttleDown yawLeft yawRight rollLeft rollRight pitchDown pitchUp
  //      cutLink pause view photo cyclePreset cycleMode benchPanel respawn
  export const DEFAULT_KEY_MAP = { throttleUp: ['w','z'], throttleDown: ['s'], yawLeft: ['a','q'], yawRight: ['d'], rollLeft: ['arrowleft'], rollRight: ['arrowright'], pitchDown: ['arrowup'], pitchUp: ['arrowdown'], cutLink: ['k'], pause: [' '], view: ['v'], photo: ['f'], cyclePreset: ['p'], cycleMode: ['m'], benchPanel: ['b'], respawn: ['r'] }
  export const KEY_MAP_STORAGE = 'fpvtp.keyMap'
  export function loadKeyMap(raw)              // JSON string | null → map (defaults merged, unknown ids dropped, invalid → defaults)
  export function actionForKey(map, key)       // lowercase KeyboardEvent.key → action id | null
  export function rebind(map, actionId, key)   // → { map, swappedWith: actionId | null }  (the key becomes the ONLY key of actionId; a conflicting action takes actionId's former primary key)
  export function keyLabel(key)                // 'arrowup' → '↑', ' ' → 'SPACE', 'k' → 'K'
  export function keyMapRows(map)              // [{ id, label, keys: ['W','Z'] }] in KEY_ACTIONS order, for Settings and the briefing
  ```
- `Input` gains `setKeyMap(map)`, `getKeyMap()`, `isHeld(actionId)`; `keydown` calls `this.onAction(actionId, e)` with the action id instead of the raw key. `escape`, `enter`, `tab` still pass through as themselves (they are not in the map).

- [ ] `key-map-selftest.mjs` (≥ 8 tests): defaults complete for every `KEY_ACTIONS` id; no key used twice in the defaults; `actionForKey` finds `z` and `w` for `throttleUp`; `rebind` on a free key replaces the list; `rebind` on a key held by another action swaps and reports `swappedWith`; `loadKeyMap('garbage')` and `loadKeyMap('{"pause":42}')` fall back to defaults for the bad entries; `keyLabel` table; `keyMapRows` order equals `KEY_ACTIONS` order. Run: red.
- [ ] Implement `key-map.js`; green.
- [ ] Wire `input.js`: load `fpvtp.keyMap` at construction (defensive like `loadCalStore`), `readKeyboard()` uses `isHeld('throttleUp')` etc. instead of literals, `keydown` dispatches `actionForKey`. `main.js`: switch on action ids (`pause`, `cyclePreset`, `cycleMode`, `photo`, `benchPanel`, `respawn`, later `view`), and `cutHeld: !MODE.bench && input.isHeld('cutLink')`. `input-selftest.mjs` keeps passing (pure exports only).
- [ ] Chain, `selftest:ci`, commit `feat(input): keyboard actions go through a remappable key map`.

### Task 6: FPV / CHASE view toggle (D11, #12)

**Files:**
- Create: `sim/src/chase-camera.js`, `sim/tools/chase-camera-selftest.mjs`
- Modify: `sim/src/main.js` (remove `freeCam`, `toggleFreeCam`, `FREE_CAM_BACK_M`, the per-frame `freeCam.update()`; add the chase placement), `sim/src/fpvtp-osd.js` (top-right `[V] FPV` / `[V] CHASE` element, clickable), `sim/src/onboard-drone.js:95-99` (`setFreeCam` → `setChase`), `sim/src/style.css`

**Interfaces:**
- Produces `chase-camera.js` (pure, Three-free — takes plain vectors):
  ```js
  export const CHASE = { back: 1.6, up: 0.6, tau: 0.12 }
  export function chaseTarget(dronePos, yawRad)                       // → { x, y, z } desired camera position
  export function chaseStep(current, desired, dt, tau = CHASE.tau)  // exponential smoothing, → { x, y, z }
  ```
  `main.js` holds `viewMode = 'fpv' | 'chase'`, `setView(mode)`, and `fpvtpOsd.setView(mode, onToggle)`.
- Consumes: action id `view` from Task 5.

- [ ] Selftest: `chaseTarget` is behind the heading (dot product with the forward vector negative) and above; `chaseStep` converges (after 1 s at dt=1/60 the distance to desired is < 1 % of the initial); `chaseStep` with `dt = 0` returns `current`. Red → implement → green.
- [ ] `main.js`: on `view` action or OSD click → `setView(viewMode === 'fpv' ? 'chase' : 'fpv')`; each frame in chase: compute desired from `physics.position` and the drone's yaw (from its quaternion), smooth, `camera.position.set(...)`, `camera.lookAt(drone)`; `playerDrone.setChase(true)` shows the world mesh, hides the onboard pass; `lens.render(camera, dt, viewMode === 'chase' ? null : linkOut)`. `simFrozen()` no longer includes any camera flag. Reset to `fpv` at every flight start. Remove `OrbitControls` import from `main.js` if unused afterwards.
- [ ] OSD: `#fo-view` in the TR corner, text `[V] FPV` / `[V] CHASE`, `pointer-events: auto`, click toggles; hidden while the flight-end screen is up.
- [ ] Check LIVE (`bootLive`) and BENCH paths compile through the same `setView`. `selftest:ci`, commit `feat(view): FPV / CHASE toggle replaces the freezing free cam`.

### Task 7: A rotatable 3D drone on every end screen (D12, #13)

**Files:**
- Create: `sim/src/drone-viewer.js`, `sim/tools/drone-viewer-model.mjs`, `sim/tools/drone-viewer-selftest.mjs`
- Modify: `sim/src/fpvtp-osd.js:109-127,249-256`, `sim/src/flight-end.js:83-121`, `sim/src/drone-profiles.js`, `sim/src/main.js` (the three nominal paths: `?family=` ~2746, `?scene=` ~2562, bench ~2853)
- Test: `sim/tools/flight-end-selftest.mjs`, `sim/tools/drone-portrait-render-selftest.mjs`

**Interfaces:**
- `tools/drone-viewer-model.mjs`: `export const VIEWER = { turnS: 24, pitchDeg: 28, startDeg: 30, size: 220 }`, `export function viewerOrbit({ tMs, dragDeg })` → `{ azimuthDeg, polarDeg }` (auto-rotate plus the accumulated drag).
- `drone-profiles.js`: `export function nominalBuildSeed(family)` → deterministic 32-bit int from the family string (FNV-1a), documented as "the seed a NOMINAL build wears so every flight has a portrait".
- `drone-viewer.js`: `export function droneViewer({ family, buildSeed, size = VIEWER.size, createRenderer })` → `{ el, stop }`; `createRenderer` is injectable (defaults to `new WebGLRenderer({ alpha: true, antialias: true })`); when it throws, returns `null` so the caller falls back to `dronePortrait()`.

- [ ] Tests: `flight-end-selftest.mjs` — every exported timeline (`TIMELINE`, `FENCE_TIMELINE`, `CUT_TIMELINE`) contains exactly one `PORTRAIT_LINE`. `drone-viewer-selftest.mjs` — `nominalBuildSeed` is stable and differs per family; `viewerOrbit` advances `360 / turnS` deg per second and adds drag; `droneViewer` with a fake `createRenderer` (returns an object with `setSize`, `render`, `dispose`, `domElement = fakeDom.createElement('canvas')`) mounts a canvas and `stop()` disposes; with a throwing `createRenderer` returns `null`. `drone-portrait-render-selftest.mjs` — a portrait exists for each of the six families with `nominalBuildSeed(family)`. Red.
- [ ] Implement model, seed, viewer (own scene, `AmbientLight` + one `DirectionalLight`, `OrbitControls` with `autoRotate`, `autoRotateSpeed` derived from `turnS`, `enableZoom = false`, `enablePan = false`, render on a rAF loop, `stop()` cancels and disposes renderer + geometry + material).
- [ ] `fpvtp-osd.js`: `_portraitNode()` → viewer, fallback SVG. Gamepad right-stick nudge: in `update()` when the end screen is up, read `input.gamepadAxes?.()` if such an accessor exists, otherwise skip this sub-point and note it in the commit body. `main.js`: assign `flightBuildSeed = nominalBuildSeed(family)` on the three nominal paths. `flight-end.js`: add `[offset, PORTRAIT_LINE]` to the fence and cut tables at blackout+0.9 s like the crash table.
- [ ] `selftest:ci`, commit `feat(flight-end): a rotatable 3D drone on every end screen`.

### Task 8: Terminal restructure (D1, D2, D3, D4, D5, D6, D15 — #6, #7)

**Files:**
- Modify: `sim/src/bench.js:84-147` (root screen, four entries), `sim/src/terminal.js` (head line, tabs order + LOCAL notice, tail row, footer, keyHints, archive row), `sim/tools/terminal-model.mjs:37-45` (footer), `sim/tools/bench-model.mjs:46-56,268` (`MODE_SELECT` four entries), `sim/src/scanner.js:103-116` (hint removed), `sim/src/main.js:2617-2625,2673-2720` (root loop routes `archive` and `settings`), `sim/src/style.css` (`.terminal-keys`, `.terminal-tab[data-off]`, `.terminal-notice`)
- Test: `sim/tools/terminal-selftest.mjs`, `sim/tools/terminal-render-selftest.mjs`, `sim/tools/archive-render-selftest.mjs`, `sim/tools/bench-render-selftest.mjs`, `sim/tools/bench-selftest.mjs`

**Interfaces:**
- `terminal.js`: `export function keyHints(pairs)` → element `.terminal-keys` with text `[ESC] BACK · [TAB] SETTINGS` from `[['ESC','BACK'],['TAB','SETTINGS']]`; `export function archiveScreen(root, api)` becomes callable from the root loop and resolves like `fieldLoop` (a `{ slug }` for REVISIT, `null` on back).
- `bench-model.mjs`: `MODE_SELECT.modes = ['field','bench','archive','settings']` with titles/subtitles; `selectOperationMode()` returns one of the four.
- `terminal-model.mjs`: `footer = [acquire ? 'LOCAL INSTALLATION' : 'SHARED SERVER', `BUILD ${build}`].join(' · ')`; the function takes `acquire` (default `true`).
- `main.js` root loop: `archive` → `await archiveLoop(ui)` (returns a flight choice or null), `settings` → `settings.toggleSettings(true)` then wait for close, back to root.

- [ ] Tests first (all on the fake DOM): `bench-render-selftest` — the root has four buttons in order FIELD, BENCH, ARCHIVE, SETTINGS; cursor lands on the last used (`fpvtp.mode = 'archive'`). `terminal-render-selftest` — no `MODE` button ever; no `OPERATOR` text in the head or footer; tabs are `LIVE` then `LOCAL` and `LIVE` has `data-on="true"` on first entry; with `acquire: false` the LOCAL body contains `NOT AVAILABLE ON THIS SERVER` and the tab has `data-off="true"`; `.terminal-keys` contains `[ESC]`; no `ARCHIVE`/`SETTINGS` button in FIELD; no `NEEDS THE LINK` anywhere. `terminal-selftest` — footer strings. `archive-render-selftest` — reaches ARCHIVE from the root button, `closeAll()` uses one `back` per level, no `SETTINGS` in the archive row, `.terminal-keys` present. Red.
- [ ] Implement per spec D1–D6, D15. The LOCAL notice is three lines in a `<pre class="terminal-notice">` (text per spec D2). Delete the `DESKTOP CLIENT AVAILABLE` footer hint and the `NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY` variant (keep `NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP` when acquisition is open). `bench-model.mjs:268` → `NO LOCAL TERRAIN — SWITCH TO LIVE, OR ACQUIRE ONE IN FIELD`.
- [ ] Remove the `SETTINGS` links from the BENCH footer (`bench.js:393`) and the FIELD footer; remove `ARCHIVE` from the LOCAL tail row; remove the `STREAMED NOW…` hint.
- [ ] `selftest:ci`, commit `feat(terminal): FIELD · BENCH · ARCHIVE · SETTINGS at the root, LIVE first, ESC named on every screen`.

### Task 9: Settings panel in the terminal art direction, with tabs (D13 UI, D14 — #15)

**Files:**
- Modify: `sim/src/settings.js` (template `:107-159`, `toggleSettings`, new `renderKeyboard()`, tab state), `sim/src/style.css:253-313,817-860`
- Create: `sim/tools/settings-render-selftest.mjs`

**Interfaces:**
- Consumes: `keyMapRows`, `rebind`, `keyLabel`, `KEY_MAP_STORAGE` from Task 5; `input.setKeyMap()`; `keyHints()` from Task 8; `versionLine()` from Task 1.
- Produces: `settings.onReplayBriefing = null` (a callback slot Task 10 fills; the `[ REPLAY BRIEFING ]` button is rendered only when the slot is set); `settings.open(tab)` (`'controller' | 'keyboard' | 'audio' | 'system'`) which is `toggleSettings(true)` plus tab selection.

- [ ] Selftest on the fake DOM (`Settings` needs `#ui` — construct it with the fake document, as `terminal-render-selftest` does for the terminal): the panel has a `.terminal-tabs` strip with `CONTROLLER, KEYBOARD, AUDIO, SYSTEM` in order; only one tab body is visible at a time; `open('keyboard')` shows one row per `KEY_ACTIONS` entry with the default labels; clicking a row's `[ REBIND ]` then dispatching `keydown` `x` rebinds and persists to `fpvtp.keyMap`; a conflicting key swaps and the row shows `SWAPPED WITH …`; `[ RESET KEYS ]` restores defaults; the `.terminal-keys` row reads `[ESC] CLOSE · [TAB] CLOSE`; SYSTEM shows `versionLine()`; the Reset settings button still needs two presses. Red.
- [ ] Rebuild the template: `FPVTP! // SETTINGS` display header (`.t-display`), tab strip (reuse `.terminal-tabs` / `.terminal-tab` CSS, `data-on`), four `<section data-tab="…">` bodies, key-hint row at the bottom. Move the existing controller/calibration markup into the CONTROLLER section unchanged (ids preserved so `startCalibration`/`renderCalibration` keep working). Keyboard capture: a module-level `capturing = actionId | null`; while capturing, the panel's `keydown` listener (capture phase, `stopPropagation`) takes the next key, `Escape` cancels; the row text shows `PRESS A KEY — ESC CANCELS`.
- [ ] Style: `#settings .panel` uses `--black` ground, `--rule` borders, `.t-ui` labels, `.t-data` values; remove the `Close (Tab)` button. Run `tools/palette-selftest.mjs`.
- [ ] Chain, `selftest:ci`, commit `feat(settings): the panel in the terminal art direction — CONTROLLER · KEYBOARD · AUDIO · SYSTEM`.

### Task 10: The briefing (D16, #16)

**Files:**
- Create: `sim/src/briefing.js`, `sim/tools/briefing-model.mjs`, `sim/tools/briefing-selftest.mjs`, `sim/tools/briefing-render-selftest.mjs`
- Modify: `sim/src/bootstrap.js` (call the briefing after `registeredScreen`), `sim/src/main.js` (`settings.onReplayBriefing`, first-flight hints feed), `sim/src/fpvtp-osd.js` (`#fo-hint`, `setHint(text|null)`), `sim/src/settings.js` (button wiring only), `sim/src/style.css`, Bible §2 and Roadmap PHASE 13 (dated revision notes), `docs/manuel.md` (one paragraph)

**Interfaces:**
- `tools/briefing-model.mjs` (pure):
  ```js
  export const BRIEFING_SEEN_KEY = 'fpvtp.briefingSeen', FIRST_FLIGHT_KEY = 'fpvtp.firstFlightDone'
  export function shouldBrief(store)                     // store = { getItem } | null → boolean (null store → false: never block a broken browser)
  export function markBriefed(store), markFirstFlight(store)
  export function briefingScreens({ input, keyRows })   // input = { kind: 'gamepad'|'keyboard', name } → [{ id, title, rows: [[label, value]…], actions: ['calibrate'|'mapKeys'|'continue'] }] — four screens per spec D16
  export function flightHint({ tFlight, armed, airborneOnce, tSinceTakeoff, bench, firstFlight }) // → 'THROTTLE UP' | '[TAB] SETTINGS' | '[HOLD K] CUT LINK' | null
  ```
- `briefing.js`: `export async function runBriefing(root, { input, keyRows, openSettings })` — terminal screens built with `revealLines`/`dotted` from `bootstrap.js` (export them if they are module-private), `[ CONTINUE ]`, `keyHints([['ESC','SKIP BRIEFING']])`, Escape resolves immediately.
- Consumes: `keyMapRows()` (Task 5), `settings.open('controller'|'keyboard')` (Task 9), `keyHints()` (Task 8).

- [ ] Model selftest: four screens in order `INPUT, THE TERMINAL, A SESSION, BRIEFING COMPLETE`; the INPUT screen rows for a keyboard equal `keyMapRows(DEFAULT_KEY_MAP)` labels; for a gamepad they name sticks; `shouldBrief` true when the key is absent, false when set, false with a null store; `flightHint` returns `THROTTLE UP` before take-off, `[TAB] SETTINGS` for 6 s after take-off, `[HOLD K] CUT LINK` from 30 s, `null` when `bench` or not `firstFlight`. Render selftest: screens mount with `[ CONTINUE ]` and the ESC hint; Escape resolves. Red → implement → green.
- [ ] Wire: `bootstrap.js` runs the briefing after registration (and `markBriefed`); `main.js` sets `settings.onReplayBriefing = () => runBriefing(...)`; per frame `fpvtpOsd.setHint(flightHint({...}))`; `markFirstFlight` when a non-bench session ends. `#fo-hint` styled like `#fo-cut`.
- [ ] Docs: Bible §2 after "Le jeu ne l'interdit pas. Le joueur décide." and Roadmap PHASE 13 "Pas de tutoriel." get the dated note from spec D16; Bible §31 lists the four Settings tabs as now built. `docs/manuel.md` gets a short "Briefing" paragraph (where it runs, how to replay, the two storage keys).
- [ ] Chain both selftests, `selftest:ci`, commit `feat(briefing): a first briefing after registration, replayable from Settings, three hints on the first flight`.

### Task 11: Close out

- [ ] CHANGELOG: check every task left its line under `## [Non publié]`; group by rubric.
- [ ] `HANDOFF.md` (sim/): update the "verified" list with the new selftests and the removal of landing; no narrative.
- [ ] Visual pass with the chrome-devtools MCP against `npm run dev` (scenes are installed locally): root screen, FIELD LIVE/LOCAL, ARCHIVE, Settings four tabs, a crash end screen with the 3D viewer, chase view, the briefing (`localStorage.removeItem('fpvtp.briefingSeen')` then replay from Settings). Screenshot each into the scratchpad; fix what is visibly wrong.
- [ ] `npm run build` and `npm run selftest:ci` green; push the branch; open the PR `Pre-release polish` listing the eleven issues (`Closes #6 … #16`), with the screenshots attached as a summary table.

## Self-review

- Spec coverage: D1/D3/D4/D6/D15 → T8; D2/D5 → T8; D7 → T3; D8 → T1; D9 → T4; D10 → T2; D11 → T6; D12 → T7; D13 → T5 + T9; D14 → T9; D16 → T10. Navigation diagram → T8. Testing section → every task + T11.
- Names used across tasks: `versionLine()` (T1→T9), `keyMapRows/rebind/keyLabel/KEY_MAP_STORAGE` (T5→T9→T10), `keyHints()` (T8→T9→T10), `settings.open(tab)` and `onReplayBriefing` (T9→T10), action id `view` (T5→T6), `nominalBuildSeed` (T7 only), `PORTRAIT_LINE` (existing).
