// Selftest of the DATA tab model (issue #26, spec
// docs/superpowers/specs/2026-09-08-flight-track-enriched-map-data-design.md).
// No I/O, no DOM, no scene data: runs in CI.
//
// What it fixes: the screen computes NOTHING. Every series the nine sections
// draw is produced here, so a section that reads wrong is a failing assertion
// rather than a canvas someone has to squint at.
//
// Run: node tools/data-model-selftest.mjs

import assert from 'node:assert/strict';
import {
	rhythmSeries, lifeSeries, speedAltitudeSeries, lossSeries, stickSeries,
	familySeries, geographySeries, profileSeries, trackSamples, trackIndexOf,
	defaultFlightId, dataModel, RHYTHM_WEEKS,
} from './data-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const DAY = 86400e3;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');   // a Tuesday

// A closed session, in the shape server/api.mjs stores.
const session = (over = {}) => ({
	id: 'paristest-0001', operatorId: 'op', area: 'paristest', seq: 1, targetSeq: 1,
	target: { family: 'heavy5' },
	start: new Date(NOW - DAY).toISOString(),
	end: new Date(NOW - DAY + 300e3).toISOString(),
	result: 'CRASHED',
	flightTelemetry: { durationS: 300, distanceM: 1200, maxSpeedMs: 24, maxRateDps: 480, maxAltitudeM: 62 },
	photos: [],
	...over,
});

// One entry of the track index (#24): start point, decimated polyline, end
// event, photo points. Never the full sample arrays.
const indexEntry = (over = {}) => ({
	sessionId: 'paristest-0001',
	start: { lat: 48.85, lon: 2.29 },
	points: [[48.85, 2.29], [48.851, 2.291]],
	end: { lat: 48.852, lon: 2.292, alt: 31, spd: 18, result: 'CRASHED' },
	photos: [{ i: 0, lat: 48.851, lon: 2.29, heading: 90 }],
	...over,
});

// ---------------------------------------------------------------- tolerance
//
// The model reads a track through one accessor, because #24 owns the encoding
// and this tab must not care whether a decoded track came back as objects or
// as parallel arrays.

t('trackSamples: parallel arrays, array of objects and nothing all read alike', () => {
	const arrays = { samples: { t: [0, 0.2], alt: [1, 2], spd: [3, 4], thr: [0.5, 0.6], rate: [10, 20] } };
	const objects = { samples: [{ t: 0, alt: 1, spd: 3, thr: 0.5, rate: 10 }, { t: 0.2, alt: 2, spd: 4, thr: 0.6, rate: 20 }] };
	for (const track of [arrays, objects]) {
		const s = trackSamples(track);
		assert.equal(s.length, 2);
		assert.deepEqual(s[1], { t: 0.2, lat: null, lon: null, alt: 2, spd: 4, thr: 0.6, rate: 20 });
	}
	// An index entry carries no samples: that is NO TRACK detail, not an error.
	assert.deepEqual(trackSamples(indexEntry()), []);
	assert.deepEqual(trackSamples(null), []);
	assert.deepEqual(trackSamples({ samples: 'nope' }), []);
});

t('trackIndexOf: a lookup by session, and it never throws on junk', () => {
	const m = trackIndexOf([indexEntry(), { sessionId: 'x' }, null, 'nope']);
	assert.equal(m.get('paristest-0001').end.spd, 18);
	assert.ok(m.has('x'));
	assert.equal(m.size, 2);
	assert.equal(trackIndexOf(null).size, 0);
});

// ------------------------------------------------------------------- RHYTHM

t('rhythm: twelve weeks ending on the current one, oldest first', () => {
	const r = rhythmSeries([], { now: NOW });
	assert.equal(r.bars.length, RHYTHM_WEEKS);
	assert.equal(RHYTHM_WEEKS, 12);
	assert.deepEqual(r.bars.map((b) => b.value), new Array(12).fill(0));
	assert.equal(r.total, 0);
	// The last bar is the week the operator is in.
	assert.equal(r.bars[11].current, true);
	assert.equal(r.bars[0].current, false);
});

