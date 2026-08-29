// Le pipeline d'ajout de carte, appelable depuis du code : téléchargement de la
// tuile Flyover (Go exporter), conversion (prep.mjs), enregistrement dans
// public/scenes.json.
//
// tools/add-map.mjs en est le wrapper CLI ; l'API dev de la GUI
// (tools/map-api-plugin.mjs) appelle addMap() directement pour pouvoir streamer
// les logs et annuler en cours de route — d'où onLog/signal plutôt que
// stdio: 'inherit'.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { run, Cancelled } from './run.mjs';
import * as providers from './providers/index.mjs';

export const SIM_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
export const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

// Surface publique historique : map-api-plugin.mjs, map-poly-selftest.mjs,
// scanner-selftest.mjs et gen-poly-fixture.mjs importent encore ces symboles ici.
export { Cancelled };
export const FLYOVER_ROOT = providers.get('flyover').FLYOVER_ROOT;
export const tileDirName = (o) => providers.get('flyover').tileDirName(o);
export const tileDirPath = (o) => providers.get('flyover').tileDirPath(o);
export const tileIsUsable = (d) => providers.get('flyover').tileIsUsable(d);
export const planScan = (o, x) => providers.get('flyover').plan(o, x);
export const probeCoverage = (o, x) => providers.get('flyover').probe(o, x);

