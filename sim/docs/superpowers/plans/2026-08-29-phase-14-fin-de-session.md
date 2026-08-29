# PHASE 14 — Vol / crash / fin de session — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer l'écran de crash et le respawn par une fin de vol qui ne propose que d'en sortir — l'image meurt, puis `LINK LOST / TARGET LOST / SESSION TERMINATED` — et par une détection de pose mesurée qui mène à `LANDING DETECTED / MOTORS DISARMED / END SESSION`.

**Architecture:** Une machine à états pure (`src/flight-end.js`, ni DOM ni Three ni Rapier) reçoit chaque frame l'état du drone et sort ce qu'il faut afficher, s'il faut tuer le lien vidéo, et s'il faut fermer la session. `main.js` l'alimente et obéit ; `hud.js` rend ses lignes ; `lens.js`/`link.js` fournissent la mort de l'image sans une ligne de shader nouvelle.

**Tech Stack:** JS ES modules, Vite, Three.js, Rapier (`@dimforge/rapier3d-compat`), harnais de test en Node pur (`node:assert/strict`), pas de framework de test.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-14-fin-de-session-design.md`

## Global Constraints

- Tous les chemins sont relatifs à `sim/`. Toutes les commandes se lancent depuis `sim/`.
- **Textes du jeu en anglais.** Commentaires de code, commits et documentation interne en **français**.
- Aucun élément de DA ne devient une dépendance du moteur physique : `npm run selftest` doit rester vert à chaque tâche.
- `src/flight-end.js` n'importe **rien** : ni Three, ni Rapier, ni DOM. C'est ce qui le rend testable en Node.
- Tout le DOM reste dans `src/hud.js`. `main.js` n'écrit pas d'HTML.
- Les seuils de crash existants (`CRASH_IMPULSE = 1500`, `CRASH_IMPULSE_FLAT = 2800`, `src/main.js:40-43`) sont réutilisés tels quels : ni déplacés, ni re-choisis.
- Les seuils de pose sont **mesurés** (Tâche 3), jamais tapés à la main. Même règle que les PID.
- Pas de `GAME OVER`, pas de musique, pas de score, pas de blague, pas de récompense.
- Style du dépôt : tabulations pour l'indentation, pas de point-virgule manquant, commentaires qui expliquent *pourquoi*.

---

### Task 1: `src/flight-end.js` — la machine à états et la séquence de crash

**Files:**
- Create: `src/flight-end.js`
- Create: `tools/flight-end-selftest.mjs`

**Interfaces:**
- Consumes: rien (premier module).
- Produces:
  - `FLYING`, `LANDING_READY`, `LANDED`, `CRASHING`, `TERMINATED` — constantes chaîne, valeur = leur nom.
  - `TIMELINE` — `{ blackoutAt: number, blackoutFade: number, lines: Array<[number, string]>, exitAt: number }`, secondes depuis l'impact.
  - `LANDING` — `{ H_ON, H_OFF, V_ON, V_OFF, W_ON, THR_IDLE, T_HOLD }`, tous des nombres (provisoires ici, mesurés en Tâche 3).
  - `class FlightEnd`
    - `new FlightEnd({ timeline?, landing? })`
    - `get phase(): string`
    - `update({ dt, armed, height, speed, angularSpeed, throttle, crashed }): void`
    - `disarm(): boolean` — `true` si le geste a été pris comme une fin de session
    - `reset(): void`
    - `get out(): { phase, lines: string[], linkDead: boolean, blackout: number, exitArmed: boolean, closes: 'CRASHED'|'LANDED'|null }` — **le même objet muté chaque frame**, comme `link.out`.

- [ ] **Step 1: Écrire le harnais de test, séquence de crash uniquement**

Créer `tools/flight-end-selftest.mjs` :

```js
// Selftest de la machine de fin de vol (PHASE 14). Aucun DOM, aucun Rapier :
// des frames synthétiques, une horloge qu'on avance à la main.
// Lancer : node tools/flight-end-selftest.mjs
import assert from 'node:assert/strict';
import {
	FlightEnd, TIMELINE, LANDING,
	FLYING, LANDING_READY, LANDED, CRASHING, TERMINATED,
} from '../src/flight-end.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une frame de vol nominal : en l'air, armé, gaz au tiers.
const FLIGHT = { dt: 1 / 60, armed: true, height: 30, speed: 12, angularSpeed: 1, throttle: 0.35, crashed: false };
const frame = (over = {}) => ({ ...FLIGHT, ...over });

// Avance la machine de `seconds` en frames de 1/60, sans rien d'autre.
function advance(fe, seconds, over = {}) {
	const steps = Math.round(seconds * 60);
	for (let i = 0; i < steps; i++) fe.update(frame({ ...over, dt: 1 / 60 }));
}

t('au départ : en vol, rien à afficher, lien vivant', () => {
	const fe = new FlightEnd();
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.linkDead, false);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.out.closes, null);
});

t('impact : le lien meurt immédiatement, aucun texte encore', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, true);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
});

t('impact : la session se ferme sur CRASHED, une seule fois', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.closes, 'CRASHED');
	fe.update(frame({ crashed: true }));
	assert.equal(fe.out.closes, null);
	advance(fe, 6, { crashed: true });
	assert.equal(fe.out.closes, null);
});

t('séquence de crash : le noir avant le texte, puis les lignes dans l\'ordre', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));

	advance(fe, TIMELINE.blackoutAt - 0.1, { crashed: true });
	assert.equal(fe.out.blackout, 0, 'pas de noir avant blackoutAt');
	assert.deepEqual(fe.out.lines, [], 'pas de texte avant le noir');

	advance(fe, 0.1 + TIMELINE.blackoutFade + 0.05, { crashed: true });
	assert.equal(fe.out.blackout, 1, 'noir complet après le fondu');

	const seen = [];
	for (const [at, text] of TIMELINE.lines) {
		const fresh = new FlightEnd();
		fresh.update(frame({ crashed: true }));
		advance(fresh, at + 0.05, { crashed: true });
		seen.push(text);
		assert.deepEqual(fresh.out.lines, seen, `à t=${at}s`);
	}
});

