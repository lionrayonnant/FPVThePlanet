// Le contexte audio et le limiteur, partagés par la synthèse moteur
// (src/audio.js) et le langage sonore d'interface (src/ui-audio.js).
//
// Pourquoi un seul contexte plutôt qu'un par module : le critère d'acceptation
// de PHASE 18 est « le mixage est équilibré à l'oreille, rituel compris »
// (issue #11). Deux contextes séparés s'additionneraient à l'aveugle dans la
// carte son, sans limiteur commun ni référence de niveau — et « le mixage » ne
// désignerait plus rien de mesurable.
//
//   moteurs/vent/propwash/impacts → master(mute) → air(6k) ─┐
//                                                            ├→ limiteur → volume → destination
//   SYSTEM / LINK / RITUAL ──────→ uiMaster(trim) ───────────┘
//
// Trois conséquences, toutes voulues :
//   - l'UI ne traverse pas `air` : ce lowpass est l'excuse « on entend le drone
//     à travers une paire de lunettes », et un click d'interface doit claquer ;
//   - l'UI n'est pas coupée par audio.setMuted(frozen), qui est vrai pendant
//     TOUT l'écran de hack — un rituel muet exactement quand il doit frapper
//     serait le bug le plus bête de la phase ;
//   - le rituel est limité avec le reste : un vrai mixage, pas deux sorties qui
//     se marchent dessus.

// Reprises telles quelles de src/audio.js, où elles étaient mesurées : le point
// le plus fort du sim (plein gaz + rush + impact) laisse ~1,6 dB de marge, et
// des oscillateurs désaccordés finissent par se mettre en phase et la manger.
const LIMIT = { threshold: -3, ratio: 20, attack: 0.003, release: 0.1 };

// Trim de la chaîne d'interface. À équilibrer à l'oreille (issue #11) : les
// sons d'UI sont rares et doivent porter sans écraser les moteurs.
const UI_TRIM = 0.5;

const TAU = 0.08; // lissage du volume, comme AUDIO.tauMaster

let ctx = null;
let engine = null;
let ui = null;
let volume = null;
let factory = null;

// Injection pour les tests (tools/audio-bus-selftest.mjs). En production la
// fabrique par défaut est le constructeur du navigateur.
export function _setContextFactory(fn) { factory = fn; }

export function _reset() {
	ctx = engine = ui = volume = null;
	factory = null;
}

function defaultFactory() {
	const Ctx = typeof window !== 'undefined'
		? (window.AudioContext ?? window.webkitAudioContext)
		: null;
	return Ctx ? new Ctx() : null;
}

// Doit être appelé depuis un geste utilisateur : les navigateurs refusent de
// démarrer un AudioContext autrement. Idempotent, et reprend un contexte que
// le navigateur a suspendu dans notre dos (changement d'onglet, autoplay).
export function ensureContext() {
	if (ctx) {
		resumeQuietly();
		return ctx;
	}
	ctx = (factory ?? defaultFactory)();
	if (!ctx) return null;              // pas de Web Audio : on reste muet, on ne jette pas

	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = LIMIT.threshold;
	limiter.knee.value = 0;
	limiter.ratio.value = LIMIT.ratio;
	limiter.attack.value = LIMIT.attack;
	limiter.release.value = LIMIT.release;

	volume = ctx.createGain();
	volume.gain.value = 1;

	engine = ctx.createGain();
	engine.gain.value = 1;
	ui = ctx.createGain();
	ui.gain.value = UI_TRIM;

	engine.connect(limiter);
	ui.connect(limiter);
	limiter.connect(volume).connect(ctx.destination);

	resumeQuietly();
	return ctx;
}

// resume() rend une promesse, et le navigateur la REJETTE quand on la demande
// hors d'un geste utilisateur — ce qui arrive à chaque chargement, puisque
// armBoot() tente sa chance avant le premier clic. Sans ce catch, chaque
// démarrage laisse une « unhandled rejection » dans la console : du bruit qui
// masquerait une vraie erreur le jour où il y en aura une.
function resumeQuietly() {
	if (!ctx || ctx.state !== 'suspended') return;
	try { ctx.resume()?.catch?.(() => {}); } catch { /* rien à faire, on reste muet */ }
}

export function context() { return ctx; }
export function engineIn() { return engine; }
export function uiIn() { return ui; }

export function setVolume(v) {
	if (!volume || !ctx) return;
	const target = v < 0 ? 0 : v > 1 ? 1 : v;
	volume.gain.setTargetAtTime(target, ctx.currentTime, TAU);
	volume.gain.value = target;   // le faux contexte n'interpole pas ; le vrai ignore
}
