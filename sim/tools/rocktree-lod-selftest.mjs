// Selftest du niveau de détail par anneaux (#22), sans réseau : un octree
// synthétique COMPLET (toutes les colonnes existent, digits horizontaux
// seulement) rend ce qu'une traversée rendrait à chaque niveau ; assembleLod()
// doit couvrir chaque point du disque EXACTEMENT une fois — ni trou à une
// couture, ni deux nœuds sur le même sol — y compris quand un anneau plus fin
// porte un fill-in peu profond qu'un anneau plus grossier raffine plus loin.
import assert from 'node:assert/strict';
import { LOD_RINGS, ringsFor, assembleLod, boxIntersectsDisc, boxInsideDisc, metersBetween } from './lib/rocktree/lod.mjs';
import { rootOctant, childBoxes } from './lib/rocktree/octant.mjs';
import { zoneOf } from './lib/rocktree/traverse.mjs';
import { boxIntersects } from './lib/rocktree/octant.mjs';

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

const CENTER = { lat: 48.8578, lon: 2.2950 };

// Tous les nœuds d'un octree complet jusqu'à `level` qui recoupent `zone`,
// digits 0-3 (bit vertical à 0), avec leur box — la forme que traverse()
// rend : tout nœud existant est retenu puis dropFillinAncestors() écarte ceux
// qui ont un descendant retenu. `holes` : chemins ABSENTS (et tout ce qui est
// dessous). Un nœud dont TOUS les enfants recoupant la zone sont absents
// reste donc retenu (fill-in) ; un nœud dont un seul enfant est absent est
// écarté au profit des autres, et l'absent est un vrai trou — exactement la
// sémantique de traverse() (Marseille, l'eau du Vieux-Port).
function syntheticTraverse(zone, level, { holes = new Set() } = {}) {
	const { path: rootPath, box: rootBox } = rootOctant(CENTER.lat, CENTER.lon);
	const out = [];
	const walk = (path, box) => {
		if (path.length === level) { out.push({ path, box, exclude: [] }); return; }
		const kids = childBoxes(box).filter((c) => c.key < 4 && boxIntersects(c.box, zone));
		const existing = kids.filter((c) => !holes.has(path + c.key));
		if (existing.length === 0) { out.push({ path, box, exclude: [], fillin: true }); return; }
		for (const c of existing) walk(path + c.key, c.box);
	};
	walk(rootPath, rootBox);
	const paths = new Set(out.map((nd) => nd.path));
	return out.map((nd) => ({ ...nd, exclude: [0, 1, 2, 3].filter((d) => paths.has(nd.path + d)) }));
}

function ringNodes(loadRadiusM, level, opts) {
	return ringsFor(loadRadiusM, level).map((r) => ({
		...r, nodes: syntheticTraverse(zoneOf({ ...CENTER, radius: r.radiusM }), r.level, opts),
	}));
}

// Quel octant de `box` contient le point ? (digits 0-3)
function octantOf(box, p) {
	return childBoxes(box).find((c) => p.lat >= c.box.s && p.lat < c.box.n && p.lon >= c.box.w && p.lon < c.box.e)?.key;
}

// Combien de nœuds retenus DESSINENT le point : la box le contient et
// l'octant qui le contient n'est pas exclu.
function coverage(selected, p) {
	let count = 0;
	for (const nd of selected) {
		const b = nd.box;
		if (!(p.lat >= b.s && p.lat < b.n && p.lon >= b.w && p.lon < b.e)) continue;
		if (nd.exclude.includes(octantOf(b, p))) continue;
		count++;
	}
	return count;
}

