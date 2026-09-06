// Selftest de src/calibration.js (issue #277) : la machine à états du calibrage
// guidé. Logique pure, aucun DOM, aucun localStorage — on lui donne des
// instantanés d'axes et un dt, elle rend l'état suivant.
//
// Les séquences rejouées ici sont celles de VRAI matériel :
//   - une radio EdgeTX : gimbal à friction, le manche des gaz TIENT sa position ;
//   - une DualShock 4 : stick auto-centré, ordre d'axes différent.
// C'est exactement la paire que padKind() n'arrive pas à départager quand la
// radio n'est pas dans la liste des marques.
// Lancer : node tools/calibration-selftest.mjs
import assert from 'node:assert/strict';
import {
	beginCalibration,
	feedSample,
	calibrationToMap,
	normalizeChannel,
	throttleFromCalibrated,
	calibrationResult,
	calProgress,
	calSummaryLines,
	CAL_PROMPTS,
	CAL_TIMING,
	padSignals,
} from '../src/calibration.js';
import { defaultMapForKind } from '../src/input.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Rejoue `ms` millisecondes d'un périphérique dont les axes sont donnés par
// `axesAt(elapsedMs)`. dt de 16 ms = une trame à 60 Hz, ce que fait le vrai
// appelant (settings.js, dans la boucle de rendu).
function feedFor(state, axesAt, ms, dt = 16) {
	for (let e = 0; e < ms; e += dt) state = feedSample(state, axesAt(e), dt);
	return state;
}

const still = (axes) => () => axes;

// Rejoue un scénario complet : une suite de [axes, durée]. C'est la forme la
// plus proche de ce que fait un pilote — il pose la manette, pousse un manche,
// le tient, le lâche.
function play(state, steps) {
	for (const [axes, ms] of steps) state = feedFor(state, still(axes), ms);
	return state;
}

// Une DualShock 4 en mapping « standard » : axe 0/1 = stick gauche X/Y,
// axe 2/3 = stick droit X/Y. Tous auto-centrés. L'axe Y vaut -1 VERS LE HAUT.
const DS4 = [
	[[0, 0, 0, 0], 1200],       // repos
	[[0, -1, 0, 0], 700],       // gaz à fond : stick gauche vers le haut
	[[0, 0, 0, 0], 900],        // lâché — il revient au centre
	[[1, 0, 0, 0], 700],        // lacet à droite : stick gauche vers la droite
	[[0, 0, 0, 0], 400],
	[[0, 0, 0, 1], 700],        // cabrer : stick droit tiré vers soi (Y positif)
	[[0, 0, 0, 0], 400],
	[[0, 0, 1, 0], 700],        // roulis à droite : stick droit vers la droite
];

// Une radio EdgeTX : axe 0 = roulis, 1 = tangage, 2 = gaz, 3 = lacet. Le manche
// des gaz est à FRICTION — il tient sa position, et le pilote l'a laissé en bas.
const EDGETX = [
	[[0, 0, -1, 0], 1200],      // repos, gaz parqué en bas
	[[0, 0, 1, 0], 700],        // gaz à fond
	[[0, 0, 1, 0], 900],        // lâché : il RESTE en haut
	[[0, 0, -1, 0], 700],       // gaz au minimum
	[[0, 0, -1, 1], 700],       // lacet à droite
	[[0, 0, -1, 0], 400],
	[[0, -1, -1, 0], 700],      // cabrer : manche tiré vers soi = axe négatif
	[[0, 0, -1, 0], 400],
	[[1, 0, -1, 0], 700],       // roulis à droite
];

// --- départ ------------------------------------------------------------------

t('beginCalibration : commence par mesurer le REPOS, pas par demander un geste', () => {
	const s = beginCalibration(4);
	assert.equal(s.phase, 'rest');
	assert.equal(s.channel, null);
	assert.ok(s.prompt.length > 0, 'une consigne doit être affichable dès la première trame');
	assert.equal(s.done, false);
});