t('la sortie ne s\'arme qu\'à la fin de la séquence', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, TIMELINE.exitAt - 0.1, { crashed: true });
	assert.equal(fe.out.exitArmed, false);
	assert.equal(fe.phase, CRASHING);
	advance(fe, 0.2, { crashed: true });
	assert.equal(fe.out.exitArmed, true);
	assert.equal(fe.phase, TERMINATED);
});

t('reset() ramène tout à l\'état de départ', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	advance(fe, 6, { crashed: true });
	fe.reset();
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	assert.equal(fe.out.linkDead, false);
	assert.equal(fe.out.blackout, 0);
	assert.equal(fe.out.exitArmed, false);
});

t('out est le même objet à chaque frame', () => {
	const fe = new FlightEnd();
	const o = fe.out;
	fe.update(frame());
	assert.equal(fe.out, o);
});

console.log(`\n${n} tests OK`);
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `node tools/flight-end-selftest.mjs`
Expected: FAIL — `Cannot find module '../src/flight-end.js'`

- [ ] **Step 3: Écrire `src/flight-end.js`, partie crash**

```js
// La fin d'un vol (PHASE 14). Machine à états pure : ni DOM, ni Three, ni
// Rapier. main.js l'alimente une fois par frame et obéit à ce qu'elle sort.
//
// Il n'y a pas de GAME OVER. Un crash n'est pas une défaite : c'est une machine
// distante qui cesse d'émettre. L'image meurt d'abord, le texte vient après, et
// c'est le joueur qui sort du contrôle — rien ne l'en sort à sa place.

export const FLYING = 'FLYING';
export const LANDING_READY = 'LANDING_READY';   // posé, encore armé
export const LANDED = 'LANDED';                 // posé, désarmé : fin propre
export const CRASHING = 'CRASHING';             // l'écran est en train de mourir
export const TERMINATED = 'TERMINATED';         // la séquence est finie

// Mise en scène, pas mesure : ces durées sont un choix, et elles se relisent
// d'un coup d'œil. Secondes depuis l'impact.
export const TIMELINE = {
	blackoutAt: 0.9,        // l'image morte reste à l'écran jusque-là
	blackoutFade: 0.4,      // puis le noir monte en autant de secondes
	lines: [
		[1.6, 'LINK LOST'],
		[2.8, 'TARGET LOST'],
		[3.6, 'SESSION TERMINATED'],
		[4.6, '[ESC] DISCONNECT'],
	],
	exitAt: 4.6,            // la sortie s'arme avec la dernière ligne
};

// Seuils de pose. PROVISOIRES : remplacés par tools/landing-selftest.mjs, qui
// les mesure. Ne pas les modifier à la main.
export const LANDING = {
	H_ON: 0.3,      // m, hauteur sol-drone sous laquelle on considère le contact
	H_OFF: 0.8,     // m, au-dessus de laquelle la pose est perdue (hystérésis)
	V_ON: 0.5,      // m/s
	V_OFF: 1.5,     // m/s
	W_ON: 0.5,      // rad/s — une sphère de collision qui roule n'est pas posée
	THR_IDLE: 0.06, // gaz coupés, même valeur que le `touchdown` de main.js
	T_HOLD: 1.0,    // s pendant lesquelles tout cela doit rester vrai
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class FlightEnd {
	constructor({ timeline = TIMELINE, landing = LANDING } = {}) {
		this.timeline = timeline;
		this.landing = landing;
		// Muté chaque frame plutôt que recréé, comme link.out et wind.out : ceci
		// tourne à la fréquence d'affichage.
		this.out = {
			phase: FLYING, lines: [], linkDead: false,
			blackout: 0, exitArmed: false, closes: null,
		};
		this.reset();
	}

	get phase() { return this._phase; }

	reset() {
		this._phase = FLYING;
		this._t = 0;        // secondes depuis l'impact
		this._hold = 0;     // secondes de pose stable accumulées
		this._pending = null;
		const o = this.out;
		o.phase = FLYING;
		o.lines.length = 0;
		o.linkDead = false;
		o.blackout = 0;
		o.exitArmed = false;
		o.closes = null;
	}

	// Le geste explicite du joueur. Ne ferme la session que sur une pose
	// reconnue : désarmer en l'air est permis, mais c'est une chute, et c'est
	// l'impact qui conclura.
	disarm() {
		if (this._phase !== LANDING_READY) return false;
		this._phase = LANDED;
		const o = this.out;
		o.lines.length = 0;
		o.lines.push('LANDING DETECTED', 'MOTORS DISARMED', '', 'END SESSION');
		o.exitArmed = true;
		// Consommé par le prochain update() : la fermeture de session sort ainsi
		// toujours du même endroit, jamais du gestionnaire de touche.
		this._pending = 'LANDED';
		return true;
	}

	update({ dt = 0, armed = false, height = Infinity, speed = 0,
	         angularSpeed = 0, throttle = 0, crashed = false } = {}) {
		const o = this.out;
		// `closes` est un événement : visible une frame, jamais deux.
		o.closes = this._pending;
		this._pending = null;

		if (crashed && this._phase !== CRASHING && this._phase !== TERMINATED
			&& this._phase !== LANDED) {
			this._phase = CRASHING;
			this._t = 0;
			this._hold = 0;
			o.lines.length = 0;
			// L'image meurt à l'instant du choc, avant tout texte.
			o.linkDead = true;
			o.closes = 'CRASHED';
		}

		if (this._phase === CRASHING || this._phase === TERMINATED) {
			this._advanceCrash(dt);
		} else if (this._phase === FLYING || this._phase === LANDING_READY) {
			this._advanceLanding({ dt, armed, height, speed, angularSpeed, throttle });
		}

		o.phase = this._phase;
	}

	_advanceCrash(dt) {
		const o = this.out, tl = this.timeline;
		this._t += dt;
		o.blackout = clamp01((this._t - tl.blackoutAt) / tl.blackoutFade);
		o.lines.length = 0;
		for (const [at, text] of tl.lines) if (this._t >= at) o.lines.push(text);
		if (this._t >= tl.exitAt) {
			this._phase = TERMINATED;
			o.exitArmed = true;
		}
	}

	_advanceLanding() {
		// Tâche 2.
	}
}
```

