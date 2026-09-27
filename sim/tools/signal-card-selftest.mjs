// Selftest of the UPLINKED card's pure half (issue #185, spec
// 2026-09-27-signals-lot2b). No DOM, no network.
// Run: node tools/signal-card-selftest.mjs
import assert from 'node:assert/strict';
import { CARD_S, MAX_FACTS, cardFacts, creditLine, CardQueue, recapTiles } from './signal-card-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const pantheon = {
	id: 'wd:Q188856',
	kind: 'MAUSOLEUM',
	fields: [
		{ key: 'name', label: 'NAME', value: 'PANTHÉON' },
		{ key: 'type', label: 'TYPE', value: 'MAUSOLEUM' },
		{ key: 'built', label: 'BUILT', value: '1764' },
		{ key: 'height', label: 'HEIGHT', value: '71 M' },
		{ key: 'status', label: 'STATUS', value: 'PROTECTED' },
	],
};

t('cardFacts: Wikidata wins over OSM for year and height', () => {
	const info = { description: 'Mausoleum in Paris', year: 1758, heightM: 83, photo: null };
	assert.deepEqual(cardFacts(pantheon, info), [
		{ icon: 'landmark', text: 'MAUSOLEUM' },
		{ icon: 'calendar', text: '1758' },
		{ icon: 'height', text: '83 M' },
		{ icon: 'heritage', text: 'PROTECTED' },
	]);
});

t('cardFacts: falls back to the OSM fields when Wikidata has none', () => {
	const info = { description: null, year: null, heightM: null, photo: null };
	assert.deepEqual(cardFacts(pantheon, info), [
		{ icon: 'landmark', text: 'MAUSOLEUM' },
		{ icon: 'calendar', text: '1764' },
		{ icon: 'height', text: '71 M' },
		{ icon: 'heritage', text: 'PROTECTED' },
	]);
});

t('cardFacts: no info at all still falls back to OSM', () => {
	assert.deepEqual(cardFacts(pantheon, null), [
		{ icon: 'landmark', text: 'MAUSOLEUM' },
		{ icon: 'calendar', text: '1764' },
		{ icon: 'height', text: '71 M' },
		{ icon: 'heritage', text: 'PROTECTED' },
	]);
});

t('cardFacts: caps at MAX_FACTS, only known facts, in order', () => {
	const bare = { kind: 'TOWER', fields: [] };
	assert.deepEqual(cardFacts(bare, null), [{ icon: 'landmark', text: 'TOWER' }]);
	assert.equal(MAX_FACTS, 4);
	assert.ok(cardFacts(pantheon, { year: 1758, heightM: 83 }).length <= MAX_FACTS);
});

t('cardFacts: a negative Wikidata year reads as BC', () => {
	const info = { year: -52, heightM: null, photo: null };
	const facts = cardFacts(pantheon, info);
	assert.deepEqual(facts.find((f) => f.icon === 'calendar'), { icon: 'calendar', text: '52 BC' });
});

t('creditLine: artist and license present', () => {
	const info = { photo: { url: 'https://upload.wikimedia.org/x.jpg', artist: 'Camille Gévaudan', license: 'CC BY-SA 3.0' } };
	assert.equal(creditLine(info), 'PHOTO © Camille Gévaudan · CC BY-SA 3.0 · WIKIMEDIA COMMONS');
});

t('creditLine: no artist falls back to UNKNOWN', () => {
	const info = { photo: { url: 'https://upload.wikimedia.org/x.jpg', artist: null, license: 'Public domain' } };
	assert.equal(creditLine(info), 'PHOTO © UNKNOWN · Public domain · WIKIMEDIA COMMONS');
});

t('creditLine: no photo, no info at all', () => {
	assert.equal(creditLine({ photo: null }), null);
	assert.equal(creditLine(null), null);
});

t('CardQueue: one card shows CARD_S seconds then empties', () => {
	const q = new CardQueue();
	q.push({ id: 'a' });
	let r = q.update(0);
	assert.equal(r.current.id, 'a');
	assert.equal(r.remaining01, 1);
	r = q.update(CARD_S / 2);
	assert.equal(r.current.id, 'a');
	assert.ok(Math.abs(r.remaining01 - 0.5) < 1e-9);
	r = q.update(CARD_S / 2);
	assert.equal(r.current, null);
	assert.equal(r.remaining01, 0);
});

t('CardQueue: a second push waits its turn, then starts fresh', () => {
	const q = new CardQueue();
	q.push({ id: 'a' });
	q.update(1);
	q.push({ id: 'b' });
	let r = q.update(CARD_S - 1); // exactly ends 'a'
	assert.equal(r.current.id, 'b');
	assert.equal(r.remaining01, 1);
	r = q.update(1);
	assert.equal(r.current.id, 'b');
	assert.ok(r.remaining01 < 1 && r.remaining01 > 0);
});

t('CardQueue: dt <= 0 freezes', () => {
	const q = new CardQueue();
	q.push({ id: 'a' });
	q.update(2);
	const before = q.update(0);
	const frozen = q.update(-5);
	assert.deepEqual(frozen, before);
});

t('recapTiles: 7 entries -> 6 tiles + 1 more, in order', () => {
	const entries = Array.from({ length: 7 }, (_, i) => ({ signal: { id: `wd:Q${i}` } }));
	const r = recapTiles(entries);
	assert.equal(r.tiles.length, 6);
	assert.equal(r.more, 1);
	assert.deepEqual(r.tiles.map((e) => e.signal.id), entries.slice(0, 6).map((e) => e.signal.id));
});

t('recapTiles: 0 entries -> null; a custom max; exactly max -> more 0', () => {
	assert.equal(recapTiles([]), null);
	assert.equal(recapTiles(null), null);
	const three = [{ a: 1 }, { a: 2 }, { a: 3 }];
	assert.deepEqual(recapTiles(three, 2), { tiles: three.slice(0, 2), more: 1 });
	assert.deepEqual(recapTiles(three, 3), { tiles: three, more: 0 });
});

console.log(`\n${n} signal-card tests OK`);
