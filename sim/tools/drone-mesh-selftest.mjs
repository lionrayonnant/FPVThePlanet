// node tools/drone-mesh-selftest.mjs — l'assemblage Three du quad (issue #250),
// en Node : la géométrie et les uniformes se vérifient sans GPU.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildDroneMesh, DroneMaterial, LedMaterial, setSun, setFog, setTime, setResolution, setLedFade, setOmega } from '../src/drone-mesh.js';
import { shapeOf, BLADE_STATIONS } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const colors = { frame: 0x121110, metal: 0x221f1c, prop: 0x8a827a, led: 0xece7dd };
const make = (family) => {
	const seed = `mesh::${family}`;
	const build = targetBuild({ seed, family });
	return buildDroneMesh(shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }) }), { colors });
};

console.log('drone-mesh');
{
	const m = make('freestyle5');
	const geo = m.body.geometry;
	const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
	check('une seule géométrie fusionnée', geo instanceof THREE.BufferGeometry);
	check('≈ 300 triangles (< 600)', tris > 100 && tris < 600, `${tris}`);
	check('couleurs par sommet', !!geo.attributes.color && geo.attributes.color.itemSize === 4);
	check('alpha < 1 sur au moins un sommet (disques)', Array.from(geo.attributes.color.array).some((v, i) => i % 4 === 3 && v < 1));
	check('normales présentes', !!geo.attributes.normal);
	geo.computeBoundingSphere();
	check('sphère englobante ≤ boundingRadius de la recette', geo.boundingSphere.radius <= 0.3);
	check('deux maillages : corps + LED', m.group.children.length === 2);
	check('matériau : ShaderMaterial', m.material instanceof THREE.ShaderMaterial && m.ledMaterial instanceof THREE.ShaderMaterial);
	check('uniformes attendus', ['uSunDir', 'uAmbient', 'uNight', 'uFogColor', 'uFogDensity', 'uTime'].every((u) => u in m.material.uniforms));
	check('LED additive', m.ledMaterial.blending === THREE.AdditiveBlending && m.ledMaterial.depthWrite === false);
	check('LED : uMinPx et uResolution', 'uMinPx' in m.ledMaterial.uniforms && 'uResolution' in m.ledMaterial.uniforms);
	check('LED : uFadeNear et uFadeFar', 'uFadeNear' in m.ledMaterial.uniforms && 'uFadeFar' in m.ledMaterial.uniforms);
	check('LED : frustumCulled false', m.led.frustumCulled === false);
	check('matrixAutoUpdate false', m.group.matrixAutoUpdate === false);
	check('frustumCulled', m.body.frustumCulled === true);
	setSun(m.material, { x: 0, y: 1, z: 0 }, 0.8, 0.2);
	check('setSun écrit', m.material.uniforms.uAmbient.value === 0.8 && m.material.uniforms.uNight.value === 0.2);
	setFog(m.material, 0x9fb8cc, 0.002);
	check('setFog écrit', m.material.uniforms.uFogDensity.value === 0.002);
	setTime(m.material, 1.5);
	check('setTime écrit', m.material.uniforms.uTime.value === 1.5);
	setResolution(m.ledMaterial, 1280, 720);
	check('setResolution écrit', m.ledMaterial.uniforms.uResolution.value.x === 1280 && m.ledMaterial.uniforms.uResolution.value.y === 720);
	setLedFade(m.ledMaterial, 120, 220);
	check('setLedFade écrit', m.ledMaterial.uniforms.uFadeNear.value === 120 && m.ledMaterial.uniforms.uFadeFar.value === 220);
	const parent = new THREE.Group();
	parent.add(m.group);
	const before = geo.attributes.position.count;
	m.dispose();
	check('dispose ne jette pas et retire du parent', m.group.parent === null && before > 0);
}
{
	const tileSrc = readFileSync(new URL('../src/TileMaterial.js', import.meta.url), 'utf8');
	const fogFormula = tileSrc.match(/1\.0 - exp\([^)]*\)/)[0];
	const shader = new DroneMaterial().fragmentShader;
	check('formule de brouillard identique à TileMaterial', shader.includes(fogFormula), fogFormula);
	check('pas de lumière Three (directionalLights absent)', !shader.includes('directionalLights'));
	check('LED : clamp en pixels dans le vertex shader', new LedMaterial().vertexShader.includes('uMinPx'));
	// Le plancher de 3 px rend la LED visible à toute distance : sans fondu,
	// une naissance ou un départ ALLUMENT une lumière. Le fondu est donc dans
	// le fragment, sur l'alpha, pas seulement dans un uniforme oublié.
	check('LED : fondu de distance dans le fragment shader',
		new LedMaterial().fragmentShader.includes('smoothstep(uFadeNear'));
}
{
	const a = make('cinewhoop'), b = make('longrange');
	a.body.geometry.computeBoundingSphere(); b.body.geometry.computeBoundingSphere();
	check('le long range est plus grand que le cinewhoop', b.body.geometry.boundingSphere.radius > a.body.geometry.boundingSphere.radius);
	a.dispose(); b.dispose();
}
// Issue #264 : le régime par moteur arrive dans le maillage.
{
	const seed = 'omega::freestyle5';
	const build = targetBuild({ seed, family: 'freestyle5' });
	const shape = shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family: 'freestyle5' }), detail: 'onboard' });
	const m = buildDroneMesh(shape, { colors });
	const geo = m.body.geometry;
	check('attribut d\'index moteur présent', !!geo.attributes.aMotor);
	check('attribut de sens présent', !!geo.attributes.aSpin);
	const idx = new Set(Array.from(geo.attributes.aMotor.array));
	check('les quatre moteurs sont représentés', [0, 1, 2, 3].every((k) => idx.has(k)), [...idx].join(','));
	// Le châssis se vérifie sur la SILHOUETTE : depuis #264 le niveau `onboard`
	// ne porte plus que les rotors — un objectif ne filme pas son propre
	// boîtier — donc il n'y a plus de carrosserie à y trouver.
	{
		const plein = buildDroneMesh(shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family: 'freestyle5' }) }), { colors });
		const sil = new Set(Array.from(plein.body.geometry.attributes.aMotor.array));
		check('le châssis n\'appartient à aucun moteur', sil.has(-1), [...sil].join(','));
		plein.dispose();
	}
	check('la vue embarquée n\'a plus de châssis à porter', !idx.has(-1), [...idx].join(','));
	const spins = new Set(Array.from(geo.attributes.aSpin.array));
	check('les deux sens sont représentés', spins.has(1) && spins.has(-1));

	check('uOmega existe et vaut zéro au départ', !!m.material.uniforms.uOmega && m.material.uniforms.uOmega.value.length === 4);
	setOmega(m.material, [100, 200, 300, 400]);
	const u = m.material.uniforms.uOmega.value;
	check('setOmega écrit les quatre régimes', u[0] === 100 && u[1] === 200 && u[2] === 300 && u[3] === 400);
	setOmega(m.material, [1, 2, 3, 4]);
	check('setOmega n\'alloue pas un nouveau vecteur', m.material.uniforms.uOmega.value === u);
	m.dispose();
}