// Points d'échantillonnage : les centres de toutes les cellules du niveau
// plein dans le disque, plus un anneau serré de points aux frontières.
function samplePoints(loadRadiusM, level) {
	const cells = syntheticTraverse(zoneOf({ ...CENTER, radius: loadRadiusM }), level);
	const pts = [];
	for (const c of cells) {
		const p = { lat: (c.box.s + c.box.n) / 2, lon: (c.box.w + c.box.e) / 2 };
		if (metersBetween(CENTER, p) <= loadRadiusM) pts.push(p);
	}
	for (const r of [149, 150, 151, 299, 300, 301]) {
		if (r > loadRadiusM) continue;
		for (let a = 0; a < 360; a += 5) {
			const th = (a / 180) * Math.PI;
			pts.push({ lat: CENTER.lat + (r * Math.cos(th)) / 111320, lon: CENTER.lon + (r * Math.sin(th)) / (111320 * Math.cos((CENTER.lat / 180) * Math.PI)) });
		}
	}
	return pts;
}

await t('ringsFor : anneaux bornés au rayon de chargement, jamais vides, niveaux décroissants', () => {
	assert.deepEqual(ringsFor(300, 21), [{ radiusM: 150, level: 21 }, { radiusM: 300, level: 20 }]);
	assert.deepEqual(ringsFor(600, 21), [{ radiusM: 150, level: 21 }, { radiusM: 300, level: 20 }, { radiusM: 600, level: 19 }]);
	assert.deepEqual(ringsFor(100, 21), [{ radiusM: 100, level: 21 }]);
	assert.deepEqual(ringsFor(150, 21), [{ radiusM: 150, level: 21 }], 'un rayon égal à la frontière ne crée pas d\'anneau vide');
	assert.deepEqual(ringsFor(200, 15), [{ radiusM: 150, level: 15 }, { radiusM: 200, level: 14 }], 'plancher de niveau');
	assert.equal(LOD_RINGS.at(-1).radiusM, Infinity, 'le dernier anneau couvre tout rayon');
});

await t('boxInsideDisc / boxIntersectsDisc : coins et bords', () => {
	const box = (m) => ({ s: CENTER.lat - m / 111320, n: CENTER.lat + m / 111320, w: CENTER.lon - m / (111320 * Math.cos(CENTER.lat * Math.PI / 180)), e: CENTER.lon + m / (111320 * Math.cos(CENTER.lat * Math.PI / 180)) });
	assert.equal(boxInsideDisc(box(10), CENTER, 15), true, 'demi-diagonale 14,1 m < 15');
	assert.equal(boxInsideDisc(box(10), CENTER, 12), false, 'les coins dépassent');
	assert.equal(boxIntersectsDisc(box(10), CENTER, 12), true);
});

for (const loadRadiusM of [300, 600]) {
	await t(`assembleLod couvre chaque point du disque de ${loadRadiusM} m exactement une fois, avec ${loadRadiusM === 300 ? 2 : 3} anneaux`, () => {
		const rings = ringNodes(loadRadiusM, 21);
		const selected = assembleLod(rings, CENTER);
		const full = syntheticTraverse(zoneOf({ ...CENTER, radius: loadRadiusM }), 21)
			.filter((nd) => boxIntersectsDisc(nd.box, CENTER, loadRadiusM));
		assert.ok(selected.length < full.length * 0.6,
			`${selected.length} nœuds retenus contre ${full.length} au niveau plein : le LOD ne réduit pas assez`);
		const levels = new Set(selected.map((nd) => nd.level));
		assert.equal(levels.size, rings.length, `niveaux retenus : ${[...levels]}`);
		for (const nd of selected) assert.ok(boxIntersectsDisc(nd.box, CENTER, loadRadiusM), `${nd.path} hors du disque`);
		let bad = 0;
		const pts = samplePoints(loadRadiusM, 21);
		for (const p of pts) {
			const c = coverage(selected, p);
			if (c !== 1) { bad++; if (bad <= 3) console.log(`      point à ${metersBetween(CENTER, p).toFixed(1)} m couvert ${c} fois`); }
		}
		assert.equal(bad, 0, `${bad}/${pts.length} points mal couverts (0 = trou, 2+ = z-fight)`);
		console.log(`      ${loadRadiusM} m : ${full.length} nœuds au niveau 21 → ${selected.length} avec LOD (${[...levels].join('/')})`);
	});
}

