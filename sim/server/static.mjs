// Le serveur de fichiers du jeu : le `dist/` de Vite à la racine, et les
// données d'installation (`scenes.json`, `scenes/<slug>/*`) depuis le
// répertoire de données — pas depuis `dist/`, parce que le catalogue est propre
// à chaque installation et commence vide, tandis que celui de `public/` n'est
// que celui du dev.
//
// Écrit à la main, sans dépendance : c'est la règle du dépôt côté serveur.
//
// PAS DE REPLI SPA. Un fichier absent rend un 404 JSON, jamais index.html :
// c'est exactement ce que l'issue #275 a coûté côté client (une scène absente
// et une scène présente rendaient toutes deux 200 text/html, et `res.ok` ne
// disait plus rien). Le garde-fou de src/loader.js reste, mais il n'a plus à
// servir.

import fs from 'node:fs';
import path from 'node:path';
import { paths as defaultPaths } from '../tools/lib/paths.mjs';

// Ce que le jeu sert réellement, rien de plus.
const TYPES = {
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.bin': 'application/octet-stream',
	'.opus': 'audio/ogg',
	'.woff2': 'font/woff2',
	'.svg': 'image/svg+xml',
	// Les licences de fontes voyagent dans le build : lisibles, pas téléchargées.
	'.txt': 'text/plain; charset=utf-8',
};

// Types servis compressés quand un `.br`/`.gz` précalculé existe à côté du
// fichier (tools/precompress.mjs, lancé par `npm run build`, lionrayonnant/FPVTP#295). Rien n'est
// compressé à la volée : ce serveur tourne aussi dans le process principal
// d'Electron, sans dépendance, et 2,9 Mo de JavaScript compressés par requête
// y coûteraient du CPU pour un résultat identique à chaque fois. Les types
// absents d'ici (chunks .bin, JPEG, Opus) sont déjà compressés par nature.
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.wasm']);
// Ordre de préférence quand le navigateur accepte les deux.
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']];

// Une scène ne change jamais sous son slug (REMOVE puis réacquisition rend le
// même slug, mais alors tout le contenu est réécrit).
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Le manifeste est relu à chaque boot : lui seul doit être revalidé.
const REVALIDATE = 'no-cache';

const SLUG_RE = /^[a-z0-9-]+$/;

function jsonError(res, code, message) {
	const s = JSON.stringify({ error: message });
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(s),
		'cache-control': 'no-store',
	});
	res.end(s);
}

// Un chemin venu du réseau ne sort jamais de sa racine, quoi qu'il contienne :
// on résout, puis on vérifie que le résultat est toujours sous la racine.
function safeJoin(root, rel) {
	const full = path.resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel));
	const base = path.resolve(root);
	if (full !== base && !full.startsWith(base + path.sep)) return null;
	return full;
}

