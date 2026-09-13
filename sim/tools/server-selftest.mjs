// Selftest du serveur autonome (issue #259, tranches T1 et T3).
//
// T3 y ajoute les deux mécanismes de #60, et les garde SÉPARÉS : la clé
// d'opérateur (qui parle) et FPVTP_ACQUIRE (ce qui a le droit de naître sur
// disque). Le mode `shared` est exercé sur un SECOND serveur, démarré après la
// fermeture du premier : api.mjs tient son mode en état de module — un seul
// serveur par processus, comme pour les chemins.
//
// Démarre server/index.mjs sur le port 0, avec un répertoire de données jetable
// et un `dist` factice : rien de ce qui suit ne touche aux scènes, à l'état
// opérateur ni au cache de l'utilisateur.
//
// FPVTP_DATA_DIR est posé AVANT tout import qui remonterait à tools/lib/paths.mjs
// (le contrat du module : la variable est lue à son chargement).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
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
// Un asset assez gros pour être précompressé (#21), passé par le VRAI outil ;
// et un asset dont le .br est plus VIEUX que la source (build partiel).
const BIG = Buffer.from(Array.from({ length: 200 }, (_, i) => `export const v${i} = ${'x'.repeat(40)};\n`).join(''));
fs.writeFileSync(path.join(DIST, 'assets', 'big-abcd1234.js'), BIG);
const { precompress } = await import('./precompress.mjs');
const compressed = precompress(DIST);
const BIG_BR = fs.readFileSync(path.join(DIST, 'assets', 'big-abcd1234.js.br'));
const BIG_GZ = fs.readFileSync(path.join(DIST, 'assets', 'big-abcd1234.js.gz'));
// Posé APRÈS precompress (qui l'aurait régénéré) : le .br date d'une minute,
// la source est neuve — c'est le serveur qui doit l'écarter, pas l'outil.
const STALE_SRC = 'export const fresh = true;\n' + '// '.padEnd(2000, '=') + '\n';
const stalePath = path.join(DIST, 'assets', 'stale-abcd1234.js');
fs.writeFileSync(stalePath + '.br', zlib.brotliCompressSync(Buffer.from('export const OLD = true;\n')));
const old = new Date(Date.now() - 60_000);
fs.utimesSync(stalePath + '.br', old, old);
fs.writeFileSync(stalePath, STALE_SRC);
const sceneDir = path.join(DATA, 'scenes', SLUG);
fs.mkdirSync(sceneDir, { recursive: true });
fs.writeFileSync(path.join(sceneDir, 'manifest.json'), JSON.stringify({ chunks: [] }));
fs.writeFileSync(path.join(sceneDir, 'chunk-0.bin'), CHUNK);

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const { startServer, resolveOptions } = await import('../server/index.mjs');

// Le drapeau d'acquisition se lit à CHAQUE requête : ces tests le posent et le
// retirent en cours de route, sans redémarrer quoi que ce soit.
delete process.env.FPVTP_ACQUIRE;

let started = await startServer({ dataDir: DATA, distDir: DIST, port: '0', host: '127.0.0.1' });
const base = started.url.replace(/\/$/, '');
let shared = null;

const at = (b) => async (p, init) => {
	const r = await fetch(b + p, init);
	return {
		status: r.status,
		type: r.headers.get('content-type') ?? '',
		cache: r.headers.get('cache-control') ?? '',
		range: r.headers.get('content-range') ?? '',
		etag: r.headers.get('etag') ?? '',
		encoding: r.headers.get('content-encoding') ?? '',
		vary: r.headers.get('vary') ?? '',
		length: r.headers.get('content-length') ?? '',
		buf: Buffer.from(await r.arrayBuffer()),
	};
};
const get = at(base);
const bodyOf = (r) => { try { return JSON.parse(r.buf.toString()); } catch { return {}; } };
const bearer = (k) => ({ authorization: `Bearer ${k}` });

// `Host`, `Origin` and `Sec-Fetch-Site` are exactly the headers a browser will
// not let a page set — and fetch() guards them too. node:http sends whatever it
// is given, which is what playing the attacker of #79 needs.
const raw = (b) => (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
	const u = new URL(b + p);
	const req = http.request({
		hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
	}, (res) => {
		let text = '';
		res.setEncoding('utf8');
		res.on('data', (d) => { text += d; });
		res.on('end', () => resolve({
			status: res.statusCode, text,
			body: (() => { try { return JSON.parse(text); } catch { return {}; } })(),
		}));
	});
	req.on('error', reject);
	if (body !== undefined) req.write(body);
	req.end();
});

