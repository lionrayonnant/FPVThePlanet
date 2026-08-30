// Cadence d'affichage d'un échange (PHASE 21). Pur : src/dialogue.js ne fait
// que poser des minuteurs sur le plan que ce module calcule — il ne reste donc
// aucune logique testable coincée derrière le DOM.
import { EVENTS } from './catalog.mjs';

const DEFAULT_GAP = [5000, 12000];
const DEFAULT_BEAT = [700, 1600];

export function pickInRange([lo, hi], rng) {
	return lo + rng() * (hi - lo);
}

export function nextGapMs(event, rng) {
	return pickInRange(EVENTS[event]?.gapMs ?? DEFAULT_GAP, rng);
}

// Les répliques d'un même échange tombent une par une, avec un battement entre
// elles : c'est ce qui fait « quelqu'un qui tape » plutôt qu'un bloc collé.
export function planExchange(lines, event, rng) {
	const beat = EVENTS[event]?.beatMs ?? DEFAULT_BEAT;
	let at = 0;
	return lines.map((line, i) => {
		if (i > 0) at += pickInRange(beat, rng);
		return { ...line, atMs: at };
	});
}
