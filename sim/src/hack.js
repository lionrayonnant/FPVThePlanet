// AUTOMATED ANALYSIS (PHASE 09, Bible §16-18). Sits between TARGET SCAN
// (PHASE 08) and flight. The map streams in the background while the player
// watches the automatic phase: a single deliberate gesture, [ JACK IN ],
// hands control over as soon as it is offered.
//
// TROIS écrans successifs (#67), pas un seul qui change de contenu sous les
// yeux. Chacun n'a qu'une chose à dire, et l'écran suivant ne peut pas être
// confondu avec la suite du précédent :
//
//   1. runAnalysis  — le log qui se remplit étape par étape (un libellé, des
//      points qui se chargent pendant son dwell, un verdict qui tombe), le
//      motif de la famille, l'attente du chargement, puis la culmination du
//      motif. Il se démonte de lui-même quand tout est prêt.
//   2. runHandover  — MANUAL OVERRIDE REQUIRED et [ JACK IN ], seuls au
//      milieu de l'écran. C'est une INVITE : rien d'autre n'y bouge, et le
//      bouton respire pour dire qu'il attend quelqu'un.
//   3. runAcquired  — CONTROL ACQUIRED et l'empreinte de la machine qui se
//      trace. Le résultat du geste, jamais mélangé au geste lui-même.
//
// L'écran peut être quitté à N'IMPORTE quel point avant l'acquisition (issue
// #33) : voir `abort()` dans les deux premiers. Sur le troisième, le contrôle
// est déjà pris — Échap saute le battement au lieu d'annuler. Le CONTROL
// VECTOR ritual (PHASE 10, formerly ritual.js) used to stand where the
// handover screen is now; the ritual has since been removed (#33).
//
// Pure client screens: terminal look (screen from terminal.js), NO Three/
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

// Le cadre de l'empreinte : ce que l'opérateur sait en vol, pas ce que
// l'archive saura. `targetSeq` est attribué par le serveur et le client ne le
// connaît pas ici — d'où `TGT ??` plutôt qu'un numéro.
const ART_TITLE = 'TGT ??';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const padLabel = (s) => s.padEnd(18);

// Les trois écrans portent la même en-tête : c'est UNE opération en trois
// temps, pas trois écrans étrangers les uns aux autres.
const headLine = (type) => {
	const el = document.createElement('pre');
	el.className = 'hack-head';
	el.textContent = `HACK // ${type}`;
	return el;
};

// createElement plutôt qu'innerHTML, comme screen() lui-même et target-scan.js
// (issue #33) : rigoureusement le même arbre, mais montable sur le faux DOM de
// tools/lib/fake-dom.mjs, qui refuse un innerHTML non vide.
const pre = (cls, text = '') => {
	const el = document.createElement('pre');
	el.className = cls;
	if (text) el.textContent = text;
	return el;
};

// `ready`: promise for the background load (main.js). Resolves -> the analysis
// screen can hand over once the scripted sequence has played. Rejects -> tear
// down and propagate (boot failure). Absent -> scripted sequence alone (the
// ?scene=/?family= paths).
//
// Rend `{ aborted: true }` si le joueur a renoncé avant l'acquisition, sinon
// `undefined`. C'est la seule chose que main.js lit.
export async function runHack(root, { hackType, family, ready, candidate = null, buildSeed = null } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : 'UNKNOWN';

	const analysis = await runAnalysis(root, { type, hackType, family, ready, candidate });
	if (analysis?.aborted) return { aborted: true };

	const handover = await runHandover(root, { type });
	if (handover?.aborted) return { aborted: true };

	// Sans `buildSeed` — les chemins d'aperçu `?hack=` — il n'y a pas de machine
	// à graver : le geste rend la main directement, comme avant #57.
	if (buildSeed) await runAcquired(root, { type, buildSeed });
	return undefined;
}

