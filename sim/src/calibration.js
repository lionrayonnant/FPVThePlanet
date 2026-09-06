// Calibrage guidé d'une radio ou d'une manette (issue #277).
//
// Ce module MESURE le périphérique là où input.js le DEVINE : padKind() lit une
// chaîne USB et en déduit un profil figé, ce qui laisse une radio absente de la
// liste des marques tomber sur un ordre d'axes faux ET un gaz en demi-course.
// Ici rien n'est déduit d'un nom : on demande un geste à la fois et on regarde
// ce qui a bougé.
//
// Machine à états PURE : pas de DOM, pas de localStorage, pas de temps réel —
// elle reçoit un instantané `pad.axes` et un `dt` en millisecondes, et rend
// l'état suivant. C'est ce qui la rend rejouable dans
// tools/calibration-selftest.mjs, où les séquences de vrai matériel (EdgeTX,
// DualShock 4) sont vérifiées sans manette branchée.
//
// Les consignes sont en ANGLAIS : c'est la langue de l'interface du jeu (D5,
// issue #120). Les commentaires restent en français, comme partout ici.

// Ordre des consignes. Le gaz d'abord : c'est lui qui décide du mode de course
// (phase 'throttle-release'), et le mode de course change la façon de lire
// l'axe pour tout le reste de la session.
export const CAL_CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'];

// -----------------------------------------------------------------------------
// CE QU'ON MESURE : TOUT CE QUE LE PÉRIPHÉRIQUE RAPPORTE (issue #279)
//
// Un manche n'est pas forcément sur un axe. Firefox applique
// `mapping: "standard"` à une radio EdgeTX et range son manche des gaz dans
// l'emplacement de la gâchette L2 : le gaz sort alors sur `buttons[6].value`,
// analogique, et le quatrième axe reste mort. Mesuré sur une Radiomaster
// Pocket — `btn 6` y lit 0.997, valeur qu'un bouton NUMÉRIQUE ne peut pas
// rendre.
//
// #277 refusait déjà de déduire quoi que ce soit du nom USB, mais gardait
// cette supposition-là sans l'avoir mesurée. Ici, axes et boutons entrent dans
// un vecteur unique et sont traités pareil.
//
// Les boutons y sont ramenés sur la course des axes — repos à -1, pleine
// pression à +1 — pour deux raisons : tous les seuils du module (PUSH_MIN,
// HOLD_TOL, REST_MAX_SPREAD…) sont calibrés sur une course de 2 et gardent
// ainsi le sens qu'on leur a mesuré ; et une gâchette au repos se lit alors
// exactement comme un manche des gaz à friction parqué en bas, ce qu'elle est.
// -----------------------------------------------------------------------------

export function padSignals(pad) {
	const axes = pad?.axes ?? [];
	const buttons = pad?.buttons ?? [];
	return [...axes, ...buttons.map((b) => (b?.value ?? 0) * 2 - 1)];
}

// Un pilote qui lit « axis 14 » sur un périphérique qui annonce 8 axes croit à
// un bug. Le récapitulatif doit nommer l'entrée telle que le navigateur la
// nomme.
export function signalLabel(i, axisCount) {
	return i < axisCount ? `axis ${i}` : `btn ${i - axisCount}`;
}

// Le geste demandé désigne toujours la direction POSITIVE du canal, telle que
// flightController l'attend : gaz en haut, lacet à droite, roulis à droite, et
// tangage POSITIF = cabrer (input.js : « stick poussé vers l'avant = nez qui
// pique », donc tiré vers soi = cabrer). Demander « tire vers toi » plutôt que
// « pousse en avant » évite d'avoir à expliquer une inversion au pilote.
//
// La consigne est COURTE — elle est affichée en 22 px dans un panneau étroit,
// et une consigne qui se coupe en deux au milieu d'une phrase se lit deux fois.
// Ce qui l'explique va dans CAL_HINTS, à la taille du texte courant.
export const CAL_PROMPTS = {
	rest: 'HANDS OFF',
	throttle: 'THROTTLE — FULL UP',
	yaw: 'YAW — FULL RIGHT',
	pitch: 'PITCH — PULL BACK',
	roll: 'ROLL — FULL RIGHT',
	throttleRelease: 'THROTTLE — LET GO',
	throttleMin: 'THROTTLE — FULL DOWN',
	done: 'CALIBRATED',
};

export const CAL_HINTS = {
	rest: 'measuring the neutral — do not touch the sticks',
	throttle: 'push it there and hold',
	yaw: 'push it there and hold',
	pitch: 'toward you — that is nose up',
	roll: 'push it there and hold',
	throttleRelease: 'let go and wait — full or half travel?',
	throttleMin: 'hold it at the bottom',
	done: '',
};

