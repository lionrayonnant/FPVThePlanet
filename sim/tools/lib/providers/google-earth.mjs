// Fournisseur Google Earth : le protocole interne « rocktree » de
// earth.google.com — voir l'amendement 2026-08-31 du design #18. Pas de clé,
// pas d'API souscrite : même posture que Flyover, endpoints kh.google.com.
//
// Réseau injectable : `_net.http(url, { signal }) -> Promise<Uint8Array>` est
// le seul point de contact avec kh.google.com. Les tests le remplacent (mock
// des fixtures) plutôt que de passer par un framework d'injection — c'est le
// motif le plus simple qui permette de rejouer une capture hors-ligne.
// Uint8Array et non Buffer (#168) : ce module doit rester importable par un
// Worker navigateur, qui n'a pas l'API Buffer
import fs from 'node:fs';
import path from 'node:path';
import { parseNode, parseCopyrights } from '../rocktree/proto.mjs';
import { polyHash } from '../tiles.mjs';
import { PREFIX, nodeUrl } from '../rocktree/url.mjs';
import { paths } from '../paths.mjs';
import {
	_net, zoneOf, getPlanetoid, dropFillinAncestors, expandBulk,
	traverse, zoomToLevel,
} from '../rocktree/traverse.mjs';

// expandBulk reste exporté ici (il l'était déjà avant l'extraction) :
// rocktree-selftest.mjs l'exerce en unité pure via `ge.expandBulk(...)`.
export { _net, zoneOf, getPlanetoid, dropFillinAncestors, expandBulk, traverse, zoomToLevel };

let CACHE_ROOT = paths.GOOGLE_CACHE_DIR;
export function _cacheRootForTests(dir) { CACHE_ROOT = dir ?? paths.GOOGLE_CACHE_DIR; }

export const id = 'google-earth';
export const label = 'Google Earth';
export const attribution = ['© Google'];

// Repli d'imagerie (issue #158) : de combien de niveaux remonter pour trouver
// des nœuds qui portent RÉELLEMENT de l'imagerie.
//
// La photogrammétrie de Google s'arrête à une profondeur variable, souvent
// bien avant le niveau demandé ; en dessous, les nœuds existent mais leur
// atlas est noir. Mesuré sur deux chaînes d'ancêtres réelles au Champ de Mars
// (niveau 21 demandé) : luminance 0,1 / 2,1 aux profondeurs 19 et 18, puis
// 100,4 à la profondeur 17 — soit quatre niveaux au-dessus. Même profil sur la
// seconde chaîne (noir de 18 à 21, 112,8 en 17).
//
// Ces nœuds sont peu nombreux et peu coûteux : au niveau 17 une cellule fait
// ~305 m, donc une poignée suffit à couvrir une tuile de scène.
const FALLBACK_LEVELS_UP = 4;

// Mêmes règles que flyover.mjs (copiées avec leur justification) : le nom du
// dossier de cache est indépendant du fournisseur (cf. HANDOFF), mais chaque
// fournisseur reste libre de sa propre disposition sur disque.
export async function tileDirName({ lat, lon, zoom = 20, radius = 25, altitude = 0, bbox, poly }) {
	if (poly) return `poly-${await polyHash(poly)}-${zoom}-${altitude}`;
	if (bbox) {
		const { south, west, north, east } = bbox;
		return `bbox-${south.toFixed(6)}-${west.toFixed(6)}-${north.toFixed(6)}-${east.toFixed(6)}-${zoom}-${altitude}`;
	}
	return `${lat.toFixed(6)}-${lon.toFixed(6)}-${zoom}-${radius}-${altitude}`;
}

export async function tileDirPath(opts) {
	return path.join(CACHE_ROOT, await tileDirName(opts));
}

// rocktree-tile.json EST le marqueur d'usabilité (voir fetch() : il est écrit
// en dernier). Un dossier avec des .pb mais sans lui est un fetch interrompu.
export function tileIsUsable(dir) {
	try {
		const tile = JSON.parse(fs.readFileSync(path.join(dir, 'rocktree-tile.json'), 'utf8'));
		if (!Array.isArray(tile.nodes) || tile.nodes.length === 0) return false;
		return tile.nodes.every((n) => fs.statSync(path.join(dir, n.file)).size > 0);
	} catch { return false; }
}