// --- phase de repos ----------------------------------------------------------

t('repos : le centre mesuré est là où le manche est POSÉ, pas à zéro', () => {
	// Gimbal à friction laissé à mi-course : le "centre" de cet axe est 0.42.
	// Le supposer à 0 est exactement ce qui fait décoller un drone tout seul.
	let s = beginCalibration(4);
	s = feedFor(s, still([0, 0, 0.42, 0]), 1500);
	assert.notEqual(s.phase, 'rest', 'la phase de repos doit se terminer d\'elle-même');
	assert.equal(s.centers.length, 4);
	assert.ok(Math.abs(s.centers[2] - 0.42) < 0.01, `centre mesuré ${s.centers[2]}`);
});

t('repos : le deadband vient du BRUIT mesuré, il n\'est pas constant', () => {
	// Un axe qui tremble de ±0.03 au repos doit produire un deadband plus large
	// qu'un axe parfaitement stable — sinon le drone dérive au neutre.
	let calme = beginCalibration(4);
	calme = feedFor(calme, still([0, 0, 0, 0]), 1500);

	let bruyant = beginCalibration(4);
	bruyant = feedFor(bruyant, (e) => [0.03 * Math.sin(e), 0, 0, 0], 1500);

	assert.ok(bruyant.deadband > calme.deadband,
		`bruyant ${bruyant.deadband} devrait dépasser calme ${calme.deadband}`);
	assert.ok(bruyant.deadband >= 0.03, 'le deadband doit au moins couvrir le bruit vu');
});

t('repos : un manche qu\'on bouge pendant la mesure relance la mesure', () => {
	// Sans ce garde-fou, le "centre" est capturé au milieu d'un geste et TOUT
	// le reste du calibrage est décalé.
	let s = beginCalibration(4);
	s = feedFor(s, (e) => [e < 500 ? 0 : (e - 500) / 1000, 0, 0, 0], 1500);
	assert.equal(s.phase, 'rest', 'on ne quitte pas le repos sur un manche qui bouge');
	assert.ok(s.message, 'et on dit pourquoi ça recommence');
});

// --- attribution d'axe -------------------------------------------------------

t('un geste attribue l\'axe QUI A BOUGÉ, et son sens', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 2));
	assert.equal(s.channels.throttle.axis, 1);
	// L'axe atteint -1 quand on demande « à fond » : la course est à l'envers.
	assert.ok(s.channels.throttle.hi < s.channels.throttle.lo);
});

t('deux axes qui bougent ensemble : on REDEMANDE au lieu d\'attribuer au hasard', () => {
	// Le cas qui rend un calibrage silencieusement faux : le pilote pousse en
	// diagonale. Aujourd'hui personne ne mesure rien, donc personne ne le voit.
	let s = beginCalibration(4);
	s = play(s, [[[0, 0, 0, 0], 1200], [[0, -0.9, -0.8, 0], 900]]);
	assert.equal(s.channel, 'throttle', 'on reste sur la même consigne');
	assert.ok(!s.channels?.throttle, 'et rien n\'est attribué');
	assert.ok(s.message, 'et on dit pourquoi');
});

t('un axe déjà attribué ne peut pas servir deux fois', () => {
	let s = beginCalibration(4);
	// Gaz sur l'axe 1, puis on repousse l'axe 1 pour le lacet.
	s = play(s, [...DS4.slice(0, 3), [[0, -1, 0, 0], 900]]);
	assert.equal(s.channel, 'yaw', 'on reste sur le lacet');
	assert.ok(!s.channels.yaw, 'rien n\'est attribué');
	assert.match(s.message, /throttle/i, 'le message nomme le canal qui tient déjà cet axe');
});

// --- mode de course du gaz : MESURÉ, plus déduit d'une marque ----------------

