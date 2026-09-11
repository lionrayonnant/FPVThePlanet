# Limites de zone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner un bord au monde — le drone ne peut plus sortir de la zone téléchargée sans être averti, retenu, puis perdu, et ne peut plus passer sous la dalle de terrain.

**Architecture:** Un module pur `src/geofence.js` transforme la bbox du manifeste en deux *couloirs* (un horizontal, un vertical) et sort une zone, une force de rappel et une perte de lien. `main.js` obéit : il pousse la force dans Rapier, l'avertissement dans l'OSD, la perte dans `link.js`, et arme `flight-end.js` au bout. Un `src/ground.js` pose un sol lointain sous le maillage pour qu'on ne voie plus de ciel sous le sol.

**Tech Stack:** JavaScript ESM, Three.js, Rapier (WASM), Vite. Tests : `node:assert/strict`, sans navigateur.

**Spec:** [`docs/superpowers/specs/2026-08-30-zone-limits-design.md`](../specs/2026-08-30-zone-limits-design.md) — issue [#139](https://github.com/lionrayonnant/FPVThePlanet/issues/139)

## Global Constraints

- **Modules purs.** `src/geofence.js` n'importe ni THREE, ni Rapier, ni DOM. Même règle que `wind.js`, `fog.js`, `link.js`, `flight-end.js`.
- **Coordonnées ENU locales, en mètres** : X=est, Y=haut, Z=sud.
- **Objets de sortie mutés, jamais recréés** : `this.out` est écrit sur place à chaque frame (patron de `link.out`, `wind.out`, `flightEnd.out`).
- **Le verdict de session reste `LANDED` | `CRASHED`.** Une sortie de zone se solde en `CRASHED`. Ajouter une troisième valeur toucherait `session.js`, `tools/session-log-model.mjs` (`SESSION_FILTERS`), `terminal.js`, `post-flight.js` et la route serveur — hors périmètre.
- **Constantes de `link.js` réutilisées, pas redéfinies** : `KNIFE_EDGE_DB` = 8, `LOSS_CLEAN` = 18, `LOSS_DEAD` = 76. `FENCE_SPAN` = `LOSS_DEAD − LOSS_CLEAN` = 58.
- **Français dans les commentaires neufs**, comme tout le code récent du dépôt.
- **`R_HOLD` et `R_CAUTION` sont mesurés** (tâche 5). Les tâches 1-4 posent des valeurs provisoires **explicitement marquées**, et tous les tests s'écrivent *relativement aux constantes exportées*, jamais sur leurs valeurs littérales — sinon la tâche 5 casse la suite.
- Chaque tâche finit par un commit qui référence `#139`.

## Décomposition en fichiers

| fichier | responsabilité |
|---|---|
| `src/geofence.js` | **nouveau.** Le modèle : couloirs, zones, rappel, perte. Pur. |
| `src/ground.js` | **nouveau.** Le sol lointain. Three seul, aucun modèle. |
| `tools/geofence-selftest.mjs` | **nouveau.** Tests unitaires du modèle (patron de `flight-end-selftest.mjs`). |
| `tools/geofence-measure.mjs` | **nouveau.** Mesure de `R_HOLD` dans le vrai Rapier (patron de `landing-selftest.mjs`). |
| `src/link.js` | `setTerminalLoss(db)` — un canal hors borne #79. |
| `src/flight-end.js` | `FENCE_TIMELINE` + entrée `outOfZone`. |
| `src/entry-state.js` | `EDGE_MARGIN` local → `R_CAUTION` importé. |
| `src/main.js` | le câblage. |
| `tools/selftest.mjs` | la vérification par scène (points d'entrée en `NOMINAL`). |
| `README.md` | la section « Limites de zone ». |

---

### Task 1 : le modèle — couloirs, marges, zones

**Files:**
- Create: `sim/src/geofence.js`
- Create: `sim/tools/geofence-selftest.mjs`

**Interfaces:**
- Consumes: `manifest.bbox` = `{ min: [x,y,z], max: [x,y,z] }`.
- Produces:
  - `class Geofence { constructor(bbox); update({x,y,z}) → this.out }`
  - `out = { zone, marginM, t, push: {x,y,z}, lossDb, warning, over }`
  - constantes : `NOMINAL`, `CAUTION`, `HOLD`, `LOST` (chaînes) ; `R_CAUTION`, `R_HOLD`, `FLOOR_CAUTION`, `FLOOR_HOLD`, `FLOOR_LOST`, `A_MAX`, `HYST`, `FENCE_SPAN`
  - `export function horizontalMargin(p, bbox)` et `export function verticalMargin(p, bbox)`, exportées pour les tests

**Le modèle en une phrase.** Deux couloirs indépendants. Chacun est décrit par
quatre distances en *marge* (positive = sûr, décroissante vers le danger) :
`caution` (entrée de l'avertissement), `hold` (entrée du rappel), `edge` (le
bord des données), `lost` (fin de session). Chaque couloir produit une zone,
une poussée et une perte ; on garde la pire zone, on somme les poussées (elles
sont orthogonales), on garde la pire perte.

| couloir | marge | caution | hold | edge | lost |
|---|---|---|---|---|---|
| horizontal | distance à la face la plus proche de la bbox, signée | `R_CAUTION` | `R_HOLD` | `0` | `−R_HOLD` |
| vertical | `y − bbox.min.y` | `−2` | `−5` | `−8` | `−10` |

Le couloir vertical est entièrement **sous** `bbox.min.y`, qui est le minimum
de tout le maillage : on ne peut y être qu'en étant sous la dalle. Mettre son
`caution` au-dessus pousserait le drone vers le haut au point le plus bas de
la carte — la Seine sur `ile-de-la-cite` — où voler à deux mètres de l'eau est
normal.

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `sim/tools/geofence-selftest.mjs` :

```js
// Selftest du modèle de limites de zone (issue #139). Aucun DOM, aucun
// Rapier : une bbox synthétique et des points qu'on place à la main.
// Lancer : node tools/geofence-selftest.mjs
import assert from 'node:assert/strict';
import {
	Geofence, horizontalMargin, verticalMargin,
	NOMINAL, CAUTION, HOLD, LOST,
	R_CAUTION, R_HOLD, FLOOR_CAUTION, FLOOR_HOLD, FLOOR_EDGE, FLOOR_LOST,
} from '../src/geofence.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Une bbox carrée et généreuse : 2000 m de côté, 300 m de haut, centrée sur
// l'origine en X/Z. Assez grande pour que les couloirs (dizaines de mètres)
// ne se touchent jamais au centre.
const BBOX = { min: [-1000, -30, -1000], max: [1000, 270, 1000] };
const at = (x, y, z) => ({ x, y, z });
// Un point franchement au milieu, à mi-hauteur : la référence « tout va bien ».
const MIDDLE = at(0, 100, 0);

t('la marge horizontale est la distance à la face la plus proche', () => {
	assert.equal(horizontalMargin(at(0, 100, 0), BBOX), 1000);
	assert.equal(horizontalMargin(at(900, 100, 0), BBOX), 100);
	assert.equal(horizontalMargin(at(0, 100, -950), BBOX), 50);
	// Dehors : négative, et c'est la vraie distance euclidienne au bord.
	assert.equal(horizontalMargin(at(1030, 100, 0), BBOX), -30);
	// Dehors par un coin : la diagonale, pas le min des deux axes.
	assert.ok(Math.abs(horizontalMargin(at(1030, 100, 1040), BBOX) - -50) < 1e-9);
});

t('la marge verticale se compte depuis le point le plus bas du maillage', () => {
	assert.equal(verticalMargin(at(0, -30, 0), BBOX), 0);
	assert.equal(verticalMargin(at(0, 100, 0), BBOX), 130);
	assert.equal(verticalMargin(at(0, -36, 0), BBOX), -6);
});

t('au milieu : rien du tout', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.zone, NOMINAL);
	assert.equal(f.out.warning, '');
	assert.equal(f.out.lossDb, 0);
	assert.deepEqual(f.out.push, { x: 0, y: 0, z: 0 });
});

t('les quatre zones horizontales, dans l ordre', () => {
	const f = new Geofence(BBOX);
	const zoneAtMargin = (m) => { f.update(at(1000 - m, 100, 0)); return f.out.zone; };
	assert.equal(zoneAtMargin(R_CAUTION + 10), NOMINAL);
	assert.equal(zoneAtMargin((R_CAUTION + R_HOLD) / 2), CAUTION);
	assert.equal(zoneAtMargin(R_HOLD / 2), HOLD);
	assert.equal(zoneAtMargin(-1), LOST);
});

t('les quatre zones verticales, toutes sous le minimum du maillage', () => {
	const f = new Geofence(BBOX);
	const zoneAtY = (y) => { f.update(at(0, y, 0)); return f.out.zone; };
	const FLOOR = BBOX.min[1];
	assert.equal(zoneAtY(FLOOR + 1), NOMINAL, 'posé sur le point le plus bas : normal');
	assert.equal(zoneAtY(FLOOR - (FLOOR_CAUTION + FLOOR_HOLD) / 2), CAUTION);
	assert.equal(zoneAtY(FLOOR - (FLOOR_HOLD + FLOOR_LOST) / 2), HOLD);
	assert.equal(zoneAtY(FLOOR - FLOOR_LOST - 1), LOST);
});

t('la pire des deux zones gagne', () => {
	const f = new Geofence(BBOX);
	// Horizontalement en CAUTION, verticalement en HOLD : c'est HOLD.
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, BBOX.min[1] - (FLOOR_HOLD + FLOOR_LOST) / 2, 0));
	assert.equal(f.out.zone, HOLD);
});

t('l hystérésis : aucun aller-retour ne double une transition', () => {
	const f = new Geofence(BBOX);
	// On oscille autour de la frontière NOMINAL/CAUTION avec une amplitude
	// plus petite que l'hystérésis : la zone ne doit changer qu'une fois.
	const seen = [];
	let prev = null;
	for (let i = 0; i < 200; i++) {
		const m = R_CAUTION - 0.02 * (i % 2 === 0 ? 1 : -1);
		f.update(at(1000 - m, 100, 0));
		if (f.out.zone !== prev) { seen.push(f.out.zone); prev = f.out.zone; }
	}
	assert.equal(seen.length, 1, `strobe : ${seen.join(' → ')}`);
});

t('l avertissement suit la zone', () => {
	const f = new Geofence(BBOX);
	f.update(MIDDLE);
	assert.equal(f.out.warning, '');
	f.update(at(1000 - (R_CAUTION + R_HOLD) / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
	f.update(at(1000 - R_HOLD / 2, 100, 0));
	assert.equal(f.out.warning, 'NO COVERAGE');
});

t('over : vrai seulement une fois la session perdue', () => {
	const f = new Geofence(BBOX);
	f.update(at(1000 - 1, 100, 0));
	assert.equal(f.out.over, false);
	f.update(at(1000 + R_HOLD * 0.5, 100, 0));
	assert.equal(f.out.over, false, 'dehors mais pas encore au bout du couloir');
	f.update(at(1000 + R_HOLD + 1, 100, 0));
	assert.equal(f.out.over, true);
});

console.log(`\n${n} vérifications OK`);
```

- [ ] **Step 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd sim && node tools/geofence-selftest.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` — `src/geofence.js` n'existe pas.

- [ ] **Step 3 : écrire `src/geofence.js`**

```js
// Les limites de la zone (issue #139) : où le monde s'arrête, et ce qui
// arrive quand on y va.
//
// Ni THREE, ni Rapier, ni DOM — même règle et même raison que wind.js,
// fog.js, link.js et flight-end.js : c'est la moitié que
// tools/geofence-selftest.mjs peut vérifier sans navigateur. Qui pousse la
// force dans Rapier, l'avertissement dans l'OSD et la perte dans le budget de
// liaison est le problème de main.js.
//
// La fiction n'est pas la portée radio, c'est LA ZONE SCANNÉE : le joueur a
// dessiné ce rectangle lui-même dans le Global Scanner, et hors de lui il n'y
// a pas de données — donc pas de couverture, donc pas de lien. Une portée
// radio aurait été un cercle centré sur le pilote, or le spawn n'est pas
// centré dans la bbox (sur tour-eiffel il est à (−120, 140) dans une boîte de
// ±642 m) : le cercle inscrit gaspillerait la moitié de la carte, le
// circonscrit déborderait dans le vide.

export const NOMINAL = 'NOMINAL';
export const CAUTION = 'CAUTION';   // averti
export const HOLD = 'HOLD';         // averti et retenu
export const LOST = 'LOST';         // dehors ; l'image est en train de mourir

// PROVISOIRE — remplacé par tools/geofence-measure.mjs (tâche 5 du plan).
// Ne pas écrire de test sur ces valeurs littérales : les tests se réfèrent aux
// constantes, jamais à leurs nombres.
export const R_HOLD = 40;      // m : distance d'arrêt, manches au neutre
export const R_CAUTION = 85;   // m : R_HOLD + 1,5 s à la vitesse maximale

// Le couloir vertical, lui, ne se mesure pas — et c'est délibéré. Une distance
// d'arrêt n'a pas de sens ici : on n'arrive pas sous la dalle en fonçant, on y
// arrive en se faufilant. Ces trois nombres sont posés sur un argument
// géométrique : deux mètres sous la surface la PLUS BASSE de la carte, on est
// forcément sous quelque chose. Il n'y a aucun faux positif à écarter, donc
// rien à séparer, donc rien à mesurer.
//
// Le signe est ce qui compte le plus dans ce fichier. Tout le couloir est SOUS
// bbox.min.y. Le poser au-dessus pousserait le drone vers le haut au point le
// plus bas de la carte — la surface de la Seine sur ile-de-la-cite, où voler à
// deux mètres de l'eau est un vol parfaitement normal.
export const FLOOR_CAUTION = 2;   // m sous bbox.min.y : l'avertissement
export const FLOOR_HOLD = 5;      // le rappel vers le haut commence
export const FLOOR_EDGE = 8;      // le rappel est plein, la perte s'emballe
export const FLOOR_LOST = 10;     // fin de session

// Le rappel, en m/s². 60 % de ce que le drone dépense simplement à tenir un
// stationnaire. Ce chiffre est choisi, et il est choisi pour ce qu'il NE fait
// PAS : il ne dépasse pas la poussée disponible. Un pilote qui lâche les
// manches est ramené ; un pilote qui insiste plein gaz passe, et perd sa
// session. Ce n'est pas un mur, c'est le failsafe du drone qui se bat contre
// toi — un comportement qu'un pilote FPV reconnaît.
export const A_MAX = 0.6 * 9.81;

// Hystérésis sur les frontières de zone, en fraction de la marge du seuil.
// Sans elle, un stationnaire tenu pile sur R_CAUTION fait strober
// l'avertissement de l'OSD. link.js a exactement ce problème et exactement
// cette réponse (FREEZE_ENTER / FREEZE_LEAVE, et son commentaire : « at a
// single threshold the picture strobes between frozen and clean while you
// hover on the boundary »).
//
// 15 % est posé et n'a pas besoin d'être mieux : il suffit que l'écart dépasse
// la dérive d'un stationnaire tenu, qui se compte en dizaines de centimètres
// quand R_CAUTION se compte en dizaines de mètres. Il n'y a pas deux ordres de
// grandeur à arbitrer.
export const HYST = 0.15;

// Le budget que la clôture dépense, en dB. LOSS_DEAD − LOSS_CLEAN de link.js :
// c'est, par construction, ce qui emmène N'IMPORTE QUEL lien, si propre
// soit-il, de parfait à mort. Dupliqué plutôt qu'importé pour garder ce
// fichier sans dépendance ; tools/geofence-selftest.mjs vérifie l'égalité.
export const FENCE_SPAN = 58;
// Ce que la clôture dépense AVANT le bord, pendant l'avertissement. C'est
// KNIFE_EDGE_DB de link.js : le plus petit incident que le modèle juge
// significatif — assez pour se lire comme une dégradation, pas assez pour
// compter. C'est le principe déjà écrit dans link.js : « you are told you are
// running out of margin before you run out. »
export const FENCE_WARN_DB = 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// La marge horizontale : positive dedans, négative dehors, et dehors c'est la
// VRAIE distance euclidienne au bord — pas le min des deux axes, qui
// sous-estimerait la sortie par un coin.
export function horizontalMargin(p, bbox) {
	const dx = Math.max(bbox.min[0] - p.x, p.x - bbox.max[0]);
	const dz = Math.max(bbox.min[2] - p.z, p.z - bbox.max[2]);
	if (dx <= 0 && dz <= 0) return -Math.max(dx, dz);   // dedans
	return -Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

// La marge verticale se compte depuis le point le plus bas du maillage, pas
// depuis le plancher du couloir : c'est ce repère-là qui a un sens physique.
export function verticalMargin(p, bbox) {
	return p.y - bbox.min[1];
}

// Un couloir : quatre marges décroissantes vers le danger. `edge` est le bord
// des données, `lost` la fin de session.
function corridor(caution, hold, edge, lost) {
	return { caution, hold, edge, lost };
}

// Où l'on en est dans un couloir : 0 à l'entrée de `caution`, 1 à `lost`.
// Au-delà de 1 la valeur continue de croître — main.js s'en sert pour savoir
// de combien on a dépassé.
function progress(margin, c) {
	return (c.caution - margin) / (c.caution - c.lost);
}

function zoneOf(margin, c, previous) {
	// Hystérésis sur LES TROIS frontières, pas seulement les deux du dedans :
	// on peut aussi bien osciller autour du bord des données qu'autour de
	// l'entrée en avertissement. Un seuil est un peu plus haut pour SORTIR
	// d'une zone que pour y entrer — « plus haut » au sens de la marge, donc
	// il faut revenir un peu plus loin dans le sûr qu'on n'est allé dans le
	// danger.
	const span = Math.abs(c.caution - c.lost) * HYST;
	const w = (thr, current) => (previous === current ? thr + span : thr);
	if (margin < w(c.edge, LOST)) return LOST;
	if (margin <= w(c.hold, HOLD)) return HOLD;
	if (margin <= w(c.caution, CAUTION)) return CAUTION;
	return NOMINAL;
}

// La perte de la clôture, en dB, en fonction de l'avancement dans le couloir.
// Deux segments, et aucun des deux n'invente son nombre :
//   - de `caution` à `edge` : FENCE_WARN_DB, l'avertissement ;
//   - de `edge` à `lost`    : le reste du budget, soit la mort de l'image
//     exactement au mètre où la session s'arrête.
// La symétrie est voulue : la distance qu'il faut pour s'arrêter est
// exactement celle que l'image coûte.
function lossOf(margin, c) {
	if (margin >= c.caution) return 0;
	if (margin >= c.edge) {
		const u = (c.caution - margin) / (c.caution - c.edge);
		return FENCE_WARN_DB * u;
	}
	const u = clamp01((c.edge - margin) / (c.edge - c.lost));
	return FENCE_WARN_DB + (FENCE_SPAN - FENCE_WARN_DB) * u;
}

// L'amplitude du rappel : nulle à l'entrée en HOLD, pleine au bord, et
// constante au-delà. Continue en `hold`, donc pas d'à-coup à l'entrée.
function pushOf(margin, c) {
	if (margin >= c.hold) return 0;
	if (margin <= c.edge) return A_MAX;
	return A_MAX * (c.hold - margin) / (c.hold - c.edge);
}

const RANK = { [NOMINAL]: 0, [CAUTION]: 1, [HOLD]: 2, [LOST]: 3 };

export class Geofence {
	constructor(bbox) {
		this.bbox = bbox;
		this.h = corridor(R_CAUTION, R_HOLD, 0, -R_HOLD);
		// Marges relatives à bbox.min.y, donc toutes négatives : le couloir est
		// entièrement sous le point le plus bas du maillage.
		this.v = corridor(-FLOOR_CAUTION, -FLOOR_HOLD, -FLOOR_EDGE, -FLOOR_LOST);
		// Muté chaque frame plutôt que recréé, comme link.out et flightEnd.out :
		// ceci tourne à la fréquence d'affichage.
		this.out = {
			zone: NOMINAL, marginM: Infinity, t: 0,
			push: { x: 0, y: 0, z: 0 }, lossDb: 0, warning: '', over: false,
		};
		this.reset();
	}

	reset() {
		this._zoneH = NOMINAL;
		this._zoneV = NOMINAL;
		const o = this.out;
		o.zone = NOMINAL; o.marginM = Infinity; o.t = 0;
		o.push.x = 0; o.push.y = 0; o.push.z = 0;
		o.lossDb = 0; o.warning = ''; o.over = false;
	}

	update(p) {
		const b = this.bbox;
		const mH = horizontalMargin(p, b);
		const mV = verticalMargin(p, b);

		this._zoneH = zoneOf(mH, this.h, this._zoneH);
		this._zoneV = zoneOf(mV, this.v, this._zoneV);

		const o = this.out;
		o.zone = RANK[this._zoneV] > RANK[this._zoneH] ? this._zoneV : this._zoneH;
		o.marginM = Math.min(mH, mV - this.v.edge);
		o.t = Math.max(progress(mH, this.h), progress(mV, this.v));
		o.lossDb = Math.max(lossOf(mH, this.h), lossOf(mV, this.v));
		o.warning = o.zone === NOMINAL ? '' : 'NO COVERAGE';
		o.over = mH < this.h.lost || mV < this.v.lost;

		// Les deux poussées sont orthogonales : on les somme sans arbitrer.
		// L'horizontale pointe vers l'intérieur le long de la normale de la
		// face la plus proche ; la verticale est toujours vers le haut.
		const aH = pushOf(mH, this.h);
		if (aH > 0) {
			const n = this._inwardNormal(p);
			o.push.x = n.x * aH;
			o.push.z = n.z * aH;
		} else {
			o.push.x = 0; o.push.z = 0;
		}
		o.push.y = pushOf(mV, this.v);
		return o;
	}

	// La normale rentrante, en X/Z. Dedans, c'est celle de la face la plus
	// proche ; dehors, c'est la direction du point le plus proche de la boîte,
	// ce qui recolle proprement dans les coins.
	_inwardNormal(p) {
		const b = this.bbox;
		const cx = Math.min(Math.max(p.x, b.min[0]), b.max[0]);
		const cz = Math.min(Math.max(p.z, b.min[2]), b.max[2]);
		if (cx !== p.x || cz !== p.z) {
			const dx = cx - p.x, dz = cz - p.z;
			const len = Math.hypot(dx, dz) || 1;
			return { x: dx / len, z: dz / len };
		}
		// Dedans : la face la plus proche, une seule composante.
		const d = [
			[p.x - b.min[0], 1, 0], [b.max[0] - p.x, -1, 0],
			[p.z - b.min[2], 0, 1], [b.max[2] - p.z, 0, -1],
		];
		d.sort((a, c) => a[0] - c[0]);
		return { x: d[0][1], z: d[0][2] };
	}
}
```

- [ ] **Step 4 : lancer les tests jusqu'au vert**

```bash
cd sim && node tools/geofence-selftest.mjs
```

Attendu : `9 vérifications OK`, sortie 0.

- [ ] **Step 5 : brancher le selftest sur `npm run selftest:operator`**

Dans `sim/package.json`, ajouter ` && node tools/geofence-selftest.mjs` à la fin du script `selftest:operator`.

```bash
cd sim && npm run selftest:operator 2>&1 | tail -20
```

Attendu : la ligne `9 vérifications OK` apparaît, et le script sort en 0.

- [ ] **Step 6 : commit**

```bash
git add sim/src/geofence.js sim/tools/geofence-selftest.mjs sim/package.json
git commit -m "feat(geofence): le modèle de limites de zone (#139)"
```

---

### Task 2 : le canal terminal de `link.js`

**Files:**
- Modify: `sim/src/link.js` (constructeur, `reset()`, `update()` — la fin, après la borne #79)
- Modify: `sim/tools/geofence-selftest.mjs` (ajouts en fin de fichier)

**Interfaces:**
- Consumes: `Geofence.out.lossDb` (tâche 1)
- Produces: `VideoLink.prototype.setTerminalLoss(db)` — la perte est appliquée **après** la borne de jouabilité, sur la sortie, sans lissage.

**Pourquoi un canal séparé.** La borne de l'issue #79 (`link.js:172-182`)
écrête `this._loss` lui-même et replaque la qualité à `COOLDOWN_FLOOR_Q` = 0,30
après 2 s d'écran noir. Une perte de clôture routée par le chemin ordinaire
serait donc **annulée** : on sortirait de la zone, l'écran mourrait deux
secondes, puis reviendrait à 0,30 pendant 25 s. Cette borne existe pour qu'on
ne reste jamais coincé aveugle *en vol* — or ici on ne vole plus.

Pas de lissage non plus : `TAU_FALL`/`TAU_RISE` existent parce que la géométrie
des obstacles est une fonction en escalier. Une position ne l'est pas — la
perte de clôture varie déjà continûment avec le mètre parcouru.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à la fin de `sim/tools/geofence-selftest.mjs`, avant le `console.log`
final, et compléter l'import du haut :

```js
// (en haut du fichier, après l'import de geofence.js)
import { VideoLink } from '../src/link.js';
```

```js
// --- Le canal terminal de link.js -----------------------------------------

// Une frame de lien parfait : à dix mètres, rien dans le chemin.
const CLEAR = { distance: 10, blocked: false, span: 0, dt: 1 / 60 };

t('sans perte terminale, link.js est intact', () => {
	const l = new VideoLink();
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('la perte terminale tue l image', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
});

t('la borne de jouabilité #79 ne relève JAMAIS une perte terminale', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	// 30 s : bien au-delà de BLACKOUT_MAX_S (2 s), donc la borne a eu tout le
	// temps de s'armer et de replaquer la qualité à COOLDOWN_FLOOR_Q.
	let worst = 0;
	for (let i = 0; i < 30 * 60; i++) {
		l.update(CLEAR);
		worst = Math.max(worst, l.out.quality);
	}
	assert.equal(worst, 0, `la borne #79 a relevé l image à ${worst}`);
});

t('la perte terminale se retire', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
	l.setTerminalLoss(0);
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('reset() efface la perte terminale', () => {
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	l.reset();
	l.update(CLEAR);
	assert.equal(l.out.quality, 1);
});

t('FENCE_SPAN vaut bien LOSS_DEAD − LOSS_CLEAN de link.js', () => {
	// Le lien est propre ; on lui ajoute exactement FENCE_SPAN. Si la constante
	// dupliquée dans geofence.js a dérivé de celle de link.js, la qualité ne
	// tombe pas pile à zéro.
	const l = new VideoLink();
	l.setTerminalLoss(FENCE_SPAN);
	l.update(CLEAR);
	assert.equal(l.out.quality, 0);
	const m = new VideoLink();
	m.setTerminalLoss(FENCE_SPAN - 0.5);
	m.update(CLEAR);
	assert.ok(m.out.quality > 0, 'un demi-dB de moins doit laisser une image');
});
```

Ajouter `FENCE_SPAN` à l'import depuis `../src/geofence.js`.

- [ ] **Step 2 : lancer pour vérifier l'échec**

```bash
cd sim && node tools/geofence-selftest.mjs
```

Attendu : `TypeError: l.setTerminalLoss is not a function`.

- [ ] **Step 3 : implémenter dans `src/link.js`**

Dans le constructeur, juste après `this._baseLoss = 0;` :

```js
		// La perte de la clôture de zone (#139). Elle NE PASSE PAS par _loss,
		// et c'est tout l'intérêt : la borne de jouabilité de l'issue #79
		// écrête _loss et replaque la qualité à COOLDOWN_FLOOR_Q après deux
		// secondes d'écran noir. Cette borne existe pour qu'on ne reste jamais
		// coincé aveugle EN VOL — or sortir de la zone n'est pas voler, c'est
		// la fin de la session. Appliquée en sortie, après la borne.
		this._terminalLoss = 0;
```

Dans `reset()`, après `this._cooldownT = 0;` :

```js
		this._terminalLoss = 0;
```

Une méthode, à côté de `setSignal()` :

```js
	// La perte de la clôture de zone (#139), en dB. Pas de lissage : TAU_FALL
	// et TAU_RISE existent parce que la géométrie des obstacles est une
	// fonction en escalier, or une position ne l'est pas — cette perte varie
	// déjà continûment avec le mètre parcouru.
	setTerminalLoss(db) {
		this._terminalLoss = Number.isFinite(db) ? Math.max(0, db) : 0;
	}
```

Dans `update()`, **après** tout le bloc de la borne #79 et **avant** le calcul
de `const loss = ...`, remplacer :

```js
		const loss = Math.max(0, this._loss + this._noise * this.severity);
```

par :

```js
		// La clôture s'ajoute ici, en aval de la borne #79 : elle n'est pas une
		// nuisance à lisser, elle est la fin de la session.
		const loss = Math.max(0, this._loss + this._noise * this.severity) + this._terminalLoss;
		if (this._terminalLoss > 0) quality = Math.min(quality, qualityOf(loss));
```

et rendre `quality` réassignable si ce n'est déjà fait (il est déjà déclaré
`let quality`, ligne ~170).

- [ ] **Step 4 : lancer jusqu'au vert**

```bash
cd sim && node tools/geofence-selftest.mjs && node tools/selftest.mjs 2>&1 | tail -5
```

Attendu : les 15 vérifications OK, **et** `tools/selftest.mjs` toujours au vert
(il exerce déjà `VideoLink` — aucune régression permise).

- [ ] **Step 5 : commit**

```bash
git add sim/src/link.js sim/tools/geofence-selftest.mjs
git commit -m "feat(link): canal de perte terminale, hors borne de jouabilité #79 (#139)"
```

---

### Task 3 : `FENCE_TIMELINE` dans `flight-end.js`

**Files:**
- Modify: `sim/src/flight-end.js` (nouvelle table, constructeur, `update()`)
- Modify: `sim/tools/flight-end-selftest.mjs` (ajouts)

**Interfaces:**
- Consumes: `Geofence.out.over` (tâche 1)
- Produces: `FENCE_TIMELINE` exportée ; `FlightEnd.update({ ..., outOfZone: false })` ; `out.closes === 'CRASHED'` inchangé.

**Pourquoi une troisième table.** `TIMELINE` commence par 0,9 s d'image morte
laissée à l'écran (`blackoutAt`), ce qui suppose un impact : il y a une épave
qui roule et on la regarde. Une sortie de zone n'a pas d'impact — l'image est
déjà morte, progressivement, sur les derniers mètres. Il n'y a rien à laisser
pourrir. La table est donc plus proche de `LANDING_TIMELINE` dans l'esprit : le
noir monte tout de suite, et la première ligne nomme la cause.

Le verdict de session reste `CRASHED` : le drone est perdu, c'est le même
seau. Une troisième valeur toucherait `session.js`, `SESSION_FILTERS`,
`terminal.js`, `post-flight.js` et la route serveur — hors périmètre.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à `sim/tools/flight-end-selftest.mjs`, et compléter l'import du haut
avec `FENCE_TIMELINE` :

```js
t('sortie de zone : CRASHING, image morte, verdict CRASHED', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	assert.equal(fe.phase, CRASHING);
	assert.equal(fe.out.linkDead, true);
	assert.equal(fe.out.closes, 'CRASHED');
});

t('sortie de zone : la table de la clôture, pas celle du crash', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	advance(fe, FENCE_TIMELINE.exitAt + 0.2, { outOfZone: true });
	assert.deepEqual(
		fe.out.lines,
		FENCE_TIMELINE.lines.map(([, text]) => text),
	);
	assert.equal(fe.out.exitArmed, true);
});

t('la clôture noircit plus tôt que le crash : pas d épave à regarder', () => {
	assert.ok(FENCE_TIMELINE.blackoutAt < TIMELINE.blackoutAt);
});

t('la première ligne de la clôture nomme la cause', () => {
	assert.equal(FENCE_TIMELINE.lines[0][1], 'OUT OF COVERAGE');
});

t('un crash pendant une sortie de zone ne rejoue pas la séquence', () => {
	const fe = new FlightEnd();
	fe.update(frame({ outOfZone: true }));
	const first = fe.out.lines.length;
	fe.update(frame({ crashed: true }));
	assert.equal(fe.phase, CRASHING);
	assert.ok(fe.out.lines.length >= first);
	assert.equal(fe.out.closes, null, 'closes ne se déclenche qu une fois');
});
```

- [ ] **Step 2 : lancer pour vérifier l'échec**

```bash
cd sim && node tools/flight-end-selftest.mjs
```

Attendu : `SyntaxError` sur l'import de `FENCE_TIMELINE`.

- [ ] **Step 3 : implémenter**

Dans `src/flight-end.js`, après `LANDING_TIMELINE` :

```js
// Troisième table : la sortie de zone (#139). TIMELINE commence par 0,9 s
// d'image morte laissée à l'écran, ce qui suppose un impact — une épave qui
// roule, et qu'on regarde. Une sortie de zone n'en a pas : l'image est déjà
// morte, progressivement, sur les derniers mètres du couloir. Il n'y a rien à
// laisser pourrir, donc le noir monte tout de suite, et la première ligne
// nomme la cause plutôt que de la faire deviner.
// Mise en scène, pas mesure — comme les deux tables au-dessus.
export const FENCE_TIMELINE = {
	blackoutAt: 0.3,
	blackoutFade: 0.5,
	lines: [
		[0, 'OUT OF COVERAGE'],
		[1.2, ''],
		[1.2, 'SIGNAL LOST'],
		[2.0, 'SESSION TERMINATED'],
		[3.0, ''],
		[3.0, '[ENTER] DISCONNECT'],
	],
	exitAt: 3.0,
};
```

Dans le constructeur, ajouter le paramètre :

```js
	constructor({ timeline = TIMELINE, landingTimeline = LANDING_TIMELINE,
	              fenceTimeline = FENCE_TIMELINE, landing = LANDING } = {}) {
		this.timeline = timeline;
		this.landingTimeline = landingTimeline;
		this.fenceTimeline = fenceTimeline;
```

Dans `update()`, changer la signature et le bloc d'armement :

```js
	update({ dt = 0, armed = false, height = Infinity, speed = 0,
	         angularSpeed = 0, throttle = 0, crashed = false,
	         outOfZone = false } = {}) {
```

puis, remplacer le bloc `if (crashed && ...)` par :

```js
		// Deux causes, une seule phase : l'écran meurt de la même façon, seule
		// la table change. `outOfZone` passe en premier — si les deux arrivent
		// sur la même frame (on percute une façade en franchissant le bord),
		// c'est la sortie qui est l'événement, pas le choc.
		const ends = outOfZone || crashed;
		if (ends && this._phase !== CRASHING && this._phase !== TERMINATED
			&& this._phase !== LANDED) {
			this._phase = CRASHING;
			this._t = 0;
			this._hold = 0;
			this._activeTimeline = outOfZone ? this.fenceTimeline : this.timeline;
			o.lines.length = 0;
			// L'image meurt à l'instant du choc, avant tout texte.
			o.linkDead = true;
			o.closes = 'CRASHED';
		}
```

- [ ] **Step 4 : lancer jusqu'au vert**

```bash
cd sim && node tools/flight-end-selftest.mjs && node tools/landing-selftest.mjs 2>&1 | tail -5
```

Attendu : les deux au vert. `landing-selftest.mjs` doit rester intact —
les seuils de pose ne bougent pas.

- [ ] **Step 5 : commit**

```bash
git add sim/src/flight-end.js sim/tools/flight-end-selftest.mjs
git commit -m "feat(flight-end): FENCE_TIMELINE pour la sortie de zone (#139)"
```

---

### Task 4 : mesurer `R_HOLD` et `R_CAUTION`

**Files:**
- Create: `sim/tools/geofence-measure.mjs`
- Modify: `sim/src/geofence.js` (remplacer les deux constantes provisoires)

**Interfaces:**
- Consumes: `Geofence` et `A_MAX` (tâche 1) ; `Physics`, `FlightController`, `PROFILES`/`FAMILIES`.
- Produces: les valeurs mesurées de `R_HOLD` et `R_CAUTION`, avec le chiffre et la date en commentaire — comme les seuils de pose de `flight-end.js`.

**Le protocole.** Pour chaque famille de `drone-profiles.js` : le drone est
lancé horizontalement à sa vitesse en palier maximale, droit vers une face. À
l'entrée en `HOLD` les manches reviennent au neutre — le pilote a lu
l'avertissement et a lâché — et seuls le rappel plafonné (`A_MAX`) et la
traînée propre de `quad.js` le décélèrent. On mesure la pénétration maximale.

Manches au neutre et non tirées à fond, délibérément : un pilote qui insiste
**doit** pouvoir passer, c'est la moitié du design. `R_HOLD` dimensionne le cas
où on obéit, pas le cas où on désobéit.

`R_CAUTION = R_HOLD + 1,5 s × vitesse max`. Le délai est de la mise en scène et
s'assume comme telle, mais il s'ancre sur une constante du dépôt :
`BLINK_PERIOD_MS` = 500 ms (`drone-osd.js:51`). Un avertissement doit clignoter
trois fois pour être lu.

- [ ] **Step 1 : écrire le harnais de mesure**

Créer `sim/tools/geofence-measure.mjs`, sur le patron de
`tools/landing-selftest.mjs` (mêmes 20 premières lignes pour charger la scène
et Rapier) :

```js
// Mesure la distance d'arrêt sous le rappel de la clôture (issue #139), pour
// chaque famille de drone, et en déduit R_HOLD et R_CAUTION.
//
//   node tools/geofence-measure.mjs [sceneDir]
//
// CLAUDE.md : mesurés, pas choisis à la main. Le protocole : le drone fonce à
// sa vitesse en palier maximale droit vers une face ; à l'entrée en HOLD les
// manches reviennent au neutre (le pilote a lu l'avertissement et a lâché) ;
// seuls A_MAX et la traînée de quad.js décélèrent. On mesure la pénétration.
//
// Manches au NEUTRE et non tirées à fond, délibérément : un pilote qui insiste
// doit pouvoir passer, c'est la moitié du design. R_HOLD dimensionne le cas où
// on obéit, pas le cas où on désobéit.
import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics } from '../src/physics.js';
import { FlightController } from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { Geofence, A_MAX, HOLD, LOST, R_HOLD } from '../src/geofence.js';

const sceneDir = path.resolve(process.argv[2] ?? 'public/scenes/tour-eiffel');
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
const BLINK_PERIOD_S = 0.5;   // drone-osd.js:51
const BLINKS_TO_READ = 3;

const LEVEL = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

// Place le corps, à plat, à la vitesse voulue. Mêmes appels que
// tools/landing-selftest.mjs:place() — il n'existe pas de `teleport`.
function place(pos, vel) {
	phys.body.setTranslation(pos, true);
	phys.body.setRotation(LEVEL, true);
	phys.body.setLinvel(vel, true);
	phys.body.setAngvel(ZERO, true);
	phys.setGroundHold(false);
}

// La vitesse en palier maximale d'un profil : on pousse tangage plein et on
// laisse la traînée trouver son équilibre, en l'air, loin de tout.
function topSpeed(family) {
	phys.setProfile(PROFILES[family]);
	const fc = new FlightController();
	fc.arm();
	phys.setWind(ZERO, 0);
	place({ x: 0, y: manifest.bbox.max[1] + 200, z: 0 }, ZERO);
	let v = 0;
	for (let i = 0; i < 25 * 250; i++) {
		const sticks = { throttle: 0.75, roll: 0, pitch: 1, yaw: 0 };
		// fc.update(sticks, phys, dt) rend { motors }, et step prend
		// (motors, dt) dans CET ordre.
		const { motors } = fc.update(sticks, phys, STEP);
		phys.step(motors, STEP);
		const s = phys.velocity;
		v = Math.max(v, Math.hypot(s.x, s.z));
	}
	return v;
}

// La pénétration : lancé à `speed` droit vers la face +X, manches au neutre
// dès HOLD, seul le rappel décélère.
function penetration(family, speed, fence) {
	phys.setProfile(PROFILES[family]);
	const fc = new FlightController();
	fc.arm();
	phys.setWind(ZERO, 0);
	const b = manifest.bbox;
	// Départ deux fois R_HOLD avant la face, à mi-hauteur, plein est.
	place({ x: b.max[0] - 2 * R_HOLD, y: (b.min[1] + b.max[1]) / 2, z: 0 },
	      { x: speed, y: 0, z: 0 });
	fence.reset();
	let deepest = -Infinity;
	for (let i = 0; i < 30 * 250; i++) {
		const p = phys.position;
		fence.update(p);
		deepest = Math.max(deepest, p.x - b.max[0]);
		// Manches au neutre dès HOLD ; avant, on maintient la vitesse.
		const held = fence.out.zone === HOLD || fence.out.zone === LOST;
		const sticks = { throttle: 0.5, roll: 0, pitch: held ? 0 : 0.3, yaw: 0 };
		const { motors } = fc.update(sticks, phys, STEP);
		// Le rappel entre par le TROISIÈME paramètre de step(), en newtons et
		// dans le repère monde — exactement comme main.js le fera. Le passer
		// par un addForce APRÈS step() ne marcherait pas : step() commence par
		// resetForces().
		const a = fence.out.push, m = phys.profile.mass;
		phys.step(motors, STEP, { x: a.x * m, y: a.y * m, z: a.z * m });
		if (phys.velocity.x <= 0) break;   // arrêté, ou repoussé
	}
	return deepest;
}

const fence = new Geofence(manifest.bbox);
const rows = [];
for (const family of FAMILIES) {
	const v = topSpeed(family);
	const d = penetration(family, v, fence);
	rows.push({ family, v, d });
	console.log(`  ${family.padEnd(12)} vmax ${v.toFixed(1)} m/s   pénétration ${d.toFixed(1)} m`);
}

const worstD = Math.max(...rows.map((r) => r.d));
const worstV = Math.max(...rows.map((r) => r.v));
const rHold = Math.ceil(worstD + 1);
const rCaution = Math.ceil(rHold + BLINKS_TO_READ * BLINK_PERIOD_S * worstV);

console.log(`\n  A_MAX          ${A_MAX.toFixed(2)} m/s²`);
console.log(`  pire pénétration ${worstD.toFixed(1)} m,  pire vmax ${worstV.toFixed(1)} m/s`);
console.log(`\n  R_HOLD    = ${rHold}`);
console.log(`  R_CAUTION = ${rCaution}   (= R_HOLD + ${BLINKS_TO_READ} × ${BLINK_PERIOD_S} s × ${worstV.toFixed(1)} m/s)`);
console.log(`\n  → reporter ces deux valeurs dans src/geofence.js, avec la date.`);
```

**Dépendance :** ce harnais utilise le troisième paramètre de
`physics.step(motors, dt, externalForce)`, qui est ajouté par la tâche 6
step 1. **Faire la tâche 6 step 1 avant celle-ci** (c'est une dizaine de
lignes dans `physics.js`, indépendante du reste de la tâche 6).

- [ ] **Step 2 : lancer la mesure**

```bash
cd sim && node tools/geofence-measure.mjs 2>&1 | tail -20
```

Attendu : une ligne par famille, puis les deux valeurs. Si une famille sort une
pénétration absurde (négative, ou > 300 m), le harnais est faux — corriger
avant de figer quoi que ce soit.

- [ ] **Step 3 : figer les constantes**

Dans `src/geofence.js`, remplacer le bloc `// PROVISOIRE` par les valeurs
mesurées, avec le protocole et la date, sur le modèle des seuils de pose de
`flight-end.js` :

```js
// Mesurés par tools/geofence-measure.mjs sur public/scenes/tour-eiffel le
// 2026-08-30, sur les <N> familles de drone-profiles.js. Protocole : lancé à
// la vitesse en palier maximale droit vers une face, manches au neutre dès
// l'entrée en HOLD (le pilote a lu l'avertissement et a lâché), seuls A_MAX et
// la traînée de quad.js décélèrent. Pire pénétration mesurée : <D> m
// (<famille>), arrondie au mètre supérieur plus un.
//
// Manches au neutre et non tirées à fond, délibérément : un pilote qui insiste
// DOIT pouvoir passer, c'est la moitié du design. R_HOLD dimensionne le cas où
// on obéit.
export const R_HOLD = <mesuré>;
// R_HOLD + le temps de lire l'avertissement à la vitesse maximale (<V> m/s).
// Ce délai est de la mise en scène et s'assume comme telle, mais il s'ancre
// sur une constante du dépôt : un avertissement doit clignoter trois fois pour
// être lu, et BLINK_PERIOD_MS vaut 500 ms (drone-osd.js:51). Soit 1,5 s.
export const R_CAUTION = <mesuré>;
```

- [ ] **Step 4 : vérifier que rien n'a cassé**

```bash
cd sim && node tools/geofence-selftest.mjs && npm run selftest 2>&1 | tail -5
```

Attendu : tout au vert. Les tests de la tâche 1 sont écrits **relativement**
aux constantes, donc changer leurs valeurs ne doit rien casser. Si un test
échoue ici, c'est qu'il avait codé un nombre en dur — le corriger, pas
l'inverse.

- [ ] **Step 5 : commit**

```bash
git add sim/tools/geofence-measure.mjs sim/src/geofence.js
git commit -m "feat(geofence): R_HOLD et R_CAUTION mesurés, pas choisis (#139)"
```

---

### Task 5 : le sol lointain

**Files:**
- Create: `sim/src/ground.js`
- Modify: `sim/src/loader.js` (`setFog`, `setNight`, `setDim` doivent aussi atteindre le sol)

**Interfaces:**
- Consumes: `manifest.bbox`, `FLOOR_LOST` de `geofence.js`, la couleur d'horizon de `sky.js`.
- Produces: `class DistantGround { constructor(scene, bbox, { fogColor, fogDensity }); dispose() }` et un accès à sa matière pour `loader.js`.

**Pourquoi.** En air « clair » la portée est d'environ 2,3 km pour une bbox de
±642 m : le bord du maillage est pleinement visible en vol normal, avec **du
ciel dessous**. C'est le symptôme que cette tâche tue.

Le plan est posé sous le point le plus bas du maillage *et* sous le plancher de
la clôture, donc rien ne peut z-fighter avec la ville et on ne peut jamais
passer dessous.

- [ ] **Step 1 : écrire `src/ground.js`**

```js
import * as THREE from 'three';
import { FLOOR_LOST } from './geofence.js';

// Le sol lointain (#139) : ce qu'on voit au-delà du dernier chunk.
//
// Sans lui, le bord du maillage est une falaise nette avec du CIEL dessous —
// et ce n'est pas un cas limite : en air « clair » la portée météorologique
// est d'environ 2,3 km (fog.js, baseFogDensity 0,00085) pour une bbox de
// ±642 m sur tour-eiffel. Le bord est donc pleinement visible en vol normal.
//
// Ce n'est pas une extension du monde : c'est une plaine, sous la brume. La
// vraie réponse « monde étendu » serait un anneau de tuiles basse résolution,
// et elle touche l'exporteur Go, prep.mjs et la VRAM — une autre issue.
//
// Posé sous le point le plus bas du maillage ET sous le plancher de la
// clôture : rien ne peut z-fighter avec la ville, et on ne peut jamais passer
// dessous.

// De combien le sol est plus sombre que l'horizon. Une plaine lointaine n'est
// pas exactement de la couleur de l'air, sinon il n'y a plus de ligne
// d'horizon du tout — et c'est cette ligne qui dit « il y a un sol ». Choisi à
// l'œil, comme les couleurs de sky.js.
const DARKEN = 0.88;
// Le côté du plan, en multiples de la portée du brouillard le plus clair. 4×
// garantit qu'il atteint toujours l'horizon, quelle que soit la météo.
const SPAN = 4;

export class DistantGround {
	constructor(scene, bbox, { fogColor, fogDensity, span = 20000 } = {}) {
		const y = bbox.min[1] - FLOOR_LOST - 0.5;
		const size = Math.max(span * SPAN, 20000);
		const geo = new THREE.PlaneGeometry(size, size);
		geo.rotateX(-Math.PI / 2);

		// Même brouillard exp-carré que TileMaterial.js, et pour la même raison
		// (bug #10 du HANDOFF) : les couleurs sont du sRGB brut, il n'y a rien à
		// convertir. Une matière à part plutôt que createTileMaterial() : il n'y
		// a pas de sampler2DArray ici, pas d'UV, pas de lumières de ville.
		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: {
				uColor: { value: new THREE.Color(fogColor).multiplyScalar(DARKEN) },
				uFogColor: { value: new THREE.Color(fogColor) },
				uFogDensity: { value: fogDensity },
				uDim: { value: 1 },
				uNight: { value: 0 },
			},
			vertexShader: /* glsl */`
				out float vDepth;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					vDepth = -mv.z;
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uColor;
				uniform vec3 uFogColor;
				uniform float uFogDensity;
				uniform float uDim;
				uniform float uNight;
				in float vDepth;
				out vec4 outColor;
				void main() {
					// Pas de lumières de ville ici : c'est la campagne, elle
					// s'éteint la nuit. uNight ne fait que l'assombrir.
					vec3 c = uColor * uDim * (1.0 - 0.75 * uNight);
					float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
					outColor = vec4(mix(c, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
				}
			`,
		});

		this.mesh = new THREE.Mesh(geo, this.material);
		this.mesh.position.set(
			(bbox.min[0] + bbox.max[0]) / 2, y, (bbox.min[2] + bbox.max[2]) / 2,
		);
		// Le sol est toujours derrière la ville, jamais devant : il se dessine
		// en premier pour que le z-buffer tranche le reste normalement.
		this.mesh.renderOrder = -1;
		scene.add(this.mesh);
	}

	// La couleur d'air a changé (pluie, brouillard, nuit) : le sol la suit,
	// sinon la ligne d'horizon se dédouble.
	setFog(color, density) {
		if (color !== undefined) {
			this.material.uniforms.uFogColor.value.set(color);
			this.material.uniforms.uColor.value.set(color).multiplyScalar(DARKEN);
		}
		if (density !== undefined) this.material.uniforms.uFogDensity.value = density;
	}

	setNight(night) { this.material.uniforms.uNight.value = night; }
	setDim(dim) { this.material.uniforms.uDim.value = dim; }

	dispose() {
		this.mesh.parent?.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}
```

- [ ] **Step 2 : faire suivre la météo depuis `loader.js`**

Dans `src/loader.js`, à côté du tableau `tileMaterials`, ajouter un crochet
pour le sol, et l'appeler dans les trois setters existants :

```js
// Le sol lointain (#139) suit exactement la même météo que les tuiles — sinon
// la ligne d'horizon se dédouble. Enregistré plutôt qu'importé : loader.js ne
// doit rien savoir de THREE au-delà de ce qu'il fait déjà.
let distantGround = null;
export function setDistantGround(g) { distantGround = g; }
```

puis dans `setFog`, `setNight` et `setDim`, après la boucle existante :

```js
	distantGround?.setFog(color, density);     // dans setFog
	distantGround?.setNight(night);            // dans setNight
	distantGround?.setDim(dim);                // dans setDim
```

- [ ] **Step 3 : vérifier que la build passe**

```bash
cd sim && npm run build 2>&1 | tail -10
```

Attendu : build OK, aucun avertissement d'import non résolu.

- [ ] **Step 4 : commit**

```bash
git add sim/src/ground.js sim/src/loader.js
git commit -m "feat(ground): un sol lointain sous le maillage (#139)"
```

---

### Task 6 : le câblage dans `main.js` et `entry-state.js`

**Files:**
- Modify: `sim/src/main.js`
- Modify: `sim/src/entry-state.js:57-59` et `:129-130`
- Modify: `sim/tools/selftest.mjs`
- Modify: `docs/manual.md`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: le comportement observable en vol.

- [ ] **Step 1 : `physics.js` — une fenêtre pour les forces externes**

`physics.step()` commence par `resetForces(false)` (ligne ~243), puis ajoute
la poussée du quad, puis appelle `world.step()`. Une force ajoutée **après**
`physics.step()` serait donc effacée au début du pas suivant **sans jamais
être intégrée** : la clôture pousserait zéro newton, en silence, et tous les
tests hors-navigateur passeraient au vert. La force doit entrer entre le reset
et `world.step()`, et `physics.js` est seul propriétaire de cette fenêtre.

Changer la signature (paramètre optionnel — aucun appelant existant n'est
cassé) :

```js
	// `external` : une force en newtons, repère MONDE, ajoutée au même pas que
	// la poussée. Un paramètre et non un setter : une force externe ne doit pas
	// pouvoir traîner d'un pas sur l'autre, et resetForces() en tête de cette
	// méthode rend tout addForce appelé du dehors silencieusement inopérant.
	// Seule cliente aujourd'hui : la clôture de zone (#139).
	step(motors, dt = this.world.timestep, external = null) {
```

et, juste après le `this.body.addTorque(tw, true);` de la poussée :

```js
		if (external) this.body.addForce(external, true);
```

Vérifier qu'aucun appelant existant ne passe déjà un troisième argument :

```bash
cd sim && grep -rn "\.step(" src/ tools/ | grep -v "propulsion.step\|world.step\|\.step(setpoint\|\.step(gyro\|\.step(-\|pid\." | head
```

Puis :

```bash
cd sim && node tools/landing-selftest.mjs 2>&1 | tail -3
git add sim/src/physics.js && git commit -m "feat(physics): step() accepte une force externe au même pas (#139)"
```

Attendu : `landing-selftest.mjs` intact — le paramètre est optionnel et par
défaut nul, donc le comportement est bit-identique.

- [ ] **Step 2 : `entry-state.js` — supprimer le `EDGE_MARGIN` local**

`EDGE_MARGIN` vaut 10 m, et `R_CAUTION` vaudra plusieurs dizaines. En l'état,
un point d'entrée pourrait naître déjà en `CAUTION`, voire en `HOLD` : le vol
commencerait sur un avertissement.

Remplacer les lignes 57-59 :

```js
// La marge au bord, désormais celle de la clôture (#139) et non plus une
// valeur locale. Elle valait 10 m, ce qui suffisait à ne pas tirer un point
// au-delà du dernier chunk chargé — mais pas à naître HORS de l'avertissement
// de zone. Un vol ne doit jamais commencer sur un « NO COVERAGE ».
import { R_CAUTION as EDGE_MARGIN } from './geofence.js';
```

(l'import monte en haut du fichier ; le `const EDGE_MARGIN = 10;` disparaît.)

- [ ] **Step 3 : la vérification par scène dans `tools/selftest.mjs`**

Ajouter, avec les autres vérifications qui prennent la scène :

```js
// Le point d'entrée ne doit JAMAIS naître dans la clôture (#139) : un vol qui
// commence sur « NO COVERAGE » est un vol qu'on n'a pas voulu.
{
	const fence = new Geofence(manifest.bbox);
	let worst = null;
	for (let i = 0; i < 10000; i++) {
		const st = generateEntryState(manifest, phys, rngFrom(i));
		if (!st) continue;
		fence.reset();
		fence.update(st.position);
		if (fence.out.zone !== GF_NOMINAL) { worst = { i, zone: fence.out.zone }; break; }
	}
	check('les points d entrée naissent tous hors clôture', worst === null,
		worst && `graine ${worst.i} : ${worst.zone}`);
}
```

Compléter l'import du haut :

```js
import { Geofence, NOMINAL as GF_NOMINAL } from '../src/geofence.js';
```

**Note :** `generateEntryState` peut ne pas avoir exactement cette signature ni
retourner `.position`. **Lire `src/entry-state.js` et l'usage existant dans
`tools/selftest.mjs` avant d'écrire ce bloc**, et l'adapter aux vrais noms.

- [ ] **Step 4 : lancer les tests**

```bash
cd sim && npm run selftest 2>&1 | tail -8 && npm run selftest -- public/scenes/ile-de-la-cite-et-ile-saint-louis 2>&1 | tail -8
```

Attendu : les deux scènes au vert, y compris la nouvelle vérification.

- [ ] **Step 5 : commit intermédiaire**

```bash
git add sim/src/entry-state.js sim/tools/selftest.mjs
git commit -m "feat(entry-state): la marge au bord est celle de la clôture (#139)"
```

- [ ] **Step 6 : le câblage dans `main.js`**

Cinq points, tous petits :

1. **Imports**, avec les autres :
```js
import { Geofence, NOMINAL as FENCE_OK } from './geofence.js';
import { DistantGround } from './ground.js';
```

2. **Instanciation**, dans `boot()`, après `physics = new Physics(...)` (ligne
~353), là où `manifest` est disponible :
```js
	fence = new Geofence(manifest.bbox);
	distantGround = new DistantGround(scene, manifest.bbox, {
		fogColor: scene.background, fogDensity: fog.density,
	});
	setDistantGround(distantGround);
```
avec `let fence = null, distantGround = null;` déclarés près de `let physics`.
Importer `setDistantGround` depuis `./loader.js`.

3. **La mise à jour et le rappel**, dans la boucle de simulation, **avant**
l'appel à `physics.step(...)`, et la force passe par le troisième paramètre
ajouté au step 1 :
```js
	fence.update(physics.position);
	let fenceForce = null;
	if (fence.out.zone !== FENCE_OK) {
		const a = fence.out.push, m = physics.profile.mass;
		fenceForce = { x: a.x * m, y: a.y * m, z: a.z * m };
	}
	physics.step(motors, STEP, fenceForce);
```
en adaptant `motors` / `STEP` aux noms réellement utilisés sur place.
**Ne pas** appeler `physics.body.addForce` depuis `main.js` : `step()`
commence par `resetForces()`, la force serait effacée sans jamais agir.

4. **La perte de lien**, à côté de `link.update(...)` (ligne ~1196) :
```js
	link.setTerminalLoss(fence.out.lossDb);
```

5. **L'avertissement et la fin.** Dans le `droneOsd.update({...})` (ligne
~1272), la chaîne de priorité devient :
```js
		// NO COVERAGE passe devant RXLOSS : en zone d'avertissement la clôture
		// EST la cause du RXLOSS, et afficher l'effet plutôt que la cause
		// dirait au pilote de revenir vers... rien.
		warning: bat.voltage / PROFILE.battery.cells < 3.4 ? 'LOW VOLTAGE'
			: fence.out.warning ? fence.out.warning
			: link.out.quality < 0.25 ? 'RXLOSS' : '',
```
et dans le `flightEnd.update({...})` (ligne ~947) :
```js
		outOfZone: fence.out.over,
```

- [ ] **Step 7 : vérifier en vol**

```bash
cd sim && npm run dev
```

Ouvrir `?scene=tour-eiffel`, puis vérifier **à l'œil**, dans cet ordre :

1. Voler vers un bord : `NO COVERAGE` apparaît et clignote, l'image commence à
   se dégrader **avant** de sentir quoi que ce soit dans les manches.
2. Lâcher les manches en `HOLD` : le drone est ramené, sans à-coup.
3. Insister plein gaz : on passe, l'image meurt, `OUT OF COVERAGE` puis la
   séquence de fin, et **l'écran ne revient jamais** (c'est la borne #79 qu'on
   contourne — le bug le plus probable de tout ce lot).
4. Descendre sous le bord de la dalle : même chose, vers le haut.
5. Regarder l'horizon depuis 100 m d'altitude : **plus de ciel sous le sol**.

Le point 5 est le pari du spec. À 640 m le brouillard ne mange que 26 % : si le
plan se lit comme une nappe morte plutôt que comme une plaine sous la brume,
ouvrir une issue de suivi pour un bruit de valeur à grande échelle sur sa
couleur. Ne pas le construire d'avance.

- [ ] **Step 8 : documenter**

Ajouter à `docs/manual.md`, après la section sur le lien vidéo, une section
« Limites de zone » : la fiction (la zone scannée), le tableau des quatre
anneaux, d'où sortent `R_HOLD` et `R_CAUTION` (la commande
`node tools/geofence-measure.mjs`), pourquoi le couloir vertical est sous
`bbox.min.y`, et pourquoi la clôture a son propre canal dans `link.js`.

- [ ] **Step 9 : commit et pousser**

```bash
git add sim/src/main.js docs/manual.md
git commit -m "feat(geofence): câblage en vol — rappel, avertissement, fin de session (#139)"
git push
```

---

## Self-review

**Couverture du spec** — chaque section a sa tâche :

| section du spec | tâche |
|---|---|
| `src/geofence.js` pur, `out` muté | 1 |
| le volume, la bbox brute, le plancher sous `bbox.min.y` | 1 |
| les quatre anneaux + hystérésis | 1 |
| le rappel plafonné, `main.js` → `addForce`, pas `quad.js` | 1 (modèle) + 6 (câblage) |
| la perte progressive, les deux segments ancrés | 1 (courbe) + 2 (canal) |
| la borne #79 contournée | 2 |
| `FENCE_TIMELINE`, verdict `CRASHED` | 3 |
| l'avertissement `NO COVERAGE` devant `RXLOSS` | 6 |
| le sol lointain + limite connue à vérifier | 5 + 6 (step 6.5) |
| `R_HOLD`/`R_CAUTION` mesurés | 4 |
| `EDGE_MARGIN` → `R_CAUTION` | 6 |
| les vérifications hors-navigateur | 1, 2, 3, 6 |
| README | 6 |

**Écarts assumés par rapport au spec :**

- Le spec nommait `tools/geofence-selftest.mjs` le harnais de mesure. Le dépôt
  sépare les deux patrons (`flight-end-selftest.mjs` = unitaire,
  `landing-selftest.mjs` = mesure sous Rapier), donc le plan sépare aussi :
  `geofence-selftest.mjs` (unitaire) et `geofence-measure.mjs` (mesure).
- Le spec parlait de `FLOOR_DEPTH` ; le plan éclate le couloir vertical en
  `FLOOR_CAUTION` / `FLOOR_HOLD` / `FLOOR_LOST`, qui sont les trois nombres
  que le spec décrit en toutes lettres (2 / 5 / 10 m).

**Deux endroits où l'implémenteur doit lire le code avant d'écrire**, signalés
en gras dans les tâches concernées : la façon de placer le drone dans
`geofence-measure.mjs` (tâche 4, step 1) et la vraie signature de
`generateEntryState` (tâche 6, step 2). Le plan ne les invente pas.

**Le risque n°1** est le point 3 de la vérification en vol : si la borne #79
relève l'image après une sortie de zone, tout le reste marche et le design est
mort quand même. Le test `la borne de jouabilité #79 ne relève JAMAIS une perte
terminale` (tâche 2) est là pour l'attraper avant le navigateur.
