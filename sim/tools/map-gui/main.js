// GUI d'ajout de cartes. Elle ne parle qu'à /__map-api (tools/map-api-plugin.mjs),
// qui n'existe que sous `npm run dev`.
//
// Le parti pris : l'objet manipulé est la ZONE, pas un couple de coordonnées. On
// dessine un rectangle, et tout le reste — colonnes, poids, durée, couverture —
// en découle. Les coordonnées ne sont qu'une lecture parmi d'autres.

import L from 'leaflet';
import { maskOutline } from '../lib/tiles.mjs';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

const API = '/__map-api';
const $ = (id) => document.getElementById(id);

const state = {
	zone: null,       // { bbox } ou { poly } — la zone dessinée, brute
	describe: null,   // dernière réponse /describe
	coverage: null,   // dernier verdict de couverture
	zoom: 20,
	jobId: null,
	nameEdited: false,
	// Fournisseur retenu par la dernière vérification en mode Auto (design #18) :
	// null tant qu'aucune sonde n'a tranché. En mode manuel c'est le sélecteur
	// lui-même qui fait foi — voir electedProviderId() plus bas.
	autoProvider: null,
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
	drawPolyline: false, drawPolygon: true, drawText: false,
	cutPolygon: false, rotateMode: false, dragMode: true,
	drawRectangle: true, editMode: true, removalMode: true,
});
map.pm.setLang('fr');

let zoneLayer = null;
const lattice = L.layerGroup().addTo(map);   // le treillis de tuiles
const outline = L.layerGroup().addTo(map);   // l'escalier des tuiles retenues
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

	// Geoman rend un L.Rectangle pour le rectangle et un L.Polygon pour le tracé
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
	state.coverage = null;
	renderVerdict({ status: 'pending', message: 'Zone modifiée — vérifie la couverture avant de lancer.' });
	describe();
}

map.on('pm:create', (e) => {
	setZone(e.layer);
	e.layer.pm.enable({ allowSelfIntersection: false });
	e.layer.on('pm:edit pm:dragend', () => setZone(e.layer));
});
map.on('pm:remove', clearZone);

