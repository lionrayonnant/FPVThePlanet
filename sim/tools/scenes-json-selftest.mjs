// Vérifie que scenes.json ne liste que des scènes physiquement présentes.
// C'est le garde-fou côté CI : un clone fresh ne doit jamais présenter de
// fantômes au joueur.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
const ghosts = [];

for (const s of scenes) {
	const manifest = path.join(SCENES_DIR, s.slug, 'manifest.json');
	if (!fs.existsSync(manifest)) {
		ghosts.push(s.slug);
	}
}

if (ghosts.length) {
	console.error(`FAIL : ${ghosts.length} scène(s) fantôme(s) dans scenes.json : ${ghosts.join(', ')}`);
	console.error('       Lancez : node tools/sync-scenes.mjs');
	process.exit(1);
}

console.log(`PASS : ${scenes.length} scène(s), toutes présentes sur le disque.`);