export const CAL_TIMING = {
	// Fenêtre de repos : assez longue pour voir le bruit d'un gimbal Hall,
	// assez courte pour ne pas donner l'impression que rien ne se passe.
	restMs: 1000,
	// Combien de temps le manche doit rester à sa butée pour qu'on la retienne.
	// Sans maintien, un passage rapide donne une butée sous-estimée — et une
	// butée sous-estimée fait saturer la commande avant la fin de la course.
	holdMs: 400,
	// Le pilote a le temps de lâcher avant qu'on lise sa position de repos.
	// Sans ce délai, on lirait le manche encore tenu à fond et on conclurait
	// « à friction » sur une manette parfaitement auto-centrée.
	releaseMinMs: 800,
	// Au bout de ce temps sans le moindre geste, la consigne le dit. Assez long
	// pour qu'un pilote qui cherche son manche ne soit pas accusé de rien faire,
	// assez court pour ne pas laisser quelqu'un devant un écran mort.
	idleWarnMs: 6000,
};

// Ce qu'on affiche quand plus rien ne bouge. Un périphérique muet — mauvais
// pad sélectionné, radio pas en mode Joystick, manche sur une entrée que le
// navigateur ne rapporte pas — passe l'étape du repos MIEUX qu'un vrai : bruit
// nul, donc aucun rejet. Sans ce message, il ne reste qu'une consigne qui ne
// bouge jamais et rien pour dire pourquoi (issue #279).
const IDLE_MESSAGE = 'no movement seen — wrong device, or this stick is not reported';

// Au-delà de cette amplitude pendant la fenêtre de repos, ce n'est plus du
// bruit : quelqu'un tient un manche. On recommence la mesure.
const REST_MAX_SPREAD = 0.15;

// Le deadband mesuré couvre le bruit avec de la marge, borné des deux côtés :
// un plancher pour ne pas croire un périphérique parfait, un plafond pour ne
// pas manger la course si l'utilisateur a bougé pendant le repos.
const NOISE_MARGIN = 1.5;
const DEADBAND_MIN = 0.02;
const DEADBAND_MAX = 0.25;

// Écart au neutre en dessous duquel on considère qu'aucun geste n'a été fait.
// En unités d'axe brutes, où la course pleine vaut 2.
const PUSH_MIN = 0.5;

// Tolérance de « le manche ne bouge plus » et de « le manche est revenu au
// neutre ».
const HOLD_TOL = 0.1;
const RETURN_TOL = 0.2;

// L'axe retenu doit dominer nettement le deuxième. Un pilote qui pousse en
// diagonale produit deux déviations comparables : mieux vaut redemander que
// d'attribuer au hasard un mappage qu'il croira ensuite calibré.
const AMBIGUITY_RATIO = 2;

function restState(signalCount, axisCount, message = null) {
	return {
		phase: 'rest',
		channel: null,
		prompt: CAL_PROMPTS.rest,
		hint: CAL_HINTS.rest,
		message,
		done: false,
		signalCount,
		// Sert UNIQUEMENT à nommer : au-delà, c'est un bouton (signalLabel).
		axisCount,
		centers: null,
		deadband: 0,
		channels: {},
		throttleMode: null,
		_elapsed: 0,
		_n: 0,
		_sum: new Array(signalCount).fill(0),
		_min: new Array(signalCount).fill(Infinity),
		_max: new Array(signalCount).fill(-Infinity),
	};
}

// `signalCount` est la longueur du vecteur rendu par padSignals(), `axisCount`
// le nombre d'axes réels du périphérique — la frontière au-delà de laquelle un
// signal est un bouton. Par défaut les deux coïncident : un appelant qui ne
// passe que des axes garde le comportement d'avant #279.
export function beginCalibration(signalCount, axisCount = signalCount) {
	return restState(signalCount, axisCount);
}

// -----------------------------------------------------------------------------
// CE QUE LE PILOTE EST EN TRAIN DE POUSSER
//
// La barre du panneau appliquait déjà cette règle en la recopiant. L'assistant
// dessine maintenant une machine qui suit le même geste (issue #281) : les deux
// doivent regarder le MÊME signal, sinon la barre et le drone se contredisent.
// -----------------------------------------------------------------------------

