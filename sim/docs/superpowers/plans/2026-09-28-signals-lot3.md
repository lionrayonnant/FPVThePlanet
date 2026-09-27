# Signals — Lot 3: DOSSIER, clearance, and the terminal's grammar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator can consult what they captured (DOSSIER), progression opens through CLEARANCE (tiers + the drone draw pool), and every signal surface — scanner, flight notice, next-signal line, UPLINKED card — speaks the terminal's grammar the Bible sets.

**Architecture:** Pure models decide (`tools/signal-clearance-model.mjs`, `tools/dossier-model.mjs`, the existing capture/store/callout/card models extended); `generateTargetScan` takes the allowed families so client and server draw the same machine; the signal source exposes progress and its cache; one new server route serves a single session photo; the DOSSIER is a root terminal mode built like the DATA screen; `main.js` wires the flight pieces.

**Tech Stack:** ES modules, Node `assert/strict` selftests, Leaflet canvas layer, IndexedDB, the operator HTTP API (`server/api.mjs`).

**Spec:** `sim/docs/superpowers/specs/2026-09-27-signals-design.md` §2 (tiers, clearance), §5 (DOSSIER). Lots 1–2 are on this branch's base (PR #186, #187). Issue #185.

**Mockups (validated by the author, 2026-09-28) — the visual source of truth:** `sim/docs/superpowers/mockups/dossier-v3.html`, `scanning-v3.html`, `signals-toast.html`, `flight-da.html`. Open them in a browser (they reference `/files/…` images of the brainstorm server; the layout and CSS are what matter).

## Decisions taken with the author (2026-09-28)

- **Art direction:** the terminal's grammar (Bible §38–§44; the DATA screen in `src/terminal.js` is the reference): one narrow column, Departure Mono titles, thin rules, mono lists with aligned columns, underlined caps links, `[+] [!] [*] [?]` marks (§40), no cards/boxes/dashboards/rounded corners, functional colours only (green = uplinked, yellow = a signal to go for, never the demo palette). The author rejected an earlier "web UI" mockup as "too AI".
- **DOSSIER** (the name stays): a root terminal mode next to DATA. PLACES as underlined links `PARIS 8/49 · KYOTO 3/61`; the selected place's list: `[+] NAME  date  machine` for uplinked, `[?] ▓░▒…  2.7 km  TIER II` for known-but-not-uplinked. Opening a capture: **the real photo first and large**, the name, the description as the foot line, key/value facts (UPLINKED, MACHINE, HOLD, RANGE, SESSION, TYPE, BUILT, HEIGHT, STATUS), the credit with a **link to the Commons file page**, then an `INTERCEPTED` section with the operator's frame small, then `[ FLY THERE ] [ PREVIOUS ] [ NEXT ] [ BACK ]`. FLY THERE launches a LIVE flight at the landmark.
- **No new image storage:** the reference photo is fetched live from Wikimedia (browser cache + place-info cache); the intercepted frame is the existing session photo, served by a new single-photo route. A capture made without a session has no frame in the DOSSIER.
- **Scanner loading:** the glitch lives only on the tile being asked, only while asked: the basemap inside it tears into displaced grey slices under ASCII noise, its hairline flickers. **Signals never move** — they appear, still, when their tile lands. Messages are terminal lines in the map corner (no box, no bar widget): `[*] SIGNAL SCAN  z12/x/y` / `▓▓▓░░░░░░  3/16_`, `[+] 42 SIGNALS IN VIEW`, `[!] SIGNAL SCAN UNAVAILABLE` / `RETRY IN 0:52 · THE MAP STILL WORKS`. Base palette only.
- **In flight, at take-off:** no extra OSD line. A one-shot notice in the exact style of the OSD's centre lines (`#fo-hint` / `#fo-cut`: same face, size, colour, scrim), above them, when control is acquired: `[*] SIGNAL SCAN · 2/7` while it finishes, then `[+] 49 SIGNALS IN RANGE`, gone after ~4 s. (The author: "a popup when control is acquired that fades — something clean".)
- **Next signal:** one more line in the top-left OSD block, same face as OPERATOR / LIVE: `NEXT SIGNAL 1.2 km ↗` (arrow relative to heading, "NEXT SIGNAL" in yellow); hidden while a callout is on screen; hidden when nothing is left.
- **UPLINKED card** redrawn in the terminal's grammar (mockup `flight-da.html`): hairline frame, square corners, the OSD scrim, header `[+] UPLINKED` / `SIGNAL n · 212 m`, a green rule that shortens (the timer), the real photo large, name (Departure Mono), description, key/value lines, then the intercepted frame small with `INTERCEPTED / machine · HOLD 5.0 s`, then the credit. No pictograms, no filled boxes.
- **Colour-blind safety on the map:** to capture = filled yellow light; uplinked = hollow green ring with a tick; locked by clearance = small dim warm-white dot, no halo. The shape alone tells them apart.
- **Clearance and the draw pool (spec §2):** implemented now. CLEARANCE 0→2; each step opens a tier AND the machines that reach it; the draw stays random, its pool widens. Signals above the operator's clearance are visible, marked, not capturable.
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
| Create `tools/dossier-model.mjs` + selftest, `src/dossier.js`; modify `tools/bench-model.mjs` + `tools/bench-selftest.mjs`, `src/main.js`, `src/style.css` | The DOSSIER mode. |
| Modify `../README.md`, `docs/FPVThePlanet! — Art Direction & Experience Bible.md` | Privacy note; the clearance section. |
| Modify `../CHANGELOG.md`, `HANDOFF.md`, `../docs/manual.md`, `../CLAUDE.md` | Changelog; docs at the end. |

