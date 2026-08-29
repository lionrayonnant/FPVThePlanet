# PHASE 17 — Session Log / Target Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à l'opérateur un journal des sessions filtrable, un détail par session, et un Target Log en lecture seule — sans qu'aucune interaction de ces écrans ne remette un drone en vol.

**Architecture:** Tout le formatage et la dérivation vivent dans un module pur (`tools/session-log-model.mjs`), testé sans navigateur. Le schéma opérateur passe en v2 pour porter deux compteurs d'affichage (`sessionSeq`, `targetSeq`) et perdre la clé morte `targetLog`. Les routes de session élident les `dataUrl` des captures par défaut, une route dédiée les rend à la demande. Les écrans (`src/session-log.js`) sont du DOM pur au-dessus du modèle.

**Tech Stack:** Node 20+ (ESM, `node:assert/strict`, pas de framework de test), Vite 5 (serveur de dev + plugin middleware `tools/map-api-plugin.mjs`), aucun ajout de dépendance.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-phase-17-session-log-design.md`

## Global Constraints

- Toutes les commandes se lancent depuis `sim/`.
- **Interface, logs et textes du jeu : anglais.** Commentaires, commits, docs internes : **français**. (Décision transverse du 2026-08-29.)
- Aucune dépendance npm nouvelle.
- Un module de `tools/` importé par le client ne doit contenir **aucun `node:`** — il est bundlé par Vite. `tools/lib/weather.mjs` est le précédent : il importe `../../src/wind.js` et reste pur.
- `npm run selftest` (158 checks) et `npm run build` doivent rester verts à la fin de **chaque** tâche.
- Pas d'ESLint/Prettier : indentation **tabulation**, apostrophes simples, point-virgules — imiter le fichier voisin.
- Ne jamais lire `public/scenes/`, `flyover-reverse-engineering/downloaded_files/` ou `cache/` avec un outil de lecture de fichier ; passer par le shell (`ls`, `du`).
- Les écrans DOM n'ont **pas** de harnais de test dans ce dépôt (pas de jsdom, pas de vitest). N'en introduis pas : le formatage est testé dans le modèle pur, les écrans sont vérifiés au navigateur (tâche 7).
- Commit à la fin de chaque tâche, en français, avec le trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Branche : `phase-17-session-log`. Ne pas force-push.

---

## File Structure

| fichier | responsabilité | tâche |
|---|---|---|
| `tools/session-log-model.mjs` | **créé** — filtres, formatage des lignes et du détail, dérivation du Target Log | 1 |
| `tools/session-log-selftest.mjs` | **créé** — selftest du module ci-dessus | 1 |
| `tools/operator-store.mjs` | modifié — `SCHEMA_VERSION` 2, `freshState`, `migrate` (backfill + suppression de `targetLog`) | 2 |
| `tools/session-model.mjs` | modifié — `seq`/`targetSeq` dans `openSession`/`validateSession`, `stripPhotoData`, `deleteSession` | 2 |
| `tools/session-selftest.mjs` | modifié — cas de la tâche 2 | 2 |
| `tools/map-api-plugin.mjs` | modifié — assignation des numéros, élision, `GET`/`DELETE .../sessions/:sid`, `operatorSummary` | 3 |
| `tools/session-api-selftest.mjs` | **créé** — selftest HTTP contre un vrai serveur de dev sandboxé | 3 |
| `src/operator.js` | modifié — `getSession`, `deleteSession` | 4 |
| `src/session-log.js` | **créé** — `runSessionDetail`, puis `runSessionLog`, puis `runTargetLog` | 4 · 5 · 6 |
| `src/style.css` | modifié — vignettes des captures | 4 |
| `src/terminal.js` | modifié — câblage des trois écrans, retrait des souches | 4 · 5 · 6 |
| `tools/terminal-model.mjs` | modifié — compte des cibles dérivé | 6 |
| `tools/terminal-selftest.mjs` | modifié — le cas `targetLog` devient un cas `sessions` | 6 |
| `package.json` | modifié — chaînage des selftests | 1 · 3 |
| `HANDOFF.md` | modifié — état vérifié / non vérifié de PHASE 17 | 7 |

---

### Task 1: Le modèle pur — filtres, formatage, dérivation

**Files:**
- Create: `sim/tools/session-log-model.mjs`
- Test: `sim/tools/session-log-selftest.mjs`
- Modify: `sim/package.json` (script `selftest:operator`)

**Interfaces:**
- Consumes: `PROFILES` de `src/drone-profiles.js` (vérifié : zéro import, importable en Node) ; `formatVisibility`, `windLabel` de `tools/lib/weather.mjs`.
- Produces: `SESSION_FILTERS`, `filterSessions(sessions, filter)`, `sessionRow(s)`, `sessionDetail(s)`, `targetLogEntries(sessions)`, `targetRow(entry)`, `areaLabel(slug)`, `stamp(iso)`, `duration(seconds)`, `pad(n, width)`.

- [ ] **Step 1: Écrire le selftest qui échoue**

Créer `sim/tools/session-log-selftest.mjs` :

```js
// Selftest du modèle Session Log / Target Log (PHASE 17). Aucune E/S.
// Lancer : node tools/session-log-selftest.mjs
import assert from 'node:assert/strict';
import {
	SESSION_FILTERS, filterSessions, sessionRow, sessionDetail,
	targetLogEntries, targetRow, areaLabel, stamp, duration, pad,
} from './session-log-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const TARGET = {
	family: 'heavy5', classHint: null, hackType: 'FIRMWARE OVERRIDE',
	signal: { rssiDbm: -71, mode: 'ANALOG' }, scannedAt: null, intel: {},
};

const WEATHER = {
	zone: '48.86,2.29', day: '2026-08-28', source: 'open-meteo',
	regime: 'CLEAR', confidence: 0.94,
	day0: { regime: 'CLEAR', windSpeed: 2.4, windDir: 210, windGust: 3.6, rateMmH: 0, visibilityM: 14200, cloudPct: 10 },
};

const mk = (over = {}) => ({
	id: 'tour-eiffel-a3f2', operatorId: 'neo-0000', area: 'tour-eiffel',
	seq: 421, targetSeq: 42, target: TARGET, weatherSnapshot: WEATHER,
	start: '2026-08-28T21:42:10.000Z', end: '2026-08-28T22:00:52.000Z',
	result: 'LANDED',
	flightTelemetry: { durationS: 1122, maxSpeedMs: 19.4, maxRateDps: 640, maxAltitudeM: 87, distanceM: 4210 },
	randomart: '+--[ART]--+', photos: [], comment: null, resumeCount: 0,
	...over,
});

// --- formateurs -------------------------------------------------------------

t('pad : largeur fixe, zéros à gauche, plancher à 0', () => {
	assert.equal(pad(421), '00421');
	assert.equal(pad(42, 3), '042');
	assert.equal(pad(0, 2), '00');
	assert.equal(pad(undefined), '00000');
	assert.equal(pad(-3, 2), '00');
});

t('areaLabel : le libellé vient du slug, pas de scenes.json', () => {
	assert.equal(areaLabel('tour-eiffel'), 'TOUR EIFFEL');
	assert.equal(areaLabel('ile-de-la-cite-et-ile-saint-louis'), 'ILE DE LA CITE ET ILE SAINT LOUIS');
	assert.equal(areaLabel(''), 'UNKNOWN AREA');
	assert.equal(areaLabel(null), 'UNKNOWN AREA');
});

t('duration : minutes + secondes, secondes seules sous la minute', () => {
	assert.equal(duration(1122), '18m 42s');
	assert.equal(duration(42), '42s');
	assert.equal(duration(60), '1m 00s');
	assert.equal(duration(0), '0s');
	assert.equal(duration(undefined), '0s');
	assert.equal(duration(-5), '0s');
});

