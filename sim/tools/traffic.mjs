// npm run traffic — what reached the instance, and what reached the repository.
//
//   npm run traffic -- --host root@vps.example.org
//   npm run traffic -- --host vps --days 30
//   npm run traffic -- --no-github          # the VPS alone
//   npm run traffic -- --no-server          # GitHub alone, no ssh
//
// The host can also live in FPVTP_VPS, which is what a shell profile is for.
//
// Two sources, neither of which the other can reach: journald only exists on
// the VPS, and the GitHub traffic API only answers a token with push access —
// which belongs on a workstation and not on a public machine. So the tool runs
// where you are, opens ONE ssh connection, and shells out to `gh` locally.
//
// It reads. It never writes anything, anywhere: no state, no cache, no file.
import { execFileSync } from 'node:child_process';
import { parseJournal, parseCounts, summarizeRequests, summarizeGithub, formatReport, NOT_ASKED } from './traffic-model.mjs';

const REPO = 'lionrayonnant/FPVThePlanet';

function parseArgs(argv) {
	const o = { host: process.env.FPVTP_VPS ?? null, days: 7, github: true, server: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--host') o.host = argv[++i];
		else if (a === '--days') o.days = Math.max(1, Math.min(365, +argv[++i] || 7));
		else if (a === '--no-github') o.github = false;
		else if (a === '--no-server') o.server = false;
		else if (a === '--help' || a === '-h') o.help = true;
		else { o.bad = a; }
	}
	return o;
}

// Everything the VPS is asked for, in one connection: the counts first, then
// the raw journal. The aggregation happens locally, in a module a selftest can
// reach — a pipeline of `jq` typed into an ssh command is neither testable nor
// readable six months later.
//
// `-o cat` drops journald's own prefixes; the non-JSON lines it leaves behind
// are filtered by parseJournal, not by grep, so the reason is written down in
// one place.
const REMOTE = `
ops=$(ls /var/lib/fpvtp/operator-state/*.json 2>/dev/null | wc -l)
fl7=$(find /var/lib/fpvtp/operator-state/tracks -name '*.json' -mtime -DAYS 2>/dev/null | wc -l)
fla=$(find /var/lib/fpvtp/operator-state/tracks -name '*.json' 2>/dev/null | wc -l)
echo "##counts $ops $fl7 $fla"
journalctl -u caddy --since -DAYSd -o cat 2>/dev/null | grep '^{' || true
`;

function collectServer(host, days) {
	const script = REMOTE.replaceAll('-DAYS ', `-${days} `).replaceAll('-DAYSd', `-${days}d`);
	// BatchMode: a tool that hangs on a passphrase prompt inside a pipeline is
	// a tool nobody runs twice. Fail fast and say what to fix instead.
	const out = execFileSync('ssh', ['-o', 'BatchMode=yes', host, 'bash', '-s'], {
		input: script, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
	});
	return {
		counts: parseCounts(out),
		requests: summarizeRequests(parseJournal(out), { now: Date.now() / 1000, days }),
	};
}

function gh(path) {
	return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

function collectGithub() {
	// views and clones need push access; releases do not. Asked separately so a
	// token without the right scope still yields the download counts, which are
	// the figure that actually means a human.
	let views = null, clones = null;
	try { views = gh(`repos/${REPO}/traffic/views`); } catch { /* no push access */ }
	try { clones = gh(`repos/${REPO}/traffic/clones`); } catch { /* idem */ }
	const releases = gh(`repos/${REPO}/releases`);
	return summarizeGithub({ views, clones, releases });
}

const USAGE = `npm run traffic -- [--host user@vps] [--days 7] [--no-github] [--no-server]

  --host    the VPS, as ssh addresses it. Defaults to $FPVTP_VPS.
  --days    window for the journal and the flight count (default 7).

Reads only: one ssh connection, then the GitHub API through \`gh\`.`;

function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) { console.log(USAGE); return; }
	if (o.bad) { console.error(`unknown argument: ${o.bad}\n\n${USAGE}`); process.exitCode = 2; return; }
	if (o.server && !o.host) {
		console.error(`no host: pass --host user@vps, or set FPVTP_VPS.\n\n${USAGE}`);
		process.exitCode = 2;
		return;
	}

	let server = null;
	if (o.server) {
		try { server = collectServer(o.host, o.days); }
		catch (e) { console.error(`ssh ${o.host}: ${String(e.message).trim().split('\n').pop()}`); }
	}

	let github = null;
	if (o.github) {
		try { github = collectGithub(); }
		catch (e) { console.error(`gh: ${String(e.message).trim().split('\n').pop()}`); }
	}

	console.log(formatReport({
		server, github, days: o.days,
		host: o.server ? o.host : NOT_ASKED,
		repo: o.github ? REPO : NOT_ASKED,
		now: Date.now() / 1000,
	}));
}

main();