---

### Task 1: Clearance — model, encrypted targets, callout

**Files:** create `tools/signal-clearance-model.mjs`, `tools/signal-clearance-selftest.mjs`; modify `src/signal-capture.js`, `tools/signal-capture-selftest.mjs`, `tools/signal-callout-model.mjs`, `tools/signal-callout-selftest.mjs`, `src/signal-callout.js`, `package.json` (chain the new selftest after `signal-store-selftest`).

**Interfaces — Produces:**
- `tools/signal-clearance-model.mjs`:
  - `TIER_POINTS = { 1: 1, 2: 2, 3: 3 }`, `STEPS = [0, 6, 18]` (points needed for clearance 0, 1, 2), `MAX_CLEARANCE = 2`
  - `LEVELS = [ { tiers: [1], families: ['cinewhoop', 'toothpick', 'freestyle5'] }, { tiers: [1, 2], families: [... , 'race5'] }, { tiers: [1, 2, 3], families: [... , 'longrange', 'heavy5'] } ]` (each level includes the previous)
  - `pointsOf(store) -> number` — sum of `TIER_POINTS[entry.tier]` over `fromStored(store).resolved`
  - `clearanceOf(store) -> 0|1|2`; `nextStep(store) -> { level, points, need } | null` (null at max)
  - `tierAllowed(level, tier) -> boolean`; `familiesFor(level) -> string[]`
- `src/signal-capture.js`: a target may carry `encrypted: true` → its row state is `'encrypted'` (shown within `SHOW_M`, never a candidate, never a gauge, never focus). State strings become `hidden|near|capturing|held|resolved|encrypted`.
- `tools/signal-callout-model.mjs`: `headline('encrypted', { need }) -> { word: \`ENCRYPTED · CLEARANCE ${need}\`, tone: 'dim' }`; `revealCount(n, g, 'encrypted') -> 0`.
- `src/signal-callout.js`: renders the encrypted headline, no gauge.

Tests first: points/levels at the step boundaries (5→0, 6→1, 17→1, 18→2); families of each level include the previous and match the six ids of `tools/target-model.mjs` `TARGET_FAMILIES` exactly (import it and assert the union of LEVELS[2].families equals it); an encrypted target dead ahead in range for 10 s never uplinks and reports `'encrypted'`; a signal resolved earlier stays `'resolved'` even if its tier is above the current clearance; callout headline/reveal for `'encrypted'`.

Commit: `Signals: clearance — tiers and machines open with what you uplinked (#185)`

---

### Task 2: The draw pool follows the clearance

**Files:** `tools/target-model.mjs`, `tools/target-model-selftest.mjs` (or the selftest that covers it — find it: `grep -l generateTargetScan tools/*selftest*`), `src/target-scan.js`, `src/ambient.js`, `src/main.js`, `server/api.mjs` (`POST /:id/sessions`, ~l.363-380), `tools/session-api-selftest.mjs`.

- `generateTargetScan({ seed, count, swarmChance, families = TARGET_FAMILIES })` draws with `pick(rand, families)` (l.105). `families` must be a non-empty subset of `TARGET_FAMILIES` (validate; fall back to `TARGET_FAMILIES` on anything else). Same seed + same families → same scan.
- Every call site passes the SAME `families` for the same flight: `src/target-scan.js:34`, `src/main.js` (~l.3681, ~l.3783), `src/ambient.js:44`. Compute it ONCE per flight choice in `main.js` from `familiesFor(clearanceOf(operator.getOperator()?.signals))` and thread it.
- Server: the `POST /sessions` body carries `clearance` (0–2) next to `targetSeed`/`targetCount`/`swarmChance`; the server regenerates with `familiesFor(clampedClearance)` (import `tools/signal-clearance-model.mjs`). Missing/invalid → the full pool (older clients keep working).
- Tests: same seed with the full pool vs clearance 0 differs only in families and never draws a family outside the level; a scan regenerated server-side with the same body resolves the same family as the client for every index (session-api selftest: post a session with `clearance: 0` and assert the stored target family ∈ level-0 families).
- The swarm pseudo-family stays out of the pool logic (it is injected separately on candidate 0).

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
- Verify by `node tools/scanner-selftest.mjs && node tools/palette-selftest.mjs` and the Node import check of `src/map-signals.js`; the look is verified in Task 9.

