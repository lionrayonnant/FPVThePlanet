// Operator Terminal (PHASE 02, Bible §11-17). Replaces the "pick a map" menu
// (the old Hud.showMenu) and the old minimal Home (home.js, deleted).
// Full-frame screens mounted by APPEND into #ui — never innerHTML, the HUD is
// already there. All interface text is English (D5).
import * as operatorApi from './operator.js';
import { bootstrap } from './bootstrap.js';
import { menuNav } from './menu-nav.js';
import { terminalModel, formatBytes } from '../tools/terminal-model.mjs';
import { countersOf, unlockedNotes, currentBuild } from '../tools/buildnotes-model.mjs';
import { targetLogEntries, areaLabel, targetRow, duration, fit } from '../tools/session-log-model.mjs';
import { dataModel, stickSeries, profileSeries } from '../tools/data-model.mjs';
import { fetchTrackIndex, fetchTrack } from './track-index.js';
import { bars, histogram, scatter, steps } from './graph.js';
import { worldWeather, formatForecast, headline, severity as weatherSeverity, today as weatherToday } from './weather.js';
import { previewBounds } from '../tools/map-preview-model.mjs';
import { countUp } from './motion.js';
import { mountScreen, screenButton } from './screen.js';
import { armConfirm } from './confirm-button.js';
import { versionLine, SOURCE_URL, SOURCE_CALL, LICENCE } from './version.js';
import { iconDataUri } from './pixel-icons.js';
import { token } from './palette.js';
import { TIP_BUTTONS, SUPPORT_LINES, SUPPORT_TAGLINE, paymentUri } from '../tools/support-model.mjs';


// How many areas the Home shows under the map before handing over to MORE….
// Enough to recognise your cache at a glance, not enough to become the list
// again — the list is exactly what we are taking out of the Home.
const COMPACT_AREAS = 5;

// The attribution the live imagery carries, pre-flight. Kept identical to
// main.js's LIVE_CREDIT, which the flight OSD paints: one string, two surfaces,
// and no way for them to drift apart.
const LIVE_IMAGERY_CREDIT = '\u00a9 Google';

// The FIELD tab we were on, for the session: LIVE (take off straight from a
// map pin) or LOCAL (fly or acquire a baked area) (#222). LIVE on entry (D2):
// it is the path that works on every build, including that of an operator who
// has not acquired anything yet.
let lastTab = 'live';

export function screen(root, cls = '') {
	return mountScreen(root, { cls: `terminal ${cls}`.trim(), boxCls: 'terminal-box' });
}

export const button = screenButton;

// A row of inline links, "A · B · C", separated by middle dots.
function navRow(entries) {
	const row = document.createElement('div');
	row.className = 'terminal-nav';
	entries.forEach(([label, fn], i) => {
		if (i) row.appendChild(document.createTextNode(' · '));
		row.appendChild(button(label, fn, 'terminal-link'));
	});
	return row;
}

// The keys a screen answers to, written where the screen is (D15). Escape has
// always worked everywhere and was named nowhere — a key nobody can see is a key
// nobody presses. `pairs` is [[key, what it does], …], rendered `[ESC] BACK`.
//
// It is information, not assistance (Bible, pilier 1): one dim line, no arrow,
// no prompt, and never a button — pressing it is the point.
export function keyHints(pairs) {
	const row = document.createElement('pre');
	row.className = 'terminal-keys';
	row.textContent = pairs.map(([key, what]) => `[${key}] ${what}`).join(' · ');
	return row;
}

// [ BACK ] and the key that does the same thing, together. Every sub-screen
// repeats this pair, so it is written once — a screen that grows a BACK button
// without its key hint is the drift this helper prevents.
export function backRow(box, onBack) {
	box.appendChild(button('BACK', onBack, 'terminal-cta'));
	box.appendChild(keyHints([['ESC', 'BACK']]));
}

// The line the three screens directly under the root carry.
const ESC_ROOT = () => keyHints([['ESC', 'OPERATION MODE']]);

// "There is nothing here", written the same way everywhere.
//
// It used to render at five different type levels: a bare <pre> inherits the
// DISPLAY face from `.bootstrap-box`, so "NO SESSIONS MATCH THIS FILTER" came
// out at 22px inside a list of 13px rows, while the same statement elsewhere
// was UI 15px, or DATA 13px, or coloured. An empty state is information, not
// an alarm and not a headline: DATA level, `--light-grey`, no colour (Bible
// §38/§39). `extra` only ever carries POSITION — `.terminal-map-none` centres
// itself in the map frame — never a second type level.
export function emptyState(text, extra = '') {
	const el = document.createElement('pre');
	el.className = `terminal-empty ${extra}`.trim();
	el.textContent = text;
	return el;
}

// The right to acquire, as the server reports it (issue #60): the
// FPVTP_ACQUIRE flag set AND `local` mode. Held aside rather than returned by
// fetchScenes(), whose three callers expect an array of areas and nothing
// else. Closed until a server says otherwise: a distributed build does not
// acquire, and that is the default case.
let acquireAllowed = false;
export function canAcquire() { return acquireAllowed; }

// Where the game RUNS, which is a different question from what it is allowed to
// download (V1). Every distributed build ships with acquisition closed, so a
// footer and a LOCAL-tab notice keyed on `acquire` told the desktop client it
// was a SHARED SERVER and that terrain "is not available on this server".
// Optimistic default: an unreachable server is not a reason to call a local
// install someone else's.
let sharedServer = false;
export function isSharedServer() { return sharedServer; }

export async function fetchScenes() {
	try {
		const r = await fetch('/__map-api/scenes');
		if (!r.ok) return null;
		const { scenes, acquire, mode } = await r.json();
		acquireAllowed = acquire === true;
		sharedServer = mode === 'shared';
		return Array.isArray(scenes) ? scenes : null;
	} catch {
		return null;
	}
}

// ---------- FORECAST ----------

// An area's 7-day forecast (PHASE 04, Bible §5). Nothing to adjust here: it is
// a bulletin, not a panel. The weather belongs to the world.
async function forecastScreen(root, scene) {
	const s = screen(root);
	// `scene.name` is NOT ours: the scanner auto-fills it from a Nominatim
	// `display_name` (src/scanner.js), i.e. straight out of a third party's HTTP
	// response. Interpolated into innerHTML it was a stored injection in the
	// origin that holds the operator key. `textContent` on a node we built: the
	// name is text, always, whatever it contains.
	const head = document.createElement('pre');
	head.textContent = `FORECAST // ${scene.name.toUpperCase()}\n\nQUERYING WORLD STATE…`;
	s.box.replaceChildren(head);
	const back = new Promise((resolve) => {
		const close = () => { nav.detach(); s.remove(); resolve(); };
		backRow(s.box, close);
		const nav = menuNav(s.el, { back: close });
	});
	const snapshot = await worldWeather({ lat: scene.lat, lon: scene.lon });
	// The screen may have been closed during the request.
	if (s.el.isConnected) {
		s.box.querySelector('pre').textContent = snapshot
			? formatForecast(snapshot, { title: `FORECAST // ${scene.name}` })
			: `FORECAST // ${scene.name.toUpperCase()}\n\nNO COORDINATES FOR THIS AREA`;
	}
	return back;
}

// ---------- an area row ----------

// The whole row is the cursor (issue #123): ↑/↓ move over it, it takes the
// white tone of the art direction — Enter/click activates it.
//
// Lifted out of localTerrain() so that the Home's compact list and the full
// screen show EXACTLY the same thing: a name, a weight, and the weather over
// there. Two implementations would be two ways of reading the same area, and
// only one of the two worldWeather() calls would be updated the day the line
// changes.
//
// `onWeather`: the severity, once known, for a caller that sorts on it.
// --- the footer's two categories: where the code is, and where a tip goes.
//
// They were one undifferentiated stack of links. A repository and a tip jar are
// not the same offer — one is a licence obligation, the other is a request —
// and a player who is looking for one should never have to read the other.
// Each gets its own heading, and each speaks in marks rather than in words:
// a logo is recognised before it is read, which "SUPPORT" never was.

