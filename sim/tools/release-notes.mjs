#!/usr/bin/env node
// Imprime les notes d'une version, telles qu'écrites dans CHANGELOG.md (#257).
//
//   node tools/release-notes.mjs 0.1.0   →  le corps de la section [0.1.0]
//   node tools/release-notes.mjs v0.1.0  →  idem, le préfixe de tag est toléré
//
// C'est ce que .github/workflows/release.yml pousse dans le corps de la
// GitHub Release : les notes sont écrites à la main, une seule fois, ici.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './release-model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = process.argv[2];

if (!arg) {
	console.error('usage : node tools/release-notes.mjs <version|tag>');
	process.exit(1);
}

try {
	const version = arg.replace(/^v/, '');
	console.log(releaseNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version));
} catch (err) {
	console.error(`release-notes: ${err.message}`);
	process.exit(1);
}
