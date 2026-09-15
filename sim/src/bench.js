// BENCH — the bench (PHASE 26, Bible §48). Screens only: all the logic lives in
// ../tools/bench-model.mjs and ../tools/bench-airframe.mjs, tested without a
// browser.
//
// Three screens:
//   selectOperationMode()  the root of the game — FIELD or BENCH
//   runBench()             the bench configuration, up to SPIN UP
//   runAirframe()          the machine itself: base, bill of materials, and
//                          every parameter the flight stack reads (issue #159)
//
// Mounted by APPEND into #ui like everything else, never innerHTML on the root.
// Interface text in English (D5). Nothing here knows about Three, Rapier or the
// session: the screen resolves a value, main.js turns it into a flight.

import { screen, button, keyHints, emptyState } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { mount, appendRtc } from './dialogue.js';
import { sessionContext } from './dialogue-context.js';
import { PROFILES, FAMILIES } from './drone-profiles.js';
import { radio } from './radio.js';
import { libraryFilters, filterLibrary, nowPlayingLine, jukeboxRow } from '../tools/jukebox-model.mjs';
import {
	MODE_SELECT, MODES, BENCH_CREED, BENCH_SEAL, LIMITS,
	ENTRY_MODES, LINK_MODES, BATTERY_MODES, HUD_MODES,
	BENCH_STORAGE_KEY, BENCH_DEFAULTS,
	normalizeBenchConfig, benchRows, benchBlockers, formatClock,
	serializeBenchConfig, parseBenchConfig,
} from '../tools/bench-model.mjs';
import {
	BUILD_BASES, PARAM_GROUPS, PARAMS, RATE_FAMILIES,
	partOptions, defaultParts, resolveBenchAirframe, paramValue, formatParam,
	rollSeed, normalizeOverrides,
} from '../tools/bench-airframe.mjs';
import { RATE_ACTUAL } from './rates.js';

// ---------------------------------------------------------------------------
// Persistence
//
// The bench's CONFIG persists; what happened on it does not. That is no breach
// of "NOTHING HERE IS LOGGED": setting a dozen controls again on every launch
// would be exactly the frustration the bench exists to remove, and nothing
// stored here says a flight took place.
//
// localStorage rather than the operator state: /__operator only exists under
// the dev server, and the bench has to stay openable without it. The fpvtp.
// prefix means the settings reset carries it away, like everything else.

const MODE_KEY = 'fpvtp.mode';

function store() {
	try {
		const s = globalThis.localStorage;
		s.getItem(MODE_KEY);   // triggers the throw in locked private browsing
		return s;
	} catch {
		const m = new Map();
		return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
	}
}

export function loadBenchConfig() {
	return parseBenchConfig(store().getItem(BENCH_STORAGE_KEY), { families: FAMILIES });
}

export function saveBenchConfig(config) {
	try { store().setItem(BENCH_STORAGE_KEY, serializeBenchConfig(config)); } catch { /* no matter */ }
	return config;
}

// The last way in, remembered across launches. All four count (D3): coming back
// to read a log should cost no more than coming back to fly.
// Modes that were renamed keep their cursor: an operator who left on ARCHIVE
// comes back on DATA, which is the same tab under its real name (issue #26).
const RENAMED_MODES = new Map([['archive', 'data']]);

export function loadLastMode() {
	const m = store().getItem(MODE_KEY);
	const renamed = RENAMED_MODES.get(m) ?? m;
	return MODES.includes(renamed) ? renamed : 'field';
}

function saveLastMode(mode) {
	try { store().setItem(MODE_KEY, mode); } catch { /* no matter */ }
}

// The thirteen wired events, shuffled on the root (issue #243). Written here
// rather than derived from EVENTS: the catalogue also declares eight events
// with neither corpus nor fallback (BOOTSTRAP, SYSTEM, FLIGHT, LINK_*, REVISIT
// — issue #242), and drawing them would only produce silence. This list says
// "what has something to say", which is not the same thing as "what is
// declared".
const RTC_EVENTS = [
	'AREA_SEARCH', 'PROBE_AREA', 'ACQUIRE_AREA', 'TERRAIN_PROGRESS',
	'TARGET_SCAN', 'TARGET_SELECTED', 'TARGET_ANALYSIS', 'HACK',
	'MANUAL_OVERRIDE', 'JACK_IN', 'WEATHER', 'CRASH', 'SESSION_COMPLETE',
];

