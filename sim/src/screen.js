// Le montage d'un écran plein cadre, une fois pour tous (#139).
//
// bootstrap.js et terminal.js montaient chacun le leur : même div, même boîte,
// même watchReveal(). Une seule des deux copies avait fini par gagner
// `close()` — l'impression inverse de #67 — et la chaîne de bootstrap est
// restée le seul endroit du jeu dont les écrans s'en vont d'un coup sec.
//
// Ce module ne connaît que le mobilier : les classes viennent de l'appelant,
// parce que ce sont elles qui disent de quel écran il s'agit.
import { watchReveal, exitScreen } from './motion.js';

// `createElement` plutôt qu'`innerHTML` : rigoureusement le même arbre, mais
// sans passer par l'analyseur HTML — ce qui rend l'écran montable sur le faux
// DOM de tools/lib/fake-dom.mjs, comme le faux AudioContext rend le son
// testable sans navigateur.
export function mountScreen(root, { cls = '', boxCls = '' } = {}) {
	const el = document.createElement('div');
	el.className = `bootstrap ${cls}`.trim();
	const box = document.createElement('div');
	box.className = `bootstrap-box ${boxCls}`.trim();
	el.appendChild(box);
	root.appendChild(el);
	// L'écran s'imprime de haut en bas (issue #224) : chaque bloc ajouté dans la
	// boîte — maintenant ou après un fetch — reçoit son délai.
	const unwatch = watchReveal(box);
	const remove = () => { unwatch(); el.remove(); };
	// `close()` : la même chose, mais l'écran s'imprime à l'envers d'abord et la
	// promesse ne rend la main qu'une fois qu'il est parti (#67). C'est ce qui
	// permet d'ENCHAÎNER deux écrans sans que la cascade du second commence dans
	// la frame où le premier disparaît. `remove()` reste synchrone : la plupart
	// des écrans se démontent parce qu'on quitte le menu, et là il n'y a rien à
	// regarder s'éteindre.
	//
	// `close({ revealBehind: true })` pour le dernier écran d'un enchaînement,
	// celui qui donne sur le vol : lui seul emmène son fond noir avec lui. Par
	// défaut le fond tient jusqu'au démontage, sinon la scène 3D chargée dessous
	// se voit entre deux écrans.
	const close = (opts) => exitScreen(el, opts).then(remove);
	return { el, box, remove, close };
}

// Un bouton d'écran. Les crochets appartiennent au CTA et à lui seul : c'est ce
// qui les distingue d'une touche clavier citée dans une aide (terminal.js,
// keyHints). Pas de `title` : l'infobulle native est du mobilier navigateur, que
// la Bible §44 refuse partout ailleurs — un bouton dit ce qu'il fait dans son
// libellé, ou la ligne d'aide sous lui le dit.
export function screenButton(label, onClick, cls = 'terminal-link') {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = cls.split(' ').some((c) => c === 'terminal-cta' || c === 'bootstrap-btn')
		? `[ ${label} ]`
		: label;
	b.onclick = onClick;
	return b;
}
