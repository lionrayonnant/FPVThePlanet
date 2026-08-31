// Selftest de la logique pure du GLOBAL SCANNER (PHASE 03). Aucune E/S, aucun
// DOM. Lancer : node tools/scanner-selftest.mjs
import assert from 'node:assert/strict';
import {
	slugify, signalDensity, areaAnalysis, coverageLine, prunedBands, sourceChoices, chosenSource,
	acquisitionProgress, pipelineBars, pipelineStats, phaseLabel, bytes, duration, elapsed, bar, designationFrom,
	latticeEdges, tileGrid, intersectBox, polygonGrid, maskOutline,
} from './scanner-model.mjs';
import { slugify as coreSlugify, parsePrepLine } from './lib/add-map-core.mjs';
import { tileGrid as estimatesTileGrid, estimateCost } from './lib/estimates.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('slugify : identique à celui du pipeline', () => {
	const cases = ['Tokyo', 'Île de la Cité', 'Sacré-Cœur !!', '  Reims  ', 'Ærø', 'Łódź', 'Tromsø', '***', 'A1 — B2'];
	for (const c of cases) assert.equal(slugify(c), coreSlugify(c), `slug de « ${c} »`);
});

t('designationFrom : nom court, pas le display_name complet', () => {
	assert.equal(designationFrom({ name: 'Tokyo', display_name: 'Tokyo, Japan' }), 'Tokyo');
	assert.equal(designationFrom({ display_name: 'Sector 07, Tokyo, Japan' }), 'Sector 07');
	assert.equal(designationFrom(null), '');
});

// La grille est celle du pipeline : tileGrid vient de tiles.mjs, ré-exporté par
// estimates.mjs. Si les deux divergent un jour, la carte mentira.
t('tileGrid : une seule implémentation partagée', () => {
	const box = { south: 48.85, west: 2.29, north: 48.86, east: 2.31 };
	assert.deepEqual(tileGrid(box, 20), estimatesTileGrid(box, 20));
});

t('latticeEdges : un bord par tuile, bornes comprises, latitudes non équidistantes', () => {
	const box = { south: 48.85, west: 2.29, north: 48.86, east: 2.31 };
	const grid = tileGrid(box, 20);
	const { lons, lats } = latticeEdges(grid, 20);
	assert.equal(lons.length, grid.cols + 1);
	assert.equal(lats.length, grid.rows + 1);
	// Les bords extrêmes sont exactement la bbox alignée sur les tuiles.
	assert.ok(Math.abs(lons[0] - grid.snapped.west) < 1e-12);
	assert.ok(Math.abs(lons.at(-1) - grid.snapped.east) < 1e-12);
	assert.ok(Math.abs(lats[0] - grid.snapped.south) < 1e-12);
	assert.ok(Math.abs(lats.at(-1) - grid.snapped.north) < 1e-12);
	for (let i = 1; i < lats.length; i++) assert.ok(lats[i] > lats[i - 1], 'latitudes croissantes');
	// Mercator : les rangées rétrécissent vers le nord. L'écart est petit mais
	// réel — c'est précisément ce que l'interpolation linéaire perdait.
	const first = lats[1] - lats[0], last = lats.at(-1) - lats.at(-2);
	assert.ok(last < first, 'les rangées ne sont pas équidistantes');
});

t('intersectBox', () => {
	const a = { south: 0, west: 0, north: 10, east: 10 };
	assert.deepEqual(intersectBox(a, { south: 5, west: 5, north: 20, east: 20 }), { south: 5, west: 5, north: 10, east: 10 });
	assert.equal(intersectBox(a, { south: 20, west: 20, north: 30, east: 30 }), null);
	assert.equal(intersectBox(a, { south: 10, west: 0, north: 20, east: 10 }), null, 'contact bord à bord = pas d\'intersection');
});