// ---------------------------------------------------------------------------
// 1. L'analyse automatique. Le seul écran qui attend quelque chose (`ready`),
//    et donc le seul qui puisse échouer.
function runAnalysis(root, { type, hackType, family, ready, candidate }) {
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);
	const steps = hackSequence(type);

	const s = screen(root, 'hack hack-analysis');
	const logEl = pre('hack-log');
	const gramEl = pre('hack-grammar');
	gramEl.setAttribute('aria-hidden', 'true');
	s.box.append(headLine(type), logEl, gramEl);

	// RTC: crew chatter during the automatic sequence only. D9 is
	// non-negotiable — the crew is silent from the handover on, and this
	// screen is torn down before the handover screen mounts.
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
		let nav = null;
		const timers = new Set();
		const t0 = performance.now();
		const nowMs = () => performance.now() - t0;

		// phase : 'run' séquence en cours · 'hold' attente du chargement ·
		//         'lock' culmination du motif, juste avant de rendre la main
		let phase = 'run';
		let lockT0 = 0;

		let stepIdx = 0;
		let stepStart = 0;          // ms du début du dwell de l'étape courante
		const doneLines = [];       // étapes terminées, texte figé

		const after = (ms, fn) => {
			const id = setTimeout(() => { timers.delete(id); if (!done) fn(); }, ms);
			timers.add(id);
		};

		const dots = (n) => '.'.repeat(Math.round(DOT_MIN + (DOT_MAX - DOT_MIN) * clamp01(n)));
		const settled = (st) => `${padLabel(st.label)} ${'.'.repeat(DOT_MAX)} ${st.verdict}`;

		// lock 0..1 : 0 pendant 'run'/'hold', rampe vers 1 pendant 'lock'.
		const lockLevel = () => (phase === 'lock' ? clamp01((nowMs() - lockT0) / HACK_LOCK_MS) : 0);

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
			after(HACK_LOCK_MS, handOver);
		};

		// Abandoning is not a failure: the player simply does not want this
		// target. main.js already knows this shape from the TARGET SCAN, whose
		// Escape returns { cancelled: true } and loops back to the zone.
		const abort = () => {
			if (done) return;
			teardown();
			resolve({ aborted: true });
		};

		// D15, and this is the exit issue #33 found missing: mounted at SCREEN
		// MOUNT, not at the end of the sequence. 'hold' — the wait for the
		// terrain to load — is exactly the phase the bug lived in: a player
		// stuck behind a screen with no way out and nothing armed yet either.
		// What stood here before was the CONTROL VECTOR ritual: it listened to
		// the four arrow keys and NOTHING else, held a promise with no reject,
		// and blocked every nav still mounted beneath it — and since fieldLoop
		// awaits runHack(), the whole game loop was stuck with the player.
		s.box.appendChild(keyHints([['ESC', 'ABORT']]));
		nav = menuNav(s.el, { back: abort });

		// --- boucle d'animation unique --------------------------------------
		const loop = () => {
			if (done) return;
			draw(gramEl, { t: nowMs() / 1000, seed, lock: lockLevel() });
			paint();
			raf = requestAnimationFrame(loop);
		};

		const teardown = () => {
			done = true;
			cancelAnimationFrame(raf);
			timers.forEach(clearTimeout);
			timers.clear();
			// Idempotent : le RTC est aussi coupé quand l'analyse échoue avant
			// d'avoir rendu la main (ready rejetée pendant 'hold') — sans ça le
			// minuteur survivrait à s.remove() sur un nœud détaché.
			stopHack();
			nav?.detach();
			nav = null;
			// Test-only hook (tools/hack-render-selftest.mjs): without this, the
			// closure — screen, timers, resolve — is retained for the page's
			// whole life, one runHack() call overwriting the last (memory-release-
			// selftest.mjs would have caught this eventually, on a real leak).
			delete globalThis.__hackTestArm;
			s.remove();
		};

		// D9: the crew speaks during the analysis, never past it — stopHack()
		// runs in teardown() before the handover screen exists.
		const handOver = () => {
			if (done) return;
			teardown();
			resolve({});
		};

		// Test-only hook (tools/hack-render-selftest.mjs): the screen walks its
		// phases on timers, and a render test has no business waiting seconds
		// for them. Nothing in the game reads this.
		globalThis.__hackTestArm = () => { timers.forEach(clearTimeout); timers.clear(); handOver(); };

		raf = requestAnimationFrame(loop);
		runStep();
	});
}

