// GLOBAL SCANNER (PHASE 03, Bible §4/§6/§8). The game's world entry point:
// it absorbs /add-map.html — search, frame, draw, probe, acquire, fly, without
// leaving the terminal.
//
// It only talks to /__map-api (tools/map-api-plugin.mjs), which only exists
// under `npm run dev`: that is the local installation, and it is deliberate
// (D1). Loaded as a dynamic import from terminal.js, so Leaflet weighs nothing
// until the operator opens the scanner.
//
// The grid displayed is the grid actually scanned (tools/lib/tiles.mjs, a port
// of the Go): no second graphical representation — see the investigation answer
// on issue #40.
import L from 'leaflet';
import { armConfirm } from './confirm-button.js';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import {
	areaAnalysis, signalDensity, railLine, prunedBands, acquisitionProgress,
	pipelineBars, pipelineStats, latticeEdges, maskOutline, polygonBounds, polygonProbePoint, slugify, designationFrom, phaseLabel, elapsed, bytes, num,
	sourceChoices, chosenSource, zoneCentre, acquireStep,
} from '../tools/scanner-model.mjs';
import { notify } from './dialogue.js';
import { acquisitionContext, scanContext } from './dialogue-context.js';
import { previewBounds } from '../tools/map-preview-model.mjs';
import { Coverage, planDraw } from './coverage.js';
import { createCoverageLayer } from './map-coverage.js';
import { createTracksLayer } from './map-tracks.js';
import * as operatorApi from './operator.js';
import { token } from './palette.js';
import { LAYERS } from './map-layers.js';

const API = '/__map-api';

const DETAIL = [
	{ zoom: 20, label: 'HIGH', side: '25 m' },
	{ zoom: 19, label: 'MED', side: '50 m' },
	{ zoom: 18, label: 'LOW', side: '100 m' },
];

const RE_COORDS = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/;

// The scanner's last view, to reopen where it was left within the session.
let lastView = { center: [48.8582, 2.297], zoom: 13 };

// The search lives outside the rail: all it does is move the map, and it
// serves both FIELD tabs (#222). The Home gives it its own host, above the
// tabs, so that it survives the rail being replaced by JOB_PANEL.
const SEARCH_PANEL = `
<div class="sc-row">
	<input class="sc-search" type="search" autocomplete="off" spellcheck="false" placeholder="SEARCH — TOKYO, OR 48.85, 2.35">
	<button type="button" class="sc-btn sc-find">FIND</button>
</div>
<div class="sc-results"></div>
<pre class="sc-note sc-search-note" hidden></pre>`;

// The LOCAL rail, once you draw (#222): the area, the source, the name, and
// ONE button. The AREA ANALYSIS, SIGNAL DENSITY and COVERAGE blocks are gone —
// what they said that was useful fits on the line under the button (railLine),
// and the density is still computed, silently, for the KEEP and the TARGET
// SCAN.
const PANEL = `
<section class="sc-block">
	<pre class="sc-h">AREA</pre>
	<pre class="sc-hint sc-area-hint">DRAW A BOX OR A SHAPE ON THE MAP</pre>
	<div class="sc-row">
		<button type="button" class="sc-btn sc-draw">DRAW BOX</button>
		<button type="button" class="sc-btn sc-draw-poly">DRAW SHAPE</button>
		<button type="button" class="sc-btn sc-clear" hidden>CLEAR</button>
	</div>
	<pre class="sc-note sc-heavy" hidden></pre>
</section>

<section class="sc-block">
	<pre class="sc-h">SOURCE</pre>
	<div class="sc-switch sc-source-switch"></div>
	<pre class="sc-note sc-source-note" hidden></pre>
</section>

<section class="sc-block">
	<pre class="sc-h">DESIGNATION</pre>
	<input class="sc-name" type="text" autocomplete="off" spellcheck="false" placeholder="AREA NAME">
	<pre class="sc-note sc-slug" hidden></pre>
</section>

<section class="sc-block sc-verbs">
	<div class="sc-verb">
		<button type="button" class="sc-cta sc-acquire" disabled>[ ACQUIRE AREA ]</button>
		<pre class="sc-hint">BAKED TO DISK · KEPT · PLAYS OFFLINE</pre>
	</div>
	<pre class="sc-verdict" data-status="unprobed">UNPROBED</pre>
	<pre class="sc-detail"></pre>
	<pre class="sc-note sc-acquire-note" hidden></pre>
</section>


<section class="sc-block sc-foot">
	<button type="button" class="sc-cta sc-back">[ BACK ]</button>
</section>`;

// The LIVE tab (#222): a pin on the map, and that is all. Nothing is planned,
// nothing is probed, nothing is written — the world arrives during the flight.
const LIVE_PANEL = `
<section class="sc-block">
	<pre class="sc-h">DROP POINT</pre>
	<pre class="sc-hint sc-pin-hint">CLICK THE MAP TO DROP A PIN</pre>
	<pre class="sc-pin-place" hidden></pre>
	<pre class="sc-hint sc-pin-coords" hidden></pre>
</section>

<section class="sc-block sc-verbs">
	<div class="sc-verb">
		<button type="button" class="sc-cta sc-fly-live" disabled>[ FLY LIVE ]</button>
	</div>
</section>`;

// One bar row: a fixed label + the `.sc-bar` watchJob() drives by selector.
const barRow = (cls, label) =>
	`<div class="sc-bar-row"><span class="sc-bar-label">${label}</span>` +
	`<div class="sc-bar ${cls}" data-indeterminate="1"><i></i></div></div>`;

