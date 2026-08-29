// Le soleil, comme modèle : où il est, ce que l'atmosphère lui fait, et ce que
// la caméra en fait.
//
// Ni THREE, ni DOM, ni `node:` — même règle et même raison que wind.js, rain.js
// et fog.js : c'est la moitié que tools/selftest.mjs peut vérifier sans
// navigateur. lens.js dessine, main.js câble.
//
// L'imagerie est de la photogrammétrie NON éclairée, avec son ombrage cuit dans
// les textures (TileMaterial.js). Ce fichier ne ré-éclaire donc RIEN : il ne
// produit qu'une direction, une couleur de ciel et un gain d'exposition. Un
// soleil mobile qui ré-éclairerait la ville la double-ombrerait avec les ombres
// du survol d'Apple, et c'est la décision d'architecture de l'issue #23.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Position
//
// Algorithme NOAA (Solar Position Calculator), lui-même tiré des Astronomical
// Algorithms de Meeus. Meilleur que 0,02° sur les dates qui nous concernent —
// très au-delà de ce qu'un disque solaire de 0,5° demande, mais c'est
// l'algorithme standard et il n'y a rien à gagner à l'approximer.

// Jour julien depuis un instant. Date.getTime() est en UTC par construction, ce
// qui est exactement ce qu'il faut : la position du soleil est fonction de
// l'instant absolu et de la position géodésique, et d'AUCUN fuseau horaire.
// C'est ce qui permet au sim de n'avoir ni base de fuseaux ni réglage d'heure.
function julianDay(date) {
	return date.getTime() / 86400000 + 2440587.5;
}

export function sunPosition({ lat, lon, date = new Date() }) {
	const jd = julianDay(date);
	const t = (jd - 2451545) / 36525;                         // siècles juliens depuis J2000

	const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;   // longitude moyenne
	const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);            // anomalie moyenne
	const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);       // excentricité
	const Mr = M * D2R;

	// Équation du centre : l'écart entre l'anomalie moyenne et la vraie, dû à
	// l'ellipticité de l'orbite.
	const C = Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
		+ Math.sin(2 * Mr) * (0.019993 - 0.000101 * t)
		+ Math.sin(3 * Mr) * 0.000289;

	const trueLong = L0 + C;
	// Nutation en longitude, réduite à son terme dominant.
	const omega = 125.04 - 1934.136 * t;
	const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);

	const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
	const eps = eps0 + 0.00256 * Math.cos(omega * D2R);       // obliquité corrigée

	const declination = Math.asin(Math.sin(eps * D2R) * Math.sin(appLong * D2R));

	// Équation du temps, en minutes : de combien le soleil vrai est en avance ou
	// en retard sur le soleil moyen. C'est elle qui fait qu'un midi solaire n'est
	// pas à midi, et l'ignorer décalerait le soleil de ±16 minutes selon la
	// saison — soit jusqu'à 4° d'azimut.
	const y = Math.tan(eps * D2R / 2) ** 2;
	const eqTime = 4 * R2D * (y * Math.sin(2 * L0 * D2R)
		- 2 * e * Math.sin(Mr)
		+ 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * D2R)
		- 0.5 * y * y * Math.sin(4 * L0 * D2R)
		- 1.25 * e * e * Math.sin(2 * Mr));

	// Minutes écoulées depuis minuit UTC. Le −0,5 ramène le jour julien (qui
	// commence à midi) sur le jour civil.
	const utcMinutes = (((jd - 0.5) % 1) + 1) % 1 * 1440;
	const trueSolarMinutes = utcMinutes + eqTime + 4 * lon;   // 4 min par degré de longitude
	let ha = trueSolarMinutes / 4 - 180;                      // angle horaire, degrés
	if (ha < -180) ha += 360;
	if (ha > 180) ha -= 360;

	const phi = lat * D2R;
	const har = ha * D2R;
	const cosZenith = Math.sin(phi) * Math.sin(declination)
		+ Math.cos(phi) * Math.cos(declination) * Math.cos(har);
	const elevation = Math.PI / 2 - Math.acos(clamp(cosZenith, -1, 1));

	// Azimut horaire depuis le nord — la convention de l'issue, et celle d'une
	// boussole. Le +π vient de ce que atan2 sous cette forme rend l'azimut
	// depuis le SUD.
	let azimuth = Math.atan2(Math.sin(har),
		Math.cos(har) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) + Math.PI;
	azimuth = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

	return { elevation, azimuth, declination, hourAngle: har, eqTime };
}

// ---------------------------------------------------------------------------
// Direction dans les axes du sim
//
// LE piège de cette issue. Après prep.mjs : X = est, Y = haut, Z = SUD. Le Z
// positif vers le sud est l'inverse de la convention habituelle et mettrait
// silencieusement le soleil dans le mauvais demi-ciel — rien d'autre dans le
// sim ne le remarquerait. Le selftest le vérifie explicitement, pour toujours.
export function sunVector(azimuth, elevation) {
	const ce = Math.cos(elevation);
	return { x: Math.sin(azimuth) * ce, y: Math.sin(elevation), z: -Math.cos(azimuth) * ce };
}

// ---------------------------------------------------------------------------
// Optique atmosphérique

// Réfraction astronomique, Bennett (1982), en degrés. Elle relève le soleil
// d'environ 0,57° à l'horizon — c'est-à-dire d'un peu plus que son propre
// diamètre, raison pour laquelle on le voit encore quand il est géométriquement
// couché. Gardée séparée de sunPosition() parce que l'une est de l'astronomie et
// l'autre de l'optique : le rendu veut le soleil qu'on VOIT.
export function refracted(elevationDeg) {
	return elevationDeg + (1 / Math.tan((elevationDeg + 7.31 / (elevationDeg + 4.4)) * D2R)) / 60;
}

// Masse d'air relative, Kasten & Young (1989). 1/sin h diverge à l'horizon,
// là où la vraie masse d'air plafonne à ~38 ; c'est toute la raison de cette
// formule plutôt que de la naïve.
export function airMass(elevationDeg) {
	const h = Math.max(elevationDeg, 0);
	return 1 / (Math.sin(h * D2R) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}
