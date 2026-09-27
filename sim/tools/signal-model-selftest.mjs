// Selftest of the signal model (issue #185, spec 2026-09-27-signals-design.md).
// No DOM, no network. Run: node tools/signal-model-selftest.mjs
import assert from 'node:assert/strict';
import {
	TILE_Z, MIN_QUERY_ZOOM, MAX_TILES_PER_VIEW, MODEL_VERSION,
	tileOf, tileKey, tileBounds, tilesForView, distanceM, tilesAround, overpassQuery,
	parseHeightM, signalFromElement, PER_TILE_CAP, capPerTile, parseOverpass,
	signalsInView, LABEL_ZOOM, declutter,
} from './signal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const EIFFEL = { lat: 48.8584, lon: 2.2945 };

t('constants from the plan, verbatim', () => {
	assert.equal(TILE_Z, 12);
	assert.equal(MIN_QUERY_ZOOM, 10);
	assert.equal(MAX_TILES_PER_VIEW, 16);
	assert.equal(MODEL_VERSION, 3);
});

t('tileOf: the z12 tile of the Eiffel Tower, computed independently', () => {
	// x = floor((lon+180)/360 * 4096) = floor(2074.107) = 2074
	// y = floor((1 - ln(tan φ + sec φ)/π)/2 * 4096) = 1409
	assert.deepEqual(tileOf(EIFFEL.lat, EIFFEL.lon), { x: 2074, y: 1409 });
});

t('tileKey is stable and carries the zoom', () => {
	assert.equal(tileKey({ x: 2074, y: 1409 }), 'z12/2074/1409');
});

t('tileBounds contains the point it came from, and n > s, e > w', () => {
	const b = tileBounds(tileOf(EIFFEL.lat, EIFFEL.lon));
	assert.ok(b.n > b.s && b.e > b.w);
	assert.ok(EIFFEL.lat >= b.s && EIFFEL.lat <= b.n, JSON.stringify(b));
	assert.ok(EIFFEL.lon >= b.w && EIFFEL.lon <= b.e, JSON.stringify(b));
	// 360 / 4096 degrees wide
	assert.ok(Math.abs((b.e - b.w) - 360 / 4096) < 1e-9);
});

t('tilesForView: null below MIN_QUERY_ZOOM', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	assert.equal(tilesForView(v, MIN_QUERY_ZOOM - 1), null);
});

t('tilesForView: a small view over Paris is one or a few tiles, deduped', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	const keys = tilesForView(v, 14);
	assert.ok(Array.isArray(keys) && keys.length >= 1 && keys.length <= 4, String(keys));
	assert.equal(new Set(keys).size, keys.length);
	assert.ok(keys.includes('z12/2074/1409'));
});

t('tilesForView: a wide view asks for the tiles nearest its centre, centre first, capped', () => {
	// Île-de-France at zoom 10: dozens of z12 tiles in view. The scanner must
	// still scan — the centre of the view, never the whole of it.
	const v = { s: 48.0, w: 1.0, n: 50.0, e: 4.0 };
	const keys = tilesForView(v, 10);
	assert.equal(keys.length, MAX_TILES_PER_VIEW);
	assert.equal(new Set(keys).size, keys.length);
	const c = tileOf(49.0, 2.5);
	assert.equal(keys[0], tileKey(c), 'the centre tile comes first');
	for (const k of keys) {
		const [, x, y] = k.split('/').map(Number);
		assert.ok(Math.abs(x - c.x) <= 2 && Math.abs(y - c.y) <= 2, k);
	}
});

t('tilesForView: every returned tile lies in the view', () => {
	// A thin horizontal strip: the nearest tiles must not spill above or below.
	const v = { s: 48.85, w: 1.0, n: 48.86, e: 4.0 };
	const lo = tileOf(48.86, 1.0).y, hi = tileOf(48.85, 4.0).y;
	for (const k of tilesForView(v, 10)) {
		const y = Number(k.split('/')[2]);
		assert.ok(y >= lo && y <= hi, k);
	}
});

