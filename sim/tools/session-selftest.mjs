// Selftest of the session model (PHASE 06). No network, no disk: src/operator.js's
// fetch is stubbed like in src/operator.selftest.mjs.
// Run: node tools/session-selftest.mjs
import assert from 'node:assert/strict';
import {
	openSession, closeSession, mergeTelemetry, SESSION_RESULTS,
	validateSession, reconcileStaleSessions, sanitizeWeatherSnapshot,
	freshTelemetry, newSessionId, SESSION_ID_RE,
	sanitizeComment, annotateSession,
	sanitizePhoto, addPhoto,
	stripPhotoData, stripOperatorPhotoData, deleteSession,
	sanitizeTarget, SESSION_SCHEMA_VERSION, TELEMETRY_MAX,
} from './session-model.mjs';
import { migrate, freshState, SCHEMA_VERSION } from './operator-store.mjs';
import {
	TARGET_FAMILIES, HACK_TYPES, generateTargetScan, resolveTarget,
	SWARM_FAMILY, SWARM_SIZE_MIN, SWARM_SIZE_MAX,
} from './target-model.mjs';
import { decodeTrack, MAX_SAMPLES } from './track-model.mjs';
import * as op from '../src/operator.js';
import * as session from '../src/session.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const WEATHER = {
	zone: '35.68,139.65', day: '2026-08-29', source: 'open-meteo',
	days: [{ regime: 'CLEAR', confidence: 0.94, tMax: 30 }],
};

// ---------------------------------------------------------------------------
// session-model
//
// NOTE: the regexes passed to assert.throws() below match error strings
// actually thrown by tools/session-model.mjs, a file this task does not
// touch and which stays in French — they are left as-is, verbatim, because
// they are data (what the source throws), not test prose.

t('newSessionId: area slug + 4 hex, matches the regex', () => {
	const id = newSessionId('Tokyo Shibuya');
	assert.match(id, SESSION_ID_RE);
	assert.match(id, /^tokyo-shibuya-[0-9a-f]{4}$/);
	assert.throws(() => newSessionId('!!!'), /AREA UNUSABLE/);
});

t('openSession: full PENDING shape, telemetry at zero', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'tokyo-shibuya', weatherSnapshot: WEATHER });
	assert.equal(s.result, 'PENDING');
	assert.equal(s.operatorId, 'neo-3f9c');
	assert.equal(s.area, 'tokyo-shibuya');
	assert.equal(s.target, null);
	assert.deepEqual(s.photos, []);
	assert.equal(s.comment, null);
	assert.equal(s.end, null);
	assert.ok(s.start);
	assert.deepEqual(s.flightTelemetry, freshTelemetry());
	assert.equal(s.weatherSnapshot.regime, 'CLEAR');
	assert.doesNotThrow(() => validateSession(s));
});

t('sanitizeWeatherSnapshot: keeps only the known shape, null is legitimate', () => {
	assert.equal(sanitizeWeatherSnapshot(null), null);
	const clean = sanitizeWeatherSnapshot({ ...WEATHER, secret: 42 });
	assert.deepEqual(Object.keys(clean).sort(), ['confidence', 'day', 'day0', 'regime', 'source', 'zone']);
	assert.equal(clean.confidence, 0.94);
	assert.throws(() => sanitizeWeatherSnapshot({ zone: 'x' }), /sans jour/);
});

t('mergeTelemetry: max on the peaks, sum on the cumulatives, associative', () => {
	const a = { durationS: 100, distanceM: 500, maxSpeedMs: 20, maxRateDps: 400, maxAltitudeM: 30 };
	const b = { durationS: 60, distanceM: 300, maxSpeedMs: 27, maxRateDps: 380, maxAltitudeM: 55 };
	const c = { durationS: 12, distanceM: 40, maxSpeedMs: 15, maxRateDps: 900, maxAltitudeM: 10 };
	const ab_c = mergeTelemetry(mergeTelemetry(a, b), c);
	const a_bc = mergeTelemetry(a, mergeTelemetry(b, c));
	assert.deepEqual(ab_c, a_bc);
	assert.equal(ab_c.durationS, 172);
	assert.equal(ab_c.distanceM, 840);
	assert.equal(ab_c.maxSpeedMs, 27);
	assert.equal(ab_c.maxRateDps, 900);
	assert.equal(ab_c.maxAltitudeM, 55);
});

t('telemetry: every field is bounded, and a bounded session still closes (#83)', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris' });
	for (const [k, max] of Object.entries(TELEMETRY_MAX)) {
		const at = { ...freshTelemetry(), [k]: max };
		assert.equal(validateSession({ ...s, flightTelemetry: at }).flightTelemetry[k], max, k);
		const over = { ...freshTelemetry(), [k]: max * 1.0001 };
		assert.throws(() => validateSession({ ...s, flightTelemetry: over }), /hors bornes/, k);
	}
	// The original bug: 1e308 stored, then merged with itself, gave Infinity —
	// and the session stayed PENDING forever.
	const huge = { durationS: 1e308, distanceM: 1e308, maxSpeedMs: 1e308, maxRateDps: 1e308, maxAltitudeM: 1e308 };
	const merged = mergeTelemetry(huge, huge);
	for (const [k, max] of Object.entries(TELEMETRY_MAX)) assert.equal(merged[k], max, k);
	const closed = closeSession({ ...s, flightTelemetry: merged }, { result: 'CRASHED', telemetry: merged });
	assert.doesNotThrow(() => validateSession(closed));
});