// A category heading in the footer. Micro type, one word or one line.
function metaHead(text) {
	const p = document.createElement('pre');
	p.className = 'terminal-meta-head';
	p.textContent = text;
	return p;
}

// A 12x12 icon as an <img>.
//
// An <img> with a data: URI rather than inline SVG: this file builds every node
// with createElement, and the fake DOM the render selftests use refuses
// innerHTML outright — which is the guard that keeps an injection from ever
// finding a door here. An attribute sidesteps the question entirely.
//
// The colour is RESOLVED here, not inherited. `currentColor` inside an <img>
// does not see the page: the browser renders the SVG in its own context, where
// `color` is the initial value — so every mark came out near-black on a black
// screen and the row read as three empty boxes. token() reads the same
// stylesheet the rest of the interface uses (src/palette.js), so there is still
// no second copy of the palette.
//
// `alt` is not decoration either: it is the name a screen reader — and the
// render selftest — has for a button whose content is a picture.
function iconImg(name, { size = 12, alt = '', cls = 'terminal-mark' } = {}) {
	const img = document.createElement('img');
	img.className = cls;
	img.setAttribute('src', iconDataUri(name, { size, color: token('--warm-white') }));
	img.setAttribute('alt', alt);
	img.setAttribute('width', String(size));
	img.setAttribute('height', String(size));
	return img;
}

// The source line: GitHub's mark and the licence. The mark rather than the
// project's own chevron pair, because the destination IS that platform and a
// player identifies it in one glance; the licence stays in words, because
// AGPL-3.0 is a legal term and no glyph carries it.
//
// target=_blank is required, not stylistic: in the desktop app
// electron/main.js refuses to navigate the window off its own origin, so a
// plain link would be silently blocked. Opening a new window routes it through
// setWindowOpenHandler, which hands https to the system browser.
function sourceLink() {
	const a = document.createElement('a');
	a.className = 'terminal-meta terminal-source';
	// setAttribute rather than the properties: the render selftests mount this
	// on a fake DOM that tracks attributes, and an offer the tests cannot see is
	// an offer nothing stops from disappearing.
	a.setAttribute('href', SOURCE_URL);
	a.setAttribute('target', '_blank');
	a.setAttribute('rel', 'noopener noreferrer');
	a.appendChild(iconImg('github', { size: 12, alt: 'GITHUB', cls: 'terminal-source-mark' }));
	a.appendChild(document.createTextNode(` ${LICENCE}`));
	return a;
}

// The tip row: one tile per currency, each opening its own window.
//
// No full screen any more. A tip jar that takes the whole frame asks more of a
// player than it is worth — the window opens over FIELD, says one thing, and
// closes.
//
// A tile rather than a bare icon: three unlabelled glyphs in a corner are
// something to decipher, and nobody gives to a puzzle. The mark is what carries
// the recognition and the coin's NAME is under it — which is the opposite of
// the word this replaced: "SUPPORT" said nothing about what would happen next.
function tipRow(onOpen) {
	const row = document.createElement('div');
	row.className = 'terminal-tips';
	for (const group of TIP_BUTTONS) {
		const b = screenButton('', () => onOpen(group, b), 'terminal-tip-btn');
		// 24px, an exact doubling of the 12x12 grid. Any other size lands pixels
		// on half-pixels, which is where crispEdges stops being able to help.
		b.appendChild(iconImg(group.icon, { size: 24, alt: '' }));
		const name = document.createElement('span');
		name.className = 'terminal-tip-name';
		name.textContent = group.alt;
		b.appendChild(name);
		b.dataset.tip = group.id;
		row.appendChild(b);
	}
	return row;
}

function areaRow(sc, { onActivate, onWeather = null } = {}) {
	const row = document.createElement('button');
	row.type = 'button';
	row.className = 'terminal-area';
	row.dataset.slug = sc.slug;

	const name = document.createElement('span');
	name.textContent = sc.name;
	const size = document.createElement('span');
	size.className = 'terminal-area-size';
	size.textContent = formatBytes(sc.bytes);
	countUp(size);
	// The weather over there, not a setting: the line fills in when the world
	// state answers, and stays empty if it does not.
	const sky = document.createElement('span');
	sky.className = 'terminal-area-weather';
	sky.textContent = '…';
	worldWeather({ lat: sc.lat, lon: sc.lon })
		.then((snap) => {
			const t = snap && weatherToday(snap);
			sky.textContent = t ? headline(t) : '';
			// Colour only appears when the conditions change the decision to fly
			// (PHASE 19, Bible §38): `nominal` sets nothing and the line
			// reste en encre neutre.
			const sev = t ? weatherSeverity(t) : 'nominal';
			if (sev !== 'nominal') sky.dataset.severity = sev;
			else delete sky.dataset.severity;
			onWeather?.(sc.slug, sev);
		})
		.catch(() => { sky.textContent = ''; delete sky.dataset.severity; });

	row.append(name, size, sky);
	row.onclick = () => onActivate?.(sc);
	return row;
}

// ---------- LOCAL TERRAIN ----------

