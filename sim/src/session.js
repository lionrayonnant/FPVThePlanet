// The lifecycle of a session, client side (PHASE 06). No DOM, no Three.
//
// The session is held in memory for the whole flight: only two network
// calls, a POST at the opening (a PENDING skeleton on disk, so a dead tab
// still leaves a trace) and a PATCH at the closing with the aggregated
// telemetry. Nothing during the flight.
//
//   terrain persistent, flights ephemeral
import * as operator from './operator.js';
import { Coverage } from './coverage.js';
import { encodeTrack, MAX_SAMPLES } from '../tools/track-model.mjs';

// Coverage (issue #245) is sampled at 5 Hz, not per frame: at 42.72 m/s — the
// worst speed measured in the repo — two samples are 8.5 m apart, well under
// the footprint's 30 m. No gap is possible, and there is nothing to do
// between two samples.
export const SAMPLE_S = 0.2;

let live = null; // { id, session, tel, closed, cov, sinceSample, track }

// The in-memory flight track (issue #24). Held exactly like `cov`: accumulated
// on the same 5 Hz boundary, written ONCE at close (D4). A dead tab loses the
// track and keeps the session — a 15 kB beacon is not worth risking the close.
function freshTrack() {
	return {
		samples: [],   // { t, lat, lon, alt, spd, thr, rate }, real units
		t: 0,          // seconds armed since the first sample
		start: null,   // { lat, lon } — the JACK IN point
		photos: [],    // { i, lat, lon, heading }, i indexes session.photos[]
		last: null,    // the most recent sample state, source of the `end` event
		heading: 0,    // the most recent heading, in degrees — geotags a capture
		overflow: false, // true once the MAX_SAMPLES cap has been hit
	};
}

// The minimal shape of the weather snapshot, without depending on the server
// model (which pulls node:crypto). The server re-filters it anyway.
export function snapshotWeather(weather) {
	if (!weather) return null;
	const day0 = weather.days?.[0] ?? null;
	if (!day0) return null;
	return {
		zone: weather.zone ?? null,
		day: weather.day ?? null,
		source: weather.source ?? null,
		regime: day0.regime ?? null,
		confidence: Number.isFinite(day0.confidence) ? day0.confidence : null,
		day0,
	};
}

function zeroTel() {
	return { durationS: 0, maxSpeedMs: 0, maxRateDps: 0, maxAltitudeM: 0, distanceM: 0 };
}

export function current() { return live?.session ?? null; }

export async function open({ area, weatherSnapshot, target } = {}) {
	// `target = { seed, count, index }`: the target chosen at the TARGET SCAN.
	// The server regenerates the full sheet from these three keys (PHASE 08).
	// `swarmChance` (issue #29) travels with them because the server cannot
	// recompute it: it depends on the early guarantee, which the client
	// evaluates on the operator state it already holds.
	// `clearance` (issue #185) travels too: the server recomputes the SAME
	// family pool and the SAME swarm gate from it, rather than trusting a
	// client-supplied family list — it is the authority on both.
	const session = await operator.postSession({
		area, weatherSnapshot,
		targetSeed: target?.seed, targetCount: target?.count, targetIndex: target?.index,
		swarmChance: target?.swarmChance, clearance: target?.clearance,
	});
	live = {
		id: session.id, session, tel: zeroTel(), closed: false,
		cov: new Coverage(), sinceSample: 0, track: freshTrack(),
	};
	return session;
}

// The current session's coverage (issue #245), for the benches and debug.
export function coverage() { return live?.cov ?? null; }

// The current session's track (issue #24), for the selftests and debug.
export function track() { return live?.track ?? null; }

