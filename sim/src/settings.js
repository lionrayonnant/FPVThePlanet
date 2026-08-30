import { CHANNELS } from './input.js';
import { menuNav } from './menu-nav.js';

const VOLUME_KEY = 'fpvmaps.audioVolume';
const BRIGHTNESS_KEY = 'fpvmaps.audioBrightness';
const LENS_KEY = 'fpvmaps.lens';
const VIGNETTE_KEY = 'fpvmaps.lensVignette';
const SHUTTER_KEY = 'fpvmaps.lensShutter';
const LENS_ON_KEY = 'fpvmaps.lensOn';
const LINK_KEY = 'fpvmaps.link';
const LINK_MODE_KEY = 'fpvmaps.linkMode';

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

// The Tab panel: gamepad mapping, camera, lens, video link, audio. It owns
// #settings and nothing else — l'OSD de vol s'est scindé en deux couches
// (drone-osd.js et fpvtp-osd.js), le terminal opérateur est dans terminal.js.
// PHASE 12 : le champ et l'inclinaison de la caméra appartiennent à la cible,
// donc leurs deux sliders ont laissé la place à une fiche en lecture seule, et
// l'aide clavier a quitté l'écran de vol pour ce panneau.
// PHASE 04 has taken the weather out: the six wind /
// rain / fog controls are gone, and nothing here can choose the weather any
// more. The link block stays for now — it is not weather, and issue #41 does
// not ask for it.
export class Settings {
	constructor(root, input) {
		this.input = input;
		const el = document.createElement('div');
		el.id = 'settings';
		el.hidden = true;
		el.innerHTML = `
			<div class="panel">
				<h2>Manette</h2>
				<p id="pad-name">aucune manette détectée</p>
				<table id="pad-map"></table>
				<h2>Caméra</h2>
				<div id="cam-spec" class="spec">—</div>
				<h2>Commandes</h2>
				<div id="keymap" class="spec">
					<b>W/S</b> throttle · <b>A/D</b> yaw · <b>arrows</b>/mouse roll-pitch<br>
					<b>R</b> respawn · <b>J</b> disarm · <b>M</b> mode · <b>P</b> rates<br>
					<b>C</b> free camera · <b>Space</b> pause · <b>Tab</b> settings
				</div>
				<h2>Objectif</h2>
				<label class="check"><input id="lens-on" type="checkbox"> Rendu FPV</label>
				<label>Objectif <input id="lens" type="range" min="0" max="100" step="1"> <span id="lens-val"></span> %</label>
				<label>Vignettage <input id="vig" type="range" min="0" max="100" step="1"> <span id="vig-val"></span> %</label>
				<label>Obturation <input id="shut" type="range" min="0" max="20" step="0.5"> <span id="shut-val"></span></label>
				<h2>Lien vidéo</h2>
				<label>Rendu <select id="link-mode">
					<option value="analog">Analogique</option>
					<option value="digital">Numérique</option>
				</select></label>
				<label>Dégradation <input id="link" type="range" min="0" max="100" step="1"> <span id="link-val"></span> %</label>
				<div id="link-presets" class="presets">
					<button type="button" data-v="30">Faible</button>
					<button type="button" data-v="60">Moyen</button>
					<button type="button" data-v="100">Élevé</button>
				</div>
				<h2>Son</h2>
				<label>Volume <input id="vol" type="range" min="0" max="100" step="1"> <span id="vol-val"></span> %</label>
				<label>Timbre <input id="tone" type="range" min="0" max="100" step="1"> <span id="tone-val"></span></label>
				<button id="reset-settings">Réinitialiser les réglages</button>
				<button id="close-settings">Fermer (Tab)</button>
			</div>`;
		root.appendChild(el);

		this.el = {
			settings: el,
			vol: el.querySelector('#vol'),
			volVal: el.querySelector('#vol-val'),
			tone: el.querySelector('#tone'),
			toneVal: el.querySelector('#tone-val'),
			padName: el.querySelector('#pad-name'),
			padMap: el.querySelector('#pad-map'),
			camSpec: el.querySelector('#cam-spec'),
			lensOn: el.querySelector('#lens-on'),
			lens: el.querySelector('#lens'),
			lensVal: el.querySelector('#lens-val'),
			vig: el.querySelector('#vig'),
			vigVal: el.querySelector('#vig-val'),
			shut: el.querySelector('#shut'),
			shutVal: el.querySelector('#shut-val'),
			linkMode: el.querySelector('#link-mode'),
			link: el.querySelector('#link'),
			linkVal: el.querySelector('#link-val'),
			linkPresets: el.querySelector('#link-presets'),
		};
		// Posé à vrai par main.js quand un vol démarre : le panneau ouvert en vol
		// n'écoute pas la manette (les sticks pilotent le drone — issue #123).
		this.flightActive = false;
		el.querySelector('#close-settings').onclick = () => this.toggleSettings(false);
		el.querySelector('#reset-settings').onclick = () => {
			if (!confirm('Réinitialiser tous les réglages (manette, caméra, objectif, lien vidéo, son) ?')) return;
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
		this.setLens(loadLens(), noop);
		this.setLink(loadLink(), noop);
		this.setAudio(loadVolume(), loadBrightness(), noop);
	}

	// La fiche de la caméra de la cible, en lecture seule. Le drone n'est pas le
	// tien : son champ et son inclinaison ne se règlent pas.
	setCameraSpec({ fovDeg, uptiltDeg, aspectName, resScale }) {
		this.el.camSpec.textContent =
			`${Math.round(fovDeg)}° FOV · ${Math.round(uptiltDeg)}° UPTILT · ${aspectName} · ${Math.round(resScale * 100)}%`;
	}

	// One slider for the lens as a whole — barrel, chromatic aberration and edge
	// softness are the same piece of glass, so splitting them into three controls
	// would only let you build an optic that cannot exist. Shutter is separate
	// because it belongs to the sensor, and because it is the first thing to turn
	// off if the frame rate drops.
	setLens({ on, lens, vignette, shutter }, onChange) {
		const emit = () => {
			const enabled = this.el.lensOn.checked;
			const l = Number(this.el.lens.value);
			const v = Number(this.el.vig.value);
			const ms = Number(this.el.shut.value);
			this.el.lensVal.textContent = l;
			this.el.vigVal.textContent = v;
			this.el.shutVal.textContent = ms === 0 ? 'aucune' : `${ms.toFixed(1)} ms`;
			// The link lives in the same pass, so the master switch has to reach it
			// too — otherwise its controls stay live while doing nothing.
			for (const el of [this.el.lens, this.el.vig, this.el.shut,
			                  this.el.linkMode, this.el.link,
			                  ...this.el.linkPresets.children]) el.disabled = !enabled;
			try {
				localStorage.setItem(LENS_ON_KEY, enabled ? '1' : '0');
				localStorage.setItem(LENS_KEY, String(l));
				localStorage.setItem(VIGNETTE_KEY, String(v));
				localStorage.setItem(SHUTTER_KEY, String(ms / 20 * 100));
			} catch { }
			onChange({ on: enabled, lens: l / 100, vignette: v / 100, shutter: ms / 1000 });
		};
		this.el.lensOn.checked = on;
		this.el.lens.value = Math.round(lens * 100);
		this.el.vig.value = Math.round(vignette * 100);
		this.el.shut.value = shutter;
		this.el.lensOn.onchange = emit;
		this.el.lens.oninput = emit;
		this.el.vig.oninput = emit;
		this.el.shut.oninput = emit;
		emit();
	}

	// Two controls and not four: which receiver you are pretending to fly, and how
	// hard it bites. Everything else about the link — where it breaks, how fast it
	// recovers — is a consequence of the geometry and belongs in link.js, not on a
	// slider.
	setLink({ mode, severity }, onChange) {
		const emit = () => {
			const pct = Number(this.el.link.value);
			const m = this.el.linkMode.value;
			this.el.linkVal.textContent = pct;
			for (const b of this.el.linkPresets.children)
				b.classList.toggle('on', Number(b.dataset.v) === pct);
			try {
				localStorage.setItem(LINK_KEY, String(pct));
				localStorage.setItem(LINK_MODE_KEY, m);
			} catch { }
			onChange({ mode: m, severity: pct / 100 });
		};
		this.el.linkMode.value = mode;
		this.el.link.value = Math.round(severity * 100);
		this.el.linkMode.onchange = emit;
		this.el.link.oninput = emit;
		this.el.linkPresets.onclick = (e) => {
			const b = e.target.closest('button');
			if (!b) return;
			this.el.link.value = b.dataset.v;
			emit();
		};
		emit();
	}

	// Both audio settings are worth remembering across reloads: nobody wants the
	// sim to come back at full blast every time, and where "bright enough but
	// not tiring" sits depends on the headphones. Same localStorage shape as
	// the gamepad map in input.js.
	setAudio(volume, brightness, onChange) {
		const emit = () => {
			const vol = Number(this.el.vol.value);
			const tone = Number(this.el.tone.value);
			this.el.volVal.textContent = vol;
			// Signed, because what the slider does is move away from the tuning
			// the spectrum was measured at, in both directions.
			this.el.toneVal.textContent = tone === 50 ? 'neutre' : (tone > 50 ? '+' : '') + (tone - 50);
			try {
				localStorage.setItem(VOLUME_KEY, String(vol));
				localStorage.setItem(BRIGHTNESS_KEY, String(tone));
			} catch { }
			onChange(vol / 100, tone / 100);
		};
		this.el.vol.value = Math.round(volume * 100);
		this.el.tone.value = Math.round(brightness * 100);
		this.el.vol.oninput = emit;
		this.el.tone.oninput = emit;
		emit();
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
		this.el.padName.textContent = pad ? pad.id : 'aucune manette détectée';
		if (!pad) { this.el.padMap.innerHTML = ''; this._axisRows = []; return; }

		this.el.padMap.innerHTML = '';
		this._axisRows = CHANNELS.map((ch) => {
			const tr = document.createElement('tr');
			const opts = pad.axes.map((_, i) => `<option value="${i}">axe ${i}</option>`).join('');
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
		if (!this.settingsOpen || this._axisRows.length === 0) return;
		const pad = this.input.getGamepad();
		if (!pad) return;
		for (const row of this._axisRows) {
			const v = pad.axes[Number(row.sel.value)] ?? 0;
			row.fill.style.left = `${((v + 1) / 2) * 100}%`;
		}
	}
}