// Resolves a slug (→ flight) or undefined (→ back to the terminal).
function localTerrain(root, scenes) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		// An open row lays down its own menuNav (OPEN/FORECAST/REMOVE TERRAIN),
		// above the list: Escape closes that one before the screen's.
		let subNav = null;
		const closeSub = () => { subNav?.detach(); subNav = null; };
		const done = (slug) => { closeSub(); nav?.detach(); s.remove(); resolve(slug); };

		// Text filter, kept from one re-render to the next (a removal, a return
		// from FORECAST) — only the name matters, it is the only field the
		// operator recognises from the keyboard.
		let query = '';

		// Active sort, same lifetime as the filter. WEATHER depends on data that
		// arrives late (worldWeather per row): the cache and the
		// `weatherReordered` register avoid re-sorting in a loop on every
		// resolution — one re-sort per map, the first time its severity is known.
		const SORTS = ['NAME', 'SIZE', 'DATE', 'WEATHER'];
		let sortBy = 'NAME';
		const weatherSeverityBySlug = new Map();
		const weatherReordered = new Set();

		const SEVERITY_RANK = { nominal: 0, watch: 1, marginal: 2, nogo: 3 };

		const compareScenes = (a, b) => {
			if (sortBy === 'SIZE') return (b.bytes ?? 0) - (a.bytes ?? 0); // plus lourd d'abord
			if (sortBy === 'DATE') return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')); // most recent first
			if (sortBy === 'WEATHER') {
				const ra = weatherSeverityBySlug.has(a.slug) ? SEVERITY_RANK[weatherSeverityBySlug.get(a.slug)] : 99;
				const rb = weatherSeverityBySlug.has(b.slug) ? SEVERITY_RANK[weatherSeverityBySlug.get(b.slug)] : 99;
				return ra - rb || a.name.localeCompare(b.name);
			}
			return a.name.localeCompare(b.name);
		};

		const render = (focusIdx = 0, focusSearch = false, focusSortIdx = -1) => {
			closeSub();
			nav?.detach();
			s.box.replaceChildren();
			const title = document.createElement('pre');
			title.textContent = 'LOCAL TERRAIN';
			s.box.appendChild(title);
			if (scenes === null || scenes.length === 0) {
				// No redirect to an acquisition page: the scanner IS the entrance.
				s.box.appendChild(emptyState(scenes === null
					? 'TERRAIN CACHE UNREACHABLE' : 'NO LOCAL TERRAIN — ACQUIRE ONE'));
				backRow(s.box, () => done());
				nav = menuNav(s.el, { back: () => done() });
				return;
			}

			const search = document.createElement('input');
			search.type = 'search';
			search.autocomplete = 'off';
			search.spellcheck = false;
			search.placeholder = 'SEARCH';
			search.value = query;
			search.className = 'terminal-search';
			search.oninput = () => { query = search.value; render(0, true); };
			s.box.appendChild(search);

			const sortRow = document.createElement('div');
			sortRow.className = 'terminal-nav terminal-sort';
			SORTS.forEach((key, i) => {
				if (i) sortRow.appendChild(document.createTextNode(' · '));
				sortRow.appendChild(button(key === sortBy ? `[${key}]` : key, () => {
					sortBy = key;
					render(0, false, i);
				}));
			});
			s.box.appendChild(sortRow);

			const q = query.trim().toLowerCase();
			const shown = (q ? scenes.filter((sc) => sc.name.toLowerCase().includes(q)) : scenes.slice())
				.sort(compareScenes);

			const refocusSearch = () => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); };
			const refocusSort = () => { sortRow.querySelectorAll('button')[focusSortIdx]?.focus(); };

			if (!shown.length) {
				s.box.appendChild(emptyState('NO MATCH'));
				backRow(s.box, () => done());
				nav = menuNav(s.el, { back: () => done(), focusFirst: false });
				if (focusSortIdx >= 0) refocusSort(); else refocusSearch();
				return;
			}

			const list = document.createElement('div');
			list.className = 'terminal-areas';
			shown.forEach((sc, i) => {
				const item = document.createElement('div');

				// Here the row OPENS its actions (OPEN / FORECAST / REMOVE
				// TERRAIN); on the Home it selects the area. Same row, two
				// gestures — and that is all that tells the two lists apart.
				const actions = document.createElement('div');
				const row = areaRow(sc, {
					onActivate: () => {
						if (subNav) return;
						actions.hidden = false;
						subNav = menuNav(actions, { back: () => { closeSub(); actions.hidden = true; row.focus(); } });
					},
					onWeather: (slug, sev) => {
						weatherSeverityBySlug.set(slug, sev);
						if (sortBy === 'WEATHER' && !weatherReordered.has(slug)) {
							weatherReordered.add(slug);
							render(focusIdx, focusSearch, focusSortIdx);
						}
					},
				});
				actions.className = 'terminal-nav terminal-area-actions';
				actions.hidden = true;
				actions.append(
					button('OPEN', () => done(sc.slug), 'terminal-link'),
					button('FORECAST', () => forecastScreen(root, sc), 'terminal-link'));
				// Removing an area is a LOCAL operation (issue #78): the terrain
				// belongs to the instance, not to whoever is looking at it, and a
				// shared server answers 403 to everyone. The button would only ever
				// fail silently there, so it is not offered.
				if (!sharedServer) {
					// Hundreds of megabytes of baked terrain, on ONE press: this
					// was the last unguarded destructive action in the game. Same
					// gesture, same words and same treatment as the scanner's
					// `[ REMOVE TERRAIN ]` (#213) — one operation, one label. The
					// second press is the confirmation; arming lapses on its own.
					const remove = button('REMOVE TERRAIN', null, 'terminal-cta');
					armConfirm(remove, async () => {
						closeSub();
						const r = await fetch(`/__map-api/scenes/${sc.slug}`, { method: 'DELETE' });
						if (!r.ok) return;
						scenes = scenes.filter((x) => x.slug !== sc.slug);
						render(Math.min(i, scenes.length - 1));
					});
					actions.append(remove);
				}

				item.append(row, actions);
				list.appendChild(item);
			});
			s.box.appendChild(list);
			backRow(s.box, () => done());
			nav = menuNav(s.el, { back: () => done(), focusFirst: false });
			if (focusSortIdx >= 0) refocusSort();
			else if (focusSearch) refocusSearch();
			else {
				// `.terminal-area` and not `button.terminal-area`: inside this list
				// the class is only ever on a row, and the tag qualifier was the
				// last thing keeping the screen off the fake DOM (tools/lib).
				const rows = list.querySelectorAll('.terminal-area');
				(rows[Math.min(focusIdx, rows.length - 1)] ?? s.box.querySelector('button'))?.focus();
			}
		};

		render();
	});
}

// ---------- LAST SESSION ----------

// Resolves undefined, or a slug (REVISIT AREA).
function lastSessionScreen(root, model) {
	const s = screen(root);
	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };
		// createElement rather than innerHTML, like the rest of the house: that
		// is what makes the screen mountable on the fake DOM, and therefore
		// testable — and the REVISIT that leaves here is the contract the root
		// loop consumes.
		const pre = (text) => {
			const el = document.createElement('pre');
			el.textContent = text;
			return el;
		};
		const ls = model.lastSession;
		if (!ls) {
			s.box.appendChild(pre('LAST SESSION — NONE YET'));
			backRow(s.box, () => done());
			nav = menuNav(s.el, { back: () => done() });
			return;
		}
		const area = ls.area ?? ls.slug ?? null;
		const when = ls.end ?? ls.endedAt ?? ls.start ?? ls.startedAt ?? ls.at ?? '';
		s.box.appendChild(pre(`LAST SESSION

AREA     ${area ? areaLabel(area) : 'UNKNOWN'}
WHEN     ${String(when).replace('T', ' ').slice(0, 16) || 'UNKNOWN'}
RESULT   ${ls.result ?? 'UNKNOWN'}`));
		s.box.appendChild(button('VIEW SESSION', async () => {
			s.el.hidden = true;
			const { runSessionDetail } = await import('./session-log.js');
			const r = await runSessionDetail(root, ls.id, { scenes: null });
			// REVISIT and DELETE both close LAST SESSION: either way the screen in
			// front of you no longer describes the current state.
			if (r?.revisit) { done(r.revisit); return; }
			if (r?.deleted) { done(); return; }
			s.el.hidden = false;
			nav?.focusAt(0);
		}, 'terminal-cta'));
		const areaKnown = area && model.areas.some((a) => a.slug === area);
		// Terrain persistent, flights ephemeral: a lost flight is not resumed
		// (D9, 2026-09-08: landing is gone, and RESUME SESSION with it). The
		// terrain stays — that is what a revisit is.
		if (areaKnown) {
			s.box.appendChild(button('REVISIT AREA', () => done(area), 'terminal-cta'));
		}
		backRow(s.box, () => done());
		nav = menuNav(s.el, { back: () => done() });
	});
}

// ---------- OPERATOR ----------

async function operatorScreen(root, api) {
	const s = screen(root);
	let resolveScreen;
	let keyShown = false;
	let nav = null;
	const close = () => { nav?.detach(); s.remove(); resolveScreen(); };
	const render = () => {
		const op = api.getOperator();
		s.box.replaceChildren();
		const pre = document.createElement('pre');
		// The target counter is DERIVED from the sessions since PHASE 17 (spec
		// D1): `op.targetLog` no longer exists, and reading it always returned 0
		// — this screen announced TARGETS 0 while the Home footer said
		// "9 TARGETS LOGGED" and the Target Log listed nine.
		pre.textContent = [
			`OPERATOR // ${op.name.toUpperCase()}`,
			'',
			`REGISTERED   ${String(op.createdAt).replace('T', ' ').slice(0, 16)}`,
			`SESSIONS     ${op.sessions?.length ?? 0}`,
			`TARGETS      ${targetLogEntries(op.sessions).length}`,
		].join('\n');
		s.box.appendChild(pre);
		// The operator KEY (#60). Same gesture as SHOW VECTOR — hidden, revealed
		// on demand — and above all NOT the same object: the Control Vector is a
		// game ritual (Bible §33), the key is the technical secret that tells a
		// `shared` server who is speaking. Two screens, two mechanisms, never
		// mixed. It comes from the browser: the server can no longer read it back
		// in clear.
		if (api.hasKey?.()) {
			const keyPre = document.createElement('pre');
			keyPre.className = 'terminal-sub';
			keyPre.textContent = `OPERATOR KEY  ${keyShown ? api.getKey() : '••••-••••-••••-••••'}`;
			s.box.appendChild(keyPre);
			if (!keyShown) s.box.appendChild(button('SHOW KEY', () => { keyShown = true; render(); }, 'terminal-cta'));
			// The only thing ever said about the key, and it is said HERE:
			// registration itself asks nobody to write anything down.
			const where = document.createElement('pre');
			where.className = 'terminal-foot';
			where.textContent = 'THIS PROFILE LIVES IN THIS BROWSER. THE KEY CARRIES IT ELSEWHERE.';
			s.box.appendChild(where);
		}
		const portrait = document.createElement('div');
		portrait.className = 'op-portrait';
		portrait.hidden = true;
		s.box.appendChild(portrait);
		backRow(s.box, close);
		nav?.focusAt(0);
	};
	render();
	nav = menuNav(s.el, { back: close });
	return new Promise((resolve) => { resolveScreen = resolve; });
}

