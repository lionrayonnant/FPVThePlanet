// Acoustique du lieu (issue #122, audio spatial). Le modèle — ce que la
// géométrie veut dire — vit dans tools/space-model.mjs ; ici il n'y a que du
// Web Audio.
//
// Pourquoi un réseau de retards et pas un ConvolverNode : la réponse
// impulsionnelle d'un convolver est un buffer figé. Or ce qui doit changer ici
// change EN CONTINU pendant le vol — le pré-delay à chaque mètre parcouru, la
// durée avec la taille du lieu. Il faudrait fabriquer et échanger un buffer par
// frame, ce que la discipline du dépôt interdit (aucun nœud créé après le
// démarrage) et ce qui claquerait à chaque échange. Un réseau de retards se
// pilote entièrement par AudioParams.
//
//   entrée → preDelay ─┬→ retard₁ ⟲ (lowpass × feedback) ─┐
//                      ├→ retard₂ ⟲ …                     ├→ wet → sortie
//                      ├→ retard₃ ⟲ …                     │
//                      └→ retard₄ ⟲ …                     ┘
//
// Quinze nœuds, construits une fois. update() ne fait que viser des
// AudioParams : `nodesCreated` doit rester immobile pendant tout un vol.

import { acoustics, reverbParams } from '../tools/space-model.mjs';

// Longueurs des quatre lignes, en secondes. Volontairement non commensurables :
// des retards en rapport simple font sonner le réseau comme une hauteur plutôt
// que comme un lieu. Échelle de petite salle — ce sont les PREMIÈRES réflexions
// qui portent la sensation de proximité, pas une longue queue.
const TAPS = [0.0197, 0.0289, 0.0353, 0.0431];

// Marge de stabilité du bouclage. Au-delà, le réseau entre en oscillation.
const MAX_FEEDBACK = 0.92;

// Lissage. Assez lent pour qu'un rayon qui accroche brièvement un lampadaire ne
// fasse pas sauter l'acoustique, assez rapide pour qu'une façade qu'on longe
// s'entende arriver.
const TAU = 0.12;

// Le pré-delay est le seul paramètre dont un saut S'ENTEND comme un clic : un
// DelayNode qui change brutalement de temps repitche son contenu. On le lisse
// donc plus lentement que le reste, ce qui donne au passage un léger effet de
// Doppler sur les réflexions — physiquement juste, puisqu'on se rapproche
// vraiment du mur.
const PREDELAY_TAU = 0.35;

export class SpaceAudio {
	constructor() {
		this.ctx = null;
		this.nodesCreated = 0;
		this.input = null;
		this.output = null;
		this._taps = [];
		this._preDelay = null;
		this._wet = null;
		this.last = null;   // dernière description du lieu, pour l'inspection
	}

	get running() { return !!this.input; }

	/**
	 * Construit le réseau et rend son entrée. Idempotent. `destination` est le
	 * nœud sur lequel le mouillé est renvoyé — le même que le sec, pour que la
	 * réverbération traverse elle aussi le lowpass `air` : elle appartient au
	 * monde, on l'entend à travers les mêmes lunettes.
	 */
	build(ctx, destination) {
		if (this.input || !ctx || !destination) return this.input;
		this.ctx = ctx;

		this.input = ctx.createGain();
		this.input.gain.value = 1;

		this._preDelay = ctx.createDelay(0.5);
		this._preDelay.delayTime.value = 0.01;

		this._wet = ctx.createGain();
		this._wet.gain.value = 0;   // on entre depuis le sec : pas de réverbe au boot

		this.input.connect(this._preDelay);
		this.nodesCreated += 3;

		for (const time of TAPS) {
			const delay = ctx.createDelay(0.25);
			delay.delayTime.value = time;

			const damp = ctx.createBiquadFilter();
			damp.type = 'lowpass';
			damp.frequency.value = 4000;
			damp.Q.value = 0.5;

			const fb = ctx.createGain();
			fb.gain.value = 0.4;

			// La boucle : retard → amortissement → gain → retour dans le retard.
			// L'amortissement EST dans la boucle, pas après : c'est ce qui fait
			// que les aigus meurent plus vite que les graves, comme dans une
			// vraie pièce, au lieu d'être coupés une fois pour toutes.
			this._preDelay.connect(delay);
			delay.connect(damp).connect(fb).connect(delay);
			delay.connect(this._wet);

			this._taps.push({ delay, damp, fb, time });
			this.nodesCreated += 3;
		}

		this._wet.connect(destination);
		this.output = this._wet;
		return this.input;
	}

	/**
	 * Une fois par frame. Ne crée AUCUN nœud : il ne fait que viser des
	 * AudioParams. `probe` est la rosace que physics.probeWind() a déjà lancée
	 * pour le vent — l'acoustique ne coûte pas un rayon de plus.
	 */
	update(probe) {
		if (!this.input || !this.ctx) return;
		const place = acoustics(probe);
		const p = reverbParams(place);
		this.last = { ...place, ...p };

		const now = this.ctx.currentTime;
		this._preDelay.delayTime.setTargetAtTime(p.preDelayS, now, PREDELAY_TAU);
		this._wet.gain.setTargetAtTime(p.wet, now, TAU);

		for (const t of this._taps) {
			t.damp.frequency.setTargetAtTime(p.dampHz, now, TAU);
			// RT60 : le gain de bouclage qui amène cette ligne à -60 dB en
			// decayS secondes. C'est la formule qui relie une DURÉE voulue à un
			// gain, et c'est elle qui rend « la taille du lieu » réglable.
			const g = Math.min(Math.pow(10, (-3 * t.time) / Math.max(p.decayS, 0.05)), MAX_FEEDBACK);
			t.fb.gain.setTargetAtTime(g, now, TAU);
		}
	}

	/** Coupe le mouillé sans démonter : le vol peut reprendre. */
	silence() {
		if (!this._wet || !this.ctx) return;
		this._wet.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
	}

	dispose() {
		if (!this.input) return;
		try {
			this.input.disconnect();
			this._preDelay.disconnect();
			for (const t of this._taps) { t.delay.disconnect(); t.damp.disconnect(); t.fb.disconnect(); }
			this._wet.disconnect();
		} catch { /* déjà démonté */ }
		this.input = this.output = this._preDelay = this._wet = null;
		this._taps = [];
	}
}

export const space = new SpaceAudio();