// ETag faible : taille + date de modification suffisent pour des fichiers que
// personne ne réécrit en place, et ne coûtent pas la lecture des 40 Mo d'un
// chunk.
function etagOf(st) {
	return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

// Une seule plage, la seule forme qu'un navigateur envoie pour reprendre un
// téléchargement. Une plage multiple ou illisible est ignorée (réponse
// complète), ce que la RFC autorise ; hors bornes rend 416.
function parseRange(header, size) {
	const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
	if (!m) return null;
	const [, a, b] = m;
	if (a === '' && b === '') return null;
	let start, end;
	if (a === '') {
		const n = Number(b);
		if (!n) return { unsatisfiable: true };
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
		return { unsatisfiable: true };
	}
	return { start, end };
}

// La variante précompressée à servir pour `file`, ou null : encodage accepté
// par le client (Accept-Encoding, jeton nu ou avec q non nul), type
// compressible, fichier `.br`/`.gz` présent ET pas plus vieux que sa source —
// un build partiel qui aurait laissé un vieux `.br` à côté d'un asset neuf
// servirait sinon du code d'une autre version sous un nom immutable.
function precompressedVariant(req, file, st) {
	const ext = path.extname(file).toLowerCase();
	if (!COMPRESSIBLE.has(ext)) return null;
	const accepted = new Set();
	for (const part of String(req.headers['accept-encoding'] ?? '').split(',')) {
		const [token, ...params] = part.trim().split(';').map((s) => s.trim());
		if (!token) continue;
		const q = params.find((p) => p.startsWith('q='));
		if (q && Number(q.slice(2)) === 0) continue;
		accepted.add(token.toLowerCase());
	}
	for (const [encoding, suffix] of ENCODINGS) {
		if (!accepted.has(encoding)) continue;
		let cst;
		try { cst = fs.statSync(file + suffix); } catch { continue; }
		if (!cst.isFile() || cst.mtimeMs < st.mtimeMs) continue;
		return { encoding, file: file + suffix, st: cst };
	}
	return null;
}

function sendFile(req, res, file, st, cacheControl) {
	const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
	// Jamais de compression sur une plage : les offsets d'un Range portent sur
	// la représentation servie, et le seul usage d'un Range ici (reprendre un
	// chunk de scène) ne concerne aucun type compressible de toute façon.
	const variant = req.headers.range ? null : precompressedVariant(req, file, st);
	// Une ETag par représentation (RFC 9110 §8.8.3) : la même valeur pour le
	// clair et le brotli ferait renvoyer un 304 à un client dont le cache tient
	// l'autre encodage.
	const etag = variant ? etagOf(st).replace(/"$/, `-${variant.encoding}"`) : etagOf(st);
	const head = {
		'content-type': type,
		'cache-control': cacheControl,
		etag,
		'accept-ranges': 'bytes',
		'last-modified': new Date(st.mtimeMs).toUTCString(),
	};
	// `Vary` dès que la réponse PEUT dépendre d'Accept-Encoding, compressée ou
	// non : un cache intermédiaire qui aurait vu la version claire ne doit pas
	// la servir à un client qui accepte brotli, ni l'inverse.
	if (COMPRESSIBLE.has(path.extname(file).toLowerCase())) head.vary = 'accept-encoding';
	if (variant) head['content-encoding'] = variant.encoding;

	if (req.headers['if-none-match'] === etag) {
		res.writeHead(304, { etag, 'cache-control': cacheControl, ...(head.vary ? { vary: head.vary } : {}) });
		return res.end();
	}

	if (variant) {
		res.writeHead(200, { ...head, 'content-length': variant.st.size });
		if (req.method === 'HEAD') return res.end();
		return fs.createReadStream(variant.file).pipe(res);
	}

	const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
	if (range?.unsatisfiable) {
		res.writeHead(416, { ...head, 'content-range': `bytes */${st.size}` });
		return res.end();
	}

	if (range) {
		const length = range.end - range.start + 1;
		res.writeHead(206, {
			...head,
			'content-length': length,
			'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
		});
		if (req.method === 'HEAD') return res.end();
		return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
	}

	res.writeHead(200, { ...head, 'content-length': st.size });
	if (req.method === 'HEAD') return res.end();
	return fs.createReadStream(file).pipe(res);
}

export function createStatic({ distDir, paths = defaultPaths } = {}) {
	const dist = path.resolve(distDir);

	return function serveStatic(req, res) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return jsonError(res, 405, `${req.method} non supporté sur un fichier`);
		}

		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		} catch {
			return jsonError(res, 400, 'URL illisible');
		}
		if (pathname.includes('\0')) return jsonError(res, 400, 'URL illisible');

		// scenes.json vit dans le répertoire de données, et une installation
		// neuve n'en a pas encore : un catalogue vide est la bonne réponse, pas
		// un 404 — c'est ce que readScenes() rend déjà côté API.
		if (pathname === '/scenes.json') {
			if (!fs.existsSync(paths.SCENES_JSON)) {
				const s = '[]';
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-length': Buffer.byteLength(s),
					'cache-control': REVALIDATE,
				});
				return res.end(req.method === 'HEAD' ? undefined : s);
			}
			const st = fs.statSync(paths.SCENES_JSON);
			return sendFile(req, res, paths.SCENES_JSON, st, REVALIDATE);
		}

		let file, cacheControl;
		if (pathname.startsWith('/scenes/')) {
			const rel = pathname.slice('/scenes/'.length);
			const slug = rel.split('/')[0];
			if (!SLUG_RE.test(slug)) return jsonError(res, 404, `chemin de scène invalide : ${pathname}`);
			file = safeJoin(paths.SCENES_DIR, rel);
			cacheControl = path.basename(rel) === 'manifest.json' ? REVALIDATE : IMMUTABLE;
		} else {
			file = safeJoin(dist, pathname === '/' ? '/index.html' : pathname);
			// Vite hache le nom de ses assets ; le reste du build (index.html en
			// tête) doit être revalidé, sinon une mise à jour ne se voit jamais.
			cacheControl = pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
		}
		if (!file) return jsonError(res, 404, `hors racine : ${pathname}`);

		let st;
		try { st = fs.statSync(file); }
		catch { return jsonError(res, 404, `${pathname} introuvable`); }
		if (!st.isFile()) return jsonError(res, 404, `${pathname} introuvable`);

		return sendFile(req, res, file, st, cacheControl);
	};
}
