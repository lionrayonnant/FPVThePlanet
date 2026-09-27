// Selftest for the pure RECOMMENDED model (tools/readiness-model.mjs). No DOM,
// no storage of its own: the browser families, which pictogram lights, the two
// text lines, the all-clear switch and the storage rules are all decided there,
// so they can be checked without a browser.
// Run: node tools/readiness-selftest.mjs
import assert from 'node:assert/strict';
import {
	READINESS_SEEN_KEY,
	READINESS_AUTO_MS,
	shouldShowReadiness,
	markReadinessDismissed,
	browserFamily,
	browserBrand,
	readinessReport,
	HINT_MOVE_STICK,
	HINT_CALIBRATE,
} from './readiness-model.mjs';
import * as model from './readiness-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('readiness model');

// A localStorage stand-in. `broken` throws on every access, the way a browser in
// private mode does — the model must never let that block a launch.
function store({ broken = false } = {}) {
	const m = new Map();
	return {
		getItem: (k) => { if (broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
		setItem: (k, v) => { if (broken) throw new Error('denied'); m.set(k, String(v)); },
		has: (k) => m.has(k),
	};
}

// --- storage rules ----------------------------------------------------------

t('the storage key is namespaced fpvtp.*', () => {
	assert.equal(READINESS_SEEN_KEY, 'fpvtp.readinessSeen');
	assert.equal(READINESS_AUTO_MS, 2000);
});

t('the screen shows while the key is absent, and never again once dismissed', () => {
	const s = store();
	assert.equal(shouldShowReadiness(s), true);
	markReadinessDismissed(s);
	assert.equal(shouldShowReadiness(s), false);
	assert.equal(s.has(READINESS_SEEN_KEY), true);
	assert.equal(s.getItem(READINESS_SEEN_KEY), '1');
});

t('no store, and a store that throws, both answer no', () => {
	// A browser we cannot read is not a new player. Offering a screen that can
	// never be dismissed for good is worse than not offering it.
	assert.equal(shouldShowReadiness(null), false);
	assert.equal(shouldShowReadiness(undefined), false);
	assert.equal(shouldShowReadiness(store({ broken: true })), false);
});

t('markReadinessDismissed never throws', () => {
	markReadinessDismissed(store({ broken: true }));
	markReadinessDismissed(null);
	markReadinessDismissed(undefined);
});

// --- the four browser families ----------------------------------------------

const UA = {
	chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
	opera: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0',
	samsung: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
	firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
	firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
	safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
	curl: 'curl/8.7.1',
};

t('Chromium-family user-agents read as chromium, Safari word and all', () => {
	// Every Chromium user-agent also contains "Safari": the order of the tests
	// is the whole correctness of this function.
	for (const k of ['chrome', 'edge', 'opera', 'samsung']) {
		assert.equal(browserFamily(null, UA[k]), 'chromium', k);
	}
});

t('Firefox reads as firefox, on the desktop and on iOS', () => {
	assert.equal(browserFamily(null, UA.firefox), 'firefox');
	// FxiOS is a WebKit shell, but the brand the operator installed is Firefox.
	assert.equal(browserFamily(null, UA.firefoxIos), 'firefox');
	// "like Gecko" must not be what decides it.
	assert.notEqual(browserFamily(null, UA.chrome), 'firefox');
});

t('Safari reads as safari, and an unknown agent as unknown', () => {
	assert.equal(browserFamily(null, UA.safari), 'safari');
	assert.equal(browserFamily(null, UA.curl), 'unknown');
	assert.equal(browserFamily(null, ''), 'unknown');
	assert.equal(browserFamily(null, null), 'unknown');
	assert.equal(browserFamily(undefined, undefined), 'unknown');
});

t('UA-Client-Hints brands win over the user-agent, padding brands dropped', () => {
	const brands = [
		{ brand: 'Not?A_Brand', version: '99' },
		{ brand: 'Google Chrome', version: '126' },
		{ brand: 'Chromium', version: '126' },
	];
	assert.equal(browserFamily({ brands }, UA.curl), 'chromium');
	// The padding entry alone is no brand at all: the user-agent decides.
	assert.equal(browserFamily({ brands: [{ brand: 'Not.A.Brand' }] }, UA.firefox), 'firefox');
	assert.equal(browserFamily({ brands: [] }, UA.safari), 'safari');
});

t('browserBrand prints what the HARDWARE DISCOVERY row printed', () => {
	// src/bootstrap.js calls this now; the row must not change wording.
	assert.equal(browserBrand({ brands: [{ brand: 'Not?A_Brand' }, { brand: 'Brave' }] }, UA.chrome), 'Brave');
	assert.equal(browserBrand(null, UA.firefox), 'Firefox');
	assert.equal(browserBrand(null, UA.edge), 'Chrome');   // first token in the string, as before
	assert.equal(browserBrand(null, UA.safari), 'Safari');
	assert.equal(browserBrand(null, UA.curl), 'UNKNOWN');
	assert.equal(browserBrand(undefined, undefined), 'UNKNOWN');
});

// --- which pictogram lights -------------------------------------------------

const report = (o) => readinessReport(o);
const lit = (r) => r.icons.filter((i) => i.lit).map((i) => i.id);

t('three pictograms, always, in the order of the mock-up', () => {
	for (const o of [{}, { browserFamily: 'chromium', padId: 'p', padKind: 'radio' }]) {
		const r = report(o);
		assert.equal(r.title, 'RECOMMENDED');
		assert.deepEqual(r.icons.map((i) => i.id), ['radio', 'gamepad', 'chrome']);
		assert.deepEqual(r.icons.map((i) => i.label), ['FPV RADIO', 'DUALSHOCK', 'CHROME']);
		assert.equal(r.or, 'OR');
	}
});

t('a radio lights the radio, and only it', () => {
	const r = report({ browserFamily: 'firefox', padId: 'FrSky Taranis X9D', padKind: 'radio' });
	assert.deepEqual(lit(r), ['radio']);
	assert.equal(r.input.state, 'recognised');
	assert.equal(r.input.verdict, 'ok');
});

t('every other recognised class lights the pad', () => {
	// padKind() grows classes; anything but 'radio' and 'generic' is a pad the
	// defaults fit, and nothing here enumerates them.
	for (const kind of ['xbox', 'playstation', 'nintendo', 'steam', 'some-future-class']) {
		const r = report({ browserFamily: 'firefox', padId: 'Some Pad', padKind: kind });
		assert.deepEqual(lit(r), ['gamepad'], kind);
		assert.equal(r.input.verdict, 'ok', kind);
	}
});

t('a Chromium-family browser lights CHROME, whatever its brand', () => {
	assert.deepEqual(lit(report({ browserFamily: 'chromium' })), ['chrome']);
	// Edge and Brave are the family, not Chrome — they light it all the same.
	for (const ua of [UA.edge, UA.opera, UA.samsung]) {
		assert.deepEqual(lit(report({ browserFamily: browserFamily(null, ua) })), ['chrome']);
	}
	for (const fam of ['firefox', 'safari', 'unknown', 'nonsense', undefined]) {
		assert.deepEqual(lit(report({ browserFamily: fam })), [], String(fam));
	}
});

t('an unknown family is treated as unknown, not passed through', () => {
	assert.equal(report({ browserFamily: 'nonsense' }).browser.family, 'unknown');
	assert.equal(report({}).browser.family, 'unknown');
});

t('an unrecognised device lights the pad, but warns and names CALIBRATE', () => {
	const r = report({ browserFamily: 'chromium', padId: 'Unknown HID 0f0d:00c1', padKind: 'generic' });
	assert.deepEqual(lit(r), ['gamepad', 'chrome']);
	assert.equal(r.input.state, 'unrecognised');
	// A device IS there, but its mapping is a guess: this operator is the one
	// who needs the CALIBRATE line, so the screen waits rather than flashing.
	assert.equal(r.input.verdict, 'warn');
	assert.equal(r.allClear, false);
	assert.equal(r.hint, HINT_CALIBRATE);
});

t('an empty list lights no pad and says how to light one', () => {
	// The trap the screen exists for: the Gamepad API reveals a device only
	// after an input on it, and the operator has just cleared the intro on the
	// keyboard. Dim is "not yet", and the hint says so.
	const r = report({ browserFamily: 'chromium', padId: '', padKind: 'generic' });
	assert.deepEqual(lit(r), ['chrome']);
	assert.equal(r.input.state, 'absent');
	assert.equal(r.hint, HINT_MOVE_STICK);
	assert.equal(r.allClear, false);
});

t('a padId with nothing but spaces counts as absent', () => {
	assert.equal(report({ padId: '   ', padKind: 'radio' }).input.state, 'absent');
	assert.equal(report({}).input.state, 'absent');
	assert.deepEqual(lit(report({ padId: '   ', padKind: 'radio' })), []);
});

// --- the only two lines of text ---------------------------------------------

t('the two hints are the only sentences, and they say what they must', () => {
	assert.equal(HINT_MOVE_STICK, 'MOVE A STICK TO DETECT IT');
	assert.match(HINT_CALIBRATE, /SETTINGS > CONTROLLER > CALIBRATE/);
	// The tab really is called CONTROLLER (src/settings.js).
	const seen = new Set();
	for (const fam of ['chromium', 'firefox', 'safari', 'unknown']) {
		for (const [id, kind] of [['', 'generic'], ['Pad', 'generic'], ['Pad', 'xbox'], ['Radio', 'radio']]) {
			const r = report({ browserFamily: fam, padId: id, padKind: kind });
			seen.add(r.hint);
			// A browser gets no sentence: the dim CHROME is the whole message.
			assert.doesNotMatch(r.hint, /CHROM|BROWSER/);
		}
	}
	assert.deepEqual([...seen].sort(), ['', HINT_CALIBRATE, HINT_MOVE_STICK].sort());
});

t('a recognised device gets no line at all', () => {
	assert.equal(report({ browserFamily: 'firefox', padId: 'p', padKind: 'xbox' }).hint, '');
	assert.equal(report({ browserFamily: 'chromium', padId: 'p', padKind: 'radio' }).hint, '');
});

t('nothing displayed ever says "no controller"', () => {
	for (const fam of ['chromium', 'firefox']) {
		const r = report({ browserFamily: fam, padId: '', padKind: 'generic' });
		const all = [r.title, r.hint, r.or, ...r.icons.map((i) => i.label)].join(' ');
		assert.doesNotMatch(all, /NO (CONTROLLER|GAMEPAD|PAD)\b/i);
		assert.doesNotMatch(all, /NOT (CONNECTED|PRESENT|FOUND)/i);
	}
});

t('everything displayed is upper case', () => {
	for (const fam of ['chromium', 'firefox', 'safari', 'unknown']) {
		for (const [id, kind] of [['', 'generic'], ['Pad', 'generic'], ['Pad', 'xbox']]) {
			const r = report({ browserFamily: fam, padId: id, padKind: kind });
			for (const s of [r.title, r.hint, r.or, ...r.icons.map((i) => i.label)]) {
				assert.equal(s, s.toUpperCase(), `${fam}/${kind}: ${s}`);
			}
		}
	}
});

// --- allClear ---------------------------------------------------------------

t('allClear is true only with a recognised device AND a Chromium browser', () => {
	const ok = { padId: 'Xbox Wireless Controller', padKind: 'xbox' };
	assert.equal(report({ browserFamily: 'chromium', ...ok }).allClear, true);
	assert.equal(report({ browserFamily: 'chromium', padId: 'X9D', padKind: 'radio' }).allClear, true);
	assert.equal(report({ browserFamily: 'firefox', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'safari', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'unknown', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'chromium', padId: '', padKind: 'generic' }).allClear, false);
	assert.equal(report({ browserFamily: 'chromium', padId: 'x', padKind: 'generic' }).allClear, false);
});

t('allClear carries the auto-dismiss delay, and only then', () => {
	assert.equal(report({ browserFamily: 'chromium', padId: 'p', padKind: 'radio' }).autoMs, READINESS_AUTO_MS);
	assert.equal(report({ browserFamily: 'firefox', padId: 'p', padKind: 'radio' }).autoMs, 0);
});

t('the old readout is gone from the model', () => {
	for (const k of ['readinessLines', 'wrap', 'WRAP_COLS']) assert.equal(model[k], undefined, k);
	const r = report({ browserFamily: 'firefox' });
	for (const k of ['rows', 'notes', 'recommendation', 'hints', 'status']) assert.equal(r[k], undefined, k);
});

console.log(`\n${n} checks passed`);
