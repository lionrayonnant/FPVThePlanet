// BENCH — le banc (PHASE 26, Bible §48). Écrans seulement : toute la logique
// vit dans ../tools/bench-model.mjs, testée sans navigateur.
//
// Deux écrans :
//   selectOperationMode()  la racine du jeu — FIELD ou BENCH
//   runBench()             la configuration du banc, jusqu'au SPIN UP
//
// Monté en APPEND dans #ui comme tout le reste, jamais innerHTML sur la racine.
// Texte d'interface en anglais (D5). Rien ici ne connaît Three, Rapier ni la
// session : l'écran résout une valeur, main.js en fait un vol.

import { screen, button } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { PROFILES, FAMILIES } from './drone-profiles.js';
import {
	MODE_SELECT, BENCH_CREED, BENCH_SEAL, LIMITS,
	ENTRY_MODES, LINK_MODES, BATTERY_MODES,
	BENCH_STORAGE_KEY, BENCH_DEFAULTS,
	normalizeBenchConfig, benchRows, benchBlockers, formatClock,
	serializeBenchConfig, parseBenchConfig,
} from '../tools/bench-model.mjs';

// ---------------------------------------------------------------------------
// Persistance
//
// La CONFIG du banc persiste ; ce qui s'y est passé, non. Ce n'est pas une
// entorse à « NOTHING HERE IS LOGGED » : reposer douze réglages à chaque
// lancement serait exactement la frustration que le banc existe pour
// supprimer, et rien de ce qui est stocké ici ne dit qu'un vol a eu lieu.
//
// localStorage plutôt que l'état opérateur : /__operator n'existe que sous le
// serveur de dev, et le banc doit rester ouvrable sans lui. Le préfixe
// fpvmaps. le fait emporter par le reset des réglages, comme le reste.

const MODE_KEY = 'fpvmaps.mode';

