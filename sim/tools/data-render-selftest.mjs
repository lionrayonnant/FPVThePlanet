// Render selftest of the COLD screens — the ones the map-first Home filed
// behind DATA (#208, renamed by #26). Same intent as
// terminal-render-selftest.mjs: it checks the TREE and the WIRING, not the
// appearance.
//
// These three screens were not testable before: they were built with innerHTML,
// which fake-dom refuses. Converting them to createElement was necessary
// anyway — it is what lets BUILD NOTES have a hanging indent per line.
//
// Each of the three tests matches a defect seen in a real render, in headless
// Chromium driven over CDP, on the phase-27-ui-rework branch.
//
// Run: node tools/data-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

globalThis.fetch = async (url) => {
	if (String(url).includes('/__map-api/scenes')) {
		return { ok: true, status: 200, json: async () => ({ scenes: [] }) };
	}
	return { ok: false, status: 503, json: async () => ({}) };
};

const { dataScreen } = await import('../src/terminal.js');
const { selectOperationMode } = await import('../src/bench.js');
const { runSessionLog } = await import('../src/session-log.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.root.replaceChildren(); dom.setActive(null); };
const btn = (label) => dom.root.querySelectorAll('button').find((b) => b.textContent.includes(label));
const tick = () => new Promise((r) => setTimeout(r, 0));

// A session that carried a target: the Target Log is DERIVED from it
// (PHASE 17, spec D1) — there is no stored `targetLog`.
const session = (over = {}) => ({
	id: 'paristest-0001', area: 'paristest', seq: 1, targetSeq: 1,
	target: { family: 'heavy5', rssiDbm: -56, mode: 'ANALOG' },
	start: '2026-09-04T18:00:00.000Z', end: '2026-09-04T18:07:00.000Z',
	result: 'CRASHED', photos: [], ...over,
});
const operator = (over = {}) => ({
	name: 'neo', createdAt: '2026-09-01T10:00:00.000Z', sessions: [session()], ...over,
});
// `key`: the operator key as the browser keeps it (#60). Absent by default —
// that is the case of a `local` server, where it does not exist.
let storedKey = null;
const api = (op) => ({
	getOperator: () => op, patch: () => {}, flush: async () => {},
	hasKey: () => Boolean(storedKey), getKey: () => storedKey,
});

// Opens the root, takes the DATA path, then mounts the screen the way
// main.js's loop does — DATA is at the same level as FIELD and BENCH (D3), it
// is no longer reached through a FIELD tab.
//
// Returns DATA's promise: it MUST be unwound at the end of the test — a screen
// left open keeps its subscriptions, and the selftest would pass without ever
// handing back.
const openData = async (op, entry) => {
	reset();
	const mode = selectOperationMode(dom.root, { last: 'data' });
	btn('DATA').click();
	assert.equal(await mode, 'data', 'the root does lead to DATA');
	// WRAPPED: `await` on an async function that RETURNED this promise would
	// unwrap it, and wait on a screen that never closes.
	const home = dataScreen(dom.root, { api: api(op), scenes: [] });
	await tick();
	btn(entry).click();
	await tick();
	return { home };
};

// Goes back up DEPTH screens with Escape. The last one closes DATA itself:
// there is no MODE button left to click (D4), Escape is the way back up
// everywhere. Closing matters: menu-nav.js holds a gamepad-polling setInterval
// that only detach() stops — a screen left open keeps the process alive.
const SUBSCREEN_DEPTH = 2;   // the screen itself, then DATA
const closeAll = async (home, depth = SUBSCREEN_DEPTH) => {
	for (let i = 0; i < depth; i++) { dom.key('Escape'); await tick(); await tick(); }
	await home;
};

// --- the DATA page ---------------------------------------------------------

// The spec's nine sections, in order, under CLEARANCE and SIGNALS (issue #185,
// lot 3). It is the only thing this test freezes about the screen: what it SHOWS and in
// what order — a graph is judged by eye, a vanished section is judged nowhere
// but here.
const SECTIONS = ['CLEARANCE', 'SIGNALS', 'RHYTHM', 'LIFE', 'SPEED × ALTITUDE', 'HOW THEY DIED',
	'STICKS', 'FAMILIES', 'GEOGRAPHY', 'PROFILE', 'RECORDS'];

await ta('data: the nine sections, in order, with RECORDS at the end', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	const page = dom.root.querySelector('.data-page');
	assert.ok(page, 'the scrolling page');
	const titles = page.querySelectorAll('.data-section').map((b) => b.children[0].textContent);
	assert.deepEqual(titles, SECTIONS);
	// RECORDS keeps the raw log and everything that is read rather than drawn.
	for (const entry of ['SESSION LOG', 'LAST SESSION', 'OPERATOR', 'BUILD NOTES']) {
		assert.ok(btn(entry), `"${entry}" is in RECORDS`);
	}
	// D2: the TARGET LOG was absorbed by FAMILIES — it has no entry any more.
	assert.equal(btn('TARGET LOG'), undefined, 'the TARGET LOG has left the menu');
	// D6: SETTINGS moved up to the root; repeating it here would make two doors
	// for one panel.
	assert.equal(dom.root.querySelectorAll('button').find((b) => b.textContent === 'SETTINGS'), undefined);
	// D15: Escape is named, and it says where it leads.
	const keys = dom.root.querySelector('.terminal-keys');
	assert.ok(keys, 'the key line');
	assert.equal(keys.textContent, '[ESC] OPERATION MODE');
	await closeAll(p, 1);
});

