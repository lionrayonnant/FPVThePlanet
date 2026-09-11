# FPVThePlanet! — how it works, in diagrams

Mermaid views of the running system. They summarise, they do not replace the
sources of truth: `docs/manuel.md` (pipeline), `sim/docs/fpv-rework-architecture.md`
(module-by-module audit and decisions D1-D7), `sim/HANDOFF.md` (verified state).

Rendered as PNG in `sim/docs/diagrams/`, for anywhere Mermaid is not rendered.
**Regenerate them after editing any diagram below** — they went stale once
already, silently, because nothing checks them: between 2026-09-09 and
2026-09-11 the markdown lost the CONTROL VECTOR, gained a guided tour and lost
it again, while the PNGs still showed the first version.

The one-liner writes `out-1.png`, `out-2.png`… in source order, which is why it
is worth spelling out the renaming rather than leaving it to memory. From the
repo root:

```bash
npx @mermaid-js/mermaid-cli -i sim/docs/architecture-diagrams.md -o out.md -e png -s 2
mv out-1.png sim/docs/diagrams/01-player-loop.png
mv out-2.png sim/docs/diagrams/02-runtime-map.png
mv out-3.png sim/docs/diagrams/03-terrain-paths.png
mv out-4.png sim/docs/diagrams/04-flight-stack.png
mv out-5.png sim/docs/diagrams/05-persistence.png
rm out.md
```

`-s 2` renders at twice the size, which is what keeps the text readable when a
tall diagram is scaled to page width. On a headless box Chromium needs a
sandbox flag: add `-p puppeteer.json` with
`{"args": ["--no-sandbox", "--disable-setuid-sandbox"]}`.

`diagrams/simulator.svg` is hand-drawn and is NOT generated — see section 6.

Every diagram opens with the same `%%{init}%%` block: a light palette with dark
text, a 15px base size, and four accent classes that carry meaning rather than
decoration — green for being in the air, red for the flight ending, amber for
anything outside our own code, lavender for browser-local storage. Keep the
block identical across diagrams when editing one, or they stop reading as one
set. The same sources live as Mermaid notes in Trilium; this file stays the one
that is true.

---

## 1. The loop the player goes through

One boot path, traversed with flags — never a parallel pipeline per mode (D7).

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  'fontSize':'15px',
  'primaryColor':'#EEF4FC','primaryTextColor':'#22303C','primaryBorderColor':'#9BB3CD',
  'lineColor':'#8496A8','edgeLabelBackground':'#FFFFFF',
  'clusterBkg':'#FBFDFF','clusterBorder':'#D6E2EE',
  'tertiaryColor':'#FFFFFF'}}}%%
flowchart TD
    LOAD["Page load<br/><b>main.js</b>"] --> INTRO["Cracktro intro<br/><b>intro.js</b>"]
    INTRO --> OP{"Operator<br/>known?"}
    OP -- "no" --> BOOT["BOOTSTRAP<br/>hardware inventory, name, briefing<br/><b>bootstrap.js</b>"]
    OP -- "yes" --> MODE
    BOOT --> MODE["SELECT OPERATION MODE<br/><b>menu-nav.js</b>"]

    MODE -- "SETTINGS" --> SET["Settings — the panel Tab opens<br/><b>settings.js</b>"] --> MODE
    MODE -- "DATA" --> DATA["Session archive<br/>logs, photos, telemetry, REVISIT<br/><b>session-log.js</b>"]
    MODE -- "BENCH" --> BENCH["BENCH<br/>airframe, terrain, weather<br/>no target, no ceremony<br/><b>bench.js</b>"]
    MODE -- "FIELD" --> TERM["Operator terminal<br/>a cached area, or a LIVE pin<br/><b>terminal.js · scanner.js</b>"]

    DATA -- "REVISIT" --> TERM
    TERM --> SCAN["TARGET SCAN<br/>seeded candidates, area weather<br/><b>target-scan.js</b>"]
    SCAN -- "ESC" --> TERM
    SCAN --> BUILD["Draw the machine<br/>family + build seed<br/><b>target-build.mjs</b>"]
    BUILD --> HACK["HACK — the terrain loads behind it<br/><b>hack.js</b>"]

    BENCH --> FLIGHT
    HACK --> FLIGHT["FLIGHT<br/>entry state: already airborne<br/><b>entry-state.js</b>"]

    FLIGHT --> END{"How it<br/>ends"}
    END -- "crash" --> DEAD
    END -- "geofence exit" --> DEAD
    END -- "link cut, hold K" --> DEAD
    DEAD["LINK LOST — the machine is gone<br/><b>flight-end.js</b>, closes CRASHED"] --> ARCH["Session written to the archive<br/><b>session.js</b> → server"]
    ARCH --> MODE

    classDef flight fill:#E3F3EA,stroke:#6FAE8B,color:#164A30
    classDef stop fill:#FBEBEB,stroke:#D9A0A0,color:#6E2222
    class FLIGHT flight
    class DEAD stop
