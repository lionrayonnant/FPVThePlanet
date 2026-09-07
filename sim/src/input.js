// Sticks are normalised to { throttle 0..1, roll/pitch/yaw -1..1 }
// regardless of whether they came from a radio or the keyboard.

import { isTextEntry } from './menu-nav.js';
import {
	CAL_CHANNELS,
	calibrationToMap,
	padSignals,
	normalizeChannel,
	throttleFromCalibrated,
} from './calibration.js';

const STORAGE_KEY = 'fpvtp.gamepadMap';
// Calibrages mesurés, indexés PAR PÉRIPHÉRIQUE (issue #277). STORAGE_KEY, lui,
// n'a jamais tenu qu'un seul mappage pour tout le monde : brancher une manette
// après avoir remappé une radio récupérait le mappage de la radio.
const CAL_STORAGE_KEY = 'fpvtp.gamepadCal';
// Deadband par défaut, utilisé tant que le périphérique n'a pas été calibré.
// Un calibrage le remplace par le bruit RÉELLEMENT mesuré au repos.
const DEADBAND = 0.06;
const GAMEPAD_MOVE_THRESHOLD = 0.15;

// -----------------------------------------------------------------------------
// GAMEPAD MAPPINGS
// -----------------------------------------------------------------------------

// EdgeTX radios : gimbals à friction, la course entière du manche gauche est
// utile — throttle en PLEINE course (voir THROTTLE_MODE).
const EDGETX_MAP = {
	roll: { axis: 0, invert: false },
	pitch: { axis: 1, invert: true },
	throttle: { axis: 2, invert: false },
	yaw: { axis: 3, invert: false },
};

// -----------------------------------------------------------------------------
// MANETTES À STICKS AUTO-CENTRÉS (DualShock 4/DualSense, Xbox, génériques)
//
// Un seul profil : en mapping « standard » du navigateur, PlayStation et Xbox
// exposent exactement la même disposition d'axes.
//
// axis 0 = stick gauche X    axis 2 = stick droit X
// axis 1 = stick gauche Y    axis 3 = stick droit Y
//
// Mapping FPV voulu :
//   gauche Y -> throttle (moitié haute seule, voir THROTTLE_MODE)
//   gauche X -> yaw
//   droit  X -> roll
//   droit  Y -> pitch : stick poussé vers l'avant = nez qui pique.
//                       L'axe vaut -1 vers l'avant et `sticks.pitch < 0` fait
//                       piquer (flightController : pitch > 0 = cabrer), donc
//                       PAS d'inversion. Même convention au clavier.
// -----------------------------------------------------------------------------

const GAMEPAD_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	roll: { axis: 2, invert: false },
	pitch: { axis: 3, invert: false },
};

// Comment l'axe de throttle devient 0..1 :
//   'full' : (v+1)/2 — le manche tient sa position (radio).
//   'half' : max(0, v) — un stick auto-centré revient à 0 %, sinon lâcher la
//            manette laisserait 50 % de gaz et rendrait le geste de
//            désarmement (throttle < 0,08) injoignable au repos.
export const THROTTLE_MODE = { radio: 'full', gamepad: 'half' };

// -----------------------------------------------------------------------------
// DEVICE DETECTION
// -----------------------------------------------------------------------------

// Les noms de marque ne suffisent pas : ils ne couvrent que les radios qu'on a
// pensé à lister, et une radio non reconnue tombe en 'generic', donc sur
// GAMEPAD_MAP — dont les quatre axes sont dans un ORDRE DIFFÉRENT d'EDGETX_MAP,
// avec un gaz en demi-course. Le pilote ne voit pas « mal mappé », il voit
// « ça ne marche pas ». Signalé sur un TBS Tango 2, qu'aucun mot de cette liste
// n'attrapait.
//
// D'où `4f54` : c'est l'identifiant produit USB des radios OpenTX/EdgeTX —
// « OT » en ASCII — associé au fabricant `1209` (pid.codes). Vérifié sur le
// matériel du projet : la Radiomaster Pocket s'énumère en 1209:4f54, et les
// firmwares dérivés d'OpenTX (dont FreedomTX du Tango 2) partagent cet
// identifiant. Un identifiant vaut mieux qu'un nom, exactement comme 045e et
// 054c plus bas pour Xbox et PlayStation.
//
// Les noms restent en second rideau, pour les radios qui s'énumèrent sous un
// identifiant propriétaire.
const RADIO_RE =
	/4f54|edgetx|opentx|freedomtx|radiomaster|frsky|jumper|tx16|taranis|betafpv|flysky|tbs|tango|horus|boxer|zorro|commando/i;

