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
//
// La géométrie pure vit dans ./tiles.mjs (importable par le navigateur, qui ne
// peut pas lire estimates.json) et est ré-exportée ici pour les appelants Node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './tiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const estimates = JSON.parse(fs.readFileSync(path.join(HERE, 'estimates.json'), 'utf8'));

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
