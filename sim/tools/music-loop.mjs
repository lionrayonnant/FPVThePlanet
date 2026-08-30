// node tools/music-loop.mjs [--crossfade 3]
//
// Transforme les survivants du gate en BOUCLES sans couture, normalisées, en
// Opus. Lit .music-staging/gate.json, écrit .music-staging/<id>.opus.
//
// Stable Audio ne produit pas de boucles : un morceau brut rejoué depuis le
// début fait entendre sa couture à chaque tour, et un vol dure plus longtemps
// qu'un morceau. D'où ce passage obligé.
//
// La recette, sur un fichier de durée D et un recouvrement X :
//
//   tête  = [0, X]          corps = [X, D-X]        queue = [D-X, D]
//   join  = crossfade(queue → tête)                 (dure X)
//   sortie = join ++ corps                          (dure D-X)
//
// Les deux jonctions sont alors continues : la fin du corps est l'échantillon
// D-X, qui est exactement là où `join` commence ; et la fin de `join` est
// l'échantillon X, où le corps commence. Le morceau peut tourner indéfiniment.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { STAGING } from './music-gen.mjs';

// 3 s : assez pour qu'un crossfade de musique électronique passe inaperçu,
// assez court pour ne pas manger une section entière.
export const CROSSFADE_S = 3;

// Toute la bibliothèque au même niveau. C'est la condition pour que la
// calibration du mix se fasse UNE fois et vaille pour tous les morceaux —
// sinon chaque piste redemanderait un réglage.
export const TARGET_LUFS = -14;

// Marge sous 0 dBFS après normalisation. Opus est un codec à transformée : il
// peut dépasser à la décompression, et le limiteur du jeu n'est pas là pour
// rattraper un fichier mal préparé.
export const TARGET_PEAK_DBFS = -1.0;

// Plage de dynamique visée. 11 LU est la valeur de référence d'EBU R128 ; la
// laisser large évite que loudnorm compresse un morceau déjà bien tenu.
export const TARGET_LRA = 11;

const OPUS_KBPS = 96;