await ta('data: CLEARANCE at the top — the progress, the hangar, the tiers, kept across re-renders', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	const first = dom.root.querySelector('.data-page').children[0];
	assert.equal(first.children[0].textContent, 'CLEARANCE');
	assert.match(first.textContent, /1 POINT PER TIER OF EVERY SIGNAL UPLINKED · ░{12}  0\/6 TO CLEARANCE 1/);
	assert.match(first.textContent, /SIGNALS   TIER I   TIER II AT CLEARANCE 1/);
	const hangar = first.querySelector('.hangar');
	assert.ok(hangar, 'the hangar');
	assert.ok(!hangar.classList.contains('hangar-compact'), 'full size in DATA');
	// A re-render (a family opened) hands back the SAME hangar, not a new one.
	const fam = dom.root.querySelectorAll('.data-section').find((b) => b.children[0].textContent === 'FAMILIES');
	fam.querySelectorAll('button')[0].click();
	await tick();
	assert.match(dom.root.textContent, /TARGET 001/, 'the page did re-render');
	assert.equal(dom.root.querySelector('.data-page').children[0].querySelector('.hangar'), hangar);
	assert.equal(dom.root.querySelectorAll('.hangar').length, 1);
	dom.key('Escape');
	await p;
	assert.equal(dom.root.querySelectorAll('.hangar').length, 0, 'gone with the screen');
});

// --- SIGNALS (issue #185, lot 3 task 9) --------------------------------------

// What the operator uplinked, as the store keeps it (`signals.resolved`).
const DAY = (d, h = 12) => new Date(2026, 8, d, h, 0).getTime();
const uplink = (over) => ({
	at: DAY(27), name: 'X', lat: 48.8462, lon: 2.3464, tier: 1, family: 'cinewhoop',
	holdS: 5, distM: 212, sessionId: null, photo: null, place: 'PARIS', ...over,
});
const withSignals = () => operator({
	signals: {
		resolved: {
			'wd:Q1': uplink({ name: 'PANTHEON', at: DAY(27) }),
			'wd:Q2': uplink({ name: 'EIFFEL TOWER', at: DAY(26) }),
			'wd:Q3': uplink({ name: 'KINKAKU-JI', place: 'KYOTO', lat: 35.0394, lon: 135.7292, at: DAY(20) }),
		},
	},
});
const waitFor = async (fn, what) => {
	for (let i = 0; i < 50; i++) { if (fn()) return; await tick(); }
	assert.fail(`timed out waiting for ${what}`);
};
// The Home and DATA stay MOUNTED behind (only `hidden`): their text is in
// dom.root. So only the last opened screen's box is read.
const topBox = () => { const b = dom.root.querySelectorAll('.terminal-box'); return b[b.length - 1]; };
// DATA has its own BACK, hidden behind the capture: aim at the capture's.
const topBtn = (label) => topBox().querySelectorAll('button').find((b) => b.textContent.includes(label));
const signalsBox = () => dom.root.querySelector('.data-page').children[1];
const signalsReady = () => waitFor(() => signalsBox()?.classList.contains('signals-section'), 'the SIGNALS section');

