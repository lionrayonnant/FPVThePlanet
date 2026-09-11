# Drones ambiants — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Les candidats non pris du TARGET SCAN volent autour du joueur pendant une session FIELD, chacun selon la routine de sa famille, rendus en quads low-poly paramétriques avec LED et voix moteur placée.

**Architecture:** Un modèle pur (`src/ambient.js`) tient la bulle, les ancres, les courbes et l'attitude dans des tableaux pré-alloués ; une recette pure (`src/drone-shape.js`) décrit le quad en primitives ; deux modules client (`src/drone-mesh.js`, `src/ambient-audio.js`) rendent et sonorisent ; `src/ambient-drones.js` lie le tout et parle à `main.js`. La session persiste `target.scan` pour rejouer les mêmes ambiants au resume.

**Tech Stack:** Three.js (ShaderMaterial, BufferGeometry), Web Audio (nœuds construits une fois), Node selftests sans navigateur (`check()`/`assert`), Rapier via `physics.groundBelow` / `physics.obstructionBetween` seulement.

**Spec:** `sim/docs/superpowers/specs/2026-09-06-ambient-drones-design.md` (issue #250)

## Global Constraints

- Coordonnées locales ENU : X = est, Y = haut, Z = sud. Nez du corps = −Z (convention caméra Three).
- Zéro allocation par frame dans tout `update()` : tableaux `Float64Array` pré-alloués, objets `out` mutés.
- Aucune validation de trajectoire dans l'accumulateur à 250 Hz ; tout travail par frame utilise `frozen ? 0 : dt`.
- Aucun littéral de couleur hors `src/tokens.css` : passer par `token('--…')` de `src/palette.js` ; `tools/palette-selftest.mjs` doit rester vert.
- Son : sinus seulement ; détune obligatoire entre voix ; nœuds construits une fois dans `start()` ; `setTargetAtTime` seulement ; somme des quatre voix à 8 m ≤ −12 dB sous `AUDIO.idleLevel` (0,12) ; jamais le Doppler du `PannerNode`.
- Jamais au banc : `if (MODE.bench)` au point de création (`bootLive()` est partagé).
- Deux rayons de bulle : `R_SPAWN = [120, 250]`, `R_LEAVE = 320` ; naissance hors champ (`cos(FOV/2 + 15°)`) ou au-delà de 220 m ; naissances seulement sur frame non gelée, une par frame.
- Validation d'une courbe : 16 échantillons, `groundBelow` par échantillon, `obstructionBetween` entre voisins avec rejet si `blocked && span > 2`.
- Interdits : `Geofence.update()` partagé (hystérésis), `occupancyOf()` (cache périmé en direct), `rolloutSafe()` (téléporte le joueur), `MeshLambertMaterial`, `scene.fog`.
- Tous les nouveaux selftests s'ajoutent à la fin de la chaîne `selftest:operator` de `package.json`.
- Commits : message en français, préfixe conventionnel, suffixe `(#250)` ; pas de push forcé.

---

## Structure des fichiers

| fichier | rôle | testé par |
|---|---|---|
| `tools/target-model.mjs` (modif) | `resolveTarget()` ajoute `scan` | `tools/target-selftest.mjs` |
| `tools/session-model.mjs` (modif) | `sanitizeTarget()` garde `scan`, schéma v2 | `tools/session-selftest.mjs` |
| `src/ambient.js` (nouveau, pur) | ensemble ambiant, routines, courbes, bulle, ancres, validation, attitude | `tools/ambient-selftest.mjs` |
| `src/drone-shape.js` (nouveau, pur) | recette géométrique | `tools/drone-shape-selftest.mjs` |
| `src/drone-mesh.js` (nouveau, Three) | géométrie fusionnée, matériau, LED | `tools/drone-mesh-selftest.mjs` (Three en Node) |
| `tools/ambient-audio-model.mjs` (nouveau, pur) | gain, coupure, pan, Doppler, fréquence | `tools/ambient-audio-selftest.mjs` |
| `src/ambient-audio.js` (nouveau, Web Audio) | quatre voix | `tools/ambient-audio-selftest.mjs` (faux contexte) |
| `src/ambient-drones.js` (nouveau) | l'instance, liaison modèle ↔ maillages ↔ voix | `tools/selftest.mjs` (bloc scène) |
| `src/main.js` (modif) | création, `update`, `reset`, `linkDead`, `__sim`, resume | navigateur (opérateur) |
| `package.json` (modif) | chaîne `selftest:operator` | — |
| `HANDOFF.md` (modif) | état vérifié / non vérifié, marche à suivre | — |

---

### Task 1 : Persistance — `target.scan` et le resume qui rejoue l'exemplaire

**Files:**
- Modify: `tools/target-model.mjs:116-140` (`resolveTarget`)
- Modify: `tools/session-model.mjs:16` (`SESSION_SCHEMA_VERSION`), `:66-86` (`sanitizeTarget`)
- Modify: `src/main.js:2434-2441` (branche `resume` de `fieldLoop`)
- Test: `tools/target-selftest.mjs`, `tools/session-selftest.mjs`

**Interfaces:**
- Produces: `resolveTarget(scan, index).scan === { seed: string, count: 2..5, index: int }` ; `sanitizeTarget(raw).scan` = même forme ou `null` (session v1) ; `SESSION_SCHEMA_VERSION === 2`.

- [ ] **Step 1 : Tests qui échouent — `resolveTarget` porte le scan**

Dans `tools/target-selftest.mjs`, à la fin du bloc `// --- resolveTarget` :

```js
{
	const scan = generateTargetScan({ seed: 'scan-kept', count: 4 });
	const t = resolveTarget(scan, 2);
	check('resolveTarget porte scan.seed', t.scan?.seed === 'scan-kept');
	check('resolveTarget porte scan.count', t.scan?.count === 4);
	check('resolveTarget porte scan.index', t.scan?.index === 2);
	check('buildSeed dérive de scan', t.buildSeed === `${t.scan.seed}::${t.scan.index}`);
}
```

Dans `tools/session-selftest.mjs`, après le test `sanitizeTarget : hackType — …` :

```js
t('sanitizeTarget : garde scan {seed,count,index} et rejette une forme fausse', () => {
	const scan = generateTargetScan({ seed: 'keep-me', count: 3 });
	const kept = sanitizeTarget(resolveTarget(scan, 1));
	assert.deepEqual(kept.scan, { seed: 'keep-me', count: 3, index: 1 });
	// Session v1 : pas de scan → null, pas d'erreur.
	const v1 = { ...resolveTarget(scan, 1) };
	delete v1.scan;
	assert.equal(sanitizeTarget(v1).scan, null);
	// Formes fausses.
	for (const bad of [
		{ seed: '', count: 3, index: 1 },
		{ seed: 'x', count: 1, index: 0 },
		{ seed: 'x', count: 6, index: 0 },
		{ seed: 'x', count: 3, index: 3 },
		{ seed: 'x', count: 3, index: -1 },
		{ seed: 'x', count: 3.5, index: 0 },
	]) {
		assert.throws(() => sanitizeTarget({ ...resolveTarget(scan, 1), scan: bad }), /target\.scan/);
	}
});

t('schéma de session : version 2', () => {
	assert.equal(SESSION_SCHEMA_VERSION, 2);
});
```

Ajouter `SESSION_SCHEMA_VERSION` à l'import de `./session-model.mjs` en tête de `tools/session-selftest.mjs`.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/target-selftest.mjs | grep FAIL ; node tools/session-selftest.mjs`
Expected: 4 `FAIL` côté target ; côté session, `✗ sanitizeTarget : garde scan` et `✗ schéma de session : version 2`.

- [ ] **Step 3 : Implémenter**

`tools/target-model.mjs`, dans l'objet rendu par `resolveTarget` (après `buildSeed`) :

```js
		// Le scan lui-même (issue #250) : ce qu'il faut pour REGÉNÉRER les
		// candidats non pris au resume — les drones ambiants — et pour
		// reconstruire buildSeed côté client sans le stocker deux fois.
		scan: { seed: String(scan.seed), count: scan.candidates.length, index },
```

`tools/session-model.mjs` :

```js
export const SESSION_SCHEMA_VERSION = 2;
```

Juste avant `sanitizeTarget` :

```js
// Le scan d'origine (issue #250). `null` pour une session v1, qui n'en a
// jamais eu : au resume elle rejoue sa cible mais pas ses ambiants.
function sanitizeScan(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target.scan invalide');
	if (typeof raw.seed !== 'string' || raw.seed.length === 0) throw new Error('target.scan.seed invalide');
	if (!Number.isInteger(raw.count) || raw.count < 2 || raw.count > 5) throw new Error('target.scan.count invalide');
	if (!Number.isInteger(raw.index) || raw.index < 0 || raw.index >= raw.count) throw new Error('target.scan.index invalide');
	return { seed: raw.seed, count: raw.count, index: raw.index };
}
```

Dans le `return` de `sanitizeTarget`, après `scannedAt` :

```js
		scan: sanitizeScan(raw.scan),
```

`src/main.js:2434-2441`, la branche `resume` :

```js
			const prev = operator.getOperator()?.sessions?.find((s) => s.id === resume);
			// L'exemplaire est rejoué depuis le scan persisté (issue #250) : le
			// serveur ne stocke pas buildSeed, il stocke ce qui permet de le
			// reconstruire. Une session v1 n'a pas de scan → profil nominal,
			// comme avant.
			const sc = prev?.target?.scan;
			return {
				slug, resume, target: undefined,
				family: prev?.target?.family ?? OPTS.family ?? undefined,
				buildSeed: sc ? `${sc.seed}::${sc.index}` : undefined,
			};
```

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/target-selftest.mjs | grep -c FAIL ; node tools/session-selftest.mjs && node tools/session-route-selftest.mjs && node tools/session-api-selftest.mjs`
Expected: `0` puis les trois suites sans `✗`, exit 0.

- [ ] **Step 5 : Commit**

```bash
git add tools/target-model.mjs tools/session-model.mjs tools/target-selftest.mjs tools/session-selftest.mjs src/main.js
git commit -m "feat(session): la cible garde son scan, le resume rejoue l'exemplaire (#250)"
```

---

### Task 2 : `src/ambient.js` — l'ensemble ambiant et les paramètres de routine par famille

**Files:**
- Create: `src/ambient.js`
- Test: `tools/ambient-selftest.mjs` (nouveau)
- Modify: `package.json` (chaîne `selftest:operator`)

**Interfaces:**
- Produces:
  - `rngFrom(seed) → () => number` (FNV-1a + xorshift, copie de `src/entry-state.js:20`)
  - `ambientSet(scan: {seed,count,index}) → Array<{ i, id, family, buildSeed, rssiDbm, mode }>`
  - `ROUTINES: Record<family, { kind, agl:[min,max], speed:[min,max], radius:[min,max] }>`
  - `lateralAccelMax(twr) → m/s²`
  - `routineFor({ family, twr, rand }) → { kind, family, aglMin, agl, speed, radius, dir:±1, phase, tiltPlane, jitter:[{amp,hz,phase}×3], period }`
  - `MAX_DRONES = 4`, `G = 9.81`, `TURN_MARGIN = 0.6`

- [ ] **Step 1 : Squelette du selftest et tests qui échouent**

Créer `tools/ambient-selftest.mjs` :

```js
// node tools/ambient-selftest.mjs
//
// Le modèle PUR des drones ambiants (issue #250) : ensemble, routines,
// courbes, bulle, ancres, validation à rayons stubs, attitude. Rien de Three,
// rien de Rapier — les rayons sont des fonctions injectées, comme dans
// tools/entry-state-selftest.mjs.

import {
	rngFrom, ambientSet, ROUTINES, lateralAccelMax, routineFor,
	MAX_DRONES, G, TURN_MARGIN,
} from '../src/ambient.js';
import { generateTargetScan, TARGET_FAMILIES } from './target-model.mjs';
import { targetBuild } from './target-build.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('ambient: ensemble');
{
	const scan = { seed: 'set-a', count: 5, index: 2 };
	const set = ambientSet(scan);
	const full = generateTargetScan({ seed: 'set-a', count: 5 }).candidates;
	check('n = count - 1', set.length === 4, `${set.length}`);
	check('le pris est absent', set.every((d) => d.i !== 2));
	check('familles = celles des candidats non pris',
		set.every((d) => d.family === full[d.i]._family));
	check('buildSeed = seed::i', set.every((d) => d.buildSeed === `set-a::${d.i}`));
	check('mode = le vrai mode vidéo', set.every((d) => d.mode === full[d.i]._videoHint));
	check('même scan → même ensemble',
		JSON.stringify(ambientSet(scan)) === JSON.stringify(set));
	check('count 2 → 1 ambiant', ambientSet({ seed: 'z', count: 2, index: 0 }).length === 1);
	check('jamais plus de MAX_DRONES', ambientSet({ seed: 'z', count: 5, index: 0 }).length <= MAX_DRONES);
}

console.log('\nambient: routines');
{
	check('une routine par famille', TARGET_FAMILIES.every((f) => ROUTINES[f]));
	check('a_max(twr=2) = g·√3', Math.abs(lateralAccelMax(2) - G * Math.sqrt(3)) < 1e-9);
	check('a_max(twr≤1) = 0', lateralAccelMax(1) === 0 && lateralAccelMax(0.5) === 0);

	for (const family of TARGET_FAMILIES) {
		const build = targetBuild({ seed: `r::${family}`, family });
		const r = routineFor({ family, twr: build.spec.twr, rand: rngFrom(`rt::${family}`) });
		const spec = ROUTINES[family];
		check(`${family}: vitesse dans la plage`, r.speed >= spec.speed[0] - 1e-9 && r.speed <= spec.speed[1] + 1e-9, `${r.speed.toFixed(1)}`);
		check(`${family}: rayon dans la plage`, r.radius >= spec.radius[0] && r.radius <= spec.radius[1]);
		check(`${family}: AGL dans la plage`, r.agl >= spec.agl[0] && r.agl <= spec.agl[1]);
		check(`${family}: v²/r ≤ 0,6·a_max`, r.speed * r.speed / r.radius <= TURN_MARGIN * lateralAccelMax(build.spec.twr) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(TURN_MARGIN * lateralAccelMax(build.spec.twr)).toFixed(1)}`);
		check(`${family}: période > 0`, r.period > 0);
	}
	const a = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	const b = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	check('même graine → même routine', JSON.stringify(a) === JSON.stringify(b));
	check('le micro a du jitter', routineFor({ family: 'toothpick', twr: 3, rand: rngFrom('j') }).jitter.length === 3);
	check('le cinewhoop n\'en a pas', routineFor({ family: 'cinewhoop', twr: 2.8, rand: rngFrom('j') }).jitter.length === 0);
	// Un TWR faible ramène la vitesse : à twr 1,5 sur 15 m de rayon, v ≤ √(0,6·g·√1,25·15)
	const slow = routineFor({ family: 'race5', twr: 1.5, rand: rngFrom('slow') });
	check('TWR faible plafonne la vitesse', slow.speed * slow.speed / slow.radius <= TURN_MARGIN * lateralAccelMax(1.5) + 1e-9);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

Ajouter à la fin de `selftest:operator` dans `package.json` : `&& node tools/ambient-selftest.mjs`.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: erreur d'import `Cannot find module '../src/ambient.js'`.

- [ ] **Step 3 : Implémenter**

Créer `src/ambient.js` :

```js
// Drones ambiants (issue #250) — le modèle PUR. Ni Three, ni Rapier, ni DOM :
// les rayons sont des fonctions injectées ({ groundBelow, obstructionBetween }
// duck-typé comme src/entry-state.js), le rendu vit dans src/drone-mesh.js et
// le son dans src/ambient-audio.js.
//
// Ce fichier tient : l'ensemble (qui vole), les routines (comment chaque
// famille vole), les courbes (où), la bulle (autour de qui), les ancres et
// leur validation, l'attitude (comment le corps se tient). Tout est
// déterministe sur la graine du scan, et update() n'alloue rien.

import { generateTargetScan } from '../tools/target-model.mjs';

export const G = 9.81;
export const MAX_DRONES = 4;
// v²/r ≤ TURN_MARGIN · a_max : un quad ne vire pas en butée de poussée.
export const TURN_MARGIN = 0.6;

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
// tools/target-model.mjs, src/entry-state.js et src/link.js).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

const lerp = (rand, [a, b]) => a + rand() * (b - a);

// Les candidats non pris, avec la graine d'exemplaire que resolveTarget()
// leur aurait donnée. Pur et déterministe : le même scan rend le même ciel.
export function ambientSet(scan) {
	const { candidates } = generateTargetScan({ seed: scan.seed, count: scan.count });
	const out = [];
	for (let i = 0; i < candidates.length; i++) {
		if (i === scan.index) continue;
		const c = candidates[i];
		out.push({
			i, id: c.id, family: c._family,
			buildSeed: `${scan.seed}::${i}`,
			rssiDbm: c.rssiDbm, mode: c._videoHint,
		});
		if (out.length === MAX_DRONES) break;
	}
	return out;
}

// Une routine par famille. Plages choisies à l'oreille de pilote, comme
// RANGES de l'entry state ; c'est le filet (validation) qui rend chaque
// tirage juste, pas la plage. `radius` du long range = rayon du demi-tour.
export const ROUTINES = {
	race5: { kind: 'loop', agl: [3, 10], speed: [15, 22], radius: [12, 20] },
	freestyle5: { kind: 'eight', agl: [10, 40], speed: [12, 18], radius: [18, 28], vertical: 8 },
	heavy5: { kind: 'eight', agl: [10, 30], speed: [9, 14], radius: [22, 30], vertical: 0 },
	cinewhoop: { kind: 'orbit', agl: [15, 30], speed: [3, 6], radius: [10, 25], faceAnchor: true },
	longrange: { kind: 'cruise', agl: [60, 120], speed: [18, 26], radius: [120, 120], leg: 400 },
	toothpick: { kind: 'orbit', agl: [1, 5], speed: [2, 5], radius: [4, 8], jitter: true },
};

// Accélération latérale maximale d'un quad de rapport poussée/poids twr :
// la poussée doit d'abord porter le poids, le reste vire.
export function lateralAccelMax(twr) {
	return twr > 1 ? G * Math.sqrt(twr * twr - 1) : 0;
}

export function routineFor({ family, twr, rand }) {
	const spec = ROUTINES[family];
	if (!spec) throw new Error(`famille sans routine : ${family}`);
	const radius = lerp(rand, spec.radius);
	const agl = lerp(rand, spec.agl);
	let speed = lerp(rand, spec.speed);
	// Le TWR borne le virage — le seul point où le build change la routine.
	const vMax = Math.sqrt(TURN_MARGIN * lateralAccelMax(twr) * radius);
	if (speed > vMax) speed = Math.max(spec.speed[0] * 0.5, vMax);
	const dir = rand() < 0.5 ? -1 : 1;
	const phase = rand() * Math.PI * 2;
	// Plan de la boucle du race : incliné de 10 à 35° pour que la boucle ne
	// soit pas un cercle plat — un race prend de la hauteur en sortie de virage.
	const tiltPlane = spec.kind === 'loop' ? (10 + rand() * 25) * Math.PI / 180 : 0;
	const jitter = spec.jitter
		? [0.7, 1.3, 2.1].map((hz) => ({ amp: 0.3, hz, phase: rand() * Math.PI * 2 }))
		: [];
	let period;
	if (spec.kind === 'cruise') period = (2 * spec.leg + Math.PI * radius) / speed;
	else if (spec.kind === 'eight') period = 2 * (2 * Math.PI * radius) / speed;
	else period = (2 * Math.PI * radius) / speed;
	return {
		kind: spec.kind, family, aglMin: spec.agl[0], agl, speed, radius, dir, phase,
		tiltPlane, vertical: spec.vertical ?? 0, leg: spec.leg ?? 0,
		faceAnchor: !!spec.faceAnchor, jitter, period,
	};
}
```

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: `all PASS`, exit 0.

- [ ] **Step 5 : Commit**

```bash
git add src/ambient.js tools/ambient-selftest.mjs package.json
git commit -m "feat(ambiants): ensemble des candidats non pris et routines par famille (#250)"
```

---

### Task 3 : `src/ambient.js` — les courbes et leurs dérivées

**Files:**
- Modify: `src/ambient.js`
- Test: `tools/ambient-selftest.mjs`

**Interfaces:**
- Produces:
  - `curveLocal(routine, t, out) → out {x,y,z}` : offset par rapport à l'ancre, `y` = offset vertical **sans** l'AGL (0 sur le plan de la routine).
  - `SAMPLES = 16` ; `curveHeights(routine, anchor, groundBelow, heights: Float64Array(16)) → boolean` : hauteur absolue de la courbe à chaque échantillon = sol + `agl`, `false` si un sol manque.
  - `curveAt(routine, anchor, heights, t, out) → out {x,y,z}` : position absolue, `y` interpolé linéairement entre échantillons + `curveLocal().y`.
  - `derive(routine, anchor, heights, t, h, pos, vel, acc)` : différences centrées, pas `h`.

- [ ] **Step 1 : Tests qui échouent**

Ajouter à `tools/ambient-selftest.mjs` (import : `curveLocal, curveHeights, curveAt, derive, SAMPLES`) :

```js
console.log('\nambient: courbes');
{
	const out = { x: 0, y: 0, z: 0 };
	const anchor = { x: 100, y: 0, z: -50 };
	const flat = { groundBelow: () => 20 };
	for (const family of TARGET_FAMILIES) {
		const r = routineFor({ family, twr: 6, rand: rngFrom(`c::${family}`) });
		// Fermée : p(0) = p(period).
		curveLocal(r, 0, out); const p0 = { ...out };
		curveLocal(r, r.period, out);
		check(`${family}: courbe fermée`, Math.hypot(out.x - p0.x, out.y - p0.y, out.z - p0.z) < 1e-6);
		// Rayon respecté (hors jitter : ±0,9 m max pour 3 sinus de 0,3).
		let maxR = 0;
		for (let i = 0; i < 200; i++) { curveLocal(r, r.period * i / 200, out); maxR = Math.max(maxR, Math.hypot(out.x, out.z)); }
		const bound = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
		check(`${family}: rayon horizontal ≤ borne`, maxR <= bound + 1.0, `${maxR.toFixed(1)} vs ${bound.toFixed(1)}`);
		// Hauteurs : sol plat à 20 → courbe à 20 + agl partout (± sinus vertical).
		const heights = new Float64Array(SAMPLES);
		check(`${family}: hauteurs calculées`, curveHeights(r, anchor, flat.groundBelow, heights));
		check(`${family}: hauteur = sol + agl`, Array.from(heights).every((h) => Math.abs(h - (20 + r.agl)) < 1e-9));
		curveAt(r, anchor, heights, r.period * 0.37, out);
		check(`${family}: curveAt au-dessus du sol`, out.y >= 20 + r.aglMin - r.vertical - 1e-9);
		// Vitesse dérivée ≈ vitesse tirée (à 10 % : les huit et le jitter déforment).
		const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, acc = { x: 0, y: 0, z: 0 };
		let vAvg = 0; const N = 100;
		for (let i = 0; i < N; i++) { derive(r, anchor, heights, r.period * i / N, 1 / 60, pos, vel, acc); vAvg += Math.hypot(vel.x, vel.z) / N; }
		check(`${family}: |v| dérivée ≈ speed`, Math.abs(vAvg - r.speed) / r.speed < 0.12, `${vAvg.toFixed(1)} vs ${r.speed.toFixed(1)}`);
		check(`${family}: accélération finie`, Number.isFinite(acc.x) && Number.isFinite(acc.y) && Number.isFinite(acc.z));
	}
	// Un sol manquant fait échouer les hauteurs.
	const r = routineFor({ family: 'race5', twr: 6, rand: rngFrom('hole') });
	const heights = new Float64Array(SAMPLES);
	check('sol null → false', curveHeights(r, anchor, (x) => (x > 100 ? null : 0), heights) === false);
	// Le relief est suivi : sol en pente → hauteurs différentes aux deux bouts.
	const slope = (x) => x * 0.1;
	curveHeights(r, anchor, slope, heights);
	check('le relief est suivi', Math.max(...heights) - Math.min(...heights) > 1);
}
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: erreur d'import (`curveLocal` non exporté).

- [ ] **Step 3 : Implémenter**

Ajouter à `src/ambient.js` :

```js
export const SAMPLES = 16;
const TWO_PI = Math.PI * 2;

// Offset par rapport à l'ancre, à l'instant t, dans le plan de la routine.
// `y` est l'offset VERTICAL de la figure seule (sinus du huit, plan incliné
// du race, jitter du micro) — l'AGL et le relief sont ajoutés par curveAt().
export function curveLocal(r, t, out) {
	const u = (t / r.period) * TWO_PI * r.dir + r.phase;
	switch (r.kind) {
		case 'loop': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			// Plan incliné : la hauteur suit une des deux composantes.
			out.y = Math.sin(r.tiltPlane) * r.radius * Math.sin(u);
			break;
		}
		case 'orbit': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			out.y = 0;
			break;
		}
		case 'eight': {
			// Lemniscate de Gerono, deux lobes de rayon ~r : période = deux tours.
			const w = u / 2;
			out.x = 2 * r.radius * Math.cos(w);
			out.z = r.radius * Math.sin(2 * w);
			out.y = r.vertical * Math.sin(w * 2 + 1);
			break;
		}
		case 'cruise': {
			// Stade : deux segments de `leg`, deux demi-tours de rayon `radius`.
			const L = r.leg, R = r.radius;
			const total = 2 * L + Math.PI * R;
			let s = ((t * r.speed * r.dir) % total + total) % total;
			out.y = 0;
			if (s < L) { out.x = -L / 2 + s; out.z = -R / 2; }
			else if (s < L + Math.PI * R / 2) {
				const a = (s - L) / R;
				out.x = L / 2 + R / 2 * Math.sin(a); out.z = -R / 2 + R / 2 * (1 - Math.cos(a));
			} else if (s < 2 * L + Math.PI * R / 2) { s -= L + Math.PI * R / 2; out.x = L / 2 - s; out.z = R / 2; }
			else {
				const a = (s - 2 * L - Math.PI * R / 2) / R;
				out.x = -L / 2 - R / 2 * Math.sin(a); out.z = R / 2 - R / 2 * (1 - Math.cos(a));
			}
			break;
		}
		default: throw new Error(`routine inconnue : ${r.kind}`);
	}
	for (let k = 0; k < r.jitter.length; k++) {
		const j = r.jitter[k];
		const s = Math.sin(TWO_PI * j.hz * t + j.phase);
		out.x += j.amp * s; out.z += j.amp * Math.cos(TWO_PI * j.hz * t * 0.7 + j.phase); out.y += j.amp * 0.5 * s;
	}
	return out;
}

const _c = { x: 0, y: 0, z: 0 };

// Hauteur absolue de la courbe à chacun des SAMPLES échantillons : sol + agl.
// `groundBelow(x, z)` rend la hauteur du sol ou null (pas de terrain).
export function curveHeights(r, anchor, groundBelow, heights) {
	for (let i = 0; i < SAMPLES; i++) {
		curveLocal(r, r.period * i / SAMPLES, _c);
		const g = groundBelow(anchor.x + _c.x, anchor.z + _c.z);
		if (g == null) return false;
		heights[i] = g + r.agl;
	}
	return true;
}

// Position absolue : XZ de la courbe, Y interpolé entre les hauteurs
// échantillonnées (le micro épouse le relief) plus l'offset de la figure.
export function curveAt(r, anchor, heights, t, out) {
	curveLocal(r, t, out);
	const f = ((t / r.period) % 1 + 1) % 1 * SAMPLES;
	const i = Math.floor(f) % SAMPLES, j = (i + 1) % SAMPLES, a = f - Math.floor(f);
	const y = heights[i] * (1 - a) + heights[j] * a;
	out.x += anchor.x; out.z += anchor.z; out.y += y;
	return out;
}

const _pm = { x: 0, y: 0, z: 0 }, _pp = { x: 0, y: 0, z: 0 };

// Position, vitesse et accélération par différences centrées de pas h.
export function derive(r, anchor, heights, t, h, pos, vel, acc) {
	curveAt(r, anchor, heights, t, pos);
	curveAt(r, anchor, heights, t - h, _pm);
	curveAt(r, anchor, heights, t + h, _pp);
	vel.x = (_pp.x - _pm.x) / (2 * h); vel.y = (_pp.y - _pm.y) / (2 * h); vel.z = (_pp.z - _pm.z) / (2 * h);
	acc.x = (_pp.x - 2 * pos.x + _pm.x) / (h * h);
	acc.y = (_pp.y - 2 * pos.y + _pm.y) / (h * h);
	acc.z = (_pp.z - 2 * pos.z + _pm.z) / (h * h);
}
```

Note pour l'implémenteur : si le test `|v| dérivée ≈ speed` échoue pour `eight` (la lemniscate n'est pas à vitesse constante), remplacer la paramétrisation par un reparamétrage par abscisse curviligne : pré-calculer 64 longueurs cumulées dans `routineFor` (`r.arc = Float64Array(65)`) et inverser par interpolation dans `curveLocal`. Ne pas relâcher la tolérance du test.

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: `all PASS`.

- [ ] **Step 5 : Commit**

```bash
git add src/ambient.js tools/ambient-selftest.mjs
git commit -m "feat(ambiants): courbes par routine, relief suivi, dérivées (#250)"
```

---

### Task 4 : `src/ambient.js` — bulle, ancres, validation, relocalisation

**Files:**
- Modify: `src/ambient.js`
- Test: `tools/ambient-selftest.mjs`

**Interfaces:**
- Produces:
  - `R_SPAWN = [120, 250]`, `R_LEAVE = 320`, `R_LEAVE_GAP = 70`, `IN_VIEW_MIN_M = 220`, `VIEW_MARGIN_DEG = 15`, `BLOCK_SPAN_M = 2`
  - `bubbleFor(bounds, player) → { rMin, rMax, rLeave }` avec `bounds = { bbox, corridor: {hold} } | { center: {x,z}|null, trusted: number }`
  - `insideBounds(bounds, x, z, y, margin) → boolean`
  - `outOfView(dx, dz, dy, cam: {fx,fy,fz}, fovDeg) → boolean`
  - `pickAnchor({ rand, player, cam, fovDeg, bounds, radius, rays, top, span }) → { x, y, z } | null` (1 rayon)
  - `validateCurve({ routine, anchor, rays, heights, top, span }) → boolean` (48 rayons)
  - `class AmbientModel { constructor({ set, builds, bounds, seed }); spawnOne({ player, cam, fovDeg, rays, top, span }) → boolean; update({ dt, player, cam, fovDeg, rays, top, span, wind }); reset(); count; pos, vel, acc, quat: Float64Array; families: string[]; stats: { relocations, raysCast, spawnFailures } }`

- [ ] **Step 1 : Tests qui échouent**

Ajouter à `tools/ambient-selftest.mjs` (import : `R_SPAWN, R_LEAVE, bubbleFor, insideBounds, outOfView, pickAnchor, validateCurve, AmbientModel`) :

```js
console.log('\nambient: bulle, ancres, validation');
{
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const smallRect = { bbox: { min: [-90, 0, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const live = { center: { x: 0, z: 0 }, trusted: 180 };
	const noLive = { center: null, trusted: 180 };
	const player = { x: 0, y: 30, z: 0 };
	const cam = { fx: 0, fy: 0, fz: -1 };   // regarde vers −Z (nord)
	const flat = (x, z) => 0;
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const wallRays = { groundBelow: () => 0, obstructionBetween: (ax, ay, az, bx) => ({ blocked: bx > 50, span: bx > 50 ? 6 : 0 }) };

	const b = bubbleFor(bigRect, player);
	check('grande carte : couronne nominale', b.rMin === R_SPAWN[0] && b.rMax === R_SPAWN[1] && b.rLeave === R_LEAVE);
	const s = bubbleFor(smallRect, player);
	check('petite carte : couronne resserrée', s.rMax === 80 && s.rMin <= s.rMax);
	check('petite carte : jamais de départ', s.rLeave === Infinity);
	const l = bubbleFor(live, player);
	check('direct : rMax = rayon de confiance', l.rMax === 180 && l.rLeave === 250);

	check('outOfView : derrière', outOfView(0, 100, 0, cam, 120) === true);
	check('outOfView : devant', outOfView(0, -100, 0, cam, 120) === false);
	check('outOfView : sur le bord + marge', outOfView(Math.sin(70 * Math.PI / 180) * 100, -Math.cos(70 * Math.PI / 180) * 100, 0, cam, 120) === false);
	check('outOfView : au-delà de la marge', outOfView(Math.sin(80 * Math.PI / 180) * 100, -Math.cos(80 * Math.PI / 180) * 100, 0, cam, 120) === true);

	check('insideBounds rect : dedans', insideBounds(bigRect, 0, 0, 10, 30));
	check('insideBounds rect : bord', !insideBounds(bigRect, 1990, 0, 10, 30));
	check('insideBounds rect : sous le plancher', !insideBounds(bigRect, 0, 0, 2, 30));
	check('insideBounds live : dedans', insideBounds(live, 100, 0, 10, 30));
	check('insideBounds live : dehors', !insideBounds(live, 170, 0, 10, 30));
	check('insideBounds live sans centre : jamais', !insideBounds(noLive, 0, 0, 10, 30));

	// 200 ancres tirées : toutes dans la couronne, hors champ ou > 220 m, dans la clôture.
	const rand = rngFrom('anchors');
	let ok = 0, n = 0;
	for (let i = 0; i < 200; i++) {
		const a = pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays, top: 250, span: 400 });
		if (!a) continue;
		n++;
		const d = Math.hypot(a.x - player.x, a.z - player.z);
		const inRing = d >= R_SPAWN[0] - 1e-9 && d <= R_SPAWN[1] + 1e-9;
		const hidden = outOfView(a.x - player.x, a.z - player.z, a.y - player.y, cam, 120) || d >= 220;
		if (inRect(a) && inRing && hidden) ok++;
	}
	function inRect(a) { return insideBounds(bigRect, a.x, a.z, a.y, 20); }
	check('200 ancres : toutes conformes', n > 150 && ok === n, `${ok}/${n}`);
	check('pas de sol → pas d\'ancre', pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400 }) === null);

	// Validation : plat → ok ; mur → rejet ; sol trop haut sous un point → rejet.
	const r = routineFor({ family: 'freestyle5', twr: 6, rand: rngFrom('v') });
	const heights = new Float64Array(SAMPLES);
	check('courbe sur du plat : valide', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays, heights, top: 250, span: 400 }));
	check('courbe contre un mur : rejetée', !validateCurve({ routine: r, anchor: { x: 40, y: 0, z: 0 }, rays: wallRays, heights, top: 250, span: 400 }));
	const bump = { groundBelow: (x) => (x > 10 ? 200 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('courbe dont un point est sous le relief : rejetée', !validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: bump, heights, top: 250, span: 400 }));
	// Un toit frôlé (span ≤ 2) passe.
	const roof = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: true, span: 1.5 }) };
	check('toit frôlé : accepté', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: roof, heights, top: 250, span: 400 }));
}

console.log('\nambient: modèle');
{
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const scan = { seed: 'model-a', count: 5, index: 0 };
	const set = ambientSet(scan);
	const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
	const mk = () => new AmbientModel({ set, builds, bounds: bigRect, seed: scan.seed });
	const cam = { fx: 0, fy: 0, fz: -1 };
	const wind = { x: 0, y: 0, z: 0 };
	const player = { x: 0, y: 30, z: 0 };
	const frame = (m, p, dt = 1 / 60) => m.update({ dt, player: p, cam, fovDeg: 120, rays, top: 250, span: 400, wind });

	const m = mk();
	check('vide au départ', m.count === 0);
	frame(m, player);
	check('une naissance par frame', m.count === 1);
	for (let i = 0; i < 3; i++) frame(m, player);
	check('quatre après quatre frames', m.count === 4, `${m.count}`);
	frame(m, player);
	check('jamais plus que l\'ensemble', m.count === 4);
	check('familles = ensemble', m.families.join() === set.map((d) => d.family).join());

	// Déterminisme.
	const m2 = mk();
	for (let i = 0; i < 4; i++) frame(m2, player);
	check('même graine → mêmes ancres', Array.from(m.anchors).every((v, i) => v === m2.anchors[i]));

	// dt 0 : rien ne bouge, rien ne naît.
	const before = Array.from(m.pos);
	m.update({ dt: 0, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
	check('dt 0 : immobile', Array.from(m.pos).every((v, i) => v === before[i]));

	// Zéro allocation : mêmes références.
	const refs = [m.pos, m.vel, m.acc, m.quat, m.anchors];
	for (let i = 0; i < 1000; i++) frame(m, player);
	check('update n\'alloue pas', refs.every((r, i) => r === [m.pos, m.vel, m.acc, m.quat, m.anchors][i]));
	check('positions finies', Array.from(m.pos).every(Number.isFinite));

	// Relocalisation : joueur déplacé de 400 m → toutes les ancres renaissent.
	const far = { x: 400, y: 30, z: 0 };
	const anchorsBefore = Array.from(m.anchors);
	for (let i = 0; i < 5; i++) frame(m, far);
	check('400 m : toutes relocalisées', m.stats.relocations >= 4, `${m.stats.relocations}`);
	check('400 m : nouvelles ancres dans la couronne autour du joueur',
		[0, 1, 2, 3].every((k) => { const d = Math.hypot(m.anchors[3 * k] - far.x, m.anchors[3 * k + 2] - far.z); return d >= R_SPAWN[0] && d <= R_SPAWN[1]; }));
	check('400 m : ancres différentes', anchorsBefore.some((v, i) => v !== m.anchors[i]));
	// 60 m : aucune.
	const before60 = m.stats.relocations;
	for (let i = 0; i < 5; i++) frame(m, { x: 460, y: 30, z: 0 });
	check('60 m : aucune relocalisation', m.stats.relocations === before60);

	// Petite carte : tout dedans, jamais de départ.
	const small = { bbox: { min: [-90, 0, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const ms = new AmbientModel({ set, builds, bounds: small, seed: 's' });
	for (let i = 0; i < 6; i++) frame(ms, player);
	check('petite carte : des drones naissent', ms.count >= 1);
	for (let i = 0; i < 60; i++) frame(ms, { x: 80, y: 30, z: 80 });
	check('petite carte : jamais de départ', ms.stats.relocations === 0);
	check('petite carte : positions dans la clôture', [...Array(ms.count).keys()].every((k) => Math.abs(ms.pos[3 * k]) < 90 && Math.abs(ms.pos[3 * k + 2]) < 90));

	// Sol absent (direct pas chargé) : rien ne naît, échecs comptés, pas d'exception.
	const mh = new AmbientModel({ set, builds, bounds: { center: { x: 0, z: 0 }, trusted: 180 }, seed: 'h' });
	for (let i = 0; i < 20; i++) mh.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400, wind });
	check('sans sol : aucune naissance', mh.count === 0 && mh.stats.spawnFailures > 0);
	check('rayons comptés', mh.stats.raysCast > 0);

	// reset : recommence à zéro autour du joueur.
	m.reset();
	check('reset : vide', m.count === 0);
}
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: erreur d'import (`bubbleFor` non exporté).

- [ ] **Step 3 : Implémenter**

Ajouter à `src/ambient.js` :

```js
export const R_SPAWN = [120, 250];
export const R_LEAVE = 320;
export const R_LEAVE_GAP = 70;      // rLeave = rMax + gap quand la couronne se resserre
export const IN_VIEW_MIN_M = 220;   // dans le champ, on ne naît qu'au-delà
export const VIEW_MARGIN_DEG = 15;
export const BLOCK_SPAN_M = 2;      // règle de geometrySafe : un mur, pas un toit frôlé
export const FLOOR_MARGIN_M = 5;    // au-dessus de FLOOR_HOLD de la clôture
const SPAWN_TRIES_PER_FRAME = 3;

// La couronne, bornée par la clôture. Rect : `halfMin - hold` ; direct : le
// rayon de confiance (180 m par défaut, sous les 250 nominaux). Une carte qui
// ne loge pas la couronne minimale garde ses drones pour toujours.
export function bubbleFor(bounds, player) {
	let rMax = R_SPAWN[1];
	if (bounds.bbox) {
		const halfMin = Math.min(
			(bounds.bbox.max[0] - bounds.bbox.min[0]) / 2,
			(bounds.bbox.max[2] - bounds.bbox.min[2]) / 2,
		);
		rMax = Math.min(rMax, halfMin - bounds.corridor.hold);
	} else {
		rMax = Math.min(rMax, bounds.trusted);
	}
	if (rMax < R_SPAWN[0]) return { rMin: 0, rMax: Math.max(rMax, 10), rLeave: Infinity };
	const rLeave = rMax < R_SPAWN[1] ? rMax + R_LEAVE_GAP : R_LEAVE;
	return { rMin: R_SPAWN[0], rMax, rLeave };
}

// Un point tient-il dans la clôture, avec `margin` (rayon de routine) en plus ?
export function insideBounds(bounds, x, z, y, margin) {
	if (bounds.bbox) {
		const b = bounds.bbox;
		const m = bounds.corridor.hold + margin;
		return x >= b.min[0] + m && x <= b.max[0] - m
			&& z >= b.min[2] + m && z <= b.max[2] - m
			&& y >= b.min[1] + FLOOR_MARGIN_M;
	}
	if (!bounds.center) return false;
	return Math.hypot(x - bounds.center.x, z - bounds.center.z) + margin <= bounds.trusted;
}

// Hors du cône caméra (FOV + marge) ?
export function outOfView(dx, dz, dy, cam, fovDeg) {
	const d = Math.hypot(dx, dy, dz);
	if (d === 0) return false;
	const cosA = (dx * cam.fx + dy * cam.fy + dz * cam.fz) / d;
	return cosA < Math.cos((fovDeg / 2 + VIEW_MARGIN_DEG) * Math.PI / 180);
}

// Une ancre dans la couronne, hors champ, dans la clôture, sur du sol. Un
// rayon. `top`/`span` : d'où et sur quelle longueur lancer vers le bas
// (haut de bbox + 50 et hauteur + 100, comme groundAt de l'entry state).
export function pickAnchor({ rand, player, cam, fovDeg, bounds, radius, rays, top, span, stats }) {
	const { rMin, rMax } = bubbleFor(bounds, player);
	const d = rMin + rand() * (rMax - rMin);
	const a = rand() * TWO_PI;
	const x = player.x + d * Math.cos(a), z = player.z + d * Math.sin(a);
	if (stats) stats.raysCast++;
	const g = rays.groundBelow(x, top, z, span);
	if (g == null) return null;
	const y = g;
	if (!insideBounds(bounds, x, z, y, radius)) return null;
	if (d < IN_VIEW_MIN_M && !outOfView(x - player.x, z - player.z, y - player.y, cam, fovDeg)) return null;
	return { x, y, z };
}

const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 };

// 16 rayons vers le bas (hauteurs), 16 obstructions entre voisins.
export function validateCurve({ routine, anchor, rays, heights, top, span, stats }) {
	const ground = (x, z) => { if (stats) stats.raysCast++; return rays.groundBelow(x, top, z, span); };
	if (!curveHeights(routine, anchor, ground, heights)) return false;
	for (let i = 0; i < SAMPLES; i++) {
		// La figure peut descendre sous l'AGL tiré (sinus, plan incliné) :
		// c'est l'AGL MINIMAL de la famille qui compte, au point le plus bas.
		curveAt(routine, anchor, heights, routine.period * i / SAMPLES, _a);
		const g = heights[i] - routine.agl;
		if (_a.y - g < routine.aglMin) return false;
		curveAt(routine, anchor, heights, routine.period * (i + 1) / SAMPLES, _b);
		if (stats) stats.raysCast += 2;
		const o = rays.obstructionBetween(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
		if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	}
	return true;
}

export class AmbientModel {
	constructor({ set, builds, bounds, seed }) {
		if (set.length > MAX_DRONES) throw new Error('trop d\'ambiants');
		this.set = set;
		this.builds = builds;
		this.bounds = bounds;
		this.seed = seed;
		this.families = set.map((d) => d.family);
		this.n = set.length;
		// Un slot par ambiant possible ; `alive[k]` dit s'il vole.
		this.alive = new Uint8Array(MAX_DRONES);
		this.pos = new Float64Array(3 * MAX_DRONES);
		this.vel = new Float64Array(3 * MAX_DRONES);
		this.acc = new Float64Array(3 * MAX_DRONES);
		this.quat = new Float64Array(4 * MAX_DRONES);
		this.anchors = new Float64Array(3 * MAX_DRONES);
		this.heights = Array.from({ length: MAX_DRONES }, () => new Float64Array(SAMPLES));
		this.routines = new Array(MAX_DRONES).fill(null);
		this.t = new Float64Array(MAX_DRONES);
		this.stats = { relocations: 0, raysCast: 0, spawnFailures: 0 };
		this._pos = { x: 0, y: 0, z: 0 }; this._vel = { x: 0, y: 0, z: 0 }; this._acc = { x: 0, y: 0, z: 0 };
		this._anchor = { x: 0, y: 0, z: 0 };
		this.reset();
	}

	get count() { let c = 0; for (let k = 0; k < this.n; k++) c += this.alive[k]; return c; }

	reset() {
		this.alive.fill(0);
		this.t.fill(0);
		this.rand = rngFrom(`${this.seed}::ambient`);
		for (let k = 0; k < this.n; k++) {
			this.routines[k] = routineFor({
				family: this.set[k].family, twr: this.builds[k].spec.twr,
				rand: rngFrom(`${this.set[k].buildSeed}::ambient::routine`),
			});
			this.quat[4 * k + 3] = 1;
		}
	}

	// Fait naître le premier slot mort. Rend true si un drone est né.
	spawnOne({ player, cam, fovDeg, rays, top, span }) {
		for (let k = 0; k < this.n; k++) {
			if (this.alive[k]) continue;
			const r = this.routines[k];
			const radius = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
			for (let tries = 0; tries < SPAWN_TRIES_PER_FRAME; tries++) {
				const a = pickAnchor({ rand: this.rand, player, cam, fovDeg, bounds: this.bounds, radius, rays, top, span, stats: this.stats });
				if (!a) { this.stats.spawnFailures++; continue; }
				if (!validateCurve({ routine: r, anchor: a, rays, heights: this.heights[k], top, span, stats: this.stats })) {
					this.stats.spawnFailures++; continue;
				}
				this.anchors[3 * k] = a.x; this.anchors[3 * k + 1] = a.y; this.anchors[3 * k + 2] = a.z;
				this.t[k] = this.rand() * r.period;
				this.alive[k] = 1;
				this._place(k, 1 / 60);
				return true;
			}
			return false;   // un slot par frame, réussi ou non
		}
		return false;
	}

	_place(k, h) {
		const r = this.routines[k];
		this._anchor.x = this.anchors[3 * k]; this._anchor.y = this.anchors[3 * k + 1]; this._anchor.z = this.anchors[3 * k + 2];
		derive(r, this._anchor, this.heights[k], this.t[k], h, this._pos, this._vel, this._acc);
		this.pos[3 * k] = this._pos.x; this.pos[3 * k + 1] = this._pos.y; this.pos[3 * k + 2] = this._pos.z;
		this.vel[3 * k] = this._vel.x; this.vel[3 * k + 1] = this._vel.y; this.vel[3 * k + 2] = this._vel.z;
		this.acc[3 * k] = this._acc.x; this.acc[3 * k + 1] = this._acc.y; this.acc[3 * k + 2] = this._acc.z;
	}

	update({ dt, player, cam, fovDeg, rays, top, span, wind }) {
		if (dt <= 0) return;
		const { rLeave } = bubbleFor(this.bounds, player);
		// Départs : l'ancre a quitté la bulle.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			const d = Math.hypot(this.anchors[3 * k] - player.x, this.anchors[3 * k + 2] - player.z);
			if (d > rLeave) { this.alive[k] = 0; this.stats.relocations++; }
		}
		// Une naissance au plus par frame.
		this.spawnOne({ player, cam, fovDeg, rays, top, span });
		// Avance et pose.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			this.t[k] += dt;
			this._place(k, Math.min(dt, 1 / 60));
			this._attitude(k, dt, wind);
		}
	}

	_attitude() { /* Task 5 */ }
}
```

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: `all PASS`. Si `200 ancres : toutes conformes` échoue sur `n > 150`, c'est que trop de tirages tombent dans le champ sous 220 m ; c'est attendu à ~40 % de rejet, `n` doit rester > 150 sur 200 — sinon vérifier `outOfView` (signe de `fz`).

- [ ] **Step 5 : Commit**

```bash
git add src/ambient.js tools/ambient-selftest.mjs
git commit -m "feat(ambiants): bulle, ancres hors champ, validation à 49 rayons, relocalisation (#250)"
```

---

### Task 5 : `src/ambient.js` — l'attitude vient du mouvement

**Files:**
- Modify: `src/ambient.js`
- Test: `tools/ambient-selftest.mjs`

**Interfaces:**
- Produces:
  - `attitudeFrom({ ax, ay, az, vx, vy, vz, wind, drag, mass, yawX, yawZ }, out: Float64Array, o)` : écrit le quaternion `(x,y,z,w)` à `out[o..o+3]`.
  - `tiltOf(quat, o) → radians` (angle entre Y corps et Y monde) — utilitaire de test et de debug.
  - `AmbientModel.update()` remplit `quat` ; lissage τ = 80 ms ; `faceAnchor` oriente le lacet vers l'ancre.

- [ ] **Step 1 : Tests qui échouent**

Ajouter à `tools/ambient-selftest.mjs` (import : `attitudeFrom, tiltOf`) :

```js
console.log('\nambient: attitude');
{
	const q = new Float64Array(4);
	const still = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: { x: 0, y: 0, z: 0 }, drag: { x: 0.01, y: 0.028, z: 0.01 }, mass: 0.65, yawX: 0, yawZ: -1 };
	attitudeFrom(still, q, 0);
	check('immobile : à plat', tiltOf(q, 0) < 1e-6);
	check('immobile : quaternion unitaire', Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
	// Accélération latérale g → 45°.
	attitudeFrom({ ...still, ax: G }, q, 0);
	check('a = g → 45°', Math.abs(tiltOf(q, 0) - Math.PI / 4) < 1e-6, `${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	// Vent de face à 10 m/s : penché dans le vent (drag), donc tilt > 0 même immobile.
	attitudeFrom({ ...still, wind: { x: 10, y: 0, z: 0 } }, q, 0);
	check('vent : penché', tiltOf(q, 0) > 0.01);
	// Le nez suit le lacet : yaw vers +X → l'axe −Z du corps pointe vers +X.
	attitudeFrom({ ...still, yawX: 1, yawZ: 0 }, q, 0);
	const fx = 2 * (q[0] * q[2] + q[3] * q[1]);   // composante X de R·(0,0,-1)… (voir impl)
	check('lacet : nez vers +X', Math.abs(fx - 1) < 1e-6 || Math.abs(fx + 1) < 1e-6);

	// Sur les courbes : race couché, cinewhoop à plat, jamais > 75°.
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const scan = { seed: 'att', count: 5, index: 4 };
	const set = ambientSet(scan).filter((d) => d.family === 'race5' || d.family === 'cinewhoop');
	if (set.length < 2) console.log('  SKIP  graine sans race5+cinewhoop — changer la graine');
	const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
	const m = new AmbientModel({ set, builds, bounds: bigRect, seed: 'att' });
	const cam = { fx: 0, fy: 0, fz: -1 }, player = { x: 0, y: 30, z: 0 }, wind = { x: 0, y: 0, z: 0 };
	let maxTilt = new Float64Array(set.length), sumTilt = new Float64Array(set.length), N = 0;
	for (let i = 0; i < 600; i++) {
		m.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
		if (i < 10) continue;
		N++;
		for (let k = 0; k < set.length; k++) { const t = tiltOf(m.quat, 4 * k); maxTilt[k] = Math.max(maxTilt[k], t); sumTilt[k] += t; }
	}
	for (let k = 0; k < set.length; k++) {
		const deg = sumTilt[k] / N * 180 / Math.PI;
		check(`${set[k].family}: tilt max ≤ 75°`, maxTilt[k] <= 75 * Math.PI / 180, `${(maxTilt[k] * 180 / Math.PI).toFixed(0)}°`);
		if (set[k].family === 'race5') check('race5 : couché (> 35° en moyenne)', deg > 35, `${deg.toFixed(0)}°`);
		if (set[k].family === 'cinewhoop') check('cinewhoop : à plat (< 12°)', deg < 12, `${deg.toFixed(0)}°`);
	}
}
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/ambient-selftest.mjs`
Expected: erreur d'import (`attitudeFrom`).

- [ ] **Step 3 : Implémenter**

Ajouter à `src/ambient.js` :

```js
export const ATTITUDE_TAU = 0.08;

// Base orthonormée → quaternion (x,y,z,w). Colonnes : X = droite, Y = haut,
// Z = arrière (le nez est −Z, comme la caméra Three du joueur).
function quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz, out, o) {
	const tr = xx + yy + zz;
	let x, y, z, w;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s; x = (yz - zy) / s; y = (zx - xz) / s; z = (xy - yx) / s;
	} else if (xx > yy && xx > zz) {
		const s = Math.sqrt(1 + xx - yy - zz) * 2;
		w = (yz - zy) / s; x = 0.25 * s; y = (xy + yx) / s; z = (xz + zx) / s;
	} else if (yy > zz) {
		const s = Math.sqrt(1 + yy - xx - zz) * 2;
		w = (zx - xz) / s; x = (xy + yx) / s; y = 0.25 * s; z = (yz + zy) / s;
	} else {
		const s = Math.sqrt(1 + zz - xx - yy) * 2;
		w = (xy - yx) / s; x = (xz + zx) / s; y = (yz + zy) / s; z = 0.25 * s;
	}
	out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

// Un quad incline sa poussée dans a + g − a_drag. Y corps = poussée
// normalisée ; le nez (−Z) suit le lacet demandé projeté sur le plan du corps.
export function attitudeFrom({ ax, ay, az, vx, vy, vz, wind, drag, mass, yawX, yawZ }, out, o) {
	const rx = vx - wind.x, ry = vy - wind.y, rz = vz - wind.z;
	const s = Math.hypot(rx, ry, rz);
	// F_drag = −c·|v_air|·v_air par axe (le modèle de quad.js), a = F/m.
	const dx = drag.x * s * rx / mass, dy = drag.y * s * ry / mass, dz = drag.z * s * rz / mass;
	let ux = ax + dx, uy = ay + G + dy, uz = az + dz;
	const n = Math.hypot(ux, uy, uz) || 1;
	ux /= n; uy /= n; uz /= n;
	// Nez : la direction de lacet, orthogonalisée contre Y.
	let fx = yawX, fy = 0, fz = yawZ;
	const fn = Math.hypot(fx, fz) || 1; fx /= fn; fz /= fn;
	const dot = fx * ux + fy * uy + fz * uz;
	fx -= dot * ux; fy -= dot * uy; fz -= dot * uz;
	const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
	// Z corps = −nez ; X = Y × Z.
	const zx = -fx, zy = -fy, zz = -fz;
	const xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
	quatFromBasis(xx, xy, xz, ux, uy, uz, zx, zy, zz, out, o);
}

// Angle entre le Y du corps et le Y du monde.
export function tiltOf(q, o) {
	const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
	const upY = 1 - 2 * (x * x + z * z);   // composante Y de R·(0,1,0)
	return Math.acos(Math.max(-1, Math.min(1, upY)));
}
```

Remplacer le stub `_attitude() { /* Task 5 */ }` de `AmbientModel` par :

```js
	_attitude(k, dt, wind) {
		const r = this.routines[k];
		const b = this.builds[k].profile;
		let yawX = this.vel[3 * k], yawZ = this.vel[3 * k + 2];
		if (r.faceAnchor) { yawX = this.anchors[3 * k] - this.pos[3 * k]; yawZ = this.anchors[3 * k + 2] - this.pos[3 * k + 2]; }
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = 0; yawZ = -1; }
		this._att.ax = this.acc[3 * k]; this._att.ay = this.acc[3 * k + 1]; this._att.az = this.acc[3 * k + 2];
		this._att.vx = this.vel[3 * k]; this._att.vy = this.vel[3 * k + 1]; this._att.vz = this.vel[3 * k + 2];
		this._att.wind = wind; this._att.drag = b.bodyDrag; this._att.mass = b.mass;
		this._att.yawX = yawX; this._att.yawZ = yawZ;
		attitudeFrom(this._att, this._q, 0);
		// Lissage exponentiel (nlerp) : les changements de segment ne sautent pas.
		const o = 4 * k, a = 1 - Math.exp(-dt / ATTITUDE_TAU);
		let d = this.quat[o] * this._q[0] + this.quat[o + 1] * this._q[1] + this.quat[o + 2] * this._q[2] + this.quat[o + 3] * this._q[3];
		const sgn = d < 0 ? -1 : 1;
		let nx = this.quat[o] + a * (sgn * this._q[0] - this.quat[o]);
		let ny = this.quat[o + 1] + a * (sgn * this._q[1] - this.quat[o + 1]);
		let nz = this.quat[o + 2] + a * (sgn * this._q[2] - this.quat[o + 2]);
		let nw = this.quat[o + 3] + a * (sgn * this._q[3] - this.quat[o + 3]);
		const n = Math.hypot(nx, ny, nz, nw) || 1;
		this.quat[o] = nx / n; this.quat[o + 1] = ny / n; this.quat[o + 2] = nz / n; this.quat[o + 3] = nw / n;
	}
```

Et dans le constructeur, après `this._anchor = …` :

```js
		this._att = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: null, drag: null, mass: 1, yawX: 0, yawZ: -1 };
		this._q = new Float64Array(4);
```

Dans `spawnOne`, après `this._place(k, 1 / 60)`, poser l'attitude sans lissage : `attitudeFrom(...)` via `this._attitude(k, 10, { x: 0, y: 0, z: 0 })` (un `dt` de 10 s rend `a ≈ 1`).

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/ambient-selftest.mjs && node tools/palette-selftest.mjs`
Expected: `all PASS` ; le test `lacet : nez vers +X` vérifie la composante X du vecteur `R·(0,0,−1)`, soit `-(2·(x·z + w·y))` — si le signe attendu ne colle pas, corriger le test, pas l'orientation (le nez doit être −Z pour que le maillage regarde où il va).

- [ ] **Step 5 : Commit**

```bash
git add src/ambient.js tools/ambient-selftest.mjs
git commit -m "feat(ambiants): attitude dérivée du mouvement, vent et drag de la famille, lissage (#250)"
```

---

### Task 6 : `src/drone-shape.js` — la recette géométrique

**Files:**
- Create: `src/drone-shape.js`
- Test: `tools/drone-shape-selftest.mjs` (nouveau), `package.json`

**Interfaces:**
- Produces: `shapeOf({ profile, build, camera }) → { family, parts: Array<Part>, boundingRadius }` avec `Part = { kind: 'box'|'cylinder'|'disc'|'ring', role: 'plate'|'arm'|'motor'|'prop'|'duct'|'camera'|'battery'|'gopro'|'antenna'|'led', at:[x,y,z], size:[...], rotY?, rotX? }`. Dimensions en mètres, repère du corps (nez −Z, haut +Y).
- Consumes: `profile` de `src/drone-profiles.js` (`armX, armZ, propRadius, bladeCount, mass, family`), `build.spec` (`cells, massG`), `camera.uptiltDeg` de `tools/target-camera.mjs`.

- [ ] **Step 1 : Tests qui échouent**

Créer `tools/drone-shape-selftest.mjs` :

```js
// node tools/drone-shape-selftest.mjs — la recette PURE du quad (issue #250).
import { shapeOf } from '../src/drone-shape.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const roles = (s, role) => s.parts.filter((p) => p.role === role);
const make = (family, seed = `shape::${family}`) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }) });
};

