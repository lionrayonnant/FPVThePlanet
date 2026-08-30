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
//   entrée → preDelay → 4 peignes bouclés ⟲ → 3 allpass en série → wet → sortie
//
// DEUX DÉFAUTS CORRIGÉS ICI, tous deux entendus en vol.
//
// 1. « Un écho infini qui devient un bruit horrible. » Ce n'était pas une
//    divergence : c'était de l'ACCUMULATION. Une réverbération se conçoit pour
//    des sons transitoires, or un moteur de drone est un son CONTINU. Un
//    peigne bouclé au gain g alimenté en continu converge vers 1/(1-g) fois
//    son entrée — à g=0,92 c'est ×12,5, et il y en avait quatre sommés sans
//    aucune compensation, soit +34 dB avant même le wet. Chaque peigne renvoie
//    désormais son signal pondéré par (1-g)/N : le niveau du mouillé devient
//    INDÉPENDANT de la durée de queue, ce que fait toute vraie réverbération.
//
// 2. « Un tour d'hélice = un écho. » La première version s'arrêtait aux
// peignes, et elle avait un défaut audible décrit à l'écoute comme « un tour
// d'hélice = un écho » : quatre peignes bouclés à fort gain résonnent à 1/T,
// soit 23 à 51 Hz pour ces longueurs, et ce battement régulier posé sur un son
// déjà périodique — des hélices — s'entend comme un bégaiement. C'est le
// flutter echo, et c'est ce que les allpass en série existent pour supprimer :
// ils étalent chaque écho discret en une queue lisse sans rien changer au
// spectre.
//
// Structure de Schroeder, donc : banc de peignes EN PARALLÈLE, puis chaîne
// d'allpass EN SÉRIE. L'ordre compte ; diffuser avant les peignes ne
// diffuserait que l'entrée, pas les répétitions.

import { acoustics, reverbParams } from '../tools/space-model.mjs';

// Longueurs des quatre peignes, en secondes. Choisies dans un rapport proche de
// nombres premiers entre eux (23 : 31 : 41 : 53 ms) pour que leurs résonances
// ne se superposent pas : des retards en rapport simple font sonner le réseau
// comme une hauteur plutôt que comme un lieu.
const COMBS = [0.0233, 0.0311, 0.0411, 0.0530];

// Allpass de diffusion, en série. Courts et non commensurables avec les
// peignes. Le gain de 0,5 est la valeur classique : au-delà l'allpass devient
// lui-même résonant et on remplace un défaut par un autre.
const ALLPASS = [0.0047, 0.0083, 0.0127];
const ALLPASS_G = 0.5;

// Plafond de contre-réaction, abaissé de 0,92 à 0,70. À 0,86 — ce que la
// version précédente atteignait en espace fermé — un peigne met plus d'une
// seconde à décroître et son battement devient un motif rythmique. La queue est
// désormais portée par la diffusion, pas par la résonance.
const MAX_FEEDBACK = 0.70;

const TAU = 0.12;

// Le pré-delay est le seul paramètre dont un saut S'ENTEND comme un clic : un
// DelayNode qui change brutalement de temps repitche son contenu. On le lisse
// donc plus lentement que le reste, ce qui donne au passage un léger effet de
// Doppler sur les réflexions — physiquement juste, puisqu'on se rapproche
// vraiment du mur.
const PREDELAY_TAU = 0.35;

/**
 * Allpass de Schroeder. Web Audio a bien un BiquadFilter `allpass`, mais c'est
 * un allpass du SECOND ORDRE : il déphase autour d'une fréquence et ne retarde
 * rien. Ce qu'il faut ici est un allpass à ligne à retard, qui diffuse dans le
 * temps. Il se construit :
 *
 *   y = -g·x + d        avec        d_in = x + g·d
 *
 * soit une contre-réaction positive dans la ligne et une anticipation négative
 * autour d'elle. Le module est transparent en amplitude — d'où « allpass » —
 * et n'agit que sur la répartition temporelle.
 */
function makeAllpass(ctx, timeS, g) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const delay = ctx.createDelay(0.2);
	delay.delayTime.value = timeS;

	const fb = ctx.createGain();      // + g dans la boucle
	fb.gain.value = g;
	const ff = ctx.createGain();      // − g autour de la boucle
	ff.gain.value = -g;

	input.connect(delay);
	delay.connect(fb).connect(delay);
	delay.connect(output);
	input.connect(ff).connect(output);

	return { input, output, nodes: 5 };
}

