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

// Nombre minimal de mots, une fois normalisée, pour qu'une réplique répétée
// compte comme un défaut. En deçà, la répétition est un procédé délibéré et
// correct : « no », « yes », « again », « no comment », « fair enough » sont
// des battements courts que le crew réutilise sciemment en aparté sec — les
// signaler comme doublon serait du bruit. Au-delà, une phrase de trois mots
// ou plus est assez distinctive pour qu'être vue dix fois trahisse une
// formule figée (« ship the coarse pass », mesuré 10 fois sur 566 entrées)
// plutôt qu'un tic de langage voulu.
export const MIN_REPEATED_LINE_WORDS = 3;

// Détection de répétition ligne par ligne, complémentaire de findDuplicates :
// findDuplicates compare des ÉCHANGES entiers et rate deux échanges
// différents qui recyclent la même réplique formule. Ici on compte les
// répliques normalisées identiques à travers tout le corpus, peu importe
// l'échange qui les porte — c'est le signal qui manquait pour mesurer un
// vocabulaire de remplissage.
export function findRepeatedLines(entries, { minWords = MIN_REPEATED_LINE_WORDS } = {}) {
	const byLine = new Map(); // texte normalisé -> [ids d'entrées]

	for (const entry of entries) {
		for (const line of entry.lines ?? []) {
			const norm = normalize(line.text);
			if (norm.split(' ').filter(Boolean).length < minWords) continue;
			let ids = byLine.get(norm);
			if (!ids) byLine.set(norm, (ids = []));
			ids.push(entry.id);
		}
	}

	const out = [];
	for (const [text, ids] of byLine) {
		if (ids.length > 1) out.push({ text, count: ids.length, ids });
	}
	out.sort((a, b) => b.count - a.count);
	return out;
}

// Ensemble des répliques normalisées déjà écrites, pour un filtrage
// INCRÉMENTAL à l'accueil d'une entrée générée (voir generate.mjs) :
// contrairement à findRepeatedLines, qui rapporte après coup sur tout le
// corpus déjà écrit, ceci permet de refuser une entrée AVANT qu'elle
// n'ajoute une formule déjà vue, pendant la génération elle-même.
export function seenLineSet(entries, { minWords = MIN_REPEATED_LINE_WORDS } = {}) {
	const seen = new Set();
	for (const entry of entries) addLinesToSeen(entry, seen, minWords);
	return seen;
}

// Ajoute les répliques distinctives (>= minWords mots) d'une entrée à un
// ensemble `seen` construit par seenLineSet. Séparé de seenLineSet pour
// pouvoir grandir l'ensemble une entrée à la fois pendant un run, sans
// reparcourir tout le corpus à chaque nouvelle entrée gardée.
export function addLinesToSeen(entry, seen, minWords = MIN_REPEATED_LINE_WORDS) {
	for (const line of entry.lines ?? []) {
		const norm = normalize(line.text);
		if (norm.split(' ').filter(Boolean).length < minWords) continue;
		seen.add(norm);
	}
}

// Rend la première réplique normalisée de `entry` déjà présente dans `seen`,
// ou null si l'entrée n'introduit aucune formule déjà écrite.
export function repeatedLineIn(entry, seen, minWords = MIN_REPEATED_LINE_WORDS) {
	for (const line of entry.lines ?? []) {
		const norm = normalize(line.text);
		if (norm.split(' ').filter(Boolean).length < minWords) continue;
		if (seen.has(norm)) return norm;
	}
	return null;
}

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
