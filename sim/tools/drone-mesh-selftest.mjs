// node tools/drone-mesh-selftest.mjs — l'assemblage Three du quad (issue #250),
// en Node : la géométrie et les uniformes se vérifient sans GPU.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildDroneMesh, DroneMaterial, LedMaterial, setSun, setFog, setTime, setResolution, setLedFade } from '../src/drone-mesh.js';
import { shapeOf } from '../src/drone-shape.js';
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
console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