- [ ] **Step 4: Lancer le test, vérifier qu'il passe**

Run: `node tools/flight-end-selftest.mjs`
Expected: PASS — `7 tests OK`

- [ ] **Step 5: Commit**

```bash
git add src/flight-end.js tools/flight-end-selftest.mjs
git commit -m "Fin de session : machine à états et séquence de crash (PHASE 14)"
```

---

### Task 2: Détection de pose dans `src/flight-end.js`

**Files:**
- Modify: `src/flight-end.js` (`_advanceLanding`)
- Modify: `tools/flight-end-selftest.mjs` (tests ajoutés à la suite)

**Interfaces:**
- Consumes: `FlightEnd`, `LANDING`, `LANDING_READY`, `LANDED` de la Tâche 1.
- Produces: `FLYING → LANDING_READY → LANDED`, et `out.lines = ['LANDING DETECTED']` en `LANDING_READY`.

- [ ] **Step 1: Écrire les tests de pose**

Ajouter dans `tools/flight-end-selftest.mjs`, **avant** la ligne `console.log(\`\n${n} tests OK\`)` :

```js
// Une frame de drone posé : au contact, immobile, gaz coupés.
const SETTLED = { dt: 1 / 60, armed: true, height: 0.16, speed: 0.02, angularSpeed: 0.05, throttle: 0, crashed: false };
const settled = (over = {}) => ({ ...SETTLED, ...over });

function hold(fe, seconds, over = {}) {
	const steps = Math.round(seconds * 60);
	for (let i = 0; i < steps; i++) fe.update(settled({ ...over, dt: 1 / 60 }));
}

t('pose : rien avant T_HOLD, LANDING DETECTED après', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD - 0.2);
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
	hold(fe, 0.4);
	assert.equal(fe.phase, LANDING_READY);
	assert.deepEqual(fe.out.lines, ['LANDING DETECTED']);
});

t('vol rasant : sous la hauteur mais trop vite → jamais de détection', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { height: LANDING.H_ON * 0.5, speed: LANDING.V_ON + 5 });
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
});

t('gaz remis : la pose ne compte pas', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { throttle: 0.4 });
	assert.equal(fe.phase, FLYING);
});

t('sphère qui roule : la vitesse angulaire empêche la détection', () => {
	const fe = new FlightEnd();
	hold(fe, 5, { angularSpeed: LANDING.W_ON + 1 });
	assert.equal(fe.phase, FLYING);
});

t('touchers successifs : le compteur repart de zéro à chaque rebond', () => {
	const fe = new FlightEnd();
	for (let i = 0; i < 6; i++) {
		hold(fe, LANDING.T_HOLD * 0.6);
		hold(fe, 0.2, { height: LANDING.H_OFF + 2, speed: 4 });
	}
	assert.equal(fe.phase, FLYING);
});

t('redécollage : LANDING_READY est perdu dès que le drone repart', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.phase, LANDING_READY);
	fe.update(settled({ height: LANDING.H_OFF + 1 }));
	assert.equal(fe.phase, FLYING);
	assert.deepEqual(fe.out.lines, []);
});

t('désarmement sur une pose : MOTORS DISARMED, END SESSION, LANDED une fois', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.disarm(), true);
	assert.equal(fe.phase, LANDED);
	assert.deepEqual(fe.out.lines, ['LANDING DETECTED', 'MOTORS DISARMED', '', 'END SESSION']);
	assert.equal(fe.out.exitArmed, true);
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, 'LANDED');
	fe.update(settled({ armed: false }));
	assert.equal(fe.out.closes, null);
});

t('désarmement en vol : rien ne se ferme, la chute suit son cours', () => {
	const fe = new FlightEnd();
	fe.update(frame());
	assert.equal(fe.disarm(), false);
	assert.equal(fe.phase, FLYING);
	fe.update(frame({ armed: false }));
	assert.equal(fe.out.closes, null);
	fe.update(frame({ armed: false, crashed: true }));
	assert.equal(fe.out.closes, 'CRASHED');
});

t('crash pendant LANDING_READY : le crash gagne', () => {
	const fe = new FlightEnd();
	hold(fe, LANDING.T_HOLD + 0.3);
	assert.equal(fe.phase, LANDING_READY);
	fe.update(settled({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.closes, 'CRASHED');
	assert.deepEqual(fe.out.lines, []);
});

t('une carcasse immobile au sol n\'est pas un atterrissage', () => {
	const fe = new FlightEnd();
	fe.update(frame({ crashed: true }));
	hold(fe, 3, { crashed: true });
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.disarm(), false);
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `node tools/flight-end-selftest.mjs`
Expected: FAIL — le premier test de pose casse : `expected 'LANDING_READY' to equal 'FLYING'` (`_advanceLanding` ne fait rien).

- [ ] **Step 3: Implémenter `_advanceLanding`**

Remplacer le stub de `src/flight-end.js` par :

```js
	// La pose, mesurée dans le temps plutôt que devinée sur une frame. Le faux
	// positif à écarter est le vol rasant : bas, mais rapide. C'est la vitesse
	// qui sépare les deux, la durée qui écarte les rebonds, et la vitesse
	// angulaire qui écarte la sphère de collision qui roule sans fin.
	_advanceLanding({ dt, armed, height, speed, angularSpeed, throttle }) {
		const o = this.out, L = this.landing;

		if (this._phase === LANDING_READY) {
			// Hystérésis : on sort de la pose plus facilement qu'on n'y entre. Un
			// drone qui repart n'a pas à attendre T_HOLD pour cesser d'être posé.
			if (height > L.H_OFF || speed > L.V_OFF || !armed) {
				this._phase = FLYING;
				this._hold = 0;
				o.lines.length = 0;
			}
			return;
		}

		const stable = armed
			&& height < L.H_ON
			&& speed < L.V_ON
			&& angularSpeed < L.W_ON
			&& throttle < L.THR_IDLE;
		this._hold = stable ? this._hold + dt : 0;
		if (this._hold >= L.T_HOLD) {
			this._phase = LANDING_READY;
			o.lines.length = 0;
			o.lines.push('LANDING DETECTED');
		}
	}
