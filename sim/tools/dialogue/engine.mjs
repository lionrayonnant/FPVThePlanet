// Sélection d'une réplique (PHASE 21). Pur : le hasard entre par `rng`, aucune
// horloge, aucune mutation de la mémoire reçue. C'est cette pureté qui rend
// mesurables la fréquence de jensen et la distribution de rareté — sans elle,
// « jensen est rare » resterait une intention.
import {
	RARITY, EVENTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN, resolvePath,
} from './catalog.mjs';

// La même paire ne peut pas enchaîner trois échanges d'affilée sans pénalité :
// root et mikhail sont majoritaires dans le corpus, sans ça ils monologuent.
export const PAIR_COOLDOWN = 3;

// Pénalité douce d'une entrée déjà vue mais sortie de l'anneau : le matériel
// jamais joué remonte, l'ancien redevient possible sans jamais être prioritaire.
const SEEN_PENALTY = 0.35;
const PAIR_PENALTY = 0.2;

// xorshift32, la même primitive que src/entry-state.js:19 — recopiée plutôt
// qu'importée : ce module doit rester sans dépendance vers src/ (qui traîne THREE).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

export function emptyMemory() {
	return { ring: [], seen: {}, buckets: {}, seq: 0 };
}

export function eligible(entry, ctx) {
	return (entry?.requires ?? []).every((path) => resolvePath(ctx, path) !== null);
}

const pairKey = (entry) => `pair:${[...new Set(entry.characters ?? [])].sort().join('|')}`;

// Le compteur avance à CHAQUE tirage, y compris silencieux : les refroidissements
// se comptent en occasions de parler, pas en répliques effectivement dites.
function bump(memory) {
	return { ...memory, seq: memory.seq + 1 };
}

function commit(memory, entry) {
	const ring = [...memory.ring, entry.id].slice(-MEMORY_RING);
	const seen = { ...memory.seen, [entry.id]: memory.seq };
	// Élagage des « vus » : on garde les MEMORY_SEEN plus récents, sinon l'objet
	// grossit sans fin dans l'état opérateur persisté.
	const keys = Object.keys(seen);
	if (keys.length > MEMORY_SEEN) {
		keys.sort((a, b) => seen[a] - seen[b]);
		for (const k of keys.slice(0, keys.length - MEMORY_SEEN)) delete seen[k];
	}
	const buckets = { ...memory.buckets, [pairKey(entry)]: memory.seq };
	if ((entry.characters ?? []).includes('jensen')) buckets.jensen = memory.seq;
	return { ring, seen, buckets, seq: memory.seq + 1 };
}

export function select({ event, pool = [], ctx = {}, memory = emptyMemory(), rng }) {
	const ring = new Set(memory.ring);
	const jensenAt = memory.buckets?.jensen;
	const jensenBlocked = jensenAt != null && (memory.seq - jensenAt) < JENSEN_COOLDOWN;

	const candidates = [];
	for (const entry of pool) {
		if (!(entry.events ?? []).includes(event)) continue;
		if (ring.has(entry.id)) continue;
		if (!eligible(entry, ctx)) continue;
		const hasJensen = (entry.characters ?? []).includes('jensen');
		if (hasJensen && jensenBlocked) continue;

		let w = RARITY[entry.rarity] ?? 0;
		if (w <= 0) continue;
		if (memory.seen?.[entry.id] != null) w *= SEEN_PENALTY;
		const pk = pairKey(entry);
		const pairAt = memory.buckets?.[pk];
		if (pairAt != null && (memory.seq - pairAt) < PAIR_COOLDOWN) w *= PAIR_PENALTY;
		candidates.push({ entry, w });
	}

	// Le silence entre dans le tirage comme un candidat (D4) : une acquisition
	// où le crew ne dit rien pendant une minute est correcte, pas cassée.
	const silence = EVENTS[event]?.silenceWeight ?? 0;
	const total = candidates.reduce((s, c) => s + c.w, 0) + silence;
	if (total <= 0) return { entry: null, memory: bump(memory) };

	let r = rng() * total;
	for (const c of candidates) {
		r -= c.w;
		if (r < 0) return { entry: c.entry, memory: commit(memory, c.entry) };
	}
	return { entry: null, memory: bump(memory) };
}
