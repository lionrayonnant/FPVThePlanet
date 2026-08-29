// PHASE 11 — Entry State. After JACK IN (and after every in-session respawn)
// the drone starts already in flight: a weighted category picks how gentle or
// hairy that moment is, a candidate is sampled anywhere in the scene, and two
// safety nets (geometry, then a headless physics rollout) reject anything
// that would crash before the player can touch a stick. See
// docs/superpowers/specs/2026-08-29-phase-11-entry-state-design.md.
//
// Runs both in the browser (bundled by Vite) and in Node (selftest) — no
// browser-only API, no `node:` import.

export const CATEGORIES = ['COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const WEIGHTS = [60, 25, 12, 3];

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
// tools/target-model.mjs et src/link.js : petit, déterministe, rejouable).
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

export function pickCategory(rand) {
	const r = rand() * 100;
	let acc = 0;
	for (let i = 0; i < CATEGORIES.length; i++) {
		acc += WEIGHTS[i];
		if (r < acc) return CATEGORIES[i];
	}
	return CATEGORIES[CATEGORIES.length - 1];
}
