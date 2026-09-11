// Le modèle PUR des voix ambiantes (issue #250) : ce que vaut le gain, la
// coupure, la fréquence et le pan d'une source qui BOUGE par rapport à
// l'auditeur — ce que #122 n'avait pas à faire (les moteurs du joueur sont
// solidaires de sa tête). Aucune Web Audio ici.
//
// Niveaux relatifs CHOISIS, pas mesurés, comme le reste du son
// (docs/handoff-archive/sound.md §« aucun agent n'écoute »).

// idleLevel du joueur = 0,12 (src/audio.js). Quatre voix à d0 doivent rester
// 12 dB dessous : 4·g0/(1 + d0/d0) = 2·g0 ≤ 0,12·10^(−12/20) = 0,0301.
export const VOICE = {
	d0: 8, dMax: 250, fadeM: 50,
	g0: 0.015,
	cutNear: 2600, cutFar: 800, behindCut: 0.6,
	c: 343, vrMax: 40,
	omegaCruise: 0.55, accelMod: 0.15, accelRef: 20,
	detuneCents: 9,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function gainFor(d) {
	if (d >= VOICE.dMax) return 0;
	const fade = clamp01((VOICE.dMax - d) / VOICE.fadeM);
	return VOICE.g0 / (1 + d / VOICE.d0) * fade;
}

// Log-interpolation de la coupure entre 0 et dMax ; l'ombre de la tête
// multiplie par behindCut au maximum (behind ∈ 0..1).
export function cutoffFor(d, behind) {
	const u = clamp01(d / VOICE.dMax);
	const f = Math.exp(Math.log(VOICE.cutNear) * (1 - u) + Math.log(VOICE.cutFar) * u);
	return f * (1 - (1 - VOICE.behindCut) * clamp01(behind));
}

// vRadial > 0 : la source s'éloigne.
export function dopplerFor(f, vRadial) {
	const vr = Math.max(-VOICE.vrMax, Math.min(VOICE.vrMax, vRadial));
	return f * VOICE.c / (VOICE.c + vr);
}

export function bladeFreq(profile, accelMag) {
	const mod = 1 + VOICE.accelMod * clamp01(accelMag / VOICE.accelRef);
	const omega = VOICE.omegaCruise * profile.maxOmega * mod;
	return omega * profile.bladeCount / (2 * Math.PI);
}

// Pan équi-puissance sur l'azimut dans le repère caméra (rx,rz = droite ;
// fx,fz = avant, horizontaux). Au zénith (rel nul) : centre, devant.
// `out`, si fourni, est muté et rendu — l'appelant par frame (AmbientDrones)
// y passe son scratch pour n'allouer aucun objet ; sans `out`, alloue un
// littéral (chemin des tests).
export function azimuthPan(relX, relZ, cam, out) {
	const o = out || { pan: 0, behind: 0 };
	const n = Math.hypot(relX, relZ);
	if (n < 1e-6) { o.pan = 0; o.behind = 0; return o; }
	const r = (relX * cam.rx + relZ * cam.rz) / n;
	const f = (relX * cam.fx + relZ * cam.fz) / n;
	o.pan = Math.max(-1, Math.min(1, r));
	o.behind = clamp01(-f);
	return o;
}

export function voiceParams({ d, behind, pan, vRadial, accelMag, profile, detune }, out) {
	out.gain = gainFor(d);
	out.cutoff = cutoffFor(d, behind);
	out.freq = dopplerFor(bladeFreq(profile, accelMag), vRadial) * Math.pow(2, detune / 1200);
	out.pan = pan;
	return out;
}
