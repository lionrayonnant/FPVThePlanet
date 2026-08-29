// AUTOMATED ANALYSIS (PHASE 09, Bible §16–18). S'intercale entre le TARGET SCAN
// (PHASE 08) et le vol. La carte se charge en tâche de fond pendant que le
// joueur regarde la phase automatique : au [ JACK IN ] le contrôle est immédiat.
//
// Déroulé : un log qui se remplit étape par étape (chaque étape = un label, des
// points qui se remplissent pendant son dwell, puis un verdict qui claque), un
// motif visuel propre à la famille de hack, un état d'attente tant que le
// chargement n'est pas fini, puis la culmination du motif + MANUAL OVERRIDE
// REQUIRED + un bouton [ JACK IN ] PROVISOIRE (le rituel réel — CONTROL VECTOR
// + QTE — est PHASE 10). Le bouton et la touche Entrée ne sont armés qu'une
// fois la séquence jouée ET le chargement terminé.
//
// Écran client pur : look terminal (screen/button de terminal.js), AUCUNE
// dépendance Three/Rapier/physics. Jamais importé par le moteur.
//
// Règle de sécurité (spec PHASE 09) : les labels/verdicts sont du vocabulaire
// d'ambiance (liste blanche dans hack-model.mjs), les motifs sont des animations
// décoratives. Aucune trame, aucun outil, aucune séquence exploitable.
import { screen, button } from './terminal.js';
import {
	HACK_TYPES, HACK_OVERRIDE, hackSequence,
	HACK_STEP_GAP_MS, HACK_HOLD_MS, HACK_LOCK_MS,
} from '../tools/hack-model.mjs';
import { GRAMMARS, drawNeutral } from './hack-grammars.js';

const DOT_MIN = 3;
const DOT_MAX = 15;

// Petit hash déterministe famille -> graine cosmétique (varie le bruit d'un vol
// à l'autre, ne révèle jamais la famille au joueur).
function cosmeticSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < String(str).length; i++) {
		h ^= String(str).charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const padLabel = (s) => s.padEnd(18);

// `ready` : promesse du chargement de fond (main.js). Résolue -> on peut armer
// [ JACK IN ] dès la fin de la séquence. Rejetée -> on démonte et on propage
// (échec de boot). Absente -> séquence scriptée seule (chemins ?scene=/?family=).
export function runHack(root, { hackType, family, ready } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : 'UNKNOWN';
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);
	const steps = hackSequence(type);

	const s = screen(root, 'hack');
	s.box.innerHTML = `<pre class="hack-head">HACK // ${type}</pre>
<pre class="hack-log"></pre>
<pre class="hack-grammar" aria-hidden="true"></pre>`;
	const logEl = s.box.querySelector('.hack-log');
	const gramEl = s.box.querySelector('.hack-grammar');

	return new Promise((resolve, reject) => {
		let raf = 0;
		let done = false;
		let armed = false;
		const timers = new Set();
		const t0 = performance.now();
		const nowMs = () => performance.now() - t0;

		// phase : 'run' séquence en cours · 'hold' attente du chargement ·
		//         'lock' culmination du motif · 'armed' [ JACK IN ] disponible
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
			} else if (phase === 'lock' || phase === 'armed') {
				out += `\n\n${HACK_OVERRIDE}`;
			}
			logEl.textContent = out;
			logEl.classList.toggle('hack-log-armed', phase === 'armed');
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

		let onKey = null;
		const arm = () => {
			if (armed || done) return;
			armed = true;
			phase = 'armed';
			paint();
			onKey = (e) => {
				if (e.repeat) return;                // ignore l'auto-repeat clavier
				if (e.key === 'Enter') { e.preventDefault(); finish(); }
			};
			window.addEventListener('keydown', onKey);
			s.box.appendChild(button('JACK IN', finish, 'terminal-cta'));
		};

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
			if (onKey) window.removeEventListener('keydown', onKey);
			s.remove();
		};

		const finish = () => {
			if (done) return;
			teardown();
			resolve();
		};

		raf = requestAnimationFrame(loop);
		runStep();
	});
}
