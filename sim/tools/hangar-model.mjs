// The hangar, as data (issue #185, Signals lot 3, mockup clearance-v4.html):
// the seven machine classes in one row, grouped by the clearance that opens
// them, and the two text lines under it. Pure — no DOM, no THREE — so the
// TARGET SCAN, DATA, the briefing and the end screen all read the same rows;
// src/hangar.js only draws them.
import { LEVELS, STEPS, MAX_CLEARANCE, clearanceOf, nextStep, tierAllowed } from './signal-clearance-model.mjs';
import { MACHINE_NAMES } from './signal-card-model.mjs';
import { scramble } from './signal-callout-model.mjs';

// The ladder's names; the hangar's slot is too narrow for THE SWARM.
export const HANGAR_LABELS = { ...MACHINE_NAMES, swarm: 'SWARM' };

// Cells of the progress bar (`▓▓▓░░░…  9/18 TO CLEARANCE 2`).
export const BAR_CELLS = 12;

const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

// A stable seed per machine id, so a locked name scrambles the same way on
// every screen and every frame.
function seedOf(id) {
	let h = 7;
	for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
	return h;
}

// A locked name: the callout's glyph noise, spaces kept, stable per seed.
export function scrambleLabel(label, seed) {
	return scramble(String(label ?? ''), typeof seed === 'number' ? seed : seedOf(String(seed ?? '')));
}

// One group per clearance level, in ladder order. `reveal` is the level a
// flight just crossed (flightCrossedStep() in main.js): only ITS machines are
// `justOpened`, and only if the store really reached it.
// `mark` is the group header's right side: `[+]` open, else its cost.
export function hangarRows(store, reveal = null) {
	const level = clearanceOf(store);
	return LEVELS.map((lv, i) => {
		const open = i <= level;
		return {
			level: i,
			open,
			cost: STEPS[i],
			mark: open ? '[+]' : `${STEPS[i]} PTS`,
			machines: lv.opens.map((id) => {
				const label = HANGAR_LABELS[id] ?? id.toUpperCase();
				return {
					id,
					label,
					shown: open ? label : scrambleLabel(label, id),
					open,
					justOpened: open && reveal === i && i > 0,
				};
			}),
		};
	});
}

// `▓▓▓░░░░░░░░░  9/18 TO CLEARANCE 2`: the bar fills over the CURRENT step
// (from the last step reached to the next), like the scanner header's.
export function progressParts(store) {
	const next = nextStep(store);
	const level = clearanceOf(store);
	if (!next || level >= MAX_CLEARANCE) return { bar: null, text: `CLEARANCE ${MAX_CLEARANCE} · MAX` };
	const from = STEPS[level];
	const cells = Math.max(0, Math.min(BAR_CELLS, Math.floor((next.points - from) / (next.need - from) * BAR_CELLS)));
	return {
		bar: '▓'.repeat(cells) + '░'.repeat(BAR_CELLS - cells),
		text: `${next.points}/${next.need} TO CLEARANCE ${next.level}`,
	};
}

export function progressLine(store) {
	const { bar, text } = progressParts(store);
	return bar ? `${bar}  ${text}` : text;
}

// `SIGNALS   TIER I · TIER II   TIER III AT CLEARANCE 2`: the open tiers,
// then the first one still closed and where it opens.
export function tiersParts(store) {
	const level = clearanceOf(store);
	const tiers = [1, 2, 3];
	const open = tiers.filter((t) => tierAllowed(level, t));
	const shut = tiers.find((t) => !tierAllowed(level, t));
	const at = shut ? LEVELS.findIndex((lv) => lv.tiers.includes(shut)) : -1;
	return {
		open: open.map((t) => `TIER ${ROMAN[t]}`).join(' · '),
		locked: shut ? `TIER ${ROMAN[shut]} AT CLEARANCE ${at}` : '',
	};
}

export function tiersLine(store) {
	const { open, locked } = tiersParts(store);
	return `SIGNALS   ${open}${locked ? `   ${locked}` : ''}`;
}