// ---------------------------------------------------------------------------
// SELECT OPERATION MODE
//
// The root of the game. The cursor lands on the last mode used: a FIELD player
// makes one more keystroke per launch, not one more choice.

export function selectOperationMode(root, { last = loadLastMode(), operatorName = null } = {}) {
	const s = screen(root, 'terminal-home bench-modes');
	// Two columns (issue #243): the ways in on the left, the RTC on the right.
	// Same grammar as FIELD (`.terminal-left` / `.terminal-right`, vertical
	// rule, stacking below 1100 px) — a second layout language for two more
	// columns would have served nobody.
	const left = document.createElement('div');
	left.className = 'terminal-left';
	const right = document.createElement('div');
	right.className = 'terminal-right';
	s.box.appendChild(left);
	s.box.appendChild(right);
	// "OPERATOR // NEO" above the title (Bible §48): the root says first who you
	// are, then asks what you are going to do. It is the same line as the Home
	// — the Home is no longer the root, but identity does not move down with it.
	if (operatorName) {
		const who = document.createElement('pre');
		who.className = 'bench-operator';
		who.textContent = `OPERATOR // ${String(operatorName).toUpperCase()}`;
		left.appendChild(who);
	}
	const title = document.createElement('pre');
	title.textContent = MODE_SELECT.title;
	left.appendChild(title);

	// The shuffled stream: the root is no event of the catalogue, and since #243
	// it is the only screen still carrying an RTC block — without this mix the
	// generated corpus would no longer be read anywhere. CRASH and
	// SESSION_COMPLETE are part of it: #126 gave them POST-FLIGHT and LAST
	// SESSION, which have no RTC any more.
	const stopRtc = mount(appendRtc(right), {
		event: RTC_EVENTS,
		context: () => sessionContext({}),
	});

	return new Promise((resolve) => {
		let nav = null;
		const pick = (mode) => {
			nav?.detach();
			stopRtc();
			s.remove();
			saveLastMode(mode);
			resolve(mode);
		};

		for (const mode of MODES) {
			const m = MODE_SELECT[mode];
			const wrap = document.createElement('div');
			wrap.className = 'bench-mode';
			wrap.appendChild(button(m.label, () => pick(mode), 'terminal-cta'));
			const sub = document.createElement('pre');
			sub.className = 'bench-mode-sub';
			sub.textContent = m.lines.join('\n');
			wrap.appendChild(sub);
			left.appendChild(wrap);
		}

		// No `back`: this is the root, there is nothing above it.
		nav = menuNav(s.el, { focusFirst: false });
		// The cursor on the last mode used: coming back to fly in FIELD must
		// cost one keystroke, and so must coming back to the bench.
		nav.focusAt(Math.max(0, MODES.indexOf(last)));
	});
}

// ---------------------------------------------------------------------------
// Shared row grammar

const familyLabel = (f) => PROFILES[f]?.label ?? f;

// The grammar of a bench row: LABEL · leader · control · value.
//
// The four parts are ALWAYS there, even empty. That is what aligns the value
// column from one end of the table to the other and makes the bench read like a
// bench rather than like a form — a row that skips its value leaves a hole, and
// the eye loses the column.
//
// The leader is a real string of dots, not a CSS rule: the bootstrap screen
// already writes them (`dotted()` in bootstrap.js) and the bench must have the
// same hand. It is decorative — hence aria-hidden, so a screen reader does not
// recite forty dots between a label and its value.
function row(box, label, control, readout) {
	const r = document.createElement('div');
	r.className = 'bench-row';
	const l = document.createElement('span');
	l.className = 'bench-label';
	l.textContent = label;
	const lead = document.createElement('span');
	lead.className = 'bench-leader';
	lead.setAttribute('aria-hidden', 'true');
	const val = readout ?? document.createElement('span');
	val.className = 'bench-value';
	r.append(l, lead, control, val);
	box.appendChild(r);
	return r;
}

