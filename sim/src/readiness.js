// RECOMMENDED — the launch screen that names the two things the game cannot
// tell you about itself: what you fly it with, and what you fly it in.
//
// Mounted by main.js in chooseScene(), after the intro and BEFORE the operator
// is resolved: this is hardware, not identity, so an operator registered months
// ago meets it too. It never runs on the ?scene= / ?live= paths — those are
// development entrances.
//
// What is SHOWN is decided by tools/readiness-model.mjs: three pictograms, each
// lit or dim, and at most one line of text. This file only mounts it.
//
// The live pad probe is the point of the screen. The Gamepad API reveals a
// device only after an input on it, so the pad opens dim ("MOVE A STICK TO
// DETECT IT") and lights the moment a stick moves — gamepadconnected, plus a
// poll at menu-nav's own cadence because Firefox fires that event late and
// Chromium fires it once per page, not once per screen.
import { mountScreen, screenButton } from './screen.js';
import { menuNav } from './menu-nav.js';
import { padKind, bestPad } from './input.js';
import { iconPath } from './pixel-icons.js';
import {
	readinessReport, browserFamily, markReadinessDismissed, READINESS_AUTO_MS,
} from '../tools/readiness-model.mjs';

// The same 80 ms as src/menu-nav.js. Not imported: it is not exported there, and
// this file must not be the reason it becomes part of that module's surface.
const PAD_POLL_MS = 80;

const SVG_NS = 'http://www.w3.org/2000/svg';

// The best enumerated pad, not the first: see bestPad() in input.js — a
// keyboard receiver listed ahead of a radio used to light DUALSHOCK.
function currentPad(nav) {
	try { return bestPad(nav?.getGamepads?.()); }
	catch { return null; }
}

// What the environment currently looks like, read once. Every `navigator` access
// of this screen goes through here, which is what keeps the model pure.
function probe(nav) {
	const pad = currentPad(nav);
	return {
		browserFamily: browserFamily(nav?.userAgentData, nav?.userAgent),
		padId: pad?.id ?? '',
		padKind: pad ? padKind(pad.id) : 'generic',
	};
}

// A pictogram as inline SVG, built node by node (no innerHTML: see
// terminal.js), so its colour is the page's `currentColor` and lit / dim are
// two CSS classes rather than two baked images. Its size is set by the
// stylesheet, on a multiple of the 12-pixel grid.
function pictogram(icon) {
	const fig = document.createElement('div');
	fig.className = 'readiness-item';
	fig.dataset.icon = icon.id;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 12 12');
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('fill', 'currentColor');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', iconPath(icon.id));
	svg.appendChild(path);
	const label = document.createElement('span');
	label.className = 'readiness-label';
	label.textContent = icon.label;
	fig.append(svg, label);
	return fig;
}

// Lit / dim, in one place: `data-lit` for the stylesheet and the selftest.
function paint(items, hintEl, report) {
	for (const icon of report.icons) {
		const fig = items.get(icon.id);
		fig.dataset.lit = String(icon.lit);
		fig.classList.toggle('is-lit', icon.lit);
	}
	hintEl.textContent = report.hint;
	hintEl.hidden = !report.hint;
}

