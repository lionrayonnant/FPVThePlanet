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

// Le jeton de la ligne « portrait » (#264). Une ligne comme les autres pour ce
// module, qui ne connaît que du texte ; c'est src/fpvtp-osd.js qui la remplace
// par le dessin de la machine. Exporté pour que les deux ne se contentent pas
// de tomber d'accord sur une chaîne recopiée.
export const PORTRAIT_LINE = '[PORTRAIT]';

// Mise en scène, pas mesure : ces durées sont un choix, et elles se relisent
// d'un coup d'œil. Secondes depuis l'impact.
export const TIMELINE = {
	blackoutAt: 0.9,        // l'image morte reste à l'écran jusque-là
	blackoutFade: 0.4,      // puis le noir monte en autant de secondes
	// Les lignes vides partagent l'horodatage de la ligne qui les suit (revue
	// finale, correction 6) : une ligne vide qui apparaît seule, une frame
	// avant son texte, romprait l'écart visuel qu'elle est censée créer. La
	// spec écrit ces blocs avec un blanc après LINK LOST et un autre avant
	// [ENTER] DISCONNECT — c'est ce que hud.js#flight-end div:empty rend déjà
	// pour l'écran de pose (MOTORS DISARMED / END SESSION).
	lines: [
		[1.6, 'LINK LOST'],
		[2.8, ''],
		[2.8, 'TARGET LOST'],
		[3.6, 'SESSION TERMINATED'],
		// Le portrait de la machine perdue (#264). Révision assumée de Bible §24
		// (« pas de grand écran de mort ») : ce n'est pas une récompense, c'est
		// ce qu'il reste. La sortie ne bouge pas — exitAt vaut toujours 4,6 s.
		// C'est src/fpvtp-osd.js qui remplace ce jeton par le dessin ; le module
		// reste pur, il ne connaît que des lignes.
		[4.0, PORTRAIT_LINE],
		[4.6, ''],
		[4.6, '[ENTER] DISCONNECT'],
		// #253 : REDEPLOY partage l'horodatage de DISCONNECT — les deux gestes
		// de sortie s'arment ensemble, jamais l'un avant l'autre.
		[4.6, '[R] REDEPLOY'],
	],
	exitAt: 4.6,            // la sortie s'arme avec la dernière ligne
};

// Symétrique de TIMELINE, pour la pose plutôt que le crash. Mise en scène, pas
// mesure, comme ci-dessus — mais une pose est un geste délibéré, pas une
// agonie : la séquence est plus courte et plus calme (pas d'image morte à
// laisser pourrir à l'écran, pas d'étapes intermédiaires façon LINK LOST /
// TARGET LOST). Secondes depuis disarm().
export const LANDING_TIMELINE = {
	blackoutAt: 0.6,        // l'image vivante reste à l'écran jusque-là
	blackoutFade: 0.4,      // puis le noir monte en autant de secondes
	// LANDING DETECTED / MOTORS DISARMED sont déjà là à t=0 (disarm() les fait
	// apparaître) ; les inclure ici aussi permet à la même _advanceTimeline()
	// de reconstruire la liste complète à chaque frame, crash ou pose. La
	// ligne vide partage l'horodatage de la ligne qui la suit, comme dans
	// TIMELINE ci-dessus.
	lines: [
		[0, 'LANDING DETECTED'],
		[0, 'MOTORS DISARMED'],
		[1.4, ''],
		[1.4, 'END SESSION'],
		[2.2, ''],
		[2.2, '[ENTER] DISCONNECT'],
		[2.2, '[R] REDEPLOY'],
	],
	exitAt: 2.2,            // la sortie s'arme avec la dernière ligne
};

