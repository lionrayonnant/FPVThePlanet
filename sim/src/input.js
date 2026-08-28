// Sticks are normalised to { throttle 0..1, roll/pitch/yaw -1..1 }
// regardless of whether they came from a radio or the keyboard.

const STORAGE_KEY = 'fpvmaps.gamepadMap';
const DEADBAND = 0.06;
const GAMEPAD_MOVE_THRESHOLD = 0.15;

// -----------------------------------------------------------------------------
// GAMEPAD MAPPINGS
// -----------------------------------------------------------------------------

// EdgeTX radios
const EDGETX_MAP = {
	roll: { axis: 0, invert: false },
	pitch: { axis: 1, invert: true },
	throttle: { axis: 2, invert: false },
	yaw: { axis: 3, invert: false },
};

// Generic gamepad / Xbox-style mapping
const PAD_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	pitch: { axis: 3, invert: true },
	roll: { axis: 2, invert: false },
};

// -----------------------------------------------------------------------------
// PS4 / DualShock 4
//
// Typical browser layout:
//
// axis 0 = left stick X
// axis 1 = left stick Y
// axis 2 = right stick X
// axis 3 = right stick Y
//
// Wanted FPV mapping:
//
// left  Y -> throttle
// left  X -> yaw
// right X -> roll
// right Y -> pitch (inverted)
// -----------------------------------------------------------------------------

const PS4_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	roll: { axis: 2, invert: false },
	pitch: { axis: 3, invert: false },
};

// -----------------------------------------------------------------------------
// DEVICE DETECTION
// -----------------------------------------------------------------------------

const RADIO_RE =
	/edgetx|opentx|radiomaster|frsky|jumper|tx16|taranis|betafpv|flysky/i;

const PS4_RE =
	/dualshock|wireless controller|054c|playstation|ps4/i;

function isPS4(pad) {
	return !!(
		pad &&
		PS4_RE.test(pad.id || '')
	);
}

function isRadio(pad) {
	return !!(
		pad &&
		RADIO_RE.test(pad.id || '')
	);
}

function defaultMapFor(pad) {
	if (isRadio(pad)) {
		return structuredClone(EDGETX_MAP);
	}

	if (isPS4(pad)) {
		return structuredClone(PS4_MAP);
	}

	return structuredClone(PAD_MAP);
}

export const CHANNELS = [
	'throttle',
	'yaw',
	'pitch',
	'roll',
];

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
			structuredClone(PAD_MAP);

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

			this.keys.add(k);

			if (
				[
					'r',
					'm',
					'p',
					'c',
					'tab',
					'escape',
					' ',
				].includes(k)
			) {
				this.onAction(k, e);
			}

			if (
				k === ' ' ||
				k.startsWith('arrow')
			) {
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

				if (isPS4(pad)) {
					console.log(
						'[input] DualShock 4 detected'
					);
				}

				if (isRadio(pad)) {
					console.log(
						'[input] EdgeTX radio detected'
					);
				}
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
			navigator.getGamepads
				? navigator.getGamepads()
				: [];

		for (const p of pads) {
			if (!p) continue;

			const base =
				this._baseline.get(p.index);

			// New device
			if (!base) {
				this._baseline.set(
					p.index,
					[...p.axes]
				);

				continue;
			}

			// Already selected
			if (
				this.gamepadIndex === p.index
			) {
				return p;
			}

			// Detect movement
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
				this.gamepadIndex =
					p.index;

				// Automatically choose the proper map
				// unless the user has explicitly saved one.
				if (!this._savedMap) {
					this.map =
						defaultMapFor(p);
				}

				console.log(
					'[input] using gamepad:',
					p.id
				);

				console.log(
					'[input] active map:',
					this.map
				);

				if (isPS4(p)) {
					console.log(
						'[input] PS4 mapping active'
					);
				}

				return p;
			}
		}

		return null;
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
			this.map =
				defaultMapFor(pad);

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
		const raw = (channel) => {
			const m =
				this.map[channel];

			if (!m) {
				return null;
			}

			const v =
				pad.axes[m.axis];

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
			(t + 1) / 2;

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
	// PS4 / DUALSHOCK 4
	// ---------------------------------------------------------------------------

	readPS4(pad) {
		// -------------------------------------------------------------
		// LEFT STICK X -> YAW
		// -------------------------------------------------------------

		const rawYaw =
			pad.axes[
				PS4_MAP.yaw.axis
			] ?? 0;

		// -------------------------------------------------------------
		// LEFT STICK Y -> THROTTLE
		//
		// PS4:
		//   haut    = -1
		//   centre  =  0
		//   bas     = +1
		//
		// On veut:
		//   haut    = 1.0 (100%)
		//   centre  = 0.0 (0%)
		//   bas     = 0.0 (0%)
		//
		// Donc seule la moitié supérieure du stick
		// contrôle les gaz.
		// -------------------------------------------------------------

		const rawThrottle =
			pad.axes[
				PS4_MAP.throttle.axis
			] ?? 0;

		const throttleAxis =
			PS4_MAP.throttle.invert
				? -rawThrottle
				: rawThrottle;

		// Seule la partie positive agit sur les gaz.
		this.sticks.throttle =
			Math.max(
				0,
				Math.min(
					1,
					throttleAxis
				)
			);

		// -------------------------------------------------------------
		// RIGHT STICK X -> ROLL
		// -------------------------------------------------------------

		const rawRoll =
			pad.axes[
				PS4_MAP.roll.axis
			] ?? 0;

		this.sticks.roll =
			applyDeadband(rawRoll);

		// -------------------------------------------------------------
		// RIGHT STICK Y -> PITCH INVERTED
		// -------------------------------------------------------------

		const rawPitch =
			pad.axes[
				PS4_MAP.pitch.axis
			] ?? 0;

		const pitchAxis =
			PS4_MAP.pitch.invert
				? -rawPitch
				: rawPitch;

		this.sticks.pitch =
			applyDeadband(pitchAxis);

		// -------------------------------------------------------------
		// YAW
		// -------------------------------------------------------------

		this.sticks.yaw =
			applyDeadband(rawYaw);

		return true;
	}


	// ---------------------------------------------------------------------------
	// GAMEPAD READER
	// ---------------------------------------------------------------------------

	readGamepad(pad) {
		if (isPS4(pad)) {
			return this.readPS4(pad);
		}

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

		// Pitch
		if (has('arrowup')) {
			pitch += 1;
		}

		if (has('arrowdown')) {
			pitch -= 1;
		}

		// Mouse
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