// 045e = vendor Microsoft. « xinput » couvre les manettes 360/One vues via
// XInput sous Windows.
const XBOX_RE =
	/xbox|xinput|045e/i;

// 054c = vendor Sony, commun à la DS4 et à la DualSense. Firefox nomme la DS4
// « Wireless Controller » tout court — mais Chrome nomme la manette Xbox
// « Xbox Wireless Controller », d'où l'ordre de test dans padKind().
const PLAYSTATION_RE =
	/dualshock|dualsense|wireless controller|054c|playstation|ps[45]/i;

// Renvoie 'radio' | 'xbox' | 'playstation' | 'generic'. L'ordre compte :
// radio d'abord (une radio peut s'annoncer « ... Controller »), puis Xbox
// avant PlayStation à cause de « Wireless Controller ».
export function padKind(id) {
	const s = id || '';
	if (RADIO_RE.test(s)) return 'radio';
	if (XBOX_RE.test(s)) return 'xbox';
	if (PLAYSTATION_RE.test(s)) return 'playstation';
	return 'generic';
}

// Ce que l'écran de périphériques doit MONTRER, décidé sans DOM (issue #162).
//
// `pads` : la sortie de listGamepads(). `activeIndex` : l'index du périphérique
// réellement lu par Input. Rend une ligne par périphérique — identifiant,
// classe déduite (c'est ELLE qui décide du mappage par défaut, donc c'est elle
// qu'il faut pouvoir lire quand « ça ne marche pas »), nombre d'axes et de
// boutons, et l'état actif.
//
// Une liste vide n'est pas « non reconnu » : l'API Gamepad n'expose un
// périphérique qu'APRÈS une action de l'utilisateur dessus. `empty` porte cette
// nuance pour que l'écran la dise au lieu de laisser conclure.
export function padListEntries(pads, activeIndex) {
	return (pads ?? []).map((g) => ({
		index: g.index,
		id: g.id,
		kind: padKind(g.id),
		axes: g.axes,
		buttons: g.buttons,
		active: g.index === activeIndex,
		label: `${g.index === activeIndex ? '▌' : ' '} ${g.id} — ${padKind(g.id)} · ${g.axes} axes · ${g.buttons} buttons`,
	}));
}

export const PAD_LIST_EMPTY = 'nothing enumerated — move a stick or press a button on the device, '
	+ 'the browser only reveals it after an input on it';

export function defaultMapForKind(kind) {
	return structuredClone(kind === 'radio' ? EDGETX_MAP : GAMEPAD_MAP);
}

export function throttleModeForKind(kind) {
	return kind === 'radio' ? THROTTLE_MODE.radio : THROTTLE_MODE.gamepad;
}

// Axe -1..1 déjà désinversé -> gaz 0..1.
export function throttleFromAxis(v, mode) {
	const t = mode === THROTTLE_MODE.radio ? (v + 1) / 2 : v;
	return Math.max(0, Math.min(1, t));
}

export const CHANNELS = [
	'throttle',
	'yaw',
	'pitch',
	'roll',
];

