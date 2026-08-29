# PHASE 08 — Target scan / choix de cible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Après l'acquisition du terrain, un écran `TARGET SCAN` où le joueur choisit un signal ; le signal choisi devient `session.target` (famille de drone + RSSI), pilote le modèle de vol et informe `src/link.js`.

**Architecture:** Modèle pur `tools/target-model.mjs` (PRNG seedé, sans dépendance) génère N signaux candidats depuis une graine. Le client affiche, récupère un index, connaît la famille tout de suite. `session.open()` n'envoie que `{ targetSeed, targetCount, targetIndex }` ; le serveur régénère à l'identique et stocke le descripteur résolu. Le vol lit `session.target` pour le profil (PHASE 07) et le RSSI (PHASE 08 `link.setSignal`).

**Tech Stack:** ES modules, Node ≥ 18 (test runner maison `check()`), Vite (bundle client), Rapier (physique, non touché ici).

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-08-target-scan-design.md`

## Global Constraints

- Interface, logs et textes du jeu : **anglais**. Issues, commits, docs internes : **français**.
- Aucun élément de DA ne devient dépendance du moteur physique. `npm run selftest` et `npm run selftest:operator` restent verts à chaque tâche.
- `tools/target-model.mjs` : **aucune dépendance** (`node:crypto` interdit — tourne dans le navigateur). PRNG = hash de string + `xorshift`, idiome de `src/link.js`.
- Ne **jamais** exposer `_family` (ni caméra / rates / batterie / état de vol) dans quoi que ce soit d'affiché avant le vol.
- Pas de hand-edit de PID. Le collider a déjà été retuné (`restitution 0.15 / friction 1.0`, commit `2eefd02`) — ne pas y retoucher.
- `SESSION_SCHEMA_VERSION` reste à `1` (le champ `target: null` existe déjà).
- Répertoire de travail des commandes : `sim/`.
- Baseline de départ (déjà verte sur la branche `phase-08-target-scan`) : `npm run selftest:operator`, `node tools/selftest.mjs public/scenes/tour-eiffel`, `npm run build`.

---

## File Structure

| Fichier | Rôle | Tâches |
|---|---|---|
| `sim/tools/target-model.mjs` | **créé** — logique pure : `generateTargetScan`, `describeTarget`, `resolveTarget`, `FAMILY_CLASS`, `TARGET_FAMILIES` | 1 |
| `sim/tools/target-selftest.mjs` | **créé** — selftest du modèle, chaîné dans `selftest:operator` | 1 |
| `sim/package.json` | **modifié** — ajoute `target-selftest` à `selftest:operator` | 1 |
| `sim/tools/session-model.mjs` | **modifié** — `sanitizeTarget`, `openSession`/`validateSession` acceptent `target` | 2 |
| `sim/tools/session-selftest.mjs` | **modifié** — cas `target` | 2 |
| `sim/tools/map-api-plugin.mjs` | **modifié** — `POST /:id/sessions` régénère et stocke la cible ; `POST /:id/terrain-cache` accepte `signalDensity` | 3, 6 |
| `sim/src/link.js` | **modifié** — `setSignal({ rssiDbm })` → `_baseLoss` additif | 4 |
| `sim/tools/selftest.mjs` | **modifié** — cas lien RSSI faible ; cas vol famille via cible | 4, 8 |
| `sim/src/scanner.js` | **modifié** — joint `signalDensity` au `keepTerrain` | 6 |
| `sim/src/operator.js` | **modifié** — `keepTerrain(slug, extra)` | 6 |
| `sim/src/terminal.js` | **modifié** — `export` sur `screen` et `button` | 5 |
| `sim/src/target-scan.js` | **créé** — l'écran `runTargetScan` | 5 |
| `sim/src/session.js` | **modifié** — `open({ …, target })` | 7 |
| `sim/src/main.js` | **modifié** — scan avant `boot()`, `PROFILE` différé, `link.setSignal` | 7, 8 |
| `sim/HANDOFF.md` | **modifié** — état PHASE 08 vérifié | 8 |

---

## Task 1: `tools/target-model.mjs` — le modèle pur

**Files:**
- Create: `sim/tools/target-model.mjs`
- Create: `sim/tools/target-selftest.mjs`
- Modify: `sim/package.json` (script `selftest:operator`)
- Reference: `sim/src/link.js:82-90` (idiome `xorshift`), `sim/src/drone-profiles.js` (`FAMILIES`), `sim/tools/scanner-selftest.mjs` (forme d'un selftest maison)

**Interfaces:**
- Produces:
  - `FAMILY_CLASS: Record<string,string>` — `{ freestyle5:'5"', race5:'5"', cinewhoop:'CINEWHOOP', longrange:'LONG RANGE', heavy5:'5"', toothpick:'MICRO' }`
  - `TARGET_FAMILIES: string[]` — `Object.keys(FAMILY_CLASS)`
  - `generateTargetScan({ seed: string, count?: number }) → { seed, count, candidates: Candidate[] }`
    - `Candidate = { id: string, rssiDbm: number, mode: 'ANALOG'|'DIGITAL'|'UNKNOWN', _family: string, _classHint: string, _videoHint: 'ANALOG'|'DIGITAL' }`
    - `count` par défaut `4`, clampé `[2, 5]` (`Math.round` puis clamp)
    - `candidates` triés `rssiDbm` décroissant, `id` = `'01'`, `'02'`, … dans cet ordre
  - `describeTarget(candidate) → { location:'KNOWN', signal:string, device:'PARTIAL', deviceHint:string, video:string, videoHint:(string|null), control:'UNKNOWN', flightState:'UNKNOWN' }`
    - `signal` = `` `${rssiDbm} dBm` ``
    - `video` = `candidate.mode === 'UNKNOWN' ? 'PARTIAL' : candidate.mode`
    - `videoHint` = `candidate.mode === 'UNKNOWN' ? candidate._videoHint : null`
    - **ne contient jamais `_family`**
  - `resolveTarget(scan, index) → { family, classHint, signal:{ rssiDbm, mode }, scannedAt:string, intel:{ location:'KNOWN', signal:'KNOWN', device:'PARTIAL', video:'EST.', control:'UNKNOWN', flightState:'UNKNOWN' } }`
    - `signal.mode` = `candidate._videoHint` (le vrai mode, pas `mode`)
    - throw `RangeError` si `index` hors `[0, scan.candidates.length[`

- [ ] **Step 1: Write the failing selftest**

Créer `sim/tools/target-selftest.mjs`. S'inspirer de `tools/scanner-selftest.mjs` pour le `check(name, cond, detail)` maison et le compteur final.

```js
import {
	generateTargetScan, describeTarget, resolveTarget,
	FAMILY_CLASS, TARGET_FAMILIES,
} from './target-model.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`); }
	else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- déterminisme
{
	const a = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	const b = generateTargetScan({ seed: 'kyiv-podil-9f2a', count: 4 });
	check('même graine → mêmes candidats', JSON.stringify(a) === JSON.stringify(b));
	const c = generateTargetScan({ seed: 'kyiv-podil-0000', count: 4 });
	check('graine différente → candidats différents', JSON.stringify(a) !== JSON.stringify(c));
}

// --- count clampé et tri
{
	check('count par défaut = 4', generateTargetScan({ seed: 'x' }).candidates.length === 4);
	check('count clampé bas', generateTargetScan({ seed: 'x', count: 0 }).candidates.length === 2);
	check('count clampé haut', generateTargetScan({ seed: 'x', count: 99 }).candidates.length === 5);
	const s = generateTargetScan({ seed: 'sorted-check', count: 5 });
	const sorted = s.candidates.every((c, i) => i === 0 || s.candidates[i - 1].rssiDbm >= c.rssiDbm);
	check('candidats triés RSSI décroissant', sorted);
	check('ids séquentiels', s.candidates.map((c) => c.id).join(',') === '01,02,03,04,05');
	check('rssi dans une plage plausible',
		s.candidates.every((c) => c.rssiDbm <= -45 && c.rssiDbm >= -80));
}

// --- describeTarget ne fuit jamais la famille
{
	for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
		const scan = generateTargetScan({ seed, count: 5 });
		for (const cand of scan.candidates) {
			const sheet = JSON.stringify(describeTarget(cand));
			check(`describeTarget(${seed}/${cand.id}) sans _family`,
				!sheet.includes(cand._family), sheet.includes(cand._family) ? sheet : '');
			check(`describeTarget(${seed}/${cand.id}) video cohérent`,
				(cand.mode === 'UNKNOWN' && JSON.parse(sheet).video === 'PARTIAL')
				|| (cand.mode !== 'UNKNOWN' && JSON.parse(sheet).video === cand.mode));
		}
	}
}

// --- resolveTarget
{
	const scan = generateTargetScan({ seed: 'resolve', count: 4 });
	const t = resolveTarget(scan, 1);
	check('resolveTarget : famille connue', TARGET_FAMILIES.includes(t.family));
	check('resolveTarget : mode réel', ['ANALOG', 'DIGITAL'].includes(t.signal.mode));
	check('resolveTarget : rssi repris', t.signal.rssiDbm === scan.candidates[1].rssiDbm);
	check('resolveTarget : intel figé', t.intel.control === 'UNKNOWN' && t.intel.location === 'KNOWN');
	let threw = false;
	try { resolveTarget(scan, 9); } catch { threw = true; }
	check('resolveTarget : index hors borne → throw', threw);
}

// --- garde-fou de dérive
check('FAMILY_CLASS couvre exactement FAMILIES',
	TARGET_FAMILIES.slice().sort().join(',') === FAMILIES.slice().sort().join(','),
	`${TARGET_FAMILIES.join(' ')} vs ${FAMILIES.join(' ')}`);

console.log(`\n${pass} tests target OK${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node tools/target-selftest.mjs`
Expected: FAIL — `Cannot find module './target-model.mjs'`

- [ ] **Step 3: Write `tools/target-model.mjs`**

```js
// Signaux candidats d'un TARGET SCAN (PHASE 08). Logique pure, AUCUNE
// dépendance : importée par le plugin de dev, le selftest et (via un bundle
// Vite) le client. Le serveur régénère la même sortie depuis la même graine,
// c'est ce qui rend le choix du joueur non falsifiable.
//
//   terrain persistent, flights ephemeral — une cible appartient à une session.

// FAMILY_CLASS : donnée stable, dupliquée ici pour garder le modèle sans
// dépendance. Le selftest vérifie que ses clés collent à src/drone-profiles.js.
// La valeur est le bucket grossier montré en EST. avant le hack — jamais la
// famille exacte.
export const FAMILY_CLASS = {
	freestyle5: '5"',
	race5: '5"',
	cinewhoop: 'CINEWHOOP',
	longrange: 'LONG RANGE',
	heavy5: '5"',
	toothpick: 'MICRO',
};
export const TARGET_FAMILIES = Object.keys(FAMILY_CLASS);

const MODES = ['ANALOG', 'DIGITAL'];
const clampCount = (n) => {
	const r = Math.round(Number.isFinite(n) ? n : 4);
	return r < 2 ? 2 : r > 5 ? 5 : r;
};

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même géné que
// src/link.js : petit, déterministe, rejouable).
function rngFrom(seed) {
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

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

export function generateTargetScan({ seed, count } = {}) {
	if (!seed) throw new Error('seed requis');
	const n = clampCount(count);
	const rand = rngFrom(`${seed}::scan`);

	const raw = [];
	for (let i = 0; i < n; i++) {
		const family = pick(rand, TARGET_FAMILIES);
		const videoHint = pick(rand, MODES);
		// -52..-72 dBm : un signal exploitable, jamais parfait (§6). Le tri se
		// fait après, l'ordre de génération n'a pas d'importance.
		const rssiDbm = -52 - Math.round(rand() * 20);
		// ~50 % des signaux révèlent leur mode, le reste reste UNKNOWN.
		const mode = rand() < 0.5 ? videoHint : 'UNKNOWN';
		raw.push({ rssiDbm, mode, _family: family, _classHint: FAMILY_CLASS[family], _videoHint: videoHint });
	}
	raw.sort((a, b) => b.rssiDbm - a.rssiDbm);
	const candidates = raw.map((c, i) => ({ id: String(i + 1).padStart(2, '0'), ...c }));

	return { seed, count: n, candidates };
}

// Fiche pré-hack (Bible §15/§22). NE CONTIENT JAMAIS _family : on n'affiche que
// ce qui est réellement connu avant le vol.
export function describeTarget(candidate) {
	const known = candidate.mode !== 'UNKNOWN';
	return {
		location: 'KNOWN',
		signal: `${candidate.rssiDbm} dBm`,
		device: 'PARTIAL',
		deviceHint: candidate._classHint,   // EST. — le bucket, pas la famille
		video: known ? candidate.mode : 'PARTIAL',
		videoHint: known ? null : candidate._videoHint,
		control: 'UNKNOWN',
		flightState: 'UNKNOWN',
	};
}

// Descripteur persisté sur la session. Le serveur l'obtient en régénérant le
// scan puis en appelant ceci — le client n'envoie qu'un index.
export function resolveTarget(scan, index) {
	const c = scan.candidates[index];
	if (!c) throw new RangeError(`index de cible hors borne : ${index}`);
	return {
		family: c._family,
		classHint: c._classHint,
		signal: { rssiDbm: c.rssiDbm, mode: c._videoHint },
		scannedAt: new Date().toISOString(),
		intel: {
			location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL',
			video: 'EST.', control: 'UNKNOWN', flightState: 'UNKNOWN',
		},
	};
}
```

- [ ] **Step 4: Run the selftest, verify it passes**

Run: `node tools/target-selftest.mjs`
Expected: PASS — `N tests target OK` (aucun FAIL). Si `FAMILY_CLASS couvre exactement FAMILIES` échoue, aligner `FAMILY_CLASS` sur `FAMILIES` de `src/drone-profiles.js` (ne pas inventer de famille).

- [ ] **Step 5: Chaîner dans `selftest:operator`**

Dans `sim/package.json`, script `selftest:operator`, ajouter `&& node tools/target-selftest.mjs` juste après `node tools/session-selftest.mjs`.

Run: `npm run selftest:operator`
Expected: toutes les suites passent, la nouvelle incluse.

- [ ] **Step 6: Commit**

```bash
git add sim/tools/target-model.mjs sim/tools/target-selftest.mjs sim/package.json
git commit -m "PHASE 08 — target-model : génération pure des signaux candidats"
```

---

## Task 2: `session-model.mjs` — la session porte une cible

**Files:**
- Modify: `sim/tools/session-model.mjs` (`sanitizeTarget` nouveau ; `openSession`, `validateSession`)
- Modify: `sim/tools/session-selftest.mjs` (cas `target`)
- Reference: `sim/tools/session-model.mjs:45-82` (`sanitizeWeatherSnapshot`, `openSession`), `:122-136` (`validateSession`)

**Interfaces:**
- Consumes: `TARGET_FAMILIES` de `tools/target-model.mjs`
- Produces:
  - `sanitizeTarget(raw) → object | null` — `null` si `raw == null` ; sinon objet validé de forme `{ family, classHint, signal:{ rssiDbm, mode }, scannedAt, intel }` ; `throw new Error(...)` si malformé
  - `openSession({ operatorId, area, weatherSnapshot, target })` — `target` optionnel, stocké via `sanitizeTarget(target) ?? null` (remplace le `target: null` figé actuel ligne ~71)
  - `validateSession(s)` — si `s.target != null`, appelle `sanitizeTarget(s.target)` (throw si malformé)

- [ ] **Step 1: Write the failing tests**

Dans `sim/tools/session-selftest.mjs`, ajouter (adapter au style `check` du fichier) :

```js
import { TARGET_FAMILIES } from './target-model.mjs';

const goodTarget = {
	family: TARGET_FAMILIES[0],
	classHint: '5"',
	signal: { rssiDbm: -59, mode: 'ANALOG' },
	scannedAt: new Date().toISOString(),
	intel: { location: 'KNOWN', signal: 'KNOWN', device: 'PARTIAL', video: 'EST.', control: 'UNKNOWN', flightState: 'UNKNOWN' },
};

{
	const s = openSession({ operatorId: 'op-1', area: 'kyiv-podil', weatherSnapshot: null, target: goodTarget });
	check('openSession stocke la cible validée', s.target && s.target.family === goodTarget.family);
	check('validateSession accepte une session avec cible', validateSession(s) === s);
	const resumed = resumeSession(closeSessionForResume(s)); // helper existant si présent, sinon voir Note
	check('resumeSession conserve la cible', resumed.target && resumed.target.family === goodTarget.family);
}

{
	const s = openSession({ operatorId: 'op-1', area: 'kyiv-podil', weatherSnapshot: null });
	check('openSession sans cible → target null', s.target === null);
}

{
	let threw = false;
	try { openSession({ operatorId: 'op-1', area: 'kyiv-podil', weatherSnapshot: null, target: { family: 'not-a-family', signal: { rssiDbm: -59, mode: 'ANALOG' }, intel: {} } }); }
	catch { threw = true; }
	check('openSession rejette une famille inconnue', threw);

	let threw2 = false;
	const bad = { ...openSession({ operatorId: 'op-1', area: 'kyiv-podil', weatherSnapshot: null }) , target: { family: TARGET_FAMILIES[0], signal: { rssiDbm: 5, mode: 'ANALOG' }, intel: {} } };
	try { validateSession(bad); } catch { threw2 = true; }
	check('validateSession rejette un rssi positif', threw2);
}
```

> **Note :** pour le cas `resumeSession`, `resumeSession` exige `result === 'LANDED'`. Construire l'entrée en clôturant d'abord : `const landed = closeSession(s, { result: 'LANDED', telemetry: freshTelemetry() });` puis `resumeSession(landed)`. Utiliser les exports réels du fichier (`closeSession`, `freshTelemetry`).

- [ ] **Step 2: Run, verify failure**

Run: `node tools/session-selftest.mjs`
Expected: FAIL — `openSession` ignore `target` / renvoie `null`, la famille inconnue n'est pas rejetée.

- [ ] **Step 3: Implement `sanitizeTarget` + câblage**

Dans `sim/tools/session-model.mjs` :

```js
import { TARGET_FAMILIES } from './target-model.mjs';

// Ne garde que la forme connue du descripteur de cible (PHASE 08). `null` est
// licite : une session peut s'ouvrir sans cible (chemin dev ?scene=).
export function sanitizeTarget(raw) {
	if (raw == null) return null;
	if (typeof raw !== 'object') throw new Error('target invalide');
	if (!TARGET_FAMILIES.includes(raw.family)) throw new Error(`famille de cible inconnue : ${raw.family}`);
	const sig = raw.signal;
	if (!sig || typeof sig !== 'object') throw new Error('target.signal manquant');
	if (!Number.isFinite(sig.rssiDbm) || sig.rssiDbm >= 0) throw new Error('target.signal.rssiDbm invalide');
	if (sig.mode !== 'ANALOG' && sig.mode !== 'DIGITAL') throw new Error('target.signal.mode invalide');
	if (!raw.intel || typeof raw.intel !== 'object') throw new Error('target.intel manquant');
	return {
		family: raw.family,
		classHint: raw.classHint ?? null,
		signal: { rssiDbm: sig.rssiDbm, mode: sig.mode },
		scannedAt: raw.scannedAt ?? null,
		intel: { ...raw.intel },
	};
}
```

Dans `openSession(...)`, remplacer la ligne `target: null,` par `target: sanitizeTarget(target),` et ajouter `target` à la déstructuration de l'argument (`{ operatorId, area, weatherSnapshot, target }`).

Dans `validateSession(s)`, après le contrôle `sanitizeWeatherSnapshot`, ajouter :
```js
if (s.target != null) sanitizeTarget(s.target); // throw si malformé
```

- [ ] **Step 4: Run, verify pass**

Run: `node tools/session-selftest.mjs && npm run selftest:operator`
Expected: PASS partout.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/session-model.mjs sim/tools/session-selftest.mjs
git commit -m "PHASE 08 — session-model : la session porte une cible validée"
```

---

## Task 3: `map-api-plugin.mjs` — le serveur régénère et stocke la cible

**Files:**
- Modify: `sim/tools/map-api-plugin.mjs` — imports + route `POST /^\/([^/]+)\/sessions$/`
- Reference: `sim/tools/map-api-plugin.mjs:203-227` (la route `POST .../sessions` actuelle), `sim/tools/session-selftest.mjs` (pas de test réseau ici — la route est couverte par un test d'intégration léger optionnel, sinon vérif manuelle)

**Interfaces:**
- Consumes: `generateTargetScan`, `resolveTarget` de `./target-model.mjs` ; `sanitizeTarget` de `./session-model.mjs` (déjà importé — ajouter à la liste)
- Produces: `POST /__operator/:id/sessions` avec body `{ area, weatherSnapshot, targetSeed?, targetCount?, targetIndex? }` → `201 { session }` où `session.target` est le descripteur résolu (ou `null` si `targetSeed` absent). Body `{ resume }` inchangé.

- [ ] **Step 1: Write the failing test**

Créer `sim/tools/session-route-selftest.mjs` (petit, style maison) qui monte la logique sans serveur HTTP en appelant directement la fonction de route si elle est exportable ; sinon, tester la composition `generateTargetScan` → `resolveTarget` → `openSession` → `validateSession` :

```js
import { generateTargetScan, resolveTarget } from './target-model.mjs';
import { openSession, validateSession } from './session-model.mjs';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const scan = generateTargetScan({ seed: 'route-seed', count: 4 });
const target = resolveTarget(scan, 2);
const s = validateSession(openSession({ operatorId: 'op-x', area: 'kyiv', weatherSnapshot: null, target }));
check('la session serveur porte la cible régénérée', s.target.family === scan.candidates[2]._family);

// régénération identique
const again = resolveTarget(generateTargetScan({ seed: 'route-seed', count: 4 }), 2);
check('régénération déterministe', again.family === target.family && again.signal.rssiDbm === target.signal.rssiDbm);

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
```

Ajouter `&& node tools/session-route-selftest.mjs` à `selftest:operator` après `target-selftest`.

- [ ] **Step 2: Run, verify pass** (ce test passe déjà après Task 1+2 — il verrouille le contrat que la route doit respecter)

Run: `node tools/session-route-selftest.mjs`
Expected: PASS.

- [ ] **Step 3: Modifier la route**

Dans `sim/tools/map-api-plugin.mjs` :

Imports — ajouter à la liste depuis `./session-model.mjs` : `sanitizeTarget`. Nouvelle ligne :
```js
import { generateTargetScan, resolveTarget } from './target-model.mjs';
```

Dans la route `['POST', /^\/([^/]+)\/sessions$/, async (req, res, [id]) => {`, branche `else` (celle qui fait `openSession({...})` aujourd'hui), remplacer par :

```js
} else {
	let target = null;
	if (b.targetSeed) {
		const scan = generateTargetScan({ seed: String(b.targetSeed), count: b.targetCount });
		if (!Number.isInteger(b.targetIndex) || b.targetIndex < 0 || b.targetIndex >= scan.candidates.length) {
			return json(res, 400, { error: `targetIndex hors borne : ${b.targetIndex}` });
		}
		target = resolveTarget(scan, b.targetIndex);
	} else {
		console.warn('[session] ouverture sans TARGET SCAN — aucune cible (chemin dev)');
	}
	session = validateSession(openSession({
		operatorId: state.id,
		area: b.area,
		weatherSnapshot: sanitizeWeatherSnapshot(b.weatherSnapshot ?? null),
		target,
	}));
	state.sessions.push(session);
}
```

(La branche `if (b.resume)` reste strictement inchangée.)

- [ ] **Step 4: Vérif manuelle rapide**

Run:
```bash
node -e "
import('./tools/map-api-plugin.mjs').then(() => console.log('module charge sans erreur de syntaxe'));
"
```
Puis `npm run selftest:operator` (les suites pures) + `npm run build`.
Expected: pas d'erreur d'import, suites vertes, build OK.

- [ ] **Step 5: Commit**

```bash
git add sim/tools/map-api-plugin.mjs sim/tools/session-route-selftest.mjs sim/package.json
git commit -m "PHASE 08 — route sessions : régénère la cible par graine côté serveur"
```

---

## Task 4: `link.js` — le RSSI annoncé informe le lien

**Files:**
- Modify: `sim/src/link.js` — `VideoLink` : champ `_baseLoss`, méthode `setSignal`, terme dans `update()`
- Modify: `sim/tools/selftest.mjs` — un cas dans le bloc `link` (autour de la ligne 240-330)
- Reference: `sim/src/link.js:92-155` (`VideoLink`), `sim/tools/selftest.mjs:242-266` (helper `settle`)

**Interfaces:**
- Produces: `VideoLink.prototype.setSignal({ rssiDbm })` — `rssiDbm` fini → `this._baseLoss = Math.max(0, RSSI_REF_DBM - rssiDbm)` ; sinon `this._baseLoss = 0`. Terme ajouté à `target` dans `update()`.

- [ ] **Step 1: Write the failing test**

Dans `sim/tools/selftest.mjs`, bloc `link`, après les cas `settle` existants, ajouter :

```js
// PHASE 08 : le RSSI annoncé de la cible décale le budget. À distance et
// obstruction égales, un signal faible arrive avec moins de marge.
{
	const strong = new VideoLink(1);
	strong.setSignal({ rssiDbm: -54 });
	const weak = new VideoLink(1);
	weak.setSignal({ rssiDbm: -72 });
	let qs = 1, qw = 1;
	for (let i = 0; i < 600; i++) {
		qs = strong.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
		qw = weak.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
	}
	check('un signal faible dégrade le lien à distance égale', qw < qs - 0.05, `fort ${qs.toFixed(2)} vs faible ${qw.toFixed(2)}`);

	const none = new VideoLink(1);
	none.setSignal({});
	let q0 = 1;
	for (let i = 0; i < 600; i++) q0 = none.update({ distance: 120, blocked: false, span: 0, dt: 1 / 60 }).quality;
	check('setSignal({}) laisse le lien inchangé', Math.abs(q0 - qs) < 1e-9);
}
```

(Vérifier que `VideoLink` est bien importé en tête de `selftest.mjs` — sinon l'ajouter : `import { VideoLink } from '../src/link.js';`.)

- [ ] **Step 2: Run, verify failure**

Run: `node tools/selftest.mjs public/scenes/tour-eiffel`
Expected: FAIL — `weak.setSignal is not a function`.

- [ ] **Step 3: Implement**

Dans `sim/src/link.js`, classe `VideoLink` :

Constructeur — après `this.severity = 1;`, ajouter :
```js
// Décalage de perte dû au RSSI annoncé de la cible (PHASE 08). Le RSSI
// annoncé = niveau de lien propre de cette cible à D0 : un émetteur ou une
// antenne plus faibles démarrent le budget avec moins de marge. Additif en
// dB, comme spread et shadow. NON remis à zéro par reset() : c'est une
// propriété de la cible, elle survit à un respawn dans la session.
this._baseLoss = 0;
```

Nouvelle méthode (à côté de `setSeverity`) :
```js
setSignal({ rssiDbm } = {}) {
	this._baseLoss = Number.isFinite(rssiDbm) ? Math.max(0, RSSI_REF_DBM - rssiDbm) : 0;
}
```

Dans `update(...)`, ligne `const target = (spread + shadow) * this.severity;` → 
```js
const target = (spread + shadow + this._baseLoss) * this.severity;
```

Ne PAS toucher `reset()`.

- [ ] **Step 4: Run, verify pass**

Run: `node tools/selftest.mjs public/scenes/tour-eiffel`
Expected: `all checks passed` (les nouveaux cas inclus).

- [ ] **Step 5: Commit**

```bash
git add sim/src/link.js sim/tools/selftest.mjs
git commit -m "PHASE 08 — link : le RSSI annoncé de la cible décale le budget"
```

---

## Task 5: `src/target-scan.js` — l'écran

**Files:**
- Modify: `sim/src/terminal.js` — `export` sur `screen` et `button` (lignes ~12 et ~20)
- Create: `sim/src/target-scan.js`
- Reference: `sim/src/terminal.js:12-28` (`screen`, `button`), `sim/src/terminal.js:239-253` (`operatorSelect` — modèle d'écran de choix qui résout une Promise)

**Interfaces:**
- Consumes: `screen`, `button` de `./terminal.js` ; `generateTargetScan`, `describeTarget` de `../tools/target-model.mjs`
- Produces: `runTargetScan(root, { seed, count }) → Promise<{ seed, count, index }>`

- [ ] **Step 1: Exporter les helpers terminal**

Dans `sim/src/terminal.js` : préfixer `function screen(` → `export function screen(` et `function button(` → `export function button(`. Rien d'autre. (`navRow` reste privé.)

Run: `npm run build`
Expected: build OK (aucun consommateur cassé).

- [ ] **Step 2: Write the screen**

Pas de test unitaire DOM ici (pas d'infra jsdom dans le repo) — la vérif est le run navigateur en Task 8. Créer `sim/src/target-scan.js` :

```js
// TARGET SCAN (PHASE 08, Bible §15). Interaction courte : une liste de signaux,
// le joueur en choisit un. On n'affiche QUE ce qui est réellement connu avant
// le vol — jamais la famille, la caméra, les rates, la batterie.
//
// Écran client pur : rendu avec le look terminal (screen/button de terminal.js),
// aucune dépendance Three/Rapier. La génération vient de tools/target-model.mjs,
// bundlée par Vite.
import { screen, button } from './terminal.js';
import { generateTargetScan, describeTarget } from '../tools/target-model.mjs';

export function runTargetScan(root, { seed, count }) {
	const scan = generateTargetScan({ seed, count });
	return new Promise((resolve) => {
		let cursor = 0;

		const list = () => scan.candidates.map((c, i) => {
			const mark = i === cursor ? '>' : ' ';
			return `${mark} ${c.id}   ${String(c.rssiDbm).padStart(4)} dBm   ${c.mode}`;
		}).join('\n');

		const s = screen(root);
		const draw = () => {
			s.box.innerHTML = `<pre>TARGET SCAN

SIGNALS DETECTED

${list()}</pre>`;
			s.box.appendChild(button('SELECT', () => sheet(cursor), 'terminal-cta'));
		};

		const onKey = (e) => {
			if (e.key === 'ArrowDown') { cursor = (cursor + 1) % scan.candidates.length; draw(); }
			else if (e.key === 'ArrowUp') { cursor = (cursor - 1 + scan.candidates.length) % scan.candidates.length; draw(); }
			else if (e.key === 'Enter') { sheet(cursor); }
		};
		window.addEventListener('keydown', onKey);

		const finish = (index) => {
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve({ seed: scan.seed, count: scan.count, index });
		};

		const sheet = (index) => {
			const d = describeTarget(scan.candidates[index]);
			const s2 = screen(root);
			s2.box.innerHTML = `<pre>TARGET ${scan.candidates[index].id}

LOCATION       ${d.location}
SIGNAL         ${d.signal}
DEVICE         ${d.device}${d.deviceHint ? `  (EST. ${d.deviceHint})` : ''}
VIDEO          ${d.video}${d.videoHint ? `  (EST. ${d.videoHint})` : ''}
CONTROL        ${d.control}
FLIGHT STATE   ${d.flightState}</pre>`;
			s2.box.appendChild(button('CONFIRM', () => { s2.remove(); finish(index); }, 'terminal-cta'));
			s2.box.appendChild(button('BACK', () => { s2.remove(); draw(); }, 'terminal-cta'));
		};

		draw();
	});
}
```

> Vérifier la forme de retour de `screen(root)` dans `terminal.js` : le code ci-dessus suppose `{ box, remove() }`. Si l'API réelle diffère (p. ex. `s.el`, `s.close()`), adapter les trois usages. Idem `button(label, onClick, cls)` : confirmer l'ordre des arguments et la classe CSS d'un CTA (`'terminal-cta'` est utilisée ailleurs dans `terminal.js`).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: OK — `target-scan.js` compile (il n'est pas encore importé, l'ajouter à un import temporaire dans `main.js` OU laisser Task 7 le câbler ; pour vérifier isolément : `node --check` ne suffit pas pour les imports, se fier au build de Task 7). Au minimum : `node -e "import('./src/target-scan.js').catch(e=>{if(!/document|window|three/i.test(String(e)))throw e})"` pour attraper une faute de frappe d'import.

- [ ] **Step 4: Commit**

```bash
git add sim/src/terminal.js sim/src/target-scan.js
git commit -m "PHASE 08 — écran TARGET SCAN (liste de signaux + fiche pré-hack)"
```

---

## Task 6: Persistance de la densité de signal à l'acquisition

**Files:**
- Modify: `sim/src/operator.js` — `keepTerrain(slug, extra)`
- Modify: `sim/src/scanner.js` — l'appel `operatorApi.keepTerrain(d.slug)` (~ligne 701) passe la densité
- Modify: `sim/tools/map-api-plugin.mjs` — route `POST /^\/([^/]+)\/terrain-cache$/` accepte `signalDensity`
- Reference: `sim/src/operator.js:91-95` (`keepTerrain`), `sim/tools/map-api-plugin.mjs:182-199`, `sim/src/scanner.js:347` (`signalDensity({ place: state.place, areaKm2 })`), `sim/src/scanner.js:693-731` (`acquired`)

**Interfaces:**
- Consumes: `signalDensity(...)` déjà calculé dans `scanner.js` (`state` porte `place` et l'aire)
- Produces:
  - `operator.keepTerrain(slug, extra?)` — `extra` optionnel `{ signalDensity: { level:number, range:[number,number] } }`, transmis dans le body POST
  - entrée `terrainCache` avec un champ optionnel `signalDensity: { level, range } | undefined`

> **Écart assumé au principe « slug only » de la route** (`map-api-plugin.mjs:180`) : la densité dépend de `state.place` (réponse Nominatim runtime) et de l'aire dessinée — le serveur n'a pas de quoi la recalculer depuis `scenes.json`. C'est une **estimation d'écran**, pas une donnée de terrain autoritative (le nom, les coordonnées, le poids continuent de venir de `scenes.json`). Le stockage se contente d'une validation de forme.

- [ ] **Step 1: Étendre `operator.keepTerrain`**

```js
export async function keepTerrain(slug, extra = {}) {
	if (!cache) throw new Error('aucun opérateur chargé');
	const body = { slug, ...extra };
	cache = (await req('POST', `/${cache.id}/terrain-cache`, body)).operator;
	return cache;
}
```

- [ ] **Step 2: Route serveur — valider et stocker la densité**

Dans `sim/tools/map-api-plugin.mjs`, route `terrain-cache`, avant de pousser `entry` :

```js
// Estimation d'écran (densité de signal du Global Scanner), pas une donnée de
// terrain autoritative — on ne fait que contrôler la forme.
const d = b.signalDensity;
if (d && typeof d === 'object'
	&& Number.isFinite(d.level)
	&& Array.isArray(d.range) && d.range.length === 2 && d.range.every(Number.isFinite)) {
	entry.signalDensity = { level: d.level, range: [d.range[0], d.range[1]] };
}
```

- [ ] **Step 3: Scanner — passer la densité au moment du KEEP**

Dans `sim/src/scanner.js`, `acquired(d)`, le handler `panel.querySelector('.sc-keep').onclick` : remplacer `await operatorApi.keepTerrain(d.slug);` par :

```js
const dens = state.place != null
	? signalDensity({ place: state.place, areaKm2: state.areaKm2 ?? areaKm2Of(state) })
	: null;
await operatorApi.keepTerrain(d.slug,
	dens && dens.known ? { signalDensity: { level: dens.level, range: dens.range } } : {});
```

> Identifier comment l'aire en km² est disponible dans ce scope (`state` porte la géométrie du rectangle ; `signalDensity` est déjà appelé ligne ~347 avec un `areaKm2` local — réutiliser la même source, extraire un helper si besoin). Si l'aire n'est pas accessible proprement dans `acquired()`, mémoriser le dernier `signalDensity` calculé dans `renderDensity()` sur `state.lastDensity` et le lire ici.

- [ ] **Step 4: Vérif**

Run: `npm run selftest:operator && npm run build`
Expected: verts. (Le chemin est vérifié en direct en Task 8.)

- [ ] **Step 5: Commit**

```bash
git add sim/src/operator.js sim/src/scanner.js sim/tools/map-api-plugin.mjs
git commit -m "PHASE 08 — persiste la densité de signal du scanner sur le terrain acquis"
```

---

## Task 7: `session.js` + `main.js` — câblage du scan au vol

**Files:**
- Modify: `sim/src/session.js` — `open({ …, target })`
- Modify: `sim/src/main.js` — `chooseScene()` (scan + famille), le `.then` gate (`PROFILE` différé, `controller` en `let`), `openFlightSession` (`session.open` avec cible, `link.setSignal`)
- Reference: `sim/src/main.js:53-72` (`OPTS`, `PROFILE`, `controller`), `:759-800` (`chooseScene`, le `.then` gate), `:802-820` (`openFlightSession`), `sim/src/session.js:35-40` (`open`)

**Interfaces:**
- Consumes: `runTargetScan` de `./target-scan.js` ; `generateTargetScan` de `../tools/target-model.mjs` ; `PROFILES` de `./drone-profiles.js` ; `operator.getOperator()`
- Produces:
  - `session.open({ area, weatherSnapshot, resume, target })` où `target = { seed, count, index } | undefined`
  - body POST : `resume ? { resume } : { area, weatherSnapshot, targetSeed, targetCount, targetIndex }`

- [ ] **Step 1: `session.js` — passer la cible**

Dans `sim/src/session.js`, `open` :

```js
export async function open({ area, weatherSnapshot, resume, target } = {}) {
	const body = resume
		? { resume }
		: { area, weatherSnapshot, targetSeed: target?.seed, targetCount: target?.count, targetIndex: target?.index };
	const session = await operator.postSession(body);
	live = { id: session.id, session, tel: zeroTel(), closed: false };
	return session;
}
```

Étendre le cas existant du selftest `open({ resume }) envoie { resume } et rien d'autre` avec un cas `open({ area, target }) envoie targetSeed/targetCount/targetIndex`. (`sim/tools/session-selftest.mjs` — un `postSession` mock capture le body.)

Run: `node tools/session-selftest.mjs`
Expected: PASS.

- [ ] **Step 2: `main.js` — `controller` en `let`, `PROFILE` résolu tardivement**

Ligne ~63 : `const PROFILE = OPTS.family ? PROFILES[OPTS.family] : undefined;` → `let PROFILE = OPTS.family ? PROFILES[OPTS.family] : undefined;`

Ligne ~79 : `const controller = new FlightController(PROFILE ? { profile: PROFILE } : undefined);` → 
```js
let controller;
```
(La construction se fait dans le gate, Step 4.) Vérifier qu'aucune ligne AVANT le gate n'utilise `controller` à l'exécution (les définitions de fonctions de la boucle d'animation sont OK, elles ne s'exécutent pas encore).

- [ ] **Step 3: `main.js` — le scan dans `chooseScene()`**

`chooseScene()` renvoie aujourd'hui `{ slug, resume }`. Le faire renvoyer `{ slug, resume, target, family }` :

```js
import { runTargetScan } from './target-scan.js';
import { generateTargetScan } from '../tools/target-model.mjs';

// … dans chooseScene(), chemin ?scene= (dev) :
if (OPTS.scene) {
	await operator.ensureDevOperator();
	const scenes = await loadSceneList();
	if (!scenes.some((s) => s.slug === OPTS.scene)) throw new Error(`carte inconnue: "${OPTS.scene}"`);
	return { slug: OPTS.scene, resume: OPTS.resume || undefined, target: undefined,
		family: OPTS.family || undefined };
}

// … après `const flyChoice = await runTerminal(ui, { settings });`
// (runTerminal résout aujourd'hui { slug, resume } — adapter à sa forme réelle)
const { slug, resume } = flyChoice;

if (resume) {
	// terrain persistent, flights ephemeral : une session LANDED rejoue SA cible.
	const prev = operator.getOperator()?.sessions?.find((s) => s.id === resume);
	return { slug, resume, target: undefined, family: prev?.target?.family ?? OPTS.family ?? undefined };
}

// Session fraîche → TARGET SCAN.
const seed = Math.random().toString(16).slice(2, 12);
const count = signalCountFor(slug);           // voir Step 5
const scan = generateTargetScan({ seed, count });
const choice = await runTargetScan(ui, { seed, count });   // { seed, count, index }
const family = scan.candidates[choice.index]._family;
return { slug, resume: undefined, target: choice, family };
```

> Adapter à la forme réelle que `runTerminal` résout (aujourd'hui `{ slug, resume }` d'après `terminal.js` après le merge PHASE 06 ; confirmer). `OPTS.family` reste un override dev qui court-circuite le scan : si `OPTS.family` est défini et qu'on n'est pas en `resume`, sauter `runTargetScan` et renvoyer `{ slug, target: undefined, family: OPTS.family }`.

- [ ] **Step 4: `main.js` — le gate résout `PROFILE` et construit `controller`**

```js
chooseScene()
	.then(({ slug, resume, target, family }) => {
		audio.start();
		hud.show();
		flyArea = slug;
		resumeId = resume || null;
		flyTarget = target || null;                      // nouveau module-level `let`
		PROFILE = family ? PROFILES[family] : PROFILE;    // garde l'override ?family= si family absent
		controller = new FlightController(PROFILE ? { profile: PROFILE } : undefined);
		if (PROFILE) console.log(`[target] family ${PROFILE.family} — ${PROFILE.label}`);
		setScene(slug);
		return boot();
	})
	.then(openFlightSession)
	.catch((err) => { console.error(err); hud.fail(err.message); });
```

`boot()` construit déjà `physics = new Physics(collision, manifest.spawn, PROFILE ? { profile: PROFILE } : {})` (PHASE 07) — vérifier que la variable lue est bien ce `PROFILE` module-level désormais résolu avant `boot()`.

- [ ] **Step 5: `main.js` — `signalCountFor(slug)` depuis la densité persistée**

```js
// Nombre de signaux du TARGET SCAN, cohérent avec la densité affichée par le
// Global Scanner (PHASE 03/05). Le terrain acquis porte { level, range } ;
// milieu de fourchette, clampé [2,5]. Terrain sans densité (cache ancien,
// terrain local) → 4.
function signalCountFor(slug) {
	const t = operator.getOperator()?.terrainCache?.find((e) => e.slug === slug);
	const r = t?.signalDensity?.range;
	if (!Array.isArray(r) || r.length !== 2) return 4;
	const mid = Math.round((r[0] + r[1]) / 2);
	return mid < 2 ? 2 : mid > 5 ? 5 : mid;
}
```

- [ ] **Step 6: `main.js` — `openFlightSession` ouvre avec la cible et arme le lien**

```js
async function openFlightSession() {
	spawnY = physics.position.y;
	try {
		await session.open({
			area: flyArea,
			weatherSnapshot: session.snapshotWeather(weather),
			resume: resumeId || OPTS.resume || undefined,
			target: flyTarget || undefined,
		});
		const tgt = session.current()?.target;
		if (tgt?.signal) {
			link.setSignal({ rssiDbm: tgt.signal.rssiDbm });
			console.log(`[link] target signal ${tgt.signal.rssiDbm} dBm (${tgt.signal.mode})`);
		}
	} catch (e) {
		console.warn('[session] ouverture échouée, ce vol ne sera pas enregistré', e);
	}
}
```

> `resume` : `session.current().target` vient du disque (serveur) → `link.setSignal` marche pareil. Le `PROFILE` du `resume` a été résolu en Step 3 via `operator.getOperator().sessions`.

- [ ] **Step 7: Build + check syntaxe**

Run: `npm run build`
Expected: OK, `target-scan.js` et `target-model.mjs` bundlés dans le chunk principal.

- [ ] **Step 8: Commit**

```bash
git add sim/src/session.js sim/src/main.js sim/tools/session-selftest.mjs
git commit -m "PHASE 08 — câble TARGET SCAN au vol : cible de session, profil, lien"
```

---

## Task 8: Vérification bout-en-bout + HANDOFF

**Files:**
- Modify: `sim/tools/selftest.mjs` — un cas « une famille cible vole »
- Modify: `sim/HANDOFF.md` — entrée PHASE 08 vérifiée
- Reference: `sim/tools/selftest.mjs:114-135` (boucle familles), la note HANDOFF PHASE 08 déjà présente (à compléter)

- [ ] **Step 1: Cas selftest — le profil arrive bien par la cible**

Le vol par famille est déjà couvert (`?family=` / `useFamily`). Ajouter un cas d'intégration pur qui vérifie que `resolveTarget().family` est une clé valide de `PROFILES` :

```js
// PHASE 08 : la cible résolue désigne toujours un profil de vol réel.
import { PROFILES } from '../src/drone-profiles.js';
import { generateTargetScan, resolveTarget } from './target-model.mjs';
{
	let okAll = true;
	for (const seed of ['t1', 't2', 't3', 't4', 't5']) {
		const scan = generateTargetScan({ seed, count: 5 });
		for (let i = 0; i < scan.candidates.length; i++) {
			if (!PROFILES[resolveTarget(scan, i).family]) okAll = false;
		}
	}
	check('toute cible résolue pointe un profil de vol', okAll);
}
```

Run: `node tools/selftest.mjs public/scenes/tour-eiffel`
Expected: `all checks passed`.

- [ ] **Step 2: Suites complètes**

Run:
```bash
npm run selftest:operator
node tools/selftest.mjs public/scenes/tour-eiffel
npm run build
```
Expected: tout vert.

- [ ] **Step 3: Run navigateur (dev)**

```bash
npm run dev
```
Vérifier, via chrome-devtools MCP (ou Chromium isolé + CDP si le profil MCP est verrouillé — cf. mémoire `reference_chrome_devtools_mcp`) :
1. Terminal opérateur → choisir un terrain en cache → **TARGET SCAN s'affiche**, N signaux, tri RSSI décroissant.
2. `↑`/`↓` déplacent le curseur ; `SELECT`/`Enter` → fiche pré-hack **sans** famille/caméra/rates.
3. `CONFIRM` → le vol charge ; `__sim.debug().family` == la famille du candidat choisi ; `__sim.debug().link.rssiDbm` reflète un décalage cohérent avec le signal annoncé.
4. `__sim.session()` porte `target` (family, signal, intel).
5. Poser + désarmer → `LANDED` ; depuis le terminal, `RESUME SESSION` → **pas de nouveau TARGET SCAN**, même famille qu'avant.
6. `?scene=tour-eiffel` (dev) : pas de TARGET SCAN, vol direct, `__sim.session().target` == `null`.

Noter les valeurs observées (famille, rssi, quality) pour le HANDOFF.

- [ ] **Step 4: HANDOFF**

Compléter l'entrée `PHASE 08` de `sim/HANDOFF.md` : remplacer « (en cours) » par l'état vérifié, lister ce qui a été confirmé au navigateur (avec les valeurs), et le point non couvert (ressenti de vol par famille, déjà noté en PHASE 07).

- [ ] **Step 5: Commit**

```bash
git add sim/tools/selftest.mjs sim/HANDOFF.md
git commit -m "PHASE 08 — vérif bout-en-bout + HANDOFF"
```

---

## Task 9: Finalisation

- [ ] **Step 1:** `git push -u origin phase-08-target-scan`
- [ ] **Step 2:** Ouvrir la PR vers `main` : titre `PHASE 08 — Target scan / choix de cible`, corps = résumé + `Closes #45`, note l'ordre de merge (après `phase-06-impl` et `phase-07-generation-cibles`, tous deux inclus dans cette branche).
- [ ] **Step 3:** Issue #45 → statut `Done` sur le Project 2 quand la PR est mergée. Vérifier le nom réel du repo/projet (`gh project item-list` n'a pas retourné #45 — repo peut-être renommé `FPVMaps`→`FPVTP`).
- [ ] **Step 4:** Si des écarts ont été découverts (aire km² non accessible dans `scanner.acquired()`, forme de `runTerminal`/`screen` différente, etc.) et contournés : créer une issue de suivi plutôt que laisser un TODO.

---

## Self-Review

**Spec coverage :**
- Génération signaux + info partielle (KNOWN/EST./UNKNOWN) → Task 1 (`generateTargetScan`, `describeTarget`).
- `session.target` non falsifiable, régénération serveur → Task 2 + Task 3.
- Ne jamais afficher famille/caméra/rates/batterie/état de vol → Task 1 (`describeTarget` sans `_family`, selftest dédié) + Task 5 (écran).
- RSSI informe `link.js` → Task 4.
- Cohérence densité Global Scanner → Task 6 (persistance) + Task 7 Step 5 (`signalCountFor`).
- Interaction courte, choix sans que le jeu dise quoi prendre → Task 5 (liste + une confirmation, aucun scoring).
- Famille pilote le modèle de vol → Task 7 (`PROFILE` résolu avant `boot()`).
- `resume` rejoue la même cible sans re-scan → Task 7 Step 3.
- Chemin dev `?scene=` / `?family=` préservé → Task 3 (branche `else` sans `targetSeed`), Task 7 Step 3.

**Placeholder scan :** les points « adapter à la forme réelle de `runTerminal`/`screen`/l'aire km² » sont des vérifications ciblées avec la forme attendue donnée et un plan B explicite — pas des TODO ouverts. Tout le code de test et d'implémentation est fourni.

**Type consistency :** `{ seed, count, index }` (retour `runTargetScan`) ↔ `target` de `session.open` ↔ `{ targetSeed, targetCount, targetIndex }` (body) ↔ `generateTargetScan({ seed, count })` + `resolveTarget(scan, index)` côté serveur : cohérent. `describeTarget` renvoie `deviceHint`/`videoHint` (utilisés tels quels par l'écran Task 5). `resolveTarget().signal.mode` = `_videoHint` (vrai mode), `sanitizeTarget` exige `mode ∈ {ANALOG, DIGITAL}` : cohérent. `FAMILY_CLASS`/`TARGET_FAMILIES` : même source, importés partout où la validation de famille est faite.
