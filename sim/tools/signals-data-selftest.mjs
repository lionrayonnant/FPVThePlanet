// Selftest of the SIGNALS section's pure half (issue #185, lot 3 task 9):
// grouping by place, the rows of a place, a capture's key/value rows and its
// credit. No DOM, no network. Run: node tools/signals-data-selftest.mjs
import assert from 'node:assert/strict';
import {
	ELSEWHERE, KNOWN_RADIUS_M, MAX_KNOWN_ROWS, DATA_CREDIT,
	buildSignals, listRows, detailRows, creditOf, sessionLabel, clearanceFor,
} from './signals-data-model.mjs';
import { scramble } from './signal-callout-model.mjs';
import { distanceM } from './signal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Local time, like the page: the operator reads their own clock.
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// ~1 km of latitude.
const KM = 1 / 111.195;

const PARIS = { lat: 48.8462, lon: 2.3464 };
const KYOTO = { lat: 35.0116, lon: 135.7681 };

const entry = (over) => ({
	at: at(2026, 9, 27), name: 'X', lat: PARIS.lat, lon: PARIS.lon, tier: 1,
	family: 'cinewhoop', holdS: 5, distM: 212, sessionId: null, photo: null, place: 'PARIS',
	...over,
});
const store = (entries) => ({ resolved: entries });
const sig = (id, dLatKm, tier = 1, name = 'SOMEWHERE', base = PARIS) =>
	({ id, name, lat: base.lat + dLatKm * KM, lon: base.lon, tier, kind: null, fields: [] });

t('empty store: nothing uplinked, no place, no known', () => {
	for (const s of [null, undefined, {}, store({})]) {
		const r = buildSignals({ store: s, known: [sig('wd:Q1', 0)] });
		assert.deepEqual(r, { uplinked: 0, knownCount: 0, places: [] });
	}
	assert.deepEqual(buildSignals({ store: null }), { uplinked: 0, knownCount: 0, places: [] });
});

t('grouping by place, sorted by uplinked count then name', () => {
	const r = buildSignals({
		store: store({
			'wd:Q1': entry({ name: 'PANTHÉON' }),
			'wd:Q2': entry({ name: 'EIFFEL TOWER' }),
			'wd:Q3': entry({ name: 'KINKAKU-JI', place: 'KYOTO', ...KYOTO }),
			'wd:Q4': entry({ name: 'X', place: 'BERN', lat: 46.948, lon: 7.447 }),
		}),
		known: [],
	});
	assert.equal(r.uplinked, 4);
	assert.deepEqual(r.places.map((p) => p.name), ['PARIS', 'BERN', 'KYOTO']);
	assert.deepEqual(r.places.map((p) => p.total), [2, 1, 1]);
	assert.equal(r.places[0].uplinked[0].id !== undefined, true, 'entries carry their id');
});

t('entries without a place go to ELSEWHERE', () => {
	const r = buildSignals({
		store: store({ 'wd:Q1': entry({ place: null }), 'wd:Q2': entry({ place: 'PARIS' }) }),
		known: [],
	});
	assert.deepEqual(r.places.map((p) => p.name).sort(), [ELSEWHERE, 'PARIS'].sort());
	assert.equal(r.places.find((p) => p.name === ELSEWHERE).uplinked[0].id, 'wd:Q1');
});

t('uplinked entries of a place: newest first', () => {
	const r = buildSignals({
		store: store({
			'wd:Q1': entry({ at: at(2026, 9, 25) }),
			'wd:Q2': entry({ at: at(2026, 9, 27) }),
			'wd:Q3': entry({ at: at(2026, 9, 26) }),
		}),
		known: [],
	});
	assert.deepEqual(r.places[0].uplinked.map((e) => e.id), ['wd:Q2', 'wd:Q3', 'wd:Q1']);
});

