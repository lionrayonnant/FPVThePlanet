# Manual — FPVThePlanet!

The technical manual: commands, map pipeline, flight model, tuning.
For what this project is and how to play it, see the
[README](../README.md).

Every command in this document is run from `sim/`.

```bash
cd sim
npm run selftest           # out-of-browser checks (see the limitation at the bottom of the page)
npm run selftest:operator  # operator state, terminal, scanner, world weather
```

> **Issue numbers.** The `#NNN` references scattered through this document point
> at the predecessor repository, which stays private. They do not resolve here,
> and a number that happens to exist on this repository is a *different* issue.
> They are kept because the repository's own history quotes them; read them as
> provenance, not as links.

## Contents

`grep -n '^#' docs/manual.md` for the exact line of a section.

- Controls
- Adding a map — from the game (GLOBAL SCANNER) · the legacy GUI ·
  from the command line · prerequisites · options · sizing `--radius` ·
  reworking a map
- Music — the generation pipeline · loops · normalisation · write-once
- Removing a map — when an area returns nothing
- The operator terminal
- Running the game without Vite — the standalone server
- The dialogue pipeline (crew RTC) — `dialogue:gen` · `dialogue:inspect` ·
  `dialogue:check` · the two backends · the review policy
- Available maps
- Exporting a scene to `.glb`
- Versioning and publishing — continuous integration · cutting a version
- Architecture
- Known limitation: `selftest` is Eiffel-Tower specific
- Technical details of the preprocessing — providers and decoders · rocktree
  fixtures · three settings that matter · about the grey
- The flight model — wind · rain · fog · sound · FPV rendering ·
  the video link · zone limits · tuning the PID

## Controls

**Gamepad / USB radio** detected automatically (Mode 2 by default), remappable
in **Tab** with live level bars to identify each axis.
**Chrome recommended**: the Gamepad API is more permissive there (detection on a
simple stick movement) than on Firefox, which is stricter about tab focus and
sometimes wants a button press before the device shows up at all.

**Keyboard**: `W`/`S` throttle · `A`/`D` yaw · arrows or mouse roll-pitch ·
`R` respawn · `M` mode (acro/angle/altitude) · `C` free camera · `Tab` settings.

## Adding a map

