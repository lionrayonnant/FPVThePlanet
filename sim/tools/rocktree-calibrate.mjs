#!/usr/bin/env node
// Outil de calibration (issue #18, Stage 3, Task 8) : mesure le m/texel réel
// de l'octree rocktree par niveau absolu, à comparer à la référence Flyover
// (m/px de tuile Web-Mercator 256px) pour construire zoomToLevel().
//
// Offline par défaut : lit tools/testdata/rocktree/ (capture Paris, epoch
// FIX.epoch). Un bulk à chemin P (longueur |P| digits) porte un tableau
// meters_per_texel indexé par NIVEAU RELATIF 1..4 → niveau absolu
// |P|+1 .. |P|+4 (voir tools/lib/rocktree/proto.mjs:parseBulk). Chaque
// NodeMetadata peut aussi porter son propre meters_per_texel (plus
// spécifique, un seul float) : on l'utilise quand présent.
//
// Lancer : node tools/rocktree-calibrate.mjs
//          node tools/rocktree-calibrate.mjs --live  (réseau, zone au choix)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFields, doubles } from './lib/rocktree/pb.mjs';
import { parsePlanetoid, parseBulk } from './lib/rocktree/proto.mjs';
import { rootOctant, childBoxes } from './lib/rocktree/octant.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');
const FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

// Latitude de la capture (voir index.json / rocktree-selftest.mjs : Paris).
const CAPTURE_LAT = 48.858;
const ZOOMS = [13, 14, 15, 16, 17, 18, 19, 20];

