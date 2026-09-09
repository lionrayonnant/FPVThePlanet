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

	// La racine de l'arbre, comme dans un vrai DOM. OrbitControls s'en sert
	// pour poser ses écouteurs de pointeur au-dessus du canvas.
	getRootNode() { let n = this; while (n.parent) n = n.parent; return n; }

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

	// Sérialisation minimale, pour les rares tests qui inspectent le BALISAGE
	// plutôt que l'arbre — le portrait SVG (#264) doit prouver qu'aucune
	// couleur littérale n'y est écrite, et ça ne se lit que sur le texte rendu.
	// Ce n'est pas un moteur de rendu : pas d'échappement, pas de balises
	// auto-fermantes, pas d'ordre canonique des attributs.
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
	blur() {
		if (ACTIVE === this) ACTIVE = null;
		this.dispatchEvent({ type: 'blur' });
	}

	click() {
		if (this.disabled) return;   // comme un vrai bouton désactivé
		this.dispatchEvent({ type: 'click', preventDefault() {} });
	}

	// Un élément accepte les DEUX conventions : la propriété `onclick`, que le
	// gros du code utilise, et addEventListener, dont se sert tout ce qui doit
	// cohabiter avec un gestionnaire déjà posé (src/confirm-button.js, #213).
	// Sans ça, un module écrit en DOM idiomatique n'était pas testable ici.
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
		// Le SVG en ligne passe par createElementNS ; ici l'espace de noms n'est
		// que retenu, rien n'en dépend — tagName suffit à la sélection.
		createElementNS: (ns, tag) => {
			const el = new FakeElement(tag);
			el.namespaceURI = String(ns);
			return el;
		},
		createTextNode: (t) => new FakeTextNode(t),
		get activeElement() { return ACTIVE; },
		body: root,
		getElementById: (id) => root.querySelector(`[id="${id}"]`),
		exitPointerLock: () => {},
		// src/input.js s'abonne sur `document` (clavier, souris, pointer lock) :
		// sans ces deux-là, instancier Input() lève et rien de ce qui en dépend
		// n'est testable sans navigateur.
		addEventListener: () => {},
		removeEventListener: () => {},
	};

	const window_ = {
		addEventListener: (type, fn) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},
		removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
		// Nombre de rappels d'animation RÉELLEMENT rejoués. C'est la mesure qui
		// permet à un test d'affirmer qu'un écran démonté a bien cessé de
		// tourner : après stop(), tick() ne doit plus rien faire monter.
		__rafCount: 0,
	};

	// L'horloge d'animation. La file est tenue ici, mais les globals ne sont
	// installés que sur demande (installFakeDom({ raf: true })) — voir là-bas
	// pourquoi ce n'est pas le défaut.
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
		requestAnimationFrame(fn) { const id = ++rafSeq; rafPending.set(id, fn); return id; },
		cancelAnimationFrame(id) { rafPending.delete(id); },
		// Avance l'horloge de `ms` et rejoue les rappels EN ATTENTE, une seule
		// fois : un rappel qui se réinscrit repart au tick suivant, jamais dans
		// celui-ci — sinon une boucle d'animation ferait tourner Node à l'infini.
		tick(ms = 16) {
			rafNow += ms;
			const due = [...rafPending.values()];
			rafPending.clear();
			for (const fn of due) { window_.__rafCount++; fn(rafNow); }
			return rafNow;
		},
	};
}

// Installe le faux DOM sur les globals que lisent les modules d'écran, et rend
// la fonction qui remet tout en place.
// `raf` installe requestAnimationFrame/cancelAnimationFrame, pilotés par
// fake.tick(). Ce n'est PAS le défaut, et c'est délibéré : src/motion.js teste
// `typeof requestAnimationFrame === 'function'` pour décider s'il anime, et
// countUp() commence par écrire ses compteurs à zéro. Sur un DOM où rien ne
// pousse les frames, les compteurs resteraient à zéro pour toujours — les
// écrans se testeraient sur un texte qu'aucun navigateur n'affiche. Seul un
// test qui rejoue lui-même les frames demande cette horloge.
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
	// menu-nav.js interroge la manette à chaque tick ; aucune ici.
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
