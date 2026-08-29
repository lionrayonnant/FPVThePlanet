// One-command pipeline for adding a new flyable map: downloads the Apple
// Flyover tile (Go exporter), converts it (prep.mjs), and registers it in
// public/scenes.json so it shows up in the in-app menu.
//
//   node tools/add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25]
//                           [--altitude 20] [--cell 256] [--quality 85]
//                           [--slug custom-slug] [--force]
//                           [--bbox <south>,<west>,<north>,<east>]
//
// radius (tryXY) and altitude (tryH) are the export-obj scan parameters — see
// ../flyover-reverse-engineering/README.md. Bigger radius = more area, at
// the cost of a longer download. 25 covers roughly the area used for the
// Tour Eiffel POC; widen it for elongated sites.
//
// --bbox extracts an explicit lat/lon rectangle instead of the radius square,
// which is what the GUI (npm run dev, /add-map.html) uses. lat/lon are still
// required — they select the Flyover region — so pass the box centre.
//
// All the work lives in lib/add-map-core.mjs; this file is only the CLI.

import { addMap, Cancelled, slugify } from './lib/add-map-core.mjs';

function parseArgs(argv) {
	const positional = [];
	const opts = { zoom: 20, radius: 25, altitude: 20, cell: 256, quality: 85, slug: null, force: false, bbox: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--zoom') opts.zoom = parseInt(argv[++i], 10);
		else if (a === '--radius') opts.radius = parseInt(argv[++i], 10);
		else if (a === '--altitude') opts.altitude = parseInt(argv[++i], 10);
		else if (a === '--cell') opts.cell = parseInt(argv[++i], 10);
		else if (a === '--quality') opts.quality = parseInt(argv[++i], 10);
		else if (a === '--slug') opts.slug = argv[++i];
		else if (a === '--force') opts.force = true;
		else if (a === '--bbox') opts.bbox = parseBox(argv[++i]);
		else positional.push(a);
	}
	if (positional.length !== 3) {
		console.error('usage: add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256] [--quality 85] [--slug id] [--force] [--bbox s,w,n,e]');
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

function parseBox(v) {
	const n = String(v ?? '').split(',').map(Number);
	if (n.length !== 4 || !n.every(Number.isFinite)) {
		console.error('--bbox expects <south>,<west>,<north>,<east> in degrees');
		process.exit(1);
	}
	return {
		south: Math.min(n[0], n[2]), west: Math.min(n[1], n[3]),
		north: Math.max(n[0], n[2]), east: Math.max(n[1], n[3]),
	};
}

const opts = parseArgs(process.argv.slice(2));

// The CLI keeps the old behaviour of showing everything the subprocesses print;
// the library streams the same lines to the GUI instead.
addMap(opts, {
	onLog: ({ stream, line }) => {
		if (stream === 'progress' || stream === 'phase' || stream === 'stat') return;
		if (stream === 'meta') console.log(line);
		else if (stream === 'stderr') console.error(line);
		else console.log(line);
	},
}).catch((err) => {
	console.error(err instanceof Cancelled ? '\nAnnulé.' : `\nÉchec : ${err.message}`);
	process.exit(1);
});
