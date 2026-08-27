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
import { estimateCost, tileGrid, boxDimensions, tileSizeMeters } from './lib/estimates.mjs';

const BASE = '/__map-api';

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
		state: 'running', phase: 'download', hits: 0,
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

	addMap(opts, {
		signal: ctrl.signal,
		onLog: (ev) => {
			if (ev.stream === 'progress') { job.hits = ev.hits; emit('progress', { hits: ev.hits, phase: job.phase }); return; }
			if (ev.stream === 'phase') { job.phase = ev.done ? 'prep' : ev.line; emit('phase', { phase: job.phase }); return; }
			emit('log', { stream: ev.stream, line: ev.line });
		},
	}).then((r) => {
		job.state = 'done'; job.endedAt = Date.now(); job.result = r;
		emit('done', { slug: r.slug, bytes: dirSize(r.outDir), stats: r.stats });
	}).catch((e) => {
		job.state = e instanceof Cancelled ? 'cancelled' : 'error';
		job.endedAt = Date.now();
		job.error = e instanceof Cancelled ? 'Annulé.' : e.message;
		emit(job.state === 'cancelled' ? 'cancelled' : 'error', { message: job.error });
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
		send('state', { state: job.state, phase: job.phase, hits: job.hits, error: job.error });
		for (const l of job.log) send('log', l);
		if (job.state === 'running') {
			job.listeners.add(send);
			const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 15000);
			req.on('close', () => { job.listeners.delete(send); clearInterval(ka); });
		} else {
			send(job.state === 'done' ? 'done' : job.state, { message: job.error ?? '' });
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
