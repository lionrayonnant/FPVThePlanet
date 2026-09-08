// Niveau de détail par anneaux pour la fenêtre de streaming (lionrayonnant/FPVTP#296).
//
// La fenêtre chargeait TOUT au même niveau d'octree (21, ~0,1 m/texel)
// jusqu'à 600 m : 1494 nœuds à 300 m, ~6000 à 600 m, chacun ~624 Kio décodés
// et un draw call. Or à 150 m, sur un écran 1080p en FOV FPV (~110°), un
// pixel couvre déjà ~0,2 m au sol : au-delà, le niveau 21 est sous-pixel.
// Chaque niveau de moins divise par ~4 le nombre de nœuds d'une même surface.
//
// Le principe : une traversée PAR NIVEAU (tools/lib/rocktree/traverse.mjs,
// inchangée), sur des disques emboîtés ; puis un assemblage PUR ici, qui
// choisit pour chaque zone le nœud de l'anneau le plus fin qui la recoupe, et
// fait EXCLURE aux nœuds plus grossiers les octants qu'un nœud plus fin
// dessine déjà — c'est le mécanisme `exclude` de build-node.mjs, celui qui
// évitait déjà le z-fight parent/enfant dans une seule traversée. Ni deux
// nœuds pour le même sol, ni trou à la frontière : verrouillé par
// tools/rocktree-lod-selftest.mjs sur un octree synthétique complet.
//
// Sans dépendance à Three ni au réseau : portable Node (selftest) et Worker.

// CHOISI, pas mesuré à l'écran — l'argument est celui du pixel ci-dessus :
// niveau plein (le `level` de la fenêtre, 21) jusqu'à 150 m, un niveau de
// moins jusqu'à 300 m, deux au-delà. Le drone reste toujours dans le premier
// anneau : la fenêtre se recentre tous les REFRESH_THRESHOLD_M (50 m), donc
// la collision qu'il touche est toujours au niveau plein. À revoir en vol
// si la couture entre anneaux se voit (texture 2× plus grossière d'un coup).
export const LOD_RINGS = [
	{ radiusM: 150, levelDrop: 0 },
	{ radiusM: 300, levelDrop: 1 },
	{ radiusM: Infinity, levelDrop: 2 },
];

// Le plancher du niveau : traverse() borne à [2, 22], et sous 14 un nœud
// couvre des kilomètres — hors sujet pour une fenêtre de 600 m au plus.
const MIN_LEVEL = 14;

const M_PER_DEG_LAT = 111320;

export function metersBetween(a, b) {
	const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
	const dLon = (a.lon - b.lon) * M_PER_DEG_LAT * Math.cos((a.lat / 180) * Math.PI);
	return Math.hypot(dLat, dLon);
}

// La box lat/lon d'un nœud recoupe-t-elle le DISQUE de `radiusM` mètres
// autour de `center` ? (lionrayonnant/FPVTP#295) Point de la box le plus proche du centre
// (clamp), puis distance plate : la même approximation locale que
// metersBetween(). Une box à cheval sur le bord recoupe (≤, pas <).
export function boxIntersectsDisc(box, center, radiusM) {
	const lat = Math.min(Math.max(center.lat, box.s), box.n);
	const lon = Math.min(Math.max(center.lon, box.w), box.e);
	return metersBetween(center, { lat, lon }) <= radiusM;
}

// La box est-elle ENTIÈREMENT dans le disque ? Un disque est convexe : ses
// quatre coins dedans suffisent.
export function boxInsideDisc(box, center, radiusM) {
	return metersBetween(center, { lat: box.s, lon: box.w }) <= radiusM
		&& metersBetween(center, { lat: box.s, lon: box.e }) <= radiusM
		&& metersBetween(center, { lat: box.n, lon: box.w }) <= radiusM
		&& metersBetween(center, { lat: box.n, lon: box.e }) <= radiusM;
}

// Les anneaux concrets pour un rayon de chargement et un niveau plein : rayons
// bornés au rayon de chargement, du plus fin au plus grossier, sans anneau
// vide (un rayon de 100 m ne donne qu'un anneau au niveau plein).
export function ringsFor(loadRadiusM, level, rings = LOD_RINGS) {
	const out = [];
	let inner = 0;
	for (const ring of rings) {
		if (inner >= loadRadiusM) break;
		const radiusM = Math.min(ring.radiusM, loadRadiusM);
		out.push({ radiusM, level: Math.max(MIN_LEVEL, level - ring.levelDrop) });
		inner = radiusM;
	}
	return out;
}

// Assemble les nœuds de chaque anneau (du plus fin au plus grossier ; chaque
// entrée porte le rayon EXTÉRIEUR de son anneau et les nœuds de sa traversée)
// en une seule liste sans recouvrement :
//
//   - un chemin déjà retenu par un anneau plus fin ne l'est pas deux fois
//     (fill-in : la même colonne peut rendre le même nœud peu profond aux
//     deux niveaux) ;
//   - un nœud d'un anneau n'est retenu que s'il recoupe le disque de son
//     anneau, et, hors du premier, s'il n'est pas ENTIÈREMENT dans le disque
//     de l'anneau plus fin (là, tout est déjà dessiné plus fin) ;
//   - un nœud retenu exclut chaque octant sous lequel un nœud DÉJÀ retenu
//     descend (`prefixes`), et chacun de ses ancêtres déjà retenus exclut
//     l'octant qui mène à lui — dans les deux sens, parce qu'un anneau plus
//     fin peut porter un fill-in PEU profond (rien de plus fin n'existe dans
//     sa colonne côté disque intérieur) qu'un anneau plus grossier raffine
//     quand même côté extérieur, où sa traversée voit plus loin.
//
// Le résultat conserve l'`exclude` que traverse() a déjà posé et y ajoute
// les octants ci-dessus ; `level` est celui de l'anneau qui a retenu le
// nœud, pour le débogage.
export function assembleLod(rings, center) {
	const selected = new Map();   // path -> node (exclude: Set)
	const prefixes = new Set();   // tous les préfixes (1..n digits) des chemins retenus
	let inner = 0;
	for (const ring of rings) {
		for (const n of ring.nodes) {
			if (selected.has(n.path)) continue;
			if (n.box) {
				if (!boxIntersectsDisc(n.box, center, ring.radiusM)) continue;
				if (inner > 0 && boxInsideDisc(n.box, center, inner)) continue;
			}
			const exclude = new Set(n.exclude ?? []);
			for (let d = 0; d < 8; d++) if (prefixes.has(n.path + d)) exclude.add(d);
			for (let len = 1; len < n.path.length; len++) {
				const ancestor = selected.get(n.path.slice(0, len));
				if (ancestor) ancestor.exclude.add(Number(n.path[len]));
			}
			selected.set(n.path, { ...n, exclude, level: ring.level });
			for (let len = 1; len <= n.path.length; len++) prefixes.add(n.path.slice(0, len));
		}
		inner = ring.radiusM;
	}
	return [...selected.values()].map((n) => ({ ...n, exclude: [...n.exclude].sort((a, b) => a - b) }));
}
