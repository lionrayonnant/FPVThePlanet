# FPVThePlanet! — how it works, in diagrams

Mermaid views of the running system. They summarise, they do not replace the
sources of truth: `docs/manuel.md` (pipeline), `sim/docs/fpv-rework-architecture.md`
(module-by-module audit and decisions D1-D7), `sim/HANDOFF.md` (verified state).

Rendered as PNG in `sim/docs/diagrams/`, for anywhere Mermaid is not rendered.
Regenerate them after editing a diagram below:

```bash
npx @mermaid-js/mermaid-cli -i sim/docs/architecture-diagrams.md -o out.md -e png
```

---

## 1. The loop the player goes through

One boot path, traversed with flags — never a parallel pipeline per mode (D7).

```mermaid
flowchart TD
    LOAD["Page load — main.js"] --> INTRO["Cracktro intro<br/>src/intro.js"]
    INTRO --> OP{"Operator known?"}
    OP -- "no" --> BOOT["BOOTSTRAP — hardware inventory,<br/>name, Control Vector, briefing<br/>src/bootstrap.js"]
    OP -- "yes" --> MODE
    BOOT --> MODE["SELECT OPERATION MODE<br/>src/menu-nav.js"]

    MODE -- "SETTINGS" --> SET["Settings panel — same one Tab opens<br/>src/settings.js"] --> MODE
    MODE -- "DATA" --> DATA["Session archive: logs, photos,<br/>telemetry, REVISIT<br/>src/session-log.js"]
    MODE -- "BENCH" --> BENCH["BENCH — airframe, terrain, weather,<br/>no target, no ceremony<br/>src/bench.js"]
    MODE -- "FIELD" --> TERM["Operator terminal:<br/>pick a cached area, or drop a LIVE pin<br/>src/terminal.js + src/scanner.js"]

    DATA -- "REVISIT" --> TERM
    TERM --> SCAN["TARGET SCAN — seeded candidates,<br/>area weather shown<br/>src/target-scan.js"]
    SCAN -- "ESC" --> TERM
    SCAN --> BUILD["Draw the machine: family + build seed<br/>tools/target-build.mjs -> PROFILE, rates"]
    BUILD --> HACK["HACK screen — the terrain loads behind it<br/>src/hack.js"]
    BENCH --> FLIGHT
    HACK --> FLIGHT["FLIGHT — entry state: already airborne<br/>src/entry-state.js"]

    FLIGHT --> END{"How it ends"}
    END -- "crash above threshold" --> DEAD
    END -- "geofence exit" --> DEAD
    END -- "pilot cuts the link, hold K" --> DEAD
    DEAD["LINK LOST — the machine is gone.<br/>src/flight-end.js, closes CRASHED"] --> ARCH["Session written to the archive<br/>src/session.js -> server"]
    ARCH --> MODE

    classDef flight fill:#1d3b2a,stroke:#4f9,color:#dfe
    class FLIGHT,DEAD flight
```

> The world persists. The machine doesn't. Terrain is heavy, expensive, kept;
> the drone is free, drawn per target, lost on crash. There is no respawn in
> FIELD — `BENCH` is the exception, where nothing is lost.

---

## 2. Runtime map

`npm run dev` *is* the game (D1). The same routes are served without Vite by
`sim/server/` for the standalone build and the Electron app.

```mermaid
flowchart LR
    subgraph BROWSER["Browser — Vite bundle"]
        UI["Operator terminal, scanner,<br/>screens, OSD, settings"]
        SIMLOOP["Simulation loop — main.js"]
        THREE["Three.js renderer<br/>+ lens compositing pass"]
        RAPIER["Rapier WASM<br/>trimesh collision"]
        WORKERS["Workers: FPVG geometry parse,<br/>rocktree fetch pool, traversal"]
        CACHE["Cache API 'fpvtp-rocktree-v1'<br/>+ localStorage 'fpvtp.*'"]
    end

    subgraph SERVER["Node — server/api.mjs, no dependencies"]
        MAPAPI["/__map-api — describe, plan,<br/>probe, jobs SSE, scenes"]
        OPAPI["/__operator — operator state,<br/>sessions, photos, world state"]
        STATIC["dist/ static files, precompressed br/gz"]
    end

    subgraph DISK["Data dir — tools/lib/paths.mjs, FPVTP_DATA_DIR"]
        SCENES["scenes/&lt;slug&gt;/ + scenes.json<br/>baked terrain"]
        OPSTATE["operator-state/ — JSON per operator"]
        GCACHE["cache/google-earth/"]
    end

    subgraph EXT["External"]
        GE["Google Earth rocktree<br/>kh.google.com, no key"]
        OM["Open-Meteo — weather"]
        OSM["OpenStreetMap + Nominatim<br/>map tiles and search"]
    end

    UI --> OPAPI
    UI --> MAPAPI
    UI --> OSM
    SIMLOOP --> THREE
    SIMLOOP --> RAPIER
    SIMLOOP --> WORKERS
    WORKERS --> CACHE
    WORKERS -- "LIVE flight, straight from the browser" --> GE
    MAPAPI -- "acquisition, FPVTP_ACQUIRE=1 only" --> GE
    MAPAPI --> SCENES
    OPAPI --> OPSTATE
    OPAPI --> OM
    MAPAPI --> GCACHE
    STATIC --> BROWSER
    SIMLOOP --> SCENES
```

