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
//
// ANALOG utilise une cellule bien plus petite ET un échantillonnage au plus
// proche (voir le constructeur) : un vrai MAX7456 pose des glyphes de
// quelques pixels de large, pas du texte anti-aliasé plein cadre. C'est ce
// qui donne le côté "chunky" d'un analogique face au numérique, net.
const CELL_SIZE = {
	ANALOG: { w: 9, h: 13 },
	DIGITAL: { w: 24, h: 34 },
};

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

// Éléments purement graphiques : pas de texte à comparer/figer/corrompre, ils
// sont redessinés avec le reste dès qu'un chiffre bouge.
const GRAPHIC_KEYS = new Set(['HORIZON', 'CROSSHAIR', 'BATT_BAR', 'THR_BAR']);

// Cadence maximale de repeinture d'un OSD analogique : un MAX7456 réel
// rafraîchit autour de 10 Hz, pas à la cadence de rendu. Le numérique n'a pas
// ce plafond — voir commit().
const ANALOG_REPAINT_MS = 100;
// Période du clignotement d'alerte (batterie basse / RXLOSS), comme un vrai
// OSD Betaflight.
const BLINK_PERIOD_MS = 500;

export class DroneOsd {
	constructor(layout) {
		this.layout = layout;
		const cell = CELL_SIZE[layout.style] ?? CELL_SIZE.ANALOG;
		this.cellW = cell.w;
		this.cellH = cell.h;
		this.canvas = document.createElement('canvas');
		this.canvas.width = layout.grid.cols * this.cellW;
		this.canvas.height = layout.grid.rows * this.cellH;
		this.ctx = this.canvas.getContext('2d');

		this.texture = new THREE.CanvasTexture(this.canvas);
		// L'analogique reste en filtrage au plus proche : c'est l'échantillonnage
		// qui garde les texels bruts d'un canvas minuscule bien blocs, comme un
		// vrai MAX7456. Le numérique, lui, reste lissé — c'est un OSD HD net.
		const filter = layout.style === 'ANALOG' ? THREE.NearestFilter : THREE.LinearFilter;
		this.texture.minFilter = filter;
		this.texture.magFilter = filter;
		this.texture.generateMipmaps = false;
		// Le canvas est déjà en sRGB non prémultiplié ; le pipeline couleur du
		// jeu est délibérément pass-through (lens.js, HANDOFF bug #10), donc
		// rien ne doit ré-encoder ici.
		this.texture.colorSpace = THREE.NoColorSpace;

		this._values = {};
		this._painted = null;
		this._lastPaintAt = 0;
		this._frozenText = null; // valeur figée par la panne FROZEN, capturée au premier commit
	}

	get style() { return this.layout.style; }

	update(values) { this._values = values; }

	// Redessine si et seulement si la chaîne affichée a changé (et, en
	// analogique, pas plus vite que le plafond de rafraîchissement matériel).
	commit() {
		const now = performance.now();
		const warning = this._values.warning;
		const blinkOn = !warning || Math.floor(now / BLINK_PERIOD_MS) % 2 === 0;

		let lines = this.layout.elements.map((e) => `${e.key}:${this._text(e.key)}`).join('|');
		if (warning) lines += `|blink:${blinkOn}`;
		if (lines === this._painted) return;

		if (this.layout.style === 'ANALOG' && now - this._lastPaintAt < ANALOG_REPAINT_MS) return;

		this._painted = lines;
		this._lastPaintAt = now;
		this._blinkOn = blinkOn;
		this._paint();
		this.texture.needsUpdate = true;
	}

	dispose() { this.texture.dispose(); }

	_text(key) {
		// La panne FROZEN : un capteur mort reste sur sa première lecture pour
		// tout le vol (si c'est un chronomètre, il ne repart jamais à zéro —
		// même symptôme, même cause matérielle).
		if (key === this.layout.frozenKey) {
			if (this._frozenText === null) this._frozenText = this._rawText(key);
			return this._frozenText;
		}
		const raw = this._rawText(key);
		// La panne GLITCH : une ROM de police morte affiche des blocs à la place
		// des caractères, jamais l'absence pure et simple de l'élément.
		if (key === this.layout.glitchKey) return raw.replace(/\S/g, '▯');
		return raw;
	}

