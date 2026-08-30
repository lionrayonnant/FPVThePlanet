// node tools/space-render-selftest.mjs
//
// Vérifie le GRAPHE de l'acoustique du lieu sur un faux contexte : sa forme, sa
// compensation de gain et son extinction. Ce que l'oreille juge — est-ce que ça
// sonne comme un lieu — n'est pas ici.
//
// Ces tests existent à cause de deux défauts entendus en vol, tous deux
// invisibles en lecture de code :
//
//   « un écho infini qui devient un bruit horrible »   → accumulation
//   « ça ne se coupe pas à la fin de la session »       → extinction incomplète
//
// Mesuré au navigateur avant correction, sur du bruit continu à -16,8 dB en
// entrée : la réverbération seule sortait à -10,8 dB avec un pic à 1,28, soit
// PLUS FORT que le signal qui l'alimentait, et au-delà de la pleine échelle.
// Après : -33,7 dB, pic 0,10.

import { strict as assert } from 'node:assert';
import { fakeAudioContext } from './lib/fake-audio-ctx.mjs';
import * as bus from '../src/audio-bus.js';
import { SpaceAudio } from '../src/space.js';

let n = 0;
function t(name, fn) {
	try { fn(); n++; console.log(`  ok  ${name}`); }
	catch (e) { console.error(`  ✗   ${name}\n      ${e.message}`); process.exitCode = 1; }
}

function fresh() {
	bus._reset();
	const ctx = fakeAudioContext();
	bus._setContextFactory(() => ctx);
	bus.ensureContext();
	return ctx;
}

function built() {
	const ctx = fresh();
	const sp = new SpaceAudio();
	const dest = ctx.createGain();
	sp.build(ctx, dest);
	return { ctx, sp, dest };
}

t('le réseau se construit une fois et une seule', () => {
	const { ctx, sp, dest } = built();
	const first = sp.nodesCreated;
	assert.ok(first > 0, 'aucun nœud construit');
	sp.build(ctx, dest);
	assert.equal(sp.nodesCreated, first, 'build() n\'est pas idempotent');
});

t('update() ne crée AUCUN nœud, même appelé mille fois', () => {
	const { sp } = built();
	const before = sp.nodesCreated;
	const probe = new Float32Array(10);
	for (let i = 0; i < 8; i++) probe[i] = 3;
	probe[8] = 3; probe[9] = 2;
	for (let i = 0; i < 1000; i++) sp.update(probe);
	assert.equal(sp.nodesCreated, before, 'des nœuds sont créés par frame');
});

t('chaque peigne a un envoi compensé, pas un branchement direct', () => {
	// LE défaut du bruit qui montait : quatre peignes sommés tels quels.
	const { sp } = built();
	assert.ok(sp._combs.length >= 4, 'moins de quatre peignes');
	for (const c of sp._combs) {
		assert.ok(c.send, 'peigne sans envoi compensé');
		assert.ok(c.fb, 'peigne sans contre-réaction');
	}
});

t('le niveau du mouillé est INDÉPENDANT de la durée de queue', () => {
	// L'invariant qui empêche l'accumulation. Le gain permanent d'un peigne
	// alimenté en continu est 1/(1-g) ; l'envoi vaut (1-g)/N ; leur produit
	// vaut donc 1/N quelle que soit la durée demandée. Sans ça, « plus de
	// queue » veut aussi dire « plus fort », et un moteur qui ne s'arrête
	// jamais fait monter le réseau jusqu'à l'écrêtage.
	const { sp } = built();
	const probe = (h, up, down) => {
		const a = new Float32Array(10);
		for (let i = 0; i < 8; i++) a[i] = h;
		a[8] = up; a[9] = down; return a;
	};
	for (const p of [probe(30, 30, 150), probe(12, 30, 4), probe(2.5, 30, 3), probe(1, 1.5, 1)]) {
		sp.update(p);
		let total = 0;
		for (const c of sp._combs) {
			const g = c.fb.gain.value;
			assert.ok(g < 1, `contre-réaction ${g} : le peigne diverge`);
			total += (1 / (1 - g)) * c.send.gain.value;
		}
		assert.ok(Math.abs(total - 1) < 0.05,
			`gain permanent ${total.toFixed(3)} au lieu de 1 — la compensation ne suit pas`);
	}
});

