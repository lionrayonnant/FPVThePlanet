// AUTOMATED ANALYSIS (PHASE 09, Bible §16-18). Sits between TARGET SCAN
// (PHASE 08) and flight. The map streams in the background while the player
// watches the automatic phase: a single deliberate gesture, [ JACK IN ],
// hands control over as soon as it is offered.
//
// Flow: a log that fills in step by step (each step: a label, dots that fill
// during its dwell, then a verdict that lands), a visual pattern specific to
// the hack family, a hold state while loading isn't done yet, then the
// pattern's culmination + MANUAL OVERRIDE REQUIRED + [ JACK IN ]. `arm()`
// only fires once the scripted sequence has played AND loading has finished
// — but the screen can be left at ANY point before that too (issue #33): see
// `abort()` below. The CONTROL VECTOR ritual (PHASE 10, formerly ritual.js)
// used to stand where `arm()` now hands off directly; the ritual has since
// been removed (#33).
//
// Pure client screen: terminal look (screen from terminal.js), NO Three/
// Rapier/physics dependency. Never imported by the engine.
//
// Safety rule (PHASE 09 spec): labels/verdicts are mood vocabulary (an
// allow-list in hack-model.mjs), the patterns are decorative animations. No
// real map data, tool, or exploitable sequence.
import { screen, button, keyHints } from './terminal.js';
import { menuNav } from './menu-nav.js';
import {
	HACK_TYPES, HACK_OVERRIDE, hackSequence,
	HACK_STEP_GAP_MS, HACK_HOLD_MS, HACK_LOCK_MS,
} from '../tools/hack-model.mjs';
import { GRAMMARS, drawNeutral, cosmeticSeed } from './hack-grammars.js';
import { notify } from './dialogue.js';
import { scanContext } from './dialogue-context.js';
import { randomartWalk, randomartFrame } from '../tools/randomart.mjs';
import { reducedMotion } from './motion.js';

const DOT_MIN = 3;
const DOT_MAX = 15;

// Mise en scène, pas mesure (comme les tables de src/flight-end.js).
// L'empreinte se trace, puis on la regarde une demi-seconde avant que le flux
// vidéo prenne la main.
const ART_WALK_MS = 1000;
const ART_HOLD_MS = 700;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const padLabel = (s) => s.padEnd(18);

