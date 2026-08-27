// GUI d'ajout de cartes. Elle ne parle qu'à /__map-api (tools/map-api-plugin.mjs),
// qui n'existe que sous `npm run dev`.
//
// Le parti pris : l'objet manipulé est la ZONE, pas un couple de coordonnées. On
// dessine un rectangle, et tout le reste — colonnes, poids, durée, couverture —
// en découle. Les coordonnées ne sont qu'une lecture parmi d'autres.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

const API = '/__map-api';
const $ = (id) => document.getElementById(id);

const state = {
	box: null,        // le rectangle dessiné
	describe: null,   // dernière réponse /describe
	coverage: null,   // dernier verdict de couverture
	zoom: 20,
	jobId: null,
	nameEdited: false,
};

// ---------------------------------------------------------------- carte

const map = L.map('map', { zoomControl: true, attributionControl: true })
	.setView([48.8582, 2.297], 15);

// Esri World Imagery : satellite gratuit et sans clé. L'attribution est une
// condition d'usage, pas une décoration — elle reste visible.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
	maxZoom: 21, maxNativeZoom: 19,
	attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics — recherche © OpenStreetMap/Nominatim',
}).addTo(map);

map.pm.addControls({
	position: 'topleft',
	drawMarker: false, drawCircle: false, drawCircleMarker: false,
	drawPolyline: false, drawPolygon: false, drawText: false,
	cutPolygon: false, rotateMode: false, dragMode: true,
	drawRectangle: true, editMode: true, removalMode: true,
});
map.pm.setLang('fr');

let zoneLayer = null;
const lattice = L.layerGroup().addTo(map);   // le treillis de tuiles
const snapped = L.rectangle([[0, 0], [0, 0]], {
	color: '#6cf', weight: 1, fill: false, dashArray: null, interactive: false,
});
const pins = L.layerGroup().addTo(map);
let dimLabel = null;

function setZone(layer) {
	if (zoneLayer && zoneLayer !== layer) map.removeLayer(zoneLayer);
	zoneLayer = layer;
	// Le rectangle dessiné est un fantôme : ce qui compte, et ce qu'on remplit,
	// c'est la zone alignée sur les tuiles.
	layer.setStyle({ color: '#eaf2f8', weight: 1, dashArray: '3 4', fill: false, opacity: .5 });
	const b = layer.getBounds();
	state.box = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
	state.coverage = null;
	renderVerdict({ status: 'pending', message: 'Zone modifiée — vérifie la couverture avant de lancer.' });
	describe();
}

map.on('pm:create', (e) => {
	setZone(e.layer);
	e.layer.on('pm:edit pm:dragend', () => setZone(e.layer));
});
map.on('pm:remove', clearZone);

function clearZone() {
	if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
	state.box = null; state.describe = null; state.coverage = null;
	lattice.clearLayers();
	map.removeLayer(snapped);
	if (dimLabel) { map.removeLayer(dimLabel); dimLabel = null; }
	for (const b of ['b-zone', 'b-grid', 'b-cost']) $(b).dataset.empty = '1';
	$('clear').hidden = true;
	setText({ 'z-area': '—', 'z-dims': '—', 'z-sw': '—', 'z-ne': '—', 'g-cols': '—', 'g-tile': '—', 'g-probes': '—', 'c-tiles': '—', 'c-raw': '—', 'c-prep': '—', 'c-time': '—' });
	$('cost-note').hidden = true;
	renderVerdict({ status: 'pending', message: 'Dessine une zone pour commencer.' });
	updateButtons();
}

// ------------------------------------------------- le treillis de tuiles
//
// L'élément signature. Flyover est servi en tuiles d'environ 25 m de côté : la
// zone réellement extraite est la zone dessinée arrondie au treillis. Le montrer
// transforme « 697 colonnes » en quelque chose qu'on voit, et explique d'un coup
// d'œil pourquoi un rectangle un peu plus grand coûte une rangée de plus.

