// Pure helpers for the hack culmination (PHASE 10, Bible §18/§36). No DOM —
// imported by the selftest and, through the Vite bundle, by src/culmination.js.
// The rendering (the burst itself) lives in src/culmination.js.
//
// These helpers were written for the CONTROL VECTOR ritual. The vector entry
// was removed (#33); the culmination it used to open onto came back on its own
// screen (#101), and this is the part of the old model that survived — what is
// gone with the entry is `checkInput`, which had inputs to validate.

// Staging durations: only the variant (number of beats / rhythm) changes from
// one hack to the next. Bible §18/§36: V1≈1s … V4≈4s.
export const CULMINATION_VARIANTS = [
	{ id: 'V1', ms: 1000, beats: 1 },
	{ id: 'V2', ms: 2000, beats: 2 },
	{ id: 'V3', ms: 3000, beats: 3 },
	{ id: 'V4', ms: 4000, beats: 4 },
];

// FNV-1a hash of a string -> 32-bit seed, then xorshift (same generation as
// tools/target-model.mjs, src/link.js: small, deterministic, replayable).
function rngFrom(seed) {
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

// Same seed -> same variant (stable replay through ?hack=&scene=). A missing
// seed still draws a variant (not deterministic) rather than failing: the
// staging does not need a seed to be valid.
export function pickVariant(seed) {
	const rand = seed != null ? rngFrom(`${seed}::culmination`) : Math.random;
	return CULMINATION_VARIANTS[Math.floor(rand() * CULMINATION_VARIANTS.length)];
}