// -----------------------------------------------------------------------------
// CALIBRAGE MESURÉ (issue #277)
//
// Le calibrage produit par src/calibration.js décrit le périphérique tel qu'il
// est : neutre, course et bruit mesurés, mode de course du gaz observé. Il
// prime sur `map` + `throttleMode`, qui restent le chemin des périphériques
// jamais calibrés.
// -----------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function isValidCalibration(cal) {
	if (!cal || typeof cal !== 'object') return false;
	if (cal.throttleMode !== 'full' && cal.throttleMode !== 'half') return false;
	if (!isNum(cal.deadband)) return false;
	const ch = cal.channels;
	if (!ch || typeof ch !== 'object') return false;
	return CAL_CHANNELS.every((name) => {
		const c = ch[name];
		if (!c || typeof c !== 'object' || !isNum(c.axis)) return false;
		return name === 'throttle'
			? isNum(c.lo) && isNum(c.hi)
			: isNum(c.center) && isNum(c.span) && typeof c.invert === 'boolean';
	});
}

// Le calibrage d'UN périphérique, ou null. Un stockage illisible retombe sur
// null plutôt que de jeter : une clé corrompue ne doit pas empêcher de booter,
// même règle que loadMap().
export function calStoreGet(store, padId) {
	if (!store || typeof store !== 'object') return null;
	const cal = store[padId];
	return isValidCalibration(cal) ? cal : null;
}

export function calStoreSet(store, padId, cal) {
	return { ...(store && typeof store === 'object' ? store : {}), [padId]: cal };
}

// Les quatre sticks lus à travers le calibrage. Aucune supposition : ni « le
// neutre est à 0 », ni « la course vaut ±1 », ni « ce gaz revient au centre »,
// ni « un manche est sur un axe » (#279 : `signals` porte les axes PUIS les
// boutons, parce qu'une radio en mapping « standard » sort son gaz sur une
// gâchette).
export function sticksFromCalibration(signals, cal) {
	const c = cal.channels;
	const at = (name) => signals[c[name].axis] ?? 0;
	return {
		throttle: throttleFromCalibrated(at('throttle'), c.throttle),
		yaw: normalizeChannel(at('yaw'), c.yaw, cal.deadband),
		pitch: normalizeChannel(at('pitch'), c.pitch, cal.deadband),
		roll: normalizeChannel(at('roll'), c.roll, cal.deadband),
	};
}

// Un calibrage « supposé » à partir d'un profil écrit à la main : c'est ce que
// devient un remap manuel fait sur un périphérique jamais calibré. Les valeurs
// de course y sont des suppositions (neutre 0, course ±1) — exactement celles
// qu'un vrai calibrage remplace par des mesures.
export function assumedCalibration(map, throttleMode) {
	const channels = {};
	for (const name of CAL_CHANNELS) {
		const m = map[name];
		channels[name] = name === 'throttle'
			? throttleEndpoints(m.axis, m.invert, throttleMode)
			: { axis: m.axis, center: 0, span: 1, invert: !!m.invert };
	}
	return { channels, deadband: DEADBAND, throttleMode };
}

// Un remap manuel appliqué à un calibrage. Le panneau Tab laisse toujours
// choisir l'axe et le sens à la main : ce chemin doit continuer à marcher SUR
// un périphérique calibré, sinon la case « inv » n'aurait plus aucun effet.
//
// Ce qu'on garde et ce qu'on jette : sur le même axe, le pilote conteste un
// SENS, pas une mesure — neutre et course restent. Sur un autre axe, rien n'a
// jamais été mesuré, on retombe sur les suppositions.
export function remapChannel(cal, channel, axis, invert) {
	const previous = cal.channels[channel];
	const sameAxis = previous?.axis === axis;

	let next;
	if (channel === 'throttle') {
		// Le plancher reste le plancher. Sur un gaz auto-centré c'est le
		// neutre : le déplacer mettrait du gaz manette lâchée.
		next = sameAxis
			? { axis, lo: previous.lo, hi: previous.lo + (invert ? -1 : 1) * Math.abs(previous.hi - previous.lo) }
			: throttleEndpoints(axis, invert, cal.throttleMode);
	} else {
		next = sameAxis
			? { ...previous, invert: !!invert }
			: { axis, center: 0, span: 1, invert: !!invert };
	}

	return { ...cal, channels: { ...cal.channels, [channel]: next } };
}