function drawLattice(grid) {
	lattice.clearLayers();
	if (!grid) return;

	const s = grid.snapped;
	snapped.setBounds([[s.south, s.west], [s.north, s.east]]).addTo(map);

	// Sous ~7 px la grille devient un aplat illisible : on ne dessine alors que
	// l'emprise. La règle vaut mieux qu'un plafond arbitraire sur le nombre de traits.
	const a = map.latLngToLayerPoint([s.south, s.west]);
	const b = map.latLngToLayerPoint([s.north, s.east]);
	const px = Math.abs(b.x - a.x) / grid.cols;
	if (px < 7) return;

	const style = { color: '#6cf', weight: 1, opacity: .22, interactive: false };
	for (let i = 1; i < grid.cols; i++) {
		const lon = s.west + ((s.east - s.west) * i) / grid.cols;
		lattice.addLayer(L.polyline([[s.south, lon], [s.north, lon]], style));
	}
	for (let j = 1; j < grid.rows; j++) {
		// Les rangées ne sont pas équidistantes en latitude (Mercator) ; sur un
		// kilomètre l'écart est négligeable, l'interpolation linéaire suffit.
		const lat = s.south + ((s.north - s.south) * j) / grid.rows;
		lattice.addLayer(L.polyline([[lat, s.west], [lat, s.east]], style));
	}
}

map.on('zoomend', () => drawLattice(state.describe?.grid));

// ---------------------------------------------------------------- appels

async function api(path, opts) {
	const res = await fetch(API + path, {
		...opts,
		headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
	});
	const body = await res.json().catch(() => ({ error: `réponse illisible (${res.status})` }));
	if (!res.ok) throw new Error(body.error ?? `erreur ${res.status}`);
	return body;
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b) });

let describeTimer = null;
function describe() {
	clearTimeout(describeTimer);
	describeTimer = setTimeout(async () => {
		if (!state.box) return;
		try {
			const d = await post('/describe', { bbox: state.box, zoom: state.zoom, altitude: Number($('altitude').value) || 20 });
			state.describe = d;
			renderZone(d);
		} catch (e) {
			note('cost-note', e.message, 'alarm');
		}
	}, 80);
}

// ---------------------------------------------------------------- rendu

function setText(map_) { for (const [id, v] of Object.entries(map_)) $(id).textContent = v; }
function note(id, msg, kind) {
	const el = $(id);
	el.hidden = !msg;
	el.textContent = msg ?? '';
	el.className = 'note' + (kind ? ' ' + kind : '');
}
const nf = new Intl.NumberFormat('fr-FR');
const fmtBytes = (n) => {
	const u = ['o', 'ko', 'Mo', 'Go', 'To'];
	let i = 0, v = n;
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
	return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};
