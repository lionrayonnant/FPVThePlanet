// Le mouvement des menus (issue #224, Bible §45 : quiet by default). Un seul
// vocabulaire, minuscule, appliqué partout : les blocs d'un écran s'impriment
// en cascade de haut en bas, un compteur roule jusqu'à sa valeur, et c'est
// tout. Trois durées (tokens.css : --dur-1/2/3), en pas plutôt qu'en fondus,
// pour rester hardware. Aucune couleur demo scene ici — elles appartiennent
// aux rituels. `prefers-reduced-motion` coupe tout : le CSS n'anime plus et
// les helpers sautent directement à l'état final.
//
// Ce module ne connaît pas les écrans : terminal.js appelle watchReveal()
// depuis screen(), et chaque bloc ajouté ensuite — tout de suite ou après un
// fetch — reçoit son délai dans l'ordre où il arrive. La logique pure
// (revealDelays, revealTargets, interpolateNumbers) est couverte par
// tools/motion-selftest.mjs sur le faux DOM.

export const LEAD_MS = 90;   // extinction : le noir avant la première ligne
export const STEP_MS = 40;   // un pas d'impression par ligne
export const CAP_MS = 520;   // au-delà, tout s'imprime en même temps
export const COUNT_MS = 360; // durée du roulement d'un compteur
export const EXIT_MS = 90;   // impression inverse : l'écran qui s'en va (--dur-1)

// Les conteneurs OUVERTS : ce sont leurs enfants qui s'impriment un à un, pas
// le conteneur d'un coup — une colonne, une liste, une rangée de liens. Le
// conteneur lui-même n'est pas animé. Les résultats du scanner n'en font pas
// partie : ils se réécrivent à chaque touche, une cascade y ferait traîner.
const OPEN = ['terminal-left', 'terminal-areas', 'terminal-list', 'terminal-nav', 'terminal-acts'];

export function reducedMotion() {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Les délais d'une fournée de n blocs : le lead, puis un pas par bloc, plafonné.
export function revealDelays(n, { lead = LEAD_MS, step = STEP_MS, cap = CAP_MS } = {}) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(Math.min(cap, lead + i * step));
	return out;
}

const isElement = (node) => !!node && typeof node.className === 'string' && !!node.classList;
const isOpen = (node) => OPEN.some((c) => node.classList.contains(c));

// Les cibles d'un écran, dans l'ordre de lecture : ses enfants directs, sauf
// qu'un conteneur ouvert s'ouvre sur les siens, récursivement.
export function revealTargets(box, out = []) {
	for (const child of box.children) {
		if (!isElement(child)) continue;
		if (isOpen(child)) revealTargets(child, out);
		else out.push(child);
	}
	return out;
}

// Tamponne les cibles pas encore tamponnées. Une seconde fournée (bloc ajouté
// après un fetch) repart du lead : c'est une nouvelle impression.
export function reveal(box, opts = {}) {
	const fresh = revealTargets(box).filter((el) => el.dataset.reveal === undefined);
	const delays = reducedMotion() ? fresh.map(() => 0) : revealDelays(fresh.length, opts);
	fresh.forEach((el, i) => {
		el.dataset.reveal = String(delays[i]);
		el.style.animationDelay = `${delays[i]}ms`;
	});
	return fresh.length;
}

// Le délai de révélation du bloc qui contient `el` — un compteur attend que
// sa ligne soit visible avant de rouler.
export function revealDelayOf(el) {
	for (let n = el; n; n = n.parentElement ?? n.parent ?? null) {
		if (n.dataset?.reveal !== undefined) return Number(n.dataset.reveal) || 0;
	}
	return 0;
}

