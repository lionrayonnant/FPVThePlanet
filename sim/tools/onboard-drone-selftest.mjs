// node tools/onboard-drone-selftest.mjs — le drone du joueur (issue #264).
// Le maillage et la règle d'exclusivité se vérifient sans GPU.
import * as THREE from 'three';
import { PlayerDrone } from '../src/onboard-drone.js';
import { shapeOf, eyeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { propCoverage } from './prop-coverage.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const make = (family = 'freestyle5') => {
	const seed = `player::${family}`;
	const build = targetBuild({ seed, family });
	return new PlayerDrone({
		scene: new THREE.Scene(),
		profile: build.profile,
		build,
		camera: targetCamera({ seed, family }),
	});
};

console.log('onboard-drone');
{
	const d = make();
	// Au repos, on est en vue pilote : l'embarqué est monté, le monde est
	// caché. « Jamais les deux » est la vraie règle — pas « jamais aucun ».
	check('au repos : l\'embarqu\u00e9 seul', d.onboardVisible && !d.worldVisible);
	d.setFreeCam(true);
	check('free cam : l\'exemplaire monde est visible', d.worldVisible);
	check('free cam : l\'embarqué est caché', !d.onboardVisible);
	d.setFreeCam(false);
	check('retour en vue pilote : le monde se cache', !d.worldVisible);
	d.dispose();
}
{
	const d = make();
	d.setFreeCam(true);
	d.update({
		dt: 1 / 60,
		position: { x: 12, y: 34, z: -56 },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		omega: [100, 100, 100, 100],
		sun: { dir: new THREE.Vector3(0, 1, 0), night: 0 },
		dim: 1,
		fogColor: 0x223344,
		fogDensity: 0.001,
		resolution: { w: 1600, h: 900 },
	});
	const p = new THREE.Vector3().setFromMatrixPosition(d.world.group.matrix);
	check('l\'exemplaire monde suit la position physique', p.distanceTo(new THREE.Vector3(12, 34, -56)) < 1e-6, `${p.toArray()}`);
	d.dispose();
}
{
	const scene = new THREE.Scene();
	const build = targetBuild({ seed: 'dispose', family: 'race5' });
	const d = new PlayerDrone({ scene, profile: build.profile, build, camera: targetCamera({ seed: 'dispose', family: 'race5' }) });
	const before = scene.children.length;
	d.dispose();
	check('dispose() retire tout de la scène', scene.children.length === 0, `${before} → ${scene.children.length}`);
}

// Issue #264 : la vue embarquée.
{
	const d = make();
	check('une scène embarquée existe', d.onboardScene instanceof THREE.Scene);
	check('sa caméra a un near de 5 mm', Math.abs(d.onboardCamera.near - 0.005) < 1e-9);
	check('en vue pilote, l\'embarqué est visible', d.onboardVisible);
	check('en vue pilote, le monde est caché', !d.worldVisible);

	// Le drone est posé à −mount : l'oeil est EXACTEMENT à l'origine de la
	// scène embarquée, le corps est derrière lui, et les hélices avant sont
	// devant et SOUS l'axe optique — c'est ce montage-là, et pas un autre, que
	// tools/prop-coverage.mjs rasterise pour tenir la borne DA.
	//
	// « Sous » se lit sur les hélices, pas sur la translation du groupe : avec
	// un uptilt franc (au-delà de ~28°, que targetCamera tire), l'axe optique
	// passe sous le plan d'hélice et le centre du corps remonte au-dessus.
	{
		const seed = 'player::freestyle5';
		const build = targetBuild({ seed, family: 'freestyle5' });
		const camera = targetCamera({ seed, family: 'freestyle5' });
		const shape = shapeOf({ profile: build.profile, build, camera, detail: 'onboard' });
		const m = d.onboard.group.matrix;
		const p = new THREE.Vector3().setFromMatrixPosition(m);
		check('le corps est posé derrière l\'oeil', p.z > 0, `${p.toArray().map((v) => v.toFixed(3))}`);
		// L'oeil se lit sur eyeOf() : le niveau `onboard` ne porte plus de part
		// `camera`, justement parce qu'un objectif ne filme pas son boîtier.
		const e = eyeOf(build.profile);
		const eye = new THREE.Vector3(e[0], e[1], e[2]).applyMatrix4(m);
		check('l\'oeil retombe exactement à l\'origine', eye.length() < 1e-9, `${eye.length().toExponential(1)}`);
		const front = shape.parts.filter((q) => q.role === 'prop').sort((a, b) => a.at[2] - b.at[2])[0];
		const v = new THREE.Vector3(front.at[0], front.at[1], front.at[2]).applyMatrix4(m);
		check('les hélices avant sont devant l\'oeil et sous l\'axe optique', v.z < 0 && v.y < 0, `${v.toArray().map((q) => q.toFixed(3))}`);
	}

	d.update({ dt: 1 / 60, omega: [111, 222, 333, 444], camera: { fov: 118, aspect: 4 / 3 } });
	check('la caméra embarquée copie le champ de la caméra de vol', d.onboardCamera.fov === 118 && Math.abs(d.onboardCamera.aspect - 4 / 3) < 1e-9);
	const u = d.onboard.material.uniforms.uOmega.value;
	check('le régime arrive dans le maillage embarqué', u[1] === 222 && u[3] === 444);

	// Exclusivité.
	d.setFreeCam(true);
	check('free cam : l\'embarqué se cache', !d.onboardVisible && d.worldVisible);
	d.setFreeCam(false);
	check('vue pilote : l\'embarqué revient', d.onboardVisible && !d.worldVisible);
	check('jamais les deux à la fois', !(d.onboardVisible && d.worldVisible));
	d.dispose();
}

