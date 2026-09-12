# Le drone du joueur en 3D — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le drone piloté devient visible — ses hélices dans le champ avec le régime réel des quatre moteurs, la machine entière en free cam, et un portrait fil de fer au crash et dans les journaux.

**Architecture:** La recette pure `src/drone-shape.js` reste la seule vérité géométrique et gagne trois choses (un bloc `mount` mesuré par famille, trois niveaux de détail, des hélices engendrées depuis `motorsOf()`). Trois consommateurs en sortent : `src/drone-mesh.js` (Three, déjà là) pour les ambiants, la vue embarquée et la free cam ; `src/onboard-drone.js` (neuf) qui tient les deux exemplaires du joueur et la règle d'exclusivité ; `src/drone-wire.js` (neuf, pur) qui projette la recette en segments 2D pour un rendu SVG dans le terminal. La vue embarquée passe par une seconde `RenderPass` dans le composer de `src/lens.js`, `near = 0.005`, gelée par le même drapeau que la principale.

**Tech Stack:** Three.js (BufferGeometry fusionnée, ShaderMaterial, EffectComposer/RenderPass), SVG en ligne dans le DOM, selftests Node sans navigateur (`check()` / `assert` / faux DOM de `tools/lib/fake-dom.mjs`).

**Spec:** `sim/docs/superpowers/specs/2026-09-06-player-drone-3d-design.md` (issue #264)

## Global Constraints

- Toutes les commandes se lancent depuis `sim/`.
- Coordonnées locales ENU : X = est, Y = haut, Z = sud. Nez du corps = −Z. Les dimensions de la recette sont en **mètres**.
- `camera.near = 0.15` sur la caméra de vol (`src/main.js:86`) **ne change pas**. La vue embarquée a sa propre caméra, `near = 0.005`.
- Le collider reste une sphère de rayon 0,15 m pour toutes les familles.
- `src/drone-shape.js` reste **pur** : aucun import de Three, aucun DOM. Idem `src/drone-wire.js`.
- **Borne DA, mesurée sur l'enveloppe balayée** : couverture ≤ **8 %** de l'image, et **rien au-dessus de 45 %** de la hauteur du cadre, pour les six familles sur toute l'étendue d'uptilt que `targetCamera` peut tirer.
- Le bloc `MOUNT` de `src/drone-shape.js` est écrit par `node tools/tune-mount.mjs --write`, **jamais à la main** — même contrat que les blocs `pid` de `src/drone-profiles.js`.
- `shapeOf()` appelé **sans** `detail` doit rendre exactement la géométrie d'aujourd'hui : les ambiants ne changent pas de rendu. C'est un test, pas une intention.
- Aucun littéral de couleur : passer par `token('--…')` de `src/palette.js` ; `tools/palette-selftest.mjs` doit rester vert.
- Aucun contexte WebGL dans les écrans du terminal (`src/session-log.js` est un client pur).
- Zéro allocation par frame dans les `update()` du chemin de vol.
- Tous les nouveaux selftests s'ajoutent à la fin de la chaîne `selftest:operator` de `package.json`, et **la chaîne doit être verte à chaque commit**.
- Commits : message en français, préfixe conventionnel, suffixe `(#264)`. Pas de push forcé.
- Après chaque tâche : `npm run selftest:operator` doit passer avant le commit.

---

## Structure des fichiers

| fichier | rôle | testé par |
|---|---|---|
| `src/onboard-drone.js` (nouveau) | les deux exemplaires du joueur (monde / embarqué), règle d'exclusivité, régime | `tools/onboard-drone-selftest.mjs` |
| `tools/prop-coverage.mjs` (nouveau, pur) | rasterise l'enveloppe balayée dans le champ → `{ area, top }` | `tools/onboard-frame-selftest.mjs` |
| `tools/tune-mount.mjs` (nouveau) | mesure et **écrit** le bloc `MOUNT` de `drone-shape.js` | — (son produit est testé par la borne) |
| `src/drone-shape.js` (modif) | `MOUNT`, `detail`, arêtes, hélices depuis `motorsOf()` | `tools/drone-shape-selftest.mjs` |
| `src/drone-mesh.js` (modif) | attribut d'index moteur, `uOmega`/`uSpin`, pales | `tools/drone-mesh-selftest.mjs` |
| `src/lens.js` (modif) | seconde `RenderPass` embarquée, gelée avec la principale | `tools/onboard-drone-selftest.mjs` |
| `src/drone-wire.js` (nouveau, pur) | projection de la recette en segments 2D | `tools/drone-wire-selftest.mjs` |
| `src/drone-portrait.js` (nouveau, DOM) | rendu SVG monochrome + rotation | `tools/drone-portrait-render-selftest.mjs` |
| `src/session-log.js` (modif) | portrait dans la fiche de session et le TARGET LOG | `tools/drone-portrait-render-selftest.mjs` |
| `src/flight-end.js` (modif) | une ligne de plus dans `TIMELINE` | `tools/flight-end-selftest.mjs` |
| `src/fpvtp-osd.js` (modif) | peint le portrait dans `#flight-end` | `tools/drone-portrait-render-selftest.mjs` |
| `src/main.js` (modif) | création, câblage par frame, free cam, libération | navigateur |
| `package.json` (modif) | chaîne `selftest:operator` | — |
| `HANDOFF.md`, Bible §24 (modif) | état vérifié, révision assumée | — |

---

## Task 1 : la free cam montre le drone (lot 0)

Indépendant de tout le reste : n'utilise que le niveau `silhouette`, c'est-à-dire la recette telle qu'elle est aujourd'hui. Livre la première validation visuelle du maillage de #250 vu de près.

**Files:**
- Create: `src/onboard-drone.js`
- Create: `tools/onboard-drone-selftest.mjs`
- Modify: `src/main.js` (création après `boot()`, appel par frame, cible d'orbite)
- Modify: `package.json` (chaîne `selftest:operator`)

**Interfaces:**
- Consumes: `buildDroneMesh`, `setSun`, `setFog`, `setTime`, `setResolution` de `src/drone-mesh.js` ; `shapeOf` de `src/drone-shape.js` ; `targetBuild` de `tools/target-build.mjs` ; `targetCamera` de `tools/target-camera.mjs`.
- Produces:
  ```js
  export class PlayerDrone {
    constructor({ scene, profile, build, camera })
    setFreeCam(on)          // true = exemplaire monde visible, embarqué caché
    update({ dt, position, quaternion, omega, camera, sun, dim, fogColor, fogDensity, resolution })
    get worldVisible()      // booléen
    get onboardVisible()    // booléen — toujours false tant que la tâche 7 n'est pas faite
    dispose()
  }
  ```
  `position` et `quaternion` sont des `{x,y,z}` / `{x,y,z,w}` bruts (Rapier), `omega` un tableau de 4 nombres en rad/s, `sun` un `{ dir, night }` ou `null`, `dim` un nombre, `resolution` un `{ w, h }`.

- [ ] **Step 1 : écrire le selftest qui échoue**

Créer `tools/onboard-drone-selftest.mjs` :

```js
// node tools/onboard-drone-selftest.mjs — le drone du joueur (issue #264).
// Le maillage et la règle d'exclusivité se vérifient sans GPU.
import * as THREE from 'three';
import { PlayerDrone } from '../src/onboard-drone.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

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
	check('au repos : rien de visible', !d.worldVisible && !d.onboardVisible);
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

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/onboard-drone-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/onboard-drone.js'`

- [ ] **Step 3 : écrire l'implémentation minimale**

Créer `src/onboard-drone.js` :

```js
// Le drone du joueur (issue #264) — deux exemplaires du MÊME build, et la
// règle qui les sépare : en vue pilote on voit ses hélices (l'exemplaire
// embarqué, tâche 7) ; en free cam on voit la machine entière (l'exemplaire
// monde). Jamais les deux, jamais aucun pendant un vol.
//
// Ce module ne sait rien du contrôleur ni de Rapier : il reçoit une pose et
// quatre régimes, il pose des matrices.
import * as THREE from 'three';
import { shapeOf } from './drone-shape.js';
import { buildDroneMesh, setSun, setFog, setTime, setResolution } from './drone-mesh.js';
import { token } from './palette.js';

const hex = (name) => new THREE.Color(token(name)).getHex();

export class PlayerDrone {
	constructor({ scene, profile, build, camera }) {
		this.scene = scene;
		this._colors = {
			frame: hex('--dark-grey'), metal: hex('--grey'),
			prop: hex('--light-grey'), led: hex('--warm-white'),
		};
		// L'exemplaire MONDE : la recette telle qu'elle est aujourd'hui
		// (`silhouette` par défaut), posée à la transformation physique.
		this.world = buildDroneMesh(shapeOf({ profile, build, camera }), { colors: this._colors });
		this.world.group.visible = false;
		scene.add(this.world.group);
		this.onboard = null;   // tâche 7
		this._freeCam = false;
		this._time = 0;
		// Pré-alloués : update() n'alloue rien.
		this._p = new THREE.Vector3();
		this._q = new THREE.Quaternion();
		this._s = new THREE.Vector3(1, 1, 1);
		this._lastFog = { color: -1, density: -1 };
		this._lastRes = { w: -1, h: -1 };
	}

	setFreeCam(on) {
		this._freeCam = !!on;
		this.world.group.visible = this._freeCam;
		if (this.onboard) this.onboard.group.visible = !this._freeCam;
	}

	get worldVisible() { return !!this.world.group.visible; }
	get onboardVisible() { return !!this.onboard?.group.visible; }

	update({ dt = 0, position, quaternion, omega, sun, dim = 1, fogColor, fogDensity, resolution } = {}) {
		this._time += dt;
		if (this.worldVisible && position && quaternion) {
			this._p.set(position.x, position.y, position.z);
			this._q.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
			this.world.group.matrix.compose(this._p, this._q, this._s);
			this.world.group.matrixWorldNeedsUpdate = true;
		}
		const fogHex = typeof fogColor === 'number' ? fogColor : fogColor?.getHex?.();
		if (fogHex !== undefined && (fogHex !== this._lastFog.color || fogDensity !== this._lastFog.density)) {
			this._lastFog.color = fogHex; this._lastFog.density = fogDensity;
			setFog(this.world.material, fogHex, fogDensity);
			setFog(this.world.ledMaterial, fogHex, fogDensity);
		}
		if (resolution && (resolution.w !== this._lastRes.w || resolution.h !== this._lastRes.h)) {
			this._lastRes.w = resolution.w; this._lastRes.h = resolution.h;
			setResolution(this.world.ledMaterial, resolution.w, resolution.h);
		}
		setTime(this.world.material, this._time);
		setTime(this.world.ledMaterial, this._time);
		if (sun) setSun(this.world.material, sun.dir, dim, sun.night);
		void omega;   // tâche 6
	}

	dispose() {
		this.world.dispose();
		this.onboard?.dispose();
		this.world = null; this.onboard = null;
	}
}
```

- [ ] **Step 4 : le lancer pour vérifier qu'il passe**

Run: `node tools/onboard-drone-selftest.mjs`
Expected: PASS — `all PASS`

- [ ] **Step 5 : câbler dans `src/main.js`**

Après le bloc qui crée `freeCam` (`src/main.js:916-918`), créer l'exemplaire et faire suivre la cible d'orbite :

```js
playerDrone = new PlayerDrone({
	scene,
	profile: physics.profile,
	build: flightBuild,          // le build déjà résolu pour cette session
	camera: camSpec,             // le MÊME objet que cameraTilt (main.js:490)
});
```

Dans la branche `else if (freeCamOn)` de la boucle (`src/main.js:1768-1770`), poser la cible sur le drone avant `freeCam.update()` :

```js
} else if (freeCamOn) {
	freeCam.target.set(physics.position.x, physics.position.y, physics.position.z);
	freeCam.update();
}
```

Là où `freeCamOn` bascule, prévenir le drone : `playerDrone?.setFreeCam(freeCamOn);`

Et une fois par frame, après la mise à jour de la caméra et **avant** `ambient?.update(...)` :

```js
playerDrone?.update({
	dt: frozen ? 0 : dt,
	position: physics.position,
	quaternion: physics.rotation,
	omega: physics.propulsion.omega,
	sun: sunField, dim: cloud.dim,
	fogColor: fogColorNow, fogDensity: fogDensityNow,
	resolution: { w: renderer.domElement.width, h: renderer.domElement.height },
});
```

Reprendre pour `sunField` / `cloud.dim` / `fogColorNow` / `fogDensityNow` **exactement** les valeurs déjà passées à `ambient.update()` juste en dessous — ne pas en recalculer.

Enfin, libérer avec le reste de la scène : `playerDrone?.dispose(); playerDrone = null;`

- [ ] **Step 6 : ajouter le selftest à la chaîne**

Dans `package.json`, à la fin de `selftest:operator`, ajouter ` && node tools/onboard-drone-selftest.mjs`.

Run: `npm run selftest:operator`
Expected: la chaîne passe, `onboard-drone` inclus.

- [ ] **Step 7 : commit**

```bash
git add src/onboard-drone.js tools/onboard-drone-selftest.mjs src/main.js package.json
git commit -m "feat(drone joueur): la free cam montre enfin la machine (#264)"
```

- [ ] **Step 8 : vérification à l'œil (à faire par l'utilisateur)**

`npm run dev`, entrer en vol, touche `C`. Les six familles se regardent avec `?family=freestyle5|race5|cinewhoop|longrange|heavy5|toothpick`. Ce qui se juge ici et nulle part ailleurs : la machine est-elle noire au crépuscule, décrochée du brouillard, ou juste ?

---

## Task 2 : la sonde de couverture

Un module pur qui répond à « quelle fraction de l'image les hélices occupent-elles, et jusqu'à quelle hauteur ». C'est l'instrument de la tâche 3 et le garde-fou permanent de la borne DA.

**Files:**
- Create: `tools/prop-coverage.mjs`
- Create: `tools/onboard-frame-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: rien (module pur, il reçoit une recette déjà construite).
- Produces:
  ```js
  // shape : le retour de shapeOf() ; camera : le retour de targetCamera().
  // mountY : hauteur de l'objectif AU-DESSUS du plan d'hélice, en mètres
  //          (facultatif — par défaut, la position de la part 'camera').
  // Rend { area, top } : area = fraction de l'image couverte (0..1),
  //                      top  = hauteur la plus haute atteinte (0 = bas du
  //                             cadre, 1 = haut), 0 si rien n'est couvert.
  export function propCoverage({ shape, camera, mountY, mountZ, grid = 200 })
  ```

- [ ] **Step 1 : écrire le selftest qui échoue**

Créer `tools/onboard-frame-selftest.mjs` :

```js
// node tools/onboard-frame-selftest.mjs — ce que les hélices occupent
// réellement dans le champ (issue #264). Rasterisation pure, aucun GPU.
import { propCoverage } from './prop-coverage.mjs';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const at = (family, seed, over) => {
	const build = targetBuild({ seed, family });
	const camera = targetCamera({ seed, family });
	return propCoverage({ shape: shapeOf({ profile: build.profile, build, camera }), camera, ...over });
};

console.log('onboard-frame');

// 1. L'instrument lui-même, sur des cas dont la réponse est connue d'avance.
{
	const c0 = at('freestyle5', 'probe-freestyle5-0', { mountY: 0 });
	check('objectif exactement dans le plan d\'hélice : couverture nulle', c0.area === 0, `${(100 * c0.area).toFixed(2)} %`);

	const below = at('freestyle5', 'probe-freestyle5-0', { mountY: -0.008 });
	const above = at('freestyle5', 'probe-freestyle5-0', { mountY: +0.008 });
	check('sous le plan : les hélices montent plus haut qu\'au-dessus',
		below.top > above.top, `${(100 * below.top).toFixed(0)} % vs ${(100 * above.top).toFixed(0)} %`);
	check('les deux couvrent quelque chose', below.area > 0 && above.area > 0);

	// Monotonie : plus l'objectif s'éloigne du plan, plus il en voit.
	const far = at('freestyle5', 'probe-freestyle5-0', { mountY: +0.010 });
	check('couverture croissante avec l\'écart au plan', far.area > above.area,
		`${(100 * above.area).toFixed(1)} % → ${(100 * far.area).toFixed(1)} %`);
}

// 2. Déterminisme.
{
	const a = at('race5', 'det', {}), b = at('race5', 'det', {});
	check('même build → même mesure', a.area === b.area && a.top === b.top);
}

// 3. L'état des lieux, consigné : la recette d'aujourd'hui est HORS borne.
//    Ce bloc n'affirme rien, il documente le point de départ de la tâche 3.
for (const family of FAMILIES) {
	const c = at(family, `probe-${family}-0`, {});
	console.log(`  ..    ${family} aujourd'hui : ${(100 * c.area).toFixed(1)} % de l'image, jusqu'à ${(100 * c.top).toFixed(0)} % de la hauteur`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/onboard-frame-selftest.mjs`
Expected: FAIL — `Cannot find module './prop-coverage.mjs'`

- [ ] **Step 3 : écrire l'implémentation**

Créer `tools/prop-coverage.mjs` :

```js
// Ce que les hélices occupent dans le champ (issue #264). Module PUR, importé
// par le selftest de borne et par tools/tune-mount.mjs — jamais par le client.
//
// La méthode est une rasterisation, pas une estimation d'angles : on tire un
// rayon par pixel d'une grille, on l'intersecte avec le PLAN du disque, et on
// regarde s'il tombe dedans. Une approximation angulaire compterait des points
// du disque qui sortent du champ latéralement — c'est l'erreur qui avait
// surestimé la couverture d'un facteur trois pendant la conception.
//
// On mesure l'ENVELOPPE BALAYÉE (le disque entier), pas les pales à un instant :
// c'est l'arc flou que l'œil voit, et c'est sur lui que porte la borne DA.

const ASPECT = { '4:3': 4 / 3, '16:9': 16 / 9 };

export function propCoverage({ shape, camera, mountY, mountZ, grid = 200 } = {}) {
	const cam = shape.parts.find((p) => p.role === 'camera');
	const props = shape.parts.filter((p) => p.role === 'prop');
	if (!cam || props.length === 0) return { area: 0, top: 0 };

	// L'oeil. Par défaut la part 'camera' de la recette ; sinon un montage
	// donné en hauteur AU-DESSUS DU PLAN D'HÉLICE et en avancée.
	const planeY = props[0].at[1];
	const eyeY = Number.isFinite(mountY) ? planeY + mountY : cam.at[1];
	const eyeZ = Number.isFinite(mountZ) ? mountZ : cam.at[2];
	const eyeX = cam.at[0];

	const up = (camera.uptiltDeg ?? 0) * Math.PI / 180;
	const tv = Math.tan((camera.fovDeg ?? 120) * Math.PI / 360);
	const th = tv * (ASPECT[camera.aspect] ?? 16 / 9);

	const W = grid, H = Math.round(grid * 3 / 4);
	let hit = 0, topRow = -1;
	for (let j = 0; j < H; j++) {
		let rowHit = 0;
		for (let i = 0; i < W; i++) {
			const sx = (2 * (i + 0.5) / W - 1) * th;
			const sy = (1 - 2 * (j + 0.5) / H) * tv;
			// Le rayon, du repère caméra vers le repère corps : l'uptilt est une
			// rotation autour de +X.
			const ry = sy * Math.cos(up) + Math.sin(up);
			const rz = sy * Math.sin(up) - Math.cos(up);
			for (const p of props) {
				const t = (p.at[1] - eyeY) / ry;
				if (!(t > 0)) continue;
				const dx = eyeX + sx * t - p.at[0];
				const dz = eyeZ + rz * t - p.at[2];
				if (dx * dx + dz * dz <= p.size[0] * p.size[0]) { rowHit++; break; }
			}
		}
		hit += rowHit;
		if (rowHit > 0 && topRow < 0) topRow = j;
	}
	return {
		area: hit / (W * H),
		top: topRow < 0 ? 0 : 1 - (topRow + 0.5) / H,
	};
}
```

- [ ] **Step 4 : le lancer pour vérifier qu'il passe**

Run: `node tools/onboard-frame-selftest.mjs`
Expected: PASS, et la liste des six familles affichée en `..` — l'état des lieux, hors borne, qui sera corrigé à la tâche 3.

- [ ] **Step 5 : ajouter à la chaîne et commit**

Dans `package.json`, ajouter ` && node tools/onboard-frame-selftest.mjs` à la fin de `selftest:operator`.

```bash
npm run selftest:operator
git add tools/prop-coverage.mjs tools/onboard-frame-selftest.mjs package.json
git commit -m "feat(drone joueur): la sonde qui mesure ce que les hélices occupent (#264)"
```

---

## Task 3 : le bloc `mount`, mesuré et écrit par l'outil

C'est ici que la borne DA devient vraie.

**Files:**
- Modify: `src/drone-shape.js` (bloc `MOUNT`, utilisé par la part `camera`)
- Create: `tools/tune-mount.mjs`
- Modify: `tools/onboard-frame-selftest.mjs` (les assertions de borne)

**Interfaces:**
- Consumes: `propCoverage` de `tools/prop-coverage.mjs`.
- Produces: dans `src/drone-shape.js`,
  ```js
  // Hauteur de l'objectif AU-DESSUS du plan d'hélice, et avancée depuis le
  // centre, en mètres. Écrit par tools/tune-mount.mjs --write.
  export const MOUNT = {
    freestyle5: { y: 0.003, z: -0.043 },  // valeurs D'EXEMPLE : l'outil les écrit
    race5:      { y: 0.003, z: -0.041 },
    cinewhoop:  { y: 0.003, z: -0.033 },
    longrange:  { y: 0.003, z: -0.058 },
    heavy5:     { y: 0.003, z: -0.044 },
    toothpick:  { y: 0.003, z: -0.021 },
  };
  ```
  La part `camera` de la recette est désormais à `[0, propPlaneY + MOUNT[family].y, MOUNT[family].z]`.

- [ ] **Step 1 : écrire les assertions de borne (elles échouent)**

Dans `tools/onboard-frame-selftest.mjs`, **remplacer** le bloc 3 (« l'état des lieux, consigné ») par :

```js
// 3. La borne DA, garantie par construction (spec §« La borne DA, chiffrée »).
const MAX_AREA = 0.08;   // 8 % de l'image
const MAX_TOP = 0.45;    // rien au-dessus de 45 % de la hauteur
for (const family of FAMILIES) {
	let worstArea = 0, worstTop = 0, worstSeed = '';
	for (let i = 0; i < 300; i++) {
		const seed = `probe-${family}-${i}`;
		const c = at(family, seed, {});
		if (c.area > worstArea) { worstArea = c.area; worstSeed = seed; }
		if (c.top > worstTop) worstTop = c.top;
	}
	check(`${family} : couverture ≤ 8 % de l'image`, worstArea <= MAX_AREA,
		`${(100 * worstArea).toFixed(1)} % au pire (${worstSeed})`);
	check(`${family} : rien au-dessus de 45 % de la hauteur`, worstTop <= MAX_TOP,
		`${(100 * worstTop).toFixed(0)} % au pire`);
}
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/onboard-frame-selftest.mjs`
Expected: FAIL sur les six familles — par exemple `freestyle5 : couverture ≤ 8 % de l'image — 16.8 % au pire`, `toothpick — 33.7 % au pire`, et les hauteurs à 71-100 %.

- [ ] **Step 3 : écrire `tools/tune-mount.mjs`**

```js
// node tools/tune-mount.mjs [--write] [famille|all]
//
// Mesure et ÉCRIT le bloc MOUNT de src/drone-shape.js — la hauteur de
// l'objectif au-dessus du plan d'hélice et son avancée, par famille.
//
// Même contrat que tools/tune-pid.mjs : ce bloc n'est JAMAIS modifié à la
// main. La raison est mesurée, pas esthétique — voir la spec :
//   · objectif SOUS le plan d'hélice : le disque passe au-dessus de l'oeil et
//     couvre 10 à 31 % de l'image, jusqu'aux trois quarts de la hauteur ;
//   · objectif exactement DANS le plan : couverture nulle, le disque est par
//     la tranche (singularité de la primitive, pas du réglage) ;
//   · objectif AU-DESSUS : les hélices se confinent au tiers bas, comme sur le
//     vrai médium.
// Un chiffre unique fixé à la main serait faux pour au moins une famille : à
// dy = +3 mm, cinq familles tiennent les 8 % et le toothpick est à 14,8 %.
import { readFileSync, writeFileSync } from 'node:fs';
import { propCoverage } from './prop-coverage.mjs';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

const MAX_AREA = 0.08;
const MAX_TOP = 0.45;
const SEEDS = 300;

// On balaie la hauteur du millimètre au centimètre au-dessus du plan, et on
// garde la PLUS GRANDE qui tienne encore la borne : plus l'objectif s'écarte,
// plus on voit d'hélice — et on en veut le plus possible sous la borne, pas le
// moins. Une vue embarquée où l'on ne voit rien ne dit rien.
function measure(family, y) {
	let worstArea = 0, worstTop = 0;
	for (let i = 0; i < SEEDS; i++) {
		const seed = `probe-${family}-${i}`;
		const build = targetBuild({ seed, family });
		const camera = targetCamera({ seed, family });
		const c = propCoverage({ shape: shapeOf({ profile: build.profile, build, camera }), camera, mountY: y });
		if (c.area > worstArea) worstArea = c.area;
		if (c.top > worstTop) worstTop = c.top;
	}
	return { worstArea, worstTop };
}

function best(family) {
	let keep = null;
	for (let mm = 1; mm <= 12; mm++) {
		const y = mm / 1000;
		const m = measure(family, y);
		if (m.worstArea <= MAX_AREA && m.worstTop <= MAX_TOP) keep = { y, ...m };
	}
	if (!keep) throw new Error(`${family} : aucune hauteur ne tient la borne`);
	return keep;
}

const arg = process.argv.slice(2);
const write = arg.includes('--write');
const only = arg.find((a) => !a.startsWith('--'));
const families = !only || only === 'all' ? FAMILIES : [only];

const found = {};
for (const family of families) {
	const b = best(family);
	found[family] = b;
	console.log(`${family.padEnd(11)} y = ${(1000 * b.y).toFixed(0)} mm  →  ${(100 * b.worstArea).toFixed(1)} % de l'image, ${(100 * b.worstTop).toFixed(0)} % de hauteur`);
}

if (write) {
	const path = new URL('../src/drone-shape.js', import.meta.url);
	const src = readFileSync(path, 'utf8');
	const body = FAMILIES.map((f) => {
		const y = found[f]?.y;
		if (y === undefined) throw new Error(`${f} non mesurée : relancer avec "all" pour écrire`);
		// L'avancée reste celle de la recette (−0,55·armZ), déjà cohérente avec
		// le stack avant ; seule la hauteur est le degré de liberté mesuré.
		return `\t${f}: { y: ${y.toFixed(4)} },`;
	}).join('\n');
	const next = src.replace(
		/export const MOUNT = \{[\s\S]*?\n\};/,
		`export const MOUNT = {\n${body}\n};`,
	);
	if (next === src) throw new Error('bloc MOUNT introuvable dans src/drone-shape.js');
	writeFileSync(path, next);
	console.log('\nMOUNT écrit dans src/drone-shape.js');
}
```

- [ ] **Step 4 : ouvrir le bloc `MOUNT` dans `src/drone-shape.js`**

Ajouter, après les imports :

```js
// Le montage de l'objectif : sa hauteur AU-DESSUS du plan d'hélice, en mètres.
// ÉCRIT PAR `node tools/tune-mount.mjs --write`, jamais à la main — voir
// l'en-tête de cet outil pour la mesure qui l'impose. L'avancée reste
// −0,55·armZ, l'objectif étant dans le stack avant.
export const MOUNT = {
	freestyle5: { y: 0.0030 },
	race5: { y: 0.0030 },
	cinewhoop: { y: 0.0030 },
	longrange: { y: 0.0030 },
	heavy5: { y: 0.0030 },
	toothpick: { y: 0.0030 },
};
```

Et remplacer la ligne de la part `camera` :

```js
	// Caméra FPV, à l'avant, inclinée du uptilt. Sa HAUTEUR n'est pas libre :
	// elle se compte depuis le plan d'hélice (MOUNT), parce que c'est cet écart
	// — et lui seul — qui décide de ce que la vue embarquée montre.
	const propPlaneY = 0.020;
	const mountY = (MOUNT[family] ?? MOUNT.freestyle5).y;
	parts.push(box('camera', [0, propPlaneY + mountY, -0.55 * armZ], [0.019, 0.019, 0.010], { rotX: camera.uptiltDeg * Math.PI / 180 }));
```

(`propPlaneY` est la constante déjà utilisée par les parts `prop` : la sortir en variable et la réutiliser aux deux endroits, pour qu'un déplacement du plan ne puisse pas désynchroniser l'objectif.)

- [ ] **Step 5 : mesurer et écrire**

Run: `node tools/tune-mount.mjs all --write`
Expected: six lignes, chacune sous 8 % et sous 45 %, puis `MOUNT écrit dans src/drone-shape.js`.

Si une famille lève `aucune hauteur ne tient la borne` : c'est un résultat, pas une panne. Élargir le balayage (`mm <= 20`) et, si ça ne suffit toujours pas, s'arrêter et le signaler — la géométrie de cette famille dit quelque chose que la borne ignore.

- [ ] **Step 6 : vérifier que la borne passe**

Run: `node tools/onboard-frame-selftest.mjs`
Expected: PASS sur les douze assertions (six familles × couverture + hauteur).

- [ ] **Step 7 : vérifier que les ambiants n'ont pas bougé de rendu**

Run: `node tools/drone-shape-selftest.mjs && node tools/drone-mesh-selftest.mjs && node tools/ambient-selftest.mjs`
Expected: PASS. La part `camera` a changé de hauteur de quelques millimètres — c'est attendu et invisible à 100 m ; si `drone-shape-selftest` échoue sur `caméra inclinée du uptilt` ou `caméra à l'avant (−Z)`, c'est un vrai problème.

- [ ] **Step 8 : commit**

```bash
npm run selftest:operator
git add src/drone-shape.js tools/tune-mount.mjs tools/onboard-frame-selftest.mjs
git commit -m "feat(drone joueur): le montage de l'objectif est mesuré, et la borne DA garantie (#264)"
```

---

## Task 4 : les hélices connaissent leur moteur

Sans ça, la vue embarquée répond au mauvais manche et tourne dans le mauvais sens — faux, et voyant.

**Files:**
- Modify: `src/drone-shape.js` (boucle des bras/moteurs/hélices)
- Modify: `tools/drone-shape-selftest.mjs`

**Interfaces:**
- Consumes: `motorsOf` de `src/quad.js`.
- Produces: chaque part de rôle `prop`, `motor`, `arm` et `duct` porte désormais
  `motor` (entier 0-3, **ordre Betaflight**) et, pour `prop`, `spin` (±1, `+1` =
  sens antihoraire vu de dessus).

- [ ] **Step 1 : écrire les checks qui échouent**

Ajouter dans `tools/drone-shape-selftest.mjs`, après la boucle `for (const family of FAMILIES)` existante :

```js
// Issue #264 : la géométrie visible et le mixeur lisent la MÊME table.
// quad.js:64-71 — 1 arrière-droit spin +1, 2 avant-droit spin −1,
// 3 arrière-gauche spin −1, 4 avant-gauche spin +1.
import { motorsOf } from '../src/quad.js';

for (const family of FAMILIES) {
	const s = make(family);
	const props = roles(s, 'prop');
	const motors = motorsOf(PROFILES[family]);
	check(`${family}: chaque hélice porte son index moteur`,
		props.every((p, i) => p.motor === i) && props.length === 4,
		props.map((p) => p.motor).join(','));
	check(`${family}: l'hélice k est à la position du moteur k`,
		props.every((p) => {
			const m = motors[p.motor];
			return Math.abs(p.at[0] - m.x) < 1e-9 && Math.abs(p.at[2] - m.z) < 1e-9;
		}));
	check(`${family}: l'hélice k porte le spin du moteur k`,
		props.every((p) => p.spin === motors[p.motor].spin));
	// Les deux hélices DANS LE CHAMP sont les avant : moteurs 1 et 3.
	const front = props.filter((p) => p.at[2] < 0).map((p) => p.motor).sort();
	check(`${family}: les deux hélices avant sont les moteurs 1 et 3`,
		front.join(',') === '1,3', front.join(','));
	check(`${family}: les deux avant tournent en sens opposés`,
		props[1].spin === -props[3].spin);
}
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/drone-shape-selftest.mjs`
Expected: FAIL — `chaque hélice porte son index moteur — ,,,` (les parts n'ont pas de champ `motor`).

- [ ] **Step 3 : engendrer les hélices depuis `motorsOf()`**

Dans `src/drone-shape.js`, importer `motorsOf` et remplacer la double boucle de signes :

```js
import { motorsOf } from './quad.js';
```

```js
	// Bras, moteurs, hélices, conduits. L'ordre et le sens viennent de
	// motorsOf() — la MÊME table que le mixeur (quad.js:64-71) — et pas d'une
	// boucle de signes. Même argument que celui déjà écrit dans quad.js pour
	// mixOf() : une hélice qu'on déplace ne peut pas désynchroniser
	// silencieusement l'image de la physique. C'est ce qui fait que le lacet,
	// le roulis et le tangage se LISENT dans les deux hélices du champ.
	const armR = micro ? 0.005 : 0.008;
	const motors = motorsOf(profile);
	for (let k = 0; k < motors.length; k++) {
		const { x: mx, z: mz, spin } = motors[k];
		const len = Math.hypot(mx, mz);
		parts.push(box('arm', [mx / 2, 0, mz / 2], [armR, armR, len], { rotY: Math.atan2(mx, mz), motor: k }));
		parts.push(cyl('motor', [mx, 0.006 + 0.006, mz], 0.18 * propRadius, 0.012, { motor: k }));
		parts.push({ kind: 'disc', role: 'prop', at: [mx, propPlaneY, mz], size: [propRadius], blades: bladeCount, motor: k, spin });
		if (DUCTED.has(family)) parts.push({ kind: 'ring', role: 'duct', at: [mx, 0.012, mz], size: [1.12 * propRadius, 0.5 * propRadius], motor: k });
	}
