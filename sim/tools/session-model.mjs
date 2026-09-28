// Pure logic of the session model (PHASE 06). No I/O: imported by the dev
// plugin, by the selftest and (through a Vite bundle) by the client.
//
// A session binds an operator, a terrain area, a target, a weather snapshot, a
// time interval, a verdict and aggregated telemetry.
//
//   terrain persistent, flights ephemeral
//
// `PENDING` → `CRASHED` (impact, fence exit or cut link: drone destroyed,
//                        session terminated)
import { randomBytes } from 'node:crypto';
import { slugify } from './operator-store.mjs';
import { asText, nameOf } from './lib/as-text.mjs';
import { TELEMETRY_MAX } from './lib/telemetry-bounds.mjs';
import {
	TARGET_FAMILIES, HACK_TYPES,
	SWARM_FAMILY, SWARM_SIZE_MIN, SWARM_SIZE_MAX,
} from './target-model.mjs';

// v3 (issue #29) adds target.swarm and target.scan.swarmAt/swarmChance. No
// migration: a v2 session simply has no swarm, honestly, the way a v1 session
// has no ambients.
export const SESSION_SCHEMA_VERSION = 3;
// The verdicts a flight can PRODUCE. `LANDED` left with landing itself
// (D9, 2026-09-08): a flight now ends only by a crash, a fence exit or a cut
// link, and all three are `CRASHED`.
export const SESSION_RESULTS = ['PENDING', 'CRASHED'];
// The verdicts an operator file may CONTAIN. States written before landing
// disappeared carry `LANDED`: they must keep being read back, displayed and
// annotated. No migration, no SESSION_SCHEMA_VERSION bump — a past verdict
// stays true.
const STORED_RESULTS = [...SESSION_RESULTS, 'LANDED'];
export const SESSION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;

// A session left in `PENDING` for longer than this when the terminal reloads
// was not closed cleanly: the tab died in flight. That is a crash. Deliberately
// generous — better to catch a crash late than to mark CRASHED a session still
// in flight whose terminal was reopened in another tab.
const STALE_MS = 30 * 60 * 1000;

const ZERO_TELEMETRY = {
	durationS: 0,
	maxSpeedMs: 0,
	maxRateDps: 0,
	maxAltitudeM: 0,
	distanceM: 0,
};

export { TELEMETRY_MAX };

export function freshTelemetry() {
	return { ...ZERO_TELEMETRY };
}

export function newSessionId(area) {
	const base = slugify(area);
	if (!base) throw new Error('AREA UNUSABLE');
	return `${base}-${randomBytes(2).toString('hex')}`;
}

// Keeps only the known shape of the weather snapshot. `null` is legal: the
// weather is scenery, it is not allowed to prevent a flight — so it is not
// allowed to prevent a session opening either.
//
// It PICKS its keys rather than spreading `day0`. The snapshot arrives from
// the client and is written to the operator file, then read back and rendered
// on the SESSION record: whatever the client put in `day0` was stored verbatim
// and travelled all the way to another operator's screen. Only the ten fields
// the weather model actually produces survive here, each coerced to its own
// type — an unknown key is dropped, and a string field cannot smuggle a value
// the record will not treat as text.
const DAY_TEXT = ['date', 'regime'];
const DAY_NUM = [
	'windSpeed', 'windGust', 'windDir', 'rateMmH', 'precipMm',
	'cloudPct', 'visibilityM', 'confidence',
];
const text = (v) => (typeof v === 'string' ? v : null);
export function sanitizeWeatherSnapshot(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('invalid weatherSnapshot');
	const src = raw.day0 ?? raw.days?.[0] ?? null;
	if (!src || typeof src !== 'object') throw new Error('weatherSnapshot has no day');
	const num = (v) => (Number.isFinite(v) ? v : null);
	const day0 = {};
	for (const k of DAY_TEXT) day0[k] = text(src[k]);
	for (const k of DAY_NUM) day0[k] = num(src[k]);
	return {
		zone: text(raw.zone),
		day: text(raw.day),
		source: text(raw.source),
		regime: day0.regime,
		confidence: day0.confidence,
		day0,
	};
}