t('closeSession: sets end + result, merges telemetry', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	s.flightTelemetry = { durationS: 40, distanceM: 100, maxSpeedMs: 12, maxRateDps: 200, maxAltitudeM: 8 };
	const done = closeSession(s, {
		result: 'CRASHED',
		telemetry: { durationS: 10, distanceM: 20, maxSpeedMs: 30, maxRateDps: 100, maxAltitudeM: 40 },
	});
	assert.equal(done.result, 'CRASHED');
	assert.ok(done.end);
	assert.equal(done.flightTelemetry.durationS, 50);
	assert.equal(done.flightTelemetry.maxSpeedMs, 30);
	assert.equal(done.flightTelemetry.maxAltitudeM, 40);
	assert.throws(() => closeSession(s, { result: 'PENDING' }), /verdict invalide/);
});

// Landing disappeared (D9, 2026-09-08): a flight now only ever produces
// CRASHED, and a closed session does not reopen. Files written before that
// carry LANDED — they must keep passing validation, accepting an annotation
// and reading back, with no migration and no SESSION_SCHEMA_VERSION bump.
t('SESSION_RESULTS: LANDED is no longer produced, but a stored LANDED stays valid', () => {
	assert.deepEqual(SESSION_RESULTS, ['PENDING', 'CRASHED']);
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(() => closeSession(s, { result: 'LANDED' }), /verdict invalide/);
	const legacy = { ...s, result: 'LANDED', end: new Date().toISOString() };
	assert.doesNotThrow(() => validateSession(legacy));
	assert.equal(annotateSession(legacy, 'old flight').result, 'LANDED');
});

t('validateSession: rejects an invalid id, result, weatherSnapshot, telemetry', () => {
	const good = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(() => validateSession({ ...good, id: 'PAS BON' }), /id de session invalide/);
	assert.throws(() => validateSession({ ...good, result: 'MEH' }), /result inconnu/);
	assert.throws(() => validateSession({ ...good, weatherSnapshot: { zone: 'x' } }), /sans jour/);
	assert.throws(() => validateSession({ ...good, flightTelemetry: { ...good.flightTelemetry, maxSpeedMs: -1 } }), /invalide/);
	assert.throws(() => validateSession({ ...good, result: 'LANDED', end: null }), /sans end/);
});

t('reconcileStaleSessions: an old PENDING -> CRASHED, a terminal one untouched', () => {
	const old = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	old.start = new Date(Date.now() - 45 * 60 * 1000).toISOString();
	const fresh = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	const closed = closeSession(
		openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER }),
		{ result: 'CRASHED', telemetry: freshTelemetry() },
	);
	const { state, changed } = reconcileStaleSessions({ sessions: [old, fresh, closed] });
	assert.equal(changed, true);
	assert.equal(state.sessions[0].result, 'CRASHED');
	assert.ok(state.sessions[0].end);
	assert.equal(state.sessions[1].result, 'PENDING'); // too recent
	assert.ok(state.sessions[2].end);

	const stable = reconcileStaleSessions({ sessions: [fresh, closed] });
	assert.equal(stable.changed, false);
});

const GOOD_TARGET = {
	family: TARGET_FAMILIES[0],
	classHint: '5"',
	hackType: HACK_TYPES[0],
	signal: { rssiDbm: -59, mode: 'ANALOG' },
	scannedAt: new Date().toISOString(),
	intel: { location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL', video: 'KNOWN', control: 'UNKNOWN', flightState: 'UNKNOWN' },
};

t('openSession: carries a validated target, kept at close, null if absent', () => {
	const s = openSession({ seq: 1, targetSeq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null, target: GOOD_TARGET });
	assert.equal(s.target.family, GOOD_TARGET.family);
	assert.equal(s.target.hackType, HACK_TYPES[0]);
	assert.equal(validateSession(s), s);
	const closed = closeSession(s, { result: 'CRASHED', telemetry: freshTelemetry() });
	assert.equal(closed.target.family, GOOD_TARGET.family);

	const noTarget = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null });
	assert.equal(noTarget.target, null);
});

t('sanitizeTarget: rejects an unknown family and a positive rssi; validateSession re-checks', () => {
	assert.throws(() => openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { family: 'not-a-family', signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} },
	}), /famille de cible inconnue/);
	const bad = {
		...openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null }),
		target: { family: TARGET_FAMILIES[0], signal: { rssiDbm: 5, mode: 'ANALOG' }, intel: {} },
	};
	assert.throws(() => validateSession(bad), /rssiDbm invalide/);
});

