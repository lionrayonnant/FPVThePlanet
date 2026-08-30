// node tools/music-retire.mjs --before <seed-base> [--apply]
// node tools/music-retire.mjs --id <id> [--id <id>…] [--apply]
//
// Retire des morceaux de la bibliothèque : du manifeste ET du disque.
//
// La règle write-once du dépôt dit qu'un fichier commité n'est jamais réécrit ;
// elle ne dit pas qu'il est éternel. Un morceau qu'on ne veut plus sort des
// deux endroits — le laisser sur le disque hors manifeste ferait grossir le
// dépôt d'un poids que plus rien ne justifie, et le laisser au manifeste sans
// fichier rendrait le jeu silencieux sur ce tirage.
//
// À BLANC PAR DÉFAUT. Rien n'est touché sans --apply : supprimer de la musique
// validée à l'oreille est exactement le genre d'opération qu'on ne veut pas
// découvrir après coup.

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SIM } from './music-gen.mjs';
import { validateManifest } from './music-model.mjs';

const MANIFEST = join(SIM, 'public/music.json');

function parseArgs(argv) {
	const out = { before: null, ids: [], apply: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--before') out.before = argv[++i];
		else if (a === '--id') out.ids.push(argv[++i]);
		else if (a === '--apply') out.apply = true;
		else throw new Error(`argument inconnu : ${a}`);
	}
	return out;
}

/**
 * Sépare ce qui part de ce qui reste. Pur : c'est la décision, et elle doit
 * être lisible avant d'être exécutée.
 */
export function partition(tracks, { before = null, ids = [] } = {}) {
	const wanted = new Set(ids);
	const drop = tracks.filter((t) => wanted.has(t.id)
		|| (before && !String(t.seed ?? '').startsWith(before)));
	const keep = tracks.filter((t) => !drop.includes(t));
	return { drop, keep };
}

function run() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.before && !opts.ids.length) {
		throw new Error('donne --before <seed-base> ou --id <id>');
	}
	if (!existsSync(MANIFEST)) throw new Error('public/music.json absent');

	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const { drop, keep } = partition(manifest.tracks, opts);

	if (!drop.length) { console.log('rien à retirer'); return; }

	// Un pool qu'on viderait entièrement rendrait le jeu muet pour toute une
	// famille de drone. On refuse, même avec --apply : c'est une erreur de
	// manipulation bien plus probable qu'une intention.
	const restants = new Map();
	for (const t of keep) restants.set(t.pool, (restants.get(t.pool) ?? 0) + 1);
	const vides = [...new Set(drop.map((t) => t.pool))].filter((p) => !restants.get(p));
	if (vides.length) {
		throw new Error(`ces pools seraient vidés : ${vides.join(', ')}\n`
			+ 'Génère et valide leur remplacement avant de retirer les anciens.');
	}

	console.log(`${drop.length} à retirer, ${keep.length} conservés\n`);
	const parPool = {};
	for (const t of drop) (parPool[t.pool] ??= []).push(t.id);
	for (const [pool, ids] of Object.entries(parPool)) {
		console.log(`  ${pool.padEnd(12)} ${ids.length} retiré(s), ${restants.get(pool)} restant(s)`);
	}

	if (!opts.apply) {
		console.log('\nCoup à blanc. Relance avec --apply pour exécuter.');
		return;
	}

	const next = { ...manifest, tracks: keep };
	const problems = validateManifest(next);
	if (problems.length) throw new Error(`le manifeste résultant est invalide :\n  ${problems.join('\n  ')}`);

	// Le manifeste D'ABORD : si la suppression des fichiers échoue à
	// mi-parcours, le jeu ne pointe déjà plus vers eux et reste jouable.
	writeFileSync(MANIFEST, JSON.stringify(next, null, '\t') + '\n');

	let supprimes = 0;
	for (const t of drop) {
		const f = join(SIM, 'public', t.file);
		if (existsSync(f)) { unlinkSync(f); supprimes++; }
	}
	// Les dossiers de pool devenus vides ne servent plus à rien.
	const musicDir = join(SIM, 'public/music');
	for (const t of drop) {
		const d = dirname(join(SIM, 'public', t.file));
		if (d !== musicDir && existsSync(d) && !readdirSync(d).length) rmdirSync(d);
	}

	console.log(`\n${supprimes} fichier(s) supprimé(s) · manifeste à ${keep.length} morceaux`);
	console.log('Les blobs restent dans l\'historique git : le dépôt ne rétrécit pas.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try { run(); } catch (e) { console.error(`[music-retire] ${e.message}`); process.exit(1); }
}