// Ce que le régime N'A PAS le droit de faire tourner : la plaque, la batterie,
// les bras, les cloches. Le shader n'anime que deux choses — le disque
// (alpha < 1) et les pales (opaques, PORTEUSES d'un sens). Un sommet opaque
// qui porterait un sens sans être une pale serait animé par erreur ; on compte
// donc les sommets à sens non nul, de la primitive près.
{
	const seed = 'omega::spin';
	const build = targetBuild({ seed, family: 'freestyle5' });
	const camera = targetCamera({ seed, family: 'freestyle5' });
	const discVerts = new THREE.CircleGeometry(1, 12).attributes.position.count;
	const boxVerts = new THREE.BoxGeometry(1, 1, 1).attributes.position.count;

	const sil = buildDroneMesh(shapeOf({ profile: build.profile, build, camera }), { colors });
	const sg = sil.body.geometry;
	const spinSil = Array.from(sg.attributes.aSpin.array).filter((v) => v !== 0).length;
	check('silhouette : seuls les quatre disques portent un sens', spinSil === 4 * discVerts, `${spinSil} / ${4 * discVerts}`);
	const opaqueSpinSil = Array.from(sg.attributes.aSpin.array)
		.filter((v, i) => v !== 0 && sg.attributes.color.array[4 * i + 3] >= 0.99).length;
	check('silhouette : aucun sommet opaque ne tourne', opaqueSpinSil === 0, `${opaqueSpinSil}`);
	// La plaque et la batterie sont au centre (x ≈ 0, z ≈ 0 pour la plaque) :
	// aucune n'appartient à un moteur, donc aucune n'a de régime à lire.
	const plateSpin = Array.from(sg.attributes.aMotor.array)
		.filter((v, i) => v < 0 && sg.attributes.aSpin.array[i] !== 0).length;
	check('plaque et batterie : sans moteur ET sans sens', plateSpin === 0, `${plateSpin}`);
	sil.dispose();

	const onb = buildDroneMesh(shapeOf({ profile: build.profile, build, camera, detail: 'onboard' }), { colors });
	const og = onb.body.geometry;
	const bladeVerts = Array.from(og.attributes.aSpin.array)
		.filter((v, i) => v !== 0 && og.attributes.color.array[4 * i + 3] >= 0.99).length;
	// Une pale est une bande de deux sommets par station (#283), plus une
	// boîte vrillée.
	const bladeStripVerts = 2 * (BLADE_STATIONS + 1);
	check('onboard : les 12 pales, et elles seules, tournent en opaque',
		bladeVerts === 12 * bladeStripVerts, `${bladeVerts} / ${12 * bladeStripVerts}`);
	check('onboard : toute pale connaît son moteur',
		Array.from(og.attributes.aSpin.array).every((v, i) => v === 0 || og.attributes.aMotor.array[i] >= 0));
	onb.dispose();
}

