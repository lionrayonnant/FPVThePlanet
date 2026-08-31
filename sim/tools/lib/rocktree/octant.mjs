// Adressage d'octree rocktree : la Terre en 8 racines de 2 digits, puis chaque
// digit ajoute une subdivision (2 bits lat/lon + 1 bit vertical). Réécrit
// d'après la documentation de protocole d'earth-reverse-engineering.

export const ROOTS = [
	['02', { n: 0, s: -90, w: -180, e: -90 }], ['03', { n: 0, s: -90, w: -90, e: 0 }],
	['12', { n: 0, s: -90, w: 0, e: 90 }],     ['13', { n: 0, s: -90, w: 90, e: 180 }],
	['20', { n: 90, s: 0, w: -180, e: -90 }],  ['21', { n: 90, s: 0, w: -90, e: 0 }],
	['30', { n: 90, s: 0, w: 0, e: 90 }],      ['31', { n: 90, s: 0, w: 90, e: 180 }],
];

export function rootOctant(lat, lon) {
	const [path, box] = ROOTS.find(([, b]) => lat >= b.s && (lat < b.n || b.n === 90) && lon >= b.w && (lon < b.e || b.e === 180));
	return { path, box };
}

export function childBoxes(box) {
	const midLat = (box.n + box.s) / 2, midLon = (box.w + box.e) / 2;
	const out = [];
	for (let key = 0; key < 8; key++) {
		const north = !!(key & 2), east = !!(key & 1);
		const b = {
			n: north ? box.n : midLat, s: north ? midLat : box.s,
			w: box.w, e: box.e,
		};
		// Aux calottes polaires la découpe est/ouest n'existe pas : la moitié
		// est (bit 0) est vide, tout vit côté 0.
		const polar = b.n === 90 || b.s === -90;
		if (!polar) { if (east) b.w = midLon; else b.e = midLon; }
		else if (east) continue;
		out.push({ key, box: b });
	}
	return out;
}

export function boxIntersects(box, zone) {
	return box.s < zone.north && box.n > zone.south && box.w < zone.east && box.e > zone.west;
}

// Boîtes des préfixes d'UN SEUL digit. Une racine fait 2 digits (ROOTS), donc
// le premier digit ne nomme pas une racine mais la paire de racines qui
// commence par lui — un quart de globe (un hémisphère × une moitié de
// longitude), que le second digit recoupe en deux. Dérivé de ROOTS plutôt
// qu'écrit à la main : la table reste la seule source de vérité.
const ROOT_HALVES = new Map();
for (const [p, b] of ROOTS) {
	const cur = ROOT_HALVES.get(p[0]);
	ROOT_HALVES.set(p[0], cur
		? { n: Math.max(cur.n, b.n), s: Math.min(cur.s, b.s), w: Math.min(cur.w, b.w), e: Math.max(cur.e, b.e) }
		: { ...b });
}

// Descend d'UN digit le long d'un chemin d'octree et rend la boîte de
// l'enfant. `pathSoFar` est le chemin DÉJÀ parcouru (sans `digit`) : c'est lui
// qui dit à quelle profondeur on se trouve, car les deux premiers digits
// adressent une racine et non un childBoxes() ordinaire.
//
// Rend `null` quand le digit n'existe pas géométriquement à cet endroit — un
// digit hors [0,7], un préfixe de 2 digits qui n'est pas une racine, ou une
// clé « est » sous une calotte polaire (childBoxes ne les émet pas : au pôle
// la découpe est/ouest n'existe pas). `null` veut dire « cette branche de
// l'octree est impossible », à distinguer de « elle existe mais est hors
// zone » : dans les deux cas on élague, mais pas pour la même raison.
export function descendBox(box, pathSoFar, digit) {
	if (pathSoFar.length === 0) return ROOT_HALVES.get(digit) ?? null;
	if (pathSoFar.length === 1) return ROOTS.find(([p]) => p === pathSoFar + digit)?.[1] ?? null;
	return childBoxes(box).find((c) => c.key === Number(digit))?.box ?? null;
}
