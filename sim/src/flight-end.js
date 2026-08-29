// La fin d'un vol (PHASE 14). Machine à états pure : ni DOM, ni Three, ni
// Rapier. main.js l'alimente une fois par frame et obéit à ce qu'elle sort.
//
// Il n'y a pas de GAME OVER. Un crash n'est pas une défaite : c'est une machine
// distante qui cesse d'émettre. L'image meurt d'abord, le texte vient après, et
// c'est le joueur qui sort du contrôle — rien ne l'en sort à sa place.

export const FLYING = 'FLYING';
export const LANDING_READY = 'LANDING_READY';   // posé, encore armé
export const LANDED = 'LANDED';                 // posé, désarmé : fin propre
export const CRASHING = 'CRASHING';             // l'écran est en train de mourir
export const TERMINATED = 'TERMINATED';         // la séquence est finie

// Mise en scène, pas mesure : ces durées sont un choix, et elles se relisent
// d'un coup d'œil. Secondes depuis l'impact.
export const TIMELINE = {
	blackoutAt: 0.9,        // l'image morte reste à l'écran jusque-là
	blackoutFade: 0.4,      // puis le noir monte en autant de secondes
	lines: [
		[1.6, 'LINK LOST'],
		[2.8, 'TARGET LOST'],
		[3.6, 'SESSION TERMINATED'],
		[4.6, '[ESC] DISCONNECT'],
	],
	exitAt: 4.6,            // la sortie s'arme avec la dernière ligne
};

// Seuils de pose. PROVISOIRES : remplacés par tools/landing-selftest.mjs, qui
// les mesure. Ne pas les modifier à la main.
export const LANDING = {
	H_ON: 0.3,      // m, hauteur sol-drone sous laquelle on considère le contact
	H_OFF: 0.8,     // m, au-dessus de laquelle la pose est perdue (hystérésis)
	V_ON: 0.5,      // m/s
	V_OFF: 1.5,     // m/s
	W_ON: 0.5,      // rad/s — une sphère de collision qui roule n'est pas posée
	THR_IDLE: 0.06, // gaz coupés, même valeur que le `touchdown` de main.js
	T_HOLD: 1.0,    // s pendant lesquelles tout cela doit rester vrai
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class FlightEnd {
	constructor({ timeline = TIMELINE, landing = LANDING } = {}) {
		this.timeline = timeline;
		this.landing = landing;
		// Muté chaque frame plutôt que recréé, comme link.out et wind.out : ceci
		// tourne à la fréquence d'affichage.
		this.out = {
			phase: FLYING, lines: [], linkDead: false,
			blackout: 0, exitArmed: false, closes: null,
		};
		this.reset();
	}

	get phase() { return this._phase; }

	reset() {
		this._phase = FLYING;
		this._t = 0;        // secondes depuis l'impact
		this._hold = 0;     // secondes de pose stable accumulées
		this._pending = null;
		const o = this.out;
		o.phase = FLYING;
		o.lines.length = 0;
		o.linkDead = false;
		o.blackout = 0;
		o.exitArmed = false;
		o.closes = null;
	}

	// Le geste explicite du joueur. Ne ferme la session que sur une pose
	// reconnue : désarmer en l'air est permis, mais c'est une chute, et c'est
	// l'impact qui conclura.
	disarm() {
		if (this._phase !== LANDING_READY) return false;
		this._phase = LANDED;
		const o = this.out;
		o.lines.length = 0;
		o.lines.push('LANDING DETECTED', 'MOTORS DISARMED', '', 'END SESSION');
		o.exitArmed = true;
		// Consommé par le prochain update() : la fermeture de session sort ainsi
		// toujours du même endroit, jamais du gestionnaire de touche.
		this._pending = 'LANDED';
		// Le geste du joueur ne passe pas par update(), donc on synchronise
		// o.phase ici pour que le changement d'état soit visible immédiatement.
		o.phase = this._phase;
		return true;
	}

	update({ dt = 0, armed = false, height = Infinity, speed = 0,
	         angularSpeed = 0, throttle = 0, crashed = false } = {}) {
		const o = this.out;
		// `closes` est un événement : visible une frame, jamais deux.
		o.closes = this._pending;
		this._pending = null;

		if (crashed && this._phase !== CRASHING && this._phase !== TERMINATED
			&& this._phase !== LANDED) {
			this._phase = CRASHING;
			this._t = 0;
			this._hold = 0;
			o.lines.length = 0;
			// L'image meurt à l'instant du choc, avant tout texte.
			o.linkDead = true;
			o.closes = 'CRASHED';
		}

		if (this._phase === CRASHING || this._phase === TERMINATED) {
			this._advanceCrash(dt);
		} else if (this._phase === FLYING || this._phase === LANDING_READY) {
			this._advanceLanding({ dt, armed, height, speed, angularSpeed, throttle });
		}

		o.phase = this._phase;
	}

	_advanceCrash(dt) {
		const o = this.out, tl = this.timeline;
		this._t += dt;
		o.blackout = clamp01((this._t - tl.blackoutAt) / tl.blackoutFade);
		o.lines.length = 0;
		for (const [at, text] of tl.lines) if (this._t >= at) o.lines.push(text);
		if (this._t >= tl.exitAt) {
			this._phase = TERMINATED;
			o.exitArmed = true;
		}
	}

	// La pose, mesurée dans le temps plutôt que devinée sur une frame. Le faux
	// positif à écarter est le vol rasant : bas, mais rapide. C'est la vitesse
	// qui sépare les deux, la durée qui écarte les rebonds, et la vitesse
	// angulaire qui écarte la sphère de collision qui roule sans fin.
	_advanceLanding({ dt, armed, height, speed, angularSpeed, throttle }) {
		const o = this.out, L = this.landing;

		if (this._phase === LANDING_READY) {
			// Hystérésis : on sort de la pose plus facilement qu'on n'y entre. Un
			// drone qui repart n'a pas à attendre T_HOLD pour cesser d'être posé.
			if (height > L.H_OFF || speed > L.V_OFF || !armed) {
				this._phase = FLYING;
				this._hold = 0;
				o.lines.length = 0;
			}
			return;
		}

		const stable = armed
			&& height < L.H_ON
			&& speed < L.V_ON
			&& angularSpeed < L.W_ON
			&& throttle < L.THR_IDLE;
		this._hold = stable ? this._hold + dt : 0;
		if (this._hold >= L.T_HOLD) {
			this._phase = LANDING_READY;
			o.lines.length = 0;
			o.lines.push('LANDING DETECTED');
		}
	}
}
