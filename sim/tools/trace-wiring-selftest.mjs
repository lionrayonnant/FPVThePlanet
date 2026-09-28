// node tools/trace-wiring-selftest.mjs — the WIRING of the signal trace in
// src/main.js (issue #185 lot 4). It reads text, not behaviour, like
// tools/swarm-wiring-selftest.mjs: main.js cannot be instantiated in Node, and
// these rules live only there.
//   1. A live collider flush re-validates the trace.
//   2. updateSignals(): the trace before the capture (a trace flown to its end
//      is uplinked by the same frame's capture), and the trace resolves through
//      resolveByTrace(); off the flight the trace is dropped.
//   3. No photo shows the line. The photos taken in flight (a trace's best
//      view, the uplink frame) use lens.grab() — no redraw, no stall — with the
//      line kept out of that frame's own render and shown again right after
//      the grabs; the manual photo goes through captureClean() (the line
//      hidden, the frame redrawn, the line back via `after`), the only
//      lens.capture(). A trace photo needs a view better than the best by a
//      margin, at most one per TRACE_PHOTO_GAP_S (#185: freezes in flight).
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
	check('the manual photo goes through captureClean()', /captureClean\(\)/.test(bodyAfter('async function capturePhoto()') ?? ''));
	check('the trace photo is a lens.grab(), not a redraw', /lens\.grab\(\)/.test(bodyAfter('function takeTracePhoto({ id, score })') ?? '')
		&& !/captureClean\(\)/.test(bodyAfter('function takeTracePhoto({ id, score })') ?? ''));
	check('the uplink frame is the best view or a lens.grab(), never a redraw',
		!/captureClean\(\)/.test(bodyAfter('async function uplinkFrame(up)') ?? ''));
	const score = bodyAfter('function scoreTracePhoto(') ?? '';
	check('a trace photo needs a view better than the best by TRACE_PHOTO_MARGIN',
		/traceBest\.score \+ TRACE_PHOTO_MARGIN/.test(score) && /const TRACE_PHOTO_MARGIN = 0\.05/.test(src));
	check('and waits TRACE_PHOTO_GAP_S after the last one of that trace',
		/tracePhotoTakenAt < TRACE_PHOTO_GAP_S/.test(score) && /const TRACE_PHOTO_GAP_S = 2/.test(src));
	check('a trace photo due hides the line BEFORE the render (the frame is the photo)',
		/pendingTracePhoto = \{ id, score \};\s*lineOffForPhoto = true;\s*traceLine\.setVisible\(false\);/.test(score));
	const up = bodyAfter('function onSignalUplinked(') ?? '';
	check('an uplink with no best view hides the line too',
		/if \(!cap\) \{ lineOffForPhoto = true; traceLine\.setVisible\(false\); \}/.test(up));
	const frame = bodyAfter('function frame()') ?? '';
	const render = frame.indexOf('lens.render(');
	const photo = frame.indexOf('takeTracePhoto(');
	const uplink = frame.indexOf('up.cap ??= lens.grab()');
	const back = frame.indexOf('traceLine.setVisible(true)');
	const manual = frame.indexOf('capturePhoto()');
	check('grabbed right after lens.render(): the trace photo, then the uplink frame',
		render > 0 && photo > render && uplink > photo, `render@${render} photo@${photo} uplink@${uplink}`);
	check('the line comes back after the grabs, before the manual photo redraws',
		back > uplink && manual > back && /if \(lineOffForPhoto\) \{\s*lineOffForPhoto = false;\s*traceLine\.setVisible\(true\);/.test(frame),
		`back@${back} manual@${manual}`);
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
	check('every tier is a trace target (tier I included), not tier ≥ 2 only',
		/trace: !!TOLERANCE_M\[s\.tier\] && !s\.encrypted/.test(src) && !/trace: s\.tier >= 2/.test(src));
}

console.log('\ntrace-wiring: the feel (sound, OSD line, ticks)');
{
	const frame = bodyAfter('function frame()') ?? '';
	check('the thread sound follows the follower, only while signals are live, silent frozen or disarmed',
		/threadAudio\.update\(signalsLive\(\) \? signalTraces\.follower\?\.out \?\? null : null, !frozen && controller\.armed\)/.test(frame));
	check('and goes silent off the flight', /else \{\s*uiAudio\.linkSilent\(\);\s*threadAudio\.silence\(\);/.test(frame));
	check('the trace cue takes the NEXT SIGNAL slot first', /nextSignal = computeTraceCue\(p\) \?\? computeNextSignal\(p\)/.test(frame));
	check('rebuilt at once when the follower state changes', /cueState !== nextCueState/.test(frame));
	const cue = bodyAfter('function computeTraceCue(') ?? '';
	check('the cue is off at the bench and under a verdict', /MODE\.bench \|\| !signalsLive\(\)/.test(cue));
	check('its arrow is relative to the nose', /relativeBearing\(bearingTo\(c\.dx, c\.dz\), headingOf\(physics\.rotation\)\)/.test(cue));
	const ut = bodyAfter('function updateTrace(') ?? '';
	check('the ticks face this frame\'s camera', /traceLine\.updateTicks\(camera\.position\)/.test(ut));
}

console.log(failures ? `\n${failures} failure(s).` : '\ntrace-wiring: all pass.');
process.exit(failures ? 1 : 0);
