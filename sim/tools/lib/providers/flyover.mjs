// Fournisseur Apple Flyover : tout ce que le pipeline sait de C3M/C3MM vit ici.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, Cancelled } from '../run.mjs';
import { polyHash, polygonProbePoint } from '../tiles.mjs';

const SIM_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
export const FLYOVER_ROOT = path.resolve(SIM_ROOT, '../flyover-reverse-engineering');

export const id = 'flyover';
export const label = 'Apple Flyover';
export const attribution = ['© Apple'];

// Doit rester en phase avec les fmt.Sprintf de cmd/export-obj/main.go — c'est ce
// nom qui sert de cache : si les deux divergent, chaque run re-télécharge tout.
// %f en Go, c'est 6 décimales.
//
// Asynchrone depuis le polygone : son nom est un sha256 de la chaîne canonique
// des sommets, et crypto.subtle — le seul digest disponible aussi dans le
// navigateur, où tiles.mjs doit rester importable — est asynchrone.
export async function tileDirName({ lat, lon, zoom, radius, altitude, bbox, poly }) {
	if (poly) return `poly-${await polyHash(poly)}-${zoom}-${altitude}`;
	if (bbox) {
		const { south, west, north, east } = bbox;
		return `bbox-${south.toFixed(6)}-${west.toFixed(6)}-${north.toFixed(6)}-${east.toFixed(6)}-${zoom}-${altitude}`;
	}
	return `${lat.toFixed(6)}-${lon.toFixed(6)}-${zoom}-${radius}-${altitude}`;
}

export async function tileDirPath(opts) {
	return path.join(FLYOVER_ROOT, 'downloaded_files/obj', await tileDirName(opts));
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

// Interroge `export-obj --plan` : combien de colonnes, quelle région Flyover,
// quelle emprise de couverture — sans émettre une seule requête de tuile.
export async function plan({ lat, lon, zoom = 20, radius = 25, altitude = 20, bbox, poly }, { signal } = {}) {
	const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--plan'];
	if (poly) args.push('--poly', poly.join(','));
	else if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);

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

// Sonde de couverture : télécharge pour de vrai une poignée de tuiles au centre
// de la zone, et rien de plus. C'est la seule preuve fiable qu'Apple Flyover
// couvre l'endroit — --plan ne connaît que l'emprise déclarée de la région, qui
// est bien plus large que la photogrammétrie réellement servie.
//
// Le verdict a trois états, pas deux : « 0 exported » seul ne prouve rien tant
// qu'on n'a pas regardé le compteur de tuiles non décodées (cf. HANDOFF #15).
export async function probe({ lat, lon, zoom = 20, altitude = 20, bbox, poly }, { signal } = {}) {
	// Sur un tracé en L ou en croissant, le centre de l'emprise tombe HORS du
	// tracé : sonder là rendrait un verdict sur une zone qu'on n'extrait pas.
	// polygonProbePoint vise le centre d'une tuile réellement retenue.
	const centre = poly
		? polygonProbePoint(poly, zoom)
		: bbox
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
		fs.rmSync(await tileDirPath({ zoom, altitude, bbox: probeBox }), { recursive: true, force: true });
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

// Télécharge la tuile et rend le dossier prêt pour prep.mjs. Lève si la zone
// n'est pas couverte — le message distingue « pas de couverture » de « couvert
// mais illisible », cf. HANDOFF #15.
export async function fetch(opts, { onLog, signal } = {}) {
	const { lat, lon, zoom = 20, radius = 25, altitude = 20, bbox, poly, force = false } = opts;
	const tileDir = await tileDirPath({ lat, lon, zoom, radius, altitude, bbox, poly });
	const stats = { exported: 0, undecodable: 0 };
	let fetchedAt;

	if (!force && tileIsUsable(tileDir)) {
		onLog?.({ stream: 'meta', line: `\nTuile déjà téléchargée (${tileDir}), téléchargement sauté (--force pour refaire).` });
		onLog?.({ stream: 'phase', line: 'download', done: true });
		// Cache hit : ce run n'a rien téléchargé aujourd'hui. `fetchedAt` doit
		// rester la date de la vraie acquisition (mtime d'exp_model.obj), pas
		// l'instant de ce re-prep — sinon une tuile vieille de plusieurs mois se
		// fait passer pour fraîche à chaque relecture, et une obligation de
		// rafraîchissement future ne rafraîchirait jamais rien.
		fetchedAt = fs.statSync(path.join(tileDir, 'exp_model.obj')).mtime.toISOString();
	} else {
		// Purge tout reliquat vide d'un scan précédent : l'exporter repart propre
		// et le test ci-dessous ne peut pas être trompé par des fichiers périmés.
		fs.rmSync(tileDir, { recursive: true, force: true });
		onLog?.({ stream: 'phase', line: 'download' });

		const args = ['run', 'cmd/export-obj/main.go', String(lat), String(lon), String(zoom), String(radius), String(altitude), '--parallel'];
		if (poly) args.push('--poly', poly.join(','));
		else if (bbox) args.push('--bbox', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);

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
		// Vraie acquisition : c'est bien maintenant que la tuile a été obtenue.
		fetchedAt = new Date().toISOString();
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
			: `aucune tuile 3D ${poly ? 'dans le tracé' : `à ${lat}, ${lon}`} (zoom ${zoom}).\n` +
			  "  Apple Flyover ne couvre en photogrammétrie qu'une liste de villes : quand le scan\n" +
			  '  affiche « 0 exported », ce lieu n\'en fait probablement pas partie. Vérifie les\n' +
			  '  coordonnées, puis essaie une zone plus large ou un zoom plus bas (19/18) avant\n' +
			  '  de conclure ; un lieu couvert renvoie des tuiles dès une zone minuscule.');
	}

	return { tileDir, attribution, fetchedAt, stats };
}