console.log('drone-shape');
for (const family of FAMILIES) {
	const s = make(family);
	check(`${family}: 4 bras, 4 moteurs, 4 hélices`, roles(s, 'arm').length === 4 && roles(s, 'motor').length === 4 && roles(s, 'prop').length === 4);
	check(`${family}: une plaque, une caméra, une batterie, une LED`, roles(s, 'plate').length === 1 && roles(s, 'camera').length === 1 && roles(s, 'battery').length === 1 && roles(s, 'led').length === 1);
	const prop = roles(s, 'prop')[0];
	check(`${family}: disque = propRadius`, Math.abs(prop.size[0] - PROFILES[family].propRadius) < 1e-9);
	const motors = roles(s, 'motor');
	check(`${family}: moteurs à (±armX, ±armZ)`, motors.every((m) => Math.abs(Math.abs(m.at[0]) - PROFILES[family].armX) < 1e-9 && Math.abs(Math.abs(m.at[2]) - PROFILES[family].armZ) < 1e-9));
	check(`${family}: rayon englobant > hypot(arm) + prop`, s.boundingRadius >= Math.hypot(PROFILES[family].armX, PROFILES[family].armZ) + PROFILES[family].propRadius);
	check(`${family}: toutes les pièces sous le rayon englobant`, s.parts.every((p) => Math.hypot(...p.at) <= s.boundingRadius + 1e-9));
	check(`${family}: caméra inclinée du uptilt`, Math.abs(roles(s, 'camera')[0].rotX - targetCamera({ seed: `shape::${family}`, family }).uptiltDeg * Math.PI / 180) < 1e-9);
	check(`${family}: LED à l'arrière (+Z)`, roles(s, 'led')[0].at[2] > 0);
	check(`${family}: caméra à l'avant (−Z)`, roles(s, 'camera')[0].at[2] < 0);
}
check('long range : disques de 88,9 mm', Math.abs(roles(make('longrange'), 'prop')[0].size[0] - 0.0889) < 1e-4);
check('micro : deux pales', roles(make('toothpick'), 'prop')[0].blades === 2);
check('micro : empattement 76 mm', Math.abs(2 * PROFILES.toothpick.armX - 0.076) < 1e-3);
check('cinewhoop : 4 conduits', roles(make('cinewhoop'), 'duct').length === 4);
check('micro : 4 conduits', roles(make('toothpick'), 'duct').length === 4);
check('race : pas de conduit', roles(make('race5'), 'duct').length === 0);
check('cinewhoop : une GoPro', roles(make('cinewhoop'), 'gopro').length === 1);
check('long range : deux antennes', roles(make('longrange'), 'antenna').length === 2);
check('race : une antenne', roles(make('race5'), 'antenna').length === 1);
check('heavy : plaque de 10 mm', Math.abs(roles(make('heavy5'), 'plate')[0].size[1] - 0.010) < 1e-9);
check('freestyle : plaque de 6 mm', Math.abs(roles(make('freestyle5'), 'plate')[0].size[1] - 0.006) < 1e-9);
{
	// Batterie : longueur = 20 mm · cells.
	const s = make('longrange');
	check('batterie 6S = 120 mm', Math.abs(roles(s, 'battery')[0].size[2] - 0.12) < 1e-9);
}
{
	// Un build lourd de freestyle porte une GoPro ; un léger non. On cherche
	// deux graines : la variation de masse est ±12 %.
	let heavy = null, light = null;
	for (let i = 0; i < 200 && !(heavy && light); i++) {
		const b = targetBuild({ seed: `gp::${i}`, family: 'freestyle5' });
		const ratio = b.profile.mass / PROFILES.freestyle5.mass;
		if (ratio > 1.05 && !heavy) heavy = `gp::${i}`;
		if (ratio < 1.0 && !light) light = `gp::${i}`;
	}
	check('freestyle lourd : GoPro', roles(make('freestyle5', heavy), 'gopro').length === 1, heavy);
	check('freestyle léger : pas de GoPro', roles(make('freestyle5', light), 'gopro').length === 0, light);
}
check('même build → même recette', JSON.stringify(make('race5', 'same')) === JSON.stringify(make('race5', 'same')));

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