function ffmpeg(args) {
	const r = spawnSync('ffmpeg', ['-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`ffmpeg a échoué :\n${(r.stderr ?? '').split('\n').slice(-6).join('\n')}`);
	return r.stderr ?? '';
}

/** Première passe de loudnorm : rend l'objet JSON de mesure. */
function measureLoudnorm(file) {
	const r = spawnSync('ffmpeg', ['-nostdin', '-nostats', '-i', file,
		'-af', loudnormMeasureFilter(), '-f', 'null', '-'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const out = r.stderr ?? '';
	// loudnorm imprime son JSON en dernier, sur stderr, après tout le reste.
	const start = out.lastIndexOf('{');
	const end = out.lastIndexOf('}');
	if (start < 0 || end < start) throw new Error('loudnorm n\'a pas rendu de mesure');
	return JSON.parse(out.slice(start, end + 1));
}

function measureLufsPeak(file) {
	const r = spawnSync('ffmpeg', ['-nostdin', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const out = r.stderr ?? '';
	const lufs = Number((out.match(/I:\s+(-?[\d.]+)\s+LUFS/g) ?? []).pop()?.match(/(-?[\d.]+)/)?.[1] ?? NaN);
	const peak = Number((out.match(/Peak:\s+(-?[\d.]+)\s+dBFS/g) ?? []).pop()?.match(/(-?[\d.]+)/)?.[1] ?? NaN);
	return { lufs, peak };
}

/**
 * Le filtre de bouclage. Pur : testable sans ffmpeg, et c'est la pièce où une
 * erreur d'une frame s'entend.
 */
export function loopFilter({ startS, endS, crossfadeS }) {
	const d = endS - startS;
	if (!(d > crossfadeS * 2.5)) throw new Error(`segment trop court (${d.toFixed(1)} s) pour un recouvrement de ${crossfadeS} s`);
	const headEnd = startS + crossfadeS;
	const tailStart = endS - crossfadeS;
	return [
		`[0:a]atrim=${startS}:${headEnd},asetpts=N/SR/TB[head]`,
		`[0:a]atrim=${tailStart}:${endS},asetpts=N/SR/TB[tail]`,
		`[0:a]atrim=${headEnd}:${tailStart},asetpts=N/SR/TB[body]`,
		`[tail][head]acrossfade=d=${crossfadeS}:c1=tri:c2=tri[joint]`,
		'[joint][body]concat=n=2:v=0:a=1[out]',
	].join(';');
}

// La normalisation se fait en DEUX passes, pas par un gain statique calculé à
// la main. Un simple `volume=XdB` ne peut pas satisfaire les deux contraintes
// à la fois : mesuré sur le lot de calibration, plafonner la crête à -1 dBFS
// laissait les masters denses jusqu'à 3 dB sous la cible, et une bibliothèque
// qui s'étale de -14 à -17 LUFS ruine précisément ce qu'on cherche — UN point
// de calibration valable pour tous les morceaux.
//
// `loudnorm` en deux passes fait ce travail correctement : la première mesure,
// la seconde applique. `linear=true` lui demande de rester sur un gain
// STATIQUE quand c'est possible (la dynamique du morceau est alors intacte) et
// ne l'autorise à limiter que si la cible est autrement inatteignable.

/** Filtre de la première passe : mesurer, sans rien écrire. */
export function loudnormMeasureFilter() {
	return `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_PEAK_DBFS}:LRA=${TARGET_LRA}:print_format=json`;
}

/**
 * Filtre de la seconde passe, construit à partir des valeurs mesurées. Pur :
 * c'est la pièce où une clé mal nommée passerait inaperçue en donnant
 * silencieusement une normalisation à une passe.
 */
export function loudnormApplyFilter(m) {
	const need = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
	for (const k of need) {
		if (!Number.isFinite(Number(m?.[k]))) throw new Error(`mesure loudnorm incomplète : ${k}`);
	}
	return [
		`loudnorm=I=${TARGET_LUFS}`,
		`TP=${TARGET_PEAK_DBFS}`,
		`LRA=${TARGET_LRA}`,
		`measured_I=${m.input_i}`,
		`measured_TP=${m.input_tp}`,
		`measured_LRA=${m.input_lra}`,
		`measured_thresh=${m.input_thresh}`,
		`offset=${m.target_offset}`,
		'linear=true',
		'print_format=summary',
	].join(':');
}

function run() {
	const argv = process.argv.slice(2);
	const xIdx = argv.indexOf('--crossfade');
	const crossfadeS = xIdx >= 0 ? Number(argv[xIdx + 1]) : CROSSFADE_S;

	const gatePath = join(STAGING, 'gate.json');
	if (!existsSync(gatePath)) { console.error('gate.json absent — lance d\'abord node tools/music-gate.mjs'); process.exit(1); }
	const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
	const kept = gate.results.filter((r) => r.pass);
	if (!kept.length) { console.error('aucun morceau retenu par le gate'); process.exit(1); }

	console.log(`${kept.length} morceau(x) à boucler · recouvrement ${crossfadeS} s · cible ${TARGET_LUFS} LUFS\n`);

	for (const r of kept) {
		const src = join(STAGING, `${r.id}.wav`);
		const dst = join(STAGING, `${r.id}.opus`);
		const tmp = join(STAGING, `${r.id}.loop.wav`);
		try {
			// On coupe les silences mesurés par le gate avant de boucler : les
			// crossfader ne ferait qu'étaler du vide.
			const startS = Number(r.headSilenceS ?? 0);
			const endS = r.durationS - Number(r.tailSilenceS ?? 0);

			ffmpeg(['-i', src, '-filter_complex', loopFilter({ startS, endS, crossfadeS }),
				'-map', '[out]', '-c:a', 'pcm_s16le', tmp]);

			// La normalisation se fait sur le fichier BOUCLÉ, pas sur la source :
			// le crossfade et la coupe des silences déplacent le loudness.
			const measured = measureLoudnorm(tmp);
			ffmpeg(['-i', tmp, '-af', loudnormApplyFilter(measured),
				'-ar', '48000',   // loudnorm resample de toute façon ; Opus est natif en 48k
				'-c:a', 'libopus', '-b:a', `${OPUS_KBPS}k`, '-vbr', 'on', '-application', 'audio', dst]);
			unlinkSync(tmp);

			const after = measureLufsPeak(dst);
			const sidecarPath = join(STAGING, `${r.id}.json`);
			const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};
			const loopDurS = Number((endS - startS - crossfadeS).toFixed(3));
			writeFileSync(sidecarPath, JSON.stringify({
				...sidecar, loopDurS, crossfadeS,
				lufs: after.lufs, peakDbfs: after.peak, opus: `${r.id}.opus`,
			}, null, '\t') + '\n');

			console.log(`  ✓ ${r.id.padEnd(20)} ${loopDurS.toFixed(1)} s  ${after.lufs} LUFS  crête ${after.peak}`);
		} catch (e) {
			if (existsSync(tmp)) unlinkSync(tmp);
			console.log(`  ✗ ${r.id} : ${e.message.split('\n')[0]}`);
		}
	}
	console.log('\nEnsuite : npm run music-review');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
