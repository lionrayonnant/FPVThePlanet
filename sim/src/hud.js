import { CHANNELS } from './input.js';

const VOLUME_KEY = 'fpvmaps.audioVolume';
const BRIGHTNESS_KEY = 'fpvmaps.audioBrightness';
const LENS_KEY = 'fpvmaps.lens';
const VIGNETTE_KEY = 'fpvmaps.lensVignette';
const SHUTTER_KEY = 'fpvmaps.lensShutter';
const LENS_ON_KEY = 'fpvmaps.lensOn';

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

export class Hud {
	constructor(root, input) {
		this.input = input;
		root.innerHTML = `
			<div id="menu" hidden><div class="panel">
				<h2>Choisir une carte</h2>
				<div id="menu-list"></div>
			</div></div>

			<div id="loading" hidden><div class="box">
				<h1>FPV Paris</h1>
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
					<b>R</b> respawn · <b>M</b> mode · <b>P</b> rates · <b>C</b> caméra libre · <b>Tab</b> réglages
				</div>
				<div id="crash" hidden>CRASH<small>R pour repartir</small></div>
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
					<h2>Air</h2>
					<label>Vent <input id="wind" type="range" min="0" max="12" step="0.5"> <span id="wind-val"></span> m/s</label>
					<label>Rafales <input id="gust" type="range" min="0" max="6" step="0.5"> <span id="gust-val"></span> m/s</label>
					<h2>Son</h2>
					<label>Volume <input id="vol" type="range" min="0" max="100" step="1"> <span id="vol-val"></span> %</label>
					<label>Timbre <input id="tone" type="range" min="0" max="100" step="1"> <span id="tone-val"></span></label>
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
			gust: root.querySelector('#gust'),
			gustVal: root.querySelector('#gust-val'),
			vol: root.querySelector('#vol'),
			volVal: root.querySelector('#vol-val'),
			tone: root.querySelector('#tone'),
			toneVal: root.querySelector('#tone-val'),
			thr: root.querySelector('#thr-fill'),
			crash: root.querySelector('#crash'),
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
		};
		root.querySelector('#close-settings').onclick = () => this.toggleSettings(false);

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
			for (const el of [this.el.lens, this.el.vig, this.el.shut]) el.disabled = !enabled;
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

	// Wind is a single speed plus a gust amplitude; the direction is picked once,
	// at random, so it is not always a convenient tailwind down the same street.
	setWind(onChange) {
		const heading = Math.random() * Math.PI * 2;
		const emit = () => {
			const speed = Number(this.el.wind.value);
			const gust = Number(this.el.gust.value);
			this.el.windVal.textContent = speed.toFixed(1);
			this.el.gustVal.textContent = gust.toFixed(1);
			onChange({ x: Math.cos(heading) * speed, y: 0, z: Math.sin(heading) * speed }, gust);
		};
		this.el.wind.value = 0;
		this.el.gust.value = 0;
		this.el.wind.oninput = emit;
		this.el.gust.oninput = emit;
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
	         voltage, soc, amps, propwash }) {
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