t('sanitizeTarget: hackType — a valid one is kept, an unknown one rejected, an absent one tolerated', () => {
	const base = { family: TARGET_FAMILIES[0], signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} };

	const withHack = openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'GNSS SPOOF' },
	});
	assert.equal(withHack.target.hackType, 'GNSS SPOOF');

	const noHack = openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base },
	});
	assert.equal(noHack.target.hackType, null);

	assert.throws(() => openSession({ seq: 1, targetSeq: 1,
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: { ...base, hackType: 'NOPE' },
	}), /hackType de cible inconnu/);
});

t('sanitizeTarget: keeps scan {seed,count,index} and rejects a wrong shape', () => {
	const scan = generateTargetScan({ seed: 'keep-me', count: 3, swarmChance: 0 });
	const kept = sanitizeTarget(resolveTarget(scan, 1));
	assert.deepEqual(kept.scan, { seed: 'keep-me', count: 3, index: 1, swarmAt: null, swarmChance: 0 });
	// A v1 session: no scan -> null, no error.
	const v1 = { ...resolveTarget(scan, 1) };
	delete v1.scan;
	assert.equal(sanitizeTarget(v1).scan, null);
	// Wrong shapes.
	for (const bad of [
		{ seed: '', count: 3, index: 1 },
		{ seed: 'x', count: 1, index: 0 },
		{ seed: 'x', count: 6, index: 0 },
		{ seed: 'x', count: 3, index: 3 },
		{ seed: 'x', count: 3, index: -1 },
		{ seed: 'x', count: 3.5, index: 0 },
	]) {
		assert.throws(() => sanitizeTarget({ ...resolveTarget(scan, 1), scan: bad }), /target\.scan/);
	}
});

t('session schema: version 3', () => {
	assert.equal(SESSION_SCHEMA_VERSION, 3);
});

// --- the swarm (issue #29)

t('sanitizeTarget: keeps swarm and scan.swarmAt/swarmChance in v3', () => {
	const scan = generateTargetScan({ seed: 'swarm-keep', count: 4, swarmChance: 1 });
	const kept = sanitizeTarget(resolveTarget(scan, 0));
	assert.equal(kept.family, SWARM_FAMILY, 'swarmNode is allowed outside TARGET_FAMILIES');
	assert.equal(kept.swarm.size, scan.candidates[0]._swarm.size);
	assert.equal(kept.swarm.doctrineSeed, scan.candidates[0]._swarm.doctrineSeed);
	assert.deepEqual(kept.scan, { seed: 'swarm-keep', count: 4, index: 0, swarmAt: 0, swarmChance: 1 });
	// And the scan replays identically from what was kept.
	const replay = generateTargetScan({
		seed: kept.scan.seed, count: kept.scan.count,
		swarmChance: kept.scan.swarmChance, swarmAt: kept.scan.swarmAt,
	});
	assert.deepEqual(replay.candidates, scan.candidates);
	// Round trip: what sanitizeTarget renders reads back with no loss.
	assert.deepEqual(sanitizeTarget(kept), kept);
});

t('sanitizeTarget: swarmNode stays outside the ordinary draw', () => {
	assert.equal(TARGET_FAMILIES.includes(SWARM_FAMILY), false);
});

t('sanitizeTarget: wrong shapes of swarm and of the v3 keys', () => {
	const scan = generateTargetScan({ seed: 'swarm-bad', count: 4, swarmChance: 1 });
	const good = resolveTarget(scan, 0);
	for (const bad of [
		{ size: SWARM_SIZE_MIN - 1, doctrineSeed: 'd' },
		{ size: SWARM_SIZE_MAX + 1, doctrineSeed: 'd' },
		{ size: 7.5, doctrineSeed: 'd' },
		{ size: '8', doctrineSeed: 'd' },
		{ size: 8, doctrineSeed: '' },
		{ size: 8 },
	]) {
		assert.throws(() => sanitizeTarget({ ...good, swarm: bad }), /target\.swarm/);
	}
	for (const bad of [4, -1, 1.5, '0']) {
		assert.throws(() => sanitizeTarget({ ...good, scan: { ...good.scan, swarmAt: bad } }),
			/target\.scan\.swarmAt/);
	}
	for (const bad of [-0.1, 1.1, 'x']) {
		assert.throws(() => sanitizeTarget({ ...good, scan: { ...good.scan, swarmChance: bad } }),
			/target\.scan\.swarmChance/);
	}
});

t('a resumed v2 session carries no swarm and reads back with no error', () => {
	// What a file written before the swarm existed contains: neither `swarm`,
	// nor the scan's two keys. No migration — like a v1 session with no ambients.
	const scan = generateTargetScan({ seed: 'v2-target', count: 3, swarmChance: 0 });
	const v2 = resolveTarget(scan, 1);
	delete v2.swarm;
	delete v2.scan.swarmAt;
	delete v2.scan.swarmChance;
	const kept = sanitizeTarget(v2);
	assert.equal(kept.swarm, null);
	assert.equal(kept.scan.swarmAt, null);
	assert.equal(kept.scan.swarmChance, 0, 'a v2 scan replays with no swarm');
	const s = validateSession(openSession({
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: v2, seq: 1, targetSeq: 1,
	}));
	assert.equal(s.target.swarm, null);
});

