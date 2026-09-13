// Exports the three tip marks of the terminal footer as standalone SVG files
// for the README, which cannot run the game to draw them.
//
// The geometry is NOT repeated here: it comes from src/pixel-icons.js, the same
// 12x12 grids the footer buttons draw. Only the colour is added — a README image
// has no `currentColor` to inherit, and it has to stay readable on GitHub's
// light theme as well as its dark one.
//
//   node tools/export-support-marks.mjs           write the files
//   node tools/export-support-marks.mjs --check   fail if they have drifted
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iconSVG } from '../src/pixel-icons.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'brand');

// Bitcoin and Monero carry their own colour; the cake is not Cake Wallet's mark
// and borrows nothing from it, so it takes the app's own violet.
export const MARKS = [
	{ icon: 'cake', file: 'mark-cake.svg', color: '#7a6cf0' },
	{ icon: 'monero', file: 'mark-monero.svg', color: '#ff6600' },
	{ icon: 'bitcoin', file: 'mark-bitcoin.svg', color: '#f7931a' },
];

const check = process.argv.includes('--check');
let bad = 0;
for (const { icon, file, color } of MARKS) {
	const svg = `${iconSVG(icon, { color, size: 24 })}\n`;
	const path = join(OUT, file);
	if (!check) { writeFileSync(path, svg); console.log(`  wrote  docs/brand/${file}`); continue; }
	const have = readFileSync(path, 'utf8');
	if (have === svg) console.log(`  ok  docs/brand/${file}`);
	else { console.error(`  DRIFT  docs/brand/${file} — re-run without --check`); bad++; }
}
process.exit(bad ? 1 : 0);
