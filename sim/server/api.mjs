// The game's API: /__operator (the operator state) and /__map-api (scenes,
// acquisition, jobs).
//
// Extracted as-is from tools/map-api-plugin.mjs (issue #259): it never had any
// dependency on Vite — both route tables are bare node:http, and the plugin
// only brought it its logger. It now serves both hostings: `npm run dev` (the
// Vite adapter, tools/map-api-plugin.mjs) and the standalone server
// (server/index.mjs). No route changed its path, its method, its status code
// or its response shape.
//
// No server dependency: node:http, nothing else.

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
	newId, validateName,
	freshState, migrate,
} from '../tools/operator-store.mjs';
import {
	openSession, closeSession, validateSession,
	reconcileStaleSessions, sanitizeWeatherSnapshot, annotateSession, addPhoto,
	stripPhotoData, stripOperatorPhotoData, deleteSession, SESSION_ID_RE,
} from '../tools/session-model.mjs';
import {
	validateTrack, decodeTrack, pruneTracks, trackIndexEntry, trackBounds,
} from '../tools/track-model.mjs';
import { targetLogEntries } from '../tools/session-log-model.mjs';
import {
	estimateCost, tileGrid, boxDimensions, tileSizeMeters,
	polygonBounds, polygonGrid, polygonArea,
} from '../tools/lib/estimates.mjs';
import { resolveWeather } from '../tools/weather-source.mjs';
import { generateTargetScan, resolveTarget } from '../tools/target-model.mjs';
import {
	generateKey, hashKey, checkKey, acquireEnabled, invalidateKeyIndex, publicOperator,
	operatorIdForKey, bearerOf, checkSignup, checkOperatorQuota,
} from './auth.mjs';
import { checkOrigin } from './origin.mjs';

const BASE = '/__map-api';

const OP_BASE = '/__operator';

// The process's data paths (tools/lib/paths.mjs). One server per process —
// `jobs`/`current` below already assume that — so module state is enough;
// createApi() resets it for a caller that supplies other paths.
let P = defaultPaths;

// `local` or `shared` (createApi). Two things depend on it, and nothing else:
// the operator key (auth.mjs) and acquisition, closed in `shared` whatever
// happens. Same reason to be module state as P: one server per process.
let MODE = 'local';

