// Les nuages, comme modèle : quelle fraction du ciel est couverte en ce moment,
// à quelle hauteur commence la couche, de combien le sol s'assombrit, et ce
// qu'on n'y voit plus une fois dedans.
//
// Pas de THREE et pas de DOM ici, même règle et même raison que wind.js,
// rain.js et fog.js : c'est la moitié que tools/selftest.mjs peut vérifier.
// sky.js fait le dôme et les nuages qu'on voit, TileMaterial.js applique
// l'assombrissement, main.js ajoute l'extinction aux autres et câble le tout.
//
// Ce fichier ne décide pas du temps qu'il fait : la couverture vient de
// cloudPct, que le monde produit (#41). Il ne fait que la rendre vivante.

import { Ou, mulberry32 } from './wind.js';
import { fogDensity } from './rain.js';

// Les altitudes de base viennent des classes observées, pas de positions
// rondes : cumulus de beau temps 600-1200 m, stratocumulus 300-900 m, stratus
// bouché 100-300 m. Ce sont les deux bouts de cette plage.
export const BASE_CLEAR = 1500;      // m AGL, ciel clair — hors d'atteinte, et c'est le but
export const BASE_OVERCAST = 120;    // m AGL, couvert plein — atteignable, et c'est le but

// Profondeur de la couche. Un stratocumulus fait 250 à 600 m d'épaisseur ; on
// prend le bas de la fourchette, parce que c'est ce qui rend la traversée
// possible dans un vol de quelques minutes plutôt que théorique.
export const DECK_THICKNESS = 250;   // m
// Sur quelle épaisseur la laiteuse monte avant la base, et redescend après le
// sommet. Un vrai bord de nuage est net à quelques dizaines de mètres près.
const EDGE = 60;                     // m
// Ce qu'on voit à l'intérieur d'un nuage. RANGE_MIN vaut 30 m dans fog.js et
// s'appelle « purée de pois » ; dedans c'est un peu pire.
export const DECK_RANGE = 25;        // m

// Mesuré, pas choisi. La radiométrie dit qu'un ciel couvert laisse passer 15 à
// 30 % de l'éclairement du ciel clair ; l'appliquer casserait l'image, parce
// que la photogrammétrie est cuite avec un éclairage ensoleillé, qu'on ne peut
// pas la ré-éclairer, et qu'on vole *à* cette texture. La contrainte n'est donc
// pas l'éclairement mais la lisibilité.
//
// Mesuré en vol, caméra figée, sur tour-eiffel — luminance moyenne du sol et
// contraste local (écart-type) en fonction du facteur :
//
//   1.00 -> lum 106.8, contraste 33.3      0.58 -> lum 69.7, contraste 25.0
//   0.72 -> lum  81.5, contraste 26.6      0.45 -> lum 57.6, contraste 23.6
//
// La perte de contraste est concentrée sur le premier palier (-20 % de 1.00 à
// 0.72, puis seulement -11 % jusqu'à 0.45) : assombrir coûte de moins en moins
// cher. À 0.45 les obstacles restent distinguables sur tour-eiffel comme sur
// notre-dame-de-la-croix, donc 0.55 garde de la marge sans être timide — à 0.72
// un ciel couvert ne se lisait pas comme couvert.
export const DIM_MAX = 0.55;

// Une couverture évolue sur des dizaines de minutes, pas sur des secondes.
// fog.js utilise 120 / 25 s pour une nappe ; une couche nuageuse est bien plus
// lente. Un vol dure quelques minutes, donc on en voit une fraction de cycle :
// ça évolue, ça ne clignote pas.
const TAU_SLOW = 600, TAU_FAST = 150;
const BAND_MIX = 0.7;    // poids de la bande lente ; les deux sont renormalisées plus bas
// Même argument lognormal que rain.js et fog.js : exp(k·n − k²/2) a une moyenne
// unité pour un n de variance unité, donc monter la variabilité fait aller et
// venir la couverture sans monter sa moyenne en douce.
const VAR_GAIN = 0.5;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};

// L'altitude de base qu'une couverture demande. Fonction libre parce que
// selftest et le HUD doivent pouvoir l'interroger sans instancier de champ —
// même motif que rangeFor() dans fog.js.
//
// Géométrique, pour la même raison que la portée du brouillard l'est : c'est la
// seule échelle sur laquelle « un peu plus bas » veut dire la même chose en
// haut et en bas de la plage. La courbe est ancrée sur ses deux bouts et passe
// dans les fourchettes observées sur l'essentiel de leur étendue ; elle court un
// peu bas dans le haut du domaine stratocumulus, ce qui penche du côté d'un
// plafond atteignable. Ce biais est voulu : un plafond que personne n'atteint
// jamais est un plafond que personne ne voit.
export function baseFor(cover) {
	return BASE_CLEAR * Math.pow(BASE_OVERCAST / BASE_CLEAR, clamp01(cover));
}