t('prunedBands : élagage = intersection de rectangles', () => {
	const scan = { south: 0, west: 0, north: 10, east: 10 };
	// Emprise inconnue (vieux trigger sans meta_region) : on ne grise rien.
	assert.equal(prunedBands({ scan, coverage: { ok: false } }), null);
	// Emprise plus large que la zone : rien d'élagué.
	assert.equal(prunedBands({ scan, coverage: { ok: true, south: -1, west: -1, north: 11, east: 11 } }), null);
	// Emprise disjointe : tout est hors couverture.
	const out = prunedBands({ scan, coverage: { ok: true, south: 20, west: 20, north: 30, east: 30 } });
	assert.equal(out.full, true);
	assert.deepEqual(out.bands, [scan]);
	// Coin sud-ouest couvert : deux bandes, nord puis est, sans recouvrement.
	const part = prunedBands({ scan, coverage: { ok: true, south: -5, west: -5, north: 6, east: 4 } });
	assert.equal(part.full, false);
	assert.deepEqual(part.bands, [
		{ south: 6, north: 10, west: 0, east: 10 },
		{ south: 0, north: 6, west: 4, east: 10 },
	]);
	const area = part.bands.reduce((s, b) => s + (b.north - b.south) * (b.east - b.west), 0);
	assert.equal(area, 100 - 6 * 4, 'les bandes couvrent exactement le complément');
});

t('signalDensity : ancrée sur la catégorie OSM, pas sur un tirage', () => {
	const city = signalDensity({ place: { addresstype: 'city', category: 'boundary', type: 'administrative' }, areaKm2: 2 });
	const farm = signalDensity({ place: { addresstype: 'farmland', category: 'landuse', type: 'farmland' }, areaKm2: 2 });
	assert.equal(city.label, 'HIGH');
	assert.equal(farm.label, 'LOW');
	assert.ok(city.range[0] > farm.range[1]);
	assert.equal(city.known, true);
	assert.equal(city.source, 'CITY');
	// Deux appels identiques donnent le même chiffre : aucune part d'aléatoire.
	assert.deepEqual(signalDensity({ place: { addresstype: 'city', category: 'boundary', type: 'administrative' }, areaKm2: 2 }), city);
});

// Nominatim jsonv2 rend `category` là où format=json rendait `class`, et rend
// « boundary/administrative » pour Tokyo comme pour un hameau : c'est
// `addresstype` qui porte l'information utile. Les deux formes sont acceptées.
t('signalDensity : addresstype prime sur category, class encore accepté', () => {
	const tokyo = signalDensity({ place: { addresstype: 'city', category: 'boundary', type: 'administrative' }, areaKm2: 1 });
	const hamlet = signalDensity({ place: { addresstype: 'hamlet', category: 'boundary', type: 'administrative' }, areaKm2: 1 });
	assert.ok(tokyo.perKm2 > hamlet.perKm2, 'deux « boundary/administrative » se distinguent quand même');
	assert.equal(signalDensity({ place: { class: 'building', type: 'yes' }, areaKm2: 1 }).perKm2, 34);
	assert.equal(signalDensity({ place: { category: 'landuse', type: 'residential' }, areaKm2: 1 }).perKm2, 28);
});

t('signalDensity : sans réponse Nominatim on le dit', () => {
	const s = signalDensity({ place: null, areaKm2: 1 });
	assert.equal(s.known, false);
	assert.equal(s.source, 'UNSURVEYED');
	assert.equal(s.perKm2, 8);
	// Catégorie inconnue du barème : « on ne sait pas » aussi, pas un 0 silencieux.
	assert.equal(signalDensity({ place: { addresstype: 'quarry', category: 'landuse', type: 'quarry' }, areaKm2: 1 }).known, false);
	assert.equal(signalDensity({ place: null, areaKm2: 0 }).targets, '—');
});

t('signalDensity : sans zone dessinée, rien à annoncer', () => {
	const idle = signalDensity({ place: { addresstype: 'city' }, areaKm2: 0 });
	assert.equal(idle.label, '—');
	assert.equal(idle.targets, '—');
	assert.equal(idle.bar, '░░░░░░░░░░');
	assert.deepEqual(idle.range, [0, 0]);
});

t('signalDensity : croît avec la surface, jamais négatif', () => {
	const small = signalDensity({ place: { addresstype: 'town' }, areaKm2: 0.5 });
	const big = signalDensity({ place: { addresstype: 'town' }, areaKm2: 5 });
	assert.ok(big.range[0] > small.range[0] && big.range[1] > small.range[1]);
	assert.ok(small.range[0] >= 0);
	// La barre ne dépend que de la densité, pas de la surface : une grande zone
	// de campagne reste une zone calme.
	assert.equal(small.bar, big.bar);
});

