// L'API du jeu : /__operator (l'état opérateur) et /__map-api (scènes,
// acquisition, jobs).
//
// Extraite telle quelle de tools/map-api-plugin.mjs (issue #259) : elle n'a
// jamais eu de dépendance à Vite — les deux tables de routes sont du node:http
// nu, et le plugin ne lui apportait que son logger. Elle sert désormais les deux
// hébergements : `npm run dev` (l'adaptateur Vite, tools/map-api-plugin.mjs) et
// le serveur autonome (server/index.mjs). Aucune route n'a changé de chemin, de
// méthode, de code de statut ni de forme de réponse.
//
// Aucune dépendance serveur : du node:http, rien d'autre.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths as defaultPaths } from '../tools/lib/paths.mjs';
import {
	addMap, planScan, probeCoverage, slugify, readScenes, writeScenes,
	dirSize, tileDirPath, rawTileDirFor, listProviders, Cancelled,
} from '../tools/lib/add-map-core.mjs';
import * as providers from '../tools/lib/providers/index.mjs';
import {
	newId, validateName, validateControlVector,
	freshState, migrate,
} from '../tools/operator-store.mjs';
import {
	openSession, resumeSession, closeSession, validateSession,
	reconcileStaleSessions, sanitizeWeatherSnapshot, annotateSession, addPhoto,
	stripPhotoData, stripOperatorPhotoData, deleteSession,
} from '../tools/session-model.mjs';
import { targetLogEntries } from '../tools/session-log-model.mjs';
import {
	estimateCost, tileGrid, boxDimensions, tileSizeMeters,
	polygonBounds, polygonGrid, polygonArea,
} from '../tools/lib/estimates.mjs';
import { resolveWeather } from '../tools/weather-source.mjs';
import { generateTargetScan, resolveTarget } from '../tools/target-model.mjs';

const BASE = '/__map-api';

const OP_BASE = '/__operator';

// Les chemins de données du processus (tools/lib/paths.mjs). Un seul serveur par
// processus — `jobs`/`current` plus bas font déjà cette hypothèse — donc un état
// de module suffit ; createApi() le repose pour l'appelant qui en fournit
// d'autres.
let P = defaultPaths;

