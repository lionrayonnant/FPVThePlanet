// La traversée d'octree (bulks + marche) hors du fil principal (#187).
// Mesuré avant : chaque recalcul de fenêtre produisait ~10 longtasks de
// 59-72 ms sur le fil principal — le parse des bulks et la marche arrivent
// par lots entre deux awaits réseau, et c'était LE micro-freeze perçu en vol.
// traverse.mjs est portable tel quel (aucun import node:*/DOM, réseau via
// son _net.http = fetch nu) : ce worker n'est qu'un adaptateur de messages.
//
// Worker module PERSISTANT (créé une fois par rocktree-traverse-client.js) :
// corrélation par id, comme rocktree-worker-pool.js. Pas de transferables —
// la sortie (nodes/radius) est petite et plaine. Pas de signal : la fenêtre
// n'en passe pas à _traverse (voir rocktree-window.js), et un AbortSignal ne
// traverse de toute façon jamais postMessage().
//
// Le cache de bulks (lionrayonnant/FPVTP#295) vit ICI, dans le worker, pour toute la session de
// vol : kh.google.com interdit au cache HTTP de garder ses réponses, et sans
// lui chaque recalcul de fenêtre (tous les 50 m) refaisait la marche entière
// depuis la racine — 344 requêtes pour 300 m — pour n'apprendre qu'une
// couronne de bulks nouveaux. Persistant parce que le worker l'est.
import { traverse, createTraverseCache, _net } from '../tools/lib/rocktree/traverse.mjs';
import { createCachedFetch } from './rocktree-cache.js';

const cache = createTraverseCache();

// Et sur disque, entre sessions, pour les bulks seulement (lionrayonnant/FPVTP#296) : un second
// vol au même endroit, ou un REDEPLOY, traverse sans réseau. PlanetoidMetadata
// reste un fetch nu — c'est lui qui dit l'epoch courante.
const { cachedFetch } = createCachedFetch();
_net.http = async (url, { signal } = {}) => {
	const res = url.includes('BulkMetadata/') ? await cachedFetch(url, { signal }) : await fetch(url, { signal });
	if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
	return new Uint8Array(await res.arrayBuffer());
};

self.onmessage = async (e) => {
	const { id, zone, level } = e.data;
	try {
		const { nodes, radius, visitedBulks, cachedBulks } = await traverse(zone, level, { cache });
		self.postMessage({ id, ok: true, nodes, radius, visitedBulks, cachedBulks });
	} catch (err) {
		self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
	}
};