t('areaAnalysis : reprend les chiffres du serveur', () => {
	const d = {
		grid: { cols: 88, rows: 74, columns: 6512 },
		dimensions: { width: 1350, height: 1348, area: 1.82e6 },
		tileMeters: 25.3,
		estimate: {
			probes: 130240, prepBytes: 412e6, prepBytesRange: [200e6, 900e6],
			rawBytes: 300e6, totalSeconds: 740, warn: false,
		},
	};
	const a = areaAnalysis(d);
	assert.equal(a.tiles, '88 × 74');
	assert.equal(a.requests, '130,240');
	assert.equal(a.surface, '1.82 km²');
	assert.equal(a.data, '412 MB');
	assert.equal(a.time, '~12 MIN');
	assert.equal(a.tileSide, '25 m');
	assert.equal(a.heavy, false);
	assert.equal(areaAnalysis(null), null);
});

t('areaAnalysis : branché sur le vrai estimateCost', () => {
	const grid = tileGrid({ south: 48.85, west: 2.29, north: 48.865, east: 2.31 }, 20);
	const a = areaAnalysis({
		grid,
		dimensions: { width: 1465, height: 1668, area: 2.44e6 },
		tileMeters: 25.3,
		estimate: estimateCost({ columns: grid.columns, zoom: 20, altitude: 20 }),
	});
	assert.match(a.data, /MB|GB/);
	assert.notEqual(a.time, '—');
});

t('coverageLine : les trois états', () => {
	assert.equal(coverageLine({}).label, 'UNPROBED');
	assert.equal(coverageLine({ plan: { columns: 0, pruned: 6512, trigger: 'Paris' } }).status, 'none');
	assert.equal(coverageLine({ plan: { columns: 40, pruned: 12, trigger: 'Paris' } }).label, 'REGION FOUND');
	assert.match(coverageLine({ plan: { columns: 40, pruned: 12, trigger: 'Paris' } }).detail, /12 pruned/);
	assert.equal(coverageLine({ probe: { status: 'ok', message: 'x' } }).label, 'PHOTOGRAMMETRY CONFIRMED');
	assert.equal(coverageLine({ probe: { status: 'undecodable', message: 'x' } }).label, 'COVERED / UNREADABLE');
	// Le serveur répond en français (il sert aussi la GUI d'extraction) ; le jeu
	// est en anglais, et le détail est reconstruit depuis les compteurs mesurés.
	const ok = coverageLine({ probe: { status: 'ok', exported: 21, message: 'Couvert : 21 tuile(s) au centre de la zone.' } });
	assert.match(ok.detail, /^21 tiles came back/);
	assert.doesNotMatch(ok.detail, /tuile/);
	assert.match(coverageLine({ probe: { status: 'undecodable', undecodable: 4 } }).detail, /^4 tiles came back but/);
	assert.match(coverageLine({ probe: { status: 'none' } }).detail, /^Nothing came back/);
	// Statut inattendu : on retombe sur ce que le serveur a dit, plutôt que rien.
	assert.equal(coverageLine({ probe: { status: 'weird', message: 'boom' } }).detail, 'boom');
	// La sonde prime sur le plan : c'est la seule preuve réelle.
	assert.equal(coverageLine({ plan: { columns: 40, trigger: 'x' }, probe: { status: 'none', message: 'y' } }).status, 'none');
});

t('coverageLine : le verdict nomme le fournisseur qui a répondu', () => {
	// Avec deux fournisseurs inscrits (issue #18), « NO COVERAGE » sans nom ne
	// dit pas s'il faut changer de zone ou changer de source.
	const google = { id: 'google-earth', label: 'Google Earth' };
	const apple = { id: 'flyover', label: 'Apple Flyover' };
	assert.match(coverageLine({ probe: { status: 'ok', exported: 28 }, provider: google }).detail,
		/^28 tiles came back at the centre of the area\. Google Earth has real photogrammetry here\.$/);
	assert.match(coverageLine({ probe: { status: 'none' }, provider: apple }).detail,
		/Apple Flyover most likely has no photogrammetry here\./);
	assert.match(coverageLine({ provider: google }).detail, /^Google Earth only serves/);
	// Aucun fournisseur connu : la phrase reste grammaticale, sans inventer de nom.
	assert.match(coverageLine({ probe: { status: 'none' } }).detail, /The source most likely has no/);
	// Le format C3M est celui d'Apple : ce statut ne peut venir que de lui, la
	// phrase n'a donc pas à être paramétrée.
	assert.match(coverageLine({ probe: { status: 'undecodable', undecodable: 4 }, provider: apple }).detail, /C3M parser/);
});

