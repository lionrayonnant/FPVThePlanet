// Visual language selftest (PHASE 19, issue #56). No DOM I/O, no network.
// Run: node tools/palette-selftest.mjs
//
// This test judges nothing aesthetic — that's the operator's eye. It mechanically
// checks the two acceptance criteria of the issue that ARE checkable:
//
//   "src/style.css reworked around tokens"
//   "No daily screen uses the demo palette"
//
// plus the hardware constraints the fonts impose that a human won't catch by
// rereading CSS: Departure Mono's 11 px grid, and the fact that the two
// families don't share the same advance width.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sim = join(here, '..');
const read = (p) => readFileSync(join(sim, p), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const TOKENS = read('src/tokens.css');
const GAME = read('src/style.css');
const MAPGUI = read('tools/map-gui/style.css');

// The demo colours (Bible §19), and the only places allowed to touch them: the
// hack's culmination (#101) and the intro. The rest of the hack stays
// monochrome — it's the culmination that explodes, not the analysis leading to it.
const DEMO_TOKENS = ['--cyan', '--magenta', '--violet', '--electric'];
const EVENT_SELECTORS = ['.intro', '.culmination'];

// Coarse but sufficient split: a rule is whatever precedes `{`, once comments
// are stripped. @media/@keyframes blocks leave their preamble in the selector,
// hence the `lastIndexOf('{')`.
function rules(css) {
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	for (const chunk of bare.split('}')) {
		const i = chunk.lastIndexOf('{');
		if (i < 0) continue;
		out.push({ selector: chunk.slice(0, i).trim(), body: chunk.slice(i + 1) });
	}
	return out;
}

// Lines annotated `/* palette-ok: … */` are declared exceptions: an alpha-mask
// stop, a light halo. They must say why.
function colourLiterals(css) {
	// Comments are blanked out while keeping their line breaks, so the reported
	// line number matches the file — a comment may perfectly well quote an old
	// value, and that's even desirable.
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
	const src = css.split('\n');
	const hits = [];
	bare.split('\n').forEach((line, i) => {
		if (src[i].includes('palette-ok:')) return;
		if (/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/.test(line)) {
			hits.push(`${i + 1}: ${src[i].trim()}`);
		}
	});
	return hits;
}

// A JS source stripped of its comments, and the strings it contains. Written
// by hand rather than with a regex: a French apostrophe in a comment — and
// there are plenty throughout this repo — opens a fake string and derails any
// naive analysis. Walking character by character is the only way to tell the
// three states apart (code, comment, string).
function scanJs(src) {
	const strings = [];
	let code = '';
	let line = 1;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === '\n') { line++; code += c; continue; }
		if (c === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			i--;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') { line++; code += '\n'; }
				i++;
			}
			i++;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			const start = line;
			let text = '';
			code += c;
			i++;
			for (; i < src.length; i++) {
				if (src[i] === '\\') { text += src[i + 1]; i += 1; continue; }
				if (src[i] === quote) break;
				if (src[i] === '\n') { line++; }
				text += src[i];
			}
			strings.push({ line: start, text });
			code += text + quote;
			continue;
		}
		code += c;
	}
	return { code, strings };
}
const stripComments = (src) => scanJs(src).code;
const stringLiterals = (src) => scanJs(src).strings;

// -------------------------------------------------------------------- tokens

t('tokens.css: the 5 greys, the 4 functional and the 4 demo tokens are defined', () => {
	for (const name of ['--black', '--dark-grey', '--grey', '--light-grey', '--warm-white',
		'--green', '--yellow', '--orange', '--red', ...DEMO_TOKENS]) {
		assert.match(TOKENS, new RegExp(`\\n\\t${name}:`), `${name} is missing from tokens.css`);
	}
});

t('tokens.css: the grey ramp is warm-neutral (R ≥ G ≥ B) and monotonic', () => {
	const ramp = ['--black', '--dark-grey', '--grey', '--light-grey', '--warm-white'];
	let prev = -1;
	for (const name of ramp) {
		const hex = TOKENS.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1];
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
		assert.ok(r >= g && g >= b, `${name} (${hex}) is not warm: R ${r} G ${g} B ${b}`);
		const lum = r + g + b;
		assert.ok(lum > prev, `${name} is not lighter than the previous token`);
		prev = lum;
	}
});

t('the two stylesheets contain no colour literal outside tokens.css', () => {
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		const hits = colourLiterals(css);
		assert.deepEqual(hits, [], `${name} paints in the raw:\n    ${hits.join('\n    ')}`);
	}
});

