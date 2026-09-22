import { CHANNELS, padKind, padListEntries, PAD_LIST_EMPTY } from './input.js';
import { beginCalibration, feedSample, calibrationResult, calProgress, calSummaryLines, padSignals, signalLabel } from './calibration.js';
import { calibrationDrone } from './calibration-drone.js';
import { armConfirm } from './confirm-button.js';
import { menuNav } from './menu-nav.js';
import { KEY_ACTIONS, KEY_MAP_STORAGE, keyMapRows, rebind, loadKeyMap } from './key-map.js';
import { button, keyHints } from './terminal.js';
import { versionLine } from './version.js';

const VOLUME_KEY = 'fpvtp.audioVolume';
const BRIGHTNESS_KEY = 'fpvtp.audioBrightness';
const MUSIC_KEY = 'fpvtp.musicVolume';
const LENS_KEY = 'fpvtp.lens';
const VIGNETTE_KEY = 'fpvtp.lensVignette';
const SHUTTER_KEY = 'fpvtp.lensShutter';
const LENS_ON_KEY = 'fpvtp.lensOn';
const LINK_KEY = 'fpvtp.link';
const LINK_MODE_KEY = 'fpvtp.linkMode';
const VIEW_RANGE_KEY = 'fpvtp.viewRange';

// Audio settings survive reloads. Anything unparseable falls back to the
// default rather than throwing: a corrupt key must not stop the sim booting.
// Note the null check — Number(null) is 0, which would silently turn a first
// run into a muted one.
function loadPercent(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved / 100;
	} catch { }
	return fallback;
}

export const loadVolume = () => loadPercent(VOLUME_KEY, 0.6);
export const loadBrightness = () => loadPercent(BRIGHTNESS_KEY, 0.5);
// This default IS the music/motor balance, and it is the only place that
// balance lives: audio-bus.js no longer applies a trim on top (it had one, also
// at 0.7, which attenuated twice — fixed). 0.7 is the value measured on the
// first listen in flight.
//
// SEPARATE from the master volume, so the music can come down without the motor
// coming down: flying stays an exercise in listening to the machine.
export const loadMusicVolume = () => loadPercent(MUSIC_KEY, 0.7);

// View distance for ?live= mode (#182), in METRES — not a percentage, so not
// loadPercent(). Slider bounds: 100-600 m. The cost is QUADRATIC in radius
// (nodes ∝ r², measured: 200 m ≈ 1032 meshes) — 600 m ≈ ×9, and it is the
// user's GPU and the user's kh.google.com, so it is the user's call. Default
// 300 m: chosen by the user on the first pass over the slider.
export const VIEW_RANGE_MIN_M = 100;
export const VIEW_RANGE_MAX_M = 2000;
export function loadViewRange() {
	try {
		const raw = localStorage.getItem(VIEW_RANGE_KEY);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= VIEW_RANGE_MIN_M && saved <= VIEW_RANGE_MAX_M) return saved;
	} catch { }
	// 600 m, not 300 (#32): since the LOD rings were extended, doubling the
	// range costs 2 fps and ~180 MB of textures (measured in Paris, 740 -> 1003
	// nodes). A 300 m default made the world stop just behind the drone, which
	// shows the moment you turn around. The slider goes up to 2 km.
	return 600;
}

// The FPV look is on by default — a clean rectilinear camera is the thing this
// is here to stop looking like. Every part of it is a slider away from off, and
// the master checkbox is one click away, which is what makes A/B comparison
// possible at all.
export function loadLens() {
	let on = true;
	try { on = localStorage.getItem(LENS_ON_KEY) !== '0'; } catch { }
	return {
		on,
		lens: loadPercent(LENS_KEY, 0.6),
		vignette: loadPercent(VIGNETTE_KEY, 0.5),
		// 8 ms is 1/125 s: a plausible daylight shutter on an FPV camera, and long
		// enough that a fast roll visibly smears.
		shutter: loadPercent(SHUTTER_KEY, 0.4) * 20,
	};
}

// The weather is no longer here (PHASE 04, Bible §31). Wind, rain and fog
// belong to the world and to the session: they come from the operator's world
// state through src/weather.js, and no user setting can choose the weather any
// more. The wind.js / rain.js / fog.js models have not moved — only the hand
// that writes their parameters has changed.
// window.__sim.setWeather / setRain / setFog remain the debug access.

// The link degradation is on at full strength by default: the point of the
// feature is that going behind a building costs you the picture, and a version
// that never quite breaks would not be that. The slider is what makes it an
// argument rather than a decree — 0 % turns the whole thing off.
export function loadLink() {
	let mode = 'analog';
	try {
		const saved = localStorage.getItem(LINK_MODE_KEY);
		if (saved === 'analog' || saved === 'digital') mode = saved;
	} catch { }
	return { mode, severity: loadPercent(LINK_KEY, 1) };
}

