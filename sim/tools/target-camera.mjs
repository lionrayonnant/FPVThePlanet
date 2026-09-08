// PHASE 12 — la caméra de la cible. Logique pure, AUCUNE dépendance : importée
// par le selftest (Node) et par le client (bundle Vite), comme
// tools/target-model.mjs.
//
// Le drone n'est pas le tien. Son champ, son inclinaison, son format, sa
// définition et son capteur sont ce qu'ils sont — c'est ce qui fait qu'un vol
// ne ressemble pas au précédent, avant même la première correction de manche.

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même géné que
// tools/target-model.mjs et src/link.js : petit, déterministe, rejouable).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

// Seuils de définition. Ce sont eux qui donnent un sens testable à « bonne » et
// « mauvaise » caméra : au-dessus de RES_HIGH c'est net, en dessous de RES_LOW
// les branches d'un arbre ne sont plus des branches.
export const RES_LOW = 0.6;
export const RES_HIGH = 0.8;

// La famille pose le terrain, la graine tire dedans : deux toothpick n'ont pas
// la même caméra, mais aucun toothpick n'a une bonne caméra. C'est LA table à
// régler pour le ressenti — rien d'autre dans ce fichier n'a besoin de bouger.
//
// `quality` (0..1) est l'axe unique du capteur : tout le bloc `sensor` en
// découle, pour qu'une caméra ne puisse pas être à la fois nette et bruitée.
// `aspects` est une liste avec répétitions : c'est la pondération du tirage.
export const CAMERA_FAMILIES = {
	// Faite pour filmer : douce, propre, presque droite.
	cinewhoop:  { fovDeg: [105, 125], uptiltDeg: [0, 10],  aspects: ['16:9'],                 resScale: [0.85, 1.00], quality: [0.75, 1.00] },
	// Cinéma lourd : même logique, un peu plus de champ.
	heavy5:     { fovDeg: [100, 120], uptiltDeg: [0, 15],  aspects: ['16:9'],                 resScale: [0.85, 1.00], quality: [0.70, 1.00] },
	// Longue distance : on regarde loin, donc plus serré, et le matériel est bon.
	longrange:  { fovDeg: [ 90, 110], uptiltDeg: [10, 25], aspects: ['16:9'],                 resScale: [0.80, 1.00], quality: [0.70, 1.00] },
	// Ça dépend : toute l'étendue, c'est la famille où l'on ne sait pas d'avance.
	freestyle5: { fovDeg: [100, 150], uptiltDeg: [15, 35], aspects: ['4:3', '16:9'],          resScale: [0.45, 1.00], quality: [0.25, 1.00] },
	// Course : très inclinée, latence avant image, matériel bas de gamme rapide.
	race5:      { fovDeg: [110, 140], uptiltDeg: [25, 45], aspects: ['4:3', '4:3', '16:9'],   resScale: [0.50, 0.75], quality: [0.30, 0.60] },
	// Une bouse, et c'est le sujet.
	toothpick:  { fovDeg: [110, 160], uptiltDeg: [10, 40], aspects: ['4:3'],                  resScale: [0.30, 0.50], quality: [0.00, 0.30] },
	// An observation machine, not a flying one: moderate uptilt (it looks
	// ahead, not down at the ground like a race), a sane field of view, decent
	// mesh-radio gear — never the best on the shelf, never junk either.
	swarmNode:  { fovDeg: [ 95, 115], uptiltDeg: [10, 20],  aspects: ['16:9'],                 resScale: [0.75, 1.00], quality: [0.55, 0.85] },
};

const FALLBACK_FAMILY = 'freestyle5';

const lerp = (rand, [lo, hi]) => lo + rand() * (hi - lo);
const mix = (a, b, t) => a + (b - a) * t;

export function targetCamera({ seed, family } = {}) {
	const table = CAMERA_FAMILIES[family] ?? CAMERA_FAMILIES[FALLBACK_FAMILY];
	const rand = rngFrom(`${seed}::camera::${family}`);

	const fovDeg = lerp(rand, table.fovDeg);
	const uptiltDeg = lerp(rand, table.uptiltDeg);
	const aspectName = table.aspects[Math.floor(rand() * table.aspects.length)];
	const resScale = lerp(rand, table.resScale);
	const q = lerp(rand, table.quality);

	// Tout le capteur descend de `q`. Écrit dans le sens « 0 = parfait » pour
	// chaque défaut, pour qu'un uniform à zéro veuille dire « rien à faire ».
	const sensor = {
		grain: mix(0.070, 0.004, q),       // bruit propre au capteur, lien parfait compris
		lift: mix(0.100, 0.004, q),        // noirs levés
		saturation: mix(0.70, 1.00, q),    // fadeur (1 = couleurs intactes)
		ringing: mix(0.90, 0.02, q),       // halo de sur-accentuation sur les contours
		clip: mix(0.80, 0.03, q),          // écrasement des hautes lumières
		// Indépendant de la qualité : c'est le décodeur, pas le capteur. À 0 la
		// caméra meurt en gris, à 1 en arc-en-ciel.
		crossColor: rand(),
		tintHue: rand(),
		tintAmount: mix(0.20, 0.01, q),
	};

	return {
		fovDeg,
		uptiltDeg,
		aspectName,
		aspect: aspectName === '4:3' ? 4 / 3 : 16 / 9,
		resScale,
		sensor,
	};
}
