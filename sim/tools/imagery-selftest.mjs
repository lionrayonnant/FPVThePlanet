// Selftest du repli d'imagerie (issue #158) : la trame au sol, la
// rastérisation UV, et la réparation des texels noirs. Aucune E/S réseau.
// Lancer : node tools/imagery-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
	createGroundRaster, paintTriangleGround, sampleRaster, dilateRaster,
	forEachTexelOfTriangle, blackMask, repairTexels,
} from './lib/rocktree/imagery.mjs';
import { parseNode } from './lib/rocktree/proto.mjs';
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './lib/rocktree/unpack.mjs';

const FIXDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');

// Échantillonneur de couleur unie : la plupart des tests ne s'intéressent pas
// au contenu de la texture, seulement au placement au sol.
const solid = (c) => () => c;

let n = 0;
const t = async (name, fn) => { await Promise.resolve(fn()); n++; console.log(`  ok  ${name}`); };

await (async () => {

// ------------------------------------------------------------- trame au sol

await t('trame : la géométrie de la boîte donne des cellules carrées en mètres', () => {
	// Paris : 1° de longitude vaut cos(lat) fois moins qu'1° de latitude. Une
	// trame en degrés serait donc rectangulaire au sol ; on veut des cellules
	// carrées EN MÈTRES, sinon le repli s'étire d'un facteur 1,5 à nos latitudes.
	const b = { south: 48.85, north: 48.86, west: 2.29, east: 2.30 };
	const r = createGroundRaster(b, 1.0);
	const hMetres = (b.north - b.south) * 111320;
	const wMetres = (b.east - b.west) * 111320 * Math.cos((48.855 * Math.PI) / 180);
	assert.ok(Math.abs(r.h - Math.ceil(hMetres)) <= 2, `${r.h} lignes pour ${hMetres.toFixed(0)} m`);
	assert.ok(Math.abs(r.w - Math.ceil(wMetres)) <= 2, `${r.w} colonnes pour ${wMetres.toFixed(0)} m`);
	assert.equal(r.rgb.length, r.w * r.h * 3);
	assert.equal(r.filled.length, r.w * r.h);
	assert.ok([...r.filled].every((x) => x === 0), 'une trame neuve est vide');
});

await t('trame : un aller-retour lat/lon -> cellule -> échantillon rend la couleur peinte', () => {
	const b = { south: 0, north: 0.001, west: 0, east: 0.001 };
	const r = createGroundRaster(b, 1.0);
	// Un triangle couvrant tout le quart sud-ouest, couleur unie.
	const P = (lat, lon, alt = 10) => ({ lat, lon, alt });
	paintTriangleGround(r, P(0, 0), P(0.0005, 0), P(0, 0.0005), [0, 0], [1, 0], [0, 1], solid([200, 100, 50]));
	const inside = sampleRaster(r, 0.0001, 0.0001);
	assert.deepEqual([...inside], [200, 100, 50]);
	assert.equal(sampleRaster(r, 0.0009, 0.0009), null, 'hors du triangle : rien de peint');
	assert.equal(sampleRaster(r, 5, 5), null, 'hors de la boîte : null, pas un débordement');
});

await t('trame : le noir n\'est jamais peint — c\'est précisément ce qu\'on veut remplacer', () => {
	const r = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 1.0);
	const P = (lat, lon) => ({ lat, lon, alt: 0 });
	paintTriangleGround(r, P(0, 0), P(0.0009, 0), P(0, 0.0009), [0, 0], [1, 0], [0, 1], solid([1, 1, 1]));
	assert.equal(sampleRaster(r, 0.0001, 0.0001), null, 'un triangle noir ne remplit pas la trame');
});

await t('trame : la surface la PLUS HAUTE gagne (un toit couvre le sol en dessous)', () => {
	const r = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 1.0);
	const tri = (alt, c) => paintTriangleGround(r,
		{ lat: 0, lon: 0, alt }, { lat: 0.0009, lon: 0, alt }, { lat: 0, lon: 0.0009, alt },
		[0, 0], [1, 0], [0, 1], solid(c));
	tri(5, [10, 10, 10]);     // sol
	tri(30, [200, 200, 200]); // toit
	tri(2, [90, 90, 90]);     // sous le sol : ne doit pas écraser
	assert.deepEqual([...sampleRaster(r, 0.0001, 0.0001)], [200, 200, 200]);
});