t('known: assigned to the nearest resolution\'s place, within 5 km, resolved ones excluded', () => {
	assert.equal(KNOWN_RADIUS_M, 5000);
	const r = buildSignals({
		store: store({
			'wd:Q1': entry({ place: 'PARIS' }),
			'wd:Q2': entry({ place: 'KYOTO', ...KYOTO }),
		}),
		known: [
			sig('wd:Q1', 0), // resolved: never "known"
			sig('wd:Q10', 2), // 2 km from the Paris entry
			sig('wd:Q11', 4.9),
			sig('wd:Q12', 5.2), // too far from anything
			sig('wd:Q13', 1, 2, 'X', KYOTO),
		],
	});
	const paris = r.places.find((p) => p.name === 'PARIS');
	const kyoto = r.places.find((p) => p.name === 'KYOTO');
	assert.deepEqual(paris.known.map((s) => s.id).sort(), ['wd:Q10', 'wd:Q11']);
	assert.deepEqual(kyoto.known.map((s) => s.id), ['wd:Q13']);
	assert.equal(paris.total, 3);
	assert.equal(r.knownCount, 3, 'only the assigned ones are counted');
});

t('known: the NEAREST resolution decides, even when another place is also within 5 km', () => {
	const r = buildSignals({
		store: store({
			'wd:Q1': entry({ place: 'PARIS' }),
			'wd:Q2': entry({ place: 'MONTROUGE', lat: PARIS.lat - 4 * KM }),
		}),
		known: [sig('wd:Q10', -3)], // 3 km from Paris, 1 km from Montrouge
	});
	assert.deepEqual(r.places.find((p) => p.name === 'MONTROUGE').known.map((s) => s.id), ['wd:Q10']);
	assert.deepEqual(r.places.find((p) => p.name === 'PARIS').known, []);
});

t('listRows: uplinked first (NAME / dd.mm  MACHINE), then known nearest first', () => {
	const r = buildSignals({
		store: store({
			'wd:Q1': entry({ name: 'Panthéon', at: at(2026, 9, 27), family: 'cinewhoop' }),
			'wd:Q2': entry({ name: 'Eiffel Tower', at: at(2026, 9, 26), family: 'freestyle5' }),
		}),
		known: [sig('wd:Q10', 2.7, 1, 'FAR'), sig('wd:Q11', 1.9, 2, 'NEAR')],
	});
	const rows = listRows(r.places[0], 3);
	assert.deepEqual(rows.map((x) => x.kind), ['uplinked', 'uplinked', 'known', 'known']);
	assert.deepEqual(rows[0], { kind: 'uplinked', id: 'wd:Q1', text: 'PANTHÉON', right: '27.09  CINEWHOOP' });
	assert.deepEqual(rows[1].right, '26.09  5" FREESTYLE');
	assert.equal(rows[2].id, 'wd:Q11');
	assert.equal(rows[2].right, '1.9 km  TIER II');
	assert.equal(rows[3].right, '2.7 km  TIER I');
});

t('listRows: the known name is scrambled, stable per id', () => {
	const r = buildSignals({
		store: store({ 'wd:Q1': entry({}) }),
		known: [sig('wd:Q10', 1, 1, 'NOTRE DAME')],
	});
	const a = listRows(r.places[0], 3).find((x) => x.id === 'wd:Q10');
	const b = listRows(r.places[0], 3).find((x) => x.id === 'wd:Q10');
	assert.equal(a.text, b.text);
	assert.equal(a.text, scramble('NOTRE DAME', 10));
	assert.ok(!a.text.includes('NOTRE'));
	assert.equal(a.text[5], ' ', 'the shape of the name survives');
});

t('listRows: locked when the tier is above the clearance', () => {
	assert.equal(clearanceFor(1), 0);
	assert.equal(clearanceFor(2), 1);
	assert.equal(clearanceFor(3), 2);
	const r = buildSignals({
		store: store({ 'wd:Q1': entry({}) }),
		known: [sig('wd:Q10', 1, 1), sig('wd:Q11', 2, 2), sig('wd:Q12', 3, 3)],
	});
	const at0 = listRows(r.places[0], 0).slice(1);
	assert.deepEqual(at0.map((x) => x.kind), ['known', 'locked', 'locked']);
	assert.deepEqual(at0.map((x) => x.right), ['1.0 km  TIER I', 'CLEARANCE 1', 'CLEARANCE 2']);
	const at1 = listRows(r.places[0], 1).slice(1);
	assert.deepEqual(at1.map((x) => x.kind), ['known', 'known', 'locked']);
	const at2 = listRows(r.places[0], 2).slice(1);
	assert.deepEqual(at2.map((x) => x.kind), ['known', 'known', 'known']);
});