t('stamp : JJ.MM.AA / HH:MM, tiret sur une date illisible', () => {
	// Heure LOCALE : on compare à ce que Date rend sur cette machine, pas à une
	// chaîne figée — sinon le test casse selon le fuseau du runner.
	const d = new Date('2026-08-28T21:42:10.000Z');
	const p = (x) => String(x).padStart(2, '0');
	const want = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)} / ${p(d.getHours())}:${p(d.getMinutes())}`;
	assert.equal(stamp('2026-08-28T21:42:10.000Z'), want);
	assert.equal(stamp('pas une date'), '—');
	assert.equal(stamp(null), '—');
});

// --- filtres ----------------------------------------------------------------

t('SESSION_FILTERS : les quatre filtres de la spec, dans l’ordre', () => {
	assert.deepEqual(SESSION_FILTERS, ['ALL', 'LANDED', 'CRASHED', 'WITH PHOTOS']);
});

t('filterSessions : chaque filtre ne garde que ce qu’il annonce', () => {
	const list = [
		mk({ id: 'a', result: 'LANDED', photos: [{ w: 1, h: 1, ts: 'x' }] }),
		mk({ id: 'b', result: 'CRASHED', photos: [] }),
		mk({ id: 'c', result: 'PENDING', photos: [] }),
	];
	assert.deepEqual(filterSessions(list, 'ALL').map((s) => s.id), ['a', 'b', 'c']);
	assert.deepEqual(filterSessions(list, 'LANDED').map((s) => s.id), ['a']);
	assert.deepEqual(filterSessions(list, 'CRASHED').map((s) => s.id), ['b']);
	assert.deepEqual(filterSessions(list, 'WITH PHOTOS').map((s) => s.id), ['a']);
});

t('filterSessions : filtre inconnu ou entrée non-tableau → repli sûr', () => {
	const list = [mk()];
	assert.equal(filterSessions(list, 'NOPE').length, 1);
	assert.deepEqual(filterSessions(null, 'ALL'), []);
	assert.deepEqual(filterSessions(undefined, 'LANDED'), []);
});

t('filterSessions : ne mute jamais le tableau reçu', () => {
	const list = [mk()];
	const out = filterSessions(list, 'ALL');
	out.push(mk({ id: 'z' }));
	assert.equal(list.length, 1);
});

// --- ligne de liste ---------------------------------------------------------

t('sessionRow : numéro, zone, cible, verdict, durée', () => {
	const row = sessionRow(mk());
	assert.match(row, /SESSION 00421/);
	assert.match(row, /TOUR EIFFEL/);
	assert.match(row, /TARGET 042/);
	assert.match(row, /LANDED/);
	assert.match(row, /18m 42s/);
});

t('sessionRow : une session sans cible le dit, elle ne ment pas', () => {
	const row = sessionRow(mk({ target: null, targetSeq: undefined }));
	assert.match(row, /NO TARGET/);
	assert.doesNotMatch(row, /TARGET 0/);
});

// --- détail -----------------------------------------------------------------

t('sessionDetail : tous les blocs de la Bible §28 quand la donnée est là', () => {
	const d = sessionDetail(mk({ photos: [{ w: 1, h: 1, ts: 'x' }], comment: 'best signal so far' }));
	assert.match(d, /SESSION 00421/);
	assert.match(d, /TOUR EIFFEL/);
	assert.match(d, /TARGET 042/);
	assert.match(d, /HEAVY 5"/);          // le label de PROFILES, pas le slug de famille
	assert.match(d, /-71 dBm ANALOG/);
	assert.match(d, /FIRMWARE OVERRIDE/);
	assert.match(d, /RANDOMART/);
	assert.match(d, /WEATHER/);
	assert.match(d, /CLEAR/);
	assert.match(d, /WIND 2\.4 m\/s/);
	assert.match(d, /VIS 14 km/);
	assert.match(d, /FLIGHT/);
	assert.match(d, /18m 42s/);
	assert.match(d, /CAPTURES\n01/);
	assert.match(d, /OPERATOR NOTE\n"best signal so far"/);
});

t('sessionDetail : les blocs absents sont omis, pas inventés', () => {
	const d = sessionDetail(mk({
		target: null, targetSeq: undefined, weatherSnapshot: null,
		randomart: null, comment: null, photos: [],
	}));
	assert.doesNotMatch(d, /TARGET 0/);
	assert.doesNotMatch(d, /WEATHER/);
	assert.doesNotMatch(d, /RANDOMART/);
	assert.doesNotMatch(d, /OPERATOR NOTE/);
	assert.match(d, /CAPTURES\n00/);   // zéro capture reste affiché : c'est une info
	assert.match(d, /FLIGHT/);
});

t('sessionDetail : la pluie n’apparaît que s’il pleut', () => {
	const dry = sessionDetail(mk());
	assert.doesNotMatch(dry, /RAIN/);
	const wet = sessionDetail(mk({
		weatherSnapshot: { ...WEATHER, day0: { ...WEATHER.day0, rateMmH: 0.66 } },
	}));
	assert.match(wet, /RAIN 0\.7 mm\/h/);
});

// --- Target Log (dérivé) ----------------------------------------------------

t('targetLogEntries : dérivé des sessions, plus récent d’abord', () => {
	const list = [
		mk({ id: 'a', seq: 1, targetSeq: 1 }),
		mk({ id: 'b', seq: 2, targetSeq: 2, result: 'CRASHED' }),
		mk({ id: 'c', seq: 3, targetSeq: 3 }),
	];
	const e = targetLogEntries(list);
	assert.deepEqual(e.map((x) => x.targetSeq), [3, 2, 1]);
	assert.equal(e[1].result, 'CRASHED');
	assert.equal(e[0].sessionId, 'c');
	assert.equal(e[0].label, 'HEAVY 5"');
	assert.equal(e[0].hackType, 'FIRMWARE OVERRIDE');
});

t('targetLogEntries : une session sans cible n’entre pas au log', () => {
	const list = [mk({ id: 'a', seq: 1, targetSeq: 1 }), mk({ id: 'b', seq: 2, target: null, targetSeq: undefined })];
	const e = targetLogEntries(list);
	assert.equal(e.length, 1);
	assert.equal(e[0].sessionId, 'a');
});

t('targetLogEntries : entrée non-tableau → liste vide', () => {
	assert.deepEqual(targetLogEntries(null), []);
	assert.deepEqual(targetLogEntries(undefined), []);
});

t('targetRow : numéro, famille, signal, zone, date, verdict', () => {
	const row = targetRow(targetLogEntries([mk()])[0]);
	assert.match(row, /TARGET 042/);
	assert.match(row, /HEAVY 5"/);
	assert.match(row, /-71 dBm ANALOG/);
	assert.match(row, /TOUR EIFFEL/);
	assert.match(row, /LANDED/);
});

console.log(`\n${n} ok`);
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
cd sim && node tools/session-log-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` — `./session-log-model.mjs` n'existe pas.

- [ ] **Step 3: Écrire le module**

Créer `sim/tools/session-log-model.mjs` :

```js
// Logique pure du Session Log et du Target Log (PHASE 17, Bible §28).
// Aucune E/S, aucun DOM, aucun `node:` — importable tel quel par le client
// (bundlé par Vite) comme par le selftest.
//
// Le Target Log est DÉRIVÉ des sessions (spec D1) : il n'y a pas de stock à
// tenir à jour, seulement une lecture de `state.sessions`. Une session
// supprimée emporte donc la trace de sa cible, ce qui est le comportement
// voulu — le log ne conserve que la trace d'une session.
import { formatVisibility, windLabel } from './lib/weather.mjs';
import { PROFILES } from '../src/drone-profiles.js';

export const SESSION_FILTERS = ['ALL', 'LANDED', 'CRASHED', 'WITH PHOTOS'];

export function pad(n, width = 5) {
	const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	return String(v).padStart(width, '0');
}

// `tour-eiffel` → `TOUR EIFFEL`. Dérivé du slug porté par la session, jamais de
// `scenes.json` ni du `terrainCache` : une session doit rester lisible après la
// suppression de son terrain (Bible §29, « supprimer le terrain ne supprime pas
// le souvenir »).
export function areaLabel(slug) {
	const s = String(slug ?? '').trim();
	return s ? s.replace(/-+/g, ' ').toUpperCase() : 'UNKNOWN AREA';
}

// `28.08.26 / 21:42`, en heure LOCALE : c'est l'heure qu'il était pour
// l'opérateur, pas UTC.
export function stamp(iso) {
	const d = new Date(iso ?? NaN);
	if (Number.isNaN(d.getTime())) return '—';
	const p = (n) => String(n).padStart(2, '0');
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)}`
		+ ` / ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function duration(seconds) {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
	const m = Math.floor(s / 60);
	return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function filterSessions(sessions, filter) {
	const list = Array.isArray(sessions) ? sessions.slice() : [];
	switch (filter) {
		case 'LANDED': return list.filter((s) => s.result === 'LANDED');
		case 'CRASHED': return list.filter((s) => s.result === 'CRASHED');
		case 'WITH PHOTOS': return list.filter((s) => (s.photos?.length ?? 0) > 0);
		// `ALL` — et tout filtre inconnu, plutôt qu'une liste vide inexplicable.
		default: return list;
	}
}

function familyLabel(family) {
	return PROFILES[family]?.label ?? String(family ?? 'UNKNOWN');
}

export function sessionRow(s) {
	const target = s?.targetSeq ? `TARGET ${pad(s.targetSeq, 3)}` : 'NO TARGET';
	return [
		`SESSION ${pad(s?.seq)}`.padEnd(14),
		areaLabel(s?.area).padEnd(26),
		target.padEnd(11),
		String(s?.result ?? 'UNKNOWN').padEnd(8),
		duration(s?.flightTelemetry?.durationS),
	].join(' ');
}

// Chaque bloc rend `null` quand sa donnée manque : un bloc absent est omis du
// détail, jamais rempli d'une valeur inventée.
function targetBlock(s) {
	const t = s?.target;
	if (!t) return null;
	const lines = [`TARGET ${pad(s.targetSeq, 3)}`, familyLabel(t.family)];
	if (t.signal) lines[1] += `  ${t.signal.rssiDbm} dBm ${t.signal.mode}`;
	if (t.hackType) lines.push(t.hackType);
	return lines;
}

function weatherBlock(snapshot) {
	const d = snapshot?.day0;
	if (!d) return null;
	const lines = ['WEATHER', snapshot.regime ?? d.regime ?? 'UNKNOWN'];
	if (Number.isFinite(d.windSpeed)) {
		lines.push(`WIND ${d.windSpeed.toFixed(1)} m/s  ${windLabel(d.windSpeed)}`);
	}
	if (Number.isFinite(d.rateMmH) && d.rateMmH >= 0.05) {
		lines.push(`RAIN ${d.rateMmH.toFixed(1)} mm/h`);
	}
	if (Number.isFinite(d.visibilityM)) lines.push(`VIS ${formatVisibility(d.visibilityM)}`);
	return lines;
}

function flightBlock(s) {
	const tel = s?.flightTelemetry ?? {};
	return [
		'FLIGHT',
		duration(tel.durationS),
		`MAX SPEED ${(tel.maxSpeedMs ?? 0).toFixed(1)} m/s`
			+ ` · MAX ALT ${Math.round(tel.maxAltitudeM ?? 0)} m`
			+ ` · DISTANCE ${Math.round(tel.distanceM ?? 0)} m`,
		`RESULT ${s?.result ?? 'UNKNOWN'}`,
	];
}

export function sessionDetail(s) {
	const blocks = [
		[`SESSION ${pad(s?.seq)}`],
		[areaLabel(s?.area), stamp(s?.start)],
		targetBlock(s),
		s?.randomart ? ['RANDOMART', s.randomart] : null,
		weatherBlock(s?.weatherSnapshot),
		flightBlock(s),
		// Zéro capture reste affiché : « aucune photo » est une information.
		['CAPTURES', pad(s?.photos?.length ?? 0, 2)],
		s?.comment ? ['OPERATOR NOTE', `"${s.comment}"`] : null,
	];
	return blocks.filter(Boolean).map((b) => b.join('\n')).join('\n\n');
}

export function targetLogEntries(sessions) {
	return (Array.isArray(sessions) ? sessions : [])
		.filter((s) => s?.target && s?.targetSeq)
		.map((s) => ({
			targetSeq: s.targetSeq,
			sessionId: s.id,
			family: s.target.family,
			label: familyLabel(s.target.family),
			rssiDbm: s.target.signal?.rssiDbm ?? null,
			mode: s.target.signal?.mode ?? null,
			hackType: s.target.hackType ?? null,
			area: s.area,
			at: s.start,
			result: s.result,
		}))
		.sort((a, b) => b.targetSeq - a.targetSeq);
}

export function targetRow(e) {
	const signal = e.rssiDbm == null ? 'NO SIGNAL' : `${String(e.rssiDbm).padStart(4)} dBm ${e.mode}`;
	return [
		`TARGET ${pad(e.targetSeq, 3)}`.padEnd(11),
		e.label.padEnd(14),
		signal.padEnd(17),
		areaLabel(e.area).padEnd(26),
		stamp(e.at).padEnd(17),
		String(e.result ?? 'UNKNOWN'),
	].join(' ');
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
cd sim && node tools/session-log-selftest.mjs
```

