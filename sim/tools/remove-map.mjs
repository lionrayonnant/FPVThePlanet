// Undo of add-map.mjs: removes a map from public/scenes.json and deletes its
// prepped scene directory. The raw downloaded tile is left alone by default
// (it's the slow part to re-fetch) — pass --raw to delete it too.
//
//   node tools/remove-map.mjs <slug> [--raw]
//
// Le cache brut se résout chez LE FOURNISSEUR de l'entrée, via rawTileDirFor
// (issue #154). Ce fichier gardait sa propre constante Flyover et ne
// l'importait pas : supprimer une scène google-earth avec --raw laissait son
// cache sim/.cache/google-earth/ orphelin, et prétendait pourtant l'avoir
// cherché. La GUI (DELETE ?raw=1) passait déjà par cette voie ; le CLI la
// partage désormais au lieu d'en avoir une seconde.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { rawTileDirFor, providerOf } from './lib/add-map-core.mjs';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

function parseArgs(argv) {
	const positional = [];
	const opts = { raw: false };
	for (const a of argv) {
		if (a === '--raw') opts.raw = true;
		else positional.push(a);
	}
	if (positional.length !== 1) {
		console.error('usage: remove-map.mjs <slug> [--raw]');
		process.exit(1);
	}
	opts.slug = positional[0];
	return opts;
}

async function main() {
	const { slug, raw } = parseArgs(process.argv.slice(2));

	const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
	const i = scenes.findIndex((s) => s.slug === slug);
	if (i < 0) {
		console.error(`Aucune carte avec le slug "${slug}" dans scenes.json. Cartes disponibles : ${scenes.map((s) => s.slug).join(', ')}`);
		process.exit(1);
	}
	const [entry] = scenes.splice(i, 1);
	fs.writeFileSync(SCENES_JSON, JSON.stringify(scenes, null, '\t') + '\n');
	console.log(`Retiré du menu : "${entry.name}" (${slug})`);

	const outDir = path.join(SCENES_DIR, slug);
	if (fs.existsSync(outDir)) {
		fs.rmSync(outDir, { recursive: true, force: true });
		console.log(`Supprimé : ${outDir}`);
	}

	if (raw) {
		const providerId = entry.provider ?? 'flyover';
		let label = providerId;
		try { label = providerOf(providerId).label; }
		catch { /* fournisseur inconnu : on le nomme quand même dans le message */ }
		try {
			const dir = await rawTileDirFor(entry);
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true });
				console.log(`Supprimé (brut, ${label}) : ${dir}`);
			} else {
				console.log(`Aucune tuile brute ${label} à ${dir} (déjà absente).`);
			}
		} catch (e) {
			// Un fournisseur inconnu ne doit pas faire passer la suppression du
			// cache pour un succès : on le DIT, et on sort en échec.
			console.error(`Cache brut non résolu (${label}) : ${e.message}`);
			process.exitCode = 1;
		}
	}

	console.log(`\n✓ "${entry.name}" retiré.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
