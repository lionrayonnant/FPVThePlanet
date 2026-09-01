import { CHANNELS } from './input.js';
import { menuNav } from './menu-nav.js';

const VOLUME_KEY = 'fpvmaps.audioVolume';
const BRIGHTNESS_KEY = 'fpvmaps.audioBrightness';
const MUSIC_KEY = 'fpvmaps.musicVolume';
const LENS_KEY = 'fpvmaps.lens';
const VIGNETTE_KEY = 'fpvmaps.lensVignette';
const SHUTTER_KEY = 'fpvmaps.lensShutter';
const LENS_ON_KEY = 'fpvmaps.lensOn';
const LINK_KEY = 'fpvmaps.link';
const LINK_MODE_KEY = 'fpvmaps.linkMode';
const VIEW_RANGE_KEY = 'fpvmaps.viewRange';

// Audio settings survive reloads. Anything unparseable falls back to the
// default rather than throwing: a corrupt key must not stop the sim booting.
// Note the null check — Number(null) is 0, which would silently turn a first
// run into a muted one.
function loadPercent(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved / 100;
	} catch { }
	return fallback;
}

export const loadVolume = () => loadPercent(VOLUME_KEY, 0.6);
export const loadBrightness = () => loadPercent(BRIGHTNESS_KEY, 0.5);
// Ce défaut EST la balance musique/moteur, et c'est le seul endroit où elle
// vit : audio-bus.js n'applique plus de trim par-dessus (il en avait un, à 0.7
// lui aussi, ce qui atténuait deux fois — corrigé). 0.7 est la valeur mesurée à
// la première écoute en vol.
//
// Réglage SÉPARÉ du volume global, pour qu'on puisse baisser la musique sans
// baisser le moteur : le vol reste un exercice d'écoute de la machine.
export const loadMusicVolume = () => loadPercent(MUSIC_KEY, 0.7);

// Distance d'affichage du mode ?live= (#182), en MÈTRES — pas un pourcentage,
// donc pas loadPercent(). Bornes du curseur : 100-600 m. Le coût est
// QUADRATIQUE en rayon (nœuds ∝ r², mesuré : 200 m ≈ 1032 meshes) — 600 m
// ≈ ×9, c'est le GPU et kh.google.com de l'utilisateur, son choix. Défaut
// 300 m : choisi par l'utilisateur à la première écoute du curseur.
export const VIEW_RANGE_MIN_M = 100;
export const VIEW_RANGE_MAX_M = 600;
export function loadViewRange() {
	try {
		const raw = localStorage.getItem(VIEW_RANGE_KEY);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= VIEW_RANGE_MIN_M && saved <= VIEW_RANGE_MAX_M) return saved;
	} catch { }
	return 300;
}

// The FPV look is on by default — a clean rectilinear camera is the thing this
// is here to stop looking like. Every part of it is a slider away from off, and
// the master checkbox is one click away, which is what makes A/B comparison
// possible at all.
export function loadLens() {
	let on = true;
	try { on = localStorage.getItem(LENS_ON_KEY) !== '0'; } catch { }
	return {
		on,
		lens: loadPercent(LENS_KEY, 0.6),
		vignette: loadPercent(VIGNETTE_KEY, 0.5),
		// 8 ms is 1/125 s: a plausible daylight shutter on an FPV camera, and long
		// enough that a fast roll visibly smears.
		shutter: loadPercent(SHUTTER_KEY, 0.4) * 20,
	};
}

// La météo n'est plus ici (PHASE 04, Bible §31). Le vent, la pluie et le
// brouillard appartiennent au monde et à la session : ils viennent du world
// state de l'opérateur via src/weather.js, et aucun réglage utilisateur ne
// permet plus de choisir le temps qu'il fait. Les modèles wind.js / rain.js /
// fog.js n'ont pas bougé — seule la main qui écrit leurs paramètres a changé.
// window.__sim.setWeather / setRain / setFog restent l'accès de debug.

// The link degradation is on at full strength by default: the point of the
// feature is that going behind a building costs you the picture, and a version
// that never quite breaks would not be that. The slider is what makes it an
// argument rather than a decree — 0 % turns the whole thing off.
export function loadLink() {
	let mode = 'analog';
	try {
		const saved = localStorage.getItem(LINK_MODE_KEY);
		if (saved === 'analog' || saved === 'digital') mode = saved;
	} catch { }
	return { mode, severity: loadPercent(LINK_KEY, 1) };
}