await t('un fill-in peu profond côté fin, raffiné côté grossier : ancêtre exclu, pas de double dessin', () => {
	// Un trou au niveau 21 sous une cellule de niveau 19 qui chevauche la
	// frontière 150 m : l'anneau fin retient l'ancêtre (fill-in au niveau 20,
	// puis 19 si le trou est à 20), l'anneau grossier voit plus loin et retient
	// des nœuds de niveau 20 sous ce même ancêtre, hors du disque intérieur.
	const cells19 = syntheticTraverse(zoneOf({ ...CENTER, radius: 300 }), 19)
		.filter((nd) => boxIntersectsDisc(nd.box, CENTER, 150) && !boxInsideDisc(nd.box, CENTER, 150));
	assert.ok(cells19.length > 0);
	const straddling = cells19[0];
	// Absents : TOUS les enfants de cette cellule qui recoupent le carré de
	// traversée de l'anneau fin. L'anneau fin retient donc la cellule 19
	// entière (fill-in) ; l'anneau grossier, dont le carré est plus grand, voit
	// ses autres enfants exister et les retient au niveau 20 — la cellule 19
	// est écartée chez lui. Attendu : la cellule 19 dessine les octants
	// absents (le fill-in comble le trou), ses enfants retenus dessinent les
	// leurs, et elle les exclut.
	const zoneFine = zoneOf({ ...CENTER, radius: 150 });
	const holes = new Set(childBoxes(straddling.box).filter((c) => c.key < 4 && boxIntersects(c.box, zoneFine)).map((c) => straddling.path + c.key));
	assert.ok(holes.size > 0 && holes.size < 4, `scénario : ${holes.size} enfant(s) absent(s) sur 4`);
	const rings = ringNodes(300, 21, { holes });
	assert.ok(rings[0].nodes.some((nd) => nd.path === straddling.path), 'l\'anneau fin retient le fill-in');
	assert.ok(!rings[1].nodes.some((nd) => nd.path === straddling.path), 'l\'anneau grossier, lui, l\'a écarté');
	const selected = assembleLod(rings, CENTER);
	const fill = selected.find((nd) => nd.path === straddling.path);
	assert.ok(fill, 'le fill-in de niveau 19 est retenu');
	assert.equal(fill.level, 21, 'par l\'anneau fin');
	const finer = selected.filter((nd) => nd.path.startsWith(straddling.path) && nd.path !== straddling.path);
	assert.ok(finer.length > 0, 'des descendants de niveau 20 hors du disque intérieur doivent être retenus par l\'anneau grossier');
	assert.ok(finer.every((nd) => fill.exclude.includes(Number(nd.path[straddling.path.length]))),
		`chaque descendant retenu a son octant exclu de l'ancêtre : ${JSON.stringify(fill.exclude)}`);
	for (const h of holes) assert.ok(!fill.exclude.includes(Number(h[straddling.path.length])), 'un octant absent reste dessiné par le fill-in');
	let bad = 0;
	for (const p of samplePoints(300, 21)) if (coverage(selected, p) !== 1) bad++;
	assert.equal(bad, 0, `${bad} points mal couverts avec un trou`);
});

await t('un nœud sans box passe tel quel ; un chemin en double n\'est retenu qu\'une fois, avec le niveau du plus fin', () => {
	const a = { path: '3060', epoch: 1, exclude: [] };
	const selected = assembleLod([{ radiusM: 150, level: 21, nodes: [a] }, { radiusM: 300, level: 20, nodes: [{ ...a, epoch: 2 }] }], CENTER);
	assert.equal(selected.length, 1);
	assert.equal(selected[0].epoch, 1);
	assert.equal(selected[0].level, 21);
});

console.log(`rocktree-lod-selftest : ${n} tests ok`);
