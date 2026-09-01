// Marche dans l'octree rocktree (issue #18, #153) et tout ce qui l'entoure —
// extrait de tools/lib/providers/google-earth.mjs (#168, tranche « fenêtre de
// streaming ») : ce code ne dépend de rien de Node (vérifié par grep ciblé
// avant d'écrire ce module), contrairement au fichier où il vivait, qui
// importe node:url pour son cache de préparation sur disque — sans rapport,
// mais un import ESM statique casse tout le module dans un Worker navigateur
// qu'il soit utilisé ou non. Même raison que url.mjs (nodeUrl/PREFIX) avant
// lui.
import { PREFIX } from './url.mjs';
import { parsePlanetoid, parseBulk } from './proto.mjs';
import { descendBox, boxIntersects } from './octant.mjs';
import { polygonBounds } from '../tiles.mjs';

// Réseau remplaçable par les tests (fixtures à la place de kh.google.com).
export const _net = {
	async http(url, { signal } = {}) {
		const res = await globalThis.fetch(url, { signal });
		if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
		return new Uint8Array(await res.arrayBuffer());
	},
};

// Table MESURÉE (Task 8, issue #18) : zoom GUI -> niveau d'octree, calibrée
// hors-ligne sur tools/testdata/rocktree/ (capture Paris, epoch 1014) avec
// tools/rocktree-calibrate.mjs. Le m/texel de l'octree décroît en puissance
// de 2 par niveau, EXACTEMENT comme le m/px Flyover décroît en puissance de
// 2 par zoom (156543.03*cos(lat)/2^zoom, la référence du zoom actuel) : le
// rapport mesuré (m/texel du niveau retenu / m/px Flyover) est constant à
// travers zoom 13-20, ≈1.032 — donc un DÉCALAGE CONSTANT, niveau = zoom+1,
// pas une intuition mais ce que dit la mesure :
//
// zoom | Flyover m/px (lat 48.858°) | niveau | m/texel mesuré | ratio
//   13 |                    12.5725 |     14 |         12.9761 | 1.032
//   14 |                     6.2863 |     15 |          6.4850 | 1.032
//   15 |                     3.1431 |     16 |          3.2424 | 1.032
//   16 |                     1.5716 |     17 |          1.6212 | 1.032
//   17 |                     0.7858 |     18 |          0.8106 | 1.032
//   18 |                     0.3929 |     19 |          0.4053 | 1.032
//   19 |                     0.1964 |     20 |          0.2026 | 1.032
//   20 |                     0.0982 |     21 |          0.1013 | 1.032
//
// Niveau 22 est le plus profond mesuré dans la capture (les nœuds réels des
// fixtures descendent jusque-là) ; les niveaux 23-24 lus dans les bulks des
// fixtures sont à 0.0 (champ non renseigné faute de subdivision connue à
// cette profondeur dans cette capture) — pas une mesure, donc la sortie est
// plafonnée à 22. Niveau 2 est le plancher : un chemin de racine (ROOTS dans
// octant.mjs) fait déjà 2 digits, c'est donc le niveau le moins profond qui
// désigne un octant. Aucune valeur de zoom utilisée par la GUI (~13-20, cf.
// README) n'approche ce plancher.
const ZOOM_TO_LEVEL = { 13: 14, 14: 15, 15: 16, 16: 17, 17: 18, 18: 19, 19: 20, 20: 21 };
export function zoomToLevel(zoom) {
	const z = Math.round(zoom);
	if (ZOOM_TO_LEVEL[z] != null) return ZOOM_TO_LEVEL[z];
	// Hors de la plage calibrée ci-dessus : même décalage constant mesuré
	// (niveau = zoom+1), borné à [2, 22] pour les raisons ci-dessus.
	return Math.max(2, Math.min(22, z + 1));
}

// Plafond de sécurité de la traversée, en NŒUDS RETENUS.
//
// Il remplace un garde-fou qui mesurait la mauvaise chose : l'ancien comparait
// un nombre de COLONNES lat/lon (~4 400 pour une zone de 500 m au niveau 21) à
// une limite de 200 000, alors que le coût réel était colonnes × 2^(niveau-2),
// soit ~2·10^9. Il ne se déclenchait donc jamais là où il aurait fallu, et un
// téléchargement de zone ordinaire partait pour des heures (issue #153).
//
// Ce n'est pas un optimum mesuré, c'est un arrêt de catastrophe. Repère réel :
// le bake `ge-champ-de-mars` (rayon 120 m, niveau 21) retient 91 nœuds ;
// 50 000 nœuds valent donc de l'ordre de 2,8 km de côté — très au-delà de
// toute scène FPV, tout en empêchant un bbox tracé à l'échelle d'un pays de
// lancer des dizaines de Go de NodeData en silence.
const MAX_NODES = 50_000;

