// Le CHÂSSIS d'un exemplaire (issue #285) — logique pure, comme
// tools/target-livery.mjs. Deux freestyle n'ont pas le même châssis : l'un est
// un X pur, l'autre un deadcat au corps reculé, un troisième un H. Les moteurs,
// eux, ne bougent pas : armX/armZ sont des invariants de famille (la physique
// les lit), et la silhouette des ambiants est gelée. Ce qui varie est donc
// l'endroit d'où PARTENT les bras, la plaque qui les porte, leur largeur, la
// hauteur de la cage — aux niveaux `onboard` et `portrait` seulement.
//
// Flux de graine à part (`seed::frame`), comme la livrée : aucun tirage
// physique ne bouge en l'ajoutant.

// Les patrons. `start(m)` rend le point d'attache d'un bras, dans le repère du
// corps, à partir de la position (x, z) de son moteur et des invariants.
//   x        : les quatre bras partent du centre — le X classique.
//   h        : un corps long, les bras perpendiculaires à ses deux bouts.
//   deadcat  : le corps est reculé, les bras avant sont longs, les arrière
//              courts — la caméra ne voit pas les hélices avant.
//   unibody  : plaque large, bras courts qui partent de ses coins.
export const PATTERNS = {
	x:       { start: (m) => [0, 0, 0],                              plate: [0.80, 1.10], shift: 0 },
	h:       { start: (m, i) => [0, 0, 0.55 * i.armZ * Math.sign(m.z)], plate: [0.38, 1.30], shift: 0 },
	deadcat: { start: (m, i) => [0.18 * i.armX * Math.sign(m.x), 0, 0.18 * i.armZ], plate: [0.70, 0.95], shift: 0.16 },
	unibody: { start: (m, i) => [0.42 * i.armX * Math.sign(m.x), 0, 0.42 * i.armZ * Math.sign(m.z)], plate: [1.00, 1.05], shift: 0 },
};

// Les patrons qu'une famille connaît, et leur fréquence.
export const PATTERN_ODDS = {
	race5:      [['x', 0.60], ['unibody', 0.25], ['h', 0.15]],
	freestyle5: [['x', 0.50], ['deadcat', 0.30], ['h', 0.20]],
	cinewhoop:  [['unibody', 0.80], ['x', 0.20]],
	toothpick:  [['unibody', 0.60], ['x', 0.40]],
	longrange:  [['x', 0.50], ['deadcat', 0.35], ['h', 0.15]],
	heavy5:     [['x', 0.60], ['h', 0.40]],
};
const DEFAULT_ODDS = PATTERN_ODDS.freestyle5;

// Largeur des bras et hauteur de la cage, en multiples de la famille.
export const ARM_K = [0.85, 1.35];
export const CAGE_K = [0.85, 1.20];

export function frameOf(rand, family) {
	const odds = PATTERN_ODDS[family] ?? DEFAULT_ODDS;
	let r = rand(), pattern = odds[odds.length - 1][0];
	for (const [name, p] of odds) { if (r < p) { pattern = name; break; } r -= p; }
	const armK = ARM_K[0] + rand() * (ARM_K[1] - ARM_K[0]);
	const cageK = CAGE_K[0] + rand() * (CAGE_K[1] - CAGE_K[0]);
	return { pattern, armK, cageK };
}

// Le point d'attache d'un bras pour ce châssis, ou le centre si le châssis
// est inconnu (silhouette, profil nominal).
export function armStart(frame, motor, invariants) {
	const p = PATTERNS[frame?.pattern];
	return p ? p.start(motor, invariants) : [0, 0, 0];
}
export function plateOf(frame, invariants) {
	const p = PATTERNS[frame?.pattern] ?? PATTERNS.x;
	return { width: p.plate[0] * invariants.armX, length: p.plate[1] * invariants.armZ, shift: p.shift * invariants.armZ };
}