Acquisition — downloading an area, decoding it and writing playable terrain —
is closed by default and never available in `--mode shared`. LIVE flight needs
none of it: tiles go to the player's browser and are never kept.

---

## 3. Where terrain comes from — two paths, one flight

```mermaid
flowchart TD
    subgraph BAKED["Baked area — acquired once, flown offline"]
        A1["lat, lon + box"] --> A2["providers/google-earth.mjs<br/>fetch + decode in Node"]
        A2 --> A3["tools/prep.mjs<br/>ECEF -> local ENU, chunking,<br/>texture arrays, FPVC collision"]
        A3 --> A4["public/scenes/&lt;slug&gt;/<br/>manifest.json, FPVG chunks"]
        A4 --> A5["tools/add-map.mjs -> scenes.json"]
        A5 --> A6["loader.js: sceneBase, loadManifest,<br/>loadChunks, loadCollision"]
    end

    subgraph LIVE["LIVE area — streamed during the flight"]
        B1["Pin on the map"] --> B2["rocktree-traverse-client.js<br/>traversal in a worker"]
        B2 --> B3["rocktree-window.js<br/>LOD rings around the drone"]
        B3 --> B4["rocktree-worker-pool.js<br/>3 workers, capped in-flight requests"]
        B4 --> B5["rocktree-cache.js<br/>Cache API, bulks and nodes"]
        B5 --> B6["Node meshes built on the fly<br/>+ rocktree-fence.js soft edge"]
    end

    A6 --> SCENE["Three.js scene + Rapier trimesh"]
    B6 --> SCENE
    SCENE --> FLY["Flight"]
```

Hard constraints that survive everything: coordinates are local ENU metres,
X east / Y up / Z south; the drone collider is a 0.15 m sphere and `camera.near`
is exactly 0.15; the UV V axis is flipped in `prep.mjs`.

---

## 4. The flight stack, one fixed step

Narrow on purpose — four motor outputs, so a SITL can replace the controller
later. No art-direction module is ever a dependency of the engine (D6).

```mermaid
flowchart LR
    IN["input.js<br/>throttle 0..1, roll/pitch/yaw -1..1<br/>auto gamepad mapping"]
    FC["flightController.js<br/>Betaflight-shaped, PID measured with<br/>npm run tune -> motors[4]"]
    QUAD["quad.js<br/>motor lag, thrust, prop drag torque,<br/>inflow, body drag, ground effect,<br/>propwash, battery sag"]
    PHY["physics.js / Rapier<br/>full-res trimesh, CCD,<br/>zero damping, forces reset each step"]

    IN --> FC --> QUAD --> PHY
    PHY -- "state feedback" --> FC

    WEATHER["World weather snapshot<br/>Open-Meteo, per area per day"] --> WRF["wind.js · rain.js · fog.js"]
    WRF --> QUAD
    WRF --> LENS

    PHY --> CAM["Camera: fpv / chase / free"]
    CAM --> LENS["lens.js — one fullscreen pass:<br/>barrel, chromatic aberration, vignette,<br/>rotation blur, lens water"]
    DOSD["drone-osd.js — the target's own OSD"] --> LENS
    LENS --> LINK["link.js — 5.8 GHz budget,<br/>RSSI, analogue/digital degradation"]
    LINK --> FOSD["fpvtp-osd.js — our overlay,<br/>above the degradation"]
    FOSD --> SCREEN["Goggles"]

    PHY --> FENCE["geofence.js — soft recall, then exit"]
    PHY --> FE["flight-end.js<br/>crash · out of zone · link cut"]
    FENCE --> FE
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
flowchart TD
    OPCLIENT["src/operator.js<br/>key in localStorage"] -->|"POST /__operator"| STORE
    SESSION["src/session.js<br/>opens at first flight frame,<br/>samples telemetry every 0.2 s"] -->|"PATCH session, POST photo"| STORE
    STORE["operator-state/&lt;id&gt;.json<br/>tools/operator-store.mjs"]
    STORE --> F1["controlVector · settings"]
    STORE --> F2["terrainCache — areas kept"]
    STORE --> F3["worldState.weather — 7 days per area"]
    STORE --> F4["sessions[] — target, weather,<br/>telemetry, photos, verdict, seq numbers"]
    F4 --> DATASCREEN["DATA screen: replayable archive"]
    LS["localStorage 'fpvtp.*'<br/>gamepad map, audio, lens, mode"] --> BROWSERONLY["Browser-local only"]
```

Server-side operator state (D2) is one coherent place next to the terrain, it
survives a browser cache wipe, and it is what makes multi-operator nearly free.