const JOB_PANEL = `
<pre class="sc-title">AREA ACQUISITION</pre>
<section class="sc-block">
	<pre class="sc-h sc-job-name">—</pre>
	<dl class="sc-readout">
		<dt>PHASE</dt><dd class="sc-job-phase">—</dd>
		<dt>TILES</dt><dd class="sc-job-tiles">—</dd>
		<dt>ELAPSED</dt><dd class="sc-job-elapsed">0 s</dd>
	</dl>
	<div class="sc-bars">
		${barRow('sc-bar-terrain', 'TERRAIN')}
		${barRow('sc-bar-fetch', 'FETCH')}
		${barRow('sc-bar-decode', 'DECODE')}
		${barRow('sc-bar-rebuild', 'REBUILD')}
	</div>
	<pre class="sc-note sc-job-note" hidden></pre>
</section>
<section class="sc-block sc-job-stats" hidden>
	<pre class="sc-h">GEOMETRY / TEXTURES</pre>
	<dl class="sc-readout sc-stats-readout"></dl>
</section>
<section class="sc-block">
	<pre class="sc-h">RF ANALYSIS / TARGET SEARCH</pre>
	<!-- Decorative (Bible §8): neither of these two bars gates anything at all —
	     the real target generation is PHASE 7. -->
	<div class="sc-bars">
		${barRow('sc-bar-rf', 'RF ANALYSIS')}
		${barRow('sc-bar-target', 'TARGET SEARCH')}
	</div>
</section>
<section class="sc-block sc-log-block">
	<pre class="sc-h">PIPELINE</pre>
	<pre class="sc-log"></pre>
</section>
<section class="sc-block sc-job-done" hidden>
	<pre class="sc-h">TERRAIN ACQUIRED</pre>
	<pre class="sc-job-done-line"></pre>
	<div class="sc-row">
		<button type="button" class="sc-cta sc-keep">[ KEEP TERRAIN ]</button>
		<button type="button" class="sc-cta sc-discard">[ REMOVE TERRAIN ]</button>
	</div>
	<pre class="sc-note sc-keep-note" hidden></pre>
</section>
<section class="sc-block sc-foot">
	<button type="button" class="sc-cta sc-abort">[ ABORT ]</button>
	<button type="button" class="sc-cta sc-leave">[ LEAVE — KEEPS RUNNING ]</button>
	<button type="button" class="sc-cta sc-fly" hidden>[ FLY ]</button>
	<button type="button" class="sc-cta sc-job-back" hidden>[ BACK ]</button>
</section>`;

async function api(path, opts) {
	const res = await fetch(API + path, {
		...opts,
		headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
	});
	const body = await res.json().catch(() => ({ error: `unreadable response (${res.status})` }));
	if (!res.ok) throw new Error(body.error ?? `error ${res.status}`);
	return body;
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b) });