t('tilesForView: a view across the antimeridian is handled, not inverted', () => {
	const keys = tilesForView({ s: -17.1, w: 179.95, n: -17.0, e: -179.95 }, 13);
	assert.ok(Array.isArray(keys) && keys.length >= 2 && keys.length <= 4, String(keys));
	assert.ok(keys.some((k) => k.startsWith('z12/4095/')));
	assert.ok(keys.some((k) => k.startsWith('z12/0/')));
});

t('overpassQuery: timeout, output cap, wikidata filter, the bbox in s,w,n,e order', () => {
	const q = overpassQuery({ s: 1, w: 2, n: 3, e: 4 });
	assert.match(q, /^\[out:json\]\[timeout:25\]\[maxsize:\d+\];/);
	assert.match(q, /\(1,2,3,4\)/);
	assert.match(q, /out tags center \d+;$/);
	assert.match(q, /out tags center 2000;$/);
	assert.doesNotMatch(q, /\["bridge"\]/);
	assert.match(q, /\["man_made"="bridge"\]/);
	// every clause requires a wikidata tag: the notability filter
	const clauses = q.match(/nwr\[[^;]*;|way\[[^;]*;/g);
	assert.ok(clauses.length >= 5);
	for (const c of clauses) assert.match(c, /\["wikidata"\]/, c);
});

t('overpassQuery: maxsize is a 64 MiB RAM budget, not an output cap (Tokyo ran out of memory at 4 MiB)', () => {
	const q = overpassQuery({ s: 1, w: 2, n: 3, e: 4 });
	assert.match(q, /\[maxsize:67108864\]/);
});

t('overpassQuery: worldwide clauses — temples/shrines, point-like natural features, waterfalls; no polygon natural areas', () => {
	const q = overpassQuery({ s: 1, w: 2, n: 3, e: 4 });
	assert.match(q, /\["building"~"\^\(cathedral\|church\|castle\|temple\|shrine\|mosque\|synagogue\|pagoda\|monastery\)\$"\]/);
	assert.match(q, /\["natural"~"\^\(peak\|volcano\|arch\|cave_entrance\|rock\|stone\|cliff\|geyser\|hot_spring\)\$"\]/);
	assert.match(q, /\["waterway"="waterfall"\]/);
	assert.doesNotMatch(q, /"natural"="water"/);
	assert.doesNotMatch(q, /nature_reserve/);
	assert.doesNotMatch(q, /national_park/);
	for (const c of q.match(/nwr\[[^;]*;/g)) assert.match(c, /\["wikidata"\]/, c);
});

const REIMS = {
	type: 'way', id: 43263447,
	center: { lat: 49.2536, lon: 4.0340 },
	tags: {
		building: 'cathedral', name: 'Cathédrale Notre-Dame de Reims',
		wikidata: 'Q191783', wikipedia: 'fr:Cathédrale Notre-Dame de Reims',
		start_date: '1211', height: '81', heritage: '1', 'heritage:operator': 'whc',
		wikimedia_commons: 'File:Reims Cathedral.jpg',
	},
};

t('parseHeightM: metres, "m" suffix, feet, garbage', () => {
	assert.equal(parseHeightM('81'), 81);
	assert.equal(parseHeightM('81 m'), 81);
	assert.equal(parseHeightM('81.5'), 81.5);
	assert.equal(Math.round(parseHeightM("265'")), 81);
	assert.equal(Math.round(parseHeightM('265 ft')), 81);
	assert.equal(parseHeightM('tall'), null);
	assert.equal(parseHeightM(undefined), null);
	assert.equal(parseHeightM('-3'), null);
});

t('signalFromElement: Reims cathedral, every field in order', () => {
	const s = signalFromElement(REIMS);
	assert.equal(s.id, 'wd:Q191783');
	assert.equal(s.osm, 'way/43263447');
	assert.equal(s.lat, 49.2536);
	assert.equal(s.lon, 4.0340);
	assert.equal(s.tile, tileKey(tileOf(49.2536, 4.0340)));
	assert.equal(s.name, 'CATHÉDRALE NOTRE-DAME DE REIMS');
	assert.equal(s.kind, 'CATHEDRAL');
	assert.equal(s.tier, 2, 'height 81 > 50 makes it tier II');
	assert.equal(s.heightM, 81);
	assert.equal(s.wikipedia, true);
	assert.equal(s.commons, 'File:Reims Cathedral.jpg');
	assert.deepEqual(s.fields.map((f) => [f.key, f.label, f.value]), [
		['name', 'NAME', 'CATHÉDRALE NOTRE-DAME DE REIMS'],
		['type', 'TYPE', 'CATHEDRAL'],
		['built', 'BUILT', '1211'],
		['height', 'HEIGHT', '81 M'],
		['status', 'STATUS', 'UNESCO WORLD HERITAGE'],
	]);
	for (const f of s.fields) assert.equal(f.source, 'osm');
});

t('signalFromElement: a node uses lat/lon, name:en wins over name', () => {
	const s = signalFromElement({
		type: 'node', id: 7, lat: 45.83, lon: 6.86,
		tags: { natural: 'peak', name: 'Mont Blanc', 'name:en': 'Mont Blanc', wikidata: 'Q583', ele: '4806' },
	});
	assert.equal(s.id, 'wd:Q583');
	assert.equal(s.osm, 'node/7');
	assert.equal(s.lat, 45.83);
	assert.equal(s.kind, 'PEAK');
	assert.equal(s.tier, 3);
});

t('tiers: I by default, II for towers / lighthouses / height > 50, III for peak, dam, bridge', () => {
	const tier = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', ...tags } }).tier;
	assert.equal(tier({ historic: 'castle' }), 1);
	assert.equal(tier({ historic: 'castle', height: '50' }), 1, '50 is not > 50');
	assert.equal(tier({ historic: 'castle', height: '51' }), 2);
	assert.equal(tier({ man_made: 'tower' }), 2);
	assert.equal(tier({ man_made: 'lighthouse' }), 2);
	assert.equal(tier({ natural: 'peak' }), 3);
	assert.equal(tier({ man_made: 'dam' }), 3);
	assert.equal(tier({ man_made: 'bridge' }), 3);
	assert.equal(tier({ bridge: 'yes', railway: 'rail' }), 1, 'a railway on a viaduct is not a bridge landmark');
	assert.equal(tier({ natural: 'volcano' }), 3);
	assert.equal(tier({ waterway: 'waterfall' }), 2);
	assert.equal(tier({ natural: 'cliff' }), 2);
	assert.equal(tier({ natural: 'arch' }), 2);
});

t('kindOf: waterfalls and natural point features get their own TYPE', () => {
	const kind = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', ...tags } }).kind;
	assert.equal(kind({ waterway: 'waterfall' }), 'WATERFALL');
	assert.equal(kind({ natural: 'cave_entrance' }), 'CAVE ENTRANCE');
	assert.equal(kind({ natural: 'hot_spring' }), 'HOT SPRING');
	assert.equal(kind({ natural: 'volcano' }), 'VOLCANO');
});

t('a Skógafoss-like waterfall node: kind WATERFALL, tier II', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 63.53, lon: -19.51, tags: { name: 'Skógafoss', wikidata: 'Q1533657', waterway: 'waterfall' } });
	assert.equal(s.kind, 'WATERFALL');
	assert.equal(s.tier, 2);
});

