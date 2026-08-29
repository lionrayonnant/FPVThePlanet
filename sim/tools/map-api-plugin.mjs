// API de développement pour la GUI d'ajout de cartes (/add-map.html).
//
// Elle n'existe QUE sous `npm run dev` : `apply: 'serve'` empêche le plugin de
// participer au build, et Vite ne sert d'entrée que index.html, donc ni cette API
// ni la page ne partent en production. Elle écoute sur le serveur de dev de Vite,
// c'est-à-dire sur localhost — et pour cause : elle lance des processus et écrit
// dans public/scenes/.
//
// Aucune dépendance serveur : on se greffe sur le connect que Vite expose déjà.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	addMap, planScan, probeCoverage, slugify, readScenes, writeScenes,
	dirSize, tileDirPath, Cancelled, SCENES_DIR, FLYOVER_ROOT,
} from './lib/add-map-core.mjs';
import {
	newId, validateName, validateControlVector,
	freshState, migrate,
} from './operator-store.mjs';
import {
	openSession, resumeSession, closeSession, validateSession,
	reconcileStaleSessions, sanitizeWeatherSnapshot,
} from './session-model.mjs';
import { estimateCost, tileGrid, boxDimensions, tileSizeMeters } from './lib/estimates.mjs';
import { resolveWeather } from './weather-source.mjs';

const BASE = '/__map-api';

const OP_BASE = '/__operator';

// Répertoire de l'état opérateur : sibling de public/scenes/, hors bundle,
// gitignored. FPV_OPERATOR_DIR permet au selftest de le rediriger.
const OPERATOR_DIR = process.env.FPV_OPERATOR_DIR
	|| path.resolve(SCENES_DIR, '..', '..', 'operator-state');