t('gaz auto-centré (DS4) -> demi-course, et le plancher est le neutre', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 3));
	assert.equal(s.throttleMode, 'half');
	assert.ok(Math.abs(s.channels.throttle.lo - 0) < 0.01, `lo=${s.channels.throttle.lo}`);
	assert.ok(Math.abs(s.channels.throttle.hi + 1) < 0.01, `hi=${s.channels.throttle.hi}`);
});

t('gaz à friction (radio) -> pleine course, et on va CHERCHER la butée basse', () => {
	let s = beginCalibration(4);
	// Après le lâcher, le manche est resté en haut : ce n'est pas un stick
	// auto-centré, donc le plancher n'est pas le neutre — il faut le mesurer.
	s = play(s, EDGETX.slice(0, 3));
	assert.equal(s.throttleMode, 'full');
	assert.equal(s.channel, 'throttle', 'on ne passe pas au canal suivant sans la butée basse');
	assert.match(s.prompt, /down/i);

	s = play(s, EDGETX.slice(3, 4));
	assert.ok(Math.abs(s.channels.throttle.lo + 1) < 0.01, `lo=${s.channels.throttle.lo}`);
	assert.ok(Math.abs(s.channels.throttle.hi - 1) < 0.01, `hi=${s.channels.throttle.hi}`);
});

// --- parcours complets -------------------------------------------------------

t('DS4 de bout en bout : le calibrage RETROUVE le profil écrit à la main', () => {
	// defaultMapForKind('generic') est le profil manette de input.js, écrit à la
	// main. Si la mesure le reproduit, c'est que la mesure est juste — et c'est
	// elle qui marchera aussi sur le matériel absent de la liste des marques.
	let s = beginCalibration(4);
	s = play(s, DS4);
	assert.equal(s.phase, 'done');
	assert.equal(s.done, true);
	assert.deepEqual(calibrationToMap(s), defaultMapForKind('generic'));
	assert.equal(s.throttleMode, 'half');
});

t('radio EdgeTX de bout en bout : idem, avec le gaz en pleine course', () => {
	let s = beginCalibration(4);
	s = play(s, EDGETX);
	assert.equal(s.phase, 'done');
	assert.deepEqual(calibrationToMap(s), defaultMapForKind('radio'));
	assert.equal(s.throttleMode, 'full');
});

// --- lecture des axes calibrés ----------------------------------------------
//
// C'est ici que le calibrage change quelque chose au vol : sans ces deux
// fonctions, il ne serait qu'un joli écran qui écrit un {axis, invert} de plus.

t('normalizeChannel : le neutre mesuré rend 0, la butée mesurée rend 1', () => {
	const cal = { axis: 2, center: 0.42, span: 0.58, invert: false };
	assert.equal(normalizeChannel(0.42, cal, 0), 0);
	assert.ok(Math.abs(normalizeChannel(1, cal, 0) - 1) < 1e-9);
});

t('normalizeChannel : un stick à course réduite atteint quand même 100 %', () => {
	// Une radio dont les endpoints ne sont pas réglés ne sort que ±0.8. Avec la
	// supposition « la course vaut ±1 », le pilote n'a jamais son plein débattement.
	const cal = { axis: 0, center: 0, span: 0.8, invert: false };
	assert.ok(Math.abs(normalizeChannel(0.8, cal, 0) - 1) < 1e-9);
	assert.ok(Math.abs(normalizeChannel(-0.8, cal, 0) + 1) < 1e-9);
});

t('normalizeChannel : borné à ±1 au-delà de la butée mesurée', () => {
	const cal = { axis: 0, center: 0, span: 0.8, invert: false };
	assert.equal(normalizeChannel(1, cal, 0), 1);
	assert.equal(normalizeChannel(-1, cal, 0), -1);
});

t('normalizeChannel : un axe inversé rend +1 pour le geste demandé', () => {
	// DS4, axe Y : « vers le haut » vaut -1. Le geste positif doit rendre +1.
	const cal = { axis: 1, center: 0, span: 1, invert: true };
	assert.ok(Math.abs(normalizeChannel(-1, cal, 0) - 1) < 1e-9);
});

