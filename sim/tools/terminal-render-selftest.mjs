// Selftest of the Home SCREEN (Operator Terminal), mounted on the fake DOM of
// tools/lib/fake-dom.mjs. Same intent as bench-render-selftest.mjs: it checks
// the TREE and the WIRING — what the Home shows, what it hides, and what
// happens when it is operated. Appearance is judged by eye, not here.
//
// This selftest was not possible before PHASE 27: the Home was built with
// innerHTML, which fake-dom refuses ("build the tree with createElement").
//
// Run: node tools/terminal-render-selftest.mjs

import assert from 'node:assert/strict';
import { ADDRESSES, HANDLE, TIP_BUTTONS } from './support-model.mjs';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

// The Home queries the terrain cache and the world weather. Neither exists
// without a dev server: they are replaced, to test the screen and not the
// network. `fetch` must exist BEFORE terminal.js is imported.
const SCENES = [
	{ slug: 'paristest', name: 'paristest', bytes: 109e6, lat: 48.8499, lon: 2.3419,
		bbox: { south: 48.8483, west: 2.3385, north: 48.8516, east: 2.3453 } },
	{ slug: 'cnam', name: 'Conservatoire', bytes: 168e6, lat: 48.8668, lon: 2.3562,
		bbox: { south: 48.8641, west: 2.3521, north: 48.8694, east: 2.3602 } },
];
let scenesReply = SCENES;
// The right to acquire, as the server announces it (#60). Closed by default:
// that is the state of every distributed build.
let acquireReply = false;
// The server MODE (V1): 'local' | 'shared'. It, and not the right to acquire,
// decides the footer and the LOCAL tab notice — a distributed build has
// acquisition closed and is still a local installation.
let modeReply = 'local';
// Every DELETE the screen actually issues. A destructive action that is armed
// must send NOTHING on the first press, and this is what proves it.
const deleted = [];
globalThis.fetch = async (url, opts) => {
	if (String(url).includes('/__map-api/scenes')) {
		if (opts?.method === 'DELETE') { deleted.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; }
		if (scenesReply === null) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ scenes: scenesReply, acquire: acquireReply, mode: modeReply }) };
	}
	// worldWeather: no bulletin, the weather line stays empty. That is already
	// the offline behaviour, and the screen must hold without it.
	return { ok: false, status: 503, json: async () => ({}) };
};

const { runTerminal, operatorKey } = await import('../src/terminal.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => {
	dom.root.replaceChildren(); dom.setActive(null);
	scenesReply = SCENES; acquireReply = false; modeReply = 'local'; deleted.length = 0;
};
// The exact label first ("MODE", "ARCHIVE"), then the bracketed CTA, and only
// then a prefix ("FLY — "). A plain `includes` took an area row for the footer:
// the offline weather is seeded per day, and "MODERATE WIND" contains "MODE" —
// the selftest hung on some days, the clicked area row never resolving the
// screen.
const btn = (label) => {
	const all = dom.root.querySelectorAll('button');
	return all.find((b) => b.textContent === label)
		?? all.find((b) => b.textContent === `[ ${label} ]`)
		?? all.find((b) => b.textContent.startsWith(label) || b.textContent.startsWith(`[ ${label}`));
};
const text = () => dom.root.textContent;
// The tab open on entry is LIVE (D2): the tests that speak of the terrain cache
// switch to LOCAL first, like an operator who has already acquired.
const openLocal = async () => {
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
};

// A minimal operator: terminalModel() needs no more than this.
const operator = (over = {}) => ({
	name: 'neo', createdAt: '2026-09-01T10:00:00.000Z', sessions: [], ...over,
});
const api = (op) => ({ getOperator: () => op, patch: () => {}, flush: async () => {} });

// FIELD resolves some form of flight; it is closed with Escape so nothing
// flies. There is no MODE button any more (D4): Escape IS the way back up, and
// D15 names it.
const close = async (p) => { dom.key('Escape'); return p; };

// --- D2: LIVE first ---------------------------------------------------------
//
// THIS TEST MUST STAY FIRST: `lastTab` is a page-load memory, shared by this
// whole file. Here, and only here, can the tab open on the FIRST entry into
// FIELD be observed.
await ta('home: LIVE is the first tab, and the open one', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const tabs = dom.root.querySelectorAll('.terminal-tab');
	assert.deepEqual(tabs.map((b) => b.textContent), ['LIVE', 'LOCAL'], 'LIVE leads');
	assert.equal(tabs[0].dataset.on, 'true', 'and is open on entry');
	await close(p);
});