export function strongestSignal(state, signals) {
	const centers = state?.centers;
	if (!centers) return { index: 0, dev: 0, span: PUSH_MIN, at: 0 };

	let index = 0, dev = 0;
	for (let i = 0; i < centers.length; i++) {
		const d = (signals[i] ?? 0) - centers[i];
		if (Math.abs(d) > Math.abs(dev)) { index = i; dev = d; }
	}

	// La référence de pleine course est la CRÊTE que ce pilote a lui-même
	// atteinte sur ce signal, avec PUSH_MIN pour plancher. La machine arrive donc
	// à pleine inclinaison quand il arrive à SA butée — une radio dont les
	// endpoints ne sont pas réglés ne donne pas une machine molle.
	const span = Math.max(PUSH_MIN, Math.abs(state._peaks?.[index] ?? 0), Math.abs(dev));
	return { index, dev, span, at: dev / span };
}

// -----------------------------------------------------------------------------
// REPOS
// -----------------------------------------------------------------------------

function feedRest(state, axes, dt) {
	const s = { ...state, _sum: [...state._sum], _min: [...state._min], _max: [...state._max] };
	s._elapsed += dt;
	s._n += 1;

	let spread = 0;
	for (let i = 0; i < s.signalCount; i++) {
		const v = axes[i] ?? 0;
		s._sum[i] += v;
		s._min[i] = Math.min(s._min[i], v);
		s._max[i] = Math.max(s._max[i], v);
		spread = Math.max(spread, s._max[i] - s._min[i]);
	}

	// Un manche tenu pendant la mesure décale le neutre, et avec lui TOUT le
	// reste du calibrage : chaque déviation se mesure par rapport à ce neutre.
	if (spread > REST_MAX_SPREAD) {
		return restState(s.signalCount, s.axisCount, 'stick moved — measuring neutral again');
	}

	if (s._elapsed < CAL_TIMING.restMs) return s;

	const centers = s._sum.map((sum) => sum / s._n);
	// Le bruit retenu est la demi-amplitude de l'axe le plus agité : le deadband
	// est commun aux quatre canaux, comme l'était la constante qu'il remplace.
	const noise = Math.max(...s._min.map((lo, i) => (s._max[i] - lo) / 2));
	const deadband = Math.min(DEADBAND_MAX, Math.max(DEADBAND_MIN, noise * NOISE_MARGIN));

	return beginChannel({ ...s, centers, deadband }, 0);
}

// -----------------------------------------------------------------------------
// UN CANAL À LA FOIS
// -----------------------------------------------------------------------------

function beginChannel(state, i, message = null) {
	return {
		...state,
		phase: 'channel',
		channel: CAL_CHANNELS[i],
		prompt: CAL_PROMPTS[CAL_CHANNELS[i]],
		hint: CAL_HINTS[CAL_CHANNELS[i]],
		message,
		_channelIndex: i,
		_peaks: new Array(state.signalCount).fill(0),
		_holdMs: 0,
		_idleMs: 0,
		// Tant que les manches n'ont pas été vus au neutre, on n'accepte aucun
		// geste : après un refus, ils sont encore poussés, et sans ce verrou on
		// refuserait la même chose en boucle sans que le pilote ait rien fait.
		_armed: false,
	};
}

// Redemande la consigne courante en disant pourquoi.
function retryChannel(state, message) {
	return { ...beginChannel(state, state._channelIndex), message };
}

function feedChannel(state, axes, dt) {
	const dev = state.centers.map((c, i) => (axes[i] ?? 0) - c);

	if (!state._armed) {
		const centered = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
		return centered ? { ...state, _armed: true } : state;
	}

	// Rien vu passer depuis assez longtemps : ce n'est plus « le pilote vise »,
	// c'est un périphérique dont ce manche ne sort nulle part. On le dit sans
	// renoncer — il lui reste peut-être un autre manche à essayer.
	const quiet = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
	const idleMs = quiet ? state._idleMs + dt : 0;
	if (quiet && idleMs >= CAL_TIMING.idleWarnMs) {
		return { ...state, _idleMs: idleMs, message: IDLE_MESSAGE };
	}

	const peaks = state._peaks.map((p, i) => (Math.abs(dev[i]) > Math.abs(p) ? dev[i] : p));

	// L'axe candidat est celui dont la déviation crête est la plus grande, et le
	// geste ne compte que quand il est TENU à cette crête.
	let win = 0;
	for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i]) > Math.abs(peaks[win])) win = i;

	const held =
		Math.abs(peaks[win]) >= PUSH_MIN &&
		Math.abs(dev[win] - peaks[win]) <= HOLD_TOL;

	const holdMs = held ? state._holdMs + dt : 0;
	const s = { ...state, _peaks: peaks, _holdMs: holdMs, _idleMs: idleMs };
	if (holdMs < CAL_TIMING.holdMs) return s;

	const second = Math.max(...peaks.map((p, i) => (i === win ? 0 : Math.abs(p))));
	if (second * AMBIGUITY_RATIO > Math.abs(peaks[win])) {
		return retryChannel(s, 'two axes moved together — release everything and try again');
	}

	const taken = CAL_CHANNELS.find((ch) => s.channels[ch]?.axis === win);
	if (taken) {
		return retryChannel(s, `axis ${win} is already ${taken} — use a different stick`);
	}

	return assignChannel(s, win, peaks[win]);
}

