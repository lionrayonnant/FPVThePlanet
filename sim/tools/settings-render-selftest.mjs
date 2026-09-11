// node tools/settings-render-selftest.mjs — the Settings panel (D14), on the
// fake DOM of tools/lib/fake-dom.mjs.
//
// Same intention as terminal-render-selftest.mjs: what is checked is the TREE
// and the WIRING — which tabs exist, which body is showing, what a REBIND does
// to the stored map — never the look, which is judged by eye.
//
// The panel needs a container to mount into and an Input to read: both are
// faked here, so this runs without a browser and without a gamepad.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom({ raf: true });

const { Settings } = await import('../src/settings.js');
const { KEY_ACTIONS, DEFAULT_KEY_MAP, KEY_MAP_STORAGE, loadKeyMap, keyLabel } = await import('../src/key-map.js');
const { versionLine } = await import('../src/version.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

console.log('settings');

// An Input reduced to what the panel actually asks of it. No gamepad: the
// CONTROLLER tab must hold together on a machine where nothing is plugged in,
// which is the common case for a keyboard pilot.
function fakeInput() {
	let keyMap = loadKeyMap(null);
	return {
		gamepadIndex: null,
		map: {},
		calibration: null,
		getGamepad: () => null,
		listGamepads: () => [],
		isCalibrated: () => false,
		selectGamepad() { },
		setMapping() { },
		setCalibration() { },
		setKeyMap(m) { keyMap = loadKeyMap(m); return keyMap; },
		getKeyMap: () => keyMap,
	};
}

function mount() {
	dom.root.replaceChildren();
	dom.storage.clear();
	const root = document.createElement('div');
	root.id = 'ui';
	dom.root.appendChild(root);
	const input = fakeInput();
	const settings = new Settings(root, input);
	const el = settings.el.settings;
	return {
		settings, input, el,
		tabs: () => el.querySelectorAll('.terminal-tab'),
		sections: () => el.querySelectorAll('section[data-tab]'),
		shown: () => el.querySelectorAll('section[data-tab]').filter((s) => !s.hidden),
		rows: () => el.querySelectorAll('.key-row'),
		btn: (label) => el.querySelectorAll('button').find((b) => b.textContent === label
			|| b.textContent === `[ ${label} ]`),
		// A key press as the panel sees it while capturing: the listener sits on
		// the panel, in the capture phase.
		down: (target) => el.dispatchEvent({ type: 'pointerdown', target }),
		key: (k) => {
			const ev = {
				type: 'keydown', key: k,
				stopPropagation() { this.stopped = true; },
				preventDefault() { this.defaultPrevented = true; },
			};
			el.dispatchEvent(ev);
			return ev;
		},
	};
}

// --- the tab strip ----------------------------------------------------------

t('the panel carries the display header and the four tabs, in order', () => {
	const p = mount();
	assert.ok(p.el.textContent.includes('FPVTP! // SETTINGS'), 'the display header names the screen');
	assert.ok(p.el.querySelector('.t-display'), 'the header is at the DISPLAY level');
	assert.ok(p.el.querySelector('.terminal-tabs'), 'the strip reuses the terminal tabs');
	assert.deepEqual(p.tabs().map((b) => b.textContent), ['CONTROLLER', 'KEYBOARD', 'AUDIO', 'SYSTEM']);
	assert.deepEqual(p.sections().map((s) => s.dataset.tab), ['controller', 'keyboard', 'audio', 'system']);
});

t('one body at a time, and the active tab wears data-on', () => {
	const p = mount();
	p.settings.open('controller');
	assert.deepEqual(p.shown().map((s) => s.dataset.tab), ['controller']);
	assert.deepEqual(p.tabs().map((b) => b.dataset.on), ['true', undefined, undefined, undefined]);

	p.tabs()[1].click();
	assert.deepEqual(p.shown().map((s) => s.dataset.tab), ['keyboard']);
	assert.deepEqual(p.tabs().map((b) => b.dataset.on), [undefined, 'true', undefined, undefined]);

	p.tabs()[3].click();
	assert.deepEqual(p.shown().map((s) => s.dataset.tab), ['system']);
});

t('open(tab) opens the panel on that tab, and the choice survives a remount', () => {
	const p = mount();
	assert.equal(p.el.hidden, true, 'the panel starts closed');
	p.settings.open('audio');
	assert.equal(p.el.hidden, false);
	assert.deepEqual(p.shown().map((s) => s.dataset.tab), ['audio']);

	// Remembered for the page load: a second panel opens where the first was
	// left, so closing and reopening does not throw the pilot back to CONTROLLER.
	const q = mount();
	q.settings.toggleSettings(true);
	assert.deepEqual(q.shown().map((s) => s.dataset.tab), ['audio']);
	q.settings.open('controller');
});

// --- the KEYBOARD tab -------------------------------------------------------

t('KEYBOARD lists every action with its default keys', () => {
	const p = mount();
	p.settings.open('keyboard');
	const rows = p.rows();
	assert.equal(rows.length, KEY_ACTIONS.length);
	assert.deepEqual(rows.map((r) => r.dataset.action), KEY_ACTIONS.map((a) => a.id));
	for (const action of KEY_ACTIONS) {
		const row = rows.find((r) => r.dataset.action === action.id);
		assert.ok(row.textContent.includes(action.label), `${action.id} names itself`);
		for (const k of DEFAULT_KEY_MAP[action.id]) {
			assert.ok(row.textContent.includes(keyLabel(k)), `${action.id} shows ${keyLabel(k)}`);
		}
		assert.ok(row.querySelectorAll('button').some((b) => b.textContent.includes('REBIND')));
	}
	p.settings.open('controller');
});

t('REBIND captures the next key, persists it and hands it to the Input', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'photo');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	assert.ok(row.textContent.includes('PRESS A KEY'), 'the row asks for a key');
	assert.ok(row.textContent.includes('ESC CANCELS'), 'and says how to back out');

	const ev = p.key('x');
	assert.ok(ev.stopped, 'the captured key does not reach the flight or the menus');
	assert.deepEqual(p.input.getKeyMap().photo, ['x'], 'the Input flies with the new key');
	assert.deepEqual(loadKeyMap(dom.storage.get(KEY_MAP_STORAGE)).photo, ['x'], 'and it survives a reload');
	const after = p.rows().find((r) => r.dataset.action === 'photo');
	assert.ok(after.textContent.includes('X'), 'the row shows the new key');
	assert.ok(!after.textContent.includes('PRESS A KEY'), 'capture is over');
	p.settings.open('controller');
});