```

- [ ] **Step 4: Lancer, vérifier que tout passe**

Run: `node tools/flight-end-selftest.mjs`
Expected: PASS — `17 tests OK`

- [ ] **Step 5: Commit**

```bash
git add src/flight-end.js tools/flight-end-selftest.mjs
git commit -m "Fin de session : détection de pose tenue dans le temps (PHASE 14)"
```

---

### Task 3: `tools/landing-selftest.mjs` — mesurer les seuils

**Files:**
- Create: `tools/landing-selftest.mjs`
- Modify: `src/flight-end.js` (bloc `LANDING`, valeurs mesurées + commentaire de mesure)

**Interfaces:**
- Consumes: `FlightEnd`, `LANDING` (Tâches 1-2) ; `initPhysics`, `Physics` de `src/physics.js` ; `FlightController` de `src/flightController.js`.
- Produces: les valeurs définitives de `LANDING`, et un test de non-régression qui échoue si un rasant déclenche la pose ou si une pose n'est pas reconnue.

**Contexte pour l'implémenteur.** `tools/selftest.mjs:1-30` montre exactement comment ouvrir une scène headless : lire `manifest.json`, lire `collision.bin` (en-tête de 16 octets, `vertexCount` en `UInt32LE` à l'offset 8, `indexCount` à 12, puis les `Float32` puis les `Uint32`), `await initPhysics()`, `new Physics(collision, manifest.spawn)`. **Un seul monde Rapier par processus** : plusieurs trimeshes de 3,7 M triangles épuisent le tas wasm. Chaque trajectoire repose donc le même corps avec `body.setTranslation` / `setLinvel` / `setAngvel` au lieu de recréer un monde. Le pas physique est `1/250`. `physics.groundBelow(x, y, z)` rend l'altitude du sol sous un point, ou `null`. La hauteur utile est `p.y - groundBelow(...)`. Le contrôleur a trois modes (`acro`, `angle`, `altitude`, `src/flightController.js:21`) ; `altitude` sert au rasant, qui doit tenir sa hauteur pendant qu'il avance.

- [ ] **Step 1: Écrire le harnais**

Créer `tools/landing-selftest.mjs` :

```js
// Mesure les seuils de détection de pose (PHASE 14) et vérifie qu'ils tiennent.
//
//   node tools/landing-selftest.mjs [sceneDir]
//   node tools/landing-selftest.mjs --report      # imprime les distributions
//
// Deux familles de trajectoires sont rejouées dans le vrai Rapier :
//   - des poses     : le drone doit être reconnu comme posé ;
//   - des rasants   : bas et rapides, ils ne doivent JAMAIS l'être. C'est le
//                     faux positif que l'issue #51 interdit, et c'est lui qui
//                     fixe la marge.
// Les seuils de src/flight-end.js sont posés dans la zone de séparation
// observée. CLAUDE.md : mesurés, pas choisis à la main.
import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics } from '../src/physics.js';
import { FlightController } from '../src/flightController.js';
import { FlightEnd, LANDING, LANDING_READY } from '../src/flight-end.js';

const args = process.argv.slice(2);
const REPORT = args.includes('--report');
const sceneDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'public/scenes/tour-eiffel');

const manifest = JSON.parse(fs.readFileSync(path.join(sceneDir, 'manifest.json')));
const raw = fs.readFileSync(path.join(sceneDir, 'collision.bin'));
const vc = raw.readUInt32LE(8), ic = raw.readUInt32LE(12);
const collision = {
	vertices: new Float32Array(raw.buffer, raw.byteOffset + 16, vc * 3),
	indices: new Uint32Array(raw.buffer, raw.byteOffset + 16 + vc * 12, ic),
};

await initPhysics();
// Un seul monde : plusieurs trimeshes pleine résolution épuisent le tas wasm.
const phys = new Physics(collision, manifest.spawn);
const STEP = 1 / 250;
const SPAWN = manifest.spawn;

const ZERO = { x: 0, y: 0, z: 0 };
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };

// Repose le corps à `height` mètres au-dessus du sol du spawn, à plat, immobile.
function place(height, vel = ZERO) {
	const g = phys.groundBelow(SPAWN.x, SPAWN.y + 200, SPAWN.z) ?? SPAWN.y;
	phys.body.setTranslation({ x: SPAWN.x, y: g + height, z: SPAWN.z }, true);
	phys.body.setRotation(LEVEL, true);
	phys.body.setLinvel(vel, true);
	phys.body.setAngvel(ZERO, true);
	phys.setGroundHold(false);
	return g;
}

function heightNow() {
	const p = phys.position;
	const g = phys.groundBelow(p.x, p.y, p.z);
	return g === null ? Infinity : p.y - g;
}

