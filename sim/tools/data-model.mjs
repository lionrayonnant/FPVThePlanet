// DATA tab model (issue #26, spec
// docs/superpowers/specs/2026-09-08-flight-track-enriched-map-data-design.md).
// Pure: no I/O, no DOM, no `node:` — imported as-is by the browser (bundled by
// Vite) and by the selftest.
//
// The screen computes NOTHING. Every section of DATA asks this module for a
// series and draws it; that is what makes nine graphs testable without a
// canvas, and what keeps src/terminal.js from growing a second, divergent way
// of counting a week.
//
// Two inputs, and they are not equals:
//
//   `sessions`  the aggregates every flight has had since PHASE 06 — duration,
//               distance, the three maxima, the target, the area. Complete,
//               always there, never dropped.
//   `tracks`    the flight-track index (#24): per retained track, the start
//               point, a decimated polyline, the `end` event and the photo
//               points. Only the last 200 flights keep one (D3), and the
//               polyline carries no telemetry.
//
// So the historical graphs — RHYTHM, LIFE, SPEED × ALTITUDE, FAMILIES,
// GEOGRAPHY — are built from the aggregates and stay complete for ever, and
// only the sections that genuinely need a trace (HOW THEY DIED, STICKS,
// PROFILE) can come back empty. A flight without a track never leaves a hole
// in a graph that did not need one.

import { PROFILES } from '../src/drone-profiles.js';
import { areaLabel, pad, targetLogEntries } from './session-log-model.mjs';

// Twelve weeks: a season. Long enough to see a habit form, short enough that
// the bar for a week you flew once is still readable.
export const RHYTHM_WEEKS = 12;


function num(v) { return Number.isFinite(v) ? v : 0; }
function list(v) { return Array.isArray(v) ? v : []; }
function ms(iso) { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? null : t; }

// Chronological, by start. The stored order is the order sessions were written
// and a reconciled stale session can land out of sequence; a graph of time must
// read time, not insertion.
function chronological(sessions) {
	return list(sessions).filter((s) => s && typeof s === 'object')
		.slice()
		.sort((a, b) => (ms(a.start) ?? 0) - (ms(b.start) ?? 0));
}

function telemetry(s) { return (s && s.flightTelemetry) || {}; }

// ---------------------------------------------------------------------------
// Reading a track
//
// #24 owns the encoding. This tab reads a track through ONE accessor so that
// whatever `decodeTrack()` hands back — parallel arrays, as it is stored, or an
// array of objects — is the same thing here. An index entry, which carries no
// samples at all, reads as no samples rather than as an error.

const SAMPLE_FIELDS = ['t', 'lat', 'lon', 'alt', 'spd', 'thr', 'rate'];

export function trackSamples(track) {
	const s = track && typeof track === 'object' ? track.samples : null;
	if (Array.isArray(s)) {
		return s.filter((x) => x && typeof x === 'object').map((x) => {
			const out = {};
			for (const f of SAMPLE_FIELDS) out[f] = Number.isFinite(x[f]) ? x[f] : null;
			return out;
		});
	}
	if (!s || typeof s !== 'object') return [];
	const len = SAMPLE_FIELDS.reduce((m, f) => Math.max(m, Array.isArray(s[f]) ? s[f].length : 0), 0);
	const out = [];
	for (let i = 0; i < len; i++) {
		const row = {};
		for (const f of SAMPLE_FIELDS) {
			const col = s[f];
			row[f] = Array.isArray(col) && Number.isFinite(col[i]) ? col[i] : null;
		}
		out.push(row);
	}
	return out;
}

// The index, by session. A `Map` rather than an object: session ids are opaque
// strings and one of them being `__proto__` is not a reason to lose a track.
export function trackIndexOf(tracks) {
	const m = new Map();
	for (const t of list(tracks)) {
		if (!t || typeof t !== 'object') continue;
		const id = t.sessionId ?? t.id;
		if (typeof id === 'string' && id) m.set(id, t);
	}
	return m;
}

// ---------------------------------------------------------------------------
// 1. RHYTHM — sessions per week over the last twelve
//
// The only graph about real time, and the one that makes coming back visible.
// Weeks start on Monday, in LOCAL time: it is the operator's week, not UTC's.

function mondayOf(t) {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	// getDay(): 0 = Sunday. Monday is the start, so Sunday is six days in.
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d;
}

function ddmm(d) {
	const p = (v) => String(v).padStart(2, '0');
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
}

export function rhythmSeries(sessions, { now = Date.now(), weeks = RHYTHM_WEEKS } = {}) {
	// Boundaries are stepped on a Date rather than by subtracting 7×86400e3:
	// a daylight-saving change shifts a local Monday by an hour, and fixed
	// arithmetic would then file the first hour of a week under the previous one.
	const bars = [];
	const cursor = mondayOf(now);
	for (let i = 0; i < weeks; i++) {
		bars.unshift({ label: ddmm(cursor), value: 0, from: cursor.getTime(), current: i === 0 });
		cursor.setDate(cursor.getDate() - 7);
	}
	const end = mondayOf(now);
	end.setDate(end.getDate() + 7);
	let total = 0;
	for (const s of list(sessions)) {
		const t = ms(s?.start);
		if (t == null || t < bars[0].from || t >= end.getTime()) continue;
		let i = bars.length - 1;
		while (i > 0 && t < bars[i].from) i--;
		bars[i].value++;
		total++;
	}
	return { bars, weeks, total };
}

