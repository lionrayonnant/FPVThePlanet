# CLAUDE.md

Guidance for Claude Code working in this repository.

## Repo

Two-part project:
- `sim/`: browser FPV drone simulator (Three.js, Rapier/WASM, Vite). Main development target.
- `flyover-reverse-engineering/`: Go exporter/reverse-engineering tool for Apple Maps Flyover C3M/C3MM tiles. Actively maintained here.

`sim/tools/add-map.mjs` wraps the Go exporter + conversion pipeline.

## Commands

From `sim/`:
```bash
npm install
npm run dev
npm run build
npm run add-map -- "Name" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256]
npm run selftest [sceneDir]
npm run tune
npm run tune -- --sweep roll
node tools/selftest.mjs public/scenes/<slug>

From flyover-reverse-engineering/:

go run cmd/export-obj/main.go <lat> <lon> <zoom> <tryXY> <tryH> [--parallel]
go run cmd/auth/main.go [url]
go run cmd/parse-c3m/main.go [file]
go run cmd/parse-c3mm/main.go [file] [file_number]

Normally use npm run add-map rather than calling the Go exporter directly.

No ESLint/Prettier is configured.

Architecture
Map pipeline

lat,lon
→ Go exporter
→ OBJ/MTL/JPEG
→ sim/tools/prep.mjs
→ sim/public/scenes/<slug>/
→ sim/tools/add-map.mjs
→ sim/public/scenes.json

See sim/README.md for prep details. Do not re-derive or replace its ECEF→ENU, VRAM, draw-call, or texture-array logic without reason.

Scene loading

public/scenes.json drives the scene menu.

src/loader.js:sceneBase(slug) gives the URL prefix; pass it explicitly to loadManifest(), loadChunks() and loadCollision(). There is no mutable current-scene global: two zones can preload concurrently (the TARGET SCAN is cancellable) and each must keep reading its own.

?scene=<slug> bypasses the menu.

Flight stack

Flow:
input.js → flightController.js → quad.js → physics.js/Rapier

input.js: normalized sticks {throttle 0..1, roll/pitch/yaw -1..1}; auto device mapping + user overrides persisted in localStorage.
flightController.js: Betaflight-shaped controller only. update(sticks, state, dt) -> {motors[4], throttle, axes}. Keep airframe knowledge out.
quad.js: airframe/air model: motor lag, thrust, prop drag torque, inflow, rotor/body drag, ground effect, propwash, battery sag/drain. No Rapier/DOM. Keep controller knowledge out.
physics.js: Rapier integration, full-resolution trimesh collision, CCD, body mass properties.

The 4-motor controller output is an intentional narrow interface for future SITL replacement.

Tuning

PID/gains/thresholds are measured, not arbitrary.

Use npm run tune / tools/tune-pid.mjs for retuning. Do not hand-edit PID values and consider the job done.

Critical constraints
Coordinates are local ENU meters after prep: X=east, Y=up, Z=south. Do not use upstream center_scale_obj.js.
Drone collider is always a sphere radius 0.15 m. Camera near is exactly 0.15.
Realism comes from quad.js mass/inertia, not a more detailed collider.
Rapier linear/angular damping is zero intentionally; drag is computed by quad.js.
Reset Rapier forces/torques every step (resetForces() / resetTorques()).
UV V-axis is flipped in prep.mjs. Check sim/README.md before diagnosing grey textures as bad source data.
Do not read raw/prepped scene data with Read.
Documentation

Sources of truth:

sim/README.md: commands, maps, prep pipeline.
sim/HANDOFF.md: current verified/unverified state only. Detailed per-subsystem session narratives are split into sim/docs/handoff-archive/*.md — read one only when touching that subsystem.
sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md: the art direction and the target experience. Validated; do not re-litigate it, implement it.
sim/docs/FPVThePlanet! — Roadmap d'implémentation DA - UX.md: the 27 phases turning the sim into that experience (PHASE 26 = BENCH, the sandbox mode).
sim/docs/fpv-rework-architecture.md: audit of the existing code, the cross-cutting decisions (D1-D7), and what each module becomes. Read before touching the rework.
GitHub Issues + Project: roadmap/status. The rework is issues PHASE 00-26, label roadmap-da, milestones P0-P3.

Prefer updating these docs rather than duplicating information here.

GitHub workflow

Repo: private lionrayonnant/FPVTP.

At the start of substantive work:

gh project item-list 2 --owner lionrayonnant

Every piece of work should have a GitHub Issue on Project 2.

Status:

start work → In Progress
stop unfinished → Todo
blocked by user/decision → Blocked + comment explaining what's needed
finished → close issue → Done
abandoned → close + comment + abandoned label

Create a new issue for follow-up work discovered during a session rather than leaving TODOs in code.

Commit and push at good checkpoints. Normal commits/pushes need no confirmation. Do not force-push/rewrite history or bypass branch protection.

Versioning

SemVer. The number lives in `sim/package.json`, the entries in `CHANGELOG.md` at the repo root, each published version carries a `vX.Y.Z` git tag and a GitHub Release.

Add entries under `## [Non publié]` as you work — that section is what a release turns into notes.

Cut a version with `npm run release -- patch|minor|major|X.Y.Z` (from `sim/`). It bumps, dates the section, commits and tags; it never pushes. Pushing the tag is what triggers `.github/workflows/release.yml`. Do not hand-edit the version or the released sections.

The `BUILD NOTES` build numbers (`sim/tools/buildnotes-model.mjs`) are diegetic lore, unrelated to the real version.

Secrets / large data

flyover-reverse-engineering/config.json contains a real Apple Flyover token and is gitignored. Never remove it from .gitignore or commit it. config.json.example documents its shape.

Never use Read on:

flyover-reverse-engineering/downloaded_files/
flyover-reverse-engineering/cache/
sim/public/scenes/

These contain huge generated files. Use ls, du, stat, grep, etc. from the shell.

Exporter commands can produce thousands of lines. Redirect output to a file and inspect with tail/grep.

For exploration across many files in pkg/ or src/, prefer an Explore agent.