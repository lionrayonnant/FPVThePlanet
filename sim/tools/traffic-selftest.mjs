// Selftest of the traffic report (tools/traffic-model.mjs). No ssh, no gh, no
// network, no clock: every window is computed against a fixed `now`.
// Run: node tools/traffic-selftest.mjs
import assert from 'node:assert/strict';
import { parseJournal, parseCounts, summarizeRequests, summarizeGithub, formatReport, NOT_ASKED } from './traffic-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const NOW = 1789318831; // 2026-09-13T17:00:31Z, the reload that started the log
const req = (ts, uri, ip = '203.0.113.0', status = 200) =>
	JSON.stringify({ level: 'info', ts, logger: 'http.log.access.log0', msg: 'handled request', request: { remote_ip: ip, client_ip: ip, uri }, status });

// The journal is NOT a JSON stream. systemd writes its own lines into the same
// unit, and this is exactly what made `jq` die with "Invalid numeric literal"
// on a working server.
t('parseJournal: systemd lines and startup noise are skipped, not fatal', () => {
	const text = [
		'Reloading caddy.service - Caddy...',
		JSON.stringify({ level: 'info', msg: 'using config from file', file: '/etc/caddy/Caddyfile' }),
		req(NOW, '/'),
		'{ this is not json',
		'Reloaded caddy.service - Caddy.',
		req(NOW, '/scenes.json'),
	].join('\n');
	const rows = parseJournal(text);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((r) => r.uri), ['/', '/scenes.json']);
});

t('parseJournal: a line without request is not a request', () => {
	assert.equal(parseJournal(JSON.stringify({ level: 'info', msg: 'server running' })).length, 0);
	assert.equal(parseJournal('').length, 0);
});

t('summarizeRequests: the 24h window is inside the 7d one', () => {
	const rows = parseJournal([
		req(NOW - 3600, '/'),
		req(NOW - 3 * 86400, '/'),
		req(NOW - 30 * 86400, '/old'),
	].join('\n'));
	const s = summarizeRequests(rows, { now: NOW, days: 7 });
	assert.equal(s.day, 1);
	assert.equal(s.window, 2);
	assert.deepEqual(s.paths, [['/', 2]]);
});

t('summarizeRequests: blocks are counted, statuses are split', () => {
	const rows = parseJournal([
		req(NOW, '/a', '203.0.113.0'),
		req(NOW, '/a', '203.0.113.0'),
		req(NOW, '/b', '198.51.100.0', 404),
		req(NOW, '/c', '198.51.100.0', 500),
	].join('\n'));
	const s = summarizeRequests(rows, { now: NOW });
	assert.equal(s.blocks, 2);
	assert.equal(s.clientErrors, 1);
	assert.equal(s.serverErrors, 1);
	assert.equal(s.paths[0][0], '/a');
});

t('parseCounts: the marker line, and its absence', () => {
	assert.deepEqual(parseCounts('##counts 3 12 40\n{"x":1}'), { operators: 3, flights: 12, flightsTotal: 40 });
	assert.equal(parseCounts('{"x":1}'), null);
});

// A prerelease is not what an installer download is measured against, and the
// .blockmap files beside an installer are electron-updater's business.
t('summarizeGithub: newest stable release, installers only', () => {
	const g = summarizeGithub({
		views: { count: 5, uniques: 3 },
		clones: { count: 943, uniques: 247 },
		releases: [
			{ tag_name: 'v1.2.0-rc1', prerelease: true, assets: [] },
			{ tag_name: 'v1.1.0', assets: [
				{ name: 'FPVTP-1.1.0-win-x64.exe', download_count: 1 },
				{ name: 'FPVTP-1.1.0-win-x64.exe.blockmap', download_count: 9 },
				{ name: 'latest.yml', download_count: 7 },
			] },
		],
	});
	assert.equal(g.release, 'v1.1.0');
	assert.deepEqual(g.downloads, [{ name: 'FPVTP-1.1.0-win-x64.exe', count: 1 }]);
	assert.equal(g.views.uniques, 3);
	assert.equal(g.clones.count, 943);
});

t('summarizeGithub: no push access still yields the downloads', () => {
	const g = summarizeGithub({ releases: [{ tag_name: 'v1.0.0', assets: [] }] });
	assert.equal(g.views, null);
	assert.equal(g.clones, null);
	assert.equal(g.release, 'v1.0.0');
});

// An empty journal is the normal state right after the access log is turned
// on. The report has to say that, because a zero that looks like a breakage
// sends the reader back into a working configuration.
t('formatReport: an empty window explains itself', () => {
	const out = formatReport({
		host: 'vps', repo: 'owner/repo', now: NOW, days: 7,
		server: { counts: { operators: 0, flights: 0, flightsTotal: 0 }, requests: summarizeRequests([], { now: NOW }) },
		github: null,
	});
	assert.match(out, /no request in the window/);
	assert.match(out, /the access log starts at the Caddy reload/);
	assert.match(out, /neighbourhoods, not people/);
});

t('formatReport: skipped and unreachable do not read alike', () => {
	const skipped = formatReport({ host: NOT_ASKED, repo: NOT_ASKED, now: NOW });
	assert.match(skipped, /SERVER {2}not asked\n {2}skipped/);
	assert.match(skipped, /GITHUB {2}not asked\n {2}skipped/);
	const down = formatReport({ host: 'vps', repo: 'owner/repo', now: NOW });
	assert.match(down, /unreachable/);
	assert.match(down, /unavailable/);
});

t('formatReport: the figures land in the text', () => {
	const rows = parseJournal([req(NOW, '/'), req(NOW, '/'), req(NOW - 2 * 86400, '/x')].join('\n'));
	const out = formatReport({
		host: 'vps', repo: 'owner/repo', now: NOW, days: 7,
		server: { counts: { operators: 4, flights: 2, flightsTotal: 9 }, requests: summarizeRequests(rows, { now: NOW }) },
		github: summarizeGithub({ views: { count: 5, uniques: 3 }, releases: [] }),
	});
	assert.match(out, /requests 24h \.+ +2/);
	assert.match(out, /requests 7d \.+ +3/);
	assert.match(out, /operators \.+ +4/);
	assert.match(out, /flights 7d \.+ +2 {2}\(9 total\)/);
	assert.match(out, /views 14d \.+ +5 {2}\(3 unique\)/);
	assert.match(out, / {4}2 {2}\//);
});

console.log(`\n${n} traffic tests OK`);
