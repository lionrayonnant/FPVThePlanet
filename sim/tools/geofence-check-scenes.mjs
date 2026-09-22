// Sweeps scenes.json and applies fenceNote() (tools/lib/add-map-core.mjs) to
// every scene, to list the ones where the zone fence's stopping guarantee
// (#139) does not hold — issue #146.
//
// add-map-core.mjs only warns at the moment a map is ADDED. Two cases slipped
// through: a map installed before that guard existed, and one prepared by
// calling tools/prep.mjs by hand without going back through add-map(). This
// script covers both by re-reading the manifest already on disk, downloading
// and rebuilding nothing.
//
//   node tools/geofence-check-scenes.mjs
//
// It reads scenes.json (the only inventory git tracks — see the header of
// src/geofence.js) and, for each entry, the manifest.json that npm run add-map
// wrote next to it — gitignored, hence necessarily absent on a machine that
// does not have that map locally. An entry with no local manifest is reported,
// not silently skipped: that is what left geofence.js's frozen comment quoting
// a list of six when there were seven.
import fs from 'node:fs';
import path from 'node:path';
import { fenceNote } from './lib/add-map-core.mjs';
import { SCENES_DIR, SCENES_JSON } from './lib/paths.mjs';

// From tools/lib/paths.mjs, so this runs the same from sim/ or from the
// repository root, and follows FPVTP_DATA_DIR on a server where the scenes are
// not under public/ at all. `path.resolve('public/scenes.json')` did neither.
const scenes = JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8'));

let flagged = 0, checked = 0, missing = 0;
for (const scene of scenes) {
	const manifestPath = path.join(SCENES_DIR, scene.slug, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		missing++;
		console.log(`  ${scene.slug.padEnd(28)} no local manifest — not downloaded here, skipped`);
		continue;
	}
	const { bbox } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const note = fenceNote(bbox);
	checked++;
	if (!note) {
		console.log(`  ${scene.slug.padEnd(28)} ok — corridor measured as is (map large enough)`);
		continue;
	}
	flagged++;
	console.log(`  ${scene.slug.padEnd(28)} ${note.replace(/\n/g, '\n' + ' '.repeat(31))}`);
}

console.log(`\n${checked} scene(s) checked out of ${scenes.length} listed in scenes.json`
	+ (missing > 0 ? `, ${missing} with no local manifest` : '')
	+ `, ${flagged} under the stopping guarantee.`);
if (missing > 0) {
	console.log(`Re-run on a machine that has downloaded the ${missing} missing map(s) to cover those too.`);
}
