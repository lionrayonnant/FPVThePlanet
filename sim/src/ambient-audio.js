// Les voix des drones ambiants (issue #250). Quatre voix construites UNE fois
// dans start(), à gain zéro ; update() ne fait que viser des AudioParams.
//
//   osc(sine) ──┐
//   noise ─ bp ─┼→ gain(distance) → lowpass(distance, dos) → panner ─┬→ destination (engineIn)
//                                                                    └→ spaceInput (acoustique du lieu, #122)
//
// Sinus seulement, détune par voix (son.md : quatre voix en phase feraient un
// son de test de synthé), coupure qui descend avec la distance (rien ne
// remonte dans 2–4 kHz), Doppler écrit à la main sur osc.frequency — jamais
// celui du PannerNode, retiré de la spec.
//
// `destination` (engineIn()) et `spaceInput` (space.input) n'existent pas
// encore au moment où AmbientAudio est construit au boot : ensureContext()
// n'a pas tourné (geste utilisateur requis) et l'acoustique du lieu n'est
// bâtie qu'une fois construite. On peut donc soit les passer au constructeur
// quand ils sont déjà connus (tests, contexte figé), soit laisser
// start(ctx, destination, spaceInput) les résoudre au moment où l'appelant
// les a enfin : les overrides, s'ils sont fournis, remplacent ceux du
// constructeur avant que le graphe ne soit construit.
//
// `spaceInput` peut même arriver APRÈS start() : le contexte s'ouvre au
// premier son d'interface, l'acoustique du lieu se bâtit au décollage.
// update(voices, now, spaceInput) le rattrape — voir _connectSpace().
import { voiceParams, VOICE } from '../tools/ambient-audio-model.mjs';
import { AUDIO } from './audio.js';

const N_VOICES = 4;
const NOISE_LEVEL = 0.25;   // part de bruit dans une voix, sous le sinus
const TAU_PAN = 0.06;

function makeNoiseBuffer(ctx, seconds) {
	const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
	return buf;
}

export class AmbientAudio {
	// `destination` : engineIn() ; `spaceInput` : space.input (peut être null
	// si l'acoustique n'est pas construite — alors pas d'envoi). Les deux sont
	// optionnels ici : start() peut les recevoir à la place, voir plus haut.
	constructor({ destination, spaceInput = null } = {}) {
		this._dest = destination;
		this._spaceIn = spaceInput;
		// L'envoi vers `space` est-il déjà branché ? Il peut ne pas l'être même
		// une fois le graphe construit : voir _connectSpace().
		this._spaceConnected = false;
		this.ctx = null;
		this._voices = [];
		this._muted = false;
		this.nodesCreated = 0;
		this._p = { gain: 0, cutoff: 0, freq: 0, pan: 0 };
		// Objet pré-alloué : les six champs de voiceParams() y sont recopiés
		// une frame à la fois plutôt que de spreader `{ ...src, detune }`,
		// qui allouerait un objet par voix et par frame.
		this._in = { d: 0, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: null, detune: 0 };
	}

	get running() { return this.ctx !== null; }

	start(ctx, destination, spaceInput) {
		if (this.ctx) return;
		this._dest = destination ?? this._dest;
		this._spaceIn = spaceInput ?? this._spaceIn;
		if (!ctx || !this._dest) return;
		this.ctx = ctx;
		this._noise = ctx.createBufferSource();
		this._noise.buffer = makeNoiseBuffer(ctx, 2);
		this._noise.loop = true;
		this._noise.start();
		this.nodesCreated++;
		// Détunes distincts et non symétriques : ±9 cents, jamais deux pareils.
		const detunes = [7, -5, 4, -8].map((c) => c * VOICE.detuneCents / 9);
		for (let i = 0; i < N_VOICES; i++) {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = 200;
			const band = ctx.createBiquadFilter();
			band.type = 'bandpass'; band.frequency.value = 200; band.Q.value = 1.6;
			const bandGain = ctx.createGain(); bandGain.gain.value = NOISE_LEVEL;
			const gain = ctx.createGain(); gain.gain.value = 0;
			const low = ctx.createBiquadFilter();
			low.type = 'lowpass'; low.frequency.value = VOICE.cutNear; low.Q.value = 0.5;
			const pan = ctx.createStereoPanner();
			osc.connect(gain);
			this._noise.connect(band).connect(bandGain).connect(gain);
			gain.connect(low).connect(pan).connect(this._dest);
			osc.start();
			this.nodesCreated += 6;
			this._voices.push({ osc, band, bandGain, gain, low, pan, detuneCents: detunes[i] });
		}
		this._connectSpace(this._spaceIn);
	}

	// L'envoi vers l'acoustique du lieu (#122), branché UNE fois, dès que le
	// nœud existe. Il peut arriver après start() : ensureContext() ouvre le
	// contexte au premier son d'interface — donc AmbientAudio démarre — alors
	// que `space.input` n'est bâti qu'à EngineAudio.start(), au décollage.
	// Sans ce rattrapage, l'envoi était perdu pour toute la session et les
	// ambiants sonnaient à sec, hors du lieu.
	_connectSpace(node) {
		if (this._spaceConnected || !node || !this._voices.length) return;
		for (const v of this._voices) v.pan.connect(node);
		this._spaceIn = node;
		this._spaceConnected = true;
	}

	setMuted(m) { this._muted = !!m; }

	// `voices[i]` = { d, behind, pan, vRadial, accelMag, profile } ou null.
	// `spaceInput` : le nœud d'entrée de l'acoustique du lieu, relu à chaque
	// frame par l'appelant (lecture de propriété, aucune allocation) — voir
	// _connectSpace().
	update(voices, now, spaceInput) {
		if (!this.ctx) return;
		if (!this._spaceConnected && spaceInput) this._connectSpace(spaceInput);
		const t = now ?? this.ctx.currentTime;
		for (let i = 0; i < N_VOICES; i++) {
			const v = this._voices[i], src = voices[i];
			if (!src || this._muted) { v.gain.gain.setTargetAtTime(0, t, AUDIO.tauGain); continue; }
			const in_ = this._in;
			in_.d = src.d; in_.behind = src.behind; in_.pan = src.pan;
			in_.vRadial = src.vRadial; in_.accelMag = src.accelMag; in_.profile = src.profile;
			in_.detune = v.detuneCents;
			voiceParams(in_, this._p);
			v.gain.gain.setTargetAtTime(this._p.gain, t, AUDIO.tauGain);
			v.low.frequency.setTargetAtTime(this._p.cutoff, t, AUDIO.tauFreq);
			v.osc.frequency.setTargetAtTime(Math.max(this._p.freq, 1), t, AUDIO.tauFreq);
			v.band.frequency.setTargetAtTime(Math.max(this._p.freq, 20), t, AUDIO.tauFreq);
			v.pan.pan.setTargetAtTime(this._p.pan, t, TAU_PAN);
		}
	}

	silence() {
		if (!this.ctx) return;
		const t = this.ctx.currentTime;
		for (const v of this._voices) v.gain.gain.setTargetAtTime(0, t, 0.05);
	}

	dispose() {
		if (!this.ctx) return;
		try {
			for (const v of this._voices) { v.osc.stop(); v.osc.disconnect(); v.band.disconnect(); v.bandGain.disconnect(); v.gain.disconnect(); v.low.disconnect(); v.pan.disconnect(); }
			this._noise.stop(); this._noise.disconnect();
		} catch { /* déjà démonté */ }
		this._voices = []; this.ctx = null; this._spaceConnected = false;
	}
}