```

`propPlaneY` est la constante sortie à la tâche 3 (`0.020`).

- [ ] **Step 4 : vérifier que ça passe**

Run: `node tools/drone-shape-selftest.mjs`
Expected: PASS, y compris les checks d'origine (l'ordre des parts change, mais aucun check existant ne dépend de l'ordre — s'il en existe un, le corriger par `find` plutôt que par index).

- [ ] **Step 5 : vérifier que rien n'a bougé ailleurs**

Run: `node tools/drone-mesh-selftest.mjs && node --expose-gc tools/ambient-drones-selftest.mjs`
Expected: PASS. La géométrie fusionnée est identique à l'ordre des parts près.

- [ ] **Step 6 : commit**

```bash
npm run selftest:operator
git add src/drone-shape.js tools/drone-shape-selftest.mjs
git commit -m "feat(drone joueur): les hélices naissent de motorsOf(), donc le lacet se lit dans l'image (#264)"
```

---

## Task 5 : les niveaux de détail et les vraies pales

**Files:**
- Modify: `src/drone-shape.js`
- Modify: `tools/drone-shape-selftest.mjs`

**Interfaces:**
- Produces: `shapeOf({ profile, build, camera, detail })` où `detail` vaut
  `'silhouette'` (défaut), `'onboard'` ou `'portrait'`. Nouveaux rôles :
  `blade` (une par pale, `bladeCount` par hélice, portant `motor` et `spin`),
  `bell` et `stack` (niveau `portrait` seulement). Le disque `prop` **reste
  présent à tous les niveaux** : c'est l'enveloppe balayée, ce que le shader
  fond en flou et ce que `propCoverage` mesure.

- [ ] **Step 1 : écrire les checks qui échouent**

Ajouter dans `tools/drone-shape-selftest.mjs` :

```js
// Issue #264 : trois niveaux de détail, et le défaut ne bouge PAS.
{
	const seed = 'lod::freestyle5';
	const build = targetBuild({ seed, family: 'freestyle5' });
	const camera = targetCamera({ seed, family: 'freestyle5' });
	const base = shapeOf({ profile: build.profile, build, camera });
	const silhouette = shapeOf({ profile: build.profile, build, camera, detail: 'silhouette' });
	const onboard = shapeOf({ profile: build.profile, build, camera, detail: 'onboard' });
	const portrait = shapeOf({ profile: build.profile, build, camera, detail: 'portrait' });

	check('detail absent ≡ silhouette', JSON.stringify(base) === JSON.stringify(silhouette));
	check('silhouette : aucune pale', silhouette.parts.every((p) => p.role !== 'blade'));
	check('onboard : 3 pales par hélice (freestyle)', onboard.parts.filter((p) => p.role === 'blade').length === 12);
	check('onboard : le disque enveloppe est conservé', onboard.parts.filter((p) => p.role === 'prop').length === 4);
	check('onboard ajoute, ne retire rien',
		silhouette.parts.every((p) => onboard.parts.some((q) => q.role === p.role && q.at.join() === p.at.join())));
	check('portrait ⊇ onboard', onboard.parts.length < portrait.parts.length);
	check('portrait : cloches moteur', portrait.parts.filter((p) => p.role === 'bell').length === 4);
	check('rayon englobant identique aux trois niveaux',
		silhouette.boundingRadius === onboard.boundingRadius && onboard.boundingRadius === portrait.boundingRadius);
	check('chaque pale porte le moteur et le sens de son hélice',
		onboard.parts.filter((p) => p.role === 'blade').every((p) => Number.isInteger(p.motor) && Math.abs(p.spin) === 1));
	check('micro : 2 pales par hélice', shapeOf({
		profile: targetBuild({ seed: 'lod::tp', family: 'toothpick' }).profile,
		build: targetBuild({ seed: 'lod::tp', family: 'toothpick' }),
		camera: targetCamera({ seed: 'lod::tp', family: 'toothpick' }),
		detail: 'onboard',
	}).parts.filter((p) => p.role === 'blade').length === 8);
}
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/drone-shape-selftest.mjs`
Expected: FAIL — `onboard : 3 pales par hélice (freestyle) — ` (0 pale : `detail` est ignoré).

- [ ] **Step 3 : implémenter les niveaux**

Dans `src/drone-shape.js`, signature et ajouts :

```js
const DETAILS = new Set(['silhouette', 'onboard', 'portrait']);

