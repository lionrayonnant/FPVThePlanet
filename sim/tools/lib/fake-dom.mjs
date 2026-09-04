// Un faux DOM, juste assez pour monter les écrans du terminal hors navigateur.
//
// Même intention que tools/lib/fake-audio-ctx.mjs : ce qu'on vérifie est
// l'ARBRE et le CÂBLAGE — quels éléments existent, ce qu'ils portent, ce qui
// se passe quand on les actionne — pas le rendu, qui se juge à l'œil.
//
// Volontairement minimal, et volontairement STRICT : ce qui n'est pas
// implémenté lève au lieu de rendre undefined. Un faux DOM permissif fait
// passer des tests sur du code qui ne marcherait pas dans un navigateur, ce
// qui est pire que pas de test du tout. En particulier innerHTML n'existe pas
// ici : les écrans construisent leur arbre avec createElement.

class FakeClassList {
	constructor(el) { this.el = el; }
	get _set() { return new Set(String(this.el.className).split(/\s+/).filter(Boolean)); }
	contains(c) { return this._set.has(c); }
	add(...cs) { const s = this._set; cs.forEach((c) => s.add(c)); this.el.className = [...s].join(' '); }
	remove(...cs) { const s = this._set; cs.forEach((c) => s.delete(c)); this.el.className = [...s].join(' '); }
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

	// --- arbre

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

	contains(el) {
		for (let n = el; n; n = n.parent) if (n === this) return true;
		return false;
	}

	// --- contenu

	// textContent d'un conteneur = la concaténation de ses descendants, comme
	// dans un vrai DOM : les assertions « la ligne dit X » doivent pouvoir
	// interroger une sous-arborescence, pas seulement une feuille.
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
		throw new Error('fake-dom: innerHTML non vide non supporté — construis l\'arbre avec createElement');
	}

	setAttribute(k, v) { this.attributes[k] = String(v); }
	getAttribute(k) { return this.attributes[k] ?? null; }

	// --- sélection
	//
	// Sélecteurs supportés : `.classe`, `tag`, `[attr]`, `[attr="v"]`, et une
	// liste séparée par des virgules. Assez pour FOCUSABLE et pour les
	// data-bench-key ; tout le reste lève plutôt que de mentir.

	matches(sel) {
		return sel.split(',').map((s) => s.trim()).filter(Boolean).some((s) => this._matchOne(s));
	}

	_matchOne(sel) {
		// `button:not(:disabled)` et `input:not(:disabled)`
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
		throw new Error(`fake-dom: sélecteur non supporté « ${sel} »`);
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
	blur() { if (ACTIVE === this) ACTIVE = null; }

	click() {
		if (this.disabled) return;   // comme un vrai bouton désactivé
		this.onclick?.({ preventDefault() {} });
	}

	dispatchEvent(ev) {
		const h = this[`on${ev.type}`];
		if (h) h.call(this, ev);
		return true;
	}

	// checkVisibility : menu-nav.js s'en sert pour ignorer un écran masqué.
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
		createElement: (tag) => new FakeElement(tag),
		createTextNode: (t) => new FakeTextNode(t),
		get activeElement() { return ACTIVE; },
		body: root,
		getElementById: (id) => root.querySelector(`[id="${id}"]`),
		exitPointerLock: () => {},
	};

	const window_ = {
		addEventListener: (type, fn) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
	};

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
		// Rejoue un keydown vers les abonnés de menu-nav.js.
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
	};
}

// Installe le faux DOM sur les globals que lisent les modules d'écran, et rend
// la fonction qui remet tout en place.
export function installFakeDom() {
	const fake = fakeDom();
	const saved = {};
	const g = globalThis;
	for (const k of ['document', 'window', 'localStorage', 'navigator', 'requestAnimationFrame']) {
		saved[k] = Object.getOwnPropertyDescriptor(g, k);
	}
	Object.defineProperty(g, 'document', { value: fake.document, configurable: true, writable: true });
	Object.defineProperty(g, 'window', { value: fake.window, configurable: true, writable: true });
	Object.defineProperty(g, 'localStorage', { value: fake.localStorage, configurable: true, writable: true });
	// menu-nav.js interroge la manette à chaque tick ; aucune ici.
	Object.defineProperty(g, 'navigator', { value: { getGamepads: () => [] }, configurable: true, writable: true });

	fake.restore = () => {
		ACTIVE = null;
		for (const [k, d] of Object.entries(saved)) {
			if (d) Object.defineProperty(g, k, d);
			else delete g[k];
		}
	};
	return fake;
}
