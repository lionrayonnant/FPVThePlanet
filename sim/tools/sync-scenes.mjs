// Nettoie scenes.json des entrées fantômes (scènes listées mais dont le
// dossier public/scenes/<slug>/ n'existe pas sur le disque).
//
//   node tools/sync-scenes.mjs
//
// Le fichier scenes.json est commité dans git ; public/scenes/ est dans
// .gitignore.  Un clone fresh ramène donc le catalogue sans les données.
// Ce script retire du catalogue les scènes manquantes avant qu'elles ne
// polluent le menu ou ne causent des erreurs au boot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
const before = scenes.length;

const alive = scenes.filter((s) => {
	const manifest = path.join(SCENES_DIR, s.slug, 'manifest.json');
	if (fs.existsSync(manifest)) return true;
	console.log(`  ✗ ${s.slug} — manifest.json absent, retiré`);
	return false;
});

if (alive.length < before) {
	fs.writeFileSync(SCENES_JSON, JSON.stringify(alive, null, '\t') + '\n');
	console.log(`\n✓ ${before - alive.length} entrée(s) fantôme(s) supprimée(s), ${alive.length} scène(s) conservée(s).`);
} else {
	console.log('\n✓ scenes.json est déjà synchronisé, aucune entrée fantôme.');
}