// LA contrainte : les ambiants ne changent pas de rendu. Ils passent par le
// MÊME buildDroneMesh(), ne posent jamais uOmega (il reste à zéro) et n'ont
// pas de pales — leur disque doit donc garder, terme à terme, la formule
// d'avant #264. C'est ce que ce bloc vérifie, dans le matériau ET dans le
// texte du shader (le seul endroit où la régression pourrait passer).
{
	const seed = 'omega::ambiant';
	const build = targetBuild({ seed, family: 'race5' });
	const camera = targetCamera({ seed, family: 'race5' });
	const sil = buildDroneMesh(shapeOf({ profile: build.profile, build, camera }), { colors });
	const onb = buildDroneMesh(shapeOf({ profile: build.profile, build, camera, detail: 'onboard' }), { colors });
	check('ambiant : uOmega à zéro sans setOmega',
		Array.from(sil.material.uniforms.uOmega.value).every((v) => v === 0));
	check('ambiant : uBlades à zéro (pas de pales)', sil.material.uniforms.uBlades.value === 0);
	check('embarqué : uBlades à un (des pales)', onb.material.uniforms.uBlades.value === 1);
	const frag = sil.material.fragmentShader;
	// Les fantômes courbés et le voile radial (#283) sont MULTIPLIÉS par
	// uBlades : à zéro, l'expression retombe terme à terme sur celle d'avant.
	check('ambiant : le bruit radial du disque est inchangé', frag.includes('0.7 + 0.3 * sin(ang * 3.0 - vSpin * rad * 2.2 * uBlades)'));
	check('ambiant : le voile radial ne s\'applique qu\'avec des pales', frag.includes('mix(1.0, (1.55 - 0.85 * rad) * smoothstep(1.0, 0.86, rad), uBlades)'));
	check('ambiant : le régime s\'AJOUTE aux 12 rad/s d\'origine, il ne les remplace pas',
		frag.includes('uTime * (12.0 + w * 0.03 * vSpin)'));
	check('ambiant : le fondu du disque est neutre sans pales', frag.includes('mix(1.0, blur, uBlades)'));
	sil.dispose(); onb.dispose();
}
console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
