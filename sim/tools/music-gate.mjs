// node tools/music-gate.mjs [--staging <dir>] [--json]
//
// Rejet automatique MESURÉ des candidats de .music-staging/. Personne
// n'écoutera des centaines de morceaux ; le gate est ce qui rend la revue à
// l'oreille tenable, en n'y envoyant que des morceaux plausibles.
//
// Chaque critère correspond à un défaut observable de Stable Audio, pas à une
// idée de ce qu'est une bonne musique — le goût est le travail de l'oreille,
// pas celui d'ffmpeg. Voir BOUNDS pour le pourquoi de chacun.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { STAGING } from './music-gen.mjs';

// CALIBRÉ sur un lot de 21 morceaux de 90 s (3 par pool, seed-base « cal1 »,
// stable-audio-3-medium, 8 pas). Distribution mesurée :
//
//   LUFS         -18.9 … -10.4   (médiane -13.0)
//   crête          -3.2 … +2.9   (19/21 au-dessus de 0 dBFS)
//   silence tête    0.0 … 0.0
//   silence queue   0.0 …  4.4   (médiane 1.1)
//   écart RMS       1.3 … 16.7   (médiane 5.3)
//   côté          -24.0 …  -6.4
//
// Deux bornes de la première version ont été retirées ou desserrées parce que
// la mesure a montré qu'elles jugeaient autre chose que ce qu'on croyait — le
// détail est écrit sur chacune.
export const BOUNDS = {
	// Un morceau qui ne fait pas la durée demandée est un morceau que le modèle
	// a abandonné. Jamais déclenché sur le lot : les 21 font exactement 90,0 s.
	durationTolerance: 0.03,
	// Départ mou : 1,5 s de silence en tête, c'est une intro qui n'arrive pas.
	// Jamais déclenché non plus, gardé comme garde-fou : il ne coûte rien et
	// attraperait un vrai raté.
	headSilenceS: 1.5,
	// Fin coupée. Desserré de 3 s à 12 s après mesure : un fondu de queue de 1
	// à 4 s est le comportement NORMAL du modèle, et music-loop.mjs recoupe la
	// queue de toute façon. Seule une queue morte couvrant plus de ~13 % du
	// morceau signale un modèle qui a lâché.
	tailSilenceS: 12.0,
	// Hors de cette plage, la normalisation à -14 LUFS ferait plus de mal que
	// de bien : trop bas on remonte le bruit de fond, trop haut il ne reste
	// plus de dynamique à récupérer. Le lot tient entièrement dedans.
	lufs: [-24, -6],
	// La crête d'un candidat BRUT ne veut rien dire : 19 des 21 morceaux
	// dépassent 0 dBFS en inter-échantillon, ce qui est le comportement normal
	// d'un master fort, et music-loop.mjs applique ensuite un gain statique qui
	// GARANTIT une sortie sous TARGET_PEAK_DBFS. La borne ci-dessous ne sert
	// donc plus qu'à repérer un rendu franchement cassé.
	maxTruePeakDbfs: 6,
	// Un morceau dont le niveau ne bouge jamais n'a rien sur quoi l'arc
	// d'intensité puisse mordre. Abaissé de 2 dB à 0,8 dB après mesure : à
	// 2 dB, le gate rejetait le dub techno et l'ambiance de menu, c'est-à-dire
	// exactement les pools dont l'identité EST d'être égale et hypnotique.
	// Décider qu'un morceau est « trop statique » est un jugement de goût :
	// c'est le travail de l'oreille (music-review), pas d'ffmpeg. Ce plancher
	// n'attrape plus que le silence déguisé.
	minRmsSpreadDb: 0.8,
	// Stable Audio rend parfois du quasi-mono. Le jeu a un champ stéréo (les
	// moteurs sont pannés) : une musique mono s'y écrase. Mesuré en écart entre
	// l'énergie du côté (L-R) et celle du milieu (L+R) ; le lot va de -24 à
	// -6 dB, donc -40 laisse passer tout vrai stéréo et n'attrape qu'un vrai
	// effondrement.
	minSideDb: -40,
};