t('map-gui does import the shared base rather than redeclaring its own tokens', () => {
	assert.match(MAPGUI, /@import '\.\.\/\.\.\/src\/tokens\.css';/);
	assert.match(GAME, /@import '\.\/tokens\.css';/);
	// Only one token still belongs to it, and it's a measurement, not a pigment.
	const own = [...MAPGUI.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]);
	assert.deepEqual(own, ['--rail']);
	// On the game side, one too (#73): the size of the brand mark on the cracktro.
	// A measurement, not a pigment — and it MUST be a variable, because the
	// stacked lockup expresses all its gaps in multiples of this size
	// (docs/brand.md: the gap to the name is worth 1 module, the clear space 4).
	// It's local and not a token because it's only meaningful there: nothing
	// else in the game is measured in brand-mark modules.
	const gameOwn = [...GAME.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]);
	assert.deepEqual(gameOwn, ['--mark-size'],
		'a local token was added to src/style.css: is it really a measurement, and not a pigment?');
});

t('every var(--…) referenced by the stylesheets is defined in tokens.css', () => {
	const defined = new Set([...TOKENS.matchAll(/^\t(--[a-z-]+):/gm)].map((m) => m[1]));
	// The two local measurements, declared by the stylesheet that uses them and
	// checked right above: these are the only exemptions.
	defined.add('--rail');
	defined.add('--mark-size');
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		for (const m of css.matchAll(/var\((--[a-z-]+)\)/g)) {
			assert.ok(defined.has(m[1]), `${name} uses ${m[1]}, which tokens.css does not define`);
		}
	}
});

// ------------------------------------------------------- demo segregation

t('the demo palette surfaces only on the culmination and the intro', () => {
	for (const { selector, body } of rules(GAME)) {
		const used = DEMO_TOKENS.filter((tk) => body.includes(`var(${tk})`));
		if (!used.length) continue;
		assert.ok(EVENT_SELECTORS.some((s) => selector.includes(s)),
			`"${selector}" uses ${used.join(', ')} outside an event (Bible §19)`);
	}
});

t('the prep console has no access at all to the demo palette', () => {
	for (const tk of DEMO_TOKENS) {
		assert.ok(!MAPGUI.includes(`var(${tk})`), `map-gui uses ${tk}: this is not an event`);
	}
});

t('no daily screen still calls back to the old cyan accent', () => {
	// --accent disappeared with PHASE 19: the current UI's accent is WARM WHITE,
	// and cyan is back to being an event colour.
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		assert.ok(!css.includes('var(--accent)'), `${name} still uses var(--accent)`);
	}
	assert.ok(!TOKENS.includes('--accent:'), 'tokens.css redefines --accent');
});

// ------------------------------------------------------------- typography

t('exactly the three levels, and not one more, are declared', () => {
	for (const cls of ['.t-display', '.t-ui', '.t-data']) {
		assert.ok(TOKENS.includes(cls), `${cls} is missing`);
	}
	const families = [...TOKENS.matchAll(/^\t--font-[a-z]+: '([^']+)'/gm)].map((m) => m[1]);
	assert.deepEqual([...new Set(families)].sort(), ['Departure Mono', 'IBM Plex Mono'],
		'exactly two embedded font families');
});

t('the two families never mix within the same stack', () => {
	// Their advance widths differ (0.6 em vs 0.6364): a glyph-by-glyph fallback
	// would misalign every ┌─┐ frame from Bible §38.
	for (const m of TOKENS.matchAll(/--font-[a-z]+:([^;]+);/g)) {
		const stack = m[1];
		assert.ok(!(stack.includes('Departure Mono') && stack.includes('IBM Plex Mono')),
			`mixed stack forbidden: ${stack.trim()}`);
	}
});

t('Departure Mono is only ever used at multiples of 11px', () => {
	// The font is drawn on a 50-unit grid for 550 of em: outside multiples of
	// 11 px, its pixels fall between two screen pixels and the "bitmap" blurs.
	// Measured on the embedded woff2.
	for (const m of TOKENS.matchAll(/--fs-display[a-z-]*: (\d+)px;/g)) {
		assert.equal(Number(m[1]) % 11, 0, `--fs-display… = ${m[1]}px is off the grid`);
	}
	for (const { selector, body } of rules(GAME)) {
		if (!/var\(--font-(display|ascii)\)/.test(body)) continue;
		for (const c of body.matchAll(/font-size: clamp\((\d+)px,[^,]+, ?(\d+)px\)/g)) {
			for (const px of [c[1], c[2]]) {
				assert.equal(Number(px) % 11, 0,
					`"${selector}": ${px}px is off Departure Mono's 11px grid`);
			}
		}
	}
});

t('no weight that the embedded files do not carry', () => {
	// Only 400 and 500 are served. Beyond that the browser synthesizes a fake
	// bold — on a fixed advance width, it distorts the block's colour.
	for (const [name, css] of [['src/style.css', GAME], ['tools/map-gui/style.css', MAPGUI]]) {
		for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font-weight: ([^;]+);/g)) {
			assert.ok(['400', '500'].includes(m[1].trim()),
				`${name} requests font-weight ${m[1].trim()}: not embedded`);
		}
	}
});