function assignChannel(state, axis, peak) {
	const center = state.centers[axis];

	// Le gaz ne se décrit pas comme les trois autres : il n'a pas de neutre au
	// milieu, il a un plancher et un plafond. Le plafond vient d'être mesuré ;
	// le plancher dépend de la mécanique du manche, qu'on va observer.
	if (state.channel === 'throttle') {
		return {
			...state,
			phase: 'throttle-release',
			prompt: CAL_PROMPTS.throttleRelease,
			hint: CAL_HINTS.throttleRelease,
			message: null,
			channels: { ...state.channels, throttle: { axis, lo: center, hi: center + peak } },
			_phaseMs: 0,
			_holdMs: 0,
			_lastVal: center + peak,
		};
	}

	const channels = {
		...state.channels,
		[state.channel]: { axis, center, span: Math.abs(peak), invert: peak < 0 },
	};
	const next = state._channelIndex + 1;
	if (next < CAL_CHANNELS.length) return beginChannel({ ...state, channels }, next);

	return {
		...state, channels, phase: 'done', channel: null,
		prompt: CAL_PROMPTS.done, hint: CAL_HINTS.done, message: null, done: true,
	};
}

// -----------------------------------------------------------------------------
// MODE DE COURSE DU GAZ — la mesure qui remplace la marque
// -----------------------------------------------------------------------------

// Une seule question, posée au matériel plutôt qu'à une table de vendeurs :
// quand on lâche le manche, revient-il au neutre ?
//   oui  -> stick auto-centré : demi-course, plancher = neutre. Sinon lâcher la
//           manette laisserait 50 % de gaz et rendrait le geste de désarmement
//           injoignable au repos.
//   non  -> gimbal à friction : pleine course, et il faut aller chercher le
//           plancher, qui n'est PAS le neutre.
function feedThrottleRelease(state, axes, dt) {
	const v = axes[state.channels.throttle.axis] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const s = {
		...state,
		_phaseMs: state._phaseMs + dt,
		_holdMs: moved ? 0 : state._holdMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};

	if (s._phaseMs < CAL_TIMING.releaseMinMs || s._holdMs < CAL_TIMING.holdMs) return s;

	const center = s.centers[s.channels.throttle.axis];
	if (Math.abs(s._lastVal - center) <= RETURN_TOL) {
		return beginChannel({ ...s, throttleMode: 'half' }, 1);
	}

	return {
		...s,
		phase: 'throttle-min',
		throttleMode: 'full',
		prompt: CAL_PROMPTS.throttleMin,
		hint: CAL_HINTS.throttleMin,
		_holdMs: 0,
		_lastVal: s._lastVal,
	};
}

function feedThrottleMin(state, axes, dt) {
	const { axis, hi } = state.channels.throttle;
	const v = axes[axis] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const s = {
		...state,
		_holdMs: moved ? 0 : state._holdMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};

	// Tenu, et assez loin du plafond pour être l'autre bout de la course.
	if (s._holdMs < CAL_TIMING.holdMs || Math.abs(s._lastVal - hi) < PUSH_MIN) return s;

	const channels = { ...s.channels, throttle: { axis, lo: s._lastVal, hi } };
	return beginChannel({ ...s, channels }, 1);
}

// -----------------------------------------------------------------------------

export function feedSample(state, axes, dt) {
	switch (state.phase) {
		case 'rest': return feedRest(state, axes, dt);
		case 'channel': return feedChannel(state, axes, dt);
		case 'throttle-release': return feedThrottleRelease(state, axes, dt);
		case 'throttle-min': return feedThrottleMin(state, axes, dt);
		default: return state;
	}
}

// Le mappage {axis, invert} attendu par input.js et par le tableau de remap du
// panneau Tab. Le calibrage en sait plus que ça (neutre, course, deadband),
// mais il doit rester lisible et modifiable par les commandes qui existaient
// avant lui.
export function calibrationToMap(state) {
	const map = {};
	for (const ch of CAL_CHANNELS) {
		const c = state.channels[ch];
		if (!c) continue;
		map[ch] = ch === 'throttle'
			? { axis: c.axis, invert: c.hi < c.lo }
			: { axis: c.axis, invert: c.invert };
	}
	return map;
}

