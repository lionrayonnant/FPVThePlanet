// Fuzzing the HTTP surface, against a REAL server.
//
//   node tools/fuzz-api.mjs [--cases 400] [--seed 7] [--verbose]
//
// server/index.mjs is started on a free port with a throwaway data directory,
// then fed malformed requests: hostile ids in the path, bodies that are not
// JSON, bodies that are JSON but not the shape the route wants, a body over the
// size cap, wrong methods, wrong content types. What is checked is not the
// status code of each route — the selftests do that — but the four things that
// must hold whatever arrives:
//
//   1. no 5xx: every refusal is a deliberate one, not a stack trace;
//   2. the answer is always JSON the client can read;
//   3. no refusal leaks a filesystem path or a stack frame;
//   4. the server is still alive and its state still readable afterwards —
//      one bad request must not cost an operator file.
//
// Routes that reach the network or start a terrain extraction (/plan, /probe,
// POST /jobs) are deliberately out: fuzzing them would fuzz Google's servers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-fuzz-'));
// Before the first import that reads it — same contract as the api selftest.
process.env.FPVTP_DATA_DIR = DIR;
delete process.env.FPV_OPERATOR_DIR;

const { startServer } = await import('../server/index.mjs');
const { encodeTrack } = await import('./track-model.mjs');
const {
	pick, int, chance, anyValue, mutate, jsonText, pretty, runTargetAsync, NASTY_STRINGS,
} = await import('./lib/fuzz.mjs');

const argv = process.argv.slice(2);
const flagOf = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const cases = Number(flagOf('cases', 400));
const seed = Number(flagOf('seed', 0x46555a5a));
const verbose = argv.includes('--verbose');

// Every refusal this fuzzer provokes is logged by the route that refused —
// that is the server working, and thousands of them would bury the findings.
// Only the deliberate `[operator]`/`[map-api]` refusal lines are swallowed;
// anything else the server has to say still comes through.
const realError = console.error;
console.error = (...args) => {
	if (typeof args[0] === 'string' && /^\[(operator|map-api)\] /.test(args[0])) return;
	realError(...args);
};

const started = await startServer({ dataDir: DIR, distDir: path.join(DIR, 'dist'), port: '0' });
const base = started.url.replace(/\/$/, '');

// --- a real operator to aim at ----------------------------------------------

const post = async (p, body) => {
	const r = await fetch(base + p, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
	});
	return r.json();
};

const operator = (await post('/__operator', { name: 'fuzz' })).operator;
const OP = operator.id;
const SID = (await post(`/__operator/${OP}/sessions`, {
	area: 'tour-eiffel', weatherSnapshot: null, targetSeed: 'fuzz-seed', targetCount: 4, targetIndex: 1,
})).session.id;

const GOOD_TRACK = encodeTrack(
	[{ t: 0, lat: 48.85, lon: 2.29, alt: 30, spd: 12, thr: 0.5, rate: 90 }],
	{ start: { lat: 48.85, lon: 2.29 } },
);
const GOOD_PHOTO = { dataUrl: 'data:image/jpeg;base64,/9j/AAA=', w: 480, h: 360 };

// --- the request space ------------------------------------------------------

// Path templates, with {op} and {sid} filled in per case. Read-only and
// state-changing routes both; nothing that touches the network.
const ROUTES = [
	['GET', '/__operator'],
	['POST', '/__operator', () => ({ name: 'fuzz' })],
	['GET', '/__operator/whoami'],
	['GET', '/__operator/{op}'],
	['PATCH', '/__operator/{op}', () => ({ name: 'renamed' })],
	['GET', '/__operator/{op}/weather'],
	['POST', '/__operator/{op}/terrain-cache', () => ({ slug: 'tour-eiffel' })],
	['POST', '/__operator/{op}/sessions', () => ({ area: 'tour-eiffel', weatherSnapshot: null })],
	['GET', '/__operator/{op}/sessions/{sid}'],
	['PATCH', '/__operator/{op}/sessions/{sid}', () => ({ result: 'CRASHED', telemetry: { durationS: 12, distanceM: 40, maxSpeedMs: 9, maxRateDps: 100, maxAltitudeM: 20 } })],
	['PATCH', '/__operator/{op}/sessions/{sid}/comment', () => ({ comment: 'note' })],
	['POST', '/__operator/{op}/sessions/{sid}/photos', () => GOOD_PHOTO],
	['PUT', '/__operator/{op}/sessions/{sid}/track', () => ({ track: GOOD_TRACK })],
	['GET', '/__operator/{op}/sessions/{sid}/track'],
	['GET', '/__operator/{op}/tracks'],
	['DELETE', '/__operator/{op}/sessions/{sid}'],
	['GET', '/__map-api/scenes'],
	['GET', '/__map-api/providers'],
	['GET', '/__map-api/jobs'],
	['POST', '/__map-api/describe', () => ({ bbox: { south: 48.85, west: 2.29, north: 48.86, east: 2.30 }, zoom: 20 })],
	['DELETE', '/__map-api/scenes/tour-eiffel'],
];

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'];

// An id as it arrives in the URL: the real one, a plausible wrong one, or an
// attempt at the filesystem. Percent-encoded, because that is the only way a
// traversal survives the client's own path normalization.
function someId(r, real) {
	if (chance(r, 0.45)) return real;
	const hostile = pick(r, [
		'..', '../..', '.', '', 'x'.repeat(3000), 'UPPER', 'a b', 'a/b',
		'%2e%2e%2f%2e%2e%2fetc%2fpasswd', '%00', 'a%00b', 'tracks',
		'neo-0000.json', '../operator-state/neo-0000', '*', 'a$b', 'nul',
		...NASTY_STRINGS.filter((s) => s.length > 0 && s.length < 60),
	]);
	// A lone surrogate cannot be percent-encoded at all — encodeURIComponent
	// throws on it. That is a value a crafted link really can carry, so it goes
	// out raw and lets the server's own URL parsing deal with it.
	try {
		return encodeURIComponent(hostile).replace(/%25/g, '%');   // keep crafted escapes crafted
	} catch {
		return hostile;
	}
}