// Plancher et plafond d'un gaz dont on ne connaît que le sens : pleine course
// d'une butée à l'autre, ou demi-course à partir du neutre.
function throttleEndpoints(axis, invert, throttleMode) {
	// Pleine course : d'une butée à l'autre, soit 2 unités d'axe. Demi-course :
	// du neutre à une butée, soit 1.
	const span = throttleMode === THROTTLE_MODE.radio ? 2 : 1;
	const lo = throttleMode === THROTTLE_MODE.radio ? (invert ? 1 : -1) : 0;
	return { axis, lo, hi: lo + (invert ? -span : span) };
}

// -----------------------------------------------------------------------------
// DEADZONE
// -----------------------------------------------------------------------------

function applyDeadband(v) {
	if (Math.abs(v) < DEADBAND) {
		return 0;
	}

	return (
		Math.sign(v) *
		((Math.abs(v) - DEADBAND) / (1 - DEADBAND))
	);
}

// -----------------------------------------------------------------------------
// INPUT
// -----------------------------------------------------------------------------

export class Input {
	constructor() {
		const saved = loadMap();

		this._savedMap = saved !== null;

		this.map =
			saved ??
			defaultMapForKind('generic');

		// Calibrages mesurés, un par périphérique (issue #277). `calibration`
		// est celui du périphérique ACTIF : tant qu'il est nul, on lit les axes
		// comme avant, avec le profil deviné.
		this._calStore = loadCalStore();
		this.calibration = null;

		// Réévalué à l'activation d'une manette : une radio garde la pleine
		// course, tout le reste passe en demi-course.
		this.throttleMode = THROTTLE_MODE.gamepad;

		this.sticks = {
			throttle: 0,
			roll: 0,
			pitch: 0,
			yaw: 0,
		};

		this.gamepadIndex = null;
		this.usingGamepad = false;

		this._baseline = new Map();

		// Keyboard
		this.keys = new Set();
		this.kbThrottle = 0;

		// Mouse
		this.mouse = {
			x: 0,
			y: 0,
		};

		this.pointerLocked = false;

		this.onAction = () => {};

		// ---------------------------------------------------------------------
		// KEYBOARD
		// ---------------------------------------------------------------------

		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;

			const k = e.key.toLowerCase();

			// Un champ de saisie garde ses touches (#222) : Espace y est un
			// espace, pas une pause — main.js fait preventDefault sur l'action.
			// Même règle que menu-nav. Échap passe quand même : il n'édite rien.
			if (isTextEntry(e.target) && k !== 'escape') return;

			this.keys.add(k);

			if (
				[
					'm',
					'p',
					'c',
					'f',
					'tab',
					'escape',
					'enter',
					' ',
					// PHASE 26 : `r` remet la machine en état, `b` ouvre le
					// panneau du banc. Transmises inconditionnellement — c'est
					// main.js qui décide qu'elles n'existent qu'au banc, ce
					// module ne connaît aucun mode de jeu.
					'r',
					'b',
				].includes(k)
			) {
				this.onAction(k, e);
			}

			// Espace et les flèches sont des commandes de vol : on empêche le
			// défilement de la page.
			if (k === ' ' || k.startsWith('arrow')) {
				e.preventDefault();
			}
		});

		window.addEventListener('keyup', (e) => {
			this.keys.delete(
				e.key.toLowerCase()
			);
		});

		window.addEventListener('blur', () => {
			this.keys.clear();
		});

		// ---------------------------------------------------------------------
		// GAMEPAD CONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepadconnected',
			(e) => {
				const pad = e.gamepad;

				this._baseline.set(
					pad.index,
					[...pad.axes]
				);

				console.log(
					'[input] gamepad connected:',
					pad.id
				);

				console.log(
					'[input] axes:',
					[...pad.axes]
				);

				console.log(
					'[input] buttons:',
					pad.buttons.length
				);

				console.log(
					'[input] kind:',
					padKind(pad.id)
				);
			}
		);

		// ---------------------------------------------------------------------
		// GAMEPAD DISCONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepaddisconnected',
			(e) => {
				this._baseline.delete(
					e.gamepad.index
				);

				if (
					this.gamepadIndex ===
					e.gamepad.index
				) {
					this.gamepadIndex = null;
					this.usingGamepad = false;

					console.log(
						'[input] gamepad disconnected:',
						e.gamepad.id
					);
				}
			}
		);

		// ---------------------------------------------------------------------
		// POINTER LOCK
		// ---------------------------------------------------------------------

		document.addEventListener(
			'pointerlockchange',
			() => {
				this.pointerLocked =
					document.pointerLockElement !== null;
			}
		);

		window.addEventListener(
			'mousemove',
			(e) => {
				if (!this.pointerLocked) {
					return;
				}

				this.mouse.x = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.x +
							e.movementX * 0.004
					)
				);

				this.mouse.y = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.y -
							e.movementY * 0.004
					)
				);
			}
		);
	}

	// ---------------------------------------------------------------------------
	// FIND ACTIVE GAMEPAD
	// ---------------------------------------------------------------------------

	getGamepad() {
		const pads =
			(navigator.getGamepads
				? navigator.getGamepads()
				: []
			).filter(Boolean);

		// Already selected
		const current = pads.find((p) => p.index === this.gamepadIndex);
		if (current) return current;

		for (const p of pads) {
			if (!this._baseline.has(p.index)) {
				this._baseline.set(p.index, [...p.axes]);
			}
		}

		// Un seul pad branché : le seuil de mouvement n'a d'utilité que pour
		// départager plusieurs manettes candidates (« laquelle bouge en
		// premier »). Avec une seule manette, l'exiger ne fait qu'empêcher
		// la détection d'un stick au repos ou trop stable (ex. gimbal Hall
		// d'une radio) — on l'adopte directement.
		if (pads.length === 1) {
			return this._activate(pads[0]);
		}

		for (const p of pads) {
			const base = this._baseline.get(p.index);

			const moved =
				p.axes.some((v, i) => {
					const previous =
						base[i] ?? 0;

					return (
						Math.abs(
							v - previous
						) >
						GAMEPAD_MOVE_THRESHOLD
					);
				});

			if (moved) {
				return this._activate(p);
			}
		}

		return null;
	}

	_activate(p) {
		this.gamepadIndex = p.index;

		const kind = padKind(p.id);

		// Le mode de throttle suit toujours le matériel : il décrit la course
		// physique du manche, pas une préférence — un remap utilisateur ne le
		// concerne pas.
		this.throttleMode = throttleModeForKind(kind);

		// Automatically choose the proper map
		// unless the user has explicitly saved one.
		if (!this._savedMap) {
			this.map = defaultMapForKind(kind);
		}

		// Un calibrage MESURÉ pour CE périphérique prime sur tout le reste :
		// c'est la seule source qui ne devine rien. Il fixe aussi le mode de
		// course du gaz, qui n'est alors plus déduit de la marque.
		this.applyCalibration(calStoreGet(this._calStore, p.id));

		console.log('[input] using gamepad:', p.id, `(${kind})`);
		console.log('[input] active map:', this.map, this.throttleMode);
		console.log('[input] calibrated:', this.calibration ? 'yes' : 'no');

		return p;
	}

	// ---------------------------------------------------------------------------
	// CALIBRAGE
	// ---------------------------------------------------------------------------

	// Le calibrage du périphérique actif, ou null pour revenir au profil deviné.
	applyCalibration(cal) {
		this.calibration = cal;
		if (!cal) return;
		this.map = calibrationToMap(cal);
		this.throttleMode = cal.throttleMode;
	}

	// Fin de l'assistant : on persiste SOUS L'IDENTIFIANT du périphérique, pour
	// que brancher l'autre manette ne récupère pas ce calibrage-ci.
	setCalibration(padId, cal) {
		this._calStore = calStoreSet(this._calStore, padId, cal);
		saveCalStore(this._calStore);
		this.applyCalibration(cal);
	}

	// L'identifiant du périphérique actif — la clé de stockage d'un calibrage.
	activePadId() {
		return (navigator.getGamepads?.() ?? [])[this.gamepadIndex]?.id ?? null;
	}

	isCalibrated(padId = this.activePadId()) {
		return padId !== null && calStoreGet(this._calStore, padId) !== null;
	}

	// ---------------------------------------------------------------------------
	// LIST GAMEPADS
	// ---------------------------------------------------------------------------

	listGamepads() {
		return [
			...(navigator.getGamepads?.() ?? []),
		]
			.filter(Boolean)
			.map((p) => ({
				index: p.index,
				id: p.id,
				axes: p.axes.length,
				buttons: p.buttons.length,
			}));
	}

	// ---------------------------------------------------------------------------
	// MANUAL GAMEPAD SELECTION
	// ---------------------------------------------------------------------------

	selectGamepad(index) {
		this.gamepadIndex = index;

		const pad =
			(navigator.getGamepads?.() ?? [])[
				index
			];

		if (pad) {
			const kind = padKind(pad.id);

			this.map = defaultMapForKind(kind);
			this.throttleMode = throttleModeForKind(kind);
			this.applyCalibration(calStoreGet(this._calStore, pad.id));

			console.log(
				'[input] manually selected:',
				pad.id
			);

			console.log(
				'[input] map:',
				this.map
			);
		}
	}

	// ---------------------------------------------------------------------------
	// SAVE CUSTOM MAPPING
	// ---------------------------------------------------------------------------

	setMapping(
		channel,
		axis,
		invert
	) {
		this.map[channel] = {
			axis,
			invert,
		};

		this._savedMap = true;

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(this.map)
		);

		// Sur un périphérique calibré, le mappage lu en vol vient du calibrage :
		// sans cette ligne, changer l'axe ou cocher « inv » n'aurait tout
		// simplement plus d'effet. Le remap suit, et reste attaché à CE
		// périphérique.
		const padId = this.activePadId();
		if (this.calibration && padId) {
			this.setCalibration(padId, remapChannel(this.calibration, channel, axis, invert));
		}
	}

	// ---------------------------------------------------------------------------
	// UPDATE
	// ---------------------------------------------------------------------------

	update(dt) {
		const pad =
			this.getGamepad();

		if (
			pad &&
			this.readGamepad(pad)
		) {
			this.usingGamepad = true;
		} else {
			this.usingGamepad = false;
			this.readKeyboard(dt);
		}

		return this.sticks;
	}

	// ---------------------------------------------------------------------------
	// STANDARD GAMEPAD / RADIO
	// ---------------------------------------------------------------------------

	readStandardGamepad(pad) {
		// Périphérique calibré : on lit ses axes avec ses propres mesures —
		// neutre, course et bruit relevés sur CE matériel. Le chemin ci-dessous
		// reste celui des périphériques jamais calibrés, avec ses suppositions.
		if (this.calibration) {
			Object.assign(this.sticks, sticksFromCalibration(padSignals(pad), this.calibration));
			return true;
		}

		const raw = (channel) => {
			const m =
				this.map[channel];

			if (!m) {
				return null;
			}

			// Même espace d'indices que le calibrage : les axes, puis les
			// boutons (#279). Un remap manuel doit pouvoir désigner une
			// gâchette, sinon il ne rattrape pas ce que le calibrage rattrape.
			const v =
				padSignals(pad)[m.axis];

			if (v === undefined) {
				return null;
			}

			return m.invert
				? -v
				: v;
		};

		const t =
			raw('throttle');

		if (t === null) {
			return false;
		}

		this.sticks.throttle =
			throttleFromAxis(
				t,
				this.throttleMode
			);

		this.sticks.yaw =
			applyDeadband(
				raw('yaw') ?? 0
			);

		this.sticks.pitch =
			applyDeadband(
				raw('pitch') ?? 0
			);

		this.sticks.roll =
			applyDeadband(
				raw('roll') ?? 0
			);

		return true;
	}

	// ---------------------------------------------------------------------------
	// GAMEPAD READER
	// ---------------------------------------------------------------------------

	// Un seul chemin de lecture pour tout le monde : radio, PlayStation, Xbox
	// et manettes génériques ne diffèrent que par `this.map` et
	// `this.throttleMode`. C'est ce qui rend le remap du panneau Settings
	// effectif sur TOUTES les manettes (il écrit dans `this.map`).
	readGamepad(pad) {
		return this.readStandardGamepad(pad);
	}

	// ---------------------------------------------------------------------------
	// KEYBOARD
	// ---------------------------------------------------------------------------

	readKeyboard(dt) {
		const has = (...keys) =>
			keys.some((x) =>
				this.keys.has(x)
			);

		// Throttle
		if (has('w', 'z')) {
			this.kbThrottle +=
				dt * 1.2;
		} else if (has('s')) {
			this.kbThrottle -=
				dt * 1.2;
		}

		this.kbThrottle =
			Math.max(
				0,
				Math.min(
					1,
					this.kbThrottle
				)
			);

		let roll = 0;
		let pitch = 0;
		let yaw = 0;

		// Yaw
		if (has('a', 'q')) {
			yaw -= 1;
		}

		if (has('d')) {
			yaw += 1;
		}

		// Roll
		if (has('arrowleft')) {
			roll -= 1;
		}

		if (has('arrowright')) {
			roll += 1;
		}

		// Pitch — même convention que la manette : « en avant » fait piquer.
		if (has('arrowup')) {
			pitch -= 1;
		}

		if (has('arrowdown')) {
			pitch += 1;
		}

		// Mouse. Exception assumée à la convention ci-dessus : la souris n'est
		// pas un manche qu'on pousse, c'est une visée. Souris vers le haut =
		// regarder vers le haut = cabrer, comme partout ailleurs.
		if (
			this.pointerLocked &&
			roll === 0 &&
			pitch === 0
		) {
			roll = this.mouse.x;
			pitch = this.mouse.y;

			const decay =
				Math.exp(-dt * 3.5);

			this.mouse.x *= decay;
			this.mouse.y *= decay;
		}

		this.sticks.throttle =
			this.kbThrottle;

		this.sticks.roll = roll;
		this.sticks.pitch = pitch;
		this.sticks.yaw = yaw;
	}

	// ---------------------------------------------------------------------------
	// RESET
	// ---------------------------------------------------------------------------

	resetKeyboardThrottle() {
		this.kbThrottle = 0;
		this.mouse.x = 0;
		this.mouse.y = 0;
	}
}

// -----------------------------------------------------------------------------
// LOAD SAVED MAP
// -----------------------------------------------------------------------------

// Les calibrages mesurés, tous périphériques confondus. Illisible -> {} : une
// clé corrompue ne doit pas empêcher le sim de booter.
function loadCalStore() {
	try {
		const saved = JSON.parse(localStorage.getItem(CAL_STORAGE_KEY));
		if (saved && typeof saved === 'object') return saved;
	} catch {
		// Ignore invalid saved data.
	}
	return {};
}

function saveCalStore(store) {
	try {
		localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(store));
	} catch {
		// Un stockage plein ou refusé ne doit pas casser la fin de l'assistant :
		// le calibrage reste actif pour la session en cours.
	}
}

function loadMap() {
	try {
		const saved =
			JSON.parse(
				localStorage.getItem(
					STORAGE_KEY
				)
			);

		if (
			saved &&
			CHANNELS.every(
				(channel) =>
					saved[channel] &&
					typeof saved[channel].axis ===
						'number'
			)
		) {
			return saved;
		}
	} catch {
		// Ignore invalid saved data.
	}

	return null;
}
