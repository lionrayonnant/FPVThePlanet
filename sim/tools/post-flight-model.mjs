// Déduction du POST-FLIGHT ANALYSIS (PHASE 15, Bible §25). Logique pure,
// importée par le selftest et (via un bundle Vite) le client.
//
// Règle : l'analyse déduit du flightTelemetry OBSERVÉ pendant la session
// (PHASE 06), jamais de la vérité interne de la cible (session.target.family
// n'est volontairement pas un paramètre ici). C'est le principe des trois
// niveaux d'information (PHASE 08 : KNOWN / EST. / UNKNOWN) appliqué à
// l'envers du temps : ce qu'on a vu pendant le vol devient KNOWN/EST., le
// reste (caméra, contrôleur de vol, moteurs) reste UNKNOWN — jamais observé.
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { RATE_PRESETS } from '../src/flightController.js';

const GRAVITY = 9.81;

// En dessous de ce temps de vol armé, le signal est trop mince pour deviner
// quoi que ce soit — pas de PROFILE, pas de CONFIDENCE.
const MIN_SIGNAL_S = 3;

// En dessous de ce temps de vol armé, on peut encore deviner un PROFILE (le
// pic de rate/vitesse déjà atteint le dit), mais pas ESTIMATED : un vol de
// 20 s n'a pas assez exploré l'enveloppe de la cible pour en déduire sa masse
// (règle de l'issue #52). 30 s est un choix de jeu, pas une mesure physique —
// documenté ici plutôt qu'arbitraire dans le code.
const MIN_ESTIMATE_S = 30;

// Borne haute de normalisation pour le signal de vitesse (tie-break, voir
// plus bas) : généreuse au-dessus de toute enveloppe réelle des 6 familles,
// jamais présentée telle quelle au joueur.
const SPEED_CEILING_MS = 100;

// FOV typique par classe : valeur narrative documentée (« ce que vole
// généralement une machine de cette classe »), PAS une propriété simulée —
// le jeu ne modélise jamais la caméra réelle d'une cible (CAMERA MODEL reste
// UNKNOWN). Même esprit que le vocabulaire d'ambiance de hack-grammars.js :
// assumé décoratif, jamais présenté comme mesuré.
const TYPICAL_FOV_DEG = {
	freestyle5: 148,
	race5: 125,
	cinewhoop: 135,
	longrange: 105,
	heavy5: 140,
	toothpick: 155,
};

function thrustToWeight(p) {
	return (p.maxThrustPerMotor * 4) / (p.mass * GRAVITY);
}

// { maxSpeedMs, maxRateDps, durationS } → { profile, estimated }
//   profile   : { family, label, confidencePct } | null (UNKNOWN)
//   estimated : { massG, fovDeg, responseMs } | null (UNKNOWN)
export function analyzeFlight({ maxSpeedMs = 0, maxRateDps = 0, durationS = 0 } = {}) {
	if (!(durationS >= MIN_SIGNAL_S)) return { profile: null, estimated: null };

	const twOf = FAMILIES.map((family) => ({ family, tw: thrustToWeight(PROFILES[family]) }));
	const twMin = Math.min(...twOf.map((t) => t.tw));
	const twMax = Math.max(...twOf.map((t) => t.tw));
	const normSpeed = Math.max(0, Math.min(1, maxSpeedMs / SPEED_CEILING_MS));

	const candidates = FAMILIES
		.map((family) => {
			const p = PROFILES[family];
			const rateCap = RATE_PRESETS[p.rates].roll.max;
			return { family, p, rateCap, tw: thrustToWeight(p) };
		})
		// Un contrôleur borné par ses rates ne peut pas dépasser le plafond de son
		// propre preset : toute famille dont le plafond est sous le pic observé est
		// physiquement exclue, pas juste improbable. Petite marge pour l'arrondi
		// de télémétrie (round() côté session.js).
		.filter((c) => maxRateDps <= c.rateCap * 1.02);

	if (candidates.length === 0) return { profile: null, estimated: null };

	const scored = candidates.map((c) => {
		// Ajustement de plafond serré : le plus petit plafond qui explique encore
		// le pic observé est le signal le plus fort — chaque famille explore toute
		// sa plage de rates au cours d'un vol normal.
		const rateFit = maxRateDps / c.rateCap;
		const normTw = twMax === twMin ? 0.5 : (c.tw - twMin) / (twMax - twMin);
		const speedFit = 1 - Math.abs(normSpeed - normTw);
		return { ...c, score: rateFit * 0.6 + speedFit * 0.4 };
	}).sort((a, b) => b.score - a.score);

	const winner = scored[0];
	const total = scored.reduce((sum, c) => sum + c.score, 0);
	const confidencePct = Math.round((winner.score / total) * 100);
	const profile = { family: winner.family, label: winner.p.label, confidencePct };

	if (!(durationS >= MIN_ESTIMATE_S)) return { profile, estimated: null };

	const estimated = {
		// La masse est réelle (drone-profiles.js), lue sur la famille devinée —
		// une déduction, pas une mesure directe : la session n'a jamais pesé la cible.
		massG: Math.round((winner.p.mass * 1000) / 10) * 10,
		fovDeg: TYPICAL_FOV_DEG[winner.family],
		// tauSpinUp (drone-profiles.js) est le temps de montée moteur réel de la
		// famille : la latence de réponse perçue en vol en découle directement.
		responseMs: Math.round(winner.p.tauSpinUp * 1000),
	};
	return { profile, estimated };
}

export const POST_FLIGHT_THRESHOLDS = { MIN_SIGNAL_S, MIN_ESTIMATE_S };