Attendu : `17 ok`, sortie 0. Si `VIS 14 km` échoue, vérifier `formatVisibility(14200)` — la fonction rend `14 km` (pas de décimale au-dessus de 10 km).

- [ ] **Step 5: Chaîner dans le selftest opérateur**

Dans `sim/package.json`, ajouter `&& node tools/session-log-selftest.mjs` à la fin du script `selftest:operator` (après `node tools/post-flight-selftest.mjs`).

- [ ] **Step 6: Vérifier la chaîne complète**

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
```

Attendu : les trois verts.

- [ ] **Step 7: Commit**

```bash
cd sim && git add tools/session-log-model.mjs tools/session-log-selftest.mjs package.json
git commit -m "PHASE 17 : modèle pur du Session Log et du Target Log

Filtres, formatage des lignes et du détail (Bible §28), dérivation du
Target Log depuis les sessions (spec D1). 17 tests, chaînés dans
selftest:operator.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Schéma v2 — numéros d'affichage, élision, suppression

**Files:**
- Modify: `sim/tools/operator-store.mjs`
- Modify: `sim/tools/session-model.mjs`
- Test: `sim/tools/session-selftest.mjs`

**Interfaces:**
- Consumes: rien de la tâche 1.
- Produces: `SCHEMA_VERSION = 2` ; `freshState()` rend `{ sessionSeq: 0, targetSeq: 0 }` et **plus** de `targetLog` ; `migrate(state)` backfille `seq`/`targetSeq` ; `openSession({ operatorId, area, weatherSnapshot, target, seq, targetSeq })` ; `stripPhotoData(session)` ; `stripOperatorPhotoData(state)` ; `deleteSession(state, sid)` qui jette une erreur portant `.status` (404 / 409).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de la section `session-model` de `sim/tools/session-selftest.mjs` (avant la section client), et importer en tête `stripPhotoData`, `stripOperatorPhotoData`, `deleteSession` depuis `./session-model.mjs`, plus `migrate`, `freshState`, `SCHEMA_VERSION` depuis `./operator-store.mjs` :

```js
// --- PHASE 17 : numéros d'affichage, élision des captures, suppression ------

t('openSession : pose seq et targetSeq tels que le serveur les attribue', () => {
	const s = openSession({
		operatorId: 'neo-3f9c', area: 'tokyo', weatherSnapshot: null,
		target: null, seq: 421, targetSeq: null,
	});
	assert.equal(s.seq, 421);
	assert.equal(s.targetSeq, null);
	validateSession(s);
});

t('validateSession : exige un seq entier ≥ 1', () => {
	const good = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	assert.throws(() => validateSession({ ...good, seq: 0 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: 1.5 }), /seq/);
	assert.throws(() => validateSession({ ...good, seq: undefined }), /seq/);
});

t('validateSession : targetSeq obligatoire avec une cible, absent sans', () => {
	const scan = generateTargetScan({ seed: 'seq-seed', count: 3 });
	const target = resolveTarget(scan, 1);
	const withT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, target, seq: 2, targetSeq: 7 });
	assert.equal(withT.targetSeq, 7);
	validateSession(withT);
	assert.throws(() => validateSession({ ...withT, targetSeq: null }), /targetSeq/);
	const noT = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 3 });
	assert.throws(() => validateSession({ ...noT, targetSeq: 4 }), /targetSeq/);
});

t('resumeSession : les deux numéros survivent — c’est la même session', () => {
	const s = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 9 });
	const landed = closeSession(s, { result: 'LANDED' });
	const again = resumeSession(landed);
	assert.equal(again.seq, 9);
	assert.equal(again.resumeCount, 1);
});

t('stripPhotoData : retire dataUrl, garde w/h/ts, ne mute pas l’original', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/jpeg;base64,AAA=', w: 480, h: 360 },
	);
	const light = stripPhotoData(s);
	assert.equal(light.photos[0].dataUrl, undefined);
	assert.equal(light.photos[0].w, 480);
	assert.equal(light.photos[0].h, 360);
	assert.equal(typeof light.photos[0].ts, 'string');
	assert.equal(s.photos[0].dataUrl, 'data:image/jpeg;base64,AAA=');
	// La session élidée reste valide : l'élision est un allègement, pas une
	// corruption.
	validateSession(light);
});

t('stripOperatorPhotoData : élide toutes les sessions d’un état', () => {
	const s = addPhoto(
		openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 }),
		{ dataUrl: 'data:image/png;base64,BBB=', w: 8, h: 8 },
	);
	const light = stripOperatorPhotoData({ id: 'op', sessions: [s] });
	assert.equal(light.sessions[0].photos[0].dataUrl, undefined);
	assert.equal(s.photos[0].dataUrl, 'data:image/png;base64,BBB=');
});

t('deleteSession : retire l’entrée, ne touche à rien d’autre', () => {
	const a = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const b = openSession({ operatorId: 'op', area: 'lviv', weatherSnapshot: null, seq: 2 });
	const state = { id: 'op', sessionSeq: 2, targetSeq: 0, sessions: [closeSession(a, { result: 'LANDED' }), closeSession(b, { result: 'CRASHED' })] };
	const out = deleteSession(state, state.sessions[0].id);
	assert.equal(out.sessions.length, 1);
	assert.equal(out.sessions[0].area, 'lviv');
	// Les compteurs ne reculent pas : un numéro ne se recycle pas (spec D2).
	assert.equal(out.sessionSeq, 2);
	assert.equal(state.sessions.length, 2); // pas de mutation
});

t('deleteSession : 404 sur inconnue, 409 sur une session encore PENDING', () => {
	const p = openSession({ operatorId: 'op', area: 'kyiv', weatherSnapshot: null, seq: 1 });
	const state = { id: 'op', sessions: [p] };
	assert.throws(() => deleteSession(state, 'nexiste-pas-0000'), (e) => e.status === 404);
	assert.throws(() => deleteSession(state, p.id), (e) => e.status === 409);
});

// --- migration v1 → v2 ------------------------------------------------------

t('SCHEMA_VERSION vaut 2', () => {
	assert.equal(SCHEMA_VERSION, 2);
});

t('freshState : deux compteurs à zéro, plus de clé targetLog', () => {
	const s = freshState({ id: 'neo-0000', name: 'neo' });
	assert.equal(s.sessionSeq, 0);
	assert.equal(s.targetSeq, 0);
	assert.equal('targetLog' in s, false);
});

t('migrate v1 → v2 : backfill des numéros dans l’ordre, targetLog retiré', () => {
	const scan = generateTargetScan({ seed: 'mig-seed', count: 3 });
	const withTarget = resolveTarget(scan, 0);
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {},
		targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null },
			{ id: 'b-0002', area: 'b', result: 'CRASHED', target: withTarget },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: withTarget },
		],
	};
	const m = migrate(v1);
	assert.equal(m.schemaVersion, 2);
	assert.equal('targetLog' in m, false);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 2, 3]);
	// Seules les sessions avec cible consomment un numéro de cible.
	assert.equal(m.sessions[0].targetSeq, undefined);
	assert.equal(m.sessions[1].targetSeq, 1);
	assert.equal(m.sessions[2].targetSeq, 2);
	assert.equal(m.sessionSeq, 3);
	assert.equal(m.targetSeq, 2);
});

t('migrate : idempotent — repasser un état v2 ne renumérote rien', () => {
	const scan = generateTargetScan({ seed: 'mig-seed-2', count: 3 });
	const v1 = {
		schemaVersion: 1, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {}, targetLog: [],
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: resolveTarget(scan, 0) },
			{ id: 'b-0002', area: 'b', result: 'LANDED', target: null },
		],
	};
	const once = migrate(v1);
	const twice = migrate(once);
	assert.deepEqual(twice.sessions.map((s) => s.seq), once.sessions.map((s) => s.seq));
	assert.deepEqual(twice.sessions.map((s) => s.targetSeq), once.sessions.map((s) => s.targetSeq));
	assert.equal(twice.sessionSeq, once.sessionSeq);
	assert.equal(twice.targetSeq, once.targetSeq);
});

t('migrate : un trou de numérotation survit à la relecture', () => {
	// Ce que devient un fichier v2 après DELETE de la session 2 : les numéros
	// restants ne bougent pas, et les compteurs ne reculent pas.
	const v2 = {
		schemaVersion: 2, id: 'neo-0000', name: 'neo', createdAt: '2026-01-01T00:00:00.000Z',
		controlVector: [], settings: {}, terrainCache: [], worldState: {},
		sessionSeq: 3, targetSeq: 0,
		sessions: [
			{ id: 'a-0001', area: 'a', result: 'LANDED', target: null, seq: 1 },
			{ id: 'c-0003', area: 'c', result: 'LANDED', target: null, seq: 3 },
		],
	};
	const m = migrate(v2);
	assert.deepEqual(m.sessions.map((s) => s.seq), [1, 3]);
	assert.equal(m.sessionSeq, 3);
});
```