await t('trame : la dilatation comble les vides sans jamais inventer du noir', () => {
	const r = createGroundRaster({ south: 0, north: 0.0005, west: 0, east: 0.0005 }, 5.0);
	// Une seule cellule peinte : après dilatation, tout doit être rempli.
	const i = Math.floor(r.h / 2) * r.w + Math.floor(r.w / 2);
	r.rgb[i * 3] = 120; r.rgb[i * 3 + 1] = 130; r.rgb[i * 3 + 2] = 140; r.filled[i] = 1;
	const before = r.filled.reduce((a, x) => a + x, 0);
	assert.equal(before, 1);
	dilateRaster(r);
	assert.ok([...r.filled].every((x) => x === 1), 'la dilatation doit tout combler');
	for (let k = 0; k < r.w * r.h; k++) {
		assert.deepEqual([r.rgb[k*3], r.rgb[k*3+1], r.rgb[k*3+2]], [120, 130, 140]);
	}
});

await t('trame : une trame entièrement vide reste vide sans boucler', () => {
	const r = createGroundRaster({ south: 0, north: 0.0002, west: 0, east: 0.0002 }, 5.0);
	dilateRaster(r); // ne doit pas tourner à l'infini
	assert.ok([...r.filled].every((x) => x === 0));
});

await t('trame : le CONTENU de la texture est restitué, pas trois couleurs interpolées', () => {
	// Régression du défaut trouvé en regardant la trame produite : la première
	// version échantillonnait la texture aux TROIS SOMMETS puis interpolait la
	// COULEUR (ombrage de Gouraud). Sur un grand triangle, cela rendait un
	// éventail de facettes au lieu de l'image. On peint ici UN SEUL grand
	// triangle portant un damier fin : si les UV ne sont pas interpolés puis
	// échantillonnés par cellule, le damier disparaît.
	const r = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 1.0);
	// damier de 8 cases en u : noir interdit, on alterne deux gris francs.
	const sample = (u) => ((Math.floor(u * 8) % 2) ? [40, 40, 40] : [220, 220, 220]);
	const P = (lat, lon) => ({ lat, lon, alt: 0 });
	paintTriangleGround(r, P(0, 0), P(0, 0.001), P(0.001, 0), [0, 0], [1, 0], [0, 1], sample);
	paintTriangleGround(r, P(0.001, 0.001), P(0, 0.001), P(0.001, 0), [1, 1], [1, 0], [0, 1], sample);

	const vals = new Set();
	for (let i = 0; i < r.w * r.h; i++) if (r.filled[i]) vals.add(r.rgb[i * 3]);
	assert.deepEqual([...vals].sort((a, b) => a - b), [40, 220],
		`la trame doit ne contenir QUE les deux gris du damier, elle contient ${[...vals].join(',')}`);

	// et les bandes doivent se succéder le long de u : au moins 6 alternances.
	const row = Math.floor(r.h / 2);
	let flips = 0;
	for (let x = 1; x < r.w; x++) {
		const a = r.rgb[(row * r.w + x - 1) * 3], b = r.rgb[(row * r.w + x) * 3];
		if (r.filled[row * r.w + x] && r.filled[row * r.w + x - 1] && a !== b) flips++;
	}
	assert.ok(flips >= 6, `${flips} alternances de damier seulement — les UV ne sont pas échantillonnés par cellule`);
});

