// Fournisseur Google Earth : le protocole interne « rocktree » de
// earth.google.com — voir l'amendement 2026-08-31 du design #18. Pas de clé,
// pas d'API souscrite : même posture que Flyover, endpoints kh.google.com.
//
// Réseau injectable : `_net.http(url, { signal }) -> Promise<Buffer>` est le
// seul point de contact avec kh.google.com. Les tests le remplacent (mock des
// fixtures) plutôt que de passer par un framework d'injection — c'est le motif
// le plus simple qui permette de rejouer une capture hors-ligne.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanetoid, parseBulk, parseNode, parseCopyrights } from '../rocktree/proto.mjs';
import { octantsCovering } from '../rocktree/octant.mjs';
import { polyHash, polygonBounds } from '../tiles.mjs';

// tools/lib/providers/ est trois niveaux sous sim/ (tools -> lib -> providers) :
// il faut donc QUATRE dirname() pour remonter à sim/ depuis le chemin complet du
// fichier (un pour retirer le nom de fichier, trois pour remonter les dossiers).
const SIM_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
let CACHE_ROOT = path.join(SIM_ROOT, '.cache/google-earth');
export function _cacheRootForTests(dir) { CACHE_ROOT = dir ?? path.join(SIM_ROOT, '.cache/google-earth'); }

export const id = 'google-earth';
export const label = 'Google Earth';
export const attribution = ['© Google'];

const PREFIX = 'https://kh.google.com/rt/earth/';

// Réseau remplaçable par les tests (fixtures à la place de kh.google.com).
export const _net = {
	async http(url, { signal } = {}) {
		const res = await globalThis.fetch(url, { signal });
		if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
		return Buffer.from(await res.arrayBuffer());
	},
};

// PROVISOIRE (Task 8 la mesure) : zoom GUI -> niveau d'octree, identité bornée
// aux niveaux que les fixtures couvrent (13 à 22).
export function zoomToLevel(zoom) { return Math.max(13, Math.min(22, zoom)); }

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