```

> The world persists. The machine doesn't. Terrain is heavy, expensive, kept;
> the drone is free, drawn per target, lost on crash. There is no respawn in
> FIELD — `BENCH` is the exception, where nothing is lost.

---

## 2. Runtime map

`npm run dev` *is* the game (D1). The same routes are served without Vite by
`sim/server/` for the standalone build and the Electron app.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  'fontSize':'15px',
  'primaryColor':'#EEF4FC','primaryTextColor':'#22303C','primaryBorderColor':'#9BB3CD',
  'lineColor':'#8496A8','edgeLabelBackground':'#FFFFFF',
  'clusterBkg':'#FBFDFF','clusterBorder':'#D6E2EE',
  'tertiaryColor':'#FFFFFF'}}}%%
flowchart LR
    subgraph BROWSER["Browser — Vite bundle"]
        UI["Operator terminal, scanner,<br/>screens, OSD, settings"]
        SIMLOOP["Simulation loop<br/><b>main.js</b>"]
        THREE["Three.js renderer<br/>+ lens compositing pass"]
        RAPIER["Rapier WASM<br/>trimesh collision"]
        WORKERS["Workers<br/>FPVG parse, rocktree pool, traversal"]
        CACHE["Cache API 'fpvtp-rocktree-v1'<br/>+ localStorage 'fpvtp.*'"]
    end

    subgraph SERVER["Node — <b>server/api.mjs</b>, no dependencies"]
        MAPAPI["<b>/__map-api</b><br/>describe, plan, probe, jobs SSE, scenes"]
        OPAPI["<b>/__operator</b><br/>operator state, sessions, photos, world"]
        STATIC["dist/ static files<br/>precompressed br / gz"]
    end

    subgraph DISK["Data dir — FPVTP_DATA_DIR"]
        SCENES["scenes/&lt;slug&gt;/ + scenes.json<br/>baked terrain"]
        OPSTATE["operator-state/<br/>one JSON per operator"]
        GCACHE["cache/google-earth/"]
    end

    subgraph EXT["External"]
        GE["Google Earth rocktree<br/>kh.google.com — no key"]
        OM["Open-Meteo — weather"]
        OSM["OpenStreetMap + Nominatim<br/>tiles and search"]
    end

    UI --> OPAPI
    UI --> MAPAPI
    UI --> OSM
    SIMLOOP --> THREE
    SIMLOOP --> RAPIER
    SIMLOOP --> WORKERS
    WORKERS --> CACHE
    WORKERS -- "LIVE flight,<br/>straight from the browser" --> GE
    MAPAPI -- "acquisition<br/>FPVTP_ACQUIRE=1 only" --> GE
    MAPAPI --> SCENES
    OPAPI --> OPSTATE
    OPAPI --> OM
    MAPAPI --> GCACHE
    STATIC --> BROWSER
    SIMLOOP --> SCENES

    classDef ext fill:#FFF7E6,stroke:#E2C583,color:#5A4412
    class GE,OM,OSM ext
```

