// A fake DOM, just enough to mount the terminal screens outside a browser.
//
// Same intent as tools/lib/fake-audio-ctx.mjs: what is checked is the TREE and
// the WIRING — which elements exist, what they carry, what happens when they
// are actuated — not the rendering, which is judged by eye.
//
// Deliberately minimal, and deliberately STRICT: whatever is not implemented
// throws instead of returning undefined. A permissive fake DOM passes tests on
// code that would not work in a browser, which is worse than no test at all.
// innerHTML in particular does not exist here: the screens build their tree
// with createElement.

class FakeClassList {
	constructor(el) { this.el = el; }
	get _set() { return new Set(String(this.el.className).split(/\s+/).filter(Boolean)); }
	contains(c) { return this._set.has(c); }
	add(...cs) { const s = this._set; cs.forEach((c) => s.add(c)); this.el.className = [...s].join(' '); }
	remove(...cs) { const s = this._set; cs.forEach((c) => s.delete(c)); this.el.className = [...s].join(' '); }
	toggle(c, force) {
		const on = force === undefined ? !this.contains(c) : !!force;
		this[on ? 'add' : 'remove'](c);
		return on;
	}
}

let ACTIVE = null;

class FakeElement {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.className = '';
		this.dataset = {};
		this.attributes = {};
		this.style = {};
		this.disabled = false;
		this.hidden = false;
		this._text = '';
		this.classList = new FakeClassList(this);
		this.options = [];
	}

	// --- tree

	appendChild(child) {
		if (child.parent) child.parent.removeChild(child);
		child.parent = this;
		this.children.push(child);
		if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
		return child;
	}

	append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

	removeChild(child) {
		const i = this.children.indexOf(child);
		if (i >= 0) this.children.splice(i, 1);
		const j = this.options.indexOf(child);
		if (j >= 0) this.options.splice(j, 1);
		child.parent = null;
		return child;
	}

	replaceChildren(...nodes) {
		for (const c of [...this.children]) this.removeChild(c);
		this.options = [];
		nodes.forEach((n) => this.appendChild(n));
	}

	remove() { this.parent?.removeChild(this); }

	get isConnected() {
		let n = this;
		while (n.parent) n = n.parent;
		return n._isRoot === true;
	}

	// The root of the tree, as in a real DOM. OrbitControls uses it to put its
	// pointer listeners above the canvas.
	getRootNode() { let n = this; while (n.parent) n = n.parent; return n; }

	contains(el) {
		for (let n = el; n; n = n.parent) if (n === this) return true;
		return false;
	}

	// --- content

	// A container's textContent is its descendants concatenated, as in a real
	// DOM: a "the line says X" assertion must be able to query a subtree, not
	// only a leaf.
	get textContent() {
		return this.children.length
			? this.children.map((c) => c.textContent).join('')
			: this._text;
	}

	set textContent(v) {
		this.replaceChildren();
		this._text = String(v);
	}

	set innerHTML(v) {
		if (v === '') { this.replaceChildren(); this._text = ''; return; }
		throw new Error('fake-dom: non-empty innerHTML is not supported — build the tree with createElement');
	}

	// Minimal serialisation, for the few tests that inspect the MARKUP rather
	// than the tree — the SVG portrait (#264) must prove no literal colour is
	// written into it, and that only reads off the rendered text. This is not a
	// renderer: no escaping, no self-closing tags, no canonical attribute
	// order.
	get outerHTML() {
		const tag = this.tagName.toLowerCase();
		const attrs = { ...this.attributes };
		if (this.className) attrs.class = this.className;
		const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
		const inner = this.children.length
			? this.children.map((c) => c.outerHTML ?? c.textContent).join('')
			: this._text;
		return `<${tag}${a}>${inner}</${tag}>`;
	}

	setAttribute(k, v) { this.attributes[k] = String(v); }
	getAttribute(k) { return this.attributes[k] ?? null; }

	// --- selection
	//
	// Supported selectors: `.class`, `tag`, `[attr]`, `[attr="v"]`, and a
	// comma-separated list. Enough for FOCUSABLE and for the data-bench-key
	// ones; everything else throws rather than lie.

	matches(sel) {
		return sel.split(',').map((s) => s.trim()).filter(Boolean).some((s) => this._matchOne(s));
	}

	_matchOne(sel) {
		// `button:not(:disabled)` and `input:not(:disabled)`
		const not = sel.match(/^([a-z]+):not\(:disabled\)$/i);
		if (not) return this.tagName === not[1].toUpperCase() && !this.disabled;
		if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
		const attrEq = sel.match(/^([a-z]*)\[([\w-]+)="([^"]*)"\]$/i);
		if (attrEq) {
			const [, tag, attr, val] = attrEq;
			if (tag && this.tagName !== tag.toUpperCase()) return false;
			return this._attrValue(attr) === val;
		}
		const attrHas = sel.match(/^([a-z]*)\[([\w-]+)\]$/i);
		if (attrHas) {
			const [, tag, attr] = attrHas;
			if (tag && this.tagName !== tag.toUpperCase()) return false;
			return this._attrValue(attr) !== null;
		}
		if (/^[a-z]+$/i.test(sel)) return this.tagName === sel.toUpperCase();
		throw new Error(`fake-dom: unsupported selector "${sel}"`);
	}

	_attrValue(attr) {
		if (attr.startsWith('data-')) {
			const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			return this.dataset[key] ?? null;
		}
		if (attr === 'type') return this.type ?? null;
		if (attr === 'href') return this.href ?? null;
		return this.attributes[attr] ?? null;
	}

	querySelectorAll(sel) {
		const out = [];
		const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
		walk(this);
		return out;
	}

	querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

	// --- interaction

	focus() { ACTIVE = this; }
	blur() {
		if (ACTIVE === this) ACTIVE = null;
		this.dispatchEvent({ type: 'blur' });
	}

	click() {
		if (this.disabled) return;   // like a real disabled button
		this.dispatchEvent({ type: 'click', preventDefault() {} });
	}

	// An element accepts BOTH conventions: the `onclick` property, which most
	// of the code uses, and addEventListener, used by anything that must live
	// alongside a handler already in place (src/confirm-button.js, #213).
	// Without it, a module written in idiomatic DOM was not testable here.
	addEventListener(type, fn) {
		(this._listeners ??= new Map()).set(type, [...(this._listeners.get(type) ?? []), fn]);
	}

	removeEventListener(type, fn) {
		const l = this._listeners?.get(type);
		if (l) this._listeners.set(type, l.filter((f) => f !== fn));
	}

	dispatchEvent(ev) {
		const h = this[`on${ev.type}`];
		if (h) h.call(this, ev);
		for (const fn of this._listeners?.get(ev.type) ?? []) fn.call(this, ev);
		return true;
	}

	// checkVisibility: menu-nav.js uses it to skip a hidden screen.
	checkVisibility() {
		for (let n = this; n; n = n.parent) if (n.hidden) return false;
		return true;
	}
}