t('a Kyoto-like temple way outranks a plain historic=memorial node', () => {
	const temple = { type: 'way', id: 1, center: { lat: 34.98, lon: 135.78 }, tags: {
		name: 'Kiyomizu-dera', wikidata: 'Q1067252', building: 'temple', tourism: 'attraction', wikipedia: 'en:x',
	} };
	const memorial = { type: 'node', id: 2, lat: 34.98, lon: 135.78, tags: { name: 'Plaque', wikidata: 'Q2', historic: 'memorial' } };
	const out = parseOverpass({ elements: [memorial, temple] });
	assert.equal(out[0].id, 'wd:Q1067252');
});

t('CJK name survives clean() intact: uppercasing a script with no case leaves it unchanged', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: '阿弥陀ヶ峰', wikidata: 'Q1', natural: 'peak' } });
	assert.equal(s.name, '阿弥陀ヶ峰');
});

t('status: UNESCO only for heritage:operator=whc, PROTECTED for other heritage, absent otherwise', () => {
	const st = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'monument', ...tags } })
		.fields.find((f) => f.key === 'status')?.value ?? null;
	assert.equal(st({ heritage: '1', 'heritage:operator': 'whc' }), 'UNESCO WORLD HERITAGE');
	assert.equal(st({ heritage: '2' }), 'PROTECTED');
	assert.equal(st({}), null);
});

