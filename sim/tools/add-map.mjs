// One-command pipeline for adding a new flyable map: downloads the tile from
// the chosen provider (Google Earth by default — the only one registered
// since Apple Flyover was retired 2026-09-07), converts it (prep.mjs), and
// registers it in public/scenes.json so it shows up in the in-app menu.
//
//   node tools/add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25]
//                           [--altitude 20] [--cell 256] [--quality 85]
//                           [--slug custom-slug] [--force]
//                           [--provider google-earth]
//                           [--bbox <south>,<west>,<north>,<east>]
//                           [--poly "<lat>,<lon> <lat>,<lon> ..."]
//
// radius and altitude are the tile scan parameters: bigger radius = more
// area, at the cost of a longer download. 25 covers roughly the area used
// for the Tour Eiffel POC; widen it for elongated sites.
//
// --bbox extracts an explicit lat/lon rectangle instead of the radius square,
// which is what the GUI (npm run dev, /add-map.html) uses. lat/lon are still
// required — pass the box centre.
//
// --poly extracts a free polygon instead of a rectangle: only the tiles its
// outline touches are scanned. A tile is kept as soon as the outline touches
// it, so the extracted area is always a superset of the shape. lat/lon are
// still required; pass a point inside the shape.
//
// All the work lives in lib/add-map-core.mjs; this file is only the CLI.

import { addMap, Cancelled, slugify } from './lib/add-map-core.mjs';
import * as providers from './lib/providers/index.mjs';

function parseArgs(argv) {
	const positional = [];
	const opts = { zoom: 20, radius: 25, altitude: 20, cell: 256, quality: 85, slug: null, force: false, bbox: null, poly: null, provider: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--zoom') opts.zoom = parseInt(argv[++i], 10);
		else if (a === '--radius') opts.radius = parseInt(argv[++i], 10);
		else if (a === '--altitude') opts.altitude = parseInt(argv[++i], 10);
		else if (a === '--cell') opts.cell = parseInt(argv[++i], 10);
		else if (a === '--quality') opts.quality = parseInt(argv[++i], 10);
		else if (a === '--slug') opts.slug = argv[++i];
		else if (a === '--force') opts.force = true;
		else if (a === '--provider') opts.provider = argv[++i];
		else if (a === '--bbox') opts.bbox = parseBox(argv[++i]);
		else if (a === '--poly') opts.poly = parseRing(argv[++i]);
		else positional.push(a);
	}
	if (positional.length !== 3) {
		console.error('usage: add-map.mjs "<name>" <lat> <lon> [--zoom 20] [--radius 25] [--altitude 20] [--cell 256] [--quality 85] [--slug id] [--force] [--provider google-earth] [--bbox s,w,n,e] [--poly "lat,lon lat,lon ..."]');
		process.exit(1);
	}
	if (opts.provider) {
		try { providers.get(opts.provider); }
		catch (e) { console.error(e.message); process.exit(1); }
	}
	const [name, latStr, lonStr] = positional;
	const lat = Number(latStr), lon = Number(lonStr);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error('lat/lon must be numbers');
		process.exit(1);
	}
	if (opts.bbox && opts.poly) {
		console.error('--bbox and --poly are mutually exclusive');
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

// Accepte "lat,lon lat,lon" comme "lat,lon,lat,lon" : à taper à la main les
// paires espacées se relisent, et la forme plate est celle que le Go reçoit.
function parseRing(v) {
	const n = String(v ?? '').trim().split(/[\s,]+/).map(Number);
	if (n.length < 6 || n.length % 2 !== 0 || !n.every(Number.isFinite)) {
		console.error('--poly expects at least 3 "<lat>,<lon>" pairs in degrees');
		process.exit(1);
	}
	return n;
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