t('normalizeChannel : le deadband mesuré tue la dérive du neutre, sans marche', () => {
	const cal = { axis: 0, center: 0, span: 1, invert: false };
	assert.equal(normalizeChannel(0.04, cal, 0.05), 0, 'dans le bruit -> exactement 0');
	// Et juste au-dessus du seuil la sortie repart de 0 : un deadband qui
	// retranche sans remettre à l'échelle fait sauter la commande.
	assert.ok(normalizeChannel(0.051, cal, 0.05) < 0.01);
	assert.ok(Math.abs(normalizeChannel(1, cal, 0.05) - 1) < 1e-9, 'la butée reste à 1');
});

t('throttleFromCalibrated : 0 au plancher mesuré, 1 au plafond mesuré', () => {
	const full = { axis: 2, lo: -1, hi: 1 };
	assert.equal(throttleFromCalibrated(-1, full), 0);
	assert.equal(throttleFromCalibrated(1, full), 1);
	assert.ok(Math.abs(throttleFromCalibrated(0, full) - 0.5) < 1e-9);
});

t('throttleFromCalibrated : un gaz auto-centré est à 0 quand on lâche', () => {
	// Le cas qui compte : manche lâché = 0 % de gaz, donc le geste de
	// désarmement (throttle < 0,08) reste joignable au repos.
	const half = { axis: 1, lo: 0, hi: -1 };
	assert.equal(throttleFromCalibrated(0, half), 0);
	assert.equal(throttleFromCalibrated(-1, half), 1);
	assert.equal(throttleFromCalibrated(0.6, half), 0, 'et pousser du mauvais côté ne donne pas de gaz');
});

t('throttleFromCalibrated : un neutre décalé ne laisse pas de gaz au repos', () => {
	// Gimbal à friction laissé à -0.9 : sans plancher mesuré, (v+1)/2 rendrait
	// 5 % de gaz permanents.
	const full = { axis: 2, lo: -0.9, hi: 0.95 };
	assert.equal(throttleFromCalibrated(-0.9, full), 0);
	assert.equal(throttleFromCalibrated(-1, full), 0, 'et sous le plancher on reste à 0');
});

t('bout en bout : la DS4 calibrée est à zéro sur les quatre canaux au repos', () => {
	let s = beginCalibration(4);
	s = play(s, DS4);
	const axes = [0, 0, 0, 0];
	assert.equal(throttleFromCalibrated(axes[s.channels.throttle.axis], s.channels.throttle), 0);
	for (const ch of ['yaw', 'pitch', 'roll']) {
		const c = s.channels[ch];
		assert.equal(normalizeChannel(axes[c.axis], c, s.deadband), 0, ch);
	}
});

// --- ce qu'on persiste, et ce qu'on montre ----------------------------------

t('calibrationResult : ne garde QUE la mesure, pas les accumulateurs', () => {
	let s = beginCalibration(4);
	s = play(s, DS4);
	const out = calibrationResult(s);
	// axisCount depuis #279 : la frontière axes/boutons, sans laquelle le
	// récapitulatif relu plus tard ne peut plus nommer « btn 6 ».
	assert.deepEqual(Object.keys(out).sort(), ['axisCount', 'channels', 'deadband', 'throttleMode']);
	assert.deepEqual(out.channels, s.channels);
	// Ce qui part dans localStorage doit survivre à un aller-retour JSON.
	assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

t('calibrationResult : rien à persister tant que ce n\'est pas fini', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 2));
	assert.equal(calibrationResult(s), null);
});

t('calProgress : le pilote voit où il en est, et la fin est la fin', () => {
	let s = beginCalibration(4);
	assert.deepEqual(calProgress(s), { step: 1, total: 6 });
	s = play(s, DS4.slice(0, 2));
	assert.deepEqual(calProgress(s), { step: 3, total: 6 }, 'le lâcher du gaz est une étape à part');
	s = play(s, DS4);
	assert.deepEqual(calProgress(s), { step: 6, total: 6 });
});

