// Lecture de l'arc musical (issue #122). Le modèle — sélection, intensité,
// paliers, durées — vit dans tools/music-model.mjs ; ici il n'y a que du
// Web Audio.
//
// La musique n'est PAS un neuvième événement du vocabulaire d'interface. Ce
// vocabulaire est clos à huit entrées et tools/ui-audio-selftest.mjs balaie
// src/ pour le faire respecter : ce module ne passe jamais par uiAudio.play(),
// il a son propre bus (musicIn) et son propre volume.
//
// Une « voix » est la chaîne complète d'un morceau :
//
//   AudioBufferSource(loop) → lowpass(intensité) → gain(intensité) → duck → musicIn()
//
// Deux voix coexistent le temps d'un fondu enchaîné (menu → drone), jamais
// plus. Après play(), setIntensity() ne fait que déplacer des AudioParams :
// aucun nœud n'est créé par frame, et `nodesCreated` est là pour le prouver au
// navigateur, comme pour EngineAudio.

import { ensureContext, musicIn, setMusicVolume } from './audio-bus.js';
import {
	intensityParams, PHASE_INTENSITY, FADE, DUCK, INTENSITY_TAU,
	MUSIC_SCHEMA_VERSION, validateManifest,
	pickTrack, pushRecent, poolForFamily,
} from '../tools/music-model.mjs';

const RECENT_KEY = 'fpvtp.musicRecent';

// Le drop est un geste, pas une rampe : on le pose avec une transition
// explicite plutôt qu'avec la constante de lissage du vol.
const RAMP_TAU = 0.09;

export class Music {
	constructor() {
		this.manifest = null;
		this.nodesCreated = 0;
		this.current = null;      // { source, lowpass, gain, duck, entry }
		this.pending = null;      // { entry, buffer } préchargé, pas encore joué
		this.intensity = 0;
		this.recent = readRecent();
		this.failed = false;      // un manifeste absent ne doit pas casser le jeu
	}

