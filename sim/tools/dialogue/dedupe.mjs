// Détection de quasi-doublons dans le corpus (PHASE 21). Trigrammes normalisés
// + Jaccard : aucune dépendance, aucun embedding. Les doublons que produit un
// LLM se ressemblent lexicalement, pas seulement sémantiquement — c'est
// suffisant, et ça reste vérifiable à la main quand un rapprochement surprend.

export function normalize(text) {
	return String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function trigrams(text) {
	const s = normalize(text);
	const out = new Set();
	for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
	return out;
}

export function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	for (const g of small) if (big.has(g)) inter++;
	return inter / (a.size + b.size - inter);
}

const entryText = (entry) => (entry.lines ?? []).map((l) => l.text).join(' ');

// Index inversé trigramme -> indices. On ne compare une entrée qu'aux entrées
// qui partagent au moins un trigramme avec elle : deux textes sans trigramme
// commun ont un Jaccard nul, les comparer serait du temps perdu.
export function findDuplicates(entries, { threshold = 0.6 } = {}) {
	const grams = entries.map((e) => trigrams(entryText(e)));
	const index = new Map();
	const out = [];

	for (let i = 0; i < entries.length; i++) {
		const neighbours = new Set();
		for (const g of grams[i]) {
			const bucket = index.get(g);
			if (bucket) for (const j of bucket) neighbours.add(j);
		}
		for (const j of neighbours) {
			const score = jaccard(grams[i], grams[j]);
			if (score >= threshold) out.push({ a: entries[j].id, b: entries[i].id, score });
		}
		for (const g of grams[i]) {
			let bucket = index.get(g);
			if (!bucket) index.set(g, (bucket = []));
			bucket.push(i);
		}
	}
	return out;
}
