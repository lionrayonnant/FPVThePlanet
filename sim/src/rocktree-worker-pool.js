// Pool de Workers persistants pour fetchNode() (#170) : la fenêtre de
// streaming (rocktree-window.js) appelle fetchNode() en continu pendant le
// vol, contrairement à loadChunks() qui ne charge qu'une fois par scène —
// créer et détruire un Worker module par nœud y dominerait le coût.
//
// POOL_SIZE : même ordre de grandeur que MAX_CONCURRENT (loader.js, 3) —
// assez pour recouvrir fetch et décodage de plusieurs nœuds à la fois, pas
// assez pour saturer le réseau ou la mémoire de plusieurs onglets.
const POOL_SIZE = 3;

// Plafond de requêtes EN VOL par worker (#179). Sans lui, update() postait
// tous les nœuds désirés d'un coup — 1055 messages au boot — et chaque
// self.onmessage étant asynchrone, autant de fetch() et de décodages JPEG
// partaient réellement en même temps.
//
// Ce que coûte un nœud en vol, mesuré sur 30 nœuds réels (Paris, niveau 21) :
// 21 Kio de protobuf + 22 Kio de géométrie construite + 580 Kio d'ImageBitmap
// décodé = 624 Kio. Une vague de 1055 nœuds sans plafond, c'est donc ~640 Mio
// de décodé simultané côté workers ; à 16 par worker (48 en vol), ~29 Mio.
//
// 16 et pas 2 : le consommateur est le fil principal, qui applique un nœud en
// ~1,4 ms sous un budget de 3-8 ms par frame (#184, #189), soit 128-342
// nœuds/s. Il faut donc débit × latence requêtes en vol pour ne pas l'affamer
// — 48 tiennent 342 nœuds/s jusqu'à 140 ms de latence. Une file de profondeur
// 2 (6 en vol) l'aurait au contraire étranglé dès 20 ms de latence.
const MAX_IN_FLIGHT_PER_WORKER = 16;

let nextId = 1;

// Le pool est construit par createPool() plutôt qu'inline : `new Worker(...)`
// n'existe pas sous Node, et le selftest (tools/rocktree-pool-selftest.mjs) a
// besoin d'injecter un faux Worker pour exercer la file d'attente.
export function createPool({ makeWorker, size = POOL_SIZE, maxInFlight = MAX_IN_FLIGHT_PER_WORKER }) {
	const pending = new Map();   // id -> { resolve, reject }, requêtes POSTÉES
	const queue = [];            // jobs pas encore postés, dans l'ordre d'arrivée
	let slots = null;

	function ensureSlots() {
		if (slots) return slots;
		slots = Array.from({ length: size }, () => {
			// inflight : les id postés à CE worker et sans réponse. Un Set plutôt
			// qu'un compteur — onerror doit pouvoir tout oublier d'un coup sans
			// qu'une réponse tardive fasse ensuite passer le compte sous zéro.
			const slot = { worker: null, inflight: new Set() };
			const w = makeWorker();
			w.onmessage = (e) => {
				const msg = e.data;
				slot.inflight.delete(msg.id);
				const p = pending.get(msg.id);
				if (!p) {
					// Réponse arrivée après annulation : ignorée — mais ses ImageBitmap
					// sont des ressources GPU/décodeur qui ne partent pas au GC aussi
					// vite qu'un buffer (#187) ; les fermer explicitement, sinon une
					// vague annulée en laisse des dizaines en vie.
					if (msg.ok) for (const m of msg.meshes) m.bitmap?.close();
					pump();
					return;
				}
				pending.delete(msg.id);
				if (!msg.ok) {
					const err = new Error(msg.error);
					err.status = msg.status;
					p.reject(err);
				} else {
					p.resolve({ matrix: msg.matrix, copyrightIds: msg.copyrightIds, meshes: msg.meshes });
				}
				pump();
			};
			w.onerror = (e) => {
				// Une erreur de worker n'est pas corrélée à une requête précise
				// (contrairement à { ok: false } côté message) : elle peut casser
				// TOUTES les requêtes en vol sur CE worker. Rejeter celles qui
				// n'ont pas encore répondu plutôt que les laisser pendre pour
				// toujours — mais UNIQUEMENT celles assignées à CE worker, pas à
				// d'autres du pool. Puis vider son inflight : sans ça, des places
				// perdues réduiraient définitivement la capacité du pool.
				for (const id of slot.inflight) {
					const p = pending.get(id);
					if (p) { pending.delete(id); p.reject(new Error(`rocktree worker: ${e.message}`)); }
				}
				slot.inflight.clear();
				pump();
			};
			slot.worker = w;
			return slot;
		});
		return slots;
	}

	// Déverse la file vers les places libres. Un seul point de dispatch : appelé
	// à l'arrivée d'une requête et à chaque réponse.
	function pump() {
		while (queue.length > 0) {
			// Le moins chargé, pas un round-robin : une réponse lente ne doit pas
			// laisser dormir la place qu'un autre worker vient de libérer.
			let best = null;
			for (const s of slots) {
				if (s.inflight.size >= maxInFlight) continue;
				if (!best || s.inflight.size < best.inflight.size) best = s;
			}
			if (!best) return;
			const job = queue.shift();
			// Annulé pendant l'attente : il n'a jamais coûté un fetch. C'est le
			// gain principal du plafond au recentrage de fenêtre, où update()
			// abandonne des nœuds que l'ancien code avait déjà tous lancés.
			if (job.aborted) continue;
			pending.set(job.id, { resolve: job.resolve, reject: job.reject });
			best.inflight.add(job.id);
			best.worker.postMessage(job.msg);
		}
	}

	return {
		fetchNode({ path, epoch, imageryEpoch, flags, sphereRadius, originEcef, originBasis, exclude }, { signal } = {}) {
			if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
			ensureSlots();
			const id = nextId++;

			return new Promise((resolve, reject) => {
				// L'AbortSignal ne traverse toujours pas postMessage() (non clonable,
				// même contrainte que la tranche précédente). Annuler ici NE termine
				// PLUS le worker (il est partagé, Tâche 5/6) : selon que la requête
				// est encore en file ou déjà postée, on la saute au dispatch ou on
				// oublie sa réponse — dans les deux cas plus personne dans `pending`
				// (voir onmessage ci-dessus).
				const onAbort = () => {
					job.aborted = true;
					pending.delete(id);
					reject(new DOMException('aborted', 'AbortError'));
				};
				const job = {
					id,
					aborted: false,
					msg: { id, path, epoch, imageryEpoch, flags, sphereRadius, originEcef, originBasis, exclude },
					resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
					reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
				};
				signal?.addEventListener('abort', onAbort);
				queue.push(job);
				pump();
			});
		},

		// Pour __sim.debug() et la calibration de TRUST_MARGIN_M (#179 point 3) :
		// une latence mesurée pendant que la file est profonde est une latence
		// d'attente, pas une latence réseau.
		stats() {
			return {
				queued: queue.length,
				inFlight: slots ? slots.reduce((a, s) => a + s.inflight.size, 0) : 0,
				capacity: size * maxInFlight,
			};
		},
	};
}

let defaultPool = null;
function pool() {
	return (defaultPool ??= createPool({
		makeWorker: () => new Worker(new URL('./rocktree-worker.js', import.meta.url), { type: 'module' }),
	}));
}

export function fetchNode(req, opts) { return pool().fetchNode(req, opts); }
export function poolStats() { return pool().stats(); }
