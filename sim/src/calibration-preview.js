// La POSE de la machine pendant le calibrage (issue #281).
//
// Le calibrage mesurait juste et ne montrait rien : le pilote poussait un
// manche et ne voyait qu'une barre horizontale. Rien ne disait ce que ce manche
// allait FAIRE au drone. C'est ce que l'onglet Receiver de Betaflight résout
// depuis toujours, et c'est tout ce que ce module calcule.
//
// Module PUR — aucun DOM, aucune horloge, aucun angle. Il rend des grandeurs
// normalisées, et la vue (src/calibration-drone.js) décide des degrés : ce qui
// se voit se vérifie donc en Node, comme la mesure elle-même.
//
//   roll, pitch, yaw  : -1..1
//   throttle          :  0..1
import { CAL_CHANNELS, strongestSignal, normalizeChannel, throttleFromCalibrated } from './calibration.js';

// Durée du geste rejoué quand un canal vient d'être attribué. Assez long pour
// se lire, assez court pour ne pas retarder la consigne suivante.
export const REPLAY_MS = 900;

const REST = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// La pose d'UN canal poussé de `at`. Le gaz n'est pas une rotation : c'est le
// seul des quatre qui ne s'exprime pas en inclinaison, et il monte quel que
// soit le SENS du signal — à ce stade le sens n'est pas encore mesuré, et une
// machine qui descend accuserait le pilote d'avoir poussé à l'envers.
function poseFor(channel, at) {
	if (channel === 'throttle') return { ...REST, throttle: clamp(Math.abs(at), 0, 1) };
	if (!channel) return { ...REST };
	return { ...REST, [channel]: clamp(at, -1, 1) };
}

// Le geste qu'un canal rejoue tout seul une fois attribué : zéro, butée, zéro.
// Une demi-sinusoïde plutôt qu'un aller-retour linéaire — elle part et revient
// sans à-coup, et elle vaut EXACTEMENT zéro à la fin, donc la machine ne reste
// pas de travers après la confirmation.
export function replayPose(channel, elapsedMs) {
	const u = clamp(elapsedMs / REPLAY_MS, 0, 1);
	return poseFor(channel, Math.sin(Math.PI * u));
}

export function calibrationPose({ state, signals = [], replay = null } = {}) {
	// Le pilote tient encore son manche quand la confirmation démarre : c'est le
	// geste REJOUÉ qu'il doit voir, pas le sien.
	if (replay) return replayPose(replay.channel, replay.elapsedMs);
	if (!state) return { ...REST };

	switch (state.phase) {
		// « HANDS OFF » : une machine qui s'agite dirait au pilote le contraire
		// de la consigne affichée.
		case 'rest':
			return { ...REST };

		case 'channel':
			return poseFor(state.channel, strongestSignal(state, signals).at);

		// Le plafond du gaz est mesuré, le plancher pas encore : la formule est
		// la même que celle du vol, et elle se borne d'elle-même.
		case 'throttle-release':
		case 'throttle-min': {
			const c = state.channels.throttle;
			return { ...REST, throttle: throttleFromCalibrated(signals[c.axis] ?? 0, c) };
		}

		// Le banc d'essai, gratuit : la mesure est finie, la machine suit les
		// quatre manches tels qu'ils viennent d'être calibrés.
		case 'done': {
			const c = state.channels;
			const at = (name) => signals[c[name].axis] ?? 0;
			return {
				throttle: throttleFromCalibrated(at('throttle'), c.throttle),
				yaw: normalizeChannel(at('yaw'), c.yaw, state.deadband),
				pitch: normalizeChannel(at('pitch'), c.pitch, state.deadband),
				roll: normalizeChannel(at('roll'), c.roll, state.deadband),
			};
		}

		default:
			return { ...REST };
	}
}

// Les canaux dont la mesure est TERMINÉE — ceux qui ont le droit de rejouer
// leur geste. Le gaz demande la nuance : il entre dans `channels` dès que son
// plafond est mesuré, mais il reste en cours (« LET GO », puis parfois « FULL
// DOWN ») jusqu'à ce que son mode de course soit décidé. Le rejouer plus tôt
// ferait bouger la machine pendant qu'on demande au pilote de lâcher.
export function completedChannels(state) {
	if (!state?.channels) return [];
	return CAL_CHANNELS.filter((ch) => state.channels[ch] && (ch !== 'throttle' || state.throttleMode));
}
