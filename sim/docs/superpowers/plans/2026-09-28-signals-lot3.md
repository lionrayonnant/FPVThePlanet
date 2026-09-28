# Signals — Lot 3: clearance and the hangar, the captures in DATA, and the terminal's grammar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Progression opens through CLEARANCE (signal tiers + the drone draw pool) and is shown as a hangar of the real 3D machines where every flight passes (TARGET SCAN); the operator can consult what they captured inside DATA; every signal surface — scanner, flight notice, next-signal line, UPLINKED card — speaks the terminal's grammar the Bible sets.

**Architecture:** Pure models decide (`tools/signal-clearance-model.mjs`, `tools/dossier-model.mjs`, the existing capture/store/callout/card models extended); `generateTargetScan` takes the allowed families so client and server draw the same machine; the signal source exposes progress and its cache; one new server route serves a single session photo; the captures are two new sections of the DATA screen (no new root mode); the hangar is one DOM+WebGL component (`src/hangar.js`) mounted in four places; `main.js` wires the flight pieces.

**Tech Stack:** ES modules, Node `assert/strict` selftests, Leaflet canvas layer, IndexedDB, the operator HTTP API (`server/api.mjs`).

**Spec:** `sim/docs/superpowers/specs/2026-09-27-signals-design.md` §2 (tiers, clearance), §5 (DOSSIER). Lots 1–2 are on this branch's base (PR #186, #187). Issue #185.

**Mockups (validated by the author, 2026-09-28) — the visual source of truth:** `sim/docs/superpowers/mockups/clearance-v4.html` (the hangar; model renders in `mockups/img/`), `dossier-v3.html` (the capture detail; its list moves into DATA), `scanning-v3.html`, `signals-toast.html`, `flight-da.html`. Open them in a browser (they reference `/files/…` images of the brainstorm server; the layout and CSS are what matter).

## Decisions taken with the author (2026-09-28)

