// Flight track model selftest (issue #24). No scene data, no network, no
// browser: pure arrays through tools/track-model.mjs, which is why this runs in
// selftest:ci. Run: node tools/track-selftest.mjs
import assert from 'node:assert/strict';
import {
	TRACK_VERSION, MAX_SAMPLES, TRACK_KEEP, QUANT,
	encodeTrack, decodeTrack, validateTrack, pruneTracks,
	decimate, trackIndexEntry,
} from './track-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A plausible flight over the repo's reference point, generated rather than
// typed: the round trip must hold over thousands of samples, not three.
const EIFFEL = { lat: 48.8584, lon: 2.2945 };
function flight(count, { dt = 0.2 } = {}) {
	const out = [];
	for (let i = 0; i < count; i++) {
		out.push({
			t: i * dt,
			lat: EIFFEL.lat + Math.sin(i / 37) * 0.0031,
			lon: EIFFEL.lon + Math.cos(i / 41) * 0.0047,
			alt: 20 + 15 * Math.sin(i / 23),
			spd: 12 + 8 * Math.cos(i / 17),
			thr: 0.5 + 0.4 * Math.sin(i / 11),
			rate: 120 + 100 * Math.cos(i / 7),
		});
	}
	return out;
}

t('constants match the spec verbatim', () => {
	assert.equal(TRACK_VERSION, 1);
	assert.equal(MAX_SAMPLES, 18000);
	assert.equal(TRACK_KEEP, 200);
	assert.deepEqual(QUANT, { t: 10, lat: 1e5, lon: 1e5, alt: 10, spd: 10, thr: 100, rate: 1 });
});

t('encodeTrack: parallel arrays of integers, not an array of objects', () => {
	const st = encodeTrack(flight(50));
	assert.equal(st.v, TRACK_VERSION);
	assert.equal(st.n, 50);
	assert.equal(st.truncated, false);
	for (const k of ['t', 'lat', 'lon', 'alt', 'spd', 'thr', 'rate']) {
		assert.ok(Array.isArray(st[k]), `${k} is an array`);
		assert.equal(st[k].length, 50, `${k} has one entry per sample`);
		assert.ok(st[k].every(Number.isInteger), `${k} holds integers only`);
	}
});

t('encodeTrack: t/lat/lon/alt are deltas, spd/thr/rate are absolute', () => {
	const st = encodeTrack(flight(10));
	// A 0.2 s step at ×10 is a constant delta of 2 after the first sample.
	assert.deepEqual(st.t.slice(1), Array(9).fill(2));
	// Deltas are small; the absolute value at ×1e5 would be ~4.8 million.
	assert.ok(st.lat.slice(1).every((d) => Math.abs(d) < 1000), 'lat deltas stay small');
	assert.ok(Math.abs(st.lat[0]) > 1e6, 'the first lat is the absolute value');
	// Throttle is absolute: 0.5 + 0.4·sin(0) = 0.5 → 50.
	assert.equal(st.thr[0], 50);
});

t('round trip: every field back within its quantization error', () => {
	const src = flight(2000);
	const back = decodeTrack(encodeTrack(src));
	assert.equal(back.samples.length, src.length);
	const tol = { t: 0.05, lat: 0.5e-5, lon: 0.5e-5, alt: 0.05, spd: 0.05, thr: 0.005, rate: 0.5 };
	for (let i = 0; i < src.length; i++) {
		for (const k of Object.keys(tol)) {
			const d = Math.abs(back.samples[i][k] - src[i][k]);
			assert.ok(d <= tol[k] + 1e-12, `sample ${i}.${k}: off by ${d}, tolerance ${tol[k]}`);
		}
	}
});

t('round trip: no drift accumulation over a full hour of samples', () => {
	const src = flight(MAX_SAMPLES);
	const back = decodeTrack(encodeTrack(src));
	const last = back.samples[back.samples.length - 1];
	const ref = src[src.length - 1];
	assert.ok(Math.abs(last.lat - ref.lat) <= 0.5e-5 + 1e-12, `lat drift ${last.lat - ref.lat}`);
	assert.ok(Math.abs(last.t - ref.t) <= 0.05 + 1e-12, `t drift ${last.t - ref.t}`);
});