export class CloudField {
	constructor(seed = 0xc10d) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);

		this.meanCover = 0;      // 0..1, ce que le monde a annoncé pour la journée
		this.variability = 0;    // 0..1, à quel point ça respire

		this._slow = new Ou(this.rng);
		this._fast = new Ou(this.rng);

		// Lus chaque frame par main.js et sky.js.
		this.cover = 0;                 // 0..1, la couverture de cette frame
		this.base = BASE_CLEAR;         // m AGL
		this.dim = 1;                   // 1 = pas d'assombrissement
		this.reset();
	}

	// Un respawn ne doit pas retomber au milieu du grain qui venait de passer.
	// Déterministe, pour que les checks headless soient stables et pas seulement
	// plausibles.
	reset() {
		this.rng = mulberry32(this.seed);
		this._slow.rng = this.rng;
		this._fast.rng = this.rng;
		this._slow.reset();
		this._fast.reset();
		this.cover = this.active ? this.meanCover : 0;
		this.base = baseFor(this.cover);
		this.dim = this.active ? 1 - (1 - DIM_MAX) * this.cover : 1;
		return this;
	}

	// cover 0..1 (0 est un ciel parfaitement dégagé), variability 0..1.
	setParams({ cover, variability } = {}) {
		if (cover !== undefined) this.meanCover = clamp01(cover);
		if (variability !== undefined) this.variability = clamp01(variability);
		return this;
	}

	// Rien de posé, rien qui tourne : aucun filtre avancé, aucun nombre tiré,
	// et le sol exactement à la luminosité où la scène l'a chargé. Un ciel clair
	// doit être bit-identique à l'absence de modèle de nuages — c'est la
	// promesse que wind.js fait au calme et fog.js à l'air clair (D5).
	get active() { return this.meanCover > 0; }

	update(dt) {
		if (!this.active) {
			this.cover = 0;
			this.base = BASE_CLEAR;
			this.dim = 1;
			return this;
		}

		// Deux bandes, renormalisées à variance unité pour que `variability`
		// veuille dire la même chose quelle que soit celle qui domine.
		const n = (BAND_MIX * this._slow.next(dt, TAU_SLOW)
			+ (1 - BAND_MIX) * this._fast.next(dt, TAU_FAST))
			/ Math.sqrt(BAND_MIX * BAND_MIX + (1 - BAND_MIX) * (1 - BAND_MIX));
		const k = VAR_GAIN * this.variability;

		// Une couverture est une fraction : elle est bornée à 1, et le clamp
		// mord donc près du couvert plein. Ce n'est pas un défaut du modèle,
		// c'est de l'atmosphère : on n'est pas « plus que couvert ».
		this.cover = clamp01(this.meanCover * Math.exp(k * n - 0.5 * k * k));
		this.base = baseFor(this.cover);
		// D0 : un scalaire, aucun motif. Et il respire avec la couverture, ce
		// qui est ce que « soleil masqué temporairement » veut dire quand il n'y
		// a pas encore de soleil (#23).
		this.dim = 1 - (1 - DIM_MAX) * this.cover;
		return this;
	}

	// Le whiteout, dans les unités du shader de tuile — parce que les
	// extinctions s'additionnent, ce qui est déjà l'argument par lequel main.js
	// ajoute la pluie au brouillard. Exactement 0 loin sous la base, monte en
	// approche, sature dans la couche, et retombe à 0 au-dessus : on perce
	// l'overcast et on débouche dessus (D1).
	extinctionAt(altitudeAGL) {
		if (!this.active) return 0;
		const h = altitudeAGL - this.base;      // signé : négatif sous la base
		if (h < -EDGE || h > DECK_THICKNESS + EDGE) return 0;
		const rise = smoothstep(-EDGE, EDGE, h);
		const fall = 1 - smoothstep(DECK_THICKNESS - EDGE, DECK_THICKNESS + EDGE, h);
		// Proportionnel à la couverture, pas un seuil binaire : à 0,3 c'est une
		// laiteuse en approche, à 0,95 c'est un vrai whiteout.
		return fogDensity(DECK_RANGE) * this.cover * rise * fall;
	}
}