- **Art direction:** the terminal's grammar (Bible §38–§44; the DATA screen in `src/terminal.js` is the reference): one narrow column, Departure Mono titles, thin rules, mono lists with aligned columns, underlined caps links, `[+] [!] [*] [?]` marks (§40), no cards/boxes/dashboards/rounded corners, functional colours only (green = uplinked, yellow = a signal to go for, never the demo palette). The author rejected an earlier "web UI" mockup as "too AI".
- **No DOSSIER mode, the main menu stays at five.** The captures live INSIDE the DATA screen as two sections at the top: CLEARANCE (the hangar) and SIGNALS (PLACES as underlined links `PARIS 8/49 · KYOTO 3/61`, then the selected place's list: `[+] NAME  date  machine` for uplinked, `[?] ▓░▒…  2.7 km  TIER II` for known-but-not-uplinked). Opening an uplinked row (like LAST SESSION opens today) shows the capture per `dossier-v3.html`: **the real photo first and large**, the name, the description as the foot line, key/value facts (UPLINKED, MACHINE, HOLD, RANGE, SESSION, TYPE, BUILT, HEIGHT, STATUS), the credit with a **link to the Commons file page**, then an `INTERCEPTED` section with the operator's frame small, then `[ FLY THERE ] [ PREVIOUS ] [ NEXT ] [ BACK ]`. FLY THERE launches a LIVE flight at the landmark. The word "DOSSIER" does not appear in the UI. DATA's menu line becomes `flight records · the signals you uplinked` / `where you have been`.
- **The hangar (clearance, `clearance-v4.html`):** the seven machines — the REAL 3D models of each family, one shared WebGL renderer — in ONE row, grouped by clearance with thin separators, same size and angle, one floor line; above each group `CLEARANCE n` and `[+]` (green) or its cost in points; under the row the progress `▓▓▓▓░░░ 9/18 TO CLEARANCE 2` and the signal tiers open. Unlocked: the model turning slowly (a turntable, never a fast spin). Locked: its dark silhouette, still, torn in horizontal slices for ~0.25 s every ~4 s, its name scrambled. Crossing a step: a warm-white scan line sweeps down once, the model appears above it and the silhouette disappears below it, the name turns green. The swarm is drawn as it flies: the node with its units around it. **Backdrop:** the fence dome's living cyan/magenta/violet/electric mass, slow, behind the machines only, with faint scanlines — an explicit exception to Bible §19, recorded in the new Bible section (and in `tools/palette-selftest.mjs`'s allowlist with a comment).
- **Where the hangar appears:** (1) the **TARGET SCAN, on every flight**, under the candidate list — the author's choice, because DATA alone would not be seen; (2) the top of DATA; (3) the briefing, as screen 5/5 — new operators in the briefing, existing operators once at their first FIELD after the update (own seen key), replayable from SETTINGS › SYSTEM like the briefing; (4) the end-of-flight screen, in place of the recap strip, when that flight crossed a step (the reveal plays there). Not on the FIELD home.
- **Clearance elsewhere is a text line:** the GLOBAL SCANNER header `CLEARANCE 0  ▓▓░░░░  2/6`; the TARGET SCAN line `CLEARANCE 0 · 1 OF 7 MACHINE CLASSES`; in flight at the uplink that crosses a step, the take-off-style notice `[+] CLEARANCE 1 · CINEWHOOP · TOOTHPICK · TIER II`.
- **No new image storage:** the reference photo is fetched live from Wikimedia (browser cache + place-info cache); the intercepted frame is the existing session photo, served by a new single-photo route. A capture made without a session has no frame in its capture view.
- **Scanner loading:** the glitch lives only on the tile being asked, only while asked: the basemap inside it tears into displaced grey slices under ASCII noise, its hairline flickers. **Signals never move** — they appear, still, when their tile lands. Messages are terminal lines in the map corner (no box, no bar widget): `[*] SIGNAL SCAN  z12/x/y` / `▓▓▓░░░░░░  3/16_`, `[+] 42 SIGNALS IN VIEW`, `[!] SIGNAL SCAN UNAVAILABLE` / `RETRY IN 0:52 · THE MAP STILL WORKS`. Base palette only.
- **In flight, at take-off:** no extra OSD line. A one-shot notice in the exact style of the OSD's centre lines (`#fo-hint` / `#fo-cut`: same face, size, colour, scrim), above them, when control is acquired: `[*] SIGNAL SCAN · 2/7` while it finishes, then `[+] 49 SIGNALS IN RANGE`, gone after ~4 s. (The author: "a popup when control is acquired that fades — something clean".)
- **Next signal:** one more line in the top-left OSD block, same face as OPERATOR / LIVE: `NEXT SIGNAL 1.2 km ↗` (arrow relative to heading, "NEXT SIGNAL" in yellow); hidden while a callout is on screen; hidden when nothing is left.
- **UPLINKED card** redrawn in the terminal's grammar (mockup `flight-da.html`): hairline frame, square corners, the OSD scrim, header `[+] UPLINKED` / `SIGNAL n · 212 m`, a green rule that shortens (the timer), the real photo large, name (Departure Mono), description, key/value lines, then the intercepted frame small with `INTERCEPTED / machine · HOLD 5.0 s`, then the credit. No pictograms, no filled boxes.
- **Colour-blind safety on the map:** to capture = filled yellow light; uplinked = hollow green ring with a tick; locked by clearance = small dim warm-white dot, no halo. The shape alone tells them apart.
- **Clearance and the draw pool (spec §2, extended by the author 2026-09-28):** CLEARANCE 0→3. **The 5" freestyle is the machine everyone has from the start** ("even if it's not the worst drone — it's what makes you want to keep playing"). Each step opens a tier AND machines; the draw stays random, its pool widens: 0 = 5" FREESTYLE, tier I · 1 (6 points) = + CINEWHOOP, TOOTHPICK, + tier II · 2 (18) = + 5" RACE, LONG RANGE, HEAVY 5", + tier III · 3 (36) = + THE SWARM. Points = 1 per tier of every signal uplinked. At clearance 0 every TARGET SCAN candidate is a freestyle (different individuals). The swarm can only appear from clearance 3. Signals above the operator's clearance are visible, marked, not capturable.
- **Commons file page link** in the credit; **`Api-User-Agent`** header on Wikimedia requests.
- **README:** a privacy note naming the third parties the player's browser contacts.
- **Bible:** a section recording the relaxed progression rule and why a clearance exists in this universe (French, like the Bible).
- **Docs** (`HANDOFF.md`, `docs/manual.md`, `CLAUDE.md` external-services line) at the very end.
- No capture calibration tool (the author is fine with the tuned values).

## Global Constraints

- Worktree `/home/user/Documents/dev/FPVThePlanet-signals3`, branch `signals-lot3` (stacked on `signals-lot2`). Paths relative to `sim/` unless they start with `sim/` or `../`.
- English code/comments/labels/UI text; a touched file leaves in English (translate the comments of what you touch, and the file header). `CHANGELOG.md` entries and the Bible section in French.
- Selftests: `node:assert/strict`, local `t(name, fn)` printing `  ok  <name>`; only the touched modules' selftests; never `npm run selftest:ci` (the CI runs it on the PR). Output clean.
- Pure modules: no DOM, no THREE, no Rapier. External text → DOM only via `textContent`; image `src` only from `safeImageUrl` URLs, our own `data:image/` URLs, or our own API; link `href` only from a validated `https://commons.wikimedia.org/wiki/File:` URL, with `rel="noopener noreferrer"` and `target="_blank"`.
- CSS: tokens only (`--space-*`, `--fs-*`, `--track-*`), functional colours only, no demo palette (`tools/palette-selftest.mjs`), no rounded corners, no shadows beyond the existing OSD text shadow.
- Commits end with a `Co-Authored-By:` trailer naming the model that wrote them. `git add` by name (other agents may be reviewing the worktree).

## File Structure