// Branche la révélation sur un écran : la fournée initiale au prochain
// microtask (avant le premier rendu, avec le noir du lead), puis chaque ajout
// ultérieur — un re-rendu de colonne, un bloc arrivé après un fetch — sans
// lead : l'écran est déjà là, seule la cascade reste. Retourne la fonction
// qui débranche.
export function watchReveal(box) {
	// Le lead vaut pour la première impression : la première fournée qui
	// tamponne quelque chose, qu'elle arrive au microtask ou après un fetch.
	// Une colonne re-rendue juste derrière (la Home le fait deux fois au
	// montage) garde ce qui reste du lead ; un bloc arrivé bien plus tard n'en
	// a plus — l'écran est déjà là, seule la cascade reste.
	let t0 = null;
	const batch = () => {
		const elapsed = t0 === null ? 0 : performance.now() - t0;
		if (reveal(box, { lead: Math.max(0, LEAD_MS - elapsed) }) && t0 === null) t0 = performance.now();
	};
	queueMicrotask(() => { if (box.isConnected !== false) batch(); });
	if (typeof MutationObserver !== 'function') return () => {};
	const mo = new MutationObserver(batch);
	mo.observe(box, { childList: true, subtree: true });
	return () => mo.disconnect();
}

// --- sortie d'écran ----------------------------------------------------------

// L'écran qui s'en va s'imprime À L'ENVERS (#67). Sans ça, un enchaînement
// d'écrans — l'analyse, l'invite, le résultat — était une coupe franche au
// milieu d'une cascade : le nouvel écran commençait à s'imprimer dans la même
// frame où l'ancien disparaissait, et les deux impressions se marchaient
// dessus. Un écran s'éteint, puis le suivant s'allume.
//
// Même grammaire que l'entrée : deux pas, une durée de token, aucun fondu long
// (Bible §45). C'est le CSS qui anime ([data-exit]) ; ici on ne fait que poser
// le marqueur et rendre la main quand c'est fini.
//
// Sans matchMedia — le faux DOM des selftests — il n'y a aucun moteur
// d'animation derrière le marqueur : attendre 90 ms n'attendrait rien. La
// sortie est alors immédiate, et les tests de rendu enchaînent les écrans en
// un microtask comme avant.
export function exitScreen(el, { ms = EXIT_MS } = {}) {
	if (!el || typeof matchMedia !== 'function' || reducedMotion()) return Promise.resolve();
	el.dataset.exit = '1';
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// --- compteurs ---------------------------------------------------------------

// Chaque entier isolé du texte (pas une décimale, pas un « 0.97b ») roule de
// 0 à sa valeur, en gardant sa largeur pour que la ligne ne saute pas.
export function interpolateNumbers(text, t) {
	if (t >= 1) return text;
	return text.replace(/(?<![\d.])\d+(?![\d.]|\w)/g, (m) => {
		const v = Math.round(Number(m) * t);
		return String(v).padStart(m.length, ' ');
	});
}

const easeOut = (t) => 1 - (1 - t) * (1 - t);

// Fait rouler les chiffres de `el` jusqu'à son texte actuel, après le délai de
// révélation de sa ligne. Sans navigateur ou en mouvement réduit : rien.
export function countUp(el, { duration = COUNT_MS } = {}) {
	const final = el.textContent;
	if (reducedMotion() || typeof requestAnimationFrame !== 'function') return;
	const delay = revealDelayOf(el);
	el.textContent = interpolateNumbers(final, 0);
	let start = null;
	const tick = (now) => {
		if (!el.isConnected) return;
		if (start === null) start = now + delay;
		const t = Math.max(0, Math.min(1, (now - start) / duration));
		el.textContent = interpolateNumbers(final, easeOut(t));
		if (t < 1) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

// --- feedback des boutons ----------------------------------------------------

// Un clic sur un bouton de menu le fait clignoter en inversé, comme une touche
// physique. Délégué au document : les écrans sont montés et démontés sans
// cesse, un bouton qui disparaît au clic n'a simplement pas de flash.
export function installClickFlash(doc = document) {
	doc.addEventListener('click', (e) => {
		const b = e.target?.closest?.('button');
		if (!b || b.disabled || reducedMotion()) return;
		b.classList.remove('flash');
		void b.offsetWidth; // relance l'animation si on reclique vite
		b.classList.add('flash');
	}, true);
}
