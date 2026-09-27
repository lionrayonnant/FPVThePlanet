// RECOMMENDED SETUP, as data. PURE: no DOM, no `navigator`, no `node:` — it is
// handed the values it needs and decides what the screen says. Imported as-is
// by tools/readiness-selftest.mjs and, through the Vite bundle, by
// src/readiness.js, which only mounts what this file decides.
//
// The screen exists because two things make the difference between flying and
// closing the tab, and neither is discoverable from inside the game: a physical
// controller, and a Chromium-family browser. It is a READOUT, not a tutorial
// (Bible §44): every line states what the machine SEES. The one imperative-
// shaped line in here names a path in the menus, it does not order anyone to
// walk it.
//
// The honesty problem this file is built around: the Gamepad API reveals a
// device only AFTER the user has acted on it. At launch the operator has just
// cleared the intro gate, probably on the keyboard, so an empty
// navigator.getGamepads() proves nothing. Nothing here is ever allowed to say
// "no controller" — the absent state says NOT DETECTED YET and says why.

// The storage rules, on the store-injected pattern of tools/briefing-model.mjs
// and tools/intro-model.mjs: a browser that refuses storage must never be
// blocked by a screen it cannot dismiss for good.
export const READINESS_SEEN_KEY = 'fpvtp.readinessSeen';

// How long the all-clear readout stays up before it takes itself away.
export const READINESS_AUTO_MS = 2000;

// A missing or unreadable store answers NO — same ruling as shouldBrief(): an
// operator who cannot persist the dismissal would rather not meet a screen they
// can never get rid of. An operator who sees it once more than needed loses two
// seconds.
export function shouldShowReadiness(store) {
	if (!store) return false;
	try { return store.getItem(READINESS_SEEN_KEY) !== '1'; }
	catch { return false; }
}

export function markReadinessDismissed(store) {
	try { store?.setItem(READINESS_SEEN_KEY, '1'); } catch { /* private browsing: it replays, it does not crash */ }
}

// ---------------------------------------------------------------------------
// THE BROWSER
// ---------------------------------------------------------------------------

// Chromium engine family, by brand or by user-agent token. CriOS and EdgiOS are
// in here too: on iOS they are a WebKit shell, but the brand the operator can
// act on is still the one they installed.
const CHROMIUM_RE = /\b(?:Chrome|Chromium|CriOS|Edge|Edg|EdgiOS|Edga|Opera|OPR|OPiOS|Brave|Samsung ?Internet|SamsungBrowser|Vivaldi|YaBrowser)\b/i;
// No `Gecko`: "like Gecko" sits in every Chromium and Safari user-agent.
const FIREFOX_RE = /\b(?:Firefox|FxiOS)\b/i;
const SAFARI_RE = /\bSafari\b/i;
const NOT_A_BRAND = /Not.?A.?Brand/i;

// The first brand a UA-Client-Hints list actually claims. The padding entries
// Chromium invents ("Not?A_Brand") are not brands and are dropped — the same
// filter src/bootstrap.js used to carry alone.
export function browserBrand(uaData, ua) {
	const named = (uaData?.brands ?? []).find((b) => !NOT_A_BRAND.test(b?.brand ?? ''))?.brand;
	// Kept byte-for-byte from the HARDWARE DISCOVERY row this replaced, so that
	// screen still prints exactly what it printed.
	return named || (String(ua ?? '').match(/(Firefox|Edg|Chrome|Safari)/)?.[1]) || 'UNKNOWN';
}

// 'chromium' | 'firefox' | 'safari' | 'unknown'. Brands first, user-agent
// second — and Firefox before Chromium before Safari in both, because every
// Chromium user-agent also contains the word Safari.
export function browserFamily(uaData, ua) {
	const brands = (uaData?.brands ?? [])
		.map((b) => String(b?.brand ?? ''))
		.filter((b) => b && !NOT_A_BRAND.test(b));
	for (const b of brands) {
		if (FIREFOX_RE.test(b)) return 'firefox';
		if (CHROMIUM_RE.test(b)) return 'chromium';
	}
	for (const b of brands) if (SAFARI_RE.test(b)) return 'safari';
	const s = String(ua ?? '');
	if (FIREFOX_RE.test(s)) return 'firefox';
	if (CHROMIUM_RE.test(s)) return 'chromium';
	if (SAFARI_RE.test(s)) return 'safari';
	return 'unknown';
}

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------

const up = (s) => String(s ?? '').toUpperCase();

// Hard wrap, so the paragraph is laid out here rather than by a stylesheet: the
// screen is a <pre> in a monospaced face, and a line that folds on its own folds
// in the wrong place.
export const WRAP_COLS = 58;

export function wrap(text, cols = WRAP_COLS) {
	const out = [];
	let line = '';
	for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
		if (line && line.length + 1 + word.length > cols) { out.push(line); line = word; }
		else line = line ? `${line} ${word}` : word;
	}
	if (line) out.push(line);
	return out;
}

const BROWSER_LABEL = {
	chromium: 'CHROMIUM FAMILY',
	firefox: 'FIREFOX',
	safari: 'SAFARI',
	unknown: 'UNKNOWN',
};

