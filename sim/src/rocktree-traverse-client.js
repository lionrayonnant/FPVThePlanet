// Client du worker de traversée (#187) : même signature que traverse() de
// tools/lib/rocktree/traverse.mjs — c'est le _traverse par défaut de
// RocktreeWindow. Worker singleton créé PARESSEUSEMENT au premier appel :
// ce module est importé (transitivement) par tools/rocktree-window-selftest.mjs
// en Node, où `Worker` n'existe pas — un `new Worker` au niveau module
// casserait toute la suite. Même motif qu'ensurePool() dans
// rocktree-worker-pool.js : corrélation par id, onerror rejette les requêtes
// en vol.
let worker = null;
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject }

function ensureWorker() {
	if (worker) return worker;
	worker = new Worker(new URL('./rocktree-traverse-worker.js', import.meta.url), { type: 'module' });
	worker.onmessage = (e) => {
		const msg = e.data;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (!msg.ok) { p.reject(new Error(msg.error)); return; }
		p.resolve({ nodes: msg.nodes, radius: msg.radius, visitedBulks: msg.visitedBulks, cachedBulks: msg.cachedBulks });
	};
	worker.onerror = (e) => {
		for (const [id, p] of pending) {
			p.reject(new Error(`rocktree traverse worker: ${e.message}`));
			pending.delete(id);
		}
	};
	return worker;
}

// Préchauffage (lionrayonnant/FPVTP#295) : bootLive() l'appelle avant même d'attendre l'init de
// Rapier, pour que le chargement du module du worker (un fetch + une
// compilation en prod) se recouvre avec le reste du boot au lieu de s'ajouter
// devant la première traversée. Idempotent.
export function warmUp() { ensureWorker(); }

// opts (signal/onLog/maxNodes) volontairement ignorées : la fenêtre appelle
// _traverse(zone, level, {}) sans rien — les transmettre exigerait de faire
// voyager des fonctions/AbortSignal par postMessage, impossible. Si un futur
// appelant en a besoin, c'est le protocole du worker qu'il faudra étendre.
export function traverseInWorker(zone, level, _opts = {}) {
	const w = ensureWorker();
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		w.postMessage({ id, zone, level });
	});
}
