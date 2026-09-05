// AUTOMATED ANALYSIS (PHASE 09, Bible §16–18) + rituel CONTROL VECTOR
// (PHASE 10, Bible §18). S'intercale entre le TARGET SCAN (PHASE 08) et le
// vol. La carte se charge en tâche de fond pendant que le joueur regarde la
// phase automatique : au bout du rituel le contrôle est immédiat.
//
// Déroulé : un log qui se remplit étape par étape (chaque étape = un label, des
// points qui se remplissent pendant son dwell, puis un verdict qui claque), un
// motif visuel propre à la famille de hack, un état d'attente tant que le
// chargement n'est pas fini, puis la culmination du motif + MANUAL OVERRIDE
// REQUIRED + le rituel réel (ritual.js : saisie du CONTROL VECTOR de
// l'opérateur, tolérante, puis 1-4 s de folie demo scene, puis CONTROL
// ACQUIRED). `arm()` n'est déclenché qu'une fois la séquence jouée ET le
// chargement terminé.
//
// Écran client pur : look terminal (screen de terminal.js), AUCUNE
// dépendance Three/Rapier/physics. Jamais importé par le moteur.
//
// Règle de sécurité (spec PHASE 09) : les labels/verdicts sont du vocabulaire
// d'ambiance (liste blanche dans hack-model.mjs), les motifs sont des animations
// décoratives. Aucune trame, aucun outil, aucune séquence exploitable.
import { screen } from './terminal.js';
import {
	HACK_TYPES, HACK_OVERRIDE, hackSequence,
	HACK_STEP_GAP_MS, HACK_HOLD_MS, HACK_LOCK_MS,
} from '../tools/hack-model.mjs';
import { GRAMMARS, drawNeutral, cosmeticSeed } from './hack-grammars.js';
import { runRitual } from './ritual.js';
import { ritualVector } from '../tools/ritual-model.mjs';
import { getOperator } from './operator.js';
import { notify } from './dialogue.js';
import { scanContext } from './dialogue-context.js';

const DOT_MIN = 3;
const DOT_MAX = 15;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const padLabel = (s) => s.padEnd(18);

// `ready` : promesse du chargement de fond (main.js). Résolue -> on peut armer
// le rituel dès la fin de la séquence. Rejetée -> on démonte et on propage
// (échec de boot). Absente -> séquence scriptée seule (chemins ?scene=/?family=).
export function runHack(root, { hackType, family, ready, candidate = null } = {}) {
	const type = HACK_TYPES.includes(hackType) ? hackType : 'UNKNOWN';
	const draw = GRAMMARS[type] || drawNeutral;
	const seed = cosmeticSeed(family || type);
	const steps = hackSequence(type);

	const s = screen(root, 'hack');
	// PHASE 19 : la reprise en main est sortie du corps du log. Tant qu'elle y
	// était, le seul moment où l'analyse rend la main à l'opérateur passait dans
	// la même graisse que les lignes de progression au-dessus (HANDOFF PHASE 09).
	// Elle a maintenant son propre élément, au niveau DISPLAY.
	s.box.innerHTML = `<pre class="hack-head">HACK // ${type}</pre>
<pre class="hack-log"></pre>
<pre class="hack-handover" hidden>${HACK_OVERRIDE}</pre>
<pre class="hack-grammar" aria-hidden="true"></pre>`;
	const logEl = s.box.querySelector('.hack-log');
	const handoverEl = s.box.querySelector('.hack-handover');
	const gramEl = s.box.querySelector('.hack-grammar');

	// RTC : de la couleur pendant la séquence automatique seulement. D9 est
	// non négociable — le crew se tait avant l'armement du CONTROL VECTOR, et
	// stopHack() coupe net avant arm() plus bas. MANUAL_OVERRIDE et JACK_IN ne
	// sont volontairement jamais montés ici : ce sont les instants du rituel.
	// Depuis #243 : un toast en surimpression, pas un bloc qui pousse la colonne.
	// Le hack est une attente qu'on REGARDE (la grille tourne) — un log qui
	// grandit sous elle déplaçait ce qu'on regardait.
	// candidate : le même exemplaire que main.js a tiré du scan (facultatif —
	// les chemins de preview ?scene=/?family= n'en ont pas). Le fournir ouvre
	// {signal} et {video_type} en plus de {hack_type} pour TARGET_ANALYSIS/HACK ;
	// candidate: null reste le comportement par défaut (issue #58 finding 2).
	const stopHack = notify({
		event: 'TARGET_ANALYSIS',
		context: () => scanContext({ candidate, hackType, family }),
		host: s.box,
	});

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
			}
			logEl.textContent = out;
			handoverEl.hidden = !(phase === 'lock' || phase === 'armed');
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

		// PHASE 10 : le rituel réel remplace le [ JACK IN ] provisoire de PHASE 09.
		// `armed` ne protège plus qu'un double-déclenchement de `arm()` lui-même —
		// runRitual gère sa propre saisie (clavier + manette) et sa propre
		// culmination, `hack.js` ne fait qu'attendre sa résolution puis finir.
		// Monté sur `root`, pas `s.box` : le rituel casse le cadre terminal
		// étroit de l'AUTOMATED ANALYSIS pour prendre tout le viewport (Bible
		// §18-19, retour utilisateur PR #80 — doit se sentir comme un vrai
		// événement, pas un écran de plus dans la même boîte).
		const arm = () => {
			if (armed || done) return;
			armed = true;
			phase = 'armed';
			paint();
			// D9 : le crew parle avant l'armement, jamais pendant — la culmination
			// du rituel est une seule chose à la fois. On coupe net ici, avant que
			// runRitual() ne prenne l'écran.
			stopHack();
			const vector = ritualVector(getOperator()?.controlVector);
			runRitual(root, { hackType: type, vector, seed }).then(finish, (err) => {
				teardown();
				reject(err instanceof Error ? err : new Error(String(err)));
			});
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
			// Idempotent : déjà arrêté si arm() est passé par là, mais teardown()
			// est aussi le seul point de sortie quand le hack échoue avant l'armement
			// (ready rejetée pendant 'hold') — sans ça le minuteur RTC survivrait à
			// s.remove() sur un nœud détaché.
			stopHack();
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
