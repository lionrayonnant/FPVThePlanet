// État opérateur, côté client. Aucun DOM.
//
// L'identité du client vit dans localStorage (fpvmaps.operatorId) et accompagne
// chaque requête : c'est ce qui permet à deux personnes de jouer en même temps
// sur le même serveur de dev. Le serveur ne décide jamais « qui tu es ».
// Repli quand la clé manque (navigateur neuf ou vidé) : 1 opérateur sur disque
// → on l'adopte ; plusieurs → l'appelant montre OPERATOR SELECT.

const OP_BASE = '/__operator';
const KEY = 'fpvmaps.operatorId';
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

async function req(method, path, body) {
	const res = await _fetch(OP_BASE + path, body === undefined ? { method } : {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = await res.json().catch(() => ({}));
	if (!res.ok) { const e = new Error(payload.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
	return payload;
}

export function getOperator() { return cache; }

export async function loadOperator() {
	const id = _store.getItem(KEY);
	if (id) {
		try {
			cache = (await req('GET', `/${id}`)).operator;
			return { operator: cache, needsBootstrap: false, choices: null };
		} catch (e) {
			if (e.status !== 404) throw e;
			_store.removeItem(KEY);
		}
	}
	const { operators } = await req('GET', '');
	if (operators.length === 0) return { operator: null, needsBootstrap: true, choices: null };
	if (operators.length === 1) {
		return { operator: await selectOperator(operators[0].id), needsBootstrap: false, choices: null };
	}
	return { operator: null, needsBootstrap: false, choices: operators.map(({ id, name }) => ({ id, name })) };
}

export async function createOperator(name) {
	cache = (await req('POST', '', { name })).operator;
	_store.setItem(KEY, cache.id);
	return cache;
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

export async function flush() {
	if (timer) { clearTimeout(timer); timer = null; }
	if (!cache || pending.size === 0) return;
	const entries = [...pending.entries()];
	pending.clear();
	for (const [key, value] of entries) {
		try { await req('PATCH', `/${cache.id}`, { key, value }); }
		catch (e) { console.warn('[operator] patch échoué, on retentera', e); pending.set(key, value); }
	}
}

export async function ensureDevOperator() {
	if (cache) return cache;
	const { operators } = await req('GET', '');
	return operators.length ? selectOperator(operators[0].id) : createOperator('dev');
}

if (typeof window !== 'undefined') {
	window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
	window.addEventListener('beforeunload', () => { flush(); });
}
