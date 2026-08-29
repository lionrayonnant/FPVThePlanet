// Flight OSD + loading screen. The map menu became the Operator Terminal
// (terminal.js) and the Tab panel moved to settings.js — this file is now the
// in-flight readout and the loading screen only. PHASE 12 splits the OSD into
// drone OSD / FPVTP! OSD; PHASE 13 moves the loading screen behind the TARGET
// SCAN.

// Where the wind is pushing you, in the drone's own frame: index 0 is straight
// ahead (world +Z at zero yaw, which is south — see the axis note in wind.js).
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

export class Hud {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
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
					<b>J</b> désarmer · <b>M</b> mode · <b>P</b> rates · <b>C</b> caméra libre · <b>Espace</b> pause · <b>Tab</b> réglages
				</div>
				<div id="flight-end" hidden></div>
					<div id="pause" hidden>PAUSE<small>Espace pour reprendre</small></div>
				<div id="session-status" hidden></div>
				<div id="reticle"></div>
			</div>`);

		this.el = {
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
			windHud: root.querySelector('#wind-hud'),
			thr: root.querySelector('#thr-fill'),
			flightEnd: root.querySelector('#flight-end'),
			pause: root.querySelector('#pause'),
			sessionStatus: root.querySelector('#session-status'),
			reticle: root.querySelector('#reticle'),
			rssi: root.querySelector('#rssi'),
		};

		this._frames = 0;
		this._fpsAt = performance.now();
		this._endLines = '';
	}

	progress(text, fraction) {
		this.el.status.textContent = text;
		if (fraction !== undefined) this.el.bar.style.width = `${Math.round(fraction * 100)}%`;
	}

	detail(text) {
		this.el.detail.textContent = text;
	}

	show() { this.el.loading.hidden = false; }

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

	setPaused(paused) {
		this.el.pause.hidden = !paused;
	}

	// Verdict de fin de session (PHASE 06). kind: 'landed' | 'lost' | null.
	setSessionStatus(text, kind = null) {
		const e = this.el.sessionStatus;
		if (!text) { e.hidden = true; return; }
		e.innerHTML = text;
		if (kind) e.dataset.kind = kind; else delete e.dataset.kind;
		e.hidden = false;
	}

	// L'écran de fin de vol (PHASE 14). Il n'annonce pas une défaite : il montre
	// un lien qui s'éteint. `blackout` est l'opacité du noir qui recouvre la
	// dernière image, `lines` ce qui s'écrit dessus, une ligne à la fois.
	setFlightEnd({ lines, blackout }) {
		const e = this.el.flightEnd;
		if (!lines.length && blackout <= 0) {
			if (!e.hidden) { e.hidden = true; e.textContent = ''; this._endLines = ''; }
			return;
		}
		e.hidden = false;
		e.style.background = `rgba(0, 0, 0, ${blackout})`;
		// Le DOM n'est reconstruit que quand le texte change : ceci tourne à la
		// fréquence d'affichage pendant toute la séquence.
		const key = lines.join('\n');
		if (key !== this._endLines) {
			this._endLines = key;
			e.replaceChildren(...lines.map((text) => {
				const d = document.createElement('div');
				d.textContent = text;
				return d;
			}));
		}
	}

	update({ altitude, speed, throttle, mode, preset, usingGamepad,
	         voltage, soc, amps, propwash, link, wind, heading }) {
		this.el.alt.textContent = altitude === null ? '–' : altitude.toFixed(0);
		this.el.spd.textContent = (speed * 3.6).toFixed(0);
		this.el.mode.textContent = mode.toUpperCase();
		if (preset) this.el.preset.textContent = preset;
		this.el.src.textContent = usingGamepad ? 'manette' : 'clavier';
		this.el.thr.style.height = `${throttle * 100}%`;

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
	}
}
