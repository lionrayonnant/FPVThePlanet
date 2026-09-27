// RECOMMENDED, as data. PURE: no DOM, no `navigator`, no `node:` — it is
// handed the values it needs and decides what the screen shows. Imported as-is
// by tools/readiness-selftest.mjs and, through the Vite bundle, by
// src/readiness.js, which only mounts what this file decides.
//
// The screen exists because two things make the difference between flying and
// closing the tab, and neither is discoverable from inside the game: a physical
// controller, and a Chromium-family browser. It says so in three pictograms —
// FPV RADIO or DUALSHOCK, and CHROME — each LIT when the machine sees it and
// DIM when it does not yet. The contrast is the message; text is kept to two
// lines that no pictogram can carry.
//
// The honesty problem this file is built around: the Gamepad API reveals a
// device only AFTER the user has acted on it. At launch the operator has just
// cleared the intro gate, probably on the keyboard, so an empty
// navigator.getGamepads() proves nothing. A dim pad is "not yet", never "no",
// and the screen says how to light it: MOVE A STICK TO DETECT IT.

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

// The only two sentences of the screen.
export const HINT_MOVE_STICK = 'MOVE A STICK TO DETECT IT';
export const HINT_CALIBRATE = 'UNKNOWN DEVICE · SETTINGS > CONTROLLER > CALIBRATE';

// `padKind` is src/input.js's class for the device. 'radio' lights the radio;
// any other class lights the pad — nothing here enumerates them, so nothing has
// to be edited the day input.js learns a new one. 'generic' lights the pad too
// (a device IS there) but its axis order and throttle travel are a guess, so it
// stays a warning: that operator is the one who needs the CALIBRATE line, and
// an all-clear screen takes itself away before it can be read.
function inputSubject(padId, padKind) {
	if (!String(padId ?? '').trim()) return { state: 'absent', verdict: 'warn', lit: null };
	const kind = String(padKind ?? 'generic') || 'generic';
	if (kind === 'generic') return { state: 'unrecognised', verdict: 'warn', lit: 'gamepad' };
	return { state: 'recognised', verdict: 'ok', lit: kind === 'radio' ? 'radio' : 'gamepad' };
}

// What the screen shows. `icons` is the row, in order; `or` sits between the
// first two (a radio OR a pad — the browser is not an alternative). `allClear`
// is the whole switch of the screen's behaviour — true means a readout that
// takes itself away after READINESS_AUTO_MS with no button, false means it
// waits on CONTINUE.
export function readinessReport({ browserFamily: family = 'unknown', padId = '', padKind = 'generic' } = {}) {
	const fam = ['chromium', 'firefox', 'safari'].includes(family) ? family : 'unknown';
	const browser = { family: fam, verdict: fam === 'chromium' ? 'ok' : 'warn' };
	const input = inputSubject(padId, padKind);
	const hint = input.state === 'absent' ? HINT_MOVE_STICK
		: input.state === 'unrecognised' ? HINT_CALIBRATE
			: '';
	const allClear = browser.verdict === 'ok' && input.verdict === 'ok';
	return {
		title: 'RECOMMENDED',
		// The logo is Chrome's because that is the one people recognise; what
		// lights it is the whole family (Edge, Brave, Opera…).
		icons: [
			{ id: 'radio', label: 'FPV RADIO', lit: input.lit === 'radio' },
			{ id: 'gamepad', label: 'DUALSHOCK', lit: input.lit === 'gamepad' },
			{ id: 'chrome', label: 'CHROME', lit: browser.verdict === 'ok' },
		],
		or: 'OR',
		browser,
		input,
		hint,
		allClear,
		autoMs: allClear ? READINESS_AUTO_MS : 0,
	};
}
