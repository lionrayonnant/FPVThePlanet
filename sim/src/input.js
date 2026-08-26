// Sticks are normalised to {throttle 0..1, roll/pitch/yaw -1..1} regardless of
// whether they came from a radio or the keyboard.

const STORAGE_KEY = 'fpvmaps.gamepadMap';
const DEADBAND = 0.06;

// Two common layouts. EdgeTX radios (Radiomaster, Jumper, FrSky) expose
// roll/pitch/throttle/yaw on axes 0-3 in USB joystick mode; game controllers use
// the Mode 2 arrangement of two centred sticks.
const EDGETX_MAP = {
	roll: { axis: 0, invert: false },
	pitch: { axis: 1, invert: true },
	throttle: { axis: 2, invert: false },
	yaw: { axis: 3, invert: false },
};

const PAD_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	pitch: { axis: 3, invert: true },
	roll: { axis: 2, invert: false },
};

const RADIO_RE = /edgetx|opentx|radiomaster|frsky|jumper|tx16|taranis|betafpv|flysky/i;

function defaultMapFor(pad) {
	return structuredClone(pad && RADIO_RE.test(pad.id) ? EDGETX_MAP : PAD_MAP);
}

export const CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'];

function applyDeadband(v) {
	if (Math.abs(v) < DEADBAND) return 0;
	return Math.sign(v) * (Math.abs(v) - DEADBAND) / (1 - DEADBAND);
}

export class Input {
	constructor() {
		const saved = loadMap();
		this._savedMap = saved !== null;
		this.map = saved ?? structuredClone(PAD_MAP);
		this.sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
		this.gamepadIndex = null;
		this.usingGamepad = false;
		this._baseline = new Map();

		// Keyboard state; throttle is held between frames like a real stick.
		this.keys = new Set();
		this.kbThrottle = 0;
		this.mouse = { x: 0, y: 0 };
		this.pointerLocked = false;
		this.onAction = () => {};

		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = e.key.toLowerCase();
			this.keys.add(k);
			if (['r', 'm', 'p', 'c', 'tab', 'escape'].includes(k)) this.onAction(k, e);
			if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
		window.addEventListener('blur', () => this.keys.clear());

		window.addEventListener('gamepadconnected', (e) => {
			this._baseline.set(e.gamepad.index, [...e.gamepad.axes]);
		});
		window.addEventListener('gamepaddisconnected', (e) => {
			this._baseline.delete(e.gamepad.index);
			if (this.gamepadIndex === e.gamepad.index) {
				this.gamepadIndex = null;
				this.usingGamepad = false;
			}
		});

		document.addEventListener('pointerlockchange', () => {
			this.pointerLocked = document.pointerLockElement !== null;
		});
		window.addEventListener('mousemove', (e) => {
			if (!this.pointerLocked) return;
			this.mouse.x = Math.max(-1, Math.min(1, this.mouse.x + e.movementX * 0.004));
			this.mouse.y = Math.max(-1, Math.min(1, this.mouse.y - e.movementY * 0.004));
		});
	}

	// Picks the device that is actually being moved. Some keyboards (Keychron,
	// for one) enumerate as gamepads with every axis at rest, and would otherwise
	// take over and sit at 50% throttle forever.
	getGamepad() {
		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		for (const p of pads) {
			if (!p) continue;
			const base = this._baseline.get(p.index);
			if (!base) { this._baseline.set(p.index, [...p.axes]); continue; }
			if (this.gamepadIndex === p.index) continue;
			// Any axis moving well beyond noise marks this device as the live one.
			if (p.axes.some((v, i) => Math.abs(v - base[i]) > 0.2)) {
				this.gamepadIndex = p.index;
				if (!this._savedMap) this.map = defaultMapFor(p);
				console.log(`[input] using "${p.id}"`);
			}
		}
		return this.gamepadIndex !== null ? (pads[this.gamepadIndex] ?? null) : null;
	}

	// Lists connected devices so the settings panel can offer a manual choice.
	listGamepads() {
		return [...(navigator.getGamepads?.() ?? [])].filter(Boolean)
			.map(p => ({ index: p.index, id: p.id, axes: p.axes.length }));
	}

	selectGamepad(index) {
		this.gamepadIndex = index;
		const pad = (navigator.getGamepads?.() ?? [])[index];
		if (pad && !this._savedMap) this.map = defaultMapFor(pad);
	}

	setMapping(channel, axis, invert) {
		this.map[channel] = { axis, invert };
		this._savedMap = true;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map));
	}

	update(dt) {
		const pad = this.getGamepad();
		if (pad && this.readGamepad(pad)) {
			this.usingGamepad = true;
		} else {
			this.usingGamepad = false;
			this.readKeyboard(dt);
		}
		return this.sticks;
	}

	readGamepad(pad) {
		const raw = (ch) => {
			const m = this.map[ch];
			const v = pad.axes[m.axis];
			if (v === undefined) return null;
			return m.invert ? -v : v;
		};
		const t = raw('throttle');
		if (t === null) return false;
		// Any stick off centre means the radio is live and should take over.
		this.sticks.throttle = (t + 1) / 2;
		this.sticks.yaw = applyDeadband(raw('yaw') ?? 0);
		this.sticks.pitch = applyDeadband(raw('pitch') ?? 0);
		this.sticks.roll = applyDeadband(raw('roll') ?? 0);
		return true;
	}

	readKeyboard(dt) {
		const has = (...k) => k.some(x => this.keys.has(x));

		// Throttle ramps while held, so it behaves like a stick rather than a switch.
		if (has('w', 'z')) this.kbThrottle += dt * 1.2;
		else if (has('s')) this.kbThrottle -= dt * 1.2;
		this.kbThrottle = Math.max(0, Math.min(1, this.kbThrottle));

		let roll = 0, pitch = 0, yaw = 0;
		if (has('a', 'q')) yaw -= 1;
		if (has('d')) yaw += 1;
		if (has('arrowleft')) roll -= 1;
		if (has('arrowright')) roll += 1;
		if (has('arrowup')) pitch += 1;
		if (has('arrowdown')) pitch -= 1;

		if (this.pointerLocked && roll === 0 && pitch === 0) {
			roll = this.mouse.x;
			pitch = this.mouse.y;
			// Self-centre, since a mouse has no springs.
			const decay = Math.exp(-dt * 3.5);
			this.mouse.x *= decay;
			this.mouse.y *= decay;
		}

		this.sticks.throttle = this.kbThrottle;
		this.sticks.roll = roll;
		this.sticks.pitch = pitch;
		this.sticks.yaw = yaw;
	}

	resetKeyboardThrottle() {
		this.kbThrottle = 0;
		this.mouse.x = this.mouse.y = 0;
	}
}

// Returns null when nothing usable is stored, so a device-specific default can
// be chosen once we know which device is in use.
function loadMap() {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
		if (saved && CHANNELS.every(c => saved[c] && typeof saved[c].axis === 'number')) return saved;
	} catch { /* fall through */ }
	return null;
}