// Mounts the scanner into the hosts the caller provides, and returns a handle.
//
// The full frame is gone (#211): since FIELD became a single screen, the Home
// owns the two columns. `mapHost` is NOT ours — that is exactly what lets the
// map survive the rest → work transition, which is the screen's central
// promise. The other three are: they are emptied and filled.
//
//   searchHost   the search, shared by both tabs (#222)
//   railHost     the LOCAL rail at work: area, source, name, ACQUIRE
//   liveHost     the LIVE tab: the pin and [ FLY LIVE ]
//
//   onZone(zone | null)   an area appears or disappears — the rest ↔ work signal
//   onPickArea(slug)      a click on the frame of an already acquired area
//   onRest()              BACK from the rail: the tool is put down, FIELD is NOT
//                         left. Leaving is MODE, and the Home holds that.
//   onBusy()              an acquisition is running (resumed at mount): the Home
//                         must show the rail, otherwise the job runs faceless.
//
// Returns { done, setAreaFrames, focusBounds, startDraw, setMode, rest, busy,
// destroy }. `done` resolves a FORM of flight: `{ slug }` for a baked area,
// `{ live: [lat, lon] }` for a live take-off, `undefined` to go back up.
export function runScanner({ mapHost, searchHost, railHost, liveHost, onZone = null, onPickArea = null, onRest = null, onBusy = null } = {}) {
	mapHost.classList.add('scanner-map', 'map-mono');
	searchHost.classList.add('scanner-search');
	railHost.classList.add('scanner-panel');
	liveHost.classList.add('scanner-panel');
	searchHost.innerHTML = SEARCH_PANEL;
	railHost.innerHTML = PANEL;
	liveHost.innerHTML = LIVE_PANEL;

	// Three hosts, one selector: the `sc-*` classes are unique from one host to
	// the next, so the first answer is the right one.
	const hosts = [searchHost, railHost, liveHost];
	const $ = (sel) => {
		for (const h of hosts) { const el = h.querySelector(sel); if (el) return el; }
		return null;
	};
	const panel = railHost;

	// No more RTC on the SEARCH panel since #243: it is a form, not a wait, and
	// its log block grew in the left rail beside the field and the estimate. The
	// crew speaks again at acquisition (as a toast) and on the root.
	// `stopSearch` stays a function so that watchJob() does not have to know
	// there is nothing left to stop.
	let stopSearch = () => {};

	const state = {
		zone: null,         // { bbox } or { poly } — the drawn area, raw
		describe: null,     // last /describe answer
		plan: null,         // last /plan answer
		probe: null,        // dernier verdict de sonde
		place: null,        // { class, type } Nominatim, for the signal density
		mode: 'local',      // 'local' | 'live' — l'onglet de la Home (#222)
		pin: null,          // { lat, lon } — the LIVE pin
		zoom: 20,
		source: null,       // id of the provider DESIGNATED by the operator, never guessed
		nameEdited: false,
		scenes: [],
		jobId: null,
	};

	// The provider registry, as the server declares it: the scanner invents
	// neither the ids nor the labels (issue #18). Until the answer arrives, the
	// SOURCE row is empty and the probe stays closed — better to offer no choice
	// than a choice that does not exist on the pipeline side.
	let registry = { providers: [], default: undefined };
	const provider = () => chosenSource(registry, state.source);

	// ------------------------------------------------------------ carte
	const map = L.map(mapHost, {
		zoomControl: false, attributionControl: true, worldCopyJump: true,
	}).setView(lastView.center, lastView.zoom);
	// One map in the game (Bible §4): same rule as the small map — the layer
	// credit stays, "Leaflet | " and its flag go.
	map.attributionControl.setPrefix('');
	L.control.zoom({ position: 'bottomright' }).addTo(map);
	map.on('moveend zoomend', () => { lastView = { center: map.getCenter(), zoom: map.getZoom() }; });

	let base = null;
	function setLayer(name) {
		if (base) map.removeLayer(base);
		base = L.tileLayer(LAYERS[name].url, LAYERS[name].opts).addTo(map);
		base.bringToBack();
	}

	map.pm.setLang('en');
	const lattice = L.layerGroup().addTo(map);
	const pruned = L.layerGroup().addTo(map);
	const pins = L.layerGroup().addTo(map);
	const outline = L.layerGroup().addTo(map);
	const snapped = L.rectangle([[0, 0], [0, 0]], { color: token('--warm-white'), weight: 1, fill: false, interactive: false });
	// The areas ALREADY acquired, in their real place on the live map (#211).
	// Same ink as `snapped`: what the Home shows and what the acquisition drew
	// must recognise each other (#207). Clickable, because the map and the list
	// must designate the same thing in both directions.
	const areaFrames = L.layerGroup().addTo(map);

	// The coverage (issue #245): where the drone has been, under the frames.
	// Read back from the operator cache on every redraw. Mind what that means
	// after a flight: the Home comes back to it through a full RELOAD (main.js,
	// `location.href = location.pathname`), so the client cache does not
	// survive — what is read back is what the server received. The stain is
	// there because patch()'s debounce (500 ms) is shorter than the end-of-
	// flight sequence (≥ 1.4 s before exitArmed), the same margin the session
	// record already depends on; `beforeunload → flush()` is only an unguaranteed
	// safety net (an ordinary fetch, without keepalive — which would not carry
	// 160 KB anyway). On a slow server, a PATCH cut short by the reload loses the
	// session's track: the same class of loss as sendBeacon, see HANDOFF.
	const coverage = createCoverageLayer(L, {
		colors: { core: token('--magenta') || '#e34de0', halo: token('--cyan') || '#4dd8e8' },
		planDraw,
		getCoverage: () => Coverage.fromStored(operatorApi.getOperator()?.coverage),
	}).addTo(map);

	// Draws the frame of every area in the cache. previewBounds() returns `null`
	// for an area with no known extent: it then has NO frame and stays
	// selectable from the list alone — falling back to (0, 0) would show the
	// Gulf of Guinea for a Parisian area.
	function setAreaFrames(scenes) {
		areaFrames.clearLayers();
		for (const sc of scenes ?? []) {
			const b = previewBounds(sc);
			if (!b) continue;
			L.rectangle(b, { color: token('--warm-white'), weight: 1, fill: true, fillOpacity: 0, interactive: true })
				// A frame is a LOCAL selection, even from LIVE: the click does not
				// bubble to the map, otherwise it would also drop a pin.
				.on('click', (e) => { L.DomEvent.stopPropagation(e); onPickArea?.(sc.slug); })
				.addTo(areaFrames);
		}
	}

	// Reframes without touching the drawing in progress: the Home's list uses it
	// to show the area that has just been selected.
	function focusBounds(b) { if (b) map.fitBounds(b, { padding: [24, 24] }); }
	let zoneLayer = null;

	// ------------------------------------------------ the grid actually scanned
	//
	// Below ~7px per tile the grid becomes an illegible fill: only the extent is
	// kept then. The rule is better than an arbitrary cap on the number of
	// strokes.
	function drawLattice() {
		lattice.clearLayers();
		outline.clearLayers();
		const grid = state.describe?.grid;
		if (!grid) return;
		const s = grid.snapped;

		// A free-hand outline is not reducible to its extent: the area kept is the
		// staircase of tiles the outline touches, and that is what is shown.
		// Unlike the lattice, it stays drawn at every scale — it is the only thing
		// that says what will actually be extracted.
		if (grid.keep) {
			map.removeLayer(snapped);
			outline.addLayer(L.polyline(
				maskOutline({ ...grid, keep: Uint8Array.from(grid.keep) }, state.zoom),
				{ color: token('--warm-white'), weight: 1, interactive: false }));
		} else {
			snapped.setBounds([[s.south, s.west], [s.north, s.east]]).addTo(map);
		}

		const a = map.latLngToLayerPoint([s.south, s.west]);
		const b = map.latLngToLayerPoint([s.north, s.east]);
		if (Math.abs(b.x - a.x) / grid.cols < 7) return;

		const style = { color: token('--warm-white'), weight: 1, opacity: .22, interactive: false };
		const { lons, lats } = latticeEdges(grid, state.zoom);
		for (let i = 1; i < lons.length - 1; i++) {
			lattice.addLayer(L.polyline([[s.south, lons[i]], [s.north, lons[i]]], style));
		}
		for (let j = 1; j < lats.length - 1; j++) {
			lattice.addLayer(L.polyline([[lats[j], s.west], [lats[j], s.east]], style));
		}
	}
	map.on('zoomend', drawLattice);

	// The share of the area the Flyover region declares it does not cover. Comes
	// from the real plan: the region extent is a rectangle, the pruning is an
	// intersection. Specific to Flyover: Google Earth's plan declares no region
	// extent (nothing to prune), prunedBands returns null and nothing is greyed.
	function drawPruned() {
		pruned.clearLayers();
		const p = prunedBands(state.plan);
		if (!p) return;
		for (const b of p.bands) {
			pruned.addLayer(L.rectangle([[b.south, b.west], [b.north, b.east]], {
				color: token('--orange'), weight: 0, fillColor: token('--orange'), fillOpacity: .18, interactive: false,
			}));
		}
	}

	// ------------------------------------------------------------ zone
	function setZone(layer) {
		if (zoneLayer && zoneLayer !== layer) map.removeLayer(zoneLayer);
		zoneLayer = layer;
		// The drawn outline is a ghost: what counts is the tile-aligned area — a
		// snapped rectangle, or a polygon's staircase.
		layer.setStyle({ color: token('--warm-white'), weight: 1, dashArray: '3 4', fill: false, opacity: .5 });

		// Geoman returns an L.Rectangle for the box and an L.Polygon for the free
		// outline; the rectangle IS a polygon, so the more specific one is tested
		// first.
		if (layer instanceof L.Rectangle) {
			const b = layer.getBounds();
			state.zone = { bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } };
		} else {
			const ring = [];
			for (const ll of layer.getLatLngs()[0]) ring.push(ll.lat, ll.lng);
			state.zone = { poly: ring };
		}
		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		describe();
		surveyCentre();
		// The screen goes to work: it is the Home that replaces its left column
		// with this rail. The scanner does not know the Home, it signals.
		onZone?.(state.zone);
	}

	map.on('pm:create', (e) => {
		setZone(e.layer);
		e.layer.pm.enable({ allowSelfIntersection: false });
		e.layer.on('pm:edit pm:dragend', () => setZone(e.layer));
	});
	map.on('pm:remove', clearZone);

	function clearZone() {
		if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
		state.zone = state.describe = state.plan = state.probe = null;
		lattice.clearLayers(); pruned.clearLayers(); outline.clearLayers(); map.removeLayer(snapped);
		onZone?.(null);
		$('.sc-area-hint').hidden = false;
		$('.sc-clear').hidden = true;
		$('.sc-heavy').hidden = true;
		updateDensity();
		renderCoverage();
		updateButtons();
	}

	// ------------------------------------------------------------ /describe
	let describeTimer = null;
	function describe() {
		clearTimeout(describeTimer);
		describeTimer = setTimeout(async () => {
			if (!state.zone) return;
			try {
				state.describe = await post('/describe', { ...state.zone, zoom: state.zoom, altitude: 20 });
				renderAnalysis();
			} catch (e) {
				note('.sc-heavy', `SCANNER OFFLINE — ${e.message}`, 'alarm');
			}
		}, 80);
	}

	function renderAnalysis() {
		const a = areaAnalysis(state.describe);
		if (!a) return;
		$('.sc-area-hint').hidden = true;
		$('.sc-clear').hidden = false;
		note('.sc-heavy', a.heavy ? `HEAVY AREA — ${a.dataRange} ON DISK. SHRINK IT OR DROP DETAIL.` : null, 'warn');
		drawLattice();
		updateDensity();
		// The line under ACQUIRE carries the tiles and the weight: it changes with
		// the area, not only with the probe.
		renderCoverage();
		updateButtons();
	}

	// ------------------------------------------------- signal density (§6)
	//
	// Nothing displays it any more (#222): it is computed silently, because the
	// KEEP writes it into the manifest and because a live flight's TARGET SCAN
	// depends on it. The estimate starts from what OSM says about the point
	// (Nominatim reverse), not from a draw: two readings of the same place read
	// the same figure.
	function updateDensity() {
		const areaKm2 = (state.describe?.dimensions.area ?? 0) / 1e6;
		state.lastDensity = signalDensity({ place: state.place, areaKm2 });
	}

	// Nominatim reverse on one point: one request per point, cached, never
	// hammered (the usage policy asks for 1 req/s at most). `then` receives the
	// answer, or null when the search is unavailable.
	const surveyCache = new Map();
	let surveyTimer = null;
	function survey(lat, lon, then) {
		clearTimeout(surveyTimer);
		const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
		if (surveyCache.has(key)) return then(surveyCache.get(key));
		surveyTimer = setTimeout(async () => {
			let hit = null;
			try {
				const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`, { headers: { accept: 'application/json' } });
				if (!r.ok) throw new Error(String(r.status));
				// The answer is kept as-is: it is the model that decides which
				// Nominatim field carries the information (addresstype > type >
				// category).
				hit = (await r.json()) ?? null;
				surveyCache.set(key, hit);
			} catch {
				hit = null;   // "we do not know" is passed on as-is.
			}
			then(hit);
		}, 1100);
	}

	function surveyCentre() {
		if (!state.zone) return;
		// On an L-shaped outline, the centre of the extent falls in the notch: we
		// would describe a district we are not extracting. Same rule as the
		// probe — hence zoneCentre(), shared.
		const { lat, lon } = zoneCentre(state.zone, state.zoom);
		survey(lat, lon, (hit) => { state.place = hit; updateDensity(); });
	}

	// ------------------------------------------------------------- LIVE pin
	//
	// A click on the map, in the LIVE tab, drops the pin; dragging it moves it.
	// The LIVE rail shows the place and the coordinates, and [ FLY LIVE ] opens.
	// The density is read at the same point, silently, for the flight's TARGET
	// SCAN.
	let pinLayer = null;
	function setPin(lat, lon) {
		state.pin = { lat, lon };
		if (!pinLayer) {
			pinLayer = L.marker([lat, lon], {
				draggable: true,
				icon: L.divIcon({ className: 'sc-pin sc-pin-live', html: '◎ LIVE', iconSize: null }),
			}).addTo(map);
			pinLayer.on('dragend', () => { const ll = pinLayer.getLatLng(); setPin(ll.lat, ll.lng); });
		} else pinLayer.setLatLng([lat, lon]);
		$('.sc-pin-hint').hidden = true;
		const place = $('.sc-pin-place');
		place.hidden = false;
		place.textContent = 'SURVEYING…';
		const coords = $('.sc-pin-coords');
		coords.hidden = false;
		coords.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
		$('.sc-fly-live').disabled = false;
		survey(lat, lon, (hit) => {
			state.place = hit;
			updateDensity();
			// The pin may have moved during the request: it is only written if it
			// is still the one being described.
			if (state.pin?.lat === lat && state.pin?.lon === lon) {
				place.textContent = hit ? designationFrom(hit).toUpperCase() : 'UNSURVEYED';
			}
		});
	}
	map.on('click', (e) => {
		if (state.mode !== 'live') return;
		setPin(e.latlng.lat, e.latlng.lng);
	});

	// The Home's tab. In LIVE a click drops a pin and the detail switch (which
	// only concerns extraction) withdraws from the map.
	function setMode(mode) {
		state.mode = mode;
		if (mode === 'live') map.pm.disableDraw();
		controls.detail.hidden = mode === 'live';
	}

	// ------------------------------------------------------------ coverage
	// The line under [ ACQUIRE AREA ]: tiles · weight · verdict (#222). The
	// detail only comes out once the source has spoken — before that, it would
	// only repeat "probe first".
	function renderCoverage() {
		const v = railLine({ describe: state.describe, plan: state.plan, probe: state.probe, provider: provider() });
		const el2 = $('.sc-verdict');
		el2.dataset.status = v.status;
		el2.textContent = v.text;
		$('.sc-detail').textContent = v.status === 'unprobed' ? '' : v.detail;
		updateButtons();
	}

	// Probing is no longer a button: it is the first half of [ ACQUIRE AREA ]
	// (#211). The body is unchanged — only its trigger has moved.
	async function runProbe() {
		const btn = $('.sc-acquire');
		// The source is designated, never guessed: without it there is nothing to
		// probe. The button is already closed in that case (updateButtons) — this
		// guard protects the keyboard/gamepad path.
		const src = provider();
		if (!state.zone || !src) return;

		btn.disabled = true;
		$('.sc-verdict').dataset.status = 'busy';
		$('.sc-verdict').textContent = 'PROBING';
		$('.sc-detail').textContent = `Querying ${src.label}…`;
		try {
			const { plan, ...d } = await post('/plan', { ...state.zone, zoom: state.zoom, altitude: 20, provider: src.id });
			state.describe = d; state.plan = plan; state.probe = null;
			renderAnalysis(); drawPruned(); renderCoverage();

			// PROBE_AREA no longer speaks here since #243: the probe is a result in
			// a form, not a wait, and its exchange landed in the log block that
			// weighed the rail down. The event stays in the root's mixed stream,
			// it is not lost.

			if (plan.columns === 0) return;

			$('.sc-verdict').dataset.status = 'busy';
			$('.sc-verdict').textContent = 'SAMPLING';
			$('.sc-detail').textContent = `${src.label} — downloading a photogrammetry sample at the centre…`;
			state.probe = await post('/probe', { ...state.zone, zoom: state.zoom, altitude: 20, provider: src.id });
			renderCoverage();
		} catch (e) {
			// A probe failure is not a coverage verdict: see coverageLine, which
			// tells "unreachable" apart from "nothing here".
			state.probe = { status: 'error', message: e.message };
			renderCoverage();
		} finally {
			updateButtons();
		}
	}

	// ------------------------------------------------------------ recherche
	const search = $('.sc-search');
	let searchTimer = null;

	search.addEventListener('input', () => {
		clearTimeout(searchTimer);
		const q = search.value.trim();
		if (!q) return note('.sc-search-note', null);
		if (RE_COORDS.test(q)) return note('.sc-search-note', 'ENTER — GO TO THESE COORDINATES');
		note('.sc-search-note', 'SEARCHING…');
		searchTimer = setTimeout(() => geocode(q), 1000);   // Nominatim: no hammering.
	});
	search.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		clearTimeout(searchTimer);
		const m = search.value.trim().match(RE_COORDS);
		if (m) return goTo(Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.')));
		geocode(search.value.trim());
	});
	$('.sc-find').onclick = () => {
		clearTimeout(searchTimer);
		const m = search.value.trim().match(RE_COORDS);
		if (m) return goTo(Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.')));
		geocode(search.value.trim());
	};

	async function geocode(q) {
		if (!q) return;
		try {
			const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(`Nominatim answered ${r.status}`);
			const hits = await r.json();
			if (!hits.length) return note('.sc-search-note', 'NO SUCH PLACE — COORDINATES "LAT, LON" ALSO WORK', 'warn');
			note('.sc-search-note', null);
			renderResults(hits);
		} catch (e) {
			note('.sc-search-note', `SEARCH UNAVAILABLE (${e.message}) — USE "LAT, LON"`, 'warn');
		}
	}

	function renderResults(hits) {
		const box = $('.sc-results');
		box.innerHTML = '';
		for (const h of hits) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'sc-result';
			b.textContent = h.display_name;
			b.onclick = () => {
				box.innerHTML = '';
				search.value = designationFrom(h);
				if (!state.nameEdited) { $('.sc-name').value = designationFrom(h); updateButtons(); }
				// The OSM category of the place searched serves as an immediate
				// estimate; the reverse at the centre of the area will correct it
				// once the area is drawn.
				state.place = h;
				updateDensity();
				// Nominatim returns an extent: it is used to frame, not to draw —
				// choosing the area stays an explicit gesture.
				if (h.boundingbox) {
					const [s, n, w, e] = h.boundingbox.map(Number);
					map.fitBounds([[s, w], [n, e]], { maxZoom: 16 });
				} else goTo(Number(h.lat), Number(h.lon));
			};
			box.appendChild(b);
		}
	}

	function goTo(lat, lon) {
		$('.sc-results').innerHTML = '';
		note('.sc-search-note', null);
		if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return note('.sc-search-note', 'COORDINATES OUT OF RANGE', 'warn');
		map.setView([lat, lon], 16);
	}

	// ------------------------------------------------------------ commandes
	const startDraw = (shape) => {
		if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
		map.pm.enableDraw(shape, { snappable: false, allowSelfIntersection: false });
	};
	$('.sc-draw').onclick = () => startDraw('Rectangle');
	// A free outline follows a river, an avenue, a district boundary — what a
	// rectangle can only do by taking the neighbouring blocks with it.
	$('.sc-draw-poly').onclick = () => startDraw('Polygon');
	$('.sc-clear').onclick = () => { map.pm.disableDraw(); clearZone(); };

	$('.sc-name').addEventListener('input', () => { state.nameEdited = true; updateButtons(); });

	function updateButtons() {
		const name = $('.sc-name').value.trim();
		const slug = slugify(name);
		// Probing, like acquiring, demands a designated source: there is no
		// default provider here, and inventing one would send the operator
		// looking for imagery they did not ask for.
		const src = provider();
		// One button, and acquireStep() decides its label as well as its state:
		// the probe→acquisition sequence lives in the pure model, not here
		// (#211). ACQUIRE ANYWAY is the only confirmation, there is no browser
		// modal left.
		const step = acquireStep({
			zone: state.zone, source: src, name, plan: state.plan, probe: state.probe,
		});
		const acq = $('.sc-acquire');
		acq.disabled = step.disabled;
		acq.textContent = `[ ${step.label} ]`;
		note('.sc-acquire-note', step.disabled ? step.why : null, null);
		const existing = state.scenes.find((s) => s.slug === slug);
		note('.sc-slug', slug ? (existing ? `ID ${slug} — ALREADY IN CACHE, ACQUIRING OVERWRITES IT` : `ID ${slug}`) : null, existing ? 'warn' : null);
	}

	function note(sel, msg, kind) {
		const n = $(sel);
		if (!n) return;
		n.hidden = !msg;
		n.textContent = msg ?? '';
		n.dataset.kind = kind ?? '';
	}

	// ------------------------------------------------------------ layers
	// `preselect`: the row starts on its first entry. True for the layers and
	// the detail, which have a legitimate starting state; FALSE for the source,
	// where nothing is chosen until the operator has chosen.
	function switchRow(sel, entries, { preselect = true } = {}) {
		const row = typeof sel === 'string' ? $(sel) : sel;
		row.innerHTML = '';
		entries.forEach(([label, fn], i) => {
			if (i) row.appendChild(document.createTextNode(' · '));
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = label;
			b.onclick = () => { fn(); for (const o of row.querySelectorAll('button')) o.dataset.on = String(o === b); };
			row.appendChild(b);
		});
		const first = row.querySelector('button');
		if (preselect && first) first.dataset.on = 'true';
	}
	// Changing source invalidates plan and probe: the verdict displayed belonged
	// to the previous provider, and nothing says the next one will answer the
	// same. Same gesture as the detail switch just below.
	function setSource(id) {
		state.source = id;
		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		updateButtons();
	}
	function renderSourceSwitch() {
		const choices = sourceChoices(registry);
		switchRow('.sc-source-switch', choices.map((p) => [p.label.toUpperCase(), () => setSource(p.id)]), { preselect: false });
		note('.sc-source-note', choices.length ? null : 'SCANNER OFFLINE — NO SOURCE AVAILABLE', 'alarm');
	}
	renderSourceSwitch();

	// The layers and the detail ON the map (#222), not at the bottom of the
	// rail: it is the map they change. A Leaflet control, at the top left, so
	// that it follows the map and its clicks do not pass through to it.
	const controls = { layers: document.createElement('div'), detail: document.createElement('div') };
	controls.layers.className = 'sc-switch sc-layers';
	controls.detail.className = 'sc-switch sc-detail-switch';
	const overlay = L.control({ position: 'topleft' });
	overlay.onAdd = () => {
		const box = L.DomUtil.create('div', 'sc-map-controls');
		box.append(controls.layers, controls.detail);
		L.DomEvent.disableClickPropagation(box);
		L.DomEvent.disableScrollPropagation(box);
		return box;
	};
	overlay.addTo(map);
	switchRow(controls.layers, Object.keys(LAYERS).map((k) => [k, () => setLayer(k)]));
	switchRow(controls.detail, DETAIL.map((d) => [`${d.label} ${d.side}`, () => {
		state.zoom = d.zoom;
		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		describe();
	}]));
	setLayer('MONO');

	// ------------------------------------------------------- FLIGHT HISTORY
	//
	// The one map shows what the operator has already flown (issue #160, was the
	// ENRICHED map of #25): the tracks left on the ground and the crosses where
	// a link was lost. Nothing else, nothing clickable — the mode that also put
	// captures on the map, labelled losses and opened session sheets read as
	// noise and was removed. One toggle, top right, in the corner the layer and
	// detail switches left free. OFF is byte-for-byte today's map, coverage
	// stain included, and issues no /tracks request at all: the quiet default
	// costs nothing (Bible §3).
	const historySwitch = document.createElement('div');
	historySwitch.className = 'sc-switch sc-history-switch';
	const historyBtn = document.createElement('button');
	historyBtn.type = 'button';
	historySwitch.appendChild(historyBtn);
	const historyCtl = L.control({ position: 'topright' });
	historyCtl.onAdd = () => {
		const box = L.DomUtil.create('div', 'sc-map-controls sc-history-controls');
		box.appendChild(historySwitch);
		L.DomEvent.disableClickPropagation(box);
		L.DomEvent.disableScrollPropagation(box);
		return box;
	};
	historyCtl.addTo(map);

	// The index is fetched ONCE, on first activation, and kept for the life of
	// the screen; every move only refilters it (spec §2, "Data flow").
	const history = { on: false, tracks: null, loading: false };

	const tracksLayer = createTracksLayer(L, {
		getTracks: () => history.tracks,
		ink: token('--warm-white') || '#ece7dd',
	});

	function renderHistorySwitch() {
		historyBtn.textContent = `FLIGHT HISTORY: ${history.on ? 'ON' : 'OFF'}`;
		historyBtn.dataset.on = String(history.on);
	}

	async function setHistory(on, { persist = true } = {}) {
		history.on = Boolean(on);
		renderHistorySwitch();
		if (persist) {
			// `settings` is already in OP_WRITABLE_KEYS; merged rather than replaced,
			// the key does not belong to the scanner alone.
			try {
				const op = operatorApi.getOperator();
				if (op) operatorApi.patch('settings', { ...(op.settings ?? {}), flightHistoryMap: history.on });
			} catch { /* no operator loaded: the toggle still works for this screen */ }
		}
		if (!history.on) {
			map.removeLayer(tracksLayer);
			return;
		}
		tracksLayer.addTo(map);
		if (history.tracks || history.loading) return;
		history.loading = true;
		try {
			// No bbox: the whole index once, then refiltered on move. It is a
			// decimated polyline per flight, capped at 200 flights — a few hundred
			// kB at worst, against one request per pan otherwise.
			history.tracks = await operatorApi.listTracks();
		} catch {
			// No link, no operator, no tracks yet: the toggle stays on and the map
			// simply has nothing extra to draw. Left null so a later toggle retries.
			history.tracks = null;
		} finally {
			history.loading = false;
			tracksLayer.refresh();
		}
	}

	historyBtn.onclick = () => setHistory(!history.on);
	renderHistorySwitch();
	// Restore the operator's choice. Silent: no fetch happens unless it was ON.
	// `enrichedMap` is the key this toggle carried before #160: the overlay it
	// switched on is a superset of this one, so an operator who had it ON keeps
	// their tracks rather than finding the map bare. The new key is written on
	// the first deliberate toggle.
	const settings = operatorApi.getOperator()?.settings ?? {};
	if (settings.flightHistoryMap ?? settings.enrichedMap) setHistory(true, { persist: false });

	// ------------------------------------------------------------ acquisition
	let resolveScanner;
	let finished = false;
	// The scanner resolves a FORM of flight, no longer a bare slug: since it
	// carries both verbs, it can return a baked area (`{ slug }`) or a point to
	// take off from live (`{ live: [lat, lon] }`). `undefined` = go back up.
	const done = (choice) => {
		if (finished) return;
		finished = true;
		cleanup();
		resolveScanner(choice);
	};

	// Destroys ONLY what the scanner created in the rail. The map survives: it
	// belongs to the screen, not to the working state (#211). It is only
	// unmounted by destroy(), when the Home dies.
	function cleanup() {
		// `replaceChildren()` empties the subtree but not the RTC mount's timer if
		// it is still running (BACK/Escape from the search, before any job).
		// stopSearch() is idempotent.
		stopSearch?.();
		for (const h of hosts) h.replaceChildren();
	}

	// No menuNav here (#222): the rail lives INSIDE the Home's left column, and
	// it is the Home's nav that carries Escape / B — it calls rest() when the
	// screen is at work. Text fields keep their keys (menu-nav's rule), the
	// search and the designation stay editable.
	// BACK no longer resolves anything: since #211 the scanner is not a screen
	// you leave, it is FIELD's right column. BACK puts the tool down and gives
	// the left column back to the Home; `done` now only serves a form of
	// flight.
	function rest() {
		// Never during an acquisition: closing that is done with ABORT or LEAVE,
		// an explicit gesture.
		if (state.jobId) return;
		map.pm.disableDraw();
		clearZone();
		onRest?.();
	}
	$('.sc-back').onclick = rest;

	// Flying live: a point is resolved, and that is all. Nothing is planned,
	// nothing is probed, nothing is written — the world arrives during the
	// flight. It is the same point that has just been described (zoneCentre),
	// otherwise the scanner would name one district and open another.
	$('.sc-fly-live').onclick = () => {
		if (!state.pin) return;
		// It is not only a point that is returned: `lastDensity` is the signal
		// density read at the pin (survey → updateDensity), and the flight's
		// TARGET SCAN depends on it. `place` names the session in the log —
		// "LIVE ODEON" says something that 48.8499, 2.3419 does not.
		done({
			live: [state.pin.lat, state.pin.lon],
			density: Number.isFinite(state.lastDensity?.level) ? state.lastDensity.level : null,
			place: state.place ? designationFrom(state.place) : null,
		});
	};

	// Actually starts the job. Only called by the handler below, which has
	// already obtained the right to acquire from the model.
	async function startJob() {
		const src = provider();
		if (!src) return;
		try {
			// Acquisition happens at the designated source, always explicitly: the
			// pipeline has a default, but it must never decide here.
			const { jobId } = await post('/jobs', {
				name: $('.sc-name').value.trim(),
				...state.zone, zoom: state.zoom, altitude: 20, cell: 256, quality: 85, provider: src.id,
			});
			watchJob(jobId, $('.sc-name').value.trim(), state.describe?.estimate?.tiles ?? 0);
		} catch (e) {
			note('.sc-acquire-note', e.message.toUpperCase(), 'alarm');
		}
	}

	// ONE button to probe and acquire (#211). The first press probes; if the
	// coverage is confirmed it goes straight on, without asking for a second.
	// Otherwise it stops, the verdict says why, and the button becomes ACQUIRE
	// ANYWAY — the second press IS the confirmation. This handler decides
	// nothing: acquireStep() decides, it executes.
	$('.sc-acquire').onclick = async () => {
		const ask = () => acquireStep({
			zone: state.zone, source: provider(), name: $('.sc-name').value,
			plan: state.plan, probe: state.probe,
		});
		const step = ask();
		if (step.disabled || !step.action) return;
		if (step.action === 'probe') {
			await runProbe();
			// The probe has filled state.plan / state.probe: the model is asked
			// again whether to go on. An ACQUIRE ANYWAY here means "the coverage is
			// not confirmed" — so it stops and lets the operator see the verdict
			// before committing ten minutes.
			const next = ask();
			if (next.action === 'acquire' && next.label === 'ACQUIRE AREA') await startJob();
			return;
		}
		await startJob();
	};

	// The "acquisition" view: the panel changes, the map stays. The figures
	// displayed are the pipeline's (phase, tiles, log, statistics). RF ANALYSIS
	// / TARGET SEARCH and the RTC stream are decorative (PHASE 05, Bible
	// §8/§9): they never gate ABORT/LEAVE/FLY.
	function watchJob(id, name, expected) {
		// The search panel disappears (innerHTML replaced just after): its RTC
		// mount must stop BEFORE, otherwise its timer writes into the void on a
		// detached node — exactly the leak stop() exists to avoid.
		stopSearch?.(); stopSearch = null;
		state.jobId = id;
		onBusy?.();
		panel.innerHTML = JOB_PANEL;
		panel.querySelector('.sc-job-name').textContent = name.toUpperCase();
		const log = panel.querySelector('.sc-log');

		const setBar = (sel, b) => {
			const el2 = panel.querySelector(sel);
			el2.dataset.indeterminate = b.indeterminate ? '1' : '0';
			el2.firstElementChild.style.width = `${b.ratio * 100}%`;
		};

		const t0 = Date.now();
		const tick = setInterval(() => {
			panel.querySelector('.sc-job-elapsed').textContent = elapsed(Date.now() - t0);
		}, 1000);

		let phase = 'download', hits = 0, pipeline = {};
		const renderProgress = () => {
			const p = acquisitionProgress({ phase, hits, expected });
			const bars = pipelineBars({ phase, hits, expected, pipeline });
			panel.querySelector('.sc-job-phase').textContent = phaseLabel(phase);
			panel.querySelector('.sc-job-tiles').textContent = p.text;
			setBar('.sc-bar-terrain', bars.terrain);
			setBar('.sc-bar-fetch', bars.fetch);
			setBar('.sc-bar-decode', bars.decode);
			setBar('.sc-bar-rebuild', bars.rebuild);
		};
		renderProgress();

		const renderStats = () => {
			const lines = pipelineStats(pipeline);
			if (!lines.length) return;
			panel.querySelector('.sc-job-stats').hidden = false;
			// Built with the DOM rather than as a markup string. Everything in
			// `lines` is a fixed label and a number formatted by pipelineStats(),
			// so nothing untrusted reaches here today — but this is the browser
			// origin that holds the operator bearer key (src/operator.js), and
			// "no value is interpolated into markup" is a rule that only works
			// if it has no exceptions to argue about later.
			const readout = panel.querySelector('.sc-stats-readout');
			readout.replaceChildren();
			for (const [k, v] of lines) {
				const dt = document.createElement('dt');
				dt.textContent = k;
				const dd = document.createElement('dd');
				dd.textContent = v;
				readout.append(dt, dd);
			}
		};

		const append = (line) => {
			// Stuck to the bottom only if the operator was already there.
			const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
			log.appendChild(document.createTextNode(line + '\n'));
			while (log.childNodes.length > 400) log.removeChild(log.firstChild);
			if (stuck) log.scrollTop = log.scrollHeight;
		};

		// RTC: colour, never a source of information about the real pipeline. The
		// corpus is drawn by the dialogue engine (PHASE 21) — the context is a
		// FUNCTION because `pipeline` fills in along the way and the crew must be
		// able to speak about it when it arrives.
		const stopRtc = notify({
			event: 'ACQUIRE_AREA',
			context: () => acquisitionContext({ name, tiles: expected, pipeline }),
			host: panel,
		});

		const es = new EventSource(`${API}/jobs/${id}/events`);

		// A stream that says NOTHING is indistinguishable, on screen, from a job
		// that is working: the ELAPSED clock runs on the browser side and keeps
		// going even if nothing ever arrives. That is what was reported — screen
		// frozen on "0 tiles" with the clock climbing, PIPELINE empty, and for
		// BOTH providers, so unrelated to what the extractor does.
		//
		// The cause: when the dev server restarts (vite reloads as soon as a file
		// moves), EventSource goes back to CONNECTING and retries endlessly.
		// `onerror` below only reacted to CLOSED — so to nothing at all in that
		// case.
		//
		// The job lives on the server side: failure cannot be concluded from mere
		// silence. It is SIGNALLED, without cutting anything, and cleared as soon
		// as an event arrives.
		const SILENCE_MS = 10_000;
		let heard = false;
		let silence = null;
		const armSilence = () => {
			clearTimeout(silence);
			silence = setTimeout(() => {
				note('.sc-job-note', heard
					? 'LINK INTERRUPTED — RECONNECTING. THE ACQUISITION KEEPS RUNNING.'
					: 'NO RESPONSE FROM LOCAL INSTALLATION — IS THE DEV SERVER STILL UP?', 'warn');
			}, SILENCE_MS);
		};
		const heardFrom = () => {
			heard = true;
			note('.sc-job-note', '', '');
			armSilence();
		};
		armSilence();

		es.addEventListener('open', heardFrom);
		es.addEventListener('state', (e) => {
			const d = JSON.parse(e.data);
			heardFrom();
			phase = d.phase ?? phase; hits = d.hits ?? 0; pipeline = d.pipeline ?? pipeline;
			renderProgress(); renderStats();
		});
		es.addEventListener('log', (e) => { heardFrom(); append(JSON.parse(e.data).line); });
		es.addEventListener('phase', (e) => { phase = JSON.parse(e.data).phase; renderProgress(); });
		es.addEventListener('progress', (e) => { heardFrom(); hits = JSON.parse(e.data).hits; renderProgress(); });
		es.addEventListener('stat', (e) => { pipeline = JSON.parse(e.data); renderProgress(); renderStats(); });
		es.addEventListener('done', (e) => { finish(); acquired(JSON.parse(e.data)); });
		es.addEventListener('error', (e) => finish(String(JSON.parse(e.data).message ?? '').toUpperCase(), 'alarm'));
		es.addEventListener('cancelled', () => finish('ACQUISITION ABORTED — NOTHING WAS ADDED', 'warn'));
		es.addEventListener('end', () => es.close());
		// CLOSED = the server refused (unknown job after a restart, 404):
		// definitive, so it concludes. CONNECTING = it is retrying: the silence
		// timer is left to speak for us rather than lying one way or the other.
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) {
				clearTimeout(silence);
				finish('LINK TO LOCAL INSTALLATION LOST', 'alarm');
			}
		};

		panel.querySelector('.sc-abort').onclick = async () => {
			const b = panel.querySelector('.sc-abort');
			b.disabled = true;
			try { await api(`/jobs/${id}`, { method: 'DELETE' }); }
			catch (e) { note('.sc-job-note', e.message.toUpperCase(), 'alarm'); b.disabled = false; }
		};

		// "This is not a mini-game" (Bible §8): leaving the acquisition screen
		// does not interrupt it — the job goes on server-side, and reopening the
		// scanner re-attaches to it (see the /jobs call at startup below). Only
		// THIS view's timers and SSE connection stop.
		panel.querySelector('.sc-leave').onclick = () => {
			clearInterval(tick);
			// The silence timer too, which finish() clears and this did not: it
			// writes into `.sc-job-note`, and that selector resolves against
			// whatever panel is mounted when it fires. Leaving within the ten
			// seconds and starting another acquisition had the abandoned view's
			// timer print LINK INTERRUPTED over the new, healthy job.
			clearTimeout(silence);
			stopRtc();
			es.close();
			done(undefined);
		};

		// End of the SSE stream (success, error or cancellation): stops the clock
		// and the RTC, without touching the log already displayed. `msg`/`kind`
		// stay empty on success — acquired() takes over there with KEEP/REMOVE.
		function finish(msg, kind) {
			clearInterval(tick);
			clearTimeout(silence);
			stopRtc();
			es.close();
			state.jobId = null;
			panel.querySelector('.sc-abort').hidden = true;
			panel.querySelector('.sc-leave').hidden = true;
			if (msg) {
				note('.sc-job-note', msg, kind);
				panel.querySelector('.sc-job-back').hidden = false;
				panel.querySelector('.sc-job-back').onclick = () => done(undefined);
			}
			loadScenes();
		}

		// TERRAIN ACQUIRED -> KEEP/REMOVE (PHASE 05, issue #42 "End"). The choice
		// did not exist before this phase: until then, everything that landed in
		// public/scenes/ stayed there unasked.
		function acquired(d) {
			const box = panel.querySelector('.sc-job-done');
			box.hidden = false;
			panel.querySelector('.sc-job-done-line').textContent =
				`${d.slug.toUpperCase()} — ${num(d.stats?.exported ?? 0)} TILES, ${bytes(d.bytes)} ON DISK`;

			panel.querySelector('.sc-keep').onclick = async () => {
				try {
					const dens = state.lastDensity;
					await operatorApi.keepTerrain(d.slug,
						dens && dens.known ? { signalDensity: { level: dens.level, range: dens.range } } : {});
					reveal();
				} catch (e) {
					note('.sc-keep-note', e.message.toUpperCase(), 'alarm');
				}
			};
			// No browser confirm() (§44, issue #213): the button relabels itself to
			// REMOVE TERRAIN — CONFIRM and the SECOND press is the confirmation.
			// The arming lapses if the cursor leaves.
			armConfirm(panel.querySelector('.sc-discard'), async () => {
				try {
					await api(`/scenes/${d.slug}?raw=1`, { method: 'DELETE' });
					box.querySelector('.sc-row').remove();
					panel.querySelector('.sc-job-done-line').textContent = 'TERRAIN REMOVED';
					panel.querySelector('.sc-job-back').hidden = false;
					panel.querySelector('.sc-job-back').onclick = () => done(undefined);
					loadScenes();
				} catch (e) {
					note('.sc-keep-note', e.message.toUpperCase(), 'alarm');
				}
			});

			function reveal() {
				box.querySelector('.sc-row').remove();
				const fly = panel.querySelector('.sc-fly');
				fly.hidden = false;
				fly.onclick = () => done({ slug: d.slug });
				panel.querySelector('.sc-job-back').hidden = false;
				panel.querySelector('.sc-job-back').onclick = () => done(undefined);
			}
		}
	}

	// ------------------------------------------------------------ cache local
	async function loadScenes() {
		try {
			const { scenes } = await api('/scenes');
			state.scenes = scenes;
			pins.clearLayers();
			for (const s of scenes) {
				// The markers stop an area already in the cache being re-acquired.
				pins.addLayer(L.marker([s.lat, s.lon], {
					interactive: false,
					icon: L.divIcon({ className: 'sc-pin', html: `▣ ${s.name.toUpperCase()}`, iconSize: null }),
				}));
			}
			updateButtons();
		} catch {
			note('.sc-acquire-note', 'SCANNER OFFLINE — ACQUISITION NEEDS THE LOCAL INSTALLATION', 'alarm');
		}
	}

	// ------------------------------------------------------------ startup
	clearZone();
	loadScenes();
	// The sources offered come from the server. On failure only AUTO is kept:
	// the pipeline will choose its default, exactly as before there were two
	// providers.
	api('/providers').then((r) => {
		registry = { providers: r.providers ?? [], default: r.default };
		renderSourceSwitch();
	}).catch(() => {});
	// Takes back an acquisition already in progress (reload, return to the
	// scanner while a job is running).
	api('/jobs').then(({ jobs }) => {
		const running = jobs.find((j) => j.state === 'running');
		if (running) watchJob(running.id, running.name, 0);
	}).catch(() => {});
	setTimeout(() => map.invalidateSize(), 0);
	// No search.focus(): the Home's cursor is on [ FLY ] (issue #123), and the
	// search is now attached to the rest state as well (#222).

	return {
		done: new Promise((resolve) => { resolveScanner = resolve; }),
		setAreaFrames,
		focusBounds,
		// The Home arms the tool from its left column: at rest the rail is hidden,
		// and without this nothing would let you start drawing.
		startDraw,
		setMode,
		rest,
		busy: () => !!state.jobId,
		// Redraws the stain from the operator cache (issue #245) — the Home calls
		// it when it reads the areas back, at the same time as setAreaFrames.
		refreshCoverage: () => coverage.refresh(),
		// The map dies ONLY HERE. `map.remove()` removes the listeners Leaflet put
		// on window: without it, a Home opened three times leaves three live maps
		// behind.
		destroy: () => { cleanup(); map.remove(); },
	};
}
