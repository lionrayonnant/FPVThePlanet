// Operator bootstrapping (PHASE 01, Bible §12-14).
// Full-frame screens mounted by APPEND into #ui — never innerHTML, the HUD has
// already filled that container. All visible text is English (D5).
import * as operatorApi from './operator.js';
import { menuNav, blockNav } from './menu-nav.js';
import { uiAudio } from './ui-audio.js';
import { reducedMotion, STEP_MS } from './motion.js';
import { mountScreen, screenButton } from './screen.js';
import { versionLine } from './version.js';
import { browserBrand } from '../tools/readiness-model.mjs';


// ---------- honest inventory (arch doc §4) ----------

async function measureRefreshHz() {
	// requestAnimationFrame is frozen in a hidden tab: the measurement races a
	// timeout that resolves null (the row already prints UNKNOWN for null).
	return new Promise((resolve) => {
		const done = (v) => resolve(v);
		setTimeout(() => done(null), 2000);
		const t = [];
		const tick = (now) => {
			t.push(now);
			if (t.length < 60) return requestAnimationFrame(tick);
			const deltas = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
			const median = deltas[deltas.length >> 1];
			done(median > 0 ? Math.round(1000 / median) : null);
		};
		requestAnimationFrame(tick);
	});
}

function gpuString() {
	try {
		const gl = document.createElement('canvas').getContext('webgl2')
			|| document.createElement('canvas').getContext('webgl');
		if (!gl) return { renderer: 'NONE', gpu: 'UNKNOWN' };
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
		const isGl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
		return { renderer: isGl2 ? 'WEBGL2' : 'WEBGL1', gpu: gpu || 'UNKNOWN' };
	} catch { return { renderer: 'UNKNOWN', gpu: 'UNKNOWN' }; }
}

function audioString() {
	try {
		const Ctx = window.AudioContext || window.webkitAudioContext;
		const ac = new Ctx();
		const s = `${ac.sampleRate} HZ / ${ac.destination.maxChannelCount} CH`;
		ac.close();
		return s;
	} catch { return 'UNKNOWN'; }
}

async function storageString() {
	try {
		const { quota } = await navigator.storage.estimate();
		return quota ? `${(quota / 1e9).toFixed(1)} GB QUOTA` : 'UNKNOWN';
	} catch { return 'UNKNOWN'; }
}

async function terrainCacheString() {
	try {
		const r = await fetch('/__map-api/scenes');
		const { scenes } = await r.json();
		return scenes.length ? `${scenes.length} AREAS` : 'EMPTY';
	} catch { return 'UNKNOWN'; }
}

export async function probeHardware() {
	const ua = navigator.userAgentData;
	const platform = (ua?.platform || navigator.platform || 'UNKNOWN').toUpperCase();
	// Same extraction as the RECOMMENDED SETUP screen, which is where it now
	// lives: two copies of it would drift the day a brand is added.
	const brand = browserBrand(ua, navigator.userAgent);
	const hz = await measureRefreshHz();
	const { renderer, gpu } = gpuString();
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	return [
		{ label: 'PLATFORM', value: platform },
		{ label: 'BROWSER', value: String(brand).toUpperCase() },
		{ label: 'LANGUAGE', value: (navigator.language || 'UNKNOWN').toUpperCase() },
		{ label: 'TIMEZONE', value: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UNKNOWN').toUpperCase() },
		// Explicit window.screen: `screen` is shadowed by this module's screen().
		// A scaled display produces a ratio like 0.8999999761581421, which wrapped
		// and broke the column. A readout is read, not poured out: two decimals,
		// and no trailing zero.
		{ label: 'DISPLAY', value: `${window.screen.width} × ${window.screen.height} @ ${(+window.devicePixelRatio.toFixed(2))}x` },
		{ label: 'REFRESH', value: hz ? `${hz} HZ` : 'UNKNOWN' },
		{ label: 'RENDERER', value: renderer },
		{ label: 'GPU', value: String(gpu).toUpperCase() },
		{ label: 'CORES', value: String(navigator.hardwareConcurrency || 'UNKNOWN') },
		{ label: 'INPUT', value: pad ? `${pad.id.slice(0, 32).toUpperCase()} / ${pad.axes.length} AXES` : 'NO GAMEPAD' },
		{ label: 'AUDIO', value: audioString() },
		{ label: 'NETWORK', value: navigator.onLine ? 'ONLINE' : 'OFFLINE' },
		{ label: 'STORAGE', value: await storageString() },
		{ label: 'TERRAIN CACHE', value: await terrainCacheString() },
	];
}

// Crew remarks: wired to what was found, 2 to 4 per run.
// PHASE 21: this screen runs before the operator is loaded, hence before the
// dialogue engine's memory exists — mounting it here would freeze that memory
// empty for the whole tab. These lines are hardcoded on purpose; do not wire
// them to the dialogue engine.
function crewNotes(rows) {
	const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	const out = [];
	const hz = parseInt(by.REFRESH, 10);
	if (hz >= 120) out.push('// root: ' + hz + 'hz', '// mikhail: acceptable');
	else if (hz) out.push('// root: ' + hz + 'hz', '// mikhail: we make do');
	if (by.INPUT === 'NO GAMEPAD') out.push('// root: no radio', '// mikhail: keyboard then');
	else out.push('// root: radio detected', '// cron: good');
	if (by.NETWORK === 'OFFLINE') out.push('// root: offline', '// cron: cache only');
	return out.slice(0, 4);
}

// ---------- screen mounting ----------

// The bootstrap chain mounts the SAME screen as the terminal (screen.js): it
// used to mount a copy that had never gained `close()`, and stayed the only
// place in the game whose screens left in one hard cut.
function screen(root) {
	return mountScreen(root);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exported for src/briefing.js (D16): the briefing prints like the bootstrap
// because it is the same machine speaking, not an online help page.
// Reduced motion: the lines are laid down in one block. Same rule as everywhere
// (motion.js) — jump to the final state rather than print more slowly. Without
// it, the first launch AND the briefing stayed the only two screens that
// animated when the system asks for the opposite.
export async function revealLines(box, lines, { interval = STEP_MS } = {}) {
	const pre = document.createElement('pre');
	box.appendChild(pre);
	if (reducedMotion()) {
		pre.textContent = lines.join('\n');
		return pre;
	}
	let skipped = false;
	const skip = () => { skipped = true; };
	window.addEventListener('keydown', skip, { once: true });
	box.addEventListener('click', skip, { once: true });
	for (const line of lines) {
		pre.textContent += (pre.textContent ? '\n' : '') + line;
		if (!skipped) await sleep(interval);
	}
	if (skipped) pre.textContent = lines.join('\n');
	window.removeEventListener('keydown', skip);
	return pre;
}

export function dotted(label, value, width = 20) {
	return `${label} ${'.'.repeat(Math.max(3, width - label.length))} ${value}`;
}

// ---------- screen 1: HARDWARE DISCOVERY ----------

async function hardwareScreen(root) {
	const s = screen(root);
	const rows = await probeHardware();
	const notes = crewNotes(rows);
	const lines = [versionLine(), '', 'OPERATOR BOOTSTRAPPING', ''];
	rows.forEach((r, i) => {
		lines.push(dotted(r.label, r.value));
		if (i === 5 && notes[0]) lines.push(notes[0], notes[1] ?? '');
		if (i === 9 && notes[2]) lines.push(notes[2], notes[3] ?? '');
	});
	// `…`, not three ASCII dots. Every other wait in the game is written with
	// the ellipsis character, and this is the very first screen an operator sees.
	lines.push('', 'INITIALIZATION…');
	await revealLines(s.box, lines.filter((l) => l !== undefined));
	await new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		s.box.appendChild(button('CONTINUE', close));
		const nav = menuNav(s.el, {});
	});
}

