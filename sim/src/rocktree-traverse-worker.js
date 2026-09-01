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
import { traverse } from '../tools/lib/rocktree/traverse.mjs';

self.onmessage = async (e) => {
	const { id, zone, level } = e.data;
	try {
		const { nodes, radius } = await traverse(zone, level, {});
		self.postMessage({ id, ok: true, nodes, radius });
	} catch (err) {
		self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
	}
};