// The originating scan (issue #250). `null` for a v1 session, which never had
// one: it keeps its target but not its ambients.
function sanitizeScan(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('invalid target.scan');
	if (typeof raw.seed !== 'string' || raw.seed.length === 0) throw new Error('invalid target.scan.seed');
	if (!Number.isInteger(raw.count) || raw.count < 2 || raw.count > 5) throw new Error('invalid target.scan.count');
	if (!Number.isInteger(raw.index) || raw.index < 0 || raw.index >= raw.count) throw new Error('invalid target.scan.index');
	// v3 (issue #29). Absent on a v2 scan, which predates swarms: it replays as
	// `null` chance 0, i.e. swarmless, which is exactly what it was.
	const at = raw.swarmAt ?? null;
	if (at !== null && (!Number.isInteger(at) || at < 0 || at >= raw.count)) {
		throw new Error('invalid target.scan.swarmAt');
	}
	const chance = raw.swarmChance ?? 0;
	if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new Error('invalid target.scan.swarmChance');
	const out = { seed: raw.seed, count: raw.count, index: raw.index, swarmAt: at, swarmChance: chance };
	// The clearance pool the scan drew from (issue #185): the ambient
	// regeneration must draw from the same one. Kept only as a non-empty subset
	// of TARGET_FAMILIES; anything else is omitted and the replay falls back to
	// the full pool, the way a scan from before clearance did.
	const fams = raw.families;
	if (Array.isArray(fams) && fams.length > 0 && fams.every((f) => TARGET_FAMILIES.includes(f))) {
		out.families = [...fams];
	}
	return out;
}

// The mesh the node commands (issue #29). `null` on any ordinary target.
function sanitizeSwarm(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('invalid target.swarm');
	if (!Number.isInteger(raw.size) || raw.size < SWARM_SIZE_MIN || raw.size > SWARM_SIZE_MAX) {
		throw new Error('invalid target.swarm.size');
	}
	if (typeof raw.doctrineSeed !== 'string' || raw.doctrineSeed.length === 0) {
		throw new Error('invalid target.swarm.doctrineSeed');
	}
	return { size: raw.size, doctrineSeed: raw.doctrineSeed };
}

// The families an operator file may CONTAIN. `swarmNode` is not in
// TARGET_FAMILIES and must not enter it — an ordinary scan could then draw it
// and the rarity would be gone (issue #29) — but a session that took a cluster
// carries it legitimately, so it is allowed here, explicitly.
const STORED_FAMILIES = [...TARGET_FAMILIES, SWARM_FAMILY];

// Keeps only the known shape of the target descriptor (PHASE 08). `null` is
// legal: a session can open with no target (the ?scene= dev path).
export function sanitizeTarget(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('invalid target');
	if (!STORED_FAMILIES.includes(raw.family)) throw new Error(`unknown target family: ${asText(raw.family, nameOf(raw.family))}`);
	if (raw.hackType != null && !HACK_TYPES.includes(raw.hackType)) {
		throw new Error(`unknown target hackType: ${asText(raw.hackType, nameOf(raw.hackType))}`);
	}
	const sig = raw.signal;
	if (!sig || typeof sig !== 'object') throw new Error('target.signal missing');
	if (!Number.isFinite(sig.rssiDbm) || sig.rssiDbm >= 0) throw new Error('invalid target.signal.rssiDbm');
	if (sig.mode !== 'ANALOG' && sig.mode !== 'DIGITAL') throw new Error('invalid target.signal.mode');
	if (!raw.intel || typeof raw.intel !== 'object') throw new Error('target.intel missing');
	return {
		family: raw.family,
		classHint: raw.classHint ?? null,
		hackType: raw.hackType ?? null,
		signal: { rssiDbm: sig.rssiDbm, mode: sig.mode },
		scannedAt: raw.scannedAt ?? null,
		scan: sanitizeScan(raw.scan),
		swarm: sanitizeSwarm(raw.swarm),
		intel: { ...raw.intel },
	};
}

// Keeps only the known shape of a capture (PHASE 16). `ts` is stamped by the
// server, never the one the client sends: a photo's timestamp must not depend
// on the browser's clock.
export function sanitizePhoto(raw) {
	if (!raw || typeof raw !== 'object') throw new Error('invalid photo');
	if (typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:image/')) {
		throw new Error('invalid photo.dataUrl');
	}
	if (!Number.isInteger(raw.w) || raw.w <= 0) throw new Error('invalid photo.w');
	if (!Number.isInteger(raw.h) || raw.h <= 0) throw new Error('invalid photo.h');
	return { dataUrl: raw.dataUrl, w: raw.w, h: raw.h, ts: new Date().toISOString() };
}

