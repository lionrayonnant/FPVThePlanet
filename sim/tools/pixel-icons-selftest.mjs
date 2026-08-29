// Selftest de la bibliothèque pixel art (PHASE 20, Bible §41). Aucune E/S DOM.
// Lancer : node tools/pixel-icons-selftest.mjs
import assert from 'node:assert/strict';
import { PIXEL_ICONS, ICON_NAMES, iconSVG, faviconDataURI } from '../src/pixel-icons.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('ICON_NAMES : exactement les 9 icônes de la Bible §41', () => {
	assert.deepEqual([...ICON_NAMES].sort(), [
		'antenna', 'battery', 'camera', 'drone', 'gps', 'link', 'map', 'radio', 'terrain',
	]);
});

t('PIXEL_ICONS : chaque icône est une grille 12x12 de . et #', () => {
	for (const name of ICON_NAMES) {
		const rows = PIXEL_ICONS[name];
		assert.equal(rows.length, 12, `${name} : 12 lignes`);
		for (const r of rows) {
			assert.equal(r.length, 12, `${name} : 12 colonnes`);
			assert.match(r, /^[.#]*$/, `${name} : uniquement . et #`);
		}
	}
});

t('PIXEL_ICONS : aucune icône vide ni pleine', () => {
	for (const name of ICON_NAMES) {
		const on = PIXEL_ICONS[name].join('').split('#').length - 1;
		assert.ok(on >= 10 && on <= 100, `${name} : ${on} pixels allumés`);
	}
});

t('iconSVG : rend des rects crispEdges, pas d\'emoji', () => {
	const svg = iconSVG('drone');
	assert.match(svg, /^<svg /);
	assert.match(svg, /crispEdges/);
	assert.match(svg, /<rect /);
	assert.doesNotMatch(svg, /[\u{1F000}-\u{1FAFF}]/u);
	assert.throws(() => iconSVG('rocket'));
});

t('faviconDataURI : data URI SVG du drone', () => {
	assert.match(faviconDataURI(), /^data:image\/svg\+xml,/);
});

console.log(`\n${n} tests pixel-icons OK`);