t('a conflicting key swaps the two actions and the row says so', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'yawLeft');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	p.key('s');   // THROTTLE DOWN holds S by default
	const map = p.input.getKeyMap();
	assert.deepEqual(map.yawLeft, ['s']);
	assert.ok(!map.throttleDown.includes('s'), 'the loser gives up the key');
	assert.ok(map.throttleDown.length > 0, 'and is never left unbound');
	const after = p.rows().find((r) => r.dataset.action === 'yawLeft');
	assert.ok(after.textContent.includes('SWAPPED WITH THROTTLE DOWN'), after.textContent);
	p.settings.open('controller');
});

t('arming a second row disarms the first — one prompt on screen, one binding', () => {
	const p = mount();
	p.settings.open('keyboard');
	const rebindOf = (id) => p.rows().find((r) => r.dataset.action === id)
		.querySelectorAll('button').find((b) => b.textContent.includes('REBIND'));
	rebindOf('cutLink').click();
	rebindOf('respawn').click();
	const note = (id) => p.rows().find((r) => r.dataset.action === id).textContent;
	assert.ok(!note('cutLink').includes('PRESS A KEY'), 'the first row gave up its prompt');
	assert.ok(note('respawn').includes('PRESS A KEY'), 'the second row asks');

	p.key('x');
	assert.deepEqual(p.input.getKeyMap().respawn, ['x'], 'the armed row gets the key');
	assert.deepEqual(p.input.getKeyMap().cutLink, DEFAULT_KEY_MAP.cutLink, 'the disarmed one is untouched');
	p.settings.open('controller');
});

t('a pointer down outside the armed row ends the capture', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'photo');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	// On the row itself, nothing happens: its own REBIND re-arms it.
	p.down(row.querySelectorAll('button')[0]);
	assert.ok(row.textContent.includes('PRESS A KEY'), 'the armed row survives its own row');

	p.down(p.tabs()[0]);
	assert.ok(!p.rows().find((r) => r.dataset.action === 'photo').textContent.includes('PRESS A KEY'));
	p.key('x');
	assert.deepEqual(p.input.getKeyMap().photo, DEFAULT_KEY_MAP.photo, 'no trap left swallowing keys');
	p.settings.open('controller');
});

t('Escape cancels a capture without touching the map', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'view');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	p.key('Escape');
	assert.deepEqual(p.input.getKeyMap().view, DEFAULT_KEY_MAP.view);
	assert.ok(!p.rows().find((r) => r.dataset.action === 'view').textContent.includes('PRESS A KEY'));
	// And the next key is a key again, not a binding.
	p.key('x');
	assert.deepEqual(p.input.getKeyMap().view, DEFAULT_KEY_MAP.view);
	p.settings.open('controller');
});

t('closing the panel ends any capture in progress', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'pause');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	p.settings.toggleSettings(false);
	p.key('x');
	assert.deepEqual(p.input.getKeyMap().pause, DEFAULT_KEY_MAP.pause, 'a closed panel binds nothing');
	p.settings.open('controller');
});