t('validateSession: rejects a malformed swarm on an otherwise valid session', () => {
	const scan = generateTargetScan({ seed: 'v3-validate', count: 4, swarmChance: 1 });
	const s = openSession({
		operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null,
		target: resolveTarget(scan, 0), seq: 1, targetSeq: 1,
	});
	assert.equal(validateSession(s).target.swarm.size >= SWARM_SIZE_MIN, true);
	assert.throws(() => validateSession({ ...s, target: { ...s.target, swarm: { size: 99, doctrineSeed: 'd' } } }),
		/target\.swarm\.size/);
	assert.throws(() => validateSession({ ...s, target: { ...s.target, family: 'nope' } }),
		/famille de cible inconnue/);
});

t('sanitizeComment: empty/blank -> null, trims spaces, caps the length', () => {
	assert.equal(sanitizeComment(null), null);
	assert.equal(sanitizeComment(''), null);
	assert.equal(sanitizeComment('   '), null);
	assert.equal(sanitizeComment('  ras, cible calme  '), 'ras, cible calme');
	assert.throws(() => sanitizeComment('x'.repeat(401)), /COMMENT TOO LONG/);
	assert.throws(() => sanitizeComment(42), /comment invalide/);
});

t('annotateSession: can annotate an already-closed session (no PENDING restriction)', () => {
	const opened = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'kyiv-podil', weatherSnapshot: null });
	const closed = closeSession(opened, { result: 'CRASHED', telemetry: freshTelemetry() });
	const noted = annotateSession(closed, 'lost against a facade');
	assert.equal(noted.comment, 'lost against a facade');
	assert.equal(noted.result, 'CRASHED'); // untouched
	assert.doesNotThrow(() => validateSession(noted));
});

const GOOD_PHOTO = { dataUrl: 'data:image/jpeg;base64,/9j/AAA=', w: 480, h: 360 };

t('sanitizePhoto: known shape kept, ts set by the server (ignores the client\'s)', () => {
	const p = sanitizePhoto({ ...GOOD_PHOTO, ts: '2000-01-01T00:00:00.000Z', extra: 'x' });
	assert.equal(p.dataUrl, GOOD_PHOTO.dataUrl);
	assert.equal(p.w, 480);
	assert.equal(p.h, 360);
	assert.notEqual(p.ts, '2000-01-01T00:00:00.000Z');
	assert.ok(new Date(p.ts).toISOString() === p.ts);
});

t('sanitizePhoto: rejects a missing/non-image dataUrl, a non-integer or <= 0 w/h', () => {
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, dataUrl: undefined }), /dataUrl invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, dataUrl: 'not-a-data-url' }), /dataUrl invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, w: 0 }), /w invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, w: 4.5 }), /w invalide/);
	assert.throws(() => sanitizePhoto({ ...GOOD_PHOTO, h: -1 }), /h invalide/);
});

t('addPhoto: appends to the existing array without mutating it, several captures per session', () => {
	const s = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	const s1 = addPhoto(s, GOOD_PHOTO);
	assert.deepEqual(s.photos, []); // no mutation of the original
	assert.equal(s1.photos.length, 1);
	const s2 = addPhoto(s1, { ...GOOD_PHOTO, w: 640, h: 480 });
	assert.equal(s2.photos.length, 2);
	assert.equal(s2.photos[0].w, 480);
	assert.equal(s2.photos[1].w, 640);
	assert.doesNotThrow(() => validateSession(s2));
});

t('validateSession: rejects a session whose photos[] has a malformed element', () => {
	const good = openSession({ seq: 1, operatorId: 'neo-3f9c', area: 'paris', weatherSnapshot: WEATHER });
	assert.throws(
		() => validateSession({ ...good, photos: [{ w: 480, h: 360 }] }),
		/photo/,
	);
	assert.throws(
		() => validateSession({ ...good, photos: 'nope' }),
		/photos/,
	);
});

// --- PHASE 17: display numbers, capture elision, deletion ------

t('openSession: sets seq and targetSeq exactly as the server assigns them', () => {
	const s = openSession({
		operatorId: 'neo-3f9c', area: 'tokyo', weatherSnapshot: null,
		target: null, seq: 421, targetSeq: null,
	});
	assert.equal(s.seq, 421);
	assert.equal(s.targetSeq, null);
	validateSession(s);
});

t('validateSession: requires an integer seq >= 1', () => {
	const good = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	assert.throws(() => validateSession({ ...good, seq: 0 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: 1.5 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: undefined }), /seq/);
});

t('validateSession: targetSeq is mandatory with a target, absent without one', () => {
	const scan = generateTargetScan({ seed: 'seq-seed', count: 3 });
	const target = resolveTarget(scan, 1);
	const withT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, target, seq: 2, targetSeq: 7 });
	assert.equal(withT.targetSeq, 7);
	validateSession(withT);
	assert.throws(() => validateSession({ ...withT, targetSeq: null }), /targetSeq/);
	const noT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 3 });
	assert.throws(() => validateSession({ ...noT, targetSeq: 4 }), /targetSeq/);
});

