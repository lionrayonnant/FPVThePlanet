// Balaie public/scenes.json et applique fenceNote() (tools/lib/add-map-core.mjs)
// à chaque scène pour lister celles où la garantie d'arrêt de la clôture de
// zone (#139) ne tient pas — issue #146.
//
// add-map-core.mjs n'avertit qu'au moment où une carte est AJOUTÉE. Deux cas
// passaient au travers : une carte installée avant ce garde-fou, ou préparée
// en appelant tools/prep.mjs à la main sans repasser par add-map(). Ce script
// couvre les deux en relisant le manifeste déjà sur disque, sans rien
// retélécharger ni reconstruire.
//
//   node tools/geofence-check-scenes.mjs
//
// Ne lit que public/scenes.json (le seul inventaire que git suive — voir
// l'en-tête de src/geofence.js) et, pour chaque entrée, le manifest.json que
// npm run add-map a écrit dans public/scenes/<slug>/ — gitignoré, donc
// forcément absent sur une machine qui n'a pas cette carte en local. Une
// entrée sans manifeste local est signalée, pas silencieusement ignorée :
// c'est ce qui a laissé le commentaire figé de geofence.js citer une liste de
// six alors qu'il y en avait sept.
import fs from 'node:fs';
import path from 'node:path';
import { fenceNote } from './lib/add-map-core.mjs';

const scenesPath = path.resolve('public/scenes.json');
const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));

let flagged = 0, checked = 0, missing = 0;
for (const scene of scenes) {
	const manifestPath = path.resolve('public/scenes', scene.slug, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		missing++;
		console.log(`  ${scene.slug.padEnd(28)} pas de manifeste local — non téléchargée ici, ignorée`);
		continue;
	}
	const { bbox } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const note = fenceNote(bbox);
	checked++;
	if (!note) {
		console.log(`  ${scene.slug.padEnd(28)} ok — couloir mesuré tel quel (carte assez grande)`);
		continue;
	}
	flagged++;
	console.log(`  ${scene.slug.padEnd(28)} ${note.replace(/\n/g, '\n' + ' '.repeat(31))}`);
}

console.log(`\n${checked} scène(s) vérifiée(s) sur ${scenes.length} listées dans scenes.json`
	+ (missing > 0 ? `, ${missing} sans manifeste local` : '')
	+ `, ${flagged} sous la garantie d'arrêt.`);
if (missing > 0) {
	console.log(`Relancer sur une machine qui a téléchargé les ${missing} carte(s) manquante(s) pour les couvrir aussi.`);
}