function ensureOperatorDir() {
	fs.mkdirSync(P.OPERATOR_DIR, { recursive: true });
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function _readOperator(id) {
	if (!ID_RE.test(id)) throw new Error('id invalide');
	const file = path.join(P.OPERATOR_DIR, `${id}.json`);
	if (!fs.existsSync(file)) return null;
	return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function _writeOperator(state) {
	if (!ID_RE.test(state.id)) throw new Error('id invalide');
	ensureOperatorDir();
	const file = path.join(P.OPERATOR_DIR, `${state.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	return state;
}

function _listOperators() {
	ensureOperatorDir();
	return fs.readdirSync(P.OPERATOR_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			try { return migrate(JSON.parse(fs.readFileSync(path.join(P.OPERATOR_DIR, f), 'utf8'))); }
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
			// Le Target Log est dérivé des sessions (PHASE 17, spec D1).
			targets: targetLogEntries(s.sessions).length,
		},
	};
}

// `dialogueMemory` (PHASE 21) : mémoire anti-répétition du moteur de dialogue,
// écrite via le même `operator.patch()` débouncé que `settings`. Purement
// cosmétique — un fichier opérateur sans cette clé se relit comme une mémoire
// neuve (src/dialogue.js) — donc pas de validation de forme côté serveur, au
// même titre que `settings` : elle est bornée côté client (anneau de 256
// entrées, table de 512 vus, dans tools/dialogue/engine.mjs).
//
// `coverage` (issue #245) : là où le drone est passé, en cellules slippy z=20.
// Même contrat que dialogueMemory — écrite par operator.patch() une fois par
// session (src/session.js), cosmétique, sans validation de forme ici parce que
// bornée côté client : MAX_CELLS = 8000 et W_MAX = 8 dans src/coverage.js, et
// fromStored() y rend une couverture vierge pour tout ce qui n'est pas la
// forme attendue. Un opérateur sans cette clé se relit comme une carte vierge.
const OP_WRITABLE_KEYS = new Set(['controlVector', 'settings', 'dialogueMemory', 'coverage']);

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
		while (fs.existsSync(path.join(P.OPERATOR_DIR, state.id + '.json')));
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
		// Les `dataUrl` des captures ne partent PAS ici (spec D4) : le terminal
		// recharge l'opérateur à chaque retour au menu, et une trentaine de
		// sessions photographiées pèseraient des dizaines de mégaoctets à chaque
		// fois. VIEW SESSION va les chercher une par une sur la route dédiée.
		json(res, 200, { operator: stripOperatorPhotoData(rec.state) });
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
	//
	// Écart assumé au principe « slug only » (PHASE 08) : le client joint aussi
	// `signalDensity`, l'estimation de densité de signal affichée par le Global
	// Scanner. Elle dépend de `state.place` (réponse Nominatim runtime) et de
	// l'aire dessinée — le serveur n'a pas de quoi la recalculer depuis
	// scenes.json. C'est une estimation d'écran, pas une donnée de terrain
	// autoritative : on se contente d'en contrôler la forme.
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
			bytes: scene.bytes ?? dirSize(path.join(P.SCENES_DIR, slug)),
			keptAt: new Date().toISOString(),
		};
		// Estimation d'écran (densité de signal du Global Scanner), pas une donnée
		// de terrain autoritative — on ne fait que contrôler la forme.
		const d = b.signalDensity;
		if (d && typeof d === 'object'
			&& Number.isFinite(d.level)
			&& Array.isArray(d.range) && d.range.length === 2 && d.range.every(Number.isFinite)) {
			entry.signalDensity = { level: d.level, range: [d.range[0], d.range[1]] };
		}
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
				let target = null;
				if (b.targetSeed) {
					const scan = generateTargetScan({ seed: String(b.targetSeed), count: b.targetCount });
					if (!Number.isInteger(b.targetIndex) || b.targetIndex < 0 || b.targetIndex >= scan.candidates.length) {
						return json(res, 400, { error: `targetIndex hors borne : ${b.targetIndex}` });
					}
					target = resolveTarget(scan, b.targetIndex);
				} else {
					console.warn('[session] ouverture sans TARGET SCAN — aucune cible (chemin dev)');
				}
				session = validateSession(openSession({
					operatorId: state.id,
					area: b.area,
					weatherSnapshot: sanitizeWeatherSnapshot(b.weatherSnapshot ?? null),
					target,
					// Numéros d'affichage (PHASE 17). Le serveur seul les attribue :
					// lui seul connaît le compteur. On n'incrémente qu'APRÈS la
					// validation, pour qu'une session refusée ne consomme rien.
					seq: (state.sessionSeq ?? 0) + 1,
					targetSeq: target ? (state.targetSeq ?? 0) + 1 : undefined,
				}));
				state.sessions.push(session);
				state.sessionSeq = session.seq;
				if (session.targetSeq) state.targetSeq = session.targetSeq;
			}
		} catch (e) { return json(res, 400, { error: e.message }); }

		_writeOperator(state);
		json(res, 201, { session: stripPhotoData(session) });
	}],

	// Clôture : pose end, result et la télémétrie agrégée. La reprise passe
	// obligatoirement par le POST .../sessions ci-dessus, jamais par ici.
	// POST est accepté en plus de PATCH pour navigator.sendBeacon (qui ne sait
	// faire que POST) au moment où l'onglet se ferme.
	['PATCH', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],
	['POST', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],

	// OPERATOR NOTE (PHASE 15) : texte libre, attaché à une session qu'elle soit
	// encore PENDING ou déjà LANDED/CRASHED — contrairement à la clôture
	// ci-dessus, une note n'est pas un verdict, elle peut s'ajouter après coup.
	['PATCH', /^\/([^/]+)\/sessions\/([^/]+)\/comment$/, async (req, res, [id, sid]) => {
		const b = await readBody(req);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });

		const i = state.sessions.findIndex((s) => s.id === sid);
		if (i < 0) return json(res, 404, { error: `aucune session "${sid}"` });

		let session;
		try { session = validateSession(annotateSession(state.sessions[i], b.comment)); }
		catch (e) { return json(res, 400, { error: e.message }); }

		state.sessions[i] = session;
		_writeOperator(state);
		json(res, 200, { session: stripPhotoData(session) });
	}],

	// Capture (PHASE 16). Écrite tout de suite sur la session, pas attendue la
	// clôture : un onglet mort en vol ne doit pas perdre les photos déjà prises.
	// Base64 dans le JSON de session, comme le reste de l'état opérateur — pas
	// de stockage binaire séparé. Plafond de body relevé rien que pour cette
	// route : une capture dépasse largement le mégaoctet des autres requêtes.
	['POST', /^\/([^/]+)\/sessions\/([^/]+)\/photos$/, async (req, res, [id, sid]) => {
		const b = await readBody(req, PHOTO_BODY_MAX);
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
		try { session = validateSession(addPhoto(state.sessions[i], b)); }
		catch (e) { return json(res, 400, { error: e.message }); }

		state.sessions[i] = session;
		_writeOperator(state);
		json(res, 201, { session: stripPhotoData(session) });
	}],

	// La session COMPLÈTE, captures comprises (PHASE 17, spec D4). Toutes les
	// autres réponses élident les `dataUrl` ; seul l'écran VIEW SESSION paie le
	// poids des images, une fois, à son ouverture.
	['GET', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		const session = state.sessions.find((s) => s.id === sid);
		if (!session) return json(res, 404, { error: `aucune session "${sid}"` });
		json(res, 200, { session });
	}],

	// DELETE SESSION (PHASE 17, spec D3). Suppression franche : l'entrée et ses
	// captures disparaissent, et sa cible quitte donc le Target Log, qui en est
	// dérivé. Le terrain n'est jamais touché.
	['DELETE', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		let next;
		try { next = deleteSession(state, sid); }
		catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
		_writeOperator(next);
		json(res, 200, { removed: sid });
	}],
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
	json(res, 200, { session: stripPhotoData(session) });
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

// Une capture encodée en base64 dépasse vite le mégaoctet d'un body JSON
// ordinaire (photo + ~33 % d'overhead base64) : plafond dédié pour cette route.
const PHOTO_BODY_MAX = 8e6;

function readBody(req, maxBytes = 1e6) {
	return new Promise((resolve, reject) => {
		let b = '';
		req.on('data', (d) => {
			b += d;
			if (b.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
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

// Un tracé venu du navigateur n'est pas de confiance : les bornes ici sont les
// mêmes que celles de parseRing() dans cmd/export-obj/main.go, pour qu'un tracé
// accepté ici ne se fasse pas refuser trois appels plus loin par le Go.
function requirePoly(p) {
	if (!Array.isArray(p) || p.length % 2 !== 0) throw new Error('tracé manquant ou invalide');
	if (p.length < 6) throw new Error('un polygone a au moins 3 sommets');
	if (p.length > 400) throw new Error('au plus 200 sommets');
	if (!p.every(Number.isFinite)) throw new Error('tracé : coordonnée non numérique');
	const b = polygonBounds(p);
	if (b.south < -85 || b.north > 85 || b.west < -180 || b.east > 180) throw new Error('tracé hors limites');
	if (b.south === b.north || b.west === b.east) throw new Error('tracé d\'aire nulle');
	if (b.east - b.west >= 180) throw new Error('tracé à cheval sur l\'antiméridien');
	return p;
}

// Les routes acceptent l'une OU l'autre forme de zone. Rendre les deux serait
// ambigu ; n'en rendre aucune est l'erreur habituelle d'un appelant.
function requireZone(b) {
	if (b.poly && b.bbox) throw new Error('bbox et poly sont exclusifs');
	if (b.poly) return { poly: requirePoly(b.poly) };
	return { bbox: requireBox(b.bbox) };
}

// b.provider est facultatif (le défaut du registre s'applique alors) ; s'il est
// fourni, il doit nommer un fournisseur inscrit — providers.get() porte déjà le
// message français ("fournisseur inconnu : ...") que la GUI affiche, et le
// throw remonte au catch générique du middleware qui le rend en 400.
function requireProvider(b) {
	if (b.provider == null) return undefined;
	return providers.get(b.provider).id;
}

function intIn(v, lo, hi, dflt) {
	const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : dflt;
	return Math.min(hi, Math.max(lo, n));
}

function centreOf(zone) {
	const b = zone.poly ? polygonBounds(zone.poly) : (zone.bbox ?? zone);
	return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

// Décrit une zone : géométrie exacte + estimations. `columns` vient du plan Go
// quand il est fourni (il a élagué les colonnes hors couverture), sinon de la
// grille calculée localement.
function describe(zone, zoom, altitude, planColumns) {
	const c = centreOf(zone);
	const box = zone.poly ? polygonBounds(zone.poly) : zone.bbox;
	const grid = zone.poly ? polygonGrid(zone.poly, zoom) : tileGrid(box, zoom);
	const columns = Number.isFinite(planColumns) ? planColumns : grid.columns;

	// L'aire du TRACÉ, pas celle de son emprise : sur un corridor le long d'un
	// fleuve les deux diffèrent d'un facteur deux ou trois, et c'est cette
	// valeur-là que l'écran présente comme « surface de la zone ».
	const dimensions = boxDimensions(box);
	if (zone.poly) dimensions.area = polygonArea(zone.poly);

	return {
		box, centre: c,
		...(zone.poly ? { poly: zone.poly } : {}),
		dimensions,
		// Uint8Array ne survit pas à JSON.stringify : la carte a besoin du masque
		// pour dessiner l'escalier, on le rend donc en tableau ordinaire.
		grid: { ...grid, keep: grid.keep ? Array.from(grid.keep) : undefined, masked: grid.masked ?? 0 },
		tileMeters: tileSizeMeters(zoom, c.lat),
		estimate: estimateCost({ columns, zoom, altitude }),
	};
}

function sceneList() {
	return readScenes().map((s) => ({
		...s,
		bytes: s.bytes ?? dirSize(path.join(P.SCENES_DIR, s.slug)),
		installed: fs.existsSync(path.join(P.SCENES_DIR, s.slug, 'manifest.json')),
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

	// Liste des fournisseurs inscrits + le défaut du registre (Task 7, issue
	// #18) : la GUI en peuple son sélecteur plutôt que de coder les ids en dur.
	['GET', /^\/providers$/, async (req, res) => json(res, 200, {
		providers: listProviders(), default: providers.DEFAULT_PROVIDER_ID,
	})],

	['DELETE', /^\/scenes\/([a-z0-9-]+)$/, async (req, res, [slug], url) => {
		const scenes = readScenes();
		const i = scenes.findIndex((s) => s.slug === slug);
		if (i < 0) return json(res, 404, { error: `aucune carte "${slug}"` });
		const [entry] = scenes.splice(i, 1);
		writeScenes(scenes);
		fs.rmSync(path.join(P.SCENES_DIR, slug), { recursive: true, force: true });
		let raw = false;
		if (url.searchParams.get('raw') === '1') {
			// On retrouve la tuile brute par son nom, quelle que soit la forme de
			// la zone, et chez SON fournisseur. La règle vit dans add-map-core
			// (rawTileDirFor) : le CLI remove-map.mjs la partage, au lieu de
			// recalculer un chemin Flyover pour toute scène (issue #154).
			const dir = await rawTileDirFor(entry);
			if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); raw = true; }
		}
		json(res, 200, { removed: slug, raw });
	}],

	// Description instantanée d'une zone : aucune requête réseau, appelable à
	// chaque déplacement de la souris. Indépendante du fournisseur (géométrie
	// et coût estimé seulement) : pas de b.provider ici.
	['POST', /^\/describe$/, async (req, res) => {
		const b = await readBody(req);
		const zone = requireZone(b);
		json(res, 200, describe(zone, intIn(b.zoom, 13, 20, 20), intIn(b.altitude, 1, 60, 20)));
	}],

	// Plan réel : interroge la région du fournisseur choisi, élague les colonnes
	// hors emprise, et rend l'emprise de couverture — sans télécharger une seule
	// tuile.
	['POST', /^\/plan$/, async (req, res) => {
		const b = await readBody(req);
		const zone = requireZone(b);
		const provider = requireProvider(b);
		const zoom = intIn(b.zoom, 13, 20, 20), altitude = intIn(b.altitude, 1, 60, 20);
		const c = centreOf(zone);
		const plan = await planScan({ lat: c.lat, lon: c.lon, zoom, altitude, provider, ...zone });
		json(res, 200, { plan, ...describe(zone, zoom, altitude, plan.columns) });
	}],

	// Sonde : la seule preuve qu'il y a vraiment de la photogrammétrie ici.
	['POST', /^\/probe$/, async (req, res) => {
		const b = await readBody(req);
		const zone = requireZone(b);
		const provider = requireProvider(b);
		const c = centreOf(zone);
		json(res, 200, await probeCoverage({
			lat: c.lat, lon: c.lon, provider, ...zone,
			zoom: intIn(b.zoom, 13, 20, 20), altitude: intIn(b.altitude, 1, 60, 20),
		}));
	}],

	['GET', /^\/jobs$/, async (req, res) => json(res, 200, {
		jobs: [...jobs.values()].map(({ id, slug, name, state, phase, hits, startedAt, endedAt, error }) =>
			({ id, slug, name, state, phase, hits, startedAt, endedAt, error })),
	})],

	['POST', /^\/jobs$/, async (req, res) => {
		if (current) return json(res, 409, { error: 'une extraction est déjà en cours', jobId: current.id });
		const b = await readBody(req);
		const zone = requireZone(b);
		const provider = requireProvider(b);
		const name = String(b.name ?? '').trim();
		if (!name) return json(res, 400, { error: 'nom manquant' });
		const slug = (b.slug ? slugify(b.slug) : slugify(name));
		if (!slug) return json(res, 400, { error: 'le nom ne donne aucun identifiant utilisable' });

		const c = centreOf(zone);
		const job = startJob({
			name, slug, provider, ...zone, lat: c.lat, lon: c.lon,
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

// La fabrique. `paths` vient de tools/lib/paths.mjs (le défaut du processus en
// dev, le `--data` du serveur autonome) ; `logger` est celui de Vite en dev, la
// console en autonome. `mode` fait partie de la signature dès maintenant mais
// aucune route ne le regarde : c'est T3 qui s'en servira (clé d'opérateur,
// acquisition fermée en `shared`).
export function createApi({ paths = defaultPaths, mode = 'local', logger = console } = {}) {
	P = paths;
	return async function api(req, res, next) {
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
				logger.error(`[operator] ${p}: ${e.stack ?? e.message}`);
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
			logger.error(`[map-api] ${p}: ${e.stack ?? e.message}`);
			return json(res, 400, { error: e.message });
		}
	};
}

export { _readOperator, _writeOperator, _listOperators };