await t('trame : onlyEmpty protège le détail fin d\'un ancêtre grossier plus haut', () => {
	// C'est l'ordre de superposition du décodeur : imagerie fine d'abord, puis
	// ancêtres seulement dans les vides. Sans onlyEmpty, un ancêtre dont la
	// surface est un cheveu plus haute écraserait le détail fin.
	const r = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 2.0);
	const T = (alt, c, opts) => paintTriangleGround(r,
		{ lat: 0, lon: 0, alt }, { lat: 0.0009, lon: 0, alt }, { lat: 0, lon: 0.0009, alt },
		[0, 0], [1, 0], [0, 1], solid(c), opts);
	T(10, [50, 60, 70]);                        // fin
	T(11, [200, 0, 0], { onlyEmpty: true });    // ancêtre, plus haut : doit être ignoré
	assert.deepEqual([...sampleRaster(r, 0.0001, 0.0001)], [50, 60, 70]);
	// mais il remplit bien une cellule vide
	const r2 = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 2.0);
	paintTriangleGround(r2, { lat: 0, lon: 0, alt: 1 }, { lat: 0.0009, lon: 0, alt: 1 },
		{ lat: 0, lon: 0.0009, alt: 1 }, [0, 0], [1, 0], [0, 1], solid([200, 0, 0]), { onlyEmpty: true });
	assert.deepEqual([...sampleRaster(r2, 0.0001, 0.0001)], [200, 0, 0]);
});

// --------------------------------------------------------- rastérisation UV

await t('UV : un triangle couvrant toute la texture visite chaque texel une fois', () => {
	const W = 8, H = 8;
	const seen = new Uint8Array(W * H);
	// Deux triangles formant le carré UV complet.
	// Convention rocktree : px = u*(W-1), py = v*(H-1).
	forEachTexelOfTriangle(W, H, [0, 0], [1, 0], [0, 1], (px, py) => { seen[py * W + px]++; });
	forEachTexelOfTriangle(W, H, [1, 1], [1, 0], [0, 1], (px, py) => { seen[py * W + px]++; });
	const zero = [...seen].filter((x) => x === 0).length;
	assert.ok(zero <= 2, `${zero} texels jamais visités (diagonale tolérée)`);
	assert.ok([...seen].every((x) => x <= 2), 'aucun texel visité plus de deux fois');
});

await t('UV : les barycentriques rendues interpolent bien les sommets', () => {
	const W = 16, H = 16;
	let checked = 0;
	forEachTexelOfTriangle(W, H, [0, 0], [1, 0], [0, 1], (px, py, b0, b1, b2) => {
		assert.ok(b0 >= -1e-6 && b1 >= -1e-6 && b2 >= -1e-6, `barycentrique négative ${b0},${b1},${b2}`);
		assert.ok(Math.abs(b0 + b1 + b2 - 1) < 1e-6, 'somme des barycentriques != 1');
		// Reconstruit la position du texel à partir des barycentriques.
		const u = b0 * 0 + b1 * 1 + b2 * 0, v = b0 * 0 + b1 * 0 + b2 * 1;
		assert.ok(Math.abs(u * (W - 1) - px) < 1.5 && Math.abs(v * (H - 1) - py) < 1.5);
		checked++;
	});
	assert.ok(checked > 50, `${checked} texels seulement`);
});

await t('UV : un triangle dégénéré ne rend aucun texel et ne divise pas par zéro', () => {
	let hits = 0;
	forEachTexelOfTriangle(32, 32, [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], () => { hits++; });
	assert.equal(hits, 0);
	forEachTexelOfTriangle(32, 32, [0, 0], [1, 1], [0.5, 0.5], () => { hits++; }); // colinéaire
	assert.equal(hits, 0);
});

// ------------------------------------------------------------- réparation

await t('masque : blackMask marque exactement les texels sous le seuil', () => {
	const W = 4, H = 2;
	const rgb = Buffer.from([
		0,0,0,   10,10,10,  200,200,200,  0,0,1,
		7,7,7,   8,8,8,     255,0,0,      0,0,0,
	]);
	const m = blackMask(rgb, W, H, 8);
	assert.deepEqual([...m], [1, 0, 0, 1, 1, 0, 0, 1]);
});

