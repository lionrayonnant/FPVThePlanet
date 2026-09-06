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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

	// 8 pas — le défaut de la CLI amont, et il faut le laisser là.
	//
	// J'ai cru que 8 était un raccourci de VITESSE et je suis monté à 50 après
	// un A/B aveugle où un morceau de race5 à 50 pas avait été préféré. C'était
	// une généralisation depuis UN échantillon, et elle était fausse : à
	// l'écoute du pool `menu`, 50 pas rend hors-style et « comme un signal un
	// peu buggé ».
	//
	// Mesuré ensuite, mêmes prompts et mêmes graines : 50 pas sort 3,6 à 8,7 dB
	// SOUS 8 pas (-21,2/-23,8/-24,7 contre -17,6/-15,1/-18,0 LUFS). Une sortie
	// plus faible et moins affirmée est la signature d'un modèle poussé hors de
	// son régime — et tout Stable Audio 3 est construit autour de l'inférence
	// rapide (« minutes of audio in milliseconds », 5 s produites en 0,41 s).
	// 8 pas n'est pas un compromis, c'est le point de fonctionnement nominal.
	//
	// Ne pas remonter ce nombre sans réécouter PLUSIEURS pools : la fidélité
	// d'un morceau isolé ne dit rien de l'adhérence au style sur l'ensemble.
	steps: 8,

	cfgScale: 1.0,
};


function parseArgs(argv) {
	const out = { pool: null, count: 1, seedBase: 'v1', tag: '', ...DEFAULTS };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--pool') out.pool = next();
		else if (a === '--count') out.count = Number(next());
		else if (a === '--duration') out.duration = Number(next());
		else if (a === '--model') out.model = next();
		else if (a === '--steps') out.steps = Number(next());
		else if (a === '--cfg') out.cfgScale = Number(next());
		else if (a === '--tag') out.tag = next();
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
export function trackId(pool, seedBase, index, tag = '') {
	const rand = rngFrom(`${pool}::${seedBase}::${index}::id${tag ? `::${tag}` : ''}`);
	const hex = () => Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
	return `${pool}-${hex()}${hex()}`;
}

/** Construit le plan de génération. Pur : testable sans GPU. */
export function planFor({ pool, count, seedBase, duration, tag = '' }) {
	const jobs = [];
	for (let i = 0; i < count; i++) {
		const seed = `${seedBase}::${i}`;
		const id = trackId(pool, seedBase, i, tag);
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

/**
 * Propose une graine libre. Suit la série vN quand elle existe, pour que
 * l'ordre des vagues reste lisible dans le manifeste.
 */
export function suggestSeedBase(used) {
	let n = 1;
	for (const base of used) {
		const m = /^v(\d+)$/.exec(base);
		if (m) n = Math.max(n, Number(m[1]) + 1);
	}
	while (used.has(`v${n}`)) n++;
	return `v${n}`;
}

async function run() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.pool) throw new Error('--pool est requis : un pool, une liste séparée par des virgules, ou "all"');
	// Une liste séparée par des virgules, parce que le modèle met plus longtemps
	// à charger qu'à générer : refaire quatre pools en quatre commandes, c'est
	// payer quatre fois les 17 s de chargement pour rien.
	const pools = opts.pool === 'all' ? MUSIC_POOLS : opts.pool.split(',').map((p) => p.trim()).filter(Boolean);
	for (const p of pools) {
		if (!MUSIC_POOLS.includes(p)) throw new Error(`pool inconnu : ${p} (connus : ${MUSIC_POOLS.join(', ')})`);
	}
	// La graine de base détermine les prompts ET les identifiants. La réutiliser
	// ne produit donc pas « d'autres morceaux » mais EXACTEMENT les mêmes, que
	// le worker saute ensuite comme déjà générés — on croit avoir agrandi la
	// bibliothèque et il ne s'est rien passé. C'est le piège le plus facile de
	// tout le pipeline, et il est silencieux.
	const manifest = join(SIM, 'public/music.json');
	if (existsSync(manifest)) {
		const used = new Set();
		for (const t of JSON.parse(readFileSync(manifest, 'utf8')).tracks ?? []) {
			const base = String(t.seed ?? '').split('::')[0];
			if (base) used.add(base);
		}
		if (used.has(opts.seedBase)) {
			throw new Error(`la graine « ${opts.seedBase} » est déjà dans la bibliothèque : `
				+ 'elle rendrait les mêmes morceaux.\n'
				+ `Graines utilisées : ${[...used].sort().join(', ')}\n`
				+ 'Donne-en une neuve, par exemple --seed-base ' + suggestSeedBase(used));
		}
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
