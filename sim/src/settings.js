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
// Ce défaut EST la balance musique/moteur, et c'est le seul endroit où elle
// vit : audio-bus.js n'applique plus de trim par-dessus (il en avait un, à 0.7
// lui aussi, ce qui atténuait deux fois — corrigé). 0.7 est la valeur mesurée à
// la première écoute en vol.
//
// Réglage SÉPARÉ du volume global, pour qu'on puisse baisser la musique sans
// baisser le moteur : le vol reste un exercice d'écoute de la machine.
export const loadMusicVolume = () => loadPercent(MUSIC_KEY, 0.7);

// Distance d'affichage du mode ?live= (#182), en MÈTRES — pas un pourcentage,
// donc pas loadPercent(). Bornes du curseur : 100-600 m. Le coût est
// QUADRATIQUE en rayon (nœuds ∝ r², mesuré : 200 m ≈ 1032 meshes) — 600 m
// ≈ ×9, c'est le GPU et kh.google.com de l'utilisateur, son choix. Défaut
// 300 m : choisi par l'utilisateur à la première écoute du curseur.
export const VIEW_RANGE_MIN_M = 100;
export const VIEW_RANGE_MAX_M = 2000;
export function loadViewRange() {
	try {
		const raw = localStorage.getItem(VIEW_RANGE_KEY);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= VIEW_RANGE_MIN_M && saved <= VIEW_RANGE_MAX_M) return saved;
	} catch { }
	// 600 m, pas 300 (#32) : depuis les anneaux de LOD prolongés, doubler la
	// portée coûte 2 fps et ~180 Mo de textures (mesuré à Paris, 740 -> 1003
	// nœuds). Un défaut à 300 m faisait s'arrêter le monde juste derrière le
	// drone, ce qui se voit dès qu'on se retourne. Le curseur monte à 2 km.
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

