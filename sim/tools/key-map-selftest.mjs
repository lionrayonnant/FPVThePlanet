// Selftest for the pure keyboard map model (src/key-map.js). No DOM, no
// storage: the module is a plain data model, so every rule it enforces can be
// checked here without a browser.
// Run: node tools/key-map-selftest.mjs
import assert from 'node:assert/strict';
import {
	KEY_ACTIONS,
	DEFAULT_KEY_MAP,
	KEY_MAP_STORAGE,
	loadKeyMap,
	actionForKey,
	rebind,
	keyLabel,
	keyMapRows,
} from '../src/key-map.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- defaults ---------------------------------------------------------------

t('every KEY_ACTIONS id has a non-empty default binding', () => {
	for (const action of KEY_ACTIONS) {
		const keys = DEFAULT_KEY_MAP[action.id];
		assert.ok(Array.isArray(keys) && keys.length > 0, `missing default for ${action.id}`);
		for (const k of keys) {
			assert.equal(typeof k, 'string');
			assert.equal(k, k.toLowerCase(), `default key ${k} must be lowercase`);
		}
	}
	// No default binds an id that is not an action.
	assert.deepEqual(
		Object.keys(DEFAULT_KEY_MAP).sort(),
		KEY_ACTIONS.map(a => a.id).sort()
	);
});

t('no key is used twice in the defaults', () => {
	const seen = new Map();
	for (const [id, keys] of Object.entries(DEFAULT_KEY_MAP)) {
		for (const k of keys) {
			assert.equal(seen.get(k), undefined, `key ${k} bound to both ${seen.get(k)} and ${id}`);
			seen.set(k, id);
		}
	}
});

t('the AZERTY and QWERTY defaults both fly', () => {
	// Both layouts must reach throttle and yaw without touching Settings.
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'w'), 'throttleUp');   // QWERTY
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'z'), 'throttleUp');   // AZERTY
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'a'), 'yawLeft');      // QWERTY
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'q'), 'yawLeft');      // AZERTY
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 's'), 'throttleDown');
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'd'), 'yawRight');
});

t('navigation keys are NOT in the map', () => {
	// Tab, Escape and Enter stay fixed: they are navigation, not flight.
	for (const k of ['tab', 'escape', 'enter']) {
		assert.equal(actionForKey(DEFAULT_KEY_MAP, k), null);
	}
	assert.equal(actionForKey(DEFAULT_KEY_MAP, 'ù'), null);
});

// --- rebind -----------------------------------------------------------------

t('rebind on a free key replaces the whole list', () => {
	const { map, swappedWith } = rebind(DEFAULT_KEY_MAP, 'throttleUp', 'i');
	assert.equal(swappedWith, null);
	assert.deepEqual(map.throttleUp, ['i']);
	// The source map is untouched: the model is pure.
	assert.deepEqual(DEFAULT_KEY_MAP.throttleUp, ['w', 'z']);
	assert.equal(actionForKey(map, 'w'), null);
	assert.equal(actionForKey(map, 'i'), 'throttleUp');
});

t('rebind on a key held by another action swaps and reports swappedWith', () => {
	// photo (F) takes P, which cyclePreset held alone: cyclePreset takes F.
	const { map, swappedWith } = rebind(DEFAULT_KEY_MAP, 'photo', 'p');
	assert.equal(swappedWith, 'cyclePreset');
	assert.deepEqual(map.photo, ['p']);
	assert.deepEqual(map.cyclePreset, ['f']);
	assert.equal(actionForKey(map, 'p'), 'photo');
	assert.equal(actionForKey(map, 'f'), 'cyclePreset');
});

t('rebind never leaves a key bound twice, even on a two-key action', () => {
	// throttleUp holds W and Z; photo taking Z must not leave Z on both.
	const { map, swappedWith } = rebind(DEFAULT_KEY_MAP, 'photo', 'z');
	assert.equal(swappedWith, 'throttleUp');
	assert.deepEqual(map.photo, ['z']);
	assert.deepEqual(map.throttleUp, ['w']);
	assert.equal(actionForKey(map, 'z'), 'photo');
	assert.equal(actionForKey(map, 'w'), 'throttleUp');
});

