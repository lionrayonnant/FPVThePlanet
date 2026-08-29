// Géométrie des tuiles Flyover. Pure : aucun accès disque, aucune dépendance —
// c'est ce qui permet au GLOBAL SCANNER (navigateur) et à l'API de dev (Node)
// de partager exactement la même grille, plutôt que d'en avoir chacun une.
//
// Tout ici est un portage littéral du Go (pkg/mth) : les colonnes annoncées à
// l'écran sont celles que `export-obj` balaiera réellement.

// Rayon terrestre WGS84 par latitude — même formule que pkg/mth.EarthRadiusByLatitude.
export function earthRadiusByLatitude(latDeg) {
	const r1 = 6378137.0, r2 = 6356752.314245179;
	const lat = (latDeg / 180) * Math.PI;
	return Math.sqrt(
		((r1 ** 2 * Math.cos(lat)) ** 2 + (r2 ** 2 * Math.sin(lat)) ** 2) /
		((r1 * Math.cos(lat)) ** 2 + (r2 * Math.sin(lat)) ** 2)
	);
}

// Portage de mth.LatLonToTileTMS.
export function latLonToTileTMS(zoom, lat, lon) {
	const n = 2 ** zoom;
	const latRad = (lat / 180) * Math.PI;
	return {
		x: Math.floor(n * ((lon + 180) / 360)),
		y: Math.floor((Math.log(Math.tan(latRad * 0.5 + Math.PI / 4)) / (2 * Math.PI) + 0.5) * n),
	};
}

export function tileTMSToLatLon(zoom, x, y) {
	const n = 2 ** zoom;
	return {
		lon: (x / n) * 360 - 180,
		lat: ((2 * Math.atan(Math.exp((y / n - 0.5) * 2 * Math.PI)) - Math.PI / 2) / Math.PI) * 180,
	};
}

// Dimensions au sol de la bbox, en mètres.
export function boxDimensions({ south, west, north, east }) {
	const R = earthRadiusByLatitude((south + north) / 2);
	const height = ((north - south) / 180) * Math.PI * R;
	const width = ((east - west) / 180) * Math.PI * R * Math.cos(((south + north) / 2 / 180) * Math.PI);
	return { width, height, area: width * height };
}

// Grille de tuiles réellement balayée pour cette bbox à ce zoom (bornes incluses),
// et la bbox « alignée sur les tuiles » qui en découle — c'est elle qu'il faut
// afficher sur la carte, pas le rectangle dessiné : l'extraction est quantifiée.
export function tileGrid(box, zoom) {
	const a = latLonToTileTMS(zoom, box.south, box.west);
	const b = latLonToTileTMS(zoom, box.north, box.east);
	const xMin = Math.min(a.x, b.x), xMax = Math.max(a.x, b.x);
	const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y);
	const sw = tileTMSToLatLon(zoom, xMin, yMin);
	const ne = tileTMSToLatLon(zoom, xMax + 1, yMax + 1);
	return {
		xMin, xMax, yMin, yMax,
		cols: xMax - xMin + 1,
		rows: yMax - yMin + 1,
		columns: (xMax - xMin + 1) * (yMax - yMin + 1),
		snapped: { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon },
	};
}

// Bords exacts des tuiles de la grille : une longitude par bord de colonne, une
// latitude par bord de rangée, bornes comprises. Les latitudes ne sont PAS
// équidistantes (Mercator) — les calculer par indice plutôt que d'interpoler
// entre les coins ne coûte rien et reste juste à n'importe quelle échelle.
export function latticeEdges(grid, zoom) {
	const lons = [], lats = [];
	for (let x = grid.xMin; x <= grid.xMax + 1; x++) lons.push(tileTMSToLatLon(zoom, x, 0).lon);
	for (let y = grid.yMin; y <= grid.yMax + 1; y++) lats.push(tileTMSToLatLon(zoom, 0, y).lat);
	return { lons, lats };
}

// Côté d'une tuile au sol, en mètres — sert à expliquer le zoom à l'utilisateur
// (« 25 m par tuile ») plutôt que de lui montrer un numéro de zoom nu.
export function tileSizeMeters(zoom, lat) {
	const R = earthRadiusByLatitude(lat);
	return (2 * Math.PI * R * Math.cos((lat / 180) * Math.PI)) / 2 ** zoom;
}

// Intersection de deux bbox lat/lon, ou null si elles ne se touchent pas.
export function intersectBox(a, b) {
	const south = Math.max(a.south, b.south), north = Math.min(a.north, b.north);
	const west = Math.max(a.west, b.west), east = Math.min(a.east, b.east);
	if (south >= north || west >= east) return null;
	return { south, west, north, east };
}
