// PHASE 12 — l'OSD FPVTP!, la couche locale. Injectée par notre station,
// au-dessus de l'image reçue : elle ne traverse pas la liaison, donc rien ne la
// dégrade. C'est la moitié stable du double HUD.
//
// Toujours métrique, même quand la cible affiche des pieds : c'est NOTRE
// station. Le désaccord entre les deux systèmes fait partie du propos.

// Constante de lore, pas une version de paquet.
export const FPVTP_VERSION = '0.97b';

// D'où le vent pousse, dans le repère du drone : l'index 0 est droit devant.
const ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

const clock = (s) => {
	const t = Math.max(0, Math.floor(s));
	return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// Ce que la ligne de vol du HUD annonce. Sorti en fonction PURE parce que c'est
// un invariant de fiction, pas de la mise en forme : un vol qui n'ouvre aucune
// session ne doit pas écrire SESSION — le HUD mentirait sur ce que le vol est en
// train de faire.
//
//   BENCH   — le banc : pas de session, et pas de temps à compter non plus.
//   LIVE    — terrain streamé (#218). Le vol est une session comme une autre —
//             cible, exemplaire, hack, rituel, trace au journal — mais le
//             terrain n'est PAS sur le disque : pas de clôture, et le relief
//             arrive pendant qu'on vole. C'est ce que la ligne signale.
//   SESSION — un vol de terrain sur une zone acquise.
export function flightLabel({ bench = false, live = false, sessionSeconds = 0 } = {}) {
	if (bench) return 'BENCH';
	return `${live ? 'LIVE' : 'SESSION'} ${clock(sessionSeconds ?? 0)}`;
}

export class FpvtpOsd {
	constructor(root) {
		root.insertAdjacentHTML('beforeend', `
			<div id="fpvtp-osd" hidden>
				<div class="corner tl">
					<div id="fo-ident">FPVTP! // ${FPVTP_VERSION}</div>
					<div id="fo-operator">OPERATOR // —</div>
					<div id="fo-session">SESSION 00:00</div>
				</div>
				<div class="corner tr">
					<div id="fo-mode">ACRO</div>
					<div id="fo-rates">—</div>
					<div id="fo-input">KEYBOARD</div>
					<div id="fo-fps">—</div>
				</div>
				<div class="corner bl">
					<div id="fo-env">WIND — · VIS — · LINK —</div>
					<div id="fo-photo"></div>
				</div>
				<div class="corner br">
					<div id="fo-credit"></div>
				</div>
				<div id="fo-pause" hidden>PAUSED<small>PRESS SPACE</small></div>
				<div id="fo-status" hidden></div>
				<div id="fo-cut" hidden><span id="fo-cut-text"></span><i id="fo-cut-bar"></i></div>
				<div id="flight-end" hidden></div>
			</div>`);

		const q = (s) => root.querySelector(s);
		this.el = {
			root: q('#fpvtp-osd'),
			operator: q('#fo-operator'),
			session: q('#fo-session'),
			mode: q('#fo-mode'),
			rates: q('#fo-rates'),
			input: q('#fo-input'),
			fps: q('#fo-fps'),
			env: q('#fo-env'),
			photo: q('#fo-photo'),
			credit: q('#fo-credit'),
			pause: q('#fo-pause'),
			status: q('#fo-status'),
			cut: q('#fo-cut'),
			cutText: q('#fo-cut-text'),
			cutBar: q('#fo-cut-bar'),
			flightEnd: q('#flight-end'),
		};
		this._frames = 0;
		this._fpsAt = performance.now();
		this._fps = 0;
		this._endLines = '';
		// Les deux états centraux occupent la même place. Ils ne s'excluent pas
		// dans le monde — on peut être en pause sur un drone détruit — donc ils
		// sont tenus ici, et un seul est peint.
		this._paused = false;
		this._status = null;
		// PHASE 16 : disponibilité de la capture, compteur et flash bref au clic.
		this._photoReady = false;
		this._photoCount = 0;
		this._flashUntil = 0;
		// #216 : le dernier libellé peint, pour ne pas réécrire le DOM à 60 Hz.
		this._cutText = '';
	}

	show() { this.el.root.hidden = false; }
	setPaused(paused) { this._paused = !!paused; this._refreshCentre(); }

	// Crédit fournisseur. Discret et permanent : Google impose d'afficher les
	// copyrights des tuiles rendues, et on applique la même règle à tous les
	// fournisseurs. Sur la couche FPVTP!, jamais sur l'OSD du drone — c'est la
	// station qui crédite, pas l'appareil (issue #18).
	setCredit(text) {
		this.el.credit.textContent = text ?? '';
	}

	// Disponibilité de la capture (PHASE 16) : vrai seulement quand ce qu'on
	// verrait à l'écran est vraiment le flux de la cible (en vol, armé, pas en
	// caméra libre, pas pendant l'agonie du lien).
	setPhotoReady(ready) { this._photoReady = !!ready; this._renderPhoto(); }

	// `count` est celui que le serveur a renvoyé — il fait autorité, pas un
	// compteur client optimiste qui pourrait diverger d'un échec réseau silencieux.
	//
	// `null` veut dire « rien n'a été compté » : c'est le banc (PHASE 26), où
	// l'image part sur le disque de l'opérateur sans que rien ne l'enregistre.
	// Il n'y a donc pas de total à afficher, et en inventer un serait mentir
	// sur ce que le mode promet.
	flashCaptured(count) {
		this._photoCount = count;
		this._flashUntil = performance.now() + 900;
		this._renderPhoto();
	}

	_renderPhoto() {
		const e = this.el.photo;
		if (performance.now() < this._flashUntil) {
			e.textContent = this._photoCount === null
				? 'FRAME DUMPED'
				: `CAPTURED · CAPTURES ${this._photoCount}`;
			e.dataset.flash = '1';
			return;
		}
		delete e.dataset.flash;
		e.textContent = this._photoReady
			? `PHOTO READY${this._photoCount ? ` · CAPTURES ${this._photoCount}` : ''}`
			: '';
	}

	// Verdict de fin de session (PHASE 06). kind: 'landed' | 'lost' | null.
	setSessionStatus(text, kind = null) {
		this._status = text ? { text, kind } : null;
		this._refreshCentre();
	}

	// Priorité explicite : verdict de session > pause. Un seul visible, sans
	// quoi les deux se superposent lettre sur lettre au même endroit.
	_refreshCentre() {
		const e = this.el.status;
		if (this._status) {
			e.innerHTML = this._status.text;
			if (this._status.kind) e.dataset.kind = this._status.kind;
			else delete e.dataset.kind;
		}
		e.hidden = !this._status;
		this.el.pause.hidden = !!this._status || !this._paused;
	}

	// La coupure du lien (#216). Deux choses au même endroit, et jamais en même
	// temps : le RAPPEL qu'elle existe, quand la machine a l'air coincée, et la
	// JAUGE du maintien en cours. Le rappel est conditionnel ; le geste, lui,
	// est toujours disponible — c'est ce qui fait qu'un rappel manqué ne
	// bloque personne, et c'est pour ça que rien ici ne décide de quoi que ce
	// soit : flight-end.js a déjà tranché, on peint.
	//
	// Nommer la touche à l'écran est le sujet même de l'issue : sans ça le
	// geste existe et personne ne le trouve.
	setCut({ stuck = false, cutProgress = 0 } = {}) {
		const e = this.el.cut;
		const cutting = cutProgress > 0;
		if (!cutting && !stuck) {
			if (!e.hidden) { e.hidden = true; this._cutText = ''; }
			return;
		}
		e.hidden = false;
		const text = cutting ? 'CUTTING LINK' : '[HOLD K] CUT LINK';
		if (text !== this._cutText) {
			this._cutText = text;
			this.el.cutText.textContent = text;
		}
		// La barre ne vit que pendant le maintien : hors maintien, le rappel est
		// une phrase, pas une jauge à zéro qui laisserait croire qu'il se passe
		// déjà quelque chose.
		this.el.cutBar.hidden = !cutting;
		this.el.cutBar.style.width = `${Math.round(cutProgress * 100)}%`;
	}

	// L'écran de fin de vol (PHASE 14). Il n'annonce pas une défaite : il montre
	// un lien qui s'éteint. `blackout` est l'opacité du noir qui recouvre la
	// dernière image, `lines` ce qui s'écrit dessus, une ligne à la fois.
	// Repris tel quel de l'ancien hud.js — c'est la couche locale qui porte
	// cette mise en scène, elle ne traverse pas la liaison.
	setFlightEnd({ lines, blackout }) {
		const e = this.el.flightEnd;
		if (!lines.length && blackout <= 0) {
			if (!e.hidden) { e.hidden = true; e.textContent = ''; this._endLines = ''; }
			return;
		}
		e.hidden = false;
		e.style.background = `rgba(10, 9, 8, ${blackout})`; // --black (issue #224)
		// Le DOM n'est reconstruit que quand le texte change : ceci tourne à la
		// fréquence d'affichage pendant toute la séquence.
		const key = lines.join('\n');
		if (key !== this._endLines) {
			this._endLines = key;
			e.replaceChildren(...lines.map((text) => {
				const d = document.createElement('div');
				d.textContent = text;
				return d;
			}));
		}
	}

	get fps() { return this._fps; }

	update({ mode, rates, usingGamepad, windMs, windRelRad, visibilityM,
	         rssiDbm, operator, sessionSeconds, propwash, bench = false, live = false }) {
		this.el.mode.textContent = String(mode).toUpperCase();
		if (rates) this.el.rates.textContent = rates;
		this.el.input.textContent = usingGamepad ? 'GAMEPAD' : 'KEYBOARD';
		this.el.operator.textContent = `OPERATOR // ${operator ?? '—'}`;
		// Au banc il n'y a pas de session : la ligne dit ce qu'elle est plutôt
		// que de compter le temps d'une chose qui n'existe pas. C'est le seul
		// endroit du HUD où le banc se signale, et il suffit.
		//
		// Une reconnaissance (#206) n'en ouvre pas non plus — rien n'est écrit,
		// donc écrire SESSION serait un mensonge du HUD sur ce que le vol est en
		// train de faire. Elle garde son chronomètre : le temps de vol se lit,
		// même quand il ne s'enregistre nulle part.
		this.el.session.textContent = flightLabel({ bench, live, sessionSeconds });

		// Une seule ligne d'environnement : trois nombres que l'opérateur lit
		// d'un coup, pas trois blocs qui se disputent un coin.
		const parts = [];
		if (Number.isFinite(windMs) && windMs >= 0.5) {
			const i = ((Math.round(((windRelRad ?? 0) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
			parts.push(`WIND ${windMs.toFixed(1)} m/s ${ARROWS[i]}`);
		} else {
			parts.push('WIND CALM');
		}
		if (Number.isFinite(visibilityM)) parts.push(`VIS ${(visibilityM / 1000).toFixed(1)} km`);
		// LOOPBACK plutôt qu'un RSSI : afficher −41 dBm là où le flux ne
		// traverse rien serait un chiffre inventé, et ce HUD ne montre que ce
		// qu'il sait (Bible §2, « Information, not assistance »).
		if (bench) parts.push('LINK LOOPBACK');
		else if (Number.isFinite(rssiDbm)) parts.push(`LINK ${Math.round(rssiDbm)} dBm`);
		this.el.env.textContent = parts.join(' · ');
		// Rafraîchi ici aussi pour que le flash de capture (PHASE 16) s'éteigne
		// de lui-même, sans minuteur séparé : cette fonction tourne déjà à 60 Hz.
		this._renderPhoto();

		this._frames++;
		const now = performance.now();
		if (now - this._fpsAt > 500) {
			this._fps = Math.round(this._frames * 1000 / (now - this._fpsAt));
			this.el.fps.textContent = `${this._fps} fps`;
			this._frames = 0;
			this._fpsAt = now;
		}
	}
}