// `store` and `nav` are injected so the selftest can hand over a broken store or
// a pad that appears halfway through; `autoMs` and `pollMs` are only for that
// selftest, which has no patience. `last` closes the screen with the backwards
// print that carries the black background away; it does not by default,
// because the bootstrap or the terminal is mounted right behind it and the
// black must hold until then (see the close() comments in src/screen.js).
export async function runReadiness(root, {
	nav = typeof navigator === 'undefined' ? null : navigator,
	store = typeof localStorage === 'undefined' ? null : localStorage,
	autoMs = READINESS_AUTO_MS,
	pollMs = PAD_POLL_MS,
	last = false,
} = {}) {
	const s = mountScreen(root, { cls: 'readiness' });
	let report = readinessReport(probe(nav));

	const title = document.createElement('pre');
	title.className = 'readiness-title';
	title.textContent = report.title;
	const row = document.createElement('div');
	row.className = 'readiness-row';
	const items = new Map();
	report.icons.forEach((icon, i) => {
		const fig = pictogram(icon);
		items.set(icon.id, fig);
		row.appendChild(fig);
		if (i === 0) {
			const or = document.createElement('span');
			or.className = 'readiness-or';
			or.textContent = report.or;
			row.appendChild(or);
		}
	});
	const hint = document.createElement('pre');
	hint.className = 'readiness-hint';
	paint(items, hint, report);
	s.box.append(title, row, hint);

	return new Promise((resolve) => {
		const actions = document.createElement('div');
		actions.className = 'readiness-actions';
		let done = false;
		let nav_ = null;
		let poll = null;
		let timer = null;
		const offs = [];

		const finish = (dismiss) => {
			if (done) return;
			done = true;
			if (dismiss) markReadinessDismissed(store);
			if (poll !== null) clearInterval(poll);
			if (timer !== null) clearTimeout(timer);
			for (const off of offs) off();
			// detach() before the screen leaves: a nav left attached to a removed
			// container keeps an 80 ms poll and a window listener that nothing can
			// ever reap — exactly what briefing-render-selftest.mjs counts.
			nav_?.detach();
			nav_ = null;
			(last ? s.close({ revealBehind: true }) : s.close()).then(resolve, resolve);
		};

		// --- the live pad probe -------------------------------------------------
		// A device appearing lights its pictogram. The reverse is not
		// done: a screen that took a verdict back would be noise, and a pad that
		// unplugs itself during these two seconds is not a case worth a branch.
		const refresh = () => {
			if (done || report.allClear) return;
			const next = readinessReport(probe(nav));
			if (next.input.state === report.input.state) return;
			report = next;
			paint(items, hint, report);
			// The screen is no longer waiting on anything: it becomes the readout
			// it would have been, and takes itself away.
			if (report.allClear) {
				clearInterval(poll);
				poll = null;
				actions.remove();
				nav_?.detach();
				nav_ = null;
				armAllClear();
			}
		};

		// --- the all-clear readout ----------------------------------------------
		// A readout, not a question: no button, and anything at all takes it away
		// before the two seconds are up. Armed at mount, or the moment the live
		// probe turns a waiting screen into one.
		const armAllClear = () => {
			timer = setTimeout(() => finish(false), autoMs);
			const any = () => finish(false);
			window.addEventListener('keydown', any);
			window.addEventListener('mousedown', any);
			window.addEventListener('gamepadconnected', any);
			offs.push(() => {
				window.removeEventListener('keydown', any);
				window.removeEventListener('mousedown', any);
				window.removeEventListener('gamepadconnected', any);
			});
			// A gamepad BUTTON is not an event: the only way to hear one is to
			// look. Same cadence as the rest of the house.
			let base = null;
			poll = setInterval(() => {
				const pad = currentPad(nav);
				const now = (pad?.buttons ?? []).map((b) => (typeof b === 'object' ? !!b.pressed : !!b));
				if (base === null) { base = now; return; }
				if (now.some((p, i) => p && !base[i])) finish(false);
				base = now;
			}, pollMs);
		};

		if (report.allClear) {
			armAllClear();
			return;
		}

		// --- the waiting screen -------------------------------------------------
		poll = setInterval(refresh, pollMs);
		const onConnect = () => refresh();
		window.addEventListener('gamepadconnected', onConnect);
		offs.push(() => window.removeEventListener('gamepadconnected', onConnect));

		actions.append(
			screenButton('CONTINUE', () => finish(false), 'bootstrap-btn'),
			screenButton("DON'T SHOW AGAIN", () => finish(true), 'bootstrap-btn'),
		);
		s.box.appendChild(actions);
		// Keyboard AND pad navigation, the house way. No `back`: there is nowhere
		// above this screen, and Escape here would be a third answer to a
		// two-answer question.
		nav_ = menuNav(s.el, {});
	});
}