Commit: `Signals: the scanner scans like a terminal — a glitching tile, still lights, plain lines (#185)`

---

### Task 6: In flight — take-off notice, next signal, the card, place at uplink, encrypted targets

**Files:** `src/fpvtp-osd.js`, `src/signal-card.js`, `tools/signal-card-model.mjs` + selftest, `src/style.css`, `src/main.js`. Mockups: `signals-toast.html`, `flight-da.html`.

- `FpvtpOsd.setNotice(text, ms)` — a one-shot centre line with its own element `#fo-notice` styled exactly like `#fo-hint` (same rule: copy its declarations, `top: 40%`), self-expiring like `setInputLost` (`_noticeUntil` checked in the paint), fading out over the last 0.5 s (opacity only). `[+]` in green via a span. At the handover (`main.js` ~l.4120, where `fpvtpOsd.setHint(null)` runs): if the flight's signals are still loading, show `[*] SIGNAL SCAN · done/total` and update it on each source change; when loaded, `[+] N SIGNALS IN RANGE` for 4 s (N = capturable, not resolved, not locked); `NO SIGNAL IN RANGE` if N = 0. Nothing on the bench.
- `NEXT SIGNAL` line: a new `#fo-next` div at the end of `.corner.tl`; `update({ …, next })` with `next = { distM, relRad } | null`; text `NEXT SIGNAL` (yellow span) + ` ${km < 1 ? Math.round(m) + ' m' : km.toFixed(1) + ' km'} ${ARROWS[i]}`; hidden when `next` is null. Export `ARROWS` from fpvtp-osd.js and reuse the wind index formula. In `main.js`: the nearest flight signal that is not resolved and not locked (distance from `droneGeo` lat/lon — add `distanceM`/bearing from `tools/signal-model.mjs` `distanceM` and a bearing via `bearingTo(dEast, dSouth)` on local ENU when the anchor exists, else from lat/lon), `null` while a callout is on screen or when none is left. Update at 5 Hz, not every frame.
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

### Task 8: The DOSSIER

**Files:** create `tools/dossier-model.mjs`, `tools/dossier-selftest.mjs`, `src/dossier.js`; modify `tools/bench-model.mjs` (`MODES` + `MODE_SELECT.dossier` — `label: 'DOSSIER'`, two English lines, e.g. `what you uplinked · where` / `the places still out there`), `tools/bench-selftest.mjs` (the exact MODES array), `src/main.js` (root loop: an explicit `if (mode === 'dossier')` branch mirroring `dataLoop`; a picked `{ live }` re-enters `fieldLoop(ui, { quickRestart: pick })`), `src/style.css`, `package.json` (chain `dossier-selftest`). Mockup: `dossier-v3.html`. The DATA screen (`src/terminal.js` `dataScreen`, ~l.733-1010) is the pattern: title, foot, `section()`, `link()`, `behind()`, `menuNav`, `BACK`.

**Model (`tools/dossier-model.mjs`, pure):**
- `buildDossier({ store, known, now }) -> { uplinked, knownCount, places: [{ name, uplinked: Entry[], known: Signal[], total }] }` — places from the resolutions' `place` (entries without a place go to `ELSEWHERE`), sorted by uplinked count desc then name; a place's `known` = cached signals (`known`) not resolved whose nearest resolution is that place's and within 5 km of it; `total = uplinked + known`.
- `listRows(place, clearance) -> Array<{ kind: 'uplinked'|'known'|'locked', id, text, right }>` — uplinked first (newest first): `NAME` / `dd.mm  MACHINE`; then known nearest to the place's centroid first: scrambled name (reuse `scramble` from `tools/signal-callout-model.mjs`, a stable seed per id) / `2.7 km  TIER II`, `locked` when the tier is above the clearance (right side `CLEARANCE n`). Cap known rows at 12 + a `…N MORE` row.
- `detailRows(entry, signal, info) -> Array<[label, value]>` — UPLINKED `dd.mm.yy / hh:mm`, MACHINE, HOLD `x.x s`, RANGE `n m`, SESSION (from the session id, uppercased, `-` → space), then TYPE, BUILT, HEIGHT, STATUS (same sources as the card).
- `creditOf(info) -> { text, href|null }` — `© AUTHOR · LICENCE · WIKIMEDIA COMMONS` + the validated page URL; `DATA © OPENSTREETMAP · WIKIDATA` separately.
- Tests: grouping, ELSEWHERE, ordering, the 5 km assignment, locked vs known, the 12-row cap, scramble stability, detail rows, credit link validation, empty store.

