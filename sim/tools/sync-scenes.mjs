// Remet scenes.json d'accord avec ce qu'il y a sur le disque.
//
//   node tools/sync-scenes.mjs            retire les entrées fantômes
//   node tools/sync-scenes.mjs --adopt    ... et réenregistre les scènes
//                                         présentes mais absentes du catalogue
//
// Le fichier scenes.json est commité dans git ; public/scenes/ est dans
// .gitignore.  Les deux dérivent donc dans les DEUX sens :
//
//   - un clone fresh ramène le catalogue sans les données — ce sont les
//     « fantômes », que ce script retire pour qu'ils ne polluent pas le menu ;
//   - une machine qui a préparé des cartes sans les enregistrer, ou dont le
//     catalogue a été taillé par un clone précédent, se retrouve avec des
//     scènes bien présentes sur le disque et INVISIBLES dans le menu. C'est
//     ce qu'`--adopt` répare : chaque `public/scenes/<slug>/manifest.json`
//     porte de quoi reconstruire son entrée.
//
// L'adoption est explicite parce que scenes.json est versionné : réenregistrer
// vingt-sept cartes locales n'est pas un geste qu'un script doit faire dans le
// dos de qui le lance.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './lib/paths.mjs';

const { SCENES_DIR, SCENES_JSON } = paths;

const adopt = process.argv.includes('--adopt');

const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
const before = scenes.length;

const alive = scenes.filter((s) => {
	const manifest = path.join(SCENES_DIR, s.slug, 'manifest.json');
	if (fs.existsSync(manifest)) return true;
	console.log(`  ✗ ${s.slug} — manifest.json absent, retiré`);
	return false;
});

// Un nom présentable depuis un slug : c'est tout ce dont le simulateur a besoin
// (il ne lit que slug/name), le reste du schéma est additif et sert à la GUI.
function nameOf(slug) {
	return slug.split('-').map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// L'emprise géographique depuis la bbox ENU du manifeste (mètres locaux, X est
// et Z sud, cf. prep.mjs) et son origine. Un degré de latitude vaut 111 320 m ;
// un degré de longitude, autant fois le cosinus de la latitude.
function bboxOf(manifest) {
	const { latitude, longitude } = manifest.origin ?? {};
	const b = manifest.bbox;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !b) return null;
	const perLat = 111320;
	const perLon = 111320 * Math.cos((latitude * Math.PI) / 180);
	if (!perLon) return null;
	// Z pointe au SUD : le min en Z est donc le bord NORD.
	return {
		south: latitude - b.max[2] / perLat,
		west: longitude + b.min[0] / perLon,
		north: latitude - b.min[2] / perLat,
		east: longitude + b.max[0] / perLon,
	};
}

function dirSize(dir) {
	let total = 0;
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		total += f.isDirectory() ? dirSize(p) : fs.statSync(p).size;
	}
	return total;
}

const adopted = [];
if (adopt && fs.existsSync(SCENES_DIR)) {
	const known = new Set(alive.map((s) => s.slug));
	for (const d of fs.readdirSync(SCENES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!d.isDirectory() || known.has(d.name)) continue;
		const file = path.join(SCENES_DIR, d.name, 'manifest.json');
		if (!fs.existsSync(file)) continue;
		let manifest;
		try {
			manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch (e) {
			console.log(`  ! ${d.name} — manifest.json illisible (${e.message}), ignoré`);
			continue;
		}
		const { latitude, longitude } = manifest.origin ?? {};
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
			console.log(`  ! ${d.name} — manifest.json sans origine, ignoré`);
			continue;
		}
		const bbox = bboxOf(manifest);
		const entry = {
			slug: d.name,
			name: nameOf(d.name),
			lat: latitude,
			lon: longitude,
			...(bbox ? { bbox } : {}),
			...(manifest.cellSize ? { cell: manifest.cellSize } : {}),
			bytes: dirSize(path.join(SCENES_DIR, d.name)),
			// La date du manifeste, pas celle d'aujourd'hui : cette carte a été
			// préparée à un moment, et ce moment-là est encore lisible.
			createdAt: fs.statSync(file).mtime.toISOString(),
		};
		alive.push(entry);
		adopted.push(d.name);
		console.log(`  + ${d.name} — présente sur le disque, réenregistrée`);
	}
}

const removed = before - (alive.length - adopted.length);
if (removed || adopted.length) {
	fs.writeFileSync(SCENES_JSON, JSON.stringify(alive, null, '\t') + '\n');
	console.log(`\n✓ ${removed} entrée(s) fantôme(s) supprimée(s), ${adopted.length} réenregistrée(s), ${alive.length} scène(s) au catalogue.`);
} else {
	console.log('\n✓ scenes.json est déjà synchronisé, aucune entrée fantôme.');
	if (!adopt) {
		const orphans = fs.existsSync(SCENES_DIR)
			? fs.readdirSync(SCENES_DIR, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !alive.some((s) => s.slug === d.name)
					&& fs.existsSync(path.join(SCENES_DIR, d.name, 'manifest.json')))
				.map((d) => d.name)
			: [];
		if (orphans.length) {
			console.log(`  ${orphans.length} scène(s) présente(s) sur le disque mais absente(s) du catalogue : ${orphans.join(', ')}`);
			console.log('  Pour les réenregistrer : node tools/sync-scenes.mjs --adopt');
		}
	}
}