t('MAX_SAMPLES: beyond one armed hour the track truncates and says so', () => {
	const st = encodeTrack(flight(MAX_SAMPLES + 500));
	assert.equal(st.n, MAX_SAMPLES);
	assert.equal(st.t.length, MAX_SAMPLES);
	assert.equal(st.truncated, true);
	assert.equal(decodeTrack(st).truncated, true);
});

t('encodeTrack: a caller that capped its own buffer can declare the truncation', () => {
	// src/session.js stops pushing at MAX_SAMPLES, so the overflow is invisible
	// here unless it is passed in.
	assert.equal(encodeTrack(flight(10), {}, { truncated: true }).truncated, true);
	assert.equal(encodeTrack(flight(10)).truncated, false);
});

t('encodeTrack: degenerate samples are dropped, not encoded as NaN', () => {
	const src = flight(5);
	src[2] = { ...src[2], lat: NaN };
	src[3] = { ...src[3], alt: Infinity };
	const st = encodeTrack(src);
	assert.equal(st.n, 3);
	assert.ok(st.lat.every(Number.isInteger));
});

t('encodeTrack: events ride along, photos keep their index into photos[]', () => {
	const st = encodeTrack(flight(20), {
		start: { lat: EIFFEL.lat, lon: EIFFEL.lon },
		end: { lat: 48.86, lon: 2.30, alt: 12.5, spd: 31.2, result: 'CRASHED' },
		photos: [{ i: 0, lat: 48.859, lon: 2.295, heading: 271.4 }],
	});
	const back = decodeTrack(st);
	assert.ok(Math.abs(back.start.lat - EIFFEL.lat) <= 0.5e-5);
	assert.equal(back.end.result, 'CRASHED');
	assert.ok(Math.abs(back.end.spd - 31.2) <= 0.05);
	assert.equal(back.photos.length, 1);
	assert.equal(back.photos[0].i, 0);
	assert.ok(Math.abs(back.photos[0].heading - 271.4) <= 0.5);
});

t('encodeTrack: an empty flight is still a valid, empty track', () => {
	const st = encodeTrack([]);
	assert.equal(st.n, 0);
	assert.equal(st.start, null);
	assert.equal(st.end, null);
	assert.deepEqual(st.photos, []);
	assert.deepEqual(decodeTrack(st).samples, []);
	assert.equal(validateTrack(st), st);
});

t('encodeTrack: a bad event is dropped, it never costs the samples', () => {
	const st = encodeTrack(flight(4), {
		start: { lat: NaN, lon: 2 },
		end: { lat: 48.86, lon: 2.3, alt: 1, spd: 2, result: 'NOT A RESULT' },
		photos: [{ i: -1, lat: 1, lon: 2, heading: 0 }, { i: 3, lat: 48.8, lon: 2.2, heading: 90 }],
	});
	assert.equal(st.start, null);
	assert.equal(st.end, null);
	assert.equal(st.photos.length, 1, 'only the well-formed photo survives');
	assert.equal(st.n, 4);
});

// --- validateTrack ---------------------------------------------------------

t('validateTrack: accepts what encodeTrack produced', () => {
	const st = encodeTrack(flight(30), { start: { lat: 48.85, lon: 2.29 } });
	assert.equal(validateTrack(st), st);
	assert.equal(validateTrack(JSON.parse(JSON.stringify(st))).n, 30);
});

t('validateTrack: rejects malformed input', () => {
	const good = encodeTrack(flight(6));
	const bad = (mutate, re) => {
		const st = JSON.parse(JSON.stringify(good));
		mutate(st);
		assert.throws(() => validateTrack(st), re ?? /track/i, `should reject: ${re}`);
	};
	assert.throws(() => validateTrack(null), /track/i);
	assert.throws(() => validateTrack('nope'), /track/i);
	assert.throws(() => validateTrack([]), /track/i);
	bad((s) => { s.v = 99; }, /version/i);
	bad((s) => { delete s.lat; }, /lat/);
	bad((s) => { s.lon = 'x'; }, /lon/);
	bad((s) => { s.alt = [1.5, 2]; }, /alt/);            // non-integer
	bad((s) => { s.spd.push(3); }, /length/i);            // parallel arrays must agree
	bad((s) => { s.n = 3; }, /n/);
	bad((s) => { s.t = new Array(MAX_SAMPLES + 1).fill(0); }, /length|n/i);
	bad((s) => { s.photos = [{ i: 'a', lat: 1, lon: 2, heading: 0 }]; }, /photo/i);
	bad((s) => { s.end = { lat: 1 }; }, /end/i);
	bad((s) => { s.truncated = 'yes'; }, /truncated/i);
});