// ---------- BUILD NOTES ----------

// A hand-written version ladder (tools/buildnotes-model.mjs), unlocked by the
// counters the operator has already accumulated. Decorative: it resolves no
// flight, just a BACK to the Home.
// A TIP WINDOW — where the money would go, if you felt like it.
//
// One window per currency, opened from the mark in the FIELD footer. Not a mode
// at SELECT OPERATION MODE (a tip jar is not a mode), and no longer a full
// screen either: it says one thing, and a screen that takes the whole frame to
// say one thing asks more of a player than the thing is worth.
//
// Crypto only. The window does not argue the point — a line explaining why
// there is no card button reads as a defence, and a tip jar that defends itself
// is asking for more than it should. The README carries the reasoning.
function tipWindow(root, group, onClose = () => {}) {
	const s = screen(root, `terminal-tip tip-${group.id}`);
	const close = () => { s.remove(); onClose(); };

	const head = document.createElement('div');
	head.className = 'tip-head';
	// The same 24px mark as the button that opened it: the window answers the
	// click by showing what was clicked, which is what says it is the right one.
	head.appendChild(iconImg(group.icon, { size: 24, alt: '' }));
	const title = document.createElement('pre');
	title.textContent = group.title;
	head.appendChild(title);
	s.box.appendChild(head);

	const said = document.createElement('pre');
	said.className = 'terminal-sub';
	said.textContent = SUPPORT_LINES.join('\n');
	s.box.appendChild(said);

	if (group.note) {
		const n = document.createElement('pre');
		n.className = 'support-note';
		n.textContent = group.note;
		s.box.appendChild(n);
	}

	for (const entry of group.entries) {
		const row = document.createElement('div');
		row.className = 'support-entry';

		const label = document.createElement('pre');
		label.className = 'support-label';
		label.textContent = entry.label;
		row.appendChild(label);

		if (entry.note) {
			const note = document.createElement('pre');
			note.className = 'support-note';
			note.textContent = entry.note;
			row.appendChild(note);
		}

		// The address, whole. Never truncated with an ellipsis: an address you
		// cannot read in full is an address you cannot check against what your
		// wallet pasted, and checking is the only defence a donor has.
		const value = document.createElement('pre');
		value.className = 'support-value';
		value.textContent = entry.address;
		row.appendChild(value);

		row.appendChild(copyButton(entry.address));
		// The handle is not a URI scheme, so it gets no URI button rather than
		// a button that copies something no wallet can open.
		const uri = paymentUri(entry);
		if (uri) row.appendChild(copyButton(uri, 'COPY URI'));
		s.box.appendChild(row);
	}

	// menuNav, like every other screen: cursor, keyboard, gamepad, and above all
	// Escape doing something. buildNotesScreen carries the comment about being
	// the one screen that forgot this; there is no reason to be the second.
	let nav = null;
	const closeAndDetach = () => { nav?.detach(); close(); };
	backRow(s.box, closeAndDetach);
	nav = menuNav(s.el, { back: closeAndDetach });
	nav.focusAt(0);
	return s;
}

// A copy button that says whether it worked, because a silent copy button is
// indistinguishable from a broken one — and here the thing being copied is a
// payment address, where "I think it copied" is not good enough.
function copyButton(text, label = 'COPY') {
	const b = screenButton(label, async () => {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch { ok = false; }
		b.textContent = ok ? '[ COPIED ]' : '[ SELECT IT BY HAND ]';
		setTimeout(() => { b.textContent = `[ ${label} ]`; }, 2000);
	});
	return b;
}

function buildNotesScreen(root, operator) {
	const s = screen(root);
	const c = countersOf(operator);
	// createElement, and one note line = one <pre>. In a single block, a note
	// too long wrapped back to column 0: the continuation of "fixed: session
	// timestamp off by one hour on the" read as a NEW top-level entry, at the
	// same rank as the version number. One element per line is the only way to
	// give the wrapped line a hanging indent (`.terminal-note`) — two literal
	// spaces do not survive the wrap. Intended side effect: the screen becomes
	// mountable on the fake DOM.
	const head = document.createElement('pre');
	head.textContent = `BUILD NOTES\n\nCURRENT BUILD   ${currentBuild(c)}`;
	s.box.appendChild(head);

	for (const n of unlockedNotes(c)) {
		const block = document.createElement('div');
		block.className = 'terminal-note-block';
		const build = document.createElement('pre');
		build.textContent = n.build;
		block.appendChild(build);
		for (const line of n.lines) {
			const p = document.createElement('pre');
			p.className = 'terminal-note';
			p.textContent = line;
			block.appendChild(p);
		}
		s.box.appendChild(block);
	}
	return new Promise((resolve) => {
		// The only screen in the house that did not call menuNav: no cursor, no
		// keyboard, no gamepad, and above all Escape doing nothing. On a list of
		// notes long enough to run below the fold, its single BACK was out of
		// sight — the screen closed in on the operator.
		let nav = null;
		const close = () => { nav?.detach(); s.remove(); resolve(); };
		backRow(s.box, close);
		nav = menuNav(s.el, { back: close });
	});
}

// ---------- DATA ----------

