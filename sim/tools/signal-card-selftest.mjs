// Selftest of the UPLINKED card's pure half (issue #185, spec
// 2026-09-27-signals-lot2b). No DOM, no network.
// Run: node tools/signal-card-selftest.mjs
import assert from 'node:assert/strict';
import { CARD_S, MAX_ROWS, cardRows, takeoffNotice, clearanceNotice, creditLine, CardQueue, recapTiles, MACHINE_NAMES } from './signal-card-model.mjs';
import { creditOf, DATA_CREDIT } from './signals-data-model.mjs';

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

t('cardRows: Wikidata wins over OSM for year and height', () => {
	const info = { description: 'Mausoleum in Paris', year: 1758, heightM: 83, photo: null };
	assert.deepEqual(cardRows(pantheon, info), [
		['TYPE', 'MAUSOLEUM'],
		['BUILT', '1758'],
		['HEIGHT', '83 m'],
		['STATUS', 'PROTECTED'],
	]);
});

t('cardRows: falls back to the OSM fields when Wikidata has none', () => {
	const info = { description: null, year: null, heightM: null, photo: null };
	assert.deepEqual(cardRows(pantheon, info), [
		['TYPE', 'MAUSOLEUM'],
		['BUILT', '1764'],
		['HEIGHT', '71 m'],
		['STATUS', 'PROTECTED'],
	]);
});

t('cardRows: no info at all still falls back to OSM', () => {
	assert.deepEqual(cardRows(pantheon, null).map(([k]) => k), ['TYPE', 'BUILT', 'HEIGHT', 'STATUS']);
});

t('cardRows: only known rows, in order, at most MAX_ROWS', () => {
	const bare = { kind: 'TOWER', fields: [] };
	assert.deepEqual(cardRows(bare, null), [['TYPE', 'TOWER']]);
	assert.deepEqual(cardRows({ fields: [] }, null), []);
	assert.deepEqual(cardRows(null, null), []);
	assert.equal(MAX_ROWS, 4);
});

t('cardRows: a negative Wikidata year reads as BC', () => {
	const rows = cardRows(pantheon, { year: -52, heightM: null, photo: null });
	assert.deepEqual(rows.find(([k]) => k === 'BUILT'), ['BUILT', '52 BC']);
});

t('cardRows: a Wikidata height is rounded', () => {
	const rows = cardRows(pantheon, { year: null, heightM: 82.6 });
	assert.deepEqual(rows.find(([k]) => k === 'HEIGHT'), ['HEIGHT', '83 m']);
});

t('creditLine: artist and license present, then the data line', () => {
	const info = { photo: { url: 'https://upload.wikimedia.org/x.jpg', artist: 'Camille Gévaudan', license: 'CC BY-SA 3.0' } };
	assert.equal(creditLine(info), '© CAMILLE GÉVAUDAN · CC BY-SA 3.0 · WIKIMEDIA COMMONS · DATA © OPENSTREETMAP · WIKIDATA');
});

t('creditLine: no artist falls back to UNKNOWN', () => {
	const info = { photo: { url: 'https://upload.wikimedia.org/x.jpg', artist: null, license: 'Public domain' } };
	assert.equal(creditLine(info), '© UNKNOWN · PUBLIC DOMAIN · WIKIMEDIA COMMONS · DATA © OPENSTREETMAP · WIKIDATA');
});

t('creditLine: no photo, no info at all -> the data line alone', () => {
	assert.equal(creditLine({ photo: null }), 'DATA © OPENSTREETMAP · WIKIDATA');
	assert.equal(creditLine(null), 'DATA © OPENSTREETMAP · WIKIDATA');
});

t('creditLine: the same words as the DATA screen (creditOf + DATA_CREDIT)', () => {
	for (const photo of [
		{ artist: 'Camille Gévaudan', license: 'CC BY-SA 3.0' },
		{ artist: '', license: null },
		{ artist: 'x', license: 'cc0' },
	]) {
		assert.equal(creditLine({ photo }), `${creditOf({ photo }).text} · ${DATA_CREDIT}`);
	}
	assert.equal(creditLine(null), DATA_CREDIT);
});

t('MACHINE_NAMES: the swarm flight (family swarmNode) is THE SWARM', () => {
	assert.equal(MACHINE_NAMES.swarmNode, 'THE SWARM');
	assert.equal(MACHINE_NAMES.swarmNode, MACHINE_NAMES.swarm);
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

t('takeoffNotice: the scan while it runs, then the count', () => {
	assert.equal(takeoffNotice({ loading: true, done: 2, total: 7, count: 0 }), '[*] SIGNAL SCAN · 2/7');
	assert.equal(takeoffNotice({ loading: false, done: 7, total: 7, count: 49 }), '[+] 49 SIGNALS IN RANGE');
	assert.equal(takeoffNotice({ loading: false, count: 1 }), '[+] 1 SIGNAL IN RANGE');
	assert.equal(takeoffNotice({ loading: false, count: 0 }), 'NO SIGNAL IN RANGE');
});

t('clearanceNotice: the machines and the tier each step opens', () => {
	assert.equal(clearanceNotice(1), '[+] CLEARANCE 1 · CINEWHOOP · TOOTHPICK · TIER II');
	assert.equal(clearanceNotice(2), '[+] CLEARANCE 2 · 5" RACE · LONG RANGE · HEAVY 5" · TIER III');
	assert.equal(clearanceNotice(3), '[+] CLEARANCE 3 · THE SWARM');
	assert.equal(clearanceNotice(0), null);
	assert.equal(clearanceNotice(9), null);
});

console.log(`\n${n} signal-card tests OK`);