A map = an area downloaded (Google Earth — see
[Providers and decoders](#providers-and-decoders)) and then converted for
the engine.

### From the game — `GLOBAL SCANNER` (the main route)

```bash
npm run dev        # then http://localhost:5173 → [ GLOBAL SCANNER ]
```

The scanner is the game's worldwide entry point (PHASE 03): you search for a
place (`SEARCH LOCATION`, or coordinates "lat, lon"), frame it, draw the area
— `DRAW BOX` for a rectangle, `DRAW SHAPE` for a free outline — and
`AREA ANALYSIS` shows, before launching the tile grid, the
number of requests, the surface, the estimated weight and the duration.
`PROBE AREA` downloads a real sample at the centre of the area — that is the
only reliable proof that there is photogrammetry here. `ACQUIRE AREA` launches
the real pipeline with live logs, and offers `[ FLY ]` at the end.

The base layer is monochrome by default (`MONO`, OpenStreetMap inverted and
desaturated); `SAT` and `TERRAIN` are there for when recognising a building or a
relief helps to frame the shot. `SIGNAL DENSITY` / `TARGETS EST.` are estimates
of radio activity (Bible §6): they start from the OSM category of a point in the
area and from its surface, without drawing anything at random — target
generation itself is PHASE 7.

#### The free outline

A river, an avenue, the contour of a neighbourhood are not rectangles: following
them with a rectangle forces you to take the neighbouring blocks along.
`DRAW SHAPE` (issue #30) bounds the area with a polygon.

**A tile is kept as soon as the outline touches it, even by a corner.** The
extracted area is therefore always a *superset* of what is drawn — the same rule
as the rectangle, already rounded outwards onto the lattice. Two intended
consequences: what you draw is always entirely covered, and a corridor thinner
than a tile (~25 m at zoom 20) stays extractable, where a "centre inside the
outline" rule would give it zero columns.

The map then no longer shows a blue rectangle but **the staircase** of the tiles
that were kept: the shape actually extracted, as opposed to the smoothed outline,
which stays dashed. Unlike the lattice, it is drawn at every scale.

`TILES` announces the number of columns actually swept out of the bounding box
("8,069 / 15,812"): on an outline, the product `cols × rows` would be the
bounding box and would suggest twice as much downloading as there really is.

The predicate "does this tile touch the outline?" lives in
`tools/lib/tiles.mjs`, shared by the scanner (browser) and the dev API
(Node): `node tools/map-poly-selftest.mjs` checks it on cases reasoned out
by hand.

### The legacy extraction GUI

`http://localhost:5173/add-map.html` still does the same thing, in French and
outside the game. The scanner has absorbed it; it will disappear along with the
staging of acquisition (PHASE 5).

Its **FOURNISSEUR** selector offers `Auto` (only `Google Earth` is registered
since Apple Flyover was withdrawn, 2026-09-07) or `Google Earth` explicitly.

Two things are worth understanding:

- **The area is quantised.** A tile is about 25 m across at zoom 20;
  the area actually extracted is the one drawn, rounded onto the lattice. The
  map displays that lattice, and the drawn outline stays dashed next to it. On a
  polygon, the bounding box gives way to the staircase of the tiles kept.
  This lattice is not decoration: it comes from `tileGrid()` (`tools/lib/tiles.mjs`)
  — it is exactly the grid the acquisition will sweep. The greying-out of a
  region outside declared coverage (`plan.pruned`) stays in the code for a
  future provider with declared regions; `google-earth` never triggers it
  (its `rocktree` traversal has no such notion).
- **The estimates are ranges, not figures.** For an equal number of columns, a
  housing estate and a district of towers return anything from one to four times
  the data. The constants come from measurements on the existing maps
  (`tools/lib/estimates.json`), not from a wet finger in the air.

That interface and its map GUI page exist only under `npm run dev`: `add-map.html`
is not a build entry, and the Vite plugin that mounts the API is `apply: 'serve'`.
The API itself is not dev-only, though — `sim/server/api.mjs` serves both
`/__map-api` and the operator layer `/__operator` in production, which is what
makes a `npm run build` bundle playable behind the standalone server (see
[Running the game without Vite](#running-the-game-without-vite--the-standalone-server)).

### From the command line

The whole pipeline fits in one command:

```bash
npm run add-map -- "Name shown in the menu" <lat> <lon>
```

For example, for an area centred on the Sacré-Cœur:

```bash
npm run add-map -- "Sacré-Cœur" 48.8867 2.3431
```

That chains, in order:

1. **Download** — the provider (`google-earth` by default) traverses
   the `rocktree` octree around `lat,lon` and writes its nodes to
   `sim/.cache/google-earth/<lat>-<lon>-<zoom>-<radius>-<altitude>/`.
2. **Post-processing** — `tools/prep.mjs` converts that `.obj` (ECEF, one JPEG
   per material) into engine-ready binaries (ENU in metres, textures grouped
   into sheets) in `public/scenes/<slug>/`. See
   [Technical details](#technical-details-of-the-preprocessing) for what this
   step actually does and why it is necessary.
3. **Registration** — the map is added to `public/scenes.json`, so it
   appears in the menu at the next `npm run dev` (no need to restart the
   server if it is already running, a page reload is enough).

## Music

The musical arc (issue #122): a library of locally generated tracks, one per
session, whose intensity follows the flight. Each drone family has its own
genre — see Bible §34.

The tracks are **committed** into `public/music/` (Opus 96 kbps, ~1.1 MB for
90 s) and described by `public/music.json`. The game launches and plays without
them: manifest missing or file missing, it simply stays silent.

The pipeline, in order. It requires a local installation of
[Stable Audio 3](https://github.com/Stability-AI/stable-audio-3) (~10 GB with
the weights), outside the repository, pointed at by `FPVTP_STABLE_AUDIO`:

```bash
export FPVTP_STABLE_AUDIO=/path/to/stableaudio3.0

npm run add-music -- --pool all --count 10 --seed-base v6   # → .music-staging/ (gitignored)
npm run music-gate                                          # measured automatic rejection
npm run music-loop                                          # loop + normalisation + Opus
npm run music-review                                        # listen: o to accept, k to reject
```

**`--seed-base` is mandatory in practice, and it is the pipeline's trap.**
The seed determines the prompts *and* the identifiers: reusing it does not
produce other tracks, it produces exactly the same ones, which the generator
then skips as already present. You believe you have grown the library and
nothing has happened. `add-music` now refuses a seed already represented in the
manifest and offers the next one — take the one it gives you.

`--pool` accepts `all`, a comma-separated list, or one of the seven
keys: `menu`, `freestyle5`, `race5`, `cinewhoop`, `longrange`, `heavy5`,
`toothpick` (the last six being the families of `src/drone-profiles.js`).
A list is better than several commands: the model takes longer to load than to
generate, and a batch loads it only once.

Count roughly **8 s per track** plus 20 s of loading. Do not touch the number of
diffusion steps: 8 is the model's nominal regime, not a speed
shortcut — raising it degrades the output by several dB and sends it
out of style (see the `DEFAULTS` comment in `tools/music-gen.mjs`).

To retire tracks — from the manifest **and** from disk, the write-once rule
saying that a file is never rewritten, not that it is eternal:

```bash
node tools/music-retire.mjs --before v6          # dry run: keeps only v6
node tools/music-retire.mjs --id <id> --apply    # or one at a time
```

It refuses to empty a pool: a pool with no music would make the game mute for a
whole drone family.

Three things to know:

- **Stable Audio does not produce loops.** `music-loop.mjs` crossfades the
  last 3 seconds over the first 3, which makes both junctions continuous.
  The `l` key in the review plays exactly that seam.
- **Everything is normalised to -14 LUFS**, in two passes. That is what makes it
  possible to calibrate the mix once for the whole library.
- **Write-once.** A committed file is never rewritten: git does not
  delta-compress audio and forgets nothing. A track rejected after the fact is
  removed from the manifest and deleted, never regenerated under the same name.

The prompts and the six axes of variation are in `tools/music-prompts.mjs` —
that is the creative source of truth, not an implementation detail.

## Removing a map

```bash
npm run remove-map -- <slug>
```

The `slug` is the one in `public/scenes.json` (e.g. `sacre-coeur`). This removes
the entry from `scenes.json` (so the map disappears from the menu at the next
`npm run dev`/reload) and deletes `public/scenes/<slug>/`.

The raw downloaded tile under `sim/.cache/google-earth/` is **not**
deleted by default — it is the slow part to download again, so `add-map`
can reuse it as is if the map is added back later. Add
`--raw` to delete it as well:

```bash
npm run remove-map -- <slug> --raw
```

### When an area returns nothing

Google Earth offers 3D photogrammetry widely, but not at every
resolution: at the requested zoom level, the `rocktree` traversal may find
no usable node. `add-map` then stops with an explicit message rather than
writing an empty map — that message is still emitted in French by
`tools/lib/providers/google-earth.mjs`: "Google Earth ne couvre pas cet endroit
à ce niveau ; essaie un zoom plus bas." ("Google Earth does not cover this place
at this level; try a lower zoom.")

`PROBE AREA` in the scanner (see above) downloads a small real sample
at the centre of the area before launching the full acquisition — that is the
way to test quickly whether a place is covered.

### Prerequisites

**None.** The `rocktree` protocol of `kh.google.com` asks for neither key nor
token — verified live on several endpoints.

### Options

```bash
npm run add-map -- "Name" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20]
                                      [--cell 256] [--quality 85]
                                      [--slug identifier] [--force]
                                      [--provider google-earth]
                                      [--bbox s,w,n,e]
                                      [--poly "lat,lon lat,lon ..."]
```

| Option | Default | Effect |
|---|---|---|
| `--provider` | `google-earth` | Provider of the bytes (see [Providers and decoders](#providers-and-decoders)) — only one registered today, but an invalid id fails immediately rather than guessing. |
| `--zoom` | 20 | Zoom level (~13-20), converted to an octree level (`level = zoom + 1`, capped at 22 — see below). |
| `--radius` | 25 | Scan radius in tiles around the centre. See below for sizing. |
| `--altitude` | 20 | No effect with `google-earth` (inherited from a withdrawn provider); accepted for compatibility with scenes already registered. |
| `--cell` | 256 | Size in pixels of each texture cell. Expensive: each doubling **quadruples** the VRAM. `128` = reduced quality but a quarter of the VRAM (useful on a modest machine). |
| `--quality` | 85 | JPEG quality of the generated texture sheets. |
| `--slug` | derived from the name | Folder identifier (`public/scenes/<slug>/`). Auto-generated from the name (accents and spaces removed) if omitted. |
| `--bbox` | — | Extracts an explicit lat/lon rectangle instead of the centred square. `--radius` is then ignored. |
| `--poly` | — | Extracts a free polygon: only the tiles the outline touches are swept. At least 3 vertices, the ring closes by itself, pairs are separated by a space or a comma. Mutually exclusive with `--bbox`. |
| `--force` | off | Downloads again even if the tile already exists locally. Without this option, a second `add-map` on the same coordinates/zoom/radius/altitude skips the download and only re-converts. |

### Sizing `--radius`

At zoom 20, a tile is about **25 m across** on the ground (at the latitude of
Paris). The scan covers a square of `(2×radius + 1)` tiles centred on the given
point, so `radius × 2 × 25 m` ≈ the side of the square covered:

| radius | side covered (approx.) | typical use |
|---|---|---|
| 25 | ~1.25 km | a monument and its surroundings (Eiffel Tower) |
| 35 | ~1.75 km | an elongated area (the two islands of the Seine) |

Too small a `radius` leaves holes at the edges of the flyable area;
too large only costs download time (empty tiles — the Seine,
the sky — answer fast and weigh nothing), so when in doubt, aim wide.

### Reworking an already downloaded map

If the raw tile is already there and only `--cell`/`--quality` needs to change
(to lighten the VRAM, for example), there is no need to download again: call
`prep.mjs` directly on the existing folder:

```bash
node tools/prep.mjs .cache/google-earth/<tile-folder> \
  --out public/scenes/<slug> --cell 128
```

(`npm run add-map` does exactly that internally, with the download on top.)

## The operator terminal

`npm run dev` opens the Operator Terminal (PHASE 02). `LOCAL TERRAIN` lists
everything in `public/scenes.json` with its real size on disk;
`OPEN` launches the flight. `GLOBAL SCANNER` opens the worldwide scanner
(PHASE 03, see "Adding a map"). `SESSION LOG` and `TARGET LOG` are still stubs
until their respective phases.

To skip the terminal (direct link, quick dev):

```
http://localhost:5173/?scene=<slug>
http://localhost:5173/?scene=<slug>&family=freestyle5            # nominal profile, grey
http://localhost:5173/?scene=<slug>&family=freestyle5&build=g1::0 # one drawn specimen
```

The `slug` is the one visible in `public/scenes.json` or in the name of the
`public/scenes/<slug>/` folder. `?family=` alone flies the NOMINAL profile of the
family (the one used by the bench and by `tools/tune-pid.mjs`); `?build=<seed>`
draws the specimen — livery, chassis, portrait — as a TARGET SCAN would.

Headless verification behind a proxy that refuses Chromium's CONNECT:
`VITE_ROCKTREE_BASE=http://127.0.0.1:8124/rt/earth/ npx vite` makes the Google
terrain read from a local relay (see `tools/lib/rocktree/url.mjs`).

### The briefing

A freshly created operator goes through a four-screen briefing
(`INPUT`, `THE TERMINAL`, `A SESSION`, `BRIEFING COMPLETE`), right after the
operator is registered (bootstrap: hardware, `OPERATOR NAME`, then the
briefing — two screens before it since the CONTROL VECTOR was withdrawn). It
states what a thing is and what a key does — never what to do — and Escape
skips it in one go. The `INPUT` screen
reads the mapping LIVE (`src/key-map.js`) and offers `[ CALIBRATE ]` or
`[ MAP KEYS ]`, which open the corresponding tab of `SETTINGS` and come back.

It can be replayed from `SETTINGS` › `SYSTEM` › `[ REPLAY BRIEFING ]`.

Two `localStorage` keys drive it: `fpvtp.briefingSeen` (set as soon as the
briefing has been shown, read or skipped) and `fpvtp.firstFlightDone` (set at
the end of the first flight outside the bench). Between the two, the first
flight displays three brief lines — `THROTTLE UP`, `[TAB] SETTINGS`,
`[HOLD K] CUT LINK` — decided by `tools/briefing-model.mjs` and painted by the
OSD. `[ RESET SETTINGS ]` erases the `fpvtp.*` keys: the briefing replays, which
is exactly what a reset is supposed to mean.

## Running the game without Vite — the standalone server

`npm run dev` remains the way to develop. But a `npm run build` alone would not
start: `/__operator` and `/__map-api` only existed as a Vite plugin, and the
terminal died at boot on the first request (issue #259). `sim/server/`
is that same server, without Vite:

```bash
npm run build
node server/index.mjs --data ~/.local/share/fpvtp --dist dist --open
```

| option | default | env |
|---|---|---|
| `--data <dir>` | the repository paths (`public/scenes`, `operator-state/`, `.cache/`) | `FPVTP_DATA_DIR` |
| `--port <n>` | `8080` (`0` = a free port) | `FPVTP_PORT` |
| `--host <addr>` | `127.0.0.1` | `FPVTP_HOST` |
| `--mode local\|shared` | `local` | `FPVTP_MODE` |
| `--dist <dir>` | `sim/dist` | — |
| `--open` | no | — |

The command-line option wins over the environment variable.

The data directory groups everything that belongs to the installation and not
to the program — which is what will let an update overwrite nothing:

```text
<data>/
  scenes/<slug>/        the acquired terrains
  scenes.json           the catalogue, specific to this installation
  operator-state/       the operators and their sessions
  cache/google-earth/   the rocktree nodes already downloaded
```

`tools/lib/paths.mjs` is the only place that resolves these paths, and **without
`FPVTP_DATA_DIR` it returns exactly today's**: `npm run dev` does not change
behaviour. The variable is read when the module is imported, so it must be set
before anything else — which is what `server/index.mjs` does.

Two things to know:

- **In `local`, the server refuses a `--host` outside `127.0.0.1`/`::1`.** The
  security boundary is the local socket, the same one as with the dev server.
  `--mode shared` lifts that guard, and the authentication that goes with it is
  implemented (`sim/server/auth.mjs`): in `shared`, every `/__operator/:id/*`
  and `/__map-api/*` request must carry an operator key as
  `Authorization: Bearer`. A key is 128 bits in Crockford base32, shown once and
  stored only as a SHA-256 hash; `node server/index.mjs key <operatorId>` issues
  a new one, which is the sole recovery path. Self-service sign-up is capped at
  five per hour per address, an operator's files are capped at 16 MB, and
  acquisition is closed in `shared` whatever `FPVTP_ACQUIRE` says — a scene must
  never be born on a server that receives strangers. Design:
  [`sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md`](../sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md).
- **No SPA fallback.** A missing file returns a real JSON 404, never
  `index.html`: the loader (`src/loader.js`) tells a present scene from an
  absent one by the content type, and a host that falls back to the page for
  everything lies to it (issue #275).

`tools/map-api-plugin.mjs` is now nothing more than an adapter: it mounts the
same `createApi()` on Vite's middlewares. `tools/vite-adapter-selftest.mjs`
checks that it does not drift from the server.

## The dialogue pipeline (crew RTC)

`public/dialogue/*.json` (one shard per event, plus `manifest.json`) is
**versioned content, not a build artefact**: it is committed like the
rest, is not regenerated at launch, and a player who ignores the crew RTC
entirely (`root`, `jensen`, `mikhail`, the `cron` process) misses no game
information — that is PHASE 21's acceptance criterion.

Three commands, all development tools (nothing under `src/` imports them,
checked by `tools/dialogue-selftest.mjs`):

```bash
npm run dialogue:gen -- --event ACQUIRE_AREA --count 200 [--batch 20] \
  [--rarity COMMON] [--backend claude|ollama] [--dry-run]
npm run dialogue:inspect -- --event ACQUIRE_AREA [--count 30] [--rarity RARE]
npm run dialogue:check     # = node tools/dialogue-selftest.mjs
```

`dialogue:gen` drives an LLM in batches (`tools/dialogue/generate.mjs`,
`tools/dialogue/prompts/`) with two backends:

- `--backend claude` (the default): `claude -p --output-format json`, with no
  prior configuration;
- `--backend ollama`: a local model over `http://127.0.0.1:11434` (default
  model `batiai/qwen3.6-27b:q3`, configurable with `--ollama-host` or
  `OLLAMA_HOST`). This is the **route chosen for bulk generation**:
  measured at 4.9 s per entry, roughly 9 h for the whole corpus, at zero cost —
  against an estimate of 100 to 200 USD through a hosted API for the same
  volume.

`dialogue:inspect` returns N draws with dummy contexts for human
review. Review policy: **100% of `RARE` and `VERY_RARE` entries, 100% of
`jensen`'s lines**, and a **10%** sample of the rest. A batch that exceeds 5%
rejection on the first pass (style, slots, duplicates) is **regenerated
whole** rather than corrected line by line — a batch's drift in tone is better
fixed by replaying it than by patching it.

`dialogue:check` runs `validate.mjs` (shape, known `speaker`, slots
vs `requires`, style blacklist — addressing the player, fourth wall,
modern AI vocabulary, promising a sequel) and `dedupe.mjs` (near-duplicates
by trigrams) over any delivered corpus.

## Available maps

The repository ships an **empty** `public/scenes.json`: no terrain travels with
the code — maps are acquired locally, and `public/scenes/` is gitignored.
The catalogue is therefore whatever this installation has acquired, and
`scenes.json` is the authority on it.

Two zones recur as references throughout this manual and in the selftests,
because they are the ones the figures were measured on:

| Name | Slug | Coordinates | Prepared size |
|---|---|---|---|
| Eiffel Tower | `tour-eiffel` | 48.8582, 2.2970 | ~290 MB |
| Île de la Cité and Île Saint-Louis | `ile-de-la-cite-et-ile-saint-louis` | 48.8534, 2.3510 | ~600 MB |

## Exporting a scene to `.glb` (to share it)

The binaries in `public/scenes/<slug>/` are only useful to the engine here. To
give a scene to somebody else — or to use it in Blender, Godot,
Unity (through glTFast), Unreal, three.js — there is an exporter to a single,
self-contained `.glb` (geometry + embedded textures, no companion file):

```bash
npm run export-glb -- public/scenes/tour-eiffel
npm run export-glb -- public/scenes/tour-eiffel --max-tex 2048   # reduced textures
npm run export-glb -- public/scenes/tour-eiffel --unlit          # KHR_materials_unlit
```

The `.glb` lands in the scene's folder (so, gitignored) unless `--out`.

| Scene | `.glb` | Triangles | Primitives |
|---|---|---|---|
| Eiffel Tower | 203 MB (148 MB with `--max-tex 2048`) | 3.74 M | 19 |
| Île de la Cité | 408 MB | 7.58 M | 38 |

`--max-tex` only saves ~55 MB because geometry dominates (~120 MB on the
Eiffel Tower): going markedly lower would require Draco/meshopt compression
or decimation, which the exporter does not do.

What it translates, and the only non-trivial point: `prep.mjs` stacks 1024
patch textures per chunk into `DataArrayTexture` sheets and stores
`(uv, layer)` per vertex. glTF has no texture array — each sheet therefore
becomes an ordinary 2D texture and the layer index is folded into the UV
(cell `(col,row)` of a `cellsPerRow` grid). This is lossless only
because every source UV fits within `[0,1]` — no patch overflows
its cell (verified: 0 out-of-bounds coordinates out of 1.4 M).

The coordinates pass through unchanged: `prep.mjs` already outputs
ENU metres in X=east, Y=up, Z=south, which is exactly glTF's frame
(right-handed, Y up). No axis conversion, therefore no scale and no
rotation to fix on import — 1 unit = 1 metre.

## Versioning and publishing

The number lives in `sim/package.json` (SemVer), the changes in
[`CHANGELOG.md`](../CHANGELOG.md) at the root, and each published version carries
a `vX.Y.Z` git tag and a GitHub Release.

As work goes on, entries are added under the `## [Non publié]` section of the
CHANGELOG — headings `Ajouté`, `Modifié`, `Corrigé`, `Retiré`, `Déprécié`,
`Sécurité`. (The CHANGELOG is written in French: it is release notes, not code.)

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, in a single job:

- **sim** — `npm run selftest:ci` then `npm run build`, on Ubuntu and on
  Windows. Windows is in the matrix because this repository never ran there
  before the desktop app existed: paths, separators and locales are flushed out
  on a runner rather than by a player.

```bash
npm run selftest:ci   # ~1,430 checks, ~2 min — to be run before pushing
```

`selftest:ci` is the chain that needs **no installed scene, no network and no
browser**: that is what makes it playable on a runner, where `public/scenes/`
(gitignored, ~900 MB) does not exist. A selftest that needs scene data
bows out by saying `SKIP` instead of failing — `tools/entry-state-selftest.mjs`
is the model to follow.

Local by nature, and staying so: `npm run selftest` (which replays the
`tour-eiffel` scene) and `npm run selftest:scenes` (which compares `scenes.json`
against the scenes installed on *this* machine).

`selftest:ci` ends with `npm run fuzz`, the fuzzing pass — fixed seed, hence
deterministic like the rest of the chain:

```bash
npm run fuzz                    # tools/fuzz.mjs then tools/fuzz-api.mjs
node tools/fuzz.mjs --list      # the targets and their threat model
node tools/fuzz.mjs --only flight --cases 20000 --seed 7
node tools/fuzz-api.mjs --cases 2000     # real server, malformed requests
```

It aims at what the selftests do not: the input nobody wrote
— a `localStorage` key edited by hand, a half-written operator file,
a gamepad axis jammed at its stop, a physical state gone to NaN, an HTTP body
that is not JSON. Each target declares an invariant the code really promises
and the threat model of its input; a finding is replayed with
`--seed <n> --cases <n>`. The detail, and what the first pass found:
[`sim/docs/handoff-archive/fuzzing.md`](../sim/docs/handoff-archive/fuzzing.md).

There is **no continuous deployment**. Pushing a tag builds and publishes the
artefacts; installing them on a machine is a deliberate, manual act —
`deploy/deploy.sh <tag>` run as root on the VPS, described in
[`deploy/README.md`](../deploy/README.md). See also `HANDOFF.md`, section
"Versionnage du dépôt".

### Cutting a version

```bash
npm run release -- patch             # 0.1.0 → 0.1.1  (fixes)
npm run release -- minor             # 0.1.0 → 0.2.0  (compatible additions)
npm run release -- major             # 0.9.0 → 1.0.0
npm run release -- 1.2.0             # an explicit number
npm run release -- minor --dry-run   # says what it would do, writes nothing
```

The script bumps `package.json` and the lockfile, dates the "Non publié"
section and reopens an empty one, regenerates the comparison links, commits
`chore(release): vX.Y.Z` and lays down an annotated tag. It refuses a dirty
working tree, an empty "Non publié" section, a number that does not go up, a tag
already laid down.

It pushes nothing — pushing the tag is what publishes:

```bash
git push -u origin <branch>
git push origin v0.1.0
```

`.github/workflows/release.yml` takes over: it checks that the tag and
`sim/package.json` state the same number, replays `npm run selftest:ci`, builds
the sim, then creates the GitHub Release with the body taken from the CHANGELOG
(`node tools/release-notes.mjs v0.1.0`). Attached to it: the self-hosting
archive (`fpvtp-server-<tag>-linux-x64.tar.gz` — server, built game, a Node
runtime and `deploy/`, with no `npm install` to run) and, from a second job, the
desktop installers built by electron-builder on their own runners.

The version is injected into the build by Vite (`__APP_VERSION__`), exposed on
`window.FPVTP_VERSION` and written once to the console: a bug report can name a
version instead of a SHA.

The build numbers on the `BUILD NOTES` screen (`tools/buildnotes-model.mjs`,
`0.1.0` → `0.9.0`) are diegetic lore: no relation to these versions.

## Architecture

```
tools/add-map.mjs     download + preprocessing + registration, in one command
tools/prep.mjs         OBJ+MTL+JPEG -> binaries (offline, per map)
tools/selftest.mjs     geodesy / flight / collision checks, without a browser
tools/fuzz.mjs         fuzzing of the pure modules (flight, stored state, screens)
tools/fuzz-api.mjs     fuzzing of the HTTP routes against a real server
tools/lib/fuzz.mjs     the harness: generators, invariants, shrinking, seeds
src/loader.js          fetch + workers -> BufferGeometry & DataArrayTexture, active scene selection
src/worker.js           parses the binary, cuts the sheet into layers
src/TileMaterial.js     GLSL3 sampler2DArray shader + fog
src/physics.js          Rapier world, static trimesh, drone body
src/flightController.js acro rates -> torque
src/input.js            Gamepad + keyboard/mouse
src/fog.js              visibility model: density, breathing, veil, colour of the air
src/lens.js             fullscreen pass: FPV optics (barrel, vignetting, blur, veil)
src/hud.js              flight OSD + loading screen
src/settings.js         settings panel (Tab): gamepad, camera, lens, link, sound
src/terminal.js         Operator Terminal (Home): LOCAL TERRAIN, FORECAST, stubs
src/scanner.js          GLOBAL SCANNER: Leaflet + Geoman, search, area, probe, acquisition
src/weather.js          the world weather, client side: reads the snapshot, writes wind/rain/fog
tools/terminal-model.mjs pure terminal logic (formatBytes, footer) — tested by selftest:operator
tools/scanner-model.mjs pure scanner logic (area analysis, signal density, coverage)
tools/lib/tiles.mjs     slippy tile geometry, shared browser/Node
tools/lib/weather.mjs   pure weather model (zones, days, regimes, guardrails) — browser AND Node
tools/weather-source.mjs Open-Meteo acquisition + per zone/day cache in the world state (server)
```

**Physics: Rapier** (Rust/WASM). Rigid body, trimesh collision at **full
resolution** on the loaded map, and CCD enabled — at 60 m/s the drone would
otherwise pass straight through a thin structure (the Eiffel Tower's lattice,
for instance).

**Betaflight-shaped controller**, with a deliberately narrow interface
(`update(sticks, state, dt) -> {motors[4], throttle, axes}`) so that it stays
replaceable by a bridge to Betaflight SITL, which likewise returns four motor
outputs rather than a thrust and a torque. Actual rates, full PID,
TPA, feedforward, i-term relax, RC smoothing and airmode mixer: the detail is
in "The flight model" below, which is the authority.

## Known limitation: `selftest` is still Eiffel-Tower specific

`npm run selftest` accepts a scene path as an argument
(`node tools/selftest.mjs public/scenes/<slug>`, default `tour-eiffel`), and
most of the checks (flight, ground, collision/CCD, UV convention) are generic
and pass on any map. **Five** checks, however, are hard-coded
for the Eiffel Tower and fail elsewhere by construction (recorded
2026-08-27 on a 328 x 276 m map):

- "tile is roughly 1.2km square"
- "Eiffel Tower is ~300m tall"
- "ray finds the tower structure"
- "ground coverage across the tile" (probe grid sized for 1.2 km)
- "high-speed impact registers as a crash" (the impact point aims at the tower)

To be generalised (bounds derived from the area actually extracted, with no
dependency on a particular monument) if `selftest` is to become a real
multi-map gate. Until then, on a map other than the Eiffel Tower, only those
five failures are expected: any other failure is a real problem.

## Technical details of the preprocessing

The source tile of a typical map is several hundred MB of ASCII OBJ
in ECEF coordinates, with **one 512×512 JPEG per material** (thousands of them)
— hence as many draw calls and several GB of VRAM as they stand.
`tools/prep.mjs` converts that once and for all, per map:

| | source | after `prep` (Eiffel Tower, `--cell 256`) |
|---|---|---|
| Geometry | ASCII, ECEF | binary, ENU **in metres** |
| Textures | 1 JPEG 512² per material | 4096² sheets, 256² cells |
| Draw calls | 1 per material (thousands) | **5** |
| Resolution | 12.6 texels/m (8 cm) at the source ceiling | 6.3 texels/m (16 cm) at `--cell 256` |

Each pack of 1024 textures becomes a `sampler2DArray`: a single draw call
per pack, and each layer keeps its own mipmap chain (which a classic
atlas could not allow without bleeding between neighbouring tiles). The sheets
are capped at 4096², so a pack occupies several of them — that is what
keeps a worker's peak memory constant as `--cell` grows.

Resolution is this pipeline's real trade-off: the source tops out around
12.6 texels/m (measured: 853 m² of surface per material for ~50% of a
512² texture), and each doubling of `--cell` quadruples the VRAM. `--cell 128`
comes back down to 3.2 texels/m for about a quarter of the VRAM.

The coordinates go from ECEF to a local ENU frame in metres (X = east,
Y = up, Z = south, so −Z = north = "ahead"), which makes the physics
directly credible. The upstream repository's `center_scale_obj.js` script
normalises to 10 arbitrary units and is not suitable for this.

### Providers and decoders

The pipeline has two distinct seams, and confusing them is the mistake to avoid:
"where do the bytes come from" and "how are they decoded" are two separate
questions.

**`tools/lib/providers/`** — where the bytes come from. Each provider exposes
`plan` (estimate without downloading), `probe` (is there really data here),
`fetch` (download and return a folder of tiles), plus `tileDirPath` and its
attribution. `lib/add-map-core.mjs` now does nothing but orchestrate; `/plan`,
`/probe`, `fetch` and `DELETE /scenes/:slug?raw=1` all dispatch by
provider, and both `add-map.mjs` and the GUI (`add-map.html`) know how to
set `opts.provider`.

A single provider is registered today, `google-earth`: Apple Flyover, the
original fallback, was withdrawn on 2026-09-07 (token and Go tool removed from
the repository):

| id | label | default | key/token | raw cache |
|---|---|---|---|---|
| `google-earth` | Google Earth | **yes** (`DEFAULT_PROVIDER_ID`) | none | `sim/.cache/google-earth/<zone>/` |

`google-earth` speaks the internal **rocktree** protocol of `kh.google.com` —
the one Google Earth web itself uses, not the Photorealistic 3D Tiles
API (key, glTF) originally considered for this provider: a HAR of the real
traffic showed that `kh.google.com` asks for neither key nor session parameter.
A native Node client in `google-earth.mjs` + `decoders/rocktree.mjs`, written
from the protocol documentation of `earth-reverse-engineering`
(unmaintained, unlicensed — code rewritten, not copied). Detail in
`docs/superpowers/specs/2026-08-29-second-3d-provider-design.md`
("Amendement 2026-08-31") and the HANDOFF entry "Second fournisseur 3D".

`--provider` (see [Adding a map](#adding-a-map)) chooses
explicitly on the CLI. The per-provider contract (`plan`/`probe`/`fetch`/
`tileDirPath`/attribution, `tools/lib/providers/index.mjs`) stays dispatched by
`opts.provider` for a future provider, even though `google-earth` is the only
one registered today.

**`tools/lib/decoders/`** — how to read them. Each decoder exposes `sniff`
(can you read this folder?) and `decode` (return materials, ECEF positions, UVs
and triangles). `prep.mjs` chooses by sniffing: **no flag selects the
decoder**, so that a provider serving OBJ reuses the OBJ decoder
without declaring anything. Everything after the decode — ENU rebase, chunks,
texture arrays, collision mesh — ignores the input format. The `rocktree`
decoder (delta-packed vertices, direct ECEF via `matrix_globe_from_mesh`)
follows that same contract; one correction is specific to it: the rocktree globe
is a **sphere** of mean Earth radius (6,371,010 m), not the WGS84 ellipsoid that
`prep.mjs` expects, so `sphereToWgs84Ecef()` converts every vertex back before
pushing it into the shared contract (without it, a scene's origin lands
~21 km from the requested point). The `1 - v` flip of the UV axis (see the box
below) stays correct for `rocktree` too — verified in the browser, no
extra flip needed.

> **Careful.** The V-axis flip lives **in the OBJ decoder**, not in the
> shared contract: OBJ puts the UV origin at the bottom left, glTF at the top
> left. A decoder that inherits that flip without deserving it produces the
> famous "grey textures" — 21% of the visible surface samples the grey
> padding outside the patch. Each decoder decides for itself.

### Rocktree fixtures and regenerating them

`tools/testdata/rocktree/` freezes a small sample of the protocol
(`.pb` bulks/nodes + `index.json`) from a real HAR of earth.google.com
(2026-08-31, root epoch 1014, captured over Paris): `tools/rocktree-selftest.mjs`
runs on it offline, without network. The source HAR (114 MB) is **not**
committed (gitignored, `docs/*.har`); only the frozen bytes are. Two
peculiarities to know before regenerating:

- the nodes are re-captured as `!2e1` (JPEG) even if the original HAR
  had them as `!2e6` (CRN/DXT1) — the provider always asks for JPEG, and that
  is what the fixtures must reflect;
- a few intermediate bulks missing from the HAR (browser cache at the time of
  the capture) were re-fetched live, at the epoch of the chain (1014).

To regenerate with a new HAR:

```bash
node tools/gen-rocktree-fixture.mjs "<path to the .har>"
```

`node tools/rocktree-calibrate.mjs [--live]` recomputes the
`zoom ↔ octree level` table (`meters_per_texel` against the Flyover reference);
`--live` queries the real service instead of the fixtures — useful if the
current single-latitude calibration (measured over Paris) has to be checked
elsewhere on the globe.

### Three settings that matter

- **V-flipped UVs in `prep.mjs`** — OBJ places the UV origin at the bottom
  left, `DataArrayTexture` forces `flipY = false` and therefore puts row 0 of the
  data at the top. Without the conversion, a good part of the visible surface
  samples the grey padding outside the useful zone of each thumbnail
  (originally observed on Apple Flyover tiles, withdrawn since, but the
  OBJ decoder keeps the correction for any provider that would serve some). The
  selftest locks down both symptoms (flipped patterns and grey patches).
- **`camera.near = 0.15`** — photogrammetry stacks nearly coplanar
  surfaces. At `near = 0.05` the depth buffer quantises to ~40 cm at the far end
  of the tile and the city shatters into z-fighting. 0.15 fixes that and is
  exactly the collider radius, so nothing can be closer to the camera
  without having already collided.
- **`resetForces()` on every step** — Rapier keeps user forces
  until they are explicitly cleared. Without this, thrust accumulates and the
  drone leaves in quadratic acceleration.

### About the grey: it was not the data

An earlier version of this README claimed that Flyover left vertical
façades grey and that one had to choose between that aesthetic and another
dataset. **That was wrong.** The grey padding (luminance exactly 128)
occupies the *unused* margin of each thumbnail; it was the un-flipped V that
projected samples onto it. Measured over 125,600 m² of real surface (Eiffel
Tower tile):

| convention | visible grey | vertical faces | horizontal faces |
|---|---|---|---|
| V not flipped | 20.9% | — | — |
| V flipped | **0.9%** | 0.9% | 1.0% |

The façades are no less well textured than the roofs.

## The flight model

The drone is not a sphere with a thrust: it is a multirotor modelled
motor by motor. `src/quad.js` holds the airframe and the air (motor lag,
thrust ∝ ω², prop drag torque, rotor drag, ground effect,
propwash, a battery that sags under load and drains);
`src/flightController.js` holds the Betaflight part (actual rates, PID with
i-term relax, TPA, feedforward, RC smoothing, airmode mixer) and outputs only
four motor commands.

### The gyro, and why the loop rate is a real question

`src/gyro.js` sits between Rapier and the PID. Without it the rate loop reads
the exact angular velocity of the rigid body, which no machine has and which
makes the whole Betaflight filter chain a handicap rather than a tool. With it
the loop reads broadband noise (quoted as a density, so the amount does not
change when the loop rate does) plus one tone per motor at its shaft frequency
and its second harmonic. The RPM filter and the dynamic notch answer those
tones; a loop delay line and Betaflight's anti-gravity and D-max sit beside
them.

All of it ships **inert**: `gyroNoise` and `loopDelay` are 0 on every family,
`ANTI_GRAVITY_GAIN` is 0, `D_MAX_RATIO` is 1, `CONTROL_SUBSTEPS` is 1. The
motor commands are bit-identical to the loop that predates the file, which
`tools/loop-realism-selftest.mjs` asserts and which
`tools/flight-replay.mjs --diff` confirms trace by trace. The reason is the
tune: the `pid` blocks in `src/drone-profiles.js` were swept by
`tools/tune-pid.mjs` against a silent gyro and a loop with no latency, and
every one of these settings moves that plant. They go on together, with a
re-sweep.

The loop rate is the question underneath. Rotor fundamentals run from 155 Hz
(longrange at a hover) to 816 Hz (toothpick at full stick), and the control
loop runs on the physics grid at 250 Hz, whose Nyquist is 125 Hz. Measured by
`node tools/loop-rate-bench.mjs`:

| control rate | notches buildable (of 9 per axis) | motor ripple removed | CPU vs 250 Hz |
|---|---|---|---|
| 250 Hz  | 0 | 0.0 %  | — |
| 500 Hz  | 0 | 0.1 %  | +0.02 % of a core |
| 1000 Hz | 4 | 11.3 % | +0.07 % of a core |
| 2000 Hz | 8 | 15.5 % | +0.16 % of a core |

At 250 and 500 Hz the notch is not weak, it is absent: every centre frequency
asked for is above 0.45 × Nyquist and `Notch.setFrequency()` refuses rather
than degenerate. A 500 Hz tone read back through the SDFT comes out as 109 Hz
at a 250 Hz loop — a tone that is not there and that the PID chases. So the
day `gyroNoise` stops being 0, the loop rate goes to 1000 Hz with it (2000 Hz
for cinewhoop and toothpick, whose fundamentals sit at 311–816 Hz). The
physics grid does not move: the controller substeps inside it on a zero-order
hold of the body state, which is what the hardware does too — the airframe does
not rotate at the frequencies the gyro reports.

Dev hook: `?loop=<hz>`, one of 250/500/1000/2000/4000, refused otherwise.

### The rotor model: `?aero=`

Two rotor models ship. `classic`, the default, is `kThrust * omega^2` with a
first-order inflow correction — it is what every PID gain in
`src/drone-profiles.js` was tuned against, and it is bit-identical to what the
simulator has always flown. `bem` puts `src/blade-element.js` in the force
path instead: thrust, torque and the in-plane force all come out of the blade,
integrated element by element and over azimuth.

`bem` is **NOT TUNED and not a candidate for the default**. The rule falls back
silently rather than refusing, unlike `?swarm=`, because an unknown value here
cannot produce a machine the game could not otherwise fly — it just gets the
default one. The rule itself lives in `src/quad.js` (`parseAeroFlag`), beside
the model it selects, and it is passed explicitly to `Physics` and `Propulsion`:
there is no mutable global.

`tools/aero-model-compare.mjs` is what makes the difference observable. For
each of the six families it sweeps hover to cruise and prints thrust, torque
and in-plane force for BOTH models with the signed gap; it runs the `#103`
off-axis gate against both; and it puts the six replay sequences side by side.
What it shows today, and why the default does not move:

- In still air the blade returns a clean square law, while `classic` carries
  `propLossFactor`, which lifts part-throttle thrust. The two are pinned
  together at `maxOmega` by the calibration and diverge below it: **-14 % to
  -30 % of rotor thrust at hover rpm**, across the families. `hoverThrottle()`
  is derived from the classic curve, so under `?aero=bem` the hover stick is
  simply wrong and the machine descends.
- The in-plane force the blade predicts is **13 % to 30 % of what `kLateral`
  applies** — `kLateral` was fitted to observed behaviour and carries the
  flapback lumped inside it, the blade resolves only the dissymmetry of lift.
- The blade does **not** bring back the defect `#103` removed: off-axis rates
  under a held roll or yaw at twice cruise are equal to or lower than the
  default's, everywhere. The mechanism is the same one, but `bem` returns a
  FORCE and no moment, applied at the hub where `kLateral` already acted.

What would have to exist before the default could move: an edgewise data
source, or a measured hover-to-cruise thrust curve from the reference build —
the axial model is validated on 187 wind-tunnel propellers, everything edgewise
is unverified — and then a full re-tune, since all six tunes belong to
`classic`.

### Translational flight (#91)

Three mechanisms separate the moving aircraft from the hovering one.

**Translational lift.** Moving forward, the rotor escapes the flow it has just
stirred itself: inflow drops, efficiency rises. This is not one more
coefficient — `kInflow` IS already the inflow slope of actuator disc theory,
linearised on the axis, and the computation generalises it to forward
flight in closed form (Glauert), hence without iterating at 250 Hz. The factor
2 in the code is what makes it a generalisation and not an addition: in pure
axial flight, the exact solution places the flow at vh + Vc/2, so that the
historical term is exactly twice the excess over hover. Still air and vertical
climb stay identical to the bit. **Descent is deliberately left
untouched**: between −2·vh and 0, momentum theory has no solution at all — that
is the vortex ring state — and that regime is already modelled empirically,
under the name `propwash`.

**Flapback, withdrawn (#103).** The disc tilts backwards and tilts the
thrust with it; the corresponding FORCE is already present, folded into
rotor drag (`kLateral`, fitted to observed behaviour). #91 had added
the MOMENT, from two places: the hub moment of a rigid propeller, and the arm
that in-plane forces had never had, the propellers being 2 cm above the
centre of mass.

Both were withdrawn after a flight test: the aircraft became unflyable.
Everything they add grows with airspeed and acts in both pitch and
roll, so that full-stick yaw held at twice cruise speed
rolled the aircraft up to 79% of the commanded yaw rate. The gate that was
missing measures exactly that: section 4 of
`tools/aero-selftest.mjs`, now held **in flight** and no longer only in still
air — where all of #91 is identically zero, which explains why it had
stayed green.

One question of modelling remains to be settled before any return: a rigid
propeller does not tilt its disc, and a flapping propeller does not return a hub
moment. Taking the flapping picture for the force and the rigid picture for the
moment probably amounts to counting the same asymmetry twice. That is the
subject of the issue, now reopened.

**Rotor precession.** The four propellers carry angular momentum, and
pivoting it costs a torque. Not to be confused with the propeller inertia term
already present in yaw: that one is the reaction to the rotor's
acceleration, this one is precession. One needs the rpm to CHANGE, the other
only needs it not to be zero. On a symmetric X, the sum of directions × rpm is
exactly zero for a pure roll as for a pure pitch, whatever the rpm curve — so
what this adds is precisely what a pilot reports: **yaw during a roll, and the
nose moves**.

No new per-family setting: everything derives from the geometry and the
coefficients already there.

`node tools/aero-selftest.mjs` proves all three in under a second, without
Rapier, without a scene and without a browser. It also carries a headless
version of the anti-divergence gate under sustained roll, which used to demand
Rapier and a scene.

### The six families (PHASE 07)

`src/drone-profiles.js` describes six families of aircraft — mass, inertia, arm,
propeller, thrust, rpm curve, motor lag, aero coefficients, pack — each
documented by a "real setup" comment:

`5" FREESTYLE` (reference) · `5" RACE` · `CINEWHOOP` · `LONG RANGE` ·
`HEAVY 5"` · `MICRO` (2.5" toothpick).

The **PID is measured per family**, never written by hand:
`node tools/tune-pid.mjs --write <family|all>` sweeps P/D against the family's
inertia and motor lag, measures `torquePerMix`, and rewrites its `pid` block.
`npm run tune` reports on all six. `npm run selftest` runs the flight
envelope / propulsion loop on every family.

The bench holds the quad in still air, which is the right test rig for a rate
loop and what makes its numbers comparable to those of day one.
It is also why it sees nothing of translational flight, and why the shipped
PIDs did not have to move when that arrived. `--cruise` makes it fly
forward, at the equilibrium speed of each family, and judges a candidate
on the WORSE of the two regimes — never on cruise alone, which would only
move the blind spot to the other end of the envelope. Off by default: turning
it on changes what "measured" means.

An airframe far faster than a 5" (the toothpick) carries a `filterScale` that
opens the roll/pitch filters, like a real micro build. `QUAD` remains the
default profile (5" freestyle, original values unchanged).

Rate presets, key `P`: **cinematic** (380 °/s), **freestyle** (820 °/s),
**race** (1100 °/s), **long range** (360 °/s), **micro** (420 °/s). Each
family starts on its own.

The HUD shows pack voltage, state of charge and current: the colour
follows the voltage *per cell under load*, not the state of charge, because
that is the number you fly by. Below 3.6 V/cell it turns
orange, below 3.4 V red.

### Target scan and hack families (PHASE 08–09)

A fresh session goes through the **TARGET SCAN** (PHASE 08) before the flight:
`tools/target-model.mjs` draws, deterministically from the session seed,
a list of signals (family, RSSI, video mode), the player picks one, and the
resolved target is persisted on the session.

Each candidate also carries a **`hackType`**, drawn at generation time in
`tools/target-model.mjs` (a dedicated, seeded draw, **independent** of the
family, of the signal and of the flight difficulty). Six families, credible
concepts but purely abstract interaction (`HACK_TYPES`):

`COMMAND INJECTION` · `LINK HIJACK` · `TELEMETRY SPOOF` · `GNSS SPOOF` ·
`NETWORK TAKEOVER` · `FIRMWARE OVERRIDE`.

`sanitizeTarget` (`tools/session-model.mjs`) validates and persists `hackType` on
the target. Right after the TARGET SCAN, `src/hack.js` plays the **AUTOMATED
ANALYSIS** screen: a fixed four-line automatic log and an animated ASCII pattern
specific to the hack family (`src/hack-grammars.js`, purely decorative).
The screen stops on `MANUAL OVERRIDE REQUIRED` and a `[ JACK IN ]` button,
with `[ESC] ABORT` mounted as soon as the screen appears — usable throughout
the background loading, not only once the screen is armed.
Activating `[ JACK IN ]` opens the **culmination** (`src/culmination.js`): one to
four fullscreen seconds of demo-scene primitives weighted by the hack
family (`FAMILY_PRIMITIVES`), in the four colours reserved for
events, with the family's sound signature
(`uiAudio.playCulmination()`) while the music withdraws. The V1–V4 variant
is drawn from the target's seed, and is therefore replayable. Nothing there is
to be pressed: it starts by itself and hands back by itself, Escape skips the
beat. Then comes the `CONTROL ACQUIRED` screen and its fingerprint, then the
flight.

Aborting (Escape or `[ESC] ABORT`), as long as the gesture has not gone
through, resolves `runHack()` to `{ aborted: true }` rather than rejecting, and
reloads the zone page the way cancelling a TARGET SCAN would. There is, on the
other hand, no longer a vector to memorise or retype: the CONTROL VECTOR, which
occupied that screen until issue #33, was withdrawn entirely — its removal had
carried the culmination away with it, restored by issue #101 (see the revision
note of Bible §15/§19 and the PHASE 10 block of the roadmap).

Dev hook: `?hack=<type>` (e.g. `?hack=gnss-spoof`) previews a pattern on
the paths that bypass the TARGET SCAN (`?scene=`, `?family=`).

### The world weather

Since PHASE 04 (issue #41), the weather is **not a setting**. There is
no longer a wind / rain / fog slider in the `Tab` panel: the weather
belongs to the world and to the session, and each zone has its own evolution
over seven rolling days.

```
tools/lib/weather.mjs    the pure model — zones, days, regimes, guardrails,
                         translation to wind.js / rain.js / fog.js / sun.js
tools/weather-source.mjs Open-Meteo + per (zone, day) cache in the world state
src/weather.js           the client: asks for the snapshot, writes the parameters
```

The sun (issue #23, `src/sun.js`) follows the same logic: no panel, no
slider. Its position comes from the scene's lat/lon and from the **real UTC
time** at the moment the page is running — there is **no time setting**
anywhere in the UI, and that is deliberate: forcing a sunrise or a sunset
would break the promise "what you see is what is there
now" that already carries the weather.

**One zone, one day, one bulletin.** The zone key is the lat/lon rounded to
0.01° (~1.1 km): two bounding boxes drawn over the same neighbourhood share
their weather, two cities never. The day's bulletin is written into the
operator's `worldState.weather[zone]`, on disk. **Relaunching an
acquisition therefore replays no draw**: the server re-reads the file, without
even touching the network.

**The source is a real API.** Open-Meteo, free, keyless — the URL contains
only the latitude and the longitude, there is no secret to commit. We
ask it for `weather_code`, `precipitation_sum`, `precipitation_hours`, the
max winds and the gusts as daily, plus `visibility` and `cloud_cover` as hourly,
which we average per day. The daily total divided by the number of hours of
rain gives the **rate** in mm/h, which is what `rain.js` expects — a total of
24 mm over the day is not 24 mm/h.

**Three fallbacks, in this order**, all tested by `tools/weather-selftest.mjs`:

1. the day's snapshot already in the world state — re-read, never re-drawn;
2. Open-Meteo;
3. the last known snapshot, re-dated, announced `stale` and with lowered
   confidence;
4. a deterministic procedural generation on `(zone, day)`.

The procedural side is not randomly smoothed noise. Three uniforms adjacent in
time give a near-normal; we pass back through its cumulative distribution
function to recover a **real** uniform, without which 7% of days stick
to the bound and Tokyo gets a storm a week. The distributions are then
calibrated on their real frequencies:

| quantity | distribution | result measured over 14,400 zone-days |
| --- | --- | --- |
| daily max wind | Weibull of shape 2 (Rayleigh), scale 3.5 to 9 depending on the zone | median 5.7 m/s, p90 10.9, p99 15.0 |
| rain | threshold + exponential total, spread over a separately drawn number of hours | ~30% of rainy days |
| fog | rare threshold, 2 to 18% of days depending on the zone | FOG 2.5%, MIST 2.9% |
| gales | a consequence of the first two | GALE + STORM 0.7% |

Temporal continuity comes from indexing on the **absolute day**: each
day depends on its two neighbours, so today's "+1" is exactly
tomorrow's "TODAY", and the forecast never contradicts itself the next day.

**The guardrails** (`sanitize()`) run before any classification, on the
data from the API as on the generator's, because both produce
combinations the atmosphere does not: a gust weaker than the
mean wind, or three times stronger; pea soup under a storm (beyond
8 m/s the mechanical stirring lifts fog into stratus); rain
under a blue sky; a visibility of 30 km under 25 mm/h, when
`rain.js` leaves only 1.7. The announced visibility can never contradict
the engine that is going to render it.

**The forecast** is displayed from `LOCAL TERRAIN` → `FORECAST`:

```
FORECAST // TOUR EIFFEL

2026-08-29 · OPEN-METEO

TODAY  LIGHT RAIN / MODERATE WIND
+1     CLOUD / MODERATE WIND
...
+6     CLOUD / LOW WIND

WIND   7.1 m/s  G 15.1  SSW
VIS    26 km
RAIN   0.6 mm/h
FOG    NONE

CONFIDENCE ███████████░
```

The order of the conditions is not fixed and differs from one zone to another.
Confidence decreases with the horizon and starts lower when the source is a
fallback: an invented forecast does not announce itself as sure as a
reading, and the bar is never full.

**For debugging**, `window.__sim.setWeather / setRain / setFog` remain
open and are now the only way to force the weather;
`window.__sim.weather()` returns the current snapshot. `tools/selftest.mjs`
assumes a neutral world and has not changed.

### Wind

`src/wind.js` — a wind field, not a vector. Four inputs, written by
the world and not by a slider (see "The world weather"):

| input | unit | what it is |
| --- | --- | --- |
| `speed` | m/s | speed **at 10 m**, the height at which a weather station measures — not the speed at the drone |
| `direction` | ° | the sector the wind **comes from**, meteorological convention |
| `gust` | 0..1 | one number for three properties — intensity, duration, frequency — see below |
| `turbulence` | 0..2 | a multiplier on the intensity the profile already implies, not the intensity itself |

These four values can still be set by hand from the console
(`window.__sim.setWeather({...})`), which is the debug access and the
measurement bench — not a hidden panel. `tools/selftest.mjs` uses it to hold its
three still-air checks (altitude hold in hover, terminal speed in level flight,
stillness on the ground), which only make sense at zero wind.

**Four layers**, each in its own frequency band, because they have
different causes: the **mean** (the pressure gradient), the slow **drift**
over tens of seconds, the discrete **gusts** of a few seconds, and the
**turbulence** at a tenth of a second. The previous version folded the last
three into a single low-pass, which can only express "how much" and never "at
what frequency" nor "for how long".

**The boundary-layer profile** is the logarithmic law, with a roughness
length of 1 m (Davenport class "city centre"). Direct consequence in
flight: at 2 m from the ground only 30% of the announced wind is left, at 100 m
there is twice as much. Climbing changes things. The log law is preferred to
the power law because it gives **for free** the turbulence intensity —
σu/U = 1/ln(z/z0), i.e. 0.43 at 10 m and 0.22 at 100 m — instead of making you
choose it.

**Turbulence** is a Dryden model: three axes generated in a frame
tied to the wind then rotated into the world, with the ratios measured in the
surface layer σu:σv:σw = 1:0.78:0.52. The time constant is L/V where V is the
advection speed — Taylor's frozen turbulence hypothesis, without which
the field would freeze as soon as you stop in a hover. It also gives, without
being asked, "the air is dirtier when you go fast": the same
eddies arrive sooner.

**Gusts** are Poisson arrivals with the 1−cosine envelope of
MIL-F-8785C. Intensity, duration and frequency are three genuinely
independent parameters; the single slider traces a line through all three,
because that is how weather deteriorates — more agitated air means
gusts that are stronger, sharper **and** more frequent. The full triplet stays
accessible through `window.__sim.setWeather({gustPeak, gustDuration, gustRate})`.

**Interaction with the terrain** is a rosette of ten rays cast at 20.8 Hz
from `physics.js` — the same order of magnitude the video link already spends
against the same mesh. Ray 0 always points into the wind, so that "is
something sheltering me" is always the same question on the same ray.
Out of it come four quantities: the **shelter** behind an obstacle (down to
−70%, never 100% — a building's wake is not still air), the
**channelling** in a street aligned with the wind (+45%), the **updraught**
along a windward façade (dynamic soaring included), and the **roughness** that
raises the turbulence intensity near the geometry. Nothing is a flag:
each ray gives a `1 − d/R` ramp and the whole is smoothed over 0.8 s, for the
same reason as in `link.js` — photogrammetry is a soup of surfaces,
the rays scintillate, and a flag would turn that scintillation into a
switch.

The wind acts **through the propellers**, not as a single force on the
airframe: each rotor sees its own airspeed, `v + ω × r`. Rolling to the right
raises the left-hand motors, which therefore see more air and lose
thrust — an aerodynamic damping the model did not have, and which
comes out of the geometry without any coefficient being invented. The HUD shows
the wind **relative to the nose**: what you want to know in flight is not an
absolute heading, it is which side is pushing.

### Rain

`src/rain.js` is the model, `src/rainfall.js` the rendering — the same split as
the wind, and for the same reason: the model half imports neither THREE nor the
DOM, which makes it verifiable in `tools/selftest.mjs`. Three things come out of
it: the streaks in the air, the loss of visibility, and the drops on the lens.

The intensity runs from 0 to 25 mm/h (`MAX_RATE`), because every relation
used is published in that unit. The median diameter follows Laws & Parsons
(`D = 0.89 R^0.21` mm), the fall speed Atlas & Ulbrich
(`v = 3.78 D^0.67` m/s) and the concentration is derived from the liquid water
content of Marshall-Palmer. At 5 mm/h that gives 1.25 mm falling at 4.4 m/s, 340
drops per cubic metre — which is the right answer, and what makes the intensity
readable in mm/h in the forecast rather than in percent.

The intensity **breathes**: the rain rate is lognormal, with the
`exp(-k²/2)` correction that guarantees that raising the variability makes the
shower come and go without making it stronger on average. Two bands, one of 70 s
and one of 14 s: a squall inside a shower.

**Visibility** comes from the extinction coefficient `σ = 0.21 R^0.74` per km
and from Koschmieder — 5.6 km at 5 mm/h, 1.7 km at 25. Extinctions add up, so
the final range is that one in parallel with the fog of the air, described
below: `loader.setFog()` moves density and colour live, and the fog
took up that same entry point rather than creating a second one.

The **streaks** are geometry in the scene, not an overlay: an
`InstancedBufferGeometry` of quads in a 4 m box that follows the camera,
therefore drawn by the `RenderPass` and therefore subject to the barrel, the
vignetting, the blur and the link degradation like everything else — and
occluded by the city. The positions are wrapped modulo the box in the vertex
shader: nothing is ever regenerated, the CPU writes one `vec3` per frame. The
streak orients itself on the drop's velocity **relative to the drone** and its
length is that velocity times the exposure time, the same shutter slider the HUD
already sets: translational blur is precisely what the lens pass does not
reconstruct, and a rain streak is that blur.

Four metres and no more, because beyond that a drop is thinner than a pixel
and stops being a streak: what happens to it is extinction, and
extinction is the fog above. The near in geometry, the far in
fog, and neither does the other's job.

One point is **assumed and not physical**, `STREAK_WIDTH_GAIN`: at real size,
the optical depth of the near field is below one percent and a streak is a
third of a pixel wide — the answer is right and unusable. The drawn width is
therefore exaggerated, the opacity **never** (it is always computed on the
real diameter), and the number of streaks is divided by the same factor so that
the screen area covered stays the one the concentration calls for.

#### Drops on the lens

An FPV camera has a flat window a few millimetres in front of the objective, and
that is where the water settles. Two numbers of the **camera** — not of the
weather — then decide nearly everything: the entrance pupil (≈ 1 mm) and that
setback (≈ 8 mm).

What matters is not the focus but **which rays the bead touches**.
Every point of the window is crossed by the whole cone the pupil accepts, so
a bead of diameter `D` at a setback `s` acts on the convolution of the
bead by the pupil: an angular disc of `(D + A)/s`, with a flat core over
`(D − A)/s`. It follows, with nothing tuned, that the footprint is **large and
almost independent of the drop's size** (six times the drop, 2.8 times the
footprint), that a drop **smaller than the pupil is never opaque**
since it can only clip part of the cone, and that the edge is soft over
the width of the pupil. It is also why refraction — a sharp image,
merely displaced — could not have looked like anything at all.

The count falls out of the same chain: `wetness` **is** the wetted fraction (the
deposition in `RainField.update()` is proportional to the bare glass
remaining), so the number of beads is that fraction of the window divided by the
area of one bead. Ten millimetres of window over four of bead makes **a handful
of drops**: a wet lens is five big blotches. That is the
reason `LensDrops` is a list of uniforms and not a procedural
field — and therefore why nothing reads as a grid.

What the drop **shows** is a different size from what it **covers**: the
first comes from the entire cone in which the bead scatters, far wider than the
disc, and biased towards the top of the frame because outside it is the sky that
dominates that cone. Hence the intended behaviour: pale in front of a façade,
invisible in front of the sky. That wide average is taken from the mip chain of
the composer's target — it is the only change the drops impose on the rest of
the pass, and it is there because a handful of taps over that much image gives
grain and not water.

**Run-off** follows `dropDrift()`, which is not "downwards": it is
apparent gravity (exactly `-force/mass`) plus the drag of the airflow,
which wins from ~6 m/s — so the water climbs up the frame in fast flight. A bead
only leaves when the force beats the contact line holding it, a threshold in
`1/D²`: the big ones run, the small ones never move, without any
"this one is mobile" flag. It catches on the next defect about one bead width
further on, which gives the jerky motion. **Nothing draws a
trail**: it was the trail that made the earlier attempt read as a scratch on
the objective.

### Fog

`src/fog.js` — the model, without THREE or DOM like the wind and the rain; the
tile shader does the extinction, `loader.setFog()` applies it on the N chunk
materials, `src/lens.js` draws the veil.

The unit is a **distance**, because that is the one a pilot
thinks in: the forecast displays "500 m", not "33%". The exp² density that
`TileMaterial.js` expects is derived from it by `fogRange()` / `fogDensity()`
(`src/rain.js`), never the other way round. The correspondence is
**geometric** between the clear air of the scene and 30 m:

```
R(i) = R0 · (30 / R0)^i          R0 = fogRange(0.00085) ≈ 2035 m
```

It is the only scale on which "a bit more fog" means the same thing at 2 km and
at 50 m, and it makes `i = 0` **exactly** the density the scene was already
loading. `intensityForRange()` is the exact inverse, and that is where the world
weather comes in: it speaks in metres of visibility, `fog.js` takes an
intensity. The presets are still resolved backwards from the WMO visibility
classes — mist 1200 m, fog 500 m, pea soup 50 m.

Like the rain, the fog **breathes**: two Ornstein-Uhlenbeck bands of
120 s and 25 s (a fog bank moves in minutes, not in seconds) and the
same lognormal `exp(-k²/2)` correction, applied to **the added extinction** and
not to the range — extinctions are what adds up. Raising the
variability therefore makes visibility come and go without thickening the air on
average, which `tools/selftest.mjs` checks over six seeds and ten cumulative
hours: over twenty minutes a single seed wanders between 0.8 and 1.2 of the
mean while the model is unbiased.

Fog and rain **add up as extinctions**, which is a strict
generalisation of what #24 had established: `FOG_DENSITY × rain.fogScale`
is by definition `FOG_DENSITY + the extinction of the rain`, so with the fog
slider at zero the image is the one from before, to the bit.

The **sky** follows, otherwise the tile edge stops dissolving into the
background. It starts from a light blue-grey, darkens under rain (the light
crosses water and cloud) then whitens under fog (what you are looking at *is*
the scattered light) — in that order, so that at fifty metres of visibility the
sky is the fog and nothing else. Interpolated on the raw bytes: see
bug #10 in HANDOFF.

**Light scattering** is rendered as a **lens veil** in
`src/lens.js`: six taps on a wide spiral, at the corresponding mip
level, mixed with the sky, added and then renormalised by `1 + k`. Added and not
blended, because the veil is light that arrives — that is what lifts the blacks,
and that is why a photograph taken in fog has no black. The
division is the exposure the camera would have taken back, and it stops the sky
from clipping. `uGlare` at zero **compiles the effect out of the shader**, like
`LINK_OFF`.

Two things are **not** here and are separate issues: ground mist and the
variation with altitude, which require a world position in the fragment
shader of `TileMaterial.js`, and the directional halo around the sun, which
requires a sun (#23).

### Sound

Nothing is loaded: `src/audio.js` synthesises everything in Web Audio from the
four motor speeds. Each motor has its own oscillators, tuned to its
blade passing frequency (≈ 530 Hz in hover, ≈ 1420 Hz at full throttle), plus
its harmonics and broadband noise; the four are panned according to
their position on the airframe. The speeds diverge as soon as you put stick in,
and it is that beating between them that makes the sound of a quad in a turn —
merging them into a single oscillator would lose exactly what is worth having.

Added to that: the aerodynamic rush (indexed on *air*speed, hence more discreet
downwind), the propwash in descent, and an impact noise whose
level follows the contact force.

The spectrum is deliberately bounded: sines rather than sawtooths, a low-pass
per motor and a general low-pass, and a limiter above everything. A synthesis
that lets its energy run into 2–8 kHz is exhausting after ten minutes,
and that is precisely the band where the ear is most sensitive. The four
motors are also slightly detuned from one another: at equal command the model
gives them the exact same speed, and four rigorously coherent oscillators
sound like a synth, not like a quad.

Volume and **timbre** in the `Tab` panel, remembered from one session to the
next; the timbre moves the two cutoffs from ×0.5 to ×2 around the measured
setting, to be adjusted to your headphones. Sound is cut in free camera. Sound
starts on the click on `OPEN` in the terminal
(or on the first gesture when `?scene=` skips the terminal): browsers
refuse to make noise before a user gesture.

### FPV rendering

A perfect rectilinear camera does not look like an FPV video feed, and
that is what `src/lens.js` corrects: a single fullscreen pass that does the
barrel, the lateral chromatic aberration, the softness at the edges, the
vignetting and the motion blur.

Three settings in the `Tab` panel, **Lens** section, remembered from one
session to the next:

| setting | default | what it does |
|---|---|---|
| **FPV rendering** | on | the master switch: unchecked, the image goes back to what it was, which is the only honest way to compare |
| **Lens** | 60% | barrel, chromatic aberration and edge softness together — it is the same piece of glass, separating them would let you build an optic that does not exist |
| **Vignetting** | 50% | the darkening of the corners |
| **Shutter** | 8 ms | the exposure time, hence the length of the trail; 0 turns the blur off |

The barrel is normalised at the corner: it does not eat field of view, it
magnifies the centre (×1.26 by default). The FOV slider therefore keeps exactly
the meaning it had.

The motion blur does not read depth. The world is static and the
camera is the only thing that moves, so rotational blur is reconstructed by
reprojecting the view rays through the rotation performed during the exposure —
which makes the blur correct without touching `camera.near`. Translational
parallax is the part that is missing.

Cost measured on the Eiffel Tower at 2560×1265: **1.14 ms/frame** on a budget of
10 ms. Contrary to what one might think, lowering the shutter only
recovers 0.47 ms of that total; if the frame rate drops, it is the
**FPV rendering** box that should be unchecked, not the blur.

### The video link

The video feed arrives by radio, and radio does not go through
buildings. `src/link.js` computes a link budget in dB between the drone and the
pilot — who stands at the take-off point — and `src/lens.js` turns it into a
degraded image, at the end of the chain, after the lens.

**Analogue has a look even at full signal.** This is the most
important and least obvious point: a composite feed is not a clean image
that then breaks, it is soft, washed out and colour-smeared from the first
frame. Chrominance bandwidth is a fraction of luminance bandwidth, so
colour bleeds laterally while contours stay sharp. That is what
makes it "FPV feed" rather than "render engine bug" — the
degradation comes **on top**. The digital mode, on the other hand, is clean: at
a perfect link it renders a sky pixel at exactly `#9fb8cc`, as without the
effect.

What drives the degradation is **distance and occlusion**, the second
counting more than the first. Quality slides continuously with distance
(1.00 at 50 m → 0.80 at 300 m → 0.64 at 900 m): there is therefore always
something to read, rather than a perfect image up to the instant it disappears.
A building between you and the pilot brings it down to ~0.50 — clearly degraded,
perfectly flyable. Only a low, distant flight across a whole neighbourhood
really cuts the link.

Occlusion is measured by **two raycasts**, one from each end: the
first hit on the way out says where the matter starts, the first hit on the
way back says where it ends, and the gap is the thickness to cross. A single ray
would only say "something is blocking", and clipping the corner of a roof (0.86)
would become as serious as passing behind a city block (0.50). Measured
cost: 0.002 to 0.016 ms per frame depending on what the ray crosses.

Attenuation by depth **saturates** instead of being linear, and
the time constants are slow (0.30 s falling, 0.70 s recovering). Both
serve the same thing: the geometry is a staircase — the wall
is on the path or it is not — so without this the link is a switch
and not a fade. Passing a corner now takes ~780 ms on screen.

Two settings in the `Tab` panel, **Video link** section:

| setting | default | what it does |
|---|---|---|
| **Rendering** | Analogue | *Analogue*: chrominance smear and a washed-out image permanently, then grain, desaturation, line tearing, a sync bar and finally snow. You watch the link weaken. *Digital* (DJI/HDZero): sharp up to the threshold, then macroblocks, quantisation and a frozen frame. It holds, then it falls |
| **Degradation** | 100% | both the aggressiveness of the fall and the strength of the baseline analogue look; at 0% the effect is compiled out of the shader |

RSSI is displayed at the top right, otherwise an image falling apart reads
as a rendering bug rather than as information.

Measured cost: **1.0 ms/frame at worst** on a budget of 10, of which 0.12 ms for
the four chrominance taps of the analogue mode. A frozen image costs 0.60 ms
instead of 1.41: it is not rendered at all, only redisplayed.

### Zone limits

The map stops. What lies beyond was never downloaded — and the
fiction does not pretend otherwise: **the zone is the rectangle the
player drew themselves in the `GLOBAL SCANNER`**, and outside it there is
no data, hence no coverage, hence no link. This is not a radio
range: a radio range would be a circle centred on the pilot, and the
take-off point is not at the centre of the map (on `tour-eiffel` it is at
(−120, 140) in a box of ±642 m). The inscribed circle would throw away half
the map, the circumscribed one would spill into the void.

The model lives in `src/geofence.js` — no THREE, no Rapier, no DOM, like
`wind.js`, `fog.js`, `link.js` and `flight-end.js`. `main.js` pushes its force
into Rapier, its warning into the OSD and its loss into the link budget.

**Four rings**, decided by the margin to the edge (positive inside, negative
outside):

| ring | horizontal | vertical (below `bbox.min.y`) | what happens |
|---|---|---|---|
| `NOMINAL` | margin > 113 m | above −2 m | nothing |
| `CAUTION` | 113 → 66 m | −2 → −5 m | `NO COVERAGE` blinks, the image starts to degrade (8 dB) |
| `HOLD` | 66 → 0 m | −5 → −8 m | the pull-back rises from 0 to 5.89 m/s², the image keeps dying |
| `LOST` | beyond the edge | below −8 m | the pull-back is full, the loss runs away; at −66 m (horizontal) or −10 m (vertical) the session ends |

The boundaries have 15% hysteresis (`HYST`): without it, a hover held
right on the threshold makes the warning strobe — `link.js` has exactly the same
problem and exactly the same answer.

**Where 66 and 113 come from.** They are measured, not chosen:

```bash
node tools/geofence-measure.mjs                 # R_HOLD and R_CAUTION
node tools/geofence-measure.mjs --guarantee     # the corridor below which the guarantee fails
node tools/geofence-selftest.mjs                # the model, without a browser
```

`R_HOLD = 66 m` is the stopping distance of the pilot who **obeys** — an
explicit stick program (full throttle at 42° of attitude on the approach,
throttle back and pitch pulled level as soon as `HOLD` is entered), swept over
the six families and over the braking throttle band, worst case kept:
`heavy5`, 65.83 m. It is a fixed point, not a subtraction — the pull-back ramp
itself depends on `R_HOLD`. `R_CAUTION = 113 m` adds the time it takes to
**read** the warning at the maximum measured speed (30.87 m/s): 1.5 s, i.e.
three blinks at `BLINK_PERIOD_MS`.

The pull-back is capped at `A_MAX = 0.6 g`, i.e. 60% of what a hover
already consumes. Chosen for what it does **not** do: it does not exceed the
available thrust. Let go of the sticks and you are brought back; insist at full
throttle and you get through — and you lose the session. It is not a wall, it is
the drone's failsafe fighting you.

**The corridor is bounded per map.** 113 m on `bastille` (half-side 164 m)
would swallow 89% of the map. `Geofence` therefore scales both thresholds
by the **same** factor, so that their ratio — and therefore the warning
time, the sole reason `R_CAUTION` exists — survives the reduction:

```
halfMin = min((max.x − min.x)/2, (max.z − min.z)/2)
scale   = min(1, (halfMin / 3) / R_CAUTION)
```

The flyable core never goes below 67% of the smallest side, and maps that are
big enough (`scale === 1`) keep the measured value identically: on the
catalogue the measurement was made against, **12 of the 17 entries of
`public/scenes.json`**. That catalogue is per-installation — the repository now
ships an empty `scenes.json`, and the manifests themselves (`public/scenes/`)
are gitignored, so a count "over the N local manifests" is not reproducible from
one machine to another — on the one where these figures were measured
(2026-08-31, 25 folders, 8 of them outside `scenes.json`), it was 16 out of 25.
The corridor actually applied is read off the instance
(`fence.effectiveCorridor`) and in the console at load time
(`[fence] couloir …`) — that is what should be shown, not the constant. Below a
`HOLD` corridor of 50 m (`HOLD_STOP_GUARANTEE_M`, i.e. a half-side under
~252 m), the pilot who obeys still crosses the edge on the heaviest families;
`npm run add-map` says so at the moment the map is added. The failure mode stays
gentle: penetration never reaches `lost`, so the session is not lost — you pay
in image, not in session.

**Why the vertical corridor is below `bbox.min.y`.** The sign is what
matters most. Placed above, it would push the drone upwards at the lowest point
of the map — the surface of the Seine on `ile-de-la-cite`, where flying two
metres above the water is a perfectly normal flight. These four numbers (2 / 5
/ 8 / 10 m) are not measured and do not have to be: they rest on a
geometric argument — two metres below the lowest surface of the map, you are
necessarily under something — and they are not scaled, because
a small map does not have a thinner underside than a big one.

**Why the fence has its own channel in `link.js`.** The zone loss
goes through `setTerminalLoss()` and **not** through `_loss`. The playability
clamp of issue #79 caps `_loss` and puts quality back on a flyable floor after
two seconds of black screen — it exists so that you are never stuck
blind **in flight**. But leaving the zone is not flying, it is the end of the
session: that channel is applied on the way out, after the clamp, and never
lifts. The budget spent is exactly `LOSS_DEAD − LOSS_CLEAN` = 58 dB —
which takes any link, however clean, from perfect to dead —
of which 8 dB before the edge, during the warning (`KNIFE_EDGE_DB`: "you are
told you are running out of margin before you run out").

Beyond the edge, `src/ground.js` lays a plane under the mesh. Without it the
cliff has **sky** underneath, and that is not an edge case: in clear air the
range is about 2 km for a map of ±642 m. It is not an extension
of the world, it is a plain under the haze — the same fog formula as
`TileMaterial.js`, term for term, otherwise the horizon doubles up.

### Tuning the PID

```bash
npm run tune                          # report for the six families
npm run tune -- toothpick              # a single family
npm run tune -- --sweep roll race5     # sweeps P/D on one axis of one family
npm run tune -- --write <family|all>   # sweep + measurement, rewrites the pid block
```

The bench integrates the Euler equations with the real inertia tensor and the
real motor lag, without Rapier and without a browser: a full pass takes one
second. Its success thresholds are derived from the sustained angular
acceleration the airframe can really produce, not from constants written
by hand — so neither a fast preset nor a slow family can "fail"
merely because more is asked of it than of another. `--write` is **the only**
way to lay a `pid` block into `drone-profiles.js`: gains are not typed
in by hand.