// Plan : la marche par bulks étant désormais proportionnelle aux nœuds
// réellement présents (issue #153), plan() peut se permettre la VRAIE
// traversée et rendre le compte exact d'octants retenus — là où il rendait
// une majoration géométrique sans rapport avec ce que Google couvre. Aucun
// NodeData n'est téléchargé : seulement les BulkMetadata, quelques dizaines
// de requêtes.
export async function plan(opts, { signal } = {}) {
	const zone = zoneOf(opts);
	const level = zoomToLevel(opts.zoom ?? 20);
	const { nodes, visitedBulks } = await traverse(zone, level, { signal });
	return { columns: nodes.length, trigger: 'Google Earth', pruned: 0, coverage: zone, level, visitedBulks };
}

// Sonde de couverture : une micro-zone (~3x3 octants) au centre de la zone,
// même esprit que flyover.probe — mais un octree n'a qu'un format, donc pas
// d'état 'undecodable' possible ici (contrairement à Flyover/C3M).
export async function probe(opts, { signal } = {}) {
	const zone = zoneOf(opts);
	const level = zoomToLevel(opts.zoom ?? 20);
	const centre = { lat: (zone.south + zone.north) / 2, lon: (zone.west + zone.east) / 2 };
	// Largeur angulaire d'un octant à ce niveau : la racine couvre 90°, et
	// chaque digit suivant la moitié (cf. childBoxes) — indépendant de la
	// latitude, à la différence de la grille Mercator de Flyover.
	const half = (90 / 2 ** Math.max(level - 2, 0)) * 1.5;
	const probeZone = { south: centre.lat - half, north: centre.lat + half, west: centre.lon - half, east: centre.lon + half };

	const { nodes } = await traverse(probeZone, level, { signal });
	// `exported` est le compteur que les deux fournisseurs ont en commun : ce qui
	// est réellement revenu au centre de la zone. Le scanner l'affiche tel quel —
	// sans lui, un verdict « couvert » s'accompagnait d'un « 0 tiles » mensonger.
	if (nodes.length > 0) {
		return { status: 'ok', exported: nodes.length, message: `Couvert : ${nodes.length} octant(s) au niveau ${level}.` };
	}
	return { status: 'none', exported: 0, message: "Google Earth n'a pas de photogrammétrie à ce niveau ici." };
}

// Télécharge la tuile : traverse puis récupère le NodeData de chaque nœud
// retenu, en petits lots pour ne pas ouvrir trop de connexions à la fois.
async function downloadNodes(tileDir, nodes, { signal, onLog, subdir = 'nodes' }) {
	fs.mkdirSync(path.join(tileDir, subdir), { recursive: true });
	const stats = { exported: 0, missing: 0 };
	const copyrightIds = new Set();
	const entries = [];
	const BATCH = 4;

	for (let i = 0; i < nodes.length; i += BATCH) {
		const batch = nodes.slice(i, i + BATCH);
		await Promise.all(batch.map(async (n) => {
			let buf;
			try {
				buf = await _net.http(nodeUrl(n), { signal });
			} catch (e) {
				// Un NodeData 404/gone n'est pas fatal : cf. ruling task-6 #3, le
				// mock hors-ligne rend cette situation systématique dès qu'un octant
				// n'a pas de fixture associée.
				if (e.status === 404 || e.status === 410) {
					stats.missing++;
					onLog?.({ stream: 'meta', line: `nœud absent (404), ignoré : ${n.path}` });
					return;
				}
				throw e;
			}
			const file = `${subdir}/${n.path}.pb`;
			fs.writeFileSync(path.join(tileDir, file), buf);
			for (const cid of parseNode(buf).copyrightIds) copyrightIds.add(cid);
			entries.push({ path: n.path, file, exclude: n.exclude });
			stats.exported++;
			onLog?.({ stream: 'progress', phase: 'download', hits: stats.exported });
		}));
	}
	return { stats, entries, copyrightIds };
}

