// What the traffic report is, as data and as text.
//
// Pure and Node-safe: no ssh, no gh, no clock of its own. The CLI
// (tools/traffic.mjs) collects the bytes, this file decides what they mean and
// how they read. That split is what lets tools/traffic-selftest.mjs check the
// arithmetic and the layout without a VPS and without a network.

// One request line of Caddy's JSON access log. The journal also carries
// systemd's own lines ("Reloading caddy.service") and Caddy's startup
// messages, which are not requests and sometimes not JSON at all — `jq` dies
// on the first of them, and so would a naive JSON.parse over the stream.
export function parseJournal(text) {
	const out = [];
	for (const line of String(text).split('\n')) {
		const s = line.trim();
		if (!s.startsWith('{')) continue;
		let o;
		try { o = JSON.parse(s); } catch { continue; }
		const r = o.request;
		if (!r || typeof r.uri !== 'string') continue;
		out.push({
			ts: typeof o.ts === 'number' ? o.ts : 0,
			ip: r.remote_ip ?? '',
			clientIp: r.client_ip ?? '',
			uri: r.uri,
			status: typeof o.status === 'number' ? o.status : 0,
		});
	}
	return out;
}

// The /24 (or /48) a masked address belongs to. The log is already truncated
// by Caddy — this only groups what is left, it does not anonymise anything.
// Counting these is counting neighbourhoods, never people, and the report says
// so in as many words.
export function block(ip) {
	return String(ip || '').trim();
}

// Rolling windows, not calendar days. The VPS runs in UTC and the operator
// rarely does; "today" would then mean two different things depending on who
// reads it, and a number that shifts with the reader is worse than no number.
export function summarizeRequests(records, { now, days = 7 } = {}) {
	const since24 = now - 86400;
	const sinceN = now - days * 86400;
	const win = records.filter((r) => r.ts >= sinceN);
	const day = win.filter((r) => r.ts >= since24);
	const paths = new Map();
	for (const r of win) paths.set(r.uri, (paths.get(r.uri) ?? 0) + 1);
	const blocks = new Set(win.map((r) => block(r.ip)).filter(Boolean));
	return {
		days,
		day: day.length,
		window: win.length,
		blocks: blocks.size,
		clientErrors: win.filter((r) => r.status >= 400 && r.status < 500).length,
		serverErrors: win.filter((r) => r.status >= 500).length,
		paths: [...paths.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
	};
}

// The counts the remote snippet prints on one line, ahead of the journal: how
// many operators exist, and how many flights were written in the window. They
// are files on disk, not log lines, which is why they survive a journal that
// only starts at the last reload.
export function parseCounts(text) {
	const m = String(text).match(/^##counts\s+(\d+)\s+(\d+)\s+(\d+)/m);
	if (!m) return null;
	return { operators: +m[1], flights: +m[2], flightsTotal: +m[3] };
}

// GitHub answers three different shapes; only the totals are kept, plus the
// assets of the newest release. Download counts per asset are the honest
// measure of "did anyone install it" — views and clones count robots too.
export function summarizeGithub({ views, clones, releases } = {}) {
	const latest = Array.isArray(releases) ? releases.find((r) => !r.draft && !r.prerelease) ?? releases[0] : null;
	const assets = latest?.assets?.filter((a) => /\.(exe|AppImage|tar\.gz)$/.test(a.name)) ?? [];
	return {
		views: views ? { count: views.count ?? 0, uniques: views.uniques ?? 0 } : null,
		clones: clones ? { count: clones.count ?? 0, uniques: clones.uniques ?? 0 } : null,
		release: latest ? latest.tag_name : null,
		downloads: assets.map((a) => ({ name: a.name, count: a.download_count ?? 0 })),
	};
}

// What `host` and `repo` carry when the run deliberately skipped a source. A
// skipped source and an unreachable one look identical in a report otherwise,
// and only one of the two is a problem.
export const NOT_ASKED = 'not asked';

const WIDTH = 30;

// A dotted leader, because a column of numbers has to be readable at a glance
// and the labels are not the same length. Same device as the BUILD NOTES
// screen: the dots carry the eye, the number lands in one place.
function row(label, value) {
	const l = ` ${label} `;
	const dots = '.'.repeat(Math.max(1, WIDTH - l.length));
	return `  ${l}${dots} ${value}`;
}

export function formatReport({ server, github, host, repo, now, days = 7 } = {}) {
	const stamp = new Date((now ?? 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
	const out = [`FPVTP! — TRAFFIC`.padEnd(26) + `${stamp} UTC`, ''];

	out.push(` SERVER  ${host ?? '—'}`);
	if (!server) {
		out.push(host === NOT_ASKED ? '  skipped' : '  unreachable — see the error above');
	} else {
		const s = server.requests;
		const n = (v) => String(v).padStart(5);
		out.push(row('requests 24h', n(s.day)));
		out.push(row(`requests ${days}d`, n(s.window)));
		out.push(row(`distinct blocks ${days}d`, n(s.blocks)));
		out.push(row(`4xx / 5xx ${days}d`, `${n(s.clientErrors)} / ${s.serverErrors}`));
		if (server.counts) {
			out.push(row('operators', n(server.counts.operators)));
			out.push(row(`flights ${days}d`, `${n(server.counts.flights)}  (${server.counts.flightsTotal} total)`));
		}
		if (s.paths.length) {
			out.push('', `  busiest paths ${days}d`);
			for (const [uri, n] of s.paths) out.push(`    ${String(n).padStart(5)}  ${uri}`);
		} else {
			// An empty journal is the expected state right after the access log
			// is switched on, and it is NOT a failure. Saying so here saves the
			// next reader from re-debugging a working setup.
			out.push('', '  no request in the window — the access log starts at the Caddy reload');
		}
		out.push('', '  addresses are masked to a /24 by Caddy: these are neighbourhoods, not people');
	}

	out.push('', ` GITHUB  ${repo ?? '—'}`);
	if (!github) {
		out.push(repo === NOT_ASKED ? '  skipped' : '  unavailable — gh not installed, not authenticated, or no push access');
	} else {
		if (github.views) out.push(row('views 14d', `${String(github.views.count).padStart(5)}  (${github.views.uniques} unique)`));
		if (github.clones) out.push(row('clones 14d', `${String(github.clones.count).padStart(5)}  (${github.clones.uniques} unique)`));
		if (github.release) {
			out.push('', `  downloads  ${github.release}`);
			for (const d of github.downloads) out.push(`    ${String(d.count).padStart(5)}  ${d.name}`);
		}
		out.push('', '  views and clones count robots too; a download is the only figure a person made');
	}
	return out.join('\n');
}