t('stripPhotoData: removes dataUrl, keeps w/h/ts, does not mutate the original', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/jpeg;base64,AAA=', w: 480, h: 360 },
	);
	const light = stripPhotoData(s);
	assert.equal(light.photos[0].dataUrl, undefined);
	assert.equal(light.photos[0].w, 480);
	assert.equal(light.photos[0].h, 360);
	assert.equal(typeof light.photos[0].ts, 'string');
	assert.equal(s.photos[0].dataUrl, 'data:image/jpeg;base64,AAA=');
	// An elided session is a WIRE FORMAT, not persistable state: it never goes
	// back through validateSession, which rightly requires a dataUrl on every
	// capture. Elision only happens in the `json(res, ...)` calls, AFTER
	// `_writeOperator` — never before a disk write. The failure is therefore
	// asserted, so this direction stays written down somewhere.
	assert.throws(() => validateSession(light), /dataUrl/);
});

t('stripOperatorPhotoData: elides every session of a state', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/png;base64,BBB=', w: 8, h: 8 },
	);
	const light = stripOperatorPhotoData({ id: 'op', sessions: [s] });
	assert.equal(light.sessions[0].photos[0].dataUrl, undefined);
	assert.equal(s.photos[0].dataUrl, 'data:image/png;base64,BBB=');
});

t('deleteSession: removes the entry, touches nothing else', () => {
	const a = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const b = openSession({ operatorId: 'op', area: 'lviv', weatherSnapshot: null, seq: 2 });
	const state = {
		id: 'op', sessionSeq: 2, targetSeq: 0,
		sessions: [closeSession(a, { result: 'CRASHED' }), closeSession(b, { result: 'CRASHED' })],
	};
	const out = deleteSession(state, state.sessions[0].id);
	assert.equal(out.sessions.length, 1);
	assert.equal(out.sessions[0].area, 'lviv');
	// Counters never move back: a number is never recycled (spec D2).
	assert.equal(out.sessionSeq, 2);
	assert.equal(state.sessions.length, 2); // no mutation
});

t('deleteSession: 404 on unknown, 409 on a session still PENDING', () => {
	const p = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const state = { id: 'op', sessions: [p] };
	assert.throws(() => deleteSession(state, 'nexiste-pas-0000'), (e) => e.status === 404);
	assert.throws(() => deleteSession(state, p.id), (e) => e.status === 409);
});

// --- migration v1 -> v2 -> v3 -----------------------------------------------

t('SCHEMA_VERSION is 3', () => {
	// v3: the CONTROL VECTOR is removed from the game and its key leaves at migration (#33).
	assert.equal(SCHEMA_VERSION, 3);
});

t('freshState: two counters at zero, no more targetLog key', () => {
	const s = freshState({ id: 'neo-0000', name: 'neo' });
	assert.equal(s.sessionSeq, 0);
	assert.equal(s.targetSeq, 0);
	assert.equal('targetLog' in s, false);
});

t('migrate v1 -> v3: backfills the numbers in order, targetLog removed', () => {
	const scan = generateTargetScan({ seed: 'mig-seed', count: 3 });
	const withTarget = resolveTarget(scan, 0);
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		settings: {}, terrainCache: [], worldState: {},
		targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null },
			{ id: 'b-0002', area: 'b', result: 'CRASHED', target: withTarget },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: withTarget },
		],
	};
	const m = migrate(v1);
	assert.equal(m.schemaVersion, 3);
	assert.equal('targetLog' in m, false);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 2, 3]);
	// Only sessions with a target consume a target number.
	assert.equal(m.sessions[0].targetSeq, undefined);
	assert.equal(m.sessions[1].targetSeq, 1);
	assert.equal(m.sessions[2].targetSeq, 2);
	assert.equal(m.sessionSeq, 3);
	assert.equal(m.targetSeq, 2);
});

t('migrate: idempotent — running a v2 state through again renumbers nothing', () => {
	const scan = generateTargetScan({ seed: 'mig-seed-2', count: 3 });
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		settings: {}, terrainCache: [], worldState: {}, targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: resolveTarget(scan, 0) },
			{ id: 'b-0002', area: 'b', result: 'LANDED', target: null },
		],
	};
	const once = migrate(v1);
	const twice = migrate(once);
	assert.deepEqual(twice.sessions.map((s) => s.seq), once.sessions.map((s) => s.seq));
	assert.deepEqual(twice.sessions.map((s) => s.targetSeq), once.sessions.map((s) => s.targetSeq));
	assert.equal(twice.sessionSeq, once.sessionSeq);
	assert.equal(twice.targetSeq, once.targetSeq);
});

t('migrate: a numbering gap survives a reread', () => {
	// What a v2 file becomes after DELETing session 2: the remaining numbers do
	// not move, and the counters never move back.
	const v2 = {
		schemaVersion: 2, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		settings: {}, terrainCache: [], worldState: {},
		sessionSeq: 3, targetSeq: 0,
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null, seq: 1 },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: null, seq: 3 },
		],
	};
	const m = migrate(v2);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 3]);
	assert.equal(m.sessionSeq, 3);
});

