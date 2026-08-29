// Helpers purs du rituel CONTROL VECTOR (PHASE 10, Bible §14/18). Logique pure,
// AUCUNE dépendance DOM — importée par le selftest et, via un bundle Vite, par
// src/ritual.js. Le rendu (saisie, culmination) vit dans src/ritual.js.

// Durées de mise en scène : le Vector reste toujours le même, seule la
// variante (nombre de battements / rythme de la culmination) change d'un hack
// à l'autre. Bible §18/§36 : V1≈1s … V4≈4s.
export const RITUAL_VARIANTS = [
	{ id: 'V1', ms: 1000, beats: 1 },
	{ id: 'V2', ms: 2000, beats: 2 },
	{ id: 'V3', ms: 3000, beats: 3 },
	{ id: 'V4', ms: 4000, beats: 4 },
];

// Vecteur de secours pour les chemins dev sans opérateur (?scene= seul) : ne
// touche jamais l'opérateur réel, sert uniquement à jouer le rituel hors
// contexte. Bible §14 : 4-8 inputs, défaut 6 — cette valeur respecte le format.
export const FALLBACK_VECTOR = ['up', 'right', 'down', 'left', 'up', 'left'];

// Hash FNV-1a d'une chaîne -> graine 32 bits, puis xorshift (même génération
// que tools/target-model.mjs, src/link.js : petit, déterministe, rejouable).
function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

// Même seed -> même variante (rejeu stable via ?hack=&scene=). Un seed absent
// tire quand même une variante (pas déterministe) plutôt que d'échouer :
// la mise en scène n'a pas besoin d'un seed pour être valide.
export function pickVariant(seed) {
	const rand = seed != null ? rngFrom(`${seed}::ritual`) : Math.random;
	return RITUAL_VARIANTS[Math.floor(rand() * RITUAL_VARIANTS.length)];
}

// Vecteur à utiliser pour CE hack : celui de l'opérateur s'il est renseigné,
// sinon le vecteur de secours. Ne modifie jamais son argument.
export function ritualVector(operatorVector) {
	return Array.isArray(operatorVector) && operatorVector.length > 0
		? operatorVector
		: FALLBACK_VECTOR;
}

// Compare l'input reçu au prochain élément attendu de `vector`, sachant
// `typedSoFar` (déjà validés). Préfixe strict : un mauvais input à n'importe
// quel index est un `mismatch` — c'est à l'appelant de vider son tampon et de
// repartir de zéro (pas de pénalité, pas de compteur : Bible + issue #47,
// « ce n'est pas un game over »).
export function checkInput(vector, typedSoFar, input) {
	const idx = typedSoFar.length;
	if (idx >= vector.length || vector[idx] !== input) return { status: 'mismatch' };
	return { status: idx + 1 === vector.length ? 'complete' : 'advance' };
}
