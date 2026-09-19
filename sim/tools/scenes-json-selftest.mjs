// Checks that scenes.json lists only scenes that are physically there. This is
// the guard on the CI side: a fresh clone must never offer the player a ghost.
//
// Local by nature — it reads the scenes installed on THIS machine — so it is
// `npm run selftest:scenes` and not part of `selftest:ci`.

import fs from 'node:fs';
import path from 'node:path';
import { SCENES_DIR, SCENES_JSON } from './lib/paths.mjs';

// SCENES_DIR/SCENES_JSON rather than a second spelling of `public/scenes`:
// under FPVTP_DATA_DIR (what deploy/fpvtp.service sets) the scenes live
// somewhere else entirely, and a check that reads the repository's copy would
// pass while the served catalogue is full of ghosts.
const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
const ghosts = [];

for (const s of scenes) {
	const manifest = path.join(SCENES_DIR, s.slug, 'manifest.json');
	if (!fs.existsSync(manifest)) {
		ghosts.push(s.slug);
	}
}

if (ghosts.length) {
	console.error(`FAIL: ${ghosts.length} ghost scene(s) in scenes.json: ${ghosts.join(', ')}`);
	console.error('      Run: node tools/sync-scenes.mjs');
	process.exit(1);
}

console.log(`PASS  scenes-json-selftest (${scenes.length} scene(s), all present on disk)`);
