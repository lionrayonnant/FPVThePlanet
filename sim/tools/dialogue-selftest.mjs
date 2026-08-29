// Selftest du moteur de dialogue (PHASE 21). Aucune E/S, aucun DOM.
// Lancer : node tools/dialogue-selftest.mjs
import assert from 'node:assert/strict';
import {
	CREW, RARITY, EVENTS, SLOTS, JENSEN_COOLDOWN, MEMORY_RING, MEMORY_SEEN,
	resolvePath, slotsUsed, pathsForSlots,
} from './dialogue/catalog.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('crew : trois voix humaines plus cron, et plus de vex', () => {
	assert.deepEqual(CREW, ['root', 'jensen', 'mikhail', 'cron']);
	assert.ok(!CREW.includes('vex'), 'vex a été retiré du canon (D7)');
});

t('rareté : les poids exacts de la spec', () => {
	assert.deepEqual(RARITY, { COMMON: 100, UNCOMMON: 30, RARE: 8, VERY_RARE: 2 });
});

t('constantes : plafond de jensen et tailles de mémoire', () => {
	assert.equal(JENSEN_COOLDOWN, 12);
	assert.equal(MEMORY_RING, 256);
	assert.equal(MEMORY_SEEN, 512);
});

t('événements : chacun a un shard, un poids de silence et des cadences', () => {
	const ids = Object.keys(EVENTS);
	assert.ok(ids.length >= 19, `catalogue complet attendu, ${ids.length} trouvés`);
	for (const [id, e] of Object.entries(EVENTS)) {
		assert.equal(id, id.toUpperCase(), `${id} : les ids d'événement sont en majuscules`);
		assert.match(e.shard, /^[a-z_]+$/, `${id} : nom de shard en minuscules`);
		assert.ok(e.silenceWeight >= 0, `${id} : poids de silence`);
		assert.ok(e.gapMs[0] > 0 && e.gapMs[1] > e.gapMs[0], `${id} : écart entre échanges`);
		assert.ok(e.beatMs[0] > 0 && e.beatMs[1] > e.beatMs[0], `${id} : battement entre répliques`);
	}
});

t('événements : les catégories câblées en v1 sont présentes', () => {
	for (const id of ['AREA_SEARCH', 'PROBE_AREA', 'ACQUIRE_AREA', 'TERRAIN_PROGRESS',
		'TARGET_SCAN', 'TARGET_SELECTED', 'TARGET_ANALYSIS', 'HACK', 'MANUAL_OVERRIDE',
		'JACK_IN', 'WEATHER']) {
		assert.ok(EVENTS[id], `événement câblé manquant : ${id}`);
	}
});

t('slots : chacun déclare un chemin et un formateur', () => {
	for (const [name, s] of Object.entries(SLOTS)) {
		assert.match(name, /^[a-z_]+$/, `slot ${name} : minuscules et souligné`);
		assert.match(s.path, /^[a-zA-Z0-9_.]+$/, `slot ${name} : chemin`);
		assert.equal(typeof s.format, 'function', `slot ${name} : formateur`);
	}
});

t('resolvePath : rend null sur absent, null, NaN et chaîne vide', () => {
	const ctx = { weather: { windMs: 6, gustMs: null, tempC: NaN }, area: { name: '' } };
	assert.equal(resolvePath(ctx, 'weather.windMs'), 6);
	assert.equal(resolvePath(ctx, 'weather.gustMs'), null);
	assert.equal(resolvePath(ctx, 'weather.tempC'), null);
	assert.equal(resolvePath(ctx, 'area.name'), null);
	assert.equal(resolvePath(ctx, 'target.rssiDbm'), null);
	assert.equal(resolvePath(ctx, 'nope.nested.deep'), null);
});

t('slotsUsed : extrait les slots des répliques, sans doublon', () => {
	const entry = { lines: [
		{ speaker: 'root', text: '{wind} meters per second in {location}.' },
		{ speaker: 'mikhail', text: 'not with the {drone_type}. {wind} is a lot.' },
	] };
	assert.deepEqual(slotsUsed(entry).sort(), ['drone_type', 'location', 'wind']);
});

t('pathsForSlots : traduit les noms de slots en chemins d\'état', () => {
	assert.deepEqual(pathsForSlots(['wind']), [SLOTS.wind.path]);
	assert.deepEqual(pathsForSlots(['nope']), []);
});

console.log(`\n${n} vérifications, tout passe.`);