Ajouter `&& node tools/drone-shape-selftest.mjs` à la chaîne `selftest:operator`.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/drone-shape-selftest.mjs`
Expected: `Cannot find module '../src/drone-shape.js'`.

- [ ] **Step 3 : Implémenter**

Créer `src/drone-shape.js` :

```js
// La recette d'un quad (issue #250) — PURE : une liste de primitives en mètres
// dans le repère du corps (nez −Z, haut +Y), que src/drone-mesh.js assemble.
// Aucune dimension n'est inventée : elles viennent des INVARIANTS par famille
// (propRadius, armX/armZ, bladeCount — tools/target-build.mjs) et de ce que le
// build sait varier (masse, cellules) ; la caméra vient de targetCamera().
//
// Rôles : plate arm motor prop duct camera battery gopro antenna led.

const box = (role, at, size, extra = {}) => ({ kind: 'box', role, at, size, ...extra });
const cyl = (role, at, r, h, extra = {}) => ({ kind: 'cylinder', role, at, size: [r, h], ...extra });

const DUCTED = new Set(['cinewhoop', 'toothpick']);

export function shapeOf({ profile, build, camera }) {
	const { family, armX, armZ, propRadius, bladeCount, mass } = profile;
	const parts = [];
	const heavy = family === 'heavy5';
	const micro = family === 'toothpick';

	// Plaque centrale.
	parts.push(box('plate', [0, 0, 0], [0.8 * armX, heavy ? 0.010 : 0.006, 1.1 * armZ]));

	// Bras, moteurs, hélices, conduits.
	const armR = micro ? 0.005 : 0.008;
	for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
		const mx = sx * armX, mz = sz * armZ;
		const len = Math.hypot(mx, mz);
		parts.push(box('arm', [mx / 2, 0, mz / 2], [armR, armR, len], { rotY: Math.atan2(mx, mz) }));
		parts.push(cyl('motor', [mx, 0.006 + 0.006, mz], 0.18 * propRadius, 0.012));
		parts.push({ kind: 'disc', role: 'prop', at: [mx, 0.020, mz], size: [propRadius], blades: bladeCount });
		if (DUCTED.has(family)) parts.push({ kind: 'ring', role: 'duct', at: [mx, 0.012, mz], size: [1.12 * propRadius, 0.5 * propRadius] });
	}

	// Caméra FPV, à l'avant, inclinée du uptilt.
	parts.push(box('camera', [0, 0.012, -0.55 * armZ], [0.019, 0.019, 0.010], { rotX: camera.uptiltDeg * Math.PI / 180 }));

	// Batterie sur le dessus : 20 mm par cellule.
	const cells = build.spec.cells;
	parts.push(box('battery', [0, 0.008 + 0.0125, 0], [0.035, 0.025, 0.020 * cells]));

	// GoPro : toujours sur le cinewhoop ; sur un freestyle/heavy lourd.
	const nominalMass = build.profile === profile ? mass / (build.variation ?? 1) : mass;
	const heavyBuild = mass > 1.05 * nominalMass;
	if (family === 'cinewhoop' || ((family === 'freestyle5' || heavy) && heavyBuild)) {
		parts.push(box('gopro', [0, 0.008 + 0.025 + 0.0125, -0.35 * armZ], [0.040, 0.025, 0.030]));
	}

	// Antennes à l'arrière ; deux sur le long range.
	const nAnt = family === 'longrange' ? 2 : 1;
	for (let i = 0; i < nAnt; i++) {
		const x = nAnt === 2 ? (i === 0 ? -0.02 : 0.02) : 0;
		parts.push(cyl('antenna', [x, 0.03, 0.5 * armZ], 0.0015, 0.060, { rotX: -Math.PI / 6 }));
	}

	// LED à l'arrière.
	parts.push({ kind: 'point', role: 'led', at: [0, 0.004, 0.55 * armZ], size: [0.004] });

	const boundingRadius = Math.hypot(armX, armZ) + (DUCTED.has(family) ? 1.12 : 1) * propRadius + 0.02;
	return { family, parts, boundingRadius };
}
```

Note : `nominalMass` doit être la masse **de la famille**, pas celle du build. `targetBuild()` retourne `variation` (`tools/target-build.mjs:199-213`) mais pas le ratio de masse tiré ; le plus simple et le plus sûr est d'importer `PROFILES` de `src/drone-profiles.js` et de comparer `mass > 1.05 * PROFILES[family].mass`. Faire cela plutôt que la ligne `nominalMass` ci-dessus, qui est un garde-fou et non la solution.

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/drone-shape-selftest.mjs`
Expected: `all PASS`.

