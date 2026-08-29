// Le pipeline d'ajout de carte, appelable depuis du code : téléchargement de la
// tuile Flyover (Go exporter), conversion (prep.mjs), enregistrement dans
// public/scenes.json.
//
// tools/add-map.mjs en est le wrapper CLI ; l'API dev de la GUI
// (tools/map-api-plugin.mjs) appelle addMap() directement pour pouvoir streamer
// les logs et annuler en cours de route — d'où onLog/signal plutôt que
// stdio: 'inherit'.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export const SIM_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const FLYOVER_ROOT = path.resolve(SIM_ROOT, '../flyover-reverse-engineering');
export const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
export const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

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

// Doit rester en phase avec les fmt.Sprintf de cmd/export-obj/main.go — c'est ce
// nom qui sert de cache : si les deux divergent, chaque run re-télécharge tout.
// %f en Go, c'est 6 décimales.
export function tileDirName({ lat, lon, zoom, radius, altitude, bbox }) {
	if (bbox) {
		const { south, west, north, east } = bbox;
		return `bbox-${south.toFixed(6)}-${west.toFixed(6)}-${north.toFixed(6)}-${east.toFixed(6)}-${zoom}-${altitude}`;
	}
	return `${lat.toFixed(6)}-${lon.toFixed(6)}-${zoom}-${radius}-${altitude}`;
}

export function tileDirPath(opts) {
	return path.join(FLYOVER_ROOT, 'downloaded_files/obj', tileDirName(opts));
}

// Le Go exporter crée exp_model.obj/.mtl avant de savoir si le scan trouvera
// quoi que ce soit : « le dossier existe » ne veut donc pas dire « la tuile est
// téléchargée ». Seul un OBJ non vide compte — sinon un premier run sur une zone
// sans couverture Flyover empoisonne le cache et tous les runs suivants sautent
// silencieusement le téléchargement.
export function tileIsUsable(dir) {
	try {
		return ['exp_model.obj', 'exp_model.mtl'].every((f) => fs.statSync(path.join(dir, f)).size > 0);
	} catch { return false; }
}

export function readScenes() {
	return fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
}

export function writeScenes(scenes) {
	fs.writeFileSync(SCENES_JSON, JSON.stringify(scenes, null, '\t') + '\n');
}

export class Cancelled extends Error {
	constructor() { super('annulé'); this.name = 'Cancelled'; }
}

