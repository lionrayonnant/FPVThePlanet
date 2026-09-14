// node tools/resume.mjs   (npm run resume)
//
// Everything a local session needs to pick this branch up, in one command. It
// is written for a machine with network access and a browser, which is what the
// remote session that produced this branch did not have — the two things that
// block every open item on it.
//
// It fetches the propeller database if it is missing, runs the validation that
// needs it, runs the fast physics benches, and then prints what to do next.
// Nothing here is required for the sim to run; it is a starting gun.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SIM = process.cwd();
const DATA = path.join(SIM, '.data');
const DB = path.join(DATA, 'UIUC-propDB');
const ZIP_URL = 'https://m-selig.ae.illinois.edu/props/download/UIUC-propDB.zip';

const line = (s = '') => console.log(s);
const rule = (t) => { line(); line(`── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); };

function git(...args) {
	try { return execFileSync('git', args, { cwd: SIM, encoding: 'utf8' }).trim(); }
	catch { return '?'; }
}

// `unzip --version` exits 10, so probe each tool with a flag it accepts.
function has(cmd, arg = '--version') {
	return spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
}

rule('where you are');
line(`branch   ${git('rev-parse', '--abbrev-ref', 'HEAD')}`);
line(`commit   ${git('log', '-1', '--oneline')}`);
line(`ahead of main by ${git('rev-list', '--count', 'origin/main..HEAD')} commit(s)`);
const dirty = git('status', '--porcelain');
line(`worktree ${dirty ? 'HAS UNCOMMITTED CHANGES' : 'clean'}`);

rule('propeller database (UIUC)');
if (fs.existsSync(DB)) {
	line(`already here: ${DB}`);
} else if (!has('curl') || !has('unzip', '-v')) {
	line('curl and unzip are needed to fetch it automatically, and one is missing.');
	line(`download by hand: ${ZIP_URL}`);
	line(`unzip into:       ${DATA}/`);
} else {
	line(`fetching ${ZIP_URL}`);
	fs.mkdirSync(DATA, { recursive: true });
	const zip = path.join(DATA, 'UIUC-propDB.zip');
	const got = spawnSync('curl', ['-fsSL', '--max-time', '600', '-o', zip, ZIP_URL], { stdio: 'inherit' });
	if (got.status !== 0) {
		line('could not download it — network blocked, or the URL moved.');
		line(`try by hand, then unzip into ${DATA}/`);
	} else {
		spawnSync('unzip', ['-q', '-o', zip, '-d', DATA], { stdio: 'inherit' });
		fs.rmSync(zip, { force: true });
		// The archive's top-level folder name has changed before; find it.
		if (!fs.existsSync(DB)) {
			const found = fs.readdirSync(DATA, { withFileTypes: true })
				.find((e) => e.isDirectory() && /prop/i.test(e.name));
			if (found) fs.renameSync(path.join(DATA, found.name), DB);
		}
		line(fs.existsSync(DB) ? `unpacked into ${DB}` : `unpacked into ${DATA} (check the folder name)`);
	}
}

rule('blade-element model against measured propellers');
spawnSync(process.execPath, ['tools/uiuc-prop-validate.mjs'], { cwd: SIM, stdio: 'inherit' });

rule('the physics benches (seconds, not the full chain)');
for (const t of [
	'tools/aero-selftest.mjs',
	'tools/blade-element-selftest.mjs',
	'tools/frame-pacing-selftest.mjs',
	'tools/force-budget-selftest.mjs',
	'tools/onboard-regime-selftest.mjs',
]) {
	const r = spawnSync(process.execPath, [t], { cwd: SIM, encoding: 'utf8' });
	const out = (r.stdout || '').trim().split('\n').filter((l) => /ok|PASS|FAIL|tests/.test(l));
	const bad = r.status !== 0;
	line(`${bad ? 'FAIL' : ' ok '}  ${path.basename(t).padEnd(34)} ${out[out.length - 1] ?? ''}`);
	if (bad) line((r.stdout || r.stderr || '').split('\n').slice(-12).join('\n'));
}

rule('what to do next');
line('Read docs/PICKUP.md — it is written for whoever (or whatever) picks this up,');
line('and it ranks the open items. The short version:');
line();
line('  1. FLY IT. Nine commits, not one of them flown in a browser.');
line('       npm run dev      then   __sim.budget()  ...fly...  __sim.budget(true)');
line('  2. Read the propeller validation above. If the errors are large, the');
line('     blade-element model is wrong and nothing downstream of it matters.');
line('  3. Only then decide whether to wire blade-element.js into quad.js.');
line();
