// Le rendu du langage sonore d'interface (PHASE 18, Bible §34-36). Prend le bus
// partagé (src/audio-bus.js) et joue ce que décrit le modèle pur
// (tools/ui-audio-model.mjs). Aucun DOM au-delà des deux écouteurs de geste,
// aucun Three, aucun Rapier : JAMAIS importé par le moteur.
//
// Tout est synthétisé, rien n'est chargé : aucune question de droits sur une
// source, et le tout pèse ce que pèse ce fichier.
//
// Aucune voix, aucun narrateur, aucune commande vocale (Bible §37).
import { ensureContext, context, uiIn } from './audio-bus.js';
import { UI_EVENTS, BOOT_SIGNATURE, scoreFor } from '../tools/ui-audio-model.mjs';

// Au-delà de cette fenêtre, une signature de démarrage armée est ABANDONNÉE
// plutôt que jouée : un son de boot qui part une minute après le boot n'est
// plus un son de boot. Mieux vaut le silence.
export const BOOT_ARM_WINDOW_S = 20;

// Niveaux relatifs des familles. Rares et brefs : ils doivent porter sans
// écraser les moteurs. À équilibrer à l'oreille (issue #11).
const LEVEL = {
	boot: 0.30,
	system: 0.22,
	link: 0.26,
	ritual: 0.34,
	carrier: 0.06,      // un lit, pas un événement
};

const CARRIER_HZ = 320;       // bande de la porteuse : là où un récepteur siffle
const CARRIER_TAU = 0.25;     // lissage, du même ordre que link.js:NOISE_TAU

export class UiAudio {
	constructor() {
		this._carrier = null;
		this._noiseBuf = null;
		this._noiseCtx = null;
		this._bootArmedAt = null;
		this._bootHandler = null;
		this.nodesCreated = 0;
	}

	// --- primitives ---------------------------------------------------------

	// Deux secondes de bruit blanc bouclé : une seule source alimente toutes les
	// branches bruitées, qui ne diffèrent que par leurs filtres. Même idiome que
	// src/audio.js.
	//
	// Mémorisé AVEC son contexte : un AudioBuffer né d'un autre contexte est
	// refusé à la lecture, et le cas se produit dès qu'un test remonte le bus.
	_noiseBuffer(ctx) {
		if (!this._noiseBuf || this._noiseCtx !== ctx) {
			const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
			const d = buf.getChannelData(0);
			for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
			this._noiseBuf = buf;
			this._noiseCtx = ctx;
		}
		return this._noiseBuf;
	}

	// Un one-shot : construit ses nœuds, se démonte sur onended. C'est le seul
	// endroit de ce fichier où un nœud naît après le montage, et jamais par
	// frame — la porteuse, elle, est permanente.
	_shot(ctx, at, durS, build) {
		const out = ctx.createGain();
		out.connect(uiIn());
		const parts = [out];
		const src = build(out, parts);
		if (!src) return;
		src.start(at);
		src.stop(at + durS + 0.05);
		src.onended = () => { for (const p of parts) p.disconnect(); src.disconnect(); };
		this.nodesCreated += parts.length + 1;
	}

	// Enveloppe percussive commune : attaque immédiate, décroissance
	// exponentielle. `exponentialRampToValueAtTime` ne peut pas viser zéro.
	_env(param, at, durS, peak) {
		param.setValueAtTime(0.0001, at);
		param.exponentialRampToValueAtTime(peak, at + 0.002);
		param.exponentialRampToValueAtTime(0.0001, at + durS);
	}