t('RESET KEYS restores the defaults', () => {
	const p = mount();
	p.settings.open('keyboard');
	const row = p.rows().find((r) => r.dataset.action === 'respawn');
	row.querySelectorAll('button').find((b) => b.textContent.includes('REBIND')).click();
	p.key('x');
	assert.deepEqual(p.input.getKeyMap().respawn, ['x']);

	p.btn('RESET KEYS').click();
	assert.deepEqual(p.input.getKeyMap(), loadKeyMap(null));
	assert.deepEqual(loadKeyMap(dom.storage.get(KEY_MAP_STORAGE)), loadKeyMap(null));
	assert.ok(p.rows().find((r) => r.dataset.action === 'respawn').textContent.includes('R'));
	p.settings.open('controller');
});

// --- CONTROLLER, AUDIO, SYSTEM ---------------------------------------------

t('CONTROLLER keeps the calibration wizard wired', () => {
	const p = mount();
	p.settings.open('controller');
	for (const id of ['pad-name', 'pad-list', 'pad-map', 'cal-row', 'calibrate', 'cal-note',
		'cal-screen', 'cal-step', 'cal-prompt', 'cal-hint', 'cal-message', 'cal-bar',
		'cal-drone', 'cal-cancel-row', 'cal-cancel', 'cal-summary']) {
		assert.ok(p.el.querySelector(`[id="${id}"]`), `#${id} is still there`);
	}
	const controller = p.sections().find((s) => s.dataset.tab === 'controller');
	assert.ok(controller.querySelector('[id="cal-row"]'), 'the wizard lives under CONTROLLER');
	// No gamepad: CALIBRATE is offered but inert, and nothing throws.
	assert.equal(p.el.querySelector('[id="calibrate"]').disabled, true);
});

t('AUDIO holds the three sliders', () => {
	const p = mount();
	p.settings.open('audio');
	const audio = p.sections().find((s) => s.dataset.tab === 'audio');
	for (const id of ['vol', 'tone', 'music']) {
		assert.ok(audio.querySelector(`[id="${id}"]`), `#${id} is under AUDIO`);
	}
});

t('SYSTEM shows the version, hides the view range until ?live=, and Reset needs two presses', () => {
	const p = mount();
	p.settings.open('system');
	const system = p.sections().find((s) => s.dataset.tab === 'system');
	assert.ok(system.textContent.includes(versionLine()), 'the real version is on screen');
	assert.equal(p.el.querySelector('[id="viewrange-row"]').hidden, true, 'no view range outside live');
	p.settings.setViewRange(300, () => { });
	assert.equal(p.el.querySelector('[id="viewrange-row"]').hidden, false);

	const reset = p.btn('RESET SETTINGS');
	assert.ok(reset, 'the reset button is under SYSTEM');
	assert.ok(system.querySelectorAll('button').includes(reset));
	reset.click();
	assert.ok(reset.textContent.includes('CONFIRM'), 'the first press only arms');
	reset.click();
	assert.ok(!reset.textContent.includes('CONFIRM'), 'the second press fires and disarms');
});

t('REPLAY BRIEFING appears only once the slot is filled', () => {
	const p = mount();
	assert.equal(p.settings.onReplayBriefing, null, 'the slot exists and starts empty');
	p.settings.open('system');
	assert.equal(p.btn('REPLAY BRIEFING'), undefined, 'nothing to replay, nothing on screen');

	let played = 0;
	p.settings.onReplayBriefing = () => { played++; };
	p.settings.open('system');
	const btn = p.btn('REPLAY BRIEFING');
	assert.ok(btn, 'the button appears once a briefing exists');
	btn.click();
	assert.equal(played, 1);
});

t('REPLAY BRIEFING is not offered in flight', () => {
	// F2: TAB opens the panel over a running flight, and the briefing mounts
	// full terminal screens — replaying it there is a way out of the session.
	const p = mount();
	p.settings.onReplayBriefing = () => { };
	p.settings.flightActive = true;
	p.settings.open('system');
	assert.equal(p.btn('REPLAY BRIEFING'), undefined, 'no way into the briefing mid-flight');
	p.settings.flightActive = false;
	p.settings.open('system');
	assert.ok(p.btn('REPLAY BRIEFING'), 'and it comes back on the ground');
});

// --- the key hints ----------------------------------------------------------

t('the panel names its keys instead of carrying a Close button', () => {
	const p = mount();
	const hints = p.el.querySelector('.terminal-keys');
	assert.ok(hints, 'the key-hint row is there');
	assert.equal(hints.textContent, '[ESC] CLOSE · [TAB] CLOSE');
	assert.equal(p.el.querySelectorAll('button').find((b) => /CLOSE/.test(b.textContent)), undefined,
		'and no button repeats it');
});

await ta('closed() resolves when the panel closes', async () => {
	const p = mount();
	p.settings.toggleSettings(true);
	let done = false;
	const wait = p.settings.closed().then(() => { done = true; });
	p.settings.toggleSettings(false);
	await wait;
	assert.equal(done, true);
});

console.log(`\n  ${n} checks ok`);
