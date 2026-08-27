// Undo of add-map.mjs: removes a map from public/scenes.json and deletes its
// prepped scene directory. The raw downloaded Flyover tile under
// flyover-reverse-engineering/downloaded_files/obj/ is left alone by default
// (it's the slow part to re-fetch) — pass --raw to delete it too.
//
//   node tools/remove-map.mjs <slug> [--raw]

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FLYOVER_ROOT = path.resolve(SIM_ROOT, '../flyover-reverse-engineering');
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

function main() {
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
		const objDir = path.join(FLYOVER_ROOT, 'downloaded_files/obj');
		let removed = false;
		if (fs.existsSync(objDir)) {
			for (const d of fs.readdirSync(objDir)) {
				if (d.startsWith(`${entry.lat.toFixed(6)}-${entry.lon.toFixed(6)}-`)) {
					fs.rmSync(path.join(objDir, d), { recursive: true, force: true });
					console.log(`Supprimé (brut) : ${path.join(objDir, d)}`);
					removed = true;
				}
			}
		}
		if (!removed) console.log('Aucune tuile brute correspondante trouvée (déjà absente ou coordonnées différentes).');
	}

	console.log(`\n✓ "${entry.name}" retiré.`);
}

main();
