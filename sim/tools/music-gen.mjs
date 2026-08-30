// npm run add-music -- --pool race5 --count 10 [--duration 90] [--model medium]
//
// Génère des candidats dans .music-staging/ (gitignoré). Ne touche JAMAIS
// public/music/ ni public/music.json : entre les deux il y a le gate mesuré
// (music-gate.mjs), le bouclage (music-loop.mjs) et l'écoute (music-review.mjs).
// Un morceau n'entre dans le jeu que si une oreille l'a validé.
//
// Le modèle pèse 1.4B et met plus longtemps à charger qu'à générer : le worker
// Python est lancé UNE fois avec tout le lot.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC_POOLS, POOLS, buildPrompt } from './music-prompts.mjs';
import { rngFrom } from './target-build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIM = resolve(HERE, '..');
export const STAGING = join(SIM, '.music-staging');

// L'installation Stable Audio n'est PAS dans le dépôt (elle pèse ~10 Go avec
// les poids) : son emplacement se donne par FPVTP_STABLE_AUDIO, avec pour
// défaut un ../stableaudio3.0 à côté du dépôt.
//
// On appelle le python du venv directement plutôt que la commande
// `stable-audio` : le venv est souvent créé ailleurs puis déplacé, et ses
// shebangs pointent alors vers un chemin mort. PYTHONPATH sur les sources
// parce que le paquet n'est pas installé dans le venv, juste résolu depuis
// son répertoire.
const SA_ROOT = resolve(process.env.FPVTP_STABLE_AUDIO ?? resolve(SIM, '../stableaudio3.0'));
const PYTHON = join(SA_ROOT, '.venv/bin/python');
const SA_SRC = join(SA_ROOT, 'stable-audio-3');

export const DEFAULTS = {
	// 90 s : assez long pour qu'un vol court ne boucle jamais, assez court pour
	// que la revue à l'oreille reste faisable et que le dépôt reste tenable.
	duration: 90,
	model: 'medium',
	steps: 8,
	cfgScale: 1.0,
};

function parseArgs(argv) {
	const out = { pool: null, count: 1, seedBase: 'v1', ...DEFAULTS };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--pool') out.pool = next();
		else if (a === '--count') out.count = Number(next());
		else if (a === '--duration') out.duration = Number(next());
		else if (a === '--model') out.model = next();
		else if (a === '--steps') out.steps = Number(next());
		else if (a === '--seed-base') out.seedBase = next();
		else throw new Error(`argument inconnu : ${a}`);
	}
	return out;
}

// Identifiant court et stable : la même (pool, seedBase, index) rend toujours
// le même id, donc relancer la commande reprend le lot au lieu de le doubler.
// Le passage par rngFrom n'est pas décoratif : un FNV brut sur des clés
// voisines (…::0, …::1) rend des hachés voisins, et une liste de revue où tous
// les ids se ressemblent est une liste où l'on se trompe de ligne. L'avalanche
// xorshift les sépare.
export function trackId(pool, seedBase, index) {
	const rand = rngFrom(`${pool}::${seedBase}::${index}::id`);
	const hex = () => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
	return `${pool}-${hex()}${hex()}`;
}

/** Construit le plan de génération. Pur : testable sans GPU. */
export function planFor({ pool, count, seedBase, duration }) {
	const jobs = [];
	for (let i = 0; i < count; i++) {
		const seed = `${seedBase}::${i}`;
		const id = trackId(pool, seedBase, i);
		const { bpm, prompt, axes } = buildPrompt(pool, seed);
		jobs.push({
			id, pool, bpm, prompt, axes, seed,
			// Stable Audio veut un entier ; on le dérive de la même clé pour que
			// la génération soit reproductible modèle et version égaux.
			modelSeed: Math.abs([...`${seed}::sa`].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193), 0x811c9dc5) | 0) % 2147483647,
			durationS: duration,
			out: join(STAGING, `${id}.wav`),
		});
	}
	return jobs;
}

async function run() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.pool) throw new Error('--pool est requis (ou "all")');
	const pools = opts.pool === 'all' ? MUSIC_POOLS : [opts.pool];
	for (const p of pools) {
		if (!MUSIC_POOLS.includes(p)) throw new Error(`pool inconnu : ${p} (connus : ${MUSIC_POOLS.join(', ')})`);
	}
	if (!existsSync(PYTHON)) {
		throw new Error(`python du venv Stable Audio introuvable : ${PYTHON}\n`
			+ 'Donne le chemin de l\'installation avec FPVTP_STABLE_AUDIO=/chemin/vers/stableaudio3.0');
	}

	mkdirSync(STAGING, { recursive: true });

	const jobs = pools.flatMap((pool) => planFor({ ...opts, pool }));
	// La fiche est écrite AVANT la génération : si le lot est interrompu, on sait
	// toujours d'où vient chaque wav qui traîne.
	for (const j of jobs) {
		writeFileSync(join(STAGING, `${j.id}.json`), JSON.stringify({
			id: j.id, pool: j.pool, bpm: j.bpm, axes: j.axes, prompt: j.prompt,
			seed: j.seed, modelSeed: j.modelSeed, durationS: j.durationS,
			model: `stable-audio-3-${opts.model}`, steps: opts.steps,
		}, null, '\t') + '\n');
	}

	console.log(`${jobs.length} morceau(x) — ${pools.map((p) => POOLS[p].label).join(', ')}`);
	console.log(`durée ${opts.duration} s · modèle ${opts.model} · ${opts.steps} pas → ${STAGING}`);

	const plan = {
		model: opts.model, duration: opts.duration, steps: opts.steps, cfg_scale: opts.cfgScale,
		jobs: jobs.map((j) => ({ id: j.id, prompt: j.prompt, seed: j.modelSeed, out: j.out })),
	};

	const code = await new Promise((res, rej) => {
		const child = spawn(PYTHON, [join(HERE, 'music-gen.py')], {
			env: { ...process.env, PYTHONPATH: SA_SRC },
			stdio: ['pipe', 'pipe', 'inherit'],
		});
		let buf = '';
		child.stdout.on('data', (d) => {
			buf += d;
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const r = JSON.parse(line);
					if (r.skipped) console.log(`  ~ ${r.id} déjà présent`);
					else if (r.ok) console.log(`  ✓ ${r.id} (${r.genS} s)`);
					else console.log(`  ✗ ${r.id} : ${r.error}`);
				} catch { console.log(line); }
			}
		});
		child.on('error', rej);
		child.on('close', res);
		// Le worker attend son plan sur stdin et ne fait RIEN tant qu'il n'a pas
		// vu la fin du flux : sans ce end(), il reste bloqué indéfiniment.
		child.stdin.write(JSON.stringify(plan));
		child.stdin.end();
	});

	if (code !== 0) throw new Error(`le worker Python a rendu ${code}`);
	console.log(`\nEnsuite : node tools/music-gate.mjs`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	run().catch((e) => { console.error(`[add-music] ${e.message}`); process.exit(1); });
}