// ---------------------------------------------------------------------------
// src/session.js — client-side aggregator, fetch stubbed

// `trackFails`: the track (issue #24) is the only write whose failure must be
// swallowed — the tests use it to check the session survives.
function stubOperator(calls, { trackFails = false } = {}) {
	op._setStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
	op._setFetch(async (url, init = {}) => {
		const method = init.method ?? 'GET';
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		if (method === 'POST' && /\/__operator$/.test(url)) {
			return json({ operator: { id: 'neo-0000', name: 'neo', createdAt: 'x', sessions: [], terrainCache: [], targetLog: [], settings: {}, worldState: {} } });
		}
		if (method === 'POST' && /\/sessions$/.test(url)) {
			return json({ session: { id: 'paris-0000', result: 'PENDING' } });
		}
		// The track (issue #24): a dedicated PUT, never an operator key.
		if (/\/sessions\/[^/]+\/track$/.test(url)) {
			if (trackFails) return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) };
			return json({ sessionId: 'paris-0000', n: body.n, truncated: body.truncated });
		}
		if (/\/sessions\/[^/]+\/photos$/.test(url)) {
			calls._photos = (calls._photos ?? 0) + 1;
			return json({ session: { id: 'paris-0000', result: 'PENDING', photos: Array(calls._photos).fill({}) } });
		}
		if (/\/sessions\/[^/]+$/.test(url)) {
			return json({ session: { id: 'paris-0000', result: body.result, flightTelemetry: body.telemetry } });
		}
		// Coverage (issue #245): a PATCH of the operator key at close.
		if (method === 'PATCH' && /\/__operator\/[^/]+$/.test(url)) {
			calls._operator = { ...(calls._operator ?? {}), [body.key]: body.value };
			return json({ operator: { id: 'neo-0000', ...calls._operator } });
		}
		throw new Error(`unstubbed fetch: ${method} ${url}`);
	});
}
const json = (obj) => ({ ok: true, status: 200, json: async () => obj });

await ta('feed only accumulates duration/distance if armed; open+end = 1 POST + 1 PATCH', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();

	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	// disarmed: nothing counts, not even the peaks (the sphere bouncing on the ground)
	session.feed({ speed: 999, horizontalSpeed: 999, rateDps: 9999, altitudeAboveSpawn: 999, dt: 1, armed: false });
	// armed: everything counts
	session.feed({ speed: 20, horizontalSpeed: 15, rateDps: 300, altitudeAboveSpawn: 40, dt: 2, armed: true });
	session.feed({ speed: 12, horizontalSpeed: 10, rateDps: 250, altitudeAboveSpawn: 18, dt: 1, armed: true });

	await session.end('CRASHED');

	const posts = calls.filter((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	const patches = calls.filter((c) => c.method === 'PATCH' && /\/sessions\//.test(c.url));
	assert.equal(posts.length, 1);
	assert.equal(patches.length, 1);
	const tel = patches[0].body.telemetry;
	assert.equal(patches[0].body.result, 'CRASHED');
	assert.equal(tel.durationS, 3);           // 2 + 1, not the disarmed step
	assert.equal(tel.distanceM, 40);          // 15*2 + 10*1
	assert.equal(tel.maxSpeedMs, 20);
	assert.equal(tel.maxRateDps, 300);
	assert.equal(tel.maxAltitudeM, 40);

	// end is idempotent: a second verdict does not go back over the network
	await session.end('CRASHED');
	assert.equal(calls.filter((c) => /\/sessions\//.test(c.url)).length, 1);
});

// ---------------------------------------------------------------------------
// Coverage (issue #245): accumulated at 5 Hz in memory, written ONCE.

const EIFFEL = { lat: 48.8584, lon: 2.2945 };

await ta('coverage: nothing is written during the flight, one single write at close', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });

	// One second of armed flight at 60 Hz, fixed position: 5 samples expected.
	let geoCalls = 0;
	const geo = () => { geoCalls++; return EIFFEL; };
	for (let i = 0; i < 60; i++) {
		session.feed({ speed: 1, horizontalSpeed: 1, rateDps: 0, altitudeAboveSpawn: 5, dt: 1 / 60, armed: true, geo });
	}
	assert.equal(geoCalls, 5, 'geo() is only called at samples, not every frame');
	assert.ok(session.coverage().size >= 4, 'the session\'s coverage has cells');
	assert.equal(calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url)).length, 0,
		'no operator write during the flight');

	await session.end('CRASHED');
	await op.flush();
	const patches = calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	assert.equal(patches.length, 1, 'a single write, at close');
	assert.equal(patches[0].body.key, 'coverage');
	const stored = patches[0].body.value;
	assert.equal(stored.v, 1);
	assert.equal(stored.z, 20);
	assert.ok(stored.cells.length >= 4);
	// The weight: 5 samples at the same spot -> 5 on that point's cell.
	const centre = stored.cells.find(([x, y]) => x === 530971 && y === 360731);
	assert.ok(centre, 'the Eiffel Tower\'s cell is written');
	assert.equal(centre[2], 5);
});

