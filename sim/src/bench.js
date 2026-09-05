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
import { mount, appendRtc } from './dialogue.js';
import { sessionContext } from './dialogue-context.js';
import { PROFILES, FAMILIES } from './drone-profiles.js';
import {
	MODE_SELECT, BENCH_CREED, BENCH_SEAL, LIMITS,
	ENTRY_MODES, LINK_MODES, BATTERY_MODES, HUD_MODES,
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

// Les treize événements câblés, mêlés sur la racine (issue #243). Écrite ici
// et pas dérivée d'EVENTS : le catalogue déclare aussi huit événements sans
// corpus ni secours (BOOTSTRAP, SYSTEM, FLIGHT, LINK_*, REVISIT — issue #242),
// et les tirer ne produirait que du silence. Cette liste dit « ce qui a de quoi
// parler », ce qui n'est pas la même chose que « ce qui est déclaré ».
const RTC_EVENTS = [
	'AREA_SEARCH', 'PROBE_AREA', 'ACQUIRE_AREA', 'TERRAIN_PROGRESS',
	'TARGET_SCAN', 'TARGET_SELECTED', 'TARGET_ANALYSIS', 'HACK',
	'MANUAL_OVERRIDE', 'JACK_IN', 'WEATHER', 'CRASH', 'SESSION_COMPLETE',
];

// ---------------------------------------------------------------------------
// SELECT OPERATION MODE
//
// La racine du jeu. Le curseur se pose sur le dernier mode utilisé : un joueur
// FIELD fait une touche de plus par lancement, pas un choix de plus.

export function selectOperationMode(root, { last = loadLastMode(), operatorName = null } = {}) {
	const s = screen(root, 'terminal-home bench-modes');
	// Deux colonnes (issue #243) : les voies à gauche, le RTC à droite. Même
	// grammaire que FIELD (`.terminal-left` / `.terminal-right`, filet vertical,
	// empilement sous 1100 px) — une seconde langue de mise en page pour deux
	// colonnes de plus n'aurait servi personne.
	const left = document.createElement('div');
	left.className = 'terminal-left';
	const right = document.createElement('div');
	right.className = 'terminal-right';
	s.box.appendChild(left);
	s.box.appendChild(right);
	// « OPERATOR // NEO » au-dessus du titre (Bible §48) : la racine dit d'abord
	// qui tu es, puis demande ce que tu vas faire. C'est la même ligne que la
	// Home — la Home n'est plus la racine, mais l'identité, elle, ne descend pas.
	if (operatorName) {
		const who = document.createElement('pre');
		who.className = 'bench-operator';
		who.textContent = `OPERATOR // ${String(operatorName).toUpperCase()}`;
		left.appendChild(who);
	}
	const title = document.createElement('pre');
	title.textContent = MODE_SELECT.title;
	left.appendChild(title);

	// Le flux mêlé : la racine n'est aucun événement du catalogue, et depuis
	// #243 elle est le seul écran qui porte encore un bloc RTC — sans ce mélange
	// le corpus généré ne serait plus lu nulle part. CRASH et SESSION_COMPLETE
	// en font partie : #126 leur avait donné POST-FLIGHT et LAST SESSION, qui
	// n'ont plus de RTC.
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

		for (const mode of ['field', 'bench']) {
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

// La grammaire d'une ligne de banc : ÉTIQUETTE · conduite · contrôle · valeur.
//
// Les quatre parties sont TOUJOURS là, même vides. C'est ce qui aligne la
// colonne des valeurs d'un bout à l'autre du tableau et fait lire le banc comme
// un banc plutôt que comme un formulaire — une ligne qui saute sa valeur laisse
// un trou, et l'œil perd la colonne.
//
// La conduite est un vrai chapelet de points, pas un filet CSS : l'écran de
// bootstrap en écrit déjà (`dotted()` dans bootstrap.js) et le banc doit avoir
// la même main. Elle est décorative — d'où aria-hidden, pour qu'un lecteur
// d'écran ne récite pas quarante points entre l'étiquette et sa valeur.
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

			// Titre et credo séparés : le credo n'est pas une seconde ligne de
			// titre, c'est ce que le banc dit de lui-même. Au niveau UI et en
			// encre éteinte, il se lit comme une rangée de quatre termes — dans
			// le même <pre> il criait aussi fort que BENCH.
			const head = document.createElement('pre');
			head.className = 'bench-title';
			head.textContent = 'BENCH';
			s.box.appendChild(head);

			const creed = document.createElement('pre');
			creed.className = 'bench-creed';
			creed.textContent = BENCH_CREED.join('   ');
			s.box.appendChild(creed);

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

			// L'OSD du DRONE seulement : celui de FPVTP! ne se coupe pas, il porte
			// PHOTO READY et la fin de vol. CLEAR, c'est une machine montée sans
			// OSD pour filmer — pas un vol à l'aveugle.
			row(s.box, 'HUD', tag(select(HUD_MODES.map((h) => [h, h]), config.hud, (v) => set({ hud: v })), 'hud'));

			// --- les conditions
			row(s.box, 'TIME', tag(slider(LIMITS.timeMin, config.timeMin, (v) => set({ timeMin: v })), 'time'),
				(() => { const e = document.createElement('span'); e.textContent = formatClock(config.timeMin); return e; })());

			row(s.box, 'WIND', tag(slider(LIMITS.windSpeed, config.weather.windSpeed, (v) => setWeather({ windSpeed: v })), 'wind'), val('wind'));
			row(s.box, 'GUST', tag(slider(LIMITS.gustFactor, config.weather.gustFactor, (v) => setWeather({ gustFactor: v })), 'gust'), val('gust'));
			row(s.box, 'FROM', tag(slider(LIMITS.windDir, config.weather.windDir, (v) => setWeather({ windDir: v })), 'dir'), val('dir'));
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
