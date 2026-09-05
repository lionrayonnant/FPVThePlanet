// GLOBAL SCANNER (PHASE 03, Bible §4/§6/§8). Point d'entrée mondial du jeu :
// il absorbe /add-map.html — chercher, cadrer, dessiner, sonder, acquérir, voler,
// sans quitter le terminal.
//
// Il ne parle qu'à /__map-api (tools/map-api-plugin.mjs), qui n'existe que sous
// `npm run dev` : c'est l'installation locale, et c'est assumé (D1). Chargé en
// import dynamique depuis terminal.js, donc Leaflet ne pèse rien tant que
// l'opérateur n'ouvre pas le scanner.
//
// La grille affichée est la grille réellement scannée (tools/lib/tiles.mjs,
// portage du Go) : pas de seconde représentation graphique — voir la réponse
// d'investigation sur l'issue #40.
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
import { mount, sayOnce } from './dialogue.js';
import { acquisitionContext, scanContext } from './dialogue-context.js';
import { previewBounds } from '../tools/map-preview-model.mjs';
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

// Dernière vue du scanner, pour rouvrir là où on s'était arrêté dans la session.
let lastView = { center: [48.8582, 2.297], zoom: 13 };

// La recherche vit hors du rail : elle ne fait que déplacer la carte, et elle
// sert aux deux onglets de FIELD (#222). La Home lui donne son propre hôte,
// au-dessus des onglets, pour qu'elle survive au remplacement du rail par
// JOB_PANEL.
const SEARCH_PANEL = `
<div class="sc-row">
	<input class="sc-search" type="search" autocomplete="off" spellcheck="false" placeholder="SEARCH — TOKYO, OR 48.85, 2.35">
	<button type="button" class="sc-btn sc-find">FIND</button>
</div>
<div class="sc-results"></div>
<pre class="sc-note sc-search-note" hidden></pre>`;

// Le rail LOCAL, une fois qu'on trace (#222) : la zone, la source, le nom,
// et UN bouton. Les blocs AREA ANALYSIS, SIGNAL DENSITY et COVERAGE ont
// disparu — ce qu'ils disaient d'utile tient sur la ligne sous le bouton
// (railLine), et la densité se calcule toujours, en silence, pour le KEEP et
// le TARGET SCAN.
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

<section class="sc-block sc-log-block sc-rtc-block">
	<pre class="sc-h">RTC // INTERNAL</pre>
	<pre class="sc-log sc-rtc"></pre>
</section>

<section class="sc-block sc-foot">
	<button type="button" class="sc-cta sc-back">[ BACK ]</button>
</section>`;

// L'onglet LIVE (#222) : une épingle sur la carte, et c'est tout. Rien n'est
// planifié, rien n'est sondé, rien n'est écrit — le monde arrive pendant le vol.
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
		<pre class="sc-hint">STREAMED NOW · NOTHING KEPT · NEEDS THE LINK</pre>
	</div>
</section>`;

// Une rangée de barre : label fixe + `.sc-bar` que watchJob() pilote par sélecteur.
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
		<dt>ELAPSED</dt><dd class="sc-job-elapsed">0 S</dd>
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
	<!-- Décoratif (Bible §8) : aucune de ces deux barres ne conditionne quoi que
	     ce soit — la génération de cibles réelle est PHASE 7. -->
	<div class="sc-bars">
		${barRow('sc-bar-rf', 'RF ANALYSIS')}
		${barRow('sc-bar-target', 'TARGET SEARCH')}
	</div>
</section>
<section class="sc-block sc-log-block">
	<pre class="sc-h">PIPELINE</pre>
	<pre class="sc-log"></pre>
</section>
<section class="sc-block sc-log-block sc-rtc-block">
	<pre class="sc-h">RTC // INTERNAL</pre>
	<pre class="sc-log sc-rtc"></pre>
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