await ta('data: the foot line counts sessions, signals uplinked and the clearance', async () => {
	reset();
	let p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	assert.equal(dom.root.querySelector('.terminal-box').children[1].textContent,
		'1 SESSIONS ON RECORD · 0 SIGNALS UPLINKED · CLEARANCE 0');
	await closeAll(p, 1);
	reset();
	p = dataScreen(dom.root, { api: api(withSignals()), scenes: [] });
	await tick();
	// 3 tier-I signals = 3 points: still under the 6 of CLEARANCE 1.
	assert.equal(dom.root.querySelector('.terminal-box').children[1].textContent,
		'1 SESSIONS ON RECORD · 3 SIGNALS UPLINKED · CLEARANCE 0');
	await closeAll(p, 1);
});

await ta('data: SIGNALS paints a placeholder first, then the section in its slot', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	// Synchronously, before the signal cache has answered: DATA is up, and the
	// slot says it is reading.
	const slot = dom.root.querySelector('.data-page').children[1];
	assert.equal(slot.children[0].textContent, 'SIGNALS');
	assert.equal(slot.children[1].textContent, 'LOADING…');
	await signalsReady();
	assert.equal(dom.root.querySelectorAll('.data-section')
		.filter((b) => b.children[0].textContent === 'SIGNALS').length, 1, 'swapped, not added');
	await closeAll(p, 1);
});

await ta('data: SIGNALS, empty — NOTHING UPLINKED YET and where to find one', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await signalsReady();
	const box = signalsBox();
	assert.equal(box.children[1].textContent, '0 UPLINKED · 0 KNOWN · 0 PLACES');
	const empty = box.querySelectorAll('.terminal-empty').map((e) => e.textContent);
	assert.deepEqual(empty, ['NOTHING UPLINKED YET', 'FIELD → A SIGNAL ON THE SCANNER']);
	assert.equal(box.querySelectorAll('button').length, 0, 'nothing to open');
	await closeAll(p, 1);
});

await ta('data: SIGNALS lists the places and the selected place\'s uplinked rows', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(withSignals()), scenes: [] });
	await signalsReady();
	const box = signalsBox();
	assert.equal(box.children[1].textContent, '3 UPLINKED · 0 KNOWN · 2 PLACES');
	const places = box.querySelector('.signals-places').querySelectorAll('button');
	assert.deepEqual(places.map((b) => b.textContent), ['PARIS 2/2', 'KYOTO 1/1']);
	assert.ok(places[0].classList.contains('on'), 'the first place is selected');
	const rows = () => signalsBox().querySelectorAll('.signals-row');
	assert.equal(rows().length, 2);
	assert.match(rows()[0].textContent, /\[\+\] PANTHEON/, 'newest first');
	assert.match(rows()[1].textContent, /EIFFEL TOWER/);
	// Choosing a place redraws the section alone: CLEARANCE and the graphs
	// stay the very same nodes.
	const rhythm = dom.root.querySelector('.data-page').children[2];
	places[1].click();
	await tick();
	assert.equal(rows().length, 1);
	assert.match(rows()[0].textContent, /KINKAKU-JI/);
	assert.equal(dom.root.querySelector('.data-page').children[2], rhythm, 'the page was not rebuilt');
	// A page re-render (a family opened) keeps the place chosen.
	dom.root.querySelectorAll('.data-section').find((b) => b.children[0].textContent === 'FAMILIES')
		.querySelectorAll('button')[0].click();
	await tick();
	assert.match(rows()[0].textContent, /KINKAKU-JI/, 'the selection survives a re-render');
	signalsBox().querySelector('.signals-places').querySelectorAll('button')[0].click();   // back to PARIS for the next tests
	await closeAll(p, 1);
});

await ta('data: an uplinked row opens its capture; BACK returns with the cursor on that row', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(withSignals()), scenes: [] });
	await signalsReady();
	const row = signalsBox().querySelectorAll('.signals-row')[1];
	row.click();
	await tick();
	const data = dom.root.querySelector('.terminal-data');
	assert.ok(data.hidden, 'DATA hides behind the capture');
	assert.equal(topBox().children[0].textContent, 'EIFFEL TOWER');
	assert.equal(topBox().querySelector('.terminal-foot').textContent, 'PARIS');
	// PREVIOUS walks the place's entries without leaving the capture.
	topBtn('PREVIOUS').click();
	await tick();
	assert.equal(topBox().children[0].textContent, 'PANTHEON');
	topBtn('BACK').click();
	await tick(); await tick();
	assert.ok(!data.hidden, 'DATA is back');
	assert.equal(dom.root.querySelectorAll('.terminal-capture').length, 0, 'the capture is gone');
	assert.equal(dom.document.activeElement, row, 'the cursor is on the row that was opened');
	await closeAll(p, 1);
});

