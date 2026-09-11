// `String(v)` is not total, and everything that reads a stored file assumes it
// is.
//
// A JSON file can hold `{"area": {"toString": null}}` — valid JSON, written by
// hand or by an older build — and `String(that)` throws
// `TypeError: Cannot convert object to primitive value`. The screen that was
// only formatting a label dies, or a validator that meant to say "id invalide"
// answers with an engine message instead. Found by tools/fuzz.mjs across the
// session log, the DATA screen and the session validator at once.
//
// Pure, no imports: it is bundled into the browser alongside the models that
// use it.

// The text of a value, or `fallback` when it has none. Only primitives have
// text — an object's is a courtesy the language does not guarantee.
export function asText(v, fallback = '') {
	const t = typeof v;
	return (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') ? String(v) : fallback;
}

// What to call a value in an error message when it has no text of its own.
// `nameOf({})` is `object`, `nameOf([])` is `array`, `nameOf(null)` is `null`.
export function nameOf(v) {
	const t = typeof v;
	if (t !== 'object') return t;
	return v === null ? 'null' : (Array.isArray(v) ? 'array' : 'object');
}