const fmtDur = (s) => s < 45 ? '< 1 min' : s < 3600 ? `~${Math.round(s / 60)} min`
	: `~${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const deg = (v) => v.toFixed(5);

function renderZone(d) {
	for (const b of ['b-zone', 'b-grid', 'b-cost']) $(b).dataset.empty = '0';
	$('clear').hidden = false;
	$('zone-hint').textContent = '';

	const { dimensions: dim, grid, estimate: e, tileMeters } = d;
	setText({
		'z-area': (dim.area / 1e6).toFixed(2),
		'z-dims': `${nf.format(Math.round(dim.width))} × ${nf.format(Math.round(dim.height))} m`,
		'z-sw': `${deg(grid.snapped.south)}, ${deg(grid.snapped.west)}`,
		'z-ne': `${deg(grid.snapped.north)}, ${deg(grid.snapped.east)}`,
		'g-cols': `${grid.cols} × ${grid.rows} = ${nf.format(grid.columns)}`,
		'g-tile': `${tileMeters.toFixed(1)} m`,
		'g-probes': nf.format(e.probes),
		'c-time': fmtDur(e.totalSeconds),
	});

	// Les fourchettes ne sont pas de la coquetterie : entre un lotissement et
	// Manhattan le même nombre de colonnes rend du simple au quadruple de données.
	// Annoncer un chiffre unique serait faux.
	range('c-tiles', nf.format(e.tiles), `${nf.format(e.tilesRange[0])} – ${nf.format(e.tilesRange[1])}`);
	range('c-raw', fmtBytes(e.rawBytes), `${fmtBytes(e.rawBytesRange[0])} – ${fmtBytes(e.rawBytesRange[1])}`);
	range('c-prep', fmtBytes(e.prepBytes), `${fmtBytes(e.prepBytesRange[0])} – ${fmtBytes(e.prepBytesRange[1])}`);

	note('cost-note', e.warn
		? `Zone très large : ~${nf.format(e.tiles)} tuiles. Réduis-la, ou passe en détail moyen si tu veux surtout de la surface.`
		: null, 'warn');

	drawLattice(grid);

	if (dimLabel) map.removeLayer(dimLabel);
	dimLabel = L.marker([grid.snapped.north, (grid.snapped.west + grid.snapped.east) / 2], {
		interactive: false,
		icon: L.divIcon({ className: 'dim-label', html: `${nf.format(Math.round(dim.width))} × ${nf.format(Math.round(dim.height))} m · ${nf.format(grid.columns)} col.`, iconSize: null }),
	}).addTo(map);

	updateButtons();
}

function range(id, main, sub) {
	$(id).innerHTML = '';
	$(id).append(main, Object.assign(document.createElement('span'), { className: 'range', textContent: sub }));
}

function renderVerdict(v) {
	state.coverage = v.status === 'pending' ? null : v;
	const el = $('verdict');
	el.dataset.status = v.status;
	el.textContent = v.message;
	updateButtons();
}

function updateButtons() {
	const hasBox = !!state.box;
	$('check').disabled = !hasBox;
	$('launch').disabled = !hasBox || !$('name').value.trim();
	const slug = slugify($('name').value);
	const existing = state.scenes?.find((s) => s.slug === slug);
	note('slug-note', slug
		? existing
			? `Identifiant « ${slug} » — déjà pris : lancer remplacera la carte existante.`
			: `Identifiant : ${slug}`
		: null, existing ? 'warn' : null);
}

// Doit rester en phase avec slugify() de lib/add-map-core.mjs : c'est cet
// identifiant que la GUI annonce avant de lancer.
const LIGATURES = { œ: 'oe', Œ: 'oe', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o', ß: 'ss', đ: 'd', ł: 'l', Ł: 'l', ð: 'd', þ: 'th' };
function slugify(n) {
	return n.replace(/[œŒæÆøØßđłŁðþ]/g, (c) => LIGATURES[c])
		.normalize('NFD').replace(/[̀-ͯ]/g, '')
		.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------- recherche

const RE_COORDS = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/;

let searchTimer = null;
$('search').addEventListener('input', () => {
	clearTimeout(searchTimer);
	const q = $('search').value.trim();
	if (!q) return note('search-note', null);

	const m = q.match(RE_COORDS);
	if (m) {
		const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
		if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
			note('search-note', 'Entrée : appliquer ces coordonnées.', null);
			return;
		}
	}
	// Nominatim demande de ne pas marteler : une seconde de repos avant d'appeler.
	note('search-note', 'Recherche…', null);
	searchTimer = setTimeout(() => geocode(q), 1000);
});

$('search').addEventListener('keydown', (e) => {
	if (e.key !== 'Enter') return;
	e.preventDefault();
	const m = $('search').value.trim().match(RE_COORDS);
	if (m) goTo(Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.')), $('search').value.trim());
});

async function geocode(q) {
	try {
		const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
		const r = await fetch(url, { headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error(`Nominatim a répondu ${r.status}`);
		const hits = await r.json();
		if (!hits.length) return note('search-note', 'Aucun lieu de ce nom. Tu peux aussi coller des coordonnées.', 'warn');
		renderResults(hits);
	} catch (e) {
		note('search-note', `Recherche indisponible (${e.message}). Colle des coordonnées « lat, lon » à la place.`, 'warn');
	}
}

function renderResults(hits) {
	note('search-note', null);
	const box = $('results');
	box.innerHTML = '';
	for (const h of hits) {
		const b = document.createElement('button');
		b.textContent = h.display_name;
		b.style.cssText = 'text-align:left;text-transform:none;letter-spacing:0;font-size:11px;white-space:normal';
		b.onclick = () => {
			box.innerHTML = '';
			$('search').value = h.name || h.display_name.split(',')[0];
			if (!state.nameEdited) { $('name').value = $('search').value; updateButtons(); }
			// Nominatim rend une emprise : on s'en sert pour cadrer, pas pour
			// dessiner — le choix de la zone reste un geste explicite.
			if (h.boundingbox) {
				const [s, n, w, e] = h.boundingbox.map(Number);
				map.fitBounds([[s, w], [n, e]], { maxZoom: 17 });
			} else goTo(Number(h.lat), Number(h.lon));
		};
		box.appendChild(b);
	}
}

function goTo(lat, lon, label) {
	$('results').innerHTML = '';
	note('search-note', null);
	map.setView([lat, lon], 16);
	if (label && !state.nameEdited && !$('name').value) { $('name').value = label; updateButtons(); }
}

// ---------------------------------------------------------------- couverture

$('check').onclick = async () => {
	const btn = $('check');
	btn.disabled = true;
	renderVerdict({ status: 'pending', message: 'Interrogation de la région Flyover…' });
	try {
		const zoom = state.zoom, altitude = Number($('altitude').value) || 20;
		const { plan, ...d } = await post('/plan', { bbox: state.box, zoom, altitude });
		state.describe = d; renderZone(d);

		// columns === 0 : la région existe mais son emprise déclarée ne recouvre
		// pas du tout la zone. Verdict immédiat, sans toucher au réseau.
		if (plan.columns === 0) {
			return renderVerdict({ status: 'none',
				message: `Hors de l'emprise de la région « ${plan.trigger} » : les ${nf.format(plan.pruned)} colonnes sont toutes en dehors. Déplace la zone.` });
		}

		renderVerdict({ status: 'pending', message: `Région « ${plan.trigger} ». Téléchargement d'un échantillon au centre…` });
		const p = await post('/probe', { bbox: state.box, zoom, altitude });
		renderVerdict(p);
	} catch (e) {
		renderVerdict({ status: 'none', message: e.message });
	} finally {
		btn.disabled = !state.box;
	}
};

