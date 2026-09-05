// La mini-carte : le même fond monochrome que le GLOBAL SCANNER, cadré sur
// l'emprise réelle d'une zone. Il n'y a qu'UNE carte dans FPVTP! (Bible §4) —
// mêmes couches (map-layers.js), mêmes filtres (`.map-mono` dans style.css),
// même encre pour le cadre (palette.js).
//
// TOUS les imports Leaflet vivent ici. C'est ce qui permet à la Home de ne rien
// payer tant qu'elle n'a pas de carte à montrer : on l'importe dynamiquement,
// exactement comme terminal.js le fait déjà pour scanner.js.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LAYERS } from './map-layers.js';
import { token } from './palette.js';

// Monte une carte dans `el` et rend { setBounds, destroy }.
//
// `bounds` : [[south, west], [north, east]], tel que le rend previewBounds().
// `interactive` : faux par défaut — sur la Home c'est une vignette, pas un
//   outil ; la carte manipulable, c'est le scanner.
// `onPick` : appelé avec { lat, lon } au clic. N'a de sens qu'interactive.
export function mountMiniMap(el, { bounds, interactive = false, onPick = null, padding = 12 } = {}) {
	el.classList.add('map-mono');

	const map = L.map(el, {
		zoomControl: false,
		attributionControl: true,   // OSM l'exige, y compris sur une vignette
		dragging: interactive,
		scrollWheelZoom: interactive,
		doubleClickZoom: interactive,
		boxZoom: false,
		keyboard: false,
		// Sur la Home la carte n'est pas un contrôle : elle ne doit pas avaler les
		// gestes destinés à la navigation clavier/manette de l'écran.
		touchZoom: interactive,
	});

	// Le crédit des couches reste — OSM l'exige. Ce qui part, c'est
	// l'auto-promotion de Leaflet (« Leaflet | » et son fanion), qui n'est due à
	// personne et qui est du meuble de navigateur sur un écran que la Bible §30
	// veut calme. `attributionControl` n'accepte qu'un booléen (Leaflet le lit
	// comme un test de vérité) : le préfixe se retire sur le contrôle, après.
	map.attributionControl.setPrefix('');

	const base = L.tileLayer(LAYERS.MONO.url, LAYERS.MONO.opts).addTo(map);

	// Le cadre de la zone, dans le style EXACT du rectangle que le scanner
	// dessine sur la grille (`snapped`) : ce que la Home montre et ce que
	// l'acquisition avait dessiné doivent se reconnaître.
	const frame = L.rectangle([[0, 0], [0, 0]], {
		color: token('--warm-white'), weight: 1, fill: false, interactive: false,
	});

	// Une zone est jouable hors ligne par définition : une tuile qui ne vient pas
	// n'est donc PAS une panne, et ne doit pas en avoir l'air. On garde le fond,
	// on garde le cadre, et on le dit une fois.
	let offline = null;
	base.on('tileerror', () => {
		if (offline || !el.isConnected) return;
		offline = document.createElement('pre');
		offline.className = 'map-offline';
		offline.textContent = 'NO TILE LINK';
		el.appendChild(offline);
	});

	const setBounds = (b) => {
		if (!b) return;
		frame.setBounds(b).addTo(map);
		map.fitBounds(b, { padding: [padding, padding] });
	};
	setBounds(bounds);

	if (interactive && onPick) {
		map.on('click', (e) => onPick({ lat: e.latlng.lat, lon: e.latlng.lng }));
	}

	return {
		setBounds,
		// Leaflet retient des écouteurs sur window (resize) : sans remove(), une
		// Home re-rendue trois fois laisse trois cartes vivantes derrière elle.
		destroy: () => { try { map.remove(); } catch { /* déjà démontée */ } },
		// Exposée pour que l'appelant puisse recadrer après un redimensionnement
		// du conteneur — Leaflet mesure au montage et ne le refait pas seul.
		invalidate: () => { map.invalidateSize(); if (bounds) map.fitBounds(bounds, { padding: [padding, padding] }); },
	};
}