| File | Responsibility |
|---|---|
| Create `tools/signal-clearance-model.mjs` + selftest | Clearance points, level, tiers and families allowed. |
| Modify `src/signal-capture.js` + selftest | `encrypted` targets: visible, never capturable. |
| Modify `tools/signal-callout-model.mjs` + selftest, `src/signal-callout.js` | `ENCRYPTED · CLEARANCE n` headline. |
| Modify `tools/target-model.mjs` + selftest, `src/target-scan.js`, `src/ambient.js`, `src/main.js`, `server/api.mjs`, `tools/session-api-selftest.mjs` | Draw pool restricted by clearance, identical client/server. |
| Modify `src/signal-source.js` + selftest | `progress()`, cache `entries()`, `cachedSignals()`. |
| Modify `tools/signal-store-model.mjs` + selftest | `place` on a resolution. |
| Create `tools/place-name-model.mjs` + selftest, `src/place-name.js` | Nominatim reverse → a short place name, cached. |
| Modify `tools/wikidata-model.mjs`, `src/place-info.js` + selftests | Commons `descriptionurl`; `Api-User-Agent`. |
| Modify `src/map-signals.js`, `src/scanner.js`, `src/style.css` | Glitch tile, terminal log lines, the three shapes. |
| Modify `src/fpvtp-osd.js`, `src/signal-card.js`, `tools/signal-card-model.mjs` + selftest, `src/style.css`, `src/main.js` | Take-off notice, NEXT SIGNAL line, card redesign, place at uplink, encrypted targets. |
| Modify `server/api.mjs` + `tools/session-api-selftest.mjs`, `src/operator.js` | `GET /__operator/:id/sessions/:sid/photos/:i` (bytes). |
| Create `tools/hangar-model.mjs` + selftest, `src/hangar.js`; modify `src/target-scan.js`, `src/terminal.js` (DATA), `src/briefing.js` + `tools/briefing-model.mjs` + selftest, `src/fpvtp-osd.js` (end screen), `tools/palette-selftest.mjs`, `src/style.css` | The hangar and its four placements. |
| Create `tools/signals-data-model.mjs` + selftest, `src/signals-data.js`; modify `src/terminal.js` (DATA), `tools/bench-model.mjs` (DATA's menu line) + `tools/bench-selftest.mjs` | The captures in DATA. |
| Modify `../README.md`, `docs/FPVThePlanet! — Art Direction & Experience Bible.md` | Privacy note; the clearance section. |
| Modify `../CHANGELOG.md`, `HANDOFF.md`, `../docs/manual.md`, `../CLAUDE.md` | Changelog; docs at the end. |

---

### Task 1: Clearance — model, encrypted targets, callout

**Files:** create `tools/signal-clearance-model.mjs`, `tools/signal-clearance-selftest.mjs`; modify `src/signal-capture.js`, `tools/signal-capture-selftest.mjs`, `tools/signal-callout-model.mjs`, `tools/signal-callout-selftest.mjs`, `src/signal-callout.js`, `package.json` (chain the new selftest after `signal-store-selftest`).

**Interfaces — Produces:**
- `tools/signal-clearance-model.mjs`:
  - `TIER_POINTS = { 1: 1, 2: 2, 3: 3 }`, `STEPS = [0, 6, 18, 36]` (points needed for clearance 0, 1, 2, 3), `MAX_CLEARANCE = 3`
  - `LEVELS = [ { tiers: [1], families: ['freestyle5'], opens: ['freestyle5'] }, { tiers: [1, 2], families: [...prev, 'cinewhoop', 'toothpick'], opens: ['cinewhoop', 'toothpick'] }, { tiers: [1, 2, 3], families: [...prev, 'race5', 'longrange', 'heavy5'], opens: [...] }, { tiers: [1, 2, 3], families: [...prev], swarm: true, opens: ['swarm'] } ]` (each level includes the previous; `swarm: true` only from level 3)
  - `swarmAllowed(level) -> boolean`; `crossed(before, after) -> number|null` (the step reached when a store change raises the level, for the notice and the end-screen reveal)
  - `pointsOf(store) -> number` — sum of `TIER_POINTS[entry.tier]` over `fromStored(store).resolved`
  - `clearanceOf(store) -> 0|1|2`; `nextStep(store) -> { level, points, need } | null` (null at max)
  - `tierAllowed(level, tier) -> boolean`; `familiesFor(level) -> string[]`
- `src/signal-capture.js`: a target may carry `encrypted: true` → its row state is `'encrypted'` (shown within `SHOW_M`, never a candidate, never a gauge, never focus). State strings become `hidden|near|capturing|held|resolved|encrypted`.
- `tools/signal-callout-model.mjs`: `headline('encrypted', { need }) -> { word: \`ENCRYPTED · CLEARANCE ${need}\`, tone: 'dim' }`; `revealCount(n, g, 'encrypted') -> 0`.
- `src/signal-callout.js`: renders the encrypted headline, no gauge.

Tests first: points/levels at the step boundaries (5→0, 6→1, 17→1, 18→2, 35→2, 36→3); level 0 is exactly `['freestyle5']`; families of each level include the previous and the union of LEVELS[3].families equals `TARGET_FAMILIES` of `tools/target-model.mjs` exactly (import it); `swarmAllowed` only at 3; `crossed(5 points → 7 points)` is 1, `crossed(7 → 8)` is null; an encrypted target dead ahead in range for 10 s never uplinks and reports `'encrypted'`; a signal resolved earlier stays `'resolved'` even if its tier is above the current clearance; callout headline/reveal for `'encrypted'`.

Commit: `Signals: clearance — tiers and machines open with what you uplinked (#185)`

---

### Task 2: The draw pool follows the clearance

**Files:** `tools/target-model.mjs`, `tools/target-model-selftest.mjs` (or the selftest that covers it — find it: `grep -l generateTargetScan tools/*selftest*`), `src/target-scan.js`, `src/ambient.js`, `src/main.js`, `server/api.mjs` (`POST /:id/sessions`, ~l.363-380), `tools/session-api-selftest.mjs`.

- `generateTargetScan({ seed, count, swarmChance, families = TARGET_FAMILIES })` draws with `pick(rand, families)` (l.105). `families` must be a non-empty subset of `TARGET_FAMILIES` (validate; fall back to `TARGET_FAMILIES` on anything else). Same seed + same families → same scan.
- Every call site passes the SAME `families` for the same flight: `src/target-scan.js:34`, `src/main.js` (~l.3681, ~l.3783), `src/ambient.js:44`. Compute it ONCE per flight choice in `main.js` from `familiesFor(clearanceOf(operator.getOperator()?.signals))` and thread it.
- Server: the `POST /sessions` body carries `clearance` (0–2) next to `targetSeed`/`targetCount`/`swarmChance`; the server regenerates with `familiesFor(clampedClearance)` (import `tools/signal-clearance-model.mjs`). Missing/invalid → the full pool (older clients keep working).
- Tests: same seed with the full pool vs clearance 0 differs only in families and never draws a family outside the level; a scan regenerated server-side with the same body resolves the same family as the client for every index (session-api selftest: post a session with `clearance: 0` and assert the stored target family ∈ level-0 families).
- The swarm: `swarmChance` is forced to 0 below clearance 3 (client and server, from the same `clearance` field), so the swarm pseudo-family (injected separately on candidate 0) only appears from clearance 3.
- TARGET SCAN copy: under the list, the line `CLEARANCE n · k OF 7 MACHINE CLASSES` (7 = six families + the swarm), faint.

Commit: `Signals: the machines you can hack widen with your clearance (#185)`

---

### Task 3: Source progress, cached signals, place on a resolution, place names

**Files:** `src/signal-source.js` + `tools/signal-source-selftest.mjs`; `tools/signal-store-model.mjs` + `tools/signal-store-selftest.mjs`; create `tools/place-name-model.mjs` + `tools/place-name-selftest.mjs`, `src/place-name.js`; `package.json` (chain `place-name-selftest`).

- `createSignalSource().progress() -> { done, total, current: tileKey|null, retryAt: ms|null }` — `done` = tiles of the current request batch already loaded, `total` = done + queued + in flight; reset when a new `request()` batch starts; `retryAt` = earliest cooldown end when state is `unavailable`. Emit on every change (existing `emit()`).
- `idbCache(name)` and `memoryCache()` gain `entries() -> Promise<Array<[key, value]>>` (IndexedDB cursor; fallback to the memory map). `createSignalSource().cachedSignals() -> Promise<Signal[]>` — every fresh, current-version cached tile's signals, deduped by id (reuse the `fromCache` checks).
- `tools/signal-store-model.mjs`: entries gain optional `place: string|null` (text, ≤ 40 code points); `MAX_RESOLVED` stays within the 1 MB PATCH budget — extend the worst-case size test with a 40-char non-ASCII place and lower `MAX_RESOLVED` if needed.
- `tools/place-name-model.mjs`: `reverseUrl(lat, lon) -> string` (Nominatim `format=jsonv2&zoom=10`), `placeNameOf(json) -> string|null` (`address.city ?? town ?? village ?? municipality ?? county ?? state`, uppercased, cleaned, ≤ 40 code points), `placeKey(lat, lon)` (z10 tile key). `src/place-name.js`: `sharedPlaceNames().nameOf(lat, lon) -> Promise<string|null>` — memo per `placeKey`, IndexedDB cache 90 days, at most 1 request/s (queue), never rejects. CSP already allows Nominatim.

Tests (fake fetch/timers like signal-source-selftest): progress across a 3-tile batch, reset on a new batch, retryAt on failure; `entries()` on memory cache; `cachedSignals()` skips stale/old-version entries and dedupes; store `place` round-trip and cap; `placeNameOf` for city / village / natural area (county fallback) / garbage; the 1 req/s queue.

Commit: `Signals: the source says how far it got, remembers what it knows, and places get names (#185)`

---

### Task 4: Commons page link and the Api-User-Agent

**Files:** `tools/wikidata-model.mjs` + selftest; `src/place-info.js` + selftest.

- `commonsUrl` asks `iiprop=url|extmetadata` (unchanged) — `imageinfo[0].descriptionurl` is already returned: `parseCommons` adds `page` = `descriptionurl` only if it starts with `https://commons.wikimedia.org/wiki/File:` (else null). `PLACE_VERSION` + 1.
- Every Wikidata/Commons fetch in `src/place-info.js` sends `Api-User-Agent: FPVThePlanet/<version> (+https://github.com/lionrayonnant/FPVThePlanet)` (version from `src/version.js`). Wikimedia allows this header through CORS.
- Tests: `page` parsed and host-checked; the header is sent (fake fetch records init.headers).

Commit: `Signals: credits link to the Commons page, and Wikimedia knows who is asking (#185)`

---

### Task 5: The scanner — glitch tile, terminal lines, three shapes

**Files:** `src/map-signals.js`, `src/scanner.js`, `src/style.css`. Mockup: `scanning-v3.html` (and `flight-da.html` §3 for the shapes).

- Shapes (`_redraw`): to capture = the current filled yellow light; **uplinked** = hollow green ring (2 px stroke, radius ~5) with a tick inside, a faint green halo; **locked by clearance** = a small filled dim warm-white dot (radius 2.5), no halo. Pass `getClearance()` to the layer (from the scanner: `clearanceOf(op.signals)`), a signal is locked when `!tierAllowed(level, s.tier)` and not resolved. Labels unchanged.
- Glitch tile: while `signalSource.progress().current` is set and its tile intersects the view, redraw at ~11 Hz (a timer started/stopped by the source's subscribe callback; never runs otherwise). Inside the tile's screen rect (`tileBounds` → `latLngToContainerPoint`): draw the loaded basemap tile images (`map.getPane('tilePane')` `img.leaflet-tile-loaded`, positioned from their `getBoundingClientRect` relative to the map container) in ~9 horizontal slices, each shifted horizontally by a random 0–18 % of the rect width in ~half of the slices, with `ctx.filter = 'grayscale(1) brightness(1.25) contrast(1.2)'` (drawing cross-origin images taints the canvas — fine, we never read it back); then a sparse ASCII noise layer (`░▒▓█▚▞■□▪·:.`, Departure Mono 10 px, warm white at .55, ~16 % density); then a 1 px warm-white hairline that blinks. The queued tiles of the batch get a 1 px dashed faint outline. When the tile lands, the effect stops at once and its signals are simply drawn — **no animation on the points**.
- Status: replace the `.sc-signals-status` text with terminal lines in the map's top-left (a black band behind each line only, no box): scanning → `[*] SIGNAL SCAN  z12/x/y` + `    ▓▓▓░░░░░░░░░  done/total_` (blinking underscore) + `    OVERPASS · 1 REQUEST IN FLIGHT` (faint); done → `[+] N SIGNALS IN VIEW` (the `[+]` green) + `· k UPLINKED` when k > 0; unavailable → `[!] SIGNAL SCAN UNAVAILABLE` (the `[!]` yellow) + `    RETRY IN m:ss · THE MAP STILL WORKS` (from `retryAt`, ticking each second while shown); too wide → `[*] ZOOM IN TO SCAN`. Text via `textContent` per span.
- The GLOBAL SCANNER header gets one line under the operator line: `CLEARANCE n  ▓▓▓░░░░░░  p/next` (the bar in yellow, `CLEARANCE 3 · MAX` at the top) — text in the scanner's existing header style.
- Verify by `node tools/scanner-selftest.mjs && node tools/palette-selftest.mjs` and the Node import check of `src/map-signals.js`; the look is verified in the final task.

Commit: `Signals: the scanner scans like a terminal — a glitching tile, still lights, plain lines (#185)`

---

### Task 6: In flight — take-off notice, next signal, the card, place at uplink, encrypted targets

**Files:** `src/fpvtp-osd.js`, `src/signal-card.js`, `tools/signal-card-model.mjs` + selftest, `src/style.css`, `src/main.js`. Mockups: `signals-toast.html`, `flight-da.html`.

- `FpvtpOsd.setNotice(text, ms)` — a one-shot centre line with its own element `#fo-notice` styled exactly like `#fo-hint` (same rule: copy its declarations, `top: 40%`), self-expiring like `setInputLost` (`_noticeUntil` checked in the paint), fading out over the last 0.5 s (opacity only). `[+]` in green via a span. At the handover (`main.js` ~l.4120, where `fpvtpOsd.setHint(null)` runs): if the flight's signals are still loading, show `[*] SIGNAL SCAN · done/total` and update it on each source change; when loaded, `[+] N SIGNALS IN RANGE` for 4 s (N = capturable, not resolved, not locked); `NO SIGNAL IN RANGE` if N = 0. Nothing on the bench.
- `NEXT SIGNAL` line: a new `#fo-next` div at the end of `.corner.tl`; `update({ …, next })` with `next = { distM, relRad } | null`; text `NEXT SIGNAL` (yellow span) + ` ${km < 1 ? Math.round(m) + ' m' : km.toFixed(1) + ' km'} ${ARROWS[i]}`; hidden when `next` is null. Export `ARROWS` from fpvtp-osd.js and reuse the wind index formula. In `main.js`: the nearest flight signal that is not resolved and not locked (distance from `droneGeo` lat/lon — add `distanceM`/bearing from `tools/signal-model.mjs` `distanceM` and a bearing via `bearingTo(dEast, dSouth)` on local ENU when the anchor exists, else from lat/lon), `null` while a callout is on screen or when none is left. Update at 5 Hz, not every frame.
- Crossing a step: in `onSignalUplinked`, compare `clearanceOf` before/after the `withResolved` patch (`crossed()`); if a step was crossed, queue the notice `[+] CLEARANCE n · <what it opens>` (after the card's first second, 5 s) and remember `flightCrossed = n` for the end screen (Task 8).
- Encrypted targets: `armSignals`' refresh marks `encrypted: !tierAllowed(clearance, s.tier)` for non-resolved signals (clearance computed once per flight at arm time).
- Place at uplink: in `onSignalUplinked`, after the synchronous `withResolved(...)` patch, `sharedPlaceNames().nameOf(s.lat, s.lon)` → when it resolves, patch the entry's `place` (add `withPlace(store, id, place)` to the store model, same rules as `withPhoto`, with a test).
- The card, redrawn per `flight-da.html`: `src/signal-card.js` rebuilt in the terminal grammar (hairline frame `1px solid var(--rule-strong)`, square, `background: var(--scrim-soft)`, header line `[+] UPLINKED` green / `SIGNAL n · d m` dim, a 1 px green rule scaled by `remaining01` from the left, the reference photo 3:2 full width (collapsed if none), the name in `--font-display`, the description in `--fs-micro` dim caps, key/value lines TYPE / BUILT / HEIGHT / STATUS as a `<pre>` (values in ink), a bottom row with the intercepted thumbnail (70 px wide) and `INTERCEPTED` / `machine · HOLD x s`, the credit in `--fs-micro` faint). Replace `cardFacts` pictograms by `cardRows(signal, info) -> Array<[label, value]>` in the model (same sources and fallbacks; test it). The recap strip on the end screen keeps its compact form but drops any remaining card styling that is not hairline/square.
- Verify: `node tools/signal-card-selftest.mjs && node tools/signal-store-selftest.mjs && node tools/palette-selftest.mjs && node tools/flight-end-selftest.mjs` + Node import checks of `src/signal-card.js` and `src/fpvtp-osd.js`.

Commit(s): `Signals: at take-off one notice, in flight the next signal, and the card speaks terminal (#185)`

---

### Task 7: One session photo, as bytes

**Files:** `server/api.mjs`, `tools/session-api-selftest.mjs`, `src/operator.js`.

- `GET /__operator/:id/sessions/:sid/photos/:i` in the operator route table (same `checkOrigin` + `checkKey` gate as every operator route): `sid` must pass `SESSION_ID_RE`, `i` a non-negative integer < `photos.length`; decode the photo's `dataUrl` (`data:image/(jpeg|png|webp);base64,…` only — anything else 404) and answer the bytes with its content type and `cache-control: private, max-age=31536000, immutable` (a photo never changes). 404 on anything missing.
- `src/operator.js`: `photoUrl(sessionId, index)` is NOT enough (the bearer header): add `fetchPhoto(sessionId, index) -> Promise<string|null>` that fetches with `authHeaders()`, `res.ok` → `URL.createObjectURL(await res.blob())`, else null; the caller revokes it.
- Tests: session-api selftest posts a session + a photo, reads it back (bytes equal the decoded base64, content-type image/jpeg), 404s for a bad sid, an out-of-range index, another operator's session.

Commit: `Signals: a single session photo can be read on its own (#185)`

---

### Task 8: The hangar and its four placements

**Files:** create `tools/hangar-model.mjs`, `tools/hangar-selftest.mjs`, `src/hangar.js`; modify `src/target-scan.js`, `src/terminal.js` (the DATA screen), `src/briefing.js`, `tools/briefing-model.mjs`, `tools/briefing-selftest.mjs`, `src/fpvtp-osd.js` (end screen), `src/main.js`, `tools/palette-selftest.mjs`, `src/style.css`, `package.json` (chain `hangar-selftest`). Mockup: `clearance-v4.html` (the look, sizes, groups, labels, the three animations, the backdrop). Model renders for reference: `mockups/img/m-*.png`.

**Model (`tools/hangar-model.mjs`, pure):** `hangarRows(store) -> Array<{ level, open, cost, machines: [{ id, label, open, justOpened }] }>` from `LEVELS`/`clearanceOf` (labels `5" FREESTYLE`, `CINEWHOOP`, `TOOTHPICK`, `5" RACE`, `LONG RANGE`, `HEAVY 5"`, `SWARM`); `progressLine(store) -> string` (`▓▓▓▓░░░░░░░░  9/18 TO CLEARANCE 2` with a 12-cell bar, or `CLEARANCE 3 · MAX`); `tiersLine(store) -> string`; `scrambleLabel(label, seed)` (reuse the callout `scramble`). Tests: rows at 0/1/2/3, justOpened only for the step passed in, the bar at boundaries, scramble stability.

**Component (`src/hangar.js`):** `mountHangar(host, { store, reveal = null, compact = false }) -> { destroy() }`.
- ONE `THREE.WebGLRenderer({ alpha: true })` for the whole row, drawing each machine into its own viewport/scissor rect (never one context per machine — a context per drone is how browsers start dropping them). Build meshes with the same path as `src/drone-viewer.js` (`shapeOf`, `buildDroneMesh`, a neutral livery for the family's `NOMINAL` build seed — reuse `targetBuild`/`liveryColors` as drone-viewer does). The swarm: the `swarmNode` mesh at the centre and six `swarmUnit` meshes around it, small.
- Open machines: slow turntable (≈ 1 turn / 20 s), same camera angle for all. Locked: the same mesh with a flat dark material (`#3a352f`-like, from a token), still; every ~4 s (staggered per machine) a 0.25 s tear: render the locked viewports into an offscreen canvas and draw it back in 6 horizontal slices with small x offsets (2D compositing over the WebGL canvas, or a second pass). Reveal (`reveal = level`): for the machines opened by that level, a one-shot 1.2 s sweep — a warm-white 1 px line moving down, the lit model above it, the silhouette below — then the name turns green; plays once.
- Backdrop: a 2D canvas behind the row: slow drifting radial blobs in `--cyan`, `--magenta`, `--violet`, `--electric` at low alpha (additive), a few slow sine "veins", faint horizontal scanlines on top — like the fence dome, calm. Pauses (`cancelAnimationFrame`) when the host is hidden or detached; `destroy()` frees the renderer, meshes, and the loop.
- Labels, the level headers, the progress and tiers lines are DOM text (`textContent`), `white-space: nowrap`.
- `tools/palette-selftest.mjs`: allow the demo palette in `src/hangar.js` ONLY, with a comment pointing at the new Bible section (Task 10).

**Placements:**
1. TARGET SCAN (`src/target-scan.js`), every flight, under the candidate list, `compact` (smaller machines, same row), plus the line `CLEARANCE n · k OF 7 MACHINE CLASSES`.
2. The top of the DATA screen (`src/terminal.js` `dataScreen`): section `CLEARANCE`, full size, with the progress line.
3. The briefing (`tools/briefing-model.mjs` / `src/briefing.js`): a fifth screen `CLEARANCE` whose body is the hangar + two fact rows (`POINTS ....... 1 PER TIER OF EVERY SIGNAL UPLINKED`, `ABOVE YOUR CLEARANCE ... VISIBLE, ENCRYPTED, NOT CAPTURABLE`). New key `fpvtp.clearanceBriefed`: an operator already briefed but not clearance-briefed sees this single screen once, at their first FIELD open after the update. Replay from SETTINGS › SYSTEM shows all five.
4. The end-of-flight screen: when `flightCrossed` is set, the recap strip is replaced by the hangar with `reveal = flightCrossed` (via the `SIGNALS_LINE` provider).

Verify: `node tools/hangar-selftest.mjs && node tools/briefing-selftest.mjs && node tools/palette-selftest.mjs && node tools/flight-end-selftest.mjs`; the look in the final task.

Commit(s): `Signals: the hangar — the machines you can hack, the ones you will, on every target scan (#185)`

---

### Task 9: The captures, inside DATA

**Files:** create `tools/signals-data-model.mjs`, `tools/signals-data-selftest.mjs`, `src/signals-data.js`; modify `src/terminal.js` (`dataScreen`), `tools/bench-model.mjs` (`MODE_SELECT.data` lines: `flight records · the signals you uplinked` / `where you have been`), `tools/bench-selftest.mjs` (only if it asserts those lines), `src/style.css`, `package.json` (chain `signals-data-selftest`). Mockup: `dossier-v3.html` (the capture view; the list becomes a DATA section). No new root mode; `MODES` unchanged.

**Model (`tools/signals-data-model.mjs`, pure):**
- `buildSignals({ store, known }) -> { uplinked, knownCount, places: [{ name, uplinked: Entry[], known: Signal[], total }] }` — places from the resolutions' `place` (entries without one go to `ELSEWHERE`), sorted by uplinked count desc then name; a place's `known` = cached signals not resolved whose nearest resolution is that place's and within 5 km of it.
- `listRows(place, clearance) -> Array<{ kind: 'uplinked'|'known'|'locked', id, text, right }>` — uplinked first (newest first): `NAME` / `dd.mm  MACHINE`; then known nearest to the place's centroid first: scrambled name (stable seed per id) / `2.7 km  TIER II`; `locked` when the tier is above the clearance (right side `CLEARANCE n`). Cap known rows at 12 + a `…N MORE` row.
- `detailRows(entry, signal, info)` — UPLINKED `dd.mm.yy / hh:mm`, MACHINE, HOLD, RANGE, SESSION (session id uppercased, `-` → space), then TYPE, BUILT, HEIGHT, STATUS.
- `creditOf(info) -> { text, href|null }` — `© AUTHOR · LICENCE · WIKIMEDIA COMMONS` + the validated Commons page URL; `DATA © OPENSTREETMAP · WIKIDATA` separately.
- Tests: grouping, ELSEWHERE, ordering, the 5 km assignment, locked vs known, the 12-row cap, scramble stability, detail rows, credit link validation, empty store.

**In DATA (`src/terminal.js`):** the page's foot becomes `N SESSIONS ON RECORD · M SIGNALS UPLINKED · CLEARANCE n`; after the CLEARANCE section (Task 8), a `SIGNALS` section: sub line `u UPLINKED · k KNOWN · p PLACES`, the PLACES links (the selected one underlined in ink), the selected place's rows (uplinked rows are focusable links; known/locked are not), empty state `NOTHING UPLINKED YET` + `FIELD → A SIGNAL ON THE SCANNER` (faint). Then the existing sections, unchanged.

**The capture view (`src/signals-data.js`, `runCapture(root, { api, entries, index }) -> Promise<{ live, place } | null | 'back'>`, opened through DATA's existing `behind()`):** title = the name; foot = the description; the reference photo (`safeImageUrl`), full column width, 3:2, collapsed if none; its credit line with `[ SOURCE ]` linking to the Commons page (new tab, `rel="noopener noreferrer"`); a rule; the key/value `<pre>`; section `INTERCEPTED` with the session photo (via `fetchPhoto`, 46 % width, object URL revoked on leave; `NO FRAME — CAPTURED WITHOUT A SESSION` if none); buttons `[ FLY THERE ] [ PREVIOUS ] [ NEXT ] [ BACK ]`. FLY THERE resolves `{ live: [lat, lon], place: entry.place ?? null }`, which DATA passes up unchanged (its `done()` already forwards objects) and `main.js`'s `dataLoop` already turns into a LIVE flight. Keyboard/pad via `menuNav`; Escape = BACK.

Commit(s): `Signals: what you uplinked, where, and what is still out there — inside DATA (#185)`

---

### Task 10: README privacy note, the Bible section, verification, changelog, docs

**Files:** `../README.md`, `docs/FPVThePlanet! — Art Direction & Experience Bible.md`, `../CHANGELOG.md`, `HANDOFF.md`, `../docs/manual.md`, `../CLAUDE.md`.

- README: a short `Privacy` section (English): what the player's browser contacts directly and why — Google Earth tiles (live terrain), OpenStreetMap tiles and Nominatim (map, search, place names), Overpass (landmark signals), Wikidata and Wikimedia Commons (the real photo and facts of a captured place) — each sees the player's IP and what is asked; nothing else leaves the machine except to the game's own server; no analytics.
- Bible: a new section after §19 or in §2/§3 as fits (read the table of contents), in French, in the Bible's voice: *Signaux et habilitation* — the author relaxed the no-progression rule on 2026-09-27 (diegetic progression allowed; scores and rankings still out); why a clearance exists in this universe (the operator's standing with the network they feed; each uplinked landmark proves the link and opens heavier machines); the ladder (freestyle from the start; the four steps; the swarm last); what it is NOT (no XP bar, no reward screen, no level-up fanfare — a line in the terminal, and the hangar); and the one exception to §19 it carries: the hangar's backdrop uses the demo palette (cyan/magenta/violet/electric), calm and slow, because it shows the machines the network could hand you — say it explicitly so §19 stays true. Keep it ~50–70 lines.
- Browser verification (dev server from this worktree; chrome-devtools MCP with `isolatedContext`, `navigator.getGamepads = () => []` after each navigation; the DEV `window.__signals` handle to set poses): scanner glitch + lines + shapes + the clearance header line; TARGET SCAN at clearance 0 shows only freestyle candidates and the hangar with six locked machines; the briefing's fifth screen (and the one-time screen for an already-briefed operator); FIELD flight with a session: take-off notice, NEXT SIGNAL line, an encrypted signal (lower the clearance or pick a tier III) shows `ENCRYPTED · CLEARANCE 2` and does not capture, the new card; cross a step in flight (set the store just below a step via the DEV handle or operator API) → the notice, then the end screen shows the hangar with the reveal; DATA: the hangar, the SIGNALS section, a capture with the real photo + Commons link + intercepted frame, FLY THERE launches a LIVE flight at the landmark. Screenshots in the lot's `shots/`.
- CHANGELOG (French, `### Ajouté` / `### Modifié`): the clearance, the hangar and the machine pool (freestyle from the start, the swarm last), the captures in DATA, the scanner's new loading and shapes, the take-off notice and next-signal line, the card's new look, the Commons link, the privacy note.
- Docs last: `HANDOFF.md` (the signals feature: verified vs unverified), `../docs/manual.md` (what signals, clearance and the hangar are, where the captures are, the external services), `../CLAUDE.md` (one line under Critical constraints or Scene loading: the game depends on Overpass, Wikidata/Commons, Nominatim at runtime; failures must degrade, never block).

Commits: one per concern.

## Out of scope

- Following the drone with signal tiles beyond 3 km of take-off (the author did not ask for it).
- Scores, rankings, sharing.
- A capture calibration tool.