Ajouter aussi en tête du fichier, si absent, l'import `generateTargetScan, resolveTarget` depuis `./target-model.mjs`.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
cd sim && node tools/session-selftest.mjs
```

Attendu : `SyntaxError`/`ERR` sur l'import de `stripPhotoData` (export inexistant).

- [ ] **Step 3: Implémenter dans `operator-store.mjs`**

Remplacer `SCHEMA_VERSION`, `freshState` et `migrate` :

```js
export const SCHEMA_VERSION = 2;
```

```js
export function freshState({ id, name }) {
	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		name,
		createdAt: new Date().toISOString(),
		controlVector: [],
		settings: {},
		terrainCache: [],
		sessions: [],
		// Numéros d'affichage (PHASE 17, spec D2). Deux compteurs et non un : le
		// footer les compte séparément, et une session ouverte sans TARGET SCAN
		// (chemin dev `?scene=`) ne doit pas consommer un numéro de cible.
		// Attribués une fois, jamais recyclés — supprimer une session laisse un
		// trou, et c'est voulu.
		sessionSeq: 0,
		targetSeq: 0,
		worldState: {},
	};
}

// Attribue les numéros manquants dans l'ordre du tableau et rend les compteurs
// au maximum atteint. Idempotent : un état déjà numéroté ressort identique.
function backfillSeq(sessions) {
	let sessionSeq = 0;
	let targetSeq = 0;
	const out = (sessions ?? []).map((s) => {
		const seq = Number.isInteger(s.seq) && s.seq > 0 ? s.seq : sessionSeq + 1;
		sessionSeq = Math.max(sessionSeq, seq);
		if (!s.target) {
			// Une session sans cible ne porte pas de targetSeq du tout.
			const { targetSeq: _drop, ...rest } = s;
			return { ...rest, seq };
		}
		const ts = Number.isInteger(s.targetSeq) && s.targetSeq > 0 ? s.targetSeq : targetSeq + 1;
		targetSeq = Math.max(targetSeq, ts);
		return { ...s, seq, targetSeq: ts };
	});
	return { sessions: out, sessionSeq, targetSeq };
}

export function migrate(state) {
	if (!state || typeof state !== 'object') throw new Error('état opérateur illisible');
	const v = state?.schemaVersion ?? 0;
	if (v > SCHEMA_VERSION) throw new Error('schemaVersion trop récent');
	const base = freshState({ id: state.id, name: state.name });
	const merged = {
		...base,
		...state,
		schemaVersion: SCHEMA_VERSION,
		createdAt: state.createdAt ?? base.createdAt,
	};
	// v1 → v2 : `targetLog` n'a jamais été écrit (toujours vide) et le Target Log
	// est désormais dérivé des sessions (spec D1). On retire la clé morte plutôt
	// que de la traîner.
	delete merged.targetLog;
	const filled = backfillSeq(merged.sessions);
	merged.sessions = filled.sessions;
	merged.sessionSeq = Math.max(filled.sessionSeq, merged.sessionSeq ?? 0);
	merged.targetSeq = Math.max(filled.targetSeq, merged.targetSeq ?? 0);
	return merged;
}
```

- [ ] **Step 4: Implémenter dans `session-model.mjs`**

Dans `openSession`, accepter et poser les deux numéros :

```js
export function openSession({ operatorId, area, weatherSnapshot, target, seq, targetSeq }) {
	if (!operatorId) throw new Error('operatorId requis');
	const areaSlug = slugify(area);
	if (!areaSlug) throw new Error('AREA UNUSABLE');
	const id = newSessionId(area);
	const resolved = sanitizeTarget(target);
	const session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		id,
		operatorId,
		area: areaSlug,
		// Numéro d'affichage (PHASE 17). Attribué par le serveur, qui seul connaît
		// le compteur de l'opérateur ; figé pour toujours, y compris au `resume`.
		seq,
		target: resolved,
		weatherSnapshot: sanitizeWeatherSnapshot(weatherSnapshot),
		start: new Date().toISOString(),
		end: null,
		result: 'PENDING',
		flightTelemetry: freshTelemetry(),
		randomart: randomart(id, { tag: id.slice(-4) }),
		photos: [],
		comment: null,
		resumeCount: 0,
	};
	// Sans cible, la clé n'est posée que si l'appelant a dit quelque chose : une
	// session ouverte sans TARGET SCAN n'a pas de `targetSeq` du tout, et un
	// `null` explicite reste un `null` (ce que `validateSession` accepte).
	if (resolved || targetSeq !== undefined) session.targetSeq = targetSeq;
	return session;
}
```

Ajouter les trois nouvelles fonctions, après `annotateSession` :

```js
// PHASE 17, spec D4 : les captures sont stockées en base64 DANS la session, et
// le terminal recharge l'opérateur entier à chaque retour au menu. On élide les
// `dataUrl` de toutes les réponses sauf celle de la route dédiée
// `GET .../sessions/:sid`, seule à les rendre — et seule appelée par l'écran
// VIEW SESSION. `w`/`h`/`ts` restent : ils suffisent au compte et au filtre
// WITH PHOTOS.
export function stripPhotoData(session) {
	if (!session || typeof session !== 'object') return session;
	return {
		...session,
		photos: (session.photos ?? []).map(({ dataUrl, ...rest }) => rest),
	};
}

export function stripOperatorPhotoData(state) {
	if (!state || typeof state !== 'object') return state;
	return { ...state, sessions: (state.sessions ?? []).map(stripPhotoData) };
}

// PHASE 17, spec D3 : suppression franche. L'entrée quitte `state.sessions`,
// captures comprises ; le terrain n'est JAMAIS touché — symétrique de
// « supprimer le terrain ne supprime pas le souvenir » (Bible §29).
// Les compteurs ne reculent pas : un numéro ne se recycle pas, la suppression
// laisse un trou visible dans le journal.
export function deleteSession(state, sid) {
	const sessions = state?.sessions ?? [];
	const i = sessions.findIndex((s) => s.id === sid);
	if (i < 0) {
		const e = new Error(`aucune session "${sid}"`);
		e.status = 404;
		throw e;
	}
	if (sessions[i].result === 'PENDING') {
		// Peut-être encore en vol dans un autre onglet : on ne supprime pas sous
		// les pieds d'une session ouverte.
		const e = new Error(`session "${sid}" encore en vol`);
		e.status = 409;
		throw e;
	}
	return { ...state, sessions: [...sessions.slice(0, i), ...sessions.slice(i + 1)] };
}
```

Dans `validateSession`, après le contrôle de `result` :

```js
	if (!Number.isInteger(s.seq) || s.seq < 1) throw new Error('seq de session invalide');
	if (s.target != null) {
		if (!Number.isInteger(s.targetSeq) || s.targetSeq < 1) {
			throw new Error('targetSeq requis pour une session avec cible');
		}
	} else if (s.targetSeq != null) {
		throw new Error('targetSeq sans cible');
	}