// Bulks demandés en parallèle. Une génération de la marche descendante tient
// dans quelques dizaines de requêtes : les paralléliser par petits lots change
// une traversée d'une minute en une de quelques secondes, sans ouvrir des
// centaines de connexions d'un coup. Même esprit que le BATCH de
// downloadNodes() dans google-earth.mjs.
const BULK_BATCH = 8;

// poly -> bbox du ring ; bbox -> bbox tel quel ; sinon carré de `radius`
// mètres autour de (lat, lon) — converti en degrés via cos(lat), comme
// tiles.mjs le fait pour Flyover.
export function zoneOf({ lat, lon, radius = 25, bbox, poly }) {
	if (poly) return polygonBounds(poly);
	if (bbox) return bbox;
	const dLat = (radius / 111320);
	const dLon = dLat / Math.cos((lat / 180) * Math.PI);
	return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

export async function getPlanetoid({ signal }) {
	const buf = await _net.http(PREFIX + 'PlanetoidMetadata', { signal });
	return parsePlanetoid(buf); // { rootEpoch, radius }
}

// Une bulk absente (404/410) veut dire « cette branche de l'octree n'est pas
// dans la capture » — pas une erreur : la traversée doit s'en accommoder
// (c'est le mécanisme même que le mock des tests exerce).
export async function fetchBulk(bulkPath, epoch, { signal }) {
	try {
		const buf = await _net.http(`${PREFIX}BulkMetadata/pb=!1m2!1s${bulkPath}!2u${epoch}`, { signal });
		return { ...parseBulk(buf), epoch };
	} catch (e) {
		if (e.status === 404 || e.status === 410) return null;
		throw e;
	}
}

// fill-in ancestors (issue #18 Task 9, ruling après échec réel de bake) :
// `lastGood`, dans traverse() ci-dessous, retient PAR COLONNE cible le nœud
// le plus profond dont le NodeData est réellement disponible — pas
// forcément un LEAF. Quand une colonne voisine descend plus loin sur le
// même chemin, ce nœud moins profond redevient un pur ancêtre, et son
// maillage (hors l'octant qui continue) couvre alors une cellule bien plus
// grande que la petite zone demandée — jusqu'à un quart d'hémisphère près
// de la racine. L'inclure a produit une origine à des milliers de km de
// Paris et un maillage sans sol trouvable (bake Champ de Mars, radius 120).
// Un nœud est un pur ancêtre ssi un AUTRE nœud retenu prolonge son chemin —
// pas seulement son enfant direct (path+1 digit) : les niveaux NODATA
// intermédiaires sautés par traverse() font que le prochain nœud réel peut
// être 2+ digits plus profond. Triés, les chemins placent un préfixe
// immédiatement avant tout ce qui le prolonge (ordre lexicographique) : un
// seul regard sur l'entrée suivante suffit à détecter un descendant.
//
// Fonction nommée et exportée séparément (plutôt que laissée en ligne dans
// traverse()) pour que rocktree-selftest.mjs verrouille l'algorithme
// lui-même sur des chemins synthétiques, sans réseau ni capture réelle qui
// doive reproduire le scénario par chance.
export function dropFillinAncestors(nodesOut) {
	const sortedPaths = [...nodesOut.keys()].sort();
	const hasDescendant = new Set();
	for (let i = 0; i + 1 < sortedPaths.length; i++) {
		if (sortedPaths[i + 1].startsWith(sortedPaths[i])) hasDescendant.add(sortedPaths[i]);
	}
	for (const p of hasDescendant) nodesOut.delete(p);
	return hasDescendant.size;
}

// Expansion d'UN bulk, sans réseau. À partir des seuls nœuds que ce bulk
// déclare, rend (a) les nœuds à retenir et (b) les bulks enfants à visiter.
//
// C'est le renversement qui fait l'issue #153. L'ancienne traversée énumérait
// d'abord toute la géométrie possible au niveau cible, puis demandait aux
// bulks si chaque chemin existait ; comme chaque digit porte 2 bits lat/lon ET
// 1 bit vertical, et que le bit vertical ne change pas la boîte lat/lon, elle
// produisait 2^(niveau-2) chemins par cellule réelle — 524 288 au niveau 21.
// Ici on part de ce que les bulks déclarent : la duplication verticale ne
// coûte plus que ce qui existe vraiment.
//
// Les chemins relatifs d'un bulk font 1 à 4 digits ; au-delà, c'est un bulk
// enfant qui prend le relais (frontière du protocole). On parcourt donc en
// profondeur l'arbre INTERNE du bulk, en raffinant la boîte digit par digit et
// en élaguant dès qu'elle ne recoupe plus la zone.
//
// Pure et exportée pour être verrouillée seule par le selftest : toute la
// logique de décision (NODATA, LEAF, niveau, frontière de bulk) tient ici,
// traverse() ne s'occupe plus que du réseau et de l'assemblage.
export function expandBulk(bulk, bulkPath, bulkBox, zone, level) {
	const retained = [];
	const children = [];
	const stack = [{ rel: '', box: bulkBox }];

	while (stack.length > 0) {
		const { rel, box } = stack.pop();
		for (let d = 0; d < 8; d++) {
			const childRel = rel + d;
			const meta = bulk.nodes.get(childRel);
			// Absent du bulk : rien de plus profond ne peut exister sous ce
			// chemin (chaque préfixe d'un nœud est déclaré, cf. selftest).
			if (!meta) continue;

			const full = bulkPath + childRel;
			// Un chemin relatif peut faire 4 digits d'un coup : sans cette
			// garde, un bulk à la profondeur 20 rendrait des nœuds de
			// profondeur 24 pour un niveau 21. L'ancienne traversée ne le
			// pouvait pas (ses cibles faisaient exactement `level` digits) —
			// c'est une divergence à ne pas introduire.
			if (full.length > level) continue;

			const childBox = descendBox(box, bulkPath + rel, String(d));
			// null = branche géométriquement impossible (clé est sous une
			// calotte polaire) ; sinon on élague sur la zone.
			if (!childBox || !boxIntersects(childBox, zone)) continue;

			// NODATA (flags & 8) : le nœud existe comme maillon du chemin mais
			// ne sert pas de NodeData — on le traverse sans le retenir.
			if (!(meta.flags & 8)) retained.push({ path: full, meta });

			// LEAF (flags & 4) : la branche est refermée, aucun bulk enfant
			// n'existe en dessous.
			if (meta.flags & 4) continue;
			if (full.length >= level) continue;

			if (childRel.length === 4) children.push({ bulkPath: full, box: childBox, epoch: meta.bulkEpoch ?? bulk.epoch });
			else stack.push({ rel: childRel, box: childBox });
		}
	}
	return { retained, children };
}

// Cœur du fournisseur : marche descendante par bulks, filtrée par la zone.
//
// On descend génération de bulks par génération de bulks (les bulks d'une même
// profondeur sont indépendants, donc demandés en parallèle par lots de
// BULK_BATCH) ; expandBulk() ci-dessus décide seul ce qui est retenu et où
// descendre. Le coût suit le nombre de nœuds réellement présents dans la zone,
// pas le nombre de cellules cibles fois 2^(niveau-2).
export async function traverse(zone, level, { signal, onLog, maxNodes = MAX_NODES, reportMs = 1500 } = {}) {
	const { rootEpoch, radius } = await getPlanetoid({ signal });
	const bulkCache = new Map();
	let visitedBulks = 0;

	// On mémorise la PROMESSE, pas le résultat : les lots parallèles ci-dessous
	// peuvent demander deux fois le même bulk avant que le premier n'ait
	// répondu, et une Map de résultats les laisserait tous deux passer au
	// réseau.
	function getBulk(bulkPath, epoch) {
		if (bulkCache.has(bulkPath)) return bulkCache.get(bulkPath);
		const p = fetchBulk(bulkPath, epoch, { signal }).then((bulk) => {
			if (bulk) visitedBulks++;
			return bulk;
		});
		bulkCache.set(bulkPath, p);
		return p;
	}

	const nodesOut = new Map();
	// Le bulk racine n'a pas de boîte parente : ses deux premiers digits
	// adressent une racine, et descendBox() le sait à la longueur du chemin.
	let frontier = [{ bulkPath: '', box: null, epoch: rootEpoch }];

	// La traversée précède tout téléchargement : le compteur de tuiles de
	// l'écran d'acquisition reste donc à 0 pendant toute sa durée. Sur une
	// grande zone c'est long — mesuré à Nantes au niveau 21 : 3,9 s pour un
	// rayon de 500 m, 13,6 s pour 1 km, 25,8 s pour 1,5 km — et sans un mot,
	// l'écran est indistinguable d'un blocage. On rend donc la marche bavarde.
	// Chaque ligne dit ce qui avance RÉELLEMENT (bulks lus, octants repérés) ;
	// on n'invente pas de fausses tuiles téléchargées.
	// `reportMs` est un point de test : le selftest le met à 0 pour vérifier
	// que la ligne est bien émise, sans avoir à faire durer une traversée.
	let lastReport = Date.now();
	const report = (force = false) => {
		if (!onLog) return;
		if (!force && Date.now() - lastReport < reportMs) return;
		lastReport = Date.now();
		onLog({ stream: 'meta', line: `repérage : ${nodesOut.size.toLocaleString('fr-FR')} octant(s), ${visitedBulks.toLocaleString('fr-FR')} bulk(s) lu(s)…` });
	};

	while (frontier.length > 0) {
		const next = [];
		for (let i = 0; i < frontier.length; i += BULK_BATCH) {
			const slice = frontier.slice(i, i + BULK_BATCH);
			const bulks = await Promise.all(slice.map((f) => getBulk(f.bulkPath, f.epoch)));
			for (let k = 0; k < slice.length; k++) {
				const bulk = bulks[k];
				// Bulk absent (404/410) : cette branche de l'octree n'est pas
				// dans la capture, ce n'est pas une erreur.
				if (!bulk) continue;
				const { retained, children } = expandBulk(bulk, slice[k].bulkPath, slice[k].box, zone, level);
				for (const { path: p, meta } of retained) {
					if (nodesOut.has(p)) continue;
					nodesOut.set(p, {
						path: p,
						epoch: meta.epoch ?? bulk.epoch,
						imageryEpoch: (meta.flags & 16) ? (meta.imageryEpoch ?? bulk.defaultImageryEpoch) : null,
						flags: meta.flags,
					});
				}
				next.push(...children);
			}
			report();
			// Plafond vérifié PENDANT la marche, pas après : le but est de
			// s'arrêter avant d'avoir dépensé le réseau, pas de constater les
			// dégâts. Voir MAX_NODES plus haut pour l'ordre de grandeur.
			if (nodesOut.size > maxNodes) {
				throw new Error(
					`zone trop grande pour ce zoom : plus de ${maxNodes.toLocaleString('fr-FR')} octants au niveau ${level}.\n` +
					'  Réduis le zoom ou la zone (rayon/bbox/polygone) avant de relancer.'
				);
			}
		}
		frontier = next;
	}

	// fill-in ancestors : voir le commentaire sur dropFillinAncestors() plus haut.
	const droppedAncestors = dropFillinAncestors(nodesOut);

	// exclude : pour chaque nœud retenu dont un enfant direct (path + 1 digit)
	// est aussi retenu, exclure cet octant — sinon parent et enfant dessinent
	// la même géométrie (z-fight, cf. décodeur). Après le filtre ci-dessus,
	// deux nœuds retenus ne sont plus jamais l'un l'ancêtre de l'autre, donc
	// ceci ne trouve normalement plus rien — gardé pour la robustesse si un
	// futur changement de traversée réintroduit des recouvrements au même
	// niveau.
	const paths = new Set(nodesOut.keys());
	const nodes = [...nodesOut.values()].map((n) => {
		const exclude = [];
		for (let d = 0; d < 8; d++) if (paths.has(n.path + d)) exclude.push(d);
		return { ...n, exclude };
	});

	onLog?.({ stream: 'meta', line: `traversée : ${nodes.length} nœud(s) (+${droppedAncestors} ancêtre(s) fill-in écarté(s)), ${visitedBulks} bulk(s) visité(s).` });
	return { nodes, visitedBulks, rootEpoch, radius };
}
