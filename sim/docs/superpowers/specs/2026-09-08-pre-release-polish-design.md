# Pre-release polish — design

2026-09-08. Fifteen points raised by the author after a full play-through,
before the first serious release. This document records the decisions taken
for each point, and why. The brainstorm was run in one pass, autonomously, on
the author's instruction ("refine, then execute without asking; I review
tomorrow"): every ambiguity below is resolved with a stated assumption rather
than a question.

Everything here is verified against the code on 2026-09-08 (three exploration
passes over `terminal.js`, `bench.js`, `flight-end.js`, `fpvtp-osd.js`,
`input.js`, `settings.js`, `sun.js`, `lens.js`, `main.js`, and the selftests).

## Where the game stands (facts that shaped the decisions)

- **There is no FIELD / BENCH / ARCHIVE tab bar.** The root screen
  (`SELECT OPERATION MODE`, `bench.js:84-147`) offers FIELD and BENCH. ARCHIVE is
  a link buried in the LOCAL tab of FIELD (`terminal.js:777-785`), so it
  vanishes whenever the LIVE tab is selected. SETTINGS is a link repeated in the
  FIELD footer, the ARCHIVE row and the BENCH footer.
- **The `MODE` link** in the FIELD footer (`terminal.js:809-812`) only goes back
  up to the root; Escape does exactly the same thing.
- **Live flights are archived.** `openFlightSession()` (`main.js:2999-3057`)
  opens a session for LIVE flights since #218; the only difference is the area
  id (`live-<place>` from `session-log-model.mjs:liveAreaId`), which
  intentionally disables REVISIT/RESUME. The hint `STREAMED NOW · NOTHING KEPT ·
  NEEDS THE LINK` (`scanner.js:114`) is therefore false.
- **The flight-end wireframe is only on the crash timeline.** `PORTRAIT_LINE`
  exists in `TIMELINE` (`flight-end.js:41`) and not in the fence, cut or landing
  tables. And `dronePortrait()` returns `null` without a `buildSeed`
  (`drone-portrait.js:23`), which is the case for every NOMINAL profile flight
  (`?family=` without `?build=`, `?scene=`, bench without airframe seed). Both
  causes explain "not all drones show the wireframe".
- **The `c` free cam** (`main.js:1559-1583`) is an `OrbitControls` orbit that
  freezes the simulation, and is inert in LIVE mode because `bootLive()` never
  creates `freeCam`. There is no chase camera.
- **Keyboard keys are literals** in `input.js:350-368` and `readKeyboard()`
  (`input.js:802-881`), plus `input.keys.has('k')` in `main.js:1948`. No model,
  no storage, no UI. The gamepad side has all three (`fpvtp.gamepadCal`,
  `calibration.js`, the wizard in `settings.js`).
- **The version on screen is lore.** `FPVTP_VERSION = '0.97b'`
  (`fpvtp-osd.js:14`), hardcoded again in `bootstrap.js:161` and
  `terminal.js:694`. The real version reaches the browser as `__APP_VERSION__`
  (`vite.config.js:15`) and is only logged (`main.js:65-69`).
- **The sun's darkening** is the AGC in `sun.js:418-586`: `E_MIN = 0.35`
  (floor), `SUN_METER_WEIGHT = 3.0` (how hard the disc closes the iris),
  `SUN_VEIL = 0.22` in `lens.js:122`. `tools/selftest.mjs` §soleil asserts the
  closing ratio.
- **Escape works everywhere and is named nowhere.** Every menu screen has
  `back` on Escape/Backspace/gamepad B (`menu-nav.js:192`); Settings closes on
  it; flight end accepts it. The only key names on screen are `[ENTER]
  DISCONNECT`, `[R] REDEPLOY`, `[HOLD K] CUT LINK`, `PRESS SPACE`, `Close (Tab)`.
- **Onboarding today** is the hardware probe + operator name + control vector
  (`bootstrap.js`). The Bible §2 ("information, not assistance") and Roadmap
  PHASE 13 ("no tutorial" at the entry into flight) are the passages the author
  has chosen to revise. Bible §11 already lists `onboarding` as an English
  text surface and §31 expects `CONTROLS / GAMEPAD / KEYBOARD` groups in
  Settings that do not exist yet.