t('rhythm: sessions land in their week, and older ones are dropped', () => {
	const s = [
		session({ id: 'a', start: new Date(NOW - DAY).toISOString() }),
		session({ id: 'b', start: new Date(NOW - 2 * DAY).toISOString() }),
		session({ id: 'c', start: new Date(NOW - 21 * DAY).toISOString() }),
		session({ id: 'old', start: new Date(NOW - 400 * DAY).toISOString() }),
		session({ id: 'broken', start: 'not a date' }),
	];
	const r = rhythmSeries(s, { now: NOW });
	// NOW is a Tuesday: yesterday is in this week, two days ago is a Sunday and
	// belongs to the week before — weeks start on Monday.
	assert.equal(r.bars[11].value, 1, 'this week holds a');
	assert.equal(r.bars[10].value, 1, 'b fell on the Sunday of the week before');
	assert.equal(r.bars[8].value, 1, 'three weeks back holds c');
	assert.equal(r.total, 3, 'and nothing outside the window is counted');
	// Weeks start on Monday: NOW is a Tuesday, so the bar covers 07.09.
	assert.equal(r.bars[11].label, '07.09');
});

// --------------------------------------------------------------------- LIFE

t('life: one bar per session, chronological, duration in seconds', () => {
	const l = lifeSeries([
		session({ id: 'b', seq: 2, start: new Date(NOW - DAY).toISOString(), flightTelemetry: { durationS: 120 } }),
		session({ id: 'a', seq: 1, start: new Date(NOW - 2 * DAY).toISOString(), flightTelemetry: { durationS: 300 } }),
	]);
	assert.deepEqual(l.bars.map((b) => b.id), ['a', 'b'], 'chronological, not stored order');
	assert.deepEqual(l.bars.map((b) => b.value), [300, 120]);
	assert.deepEqual(l.bars.map((b) => b.label), ['00001', '00002']);
	assert.equal(l.maxS, 300);
	assert.equal(l.meanS, 210);
});

t('life: no session is an empty series, not a crash', () => {
	const l = lifeSeries(null);
	assert.deepEqual(l.bars, []);
	assert.equal(l.maxS, 0);
	assert.equal(l.meanS, 0);
});

// --------------------------------------------------------- SPEED × ALTITUDE

t('speed × altitude: one point per flight, from the aggregates every flight has', () => {
	const p = speedAltitudeSeries([
		session({ id: 'a', flightTelemetry: { maxSpeedMs: 24, maxAltitudeM: 62, durationS: 300 } }),
		session({ id: 'b', flightTelemetry: { maxSpeedMs: 8, maxAltitudeM: 15, durationS: 60 } }),
		// A flight that never moved carries no shape: it is not a point.
		session({ id: 'z', flightTelemetry: { maxSpeedMs: 0, maxAltitudeM: 0, durationS: 4 } }),
	]);
	assert.deepEqual(p.points.map((q) => [q.id, q.x, q.y]), [['a', 24, 62], ['b', 8, 15]]);
	assert.equal(p.maxX, 24);
	assert.equal(p.maxY, 62);
});

// ------------------------------------------------------------ HOW THEY DIED

t('losses: the end event of every track, and a count of the flights without one', () => {
	const sessions = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })];
	const tracks = [
		indexEntry({ sessionId: 'a' }),
		indexEntry({ sessionId: 'b', end: { lat: 1, lon: 2, alt: 0, spd: 2, result: 'CRASHED' } }),
		indexEntry({ sessionId: 'c', end: null }),
	];
	const l = lossSeries(sessions, tracks);
	assert.deepEqual(l.points.map((p) => [p.id, p.x, p.y]), [['a', 18, 31], ['b', 2, 0]]);
	assert.equal(l.missing, 1, 'c flew without an end event');
	assert.equal(l.maxX, 18);
	assert.equal(l.maxY, 31);
});