t('calSummaryLines : le récapitulatif dit ce qui a été MESURÉ, pas « ok »', () => {
	// Un calibrage qui se contente d'annoncer sa réussite est invérifiable. Ces
	// lignes sont ce qu'on relit quand « ça ne marche toujours pas » — même
	// rôle que padListEntries() pour la liste des périphériques (#162).
	let s = beginCalibration(4);
	s = play(s, EDGETX);
	const lines = calSummaryLines(calibrationResult(s));

	assert.equal(lines.length, 5, 'quatre canaux + le deadband');
	assert.match(lines[0], /throttle/);
	assert.match(lines[0], /axis 2/);
	assert.match(lines[0], /full travel/, 'le mode de course mesuré doit être lisible');
	assert.match(lines[2], /pitch/);
	assert.match(lines[2], /axis 1/);
	assert.match(lines[2], /inverted/, 'le sens retenu aussi');
	assert.match(lines[4], /deadband/);
});

t('calSummaryLines : une course réduite se VOIT dans le récapitulatif', () => {
	// Une radio qui ne sort que ±0.8 est un vrai problème de matériel. Le
	// calibrage la rattrape, mais il doit aussi la DIRE.
	const cal = {
		channels: {
			throttle: { axis: 2, lo: -1, hi: 1 },
			yaw: { axis: 3, center: 0, span: 0.8, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: true },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
		deadband: 0.02,
		throttleMode: 'full',
	};
	assert.match(calSummaryLines(cal)[1], /0\.80/);
});

t('les consignes tiennent sur une ligne du panneau', () => {
	// Elles s'affichent en 22 px dans un panneau étroit : au-delà d'une
	// vingtaine de caractères, la consigne se coupe au milieu d'une phrase et se
	// lit deux fois. Ce qui a besoin d'être expliqué va dans CAL_HINTS.
	for (const [key, text] of Object.entries(CAL_PROMPTS)) {
		assert.ok(text.length <= 22, `${key} : « ${text} » fait ${text.length} caractères`);
		assert.equal(text, text.toUpperCase(), `${key} : les consignes sont en capitales`);
	}
});

// --- un gaz rangé en gâchette (issue #279) -----------------------------------
//
// Mesuré sur une Radiomaster Pocket, EdgeTX en mode Joystick, sous Firefox :
//
//   id      1209-4f54-EdgeTX Radiomaster Pocket Joystick
//   mapping standard   axes=8  boutons=28
//   axe 0,1,2  vu -1.00..1.00      axe 3 à 7  vu 0.00..0.00
//   btn 6      0.997               vu 0.00..1.00
//
// Firefox applique le mapping « standard » à la radio et range son manche des
// gaz dans l'emplacement de la gâchette L2. Le gaz sort donc sur
// `buttons[6].value`, ANALOGIQUE — un bouton numérique rendrait exactement
// 1.000, jamais 0.997 — et le quatrième axe reste mort.
//
// C'est la supposition que #277 avait gardée sans la mesurer : « un manche est
// sur un axe ». Elle rendait le gaz de cette radio structurellement invisible.

// L'instantané du périphérique tel que le navigateur le rapporte, passé par
// padSignals() : c'est la fonction sous test autant que la machine à états.
const pocket = (a0, a1, a2, btn6) => padSignals({
	axes: [a0, a1, a2, 0, 0, 0, 0, 0],
	buttons: Array.from({ length: 28 }, (_, i) => ({ value: i === 6 ? btn6 : 0 })),
});

// Le gaz est à friction : il TIENT sa position, le pilote l'a laissé en bas.
const POCKET = [
	[pocket(0, 0, 0, 0), 1200],        // repos, gaz parqué en bas
	[pocket(0, 0, 0, 0.997), 700],     // gaz à fond — sur le BOUTON 6
	[pocket(0, 0, 0, 0.997), 900],     // lâché : il RESTE en haut
	[pocket(0, 0, 0, 0), 700],         // gaz au minimum
	[pocket(0, 0, 1, 0), 700],         // lacet à droite
	[pocket(0, 0, 0, 0), 400],
	[pocket(0, -1, 0, 0), 700],        // cabrer
	[pocket(0, 0, 0, 0), 400],
	[pocket(1, 0, 0, 0), 700],         // roulis à droite
];

t('#279 : padSignals expose les boutons sur la même course que les axes', () => {
	// Un bouton au repos doit se lire comme un manche parqué en butée basse :
	// c'est ce qui laisse aux seuils du module (tous calibrés sur une course de
	// 2) le sens qu'on leur a mesuré.
	const v = padSignals({ axes: [0.5, -1], buttons: [{ value: 0 }, { value: 1 }, { value: 0.5 }] });
	assert.deepEqual(v, [0.5, -1, -1, 1, 0]);
});

t('#279 : le gaz sur la gâchette L2 est trouvé, et nommé btn 6', () => {
	const s = play(beginCalibration(8 + 28, 8), POCKET);
	const cal = calibrationResult(s);
	assert.ok(cal, `le calibrage doit aboutir — bloqué sur « ${s.prompt} »`);

	// 8 axes puis 28 boutons : le bouton 6 est le signal 14.
	assert.equal(cal.channels.throttle.axis, 14, 'le gaz est sur le bouton 6');
	assert.equal(cal.throttleMode, 'full', 'un gimbal à friction est en pleine course');
	assert.ok(cal.channels.throttle.hi > cal.channels.throttle.lo);

	// Et les trois autres manches restent sur leurs axes.
	assert.equal(cal.channels.yaw.axis, 2);
	assert.equal(cal.channels.pitch.axis, 1);
	assert.equal(cal.channels.roll.axis, 0);

	// Le récapitulatif doit dire « btn 6 » : un pilote qui lit « axis 14 » sur un
	// périphérique qui annonce 8 axes croit à un bug.
	assert.match(calSummaryLines(cal)[0], /btn 6/);
});

t('#279 : le gaz calibré sur un bouton rend bien 0 en bas et 1 en haut', () => {
	const s = play(beginCalibration(8 + 28, 8), POCKET);
	const cal = calibrationResult(s);
	const lire = (btn6) => throttleFromCalibrated(pocket(0, 0, 0, btn6)[14], cal.channels.throttle);
	assert.ok(lire(0) < 0.02, `gaz en bas = ${lire(0)}`);
	assert.ok(lire(0.997) > 0.98, `gaz en haut = ${lire(0.997)}`);
	// Le geste de désarmement (throttle < 0.08) doit rester joignable au repos.
	assert.ok(lire(0) < 0.08);
});

t('#279 : un périphérique qui ne rapporte rien finit par le DIRE', () => {
	// Un pad muet passe l'étape du repos MIEUX qu'un vrai — bruit nul, donc
	// aucun rejet — puis laisse le pilote devant une consigne qui ne bougera
	// jamais. Sans ce garde-fou, rien ne nomme le problème.
	let s = beginCalibration(8 + 28, 8);
	s = feedFor(s, still(pocket(0, 0, 0, 0)), 1200);
	assert.equal(s.phase, 'channel', 'le repos passe : un pad muet est parfaitement stable');
	assert.equal(s.message, null, 'rien à signaler tant que le pilote peut être en train de viser');
	s = feedFor(s, still(pocket(0, 0, 0, 0)), CAL_TIMING.idleWarnMs + 200);
	assert.match(s.message ?? '', /no movement/i, 'après une longue attente immobile, il faut le dire');
	assert.equal(s.phase, 'channel', 'mais on ne renonce pas : le pilote peut encore bouger');
});

console.log(`\n  ${n} tests OK`);