```

- [ ] **Step 5: Lancer les tests**

```bash
cd sim && node tools/session-selftest.mjs && node tools/operator-selftest.mjs
```

Attendu : les deux verts. `operator-selftest.mjs:52` asserte `s.targetLog` deepEqual `[]` — le corriger en `assert.equal('targetLog' in s, false); assert.equal(s.sessionSeq, 0); assert.equal(s.targetSeq, 0);`.

- [ ] **Step 6: Vérifier que rien d'autre n'a cassé**

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
```

Attendu : les trois verts. `session-route-selftest.mjs` appelle `openSession` sans `seq` puis `validateSession` — lui passer `seq: 1, targetSeq: 1`.

- [ ] **Step 7: Commit**

```bash
cd sim && git add tools/operator-store.mjs tools/session-model.mjs tools/session-selftest.mjs tools/operator-selftest.mjs tools/session-route-selftest.mjs
git commit -m "PHASE 17 : schéma opérateur v2 — numéros d'affichage, élision, suppression

seq/targetSeq attribués à l'ouverture et jamais recyclés (spec D2), clé
morte targetLog retirée par la migration (D1), stripPhotoData pour
alléger les réponses (D4), deleteSession pur avec ses codes 404/409 (D3).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Les routes — assignation, élision, lecture complète, suppression

**Files:**
- Modify: `sim/tools/map-api-plugin.mjs`
- Create: `sim/tools/session-api-selftest.mjs`
- Modify: `sim/package.json` (script `selftest:api`)

**Interfaces:**
- Consumes: `stripPhotoData`, `stripOperatorPhotoData`, `deleteSession` (tâche 2) ; `targetLogEntries` (tâche 1).
- Produces: `GET /__operator/:id/sessions/:sid` → `{ session }` complet ; `DELETE /__operator/:id/sessions/:sid` → `{ removed: sid }`.

- [ ] **Step 1: Écrire le selftest HTTP qui échoue**

Créer `sim/tools/session-api-selftest.mjs` :

```js
// Selftest des routes de session (PHASE 17) contre un VRAI serveur de dev.
//
// Contrairement aux autres selftests, celui-ci démarre Vite : il est lent et
// n'est donc PAS chaîné dans `npm run selftest:operator`. Lancer :
//   npm run selftest:api
//
// L'état opérateur est redirigé vers un répertoire temporaire via
// FPV_OPERATOR_DIR — lu par map-api-plugin.mjs à son chargement, d'où le
// process.env AVANT l'import de vite. Le fichier opérateur réel de
// l'utilisateur n'est ni lu ni écrit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpvtp-api-'));
process.env.FPV_OPERATOR_DIR = DIR;

const { createServer } = await import('vite');

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const server = await createServer({ server: { port: 0 }, logLevel: 'error' });
await server.listen();
const { port } = server.httpServer.address();
const base = `http://127.0.0.1:${port}`;