// `ready`: promise for the background load (main.js). Resolves -> arm() can
// fire once the sequence is done. Rejects -> tear down and propagate (boot
// failure). Absent -> scripted sequence alone (the ?scene=/?family= paths).
export function runHack(root, { hackType, family, ready, candidate = null, buildSeed = null } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : 'UNKNOWN';
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);
	const steps = hackSequence(type);

	const s = screen(root, 'hack');
	// PHASE 19 : la reprise en main est sortie du corps du log. Tant qu'elle y
	// était, le seul moment où l'analyse rend la main à l'opérateur passait dans
	// la même graisse que les lignes de progression au-dessus (HANDOFF PHASE 09).
	// Elle a maintenant son propre élément, au niveau DISPLAY.
	//
	// createElement plutôt qu'innerHTML, comme screen() lui-même et
	// target-scan.js (issue #33) : rigoureusement le même arbre, mais montable
	// sur le faux DOM de tools/lib/fake-dom.mjs, qui refuse un innerHTML non vide.
	const headEl = document.createElement('pre');
	headEl.className = 'hack-head';
	headEl.textContent = `HACK // ${type}`;
	const logEl = document.createElement('pre');
	logEl.className = 'hack-log';
	const handoverEl = document.createElement('pre');
	handoverEl.className = 'hack-handover';
	handoverEl.hidden = true;
	handoverEl.textContent = HACK_OVERRIDE;
	const gramEl = document.createElement('pre');
	gramEl.className = 'hack-grammar';
	gramEl.setAttribute('aria-hidden', 'true');
	// L'empreinte de la cible (#57), vide jusqu'à l'acquisition.
	const artEl = document.createElement('pre');
	artEl.className = 'hack-art';
	artEl.setAttribute('aria-hidden', 'true');
	artEl.hidden = true;
	s.box.append(headEl, logEl, handoverEl, gramEl, artEl);

	// RTC: crew chatter during the automatic sequence only. D9 is
	// non-negotiable — the crew is silent from the handover on, and
	// stopHack() cuts it before arm() runs below. MANUAL_OVERRIDE and
	// [ JACK IN ] are deliberately never voiced here: they are arm()'s
	// moment, not the log's.
	// Since #243: an overlay toast, not a block that pushes the column. The
	// hack is a wait you WATCH (the grid spins) — a log growing underneath it
	// moved what you were looking at.
	// candidate: the same instance main.js drew from the scan (optional — the
	// ?scene=/?family= preview paths have none). Providing it opens {signal}
	// and {video_type} in addition to {hack_type} for TARGET_ANALYSIS/HACK;
	// candidate: null keeps today's default (issue #58 finding 2).
	const stopHack = notify({
		event: 'TARGET_ANALYSIS',
		context: () => scanContext({ candidate, hackType, family }),
		host: s.box,
	});

	return new Promise((resolve, reject) => {
		let raf = 0;
		let done = false;
		let armed = false;
		let nav = null;
		const timers = new Set();
		const t0 = performance.now();
		const nowMs = () => performance.now() - t0;

		// phase : 'run' séquence en cours · 'hold' attente du chargement ·
		//         'lock' culmination du motif · 'armed' [ JACK IN ] disponible ·
		//         'acquired' l'empreinte se trace, le contrôle est pris (#57)
		let phase = 'run';
		let lockT0 = 0;
		let walk = null;
		let artT0 = 0;

		let stepIdx = 0;
		let stepStart = 0;          // ms du début du dwell de l'étape courante
		const doneLines = [];       // étapes terminées, texte figé

		const after = (ms, fn) => {
			const id = setTimeout(() => { timers.delete(id); if (!done) fn(); }, ms);
			timers.add(id);
		};

		const dots = (n) => '.'.repeat(Math.round(DOT_MIN + (DOT_MAX - DOT_MIN) * clamp01(n)));
		const settled = (st) => `${padLabel(st.label)} ${'.'.repeat(DOT_MAX)} ${st.verdict}`;

		// lock 0..1 : 0 pendant 'run'/'hold', rampe vers 1 pendant 'lock'/'armed'.
		const lockLevel = () => (phase === 'lock' || phase === 'armed'
			? clamp01((nowMs() - lockT0) / HACK_LOCK_MS) : 0);

		const paint = () => {
			let out = doneLines.join('\n');
			if (phase === 'run' && stepIdx < steps.length) {
				const st = steps[stepIdx];
				const p = clamp01((nowMs() - stepStart) / st.dwellMs);
				out += (out ? '\n' : '') + `${padLabel(st.label)} ${dots(p)}`;
			} else if (phase === 'hold') {
				// « recherche » : trois points qui pulsent, rien qui progresse.
				const k = Math.floor(nowMs() / 350) % 4;
				out += `\n${'.'.repeat(k)}`;
			}
			logEl.textContent = out;
			handoverEl.hidden = !(phase === 'lock' || phase === 'armed' || phase === 'acquired');
			logEl.classList.toggle('hack-log-armed', phase === 'armed');
			// #57 : pendant 'acquired', le log et le motif se taisent, l'empreinte
			// se trace. `randomartFrame` pose E sur la case du dernier pas : le fou
			// est son propre curseur.
			if (phase === 'acquired') {
				const n = walk.steps.length * (reducedMotion() ? 1
					: clamp01((nowMs() - artT0) / ART_WALK_MS));
				artEl.textContent = randomartFrame(walk, n, { title: 'TGT ??', tag: buildSeed });
			}
		};

		// --- machine à étapes -------------------------------------------------
		const runStep = () => {
			if (done) return;
			if (stepIdx >= steps.length) { enterHold(); return; }
			stepStart = nowMs();
			after(steps[stepIdx].dwellMs, () => {
				doneLines.push(settled(steps[stepIdx]));
				stepIdx++;
				after(HACK_STEP_GAP_MS, runStep);
			});
		};

		const enterHold = () => {
			if (done) return;
			phase = 'hold';
			Promise.resolve(ready).then(
				() => after(HACK_HOLD_MS, enterLock),
				(err) => { teardown(); reject(err instanceof Error ? err : new Error(String(err))); },
			);
		};

		const enterLock = () => {
			if (done) return;
			phase = 'lock';
			lockT0 = nowMs();
			after(HACK_LOCK_MS, arm);
		};

		// Abandoning is not a failure: the player simply does not want this
		// target. main.js already knows this shape from the TARGET SCAN, whose
		// Escape returns { cancelled: true } and loops back to the zone.
		const abort = () => {
			if (done) return;
			// #57 : une fois le contrôle pris, Échap ne renvoie plus au scan — il
			// saute le battement. Le geste est fait, il n'y a rien à annuler.
			if (phase === 'acquired') { handOver(); return; }
			teardown();
			resolve({ aborted: true });
		};

		// D15, and this is the exit issue #33 found missing: mounted at SCREEN
		// MOUNT, not at arm(). 'hold' — the wait for the terrain to load — is
		// exactly the phase the bug lived in: a player stuck behind a screen
		// with no way out and no armed [ JACK IN ] yet either. What stood here
		// before was the CONTROL VECTOR ritual: it listened to the four arrow
		// keys and NOTHING else, held a promise with no reject, and blocked
		// every nav still mounted beneath it — and since fieldLoop awaits
		// runHack(), the whole game loop was stuck with the player.
		s.box.appendChild(keyHints([['ESC', 'ABORT']]));
		nav = menuNav(s.el, { back: abort });

		// The hack ends on a single deliberate gesture. `[ JACK IN ]` is not
		// new: it is what stood here before PHASE 10, and the crew already has
		// lines for MANUAL_OVERRIDE and JACK_IN waiting for a call site
		// (src/dialogue-fallback.js).
		const arm = () => {
			if (armed || done) return;
			armed = true;
			phase = 'armed';
			paint();
			// D9: the crew speaks before the handover, never during it.
			stopHack();
			s.box.appendChild(button('JACK IN', finish, 'terminal-cta'));
		};

		// --- boucle d'animation unique --------------------------------------
		const loop = () => {
			if (done) return;
			if (phase !== 'acquired') draw(gramEl, { t: nowMs() / 1000, seed, lock: lockLevel() });
			paint();
			raf = requestAnimationFrame(loop);
		};

		const teardown = () => {
			done = true;
			cancelAnimationFrame(raf);
			timers.forEach(clearTimeout);
			timers.clear();
			// Idempotent : déjà arrêté si arm() est passé par là, mais teardown()
			// est aussi le seul point de sortie quand le hack échoue avant l'armement
			// (ready rejetée pendant 'hold') — sans ça le minuteur RTC survivrait à
			// s.remove() sur un nœud détaché.
			stopHack();
			nav?.detach();
			nav = null;
			// Test-only hook (tools/hack-render-selftest.mjs): without this, the
			// closure — screen, timers, resolve — is retained for the page's
			// whole life, one runHack() call overwriting the last (memory-release-
			// selftest.mjs would have caught this eventually, on a real leak).
			delete globalThis.__hackTestArm;
			delete globalThis.__hackTestFinish;
			s.remove();
		};

		// #57 — le battement d'acquisition. `[ JACK IN ]` est le GESTE ;
		// `CONTROL ACQUIRED` est son RÉSULTAT, et il vient après. Le motif de la
		// famille cède la place à l'empreinte de la machine, qui se trace, puis
		// le flux vidéo prend la main.
		//
		// Sans `buildSeed` — les chemins d'aperçu `?hack=` — il n'y a pas de
		// machine à graver : on résout directement, comme avant #57.
		const finish = () => {
			if (done) return;
			if (!buildSeed) { handOver(); return; }
			phase = 'acquired';
			artT0 = nowMs();
			walk = randomartWalk(buildSeed);
			artEl.hidden = false;
			gramEl.hidden = true;
			handoverEl.textContent = 'CONTROL ACQUIRED';
			paint();
			after(reducedMotion() ? ART_HOLD_MS : ART_WALK_MS + ART_HOLD_MS, handOver);
		};

		// La sortie de la phase, et le seul point qui résout. Appelé par le
		// minuteur, par Échap (qui SAUTE le battement — le contrôle est pris, on
		// ne revient pas au scan) et par le crochet de test.
		const handOver = () => {
			if (done) return;
			// L'empreinte est POSÉE dans son état final avant le démontage. Sauter
			// le battement — Échap, ou le crochet de test — ne doit pas laisser une
			// image à moitié tracée comme dernière chose à l'écran.
			if (phase === 'acquired') {
				artEl.textContent = randomartFrame(walk, walk.steps.length, { title: 'TGT ??', tag: buildSeed });
			}
			globalThis.__hackTestObserve?.(artEl.textContent, handoverEl.textContent);
			teardown();
			resolve();
		};

		// Test-only hook (tools/hack-render-selftest.mjs): the screen walks its
		// phases on timers, and a render test has no business waiting seconds
		// for them. Nothing in the game reads this.
		globalThis.__hackTestArm = () => { timers.forEach(clearTimeout); timers.clear(); arm(); };
		globalThis.__hackTestFinish = () => { timers.forEach(clearTimeout); timers.clear(); handOver(); };

		raf = requestAnimationFrame(loop);
		runStep();
	});
}