	_rawText(key) {
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
			case 'HORIZON': return `${Math.round((v.rollRad ?? 0) * 30)}/${Math.round((v.pitchRad ?? 0) * 30)}`;
			case 'HEADING_TAPE': return String(Math.round(((v.headingRad ?? 0) * 180 / Math.PI + 360) % 360));
			case 'CROSSHAIR': return '';
			case 'BATT_BAR': return Number.isFinite(v.socPercent) ? `${Math.round(v.socPercent)}` : '--';
			case 'THR_BAR': return Number.isFinite(v.throttle01) ? `${Math.round(v.throttle01 * 100)}` : '--';
			default: return '';
		}
	}

	// L'OSD entier peut être décalé de quelques cellules (panne OFFSET) : une
	// incrustation mal calée déborde du cadre plutôt que de rester centrée.
	_ox(x) { return x + (this.layout.offsetCols ?? 0) * this.cellW; }
	_oy(y) { return y + (this.layout.offsetRows ?? 0) * this.cellH; }

	_paint() {
		const { ctx, layout } = this;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		const scale = FONT_SCALE[layout.font] ?? 1;
		ctx.font = `${FONT_WEIGHT[layout.font] ?? 500} ${Math.round(this.cellH * 0.72 * scale)}px ${FONT_STACK}`;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.lineJoin = 'round';

		const tint = layout.tint ?? '#fff';
		const panel = layout.panel ?? 'OUTLINE';

		for (const e of layout.elements) {
			const x = this._ox(e.col * this.cellW);
			const y = this._oy(e.row * this.cellH + this.cellH * 0.5);
			if (e.key === 'CROSSHAIR') { this._crosshair(x, y); continue; }
			if (e.key === 'HORIZON') { this._horizon(); continue; }
			if (e.key === 'BATT_BAR') { this._bar(x, y, this._values.socPercent, '#39ff14'); continue; }
			if (e.key === 'THR_BAR') { this._bar(x, y, (this._values.throttle01 ?? 0) * 100, '#00e5ff'); continue; }

			const text = this._text(e.key);
			if (!text) continue;
			if (e.key === 'WARNINGS' && !this._blinkOn) continue;
			this._drawText(x, y, text, tint, panel);
		}
	}

	_drawText(x, y, text, tint, panel) {
		const { ctx } = this;
		const w = ctx.measureText(text).width;
		const padX = this.cellW * 0.3;
		const bandH = this.cellH * 0.86;

		if (panel === 'BOX') {
			ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
			ctx.fillRect(x - padX, y - bandH / 2, w + padX * 2, bandH);
			ctx.fillStyle = tint;
			ctx.fillText(text, x, y);
		} else if (panel === 'INVERT') {
			ctx.fillStyle = 'rgba(235, 235, 235, 0.9)';
			ctx.fillRect(x - padX, y - bandH / 2, w + padX * 2, bandH);
			ctx.fillStyle = '#111';
			ctx.fillText(text, x, y);
		} else {
			// OUTLINE : blanc (ou la teinte numérique) bordé de noir, comme un vrai
			// MAX7456 — la seule façon de rester lisible sur un ciel blanc comme
			// sur du bitume.
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
			ctx.lineWidth = this.layout.style === 'ANALOG' ? 3 : 3;
			ctx.strokeText(text, x, y);
			ctx.fillStyle = tint;
			ctx.fillText(text, x, y);
		}
	}

	_crosshair(x, y) {
		const { ctx } = this;
		ctx.save();
		ctx.lineWidth = 3;
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		ctx.beginPath();
		ctx.moveTo(x, y); ctx.lineTo(x + this.cellW * 3, y);
		ctx.stroke();
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.restore();
	}

	// Jauge graphique (batterie / gaz) : un cadre et un remplissage
	// proportionnel, posés sur la grille comme HORIZON/CROSSHAIR.
	_bar(x, y, pct01to100, fillColor) {
		const { ctx } = this;
		const w = this.cellW * 7;
		const h = this.cellH * 0.5;
		const top = y - h / 2;
		const p = Number.isFinite(pct01to100) ? Math.max(0, Math.min(100, pct01to100)) / 100 : 0;
		ctx.save();
		ctx.strokeStyle = 'rgba(0,0,0,0.85)';
		ctx.lineWidth = 3;
		ctx.strokeRect(x, top, w, h);
		ctx.fillStyle = '#000';
		ctx.globalAlpha = 0.35;
		ctx.fillRect(x, top, w, h);
		ctx.globalAlpha = 1;
		ctx.fillStyle = fillColor;
		ctx.fillRect(x, top, w * p, h);
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1;
		ctx.strokeRect(x, top, w, h);
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