// -----------------------------------------------------------------------------
// LECTURE D'UN AXE CALIBRÉ
//
// C'est ici que le calibrage cesse d'être un écran et devient du vol. Deux
// suppositions de input.js disparaissent :
//   - « le neutre est à 0 » — faux dès qu'un gimbal a une dérive ou qu'un
//     manche à friction est parqué ailleurs ;
//   - « la course vaut ±1 » — faux sur toute radio dont les endpoints ne sont
//     pas réglés, et le pilote n'a alors jamais son plein débattement.
// -----------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Axe brut -> -1..1, autour du neutre MESURÉ et sur la course MESURÉE.
// Le deadband est retranché puis la course restante remise à l'échelle : un
// deadband qui retranche sans remettre à l'échelle fait sauter la commande au
// franchissement du seuil, et coûte le même pourcentage de butée.
export function normalizeChannel(v, cal, deadband) {
	if (!cal || !(cal.span > 0)) return 0;
	const signed = (cal.invert ? -1 : 1) * (v - cal.center);
	const n = clamp(signed / cal.span, -1, 1);
	if (Math.abs(n) < deadband) return 0;
	return Math.sign(n) * ((Math.abs(n) - deadband) / (1 - deadband));
}

// Axe brut -> gaz 0..1, entre le plancher et le plafond MESURÉS. Une seule
// formule pour les deux mécaniques de manche : sur un stick auto-centré le
// plancher EST le neutre, donc lâcher rend 0 — et le geste de désarmement
// (throttle < 0,08) reste joignable au repos.
export function throttleFromCalibrated(v, cal) {
	if (!cal || cal.hi === cal.lo) return 0;
	return clamp((v - cal.lo) / (cal.hi - cal.lo), 0, 1);
}

// -----------------------------------------------------------------------------
// CE QU'ON PERSISTE, CE QU'ON MONTRE
// -----------------------------------------------------------------------------

// L'état de la machine traîne ses accumulateurs (fenêtres, crêtes, minuteries).
// Ce qui va dans localStorage est la MESURE seule : trois champs, sérialisables,
// et rien qui ne survivrait pas à un aller-retour JSON.
export function calibrationResult(state) {
	if (!state.done) return null;
	const { channels, deadband, throttleMode, axisCount } = state;
	return { channels, deadband, throttleMode, axisCount };
}

// L'ordre des écrans, pour dire au pilote où il en est. Le lâcher du gaz est une
// étape à part entière : c'est elle qui décide du mode de course, et elle
// demande un geste (lâcher) que les autres ne demandent pas.
const STEP_ORDER = ['rest', 'throttle', 'throttle-release', 'yaw', 'pitch', 'roll'];

export function calProgress(state) {
	const total = STEP_ORDER.length;
	if (state.phase === 'done') return { step: total, total };
	// 'throttle-min' n'est pas une étape de plus : c'est la suite de la même
	// question — où est le plancher de ce gaz ?
	const key = state.phase === 'channel' ? state.channel
		: state.phase === 'throttle-min' ? 'throttle-release'
			: state.phase;
	return { step: STEP_ORDER.indexOf(key) + 1, total };
}

// Le récapitulatif de fin, décidé sans DOM — même rôle que padListEntries()
// pour la liste des périphériques (issue #162) : ce qu'on relit quand « ça ne
// marche toujours pas ». Un calibrage qui annonce seulement sa réussite est
// invérifiable ; celui-ci montre ses chiffres, y compris quand ils sont mauvais
// (une course de 0.80 est un problème de radio, et il doit se voir).
export function calSummaryLines(cal) {
	const pad = (s) => s.padEnd(9, ' ');
	// Un calibrage d'avant #279 n'a pas d'axisCount : tous ses signaux sont des
	// axes, et l'étiquette retombe dessus.
	const where = (i) => signalLabel(i, cal.axisCount ?? Infinity);
	const lines = CAL_CHANNELS.map((name) => {
		const c = cal.channels[name];
		if (name === 'throttle') {
			const travel = cal.throttleMode === 'full' ? 'full travel' : 'half travel';
			return `${pad(name)} ${where(c.axis)}  ${travel}  ${c.lo.toFixed(2)} → ${c.hi.toFixed(2)}`;
		}
		return `${pad(name)} ${where(c.axis)}  ±${c.span.toFixed(2)}${c.invert ? '  inverted' : ''}`;
	});
	lines.push(`${pad('deadband')} ${cal.deadband.toFixed(3)}`);
	return lines;
}