t('losses: no track at all is an empty series that says so', () => {
	const l = lossSeries([session()], []);
	assert.deepEqual(l.points, []);
	assert.equal(l.missing, 1);
});

// ------------------------------------------------------------------- STICKS

t('sticks: two histograms over the samples of one flight', () => {
	const track = { samples: { thr: [0, 0.5, 0.5, 1], rate: [0, 100, 200, 400] } };
	const s = stickSeries(track, { bins: 4 });
	assert.equal(s.samples, 4);
	assert.equal(s.throttle.bins.length, 4);
	// 0 → first bin, 0.5 → third, 1 → last (the top edge belongs to the last bin).
	assert.deepEqual(s.throttle.bins.map((b) => b.n), [1, 0, 2, 1]);
	assert.equal(s.throttle.max, 1, 'throttle is a stick: its scale is fixed 0..1');
	assert.deepEqual(s.rate.bins.map((b) => b.n), [1, 1, 1, 1]);
	assert.equal(s.rate.max, 400, 'rotation rate has no fixed ceiling: it scales to what was flown');
});

t('sticks: a track without stick data is null, never an empty graph', () => {
	assert.equal(stickSeries(indexEntry()), null);
	assert.equal(stickSeries(null), null);
	assert.equal(stickSeries({ samples: { alt: [1, 2] } }), null);
});

// ----------------------------------------------------------------- FAMILIES

t('families: one bar per family, mean survival on it, targets met inside', () => {
	const f = familySeries([
		session({ id: 'a', seq: 1, targetSeq: 1, target: { family: 'heavy5' }, flightTelemetry: { durationS: 300 } }),
		session({ id: 'b', seq: 2, targetSeq: 2, target: { family: 'heavy5' }, flightTelemetry: { durationS: 100 } }),
		session({ id: 'c', seq: 3, targetSeq: 3, target: { family: 'race5' }, flightTelemetry: { durationS: 60 } }),
		// No target: it belongs to no family and must not invent one.
		session({ id: 'd', seq: 4, targetSeq: 0, target: null, flightTelemetry: { durationS: 900 } }),
	]);
	assert.deepEqual(f.families.map((x) => x.family), ['heavy5', 'race5'], 'most met first');
	assert.equal(f.families[0].count, 2);
	assert.equal(f.families[0].meanS, 200);
	assert.equal(f.families[0].entries.length, 2, 'the targets met, which is what the TARGET LOG was');
	assert.equal(f.families[0].entries[0].targetSeq, 2, 'newest first, like the log');
	assert.ok(f.families[0].label.length > 0, 'a family reads as its profile label');
	assert.equal(f.max, 200);
	assert.equal(f.total, 3);
});

t('families: no target ever met is an empty list, not a zero bar', () => {
	const f = familySeries([session({ targetSeq: 0, target: null })]);
	assert.deepEqual(f.families, []);
	assert.equal(f.total, 0);
});

// ---------------------------------------------------------------- GEOGRAPHY

t('geography: areas by visits, cumulative distance, countries only when known', () => {
	const g = geographySeries([
		session({ id: 'a', area: 'paristest', flightTelemetry: { distanceM: 1200 } }),
		session({ id: 'b', area: 'paristest', flightTelemetry: { distanceM: 800 } }),
		session({ id: 'c', area: 'live-berlin', flightTelemetry: { distanceM: 2000 } }),
	]);
	assert.deepEqual(g.areas.map((a) => [a.slug, a.count]), [['paristest', 2], ['live-berlin', 1]]);
	assert.equal(g.areas[0].label, 'PARISTEST');
	assert.equal(g.distanceM, 4000);
	assert.equal(g.areaCount, 2);
	// Nothing on a session says which country it was: the model reports none
	// rather than guessing one out of a slug.
	assert.deepEqual(g.countries, []);
});