await ta('home: the map, then the only thing that takes off', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));   // fetchScenes()
	await openLocal();
	assert.ok(dom.root.querySelector('.terminal-map'), 'the map frame');
	assert.ok(btn('FLY — PARISTEST'), 'the flight CTA, labelled by the area');
	await close(p);
});

await ta('home: FIELD does nothing but fly now', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	// D3/D4/D6: ARCHIVE and SETTINGS moved up to the root, MODE is gone. FIELD
	// keeps only what makes something take off (Bible §30).
	for (const gone of ['SESSION LOG', 'TARGET LOG', 'OPERATOR', 'BUILD NOTES',
		'ARCHIVE', 'SETTINGS', 'MODE']) {
		assert.equal(btn(gone), undefined, `"${gone}" is no longer on FIELD`);
	}
	await close(p);
});

await ta('home: the head no longer greets, and the footer no longer counts', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	// D1: the operator is greeted at the root, once. FIELD is a workstation, not
	// a dashboard.
	assert.doesNotMatch(text(), /OPERATOR/, 'neither in the head nor in the foot');
	for (const gone of ['LOCAL AREAS', 'TARGETS LOGGED', 'SESSIONS']) {
		assert.ok(!text().includes(gone), `"${gone}" has left the footer`);
	}
	await close(p);
});

// --- Bible §4: the screen has a name ----------------------------------------

await ta('home: FIELD writes its own name, in every state', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const title = dom.root.querySelector('.sc-title');
	assert.ok(title, 'the flagship screen is named');
	assert.equal(title.textContent, 'GLOBAL SCANNER');
	// Above the tabs, so the LOCAL rest state and the LIVE rail inherit it: one
	// title, not one per state.
	await openLocal();
	assert.equal(dom.root.querySelector('.sc-title').textContent, 'GLOBAL SCANNER');
	await close(p);
});

await ta('home: on a SHARED server, LOCAL SAYS SO instead of being empty', async () => {
	reset();
	modeReply = 'shared';
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	// Dimmed but still selectable: the state is read BEFORE the click, and areas
	// the host pre-installed stay reachable.
	assert.equal(local.dataset.off, 'true', 'the tab is dimmed');
	local.click();
	await new Promise((r) => setTimeout(r, 0));
	const notice = dom.root.querySelector('.terminal-notice');
	assert.ok(notice, 'a notice block at the head of the LOCAL body');
	assert.match(notice.textContent, /NOT AVAILABLE ON THIS SERVER/);
	assert.match(notice.textContent, /SWITCH TO THE LIVE TAB/);
	// It must NOT send anyone to the desktop client to acquire: that build
	// starts its server in `local` mode and never sets FPVTP_ACQUIRE either, so
	// acquisition fails there too. No screen may promise a path no shipped build
	// walks.
	assert.ok(!notice.textContent.includes('DESKTOP CLIENT'), 'no promise of a path that also fails');
	// Absorbed by the notice: they must not linger anywhere else on screen.
	assert.ok(!text().includes('DESKTOP CLIENT AVAILABLE'));
	assert.ok(!text().includes('SWITCH TO LIVE TO FLY'));
	assert.equal(dom.root.querySelectorAll('.terminal-foot-hint').length, 0);
	await close(p);
});

await ta('home: on a local installation, LOCAL has nothing to announce', async () => {
	reset();
	acquireReply = true;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	assert.equal(local.dataset.off, undefined, 'the tab is lit');
	assert.equal(dom.root.querySelector('.terminal-notice'), null);
	await close(p);
});

await ta('home: local installation with no acquisition — no notice, no dimmed tab', async () => {
	// V1: the default of every distributed build. It does not acquire, but it is
	// not "this server": the desktop client does not tell itself to install the
	// desktop client.
	reset();
	scenesReply = [];
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const local = dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL');
	assert.equal(local.dataset.off, undefined, 'the tab stays lit');
	local.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelector('.terminal-notice'), null, 'no shared-server notice');
	assert.ok(!text().includes('DESKTOP CLIENT'));
	assert.ok(text().includes('NO LOCAL TERRAIN — SWITCH TO LIVE TO FLY'), 'just the empty disk');
	assert.ok(dom.root.querySelector('.terminal-foot').textContent.startsWith('LOCAL INSTALLATION'));
	await close(p);
});