t('coverageLine : une sonde en échec ne se déguise pas en absence de couverture', () => {
	// Constaté en vrai : sans flyover-reverse-engineering/config.json, la sonde
	// Apple plante — et l'écran annonçait « NO COVERAGE / rien n'est revenu »,
	// c'est-à-dire « change de zone » là où il fallait lire « répare ton
	// installation ». Les deux verdicts sont désormais distincts.
	const apple = { id: 'flyover', label: 'Apple Flyover' };
	const v = coverageLine({ probe: { status: 'error', message: 'panic: open ./config.json: no such file' }, provider: apple });
	assert.equal(v.status, 'error');
	assert.equal(v.label, 'SOURCE UNAVAILABLE');
	assert.match(v.detail, /^Apple Flyover could not be reached: panic: open \.\/config\.json/);
	assert.doesNotMatch(v.detail, /no photogrammetry here/);
	// Le message du serveur est ce qui aide : il n'est jamais avalé.
	assert.match(coverageLine({ probe: { status: 'error' } }).detail, /unknown error/);
	// Mais un panic Go rend sa stack goroutine entière : seule la première ligne
	// — la cause — entre dans le panneau, le reste vit dans le log serveur.
	const panic = coverageLine({ provider: apple, probe: { status: 'error',
		message: 'panic: open ./config.json: no such file or directory\n\ngoroutine 1 [running]:\nmain.main()\n\t/x/y.go:145 +0x21d1\nexit status 2' } });
	assert.equal(panic.detail, 'Apple Flyover could not be reached: panic: open ./config.json: no such file or directory');
	assert.doesNotMatch(panic.detail, /goroutine/);
	// Une ligne unique interminable est coupée plutôt que d'étirer le panneau.
	assert.ok(coverageLine({ probe: { status: 'error', message: 'x'.repeat(400) } }).detail.length < 220);
});

const REGISTRY = {
	// Le serveur liste Flyover en premier et désigne Google comme défaut : les
	// deux informations sont distinctes, et c'est le cas réel de /providers.
	providers: [{ id: 'flyover', label: 'Apple Flyover' }, { id: 'google-earth', label: 'Google Earth' }],
	default: 'google-earth',
};

t('sourceChoices : les deux sources, priorité #18 en tête, rien de choisi', () => {
	assert.deepEqual(sourceChoices(REGISTRY), [
		{ id: 'google-earth', label: 'Google Earth' },
		{ id: 'flyover', label: 'Apple Flyover' },
	]);
	// L'ordre d'affichage suit le défaut du registre, mais AFFICHER n'est pas
	// CHOISIR : rien n'est présélectionné, c'est chosenSource qui tranche.
	assert.equal(chosenSource(REGISTRY, null), null);
	assert.equal(chosenSource(REGISTRY, undefined), null);
	assert.deepEqual(chosenSource(REGISTRY, 'flyover'), { id: 'flyover', label: 'Apple Flyover' });
	assert.deepEqual(chosenSource(REGISTRY, 'google-earth'), { id: 'google-earth', label: 'Google Earth' });
	// Un id inconnu ne se rabat PAS en silence sur un autre fournisseur : sans
	// source valide, le scanner ferme la sonde plutôt que d'en deviner une.
	assert.equal(chosenSource(REGISTRY, 'inconnu'), null);
	// Registre absent ou vide (serveur injoignable) : aucune source à proposer.
	assert.deepEqual(sourceChoices(undefined), []);
	assert.deepEqual(sourceChoices({ providers: [] }), []);
	assert.equal(chosenSource(undefined, 'google-earth'), null);
	// Défaut annoncé mais pas inscrit : la liste reste celle du serveur.
	assert.deepEqual(sourceChoices({ providers: [{ id: 'flyover', label: 'Apple Flyover' }], default: 'absent' }),
		[{ id: 'flyover', label: 'Apple Flyover' }]);
	// Libellé manquant : on affiche l'id plutôt qu'un bouton vide.
	assert.deepEqual(sourceChoices({ providers: [{ id: 'x' }] }), [{ id: 'x', label: 'x' }]);
});