// Télécharge la tuile et rend le dossier prêt pour prep.mjs. Lève si aucun
// nœud n'a pu être obtenu — 0 tuile 3D, cf. ruling task-6 #3.
export async function fetch(opts, { onLog, signal } = {}) {
	const { zoom = 20, force = false } = opts;
	const tileDir = await tileDirPath(opts);
	let fetchedAt;

	if (!force && tileIsUsable(tileDir)) {
		onLog?.({ stream: 'meta', line: `\nTuile déjà téléchargée (${tileDir}), téléchargement sauté (--force pour refaire).` });
		onLog?.({ stream: 'phase', line: 'download', done: true });
		// Cache hit : même règle que flyover.mjs — fetchedAt reste la date de la
		// vraie acquisition (mtime de rocktree-tile.json), pas l'instant de cette
		// relecture, sinon une tuile ancienne se ferait passer pour fraîche à
		// chaque re-prep.
		fetchedAt = fs.statSync(path.join(tileDir, 'rocktree-tile.json')).mtime.toISOString();
		const tile = JSON.parse(fs.readFileSync(path.join(tileDir, 'rocktree-tile.json'), 'utf8'));
		return { tileDir, attribution, fetchedAt, stats: { exported: tile.nodes.length, missing: 0 } };
	}

	// Purge tout reliquat d'un fetch précédent interrompu : rocktree-tile.json
	// n'existant qu'à la toute fin, un fetch interrompu ne laisse jamais un
	// cache "usable" mais peut laisser des .pb orphelins.
	fs.rmSync(tileDir, { recursive: true, force: true });
	onLog?.({ stream: 'phase', line: 'download' });

	const zone = zoneOf(opts);
	const level = zoomToLevel(zoom);

	const { nodes, rootEpoch, radius } = await traverse(zone, level, { signal, onLog });

	const { stats, entries, copyrightIds } = await downloadNodes(tileDir, nodes, { signal, onLog });

	// Repli d'imagerie (issue #158) : les ancêtres qui portent encore de la
	// vraie imagerie là où les nœuds fins n'ont qu'un atlas noir. On ne garde
	// que ceux qui ne sont PAS déjà dans la tuile — un ancêtre retenu par la
	// traversée principale sert déjà.
	const fallbackLevel = Math.max(2, level - FALLBACK_LEVELS_UP);
	let fallbackEntries = [];
	if (fallbackLevel < level) {
		const retained = new Set(nodes.map((n) => n.path));
		const coarse = (await traverse(zone, fallbackLevel, { signal })).nodes
			.filter((n) => !retained.has(n.path));
		if (coarse.length > 0) {
			onLog?.({ stream: 'meta', line: `repli d'imagerie : ${coarse.length} nœud(s) au niveau ${fallbackLevel}.` });
			const fb = await downloadNodes(tileDir, coarse, { signal, onLog, subdir: 'fallback' });
			fallbackEntries = fb.entries;
			for (const cid of fb.copyrightIds) copyrightIds.add(cid);
		}
	}

	if (stats.exported === 0) {
		fs.rmSync(tileDir, { recursive: true, force: true });
		throw new Error(
			`aucune tuile 3D dans la zone (niveau ${level}).\n` +
			"  Google Earth ne couvre pas cet endroit à ce niveau ; essaie un zoom plus bas."
		);
	}

	let copyrights = {};
	if (copyrightIds.size > 0) {
		const buf = await _net.http(`${PREFIX}Copyrights/pb=!1u${rootEpoch}`, { signal });
		const map = parseCopyrights(buf);
		for (const cid of copyrightIds) if (map.has(cid)) copyrights[cid] = map.get(cid);
	}

	fetchedAt = new Date().toISOString();
	// rocktree-tile.json écrit EN DERNIER : c'est le marqueur d'usabilité
	// (tileIsUsable), un fetch interrompu avant cette ligne n'empoisonne donc
	// jamais le cache.
	fs.writeFileSync(path.join(tileDir, 'rocktree-tile.json'), JSON.stringify({
		provider: id, epoch: rootEpoch, radius, level, fetchedAt, copyrights, nodes: entries,
		fallbackLevel, fallback: fallbackEntries,
	}, null, '\t'));

	onLog?.({ stream: 'phase', line: 'download', done: true });
	return { tileDir, attribution, fetchedAt, stats };
}