await ta('data: FLY THERE hands { live, place } up unchanged', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(withSignals()), scenes: [] });
	await signalsReady();
	signalsBox().querySelectorAll('.signals-row')[0].click();
	await tick();
	topBtn('FLY THERE').click();
	assert.deepEqual(await p, { live: [48.8462, 2.3464], place: 'PARIS' });
	assert.equal(dom.root.children.length, 0, 'and nothing is left in #ui');
});

await ta('data: with no track, the sections that need one say NO TRACK', async () => {
	// The issue's acceptance criterion: never an error, never a hole in the
	// graphs that do not need a track. Here no `/tracks` route answers — that is
	// the state of every build until #24 lands, and also that of a flight too
	// old to be kept (D3).
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick(); await tick();
	const page = dom.root.querySelector('.data-page');
	const sectionOf = (name) => page.querySelectorAll('.data-section')
		.find((b) => b.children[0].textContent === name);
	for (const name of ['HOW THEY DIED', 'STICKS', 'PROFILE']) {
		assert.match(sectionOf(name).textContent, /NO TRACK/, `${name} does not say NO TRACK`);
	}
	// And the five that do not need one keep their readout: the session
	// aggregates are enough, and they are never thrown away.
	assert.match(sectionOf('RHYTHM').textContent, /SESSIONS PER WEEK/);
	assert.match(sectionOf('LIFE').textContent, /DURATION PER SESSION/);
	assert.doesNotMatch(sectionOf('RHYTHM').textContent, /NO TRACK/);
	await closeAll(p, 1);
});

await ta('data: FAMILIES absorbed the TARGET LOG — a family opens onto its targets', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: [] });
	await tick();
	const page = dom.root.querySelector('.data-page');
	const fam = () => page.querySelectorAll('.data-section').find((b) => b.children[0].textContent === 'FAMILIES');
	assert.doesNotMatch(fam().textContent, /TARGET 001/, 'closed, the family lists nothing');
	const open = fam().querySelectorAll('button')[0];
	assert.ok(open, 'the family met is a link');
	open.click();
	await tick();
	assert.match(fam().textContent, /TARGET 001/, 'open, it lists the target met');
	assert.match(fam().textContent, /PARISTEST/);
	// A second click closes it: this is a fold-out, not one more screen.
	fam().querySelectorAll('button')[0].click();
	await tick();
	assert.doesNotMatch(fam().textContent, /TARGET 001/);
	await closeAll(p, 1);
});

// --- what DATA hands back ---------------------------------------------------
//
// This is the contract main.js:dataLoop() consumes (D3): DATA resolves UPWARDS,
// in the shape the FIELD loop knows how to fly. Without this test a REVISIT
// could hand back a bare slug and the loop took off on `undefined`.

// The area must still be on disk for REVISIT to be offered: that is
// lastSessionScreen's `model.areas.some(...)` gate.
const INSTALLED = [{ slug: 'paristest', name: 'paristest', bytes: 109e6 }];

await ta('data: a REVISIT hands back { slug }, the shape the FIELD loop flies', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: INSTALLED });
	await tick();
	await tick();
	btn('LAST SESSION').click();
	await tick();
	btn('REVISIT AREA').click();
	// A bare slug would come back here without done()'s normaliser: that is what
	// lastSessionScreen returns, and not what the loop expects.
	assert.deepEqual(await p, { slug: 'paristest' });
	assert.equal(dom.root.children.length, 0, 'and nothing is left in #ui');
});

await ta('data: Escape hands back null, not undefined', async () => {
	reset();
	const p = dataScreen(dom.root, { api: api(operator()), scenes: INSTALLED });
	await tick();
	// `if (!pick) continue;` in main.js: null and undefined would both pass, but
	// the function promises a shape — and it keeps it.
	dom.key('Escape');
	assert.equal(await p, null);
});

// --- OPERATOR ---------------------------------------------------------------

await ta('operator: the target counter comes from the sessions, not a dead key', async () => {
	// `op.targetLog` has not existed since PHASE 17: reading it always returned
	// 0, and the screen contradicted the Home footer ("9 TARGETS LOGGED") and
	// the Target Log itself. Two sessions, only one with a target.
	const { home } = await openData(operator({ sessions: [session(), session({ id: 'x', seq: 2, targetSeq: 0, target: null })] }), 'OPERATOR');
	const t = dom.root.textContent;
	assert.match(t, /OPERATOR \/\/ NEO/);
	assert.match(t, /SESSIONS\s+2/);
	assert.match(t, /TARGETS\s+1/, 'only one of the two sessions carried a target');
	assert.doesNotMatch(t, /TARGETS\s+0/);
	await closeAll(home);
});