// The Tab panel: input detection/binding, controls reminder, audio. It owns
// #settings and nothing else — l'OSD de vol s'est scindé en deux couches
// (drone-osd.js et fpvtp-osd.js), le terminal opérateur est dans terminal.js.
// Issue #120 : caméra, objectif et lien vidéo n'étaient pas des réglages
// destinés au joueur — ils restent pilotés par leurs valeurs stockées
// (loadLens/loadLink, cf. main.js) mais ont quitté ce panneau.
export class Settings {
	constructor(root, input) {
		this.input = input;
		const el = document.createElement('div');
		el.id = 'settings';
		el.hidden = true;
		el.innerHTML = `
			<div class="panel">
				<h2>Controller</h2>
				<p id="pad-name">no controller detected</p>
				<table id="pad-map"></table>
				<h2>Controls</h2>
				<div id="keymap" class="spec">
					<b>W/S</b> throttle · <b>A/D</b> yaw · <b>arrows</b>/mouse roll-pitch<br>
					<b>R</b> respawn · <b>J</b> disarm · <b>M</b> mode · <b>P</b> rates<br>
					<b>C</b> free camera · <b>Space</b> pause · <b>Tab</b> settings
				</div>
				<h2>Sound</h2>
				<label>Volume <input id="vol" type="range" min="0" max="100" step="1"> <span id="vol-val"></span> %</label>
				<label>Tone <input id="tone" type="range" min="0" max="100" step="1"> <span id="tone-val"></span></label>
				<label>Music <input id="music" type="range" min="0" max="100" step="1"> <span id="music-val"></span> %</label>
				<div id="viewrange-row" hidden>
					<h2>View</h2>
					<label>Range <input id="viewrange" type="range" min="${VIEW_RANGE_MIN_M}" max="${VIEW_RANGE_MAX_M}" step="50"> <span id="viewrange-val"></span> m</label>
				</div>
				<button id="reset-settings">Reset settings</button>
				<button id="close-settings">Close (Tab)</button>
			</div>`;
		root.appendChild(el);

		this.el = {
			settings: el,
			vol: el.querySelector('#vol'),
			volVal: el.querySelector('#vol-val'),
			tone: el.querySelector('#tone'),
			toneVal: el.querySelector('#tone-val'),
			music: el.querySelector('#music'),
			musicVal: el.querySelector('#music-val'),
			viewRangeRow: el.querySelector('#viewrange-row'),
			viewRange: el.querySelector('#viewrange'),
			viewRangeVal: el.querySelector('#viewrange-val'),
			padName: el.querySelector('#pad-name'),
			padMap: el.querySelector('#pad-map'),
		};
		// Posé à vrai par main.js quand un vol démarre : le panneau ouvert en vol
		// n'écoute pas la manette (les sticks pilotent le drone — issue #123).
		this.flightActive = false;
		el.querySelector('#close-settings').onclick = () => this.toggleSettings(false);
		el.querySelector('#reset-settings').onclick = () => {
			if (!confirm('Reset all settings (controller, sound)?')) return;
			try {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('fpvmaps.')) localStorage.removeItem(key);
				}
			} catch { }
			location.reload();
		};
		this._axisRows = [];
		// Populate every control from storage now, with inert callbacks, so the
		// panel reads correctly when opened from the terminal before boot(). boot()
		// calls the same setters again with live callbacks — every setter re-reads
		// and re-emits, so the second pass is idempotent.
		this.hydrate();
	}

	hydrate() {
		const noop = () => { };
		this.setAudio(loadVolume(), loadBrightness(), loadMusicVolume(), noop);
	}

	// All three audio settings are worth remembering across reloads: nobody
	// wants the sim to come back at full blast every time, where "bright enough
	// but not tiring" sits depends on the headphones, and how much music you
	// want under the motors is a matter of taste. Same localStorage shape as
	// the gamepad map in input.js.
	setAudio(volume, brightness, musicVolume, onChange) {
		const emit = () => {
			const vol = Number(this.el.vol.value);
			const tone = Number(this.el.tone.value);
			const mus = Number(this.el.music.value);
			this.el.volVal.textContent = vol;
			// Signed, because what the slider does is move away from the tuning
			// the spectrum was measured at, in both directions.
			this.el.toneVal.textContent = tone === 50 ? 'neutre' : (tone > 50 ? '+' : '') + (tone - 50);
			this.el.musicVal.textContent = mus;
			try {
				localStorage.setItem(VOLUME_KEY, String(vol));
				localStorage.setItem(BRIGHTNESS_KEY, String(tone));
				localStorage.setItem(MUSIC_KEY, String(mus));
			} catch { }
			onChange(vol / 100, tone / 100, mus / 100);
		};
		this.el.vol.value = Math.round(volume * 100);
		this.el.tone.value = Math.round(brightness * 100);
		this.el.music.value = Math.round(musicVolume * 100);
		this.el.vol.oninput = emit;
		this.el.tone.oninput = emit;
		this.el.music.oninput = emit;
		emit();
	}

	// Curseur de distance d'affichage du mode ?live= (#182). La ligne reste
	// cachée hors mode live (le rayon de fenêtre n'existe pas pour une scène
	// pré-cuite) : c'est CET appel, fait par bootLive(), qui la révèle.
	// L'affichage suit le doigt (oninput) mais le callback ne part qu'au
	// relâchement (onchange) : chaque cran déclenche traverse() + une vague de
	// fetchs vers kh.google.com — pas pendant un glissement.
	setViewRange(meters, onChange) {
		this.el.viewRangeRow.hidden = false;
		const show = () => { this.el.viewRangeVal.textContent = this.el.viewRange.value; };
		const commit = () => {
			const m = Number(this.el.viewRange.value);
			show();
			try { localStorage.setItem(VIEW_RANGE_KEY, String(m)); } catch { }
			onChange(m);
		};
		this.el.viewRange.value = meters;
		this.el.viewRange.oninput = show;
		this.el.viewRange.onchange = commit;
		commit();
	}

	toggleSettings(force) {
		const show = force ?? this.el.settings.hidden;
		this.el.settings.hidden = !show;
		if (show) {
			this.buildAxisRows();
			// Navigation clavier + manette (issue #123) : ↑/↓ circule entre les
			// lignes, ←/→ règle le contrôle focalisé (menu-nav.js sait lesquels
			// sont réglables), Échap / B referme. Attaché à l'ouverture seulement :
			// en vol, panneau fermé, les flèches restent des commandes.
			this._nav ??= menuNav(this.el.settings, {
				back: () => this.toggleSettings(false),
				gamepad: !this.flightActive,
			});
		} else {
			this._nav?.detach();
			this._nav = null;
		}
	}

	get settingsOpen() { return !this.el.settings.hidden; }

	// One row per channel: pick which axis drives it and whether to invert.
	// Live bars next to each let you see which physical stick is which.
	buildAxisRows() {
		const pad = this.input.getGamepad();
		this.el.padName.textContent = pad ? pad.id : 'no controller detected';
		if (!pad) { this.el.padMap.innerHTML = ''; this._axisRows = []; return; }

		this.el.padMap.innerHTML = '';
		this._axisRows = CHANNELS.map((ch) => {
			const tr = document.createElement('tr');
			const opts = pad.axes.map((_, i) => `<option value="${i}">axis ${i}</option>`).join('');
			tr.innerHTML = `<td>${ch}</td>
				<td><select>${opts}</select></td>
				<td><label><input type="checkbox"> inv</label></td>
				<td><div class="axisbar"><i></i></div></td>`;
			const sel = tr.querySelector('select');
			const inv = tr.querySelector('input');
			sel.value = String(this.input.map[ch].axis);
			inv.checked = this.input.map[ch].invert;
			const save = () => this.input.setMapping(ch, Number(sel.value), inv.checked);
			sel.onchange = save;
			inv.onchange = save;
			this.el.padMap.appendChild(tr);
			return { ch, sel, fill: tr.querySelector('.axisbar i') };
		});
	}

	updateAxisBars() {
		if (!this.settingsOpen) return;
		// La manette a pu se faire connaître après l'ouverture du panneau
		// (ex. gamepadconnected pas encore levé par le navigateur au moment
		// du premier buildAxisRows()) : on retente tant qu'aucune ligne n'a
		// été construite plutôt que de rester bloqué sur "no controller detected".
		if (this._axisRows.length === 0) { this.buildAxisRows(); return; }
		const pad = this.input.getGamepad();
		if (!pad) return;
		for (const row of this._axisRows) {
			const v = pad.axes[Number(row.sel.value)] ?? 0;
			row.fill.style.left = `${((v + 1) / 2) * 100}%`;
		}
	}
}
