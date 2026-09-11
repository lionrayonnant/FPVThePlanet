// Keyboard bindings, remappable (D13).
//
// This module is the MODEL of the keyboard: which actions exist, which keys
// reach them, and what happens when the player gives a key to another action.
// It is PURE — no DOM, no localStorage, no event listeners — exactly like
// calibration.js, so tools/key-map-selftest.mjs can exercise every rule
// without a browser. input.js owns the storage and the events, settings.js
// owns the rows.
//
// Keys are stored the way KeyboardEvent.key reports them, lowercased:
// 'w', ' ', 'arrowup'. That is a LAYOUT-DEPENDENT value, which is exactly what
// we want: an AZERTY keyboard reports 'z' where a QWERTY one reports 'w', so
// the default map binds BOTH and neither player has to open Settings to fly.
//
// Tab, Escape and Enter are deliberately absent: they are navigation, not
// flight, and input.js passes them through under their own names.

// Ordered list — this order drives the KEYBOARD tab in Settings and the
// briefing. `hold: true` marks an action read continuously (an axis, or the
// link cut) rather than fired once on keydown.
export const KEY_ACTIONS = [
	{ id: 'throttleUp',   label: 'THROTTLE UP',   group: 'flight', hold: true },
	{ id: 'throttleDown', label: 'THROTTLE DOWN', group: 'flight', hold: true },
	{ id: 'yawLeft',      label: 'YAW LEFT',      group: 'flight', hold: true },
	{ id: 'yawRight',     label: 'YAW RIGHT',     group: 'flight', hold: true },
	{ id: 'rollLeft',     label: 'ROLL LEFT',     group: 'flight', hold: true },
	{ id: 'rollRight',    label: 'ROLL RIGHT',    group: 'flight', hold: true },
	{ id: 'pitchDown',    label: 'PITCH FORWARD', group: 'flight', hold: true },
	{ id: 'pitchUp',      label: 'PITCH BACK',    group: 'flight', hold: true },
	{ id: 'cutLink',      label: 'CUT LINK',      group: 'flight', hold: true },
	{ id: 'turtle',       label: 'TURTLE',        group: 'flight', hold: false },
	{ id: 'pause',        label: 'PAUSE',         group: 'system', hold: false },
	{ id: 'view',         label: 'VIEW',          group: 'system', hold: false },
	{ id: 'photo',        label: 'PHOTO',         group: 'system', hold: false },
	{ id: 'cyclePreset',  label: 'CYCLE PRESET',  group: 'system', hold: false },
	{ id: 'cycleMode',    label: 'CYCLE MODE',    group: 'system', hold: false },
	{ id: 'benchPanel',   label: 'BENCH PANEL',   group: 'bench',  hold: false },
	{ id: 'respawn',      label: 'RESPAWN',       group: 'bench',  hold: false },
];

const ACTION_IDS = KEY_ACTIONS.map(a => a.id);

// Two entries where the layouts disagree: both stay active at once, so the
// same install flies on a QWERTY and on an AZERTY keyboard.
export const DEFAULT_KEY_MAP = {
	throttleUp: ['w', 'z'],
	throttleDown: ['s'],
	yawLeft: ['a', 'q'],
	yawRight: ['d'],
	rollLeft: ['arrowleft'],
	rollRight: ['arrowright'],
	// "Forward on the stick makes the nose drop": ↑ pitches down, like the
	// gamepad convention in input.js.
	pitchDown: ['arrowup'],
	pitchUp: ['arrowdown'],
	cutLink: ['k'],
	turtle: ['t'],
	pause: [' '],
	view: ['v'],
	photo: ['f'],
	cyclePreset: ['p'],
	cycleMode: ['m'],
	benchPanel: ['b'],
	respawn: ['r'],
};

// localStorage key. Wiped by the Reset button like every other fpvtp.* key.
export const KEY_MAP_STORAGE = 'fpvtp.keyMap';

// A key is any non-empty string; Space is ' ' and must survive.
function normalizeKey(key) {
	return typeof key === 'string' && key.length > 0 ? key.toLowerCase() : null;
}

// One stored entry -> a clean key list, or null when nothing usable is left.
function normalizeKeys(value) {
	const list = Array.isArray(value) ? value : [value];
	const keys = [];
	for (const raw of list) {
		const key = normalizeKey(raw);
		if (key && !keys.includes(key)) keys.push(key);
	}
	return keys.length > 0 ? keys : null;
}

function cloneMap(map) {
	const out = {};
	for (const id of ACTION_IDS) out[id] = [...(map[id] ?? [])];
	return out;
}

// Stored JSON (or an already-parsed object) -> a complete map. Defensive on
// purpose: a corrupt key must never keep the sim from booting, so anything
// unreadable falls back per entry rather than as a whole.
export function loadKeyMap(raw) {
	let parsed = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return cloneMap(DEFAULT_KEY_MAP);
	}

	const map = {};
	for (const id of ACTION_IDS) {
		map[id] = normalizeKeys(parsed[id]) ?? [...DEFAULT_KEY_MAP[id]];
	}
	// Unknown ids in `parsed` are dropped: the loop above only reads the ids
	// this build knows about.
	return map;
}

// Lowercased KeyboardEvent.key -> action id, or null when nothing is bound.
export function actionForKey(map, key) {
	const wanted = normalizeKey(key);
	if (!wanted || !map) return null;
	for (const id of ACTION_IDS) {
		if (map[id]?.includes(wanted)) return id;
	}
	return null;
}

// Give `key` to `actionId`, as its ONLY key.
//
// If another action held that key, it loses it; when that leaves it with no
// key at all, it takes over actionId's former primary key — a true swap, so
// the player can never strand an action with nothing bound. `swappedWith`
// names that action so the UI can say what happened.
export function rebind(map, actionId, key) {
	const next = cloneMap(map ?? DEFAULT_KEY_MAP);
	const wanted = normalizeKey(key);
	if (!wanted || !ACTION_IDS.includes(actionId)) return { map: next, swappedWith: null };

	const formerPrimary = next[actionId][0] ?? null;
	const holder = actionForKey(next, wanted);

	next[actionId] = [wanted];

	if (holder && holder !== actionId) {
		next[holder] = next[holder].filter(k => k !== wanted);
		if (next[holder].length === 0 && formerPrimary) next[holder] = [formerPrimary];
		return { map: next, swappedWith: holder };
	}
	return { map: next, swappedWith: null };
}

const KEY_LABELS = {
	arrowup: '↑',
	arrowdown: '↓',
	arrowleft: '←',
	arrowright: '→',
	' ': 'SPACE',
	escape: 'ESC',
	enter: 'ENTER',
	tab: 'TAB',
	shift: 'SHIFT',
	control: 'CTRL',
	alt: 'ALT',
	backspace: 'BKSP',
};

// Display form of a stored key. '—' stands for "nothing bound".
export function keyLabel(key) {
	const k = normalizeKey(key);
	if (!k) return '—';
	return KEY_LABELS[k] ?? k.toUpperCase();
}

// One row per action, in KEY_ACTIONS order, keys already labelled — what the
// Settings tab and the briefing render.
export function keyMapRows(map) {
	return KEY_ACTIONS.map(action => ({
		id: action.id,
		label: action.label,
		group: action.group,
		hold: action.hold,
		keys: (map?.[action.id] ?? []).map(keyLabel),
	}));
}