// ---------------------------------------------------------------- extraction

$('name').addEventListener('input', () => { state.nameEdited = true; updateButtons(); });
$('altitude').addEventListener('change', describe);
for (const r of document.querySelectorAll('#zoom input')) {
	r.addEventListener('change', () => { state.zoom = Number(r.value); state.coverage = null; describe(); });
}
$('clear').onclick = () => { if (zoneLayer) zoneLayer.remove(); clearZone(); };

$('launch').onclick = async () => {
	// La sonde n'est pas obligatoire, mais lancer sans elle est le meilleur moyen
	// d'attendre dix minutes pour rien : on demande confirmation.
	if (state.coverage?.status !== 'ok') {
		const why = state.coverage
			? state.coverage.message
			: 'La couverture Flyover n\'a pas été vérifiée pour cette zone.';
		if (!confirm(`${why}\n\nLancer quand même l'extraction ?`)) return;
	}
	try {
		const { jobId } = await post('/jobs', {
			name: $('name').value.trim(),
			bbox: state.box,
			zoom: state.zoom,
			altitude: Number($('altitude').value) || 20,
			cell: Number($('cell').value) || 256,
			quality: Number($('quality').value) || 85,
			force: $('force').checked,
		});
		watchJob(jobId, $('name').value.trim());
	} catch (e) {
		note('launch-note', e.message, 'alarm');
	}
};

