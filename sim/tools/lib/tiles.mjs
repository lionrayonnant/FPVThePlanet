// Géométrie de tuiles slippy (Web Mercator, zoom entier). Pure : aucun accès
// disque, aucune dépendance — c'est ce qui permet au GLOBAL SCANNER (navigateur)
// et à l'API de dev (Node) de partager exactement la même grille, plutôt que
// d'en avoir chacun une.
//
// Écrit à l'origine comme portage littéral du Go d'Apple Flyover (pkg/mth,
// retiré 2026-09-07) : la formule WGS84 ci-dessous n'a rien de spécifique à un
// fournisseur, elle reste utilisée par tous les calculs de zone (scanner, API,
// providers/google-earth.mjs).

// Rayon terrestre WGS84 par latitude.
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

// ------------------------------------------------------------------ polygones
//
// Un anneau est un tableau plat [lat, lon, lat, lon, …], refermé implicitement.
// C'est exactement la forme de l'option --poly de l'exporter : une seule
// représentation du tracé, du clic de souris jusqu'à l'argv du sous-processus.
//
// Tout ce bloc a un jumeau en Go dans pkg/mth/poly.go. Les deux sont tenus
// d'accord par testdata/poly-cases.json — une dérive ne se verrait sinon qu'au
// moment où le nom du dossier de cache diverge, c'est-à-dire en re-téléchargeant
// plusieurs gigaoctets.

export function polygonBounds(ring) {
	let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
	for (let i = 0; i < ring.length; i += 2) {
		if (ring[i] < south) south = ring[i];
		if (ring[i] > north) north = ring[i];
		if (ring[i + 1] < west) west = ring[i + 1];
		if (ring[i + 1] > east) east = ring[i + 1];
	}
	return { south, west, north, east };
}

// Lancer de rayon. Le point sur une arête n'a pas de réponse stable ici — c'est
// sans conséquence : tileIntersectsPolygon teste aussi les arêtes, donc une
// tuile dont un coin est pile sur le tracé est retenue par le test de croisement.
export function pointInPolygon(lat, lon, ring) {
	const n = ring.length / 2;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const yi = ring[2 * i], xi = ring[2 * i + 1];
		const yj = ring[2 * j], xj = ring[2 * j + 1];
		if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

// x = lon, y = lat. Les cas colinéaires comptent comme une intersection : deux
// segments qui se touchent bout à bout se touchent bel et bien, et c'est ce qui
// fait qu'une tuile rasée par une arête est retenue plutôt qu'oubliée.
function cross(ax, ay, bx, by, cx, cy) {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function onSegment(ax, ay, bx, by, px, py) {
	return Math.min(ax, bx) <= px && px <= Math.max(ax, bx)
		&& Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
	const d1 = cross(cx, cy, dx, dy, ax, ay);
	const d2 = cross(cx, cy, dx, dy, bx, by);
	const d3 = cross(ax, ay, bx, by, cx, cy);
	const d4 = cross(ax, ay, bx, by, dx, dy);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
	if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
	if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
	if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
	return false;
}

// Les trois façons dont un carré et un anneau se touchent, et elles sont
// nécessaires toutes les trois : un sommet dans la tuile (tracé inclus dans la
// tuile), un coin de tuile dans le tracé (tuile incluse dans le tracé), ou une
// arête qui en croise une autre (le cas courant).
export function tileIntersectsPolygon(ring, box) {
	for (let i = 0; i < ring.length; i += 2) {
		const lat = ring[i], lon = ring[i + 1];
		if (lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east) return true;
	}
	if (pointInPolygon(box.south, box.west, ring)) return true;

	const corners = [
		[box.west, box.south], [box.east, box.south],
		[box.east, box.north], [box.west, box.north],
	];
	const n = ring.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const ay = ring[2 * j], ax = ring[2 * j + 1];
		const by = ring[2 * i], bx = ring[2 * i + 1];
		for (let k = 0; k < 4; k++) {
			const [cx, cy] = corners[k], [dx, dy] = corners[(k + 1) % 4];
			if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
		}
	}
	return false;
}

// La grille balayée pour un tracé : celle de son emprise, plus le masque des
// tuiles réellement retenues. `columns` remplace grid.columns partout où le coût
// est calculé — c'est le seul chiffre qui compte pour le téléchargement.
export function polygonGrid(ring, zoom) {
	const grid = tileGrid(polygonBounds(ring), zoom);
	const keep = new Uint8Array(grid.cols * grid.rows);
	let columns = 0;
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		const south = tileTMSToLatLon(zoom, grid.xMin, y).lat;
		const north = tileTMSToLatLon(zoom, grid.xMin, y + 1).lat;
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			const west = tileTMSToLatLon(zoom, x, y).lon;
			const east = tileTMSToLatLon(zoom, x + 1, y).lon;
			if (tileIntersectsPolygon(ring, { south, west, north, east })) {
				keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)] = 1;
				columns++;
			}
		}
	}
	return { ...grid, keep, columns, masked: grid.cols * grid.rows - columns };
}

