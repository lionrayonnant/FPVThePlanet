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
		buf: Buffer.from(await r.arrayBuffer()),
	};
};
const get = at(base);
const bodyOf = (r) => { try { return JSON.parse(r.buf.toString()); } catch { return {}; } };
const bearer = (k) => ({ authorization: `Bearer ${k}` });

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

	const closedJob = await postJob(base);
	check('local, drapeau absent : POST /__map-api/jobs refuse (403)',
		closedJob.status === 403 && /désactivée/.test(bodyOf(closedJob).error ?? ''));

	process.env.FPVTP_ACQUIRE = '1';
	check('local, FPVTP_ACQUIRE=1 : GET /__map-api/scenes annonce acquire:true',
		bodyOf(await get('/__map-api/scenes')).acquire === true);

	// Contrôle POSITIF : la garde a bien laissé passer, et c'est le corps vide
	// qui arrête maintenant la requête. Sans lui, un 403 devenu 400 pour une
	// tout autre raison passerait pour un succès.
	const openedJob = await postJob(base);
	check('local, FPVTP_ACQUIRE=1 : la garde s\'ouvre — POST /jobs cale sur le corps, pas sur elle',
		openedJob.status === 400 && !/désactivée/.test(bodyOf(openedJob).error ?? ''));

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

	// Derrière Caddy, `remoteAddress` vaut toujours la boucle locale : seul
	// x-forwarded-for identifie le demandeur. En `local` il serait falsifiable
	// par le client, et on ne le lit PAS.
	const proxied = { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } };
	check('x-forwarded-for n\'est lu qu\'en `shared`',
		clientIp(proxied, 'shared') === '203.0.113.7' && clientIp(proxied, 'local') === '127.0.0.1');

	let localCodes = [];
	for (let i = 0; i < SIGNUP_MAX + 2; i++) localCodes.push((await signup(base, `flood${i}`)).status);
	check(`local : ${SIGNUP_MAX + 2} inscriptions d'affilée passent toutes — aucun plafond`,
		localCodes.every((c) => c === 201));

	// --- un opérateur d'avant #60 : aucun keyHash, et il doit rester intact ---
	const LEGACY = 'legacy-0001';
	fs.writeFileSync(path.join(DATA, 'operator-state', `${LEGACY}.json`), JSON.stringify({
		schemaVersion: 2, id: LEGACY, name: 'legacy', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], sessions: [],
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
		sharedJob.status === 403 && /désactivée/.test(bodyOf(sharedJob).error ?? ''));
	delete process.env.FPVTP_ACQUIRE;
	check('shared, drapeau absent : acquire:false, et POST /jobs 403',
		bodyOf(await sget('/__map-api/scenes', { headers: bearer(KEY) })).acquire === false
		&& (await postJob(sbase, bearer(KEY))).status === 403);

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
	check('shared : la suivante rend 429, avec un message lisible en français',
		over.status === 429 && /trop d'inscriptions/.test(overBody.error ?? '')
		&& /min/.test(overBody.error ?? ''));
	check('shared : une AUTRE adresse a son propre compteur',
		(await signup(sbase, 'ailleurs', { 'x-forwarded-for': '203.0.113.99' })).status === 201);
	// Le proxy pose plusieurs sauts : c'est le PREMIER qui est le client.
	check('shared : x-forwarded-for à plusieurs sauts — c\'est le premier qui compte',
		(await signup(sbase, 'saut', { 'x-forwarded-for': `${IP_A}, 10.0.0.1` })).status === 429);

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
		refusedPhoto.status === 413 && /quota atteint/.test((await refusedPhoto.json()).error ?? ''));
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
		unknownKey.status === 1 && /aucun opérateur/.test(unknownKey.stderr));
} finally {
	await started?.close();
	await shared?.close();
	fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
