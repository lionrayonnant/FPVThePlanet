// État opérateur, côté client. Aucun DOM.
//
// L'identité du client vit dans localStorage (fpvtp.operatorId) et accompagne
// chaque requête : c'est ce qui permet à deux personnes de jouer en même temps
// sur le même serveur de dev. Le serveur ne décide jamais « qui tu es ».
// Repli quand la clé manque (navigateur neuf ou vidé) : l'appelant montre
// toujours OPERATOR SELECT — même avec un seul opérateur sur disque, pour
// qu'un nouveau client (ex. ami sur un tunnel ngrok partagé) puisse créer le
// sien plutôt que d'hériter du tien.
//
// La CLÉ d'opérateur (fpvtp.operatorKey, issue #60) est autre chose : un
// secret de 128 bits rendu une fois à la création, envoyé en `Authorization:
// Bearer` sur chaque requête. Un serveur `local` ne la regarde jamais ; un
// serveur `shared` la réclame. Elle n'a RIEN à voir avec le Control Vector
// (Bible §33) : celui-ci est un rituel de jeu, celle-là un secret technique.
// Elle n'est JAMAIS montrée à l'inscription — le navigateur la garde, point.
// Sur 401/403 on efface id ET clé et l'appelant montre OPERATOR KEY.

const OP_BASE = '/__operator';
const KEY = 'fpvtp.operatorId';
const OP_KEY = 'fpvtp.operatorKey';
const DEBOUNCE_MS = 500;

let _fetch = (...a) => globalThis.fetch(...a);
let _store = safeStore();
export function _setFetch(fn) { _fetch = fn; }
export function _setStore(obj) { _store = obj; }

function safeStore() {
	try {
		const s = globalThis.localStorage;
		s.getItem(KEY); // déclenche le throw en navigation privée verrouillée
		return s;
	} catch {
		const m = new Map();
		return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
	}
}

let cache = null;
const pending = new Map();        // key -> value en attente d'écriture
let timer = null;

export function getKey() { return _store.getItem(OP_KEY); }
export function hasKey() { return Boolean(getKey()); }
export function setKey(key) {
	const k = String(key ?? '').trim();
	if (k) _store.setItem(OP_KEY, k); else _store.removeItem(OP_KEY);
}

// Efface l'identité locale. Ni l'id ni la clé ne survivent à un refus du
// serveur : garder l'un sans l'autre rejouerait le même 401 à chaque écran.
export function forgetOperator() {
	cache = null;
	_store.removeItem(KEY);
	_store.removeItem(OP_KEY);
}

export function authHeaders() {
	const k = getKey();
	return k ? { authorization: `Bearer ${k}` } : {};
}

