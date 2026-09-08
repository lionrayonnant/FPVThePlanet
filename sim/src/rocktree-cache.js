// Cache disque des réponses rocktree, entre sessions (#22). kh.google.com
// répond `cache-control: no-cache, must-revalidate` : le cache HTTP du
// navigateur ne garde rien, et REDEPLOY (#253, rechargement de page) comme
// un second vol au même endroit refetchaient tout — bulks et nœuds. La Cache
// API (`caches`) est le stockage que le navigateur offre pour ça : sur disque,
// partagé entre les Workers d'une même origine, disponible en contexte
// sécurisé (https, ou localhost — le serveur autonome et Electron).
//
// Clé = l'URL complète, qui porte l'epoch (bulk comme nœud) : une nouvelle
// epoch racine donne de nouvelles clés, les anciennes finissent évincées.
// Jamais PlanetoidMetadata : c'est lui qui dit l'epoch courante, il doit
// venir du réseau (traverse.mjs le garde 10 min en mémoire, pas plus).
//
// Éviction par NOMBRE d'entrées, pas par taille : la Cache API ne rend pas la
// taille d'une entrée sans la lire. Un nœud de niveau 21 pèse ~21 Kio, un
// nœud grossier jusqu'à ~350 Kio (fixtures) ; 5000 entrées valent donc de
// l'ordre de 100-200 Mo, loin du quota (un pourcentage du disque). Les clés
// reviennent dans l'ordre d'insertion sur les moteurs actuels — pas garanti
// par la spec, mais l'éviction n'est qu'une borne, pas une garantie de
// fraîcheur : au pire elle retire des entrées récentes, jamais des fausses.
//
// Importé UNIQUEMENT par les Workers (rocktree-worker.js,
// rocktree-traverse-worker.js) : ce module suppose `caches`/`fetch` du
// navigateur — d'où l'injection, pour que tools/rocktree-cache-selftest.mjs
// l'exerce en Node avec des doublures.
export const CACHE_NAME = 'fpvtp-rocktree-v1';
export const MAX_ENTRIES = 5000;
// Compter les clés coûte proportionnellement à leur nombre : on ne le fait
// qu'une fois toutes les PRUNE_EVERY écritures.
export const PRUNE_EVERY = 250;

export function createCachedFetch({
	caches = globalThis.caches,
	fetch = globalThis.fetch,
	maxEntries = MAX_ENTRIES,
	pruneEvery = PRUNE_EVERY,
} = {}) {
	let opened = null;
	let puts = 0;
	let pruning = null;

	function open() {
		if (opened) return opened;
		if (!caches?.open) return (opened = Promise.resolve(null));
		// Un échec d'ouverture (quota, mode privé strict) dégrade en fetch nu,
		// une fois pour toutes : pas de retentative à chaque requête.
		return (opened = caches.open(CACHE_NAME).catch(() => null));
	}

	async function prune(cache) {
		const keys = await cache.keys();
		const excess = keys.length - maxEntries;
		if (excess <= 0) return 0;
		// On retire l'excédent PLUS une tranche : sinon la prochaine écriture
		// redéclenche un comptage complet pour une seule entrée de trop.
		const n = Math.min(keys.length, excess + pruneEvery);
		await Promise.all(keys.slice(0, n).map((k) => cache.delete(k)));
		return n;
	}

	return {
		async cachedFetch(url, opts) {
			const cache = await open();
			if (cache) {
				try {
					const hit = await cache.match(url);
					if (hit) return hit;
				} catch { /* cache illisible : le réseau tranche */ }
			}
			const res = await fetch(url, opts);
			// Seules les réponses complètes entrent : un 404 de nœud absent
			// (résultat normal du protocole) ou un 5xx passager ne doit pas
			// devenir permanent. Le clone est nécessaire : un corps ne se lit
			// qu'une fois, l'appelant garde l'original.
			if (cache && res.ok) {
				try {
					await cache.put(url, res.clone());
					if (++puts % pruneEvery === 0) pruning ??= prune(cache).catch(() => 0).finally(() => { pruning = null; });
				} catch { /* quota ou corps déjà consommé : la réponse sert quand même */ }
			}
			return res;
		},
		// Pour le selftest et __sim.debug() : attend une éviction en cours.
		flush() { return pruning ?? Promise.resolve(0); },
	};
}