// Called once per frame. Only aggregates duration and distance while the
// drone is armed — a wreck does not "fly".
//
// `geo` (issue #245): a FUNCTION that renders { lat, lon }, not the value. It
// is only called at samples (5 Hz), so the ENU -> lat/lon conversion costs
// nothing in between. A non-finite result is ignored: a degenerate position
// (a drone gone under the terrain during a crash, #182) must not mark a cell
// off the coast of Africa.
//
// `throttle` and `headingDeg` (issue #24) are ONLY used by the track: the
// aggregated telemetry ignores them. They arrive from the same call site as
// the rest, where they are already computed.
export function feed({
	speed = 0, horizontalSpeed = 0, rateDps = 0, altitudeAboveSpawn = 0,
	dt = 0, armed = false, geo = null, throttle = 0, headingDeg = 0,
} = {}) {
	if (!live || live.closed) return;
	const t = live.tel;
	// Nothing counts while the drone is disarmed: not the duration, not the
	// distance, not the peaks — a downed drone bouncing on its collision
	// sphere is not "flying at 2000 deg/s".
	if (!armed) return;
	if (dt > 0) {
		t.durationS += dt;
		t.distanceM += Math.max(0, horizontalSpeed) * dt;
		// dt = 0 when the sim is frozen: no sampling while paused.
		live.sinceSample += dt;
		// `- 1e-9`: twelve additions of 1/60 land on 0.19999999999999998.
		if (geo && live.sinceSample >= SAMPLE_S - 1e-9) {
			live.sinceSample = 0;
			const g = geo();
			if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
				live.cov.mark(g.lat, g.lon);
				// The track (issue #24) rides on the SAME boundary and the same
				// position: one array push per sample, no second timer, no second
				// ENU → lat/lon conversion.
				const tr = live.track;
				tr.t += SAMPLE_S;
				const s = {
					t: tr.t, lat: g.lat, lon: g.lon,
					alt: altitudeAboveSpawn, spd: speed, thr: throttle, rate: rateDps,
				};
				// The cap is also held HERE: encodeTrack() truncates anyway, but a
				// tab's memory must not grow unbounded over a ninety-minute flight.
				if (tr.samples.length < MAX_SAMPLES) tr.samples.push(s); else tr.overflow = true;
				tr.last = s;
				tr.heading = headingDeg;
				if (!tr.start) tr.start = { lat: g.lat, lon: g.lon };
			}
		}
	}
	if (speed > t.maxSpeedMs) t.maxSpeedMs = speed;
	if (rateDps > t.maxRateDps) t.maxRateDps = rateDps;
	if (altitudeAboveSpawn > t.maxAltitudeM) t.maxAltitudeM = altitudeAboveSpawn;
}

// Number of captures taken during the current session (PHASE 16).
export function photoCount() { return live?.session?.photos?.length ?? 0; }

// Sends a capture to the server, which is authoritative on the final count
// (rendered via the updated session). Returns 0 without sending anything if
// no session is open or it is already closed — no orphan photo.
export async function capturePhoto({ dataUrl, w, h }) {
	if (!live || live.closed) return 0;
	try {
		live.session = await operator.postPhoto(live.id, { dataUrl, w, h });
		markPhoto();
		return photoCount();
	} catch (e) {
		console.warn('[session] capture failed', e);
		return photoCount();
	}
}

// Geotags the capture the server just accepted (issue #24): where the drone was
// and where it looked, indexed into the session's photos[]. The position lives
// on the TRACK, not on the photo — sanitizePhoto is untouched, so dropping a
// track (D3) never invalidates a photo, it only forgets where it was taken.
//
// Before the first 5 Hz sample there is no position to record; the photo still
// exists, it simply never reaches the map.
function markPhoto() {
	const tr = live.track;
	if (!tr.last) return;
	tr.photos.push({
		i: photoCount() - 1,
		lat: tr.last.lat, lon: tr.last.lon, heading: tr.heading,
	});
}

