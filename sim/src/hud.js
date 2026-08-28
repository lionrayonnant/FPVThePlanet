import { CHANNELS } from './input.js';
import { WIND_PRESETS, compassPoint } from './wind.js';
import { RAIN_PRESETS, MAX_RATE } from './rain.js';
import { FOG_PRESETS, rangeFor } from './fog.js';

const VOLUME_KEY = 'fpvmaps.audioVolume';
const BRIGHTNESS_KEY = 'fpvmaps.audioBrightness';
const LENS_KEY = 'fpvmaps.lens';
const VIGNETTE_KEY = 'fpvmaps.lensVignette';
const SHUTTER_KEY = 'fpvmaps.lensShutter';
const LENS_ON_KEY = 'fpvmaps.lensOn';
const LINK_KEY = 'fpvmaps.link';
const LINK_MODE_KEY = 'fpvmaps.linkMode';
// Where the wind is pushing you, in the drone's own frame: index 0 is straight
// ahead (world +Z at zero yaw, which is south — see the axis note in wind.js).
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

const WIND_KEY = 'fpvmaps.windSpeed';
const WIND_DIR_KEY = 'fpvmaps.windDir';
const GUST_KEY = 'fpvmaps.windGust';
const TURB_KEY = 'fpvmaps.windTurb';
const RAIN_KEY = 'fpvmaps.rain';
const RAIN_VAR_KEY = 'fpvmaps.rainVar';
const FOG_KEY = 'fpvmaps.fog';
const FOG_VAR_KEY = 'fpvmaps.fogVar';

// Audio settings survive reloads. Anything unparseable falls back to the
// default rather than throwing: a corrupt key must not stop the sim booting.
// Note the null check — Number(null) is 0, which would silently turn a first
// run into a muted one.
// loadPercent's 0..100 range is wrong for a bearing and for a wind speed, and
// storing "60% of 20 m/s" instead of "12 m/s" would make the saved value depend
// on the slider's range. Physical units, and the bounds come from the caller.
function loadNumber(key, fallback, min, max) {
	try {
		const raw = localStorage.getItem(key);
		const saved = raw === null ? NaN : Number(raw);
		if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
	} catch { }
	return fallback;
}

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

// Wind is off by default, and that is not timidity: three of the checks in
// tools/selftest.mjs — holds altitude at hover, terminal velocity falling flat,
// sits still on the ground — only mean anything in calm air, and a sim that
// starts by pushing you sideways before you have touched a slider is a sim that
// looks broken. The direction is drawn once, on first run, and then kept: the
// randomness exists so it is not always a convenient tailwind down the same
// street, which is a reason to vary it between pilots, not between reloads.
export function loadWeather() {
	let dir = loadNumber(WIND_DIR_KEY, -1, 0, 355);
	if (dir < 0) {
		dir = Math.floor(Math.random() * 72) * 5;
		try { localStorage.setItem(WIND_DIR_KEY, String(dir)); } catch { }
	}
	return {
		speed: loadNumber(WIND_KEY, 0, 0, 25),
		direction: dir,
		gust: loadPercent(GUST_KEY, 0),
		turbulence: loadPercent(TURB_KEY, 0.5) * 2,
	};
}

// Dry by default, for the same reason the wind starts calm: every check in
// tools/selftest.mjs assumes a neutral world, and a sim that opens under a
// downpour looks broken rather than atmospheric. Variability starts at 50 %,
// which is where rain stops being a constant and starts being weather.
export function loadRain() {
	return {
		intensity: loadPercent(RAIN_KEY, 0),
		variability: loadPercent(RAIN_VAR_KEY, 0.5),
	};
}

// Clear air by default, and for the same reason the wind starts calm and the
// rain dry: every check in tools/selftest.mjs assumes a neutral world, and the
// #9fb8cc sky pixel that HANDOFF calls the regression not to reopen is the sky
// of a scene whose fog slider is at zero. Variability starts at 50 %, which is
// where fog stops being a filter and starts being weather.
export function loadFog() {
	return {
		intensity: loadPercent(FOG_KEY, 0),
		variability: loadPercent(FOG_VAR_KEY, 0.5),
	};
}

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

