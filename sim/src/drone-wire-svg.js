// Le montage <svg> d'un fil de fer (issues #264, #281). Extrait de
// src/drone-portrait.js le jour où un deuxième écran a eu besoin de la même
// machine : le portrait d'archive qui tourne lentement, et l'assistant de
// calibrage où elle réagit aux manches. Deux animations, un seul dessin.
//
// Pourquoi du SVG et pas un canvas : src/session-log.js est un client pur
// (« aucune dépendance Three/Rapier ») et une machine en fil de fer ne doit pas
// y faire entrer le moteur pour deux cents traits.
//
// La couleur vient du contexte via currentColor, jamais d'ici — même règle que
// src/pixel-icons.js.
import { wireOf } from './drone-wire.js';

const NS = 'http://www.w3.org/2000/svg';

// `strokeWidth` est en unités du viewBox, qui va de -1.1 à 1.1, et c'est
// l'épaisseur du trait le plus PROCHE et le plus LOURD : la profondeur et le
// poids de la primitive l'amincissent ensuite jusqu'à un quart. À 0.010 et
// 160 px, ce trait-là fait 0.73 px : il tient le pixel, et le détail lointain
// se délave en gris — c'est la hiérarchie voulue pour une fiche d'archive
// (issue #283, rendu à 160 px et regardé : à 0.006 tout était sous le pixel
// et l'antialiasing faisait de la machine une tache uniforme). Un écran où
// l'on suit un manche en direct prend plus épais (issue #281).
// `minWeight` (#286) : en dessous de ce poids de primitive, le trait n'est pas
// tracé du tout. À 160 px, atténuer ne suffit pas — un moyeu de deux pixels
// reste une tache ; le retirer laisse lire les disques, les bras et le corps.
export function wireSvg({ shape, size = 160, className = 'drone-portrait', label = '', strokeWidth = 0.010, minWeight = 0 } = {}) {
	const el = document.createElementNS(NS, 'svg');
	el.setAttribute('viewBox', '-1.1 -1.1 2.2 2.2');
	el.setAttribute('width', String(size));
	el.setAttribute('height', String(size));
	el.setAttribute('class', className);
	if (label) el.setAttribute('aria-label', label);

	// Le groupe existe pour porter une translation SANS toucher à la
	// projection : le gaz fait MONTER la machine dans le cadre, et wireOf n'a
	// pas à connaître le gaz.
	const g = document.createElementNS(NS, 'g');
	el.appendChild(g);

	const lines = [];
	// L'ordre de tracé, réutilisé d'une frame à l'autre : SVG peint dans
	// l'ordre du DOM, et on veut le lointain DESSOUS le proche.
	let order = new Uint32Array(0);
	return {
		el,
		// `view` part tel quel dans wireOf : orbite de caméra (yawDeg, pitchDeg)
		// ET attitude de la machine (roll, pitch, yaw).
		draw(view, { lift = 0 } = {}) {
			// SVG a l'axe Y vers le BAS : monter, c'est translater vers le
			// négatif — comme l'inversion des y ci-dessous.
			g.setAttribute('transform', `translate(0 ${(-lift).toFixed(4)})`);

			const w = wireOf(shape, view);
			const n = w.segments.length / 4;
			while (lines.length < n) {
				const l = document.createElementNS(NS, 'line');
				l.setAttribute('stroke', 'currentColor');
				l.setAttribute('stroke-width', String(strokeWidth));
				g.appendChild(l);
				lines.push(l);
			}
			// Le lointain d'abord (issue #283) : sans ce tri, une arête du fond
			// pouvait passer par-dessus une arête du devant, et la profondeur
			// que l'opacité raconte était contredite par le tracé.
			if (order.length !== n) order = Uint32Array.from({ length: n }, (_, i) => i);
			order.sort((i, j) => w.depth[j] - w.depth[i]);
			for (let k = 0; k < n; k++) {
				const i = order[k];
				const l = lines[k];
				l.setAttribute('x1', w.segments[4 * i].toFixed(4));
				// Sans cette inversion, la machine est sur le dos.
				l.setAttribute('y1', (-w.segments[4 * i + 1]).toFixed(4));
				l.setAttribute('x2', w.segments[4 * i + 2].toFixed(4));
				l.setAttribute('y2', (-w.segments[4 * i + 3]).toFixed(4));
				// Pas d'élimination des faces cachées : les arêtes lointaines
				// s'ATTÉNUENT — en opacité ET en épaisseur, deux indices de
				// profondeur qui vont dans le même sens. Une machine qu'on voit
				// à travers se lit mieux qu'une silhouette pleine.
				// Et la hiérarchie du dessin technique : les grandes lignes en
				// fort, le détail en fin (le poids vient de wireOf).
				const d = w.depth[i], g = w.weight[i];
				l.setAttribute('opacity', g < minWeight ? '0' : ((1 - 0.72 * d) * (0.7 + 0.3 * g)).toFixed(3));
				l.setAttribute('stroke-width', (strokeWidth * (1 - 0.45 * d) * (0.5 + 0.5 * g)).toFixed(5));
			}
			for (let i = n; i < lines.length; i++) lines[i].setAttribute('opacity', '0');
		},
	};
}

// L'horloge n'est pas garantie : les selftests montent ces écrans sur un faux
// DOM. Sans elle le dessin est simplement immobile — il ne lève pas, et stop()
// reste sûr à appeler.
export function wireLoop(frame) {
	const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
	const unraf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
	// `t0 = null` et pas 0 : une première frame à t = 0 est parfaitement légale
	// (c'est ce que rend une horloge de test), et `!t0` la relirait comme « pas
	// encore d'origine » à chaque frame — le dessin resterait figé.
	let handle = 0, t0 = null, stopped = false;
	const step = (t) => {
		if (stopped) return;
		if (t0 === null) t0 = t;
		frame(t - t0);
		handle = raf(step);
	};
	if (raf) handle = raf(step);
	return () => { stopped = true; if (unraf) unraf(handle); };
}