// --- D15: Escape is named ---------------------------------------------------

await ta('home: Escape is written down, and it says where it leads', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const keys = dom.root.querySelector('.terminal-keys');
	assert.ok(keys, 'the key line');
	assert.equal(keys.textContent, '[ESC] OPERATION MODE');
	await close(p);
});

await ta('home: the cursor lands on FLY, not on an area', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	// "One key to fly" (issue #123). The map is not focusable, so nothing must
	// come between opening the screen and taking off.
	assert.ok(dom.active?.textContent.includes('FLY —'), `cursor on FLY, not on "${dom.active?.textContent}"`);
	await close(p);
});

await ta('home: picking an area reframes and relabels, but does not fly', async () => {
	reset();
	let resolved = false;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	p.then(() => { resolved = true; });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.ok(btn('FLY — PARISTEST'), 'at the start, the first area');

	dom.root.querySelectorAll('.terminal-area').find((r) => r.dataset.slug === 'cnam').click();
	await new Promise((r) => setTimeout(r, 0));

	assert.ok(btn('FLY — CONSERVATOIRE'), 'the CTA follows the selection');
	// The point of batch 4: a single axis. The list picks, [ FLY ] takes off.
	assert.equal(resolved, false, 'selecting an area does not fly');
	await close(p);
});

await ta('home: the area flown is the one selected', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	dom.root.querySelectorAll('.terminal-area').find((r) => r.dataset.slug === 'cnam').click();
	await new Promise((r) => setTimeout(r, 0));
	btn('FLY —').click();
	assert.deepEqual(await p, { slug: 'cnam' });
	assert.equal(dom.root.children.length, 0, 'nothing is left in #ui');
});

await ta('home: [ FLY ] leaves on the last session\'s area', async () => {
	reset();
	const op = operator({ sessions: [{ id: 's1', area: 'cnam', result: 'CRASHED', end: '2026-09-04T12:00:00.000Z' }] });
	const p = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	// Coming back to the same ground is the common gesture (Bible §7): it must
	// not cost one more selection.
	assert.ok(btn('FLY — CONSERVATOIRE'), 'the last session\'s area');
	await close(p);
});

await ta('home: the footer is exactly the model\'s', async () => {
	reset();
	const op = operator();
	const p = runTerminal(dom.root, { settings: null, api: api(op), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const { terminalModel } = await import('./terminal-model.mjs');
	const expected = terminalModel({ operator: op, scenes: SCENES, shared: false }).footer;
	const foot = dom.root.querySelector('.terminal-foot');
	// The footer counters are the non-regression seal of BENCH and of live
	// flight: they must stay word for word the model's.
	assert.equal(foot.textContent, expected);
	await close(p);
});

await ta('home: with no terrain, the map stays the entrance', async () => {
	// Since #211 there is no [ GLOBAL SCANNER ] CTA any more: the scanner's map
	// IS the right column, and you go looking for terrain by drawing on it. So
	// the left column has to say so, otherwise a new operator sees nothing but
	// an empty screen next to a map.
	reset();
	scenesReply = [];
	acquireReply = true;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LOCAL').click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(btn('FLY —'), undefined, 'nothing to fly');
	assert.ok(dom.root.querySelector('.terminal-map'), 'the map is there, and it is the way out');
	assert.ok(text().includes('NO LOCAL TERRAIN — DRAW AN AREA ON THE MAP'), 'and the left column says so');
	// One empty state, one treatment (Bible §39): DATA level, not the DISPLAY
	// face a bare <pre> inherits from the box.
	assert.ok(dom.root.querySelector('.terminal-empty'), 'and it is written as an empty state');
	assert.equal(btn('ALL TERRAIN…'), undefined, 'no ALL TERRAIN… on an empty list');
	await close(p);
});

await ta('home: unreachable cache — the Home mounts anyway', async () => {
	reset();
	scenesReply = null;
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(dom.root.querySelector('.terminal-right'), 'the screen holds');
	assert.ok(dom.root.querySelector('.terminal-foot'), 'and so does the footer');
	await close(p);
});

await ta('home: with nowhere to go back to, no key is announced', async () => {
	reset();
	// ?scene= skips the mode choice: FIELD is still the root there, and
	// announcing "[ESC] OPERATION MODE" would promise a screen that does not
	// exist.
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: false });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.equal(dom.root.querySelector('.terminal-keys'), null, 'no key line without back');
	assert.equal(btn('MODE'), undefined, 'and still no MODE');
	btn('FLY —').click();
	await p;
});