t('rebind is case-insensitive and ignores unknown actions', () => {
	const { map } = rebind(DEFAULT_KEY_MAP, 'photo', 'J');
	assert.deepEqual(map.photo, ['j']);
	const untouched = rebind(DEFAULT_KEY_MAP, 'nope', 'j');
	assert.equal(untouched.swappedWith, null);
	assert.deepEqual(untouched.map, DEFAULT_KEY_MAP);
});

// --- loadKeyMap -------------------------------------------------------------

t('loadKeyMap(null) and garbage fall back to the defaults', () => {
	assert.deepEqual(loadKeyMap(null), DEFAULT_KEY_MAP);
	assert.deepEqual(loadKeyMap('garbage'), DEFAULT_KEY_MAP);
	assert.deepEqual(loadKeyMap(''), DEFAULT_KEY_MAP);
	assert.deepEqual(loadKeyMap('[1,2,3]'), DEFAULT_KEY_MAP);
	assert.deepEqual(loadKeyMap(undefined), DEFAULT_KEY_MAP);
});

t('loadKeyMap keeps the good entries and defaults the bad ones', () => {
	const map = loadKeyMap('{"pause":42,"photo":["j"],"bogusAction":["x"]}');
	assert.deepEqual(map.pause, DEFAULT_KEY_MAP.pause);   // bad value -> default
	assert.deepEqual(map.photo, ['j']);                   // good value kept
	assert.equal(map.bogusAction, undefined);             // unknown id dropped
	// Every action is still present after a partial load.
	for (const action of KEY_ACTIONS) assert.ok(map[action.id]?.length > 0);
});

t('loadKeyMap normalises keys and drops the empty leftovers', () => {
	const map = loadKeyMap('{"photo":["J","",7," "],"respawn":[]}');
	assert.deepEqual(map.photo, ['j', ' ']);
	assert.deepEqual(map.respawn, DEFAULT_KEY_MAP.respawn);
	assert.deepEqual(loadKeyMap({ photo: 'j' }).photo, ['j']);
});

// --- labels and rows --------------------------------------------------------

t('keyLabel table', () => {
	assert.equal(keyLabel('arrowup'), '↑');
	assert.equal(keyLabel('arrowdown'), '↓');
	assert.equal(keyLabel('arrowleft'), '←');
	assert.equal(keyLabel('arrowright'), '→');
	assert.equal(keyLabel(' '), 'SPACE');
	assert.equal(keyLabel('k'), 'K');
	assert.equal(keyLabel('escape'), 'ESC');
	assert.equal(keyLabel(''), '—');
	assert.equal(keyLabel(null), '—');
});

t('keyMapRows follows KEY_ACTIONS order and labels the keys', () => {
	const rows = keyMapRows(DEFAULT_KEY_MAP);
	assert.deepEqual(rows.map(r => r.id), KEY_ACTIONS.map(a => a.id));
	assert.deepEqual(rows.map(r => r.label), KEY_ACTIONS.map(a => a.label));
	const throttleUp = rows.find(r => r.id === 'throttleUp');
	assert.deepEqual(throttleUp.keys, ['W', 'Z']);
	assert.deepEqual(rows.find(r => r.id === 'pause').keys, ['SPACE']);
	assert.deepEqual(rows.find(r => r.id === 'pitchDown').keys, ['↑']);
	// A missing entry never throws: the row is simply empty.
	assert.deepEqual(keyMapRows({}).find(r => r.id === 'photo').keys, []);
});

t('storage key is the documented fpvtp.* one', () => {
	assert.equal(KEY_MAP_STORAGE, 'fpvtp.keyMap');
});

console.log(`\n${n} tests OK`);