// Le gel : une image perdue ne doit pas montrer des hélices qui tournent.
{
	const d = make();
	d.update({ dt: 1 / 60, omega: [500, 500, 500, 500], camera: { fov: 120, aspect: 1 } });
	const t0 = d.onboard.material.uniforms.uTime.value;
	d.update({ dt: 0, omega: [500, 500, 500, 500], camera: { fov: 120, aspect: 1 } });
	check('dt = 0 : le temps du maillage n\'avance pas', d.onboard.material.uniforms.uTime.value === t0);
	d.dispose();
}

// La cohérence avec la sonde de la borne DA (tools/prop-coverage.mjs). La borne
// « ≤ 8 % de l'image, rien au-dessus de 50 % de la hauteur » est mesurée par une
// rasterisation qui MODÉLISE le montage : oeil à la part `camera`, champ
// vertical de la caméra tirée, format du capteur, uptilt autour de +X. Si la
// caméra qu'on monte ici s'en écarte, la borne devient un mensonge.
//
// On le vérifie sur le seul chiffre commun aux deux : la hauteur atteinte par
// l'enveloppe balayée. À gauche la sonde ; à droite le bord des disques projeté
// par la VRAIE caméra embarquée, à travers la VRAIE matrice de montage. La
// tolérance est la taille d'une ligne de la grille de la sonde (1/150).
for (const family of FAMILIES) {
	const seed = `coh::${family}`;
	const build = targetBuild({ seed, family });
	const camera = targetCamera({ seed, family });
	const d = new PlayerDrone({ scene: new THREE.Scene(), profile: build.profile, build, camera });
	const shape = shapeOf({ profile: build.profile, build, camera, detail: 'onboard' });
	// La sonde travaille sur la recette COMPLÈTE : c'est là qu'elle trouve la
	// part `camera` dont elle tire l'oeil. Le niveau `onboard` n'en a plus, et
	// c'est justement ce qu'on veut vérifier — que les deux montages coïncident
	// alors qu'ils lisent l'oeil par deux chemins différents.
	const sonde = propCoverage({ shape: shapeOf({ profile: build.profile, build, camera }), camera }).top;

	const m = d.onboard.group.matrix;
	const viewProj = d.onboardCamera.projectionMatrix.clone().multiply(d.onboardCamera.matrixWorldInverse);
	const v = new THREE.Vector3();
	let top = 0;
	for (const disc of shape.parts.filter((q) => q.role === 'prop')) {
		for (let i = 0; i < 512; i++) {
			const a = 2 * Math.PI * i / 512;
			v.set(disc.at[0] + disc.size[0] * Math.cos(a), disc.at[1], disc.at[2] + disc.size[0] * Math.sin(a));
			v.applyMatrix4(m);
			if (v.z >= -1e-6) continue;                  // derrière l'oeil
			v.applyMatrix4(viewProj);
			if (Math.abs(v.x) > 1) continue;             // hors cadre latéralement
			top = Math.max(top, (Math.min(v.y, 1) + 1) / 2);
		}
	}
	check(`${family} : la caméra montée est celle que la sonde mesure`, Math.abs(top - sonde) <= 1 / 150,
		`sonde ${(100 * sonde).toFixed(1)} % vs projeté ${(100 * top).toFixed(1)} %`);
	d.dispose();
}