// Adds a capture without mutating the existing session: several captures per
// session, each one more element in `photos[]`.
export function addPhoto(session, raw) {
	if (!session || typeof session !== 'object') throw new Error('unreadable session');
	const photo = sanitizePhoto(raw);
	return { ...session, photos: [...(session.photos ?? []), photo] };
}

export function openSession({ operatorId, area, weatherSnapshot, target, seq, targetSeq }) {
	if (!operatorId) throw new Error('operatorId required');
	const areaSlug = slugify(area);
	if (!areaSlug) throw new Error('AREA UNUSABLE');
	const id = newSessionId(area);
	const resolved = sanitizeTarget(target);
	const session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		id,
		operatorId,
		area: areaSlug,
		// Display number (PHASE 17). Assigned by the server, the only side that
		// knows the operator's counter; frozen forever.
		seq,
		target: resolved,
		weatherSnapshot: sanitizeWeatherSnapshot(weatherSnapshot),
		start: new Date().toISOString(),
		end: null,
		result: 'PENDING',
		flightTelemetry: freshTelemetry(),
		photos: [],
		comment: null,
	};
	// With no target the key is only set if the caller said something: a session
	// opened without TARGET SCAN has no `targetSeq` at all, and an explicit
	// `null` stays a `null` (which `validateSession` accepts).
	if (resolved || targetSeq !== undefined) session.targetSeq = targetSeq;
	return session;
}

// Merges two sets of aggregates: `max` on the peaks, `+` on the totals.
// Associative — three segments in any order give the same total.
export function mergeTelemetry(rawA = ZERO_TELEMETRY, rawB = ZERO_TELEMETRY) {
	// A default parameter only covers `undefined`. A stored session whose
	// `flightTelemetry` is null — JSON can hold that, and a file written by
	// hand does — reached this as `null` and closeSession died on it with a
	// TypeError instead of closing the flight.
	const a = rawA ?? ZERO_TELEMETRY;
	const b = rawB ?? ZERO_TELEMETRY;
	const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
	// The sums are capped, not just the inputs: a session already at the
	// ceiling must still be closeable, and a merge that overshot it would
	// produce a session validateSession refuses — the flight would stay
	// PENDING forever (#83). Saturating is the honest answer: the cap is
	// unreachable by flying, so only a lie ever hits it.
	const cap = (k, v) => Math.min(v, TELEMETRY_MAX[k]);
	return {
		durationS: cap('durationS', n(a.durationS) + n(b.durationS)),
		distanceM: cap('distanceM', n(a.distanceM) + n(b.distanceM)),
		maxSpeedMs: cap('maxSpeedMs', Math.max(n(a.maxSpeedMs), n(b.maxSpeedMs))),
		maxRateDps: cap('maxRateDps', Math.max(n(a.maxRateDps), n(b.maxRateDps))),
		maxAltitudeM: cap('maxAltitudeM', Math.max(n(a.maxAltitudeM), n(b.maxAltitudeM))),
	};
}

export function closeSession(session, { result, telemetry } = {}) {
	if (!session || typeof session !== 'object') throw new Error('unreadable session');
	if (result !== 'CRASHED') throw new Error('invalid verdict');
	return {
		...session,
		end: new Date().toISOString(),
		result,
		flightTelemetry: mergeTelemetry(session.flightTelemetry, telemetry),
	};
}

// OPERATOR NOTE (PHASE 15, Bible §25): free text, attached to an already closed
// session as well as to a PENDING one — unlike closeSession, which requires
// PENDING (a verdict does not reopen), a note can be added at any time.
const COMMENT_MAX_LEN = 400;

export function sanitizeComment(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'string') throw new Error('invalid comment');
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.length > COMMENT_MAX_LEN) throw new Error(`COMMENT TOO LONG (max ${COMMENT_MAX_LEN})`);
	return trimmed;
}

export function annotateSession(session, comment) {
	if (!session || typeof session !== 'object') throw new Error('unreadable session');
	return { ...session, comment: sanitizeComment(comment) };
}

