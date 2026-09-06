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

// `strokeWidth` est en unités du viewBox, qui va de -1.1 à 1.1 : à 0.006 et
// 160 px le trait fait 0.44 px, donc moins d'un pixel — l'antialiasing le
// délave en gris. C'est le rendu voulu pour une fiche d'archive, qui doit
// s'effacer ; un écran où l'on suit un manche en direct a besoin d'un trait
// qui tient le pixel (issue #281, rendu dans le panneau et regardé).
export function wireSvg({ shape, size = 160, className = 'drone-portrait', label = '', strokeWidth = 0.006 } = {}) {
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
			for (let i = 0; i < n; i++) {
				const l = lines[i];
				l.setAttribute('x1', w.segments[4 * i].toFixed(4));
				// Sans cette inversion, la machine est sur le dos.
				l.setAttribute('y1', (-w.segments[4 * i + 1]).toFixed(4));
				l.setAttribute('x2', w.segments[4 * i + 2].toFixed(4));
				l.setAttribute('y2', (-w.segments[4 * i + 3]).toFixed(4));
				// Pas d'élimination des faces cachées : les arêtes lointaines
				// s'ATTÉNUENT. Une machine qu'on voit à travers se lit mieux
				// qu'une silhouette pleine.
				l.setAttribute('opacity', (1 - 0.65 * w.depth[i]).toFixed(3));
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