export class Hud {
	constructor(root, input) {
		this.input = input;
		root.innerHTML = `
			<div id="menu" hidden><div class="panel">
				<h2>Choisir une carte</h2>
				<div id="menu-list"></div>
				<a id="add-map-link" href="/add-map.html">+ Ajouter une carte</a>
			</div></div>

			<div id="loading" hidden><div class="box">
				<h1>FPVThePlanet!</h1>
				<p id="loading-status">chargement…</p>
				<div class="bar"><div id="loading-bar"></div></div>
				<p id="loading-detail"></p>
				<p id="loading-clock"></p>
			</div></div>

			<div id="hud" hidden>
				<div class="corner tl">
					<div class="big"><span id="alt">0</span><small>m AGL</small></div>
					<div class="big"><span id="spd">0</span><small>km/h</small></div>
				</div>
				<div class="corner tr">
					<div id="mode">ACRO</div>
					<div id="preset">freestyle</div>
					<div id="src">clavier</div>
					<div id="fps">–</div>
					<div id="rssi">–</div>
					<div id="wind-hud" hidden>–</div>
				</div>
				<div class="corner bl">
					<div class="throttle"><div id="thr-fill"></div></div>
					<div class="label">gaz</div>
					<div id="batt"><span id="volts">16.8</span><small>V</small>
						<div class="battbar"><i id="batt-fill"></i></div>
						<span id="amps">0</span><small>A</small></div>
				</div>
				<div class="corner br" id="help">
					<b>W/S</b> gaz · <b>A/D</b> lacet · <b>flèches</b>/souris roulis-tangage<br>
					<b>R</b> respawn · <b>M</b> mode · <b>P</b> rates · <b>C</b> caméra libre · <b>Espace</b> pause · <b>Tab</b> réglages
				</div>
				<div id="crash" hidden>CRASH<small>R pour repartir</small></div>
					<div id="pause" hidden>PAUSE<small>Espace pour reprendre</small></div>
				<div id="reticle"></div>
			</div>

			<div id="settings" hidden>
				<div class="panel">
					<h2>Manette</h2>
					<p id="pad-name">aucune manette détectée</p>
					<table id="pad-map"></table>
					<h2>Caméra</h2>
					<label>FOV <input id="fov" type="range" min="80" max="150" step="1"> <span id="fov-val"></span>°</label>
					<label>Uptilt <input id="tilt" type="range" min="0" max="50" step="1"> <span id="tilt-val"></span>°</label>
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
					<h2>Météo — vent</h2>
					<label>Vent <input id="wind" type="range" min="0" max="25" step="0.5"> <span id="wind-val"></span> m/s</label>
					<label title="direction d'où vient le vent">Direction <input id="wind-dir" type="range" min="0" max="355" step="5"> <span id="wind-dir-val"></span>
						<button type="button" id="wind-dir-rand" title="au hasard">↻</button></label>
					<label>Rafales <input id="gust" type="range" min="0" max="100" step="1"> <span id="gust-val"></span> %</label>
					<label>Turbulences <input id="turb" type="range" min="0" max="200" step="5"> <span id="turb-val"></span> %</label>
					<div id="wind-presets" class="presets">
						<button type="button" data-v="calme">Calme</button>
						<button type="button" data-v="brise">Brise</button>
						<button type="button" data-v="frais">Vent frais</button>
						<button type="button" data-v="tempete">Tempête</button>
					</div>
					<h2>Météo — pluie</h2>
					<label>Pluie <input id="rain" type="range" min="0" max="100" step="1"> <span id="rain-val"></span></label>
					<label title="de combien l'averse va et vient">Variabilité <input id="rain-var" type="range" min="0" max="100" step="1"> <span id="rain-var-val"></span> %</label>
					<div id="rain-presets" class="presets">
						<button type="button" data-v="sec">Sec</button>
						<button type="button" data-v="bruine">Bruine</button>
						<button type="button" data-v="pluie">Pluie</button>
						<button type="button" data-v="averse">Averse</button>
					</div>
					<h2>Météo — brouillard</h2>
					<label title="jusqu'où on voit">Brouillard <input id="fog" type="range" min="0" max="100" step="1"> <span id="fog-val"></span></label>
					<label title="de combien la nappe va et vient">Variabilité <input id="fog-var" type="range" min="0" max="100" step="1"> <span id="fog-var-val"></span> %</label>
					<div id="fog-presets" class="presets">
						<button type="button" data-v="clair">Clair</button>
						<button type="button" data-v="brume">Brume</button>
						<button type="button" data-v="brouillard">Brouillard</button>
						<button type="button" data-v="puree">Purée de pois</button>
					</div>
					<h2>Son</h2>
					<label>Volume <input id="vol" type="range" min="0" max="100" step="1"> <span id="vol-val"></span> %</label>
					<label>Timbre <input id="tone" type="range" min="0" max="100" step="1"> <span id="tone-val"></span></label>
					<button id="reset-settings">Réinitialiser les réglages</button>
					<button id="close-settings">Fermer (Tab)</button>
				</div>
			</div>`;

		this.el = {
			menu: root.querySelector('#menu'),
			menuList: root.querySelector('#menu-list'),
			loading: root.querySelector('#loading'),
			status: root.querySelector('#loading-status'),
			bar: root.querySelector('#loading-bar'),
			detail: root.querySelector('#loading-detail'),
			clock: root.querySelector('#loading-clock'),
			hud: root.querySelector('#hud'),
			alt: root.querySelector('#alt'),
			spd: root.querySelector('#spd'),
			mode: root.querySelector('#mode'),
			src: root.querySelector('#src'),
			fps: root.querySelector('#fps'),
			preset: root.querySelector('#preset'),
			volts: root.querySelector('#volts'),
			amps: root.querySelector('#amps'),
			battFill: root.querySelector('#batt-fill'),
			batt: root.querySelector('#batt'),
			wind: root.querySelector('#wind'),
			windVal: root.querySelector('#wind-val'),
			windDir: root.querySelector('#wind-dir'),
			windDirVal: root.querySelector('#wind-dir-val'),
			windDirRand: root.querySelector('#wind-dir-rand'),
			gust: root.querySelector('#gust'),
			gustVal: root.querySelector('#gust-val'),
			turb: root.querySelector('#turb'),
			turbVal: root.querySelector('#turb-val'),
			windPresets: root.querySelector('#wind-presets'),
			windHud: root.querySelector('#wind-hud'),
			rain: root.querySelector('#rain'),
			rainVal: root.querySelector('#rain-val'),
			rainVar: root.querySelector('#rain-var'),
			rainVarVal: root.querySelector('#rain-var-val'),
			rainPresets: root.querySelector('#rain-presets'),
			fog: root.querySelector('#fog'),
			fogVal: root.querySelector('#fog-val'),
			fogVar: root.querySelector('#fog-var'),
			fogVarVal: root.querySelector('#fog-var-val'),
			fogPresets: root.querySelector('#fog-presets'),
			vol: root.querySelector('#vol'),
			volVal: root.querySelector('#vol-val'),
			tone: root.querySelector('#tone'),
			toneVal: root.querySelector('#tone-val'),
			thr: root.querySelector('#thr-fill'),
			crash: root.querySelector('#crash'),
			pause: root.querySelector('#pause'),
			reticle: root.querySelector('#reticle'),
			settings: root.querySelector('#settings'),
			padName: root.querySelector('#pad-name'),
			padMap: root.querySelector('#pad-map'),
			fov: root.querySelector('#fov'),
			fovVal: root.querySelector('#fov-val'),
			tilt: root.querySelector('#tilt'),
			tiltVal: root.querySelector('#tilt-val'),
			lensOn: root.querySelector('#lens-on'),
			lens: root.querySelector('#lens'),
			lensVal: root.querySelector('#lens-val'),
			vig: root.querySelector('#vig'),
			vigVal: root.querySelector('#vig-val'),
			shut: root.querySelector('#shut'),
			shutVal: root.querySelector('#shut-val'),
			linkMode: root.querySelector('#link-mode'),
			link: root.querySelector('#link'),
			linkVal: root.querySelector('#link-val'),
			linkPresets: root.querySelector('#link-presets'),
			rssi: root.querySelector('#rssi'),
		};
		root.querySelector('#close-settings').onclick = () => this.toggleSettings(false);
		root.querySelector('#reset-settings').onclick = () => {
			if (!confirm('Réinitialiser tous les réglages (manette, caméra, objectif, météo, son) ?')) return;
			try {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('fpvmaps.')) localStorage.removeItem(key);
				}
			} catch { }
			location.reload();
		};

		this._frames = 0;
		this._fpsAt = performance.now();
		this._axisRows = [];
	}

	// Pre-flight screen: one button per prepared map. Resolves via onPick and
	// hands off to the loading screen, which stays hidden until now.
	showMenu(scenes, onPick) {
		this.el.menuList.innerHTML = '';
		for (const s of scenes) {
			const btn = document.createElement('button');
			btn.textContent = s.name;
			btn.onclick = () => {
				this.el.menu.hidden = true;
				this.el.loading.hidden = false;
				onPick(s.slug);
			};
			this.el.menuList.appendChild(btn);
		}
		this.el.menu.hidden = false;
	}

	progress(text, fraction) {
		this.el.status.textContent = text;
		if (fraction !== undefined) this.el.bar.style.width = `${Math.round(fraction * 100)}%`;
	}

	detail(text) {
		this.el.detail.textContent = text;
	}

	// A ticking clock is the cheapest way to tell "slow" apart from "hung", and
	// naming the current step says which part is the slow one.
	startClock() {
		const t0 = performance.now();
		this._stage = { name: '', at: t0 };
		this._clock = setInterval(() => {
			const total = (performance.now() - t0) / 1000;
			const inStage = (performance.now() - this._stage.at) / 1000;
			this.el.clock.textContent = this._stage.name
				? `${total.toFixed(0)} s — étape « ${this._stage.name} » depuis ${inStage.toFixed(0)} s`
				: `${total.toFixed(0)} s`;
		}, 250);
	}

	setStage(name) {
		if (this._stage) this._stage = { name, at: performance.now() };
	}

	fail(err) {
		clearInterval(this._clock);
		this.el.status.innerHTML = `<span class="err">${err}</span>`;
		this.el.bar.style.width = '0%';
	}

	ready() {
		clearInterval(this._clock);
		this.el.loading.hidden = true;
		this.el.hud.hidden = false;
	}

	setCamera(fov, tilt, onChange) {
		this.el.fov.value = fov;
		this.el.tilt.value = tilt;
		this.el.fovVal.textContent = fov;
		this.el.tiltVal.textContent = tilt;
		const emit = () => {
			this.el.fovVal.textContent = this.el.fov.value;
			this.el.tiltVal.textContent = this.el.tilt.value;
			onChange(Number(this.el.fov.value), Number(this.el.tilt.value));
		};
		this.el.fov.oninput = emit;
		this.el.tilt.oninput = emit;
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

	// Four controls, and one of them is a gust knob standing in for three. The
	// issue asks for gust intensity, duration and frequency separately and it is
	// right to — they are genuinely independent — but three gust sliders on a
	// flight panel is three sliders nobody ever moves. The one knob walks a line
	// through all three (see wind.js), because that is how weather gets worse:
	// gustier air means gusts that are bigger, sharper AND more frequent. The
	// full triple is still reachable from window.__sim for anyone tuning it.
	//
	// Everything else about the wind — how it grows with height, where it is
	// sheltered, where it is channelled — is a consequence of the scene and
	// belongs in wind.js, not on a slider. Same argument as setLink.
	setWeather({ speed, direction, gust, turbulence }, onChange) {
		const emit = () => {
			const p = {
				speed: Number(this.el.wind.value),
				direction: Number(this.el.windDir.value),
				gust: Number(this.el.gust.value) / 100,
				turbulence: Number(this.el.turb.value) / 100,
			};
			this.el.windVal.textContent = p.speed.toFixed(1);
			this.el.windDirVal.textContent = `${p.direction}° ${compassPoint(p.direction)}`;
			this.el.gustVal.textContent = Math.round(p.gust * 100);
			this.el.turbVal.textContent = Math.round(p.turbulence * 100);
			// A preset lights up only when the whole bundle matches, not one
			// number of it — otherwise three of the four buttons glow at once.
			for (const b of this.el.windPresets.children) {
				const w = WIND_PRESETS[b.dataset.v];
				b.classList.toggle('on', !!w && w.speed === p.speed
					&& Math.abs(w.gust - p.gust) < 0.005 && Math.abs(w.turbulence - p.turbulence) < 0.005);
			}
			try {
				localStorage.setItem(WIND_KEY, String(p.speed));
				localStorage.setItem(WIND_DIR_KEY, String(p.direction));
				localStorage.setItem(GUST_KEY, String(Math.round(p.gust * 100)));
				localStorage.setItem(TURB_KEY, String(Math.round(p.turbulence * 50)));
			} catch { }
			onChange(p);
		};
		this.el.wind.value = speed;
		this.el.windDir.value = direction;
		this.el.gust.value = Math.round(gust * 100);
		this.el.turb.value = Math.round(turbulence * 100);
		this.el.wind.oninput = emit;
		this.el.windDir.oninput = emit;
		this.el.gust.oninput = emit;
		this.el.turb.oninput = emit;
		this.el.windDirRand.onclick = () => {
			this.el.windDir.value = Math.floor(Math.random() * 72) * 5;
			emit();
		};
		this.el.windPresets.onclick = (e) => {
			const b = e.target.closest('button');
			if (!b || !WIND_PRESETS[b.dataset.v]) return;
			const w = WIND_PRESETS[b.dataset.v];
			this.el.wind.value = w.speed;
			this.el.gust.value = Math.round(w.gust * 100);
			this.el.turb.value = Math.round(w.turbulence * 100);
			emit();
		};
		emit();
	}

	setRain({ intensity, variability }, onChange) {
		const emit = () => {
			const p = {
				intensity: Number(this.el.rain.value) / 100,
				variability: Number(this.el.rainVar.value) / 100,
			};
			// Millimetres per hour, not a percentage: "12 mm/h" is a number a
			// pilot can picture and "48 %" is not.
			const mm = p.intensity * MAX_RATE;
			this.el.rainVal.textContent = p.intensity === 0 ? 'sec'
				: `${mm < 1 ? mm.toFixed(1) : Math.round(mm)} mm/h`;
			this.el.rainVarVal.textContent = Math.round(p.variability * 100);
			// A preset lights up only when the whole bundle matches, same rule
			// as the wind ones.
			for (const b of this.el.rainPresets.children) {
				const r = RAIN_PRESETS[b.dataset.v];
				b.classList.toggle('on', !!r && Math.abs(r.intensity - p.intensity) < 0.005
					&& Math.abs(r.variability - p.variability) < 0.005);
			}
			try {
				localStorage.setItem(RAIN_KEY, String(Math.round(p.intensity * 100)));
				localStorage.setItem(RAIN_VAR_KEY, String(Math.round(p.variability * 100)));
			} catch { }
			onChange(p);
		};
		this.el.rain.value = Math.round(intensity * 100);
		this.el.rainVar.value = Math.round(variability * 100);
		this.el.rain.oninput = emit;
		this.el.rainVar.oninput = emit;
		this.el.rainPresets.onclick = (e) => {
			const b = e.target.closest('button');
			if (!b || !RAIN_PRESETS[b.dataset.v]) return;
			const r = RAIN_PRESETS[b.dataset.v];
			this.el.rain.value = Math.round(r.intensity * 100);
			this.el.rainVar.value = Math.round(r.variability * 100);
			emit();
		};
		emit();
	}

	setFog({ intensity, variability }, onChange) {
		const emit = () => {
			const p = {
				intensity: Number(this.el.fog.value) / 100,
				variability: Number(this.el.fogVar.value) / 100,
			};
			// A distance, not a percentage — same argument as the rain showing
			// mm/h. "250 m" is the only form of this number a pilot can fly by.
			const r = rangeFor(p.intensity);
			this.el.fogVal.textContent = p.intensity === 0 ? 'air clair'
				: r >= 1000 ? `${(r / 1000).toFixed(1).replace('.', ',')} km`
				: `${Math.round(r / 5) * 5} m`;
			this.el.fogVarVal.textContent = Math.round(p.variability * 100);
			// A preset lights up only when the whole bundle matches. The margin is
			// wider than the rain's because these intensities are solved back from
			// a visibility in metres and do not land on whole percent.
			for (const b of this.el.fogPresets.children) {
				const f = FOG_PRESETS[b.dataset.v];
				b.classList.toggle('on', !!f && Math.abs(f.intensity - p.intensity) < 0.006
					&& Math.abs(f.variability - p.variability) < 0.006);
			}
			try {
				localStorage.setItem(FOG_KEY, String(Math.round(p.intensity * 100)));
				localStorage.setItem(FOG_VAR_KEY, String(Math.round(p.variability * 100)));
			} catch { }
			onChange(p);
		};
		this.el.fog.value = Math.round(intensity * 100);
		this.el.fogVar.value = Math.round(variability * 100);
		this.el.fog.oninput = emit;
		this.el.fogVar.oninput = emit;
		this.el.fogPresets.onclick = (e) => {
			const b = e.target.closest('button');
			if (!b || !FOG_PRESETS[b.dataset.v]) return;
			const f = FOG_PRESETS[b.dataset.v];
			this.el.fog.value = Math.round(f.intensity * 100);
			this.el.fogVar.value = Math.round(f.variability * 100);
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

	setPaused(paused) {
		this.el.pause.hidden = !paused;
	}

	toggleSettings(force) {
		const show = force ?? this.el.settings.hidden;
		this.el.settings.hidden = !show;
		if (show) this.buildAxisRows();
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

	update({ altitude, speed, throttle, mode, preset, crashed, usingGamepad,
	         voltage, soc, amps, propwash, link, wind, heading }) {
		this.el.alt.textContent = altitude === null ? '–' : altitude.toFixed(0);
		this.el.spd.textContent = (speed * 3.6).toFixed(0);
		this.el.mode.textContent = mode.toUpperCase();
		if (preset) this.el.preset.textContent = preset;
		this.el.src.textContent = usingGamepad ? 'manette' : 'clavier';
		this.el.thr.style.height = `${throttle * 100}%`;
		this.el.crash.hidden = !crashed;

		if (voltage !== undefined) {
			this.el.volts.textContent = voltage.toFixed(1);
			this.el.amps.textContent = amps.toFixed(0);
			this.el.battFill.style.width = `${soc * 100}%`;
			// Per-cell voltage under load is what a pilot actually watches; 3.5 V
			// is where you land and 3.3 V is where you have damaged the pack.
			const cell = voltage / 4;
			this.el.batt.dataset.level = cell < 3.4 ? 'empty' : cell < 3.6 ? 'low' : 'ok';
		}
		// Without a readout, a picture falling apart reads as a rendering bug
		// rather than as the link telling you something. Real goggles show it as a
		// percentage, so this does too.
		// The wind, relative to where the nose is pointing. An absolute bearing
		// would be the honest number and the useless one: what a pilot needs to
		// know mid-line is whether the next thing to happen is a headwind or a
		// push from the left, and that is a question about the drone's frame.
		// Hidden entirely in calm air rather than showing a zero.
		if (wind && this.el.windHud) {
			const speedW = Math.hypot(wind.x, wind.z);
			this.el.windHud.hidden = speedW < 0.5;
			if (speedW >= 0.5) {
				// Bearing of where the wind is blowing TO, minus the nose.
				const rel = Math.atan2(wind.x, wind.z) - (heading ?? 0);
				const arrow = ARROWS[((Math.round((rel / (Math.PI * 2)) * 8) % 8) + 8) % 8];
				this.el.windHud.textContent = `VENT ${speedW.toFixed(0)} ${arrow}`;
				this.el.windHud.dataset.level = speedW > 12 ? 'empty' : speedW > 6 ? 'low' : 'ok';
			}
		}

		if (link && this.el.rssi) {
			const pct = Math.round(link.quality * 100);
			this.el.rssi.textContent = `RSSI ${pct} %`;
			this.el.rssi.dataset.level = pct < 25 ? 'empty' : pct < 55 ? 'low' : 'ok';
		}
		// Propwash is invisible on a still HUD, so the reticle shivers with it.
		if (propwash !== undefined && this.el.reticle) {
			this.el.reticle.style.opacity = propwash > 0.05 ? String(1 - 0.4 * propwash) : '1';
		}

		this._frames++;
		const now = performance.now();
		if (now - this._fpsAt > 500) {
			this.el.fps.textContent = `${Math.round(this._frames * 1000 / (now - this._fpsAt))} fps`;
			this._frames = 0;
			this._fpsAt = now;
		}
		this.updateAxisBars();
	}
}
