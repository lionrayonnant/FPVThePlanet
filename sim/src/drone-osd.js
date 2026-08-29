// PHASE 12 — l'OSD de la cible, peint dans un canvas 2D dont la texture est
// échantillonnée par le pass unique de lens.js, en amont du vignettage, du
// capteur et de la liaison. Il traverse donc tout ce que l'image traverse.
//
// Deux responsabilités séparées, et la séparation est load-bearing :
//   update()  accumule ce qu'il y aurait à afficher, ne dessine rien ;
//   commit()  redessine, et seulement si la chaîne affichée a changé.
// C'est lens.js qui décide quand commit() a le droit de tourner — voir le gel
// numérique dans son render().

import * as THREE from 'three';

// La taille d'une cellule de la grille, en pixels de canvas. Le canvas est
// dimensionné à la GRILLE de la cible et pas à la fenêtre : une incrustation
// vidéo est à résolution fixe. C'est aussi ce qui fait qu'un OSD 30×16 est
// énorme et qu'un 50×18 est fin, sans qu'aucun code n'ait à le dire.
const CELL_W = 24;
const CELL_H = 34;

const FONT_STACK = '"DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
const FONT_SCALE = { DEFAULT: 1.0, BOLD: 1.0, LARGE: 1.18, CLARITY: 0.92 };
const FONT_WEIGHT = { DEFAULT: 500, BOLD: 800, LARGE: 700, CLARITY: 600 };

const M_TO_FT = 3.28084;
const MS_TO_KMH = 3.6;
const MS_TO_MPH = 2.23694;

const pad = (n, w) => String(n).padStart(w, ' ');
// Un tiret plutôt qu'un zéro : un MAH à 0 ressemble à une batterie neuve, un
// HOME_DIST à 0m ressemble à "je suis chez moi". Une donnée absente doit se
// voir comme absente, jamais comme une valeur plausible.
const dash = (unit) => `--${unit}`;

export class DroneOsd {
	constructor(layout) {
		this.layout = layout;
		this.canvas = document.createElement('canvas');
		this.canvas.width = layout.grid.cols * CELL_W;
		this.canvas.height = layout.grid.rows * CELL_H;
		this.ctx = this.canvas.getContext('2d');

		this.texture = new THREE.CanvasTexture(this.canvas);
		this.texture.minFilter = THREE.LinearFilter;
		this.texture.magFilter = THREE.LinearFilter;
		this.texture.generateMipmaps = false;
		// Le canvas est déjà en sRGB non prémultiplié ; le pipeline couleur du
		// jeu est délibérément pass-through (lens.js, HANDOFF bug #10), donc
		// rien ne doit ré-encoder ici.
		this.texture.colorSpace = THREE.NoColorSpace;

		this._values = {};
		this._painted = null;
	}

	get style() { return this.layout.style; }

	update(values) { this._values = values; }

	// Redessine si et seulement si la chaîne affichée a changé. Les valeurs sont
	// arrondies à l'affichage, donc c'est quelques repeints par seconde et pas
	// soixante.
	commit() {
		const lines = this.layout.elements.map((e) => `${e.key}:${this._text(e.key)}`).join('|');
		if (lines === this._painted) return;
		this._painted = lines;
		this._paint();
		this.texture.needsUpdate = true;
	}

	dispose() { this.texture.dispose(); }

