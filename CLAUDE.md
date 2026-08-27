# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository structure

Two-part project (one git repo overall — see "Repo & cross-session roadmap"):

- **`sim/`** — the actual product: a browser-based FPV drone simulator (Three.js
  rendering, Rapier/WASM physics), built with Vite. This is where almost all
  work happens.
- **`flyover-reverse-engineering/`** — originally a clone of
  [retroplasma/flyover-reverse-engineering](https://github.com/retroplasma/flyover-reverse-engineering)
  (its own git repo; last upstream commit 2021), but actively developed here
  too — it's fair game to modify, not a frozen dependency. A Go program that
  reverse-engineers Apple Maps Flyover's undocumented API to download 3D
  photogrammetry tiles (C3M/C3MM formats). `sim/` consumes its output via
  `sim/tools/add-map.mjs`.

## Commands

### `sim/` (run from `sim/`)

```bash
npm install
npm run dev            # http://localhost:5173, vite dev server
npm run build           # vite build
npm run add-map -- "Name" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256]
                         # download (via the Go exporter) + convert + register a new map
npm run selftest [sceneDir]   # headless checks: geodesy, flight envelope, propulsion,
                               # collision, UV convention — no browser, no test framework;
                               # default scene is public/scenes/tour-eiffel
npm run tune                    # rate-loop step-response bench (no scene needed)
npm run tune -- --sweep roll    # search P/D for one axis and rank by cost
node tools/selftest.mjs public/scenes/<slug>   # run selftest against a specific scene
```

No lint/formatter is configured for `sim/` — there's no eslint/prettier config.

### `flyover-reverse-engineering/` (run from that directory)

```bash
go run cmd/export-obj/main.go <lat> <lon> <zoom> <tryXY> <tryH> [--parallel]
go run cmd/auth/main.go [url]
go run cmd/parse-c3m/main.go [file]
go run cmd/parse-c3mm/main.go [file] [file_number]
```

Requires `config.json` (`resourceManifestURL`, `tokenP1`) populated first —
see that directory's `README.md` ("Setup" section). Normally you don't call
this directly; use `npm run add-map` from `sim/` instead, which wraps it.

## Architecture

### Data pipeline

`lat,lon` → Go exporter (`flyover-reverse-engineering/cmd/export-obj`, walks
an octree of C3M/C3MM tiles) → OBJ+MTL+JPEG under
`flyover-reverse-engineering/downloaded_files/obj/<lat>-<lon>-<zoom>-<radius>-<altitude>/`
→ `sim/tools/prep.mjs` converts to engine-ready binaries in
`sim/public/scenes/<slug>/` → `sim/tools/add-map.mjs` wraps both steps and
registers the result in `sim/public/scenes.json`. See `sim/README.md` for the
full explanation of what `prep.mjs` does and why (VRAM/draw-call reduction,
texture-array packing, ECEF→ENU conversion) — it's not obvious from the code
alone and shouldn't be re-derived from scratch.

### Multi-scene / menu system

`public/scenes.json` is the manifest `src/main.js` reads at boot to show a
scene-picker menu (`src/hud.js` `showMenu`) before any heavy loading starts.
`src/loader.js`'s `setScene(slug)` must be called before
`loadManifest()`/`loadChunks()`/`loadCollision()` — there is no default baked
into the loader. `?scene=<slug>` in the URL skips the menu.

### Physics / flight / input contract

Three files, one direction of flow — sticks → controller → four motor
commands → airframe → Rapier:

- `src/input.js` normalizes gamepad/keyboard to
  `{throttle 0..1, roll/pitch/yaw -1..1}`. Per-device axis mapping is
  auto-detected (EdgeTX/Radiomaster regex vs. generic gamepad default) and
  user-overridable via the in-app settings panel (`Tab`), persisted to
  `localStorage`.
- `src/flightController.js` is Betaflight-shaped and nothing else: actual
  rates, PID with iterm-relax/TPA/feedforward, RC smoothing, airmode mixer.
  `update(sticks, state, dt) -> {motors[4], throttle, axes}`. **This interface
  is narrower than it looks** — four motor outputs is exactly what a real
  Betaflight SITL bridge speaks, so a bridge can replace this file without
  touching anything else. Don't put airframe knowledge in here.
- `src/quad.js` is the airframe and the air: motor lag, thrust and prop drag
  torque, axial-inflow and rotor drag, anisotropic body drag, ground effect,
  propwash, battery sag and drain. No Rapier, no DOM — deliberately, so it can
  be benched headlessly. Don't put controller knowledge in here.
- `src/wind.js` is the air itself: a wind field (boundary-layer profile,
  wander, Poisson gusts, Dryden turbulence, terrain interaction) in world ENU
  metres. Pure model — no Rapier, no DOM — on the same pattern as `link.js`:
  it says which rays to cast and what the distances mean, `physics.js` casts
  them. Seeded, so `selftest` can assert properties of turbulence rather than
  sample them.
- `src/physics.js` is the Rapier glue: full-resolution trimesh collision on
  whatever scene is loaded with CCD enabled (so fast movement can't tunnel
  through thin structures), plus the body whose mass properties come from
  `quad.js`.

**Gains and thresholds in these files are measured, not chosen.**
`npm run tune` (`tools/tune-pid.mjs`) runs step responses against the real
inertia tensor and motor lag and reports rise/overshoot/settle/bounce, with
`--sweep <axis>` to search P/D. Its pass thresholds are themselves derived from
the airframe's measured angular acceleration, so a preset is never failed for
commanding more rate than the quad can physically build. Retune there; never
hand-edit `PID` and call it done.

### Non-obvious constraints worth knowing before touching related code

- Coordinates are converted from ECEF to local ENU **meters** at prep time
  (X=east, Y=up, Z=south) — this is what lets the physics/flight code work in
  plain meters. Don't reach for the upstream repo's
  `scripts/center_scale_obj.js`; it normalizes to 10 arbitrary units and isn't
  used here.
- The drone's collider stays a **sphere of radius 0.15** even though the
  airframe model is a flat X with motors at ±0.078 m. `camera.near` is pinned
  to that radius, so any collider that could get closer to the camera would
  put geometry inside the near plane. The realism lives in the mass properties
  (`setAdditionalMassProperties` with the anisotropic inertia tensor from
  `quad.js`), not in the collision shape.
- Linear and angular damping on the drone body are **zero on purpose**. Every
  force it feels is a real one computed in `quad.js`; a Rapier damping term on
  top would be the same drag counted twice.
- `camera.near` is pinned to the drone collider's radius (0.15), not a
  smaller "safe-looking" value — photogrammetry has near-coplanar surfaces
  that z-fight badly if `near` quantizes the depth buffer too coarsely at the
  tile's far edge.
- **Every raycast user gets its own `RAPIER.Ray`.** There are three
  (`_ray` for ground effect, `_linkRay` for the video link, `_windRay` for the
  wind rosette) because the objects are mutated in place and the three queries
  interleave — ground effect runs inside `step()`, the link query runs from the
  render loop in between. A fourth caller reusing an existing one corrupts the
  other silently.
- Physics forces must be reset every step (`resetForces()`/`resetTorques()`)
  — Rapier accumulates applied force across steps otherwise.
- Texture UV V-axis is flipped in `prep.mjs`, not left as the OBJ exports it —
  see `sim/README.md` ("Sur le gris : ce n'était pas les données") before
  assuming grey/broken-looking textures are a data problem; they were a UV
  bug.

For anything not covered here, `sim/README.md` (user-facing: commands, adding
maps, prep pipeline internals) and `sim/HANDOFF.md` (session-by-session
findings, what's verified vs. not) are the sources of truth — prefer updating
those over duplicating their content back into this file.

## Repo & cross-session roadmap

This whole tree (`sim/`, `flyover-reverse-engineering/`, docs) is one git
repo, pushed to a private GitHub repo: `lionrayonnant/FPVMaps`
(`origin`). `flyover-reverse-engineering/` was originally its own git repo
(fork of `retroplasma/flyover-reverse-engineering`) — that history is
preserved at `flyover-reverse-engineering/.git-upstream-backup/` (gitignored,
not part of this repo's history) rather than lost.

`flyover-reverse-engineering/config.json` holds a real Apple Flyover auth
token — it's gitignored; `config.json.example` shows the expected shape.
Never remove it from `.gitignore` or add a filled-in `config.json`.

**The roadmap lives in GitHub Issues + a GitHub Project (kanban board) on
that repo, not in a markdown file.** This is deliberate — it's meant to
survive across sessions (and across different Claude instances) as the
shared source of truth for what's done, in progress, blocked, or abandoned.
Board: `gh project view 2 --owner lionrayonnant` (or
`https://github.com/users/lionrayonnant/projects/2`), `Status` field =
Todo / In Progress / Blocked / Done. Conventions:

- Every piece of work is an issue on the board, in one of those four
  columns. The column is the source of truth for status — don't also
  maintain `in-progress`/`blocked` labels in parallel, that just invites
  drift between the two.
- Move an issue to `In Progress` when you start it this session; move it
  back to `Todo` if you stop before finishing (so the next session doesn't
  think it's actively being worked when it isn't). Move to `Blocked` when
  stalled on a decision or missing info from the user — say what's needed in
  a comment.
  `gh project item-edit 2 --owner lionrayonnant --url <issue-url> --field Status --value "In Progress"`
- Closing an issue (GitHub's close, not just moving the card) is what marks
  it `Done` on the board. If an approach is tried and dropped instead of
  finished, **close the issue with a comment explaining why** and add the
  `abandoned` label — a closed issue defaults to reading as "done", and
  without the label + comment an abandoned attempt looks like a success.
- File a new issue (and add it to the board) for follow-up work discovered
  mid-session rather than leaving it as a TODO comment in code or a passing
  mention in a doc.
- At the start of substantive work, check the board
  (`gh project item-list 2 --owner lionrayonnant`) before assuming there's no
  prior context or plan.

Commit and push when you reach a good checkpoint — don't let work pile up
uncommitted across sessions. Ordinary commits/pushes to this private repo
don't need per-action confirmation; force-pushes, history rewrites, and
anything touching `origin`'s branch protection still do.

## Token economy in this repo

- Routine work here (adding a map, doc edits, wiring up a small feature,
  running selftest) doesn't need Opus/high effort — default to a cheaper
  model/lower effort and reserve Opus/high for physics/rendering bugs or
  architecture decisions, where the failure modes are subtle enough that
  the extra reasoning pays for itself.
- **Never `Read` files under `flyover-reverse-engineering/downloaded_files/`,
  `flyover-reverse-engineering/cache/`, or `sim/public/scenes/`.** They're
  gitignored raw/prepped tile data — a single tile's `.obj` can exceed
  500MB, and a scene's texture sheets are tens to hundreds of MB each.
  Inspect them with `ls`/`du -sh`/`stat` from the shell, never the Read tool.
- `go run cmd/export-obj` and `npm run add-map` print one line per tile
  scanned — thousands of lines for a full-area download. Redirect to a file
  and `tail`/`grep` it (as done for the two existing scenes); don't let it
  stream into context.
- For exploration spanning many files in `pkg/` (Go) or `src/` (JS), prefer
  the Explore agent over reading files one by one in the main thread.