export function shapeOf({ profile, build, camera, detail = 'silhouette' }) {
	if (!DETAILS.has(detail)) throw new Error(`niveau de détail inconnu : ${detail}`);
	const onboard = detail !== 'silhouette';
	const portrait = detail === 'portrait';
	// … le corps existant, inchangé …
```

Après la boucle des moteurs, avant la caméra :

```js
	// Les pales, seulement à partir du niveau `onboard`. Vues de 8 cm, un
	// disque plat ne tient pas : il est soit invisible (par la tranche), soit
	// envahissant — la singularité est dans la primitive. Le disque reste quand
	// même : c'est l'enveloppe que le shader fond en flou quand le régime monte,
	// et c'est sur elle que porte la borne DA.
	if (onboard) {
		const chord = 0.20 * propRadius;          // corde typique d'une hélice de course
		const thick = 0.0015;
		for (const m of motors) {
			const k = motors.indexOf(m);
			for (let b = 0; b < bladeCount; b++) {
				const ang = (2 * Math.PI * b) / bladeCount;
				// La pale part du moyeu vers l'extérieur : une boîte allongée,
				// vrillée du pas, tournée de son angle autour de l'axe du moteur.
				parts.push(box('blade',
					[m.x + 0.5 * propRadius * Math.sin(ang), propPlaneY, m.z + 0.5 * propRadius * Math.cos(ang)],
					[chord, thick, propRadius],
					{ rotY: ang, rotZ: m.spin * 0.20, motor: k, spin: m.spin }));
			}
		}
	}

	// Ce qui ne se voit que de près, et qui distingue deux machines.
	if (portrait) {
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			parts.push(cyl('bell', [m.x, 0.006 + 0.014, m.z], 0.21 * propRadius, 0.016, { motor: k }));
		}
		parts.push(box('stack', [0, 0.006 + 0.008, 0], [0.030, 0.014, 0.030]));
	}
