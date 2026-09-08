#!/usr/bin/env node
// Précompression du build (#21) : à côté de chaque fichier compressible de
// `dist/`, un `.br` (brotli, qualité maximale) et un `.gz` (gzip 9) que
// server/static.mjs sert avec `content-encoding` quand le navigateur l'accepte.
//
// Pourquoi à la compilation et pas à la volée : le serveur du jeu est écrit
// sans dépendance et tourne aussi dans le process principal d'Electron —
// compresser 2,9 Mo de JavaScript à chaque requête y coûterait des dizaines
// de millisecondes de CPU par client, pour un résultat identique à chaque
// fois. Ici on paie une fois par build, brotli à la qualité 11 (qui serait
// trop lente en ligne) ; la sortie est une vérité figée aux côtés de l'asset
// haché, immutable comme lui.
//
// Seuls les fichiers TEXTE du build sont concernés. Les scènes (chunks .bin,
// planches JPEG, Opus) ne passent pas ici : déjà compressées par nature, et
// servies depuis le répertoire de données, pas depuis dist/.
//
//   node tools/precompress.mjs [dist]
//
// Sortie : une ligne par fichier, et un total. Idempotent : un .br/.gz plus
// récent que sa source est laissé tel quel.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Ce que le serveur sait servir compressé (server/static.mjs : COMPRESSIBLE).
export const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.wasm']);

// En dessous, l'en-tête pèse autant que le gain, et un aller-retour de plus
// ne change rien : on ne produit rien.
const MIN_BYTES = 1024;

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Les scènes copiées depuis public/ (gitignorées, parfois présentes
			// dans un dist local) ne sont jamais servies depuis dist/.
			if (entry.name === 'scenes') continue;
			yield* walk(full);
		} else if (entry.isFile()) yield full;
	}
}

function fresh(src, out) {
	try { return fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs; } catch { return false; }
}

export function precompress(distDir, { log = () => {} } = {}) {
	const dist = path.resolve(distDir);
	let files = 0, raw = 0, br = 0, gz = 0;
	for (const file of walk(dist)) {
		const ext = path.extname(file).toLowerCase();
		if (!COMPRESSIBLE.has(ext)) continue;
		if (ext === '.json' && path.basename(file) === 'scenes.json') continue;   // servi depuis les données, jamais depuis dist/
		const st = fs.statSync(file);
		if (st.size < MIN_BYTES) continue;
		const buf = fs.readFileSync(file);
		files++;
		raw += st.size;
		let bo, go;
		if (fresh(file, file + '.br')) bo = fs.statSync(file + '.br').size;
		else {
			const out = zlib.brotliCompressSync(buf, {
				params: {
					[zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
					[zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
					[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
				},
			});
			fs.writeFileSync(file + '.br', out);
			bo = out.length;
		}
		if (fresh(file, file + '.gz')) go = fs.statSync(file + '.gz').size;
		else {
			const out = zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_COMPRESSION });
			fs.writeFileSync(file + '.gz', out);
			go = out.length;
		}
		br += bo; gz += go;
		log(`  ${path.relative(dist, file)}  ${kb(st.size)} → br ${kb(bo)}, gz ${kb(go)}`);
	}
	log(`precompress : ${files} fichier(s), ${kb(raw)} → br ${kb(br)}, gz ${kb(gz)}`);
	return { files, raw, br, gz };
}

function kb(n) { return `${(n / 1024).toFixed(1)} Kio`; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dist = process.argv[2] ?? path.join(SIM_ROOT, 'dist');
	if (!fs.existsSync(dist)) {
		console.error(`precompress : ${dist} introuvable — lancez \`vite build\` d'abord`);
		process.exit(1);
	}
	precompress(dist, { log: console.log });
}
