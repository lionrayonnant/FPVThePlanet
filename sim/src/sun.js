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

// ---------------------------------------------------------------------------
// Extinction spectrale
//
// Tout ce qui suit est MESURÉ, pas choisi à l'œil : c'est ce qui permet à la
// couleur du ciel d'être dérivée plutôt que peinte, et donc de ne jamais
// contredire le régime météo que le terminal a affiché au joueur.

// Les longueurs d'onde effectives de nos trois canaux, en µm.
const LAMBDA = [0.610, 0.550, 0.470];

// Épaisseur optique de Rayleigh au niveau de la mer, Hansen & Travis (1974) :
// tau = 0,008735 · lambda^(−4,08). Soit 0,066 / 0,100 / 0,190 — le bleu est
// diffusé trois fois plus que le rouge, et c'est là toute la couleur du ciel.
export const TAU_RAYLEIGH = LAMBDA.map((l) => 0.008735 * Math.pow(l, -4.08));

// Aérosols. Le bulletin météo donne une visibilité en mètres ; Koschmieder la
// convertit en coefficient d'extinction horizontal à 550 nm, et une hauteur
// d'échelle en épaisseur optique verticale. C'est ce qui fait tomber TOUT SEUL
// le couplage brouillard demandé par l'issue, sans une seule constante inventée
// pour l'occasion : la même visibilité pilote déjà fog.js.
const KOSCHMIEDER = 3.912;          // = ln(1/0.02), le contraste seuil de 2 %
const AEROSOL_SCALE_HEIGHT = 1200;  // m, valeur des atmosphères de référence
const ANGSTROM = 1.3;               // exposant continental standard

export function tauAerosol(visibilityM) {
	const t550 = (KOSCHMIEDER / Math.max(1, visibilityM)) * AEROSOL_SCALE_HEIGHT;
	return LAMBDA.map((l) => t550 * Math.pow(l / 0.550, -ANGSTROM));
}

// Ce qui reste du faisceau direct après la traversée. C'est la formule qui fait
// le coucher de soleil : à 30 masses d'air le bleu est parti et le rouge reste.
export function transmittance(m, visibilityM) {
	const ta = tauAerosol(visibilityM);
	return TAU_RAYLEIGH.map((tr, i) => Math.exp(-(tr + ta[i]) * m));
}

// ---------------------------------------------------------------------------
// La couleur du ciel
//
// La scène n'a qu'UNE couleur de ciel — c'est celle que lisent scene.background,
// le fog des tuiles, rainfall.js et le uSky de lens.js. Elle est donc la couleur
// moyenne du dôme, et pas celle d'une direction particulière.
//
// Chroma et luminance sont calculées séparément, et c'est délibéré : elles ne
// suivent pas la même loi. Quand le soleil se couche, l'éclairement du sol
// s'effondre bien plus vite que la luminance du ciel — c'est exactement pour ça
// qu'un ciel de fin de journée est éclatant au-dessus d'une ville déjà sombre.
// Les confondre donnait un crépuscule uniformément gris.

export const REF_ELEV = 60;         // l'élévation de calibrage
export const REF_VIS = 25000;       // et sa visibilité : de l'air clair
export const SKY_REF = 0x9fb8cc;    // la couleur que main.js utilise depuis toujours

// De combien le dôme subit le trajet oblique du faisceau. Pas 1 : le zénith ne
// le voit pas du tout et l'horizon le voit entièrement, et la moyenne du dôme
// est entre les deux. À 1 le ciel virait au brun bien trop haut dans le ciel.
// Choisi à l'œil, comme K1/K2 dans lens.js — et déclaré comme tel.
const SKY_SLANT = 0.6;
// Au-delà d'une épaisseur optique de vue de cet ordre, la diffusion multiple
// domine et lave la couleur : c'est pour ça qu'un brouillard est blanc et non
// bleu foncé. Sans ce terme, le modèle mono-diffusion rendait un ciel NOIR dans
// la purée de pois, ce qui est le contraire de ce qu'on voit.
const MS_TAU = 2.0;
// Le ciel de nuit, en chromaticité. Bleu profond, jamais noir : l'imagerie est
// photographiée en plein jour et une ville rigoureusement noire serait à la fois
// fausse et injouable.
const NIGHT_CHROMA = [0.250, 0.330, 0.420];

