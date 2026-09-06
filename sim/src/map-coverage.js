// La couverture sur la carte (issue #245) : la colle Leaflet. Tout ce qui se
// calcule sans navigateur — quelles cellules, où, à quel rayon, à quel alpha —
// est dans src/coverage.js (planDraw) et vérifié là ; ici il ne reste qu'un
// canvas et le cycle de vie d'un calque.
//
// Les constantes d'alpha viennent de coverage.js : c'est planDraw qui décide
// de l'alpha, ce module ne fait que le lire comme curseur de teinte.
import { ALPHA_MIN, ALPHA_MAX } from './coverage.js';
//
// Un pane dédié, sous les vecteurs : la tache est un FOND, pas un objet qu'on
// désigne. overlayPane est à 400 et porte les cadres de zone (SVG) ; tilePane
// à 200. À 350 le canvas passe au-dessus des tuiles et sous les cadres, sans
// dépendre de l'ordre dans lequel Leaflet a créé son renderer SVG.
//
// `L` est reçu en paramètre et non importé : le module reste importable sous
// Node pour les bancs (Leaflet touche `window` au chargement).
const PANE = 'coverage';
const PANE_Z = 350;

// Le skin de la tache (issue #251) : magenta au cœur, cyan sur le halo,
// transparent au bord. Ce sont les deux couleurs réservées au rituel (tokens
// --magenta / --cyan) — choix assumé par l'auteur de la DA pour cette tache.
// Le mélange suit la densité de passage : `alpha` est ce que planDraw a
// décidé entre ALPHA_MIN et ALPHA_MAX, et sert aussi de curseur cyan → magenta
// au cœur. Un passage isolé reste surtout cyan ; une zone survolée souvent
// vire au magenta au centre ; en 'lighter', deux taches qui se recouvrent
// s'additionnent vers un violet clair, le troisième token de la famille.
const CORE_MIX_MIN = 0.35;   // part de magenta au cœur, passage isolé
const CORE_MIX_MAX = 1.0;    // …et à saturation (W_MAX)
const HALO_STOP = 0.55;      // où le cœur a fini de céder au cyan (fraction du rayon)
const HALO_ALPHA = 0.6;      // alpha du halo, en fraction de celui du cœur

export function mixHex(a, b, t) {
	const A = hexToRgbArray(a), B = hexToRgbArray(b);
	return A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(', ');
}

// Les arrêts du dégradé d'un disque : [[offset, 'rgba(...)'], …]. Pur, pour
// être vérifié en Node ; le dessinateur ne fait que les poser.
export function blobStops({ core, halo }, alpha) {
	const t = Math.max(0, Math.min(1, (alpha - ALPHA_MIN) / (ALPHA_MAX - ALPHA_MIN)));
	const mix = CORE_MIX_MIN + (CORE_MIX_MAX - CORE_MIX_MIN) * t;
	const haloRgb = mixHex(halo, halo, 0);
	return [
		[0, `rgba(${mixHex(halo, core, mix)}, ${alpha})`],
		[HALO_STOP, `rgba(${haloRgb}, ${alpha * HALO_ALPHA})`],
		[1, `rgba(${haloRgb}, 0)`],
	];
}

export function createCoverageLayer(L, { getCoverage, colors = { core: '#e34de0', halo: '#4dd8e8' }, planDraw }) {

	const Layer = L.Layer.extend({
		onAdd(map) {
			this._map = map;
			if (!map.getPane(PANE)) {
				map.createPane(PANE).style.zIndex = String(PANE_Z);
			}
			const canvas = L.DomUtil.create('canvas', 'map-coverage leaflet-zoom-hide', map.getPane(PANE));
			this._canvas = canvas;
			this._ctx = canvas.getContext('2d');
			map.on('moveend zoomend viewreset resize', this._redraw, this);
			this._redraw();
		},

		onRemove(map) {
			map.off('moveend zoomend viewreset resize', this._redraw, this);
			L.DomUtil.remove(this._canvas);
			this._canvas = null;
			this._ctx = null;
			this._map = null;
		},

		// Relit la couverture (celle de l'opérateur peut avoir changé après un
		// vol) et redessine. Inoffensif hors carte.
		refresh() { if (this._map) this._redraw(); },

		_redraw() {
			const map = this._map, canvas = this._canvas, ctx = this._ctx;
			if (!map || !canvas) return;
			const size = map.getSize();
			// Le canvas suit la taille du conteneur et se repositionne sur le
			// coin haut-gauche du conteneur dans le repère du calque : c'est ce
			// qui le garde en place pendant un déplacement de carte.
			const dpr = window.devicePixelRatio || 1;
			// Arrondis AVANT de comparer : `canvas.width` tronque à l'entier, donc
			// à DPR fractionnaire (le dépôt en a mesuré 0,9) `811 × 0,9 = 729,9`
			// ne vaudrait jamais 729 et le tampon serait réalloué à chaque
			// moveend, avec une bande sous-pixel au bord.
			const bw = Math.round(size.x * dpr), bh = Math.round(size.y * dpr);
			if (canvas.width !== bw || canvas.height !== bh) {
				canvas.width = bw;
				canvas.height = bh;
				canvas.style.width = `${size.x}px`;
				canvas.style.height = `${size.y}px`;
			}
			L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, size.x, size.y);

			const cov = getCoverage();
			if (!cov || cov.size === 0) return;
			const project = (lat, lon) => {
				const p = map.latLngToContainerPoint([lat, lon]);
				return { x: p.x, y: p.y };
			};
			const plan = planDraw(cov, project, { w: size.x, h: size.y });

			// 'lighter' additionne : deux dégradés qui se recouvrent font une
			// zone plus dense, et c'est exactement « plus tu repasses, plus c'est
			// dense ». Le rayon minimal de 1,5 px garde un point visible au zoom
			// monde, où une cellule est sous-pixel.
			ctx.globalCompositeOperation = 'lighter';
			for (const { cx, cy, r, alpha } of plan) {
				const rr = Math.max(1.5, r);
				const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
				for (const [offset, rgba] of blobStops(colors, alpha)) g.addColorStop(offset, rgba);
				ctx.fillStyle = g;
				ctx.beginPath();
				ctx.arc(cx, cy, rr, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalCompositeOperation = 'source-over';
		},
	});

	return new Layer();
}

// '#ece7dd' → [236, 231, 221]. Les tokens du dépôt sont en hex 6 chiffres.
function hexToRgbArray(hex) {
	const h = hex.replace('#', '');
	const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