// Troisième table : la sortie de zone (#139). TIMELINE commence par 0,9 s
// d'image morte laissée à l'écran, ce qui suppose un impact — une épave qui
// roule, et qu'on regarde. Une sortie de zone n'en a pas : l'image est déjà
// morte, progressivement, sur les derniers mètres du couloir. Il n'y a rien à
// laisser pourrir, donc le noir monte tout de suite, et la première ligne
// nomme la cause plutôt que de la faire deviner.
// Mise en scène, pas mesure — comme les deux tables au-dessus.
export const FENCE_TIMELINE = {
	blackoutAt: 0.3,
	blackoutFade: 0.5,
	lines: [
		[0, 'OUT OF COVERAGE'],
		[1.2, ''],
		[1.2, 'SIGNAL LOST'],
		[2.0, 'SESSION TERMINATED'],
		[3.0, ''],
		[3.0, '[ENTER] DISCONNECT'],
		[3.0, '[R] REDEPLOY'],
	],
	exitAt: 3.0,
};

// Quatrième table : la coupure volontaire du lien (#216). Un drone coincé
// dans une façade, calé sur un toit en pente ou retourné n'atteint jamais
// LANDING_READY et ne percute plus rien : sans ce geste il n'y a ni pose, ni
// crash, ni sortie — la session ne se ferme jamais et rien ne rend la main au
// terminal. Ce n'est pas un respawn : le drone est perdu comme après un crash,
// c'est seulement l'opérateur qui prononce la fin plutôt que la façade.
// Comme FENCE_TIMELINE, le noir monte tout de suite : les 0,9 s d'image morte
// de TIMELINE supposent une épave qui roule, et il n'y en a pas ici. Et comme
// elle, la première ligne nomme la cause plutôt que de la faire deviner.
// Mise en scène, pas mesure — comme les trois tables au-dessus.
export const CUT_TIMELINE = {
	blackoutAt: 0.3,
	blackoutFade: 0.5,
	lines: [
		[0, 'SIGNAL CUT'],
		[1.2, ''],
		[1.2, 'TARGET LOST'],
		[2.0, 'SESSION TERMINATED'],
		[3.0, ''],
		[3.0, '[ENTER] DISCONNECT'],
		[3.0, '[R] REDEPLOY'],
	],
	exitAt: 3.0,
};