- [ ] **Step 5 : Commit**

```bash
git add src/drone-shape.js tools/drone-shape-selftest.mjs package.json
git commit -m "feat(ambiants): recette géométrique paramétrique du quad par famille et build (#250)"
```

---

### Task 7 : `src/drone-mesh.js` — géométrie fusionnée, matériau auto-éclairé, LED

**Files:**
- Create: `src/drone-mesh.js`
- Test: `tools/drone-mesh-selftest.mjs` (nouveau, Three en Node), `package.json`

**Interfaces:**
- Produces:
  - `buildDroneMesh(shape, { colors: { frame, metal, prop, led } }) → { group: THREE.Group, body: THREE.Mesh, led: THREE.Mesh, material: THREE.ShaderMaterial, ledMaterial: THREE.ShaderMaterial, dispose() }`
  - `DroneMaterial(colorsUnused) → THREE.ShaderMaterial` avec uniformes `uSunDir (vec3), uAmbient (float), uNight (float), uFogColor (vec3), uFogDensity (float), uTime (float)`
  - `LedMaterial() → THREE.ShaderMaterial` avec `uColor, uMinPx, uPhase, uDuty, uTime, uResolution`
  - `setSun(mat, dir, ambient, night)`, `setFog(mat, color, density)`, `setTime(mat, t)` — setters purs sur uniformes.