t('architect field appears when tagged, after height', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', man_made: 'tower', height: '300', architect: 'Gustave Eiffel' } });
	assert.deepEqual(s.fields.map((f) => f.key), ['name', 'type', 'height', 'architect']);
	assert.equal(s.fields[3].value, 'GUSTAVE EIFFEL');
});

t('signalFromElement rejects what cannot be a signal', () => {
	assert.equal(signalFromElement(null), null);
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { wikidata: 'Q1', historic: 'x' } }), null, 'no name');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', historic: 'x' } }), null, 'no wikidata');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1;Q2', historic: 'x' } }), null, 'not a single Q-id');
	assert.equal(signalFromElement({ type: 'way', id: 1, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'no position');
	assert.equal(signalFromElement({ type: 'node', id: 1, lat: 'a', lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'NaN lat');
	assert.equal(signalFromElement({ type: 'bogus', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x' } }), null, 'unknown type');
});

t('text is sanitised: control chars stripped, length capped, markup kept inert as text', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: {
		name: '<img src=x onerror=alert(1)>\u0000\u001b' + 'A'.repeat(200), wikidata: 'Q1', historic: 'x',
	} });
	assert.ok(!/[\u0000-\u001f]/.test(s.name));
	assert.ok(s.name.length <= 60, String(s.name.length));
	// Not escaped here — it is rendered with textContent / fillText, never innerHTML.
	assert.ok(s.name.startsWith('<IMG'));
});

t('commons: only a Commons file name is kept; image= is accepted only when it points at Commons', () => {
	const c = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x', ...tags } }).commons;
	assert.equal(c({ wikimedia_commons: 'File:A b.jpg' }), 'File:A b.jpg');
	assert.equal(c({ wikimedia_commons: 'Category:Stuff' }), null);
	assert.equal(c({ image: 'https://commons.wikimedia.org/wiki/File:C_d.jpg' }), 'File:C d.jpg');
	assert.equal(c({ image: 'https://example.com/x.jpg' }), null);
	assert.equal(c({}), null);
});

t('clean caps by code points, not UTF-16 units: an astral character stays whole', () => {
	const s = signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: {
		name: 'A'.repeat(59) + '🏰' + 'B', wikidata: 'Q1', historic: 'x',
	} });
	assert.doesNotMatch(s.name, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no lone surrogate');
	assert.ok(s.name.includes('🏰'), 'the castle is kept whole');
});

t('commons: a malformed percent-encoding in image= does not throw, just returns null', () => {
	const c = (tags) => signalFromElement({ type: 'node', id: 1, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q1', historic: 'x', ...tags } }).commons;
	assert.equal(c({ image: 'https://commons.wikimedia.org/wiki/File:100%_x.jpg' }), null);
});

t('parseOverpass: an element that throws while being parsed is dropped, never the whole tile', () => {
	const bad = new Proxy({ type: 'node', id: 9, lat: 0, lon: 0, tags: { name: 'X', wikidata: 'Q9', historic: 'x' } }, {
		get(t, k) { if (k === 'tags') throw new Error('boom'); return t[k]; },
	});
	const out = parseOverpass({ elements: [bad, REIMS] });
	assert.equal(out.length, 1);
	assert.equal(out[0].id, 'wd:Q191783');
});

t('capPerTile: keeps the best-ranked per tile, id breaks ties', () => {
	const mk = (id, tile, rank) => ({ id, tile, rank });
	const list = [mk('a', 'T1', 1000), mk('b', 'T1', 1500), mk('c', 'T1', 3000), mk('d', 'T1', 1500), mk('e', 'T2', 1000)];
	const kept = capPerTile(list, 2);
	assert.deepEqual(kept.filter((s) => s.tile === 'T1').map((s) => s.id), ['c', 'b']);
	assert.deepEqual(kept.filter((s) => s.tile === 'T2').map((s) => s.id), ['e']);
	assert.equal(PER_TILE_CAP, 60);
});

t('parseOverpass: one signal per Wikidata id, drops junk, survives a malformed body', () => {
	const json = { elements: [REIMS, REIMS, { type: 'node', id: 2 }, null, 'x'] };
	const out = parseOverpass(json);
	assert.equal(out.length, 1);
	assert.equal(out[0].id, 'wd:Q191783');
	assert.deepEqual(parseOverpass(null), []);
	assert.deepEqual(parseOverpass({ elements: 'nope' }), []);
});

// Trimmed from the real Overpass answer for the Reims z12 tile (2026-09-27,
// 86 elements). The cathedral is there twice — a node tagged
// archaeological_site and the building way — and a statue and a boundary
// stone sit next to the palace and the basilica. The ranking must put the
// three monuments first and keep the cathedral's BUILDING.
const REIMS_TILE = [
	{ type: 'node', id: 1071213823, lat: 49.2570619, lon: 4.0341304, tags: { name: "Jeanne d'Arc", wikidata: 'Q2963048', wikipedia: 'fr:Chevauchée vers Reims', historic: 'memorial' } },
	{ type: 'node', id: 4253229600, lat: 49.2512625, lon: 3.9849493, tags: { name: 'Borne Vauthier', wikidata: 'Q2495007', wikipedia: 'fr:Bornes Vauthier', historic: 'memorial' } },
	{ type: 'node', id: 7388163831, lat: 49.2535616, lon: 4.033298, tags: { name: 'Cathédrale de Reims', wikidata: 'Q206823', wikipedia: 'fr:Cathédrale Notre-Dame de Reims', historic: 'archaeological_site' } },
	{ type: 'way', id: 92294792, center: { lat: 49.2537686, lon: 4.033823 }, tags: { name: 'Cathédrale Notre-Dame', wikidata: 'Q206823', wikipedia: 'fr:Cathédrale Notre-Dame de Reims', building: 'cathedral', tourism: 'attraction', heritage: '2' } },
	{ type: 'way', id: 92296301, center: { lat: 49.2532652, lon: 4.0343524 }, tags: { name: 'Palais du Tau', wikidata: 'Q578771', wikipedia: 'fr:Palais du Tau (Reims)', building: 'yes', historic: 'palace', tourism: 'museum' } },
	{ type: 'way', id: 92309276, center: { lat: 49.243071, lon: 4.0418455 }, tags: { name: 'Basilique Saint-Remi', wikidata: 'Q334233', wikipedia: 'fr:Basilique Saint-Remi de Reims', building: 'church', tourism: 'attraction', heritage: '2' } },
];

t('real Reims tile: the monuments outrank the statue and the stone, the cathedral keeps its building', () => {
	const out = parseOverpass({ elements: REIMS_TILE });
	assert.equal(out.length, 5, 'the cathedral node and way are one signal');
	assert.deepEqual(out.slice(0, 3).map((s) => s.id), ['wd:Q206823', 'wd:Q334233', 'wd:Q578771']);
	const cathedral = out[0];
	assert.equal(cathedral.osm, 'way/92294792');
	assert.equal(cathedral.kind, 'CATHEDRAL');
	assert.equal(cathedral.name, 'CATHÉDRALE NOTRE-DAME');
	for (const s of out.slice(3)) assert.equal(s.kind, 'MEMORIAL');
});

t('a tier III bridge does not outrank a cathedral: tier is difficulty, not notability', () => {
	const cathedral = { type: 'way', id: 1, center: { lat: 49.25, lon: 4.03 }, tags: {
		name: 'Cathedral', wikidata: 'Q1', building: 'cathedral', tourism: 'attraction', heritage: '1',
		wikipedia: 'fr:x',
	} };
	const bridge = { type: 'way', id: 2, center: { lat: 49.25, lon: 4.03 }, tags: {
		name: 'Bridge', wikidata: 'Q2', man_made: 'bridge', wikipedia: 'fr:y',
	} };
	const out = parseOverpass({ elements: [bridge, cathedral] });
	assert.equal(out[0].id, 'wd:Q1');
	assert.equal(signalFromElement(bridge).tier, 3);
});

t('declutter: one point per screen cell, the best-ranked wins, deterministic', () => {
	const p = (id, x, y, rank) => ({ s: { id, rank }, x, y });
	const pts = [p('a', 10, 10, 100), p('b', 12, 11, 500), p('c', 60, 10, 50), p('d', 11, 12, 500)];
	const kept = declutter(pts, 24).map((q) => q.s.id).sort();
	assert.deepEqual(kept, ['b', 'c'], 'b and d tie on rank: the smaller id wins');
	assert.deepEqual(declutter([], 24), []);
});

t('signalsInView: bbox filter, antimeridian-aware', () => {
	const s = (id, lat, lon) => ({ id, lat, lon });
	const list = [s('a', 48.86, 2.29), s('b', 10, 10), s('c', -17, 179.99), s('d', -17, -179.99)];
	assert.deepEqual(signalsInView(list, { minLat: 48, maxLat: 49, minLon: 2, maxLon: 3 }).map((x) => x.id), ['a']);
	assert.deepEqual(signalsInView(list, { minLat: -18, maxLat: -16, minLon: 179.9, maxLon: -179.9 }).map((x) => x.id), ['c', 'd']);
	assert.equal(LABEL_ZOOM, 15);
});

t('distanceM: Eiffel Tower to Notre-Dame is ~4.1 km', () => {
	const d = distanceM({ lat: 48.8584, lon: 2.2945 }, { lat: 48.8530, lon: 2.3499 });
	assert.ok(Math.abs(d - 4090) < 60, String(d));
});

// The nearest point of a tile to p, antimeridian-aware: the tile's longitude
// span is shifted to its copy nearest p before clamping (mirrors the fix in
// tilesAround itself — a bare clamp picks the far side of the date line).
function nearestPointOf(b, p) {
	let w = b.w, e = b.e;
	if (w - p.lon > 180) { w -= 360; e -= 360; }
	else if (p.lon - e > 180) { w += 360; e += 360; }
	return { lat: Math.max(b.s, Math.min(b.n, p.lat)), lon: Math.max(w, Math.min(e, p.lon)) };
}

t('tilesAround: own tile first, every tile within the radius, none farther', () => {
	const p = { lat: 48.8584, lon: 2.2945 };
	const keys = tilesAround(p.lat, p.lon, 1500);
	assert.equal(keys[0], tileKey(tileOf(p.lat, p.lon)));
	assert.equal(new Set(keys).size, keys.length);
	assert.ok(keys.length >= 1 && keys.length <= 9, String(keys.length));
	for (const k of keys) {
		const [, x, y] = k.split('/').map(Number);
		const b = tileBounds({ x, y });
		const near = nearestPointOf(b, p);
		assert.ok(distanceM(p, near) <= 1500 + 1, k);
	}
	assert.deepEqual(tilesAround(p.lat, p.lon, 0), [tileKey(tileOf(p.lat, p.lon))]);
});

t('tilesAround: sees across the antimeridian', () => {
	const p = { lat: -17, lon: 179.99 };
	const keys = tilesAround(p.lat, p.lon, 1500);
	assert.ok(keys.some((k) => k.startsWith('z12/0/')), String(keys));
	for (const k of keys) {
		const [, x, y] = k.split('/').map(Number);
		const b = tileBounds({ x, y });
		const near = nearestPointOf(b, p);
		assert.ok(distanceM(p, near) <= 1500 + 1, k);
	}
});

console.log(`signal-model: ${n} ok`);
