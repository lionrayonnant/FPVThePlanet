// Enriched map model selftest (issue #25). No scene data, no network, no
// browser: plain numbers through tools/enriched-map-model.mjs, which is why it
// runs in selftest:ci. Run: node tools/enriched-map-selftest.mjs
import assert from 'node:assert/strict';
import {
	CLUSTER_PX, THUMB_ZOOM, PHOTO_PX, THUMB_PX, HIT_PX,
	boxesIntersect, pointInBox, tracksInView, clusterMarks,
	photoMarkStyle, hitMark, lossLabel,
} from './enriched-map-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const entry = (line, extra = {}) => ({ line, start: null, end: null, photos: [], ...extra });

t('constants match the spec verbatim', () => {
	assert.equal(CLUSTER_PX, 20);
	assert.equal(THUMB_ZOOM, 16);
	assert.ok(PHOTO_PX < THUMB_PX, 'a thumbnail is bigger than the square it replaces');
});

t('boxesIntersect: touching boxes count, disjoint ones do not', () => {
	const a = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
	assert.equal(boxesIntersect(a, { minLat: 1, maxLat: 2, minLon: 1, maxLon: 2 }), true);
	assert.equal(boxesIntersect(a, { minLat: 2, maxLat: 3, minLon: 0, maxLon: 1 }), false);
	assert.equal(boxesIntersect(a, { minLat: 0, maxLat: 1, minLon: 2, maxLon: 3 }), false);
	assert.equal(boxesIntersect(a, null), false);
});

t('pointInBox: a null box accepts everything', () => {
	assert.equal(pointInBox(48.8, 2.3, null), true);
	assert.equal(pointInBox(48.8, 2.3, { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 }), true);
	assert.equal(pointInBox(50, 2.3, { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 }), false);
});

t('tracksInView: keeps what the view touches, drops the rest', () => {
	const paris = entry([[48.85, 2.29], [48.86, 2.30]]);
	const tokyo = entry([[35.68, 139.76], [35.69, 139.77]]);
	const all = [paris, tokyo];
	assert.equal(tracksInView(all, null).length, 2, 'no box means no filter');
	const view = { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 };
	assert.deepEqual(tracksInView(all, view), [paris]);
	assert.equal(tracksInView(all, { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }).length, 0);
});

t('tracksInView: a track with no geometry at all is dropped, never thrown on', () => {
	assert.equal(tracksInView([entry([])], { minLat: 0, maxLat: 90, minLon: -180, maxLon: 180 }).length, 0);
	assert.equal(tracksInView(null, null).length, 0);
});

t('tracksInView: a track known only by its end event still shows', () => {
	const only = entry([], { end: { lat: 48.85, lon: 2.29, alt: 30, spd: 12, result: 'CRASHED' } });
	assert.equal(tracksInView([only], { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 }).length, 1);
});

t('clusterMarks: marks closer than CLUSTER_PX collapse and carry a count', () => {
	const c = clusterMarks([{ x: 100, y: 100, id: 'a' }, { x: 110, y: 100, id: 'b' }]);
	assert.equal(c.length, 1);
	assert.equal(c[0].count, 2);
	assert.deepEqual(c[0].items.map((m) => m.id).sort(), ['a', 'b']);
});

t('clusterMarks: marks further than CLUSTER_PX stay apart', () => {
	const c = clusterMarks([{ x: 100, y: 100 }, { x: 100, y: 121 }]);
	assert.equal(c.length, 2);
	assert.ok(c.every((m) => m.count === 1));
});

t('clusterMarks: the boundary is inclusive and measured in 2D', () => {
	assert.equal(clusterMarks([{ x: 0, y: 0 }, { x: CLUSTER_PX, y: 0 }]).length, 1);
	// 20 px on each axis is 28 px apart: further than the threshold.
	assert.equal(clusterMarks([{ x: 0, y: 0 }, { x: CLUSTER_PX, y: CLUSTER_PX }]).length, 2);
});