- Consumes: `shape` de `shapeOf()` (Task 6) ; couleurs hex numériques (l'appelant les tire de `token()`).

- [ ] **Step 1 : Tests qui échouent**

Créer `tools/drone-mesh-selftest.mjs` :

```js
// node tools/drone-mesh-selftest.mjs — l'assemblage Three du quad (issue #250),
// en Node : la géométrie et les uniformes se vérifient sans GPU.
import * as THREE from 'three';
import { buildDroneMesh, DroneMaterial, LedMaterial, setSun, setFog } from '../src/drone-mesh.js';
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
	check('matrixAutoUpdate false', m.group.matrixAutoUpdate === false);
	check('frustumCulled', m.body.frustumCulled === true);
	setSun(m.material, { x: 0, y: 1, z: 0 }, 0.8, 0.2);
	check('setSun écrit', m.material.uniforms.uAmbient.value === 0.8 && m.material.uniforms.uNight.value === 0.2);
	setFog(m.material, 0x9fb8cc, 0.002);
	check('setFog écrit', m.material.uniforms.uFogDensity.value === 0.002);
	const before = geo.attributes.position.count;
	m.dispose();
	check('dispose ne jette pas et retire du parent', m.group.parent === null && before > 0);
}
{
	const shader = new DroneMaterial().fragmentShader;
	check('formule de brouillard identique à TileMaterial', shader.includes('1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth)'));
	check('sinus seulement… non : pas de lumière Three', !shader.includes('directionalLights'));
	check('LED : clamp en pixels dans le vertex shader', new LedMaterial().vertexShader.includes('uMinPx'));
}
{
	const a = make('cinewhoop'), b = make('longrange');
	a.body.geometry.computeBoundingSphere(); b.body.geometry.computeBoundingSphere();
	check('le long range est plus grand que le cinewhoop', b.body.geometry.boundingSphere.radius > a.body.geometry.boundingSphere.radius);
	a.dispose(); b.dispose();
}
console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);
```

Ajouter `&& node tools/drone-mesh-selftest.mjs` à `selftest:operator`.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/drone-mesh-selftest.mjs`
Expected: `Cannot find module '../src/drone-mesh.js'`.

- [ ] **Step 3 : Implémenter**

Créer `src/drone-mesh.js` :

```js
// L'assemblage Three d'un quad (issue #250) depuis la recette de
// src/drone-shape.js. Une seule BufferGeometry fusionnée avec couleurs par
// sommet (alpha inclus pour les disques d'hélice), un ShaderMaterial maison —
// la scène n'a AUCUNE lumière (sun.js « ne ré-éclaire RIEN ») et le
// brouillard n'est pas scene.fog : on éclaire à la main par le soleil et on
// éteint par la même formule que TileMaterial.js / ground.js. La LED est un
// second maillage, billboard additif dont la taille est clampée en pixels.
//
// Ce module ne sait pas qui pilote le quad : un ambiant aujourd'hui, le
// drone du joueur (hélices dans le champ, épave) demain.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PROP_ALPHA = 0.35;

function colored(geo, hex, alpha) {
	const c = new THREE.Color(hex);
	const n = geo.attributes.position.count;
	const col = new Float32Array(4 * n);
	for (let i = 0; i < n; i++) { col[4 * i] = c.r; col[4 * i + 1] = c.g; col[4 * i + 2] = c.b; col[4 * i + 3] = alpha; }
	geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
	return geo;
}

function place(geo, part) {
	if (part.rotX) geo.rotateX(part.rotX);
	if (part.rotY) geo.rotateY(part.rotY);
	geo.translate(part.at[0], part.at[1], part.at[2]);
	return geo;
}

function partGeometry(part, colors) {
	switch (part.kind) {
		case 'box': {
			const g = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
			const hex = part.role === 'plate' || part.role === 'arm' || part.role === 'battery' ? colors.frame : colors.metal;
			return colored(place(g, part), hex, 1);
		}
		case 'cylinder': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 8);
			return colored(place(g, part), colors.metal, 1);
		}
		case 'ring': {
			const g = new THREE.CylinderGeometry(part.size[0], part.size[0], part.size[1], 12, 1, true);
			return colored(place(g, part), colors.frame, 1);
		}
		case 'disc': {
			const g = new THREE.CircleGeometry(part.size[0], 12);
			g.rotateX(-Math.PI / 2);
			return colored(place(g, part), colors.prop, PROP_ALPHA);
		}
		default: return null;   // 'point' (LED) : maillage séparé
	}
}

export function DroneMaterial() {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		transparent: true,
		depthWrite: true,
		side: THREE.DoubleSide,
		uniforms: {
			uSunDir: { value: new THREE.Vector3(0, 1, 0) },
			uAmbient: { value: 1 },
			uNight: { value: 0 },
			uFogColor: { value: new THREE.Color(0x000000) },
			uFogDensity: { value: 0 },
			uTime: { value: 0 },
		},
		vertexShader: /* glsl */`
			in vec4 color;
			out vec4 vColor;
			out vec3 vNormalW;
			out float vDepth;
			out vec3 vLocal;
			void main() {
				vColor = color;
				vNormalW = normalize(mat3(modelMatrix) * normal);
				vLocal = position;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uSunDir;
			uniform float uAmbient;
			uniform float uNight;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			uniform float uTime;
			in vec4 vColor;
			in vec3 vNormalW;
			in float vDepth;
			in vec3 vLocal;
			out vec4 outColor;
			void main() {
				// Éclairage à la main : hémisphère + soleil, mis à l'échelle par
				// l'ambiant du monde ; la nuit assombrit comme les tuiles.
				float lit = 0.55 + 0.45 * max(0.0, dot(normalize(vNormalW), uSunDir));
				vec3 c = vColor.rgb * lit * uAmbient * (1.0 - 0.75 * uNight);
				float a = vColor.a;
				// Disques d'hélice : un bruit radial qui tourne, flou d'hélice sans
				// géométrie animée (alpha < 1 ⇔ disque).
				if (a < 0.99) {
					float ang = atan(vLocal.z, vLocal.x) + uTime * 40.0;
					a *= 0.7 + 0.3 * sin(ang * 3.0);
				}
				// Dupliqué depuis TileMaterial.js, DÉLIBÉRÉMENT : les deux formules
				// doivent rester identiques terme à terme.
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), a);
			}
		`,
	});
}

