// Selftest du modèle pur du jukebox (issue #120).
// Lancer : node tools/jukebox-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MUSIC_POOLS } from './music-model.mjs';
import {
	buildLibrary, libraryFilters, filterLibrary, formatDuration, shortId,
	jukeboxRow, nowPlayingLine, librarySummary, stepIndex,
	PLAYING_MARK, IDLE_MARK, STOPPED_LINE,
} from './jukebox-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const track = (pool, id, durS = 84, bpm = 120) => ({ id: `${pool}-${id}`, pool, file: `music/${pool}/${pool}-${id}.opus`, durS, bpm });

// Délibérément dans le désordre, et avec un pool qui vient APRÈS l'autre dans
// MUSIC_POOLS pour que le tri ait quelque chose à faire.
const fake = {
	schemaVersion: 1,
	tracks: [
		track('race5', 'ffff'), track('menu', 'bbbb'),
		track('race5', 'aaaa'), track('menu', 'aaaa'),
	],
};

t('buildLibrary : groupé par pool dans l\'ordre de MUSIC_POOLS, puis par id', () => {
	const lib = buildLibrary(fake);
	assert.deepEqual(lib.map((x) => x.id), ['menu-aaaa', 'menu-bbbb', 'race5-aaaa', 'race5-ffff']);
	// menu précède race5 parce que MUSIC_POOLS le dit, pas par hasard.
	assert.ok(MUSIC_POOLS.indexOf('menu') < MUSIC_POOLS.indexOf('race5'));
});

t('buildLibrary : stable, et ne modifie pas le manifeste', () => {
	const before = fake.tracks.map((x) => x.id);
	const a = buildLibrary(fake).map((x) => x.id);
	const b = buildLibrary(fake).map((x) => x.id);
	assert.deepEqual(a, b);
	assert.deepEqual(fake.tracks.map((x) => x.id), before);
});

t('buildLibrary : un manifeste absent ou vide rend une liste vide', () => {
	for (const bad of [null, undefined, {}, { tracks: null }, { tracks: 'nope' }]) {
		assert.deepEqual(buildLibrary(bad), []);
	}
});

t('libraryFilters : ALL puis les pools PRÉSENTS seulement', () => {
	assert.deepEqual(libraryFilters(fake), ['ALL', 'menu', 'race5']);
	// swarmNode est déclaré dans MUSIC_POOLS mais absent du manifeste : il ne
	// doit pas offrir un filtre toujours vide.
	assert.ok(MUSIC_POOLS.includes('swarmNode'));
	assert.ok(!libraryFilters(fake).includes('swarmNode'));
});

t('filterLibrary : ALL ne filtre rien, un pool ne rend que lui', () => {
	const lib = buildLibrary(fake);
	assert.equal(filterLibrary(lib, 'ALL').length, 4);
	assert.equal(filterLibrary(lib, null).length, 4);
	assert.deepEqual(filterLibrary(lib, 'race5').map((x) => x.id), ['race5-aaaa', 'race5-ffff']);
	assert.deepEqual(filterLibrary(lib, 'heavy5'), []);
});

t('formatDuration', () => {
	assert.equal(formatDuration(84.144), '1:24');
	assert.equal(formatDuration(84.9), '1:25');
	assert.equal(formatDuration(5), '0:05');
	assert.equal(formatDuration(60), '1:00');
	assert.equal(formatDuration(725), '12:05');
	// Jamais de NaN ni de négatif dans une table.
	assert.equal(formatDuration(undefined), '0:00');
	assert.equal(formatDuration(-3), '0:00');
});

t('shortId : ce qui suit le premier tiret, l\'id entier sinon', () => {
	assert.equal(shortId('menu-1aec9db0'), '1aec9db0');
	assert.equal(shortId('swarmNode-4e3c1361'), '4e3c1361');
	assert.equal(shortId('nodash'), 'nodash');
	assert.equal(shortId(undefined), '');
});

t('jukeboxRow : les colonnes annoncées', () => {
	assert.equal(jukeboxRow(track('menu', '1aec9db0', 84.1, 86)), '  MENU       · 1aec9db0 ·  1:24 ·  86 BPM');
	assert.equal(
		jukeboxRow(track('freestyle5', '7f99af7b', 85.4, 168), { playing: true }),
		'▶ FREESTYLE5 · 7f99af7b ·  1:25 · 168 BPM',
	);
});

t('jukeboxRow : le marqueur fait 2 caractères DANS LES DEUX ÉTATS', () => {
	// Sinon toute la table se décale d'un cran quand la lecture change de ligne.
	assert.equal(PLAYING_MARK.length, 2);
	assert.equal(IDLE_MARK.length, 2);
	const one = track('menu', 'aaaaaaaa');
	assert.equal(jukeboxRow(one, { playing: true }).length, jukeboxRow(one, { playing: false }).length);
});

t('nowPlayingLine : le morceau, ou l\'état muet', () => {
	assert.equal(nowPlayingLine(track('race5', 'd8031836', 83.6, 148)), 'ON AIR   RACE5      · d8031836 ·  1:24 · 148 BPM');
	assert.equal(nowPlayingLine(null), STOPPED_LINE);
});

t('librarySummary : compté, jamais figé', () => {
	assert.equal(librarySummary(buildLibrary(fake)), '4 TRACKS · 2 POOLS');
	assert.equal(librarySummary([]), '0 TRACKS · 0 POOLS');
});

t('stepIndex : circulaire dans les deux sens', () => {
	assert.equal(stepIndex(3, 0, 1), 1);
	assert.equal(stepIndex(3, 2, 1), 0);
	assert.equal(stepIndex(3, 0, -1), 2);
	assert.equal(stepIndex(1, 0, 1), 0);
});

t('stepIndex : rien n\'a encore joué (-1) entre par le bon bout', () => {
	assert.equal(stepIndex(5, -1, 1), 0);
	assert.equal(stepIndex(5, -1, -1), 4);
});

t('stepIndex : une bibliothèque vide ne rend jamais un index jouable', () => {
	assert.equal(stepIndex(0, -1, 1), -1);
	assert.equal(stepIndex(0, 0, -1), -1);
});

// --- la vraie bibliothèque, si elle est là ---------------------------------
//
// public/music.json est versionné, mais on ne fige RIEN de son contenu : il
// grossit à chaque lot généré. On n'affirme que des invariants de forme.
const manifestPath = fileURLToPath(new URL('../public/music.json', import.meta.url));
if (existsSync(manifestPath)) {
	const real = JSON.parse(readFileSync(manifestPath, 'utf8'));

	t('bibliothèque réelle : tout morceau du manifeste y apparaît une fois', () => {
		const lib = buildLibrary(real);
		assert.equal(lib.length, real.tracks.length);
		assert.equal(new Set(lib.map((x) => x.id)).size, lib.length);
	});

	t('bibliothèque réelle : aucune ligne ne dépasse le budget de la table', () => {
		// 56 caractères : la largeur que button.terminal-row tient sans
		// défilement horizontal à --fs-data.
		for (const track of buildLibrary(real)) {
			const row = jukeboxRow(track, { playing: true });
			assert.ok(row.length <= 56, `ligne trop large (${row.length}) : ${row}`);
		}
	});

	t('bibliothèque réelle : les filtres ne proposent que du non vide', () => {
		const lib = buildLibrary(real);
		for (const f of libraryFilters(real)) {
			assert.ok(filterLibrary(lib, f).length > 0, `filtre vide : ${f}`);
		}
	});
} else {
	console.log('  --  public/music.json absent : les cas sur la vraie bibliothèque sont sautés');
}

console.log(`\n${n} tests jukebox-model OK`);