async function req(method, path, body) {
	const headers = authHeaders();
	const res = await _fetch(OP_BASE + path, body === undefined ? { method, headers } : {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = await res.json().catch(() => ({}));
	if (!res.ok) { const e = new Error(payload.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
	return payload;
}

export function getOperator() { return cache; }

// Rend une seule de ces quatre formes : un opérateur chargé, needsBootstrap,
// une liste de choices, ou needsKey (le serveur `shared` ne nous reconnaît pas —
// clé absente, fausse, ou opérateur d'avant #60 sans clé).
const NEEDS_KEY = { operator: null, needsBootstrap: false, choices: null, needsKey: true };

function refused(e) { return e.status === 401 || e.status === 403; }

export async function loadOperator() {
	const id = _store.getItem(KEY);
	if (id) {
		try {
			cache = (await req('GET', `/${id}`)).operator;
			return { operator: cache, needsBootstrap: false, choices: null, needsKey: false };
		} catch (e) {
			if (refused(e)) { forgetOperator(); return NEEDS_KEY; }
			if (e.status !== 404) throw e;
			_store.removeItem(KEY);
		}
	}
	let operators;
	try { operators = (await req('GET', '')).operators; }
	catch (e) {
		// 404 sur la liste : c'est un serveur `shared`, qui n'en publie pas. 401 /
		// 403 : la clé qu'on porte ne vaut rien. Dans les deux cas, l'écran
		// OPERATOR KEY — entrer une clé, ou repartir sur un nouvel opérateur.
		if (refused(e) || e.status === 404) { forgetOperator(); return NEEDS_KEY; }
		throw e;
	}
	if (operators.length === 0) return { operator: null, needsBootstrap: true, choices: null, needsKey: false };
	return {
		operator: null, needsBootstrap: false, needsKey: false,
		choices: operators.map(({ id, name }) => ({ id, name })),
	};
}

export async function createOperator(name) {
	// La création est la seule route que le mode `shared` laisse ouverte sans
	// clé : sans elle, personne ne pourrait jamais s'inscrire sur le VPS.
	const { operator, key } = await req('POST', '', { name });
	cache = operator;
	_store.setItem(KEY, cache.id);
	// SILENCIEUSEMENT. On ne fait pas noter un secret de 128 bits à quelqu'un qui
	// vient voler : le navigateur la garde, et [ SHOW KEY ] (ARCHIVE) la rend le
	// jour où l'on veut emporter son profil ailleurs.
	if (key) setKey(key);
	return cache;
}

// Retrouver son opérateur depuis un autre navigateur : on pose la clé, puis on
// demande au serveur qui elle désigne. C'est la clé qui identifie — le serveur
// `shared` ne publie aucune liste où choisir.
export async function resumeWithKey(key) {
	const previous = getKey();
	setKey(key);
	try {
		const { operator } = await req('GET', '/whoami');
		cache = operator;
		_store.setItem(KEY, cache.id);
		return cache;
	} catch (e) {
		setKey(previous ?? '');
		throw e;
	}
}

export async function selectOperator(id) {
	cache = (await req('GET', `/${id}`)).operator;
	_store.setItem(KEY, cache.id);
	return cache;
}

export function patch(key, value) {
	if (!cache) throw new Error('aucun opérateur chargé');
	cache[key] = value;
	pending.set(key, value);
	if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
}

export async function listOperators() {
	return (await req('GET', '')).operators;
}

// Rattache un terrain déjà acquis à l'opérateur courant (PHASE 05, KEEP
// TERRAIN). Contrairement à patch(), c'est un appel serveur direct plutôt
// qu'un debounce : la décision est unique et son écran attend la confirmation.
// `extra` optionnel : { signalDensity: { level, range } } — une estimation
// d'écran du Global Scanner que le serveur ne peut pas recalculer (voir la route).
export async function keepTerrain(slug, extra = {}) {
	if (!cache) throw new Error('aucun opérateur chargé');
	cache = (await req('POST', `/${cache.id}/terrain-cache`, { slug, ...extra })).operator;
	return cache;
}

// Sessions (PHASE 06). Le cycle de vie complet vit dans src/session.js ; ici on
// n'expose que les deux appels réseau, parce que c'est cette couche qui connaît
// l'id de l'opérateur courant.
export async function postSession(body) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('POST', `/${cache.id}/sessions`, body)).session;
}

export async function patchSession(sid, body) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('PATCH', `/${cache.id}/sessions/${sid}`, body)).session;
}

// OPERATOR NOTE (PHASE 15) : distincte de patchSession — s'applique aussi à une
// session déjà close, que closeSessionRoute (PENDING seulement) refuserait.
export async function patchSessionComment(sid, comment) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('PATCH', `/${cache.id}/sessions/${sid}/comment`, { comment })).session;
}

// La session COMPLÈTE, captures comprises (PHASE 17). Les autres réponses
// élident les `dataUrl` : seul VIEW SESSION paie le poids des images, et
// seulement à son ouverture.
export async function getSession(sid) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('GET', `/${cache.id}/sessions/${sid}`)).session;
}