// Everything COLD, and no longer a shelf of logs (issue #26). ARCHIVE listed
// what had been stored; DATA is one scrolling page where the operator reads
// their own flying back — nine sections, graphs first, raw records last.
//
// The screen COMPUTES NOTHING. Every series comes from tools/data-model.mjs and
// every mark is put down by src/graph.js; what lives here is the page — which
// section, in what order, and the one readout line under each.
//
// No score, no level, no badge, no comparison with anybody (spec, Non-goals).
// Nothing here is won: it is what happened, drawn.
//
// Resolves { slug } (a REVISIT, which the root loop flies like a choice made in
// FIELD) or null.
//
// `openMap` is the single call site of the ENRICHED map (#25): the scanner does
// not carry that toggle yet, so the caller passes nothing today and GEOGRAPHY
// renders no link. Wiring it later is one argument at one call site.
export function dataScreen(root, { api = operatorApi, scenes = null, openMap = null } = {}) {
	const operator = api.getOperator();
	const model = terminalModel({ operator, scenes });
	const s = screen(root, 'terminal-data');
	return new Promise((resolve) => {
		let nav = null;
		let alive = true;
		// A bare slug (lastSessionScreen) and a { slug } (SESSION LOG) say the
		// same thing: one shape goes back up, the one the root loop knows how to
		// fly.
		const done = (value) => {
			alive = false;
			window.removeEventListener('resize', onResize);
			nav?.detach();
			s.remove();
			resolve(value == null ? null : (typeof value === 'string' ? { slug: value } : value));
		};

		// One full-frame screen hides another: this one is hidden meanwhile and
		// given back on return. Same gesture as the Home with the scanner.
		const behind = async (fn) => {
			s.el.hidden = true;
			const r = await fn();
			if (r !== undefined && r !== null) return done(r);
			s.el.hidden = false;
			nav?.focusAt(0);
		};

		// --- state ---------------------------------------------------------
		// `tracks` is the index (#24), empty until it answers — and empty for
		// ever on a build that does not serve it. `track` is the ONE decoded
		// track of the flight being profiled: STICKS and PROFILE need samples,
		// and no other section does.
		const sessions = operator?.sessions ?? [];
		let tracks = [];
		let data = dataModel({ sessions, tracks });
		let selectedId = data.selectedId;
		let track = null;
		let openFamily = null;

		// --- page ----------------------------------------------------------
		const page = document.createElement('div');
		page.className = 'data-page';
		// Drawing is deferred: a canvas measures 0 until it has been laid out,
		// and the same closures are what a resize replays.
		let draws = [];
		const paint = () => { for (const d of draws) d(); };
		const onResize = () => { if (alive) paint(); };

		const pre = (text, cls = '') => {
			const el = document.createElement('pre');
			if (cls) el.className = cls;
			el.textContent = text;
			return el;
		};

		// A section is a title, one readout line, then whatever it draws. The
		// title is the machine speaking (DISPLAY); the readout is data.
		const section = (name, readout) => {
			const box = document.createElement('div');
			box.className = 'data-section';
			box.appendChild(pre(name));
			if (readout) box.appendChild(pre(readout, 'terminal-foot'));
			page.appendChild(box);
			return box;
		};

		// A canvas, and the closure that fills it. `draw` is called once the page
		// is up and again on every resize.
		const graph = (box, height, draw) => {
			const c = document.createElement('canvas');
			c.className = 'data-graph';
			box.appendChild(c);
			draws.push(() => draw(c));
			return c;
		};

		// The sections that need a trace say so in the same words everywhere, and
		// in the same way as every other empty state in the game.
		const noTrack = (box, why = 'NO TRACK') => box.appendChild(emptyState(why));

		// No tooltip: `title` is browser furniture, which Bible §44 refuses
		// everywhere else (cf. the refusal of confirm() in confirm-button.js). A
		// link says what it does in its label — so this helper takes THREE
		// arguments and a fourth would be silently dropped, which is exactly what
		// used to happen at three call sites below.
		const link = (row, label, fn) => {
			if (row.children.length) row.appendChild(document.createTextNode(' · '));
			row.appendChild(button(label, fn, 'terminal-link'));
		};
		const linkRow = () => {
			const row = document.createElement('div');
			row.className = 'terminal-nav';
			return row;
		};

		// --- the nine sections ----------------------------------------------

		const render = () => {
			page.replaceChildren();
			draws = [];

			// 1. RHYTHM — the only graph about real time, and the one that makes
			// coming back visible.
			const weeks = data.rhythm.bars.filter((b) => b.value > 0).length;
			const rhythm = section('RHYTHM',
				`SESSIONS PER WEEK · LAST ${data.rhythm.weeks} · ${data.rhythm.total} FLOWN · ${weeks} WEEKS WITH A FLIGHT`);
			graph(rhythm, 96, (c) => bars(c, { items: data.rhythm.bars, height: 96, format: (v) => String(Math.round(v)) }));

			// 2. LIFE — how long each one lasted, in the order they happened.
			const life = section('LIFE',
				data.life.bars.length
					? `DURATION PER SESSION · LONGEST ${duration(data.life.maxS)} · MEAN ${duration(data.life.meanS)}`
					: 'NO SESSION YET');
			graph(life, 96, (c) => bars(c, {
				items: data.life.bars.map((b) => ({ ...b, selected: b.id === selectedId })),
				height: 96,
				format: (v) => `${Math.round(v / 60)}m`,
				everyLabel: Math.max(1, Math.ceil(data.life.bars.length / 8)),
			}));

			// 3. SPEED × ALTITUDE — the shape of a flying style: low and fast, or
			// high and slow. One mark per flight, from the maxima it recorded.
			const sa = section('SPEED × ALTITUDE',
				data.speedAlt.points.length
					? `PEAK OF EACH FLIGHT · ${data.speedAlt.points.length} FLIGHTS · UP TO ${round1(data.speedAlt.maxX)} m/s AND ${Math.round(data.speedAlt.maxY)} m`
					: 'NO FLIGHT WITH A SHAPE YET');
			graph(sa, 150, (c) => scatter(c, {
				points: data.speedAlt.points.map((p) => ({ ...p, selected: p.id === selectedId })),
				height: 150, maxX: data.speedAlt.maxX, maxY: data.speedAlt.maxY,
				xLabel: 'SPEED m/s', yLabel: 'ALT m',
			}));

			// 4. HOW THEY DIED — the state at the moment the link died. Needs the
			// `end` event, so flights without a track are counted, not drawn.
			const deaths = section('HOW THEY DIED',
				data.loss.points.length
					? `SPEED AND ALTITUDE AT LINK LOSS · ${data.loss.points.length} RECORDED`
					+ (data.loss.missing ? ` · ${data.loss.missing} WITHOUT A TRACK` : '')
					: '');
			if (data.loss.points.length) {
				graph(deaths, 150, (c) => scatter(c, {
					points: data.loss.points.map((p) => ({ ...p, selected: p.id === selectedId })),
					height: 150, maxX: data.loss.maxX, maxY: data.loss.maxY,
					xLabel: 'SPEED m/s', yLabel: 'ALT m',
				}));
			} else noTrack(deaths);

			// 5. STICKS — throttle and rotation rate. They live in the samples, so
			// this is the SELECTED flight, the same one PROFILE draws.
			const sticks = stickSeries(track);
			const st = section('STICKS', sticks
				? `${selectedLabel()} · ${sticks.samples} SAMPLES`
				: '');
			if (sticks) {
				st.appendChild(pre('THROTTLE', 'terminal-foot'));
				graph(st, 84, (c) => histogram(c, { bins: sticks.throttle.bins, height: 84, format: (v) => `${Math.round(v * 100)}%` }));
				st.appendChild(pre('ROTATION RATE', 'terminal-foot'));
				graph(st, 84, (c) => histogram(c, { bins: sticks.rate.bins, height: 84, format: (v) => `${Math.round(v)}°/s` }));
			} else noTrack(st);

			// 6. FAMILIES — a bar per target family, mean survival on it. This is
			// where the TARGET LOG went (D2): a family opens on the targets met.
			const fam = section('FAMILIES', data.families.total
				? `MEAN SURVIVAL PER TARGET FAMILY · ${data.families.total} TARGETS MET`
				: 'NO TARGET MET YET');
			if (data.families.total) {
				graph(fam, 110, (c) => bars(c, {
					items: data.families.families.map((f) => ({ label: f.label, value: f.meanS, selected: f.family === openFamily })),
					height: 110, format: (v) => `${Math.round(v / 60)}m`,
				}));
				const row = linkRow();
				for (const f of data.families.families) {
					link(row, `${f.label} ${f.count}`, () => {
						openFamily = openFamily === f.family ? null : f.family;
						render();
					});
				}
				fam.appendChild(row);
				const open = data.families.families.find((f) => f.family === openFamily);
				if (open) {
					fam.appendChild(pre(open.entries.map((e) => `  ${targetRow(e)}`).join('\n'), 'terminal-log'));
				}
			}

			// 7. GEOGRAPHY — where the operator has been. Countries only when a
			// session carries one; nothing invents a flag out of a slug.
			const geo = section('GEOGRAPHY',
				`${data.geography.areaCount} AREAS · ${formatDistance(data.geography.distanceM)} FLOWN`);
			const areaLines = data.geography.areas.slice(0, 12)
				.map((a) => `  ${fit(a.label, 30)} ${String(a.count).padStart(4)}`);
			geo.appendChild(pre(areaLines.length ? areaLines.join('\n') : '  NOWHERE YET', 'terminal-log'));
			geo.appendChild(pre(`COUNTRIES  ${data.geography.countries.length
				? data.geography.countries.map((c) => `${c.code} ${c.count}`).join(' · ')
				: '—'}`, 'terminal-foot'));
			// The way back to the one map with the traces drawn on it (#25). The
			// ENRICHED toggle does not exist yet: until the caller passes
			// `openMap`, this link is simply not there. THIS is the call site.
			if (openMap) {
				const row = linkRow();
				link(row, 'OPEN MAP — ENRICHED', () => behind(async () => openMap({ enriched: true })));
				geo.appendChild(row);
			}

			// 8. PROFILE — altitude against time for one flight, photos marked.
			// Opens on the last flight that HAS a track, not simply the last one.
			const profile = profileSeries(track);
			const prof = section('PROFILE', data.hasTracks
				? `${selectedLabel()} · ALTITUDE OVER TIME`
				: '');
			if (data.flights.length > 1) {
				const row = linkRow();
				link(row, 'PREVIOUS FLIGHT', () => step(-1));
				link(row, 'NEXT FLIGHT', () => step(1));
				prof.appendChild(row);
			}
			if (profile) {
				graph(prof, 160, (c) => steps(c, {
					points: profile.points.map((p) => ({ x: p.t, y: p.alt })),
					marks: profile.photos.map((p) => ({ x: p.t, y: p.alt })),
					height: 160, maxY: profile.maxAltM,
					formatX: (v) => `${Math.round(v)}s`, formatY: (v) => `${Math.round(v)}m`,
					xLabel: 'TIME',
				}));
				prof.appendChild(pre(`PEAK ${Math.round(profile.maxAltM)} m · ${duration(profile.durationS)}`
					+ ` · ${profile.photos.length} CAPTURES MARKED`, 'terminal-foot'));
			} else noTrack(prof, data.hasTracks ? 'LOADING…' : 'NO TRACK');

			// 9. RECORDS — the raw log at the bottom, unchanged, and everything
			// that is read rather than drawn.
			const rec = section('RECORDS', 'THE LOG · THE LAST SESSION · THE OPERATOR · THE NOTES');
			const row = linkRow();
			link(row, 'SESSION LOG', () => behind(async () => {
				const { runSessionLog } = await import('./session-log.js');
				return await runSessionLog(root, { operator: api.getOperator(), scenes });
			}));
			link(row, 'LAST SESSION', () => behind(async () => {
				const r = await lastSessionScreen(root, model);
				// lastSessionScreen yields a slug, or nothing.
				return typeof r === 'string' ? r : r ?? undefined;
			}));
			link(row, 'OPERATOR', () => behind(() => operatorScreen(root, api)));
			link(row, 'BUILD NOTES', () => behind(() => buildNotesScreen(root, api.getOperator())));
			rec.appendChild(row);

			paint();
			// A canvas measures nothing until the page has been laid out: the
			// second pass is what gives the graphs their real width.
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => { if (alive) paint(); });
			}
		};

		const selectedLabel = () =>
			data.flights.find((f) => f.id === selectedId)?.label ?? 'NO FLIGHT';

		// Walks the flights that have a track, in the order they were flown.
		const step = (dir) => {
			const i = data.flights.findIndex((f) => f.id === selectedId);
			const next = data.flights[Math.min(data.flights.length - 1, Math.max(0, i + dir))];
			if (!next || next.id === selectedId) return;
			selectedId = next.id;
			track = null;
			render();
			loadTrack();
		};

		const loadTrack = async () => {
			if (!selectedId) return;
			const wanted = selectedId;
			const t = await fetchTrack(operator?.id, wanted);
			if (!alive || wanted !== selectedId) return;
			track = t;
			render();
		};

		const title = document.createElement('pre');
		title.textContent = 'DATA';
		s.box.appendChild(title);
		s.box.appendChild(pre(`${data.sessionCount} SESSIONS ON RECORD`, 'terminal-foot'));
		s.box.appendChild(page);
		render();

		s.box.appendChild(button('BACK', () => done(), 'terminal-cta'));
		s.box.appendChild(ESC_ROOT());
		nav = menuNav(s.el, { back: () => done() });
		window.addEventListener('resize', onResize);

		// The index, then the one track the profile needs. Both are allowed to
		// fail: the page is already readable without them.
		(async () => {
			tracks = await fetchTrackIndex(operator?.id);
			if (!alive) return;
			data = dataModel({ sessions, tracks });
			if (!selectedId) selectedId = data.selectedId;
			render();
			await loadTrack();
		})();
	});
}