function ensureOperatorDir() {
	fs.mkdirSync(OPERATOR_DIR, { recursive: true });
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function _readOperator(id) {
	if (!ID_RE.test(id)) throw new Error('id invalide');
	const file = path.join(OPERATOR_DIR, `${id}.json`);
	if (!fs.existsSync(file)) return null;
	return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function _writeOperator(state) {
	if (!ID_RE.test(state.id)) throw new Error('id invalide');
	ensureOperatorDir();
	const file = path.join(OPERATOR_DIR, `${state.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	return state;
}

function _listOperators() {
	ensureOperatorDir();
	return fs.readdirSync(OPERATOR_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			try { return migrate(JSON.parse(fs.readFileSync(path.join(OPERATOR_DIR, f), 'utf8'))); }
			catch { return null; }
		})
		.filter(Boolean)
		.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function operatorSummary(s) {
	return {
		id: s.id, name: s.name, createdAt: s.createdAt,
		counts: {
			areas: s.terrainCache.length,
			sessions: s.sessions.length,
			targets: s.targetLog.length,
		},
	};
}

const OP_WRITABLE_KEYS = new Set(['controlVector', 'settings']);

// Traduit une erreur de lecture d'opérateur en code HTTP : id malformé → 400,
// fichier d'un schéma trop récent → 409, tout le reste (JSON corrompu, E/S) → 500.
function opReadErrorStatus(e) {
	if (e.message === 'id invalide') return 400;
	if (e.message === 'schemaVersion trop récent') return 409;
	return 500;
}

const opRoutes = [
	['GET', /^\/$/, async (req, res) => {
		json(res, 200, { operators: _listOperators().map(operatorSummary) });
	}],

	['POST', /^\/$/, async (req, res) => {
		const b = await readBody(req);
		let name;
		try { name = validateName(b.name); }
		catch (e) { return json(res, 400, { error: e.message }); }
		// Garde contre la collision d'id à ~1/65536 : on retire jusqu'à un id libre.
		let state;
		do { state = freshState({ id: newId(name), name }); }
		while (fs.existsSync(path.join(OPERATOR_DIR, state.id + '.json')));
		_writeOperator(state);
		json(res, 201, { operator: state });
	}],

	['GET', /^\/([^/]+)$/, async (req, res, [id]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, opReadErrorStatus(e), { error: e.message });
		}
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		// Le terminal recharge l'opérateur à chaque retour au menu : c'est le
		// moment où l'on rattrape les sessions dont l'onglet est mort en vol.
		const rec = reconcileStaleSessions(state);
		if (rec.changed) _writeOperator(rec.state);
		json(res, 200, { operator: rec.state });
	}],

	['PATCH', /^\/([^/]+)$/, async (req, res, [id]) => {
		const b = await readBody(req);
		if (!OP_WRITABLE_KEYS.has(b.key)) {
			return json(res, 400, { error: `clé non modifiable : ${b.key}` });
		}
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, opReadErrorStatus(e), { error: e.message });
		}
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		let value = b.value;
		if (b.key === 'controlVector') {
			try { value = validateControlVector(value); }
			catch (e) { return json(res, 400, { error: e.message }); }
		}
		state[b.key] = value;
		_writeOperator(state);
		json(res, 200, { operator: state });
	}],

	// Météo du monde pour une zone (PHASE 04). Lecture d'abord : si le world
	// state connaît déjà le jour, on le relit sans toucher au réseau — c'est ce
	// qui garantit que deux acquisitions rapprochées voient le même temps. La
	// clé `worldState` n'est PAS dans OP_WRITABLE_KEYS : le monde n'est pas un
	// réglage, le client ne l'écrit jamais, seul le serveur le remplit.
	['GET', /^\/([^/]+)\/weather$/, async (req, res, [id], url) => {
		// Number('') et Number(null) valent tous les deux 0 — une coordonnée
		// parfaitement valide au milieu du golfe de Guinée. Sans ce garde-fou,
		// un paramètre absent ou vide remplit le world state de zones fantômes
		// « 0.00,0.00 » et sert une météo qui n'est celle de personne.
		const num = (v) => (v === null || v.trim() === '' ? NaN : Number(v));
		const lat = num(url.searchParams.get('lat'));
		const lon = num(url.searchParams.get('lon'));
		if (!Number.isFinite(lat) || !Number.isFinite(lon)
			|| lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return json(res, 400, { error: 'lat/lon manquants ou hors limites' });
		}
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });

		const day = url.searchParams.get('day') || undefined;
		const { snapshot, changed } = await resolveWeather(state.worldState ?? (state.worldState = {}), {
			lat, lon, day,
			onWarn: (e) => console.warn(`[weather] ${e.message} — repli`),
		});
		if (changed) _writeOperator(state);
		json(res, 200, { snapshot });
	}],

	// Rattache un terrain déjà acquis à l'opérateur (PHASE 05, écran « TERRAIN
	// ACQUIRED » -> KEEP TERRAIN). Le client n'envoie que le slug : le reste
	// (nom, coordonnées, poids) vient de public/scenes.json, jamais du client —
	// mêmes garde-fous que pour worldState, sur des données différentes.
	['POST', /^\/([^/]+)\/terrain-cache$/, async (req, res, [id]) => {
		const b = await readBody(req);
		const slug = String(b.slug ?? '').trim();
		if (!slug) return json(res, 400, { error: 'slug manquant' });
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		const scene = readScenes().find((s) => s.slug === slug);
		if (!scene) return json(res, 404, { error: `aucune carte "${slug}"` });
		const entry = {
			slug: scene.slug, name: scene.name, lat: scene.lat, lon: scene.lon,
			bytes: scene.bytes ?? dirSize(path.join(SCENES_DIR, slug)),
			keptAt: new Date().toISOString(),
		};
		state.terrainCache = (state.terrainCache ?? []).filter((t) => t.slug !== slug);
		state.terrainCache.push(entry);
		_writeOperator(state);
		json(res, 200, { operator: state });
	}],

	// Ouvre une session (squelette PENDING sur disque) ou ré-ouvre une session
	// LANDED. Deux écritures réseau par vol : ce POST à l'ouverture, un PATCH à
	// la clôture. Rien pendant le vol.
	['POST', /^\/([^/]+)\/sessions$/, async (req, res, [id]) => {
		const b = await readBody(req);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });

		let session;
		try {
			if (b.resume) {
				const i = state.sessions.findIndex((s) => s.id === b.resume);
				if (i < 0) return json(res, 404, { error: `aucune session "${b.resume}"` });
				session = validateSession(resumeSession(state.sessions[i]));
				state.sessions[i] = session;
			} else {
				session = validateSession(openSession({
					operatorId: state.id,
					area: b.area,
					weatherSnapshot: sanitizeWeatherSnapshot(b.weatherSnapshot ?? null),
				}));
				state.sessions.push(session);
			}
		} catch (e) { return json(res, 400, { error: e.message }); }

		_writeOperator(state);
		json(res, 201, { session });
	}],

	// Clôture : pose end, result et la télémétrie agrégée. La reprise passe
	// obligatoirement par le POST .../sessions ci-dessus, jamais par ici.
	// POST est accepté en plus de PATCH pour navigator.sendBeacon (qui ne sait
	// faire que POST) au moment où l'onglet se ferme.
	['PATCH', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],
	['POST', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],
];

async function closeSessionRoute(req, res, [id, sid]) {
	const b = await readBody(req);
	let state;
	try { state = _readOperator(id); }
	catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
	if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });

	const i = state.sessions.findIndex((s) => s.id === sid);
	if (i < 0) return json(res, 404, { error: `aucune session "${sid}"` });
	if (state.sessions[i].result !== 'PENDING') {
		return json(res, 409, { error: `session "${sid}" déjà ${state.sessions[i].result}` });
	}

	let session;
	try {
		session = validateSession(closeSession(state.sessions[i], {
			result: b.result,
			telemetry: b.telemetry,
		}));
	} catch (e) { return json(res, 400, { error: e.message }); }

	state.sessions[i] = session;
	_writeOperator(state);
	json(res, 200, { session });
}

// Un seul job à la fois : télécharger deux cartes en parallèle sature la même
// liaison et ne va pas plus vite, mais rend la progression illisible.
const jobs = new Map();
let current = null;

function json(res, code, body) {
	const s = JSON.stringify(body);
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(s);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let b = '';
		req.on('data', (d) => {
			b += d;
			if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
		});
		req.on('end', () => {
			try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid JSON body')); }
		});
		req.on('error', reject);
	});
}

// Une bbox venue du navigateur n'est pas de confiance : on la valide avant de la
// passer à un sous-processus.
function requireBox(b) {
	if (!b || !['south', 'west', 'north', 'east'].every((k) => Number.isFinite(b[k]))) {
		throw new Error('bbox manquante ou invalide');
	}
	const box = {
		south: Math.min(b.south, b.north), west: Math.min(b.west, b.east),
		north: Math.max(b.south, b.north), east: Math.max(b.west, b.east),
	};
	if (box.south < -85 || box.north > 85 || box.west < -180 || box.east > 180) throw new Error('bbox hors limites');
	if (box.south === box.north || box.west === box.east) throw new Error('bbox d\'aire nulle');
	return box;
}

function intIn(v, lo, hi, dflt) {
	const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : dflt;
	return Math.min(hi, Math.max(lo, n));
}

function centreOf(box) {
	return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
}

// Décrit une zone : géométrie exacte + estimations. `columns` vient du plan Go
// quand il est fourni (il a élagué les colonnes hors couverture), sinon de la
// grille calculée localement.
function describe(box, zoom, altitude, planColumns) {
	const c = centreOf(box);
	const grid = tileGrid(box, zoom);
	const columns = Number.isFinite(planColumns) ? planColumns : grid.columns;
	return {
		box, centre: c,
		dimensions: boxDimensions(box),
		grid,
		tileMeters: tileSizeMeters(zoom, c.lat),
		estimate: estimateCost({ columns, zoom, altitude }),
	};
}

function sceneList() {
	return readScenes().map((s) => ({
		...s,
		bytes: s.bytes ?? dirSize(path.join(SCENES_DIR, s.slug)),
		installed: fs.existsSync(path.join(SCENES_DIR, s.slug, 'manifest.json')),
	}));
}

function startJob(opts) {
	const id = randomUUID();
	const ctrl = new AbortController();
	const job = {
		id, slug: opts.slug, name: opts.name,
		state: 'running', phase: 'download', hits: 0, pipeline: {},
		startedAt: Date.now(), endedAt: null, error: null,
		log: [], listeners: new Set(), ctrl,
	};
	jobs.set(id, job);
	current = job;

	const emit = (event, data) => {
		if (event === 'log') {
			job.log.push(data);
			// Le log d'un gros export fait des dizaines de milliers de lignes ;
			// on n'en garde que la queue pour le rattrapage après rechargement.
			if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
		}
		for (const send of job.listeners) send(event, data);
	};

	// Certains champs de parsePrepLine sont des compteurs qui s'accumulent
	// (un événement par chunk/sheet), le reste est un dernier état connu.
	const ACCUMULATED = new Set(['chunksDone', 'chunkBytes', 'textureSheets', 'textureBytes']);
	const mergeStat = (stat) => {
		for (const [k, v] of Object.entries(stat)) {
			job.pipeline[k] = ACCUMULATED.has(k) ? (job.pipeline[k] ?? 0) + v : v;
		}
	};

	addMap(opts, {
		signal: ctrl.signal,
		onLog: (ev) => {
			if (ev.stream === 'progress') { job.hits = ev.hits; emit('progress', { hits: ev.hits, phase: job.phase }); return; }
			// Après un skip (tuile déjà en cache), on saute directement à decode :
			// prep tourne quand même, il n'y a simplement rien eu à télécharger.
			if (ev.stream === 'phase') { job.phase = ev.done ? 'decode' : ev.line; emit('phase', { phase: job.phase }); return; }
			if (ev.stream === 'stat') { mergeStat(ev.stat); emit('stat', { ...job.pipeline }); return; }
			emit('log', { stream: ev.stream, line: ev.line });
		},
	}).then((r) => {
		job.state = 'done'; job.endedAt = Date.now(); job.result = r;
		// Rejoué tel quel à une connexion SSE tardive (voir la route /events plus
		// bas) : sans ça, un rechargement de page après la fin du job ne recevait
		// qu'un {message} vide — slug/bytes/stats disparaissaient, et l'écran
		// TERRAIN ACQUIRED de PHASE 05 n'avait plus de quoi proposer KEEP/REMOVE.
		job.final = { event: 'done', data: { slug: r.slug, bytes: dirSize(r.outDir), stats: r.stats } };
		emit(job.final.event, job.final.data);
	}).catch((e) => {
		job.state = e instanceof Cancelled ? 'cancelled' : 'error';
		job.endedAt = Date.now();
		job.error = e instanceof Cancelled ? 'Annulé.' : e.message;
		job.final = { event: job.state === 'cancelled' ? 'cancelled' : 'error', data: { message: job.error } };
		emit(job.final.event, job.final.data);
	}).finally(() => {
		if (current === job) current = null;
		for (const send of job.listeners) send('end', {});
	});

	return job;
}

const routes = [
	['GET', /^\/scenes$/, async (req, res) => json(res, 200, { scenes: sceneList() })],

	['DELETE', /^\/scenes\/([a-z0-9-]+)$/, async (req, res, [slug], url) => {
		const scenes = readScenes();
		const i = scenes.findIndex((s) => s.slug === slug);
		if (i < 0) return json(res, 404, { error: `aucune carte "${slug}"` });
		const [entry] = scenes.splice(i, 1);
		writeScenes(scenes);
		fs.rmSync(path.join(SCENES_DIR, slug), { recursive: true, force: true });
		let raw = false;
		if (url.searchParams.get('raw') === '1') {
			// Même logique que remove-map.mjs : on retrouve la tuile brute par son
			// nom, qu'elle soit au format « centre » ou « bbox ».
			const dir = entry.bbox
				? tileDirPath({ ...entry, bbox: entry.bbox })
				: tileDirPath({ lat: entry.lat, lon: entry.lon, zoom: entry.zoom ?? 20, radius: entry.radius ?? 25, altitude: entry.altitude ?? 20 });
			if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); raw = true; }
		}
		json(res, 200, { removed: slug, raw });
	}],

	// Description instantanée d'une zone : aucune requête réseau, appelable à
	// chaque déplacement de la souris.
	['POST', /^\/describe$/, async (req, res) => {
		const b = await readBody(req);
		const box = requireBox(b.bbox);
		json(res, 200, describe(box, intIn(b.zoom, 13, 20, 20), intIn(b.altitude, 1, 60, 20)));
	}],

	// Plan réel : interroge la région Flyover, élague les colonnes hors emprise,
	// et rend l'emprise de couverture — sans télécharger une seule tuile.
	['POST', /^\/plan$/, async (req, res) => {
		const b = await readBody(req);
		const box = requireBox(b.bbox);
		const zoom = intIn(b.zoom, 13, 20, 20), altitude = intIn(b.altitude, 1, 60, 20);
		const c = centreOf(box);
		const plan = await planScan({ lat: c.lat, lon: c.lon, zoom, altitude, bbox: box });
		json(res, 200, { plan, ...describe(box, zoom, altitude, plan.columns) });
	}],

	// Sonde : la seule preuve qu'il y a vraiment de la photogrammétrie ici.
	['POST', /^\/probe$/, async (req, res) => {
		const b = await readBody(req);
		const box = requireBox(b.bbox);
		json(res, 200, await probeCoverage({
			bbox: box, zoom: intIn(b.zoom, 13, 20, 20), altitude: intIn(b.altitude, 1, 60, 20),
		}));
	}],

	['GET', /^\/jobs$/, async (req, res) => json(res, 200, {
		jobs: [...jobs.values()].map(({ id, slug, name, state, phase, hits, startedAt, endedAt, error }) =>
			({ id, slug, name, state, phase, hits, startedAt, endedAt, error })),
	})],

	['POST', /^\/jobs$/, async (req, res) => {
		if (current) return json(res, 409, { error: 'une extraction est déjà en cours', jobId: current.id });
		const b = await readBody(req);
		const box = requireBox(b.bbox);
		const name = String(b.name ?? '').trim();
		if (!name) return json(res, 400, { error: 'nom manquant' });
		const slug = (b.slug ? slugify(b.slug) : slugify(name));
		if (!slug) return json(res, 400, { error: 'le nom ne donne aucun identifiant utilisable' });

		const c = centreOf(box);
		const job = startJob({
			name, slug, bbox: box, lat: c.lat, lon: c.lon,
			zoom: intIn(b.zoom, 13, 20, 20), altitude: intIn(b.altitude, 1, 60, 20),
			cell: intIn(b.cell, 64, 512, 256), quality: intIn(b.quality, 40, 100, 85),
			force: b.force === true,
		});
		json(res, 201, { jobId: job.id, slug });
	}],

	['DELETE', /^\/jobs\/([0-9a-f-]+)$/, async (req, res, [id]) => {
		const job = jobs.get(id);
		if (!job) return json(res, 404, { error: 'job inconnu' });
		job.ctrl.abort();
		json(res, 200, { cancelling: id });
	}],

	// SSE. Le buffer de log est rejoué à la connexion, pour qu'un rechargement de
	// page pendant un export de dix minutes ne perde pas le fil.
	['GET', /^\/jobs\/([0-9a-f-]+)\/events$/, async (req, res, [id]) => {
		const job = jobs.get(id);
		if (!job) return json(res, 404, { error: 'job inconnu' });
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		});
		const send = (event, data) => {
			try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client parti */ }
		};
		send('state', { state: job.state, phase: job.phase, hits: job.hits, pipeline: job.pipeline, error: job.error });
		for (const l of job.log) send('log', l);
		if (job.state === 'running') {
			job.listeners.add(send);
			const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 15000);
			req.on('close', () => { job.listeners.delete(send); clearInterval(ka); });
		} else {
			// job.final porte le VRAI événement terminal (voir startJob) : une
			// connexion tardive (rechargement après la fin du job) doit voir
			// exactement ce qu'une connexion restée ouverte aurait reçue, slug et
			// stats compris — pas une reconstruction générique.
			const fallback = { event: job.state === 'done' ? 'done' : job.state, data: { message: job.error ?? '' } };
			const { event, data } = job.final ?? fallback;
			send(event, data);
			send('end', {});
			res.end();
		}
	}],
];

export default function mapApiPlugin() {
	return {
		name: 'fpvmaps-map-api',
		apply: 'serve', // outil de dev : jamais dans le bundle de production
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.url === OP_BASE || req.url?.startsWith(OP_BASE + '/') || req.url?.startsWith(OP_BASE + '?')) {
					const url = new URL(req.url, 'http://localhost');
					const p = url.pathname.slice(OP_BASE.length) || '/';
					const onPath = opRoutes.filter(([, re]) => re.test(p));
					if (!onPath.length) return json(res, 404, { error: `route inconnue : ${p}` });
					const route = onPath.find(([method]) => method === req.method);
					if (!route) return json(res, 405, { error: `${req.method} non supporté sur ${p}`, allow: onPath.map(([m]) => m) });
					try {
						return await route[2](req, res, route[1].exec(p).slice(1), url);
					} catch (e) {
						server.config.logger.error(`[operator] ${p}: ${e.stack ?? e.message}`);
						return json(res, 400, { error: e.message });
					}
				}
				if (!req.url?.startsWith(BASE)) return next();
				const url = new URL(req.url, 'http://localhost');
				const p = url.pathname.slice(BASE.length) || '/';
				// Plusieurs routes partagent un chemin (GET et POST /jobs) : on
				// cherche la méthode parmi TOUTES celles qui matchent le chemin, et
				// on ne répond 405 que si aucune ne convient.
				const onPath = routes.filter(([, re]) => re.test(p));
				if (!onPath.length) return json(res, 404, { error: `route inconnue : ${p}` });
				const route = onPath.find(([method]) => method === req.method);
				if (!route) {
					return json(res, 405, {
						error: `${req.method} non supporté sur ${p}`,
						allow: onPath.map(([m]) => m),
					});
				}
				try {
					return await route[2](req, res, route[1].exec(p).slice(1), url);
				} catch (e) {
					server.config.logger.error(`[map-api] ${p}: ${e.stack ?? e.message}`);
					return json(res, 400, { error: e.message });
				}
			});
			server.config.logger.info(`  ➜  Cartes:  http://localhost:${server.config.server.port ?? 5173}/add-map.html`);
		},
	};
}

export { FLYOVER_ROOT };
export { _readOperator, _writeOperator, _listOperators, OPERATOR_DIR };
