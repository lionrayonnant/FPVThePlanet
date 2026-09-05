// La couverture : là où le drone est passé (issue #245). Une tache sur la
// carte vivante qui s'étend sous les trajectoires, se densifie quand on repasse,
// et survit aux sessions.
//
// Ni THREE, ni Rapier, ni DOM, ni Leaflet — même règle et même raison que
// wind.js, fog.js, geofence.js : c'est la moitié que tools/coverage-selftest.mjs
// vérifie sans navigateur. Qui échantillonne en vol (session.js), qui écrit sur
// l'opérateur (session.js) et qui dessine (map-coverage.js) est ailleurs.
//
// Ce n'est PAS « la zone est acquise, donc explorée » : un cadre acquis où l'on
// n'a jamais volé reste vierge. Et ce n'est pas un brouillard de guerre : on
// marque où le drone est PASSÉ, pas ce que la caméra a VU — voir la spec pour
// ce qui a été écarté et pourquoi.

// ---------------------------------------------------------------------------
// La grille
//
// Des tuiles slippy à zoom FIXE, clé entière (x, y). Choisi plutôt qu'une grille
// en degrés parce que Leaflet est déjà en Web Mercator : une cellule se projette
// sans conversion au rendu, et l'indexation ne se déforme pas avec la latitude.
// À z=20 et 48,85° (Paris) une tuile fait 25,15 m de côté ; 38,2 m à l'équateur.
export const Z = 20;
const N = 2 ** Z;

// Le rayon de l'empreinte autour de la trajectoire, en mètres. À 25 m de
// cellule, ça fait 4 à 5 cellules par échantillon (les diagonales sont à
// 35,6 m et sortent du rayon) — la bonne approximation d'un disque de 30 m,
// dont l'aire vaut 2 827 m² pour 632 m² de cellule.
export const R_M = 30;

// Le poids sature : au-delà, repasser n'assombrit plus. Sans ce plafond, un
// stationnaire de deux minutes au même endroit écraserait à lui seul l'échelle
// de toute la carte.
export const W_MAX = 8;

// Plafond de cellules persistées, ~5 km² parcourus. UN PARI, écrit comme tel :
// il n'y a pas encore d'usage réel à mesurer. Ordre de grandeur : un vol de dix
// minutes à 15 m/s balaie 9 km de trajectoire, soit un couloir de 60 m de large,
// soit ~850 cellules à Paris. Une dizaine de vols sans recouvrement tiennent,
// bien davantage en usage réel où l'on repasse. À revoir sur des données.
export const MAX_CELLS = 8000;

const RAD = Math.PI / 180;
// Résolution Web Mercator au niveau de la mer, en m/px à z=0 pour une tuile de
// 256 px : 2π·6378137 / 256. La valeur canonique du format slippy.
const RES_Z0 = 156543.03392;

export function cellOf(lat, lon) {
	const latR = lat * RAD;
	const x = Math.floor((lon + 180) / 360 * N);
	const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * N);
	return { x, y };
}

export function cellCenter(x, y) {
	const lon = (x + 0.5) / N * 360 - 180;
	const n = Math.PI - 2 * Math.PI * (y + 0.5) / N;
	const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
	return { lat, lon };
}

export function cellSizeM(lat) {
	return RES_Z0 * Math.cos(lat * RAD) / N * 256;
}

// Distance plate. À l'échelle d'une empreinte de 30 m, la courbure ne pèse
// rien — c'est la même approximation que latLonOf() dans main.js.
export function distanceM(a, b) {
	const latM = 111320;
	const lonM = latM * Math.cos(((a.lat + b.lat) / 2) * RAD);
	const dx = (b.lon - a.lon) * lonM;
	const dy = (b.lat - a.lat) * latM;
	return Math.hypot(dx, dy);
}

// Les cellules dont le CENTRE est à moins de rM du point. On balaie un carré de
// ±k cellules autour de la cellule du point, k dimensionné par rM et la taille
// de cellule à cette latitude — +1 pour que le point posé sur un bord voie
// bien la cellule d'à côté.
export function stampCells(lat, lon, rM = R_M) {
	const at = { lat, lon };
	const c = cellOf(lat, lon);
	const k = Math.ceil(rM / cellSizeM(lat)) + 1;
	const out = [];
	for (let dx = -k; dx <= k; dx++) {
		for (let dy = -k; dy <= k; dy++) {
			const x = c.x + dx, y = c.y + dy;
			if (distanceM(at, cellCenter(x, y)) < rM) out.push({ x, y });
		}
	}
	return out;
}