// Rejoue une trajectoire et rend la trace de ce que la machine à états verrait.
// `sticks(t, state)` rend les manches ; `seconds` la durée simulée.
function fly({ sticks, seconds, mode = 'acro', windless = true }) {
	const fc = new FlightController();
	fc.setMode(mode);
	fc.arm();
	if (windless) phys.setWind(ZERO, 0);
	const trace = [];
	const steps = Math.round(seconds / STEP);
	for (let i = 0; i < steps; i++) {
		const t = i * STEP;
		const h = heightNow();
		const s = sticks(t, { height: h, velocity: phys.velocity });
		// Même règle que main.js : gaz coupés au ras du sol → moteurs à zéro et
		// groundHold, sinon une sphère de collision roule sans fin.
		const touchdown = s.throttle < 0.06 && h < 0.6;
		phys.setGroundHold(touchdown);
		const { motors } = fc.update(s, phys, STEP);
		if (touchdown) motors.fill(0);
		phys.step(motors, STEP);
		const v = phys.velocity, w = phys.angularVelocity;
		trace.push({
			t,
			height: heightNow(),
			speed: Math.hypot(v.x, v.y, v.z),
			angularSpeed: Math.hypot(w.x, w.y, w.z),
			throttle: s.throttle,
		});
	}
	return trace;
}

const stick = (over = {}) => ({ throttle: 0, roll: 0, pitch: 0, yaw: 0, ...over });

// --- les poses -------------------------------------------------------------
// Descente gaz coupés depuis trois hauteurs, puis on laisse le drone s'immobiliser.
const LANDINGS = [1, 3, 8].map((h) => ({
	name: `pose depuis ${h} m`,
	run: () => { place(h); return fly({ sticks: () => stick({ throttle: 0 }), seconds: 6 }); },
}));

// Pose vent de travers : le drone est poussé pendant qu'il se pose.
LANDINGS.push({
	name: 'pose par vent de travers (8 m/s)',
	run: () => {
		place(3);
		const fc = { sticks: () => stick({ throttle: 0 }) };
		phys.setWind({ x: 8, y: 0, z: 0 }, 0.3);
		const trace = fly({ ...fc, seconds: 8, windless: false });
		phys.setWind(ZERO, 0);
		return trace;
	},
});

// --- les rasants (faux positifs) -------------------------------------------
// Passage bas et rapide : mode altitude pour tenir la hauteur, tangage plein
// pot pour la vitesse.
const PASSES = [];
for (const h of [0.3, 0.6, 1.0]) {
	for (const push of [0.3, 0.6, 1.0]) {
		PASSES.push({
			name: `rasant ${h} m, tangage ${push}`,
			run: () => {
				place(h + 0.2);
				return fly({
					mode: 'altitude',
					seconds: 6,
					sticks: (t, st) => stick({
						// Servo d'altitude simple autour de la hauteur visée : le mode
						// altitude tient la sienne, ce P la ramène sur la nôtre.
						throttle: Math.max(0, Math.min(1, 0.5 + (h - st.height) * 0.5)),
						pitch: t > 0.5 ? push : 0,
					}),
				});
			},
		});
	}
}

// Stationnaire bas : lent, bas, mais gaz mis — ce n'est pas une pose.
PASSES.push({
	name: 'stationnaire bas (gaz mis)',
	run: () => {
		place(0.5);
		return fly({
			mode: 'altitude', seconds: 6,
			sticks: (t, st) => stick({ throttle: Math.max(0, Math.min(1, 0.5 + (0.5 - st.height) * 0.5)) }),
		});
	},
});

// --- mesure ----------------------------------------------------------------
// Ce que la machine verrait sur cette trace : est-elle passée en LANDING_READY ?
function detects(trace) {
	const fe = new FlightEnd();
	for (let i = 1; i < trace.length; i++) {
		const s = trace[i];
		fe.update({ dt: STEP, armed: true, crashed: false, ...s });
		if (fe.phase === LANDING_READY) return s.t;
	}
	return null;
}

// La fenêtre stable de fin de trace : ce que « posé » vaut réellement ici.
function tail(trace, seconds = 1.5) {
	const from = trace[trace.length - 1].t - seconds;
	return trace.filter((s) => s.t >= from);
}
const maxOf = (rows, key) => rows.reduce((m, r) => Math.max(m, r[key]), 0);

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

console.log('\nposes');
const landStats = [];
for (const c of LANDINGS) {
	const trace = c.run();
	const end = tail(trace);
	const at = detects(trace);
	landStats.push({ name: c.name, h: maxOf(end, 'height'), v: maxOf(end, 'speed'), w: maxOf(end, 'angularSpeed') });
	check(`${c.name} : reconnue`, at !== null,
		at === null ? 'jamais détectée' : `à t=${at.toFixed(2)}s`);
}

console.log('\nrasants (aucun ne doit être reconnu)');
const passStats = [];
for (const c of PASSES) {
	const trace = c.run();
	const at = detects(trace);
	const flying = trace.filter((s) => s.t > 1);
	passStats.push({ name: c.name, h: Math.min(...flying.map((s) => s.height)), v: Math.min(...flying.map((s) => s.speed)) });
	check(`${c.name} : rejeté`, at === null, at === null ? '' : `faux positif à t=${at.toFixed(2)}s`);
}

if (REPORT) {
	console.log('\nposes — fin de trace (max sur 1,5 s) :');
	for (const s of landStats) console.log(`  ${s.name.padEnd(34)} h=${s.h.toFixed(3)}m v=${s.v.toFixed(3)}m/s w=${s.w.toFixed(3)}rad/s`);
	console.log('\nrasants — minimums en vol :');
	for (const s of passStats) console.log(`  ${s.name.padEnd(34)} h=${s.h.toFixed(3)}m v=${s.v.toFixed(3)}m/s`);
	const hPose = Math.max(...landStats.map((s) => s.h));
	const vPose = Math.max(...landStats.map((s) => s.v));
	const vPass = Math.min(...passStats.map((s) => s.v));
	console.log(`\nséparation : hauteur posée <= ${hPose.toFixed(3)}m · vitesse posée <= ${vPose.toFixed(3)}m/s · vitesse rasante >= ${vPass.toFixed(3)}m/s`);
	console.log(`seuils actuels : H_ON=${LANDING.H_ON} V_ON=${LANDING.V_ON} W_ON=${LANDING.W_ON} T_HOLD=${LANDING.T_HOLD}`);
}