let elapsedTimer = null;
function watchJob(id, name) {
	state.jobId = id;
	$('compose').hidden = true;
	$('job').hidden = false;
	$('j-name').textContent = name;
	$('j-count').textContent = '0';
	$('log').textContent = '';
	$('cancel').hidden = false;
	$('back').hidden = $('fly').hidden = true;
	note('j-note', null);

	const t0 = Date.now();
	clearInterval(elapsedTimer);
	elapsedTimer = setInterval(() => {
		const s = Math.round((Date.now() - t0) / 1000);
		$('j-elapsed').textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
	}, 1000);

	const expected = state.describe?.estimate?.tiles ?? 0;
	const es = new EventSource(`${API}/jobs/${id}/events`);
	const append = (text, tag) => {
		const log = $('log');
		// Collé au bas seulement si l'utilisateur y était déjà : sinon on lui
		// arrache la vue sous les yeux dès qu'il remonte lire une ligne.
		const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
		if (tag) {
			const el = document.createElement(tag);
			el.textContent = text;
			log.appendChild(el);
		} else {
			log.appendChild(document.createTextNode(text + '\n'));
		}
		if (stuck) log.scrollTop = log.scrollHeight;
	};

	es.addEventListener('state', (e) => {
		const d = JSON.parse(e.data);
		$('j-phase').textContent = phaseLabel(d.phase);
		$('j-count').textContent = nf.format(d.hits ?? 0);
	});
	es.addEventListener('log', (e) => {
		const d = JSON.parse(e.data);
		append(d.line, d.stream === 'meta' ? 'b' : d.stream === 'stderr' && /Attention|non décod/i.test(d.line) ? 'i' : null);
	});
	es.addEventListener('phase', (e) => {
		const p = JSON.parse(e.data).phase;
		$('j-phase').textContent = phaseLabel(p);
		// La conversion, elle, a un début et une fin connus : la barre peut enfin
		// dire où on en est plutôt que juste « ça tourne ».
		if (p === 'prep') { $('j-bar').dataset.indeterminate = '0'; $('j-bar').firstElementChild.style.width = '100%'; }
	});
	es.addEventListener('progress', (e) => {
		const { hits } = JSON.parse(e.data);
		$('j-count').textContent = nf.format(hits);
		if (expected) $('j-bar').firstElementChild.style.width = `${Math.min(99, (hits / expected) * 100)}%`;
	});
	es.addEventListener('done', (e) => {
		const d = JSON.parse(e.data);
		finish(`Terminé : ${nf.format(d.stats?.exported ?? 0)} tuiles, ${fmtBytes(d.bytes)} sur disque.`, 'ok');
		$('fly').hidden = false;
		$('fly').onclick = () => { location.href = `/?scene=${encodeURIComponent(d.slug)}`; };
		loadScenes();
	});
	es.addEventListener('error', (e) => finish(JSON.parse(e.data).message, 'alarm'));
	es.addEventListener('cancelled', () => finish('Extraction annulée. Rien n\'a été ajouté au menu.', 'warn'));
	es.addEventListener('end', () => es.close());
	es.onerror = () => { if (es.readyState === EventSource.CLOSED) finish('Connexion au serveur de dev perdue.', 'alarm'); };

	function finish(msg, kind) {
		clearInterval(elapsedTimer);
		es.close();
		state.jobId = null;
		$('j-bar').dataset.indeterminate = '0';
		$('j-bar').firstElementChild.style.width = '100%';
		$('j-phase').textContent = '';
		note('j-note', msg, kind);
		$('cancel').hidden = true;
		$('back').hidden = false;
	}
}

const phaseLabel = (p) => ({ download: 'téléchargement', prep: 'conversion' })[p] ?? p ?? '';

$('cancel').onclick = async () => {
	if (!state.jobId) return;
	$('cancel').disabled = true;
	try { await api(`/jobs/${state.jobId}`, { method: 'DELETE' }); }
	catch (e) { note('j-note', e.message, 'alarm'); }
	finally { $('cancel').disabled = false; }
};
$('back').onclick = () => { $('job').hidden = true; $('compose').hidden = false; };

// ---------------------------------------------------------------- cartes installées

async function loadScenes() {
	try {
		const { scenes } = await api('/scenes');
		state.scenes = scenes;
		const dl = $('scenes');
		dl.innerHTML = '';
		pins.clearLayers();
		let total = 0;
		for (const s of scenes) {
			total += s.bytes ?? 0;
			const dt = document.createElement('dt');
			const a = document.createElement('a');
			a.href = `/?scene=${encodeURIComponent(s.slug)}`;
			a.textContent = s.name;
			a.style.cssText = 'color:inherit;text-decoration:none';
			a.onmouseenter = () => map.panTo([s.lat, s.lon]);
			dt.appendChild(a);
			const dd = document.createElement('dd');
			dd.textContent = fmtBytes(s.bytes ?? 0);
			dl.append(dt, dd);

			// Les repères évitent de re-télécharger une zone déjà en boîte.
			pins.addLayer(L.marker([s.lat, s.lon], {
				icon: L.divIcon({ className: 'scene-pin', html: s.name, iconSize: null }),
			}));
		}
		$('scenes-total').textContent = scenes.length ? `${scenes.length} · ${fmtBytes(total)}` : '';
		updateButtons();
	} catch { /* le rail marche sans */ }
}

// ---------------------------------------------------------------- démarrage

loadScenes();
clearZone();

// Reprend la main sur une extraction déjà en cours (rechargement de page).
api('/jobs').then(({ jobs }) => {
	const running = jobs.find((j) => j.state === 'running');
	if (running) watchJob(running.id, running.name);
}).catch(() => {});