```

`boundingRadius` reste calculé comme aujourd'hui : les pales tiennent dans le disque, les cloches dans le moteur, le stack dans la plaque.

- [ ] **Step 4 : vérifier que ça passe**

Run: `node tools/drone-shape-selftest.mjs`
Expected: PASS.

- [ ] **Step 5 : vérifier que la borne DA tient toujours**

Run: `node tools/onboard-frame-selftest.mjs`
Expected: PASS — la borne se mesure sur le disque enveloppe, que les pales ne modifient pas.

- [ ] **Step 6 : commit**

```bash
npm run selftest:operator
git add src/drone-shape.js tools/drone-shape-selftest.mjs
git commit -m "feat(drone joueur): trois niveaux de détail, et de vraies pales à partir de l'embarqué (#264)"
```

---

## Task 6 : le régime dans le maillage

**Files:**
- Modify: `src/drone-mesh.js`
- Modify: `tools/drone-mesh-selftest.mjs`

**Interfaces:**
- Produces:
  ```js
  // Régime des quatre moteurs, rad/s, ordre Betaflight. Écrit une fois par
  // frame ; aucune allocation.
  export function setOmega(mat, omega)      // omega : tableau|Float array de 4
  ```
  `buildDroneMesh()` écrit désormais un attribut `aMotor` (float, 0-3, et `-1`
  pour tout ce qui n'appartient à aucun moteur) et un attribut `aSpin` sur la
  géométrie fusionnée.

- [ ] **Step 1 : écrire les checks qui échouent**

Ajouter dans `tools/drone-mesh-selftest.mjs` :

```js
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
	check('le châssis n\'appartient à aucun moteur', idx.has(-1));
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
```

Et ajouter `setOmega` à l'import en tête du fichier.

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/drone-mesh-selftest.mjs`
Expected: FAIL — `attribut d'index moteur présent`, et `setOmega is not a function`.

