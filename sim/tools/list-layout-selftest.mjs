// A layout guard the render selftests structurally cannot catch, because they
// mount on a fake DOM with no layout at all (tools/lib/fake-dom.mjs).
// Run: node tools/list-layout-selftest.mjs
//
// What it protects: a scrolling list must SCROLL, not squeeze.
//
// Flex items shrink by default. A column with `max-height` and `overflow-y:
// auto` therefore has two possible behaviours, and the default is the wrong
// one: rather than overflowing and handing the overflow to the scrollbar, the
// browser shrinks every item until the whole list fits the cap. With 143 tracks
// in the JUKEBOX's ALL view that put each 24.8px row at 6.5px — the rows were
// all there, in the right order, with the right text, and not one of them was
// readable. Under twenty items nothing shrinks, so every pool filter looked
// perfect and only ALL was broken.
//
// The fix is one declaration (`flex: none` on the children), and it is exactly
// the kind of thing that gets dropped by the next person who rewrites a list —
// hence this test rather than a comment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, '..', 'src', 'style.css'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// One rule = what precedes its `{`, comments removed. Same coarse cut as
// tools/palette-selftest.mjs, and sufficient for the same reason: this
// stylesheet has no nesting.
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

const RULES = rules(CSS);

// A capped scrolling column: the shape that shrinks its children silently.
const capped = RULES.filter((r) => /flex-direction:\s*column/.test(r.body)
	&& /max-height:/.test(r.body)
	&& /overflow(-y)?:\s*auto/.test(r.body));

t('the stylesheet still has scrolling lists to protect', () => {
	assert.ok(capped.length >= 2, `found ${capped.length} capped scrolling columns`);
});

t('every capped scrolling column keeps its children at their natural height', () => {
	// `flex: none` is `flex: 0 0 auto`; `flex-shrink: 0` says the same thing.
	const holds = (sel) => RULES.some((r) => new RegExp(`(^|,)\\s*${sel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*>\\s*\\*`).test(r.selector)
		&& (/flex:\s*none/.test(r.body) || /flex:\s*0\s+0/.test(r.body) || /flex-shrink:\s*0/.test(r.body)));

	const naked = [];
	for (const r of capped) {
		// A rule may cap several lists at once; each selector answers for itself.
		for (const sel of r.selector.split(',').map((s) => s.trim())) {
			// Only class selectors are addressed by a `> *` companion; anything
			// else is out of this guard's reach and says so by being skipped.
			if (!/^\.[A-Za-z0-9_-]+$/.test(sel)) continue;
			if (!holds(sel)) naked.push(sel);
		}
	}
	assert.deepEqual(naked, [],
		'these lists squeeze their rows instead of scrolling — they need '
		+ `\`<selector> > * { flex: none; }\`:\n    ${naked.join('\n    ')}`);
});

console.log(`\n${n} list-layout tests OK`);
