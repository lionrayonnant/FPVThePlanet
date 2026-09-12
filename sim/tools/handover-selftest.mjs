// node tools/handover-selftest.mjs — the HANDOVER from the hack screen to the
// flight (#122), as it is wired in src/main.js.
//
// The rule, and it is a staging rule: the last hack screen (CONTROL ACQUIRED
// and its randomart) fades INTO the drone's video feed. Not onto a bare map
// that the drone's camera, its props and its OSD would dress up a fraction of
// a second later — session.open() is a server round trip, and it used to show.
// So armFlight() mounts all of it BEHIND a screen: the [ JACK IN ] gesture on
// FIELD (nothing may reach the server before it, since every screen up to it
// still aborts), the loading screen everywhere else.
//
// This file reads text, not behaviour, and that is deliberate: these rules
// only live in main.js, which touches Rapier, WebGL, the network and the DOM,
// and which no Node harness can instantiate. Same pattern, for the same
// reason, as tools/swarm-wiring-selftest.mjs and tools/loader-guard-selftest.mjs.
// What it catches is a removal or a move; what it cannot catch is a call that
// is present but inert.
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// A block's body, from the `{` that opens it to its matching `}`. The parameter
// list is skipped first, or a destructured argument (`{ arm = true } = {}`)
// would be taken for the body. Naive about braces in strings and comments,
// which is enough here: all we look for is the presence and the ORDER of calls
// inside a function.
function bodyAfter(header) {
	const i = src.indexOf(header);
	if (i < 0) return null;
	let k = src.indexOf('(', i);
	for (let d = 0; k < src.length; k++) {
		if (src[k] === '(') d++;
		else if (src[k] === ')' && --d === 0) break;
	}
	const open = src.indexOf('{', k);
	let depth = 0;
	for (let k = open; k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(open, k);
	}
	return null;
}

