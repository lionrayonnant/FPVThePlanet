// The UPLINKED card's pure half (issue #185, spec 2026-09-27-signals-lot2b):
// which facts show, the credit line, and how long a card stays up before the
// next one takes its place. No DOM — the DOM layer is src/signal-card.js.

// Seconds a card stays up before the next one (in flight) takes its place.
export const CARD_S = 6;
// The card shows at most four pictogram facts (landmark, calendar, height,
// heritage): more would not fit the ~250px column of layout B.
export const MAX_FACTS = 4;

const fieldValue = (signal, key) => signal?.fields?.find((f) => f.key === key)?.value ?? null;

// Wikidata gives a signed year (P571 precision >= day); OSM's BUILT field is
// already a display string (signal-model.mjs uppercases it), used as-is.
const yearText = (y) => (y < 0 ? `${-y} BC` : `${y}`);

// The four possible facts, in a fixed order, Wikidata preferred over OSM for
// year and height (spec: "the real photo... supersedes OSM for images and the
// short description" — the same precedence applies to these two facts).
export function cardFacts(signal, info) {
	const facts = [];
	if (signal?.kind) facts.push({ icon: 'landmark', text: signal.kind });

	const year = typeof info?.year === 'number' ? yearText(info.year) : fieldValue(signal, 'built');
	if (year) facts.push({ icon: 'calendar', text: year });

	const height = typeof info?.heightM === 'number' ? `${Math.round(info.heightM)} M` : fieldValue(signal, 'height');
	if (height) facts.push({ icon: 'height', text: height });

	const status = fieldValue(signal, 'status');
	if (status) facts.push({ icon: 'heritage', text: status });

	return facts.slice(0, MAX_FACTS);
}

// The photo's credit line. The data line ("DATA © OSM · WIKIDATA") is always
// shown, separately, by the DOM — it does not depend on a photo existing.
export function creditLine(info) {
	const photo = info?.photo;
	if (!photo) return null;
	const artist = photo.artist ?? 'UNKNOWN';
	const license = photo.license ?? 'UNKNOWN';
	return `PHOTO © ${artist} · ${license} · WIKIMEDIA COMMONS`;
}

// The end-of-flight recap strip: the first `max` uplinks as tiles, and how
// many more a `+N` tile stands for. null when nothing was uplinked.
export function recapTiles(entries, max = 6) {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	return { tiles: entries.slice(0, max), more: Math.max(0, entries.length - max) };
}

// Shows each pushed card for CARD_S seconds, then the next. A card pushed
// while one is showing waits its turn (FIFO): the operator sees every
// UPLINKED, one at a time, never two overlapping.
export class CardQueue {
	constructor() {
		this._queue = [];
		this._elapsed = 0;
	}

	push(card) {
		this._queue.push(card);
	}

	// dt <= 0 freezes: no card starts or ends, remaining01 does not move.
	update(dt) {
		if (dt > 0 && this._queue.length > 0) {
			this._elapsed += dt;
			while (this._queue.length > 0 && this._elapsed >= CARD_S) {
				this._elapsed -= CARD_S;
				this._queue.shift();
				if (this._queue.length === 0) { this._elapsed = 0; break; }
			}
		}
		const current = this._queue[0] ?? null;
		const remaining01 = current ? Math.max(0, 1 - this._elapsed / CARD_S) : 0;
		return { current, remaining01 };
	}
}