// La MOITIÉ HAUTE du cadre est libre. C'est la borne DA (≤ 50 % de la hauteur),
// mais portée sur TOUT le maillage embarqué et non sur les seuls disques que
// tools/prop-coverage.mjs rasterise — et c'est la règle que rien ne vérifiait :
// la recette portait un boîtier de caméra centré sur l'oeil, qui couvrait tout
// l'écran. On ne voyait plus le monde, et surtout plus ses propres hélices.
//
// Le test ne regarde pas les rôles de la recette, il lance de vrais rayons sur
// la VRAIE géométrie fusionnée : c'est elle qu'on affiche, et une pièce ajoutée
// demain sera prise au même filet.
{
	const tanV = (fovDeg) => Math.tan(fovDeg * Math.PI / 360);
	// Möller–Trumbore, rayon depuis l'origine (l'oeil) — la géométrie est déjà
	// dans le repère de l'objectif.
	const hits = (pos, idx, m, dir) => {
		const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
		const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), qv = new THREE.Vector3();
		for (let t = 0; t < idx.length; t += 3) {
			a.fromBufferAttribute(pos, idx[t]).applyMatrix4(m);
			b.fromBufferAttribute(pos, idx[t + 1]).applyMatrix4(m);
			c.fromBufferAttribute(pos, idx[t + 2]).applyMatrix4(m);
			e1.subVectors(b, a); e2.subVectors(c, a);
			pv.crossVectors(dir, e2);
			const det = e1.dot(pv);
			if (Math.abs(det) < 1e-12) continue;
			const inv = 1 / det;
			// L'origine du rayon est (0,0,0), donc le vecteur origine→a vaut −a.
			const u = -a.dot(pv) * inv;
			if (u < 0 || u > 1) continue;
			qv.crossVectors(a.clone().negate(), e1);
			const v = dir.dot(qv) * inv;
			if (v < 0 || u + v > 1) continue;
			if (e2.dot(qv) * inv > 1e-5) return true;
		}
		return false;
	};

	for (const family of FAMILIES) {
		let haut = 0, bas = 0, seeds = 0, pire = 0;
		for (const tag of ['a', 'b', 'c', 'd', 'e']) {
			const seed = `libre::${family}::${tag}`;
			const build = targetBuild({ seed, family });
			const camera = targetCamera({ seed, family });
			const d = new PlayerDrone({ scene: new THREE.Scene(), profile: build.profile, build, camera });
			const geo = d.onboard.body.geometry;
			const pos = geo.getAttribute('position');
			const idx = geo.getIndex().array;
			const m = d.onboard.group.matrix;
			const tv = tanV(camera.fovDeg), th = tv * camera.aspect;
			const dir = new THREE.Vector3();
			// Toute la moitié haute, sur toute la largeur.
			for (let i = 0; i <= 16; i++) for (let j = 0; j <= 8; j++) {
				const nx = i / 8 - 1, ny = j / 8;
				dir.set(nx * th, ny * tv, -1).normalize();
				if (hits(pos, idx, m, dir)) { haut++; pire = Math.max(pire, 50 * (ny + 1)); }
			}
			// Et le contrôle en sens inverse : le bas du cadre, lui, DOIT être
			// occupé — sinon « rien dans le cadre » passerait pour un succès.
			let vu = false;
			for (let i = 0; i <= 8 && !vu; i++) for (let j = 0; j <= 6 && !vu; j++) {
				dir.set((i / 4 - 1) * th, (-0.35 - j * 0.09) * tv, -1).normalize();
				if (hits(pos, idx, m, dir)) vu = true;
			}
			if (vu) bas++;
			seeds++;
			d.dispose();
		}
		check(`${family} : la moitié haute du cadre est libre`, haut === 0,
			haut ? `${haut} rayons bloqués, jusqu'à ${pire.toFixed(0)} % de la hauteur` : 'aucun rayon bloqué');
		check(`${family} : les hélices sont bien dans le bas du cadre`, bas === seeds, `${bas}/${seeds}`);
	}
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