	/**
	 * Charge public/music.json. Un manifeste absent, invalide ou vide laisse le
	 * jeu parfaitement jouable et silencieux : la musique est un enrichissement,
	 * jamais une dépendance.
	 */
	async loadManifest() {
		if (this.manifest || this.failed) return this.manifest;
		try {
			const res = await fetch(`${import.meta.env.BASE_URL}music.json`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			const problems = validateManifest(json);
			if (problems.length) throw new Error(problems[0]);
			this.manifest = json;
		} catch (e) {
			this.failed = true;
			console.warn(`[music] pas de bibliothèque musicale (${e.message}) — le jeu reste silencieux`);
		}
		return this.manifest;
	}

	/** Le morceau qu'aura ce drone. Pur côté modèle, déterministe sur buildSeed. */
	trackForFamily(family, buildSeed) {
		const pool = poolForFamily(family);
		return pool ? pickTrack(this.manifest, pool, buildSeed, this.recent) : null;
	}

	trackForMenu(seed) {
		return pickTrack(this.manifest, 'menu', seed, this.recent);
	}

	/**
	 * Décode un morceau sans le jouer. Appelé pendant que l'écran de hack
	 * tourne, en parallèle du préchargement de la scène : au moment du drop le
	 * buffer doit déjà être là, un fetch à cet instant se verrait.
	 */
	async prepare(entry) {
		if (!entry || this.failed) return null;
		if (this.pending?.entry?.id === entry.id) return this.pending;
		const ctx = ensureContext();
		if (!ctx) return null;
		try {
			const res = await fetch(`${import.meta.env.BASE_URL}${entry.file}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
			this.pending = { entry, buffer };
			return this.pending;
		} catch (e) {
			console.warn(`[music] ${entry.id} illisible (${e.message})`);
			return null;
		}
	}

	/**
	 * Joue le morceau préparé. Si une voix tourne déjà, elle s'efface en
	 * `fadeMs` pendant que la nouvelle entre — c'est le passage menu → drone.
	 */
	play({ intensity = PHASE_INTENSITY.MENU, fadeMs = FADE.menuToHack } = {}) {
		const ready = this.pending;
		if (!ready) return false;
		const ctx = ensureContext();
		if (!ctx) return false;

		if (this.current) this._retire(this.current, fadeMs);

		const { cutoffHz, gain } = intensityParams(intensity);
		const source = ctx.createBufferSource();
		source.buffer = ready.buffer;
		source.loop = true;   // les fichiers sont pré-bouclés par tools/music-loop.mjs

		const lowpass = ctx.createBiquadFilter();
		lowpass.type = 'lowpass';
		lowpass.frequency.value = cutoffHz;
		lowpass.Q.value = 0.7;

		const gainNode = ctx.createGain();
		// On entre depuis le silence même quand l'intensité visée est haute :
		// un buffer qui démarre à plein gain fait un clic.
		gainNode.gain.value = 0;
		gainNode.gain.setTargetAtTime(gain, ctx.currentTime, RAMP_TAU);

		const duck = ctx.createGain();
		duck.gain.value = 1;

		source.connect(lowpass).connect(gainNode).connect(duck).connect(musicIn());
		source.start();
		this.nodesCreated += 4;

		this.current = { source, lowpass, gain: gainNode, duck, entry: ready.entry };
		this.pending = null;
		this.intensity = intensity;
		this.recent = pushRecent(this.recent, ready.entry.id);
		writeRecent(this.recent);
		return true;
	}

	/**
	 * Le seul appel de la boucle de rendu. Ne crée AUCUN nœud : il ne fait que
	 * viser deux AudioParams.
	 */
	setIntensity(k, { tau = null } = {}) {
		const v = this.current;
		const rising = k >= this.intensity;
		this.intensity = k;
		if (!v) return;
		const ctx = ensureContext();
		if (!ctx) return;
		// Asymétrique par défaut : on monte vite, on redescend lentement. En FPV
		// les gaz se coupent sans arrêt, et sans cette asymétrie la musique
		// duckait à chaque chop. Un appelant qui veut un geste franc — le drop —
		// passe sa propre constante.
		const t = tau ?? (rising ? INTENSITY_TAU.rise : INTENSITY_TAU.fall);
		const { cutoffHz, gain } = intensityParams(k);
		v.lowpass.frequency.setTargetAtTime(cutoffHz, ctx.currentTime, t);
		v.gain.gain.setTargetAtTime(gain, ctx.currentTime, t);
	}

	/** Le drop : on pose l'intensité pleine d'un geste, pas d'une dérive. */
	drop() {
		// Le rituel vient de se terminer ; c'est ici, et pas dans ritual.js, que
		// la musique reprend sa place — le drop EST la fin du duck.
		this.unduck(FADE.drop);
		this.setIntensity(PHASE_INTENSITY.DROP, { tau: FADE.drop / 3000 });
	}

	/** Laisse le rituel culminer seul, puis rend la place. */
	duck(amount = DUCK.ritual, ms = DUCK.ms) {
		const v = this.current;
		const ctx = ensureContext();
		if (!v || !ctx) return;
		v.duck.gain.cancelScheduledValues(ctx.currentTime);
		v.duck.gain.setTargetAtTime(amount, ctx.currentTime, ms / 3000);
	}

	unduck(ms = DUCK.ms) {
		const v = this.current;
		const ctx = ensureContext();
		if (!v || !ctx) return;
		v.duck.gain.setTargetAtTime(1, ctx.currentTime, ms / 3000);
	}

	/** La pose : on relâche. */
	/** Le crash : la musique meurt avec le lien. Court, mais pas un clic. */
	kill() {
		if (this.current) this._retire(this.current, FADE.kill);
		this.current = null;
		this.intensity = 0;
	}

	/**
	 * Éteint une voix et la démonte. `onended` est le seul endroit où l'on peut
	 * déconnecter sans couper le fondu : sans ce démontage, chaque transition
	 * laisserait un AudioBuffer vivant et la mémoire monterait sur une longue
	 * session.
	 */
	_retire(voice, fadeMs) {
		const ctx = ensureContext();
		if (!ctx) return;
		const endsAt = ctx.currentTime + Math.max(0.01, fadeMs / 1000);
		voice.gain.gain.cancelScheduledValues(ctx.currentTime);
		voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
		voice.gain.gain.linearRampToValueAtTime(0, endsAt);
		voice.source.onended = () => {
			try {
				voice.source.disconnect();
				voice.lowpass.disconnect();
				voice.gain.disconnect();
				voice.duck.disconnect();
			} catch { /* déjà démonté */ }
			voice.source.buffer = null;
		};
		try { voice.source.stop(endsAt); } catch { /* déjà arrêté */ }
	}

	setVolume(v) { setMusicVolume(v); }

	get playing() { return !!this.current; }
	get currentId() { return this.current?.entry?.id ?? null; }
}

function readRecent() {
	try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); }
	catch { return []; }
}

function writeRecent(list) {
	try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }
	catch { /* stockage plein ou refusé : on perd la mémoire des récents, rien d'autre */ }
}

export const music = new Music();
export { MUSIC_SCHEMA_VERSION };
