// node tools/onboard-regime-selftest.mjs — ce que les hélices racontent
// (issue #264). On ne teste pas le rendu ici, mais la PHYSIQUE que le rendu
// donne à lire : quel moteur accélère sur quel manche, et comment le régime
// répond au temps et à la batterie.
import { Propulsion, mixOf, idleThrottle } from '../src/quad.js';
import { PROFILES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const STILL = { v: { x: 0, y: 0, z: 0 }, omega: null, agl: null, shake: 0 };
const profile = PROFILES.freestyle5;
const mix = mixOf(profile);

// Commandes moteur pour un manche donné, par le mixeur réel.
const cmd = (thr, { roll = 0, pitch = 0, yaw = 0 } = {}) =>
	mix.map((m) => Math.max(0, Math.min(1, thr + m.roll * roll + m.pitch * pitch + m.yaw * yaw)));

const settle = (motors, seconds = 1.5) => {
	const p = new Propulsion({ profile, seed: 1 });
	const dt = 1 / 250;
	for (let i = 0; i < seconds / dt; i++) p.step(motors, STILL, dt);
	return p;
};

console.log('onboard-regime');

// 1. Le lacet, la promesse centrale : les deux hélices DU CHAMP sont les
//    avant — moteurs 1 (avant-droit, spin −1) et 3 (avant-gauche, spin +1) —
//    donc deux diagonales opposées. quad.js pose yaw: -m.spin et son
//    commentaire fixe le sens : « yaw left = +omega.y -> spin-down motors up ».
{
	const left = settle(cmd(0.5, { yaw: +1 }));
	check('lacet à gauche : l\'avant-droite accélère, l\'avant-gauche ralentit',
		left.omega[1] > left.omega[3], `${left.omega[1].toFixed(0)} vs ${left.omega[3].toFixed(0)} rad/s`);
	const right = settle(cmd(0.5, { yaw: -1 }));
	check('lacet à droite : l\'inverse', right.omega[1] < right.omega[3],
		`${right.omega[1].toFixed(0)} vs ${right.omega[3].toFixed(0)} rad/s`);
	check('lacet : les deux avant tournent en sens opposés dans le mixeur',
		Math.sign(mix[1].yaw) === -Math.sign(mix[3].yaw));
}

// 2. Le tangage bouge les deux avant ENSEMBLE, le roulis n'en bouge qu'une.
{
	const p = settle(cmd(0.5, { pitch: +0.5 }));
	const neutral = settle(cmd(0.5));
	const d1 = p.omega[1] - neutral.omega[1], d3 = p.omega[3] - neutral.omega[3];
	check('tangage : les deux hélices du champ vont dans le même sens',
		Math.sign(d1) === Math.sign(d3) && Math.abs(d1) > 1, `${d1.toFixed(0)} / ${d3.toFixed(0)}`);
	const r = settle(cmd(0.5, { roll: +0.5 }));
	const r1 = r.omega[1] - neutral.omega[1], r3 = r.omega[3] - neutral.omega[3];
	check('roulis : elles vont en sens contraires',
		Math.sign(r1) === -Math.sign(r3), `${r1.toFixed(0)} / ${r3.toFixed(0)}`);
}

// 3. L'asymétrie du retard moteur : quad.js:328-331, « making spin-down slower
//    than spin-up ». À l'image, les hélices s'emballent net et redescendent
//    lentement.
{
	const p = new Propulsion({ profile, seed: 1 });
	const dt = 1 / 250;
	for (let i = 0; i < 250; i++) p.step(cmd(0.3), STILL, dt);
	const base = p.omega[0];
	for (let i = 0; i < 25; i++) p.step(cmd(0.9), STILL, dt);   // 0,1 s de montée
	const up = p.omega[0] - base;
	for (let i = 0; i < 25; i++) p.step(cmd(0.3), STILL, dt);   // 0,1 s de descente
	const down = p.omega[0] - base;
	// Le `|| up > 0` du plan rendait ce check tautologique : `up` est positif dès
	// que le manche monte. On garde la seule branche qui mord — sur la MÊME
	// fenêtre de 0,1 s, la montée gagne plus que la descente ne rend.
	check('montée en régime plus raide que la descente', up > Math.abs(down - up),
		`+${up.toFixed(0)} puis ${(down - up).toFixed(0)} rad/s`);
	check('l\'asymétrie est bien dans le profil', profile.tauSpinDown > profile.tauSpinUp,
		`tauSpinUp ${profile.tauSpinUp} < tauSpinDown ${profile.tauSpinDown}`);
}

// 4. La batterie : quad.js:205-207, « Motor rpm tracks voltage, so a sagging
//    pack lowers the ceiling on thrust ». Les hélices annoncent le pack mourant.
//    On vide le pack par sa CHARGE, pas par sa tension : `voltage` est une
//    valeur dérivée que `Battery.update()` recalcule à chaque pas depuis
//    `openCircuit()` — donc depuis `usedMah`. Y écrire à la main ne survit pas
//    au premier step, et les deux propulsions finissent au même régime.
{
	const full = settle(cmd(0.8), 1.0);
	const flat = new Propulsion({ profile, seed: 1 });
	flat.battery.usedMah = 0.9 * profile.battery.capacityMah;   // ~9 % de charge
	const dt = 1 / 250;
	for (let i = 0; i < 250; i++) flat.step(cmd(0.8), STILL, dt);
	// Marge mesurée : 374 rad/s, ~14 %. Le seuil à 5 % laisse le modèle de sag
	// bouger sans que le check devienne une comparaison de flottants voisins.
	check('pack vidé : plafond de régime abaissé', flat.omega[0] < 0.95 * full.omega[0],
		`${flat.omega[0].toFixed(0)} < ${full.omega[0].toFixed(0)} rad/s, soit ${(full.omega[0] - flat.omega[0]).toFixed(0)} de moins`);
}

// 5. Au ralenti, le régime est bas mais non nul : c'est le cas où les pales se
//    distinguent une à une dans le champ.
{
	const idle = settle(cmd(idleThrottle(profile)));
	check('ralenti : régime bas et non nul', idle.omega[0] > 0 && idle.omega[0] < 0.6 * profile.maxOmega,
		`${idle.omega[0].toFixed(0)} rad/s sur ${profile.maxOmega}`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
