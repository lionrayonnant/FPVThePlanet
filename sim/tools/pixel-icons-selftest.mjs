// Selftest of the pixel-art library (PHASE 20, Bible §41). No DOM, no I/O.
// Run: node tools/pixel-icons-selftest.mjs
import assert from 'node:assert/strict';
import { PIXEL_ICONS, ICON_NAMES, iconSVG } from '../src/pixel-icons.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('ICON_NAMES: the Bible §41 set, plus source', () => {
	assert.deepEqual([...ICON_NAMES].sort(), [
		'antenna', 'battery', 'camera', 'drone', 'gps', 'link', 'map', 'radio',
		'source', 'terrain',
	]);
});

t('PIXEL_ICONS: every icon is a 12x12 grid of . and #', () => {
	for (const name of ICON_NAMES) {
		const rows = PIXEL_ICONS[name];
		assert.equal(rows.length, 12, `${name}: 12 rows`);
		for (const r of rows) {
			assert.equal(r.length, 12, `${name}: 12 columns`);
			assert.match(r, /^[.#]*$/, `${name}: only . and #`);
		}
	}
});

t('PIXEL_ICONS: no icon is empty, none is solid', () => {
	for (const name of ICON_NAMES) {
		const on = PIXEL_ICONS[name].join('').split('#').length - 1;
		assert.ok(on >= 10 && on <= 100, `${name}: ${on} lit pixels`);
	}
});

t('iconSVG: crispEdges rects, no emoji', () => {
	const svg = iconSVG('drone');
	assert.match(svg, /^<svg /);
	assert.match(svg, /crispEdges/);
	assert.match(svg, /<rect /);
	assert.doesNotMatch(svg, /[\u{1F000}-\u{1FAFF}]/u);
	assert.throws(() => iconSVG('rocket'));
});

// The source icon carries a licence obligation, not a decoration: the AGPL's
// section 13 asks that a networked player be offered the source, and this is
// the mark that offers it. So it is pinned harder than the rest — symmetric,
// because a lopsided chevron pair reads as a rendering fault rather than as a
// glyph, and small enough to stay legible at the 9 px the flight OSD uses.
t('source: a symmetric chevron pair, legible small', () => {
	const rows = PIXEL_ICONS.source;
	for (const r of rows) {
		assert.equal(r, [...r].reverse().join(''), `asymmetric row: ${r}`);
	}
	const on = rows.join('').split('#').length - 1;
	assert.equal(on, 16, 'eight pixels per chevron');
	assert.equal(iconSVG('source', { size: 9 }).match(/<rect /g).length, on);
});

console.log(`\n${n} pixel-icons tests OK`);