await ta('coverage: disarmed or frozen, no sampling; a non-finite geo is ignored', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 60; i++) {
		session.feed({ dt: 1 / 60, armed: false, geo: () => EIFFEL });   // parked
		session.feed({ dt: 0, armed: true, geo: () => EIFFEL });          // frozen
	}
	assert.equal(session.coverage().size, 0);
	for (let i = 0; i < 60; i++) {
		session.feed({ dt: 1 / 60, armed: true, geo: () => ({ lat: NaN, lon: 2 }) });
	}
	assert.equal(session.coverage().size, 0, 'a degenerate position marks nothing');
	await session.end('CRASHED');
	await op.flush();
	assert.equal(calls.filter((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url)).length, 0,
		'a session that marked nothing does not write the key');
});

await ta('coverage: close MERGES with what the operator already had, then bounds it', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	// The operator arrives with prior coverage: the Eiffel Tower at w=3.
	op.getOperator().coverage = { v: 1, z: 20, cells: [[530971, 360731, 3]] };
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) {
		session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });   // 12 frames = 1 sample
	}
	await session.end('CRASHED');
	await op.flush();
	const patch = calls.find((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	const centre = patch.body.value.cells.find(([x, y]) => x === 530971 && y === 360731);
	assert.equal(centre[2], 4, '3 (before) + 1 (this session)');
	// And the key is also up to date in the client cache, with no need to wait for the network.
	assert.equal(op.getOperator().coverage.cells.find(([x, y]) => x === 530971 && y === 360731)[2], 4);
});

await ta('coverage: a corrupt operator coverage does not block the close', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	op.getOperator().coverage = 'whatever';
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });
	const s = await session.end('CRASHED');
	assert.ok(s, 'the session closes');
	await op.flush();
	const patch = calls.find((c) => c.method === 'PATCH' && /\/__operator\/[^/]+$/.test(c.url));
	assert.ok(patch, 'and coverage restarts from the session alone');
	assert.equal(patch.body.value.cells.find(([x, y]) => x === 530971 && y === 360731)[2], 1);
});

await ta('open({ area, target }) sends targetSeed/targetCount/targetIndex', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'kyiv', target: { seed: 's', count: 4, index: 1 } });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.equal(post.body.area, 'kyiv');
	assert.equal(post.body.targetSeed, 's');
	assert.equal(post.body.targetCount, 4);
	assert.equal(post.body.targetIndex, 1);
	// #29: the swarm chance travels with the target — only the client can
	// compute it, and without it the server does not regenerate the same scan.
	assert.equal(post.body.swarmChance, undefined, 'absent when the caller gives none');
});

await ta('open({ target: { swarmChance } }) sends swarmChance to the server', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'kyiv', target: { seed: 's', count: 4, index: 0, swarmChance: 1 } });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.equal(post.body.swarmChance, 1);
});

await ta('open({ target: { clearance } }) sends clearance to the server (issue #185)', async () => {
	// The server is the authority on the draw pool and the swarm gate: it
	// recomputes both from `clearance` rather than trusting a client-supplied
	// family list.
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'kyiv', target: { seed: 's', count: 4, index: 0, clearance: 2 } });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.equal(post.body.clearance, 2);
});

await ta('open({ target }) with no clearance sends undefined (older/dev callers)', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'kyiv', target: { seed: 's', count: 4, index: 0 } });
	const post = calls.find((c) => c.method === 'POST' && /\/sessions$/.test(c.url));
	assert.equal(post.body.clearance, undefined);
});

await ta('capturePhoto: POST .../sessions/:sid/photos, increments the local counter', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	assert.equal(session.photoCount(), 0);

	const n1 = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AAA=', w: 480, h: 360 });
	assert.equal(n1, 1);
	assert.equal(session.photoCount(), 1);
	const post = calls.find((c) => c.method === 'POST' && /\/photos$/.test(c.url));
	assert.ok(post);
	assert.equal(post.body.dataUrl, 'data:image/jpeg;base64,AAA=');
	assert.equal(post.body.w, 480);

	const n2 = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,BBB=', w: 480, h: 360 });
	assert.equal(n2, 2);
});

await ta('capturePhoto: with no open session, does nothing and renders 0', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	const n = await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AAA=', w: 1, h: 1 });
	assert.equal(n, 0);
	assert.equal(calls.filter((c) => /\/photos$/.test(c.url)).length, 0);
});

console.log(`\n${n} tests session OK`);

// ---------------------------------------------------------------------------
// The flight track (issue #24): accumulated at 5 Hz alongside coverage,
// written ONCE, after the session's PATCH.

const trackPuts = (calls) => calls.filter((c) => c.method === 'PUT' && /\/track$/.test(c.url));