const clamp01 = (v) => clamp(v, 0, 1);
const smoothstep = (a, b, x) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const normalize3 = (c) => {
	const s = c[0] + c[1] + c[2] || 1;
	return [c[0] / s, c[1] / s, c[2] / s];
};

export function skyChroma(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	const m = airMass(refracted(elevationDeg));
	const mSky = 1 + (m - 1) * SKY_SLANT;
	const ta = tauAerosol(visibilityM);
	// Ce qui atteint le volume diffusant, après le trajet oblique.
	const T = TAU_RAYLEIGH.map((tr, i) => Math.exp(-(tr + ta[i]) * mSky));
	// Ce que ce volume rediffuse vers nous. Rayleigh est sélectif (le bleu) ;
	// la diffusion de Mie par les aérosols est quasi neutre, ce qui est
	// précisément pourquoi la brume blanchit le ciel au lieu de le bleuir.
	const grey = 1 - Math.exp(-ta[1]);
	const single = normalize3(T.map((t, i) => t * ((1 - Math.exp(-TAU_RAYLEIGH[i])) + grey)));

	// Lavage par diffusion multiple, piloté par l'épaisseur optique de la VUE et
	// non par celle du faisceau : sinon un coucher de soleil par temps clair
	// virait au gris, alors que c'est le brouillard qui lave, pas la distance
	// que le faisceau a parcourue avant d'arriver.
	const ms = clamp01(1 - Math.exp(-(TAU_RAYLEIGH[1] + ta[1]) / MS_TAU));
	const w = clamp01(ms + (1 - ms) * Math.pow(clamp01(cloudPct / 100), 1.5));
	const day = single.map((c) => c * (1 - w) + w / 3);

	// Sous l'horizon la diffusion simple ne décrit plus rien : la lumière vient
	// de la haute atmosphère, plusieurs fois diffusée. Le modèle passe la main,
	// mais sur les seuils crépusculaires réels — civil −6°, nautique −12°,
	// astronomique −18° — et non sur des paliers ronds.
	const night = smoothstep(-2, -14, elevationDeg);
	return day.map((c, i) => c * (1 - night) + NIGHT_CHROMA[i] * night);
}

// ---------------------------------------------------------------------------
// Les deux niveaux
//
// LUM_* : l'éclairement du sol, ce qui décide de l'exposition.
// SKY_* : la luminance du dôme, qui tombe beaucoup plus lentement.

const AMBIENT_EXP = 0.6;      // ajustement standard de l'éclairement diffus en (sin h)^n
const SKY_EXP = 0.25;         // le ciel s'assombrit bien plus lentement que le sol
// Loi crépusculaire : la luminance du ciel perd une décade tous les 6° de
// dépression solaire. C'est un résultat mesuré, pas une rampe. Le dôme la perd
// plus lentement que le sol, d'où les deux décades différentes.
const JOIN = 3;               // au-dessus, la loi diurne ; en dessous, la crépusculaire
const AMBIENT_DECADE = 6;
const SKY_DECADE = 9;
// Les deux planchers de nuit. C'est LE seul endroit où la jouabilité l'emporte
// sur la physique : le vrai rapport jour/nuit est de l'ordre de 10^7, et une
// ville à 10^-7 serait un écran noir. Le couple (plancher, E_MAX) est calibré
// pour que la nuit pleine rende une image sombre mais pilotable — le banc le
// vérifie, plutôt que de faire confiance à ces deux nombres.
const NIGHT_AMBIENT = 0.05;
const NIGHT_SKY = 0.10;
// Un ciel couvert divise l'éclairement du sol par ~3 et laisse le dôme presque
// aussi lumineux — c'est le couvercle blanc au-dessus d'une ville éteinte.
const OVERCAST_AMBIENT = 0.35;
const OVERCAST_SKY = 0.75;

function level(elevationDeg, exponent, decade, floor) {
	const ref = Math.pow(Math.sin(REF_ELEV * D2R), exponent);
	const day = elevationDeg > 0 ? Math.pow(Math.sin(elevationDeg * D2R), exponent) / ref : 0;
	const join = Math.pow(Math.sin(JOIN * D2R), exponent) / ref;
	// La loi crépusculaire ne vaut QUE sous le raccord : au-dessus,
	// 10^((h−3)/6) diverge et écraserait le jour.
	const twilight = elevationDeg < JOIN ? join * Math.pow(10, (elevationDeg - JOIN) / decade) : 0;
	return Math.max(floor, day, twilight);
}