export function LedMaterial() {
	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: THREE.AdditiveBlending,
		uniforms: {
			uColor: { value: new THREE.Color(0xffffff) },
			uMinPx: { value: 3 },
			uPhase: { value: 0 },
			uDuty: { value: 0.5 },
			uTime: { value: 0 },
			uResolution: { value: new THREE.Vector2(1920, 1080) },
			uFogColor: { value: new THREE.Color(0x000000) },
			uFogDensity: { value: 0 },
		},
		vertexShader: /* glsl */`
			uniform float uMinPx;
			uniform vec2 uResolution;
			out vec2 vUv;
			out float vDepth;
			void main() {
				vUv = uv;
				// Billboard : le centre du quad en vue, puis l'offset en pixels
				// clampé — la LED ne descend jamais sous uMinPx.
				vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
				vDepth = -center.z;
				vec4 clip = projectionMatrix * center;
				float worldPx = 0.004 * projectionMatrix[1][1] * uResolution.y * 0.5 / max(vDepth, 0.01);
				float px = max(worldPx, uMinPx);
				vec2 off = (uv - 0.5) * 2.0 * px / uResolution * clip.w;
				gl_Position = clip + vec4(off, 0.0, 0.0);
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uColor;
			uniform float uPhase;
			uniform float uDuty;
			uniform float uTime;
			uniform vec3 uFogColor;
			uniform float uFogDensity;
			in vec2 vUv;
			in float vDepth;
			out vec4 outColor;
			void main() {
				float r = length(vUv - 0.5) * 2.0;
				if (r > 1.0) discard;
				// Strobe : période 1,2 s, rapport tiré par drone.
				float on = fract(uTime / 1.2 + uPhase) < uDuty ? 1.0 : 0.15;
				float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
				float a = (1.0 - r * r) * on * (1.0 - clamp(f, 0.0, 1.0));
				outColor = vec4(uColor * a, a);
			}
		`,
	});
}

export function setSun(mat, dir, ambient, night) {
	mat.uniforms.uSunDir.value.set(dir.x, dir.y, dir.z);
	mat.uniforms.uAmbient.value = ambient;
	mat.uniforms.uNight.value = night;
}
export function setFog(mat, color, density) {
	mat.uniforms.uFogColor.value.set(color);
	mat.uniforms.uFogDensity.value = density;
}
export function setTime(mat, t) { mat.uniforms.uTime.value = t; }