// ---------------------------------------------------------------------------
// THE PANEL (D14)
//
// Four tabs, one body at a time, in the terminal's own clothes: a DISPLAY
// header, the tab strip the Home already uses, and a key-hint row instead of a
// Close button. Same #settings element and same toggleSettings()/closed()
// contract as before — only the inside changed.
//
// The tree is built with createElement rather than innerHTML, for the same
// reason terminal.js is: an innerHTML panel cannot be mounted on the fake DOM
// of tools/lib/fake-dom.mjs, and this screen is now worth testing.
// ---------------------------------------------------------------------------

const TABS = [
	['controller', 'CONTROLLER'],
	['keyboard', 'KEYBOARD'],
	['audio', 'AUDIO'],
	['system', 'SYSTEM'],
];

// The open tab, for the page load only (same rule as terminal.js's lastTab):
// reopening the panel comes back where it was left, a reload starts at
// CONTROLLER. Not stored — a remembered tab is not a setting.
let activeTab = TABS[0][0];

// How long a row keeps saying what a rebind did to its neighbour.
const SWAP_NOTICE_MS = 2000;

// What a row says while it waits for a key.
//
// The key is written in the game's one key-hint form, `[KEY] VERB` (D15,
// terminal.js keyHints): the prose `PRESS A KEY — ESC CANCELS` was the only
// place a key was named without brackets, and it sat in the same panel as
// `[ESC] CLOSE` — two spellings of Escape, in two formats, on one screen.
const CAPTURE_PROMPT = 'PRESS A KEY · [ESC] CANCEL';

// Minimal element builder. `id` is written to BOTH the property and the
// attribute: the property is what the code reads, the attribute is what
// querySelector('[id="…"]') matches on a DOM that does not reflect.
function h(tag, props = {}, children = []) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined) continue;
		if (k === 'class') el.className = v;
		else if (k === 'text') el.textContent = v;
		else if (k === 'data') Object.assign(el.dataset, v);
		else if (k === 'id') { el.id = v; el.setAttribute('id', v); }
		else el[k] = v;
	}
	for (const c of children) el.appendChild(c);
	return el;
}

// The Tab panel: input detection/binding, keyboard mapping, audio, system.
// It owns #settings and nothing else — the flight OSD has split into two
// layers (drone-osd.js and fpvtp-osd.js), and the operator terminal lives in
// terminal.js.
// Issue #120: camera, lens and video link were not settings meant for the
// player — they are still driven by their stored values (loadLens/loadLink, cf.
// main.js) but they have left this panel.
export class Settings {
	constructor(root, input) {
		this.input = input;
		// Filled by main.js when a briefing exists (D16). While it is null the
		// SYSTEM tab draws no REPLAY BRIEFING button: nothing to replay.
		this.onReplayBriefing = null;
		// The action being rebound, or null. Module-level state would be wrong
		// here — two panels never coexist, but the listener is per panel.
		this._capture = null;
		this._captureKey = null;
		this._swapNotice = null;
		this._swapTimer = 0;

		const el = h('div', { id: 'settings', hidden: true });
		const panel = h('div', { class: 'panel' });
		el.appendChild(panel);

		// The DISPLAY level, once: the panel names itself, then keeps quiet.
		panel.appendChild(h('pre', { class: 'panel-title t-display', text: 'FPVTP! // SETTINGS' }));

		const strip = h('div', { class: 'terminal-tabs' });
		this._tabButtons = TABS.map(([id, label]) => {
			const b = h('button', {
				type: 'button', class: 'terminal-tab', text: label,
				onclick: () => this.selectTab(id),
			});
			b.dataset.tab = id;
			strip.appendChild(b);
			return b;
		});
		panel.appendChild(strip);

		this._sections = {};
		for (const [id] of TABS) {
			const section = h('section', { class: 'panel-body', hidden: true });
			section.dataset.tab = id;
			this._sections[id] = section;
			panel.appendChild(section);
		}

		this.buildController(this._sections.controller);
		this.buildKeyboard(this._sections.keyboard);
		this.buildAudio(this._sections.audio);
		this.buildSystem(this._sections.system);

		// D15: the key is written, not drawn as a button. Both close, and it is
		// main.js that hears them — the panel only says so.
		panel.appendChild(keyHints([['ESC', 'CLOSE'], ['TAB', 'CLOSE']]));

		root.appendChild(el);

		this.el = {
			settings: el,
			panel,
			vol: el.querySelector('[id="vol"]'),
			volVal: el.querySelector('[id="vol-val"]'),
			tone: el.querySelector('[id="tone"]'),
			toneVal: el.querySelector('[id="tone-val"]'),
			music: el.querySelector('[id="music"]'),
			musicVal: el.querySelector('[id="music-val"]'),
			viewRangeRow: el.querySelector('[id="viewrange-row"]'),
			viewRange: el.querySelector('[id="viewrange"]'),
			viewRangeVal: el.querySelector('[id="viewrange-val"]'),
			padName: el.querySelector('[id="pad-name"]'),
			padList: el.querySelector('[id="pad-list"]'),
			padMap: el.querySelector('[id="pad-map"]'),
			calRow: el.querySelector('[id="cal-row"]'),
			calButton: el.querySelector('[id="calibrate"]'),
			calNote: el.querySelector('[id="cal-note"]'),
			calScreen: el.querySelector('[id="cal-screen"]'),
			calStep: el.querySelector('[id="cal-step"]'),
			calPrompt: el.querySelector('[id="cal-prompt"]'),
			calHint: el.querySelector('[id="cal-hint"]'),
			calMessage: el.querySelector('[id="cal-message"]'),
			calBar: el.querySelector('[id="cal-bar"]'),
			calDrone: el.querySelector('[id="cal-drone"]'),
			calCancelRow: el.querySelector('[id="cal-cancel-row"]'),
			calSummary: el.querySelector('[id="cal-summary"]'),
			keyRows: el.querySelector('[id="key-rows"]'),
			replayRow: el.querySelector('[id="replay-row"]'),
		};
		// State of the calibration wizard, or null. It is the only thing that
		// tells an open panel apart from a panel that is measuring.
		this._cal = null;
		this._calPadId = null;
		this._calLast = 0;
		this._calRaf = null;
		this.el.calButton.onclick = () => this.startCalibration();
		el.querySelector('[id="cal-cancel"]').onclick = () => this.cancelCalibration();
		// Set true by main.js when a flight starts: the panel opened in flight
		// does not listen to the gamepad (the sticks fly the drone — issue #123).
		this.flightActive = false;
		this._axisRows = [];
		this.selectTab(activeTab);
		// Populate every control from storage now, with inert callbacks, so the
		// panel reads correctly even if nothing wires it. main.js re-arms the same
		// setters with live callbacks — every setter re-reads and re-emits, so the
		// second pass is idempotent. The audio ones are re-armed at module scope,
		// NOT at boot: the panel is reachable from the terminal, and a slider
		// wired at boot only took effect at the next hack.
		this.hydrate();
	}