// Les ligatures et les lettres barrées ne se décomposent pas en NFD : sans cette
// table, « Sacré-Cœur » donne « sacre-c-ur ». Le slug est visible dans la GUI et
// sert de nom de dossier, il ne peut pas se permettre d'avaler des lettres.
const LIGATURES = { 'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'đ': 'd', 'ł': 'l', 'Ł': 'l', 'ð': 'd', 'þ': 'th' };

export function slugify(name) {
	return name
		.replace(/[œŒæÆøØßđłŁðþ]/g, (c) => LIGATURES[c])
		.normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function readScenes() {
	return fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
}

export function writeScenes(scenes) {
	fs.writeFileSync(SCENES_JSON, JSON.stringify(scenes, null, '\t') + '\n');
}

// Extrait les jalons réels de prep.mjs de son stdout, sans y toucher : c'est le
// seul endroit qui sait que le pipeline passe par decode (lecture MTL/OBJ) puis
// rebuild (ENU, chunks, sheets de textures, mesh de collision). Chaque motif
// correspond à une ligne existante de prep.mjs (voir les console.log autour de
// la parse OBJ et de la construction des chunks) : rien n'est deviné, tout est
// lu. Le PHASE 05 en tire les barres FETCH/DECODE/REBUILD du scanner ; add-map.mjs
// (CLI) ignore ces événements et continue d'imprimer les lignes brutes.
// prep.mjs groupe ses gros nombres avec toLocaleString() sans locale explicite :
// le séparateur suit donc l'ICU du runtime qui l'exécute (virgule, espace,
// espace fine insécable U+202F...), pas forcément celui de la machine de dev.
// `N` capture n'importe lequel de ces styles ; int() ne garde que les chiffres.
const N = String.raw`[\d\s,]+`;
const RE_MATERIALS = new RegExp(`^(\\d+) materials, (\\d+) without a texture$`);
const RE_CHUNKS_PLANNED = new RegExp(`^-> (\\d+) chunks? of up to \\d+ layers$`);
const RE_GEOMETRY = new RegExp(`^(${N}) vertices, (${N}) uvs, (${N}) triangles$`);
const RE_CHUNK_DONE = new RegExp(`^chunk \\d+: ${N} verts, ${N} tris, bbox .+ m, ([\\d.]+) MB$`);
const RE_TEXTURE_SHEET = /^\S+\.jpg: (\d+) layers, ([\d.]+) MB$/;
const RE_COLLISION = new RegExp(`^collision\\.bin: (${N}) verts, (${N}) tris, ([\\d.]+) MB$`);

const int = (s) => Number(String(s).replace(/[^\d]/g, ''));

// `line` est déjà débarrassée du timestamp `[X.Xs] ` par l'appelant. Rend
// `{ phase }`, `{ stat }`, les deux, ou `null` si la ligne ne dit rien
// d'exploitable pour l'affichage (elle part quand même en log brut).
export function parsePrepLine(line) {
	let m;
	if ((m = line.match(RE_MATERIALS))) {
		return { stat: { materials: Number(m[1]), materialsNoTexture: Number(m[2]) } };
	}
	if ((m = line.match(RE_CHUNKS_PLANNED))) {
		return { stat: { chunksPlanned: Number(m[1]) } };
	}
	if ((m = line.match(RE_GEOMETRY))) {
		// Le flux OBJ vient de finir : tout ce qui suit construit le résultat
		// (ENU, chunks, textures, collision) plutôt que de lire l'entrée.
		return { phase: 'rebuild', stat: { vertices: int(m[1]), triangles: int(m[3]) } };
	}
	if ((m = line.match(RE_CHUNK_DONE))) {
		return { stat: { chunksDone: 1, chunkBytes: Math.round(Number(m[1]) * 1e6) } };
	}
	if ((m = line.match(RE_TEXTURE_SHEET))) {
		return { stat: { textureSheets: 1, textureBytes: Math.round(Number(m[2]) * 1e6) } };
	}
	if ((m = line.match(RE_COLLISION))) {
		return { stat: { collisionVerts: int(m[1]), collisionTris: int(m[2]), collisionBytes: Math.round(Number(m[3]) * 1e6) } };
	}
	return null;
}

// Ajoute (ou remet à jour) une carte. onLog reçoit {stream, line} pour chaque
// ligne des sous-processus, et {stream:'phase'|'progress'|'meta'} pour l'avancement.
export async function addMap(opts, { onLog, signal } = {}) {
	const {
		name, lat, lon, bbox, poly,
		zoom = 20, radius = 25, altitude = 20, cell = 256, quality = 85,
	} = opts;
	const slug = opts.slug ?? slugify(name);

	const outDir = path.join(SCENES_DIR, slug);

	const log = (line) => onLog?.({ stream: 'meta', line });
	log(`Carte : ${name}  (slug: ${slug})`);
	log(poly
		? `Tracé : ${poly.length / 2} sommets  zoom ${zoom}  altitudes ${altitude}`
		: bbox
			? `Zone : ${bbox.south}, ${bbox.west} → ${bbox.north}, ${bbox.east}  zoom ${zoom}  altitudes ${altitude}`
			: `Centre : ${lat}, ${lon}  zoom ${zoom}  rayon ${radius}  altitudes ${altitude}`);

	const provider = providers.get(opts.provider ?? providers.DEFAULT_PROVIDER_ID);
	const { tileDir, attribution, fetchedAt, stats } = await provider.fetch(opts, { onLog, signal });

	// « prep » commence par lire l'OBJ/MTL téléchargé (decode) avant de le
	// reconstruire pour le moteur (rebuild) — voir parsePrepLine ci-dessus, qui
	// détecte le vrai basculement dans le flux stdout de prep.mjs.
	onLog?.({ stream: 'phase', line: 'decode' });
	await run('node', [
		'tools/prep.mjs', tileDir,
		'--out', outDir,
		'--cell', String(cell),
		'--quality', String(quality),
	], SIM_ROOT, {
		signal,
		onLog: (ev) => {
			onLog?.(ev);
			if (ev.stream !== 'stdout') return;
			const parsed = parsePrepLine(ev.line.replace(/^\[[\d.]+s\]\s*/, ''));
			if (!parsed) return;
			if (parsed.phase) onLog?.({ stream: 'phase', line: parsed.phase });
			if (parsed.stat) onLog?.({ stream: 'stat', stat: parsed.stat });
		},
	});

	// Schéma additif : les entrées historiques {slug,name,lat,lon} restent valides,
	// et le simulateur ne lit toujours que slug/name. Les champs en plus servent à
	// la GUI (re-préparer sans redemander les réglages, dessiner la zone existante).
	const scenes = readScenes();
	const entry = {
		slug, name, lat, lon,
		...(poly ? { poly } : bbox ? { bbox } : { radius }),
		zoom, altitude, cell, quality,
		bytes: dirSize(outDir),
		createdAt: new Date().toISOString(),
	};
	const i = scenes.findIndex((s) => s.slug === slug);
	if (i >= 0) scenes[i] = entry; else scenes.push(entry);
	writeScenes(scenes);

	log(`\n✓ "${name}" prêt — disponible dans le menu au prochain "npm run dev".`);
	return { slug, outDir, tileDir, entry, stats };
}

export function dirSize(dir) {
	let total = 0;
	try {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
		}
	} catch { return 0; }
	return total;
}
