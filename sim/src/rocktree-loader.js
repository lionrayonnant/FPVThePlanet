// Orchestre src/rocktree-worker.js (#168) : miroir de loadChunks() dans
// loader.js, mais pour UN nœud rocktree fetché en direct plutôt qu'un lot de
// chunks pré-cuits. Ce module ne sait RIEN de la position du drone ni d'une
// fenêtre de streaming — c'est le problème de la tranche suivante, qui
// appellera fetchNode() en boucle.
//
// Contrat imageryEpoch : quand meta.flags & 16, l'appelant doit résoudre
// imageryEpoch en meta.imageryEpoch ?? bulk.defaultImageryEpoch avant
// d'appeler fetchNode() (voir tools/lib/providers/google-earth.mjs,
// traverse()) — sinon l'URL omet !3u et le nœud répond 404.
export function fetchNode({ path, epoch, imageryEpoch, flags }, { signal } = {}) {
	if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));

	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' });

		// L'AbortSignal ne traverse pas postMessage() (non clonable) : le worker
		// ne le reçoit jamais, l'annulation reste ici, sur le fil principal —
		// même motif que loadChunks() dans loader.js pour les chunks pré-cuits
		// (worker.terminate()).
		const onAbort = () => {
			worker.terminate();
			reject(new DOMException('aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort);

		const cleanup = () => {
			signal?.removeEventListener('abort', onAbort);
			worker.terminate();
		};

		worker.onerror = (e) => { cleanup(); reject(new Error(`fetchNode ${path}: ${e.message}`)); };
		worker.onmessage = (e) => {
			cleanup();
			const msg = e.data;
			if (!msg.ok) {
				// status propagé tel quel (404/410 = absent, cf. worker) : le prochain
				// appelant (LOD/traversée) doit pouvoir tester e.status sans parser le message.
				const e2 = new Error(`fetchNode ${path}: ${msg.error}`);
				e2.status = msg.status;
				reject(e2);
				return;
			}
			resolve({ matrix: msg.matrix, copyrightIds: msg.copyrightIds, meshes: msg.meshes });
		};
		worker.postMessage({ path, epoch, imageryEpoch, flags });
	});
}