## Decisions

Numbered as the author listed them.

### D1 — FIELD tab: no operator name, no counters

- The `FPVTP! // 0.97b / OPERATOR // <name>` header of FIELD
  (`terminal.js:693-695`) keeps only its first line, `FPVTP! // <version>` (see
  D8). The root screen keeps its `OPERATOR // <name>` line (`bench.js:99-104`):
  it is the one place the operator is greeted.
- The footer built by `terminal-model.mjs:37-45` drops `OPERATOR <name>`,
  `N LOCAL AREAS`, `N SESSIONS`, `N TARGETS LOGGED`. It becomes
  `LOCAL INSTALLATION · BUILD <build>` on a local install and
  `SHARED SERVER · BUILD <build>` when acquisition is closed (the server's
  `acquire` flag is the signal the client already has, `terminal.js:69-81`).
  The counters stay available in ARCHIVE › OPERATOR (`terminal.js:403-409`),
  which is their home.
- `tools/terminal-selftest.mjs` and `terminal-render-selftest.mjs` follow.

### D2 — LIVE first, and LOCAL says clearly when it is unavailable

- Tab order becomes `LIVE · LOCAL` (`terminal.js:710`). The default tab on
  every entry into FIELD is LIVE; `lastTab` keeps remembering the choice within
  a page load, as today. Clicking a map frame still forces LOCAL
  (`terminal.js:852`), that is where the frames live.
- When `acquireAllowed === false` (shared server), the LOCAL tab body opens
  with a notice block, before any area list:

  ```
  LOCAL TERRAIN IS NOT AVAILABLE ON THIS SERVER.
  THIS SERVER FLIES LIVE ONLY — SWITCH TO THE LIVE TAB.
  TO ACQUIRE AND KEEP TERRAIN, INSTALL THE DESKTOP CLIENT.
  ```

  Areas pre-installed by the server operator, if any, are still listed under
  it (they are real and flyable). The tab label itself gets `data-off="true"`
  (dimmed, still selectable) so the state is visible before clicking. The
  existing `NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY` line and the
  `DESKTOP CLIENT AVAILABLE` footer hint are absorbed by this notice and
  removed.
- BENCH keeps its own wording (`bench-model.mjs:268`), only adjusted to
  `SWITCH TO LIVE` first.

### D3 — ARCHIVE at the same level as FIELD and BENCH

