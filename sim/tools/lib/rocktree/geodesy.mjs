// Géodésie du rendu rocktree en direct (#168). Chemin INDÉPENDANT de
// tools/prep.mjs, délibérément — CLAUDE.md protège la géodésie de prep.mjs
// (« do not re-derive or replace… without reason ») et prep.mjs n'a de toute
// façon jamais eu besoin de geodeticToEcef (ses origines viennent déjà en
// ECEF de la source Flyover). sphereToWgs84Ecef et ecefToGeodetic sont la
// même formule que tools/lib/decoders/rocktree.mjs (déplacées ici pour être
// réutilisées côté rendu live sans importer un fichier qui tire `sharp`).

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

// Un nœud rocktree place ses sommets sur une SPHÈRE de rayon `radius`
// (PlanetoidMetadata, voir getPlanetoid() dans traverse.mjs), pas
// l'ellipsoïde WGS84 — les deux sont proches mais pas identiques, l'écart
// mesuré est de plusieurs kilomètres si on les confond (issue #18 Task 9).
export function sphereToWgs84Ecef(x, y, z, radius) {
	const r = Math.hypot(x, y, z);
	const lat = Math.asin(z / r), lon = Math.atan2(y, x);
	const alt = r - radius;
	const sl = Math.sin(lat), cl = Math.cos(lat);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
	return [
		(n + alt) * cl * Math.cos(lon),
		(n + alt) * cl * Math.sin(lon),
		(n * (1 - WGS84_E2) + alt) * sl,
	];
}

// ECEF WGS84 -> géodésique (Bowring), en DEGRÉS (pas radians — cohérent avec
// zoneOf()/traverse.mjs qui prennent déjà lat/lon en degrés).
export function ecefToGeodetic(x, y, z) {
	const p = Math.hypot(x, y);
	const th = Math.atan2(z * WGS84_A, p * WGS84_B);
	const lat = Math.atan2(z + WGS84_EP2 * WGS84_B * Math.sin(th) ** 3, p - WGS84_E2 * WGS84_A * Math.cos(th) ** 3);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
	return { lat: (lat * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI, alt: p / Math.cos(lat) - n };
}

// Géodésique -> ECEF WGS84. N'existait nulle part dans ce dépôt avant #168 :
// nécessaire pour situer l'origine du spawn ?live=lat,lon en ECEF, point de
// départ du repère local.
export function geodeticToEcef(latDeg, lonDeg, alt = 0) {
	const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
	const sl = Math.sin(lat), cl = Math.cos(lat);
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
	return [
		(n + alt) * cl * Math.cos(lon),
		(n + alt) * cl * Math.sin(lon),
		(n * (1 - WGS84_E2) + alt) * sl,
	];
}

// Repère tangent local à (lat, lon), convention three.js Y-up — MÊME
// convention que prep.mjs (X=est, Y=haut, Z=sud), dupliquée à dessein (voir
// l'en-tête de ce fichier) plutôt qu'importée.
export function enuBasis(latDeg, lonDeg) {
	const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
	const sla = Math.sin(lat), cla = Math.cos(lat);
	const slo = Math.sin(lon), clo = Math.cos(lon);
	return {
		east: [-slo, clo, 0],
		up: [cla * clo, cla * slo, sla],
		south: [sla * clo, sla * slo, -cla],
	};
}

export function ecefToLocalEnu(ecef, originEcef, basis) {
	const d = [ecef[0] - originEcef[0], ecef[1] - originEcef[1], ecef[2] - originEcef[2]];
	const dot = (v, w) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
	return { x: dot(d, basis.east), y: dot(d, basis.up), z: dot(d, basis.south) };
}

// Inverse de ecefToLocalEnu : reconstruit le point ECEF depuis des mètres
// locaux ENU. `basis` est orthonormée (est/haut/sud sont perpendiculaires
// entre eux et de norme 1 — vrai par construction dans enuBasis()), donc la
// reconstruction est une simple combinaison linéaire, pas une inversion de
// matrice.
export function localEnuToEcef({ x, y, z }, originEcef, basis) {
	return [
		originEcef[0] + x * basis.east[0] + y * basis.up[0] + z * basis.south[0],
		originEcef[1] + x * basis.east[1] + y * basis.up[1] + z * basis.south[1],
		originEcef[2] + x * basis.east[2] + y * basis.up[2] + z * basis.south[2],
	];
}