await t('réparation : un texel noir couvert prend la couleur de la trame au sol', () => {
	const W = 4, H = 4;
	const rgb = Buffer.alloc(W * H * 3, 0); // tout noir
	const raster = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 2.0);
	const P = (lat, lon) => ({ lat, lon, alt: 0 });
	paintTriangleGround(raster, P(0, 0), P(0.001, 0), P(0, 0.001), [0,0],[1,0],[0,1], solid([77, 88, 99]));
	paintTriangleGround(raster, P(0.001, 0.001), P(0.001, 0), P(0, 0.001), [1,1],[1,0],[0,1], solid([77, 88, 99]));

	// Un triangle couvrant toute la texture, posé sur le centre de la boîte.
	const tris = [{
		uv: [[0, 0], [1, 0], [0, 1]],
		pos: [P(0.0002, 0.0002), P(0.0002, 0.0008), P(0.0008, 0.0002)],
	}, {
		uv: [[1, 1], [1, 0], [0, 1]],
		pos: [P(0.0008, 0.0008), P(0.0002, 0.0008), P(0.0008, 0.0002)],
	}];
	const { repaired, remaining } = repairTexels(rgb, W, H, tris, raster, 8);
	assert.ok(repaired > 0, 'aucun texel réparé');
	assert.equal(remaining, 0, `${remaining} texels noirs subsistent`);
	for (let i = 0; i < W * H; i++) {
		assert.deepEqual([rgb[i*3], rgb[i*3+1], rgb[i*3+2]], [77, 88, 99], `texel ${i}`);
	}
});

await t('réparation : les texels NON noirs ne sont jamais touchés', () => {
	const W = 2, H = 2;
	const rgb = Buffer.from([0,0,0, 40,50,60, 0,0,0, 70,80,90]);
	const raster = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 2.0);
	const P = (lat, lon) => ({ lat, lon, alt: 0 });
	paintTriangleGround(raster, P(0, 0), P(0.001, 0), P(0, 0.001), [0,0],[1,0],[0,1], solid([11, 22, 33]));
	paintTriangleGround(raster, P(0.001, 0.001), P(0.001, 0), P(0, 0.001), [1,1],[1,0],[0,1], solid([11, 22, 33]));
	const tris = [
		{ uv: [[0,0],[1,0],[0,1]], pos: [P(0.0002,0.0002), P(0.0002,0.0008), P(0.0008,0.0002)] },
		{ uv: [[1,1],[1,0],[0,1]], pos: [P(0.0008,0.0008), P(0.0002,0.0008), P(0.0008,0.0002)] },
	];
	repairTexels(rgb, W, H, tris, raster, 8);
	assert.deepEqual([rgb[3], rgb[4], rgb[5]], [40, 50, 60], 'texel clair modifié');
	assert.deepEqual([rgb[9], rgb[10], rgb[11]], [70, 80, 90], 'texel clair modifié');
});

await t('réparation : sans trame utilisable, la texture ressort inchangée', () => {
	const W = 2, H = 2;
	const rgb = Buffer.alloc(W * H * 3, 0);
	const raster = createGroundRaster({ south: 0, north: 0.001, west: 0, east: 0.001 }, 2.0); // vide
	const P = (lat, lon) => ({ lat, lon, alt: 0 });
	const tris = [{ uv: [[0,0],[1,0],[0,1]], pos: [P(0.0002,0.0002), P(0.0002,0.0008), P(0.0008,0.0002)] }];
	const { repaired } = repairTexels(rgb, W, H, tris, raster, 8);
	assert.equal(repaired, 0);
	assert.ok([...rgb].every((x) => x === 0), 'rien ne doit être inventé');
});

