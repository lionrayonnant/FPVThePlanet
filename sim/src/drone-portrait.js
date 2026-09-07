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
import { wireSvg, wireLoop } from './drone-wire-svg.js';
import { shapeOf } from './drone-shape.js';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';

const PERIOD_S = 24;      // un tour complet, lent : c'est une fiche, pas une démo
const PITCH_DEG = 28;     // vu d'un peu au-dessus, comme une fiche d'atelier — assez pour que les disques s'ouvrent (#283)
const START_DEG = 30;     // trois quarts d'entrée : ni de face, ni de profil

export function dronePortrait({ family, buildSeed, size = 160 } = {}) {
	if (!family || !buildSeed) return null;

	const build = targetBuild({ seed: buildSeed, family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: buildSeed, family }),
		detail: 'portrait',
	});

	// Sous 200 px, le détail (moyeux, fixations, rubans, boîtier) n'est pas
	// tracé (#286) : rendu à 160 px et regardé, il faisait une tache.
	const view = wireSvg({ shape, size, label: `${family} ${buildSeed}`, minWeight: size < 200 ? 0.18 : 0 });
	const draw = (yawDeg) => view.draw({ yawDeg, pitchDeg: PITCH_DEG });

	draw(START_DEG);
	const stop = wireLoop((ms) => draw(START_DEG + (ms / 1000 / PERIOD_S) * 360));

	return { el: view.el, stop };
}
