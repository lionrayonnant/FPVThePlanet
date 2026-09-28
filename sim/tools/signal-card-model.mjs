// The UPLINKED card's pure half (issue #185, spec 2026-09-27-signals-lot2b):
// which key/value rows show, the credit line, and how long a card stays up before the
// next one takes its place. No DOM — the DOM layer is src/signal-card.js.

import { LEVELS } from './signal-clearance-model.mjs';
import { TRACE_SHAPES } from './signal-store-model.mjs';

// Seconds a card stays up before the next one (in flight) takes its place.
export const CARD_S = 6;
// The card's key/value lines (TYPE / BUILT / HEIGHT / STATUS): four at most,
// the terminal's <pre> has no room for more in a ~250px column.
export const MAX_ROWS = 4;

const fieldValue = (signal, key) => signal?.fields?.find((f) => f.key === key)?.value ?? null;

// Wikidata gives a signed year (P571 precision >= day); OSM's BUILT field is
// already a display string (signal-model.mjs uppercases it), used as-is.
const yearText = (y) => (y < 0 ? `${-y} BC` : `${y}`);
// Metres in lower case, like every distance on the OSD; OSM's field arrives
// uppercased ("71 M").
const metres = (v) => (typeof v === 'string' ? v.replace(/ M$/, ' m') : v);

// The rows, in a fixed order, only the known ones. Wikidata is preferred over
// OSM for year and height (spec: "the real photo... supersedes OSM for images
// and the short description" — the same precedence applies to these two).
export function cardRows(signal, info) {
	const rows = [];
	if (signal?.kind) rows.push(['TYPE', signal.kind]);

	const year = typeof info?.year === 'number' ? yearText(info.year) : fieldValue(signal, 'built');
	if (year) rows.push(['BUILT', year]);

	const height = typeof info?.heightM === 'number' ? `${Math.round(info.heightM)} m` : metres(fieldValue(signal, 'height'));
	if (height) rows.push(['HEIGHT', height]);

	const status = fieldValue(signal, 'status');
	if (status) rows.push(['STATUS', status]);

	return rows.slice(0, MAX_ROWS);
}

// How the signal was captured, shared by the card and DATA: `HOLD 5.0 s`
// for a hold in the frame, `TRACE SPIRAL · 38.2 s` for a trace flown (lot 4,
// the seconds spent on it). The unknown shape of a corrupt entry reads as a hold.
export function captureLine({ holdS, trace } = {}) {
	const s = `${(Number.isFinite(holdS) ? holdS : 0).toFixed(1)} s`;
	return TRACE_SHAPES.includes(trace) ? `TRACE ${trace.toUpperCase()} · ${s}` : `HOLD ${s}`;
}

// The lines under the card's INTERCEPTED, one per line and none wrapping:
// the machine (when known), then the capture. On one line,
// `5" FREESTYLE · TRACE SPIRAL · 61.2 s` overflows the card and strands the
// seconds alone below.
export function interceptLines({ machine, holdS, trace } = {}) {
	const how = captureLine({ holdS, trace });
	return machine ? [machine, how] : [how];
}

// The card's credit line, in DATA's form (tools/signals-data-model.mjs
// creditOf + DATA_CREDIT; signal-card-selftest holds the two equal): the
// photo's credit when there is one, then the data line, always.
const DATA_CREDIT = 'DATA © OPENSTREETMAP · WIKIDATA';
export function creditLine(info) {
	const photo = info?.photo;
	if (!photo) return DATA_CREDIT;
	const artist = (photo.artist || 'UNKNOWN').toUpperCase();
	const license = (photo.license || 'UNKNOWN').toUpperCase();
	return `© ${artist} · ${license} · WIKIMEDIA COMMONS · ${DATA_CREDIT}`;
}

// The one-shot notice when control is acquired (the OSD's #fo-notice): the
// scan while the flight's tiles are still loading, then how many signals are
// open to this operator. `count` excludes the resolved and the locked ones.
export function takeoffNotice({ loading = false, done = 0, total = 0, count = 0 } = {}) {
	if (loading) return `[*] SIGNAL SCAN · ${done}/${total}`;
	if (count > 0) return `[+] ${count} SIGNAL${count === 1 ? '' : 'S'} IN RANGE`;
	return 'NO SIGNAL IN RANGE';
}

// The machines as the clearance ladder names them (the hangar's names, not
// the profiles' EST. classes: the toothpick is not "MICRO" here).
export const MACHINE_NAMES = {
	freestyle5: '5" FREESTYLE', cinewhoop: 'CINEWHOOP', toothpick: 'TOOTHPICK',
	race5: '5" RACE', longrange: 'LONG RANGE', heavy5: 'HEAVY 5"', swarm: 'THE SWARM',
	// The family an uplink stores for the swarm flight (PROFILE.family).
	swarmNode: 'THE SWARM',
};
const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

// The notice of an uplink that crosses a clearance step: what that step opens,
// machines then the new signal tier. null for level 0 or an unknown level.
export function clearanceNotice(level) {
	const now = LEVELS[level], before = LEVELS[level - 1];
	if (!now || !before) return null;
	const parts = now.opens.map((f) => MACHINE_NAMES[f] ?? f.toUpperCase());
	for (const t of now.tiers) if (!before.tiers.includes(t)) parts.push(`TIER ${ROMAN[t]}`);
	return [`[+] CLEARANCE ${level}`, ...parts].join(' · ');
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