function select(options, value, onChange) {
	const el = document.createElement('select');
	el.className = 'bench-select';
	for (const [v, label] of options) {
		const o = document.createElement('option');
		o.value = String(v);
		o.textContent = label;
		el.appendChild(o);
	}
	el.value = String(value);
	el.onchange = () => onChange(el.value);
	return el;
}

function slider(limit, value, onInput) {
	const el = document.createElement('input');
	el.type = 'range';
	el.className = 'bench-slider';
	el.min = String(limit.min);
	el.max = String(limit.max);
	el.step = String(limit.step ?? 1);
	el.value = String(value);
	el.oninput = () => onInput(Number(el.value));
	return el;
}

const text = (content, cls = null) => {
	const e = document.createElement('span');
	if (cls) e.className = cls;
	e.textContent = content;
	return e;
};

// ---------------------------------------------------------------------------
// The airframe screen (issue #159)
//
// A family is a TYPE of machine. This is where it becomes THE machine: which
// base it is built off, which parts are on it, and what every number the flight
// stack reads is actually set to.
//
// Numeric parameters are typed, not dragged. The weather has sliders because a
// wind of "about eight" is a real request; a PID gain of "about 0.062" is not.
// This screen exists to be exact, so it takes digits.
export function runAirframe(root, { config, live = false, onChange = null } = {}) {
	let airframe = config.airframe;
	const s = screen(root, 'terminal-home bench-config bench-airframe');

	return new Promise((resolve) => {
		let nav = null;

		const set = (patch) => {
			airframe = { ...airframe, ...patch };
			onChange?.(airframe);
			render();
		};
		const setOverride = (key, value) => {
			const next = { ...airframe.overrides };
			if (value === null) delete next[key];
			else next[key] = value;
			set({ overrides: normalizeOverrides(next) });
		};

		const leave = () => { nav?.detach(); s.remove(); resolve(airframe); };

		const render = () => {
			const focusKey = document.activeElement?.dataset?.benchKey ?? null;
			s.box.replaceChildren();

			const r = resolveBenchAirframe(airframe);
			airframe = r.airframe;

			const head = document.createElement('pre');
			head.className = 'bench-title';
			head.textContent = 'AIRFRAME';
			s.box.appendChild(head);

			const sub = document.createElement('pre');
			sub.className = 'bench-creed';
			sub.textContent = `${familyLabel(airframe.family)}   ${airframe.base}   ${r.identity.toUpperCase()}`;
			s.box.appendChild(sub);

			const tag = (el, key) => { el.dataset.benchKey = key; return el; };

			// --- the base
			//
			// Changing family rebuilds the bill of materials from that family's
			// own parts: a 5" frame left under a toothpick would be a machine
			// nobody asked for. The overrides are NOT cleared — those were typed
			// on purpose, and they are clamped to bounds that hold for every
			// family anyway.
			row(s.box, 'FAMILY', tag(select(
				FAMILIES.map((f) => [f, familyLabel(f)]),
				airframe.family,
				(v) => set({ family: v, parts: defaultParts(v) }),
			), 'family'), text(familyLabel(airframe.family)));

			const baseCtl = document.createElement('div');
			baseCtl.className = 'bench-inline';
			baseCtl.appendChild(tag(select(
				BUILD_BASES.map((b) => [b, b]),
				airframe.base,
				(v) => set({ base: v, seed: v === 'INDIVIDUAL' ? (airframe.seed ?? rollSeed()) : airframe.seed }),
			), 'base'));
			if (airframe.base === 'INDIVIDUAL') {
				baseCtl.appendChild(tag(button('ROLL', () => set({ seed: rollSeed() })), 'roll'));
			}
			row(s.box, 'BASE', baseCtl,
				text(airframe.base === 'INDIVIDUAL' ? `SEED ${airframe.seed}` : airframe.base));

			// --- the bill of materials
			if (airframe.base === 'CUSTOM') {
				const opts = partOptions();
				const part = (key, label) => row(s.box, label, tag(select(
					opts[key],
					airframe.parts[key],
					(v) => set({ parts: { ...airframe.parts, [key]: key === 'blades' ? Number(v) : v } }),
				), `part.${key}`));
				part('frame', 'FRAME');
				part('motor', 'MOTOR ×4');
				part('prop', 'PROP ×4');
				part('blades', 'BLADES');
				part('battery', 'PACK');
				part('camera', 'CAMERA');
			}

			// --- what the parts add up to
			//
			// Consequences, not settings. Assembling a machine is only worth
			// doing if what it does shows while you do it.
			const d = r.derived;
			const readout = document.createElement('pre');
			readout.className = 'bench-readout';
			readout.textContent = [
				`MASS            ${Math.round(d.massG)} g`,
				`THRUST          ${d.thrustN.toFixed(1)} N  (${d.twr.toFixed(2)} : 1)`,
				`HOVER           ${Math.round(d.hoverFraction * 100)} % of travel`,
				`HEAD RPM        ${Math.round(d.rpm)}`,
				`PACK            ${r.profile.battery.cells}S ${r.profile.battery.capacityMah} mAh · ${Math.round(d.packDrawA)} A flat out`,
				`ENDURANCE       ${d.minutesFlatOut.toFixed(1)} min at that draw — a floor, not a flight time`,
			].join('\n');
			s.box.appendChild(readout);

			// --- every parameter
			for (const group of PARAM_GROUPS) {
				const gh = document.createElement('pre');
				gh.className = 'bench-group';
				gh.textContent = group.label;
				s.box.appendChild(gh);

				for (const p of group.params) {
					// The rate parameterisations are mutually exclusive: ACTUAL
					// reads (centre, max), the five spec families read (rcRate,
					// superRate), and showing both would be showing four controls
					// of which two do nothing.
					if (p.shape === 'actual' && r.rateFamily !== RATE_ACTUAL) continue;
					if (p.shape === 'spec' && r.rateFamily === RATE_ACTUAL) continue;
					paramRow(s.box, p, r, airframe, setOverride, tag);
				}
			}

			if (r.warnings.length) {
				const warn = document.createElement('pre');
				warn.className = 'bench-warn';
				warn.textContent = r.warnings.join('\n');
				s.box.appendChild(warn);
			}

			const foot = document.createElement('div');
			foot.className = 'terminal-nav';
			foot.appendChild(button('CLEAR OVERRIDES', () => set({ overrides: {} })));
			foot.appendChild(document.createTextNode(' · '));
			foot.appendChild(button('BACK', leave));
			s.box.appendChild(foot);
			s.box.appendChild(keyHints([['ESC', live ? 'BENCH PANEL' : 'BENCH']]));

			if (nav) {
				const again = focusKey && s.el.querySelector(`[data-bench-key="${focusKey}"]`);
				if (again) again.focus();
				else s.el.querySelector('[data-bench-key="base"]')?.focus();
			}
		};

		render();
		// The gamepad is unplugged in flight: the sticks fly the drone, and they
		// would walk the cursor across forty parameters on every input.
		nav = menuNav(s.el, { back: leave, focusFirst: false, gamepad: !live });
		s.el.querySelector('[data-bench-key="base"]')?.focus();
	});
}

