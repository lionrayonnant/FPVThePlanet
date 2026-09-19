# Contributing

Contributions are welcome. This file is the short version of how the project
works; the long version is in `CLAUDE.md`, which is written for whoever is
holding the keyboard, human or otherwise.

## Getting it running

You need Node 22 and a WebGL2 browser. Chromium is the safe choice, because its
Gamepad API picks up a radio as soon as you move a stick.

```bash
git clone https://github.com/lionrayonnant/FPVThePlanet.git
cd FPVThePlanet/sim
npm install
npm run dev            # http://localhost:5173
git config core.hooksPath .githooks    # once per clone, see "Commit identity"
```

A fresh clone has no terrain on disk and that is the normal state: the
catalogue starts empty and the LIVE tab streams tiles into your browser without
writing anything. `sim/public/scenes/` is gitignored and can reach a gigabyte
per city, so it never enters a commit.

## Before you open a pull request

Open an issue first for anything larger than a fix. The experience this game is
aiming at is already written down, and so is the order it gets built in — a
described problem is often already answered by something planned, or was ruled
out on purpose:

- `sim/docs/FPVThePlanet! — Art Direction & Experience Bible.md` — the target
  experience. It is settled; the useful discussion is about implementing it,
  not re-opening it.
- `sim/docs/FPVThePlanet! — DA-UX Implementation Roadmap.md` — the phases.
- `sim/docs/fpv-rework-architecture.md` — what each module is and becomes.
- `docs/manual.md` — commands, the map pipeline, the flight model, PID tuning.

## The rules that actually bite

**Run the selftests once, at the end.** `npm run selftest:ci` from `sim/` is the
same chain CI runs: no browser, no network, no installed scene, a couple of
minutes. `docs/manual.md` carries the check count — one place, so it can be
wrong in only one place. Run it right before you push, not between two edits
of the same change. While you work, run the selftest of the module you touched
instead — `node tools/<module>-selftest.mjs` costs seconds.

**A test that needs scene data must SKIP loudly, never fail.**
`sim/tools/entry-state-selftest.mjs` is the pattern to copy.

**Do not hand-edit PID values.** Gains, thresholds and airframe constants are
measured, not chosen. Retune with `npm run tune` (`sim/tools/tune-pid.mjs`) and
commit what the bench produced.

**English.** Code, comments, documentation, selftest labels, CI workflows and
filenames are English. Much of the tree is still French, and the rule is
per-file rather than one sweeping pass: **a file you touch for another reason
leaves in English.** Translate its comments and its selftest labels as part of
that work; do not open a separate translation pull request, and do not
translate files your change did not otherwise need. `CHANGELOG.md` entries stay
French — they are release notes, not code.

**Keep the module boundaries.** They are the reason the flight stack is
testable:

| module | owns | must not know about |
|---|---|---|
| `src/input.js` | normalised sticks, device mapping | the airframe |
| `src/flightController.js` | the Betaflight-shaped controller, `motors[4]` out | the airframe |
| `src/quad.js` | mass, inertia, motor lag, drag, ground effect, battery | Rapier, the DOM |
| `src/physics.js` | Rapier, collision, mass properties | the controller |

The four-motor controller output is a deliberately narrow interface, so that a
real SITL can replace the controller one day.

**Coordinates are local ENU metres** after prep: X east, Y up, Z south. The
drone collider is always a sphere of radius 0.15 m and the camera near plane is
exactly 0.15. Rapier damping is zero on purpose — drag is `quad.js`'s job.

**No force-pushing, no history rewriting.** The repository already survived one
full rewrite and it is why the old repository can never be made public.

## Commit identity

This repository is public and its commits must never carry a personal address.
`.githooks/pre-commit` refuses anything outside a short allowlist; enable it
once per clone with `git config core.hooksPath .githooks` and add your own
`<id>+<account>@users.noreply.github.com` to that list in the same commit as
your first contribution.

The guard that actually holds is on your account, not in this repo: GitHub →
Settings → Emails → *Keep my email addresses private* and *Block command line
pushes that expose my email*. Setting `git config --global user.useConfigOnly
true` makes git refuse to invent an identity from your hostname.

## Commits and pull requests

Write commit messages that say what changed and why the change is the right
one. The repository's history is unusually explanatory and that is deliberate —
it is the only place some decisions are recorded.

Add an entry under `## [Non publié]` in `CHANGELOG.md` as you go. That section
is what a release turns into notes, so an entry written after the fact is an
entry that gets forgotten.

Do not bump the version and do not hand-edit a released section. Releases are
cut with `npm run release -- patch|minor|major|X.Y.Z` from `sim/`, which bumps,
dates, commits and tags without pushing.

## Testing

Two mechanisms, and they answer different questions.

**Selftests** check what the code is supposed to do with the input it expects.
Each module has one next to it in `sim/tools/`; a new module arrives with one.

**Fuzzing** (`npm run fuzz`) checks what it does with input nobody wrote a test
for — a hand-edited `localStorage` key, a half-written operator file, a body
state that went to NaN after a crash. It is property-based and seeded, so a
finding replays. Every target states the invariant it verifies and the threat
model of its input, and that second part matters more than the generator: a
target fed input the function cannot really receive produces findings nobody
should act on. Read `sim/docs/handoff-archive/fuzzing.md` before adding one.

## Licence

The project is [AGPL-3.0-only](LICENSE), and contributions are accepted under
it. New files need no per-file header — the repository has none. Do not paste
in code under an incompatible licence, and keep third-party licences next to
what they cover (`sim/public/fonts/OFL-*.txt` is the pattern).

## Reporting a vulnerability

Not here. See [SECURITY.md](SECURITY.md).
