import { CHANNELS } from './input.js';

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
					<div id="src">clavier</div>
					<div id="fps">–</div>
				</div>
				<div class="corner bl">
					<div class="throttle"><div id="thr-fill"></div></div>
					<div class="label">gaz</div>
				</div>
				<div class="corner br" id="help">
					<b>W/S</b> gaz · <b>A/D</b> lacet · <b>flèches</b>/souris roulis-tangage<br>
					<b>R</b> respawn · <b>M</b> mode · <b>C</b> caméra libre · <b>Tab</b> réglages
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
			thr: root.querySelector('#thr-fill'),
			crash: root.querySelector('#crash'),
			settings: root.querySelector('#settings'),
			padName: root.querySelector('#pad-name'),
			padMap: root.querySelector('#pad-map'),
			fov: root.querySelector('#fov'),
			fovVal: root.querySelector('#fov-val'),
			tilt: root.querySelector('#tilt'),
			tiltVal: root.querySelector('#tilt-val'),
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

	update({ altitude, speed, throttle, mode, crashed, usingGamepad }) {
		this.el.alt.textContent = altitude === null ? '–' : altitude.toFixed(0);
		this.el.spd.textContent = (speed * 3.6).toFixed(0);
		this.el.mode.textContent = mode.toUpperCase();
		this.el.src.textContent = usingGamepad ? 'manette' : 'clavier';
		this.el.thr.style.height = `${throttle * 100}%`;
		this.el.crash.hidden = !crashed;

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
