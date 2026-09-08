// La fin d'un vol (PHASE 14). Machine à états pure : ni DOM, ni Three, ni
// Rapier. main.js l'alimente une fois par frame et obéit à ce qu'elle sort.
//
// Il n'y a pas de GAME OVER. Un crash n'est pas une défaite : c'est une machine
// distante qui cesse d'émettre. L'image meurt d'abord, le texte vient après, et
// c'est le joueur qui sort du contrôle — rien ne l'en sort à sa place.
//
// Révision 2026-09-08 (D9) : l'atterrissage a disparu. Un vol se termine par un
// crash, une sortie de zone ou la coupure volontaire du lien (K tenue) — il n'y
// a plus de pose reconnue, plus de désarmement, plus de verdict LANDED.

export const FLYING = 'FLYING';
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
	// [ESC] DISCONNECT — c'est ce que hud.js#flight-end div:empty rend.
	//
	// D15: the line names ESCAPE, the key that goes back everywhere else in the
	// game. Enter keeps working silently — in browser fullscreen Escape is
	// confiscated to leave fullscreen, so a second way out has to exist.
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
		[4.6, '[ESC] DISCONNECT'],
		// #253 : REDEPLOY partage l'horodatage de DISCONNECT — les deux gestes
		// de sortie s'arment ensemble, jamais l'un avant l'autre.
		[4.6, '[R] REDEPLOY'],
	],
	exitAt: 4.6,            // la sortie s'arme avec la dernière ligne
};

// Deuxième table : la sortie de zone (#139). TIMELINE commence par 0,9 s
// d'image morte laissée à l'écran, ce qui suppose un impact — une épave qui
// roule, et qu'on regarde. Une sortie de zone n'en a pas : l'image est déjà
// morte, progressivement, sur les derniers mètres du couloir. Il n'y a rien à
// laisser pourrir, donc le noir monte tout de suite, et la première ligne
// nomme la cause plutôt que de la faire deviner.
// Mise en scène, pas mesure — comme la table au-dessus.
export const FENCE_TIMELINE = {
	blackoutAt: 0.3,
	blackoutFade: 0.5,
	lines: [
		[0, 'OUT OF COVERAGE'],
		[1.2, ''],
		[1.2, 'SIGNAL LOST'],
		[2.0, 'SESSION TERMINATED'],
		// D12 : le portrait, à la même place que sur la table du crash — 0,4 s
		// après le constat, avant que la sortie s'arme. Une machine perdue hors
		// couverture est perdue autant qu'une machine encastrée : il n'y avait
		// aucune raison de ne la montrer qu'après un impact.
		[2.4, PORTRAIT_LINE],
		[3.0, ''],
		[3.0, '[ESC] DISCONNECT'],
		[3.0, '[R] REDEPLOY'],
	],
	exitAt: 3.0,
};