// Lance une commande en relayant chaque ligne de stdout ET de stderr à onLog.
// Le Go exporter écrit toute sa progression sur stderr et réserve stdout au JSON
// de --plan, alors que prep.mjs écrit sur stdout : il faut les deux.
function run(cmd, args, cwd, { onLog, signal }) {
	return new Promise((resolve, reject) => {
		onLog?.({ stream: 'meta', line: `$ ${cmd} ${args.join(' ')}` });
		const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

		// Une ligne peut arriver en plusieurs chunks : on tamponne jusqu'au \n.
		const pump = (stream, name) => {
			let buf = '';
			stream.setEncoding('utf8');
			stream.on('data', (d) => {
				buf += d;
				const lines = buf.split('\n');
				buf = lines.pop();
				for (const line of lines) onLog?.({ stream: name, line });
			});
			stream.on('end', () => { if (buf) onLog?.({ stream: name, line: buf }); });
		};
		pump(child.stdout, 'stdout');
		pump(child.stderr, 'stderr');

		let cancelled = false;
		const abort = () => {
			cancelled = true;
			// SIGTERM d'abord ; `go run` relaie mal les signaux à son enfant, donc
			// on repasse en SIGKILL si le processus s'accroche.
			child.kill('SIGTERM');
			setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref?.();
		};
		if (signal) {
			if (signal.aborted) return void abort();
			signal.addEventListener('abort', abort, { once: true });
		}

		child.on('error', reject);
		child.on('close', (code) => {
			signal?.removeEventListener('abort', abort);
			if (cancelled) reject(new Cancelled());
			else if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with code ${code}`));
		});
	});
}

// Interroge `export-obj --plan` : combien de colonnes, quelle région Flyover,
// quelle emprise de couverture — sans émettre une seule requête de tuile.
export async function planScan({ lat, lon, zoom = 20, radius = 25, altitude = 20, bbox }, { signal } = {}) {
	const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--plan'];
	if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);

	let out = '', err = '';
	await run('go', args, FLYOVER_ROOT, {
		signal,
		onLog: ({ stream, line }) => {
			if (stream === 'stdout') out += line + '\n';
			else if (stream === 'stderr') err += line + '\n';
		},
	}).catch((e) => {
		// findPlace échoue quand aucun trigger Flyover ne contient le point :
		// c'est un « pas de couverture ici », pas un plantage à remonter tel quel.
		if (/minPlace not found/.test(err)) throw new Error('hors couverture : Apple Flyover n\'a aucune région à ces coordonnées.');
		throw new Error(err.trim() || e.message);
	});
	return JSON.parse(out);
}

const RE_EXPORTING = /^Exporting /;
const RE_EXPORTED = /^(\d+) exported$/;
const RE_UNDECODABLE = /^(\d+) tuile\(s\) reçues mais non décodées/;

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

// Sonde de couverture : télécharge pour de vrai une poignée de tuiles au centre
// de la zone, et rien de plus. C'est la seule preuve fiable qu'Apple Flyover
// couvre l'endroit — --plan ne connaît que l'emprise déclarée de la région, qui
// est bien plus large que la photogrammétrie réellement servie.
//
// Le verdict a trois états, pas deux : « 0 exported » seul ne prouve rien tant
// qu'on n'a pas regardé le compteur de tuiles non décodées (cf. HANDOFF #15).
export async function probeCoverage({ lat, lon, zoom = 20, altitude = 20, bbox }, { signal } = {}) {
	const centre = bbox
		? { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 }
		: { lat, lon };

	// Une boîte de ~3x3 tuiles autour du centre : assez pour tomber sur du bâti,
	// assez petit pour répondre en une poignée de secondes.
	const n = 2 ** zoom;
	const dLon = (360 / n) * 1.5;
	const dLat = dLon * Math.cos((centre.lat / 180) * Math.PI);
	const probeBox = {
		south: centre.lat - dLat, west: centre.lon - dLon,
		north: centre.lat + dLat, east: centre.lon + dLon,
	};

	const args = ['run', 'cmd/export-obj/main.go', String(centre.lat), String(centre.lon),
		String(zoom), '1', String(altitude), '--parallel',
		'--bbox', `${probeBox.south},${probeBox.west},${probeBox.north},${probeBox.east}`];

	const res = { exported: 0, undecodable: 0 };
	let err = '';
	try {
		await run('go', args, FLYOVER_ROOT, {
			signal,
			onLog: ({ stream, line }) => {
				if (stream !== 'stderr') return;
				err += line + '\n';
				let m = line.match(RE_EXPORTED);
				if (m) res.exported = Number(m[1]);
				m = line.match(RE_UNDECODABLE);
				if (m) res.undecodable = Number(m[1]);
			},
		});
	} catch (e) {
		if (e instanceof Cancelled) throw e;
		if (/minPlace not found/.test(err)) {
			return { ...res, status: 'none', message: "Apple Flyover n'a aucune région à ces coordonnées." };
		}
		throw new Error(err.trim() || e.message);
	} finally {
		// La sonde est jetable : on ne laisse pas un dossier par clic dans le cache.
		fs.rmSync(tileDirPath({ zoom, altitude, bbox: probeBox }), { recursive: true, force: true });
	}

	if (res.exported > 0) {
		return { ...res, status: 'ok', message: `Couvert : ${res.exported} tuile(s) au centre de la zone.` };
	}
	if (res.undecodable > 0) {
		return { ...res, status: 'undecodable',
			message: `Zone couverte, mais illisible : ${res.undecodable} tuile(s) reçues que le parseur C3M ne sait pas décoder.` };
	}
	return { ...res, status: 'none',
		message: 'Aucune tuile au centre de la zone — Flyover ne fait probablement pas de photogrammétrie ici.' };
}

// Ajoute (ou remet à jour) une carte. onLog reçoit {stream, line} pour chaque
// ligne des sous-processus, et {stream:'phase'|'progress'|'meta'} pour l'avancement.
export async function addMap(opts, { onLog, signal } = {}) {
	const {
		name, lat, lon, bbox,
		zoom = 20, radius = 25, altitude = 20, cell = 256, quality = 85,
		force = false,
	} = opts;
	const slug = opts.slug ?? slugify(name);

	const tileDir = tileDirPath({ lat, lon, zoom, radius, altitude, bbox });
	const outDir = path.join(SCENES_DIR, slug);

	const log = (line) => onLog?.({ stream: 'meta', line });
	log(`Carte : ${name}  (slug: ${slug})`);
	log(bbox
		? `Zone : ${bbox.south}, ${bbox.west} → ${bbox.north}, ${bbox.east}  zoom ${zoom}  altitudes ${altitude}`
		: `Centre : ${lat}, ${lon}  zoom ${zoom}  rayon ${radius}  altitudes ${altitude}`);

	const stats = { exported: 0, undecodable: 0 };

	if (!force && tileIsUsable(tileDir)) {
		log(`\nTuile déjà téléchargée (${tileDir}), téléchargement sauté (--force pour refaire).`);
		onLog?.({ stream: 'phase', line: 'download', done: true });
	} else {
		// Purge tout reliquat vide d'un scan précédent : l'exporter repart propre
		// et le test ci-dessous ne peut pas être trompé par des fichiers périmés.
		fs.rmSync(tileDir, { recursive: true, force: true });
		onLog?.({ stream: 'phase', line: 'download' });

		const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--parallel'];
		if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);

		let hits = 0;
		await run('go', args, FLYOVER_ROOT, {
			signal,
			onLog: (ev) => {
				if (ev.stream === 'stderr') {
					if (RE_EXPORTING.test(ev.line)) {
						// Une ligne par tuile trouvée : trop verbeux pour l'affichage,
						// on n'en garde que le compteur.
						onLog?.({ stream: 'progress', phase: 'download', hits: ++hits });
						return;
					}
					let m = ev.line.match(RE_EXPORTED);
					if (m) stats.exported = Number(m[1]);
					m = ev.line.match(RE_UNDECODABLE);
					if (m) stats.undecodable = Number(m[1]);
				}
				onLog?.(ev);
			},
		});
	}

	if (!tileIsUsable(tileDir)) {
		fs.rmSync(tileDir, { recursive: true, force: true });
		// « 0 exported » ne prouve pas l'absence de couverture : une région dont le
		// parseur C3M ne comprend pas le format renvoie elle aussi zéro tuile
		// utilisable, et le message doit alors dire autre chose (cf. HANDOFF #15).
		throw new Error(stats.undecodable > 0
			? `zone couverte mais illisible : ${stats.undecodable} tuile(s) C3M reçues et non décodées par le parseur.\n` +
			  '  Ce n\'est pas un problème de coordonnées — cette région sert un format que\n' +
			  '  flyover-reverse-engineering ne sait pas encore lire.'
			: `aucune tuile 3D à ${lat}, ${lon} (zoom ${zoom}).\n` +
			  "  Apple Flyover ne couvre en photogrammétrie qu'une liste de villes : quand le scan\n" +
			  '  affiche « 0 exported », ce lieu n\'en fait probablement pas partie. Vérifie les\n' +
			  '  coordonnées, puis essaie une zone plus large ou un zoom plus bas (19/18) avant\n' +
			  '  de conclure ; un lieu couvert renvoie des tuiles dès une zone minuscule.');
	}

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
		...(bbox ? { bbox } : { radius }),
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