console.log(failures ? `\n${failures} échec(s)` : '\nOK');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Lancer le rapport et lire les distributions**

Run: `node tools/landing-selftest.mjs --report`

Ne rien conclure avant d'avoir lu la sortie. Le rapport donne trois nombres qui décident :
- `hauteur posée` — le maximum de la hauteur en fin de trace sur toutes les poses ;
- `vitesse posée` — idem pour la vitesse ;
- `vitesse rasante` — le minimum de vitesse atteint par un rasant en vol.

- [ ] **Step 3: Poser les seuils dans la zone de séparation**

Éditer le bloc `LANDING` de `src/flight-end.js` avec les valeurs lues, en suivant cette règle, et **remplacer** le commentaire « PROVISOIRES » par la mesure qui les justifie (date, scène, valeurs observées) :

- `H_ON` = `hauteur posée` arrondie au-dessus, avec ~30 % de marge ;
- `V_ON` = à mi-chemin, en échelle log, entre `vitesse posée` et `vitesse rasante` ; si les deux se chevauchent, c'est que la vitesse ne sépare pas et il faut le dire dans le commentaire plutôt que de forcer un nombre ;
- `H_OFF` = `2 × H_ON`, `V_OFF` = `3 × V_ON` — l'hystérésis, pas une mesure ;
- `W_ON` = maximum de `w` en fin de pose, doublé ;
- `T_HOLD` : le plus petit multiple de 0,25 s tel que toutes les poses soient reconnues et aucun rasant ne le soit.

Exemple de la forme attendue du commentaire (les nombres viennent de **votre** exécution, pas de cet exemple) :

```js
// Seuils de pose, mesurés par tools/landing-selftest.mjs sur
// public/scenes/tour-eiffel le 2026-08-29 : une pose se stabilise sous
// h=0.171 m / v=0.043 m/s / w=0.112 rad/s, alors qu'un rasant ne descend
// jamais sous v=3.9 m/s. La vitesse sépare largement les deux familles ;
// H_OFF et V_OFF sont l'hystérésis de sortie, pas une mesure.
export const LANDING = { ... };
```

- [ ] **Step 4: Re-lancer, tout doit passer**

Run: `node tools/landing-selftest.mjs`
Expected: PASS pour chaque pose et chaque rasant, puis `OK`, code de sortie 0.

Run: `node tools/flight-end-selftest.mjs`
Expected: PASS — les tests de la Tâche 2 sont écrits en fonction de `LANDING`, ils suivent les nouvelles valeurs.

Si un rasant est un faux positif : ne pas remonter `T_HOLD` jusqu'à ce que ça passe. Regarder d'abord **pourquoi** ce rasant ressemble à une pose dans le rapport, et le dire dans le commentaire.

- [ ] **Step 5: Commit**

```bash
git add src/flight-end.js tools/landing-selftest.mjs
git commit -m "Fin de session : seuils de pose mesurés au banc Rapier (PHASE 14)"
```

---

### Task 4: L'écran de fin dans `src/hud.js`

**Files:**
- Modify: `src/hud.js` (gabarit ~ligne 46, table `this.el` ~ligne 71, `update()` ~ligne 144)
- Modify: `src/style.css` (bloc `#crash, #pause, #session-status`, lignes 79-92)
- Modify: `tools/flight-end-selftest.mjs` — non ; le HUD n'est pas testable headless, il se vérifie en Tâche 6.

**Interfaces:**
- Consumes: `out.lines`, `out.blackout` de `FlightEnd`.
- Produces: `hud.setFlightEnd({ lines, blackout })` — `lines: string[]` (une chaîne vide = une ligne blanche), `blackout: number` 0..1. Appelée chaque frame ; ne fait rien de coûteux quand `lines` est vide et `blackout` vaut 0.

- [ ] **Step 1: Retirer l'écran de mort et la touche R du gabarit**

Dans `src/hud.js`, supprimer la ligne :

```html
				<div id="crash" hidden>CRASH<small>R pour repartir</small></div>
```

et la remplacer par :

```html
				<div id="flight-end" hidden></div>
```

Dans la même chaîne de gabarit, l'aide en bas à droite perd `R` :

```html
					<b>J</b> désarmer · <b>M</b> mode · <b>P</b> rates · <b>C</b> caméra libre · <b>Espace</b> pause · <b>Tab</b> réglages
```

Dans la table `this.el`, remplacer `crash: root.querySelector('#crash'),` par `flightEnd: root.querySelector('#flight-end'),`.

- [ ] **Step 2: Ajouter `setFlightEnd` et retirer `crashed` de `update()`**

Dans `src/hud.js`, ajouter après `setSessionStatus` :

```js
	// L'écran de fin de vol (PHASE 14). Il n'annonce pas une défaite : il montre
	// un lien qui s'éteint. `blackout` est l'opacité du noir qui recouvre la
	// dernière image, `lines` ce qui s'écrit dessus, une ligne à la fois.
	setFlightEnd({ lines, blackout }) {
		const e = this.el.flightEnd;
		if (!lines.length && blackout <= 0) {
			if (!e.hidden) { e.hidden = true; e.textContent = ''; this._endLines = ''; }
			return;
		}
		e.hidden = false;
		e.style.background = `rgba(0, 0, 0, ${blackout})`;
		// Le DOM n'est reconstruit que quand le texte change : ceci tourne à la
		// fréquence d'affichage pendant toute la séquence.
		const key = lines.join('\n');
		if (key !== this._endLines) {
			this._endLines = key;
			e.replaceChildren(...lines.map((text) => {
				const d = document.createElement('div');
				d.textContent = text;
				return d;
			}));
		}
	}
```

Initialiser `this._endLines = '';` juste après `this._fpsAt = performance.now();` dans le constructeur.