	// ---------------------------------------------------------------------------
	// THE FOUR BODIES
	// ---------------------------------------------------------------------------

	// CONTROLLER — the device list, the calibration wizard and the channel map,
	// moved here whole. Every id is the one startCalibration/renderCalibration
	// already write to: this tab changed address, not behaviour.
	buildController(box) {
		box.appendChild(h('p', { id: 'pad-name', text: 'NO CONTROLLER DETECTED' }));
		// What the BROWSER sees, and the choice when it sees several (issue
		// #162). Without this list a misclassified radio — or one simply absent
		// from the enumeration — left the pilot with no recourse at all.
		box.appendChild(h('div', { id: 'pad-list', class: 'spec' }));
		// Measured calibration (issue #277). The button is always there; the
		// note beside it only ever speaks of a device that was NEVER calibrated.
		box.appendChild(h('div', { id: 'cal-row' }, [
			// `terminal-cta`: the brackets are the mark of a decision, and
			// CALIBRATE is one just as much as [ RESET KEYS ] two tabs further
			// on. Two button conventions used to coexist in the same panel.
			h('button', { id: 'calibrate', type: 'button', class: 'terminal-cta', text: '[ CALIBRATE ]' }),
			h('span', { id: 'cal-note', class: 'spec' }),
		]));
		box.appendChild(h('div', { id: 'cal-screen', hidden: true }, [
			h('p', { id: 'cal-step', class: 'spec' }),
			h('p', { id: 'cal-prompt' }),
			h('p', { id: 'cal-hint', class: 'spec' }),
			h('p', { id: 'cal-message', class: 'spec' }),
			h('div', { class: 'axisbar' }, [h('i', { id: 'cal-bar' })]),
		]));
		// The machine that answers the sticks (#281). Outside #cal-screen on
		// purpose: it stays once the measurement is over and follows the four
		// calibrated sticks — the test bench comes for free. That is also why
		// CANCEL moved below it.
		box.appendChild(h('div', { id: 'cal-drone', hidden: true }));
		box.appendChild(h('div', { id: 'cal-cancel-row', hidden: true }, [
			h('button', { id: 'cal-cancel', type: 'button', class: 'terminal-cta', text: '[ CANCEL ]' }),
		]));
		box.appendChild(h('div', { id: 'cal-summary', class: 'spec', hidden: true }));
		box.appendChild(h('table', { id: 'pad-map' }));
	}

	// KEYBOARD — one row per action (D13). The rows are rebuilt from the map
	// rather than patched: the map is the truth, the tab is a view of it.
	buildKeyboard(box) {
		box.appendChild(h('div', { id: 'key-rows', class: 'key-rows' }));
		// A rebind is patient work, and it was thrown away on one press. Same
		// guard as RESET SETTINGS below and as the terminal's REMOVE TERRAIN
		// (#213): the first press arms, the second one resets.
		const reset = button('RESET KEYS', null, 'terminal-cta');
		armConfirm(reset, () => this.resetKeys());
		box.appendChild(reset);
	}

