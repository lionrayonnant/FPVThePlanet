// Selftest of the Wikidata / Commons model (issue #185, lot 2b). Fixtures are
// trimmed from the real answers for the Panthéon (2026-09-27). No network.
// Run: node tools/wikidata-model-selftest.mjs
import assert from 'node:assert/strict';
import { entityUrl, parseEntity, commonsUrl, parseCommons, safeImageUrl, qidOf } from './wikidata-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ENTITY = { entities: { Q188856: {
	descriptions: { en: { language: 'en', value: 'mausoleum in Paris for the most distinguished French people' } },
	claims: {
		P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Panthéon, Paris 25 March 2012.jpg' } } }],
		P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+1758-00-00T00:00:00Z', precision: 9 } } } }],
		P2048: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+83', unit: 'http://www.wikidata.org/entity/Q11573' } } } }],
	},
} } };

const COMMONS = { query: { pages: { 38044545: { imageinfo: [{
	thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/58/Panth%C3%A9on%2C_Paris_25_March_2012.jpg/500px-Panth%C3%A9on%2C_Paris_25_March_2012.jpg',
	thumbwidth: 480, thumbheight: 326,
	extmetadata: {
		Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Trizek">Camille G&eacute;vaudan</a>' },
		LicenseShortName: { value: 'CC BY-SA 3.0' },
	},
}] } } } };

t('qidOf', () => {
	assert.equal(qidOf('wd:Q188856'), 'Q188856');
	assert.equal(qidOf('osm:way/1'), null);
	assert.equal(qidOf('wd:Q1;drop'), null);
});

t('entityUrl: CORS origin, the one id, claims + descriptions in English', () => {
	const u = new URL(entityUrl('Q188856'));
	assert.equal(u.origin, 'https://www.wikidata.org');
	assert.equal(u.searchParams.get('ids'), 'Q188856');
	assert.equal(u.searchParams.get('origin'), '*');
	assert.equal(u.searchParams.get('props'), 'claims|descriptions');
	assert.equal(u.searchParams.get('languages'), 'en');
});

t('parseEntity: the Panthéon', () => {
	assert.deepEqual(parseEntity(ENTITY, 'Q188856'), {
		description: 'mausoleum in Paris for the most distinguished French people',
		image: 'Panthéon, Paris 25 March 2012.jpg',
		year: 1758,
		heightM: 83,
	});
});

t('parseEntity: preferred rank wins, deprecated ignored, feet are not metres, BC years, garbage', () => {
	const e = { entities: { Q1: { claims: {
		P18: [
			{ rank: 'deprecated', mainsnak: { datavalue: { value: 'bad.jpg' } } },
			{ rank: 'normal', mainsnak: { datavalue: { value: 'normal.jpg' } } },
			{ rank: 'preferred', mainsnak: { datavalue: { value: 'best.jpg' } } },
		],
		P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '-0052-00-00T00:00:00Z', precision: 9 } } } }],
		P2048: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+300', unit: 'http://www.wikidata.org/entity/Q3710' } } } }],
	} } } };
	assert.deepEqual(parseEntity(e, 'Q1'), { description: null, image: 'best.jpg', year: -52, heightM: null });
	assert.deepEqual(parseEntity(null, 'Q1'), { description: null, image: null, year: null, heightM: null });
	assert.deepEqual(parseEntity({ entities: { Q1: { claims: 'x' } } }, 'Q1'), { description: null, image: null, year: null, heightM: null });
});

t('parseEntity: a decade/century precision is not a year', () => {
	const e = { entities: { Q1: { claims: { P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+1700-00-00T00:00:00Z', precision: 7 } } } }] } } } };
	assert.equal(parseEntity(e, 'Q1').year, null);
});

t('commonsUrl: the file title, the width, the two metadata fields, CORS', () => {
	const u = new URL(commonsUrl('Panthéon, Paris 25 March 2012.jpg', 480));
	assert.equal(u.origin, 'https://commons.wikimedia.org');
	assert.equal(u.searchParams.get('titles'), 'File:Panthéon, Paris 25 March 2012.jpg');
	assert.equal(u.searchParams.get('iiurlwidth'), '480');
	assert.equal(u.searchParams.get('iiextmetadatafilter'), 'Artist|LicenseShortName');
	assert.equal(u.searchParams.get('origin'), '*');
});

t('parseCommons: thumb URL, size, artist stripped of HTML, licence', () => {
	assert.deepEqual(parseCommons(COMMONS), {
		url: COMMONS.query.pages[38044545].imageinfo[0].thumburl,
		w: 480, h: 326,
		artist: 'Camille Gévaudan',
		license: 'CC BY-SA 3.0',
	});
	assert.equal(parseCommons(null), null);
	assert.equal(parseCommons({ query: { pages: { '-1': { missing: '' } } } }), null);
});

t('safeImageUrl: only the two Wikimedia image hosts, https', () => {
	assert.ok(safeImageUrl('https://upload.wikimedia.org/a.jpg'));
	assert.ok(safeImageUrl('https://thumb.wikimedia.org/a.jpg'));
	assert.equal(safeImageUrl('http://upload.wikimedia.org/a.jpg'), null);
	assert.equal(safeImageUrl('https://upload.wikimedia.org.evil.com/a.jpg'), null);
	assert.equal(safeImageUrl('javascript:alert(1)'), null);
	assert.equal(safeImageUrl(3), null);
	const bad = structuredClone(COMMONS);
	bad.query.pages[38044545].imageinfo[0].thumburl = 'https://evil.example/x.jpg';
	assert.equal(parseCommons(bad), null, 'no usable image, no card photo');
});

t('parseCommons: malformed numeric entities do not throw', () => {
	const bad = structuredClone(COMMONS);
	bad.query.pages[38044545].imageinfo[0].extmetadata.Artist.value = 'weird &#99999999; artist &#65;';
	const result = parseCommons(bad);
	assert.ok(result);
	assert.equal(result.artist, 'weird artist A');
});

t('parseCommons: hex entities are decoded', () => {
	const bad = structuredClone(COMMONS);
	bad.query.pages[38044545].imageinfo[0].extmetadata.Artist.value = 'test &#x41; hex';
	const result = parseCommons(bad);
	assert.ok(result);
	assert.equal(result.artist, 'test A hex');
});

console.log(`wikidata-model: ${n} ok`);