	// Une voix de la partition, à l'instant absolu `at` de l'horloge audio.
	_voice(ctx, ev, at, level) {
		const { voice, durS } = ev;
		const gain = level * (ev.gain ?? 1);

		if (voice === 'click') {
			this._shot(ctx, at, durS, (out, parts) => {
				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = ev.freq ?? 3500;
				bp.Q.value = 2.5;
				const src = ctx.createBufferSource();
				src.buffer = this._noiseBuffer(ctx);
				src.connect(bp).connect(out);
				this._env(out.gain, at, durS, gain);
				parts.push(bp);
				return src;
			});
			return;
		}

		if (voice === 'glitch') {
			// Bruit annelé : un oscillateur module l'amplitude d'une bande de
			// bruit. C'est la façon la plus courte d'obtenir « numérique cassé »
			// sans charger un échantillon.
			this._shot(ctx, at, durS, (out, parts) => {
				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = ev.freq ?? 1400;
				bp.Q.value = 6;
				const ring = ctx.createGain();
				ring.gain.value = 0;
				const mod = ctx.createOscillator();
				mod.type = 'square';
				mod.frequency.value = 70;
				mod.connect(ring.gain);
				mod.start(at);
				mod.stop(at + durS + 0.05);
				const src = ctx.createBufferSource();
				src.buffer = this._noiseBuffer(ctx);
				src.connect(bp).connect(ring).connect(out);
				this._env(out.gain, at, durS, gain);
				parts.push(bp, ring, mod);
				return src;
			});
			return;
		}

		if (voice === 'impact') {
			// La retombée : un grave qui chute. Elle ne reprend AUCUN élément de
			// la signature de boot (Bible §35).
			//
			// `_shot` démarre et arrête la source qu'on lui rend : ne PAS appeler
			// start() ici en plus, un double start() jette InvalidStateError.
			const total = durS * 3;
			this._shot(ctx, at, total, (out, parts) => {
				const lp = ctx.createBiquadFilter();
				lp.type = 'lowpass';
				lp.frequency.value = 900;
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.setValueAtTime((ev.freq ?? 45) * 3, at);
				osc.frequency.exponentialRampToValueAtTime(ev.freq ?? 45, at + total * 0.7);
				osc.connect(lp).connect(out);
				this._env(out.gain, at, total, gain * 1.4);
				parts.push(lp);
				return osc;
			});
			return;
		}

		// Voix à oscillateur : tone, pulse, bass, sweep, stab.
		this._shot(ctx, at, durS, (out, parts) => {
			const osc = ctx.createOscillator();
			osc.type = voice === 'stab' ? 'sawtooth' : voice === 'bass' ? 'triangle' : 'sine';
			const f0 = ev.freq ?? 440;
			osc.frequency.setValueAtTime(f0, at);
			if (voice === 'sweep') {
				osc.frequency.exponentialRampToValueAtTime(ev.to ?? f0 * 4, at + durS);
			} else if (voice === 'pulse') {
				osc.frequency.exponentialRampToValueAtTime(Math.max(f0 * 0.4, 20), at + durS);
			} else if (ev.to) {
				osc.frequency.exponentialRampToValueAtTime(ev.to, at + durS);
			}
			const lp = ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = voice === 'bass' ? 400 : 7000;
			osc.connect(lp).connect(out);
			this._env(out.gain, at, durS, gain);
			parts.push(lp);
			return osc;
		});
	}

	// --- API ----------------------------------------------------------------

	play(event) {
		// Le vocabulaire est clos : une faute se voit au développement, pas à
		// l'oreille trois semaines plus tard.
		if (!UI_EVENTS.includes(event)) {
			throw new Error(`[ui-audio] événement hors vocabulaire : ${event}`);
		}
		const ctx = ensureContext();
		if (!ctx) return;
		const t0 = ctx.currentTime;

		if (event === 'BOOT') {
			// Un cran de filtrage de plus que le timbre ESC brut, pour lire comme
			// un logiciel qui démarre plutôt qu'un drone posé devant soi — le
			// « traitement synthétique ou filtré » que la Bible §35 autorise.
			for (const note of BOOT_SIGNATURE) {
				this._voice(ctx, { voice: 'tone', freq: note.freq, durS: note.durS },
					t0 + note.atMs / 1000, LEVEL.boot);
			}
			return;
		}
		if (event === 'TERRAIN_READY') {
			this._voice(ctx, { voice: 'tone', freq: 660, to: 990, durS: 0.16 }, t0, LEVEL.system);
			return;
		}
		if (event === 'TARGET_FOUND') {
			this._voice(ctx, { voice: 'click', freq: 3200, durS: 0.02 }, t0, LEVEL.system);
			this._voice(ctx, { voice: 'tone', freq: 1320, durS: 0.10 }, t0 + 0.05, LEVEL.system);
			return;
		}
		if (event === 'ERROR') {
			// Court et bas. Un accusé de réception, pas une punition : le rituel
			// n'a ni pénalité ni compteur (Bible §14, issue #47).
			this._voice(ctx, { voice: 'tone', freq: 180, durS: 0.09 }, t0, LEVEL.system);
			return;
		}
		if (event === 'LINK_LOST') {
			// Réaliste : la porteuse s'effondre, elle ne joue pas une mélodie.
			this._voice(ctx, { voice: 'glitch', freq: 800, durS: 0.09 }, t0, LEVEL.link);
			this._voice(ctx, { voice: 'pulse', freq: 130, durS: 0.22 }, t0 + 0.06, LEVEL.link);
			return;
		}
		if (event === 'LINK_RESTORED') {
			// Son PROPRE, pas l'inverse du précédent (Bible §35).
			this._voice(ctx, { voice: 'tone', freq: 520, to: 780, durS: 0.13 }, t0, LEVEL.link);
			return;
		}
		if (event === 'RITUAL') {
			// Le rituel réel passe par playRitual() ; ce chemin n'existe que pour
			// que les sept entrées du vocabulaire soient toutes jouables.
			this.playRitual('LINK HIJACK', 2000);
		}
	}

