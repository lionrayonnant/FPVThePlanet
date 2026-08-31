// Génère testdata/poly-cases.json depuis le port JS de la géométrie de polygone.
// Lancer : node tools/gen-poly-fixture.mjs
//
// Le sens de la manœuvre : le port JS est validé le premier, contre des cas
// raisonnés à la main dans map-poly-selftest.mjs. La fixture fige ensuite ce
// port validé, et pkg/mth/poly_test.go y conforme le Go. La fixture n'est donc
// pas « la vérité » — elle est le procès-verbal d'un port déjà vérifié, et elle
// existe pour que la dérive entre les deux se voie tout de suite plutôt qu'en
// re-téléchargeant plusieurs gigaoctets.
//
// Ne pas régénérer pour faire taire un test qui échoue : si le Go et le JS ne
// disent plus la même chose, l'un des deux a un bug.
import fs from 'node:fs';
import path from 'node:path';
import { polygonBounds, polygonGrid, maskKeys, polygonArea, canonicalPoly, polyHash } from './lib/tiles.mjs';
import { FLYOVER_ROOT } from './lib/providers/flyover.mjs';

const CASES = [
	{ name: 'carré', zoom: 20, ring: [48.845, 2.295, 48.845, 2.305, 48.855, 2.305, 48.855, 2.295] },
	{ name: 'triangle rectangle', zoom: 20, ring: [48.845, 2.295, 48.845, 2.305, 48.855, 2.295] },
	{ name: 'L (centroïde hors du tracé)', zoom: 20,
	  ring: [48.840, 2.280, 48.840, 2.320, 48.850, 2.320, 48.850, 2.290, 48.870, 2.290, 48.870, 2.280] },
	{ name: 'corridor plus fin qu\'une tuile', zoom: 20,
	  ring: [48.8500, 2.2950, 48.8500, 2.3050, 48.85002, 2.3050, 48.85002, 2.2950] },
	{ name: 'corridor en diagonale', zoom: 20,
	  ring: [48.8500, 2.2950, 48.8505, 2.2950, 48.8560, 2.3050, 48.8555, 2.3050] },
	{ name: 'concave en U', zoom: 19,
	  ring: [48.840, 2.280, 48.840, 2.320, 48.845, 2.320, 48.845, 2.290, 48.860, 2.290, 48.860, 2.320, 48.865, 2.320, 48.865, 2.280] },
	{ name: 'sens horaire', zoom: 20, ring: [48.845, 2.295, 48.855, 2.295, 48.855, 2.305, 48.845, 2.305] },
	{ name: 'hémisphère sud', zoom: 20, ring: [-33.870, 151.200, -33.870, 151.215, -33.860, 151.215] },
	{ name: 'longitude négative', zoom: 20, ring: [34.050, -118.250, 34.050, -118.235, 34.060, -118.235] },
	{ name: 'zoom bas', zoom: 16, ring: [48.82, 2.26, 48.82, 2.40, 48.90, 2.40, 48.90, 2.26] },
];

const out = [];
for (const c of CASES) {
	const grid = polygonGrid(c.ring, c.zoom);
	out.push({
		name: c.name, ring: c.ring, zoom: c.zoom,
		bounds: polygonBounds(c.ring),
		grid: { xMin: grid.xMin, xMax: grid.xMax, yMin: grid.yMin, yMax: grid.yMax, cols: grid.cols, rows: grid.rows },
		columns: grid.columns,
		masked: grid.masked,
		keys: maskKeys(grid),
		areaM2: polygonArea(c.ring),
		canonical: canonicalPoly(c.ring),
		hash: await polyHash(c.ring),
	});
}

const dest = path.join(FLYOVER_ROOT, 'testdata/poly-cases.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, '\t') + '\n');
console.log(`${out.length} cas écrits dans ${dest}`);
for (const c of out) console.log(`  ${String(c.columns).padStart(6)} col. / ${String(c.columns + c.masked).padStart(6)} — ${c.name}`);