// ---------------------------------------------------------------------------
// 2. L'invite. Un écran qui ne fait qu'une chose : demander LE geste.
//
// `[ JACK IN ]` is not new: it is what stood here before PHASE 10, and the crew
// already has lines for MANUAL_OVERRIDE and JACK_IN waiting for a call site
// (src/dialogue-fallback.js). Rien n'y est animé sauf le bouton lui-même —
// c'est ce qui le désigne.
function runHandover(root, { type }) {
	const s = screen(root, 'hack hack-jack');
	s.box.append(headLine(type), pre('hack-handover', HACK_OVERRIDE));

	return new Promise((resolve) => {
		let done = false;
		let nav = null;

		const teardown = () => {
			done = true;
			nav?.detach();
			nav = null;
			s.remove();
		};

		// Renoncer est encore possible ici : rien n'a été pris.
		const abort = () => { if (done) return; teardown(); resolve({ aborted: true }); };
		const engage = () => { if (done) return; teardown(); resolve({}); };

		const cta = button('JACK IN', engage, 'terminal-cta hack-cta');
		s.box.append(cta, keyHints([['ESC', 'ABORT']]));
		nav = menuNav(s.el, { back: abort });
		// Le curseur de menuNav EST le focus natif : le clavier et la manette
		// tombent sur le geste du moment sans qu'on ait à les viser.
		cta.focus?.();
	});
}

// ---------------------------------------------------------------------------
// 3. Le résultat (#57). `[ JACK IN ]` est le GESTE ; `CONTROL ACQUIRED` est ce
//    qu'il produit, et il a son propre écran. Le motif de la famille a disparu
//    avec l'analyse ; ce qui se trace ici est l'empreinte de LA machine — la
//    même à chaque fois qu'on la retrouve.
function runAcquired(root, { type, buildSeed }) {
	const s = screen(root, 'hack hack-acquired');
	const artEl = pre('hack-art');
	artEl.setAttribute('aria-hidden', 'true');
	const handoverEl = pre('hack-handover', 'CONTROL ACQUIRED');
	s.box.append(headLine(type), handoverEl, artEl);

	return new Promise((resolve) => {
		let raf = 0;
		let done = false;
		let nav = null;
		let timer = 0;
		const t0 = performance.now();
		const walk = randomartWalk(buildSeed);
		const frame = (n) => randomartFrame(walk, n, { title: ART_TITLE, tag: buildSeed });

		// `randomartFrame` pose E sur la case du dernier pas : le fou est son
		// propre curseur, il n'y a pas de curseur à dessiner en plus.
		const loop = () => {
			if (done) return;
			const p = reducedMotion() ? 1 : clamp01((performance.now() - t0) / ART_WALK_MS);
			artEl.textContent = frame(walk.steps.length * p);
			raf = requestAnimationFrame(loop);
		};

		// La sortie, et le seul point qui résout. Appelé par le minuteur, par
		// Échap (qui SAUTE le battement — le contrôle est pris, on ne revient
		// pas au scan) et par le crochet de test.
		const handOver = () => {
			if (done) return;
			// L'empreinte est POSÉE dans son état final avant le démontage. Sauter
			// le battement ne doit pas laisser une image à moitié tracée comme
			// dernière chose à l'écran.
			artEl.textContent = frame(walk.steps.length);
			globalThis.__hackTestObserve?.(artEl.textContent, handoverEl.textContent);
			done = true;
			cancelAnimationFrame(raf);
			clearTimeout(timer);
			nav?.detach();
			nav = null;
			delete globalThis.__hackTestFinish;
			s.remove();
			resolve();
		};

		s.box.appendChild(keyHints([['ESC', 'SKIP']]));
		nav = menuNav(s.el, { back: handOver });

		globalThis.__hackTestFinish = () => handOver();

		timer = setTimeout(handOver, reducedMotion() ? ART_HOLD_MS : ART_WALK_MS + ART_HOLD_MS);
		raf = requestAnimationFrame(loop);
	});
}