const call = async (method, p, body) => {
	const r = await fetch(base + p, body === undefined ? { method } : {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: r.status, body: await r.json().catch(() => ({})) };
};

const PHOTO = { dataUrl: 'data:image/jpeg;base64,/9j/AAA=', w: 480, h: 360 };

try {
	// --- un opérateur, deux sessions -----------------------------------------
	const created = await call('POST', '/__operator', { name: 'apitest' });
	check('POST /__operator crée un opérateur v2', created.status === 201
		&& created.body.operator.schemaVersion === 2
		&& created.body.operator.sessionSeq === 0
		&& !('targetLog' in created.body.operator));
	const id = created.body.operator.id;

	const s1 = await call('POST', `/__operator/${id}/sessions`, {
		area: 'tour-eiffel', weatherSnapshot: null,
		targetSeed: 'api-seed', targetCount: 4, targetIndex: 1,
	});
	check('POST sessions : première session numérotée 1 / cible 1',
		s1.status === 201 && s1.body.session.seq === 1 && s1.body.session.targetSeq === 1);
	const sid1 = s1.body.session.id;

	// Session sans TARGET SCAN (chemin dev) : elle ne consomme pas de numéro de
	// cible.
	const s2 = await call('POST', `/__operator/${id}/sessions`, { area: 'kyiv', weatherSnapshot: null });
	check('POST sessions : une session sans cible ne consomme pas de targetSeq',
		s2.status === 201 && s2.body.session.seq === 2 && s2.body.session.targetSeq == null);
	const sid2 = s2.body.session.id;

	// --- captures et élision --------------------------------------------------
	const ph = await call('POST', `/__operator/${id}/sessions/${sid1}/photos`, PHOTO);
	check('POST photos : accepté, et la réponse est déjà élidée',
		ph.status === 201 && ph.body.session.photos.length === 1
		&& ph.body.session.photos[0].dataUrl === undefined
		&& ph.body.session.photos[0].w === 480);

	const full = await call('GET', `/__operator/${id}`);
	check('GET /__operator/:id : aucune dataUrl dans la charge utile',
		full.status === 200
		&& !JSON.stringify(full.body).includes('data:image/'));

	const one = await call('GET', `/__operator/${id}/sessions/${sid1}`);
	check('GET .../sessions/:sid : la capture complète, dataUrl comprise',
		one.status === 200 && one.body.session.photos[0].dataUrl === PHOTO.dataUrl);

	const missing = await call('GET', `/__operator/${id}/sessions/nexiste-pas-0000`);
	check('GET .../sessions/:sid inconnue → 404', missing.status === 404);

	// --- suppression ----------------------------------------------------------
	const pending = await call('DELETE', `/__operator/${id}/sessions/${sid2}`);
	check('DELETE une session PENDING → 409', pending.status === 409);

	const closed = await call('PATCH', `/__operator/${id}/sessions/${sid1}`, {
		result: 'LANDED',
		telemetry: { durationS: 12, maxSpeedMs: 4, maxRateDps: 90, maxAltitudeM: 3, distanceM: 20 },
	});
	check('PATCH clôture : LANDED, réponse élidée', closed.status === 200
		&& closed.body.session.result === 'LANDED'
		&& closed.body.session.photos[0].dataUrl === undefined);

	const gone = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE une session close → 200', gone.status === 200 && gone.body.removed === sid1);

	const after = await call('GET', `/__operator/${id}`);
	check('après DELETE : la session a disparu, le compteur ne recule pas',
		after.body.operator.sessions.length === 1
		&& after.body.operator.sessionSeq === 2);

	const again = await call('DELETE', `/__operator/${id}/sessions/${sid1}`);
	check('DELETE deux fois → 404', again.status === 404);

	// Le trou : la prochaine session prend 3, pas 2.
	const s3 = await call('POST', `/__operator/${id}/sessions`, { area: 'lviv', weatherSnapshot: null });
	check('le numéro suivant est 3 : un numéro ne se recycle pas', s3.body.session.seq === 3);
} finally {
	await server.close();
	fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Ajouter d'abord dans `sim/package.json` : `"selftest:api": "node tools/session-api-selftest.mjs"`.

```bash
cd sim && npm run selftest:api
```

Attendu : plusieurs `FAIL` — au minimum `GET .../sessions/:sid` et les deux `DELETE` (404 « route inconnue »), et l'élision absente.

- [ ] **Step 3: Implémenter les routes**

Dans `sim/tools/map-api-plugin.mjs` :

Import — ajouter à l'import depuis `./session-model.mjs` : `stripPhotoData`, `stripOperatorPhotoData`, `deleteSession`. Ajouter `import { targetLogEntries } from './session-log-model.mjs';`.

`operatorSummary` — le compte des cibles devient dérivé :

```js
			targets: targetLogEntries(s.sessions).length,
```

`GET /^\/([^/]+)$/` — élider avant de répondre :

```js
		// Les `dataUrl` des captures ne partent PAS ici (spec D4) : le terminal
		// recharge l'opérateur à chaque retour au menu, et une trentaine de
		// sessions photographiées pèseraient des dizaines de mégaoctets à chaque
		// fois. VIEW SESSION va les chercher une par une sur la route dédiée.
		json(res, 200, { operator: stripOperatorPhotoData(rec.state) });
```

`POST /^\/([^/]+)\/sessions$/` — assigner les numéros dans la branche « session neuve », juste avant `state.sessions.push(session)` :

```js
				session = validateSession(openSession({
					operatorId: state.id,
					area: b.area,
					weatherSnapshot: sanitizeWeatherSnapshot(b.weatherSnapshot ?? null),
					target,
					// Numéros d'affichage (PHASE 17). Le serveur seul les attribue :
					// lui seul connaît le compteur. On n'incrémente qu'APRÈS la
					// validation, pour qu'une session refusée ne consomme rien.
					seq: (state.sessionSeq ?? 0) + 1,
					targetSeq: target ? (state.targetSeq ?? 0) + 1 : undefined,
				}));
				state.sessions.push(session);
				state.sessionSeq = session.seq;
				if (session.targetSeq) state.targetSeq = session.targetSeq;
```

et la réponse de cette route : `json(res, 201, { session: stripPhotoData(session) });`

Faire de même — `stripPhotoData(session)` dans la réponse — pour `closeSessionRoute`, la route `/comment` et la route `/photos`.

Ajouter les deux nouvelles routes au tableau `opRoutes`, **avant** les routes `/photos` (l'ordre n'importe pas, les regex sont distinctes, mais garder les routes d'une même ressource groupées) :

```js
	// La session COMPLÈTE, captures comprises (PHASE 17, spec D4). Toutes les
	// autres réponses élident les `dataUrl` ; seul l'écran VIEW SESSION paie le
	// poids des images, une fois, à son ouverture.
	['GET', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		const session = state.sessions.find((s) => s.id === sid);
		if (!session) return json(res, 404, { error: `aucune session "${sid}"` });
		json(res, 200, { session });
	}],

	// DELETE SESSION (PHASE 17, spec D3). Suppression franche : l'entrée et ses
	// captures disparaissent, et sa cible quitte donc le Target Log, qui en est
	// dérivé. Le terrain n'est jamais touché.
	['DELETE', /^\/([^/]+)\/sessions\/([^/]+)$/, async (req, res, [id, sid]) => {
		let state;
		try { state = _readOperator(id); }
		catch (e) { return json(res, opReadErrorStatus(e), { error: e.message }); }
		if (!state) return json(res, 404, { error: `aucun opérateur "${id}"` });
		let next;
		try { next = deleteSession(state, sid); }
		catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
		_writeOperator(next);
		json(res, 200, { removed: sid });
	}],
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
cd sim && npm run selftest:api
```

Attendu : `13 ok`, sortie 0.

- [ ] **Step 5: Vérifier que rien d'autre n'a cassé**

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
```

Attendu : les trois verts.

- [ ] **Step 6: Commit**

```bash
cd sim && git add tools/map-api-plugin.mjs tools/session-api-selftest.mjs package.json
git commit -m "PHASE 17 : routes de session — numéros, élision, lecture complète, suppression

Le serveur attribue seq/targetSeq à l'ouverture, élide les dataUrl de
toutes les réponses sauf la nouvelle GET .../sessions/:sid, et expose
DELETE .../sessions/:sid (404 inconnue, 409 encore en vol).

Nouveau selftest HTTP contre un vrai serveur de dev, état opérateur
sandboxé par FPV_OPERATOR_DIR. Hors de la chaîne rapide : npm run selftest:api.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: L'écran de détail — VIEW SESSION

**Files:**
- Modify: `sim/src/operator.js`
- Create: `sim/src/session-log.js`
- Modify: `sim/src/style.css`
- Modify: `sim/src/terminal.js` (`lastSessionScreen`)

**Interfaces:**
- Consumes: `sessionDetail` (tâche 1) ; `GET`/`DELETE .../sessions/:sid` (tâche 3) ; `screen`, `button`, `fetchScenes` de `src/terminal.js`.
- Produces: `runSessionDetail(root, sessionId, { scenes })` → `Promise<undefined | { revisit: slug } | { deleted: sessionId }>` ; `operatorApi.getSession(sid)`, `operatorApi.deleteSession(sid)`.

**Note pour l'implémenteur :** les écrans DOM n'ont pas de harnais de test ici. Le formatage est déjà couvert par la tâche 1 ; cet écran se vérifie au navigateur (tâche 7). N'introduis pas jsdom.

- [ ] **Step 1: Ajouter les deux appels client**

Dans `sim/src/operator.js`, après `patchSessionComment` :

```js
// La session COMPLÈTE, captures comprises (PHASE 17). Les autres réponses
// élident les `dataUrl` : seul VIEW SESSION paie le poids des images, et
// seulement à son ouverture.
export async function getSession(sid) {
	if (!cache) throw new Error('aucun opérateur chargé');
	return (await req('GET', `/${cache.id}/sessions/${sid}`)).session;
}

// DELETE SESSION (PHASE 17). Le cache local est mis à jour tout de suite : la
// Home se reconstruit derrière l'écran de détail, et son footer doit compter
// juste sans refaire un GET complet.
export async function deleteSession(sid) {
	if (!cache) throw new Error('aucun opérateur chargé');
	const { removed } = await req('DELETE', `/${cache.id}/sessions/${sid}`);
	cache.sessions = (cache.sessions ?? []).filter((s) => s.id !== sid);
	return removed;
}
```

- [ ] **Step 2: Créer l'écran de détail**

Créer `sim/src/session-log.js` :

```js
// SESSION LOG / TARGET LOG (PHASE 17, Bible §28 et §30). Écrans client purs :
// `screen`/`button` de terminal.js, aucune dépendance Three/Rapier. Tout le
// formatage vit dans tools/session-log-model.mjs — ici, rien que du DOM.
//
// terminal.js importe ce module À LA DEMANDE (`await import`), comme il le fait
// déjà pour le scanner : un import statique fermerait un cycle, puisque ce
// fichier importe screen/button de terminal.js.
import { screen, button, fetchScenes } from './terminal.js';
import * as operatorApi from './operator.js';
import { sessionDetail } from '../tools/session-log-model.mjs';

// Vignettes des captures. `dataUrl` n'existe que sur la réponse de la route
// dédiée (spec D4) — d'où le garde-fou : une session lue depuis le cache
// opérateur n'affiche simplement rien.
function gallery(photos) {
	const wrap = document.createElement('div');
	wrap.className = 'session-shots';
	for (const p of photos ?? []) {
		if (!p.dataUrl) continue;
		const img = document.createElement('img');
		img.src = p.dataUrl;
		img.alt = 'CAPTURE';
		wrap.appendChild(img);
	}
	return wrap;
}

// Détail d'une session (Bible §28). Charge la session COMPLÈTE via la route
// dédiée : c'est le seul endroit du jeu qui rapatrie les images.
//
// Résout `undefined` (retour), `{ revisit: slug }` ou `{ deleted: sessionId }`.
export async function runSessionDetail(root, sessionId, { scenes = null } = {}) {
	const s = screen(root);
	s.box.innerHTML = '<pre>SESSION\n\nREADING LOG…</pre>';

	let session = null;
	let error = null;
	try { session = await operatorApi.getSession(sessionId); }
	catch (e) { error = e; }

	// L'écran a pu être démonté pendant la requête.
	if (!s.el.isConnected) return undefined;

	if (error) {
		s.box.querySelector('pre').textContent = `SESSION\n\nLOG UNREADABLE — ${error.message}`;
		return new Promise((resolve) => {
			s.box.appendChild(button('BACK', () => { s.remove(); resolve(undefined); }, 'terminal-cta'));
		});
	}

	// REVISIT n'est proposé que si la zone est encore sur disque. `scenes` vaut
	// `null` quand l'appelant ne l'a pas déjà : on le demande alors nous-mêmes.
	const known = scenes ?? await fetchScenes().catch(() => null);
	const areaKnown = Array.isArray(known) && known.some((sc) => sc.slug === session.area);
	if (!s.el.isConnected) return undefined;

	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve(value);
		};

		s.box.innerHTML = `<pre>${sessionDetail(session)}</pre>`;
		if (session.photos?.length) s.box.appendChild(gallery(session.photos));

		if (areaKnown) {
			// REVISIT AREA ne rejoue PAS la session (issue #54) : il rend le slug au
			// terminal, qui repart par le chemin de vol normal — TARGET SCAN frais,
			// météo courante, entry state neuf, terrain relu sur disque.
			s.box.appendChild(button('REVISIT AREA', () => finish({ revisit: session.area }), 'terminal-cta'));
		}
		s.box.appendChild(button('DELETE SESSION', async () => {
			if (done) return;
			try { await operatorApi.deleteSession(session.id); }
			catch (e) {
				console.warn('[session-log] suppression refusée', e);
				const warn = document.createElement('pre');
				warn.textContent = `\nDELETE REFUSED — ${e.message}`;
				s.box.appendChild(warn);
				return;
			}
			finish({ deleted: session.id });
		}, 'terminal-cta'));
		s.box.appendChild(button('BACK', () => finish(undefined), 'terminal-cta'));

		function onKey(e) {
			if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); finish(undefined); }
		}
		window.addEventListener('keydown', onKey);
	});
}
```

- [ ] **Step 3: Ajouter le style des vignettes**

Dans `sim/src/style.css`, à la suite des autres règles `.terminal-*`, en imitant leur écriture (mêmes unités, même palette — lire les voisines avant d'écrire) :

```css
/* Vignettes des captures d'une session (PHASE 17). Grille souple : le détail
   d'une session ne doit jamais forcer un défilement horizontal. */
.session-shots {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin: 0.75rem 0;
}

.session-shots img {
	width: 9rem;
	height: auto;
	border: 1px solid currentColor;
	image-rendering: pixelated;
}
```

- [ ] **Step 4: Brancher sur le `VIEW SESSION` de LAST SESSION**

Dans `sim/src/terminal.js`, remplacer le bouton souche de `lastSessionScreen` :

```js
		s.box.appendChild(button('VIEW SESSION', async () => {
			s.el.style.display = 'none';
			const { runSessionDetail } = await import('./session-log.js');
			const r = await runSessionDetail(root, ls.id, { scenes: null });
			// REVISIT et DELETE ferment LAST SESSION : dans les deux cas l'écran
			// qu'on avait sous les yeux ne décrit plus l'état courant.
			if (r?.revisit) { s.remove(); resolve(r.revisit); return; }
			if (r?.deleted) { s.remove(); resolve(); return; }
			s.el.style.display = '';
		}, 'terminal-cta'));
```

- [ ] **Step 5: Vérifier que le build passe**

```bash
cd sim && npm run build && npm run selftest:operator
```

Attendu : les deux verts. Le build échoue si l'import de `../tools/session-log-model.mjs` tire un `node:` — c'est le garde-fou.

- [ ] **Step 6: Vérifier à l'œil dans le navigateur**

```bash
cd sim && npm run dev
```

Voler une session courte sur une scène locale, la poser (`j`), sortir (`Échap`), puis Home → `LAST SESSION` → `VIEW SESSION`. Attendu : le bloc §28 complet, `BACK` qui revient, console sans erreur. Ne pas cliquer `DELETE SESSION` ici — il est vérifié en tâche 7 sur une session jetable.

- [ ] **Step 7: Commit**

```bash
cd sim && git add src/operator.js src/session-log.js src/style.css src/terminal.js
git commit -m "PHASE 17 : écran de détail de session

VIEW SESSION rend le bloc Bible §28, les vignettes des captures (route
dédiée, seul endroit qui rapatrie les images), REVISIT AREA et DELETE
SESSION. Câblé sur LAST SESSION ; import à la demande pour ne pas fermer
de cycle avec terminal.js.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: L'écran de liste — SESSION LOG

**Files:**
- Modify: `sim/src/session-log.js`
- Modify: `sim/src/terminal.js` (souche `SESSION LOG` de la Home)

**Interfaces:**
- Consumes: `SESSION_FILTERS`, `filterSessions`, `sessionRow` (tâche 1) ; `runSessionDetail` (tâche 4).
- Produces: `runSessionLog(root, { operator, scenes })` → `Promise<undefined | slug>`.

- [ ] **Step 1: Compléter l'import du modèle**

En tête de `sim/src/session-log.js` :

```js
import {
	SESSION_FILTERS, filterSessions, sessionRow, sessionDetail,
} from '../tools/session-log-model.mjs';
```

- [ ] **Step 2: Écrire l'écran de liste**

Ajouter à `sim/src/session-log.js`, avant `runSessionDetail` :

```js
// SESSION LOG (Bible §28). Liste filtrable, curseur ↑/↓, ←/→ change de filtre,
// Entrée ouvre la fiche, Échap revient — même grammaire que le TARGET SCAN.
//
// Résout `undefined` (retour au terminal) ou un slug de zone (REVISIT AREA
// remonté depuis la fiche).
export function runSessionLog(root, { operator, scenes = null } = {}) {
	// Plus récent en haut : c'est ce que l'opérateur vient de vivre. Copie
	// locale, parce qu'une suppression la modifie sans toucher au cache.
	const all = [...(operator?.sessions ?? [])].reverse();

	return new Promise((resolve) => {
		let filter = 'ALL';
		let cursor = 0;
		let busy = false; // une fiche est ouverte : la liste ne réagit plus
		let done = false;

		const s = screen(root);
		const rows = () => filterSessions(all, filter);

		const finish = (value) => {
			if (done) return;
			done = true;
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve(value);
		};

		const draw = () => {
			const list = rows();
			cursor = list.length ? Math.min(cursor, list.length - 1) : 0;
			const body = list.length
				? list.map((sess, i) => `${i === cursor ? '>' : ' '} ${sessionRow(sess)}`).join('\n')
				: '  NO SESSIONS MATCH THIS FILTER';
			s.box.innerHTML = `<pre>SESSION LOG

${body}</pre>`;

			const nav = document.createElement('div');
			nav.className = 'terminal-nav';
			SESSION_FILTERS.forEach((f, i) => {
				if (i) nav.appendChild(document.createTextNode(' · '));
				// Le filtre actif se lit entre crochets — pas de classe dédiée, la
				// Home est calme (Bible §30).
				nav.appendChild(button(f === filter ? `[${f}]` : f, () => {
					filter = f;
					cursor = 0;
					draw();
				}));
			});
			s.box.appendChild(nav);

			if (list.length) s.box.appendChild(button('VIEW SESSION', () => openAt(cursor), 'terminal-cta'));
			s.box.appendChild(button('BACK', () => finish(undefined), 'terminal-cta'));
		};

		const openAt = async (i) => {
			if (busy || done) return;
			const sess = rows()[i];
			if (!sess) return;
			busy = true;
			s.el.style.display = 'none';
			const r = await runSessionDetail(root, sess.id, { scenes });
			if (r?.revisit) return finish(r.revisit);
			if (r?.deleted) {
				const k = all.findIndex((x) => x.id === r.deleted);
				if (k >= 0) all.splice(k, 1);
			}
			busy = false;
			s.el.style.display = '';
			draw();
		};

		function onKey(e) {
			if (busy) return; // la fiche a ses propres touches
			const list = rows();
			if (e.key === 'ArrowDown' && list.length) {
				e.preventDefault();
				cursor = (cursor + 1) % list.length;
				draw();
			} else if (e.key === 'ArrowUp' && list.length) {
				e.preventDefault();
				cursor = (cursor - 1 + list.length) % list.length;
				draw();
			} else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
				e.preventDefault();
				const d = e.key === 'ArrowRight' ? 1 : -1;
				const i = SESSION_FILTERS.indexOf(filter);
				filter = SESSION_FILTERS[(i + d + SESSION_FILTERS.length) % SESSION_FILTERS.length];
				cursor = 0;
				draw();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				openAt(cursor);
			} else if (e.key === 'Escape' || e.key === 'Backspace') {
				e.preventDefault();
				finish(undefined);
			}
		}
		window.addEventListener('keydown', onKey);

		draw();
	});
}
```

- [ ] **Step 3: Brancher la souche `SESSION LOG` de la Home**

Dans `sim/src/terminal.js`, dans le second `navRow`, remplacer l'entrée `SESSION LOG` :

```js
			['SESSION LOG', async () => {
				s.el.hidden = true;
				const { runSessionLog } = await import('./session-log.js');
				const slug = await runSessionLog(root, { operator: api.getOperator(), scenes });
				if (slug) return fly(slug);
				s.el.hidden = false;
				// Une suppression a pu changer les compteurs du footer.
				render();
			}],
```

- [ ] **Step 4: Vérifier le build**

```bash
cd sim && npm run build && npm run selftest:operator && npm run selftest
```

Attendu : les trois verts.

- [ ] **Step 5: Vérifier à l'œil**

`npm run dev` → Home → `SESSION LOG`. Attendu : la liste, les quatre filtres cliquables et au clavier, `↑`/`↓` qui déplacent le curseur, `Entrée` qui ouvre une fiche, `BACK` qui revient à une Home au footer juste. Console sans erreur.

- [ ] **Step 6: Commit**

```bash
cd sim && git add src/session-log.js src/terminal.js
git commit -m "PHASE 17 : écran SESSION LOG

Liste filtrable (ALL / LANDED / CRASHED / WITH PHOTOS), curseur ↑↓,
←→ change de filtre, Entrée ouvre la fiche. La souche de la Home
disparaît.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: L'écran TARGET LOG et le compte dérivé

**Files:**
- Modify: `sim/src/session-log.js`
- Modify: `sim/src/terminal.js` (souche `TARGET LOG`, helper `stub`)
- Modify: `sim/tools/terminal-model.mjs`
- Modify: `sim/tools/terminal-selftest.mjs`

**Interfaces:**
- Consumes: `targetLogEntries`, `targetRow` (tâche 1).
- Produces: `runTargetLog(root, { operator })` → `Promise<undefined>`.

- [ ] **Step 1: Écrire le test qui échoue**

Dans `sim/tools/terminal-selftest.mjs`, ajouter sous l'import existant :

```js
import { generateTargetScan, resolveTarget } from './target-model.mjs';

const TGT = resolveTarget(generateTargetScan({ seed: 'terminal-seed', count: 3 }), 0);
```

Puis remplacer intégralement le cas `terminalModel : compteurs et dernière session` par :

```js
t('terminalModel : compteurs et dernière session', () => {
	const operator = {
		name: 'Vex',
		// Le Target Log est dérivé des sessions (PHASE 17, spec D1) : la troisième
		// session n'a pas de cible, elle ne compte donc pas comme cible loguée.
		sessions: [
			{ id: 'a', seq: 1, target: TGT, targetSeq: 1 },
			{ id: 'b', area: 'tour-eiffel', seq: 2, target: TGT, targetSeq: 2 },
			{ id: 'c', area: 'tour-eiffel', seq: 3, target: null },
		],
	};
	const scenes = [
		{ slug: 'tour-eiffel', name: 'Tour Eiffel', bytes: 812_000_000 },
		{ slug: 'sacre-coeur', name: 'Sacré-Cœur', bytes: null },
	];
	const m = terminalModel({ operator, scenes });
	assert.equal(m.footer, 'LOCAL INSTALLATION · OPERATOR VEX · 2 LOCAL AREAS · 3 SESSIONS · 2 TARGETS LOGGED');
	assert.deepEqual(m.areas, [
		{ slug: 'tour-eiffel', name: 'Tour Eiffel', size: '812 MB' },
		{ slug: 'sacre-coeur', name: 'Sacré-Cœur', size: '—' },
	]);
	assert.equal(m.lastSession.id, 'c');
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
cd sim && node tools/terminal-selftest.mjs
```

Attendu : `FAIL` sur `2 TARGETS LOGGED` (le modèle compte encore `operator.targetLog`, absent → `0`).

- [ ] **Step 3: Dériver le compte dans `terminal-model.mjs`**

```js
import { targetLogEntries } from './session-log-model.mjs';
```

et remplacer la ligne des cibles :

```js
	// Le Target Log est dérivé des sessions (PHASE 17, spec D1) : il n'y a plus
	// de clé `targetLog` sur l'opérateur.
	const targets = targetLogEntries(operator?.sessions);
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
cd sim && node tools/terminal-selftest.mjs
```

Attendu : vert.

- [ ] **Step 5: Écrire l'écran TARGET LOG**

Ajouter à l'import du modèle dans `sim/src/session-log.js` : `targetLogEntries`, `targetRow`. Puis, à la fin du fichier :

```js
// TARGET LOG (Bible §28, spec D5). Historique en LECTURE SEULE.
//
// Cet écran ne reçoit AUCUNE fonction de navigation vers le vol et n'en
// construit aucune : « aucune interaction du Target Log ne remet un drone en
// vol » (issue #54) est donc vrai par construction, pas par discipline. Ne pas
// y ajouter de bouton qui résout un slug.
export function runTargetLog(root, { operator } = {}) {
	const entries = targetLogEntries(operator?.sessions);
	const s = screen(root);
	const body = entries.length
		? entries.map((e) => `  ${targetRow(e)}`).join('\n')
		: '  NO TARGETS LOGGED';
	s.box.innerHTML = `<pre>TARGET LOG

A TARGET IS A TRACE. A CRASHED TARGET IS LOST, A LANDED ONE IS DONE.

${body}</pre>`;
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			window.removeEventListener('keydown', onKey);
			s.remove();
			resolve(undefined);
		};
		function onKey(e) {
			if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); finish(); }
		}
		window.addEventListener('keydown', onKey);
		s.box.appendChild(button('BACK', finish, 'terminal-cta'));
	});
}
```

- [ ] **Step 6: Brancher la souche `TARGET LOG` et retirer `stub` si elle n'a plus d'appelant**

Dans `sim/src/terminal.js` :

```js
			['TARGET LOG', async () => {
				s.el.hidden = true;
				const { runTargetLog } = await import('./session-log.js');
				await runTargetLog(root, { operator: api.getOperator() });
				s.el.hidden = false;
				render();
			}],
```

Vérifier ensuite les appelants restants de `stub()` :

```bash
cd sim && grep -n "stub(" src/terminal.js
```

`globalScanner` s'en sert pour son message d'erreur — la fonction **reste**. Si le grep ne montre plus que sa définition, la supprimer.

- [ ] **Step 7: Vérifier**

```bash
cd sim && npm run selftest:operator && npm run selftest && npm run build
```

Attendu : les trois verts.

- [ ] **Step 8: Commit**

```bash
cd sim && git add src/session-log.js src/terminal.js tools/terminal-model.mjs tools/terminal-selftest.mjs
git commit -m "PHASE 17 : écran TARGET LOG et compte dérivé

Historique en lecture seule : l'écran ne reçoit aucune fonction de
navigation vers le vol, le critère d'acceptation tient par construction.
Le footer compte les cibles via targetLogEntries(sessions).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Vérification navigateur, documentation, PR

**Files:**
- Modify: `sim/HANDOFF.md`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien de code.

- [ ] **Step 1: Sauvegarder l'état opérateur réel avant de toucher à quoi que ce soit**

La migration v2 réécrit les fichiers opérateur, et cette tâche va supprimer des sessions pour de vrai.

```bash
cd /home/user/Documents/dev/FPVMaps && cp -r operator-state /tmp/operator-state-backup-$(date +%s) && ls /tmp/ | grep operator-state-backup
```

Si le répertoire n'existe pas, le noter et continuer.

- [ ] **Step 2: Lancer toute la chaîne**

```bash
cd sim && npm run selftest && npm run selftest:operator && npm run selftest:api && npm run build
```

Attendu : les quatre verts. Noter les compteurs exacts (`158 checks`, le nombre de tests opérateur, `13 ok` pour l'API) — ils vont dans le HANDOFF.

- [ ] **Step 3: Vérifier au navigateur**

`npm run dev`, puis, sur une scène locale réelle, avec le MCP chrome-devtools (ou un Chromium piloté en CDP si le profil est déjà pris) :

1. Voler deux sessions courtes : une posée avec au moins une capture, une crashée.
2. Home → `SESSION LOG` : les deux entrées, numéros `00001`/`00002` (ou la suite du journal existant), zone, cible, verdict, durée.
3. Les quatre filtres, à la souris **et** au clavier (`←`/`→`) : `LANDED` n'en montre qu'une, `CRASHED` l'autre, `WITH PHOTOS` celle qui a la capture.
4. `Entrée` sur la session posée : le bloc §28 complet, le Randomart, la météo, la vignette de la capture **affichée**.
5. Dans l'onglet réseau : `GET /__operator/<id>` ne contient **aucun** `data:image/` ; `GET /__operator/<id>/sessions/<sid>` en contient un. C'est la preuve mesurée de D4 — la relever, ne pas la supposer.
6. `DELETE SESSION` sur la session crashée → retour à la liste sans elle, `BACK` → Home dont le footer a décrémenté.
7. Rouvrir `SESSION LOG` : le trou de numérotation est visible, les numéros restants n'ont pas bougé.
8. `TARGET LOG` : les cibles des sessions restantes, et **aucun bouton** en dehors de `BACK`.
9. `REVISIT AREA` depuis une fiche → vol : le TARGET SCAN est neuf (autres signaux), le terrain n'est **pas** re-téléchargé (aucune requête `/__map-api/jobs`, chargement de l'ordre de la seconde). C'est le second critère d'acceptation de l'issue.
10. Console sans erreur ni warning sur tout le parcours.

- [ ] **Step 4: Écrire l'état dans le HANDOFF**

Dans `sim/HANDOFF.md`, ajouter une section `**PHASE 17 — Session Log / Target Log (issue #54)**, branche `phase-17-session-log`` dans la liste « Vérifié », sur le modèle des phases 15 et 16. Y mettre :

- les cinq décisions et leur conséquence courte ;
- les chiffres réellement mesurés à l'étape 2 et les observations de l'étape 3 (notamment la preuve réseau de l'élision) ;
- une sous-section **Non vérifié** honnête : au minimum le ressenti (lisibilité du détail, longueur des lignes de liste sur un écran réel), et tout point de l'étape 3 qui n'aurait pas pu être exercé ;
- le **changement cassant** : `SCHEMA_VERSION` 2 — un fichier opérateur écrit par cette branche est refusé par `main` (`409 schemaVersion trop récent`).

- [ ] **Step 5: Ouvrir les issues de suivi**

Pour tout ce qui a été découvert et laissé de côté, créer une issue plutôt qu'un TODO dans le code, et l'ajouter au Project 2 :

```bash
gh issue create --repo lionrayonnant/FPVTP --title "<titre en français>" --body "<contexte>"
```

Candidat déjà connu (à ouvrir si l'étape 3 confirme que c'est gênant) : le stockage des captures en base64 dans le JSON opérateur — D4 traite le symptôme, pas la cause.

- [ ] **Step 6: Commit, push, PR**

```bash
cd /home/user/Documents/dev/FPVMaps && git add sim/HANDOFF.md
git commit -m "PHASE 17 : état vérifié dans le HANDOFF

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin phase-17-session-log
gh pr create --repo lionrayonnant/FPVTP --base main --title "PHASE 17 — Session Log / Target Log (#54)" --body "$(cat <<'BODY'
Ferme #54.

Journal des sessions filtrable, détail par session (Bible §28), Target Log
en lecture seule. Spec : `sim/docs/superpowers/specs/2026-08-29-phase-17-session-log-design.md`.

## Décisions
- **D1** Target Log **dérivé** des sessions ; la clé morte `targetLog` est retirée du schéma.
- **D2** `seq`/`targetSeq` persistés, attribués à l'ouverture, jamais recyclés — une suppression laisse un trou.
- **D3** `DELETE SESSION` franc ; `409` sur une session encore en vol ; le terrain n'est jamais touché.
- **D4** Les `dataUrl` des captures sont élidées de toutes les réponses sauf la nouvelle `GET .../sessions/:sid`.
- **D5** L'écran Target Log ne reçoit aucune fonction de navigation vers le vol.

## Changement cassant
`SCHEMA_VERSION` 1 → 2. Un fichier opérateur écrit par cette branche est refusé
par `main` (`409 schemaVersion trop récent`).

## Vérification
Voir la section PHASE 17 de `sim/HANDOFF.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 7: Fermer l'issue et passer la carte en Done**

```bash
gh issue close 54 --repo lionrayonnant/FPVTP --comment "Livré par la PR ci-dessus."
gh project item-edit --id PVTI_lAHOBlam-M4Bhk9azg4fZS8 --project-id PVT_kwHOBlam-M4Bhk9a --field-id PVTSSF_lAHOBlam-M4Bhk9azhggMQE --single-select-option-id f65968bc
```

(Ne faire cette étape qu'une fois la PR mergée, ou si l'utilisateur demande de fermer à l'ouverture de la PR.)