Acquisition — downloading an area, decoding it and writing playable terrain —
is closed by default and never available in `--mode shared`. LIVE flight needs
none of it: tiles go to the player's browser and are never kept.

---

## 3. Where terrain comes from — two paths, one flight

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  'fontSize':'15px',
  'primaryColor':'#EEF4FC','primaryTextColor':'#22303C','primaryBorderColor':'#9BB3CD',
  'lineColor':'#8496A8','edgeLabelBackground':'#FFFFFF',
  'clusterBkg':'#FBFDFF','clusterBorder':'#D6E2EE',
  'tertiaryColor':'#FFFFFF'}}}%%
flowchart TD
    subgraph BAKED["Baked area — acquired once, flown offline"]
        A1["lat, lon + box"] --> A2["<b>providers/google-earth.mjs</b><br/>fetch + decode in Node"]
        A2 --> A3["<b>tools/prep.mjs</b><br/>ECEF → local ENU, chunking,<br/>texture arrays, FPVC collision"]
        A3 --> A4["public/scenes/&lt;slug&gt;/<br/>manifest.json, FPVG chunks"]
        A4 --> A5["<b>tools/add-map.mjs</b> → scenes.json"]
        A5 --> A6["<b>loader.js</b><br/>sceneBase, loadManifest,<br/>loadChunks, loadCollision"]
    end

    subgraph LIVE["LIVE area — streamed during the flight"]
        B1["Pin on the map"] --> B2["<b>rocktree-traverse-client.js</b><br/>traversal in a worker"]
        B2 --> B3["<b>rocktree-window.js</b><br/>LOD rings around the drone"]
        B3 --> B4["<b>rocktree-worker-pool.js</b><br/>3 workers, capped in-flight requests"]
        B4 --> B5["<b>rocktree-cache.js</b><br/>Cache API, bulks and nodes"]
        B5 --> B6["Node meshes built on the fly<br/>+ <b>rocktree-fence.js</b> soft edge"]
    end

    A6 --> SCENE["Three.js scene + Rapier trimesh"]
    B6 --> SCENE
    SCENE --> FLY["Flight"]

    classDef flight fill:#E3F3EA,stroke:#6FAE8B,color:#164A30
    class FLY flight
```

Hard constraints that survive everything: coordinates are local ENU metres,
X east / Y up / Z south; the drone collider is a 0.15 m sphere and `camera.near`
is exactly 0.15; the UV V axis is flipped in `prep.mjs`.

---

## 4. The flight stack, one fixed step

Narrow on purpose — four motor outputs, so a SITL can replace the controller
later. No art-direction module is ever a dependency of the engine (D6).

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  'fontSize':'15px',
  'primaryColor':'#EEF4FC','primaryTextColor':'#22303C','primaryBorderColor':'#9BB3CD',
  'lineColor':'#8496A8','edgeLabelBackground':'#FFFFFF',
  'clusterBkg':'#FBFDFF','clusterBorder':'#D6E2EE',
  'tertiaryColor':'#FFFFFF'}}}%%
flowchart TB
    IN["<b>input.js</b><br/>throttle 0..1 · roll/pitch/yaw −1..1<br/>auto gamepad mapping"]
    FC["<b>flightController.js</b><br/>Betaflight-shaped<br/>PID measured with npm run tune → motors[4]"]
    QUAD["<b>quad.js</b><br/>motor lag, thrust, prop drag torque,<br/>inflow, body drag, ground effect,<br/>propwash, battery sag"]
    PHY["<b>physics.js</b> / Rapier<br/>full-res trimesh, CCD,<br/>zero damping, forces reset each step"]

    IN --> FC --> QUAD --> PHY
    PHY -- "state feedback" --> FC

    WEATHER["World weather snapshot<br/>Open-Meteo, per area per day"] --> WRF["<b>wind.js · rain.js · fog.js</b><br/>pure models, never a dependency<br/>of the engine (D6)"]
    WRF --> QUAD
    WRF --> LENS

    PHY --> CAM["Camera — fpv / chase / free"]
    CAM --> LENS["<b>lens.js</b> — one fullscreen pass<br/>barrel, chromatic aberration, vignette,<br/>rotation blur, lens water, sun"]
    DOSD["<b>drone-osd.js</b><br/>the target's own OSD"] --> LENS
    LENS --> LINK["<b>link.js</b> — 5.8 GHz budget, RSSI<br/>analogue / digital degradation"]
    LINK --> FOSD["<b>fpvtp-osd.js</b> — our overlay,<br/>above the degradation"]
    FOSD --> SCREEN["Goggles"]

    PHY --> FENCE["<b>geofence.js</b><br/>soft recall, then exit"]
    PHY --> FE["<b>flight-end.js</b><br/>crash · out of zone · link cut"]
    FENCE --> FE

    classDef env fill:#FFF7E6,stroke:#E2C583,color:#5A4412
    classDef stop fill:#FBEBEB,stroke:#D9A0A0,color:#6E2222
    classDef out fill:#E3F3EA,stroke:#6FAE8B,color:#164A30
    class WEATHER,WRF env
    class FE stop
    class SCREEN out
```

