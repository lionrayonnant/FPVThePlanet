// node tools/swarm-audio-selftest.mjs — la voix de l'essaim (issue #29) : le
// modèle PUR (tools/swarm-audio-model.mjs), le bus `others` partagé avec les
// ambiants, et le graphe Web Audio sur un faux contexte. Aucun AudioContext
// n'est ouvert ici. Ce qui s'écoute se juge à l'oreille, pas dans ce fichier.
//
// Quatre propriétés portent la tranche, dans cet ordre d'importance :
//   1. essaim + ambiants ≤ le plafond du bus, QUELLE QUE SOIT la taille ;
//   2. aucune énergie de la nappe dans 2–4 kHz ;
//   3. les détunes sont tous distincts ;
//   4. la réassignation des 3 voix ne fait AUCUN saut de gain.
import { strict as assert } from 'node:assert';
import {
	OTHERS, OTHERS_CAP, AMBIENT_WORST, SWARM_AUDIO, SWARM_WORST, TRIM,
	NEAR_DETUNE, BED_DETUNE, NEAR_WANDER_HZ, BED_WANDER_HZ,
	nearGain, bedGain, bedCenter, bedResponse, rankNearest, detuneAt,
	centsToRatio, unitBladeFreq, swarmSum,
} from './swarm-audio-model.mjs';
import { VOICE, gainFor, dopplerFor } from './ambient-audio-model.mjs';
import { SwarmAudio } from '../src/swarm-audio.js';
import { AmbientAudio } from '../src/ambient-audio.js';
import { othersBus, setSwarmPresent, AMBIENT_ALONE, _resetOthers } from '../src/audio-others.js';
import { SWARM_UNIT, MAX_SIZE } from '../src/swarm.js';
import { AUDIO } from '../src/audio.js';

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Un générateur déterministe : un selftest qui échoue une fois sur dix ne
// prouve rien.
function rng(seed) {
	let x = seed >>> 0;
	return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ------------------------------------------------------------------ le budget

test('le plafond du bus est bien −12 dB sous l\'idleLevel du joueur', () => {
	assert.equal(OTHERS.idleLevel, AUDIO.idleLevel, 'idleLevel recopié et désynchronisé');
	assert.ok(Math.abs(OTHERS_CAP - AUDIO.idleLevel * Math.pow(10, -12 / 20)) < 1e-12);
	assert.ok(Math.abs(OTHERS.ambientShare + OTHERS.swarmShare - 1) < 1e-12, 'les parts ne font pas 1');
});

test('LA propriété : essaim + ambiants ≤ le plafond, quelle que soit la taille', () => {
	const r = rng(20260908);
	const dNear = [0, 0, 0];
	// Le pire cas exact, puis 20 000 tirages : tailles absurdes comprises,
	// parce que « quelle que soit la taille » ne veut pas dire « jusqu'à 12 ».
	const worst = AMBIENT_WORST * TRIM.ambient + SWARM_WORST * TRIM.swarm;
	assert.ok(worst <= OTHERS_CAP + 1e-12, `pire cas ${worst} > plafond ${OTHERS_CAP}`);
	assert.ok(worst > OTHERS_CAP * 0.999, `plafond gaspillé : ${worst} contre ${OTHERS_CAP}`);
	for (let i = 0; i < 20000; i++) {
		const n = Math.floor(r() * 200);
		for (let k = 0; k < 3; k++) dNear[k] = r() * r() * 300;
		dNear.sort((a, b) => a - b);
		const dMean = r() * r() * 300;
		const sum = swarmSum(dNear, n, dMean) * TRIM.swarm + AMBIENT_WORST * TRIM.ambient;
		assert.ok(sum <= OTHERS_CAP + 1e-12, `n=${n} d=${dNear} dMean=${dMean} → ${sum}`);
	}
	// Et la taille que le modèle produit réellement (6..12) ne sature pas le
	// plafond à elle seule : les ambiants gardent leur part.
	for (let n = 6; n <= MAX_SIZE; n++) {
		assert.ok(swarmSum([0, 0, 0], n, 0) * TRIM.swarm <= OTHERS.swarmShare * OTHERS_CAP + 1e-12);
	}
});

test('la nappe sature : au-delà de nMax, plus rien ne monte', () => {
	const at12 = bedGain(MAX_SIZE, 30);
	assert.ok(bedGain(1000, 30) === at12, 'la nappe grandit encore à n = 1000');
	assert.equal(bedGain(SWARM_AUDIO.nearVoices, 30), 0, 'trois unités : rien à mettre dans la nappe');
	assert.ok(bedGain(12, 30) > bedGain(6, 30), 'la nappe ne suit pas le nombre');
	assert.ok(bedGain(12, 30) < bedGain(12, 10), 'la nappe ne suit pas la distance');
	assert.equal(bedGain(12, VOICE.dMax), 0);
});

test('la borne ambiante est une CONVENTION, et on dit laquelle', () => {
	// À d0 elle est exacte — mais c'est la DÉFINITION de TRIM.ambient, donc
	// cette égalité ne prouve rien d'autre que l'absence de faute de frappe.
	assert.ok(Math.abs(4 * gainFor(VOICE.d0) * TRIM.ambient - OTHERS.ambientShare * OTHERS_CAP) < 1e-12);
	// Ce qui est vrai et qu'il FAUT dire : en dessous de d0 la loi des
	// ambiants continue de monter, donc la borne n'est pas un supremum.
	// Quatre voix collées à l'auditeur sortiraient au double de leur part —
	// 2,5 × avec leur bruit (NOISE_LEVEL = 0,25 dans src/ambient-audio.js).
	// L'hypothèse qui la fait tenir est une distance de naissance ≥ d0 :
	// R_SPAWN part de 120 m, et rien dans le code ne le VÉRIFIE (le chemin
	// petite scène de src/ambient.js:359 a rMin = 0). Hypothèse héritée de
	// #250, écrite dans src/audio-others.js, non corrigée ici — clamper
	// gainFor() serait une seconde modification de code son validé.
	const atZero = 4 * gainFor(0) * TRIM.ambient;
	const share = OTHERS.ambientShare * OTHERS_CAP;
	assert.ok(atZero > share, 'la borne ambiante est devenue un supremum : le commentaire d\'audio-others.js est à corriger');
	assert.ok(Math.abs(atZero / share - 2) < 0.05, `${(atZero / share).toFixed(2)} × la part, et non 2`);
	// Le prix payé, dit une fois : les ambiants perdent ~3 dB.
	const drop = 20 * Math.log10(TRIM.ambient);
	assert.ok(drop < -2.5 && drop > -3.5, `${drop.toFixed(2)} dB`);
});

// ------------------------------------------------------------ 2–4 kHz : rien

test('aucune énergie de la nappe dans 2–4 kHz', () => {
	const fMean = unitBladeFreq(SWARM_UNIT, 0);
	assert.ok(fMean > 1000 && fMean < 1200, `fréquence de pale ${fMean.toFixed(0)} Hz`);
	assert.ok(bedCenter(fMean) <= SWARM_AUDIO.bedCenterMax);
	// Le centre est plafonné même si la famille change et monte.
	assert.equal(bedCenter(5000), SWARM_AUDIO.bedCenterMax);

	const peak = bedResponse(bedCenter(fMean), fMean);
	let worst = 0, worstF = 0;
	for (let f = 2000; f <= 4000; f += 10) {
		const m = bedResponse(f, fMean);
		if (m > worst) { worst = m; worstF = f; }
	}
	const rel = 20 * Math.log10(worst / peak);
	assert.ok(rel <= -24, `${rel.toFixed(1)} dB sous le centre à ${worstF} Hz — pas assez`);
	// Et en ABSOLU, ce qui est la vraie question : la nappe au pire de son
	// niveau, trim du bus compris, laisse-t-elle quoi que ce soit d'audible
	// dans la bande dure ? Repère : 50 dB sous l'idleLevel du joueur.
	const abs = bedGain(SWARM_AUDIO.nMax, 0) * TRIM.swarm * worst;
	const floor = AUDIO.idleLevel * Math.pow(10, -50 / 20);
	assert.ok(abs <= floor, `${abs.toExponential(2)} > ${floor.toExponential(2)}`);
});

test('les fondamentaux ne montent jamais dans 2–4 kHz non plus', () => {
	// Balayage complet : accélération jusqu'à la butée du modèle ambiant,
	// Doppler aux deux bornes, détune et wander au maximum.
	let max = 0;
	for (let a = 0; a <= 60; a += 2) {
		for (let vr = -VOICE.vrMax; vr <= VOICE.vrMax; vr += 5) {
			const f = dopplerFor(unitBladeFreq(SWARM_UNIT, a), vr);
			const cents = SWARM_AUDIO.detuneCents + SWARM_AUDIO.wanderCents;
			max = Math.max(max, f * centsToRatio(cents));
		}
	}
	assert.ok(max < 2000, `${max.toFixed(0)} Hz`);
});

// ------------------------------------------------------------------ le détune

test('détunes distincts, bornés, et wander sans période commune', () => {
	const all = [...NEAR_DETUNE, ...BED_DETUNE];
	assert.equal(NEAR_DETUNE.length, SWARM_AUDIO.nearVoices);
	assert.equal(BED_DETUNE.length, SWARM_AUDIO.bedOscs);
	assert.equal(new Set(all).size, all.length, 'deux voix partagent un détune');
	assert.ok(all.every((c) => Math.abs(c) <= SWARM_AUDIO.detuneCents), 'détune hors des ±9 cents');
	assert.ok(all.every((c) => c !== 0), 'une voix sans détune se verrouille avec la nappe');
	const rates = [...NEAR_WANDER_HZ, ...BED_WANDER_HZ];
	assert.equal(new Set(rates).size, rates.length);
	// Aucun rapport entier simple entre deux taux : deux LFO en rapport 2:1
	// ramènent le chœur au même accord une fois sur deux.
	for (let i = 0; i < rates.length; i++) {
		for (let j = i + 1; j < rates.length; j++) {
			const q = rates[j] / rates[i];
			for (let k = 2; k <= 4; k++) assert.ok(Math.abs(q - k) > 0.05 && Math.abs(q - 1 / k) > 0.05, `${rates[i]} et ${rates[j]}`);
		}
	}
	// Le wander reste dans son amplitude, et il bouge vraiment.
	let lo = Infinity, hi = -Infinity;
	for (let t = 0; t < 60; t += 0.05) { const c = detuneAt(0, NEAR_WANDER_HZ[0], 0, t); lo = Math.min(lo, c); hi = Math.max(hi, c); }
	assert.ok(hi - lo > SWARM_AUDIO.wanderCents, `wander plat : ${(hi - lo).toFixed(2)} cents`);
	assert.ok(hi <= SWARM_AUDIO.wanderCents + 1e-9 && lo >= -SWARM_AUDIO.wanderCents - 1e-9);
});

// -------------------------------------------------------------- les 3 rangs

test('rankNearest : les trois plus proches, dans l\'ordre, sans allouer', () => {
	const d = Float64Array.from([9, 3, 7, 1, 5]);
	const out = new Int32Array(3);
	assert.equal(rankNearest(5, d, out), out);
	assert.deepEqual([...out], [3, 1, 4]);
	// Moins d'unités que de voix : les rangs manquants valent −1.
	const d2 = Float64Array.from([4, 2]);
	rankNearest(2, d2, out);
	assert.deepEqual([...out], [1, 0, -1]);
	// Ex aequo : un choix, pas un NaN, et jamais deux fois la même unité.
	const d3 = Float64Array.from([5, 5, 5, 5]);
	rankNearest(4, d3, out);
	assert.equal(new Set([...out]).size, 3);
});

test('LA continuité : deux unités qui échangent leur rang ne font aucun saut de gain', () => {
	// Cinq unités ; l'unité 0 dérive de 10 m à 60 m et SORT des trois plus
	// proches, remplacée par l'unité 3, restée loin. C'est l'instant où une
	// liaison voix→unité mal faite claque. Le rang, lui, est continu par
	// construction : d[0] ≤ d[1] ≤ d[2] est une fonction continue des
	// distances même quand les identités derrière elle changent.
	const n = 5;
	const d = new Float64Array(n);
	const out = new Int32Array(3);
	const FIXED = [0, 12, 14, 45, 60];
	const dist = (k, t) => (k === 0 ? 10 + 50 * t : FIXED[k]);
	const step = 1 / 240;
	// Ce qu'une frame peut bouger, au pire : 50 m/s sur 1/240 s, là où la loi
	// de gain est la plus raide (d = 0).
	const bound = Math.abs(nearGain(0) - nearGain(50 / 240)) + 1e-12;

	let prevRank = null, prevIdx = null, prevSet = null, membership = false;
	let rankJump = 0, idxJump = 0;
	for (let t = 0; t <= 1; t += step) {
		for (let k = 0; k < n; k++) d[k] = dist(k, t);
		rankNearest(n, d, out);
		// Par RANG : la voix i chante la i-ème plus proche.
		const byRank = [0, 1, 2].map((i) => nearGain(d[out[i]]));
		// Le contre-exemple : le même trio, mais réparti sur les voix par
		// INDEX d'unité — l'ordre « naturel » quand on itère sur les unités.
		// Une entrée/sortie dans le trio décale alors tout le monde d'un cran.
		const set = [...out].sort((a, b) => a - b);
		const byIndex = set.map((u) => nearGain(d[u]));
		if (prevRank) {
			for (let i = 0; i < 3; i++) rankJump = Math.max(rankJump, Math.abs(byRank[i] - prevRank[i]));
			for (let i = 0; i < 3; i++) idxJump = Math.max(idxJump, Math.abs(byIndex[i] - prevIdx[i]));
			if (set.join() !== prevSet) membership = true;
		}
		prevSet = set.join(); prevRank = byRank; prevIdx = byIndex;
	}
	assert.ok(membership, 'le trio n\'a jamais changé : le test ne teste rien');
	assert.ok(rankJump <= bound, `saut de gain ${rankJump.toExponential(2)} > ${bound.toExponential(2)}`);
	// Et l'écart avec le contre-exemple, qui est ce que le rang achète.
	assert.ok(idxJump > 20 * rankJump, `contre-exemple ${idxJump.toExponential(2)} contre rang ${rankJump.toExponential(2)}`);
});

test('nearGain : décroissant, nul à dMax, et c\'est la loi des ambiants', () => {
	let prev = Infinity;
	for (let dd = 0; dd <= 260; dd += 2) { const g = nearGain(dd); assert.ok(g <= prev + 1e-12); prev = g; }
	assert.equal(nearGain(VOICE.dMax), 0);
	assert.ok(Math.abs(nearGain(0) - SWARM_AUDIO.g0) < 1e-12);
	assert.ok(Math.abs(nearGain(SWARM_AUDIO.d0) - SWARM_AUDIO.g0 / 2) < 1e-12);
});

// ----------------------------------------------------------------- Web Audio
// Faux contexte, repris de tools/ambient-audio-selftest.mjs : il compte les
// nœuds, garde les AudioParams, et ne joue rien.
function fakeContext() {
	let created = 0;
	const param = (v) => ({ value: v, setTargetAtTime(t) { this.value = t; }, setValueAtTime(t) { this.value = t; } });
	const node = (extra = {}) => {
		created++;
		return { targets: [], connect(t) { this.targets.push(t); return t; }, disconnect() {}, start() {}, stop() {}, ...extra };
	};
	return {
		currentTime: 0, sampleRate: 48000, state: 'running',
		get created() { return created; },
		createGain: () => node({ gain: param(1) }),
		createOscillator: () => node({ type: 'sine', frequency: param(440), detune: param(0) }),
		createBiquadFilter: () => node({ type: 'lowpass', frequency: param(1000), Q: param(1) }),
		createStereoPanner: () => node({ pan: param(0) }),
		createBufferSource: () => node({ buffer: null, loop: false }),
		createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
		destination: {},
	};
}

function state(count, dNear, dMean) {
	return {
		count, nearCount: Math.min(3, count), dMean, accelMean: 0, bedPan: 0.2,
		profile: SWARM_UNIT,
		near: dNear.map((d) => ({ d, behind: 0.1, pan: 0.3, vRadial: 2, accelMag: 5 })),
	};
}

test('graphe : ~24 nœuds, construit une fois, aucun nœud pendant update()', () => {
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const before = ctx.created;
	const a = new SwarmAudio({ destination: dest, spaceInput: ctx.createGain() });
	a.start(ctx);
	assert.equal(a.nodesCreated, 24, `${a.nodesCreated} nœuds propres`);
	// +3 pour le bus `others`, partagé et bâti une fois par contexte.
	assert.equal(ctx.created - before, 24 + 1 + 3);
	const after = ctx.created;
	const st = state(9, [12, 18, 25], 40);
	for (let i = 0; i < 300; i++) a.update(st, i / 60);
	assert.equal(ctx.created, after, 'un nœud a été créé pendant update()');
	a.silence();
	a.dispose();
	assert.equal(ctx.created, after);
});

test('graphe : sinus seulement, et la nappe est bornée en fréquence', () => {
	_resetOthers();
	const ctx = fakeContext();
	const a = new SwarmAudio({ destination: ctx.createGain() });
	a.start(ctx);
	assert.ok(a._near.every((v) => v.osc.type === 'sine'));
	assert.ok(a._bed.oscs.every((o) => o.osc.type === 'sine'));
	assert.equal(a._bed.band.type, 'bandpass');
	assert.equal(a._bed.lp1.type, 'lowpass');
	assert.equal(a._bed.lp2.type, 'lowpass');
	assert.ok(a._bed.lp1.frequency.value <= SWARM_AUDIO.bedCenterMax);
	assert.ok(a._bed.lp2.frequency.value <= SWARM_AUDIO.bedCenterMax);
	// Le pire cas de la nappe est bien celui qui a été budgété : le bruit plus
	// les trois sinus EN PHASE ne dépassent pas bedGain. Sans la division par
	// bedOscs, trois sinus alignés sortaient à 1,35 × le budget.
	assert.ok(a._bed.noiseGain.gain.value + a._bed.toneGain.gain.value * SWARM_AUDIO.bedOscs <= 1 + 1e-12,
		'la nappe peut dépasser son budget quand ses sinus se mettent en phase');
	// Après une frame : le centre de la bande reste sous le plafond, et les
	// trois sinus de la nappe sont bien désaccordés les uns des autres.
	a.update(state(12, [10, 14, 20], 35), 3.5);
	assert.ok(a._bed.band.frequency.value <= SWARM_AUDIO.bedCenterMax);
	const f = a._bed.oscs.map((o) => o.osc.frequency.value);
	assert.equal(new Set(f).size, 3);
	assert.ok(f.every((x) => x < 2000));
	const fn = a._near.map((v) => v.osc.frequency.value);
	assert.equal(new Set(fn).size, 3, 'les trois voix proches sont à la même fréquence');
	assert.ok(fn.every((x) => x < 2000));
});

test('graphe : gelé, muet, ou sans essaim → tous les gains à zéro', () => {
	_resetOthers();
	const ctx = fakeContext();
	const a = new SwarmAudio({ destination: ctx.createGain() });
	a.start(ctx);
	a.update(state(9, [10, 14, 20], 35), 1);
	assert.ok(a._near[0].gain.gain.value > 0 && a._bed.gain.gain.value > 0);
	a.setMuted(true);
	a.update(state(9, [10, 14, 20], 35), 2);
	assert.ok(a._near.every((v) => v.gain.gain.value === 0));
	assert.equal(a._bed.gain.gain.value, 0);
	a.setMuted(false);
	a.update(state(0, [], 0), 3);
	assert.ok(a._near.every((v) => v.gain.gain.value === 0));
	assert.equal(a._bed.gain.gain.value, 0);
	// Trois unités ou moins : les voix chantent, la nappe se tait.
	a.update(state(3, [5, 9, 14], 9), 4);
	assert.ok(a._near.every((v) => v.gain.gain.value > 0));
	assert.equal(a._bed.gain.gain.value, 0);
});

test('bus : ambiants et essaim entrent par la MÊME sortie, chacun par son trim', () => {
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const amb = new AmbientAudio({ destination: dest });
	const sw = new SwarmAudio({ destination: dest });
	amb.start(ctx);
	const afterAmbient = ctx.created;
	sw.start(ctx);
	// Le bus n'est bâti qu'une fois : le second démarrage ne crée que ses
	// propres nœuds.
	assert.equal(ctx.created - afterAmbient, 24);
	const bus = othersBus(ctx, dest);
	assert.equal(bus.ambient.targets[0], bus.out);
	assert.equal(bus.swarm.targets[0], bus.out);
	assert.equal(bus.out.targets[0], dest);
	assert.ok(Math.abs(bus.ambient.gain.value - TRIM.ambient) < 1e-12);
	assert.ok(Math.abs(bus.swarm.gain.value - TRIM.swarm) < 1e-12);
	// Aucune voix ne touche `dest` directement : tout passe par le plafond.
	assert.ok(amb._voices.every((v) => !v.pan.targets.includes(dest)));
	assert.ok(amb._voices.every((v) => v.pan.targets.includes(bus.ambient)));
	assert.ok(!sw._out.targets.includes(dest));
	assert.ok(sw._out.targets.includes(bus.swarm));
});

test('space : l\'envoi part APRÈS le trim, et se branche même s\'il arrive tard', () => {
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const a = new SwarmAudio({ destination: dest });
	a.start(ctx);
	const spaceIn = ctx.createGain();
	const bus = othersBus(ctx, dest);
	assert.ok(!bus.swarm.targets.includes(spaceIn), 'branché trop tôt');
	const nodes = ctx.created;
	a.update(state(0, [], 0), 0, spaceIn);
	assert.equal(bus.swarm.targets.filter((t) => t === spaceIn).length, 1, 'envoi non branché');
	for (let i = 1; i < 50; i++) a.update(state(0, [], 0), i / 60, spaceIn);
	assert.equal(bus.swarm.targets.filter((t) => t === spaceIn).length, 1, 'branché plusieurs fois');
	assert.equal(ctx.created, nodes, 'un nœud a été créé pendant update()');
});

test('graphe : les gains ÉCRITS sont ceux du modèle, pas seulement non nuls', () => {
	// Sans ces trois lignes, un gain de compensation ×2 glissé dans
	// swarm-audio.js laisserait les autres tests verts et le plafond faux :
	// ils ne regardent que « > 0 » et « === 0 ».
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const a = new SwarmAudio({ destination: dest });
	a.start(ctx);
	const st = state(9, [7, 13, 26], 41);
	a.update(st, 1);
	assert.equal(a._out.gain.value, 1, 'la sortie n\'est pas à l\'unité : le plafond a bougé');
	for (let i = 0; i < SWARM_AUDIO.nearVoices; i++) {
		assert.ok(Math.abs(a._near[i].gain.gain.value - nearGain(st.near[i].d)) < 1e-12,
			`voix ${i} : ${a._near[i].gain.gain.value} contre ${nearGain(st.near[i].d)}`);
	}
	assert.ok(Math.abs(a._bed.gain.gain.value - bedGain(st.count, st.dMean)) < 1e-12,
		`nappe : ${a._bed.gain.gain.value} contre ${bedGain(st.count, st.dMean)}`);
	// Et le dernier maillon entre le plafond calculé et le plafond entendu.
	assert.ok(Math.abs(othersBus(ctx, dest).swarm.gain.value - TRIM.swarm) < 1e-12);
	assert.ok(Math.abs(othersBus(ctx, dest).ambient.gain.value - TRIM.ambient) < 1e-12);
	assert.equal(othersBus(ctx, dest).out.gain.value, 1);
});

test('bus : le PREMIER appelant fige la destination, et `dest` le dit', () => {
	// Le piège du singleton de module, verrouillé ici pour qu'il ne devienne
	// pas une surprise : une seconde destination est jetée en silence. Sans
	// effet aujourd'hui — les deux sources passent engineIn() — mais c'est
	// écrit dans src/audio-others.js et `dest` permet de le constater.
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const other = ctx.createGain();
	assert.equal(othersBus(ctx, dest).dest, dest);
	assert.equal(othersBus(ctx, other).dest, dest, 'la seconde destination a été prise');
	assert.equal(othersBus(ctx, other).out.targets.length, 1, 'la sortie a été rebranchée');
	// Un autre contexte, un autre bus : le cache est bien porté par le ctx.
	const ctx2 = fakeContext();
	const dest2 = ctx2.createGain();
	assert.equal(othersBus(ctx2, dest2).dest, dest2);
});

// -------------------------------------- qui paie la part de l'essaim, et quand
//
// Le partage coûte ~3 dB aux ambiants, et un cluster ne tombe qu'une session
// sur dix : le payer dans TOUS les vols, c'est provisionner neuf fois sur dix
// une part que personne ne prend. Ces trois tests verrouillent les deux cas et
// la sûreté d'ordre entre eux.

test('sans essaim : les ambiants retrouvent le plafond entier (le niveau de #250)', () => {
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	setSwarmPresent(false);
	const amb = new AmbientAudio({ destination: dest });
	amb.start(ctx);
	const bus = othersBus(ctx, dest);
	assert.ok(Math.abs(bus.ambient.gain.value - AMBIENT_ALONE) < 1e-12,
		`trim ${bus.ambient.gain.value} au lieu de ${AMBIENT_ALONE}`);
	// Le pire cas des ambiants EST le plafond : rien n'est ni gaspillé ni dépassé.
	assert.ok(Math.abs(AMBIENT_WORST * bus.ambient.gain.value - OTHERS_CAP) < 1e-12);
	// Et c'est bien ~3 dB au-dessus de la part partagée, pas un arrondi.
	const gainDb = 20 * Math.log10(AMBIENT_ALONE / TRIM.ambient);
	assert.ok(Math.abs(gainDb - 20 * Math.log10(1 / OTHERS.ambientShare)) < 1e-9);
	assert.ok(gainDb > 3, `${gainDb} dB récupérés seulement`);
	// La déclaration se pose aussi APRÈS la construction du graphe (le contexte
	// s'ouvre au premier son d'interface, avant openFlightSession()).
	setSwarmPresent(true);
	assert.ok(Math.abs(bus.ambient.gain.value - TRIM.ambient) < 1e-12);
	setSwarmPresent(false);
	assert.ok(Math.abs(bus.ambient.gain.value - AMBIENT_ALONE) < 1e-12);
});

test('avec essaim : la somme reste sous le plafond, quelle que soit la taille', () => {
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	setSwarmPresent(true);
	const amb = new AmbientAudio({ destination: dest });
	const sw = new SwarmAudio({ destination: dest });
	amb.start(ctx);
	sw.start(ctx);
	const bus = othersBus(ctx, dest);
	// Les trims LUS sur le graphe, pas les constantes du modèle : c'est le
	// dernier maillon, et c'est lui que la déclaration peut fausser.
	const ga = bus.ambient.gain.value, gs = bus.swarm.gain.value;
	const r = rng(20260909);
	const dNear = [0, 0, 0];
	assert.ok(AMBIENT_WORST * ga + SWARM_WORST * gs <= OTHERS_CAP + 1e-12);
	for (let i = 0; i < 20000; i++) {
		const n = Math.floor(r() * 200);
		for (let k = 0; k < 3; k++) dNear[k] = r() * r() * 300;
		dNear.sort((a, b) => a - b);
		const dMean = r() * r() * 300;
		const sum = AMBIENT_WORST * ga + swarmSum(dNear, n, dMean) * gs;
		assert.ok(sum <= OTHERS_CAP + 1e-12, `n=${n} → ${sum} > ${OTHERS_CAP}`);
	}
});

test('plafond structurel : prendre la branche essaim suffit, sans déclaration', () => {
	// LA propriété ne doit pas dépendre d'un ordre d'appel ni d'un appelant qui
	// pense à parler. Un vol déclaré sans essaim où une voix d'essaim démarre
	// quand même — bug, chemin de dev, essaim posé tard — doit revenir au
	// partage tout seul, avant que cette voix ne s'entende.
	_resetOthers();
	const ctx = fakeContext();
	const dest = ctx.createGain();
	setSwarmPresent(false);
	const amb = new AmbientAudio({ destination: dest });
	amb.start(ctx);
	assert.ok(Math.abs(othersBus(ctx, dest).ambient.gain.value - AMBIENT_ALONE) < 1e-12);
	const sw = new SwarmAudio({ destination: dest });
	sw.start(ctx);   // ne touche que la branche `swarm` du bus
	const bus = othersBus(ctx, dest);
	assert.ok(Math.abs(bus.ambient.gain.value - TRIM.ambient) < 1e-12,
		'les ambiants sont restés au plafond entier alors que l\'essaim chante');
	assert.ok(AMBIENT_WORST * bus.ambient.gain.value + SWARM_WORST * bus.swarm.gain.value
		<= OTHERS_CAP + 1e-12);
	// Et par défaut, sans aucune déclaration, c'est le partage qui tient.
	_resetOthers();
	const ctx2 = fakeContext();
	const dest2 = ctx2.createGain();
	assert.ok(Math.abs(othersBus(ctx2, dest2).ambient.gain.value - TRIM.ambient) < 1e-12);
});

console.log(`swarm-audio: ${passed} tests OK`);