function ensureOperatorDir() {
	fs.mkdirSync(P.OPERATOR_DIR, { recursive: true });
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function _readOperator(id) {
	if (!ID_RE.test(id)) throw new Error('invalid id');
	const file = path.join(P.OPERATOR_DIR, `${id}.json`);
	if (!fs.existsSync(file)) return null;
	return migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function _writeOperator(state) {
	if (!ID_RE.test(state.id)) throw new Error('invalid id');
	ensureOperatorDir();
	const file = path.join(P.OPERATOR_DIR, `${state.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	invalidateKeyIndex();
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

// --- flight tracks (issue #24) ---------------------------------------------
//
// D5: a track is a FILE beside the operator file, never a key inside it. The
// operator JSON is read and rewritten on every session event; folding 3 MB of
// track data into it would make every one of those writes quadratic.
//
//   <OPERATOR_DIR>/tracks/<operatorId>/<sessionId>.json
//
// Both id and session id are checked against their regexes before they touch a
// path: they come from the URL, and nothing else stands between them and the
// filesystem.
function tracksDirFor(id) {
	if (!ID_RE.test(id)) throw new Error('invalid id');
	return path.join(P.OPERATOR_DIR, 'tracks', id);
}

function trackFileFor(id, sid) {
	if (!SESSION_ID_RE.test(sid)) throw new Error('invalid session id');
	return path.join(tracksDirFor(id), `${sid}.json`);
}

// The session ids that have a track on disk. Cheap enough to call on every
// operator read: a readdir over at most TRACK_KEEP entries.
function trackIdsFor(id) {
	let names;
	try { names = fs.readdirSync(tracksDirFor(id)); } catch { return new Set(); }
	return new Set(names.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
}

// The derived `hasTrack` the UI needs to say NO TRACK on an old flight without
// a second request. Derived on the way OUT only — it is never stored.
function markTracks(state) {
	if (!state || typeof state !== 'object') return state;
	const ids = trackIdsFor(state.id);
	return { ...state, sessions: (state.sessions ?? []).map((s) => ({ ...s, hasTrack: ids.has(s.id) })) };
}

function readTrackFile(file) {
	return validateTrack(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Retention (D3): the newest TRACK_KEEP tracks stay, the rest are removed. The
// sessions and their aggregates are untouched — only per-flight detail is lost.
function pruneTracksOnDisk(id) {
	const dir = tracksDirFor(id);
	let names;
	try { names = fs.readdirSync(dir); } catch { return; }
	const list = names.filter((f) => f.endsWith('.json')).map((f) => {
		let ts = 0;
		try { ts = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* raced */ }
		return { id: f, ts };
	});
	for (const e of pruneTracks(list).dropped) {
		try { fs.rmSync(path.join(dir, e.id)); } catch { /* raced */ }
	}
}

function operatorSummary(s) {
	return {
		id: s.id, name: s.name, createdAt: s.createdAt,
		counts: {
			areas: s.terrainCache.length,
			sessions: s.sessions.length,
			// The Target Log is derived from the sessions (PHASE 17, spec D1).
			targets: targetLogEntries(s.sessions).length,
		},
	};
}

// `dialogueMemory` (PHASE 21): the dialogue engine's anti-repetition memory,
// written through the same debounced `operator.patch()` as `settings`. Purely
// cosmetic — an operator file without this key reads back as a fresh memory
// (src/dialogue.js) — so no shape validation on the server side, just like
// `settings`: it is bounded on the client side (a ring of 256 entries, a table
// of 512 seen, in tools/dialogue/engine.mjs).
//
// `coverage` (issue #245): where the drone has been, in slippy cells at z=20.
// Same contract as dialogueMemory — written by operator.patch() once per
// session (src/session.js), cosmetic, with no shape validation here because it
// is bounded on the client side: MAX_CELLS = 8000 and W_MAX = 8 in
// src/coverage.js, and fromStored() there returns a blank coverage for
// anything that is not the expected shape. An operator without this key reads
// back as a blank map.
const OP_WRITABLE_KEYS = new Set(['settings', 'dialogueMemory', 'coverage']);

// Turns an operator read error into an HTTP code: malformed id → 400, file
// from a too recent schema → 409, everything else (corrupt JSON, I/O) → 500.
// The schema case is recognised on the `schemaVersion` prefix rather than on
// the whole sentence: the message belongs to operator-store.mjs, and matching
// its exact wording would make this 409 hostage to a rewording there.
function opReadErrorStatus(e) {
	if (e.message === 'invalid id') return 400;
	if (e.message.startsWith('schemaVersion')) return 409;
	return 500;
}

const opRoutes = [
	['GET', /^\/$/, async (req, res) => {
		json(res, 200, { operators: _listOperators().map(operatorSummary) });
	}],

	['POST', /^\/$/, async (req, res) => {
		// Signup is self-service (that is the nominal case on the VPS): it
		// therefore has a per-address ceiling, and only that. Nothing in `local`.
		const flood = checkSignup({ mode: MODE, req });
		if (flood) return json(res, flood.status, { error: flood.error });
		const b = await readBody(req, res);
		let name;
		try { name = validateName(b.name); }
		catch (e) { return json(res, 400, { error: e.message }); }
		// Guard against the ~1/65536 id collision: draw again until an id is free.
		let state;
		do { state = freshState({ id: newId(name), name }); }
		while (fs.existsSync(path.join(P.OPERATOR_DIR, state.id + '.json')));
		// The key is handed out HERE and nowhere else: the server only keeps its
		// digest, and no route knows how to read it back in the clear.
		const key = generateKey();
		state.keyHash = hashKey(key);
		_writeOperator(state);
		json(res, 201, { operator: publicOperator(state), key });
	}],

	// "Who am I?", answered by the KEY and nothing else (issue #60). That is
	// what makes it possible to find your operator again from another browser
	// on a `shared` server, where no list says who exists. Placed BEFORE /:id:
	// the two patterns overlap, and the first one found answers.
	['GET', /^\/whoami$/, async (req, res) => {
		const id = operatorIdForKey(P.OPERATOR_DIR, bearerOf(req));
		if (!id) return json(res, 404, { error: 'no operator for this key' });
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: 'no operator for this key' });
		const rec = reconcileStaleSessions(state);
		if (rec.changed) _writeOperator(rec.state);
		json(res, 200, { operator: publicOperator(markTracks(stripOperatorPhotoData(rec.state))) });
	}],

	['GET', /^\/([^/]+)$/, async (req, res, [id]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, opReadErrorStatus(e), { error: e.message });
		}
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		// The terminal reloads the operator on every return to the menu: that is
		// when the sessions whose tab died in flight are caught up.
		const rec = reconcileStaleSessions(state);
		if (rec.changed) _writeOperator(rec.state);
		// The captures' `dataUrl` do NOT travel here (spec D4): the terminal
		// reloads the operator on every return to the menu, and thirty or so
		// photographed sessions would weigh tens of megabytes every time. VIEW
		// SESSION fetches them one by one on the dedicated route.
		//
		// `hasTrack` (issue #24) is derived here, from the tracks directory: the
		// UI can say NO TRACK on an old flight without a second request.
		json(res, 200, { operator: publicOperator(markTracks(stripOperatorPhotoData(rec.state))) });
	}],

	['PATCH', /^\/([^/]+)$/, async (req, res, [id]) => {
		const b = await readBody(req, res);
		if (!OP_WRITABLE_KEYS.has(b.key)) {
			return json(res, 400, { error: `key is not writable: ${b.key}` });
		}
		let state;
		try { state = _readOperator(id); }
		catch (e) {
			return json(res, opReadErrorStatus(e), { error: e.message });
		}
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		// `controlVector` used to leave here with its validation (#33). Both went
		// TOGETHER: keeping the validation without the writable key would have
		// returned an opaque 400 to an old client still patching the vector,
		// whereas the allowlist already refuses it with a clear message.
		state[b.key] = b.value;
		_writeOperator(state);
		json(res, 200, { operator: publicOperator(state) });
	}],

	// World weather for an area (PHASE 04). Read first: if the world state
	// already knows the day, it is read back without touching the network —
	// that is what guarantees two nearby acquisitions see the same weather. The
	// `worldState` key is NOT in OP_WRITABLE_KEYS: the world is not a setting,
	// the client never writes it, only the server fills it in.
	['GET', /^\/([^/]+)\/weather$/, async (req, res, [id], url) => {
		// Number('') and Number(null) are both 0 — a perfectly valid coordinate
		// in the middle of the Gulf of Guinea. Without this guard rail, an
		// absent or empty parameter fills the world state with phantom
		// "0.00,0.00" areas and serves weather that belongs to nobody.
		const num = (v) => (v === null || v.trim() === '' ? NaN : Number(v));
		const lat = num(url.searchParams.get('lat'));
		const lon = num(url.searchParams.get('lon'));
		if (!Number.isFinite(lat) || !Number.isFinite(lon)
			|| lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return json(res, 400, { error: 'lat/lon missing or out of bounds' });
		}
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });

		const day = url.searchParams.get('day') || undefined;
		const { snapshot, changed } = await resolveWeather(state.worldState ?? (state.worldState = {}), {
			lat, lon, day,
			onWarn: (e) => console.warn(`[weather] ${e.message} — falling back`),
		});
		if (changed) _writeOperator(state);
		json(res, 200, { snapshot });
	}],

	// Attaches an already acquired terrain to the operator (PHASE 05, "TERRAIN
	// ACQUIRED" screen -> KEEP TERRAIN). The client only sends the slug: the
	// rest (name, coordinates, weight) comes from public/scenes.json, never
	// from the client — same guard rails as for worldState, on different data.
	//
	// A deliberate departure from the "slug only" principle (PHASE 08): the
	// client also attaches `signalDensity`, the signal density estimate the
	// Global Scanner displays. It depends on `state.place` (a runtime Nominatim
	// answer) and on the drawn area — the server has no way to recompute it
	// from scenes.json. It is a screen estimate, not authoritative terrain
	// data: only its shape is checked.
	['POST', /^\/([^/]+)\/terrain-cache$/, async (req, res, [id]) => {
		const b = await readBody(req, res);
		const slug = String(b.slug ?? '').trim();
		if (!slug) return json(res, 400, { error: 'slug missing' });
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		const scene = readScenes().find((s) => s.slug === slug);
		if (!scene) return json(res, 404, { error: `no map "${slug}"` });
		const entry = {
			slug: scene.slug, name: scene.name, lat: scene.lat, lon: scene.lon,
			bytes: scene.bytes ?? dirSize(path.join(P.SCENES_DIR, slug)),
			keptAt: new Date().toISOString(),
		};
		// A screen estimate (the Global Scanner's signal density), not
		// authoritative terrain data — only the shape is checked.
		const d = b.signalDensity;
		if (d && typeof d === 'object'
			&& Number.isFinite(d.level)
			&& Array.isArray(d.range) && d.range.length === 2 && d.range.every(Number.isFinite)) {
			entry.signalDensity = { level: d.level, range: [d.range[0], d.range[1]] };
		}
		state.terrainCache = (state.terrainCache ?? []).filter((t) => t.slug !== slug);
		state.terrainCache.push(entry);
		_writeOperator(state);
		json(res, 200, { operator: publicOperator(state) });
	}],

	// Opens a session: a PENDING skeleton on disk. Two network writes per
	// flight, this POST at the opening and a PATCH at the closing. Nothing
	// during the flight. A closed session does not reopen (D9, 2026-09-08:
	// landing disappeared, and resuming with it).
	['POST', /^\/([^/]+)\/sessions$/, async (req, res, [id]) => {
		const b = await readBody(req, res);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });

		let session;
		try {
			let target = null;
			if (b.targetSeed) {
				// `swarmChance` (issue #29) comes from the client, which computed it
				// from the operator state it already holds (the early guarantee).
				// The server needs it to regenerate the SAME scan: seed, count and
				// chance fully determine the draw, so `swarmAt` never travels.
				// Absent means 0, not the default chance: a client that says nothing
				// showed no cluster, and the server must not invent one.
				const swarmChance = b.swarmChance ?? 0;
				if (!Number.isFinite(swarmChance) || swarmChance < 0 || swarmChance > 1) {
					return json(res, 400, { error: `swarmChance outside [0,1]: ${b.swarmChance}` });
				}
				const scan = generateTargetScan({ seed: String(b.targetSeed), count: b.targetCount, swarmChance });
				if (!Number.isInteger(b.targetIndex) || b.targetIndex < 0 || b.targetIndex >= scan.candidates.length) {
					return json(res, 400, { error: `targetIndex out of range: ${b.targetIndex}` });
				}
				target = resolveTarget(scan, b.targetIndex);
			} else {
				console.warn('[session] opened without a TARGET SCAN — no target (dev path)');
			}
			session = validateSession(openSession({
				operatorId: state.id,
				area: b.area,
				weatherSnapshot: sanitizeWeatherSnapshot(b.weatherSnapshot ?? null),
				target,
				// Display numbers (PHASE 17). The server alone assigns them: it
				// alone knows the counter. The increment happens only AFTER
				// validation, so that a refused session consumes nothing.
				seq: (state.sessionSeq ?? 0) + 1,
				targetSeq: target ? (state.targetSeq ?? 0) + 1 : undefined,
			}));
			state.sessions.push(session);
			state.sessionSeq = session.seq;
			if (session.targetSeq) state.targetSeq = session.targetSeq;
		} catch (e) { return json(res, 400, { error: e.message }); }

		_writeOperator(state);
		json(res, 201, { session: stripPhotoData(session) });
	}],

	// Closing: sets end, result and the aggregated telemetry. POST is accepted
	// alongside PATCH for navigator.sendBeacon (which can only do POST) at the
	// moment the tab closes.
	['PATCH', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],
	['POST', /^\/([^/]+)\/sessions\/([^/]+)$/, closeSessionRoute],

	// OPERATOR NOTE (PHASE 15): free text, attached to a session whether it is
	// still PENDING or already closed — unlike the closing above, a note is not
	// a verdict, it can be added afterwards.
	['PATCH', /^\/([^/]+)\/sessions\/([^/]+)\/comment$/, async (req, res, [id, sid]) => {
		const b = await readBody(req, res);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });

		const i = state.sessions.findIndex((s) => s.id === sid);
		if (i < 0) return json(res, 404, { error: `no session "${sid}"` });

		let session;
		try { session = validateSession(annotateSession(state.sessions[i], b.comment)); }
		catch (e) { return json(res, 400, { error: e.message }); }

		state.sessions[i] = session;
		_writeOperator(state);
		json(res, 200, { session: stripPhotoData(session) });
	}],

	// Capture (PHASE 16). Written to the session right away, not held back
	// until the closing: a tab that dies in flight must not lose the photos
	// already taken. Base64 inside the session JSON, like the rest of the
	// operator state — no separate binary storage. Body cap raised for this
	// route alone: a capture goes well past the megabyte of the other
	// requests.
	['POST', /^\/([^/]+)\/sessions\/([^/]+)\/photos$/, async (req, res, [id, sid]) => {
		// The ONLY write whose size depends on the client (base64 in the session
		// JSON). PHOTO_BODY_MAX bounds one request, this ceiling bounds the
		// total — without it N strangers fill the VPS's disk. The flight itself
		// is never blocked: opening and closing a session always passes.
		const full = checkOperatorQuota({ mode: MODE, dir: P.OPERATOR_DIR, id });
		if (full) return json(res, full.status, { error: full.error });
		const b = await readBody(req, res, PHOTO_BODY_MAX);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });

		const i = state.sessions.findIndex((s) => s.id === sid);
		if (i < 0) return json(res, 404, { error: `no session "${sid}"` });
		if (state.sessions[i].result !== 'PENDING') {
			return json(res, 409, { error: `session "${sid}" already ${state.sessions[i].result}` });
		}

		let session;
		try { session = validateSession(addPhoto(state.sessions[i], b)); }
		catch (e) { return json(res, 400, { error: e.message }); }

		state.sessions[i] = session;
		_writeOperator(state);
		json(res, 201, { session: stripPhotoData(session) });
	}],

	// The flight track (issue #24). Written ONCE, at the closing (D4), after
	// the session PATCH: a track without a session makes no sense, and losing
	// the track must never cost the session. Idempotent — a second PUT
	// replaces, which makes a resend after a timeout harmless.
	//
	// Body cap raised like the captures route: 18,000 samples fit in a few
	// hundred kilobytes, but not in the megabyte of ordinary requests.
	['PUT', /^\/([^/]+)\/sessions\/([^/]+)\/track$/, async (req, res, [id, sid]) => {
		// Like the captures: the size of this write depends on the client, so it
		// goes through the quota. The flight itself is never blocked.
		const full = checkOperatorQuota({ mode: MODE, dir: P.OPERATOR_DIR, id });
		if (full) return json(res, full.status, { error: full.error });
		const b = await readBody(req, res, PHOTO_BODY_MAX);
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		if (!state.sessions.some((s) => s.id === sid)) {
			return json(res, 404, { error: `no session "${sid}"` });
		}

		let file, track;
		try {
			file = trackFileFor(id, sid);
			track = validateTrack(b);
		} catch (e) { return json(res, 400, { error: e.message }); }

		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(track));
		fs.renameSync(tmp, file);
		pruneTracksOnDisk(id);
		json(res, 200, { sessionId: sid, n: track.n, truncated: track.truncated });
	}],

	// One track, decoded: samples in real units, plus the three point events.
	// It is the only route that returns the full arrays.
	['GET', /^\/([^/]+)\/sessions\/([^/]+)\/track$/, async (req, res, [id, sid]) => {
		let file;
		try { file = trackFileFor(id, sid); }
		catch (e) { return json(res, 400, { error: e.message }); }
		if (!fs.existsSync(file)) return json(res, 404, { error: `no track for "${sid}"` });
		let track;
		try { track = decodeTrack(readTrackFile(file)); }
		catch (e) { return json(res, 500, { error: `unreadable track: ${e.message}` }); }
		json(res, 200, { sessionId: sid, track });
	}],

	// The COMPLETE session, captures included (PHASE 17, spec D4). Every other
	// response elides the `dataUrl`; only the VIEW SESSION screen pays the
	// weight of the images, once, when it opens.
	['GET', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		const session = state.sessions.find((s) => s.id === sid);
		if (!session) return json(res, 404, { error: `no session "${sid}"` });
		json(res, 200, { session: { ...session, hasTrack: trackIdsFor(id).has(sid) } });
	}],

	// The index the flight history overlay consumes (issue #24): for every
	// retained track, a decimated polyline (~100 points), the start, the end and
	// the geolocated photos. NEVER the sample arrays — 200 complete tracks would be
	// 3 MB to draw one-pixel lines.
	//
	// `?bbox=south,west,north,east` filters: the world view does not have to
	// carry everything. A track is kept if its bbox overlaps the requested
	// one.
	['GET', /^\/([^/]+)\/tracks$/, async (req, res, [id], url) => {
		let dir;
		try { dir = tracksDirFor(id); }
		catch (e) { return json(res, 400, { error: e.message }); }

		let box = null;
		const raw = url.searchParams.get('bbox');
		if (raw) {
			const n = raw.split(',').map(Number);
			if (n.length !== 4 || !n.every(Number.isFinite)) {
				return json(res, 400, { error: 'bbox: expected south,west,north,east' });
			}
			box = {
				minLat: Math.min(n[0], n[2]), minLon: Math.min(n[1], n[3]),
				maxLat: Math.max(n[0], n[2]), maxLon: Math.max(n[1], n[3]),
			};
		}

		let names;
		try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
		catch { names = []; }

		const tracks = [];
		for (const f of names) {
			const sid = f.slice(0, -5);
			let entry;
			// A corrupt file does not take the index down: skip the track and the
			// map draws the rest.
			try { entry = trackIndexEntry(readTrackFile(path.join(dir, f)), { sessionId: sid }); }
			catch { continue; }
			if (box) {
				const b = trackBounds(entry);
				if (!b || b.maxLat < box.minLat || b.minLat > box.maxLat
					|| b.maxLon < box.minLon || b.minLon > box.maxLon) continue;
			}
			tracks.push(entry);
		}
		json(res, 200, { tracks });
	}],

	// DELETE SESSION (PHASE 17, spec D3). Outright removal: the entry and its
	// captures disappear, and its target therefore leaves the Target Log, which
	// is derived from them. The terrain is never touched.
	['DELETE', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `no operator "${id}"` });
		let next;
		try { next = deleteSession(state, sid); }
		catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
		_writeOperator(next);
		// The track leaves with the session (issue #24): it no longer has
		// anything to point at, and an orphan would keep weighing on the quota.
		try { fs.rmSync(trackFileFor(id, sid)); } catch { /* no track, or already gone */ }
		json(res, 200, { removed: sid });
	}],
];

async function closeSessionRoute(req, res, [id, sid]) {
	const b = await readBody(req, res);
	let state;
	try { state = _readOperator(id); }
	catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
	if (!state) return json(res, 404, { error: `no operator "${id}"` });

	const i = state.sessions.findIndex((s) => s.id === sid);
	if (i < 0) return json(res, 404, { error: `no session "${sid}"` });
	if (state.sessions[i].result !== 'PENDING') {
		return json(res, 409, { error: `session "${sid}" already ${state.sessions[i].result}` });
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

// One job at a time: downloading two maps in parallel saturates the same link
// and goes no faster, but makes the progress unreadable.
const jobs = new Map();
let current = null;

function json(res, code, body) {
	// The response may already be gone: readBody() answers 413 itself and then
	// destroys the socket, and the rejection it raises still travels up to a
	// route's catch. writeHead() on a finished response throws, which would
	// replace the answer the client actually got with a logged crash (#84).
	if (res.headersSent || res.writableEnded) return;
	const s = JSON.stringify(body);
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(s);
}

// A base64-encoded capture quickly goes past the megabyte of an ordinary JSON
// body (photo + ~33% base64 overhead): a dedicated cap for this route.
const PHOTO_BODY_MAX = 8e6;

// A cross-site request that skips the preflight can only carry a CORS-safelisted
// content type — `text/plain`, a form encoding, or none at all — never
// `application/json` (issue #79). Demanding it is a second lock behind
// checkOrigin() and costs the client nothing: every caller in src/ already sets
// it. A body with no type at all is refused too, because a Blob of empty type
// is exactly how a page sends one without a preflight.
// Lingering close. A socket destroyed while bytes are still in flight sends
// RST, and the client throws away the 413 it had already received — which is
// how the reset survived the first fix (seen on Windows CI, five requests in
// four hundred). So the server keeps reading and discarding for a moment after
// it has answered, bounded in both bytes and time; nginx calls this
// lingering_close and does it for the same reason. An abusive body still gets
// nothing more than this.
const LINGER_BYTES = 4e6;
const LINGER_MS = 2000;

function readBody(req, res, maxBytes = 1e6) {
	const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
	if (type && type !== 'application/json') {
		return Promise.reject(new Error(`body must be application/json, got ${type}`));
	}
	return new Promise((resolve, reject) => {
		let b = '';
		let over = false, drained = 0, timer = null;
		const hangUp = () => { clearTimeout(timer); timer = null; req.destroy(); };
		req.on('data', (d) => {
			if (over) {
				// Answered already: count what still arrives, never keep it.
				drained += d.length;
				if (drained > LINGER_BYTES) hangUp();
				return;
			}
			b += d;
			if (b.length > maxBytes) {
				over = true;
				b = '';
				// Answer, THEN stop listening. Destroying the socket first
				// turned the 413 the server meant to send into an ECONNRESET
				// the GUI reads as "network error" (#84). The rest of the
				// body is still never parsed, which is the point of the cap.
				json(res, 413, { error: 'body too large' });
				reject(new Error('body too large'));
				timer = setTimeout(hangUp, LINGER_MS);
				timer.unref?.();
			}
		});
		req.on('end', () => {
			clearTimeout(timer); timer = null;
			// An oversized body that finished on its own needs no hang-up: the
			// answer is out and the socket closes the ordinary way.
			if (over) return;
			if (b && !type) return reject(new Error('body must be application/json, Content-Type missing'));
			try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid JSON body')); }
		});
		req.on('close', () => { clearTimeout(timer); timer = null; });
		req.on('error', (e) => { clearTimeout(timer); timer = null; reject(e); });
	});
}

// A bbox coming from the browser is not trusted: validate it before handing it
// to a subprocess.
function requireBox(b) {
	if (!b || !['south', 'west', 'north', 'east'].every((k) => Number.isFinite(b[k]))) {
		throw new Error('bbox missing or invalid');
	}
	const box = {
		south: Math.min(b.south, b.north), west: Math.min(b.west, b.east),
		north: Math.max(b.south, b.north), east: Math.max(b.west, b.east),
	};
	if (box.south < -85 || box.north > 85 || box.west < -180 || box.east > 180) throw new Error('bbox out of bounds');
	if (box.south === box.north || box.west === box.east) throw new Error('bbox has zero area');
	return box;
}

// An outline coming from the browser is not trusted: the bounds here are the
// same as those of parseRing() in cmd/export-obj/main.go, so that an outline
// accepted here is not refused three calls later by the Go side.
function requirePoly(p) {
	if (!Array.isArray(p) || p.length % 2 !== 0) throw new Error('outline missing or invalid');
	if (p.length < 6) throw new Error('a polygon has at least 3 vertices');
	if (p.length > 400) throw new Error('at most 200 vertices');
	if (!p.every(Number.isFinite)) throw new Error('outline: non-numeric coordinate');
	const b = polygonBounds(p);
	if (b.south < -85 || b.north > 85 || b.west < -180 || b.east > 180) throw new Error('outline out of bounds');
	if (b.south === b.north || b.west === b.east) throw new Error('outline has zero area');
	if (b.east - b.west >= 180) throw new Error('outline straddles the antimeridian');
	return p;
}

// The routes accept one OR the other zone shape. Sending both would be
// ambiguous; sending neither is a caller's usual mistake.
function requireZone(b) {
	if (b.poly && b.bbox) throw new Error('bbox and poly are mutually exclusive');
	if (b.poly) return { poly: requirePoly(b.poly) };
	return { bbox: requireBox(b.bbox) };
}

// --- the ceiling on how much work one request may ask for -------------------
//
// requireBox/requirePoly bound the SHAPE (in bounds, non-degenerate, at most
// 200 vertices) but not its SIZE, and size is what costs. A ring is legal up
// to 180° x 170°, and polygonGrid then allocates cols x rows and walks every
// cell: measured at zoom 20, a 1° square is 8.5 M cells and 388 ms, 2° is
// 34 M and 1.7 s, 4° is 136 M and 7.8 s. The server is single-process
// (see the note on P/MODE above), so those seconds are seconds during which
// nobody else's terminal, session write or scene fetch is served. /plan and
// /probe are worse in the other direction: each one fans out to kh.google.com
// until traverse() hits its own MAX_NODES.
//
// 4 M cells is deliberately far above anything real. `--radius` is in METRES
// (traverse.mjs:zoneOf), so `add-map --radius 25` (the default) is a 50 m square
// and sweeps 3 x 3 = 9 tiles at zoom 20; radius 35, the largest this manual
// documents, is 4 x 4 = 16. Even a 2 km radius is 160 x 160 = 25,600. 4 M is a
// 2000 x 2000 grid, about 50 x 50 km at zoom 20 — orders of magnitude past any
// zone anyone would actually acquire, and still bounded at ~0.2 s and a few MB.
// The point is not to be tight, it is to be finite.
const MAX_GRID_CELLS = 4_000_000;

// The cell count is the whole cost of the BBOX path, and only part of the cost
// of the POLY one. polygonGrid() runs tileIntersectsPolygon() once per cell and
// that walks the WHOLE ring — so the work is cells x vertices, and requirePoly
// allows 200 vertices. Under the cell cap alone, a 200-vertex 0.2 degree trace
// still measured `POST /describe: 10742 ms`, during which a plain concurrent
// GET waited 10745 ms: the route documented as "callable on every mouse move"
// froze every other player on a `shared` instance.
//
// Calibrated the same way MAX_GRID_CELLS was, from what add-map legitimately
// asks for. The largest zone the manual documents (radius 35 = 16 tiles) at the
// maximum 200 vertices is 3.2e3 units of work; a 4 km x 4 km hand-drawn trace at
// 200 vertices measures 5.1e6 and 100 ms; 8 km x 8 km at 200 vertices is 3.2e7
// and 587 ms. Measured here at ~18 ms per 1e6 units, so 2e7 is about 0.36 s —
// the same order as the ~0.2 s MAX_GRID_CELLS was picked for, four orders of
// magnitude above any real acquisition, and thirty times cheaper than the
// finding. A 25 x 25 km trace at a realistic 20 vertices still passes.
const MAX_POLY_WORK = 20_000_000;

// The mask is only ever used to DRAW the staircase of kept tiles, and
// scanner.js already stops drawing it once tiles fall below 7 px. Past this
// size it is pure weight — 4 M cells would be an 8 MB JSON array on a route
// the scanner may call on every mouse move. Above the ceiling `keep` is
// omitted and the client falls back to the bounding box, a branch it already
// has. `masked`/`columns` stay, so the figures on the rail do not change.
const MAX_MASK_CELLS = 250_000;

// Refuses a zone whose grid at this zoom would be unaffordable, BEFORE any
// grid is allocated — tileGrid() only computes bounds, it allocates nothing,
// and the vertex count is already in hand. The message names the limit and what
// to do about it, because the ways out are not obvious: shrink the zone, drop
// the zoom, or — on the poly path — simplify the trace.
function requireAffordable(zone, zoom) {
	const box = zone.poly ? polygonBounds(zone.poly) : zone.bbox;
	const g = tileGrid(box, zoom);
	const cells = g.cols * g.rows;
	if (cells > MAX_GRID_CELLS) {
		throw new Error(
			`zone too large at zoom ${zoom}: ${cells.toLocaleString('en')} tiles, `
			+ `limit ${MAX_GRID_CELLS.toLocaleString('en')} — reduce the zone or lower the zoom`);
	}
	if (zone.poly) {
		const vertices = zone.poly.length / 2;
		const work = cells * vertices;
		if (work > MAX_POLY_WORK) {
			throw new Error(
				`zone too large at zoom ${zoom}: ${cells.toLocaleString('en')} tiles x `
				+ `${vertices} outline vertices = ${work.toLocaleString('en')} intersection tests, `
				+ `limit ${MAX_POLY_WORK.toLocaleString('en')} — reduce the zone, lower the zoom, `
				+ 'or simplify the outline');
		}
	}
	return zone;
}

// b.provider is optional (the registry default applies then); when supplied it
// must name a registered provider — providers.get() already carries the
// message the GUI displays, and the throw travels up to the middleware's
// generic catch, which renders it as a 400.
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

// Describes a zone: exact geometry + estimates. `columns` comes from the Go
// plan when it is supplied (it pruned the columns outside coverage), otherwise
// from the locally computed grid.
function describe(zone, zoom, altitude, planColumns) {
	const c = centreOf(zone);
	const box = zone.poly ? polygonBounds(zone.poly) : zone.bbox;
	const grid = zone.poly ? polygonGrid(zone.poly, zoom) : tileGrid(box, zoom);
	const columns = Number.isFinite(planColumns) ? planColumns : grid.columns;

	// The area of the OUTLINE, not of its bounding box: on a corridor along a
	// river the two differ by a factor of two or three, and that is the value
	// the screen presents as "zone area".
	const dimensions = boxDimensions(box);
	if (zone.poly) dimensions.area = polygonArea(zone.poly);

	return {
		box, centre: c,
		...(zone.poly ? { poly: zone.poly } : {}),
		dimensions,
		// A Uint8Array does not survive JSON.stringify: the map needs the mask
		// to draw the staircase, so it is returned as an ordinary array.
		grid: {
			...grid,
			keep: grid.keep && grid.keep.length <= MAX_MASK_CELLS ? Array.from(grid.keep) : undefined,
			masked: grid.masked ?? 0,
		},
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
			// A big export's log runs to tens of thousands of lines; only the
			// tail is kept, for catching up after a reload.
			if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
		}
		for (const send of job.listeners) send(event, data);
	};

	// Some parsePrepLine fields are counters that accumulate (one event per
	// chunk/sheet), the rest is a last known state.
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
			// After a skip (tile already cached), jump straight to decode: prep
			// still runs, there was simply nothing to download.
			if (ev.stream === 'phase') { job.phase = ev.done ? 'decode' : ev.line; emit('phase', { phase: job.phase }); return; }
			if (ev.stream === 'stat') { mergeStat(ev.stat); emit('stat', { ...job.pipeline }); return; }
			emit('log', { stream: ev.stream, line: ev.line });
		},
	}).then((r) => {
		job.state = 'done'; job.endedAt = Date.now(); job.result = r;
		// Replayed as-is to a late SSE connection (see the /events route below):
		// without it, a page reload after the job ended only received an empty
		// {message} — slug/bytes/stats disappeared, and PHASE 05's TERRAIN
		// ACQUIRED screen had nothing left to offer KEEP/REMOVE with.
		job.final = { event: 'done', data: { slug: r.slug, bytes: dirSize(r.outDir), stats: r.stats } };
		emit(job.final.event, job.final.data);
	}).catch((e) => {
		job.state = e instanceof Cancelled ? 'cancelled' : 'error';
		job.endedAt = Date.now();
		job.error = e instanceof Cancelled ? 'Cancelled.' : e.message;
		job.final = { event: job.state === 'cancelled' ? 'cancelled' : 'error', data: { message: job.error } };
		emit(job.final.event, job.final.data);
	}).finally(() => {
		if (current === job) current = null;
		for (const send of job.listeners) send('end', {});
	});

	return job;
}

// Destroying server-wide data is a LOCAL operation (issue #78).
//
// In `shared` every /__map-api/* route asks for SOME valid operator key, and
// signup is self-service: there is no role, no ownership. Any player could
// therefore wipe a scene for every user of the instance — and could not rebuild
// it, since acquisition is hard-closed in `shared` (auth.mjs). The mode closes
// the route, exactly as the acquisition flag closes POST /jobs, and it matches
// the documented model: a shared instance serves LIVE only.
const DESTRUCTION_ERROR = 'removal is disabled on a shared server';

function destructionClosed() { return MODE === 'shared'; }

const routes = [
	// `acquire` (issue #60): the REAL state of the right to acquire — the flag
	// set AND local mode. The client uses it to hide DRAW BOX / DRAW SHAPE /
	// ACQUIRE AREA; that is display, the guard is on POST /jobs.
	// `mode` (V1) : where the game runs, 'local' or 'shared'. A distributed
	// desktop build has acquisition CLOSED and is still a local installation,
	// so the footer and the LOCAL-tab notice key on this, not on `acquire`.
	['GET', /^\/scenes$/, async (req, res) => json(res, 200, {
		scenes: sceneList(), acquire: acquireEnabled(MODE), mode: MODE,
	})],

	// The list of registered providers + the registry default (Task 7, issue
	// #18): the GUI populates its selector from it instead of hard-coding the
	// ids.
	['GET', /^\/providers$/, async (req, res) => json(res, 200, {
		providers: listProviders(), default: providers.DEFAULT_PROVIDER_ID,
	})],

	['DELETE', /^\/scenes\/([a-z0-9-]+)$/, async (req, res, [slug], url) => {
		if (destructionClosed()) return json(res, 403, { error: DESTRUCTION_ERROR });
		const scenes = readScenes();
		const i = scenes.findIndex((s) => s.slug === slug);
		if (i < 0) return json(res, 404, { error: `no map "${slug}"` });
		const [entry] = scenes.splice(i, 1);
		writeScenes(scenes);
		fs.rmSync(path.join(P.SCENES_DIR, slug), { recursive: true, force: true });
		let raw = false;
		if (url.searchParams.get('raw') === '1') {
			// The raw tile is found by its name, whatever the shape of the zone,
			// and at ITS provider. The rule lives in add-map-core
			// (rawTileDirFor): the remove-map.mjs CLI shares it, instead of
			// recomputing a Flyover path for every scene (issue #154).
			const dir = await rawTileDirFor(entry);
			if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); raw = true; }
		}
		json(res, 200, { removed: slug, raw });
	}],

	// Instant description of a zone: no network request, callable on every
	// mouse move. Provider-independent (geometry and estimated cost only): no
	// b.provider here.
	['POST', /^\/describe$/, async (req, res) => {
		const b = await readBody(req, res);
		const zoom = intIn(b.zoom, 13, 20, 20);
		const zone = requireAffordable(requireZone(b), zoom);
		json(res, 200, describe(zone, zoom, intIn(b.altitude, 1, 60, 20)));
	}],

	// A real plan: queries the chosen provider's region, prunes the columns
	// outside the footprint, and returns the coverage footprint — without
	// downloading a single tile.
	['POST', /^\/plan$/, async (req, res) => {
		const b = await readBody(req, res);
		const provider = requireProvider(b);
		const zoom = intIn(b.zoom, 13, 20, 20), altitude = intIn(b.altitude, 1, 60, 20);
		const zone = requireAffordable(requireZone(b), zoom);
		const c = centreOf(zone);
		const plan = await planScan({ lat: c.lat, lon: c.lon, zoom, altitude, provider, ...zone });
		json(res, 200, { plan, ...describe(zone, zoom, altitude, plan.columns) });
	}],

	// Probe: the only proof that there really is photogrammetry here.
	['POST', /^\/probe$/, async (req, res) => {
		const b = await readBody(req, res);
		const provider = requireProvider(b);
		const zoom = intIn(b.zoom, 13, 20, 20);
		const zone = requireAffordable(requireZone(b), zoom);
		const c = centreOf(zone);
		json(res, 200, await probeCoverage({
			lat: c.lat, lon: c.lon, provider, ...zone,
			zoom, altitude: intIn(b.altitude, 1, 60, 20),
		}));
	}],

	['GET', /^\/jobs$/, async (req, res) => json(res, 200, {
		jobs: [...jobs.values()].map(({ id, slug, name, state, phase, hits, startedAt, endedAt, error }) =>
			({ id, slug, name, state, phase, hits, startedAt, endedAt, error })),
	})],

	['POST', /^\/jobs$/, async (req, res) => {
		// The only route that brings a scene into existence on disk, hence the
		// only one that carries the guard. Nothing to do with the operator key:
		// that one says who speaks, this one what has the right to exist here
		// (D2).
		if (!acquireEnabled(MODE)) {
			return json(res, 403, { error: 'terrain acquisition is disabled on this server' });
		}
		if (current) return json(res, 409, { error: 'an extraction is already running', jobId: current.id });
		const b = await readBody(req, res);
		const zone = requireAffordable(requireZone(b), intIn(b.zoom, 13, 20, 20));
		const provider = requireProvider(b);
		const name = String(b.name ?? '').trim();
		if (!name) return json(res, 400, { error: 'name missing' });
		const slug = (b.slug ? slugify(b.slug) : slugify(name));
		if (!slug) return json(res, 400, { error: 'the name yields no usable identifier' });

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
		if (destructionClosed()) return json(res, 403, { error: DESTRUCTION_ERROR });
		const job = jobs.get(id);
		if (!job) return json(res, 404, { error: 'unknown job' });
		job.ctrl.abort();
		json(res, 200, { cancelling: id });
	}],

	// SSE. The log buffer is replayed on connection, so that a page reload
	// during a ten-minute export does not lose the thread.
	['GET', /^\/jobs\/([0-9a-f-]+)\/events$/, async (req, res, [id]) => {
		const job = jobs.get(id);
		if (!job) return json(res, 404, { error: 'unknown job' });
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		});
		const send = (event, data) => {
			try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
		};
		send('state', { state: job.state, phase: job.phase, hits: job.hits, pipeline: job.pipeline, error: job.error });
		for (const l of job.log) send('log', l);
		if (job.state === 'running') {
			job.listeners.add(send);
			const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 15000);
			req.on('close', () => { job.listeners.delete(send); clearInterval(ka); });
		} else {
			// job.final carries the REAL terminal event (see startJob): a late
			// connection (a reload after the job ended) must see exactly what a
			// connection left open would have received, slug and stats
			// included — not a generic reconstruction.
			const fallback = { event: job.state === 'done' ? 'done' : job.state, data: { message: job.error ?? '' } };
			const { event, data } = job.final ?? fallback;
			send(event, data);
			send('end', {});
			res.end();
		}
	}],
];

// The factory. `paths` comes from tools/lib/paths.mjs (the process default in
// dev, the standalone server's `--data`); `logger` is Vite's in dev, the
// console in standalone. `mode` has been part of the signature from the start
// but no route looked at it until operator keys arrived; it is now what
// selects them, and what keeps acquisition closed in `shared`.
export function createApi({ paths = defaultPaths, mode = 'local', logger = console } = {}) {
	P = paths;
	MODE = mode;
	return async function api(req, res, next) {
		const onOperator = req.url === OP_BASE || req.url?.startsWith(OP_BASE + '/') || req.url?.startsWith(OP_BASE + '?');
		if (onOperator || req.url?.startsWith(BASE)) {
			// Where the request comes FROM, before anything about who sends it
			// (issue #79). Static files stay out of it: they are the same bytes
			// for everyone, and in dev Vite has its own host check for them.
			const foreign = checkOrigin({ mode: MODE, req });
			if (foreign) return json(res, foreign.status, { error: foreign.error });
		}
		if (onOperator) {
			const url = new URL(req.url, 'http://localhost');
			const p = url.pathname.slice(OP_BASE.length) || '/';
			// In `shared`, the root has only two possible answers: create an
			// operator (without a key — otherwise nobody could ever sign up) or
			// nothing. No public list: on a server that receives strangers,
			// enumerating the operators is already a leak.
			if (MODE === 'shared' && p === '/' && req.method === 'GET') {
				return json(res, 404, { error: 'no operator directory on this server' });
			}
			if (!(p === '/' && req.method === 'POST')) {
				// /whoami does not name an operator, it LOOKS one up: the key
				// alone decides, otherwise you would already have to know who
				// you are to ask. A generated id always carries a hexadecimal
				// suffix (operator-store.newId), so "whoami" never names one.
				const named = /^\/([^/]+)/.exec(p)?.[1] ?? null;
				const denied = checkKey({ mode: MODE, dir: P.OPERATOR_DIR, req, id: named === 'whoami' ? null : named });
				if (denied) return json(res, denied.status, { error: denied.error });
			}
			const onPath = opRoutes.filter(([, re]) => re.test(p));
			if (!onPath.length) return json(res, 404, { error: `unknown route: ${p}` });
			const route = onPath.find(([method]) => method === req.method);
			if (!route) return json(res, 405, { error: `${req.method} not supported on ${p}`, allow: onPath.map(([m]) => m) });
			try {
				return await route[2](req, res, route[1].exec(p).slice(1), url);
			} catch (e) {
				// readBody() answers its own 413 and then rejects: the request
				// is already handled, and a stack in the log would say
				// otherwise.
				if (res.headersSent) return;
				logger.error(`[operator] ${p}: ${e.stack ?? e.message}`);
				return json(res, 400, { error: e.message });
			}
		}
		if (!req.url?.startsWith(BASE)) return next();
		const url = new URL(req.url, 'http://localhost');
		const p = url.pathname.slice(BASE.length) || '/';
		// /__map-api/* names no operator: the key alone says who speaks. In
		// `local` the header is not even read.
		{
			const denied = checkKey({ mode: MODE, dir: P.OPERATOR_DIR, req });
			if (denied) return json(res, denied.status, { error: denied.error });
		}
		// Several routes share a path (GET and POST /jobs): look for the method
		// among ALL those that match the path, and answer 405 only if none
		// fits.
		const onPath = routes.filter(([, re]) => re.test(p));
		if (!onPath.length) return json(res, 404, { error: `unknown route: ${p}` });
		const route = onPath.find(([method]) => method === req.method);
		if (!route) {
			return json(res, 405, {
				error: `${req.method} not supported on ${p}`,
				allow: onPath.map(([m]) => m),
			});
		}
		try {
			return await route[2](req, res, route[1].exec(p).slice(1), url);
		} catch (e) {
			if (res.headersSent) return;   // readBody() already answered 413
			logger.error(`[map-api] ${p}: ${e.stack ?? e.message}`);
			return json(res, 400, { error: e.message });
		}
	};
}

export { _readOperator, _writeOperator, _listOperators };
