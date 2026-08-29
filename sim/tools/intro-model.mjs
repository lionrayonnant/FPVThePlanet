// Timeline pure de l'intro demoscene au lancement (issue #106). AUCUNE Web
// Audio, AUCUN DOM, AUCUN `node:` — importé tel quel par intro-selftest.mjs et,
// via un bundle Vite, par src/intro.js, qui ne fait qu'y lire les instants et
// les noms de phase. Le montage/démontage DOM, le rAF, les écouteurs de skip
// vivent là-bas ; ici, seulement des nombres.
//
// L'écran d'attente PRESS ANY KEY est HORS timeline : il n'a pas de durée, il
// attend un geste (c'est aussi le geste qui débloque l'AudioContext).

// Trois mouvements, dans l'ordre : le logo se révèle, le cracktro tourne
// (plasma/raster + scrolltext), puis la partition se résout sur la signature
// de boot existante (BOOT_SIGNATURE, ui-audio-model.mjs). Les durées sont
// fixées ICI et nulle part ailleurs : src/intro.js ne réinvente pas de
// minutage, il lit celui-ci.
export const INTRO_PHASES = [
	{ name: 'reveal', durMs: 1500 },      // logo ASCII qui se pose, sinus-scroll par colonne
	{ name: 'plasma', durMs: 4000 },      // raster bars/plasma + scrolltext horizontal
	{ name: 'resolution', durMs: 1500 },  // la partition rejoint BOOT_SIGNATURE
];

export const INTRO_TOTAL_MS = INTRO_PHASES.reduce((sum, p) => sum + p.durMs, 0); // 7000

// Instant où commence la résolution : reveal + plasma. C'est aussi l'instant
// où, dans un déroulement NON skippé, ui-audio.js déclenche BOOT_SIGNATURE
// (playIntro() la programme à INTRO_SCORE_MS après le départ). Les deux
// fichiers restent indépendants — aucun import croisé entre un modèle de
// timeline visuelle et un modèle audio — mais doivent s'accorder :
// intro-selftest.mjs vérifie l'égalité contre ui-audio-model.mjs:INTRO_SCORE_MS.
export const RESOLUTION_AT_MS = INTRO_PHASES[0].durMs + INTRO_PHASES[1].durMs;

// Phase active à l'instant `tMs` d'un déroulement NORMAL (non skippé). Clampée
// aux bords : un instant négatif retombe sur la première phase, un instant
// au-delà de la fin reste sur la dernière (résolution) plutôt que de rendre
// undefined.
export function phaseAt(tMs) {
	let acc = 0;
	for (const phase of INTRO_PHASES) {
		acc += phase.durMs;
		if (tMs < acc) return phase.name;
	}
	return INTRO_PHASES[INTRO_PHASES.length - 1].name;
}

// Sémantique du skip : « skippable à tout instant » se lit littéralement ici —
// il n'y a qu'UNE destination de skip, quel que soit le moment du geste (en
// plein reveal, en pleine plasma, ou même pendant la résolution elle-même).
// Jamais de phase intermédiaire à rejouer en accéléré : on atterrit direct sur
// 'resolution', qui est le même point d'arrivée qu'un déroulement complet.
export function skipPhase() {
	return 'resolution';
}

// Durée du dénouement quand on saute, en ms : nettement plus courte que la
// résolution jouée en entier (1500 ms, pensés pour un déroulement normal) —
// un skip doit couper net et rendre la main tout de suite, pas rejouer la
// coda intégrale. src/intro.js s'en sert pour son propre délai avant de
// résoudre la Promise après un skip ; ui-audio.js, lui, coupe son gain sur sa
// propre constante (INTRO_SKIP_FADE_S), plus courte encore — un fondu audio et
// une transition visuelle n'ont pas à durer pareil.
export const SKIP_WRAP_MS = 250;