class FakeTextNode {
	constructor(text) { this._text = String(text); this.children = []; this.parent = null; }
	get textContent() { return this._text; }
	matches() { return false; }
	get isConnected() { return true; }
}

export function fakeDom() {
	const root = new FakeElement('div');
	root._isRoot = true;
	root.dataset.role = 'document';

	const listeners = new Map();

	const document_ = {
		createElement: (tag) => own(new FakeElement(tag)),
		// Inline SVG goes through createElementNS; here the namespace is only
		// remembered, nothing depends on it — tagName is enough to select.
		createElementNS: (ns, tag) => {
			const el = own(new FakeElement(tag));
			el.namespaceURI = String(ns);
			return el;
		},
		createTextNode: (t) => new FakeTextNode(t),
		get activeElement() { return ACTIVE; },
		body: root,
		getElementById: (id) => root.querySelector(`[id="${id}"]`),
		exitPointerLock: () => {},
		// src/input.js subscribes on `document` (keyboard, mouse, pointer
		// lock): without these two, instantiating Input() throws and nothing
		// that depends on it is testable without a browser.
		addEventListener: () => {},
		removeEventListener: () => {},
	};

	// OrbitControls (three >= 0.186) connects from its constructor, and
	// connect() starts by disconnecting: it reads domElement.ownerDocument to
	// drop the pointer listeners it puts there. An element born from this
	// document must know that document, or building a viewer throws.
	const own = (el) => { el.ownerDocument = document_; return el; };
	own(root);

	const window_ = {
		addEventListener: (type, fn) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
		// How many animation callbacks were ACTUALLY replayed. This is the
		// measure that lets a test claim an unmounted screen really stopped
		// running: after stop(), tick() must raise it no further.
		__rafCount: 0,
	};

	// The animation clock. The queue lives here, but the globals are installed
	// only on demand (installFakeDom({ raf: true })) — see there why that is
	// not the default.
	let rafSeq = 0;
	let rafNow = 0;
	const rafPending = new Map();

	const storage = new Map();
	const localStorage_ = {
		getItem: (k) => (storage.has(k) ? storage.get(k) : null),
		setItem: (k, v) => storage.set(k, String(v)),
		removeItem: (k) => storage.delete(k),
		clear: () => storage.clear(),
	};

	return {
		root,
		document: document_,
		window: window_,
		localStorage: localStorage_,
		storage,
		// Replays a keydown towards menu-nav.js' subscribers.
		key(k, target = null) {
			const ev = {
				key: k, target: target ?? ACTIVE ?? root,
				preventDefault() { this.defaultPrevented = true; },
				defaultPrevented: false,
			};
			for (const fn of listeners.get('keydown') ?? []) fn(ev);
			return ev;
		},
		setActive(el) { ACTIVE = el; },
		get active() { return ACTIVE; },
		requestAnimationFrame(fn) { const id = ++rafSeq; rafPending.set(id, fn); return id; },
		cancelAnimationFrame(id) { rafPending.delete(id); },
		// Advances the clock by `ms` and replays the PENDING callbacks, once: a
		// callback that re-registers leaves for the next tick, never this one —
		// otherwise an animation loop would spin Node forever.
		tick(ms = 16) {
			rafNow += ms;
			const due = [...rafPending.values()];
			rafPending.clear();
			for (const fn of due) { window_.__rafCount++; fn(rafNow); }
			return rafNow;
		},
	};
}

