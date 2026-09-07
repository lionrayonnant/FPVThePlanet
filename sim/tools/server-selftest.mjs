// Selftest du serveur autonome (issue #259, tranche T1).
//
// Démarre server/index.mjs sur le port 0, avec un répertoire de données jetable
// et un `dist` factice : rien de ce qui suit ne touche aux scènes, à l'état
// opérateur ni au cache de l'utilisateur.
//
// FPVTP_DATA_DIR est posé AVANT tout import qui remonterait à tools/lib/paths.mjs
// (le contrat du module : la variable est lue à son chargement).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-server-'));
const DIST = path.join(DATA, 'dist');
process.env.FPVTP_DATA_DIR = DATA;
// L'override d'état opérateur des autres selftests n'a rien à faire ici : on
// veut vérifier que le répertoire de données SEUL suffit à tout placer.
delete process.env.FPV_OPERATOR_DIR;

const SLUG = 'testville';
const CHUNK = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 0xff));

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>FPVTP</title>');
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'assets', 'index-abcd1234.js'), 'export const x = 1;\n');
const sceneDir = path.join(DATA, 'scenes', SLUG);
fs.mkdirSync(sceneDir, { recursive: true });
fs.writeFileSync(path.join(sceneDir, 'manifest.json'), JSON.stringify({ chunks: [] }));
fs.writeFileSync(path.join(sceneDir, 'chunk-0.bin'), CHUNK);

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const { startServer, resolveOptions } = await import('../server/index.mjs');

const started = await startServer({ dataDir: DATA, distDir: DIST, port: '0', host: '127.0.0.1' });
const base = started.url.replace(/\/$/, '');

const get = async (p, init) => {
	const r = await fetch(base + p, init);
	return {
		status: r.status,
		type: r.headers.get('content-type') ?? '',
		cache: r.headers.get('cache-control') ?? '',
		range: r.headers.get('content-range') ?? '',
		etag: r.headers.get('etag') ?? '',
		buf: Buffer.from(await r.arrayBuffer()),
	};
};