// m/px d'une tuile Web-Mercator 256px à cette latitude : la référence Flyover
// actuelle (--zoom de add-map.mjs), citée telle quelle par le brief.
function flyoverMetersPerPixel(zoom, lat = CAPTURE_LAT) {
	return (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

// Accumule les échantillons de m/texel par niveau ABSOLU, à partir d'un
// ensemble de bulks { path, metersPerTexel: Float32Array, nodes }.
function accumulate(bulks) {
	const byLevel = new Map(); // level -> { sum, n, min, max }
	const add = (level, value, source) => {
		if (value == null || !Number.isFinite(value)) return;
		let e = byLevel.get(level);
		if (!e) { e = { sum: 0, n: 0, min: Infinity, max: -Infinity, sources: new Set() }; byLevel.set(level, e); }
		e.sum += value; e.n++; e.min = Math.min(e.min, value); e.max = Math.max(e.max, value);
		e.sources.add(source);
	};
	for (const { bulkPath, bulk } of bulks) {
		const base = bulkPath.length;
		for (let i = 0; i < bulk.metersPerTexel.length; i++) {
			add(base + i + 1, bulk.metersPerTexel[i], 'bulk');
		}
		for (const [relPath, node] of bulk.nodes) {
			if (node.metersPerTexel != null) add(base + relPath.length, node.metersPerTexel, 'node');
		}
	}
	return byLevel;
}

function printLevelTable(byLevel) {
	console.log('niveau absolu | m/texel (moyenne) |  min  |  max  | échantillons | source(s)');
	console.log('--------------+--------------------+-------+-------+--------------+----------');
	const levels = [...byLevel.keys()].sort((a, b) => a - b);
	for (const lvl of levels) {
		const e = byLevel.get(lvl);
		const mean = e.sum / e.n;
		console.log(
			`${String(lvl).padStart(13)} | ${mean.toFixed(4).padStart(18)} | ${e.min.toFixed(2).padStart(5)} | ${e.max.toFixed(2).padStart(5)} | ${String(e.n).padStart(12)} | ${[...e.sources].join('+')}`
		);
	}
	return levels;
}

function printFlyoverTable() {
	console.log(`zoom | m/px tuile Flyover (lat ${CAPTURE_LAT}°)`);
	console.log('-----+--------------------------------');
	for (const z of ZOOMS) console.log(`${String(z).padStart(4)} | ${flyoverMetersPerPixel(z).toFixed(4)}`);
}

// Correspondance zoom -> niveau : pour chaque zoom, le niveau mesuré dont le
// m/texel est le plus proche EN ÉCHELLE LOG (on compare des ratios, pas des
// différences — le m/texel décroît exponentiellement avec le niveau, comme
// le m/px Flyover avec le zoom).
function closestLevel(byLevel, targetMetersPerPixel) {
	let best = null, bestRatio = Infinity;
	for (const [lvl, e] of byLevel) {
		const mean = e.sum / e.n;
		const ratio = Math.abs(Math.log(mean / targetMetersPerPixel));
		if (ratio < bestRatio) { bestRatio = ratio; best = lvl; }
	}
	return best;
}

function printMapping(byLevel) {
	console.log('zoom | Flyover m/px | niveau retenu | m/texel mesuré | ratio (mesuré/Flyover)');
	console.log('-----+--------------+----------------+-----------------+------------------------');
	for (const z of ZOOMS) {
		const target = flyoverMetersPerPixel(z);
		const lvl = closestLevel(byLevel, target);
		if (lvl == null) { console.log(`${String(z).padStart(4)} | ${target.toFixed(4).padStart(12)} | (aucune donnée)`); continue; }
		const mean = byLevel.get(lvl).sum / byLevel.get(lvl).n;
		console.log(`${String(z).padStart(4)} | ${target.toFixed(4).padStart(12)} | ${String(lvl).padStart(14)} | ${mean.toFixed(4).padStart(15)} | ${(mean / target).toFixed(3)}`);
	}
}

async function offline() {
	console.log('=== Calibration zoom -> niveau d\'octree (mesurée sur fixtures, hors-ligne) ===\n');
	const bulks = FIX.bulks.map((b) => ({ bulkPath: b.path, bulk: parseBulk(read(b.file)) }));
	console.log(`${bulks.length} bulk(s) de fixtures, chemins de longueur : ${bulks.map((b) => b.bulkPath.length).join(', ')}\n`);

	console.log('--- m/texel mesurés par niveau absolu (moyenne des bulks + nœuds des fixtures) ---');
	const byLevel = printLevelTable(accumulate(bulks));
	console.log();

	console.log('--- référence Flyover (156543.03 * cos(lat) / 2^zoom, tuile 256px) ---');
	printFlyoverTable();
	console.log();

	const levelMap = accumulate(bulks);
	console.log('--- correspondance zoom -> niveau (plus proche EN ÉCHELLE LOG) ---');
	printMapping(levelMap);

	return levelMap;
}

// --live (optionnel, brief Task 8) : refait la même mesure sur une zone au
// choix via kh.google.com, en descendant les bulks tous les 4 digits à
// partir de la racine couvrant (lat, lon). N'est PAS exécuté par défaut —
// implémenté pour permettre une recalibration future sans dépendre des
// fixtures figées.
const PREFIX = 'https://kh.google.com/rt/earth/';

async function fetchBulkLive(bulkPath, epoch) {
	const url = `${PREFIX}BulkMetadata/pb=!1m2!1s${bulkPath}!2u${epoch}`;
	const res = await globalThis.fetch(url);
	if (!res.ok) return null;
	return parseBulk(Buffer.from(await res.arrayBuffer()));
}

// Chemin absolu (digits) menant vers (lat, lon), calculé géométriquement en
// suivant childBoxes à chaque digit — indépendant des bulks eux-mêmes.
function pathTo(lat, lon, depth) {
	const { path: root, box } = rootOctant(lat, lon);
	let cur = box, out = root;
	for (let i = root.length; i < depth; i++) {
		const kids = childBoxes(cur);
		const k = kids.find((c) => lat >= c.box.s && (lat < c.box.n || c.box.n === 90) && lon >= c.box.w && (lon < c.box.e || c.box.e === 180));
		if (!k) break;
		out += k.key; cur = k.box;
	}
	return out;
}

async function live(lat, lon) {
	console.log(`=== Calibration en direct sur (${lat}, ${lon}) — kh.google.com ===\n`);
	const planetoidBuf = Buffer.from(await (await globalThis.fetch(PREFIX + 'PlanetoidMetadata')).arrayBuffer());
	const { rootEpoch } = parsePlanetoid(planetoidBuf);
	console.log(`epoch racine : ${rootEpoch}\n`);

	const bulks = [];
	let bulkPath = '', epoch = rootEpoch;
	for (let depth = 0; depth <= 24; depth += 4) {
		const bulk = await fetchBulkLive(bulkPath, epoch);
		if (!bulk) break;
		bulks.push({ bulkPath, bulk });
		const target = pathTo(lat, lon, bulkPath.length + 4);
		const rel4 = target.slice(bulkPath.length, bulkPath.length + 4);
		const nextMeta = bulk.nodes.get(rel4);
		if (!nextMeta) break;
		epoch = nextMeta.bulkEpoch ?? epoch;
		bulkPath = target.slice(0, bulkPath.length + 4);
	}
	console.log(`${bulks.length} bulk(s) obtenu(s), chemins de longueur : ${bulks.map((b) => b.bulkPath.length).join(', ')}\n`);

	console.log('--- m/texel mesurés par niveau absolu ---');
	printLevelTable(accumulate(bulks));
	console.log();
	console.log('--- référence Flyover ---');
	printFlyoverTable(lat);
	console.log();
	console.log('--- correspondance zoom -> niveau ---');
	printMapping(accumulate(bulks));
}

const args = process.argv.slice(2);
if (args.includes('--live')) {
	const latArg = args.find((a) => a.startsWith('--lat='));
	const lonArg = args.find((a) => a.startsWith('--lon='));
	const lat = latArg ? Number(latArg.slice(6)) : CAPTURE_LAT;
	const lon = lonArg ? Number(lonArg.slice(6)) : 2.3522;
	await live(lat, lon);
} else {
	await offline();
}