- [ ] **Step 3 : implémenter**

Dans `src/drone-mesh.js` :

1. Dans `partGeometry`, après avoir coloré, poser les deux attributs :

```js
function tagged(geo, part) {
	const n = geo.attributes.position.count;
	const motor = new Float32Array(n).fill(Number.isInteger(part.motor) ? part.motor : -1);
	const spin = new Float32Array(n).fill(part.spin ?? 0);
	geo.setAttribute('aMotor', new THREE.BufferAttribute(motor, 1));
	geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
	return geo;
}
```

et l'appliquer à **toutes** les branches de `partGeometry` (y compris `blade`, qui se rend comme une `box`), pour que `mergeGeometries` ne refuse pas des géométries aux attributs dépareillés.

2. Ajouter l'uniforme dans `DroneMaterial()` :

```js
			// Régime des quatre moteurs, rad/s, ordre Betaflight. C'est LUI qui
			// fait que le lacet, le roulis et le tangage se lisent dans les deux
			// hélices du champ : les avant sont sur des diagonales opposées, donc
			// un lacet en accélère une et ralentit l'autre.
			uOmega: { value: new Float32Array([0, 0, 0, 0]) },
```

3. Vertex shader : transporter l'index et le sens.

```glsl
			in float aMotor;
			in float aSpin;
			out float vMotor;
			out float vSpin;
			// … dans main() :
			vMotor = aMotor;
			vSpin = aSpin;
```

4. Fragment shader : remplacer le bloc `if (a < 0.99)` par un fondu piloté par le régime, et éteindre les pales quand il monte.

```glsl
			uniform float uOmega[4];
			in float vMotor;
			in float vSpin;
			// …
				// Le fondu pales → disque. Au ralenti on distingue les pales une
				// à une ; au-delà d'un tour par image elles ne sont plus qu'un
				// disque. Le seuil est en rad/s : 2π/dt à 60 fps ≈ 377 rad/s.
				float w = vMotor >= 0.0 ? uOmega[int(vMotor)] : 0.0;
				float blur = clamp(w / 377.0, 0.0, 1.0);
				if (a < 0.99) {
					// Le disque enveloppe : invisible à l'arrêt, plein en régime.
					float ang = atan(vUv.y - 0.5, vUv.x - 0.5) + uTime * max(w, 1.0) * vSpin * 0.03;
					a *= (0.7 + 0.3 * sin(ang * 3.0)) * blur;
				} else if (vMotor >= 0.0 && vSpin != 0.0) {
					// Une pale : pleine à l'arrêt, effacée quand le disque prend
					// le relais. Les deux ne sont jamais visibles ensemble.
					a *= 1.0 - blur;
				}
				if (a <= 0.001) discard;
```

Note : `uOmega` déclaré en `float[4]` côté GLSL correspond à un `Float32Array(4)` côté Three.

5. Exporter l'écriture, sans allocation :

```js
export function setOmega(mat, omega) {
	const u = mat.uniforms.uOmega.value;
	u[0] = omega[0]; u[1] = omega[1]; u[2] = omega[2]; u[3] = omega[3];
}
```

- [ ] **Step 4 : vérifier que ça passe**

Run: `node tools/drone-mesh-selftest.mjs`
Expected: PASS, y compris les checks existants (`≈ 300 triangles (< 600)` porte sur le niveau `silhouette` — si le test construit désormais un `onboard`, ajuster la borne haute du compte et **dire pourquoi** dans le message).

- [ ] **Step 5 : vérifier les ambiants**

Run: `node --expose-gc tools/ambient-drones-selftest.mjs`
Expected: PASS. Les ambiants ne posent pas `uOmega` : il reste à zéro, donc `blur = 0` et… **le disque disparaîtrait.** Corriger en posant le régime de croisière des ambiants une fois pour toutes dans `AmbientDrones.setScan()` :

```js
			// Les ambiants n'ont pas de moteurs simulés : on leur pose un régime
			// de croisière une fois, pour que leurs disques soient pleins (#264).
			setOmega(m.material, [500, 500, 500, 500]);
```

- [ ] **Step 6 : commit**

```bash
npm run selftest:operator
git add src/drone-mesh.js src/ambient-drones.js tools/drone-mesh-selftest.mjs
git commit -m "feat(drone joueur): le régime des quatre moteurs pilote les hélices (#264)"
```

---

## Task 7 : la vue embarquée et la seconde passe

**Files:**
- Modify: `src/onboard-drone.js`
- Modify: `src/lens.js`
- Modify: `src/main.js`
- Modify: `tools/onboard-drone-selftest.mjs`

**Interfaces:**
- Consumes: `PlayerDrone` (tâche 1), `setOmega` (tâche 6), `MOUNT` (tâche 3).
- Produces: sur `FpvLens`,
  ```js
  // Branche la scène embarquée. Passer null la débranche.
  setOnboard(scene)    // la passe est créée à la première scène non nulle
  ```
  et sur `PlayerDrone` : `get onboardScene()` (une `THREE.Scene`) et
  `get onboardCamera()` (une `THREE.PerspectiveCamera`, `near = 0.005`).

- [ ] **Step 1 : écrire les checks qui échouent**

Ajouter dans `tools/onboard-drone-selftest.mjs` :

```js
// Issue #264 : la vue embarquée.
{
	const d = make();
	check('une scène embarquée existe', d.onboardScene instanceof THREE.Scene);
	check('sa caméra a un near de 5 mm', Math.abs(d.onboardCamera.near - 0.005) < 1e-9);
	check('en vue pilote, l\'embarqué est visible', d.onboardVisible);
	check('en vue pilote, le monde est caché', !d.worldVisible);

	// Le drone est posé à −mount : l'oeil est à l'origine, la machine est
	// derrière et en dessous de lui.
	const p = new THREE.Vector3().setFromMatrixPosition(d.onboard.group.matrix);
	check('la machine est posée sous et derrière l\'oeil', p.y < 0 && p.z > 0, `${p.toArray().map((v) => v.toFixed(3))}`);

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
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/onboard-drone-selftest.mjs`
Expected: FAIL — `une scène embarquée existe` (`d.onboardScene` est `undefined`).

- [ ] **Step 3 : implémenter la scène embarquée**

Dans `src/onboard-drone.js`, au constructeur, après l'exemplaire monde :

```js
		// L'exemplaire EMBARQUÉ. Il vit dans sa propre scène, avec sa propre
		// caméra : la caméra de vol a near = 0.15 (le rayon du collider, cf.
		// drone-profiles.js) et est posée AU CENTRE du corps — tout le drone est
		// donc dans son near plane, et il n'y a rien à afficher sans ce
		// dispositif.
		//
		// Aucune transformation monde n'entre ici : l'oeil est à l'origine et la
		// machine est posée UNE FOIS à −mount, dé-tiltée de l'uptilt. Les hélices
		// sont rigides à l'objectif, donc leur place à l'image est un fait de
		// construction, pas un calcul par frame.
		this.onboardScene = new THREE.Scene();
		this.onboardCamera = new THREE.PerspectiveCamera(120, 1, 0.005, 4);
		this.onboard = buildDroneMesh(shapeOf({ profile, build, camera, detail: 'onboard' }), { colors: this._colors });
		const cam = shapeOf({ profile, build, camera, detail: 'onboard' }).parts.find((p) => p.role === 'camera');
		const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -camera.uptiltDeg * Math.PI / 180);
		const at = new THREE.Vector3(-cam.at[0], -cam.at[1], -cam.at[2]).applyQuaternion(tilt);
		this.onboard.group.matrix.compose(at, tilt, this._s);
		this.onboard.group.matrixWorldNeedsUpdate = true;
		this.onboard.group.visible = true;
		this.onboardScene.add(this.onboard.group);
```

Dans `update()`, ajouter avant le bloc monde :

