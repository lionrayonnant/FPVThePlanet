// One-command pipeline for adding a new flyable map: downloads the Apple
// Flyover tile (Go exporter), converts it (prep.mjs), and registers it in
// public/scenes.json so it shows up in the in-app menu.
//
//   node tools/add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25]
//                           [--altitude 20] [--cell 256] [--quality 85]
//                           [--slug custom-slug] [--force]
//
// radius (tryXY) and altitude (tryH) are the export-obj scan parameters — see
// ../flyover-reverse-engineering/README.md. Bigger radius = more area, at
// the cost of a longer download. 25 covers roughly the area used for the
// Tour Eiffel POC; widen it for elongated sites.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SIM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FLYOVER_ROOT = path.resolve(SIM_ROOT, '../flyover-reverse-engineering');
const SCENES_DIR = path.join(SIM_ROOT, 'public/scenes');
const SCENES_JSON = path.join(SIM_ROOT, 'public/scenes.json');

function parseArgs(argv) {
	const positional = [];
	const opts = { zoom: 20, radius: 25, altitude: 20, cell: 256, quality: 85, slug: null, force: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--zoom') opts.zoom = parseInt(argv[++i], 10);
		else if (a === '--radius') opts.radius = parseInt(argv[++i], 10);
		else if (a === '--altitude') opts.altitude = parseInt(argv[++i], 10);
		else if (a === '--cell') opts.cell = parseInt(argv[++i], 10);
		else if (a === '--quality') opts.quality = parseInt(argv[++i], 10);
		else if (a === '--slug') opts.slug = argv[++i];
		else if (a === '--force') opts.force = true;
		else positional.push(a);
	}
	if (positional.length !== 3) {
		console.error('usage: add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256] [--quality 85] [--slug id] [--force]');
		process.exit(1);
	}
	const [name, latStr, lonStr] = positional;
	const lat = Number(latStr), lon = Number(lonStr);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error('lat/lon must be numbers');
		process.exit(1);
	}
	opts.name = name;
	opts.lat = lat;
	opts.lon = lon;
	opts.slug = opts.slug ?? slugify(name);
	return opts;
}

function slugify(name) {
	return name
		.normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function run(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		console.log(`\n$ ${cmd} ${args.join(' ')}\n  (cwd: ${cwd})\n`);
		const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with code ${code}`));
		});
	});
}

function dirHasFiles(dir) {
	try { return fs.readdirSync(dir).length > 0; } catch { return false; }
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const { name, lat, lon, zoom, radius, altitude, cell, quality, slug, force } = opts;

	// Must match the Go exporter's fmt.Sprintf("%f-%f-%d-%d-%d", ...): %f is 6 decimals.
	const tileDirName = `${lat.toFixed(6)}-${lon.toFixed(6)}-${zoom}-${radius}-${altitude}`;
	const tileDir = path.join(FLYOVER_ROOT, 'downloaded_files/obj', tileDirName);
	const outDir = path.join(SCENES_DIR, slug);

	console.log(`Carte : ${name}  (slug: ${slug})`);
	console.log(`Centre : ${lat}, ${lon}  zoom ${zoom}  rayon ${radius}  altitudes ${altitude}`);

	if (!force && dirHasFiles(tileDir)) {
		console.log(`\nTuile déjà téléchargée (${tileDir}), téléchargement sauté (--force pour refaire).`);
	} else {
		await run('go', [
			'run', 'cmd/export-obj/main.go',
			String(lat), String(lon), String(zoom), String(radius), String(altitude),
			'--parallel',
		], FLYOVER_ROOT);
	}

	if (!dirHasFiles(tileDir)) {
		throw new Error(`aucune tuile trouvée à cet endroit (${tileDir} est vide) — vérifie les coordonnées`);
	}

	await run('node', [
		'tools/prep.mjs', tileDir,
		'--out', outDir,
		'--cell', String(cell),
		'--quality', String(quality),
	], SIM_ROOT);

	const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
	const entry = { slug, name, lat, lon };
	const i = scenes.findIndex((s) => s.slug === slug);
	if (i >= 0) scenes[i] = entry; else scenes.push(entry);
	fs.writeFileSync(SCENES_JSON, JSON.stringify(scenes, null, '\t') + '\n');

	console.log(`\n✓ "${name}" prêt — disponible dans le menu au prochain "npm run dev".`);
}

main().catch((err) => {
	console.error('\nÉchec :', err.message);
	process.exit(1);
});