t('geography: a country is read when a session carries one', () => {
	const g = geographySeries([
		session({ id: 'a', country: 'FR' }),
		session({ id: 'b', country: 'FR' }),
		session({ id: 'c', country: 'DE' }),
	]);
	assert.deepEqual(g.countries.map((c) => [c.code, c.count]), [['FR', 2], ['DE', 1]]);
});

// ------------------------------------------------------------------ PROFILE

t('profile: altitude against time, with the photos marked on the curve', () => {
	const track = {
		samples: { t: [0, 1, 2, 3], alt: [0, 10, 25, 12], lat: [1, 1, 1, 1], lon: [2, 2, 2, 2] },
		photos: [{ i: 0, t: 2 }],
	};
	const p = profileSeries(track);
	assert.deepEqual(p.points.map((q) => [q.t, q.alt]), [[0, 0], [1, 10], [2, 25], [3, 12]]);
	assert.equal(p.durationS, 3);
	assert.equal(p.maxAltM, 25);
	assert.deepEqual(p.photos, [{ i: 0, t: 2, alt: 25 }]);
});

t('profile: a photo without a time is placed by its sample index', () => {
	const track = { samples: { t: [0, 1, 2], alt: [0, 5, 9] }, photos: [{ i: 0, sample: 1 }] };
	assert.deepEqual(profileSeries(track).photos, [{ i: 0, t: 1, alt: 5 }]);
});

t('profile: no samples is null — the screen says NO TRACK, it does not draw a flat line', () => {
	assert.equal(profileSeries(null), null);
	assert.equal(profileSeries(indexEntry()), null);
});

// --------------------------------------------------------- the whole screen

t('defaultFlightId: the last flight WITH a track, not just the last flight', () => {
	const sessions = [
		session({ id: 'a', start: new Date(NOW - 3 * DAY).toISOString() }),
		session({ id: 'b', start: new Date(NOW - 2 * DAY).toISOString() }),
		session({ id: 'c', start: new Date(NOW - DAY).toISOString() }),
	];
	assert.equal(defaultFlightId(sessions, [indexEntry({ sessionId: 'b' })]), 'b');
	assert.equal(defaultFlightId(sessions, []), null, 'no track at all: nothing is selected');
	assert.equal(defaultFlightId([], []), null);
});

t('dataModel: every section is present, and none of them throws without tracks', () => {
	const m = dataModel({ sessions: [session()], tracks: [], now: NOW });
	for (const k of ['rhythm', 'life', 'speedAlt', 'loss', 'families', 'geography']) {
		assert.ok(m[k], `${k} is missing`);
	}
	assert.equal(m.hasTracks, false);
	assert.equal(m.selectedId, null);
	assert.deepEqual(m.flights, []);
	assert.equal(m.sessionCount, 1);
});

t('dataModel: the flights that can be profiled are listed oldest to newest', () => {
	const sessions = [
		session({ id: 'a', seq: 1, start: new Date(NOW - 3 * DAY).toISOString() }),
		session({ id: 'b', seq: 2, start: new Date(NOW - 2 * DAY).toISOString() }),
	];
	const m = dataModel({ sessions, tracks: [indexEntry({ sessionId: 'a' }), indexEntry({ sessionId: 'b' })], now: NOW });
	assert.deepEqual(m.flights.map((f) => f.id), ['a', 'b']);
	assert.equal(m.selectedId, 'b');
	assert.equal(m.hasTracks, true);
	assert.equal(m.flights[0].label, 'SESSION 00001');
});

t('dataModel: junk in, a readable screen out', () => {
	const m = dataModel({ sessions: null, tracks: null, now: NOW });
	assert.equal(m.sessionCount, 0);
	assert.equal(m.life.bars.length, 0);
	assert.equal(m.rhythm.bars.length, RHYTHM_WEEKS);
});

console.log(`\n${n} tests data-model OK`);