// Installs the fake DOM on the globals the screen modules read, and returns
// the function that puts everything back.
// `raf` installs requestAnimationFrame/cancelAnimationFrame, driven by
// fake.tick(). That is NOT the default, deliberately: src/motion.js tests
// `typeof requestAnimationFrame === 'function'` to decide whether it animates,
// and countUp() starts by writing its counters to zero. On a DOM where nothing
// pushes frames, the counters would stay at zero forever — the screens would
// be tested on text no browser ever shows. Only a test that replays the frames
// itself asks for this clock.
export function installFakeDom({ raf = false } = {}) {
	const fake = fakeDom();
	const saved = {};
	const g = globalThis;
	for (const k of ['document', 'window', 'localStorage', 'navigator',
		'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
		saved[k] = Object.getOwnPropertyDescriptor(g, k);
	}
	Object.defineProperty(g, 'document', { value: fake.document, configurable: true, writable: true });
	Object.defineProperty(g, 'window', { value: fake.window, configurable: true, writable: true });
	Object.defineProperty(g, 'localStorage', { value: fake.localStorage, configurable: true, writable: true });
	// menu-nav.js polls the gamepad on every tick; there is none here.
	Object.defineProperty(g, 'navigator', { value: { getGamepads: () => [] }, configurable: true, writable: true });
	// src/palette.js reads the CSS custom properties off the document. There is
	// no stylesheet here, so every token resolves to '' and palette.js falls
	// back to its own table — which is the point: a colour asserted in a test
	// must come from the code, not from a sheet the test did not load.
	Object.defineProperty(g, 'getComputedStyle', {
		value: () => ({ getPropertyValue: () => '' }), configurable: true, writable: true,
	});
	if (raf) {
		Object.defineProperty(g, 'requestAnimationFrame', { value: (fn) => fake.requestAnimationFrame(fn), configurable: true, writable: true });
		Object.defineProperty(g, 'cancelAnimationFrame', { value: (id) => fake.cancelAnimationFrame(id), configurable: true, writable: true });
	}

	fake.restore = () => {
		ACTIVE = null;
		for (const [k, d] of Object.entries(saved)) {
			if (d) Object.defineProperty(g, k, d);
			else delete g[k];
		}
	};
	return fake;
}