// --- FIELD is a single screen (#211) ----------------------------------------

await ta('home: two columns, and the map is in the right one', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const left = dom.root.querySelector('.terminal-left');
	const right = dom.root.querySelector('.terminal-right');
	assert.ok(left, 'the menu column');
	assert.ok(right, 'the world column');
	assert.ok(right.querySelector('.terminal-map'), 'the map is on the right');
	assert.equal(left.querySelector('.terminal-map'), null, 'and not on the left');
	await close(p);
});

await ta('home: the [ GLOBAL SCANNER ] button is gone — there is no elsewhere left', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	assert.equal(btn('GLOBAL SCANNER'), undefined, 'the screen is NAMED, not offered as a destination');
	assert.ok(btn('FLY —'), 'FLY stays the only thing that takes off');
	await close(p);
});

await ta('home: the map SURVIVES a re-render of the left column', async () => {
	// This is the screen's central promise. If this test falls, the merge is
	// pointless: two screens would do. It compares the node REFERENCE, not its
	// presence — a rebuilt equivalent would be a Leaflet remount.
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	const map = dom.root.querySelector('.terminal-map');
	const right = dom.root.querySelector('.terminal-right');
	dom.root.querySelectorAll('.terminal-area').at(1).click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(dom.root.querySelector('.terminal-map'), map, 'the SAME map node');
	assert.equal(dom.root.querySelector('.terminal-right'), right, 'the SAME column');
	await close(p);
});

await ta('home: the LIVE tab credits the imagery it is about to stream', async () => {
	// Google requires the copyright of rendered tiles to be displayed. The OSD
	// says it in flight; the screen that OFFERS the imagery said nothing, which
	// is an attribution gap rather than a design one.
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	// `lastTab` is a page-load memory shared by this whole file, so LIVE is
	// selected explicitly rather than assumed.
	dom.root.querySelectorAll('.terminal-tab').find((b) => b.textContent === 'LIVE').click();
	await new Promise((r) => setTimeout(r, 0));
	const credit = dom.root.querySelector('.terminal-credit');
	assert.ok(credit, 'the LIVE tab carries a credit line');
	assert.match(credit.textContent, /\u00a9 Google/, 'the same literal the flight OSD paints');
	// And it sits at the FOOT of the column, with the other legal notices,
	// not wedged between the LIVE rail and the thing that takes off.
	const column = [...dom.root.querySelector('.terminal-left').children];
	assert.ok(column.indexOf(credit) > column.findIndex((e) => e.className?.includes('terminal-foot')),
		'the credit comes after the build footer');
	// And it belongs to LIVE: LOCAL flies terrain already on disk, whose credit
	// travelled with the acquisition.
	await openLocal();
	assert.equal(dom.root.querySelector('.terminal-credit'), null);
	await close(p);
});

// --- ALL TERRAIN: the destructive action, and an untrusted area name ---------

// Opens FIELD, switches to LOCAL, walks into ALL TERRAIN… and opens the first
// row's actions. That row is the only place in the game where a baked area is
// destroyed, and the only place a scene name reaches a screen of its own.
const openAreaActions = async () => {
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	await openLocal();
	btn('ALL TERRAIN…').click();
	await new Promise((r) => setTimeout(r, 0));
	// The LAST row: FIELD stays mounted underneath (only `hidden`), so its own
	// compact list is still in the tree and comes first.
	dom.root.querySelectorAll('.terminal-area').at(-1).click();
	await new Promise((r) => setTimeout(r, 0));
	// WRAPPED: `await` on an async function that RETURNED this promise would
	// unwrap it, and wait on a screen that has not been closed yet.
	return { p };
};

// ALL TERRAIN… stacks screens on top of FIELD, and each one answers Escape in
// turn. Pressing it a bounded number of times unwinds the stack whatever depth
// the test left it at; the presses that land after FIELD is gone reach a
// detached nav and do nothing.
const unwind = async (p) => {
	for (let i = 0; i < 4; i++) { dom.key('Escape'); await new Promise((r) => setTimeout(r, 0)); }
	return p;
};