t('listRows: known rows capped at 12, then a …N MORE row', () => {
	assert.equal(MAX_KNOWN_ROWS, 12);
	const known = Array.from({ length: 20 }, (_, i) => sig(`wd:Q${100 + i}`, 0.1 + i * 0.2));
	const r = buildSignals({ store: store({ 'wd:Q1': entry({}) }), known });
	const rows = listRows(r.places[0], 3);
	assert.equal(rows.length, 1 + 12 + 1);
	assert.deepEqual(rows.at(-1), { kind: 'more', id: null, text: '…8 MORE', right: '' });
	// Exactly 12: no MORE row.
	const r12 = buildSignals({ store: store({ 'wd:Q1': entry({}) }), known: known.slice(0, 12) });
	assert.equal(listRows(r12.places[0], 3).at(-1).kind, 'known');
});

t('listRows: distances under a kilometre read in metres', () => {
	const r = buildSignals({ store: store({ 'wd:Q1': entry({}) }), known: [sig('wd:Q10', 0.4)] });
	assert.equal(listRows(r.places[0], 3)[1].right, '400 m  TIER I');
	assert.deepEqual(listRows(null, 3), []);
});

t('sessionLabel: uppercased, dashes to spaces, null when none', () => {
	assert.equal(sessionLabel('live-quartier-des-invalides'), 'LIVE QUARTIER DES INVALIDES');
	assert.equal(sessionLabel(null), null);
});

t('detailRows: the capture, a spacer, then the landmark facts', () => {
	const e = {
		id: 'wd:Q188856', ...entry({ at: at(2026, 9, 27, 21, 14), family: 'cinewhoop', holdS: 5, distM: 211.6, sessionId: 'live-quartier-des-invalides' }),
	};
	const signal = { kind: 'MAUSOLEUM', fields: [{ key: 'status', value: 'PROTECTED' }] };
	const info = { description: 'x', year: 1758, heightM: 83, photo: null };
	assert.deepEqual(detailRows(e, signal, info), [
		['UPLINKED', '27.09.26 / 21:14'],
		['MACHINE', 'CINEWHOOP'],
		['HOLD', '5.0 s'],
		['RANGE', '212 m'],
		['SESSION', 'LIVE QUARTIER DES INVALIDES'],
		null,
		['TYPE', 'MAUSOLEUM'],
		['BUILT', '1758'],
		['HEIGHT', '83 m'],
		['STATUS', 'PROTECTED'],
	]);
});

t('detailRows: no session, no signal, no info — only what is known, no dangling spacer', () => {
	const e = { id: 'wd:Q1', ...entry({ at: at(2026, 1, 2, 3, 4), family: null, sessionId: null, holdS: 4.25, distM: 1500 }) };
	assert.deepEqual(detailRows(e, null, null), [
		['UPLINKED', '02.01.26 / 03:04'],
		['HOLD', '4.3 s'],
		['RANGE', '1.5 km'],
	]);
});

t('detailRows: an uplink from the swarm flight names THE SWARM, not SWARMNODE', () => {
	const e = { id: 'wd:Q2', ...entry({ at: at(2026, 1, 2, 3, 4), family: 'swarmNode', sessionId: null, holdS: 4, distM: 90 }) };
	assert.deepEqual(detailRows(e, null, null)[1], ['MACHINE', 'THE SWARM']);
});

t('detailRows: a trace flown reads TRACE SPIRAL · seconds instead of HOLD', () => {
	const e = { id: 'wd:Q3', ...entry({ at: at(2026, 1, 2, 3, 4), family: null, holdS: 38.24, distM: 90, trace: 'spiral' }) };
	assert.deepEqual(detailRows(e, null, null)[1], ['TRACE', 'SPIRAL · 38.2 s']);
	// Through the store: the shape survives fromStored().
	const s = buildSignals({ store: store({ 'wd:Q3': entry({ trace: 'dive', holdS: 12 }) }) });
	const up = s.places[0].uplinked[0];
	assert.equal(detailRows(up, null, null).find((r) => r?.[0] === 'HOLD'), undefined);
	assert.deepEqual(detailRows(up, null, null).find((r) => r?.[0] === 'TRACE'), ['TRACE', 'DIVE · 12.0 s']);
});

