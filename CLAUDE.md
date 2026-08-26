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
npm run selftest [sceneDir]   # headless checks: geodesy, flight envelope, collision, UV
                               # convention — no browser, no test framework; default scene
                               # is public/scenes/tour-eiffel
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

- Rapier (WASM) trimesh collision at **full resolution** on whatever scene is
  loaded, with CCD enabled — needed so fast movement can't tunnel through
  thin structures.
- `src/flightController.js` exposes a deliberately narrow
  `update(sticks, state) -> {thrust, torque}` interface, kept substitutable by
  a future Betaflight SITL bridge. Don't widen this interface without reason.
- `src/input.js` normalizes gamepad/keyboard to
  `{throttle 0..1, roll/pitch/yaw -1..1}`. Per-device axis mapping is
  auto-detected (EdgeTX/Radiomaster regex vs. generic gamepad default) and
  user-overridable via the in-app settings panel (`Tab`), persisted to
  `localStorage`.

### Non-obvious constraints worth knowing before touching related code

- Coordinates are converted from ECEF to local ENU **meters** at prep time
  (X=east, Y=up, Z=south) — this is what lets the physics/flight code work in
  plain meters. Don't reach for the upstream repo's
  `scripts/center_scale_obj.js`; it normalizes to 10 arbitrary units and isn't
  used here.
- `camera.near` is pinned to the drone collider's radius (0.15), not a
  smaller "safe-looking" value — photogrammetry has near-coplanar surfaces
  that z-fight badly if `near` quantizes the depth buffer too coarsely at the
  tile's far edge.
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

**The roadmap lives in GitHub Issues on that repo, not in a markdown file.**
This is deliberate — it's meant to survive across sessions (and across
different Claude instances) as the shared source of truth for what's done,
in progress, blocked, or abandoned. Conventions:

- An open, unlabeled issue is backlog (to do).
- Label `in-progress` while actively working an issue this session; remove
  the label if you stop before finishing (so the next session doesn't think
  it's actively being worked when it isn't).
- Label `blocked` when stalled on a decision or missing info from the user —
  say what's needed in a comment.
- If an approach is tried and dropped, **close the issue with a comment
  explaining why** and add the `abandoned` label — don't just close it
  silently, and don't leave a dead approach undocumented in code comments
  instead.
- File a new issue for follow-up work discovered mid-session rather than
  leaving it as a TODO comment in code or a passing mention in a doc.
- At the start of substantive work, check open issues
  (`gh issue list --repo lionrayonnant/FPVMaps`) before assuming there's no
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