await ta('track: nothing during the flight, one single PUT at close, AFTER the PATCH', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });

	// Two seconds armed at 60 Hz: 10 samples expected, same as coverage.
	for (let i = 0; i < 120; i++) {
		session.feed({
			speed: 14, horizontalSpeed: 13, rateDps: 210, altitudeAboveSpawn: 32,
			dt: 1 / 60, armed: true, geo: () => EIFFEL, throttle: 0.62, headingDeg: 271,
		});
	}
	assert.equal(session.track().samples.length, 10);
	assert.equal(trackPuts(calls).length, 0, 'no track write during the flight');

	await session.end('CRASHED');
	const puts = trackPuts(calls);
	assert.equal(puts.length, 1, 'a single write');
	// Order matters: the track needs an existing session server-side.
	const patchAt = calls.findIndex((c) => c.method === 'PATCH' && /\/sessions\//.test(c.url));
	assert.ok(patchAt >= 0 && calls.indexOf(puts[0]) > patchAt, 'the track leaves after the PATCH');

	const back = decodeTrack(puts[0].body);
	assert.equal(back.samples.length, 10);
	assert.ok(Math.abs(back.samples[0].lat - EIFFEL.lat) < 1e-5);
	assert.ok(Math.abs(back.samples[0].thr - 0.62) < 0.005, 'the throttle is recorded');
	assert.ok(Math.abs(back.samples[0].rate - 210) < 0.5);
	assert.ok(Math.abs(back.samples[0].alt - 32) < 0.05);
	assert.ok(Math.abs(back.samples[9].t - 2) < 0.05, 'time runs across the 5 Hz boundary');
	assert.ok(Math.abs(back.start.lat - EIFFEL.lat) < 1e-5, 'the JACK IN point');
	assert.equal(back.end.result, 'CRASHED');
	assert.ok(Math.abs(back.end.spd - 14) < 0.05, 'the state at the moment the link dies');
	assert.equal(back.truncated, false);
});

await ta('track: disarmed or frozen, no sampling; with no sample, no PUT', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 120; i++) {
		session.feed({ dt: 1 / 60, armed: false, geo: () => EIFFEL, throttle: 1 });
		session.feed({ dt: 0, armed: true, geo: () => EIFFEL, throttle: 1 });
	}
	assert.equal(session.track().samples.length, 0);
	await session.end('CRASHED');
	assert.equal(trackPuts(calls).length, 0, 'a flight that recorded nothing writes no file');
});

await ta('track: captures are geotagged when taken, indexed on photos[]', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	// A capture BEFORE the first sample: it exists, but with no position.
	await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AA==', w: 4, h: 3 });
	for (let i = 0; i < 12; i++) {
		session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL, throttle: 0.5, headingDeg: 91.4 });
	}
	await session.capturePhoto({ dataUrl: 'data:image/jpeg;base64,AA==', w: 4, h: 3 });
	assert.equal(session.photoCount(), 2);
	await session.end('CRASHED');

	const back = decodeTrack(trackPuts(calls)[0].body);
	assert.equal(back.photos.length, 1, 'only the capture taken after a sample has a position');
	assert.equal(back.photos[0].i, 1, 'the index points into photos[]');
	assert.ok(Math.abs(back.photos[0].lat - EIFFEL.lat) < 1e-5);
	assert.equal(back.photos[0].heading, 91);
});

await ta('track: a write failure is swallowed, the session stays closed', async () => {
	const calls = [];
	stubOperator(calls, { trackFails: true });
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });
	const s = await session.end('CRASHED');
	assert.ok(s, 'losing the track does not cost the session');
	assert.equal(s.result, 'CRASHED');
	assert.equal(trackPuts(calls).length, 1, 'tried once, not replayed');
});

await ta('track: the fallback beacon carries no track (D4)', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	for (let i = 0; i < 12; i++) session.feed({ dt: 1 / 60, armed: true, geo: () => EIFFEL });
	const beacons = [];
	// `navigator` is only a getter under Node: it is redefined here, and put back.
	const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
	});
	const hadBlob = globalThis.Blob;
	globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
	try {
		session.beacon('CRASHED');
		assert.equal(beacons.length, 1);
		assert.ok(!/track/.test(beacons[0].url));
		assert.ok(!/"lat"/.test(beacons[0].blob.parts[0]), 'the beacon only carries the aggregates');
		assert.equal(trackPuts(calls).length, 0);
	} finally {
		if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav);
		else delete globalThis.navigator;
		globalThis.Blob = hadBlob;
	}
});

await ta('track: the MAX_SAMPLES cap bounds the tab\'s memory and reports itself', async () => {
	const calls = [];
	stubOperator(calls);
	await op.createOperator('neo');
	session._reset();
	await session.open({ area: 'paris', weatherSnapshot: WEATHER });
	// A 0.2 s step per call: one sample per call, without spinning at 60 Hz.
	for (let i = 0; i < MAX_SAMPLES + 20; i++) {
		session.feed({ dt: 0.2, armed: true, geo: () => EIFFEL, throttle: 0.5 });
	}
	assert.equal(session.track().samples.length, MAX_SAMPLES);
	await session.end('CRASHED');
	assert.equal(trackPuts(calls)[0].body.truncated, true);
});
