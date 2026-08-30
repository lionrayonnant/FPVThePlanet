// npm run music-review
//
// La dernière porte, et la seule qui juge : l'oreille. Le gate mesuré écarte ce
// qui est cassé, il ne sait rien dire de ce qui est bon. Rien n'entre dans
// public/music/ sans passer ici.
//
// Un morceau accepté est déplacé dans public/music/<pool>/ et ajouté à
// public/music.json. Refusé, il reste dans le staging (gitignoré) : on ne
// supprime rien, pour pouvoir réécouter et ajuster les prompts.
//
// Touches : o accepter · k refuser · r rejouer · l écouter la COUTURE de
// boucle · s passer · q sauver et quitter.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { STAGING, SIM } from './music-gen.mjs';
import { POOLS } from './music-prompts.mjs';
import { MUSIC_SCHEMA_VERSION, validateManifest } from './music-model.mjs';

const MUSIC_DIR = join(SIM, 'public/music');
const MANIFEST = join(SIM, 'public/music.json');

// Les refus sont MÉMORISÉS. Sans ça, chaque nouvelle vague represente les
// morceaux déjà écartés — on refuse deux fois le même, et le temps d'écoute est
// la ressource rare de tout ce pipeline. Le fichier vit dans le staging, donc
// gitignoré : c'est un journal de travail local, pas une donnée du jeu.
const REJECTED = join(STAGING, 'rejected.json');

// Combien de secondes de part et d'autre du point de bouclage la touche `l`
// fait entendre.
const SEAM_S = 5;

const ESC = '';

function loadRejected() {
	try { return new Set(JSON.parse(readFileSync(REJECTED, 'utf8'))); }
	catch { return new Set(); }
}

function saveRejected(set) {
	writeFileSync(REJECTED, JSON.stringify([...set].sort(), null, '\t') + '\n');
}

function loadManifest() {
	if (!existsSync(MANIFEST)) return { schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [] };
	return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function saveManifest(m) {
	m.tracks.sort((a, b) => (a.pool.localeCompare(b.pool) || a.id.localeCompare(b.id)));
	const problems = validateManifest(m);
	if (problems.length) throw new Error(`manifeste invalide, rien n'a été écrit :\n  ${problems.join('\n  ')}`);
	writeFileSync(MANIFEST, JSON.stringify(m, null, '\t') + '\n');
}

let player = null;
function stopPlayer() {
	if (player && !player.killed) { try { player.kill('SIGKILL'); } catch { /* déjà mort */ } }
	player = null;
}

function play(file, extra = []) {
	stopPlayer();
	player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', ...extra, file], { stdio: 'ignore' });
}

/**
 * Fabrique et joue le raccord de boucle : les SEAM_S dernières secondes suivies
 * des SEAM_S premières. C'est exactement ce que l'oreille entendra au moment où
 * le morceau repart — le seul défaut que le gate ne sait pas mesurer.
 */
function playSeam(file, durS) {
	const tmp = join(STAGING, '.seam.wav');
	const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error',
		'-i', file, '-filter_complex',
		`[0:a]atrim=${Math.max(0, durS - SEAM_S)}:${durS},asetpts=N/SR/TB[a];`
		+ `[0:a]atrim=0:${SEAM_S},asetpts=N/SR/TB[b];[a][b]concat=n=2:v=0:a=1[out]`,
		'-map', '[out]', tmp], { encoding: 'utf8' });
	if (r.status !== 0) { console.log('  (couture non fabriquée)'); return; }
	play(tmp);
}

function fmtAxes(axes = {}) {
	return Object.entries(axes).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' · ');
}

async function run() {
	if (!existsSync(STAGING)) { console.error(`${STAGING} n'existe pas`); process.exit(1); }
	if (!process.stdin.isTTY) { console.error("music-review a besoin d'un terminal interactif"); process.exit(1); }

	const manifest = loadManifest();
	const known = new Set(manifest.tracks.map((t) => t.id));
	const rejected = loadRejected();

	const all = readdirSync(STAGING).filter((f) => f.endsWith('.opus')).sort()
		.map((f) => basename(f, '.opus'));
	const candidates = all.filter((id) => !known.has(id) && !rejected.has(id));
	const skipped = all.length - candidates.length;

	if (!candidates.length) {
		console.log(`rien de neuf à écouter${skipped ? ` (${skipped} déjà jugé(s))` : ''}`);
		console.log('lance npm run add-music, puis music-gate et music-loop');
		return;
	}

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding('utf8');
	const key = () => new Promise((res) => process.stdin.once('data', res));

	console.log(`${candidates.length} morceau(x) à écouter · ${manifest.tracks.length} déjà dans le jeu`
		+ (skipped ? ` · ${skipped} déjà jugé(s), non representé(s)` : ''));
	console.log('o accepter · k refuser · r rejouer · l couture · s passer · q sauver et quitter\n');

	let accepted = 0;
	let nRejected = 0;
	let quit = false;

	for (const [i, id] of candidates.entries()) {
		if (quit) break;
		const file = join(STAGING, `${id}.opus`);
		const meta = JSON.parse(readFileSync(join(STAGING, `${id}.json`), 'utf8'));
		const spec = POOLS[meta.pool];
		console.log(`[${i + 1}/${candidates.length}] ${id}`);
		console.log(`  ${spec?.label ?? meta.pool} · ${meta.bpm} BPM · ${meta.loopDurS?.toFixed(1)} s · ${meta.lufs} LUFS`);
		console.log(`  visé : ${spec?.feel ?? '—'}`);
		console.log(`  ${fmtAxes(meta.axes)}`);
		play(file);

		let done = false;
		while (!done) {
			const k = (await key()).toLowerCase();
			if (k === 'o') {
				stopPlayer();
				const dir = join(MUSIC_DIR, meta.pool);
				mkdirSync(dir, { recursive: true });
				renameSync(file, join(dir, `${id}.opus`));
				manifest.tracks.push({
					id, pool: meta.pool, file: `music/${meta.pool}/${id}.opus`,
					durS: meta.loopDurS, bpm: meta.bpm, axes: meta.axes,
					prompt: meta.prompt, seed: meta.seed, modelSeed: meta.modelSeed,
					model: meta.model, lufs: meta.lufs,
				});
				accepted++; console.log('  → accepté\n'); done = true;
			} else if (k === 'k') {
				stopPlayer(); rejected.add(id); nRejected++;
				console.log('  → refusé\n'); done = true;
			} else if (k === 's') {
				// Passer n'est PAS refuser : le morceau reviendra à la prochaine
				// session, c'est ce qui distingue les deux touches.
				stopPlayer(); console.log('  → passé\n'); done = true;
			} else if (k === 'r') {
				play(file);
			} else if (k === 'l') {
				playSeam(file, meta.loopDurS);
			} else if (k === 'q' || k === ESC || k === '') {
				stopPlayer(); quit = true; done = true;
			}
		}
	}

	stopPlayer();
	const seam = join(STAGING, '.seam.wav');
	if (existsSync(seam)) unlinkSync(seam);
	// Le manifeste et le journal des refus sont écrits même sur un abandon : ce
	// qui a été jugé est acquis, sinon une session de revue interrompue serait
	// entièrement à refaire.
	saveRejected(rejected);
	saveManifest(manifest);
	process.stdin.setRawMode(false);
	console.log(`\n${accepted} accepté(s), ${nRejected} refusé(s) · ${manifest.tracks.length} morceaux dans le jeu`);
	console.log(`→ ${MANIFEST}`);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	run().catch((e) => { console.error(`[music-review] ${e.message}`); process.exit(1); });
}