// The key (#60) is a TECHNICAL mechanism, shown here for the same reason the
// Control Vector is shown on ITS screen: because you may want to read it back.
// The two mix neither on screen nor in the code (Bible §33) — which is exactly
// what these two tests pin down (topBox() is defined with the SIGNALS tests).

await ta('operator: with no key (local server), no SHOW KEY on screen', async () => {
	storedKey = null;
	const { home } = await openData(operator(), 'OPERATOR');
	assert.equal(btn('SHOW KEY'), undefined);
	assert.doesNotMatch(topBox().textContent, /OPERATOR KEY/);
	await closeAll(home);
});

await ta('operator: with a key, it is masked until SHOW KEY', async () => {
	storedKey = 'K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE';
	const { home } = await openData(operator(), 'OPERATOR');
	assert.match(topBox().textContent, /OPERATOR KEY\s+•/, 'masked on the first render');
	assert.doesNotMatch(topBox().textContent, /K7QP/);
	btn('SHOW KEY').click();
	await tick();
	assert.match(topBox().textContent, /K7QP-3MZX-AAAA-BBBB-CCCC-DDDD-EE/);
	// The ONLY thing the game ever says about the key: registration itself asks
	// nobody to write anything down (amendment of 2026-09-07).
	assert.match(topBox().textContent, /THIS PROFILE LIVES IN THIS BROWSER/);
	// The key has nothing to do with the Control Vector, removed from the game
	// (#33). The assertion stays: it locks in that this screen speaks of the KEY
	// and nothing else, and the phrase must not come back through a copy
	// regression.
	assert.doesNotMatch(topBox().textContent, /CONTROL VECTOR/);
	storedKey = null;
	await closeAll(home);
});

// --- BUILD NOTES ------------------------------------------------------------

await ta('build notes: one note line = one element, for the hanging indent', async () => {
	// In a single <pre>, a note that was too long wrapped back to column 0 and
	// read as a top-level entry. `.terminal-note`'s hanging indent is only
	// possible if every line is its own node.
	const { home } = await openData(operator(), 'BUILD NOTES');
	assert.match(dom.root.textContent, /BUILD NOTES/);
	const notes = dom.root.querySelectorAll('.terminal-note');
	assert.ok(notes.length > 0, 'at least one note line carried by its own element');
	// No line may carry its indent as literal spaces: they do not survive the
	// wrap, which is exactly the defect being fixed.
	for (const p of notes) assert.doesNotMatch(p.textContent, /^ /, 'indent in CSS, not in spaces');
	assert.ok(dom.root.querySelectorAll('.terminal-note-block').length > 0, 'the notes are grouped by version');
	await closeAll(home);
});

await ta('build notes: [ BACK ] exists AND Escape leaves', async () => {
	// The only screen in the house that did not call menuNav: with no cursor and
	// no keyboard, and on a list long enough to run below the fold, its single
	// BACK was out of sight. The screen closed in on the operator.
	const { home } = await openData(operator(), 'BUILD NOTES');
	assert.ok(btn('BACK'), 'a BACK');
	// `BUILD NOTES` is also the LABEL of the link in RECORDS: so this aims at
	// `CURRENT BUILD`, which only the screen itself displays.
	assert.match(dom.root.textContent, /CURRENT BUILD/);
	dom.key('Escape');
	await tick();
	assert.doesNotMatch(dom.root.textContent, /CURRENT BUILD/, 'Escape closes the screen');
	assert.match(dom.root.textContent, /SESSION LOG · LAST SESSION/, 'and hands back to DATA');
	await closeAll(home, 1);   // the test's Escape has already closed BUILD NOTES
});

// --- SESSION LOG ------------------------------------------------------------

await ta('session log: Escape is named, as on every screen that listens for it', async () => {
	reset();
	const p = runSessionLog(dom.root, { operator: operator(), scenes: [] });
	await tick();
	assert.match(dom.root.textContent, /SESSION LOG/);
	assert.equal(dom.root.querySelector('.terminal-keys').textContent, '[ESC] BACK');
	btn('BACK').click();
	await p;
});