t('acquisitionProgress : honnête sur ce qu\'il sait', () => {
	assert.deepEqual(acquisitionProgress({ phase: 'download', hits: 500, expected: 1000 }),
		{ indeterminate: false, ratio: .5, text: '500 / ~1,000 TILES' });
	// Jamais 100 % tant que le téléchargement tourne, même si l'estimation est dépassée.
	assert.equal(acquisitionProgress({ phase: 'download', hits: 5000, expected: 1000 }).ratio, .99);
	assert.equal(acquisitionProgress({ phase: 'download', hits: 12, expected: 0 }).indeterminate, true);
	const prep = acquisitionProgress({ phase: 'prep', hits: 6000, expected: 1000 });
	assert.equal(prep.indeterminate, true);
	assert.equal(prep.text, '6,000 TILES');
});

t('formats', () => {
	assert.equal(bytes(412e6), '412 MB');
	assert.equal(bytes(0), '—');
	assert.equal(duration(10), '< 1 MIN');
	assert.equal(duration(740), '~12 MIN');
	assert.equal(duration(7400), '~2 H 3 MIN');
	assert.equal(elapsed(0), '0 S');
	assert.equal(elapsed(134_000), '2 MIN 14 S');
	assert.equal(bar(0, 4), '░░░░');
	assert.equal(bar(1, 4), '████');
	assert.equal(bar(.5, 4), '██░░');
	assert.equal(bar(2, 4), '████', 'clampé');
});

t('parsePrepLine : les jalons réels de prep.mjs (PHASE 05)', () => {
	assert.equal(parsePrepLine('parsing exp_model.mtl'), null);
	assert.deepEqual(parsePrepLine('142 materials, 3 without a texture'), { stat: { materials: 142, materialsNoTexture: 3 } });
	assert.deepEqual(parsePrepLine('-> 12 chunks of up to 32 layers'), { stat: { chunksPlanned: 12 } });
	assert.deepEqual(
		parsePrepLine('1,234,567 vertices, 234 uvs, 456,789 triangles'),
		{ phase: 'rebuild', stat: { vertices: 1234567, triangles: 456789 } },
	);
	assert.deepEqual(
		parsePrepLine('chunk 0: 12,000 verts, 4,000 tris, bbox 100 x 50 x 20 m, 3.4 MB'),
		{ stat: { chunksDone: 1, chunkBytes: 3400000 } },
	);
	assert.deepEqual(
		parsePrepLine('chunk0.tex0.jpg: 32 layers, 2.1 MB'),
		{ stat: { textureSheets: 1, textureBytes: 2100000 } },
	);
	assert.deepEqual(
		parsePrepLine('collision.bin: 100,000 verts, 33,000 tris, 5.2 MB'),
		{ stat: { collisionVerts: 100000, collisionTris: 33000, collisionBytes: 5200000 } },
	);
	assert.equal(parsePrepLine('geometry done'), null);
	assert.equal(parsePrepLine(''), null);
});

// toLocaleString() sans locale explicite suit l'ICU du runtime qui exécute
// prep.mjs, pas celui de la machine de dev : sur ce serveur ça groupe avec un
// espace fine insécable (U+202F), jamais une virgule. Vu et corrigé en testant
// une vraie acquisition (PHASE 05) — verrouillé ici pour ne pas régresser.
t('parsePrepLine : les grands nombres au format ICU (espace, pas virgule)', () => {
	assert.deepEqual(
		parsePrepLine('17 601 vertices, 17 601 uvs, 15 763 triangles'),
		{ phase: 'rebuild', stat: { vertices: 17601, triangles: 15763 } },
	);
	assert.deepEqual(
		parsePrepLine('collision.bin: 17 601 verts, 15 763 tris, 0.4 MB'),
		{ stat: { collisionVerts: 17601, collisionTris: 15763, collisionBytes: 400000 } },
	);
});