**Screen (`src/dossier.js`, `runDossier(root, { api }) -> Promise<{ live, place } | null>`):**
- List view per the mockup: `DOSSIER` title; foot `N SIGNALS UPLINKED · M KNOWN · P PLACES` + `CLEARANCE n · k POINTS TO NEXT` (or `CLEARANCE 2 · MAX`); section PLACES with the place links (`NAME u/t`, the selected one underlined in ink); section `<PLACE>` with a sub line (`u UPLINKED · k STILL OUT THERE · NEAREST FIRST`) and the rows as a `<pre>`-like list of focusable rows (uplinked rows are links to the detail; known/locked rows are not focusable); `[ BACK ]`. Empty state: `NOTHING UPLINKED YET` + one faint line `GO FLY — FIELD → A SIGNAL ON THE SCANNER`.
- Detail view: title = the name; foot = the description; the reference photo (`safeImageUrl`), full column width, 3:2, collapsed if none; its credit line with the Commons link (`[ SOURCE ]` as a link, opens a new tab); a thin rule; the key/value `<pre>`; section `INTERCEPTED` with the session photo (via `fetchPhoto`, 46 % width, revoked on leave; the line `NO FRAME — CAPTURED WITHOUT A SESSION` if none) and its caption; buttons `[ FLY THERE ] [ PREVIOUS ] [ NEXT ] [ BACK ]`. FLY THERE resolves `{ live: [lat, lon], place: entry.place ?? null }`.
- Data: `api.getOperator().signals`, `sharedSignalSource().cachedSignals()`, `sharedPlaceInfo().info(id)` per opened detail (and prefetch the next), `fetchPhoto(entry.sessionId, entry.photo)`.
- Keyboard/pad via `menuNav` like DATA; Escape = BACK.

Commit(s): `Signals: the DOSSIER — what you uplinked, where, and what is still out there (#185)`

---

### Task 9: README privacy note, the Bible section, verification, changelog, docs

**Files:** `../README.md`, `docs/FPVThePlanet! — Art Direction & Experience Bible.md`, `../CHANGELOG.md`, `HANDOFF.md`, `../docs/manual.md`, `../CLAUDE.md`.

- README: a short `Privacy` section (English): what the player's browser contacts directly and why — Google Earth tiles (live terrain), OpenStreetMap tiles and Nominatim (map, search, place names), Overpass (landmark signals), Wikidata and Wikimedia Commons (the real photo and facts of a captured place) — each sees the player's IP and what is asked; nothing else leaves the machine except to the game's own server; no analytics.
- Bible: a new section after §19 or in §2/§3 as fits (read the table of contents), in French, in the Bible's voice: *Signaux et habilitation* — the author relaxed the no-progression rule on 2026-09-27 (diegetic progression allowed; scores and rankings still out); why a clearance exists in this universe (the operator's standing with the network they feed; each uplinked landmark proves the link and opens heavier machines); what it is NOT (no XP bar, no reward screen, no level-up fanfare; it reads as a line in the terminal). Keep it ~40–60 lines.
- Browser verification (dev server from this worktree; chrome-devtools MCP with `isolatedContext`, `navigator.getGamepads = () => []` after each navigation; the DEV `window.__signals` handle to set poses): scanner glitch + lines + shapes; FIELD flight with a session: take-off notice, NEXT SIGNAL line, an encrypted signal (lower the clearance or pick a tier III) shows `ENCRYPTED · CLEARANCE 2` and does not capture, the new card; DOSSIER list, detail with the real photo + Commons link + intercepted frame, FLY THERE launches a LIVE flight at the landmark; the TARGET SCAN at clearance 0 only offers level-0 machines. Screenshots in the lot's `shots/`.
- CHANGELOG (French, `### Ajouté` / `### Modifié`): the DOSSIER, clearance and the machine pool, the scanner's new loading and shapes, the take-off notice and next-signal line, the card's new look, the Commons link, the privacy note.
- Docs last: `HANDOFF.md` (the signals feature: verified vs unverified), `../docs/manual.md` (what signals/clearance/DOSSIER are, the external services), `../CLAUDE.md` (one line under Critical constraints or Scene loading: the game depends on Overpass, Wikidata/Commons, Nominatim at runtime; failures must degrade, never block).

Commits: one per concern.

## Out of scope

- Following the drone with signal tiles beyond 3 km of take-off (the author did not ask for it).
- Scores, rankings, sharing.
- A capture calibration tool.