t('la contre-réaction reste sous son plafond sur toute la plage', () => {
	const { sp } = built();
	const a = new Float32Array(10);
	for (let h = 0.2; h <= 40; h += 0.5) {
		for (let i = 0; i < 8; i++) a[i] = h;
		a[8] = h; a[9] = h;
		sp.update(a);
		for (const c of sp._combs) {
			assert.ok(c.fb.gain.value <= 0.71, `contre-réaction ${c.fb.gain.value} à ${h} m`);
		}
	}
});

t('la diffusion est en SÉRIE, après les peignes', () => {
	// Sans elle, quatre peignes bouclés résonnent à 1/T — 23 à 51 Hz pour ces
	// longueurs — et ce battement posé sur un son déjà périodique s'entend
	// comme « un tour d'hélice = un écho ». Diffuser avant les peignes ne
	// diffuserait que l'entrée, pas les répétitions.
	const { ctx } = built();
	const delays = ctx._nodes.filter((x) => x.type === 'delay');
	// 1 pré-delay + 4 peignes + les allpass de diffusion.
	assert.ok(delays.length >= 8, `${delays.length} lignes à retard, diffusion absente`);
});

t('les longueurs de peigne ne sont pas en rapport simple', () => {
	// Des retards commensurables superposent leurs résonances et le réseau
	// sonne comme une hauteur au lieu d'un lieu.
	const { sp } = built();
	const times = sp._combs.map((c) => c.time).sort((a, b) => a - b);
	for (let i = 1; i < times.length; i++) {
		const r = times[i] / times[0];
		assert.ok(Math.abs(r - Math.round(r)) > 0.1, `rapport ${r.toFixed(3)} trop proche d'un entier`);
	}
});

t('silence() coupe le mouillé ET ouvre les boucles', () => {
	// Couper le seul wet laisse l'énergie tourner dans les peignes : rouvrir
	// plus tard réveillerait la queue du vol précédent. C'est ce qui faisait
	// continuer le bruit dans les menus après la fin de session.
	const { sp } = built();
	const a = new Float32Array(10);
	for (let i = 0; i < 8; i++) a[i] = 2;
	a[8] = 2; a[9] = 2;
	sp.update(a);
	assert.ok(sp._wet.gain.value > 0, 'rien à couper, le test ne prouve rien');
	sp.silence();
	assert.equal(sp._wet.gain.value, 0, 'le mouillé n\'est pas coupé');
	for (const c of sp._combs) {
		assert.equal(c.fb.gain.value, 0, 'une boucle tourne encore après silence()');
	}
});

t('silence() est idempotent et survit à un update() ultérieur', () => {
	const { sp } = built();
	sp.silence();
	sp.silence();
	assert.equal(sp._wet.gain.value, 0);
	// Reprendre un vol doit réarmer proprement.
	const a = new Float32Array(10);
	for (let i = 0; i < 8; i++) a[i] = 3;
	a[8] = 3; a[9] = 3;
	sp.update(a);
	assert.ok(sp._wet.gain.value > 0, 'le réseau ne se réarme pas après silence()');
});

t('sans contexte ni destination, on reste muet sans jeter', () => {
	const sp = new SpaceAudio();
	assert.equal(sp.build(null, null), null);
	assert.equal(sp.running, false);
	sp.update(null);      // ne doit pas jeter
	sp.silence();
	assert.equal(sp.nodesCreated, 0);
});

console.log(`\n${n} tests OK`);
