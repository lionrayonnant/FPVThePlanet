// Selftest of the HUD callout's pure layout (issue #185, spec §4).
// Run: node tools/signal-callout-selftest.mjs
import assert from 'node:assert/strict';
import { placeCallout, revealCount, scramble, headline } from './signal-callout-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const VP = { w: 1600, h: 900 };

t('an anchor on screen: px position, box up-right, inside the viewport', () => {
	const p = placeCallout({ ndcX: 0, ndcY: 0, behind: false }, VP, {});
	assert.equal(p.onScreen, true);
	assert.deepEqual([p.ax, p.ay], [800, 450]);
	assert.ok(p.bx > p.ax && p.by < p.ay);
	assert.equal(p.edge, null);
});

t('near the right edge the box flips left; near the top it is clamped down', () => {
	const p = placeCallout({ ndcX: 0.95, ndcY: 0.98, behind: false }, VP, {});
	assert.ok(p.bx + 230 <= VP.w, String(p.bx));
	assert.ok(p.bx < p.ax);
	assert.ok(p.by >= 0);
});

t('off screen to the right: an edge chevron on the right border pointing right', () => {
	const p = placeCallout({ ndcX: 3, ndcY: 0, behind: false }, VP, { margin: 24 });
	assert.equal(p.onScreen, false);
	assert.ok(Math.abs(p.edge.x - (VP.w - 24)) < 1 && Math.abs(p.edge.y - 450) < 1);
	assert.ok(Math.abs(p.edge.angleDeg) < 1);
});

t('behind the camera: the chevron points the other way', () => {
	const p = placeCallout({ ndcX: 0.5, ndcY: 0, behind: true }, VP, { margin: 24 });
	assert.equal(p.onScreen, false);
	assert.ok(p.edge.x < VP.w / 2, 'reversed: the left side');
});

t('revealCount: name first, all at 100 %, nothing when merely near, all when resolved', () => {
	assert.equal(revealCount(5, 0, 'near'), 0);
	assert.equal(revealCount(5, 0.2, 'capturing'), 1);
	assert.equal(revealCount(5, 0.99, 'capturing'), 5);
	assert.equal(revealCount(5, 0.5, 'held'), 3);
	assert.equal(revealCount(5, 0, 'resolved'), 5);
	assert.equal(revealCount(0, 1, 'capturing'), 0);
});

t('scramble: same length, spaces kept, deterministic per seed, changes with the seed', () => {
	const s = 'NOTRE DAME';
	assert.equal(scramble(s, 1).length, s.length);
	assert.equal(scramble(s, 1)[5], ' ');
	assert.equal(scramble(s, 1), scramble(s, 1));
	assert.notEqual(scramble(s, 1), scramble(s, 2));
	assert.ok(/^[░▒▓█ ]+$/.test(scramble(s, 7)));
});

t('headline: words and functional tones', () => {
	assert.deepEqual(headline('near'), { word: 'SIGNAL', tone: 'dim' });
	assert.deepEqual(headline('held'), { word: 'SIGNAL', tone: 'dim' });
	assert.deepEqual(headline('capturing'), { word: 'CAPTURING', tone: 'orange' });
	assert.deepEqual(headline('resolved'), { word: 'UPLINKED', tone: 'green' });
});

console.log(`signal-callout: ${n} ok`);