// Les tuiles retenues, en clés « x/y » triées — la forme comparable d'un masque,
// et ce que la fixture partagée contient.
export function maskKeys(grid) {
	const keys = [];
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)]) keys.push(`${x}/${y}`);
		}
	}
	return keys.sort();
}

// Aire du tracé en m², par la formule du lacet sur une projection
// équirectangulaire locale. Sur un corridor le long d'un fleuve elle vaut deux
// ou trois fois moins que l'aire de l'emprise : afficher l'emprise comme
// « surface de la zone » serait un mensonge.
export function polygonArea(ring) {
	const b = polygonBounds(ring);
	const lat0 = (b.south + b.north) / 2;
	const R = earthRadiusByLatitude(lat0);
	const rad = Math.PI / 180;
	const kx = rad * R * Math.cos(lat0 * rad), ky = rad * R;
	const n = ring.length / 2;
	let sum = 0;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		sum += (ring[2 * j + 1] * kx) * (ring[2 * i] * ky) - (ring[2 * i + 1] * kx) * (ring[2 * j] * ky);
	}
	return Math.abs(sum) / 2;
}

// 6 décimales : c'est ce que rend le %f du Go, et c'est ce hash qui nomme le
// dossier de cache. Les deux ports doivent rendre la même chaîne au caractère près.
export function canonicalPoly(ring) {
	return Array.from(ring, (v) => v.toFixed(6)).join(',');
}

// Asynchrone parce que crypto.subtle l'est : tiles.mjs doit rester importable
// par le navigateur, il ne peut donc pas faire `import crypto from 'node:crypto'`.
export async function polyHash(ring) {
	const bytes = new TextEncoder().encode(canonicalPoly(ring));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Le contour de la zone retenue : les arêtes qu'une tuile gardée ne partage pas
// avec une autre tuile gardée. C'est l'escalier — la forme réellement extraite,
// par opposition au tracé lisse que l'utilisateur a dessiné. Rendu en segments
// plutôt qu'en anneaux cousus : Leaflet accepte un tableau de segments comme
// polyligne multiple, et recoudre des anneaux n'apporterait rien à l'écran.
export function maskOutline(grid, zoom) {
	const kept = (x, y) => x >= grid.xMin && x <= grid.xMax && y >= grid.yMin && y <= grid.yMax
		&& grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)] === 1;

	const segs = [];
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (!kept(x, y)) continue;
			const s = tileTMSToLatLon(zoom, x, y).lat, n = tileTMSToLatLon(zoom, x, y + 1).lat;
			const w = tileTMSToLatLon(zoom, x, y).lon, e = tileTMSToLatLon(zoom, x + 1, y).lon;
			if (!kept(x, y - 1)) segs.push([[s, w], [s, e]]);
			if (!kept(x, y + 1)) segs.push([[n, w], [n, e]]);
			if (!kept(x - 1, y)) segs.push([[s, w], [n, w]]);
			if (!kept(x + 1, y)) segs.push([[s, e], [n, e]]);
		}
	}
	return segs;
}

// Où sonder la couverture Flyover pour un tracé. Le centre de l'emprise ne
// convient pas : sur un croissant le long d'un fleuve, ou sur un L, il tombe
// HORS du tracé, et la sonde rendrait son verdict sur une zone qu'on n'extrait
// pas. On vise donc le centre de la tuile retenue la plus proche du centroïde.
export function polygonProbePoint(ring, zoom) {
	const grid = polygonGrid(ring, zoom);
	const b = polygonBounds(ring);
	const cLat = (b.south + b.north) / 2, cLon = (b.west + b.east) / 2;

	let best = null, bestD = Infinity;
	for (let y = grid.yMin; y <= grid.yMax; y++) {
		for (let x = grid.xMin; x <= grid.xMax; x++) {
			if (!grid.keep[(y - grid.yMin) * grid.cols + (x - grid.xMin)]) continue;
			const lat = (tileTMSToLatLon(zoom, x, y).lat + tileTMSToLatLon(zoom, x, y + 1).lat) / 2;
			const lon = (tileTMSToLatLon(zoom, x, y).lon + tileTMSToLatLon(zoom, x + 1, y).lon) / 2;
			const d = (lat - cLat) ** 2 + (lon - cLon) ** 2;
			// Strictement inférieur : à égalité, la première tuile dans l'ordre
			// (y puis x) gagne, et la sonde reste reproductible.
			if (d < bestD) { bestD = d; best = { lat, lon }; }
		}
	}
	return best ?? { lat: cLat, lon: cLon };
}