try {
	// --- le port 0 a bien été résolu ------------------------------------------
	check('port 0 : le serveur choisit un port libre',
		Number.isInteger(started.port) && started.port > 0);

	// --- les chemins suivent le répertoire de données -------------------------
	check('les chemins suivent --data',
		started.paths.SCENES_DIR === path.join(DATA, 'scenes')
		&& started.paths.OPERATOR_DIR === path.join(DATA, 'operator-state'));

	// --- scenes.json dynamique, vide au départ --------------------------------
	const scenes = await get('/scenes.json');
	check('GET /scenes.json : 200 JSON, catalogue vide sur une installation neuve',
		scenes.status === 200 && scenes.type.includes('json') && scenes.buf.toString() === '[]');

	// Celui de public/ ne doit pas s'y substituer : il n'est pas vide sur cette
	// machine, et un `dist` en contient une copie.
	fs.writeFileSync(path.join(DIST, 'scenes.json'), JSON.stringify([{ slug: 'du-dist' }]));
	const shadowed = await get('/scenes.json');
	check('GET /scenes.json : le répertoire de données prime sur dist/',
		shadowed.buf.toString() === '[]');

	// --- pas de repli SPA (issue #275, côté serveur) --------------------------
	const missing = await get('/scenes/' + SLUG + '/pas-la.bin');
	check('un fichier de scène absent rend 404 JSON, jamais text/html',
		missing.status === 404 && missing.type.includes('json') && !missing.type.includes('html')
		&& JSON.parse(missing.buf.toString()).error);

	const missingScene = await get('/scenes/aucune-scene/manifest.json', { method: 'HEAD' });
	check('HEAD sur le manifeste d\'une scène absente : 404, type JSON',
		missingScene.status === 404 && missingScene.type.includes('json'));

	const missingAsset = await get('/assets/pas-la.js');
	check('un asset absent rend 404 JSON, jamais index.html',
		missingAsset.status === 404 && missingAsset.type.includes('json'));

	const escape = await get('/scenes/' + SLUG + '/../../../etc/passwd');
	check('un chemin qui remonte hors de la racine ne sert rien', escape.status === 404);

	// --- le build est bien servi ----------------------------------------------
	const index = await get('/');
	check('GET / sert index.html du dist',
		index.status === 200 && index.type.includes('html') && index.buf.includes('FPVTP'));

	const asset = await get('/assets/index-abcd1234.js');
	check('les assets hachés de Vite sont immutables',
		asset.status === 200 && asset.type.includes('javascript')
		&& asset.cache === 'public, max-age=31536000, immutable');

	// --- cache et Range sur une scène -----------------------------------------
	const chunk = await get(`/scenes/${SLUG}/chunk-0.bin`);
	check('Cache-Control immutable sur /scenes/<slug>/*',
		chunk.status === 200 && chunk.cache === 'public, max-age=31536000, immutable'
		&& chunk.buf.equals(CHUNK));

	const manifest = await get(`/scenes/${SLUG}/manifest.json`);
	check('le manifeste, lui, est revalidé à chaque boot',
		manifest.status === 200 && manifest.type.includes('json') && manifest.cache === 'no-cache');

	const partial = await get(`/scenes/${SLUG}/chunk-0.bin`, { headers: { range: 'bytes=100-199' } });
	check('Range : 206 Partial Content, Content-Range et octets justes',
		partial.status === 206
		&& partial.range === `bytes 100-199/${CHUNK.length}`
		&& partial.buf.length === 100
		&& partial.buf.equals(CHUNK.subarray(100, 200)));

	const tail = await get(`/scenes/${SLUG}/chunk-0.bin`, { headers: { range: 'bytes=4090-' } });
	check('Range ouvert à droite : jusqu\'à la fin du fichier',
		tail.status === 206 && tail.buf.equals(CHUNK.subarray(4090))
		&& tail.range === `bytes 4090-4095/${CHUNK.length}`);

	const beyond = await get(`/scenes/${SLUG}/chunk-0.bin`, { headers: { range: 'bytes=99999-' } });
	check('Range hors bornes : 416 et Content-Range total',
		beyond.status === 416 && beyond.range === `bytes */${CHUNK.length}`);

	const revalidated = await get(`/scenes/${SLUG}/chunk-0.bin`, { headers: { 'if-none-match': chunk.etag } });
	check('ETag faible : un second appel rend 304',
		chunk.etag.startsWith('W/"') && revalidated.status === 304 && revalidated.buf.length === 0);

	// --- l'API répond, et n'est jamais mise en cache --------------------------
	const apiScenes = await get('/__map-api/scenes');
	check('GET /__map-api/scenes : 200 JSON, no-store',
		apiScenes.status === 200 && apiScenes.cache === 'no-store'
		&& Array.isArray(JSON.parse(apiScenes.buf.toString()).scenes));

	const ops = await get('/__operator');
	check('GET /__operator : 200 JSON, no-store, aucun opérateur',
		ops.status === 200 && ops.cache === 'no-store'
		&& JSON.parse(ops.buf.toString()).operators.length === 0);

	const created = await fetch(base + '/__operator', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'servertest' }),
	});
	const createdBody = await created.json();
	check('POST /__operator écrit dans <data>/operator-state',
		created.status === 201
		&& fs.existsSync(path.join(DATA, 'operator-state', `${createdBody.operator.id}.json`)));

	const unknown = await get('/__map-api/route-qui-nexiste-pas');
	check('une route d\'API inconnue rend 404 JSON, pas un fichier',
		unknown.status === 404 && unknown.type.includes('json'));

	const notAllowed = await fetch(base + '/scenes.json', { method: 'DELETE' });
	check('une méthode non supportée sur un fichier rend 405 JSON',
		notAllowed.status === 405 && (notAllowed.headers.get('content-type') ?? '').includes('json'));

	// --- le garde-fou réseau ---------------------------------------------------
	assert.throws(() => resolveOptions({ host: '0.0.0.0' }), /refusé en mode local/);
	check('resolveOptions refuse --host 0.0.0.0 en mode local', true);
	check('… et l\'accepte avec --mode shared',
		resolveOptions({ host: '0.0.0.0', mode: 'shared' }).host === '0.0.0.0');
	check('… et laisse passer la boucle locale',
		resolveOptions({ host: '::1' }).host === '::1');

	// Le vrai processus, pas seulement la fonction : un refus doit SORTIR en
	// erreur explicite, pas planter en silence ni démarrer quand même.
	const refused = spawnSync(process.execPath, ['server/index.mjs', '--host', '0.0.0.0', '--port', '0'], {
		cwd: SIM_ROOT, encoding: 'utf8', env: { ...process.env, FPVTP_DATA_DIR: DATA },
	});
	check('node server/index.mjs --host 0.0.0.0 : sort en erreur, message explicite',
		refused.status === 1 && /refusé en mode local/.test(refused.stderr));

	const badOption = spawnSync(process.execPath, ['server/index.mjs', '--nope'], {
		cwd: SIM_ROOT, encoding: 'utf8', env: { ...process.env, FPVTP_DATA_DIR: DATA },
	});
	check('une option inconnue sort en erreur au lieu de démarrer',
		badOption.status === 2 && /option inconnue/.test(badOption.stderr));
} finally {
	await started.close();
	fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