function clearZone() {
	if (zoneLayer) { map.removeLayer(zoneLayer); zoneLayer = null; }
	state.zone = null; state.describe = null; state.coverage = null; state.autoProvider = null;
	lattice.clearLayers();
	outline.clearLayers();
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
// L'élément signature. Une tuile fait environ 25 m de côté au zoom par défaut :
// la zone réellement extraite est la zone dessinée arrondie au treillis. Le montrer
// transforme « 697 colonnes » en quelque chose qu'on voit, et explique d'un coup
// d'œil pourquoi un rectangle un peu plus grand coûte une rangée de plus.

function drawLattice(grid) {
	lattice.clearLayers();
	outline.clearLayers();
	if (!grid) return;

	const s = grid.snapped;
	// Un tracé libre ne se résume pas à son emprise : la zone retenue est
	// l'escalier des tuiles qu'il touche. Contrairement au treillis, il reste
	// dessiné à toute échelle — c'est la seule chose qui dise ce qui sera extrait.
	if (grid.keep) {
		map.removeLayer(snapped);
		outline.addLayer(L.polyline(maskOutline({ ...grid, keep: Uint8Array.from(grid.keep) }, state.zoom),
			{ color: '#6cf', weight: 1, interactive: false }));
	} else {
		snapped.setBounds([[s.south, s.west], [s.north, s.east]]).addTo(map);
	}

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
		if (!state.zone) return;
		try {
			const d = await post('/describe', { ...state.zone, zoom: state.zoom, altitude: Number($('altitude').value) || 20 });
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
		// Sur un tracé, « cols × rows = columns » serait faux : le produit est
		// l'emprise, pas ce qu'on balaie. On montre la soustraction.
		'g-cols': grid.masked
			? `${grid.cols} × ${grid.rows} − ${nf.format(grid.masked)} = ${nf.format(grid.columns)}`
			: `${grid.cols} × ${grid.rows} = ${nf.format(grid.columns)}`,
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
	const hasZone = !!state.zone;
	$('check').disabled = !hasZone;
	$('launch').disabled = !hasZone || !$('name').value.trim();
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

// -------------------------------------------------------------- fournisseur
//
// « Auto » sonde les fournisseurs inscrits dans l'ordre du registre (l'ordre du
// design #18 : Google Earth par défaut). Apple Flyover, seul repli qu'il y ait
// jamais eu, a été retiré (2026-09-07) — un seul fournisseur reste, mais la
// boucle reste écrite pour plusieurs. Le sélecteur manuel court-circuite cette
// logique et n'interroge que le fournisseur choisi.
const AUTO_ORDER = ['google-earth'];
let providersList = []; // [{id, label}], peuplé par /providers au démarrage

function providerLabel(id) {
	return providersList.find((p) => p.id === id)?.label ?? id;
}

// Le fournisseur qui part réellement dans /plan, /probe et /jobs : le choix
// manuel du sélecteur s'il y en a un, sinon celui que la dernière sonde Auto a
// retenu (peut être null si aucune vérification n'a encore tourné — dans ce
// cas le serveur applique son propre défaut, qui est aussi le premier de
// AUTO_ORDER).
function electedProviderId() {
	return $('provider').value || state.autoProvider || undefined;
}

async function loadProviders() {
	try {
		const { providers } = await api('/providers');
		providersList = providers;
		const sel = $('provider');
		for (const p of providers) {
			sel.append(Object.assign(document.createElement('option'), { value: p.id, textContent: p.label }));
		}
	} catch { /* le sélecteur reste sur "Auto" seul ; /plan et /jobs valident quand même côté serveur */ }
}

$('provider').addEventListener('change', () => {
	state.autoProvider = null; state.coverage = null;
	renderVerdict({ status: 'pending', message: 'Fournisseur changé — vérifie la couverture avant de lancer.' });
});

// ---------------------------------------------------------------- couverture

// Plan puis sonde UN fournisseur donné. Rend le verdict de probe() tel quel
// (status/message), sans toucher à l'affichage — l'appelant décide comment le
// montrer (mode manuel : tel quel ; mode Auto : préfixé du fournisseur élu).
async function checkProvider(provider, zoom, altitude) {
	const { plan, ...d } = await post('/plan', { ...state.zone, zoom, altitude, provider });
	state.describe = d; renderZone(d);

	// columns === 0 : la région existe mais son emprise déclarée ne recouvre
	// pas du tout la zone. Verdict immédiat, sans toucher au réseau.
	if (plan.columns === 0) {
		return { status: 'none',
			message: `Hors de l'emprise de « ${plan.trigger} » : les ${nf.format(plan.pruned)} colonnes sont toutes en dehors. Déplace la zone.` };
	}

	renderVerdict({ status: 'pending', message: `${providerLabel(provider)} — « ${plan.trigger} ». Téléchargement d'un échantillon au centre…` });
	return post('/probe', { ...state.zone, zoom, altitude, provider });
}

$('check').onclick = async () => {
	const btn = $('check');
	btn.disabled = true;
	const zoom = state.zoom, altitude = Number($('altitude').value) || 20;
	const chosen = $('provider').value; // '' = Auto
	try {
		if (chosen) {
			renderVerdict({ status: 'pending', message: `Interrogation de ${providerLabel(chosen)}…` });
			renderVerdict(await checkProvider(chosen, zoom, altitude));
			return;
		}

		// Auto : Google Earth d'abord, repli sur Apple Flyover si pas 'ok' — y
		// compris si la sonde LÈVE (réseau, 5xx transitoire de kh.google.com,
		// non-2xx sur /plan ou /probe). Sur un endpoint non documenté c'est la
		// panne la plus probable, pas juste un statut 'none' : une exception
		// attrapée ici vaut donc "pas 'ok'" et fait continuer au fournisseur
		// suivant, elle ne casse pas la boucle.
		let verdict = null, tried, failures = [];
		for (tried of AUTO_ORDER) {
			renderVerdict({ status: 'pending', message: `Interrogation de ${providerLabel(tried)}…` });
			try {
				verdict = await checkProvider(tried, zoom, altitude);
				if (verdict.status === 'ok') break;
			} catch (e) {
				failures.push(`${providerLabel(tried)} : ${e.message}`);
				verdict = null;
			}
		}
		// Le fournisseur retenu pour /jobs est le dernier essayé, qu'il ait
		// couvert ou non : si l'utilisateur choisit de lancer quand même malgré
		// un verdict négatif, il faut envoyer le plus généreux des deux essais,
		// pas retomber sur le défaut du serveur (le premier de AUTO_ORDER).
		state.autoProvider = tried;
		if (verdict?.status === 'ok') {
			renderVerdict({ status: verdict.status, message: `Couvert par ${providerLabel(tried)} : ${verdict.message.replace(/^Couvert\s*:\s*/, '')}` });
		} else if (verdict) {
			renderVerdict({ status: verdict.status, message: `${providerLabel(tried)} : ${verdict.message}` });
		} else {
			// Les deux sondes ont levé (pas juste rendu un statut non-'ok') : on
			// montre les deux échecs plutôt que d'avaler silencieusement le
			// dernier et de laisser croire à une simple absence de couverture.
			renderVerdict({ status: 'none', message: `Aucun fournisseur n'a répondu — ${failures.join(' ; ')}` });
		}
	} catch (e) {
		renderVerdict({ status: 'none', message: e.message });
	} finally {
		btn.disabled = !state.zone;
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
			: 'La couverture n\'a pas été vérifiée pour cette zone.';
		if (!confirm(`${why}\n\nLancer quand même l'extraction ?`)) return;
	}
	try {
		const { jobId } = await post('/jobs', {
			name: $('name').value.trim(),
			provider: electedProviderId(),
			...state.zone,
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

loadProviders();
loadScenes();
clearZone();

// Reprend la main sur une extraction déjà en cours (rechargement de page).
api('/jobs').then(({ jobs }) => {
	const running = jobs.find((j) => j.state === 'running');
	if (running) watchJob(running.id, running.name);
}).catch(() => {});