// ffmpeg écrit TOUTES ses mesures sur stderr. execFileSync ne rend que stdout,
// d'où spawnSync : c'est le seul moyen d'attraper ce qui nous intéresse, que la
// commande sorte zéro ou non.
function stderrOf(args) {
	const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return r.stderr ?? '';
}

// 5 s à 44,1 kHz. Assez long pour moyenner une mesure, assez court pour voir
// une structure de morceau apparaître.
const WINDOW_SAMPLES = 220500;

function rmsValues(out) {
	return [...out.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/g)]
		.map((m) => Number(m[1])).filter(Number.isFinite);
}

/**
 * RMS mono par fenêtre de 5 s, en dB.
 *
 * `astats=reset=1` ne PUBLIE pas ses valeurs par fenêtre sur stderr — il ne
 * rend là que le résumé global. Les valeurs par fenêtre vivent dans les
 * métadonnées de frame, d'où ametadata=print, qui écrit sur stdout.
 */
function windowRmsDb(file) {
	const r = spawnSync('ffmpeg', ['-nostats', '-v', 'error', '-i', file, '-af',
		`pan=mono|c0=0.5*c0+0.5*c1,asetnsamples=n=${WINDOW_SAMPLES},`
		+ 'astats=metadata=1:reset=1,'
		+ 'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
		'-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return [...(r.stdout ?? '').matchAll(/RMS_level=(-?[\d.]+)/g)]
		.map((m) => Number(m[1])).filter(Number.isFinite);
}

/** Percentile linéaire sur une liste non triée. */
function percentile(values, q) {
	const v = values.slice().sort((a, b) => a - b);
	if (!v.length) return NaN;
	const i = (v.length - 1) * q;
	const lo = Math.floor(i);
	const hi = Math.ceil(i);
	return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/** RMS global d'un downmix décrit par une expression `pan`, en dB. */
function monoRmsDb(file, expr) {
	const v = rmsValues(stderrOf(['-nostats', '-i', file, '-af',
		`pan=mono|c0=${expr},astats`, '-f', 'null', '-']));
	return v.length ? v[v.length - 1] : NaN;
}

/** Mesures brutes d'un fichier. Aucun jugement ici. */
export function measure(file) {
	const dur = Number(execFileSync('ffprobe', [
		'-v', 'error', '-show_entries', 'format=duration',
		'-of', 'default=nw=1:nk=1', file,
	], { encoding: 'utf8' }).trim());

	// ebur128 : loudness intégré et true peak, en une passe.
	const eb = stderrOf(['-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
	const lufs = Number((eb.match(/I:\s+(-?[\d.]+)\s+LUFS/g) ?? []).pop()?.match(/(-?[\d.]+)/)?.[1] ?? NaN);
	const truePeak = Number((eb.match(/Peak:\s+(-?[\d.]+)\s+dBFS/g) ?? []).pop()?.match(/(-?[\d.]+)/)?.[1] ?? NaN);

	// silencedetect aux deux bouts, sur un seuil bas : on cherche le vide, pas
	// le calme.
	const sd = stderrOf(['-nostats', '-i', file, '-af', 'silencedetect=noise=-50dB:d=0.3', '-f', 'null', '-']);
	const starts = [...sd.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
	const ends = [...sd.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
	// Silence de tête = un segment qui commence à ~0.
	const headSilenceS = (starts.length && starts[0] <= 0.05) ? (ends[0] ?? dur) : 0;
	// Silence de queue = un segment ouvert à la fin.
	const tailSilenceS = (starts.length > ends.length) ? dur - starts[starts.length - 1]
		: (ends.length && Math.abs(ends[ends.length - 1] - dur) < 0.05 ? ends[ends.length - 1] - starts[starts.length - 1] : 0);

	// Dispersion du niveau dans le temps : RMS par tranches de 5 s. On downmixe
	// AVANT de fenêtrer, sinon astats rend trois valeurs par fenêtre (G, D,
	// Overall) et l'écart mesuré mélangerait le temps et les canaux.
	// Écart ROBUSTE (p90 − p10), pas max − min : Stable Audio termine presque
	// toujours par un fondu, et une seule fenêtre à -35 dB ferait passer pour
	// « structuré » un morceau parfaitement plat. Les percentiles ignorent le
	// fondu et mesurent ce qui se passe pendant le morceau.
	const rms = windowRmsDb(file);
	const rmsSpreadDb = rms.length > 3 ? percentile(rms, 0.9) - percentile(rms, 0.1) : 0;

	// Détection du quasi-mono : on compare l'énergie du côté (L-R) à celle du
	// milieu (L+R). Un vrai stéréo tient dans -25..-6 dB ; un mono déguisé
	// s'effondre vers -60 dB et plus bas. `astats` de ce build ne rend pas de
	// phase, et c'est de toute façon la mesure la plus lisible des deux.
	const mid = monoRmsDb(file, '0.5*c0+0.5*c1');
	const side = monoRmsDb(file, '0.5*c0-0.5*c1');
	const sideDb = (Number.isFinite(mid) && Number.isFinite(side)) ? side - mid : NaN;

	return { file, durationS: dur, lufs, truePeak, headSilenceS, tailSilenceS, rmsSpreadDb, sideDb };
}

/** Mesures → verdict. Pur : testable sans ffmpeg. */
export function judge(m, targetDurationS) {
	const bad = [];
	const tol = targetDurationS * BOUNDS.durationTolerance;
	if (!(Math.abs(m.durationS - targetDurationS) <= tol)) {
		bad.push(`durée ${m.durationS?.toFixed(1)} s ≠ ${targetDurationS} s ±${tol.toFixed(1)}`);
	}
	if (m.headSilenceS > BOUNDS.headSilenceS) bad.push(`silence de tête ${m.headSilenceS.toFixed(2)} s`);
	if (m.tailSilenceS > BOUNDS.tailSilenceS) bad.push(`silence de queue ${m.tailSilenceS.toFixed(2)} s`);
	if (!Number.isFinite(m.lufs)) bad.push('LUFS non mesuré');
	else if (m.lufs < BOUNDS.lufs[0] || m.lufs > BOUNDS.lufs[1]) bad.push(`${m.lufs} LUFS hors [${BOUNDS.lufs}]`);
	if (Number.isFinite(m.truePeak) && m.truePeak > BOUNDS.maxTruePeakDbfs) bad.push(`crête ${m.truePeak} dBFS — rendu cassé`);
	if (m.rmsSpreadDb < BOUNDS.minRmsSpreadDb) bad.push(`niveau plat (${m.rmsSpreadDb.toFixed(1)} dB d'écart) — nappe, pas morceau`);
	if (Number.isFinite(m.sideDb) && m.sideDb < BOUNDS.minSideDb) bad.push(`quasi-mono (côté à ${m.sideDb.toFixed(1)} dB du milieu)`);
	return { pass: bad.length === 0, reasons: bad };
}

function run() {
	const asJson = process.argv.includes('--json');
	if (!existsSync(STAGING)) { console.error(`rien à mesurer : ${STAGING} n'existe pas`); process.exit(1); }

	const wavs = readdirSync(STAGING).filter((f) => f.endsWith('.wav')).sort();
	if (!wavs.length) { console.error('aucun .wav dans le staging'); process.exit(1); }

	const results = [];
	for (const w of wavs) {
		const id = basename(w, '.wav');
		const sidecar = join(STAGING, `${id}.json`);
		const meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : {};
		const m = measure(join(STAGING, w));
		const v = judge(m, meta.durationS ?? m.durationS);
		results.push({ id, pool: meta.pool, ...m, ...v });
		if (!asJson) {
			const mark = v.pass ? '✓' : '✗';
			console.log(`${mark} ${id.padEnd(20)} ${String(meta.pool ?? '').padEnd(11)} ${m.lufs} LUFS  crête ${m.truePeak}  écart ${m.rmsSpreadDb.toFixed(1)} dB`);
			for (const r of v.reasons) console.log(`    ${r}`);
		}
	}

	writeFileSync(join(STAGING, 'gate.json'), JSON.stringify({ bounds: BOUNDS, results }, null, '\t') + '\n');
	const kept = results.filter((r) => r.pass).length;
	if (asJson) console.log(JSON.stringify(results, null, '\t'));
	else console.log(`\n${kept}/${results.length} retenus → gate.json\nEnsuite : node tools/music-loop.mjs`);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