t('clusterMarks: a cluster sits exactly on a real point, not on a drifting centroid', () => {
	const c = clusterMarks([{ x: 100, y: 100 }, { x: 115, y: 100 }, { x: 128, y: 100 }]);
	// 100 and 115 group; 128 is 28 from 100, so it opens its own cluster.
	assert.equal(c.length, 2);
	assert.equal(c[0].x, 100);
	assert.equal(c[1].x, 128);
});

t('clusterMarks: the result does not depend on input order', () => {
	const marks = [
		{ x: 40, y: 12, id: 'a' }, { x: 300, y: 40, id: 'b' },
		{ x: 47, y: 15, id: 'c' }, { x: 305, y: 44, id: 'd' }, { x: 900, y: 900, id: 'e' },
	];
	const shape = (list) => clusterMarks(list).map((c) => [c.x, c.y, c.count]);
	const forward = shape(marks);
	assert.deepEqual(shape([...marks].reverse()), forward);
	assert.deepEqual(forward.map((s) => s[2]), [2, 2, 1]);
});

t('clusterMarks: a very flown area declusters only as you zoom in', () => {
	// Ten losses on a 60 m square: one mark at world zoom (a few pixels apart),
	// ten at street zoom (hundreds of pixels apart). Same points, same code.
	const jitter = (i) => ({ id: i, dx: ((i * 37) % 10) - 5, dy: ((i * 53) % 10) - 5 });
	const at = (scale) => clusterMarks(Array.from({ length: 10 }, (_, i) => {
		const j = jitter(i);
		return { x: 500 + j.dx * scale, y: 500 + j.dy * scale, id: j.id };
	}));
	assert.equal(at(0.4).length, 1, 'zoomed out, one mark');
	assert.equal(at(0.4)[0].count, 10);
	assert.equal(at(40).length, 10, 'zoomed in, ten marks');
});

t('clusterMarks: non-finite marks are dropped rather than poisoning a cluster', () => {
	const c = clusterMarks([{ x: NaN, y: 1 }, null, { x: 5, y: 5 }]);
	assert.equal(c.length, 1);
	assert.equal(c[0].x, 5);
});

t('photoMarkStyle: squares below THUMB_ZOOM, thumbnails at and above it', () => {
	assert.deepEqual(photoMarkStyle(15), { thumb: false, side: PHOTO_PX });
	assert.deepEqual(photoMarkStyle(THUMB_ZOOM), { thumb: true, side: THUMB_PX });
	assert.deepEqual(photoMarkStyle(19), { thumb: true, side: THUMB_PX });
	assert.equal(photoMarkStyle(undefined).thumb, false);
});

t('hitMark: nearest within the radius, null outside it', () => {
	const marks = [{ x: 100, y: 100, id: 'a' }, { x: 106, y: 100, id: 'b' }];
	assert.equal(hitMark(marks, 105, 100).id, 'b');
	assert.equal(hitMark(marks, 101, 100).id, 'a');
	assert.equal(hitMark(marks, 100 + HIT_PX + 20, 100), null);
	assert.equal(hitMark([], 0, 0), null);
});

t('hitMark: a thumbnail claims its own size', () => {
	const marks = [{ x: 100, y: 100, r: THUMB_PX / 2, id: 'thumb' }];
	assert.equal(hitMark(marks, 116, 100)?.id, 'thumb');
	assert.equal(hitMark(marks, 130, 100), null);
});

t('lossLabel: a count when collapsed, a date when alone', () => {
	assert.equal(lossLabel({ count: 3, items: [{}, {}, {}] }), '3 LOSSES');
	assert.equal(lossLabel({ count: 1, items: [{ sessionId: 'x' }] }, () => '2026-09-08'), '2026-09-08');
	assert.equal(lossLabel({ count: 1, items: [{}] }, () => null), 'LOSS');
	assert.equal(lossLabel(null), '');
});

console.log(`\n${n} ok`);