await ta('all terrain: REMOVE TERRAIN is one operation, one label, and it is armed', async () => {
	reset();
	const { p } = await openAreaActions();
	// The FIRST row's actions are hidden but still in the tree, so the removal
	// is looked up inside the row that was actually opened.
	const row = dom.root.querySelectorAll('.terminal-area-actions').at(-1);
	const remove = row.querySelectorAll('button').find((b) => b.textContent.includes('REMOVE'));
	// The scanner has always called this `[ REMOVE TERRAIN ]`; this row called it
	// `REMOVE`, as a bare inline link, and deleted hundreds of megabytes on one
	// press. Same operation, same words, same treatment.
	assert.ok(remove, 'the row offers REMOVE TERRAIN');
	assert.equal(remove.textContent, '[ REMOVE TERRAIN ]', 'a CTA, with its brackets');
	assert.ok(!text().includes('REMOVE\n'), 'and no second, differently spelled removal is offered');

	remove.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(remove.textContent, '[ REMOVE TERRAIN — CONFIRM ]', 'the first press only arms');
	assert.deepEqual(deleted, [], 'and nothing has been deleted');

	remove.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(deleted, ['/__map-api/scenes/paristest'], 'the second press is the confirmation');
	await unwind(p);
});

await ta('forecast: an area name is rendered as text, never as markup', async () => {
	// `scene.name` is auto-filled from a Nominatim `display_name` (scanner.js):
	// it is a third party's HTTP response, not the player's text and not ours.
	// It used to be interpolated into innerHTML in the origin that holds the
	// operator bearer key. fake-dom refusing every non-empty innerHTML is half
	// the guard; this is the other half.
	reset();
	const HOSTILE = '<img src=x onerror=alert(1)>PARIS';
	scenesReply = [{ ...SCENES[0], name: HOSTILE }];
	const { p } = await openAreaActions();
	dom.root.querySelectorAll('.terminal-area-actions').at(-1)
		.querySelectorAll('button').find((b) => b.textContent === 'FORECAST').click();
	await new Promise((r) => setTimeout(r, 0));
	const box = dom.root.querySelectorAll('.terminal-box').at(-1);
	assert.match(box.textContent, /^FORECAST \/\//, 'the forecast screen is the one on top');
	assert.ok(box.textContent.includes(HOSTILE.toUpperCase()), 'the name is on screen, verbatim');
	// Not "no <img> anywhere": the footer legitimately carries one, the source
	// mark, whose src is a data: URI built from a static table. What must not
	// exist is an element that came from the STRING — so the check names the
	// payload instead of counting tags, which also makes it survive the next
	// legitimate image.
	for (const img of dom.root.querySelectorAll('img')) {
		const src = img.getAttribute?.('src') ?? img.src ?? '';
		assert.ok(String(src).startsWith('data:'),
			`an <img> was built from the hostile name: src=${src}`);
		assert.equal(img.getAttribute?.('onerror') ?? null, null, 'no onerror survived');
	}
	await unwind(p);
});

await ta('home: the source is offered, which the AGPL requires of a network instance', async () => {
	// Section 13: a player interacting with this program over a network must be
	// OFFERED the corresponding source. On someone else's instance they never
	// see the repository, the LICENSE file or the README, so the offer has to be
	// in the program. This is the test that it stays there.
	reset();
	modeReply = 'shared';
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const link = dom.root.querySelectorAll('.terminal-source').at(-1);
	assert.ok(link, 'the source link is on the root screen');
	assert.match(link.getAttribute('href'), /^https:\/\/github\.com\//, 'it points at the repository');
	// The word SOURCE is the category heading now and the licence is the link's
	// own text: the mark says WHERE, the words say WHAT and under what terms.
	// Both halves are asserted, because half an offer is not one.
	const heads = dom.root.querySelectorAll('.terminal-meta-head').map((e) => e.textContent);
	assert.ok(heads.some((h) => h.includes('SOURCE')), 'the offer is named');
	assert.match(link.textContent, /AGPL-3\.0/, 'and made under stated terms');
	// target=_blank is load-bearing, not cosmetic: electron/main.js refuses to
	// navigate the window off its own origin, so without it the desktop app
	// swallows the click and the offer is a dead link.
	assert.equal(link.getAttribute('target'), '_blank', 'opens outside, or Electron blocks it');
	assert.match(link.getAttribute('rel') ?? '', /noopener/, 'and does not hand over the opener');
	await close(p);
});

await ta('tips: three marks, and each one opens its own addresses whole', async () => {
	// support-selftest.mjs proves the addresses are valid; this proves the
	// windows do not mangle them on the way out. An address shortened with an
	// ellipsis for layout is an address a donor cannot check against what their
	// wallet pasted, which is the only defence they have — so the assertion is
	// character-for-character.
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));

	const marks = dom.root.querySelectorAll('.terminal-tip-btn');
	assert.equal(marks.length, TIP_BUTTONS.length, 'one mark per currency');
	// Each tile names its coin under the mark. Three unlabelled glyphs in a
	// corner are something to decipher, and nobody gives to a puzzle.
	for (const [i, b] of marks.entries()) {
		assert.ok(b.textContent.includes(TIP_BUTTONS[i].alt), 'the tile names its coin');
		assert.ok(b.querySelectorAll('img').length, 'and carries its mark');
	}

	for (const [i, group] of TIP_BUTTONS.entries()) {
		dom.root.querySelectorAll('.terminal-tip-btn').at(i).click();
		await new Promise((r) => setTimeout(r, 0));
		const box = dom.root.querySelectorAll('.terminal-box').at(-1);
		assert.ok(box.textContent.includes(group.title), `${group.id}: the window says which coin`);
		for (const e of group.entries) {
			assert.ok(box.textContent.includes(e.address), `${group.id}: ${e.id} is on screen in full`);
		}
		assert.doesNotMatch(box.textContent, /\u2026|\.\.\./, `${group.id}: nothing is elided`);
		// BACK returns to FIELD with the map untouched — opening a tip window
		// must cost a player nothing.
		box.querySelectorAll('button').find((b) => b.textContent === '[ BACK ]').click();
		await new Promise((r) => setTimeout(r, 0));
	}

	// Every address, and the handle, reachable from the footer.
	const all = TIP_BUTTONS.flatMap((g) => g.entries.map((e) => e.address));
	for (const a of ADDRESSES) assert.ok(all.includes(a.address), `${a.id}: unreachable`);
	assert.ok(all.includes(HANDLE), 'the readable handle has a window too');
	await close(p);
});

