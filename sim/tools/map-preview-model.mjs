// Le cadrage de la mini-carte d'une zone. Logique pure : aucun DOM, aucun
// Leaflet, aucune E/S — importable par la Home et par le selftest.
//
// La donnée existe déjà : public/scenes.json porte `lat`, `lon` et, depuis que
// l'acquisition sait dessiner autre chose qu'un cercle, `bbox` ou `poly`
// (tools/lib/add-map-core.mjs). Rien à ajouter au pipeline pour montrer une
// zone sur une carte, y compris pour les zones déjà acquises.

// Rayon de repli quand une vieille entrée n'a ni bbox ni poly : la convention
// d'add-map (--radius 25 au zoom 20, cf. CLAUDE.md). Un degré de latitude fait
// ~111,32 km ; en longitude il rétrécit avec le cosinus de la latitude, sinon
// le cadre serait deux fois trop large à Reykjavik.
const M_PER_DEG_LAT = 111320;
const FALLBACK_RADIUS_M = 25;

const clampLat = (v) => Math.max(-90, Math.min(90, v));

// Rend [[south, west], [north, east]] — la forme qu'attend `fitBounds` — ou
// null quand l'entrée ne dit pas où elle est.
//
// null n'est PAS une erreur : l'appelant écrit « NO MAP FOR THIS AREA ». Une
// carte inventée autour d'un (0, 0) de repli montrerait le golfe de Guinée pour
// une zone parisienne, ce qui est pire que pas de carte du tout.
export function previewBounds(scene, { radiusM = FALLBACK_RADIUS_M } = {}) {
	if (!scene) return null;

	// Le tracé libre d'abord : c'est l'emprise la plus fidèle qu'on ait.
	if (Array.isArray(scene.poly) && scene.poly.length >= 6) {
		let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
		for (let i = 0; i + 1 < scene.poly.length; i += 2) {
			const lat = scene.poly[i], lon = scene.poly[i + 1];
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
			if (lat < south) south = lat;
			if (lat > north) north = lat;
			if (lon < west) west = lon;
			if (lon > east) east = lon;
		}
		return [[south, west], [north, east]];
	}

	const b = scene.bbox;
	if (b && [b.south, b.west, b.north, b.east].every(Number.isFinite)) {
		// L'emprise RÉELLEMENT acquise : c'est elle qu'on a volée, pas un cercle
		// autour du centre. Une bbox dégénérée (les quatre bords égaux, vieille
		// entrée ou bug d'écriture) ne se cadre pas — on retombe sur le rayon.
		if (b.north > b.south && b.east > b.west) {
			return [[b.south, b.west], [b.north, b.east]];
		}
	}

	if (!Number.isFinite(scene.lat) || !Number.isFinite(scene.lon)) return null;

	const dLat = radiusM / M_PER_DEG_LAT;
	// cos(lat) tend vers 0 aux pôles : borner évite un cadre de largeur infinie.
	const cos = Math.max(0.01, Math.cos(scene.lat * Math.PI / 180));
	const dLon = radiusM / (M_PER_DEG_LAT * cos);
	return [
		[clampLat(scene.lat - dLat), scene.lon - dLon],
		[clampLat(scene.lat + dLat), scene.lon + dLon],
	];
}