- The root screen (`selectOperationMode`, `bench.js`) offers, in this order:
  `[ FIELD ]`, `[ BENCH ]`, `[ ARCHIVE ]`, then `[ SETTINGS ]` (D6). The
  two-line subtitles under FIELD and BENCH get counterparts for ARCHIVE
  ("Session log, target log, operator, build notes") and SETTINGS ("Controller,
  keyboard, audio, system").
- `archiveScreen()` is reached from the root and returns to it. Its own rows
  keep `LAST SESSION · SESSION LOG · TARGET LOG` and `CONTROL VECTOR · OPERATOR
  · BUILD NOTES`; `SETTINGS` leaves that row (it is now on the root). A
  REVISIT choice made inside ARCHIVE still resolves to a flight: the root loop
  in `main.js:2617-2625` treats an ARCHIVE choice like a FIELD one.
- The `ALL TERRAIN… · ARCHIVE` tail row of the LOCAL tab loses `ARCHIVE`.
- `fpvtp.mode` (last used root choice) accepts the new values; the cursor
  lands on the last used one as today.

### D4 — the MODE button disappears

- The `MODE` link (`terminal.js:809-812`) is removed. Escape (already wired to
  `leave()`) is the way back, and D15 names it on screen.
- `terminal-render-selftest.mjs` (`MODE` present iff `back`) and
  `archive-render-selftest.mjs:closeAll()` (which clicks `MODE`) are rewritten
  around the new navigation.

### D5 — remove the LIVE hint

- `STREAMED NOW · NOTHING KEPT · NEEDS THE LINK` (`scanner.js:114`) is deleted,
  nothing replaces it. The panel keeps `[ FLY LIVE ]`.

### D6 — SETTINGS at the same level, under ARCHIVE

- Fourth root entry (D3). The `SETTINGS` links in the FIELD footer, the ARCHIVE
  row and the BENCH footer are removed: one place in the menus, plus Tab in
  flight, which stays.
- The Settings panel opened from the root pushes its own `menuNav` as today
  and returns to the root on Escape.

### D7 — verify that LIVE flights fill the archives

- The code path is shared (facts above). What is missing is a test that keeps
  it so. `tools/session-log-selftest.mjs` gains cases: a session whose area is
  `live-…` appears in SESSION LOG and TARGET LOG, counts in the OPERATOR
  screen, shows its place name, and offers neither REVISIT nor RESUME.
- `openFlightSession()` keeps `if (OPTS.live) return;` (the dev `?live=`
  shortcut is not a player path) but the guard gets a one-line comment saying
  so, because it is the line a reader will suspect.
- If the render of a `live-` row turns out wrong (area label, missing place),
  it is fixed as part of this point.

### D8 — the real version replaces `0.97b`

- New module `src/version.js`: `export const APP_VERSION = typeof
  __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';`. `main.js` uses it
  for `window.FPVTP_VERSION` and the console line.
- `fpvtp-osd.js` drops `FPVTP_VERSION = '0.97b'` and imports `APP_VERSION`;
  `bootstrap.js:161` and `terminal.js:694` import it instead of their literal.
  On screen the string is `FPVTP! // v<APP_VERSION>` (`v0.0.0` today, the tag
  after the first `npm run release`; `dev` when built without Vite define).
- `motion.js:97` comment and `motion-selftest.mjs:119` keep `0.97b` as an
  arbitrary non-numeric fixture; they are about number interpolation, not the
  version. The Bible and old specs keep their historical mentions.
- The `BUILD NOTES` build numbers stay lore (CLAUDE.md).

### D9 — landing is removed

The flight ends by crash, geofence exit, or the player cutting the link
(hold K). No disarm, no LANDED verdict, no post-flight note, no resume.

- `flight-end.js`: `LANDING_READY`, `LANDED`, `LANDING_TIMELINE`, the
  `LANDING` thresholds and their measurement comment, `disarm()`,
  `_advanceLanding()`. The "stuck on the ground" reminder that `_advanceLanding`
  hosts (`STUCK_S`, `V_STUCK`, `W_STUCK`, which surfaces `[HOLD K] CUT LINK`)
  stays, moved into `update()`: it is now the only way a grounded quad ends its
  flight, so it matters more, not less.
- `main.js`: `doDisarm()`, the `disarm` action, `flightEnd.landing.THR_IDLE`
  assignments, the `LANDED` branches of `finishSession()` and the music fade,
  `?resume=`, `setSessionStatus('TARGET STATUS LANDED')`. The `touchdown`
  ground-hold in the physics step (`main.js:1690-1704`) **stays**: it is the
  physical feel of resting on the ground (#69), not the landing feature. It
  keeps reading an idle-throttle threshold; that constant moves out of the
  landing block to a plain `IDLE_THROTTLE` on the physics side.
- `input.js`: the `j` key and the gamepad disarm gesture (`input.js:708-717`).
- `post-flight.js`, `tools/post-flight-model.mjs`,
  `tools/post-flight-selftest.mjs`, `tools/landing-selftest.mjs`: deleted, and
  removed from `selftest:operator`.
- Session layer: `LANDED` leaves `SESSION_RESULTS` for new sessions and
  `SESSION_FILTERS`; `resumeSession()` and the `RESUME SESSION` button go.
  Reading old operator files that contain `LANDED` sessions keeps working (they
  display as they are; no migration, no `SCHEMA_VERSION` bump).
- Copy: `session-log.js:265` credo becomes `A CRASHED TARGET IS LOST. THE LOG
  IS WHAT REMAINS.`; `#fo-status[data-kind="landed"]` CSS and `FADE.landed` go.
- Docs: CLAUDE.md and `docs/manual.md` cite `landing-selftest.mjs` as the
  SKIP pattern; `tools/entry-state-selftest.mjs` (which SKIPs without a scene)
  becomes the cited example. Bible §24/§1768 ("atterrissage = fin propre"),
  Roadmap PHASE 14 §Landing, `fpv-rework-architecture.md:85` get a dated
  "revised — landing removed" note, not a rewrite.
- CHANGELOG `Retiré` entry.

### D10 — the sun darkens less

- `sun.js`: `E_MIN` 0.35 → 0.60 (the picture never drops under 60 % of
  nominal), `SUN_METER_WEIGHT` 3.0 → 1.5 (the disc has to fill twice as much of
  the frame to close the iris as far). `TAU_CLOSE`/`TAU_OPEN` stay: the
  closes-fast/opens-slow asymmetry is the effect (#23), the depth was the
  problem.
- `lens.js`: `SUN_VEIL` 0.22 → 0.14. Disc and halo unchanged.
- `tools/selftest.mjs` §soleil: the "closes to `< 0.4 × before`" assertion
  becomes `< 0.75 × before` and `> 0.55 × before`, so the nerf cannot silently
  regress in either direction. Comments carry the 2026-09-08 revision.

### D11 — `c` becomes a view toggle button: FPV / CHASE

- New view mode `chase`: a third-person camera that follows the drone while
  the simulation keeps running. Position = drone position − 1.6 m along the
  drone's yaw heading + 0.6 m up, smoothed with a 0.12 s time constant; it
  looks at the drone. The world mesh (`PlayerDrone.world`) is visible, the
  onboard pass is off, the video-link degradation is off (a chase view is not
  the video feed), lens effects stay. The chase camera is the flight camera
  re-placed, so it works in LIVE mode and in BENCH without any boot-path
  dependency.
- The old freezing `OrbitControls` free cam and `FREE_CAM_BACK_M` are removed;
  the flight-end viewer (D12) covers "look at the machine".
- Toggle: a clickable `[V] FPV` / `[V] CHASE` element in the top-right corner
  of the FPVTP OSD (`fpvtp-osd.js`, next to the input line), and the keyboard
  action `view` bound to `v` by default (remappable, D13). `c` is not kept as
  an alias.
- Chase view is a per-flight state, starting in FPV every flight.
- `#264` (old repo) lot 0 described the free cam; this supersedes it and the
  issue's text is not migrated as such.

### D12 — a rotatable 3D drone at the end of every flight

- New module `src/drone-viewer.js`: `droneViewer({ family, buildSeed, size })
  → { el, stop }`. Own `WebGLRenderer` (alpha, size×size), own scene, the mesh
  from `buildDroneMesh(shapeOf({ profile, build, camera, detail: 'portrait' }))`
  with the build's livery, an `OrbitControls` with `autoRotate` at the SVG
  portrait's pace (24 s/turn), drag with the mouse to rotate, no zoom, no pan.
  A gamepad right stick nudges the orbit while the end screen is up (read in
  the `update()` tick like `flashCaptured`). The renderer is disposed on
  `stop()`.
- `fpvtp-osd.js:_portraitNode()` builds a `droneViewer` instead of a
  `dronePortrait`. If WebGL context creation fails, it falls back to the SVG
  portrait, so the screen is never blank.
- `PORTRAIT_LINE` enters `FENCE_TIMELINE` and `CUT_TIMELINE` at the same
  offset relative to their blackout as in `TIMELINE`. Every end of flight
  shows the machine.
- A build seed always exists: `flightBuildSeed` on the NOMINAL paths
  (`?family=`, `?scene=`, bench without airframe seed) is derived
  deterministically from the family name (`nominalBuildSeed(family)` in
  `drone-profiles.js`), so `setTarget()` never receives `null`. The archive SVG
  portrait (SESSION LOG / TARGET LOG) benefits from the same fix and stays SVG:
  the author asked for 3D at the end of the flight, the archive card is a
  different surface.
- Selftests: a pure `tools/drone-viewer-model.mjs` (orbit parameters, seed
  fallback) with a selftest; `flight-end-selftest.mjs` asserts every timeline
  contains `PORTRAIT_LINE`; `drone-portrait-render-selftest.mjs` asserts a
  portrait exists for each family with the nominal seed.

### D13 — keyboard mapping, remappable

- Pure model `src/key-map.js` (mirrors `calibration.js`: no DOM, no storage):
  `KEY_ACTIONS` (ordered list with label and group), `DEFAULT_KEY_MAP`,
  `loadKeyMap(raw) → map` (defensive), `rebind(map, action, key) → { map,
  conflict }` (a key already used by another action is reported, the caller
  decides), `keyLabel(key)` (`ARROWUP` → `↑`, `' '` → `SPACE`).
- Actions, one key each, with both QWERTY and AZERTY defaults where the
  layouts disagree (stored as two entries `primary`/`alt`, both active):
  `throttleUp` (W/Z), `throttleDown` (S), `yawLeft` (A/Q), `yawRight` (D),
  `rollLeft` (←), `rollRight` (→), `pitchDown` (↑), `pitchUp` (↓),
  `cutLink` (K, hold), `pause` (SPACE), `view` (V), `photo` (F),
  `cyclePreset` (P), `cycleMode` (M), `benchPanel` (B, bench only),
  `respawn` (R, bench only). `Tab` (settings), `Escape` and `Enter` are fixed
  and not in the map: they are navigation, not flight.
- Storage: `fpvtp.keyMap` in `localStorage`, wiped by Reset like every
  `fpvtp.*` key.
- `input.js` reads through the map: `keydown` dispatches `onAction(action)`
  by looking the key up; `readKeyboard()` uses the map for the axes; `main.js`
  switches on action names, and `cutHeld` asks `input.isHeld('cutLink')`.
- UI: a KEYBOARD tab in Settings (D14) with one row per action (label, key,
  `[ REBIND ]`); pressing REBIND enters capture mode ("PRESS A KEY — ESC
  CANCELS"), the next key is assigned, a conflict swaps the two bindings and
  says so on the row for 2 s. `[ RESET KEYS ]` restores the defaults.
- Selftest `tools/key-map-selftest.mjs`: defaults are complete and free of
  conflicts, rebind reports conflicts and swaps, corrupt storage falls back,
  AZERTY and QWERTY both fly with the defaults.

### D14 — the Settings panel in the game's art direction, with tabs

- Same `#settings` element and `toggleSettings()` contract, new inside. The
  panel adopts the terminal's structure: `FPVTP! // SETTINGS` display header, a
  `.terminal-tabs` strip (reused CSS, `style.css:481-495`) with four tabs:
  `CONTROLLER` (device list, calibration wizard, channel map — unchanged
  content), `KEYBOARD` (D13), `AUDIO` (volume, tone, music), `SYSTEM` (view
  range when `?live=`, `[ REPLAY BRIEFING ]` (D16), `[ RESET SETTINGS ]`,
  version line). Labels in the `.t-ui` face, values in `.t-data`, rules from
  the tokens; no colour except the functional ones already in use.
- The `Close (Tab)` button becomes the key-hint row `[ESC] CLOSE · [TAB]
  CLOSE` (D15); the panel still closes on both.
- Left/right arrows keep adjusting a focused range; switching tabs is by
  clicking or focusing a tab and pressing Enter (menu-nav semantics
  unchanged). The active tab is remembered for the page load.
- `tools/settings-render-selftest.mjs` (new, on `tools/lib/fake-dom.mjs`):
  the four tabs exist in order, one body at a time, the key-hint row is
  present, Reset needs two presses.
- `tools/palette-selftest.mjs` must still pass: no demo colour on this screen.

### D15 — Escape is named on screen

- A shared helper `keyHints(pairs)` in `terminal.js` renders a
  `.terminal-keys` row (`.t-data`, dim) such as `[ESC] BACK`. Every terminal
  sub-screen that has `back` renders it after its nav rows; FIELD renders
  `[ESC] OPERATION MODE`; ARCHIVE `[ESC] OPERATION MODE`; BENCH the same; the
  root screen renders nothing (there is no back). Screens that deliberately
  have no `back` (bootstrap, operator key) render nothing.
- Flight end: `[ENTER] DISCONNECT` becomes `[ESC] DISCONNECT · [R] REDEPLOY`
  in all timelines; Enter keeps working silently (browser fullscreen swallows
  Escape, the reason Enter exists).
- Settings: `[ESC] CLOSE · [TAB] CLOSE` (D14).
- Briefing screens (D16): `[ESC] SKIP BRIEFING`.

### D16 — a briefing for the new player (the Bible is revised)

The author overrides Bible §2 and Roadmap PHASE 13 on this point. The
revision is written into both documents as dated notes ("revised 2026-09-08 —
a briefing exists; it lives before the first flight and in Settings, never at
the entry into flight"). PHASE 13's "no 3-2-1-GO, the player takes the sticks
immediately" stays true.

- **When**: once, right after `registeredScreen` of the bootstrap (the
  operator has just been created), and on demand from SETTINGS › SYSTEM ›
  `[ REPLAY BRIEFING ]`. Persisted as `fpvtp.briefingSeen` in `localStorage`
  (Reset wipes it and the briefing replays: acceptable, that is what a reset
  is).
- **Form**: terminal screens in the bootstrap's style (`revealLines`, dotted
  rows, `[ CONTINUE ]`, any key skips the reveal, Escape skips the whole
  briefing). Four screens, English, information-not-instruction in tone:
  1. `INPUT` — the detected device (`GAMEPAD <name>` or `KEYBOARD`), then the
     mapping as dotted rows (sticks for a pad, the key map for a keyboard,
     read live from D13 so it is never stale). `[ CALIBRATE ]` / `[ MAP KEYS ]`
     opens the matching Settings tab and comes back.
  2. `THE TERMINAL` — four dotted rows: `FIELD` (fly a downloaded area or take
     off live from a map pin), `BENCH` (sandbox, nothing is logged), `ARCHIVE`
     (session log, target log, operator, build notes), `SETTINGS`. Then
     `ESC ...... BACK, EVERYWHERE` and `TAB ...... SETTINGS, IN FLIGHT`.
  3. `A SESSION` — the loop as rows: `TARGET SCAN`, `CONTROL VECTOR` (the
     arrows you registered), `FLIGHT`, `HOLD K ...... CUT THE LINK`,
     `V ...... FPV / CHASE VIEW`, `SPACE ...... PAUSE`, `THE LOG KEEPS WHAT
     HAPPENED`.
  4. `BRIEFING COMPLETE` — `[ CONTINUE ]`.
- **In flight**, first session only (`fpvtp.briefingSeen` set but
  `fpvtp.firstFlightDone` unset): three transient hints through a new
  `#fo-hint` element of the FPVTP OSD, decided by a pure
  `tools/briefing-model.mjs` (`flightHint({ t, armed, airborne, ... }) →
  string | null`), painted by the OSD like `#fo-cut`: `THROTTLE UP` until the
  first take-off, `[TAB] SETTINGS` for 6 s after take-off, `[HOLD K] CUT LINK`
  at 30 s of flight. Never again after that session. Bench flights do not
  count as the first flight.
- Selftests: `tools/briefing-selftest.mjs` (screens in order, rows reflect the
  live key map, skip semantics, `shouldBrief()` storage rules, `flightHint()`
  timing), `tools/briefing-render-selftest.mjs` on the fake DOM.

## Navigation after the change

```
ROOT  SELECT OPERATION MODE        OPERATOR // <name>
      [ FIELD ]  [ BENCH ]  [ ARCHIVE ]  [ SETTINGS ]
        │           │          │             │
        │           │          │             └─ panel, tabs CONTROLLER · KEYBOARD · AUDIO · SYSTEM
        │           │          └─ LAST SESSION · SESSION LOG · TARGET LOG
        │           │             CONTROL VECTOR · OPERATOR · BUILD NOTES
        │           └─ bench (unchanged inside)
        └─ FIELD    tabs LIVE · LOCAL          footer: LOCAL INSTALLATION · BUILD n
                    (LOCAL carries the "not available on this server" notice when acquisition is closed)
      every level below ROOT shows  [ESC] <where it goes>
```

## Out of scope

- The archive SVG portrait stays SVG (D12).
- Gamepad button remapping (only axes are calibrated today; unchanged).
- A shared-server login/first-run page (#255 old repo) — separate.
- Damage on the wreck, props in the field (#264 lots A/B) — separate.

## Testing

`npm run selftest:ci` must pass at every checkpoint (CI runs it). New
selftests are chained into `selftest:operator`. The chrome-devtools MCP is used
at the end for a visual pass over: root screen, FIELD both tabs, ARCHIVE,
Settings tabs, a crash end screen with the 3D viewer, the chase view.

## Versioning

Everything lands under `## [Non publié]` in `CHANGELOG.md`. Cutting the
version is the author's call.