// --- OPERATOR KEY -----------------------------------------------------------

const keyApi = (over = {}) => ({
	resumeWithKey: async () => { throw new Error('bad operator key'); }, ...over,
});

await ta('operator key: NEW OPERATOR first, the key as a fallback — and nothing to choose', async () => {
	reset();
	const p = operatorKey(dom.root, keyApi());
	const buttons = dom.root.querySelectorAll('button');
	// The ORDER is the message: the nominal case on a shared server is somebody
	// arriving and leaving with a profile.
	assert.equal(buttons[0].textContent, '[ NEW OPERATOR ]', 'the first button on the screen');
	assert.ok(dom.root.querySelector('input'), 'the key field, further down');
	// RESUME is not a CTA: typing a key is an emergency door.
	assert.equal(btn('RESUME').className, 'terminal-link');
	assert.match(text(), /THIS SERVER DOES NOT KNOW THIS BROWSER/);
	btn('NEW OPERATOR').click();
	assert.deepEqual(await p, { create: true });
});

await ta('operator key: a valid key returns the operator', async () => {
	reset();
	const seen = [];
	const p = operatorKey(dom.root, keyApi({
		resumeWithKey: async (k) => { seen.push(k); return { id: 'neo-1', name: 'Neo' }; },
	}));
	dom.root.querySelector('input').value = 'K7QP-3MZX';
	btn('RESUME').click();
	const r = await p;
	assert.deepEqual(seen, ['K7QP-3MZX']);
	assert.equal(r.operator.id, 'neo-1');
});

await ta('operator key: a refused key leaves the screen open and says so', async () => {
	reset();
	const p = operatorKey(dom.root, keyApi());
	dom.root.querySelector('input').value = 'WRONG';
	btn('RESUME').click();
	await new Promise((r) => setTimeout(r, 0));
	assert.match(text(), /UNKNOWN KEY/);
	assert.ok(dom.root.querySelector('input'), 'the screen is still there');
	btn('NEW OPERATOR').click();
	await p;
});

console.log(`\n${n} terminal-render tests OK`);