const round1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function formatDistance(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ---------- OPERATOR SELECT (carried over from the old home.js) ----------

export async function operatorSelect(root, choices) {
	const s = screen(root);
	s.box.innerHTML = '<pre>OPERATOR SELECT</pre>';
	return new Promise((resolve) => {
		const done = (value) => { nav.detach(); s.remove(); resolve(value); };
		for (const c of choices) {
			s.box.appendChild(button(c.name.toUpperCase(), () => done({ id: c.id }), 'terminal-cta'));
		}
		s.box.appendChild(button('+ NEW OPERATOR', () => done({ create: true }), 'terminal-cta'));
		// No `back`: an operator must be chosen — there is nowhere else to go.
		const nav = menuNav(s.el, {});
	});
}

// ---------- OPERATOR KEY (issue #60) ----------

// What an operator sees when a `shared` server does not recognise them: key
// missing, wrong, or a pre-#60 file that has none yet. Same template as
// OPERATOR SELECT above — it is the same moment of the game, minus a list: on a
// shared server there is nobody to choose from.
//
// [ NEW OPERATOR ] is the NORMAL path, and it comes first: the nominal case on
// a shared server is somebody arriving and leaving with a profile. Typing a
// key is an emergency door — you only go there if you already have a profile
// elsewhere — hence lower down and without a CTA.
//
// Resolves { create: true } for a bootstrap, { operator } when a key finds its
// operator again.
export async function operatorKey(root, api = operatorApi) {
	const s = screen(root);
	const title = document.createElement('pre');
	title.textContent = 'OPERATOR\n\nTHIS SERVER DOES NOT KNOW THIS BROWSER.';
	s.box.appendChild(title);

	return new Promise((resolve) => {
		let nav = null;
		const done = (value) => { nav?.detach(); s.remove(); resolve(value); };

		s.box.appendChild(button('NEW OPERATOR', () => done({ create: true }), 'terminal-cta'));

		const sub = document.createElement('pre');
		sub.className = 'terminal-sub';
		sub.textContent = 'ALREADY REGISTERED ELSEWHERE? ENTER YOUR OPERATOR KEY.';
		s.box.appendChild(sub);

		const input = document.createElement('input');
		input.type = 'text';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = 'K7QP-3MZX-…';
		s.box.appendChild(input);

		const err = document.createElement('div');
		err.className = 'bootstrap-err';
		s.box.appendChild(err);

		const submit = async () => {
			err.textContent = '';
			if (!input.value.trim()) { err.textContent = 'KEY REQUIRED'; return; }
			try { done({ operator: await api.resumeWithKey(input.value) }); }
			catch { err.textContent = 'UNKNOWN KEY'; }
		};
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		s.box.appendChild(button('RESUME', submit, 'terminal-link'));
		// No `back`: like OPERATOR SELECT, there is nowhere else to go. The
		// cursor lands on [ NEW OPERATOR ], not in the field: that is what the
		// person who has just arrived does.
		nav = menuNav(s.el, {});
	});
}

// ---------- terminal ----------

// Mounts the Operator Terminal and resolves the area to fly over.
// Resolves { slug } to fly a baked area, { live: [lat, lon] } to
// take off live from the scanner, or null to go back up to the mode choice
// when `back` is true (PHASE 26: the Home is no longer the game's root).
export async function runTerminal(root, { api = operatorApi, back = false } = {}) {
	let scenes = await fetchScenes();
	// `terminal-field` on top of `terminal-home`: the bench mounts its two
	// screens with `terminal-home` too (bench.js:72 and :196) to share its
	// typography. The two-column layout, though, belongs to FIELD alone —
	// hanging it off `terminal-home` put it on SELECT OPERATION MODE and on the
	// bench screen, which both ended up full width.
	const s = screen(root, 'terminal-home terminal-field');
	let resolveFly;

	let nav = null;
	// The area under the cursor: what [ FLY ] will fly and what the map frames.
	let selected = null;
	// The scanner handle. It is mounted ONCE and lives as long as the Home: it
	// owns the map, and the map is never unmounted between the rest state and
	// the working state (#211).
	let scanner = null;
	// True as soon as an area is drawn on the map. This is the LOCAL tab's
	// switch: the body of the left column goes from the list to the scanner's
	// rail.
	let drawing = false;
	// LOCAL or LIVE (#222). The two tabs share the head, the search and the
	// footer; only the body changes.
	let tab = lastTab;

	// --- the two columns, created ONCE
	//
	// FIELD is a single screen (Bible §4: "the GLOBAL SCANNER is the main menu
	// after initialisation"). On the left what you read and what you choose; on
	// the right the world. Only the left column is rebuilt — `right` and the map
	// node it contains are NEVER replaced, otherwise Leaflet would remount on
	// every re-render and the screen's promise would fall through.
	const left = document.createElement('div');
	left.className = 'terminal-left';
	const right = document.createElement('div');
	right.className = 'terminal-right';
	const mapHost = document.createElement('div');
	mapHost.className = 'terminal-map';
	right.appendChild(mapHost);
	// The scanner's three hosts, created once: the search above the tabs, the
	// LOCAL rail at work, the LIVE tab. The scanner fills them, the Home places
	// them.
	const searchHost = document.createElement('div');
	searchHost.className = 'terminal-search';
	const rail = document.createElement('aside');
	const liveRail = document.createElement('aside');
	s.box.append(left, right);

	const renderLeft = () => {
		const model = terminalModel({ operator: api.getOperator(), scenes, shared: sharedServer });
		const areas = Array.isArray(scenes) ? scenes : [];

		// Flying is what every session is for: the most frequent action gets a
		// direct entry and the resting cursor (issue #123, point 5) — the last
		// session's area if it is still on disk, otherwise the first local area.
		if (!selected || !areas.some((a) => a.slug === selected)) {
			selected = areas.find((a) => a.slug === model.lastSession?.area)?.slug
				?? areas[0]?.slug ?? null;
		}
		const flyArea = areas.find((a) => a.slug === selected) ?? null;

		left.replaceChildren();

		// D1: the version, and nothing else. The operator is greeted at the
		// root — once, where the game asks who you are.
		const head = document.createElement('pre');
		head.textContent = versionLine();
		left.appendChild(head);

		// The screen's NAME (Bible §4). FIELD is the GLOBAL SCANNER — the main
		// menu after initialisation — and it was the one screen family in the
		// game that never wrote its own name anywhere, in any of its three
		// states. It sits here, above the tabs, so the rest state, the drawing
		// rail and the LIVE rail all inherit it: one title, not three.
		const title = document.createElement('pre');
		title.className = 'sc-title';
		title.textContent = 'GLOBAL SCANNER';
		left.appendChild(title);

		// The search is shared by both tabs: all it does is move the map. Its host
		// stays empty until the scanner is mounted.
		left.appendChild(searchHost);

		// --- the tabs (#222)
		//
		// LOCAL: what is on the disk, and how to add an area to it.
		// LIVE: a pin and a live take-off. Two ways to fly, one map.
		const tabs = document.createElement('div');
		tabs.className = 'terminal-tabs';
		// LIVE first (D2): it is the path that works everywhere, on every build,
		// with nothing to download. LOCAL is the path of whoever has acquired.
		for (const [id, label] of [['live', 'LIVE'], ['local', 'LOCAL']]) {
			const b = button(label, () => setTab(id), 'terminal-tab');
			b.dataset.on = String(tab === id);
			// Dimmed but still selectable: the state is read BEFORE the click,
			// and areas a host pre-installed stay reachable.
			// Dimmed on a SHARED server only: a local install with acquisition
			// closed still flies whatever terrain is on its disk.
			if (id === 'local' && sharedServer) b.dataset.off = 'true';
			tabs.appendChild(b);
		}
		left.appendChild(tabs);

		// The LOCAL tab of a shared server opens by SAYING so (D2). Three lines
		// at the head of the body, before any list: they absorb the old "SWITCH
		// TO LIVE TO FLY" line and the old "DESKTOP CLIENT AVAILABLE" footer,
		// which said the same thing twice, elsewhere, and never where the
		// operator was wondering why the list is empty.
		// V1: keyed on the SERVER MODE, not on the acquisition right. Telling the
		// desktop client to "install the desktop client" is the bug this fixes.
		if (tab === 'local' && sharedServer) {
			const notice = document.createElement('pre');
			notice.className = 'terminal-notice';
			// The third line used to read "INSTALL THE DESKTOP CLIENT". It sent
			// the operator somewhere acquisition also fails: the desktop build
			// starts its server in `local` mode but never sets FPVTP_ACQUIRE, and
			// acquireEnabled() is closed without it. No shipped build acquires, so
			// no screen may promise that one does — the notice now says what this
			// server does, and stops there.
			notice.textContent = [
				'LOCAL TERRAIN IS NOT AVAILABLE ON THIS SERVER.',
				'THIS SERVER FLIES LIVE ONLY — SWITCH TO THE LIVE TAB.',
				'AREAS ALREADY ON DISK STAY FLYABLE ON A LOCAL INSTALL.',
			].join('\n');
			left.appendChild(notice);
		}

		if (tab === 'live') {
			left.appendChild(liveRail);
		} else if (drawing) {
			// WORKING state: an area is drawn, the body becomes the scanner's
			// rail. The map has not moved by a single pixel — which is the entire
			// point of this screen.
			left.appendChild(rail);
		} else {
			// --- the only thing that takes off
			const acts = document.createElement('div');
			acts.className = 'terminal-acts';
			if (flyArea) {
				acts.appendChild(button(`FLY — ${flyArea.name.toUpperCase()}`, () => fly(flyArea.slug), 'terminal-cta'));
			}
			left.appendChild(acts);

			// --- the terrain cache
			//
			// The list SELECTS, it does not fly: clicking an area reframes the map
			// and relabels the CTA. [ FLY ] stays the only thing that takes off —
			// two ways to leave would be two axes on a screen that wants one.
			if (areas.length) {
				const h = document.createElement('pre');
				h.className = 'terminal-sub';
				h.textContent = 'LOCAL TERRAIN';
				left.appendChild(h);

				const list = document.createElement('div');
				list.className = 'terminal-areas terminal-areas-compact';
				for (const sc of areas.slice(0, COMPACT_AREAS)) {
					const row = areaRow(sc, { onActivate: (picked) => pickArea(picked.slug) });
					if (sc.slug === selected) row.dataset.selected = '1';
					list.appendChild(row);
				}
				left.appendChild(list);
			} else {
				// Three cases, three sentences (V1). Acquisition open: the map is
				// where a new area comes from. Shared server: the notice at the
				// head of the tab has already said everything, and repeating it
				// here would say the same phrase twice in one column. Local
				// install with acquisition closed: neither of those — the disk is
				// simply empty, and the LIVE tab is the way to fly today.
				if (acquireAllowed) {
					left.appendChild(emptyState('NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP'));
				} else if (!sharedServer) {
					left.appendChild(emptyState('NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY'));
				}
			}

			// ALL TERRAIN… only appears when there is really something to
			// search, sort or remove — it is the full screen, unchanged. It has
			// been alone on its row since ARCHIVE moved to the root (D3).
			if (areas.length) left.appendChild(navRow([['ALL TERRAIN…', async () => {
				s.el.hidden = true;
				const slug = await localTerrain(root, scenes);
				if (slug) return fly(slug);
				scenes = await fetchScenes();
				scanner?.setAreaFrames(Array.isArray(scenes) ? scenes : []);
				scanner?.refreshCoverage();
				s.el.hidden = false;
				renderLeft();
			}]]));

			// Drawing is not flying, but you have to be able to start: at rest the
			// rail is hidden, and both draw tools with it. A click arms the tool
			// and puts the screen to work — the source, the name and the
			// acquisition then arrive with the rail.
			// … and only where a scene is allowed to be born on disk (#60).
			// Without that right only the LIVE tab remains, which has carried the
			// full loop since #218. The guard that counts is on POST
			// /__map-api/jobs: here we merely refrain from offering what the
			// server will refuse.
			if (scanner && acquireAllowed) {
				const draw = (shape) => () => { drawing = true; renderLeft(); scanner.startDraw(shape); };
				const row = document.createElement('div');
				row.className = 'terminal-acts';
				row.append(
					// Arming a tool is not making a decision: no brackets, exactly
					// like the same buttons in the scanner rail (scanner.js,
					// .sc-btn). Brackets stay with the CTAs.
					button('DRAW BOX', draw('Rectangle'), 'terminal-tool'),
					button('DRAW SHAPE', draw('Polygon'), 'terminal-tool'),
				);
				left.appendChild(row);
			}
		}

		// --- the footer: where the game runs, and nothing more
		//
		// No row of links any more (D4, D6): MODE only did what Escape already
		// does, and SETTINGS moved to the root. A menu that repeats its exits on
		// every floor has no floors.
		const foot = document.createElement('pre');
		foot.className = 'terminal-foot';
		foot.textContent = model.footer;
		left.appendChild(foot);
		countUp(foot);

		// The imagery credit, before the flight as well as during it.
		//
		// A LIVE take-off streams Google's 3D imagery, and Google requires the
		// copyright of rendered tiles to be displayed. In flight the OSD says it
		// (fpvtp-osd.js setCredit, main.js LIVE_CREDIT). It is an obligation,
		// not a nicety: DATA level in --light-grey, never the --faint of a
		// decorative note.
		//
		// It sits at the FOOT of the column rather than under the LIVE rail: a
		// legal notice belongs with the other legal notices — the licence, the
		// source — not wedged between the rail and the thing that takes off,
		// where it read as a step in the flow.
		//
		// The same literal as the OSD, deliberately, so the two cannot disagree:
		// the per-node copyright ids the tile workers decode are still dropped
		// before they could become text, and inventing a different wording here
		// would only make the disagreement look intentional. LIVE only: LOCAL
		// flies terrain already on disk, whose credit travelled with it.
		if (tab === 'live') {
			const credit = document.createElement('pre');
			credit.className = 'terminal-credit';
			credit.textContent = `LIVE IMAGERY ${LIVE_IMAGERY_CREDIT}`;
			left.appendChild(credit);
		}

		// The bridge to the source, and the AGPL's section 13: anyone
		// interacting with this program over a network must be OFFERED the
		// corresponding source, and a player on someone else's instance never
		// sees the repository, the LICENSE file or the README. The offer has to
		// be inside the program, so it sits on the one screen every session
		// passes through.
		left.appendChild(metaHead(SOURCE_CALL));
		left.appendChild(sourceLink());

		// And the tip jar, which is a different kind of offer and says so by
		// standing in its own category with its own line.
		//
		// FIELD is left MOUNTED and visible under the window: the map, the pin
		// and the selected area stay exactly where they were, which is what makes
		// this a window rather than a detour. menuNav takes care of itself — the
		// active nav is the topmost one on the stack, so the window has the
		// keyboard for as long as it is open. On the way out the cursor goes back
		// to the mark that opened it, not to the top of the column.
		left.appendChild(metaHead(SUPPORT_TAGLINE));
		left.appendChild(tipRow((group, mark) => {
			tipWindow(root, group, () => mark.focus());
		}));

		// D15: Escape goes back up, and it says so — but it must say what Escape
		// ACTUALLY does in the state on screen. While an area is drawn, Escape
		// puts the tool down (see the nav below) and does not leave FIELD; while
		// an acquisition runs it does nothing at all, and the rail's own
		// [ ABORT ] / [ LEAVE — KEEPS RUNNING ] are the exits. A hint that names
		// the wrong destination is worse than no hint.
		if (scanner?.busy()) {
			// Nothing: the two rail buttons are the only ways out of a running job.
		} else if (drawing && tab === 'local') {
			left.appendChild(keyHints([['ESC', 'BACK']]));
		} else if (back) {
			left.appendChild(ESC_ROOT());
		}
		// "One key to fly" (issue #123): the cursor lands on [ FLY ], not on the
		// search box nor on a tab, both of which now precede it in the column
		// (#222).
		const cta = [...left.querySelectorAll('button')].find((b) => b.textContent.startsWith('[ FLY'));
		if (cta) cta.focus(); else nav?.focusAt(0);
	};

	const setTab = (id) => {
		if (tab === id) return;
		tab = lastTab = id;
		scanner?.setMode(id);
		renderLeft();
	};

	// Selecting an area reframes the map and relabels [ FLY ]. ONLY the left
	// column is rebuilt: re-rendering everything would remount the map, which is
	// what this screen promises never to do.
	const pickArea = (slug) => {
		selected = slug;
		const sc = (Array.isArray(scenes) ? scenes : []).find((a) => a.slug === slug);
		if (sc) scanner?.focusBounds(previewBounds(sc));
		// A frame clicked on the map is a LOCAL selection, even from LIVE.
		if (tab !== 'local') { tab = lastTab = 'local'; scanner?.setMode('local'); }
		renderLeft();
	};

	// Every exit goes through here. `s.remove()` destroys the map node but not
	// the listeners Leaflet put on window: destroy() is what calls map.remove(),
	// without which a Home opened three times leaves three live maps behind.
	const quit = (value) => { scanner?.destroy(); scanner = null; nav?.detach(); s.remove(); resolveFly(value); };
	const fly = (slug) => quit({ slug });
	// Live flight. The Home only FORWARDS, reading nothing and deciding nothing:
	// the scanner attaches to the point the survey it has just made of the area
	// (signal density, place name), and fieldLoop() is what knows what a live
	// flight means.
	const flyLive = (live) => quit(live);
	// One step up: SELECT OPERATION MODE. Since PHASE 26 the Home is no longer
	// the root — but it still is for ?scene=, which skips the mode choice, hence
	// the flag rather than an unconditional `back`.
	const leave = () => quit(null);

	renderLeft();
	// Escape / B: at work, puts the tool down (the rail no longer has a nav of
	// its own, #222); at rest, goes back up to the mode choice if it can.
	nav = menuNav(s.el, {
		// renderLeft() has already put the cursor on [ FLY ]; focusFirst would
		// move it onto the LOCAL tab.
		focusFirst: false,
		back: () => {
			if (scanner?.busy()) return;
			if (drawing && tab === 'local') return scanner?.rest();
			if (back) leave();
		},
	});

	// The scanner is mounted after the first render: the Home must hold even if
	// it never arrives (offline, missing chunk). Without it the right column
	// stays empty and everything else works — which is already what the #208
	// thumbnail did.
	import('./scanner.js')
		.then(({ runScanner }) => {
			if (!mapHost.isConnected) return;
			scanner = runScanner({
				mapHost,
				searchHost,
				railHost: rail,
				liveHost: liveRail,
				// A drawn area puts the screen to work; clearing it does NOT take
				// it back out — you may want to redraw. BACK is what puts the tool
				// down.
				onZone: (zone) => { if (zone) { drawing = true; renderLeft(); } },
				onPickArea: pickArea,
				onRest: () => { drawing = false; renderLeft(); },
				// An acquisition resumed at mount time: the rail must be visible.
				onBusy: () => { drawing = true; tab = lastTab = 'local'; renderLeft(); },
			});
			scanner.setMode(tab);
			scanner.setAreaFrames(Array.isArray(scenes) ? scenes : []);
			scanner.refreshCoverage();
			// The scanner arrives after the first render: the left column has to
			// be rebuilt to show DRAW BOX / DRAW SHAPE, which mean nothing
			// without it.
			renderLeft();
			// A baked area is flown by its slug; a live take-off travels back up
			// as-is to fieldLoop(), which knows how to run it through bootLive().
			scanner.done.then((choice) => {
				if (choice?.slug) return fly(choice.slug);
				if (choice?.live) return flyLive(choice);
			});
		})
		.catch(() => {
			mapHost.appendChild(emptyState('NO MAP LINK', 'terminal-map-none'));
		});

	return new Promise((resolve) => { resolveFly = resolve; });
}
