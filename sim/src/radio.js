// La radio (issue #120). Le séquenceur du JUKEBOX : il détient l'antenne,
// enchaîne, précharge le suivant, et prévient qui l'écoute.
//
// POURQUOI IL NE VIT PAS DANS L'ÉCRAN. Une radio qu'on éteint en fermant la
// fenêtre n'est pas une radio. Celle-ci doit survivre à la sortie du jukebox,
// traverser les menus et continuer pendant le vol : elle est donc un singleton
// de module, et src/jukebox.js n'en est qu'une VUE.
//
// LA RÈGLE. La radio n'est PAS la musique du vol. L'arc de la Bible §34 — la
// musique sourde au hack, le duck du rituel, l'explosion au drop, l'intensité
// qui suit le pilote, la mort au choc — appartient à FIELD. Ici on joue à
// plat, et tant que `owns` est vrai, main.js ne touche plus à `music`.
import { music as sharedMusic } from './music.js';
import { loadMusicVolume } from './settings.js';
import { PHASE_INTENSITY, FADE } from '../tools/music-model.mjs';
import { buildLibrary, stepIndex } from '../tools/jukebox-model.mjs';

export class Radio {
	constructor(music = sharedMusic) {
		this._music = music;
		this.library = [];
		this.index = -1;
		// `owns` : la radio tient l'antenne. Vrai du premier morceau lancé
		// jusqu'à stop(), y compris dans le blanc entre deux morceaux — c'est ce
		// que lisent les gardes de main.js, et `music.playing` ne suffirait pas.
		this.owns = false;
		this._ready = null;
		this._pre = null;
		// Jeton monotone : tout geste (playAt, stop) l'incrémente. Un rappel de
		// fin parti d'un morceau déjà remplacé se reconnaît à son jeton périmé.
		// Seconde ligne de défense derrière le drapeau `retired` de music.js.
		this._token = 0;
		this._changed = new Set();
		this._released = new Set();
	}

	get current() { return this.library[this.index] ?? null; }
	get playing() { return this.owns && this._music.playing; }

	/** Charge le manifeste et bâtit la bibliothèque. Mémoïsé, ne jette jamais. */
	async ready() {
		if (!this._ready) {
			this._ready = this._music.loadManifest()
				.then((m) => { this.library = buildLibrary(m); return this.library; })
				.catch(() => { this.library = []; return this.library; });
		}
		return this._ready;
	}

	/**
	 * Prend l'antenne sur `list[i]`. `list`, s'il est donné, DEVIENT la
	 * programmation : filtrer sur RACE5 puis lancer donne une radio race5, et
	 * l'enchaînement suit ce même ordre.
	 *
	 * Un morceau illisible est sauté plutôt que fatal — un .opus manquant ne
	 * doit pas transformer le silence en gel.
	 */
	async playAt(i, list = null) {
		if (list) this.library = list;
		const lib = this.library;
		if (!lib.length) return false;

		const token = ++this._token;
		let at = ((i % lib.length) + lib.length) % lib.length;

		for (let tries = 0; tries < lib.length; tries++) {
			const entry = lib[at];
			const ready = await this._decodeFor(entry);
			// Un autre geste a pris la main pendant le décodage : on se retire.
			if (token !== this._token) return false;

			if (ready) {
				this._music.setVolume(loadMusicVolume());
				const started = this._music.play({
					ready,
					intensity: PHASE_INTENSITY.DROP,   // à plat : plein spectre, 0 dB
					fadeMs: FADE.menuToHack,
					loop: false,
					remember: false,
					onEnded: () => {
						if (!this.owns || token !== this._token) return;
						this.next().catch(() => { /* l'enchaînement n'est pas critique */ });
					},
				});
				// Pas de contexte audio (aucun geste utilisateur encore) : on ne
				// s'approprie RIEN, sinon main.js céderait l'antenne à une radio
				// muette.
				if (!started) return false;
				this.owns = true;
				this.index = at;
				this._prefetch();
				this._emit();
				return true;
			}
			at = stepIndex(lib.length, at, 1);
		}

		// Toute la bibliothèque est illisible.
		this.stop();
		return false;
	}

	async next() { return this.playAt(stepIndex(this.library.length, this.index, 1)); }
	async prev() { return this.playAt(stepIndex(this.library.length, this.index, -1)); }

	/** Le bouton unique : coupe si ça joue, reprend où on en était sinon. */
	async toggle() {
		if (this.playing) { this.stop(); return false; }
		return this.playAt(this.index < 0 ? 0 : this.index);
	}

	/** Rend l'antenne. main.js reprend la main sur `music` au geste suivant. */
	stop() {
		this._token++;
		this._pre = null;
		const was = this.owns;
		this.owns = false;
		this._music.kill();
		this._emit();
		if (was) for (const fn of [...this._released]) fn();
	}

	/** Appelé à chaque changement d'antenne : l'écran s'y abonne pour repeindre. */
	onChange(fn) { this._changed.add(fn); return () => this._changed.delete(fn); }

	/** Appelé quand la radio rend l'antenne — main.js y relance sa musique. */
	onRelease(fn) { this._released.add(fn); return () => this._released.delete(fn); }

	_emit() { for (const fn of [...this._changed]) fn(); }

	// Le morceau préchargé s'il correspond, un décodage neuf sinon.
	async _decodeFor(entry) {
		if (this._pre?.id === entry.id) {
			const pending = this._pre.p;
			this._pre = null;
			return pending;
		}
		return this._music.decode(entry);
	}

	// Précharge le suivant. Par decode() et JAMAIS prepare() : `music.pending`
	// est un créneau unique partagé avec le chemin du jeu, et un hack lancé
	// pendant que la radio joue échangerait le buffer sous elle.
	_prefetch() {
		const len = this.library.length;
		const next = len > 1 ? this.library[stepIndex(len, this.index, 1)] : null;
		if (!next) { this._pre = null; return; }
		this._pre = { id: next.id, p: this._music.decode(next).catch(() => null) };
	}

	// --- tests seulement, même idiome que audio-bus._setContextFactory --------
	_setMusic(m) { this._music = m; }

	_reset() {
		this._music = sharedMusic;
		this.library = [];
		this.index = -1;
		this.owns = false;
		this._ready = null;
		this._pre = null;
		this._token = 0;
		this._changed.clear();
		this._released.clear();
	}
}

export const radio = new Radio();
