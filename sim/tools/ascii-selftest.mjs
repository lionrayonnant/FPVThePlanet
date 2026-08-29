// sim/tools/ascii-selftest.mjs
// Selftest du langage ASCII (PHASE 20, Bible §40). Aucune E/S, aucun DOM.
// Lancer : node tools/ascii-selftest.mjs
import assert from 'node:assert/strict';
import { ASCII_TAGS, asciiTag, asciiChain, bigText, BIG_FONT } from '../src/ascii.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('asciiTag : les trois usages information de la Bible §40', () => {
	assert.equal(asciiTag('ok', 'SIGNAL FOUND'), '[+] SIGNAL FOUND');
	assert.equal(asciiTag('alert', 'LINK LOST'), '[!] LINK LOST');
	assert.equal(asciiTag('status', 'TERRAIN READY'), '[*] TERRAIN READY');
});

t('asciiTag : kind inconnu → erreur (pas de tag silencieusement faux)', () => {
	assert.throws(() => asciiTag('info', 'X'));
});

t('asciiChain : exemple exact de la Bible §40', () => {
	assert.equal(asciiChain(['RX', 'FC', 'MOTOR']), 'RX ───┤ FC ├── MOTOR');
});

t('asciiChain : 2 nœuds et 4 nœuds restent lisibles', () => {
	assert.equal(asciiChain(['RX', 'FC']), 'RX ── FC');
	assert.equal(asciiChain(['RX', 'FC', 'ESC', 'MOTOR']), 'RX ───┤ FC ├───┤ ESC ├── MOTOR');
});

t('bigText : 5 lignes de même largeur, uniquement # et espace', () => {
	const rows = bigText('JACK IN');
	assert.equal(rows.length, 5);
	for (const r of rows) {
		assert.equal(r.length, rows[0].length);
		assert.match(r, /^[# ]*$/);
	}
});

t('BIG_FONT : chaque glyphe fait 5 lignes de 3 colonnes', () => {
	for (const [ch, glyph] of Object.entries(BIG_FONT)) {
		assert.equal(glyph.length, 5, `glyphe ${ch}`);
		for (const row of glyph) assert.equal(row.length, 3, `glyphe ${ch}`);
	}
});

t('BIG_FONT : couvre A-Z, espace, ! et -', () => {
	for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ !-') {
		assert.ok(BIG_FONT[ch], `manque ${JSON.stringify(ch)}`);
	}
});

console.log(`\n${n} tests ascii OK`);