export function buildDroneMesh(shape, { colors }) {
	const geos = [];
	let ledAt = [0, 0, 0];
	for (const part of shape.parts) {
		if (part.role === 'led') { ledAt = part.at; continue; }
		const g = partGeometry(part, colors);
		if (g) geos.push(g);
	}
	const geometry = mergeGeometries(geos, false);
	for (const g of geos) g.dispose();
	geometry.computeBoundingSphere();

	const material = DroneMaterial();
	const body = new THREE.Mesh(geometry, material);
	body.frustumCulled = true;

	const ledMaterial = LedMaterial();
	ledMaterial.uniforms.uColor.value.set(colors.led);
	const led = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ledMaterial);
	led.position.set(ledAt[0], ledAt[1], ledAt[2]);
	led.frustumCulled = false;   // sa taille écran ne suit pas sa géométrie

	const group = new THREE.Group();
	group.matrixAutoUpdate = false;
	group.add(body); group.add(led);

	return {
		group, body, led, material, ledMaterial,
		dispose() {
			group.parent?.remove(group);
			geometry.dispose(); led.geometry.dispose();
			material.dispose(); ledMaterial.dispose();
		},
	};
}
```

Aucun selftest du dépôt n'importe encore `three` en Node ; `three@^0.170` s'importe en ESM sans bundler et expose `three/addons/*` par son champ `exports`. Si `three/addons/utils/BufferGeometryUtils.js` ne se résout pas depuis `tools/`, importer `three/examples/jsm/utils/BufferGeometryUtils.js` (même module, chemin historique, présent dans `node_modules`) et vérifier que Vite le résout aussi (`npm run build`).

- [ ] **Step 4 : Lancer, vérifier le vert**

Run: `cd sim && node tools/drone-mesh-selftest.mjs && node tools/palette-selftest.mjs && npm run build 2>&1 | tail -3`
Expected: `all PASS` ; palette vert (les hex du selftest sont dans `tools/`, pas dans `src/` — si `palette-selftest` scanne aussi `tools/`, remplacer les hex du test par `FALLBACK` importé de `src/palette.js`) ; build OK.

- [ ] **Step 5 : Commit**

```bash
git add src/drone-mesh.js tools/drone-mesh-selftest.mjs package.json
git commit -m "feat(ambiants): maillage fusionné auto-éclairé, brouillard des tuiles, LED billboard (#250)"
```

---

### Task 8 : Le son — modèle pur puis quatre voix Web Audio

**Files:**
- Create: `tools/ambient-audio-model.mjs`, `src/ambient-audio.js`
- Test: `tools/ambient-audio-selftest.mjs` (nouveau), `package.json`

**Interfaces:**
- Produces (modèle) :
  - `VOICE = { d0: 8, dMax: 250, fadeM: 50, g0, cutNear: 2600, cutFar: 800, behindCut: 0.6, c: 343, vrMax: 40, omegaCruise: 0.55, accelMod: 0.15, accelRef: 20, detuneCents: 9 }`
  - `gainFor(d) → number`, `cutoffFor(d, behind) → Hz`, `dopplerFor(f, vRadial) → Hz`, `bladeFreq(profile, accelMag) → Hz`, `azimuthPan(relX, relZ, cam: {fx,fz,rx,rz}) → { pan, behind }`
  - `voiceParams({ d, behind, pan, vRadial, accelMag, profile, detune }) → { gain, cutoff, freq, pan }` (mute un objet `out` fourni)
- Produces (client) : `class AmbientAudio { start(ctx?); update(voices: Array<{ d, behind, pan, vRadial, accelMag, profile }|null>, now); setMuted(b); silence(); dispose(); nodesCreated }` — 6 nœuds par voix + 1 bruit partagé, branchés sur `engineIn()` et `space.input`.

- [ ] **Step 1 : Tests qui échouent**

Créer `tools/ambient-audio-selftest.mjs` :

```js
// node tools/ambient-audio-selftest.mjs — le modèle PUR des voix ambiantes
// (issue #250) et le graphe Web Audio sur un faux contexte. Ce qui s'écoute se
// vérifie à l'oreille, pas ici.
import { strict as assert } from 'node:assert';
import {
	VOICE, gainFor, cutoffFor, dopplerFor, bladeFreq, azimuthPan, voiceParams,
} from './ambient-audio-model.mjs';
import { AmbientAudio } from '../src/ambient-audio.js';
import { AUDIO } from '../src/audio.js';
import { PROFILES } from '../src/drone-profiles.js';

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('gain décroissant, nul à 250 m', () => {
	let prev = Infinity;
	for (let d = 0; d <= 260; d += 5) { const g = gainFor(d); assert.ok(g <= prev + 1e-12, `d=${d}`); prev = g; }
	assert.equal(gainFor(250), 0);
	assert.equal(gainFor(400), 0);
	assert.ok(gainFor(8) > 0);
});

test('quatre voix à 8 m ≤ −12 dB sous idleLevel', () => {
	const sum = 4 * gainFor(8);
	assert.ok(sum <= AUDIO.idleLevel * Math.pow(10, -12 / 20) + 1e-12, `${sum} vs ${AUDIO.idleLevel * Math.pow(10, -12 / 20)}`);
});

test('coupure décroissante en distance, plus basse dans le dos', () => {
	assert.ok(Math.abs(cutoffFor(0, 0) - VOICE.cutNear) < 1);
	assert.ok(Math.abs(cutoffFor(250, 0) - VOICE.cutFar) < 1);
	assert.ok(cutoffFor(100, 0) > cutoffFor(200, 0));
	assert.ok(cutoffFor(100, 1) < cutoffFor(100, 0));
	assert.ok(Math.abs(cutoffFor(100, 1) / cutoffFor(100, 0) - VOICE.behindCut) < 1e-9);
	// Rien ne remonte : la coupure ne dépasse jamais 2600.
	for (let d = 0; d < 250; d += 10) assert.ok(cutoffFor(d, 0) <= VOICE.cutNear + 1e-9);
});

test('Doppler ±40 m/s dans ±12 %, borné', () => {
	assert.equal(dopplerFor(100, 0), 100);
	assert.ok(dopplerFor(100, 40) < 100 && dopplerFor(100, 40) > 88);
	assert.ok(dopplerFor(100, -40) > 100 && dopplerFor(100, -40) < 114);
	assert.equal(dopplerFor(100, 400), dopplerFor(100, 40));
});

test('fréquence de pale : ω = 0,55·maxOmega, +15 % en virage, pales de la famille', () => {
	const f0 = bladeFreq(PROFILES.race5, 0);
	assert.ok(Math.abs(f0 - 0.55 * PROFILES.race5.maxOmega * PROFILES.race5.bladeCount / (2 * Math.PI)) < 1e-9);
	assert.ok(Math.abs(bladeFreq(PROFILES.race5, 100) / f0 - 1.15) < 1e-9);
	assert.ok(bladeFreq(PROFILES.toothpick, 0) !== bladeFreq(PROFILES.race5, 0));
});

test('azimut : droite → pan +, derrière → behind 1, continu au zénith', () => {
	const cam = { fx: 0, fz: -1, rx: 1, rz: 0 };   // regarde −Z, droite = +X
	assert.ok(azimuthPan(10, 0, cam).pan > 0.5);
	assert.ok(azimuthPan(-10, 0, cam).pan < -0.5);
	assert.ok(Math.abs(azimuthPan(0, -10, cam).pan) < 1e-9 && azimuthPan(0, -10, cam).behind === 0);
	assert.ok(azimuthPan(0, 10, cam).behind > 0.99);
	// Zénith : relX = relZ = 0 → pan 0, behind 0, pas de NaN.
	const z = azimuthPan(0, 0, cam);
	assert.equal(z.pan, 0); assert.equal(z.behind, 0);
});

test('voiceParams mute out sans allouer', () => {
	const out = { gain: 0, cutoff: 0, freq: 0, pan: 0 };
	const r = voiceParams({ d: 50, behind: 0.3, pan: 0.2, vRadial: 5, accelMag: 10, profile: PROFILES.cinewhoop, detune: 4 }, out);
	assert.equal(r, out);
	assert.ok(out.gain > 0 && out.cutoff > 0 && out.freq > 0);
	// Détune : 4 cents = ×2^(4/1200).
	const base = voiceParams({ d: 50, behind: 0.3, pan: 0.2, vRadial: 5, accelMag: 10, profile: PROFILES.cinewhoop, detune: 0 }, { gain: 0, cutoff: 0, freq: 0, pan: 0 });
	assert.ok(Math.abs(out.freq / base.freq - Math.pow(2, 4 / 1200)) < 1e-9);
});

// ----------------------------------------------------------------- Web Audio
// Faux contexte : compte les nœuds, garde les AudioParams, ne joue rien.
function fakeContext() {
	let created = 0;
	const param = (v) => ({ value: v, setTargetAtTime(t) { this.value = t; }, setValueAtTime(t) { this.value = t; } });
	const node = (extra = {}) => { created++; return { connect() { return this; }, disconnect() {}, start() {}, stop() {}, ...extra }; };
	return {
		currentTime: 0, sampleRate: 48000, state: 'running',
		get created() { return created; },
		createGain: () => node({ gain: param(1) }),
		createOscillator: () => node({ type: 'sine', frequency: param(440), detune: param(0) }),
		createBiquadFilter: () => node({ type: 'lowpass', frequency: param(1000), Q: param(1) }),
		createStereoPanner: () => node({ pan: param(0) }),
		createBufferSource: () => node({ buffer: null, loop: false }),
		createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
		createDelay: () => node({ delayTime: param(0) }),
		createDynamicsCompressor: () => node({ threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0) }),
		destination: {},
	};
}

test('graphe : construit une fois, 6 nœuds par voix + bruit partagé, aucun nœud après', () => {
	const ctx = fakeContext();
	const dest = ctx.createGain();
	const spaceIn = ctx.createGain();
	const a = new AmbientAudio({ destination: dest, spaceInput: spaceIn });
	a.start(ctx);
	const after = ctx.created;
	assert.ok(after >= 2 + 4 * 6 && after <= 2 + 4 * 6 + 3, `${after} nœuds`);
	const voices = [
		{ d: 30, behind: 0, pan: 0.1, vRadial: 2, accelMag: 5, profile: PROFILES.race5 },
		null, null, null,
	];
	for (let i = 0; i < 300; i++) a.update(voices, i / 60);
	assert.equal(ctx.created, after, 'un nœud a été créé pendant update');
	a.silence();
	a.dispose();
	assert.equal(ctx.created, after);
});

test('graphe : sinus seulement, détunes distincts', () => {
	const ctx = fakeContext();
	const a = new AmbientAudio({ destination: ctx.createGain(), spaceInput: ctx.createGain() });
	a.start(ctx);
	assert.ok(a._voices.every((v) => v.osc.type === 'sine'));
	const det = a._voices.map((v) => v.detuneCents);
	assert.equal(new Set(det).size, 4);
	assert.ok(det.every((c) => Math.abs(c) <= VOICE.detuneCents));
});

test('voix nulle → gain 0 ; muted → gain 0 partout', () => {
	const ctx = fakeContext();
	const a = new AmbientAudio({ destination: ctx.createGain(), spaceInput: ctx.createGain() });
	a.start(ctx);
	a.update([{ d: 30, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: PROFILES.race5 }, null, null, null], 1);
	assert.ok(a._voices[0].gain.gain.value > 0);
	assert.equal(a._voices[1].gain.gain.value, 0);
	a.setMuted(true);
	a.update([{ d: 30, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: PROFILES.race5 }, null, null, null], 2);
	assert.equal(a._voices[0].gain.gain.value, 0);
});

console.log(`ambient-audio: ${passed} tests OK`);
```

Ajouter `&& node tools/ambient-audio-selftest.mjs` à `selftest:operator`. `AUDIO` n'est **pas** exporté aujourd'hui (`src/audio.js:28` : `const AUDIO = {`) : le passer en `export const AUDIO = {` — une ligne, aucune valeur ne change, `tools/audio-bus-selftest.mjs` et `tools/ui-audio-selftest.mjs` doivent rester verts.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && node tools/ambient-audio-selftest.mjs`
Expected: `Cannot find module './ambient-audio-model.mjs'`.

- [ ] **Step 3 : Implémenter le modèle**

Créer `tools/ambient-audio-model.mjs` :

```js
// Le modèle PUR des voix ambiantes (issue #250) : ce que vaut le gain, la
// coupure, la fréquence et le pan d'une source qui BOUGE par rapport à
// l'auditeur — ce que #122 n'avait pas à faire (les moteurs du joueur sont
// solidaires de sa tête). Aucune Web Audio ici.
//
// Niveaux relatifs CHOISIS, pas mesurés, comme le reste du son
// (docs/handoff-archive/sound.md §« aucun agent n'écoute »).

// idleLevel du joueur = 0,12 (src/audio.js). Quatre voix à d0 doivent rester
// 12 dB dessous : 4·g0/(1 + d0/d0) = 2·g0 ≤ 0,12·10^(−12/20) = 0,0301.
export const VOICE = {
	d0: 8, dMax: 250, fadeM: 50,
	g0: 0.015,
	cutNear: 2600, cutFar: 800, behindCut: 0.6,
	c: 343, vrMax: 40,
	omegaCruise: 0.55, accelMod: 0.15, accelRef: 20,
	detuneCents: 9,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function gainFor(d) {
	if (d >= VOICE.dMax) return 0;
	const fade = clamp01((VOICE.dMax - d) / VOICE.fadeM);
	return VOICE.g0 / (1 + d / VOICE.d0) * fade;
}

// Log-interpolation de la coupure entre 0 et dMax ; l'ombre de la tête
// multiplie par behindCut au maximum (behind ∈ 0..1).
export function cutoffFor(d, behind) {
	const u = clamp01(d / VOICE.dMax);
	const f = Math.exp(Math.log(VOICE.cutNear) * (1 - u) + Math.log(VOICE.cutFar) * u);
	return f * (1 - (1 - VOICE.behindCut) * clamp01(behind));
}

// vRadial > 0 : la source s'éloigne.
export function dopplerFor(f, vRadial) {
	const vr = Math.max(-VOICE.vrMax, Math.min(VOICE.vrMax, vRadial));
	return f * VOICE.c / (VOICE.c + vr);
}

export function bladeFreq(profile, accelMag) {
	const mod = 1 + VOICE.accelMod * clamp01(accelMag / VOICE.accelRef);
	const omega = VOICE.omegaCruise * profile.maxOmega * mod;
	return omega * profile.bladeCount / (2 * Math.PI);
}

// Pan équi-puissance sur l'azimut dans le repère caméra (rx,rz = droite ;
// fx,fz = avant, horizontaux). Au zénith (rel nul) : centre, devant.
export function azimuthPan(relX, relZ, cam) {
	const n = Math.hypot(relX, relZ);
	if (n < 1e-6) return { pan: 0, behind: 0 };
	const r = (relX * cam.rx + relZ * cam.rz) / n;
	const f = (relX * cam.fx + relZ * cam.fz) / n;
	return { pan: Math.max(-1, Math.min(1, r)), behind: clamp01(-f) };
}

export function voiceParams({ d, behind, pan, vRadial, accelMag, profile, detune }, out) {
	out.gain = gainFor(d);
	out.cutoff = cutoffFor(d, behind);
	out.freq = dopplerFor(bladeFreq(profile, accelMag), vRadial) * Math.pow(2, detune / 1200);
	out.pan = pan;
	return out;
}
```

- [ ] **Step 4 : Implémenter les voix**

Créer `src/ambient-audio.js` :

```js
// Les voix des drones ambiants (issue #250). Quatre voix construites UNE fois
// dans start(), à gain zéro ; update() ne fait que viser des AudioParams.
//
//   osc(sine) ──┐
//   noise ─ bp ─┼→ gain(distance) → lowpass(distance, dos) → panner ─┬→ destination (engineIn)
//                                                                    └→ spaceInput (acoustique du lieu, #122)
//
// Sinus seulement, détune par voix (sound.md : quatre voix en phase feraient un
// son de test de synthé), coupure qui descend avec la distance (rien ne
// remonte dans 2–4 kHz), Doppler écrit à la main sur osc.frequency — jamais
// celui du PannerNode, retiré de la spec.
import { voiceParams, VOICE } from '../tools/ambient-audio-model.mjs';
import { AUDIO } from './audio.js';

const N_VOICES = 4;
const NOISE_LEVEL = 0.25;   // part de bruit dans une voix, sous le sinus
const TAU_PAN = 0.06;

function makeNoiseBuffer(ctx, seconds) {
	const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
	return buf;
}

export class AmbientAudio {
	// `destination` : engineIn() ; `spaceInput` : space.input (peut être null
	// si l'acoustique n'est pas construite — alors pas d'envoi).
	constructor({ destination, spaceInput = null } = {}) {
		this._dest = destination;
		this._spaceIn = spaceInput;
		this.ctx = null;
		this._voices = [];
		this._muted = false;
		this.nodesCreated = 0;
		this._p = { gain: 0, cutoff: 0, freq: 0, pan: 0 };
	}

	get running() { return this.ctx !== null; }

	start(ctx) {
		if (this.ctx || !ctx || !this._dest) return;
		this.ctx = ctx;
		this._noise = ctx.createBufferSource();
		this._noise.buffer = makeNoiseBuffer(ctx, 2);
		this._noise.loop = true;
		this._noise.start();
		this.nodesCreated++;
		// Détunes distincts et non symétriques : ±9 cents, jamais deux pareils.
		const detunes = [7, -5, 4, -8].map((c) => c * VOICE.detuneCents / 9);
		for (let i = 0; i < N_VOICES; i++) {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = 200;
			const band = ctx.createBiquadFilter();
			band.type = 'bandpass'; band.frequency.value = 200; band.Q.value = 1.6;
			const bandGain = ctx.createGain(); bandGain.gain.value = NOISE_LEVEL;
			const gain = ctx.createGain(); gain.gain.value = 0;
			const low = ctx.createBiquadFilter();
			low.type = 'lowpass'; low.frequency.value = VOICE.cutNear; low.Q.value = 0.5;
			const pan = ctx.createStereoPanner();
			osc.connect(gain);
			this._noise.connect(band).connect(bandGain).connect(gain);
			gain.connect(low).connect(pan).connect(this._dest);
			if (this._spaceIn) pan.connect(this._spaceIn);
			osc.start();
			this.nodesCreated += 6;
			this._voices.push({ osc, band, bandGain, gain, low, pan, detuneCents: detunes[i] });
		}
	}

	setMuted(m) { this._muted = !!m; }

	// `voices[i]` = { d, behind, pan, vRadial, accelMag, profile } ou null.
	update(voices, now) {
		if (!this.ctx) return;
		const t = now ?? this.ctx.currentTime;
		for (let i = 0; i < N_VOICES; i++) {
			const v = this._voices[i], src = voices[i];
			if (!src || this._muted) { v.gain.gain.setTargetAtTime(0, t, AUDIO.tauGain); continue; }
			voiceParams({ ...src, detune: v.detuneCents }, this._p);
			v.gain.gain.setTargetAtTime(this._p.gain, t, AUDIO.tauGain);
			v.low.frequency.setTargetAtTime(this._p.cutoff, t, AUDIO.tauFreq);
			v.osc.frequency.setTargetAtTime(Math.max(this._p.freq, 1), t, AUDIO.tauFreq);
			v.band.frequency.setTargetAtTime(Math.max(this._p.freq, 20), t, AUDIO.tauFreq);
			v.pan.pan.setTargetAtTime(this._p.pan, t, TAU_PAN);
		}
	}

	silence() {
		if (!this.ctx) return;
		const t = this.ctx.currentTime;
		for (const v of this._voices) v.gain.gain.setTargetAtTime(0, t, 0.05);
	}

	dispose() {
		if (!this.ctx) return;
		try {
			for (const v of this._voices) { v.osc.stop(); v.osc.disconnect(); v.band.disconnect(); v.bandGain.disconnect(); v.gain.disconnect(); v.low.disconnect(); v.pan.disconnect(); }
			this._noise.stop(); this._noise.disconnect();
		} catch { /* déjà démonté */ }
		this._voices = []; this.ctx = null;
	}
}
```

Attention : `voiceParams({ ...src, detune })` alloue un objet par voix et par frame. Remplacer par un objet `_in` pré-alloué dans le constructeur dont on copie les six champs avant l'appel — le test « aucun nœud après » ne le voit pas, la règle « zéro allocation par frame » si.

- [ ] **Step 5 : Lancer, vérifier le vert**

Run: `cd sim && node tools/ambient-audio-selftest.mjs && node tools/audio-bus-selftest.mjs && node tools/space-selftest.mjs`
Expected: `ambient-audio: 10 tests OK`, autres suites inchangées.

- [ ] **Step 6 : Commit**

```bash
git add tools/ambient-audio-model.mjs src/ambient-audio.js tools/ambient-audio-selftest.mjs package.json src/audio.js
git commit -m "feat(ambiants): quatre voix placées — distance, ombre du dos, Doppler, envoi vers l'acoustique du lieu (#250)"
```

---

### Task 9 : `src/ambient-drones.js` et le câblage dans `main.js`

**Files:**
- Create: `src/ambient-drones.js`
- Modify: `src/main.js` — `finishBoot()` (~`:822`), `bootLive()` (~`:1061`), `frame()` (après `:1660`, et la variable `density` de `:1784`), `respawn()` (`:1340`), `__sim.teleport` (`:585`), `__sim` objet (`:561`) et `debug()` (`:603`), `linkDead` (`:1711`), `openFlightSession()` (~`:2754`), fin de boot (`:2811`)
- Test: bloc scène dans `tools/selftest.mjs` (après le bloc entry-state, ~`:2075`)

**Interfaces:**
- Consumes: `AmbientModel`, `ambientSet` (Task 2–5), `shapeOf` (6), `buildDroneMesh/setSun/setFog/setTime` (7), `AmbientAudio`, `azimuthPan` (8), `targetBuild`, `targetCamera`, `token`, `engineIn`, `space`.
- Produces: `class AmbientDrones { constructor({ scene, physics, bounds, sun }); setScan(scan|null); update({ dt, player, playerVel, camera, wind, fogColor, fogDensity, sun, top, span, resolution }); reset(); silence(); setMuted(b); dispose(); debug() → { count, families, positions, relocations, raysCast, spawnFailures, audioNodes } }`.

- [ ] **Step 1 : Test scène qui échoue**

Dans `tools/selftest.mjs`, après le bloc entry-state (chercher `console.log('\nentry state` ou le dernier `check(` du bloc, ~`:2075`) ; imports en tête : `AmbientModel, ambientSet, SAMPLES` depuis `../src/ambient.js`, `targetBuild` depuis `./target-build.mjs` (déjà importé ? vérifier), `Geofence` déjà importé :

```js
// ---------------------------------------------------------------- ambient
// 40 naissances contre le VRAI trimesh : aucune courbe ne coupe un mur (rejeu
// de obstructionBetween sur 64 points), toutes au-dessus du sol.
console.log('\nambient drones (real trimesh)');
{
	const fence = new Geofence(manifest.bbox);
	const bounds = { bbox: manifest.bbox, corridor: fence.effectiveCorridor };
	const top = manifest.bbox.max[1] + 50, span = (manifest.bbox.max[1] - manifest.bbox.min[1]) + 100;
	const cam = { fx: 0, fy: 0, fz: -1 };
	const wind = { x: 0, y: 0, z: 0 };
	const sp = physics.spawn;
	const player = { x: sp.x, y: sp.y + 30, z: sp.z };
	let born = 0, clean = 0, aboveGround = 0, tested = 0;
	for (let s = 0; s < 10; s++) {
		const scan = { seed: `selftest-ambient-${s}`, count: 5, index: 0 };
		const set = ambientSet(scan);
		const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
		const m = new AmbientModel({ set, builds, bounds, seed: scan.seed });
		for (let f = 0; f < 30 && m.count < set.length; f++) {
			m.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays: physics, top, span, wind });
		}
		for (let k = 0; k < set.length; k++) {
			if (!m.alive[k]) continue;
			born++;
			const r = m.routines[k];
			const a = { x: m.anchors[3 * k], y: m.anchors[3 * k + 1], z: m.anchors[3 * k + 2] };
			let ok = true, above = true;
			const pa = { x: 0, y: 0, z: 0 }, pb = { x: 0, y: 0, z: 0 };
			for (let i = 0; i < 64; i++) {
				curveAt(r, a, m.heights[k], r.period * i / 64, pa);
				curveAt(r, a, m.heights[k], r.period * (i + 1) / 64, pb);
				const o = physics.obstructionBetween(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
				if (o.blocked && o.span > 2) ok = false;
				const g = physics.groundBelow(pa.x, pa.y, pa.z);
				if (g == null || pa.y - g < r.aglMin - 0.5) above = false;
				tested++;
			}
			if (ok) clean++;
			if (above) aboveGround++;
		}
	}
	check('at least 30 of 40 ambient drones are born on the reference scene', born >= 30, `${born}/40`);
	check('no ambient curve cuts a wall (64-point replay)', clean === born, `${clean}/${born}`);
	check('every ambient curve stays above its family AGL', aboveGround === born, `${aboveGround}/${born}`);
}
```

Ajouter `curveAt` à l'import de `../src/ambient.js`.

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd sim && npm run selftest 2>&1 | tail -5`
Expected: erreur d'import `ambient.js`… non : `src/ambient.js` existe déjà (Task 2–5), donc les trois checks tournent. Attendu : PASS si le modèle est juste ; sinon FAIL avec les comptes. Ce test ne dépend pas de `ambient-drones.js` — il valide le modèle contre la vraie scène **avant** le câblage. S'il est rouge, c'est le modèle (Task 4) qu'on corrige, pas le test.

- [ ] **Step 3 : Implémenter `src/ambient-drones.js`**

```js
// Les drones ambiants (issue #250) — l'instance qui lie le modèle pur
// (src/ambient.js), les maillages (src/drone-mesh.js) et les voix
// (src/ambient-audio.js), et qui parle à main.js. Rien d'autre ne connaît
// les trois à la fois.
import * as THREE from 'three';
import { AmbientModel, ambientSet } from './ambient.js';
import { shapeOf } from './drone-shape.js';
import { buildDroneMesh, setSun, setFog, setTime } from './drone-mesh.js';
import { AmbientAudio } from './ambient-audio.js';
import { azimuthPan } from '../tools/ambient-audio-model.mjs';
import { targetBuild } from '../tools/target-build.mjs';
import { targetCamera } from '../tools/target-camera.mjs';
import { token } from './palette.js';
import { engineIn, context as audioContext } from './audio-bus.js';
import { space } from './space.js';

const hex = (name) => new THREE.Color(token(name)).getHex();

export class AmbientDrones {
	constructor({ scene, bounds }) {
		this.scene = scene;
		this.bounds = bounds;
		this.model = null;
		this.meshes = [];
		this.audio = new AmbientAudio({ destination: engineIn(), spaceInput: space.input });
		this._voices = [null, null, null, null];
		this._voiceIn = [0, 1, 2, 3].map(() => ({ d: 0, behind: 0, pan: 0, vRadial: 0, accelMag: 0, profile: null }));
		this._m = new THREE.Matrix4();
		this._q = new THREE.Quaternion();
		this._p = new THREE.Vector3();
		this._s = new THREE.Vector3(1, 1, 1);
		this._camF = new THREE.Vector3();
		this._camR = new THREE.Vector3();
		this._cam = { fx: 0, fy: 0, fz: -1 };
		this._camPan = { fx: 0, fz: -1, rx: 1, rz: 0 };
		this._lastFog = { color: -1, density: -1 };
		this._time = 0;
		this._colors = { frame: hex('--dark-grey'), metal: hex('--grey'), prop: hex('--light-grey'), led: hex('--warm-white') };
	}

	// Le scan {seed,count,index} ou null (pas d'ambiants). Peut être appelé
	// une seule fois par page ; un second appel remplace tout.
	setScan(scan) {
		this._clear();
		if (!scan) return;
		const set = ambientSet(scan);
		const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
		this.model = new AmbientModel({ set, builds, bounds: this.bounds, seed: scan.seed });
		for (let k = 0; k < set.length; k++) {
			const camera = targetCamera({ seed: set[k].buildSeed, family: set[k].family });
			const shape = shapeOf({ profile: builds[k].profile, build: builds[k], camera });
			const m = buildDroneMesh(shape, { colors: this._colors });
			m.group.visible = false;
			// Strobe par drone : phase et rapport tirés de la graine.
			const rand = ((s) => { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); })(`${set[k].buildSeed}::led`);
			m.ledMaterial.uniforms.uPhase.value = rand();
			m.ledMaterial.uniforms.uDuty.value = 0.3 + rand() * 0.5;
			this.scene.add(m.group);
			this.meshes.push(m);
		}
		const ctx = audioContext();
		if (ctx) this.audio.start(ctx);
	}

	_clear() {
		for (const m of this.meshes) m.dispose();
		this.meshes = [];
		this.model = null;
	}

	reset() { this.model?.reset(); }
	silence() { this.audio.silence(); }
	setMuted(b) { this.audio.setMuted(b); }

	// Une fois par frame, dt = 0 quand gelé. `player`/`playerVel` : Rapier
	// {x,y,z} ; `camera` : la caméra Three posée ; `wind` : physics.wind.out ;
	// `rays` : physics (groundBelow/obstructionBetween) ; `sun` : SunField|null.
	update({ dt, player, playerVel, camera, wind, rays, top, span, fogColor, fogDensity, sun, resolution }) {
		const m = this.model;
		if (!m) return;
		this._camF.set(0, 0, -1).applyQuaternion(camera.quaternion);
		this._camR.set(1, 0, 0).applyQuaternion(camera.quaternion);
		this._cam.fx = this._camF.x; this._cam.fy = this._camF.y; this._cam.fz = this._camF.z;
		this._camPan.fx = this._camF.x; this._camPan.fz = this._camF.z; this._camPan.rx = this._camR.x; this._camPan.rz = this._camR.z;

		m.update({ dt, player, cam: this._cam, fovDeg: camera.fov, rays, top, span, wind });
		this._time += dt;

		// Brouillard et soleil : écrits sur changement seulement.
		const fogHex = typeof fogColor === 'number' ? fogColor : fogColor.getHex();
		const fogChanged = fogHex !== this._lastFog.color || fogDensity !== this._lastFog.density;
		if (fogChanged) { this._lastFog.color = fogHex; this._lastFog.density = fogDensity; }

		for (let k = 0; k < this.meshes.length; k++) {
			const mesh = this.meshes[k];
			const alive = m.alive[k] === 1;
			mesh.group.visible = alive;
			if (!alive) { this._voices[k] = null; continue; }
			this._p.set(m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]);
			this._q.set(m.quat[4 * k], m.quat[4 * k + 1], m.quat[4 * k + 2], m.quat[4 * k + 3]);
			mesh.group.matrix.compose(this._p, this._q, this._s);
			mesh.group.matrixWorldNeedsUpdate = true;
			setTime(mesh.material, this._time);
			mesh.ledMaterial.uniforms.uTime.value = this._time;
			if (resolution) mesh.ledMaterial.uniforms.uResolution.value.set(resolution.w, resolution.h);
			if (fogChanged) { setFog(mesh.material, fogHex, fogDensity); mesh.ledMaterial.uniforms.uFogColor.value.set(fogHex); mesh.ledMaterial.uniforms.uFogDensity.value = fogDensity; }
			if (sun) setSun(mesh.material, sun.dir, sun.ambient, sun.night);

			// La voix.
			const relX = m.pos[3 * k] - player.x, relY = m.pos[3 * k + 1] - player.y, relZ = m.pos[3 * k + 2] - player.z;
			const d = Math.hypot(relX, relY, relZ) || 1e-6;
			const rvx = m.vel[3 * k] - playerVel.x, rvy = m.vel[3 * k + 1] - playerVel.y, rvz = m.vel[3 * k + 2] - playerVel.z;
			const ap = azimuthPan(relX, relZ, this._camPan);
			const v = this._voiceIn[k];
			v.d = d; v.behind = ap.behind; v.pan = ap.pan;
			v.vRadial = (rvx * relX + rvy * relY + rvz * relZ) / d;
			v.accelMag = Math.hypot(m.acc[3 * k], m.acc[3 * k + 1], m.acc[3 * k + 2]);
			v.profile = m.builds[k].profile;
			this._voices[k] = v;
		}
		if (dt > 0) this.audio.update(this._voices);
	}

	debug() {
		const m = this.model;
		if (!m) return { count: 0 };
		const positions = [];
		for (let k = 0; k < m.n; k++) if (m.alive[k]) positions.push([m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]].map((v) => +v.toFixed(1)));
		return { count: m.count, families: m.families, positions, ...m.stats, audioNodes: this.audio.nodesCreated };
	}

	dispose() { this._clear(); this.audio.dispose(); }
}
```

Note : `azimuthPan` alloue `{ pan, behind }` à chaque appel. Lui ajouter un paramètre `out` optionnel dans `tools/ambient-audio-model.mjs` (muter et rendre `out` s'il est fourni) et passer `this._ap` pré-alloué ici. Mettre à jour le test `azimuthPan` en conséquence (il reste valide sans `out`).

- [ ] **Step 4 : Câbler `main.js`**

1. Imports en tête : `import { AmbientDrones } from './ambient-drones.js';`. Déclarer `let ambient = null;` à côté de `let distantGround` (~`:379`). Déclarer `let lastFogDensity = 0;` à côté de `lastDensity`.

2. `finishBoot()`, juste après `setDistantGround(distantGround);` (~`:829`) :

```js
	// Les drones ambiants (issue #250) — jamais au banc : NO TARGET.
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			bounds: { bbox: manifest.bbox, corridor: fence.effectiveCorridor },
		});
	}
