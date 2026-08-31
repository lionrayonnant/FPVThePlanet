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

export function* octantsCovering(zone, level) {
	function* walk(pathArr, box) {
		if (pathArr.length === level) { yield { path: pathArr.join(''), box }; return; }
		for (const { key, box: b } of childBoxes(box)) {
			if (boxIntersects(b, zone)) {
				pathArr.push(key);
				yield* walk(pathArr, b);
				pathArr.pop();
			}
		}
	}
	const pathArr = [];
	for (const [path, box] of ROOTS) {
		if (boxIntersects(box, zone)) {
			for (const ch of path) pathArr.push(ch);
			yield* walk(pathArr, box);
			pathArr.length = 0;
		}
	}
}