t('both fonts and their licenses are indeed in the repo', () => {
	for (const f of ['DepartureMono-Regular.woff2', 'IBMPlexMono-Regular.woff2',
		'IBMPlexMono-Medium.woff2', 'OFL-DepartureMono.txt', 'OFL-IBMPlexMono.txt']) {
		assert.ok(readFileSync(join(sim, 'public/fonts', f)).length > 0, `${f} is missing or empty`);
	}
	for (const f of ['OFL-DepartureMono.txt', 'OFL-IBMPlexMono.txt']) {
		assert.match(read(join('public/fonts', f)), /SIL Open Font License, Version 1\.1/,
			`${f} is not an OFL 1.1`);
	}
	// Served from public/, never from a CDN: the game installs offline.
	for (const m of TOKENS.matchAll(/src: url\('([^']+)'\)/g)) {
		assert.match(m[1], /^\/fonts\//, `font served from ${m[1]}`);
	}
});

// --------------------------------------------------------- the bridge to JS

t('palette.js fallback values match the tokens', () => {
	const js = read('src/palette.js');
	const fallbacks = [...js.matchAll(/'(--[a-z-]+)': '(#[0-9a-f]{6})'/g)];
	assert.ok(fallbacks.length >= 6, 'the fallback table has disappeared');
	for (const [, name, value] of fallbacks) {
		const m = TOKENS.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
		assert.ok(m, `${name} no longer exists in tokens.css`);
		assert.equal(value, m[1], `${name} fallback out of sync: ${value} vs ${m[1]}`);
	}
});

t('no more hardcoded colour in the scanner\'s vector layers', () => {
	const js = read('src/scanner.js').replace(/\/\/.*$/gm, '');
	const hits = [...js.matchAll(/(?:color|fillColor): '(#[0-9a-fA-F]{3,8})'/g)].map((m) => m[1]);
	assert.deepEqual(hits, [], `scanner.js still paints in the raw: ${hits.join(', ')}`);
});

// --- the `pointer-events` trap of #ui ---------------------------------------

// `#ui` is `pointer-events: none` and ONLY `button, input, select, label` take
// the pointer back. Any full-frame screen that contains an interactive element
// of another kind — a Leaflet map is a <div>, its zoom controls are <a> —
// must therefore reclaim the pointer itself.
//
// This test exists because the rule was lost once: `.scanner` carried it, it
// disappeared with the scanner's full-frame rework (#211), and FIELD ended up
// with a map that was VISIBLE BUT DEAF — you could see it but not pan it. No
// render selftest can catch this: the fake DOM computes no style, and the tree
// was perfectly correct.
t('pointer-events: any screen carrying a map reclaims the pointer', () => {
	assert.match(GAME, /#ui\s*\{[^}]*pointer-events:\s*none/,
		'the test\'s premise: #ui lets clicks pass through');
	// `.terminal-field` is FIELD's full frame, which carries the GLOBAL SCANNER
	// map in its right-hand column.
	const bloc = GAME.match(/\.terminal-field\s*\{[\s\S]*?\}/);
	assert.ok(bloc, '.terminal-field exists');
	assert.match(bloc[0], /pointer-events:\s*auto/,
		'without which the map is visible but deaf');
});

// ====================================================================== #140
// THE BLIND SPOT. Everything above only looks at CSS, and the drift lives
// elsewhere: in the JS that paints on its own, in non-colour values, and in
// the strings that reach the screen. The three blocks below cover that.

// --- (a) the demo palette reached from JS ------------------------------------

// `token('--cyan')` bypasses exactly what the CSS rule above forbids. A few
// daily screens touch it, and these are DELIBERATE EXCEPTIONS, not oversights:
// the coverage blot would lose its legibility in monochrome, DATA's selected
// point is the only landmark on a page of graphs, and the hangar's backdrop is
// the fence dome itself. They're named here so another one doesn't slip
// through silently.
const DEMO_JS_ALLOWED = new Map([
	['src/intro.js', 'the cracktro (Bible §19)'],
	['src/culmination.js', 'the hack\'s culmination (#101)'],
	['src/palette.js', 'the fallback table, which declares the same exception'],
	['src/scanner.js', 'DELIBERATE EXCEPTION: the map coverage blot'],
	['src/map-coverage.js', 'DELIBERATE EXCEPTION: the map coverage blot'],
	['src/graph.js', 'DELIBERATE EXCEPTION: a DATA graph\'s selected point'],
	// The hangar's backdrop is the fence dome's living mass, behind the
	// machines only (issue #185). The exception and its reason are recorded in
	// the Bible, section "Signaux et habilitation".
	['src/hangar.js', 'DELIBERATE EXCEPTION: the hangar backdrop (Bible, "Signaux et habilitation")'],
]);

t('the demo palette is also unreachable via token() from a daily screen', () => {
	for (const f of readdirSync(join(sim, 'src')).filter((f) => f.endsWith('.js'))) {
		const rel = `src/${f}`;
		const js = stripComments(read(rel));
		const used = DEMO_TOKENS.filter((tk) => js.includes(`token('${tk}')`) || js.includes(`'${tk}'`));
		if (!used.length) continue;
		assert.ok(DEMO_JS_ALLOWED.has(rel),
			`${rel} reaches ${used.join(', ')} via JS: the CSS rule cannot see it. `
			+ 'If intentional, list it in DEMO_JS_ALLOWED with its reason.');
	}
});

// --- (b) the scales ----------------------------------------------------------

// A size, letter-spacing or spacing value written in pixels is one more scale:
// that's how the game's body text ended up at 14px, off both scales, and how
// thirty magic paddings coexisted. A component's dimensions (a bar's height, a
// Leaflet tile's size) are not spacings and don't get flagged here — only
// padding, margin and gap are rhythm decisions.
const SCALE_PROPS = /(?:^|[;{\s])(font-size|letter-spacing|padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?: *([^;]+)/g;

// The extraction console (tools/map-gui/) is outside the game and keeps its
// own sizes for now: that's its own issue's concern, not this one's.
t('no size, letter-spacing or spacing outside the tokens', () => {
	for (const [name, css] of [['src/style.css', GAME]]) {
		const src = css.split('\n');
		const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
		const hits = [];
		bare.split('\n').forEach((line, i) => {
			if (src[i].includes('scale-ok:')) return;
			for (const m of line.matchAll(SCALE_PROPS)) {
				const value = m[3].trim();
				// What's legitimate: a token, a token computation, zero, a measure
				// relative to text (em, ch) or to the viewport (vw, %).
				if (value.includes('var(--')) continue;
				// A display-font clamp() is already judged, more strictly, by the
				// Departure Mono 11px grid test.
				if (value.includes('clamp(')) continue;
				if (!/\d/.test(value)) continue;
				if (!/\b\d*\.?\d+px\b/.test(value)) continue;
				hits.push(`${i + 1}: ${src[i].trim()}`);
			}
		});
		const uniq = [...new Set(hits)];
		assert.deepEqual(uniq, [],
			`${name} writes a scale value in the raw:\n    ${uniq.join('\n    ')}`);
	}
});

// --- (c) the screen's language ----------------------------------------------

// Bible §11: the game is entirely in English. COMMENTS, though, may still be
// French — the repo is moving its comments to English file by file (#88): a
// file touched for other reasons leaves in English. So this test only looks at
// strings, comments stripped for good (a French apostrophe in a comment would
// otherwise look like a string), and only in the modules that write to the
// screen: elsewhere, a French console message is right at home.
const SCREEN_MODULES = [
	'hud.js', 'loader.js', 'terminal.js', 'bench.js', 'settings.js', 'scanner.js',
	'session-log.js', 'jukebox.js', 'briefing.js', 'bootstrap.js', 'intro.js',
	'flight-end.js', 'fpvtp-osd.js', 'hack.js', 'brand-lockup.js', 'screen.js',
	'flightController.js', 'target-scan.js', 'calibration.js', 'confirm-button.js',
];
const ACCENTED = /[À-ÖØ-öø-ÿŒœ«»]/;
// Accents aren't enough: "chargement…" carries none, and it happened to be the
// most-seen string in the game. Hence this handful of French function words,
// matched whole — none of them is an English word.
const FRENCH_WORDS = /\b(le|la|les|des|une|un|pour|avec|dans|sur|pas|est|sont|aucun|aucune|chargement|fermez|lancez|relancez|touche|écran)\b/i;

t('no French word in a string from a module that writes to the screen', () => {
	const hits = [];
	for (const f of SCREEN_MODULES) {
		const src = read(`src/${f}`);
		const lines = src.split('\n');
		for (const { line, text } of stringLiterals(src)) {
			// An HTML comment inside a template isn't displayed either.
			const shown = text.replace(/<!--[\s\S]*?-->/g, '');
			if (!ACCENTED.test(shown) && !FRENCH_WORDS.test(shown)) continue;
			if (/console\.(log|warn|error|info|debug)/.test(lines[line - 1] ?? '')) continue;
			hits.push(`src/${f}:${line}: ${shown.trim().slice(0, 70)}`);
		}
	}
	assert.deepEqual(hits, [],
		`French reaches the screen:\n    ${hits.join('\n    ')}`);
});

console.log(`\n  ${n} tests OK — visual language (PHASE 19)`);