// ---------------------------------------------------------------------------
// 2. LIFE — duration per session, chronological

export function lifeSeries(sessions) {
	const bars = chronological(sessions).map((s) => ({
		id: s.id,
		label: pad(s.seq),
		value: num(telemetry(s).durationS),
	}));
	const maxS = bars.reduce((m, b) => Math.max(m, b.value), 0);
	const meanS = bars.length ? bars.reduce((a, b) => a + b.value, 0) / bars.length : 0;
	return { bars, maxS, meanS };
}

// ---------------------------------------------------------------------------
// 3. SPEED × ALTITUDE — the shape of a flying style
//
// One point per FLIGHT, from the maxima every session carries, not one point
// per sample: the track index ships a decimated polyline without telemetry, and
// reading 200 full tracks to plot a cloud would cost 3 MB for a scatter. The
// question the section asks — low and fast, or high and slow — is answered per
// flight anyway.
//
// A flight that never moved carries no shape and is not a point: it would sit
// on the origin and pull the eye to a flight that never happened.

export function speedAltitudeSeries(sessions) {
	const points = [];
	for (const s of chronological(sessions)) {
		const tel = telemetry(s);
		const x = num(tel.maxSpeedMs);
		const y = num(tel.maxAltitudeM);
		if (x <= 0 && y <= 0) continue;
		points.push({ id: s.id, label: `SESSION ${pad(s.seq)}`, x, y });
	}
	return {
		points,
		maxX: points.reduce((m, p) => Math.max(m, p.x), 0),
		maxY: points.reduce((m, p) => Math.max(m, p.y), 0),
	};
}

// ---------------------------------------------------------------------------
// 4. HOW THEY DIED — the state at the moment the link died
//
// Needs a track: the `end` event is the only place that state exists. Flights
// without one are COUNTED rather than drawn — `missing` is what lets the screen
// say how much of the history is not in the cloud, instead of implying that
// this is all of it.

export function lossSeries(sessions, tracks) {
	const idx = trackIndexOf(tracks);
	const points = [];
	let missing = 0;
	for (const s of chronological(sessions)) {
		const end = idx.get(s.id)?.end;
		if (!end || typeof end !== 'object') { missing++; continue; }
		points.push({
			id: s.id,
			label: `SESSION ${pad(s.seq)}`,
			x: num(end.spd),
			y: num(end.alt),
			result: end.result ?? s.result ?? 'UNKNOWN',
		});
	}
	return {
		points,
		missing,
		maxX: points.reduce((m, p) => Math.max(m, p.x), 0),
		maxY: points.reduce((m, p) => Math.max(m, p.y), 0),
	};
}

// ---------------------------------------------------------------------------
// 5. STICKS — throttle and rotation rate, for ONE flight
//
// Stick values live in the samples, which only a full track carries: the index
// does not have them. So this is the histogram of the SELECTED flight, the same
// one PROFILE draws — not of the whole history, which would mean downloading
// every track to draw two bar charts.
//
// Throttle is a stick: its scale is 0..1 whatever was flown, so two flights are
// comparable. Rotation rate has no ceiling and scales to what happened.

function histogram(values, { bins, max }) {
	const top = max > 0 ? max : 1;
	const out = [];
	for (let i = 0; i < bins; i++) {
		out.push({ x0: (top * i) / bins, x1: (top * (i + 1)) / bins, n: 0 });
	}
	for (const v of values) {
		// The top edge belongs to the last bin, otherwise full throttle falls out
		// of its own histogram.
		const i = Math.min(bins - 1, Math.floor((v / top) * bins));
		if (i >= 0) out[i].n++;
	}
	return { bins: out, max: top, peak: out.reduce((m, b) => Math.max(m, b.n), 0) };
}

export function stickSeries(track, { bins = 10 } = {}) {
	const samples = trackSamples(track);
	const thr = samples.map((s) => s.thr).filter((v) => Number.isFinite(v));
	// Filter BEFORE the absolute value: `Math.abs(null)` is 0, and a track with
	// no rate column would histogram as a flight that never rotated.
	const rate = samples.map((s) => s.rate).filter((v) => Number.isFinite(v)).map(Math.abs);
	if (!thr.length && !rate.length) return null;
	return {
		samples: Math.max(thr.length, rate.length),
		throttle: histogram(thr, { bins, max: 1 }),
		rate: histogram(rate, { bins, max: rate.reduce((m, v) => Math.max(m, v), 0) }),
	};
}