	buildAudio(box) {
		box.appendChild(h('label', {}, [
			h('span', { class: 't-ui', text: 'Volume' }),
			h('input', { id: 'vol', type: 'range', min: '0', max: '100', step: '1' }),
			h('span', { id: 'vol-val', class: 't-data' }),
			h('span', { class: 't-data', text: '%' }),
		]));
		box.appendChild(h('label', {}, [
			h('span', { class: 't-ui', text: 'Tone' }),
			h('input', { id: 'tone', type: 'range', min: '0', max: '100', step: '1' }),
			h('span', { id: 'tone-val', class: 't-data' }),
		]));
		box.appendChild(h('label', {}, [
			h('span', { class: 't-ui', text: 'Music' }),
			h('input', { id: 'music', type: 'range', min: '0', max: '100', step: '1' }),
			h('span', { id: 'music-val', class: 't-data' }),
			h('span', { class: 't-data', text: '%' }),
		]));
	}

	// SYSTEM — what belongs to the installation rather than to the pilot: the
	// live view range, the briefing, the reset, and which build this is.
	buildSystem(box) {
		box.appendChild(h('div', { id: 'viewrange-row', hidden: true }, [
			h('label', {}, [
				h('span', { class: 't-ui', text: 'View range' }),
				h('input', {
					id: 'viewrange', type: 'range',
					min: String(VIEW_RANGE_MIN_M), max: String(VIEW_RANGE_MAX_M), step: '100',
				}),
				h('span', { id: 'viewrange-val', class: 't-data' }),
				h('span', { class: 't-data', text: 'm' }),
			]),
		]));
		box.appendChild(h('div', { id: 'replay-row' }));
		// No browser confirm() (§44, issue #213): the button relabels itself and
		// the SECOND press is the confirmation.
		const reset = button('RESET SETTINGS', null, 'terminal-cta');
		box.appendChild(reset);
		armConfirm(reset, () => {
			try {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('fpvtp.')) localStorage.removeItem(key);
				}
			} catch { }
			// Guarded: this module is now mounted on a fake DOM by
			// tools/settings-render-selftest.mjs, where there is no location.
			if (typeof location !== 'undefined') location.reload();
		});
		box.appendChild(h('pre', { class: 'panel-version t-data', text: versionLine() }));
	}

	// ---------------------------------------------------------------------------
	// TABS
	// ---------------------------------------------------------------------------

	selectTab(id) {
		const tab = TABS.some(([t]) => t === id) ? id : TABS[0][0];
		if (tab !== 'keyboard') this.endCapture();
		activeTab = tab;
		for (const b of this._tabButtons) {
			if (b.dataset.tab === tab) b.dataset.on = 'true'; else delete b.dataset.on;
		}
		for (const [key, section] of Object.entries(this._sections)) section.hidden = key !== tab;
		if (tab === 'keyboard') this.renderKeyboard();
		if (tab === 'system') this.renderSystem();
	}

	// Open the panel straight onto a tab. The terminal uses it to land on
	// KEYBOARD or CONTROLLER from a briefing that just named them.
	open(tab) {
		this.toggleSettings(true);
		if (tab) this.selectTab(tab);
	}

	// ---------------------------------------------------------------------------
	// KEYBOARD TAB (D13)
	// ---------------------------------------------------------------------------

	renderKeyboard() {
		const box = this.el.keyRows;
		box.replaceChildren();
		this._keyRows = new Map();
		for (const row of keyMapRows(this.input.getKeyMap())) {
			const line = h('div', { class: 'key-row' });
			line.dataset.action = row.id;
			line.appendChild(h('span', { class: 'key-name t-ui', text: row.label }));
			line.appendChild(h('span', { class: 'key-keys t-data', text: row.keys.join(' · ') || '—' }));
			// One row speaks at a time: the capture in progress, else the swap
			// that just happened, else nothing.
			const note = h('span', {
				class: 'key-note t-data',
				text: this._capture === row.id ? CAPTURE_PROMPT
					: this._swapNotice?.id === row.id ? `SWAPPED WITH ${this._swapNotice.label}`
						: '',
			});
			line.appendChild(note);
			const rebindBtn = button('REBIND', () => this.startCapture(row.id), 'terminal-cta key-rebind');
			line.appendChild(rebindBtn);
			box.appendChild(line);
			this._keyRows.set(row.id, { line, note, rebind: rebindBtn });
		}
	}

	// A row speaks WITHOUT the list being rebuilt. Not an optimisation: a
	// rebuild would take the just-clicked button out of the document, focus
	// would fall back to the page body, and the capture listener — which sits
	// on the panel — would never see the next key.
	setRowNote(actionId, text) {
		const row = this._keyRows?.get(actionId);
		if (row) row.note.textContent = text;
	}

	// The next key belongs to the panel. The listener sits on the panel in the
	// CAPTURE phase, so it runs before input.js (window, bubble phase), and
	// stopPropagation() guarantees the captured key flies nothing and closes
	// nothing.
	startCapture(actionId) {
		if (this._swapNotice) { this.setRowNote(this._swapNotice.id, ''); this.clearSwapNotice(); }
		// Arming a second row disarms the first: two rows both asking for a key
		// would be a lie, since only one of them can get it.
		if (this._capture && this._capture !== actionId) this.setRowNote(this._capture, '');
		this._capture = actionId;
		if (!this._captureKey) {
			this._captureKey = (ev) => this.onCaptureKey(ev);
			this.el.settings.addEventListener('keydown', this._captureKey, true);
			// Clicking anywhere else gives up: an armed row left behind would go
			// on swallowing keystrokes from a panel that looks idle.
			this._capturePointer = (ev) => this.onCapturePointer(ev);
			this.el.settings.addEventListener('pointerdown', this._capturePointer, true);
		}
		this.setRowNote(actionId, CAPTURE_PROMPT);
		// The listener is on the PANEL: the key only reaches it while focus is
		// inside. A click does not grant that everywhere (Safari does not focus
		// clicked buttons), so it is set explicitly.
		this._keyRows?.get(actionId)?.rebind.focus?.();
	}

	// Drops the swap notice AND its timer. Left alone, the timer would fire on
	// a closed panel — or on a list rebuilt by RESET KEYS — and blank a row it
	// no longer owns.
	clearSwapNotice() {
		if (this._swapTimer) clearTimeout(this._swapTimer);
		this._swapTimer = 0;
		this._swapNotice = null;
	}

	endCapture() {
		if (this._captureKey) {
			this.el.settings.removeEventListener('keydown', this._captureKey, true);
			this._captureKey = null;
		}
		if (this._capturePointer) {
			this.el.settings.removeEventListener('pointerdown', this._capturePointer, true);
			this._capturePointer = null;
		}
		this._capture = null;
	}

	// A pointer landing outside the armed row cancels. The row's own REBIND is
	// exempt: its click handler re-arms the same row, and cancelling first
	// would make the second press look inert.
	onCapturePointer(ev) {
		if (!this._capture) return;
		const row = this._keyRows?.get(this._capture)?.line;
		const target = ev.target;
		if (row && target && (row === target || row.contains?.(target))) return;
		const actionId = this._capture;
		this.endCapture();
		this.setRowNote(actionId, '');
	}

	onCaptureKey(ev) {
		if (!this._capture) return;
		ev.stopPropagation?.();
		ev.preventDefault?.();
		const actionId = this._capture;
		this.endCapture();
		// Escape cancels, and so does Tab: those two close the panel, so they
		// can never become flight keys (D13).
		const key = String(ev.key ?? '');
		if (key === 'Escape' || key === 'Tab') { this.setRowNote(actionId, ''); return; }

		const { map, swappedWith } = rebind(this.input.getKeyMap(), actionId, key);
		this.input.setKeyMap(map);
		try { localStorage.setItem(KEY_MAP_STORAGE, JSON.stringify(map)); } catch { }
		if (swappedWith) {
			const label = KEY_ACTIONS.find((a) => a.id === swappedWith)?.label ?? swappedWith;
			this._swapNotice = { id: actionId, label };
			if (this._swapTimer) clearTimeout(this._swapTimer);
			this._swapTimer = setTimeout(() => {
				this._swapTimer = 0;
				this._swapNotice = null;
				this.setRowNote(actionId, '');
			}, SWAP_NOTICE_MS);
			// Node keeps the process alive for a pending timer; a selftest must
			// not wait two seconds to exit. No-op in a browser.
			this._swapTimer?.unref?.();
		}
		this.renderKeyboard();
		// Focus returns to the button just used, so arrow navigation (menu-nav)
		// carries on where it was.
		this._keyRows.get(actionId)?.rebind.focus?.();
	}

	resetKeys() {
		this.endCapture();
		this.clearSwapNotice();
		const map = this.input.setKeyMap(loadKeyMap(null));
		try { localStorage.setItem(KEY_MAP_STORAGE, JSON.stringify(map)); } catch { }
		this.renderKeyboard();
	}

	// ---------------------------------------------------------------------------
	// SYSTEM TAB
	// ---------------------------------------------------------------------------

	// The briefing button exists only when there is a briefing to replay, which
	// is why this is redrawn on every visit rather than once at construction:
	// main.js fills the slot long after the panel is built.
	//
	// It is also hidden in flight: the panel is reachable with TAB while flying,
	// and the briefing mounts full terminal screens — over a running session,
	// that is a way out of the flight, not a setting.
	renderSystem() {
		const row = this.el?.replayRow ?? this._sections.system.querySelector('[id="replay-row"]');
		row.replaceChildren();
		if (this.onReplayBriefing && !this.flightActive) {
			row.appendChild(button('REPLAY BRIEFING', () => this.onReplayBriefing?.(), 'terminal-cta'));
		}
	}

	hydrate() {
		const noop = () => { };
		this.setAudio(loadVolume(), loadBrightness(), loadMusicVolume(), noop);
	}

	// All three audio settings are worth remembering across reloads: nobody
	// wants the sim to come back at full blast every time, where "bright enough
	// but not tiring" sits depends on the headphones, and how much music you
	// want under the motors is a matter of taste. Same localStorage shape as
	// the gamepad map in input.js.
	setAudio(volume, brightness, musicVolume, onChange) {
		const emit = () => {
			const vol = Number(this.el.vol.value);
			const tone = Number(this.el.tone.value);
			const mus = Number(this.el.music.value);
			this.el.volVal.textContent = vol;
			// Signed, because what the slider does is move away from the tuning
			// the spectrum was measured at, in both directions.
			this.el.toneVal.textContent = tone === 50 ? 'neutre' : (tone > 50 ? '+' : '') + (tone - 50);
			this.el.musicVal.textContent = mus;
			try {
				localStorage.setItem(VOLUME_KEY, String(vol));
				localStorage.setItem(BRIGHTNESS_KEY, String(tone));
				localStorage.setItem(MUSIC_KEY, String(mus));
			} catch { }
			onChange(vol / 100, tone / 100, mus / 100);
		};
		this.el.vol.value = Math.round(volume * 100);
		this.el.tone.value = Math.round(brightness * 100);
		this.el.music.value = Math.round(musicVolume * 100);
		this.el.vol.oninput = emit;
		this.el.tone.oninput = emit;
		this.el.music.oninput = emit;
		emit();
	}

	// The view-distance slider of ?live= mode (#182). The row stays
	// hidden outside live mode (the window radius does not exist for a pre-baked
	// scene): it is THIS call, made by bootLive(), that reveals it.
	// The readout follows the finger (oninput) but the callback only fires on
	// release (onchange): every notch triggers traverse() + a wave of fetches to
	// kh.google.com — not during a drag.
	setViewRange(meters, onChange) {
		this.el.viewRangeRow.hidden = false;
		const show = () => { this.el.viewRangeVal.textContent = this.el.viewRange.value; };
		const commit = () => {
			const m = Number(this.el.viewRange.value);
			show();
			try { localStorage.setItem(VIEW_RANGE_KEY, String(m)); } catch { }
			onChange(m);
		};
		this.el.viewRange.value = meters;
		this.el.viewRange.oninput = show;
		this.el.viewRange.onchange = commit;
		commit();
	}

	toggleSettings(force) {
		const show = force ?? this.el.settings.hidden;
		this.el.settings.hidden = !show;
		// Closing the panel abandons a measurement in progress, and nothing is
		// written: a half-finished calibration must not survive a closed panel,
		// and its rAF loop must not keep running behind it.
		//
		// So Escape closes the panel, as it does everywhere else — it does not
		// cancel "just the wizard". That is also what happened in fact: Escape is
		// handled TWICE (main.js and menu-nav's `back`), and a guard that
		// cancelled on the first pass let the second one close anyway.
		if (!show && this._cal) this.cancelCalibration();
		// A key capture does not survive a closed panel either: its listener
		// would linger, and the next keystroke would be swallowed.
		if (!show) { this.endCapture(); this.clearSwapNotice(); }
		if (show) {
			this.selectTab(activeTab);
			this.buildAxisRows();
			// Keyboard + gamepad navigation (issue #123): ↑/↓ moves between the
			// rows, ←/→ adjusts the focused control (menu-nav.js knows which ones
			// are adjustable), Escape / B closes. Attached on open only: in
			// flight, with the panel closed, the arrows stay flight commands.
			this._nav ??= menuNav(this.el.settings, {
				back: () => this.toggleSettings(false),
				gamepad: !this.flightActive,
			});
		} else {
			this._nav?.detach();
			this._nav = null;
			// Panel closed: the machine's loop stops with it, like the wizard's.
			this.unmountCalDrone();
			// A caller that WAITS on the close (the root menu, D6) gets the hand
			// back here. Cleared before the call: the panel promises one close.
			const closed = this._onClosed;
			this._onClosed = null;
			closed?.();
		}
	}

	// Resolves the next time the panel closes. The root menu opens SETTINGS and
	// waits on this before drawing SELECT OPERATION MODE again.
	closed() { return new Promise((r) => { this._onClosed = r; }); }

	get settingsOpen() { return !this.el.settings.hidden; }

	// One row per channel: pick which axis drives it and whether to invert.
	// Live bars next to each let you see which physical stick is which.
	// What the browser enumerates, as-is: id, axis count, button count, and the
	// class padKind() derives from them — that class decides the default
	// mapping, so it is the one thing you must be able to READ when "it does not
	// work" (issue #162). A click designates the active device, which matters as
	// soon as two are plugged in.
	//
	// A note that helps diagnosis: the Gamepad API only exposes a device after
	// the user has acted ON it. An empty list therefore does not mean "not
	// recognised", it can mean "not touched yet" — and the text says so, rather
	// than leaving people to conclude.
	// ---------------------------------------------------------------------------
	// CALIBRATION WIZARD (issue #277)
	//
	// The panel decides nothing: src/calibration.js holds the state machine and
	// says which instruction to show. Here it is handed a frame and a dt, and
	// what it returns is painted.
	// ---------------------------------------------------------------------------

	startCalibration() {
		const pad = this.input.getGamepad();
		if (!pad) return;
		this._calPadId = pad.id;
		// Axes AND buttons: on a radio the browser maps as "standard", throttle
		// comes out on a trigger (#279).
		this._cal = beginCalibration(padSignals(pad).length, pad.axes.length);
		this._calLast = performance.now();
		this.el.calSummary.hidden = true;
		this.renderCalibration(pad);

		// The wizard runs on ITS OWN loop, not on the flight's:
		// renderer.setAnimationLoop(frame) only starts at take-off, and the Tab
		// panel also opens from the terminal, before boot(). Without this loop
		// the wizard would sit frozen on its first instruction — that
		// is, broken, in exactly the place a pilot for whom "it does not work"
		// goes looking for it.
		const tick = () => {
			if (!this._cal) { this._calRaf = null; return; }
			this._calRaf = requestAnimationFrame(tick);
			const p = this.input.getGamepad();
			if (p) this.stepCalibration(p);
		};
		this._calRaf = requestAnimationFrame(tick);
	}

	cancelCalibration() {
		// Nothing is written: an abandoned calibration leaves the device exactly
		// as it was.
		this.stopCalibration();
		this.renderCalibration(this.input.getGamepad());
	}

	stopCalibration() {
		if (this._calRaf !== null) cancelAnimationFrame(this._calRaf);
		this._calRaf = null;
		this._cal = null;
		this._calPadId = null;
	}

	// ---------------------------------------------------------------------------
	// THE MACHINE THAT ANSWERS THE STICK (issue #281)
	//
	// The calibration measured correctly and showed nothing: the pilot pushed a
	// stick and saw only a bar. It lives for as long as the panel is
	// open and there is something to show — a measurement in progress, or an
	// already calibrated device, and then it is a test bench.
	// ---------------------------------------------------------------------------

	// What the machine must reflect on this frame, or null for the resting pose.
	// No clock here: calibration-drone.js holds its own.
	calDroneSample() {
		const pad = this.input.getGamepad();
		if (!pad) return null;
		const signals = padSignals(pad);
		if (this._cal) return { state: this._cal, signals };

		// Measurement finished: the pose comes from the written calibration, by
		// the same path as the flight. `phase: 'done'` is all calibrationPose()
		// reads.
		const cal = this.input.calibration;
		if (!cal) return null;
		return { state: { phase: 'done', channels: cal.channels, deadband: cal.deadband }, signals };
	}

	syncCalDrone() {
		const show = this.settingsOpen
			&& this.input.gamepadIndex !== null
			&& (this._cal !== null || this.input.isCalibrated());
		if (show) this.mountCalDrone(); else this.unmountCalDrone();
	}

	mountCalDrone() {
		if (this._calDrone) return;
		this._calDrone = calibrationDrone({ sample: () => this.calDroneSample() });
		this.el.calDrone.appendChild(this._calDrone.el);
		this.el.calDrone.hidden = false;
	}

	unmountCalDrone() {
		if (!this._calDrone) return;
		this._calDrone.stop();
		this._calDrone.el.remove();
		this._calDrone = null;
		this.el.calDrone.hidden = true;
	}

	// One measurement frame. The dt comes from here and not from main.js: the
	// machine reasons in real milliseconds, and updateAxisBars() is given none.
	stepCalibration(pad) {
		const now = performance.now();
		// A backgrounded tab returns an enormous dt; clamping it avoids
		// validating an instruction nobody actually held.
		const dt = Math.min(100, now - this._calLast);
		this._calLast = now;

		this._cal = feedSample(this._cal, padSignals(pad), dt);

		const result = calibrationResult(this._cal);
		if (result) {
			this.input.setCalibration(this._calPadId, result);
			// stopCalibration() efface _calPadId : la persistance passe AVANT.
			this.el.calSummary.textContent = '';
			for (const line of calSummaryLines(result)) {
				const div = document.createElement('div');
				div.textContent = line;
				this.el.calSummary.appendChild(div);
			}
			this.el.calSummary.hidden = false;
			this.stopCalibration();
			// The mapping has just changed under the axis rows: they are rebuilt,
			// they are not refreshed.
			this._axisRows = [];
		}
		this.renderCalibration(pad);
	}

	renderCalibration(pad) {
		const running = this._cal !== null;
		this.syncCalDrone();
		this.el.calScreen.hidden = !running;
		this.el.calCancelRow.hidden = !running;
		this.el.calRow.hidden = running;
		this.el.padMap.hidden = running;
		this.el.padList.hidden = running;

		if (!running) {
			// The instruction must not survive the measurement: otherwise
			// reopening the panel would flash the last instruction of a finished
			// calibration.
			this.el.calStep.textContent = '';
			this.el.calPrompt.textContent = '';
			this.el.calHint.textContent = '';
			this.el.calMessage.textContent = '';
			const calibrated = this.input.isCalibrated();
			this.el.calButton.disabled = this.input.gamepadIndex === null;
			this.el.calNote.textContent = this.el.calButton.disabled ? ''
				: calibrated ? 'this device is calibrated'
					: 'never calibrated — measured neutral, travel and throttle mode, about 20 s';
			return;
		}

		const { step, total } = calProgress(this._cal);
		this.el.calStep.textContent = `STEP ${step}/${total}`;
		this.el.calPrompt.textContent = this._cal.prompt;
		this.el.calHint.textContent = this._cal.hint;
		this.el.calMessage.textContent = this._cal.message ?? '';

		// The bar follows the axis furthest from its neutral: during an
		// instruction that is the one the pilot is pushing. For as long as the
		// neutral is not measured, it follows the axis furthest from zero.
		const signals = pad ? padSignals(pad) : [];
		const centers = this._cal.centers;
		let best = 0;
		for (let i = 0; i < signals.length; i++) {
			const d = Math.abs(signals[i] - (centers?.[i] ?? 0));
			if (d > Math.abs(signals[best] - (centers?.[best] ?? 0))) best = i;
		}
		this.el.calBar.style.left = `${(((signals[best] ?? 0) + 1) / 2) * 100}%`;
	}

	buildPadList() {
		const pads = this.input.listGamepads();
		const box = this.el.padList;
		// updateAxisBars() calls buildAxisRows() again every frame for as long as
		// no row could be built (gamepad not announced yet). Without this
		// signature the list would rebuild sixty times a second and a click would
		// land on a button that has already been replaced.
		const sig = `${this.input.gamepadIndex}|${pads.map((g) => `${g.index}:${g.id}:${g.axes}:${g.buttons}`).join('|')}`;
		if (sig === this._padListSig) return;
		this._padListSig = sig;
		box.replaceChildren();
		// What is shown is decided by padListEntries() (input.js, pure and
		// tested); here we only paint it and make it clickable.
		const entries = padListEntries(pads, this.input.gamepadIndex);
		if (!entries.length) {
			const p = document.createElement('p');
			p.textContent = PAD_LIST_EMPTY;
			box.appendChild(p);
			return;
		}
		for (const g of entries) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pad-entry';
			if (g.active) b.dataset.active = '1';
			b.textContent = g.label;
			b.onclick = () => {
				this.input.selectGamepad(g.index);
				// The default mapping changes with the device class: the axis rows
				// must be rebuilt, not refreshed.
				this._axisRows = [];
				this._padListSig = null;
				this.buildAxisRows();
			};
			box.appendChild(b);
		}
	}

	buildAxisRows() {
		this.buildPadList();
		const pad = this.input.getGamepad();
		this.el.padName.textContent = pad ? `${pad.id} — ${padKind(pad.id)}` : 'NO CONTROLLER DETECTED';
		this.renderCalibration(pad);
		if (!pad) { this.el.padMap.replaceChildren(); this._axisRows = []; return; }

		this.el.padMap.replaceChildren();
		this._axisRows = CHANNELS.map((ch) => {
			// Buttons are offered like axes: a manual remap must be able to point
			// at the trigger where the browser filed the throttle.
			const sel = h('select');
			padSignals(pad).forEach((_, i) => {
				sel.appendChild(h('option', { value: String(i), text: signalLabel(i, pad.axes.length) }));
			});
			const inv = h('input', { type: 'checkbox' });
			const tr = h('tr', {}, [
				h('td', { text: ch }),
				h('td', {}, [sel]),
				h('td', {}, [h('label', {}, [inv, h('span', { text: ' inv' })])]),
				h('td', {}, [h('div', { class: 'axisbar' }, [h('i')])]),
			]);
			sel.value = String(this.input.map[ch].axis);
			inv.checked = this.input.map[ch].invert;
			const save = () => this.input.setMapping(ch, Number(sel.value), inv.checked);
			sel.onchange = save;
			inv.onchange = save;
			this.el.padMap.appendChild(tr);
			return { ch, sel, fill: tr.querySelector('.axisbar i') };
		});
	}

	updateAxisBars() {
		if (!this.settingsOpen) return;

		// A measurement in progress has its own loop (startCalibration) and hides
		// the remap rows: there is nothing to refresh here.
		if (this._cal) return;

		// The gamepad may have announced itself after the panel opened
		// (e.g. gamepadconnected not yet raised by the browser at the moment
		// of the first buildAxisRows()): it is retried for as long as no row has
		// been built rather than staying stuck on "no controller detected".
		if (this._axisRows.length === 0) { this.buildAxisRows(); return; }
		const pad = this.input.getGamepad();
		if (!pad) return;
		for (const row of this._axisRows) {
			const v = padSignals(pad)[Number(row.sel.value)] ?? 0;
			row.fill.style.left = `${((v + 1) / 2) * 100}%`;
		}
	}
}
