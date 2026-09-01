// Pool de Workers persistants pour fetchNode() (#170) : la fenêtre de
// streaming (rocktree-window.js) appelle fetchNode() en continu pendant le
// vol, contrairement à loadChunks() qui ne charge qu'une fois par scène —
// créer et détruire un Worker module par nœud y dominerait le coût.
//
// POOL_SIZE : même ordre de grandeur que MAX_CONCURRENT (loader.js, 3) —
// assez pour recouvrir fetch et décodage de plusieurs nœuds à la fois, pas
// assez pour saturer le réseau ou la mémoire de plusieurs onglets.
const POOL_SIZE = 3;

let nextId = 1;
let workers = null;   // Worker[], créés une seule fois, jamais détruits
let nextWorker = 0;   // round-robin
const pending = new Map();   // id -> { worker, resolve, reject }

function ensurePool() {
	if (workers) return workers;
	workers = Array.from({ length: POOL_SIZE }, () => {
		const w = new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' });
		w.onmessage = (e) => {
			const msg = e.data;
			const p = pending.get(msg.id);
			if (!p) return;   // réponse arrivée après annulation (Step suivant) : ignorée
			pending.delete(msg.id);
			if (!msg.ok) {
				const err = new Error(msg.error);
				err.status = msg.status;
				p.reject(err);
				return;
			}
			p.resolve({ matrix: msg.matrix, copyrightIds: msg.copyrightIds, meshes: msg.meshes });
		};
		w.onerror = (e) => {
			// Une erreur de worker n'est pas corrélée à une requête précise
			// (contrairement à { ok: false } côté message) : elle peut casser
			// TOUTES les requêtes en vol sur CE worker. Rejeter celles qui
			// n'ont pas encore répondu plutôt que les laisser pendre pour
			// toujours — mais UNIQUEMENT celles assignées à CE worker, pas à
			// d'autres du pool.
			for (const [id, p] of pending) {
				if (p.worker === w) {
					p.reject(new Error(`rocktree worker: ${e.message}`));
					pending.delete(id);
				}
			}
		};
		return w;
	});
	return workers;
}

export function fetchNode({ path, epoch, imageryEpoch, flags }, { signal } = {}) {
	if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));

	const pool = ensurePool();
	const id = nextId++;
	const worker = pool[nextWorker];
	nextWorker = (nextWorker + 1) % pool.length;

	return new Promise((resolve, reject) => {
		// L'AbortSignal ne traverse toujours pas postMessage() (non clonable,
		// même contrainte que la tranche précédente). Annuler ici NE termine
		// PLUS le worker (il est partagé, Tâche 5/6) : juste oublier la
		// requête en attente. Sa réponse, si elle arrive quand même, ne
		// trouvera plus personne dans `pending` (voir onmessage ci-dessus) et
		// sera silencieusement ignorée.
		const onAbort = () => {
			pending.delete(id);
			reject(new DOMException('aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort);

		pending.set(id, {
			worker,
			resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
			reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
		});
		worker.postMessage({ id, path, epoch, imageryEpoch, flags });
	});
}