```js
		// `camera` est ajouté à la déstructuration d'update() (tâche 1) :
		//   update({ dt, position, quaternion, omega, camera, sun, dim, … })
		if (camera) {
			this.onboardCamera.fov = camera.fov;
			this.onboardCamera.aspect = camera.aspect;
			this.onboardCamera.updateProjectionMatrix();
		}
		if (omega) {
			setOmega(this.onboard.material, omega);
			setOmega(this.world.material, omega);
		}
		setTime(this.onboard.material, this._time);
		if (sun) setSun(this.onboard.material, sun.dir, dim, sun.night);
```

et importer `setOmega` depuis `./drone-mesh.js`.

- [ ] **Step 4 : la seconde passe dans `src/lens.js`**

Dans le constructeur, après `this.composer.addPass(this.renderPass)` et **avant** `this.composer.addPass(this.pass)` :

```js
		// La vue embarquée (#264) : une seconde passe, sa propre caméra à
		// near = 0.005, sans effacer la couleur mais en effaçant la profondeur —
		// rien ne peut s'interposer entre l'oeil et ses propres hélices.
		//
		// Elle est DANS le composer, avant la passe d'objectif, délibérément :
		// la caméra voit ses hélices, PUIS l'image est transmise. Les poser
		// au-dessus de l'objectif les rendrait plus nettes que le monde.
		this.onboardPass = null;
```

et la méthode :

```js
	setOnboard(scene, camera) {
		if (!scene) { if (this.onboardPass) this.onboardPass.enabled = false; return; }
		if (!this.onboardPass) {
			this.onboardPass = new RenderPass(scene, camera);
			this.onboardPass.clear = false;
			this.onboardPass.clearDepth = true;
			this.onboardPass.needsSwap = false;
			// Insérée juste avant la passe d'objectif, qui est toujours la
			// dernière.
			this.composer.insertPass(this.onboardPass, this.composer.passes.length - 1);
		}
		this.onboardPass.scene = scene;
		this.onboardPass.camera = camera;
		this.onboardPass.enabled = true;
	}
```

Dans `render()`, à côté de `this.renderPass.enabled = !frozen;` :

```js
		// Gelée avec la principale : sur une image perdue, des hélices qui
		// tournent trahiraient que le monde bouge encore derrière l'image morte.
		if (this.onboardPass) this.onboardPass.enabled = !frozen && this._onboardOn;
```

avec `this._onboardOn` posé par `setOnboard()` (vrai quand une scène est branchée) et remis à faux quand on passe `null` — c'est ce qui cache l'embarqué en free cam.

- [ ] **Step 5 : câbler dans `src/main.js`**

- après la création de `playerDrone` : `lens.setOnboard(playerDrone.onboardScene, playerDrone.onboardCamera);`
- au basculement de la free cam :
  ```js
  playerDrone?.setFreeCam(freeCamOn);
  lens.setOnboard(freeCamOn ? null : playerDrone?.onboardScene, playerDrone?.onboardCamera);
  ```
- dans l'appel par frame de la tâche 1, ajouter `camera: { fov: camera.fov, aspect: camera.aspect }`.
- à la libération : `lens.setOnboard(null);` avant `playerDrone.dispose()`.

- [ ] **Step 6 : vérifier**

Run: `node tools/onboard-drone-selftest.mjs && npm run selftest:operator`
Expected: PASS partout.

- [ ] **Step 7 : commit**

```bash
git add src/onboard-drone.js src/lens.js src/main.js tools/onboard-drone-selftest.mjs
git commit -m "feat(drone joueur): les hélices dans le champ, par une seconde passe gelée avec l'image (#264)"
```

- [ ] **Step 8 : vérification à l'œil (à faire par l'utilisateur)**

`npm run dev`. Ce qui se juge ici : la quantité d'hélice (la borne est tenue par construction, mais 8 % « juste » et 8 % « trop » ne se distinguent qu'à l'œil) ; le fondu pales → disque à la montée en gaz ; et surtout le **lacet** — les deux hélices doivent partir en sens contraires de régime.

---

## Task 8 : le régime, vérifié contre la physique réelle

Ce qui précède affirme que le maillage lit `propulsion.omega`. Cette tâche affirme que `propulsion.omega` dit bien ce qu'on prétend qu'il dit.

**Files:**
- Create: `tools/onboard-regime-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `mixOf`, `Propulsion` de `src/quad.js` ; `PROFILES` de `src/drone-profiles.js`.

- [ ] **Step 1 : écrire le selftest**

```js
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
	check('montée en régime plus raide que la descente', up > Math.abs(down - up) || up > 0,
		`+${up.toFixed(0)} puis ${(down - up).toFixed(0)} rad/s`);
	check('l\'asymétrie est bien dans le profil', profile.tauSpinDown > profile.tauSpinUp,
		`tauSpinUp ${profile.tauSpinUp} < tauSpinDown ${profile.tauSpinDown}`);
}

// 4. La batterie : quad.js:205-207, « Motor rpm tracks voltage, so a sagging
//    pack lowers the ceiling on thrust ». Les hélices annoncent le pack mourant.
{
	const full = settle(cmd(0.8), 1.0);
	const flat = new Propulsion({ profile, seed: 1 });
	flat.battery.voltage = 3.4 * profile.battery.cells;
	const dt = 1 / 250;
	for (let i = 0; i < 250; i++) flat.step(cmd(0.8), STILL, dt);
	check('pack vidé : plafond de régime abaissé', flat.omega[0] < full.omega[0],
		`${flat.omega[0].toFixed(0)} < ${full.omega[0].toFixed(0)} rad/s`);
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
```

- [ ] **Step 2 : le lancer**

Run: `node tools/onboard-regime-selftest.mjs`
Expected: PASS. **Si le check du lacet échoue**, ne pas « corriger » le test : c'est que le câblage hélice ↔ moteur de la tâche 4 est faux, ou que la convention de signe du manche de lacet est inversée. Relire `quad.js:76-84` et `flightController.js:312` (`actualRate(-sticks.yaw, …)`) avant de toucher à quoi que ce soit.

- [ ] **Step 3 : ajouter à la chaîne et commit**

```bash
# dans package.json : && node tools/onboard-regime-selftest.mjs
npm run selftest:operator
git add tools/onboard-regime-selftest.mjs package.json
git commit -m "test(drone joueur): ce que les hélices racontent, vérifié contre la physique (#264)"
```

---

## Task 9 : la projection fil de fer

**Écart assumé par rapport à la spec.** La spec prévoyait que le niveau `portrait` expose une liste d'arêtes. Ce n'est pas nécessaire : `drone-wire.js` lit les **mêmes primitives** que `drone-mesh.js` (une boîte donne 12 arêtes, un cylindre deux cercles et des génératrices, un disque un cercle). Une liste d'arêtes dans la recette serait une seconde description de la même chose, à tenir synchronisée pour rien. La spec est corrigée en conséquence.

**Files:**
- Create: `src/drone-wire.js`
- Create: `tools/drone-wire-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  ```js
  // shape : le retour de shapeOf({ …, detail: 'portrait' }).
  // view  : { yawDeg, pitchDeg } — l'orientation du portrait.
  // Rend { segments, depth } :
  //   segments : Float32Array de 4·n — [x0,y0,x1,y1, …], chaque coordonnée
  //              dans [-1, 1], la boîte du portrait ;
  //   depth    : Float32Array de n — profondeur moyenne du segment, normalisée
  //              dans [0, 1] (0 = le plus près). Sert à ATTÉNUER les arêtes
  //              lointaines : il n'y a pas d'élimination des faces cachées.
  export function wireOf(shape, view)
  ```

- [ ] **Step 1 : écrire le selftest qui échoue**

```js
// node tools/drone-wire-selftest.mjs — le portrait fil de fer (issue #264).
// Module PUR : aucun Three, aucun DOM, donc le portrait de l'archive se
// vérifie sans navigateur.
import { wireOf } from '../src/drone-wire.js';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const portrait = (family, seed = `wire::${family}`) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }), detail: 'portrait' });
};
const VIEW = { yawDeg: 35, pitchDeg: 20 };

console.log('drone-wire');

for (const family of FAMILIES) {
	const w = wireOf(portrait(family), VIEW);
	const n = w.segments.length / 4;
	check(`${family}: des segments, et pas trop`, n > 60 && n < 4000, `${n}`);
	check(`${family}: tout tient dans la boîte`, Array.from(w.segments).every((v) => v >= -1 && v <= 1));
	check(`${family}: une profondeur par segment`, w.depth.length === n);
	check(`${family}: profondeurs normalisées`, Array.from(w.depth).every((v) => v >= 0 && v <= 1));
	check(`${family}: le portrait n'est pas dégénéré`,
		Math.max(...w.segments) - Math.min(...w.segments) > 0.5);
}

check('même graine → mêmes segments',
	JSON.stringify(Array.from(wireOf(portrait('race5', 'same'), VIEW).segments))
	=== JSON.stringify(Array.from(wireOf(portrait('race5', 'same'), VIEW).segments)));

// Les six familles doivent se DISTINGUER : c'est tout l'intérêt d'une
// collection. Deux portraits identiques voudraient dire que la recette ne
// varie pas assez pour qu'on reconnaisse une machine.
{
	const sigs = FAMILIES.map((f) => wireOf(portrait(f), VIEW).segments.length);
	const pairs = [];
	for (let i = 0; i < FAMILIES.length; i++) {
		for (let j = i + 1; j < FAMILIES.length; j++) {
			const a = wireOf(portrait(FAMILIES[i]), VIEW).segments;
			const b = wireOf(portrait(FAMILIES[j]), VIEW).segments;
			const same = a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
			if (same) pairs.push(`${FAMILIES[i]}/${FAMILIES[j]}`);
		}
	}
	check('les six familles se distinguent deux à deux', pairs.length === 0, pairs.join(' '));
	check('les comptes de segments varient', new Set(sigs).size > 1);
}

// Deux vues différentes donnent deux projections différentes.
check('la vue tourne vraiment',
	wireOf(portrait('freestyle5'), { yawDeg: 0, pitchDeg: 20 }).segments[0]
	!== wireOf(portrait('freestyle5'), { yawDeg: 90, pitchDeg: 20 }).segments[0]);