function store() {
	try {
		const s = globalThis.localStorage;
		s.getItem(MODE_KEY);   // déclenche le throw en navigation privée verrouillée
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
	try { store().setItem(BENCH_STORAGE_KEY, serializeBenchConfig(config)); } catch { /* pas grave */ }
	return config;
}

export function loadLastMode() {
	return store().getItem(MODE_KEY) === 'bench' ? 'bench' : 'field';
}

function saveLastMode(mode) {
	try { store().setItem(MODE_KEY, mode); } catch { /* pas grave */ }
}

// ---------------------------------------------------------------------------
// SELECT OPERATION MODE
//
// La racine du jeu. Le curseur se pose sur le dernier mode utilisé : un joueur
// FIELD fait une touche de plus par lancement, pas un choix de plus.

export function selectOperationMode(root, { last = loadLastMode() } = {}) {
	const s = screen(root, 'terminal-home bench-modes');
	const title = document.createElement('pre');
	title.textContent = MODE_SELECT.title;
	s.box.appendChild(title);

	return new Promise((resolve) => {
		let nav = null;
		const pick = (mode) => {
			nav?.detach();
			s.remove();
			saveLastMode(mode);
			resolve(mode);
		};

		for (const mode of ['field', 'bench']) {
			const m = MODE_SELECT[mode];
			const wrap = document.createElement('div');
			wrap.className = 'bench-mode';
			wrap.appendChild(button(m.label, () => pick(mode), 'terminal-cta'));
			const sub = document.createElement('pre');
			sub.className = 'bench-mode-sub';
			sub.textContent = m.lines.join('\n');
			wrap.appendChild(sub);
			s.box.appendChild(wrap);
		}

		// Pas de `back` : c'est la racine, il n'y a rien au-dessus.
		nav = menuNav(s.el, { focusFirst: false });
		// Le curseur sur le dernier mode utilisé : revenir jouer en FIELD ne
		// doit coûter qu'une touche, et revenir au banc non plus.
		nav.focusAt(last === 'bench' ? 1 : 0);
	});
}

// ---------------------------------------------------------------------------
// L'écran du banc

const familyLabel = (f) => PROFILES[f]?.label ?? f;

function row(box, label, control, readout) {
	const r = document.createElement('div');
	r.className = 'bench-row';
	const l = document.createElement('span');
	l.className = 'bench-label';
	l.textContent = label;
	r.append(l, control);
	if (readout) {
		readout.className = 'bench-value';
		r.appendChild(readout);
	}
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

const rollSeed = () => Math.random().toString(16).slice(2, 8);

// Résout la configuration à voler, ou null pour remonter au choix de mode.
//
// `scenes` : la liste du cache terrain (peut être vide — le banc bascule alors
// sur le vol libre, qui n'a besoin d'aucun terrain sur disque).
//
// `live` : le même écran, ouvert PENDANT le vol. Deux différences seulement —
// les réglages qui exigeraient un rechargement (le terrain) disparaissent, et
// chaque changement part tout de suite dans onChange() au lieu d'attendre le
// décollage. C'est le même écran et le même modèle à dessein : un réglage doit
// se comporter pareil avant et pendant, sinon le banc ment sur ce qu'il règle.
export function runBench(root, { scenes = [], settings = null, live = false, onChange = null } = {}) {
	let config = loadBenchConfig();

	// Un terrain par défaut : la dernière zone connue, sinon la première. Si le
	// cache est vide, le vol libre — le banc ne doit pas s'ouvrir sur un refus.
	if (config.terrain.kind === 'cached'
		&& (!config.terrain.slug || !scenes.some((s) => s.slug === config.terrain.slug))) {
		if (scenes.length) config = normalizeBenchConfig({ ...config, terrain: { ...config.terrain, slug: scenes[0].slug } });
		else config = normalizeBenchConfig({ ...config, terrain: { ...config.terrain, kind: 'live' } });
	}

	const s = screen(root, 'terminal-home bench-config');

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

		const render = () => {
			// Le curseur doit survivre au re-rendu : on retient QUOI était
			// focalisé, pas quel index — les lignes apparaissent et disparaissent
			// (lat/lon n'existent qu'en vol libre) et un index mentirait.
			const focusKey = document.activeElement?.dataset?.benchKey ?? null;

			s.box.replaceChildren();

			const head = document.createElement('pre');
			head.className = 'bench-head';
			head.textContent = `BENCH\n\n${BENCH_CREED.join('   ')}`;
			s.box.appendChild(head);

			const rows = new Map(benchRows(config, { familyLabel }).map((r) => [r.key, r]));
			const val = (k) => { const e = document.createElement('span'); e.textContent = rows.get(k).value; return e; };

			const tag = (el, key) => { el.dataset.benchKey = key; return el; };

			// --- la machine
			row(s.box, 'AIRFRAME', tag(select(
				FAMILIES.map((f) => [f, familyLabel(f)]),
				config.airframe.family,
				(v) => set({ airframe: { ...config.airframe, family: v } }),
			), 'family'));

			const buildCtl = document.createElement('div');
			buildCtl.className = 'bench-inline';
			buildCtl.appendChild(tag(select(
				[['nominal', 'NOMINAL'], ['seeded', 'INDIVIDUAL']],
				config.airframe.seed ? 'seeded' : 'nominal',
				(v) => set({ airframe: { ...config.airframe, seed: v === 'seeded' ? (config.airframe.seed ?? rollSeed()) : null } }),
			), 'seed'));
			if (config.airframe.seed) {
				buildCtl.appendChild(tag(button('ROLL', () => set({ airframe: { ...config.airframe, seed: rollSeed() } })), 'roll'));
			}
			row(s.box, 'BUILD', buildCtl, val('seed'));

			// --- le terrain
			//
			// Absent en vol : changer de terrain veut dire recharger la scène,
			// donc quitter le vol. Le montrer grisé serait pire que ne pas le
			// montrer — le banc n'affiche pas des boutons qui ne font rien.
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
						// `change` et non `input` : re-normaliser à chaque frappe
						// rendrait le champ inéditable — taper « 4 » de « 48 »
						// serait aussitôt borné et réécrit sous les doigts.
						inp.onchange = () => setTerrain({ [key]: Number(inp.value) });
						coords.appendChild(tag(inp, key));
					}
					row(s.box, 'COORDS', coords);
				}
			}

			// --- l'entrée
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

			// --- les conditions
			row(s.box, 'TIME', tag(slider(LIMITS.timeMin, config.timeMin, (v) => set({ timeMin: v })), 'time'),
				(() => { const e = document.createElement('span'); e.textContent = formatClock(config.timeMin); return e; })());

			row(s.box, 'WIND', tag(slider(LIMITS.windSpeed, config.weather.windSpeed, (v) => setWeather({ windSpeed: v })), 'wind'), val('wind'));
			row(s.box, 'GUST', tag(slider(LIMITS.gustFactor, config.weather.gustFactor, (v) => setWeather({ gustFactor: v })), 'gust'));
			row(s.box, 'FROM', tag(slider(LIMITS.windDir, config.weather.windDir, (v) => setWeather({ windDir: v })), 'dir'));
			row(s.box, 'RAIN', tag(slider(LIMITS.rateMmH, config.weather.rateMmH, (v) => setWeather({ rateMmH: v })), 'rain'), val('rain'));
			row(s.box, 'FOG', tag(slider(LIMITS.visibilityM, config.weather.visibilityM, (v) => setWeather({ visibilityM: v })), 'fog'), val('fog'));
			row(s.box, 'CLOUD', tag(slider(LIMITS.cloudPct, config.weather.cloudPct, (v) => setWeather({ cloudPct: v })), 'cloud'), val('cloud'));

			// --- le reste
			row(s.box, 'LINK', tag(select(LINK_MODES.map((l) => [l, l]), config.link, (v) => set({ link: v })), 'link'));
			row(s.box, 'BATTERY', tag(select(BATTERY_MODES.map((b) => [b, b]), config.battery, (v) => set({ battery: v })), 'battery'));

			// --- ce qu'il faut savoir avant de décoller
			const blockers = live ? [] : benchBlockers(config, { scenes });
			// Le SEUL refus du banc : pas de terrain du tout. Le reste des lignes
			// est un avertissement, pas un verrou — le banc informe, il n'interdit
			// pas (Bible §2, « Information, not assistance »).
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
			foot.appendChild(document.createTextNode(' · '));
			foot.appendChild(button('SETTINGS', () => settings?.toggleSettings(true)));
			if (!live) {
				foot.appendChild(document.createTextNode(' · '));
				foot.appendChild(button('BACK', () => leave(null)));
			}
			s.box.appendChild(foot);

			// Repose le curseur là où il était, sinon sur SPIN UP — c'est ce
			// qu'on vient chercher quand on rouvre le banc sans rien changer.
			if (nav) {
				const again = focusKey && s.el.querySelector(`[data-bench-key="${focusKey}"]`);
				if (again) again.focus();
				else s.el.querySelector('[data-bench-key="spin"]')?.focus();
			}
		};

		render();
		// En vol, Échap REPREND le vol — il n'annule rien, puisque tout a déjà
		// été appliqué au fur et à mesure. Avant le vol, il remonte.
		// Et la manette est débranchée en vol : les sticks pilotent le drone,
		// ils déplaceraient le curseur et les sliders à chaque geste (même
		// raison que le panneau Settings ouvert en vol).
		nav = menuNav(s.el, {
			back: () => leave(live ? config : null),
			focusFirst: false,
			gamepad: !live,
		});
		s.el.querySelector('[data-bench-key="spin"]')?.focus();
	});
}
