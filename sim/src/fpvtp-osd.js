// PHASE 12 — l'OSD FPVTP!, la couche locale. Injectée par notre station,
// au-dessus de l'image reçue : elle ne traverse pas la liaison, donc rien ne la
// dégrade. C'est la moitié stable du double HUD.
//
// Toujours métrique, même quand la cible affiche des pieds : c'est NOTRE
// station. Le désaccord entre les deux systèmes fait partie du propos.

// Constante de lore, pas une version de paquet.
export const FPVTP_VERSION = '0.97b';

// D'où le vent pousse, dans le repère du drone : l'index 0 est droit devant.
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

const clock = (s) => {
	const t = Math.max(0, Math.floor(s));
	return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export class FpvtpOsd {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
			<div id="fpvtp-osd" hidden>
				<div class="corner tl">
					<div id="fo-ident">FPVTP! // ${FPVTP_VERSION}</div>
					<div id="fo-operator">OPERATOR // —</div>
					<div id="fo-session">SESSION 00:00</div>
				</div>
				<div class="corner tr">
					<div id="fo-mode">ACRO</div>
					<div id="fo-rates">—</div>
					<div id="fo-input">KEYBOARD</div>
					<div id="fo-fps">—</div>
				</div>
				<div class="corner bl">
					<div id="fo-env">WIND — · VIS — · LINK —</div>
				</div>
				<div id="fo-pause" hidden>PAUSED<small>PRESS SPACE</small></div>
				<div id="fo-status" hidden></div>
				<div id="flight-end" hidden></div>
				<div id="fo-reticle"></div>
			</div>`);

		const q = (s) => root.querySelector(s);
		this.el = {
			root: q('#fpvtp-osd'),
			operator: q('#fo-operator'),
			session: q('#fo-session'),
			mode: q('#fo-mode'),
			rates: q('#fo-rates'),
			input: q('#fo-input'),
			fps: q('#fo-fps'),
			env: q('#fo-env'),
			pause: q('#fo-pause'),
			status: q('#fo-status'),
			flightEnd: q('#flight-end'),
			reticle: q('#fo-reticle'),
		};
		this._frames = 0;
		this._fpsAt = performance.now();
		this._fps = 0;
		this._endLines = '';
		// Les deux états centraux occupent la même place. Ils ne s'excluent pas
		// dans le monde — on peut être en pause sur un drone détruit — donc ils
		// sont tenus ici, et un seul est peint.
		this._paused = false;
		this._status = null;
	}

	show() { this.el.root.hidden = false; }
	setPaused(paused) { this._paused = !!paused; this._refreshCentre(); }

	// Verdict de fin de session (PHASE 06). kind: 'landed' | 'lost' | null.
	setSessionStatus(text, kind = null) {
		this._status = text ? { text, kind } : null;
		this._refreshCentre();
	}

	// Priorité explicite : verdict de session > pause. Un seul visible, sans
	// quoi les deux se superposent lettre sur lettre au même endroit.
	_refreshCentre() {
		const e = this.el.status;
		if (this._status) {
			e.innerHTML = this._status.text;
			if (this._status.kind) e.dataset.kind = this._status.kind;
			else delete e.dataset.kind;
		}
		e.hidden = !this._status;
		this.el.pause.hidden = !!this._status || !this._paused;
	}

	// L'écran de fin de vol (PHASE 14). Il n'annonce pas une défaite : il montre
	// un lien qui s'éteint. `blackout` est l'opacité du noir qui recouvre la
	// dernière image, `lines` ce qui s'écrit dessus, une ligne à la fois.
	// Repris tel quel de l'ancien hud.js — c'est la couche locale qui porte
	// cette mise en scène, elle ne traverse pas la liaison.
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

	get fps() { return this._fps; }

	update({ mode, rates, usingGamepad, windMs, windRelRad, visibilityM,
	         rssiDbm, operator, sessionSeconds, propwash }) {
		this.el.mode.textContent = String(mode).toUpperCase();
		if (rates) this.el.rates.textContent = rates;
		this.el.input.textContent = usingGamepad ? 'GAMEPAD' : 'KEYBOARD';
		this.el.operator.textContent = `OPERATOR // ${operator ?? '—'}`;
		this.el.session.textContent = `SESSION ${clock(sessionSeconds ?? 0)}`;

		// Une seule ligne d'environnement : trois nombres que l'opérateur lit
		// d'un coup, pas trois blocs qui se disputent un coin.
		const parts = [];
		if (Number.isFinite(windMs) && windMs >= 0.5) {
			const i = ((Math.round(((windRelRad ?? 0) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
			parts.push(`WIND ${windMs.toFixed(1)} m/s ${ARROWS[i]}`);
		} else {
			parts.push('WIND CALM');
		}
		if (Number.isFinite(visibilityM)) parts.push(`VIS ${(visibilityM / 1000).toFixed(1)} km`);
		if (Number.isFinite(rssiDbm)) parts.push(`LINK ${Math.round(rssiDbm)} dBm`);
		this.el.env.textContent = parts.join(' · ');

		// Le propwash est invisible sur un HUD immobile, donc le réticule
		// frissonne avec (repris tel quel de hud.js).
		if (propwash !== undefined) {
			this.el.reticle.style.opacity = propwash > 0.05 ? String(1 - 0.4 * propwash) : '1';
		}

		this._frames++;
		const now = performance.now();
		if (now - this._fpsAt > 500) {
			this._fps = Math.round(this._frames * 1000 / (now - this._fpsAt));
			this.el.fps.textContent = `${this._fps} fps`;
			this._frames = 0;
			this._fpsAt = now;
		}
	}
}
