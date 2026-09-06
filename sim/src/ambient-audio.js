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
			if (this._spaceIn) pan.connect(this._spaceIn);
			osc.start();
			this.nodesCreated += 6;
			this._voices.push({ osc, band, bandGain, gain, low, pan, detuneCents: detunes[i] });
		}
	}

	setMuted(m) { this._muted = !!m; }

	// `voices[i]` = { d, behind, pan, vRadial, accelMag, profile } ou null.
	update(voices, now) {
		if (!this.ctx) return;
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
		this._voices = []; this.ctx = null;
	}
}
