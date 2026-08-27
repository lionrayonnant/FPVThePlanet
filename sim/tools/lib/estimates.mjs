// Estimations de coût d'une extraction, à partir des constantes mesurées dans
// estimates.json. Rien n'est deviné ici : chaque constante vient d'un relevé sur
// les cartes déjà téléchargées (voir le mode --recalibrate en bas de fichier).
//
// La chaîne d'estimation :
//   bbox (degrés) -> colonnes de tuiles -> tuiles -> octets et secondes
//
// Le nombre de colonnes est exact (c'est de la géométrie). Le nombre de tuiles
// ne l'est pas : il dépend de la hauteur du bâti, d'où la fourchette
// tilesPerColumn min/typical/max plutôt qu'un chiffre unique.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const estimates = JSON.parse(fs.readFileSync(path.join(HERE, 'estimates.json'), 'utf8'));

// Rayon terrestre WGS84 par latitude — même formule que pkg/mth.EarthRadiusByLatitude,
// pour que les mètres affichés par la GUI et ceux du Go exporter concordent.
export function earthRadiusByLatitude(latDeg) {
	const r1 = 6378137.0, r2 = 6356752.314245179;
	const lat = (latDeg / 180) * Math.PI;
	return Math.sqrt(
		((r1 ** 2 * Math.cos(lat)) ** 2 + (r2 ** 2 * Math.sin(lat)) ** 2) /
		((r1 * Math.cos(lat)) ** 2 + (r2 * Math.sin(lat)) ** 2)
	);
}

// Portage de mth.LatLonToTileTMS. Doit rester identique au Go : c'est ce qui
// garantit que les colonnes annoncées par la GUI sont celles réellement scannées.
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

// Côté d'une tuile au sol, en mètres — sert à expliquer le zoom à l'utilisateur
// (« 25 m par tuile ») plutôt que de lui montrer un numéro de zoom nu.
export function tileSizeMeters(zoom, lat) {
	const R = earthRadiusByLatitude(lat);
	return (2 * Math.PI * R * Math.cos((lat / 180) * Math.PI)) / 2 ** zoom;
}

// Estimation complète. `columns` peut venir de tileGrid (approximation locale,
// instantanée) ou du champ `columns` de `export-obj --plan`, qui a en plus élagué
// les colonnes hors couverture — d'où le paramètre plutôt qu'un recalcul interne.
export function estimateCost({ columns, zoom = 20, altitude = 20 }) {
	const e = estimates;
	const probes = columns * altitude;
	// Une tuile au zoom z couvre 4^(20-z) fois l'aire d'une tuile z20 : à surface
	// au sol égale il y a d'autant moins de colonnes, mais chacune pèse d'autant plus.
	const areaFactor = 4 ** (e.zoomAreaFactor.base - zoom);
	const band = (k) => ({
		tiles: Math.round(e.tilesPerColumn[k] * columns),
		rawBytes: Math.round(columns * e.bytesPerColumnZ20.raw[k] * areaFactor),
		prepBytes: Math.round(columns * e.bytesPerColumnZ20.prep[k] * areaFactor),
	});
	const low = band('min'), typical = band('typical'), high = band('max');

	// Le téléchargement est limité soit par le nombre de requêtes, soit par le
	// débit : on prend le pire des deux, c'est ce qu'on observe en pratique.
	const downloadSeconds = Math.max(
		probes / e.probesPerSecond.value,
		typical.rawBytes / e.downloadBytesPerSecond.value
	);
	const prepSeconds = typical.tiles * e.prepSecondsPerTile.value;

	return {
		columns, probes, zoom, altitude,
		tiles: typical.tiles,
		tilesRange: [low.tiles, high.tiles],
		rawBytes: typical.rawBytes,
		rawBytesRange: [low.rawBytes, high.rawBytes],
		prepBytes: typical.prepBytes,
		prepBytesRange: [low.prepBytes, high.prepBytes],
		downloadSeconds, prepSeconds,
		totalSeconds: downloadSeconds + prepSeconds,
		warn: typical.tiles > e.warnAboveTiles.value,
	};
}

export function formatBytes(n) {
	if (n < 1024) return `${n} o`;
	const u = ['ko', 'Mo', 'Go', 'To'];
	let i = -1, v = n;
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// Ordre de grandeur volontairement grossier : les fourchettes de tilesPerColumn
// vont du simple au triple, annoncer « 12 min 34 s » serait mentir.
export function formatDuration(s) {
	if (s < 45) return '< 1 min';
	if (s < 3600) return `~${Math.round(s / 60)} min`;
	const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
	return m ? `~${h} h ${m} min` : `~${h} h`;
}
