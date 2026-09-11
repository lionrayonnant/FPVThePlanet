// Where a request comes FROM (issue #79).
//
// auth.mjs answers who speaks (the operator key) and what may be born on disk
// (FPVTP_ACQUIRE). Neither covers the browser itself: in `local` mode there is
// no key by design — the security boundary is the loopback socket — and a
// browser will happily carry a hostile page's requests to that socket. Two
// attacks live in that gap, and both are stopped by headers a page cannot
// forge from script:
//
//   1. DNS rebinding. A name whose A record flips to 127.0.0.1 makes the
//      attacker's page SAME-ORIGIN with the dev or standalone server, so it
//      reads every answer: operator profiles, sessions, captures, the scene
//      list — and can delete scenes. The `Host` header still carries the
//      attacker's name, and the browser sets it: refusing anything but
//      loopback in `local` closes it.
//   2. Cross-site requests. A simple POST (no preflight, `text/plain`) reaches
//      the API even though the response stays unreadable — enough to create
//      operators or write sessions. `Origin` and `Sec-Fetch-Site` both come
//      from the browser, so an unsafe method that does not look same-origin is
//      refused.
//
// In `shared` the host is whatever domain the instance answers on, so only the
// second guard applies — the operator key does the rest.
//
// No dependency: plain headers.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// `Host` and the authority of an `Origin` both look like `name[:port]`, with an
// IPv6 literal in brackets. Only the name is wanted here.
export function hostnameOf(value) {
	const raw = String(value ?? '').trim().toLowerCase();
	if (!raw) return '';
	if (raw.startsWith('[')) {
		const end = raw.indexOf(']');
		return end > 0 ? raw.slice(1, end) : raw.slice(1);
	}
	return raw.split(':')[0];
}

// The whole 127.0.0.0/8 is loopback, not just .1 — and `localhost` resolves
// nowhere else.
export function isLoopbackHost(name) {
	return name === 'localhost' || name === '::1'
		|| /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

// Authority (name + port) of an `Origin`, or null when there is none to
// compare: `null` (sandboxed iframe, file://) and anything unparsable included.
function authorityOf(origin) {
	const raw = String(origin ?? '').trim();
	if (!raw || raw === 'null') return null;
	try { return new URL(raw).host.toLowerCase(); } catch { return null; }
}

// Returns `null` when the request passes, otherwise { status, error } — the
// same shape as the guards in auth.mjs.
export function checkOrigin({ mode = 'local', req } = {}) {
	const host = String(req?.headers?.host ?? '').trim().toLowerCase();

	// Guard 1. A missing Host is refused with the rest: HTTP/1.1 requires it,
	// every browser sends it, and letting it through would hand back the
	// rebinding hole for free.
	if (mode !== 'shared' && !isLoopbackHost(hostnameOf(host))) {
		return { status: 403, error: 'this server only answers on loopback — check the address' };
	}

	// Guard 2. Reads are left alone: in `local` the Host check above already
	// keeps a foreign page from reading anything, and in `shared` the operator
	// key does.
	const method = String(req?.method ?? 'GET').toUpperCase();
	if (SAFE_METHODS.has(method)) return null;

	// `none` is a typed address or a bookmark — no initiator, so nothing to
	// be cross about. `same-origin` is the game itself.
	const site = String(req?.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase();
	if (site && site !== 'same-origin' && site !== 'none') {
		return { status: 403, error: `cross-site request refused (Sec-Fetch-Site: ${site})` };
	}

	// An older browser sends no Sec-Fetch-Site but still sends Origin on an
	// unsafe method. Same origin as the page we serve, or — in `local`, where
	// dev and standalone servers sit on different loopback ports — some other
	// loopback origin.
	const origin = req?.headers?.origin;
	if (origin !== undefined) {
		const authority = authorityOf(origin);
		const ok = authority !== null
			&& (authority === host || (mode !== 'shared' && isLoopbackHost(hostnameOf(authority))));
		if (!ok) return { status: 403, error: `cross-origin request refused (Origin: ${String(origin).slice(0, 80)})` };
	}

	return null;
}