await ta('session log: an empty list says so at DATA level, not at 22 px', async () => {
	// A bare <pre> inherits the DISPLAY level from `.bootstrap-box`: "NO SESSIONS
	// MATCH THIS FILTER" therefore printed LARGER than the 13 px rows it
	// replaced. An empty state is information, not a headline (Bible §39).
	reset();
	const p = runSessionLog(dom.root, { operator: operator({ sessions: [] }), scenes: [] });
	await tick();
	const empty = dom.root.querySelector('.terminal-empty');
	assert.ok(empty, 'the empty state goes through the one shared treatment');
	assert.match(empty.textContent, /NO SESSIONS MATCH THIS FILTER/);
	btn('BACK').click();
	await p;
});

// --- SESSION DETAIL ---------------------------------------------------------
//
// The record talks to the REAL src/operator.js: that is what fetches the
// complete session. `_setFetch` exists for this, and an operator created
// through the same route sets the cache getSession() needs.
const { runSessionDetail } = await import('../src/session-log.js');
const operatorApi = await import('../src/operator.js');

const HOSTILE = '<img src=x onerror=alert(1)>';
const mountDetail = async (over = {}) => {
	reset();
	const full = {
		id: 'paristest-0001', operatorId: 'neo-0000', area: 'paristest', seq: 1,
		start: '2026-09-04T18:00:00.000Z', end: '2026-09-04T18:07:00.000Z',
		result: 'CRASHED', photos: [], comment: null, target: null,
		flightTelemetry: { durationS: 420, maxSpeedMs: 12, maxRateDps: 300, maxAltitudeM: 40, distanceM: 900 },
		...over,
	};
	const calls = [];
	operatorApi._setFetch(async (url, opts) => {
		calls.push(`${opts?.method ?? 'GET'} ${url}`);
		if (opts?.method === 'POST') {
			return { ok: true, status: 200, json: async () => ({ operator: { id: 'neo-0000', name: 'neo', sessions: [full] }, key: 'k' }) };
		}
		if (opts?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ removed: full.id }) };
		return { ok: true, status: 200, json: async () => ({ session: full }) };
	});
	await operatorApi.createOperator('neo');
	const p = runSessionDetail(dom.root, full.id, { scenes: [] });
	await tick(); await tick();
	return { p, calls };
};

await ta('session detail: the operator note is TEXT, never markup', async () => {
	// The note is typed by a player and rendered, on a shared server, in ANOTHER
	// operator's browser — the one holding the bearer key (src/operator.js).
	// Interpolated into innerHTML it was a stored injection. fake-dom refusing
	// every non-empty innerHTML is half the guard; this is the other half.
	const { p, calls } = await mountDetail({ comment: `${HOSTILE}NOTE` });
	assert.ok(dom.root.textContent.includes(`${HOSTILE}NOTE`), 'the note is on screen, verbatim');
	assert.equal(dom.root.querySelectorAll('img').length, 0, 'and it built no element');
	dom.key('Escape');
	await p;
	assert.ok(calls.some((c) => c.startsWith('GET')), 'the record did read the complete session');
});

await ta('session detail: DELETE SESSION asks for a second press', async () => {
	// A session is a flight's only record, and it went on one distracted press.
	// Same guard as RESET SETTINGS and REMOVE TERRAIN (#213).
	const { p, calls } = await mountDetail();
	const del = btn('DELETE SESSION');
	assert.equal(del.textContent, '[ DELETE SESSION ]');
	del.click();
	await tick();
	assert.equal(del.textContent, '[ DELETE SESSION — CONFIRM ]', 'the first press arms');
	assert.ok(!calls.some((c) => c.startsWith('DELETE')), 'and nothing is deleted');
	del.click();
	await tick();
	assert.ok(calls.some((c) => c.startsWith('DELETE')), 'the second press is the confirmation');
	assert.deepEqual(await p, { deleted: 'paristest-0001' });
});

// Like bench-render-selftest: the globals are handed back before concluding.
// Without that the subscriptions menuNav puts on the fake window keep the
// process alive and the test "passes" without ever handing back.
dom.restore();
console.log(`\n${n} data-render tests OK`);
// No `process.exit(0)` here any more: menu-nav.js now sweeps the navs whose
// screen has left the DOM (#210), so no gamepad polling survives this suite and
// Node hands back on its own. If this file starts hanging again, that sweep is
// what to look at — not a forced exit put back.