const cloudFactor = (cloudPct, overcast) =>
	1 - Math.pow(clamp01(cloudPct / 100), 1.2) * (1 - overcast);

export function ambientLevel(elevationDeg, cloudPct = 0) {
	return level(elevationDeg, AMBIENT_EXP, AMBIENT_DECADE, NIGHT_AMBIENT)
		* cloudFactor(cloudPct, OVERCAST_AMBIENT);
}

export function skyLevel(elevationDeg, cloudPct = 0) {
	return level(elevationDeg, SKY_EXP, SKY_DECADE, NIGHT_SKY)
		* cloudFactor(cloudPct, OVERCAST_SKY);
}

// ---------------------------------------------------------------------------
// Balance des blancs
//
// Le modèle rend une radiance relative ; la caméra, elle, a une balance des
// blancs, et sur une caméra FPV elle est verrouillée. La nôtre est calibrée une
// fois pour toutes sur le ciel clair de midi, et le nombre qui en sort est
// exactement ce qui fait retomber la référence sur #9FB8CC.
//
// C'est ce qui tient la promesse de non-régression : dans les conditions où le
// sim tournait déjà, il rend exactement la même image. Toute la VARIATION —
// coucher, couvert, nuit — continue de sortir du modèle.
const WHITE_BALANCE = (() => {
	const ref = skyChroma(REF_ELEV, REF_VIS, 0);
	const target = [(SKY_REF >> 16 & 255) / 255, (SKY_REF >> 8 & 255) / 255, (SKY_REF & 255) / 255];
	return target.map((t, i) => t / ref[i]);
})();

// De combien le ciel est plus lumineux que ce pour quoi la caméra expose. Le
// rapport brut atteint 2,5 au crépuscule et brûlerait le ciel en blanc pur, ce
// qui emporterait justement la couleur d'heure dorée qu'on cherche. Comprimé en
// loi de puissance : la variation reste lisible, la teinte survit.
const SKY_COMPRESS = 0.35;

// La couleur que main.js pousse vers ses quatre consommateurs.
export function skyColor(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	const rel = Math.pow(skyLevel(elevationDeg, cloudPct) / ambientLevel(elevationDeg, cloudPct),
		SKY_COMPRESS);
	const c = skyChroma(elevationDeg, visibilityM, cloudPct);
	return {
		r: clamp01(c[0] * WHITE_BALANCE[0] * rel),
		g: clamp01(c[1] * WHITE_BALANCE[1] * rel),
		b: clamp01(c[2] * WHITE_BALANCE[2] * rel),
	};
}

// ---------------------------------------------------------------------------
// Le disque

// Un ciel couvert ne divise pas le soleil par deux : il l'efface. Le carré
// laisse un soleil encore perceptible à 40 % de couverture (le régime CLOUD) et
// rigoureusement rien à 100 % (OVERCAST). Exposant à l'œil, déclaré comme tel.
const CLOUD_KILL = 2;

export function sunDisc(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	// Réfracté : le disque qu'on VOIT est encore là quand le soleil est
	// géométriquement couché.
	const h = refracted(elevationDeg);
	if (h <= 0) return { color: { r: 0, g: 0, b: 0 }, amount: 0 };

	const T = transmittance(airMass(h), visibilityM);
	const ref = transmittance(airMass(REF_ELEV), REF_VIS);
	// Luminance relative du faisceau, par rapport à la référence de calibrage.
	// Rec.709, la même base que partout ailleurs dans le projet.
	const lum = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
	const amount = clamp01(lum(T) / lum(ref))
		* Math.pow(1 - clamp01(cloudPct / 100), CLOUD_KILL)
		// Le disque disparaît dans le dernier degré plutôt que de s'éteindre
		// d'un coup au passage de l'horizon.
		* smoothstep(0, 1, h);
	const n = normalize3(T);
	// Normalisée puis remise à une luminance de 1 : la couleur du disque, sa
	// force est portée par `amount`. Sinon l'un multiplierait l'autre deux fois.
	const k = 1 / Math.max(1e-6, lum(n));
	return { color: { r: n[0] * k, g: n[1] * k, b: n[2] * k }, amount };
}
