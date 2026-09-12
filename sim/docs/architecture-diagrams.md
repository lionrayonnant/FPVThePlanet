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

---

## 1. The loop the player goes through

One boot path, traversed with flags — never a parallel pipeline per mode (D7).
<img width="931" height="2251" alt="1 — The loop the player goes through" src="https://github.com/user-attachments/assets/22eacb52-708a-4b39-a243-df51047d80b8" />

> The world persists. The machine doesn't. Terrain is heavy, expensive, kept;
> the drone is free, drawn per target, lost on crash. There is no respawn in
> FIELD — `BENCH` is the exception, where nothing is lost.

---

## 2. Runtime map

`npm run dev` *is* the game (D1). The same routes are served without Vite by
`sim/server/` for the standalone build and the Electron app.

<img width="1463" height="1389" alt="2 — Runtime map" src="https://github.com/user-attachments/assets/de11ace3-6ebc-4fcf-a1e5-7c200117273c" /># FPVThePlanet! — how it works, in diagrams

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
flowchart TB
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
    STORE --> F1["settings"]
    STORE --> F2["terrainCache — areas kept"]
    STORE --> F3["worldState.weather — 7 days per area"]
    STORE --> F4["sessions[] — target, weather,<br/>telemetry, photos, verdict, seq numbers"]
    F4 --> DATASCREEN["DATA screen: replayable archive"]
    LS["localStorage 'fpvtp.*'<br/>gamepad map, audio, lens, mode"] --> BROWSERONLY["Browser-local only"]
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