export class SpaceAudio {
	constructor() {
		this.ctx = null;
		this.nodesCreated = 0;
		this.input = null;
		this.output = null;
		this._combs = [];
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

		// Somme des peignes, avant diffusion. Chaque peigne y entre par son
		// propre envoi compensé (voir update) — la somme elle-même est neutre.
		const combSum = ctx.createGain();
		combSum.gain.value = 1;

		this._wet = ctx.createGain();
		this._wet.gain.value = 0;   // on entre depuis le sec : pas de réverbe au boot

		this.input.connect(this._preDelay);
		this.nodesCreated += 4;

		for (const time of COMBS) {
			const delay = ctx.createDelay(0.25);
			delay.delayTime.value = time;

			const damp = ctx.createBiquadFilter();
			damp.type = 'lowpass';
			damp.frequency.value = 4000;
			damp.Q.value = 0.5;

			const fb = ctx.createGain();
			fb.gain.value = 0.3;

			// Envoi compensé. C'est LA correction du bruit qui montait : sans
			// lui, allonger la queue augmente aussi le niveau, et sur une
			// source continue le peigne s'accumule jusqu'à saturer le mix.
			const send = ctx.createGain();
			send.gain.value = (1 - 0.3) / COMBS.length;

			// L'amortissement EST dans la boucle, pas après : c'est ce qui fait
			// que les aigus meurent plus vite que les graves, comme dans une
			// vraie pièce, au lieu d'être coupés une fois pour toutes.
			this._preDelay.connect(delay);
			delay.connect(damp).connect(fb).connect(delay);
			delay.connect(send).connect(combSum);

			this._combs.push({ delay, damp, fb, send, time });
			this.nodesCreated += 4;
		}

		// La chaîne de diffusion. C'est elle qui transforme quatre échos
		// périodiques en une queue.
		let node = combSum;
		for (const time of ALLPASS) {
			const ap = makeAllpass(ctx, time, ALLPASS_G);
			node.connect(ap.input);
			node = ap.output;
			this.nodesCreated += ap.nodes;
		}
		node.connect(this._wet);

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

		for (const c of this._combs) {
			c.damp.frequency.setTargetAtTime(p.dampHz, now, TAU);
			// RT60 : le gain de bouclage qui amène ce peigne à -60 dB en decayS
			// secondes. C'est la formule qui relie une DURÉE voulue à un gain,
			// et c'est elle qui rend « la taille du lieu » réglable. Le plafond
			// prime toujours : au-delà, le peigne résonne au lieu de décroître.
			const g = Math.min(Math.pow(10, (-3 * c.time) / Math.max(p.decayS, 0.05)), MAX_FEEDBACK);
			c.fb.gain.setTargetAtTime(g, now, TAU);
			// Le gain permanent d'un peigne alimenté en continu est 1/(1-g) :
			// on l'annule exactement, sinon « plus de queue » voudrait aussi
			// dire « plus fort », et le moteur — qui ne s'arrête jamais —
			// ferait monter le réseau jusqu'à l'écrasement.
			c.send.gain.setTargetAtTime((1 - g) / this._combs.length, now, TAU);
		}
	}

	/**
	 * Coupe la réverbération sans démonter : le vol peut reprendre.
	 *
	 * Couper le seul `wet` ne suffit PAS. Les peignes gardent l'énergie déjà
	 * accumulée et continuent de tourner en boucle ; il faut aussi ouvrir les
	 * boucles, sinon rouvrir le wait plus tard réveillerait la queue d'un vol
	 * précédent. C'est ce qui faisait continuer le bruit dans les menus après
	 * la fin de session.
	 */
	silence() {
		if (!this._wet || !this.ctx) return;
		const now = this.ctx.currentTime;
		this._wet.gain.setTargetAtTime(0, now, 0.05);
		for (const c of this._combs) c.fb.gain.setTargetAtTime(0, now, 0.05);
		this.last = null;
	}

	dispose() {
		if (!this.input) return;
		try {
			this.input.disconnect();
			this._preDelay.disconnect();
			for (const c of this._combs) { c.delay.disconnect(); c.damp.disconnect(); c.fb.disconnect(); }
			this._wet.disconnect();
		} catch { /* déjà démonté */ }
		this.input = this.output = this._preDelay = this._wet = null;
		this._combs = [];
	}
}

export const space = new SpaceAudio();
