// Selftest of the pure version-line formatting in src/version.js (#9): the
// on-screen string must carry the real package version, not a lore literal.
// Run: node tools/version-selftest.mjs
import assert from 'node:assert/strict';
import { versionLineFor } from '../src/version.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('versionLineFor : version numérique -> préfixée de v', () => {
	assert.equal(versionLineFor('0.0.0'), 'FPVTP! // v0.0.0');
});

t('versionLineFor : dev -> pas de v', () => {
	assert.equal(versionLineFor('dev'), 'FPVTP! // dev');
});

console.log(`PASS  version-selftest (${n} tests)`);