// DELETE SESSION (PHASE 17). Le cache local est mis à jour tout de suite : la
// Home se reconstruit derrière l'écran de détail, et son footer doit compter
// juste sans refaire un GET complet.
export async function deleteSession(sid) {
	if (!cache) throw new Error('aucun opérateur chargé');
	const { removed } = await req('DELETE', `/${cache.id}/sessions/${sid}`);
	cache.sessions = (cache.sessions ?? []).filter((s) => s.id !== sid);
	return removed;
}

// Une capture (PHASE 16). Écriture immédiate, pas attendue la clôture de
// session : un onglet mort en vol ne doit pas perdre les photos déjà prises.
export async function postPhoto(sid, body) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('POST', `/${cache.id}/sessions/${sid}/photos`, body)).session;
}

export function operatorBase() { return OP_BASE; }

export async function flush() {
	if (timer) { clearTimeout(timer); timer = null; }
	if (!cache || pending.size === 0) return;
	const entries = [...pending.entries()];
	pending.clear();
	let successCount = 0;
	let lastError = null;
	for (const [key, value] of entries) {
		try { await req('PATCH', `/${cache.id}`, { key, value }); successCount++; }
		catch (e) {
			console.warn('[operator] patch échoué, on retentera', e);
			lastError = e;
			pending.set(key, value);
			// Réarme le debounce : une panne non surveillée doit quand même retenter.
			if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
		}
	}
	// Rien n'a été écrit : on le signale à l'appelant plutôt que de mentir « sauvé ».
	if (entries.length > 0 && successCount === 0) throw lastError;
}

export async function ensureDevOperator() {
	if (cache) return cache;
	const id = _store.getItem(KEY);
	if (id) {
		try { return await selectOperator(id); }
		catch (e) { if (e.status !== 404) throw e; _store.removeItem(KEY); }
	}
	const { operators } = await req('GET', '');
	return operators.length ? selectOperator(operators[0].id) : createOperator('dev');
}

// --- la clé sur TOUTES les requêtes de l'API du jeu ---------------------------
//
// Un seul point d'attache, et c'est délibéré : `/__map-api` est appelé depuis
// scanner.js, bootstrap.js, post-flight.js et terminal.js, `/__operator/:id`
// aussi depuis weather.js. Répéter l'en-tête dans chaque module, c'est
// s'exposer au premier oubli — qui ne se verrait qu'en `shared`, sur le seul
// hébergement où il compte. En `local` le serveur ne lit jamais l'en-tête : ce
// qui suit n'y change rigoureusement rien.
const API_PREFIXES = [OP_BASE, '/__map-api'];

function isGameApi(url) {
	const u = String(url ?? '');
	const p = u.startsWith('/') ? u : (() => { try { return new URL(u, location.href).pathname; } catch { return ''; } })();
	return API_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/') || p.startsWith(pre + '?'));
}

function headerObject(h) {
	if (!h) return {};
	// Headers, Map, ou un tableau de paires : tous itérables par forEach.
	if (typeof h.forEach === 'function') { const o = {}; h.forEach((v, k) => { o[Array.isArray(h) ? v[0] : k] = Array.isArray(h) ? v[1] : v; }); return o; }
	return { ...h };
}

export function installAuthFetch(target = globalThis) {
	const raw = target.fetch?.bind(target);
	if (!raw) return;
	target.fetch = (input, init) => {
		const url = typeof input === 'string' ? input : (input?.url ?? '');
		const key = getKey();
		if (!key || !isGameApi(url)) return raw(input, init);
		const headers = headerObject(init?.headers ?? (typeof input === 'object' ? input?.headers : null));
		if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
			headers.authorization = `Bearer ${key}`;
		}
		return raw(input, { ...init, headers });
	};
}

if (typeof window !== 'undefined') {
	installAuthFetch();
	window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
	window.addEventListener('beforeunload', () => { flush(); });
}