t('pipelineBars : FETCH et REBUILD ont un vrai ratio, DECODE reste indéterminé', () => {
	const fetching = pipelineBars({ phase: 'download', hits: 50, expected: 100, pipeline: {} });
	assert.equal(fetching.fetch.ratio, .5);
	assert.equal(fetching.decode.ratio, 0);
	assert.equal(fetching.rebuild.ratio, 0);

	const decoding = pipelineBars({ phase: 'decode', pipeline: {} });
	assert.equal(decoding.fetch.ratio, 1, 'FETCH est derrière, donc plein');
	assert.equal(decoding.decode.indeterminate, true, 'pas de jalon intermédiaire pour decode');

	const rebuilding = pipelineBars({ phase: 'rebuild', pipeline: { chunksPlanned: 10, chunksDone: 4 } });
	assert.equal(rebuilding.decode.ratio, 1);
	assert.equal(rebuilding.rebuild.ratio, .4);
	assert.equal(rebuilding.rebuild.indeterminate, false);

	// Sans compteur de chunks encore connu, REBUILD reste honnêtement indéterminé.
	assert.equal(pipelineBars({ phase: 'rebuild', pipeline: {} }).rebuild.indeterminate, true);

	// TERRAIN est un composite [0,1] qui progresse avec chaque étape.
	assert.ok(pipelineBars({ phase: 'download', hits: 0, expected: 100, pipeline: {} }).terrain.ratio
		< pipelineBars({ phase: 'rebuild', pipeline: { chunksPlanned: 10, chunksDone: 9 } }).terrain.ratio);
});

t('pipelineStats : n\'affiche que ce qui est déjà connu', () => {
	assert.deepEqual(pipelineStats(undefined), []);
	assert.deepEqual(pipelineStats({ materials: 42 }), [['MATERIALS', '42']]);
	const full = pipelineStats({
		materials: 42, materialsNoTexture: 2,
		vertices: 1_000_000, triangles: 500_000,
		chunksPlanned: 10, chunksDone: 3,
		textureSheets: 5, textureBytes: 12e6,
		collisionTris: 500_000, collisionBytes: 8e6,
	});
	assert.deepEqual(full, [
		['MATERIALS', '42 (2 untextured)'],
		['GEOMETRY', '1,000,000 verts, 500,000 tris'],
		['CHUNKS', '3 / 10'],
		['TEXTURES', '5 sheets, 12 MB'],
		['COLLISION', '500,000 tris, 8 MB'],
	]);
});

t('phaseLabel : les trois phases réelles', () => {
	assert.equal(phaseLabel('download'), 'FETCH');
	assert.equal(phaseLabel('decode'), 'DECODE');
	assert.equal(phaseLabel('rebuild'), 'REBUILD');
});

// Le SCANNER dessine la zone RÉELLEMENT retenue, pas le tracé lissé : sur un
// polygone c'est un escalier, et il vient du même masque que le coût annoncé.
t('maskOutline : le SCANNER a accès à l\'escalier via scanner-model', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	assert.ok(maskOutline(g, 20).length > 0);
	assert.ok(g.columns < g.cols * g.rows, 'un triangle masque des colonnes');
});

t('areaAnalysis : une réponse de polygone se lit comme une réponse de rectangle', () => {
	const TRI = [48.845, 2.295, 48.845, 2.305, 48.855, 2.295];
	const g = polygonGrid(TRI, 20);
	const a = areaAnalysis({
		grid: g,
		dimensions: { width: 730, height: 1112, area: 406175 },
		tileMeters: 25.4,
		estimate: {
			probes: g.columns * 20, tiles: 100, prepBytes: 5e6, prepBytesRange: [2e6, 9e6],
			rawBytes: 2e7, totalSeconds: 300, warn: false,
		},
	});
	assert.equal(a.columns, new Intl.NumberFormat('en-US').format(g.columns));
	// TILES doit dire ce qui est RÉELLEMENT balayé. Sur un tracé, « 30 × 45 »
	// (l'emprise) laisserait croire à 1350 tuiles quand on n'en demande que 732 —
	// et masquerait l'économie qui est toute la raison d'être du polygone.
	assert.equal(a.tiles, `${new Intl.NumberFormat('en-US').format(g.columns)} / ${new Intl.NumberFormat('en-US').format(g.cols * g.rows)}`);
	// L'aire vient du tracé : 0.41 km², pas les 0.81 de son emprise.
	assert.equal(a.surface, '0.41 km²');
});

console.log(`\n${n} vérifications, tout passe.`);