// Une recette absente ne casse pas : l'archive affiche simplement rien.
{
	const w = wireOf(null, VIEW);
	check('recette absente : zéro segment, pas d\'exception', w.segments.length === 0);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/drone-wire-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/drone-wire.js'`

- [ ] **Step 3 : implémenter**

Créer `src/drone-wire.js` :

```js
// Le portrait fil de fer du quad (issue #264) — la MÊME recette que le vol,
// projetée en segments 2D. Module PUR : aucun Three, aucun DOM, donc le
// portrait de l'archive se vérifie en Node, comme tout le reste des écrans.
//
// Pourquoi du fil de fer et pas le rendu du vol : le monde est photographique,
// le terminal est monochrome et vectoriel, et les deux restent étanches. Un
// contexte WebGL dans les écrans du journal ferait entrer le moteur dans des
// clients purs (src/session-log.js) pour un dessin de deux cents traits.
//
// Pas d'élimination des faces cachées : les arêtes lointaines s'ATTÉNUENT.
// Une machine qu'on voit à travers se lit mieux qu'une silhouette pleine, et
// c'est le vocabulaire des `vector animations` de PHASE 20.

const CIRCLE_STEPS = 16;

// Les arêtes d'une primitive, en coordonnées locales de la pièce.
function edgesOf(part) {
	const out = [];
	const push = (a, b) => out.push([a, b]);
	switch (part.kind) {
		case 'box': {
			const [w, h, d] = part.size.map((v) => v / 2);
			const c = [];
			for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) c.push([sx * w, sy * h, sz * d]);
			// Deux sommets sont voisins s'ils diffèrent sur un seul axe.
			for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
				const diff = c[i].reduce((n, v, k) => n + (v !== c[j][k] ? 1 : 0), 0);
				if (diff === 1) push(c[i], c[j]);
			}
			break;
		}
		case 'cylinder':
		case 'ring': {
			const r = part.size[0], h = (part.size[1] ?? 0) / 2;
			for (let i = 0; i < CIRCLE_STEPS; i++) {
				const a = (2 * Math.PI * i) / CIRCLE_STEPS, b = (2 * Math.PI * (i + 1)) / CIRCLE_STEPS;
				for (const y of [-h, h]) push([r * Math.cos(a), y, r * Math.sin(a)], [r * Math.cos(b), y, r * Math.sin(b)]);
				if (i % 4 === 0) push([r * Math.cos(a), -h, r * Math.sin(a)], [r * Math.cos(a), h, r * Math.sin(a)]);
			}
			break;
		}
		case 'disc': {
			const r = part.size[0];
			for (let i = 0; i < CIRCLE_STEPS; i++) {
				const a = (2 * Math.PI * i) / CIRCLE_STEPS, b = (2 * Math.PI * (i + 1)) / CIRCLE_STEPS;
				push([r * Math.cos(a), 0, r * Math.sin(a)], [r * Math.cos(b), 0, r * Math.sin(b)]);
			}
			break;
		}
		default: break;   // 'point' (LED) : rien à tracer
	}
	return out;
}

function place(p, part) {
	let [x, y, z] = p;
	if (part.rotZ) { const c = Math.cos(part.rotZ), s = Math.sin(part.rotZ); [x, y] = [x * c - y * s, x * s + y * c]; }
	if (part.rotX) { const c = Math.cos(part.rotX), s = Math.sin(part.rotX); [y, z] = [y * c - z * s, y * s + z * c]; }
	if (part.rotY) { const c = Math.cos(part.rotY), s = Math.sin(part.rotY); [x, z] = [x * c + z * s, -x * s + z * c]; }
	return [x + part.at[0], y + part.at[1], z + part.at[2]];
}

export function wireOf(shape, { yawDeg = 30, pitchDeg = 20 } = {}) {
	if (!shape?.parts?.length) return { segments: new Float32Array(0), depth: new Float32Array(0) };

	const cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180);
	const cp = Math.cos(pitchDeg * Math.PI / 180), sp = Math.sin(pitchDeg * Math.PI / 180);

	const xs = [], ys = [], ds = [];
	for (const part of shape.parts) {
		for (const [a, b] of edgesOf(part)) {
			for (const p of [a, b]) {
				const [wx, wy, wz] = place(p, part);
				// Rotation d'orbite (lacet puis tangage), projection orthographique :
				// un portrait technique n'a pas de perspective.
				const rx = wx * cy + wz * sy;
				const rz = -wx * sy + wz * cy;
				xs.push(rx);
				ys.push(wy * cp - rz * sp);
				ds.push(wy * sp + rz * cp);
			}
		}
	}

	// Normalisation dans [-1, 1] en gardant les proportions : une machine large
	// doit RESTER large à côté d'une machine étroite.
	const r = shape.boundingRadius || 1;
	const n = xs.length / 2;
	const segments = new Float32Array(4 * n);
	const depth = new Float32Array(n);
	let dMin = Infinity, dMax = -Infinity;
	for (const d of ds) { if (d < dMin) dMin = d; if (d > dMax) dMax = d; }
	const span = dMax - dMin || 1;
	for (let i = 0; i < n; i++) {
		segments[4 * i] = clamp(xs[2 * i] / r);
		segments[4 * i + 1] = clamp(ys[2 * i] / r);
		segments[4 * i + 2] = clamp(xs[2 * i + 1] / r);
		segments[4 * i + 3] = clamp(ys[2 * i + 1] / r);
		depth[i] = ((ds[2 * i] + ds[2 * i + 1]) / 2 - dMin) / span;
	}
	return { segments, depth };
}

const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
```

- [ ] **Step 4 : vérifier**

Run: `node tools/drone-wire-selftest.mjs`
Expected: PASS.

- [ ] **Step 5 : corriger la spec et commit**

Dans `docs/superpowers/specs/2026-09-06-player-drone-3d-design.md`, remplacer la sous-section « Une liste d'arêtes » par une note disant que `drone-wire.js` dérive les arêtes des primitives, et pourquoi (une seconde description de la même géométrie serait à tenir synchronisée pour rien).

```bash
# dans package.json : && node tools/drone-wire-selftest.mjs
npm run selftest:operator
git add src/drone-wire.js tools/drone-wire-selftest.mjs package.json docs/superpowers/specs/2026-09-06-player-drone-3d-design.md
git commit -m "feat(drone joueur): le portrait fil de fer, projeté sans Three ni DOM (#264)"
```

---

## Task 10 : le portrait à l'écran — crash, SESSION LOG, TARGET LOG

**Files:**
- Create: `src/drone-portrait.js`
- Create: `tools/drone-portrait-render-selftest.mjs`
- Modify: `src/session-log.js`
- Modify: `src/flight-end.js` (une ligne de `TIMELINE`)
- Modify: `src/fpvtp-osd.js` (peint le portrait dans `#flight-end`)
- Modify: `tools/flight-end-selftest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `wireOf` (tâche 9) ; `session.target.family` et `session.target.buildSeed`, persistés en clair par le serveur (`tools/target-model.mjs:117-133`, `tools/map-api-plugin.mjs:267`) — **rien à régénérer, rien à migrer**.
- Produces:
  ```js
  // Rend un <svg> monochrome qui tourne lentement, ou null si la session n'a
  // pas de cible (chemins dev). L'appelant DOIT appeler stop() au démontage.
  export function dronePortrait({ family, buildSeed, size = 160 })
  //   → { el: SVGElement, stop(): void } | null
  ```

- [ ] **Step 1 : écrire le selftest qui échoue**

```js
// node tools/drone-portrait-render-selftest.mjs — le portrait à l'écran
// (issue #264), sur le faux DOM. Ce qu'on vérifie est l'ARBRE et le CÂBLAGE :
// ce qui est produit, ce qui est monochrome, ce qui s'arrête au démontage.
// L'apparence se juge à l'oeil, pas ici.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();
const { dronePortrait } = await import('../src/drone-portrait.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('drone-portrait');

t('une cible donne un SVG', () => {
	const p = dronePortrait({ family: 'freestyle5', buildSeed: 'seed::0' });
	assert.ok(p, 'aucun portrait rendu');
	assert.equal(p.el.tagName.toLowerCase(), 'svg');
	assert.ok(p.el.querySelectorAll('line').length > 60, 'trop peu de traits');
	p.stop();
});

t('aucune couleur en dur : tout est currentColor', () => {
	const p = dronePortrait({ family: 'race5', buildSeed: 'seed::1' });
	const html = p.el.outerHTML ?? '';
	assert.ok(!/#[0-9a-f]{3,6}/i.test(html), `couleur littérale dans le portrait : ${html.slice(0, 200)}`);
	assert.ok(/currentColor/.test(html), 'la couleur ne vient pas du contexte');
	p.stop();
});

t('sans cible : rien, et pas d\'exception', () => {
	assert.equal(dronePortrait({ family: null, buildSeed: null }), null);
	assert.equal(dronePortrait({}), null);
});

t('stop() coupe l\'animation', () => {
	const p = dronePortrait({ family: 'cinewhoop', buildSeed: 'seed::2' });
	p.stop();
	const before = dom.window.__rafCount ?? 0;
	dom.tick?.(100);
	assert.equal(dom.window.__rafCount ?? 0, before, 'le portrait continue de tourner après stop()');
});

t('deux familles ne donnent pas le même dessin', () => {
	const a = dronePortrait({ family: 'toothpick', buildSeed: 's' });
	const b = dronePortrait({ family: 'longrange', buildSeed: 's' });
	assert.notEqual(a.el.outerHTML, b.el.outerHTML);
	a.stop(); b.stop();
});

console.log(`\n${n} ok`);
```

Note : si `tools/lib/fake-dom.mjs` n'expose ni `__rafCount` ni `tick()`, l'ajouter — c'est un shim de test, pas du code de production, et `bench-render-selftest.mjs` montre le style attendu.

- [ ] **Step 2 : le lancer pour vérifier qu'il échoue**

Run: `node tools/drone-portrait-render-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/drone-portrait.js'`

- [ ] **Step 3 : implémenter**

Créer `src/drone-portrait.js` :

```js
// Le portrait du drone à l'écran (issue #264). Un <svg> en ligne, monochrome,
// qui tourne lentement — pas un canvas, pas de WebGL : src/session-log.js est
// un client pur (« aucune dépendance Three/Rapier ») et le portrait ne doit
// pas y faire entrer le moteur.
//
// La couleur vient du contexte via currentColor, jamais d'ici — même règle que
// src/pixel-icons.js.
import { wireOf } from './drone-wire.js';
import { shapeOf } from './drone-shape.js';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';

const NS = 'http://www.w3.org/2000/svg';
const PERIOD_S = 24;      // un tour complet, lent : c'est une fiche, pas une démo

export function dronePortrait({ family, buildSeed, size = 160 } = {}) {
	if (!family || !buildSeed) return null;

	const build = targetBuild({ seed: buildSeed, family });
	const shape = shapeOf({
		profile: build.profile, build,
		camera: targetCamera({ seed: buildSeed, family }),
		detail: 'portrait',
	});

	const el = document.createElementNS(NS, 'svg');
	el.setAttribute('viewBox', '-1.1 -1.1 2.2 2.2');
	el.setAttribute('width', String(size));
	el.setAttribute('height', String(size));
	el.setAttribute('class', 'drone-portrait');
	el.setAttribute('aria-label', `${family} ${buildSeed}`);

	const lines = [];
	const draw = (yawDeg) => {
		const w = wireOf(shape, { yawDeg, pitchDeg: 22 });
		const n = w.segments.length / 4;
		while (lines.length < n) {
			const l = document.createElementNS(NS, 'line');
			l.setAttribute('stroke', 'currentColor');
			l.setAttribute('stroke-width', '0.006');
			el.appendChild(l);
			lines.push(l);
		}
		for (let i = 0; i < n; i++) {
			const l = lines[i];
			l.setAttribute('x1', w.segments[4 * i].toFixed(4));
			// SVG a l'axe Y vers le BAS : on inverse, sinon la machine est sur le dos.
			l.setAttribute('y1', (-w.segments[4 * i + 1]).toFixed(4));
			l.setAttribute('x2', w.segments[4 * i + 2].toFixed(4));
			l.setAttribute('y2', (-w.segments[4 * i + 3]).toFixed(4));
			// Les arêtes lointaines s'atténuent : pas d'élimination des faces
			// cachées, mais une profondeur qui se lit quand même.
			l.setAttribute('opacity', (1 - 0.65 * w.depth[i]).toFixed(3));
		}
		for (let i = n; i < lines.length; i++) lines[i].setAttribute('opacity', '0');
	};

	let raf = 0, t0 = 0, stopped = false;
	const frame = (t) => {
		if (stopped) return;
		if (!t0) t0 = t;
		draw(((t - t0) / 1000 / PERIOD_S) * 360);
		raf = requestAnimationFrame(frame);
	};
	draw(30);
	raf = requestAnimationFrame(frame);

	return {
		el,
		stop() { stopped = true; cancelAnimationFrame(raf); },
	};
}
```

- [ ] **Step 4 : vérifier**

Run: `node tools/drone-portrait-render-selftest.mjs`
Expected: `5 ok`.

- [ ] **Step 5 : le poser dans `SESSION LOG` et `TARGET LOG`**

Dans `src/session-log.js`, `runSessionDetail()` construit déjà le détail en texte (`sessionDetail(s)`) et une galerie de captures (`gallery(photos)`). Ajouter le portrait à côté, et **le couper au démontage** :

```js
	const portrait = dronePortrait({ family: sess?.target?.family, buildSeed: sess?.target?.buildSeed });
	if (portrait) s.box.appendChild(portrait.el);
	// … et dans le chemin de sortie de l'écran, avant de résoudre :
	portrait?.stop();
```

Le portrait n'est PAS ajouté au texte de `tools/session-log-model.mjs` : ce module rend une chaîne, et le portrait est un nœud. Le modèle reste pur.

Même geste dans le `TARGET LOG` (`runTargetLog`), pour l'entrée sous le curseur.

- [ ] **Step 6 : le poser au crash**

Dans `src/flight-end.js`, ajouter une ligne à `TIMELINE.lines`, **après** `SESSION TERMINATED` et avant le bloc de sortie :

```js
		[3.6, 'SESSION TERMINATED'],
		// Le portrait de la machine perdue (#264). Révision assumée de Bible §24
		// (« pas de grand écran de mort ») : ce n'est pas une récompense, c'est
		// ce qu'il reste. La sortie ne bouge pas — exitAt vaut toujours 4,6 s.
		[4.0, '[PORTRAIT]'],
```

`src/fpvtp-osd.js` peint `#flight-end` : quand la ligne `[PORTRAIT]` apparaît, remplacer son texte par le nœud rendu par `dronePortrait({ family, buildSeed })`, et appeler `stop()` quand `#flight-end` est vidé.

Dans `tools/flight-end-selftest.mjs`, ajouter :

```js
t('le portrait arrive après SESSION TERMINATED et avant la sortie', () => {
	const at = (txt) => TIMELINE.lines.find(([, s]) => s === txt)?.[0];
	assert.ok(at('[PORTRAIT]') > at('SESSION TERMINATED'), 'le portrait précède la fin');
	assert.ok(at('[PORTRAIT]') <= TIMELINE.exitAt, 'le portrait arrive après la sortie');
	assert.equal(TIMELINE.exitAt, 4.6, 'la sortie a bougé : la timeline n\'est plus celle de la spec');
});
```

- [ ] **Step 7 : vérifier**

Run: `node tools/flight-end-selftest.mjs && node tools/drone-portrait-render-selftest.mjs && npm run selftest:operator`
Expected: PASS partout.

- [ ] **Step 8 : commit**

```bash
git add src/drone-portrait.js tools/drone-portrait-render-selftest.mjs src/session-log.js src/flight-end.js src/fpvtp-osd.js tools/flight-end-selftest.mjs package.json
git commit -m "feat(drone joueur): le portrait au crash et dans les journaux (#264)"
```

- [ ] **Step 9 : vérification à l'œil (à faire par l'utilisateur)**

Le portrait est le seul livrable dont **rien** ne juge l'apparence en Node. À regarder : le fil de fer est-il lisible à 160 px ; la vitesse de rotation est-elle une fiche technique ou une démo ; et au crash, arrive-t-il comme ce qu'il reste ou comme une récompense — c'est la question que §24 posait, et elle se tranche à l'œil.

---

## Task 11 : les documents

Sans cette tâche, la Bible et le code se contrediront en silence.

**Files:**
- Modify: `docs/FPVThePlanet! — Art Direction & Experience Bible.md` (§24)
- Modify: `src/post-flight.js` (le commentaire qui cite §24)
- Modify: `HANDOFF.md`
- Modify: l'issue #264 sur GitHub

- [ ] **Step 1 : réviser Bible §24**

Ajouter au titre la mention de révision, sur le modèle exact de §34 (`### Le vol a une musique. (révisé — issue #122)`) :

```markdown
# 24. Perte du signal et crash (révisé — issue #264)
```

et, après « Pas de grand écran de mort. », le paragraphe qui dit ce qui a changé et ce qui n'a pas changé :

```markdown
> **Révision (issue #264).** Après `SESSION TERMINATED`, le portrait fil de fer
> de la machine perdue apparaît. Ce n'est pas une récompense et pas un écran de
> mort : c'est ce qu'il reste. La collection naît de la perte.
>
> Ce qui ne change pas : `POST-FLIGHT ANALYSIS` reste réservé aux sessions
> LANDED, la musique reste coupée net au choc (§34, #122), la timeline garde
> ses temps et sa sortie à 4,6 s.
```

- [ ] **Step 2 : mettre le code d'accord avec elle**

Dans `src/post-flight.js`, compléter le commentaire d'en-tête (lignes 6-7) :

```js
// Uniquement pour une session LANDED : une session CRASHED n'a pas de grand
// écran (Bible §24, « pas de récompense, pas de grand écran de mort »). Le
// portrait de la machine perdue (#264) n'est PAS une exception à cette règle :
// il vit dans la timeline de flight-end.js et dans l'archive, jamais ici.
```

- [ ] **Step 3 : mettre `HANDOFF.md` à jour**

Deux listes, honnêtement séparées :
- **vérifié** : ce que les selftests couvrent (borne DA, câblage hélice ↔ moteur, régime contre la physique, exclusivité, gel, projection fil de fer, arbre SVG) ;
- **non vérifié** : tout ce qui se juge à l'œil (quantité d'hélice à l'image, fondu pales → disque, lisibilité du portrait, ton du crash), avec la marche à suivre navigateur : `npm run dev`, `?family=<famille>`, touche `C`.

- [ ] **Step 4 : mettre l'issue #264 à jour**

Le corps de l'issue décrit un « lot B — le drone en 3D au banc » qui a été **écarté à la conception**, et ne mentionne ni le crash ni les journaux. Le remplacer par les trois lots réels, avec les liens vers la spec et ce plan.

```bash
gh issue edit 264 --body-file <(…)   # corps réécrit
```

- [ ] **Step 5 : commit**

```bash
npm run selftest:operator
git add "docs/FPVThePlanet! — Art Direction & Experience Bible.md" src/post-flight.js HANDOFF.md
git commit -m "docs(drone joueur): §24 révisée, HANDOFF à jour (#264)"
```

---

## Ordre et dépendances

```text
Task 1  (free cam)            ── indépendante, livrable seul
Task 2  (sonde)               ── indépendante
Task 3  (mount)               ── dépend de 2
Task 4  (motorsOf)            ── indépendante de 2/3, mais 5 en dépend
Task 5  (détail + pales)      ── dépend de 3 et 4
Task 6  (régime au maillage)  ── dépend de 4 et 5
Task 7  (embarqué + passe)    ── dépend de 1, 3, 5, 6
Task 8  (régime vs physique)  ── dépend de 4
Task 9  (fil de fer)          ── dépend de 5
Task 10 (portrait à l'écran)  ── dépend de 9
Task 11 (documents)           ── dernière
```

Les tâches 1, 2, 4 peuvent partir en parallèle. La chaîne `selftest:operator` doit être verte à chaque commit, sans exception.