// --- pruneTracks -----------------------------------------------------------

t('pruneTracks: keeps the newest 200, drops the rest', () => {
	const list = Array.from({ length: 250 }, (_, i) => ({ id: `s-${i}`, ts: 1000 + i }));
	const { kept, dropped } = pruneTracks(list);
	assert.equal(kept.length, TRACK_KEEP);
	assert.equal(dropped.length, 50);
	assert.equal(kept[0].id, 's-249', 'newest first');
	assert.equal(kept[kept.length - 1].id, 's-50');
	assert.ok(dropped.every((e) => Number(e.id.slice(2)) < 50), 'the oldest 50 go');
});

t('pruneTracks: under the cap nothing is dropped, input order is irrelevant', () => {
	const list = [{ id: 'b', ts: 3 }, { id: 'a', ts: 9 }, { id: 'c', ts: 1 }];
	const { kept, dropped } = pruneTracks(list);
	assert.deepEqual(kept.map((e) => e.id), ['a', 'b', 'c']);
	assert.deepEqual(dropped, []);
});

t('pruneTracks: honours an explicit keep, and never mutates the caller list', () => {
	const list = [{ id: 'a', ts: 1 }, { id: 'b', ts: 2 }, { id: 'c', ts: 3 }];
	const copy = JSON.parse(JSON.stringify(list));
	const { kept, dropped } = pruneTracks(list, 1);
	assert.deepEqual(kept.map((e) => e.id), ['c']);
	assert.deepEqual(dropped.map((e) => e.id), ['b', 'a']);
	assert.deepEqual(list, copy);
	assert.deepEqual(pruneTracks([], 200), { kept: [], dropped: [] });
	assert.equal(pruneTracks(list, 0).kept.length, 0);
});

// --- decimate --------------------------------------------------------------

t('decimate: Douglas-Peucker keeps the ends and thins a dense line', () => {
	const pts = flight(2000).map((s) => [s.lat, s.lon]);
	const out = decimate(pts, 100);
	assert.ok(out.length <= 100, `${out.length} points`);
	assert.ok(out.length > 2, 'a curved flight does not collapse to a segment');
	assert.deepEqual(out[0], pts[0]);
	assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});

t('decimate: a straight line collapses to its two ends; short input is untouched', () => {
	const line = Array.from({ length: 500 }, (_, i) => [48 + i * 1e-4, 2 + i * 2e-4]);
	assert.equal(decimate(line, 100).length, 2);
	const few = [[1, 1], [2, 2], [3, 3.5]];
	assert.deepEqual(decimate(few, 100), few);
	assert.deepEqual(decimate([], 100), []);
	assert.deepEqual(decimate([[1, 2]], 100), [[1, 2]]);
});

// --- trackIndexEntry -------------------------------------------------------

t('trackIndexEntry: the map payload, never the raw sample arrays', () => {
	const st = encodeTrack(flight(2000), {
		start: { lat: EIFFEL.lat, lon: EIFFEL.lon },
		end: { lat: 48.86, lon: 2.30, alt: 12.5, spd: 31.2, result: 'CRASHED' },
		photos: [{ i: 0, lat: 48.859, lon: 2.295, heading: 271 }],
	});
	const e = trackIndexEntry(st, { sessionId: 'paris-0000' });
	assert.equal(e.sessionId, 'paris-0000');
	assert.ok(e.line.length <= 100 && e.line.length > 2);
	assert.equal(e.n, 2000);
	assert.equal(e.truncated, false);
	assert.equal(e.end.result, 'CRASHED');
	assert.equal(e.photos.length, 1);
	for (const k of ['t', 'lat', 'lon', 'alt', 'spd', 'thr', 'rate', 'samples']) {
		assert.equal(e[k], undefined, `${k} must not reach the index`);
	}
	assert.ok(JSON.stringify(e).length < JSON.stringify(st).length / 4, 'the index is far smaller');
});

t('trackIndexEntry: an empty track still yields an entry with an empty line', () => {
	const e = trackIndexEntry(encodeTrack([]), { sessionId: 'paris-0001' });
	assert.deepEqual(e.line, []);
	assert.equal(e.start, null);
	assert.equal(e.end, null);
});

console.log(`\n${n} ok`);