try {
	// --- le port 0 a bien été résolu ------------------------------------------
	check('port 0 : le serveur choisit un port libre',
		Number.isInteger(started.port) && started.port > 0);

	// --- precompress (#21) : ce qu'il produit, et ce qu'il laisse tranquille --
	check('precompress : big.js (> 1 Kio) compressé en .br et .gz, les petits fichiers laissés tels quels',
		compressed.files === 1
		&& BIG_BR.length < BIG.length && BIG_GZ.length < BIG.length
		&& !fs.existsSync(path.join(DIST, 'assets', 'index-abcd1234.js.br'))
		&& !fs.existsSync(path.join(DIST, 'index.html.br')));

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

	// --- précompression (#21) -------------------------------------------------
	// tools/precompress.mjs a posé un .br et un .gz à côté de big.js (voir le
	// dist factice plus haut). fetch() de Node décode lui-même le corps : on
	// juge donc sur les en-têtes ET sur le corps décodé, qui doit être le clair.
	const plain = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'identity' } });
	check('sans Accept-Encoding compressible : le clair, avec Vary',
		plain.status === 200 && plain.encoding === '' && plain.vary === 'accept-encoding'
		&& plain.buf.equals(BIG) && plain.length === String(BIG.length));

	const brotli = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
	check('Accept-Encoding: br : le .br précalculé, content-encoding, taille du .br',
		brotli.status === 200 && brotli.encoding === 'br' && brotli.vary === 'accept-encoding'
		&& brotli.length === String(BIG_BR.length) && brotli.buf.equals(BIG)
		&& brotli.cache === 'public, max-age=31536000, immutable');

	const gzipped = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'gzip' } });
	check('Accept-Encoding: gzip seul : le .gz',
		gzipped.status === 200 && gzipped.encoding === 'gzip' && gzipped.length === String(BIG_GZ.length) && gzipped.buf.equals(BIG));

	const zeroQ = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } });
	check('q=0 refuse un encodage : le clair', zeroQ.status === 200 && zeroQ.encoding === '' && zeroQ.buf.equals(BIG));

	check('une ETag par représentation : clair et brotli ne partagent pas la même',
		plain.etag && brotli.etag && plain.etag !== brotli.etag && brotli.etag.endsWith('-br"'));
	const brotli304 = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'br', 'if-none-match': brotli.etag } });
	const cross = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'br', 'if-none-match': plain.etag } });
	check('If-None-Match : 304 sur l\'ETag de SA représentation, 200 sur celle de l\'autre',
		brotli304.status === 304 && cross.status === 200 && cross.encoding === 'br');

	const ranged = await get('/assets/big-abcd1234.js', { headers: { 'accept-encoding': 'br', range: 'bytes=0-9' } });
	check('un Range n\'est jamais servi compressé',
		ranged.status === 206 && ranged.encoding === '' && ranged.buf.equals(BIG.subarray(0, 10)));

	const stale = await get('/assets/stale-abcd1234.js', { headers: { 'accept-encoding': 'br' } });
	check('un .br plus vieux que sa source est ignoré (build partiel) : le clair',
		stale.status === 200 && stale.encoding === '' && stale.buf.toString() === STALE_SRC);

	const binary = await get(`/scenes/${SLUG}/chunk-0.bin`, { headers: { 'accept-encoding': 'br, gzip' } });
	check('un type non compressible n\'a ni content-encoding ni Vary',
		binary.status === 200 && binary.encoding === '' && binary.vary === '');

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

	// --- the ceiling on how much work one zone may ask for --------------------
	//
	// requireBox/requirePoly bound the shape, not its size: a legal ring is up
	// to 180° x 170°, and polygonGrid then walks cols x rows. On a
	// single-process server those seconds are seconds nobody else is served.
	// The gate must refuse BEFORE allocating, so the refusal is also fast.
	const postApi = (p, b) => fetch(base + '/__map-api' + p, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
	});
	const square = (lat, lon, deg) => [lat, lon, lat + deg, lon, lat + deg, lon + deg, lat, lon + deg];

	{
		const t0 = Date.now();
		const huge = await postApi('/describe', { poly: square(0, 0, 4), zoom: 20 });
		const ms = Date.now() - t0;
		const body = await huge.json();
		check('describe: a 4° ring at zoom 20 is refused, not computed',
			huge.status === 400 && /zone too large/.test(body.error ?? ''));
		// The message has to say what the limit IS: "too large" alone leaves the
		// caller guessing how much to shrink by.
		check('… and the refusal names both the count and the limit',
			/135,862,311 tiles/.test(body.error ?? '') && /4,000,000/.test(body.error ?? ''));
		check('… and it refuses fast (no grid was allocated)', ms < 1000);

		// Same ceiling on the bbox shape, and on the three other routes.
		check('describe: the bbox shape is bounded too',
			(await postApi('/describe', { bbox: { south: 0, west: 0, north: 8, east: 8 }, zoom: 20 })).status === 400);
		check('plan: bounded before it can fan out to the provider',
			(await postApi('/plan', { poly: square(0, 0, 4), zoom: 20 })).status === 400);
		check('probe: bounded before it can fan out to the provider',
			(await postApi('/probe', { poly: square(0, 0, 4), zoom: 20 })).status === 400);
		// /jobs is gated by acquireEnabled first, so it answers 403 here rather
		// than 400 — what matters is that it does not do the work either.
		check('jobs: an oversized zone never reaches startJob',
			[400, 403].includes((await postApi('/jobs', { name: 'x', poly: square(0, 0, 4), zoom: 20 })).status));
	}

	{
		// The zones that actually exist must be untouched. `add-map --radius 25`
		// is 51 x 51 tiles; radius 35 is 71 x 71. Both are far below the ceiling
		// and must still come back with their mask.
		const ok = await postApi('/describe', { poly: square(48.85, 2.29, 0.0113), zoom: 20 });
		const body = await ok.json();
		check('describe: a real zone (~1.25 km, the add-map default) still passes',
			ok.status === 200 && body.grid.cols * body.grid.rows < 4_000_000);
		check('… and still carries its mask, so the staircase is still drawn',
			Array.isArray(body.grid.keep) && body.grid.keep.length === body.grid.cols * body.grid.rows);

		// Below the ceiling but far past anything drawable: the mask is dropped
		// rather than shipped, and the client falls back to the bounding box.
		// The figures on the rail come from `masked`/`columns`, which stay.
		const wide = await postApi('/describe', { poly: square(48.85, 2.29, 0.36), zoom: 20 });
		const wideBody = await wide.json();
		check('describe: a zone past the mask ceiling drops keep, keeps the figures',
			wide.status === 200 && wideBody.grid.keep === undefined
			&& Number.isFinite(wideBody.grid.masked) && Number.isFinite(wideBody.grid.columns));
	}

	const notAllowed = await fetch(base + '/scenes.json', { method: 'DELETE' });
	check('une méthode non supportée sur un fichier rend 405 JSON',
		notAllowed.status === 405 && (notAllowed.headers.get('content-type') ?? '').includes('json'));

	// --- security response headers --------------------------------------------
	//
	// Set once in server/index.mjs, before the API and the file server see the
	// request, so the test is that they reach EVERY kind of response — a
	// document, a scene chunk, an API answer and an error alike. A per-route
	// header is one a route can forget.
	{
		const hdr = async (p) => (await fetch(base + p)).headers;
		const doc = await hdr('/');
		const api = await hdr('/__map-api/scenes');
		const err = await hdr('/definitely-not-here.html');
		for (const [name, want] of Object.entries({
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			// NOT no-referrer: OpenStreetMap's tile policy needs a Referer or an
			// identifying User-Agent, and stripping it got every basemap tile 403'd
			// in production. Same-origin still sends the full URL, so the scene slug
			// and the build seed stay in.
			'referrer-policy': 'strict-origin-when-cross-origin',
			'cross-origin-opener-policy': 'same-origin',
		})) {
			check(`${name} is set on the document, the API and an error alike`,
				doc.get(name) === want && api.get(name) === want && err.get(name) === want);
		}

		// Report-Only, deliberately: the policy has never been exercised in a
		// browser, and a wrong enforced policy is a black screen. See the note
		// in server/headers.mjs for what turns it into an enforced one.
		const csp = doc.get('content-security-policy-report-only') ?? '';
		check('the document carries a Content-Security-Policy, in Report-Only',
			csp.length > 0 && doc.get('content-security-policy') === null);
		// The directives the app genuinely needs. Each of these was read off the
		// source, and getting one wrong is what breaks the game on launch day.
		check('… whose script-src allows WASM (Rapier) and the inline WebGL2 probe',
			/script-src [^;]*'wasm-unsafe-eval'/.test(csp) && /script-src [^;]*'unsafe-inline'/.test(csp));
		check('… whose connect-src allows the terrain and the search',
			/connect-src [^;]*https:\/\/kh\.google\.com/.test(csp)
			&& /connect-src [^;]*https:\/\/nominatim\.openstreetmap\.org/.test(csp));
		check('… whose img-src allows the three basemaps of src/map-layers.js',
			/img-src [^;]*tile\.openstreetmap\.org/.test(csp)
			&& /img-src [^;]*tile\.opentopomap\.org/.test(csp)
			&& /img-src [^;]*server\.arcgisonline\.com/.test(csp));
		check('… whose worker-src allows the module workers',
			/worker-src 'self' blob:/.test(csp));
		check('… and which forbids framing, base rewriting and plugins',
			/frame-ancestors 'none'/.test(csp) && /base-uri 'none'/.test(csp)
			&& /object-src 'none'/.test(csp));

		// A .bin chunk is not a browsing context: the ~400-byte policy has no
		// business riding on responses a scene fetches by the thousand.
		const chunk = await hdr(`/scenes/${SLUG}/manifest.json`);
		check('the document policy does NOT ride on scene data',
			chunk.get('content-security-policy-report-only') === null
			&& chunk.get('x-content-type-options') === 'nosniff');
	}

	// --- le garde-fou réseau ---------------------------------------------------
	assert.throws(() => resolveOptions({ host: '0.0.0.0' }), /refused in local mode/);
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
		refused.status === 1 && /refused in local mode/.test(refused.stderr));

	const badOption = spawnSync(process.execPath, ['server/index.mjs', '--nope'], {
		cwd: SIM_ROOT, encoding: 'utf8', env: { ...process.env, FPVTP_DATA_DIR: DATA },
	});
	check('une option inconnue sort en erreur au lieu de démarrer',
		badOption.status === 2 && /unknown option/.test(badOption.stderr));

	// ================= issue #79: where the request comes FROM =================
	//
	// In `local` there is no key: the boundary is the loopback socket, and a
	// browser crosses it for any page the developer visits. Two guards
	// (server/origin.mjs), both on headers a page cannot forge.
	const rawLocal = raw(base);

	// DNS rebinding: the name flips to 127.0.0.1 and the attacker page becomes
	// same-origin — but `Host` still carries the attacker's name.
	check('local: a foreign Host (DNS rebinding) is refused on /__map-api',
		(await rawLocal('/__map-api/scenes', { headers: { host: 'attacker.example' } })).status === 403);
	check('local: … and on /__operator, where the data is',
		(await rawLocal('/__operator', { headers: { host: 'attacker.example' } })).status === 403);
	check('local: loopback passes — 127.0.0.2 and localhost included',
		(await rawLocal('/__map-api/scenes')).status === 200
		&& (await rawLocal('/__map-api/scenes', { headers: { host: `127.0.0.2:${started.port}` } })).status === 200
		&& (await rawLocal('/__map-api/scenes', { headers: { host: `localhost:${started.port}` } })).status === 200);
	// The guard covers the API, not the file server: those are the same bytes
	// for everyone, and in dev Vite has its own host check for them.
	check('local: a static file is not concerned',
		(await rawLocal('/scenes.json', { headers: { host: 'attacker.example' } })).status === 200);

	// CSRF: a simple request (no preflight) goes through whether or not its
	// answer can be read — writing is enough.
	const csrf = (headers, body = JSON.stringify({ name: 'csrf' })) => rawLocal('/__operator', {
		method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
	});
	check('local: a cross-site POST is refused (Sec-Fetch-Site)',
		(await csrf({ 'sec-fetch-site': 'cross-site' })).status === 403);
	check('local: a same-site POST (a sibling subdomain) too',
		(await csrf({ 'sec-fetch-site': 'same-site' })).status === 403);
	check('local: a foreign Origin is refused',
		(await csrf({ origin: 'https://attacker.example' })).status === 403);
	check('local: Origin null (sandboxed iframe, file://) is refused',
		(await csrf({ origin: 'null' })).status === 403);
	check('local: a cross-site DELETE is refused like a POST',
		(await rawLocal(`/__map-api/scenes/${SLUG}`, {
			method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' },
		})).status === 403);
	// POSITIVE control: the game's own page still writes.
	check('local: the game page passes — same-origin, and its Origin is the Host',
		(await csrf({ 'sec-fetch-site': 'same-origin', origin: base })).status === 201);
	// A cross-site READ is deliberately not blocked: the Host check above closes
	// rebinding, and without CORS headers the answer stays unreadable anyway.
	check('local: a cross-site read from the right host is not blocked',
		(await rawLocal('/__map-api/scenes', { headers: { 'sec-fetch-site': 'cross-site' } })).status === 200);

	// The second lock: a simple POST cannot carry application/json.
	check('local: a text/plain body is refused (simple POST, no preflight)',
		(await csrf({ 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' })).status === 400);
	check('local: a body with no Content-Type is refused too (Blob of empty type)',
		(await rawLocal('/__operator', {
			method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'blob' }),
		})).status === 400);

	// ================= issue #78: removing is a LOCAL operation ================
	//
	// POSITIVE control in `local`: the guard lets it through and the empty
	// catalogue is what stops the request. The `shared` 403 is further down.
	const gone = await rawLocal(`/__map-api/scenes/${SLUG}`, { method: 'DELETE' });
	check('local: DELETE /__map-api/scenes/<slug> is not gated — 404, empty catalogue',
		gone.status === 404 && /no map/.test(gone.body.error ?? ''));
	check('local: DELETE /__map-api/jobs/<id> neither — 404, unknown job',
		(await rawLocal('/__map-api/jobs/00000000-0000-0000-0000-000000000000', { method: 'DELETE' })).status === 404);

	// ================= issue #60 : la clé d'opérateur =========================
	//
	// Mécanisme 1 : QUI parle au serveur. En `local`, personne ne le demande.

	check('POST /__operator rend une clé, une seule fois, groupée par 4',
		typeof createdBody.key === 'string'
		&& /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{2,4}){5,6}$/.test(createdBody.key));

	const opFile = path.join(DATA, 'operator-state', `${createdBody.operator.id}.json`);
	const onDisk = fs.readFileSync(opFile, 'utf8');
	check('la clé n\'est PAS sur disque en clair — seulement son empreinte',
		!onDisk.includes(createdBody.key)
		&& !onDisk.includes(createdBody.key.replace(/-/g, ''))
		&& /"keyHash": "[0-9a-f]{64}"/.test(onDisk));

	const reread = await get(`/__operator/${createdBody.operator.id}`);
	check('… et elle n\'est jamais relue : ni `key`, ni `keyHash` dans la réponse',
		reread.status === 200 && bodyOf(reread).key === undefined
		&& bodyOf(reread).operator.keyHash === undefined
		&& createdBody.operator.keyHash === undefined);

	const noKeyLocal = await get(`/__operator/${createdBody.operator.id}`, { headers: bearer('N1MP-0RT3-QU01') });
	check('en `local`, une clé fausse est IGNORÉE : la frontière reste le socket',
		noKeyLocal.status === 200);

	// Mécanisme 2 : QUI a le droit de faire naître une scène sur disque.
	// Indépendant du premier — un serveur `local` authentifie personne et
	// n'acquiert pourtant pas sans le drapeau.

	const postJob = (b, headers = {}) => at(b)('/__map-api/jobs', {
		method: 'POST',
		headers: { ...headers, 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});

	check('local, drapeau absent : GET /__map-api/scenes annonce acquire:false',
		bodyOf(await get('/__map-api/scenes')).acquire === false);
	// V1 : le MODE voyage avec la liste. C'est lui qui décide du pied du
	// terminal et de l'avis de l'onglet LOCAL — l'acquisition fermée d'une
	// build distribuée n'en fait pas un serveur partagé.
	check('… et annonce mode:"local" avec',
		bodyOf(await get('/__map-api/scenes')).mode === 'local');

	const closedJob = await postJob(base);
	check('local, drapeau absent : POST /__map-api/jobs refuse (403)',
		closedJob.status === 403 && /disabled/.test(bodyOf(closedJob).error ?? ''));

	process.env.FPVTP_ACQUIRE = '1';
	check('local, FPVTP_ACQUIRE=1 : GET /__map-api/scenes annonce acquire:true',
		bodyOf(await get('/__map-api/scenes')).acquire === true);

	// Contrôle POSITIF : la garde a bien laissé passer, et c'est le corps vide
	// qui arrête maintenant la requête. Sans lui, un 403 devenu 400 pour une
	// tout autre raison passerait pour un succès.
	const openedJob = await postJob(base);
	check('local, FPVTP_ACQUIRE=1 : la garde s\'ouvre — POST /jobs cale sur le corps, pas sur elle',
		openedJob.status === 400 && !/disabled/.test(bodyOf(openedJob).error ?? ''));

	check('FPVTP_ACQUIRE=nimportequoi ne vaut pas vrai',
		(process.env.FPVTP_ACQUIRE = 'oui', bodyOf(await get('/__map-api/scenes')).acquire === false));
	check('FPVTP_ACQUIRE=true, lui, ouvre',
		(process.env.FPVTP_ACQUIRE = 'TRUE', bodyOf(await get('/__map-api/scenes')).acquire === true));

	// --- inscription en libre service : les deux plafonds ---------------------
	//
	// En `local`, ni l'un ni l'autre ne s'applique — c'est le point.
	const signup = (b, name, headers = {}) => fetch(b + '/__operator', {
		method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
		body: JSON.stringify({ name }),
	});

	const { SIGNUP_MAX, OPERATOR_BYTES_MAX, clientIp } = await import('../server/auth.mjs');

	// Behind Caddy, `remoteAddress` is always the loopback: only
	// x-forwarded-for identifies the requester. In `local` it would be
	// forgeable by the client, so it is NOT read.
	const proxied = { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } };
	check('x-forwarded-for is only read in `shared`',
		clientIp(proxied, 'shared') === '203.0.113.7' && clientIp(proxied, 'local') === '127.0.0.1');

	// The proxy APPENDS the peer it is really talking to, so the last hop is
	// the only entry we trust; everything to its left is text the client chose.
	// Reading the first entry would let a client pick its own rate-limit key.
	const forged = {
		headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.4' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	check('x-forwarded-for multi-hop: the LAST hop is the client, not the first',
		clientIp(forged, 'shared') === '198.51.100.4');
	// No header at all (no proxy in front): fall back to the real socket.
	// Behind a CDN the last hop is the CDN's own edge, so CF-Connecting-IP is
	// the only thing that still names the visitor. It is read ONLY when the
	// operator has declared the topology: the header is forgeable by anyone who
	// can reach the origin directly, so trusting its mere presence would undo
	// the multi-hop fix above.
	const cf = {
		headers: { 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': '172.68.0.1' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	check('cf-connecting-ip is ignored unless FPVTP_TRUST_CF_IP says otherwise',
		clientIp(cf, 'shared') === '172.68.0.1');

	{
		const before = process.env.FPVTP_TRUST_CF_IP;
		process.env.FPVTP_TRUST_CF_IP = '1';
		const fresh = await import(`../server/auth.mjs?cf=${Date.now()}`);
		check('with the flag set, cf-connecting-ip wins over the CDN edge address',
			fresh.clientIp(cf, 'shared') === '203.0.113.50');
		check('with the flag set, `local` still reads no header at all',
			fresh.clientIp(cf, 'local') === '127.0.0.1');
		check('with the flag set but no CF header, the last hop is still used',
			fresh.clientIp({ headers: { 'x-forwarded-for': 'a, 198.51.100.9' }, socket: {} }, 'shared') === '198.51.100.9');
		if (before === undefined) delete process.env.FPVTP_TRUST_CF_IP;
		else process.env.FPVTP_TRUST_CF_IP = before;
	}

	check('x-forwarded-for absent: falls back to remoteAddress',
		clientIp({ headers: {}, socket: { remoteAddress: '198.51.100.9' } }, 'shared') === '198.51.100.9');

	let localCodes = [];
	for (let i = 0; i < SIGNUP_MAX + 2; i++) localCodes.push((await signup(base, `flood${i}`)).status);
	check(`local : ${SIGNUP_MAX + 2} inscriptions d'affilée passent toutes — aucun plafond`,
		localCodes.every((c) => c === 201));

	// --- un opérateur d'avant #60 : aucun keyHash, et il doit rester intact ---
	const LEGACY = 'legacy-0001';
	fs.writeFileSync(path.join(DATA, 'operator-state', `${LEGACY}.json`), JSON.stringify({
		schemaVersion: 2, id: LEGACY, name: 'legacy', createdAt: '2026-01-01T00:00:00.000Z',
		settings: {}, terrainCache: [], sessions: [],
		sessionSeq: 0, targetSeq: 0, worldState: {},
	}, null, '\t'));
	const legacyLocal = await get(`/__operator/${LEGACY}`);
	check('migration : un fichier sans clé reste parfaitement utilisable en `local`',
		legacyLocal.status === 200 && bodyOf(legacyLocal).operator.id === LEGACY);

	// ================= le mode `shared` =======================================
	//
	// Un SECOND serveur : api.mjs tient son mode en état de module.
	await started.close();
	started = null;

	shared = await startServer({ dataDir: DATA, distDir: DIST, port: '0', host: '127.0.0.1', mode: 'shared' });
	const sbase = shared.url.replace(/\/$/, '');
	const sget = at(sbase);
	const KEY = createdBody.key;
	const ID = createdBody.operator.id;

	check('shared : GET /__operator rend 404 — pas de liste publique',
		(await sget('/__operator', { headers: bearer(KEY) })).status === 404);

	check('shared : /__operator/:id sans clé → 401',
		(await sget(`/__operator/${ID}`)).status === 401);
	check('shared : /__operator/:id avec une mauvaise clé → 403',
		(await sget(`/__operator/${ID}`, { headers: bearer('N1MP-0RT3-QU01') })).status === 403);
	const good = await sget(`/__operator/${ID}`, { headers: bearer(KEY) });
	check('shared : /__operator/:id avec la bonne clé → 200',
		good.status === 200 && bodyOf(good).operator.id === ID);

	check('shared : la clé d\'un opérateur n\'ouvre pas celui d\'un autre → 403',
		(await sget(`/__operator/${LEGACY}`, { headers: bearer(KEY) })).status === 403);

	check('shared : /__map-api/* sans clé → 401',
		(await sget('/__map-api/scenes')).status === 401);
	check('shared : /__map-api/* avec une mauvaise clé → 403',
		(await sget('/__map-api/scenes', { headers: bearer('N1MP-0RT3-QU01') })).status === 403);

	// La clé est tolérante à la frappe : minuscules, espaces, tirets en trop.
	check('shared : la clé se retape en minuscules et sans tirets',
		(await sget(`/__operator/${ID}`, { headers: bearer(KEY.replace(/-/g, '').toLowerCase()) })).status === 200);

	// whoami : retrouver son opérateur depuis un autre navigateur, où aucune
	// liste ne dit qui existe.
	const who = await sget('/__operator/whoami', { headers: bearer(KEY) });
	check('shared : GET /__operator/whoami rend l\'opérateur que la clé désigne',
		who.status === 200 && bodyOf(who).operator.id === ID);
	check('shared : whoami sur une clé inconnue → 403 (la garde passe avant)',
		(await sget('/__operator/whoami', { headers: bearer('N1MP-0RT3-QU01') })).status === 403);

	// L'inscription reste ouverte : sans elle, personne ne pourrait jamais
	// arriver sur le VPS.
	const newOp = await fetch(sbase + '/__operator', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'sharedtest' }),
	});
	const newBody = await newOp.json();
	check('shared : POST /__operator reste ouvert sans clé, et rend la clé neuve',
		newOp.status === 201 && typeof newBody.key === 'string' && newBody.key !== KEY);
	check('shared : la clé neuve ouvre son opérateur, tout de suite',
		(await sget(`/__operator/${newBody.operator.id}`, { headers: bearer(newBody.key) })).status === 200);

	// --- l'acquisition, en `shared` : fermée MÊME avec le drapeau posé --------
	process.env.FPVTP_ACQUIRE = '1';
	check('shared, FPVTP_ACQUIRE=1 : GET /__map-api/scenes annonce quand même acquire:false',
		bodyOf(await sget('/__map-api/scenes', { headers: bearer(KEY) })).acquire === false);
	const sharedJob = await postJob(sbase, bearer(KEY));
	check('shared, FPVTP_ACQUIRE=1, clé valide : POST /__map-api/jobs refuse quand même (403)',
		sharedJob.status === 403 && /disabled/.test(bodyOf(sharedJob).error ?? ''));
	delete process.env.FPVTP_ACQUIRE;
	check('shared : GET /__map-api/scenes annonce mode:"shared"',
		bodyOf(await sget('/__map-api/scenes', { headers: bearer(KEY) })).mode === 'shared');
	check('shared, drapeau absent : acquire:false, et POST /jobs 403',
		bodyOf(await sget('/__map-api/scenes', { headers: bearer(KEY) })).acquire === false
		&& (await postJob(sbase, bearer(KEY))).status === 403);

	// --- issue #78: one player does not delete everybody's map ----------------
	//
	// Signup is self-service and there is neither role nor ownership: a valid
	// key must therefore not be enough to erase a scene for the whole instance
	// — all the more so as it could not be rebuilt, acquisition being closed in
	// `shared`. The scene is listed in the catalogue on purpose: the refusal has
	// to be the guard, not a 404.
	fs.writeFileSync(path.join(DATA, 'scenes.json'), JSON.stringify([{ slug: SLUG, name: 'Testville' }], null, '\t'));
	check('shared: the scene is indeed in the catalogue',
		bodyOf(await sget('/__map-api/scenes', { headers: bearer(KEY) })).scenes.some((s) => s.slug === SLUG));
	const wipe = await sget(`/__map-api/scenes/${SLUG}?raw=1`, { method: 'DELETE', headers: bearer(KEY) });
	check('shared: DELETE /__map-api/scenes/<slug> with a valid key is refused (403)',
		wipe.status === 403 && /disabled/.test(bodyOf(wipe).error ?? ''));
	check('… and nothing on disk was touched',
		fs.existsSync(path.join(sceneDir, 'chunk-0.bin'))
		&& JSON.parse(fs.readFileSync(path.join(DATA, 'scenes.json'), 'utf8')).length === 1);
	check('shared: DELETE /__map-api/jobs/<id> is refused too (403), before even looking the job up',
		(await sget('/__map-api/jobs/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE', headers: bearer(KEY),
		})).status === 403);

	// --- le plafond d'inscriptions, en `shared` ------------------------------
	//
	// Chaque adresse a son propre compteur : deux x-forwarded-for différents ne
	// se gênent pas, et la 6e depuis la MÊME adresse est refusée.
	const IP_A = '203.0.113.7';
	const codes = [];
	for (let i = 0; i < SIGNUP_MAX + 1; i++) {
		codes.push((await signup(sbase, `flood${i}`, { 'x-forwarded-for': IP_A })).status);
	}
	check(`shared : les ${SIGNUP_MAX} premières inscriptions d'une adresse passent`,
		codes.slice(0, SIGNUP_MAX).every((c) => c === 201));
	const over = await signup(sbase, 'detrop', { 'x-forwarded-for': IP_A });
	const overBody = await over.json();
	check('shared : la suivante rend 429, avec un message lisible',
		over.status === 429 && /too many signups/.test(overBody.error ?? '')
		&& /min/.test(overBody.error ?? ''));
	check('shared : une AUTRE adresse a son propre compteur',
		(await signup(sbase, 'ailleurs', { 'x-forwarded-for': '203.0.113.99' })).status === 201);
	// Multi-hop x-forwarded-for: the proxy APPENDS the peer, so the LAST entry
	// is the client and everything left of it is client-supplied text. IP_A is
	// already over its ceiling above, which makes the two directions testable.
	//
	// Forging a leading hop must not let the real address escape its counter:
	// `<anything>, IP_A` is still IP_A, still 429.
	check('shared: a forged leading hop does not escape the counter — the last hop wins',
		(await signup(sbase, 'forged', { 'x-forwarded-for': `198.51.100.1, ${IP_A}` })).status === 429);
	// And the mirror image: an exhausted address in the FIRST position must not
	// be charged to the real peer, which is a fresh address and must pass.
	check('shared: an exhausted address in the first position is not charged',
		(await signup(sbase, 'realpeer', { 'x-forwarded-for': `${IP_A}, 198.51.100.2` })).status === 201);

	// --- le quota d'octets par opérateur -------------------------------------
	//
	// Le VOL n'est jamais bloqué : seule la capture l'est, parce que c'est la
	// seule écriture dont la taille dépende du client.
	const fat = JSON.parse(await (await signup(sbase, 'gras', { 'x-forwarded-for': '203.0.113.50' })).text());
	const fatFile = path.join(DATA, 'operator-state', `${fat.operator.id}.json`);
	const opened = await fetch(`${sbase}/__operator/${fat.operator.id}/sessions`, {
		method: 'POST', headers: { ...bearer(fat.key), 'content-type': 'application/json' },
		body: JSON.stringify({ area: SLUG }),
	});
	const sid = (await opened.json()).session?.id;
	check('shared : ouvrir une session passe, quota ou pas', opened.status === 201 && Boolean(sid));

	const photo = (k, i) => fetch(`${sbase}/__operator/${fat.operator.id}/sessions/${sid}/photos`, {
		method: 'POST', headers: { ...bearer(k), 'content-type': 'application/json' },
		body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${'A'.repeat(2048 + i)}`, w: 320, h: 180 }),
	});
	check('shared : sous le plafond, une capture passe', (await photo(fat.key, 0)).status === 201);

	// On gonfle le fichier au-delà du plafond sans passer par mille requêtes :
	// c'est la TAILLE SUR DISQUE que la garde regarde.
	const bloated = JSON.parse(fs.readFileSync(fatFile, 'utf8'));
	bloated.settings = { padding: 'x'.repeat(OPERATOR_BYTES_MAX) };
	fs.writeFileSync(fatFile, JSON.stringify(bloated, null, '\t'));
	check(`le fichier dépasse bien ${Math.round(OPERATOR_BYTES_MAX / 1e6)} Mo`,
		fs.statSync(fatFile).size > OPERATOR_BYTES_MAX);

	const refusedPhoto = await photo(fat.key, 1);
	check('shared : au-delà du plafond, la capture est refusée (413) et le dit',
		refusedPhoto.status === 413 && /quota reached/.test((await refusedPhoto.json()).error ?? ''));
	const closed = await fetch(`${sbase}/__operator/${fat.operator.id}/sessions/${sid}`, {
		method: 'PATCH', headers: { ...bearer(fat.key), 'content-type': 'application/json' },
		body: JSON.stringify({ result: 'CRASHED', end: new Date().toISOString() }),
	});
	check('shared : le quota ne bloque JAMAIS le vol — la session se clôt quand même',
		closed.status === 200);

	// --- migration : la commande `key` ---------------------------------------
	check('shared : l\'opérateur d\'avant #60 est inutilisable — aucune clé ne mène à lui',
		(await sget(`/__operator/${LEGACY}`, { headers: bearer(KEY) })).status === 403);

	const issued = spawnSync(process.execPath, ['server/index.mjs', 'key', LEGACY, '--data', DATA], {
		cwd: SIM_ROOT, encoding: 'utf8', env: { ...process.env },
	});
	const legacyKey = issued.stdout.trim();
	check('node server/index.mjs key <id> : imprime UNE clé sur stdout',
		issued.status === 0 && /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{2,4}){5,6}$/.test(legacyKey)
		&& issued.stdout.trim().split('\n').length === 1);
	check('… hachée sur disque, jamais en clair',
		!fs.readFileSync(path.join(DATA, 'operator-state', `${LEGACY}.json`), 'utf8').includes(legacyKey));
	// Le serveur tourne toujours : son index de clés doit voir l'écriture d'un
	// AUTRE processus, sans redémarrage.
	check('… et l\'opérateur migré passe aussitôt, sur le serveur déjà démarré',
		(await sget(`/__operator/${LEGACY}`, { headers: bearer(legacyKey) })).status === 200);

	const unknownKey = spawnSync(process.execPath, ['server/index.mjs', 'key', 'personne-0000', '--data', DATA], {
		cwd: SIM_ROOT, encoding: 'utf8', env: { ...process.env },
	});
	check('key sur un opérateur inconnu : sort en erreur, n\'écrit rien',
		unknownKey.status === 1 && /no operator/.test(unknownKey.stderr));
} finally {
	await started?.close();
	await shared?.close();
	fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