// The body: the route's own shape, a mutation of it, pure noise, or not JSON
// at all.
function someBody(r, good) {
	switch (int(r, 0, 8)) {
		case 0: return good ? jsonText(good()) : '';
		case 1: return good ? jsonText(mutate(r, good(), 3)) : jsonText(anyValue(r, 2));
		case 2: return jsonText(anyValue(r, 3));
		case 3: return pick(r, ['', 'null', '[]', '"x"', '0', 'true', '{', '{"a":', 'not json at all', '\0']);
		case 4: return `{"x":"${'A'.repeat(int(r, 1, 4) * 300000)}"}`;   // around the 1 MB body cap
		case 5: return jsonText({ __proto__: { polluted: true }, ...(good ? good() : {}) });
		case 6: return jsonText(good ? { ...good(), extra: anyValue(r, 2) } : anyValue(r, 1));
		// Valid JSON that breaks `String(v)`: a field whose own toString is null.
		// Every route that slugifies or names a field back at the client walks
		// into it.
		case 7: return jsonText({ ...(good ? good() : {}), [pick(r, ['area', 'name', 'slug', 'result', 'comment'])]: { toString: null } });
		default: return undefined;   // no body at all
	}
}

// --- invariants -------------------------------------------------------------

// A refusal names what is wrong, never where the server keeps its files.
const LEAKS = [DIR, os.homedir(), '/node_modules/', 'node:internal', '    at '];

function leakIn(text) {
	for (const l of LEAKS) if (l && text.includes(l)) return l;
	return null;
}

const target = {
	name: 'http',
	gen(r) {
		const [method, template, good] = pick(r, ROUTES);
		return {
			method: chance(r, 0.8) ? method : pick(r, METHODS),
			path: template.replace('{op}', someId(r, OP)).replace('{sid}', someId(r, SID)),
			query: chance(r, 0.75) ? '' : `?${pick(r, ['limit=-1', 'limit=1e9', 'lat=NaN&lon=NaN', 'day=../..', 'a'.repeat(2000), 'zoom=99'])}`,
			body: someBody(r, good),
			contentType: chance(r, 0.8) ? 'application/json' : pick(r, ['text/plain', 'application/x-www-form-urlencoded', '', 'application/json; charset=utf-16']),
		};
	},
	async check({ method, path: p, query, body, contentType }) {
		const sendable = method !== 'GET' && method !== 'HEAD' && body !== undefined;
		let res;
		try {
			res = await fetch(base + p + query, {
				method,
				headers: sendable ? { 'content-type': contentType } : undefined,
				body: sendable ? body : undefined,
			});
		} catch (err) {
			// readBody() destroys the request as soon as a body passes its cap, so
			// an oversized one is answered with a reset rather than with the 400
			// the route meant to send. Documented here rather than failed on: the
			// routes that carry a real payload (photos, tracks) have the 8 MB cap,
			// so only an abusive body reaches this, and holding the connection
			// open to answer politely is what an abusive body wants (issue #84).
			// Every OTHER
			// dead connection is a finding.
			if (sendable && body.length > 1e6) return null;
			return `the connection died instead of answering (${err?.cause?.code ?? err.message})`;
		}
		if (res.status >= 500) {
			return `HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`;
		}
		const text = await res.text();
		if (method !== 'HEAD' && text.length > 0) {
			let parsed;
			try { parsed = JSON.parse(text); } catch {
				return `answered ${res.status} with something that is not JSON: ${text.slice(0, 120)}`;
			}
			const leak = leakIn(JSON.stringify(parsed));
			if (leak) return `the answer leaks ${leak}: ${text.slice(0, 200)}`;
		}
		// Still alive, still readable: the operator file survives whatever that
		// request was, and it is still the JSON the next boot will parse.
		const after = await fetch(`${base}/__operator/${OP}`);
		if (after.status !== 200) return `a known-good read broke after this request: HTTP ${after.status}`;
		try { await after.json(); } catch { return 'the operator no longer reads back as JSON'; }
		// Nothing may appear outside the operator directory.
		const stray = fs.readdirSync(DIR).filter((f) => !['operator-state', 'dist', 'scenes', 'scenes.json', 'cache'].includes(f));
		if (stray.length) return `the request created ${stray.join(', ')} in the data directory`;
		if (({}).polluted !== undefined) return 'a request body polluted Object.prototype';
		return null;
	},
};

console.log(`fuzz-api: ${cases} requests, seed 0x${seed.toString(16)}, data in ${DIR}\n`);

const result = await runTargetAsync(target, { cases, seed, verbose });
console.log(`  ${result.failures.length === 0 ? ' ok ' : 'FAIL'}  http  ${result.ms} ms`);
for (const f of result.failures) {
	console.log(`        ${f.kind}: ${f.detail}`);
	console.log(`        seen in ${f.count ?? 1} case(s), smallest input (case ${f.case}):`);
	console.log(`          ${pretty(f.input)}`);
}

await started.close?.();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${result.failures.length === 0 ? 'no findings' : `${result.failures.length} finding(s)`} — replay with --seed 0x${seed.toString(16)} --cases ${cases}`);
process.exit(result.failures.length === 0 ? 0 : 1);
