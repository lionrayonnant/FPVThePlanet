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
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import {
	areaAnalysis, signalDensity, coverageLine, prunedBands, acquisitionProgress,
	latticeEdges, slugify, designationFrom, phaseLabel, elapsed, bytes, num,
} from '../tools/scanner-model.mjs';

const API = '/__map-api';

// Fonds de carte. Tous passent par le même filtre monochrome (voir .scanner-map
// dans style.css) : le scanner est N&B, quelle que soit la couche. Aucune couche
// n'existe ici pour des raisons esthétiques — MONO pour lire une ville, SAT pour
// reconnaître un bâtiment avant de le survoler, TERRAIN pour le relief.
const LAYERS = {
	// OSM standard, inversé et désaturé : un plan de ville lisible, blanc sur
	// noir, sans clé d'API. (CARTO et Stamen en demandent une aujourd'hui.)
	MONO: {
		url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
		opts: { maxZoom: 19, className: 'sc-invert', attribution: '© OpenStreetMap contributors · search © Nominatim' },
	},
	SAT: {
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		opts: { maxZoom: 21, maxNativeZoom: 19, className: 'sc-gray', attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
	},
	TERRAIN: {
		url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
		opts: { maxZoom: 17, subdomains: 'abc', className: 'sc-gray', attribution: '© OpenTopoMap · © OpenStreetMap contributors' },
	},
};

const DETAIL = [
	{ zoom: 20, label: 'HIGH', side: '25 m' },
	{ zoom: 19, label: 'MED', side: '50 m' },
	{ zoom: 18, label: 'LOW', side: '100 m' },
];

const RE_COORDS = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/;

// Dernière vue du scanner, pour rouvrir là où on s'était arrêté dans la session.
let lastView = { center: [48.8582, 2.297], zoom: 13 };

const PANEL = `
<pre class="sc-title">GLOBAL SCANNER</pre>

<section class="sc-block">
	<pre class="sc-h">SEARCH LOCATION</pre>
	<div class="sc-row">
		<input class="sc-search" type="search" autocomplete="off" spellcheck="false" placeholder="TOKYO">
		<button type="button" class="sc-btn sc-find">FIND</button>
	</div>
	<div class="sc-results"></div>
	<pre class="sc-note sc-search-note" hidden></pre>
</section>

<section class="sc-block">
	<pre class="sc-h">AREA ANALYSIS</pre>
	<pre class="sc-hint">NO AREA — DRAW A RECTANGLE</pre>
	<dl class="sc-readout" hidden>
		<dt>TILES</dt><dd class="sc-tiles">—</dd>
		<dt>REQUESTS</dt><dd class="sc-requests">—</dd>
		<dt>SURFACE</dt><dd class="sc-surface">—</dd>
		<dt>EST. DATA</dt><dd class="sc-data">—</dd>
		<dt>EST. TIME</dt><dd class="sc-time">—</dd>
	</dl>
	<pre class="sc-note sc-heavy" hidden></pre>
	<div class="sc-row">
		<button type="button" class="sc-btn sc-draw">DRAW AREA</button>
		<button type="button" class="sc-btn sc-clear" hidden>CLEAR</button>
	</div>
</section>

<section class="sc-block">
	<pre class="sc-h">SIGNAL DENSITY</pre>
	<pre class="sc-density">LOW ░░░░░░░░░░ HIGH</pre>
	<dl class="sc-readout">
		<dt>LEVEL</dt><dd class="sc-level">—</dd>
		<dt>TARGETS EST.</dt><dd class="sc-targets">—</dd>
		<dt>SURVEY</dt><dd class="sc-survey">UNSURVEYED</dd>
	</dl>
</section>

<section class="sc-block">
	<pre class="sc-h">COVERAGE</pre>
	<pre class="sc-verdict" data-status="unprobed">UNPROBED</pre>
	<pre class="sc-detail"></pre>
	<button type="button" class="sc-cta sc-probe" disabled>[ PROBE AREA ]</button>
</section>

<section class="sc-block">
	<pre class="sc-h">DESIGNATION</pre>
	<input class="sc-name" type="text" autocomplete="off" spellcheck="false" placeholder="AREA NAME">
	<pre class="sc-note sc-slug" hidden></pre>
	<button type="button" class="sc-cta sc-acquire" disabled>[ ACQUIRE AREA ]</button>
	<pre class="sc-note sc-acquire-note" hidden></pre>
</section>

<section class="sc-block sc-foot">
	<div class="sc-switch sc-layers"></div>
	<div class="sc-switch sc-detail-switch"></div>
	<button type="button" class="sc-cta sc-back">[ BACK ]</button>
</section>`;

const JOB_PANEL = `
<pre class="sc-title">AREA ACQUISITION</pre>
<section class="sc-block">
	<pre class="sc-h sc-job-name">—</pre>
	<dl class="sc-readout">
		<dt>PHASE</dt><dd class="sc-job-phase">—</dd>
		<dt>TILES</dt><dd class="sc-job-tiles">—</dd>
		<dt>ELAPSED</dt><dd class="sc-job-elapsed">0 S</dd>
	</dl>
	<div class="sc-bar" data-indeterminate="1"><i></i></div>
	<pre class="sc-note sc-job-note" hidden></pre>
</section>
<section class="sc-block sc-log-block">
	<pre class="sc-h">PIPELINE</pre>
	<pre class="sc-log"></pre>
</section>
<section class="sc-block sc-foot">
	<button type="button" class="sc-cta sc-abort">[ ABORT ]</button>
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

// Résout le slug de la carte à survoler, ou undefined pour revenir au terminal.
export function runScanner(root) {
	const el = document.createElement('div');
	el.className = 'scanner';
	el.innerHTML = `<div class="scanner-map"></div><aside class="scanner-panel">${PANEL}</aside>`;
	root.appendChild(el);

	const $ = (sel) => el.querySelector(sel);
	const panel = $('.scanner-panel');

	const state = {
		box: null,          // rectangle dessiné (bbox brute)
		describe: null,     // dernière réponse /describe
		plan: null,         // dernière réponse /plan
		probe: null,        // dernier verdict de sonde
		place: null,        // { class, type } Nominatim, pour la densité de signal
		zoom: 20,
		nameEdited: false,
		scenes: [],
		jobId: null,
	};

	// ------------------------------------------------------------ carte
	const map = L.map($('.scanner-map'), {
		zoomControl: false, attributionControl: true, worldCopyJump: true,
	}).setView(lastView.center, lastView.zoom);
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
	const snapped = L.rectangle([[0, 0], [0, 0]], { color: '#6cf', weight: 1, fill: false, interactive: false });
	let zoneLayer = null;

	// ---------------------------------------------- la grille réellement scannée
	//
	// Sous ~7 px par tuile la grille devient un aplat illisible : on ne garde
	// alors que l'emprise. La règle vaut mieux qu'un plafond arbitraire sur le
	// nombre de traits.
	function drawLattice() {
		lattice.clearLayers();
		const grid = state.describe?.grid;
		if (!grid) return;
		const s = grid.snapped;
		snapped.setBounds([[s.south, s.west], [s.north, s.east]]).addTo(map);

		const a = map.latLngToLayerPoint([s.south, s.west]);
		const b = map.latLngToLayerPoint([s.north, s.east]);
		if (Math.abs(b.x - a.x) / grid.cols < 7) return;

		const style = { color: '#6cf', weight: 1, opacity: .22, interactive: false };
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
	function drawPruned() {
		pruned.clearLayers();
		const p = prunedBands(state.plan);
		if (!p) return;
		for (const b of p.bands) {
			pruned.addLayer(L.rectangle([[b.south, b.west], [b.north, b.east]], {
				color: '#f2714f', weight: 0, fillColor: '#f2714f', fillOpacity: .18, interactive: false,
			}));
		}
	}

	// ------------------------------------------------------------ zone
	function setZone(layer) {
		if (zoneLayer && zoneLayer !== layer) map.removeLayer(zoneLayer);
		zoneLayer = layer;
		// Le rectangle dessiné est un fantôme : ce qui compte, c'est la zone
		// alignée sur les tuiles.
		layer.setStyle({ color: '#eaf2f8', weight: 1, dashArray: '3 4', fill: false, opacity: .5 });
		const b = layer.getBounds();
		state.box = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		describe();
		surveyCentre();
	}

	map.on('pm:create', (e) => {
		setZone(e.layer);
		e.layer.pm.enable({ allowSelfIntersection: false });
		e.layer.on('pm:edit pm:dragend', () => setZone(e.layer));
	});
	map.on('pm:remove', clearZone);

	function clearZone() {
		if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
		state.box = state.describe = state.plan = state.probe = null;
		lattice.clearLayers(); pruned.clearLayers(); map.removeLayer(snapped);
		$('.sc-hint').hidden = false;
		$('.sc-readout').hidden = true;
		$('.sc-clear').hidden = true;
		$('.sc-heavy').hidden = true;
		renderDensity();
		renderCoverage();
		updateButtons();
	}

	// ------------------------------------------------------------ /describe
	let describeTimer = null;
	function describe() {
		clearTimeout(describeTimer);
		describeTimer = setTimeout(async () => {
			if (!state.box) return;
			try {
				state.describe = await post('/describe', { bbox: state.box, zoom: state.zoom, altitude: 20 });
				renderAnalysis();
			} catch (e) {
				note('.sc-heavy', `SCANNER OFFLINE — ${e.message}`, 'alarm');
			}
		}, 80);
	}

	function renderAnalysis() {
		const a = areaAnalysis(state.describe);
		if (!a) return;
		$('.sc-hint').hidden = true;
		$('.sc-readout').hidden = false;
		$('.sc-clear').hidden = false;
		$('.sc-tiles').textContent = a.tiles;
		$('.sc-requests').textContent = a.requests;
		$('.sc-surface').textContent = a.surface;
		$('.sc-data').textContent = a.data;
		$('.sc-time').textContent = a.time;
		note('.sc-heavy', a.heavy ? `HEAVY AREA — ${a.dataRange} ON DISK. SHRINK IT OR DROP DETAIL.` : null, 'warn');
		drawLattice();
		renderDensity();
		updateButtons();
	}

	// -------------------------------------------------- densité de signal (§6)
	//
	// L'estimation part de ce qu'OSM dit du centre de la zone, pas d'un tirage :
	// deux sondes de la même zone lisent le même chiffre. La génération de cibles
	// reste PHASE 7 — ici on n'affiche qu'une fourchette.
	function renderDensity() {
		const areaKm2 = (state.describe?.dimensions.area ?? 0) / 1e6;
		const s = signalDensity({ place: state.place, areaKm2 });
		$('.sc-density').textContent = `LOW ${s.bar} HIGH`;
		$('.sc-level').textContent = s.label;
		$('.sc-targets').textContent = s.targets;
		$('.sc-survey').textContent = s.known ? s.source.toUpperCase() : 'UNSURVEYED';
	}

	// Nominatim reverse au centre de la zone : une requête par zone, mise en
	// cache, jamais martelée (la politique d'usage demande 1 req/s au plus).
	const surveyCache = new Map();
	let surveyTimer = null;
	function surveyCentre() {
		clearTimeout(surveyTimer);
		if (!state.box) return;
		const lat = (state.box.south + state.box.north) / 2, lon = (state.box.west + state.box.east) / 2;
		const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
		if (surveyCache.has(key)) { state.place = surveyCache.get(key); return renderDensity(); }
		surveyTimer = setTimeout(async () => {
			try {
				const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`, { headers: { accept: 'application/json' } });
				if (!r.ok) throw new Error(String(r.status));
				// On garde la réponse telle quelle : c'est le modèle qui décide
				// quel champ Nominatim porte l'information (addresstype > type > category).
				const hit = await r.json();
				surveyCache.set(key, hit ?? null);
				state.place = hit ?? null;
			} catch {
				state.place = null;   // « on ne sait pas » s'affiche tel quel.
			}
			renderDensity();
		}, 1100);
	}

	// ------------------------------------------------------------ couverture
	function renderCoverage() {
		const v = coverageLine({ plan: state.plan, probe: state.probe });
		const el2 = $('.sc-verdict');
		el2.dataset.status = v.status;
		el2.textContent = v.label;
		$('.sc-detail').textContent = v.detail ?? '';
		updateButtons();
	}

	$('.sc-probe').onclick = async () => {
		const btn = $('.sc-probe');
		btn.disabled = true;
		$('.sc-verdict').dataset.status = 'busy';
		$('.sc-verdict').textContent = 'PROBING';
		$('.sc-detail').textContent = 'Querying the Flyover region…';
		try {
			const { plan, ...d } = await post('/plan', { bbox: state.box, zoom: state.zoom, altitude: 20 });
			state.describe = d; state.plan = plan; state.probe = null;
			renderAnalysis(); drawPruned(); renderCoverage();
			if (plan.columns === 0) return;

			$('.sc-verdict').dataset.status = 'busy';
			$('.sc-verdict').textContent = 'SAMPLING';
			$('.sc-detail').textContent = `Region "${plan.trigger}" — downloading a photogrammetry sample at the centre…`;
			state.probe = await post('/probe', { bbox: state.box, zoom: state.zoom, altitude: 20 });
			renderCoverage();
		} catch (e) {
			state.probe = { status: 'none', message: e.message };
			renderCoverage();
		} finally {
			btn.disabled = !state.box;
		}
	};

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
				renderDensity();
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
	$('.sc-draw').onclick = () => {
		if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
		map.pm.enableDraw('Rectangle', { snappable: false });
	};
	$('.sc-clear').onclick = () => { map.pm.disableDraw(); clearZone(); };

	$('.sc-name').addEventListener('input', () => { state.nameEdited = true; updateButtons(); });

	function updateButtons() {
		const name = $('.sc-name').value.trim();
		const slug = slugify(name);
		$('.sc-probe').disabled = !state.box;
		$('.sc-acquire').disabled = !state.box || !slug;
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
	function switchRow(sel, entries) {
		const row = $(sel);
		row.innerHTML = '';
		entries.forEach(([label, fn], i) => {
			if (i) row.appendChild(document.createTextNode(' · '));
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = label;
			b.onclick = () => { fn(); for (const o of row.querySelectorAll('button')) o.dataset.on = String(o === b); };
			row.appendChild(b);
		});
		row.querySelector('button').dataset.on = 'true';
	}
	switchRow('.sc-layers', Object.keys(LAYERS).map((k) => [k, () => setLayer(k)]));
	switchRow('.sc-detail-switch', DETAIL.map((d) => [`${d.label} ${d.side}`, () => {
		state.zoom = d.zoom;
		state.plan = null; state.probe = null;
		pruned.clearLayers();
		renderCoverage();
		describe();
	}]));
	setLayer('MONO');

	// ------------------------------------------------------------ acquisition
	let resolveScanner;
	const done = (slug) => { cleanup(); resolveScanner(slug); };

	function cleanup() {
		document.removeEventListener('keydown', onKey);
		map.remove();
		el.remove();
	}

	function onKey(e) {
		if (e.key === 'Escape' && !state.jobId) { e.preventDefault(); done(undefined); }
	}
	document.addEventListener('keydown', onKey);
	$('.sc-back').onclick = () => done(undefined);

	$('.sc-acquire').onclick = async () => {
		// La sonde n'est pas obligatoire, mais acquérir sans elle est le meilleur
		// moyen d'attendre dix minutes pour rien.
		if (state.probe?.status !== 'ok') {
			const why = state.probe || state.plan
				? coverageLine({ plan: state.plan, probe: state.probe }).detail
				: 'Flyover coverage has not been probed for this area.';
			if (!confirm(`${why}\n\nAcquire anyway?`)) return;
		}
		try {
			const { jobId } = await post('/jobs', {
				name: $('.sc-name').value.trim(),
				bbox: state.box, zoom: state.zoom, altitude: 20, cell: 256, quality: 85,
			});
			watchJob(jobId, $('.sc-name').value.trim(), state.describe?.estimate?.tiles ?? 0);
		} catch (e) {
			note('.sc-acquire-note', e.message.toUpperCase(), 'alarm');
		}
	};

	// Vue « acquisition » : le panneau change, la carte reste. Les chiffres
	// affichés sont ceux du pipeline (phase, tuiles, log) — la mise en scène
	// diégétique complète est PHASE 5.
	function watchJob(id, name, expected) {
		state.jobId = id;
		panel.innerHTML = JOB_PANEL;
		panel.querySelector('.sc-job-name').textContent = name.toUpperCase();
		const bar = panel.querySelector('.sc-bar');
		const fill = bar.firstElementChild;
		const log = panel.querySelector('.sc-log');

		const t0 = Date.now();
		const tick = setInterval(() => {
			panel.querySelector('.sc-job-elapsed').textContent = elapsed(Date.now() - t0);
		}, 1000);

		let phase = 'download', hits = 0;
		const renderProgress = () => {
			const p = acquisitionProgress({ phase, hits, expected });
			panel.querySelector('.sc-job-phase').textContent = phaseLabel(phase);
			panel.querySelector('.sc-job-tiles').textContent = p.text;
			bar.dataset.indeterminate = p.indeterminate ? '1' : '0';
			fill.style.width = `${p.ratio * 100}%`;
		};
		renderProgress();

		const append = (line) => {
			// Collé au bas seulement si l'opérateur y était déjà.
			const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
			log.appendChild(document.createTextNode(line + '\n'));
			while (log.childNodes.length > 400) log.removeChild(log.firstChild);
			if (stuck) log.scrollTop = log.scrollHeight;
		};

		const es = new EventSource(`${API}/jobs/${id}/events`);
		es.addEventListener('state', (e) => { const d = JSON.parse(e.data); phase = d.phase ?? phase; hits = d.hits ?? 0; renderProgress(); });
		es.addEventListener('log', (e) => append(JSON.parse(e.data).line));
		es.addEventListener('phase', (e) => { phase = JSON.parse(e.data).phase; renderProgress(); });
		es.addEventListener('progress', (e) => { hits = JSON.parse(e.data).hits; renderProgress(); });
		es.addEventListener('done', (e) => {
			const d = JSON.parse(e.data);
			finish(`TERRAIN READY — ${num(d.stats?.exported ?? 0)} TILES, ${bytes(d.bytes)} ON DISK`, 'ok');
			const fly = panel.querySelector('.sc-fly');
			fly.hidden = false;
			fly.onclick = () => done(d.slug);
		});
		es.addEventListener('error', (e) => finish(String(JSON.parse(e.data).message ?? '').toUpperCase(), 'alarm'));
		es.addEventListener('cancelled', () => finish('ACQUISITION ABORTED — NOTHING WAS ADDED', 'warn'));
		es.addEventListener('end', () => es.close());
		es.onerror = () => { if (es.readyState === EventSource.CLOSED) finish('LINK TO LOCAL INSTALLATION LOST', 'alarm'); };

		panel.querySelector('.sc-abort').onclick = async () => {
			const b = panel.querySelector('.sc-abort');
			b.disabled = true;
			try { await api(`/jobs/${id}`, { method: 'DELETE' }); }
			catch (e) { note('.sc-job-note', e.message.toUpperCase(), 'alarm'); b.disabled = false; }
		};

		function finish(msg, kind) {
			clearInterval(tick);
			es.close();
			state.jobId = null;
			bar.dataset.indeterminate = '0';
			fill.style.width = '100%';
			note('.sc-job-note', msg, kind);
			panel.querySelector('.sc-abort').hidden = true;
			panel.querySelector('.sc-job-back').hidden = false;
			panel.querySelector('.sc-job-back').onclick = () => done(undefined);
			loadScenes();
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
	// Reprend la main sur une acquisition déjà en cours (rechargement, retour au
	// scanner pendant qu'un job tourne).
	api('/jobs').then(({ jobs }) => {
		const running = jobs.find((j) => j.state === 'running');
		if (running) watchJob(running.id, running.name, 0);
	}).catch(() => {});
	setTimeout(() => map.invalidateSize(), 0);
	search.focus();

	return new Promise((resolve) => { resolveScanner = resolve; });
}
