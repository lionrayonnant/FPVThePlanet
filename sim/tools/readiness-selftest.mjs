// Selftest for the pure RECOMMENDED SETUP model (tools/readiness-model.mjs). No
// DOM, no storage of its own: the browser families, the three gamepad states,
// the all-clear switch and the storage rules are all decided there, so they can
// be checked without a browser.
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
	readinessLines,
	wrap,
	WRAP_COLS,
} from './readiness-model.mjs';

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

// --- the three input states -------------------------------------------------

const report = (o) => readinessReport(o);

t('a recognised device is a verdict, and it is named', () => {
	const r = report({ browserFamily: 'chromium', padId: 'FrSky Taranis X9D', padKind: 'radio' });
	assert.equal(r.input.state, 'recognised');
	assert.equal(r.input.verdict, 'ok');
	assert.match(r.input.value, /FRSKY TARANIS X9D/);
	assert.match(r.input.value, /RADIO/);
	assert.equal(r.allClear, true);
});

t('a class padKind has not learnt yet still counts as recognised', () => {
	// padKind() will grow classes (nintendo, steam). Anything but 'generic' is a
	// class the defaults fit, and nothing here enumerates them.
	for (const kind of ['radio', 'xbox', 'playstation', 'nintendo', 'steam']) {
		const r = report({ browserFamily: 'chromium', padId: 'Some Pad', padKind: kind });
		assert.equal(r.input.state, 'recognised', kind);
		assert.equal(r.input.verdict, 'ok', kind);
		assert.match(r.input.value, new RegExp(kind.toUpperCase()));
	}
});

t('an unrecognised device warns, and is told where its channels are set', () => {
	const r = report({ browserFamily: 'chromium', padId: 'Unknown HID 0f0d:00c1', padKind: 'generic' });
	assert.equal(r.input.state, 'unrecognised');
	// A device IS there, but its axis order and its throttle travel are a guess:
	// this operator is the only one who needs the CALIBRATE line, so the screen
	// has to WAIT rather than flash for two seconds.
	assert.equal(r.input.verdict, 'warn');
	assert.equal(r.allClear, false);
	assert.match(r.input.value, /UNRECOGNISED/);
	assert.match(r.hints.join(' '), /CALIBRATE/);
	// No hardware is recommended to someone already holding some: their line is
	// the hint, not the shopping list.
	assert.deepEqual(r.recommendation, []);
	// And it does not also claim the setup is good.
	assert.equal(r.status, '');
});

t('an empty list is NEVER "no controller"', () => {
	// The trap the screen exists for: the Gamepad API reveals a device only
	// after an input on it, and the operator has just cleared the intro on the
	// keyboard.
	const r = report({ browserFamily: 'chromium', padId: '', padKind: 'generic' });
	assert.equal(r.input.state, 'absent');
	assert.equal(r.input.verdict, 'warn');
	assert.equal(r.input.value, 'NOT DETECTED YET');
	const all = [r.input.value, ...r.hints, ...r.recommendation, ...r.notes].join(' ');
	assert.doesNotMatch(all, /NO (CONTROLLER|GAMEPAD|PAD)\b/i);
	assert.doesNotMatch(all, /NOT (CONNECTED|PRESENT|FOUND)/i);
	assert.match(r.hints.join(' '), /MOVE A STICK/);
	assert.equal(r.allClear, false);
});

t('a padId with nothing but spaces counts as absent', () => {
	assert.equal(report({ padId: '   ', padKind: 'radio' }).input.state, 'absent');
	assert.equal(report({}).input.state, 'absent');
});

// --- the verdicts and allClear ----------------------------------------------

t('allClear is true only when both subjects are ok', () => {
	const ok = { padId: 'Xbox Wireless Controller', padKind: 'xbox' };
	assert.equal(report({ browserFamily: 'chromium', ...ok }).allClear, true);
	assert.equal(report({ browserFamily: 'firefox', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'safari', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'unknown', ...ok }).allClear, false);
	assert.equal(report({ browserFamily: 'chromium', padId: '', padKind: 'generic' }).allClear, false);
	// An enumerated but unrecognised device warns: its mapping is a guess, and
	// the screen has to stay up long enough to say where that is settled.
	assert.equal(report({ browserFamily: 'chromium', padId: 'x', padKind: 'generic' }).allClear, false);
	assert.equal(report({ browserFamily: 'firefox', padId: '', padKind: 'generic' }).allClear, false);
});

t('allClear carries the auto-dismiss delay, and only then', () => {
	assert.equal(report({ browserFamily: 'chromium', padId: 'p', padKind: 'radio' }).autoMs, READINESS_AUTO_MS);
	assert.equal(report({ browserFamily: 'firefox', padId: 'p', padKind: 'radio' }).autoMs, 0);
});

t('an unknown family is treated as unknown, not passed through', () => {
	const r = report({ browserFamily: 'nonsense', padId: 'p', padKind: 'radio' });
	assert.equal(r.browser.family, 'unknown');
	assert.equal(r.browser.verdict, 'warn');
	assert.equal(r.browser.value, 'UNKNOWN');
	assert.equal(report({}).browser.family, 'unknown');
});

