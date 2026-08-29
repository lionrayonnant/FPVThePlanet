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
	// Les lignes vides partagent l'horodatage de la ligne qui les suit (revue
	// finale, correction 6) : une ligne vide qui apparaît seule, une frame
	// avant son texte, romprait l'écart visuel qu'elle est censée créer. La
	// spec écrit ces blocs avec un blanc après LINK LOST et un autre avant
	// [ESC] DISCONNECT — c'est ce que hud.js#flight-end div:empty rend déjà
	// pour l'écran de pose (MOTORS DISARMED / END SESSION).
	lines: [
		[1.6, 'LINK LOST'],
		[2.8, ''],
		[2.8, 'TARGET LOST'],
		[3.6, 'SESSION TERMINATED'],
		[4.6, ''],
		[4.6, '[ESC] DISCONNECT'],
	],
	exitAt: 4.6,            // la sortie s'arme avec la dernière ligne
};

// Seuils de pose, mesurés par tools/landing-selftest.mjs sur
// public/scenes/tour-eiffel le 2026-08-29 : quatre poses (1 m, 3 m, 8 m, vent
// de travers 8 m/s) se stabilisent toutes sous h=0,1488 m / v=0,0050 m/s /
// w=0,0336 rad/s (0,1488 m ~ le rayon 0,15 m du collider sphérique : le drone
// touche le sol). Neuf rasants (hauteur visée 0,3-1 m, tangage 0,3-1) ne
// descendent jamais sous v=0,809 m/s en vol, même quand la hauteur elle-même
// frôle 0,15 m un instant — c'est donc la vitesse, pas la hauteur seule, qui
// écarte ce faux positif.
// Un dixième cas, un stationnaire bas gaz mis (h~0,5 m, v jusqu'à 0,0008
// m/s), chevauche largement la vitesse posée : la vitesse ne sépare pas un
// vol stationnaire tenu d'une pose. C'est THR_IDLE qui l'écarte (le gaz y
// reste nettement au-dessus du seuil de gaz coupés, et la hauteur au-dessus
// de H_ON) — pas V_ON, qui est donc calé sur la séparation réelle : le
// rasant le plus lent mesuré, pas ce stationnaire.
// H_ON = 0,1488 × 1,3 arrondi. V_ON = milieu en échelle log entre la vitesse
// posée (0,0050) et celle du rasant le plus lent (0,809) : sqrt(0,0050 ×
// 0,809) ≈ 0,064, arrondi à 0,06. H_OFF et V_OFF sont l'hystérésis de
// sortie, pas une mesure. W_ON = 2 × 0,0336.
// T_HOLD, en revanche, ne sépare rien : mesuré en ne faisant varier que lui
// (tools/landing-selftest.mjs, 2026-08-29), un T_HOLD quasi nul (0,004 s)
// laisse déjà le rebond écarté jusqu'à t=0,64 s et le roulé jusqu'à t=0,48 s
// — au-delà des gardes `notBefore` du banc. C'est donc H_ON/V_ON/W_ON seuls
// qui font la séparation géométrique ; T_HOLD n'ajoute qu'un retard
// constant. Il reste une marge de confirmation *choisie* contre le bruit non
// modélisé (vibration de contact, jitter physique), au même titre que
// TIMELINE — 0,25 s parce que ça tient (poses toutes reconnues, aucun
// rasant détecté) sans se sentir long en jeu.

// THR_IDLE n'a plus de valeur unique : la poussée n'est pas linéaire en gaz
// (omega = omegaMax*cmd^rpmCurve, poussée ∝ omega²), donc le manche en-dessous
// duquel l'appareil ne peut plus se retenir de descendre dépend de la
// famille — voir `idleThrottle()` dans src/quad.js, qui le dérive par famille
// (poussée = moitié du poids). Ce module reste pur (pas d'aéronef ici) : 0,06
// ci-dessous n'est qu'un repli pour les bancs headless qui construisent
// `FlightEnd` sans passer de `landing` — c'est main.js qui pose la vraie
// valeur, dérivée de la famille en vol, dans le `landing` qu'il fournit à la
// construction.
export const LANDING = {
	H_ON: 0.2,      // m, hauteur sol-drone sous laquelle on considère le contact
	H_OFF: 0.4,     // m, au-dessus de laquelle la pose est perdue (hystérésis)
	V_ON: 0.06,     // m/s
	V_OFF: 0.18,    // m/s
	W_ON: 0.07,     // rad/s — une sphère de collision qui roule n'est pas posée
	THR_IDLE: 0.06, // repli headless (voir ci-dessus) ; main.js injecte la vraie valeur
	T_HOLD: 0.25,   // s pendant lesquelles tout cela doit rester vrai
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
		// exitArmed ne s'arme PAS ici : il s'arme dans update(), à la frame qui
		// vidange réellement `_pending` vers `out.closes` (revue finale,
		// correction 1). Sinon Échap pourrait sortir au terminal pendant que la
		// requête de fermeture de session est encore en vol.
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
		// C'est ici, à la frame qui vidange réellement la fermeture 'LANDED',
		// que la sortie s'arme — pas au moment de disarm() (correction 1) : un
		// `update(dt=0)` (sim gelée) doit pouvoir vidanger `closes` sans jamais
		// perdre l'événement, y compris quand aucune frame non gelée ne tourne
		// entre le geste du joueur et Échap.
		if (o.closes === 'LANDED') o.exitArmed = true;

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
	// qui sépare les deux et la vitesse angulaire qui écarte la sphère de
	// collision qui roule sans fin ; T_HOLD n'écarte rien lui-même (mesuré,
	// voir le commentaire de LANDING ci-dessus), c'est une marge de
	// confirmation contre le bruit non modélisé.
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
