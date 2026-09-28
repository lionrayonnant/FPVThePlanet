// FIRST RUN — what a stranger sees when something goes wrong before they have
// flown anything.
//
// Everything checked here is a failure path that cannot be reproduced on the
// machine the game is written on: a browser with no WebGL2, a network that
// refuses kh.google.com, a WebAssembly chunk a proxy ate, a keyboard with no
// gamepad next to it. They used to be a black page or a dead-end error screen,
// which on launch day is the difference between someone flying and someone
// closing the tab. So they get a test rather than a hope.
//
// Covers: tools/boot-failure-model.mjs, the WebGL2 probe inlined in index.html,
// src/hud.js's way out of a failure, src/flightController.js's start mode and
// the device rule that picks it (src/input.js:startFlightMode).
//
// Run: node tools/first-run-selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	bootFailureMessage, isTerrainNetworkFailure, isPhysicsLoadFailure, terrainEmptyError,
	TERRAIN_HOST, TERRAIN_UNREACHABLE, TERRAIN_EMPTY, PHYSICS_OOM, PHYSICS_UNAVAILABLE, NO_WEBGL2,
} from './boot-failure-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM = join(HERE, '..');

let failures = 0;
function t(name, fn) {
	try { fn(); console.log(`  ok  ${name}`); }
	catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
function section(name) { console.log(`\n${name}`); }

// -----------------------------------------------------------------------------
// 1. WHAT A FAILURE SAYS
// -----------------------------------------------------------------------------

section('1. boot failure messages');

t('a blocked tile server names the cause the player can act on', () => {
	// The three spellings of one refused request, plus the status line the
	// traverse worker rethrows when the blocker answers instead of dropping.
	for (const raw of [
		'Failed to fetch',
		'NetworkError when attempting to fetch resource.',
		'Load failed',
		`403 https://${TERRAIN_HOST}/rt/earth/PlanetoidMetadata`,
		'rocktree traverse worker: Failed to fetch',
	]) {
		assert.ok(isTerrainNetworkFailure(raw), `recognised: ${raw}`);
		assert.equal(bootFailureMessage(new Error(raw)), TERRAIN_UNREACHABLE);
	}
	assert.ok(/ad blocker/i.test(TERRAIN_UNREACHABLE), 'names the usual cause');
	assert.ok(TERRAIN_UNREACHABLE.includes(TERRAIN_HOST), 'names the host to allow');
});

t('an unrelated failure is NOT dressed up as a network one', () => {
	assert.ok(!isTerrainNetworkFailure('carte inconnue: "nope"'));
	assert.equal(bootFailureMessage(new Error('unknown scene: "nope"')), 'unknown scene: "nope"');
});

t('a refused WASM chunk is told apart from an out-of-memory trap', () => {
	const load = new Error('Failed to fetch dynamically imported module: /assets/rapier3d.wasm');
	assert.ok(isPhysicsLoadFailure(load.message));
	assert.equal(bootFailureMessage(load), PHYSICS_UNAVAILABLE);
	// The trap is issue #249: an allocation that failed, not a missing file.
	assert.equal(bootFailureMessage(new WebAssembly.RuntimeError('unreachable')), PHYSICS_OOM);
	assert.notEqual(PHYSICS_UNAVAILABLE, PHYSICS_OOM);
});

t('the 45 s empty-terrain rejection reaches the screen verbatim', () => {
	const err = terrainEmptyError('12 fetches still in flight');
	assert.ok(err.userMessage, 'flagged as already written for a player');
	assert.ok(err.message.startsWith(TERRAIN_EMPTY));
	// Without the flag this would be re-classified: it mentions terrain, and a
	// generic "the tile server could not be reached" would be a lie — the
	// server answered, there is simply nothing there.
	assert.equal(bootFailureMessage(err), err.message);
	assert.ok(/45 s/.test(TERRAIN_EMPTY), 'says how long it waited');
});

t('every message a player can see is English and actionable', () => {
	for (const m of [TERRAIN_UNREACHABLE, TERRAIN_EMPTY, PHYSICS_OOM, PHYSICS_UNAVAILABLE, NO_WEBGL2]) {
		assert.ok(!/[\u00c0-\u00ff]/i.test(m), `English: ${m}`);
		assert.ok(/reload|close|update|try|allow/i.test(m), `says what to do: ${m}`);
	}
});

// -----------------------------------------------------------------------------
// 2. THE WebGL2 PROBE, AS IT IS ACTUALLY SHIPPED
// -----------------------------------------------------------------------------
//
// The probe is inlined in index.html on purpose: three r170 asks for a "webgl2"
// context and nothing else, and WebGLRenderer throws at module top level when
// it cannot get one, which aborts main.js before anything exists that could
// report it. A probe living in the bundle would be aborted by the same failure
// it is there to describe. So the test reads the real file and runs the real
// script — not a copy of it, which would rot.

section('2. the WebGL2 probe in index.html');

const html = readFileSync(join(SIM, 'index.html'), 'utf8');

function probeSource() {
	const m = html.match(/<script>([\s\S]*?)<\/script>/);
	assert.ok(m, 'index.html carries an inline classic script');
	return m[1];
}

function runProbe({ webgl2 }) {
	const ui = { innerHTML: '' };
	const win = webgl2 ? { WebGL2RenderingContext: function WebGL2RenderingContext() {} } : {};
	const doc = {
		createElement: () => ({ getContext: (kind) => (webgl2 && kind === 'webgl2' ? {} : null) }),
		getElementById: (id) => (id === 'ui' ? ui : null),
	};
	// eslint-disable-next-line no-new-func
	new Function('document', 'window', probeSource())(doc, win);
	return { ui, win };
}

t('the probe runs BEFORE the module tag, so a dead bundle cannot silence it', () => {
	const inline = html.indexOf('<script>');
	const mod = html.indexOf('<script type="module"');
	assert.ok(inline > 0 && mod > 0, 'both scripts are there');
	assert.ok(inline < mod, 'the probe comes first');
	// Classic, not module: module scripts are deferred and would run after the
	// page has already been sitting black.
	assert.ok(!/<script type="module">/.test(html), 'the probe is not a module');
});

t('no WebGL2: the page says so, in words, with no bundle and no stylesheet', () => {
	const { ui, win } = runProbe({ webgl2: false });
	assert.equal(win.__FPVTP_NO_WEBGL2, true, 'main.js can tell this panel is already up');
	const text = ui.innerHTML;
	assert.ok(/WebGL2/i.test(text), 'names the missing thing');
	assert.ok(/browser/i.test(text), 'names what has to change');
	// The panel must not depend on style.css: whatever failed further down, the
	// words have to reach the screen.
	assert.ok(/style="/.test(text), 'carries its own styles inline');
	assert.ok(!/class="/.test(text), 'leans on no stylesheet class');
	assert.ok(!/[\u00c0-\u00ff]/i.test(text), 'English');
});

t('WebGL2 present: the probe leaves no trace at all', () => {
	const { ui, win } = runProbe({ webgl2: true });
	assert.equal(ui.innerHTML, '', 'nothing painted');
	assert.equal(win.__FPVTP_NO_WEBGL2, undefined, 'no flag');
});

t('a browser that throws from getContext is treated as having no WebGL2', () => {
	const ui = { innerHTML: '' };
	const win = {};
	const doc = {
		createElement: () => ({ getContext: () => { throw new Error('blocked'); } }),
		getElementById: () => ui,
	};
	win.WebGL2RenderingContext = function C() {};
	// eslint-disable-next-line no-new-func
	new Function('document', 'window', probeSource())(doc, win);
	assert.equal(win.__FPVTP_NO_WEBGL2, true);
	assert.ok(/WebGL2/i.test(ui.innerHTML));
});

// -----------------------------------------------------------------------------
// 3. THE FAILURE SCREEN HAS A WAY OUT
// -----------------------------------------------------------------------------
//
// Every boot rejection lands on Hud.fail(). It used to swap a text node onto a
// stopped loading bar and stop there: no button, no key, nothing but F5, which
// a stranger has no reason to try on what looks like a broken page.

section('3. Hud.fail offers a way out');

const { installFakeDom } = await import('./lib/fake-dom.mjs');

// fake-dom builds trees with createElement and refuses innerHTML on purpose.
// Hud mounts itself with insertAdjacentHTML, so the two are taught to meet here
// rather than in the shared harness: this parser is deliberately small, it
// exists to mount ONE known template, and nothing else should grow to depend
// on it.
function teachInsertAdjacentHTML(Element) {
	const VOID = new Set(['BR', 'IMG', 'INPUT', 'HR', 'RECT', 'CIRCLE', 'PATH', 'LINE', 'USE', 'POLYGON']);
	if (!Object.getOwnPropertyDescriptor(Element.prototype, 'parentElement')) {
		Object.defineProperty(Element.prototype, 'parentElement', { get() { return this.parent; } });
	}
	// fake-dom speaks `[id="x"]`; Hud, like every browser, writes `#x`.
	const all = Element.prototype.querySelectorAll;
	Element.prototype.querySelectorAll = function (sel) {
		return all.call(this, String(sel).replace(/^#([\w-]+)$/, '[id="$1"]'));
	};
	Element.prototype.insertAdjacentHTML = function insertAdjacentHTML(position, markup) {
		assert.equal(position, 'beforeend', 'only the position Hud uses is supported');
		const stack = [this];
		const re = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>|([^<]+)/g;
		let m;
		while ((m = re.exec(markup)) !== null) {
			const [, close, open, attrs, selfClose, text] = m;
			if (close) { if (stack.length > 1) stack.pop(); continue; }
			if (text) {
				const trimmed = text.trim();
				if (trimmed) stack[stack.length - 1]._text = trimmed;
				continue;
			}
			const el = document.createElement(open);
			for (const a of (attrs ?? '').matchAll(/([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g)) {
				const [, key, value = ''] = a;
				if (key === 'class') el.className = value;
				else if (key === 'id') el.setAttribute('id', value);
				else if (key === 'hidden') el.hidden = true;
				else el.setAttribute(key, value);
			}
			stack[stack.length - 1].appendChild(el);
			if (!selfClose && !VOID.has(el.tagName)) stack.push(el);
		}
	};
}

async function mountHud() {
	const dom = installFakeDom();
	teachInsertAdjacentHTML(Object.getPrototypeOf(dom.root).constructor);
	const nav = [];
	globalThis.location = {
		pathname: '/',
		set href(v) { nav.push(v); },
		get href() { return nav[nav.length - 1] ?? ''; },
	};
	const { Hud } = await import('../src/hud.js');
	const root = document.createElement('div');
	root.setAttribute('id', 'ui');
	dom.root.appendChild(root);
	return { dom, nav, hud: new Hud(root), root };
}

const mounted = await mountHud();

t('a failure prints the message AND unhides the screen carrying it', () => {
	mounted.hud.fail('terrain: nope');
	assert.ok(!mounted.root.querySelector('[id="loading"]').hidden, 'the screen is visible');
	assert.ok(mounted.root.textContent.includes('terrain: nope'));
});

t('there is a [ RELOAD ], and it reloads the bare page', () => {
	const btn = mounted.root.querySelectorAll('button').find((b) => b.textContent.includes('RELOAD'));
	assert.ok(btn, 'the button exists');
	// The global CTA class, so it looks like every other action in the product.
	assert.equal(btn.className, 'bootstrap-btn');
	btn.click();
	// location.pathname, not location.reload(): a bad ?scene= slug must not be
	// retried for ever, and the intro is already marked seen in sessionStorage,
	// so this lands on SELECT OPERATION MODE.
	assert.equal(mounted.nav.at(-1), '/');
});

t('Escape and Enter do the same thing, because pointer lock eats one of them', () => {
	for (const key of ['Escape', 'Enter']) {
		const before = mounted.nav.length;
		mounted.dom.key(key);
		assert.equal(mounted.nav.length, before + 1, `${key} gets out`);
	}
	const before = mounted.nav.length;
	mounted.dom.key('k');
	assert.equal(mounted.nav.length, before, 'an unrelated key does nothing');
});

t('a second failure does not stack a second button or a second listener', () => {
	mounted.hud.fail('and again');
	const buttons = mounted.root.querySelectorAll('button').filter((b) => b.textContent.includes('RELOAD'));
	assert.equal(buttons.length, 1);
	const before = mounted.nav.length;
	mounted.dom.key('Escape');
	assert.equal(mounted.nav.length, before + 1, 'exactly one navigation, not two');
});

mounted.dom.restore();
delete globalThis.location;

// -----------------------------------------------------------------------------
// 4. THE MODE A MACHINE STARTS IN
// -----------------------------------------------------------------------------
//
// main.js decides which mode a flight starts in, as it arms, because only main.js
// knows what is plugged in — the controller must stay ignorant of input devices.
// The rule itself is input.js:startFlightMode(): every device starts in ACRO,
// unless a radio's measured flight-mode switch says otherwise.

section('4. FlightController start mode');

const { FlightController, MODES } = await import('../src/flightController.js');

t('the default is unchanged: acro', () => {
	assert.equal(new FlightController().mode, 'acro');
	assert.equal(new FlightController({}).mode, 'acro');
	// The bare-string form (bench and older callers) still means "preset".
	assert.equal(new FlightController('race').mode, 'acro');
	assert.equal(new FlightController('race').preset, 'race');
});

t('a caller can start the machine in angle', () => {
	const fc = new FlightController({ mode: 'angle' });
	assert.equal(fc.mode, 'angle');
	// And the mode cycle still works from there — nothing is taken away.
	assert.equal(fc.cycleMode(), MODES[(MODES.indexOf('angle') + 1) % MODES.length]);
});

const { startFlightMode } = await import('../src/input.js');

t('every device starts in acro without a measured switch', () => {
	const mode = startFlightMode();
	assert.equal(mode, 'acro');
	assert.equal(new FlightController({ mode }).mode, 'acro');
	assert.equal(startFlightMode(null), 'acro', 'no measured switch');
});

t('a radio with a measured switch starts where the switch is', () => {
	assert.equal(startFlightMode('angle'), 'angle');
	assert.equal(startFlightMode('acro'), 'acro');
	assert.equal(startFlightMode('nonsense'), 'acro', 'an unreadable position is no position');
});

t('an unknown mode falls back to acro rather than throwing', () => {
	assert.equal(new FlightController({ mode: 'sport' }).mode, 'acro');
	assert.equal(new FlightController({ mode: null }).mode, 'acro');
	// Removed modes: a stale value flies as acro, at construction and on setMode.
	for (const gone of ['acro3d', 'gps']) {
		assert.equal(new FlightController({ mode: gone }).mode, 'acro', gone);
		const fc = new FlightController({ mode: 'angle' });
		fc.setMode(gone);
		assert.equal(fc.mode, 'acro', gone);
	}
});

t('the M cycle only walks the remaining modes', () => {
	assert.deepEqual(MODES, ['acro', 'angle', 'altitude']);
	const fc = new FlightController();
	assert.deepEqual([fc.cycleMode(), fc.cycleMode(), fc.cycleMode()], ['angle', 'altitude', 'acro']);
});

t('the mode option touches nothing else about the machine', () => {
	const a = new FlightController({ preset: 'race' });
	const b = new FlightController({ preset: 'race', mode: 'angle' });
	assert.deepEqual(a.rates, b.rates, 'same rates');
	assert.deepEqual(a.gains, b.gains, 'same measured gains — no PID moved');
	assert.equal(a.preset, b.preset);
});

console.log(failures ? `\nfirst-run: ${failures} FAILED` : '\nfirst-run: all checks passed');
process.exit(failures ? 1 : 0);