The order is physical: the lens is glass in front of the sensor, the link is what
happens to the picture afterwards. RF snow is not vignetted, because the vignette
happened two boxes upstream.

Per frame, `main.js` runs a fixed-step accumulator: `controller.update` then
`physics.step` per step, geofence force injected inside the step, and everything
else — telemetry sampling, weather, audio, screens — once per frame.

---

## 5. What is persisted, and where

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  'fontSize':'15px',
  'primaryColor':'#EEF4FC','primaryTextColor':'#22303C','primaryBorderColor':'#9BB3CD',
  'lineColor':'#8496A8','edgeLabelBackground':'#FFFFFF',
  'clusterBkg':'#FBFDFF','clusterBorder':'#D6E2EE',
  'tertiaryColor':'#FFFFFF'}}}%%
flowchart TD
    OPCLIENT["<b>operator.js</b><br/>key in localStorage"] -->|"POST /__operator"| STORE
    SESSION["<b>session.js</b><br/>opens at the first flight frame,<br/>samples telemetry every 0.2 s"] -->|"PATCH session<br/>POST photo"| STORE
    STORE["operator-state/&lt;id&gt;.json<br/><b>tools/operator-store.mjs</b>"]
    STORE --> F1["settings"]
    STORE --> F2["terrainCache<br/>areas kept"]
    STORE --> F3["worldState.weather<br/>7 days per area"]
    STORE --> F4["sessions[]<br/>target, weather, telemetry,<br/>photos, verdict, seq numbers"]
    F4 --> DATASCREEN["DATA screen<br/>replayable archive"]
    LS["localStorage 'fpvtp.*'<br/>gamepad map, audio, lens, mode"] --> BROWSERONLY["Browser-local only"]

    classDef io fill:#F0EBFA,stroke:#B2A4DA,color:#3A2F5E
    class LS,BROWSERONLY io
```

Server-side operator state (D2) is one coherent place next to the terrain, it
survives a browser cache wipe, and it is what makes multi-operator nearly free.

---

## 6. Inside the simulator

Hand-drawn rather than generated: the engine itself, and where each module sits
relative to the fixed step. Edit `diagrams/simulator.svg` directly.

![The simulator: input and environment, the fixed-step loop, the image chain](diagrams/simulator.svg)

Three things this is meant to make obvious. The controller, the airframe and
Rapier are one loop at a fixed 1/250 s, capped at 12 steps per frame — the rest
of the game runs once per frame around it. The environment models are pure and
sit outside, writing into that loop rather than being part of it. And the image
chain has an order that is physical, not arbitrary: the glass, then the link.