// PHASE 17, spec D4: captures are stored as base64 INSIDE the session, and the
// terminal reloads the whole operator every time it returns to the menu. The
// `dataUrl`s are elided from every response except the dedicated route
// `GET .../sessions/:sid`, the only one that returns them — and the only one
// the VIEW SESSION screen calls. `w`/`h`/`ts` stay: they are enough for the
// count and for the WITH PHOTOS filter.
//
// The result is a WIRE FORMAT, not a persistable state: it never goes back
// through `validateSession` (which rightly demands a `dataUrl` per capture),
// and the elision only happens when answering, after the disk write.
export function stripPhotoData(session) {
	if (!session || typeof session !== 'object') return session;
	return {
		...session,
		photos: (session.photos ?? []).map(({ dataUrl, ...rest }) => rest),
	};
}

export function stripOperatorPhotoData(state) {
	if (!state || typeof state !== 'object') return state;
	return { ...state, sessions: (state.sessions ?? []).map(stripPhotoData) };
}

// PHASE 17, spec D3: outright deletion. The entry leaves `state.sessions`,
// captures included; the terrain is NEVER touched — the mirror of "removing the
// terrain does not remove the memory" (Bible §29).
// The counters do not go back: a number is not recycled, a deletion leaves a
// visible hole in the log.
export function deleteSession(state, sid) {
	const sessions = state?.sessions ?? [];
	const i = sessions.findIndex((s) => s.id === sid);
	if (i < 0) {
		const e = new Error(`no session "${sid}"`);
		e.status = 404;
		throw e;
	}
	if (sessions[i].result === 'PENDING') {
		// Possibly still in flight in another tab: we do not delete out from
		// under an open session.
		const e = new Error(`session "${sid}" still in flight`);
		e.status = 409;
		throw e;
	}
	return { ...state, sessions: [...sessions.slice(0, i), ...sessions.slice(i + 1)] };
}

// Server guard: rejects anything that does not have the expected shape.
export function validateSession(s) {
	if (!s || typeof s !== 'object') throw new Error('unreadable session');
	if (!SESSION_ID_RE.test(asText(s.id))) throw new Error('invalid session id');
	if (!STORED_RESULTS.includes(s.result)) throw new Error(`unknown result: ${asText(s.result, nameOf(s.result))}`);
	if (!s.operatorId) throw new Error('operatorId required');
	if (!slugify(s.area)) throw new Error('invalid area');
	sanitizeWeatherSnapshot(s.weatherSnapshot); // throws if malformed
	// sanitizeTarget holds ALL of the target's shape validation, the v3 swarm
	// included: validating it a second time here would mean two rules to keep.
	if (s.target != null) sanitizeTarget(s.target); // throws if malformed
	// Display numbers (PHASE 17). Checked AFTER the target's shape: a malformed
	// target is a more fundamental error than its numbering, and that is what
	// the caller must see first.
	if (!Number.isInteger(s.seq) || s.seq < 1) throw new Error('invalid session seq');
	if (s.target != null) {
		if (!Number.isInteger(s.targetSeq) || s.targetSeq < 1) {
			throw new Error('targetSeq required for a session with a target');
		}
	} else if (s.targetSeq != null) {
		throw new Error('targetSeq without a target');
	}
	const t = s.flightTelemetry ?? {};
	for (const k of Object.keys(ZERO_TELEMETRY)) {
		const v = t[k];
		if (!Number.isFinite(v) || v < 0) throw new Error(`invalid telemetry.${k}`);
		if (v > TELEMETRY_MAX[k]) throw new Error(`telemetry.${k} out of bounds (max ${TELEMETRY_MAX[k]})`);
	}
	if (s.result !== 'PENDING' && !s.end) throw new Error('closed session without end');
	if (!Array.isArray(s.photos)) throw new Error('invalid photos');
	for (const p of s.photos) sanitizePhoto(p); // throws if a capture is malformed
	return s;
}

// Turns to `CRASHED` any session left `PENDING` past the threshold: the tab
// died in flight. Returns `{ state, changed }` — the caller rewrites if needed.
export function reconcileStaleSessions(state, now = Date.now()) {
	let changed = false;
	const sessions = (state.sessions ?? []).map((s) => {
		if (s.result !== 'PENDING') return s;
		const age = now - Date.parse(s.start ?? 0);
		if (!(age > STALE_MS)) return s;
		changed = true;
		return { ...s, result: 'CRASHED', end: new Date(now).toISOString() };
	});
	return { state: changed ? { ...state, sessions } : state, changed };
}
