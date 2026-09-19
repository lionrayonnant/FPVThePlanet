<div align="center">

<img src="docs/brand/fpvtp-readme-1280x320.png" alt="FPVThePlanet! — point at a city, fly it" width="100%">

https://github.com/user-attachments/assets/d18df585-a85d-484f-8743-3dce02777d50

**FPV drone flying over real cities, in the browser.**<br>
Photogrammetry from Google Earth, a Betaflight quad, and a radio that works without setup.

[![Release](https://img.shields.io/github/v/release/lionrayonnant/FPVThePlanet?style=flat-square&labelColor=0d0d0d&color=d8d8d8&label=release)](https://github.com/lionrayonnant/FPVThePlanet/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/lionrayonnant/FPVThePlanet/ci.yml?branch=main&style=flat-square&labelColor=0d0d0d&color=d8d8d8&label=ci)](https://github.com/lionrayonnant/FPVThePlanet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-d8d8d8?style=flat-square&labelColor=0d0d0d)](LICENSE)
[![Discussions](https://img.shields.io/badge/discussions-open-d8d8d8?style=flat-square&labelColor=0d0d0d)](https://github.com/lionrayonnant/FPVThePlanet/discussions)

**[Download](https://github.com/lionrayonnant/FPVThePlanet/releases/latest)** ·
**[Run from source](#play)** ·
**[How it works](#how-it-works)** ·
**[Manual](docs/manual.md)** ·
**[Contribute](CONTRIBUTING.md)**

</div>

## Play

[Download the latest release](https://github.com/lionrayonnant/FPVThePlanet/releases/latest):
a `.exe` installer for Windows, an `.AppImage` for Linux. Both update themselves.

To run from source you need Node 22 and a WebGL2 browser. Chromium is the safe
choice, because its Gamepad API picks up a radio as soon as you move a stick.

```bash
git clone --depth 1 https://github.com/lionrayonnant/FPVThePlanet.git
cd FPVThePlanet/sim && npm install && npm run dev   # http://localhost:5173
```

The clone is around 165 MB, nine tenths of it the 143 music tracks in
`sim/public/music/`. `--depth 1` skips the history; the audio it does not skip,
because the soundtrack is part of the game rather than an asset pack.

A fresh clone has no terrain on disk, so the catalogue starts empty. Open the
LIVE tab, click the map to drop a pin, then `[ FLY LIVE ]`. Tiles stream in
during the flight and nothing is written to your disk.

## Support

The game is 100% free. If you appreciate my work, please consider helping me cover the hosting costs and burn some tokens!

<p align="center">
  <img src="docs/brand/mark-cake.svg" width="22" alt=""><br>
  <b>Cake Wallet</b> · one line, any coin<br>
  <code>fpvtp@cake.cash</code>
</p>

<p align="center">
  <img src="docs/brand/mark-monero.svg" width="22" alt=""><br>
  <b>Monero</b> · private by construction<br>
  <code>42RnnFdtNasaiUQGEASPGRXjHcr2pDocwXCwGUAhwyp7KbAhbKwCHrEfeYMkUMpo7gQdEABWy9LoRd4iEUFMq2SXKdHPqKt</code>
</p>

<p align="center">
  <img src="docs/brand/mark-bitcoin.svg" width="22" alt=""><br>
  <b>Bitcoin</b> · silent payment, every tip lands somewhere new<br>
  <code>sp1qq2tuvemuzgu6hudsu7jf2h90gl6xemav67s3x3f34l76qtfl6dzgcq43r30lvckcz4qat2x8ju5a36sdqr2r3fe72cqpudvlqh797agdkcvkvkl4</code>
</p>

<p align="center">
  <img src="docs/brand/mark-bitcoin.svg" width="22" alt=""><br>
  <b>Bitcoin</b> · for wallets that do not know silent payments yet<br>
  <code>bc1qmwm3rcvzkwaft40yrtynym3yww20t2atfr45yg</code>
</p>

## Controls

| | |
|---|---|
| radio / gamepad | detected automatically in Mode 2; remap and calibrate under `Tab`, with live bars to identify each axis |
| throttle, yaw | `W`/`S`, `A`/`D` |
| roll, pitch | the arrows, or the mouse |
| `M` | flight mode: acro, angle, altitude |
| `C` · `T` · `Tab` | free camera · flip the machine back over · settings |
| `B` | the bench panel, in flight — BENCH only |

Acro is the default, on a keyboard as much as on a radio — the keyboard axes
ramp rather than snapping to full deflection, which is what makes that
survivable without a stick. `M` cycles to angle and altitude if you want them.
There is no respawn in FIELD: crash and the machine is gone, and you start a
new one. BENCH is the mode where nothing is lost.

It is also the mode where you know the part numbers. The bench builds a machine
rather than picking one: a frame, four motors, four props, a pack and a camera
out of the spec's own catalogue, and then every parameter the flight stack
reads — mass and inertias, prop pitch, KV, pack resistance, drag, PID gains,
rates, throttle curve, gyro noise, loop latency — typed to the digit. `B` opens
the same screen over the flight, so a gain can be set and felt without landing,
and the jukebox can be re-tuned from the air.

## How it works

```mermaid
flowchart LR
    TERM["Operator terminal<br/>pin a place"] --> SCAN["TARGET SCAN<br/>lock an access"]
    SCAN --> BUILD["The machine is drawn<br/>per target"]
    BUILD --> FLY["FLIGHT"]
    FLY -- "crash, geofence,<br/>or you cut the link" --> LOST["LINK LOST<br/>the machine is gone"]
    LOST --> ARCH["Session archived:<br/>weather, telemetry, photos"]
    ARCH --> TERM
```

```mermaid
flowchart LR
    GE["Google Earth<br/>rocktree protocol"] --> LIVE["LIVE: streamed in the browser<br/>LOD rings, 3 workers, Cache API"]
    GE --> ACQ["ACQUIRE: fetched and decoded in Node<br/>FPVTP_ACQUIRE=1 only"]
    ACQ --> PREP["prep.mjs: ECEF to local ENU,<br/>chunks, texture arrays, collision"]
    PREP --> DISK["public/scenes/&lt;slug&gt;/"]
    LIVE --> SCENE["Three.js scene + Rapier trimesh"]
    DISK --> SCENE
```

Tiles come from Google Earth's internal `rocktree` protocol, which needs no key
and no account. In LIVE mode the player's own browser fetches them, so they
never pass through a server and nothing is kept.

Acquisition is the other path: downloading an area and baking it to playable
terrain on disk. It is off by default. It only turns on with `FPVTP_ACQUIRE=1`
in the environment, and never in `--mode shared`. CI doesn't set it and neither
do the distributed builds. The imagery stays © Google and is never
redistributed, so every install downloads its own and no baked terrain ships
from here.

## Built with

Plain JavaScript, no transpiler. Three.js for rendering, Rapier (WASM) for
physics, Vite for development and builds, Electron for the desktop app. The
standalone server is `node:http` with no dependencies.

The air model lives in `sim/src/quad.js` (mass, inertia, motor lag, blade drag,
ground effect, propwash, battery sag) and the controller in
`sim/src/flightController.js`. PID gains are measured with `npm run tune`.

| | |
|---|---|
| `npm run dev` | development: Vite, hot reload |
| `npm run build` then `node server/index.mjs --dist dist --open` | the game served without Vite, which is also what runs on a server |
| `npm run build` then `npx electron-builder` | the desktop app (`.exe`, `.AppImage`), with auto-update. The build step is not optional: electron-builder packages `dist/` as it finds it, and `dist/` is gitignored, so skipping it ships whatever bundle was last built |
| `npm run selftest:ci` | the full check chain, about two minutes: no browser, no network, no terrain |

## Read on

| | |
|---|---|
| [`docs/manual.md`](docs/manual.md) | commands, adding maps, the prep pipeline, the flight model, PID tuning |
| [`sim/docs/architecture-diagrams.md`](sim/docs/architecture-diagrams.md) | six more diagrams of the running system |
| [`deploy/README.md`](deploy/README.md) | putting the server on a machine |
| [`CHANGELOG.md`](CHANGELOG.md) | what changed, version by version |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how the project works, and the rules that actually bite |
| [`sim/HANDOFF.md`](sim/HANDOFF.md) | the maintainer's working log: what is measured, what is not. Internal, and still largely in French |

## Contributions

Still reading? Contributions are welcome.

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the short version of how the project
works — how to get it running, the module boundaries that keep the flight stack
testable, and the three or four rules a pull request actually gets sent back
for. Open an issue before anything larger than a fix; the target experience and
the order it gets built in are already written down, and a described problem is
often already answered by something planned.

Questions, tuning talk and "is this supposed to work like that" belong in
[Discussions](https://github.com/lionrayonnant/FPVThePlanet/discussions).
Vulnerabilities go through [`SECURITY.md`](SECURITY.md), never a public issue.
Everyone taking part is held to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright © 2026 lionrayonnant. [GNU AGPL-3.0-only](LICENSE). The code is free,
and anyone hosting a modified version for other people has to publish their
sources.

Bundled third-party work keeps its own licence: [Three.js](https://threejs.org/),
[Rapier](https://rapier.rs/), [Leaflet](https://leafletjs.com/) and
[Leaflet-Geoman](https://geoman.io/leaflet-geoman), all listed in
`sim/package.json`. The IBM Plex Mono and Departure Mono fonts are under the SIL
Open Font License, whose text sits next to them in `sim/public/fonts/`. The
music in `sim/public/music/` was generated for this project. Map tiles are
© OpenStreetMap and place search is © Nominatim.