await t('convention V : v = 0 est la ligne du HAUT — mesuré sur une fixture réelle', async () => {
	// LE verrou de l'issue #158. Le décodeur héritait de obj.mjs un tv = 1 - v
	// qui affichait toutes les tuiles rocktree RETOURNÉES ; « textures nettes »
	// ne l'avait pas vu, une vue aérienne retournée restant parfaitement nette.
	//
	// On ne teste donc pas un paramètre mais la SORTIE : on rasterise au sol le
	// maillage d'un vrai nœud dans les deux conventions et on mesure la
	// COHÉRENCE SPATIALE de l'image obtenue (écart moyen entre cellules
	// voisines). L'imagerie aérienne est lisse ; la mauvaise convention recolle
	// les triangles au hasard et explose ce gradient.
	const fix = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'index.json'), 'utf8'));
	// Le nœud le moins profond : il couvre le plus de sol, donc le signal est
	// le plus net.
	const nf = fix.nodes.reduce((a, b) => (a.path.length <= b.path.length ? a : b));
	const node = parseNode(fs.readFileSync(path.join(FIXDIR, nf.file)));
	const ma = node.matrix;
	const mesh = node.meshes.reduce((a, b) => (a.vertices.length >= b.vertices.length ? a : b));

	const { xyz, count } = unpackVertices(mesh.vertices);
	const { uv, uMod, vMod } = unpackTexCoords(mesh.texCoords, count);
	const strip = unpackIndices(mesh.indices);
	const { layerBounds } = unpackLayerBoundsAndOctants(mesh.layerAndOctantCounts, strip, count);
	const end = Math.min(layerBounds[3], strip.length);

	// Sommets en géodésique. Le globe rocktree est une sphère ; pour une simple
	// mesure de cohérence, lat/lon sphériques suffisent (aucune altitude
	// géodésique n'est nécessaire ici).
	const geo = [];
	for (let i = 0; i < count; i++) {
		const x = xyz[i*3], y = xyz[i*3+1], z = xyz[i*3+2];
		const ex = x*ma[0]+y*ma[4]+z*ma[8]+ma[12], ey = x*ma[1]+y*ma[5]+z*ma[9]+ma[13], ez = x*ma[2]+y*ma[6]+z*ma[10]+ma[14];
		const r = Math.hypot(ex, ey, ez);
		geo.push({ lat: Math.asin(ez/r)*180/Math.PI, lon: Math.atan2(ey, ex)*180/Math.PI, alt: r });
	}
	let south=Infinity,north=-Infinity,west=Infinity,east=-Infinity;
	for (const g of geo) { if(g.lat<south)south=g.lat; if(g.lat>north)north=g.lat; if(g.lon<west)west=g.lon; if(g.lon>east)east=g.lon; }

	const img = sharp(mesh.texture.data);
	const { width: W, height: H } = await img.metadata();
	const { data } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });

	const roughness = (flipV) => {
		const r = createGroundRaster({ south, north, west, east }, 1.0);
		const sample = (u, v) => {
			const px = Math.min(W-1, Math.max(0, Math.round(u*(W-1))));
			const py = Math.min(H-1, Math.max(0, Math.round((flipV ? 1 - v : v)*(H-1))));
			const o = (py*W+px)*3; return [data[o], data[o+1], data[o+2]];
		};
		const UV = (i) => [(uv[i*2]+0.5)/uMod, (uv[i*2+1]+0.5)/vMod];
		for (let i = 0; i + 2 < end; i++) {
			let a = strip[i], b = strip[i+1], c = strip[i+2];
			if (a===b||a===c||b===c) continue;
			if (i & 1) { const t=b; b=c; c=t; }
			paintTriangleGround(r, geo[a], geo[b], geo[c], UV(a), UV(b), UV(c), sample);
		}
		let sum = 0, k = 0;
		for (let y = 0; y < r.h; y++) for (let x = 1; x < r.w; x++) {
			const i = y*r.w+x, j = i-1;
			if (!r.filled[i] || !r.filled[j]) continue;
			sum += Math.abs(r.rgb[i*3] - r.rgb[j*3]); k++;
		}
		return { rough: k ? sum/k : Infinity, cells: k };
	};

	const direct = roughness(false), flipped = roughness(true);
	assert.ok(direct.cells > 1000 && flipped.cells > 1000, 'trames trop vides pour conclure');
	console.log(`      gradient moyen : v direct ${direct.rough.toFixed(2)} | v inversé ${flipped.rough.toFixed(2)}`);
	assert.ok(direct.rough < flipped.rough * 0.8,
		`v direct (${direct.rough.toFixed(2)}) doit être NETTEMENT plus lisse que v inversé `
		+ `(${flipped.rough.toFixed(2)}) — si ce n'est plus le cas, la convention V a changé de sens`);
});

console.log(`imagery-selftest : ${n} tests ok`);

})();