// Monte le scanner dans les hôtes fournis par l'appelant, et rend une poignée.
//
// Le plein cadre a disparu (#211) : depuis que FIELD est un seul écran, c'est la
// Home qui possède les deux colonnes. `mapHost` ne nous appartient PAS — c'est
// exactement ce qui permet à la carte de survivre au passage repos → travail,
// qui est la promesse centrale de l'écran. Les trois autres, si : on les vide
// et on les remplit.
//
//   searchHost   la recherche, commune aux deux onglets (#222)
//   railHost     le rail LOCAL au travail : zone, source, nom, ACQUIRE
//   liveHost     l'onglet LIVE : l'épingle et [ FLY LIVE ]
//
//   onZone(zone | null)   une zone apparaît ou disparaît — le signal repos ↔ travail
//   onPickArea(slug)      clic sur le cadre d'une zone déjà acquise
//   onRest()              BACK depuis le rail : on repose l'outil, on ne quitte PAS
//                         FIELD. Quitter, c'est MODE, et c'est la Home qui le tient.
//   onBusy()              une acquisition tourne (reprise au montage) : la Home
//                         doit montrer le rail, sinon le job tourne sans visage.
//
// Rend { done, setAreaFrames, focusBounds, startDraw, setMode, rest, busy,
// destroy }. `done` résout une FORME de vol : `{ slug }` pour une zone cuite,
// `{ live: [lat, lon] }` pour un décollage en direct, `undefined` pour remonter.
export function runScanner({ mapHost, searchHost, railHost, liveHost, onZone = null, onPickArea = null, onRest = null, onBusy = null } = {}) {
	mapHost.classList.add('scanner-map', 'map-mono');
	searchHost.classList.add('scanner-search');
	railHost.classList.add('scanner-panel');
	liveHost.classList.add('scanner-panel');
	searchHost.innerHTML = SEARCH_PANEL;
	railHost.innerHTML = PANEL;
	liveHost.innerHTML = LIVE_PANEL;

	// Trois hôtes, un seul sélecteur : les classes `sc-*` sont uniques d'un
	// hôte à l'autre, donc la première réponse est la bonne.
	const hosts = [searchHost, railHost, liveHost];
	const $ = (sel) => {
		for (const h of hosts) { const el = h.querySelector(sel); if (el) return el; }
		return null;
	};
	const panel = railHost;

	// RTC du panneau de recherche : de la couleur, jamais une source
	// d'information sur le pipeline réel (mêmes invariants que watchJob()).
	// Ce panneau n'est monté qu'une fois — il n'est jamais réaffiché après
	// avoir été remplacé par JOB_PANEL — mais on arrête quand même le montage
	// avant ce remplacement (voir watchJob()) : c'est stop() qui existe pour
	// éviter qu'un minuteur ne survive à son nœud.
	let stopSearch = mount(panel.querySelector('.sc-rtc'), {
		event: 'AREA_SEARCH',
		context: () => scanContext({}),
	});

	const state = {
		zone: null,         // { bbox } ou { poly } — la zone dessinée, brute
		describe: null,     // dernière réponse /describe
		plan: null,         // dernière réponse /plan
		probe: null,        // dernier verdict de sonde
		place: null,        // { class, type } Nominatim, pour la densité de signal
		mode: 'local',      // 'local' | 'live' — l'onglet de la Home (#222)
		pin: null,          // { lat, lon } — l'épingle de LIVE
		zoom: 20,
		source: null,       // id du fournisseur DÉSIGNÉ par l'opérateur, jamais deviné
		nameEdited: false,
		scenes: [],
		jobId: null,
	};

	// Registre des fournisseurs, tel que le serveur le déclare : le scanner
	// n'invente ni les ids ni les libellés (issue #18). Tant que la réponse n'est
	// pas là, la rangée SOURCE est vide et la sonde reste fermée — mieux vaut
	// n'offrir aucun choix qu'un choix qui n'existe pas côté pipeline.
	let registry = { providers: [], default: undefined };
	const provider = () => chosenSource(registry, state.source);

	// ------------------------------------------------------------ carte
	const map = L.map(mapHost, {
		zoomControl: false, attributionControl: true, worldCopyJump: true,
	}).setView(lastView.center, lastView.zoom);
	// Une seule carte dans le jeu (Bible §4) : même règle que la mini-carte —
	// le crédit des couches reste, « Leaflet | » et son fanion partent.
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
	// Les zones DÉJÀ acquises, à leur vraie place sur la carte vivante (#211).
	// Même encre que `snapped` : ce que la Home montre et ce que l'acquisition
	// avait dessiné doivent se reconnaître (#207). Cliquables, parce que la
	// carte et la liste doivent désigner la même chose dans les deux sens.
	const areaFrames = L.layerGroup().addTo(map);

	// Dessine le cadre de chaque zone du cache. previewBounds() rend `null` pour
	// une zone sans emprise connue : elle n'a alors PAS de cadre et reste
	// sélectionnable par la liste seule — un repli sur (0, 0) montrerait le
	// golfe de Guinée pour une zone parisienne.
	function setAreaFrames(scenes) {
		areaFrames.clearLayers();
		for (const sc of scenes ?? []) {
			const b = previewBounds(sc);
			if (!b) continue;
			L.rectangle(b, { color: token('--warm-white'), weight: 1, fill: true, fillOpacity: 0, interactive: true })
				// Un cadre est une sélection LOCAL, même depuis LIVE : le clic ne
				// remonte pas jusqu'à la carte, sinon il poserait aussi une épingle.
				.on('click', (e) => { L.DomEvent.stopPropagation(e); onPickArea?.(sc.slug); })
				.addTo(areaFrames);
		}
	}

	// Recadre sans toucher au tracé en cours : la liste de la Home s'en sert
	// pour montrer la zone qu'on vient de sélectionner.
	function focusBounds(b) { if (b) map.fitBounds(b, { padding: [24, 24] }); }
	let zoneLayer = null;

	// ---------------------------------------------- la grille réellement scannée
	//
	// Sous ~7 px par tuile la grille devient un aplat illisible : on ne garde
	// alors que l'emprise. La règle vaut mieux qu'un plafond arbitraire sur le
	// nombre de traits.
	function drawLattice() {
		lattice.clearLayers();
		outline.clearLayers();
		const grid = state.describe?.grid;
		if (!grid) return;
		const s = grid.snapped;

		// Un tracé libre ne se résume pas à son emprise : la zone retenue est
		// l'escalier des tuiles que le tracé touche, et c'est lui qu'on montre.
		// Contrairement au treillis, il reste dessiné à toute échelle — c'est la
		// seule chose qui dise ce qui sera réellement extrait.
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

	// Part de la zone que la région Flyover déclare ne pas couvrir. Vient du plan
	// réel : l'emprise de région est un rectangle, l'élagage est une intersection.
	// Propre à Flyover : le plan de Google Earth ne déclare pas d'emprise de
	// région (rien à élaguer), prunedBands rend null et rien n'est grisé.
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
		// Le tracé dessiné est un fantôme : ce qui compte, c'est la zone alignée
		// sur les tuiles — un rectangle snappé, ou l'escalier d'un polygone.
		layer.setStyle({ color: token('--warm-white'), weight: 1, dashArray: '3 4', fill: false, opacity: .5 });

		// Geoman rend un L.Rectangle pour la boîte et un L.Polygon pour le tracé
		// libre ; le rectangle EST un polygone, donc on teste le plus spécifique
		// d'abord.
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
		// L'écran passe au travail : c'est la Home qui remplace sa colonne
		// gauche par ce rail. Le scanner ne connaît pas la Home, il signale.
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
		// La ligne sous ACQUIRE porte les tuiles et le poids : elle change avec
		// la zone, pas seulement avec la sonde.
		renderCoverage();
		updateButtons();
	}

	// -------------------------------------------------- densité de signal (§6)
	//
	// Plus rien ne l'affiche (#222) : elle se calcule en silence, parce que le
	// KEEP l'écrit dans le manifeste et que le TARGET SCAN d'un vol en direct
	// en dépend. L'estimation part de ce qu'OSM dit du point (Nominatim
	// reverse), pas d'un tirage : deux relevés du même endroit lisent le même
	// chiffre.
	function updateDensity() {
		const areaKm2 = (state.describe?.dimensions.area ?? 0) / 1e6;
		state.lastDensity = signalDensity({ place: state.place, areaKm2 });
	}

	// Nominatim reverse en un point : une requête par point, mise en cache,
	// jamais martelée (la politique d'usage demande 1 req/s au plus). `then`
	// reçoit la réponse, ou null quand la recherche est indisponible.
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
				// On garde la réponse telle quelle : c'est le modèle qui décide
				// quel champ Nominatim porte l'information (addresstype > type > category).
				hit = (await r.json()) ?? null;
				surveyCache.set(key, hit);
			} catch {
				hit = null;   // « on ne sait pas » se transmet tel quel.
			}
			then(hit);
		}, 1100);
	}

	function surveyCentre() {
		if (!state.zone) return;
		// Sur un tracé en L, le centre de l'emprise tombe dans l'encoche : on
		// décrirait un quartier qu'on n'extrait pas. Même règle que la sonde —
		// d'où zoneCentre(), partagé.
		const { lat, lon } = zoneCentre(state.zone, state.zoom);
		survey(lat, lon, (hit) => { state.place = hit; updateDensity(); });
	}

	// ------------------------------------------------------------ épingle LIVE
	//
	// Un clic sur la carte, dans l'onglet LIVE, pose l'épingle ; la glisser la
	// déplace. Le rail LIVE montre le lieu et les coordonnées, et [ FLY LIVE ]
	// s'ouvre. La densité se relève au même point, en silence, pour le TARGET
	// SCAN du vol.
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
			// L'épingle a pu bouger pendant la requête : on n'écrit que si c'est
			// encore elle qu'on décrit.
			if (state.pin?.lat === lat && state.pin?.lon === lon) {
				place.textContent = hit ? designationFrom(hit).toUpperCase() : 'UNSURVEYED';
			}
		});
	}
	map.on('click', (e) => {
		if (state.mode !== 'live') return;
		setPin(e.latlng.lat, e.latlng.lng);
	});

	// L'onglet de la Home. En LIVE le clic pose une épingle et le commutateur de
	// détail (qui ne concerne que l'extraction) se retire de la carte.
	function setMode(mode) {
		state.mode = mode;
		if (mode === 'live') map.pm.disableDraw();
		controls.detail.hidden = mode === 'live';
	}

	// ------------------------------------------------------------ couverture
	// La ligne sous [ ACQUIRE AREA ] : tuiles · poids · verdict (#222). Le
	// détail ne sort que quand la source a parlé — avant, il ne ferait que
	// répéter « sondez d'abord ».
	function renderCoverage() {
		const v = railLine({ describe: state.describe, plan: state.plan, probe: state.probe, provider: provider() });
		const el2 = $('.sc-verdict');
		el2.dataset.status = v.status;
		el2.textContent = v.text;
		$('.sc-detail').textContent = v.status === 'unprobed' ? '' : v.detail;
		updateButtons();
	}

	// Sonder n'est plus un bouton : c'est la première moitié de [ ACQUIRE AREA ]
	// (#211). Le corps est inchangé — seul son déclencheur a bougé.
	async function runProbe() {
		const btn = $('.sc-acquire');
		// La source est désignée, jamais devinée : sans elle, il n'y a rien à
		// sonder. Le bouton est déjà fermé dans ce cas (updateButtons) — cette
		// garde protège le chemin clavier/manette.
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

			// Un seul échange, jamais un blocage : la sonde continue sans attendre
			// le crew (pas d'await sur ce chemin d'interaction, PHASE 05).
			sayOnce('PROBE_AREA', acquisitionContext({ name: $('.sc-name').value.trim(), tiles: state.describe?.estimate?.tiles }))
				.then((lines) => {
					const rtcEl = $('.sc-rtc');
					if (!lines || !rtcEl) return;
					for (const l of lines) rtcEl.appendChild(document.createTextNode(`\n> ${l.speaker}\n${l.text}\n`));
					rtcEl.scrollTop = rtcEl.scrollHeight;
				});

			if (plan.columns === 0) return;

			$('.sc-verdict').dataset.status = 'busy';
			$('.sc-verdict').textContent = 'SAMPLING';
			$('.sc-detail').textContent = `${src.label} — downloading a photogrammetry sample at the centre…`;
			state.probe = await post('/probe', { ...state.zone, zoom: state.zoom, altitude: 20, provider: src.id });
			renderCoverage();
		} catch (e) {
			// Un échec de la sonde n'est pas un verdict de couverture : voir
			// coverageLine, qui distingue « injoignable » de « rien ici ».
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
		searchTimer = setTimeout(() => geocode(q), 1000);   // Nominatim : pas de martèlement.
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
				// La catégorie OSM du lieu cherché sert d'estimation immédiate ;
				// le reverse au centre de la zone la corrigera quand elle sera dessinée.
				state.place = h;
				updateDensity();
				// Nominatim rend une emprise : on s'en sert pour cadrer, pas pour
				// dessiner — le choix de la zone reste un geste explicite.
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
	// Le tracé libre suit un fleuve, une avenue, un contour de quartier — ce
	// qu'un rectangle ne sait faire qu'en embarquant les blocs voisins.
	$('.sc-draw-poly').onclick = () => startDraw('Polygon');
	$('.sc-clear').onclick = () => { map.pm.disableDraw(); clearZone(); };

	$('.sc-name').addEventListener('input', () => { state.nameEdited = true; updateButtons(); });

	function updateButtons() {
		const name = $('.sc-name').value.trim();
		const slug = slugify(name);
		// Sonder comme acquérir demandent une source désignée : il n'y a pas de
		// fournisseur par défaut ici, et en inventer un enverrait l'opérateur
		// chercher une imagerie qu'il n'a pas demandée.
		const src = provider();
		// Un seul bouton, et c'est acquireStep() qui décide de son libellé comme
		// de son état : la séquence sonde→acquisition vit dans le modèle pur, pas
		// ici (#211). ACQUIRE ANYWAY est la seule confirmation, il n'y a plus de
		// modale de navigateur.
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

	// ------------------------------------------------------------ couches
	// `preselect` : la rangée démarre sur sa première entrée. Vrai pour les
	// couches et le détail, qui ont un état de départ légitime ; FAUX pour la
	// source, où rien n'est choisi tant que l'opérateur n'a pas choisi.
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
	// Changer de source invalide plan et sonde : le verdict affiché appartenait
	// au fournisseur précédent, et rien ne dit que le suivant répondra pareil.
	// Même geste que le commutateur de détail juste en dessous.
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

	// Les couches et le détail SUR la carte (#222), pas au fond du rail : c'est
	// la carte qu'ils changent. Un contrôle Leaflet, en haut à gauche, pour
	// qu'il suive la carte et que ses clics ne traversent pas jusqu'à elle.
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

	// ------------------------------------------------------------ acquisition
	let resolveScanner;
	let finished = false;
	// Le scanner résout une FORME de vol, plus un slug nu : depuis qu'il porte
	// les deux verbes, il peut rendre une zone cuite (`{ slug }`) ou un point où
	// décoller en direct (`{ live: [lat, lon] }`). `undefined` = on remonte.
	const done = (choice) => {
		if (finished) return;
		finished = true;
		cleanup();
		resolveScanner(choice);
	};

	// Ne détruit QUE ce que le scanner a créé dans le rail. La carte survit :
	// elle appartient à l'écran, pas à l'état de travail (#211). Elle ne se
	// démonte que par destroy(), quand la Home meurt.
	function cleanup() {
		// `replaceChildren()` vide le sous-arbre mais pas le minuteur du montage
		// RTC s'il tourne encore (BACK/Échap depuis la recherche, avant tout
		// job). stopSearch() est idempotent.
		stopSearch?.();
		for (const h of hosts) h.replaceChildren();
	}

	// Pas de menuNav ici (#222) : le rail vit DANS la colonne gauche de la Home,
	// et c'est le nav de la Home qui porte Échap / B — il appelle rest() quand
	// l'écran est au travail. Les champs de saisie gardent leurs touches (règle
	// de menu-nav), la recherche et la désignation restent éditables.
	// BACK ne résout plus rien : depuis #211 le scanner n'est pas un écran qu'on
	// quitte, c'est la colonne de droite de FIELD. BACK repose l'outil et rend
	// la colonne gauche à la Home ; `done` ne sert plus qu'à une forme de vol.
	function rest() {
		// Jamais pendant une acquisition : la fermer se fait par ABORT ou LEAVE,
		// un geste explicite.
		if (state.jobId) return;
		map.pm.disableDraw();
		clearZone();
		onRest?.();
	}
	$('.sc-back').onclick = rest;

	// Voler en direct : on résout un point, et c'est tout. Rien n'est planifié,
	// rien n'est sondé, rien n'est écrit — le monde arrive pendant le vol.
	// C'est le même point que celui qu'on vient de décrire (zoneCentre), sinon
	// le scanner désignerait un quartier et en ouvrirait un autre.
	$('.sc-fly-live').onclick = () => {
		if (!state.pin) return;
		// On ne rend pas seulement un point : `lastDensity` est la densité de
		// signal relevée à l'épingle (survey → updateDensity), et le TARGET SCAN
		// du vol en dépend. `place` nomme la session au journal — « LIVE ODEON »
		// dit quelque chose que 48.8499, 2.3419 ne dit pas.
		done({
			live: [state.pin.lat, state.pin.lon],
			density: Number.isFinite(state.lastDensity?.level) ? state.lastDensity.level : null,
			place: state.place ? designationFrom(state.place) : null,
		});
	};

	// Lance réellement le job. N'est appelée que par le gestionnaire ci-dessous,
	// qui a déjà obtenu du modèle le droit d'acquérir.
	async function startJob() {
		const src = provider();
		if (!src) return;
		try {
			// On acquiert chez la source désignée, toujours explicitement : le
			// pipeline a un défaut, mais il ne doit jamais décider ici.
			const { jobId } = await post('/jobs', {
				name: $('.sc-name').value.trim(),
				...state.zone, zoom: state.zoom, altitude: 20, cell: 256, quality: 85, provider: src.id,
			});
			watchJob(jobId, $('.sc-name').value.trim(), state.describe?.estimate?.tiles ?? 0);
		} catch (e) {
			note('.sc-acquire-note', e.message.toUpperCase(), 'alarm');
		}
	}

	// UN bouton pour sonder et acquérir (#211). La première pression sonde ; si
	// la couverture est confirmée elle enchaîne, sans en demander une seconde.
	// Sinon elle s'arrête, le verdict dit pourquoi, et le bouton devient
	// ACQUIRE ANYWAY — la deuxième pression EST la confirmation. Ce gestionnaire
	// ne décide de rien : acquireStep() décide, il exécute.
	$('.sc-acquire').onclick = async () => {
		const ask = () => acquireStep({
			zone: state.zone, source: provider(), name: $('.sc-name').value,
			plan: state.plan, probe: state.probe,
		});
		const step = ask();
		if (step.disabled || !step.action) return;
		if (step.action === 'probe') {
			await runProbe();
			// La sonde a rempli state.plan / state.probe : on redemande au modèle
			// s'il faut enchaîner. Un ACQUIRE ANYWAY ici veut dire « la couverture
			// n'est pas confirmée » — on s'arrête et on laisse l'opérateur voir le
			// verdict avant d'engager dix minutes.
			const next = ask();
			if (next.action === 'acquire' && next.label === 'ACQUIRE AREA') await startJob();
			return;
		}
		await startJob();
	};

	// Vue « acquisition » : le panneau change, la carte reste. Les chiffres
	// affichés sont ceux du pipeline (phase, tuiles, log, statistiques). RF
	// ANALYSIS / TARGET SEARCH et le flux RTC sont décoratifs (PHASE 05, Bible
	// §8/§9) : ils ne conditionnent jamais ABORT/LEAVE/FLY.
	function watchJob(id, name, expected) {
		// Le panneau de recherche disparaît (innerHTML remplacé juste après) :
		// son montage RTC doit s'arrêter AVANT, sinon son minuteur écrit dans le
		// vide sur un nœud détaché — exactement la fuite que stop() existe pour
		// éviter.
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
			panel.querySelector('.sc-stats-readout').innerHTML =
				lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
		};

		const append = (line) => {
			// Collé au bas seulement si l'opérateur y était déjà.
			const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
			log.appendChild(document.createTextNode(line + '\n'));
			while (log.childNodes.length > 400) log.removeChild(log.firstChild);
			if (stuck) log.scrollTop = log.scrollHeight;
		};

		// RTC : de la couleur, jamais une source d'information sur le pipeline
		// réel. Le corpus est tiré par le moteur de dialogue (PHASE 21) — le
		// contexte est une FONCTION parce que `pipeline` se remplit en cours de
		// route et que le crew doit pouvoir en parler quand il arrive.
		const stopRtc = mount(panel.querySelector('.sc-rtc'), {
			event: 'ACQUIRE_AREA',
			context: () => acquisitionContext({ name, tiles: expected, pipeline }),
		});

		const es = new EventSource(`${API}/jobs/${id}/events`);

		// Un flux qui ne dit RIEN est indistinguable, à l'écran, d'un job qui
		// travaille : le chrono ELAPSED tourne côté navigateur et continue même
		// si rien n'arrive jamais. C'est ce qui a été signalé — écran figé sur
		// « 0 tuile » avec le chrono qui monte, PIPELINE vide, et pour les DEUX
		// fournisseurs, donc sans rapport avec ce que fait l'extracteur.
		//
		// La cause : quand le serveur de dev redémarre (vite recharge dès qu'un
		// fichier bouge), EventSource repasse en CONNECTING et réessaie sans
		// fin. `onerror` plus bas ne réagissait qu'à CLOSED — donc à rien du
		// tout dans ce cas.
		//
		// Le job vit côté serveur : on ne peut pas conclure à l'échec sur un
		// simple silence. On le SIGNALE, sans rien couper, et on l'efface dès
		// qu'un événement arrive.
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
		// CLOSED = le serveur a refusé (job inconnu apres un redemarrage, 404) :
		// definitif, on conclut. CONNECTING = il reessaie : on laisse le
		// minuteur de silence parler a notre place plutot que de mentir dans un
		// sens ou dans l'autre.
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

		// « Ce n'est pas un mini-jeu » (Bible §8) : quitter l'écran d'acquisition
		// ne l'interrompt pas — le job continue côté serveur, et rouvrir le
		// scanner s'y rattache (voir l'appel à /jobs au démarrage plus bas). Seuls
		// les minuteurs et la connexion SSE de CETTE vue s'arrêtent.
		panel.querySelector('.sc-leave').onclick = () => {
			clearInterval(tick);
			stopRtc();
			es.close();
			done(undefined);
		};

		// Fin du flux SSE (succès, erreur ou annulation) : coupe le chrono et le
		// RTC, sans toucher au log déjà affiché. `msg`/`kind` restent vides sur
		// un succès — c'est acquired() qui prend le relais avec KEEP/REMOVE.
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

		// TERRAIN ACQUIRED -> KEEP/REMOVE (PHASE 05, issue #42 « Fin »). Le choix
		// n'existait pas avant cette phase : jusqu'ici, tout ce qui atterrissait
		// dans public/scenes/ y restait sans qu'on le demande.
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
			// Pas de confirm() de navigateur (§44, issue #213) : le bouton se
			// réétiquette en REMOVE TERRAIN — CONFIRM et la DEUXIÈME pression
			// est la confirmation. L'armement retombe si le curseur s'en va.
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
				// Les repères évitent de ré-acquérir une zone déjà en cache.
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

	// ------------------------------------------------------------ démarrage
	clearZone();
	loadScenes();
	// Les sources proposées viennent du serveur. En cas d'échec on garde AUTO
	// seul : le pipeline choisira son défaut, exactement comme avant qu'il y ait
	// deux fournisseurs.
	api('/providers').then((r) => {
		registry = { providers: r.providers ?? [], default: r.default };
		renderSourceSwitch();
	}).catch(() => {});
	// Reprend la main sur une acquisition déjà en cours (rechargement, retour au
	// scanner pendant qu'un job tourne).
	api('/jobs').then(({ jobs }) => {
		const running = jobs.find((j) => j.state === 'running');
		if (running) watchJob(running.id, running.name, 0);
	}).catch(() => {});
	setTimeout(() => map.invalidateSize(), 0);
	// Pas de search.focus() : le curseur de la Home est sur [ FLY ] (issue
	// #123), et la recherche est désormais attachée au repos aussi (#222).

	return {
		done: new Promise((resolve) => { resolveScanner = resolve; }),
		setAreaFrames,
		focusBounds,
		// La Home arme l'outil depuis sa colonne gauche : au repos, le rail est
		// caché, et sans ça rien ne permettrait de commencer à tracer.
		startDraw,
		setMode,
		rest,
		busy: () => !!state.jobId,
		// La carte ne meurt QU'ICI. `map.remove()` retire les écouteurs que
		// Leaflet a posés sur window : sans lui, une Home ouverte trois fois
		// laisse trois cartes vivantes derrière elle.
		destroy: () => { cleanup(); map.remove(); },
	};
}