// Troisième table : la coupure volontaire du lien (#216). Un drone coincé dans
// une façade, calé sur un toit en pente, retourné — ou simplement posé au sol,
// depuis que l'atterrissage n'est plus une fin (D9, 2026-09-08) — ne percute
// plus rien : sans ce geste il n'y a ni crash, ni sortie, la session ne se
// ferme jamais et rien ne rend la main au terminal. Ce n'est pas un respawn :
// le drone est perdu comme après un crash, c'est seulement l'opérateur qui
// prononce la fin plutôt que la façade.
// Comme FENCE_TIMELINE, le noir monte tout de suite : les 0,9 s d'image morte
// de TIMELINE supposent une épave qui roule, et il n'y en a pas ici. Et comme
// elle, la première ligne nomme la cause plutôt que de la faire deviner.
// Mise en scène, pas mesure — comme les deux tables au-dessus.
export const CUT_TIMELINE = {
	blackoutAt: 0.3,
	blackoutFade: 0.5,
	lines: [
		[0, 'SIGNAL CUT'],
		[1.2, ''],
		[1.2, 'TARGET LOST'],
		[2.0, 'SESSION TERMINATED'],
		// D12 : le portrait, comme sur les deux autres tables. C'est l'opérateur
		// qui a prononcé la fin, la machine est perdue pareil — et c'est la
		// seule fin qu'on choisit, donc la seule où l'on prend le temps.
		[2.4, PORTRAIT_LINE],
		[3.0, ''],
		[3.0, '[ESC] DISCONNECT'],
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
// tenu. V_STUCK/W_STUCK à 0,5 : un demi-mètre par seconde et un demi-radian
// par seconde sont grossièrement au-dessus du bruit d'un appareil calé (le
// contact et la friction laissent des résidus bien plus petits) et
// nettement en dessous de ce qu'un pilote qui manœuvre produit. Depuis que
// l'atterrissage n'est plus une fin (D9, 2026-09-08) le rappel est la SEULE
// issue d'un drone au sol : il doit donc s'afficher aussi sur une pose
// parfaite, ce que ces seuils larges garantissent. Au pire il s'affiche pour
// un pilote qui n'en avait pas besoin ; il ne manque à personne.
export const CUT = {
	HOLD_S: 2,      // s de maintien pour couper
	STUCK_S: 4,     // s d'immobilité avant que le rappel s'affiche
	V_STUCK: 0.5,   // m/s
	W_STUCK: 0.5,   // rad/s
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class FlightEnd {
	constructor({ timeline = TIMELINE, fenceTimeline = FENCE_TIMELINE,
	              cutTimeline = CUT_TIMELINE, cut = CUT } = {}) {
		this.timeline = timeline;
		this.fenceTimeline = fenceTimeline;
		this.cutTimeline = cutTimeline;
		this.cut = cut;
		// Muté chaque frame plutôt que recréé, comme link.out et wind.out : ceci
		// tourne à la fréquence d'affichage.
		this.out = {
			phase: FLYING, lines: [], linkDead: false,
			blackout: 0, exitArmed: false, closes: null,
			// #216 : le maintien en cours (0..1) et le rappel qui le fait
			// découvrir. Les deux sont de l'affichage : main.js les peint,
			// personne d'autre ne décide sur eux.
			cutProgress: 0, stuck: false, cuttable: true,
		};
		this.reset();
	}

	get phase() { return this._phase; }

	reset() {
		this._phase = FLYING;
		this._t = 0;        // secondes depuis l'impact
		this._pending = null;
		this._cutHold = 0;  // secondes de coupure tenue (#216)
		this._still = 0;    // secondes d'immobilité, pour le rappel (#216)
		// Quelle table _advanceTimeline() lit : posée à l'entrée en CRASHING, et
		// jamais changée ensuite — TERMINATED doit continuer à lire la table de
		// celui qui l'y a mené, pas systématiquement celle du crash.
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
		o.cuttable = true;
	}

	// `height` et `throttle` ont disparu de l'entrée avec l'atterrissage (D9,
	// 2026-09-08) : plus rien ici ne regarde le sol ni le manche de gaz.
	update({ dt = 0, armed = false, speed = 0, angularSpeed = 0,
	         crashed = false, outOfZone = false, cutHeld = false } = {}) {
		const o = this.out;
		// `closes` est un événement : visible une frame, jamais deux.
		o.closes = this._pending;
		this._pending = null;
		// `closes` continue de se vidanger ici inconditionnellement, y compris à
		// dt=0 (sim gelée) : un `update(dt=0)` doit pouvoir livrer l'événement
		// sans jamais le perdre, même si aucune frame non gelée ne tourne entre
		// le geste du joueur et Échap (revue finale, correction 1). L'armement
		// d'exitArmed, lui, ne dépend pas de cet instant : voir
		// _advanceTimeline, qui l'arme seul, à la fin de la séquence (correction
		// 2) — il faut à la fois que la fermeture soit partie *et* que le
		// joueur ait vu la séquence en entier.

		// Le maintien de la coupure (#216). Il ne s'accumule que tant qu'il y a
		// quelque chose à couper : une fois la fin de vol engagée, tenir la
		// touche ne rejoue rien, et le compteur retombe de lui-même. Le
		// relâchement remet à zéro plutôt que de décroître — un geste
		// destructeur se tient d'un trait, il ne se grignote pas en plusieurs
		// fois. À dt=0 (sim gelée) rien n'avance : on ne coupe pas en pause.
		const cuttable = this._phase === FLYING;
		o.cuttable = cuttable;
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
		if (ends && this._phase !== CRASHING && this._phase !== TERMINATED) {
			this._phase = CRASHING;
			this._t = 0;
			this._activeTimeline = outOfZone ? this.fenceTimeline
				: crashed ? this.timeline
				: this.cutTimeline;
			o.lines.length = 0;
			// L'image meurt à l'instant du choc, avant tout texte.
			o.linkDead = true;
			o.closes = 'CRASHED';
		}

		// CRASHING et TERMINATED avancent la même horloge sur la table posée à
		// l'entrée (this._activeTimeline) : TERMINATED doit continuer d'y lire
		// une fois la séquence finie, plutôt que de retomber sur celle du crash
		// par défaut.
		if (this._phase === CRASHING || this._phase === TERMINATED) {
			this._advanceTimeline(dt);
			// Plus rien à débloquer : le rappel n'a plus lieu d'être.
			this._still = 0;
			o.stuck = false;
		} else {
			// Le rappel « tu peux couper » (#216), en vol seulement. Immobile et
			// armé : coincé dans une façade, calé sur un toit, retourné, posé au
			// sol — ou simplement en stationnaire, et c'est sans conséquence,
			// parce que ceci n'autorise rien. Le geste, lui, reste toujours
			// disponible. Depuis que l'atterrissage n'est plus une fin (D9,
			// 2026-09-08), c'est le seul chemin qui sorte un drone intact.
			const C = this.cut;
			const still = armed && speed < C.V_STUCK && angularSpeed < C.W_STUCK;
			this._still = still ? this._still + dt : 0;
			o.stuck = this._still >= C.STUCK_S;
		}

		o.phase = this._phase;
	}

	// Partagée par le crash, la sortie de zone et la coupure : seule la table
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
}