// poly -> bbox du ring ; bbox -> bbox tel quel ; sinon carré de `radius`
// mètres autour de (lat, lon) — converti en degrés via cos(lat), comme
// tiles.mjs le fait pour Flyover.
function zoneOf({ lat, lon, radius = 25, bbox, poly }) {
	if (poly) return polygonBounds(poly);
	if (bbox) return bbox;
	const dLat = (radius / 111320);
	const dLon = dLat / Math.cos((lat / 180) * Math.PI);
	return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

async function getPlanetoidEpoch({ signal }) {
	const buf = await _net.http(PREFIX + 'PlanetoidMetadata', { signal });
	return parsePlanetoid(buf).rootEpoch;
}

// Une bulk absente (404/410) veut dire « cette branche de l'octree n'est pas
// dans la capture » — pas une erreur : la traversée doit s'en accommoder
// (c'est le mécanisme même que le mock des tests exerce).
async function fetchBulk(bulkPath, epoch, { signal }) {
	try {
		const buf = await _net.http(`${PREFIX}BulkMetadata/pb=!1m2!1s${bulkPath}!2u${epoch}`, { signal });
		return { ...parseBulk(buf), epoch };
	} catch (e) {
		if (e.status === 404 || e.status === 410) return null;
		throw e;
	}
}

function nodeUrl({ path: p, epoch, imageryEpoch, flags }) {
	let u = `${PREFIX}NodeData/pb=!1m2!1s${p}!2u${epoch}!2e1`;
	if (flags & 16) u += `!3u${imageryEpoch}`;
	return u + '!4b0';
}

// Cœur du fournisseur : descend les bulks tous les 4 digits (le grain auquel
// le protocole les découpe), en vérifiant à chaque étage que le préfixe
// existe et sert du NodeData (flags & 8 = NODATA). Un LEAF (flags & 4)
// rencontré avant le niveau demandé referme la branche : le nœud le plus
// profond retenu (fill-in) est le dernier prefix valide, pas de descente plus
// loin puisqu'aucun bulk enfant n'existe.
export async function traverse(zone, level, { signal, onLog } = {}) {
	const rootEpoch = await getPlanetoidEpoch({ signal });
	const bulkCache = new Map();
	let visitedBulks = 0;

	async function getBulk(bulkPath, epoch) {
		if (bulkCache.has(bulkPath)) return bulkCache.get(bulkPath);
		const bulk = await fetchBulk(bulkPath, epoch, { signal });
		bulkCache.set(bulkPath, bulk);
		if (bulk) visitedBulks++;
		return bulk;
	}

	const nodesOut = new Map();
	for (const { path: target } of octantsCovering(zone, level)) {
		let bulk = await getBulk('', rootEpoch);
		let consumed = 0;
		let lastGood = null; // { path, meta, bulk }

		while (bulk && consumed < target.length) {
			const remain = Math.min(4, target.length - consumed);
			let matchedLen = 0, leafHit = false;
			for (let len = 1; len <= remain; len++) {
				const rel = target.slice(consumed, consumed + len);
				const meta = bulk.nodes.get(rel);
				if (!meta) break;
				matchedLen = len;
				if (!(meta.flags & 8)) lastGood = { path: target.slice(0, consumed + len), meta, bulk };
				if (meta.flags & 4) { leafHit = true; break; }
			}
			if (matchedLen === 0 || leafHit) break; // chemin absent, ou LEAF : branche refermée
			consumed += matchedLen;
			if (consumed >= target.length || matchedLen < 4) break; // niveau atteint, ou pas de frontière de bulk
			const rel4 = target.slice(consumed - 4, consumed);
			const nextEpoch = bulk.nodes.get(rel4)?.bulkEpoch ?? bulk.epoch;
			bulk = await getBulk(target.slice(0, consumed), nextEpoch);
		}

		if (lastGood && !nodesOut.has(lastGood.path)) {
			const { meta, bulk: b } = lastGood;
			nodesOut.set(lastGood.path, {
				path: lastGood.path,
				epoch: meta.epoch ?? b.epoch,
				imageryEpoch: (meta.flags & 16) ? (meta.imageryEpoch ?? b.defaultImageryEpoch) : null,
				flags: meta.flags,
			});
		}
	}

	// exclude : pour chaque nœud retenu dont un enfant direct (path + 1 digit)
	// est aussi retenu, exclure cet octant — sinon parent et enfant dessinent
	// la même géométrie (z-fight, cf. décodeur).
	const paths = new Set(nodesOut.keys());
	const nodes = [...nodesOut.values()].map((n) => {
		const exclude = [];
		for (let d = 0; d < 8; d++) if (paths.has(n.path + d)) exclude.push(d);
		return { ...n, exclude };
	});

	onLog?.({ stream: 'meta', line: `traversée : ${nodes.length} nœud(s), ${visitedBulks} bulk(s) visité(s).` });
	return { nodes, visitedBulks, rootEpoch };
}

// Interroge la traversée seule (aucun NodeData téléchargé) : combien de
// colonnes, sur quelle emprise — les champs que la GUI lit (columns, trigger,
// pruned).
export async function plan(opts, { signal } = {}) {
	const zone = zoneOf(opts);
	const level = zoomToLevel(opts.zoom ?? 20);
	const { nodes } = await traverse(zone, level, { signal });
	return { columns: nodes.length, trigger: 'Google Earth', pruned: 0, coverage: zone };
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
	if (nodes.length > 0) {
		return { status: 'ok', message: `Couvert : ${nodes.length} octant(s) au niveau ${level}.` };
	}
	return { status: 'none', message: "Google Earth n'a pas de photogrammétrie à ce niveau ici." };
}

// Télécharge la tuile : traverse puis récupère le NodeData de chaque nœud
// retenu, en petits lots pour ne pas ouvrir trop de connexions à la fois.
async function downloadNodes(tileDir, nodes, { signal, onLog }) {
	fs.mkdirSync(path.join(tileDir, 'nodes'), { recursive: true });
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
			const file = `nodes/${n.path}.pb`;
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
	const { nodes, rootEpoch } = await traverse(zone, level, { signal, onLog });

	const { stats, entries, copyrightIds } = await downloadNodes(tileDir, nodes, { signal, onLog });

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
		provider: id, epoch: rootEpoch, level, fetchedAt, copyrights, nodes: entries,
	}, null, '\t'));

	onLog?.({ stream: 'phase', line: 'download', done: true });
	return { tileDir, attribution, fetchedAt, stats };
}
