// node tools/trace-wiring-selftest.mjs — the WIRING of the signal trace in
// src/main.js (issue #185 lot 4). It reads text, not behaviour, like
// tools/swarm-wiring-selftest.mjs: main.js cannot be instantiated in Node, and
// these rules live only there.
//   1. A live collider flush re-validates the trace.
//   2. updateSignals(): the trace before the capture (a trace flown to its end
//      is uplinked by the same frame's capture), and the trace resolves through
//      resolveByTrace(); off the flight the trace is dropped.
//   3. Every photo goes through captureClean() (the line hidden, the frame
//      redrawn, the line back via `after`): no bare lens.capture() elsewhere.
//      The trace photo is taken in the post-render window, before the uplink
//      frame, and only for a view better than the best by a margin.
//   4. disarmSignals() resets the traces; a crash / link dead only stops them.
//      The uplink entry carries `trace`. The callout never picks a hidden row.
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// The body of a block, from the `{` after `header` to its matching `}`. Naive
// about braces in strings and comments, which is enough to find calls.
function bodyAfter(header) {
	const i = src.indexOf(header);
	if (i < 0) return null;
	const open = src.indexOf('{', i + header.length);
	let depth = 0;
	for (let k = open; k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(open, k);
	}
	return null;
}

console.log('trace-wiring: collider flush');
{
	const work = bodyAfter('function processLiveNodeWork(');
	check('processLiveNodeWork() is found', work !== null);
	check('a flush that changed colliders re-validates the trace',
		/if\s*\(physics\.flushNodeColliders\(\)\)\s*signalTraces\.collidersChanged\(\)/.test(work ?? ''));
	check('the physics methods go in as closures, not unbound methods',
		/groundBelow:\s*\(x, y, z, max\)\s*=>\s*physics\.groundBelow\(/.test(src)
		&& /rayUp:\s*\(x, y, z, max\)\s*=>\s*physics\.rayUp\(/.test(src)
		&& /obstructionBetween:\s*\([^)]*\)\s*=>\s*physics\.obstructionBetween\(/.test(src));
}

console.log('\ntrace-wiring: updateSignals()');
{
	const upd = bodyAfter('function updateSignals(') ?? '';
	const trace = upd.indexOf('updateTrace(');
	const capture = upd.indexOf('signalCapture.update(');
	check('the trace is updated before the capture', trace > 0 && capture > trace, `trace@${trace} capture@${capture}`);
	check('only while signalsLive(); otherwise the trace is stopped (not reset: the hold fallbacks stay)',
		/if\s*\(flying\)\s*updateTrace\(/.test(upd) && /else if\s*\(signalTraces\.id\)\s*\{[^}]*signalTraces\.stop\(\)/.test(upd)
		&& !/signalTraces\.reset\(\)/.test(upd));
	check('the stopped id gets its gauge dropped', /signalCapture\.setTraceProgress\(id,\s*0,\s*null\)/.test(upd));
	const ut = bodyAfter('function updateTrace(') ?? '';
	check('a trace flown to its end resolves through the capture', /signalCapture\.resolveByTrace\(tr\.done\)/.test(ut));
	check('a trace that cannot be laid puts the signal back on the hold', /t\.trace\s*=\s*false/.test(ut));
	check('the line gets the composer resolution', /traceLine\.setResolution\(/.test(ut));
	const frame = bodyAfter('function frame()') ?? '';
	const flightEnd = frame.indexOf('flightEnd.update(');
	const signals = frame.indexOf('updateSignals(');
	check('updateSignals() runs after flightEnd.update()', flightEnd > 0 && signals > flightEnd, `end@${flightEnd} signals@${signals}`);
}

console.log('\ntrace-wiring: the photo');
{
	const clean = bodyAfter('function captureClean()') ?? '';
	const hide = clean.indexOf('traceLine.setVisible(false)');
	const cap = clean.indexOf('lens.capture(');
	check('captureClean() hides the line before lens.capture()', hide >= 0 && cap > hide, `${hide} ${cap}`);
	check('it redraws the frame and shows the line again in after()',
		/lens\.capture\(\{\s*redraw:\s*true,\s*after:\s*\(\)\s*=>\s*traceLine\.setVisible\(true\)\s*\}\)/.test(clean));
	// Every lens.capture( in main.js outside comments must be the helper's.
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const bare = (code.match(/lens\.capture\(/g) ?? []).length;
	check('no bare lens.capture() outside captureClean()', bare === 1, `${bare} call(s)`);
	for (const fn of ['async function capturePhoto()', 'function takeTracePhoto({ id, score })', 'async function uplinkFrame(up)']) {
		check(`${fn.replace(/^(async )?function /, '')} goes through captureClean()`, /captureClean\(\)/.test(bodyAfter(fn) ?? ''));
	}
	const score = bodyAfter('function scoreTracePhoto(') ?? '';
	check('a trace photo needs a view better than the best by TRACE_PHOTO_MARGIN',
		/traceBest\.score \+ TRACE_PHOTO_MARGIN/.test(score) && /const TRACE_PHOTO_MARGIN = 0\.05/.test(src));
	const frame = bodyAfter('function frame()') ?? '';
	const render = frame.indexOf('lens.render(');
	const photo = frame.indexOf('takeTracePhoto(');
	const uplink = frame.indexOf('uplinkFrame(');
	check('taken right after lens.render(), before the uplink frame', render > 0 && photo > render && uplink > photo, `render@${render} photo@${photo} uplink@${uplink}`);
}

console.log('\ntrace-wiring: flight end and the uplink entry');
{
	const dis = bodyAfter('function disarmSignals()') ?? '';
	check('disarmSignals() resets the traces', /signalTraces\.reset\(\)/.test(dis));
	const callout = bodyAfter('function renderSignalCallout(') ?? '';
	check('the flown trace takes the callout only from a visible row',
		/r\.id === flown && r\.state !== 'hidden'/.test(callout));
	const up = bodyAfter('function onSignalUplinked(') ?? '';
	check('the entry carries the shape of a trace flown', /trace:\s*tr\.shape/.test(up));
	check('and its seconds on the trace as holdS', /const holdS = tr \? tr\.holdS : HOLD_S/.test(up));
}

console.log(failures ? `\n${failures} failure(s).` : '\ntrace-wiring: all pass.');
process.exit(failures ? 1 : 0);