// One parameter: its control, whether it is overridden, and what it reads.
//
// An overridden row wears a marker and a RESET. Without it there is no way to
// tell a value an operator typed from one the base happened to produce, and
// "what have I actually changed" is the first question anyone asks of a screen
// with forty numbers on it.
function paramRow(box, p, resolution, airframe, setOverride, tag) {
	const overridden = Object.hasOwn(airframe.overrides, p.key);
	const value = overridden
		? airframe.overrides[p.key]
		: paramValue(p.key, { profile: resolution.profile, rates: resolution.ratesView, rateFamily: resolution.rateFamily });

	const ctl = document.createElement('div');
	ctl.className = 'bench-inline';

	if (p.options) {
		const labels = p.optionLabels ?? p.options.map((o) => [o, String(o).toUpperCase()]);
		ctl.appendChild(tag(select(labels, value, (v) => {
			// A select's value is always a string; the rate families are keyed
			// by number for four of the six, and src/rates.js dispatches on that
			// number being a number.
			const opt = p.options.find((o) => String(o) === v);
			setOverride(p.key, opt ?? v);
		}), p.key));
	} else {
		const inp = document.createElement('input');
		inp.type = 'number';
		inp.className = 'bench-number';
		inp.min = String(p.min);
		inp.max = String(p.max);
		inp.step = String(p.step);
		inp.value = value === null || value === undefined ? '' : String(value);
		inp.setAttribute('aria-label', p.label);
		// `change` and not `input`: re-normalising on every keystroke would make
		// the field uneditable — typing the "0" of "0.062" would be clamped to
		// the floor and rewritten under your fingers. Same reason as the free
		// flight coordinates.
		//
		// An emptied field CLEARS the override rather than writing a zero: that
		// is how a row goes back to reading its base, and it is the only gesture
		// that has to exist for the screen to be reversible.
		inp.onchange = () => setOverride(p.key, inp.value.trim() === '' ? null : Number(inp.value));
		ctl.appendChild(tag(inp, p.key));
	}

	if (overridden) {
		ctl.appendChild(tag(button('RESET', () => setOverride(p.key, null)), `reset.${p.key}`));
	}

	const readout = text(formatParam(p.key, value), overridden ? 'bench-value bench-set' : 'bench-value');
	row(box, overridden ? `${p.label} ·` : p.label, ctl, readout);
}

