# CLAUDE.md

Guidance for Claude Code working in this repository.

## Repo

`sim/`: browser FPV drone simulator (Three.js, Rapier/WASM, Vite).

`sim/tools/add-map.mjs` wraps the terrain acquisition + conversion pipeline.

## Commands

From `sim/`:
```bash
npm install
npm run dev
npm run build
node server/index.mjs --data <dir> --dist dist   # le jeu sans Vite (#259)
npm run add-map -- "Name" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256]
npm run selftest [sceneDir]
npm run tune
npm run tune -- --sweep roll
node tools/selftest.mjs public/scenes/<slug>
```

No ESLint/Prettier is configured.

Architecture
Map pipeline

lat,lon
→ tools/lib/providers/google-earth.mjs (fetch + decode, in Node)
→ sim/tools/prep.mjs
→ sim/public/scenes/<slug>/
→ sim/tools/add-map.mjs
→ sim/public/scenes.json

See docs/manual.md for prep details. Do not re-derive or replace its ECEF→ENU, VRAM, draw-call, or texture-array logic without reason.

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
UV V-axis is flipped in prep.mjs. Check docs/manual.md before diagnosing grey textures as bad source data.
Do not read raw/prepped scene data with Read.
Documentation

Sources of truth:

docs/manual.md: commands, maps, prep pipeline.
docs/brand.md: the mark — geometry, lockups, clear space, what is forbidden. The files live in sim/public/brand/; copy from there rather than re-exporting.
sim/HANDOFF.md: current verified/unverified state only. Detailed per-subsystem session narratives are split into sim/docs/handoff-archive/*.md — read one only when touching that subsystem.
sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md: the art direction and the target experience. Validated; do not re-litigate it, implement it.
sim/docs/FPVThePlanet! — DA-UX Implementation Roadmap.md: the 27 phases turning the sim into that experience (PHASE 26 = BENCH, the sandbox mode).
sim/docs/fpv-rework-architecture.md: audit of the existing code, the cross-cutting decisions (D1-D7), and what each module becomes. Read before touching the rework.
GitHub Issues + Project: roadmap/status. The rework is issues PHASE 00-26, label roadmap-da, milestones P0-P3.

Prefer updating these docs rather than duplicating information here.

GitHub workflow

Repo: lionrayonnant/FPVThePlanet, being prepared to go public. It carries a
rewritten history and is NOT the repo the older docs were written against: the
original, `lionrayonnant/FPVTP`, stays private forever because its
`refs/pull/*` permanently pin commits that carried a personal email address.
Issue numbers quoted throughout this repo's history refer to that older repo
and do not resolve here until the issues are migrated. Push here, never there.

Licensed AGPL-3.0-only
(`LICENSE` at the root, `README.md` is the public front door — `docs/manual.md`
stays the technical one). Two things change the day the switch is flipped:
`sim/electron-builder.yml` can move from `provider: generic` to
`provider: github` (the generic HTTP feed only exists because a private repo
demands a token for every download), and `deploy/deploy.sh` no longer needs the
read-only token in `/etc/fpvtp/token`.

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

Work in a fresh worktree, one per piece of work. Never work directly in the
main checkout: create the worktree at the START of the task, from an up-to-date
`main`, and let it carry that task's branch alone. A second task means a second
worktree, never a reused one — a worktree that already has a branch's history in
it is how unrelated changes end up in the same PR. Remove it once the work is
merged.

Commit and push at good checkpoints. Normal commits/pushes need no confirmation. Do not force-push/rewrite history or bypass branch protection.

Versioning

SemVer. The number lives in `sim/package.json`, the entries in `CHANGELOG.md` at the repo root, each published version carries a `vX.Y.Z` git tag and a GitHub Release.

Add entries under `## [Non publié]` as you work — that section is what a release turns into notes.

Cut a version with `npm run release -- patch|minor|major|X.Y.Z` (from `sim/`). It bumps, dates the section, commits and tags; it never pushes. Pushing the tag is what triggers `.github/workflows/release.yml`. Do not hand-edit the version or the released sections.

The `BUILD NOTES` build numbers (`sim/tools/buildnotes-model.mjs`) are diegetic lore, unrelated to the real version.

CI

`.github/workflows/ci.yml` runs on push to `main` and on every PR: `npm run selftest:ci` (the chain that needs no installed scene, no network, no browser — ~2 min) and `npm run build` for `sim/`. The release workflow runs the same `selftest:ci` before publishing a tag.

Run `npm run selftest:ci` ONCE, at the very END of the work, right before
pushing — not after each step, not between two edits of the same change. The
chain takes minutes and re-running it mid-task buys nothing: what a step needs
is its OWN selftest (`node tools/<module>-selftest.mjs`), which costs seconds.
The full chain is the final gate, and the same rule binds subagents: a subagent
runs only the selftests of the module it touched, and the parent runs the chain
once when everything has landed. A selftest that needs scene data must SKIP
loudly when it is missing rather than fail — `tools/entry-state-selftest.mjs` is
the pattern.

`npm run selftest` and `npm run selftest:scenes` stay local: they read `sim/public/scenes/`, which is gitignored.

Commit identity

The repo is public: commits must never carry a personal address. `.githooks/pre-commit`
refuses anything outside a short allowlist — enable it once per clone with
`git config core.hooksPath .githooks`. Set `user.useConfigOnly true` globally so
git errors instead of inventing an identity from the hostname. The account-level
guard is the one that actually holds: GitHub → Settings → Emails → *Keep my email
addresses private* + *Block command line pushes that expose my email*.

This is not theoretical. A global identity left at `test <test>` signed 442
commits, and a personal address reached 6 more; removing it took a full history
rewrite, and GitHub's `refs/pull/*` kept the old commits anyway — which is why
the public repo had to be a fresh one.

Licensing

AGPL-3.0-only. New files need no per-file header — the repo has none — but do
not copy code in from an incompatible licence, and keep third-party licences
next to what they cover (`sim/public/fonts/OFL-*.txt` is the pattern).

Secrets / large data

Never use Read on:

sim/public/scenes/

This contains huge generated files. Use ls, du, stat, grep, etc. from the shell.

For exploration across many files in tools/ or src/, prefer an Explore agent.

Everything in the code, docs... must be in english. Do efficient comments.