t('creditOf: author, licence, Commons, and the validated file page', () => {
	const photo = { url: 'https://upload.wikimedia.org/a.jpg', artist: 'Camille Gévaudan', license: 'CC BY-SA 3.0', page: 'https://commons.wikimedia.org/wiki/File:Pantheon.jpg' };
	assert.deepEqual(creditOf({ photo }), {
		text: '© CAMILLE GÉVAUDAN · CC BY-SA 3.0 · WIKIMEDIA COMMONS',
		href: 'https://commons.wikimedia.org/wiki/File:Pantheon.jpg',
	});
	assert.equal(DATA_CREDIT, 'DATA © OPENSTREETMAP · WIKIDATA');
});

t('creditOf: unknown author/licence spelt out; no photo, no credit', () => {
	assert.deepEqual(creditOf({ photo: { url: 'https://upload.wikimedia.org/a.jpg', artist: null, license: null, page: null } }),
		{ text: '© UNKNOWN · UNKNOWN · WIKIMEDIA COMMONS', href: null });
	assert.equal(creditOf(null), null);
	assert.equal(creditOf({ photo: null }), null);
});

t('creditOf: a link that is not a Commons file page is dropped', () => {
	const bad = [
		'javascript:alert(1)',
		'http://commons.wikimedia.org/wiki/File:A.jpg',
		'https://commons.wikimedia.org.evil.example/wiki/File:A.jpg',
		'https://commons.wikimedia.org/wiki/Special:Logout',
		'https://evil.example/https://commons.wikimedia.org/wiki/File:A.jpg',
		'https://user@commons.wikimedia.org/wiki/File:A.jpg',
		'https://commons.wikimedia.org/wiki/File:',
		42,
	];
	for (const page of bad) {
		assert.equal(creditOf({ photo: { artist: 'A', license: 'B', page } }).href, null, String(page));
	}
});

// The pre-box version, verbatim in intent: nearest entry by haversine over
// every entry, first in store order on a tie, kept within KNOWN_RADIUS_M.
function bruteAssign(entries, known) {
	const out = new Map();
	for (const s of known) {
		let best = null, bestD = Infinity;
		for (const e of entries) {
			const d = distanceM(e, s);
			if (d < bestD) { bestD = d; best = e; }
		}
		if (best && bestD <= KNOWN_RADIUS_M) out.set(s.id, best.place);
	}
	return out;
}

t('buildSignals: the lat/lon box prefilter changes no assignment', () => {
	let seed = 12345;
	const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
	// Clusters at the equator, mid-latitude, near a pole and across the
	// antimeridian, where a naive longitude box would be wrong.
	const centres = [{ lat: 0, lon: 10 }, PARIS, { lat: 89.97, lon: 40 }, { lat: -12, lon: 179.99 }, { lat: -12, lon: -179.99 }];
	const entries = {}, list = [];
	for (let i = 0; i < 300; i++) {
		const c = centres[i % centres.length];
		const id = `wd:Q${1000 + i}`;
		const e = entry({ lat: Math.min(90, c.lat + (rnd() - 0.5) * 0.12), lon: c.lon + (rnd() - 0.5) * (c.lat > 89 ? 60 : 0.12), place: `P${i % 17}`, at: i });
		entries[id] = e;
		list.push({ id, ...e });
	}
	const known = [];
	for (let i = 0; i < 600; i++) {
		const c = centres[i % centres.length];
		known.push({ id: `wd:Q${5000 + i}`, name: 'K', lat: Math.min(90, c.lat + (rnd() - 0.5) * 0.3), lon: c.lon + (rnd() - 0.5) * (c.lat > 89 ? 360 : 0.3), tier: 1, kind: null, fields: [] });
	}
	const r = buildSignals({ store: store(entries), known });
	const got = new Map();
	for (const p of r.places) for (const s of p.known) got.set(s.id, p.name);
	const want = bruteAssign(list, known);
	assert.ok(want.size > 100 && want.size < known.length, `a mix of claimed and unclaimed (${want.size})`);
	assert.equal(r.knownCount, want.size);
	assert.deepEqual([...got].sort(), [...want].sort());
});

console.log(`signals-data-selftest: ${n} ok`);