// `padKind` is src/input.js's class for the device: anything other than
// 'generic' is a class the default mapping fits. New classes will appear there
// (nintendo, steam); nothing here enumerates them, so nothing here has to be
// edited the day they do.
function inputSubject(padId, padKind) {
	const id = up(padId).trim();
	if (!id) {
		return {
			state: 'absent',
			verdict: 'warn',
			value: 'NOT DETECTED YET',
			kind: null,
		};
	}
	const kind = String(padKind ?? 'generic');
	const short = id.slice(0, 32);
	if (kind && kind !== 'generic') {
		return { state: 'recognised', verdict: 'ok', value: `${short} — ${up(kind)}`, kind };
	}
	// A device is there, which is the thing that mattered — but its class is not
	// one the defaults cover, so the axis order and the throttle travel are a
	// guess. That is a warning, not an all-clear: this operator is the only one
	// who actually needs to read the CALIBRATE line, and an all-clear readout
	// takes itself away after two seconds.
	return { state: 'unrecognised', verdict: 'warn', value: `${short} — UNRECOGNISED`, kind: 'generic' };
}

// What the screen shows. `browserName` is optional: given the brand the browser
// claims, the row prints it; otherwise it prints the family.
//
// `allClear` is the whole switch of the screen's behaviour — true means a
// readout that takes itself away after READINESS_AUTO_MS with no button, false
// means it waits on CONTINUE.
export function readinessReport({ browserFamily: family = 'unknown', padId = '', padKind = 'generic', browserName = '' } = {}) {
	const fam = ['chromium', 'firefox', 'safari'].includes(family) ? family : 'unknown';
	const browser = {
		family: fam,
		verdict: fam === 'chromium' ? 'ok' : 'warn',
		value: up(browserName).trim() || BROWSER_LABEL[fam],
	};
	const input = inputSubject(padId, padKind);

	const recommendation = [];
	// Gated on `absent`, not on the verdict: an UNRECOGNISED device warns too,
	// but recommending hardware to someone who already has some in their hands
	// would read as not having looked. Their line is the CALIBRATE hint below.
	if (input.state === 'absent') {
		recommendation.push(...wrap('AN FPV RADIO RUNNING EDGETX, OR A DUALSHOCK OR XBOX PAD, '
			+ 'IS WHAT THIS SIMULATOR IS FLOWN WITH.'));
	}
	if (browser.verdict === 'warn') {
		if (recommendation.length) recommendation.push('');
		recommendation.push(...wrap('A CHROMIUM-BASED BROWSER CARRIES THE TERRAIN AND '
			+ 'THE PHYSICS MORE SMOOTHLY THAN THIS ONE.'));
	}

	const hints = [];
	if (input.state === 'absent') {
		hints.push(...wrap('A CONTROLLER ONLY APPEARS ONCE YOU MOVE A STICK ON IT.'));
	}
	if (input.state === 'unrecognised') {
		hints.push(...wrap('ITS CHANNELS ARE SET IN SETTINGS > CONTROLLER > CALIBRATE.'));
	}

	// Crew remarks, in the voice and the shape src/bootstrap.js already uses on
	// HARDWARE DISCOVERY. Two at most: this screen is a glance, not a briefing.
	// One pair, chosen by what is worst: the input when there is anything to say
	// about it, the browser otherwise, the all-clear last.
	const notes = [];
	if (input.state === 'absent') notes.push('// root: nothing on the bus', '// mikhail: keyboard then');
	else if (input.state === 'unrecognised') notes.push('// root: unknown device', '// cron: calibrate it');
	else if (browser.verdict === 'warn') notes.push(`// root: ${fam}`, '// mikhail: chromium flies better');
	else notes.push(`// root: ${input.kind} detected`, '// cron: good');

	const allClear = browser.verdict === 'ok' && input.verdict === 'ok';
	return {
		title: 'RECOMMENDED SETUP',
		rows: [['BROWSER', browser.value], ['INPUT', input.value]],
		browser,
		input,
		verdicts: { browser: browser.verdict, input: input.verdict },
		notes: notes.slice(0, 2),
		recommendation,
		hints,
		// The all-clear readout still says something, or it would be a screen
		// that flashes for no reason anyone can name. Only a RECOGNISED device
		// gets there: an unrecognised one warns instead, so it keeps the screen
		// up long enough for the CALIBRATE line to be read.
		status: allClear ? 'SETUP LOOKS GOOD.' : '',
		allClear,
		autoMs: allClear ? READINESS_AUTO_MS : 0,
	};
}

// The lines of the screen, in order, ready for revealLines(). `dot(label, value)`
// is injected — the dotted() of src/bootstrap.js in the game, a stub in a test —
// so this file stays free of the renderer.
export function readinessLines(report, dot = (l, v) => `${l} ${v}`) {
	const lines = [report.title, ''];
	for (const [label, value] of report.rows) lines.push(dot(label, value));
	if (report.notes.length) lines.push('', ...report.notes);
	if (report.recommendation.length) lines.push('', ...report.recommendation);
	if (report.hints.length) lines.push('', ...report.hints);
	if (report.status) lines.push('', report.status);
	return lines;
}