// La météo n'est plus ici (PHASE 04, Bible §31). Le vent, la pluie et le
// brouillard appartiennent au monde et à la session : ils viennent du world
// state de l'opérateur via src/weather.js, et aucun réglage utilisateur ne
// permet plus de choisir le temps qu'il fait. Les modèles wind.js / rain.js /
// fog.js n'ont pas bougé — seule la main qui écrit leurs paramètres a changé.
// window.__sim.setWeather / setRain / setFog restent l'accès de debug.

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
const CAPTURE_PROMPT = 'PRESS A KEY — ESC CANCELS';

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
// Issue #120 : caméra, objectif et lien vidéo n'étaient pas des réglages
// destinés au joueur — ils restent pilotés par leurs valeurs stockées
// (loadLens/loadLink, cf. main.js) mais ont quitté ce panneau.
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
		// État de l'assistant de calibrage, ou null. C'est la seule chose qui
		// distingue le panneau ouvert du panneau en train de mesurer.
		this._cal = null;
		this._calPadId = null;
		this._calLast = 0;
		this._calRaf = null;
		this.el.calButton.onclick = () => this.startCalibration();
		el.querySelector('[id="cal-cancel"]').onclick = () => this.cancelCalibration();
		// Posé à vrai par main.js quand un vol démarre : le panneau ouvert en vol
		// n'écoute pas la manette (les sticks pilotent le drone — issue #123).
		this.flightActive = false;
		this._axisRows = [];
		this.selectTab(activeTab);
		// Populate every control from storage now, with inert callbacks, so the
		// panel reads correctly when opened from the terminal before boot(). boot()
		// calls the same setters again with live callbacks — every setter re-reads
		// and re-emits, so the second pass is idempotent.
		this.hydrate();
	}

	// ---------------------------------------------------------------------------
	// THE FOUR BODIES
	// ---------------------------------------------------------------------------

	// CONTROLLER — the device list, the calibration wizard and the channel map,
	// moved here whole. Every id is the one startCalibration/renderCalibration
	// already write to: this tab changed address, not behaviour.
	buildController(box) {
		box.appendChild(h('p', { id: 'pad-name', text: 'no controller detected' }));
		// What the BROWSER sees, and the choice when it sees several (issue
		// #162). Without this list a misclassified radio — or one simply absent
		// from the enumeration — left the pilot with no recourse at all.
		box.appendChild(h('div', { id: 'pad-list', class: 'spec' }));
		// Measured calibration (issue #277). The button is always there; the
		// note beside it only ever speaks of a device that was NEVER calibrated.
		box.appendChild(h('div', { id: 'cal-row' }, [
			h('button', { id: 'calibrate', type: 'button', text: 'Calibrate' }),
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
			h('button', { id: 'cal-cancel', type: 'button', text: 'Cancel' }),
		]));
		box.appendChild(h('div', { id: 'cal-summary', class: 'spec', hidden: true }));
		box.appendChild(h('table', { id: 'pad-map' }));
	}

	// KEYBOARD — one row per action (D13). The rows are rebuilt from the map
	// rather than patched: the map is the truth, the tab is a view of it.
	buildKeyboard(box) {
		box.appendChild(h('div', { id: 'key-rows', class: 'key-rows' }));
		box.appendChild(button('RESET KEYS', () => this.resetKeys(), 'terminal-cta'));
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
		// Pas de confirm() de navigateur (§44, issue #213) : le bouton se
		// réétiquette et la DEUXIÈME pression est la confirmation.
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

	// Curseur de distance d'affichage du mode ?live= (#182). La ligne reste
	// cachée hors mode live (le rayon de fenêtre n'existe pas pour une scène
	// pré-cuite) : c'est CET appel, fait par bootLive(), qui la révèle.
	// L'affichage suit le doigt (oninput) mais le callback ne part qu'au
	// relâchement (onchange) : chaque cran déclenche traverse() + une vague de
	// fetchs vers kh.google.com — pas pendant un glissement.
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
		// Fermer le panneau abandonne une mesure en cours, et rien n'est écrit :
		// un calibrage à moitié fait ne doit pas survivre à un panneau fermé, et
		// sa boucle rAF ne doit pas continuer à tourner derrière.
		//
		// Échap ferme donc le panneau, comme partout ailleurs — il n'annule pas
		// « juste l'assistant ». C'est aussi ce qui arrivait de fait : Échap est
		// traité DEUX fois (main.js et le `back` de menu-nav), et une garde qui
		// annulait au premier passage laissait le second fermer quand même.
		if (!show && this._cal) this.cancelCalibration();
		// A key capture does not survive a closed panel either: its listener
		// would linger, and the next keystroke would be swallowed.
		if (!show) { this.endCapture(); this.clearSwapNotice(); }
		if (show) {
			this.selectTab(activeTab);
			this.buildAxisRows();
			// Navigation clavier + manette (issue #123) : ↑/↓ circule entre les
			// lignes, ←/→ règle le contrôle focalisé (menu-nav.js sait lesquels
			// sont réglables), Échap / B referme. Attaché à l'ouverture seulement :
			// en vol, panneau fermé, les flèches restent des commandes.
			this._nav ??= menuNav(this.el.settings, {
				back: () => this.toggleSettings(false),
				gamepad: !this.flightActive,
			});
		} else {
			this._nav?.detach();
			this._nav = null;
			// Panneau fermé : la boucle de la machine s'arrête avec lui, comme
			// celle de l'assistant.
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
	// Ce que le navigateur énumère, tel quel : identifiant, nombre d'axes,
	// nombre de boutons, et la classe que padKind() en déduit — c'est elle qui
	// décide du mappage par défaut, donc c'est elle qu'il faut pouvoir LIRE
	// quand « ça ne marche pas » (issue #162). Un clic désigne le périphérique
	// actif, ce qui compte dès qu'il y en a deux branchés.
	//
	// Rappel utile au diagnostic : l'API Gamepad n'expose un périphérique
	// qu'après une action de l'utilisateur DESSUS. Une liste vide ne veut donc
	// pas dire « non reconnu », elle peut vouloir dire « pas encore touché » —
	// et le texte le dit, plutôt que de laisser conclure.
	// ---------------------------------------------------------------------------
	// ASSISTANT DE CALIBRAGE (issue #277)
	//
	// Le panneau ne décide de rien : src/calibration.js tient la machine à états
	// et dit quelle consigne afficher. Ici on lui donne une trame et un dt, et on
	// peint ce qu'elle rend.
	// ---------------------------------------------------------------------------

	startCalibration() {
		const pad = this.input.getGamepad();
		if (!pad) return;
		this._calPadId = pad.id;
		// Axes ET boutons : sur une radio que le navigateur mappe en
		// « standard », le gaz sort sur une gâchette (#279).
		this._cal = beginCalibration(padSignals(pad).length, pad.axes.length);
		this._calLast = performance.now();
		this.el.calSummary.hidden = true;
		this.renderCalibration(pad);

		// L'assistant tourne sur SA PROPRE boucle, pas sur celle du vol :
		// renderer.setAnimationLoop(frame) ne démarre qu'au décollage, et le
		// panneau Tab s'ouvre aussi depuis le terminal, avant boot(). Sans
		// cette boucle, l'assistant y resterait figé sur sa première consigne —
		// c'est-à-dire cassé, exactement là où un pilote dont « ça ne marche
		// pas » va le chercher.
		const tick = () => {
			if (!this._cal) { this._calRaf = null; return; }
			this._calRaf = requestAnimationFrame(tick);
			const p = this.input.getGamepad();
			if (p) this.stepCalibration(p);
		};
		this._calRaf = requestAnimationFrame(tick);
	}

	cancelCalibration() {
		// Rien n'est écrit : un calibrage abandonné laisse le périphérique
		// exactement comme il était.
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
	// LA MACHINE QUI RÉAGIT AU MANCHE (issue #281)
	//
	// Le calibrage mesurait juste et ne montrait rien : le pilote poussait un
	// manche et ne voyait qu'une barre. Elle vit tant que le panneau est
	// ouvert et qu'il y a quelque chose à montrer — une mesure en cours, ou un
	// périphérique déjà calibré, et c'est alors un banc d'essai.
	// ---------------------------------------------------------------------------

	// Ce que la machine doit refléter à cette frame, ou null pour la pose de
	// repos. Aucune horloge ici : calibration-drone.js tient la sienne.
	calDroneSample() {
		const pad = this.input.getGamepad();
		if (!pad) return null;
		const signals = padSignals(pad);
		if (this._cal) return { state: this._cal, signals };

		// Mesure finie : la pose vient du calibrage écrit, par le même chemin
		// que le vol. `phase: 'done'` est tout ce que calibrationPose() lit.
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

	// Une trame de mesure. Le dt vient d'ici et non de main.js : la machine
	// raisonne en millisecondes réelles, et updateAxisBars() n'en reçoit pas.
	stepCalibration(pad) {
		const now = performance.now();
		// Un onglet en arrière-plan rend un dt énorme au retour ; le borner
		// évite de valider une consigne que personne n'a tenue.
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
			// Le mappage vient de changer sous les lignes d'axes : elles se
			// reconstruisent, elles ne se rafraîchissent pas.
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
			// La consigne ne doit pas survivre à la mesure : sinon rouvrir le
			// panneau ferait clignoter la dernière consigne d'un calibrage fini.
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

		// La barre suit l'axe le plus écarté de son neutre : pendant une
		// consigne, c'est celui que le pilote est en train de pousser. Tant que
		// le neutre n'est pas mesuré, elle suit l'axe le plus écarté de zéro.
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
		// updateAxisBars() rappelle buildAxisRows() à chaque frame tant qu'aucune
		// ligne n'a pu être construite (manette pas encore annoncée). Sans cette
		// signature, la liste se reconstruirait 60 fois par seconde et un clic
		// tomberait sur un bouton déjà remplacé.
		const sig = `${this.input.gamepadIndex}|${pads.map((g) => `${g.index}:${g.id}:${g.axes}:${g.buttons}`).join('|')}`;
		if (sig === this._padListSig) return;
		this._padListSig = sig;
		box.replaceChildren();
		// Ce qu'on montre est décidé par padListEntries() (input.js, pur et
		// testé) ; ici on ne fait que le peindre et le rendre cliquable.
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
				// Le mappage par défaut change avec la classe du périphérique :
				// les lignes d'axes doivent se reconstruire, pas se rafraîchir.
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
		this.el.padName.textContent = pad ? `${pad.id} — ${padKind(pad.id)}` : 'no controller detected';
		this.renderCalibration(pad);
		if (!pad) { this.el.padMap.replaceChildren(); this._axisRows = []; return; }

		this.el.padMap.replaceChildren();
		this._axisRows = CHANNELS.map((ch) => {
			// Les boutons sont proposés comme les axes : un remap manuel doit
			// pouvoir désigner la gâchette où le navigateur a rangé le gaz.
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

		// Une mesure en cours a sa propre boucle (startCalibration) et cache les
		// lignes de remap : il n'y a rien à rafraîchir ici.
		if (this._cal) return;

		// La manette a pu se faire connaître après l'ouverture du panneau
		// (ex. gamepadconnected pas encore levé par le navigateur au moment
		// du premier buildAxisRows()) : on retente tant qu'aucune ligne n'a
		// été construite plutôt que de rester bloqué sur "no controller detected".
		if (this._axisRows.length === 0) { this.buildAxisRows(); return; }
		const pad = this.input.getGamepad();
		if (!pad) return;
		for (const row of this._axisRows) {
			const v = padSignals(pad)[Number(row.sel.value)] ?? 0;
			row.fill.style.left = `${((v + 1) / 2) * 100}%`;
		}
	}
}