const button = (label, onClick) => screenButton(label, onClick, 'bootstrap-btn');

// ---------- screen 2: OPERATOR NAME ----------

async function nameScreen(root, api) {
	const s = screen(root);
	// Built with createElement rather than innerHTML, like the rest of the
	// house: same tree, no HTML parser, and mountable on the fake DOM.
	const title = document.createElement('pre');
	title.textContent = 'OPERATOR NAME';
	const input = document.createElement('input');
	input.id = 'op-name';
	input.maxLength = 24;
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.placeholder = 'NEO';
	const err = document.createElement('div');
	err.className = 'bootstrap-err';
	err.id = 'op-name-err';
	s.box.append(title, input, err);
	input.focus();
	return new Promise((resolve) => {
		const submit = async () => {
			err.textContent = '';
			try {
				const state = await api.createOperator(input.value);
				nav.detach();
				s.remove();
				resolve(state);
			} catch (e) {
				err.textContent = e.message;
			}
		};
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		s.box.appendChild(button('REGISTER', submit));
		// The field keeps its focus and its keys (menu-nav ignores text entry);
		// the gamepad can move down to REGISTER and press A. The name itself is
		// typed — the only moment in the game that needs a keyboard.
		const nav = menuNav(s.el, { focusFirst: false });
	});
}

// ---------- the full sequence ----------

// `briefing` (D16): what main.js does right after registration. Injected rather
// than imported — the bootstrap needs neither the gamepad, nor the settings
// panel, nor the localStorage the briefing marks, so it must not depend on the
// module that knows them.
export async function bootstrap(root, api = operatorApi, { briefing = null } = {}) {
	await hardwareScreen(root);
	await nameScreen(root, api);
	// The CONTROL VECTOR used to be set here, over two further screens (#33). It
	// asked the player to memorise a sequence of arrows outside the game and
	// punished forgetting it with a total lockout at every acquisition. The
	// bootstrap therefore goes from four screens to two before the briefing.
	await flushOrRetry(root, api);
	// The operator exists: this is the only moment the briefing makes sense. An
	// error here must not stop anyone from entering the game.
	if (briefing) { try { await briefing(); } catch (e) { console.warn('[briefing]', e); } }
	return api.getOperator();
}

// flush() throws if nothing could be written: show the error on the current
// screen with a RETRY button rather than enter the game on a profile the server
// does not have. Since #33 it is the NAME it protects, the only part of the
// bootstrap that has to survive a reload.
async function flushOrRetry(root, api) {
	while (true) {
		try { await api.flush(); return; }
		catch {
			uiAudio.play('ERROR');
			const s = screen(root);
			const ok = await new Promise((resolve) => {
				const retry = () => { nav.detach(); s.remove(); resolve(true); };
				const line = document.createElement('pre');
				line.textContent = 'PROFILE NOT SAVED — RETRY';
				s.box.appendChild(line);
				s.box.appendChild(button('RETRY', retry));
				const nav = menuNav(s.el, {});
			});
			if (!ok) return;
		}
	}
}