// `CRASHED`, the only verdict a flight produces (D9, 2026-09-08: landing
// disappeared). Idempotent: the first verdict wins.
export async function end(result) {
	if (!live || live.closed) return null;
	live.closed = true;
	const { id, tel } = live;
	// Coverage is written HERE, once (issue #245). operator.patch() is
	// debounced but re-emits the whole value on every flush: patching in
	// flight would send the entire blob several times a second. And that is
	// the right shape anyway: the world remembers what a session DID, not
	// what it is doing.
	//
	// The bench never reaches here: it opens no session, so `live` is null
	// and feed() marks nothing. NOTHING LOGGED holds by construction, with no
	// guard to maintain.
	//
	// Before the session's PATCH: if that fails, the coverage is still in the
	// client cache and will leave on the next flush — a flight that loses its
	// record must not also lose its trace on the map.
	flushCoverage();
	try {
		const session = await operator.patchSession(id, { result, telemetry: round(tel) });
		live.session = session;
		// The track leaves AFTER the PATCH and only if it succeeded (issue #24):
		// it needs an existing session server-side, and its own failure is
		// swallowed. Losing the track must never cost the session.
		await flushTrack(id, result);
		return session;
	} catch (e) {
		console.warn('[session] close failed, reconciliation at the next terminal visit', e);
		return null;
	}
}

// Encodes the accumulated track and writes it in a single PUT (D4). A session
// with no sample writes nothing: no empty file for a flight that never left
// the ground.
async function flushTrack(id, result) {
	const tr = live.track;
	if (tr.samples.length === 0) return;
	try {
		const end = tr.last
			? { lat: tr.last.lat, lon: tr.last.lon, alt: tr.last.alt, spd: tr.last.spd, result }
			: null;
		const stored = encodeTrack(tr.samples, { start: tr.start, end, photos: tr.photos },
			{ truncated: tr.overflow });
		await operator.putTrack(id, stored);
	} catch (e) {
		console.warn('[session] track not written (the session itself is closed)', e);
	}
}

// Merges the session's coverage with the operator's, caps it, and sets the
// key in the client cache via patch() — written on the next flush (debounce,
// visibilitychange or beforeunload). A session that marked nothing writes
// nothing: no key set for nothing on an operator that had none.
//
// The operator's coverage is read back by fromStored(), which renders an
// empty coverage for anything not exactly the expected shape: a corrupt file
// restarts from the session alone rather than blocking the close.
function flushCoverage() {
	if (!live || live.cov.size === 0) return;
	try {
		const before = Coverage.fromStored(operator.getOperator()?.coverage);
		const merged = before.merge(live.cov).cap();
		operator.patch('coverage', merged.toStored());
	} catch (e) {
		console.warn('[session] coverage not written (cosmetic)', e);
	}
}

// Best-effort when the tab closes mid-flight: sendBeacon can only do POST,
// and the close route accepts one for that. If it fails, server-side
// reconciliation turns the PENDING session into CRASHED.
export function beacon(result = 'CRASHED') {
	if (!live || live.closed) return;
	live.closed = true;
	// sendBeacon only ever does POST, and coverage travels through a PATCH of
	// an operator key: THIS session's track is lost if the tab dies. Accepted
	// (spec #245) — the session's record itself does leave.
	//
	// Same for the track (issue #24, D4): the beacon stays aggregates only.
	// Fifteen more kilobytes are not worth risking the whole close, which is
	// the only thing sendBeacon really has to save.
	try {
		const op = operator.getOperator();
		if (!op || !navigator.sendBeacon) return;
		const url = `${operator.operatorBase()}/${op.id}/sessions/${live.id}`;
		const blob = new Blob([JSON.stringify({ result, telemetry: round(live.tel) })],
			{ type: 'application/json' });
		navigator.sendBeacon(url, blob);
	} catch { /* the tab dies, reconciliation covers it */ }
}

function round(t) {
	return {
		durationS: +t.durationS.toFixed(1),
		distanceM: Math.round(t.distanceM),
		maxSpeedMs: +t.maxSpeedMs.toFixed(1),
		maxRateDps: Math.round(t.maxRateDps),
		maxAltitudeM: +t.maxAltitudeM.toFixed(1),
	};
}

// For the tests.
export function _reset() { live = null; }
