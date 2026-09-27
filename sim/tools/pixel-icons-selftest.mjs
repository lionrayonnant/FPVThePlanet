// Selftest of the pixel-art library (PHASE 20, Bible §41). No DOM, no I/O.
// Run: node tools/pixel-icons-selftest.mjs
import assert from 'node:assert/strict';
import { PIXEL_ICONS, ICON_NAMES, iconSVG, iconPath } from '../src/pixel-icons.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('ICON_NAMES: the Bible §41 set, the footer marks and the RECOMMENDED pair', () => {
	assert.deepEqual([...ICON_NAMES].sort(), [
		'antenna', 'battery', 'bitcoin', 'cake', 'camera', 'chrome', 'drone',
		'gamepad', 'github', 'gps', 'link', 'map', 'monero', 'radio', 'source',
		'terrain',
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

// The bound catches the two ways a 12x12 grid stops being a glyph: empty, and
// filled. The ceiling sits above 100 because a filled SILHOUETTE — GitHub's
// mark — is a legitimate icon and lights more of the grid than a line drawing;
// what it must not do is light all 144.
t('PIXEL_ICONS: no icon is empty, none is solid', () => {
	for (const name of ICON_NAMES) {
		const on = PIXEL_ICONS[name].join('').split('#').length - 1;
		assert.ok(on >= 10 && on <= 110, `${name}: ${on} lit pixels`);
	}
});

// The three tip marks and the source mark are the only icons a player is asked
// to RECOGNISE rather than read alongside a label — the footer buttons carry no
// text. A mark that drifts off-centre or loses its symmetry stops being the
// logo it is standing in for, so each is pinned to what makes it that logo.
t('footer marks: each keeps what makes it recognisable', () => {
	// GitHub: a silhouette, so it is pinned by its outline — ears at the top,
	// a tail split at the bottom, and both halves mirrored.
	for (const r of PIXEL_ICONS.github) {
		assert.equal(r, [...r].reverse().join(''), `github asymmetric row: ${r}`);
	}
	// Bitcoin: the two stems above and below the B are the whole difference
	// between the currency's glyph and a capital B.
	const btc = PIXEL_ICONS.bitcoin;
	for (const y of [0, 1, 10, 11]) {
		assert.match(btc[y], /^\.*#+\.+#+\.*$/, `bitcoin row ${y}: two stems`);
	}
	// Monero: a closed ring. Every row of the glyph touches both sides of it.
	const xmr = PIXEL_ICONS.monero;
	for (let y = 3; y <= 7; y++) {
		assert.equal(xmr[y][0], '#', `monero row ${y}: left of the ring`);
		assert.equal(xmr[y][11], '#', `monero row ${y}: right of the ring`);
	}
});

// The RECOMMENDED screen asks the player to recognise these two at a glance,
// so each is pinned to what makes it that thing.
t('RECOMMENDED marks: each keeps what makes it recognisable', () => {
	// The pad: a silhouette whose outline is mirrored — shoulders, body and
	// grips — while the inside is not (D-pad left, face buttons right).
	const g = PIXEL_ICONS.gamepad;
	for (const y of [1, 2, 7, 8, 9, 10, 11]) {
		assert.equal(g[y], [...g[y]].reverse().join(''), `gamepad outline row ${y}`);
	}
	assert.equal(g[4].slice(1, 4), '...', 'the D-pad crossbar, left');
	assert.equal(g[4].slice(8, 11), '.#.', 'the face-button diamond, right');
	assert.notEqual(g[4], [...g[4]].reverse().join(''), 'left and right differ inside');
	// Chrome: a disc that reaches all four edges, a solid centre, and an empty
	// ring around it.
	const c = PIXEL_ICONS.chrome;
	assert.ok(c[0].includes('#') && c[11].includes('#'), 'chrome: top and bottom of the disc');
	assert.ok(c.some((r) => r[0] === '#') && c.some((r) => r[11] === '#'), 'chrome: both sides');
	for (const [x, y] of [[5, 5], [6, 5], [5, 6], [6, 6]]) assert.equal(c[y][x], '#', `centre ${x},${y}`);
	for (const [x, y] of [[5, 3], [6, 3], [3, 5], [8, 5], [5, 8], [6, 8]]) assert.equal(c[y][x], '.', `ring ${x},${y}`);
});

t('iconPath: one rectangle per run, covering exactly the lit pixels', () => {
	for (const name of ICON_NAMES) {
		const d = iconPath(name);
		let area = 0;
		for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
			assert.equal(m[3], m[4], `${name}: closed run`);
			const [x, y, w] = [+m[1], +m[2], +m[3]];
			assert.equal(PIXEL_ICONS[name][y].slice(x, x + w), '#'.repeat(w), `${name}: run at ${x},${y}`);
			area += w;
		}
		assert.equal(area, PIXEL_ICONS[name].join('').split('#').length - 1, `${name}: every lit pixel`);
	}
	assert.throws(() => iconPath('rocket'));
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