t('a warned browser is argued for qualitatively, with no numbers', () => {
	const r = report({ browserFamily: 'firefox', padId: 'p', padKind: 'radio' });
	assert.equal(r.browser.verdict, 'warn');
	const text = r.recommendation.join(' ');
	assert.match(text, /CHROMIUM/);
	assert.doesNotMatch(text, /\d/, 'no figures on this screen');
	// A good browser says nothing about browsers.
	const good = report({ browserFamily: 'chromium', padId: '', padKind: 'generic' });
	assert.doesNotMatch(good.recommendation.join(' '), /CHROMIUM/);
});

t('a missing controller is argued for with the radio and the pads', () => {
	const r = report({ browserFamily: 'chromium', padId: '', padKind: 'generic' });
	const text = r.recommendation.join(' ');
	assert.match(text, /EDGETX/);
	assert.match(text, /DUALSHOCK/);
	assert.match(text, /XBOX/);
});

t('both warnings produce both arguments, separated', () => {
	const r = report({ browserFamily: 'safari', padId: '', padKind: 'generic' });
	const text = r.recommendation.join(' ');
	assert.match(text, /EDGETX/);
	assert.match(text, /CHROMIUM/);
	assert.ok(r.recommendation.includes(''), 'a blank line between the two');
});

t('the browser row prints the brand when one is given, the family otherwise', () => {
	assert.equal(report({ browserFamily: 'firefox', browserName: 'Firefox' }).browser.value, 'FIREFOX');
	assert.equal(report({ browserFamily: 'chromium' }).browser.value, 'CHROMIUM FAMILY');
	assert.equal(report({ browserFamily: 'chromium', browserName: 'Brave' }).browser.value, 'BRAVE');
});

// --- what the screen is made of ---------------------------------------------

t('two rows, always, labelled BROWSER and INPUT', () => {
	for (const o of [{}, { browserFamily: 'chromium', padId: 'p', padKind: 'radio' }]) {
		const r = report(o);
		assert.deepEqual(r.rows.map((x) => x[0]), ['BROWSER', 'INPUT']);
		assert.equal(r.rows.length, 2);
	}
});

t('everything displayed is upper case English', () => {
	for (const fam of ['chromium', 'firefox', 'safari', 'unknown']) {
		for (const pad of [['', 'generic'], ['Pad', 'generic'], ['Pad', 'xbox']]) {
			const r = report({ browserFamily: fam, padId: pad[0], padKind: pad[1] });
			const shown = [...r.rows.flat(), ...r.recommendation, ...r.hints, r.status, r.title];
			for (const s of shown) assert.equal(s, s.toUpperCase(), `${fam}/${pad[1]}: ${s}`);
			// The crew remarks are the one lower-case voice, exactly as on
			// HARDWARE DISCOVERY.
			for (const note of r.notes) assert.match(note, /^\/\/ [a-z]+: /);
			assert.equal(r.notes.length, 2);
		}
	}
});

t('the all-clear readout still says one thing', () => {
	const r = report({ browserFamily: 'chromium', padId: 'Xbox Wireless Controller', padKind: 'xbox' });
	assert.match(r.status, /GOOD/);
	assert.deepEqual(r.recommendation, []);
	assert.deepEqual(r.hints, []);
	assert.equal(report({ browserFamily: 'firefox' }).status, '');
});

t('no line is wider than the wrap column', () => {
	for (const fam of ['chromium', 'firefox', 'safari', 'unknown']) {
		const r = report({ browserFamily: fam, padId: '', padKind: 'generic' });
		for (const line of [...r.recommendation, ...r.hints]) {
			assert.ok(line.length <= WRAP_COLS, `${line.length}: ${line}`);
		}
	}
});

t('wrap breaks on words and never loses one', () => {
	assert.deepEqual(wrap('', 10), []);
	assert.deepEqual(wrap('ONE TWO THREE', 100), ['ONE TWO THREE']);
	const lines = wrap('AAAA BBBB CCCC DDDD', 9);
	assert.deepEqual(lines, ['AAAA BBBB', 'CCCC DDDD']);
	assert.equal(wrap('  A   B  ', 40).join(' '), 'A B');
});

t('readinessLines lays the screen out, title first, dots injected', () => {
	const r = report({ browserFamily: 'firefox', padId: '', padKind: 'generic' });
	const lines = readinessLines(r, (l, v) => `${l}=${v}`);
	assert.equal(lines[0], 'RECOMMENDED SETUP');
	assert.equal(lines[1], '');
	assert.equal(lines[2], 'BROWSER=FIREFOX');
	assert.equal(lines[3], 'INPUT=NOT DETECTED YET');
	assert.ok(lines.includes('// root: nothing on the bus'));
	assert.match(lines.join('\n'), /EDGETX/);
	assert.match(lines.join('\n'), /MOVE A STICK/);
	// A default dot function keeps it usable with no renderer at all.
	assert.ok(readinessLines(r)[2].startsWith('BROWSER '));
});

t('readinessLines on the all-clear report is short and buttonless by nature', () => {
	const r = report({ browserFamily: 'chromium', padId: 'FrSky Taranis', padKind: 'radio', browserName: 'Chrome' });
	const lines = readinessLines(r, (l, v) => `${l}=${v}`);
	assert.equal(lines[2], 'BROWSER=CHROME');
	assert.match(lines.join('\n'), /RADIO/);
	assert.match(lines.join('\n'), /GOOD/);
	assert.doesNotMatch(lines.join('\n'), /CHROMIUM-BASED/);
});

console.log(`\n${n} checks passed`);
