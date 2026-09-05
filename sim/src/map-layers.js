// Les fonds de carte du jeu. Extraits de scanner.js pour que la mini-carte de
// la Home vole exactement les mêmes : il n'y a qu'UNE carte dans FPVTP! (Bible
// §4), et deux tables de couches seraient deux cartes le jour où l'une change.
//
// Données pures : aucun import Leaflet, donc importable depuis Node par un
// selftest sans faire entrer une bibliothèque de navigateur.
//
// Tous passent par le même filtre monochrome (voir `.map-mono` dans style.css) :
// le jeu est N&B, quelle que soit la couche. Aucune couche n'existe ici pour des
// raisons esthétiques — MONO pour lire une ville, SAT pour reconnaître un
// bâtiment avant de le survoler, TERRAIN pour le relief.
export const LAYERS = {
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