// ---------------------------------------------------------------------------
// The radio, in flight (bench only)
//
// The jukebox keeps playing when you walk out of it, and that is the feature
// (issue #120) — but until now there was no way back IN once a flight had
// started, so a track that did not suit the flight had to be lived with or
// killed from the menus, which means landing.
//
// Only at the bench, and only in flight. FIELD's music is Bible §34's arc — the
// muffled hack, the ritual duck, the drop — and a transport control over it
// would be a second author on the same scene. The bench has no arc: it is a
// rig in a room with a radio on.
//
// This is a VIEW onto src/radio.js, exactly like src/jukebox.js: it never owns
// playback, and `radio.owns` is already what stops main.js touching the music.
function musicBlock(box, tag, state, repaint) {
	const library = radio.library;
	if (!library.length) {
		// The library is built on the jukebox's first visit. A flight that never
		// went there has none, so ask for it once and repaint when it lands —
		// ready() is memoised and never throws.
		if (!state.asked) {
			state.asked = true;
			radio.ready().then(repaint).catch(() => {});
		}
		row(box, 'RADIO', emptyState('NO MUSIC LIBRARY'));
		return;
	}

	const pools = libraryFilters(library);
	if (!pools.includes(state.pool)) state.pool = 'ALL';
	const shown = filterLibrary(library, state.pool);

	row(box, 'ON AIR', text(''), text(nowPlayingLine(radio.owns ? radio.current : null)));

	row(box, 'POOL', tag(select(
		pools.map((f) => [f, f.toUpperCase()]),
		state.pool,
		(v) => { state.pool = v; repaint(); },
	), 'pool'));

	const idx = shown.findIndex((t) => t.id === radio.current?.id);
	row(box, 'TRACK', tag(select(
		// The DISPLAYED list becomes the programme, the same rule the jukebox
		// screen follows: filtering on RACE5 and playing gives a race5 radio,
		// and the hand-over follows that order.
		shown.map((t, i) => [i, jukeboxRow(t, { playing: i === idx }).trim()]),
		idx < 0 ? 0 : idx,
		(v) => { radio.playAt(Number(v), shown).then(repaint).catch(() => {}); },
	), 'track'));

	const transport = document.createElement('div');
	transport.className = 'bench-inline';
	const step = (fn) => () => { fn.call(radio).then(repaint).catch(() => {}); };
	transport.appendChild(tag(button('PREV', step(radio.prev)), 'prev'));
	transport.appendChild(tag(button(radio.playing ? 'STOP' : 'PLAY', () => {
		// toggle() on a radio that has never taken the antenna resumes nothing:
		// there is no current track to resume. The first press therefore starts
		// the programme, which is what a PLAY button means.
		const act = radio.owns ? radio.toggle() : radio.playAt(idx < 0 ? 0 : idx, shown);
		act.then(repaint).catch(() => {});
	}), 'play'));
	transport.appendChild(tag(button('NEXT', step(radio.next)), 'next'));
	row(box, 'RADIO', transport);
}