// Comments are stripped before the ABSENCE tests: main.js explains at length
// what it no longer does where, and an explanation is not a call.
const code = (body) => (body ?? '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const hackSrc = readFileSync(new URL('../src/hack.js', import.meta.url), 'utf8');

const finishBoot = bodyAfter('async function finishBoot(');
const bootLive = bodyAfter('async function bootLive(');
const arm = bodyAfter('async function armFlightOnce(');
const open = bodyAfter('async function openFlightSession(');
const frame = bodyAfter('function frame()');

console.log('handover: the five functions are findable');
{
	check('finishBoot()', finishBoot !== null);
	check('bootLive()', bootLive !== null);
	check('armFlightOnce()', arm !== null);
	check('openFlightSession()', open !== null);
	check('frame()', frame !== null);
}

// On the paths with no hack screen, both boot halves arm the flight BEFORE
// letting go of the loading screen and scheduling the render loop.
console.log('\nhandover: armed before the first frame, on both boot paths');
for (const [name, body] of [['finishBoot', finishBoot], ['bootLive', bootLive]]) {
	const armAt = (body ?? '').indexOf('await armFlight()');
	const ready = (body ?? '').indexOf('hud.ready()');
	const loop = (body ?? '').indexOf('renderer.setAnimationLoop(');
	check(`${name} awaits armFlight()`, armAt > 0);
	check(`${name} arms before hud.ready()`, ready > 0 && armAt < ready, `arm@${armAt} ready@${ready}`);
	check(`${name} arms before renderer.setAnimationLoop()`, loop > 0 && armAt < loop, `arm@${armAt} loop@${loop}`);
	// And on a path that does NOT boot into flight straight away, it does not
	// arm at all: `arm: false` hands that to the [ JACK IN ] gesture.
	check(`${name} takes the arm flag`, new RegExp(`function ${name}\\(`).test(src)
		&& /\{ arm = true \} = \{\}/.test(src));
}

// The camera goes onto the machine before the first frame whoever arms the
// flight: at the ENU origin it looks at the map from underneath.
console.log('\nhandover: the camera never waits');
{
	check('bootLive places it itself', /placeCamera\(0\);/.test(bootLive ?? ''));
	check('the scene path places it at its first-frame stage', /placeCamera\(0\);/.test(finishBoot ?? ''));
}

// FIELD: the gesture arms, and the last screen waits for it before it fades.
console.log('\nhandover: FIELD arms on the gesture');
{
	const field = (src.match(/commit: armFlight/g) ?? []).length;
	check('both FIELD paths hand armFlight to runHack as `commit`', field === 2, `${field}`);
	const noArm = (src.match(/\{ arm: false \}/g) ?? []).length;
	check('and neither lets the boot arm', noArm === 2, `${noArm}`);
	// In hack.js: after the gesture (nothing aborts past it), before the fade.
	const gesture = hackSrc.indexOf('if (handover?.aborted) return { aborted: true };');
	const commit = hackSrc.indexOf('const committed = commit ? commit() : null;');
	const culmination = hackSrc.indexOf('await runCulmination(');
	check('hack.js commits after the gesture', gesture > 0 && commit > gesture, `gesture@${gesture} commit@${commit}`);
	check('…and under the culmination, not after it', culmination > 0 && commit < culmination, `commit@${commit} culmination@${culmination}`);
	check('the last screen awaits it before revealing the feed',
		/await Promise\.resolve\(committed\)\.catch[\s\S]{0,400}?s\.close\(\{ revealBehind: true \}\)/.test(hackSrc));
}

// What the arming mounts: everything that is SEEN. Should any of these gestures
// drop back into openFlightSession(), the randomart opens on a bare map again.
console.log('\nhandover: what the arming mounts');
{
	check('the FPV view (D11), which also puts the camera on the machine', /setView\('fpv'\)/.test(arm ?? ''));
	const mounts = [
		['the target\'s camera', /applyTargetCamera\(/],
		['the player\'s drone', /new PlayerDrone\(/],
		['the target\'s OSD', /droneOsd = osdLayout \? new DroneOsd\(/],
		['its wiring into the lens', /lens\.setOsd\(/],
		['the FPVTP! OSD', /fpvtpOsd\.show\(\)/],
		['the spawn point, which the OSD reads for its altitude', /spawnY = physics\.spawn\.y/],
	];
	for (const [label, re] of mounts) {
		check(label, re.test(arm ?? ''));
		check('  …and not in openFlightSession()', !re.test(code(open)));
	}
	// setView('fpv') is the one exception, and an explicit one: the ?live= dev
	// shortcut mounts neither target nor OSD, it only has its camera to place.
	// That is its only line in openFlightSession().
	check('setView(\'fpv\') only stays there for the ?live= shortcut',
		(code(open).match(/setView\('fpv'\)/g) ?? []).length === 1
		&& /if \(OPTS\.live\) \{ setView\('fpv'\); return; \}/.test(code(open)));
}

// And what is left to the handover itself: the drop, and the start of the
// clock. Neither belongs to the arming — between the two sits the [ JACK IN ]
// prompt, which has no duration.
console.log('\nhandover: what is left to the handover');
{
	check('openFlightSession() awaits the arming', /await armFlight\(\)/.test(open ?? ''));
	check('the drop is there, and only there',
		/music\.drop\(\)/.test(open ?? '') && !/music\.drop\(\)/.test(arm ?? ''));
	check('the flight clock starts there, and only there',
		/sessionStartedAt = Date\.now\(\)/.test(open ?? '') && !/sessionStartedAt = Date\.now\(\)/.test(arm ?? ''));
	// The OSD is on screen for the whole freeze: its timer must read 0 there,
	// not the time spent in front of the prompt, and it must not jump on thaw.
	check('frame() pins that clock for the duration of the freeze',
		/if \(introFrozen\) sessionStartedAt = Date\.now\(\);/.test(frame ?? ''));
}

// The arming happens once: both boot paths call it, and the startup() chain
// awaits it behind them.
console.log('\nhandover: armed exactly once');
{
	check('armFlight() memoises its promise', /flightArming \?\?= armFlightOnce\(\)/.test(src));
	check('declared at module scope, not inside a function', /^let flightArming = null;$/m.test(src));
}

console.log(failures ? `\n${failures} failure(s).` : '\n7 blocks, all pass.');
process.exit(failures ? 1 : 0);