// Le geste, et le rappel qui le fait découvrir. Choix, pas mesures.
//
// HOLD_S : couper le lien détruit la machine, donc ça ne peut pas être un
// appui. Deux secondes, c'est assez long pour qu'aucune touche effleurée ne le
// déclenche, assez court pour ne pas se sentir comme une punition.
//
// STUCK_S / V_STUCK / W_STUCK : quand afficher le RAPPEL, jamais quand
// autoriser le geste. Le geste, lui, est toujours disponible — c'est
// exactement ce qui fait qu'un faux négatif ici ne bloque personne, et
// pourquoi ces trois seuils n'ont pas à séparer un blocage d'un stationnaire
// tenu (V_STUCK est d'ailleurs bien au-dessus de LANDING.V_ON : on ne cherche
// pas la même chose). Au pire, le rappel s'affiche pour un pilote qui n'en
// avait pas besoin ; il ne manque à personne.
export const CUT = {
	HOLD_S: 2,      // s de maintien pour couper
	STUCK_S: 4,     // s d'immobilité avant que le rappel s'affiche
	V_STUCK: 0.5,   // m/s
	W_STUCK: 0.5,   // rad/s
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
	constructor({ timeline = TIMELINE, landingTimeline = LANDING_TIMELINE,
	              fenceTimeline = FENCE_TIMELINE, cutTimeline = CUT_TIMELINE,
	              landing = LANDING, cut = CUT } = {}) {
		this.timeline = timeline;
		this.landingTimeline = landingTimeline;
		this.fenceTimeline = fenceTimeline;
		this.cutTimeline = cutTimeline;
		this.landing = landing;
		this.cut = cut;
		// Muté chaque frame plutôt que recréé, comme link.out et wind.out : ceci
		// tourne à la fréquence d'affichage.
		this.out = {
			phase: FLYING, lines: [], linkDead: false,
			blackout: 0, exitArmed: false, closes: null,
			// #216 : le maintien en cours (0..1) et le rappel qui le fait
			// découvrir. Les deux sont de l'affichage : main.js les peint,
			// personne d'autre ne décide sur eux.
			cutProgress: 0, stuck: false,
		};
		this.reset();
	}

	get phase() { return this._phase; }

	reset() {
		this._phase = FLYING;
		this._t = 0;        // secondes depuis l'impact (ou depuis disarm(), en pose)
		this._hold = 0;     // secondes de pose stable accumulées
		this._pending = null;
		this._cutHold = 0;  // secondes de coupure tenue (#216)
		this._still = 0;    // secondes d'immobilité, pour le rappel (#216)
		// Quelle table _advanceTimeline() lit : posée à l'entrée en CRASHING ou en
		// LANDED, et jamais changée ensuite — TERMINATED doit continuer à lire la
		// table de celui qui l'y a mené, pas systématiquement celle du crash.
		this._activeTimeline = null;
		const o = this.out;
		o.phase = FLYING;
		o.lines.length = 0;
		o.linkDead = false;
		o.blackout = 0;
		o.exitArmed = false;
		o.closes = null;
		o.cutProgress = 0;
		o.stuck = false;
	}

	// Le geste explicite du joueur. Ne ferme la session que sur une pose
	// reconnue : désarmer en l'air est permis, mais c'est une chute, et c'est
	// l'impact qui conclura.
	disarm() {
		if (this._phase !== LANDING_READY) return false;
		this._phase = LANDED;
		this._t = 0;
		this._hold = 0;
		this._activeTimeline = this.landingTimeline;
		// t=0 : rejoue tout de suite ce que la table dit pour cet instant
		// (LANDING DETECTED / MOTORS DISARMED), pour que le joueur les voie sans
		// attendre le prochain update() — le geste du joueur ne passe pas par
		// update(). _advanceTimeline(0) n'arme pas exitArmed : exitAt=2.2 > 0.
		this._advanceTimeline(0);
		// exitArmed ne s'arme PAS ici : il s'arme à la toute fin de la séquence
		// de pose (voir _advanceTimeline), pas à la frame qui vidange `_pending`
		// (ancien comportement, revue finale correction 1) ni ici — désormais il
		// faut à la fois que la fermeture soit partie ET que la séquence soit
		// terminée (revue finale correction 2), sans quoi Échap pourrait sortir
		// au terminal pendant que le joueur regarde encore l'écran de pose.
		// Consommé par le prochain update() : la fermeture de session sort ainsi
		// toujours du même endroit, jamais du gestionnaire de touche.
		this._pending = 'LANDED';
		// Le geste du joueur ne passe pas par update(), donc on synchronise
		// o.phase ici pour que le changement d'état soit visible immédiatement.
		const o = this.out;
		o.phase = this._phase;
		return true;
	}

	update({ dt = 0, armed = false, height = Infinity, speed = 0,
	         angularSpeed = 0, throttle = 0, crashed = false,
	         outOfZone = false, cutHeld = false } = {}) {
		const o = this.out;
		// `closes` est un événement : visible une frame, jamais deux.
		o.closes = this._pending;
		this._pending = null;
		// `closes` continue de se vidanger ici inconditionnellement, y compris à
		// dt=0 (sim gelée) : un `update(dt=0)` doit pouvoir livrer l'événement
		// sans jamais le perdre, même si aucune frame non gelée ne tourne entre
		// le geste du joueur et Échap (revue finale, correction 1). L'armement
		// d'exitArmed, lui, ne dépend plus de cet instant : voir
		// _advanceTimeline, qui l'arme seul, à la fin de la séquence (correction
		// 2) — il faut à la fois que la fermeture soit partie *et* que le
		// joueur ait vu la séquence en entier.

		// Le maintien de la coupure (#216). Il ne s'accumule que tant qu'il y a
		// quelque chose à couper : une fois la fin de vol engagée, tenir la
		// touche ne rejoue rien, et le compteur retombe de lui-même. Le
		// relâchement remet à zéro plutôt que de décroître — un geste
		// destructeur se tient d'un trait, il ne se grignote pas en plusieurs
		// fois. À dt=0 (sim gelée) rien n'avance : on ne coupe pas en pause.
		const cuttable = this._phase === FLYING || this._phase === LANDING_READY;
		this._cutHold = (cutHeld && cuttable) ? this._cutHold + dt : 0;
		const cut = this._cutHold >= this.cut.HOLD_S;
		o.cutProgress = cuttable ? clamp01(this._cutHold / this.cut.HOLD_S) : 0;

		// Trois causes, une seule phase : l'écran meurt de la même façon, seule
		// la table change. L'ordre est celui de ce qui EST l'événement quand
		// plusieurs arrivent sur la même frame. `outOfZone` passe en premier —
		// si on percute une façade en franchissant le bord, c'est la sortie
		// l'événement, pas le choc. La coupure passe en dernier : elle n'est
		// jamais la cause quand le terrain, lui, a déjà tranché.
		const ends = outOfZone || crashed || cut;
		if (ends && this._phase !== CRASHING && this._phase !== TERMINATED
			&& this._phase !== LANDED) {
			this._phase = CRASHING;
			this._t = 0;
			this._hold = 0;
			this._activeTimeline = outOfZone ? this.fenceTimeline
				: crashed ? this.timeline
				: this.cutTimeline;
			o.lines.length = 0;
			// L'image meurt à l'instant du choc, avant tout texte.
			o.linkDead = true;
			o.closes = 'CRASHED';
		}

		// CRASHING/LANDED avancent tous deux la même horloge, juste sur une table
		// différente (this._activeTimeline, posée à l'entrée dans l'une ou
		// l'autre) ; TERMINATED doit continuer d'y lire une fois la séquence
		// finie, plutôt que de retomber sur celle du crash par défaut.
		if (this._phase === CRASHING || this._phase === LANDED || this._phase === TERMINATED) {
			this._advanceTimeline(dt);
			// Plus rien à débloquer : le rappel n'a plus lieu d'être.
			this._still = 0;
			o.stuck = false;
		} else if (this._phase === FLYING || this._phase === LANDING_READY) {
			this._advanceLanding({ dt, armed, height, speed, angularSpeed, throttle });
		}

		o.phase = this._phase;
	}

	// Partagée par le crash, la pose et la sortie de zone : seule la table
	// (this._activeTimeline) change. Les trois causes qu'une timeline avance
	// sont symétriques (une horloge, un fondu au noir, des lignes qui
	// apparaissent), donc une seule fonction plutôt que trois copies presque
	// identiques.
	_advanceTimeline(dt) {
		const o = this.out, tl = this._activeTimeline;
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
			// Une pose reconnue n'est pas un blocage : elle a déjà sa sortie (J).
			this._still = 0;
			o.stuck = false;
			// Hystérésis : on sort de la pose plus facilement qu'on n'y entre. Un
			// drone qui repart n'a pas à attendre T_HOLD pour cesser d'être posé.
			if (height > L.H_OFF || speed > L.V_OFF || !armed) {
				this._phase = FLYING;
				this._hold = 0;
				o.lines.length = 0;
			}
			return;
		}

		// Le rappel « tu peux couper » (#216). Immobile et armé sans qu'une pose
		// soit reconnue : coincé dans une façade, calé sur un toit, retourné —
		// ou simplement en stationnaire, et c'est sans conséquence, parce que
		// ceci n'autorise rien. Le geste, lui, reste toujours disponible.
		const C = this.cut;
		const still = armed && speed < C.V_STUCK && angularSpeed < C.W_STUCK;
		this._still = still ? this._still + dt : 0;
		o.stuck = this._still >= C.STUCK_S;

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