// ---------------------------------------------------------------------------
// 6. FAMILIES — a bar per target family, mean survival on it
//
// This section absorbs the TARGET LOG (D2): `entries` is exactly what that
// screen listed, grouped by the family it was flown against, so the log did not
// disappear — it acquired an axis. `targetLogEntries()` stays the one source.

function familyLabel(family) {
	return PROFILES[family]?.label ?? String(family ?? 'UNKNOWN');
}

export function familySeries(sessions) {
	const entries = targetLogEntries(list(sessions));
	const byId = new Map(list(sessions).filter((s) => s?.id).map((s) => [s.id, s]));
	const groups = new Map();
	for (const e of entries) {
		const key = e.family ?? 'unknown';
		if (!groups.has(key)) groups.set(key, { family: key, label: familyLabel(key), count: 0, sumS: 0, entries: [] });
		const g = groups.get(key);
		g.count++;
		g.sumS += num(telemetry(byId.get(e.sessionId)).durationS);
		g.entries.push(e);
	}
	const families = [...groups.values()]
		.map((g) => ({ ...g, meanS: g.count ? g.sumS / g.count : 0 }))
		// Most met first: the family an operator keeps running into is the one
		// the section is about.
		.sort((a, b) => b.count - a.count || b.meanS - a.meanS);
	return {
		families,
		total: entries.length,
		max: families.reduce((m, f) => Math.max(m, f.meanS), 0),
	};
}

// ---------------------------------------------------------------------------
// 7. GEOGRAPHY — where the operator has been
//
// Countries are reported ONLY when a session carries one. Nothing writes that
// field today, and deriving it from a slug would be a guess dressed as a fact:
// the screen prints `—` rather than inventing a flag.

export function geographySeries(sessions) {
	const areas = new Map();
	const countries = new Map();
	let distanceM = 0;
	for (const s of chronological(sessions)) {
		distanceM += num(telemetry(s).distanceM);
		const slug = typeof s.area === 'string' && s.area ? s.area : null;
		if (slug) areas.set(slug, (areas.get(slug) ?? 0) + 1);
		const code = s.country ?? s.place?.country ?? null;
		if (typeof code === 'string' && code) countries.set(code, (countries.get(code) ?? 0) + 1);
	}
	const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
	return {
		areas: rank(areas).map(([slug, count]) => ({ slug, label: areaLabel(slug), count })),
		countries: rank(countries).map(([code, count]) => ({ code, count })),
		areaCount: areas.size,
		distanceM,
	};
}

// ---------------------------------------------------------------------------
// 8. PROFILE — altitude against time, for one flight
//
// A photo is placed at its own time when the track records one, and by the
// sample it was taken at otherwise; a photo that says neither is not drawn,
// because a mark at t = 0 would be a lie about when the shot was taken.

export function profileSeries(track) {
	const samples = trackSamples(track);
	const points = samples
		.map((s, i) => ({ t: Number.isFinite(s.t) ? s.t : i, alt: num(s.alt) }))
		.filter((p) => Number.isFinite(p.t));
	if (!points.length || !samples.some((s) => Number.isFinite(s.alt))) return null;
	const photos = [];
	for (const p of list(track?.photos)) {
		if (!p || typeof p !== 'object') continue;
		let i = null;
		if (Number.isFinite(p.sample)) i = p.sample;
		else if (Number.isFinite(p.t)) i = points.findIndex((q) => q.t >= p.t);
		if (i == null || i < 0 || i >= points.length) continue;
		photos.push({ i: p.i ?? photos.length, t: points[i].t, alt: points[i].alt });
	}
	return {
		points,
		photos,
		durationS: points[points.length - 1].t - points[0].t,
		maxAltM: points.reduce((m, p) => Math.max(m, p.alt), 0),
	};
}

// The flight PROFILE opens on: the last one that has a track. Not simply the
// last flight — that one may well be older than the retention window, and
// opening on `NO TRACK` when a drawable flight exists reads as a broken screen.
export function defaultFlightId(sessions, tracks) {
	const idx = trackIndexOf(tracks);
	const flights = chronological(sessions).filter((s) => idx.has(s.id));
	return flights.length ? flights[flights.length - 1].id : null;
}

// ---------------------------------------------------------------------------
// The whole screen, in one call. The UI walks these fields in order and draws
// them; it decides nothing.

export function dataModel({ sessions, tracks, now = Date.now() } = {}) {
	const ordered = chronological(sessions);
	const idx = trackIndexOf(tracks);
	const flights = ordered.filter((s) => idx.has(s.id)).map((s) => ({
		id: s.id,
		label: `SESSION ${pad(s.seq)}`,
		area: s.area ?? null,
		start: s.start ?? null,
	}));
	return {
		sessionCount: ordered.length,
		rhythm: rhythmSeries(ordered, { now }),
		life: lifeSeries(ordered),
		speedAlt: speedAltitudeSeries(ordered),
		loss: lossSeries(ordered, tracks),
		families: familySeries(ordered),
		geography: geographySeries(ordered),
		flights,
		hasTracks: flights.length > 0,
		selectedId: flights.length ? flights[flights.length - 1].id : null,
	};
}