	// Programmée D'UN COUP sur l'horloge de l'AudioContext, jamais sur
	// requestAnimationFrame : une culmination de 1 à 4 s doit rester
	// rythmiquement juste même si une frame saute pendant que la carte finit de
	// se charger.
	playRitual(hackType, variantMs) {
		const ctx = ensureContext();
		if (!ctx) return;
		const t0 = ctx.currentTime;
		for (const ev of scoreFor(hackType, variantMs)) {
			this._voice(ctx, ev, t0 + ev.atMs / 1000, LEVEL.ritual);
		}
	}

	// --- porteuse -----------------------------------------------------------

	// Branche permanente : seuls les AudioParam bougent. Appelée une fois par
	// frame de vol, elle ne doit jamais construire de nœud.
	_ensureCarrier(ctx) {
		if (this._carrier) return this._carrier;
		const src = ctx.createBufferSource();
		src.buffer = this._noiseBuffer(ctx);
		src.loop = true;
		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = CARRIER_HZ;
		bp.Q.value = 1.2;
		const g = ctx.createGain();
		g.gain.value = 0;
		src.connect(bp).connect(g).connect(uiIn());
		src.start();
		this.nodesCreated += 3;
		this._carrier = { src, bp, gain: g };
		return this._carrier;
	}

	// La marge qui fond s'entend avant d'être perdue, comme le fade visuel : le
	// souffle monte quand la qualité descend.
	setLinkQuality(q) {
		const ctx = context();
		if (!ctx) return;
		const c = this._ensureCarrier(ctx);
		const k = Math.min(Math.max(q, 0), 1);
		const t = ctx.currentTime;
		c.gain.gain.setTargetAtTime(LEVEL.carrier * (1 - k), t, CARRIER_TAU);
		c.bp.frequency.setTargetAtTime(CARRIER_HZ * (0.6 + 0.8 * k), t, CARRIER_TAU);
	}

	// Hors vol. Coupe sans démonter : la branche resservira au vol suivant.
	linkSilent() {
		const ctx = context();
		if (!ctx || !this._carrier) return;
		this._carrier.gain.gain.setTargetAtTime(0, ctx.currentTime, CARRIER_TAU);
	}

	// --- boot ---------------------------------------------------------------

	// Au premier chargement d'une page aucun geste n'a eu lieu, et le navigateur
	// refuse de démarrer l'AudioContext. Or le boot FPVTP! est précisément le
	// premier écran : selon le chemin (bootstrap, sélection d'opérateur, ou
	// directement le terminal), il peut s'écouler un temps arbitraire avant le
	// premier clic.
	armBoot() {
		const ctx = ensureContext();
		if (ctx && ctx.state === 'running') { this.play('BOOT'); return; }
		if (this._bootHandler) return;
		this._bootArmedAt = Date.now();
		this._bootHandler = () => {
			this._disarmBoot();
			if ((Date.now() - this._bootArmedAt) / 1000 > BOOT_ARM_WINDOW_S) return;
			const c = ensureContext();
			if (c) this.play('BOOT');
		};
		if (typeof window === 'undefined') return;
		window.addEventListener('pointerdown', this._bootHandler, { once: true });
		window.addEventListener('keydown', this._bootHandler, { once: true });
	}

	_disarmBoot() {
		if (typeof window === 'undefined' || !this._bootHandler) return;
		window.removeEventListener('pointerdown', this._bootHandler);
		window.removeEventListener('keydown', this._bootHandler);
		this._bootHandler = null;
	}
}

// L'instance unique. Les écrans (ritual.js, target-scan.js, bootstrap.js)
// l'importent directement plutôt que de se la faire passer : ce sont des
// écrans clients, pas des sous-systèmes du moteur, et la faire circuler dans
// six signatures n'achèterait rien.
export const uiAudio = new UiAudio();