Dans la signature de `update()`, retirer `crashed` de la déstructuration, et supprimer la ligne `this.el.crash.hidden = !crashed;`.

- [ ] **Step 3: Styler l'écran de fin**

Dans `src/style.css`, remplacer `#crash, #pause, #session-status {` par `#pause, #session-status {`, et `#crash small, #pause small,` par `#pause small,`. Ajouter à la suite du bloc :

```css
/* Fin de vol (PHASE 14) : pas un écran de mort, un lien qui s'éteint. */
#flight-end {
	position: absolute; inset: 0;
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: .5em;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 22px; letter-spacing: .35em; text-transform: uppercase;
	color: #c8d4dd;
	pointer-events: none;
}
#flight-end div:empty { height: .6em; }
```

- [ ] **Step 4: Vérifier que rien n'est cassé**

Run: `npm run build`
Expected: build Vite réussi, aucune erreur. (`main.js` référence encore `crashed` dans son appel à `hud.update()` : c'est sans effet, la propriété est simplement ignorée. La Tâche 5 la retire.)

Run: `grep -rn "el.crash\|#crash" src/`
Expected: aucun résultat.

- [ ] **Step 5: Commit**

```bash
git add src/hud.js src/style.css
git commit -m "Fin de session : écran de fin, suppression de l'écran de mort (PHASE 14)"
```

---

### Task 5: Câbler `src/main.js`

**Files:**
- Modify: `src/main.js` — imports (~ligne 24), état (~ligne 122), `input.onAction` (442-451), `doDisarm()` (463-489), `respawn()` (490-508), la boucle physique (607-631), le rendu du lens (~711), l'appel `hud.update()` (~730), `__sim.debug()` (~426)

**Interfaces:**
- Consumes: `FlightEnd`, `CRASHING` de `src/flight-end.js` ; `hud.setFlightEnd` de la Tâche 4.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Importer et instancier la machine**

Ajouter aux imports de `src/main.js` :

```js
import { FlightEnd } from './flight-end.js';
```

Remplacer `let crashed = false;` (ligne 122) par :

```js
const flightEnd = new FlightEnd();
// Le lien vu par lens.js quand la machine est morte : quality 0 et frozen sont
// exactement ce que le shader interprète déjà comme « plus rien n'arrive ».
// Aucun code d'image nouveau, seulement le mode de dégradation le plus profond.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };
let linkForced = false;
```

- [ ] **Step 2: Alimenter la machine et fermer la session depuis elle**

Dans la boucle physique, remplacer le bloc de détection de crash (lignes 617-627, de `if (impact > 0 && !crashed) {` jusqu'à sa fermeture) par :

```js
			if (impact > 0 && !flightEnd.out.linkDead) {
				const r = physics.rotation;
				const upright = (1 - 2 * (r.x * r.x + r.z * r.z)) > 0.4;
				// Un drone qui arrive à plat encaisse : les bras fléchissent, les
				// hélices absorbent. Nez en avant ou sur le dos, il casse. Le seuil
				// de crash suit donc l'assiette au moment du choc.
				if (impact > (upright ? CRASH_IMPULSE_FLAT : CRASH_IMPULSE)) crashedThisFrame = true;
			}
```

Déclarer `let crashedThisFrame = false;` juste avant `let peakImpact = 0;` (ligne 593).

Après la boucle `while` et son `if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;`, ajouter :

```js
		// La fin de vol décide seule : ce qui s'affiche, quand l'image meurt,
		// quand la session se ferme. main.js ne fait que l'alimenter et obéir.
		const fp = physics.position;
		const fg = physics.groundBelow(fp.x, fp.y, fp.z);
		const fv = physics.velocity, fw = physics.angularVelocity;
		flightEnd.update({
			dt,
			armed: controller.armed,
			height: fg === null ? Infinity : fp.y - fg,
			speed: Math.hypot(fv.x, fv.y, fv.z),
			angularSpeed: Math.hypot(fw.x, fw.y, fw.z),
			throttle: sticks.throttle,
			crashed: crashedThisFrame,
		});
		if (crashedThisFrame) {
			// Le drone est détruit : les moteurs se taisent, donc le son aussi —
			// audio.js suit le régime moteur, il n'y a rien à couper à la main.
			controller.disarm();
			// Si le joueur avait coupé la modélisation du lien, il ne verrait
			// aucune dégradation. La mort de l'image ne se négocie pas.
			if (!linkForced) {
				linkForced = true;
				lens.setLink({ mode: lensLinkMode === LINK_OFF ? LINK_ANALOG : lensLinkMode, severity: 1 });
			}
		}
		const closes = flightEnd.out.closes;
		if (closes) {
			session.end(closes).then((s) => s && console.log(`[session] ${closes}`, s));
		}
```

`lensLinkMode` n'existe pas encore. Le mode du lens n'est écrit qu'à un seul endroit, la callback des réglages `settings.setLink` (`src/main.js:287-294`) ; le mémoriser là. Déclarer `let lensLinkMode = LINK_OFF;` près des autres `let` d'état, et réécrire la callback ainsi :

```js
	settings.setLink(loadLink(), (p) => {
		link.setSeverity(p.severity);
		// Mémorisé : la séquence de crash doit pouvoir forcer une dégradation
		// même si le joueur a coupé la modélisation du lien.
		lensLinkMode = p.severity === 0 ? LINK_OFF
			: p.mode === 'digital' ? LINK_DIGITAL : LINK_ANALOG;
		lens.setLink({ mode: lensLinkMode, severity: p.severity });
	});
```

- [ ] **Step 3: Faire mourir l'image, afficher l'écran, retirer `crashed` du HUD**

Remplacer l'appel au lens (`lens.render(camera, dt, freeCamOn ? null : link.out);`) par :

```js
	// Free camera is not looking down the drone's video feed, so it gets a clean
	// picture — same reasoning as muting the motors there. The model keeps
	// running, so coming back does not start from a stale RSSI.
	const linkOut = flightEnd.out.linkDead ? DEAD_LINK : link.out;
	lens.render(camera, dt, freeCamOn ? null : linkOut);
```

Dans l'appel `hud.update({...})`, retirer la ligne `crashed,`. Juste après cet appel, ajouter :

```js
	hud.setFlightEnd(flightEnd.out);
```

Dans `__sim.debug()`, remplacer `crashed,` par `flightEnd: flightEnd.out.phase,`.

- [ ] **Step 4: Supprimer `respawn()`, brancher la sortie**

Supprimer entièrement la fonction `respawn()` (lignes 490-508) et sa branche dans `input.onAction`. Le nouveau gestionnaire :

```js
input.onAction = (key, event) => {
	// Pas de respawn : on ne fait pas réapparaître un drone qu'on a perdu.
	// terrain persistent, flights ephemeral.
	if (key === 'disarm') doDisarm();
	else if (key === ' ') { event.preventDefault(); togglePause(); }
	else if (key === 'p') controller?.cyclePreset();
	else if (key === 'm') controller?.cycleMode();
	else if (key === 'c') toggleFreeCam();
	else if (key === 'tab') { event.preventDefault(); settings.toggleSettings(); }
	else if (key === 'escape' && settings.settingsOpen) settings.toggleSettings(false);
	// Le joueur sort lui-même du contrôle : rien ne le sort à sa place, et rien
	// d'autre n'est proposé.
	else if (key === 'escape' && flightEnd.out.exitArmed) location.href = location.pathname;
};
```

Retirer aussi `'r'` de la liste des touches transmises par `src/input.js:167` : elle n'a plus de destinataire. C'est la seule occurrence de `'r'` dans ce fichier — le vérifier avec `grep -n "'r'" src/input.js` avant et après.

- [ ] **Step 5: Réduire `doDisarm()`**

Remplacer tout le corps de `doDisarm()` par :

```js
// Désarmement Betaflight. Le geste reste celui du joueur ; c'est la machine de
// fin de vol qui sait si le drone était posé. Désarmer en l'air est permis : la
// chute suit son cours, et c'est l'impact qui conclut.
function doDisarm() {
	if (!physics || !controller.armed) return;
	controller.disarm();
	if (!flightEnd.disarm()) return;
	// Posé : on le fige, il ne roule pas et ne dérive pas.
	physics.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
	physics.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
```

Le `hud.setSessionStatus(...)` de l'ancienne version disparaît : les textes de fin appartiennent désormais à l'écran de fin.

- [ ] **Step 6: Vérifier**

Run: `npm run build`
Expected: build réussi.

Run: `grep -n "crashed\|respawn" src/main.js`
Expected: seulement `crashedThisFrame` et le commentaire du `onAction`. Aucun `let crashed`, aucune fonction `respawn`.

Run: `node tools/selftest.mjs public/scenes/tour-eiffel`
Expected: aucun `FAIL` — la physique n'a pas bougé.

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/input.js
git commit -m "Fin de session : câblage main.js, R et respawn retirés du vol (PHASE 14)"
```

---

### Task 6: Chaîne de tests, vérification en vol, documentation

**Files:**
- Modify: `package.json` (script `selftest:operator`)
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien.

- [ ] **Step 1: Ajouter les deux harnais à la chaîne**

Dans `package.json`, à la fin de la valeur de `selftest:operator`, ajouter :

```
 && node tools/flight-end-selftest.mjs && node tools/landing-selftest.mjs
```

- [ ] **Step 2: Lancer toute la chaîne**

Run: `npm run selftest:operator`
Expected: chaque harnais finit sans échec, code de sortie 0.

Run: `npm run selftest`
Expected: aucun `FAIL`.

- [ ] **Step 3: Vérifier en vol**

Run: `npm run dev`, puis ouvrir la scène et vérifier, dans cet ordre :

1. **Crash** — piquer dans un bâtiment. Attendu : l'image se fige et se dégrade **avant** tout texte, le noir arrive vers 0,9 s, puis `LINK LOST`, `TARGET LOST`, `SESSION TERMINATED`, `[ESC] DISCONNECT`. `R` ne fait plus rien. Échap avant la fin de la séquence ne fait rien non plus.
2. **Pose** — se poser, gaz coupés, attendre. Attendu : `LANDING DETECTED` apparaît une fois le drone immobile ; `J` affiche `MOTORS DISARMED` puis `END SESSION`.
3. **Rasant** — passer à moins d'un mètre du sol à pleine vitesse, plusieurs fois. Attendu : `LANDING DETECTED` n'apparaît **jamais**. C'est le critère d'acceptation de l'issue #51.
4. `window.__sim.debug().flightEnd` rend la phase courante.

- [ ] **Step 4: Mettre `HANDOFF.md` à jour**

Ajouter dans la section vérifiée ce qui a été constaté en vol à l'étape 3, et dans la section non vérifiée ce qui ne l'a pas été. Ne pas y recopier la spec : `HANDOFF.md` ne porte que l'état vérifié / non vérifié.

- [ ] **Step 5: Commit et pousser**

```bash
git add package.json HANDOFF.md
git commit -m "Fin de session : harnais dans la chaîne de selftest, HANDOFF (PHASE 14)"
git push -u origin phase-14-fin-de-session
```

---

## Notes pour la revue

- Le point le plus facile à rater : `out.closes` doit être vu **exactement une fois** par `main.js`. S'il est lu ailleurs que dans la boucle qui appelle `update()`, il sera manqué ou vu deux fois, et la session se fermera deux fois côté serveur.
- Le second : `flightEnd.update()` est appelé une fois par **frame**, pas une fois par pas physique. Les durées de la timeline sont en temps réel.
- Le troisième : les seuils de la Tâche 3 sont des mesures. Un seuil changé à la main sans re-lancer `tools/landing-selftest.mjs --report` est un défaut de revue, pas un détail.