// ---------------------------------------------------------------------------
// The bench screen

// Resolves the configuration to fly, or null to go back up to the mode choice.
//
// `scenes`: the terrain cache's list (may be empty — the bench then falls back
// to free flight, which needs no terrain on disk).
//
// `live`: the same screen, opened DURING the flight. Two differences only — the
// settings that would require a reload (the terrain) disappear, and every
// change leaves at once through onChange() instead of waiting for take-off. It
// is the same screen and the same model on purpose: a setting must behave the
// same before and during, otherwise the bench lies about what it sets.
export function runBench(root, { scenes = [], live = false, onChange = null } = {}) {
	let config = loadBenchConfig();

	// A default terrain: the last known area, otherwise the first one. If the
	// cache is empty, free flight — the bench must not open on a refusal.
	if (config.terrain.kind === 'cached'
		&& (!config.terrain.slug || !scenes.some((s) => s.slug === config.terrain.slug))) {
		if (scenes.length) config = normalizeBenchConfig({ ...config, terrain: { ...config.terrain, slug: scenes[0].slug } });
		else config = normalizeBenchConfig({ ...config, terrain: { ...config.terrain, kind: 'live' } });
	}

	const s = screen(root, 'terminal-home bench-config');

	// The radio's own screen state: which pool is on show, and whether the
	// library has been asked for. It belongs to the panel and not to the radio —
	// a sequencer that remembered a filter would be a sequencer with a view.
	const musicState = { pool: 'ALL', asked: false };

	return new Promise((resolve) => {
		let nav = null;

		const set = (patch) => {
			config = normalizeBenchConfig({ ...config, ...patch }, { families: FAMILIES });
			saveBenchConfig(config);
			onChange?.(config);
			render();
		};
		const setWeather = (patch) => set({ weather: { ...config.weather, ...patch } });
		const setTerrain = (patch) => set({ terrain: { ...config.terrain, ...patch } });

		const leave = (value) => { nav?.detach(); s.remove(); resolve(value); };

		// The airframe screen replaces this one and hands it back: the bench is
		// a stack of two screens, not two panels fighting over one root.
		const openAirframe = async () => {
			nav?.detach();
			// And forgotten, not merely detached: render() refocuses its own
			// cursor when it has a nav, and the airframe screen's onChange
			// re-renders this one underneath. Without this, typing a parameter
			// would pull focus down into the hidden screen at every keystroke.
			nav = null;
			s.el.hidden = true;
			const next = await runAirframe(root, {
				config, live,
				onChange: (a) => set({ airframe: a }),
			});
			s.el.hidden = false;
			set({ airframe: next });
			nav = menuNav(s.el, { back: () => leave(live ? config : null), focusFirst: false, gamepad: !live });
			s.el.querySelector('[data-bench-key="detail"]')?.focus();
		};

		const render = () => {
			// The cursor has to survive the re-render: we remember WHAT was
			// focused, not which index — rows appear and disappear (lat/lon only
			// exist in free flight) and an index would lie.
			const focusKey = document.activeElement?.dataset?.benchKey ?? null;

			s.box.replaceChildren();

			// Title and creed apart: the creed is not a second title line, it is
			// what the bench says about itself. At UI level and in dead ink it
			// reads as a row of four terms — in the same <pre> it shouted as loud
			// as BENCH.
			const head = document.createElement('pre');
			head.className = 'bench-title';
			head.textContent = 'BENCH';
			s.box.appendChild(head);

			const creed = document.createElement('pre');
			creed.className = 'bench-creed';
			creed.textContent = BENCH_CREED.join('   ');
			s.box.appendChild(creed);

			const rows = new Map(benchRows(config, { familyLabel }).map((r) => [r.key, r]));
			const val = (k) => text(rows.get(k).value);

			const tag = (el, key) => { el.dataset.benchKey = key; return el; };

			// --- the machine
			row(s.box, 'AIRFRAME', tag(select(
				FAMILIES.map((f) => [f, familyLabel(f)]),
				config.airframe.family,
				(v) => set({ airframe: { ...config.airframe, family: v, parts: defaultParts(v) } }),
			), 'family'));

			const buildCtl = document.createElement('div');
			buildCtl.className = 'bench-inline';
			buildCtl.appendChild(tag(select(
				BUILD_BASES.map((b) => [b, b]),
				config.airframe.base,
				(v) => set({
					airframe: {
						...config.airframe,
						base: v,
						seed: v === 'INDIVIDUAL' ? (config.airframe.seed ?? rollSeed()) : config.airframe.seed,
					},
				}),
			), 'base'));
			if (config.airframe.base === 'INDIVIDUAL') {
				buildCtl.appendChild(tag(button('ROLL', () => set({
					airframe: { ...config.airframe, seed: rollSeed() },
				})), 'roll'));
			}
			row(s.box, 'BUILD', buildCtl, val('seed'));

			// One door to the machine itself. The bench stays readable at a
			// glance — a dozen rows — and everything exact is one keystroke away.
			row(s.box, 'MACHINE', tag(button('PARAMETERS', openAirframe), 'detail'), val('detail'));

			// --- the terrain
			//
			// Absent in flight: changing terrain means reloading the scene, so
			// leaving the flight. Showing it greyed out would be worse than not
			// showing it — the bench does not display buttons that do nothing.
			if (!live) {
				const terrainOpts = [
					...scenes.map((sc) => [`cached:${sc.slug}`, (sc.name ?? sc.slug).toUpperCase()]),
					['live', 'LIVE — ANYWHERE'],
				];
				row(s.box, 'TERRAIN', tag(select(
					terrainOpts,
					config.terrain.kind === 'live' ? 'live' : `cached:${config.terrain.slug}`,
					(v) => setTerrain(v === 'live' ? { kind: 'live' } : { kind: 'cached', slug: v.slice('cached:'.length) }),
				), 'terrain'));

				if (config.terrain.kind === 'live') {
					const coords = document.createElement('div');
					coords.className = 'bench-inline';
					for (const key of ['lat', 'lon']) {
						const inp = document.createElement('input');
						inp.type = 'text';
						inp.className = 'bench-coord';
						inp.value = String(config.terrain[key]);
						inp.setAttribute('aria-label', key.toUpperCase());
						// `change` and not `input`: re-normalising on every
						// keystroke would make the field uneditable — typing the
						// "4" of "48" would be clamped and rewritten at once.
						inp.onchange = () => setTerrain({ [key]: Number(inp.value) });
						coords.appendChild(tag(inp, key));
					}
					row(s.box, 'COORDS', coords);
				}
			}

			// --- the way in
			row(s.box, 'ENTRY', tag(select(
				ENTRY_MODES.map((e) => [e, e === 'IDLE' ? 'IDLE ON GROUND' : e.replace('_', ' ')]),
				config.entry,
				(v) => set({ entry: v }),
			), 'entry'));

			row(s.box, 'FENCE', tag(select(
				[['on', 'ON'], ['off', 'OFF']],
				config.fence ? 'on' : 'off',
				(v) => set({ fence: v === 'on' }),
			), 'fence'));

			// The DRONE's OSD only: FPVTP!'s does not switch off, it carries
			// PHOTO READY and the end of the flight. CLEAR is a machine built
			// without an OSD, for filming — not a blind flight.
			row(s.box, 'HUD', tag(select(HUD_MODES.map((h) => [h, h]), config.hud, (v) => set({ hud: v })), 'hud'));

			// --- the conditions
			row(s.box, 'TIME', tag(slider(LIMITS.timeMin, config.timeMin, (v) => set({ timeMin: v })), 'time'),
				text(formatClock(config.timeMin)));

			row(s.box, 'WIND', tag(slider(LIMITS.windSpeed, config.weather.windSpeed, (v) => setWeather({ windSpeed: v })), 'wind'), val('wind'));
			row(s.box, 'GUST', tag(slider(LIMITS.gustFactor, config.weather.gustFactor, (v) => setWeather({ gustFactor: v })), 'gust'), val('gust'));
			row(s.box, 'FROM', tag(slider(LIMITS.windDir, config.weather.windDir, (v) => setWeather({ windDir: v })), 'dir'), val('dir'));
			row(s.box, 'RAIN', tag(slider(LIMITS.rateMmH, config.weather.rateMmH, (v) => setWeather({ rateMmH: v })), 'rain'), val('rain'));
			row(s.box, 'FOG', tag(slider(LIMITS.visibilityM, config.weather.visibilityM, (v) => setWeather({ visibilityM: v })), 'fog'), val('fog'));
			row(s.box, 'CLOUD', tag(slider(LIMITS.cloudPct, config.weather.cloudPct, (v) => setWeather({ cloudPct: v })), 'cloud'), val('cloud'));

			// --- the rest
			row(s.box, 'LINK', tag(select(LINK_MODES.map((l) => [l, l]), config.link, (v) => set({ link: v })), 'link'));
			row(s.box, 'BATTERY', tag(select(BATTERY_MODES.map((b) => [b, b]), config.battery, (v) => set({ battery: v })), 'battery'));

			// --- the radio, only over a flight
			if (live) musicBlock(s.box, tag, musicState, render);

			// --- what has to be known before taking off
			const airframeWarnings = resolveBenchAirframe(config.airframe).warnings;
			const blockers = [...(live ? [] : benchBlockers(config, { scenes })), ...airframeWarnings];
			// The bench's ONLY refusal: no terrain at all. The rest of the lines
			// are a warning, not a lock — the bench informs, it does not forbid
			// (Bible §2, "Information, not assistance").
			const fatal = blockers.filter((b) => /NO LOCAL TERRAIN|NO LONGER ON DISK/.test(b));
			if (blockers.length) {
				const warn = document.createElement('pre');
				warn.className = 'bench-warn';
				warn.textContent = blockers.join('\n');
				s.box.appendChild(warn);
			}

			const seal = document.createElement('pre');
			seal.className = 'bench-seal';
			seal.textContent = BENCH_SEAL;
			s.box.appendChild(seal);

			const spin = button(live ? 'RESUME' : 'SPIN UP', () => leave(config), 'terminal-cta');
			spin.disabled = fatal.length > 0;
			tag(spin, 'spin');
			s.box.appendChild(spin);

			const foot = document.createElement('div');
			foot.className = 'terminal-nav';
			const reset = () => {
				config = normalizeBenchConfig(BENCH_DEFAULTS, { families: FAMILIES });
				saveBenchConfig(config);
				onChange?.(config);
				render();
			};
			foot.appendChild(button('RESET BENCH', reset));
			// No SETTINGS here (D6): the panel has one door in the menus, at the
			// root, plus Tab in flight.
			if (!live) {
				foot.appendChild(document.createTextNode(' · '));
				foot.appendChild(button('BACK', () => leave(null)));
			}
			s.box.appendChild(foot);
			// D15: Escape goes back up to the choice of way, and it says so. In
			// flight the bench has no back — the panel is a setting, not a screen.
			if (!live) s.box.appendChild(keyHints([['ESC', 'OPERATION MODE']]));

			// Puts the cursor back where it was, otherwise on SPIN UP — which is
			// what you come for when you reopen the bench without changing
			// anything.
			if (nav) {
				const again = focusKey && s.el.querySelector(`[data-bench-key="${focusKey}"]`);
				if (again) again.focus();
				else s.el.querySelector('[data-bench-key="spin"]')?.focus();
			}
		};

		render();
		// In flight Escape RESUMES the flight — it cancels nothing, since
		// everything has already been applied as it went. Before the flight, it
		// goes back up.
		// And the gamepad is unplugged in flight: the sticks fly the drone, they
		// would move the cursor and the sliders on every gesture (same reason as
		// the Settings panel opened in flight).
		nav = menuNav(s.el, {
			back: () => leave(live ? config : null),
			focusFirst: false,
			gamepad: !live,
		});
		s.el.querySelector('[data-bench-key="spin"]')?.focus();
	});
}