	_text(key) {
		const v = this._values;
		const imperial = this.layout.units === 'IMPERIAL';
		const dec = this.layout.style === 'DIGITAL' ? 1 : 0;
		const n = (x, d = dec) => (Number.isFinite(x) ? x.toFixed(d) : '--');

		switch (key) {
			case 'BAT_V': return `${n(v.voltageV, 1)}V`;
			case 'CELL_V': return `${n(v.cellV, 2)}V`;
			case 'CURRENT': return `${n(v.currentA, dec)}A`;
			case 'MAH': return Number.isFinite(v.mahUsed)
				? `${pad(Math.round(v.mahUsed), 4)}mAh`
				: `${pad('--', 4)}mAh`;
			case 'ALT': {
				if (!Number.isFinite(v.agiM)) return imperial ? dash('F') : dash('m');
				return imperial ? `${Math.round(v.agiM * M_TO_FT)}F` : `${n(v.agiM, dec)}m`;
			}
			case 'ALT_HOME': {
				if (!Number.isFinite(v.altM)) return imperial ? dash('F') : dash('m');
				return imperial ? `${Math.round(v.altM * M_TO_FT)}F` : `${n(v.altM, dec)}m`;
			}
			case 'GS': {
				if (!Number.isFinite(v.groundSpeedMs)) return imperial ? dash('MPH') : dash('KMH');
				return imperial
					? `${Math.round(v.groundSpeedMs * MS_TO_MPH)}MPH`
					: `${Math.round(v.groundSpeedMs * MS_TO_KMH)}KMH`;
			}
			case 'VS': {
				if (!Number.isFinite(v.verticalSpeedMs)) return imperial ? dash('F/S') : dash('M/S');
				return imperial ? `${n(v.verticalSpeedMs * M_TO_FT, 0)}F/S` : `${n(v.verticalSpeedMs, 1)}M/S`;
			}
			case 'THR': return Number.isFinite(v.throttle01) ? `${Math.round(v.throttle01 * 100)}%` : '--%';
			case 'RSSI': return Number.isFinite(v.rssiDbm) ? `${Math.round(v.rssiDbm)}dBm` : dash('dBm');
			case 'LQ': return Number.isFinite(v.linkQuality) ? `LQ${Math.round(v.linkQuality * 100)}` : 'LQ--';
			// Puissance d'émission et canal VTX : réglages de la machine, pas de la
			// télémétrie — un repli par défaut est une vraie config plausible, pas
			// un mensonge sur une donnée absente.
			case 'TX_POWER': return `${v.txPowerMw ?? 25}mW`;
			case 'SATS': return Number.isFinite(v.sats) ? `S${pad(v.sats, 2)}` : 'S--';
			case 'LATLON': return (Number.isFinite(v.lat) && Number.isFinite(v.lon))
				? `${v.lat.toFixed(4)} ${v.lon.toFixed(4)}`
				: '-- --';
			case 'HOME_DIST': {
				if (!Number.isFinite(v.homeDistM)) return imperial ? dash('F') : dash('m');
				return imperial ? `${Math.round(v.homeDistM * M_TO_FT)}F` : `${Math.round(v.homeDistM)}m`;
			}
			case 'HOME_ARROW': return Number.isFinite(v.homeBearingRad)
				? ARROWS[dirIndex(v.homeBearingRad, v.headingRad)]
				: '--';
			case 'TIMER_FLIGHT':
			case 'TIMER_ON': return clock(v.flightSeconds ?? 0);
			case 'ESC_TEMP': return Number.isFinite(v.escTempC) ? `${Math.round(v.escTempC)}C` : dash('C');
			case 'EFFICIENCY': return effText(v);
			case 'VTX_CHAN': return `F${v.vtxChan ?? 4}`;
			case 'CRAFT_NAME': return this.layout.craftName ?? '';
			case 'WARNINGS': return v.warning ?? '';
			// Éléments graphiques : rien à comparer, ils sont redessinés avec le
			// reste dès qu'un chiffre bouge.
			case 'HORIZON': return `${Math.round((v.rollRad ?? 0) * 30)}/${Math.round((v.pitchRad ?? 0) * 30)}`;
			case 'HEADING_TAPE': return String(Math.round(((v.headingRad ?? 0) * 180 / Math.PI + 360) % 360));
			case 'CROSSHAIR': return '';
			default: return '';
		}
	}

	_paint() {
		const { ctx, layout } = this;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		const scale = FONT_SCALE[layout.font] ?? 1;
		ctx.font = `${FONT_WEIGHT[layout.font] ?? 500} ${Math.round(CELL_H * 0.72 * scale)}px ${FONT_STACK}`;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';

		// Blanc bordé de noir : c'est ce que fait un MAX7456, et c'est la seule
		// façon de rester lisible sur un ciel blanc comme sur du bitume.
		ctx.lineJoin = 'round';
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
		ctx.lineWidth = layout.style === 'ANALOG' ? 5 : 3;
		ctx.fillStyle = '#fff';

		for (const e of layout.elements) {
			const x = e.col * CELL_W;
			const y = e.row * CELL_H + CELL_H * 0.5;
			if (e.key === 'CROSSHAIR') { this._crosshair(x, y); continue; }
			if (e.key === 'HORIZON') { this._horizon(); continue; }
			const text = this._text(e.key);
			if (!text) continue;
			ctx.strokeText(text, x, y);
			ctx.fillText(text, x, y);
		}
	}

	_crosshair(x, y) {
		const { ctx } = this;
		ctx.save();
		ctx.lineWidth = 3;
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		ctx.beginPath();
		ctx.moveTo(x, y); ctx.lineTo(x + CELL_W * 3, y);
		ctx.stroke();
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.restore();
	}

	// L'horizon artificiel : deux traits qui basculent avec le roulis et
	// glissent avec le tangage, au centre de l'image. Il n'a pas de place dans
	// la grille — comme sur du vrai matériel, il est posé par-dessus.
	_horizon() {
		const { ctx } = this;
		const v = this._values;
		const cx = this.canvas.width * 0.5;
		const cy = this.canvas.height * 0.5 + (v.pitchRad ?? 0) * this.canvas.height * 0.5;
		const half = this.canvas.width * 0.22;
		const dy = Math.tan(v.rollRad ?? 0) * half;
		ctx.save();
		ctx.lineWidth = 5;
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		for (const s of [-1, 1]) {
			ctx.beginPath();
			ctx.moveTo(cx + s * half * 0.35, cy + s * dy * 0.35);
			ctx.lineTo(cx + s * half, cy + s * dy);
			ctx.stroke();
		}
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 2;
		for (const s of [-1, 1]) {
			ctx.beginPath();
			ctx.moveTo(cx + s * half * 0.35, cy + s * dy * 0.35);
			ctx.lineTo(cx + s * half, cy + s * dy);
			ctx.stroke();
		}
		ctx.restore();
	}
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

function dirIndex(bearingRad, headingRad) {
	const rel = (bearingRad ?? 0) - (headingRad ?? 0);
	return ((Math.round((rel / (Math.PI * 2)) * 8) % 8) + 8) % 8;
}

function clock(seconds) {
	const s = Math.max(0, Math.floor(seconds));
	return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function effText(v) {
	if (!Number.isFinite(v.homeDistM) || !Number.isFinite(v.mahUsed)) return '--mAh/km';
	const km = v.homeDistM / 1000;
	if (km < 0.01) return '---';
	return `${Math.round(v.mahUsed / km)}mAh/km`;
}
