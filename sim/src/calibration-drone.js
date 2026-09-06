// La machine qui réagit aux manches pendant le calibrage (issue #281).
//
// Le calibrage mesurait juste et ne montrait rien : le pilote poussait un
// manche et ne voyait qu'une barre horizontale se déplacer. C'est ce que
// l'onglet Receiver de Betaflight règle depuis toujours — un modèle qui bouge.
//
// Le DESSIN est celui des portraits d'archive (src/drone-wire-svg.js), la POSE
// vient d'un module pur (src/calibration-preview.js). Ici il ne reste que trois
// choses : les degrés, l'horloge, et la détection d'un canal qui vient d'être
// attribué — celui qui rejoue son geste tout seul.
import { wireSvg, wireLoop } from './drone-wire-svg.js';
import { shapeOf } from './drone-shape.js';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { calibrationPose, completedChannels, REPLAY_MS } from './calibration-preview.js';

// L'exemplaire de banc. Fixe et nommé : le panneau des réglages s'ouvre depuis
// le terminal, avant boot(), et n'a donc aucune session sous la main. Une
// machine tirée au hasard changerait de dessin d'une ouverture à l'autre sans
// que rien ne l'explique.
export const BENCH = { family: 'freestyle5', buildSeed: 'calibration' };

// Le point de vue ne bouge pas — c'est la MACHINE qui bouge, sinon on ne sait
// plus ce qui vient du manche.
//
// 45° et non les 22° de la fiche d'atelier (src/drone-portrait.js), et c'est
// MESURÉ, pas choisi : sous un point de vue bas, un roulis amène le plan des
// hélices dans l'axe du regard et la machine s'écrase en une tranche illisible
// — dès 20° de roulis à 22° de vue. Rendu et regardé sur une grille point de
// vue × roulis. Vu de plus haut, les disques restent ouverts et l'inclinaison
// se lit jusqu'à 40°.
//
// Une fiche d'atelier peut se permettre un point de vue bas : elle est
// immobile. Celle-ci doit rester lisible EN MOUVEMENT.
const VIEW = { yawDeg: 30, pitchDeg: 45 };

// Assez pour se lire d'un coup d'oeil, pas assez pour que le fil de fer se
// replie sur lui-même. Le lacet reste nettement sous 90° : un quad est
// symétrique d'ordre 4, et au-delà on ne sait plus de quel côté il tourne.
const ROLL_DEG = 30;
const PITCH_DEG = 30;
const YAW_DEG = 40;
// Montée dans le cadre, en unités du viewBox (qui va de -1.1 à 1.1).
const LIFT = 0.3;

// 200 px et non 120 : rendu dans le vrai panneau et regardé, un fil de fer de
// six cents traits à 120 px n'est plus une machine, c'est une tache.
export function calibrationDrone({ size = 200, sample } = {}) {
	const build = targetBuild({ seed: BENCH.buildSeed, family: BENCH.family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: BENCH.buildSeed, family: BENCH.family }),
		detail: 'portrait',
	});

	const view = wireSvg({ shape, size, className: 'cal-drone', label: 'calibration preview', strokeWidth: 0.013 });

	const paint = (pose) => view.draw({
		...VIEW,
		roll: pose.roll * ROLL_DEG,
		pitch: pose.pitch * PITCH_DEG,
		yaw: pose.yaw * YAW_DEG,
	}, { lift: pose.throttle * LIFT });

	// Ce qui était déjà mesuré à la frame précédente. Un canal qui APPARAÎT
	// vient d'être attribué : il rejoue son geste.
	//
	// `null` tant qu'on n'a rien observé, et pas `[]` : sur un périphérique déjà
	// calibré, le tout premier échantillon arrive avec les quatre canaux
	// mesurés. Les traiter comme des nouveautés ferait rejouer quatre gestes à
	// l'ouverture du panneau, et couvrirait le manche du pilote pendant tout ce
	// temps. On ne rejoue que ce qu'on a vu APPARAÎTRE.
	let seen = null;
	let replayChannel = null;
	let replayStart = 0;

	paint(calibrationPose());

	const stop = wireLoop((ms) => {
		const s = typeof sample === 'function' ? sample() : null;
		const state = s?.state ?? null;
		const signals = s?.signals ?? [];

		const done = completedChannels(state);
		if (seen !== null) {
			const fresh = done.find((ch) => !seen.includes(ch));
			if (fresh) { replayChannel = fresh; replayStart = ms; }
		}
		// Une liste qui RÉTRÉCIT, c'est un calibrage relancé : on repart de la
		// nouvelle plutôt que de rejouer tout ce qui va réapparaître.
		seen = done;

		let replay = null;
		if (replayChannel) {
			const elapsedMs = ms - replayStart;
			if (elapsedMs >= REPLAY_MS) replayChannel = null;
			else replay = { channel: replayChannel, elapsedMs };
		}

		paint(calibrationPose({ state, signals, replay }));
	});

	return { el: view.el, stop };
}