```

3. `bootLive()`, juste après `fenceDome = new FenceDome(scene);` (~`:1062`) :

```js
	if (!MODE.bench) {
		ambient = new AmbientDrones({
			scene,
			// Direct : le cercle de confiance de la fenêtre, relu à chaque frame
			// (bounds est muté, jamais remplacé — le modèle garde la référence).
			bounds: liveBounds,
		});
	}
```

avec, déclaré au niveau module : `const liveBounds = { center: null, trusted: 0 };`. Et, en `?live=` dev (`OPTS.live`), tout de suite après : `ambient?.setScan({ seed: \`dev::${OPTS.live}\`, count: 4, index: 0 });`.

4. `frame()`, juste après le bloc caméra (`}` de `if (!frozen) {…} else if (freeCamOn) {…}`, ~`:1663`) :

```js
	if (ambient) {
		if (liveWindow) {
			const c = liveWindow.windowCenterLocal;
			liveBounds.center = c;
			liveBounds.trusted = liveWindow.nearestTrustedRadius();
		}
		ambient.setMuted(frozen);
		ambient.update({
			dt: frozen ? 0 : dt,
			player: physics.position, playerVel: physics.velocity, camera,
			wind: physics.wind.out, rays: physics,
			top: sceneManifest ? sceneManifest.bbox.max[1] + 50 : physics.position.y + 300,
			span: sceneManifest ? (sceneManifest.bbox.max[1] - sceneManifest.bbox.min[1]) + 100 : 3000,
			fogColor: scene.background, fogDensity: lastFogDensity, sun,
			resolution: _res,
		});
	}
```

avec `const _res = { w: 1, h: 1 };` au niveau module, mis à jour là où `renderer.setSize` est appelé (`_res.w = renderer.domElement.width; _res.h = renderer.domElement.height;`). Et dans le bloc météo, après `const density = …` (`:1784-1787`) : `lastFogDensity = density;`.

5. `respawn()` : après `crashed = false;` (fin de la fonction) : `ambient?.reset();`. `__sim.teleport` : après `linkForced = false;` : `ambient?.reset();`.

6. `__sim` : ajouter `ambient: () => ambient,` dans l'objet (`:561`), et dans `debug()` : `ambient: ambient?.debug(),`.

7. `linkDead` (`:1711`, après `space.silence();`) : `ambient?.silence();`.

8. `openFlightSession()`, après le `try { … }` qui pose `tgt` (juste avant `applyTargetCamera(...)`, ~`:2807`) :

```js
	// Les ambiants (issue #250) : le scan du client (session fraîche), ou
	// celui que la session persistée a gardé (resume, schéma v2), ou un scan
	// de dev en ?scene=, ou rien.
	ambient?.setScan(
		flyTarget ?? tgt?.scan ?? (OPTS.scene && !MODE.bench ? { seed: `dev::${flyArea}`, count: 4, index: 0 } : null),
	);
```

9. Fin de page, à côté de `droneOsd?.dispose()` (`:2811`) : `ambient?.dispose();` — vérifier que cet endroit est bien un démontage et non le début d'un vol ; sinon ne l'ajouter qu'au `beforeunload` (`:2830`).

- [ ] **Step 5 : Lancer les suites et le build**

Run: `cd sim && npm run selftest 2>&1 | tail -6 && npm run selftest:operator 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: selftest tout PASS (dont les 3 checks ambient), selftest:operator exit 0, build OK.

- [ ] **Step 6 : Commit**

```bash
git add src/ambient-drones.js src/main.js tools/selftest.mjs tools/ambient-audio-model.mjs tools/ambient-audio-selftest.mjs
git commit -m "feat(ambiants): l'instance et le câblage — FIELD seulement, bulle live, resume, __sim (#250)"
```

---

### Task 10 : Vérification navigateur par l'opérateur, HANDOFF, issue

**Files:**
- Modify: `HANDOFF.md` (section « Vérifié » / « Non vérifié »)
- Issue #250 (commentaire)

- [ ] **Step 1 : Écrire la marche à suivre dans HANDOFF.md**

Sous « Vérifié », un bloc **Drones ambiants (issue #250)** listant ce que les selftests couvrent (ambient 60+ checks, drone-shape, drone-mesh, ambient-audio, bloc scène de `selftest.mjs`). Sous « Non vérifié / à faire », la marche à suivre pour l'opérateur, dans Chrome :

```text
1. npm run dev, FIELD, une zone, TARGET SCAN avec ≥ 3 signaux, prendre un, hack, JACK IN.
2. Console : __sim.debug().ambient → count = signaux − 1, families, positions.
   Au banc : __sim.debug().ambient === undefined.
3. Regarder autour : un point qui bat (LED) doit se voir avant le corps ;
   s'en approcher à 30 m → un quad avec hélices floues, incliné dans ses virages.
   race : couché ; cinewhoop : à plat, nez vers son sujet ; long range : haut et droit ;
   micro : au ras du sol, nerveux.
4. Écoute : au casque, le passage d'un drone doit aller d'une oreille à l'autre,
   plus sourd dans le dos, glissando au passage (Doppler). Le moteur du joueur
   ne doit jamais pomper (limiteur) : si oui, baisser VOICE.g0.
5. __sim.debug().drawCalls avant/après = +2 par drone visible ; ambient.audioNodes
   constant en vol ; longtask nul (Performance panel, 30 s de vol).
6. Traverser la carte en long range : jamais de ciel vide, jamais de drone qui
   apparaît dans le champ (ambient.relocations monte, count reste = n).
7. Mode direct (LIVE) : même chose, count peut mettre quelques secondes à monter
   (terrain non chargé → spawnFailures monte puis se stabilise).
8. Resume d'une session LANDED : mêmes familles qu'à la première session.
```

- [ ] **Step 2 : Commenter l'issue #250**

```bash
gh issue comment 250 --body "Implémenté sur main (spec + plan dans sim/docs/superpowers). Selftests : ambient, drone-shape, drone-mesh, ambient-audio + bloc scène de selftest.mjs, tous verts. Non vérifié au navigateur — marche à suivre dans HANDOFF.md, section « Non vérifié ». Points à écouter/regarder : niveau des voix (VOICE.g0), lisibilité de la LED à 100 m, tilt du race en virage."
```

- [ ] **Step 3 : Commit et push**

```bash
git add HANDOFF.md
git commit -m "docs(ambiants): HANDOFF — état vérifié, marche à suivre navigateur (#250)"
git push
```

L'issue reste **In Progress** jusqu'à la vérification visuelle par l'opérateur ; c'est lui qui la ferme ou qui rouvre.

---

## Auto-revue du plan

**Couverture de la spec** : ensemble (T2) ; bulle, rayons, hors champ, petite carte, direct (T4, T9) ; routines par famille et TWR (T2) ; cinewhoop nez vers l'ancre, micro jitter, long range stade (T3, T5) ; validation 49 rayons, un candidat par frame, jamais à 250 Hz (T4, T9) ; attitude, vent, drag, lissage (T5) ; recette et maillage, matériau auto-éclairé, brouillard des tuiles, LED clampée, deux draw calls, dispose (T6, T7) ; son : quatre voix, sinus, détune, gain −12 dB, coupure distance et dos, Doppler à la main, pan lissé, envoi vers `space`, mute gelé, silence `linkDead` (T8, T9) ; intégration `finishBoot`/`bootLive`/`frame`/`respawn`/`teleport`/`__sim`/dispose (T9) ; persistance `target.scan`, schéma v2, resume exemplaire (T1) ; selftests purs, scène, navigateur par l'opérateur (T2–T10). Écarté : rien à implémenter.

**Types cohérents** : `bounds` = `{ bbox, corridor }` ou `{ center, trusted }` partout (T4, T9) ; `rays` duck-typé `{ groundBelow(x, y, z, max), obstructionBetween(ax,ay,az,bx,by,bz) }` — `physics` le satisfait ; `voices[i]` = `{ d, behind, pan, vRadial, accelMag, profile }` (T8, T9) ; `shape.parts[].role` (T6, T7) ; `scan = { seed, count, index }` (T1, T2, T9).

**Points d'attention pour l'exécutant** : la paramétrisation de la lemniscate (T3, note) ; `nominalMass` (T6, note) ; allocation de `azimuthPan` et de `{ ...src }` (T8, T9, notes) ; le chemin d'import de `BufferGeometryUtils` (T7) ; l'export de `AUDIO` (T8).
