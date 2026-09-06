// Le portrait du drone à l'écran (issue #264). Un <svg> en ligne, monochrome,
// qui tourne lentement — pas un canvas, pas de WebGL : src/session-log.js est
// un client pur (« aucune dépendance Three/Rapier ») et le portrait ne doit
// pas y faire entrer le moteur.
//
// La couleur vient du contexte via currentColor, jamais d'ici — même règle que
// src/pixel-icons.js.
//
// « Aucune migration » : la machine se reconstruit de `family` + `buildSeed`,
// que le serveur persiste en clair depuis PHASE 07. Tout l'historique déjà
// journalisé sait donc se dessiner, et une session qui n'a ni l'un ni l'autre
// (chemins dev, override NOMINAL) ne rend rien plutôt qu'un cadre vide.
import { wireOf } from './drone-wire.js';
import { shapeOf } from './drone-shape.js';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';

const NS = 'http://www.w3.org/2000/svg';
const PERIOD_S = 24;      // un tour complet, lent : c'est une fiche, pas une démo
const PITCH_DEG = 22;     // vu d'un peu au-dessus, comme une fiche d'atelier
const START_DEG = 30;     // trois quarts d'entrée : ni de face, ni de profil

export function dronePortrait({ family, buildSeed, size = 160 } = {}) {
	if (!family || !buildSeed) return null;

	const build = targetBuild({ seed: buildSeed, family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: buildSeed, family }),
		detail: 'portrait',
	});

	const el = document.createElementNS(NS, 'svg');
	el.setAttribute('viewBox', '-1.1 -1.1 2.2 2.2');
	el.setAttribute('width', String(size));
	el.setAttribute('height', String(size));
	el.setAttribute('class', 'drone-portrait');
	el.setAttribute('aria-label', `${family} ${buildSeed}`);

	const lines = [];
	const draw = (yawDeg) => {
		const w = wireOf(shape, { yawDeg, pitchDeg: PITCH_DEG });
		const n = w.segments.length / 4;
		while (lines.length < n) {
			const l = document.createElementNS(NS, 'line');
			l.setAttribute('stroke', 'currentColor');
			l.setAttribute('stroke-width', '0.006');
			el.appendChild(l);
			lines.push(l);
		}
		for (let i = 0; i < n; i++) {
			const l = lines[i];
			l.setAttribute('x1', w.segments[4 * i].toFixed(4));
			// SVG a l'axe Y vers le BAS : on inverse, sinon la machine est sur le dos.
			l.setAttribute('y1', (-w.segments[4 * i + 1]).toFixed(4));
			l.setAttribute('x2', w.segments[4 * i + 2].toFixed(4));
			l.setAttribute('y2', (-w.segments[4 * i + 3]).toFixed(4));
			// Les arêtes lointaines s'atténuent : pas d'élimination des faces
			// cachées, mais une profondeur qui se lit quand même.
			l.setAttribute('opacity', (1 - 0.65 * w.depth[i]).toFixed(3));
		}
		for (let i = n; i < lines.length; i++) lines[i].setAttribute('opacity', '0');
	};

	// L'horloge n'est pas garantie : les selftests montent ces écrans sur un
	// faux DOM. Sans elle le portrait est simplement immobile — il ne lève pas,
	// et stop() reste sûr à appeler.
	const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
	const unraf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;

	// `t0 = null` et pas 0 : une première frame à t = 0 est parfaitement légale
	// (c'est ce que rend une horloge de test), et `!t0` la relirait comme « pas
	// encore d'origine » à chaque frame — le portrait resterait figé.
	let handle = 0, t0 = null, stopped = false;
	const frame = (t) => {
		if (stopped) return;
		if (t0 === null) t0 = t;
		draw(START_DEG + ((t - t0) / 1000 / PERIOD_S) * 360);
		handle = raf(frame);
	};
	draw(START_DEG);
	if (raf) handle = raf(frame);

	return {
		el,
		stop() { stopped = true; if (unraf) unraf(handle); },
	};
}
