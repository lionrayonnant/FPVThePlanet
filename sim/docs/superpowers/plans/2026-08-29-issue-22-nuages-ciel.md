# Nuages et ciel (issue #22) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner un ciel au simulateur — dégradé, nuages procéduraux animés, couverture pilotée par le monde, plafond traversable — sans introduire d'éclairage ni d'ombre projetée.

**Architecture:** Un modèle pur (`src/cloud.js`, `CloudField`) sur le patron exact de `FogField`, et un rendu (`src/sky.js`, `SkyDome`) : une sphère `BackSide` de rayon 1 recollée sur la caméra, dont le fragment shader fait le dégradé zénith/horizon et intersecte le rayon de vue avec un plan horizontal à l'altitude de la base des nuages pour y échantillonner un FBM. Le whiteout réutilise le terme d'extinction existant de `main.js`, l'assombrissement du sol est un unique uniforme scalaire dans `TileMaterial.js`.

**Tech Stack:** Three.js (GLSL3, `ShaderMaterial`), Vite, JS ES modules sans framework. Vérification headless par `node tools/selftest.mjs`, vérification visuelle par chrome-devtools.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-issue-22-nuages-ciel-design.md`

## Global Constraints

Copiées telles quelles de la spec. Elles s'appliquent implicitement à **toutes** les tâches.

- **Aucune ombre de nuage projetée avec motif** (D0). L'assombrissement du sol est un scalaire unique, sans aucune structure spatiale.
- **Aucun réglage utilisateur** : pas de slider, pas de preset, pas de `localStorage`. La couverture vient de `cloudPct`, produit par le monde (#41).
- **Aucun modèle d'éclairage, aucune normale.** La géométrie n'a que `position`, `uv`, `aLayer`. `TileMaterial.js` ne gagne qu'un multiplicateur scalaire.
- **`ColorManagement.enabled = false`, `NoToneMapping`.** Toutes les couleurs sont écrites et sorties en sRGB. Ne jamais appeler `convertSRGBToLinear()`, ne jamais poser `colorSpace` sur une couleur, ne pas activer le tone mapping.
- **D5 — air clair bit-identique côté modèle :** à `cover === 0`, `dim === 1` exactement, `extinctionAt()` rend exactement `0` à toute altitude, aucun nombre aléatoire n'est tiré, et la densité de nuage dans le shader est exactement `0`.
- **D5 — invariant de couleur reformulé :** la couleur d'**horizon** par ciel clair reste exactement `#9fb8cc` (`SKY`). Le zénith, lui, devient plus profond — c'est voulu.
- **D4 — une seule couleur d'air :** `loader.setFog()` et `scene.background` reçoivent tous les deux la couleur d'horizon du dôme, pour que la ligne d'horizon ne se dédouble pas. `rainfall.js` et `lens.js` ne sont pas modifiés.
- **Aucun asset, aucune texture** pour les nuages : bruit haché calculé dans le shader.
- **Constantes non rondes et justifiées.** Le dépôt mesure ses seuils au lieu de les choisir ; tout nombre nouveau porte en commentaire d'où il vient.
- **Pas de changement à la physique du vol.** Le plafond change la visibilité, pas l'aérodynamique.

---

## Structure des fichiers

| Fichier | Rôle | Tâche |
|---|---|---|
| `src/cloud.js` | **Créé.** `CloudField` : couverture effective, altitude de base, assombrissement, extinction du whiteout. Pas de THREE, pas de DOM. | 1 |
| `tools/selftest.mjs` | **Modifié.** Nouvelle section `nuages`, après la section `brouillard`. | 1, 2 |
| `tools/lib/weather.mjs` | **Modifié.** `toSimParams()` gagne le canal `cloud`. | 2 |
| `src/weather.js` | **Modifié.** `applyWeather()` pose `cloud`, `CALM` gagne `cloud`. | 2 |
| `src/TileMaterial.js` | **Modifié.** Uniforme `uDim`. | 3 |
| `src/loader.js` | **Modifié.** `setDim(dim)`. | 3 |
| `src/sky.js` | **Créé.** `SkyDome` : le dôme, son shader, la couleur d'horizon. | 4, 5 |
| `src/main.js` | **Modifié.** Instanciation et câblage dans la boucle de rendu. | 4, 6 |
| `HANDOFF.md` | **Modifié.** État vérifié / non vérifié. | 7 |

Le découpage suit celui déjà en place dans le dépôt : `rain.js` (modèle) / `rainfall.js` (rendu), `fog.js` (modèle) / `lens.js` (rendu). Ici `cloud.js` (modèle) / `sky.js` (rendu). Le modèle est la moitié que `selftest.mjs` peut vérifier ; le rendu se vérifie en vol.

---

### Task 1 : `CloudField`, le modèle

**Files:**
- Create: `sim/src/cloud.js`
- Test: `sim/tools/selftest.mjs` (nouvelle section, insérée juste après la section `brouillard` qui se termine avant `console.log('\ntextures');`)

**Interfaces:**
- Consumes: `Ou`, `mulberry32` depuis `./wind.js` ; `fogDensity` depuis `./rain.js`.
- Produces:
  - `class CloudField` — `constructor(seed = 0xc10d)`, `setParams({ cover, variability })` (rend `this`), `get active()`, `reset()`, `update(dt)` (rend `this`), et les champs lus chaque frame : `cover` (0..1 effectif), `base` (mètres AGL), `dim` (0..1, 1 = pas d'assombrissement).
  - `extinctionAt(altitudeAGL)` — méthode, rend une extinction dans les unités du shader.
  - Constantes exportées : `BASE_CLEAR`, `BASE_OVERCAST`, `DECK_THICKNESS`, `DECK_RANGE`, `DIM_MAX`.
  - `baseFor(cover)` — fonction libre, le mapping d'altitude sans instancier de champ (même motif que `rangeFor()` dans `fog.js`).

- [ ] **Step 1 : écrire les tests qui échouent**

Insérer dans `sim/tools/selftest.mjs`. D'abord l'import, à ajouter au groupe d'imports en tête de fichier (après la ligne qui importe `FogField`) :

```js
import { CloudField, baseFor, BASE_CLEAR, BASE_OVERCAST, DECK_THICKNESS, DIM_MAX } from '../src/cloud.js';
```

Puis la section, insérée juste avant `console.log('\ntextures');` :

```js
console.log('\nnuages');
{
	// D5. Un ciel clair doit être le monde tel qu'il était avant que le modèle
	// existe : la même promesse que wind.js fait au calme et fog.js à l'air
	// clair, et ce qui garde un monde neutre neutre.
	{
		const c = new CloudField(7);
		for (let i = 0; i < 1000; i++) c.update(1 / 50);
		let allZero = true;
		for (let agl = 0; agl <= 3000; agl += 25) if (c.extinctionAt(agl) !== 0) allZero = false;
		check('ciel clair : aucun assombrissement, aucune extinction, à aucune altitude',
			c.dim === 1 && c.cover === 0 && allZero, `dim ${c.dim}`);

		// Et il le fait sans tirer un seul nombre aléatoire, donc une session
		// par ciel clair est bit-identique à une session sans modèle de nuages.
		const off = new CloudField(7);
		const armed = new CloudField(7).setParams({ cover: 0.5, variability: 0.8 });
		let untouched = true;
		for (let i = 0; i < 500; i++) {
			off.update(1 / 50); armed.update(1 / 50);
			if (off.dim !== 1 || off.cover !== 0) untouched = false;
		}
		check('et il ne consomme aucune randomness tant qu\'il est éteint', untouched);
	}

	// D2. Le mapping est géométrique, comme celui de fog.js sur la portée : la
	// seule échelle sur laquelle « un peu plus bas » veut dire la même chose à
	// 1200 m et à 150 m.
	{
		check('le mapping va de BASE_CLEAR à BASE_OVERCAST',
			Math.abs(baseFor(0) - BASE_CLEAR) < 1e-9 && Math.abs(baseFor(1) - BASE_OVERCAST) < 1e-9,
			`${Math.round(baseFor(0))} m -> ${Math.round(baseFor(1))} m`);
		check('et il est géométrique, donc la moitié est la moyenne géométrique',
			Math.abs(baseFor(0.5) ** 2 - BASE_CLEAR * BASE_OVERCAST) < 1e-6 * BASE_CLEAR * BASE_OVERCAST,
			`${Math.round(baseFor(0.5))} m`);
		let monotone = true;
		for (let i = 1; i <= 100; i++) if (baseFor(i / 100) >= baseFor((i - 1) / 100)) monotone = false;
		check('le plafond ne fait que descendre quand la couverture monte', monotone);
	}

	// D1, la décision de conception que ce plan doit protéger : le plafond n'est
	// atteignable QUE par mauvais temps. Un ciel épars a une base hors de portée
	// d'un vol normal ; un ciel bouché en a une qu'on touche.
	{
		const scattered = baseFor(0.3), overcast = baseFor(0.92);
		check('un ciel épars a un plafond hors d\'atteinte (> 500 m)', scattered > 500,
			`${Math.round(scattered)} m`);
		check('un ciel bouché a un plafond atteignable (< 250 m)', overcast < 250,
			`${Math.round(overcast)} m`);
	}

	// Le whiteout. Nul loin sous la base, il mord en approche, sature dans la
	// couche, et se rouvre au-dessus — c'est la récompense de D1.
	{
		const c = new CloudField(11).setParams({ cover: 1, variability: 0 }).update(1 / 50);
		const base = c.base;
		const inside = c.extinctionAt(base + DECK_THICKNESS * 0.5);
		check('rien à voir loin sous la base', c.extinctionAt(base * 0.25) === 0);
		check('ça mord dans la couche', inside > 0.05, inside.toFixed(4));
		check('l\'approche est plus douce que l\'intérieur',
			c.extinctionAt(base - 60) > 0 && c.extinctionAt(base - 60) < inside);
		check('et on ressort au-dessus de la couche',
			c.extinctionAt(base + DECK_THICKNESS * 3) === 0);

		// Amplitude proportionnelle à la couverture, pas un seuil binaire.
		const light = new CloudField(11).setParams({ cover: 0.3, variability: 0 }).update(1 / 50);
		check('une couverture faible donne une laiteuse, pas un whiteout',
			light.extinctionAt(light.base + DECK_THICKNESS * 0.5) < inside * 0.5);
	}

	// D0. L'assombrissement est un scalaire, borné par DIM_MAX, monotone.
	{
		const full = new CloudField(13).setParams({ cover: 1, variability: 0 }).update(1 / 50);
		check('couvert plein : l\'assombrissement atteint DIM_MAX',
			Math.abs(full.dim - DIM_MAX) < 1e-9, full.dim.toFixed(3));
		let monotone = true, prev = 1;
		for (let i = 1; i <= 100; i++) {
			const f = new CloudField(13).setParams({ cover: i / 100, variability: 0 }).update(1 / 50);
			if (f.dim > prev) monotone = false;
			prev = f.dim;
		}
		check('et il ne fait que s\'assombrir quand la couverture monte', monotone);
		check('il n\'assombrit jamais au point de rendre l\'image illisible', DIM_MAX > 0.5, `${DIM_MAX}`);
	}

	// D3. La respiration ne doit pas être un épaississement : même correction
	// lognormale que rain.js et fog.js, et la même raison de la vérifier — la
	// moyenne est ce que le monde a annoncé.
	{
		const still = new CloudField(17).setParams({ cover: 0.6, variability: 0 });
		let flat = true;
		for (let i = 0; i < 2000; i++) { still.update(1 / 50); if (Math.abs(still.cover - 0.6) > 1e-12) flat = false; }
		check('pas de variabilité, pas de respiration', flat);

		// Mis en commun sur six graines. La bande lente a une mémoire de dix
		// minutes, donc une seule graine sur une heure ne fait qu'une poignée
		// d'échantillons indépendants et atterrit n'importe où — ce n'est pas du
		// remplissage, c'est ce qu'il faut pour que la mesure veuille dire
		// quelque chose. Mesuré à 0,5 : la couverture est bornée à 1, donc près
		// de 1 le clamp mord et biaise à juste titre (on n'est pas « plus que
		// couvert »), ce qui n'est pas ce qu'on teste ici.
		let sum = 0, n = 0;
		for (const seed of [2, 3, 5, 7, 11, 13]) {
			const f = new CloudField(seed).setParams({ cover: 0.5, variability: 1 });
			for (let i = 0; i < 300000; i++) { f.update(1 / 50); sum += f.cover; n++; }
		}
		const mean = sum / n;
		check('la respiration ne biaise pas la couverture moyenne',
			Math.abs(mean - 0.5) < 0.02, `moyenne ${mean.toFixed(4)} pour 0.5`);
	}

	// Déterminisme : un respawn ne doit pas retomber au milieu du grain en
	// cours, et les checks doivent être stables plutôt que seulement plausibles.
	{
		const a = new CloudField(19).setParams({ cover: 0.7, variability: 0.6 });
		const b = new CloudField(19).setParams({ cover: 0.7, variability: 0.6 });
		let same = true;
		for (let i = 0; i < 400; i++) { a.update(1 / 50); b.update(1 / 50); if (a.cover !== b.cover) same = false; }
		a.reset(); b.reset();
		for (let i = 0; i < 400; i++) { a.update(1 / 50); b.update(1 / 50); if (a.cover !== b.cover) same = false; }
		check('même graine, même trajectoire, avant et après reset()', same);
	}

	// La couverture est une fraction : elle ne peut pas sortir de [0, 1], quelle
	// que soit la violence de la respiration.
	{
		const f = new CloudField(23).setParams({ cover: 0.95, variability: 1 });
		let inRange = true;
		for (let i = 0; i < 50000; i++) { f.update(1 / 50); if (f.cover < 0 || f.cover > 1) inRange = false; }
		check('la couverture reste une fraction, quoi qu\'il arrive', inRange);
	}
}
```

- [ ] **Step 2 : lancer les tests pour vérifier qu'ils échouent**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot find module '.../src/cloud.js'`. C'est une erreur d'import, pas un échec de check : le fichier n'existe pas encore.

- [ ] **Step 3 : écrire `src/cloud.js`**

```js
// Les nuages, comme modèle : quelle fraction du ciel est couverte en ce moment,
// à quelle hauteur commence la couche, de combien le sol s'assombrit, et ce
// qu'on n'y voit plus une fois dedans.
//
// Pas de THREE et pas de DOM ici, même règle et même raison que wind.js,
// rain.js et fog.js : c'est la moitié que tools/selftest.mjs peut vérifier.
// sky.js fait le dôme et les nuages qu'on voit, TileMaterial.js applique
// l'assombrissement, main.js ajoute l'extinction aux autres et câble le tout.
//
// Ce fichier ne décide pas du temps qu'il fait : la couverture vient de
// cloudPct, que le monde produit (#41). Il ne fait que la rendre vivante.

import { Ou, mulberry32 } from './wind.js';
import { fogDensity } from './rain.js';

// Les altitudes de base viennent des classes observées, pas de positions
// rondes : cumulus de beau temps 600-1200 m, stratocumulus 300-900 m, stratus
// bouché 100-300 m. Ce sont les deux bouts de cette plage.
export const BASE_CLEAR = 1500;      // m AGL, ciel clair — hors d'atteinte, et c'est le but
export const BASE_OVERCAST = 120;    // m AGL, couvert plein — atteignable, et c'est le but

// Profondeur de la couche. Un stratocumulus fait 250 à 600 m d'épaisseur ; on
// prend le bas de la fourchette, parce que c'est ce qui rend la traversée
// possible dans un vol de quelques minutes plutôt que théorique.
export const DECK_THICKNESS = 250;   // m
// Sur quelle épaisseur la laiteuse monte avant la base, et redescend après le
// sommet. Un vrai bord de nuage est net à quelques dizaines de mètres près.
const EDGE = 60;                     // m
// Ce qu'on voit à l'intérieur d'un nuage. RANGE_MIN vaut 30 m dans fog.js et
// s'appelle « purée de pois » ; dedans c'est un peu pire.
export const DECK_RANGE = 25;        // m

// D6 — PROVISOIRE, à calibrer en vol (tâche 7) avant d'être figé.
// La radiométrie dit qu'un ciel couvert laisse passer 15 à 30 % de
// l'éclairement du ciel clair. On ne peut pas l'appliquer : la photogrammétrie
// est cuite avec un éclairage ensoleillé, on ne peut pas la ré-éclairer, et on
// vole *à* cette texture. La contrainte réelle est la lisibilité, pas
// l'éclairement, donc ce nombre se mesure à l'œil dans le simulateur.
export const DIM_MAX = 0.72;

// Une couverture évolue sur des dizaines de minutes, pas sur des secondes.
// fog.js utilise 120 / 25 s pour une nappe ; une couche nuageuse est bien plus
// lente. Un vol dure quelques minutes, donc on en voit une fraction de cycle :
// ça évolue, ça ne clignote pas.
const TAU_SLOW = 600, TAU_FAST = 150;
const BAND_MIX = 0.7;    // poids de la bande lente ; les deux sont renormalisées plus bas
// Même argument lognormal que rain.js et fog.js : exp(k·n − k²/2) a une moyenne
// unité pour un n de variance unité, donc monter la variabilité fait aller et
// venir la couverture sans monter sa moyenne en douce.
const VAR_GAIN = 0.5;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};

// L'altitude de base qu'une couverture demande. Fonction libre parce que
// selftest et le HUD doivent pouvoir l'interroger sans instancier de champ —
// même motif que rangeFor() dans fog.js.
//
// Géométrique, pour la même raison que la portée du brouillard l'est : c'est la
// seule échelle sur laquelle « un peu plus bas » veut dire la même chose en
// haut et en bas de la plage. La courbe est ancrée sur ses deux bouts et passe
// dans les fourchettes observées sur l'essentiel de leur étendue ; elle court un
// peu bas dans le haut du domaine stratocumulus, ce qui penche du côté d'un
// plafond atteignable. Ce biais est voulu : un plafond que personne n'atteint
// jamais est un plafond que personne ne voit.
export function baseFor(cover) {
	return BASE_CLEAR * Math.pow(BASE_OVERCAST / BASE_CLEAR, clamp01(cover));
}

export class CloudField {
	constructor(seed = 0xc10d) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);

		this.meanCover = 0;      // 0..1, ce que le monde a annoncé pour la journée
		this.variability = 0;    // 0..1, à quel point ça respire

		this._slow = new Ou(this.rng);
		this._fast = new Ou(this.rng);

		// Lus chaque frame par main.js et sky.js.
		this.cover = 0;                 // 0..1, la couverture de cette frame
		this.base = BASE_CLEAR;         // m AGL
		this.dim = 1;                   // 1 = pas d'assombrissement
		this.reset();
	}

	// Un respawn ne doit pas retomber au milieu du grain qui venait de passer.
	// Déterministe, pour que les checks headless soient stables et pas seulement
	// plausibles.
	reset() {
		this.rng = mulberry32(this.seed);
		this._slow.rng = this.rng;
		this._fast.rng = this.rng;
		this._slow.reset();
		this._fast.reset();
		this.cover = this.active ? this.meanCover : 0;
		this.base = baseFor(this.cover);
		this.dim = this.active ? 1 - (1 - DIM_MAX) * this.cover : 1;
		return this;
	}

	// cover 0..1 (0 est un ciel parfaitement dégagé), variability 0..1.
	setParams({ cover, variability } = {}) {
		if (cover !== undefined) this.meanCover = clamp01(cover);
		if (variability !== undefined) this.variability = clamp01(variability);
		return this;
	}

	// Rien de posé, rien qui tourne : aucun filtre avancé, aucun nombre tiré,
	// et le sol exactement à la luminosité où la scène l'a chargé. Un ciel clair
	// doit être bit-identique à l'absence de modèle de nuages — c'est la
	// promesse que wind.js fait au calme et fog.js à l'air clair (D5).
	get active() { return this.meanCover > 0; }

	update(dt) {
		if (!this.active) {
			this.cover = 0;
			this.base = BASE_CLEAR;
			this.dim = 1;
			return this;
		}

		// Deux bandes, renormalisées à variance unité pour que `variability`
		// veuille dire la même chose quelle que soit celle qui domine.
		const n = (BAND_MIX * this._slow.next(dt, TAU_SLOW)
			+ (1 - BAND_MIX) * this._fast.next(dt, TAU_FAST))
			/ Math.sqrt(BAND_MIX * BAND_MIX + (1 - BAND_MIX) * (1 - BAND_MIX));
		const k = VAR_GAIN * this.variability;

		// Une couverture est une fraction : elle est bornée à 1, et le clamp
		// mord donc près du couvert plein. Ce n'est pas un défaut du modèle,
		// c'est de l'atmosphère : on n'est pas « plus que couvert ».
		this.cover = clamp01(this.meanCover * Math.exp(k * n - 0.5 * k * k));
		this.base = baseFor(this.cover);
		// D0 : un scalaire, aucun motif. Et il respire avec la couverture, ce
		// qui est ce que « soleil masqué temporairement » veut dire quand il n'y
		// a pas encore de soleil (#23).
		this.dim = 1 - (1 - DIM_MAX) * this.cover;
		return this;
	}

	// Le whiteout, dans les unités du shader de tuile — parce que les
	// extinctions s'additionnent, ce qui est déjà l'argument par lequel main.js
	// ajoute la pluie au brouillard. Exactement 0 loin sous la base, monte en
	// approche, sature dans la couche, et retombe à 0 au-dessus : on perce
	// l'overcast et on débouche dessus (D1).
	extinctionAt(altitudeAGL) {
		if (!this.active) return 0;
		const h = altitudeAGL - this.base;      // signé : négatif sous la base
		if (h < -EDGE || h > DECK_THICKNESS + EDGE) return 0;
		const rise = smoothstep(-EDGE, EDGE, h);
		const fall = 1 - smoothstep(DECK_THICKNESS - EDGE, DECK_THICKNESS + EDGE, h);
		// Proportionnel à la couverture, pas un seuil binaire : à 0,3 c'est une
		// laiteuse en approche, à 0,95 c'est un vrai whiteout.
		return fogDensity(DECK_RANGE) * this.cover * rise * fall;
	}
}
```

- [ ] **Step 4 : lancer les tests pour vérifier qu'ils passent**

Run: `cd sim && node tools/selftest.mjs`
Expected: la section `nuages` affiche `PASS` sur ses douze checks, et le total en fin de fichier reste `all checks passed`.

Si `la respiration ne biaise pas la couverture moyenne` échoue de peu (moyenne à 0,47 ou 0,53), ne pas ajuster le seuil du test : c'est `VAR_GAIN` ou la renormalisation des bandes qu'il faut regarder. Le test dit ce que le modèle promet ; on ne change pas la promesse pour faire passer le test.

- [ ] **Step 5 : commit**

```bash
cd sim && git add src/cloud.js tools/selftest.mjs
git commit -m "Nuages : CloudField, le modèle (couverture, plafond, whiteout)

Couverture qui respire sur deux bandes d'Ornstein-Uhlenbeck aux échelles
des nuages (600/150 s), altitude de base géométrique de 1500 m à 120 m
ancrée sur les classes météo observées, extinction de whiteout qui
s'ouvre au-dessus de la couche. Air clair bit-identique à l'absence de
modèle (D5).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2 : brancher `cloudPct`, le canal mort

`cloudPct` est déjà produit, déjà borné, déjà rendu cohérent avec la pluie et la visibilité par `sanitize()`. Il n'est consommé par rien. Cette tâche ne fait que le router — elle n'invente aucune constante côté modèle météo.

**Files:**
- Modify: `sim/tools/lib/weather.mjs` (fonction `toSimParams`, autour de la ligne 461)
- Modify: `sim/src/weather.js` (fonction `applyWeather`, et la constante `CALM`)
- Test: `sim/tools/selftest.mjs` (ajouts dans la section `nuages` de la tâche 1)

**Interfaces:**
- Consumes: `CloudField` de la tâche 1.
- Produces: `toSimParams(day)` rend désormais `{ wind, rain, fog, cloud }` où `cloud` vaut `{ cover: number 0..1, variability: number 0..1 }`. `CALM.cloud === { cover: 0, variability: 0.5 }`. `applyWeather(snapshot, { physics, rain, fog, cloud })` accepte un quatrième modèle.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter l'import en tête de `sim/tools/selftest.mjs`, à côté des autres :

```js
import { toSimParams, sanitize } from './lib/weather.mjs';
import { CALM as CALM_WEATHER } from '../src/weather.js';
```

Puis, à la fin du bloc `console.log('\nnuages');` de la tâche 1 (avant sa `}` fermante) :

```js
	// Le canal était déjà produit et déjà assaini ; cette partie ne fait que le
	// router. Ce qui se teste est donc le routage, pas la météo.
	{
		const clear = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 0, visibilityM: 60000 }));
		check('un ciel à 0 % donne une couverture exactement nulle', clear.cloud.cover === 0);

		const shut = toSimParams(sanitize({ cloudPct: 100, windSpeed: 0, rateMmH: 0, visibilityM: 60000 }));
		check('un ciel à 100 % donne une couverture pleine', shut.cloud.cover === 1);

		// La garde-fou de sanitize() qui existait déjà et que personne ne
		// consommait : il ne pleut pas sous un ciel bleu. Maintenant qu'on le
		// consomme, on le vérifie.
		const wet = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 4, visibilityM: 60000 }));
		check('il ne peut pas pleuvoir sous un ciel dégagé', wet.cloud.cover >= 0.7,
			wet.cloud.cover.toFixed(2));

		// Et l'autre : un ciel bouché n'est pas dégagé.
		const foggy = toSimParams(sanitize({ cloudPct: 0, windSpeed: 0, rateMmH: 0, visibilityM: 400 }));
		check('un brouillard épais implique un ciel couvert', foggy.cloud.cover >= 0.6,
			foggy.cloud.cover.toFixed(2));

		// Un ciel épars s'agite, un couvercle d'overcast ne bouge presque plus.
		check('un ciel épars respire plus qu\'un couvercle',
			toSimParams(sanitize({ cloudPct: 30 })).cloud.variability
			> toSimParams(sanitize({ cloudPct: 95 })).cloud.variability);

		// Le monde neutre que selftest.mjs suppose doit rester neutre.
		check('CALM est un ciel parfaitement dégagé', CALM_WEATHER.cloud.cover === 0);
		const calmField = new CloudField(29).setParams(CALM_WEATHER.cloud);
		for (let i = 0; i < 200; i++) calmField.update(1 / 50);
		check('et un CloudField nourri par CALM n\'assombrit rien',
			calmField.dim === 1 && calmField.extinctionAt(150) === 0);
	}
```

- [ ] **Step 2 : lancer les tests pour vérifier qu'ils échouent**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'cover')`, parce que `toSimParams()` ne rend pas encore de canal `cloud`.

- [ ] **Step 3 : écrire l'implémentation**

Dans `sim/tools/lib/weather.mjs`, dans `toSimParams()`, juste avant le `return` final, ajouter :

```js
	// Nuages. cloudPct est déjà produit, déjà borné et déjà rendu cohérent avec
	// la pluie et la visibilité par sanitize() ; il n'y a rien à modéliser ici,
	// seulement à convertir en fraction.
	const cover = clamp01(d.cloudPct / 100);
	// Un ciel épars s'agite — les cumulus se forment et se dissipent à vue —
	// tandis qu'un couvercle de stratus est une couche stable qui ne bouge
	// presque plus. Même forme et même raison que fogVariability juste au-dessus.
	const cloudVariability = cover > 0 ? clamp01(0.7 - 0.45 * cover) : 0.5;
```

et remplacer le `return` par :

```js
	return {
		wind: { speed, direction: d.windDir, gust, turbulence },
		rain: { intensity: rainIntensity, variability: rainVariability(d) },
		fog: { intensity: fogIntensity, variability: fogVariability },
		cloud: { cover, variability: cloudVariability },
	};
```

Dans `sim/src/weather.js`, dans `applyWeather()`, ajouter le quatrième modèle :

```js
export function applyWeather(snapshot, { physics, rain, fog, cloud } = {}) {
	const d = model.today(snapshot);
	if (!d) return null;
	const p = model.toSimParams(d);
	physics?.setWeather(p.wind);
	rain?.setParams(p.rain);
	fog?.setParams(p.fog);
	cloud?.setParams(p.cloud);
	return p;
}
```

et dans la constante `CALM`, ajouter la ligne :

```js
	cloud: { cover: 0, variability: 0.5 },
```

- [ ] **Step 4 : lancer les tests pour vérifier qu'ils passent**

Run: `cd sim && node tools/selftest.mjs`
Expected: les sept nouveaux checks passent, et le total reste `all checks passed`. Vérifier en particulier qu'**aucun** check des sections `wind`, `rain` ou `brouillard` n'a bougé : `CALM` a changé de forme, et rien ne doit s'en apercevoir.

- [ ] **Step 5 : commit**

```bash
cd sim && git add tools/lib/weather.mjs src/weather.js tools/selftest.mjs
git commit -m "Météo : brancher cloudPct, qui était un canal mort

toSimParams() gagne un canal cloud, applyWeather() un quatrième modèle,
CALM un ciel dégagé. Aucune constante nouvelle du côté du modèle météo :
cloudPct était déjà produit, borné et rendu cohérent par sanitize().

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3 : l'assombrissement du sol

**Files:**
- Modify: `sim/src/TileMaterial.js` (fonction `createTileMaterial`)
- Modify: `sim/src/loader.js:40` (à côté de `setFog`)
- Test: `sim/tools/selftest.mjs` (ajout dans la section `nuages`)

**Interfaces:**
- Consumes: rien des tâches précédentes.
- Produces: `createTileMaterial(arrayTexture, fogColor, fogDensity)` — signature **inchangée** — dont le matériau porte désormais `uniforms.uDim.value === 1` par défaut. `setDim(dim)` exportée par `loader.js`, de signature `(dim: number) => void`, sur le modèle de `setFog(color, density)`.

- [ ] **Step 1 : écrire le test qui échoue**

Ajouter en tête de `sim/tools/selftest.mjs` :

```js
import { createTileMaterial } from '../src/TileMaterial.js';
```

et à la fin de la section `nuages` :

```js
	// D5 côté rendu : un matériau de tuile qu'on vient de créer n'assombrit
	// rien. Three tourne en node tant qu'on n'ouvre pas de contexte WebGL, donc
	// ce défaut-là se vérifie ici et pas seulement à l'œil dans le navigateur.
	{
		const m = createTileMaterial(null, 0x9fb8cc, 0.00085);
		check('un matériau de tuile neuf n\'assombrit rien', m.uniforms.uDim.value === 1);
		m.dispose();
	}
```

- [ ] **Step 2 : lancer le test pour vérifier qu'il échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'value')`, l'uniforme n'existe pas.

- [ ] **Step 3 : écrire l'implémentation**

Dans `sim/src/TileMaterial.js` : ajouter l'uniforme au bloc `uniforms`, après `uFogDensity` :

```js
			// Les nuages passent (#22). Pas une ombre : un scalaire, sans aucune
			// structure spatiale — les tuiles portent déjà l'ombrage cuit
			// d'Apple, et un motif projeté par-dessus le contredirait. 1.0 est
			// bit-identique à l'absence de nuages.
			uDim: { value: 1 },
```

déclarer l'uniforme dans le fragment shader, après `uniform float uFogDensity;` :

```glsl
			uniform float uDim;
```

et l'appliquer au texel, en remplaçant la ligne `vec3 c = texture(...)` par :

```glsl
				// Assombri avant le brouillard : ce qui est voilé est déjà à
				// l'ombre du nuage, et le voile lui-même a la couleur de l'air,
				// qui a sa propre luminosité.
				vec3 c = texture(uMap, vec3(vUv, float(vLayer))).rgb * uDim;
```

Mettre aussi à jour le commentaire d'en-tête du fichier, qui affirme aujourd'hui qu'il n'y a aucun modèle d'éclairage — c'est toujours vrai et il faut dire pourquoi :

```js
// The imagery is photogrammetry with lighting already baked in, so there is no
// lighting model: the sampled texel is the output, scaled by a single scalar
// when clouds are over the map (#22). That scalar carries no spatial structure
// on purpose — the geometry has no normals, and a projected pattern would
// argue with the shadows Apple baked into the texture.
```

Dans `sim/src/loader.js`, à côté de `setFog` :

```js
// L'assombrissement des nuages (#22). Même forme que setFog : le modèle vit
// dans cloud.js, ce fichier ne fait que le pousser sur chaque chunk.
export function setDim(dim) {
	for (const m of materials) m.uniforms.uDim.value = dim;
}
```

**Note pour l'implémenteur :** `setFog` itère sur une collection de matériaux ; reprendre **exactement** la même itération que `setFog` (lire `loader.js:40-45` et copier sa forme), sans en inventer une autre.

- [ ] **Step 4 : lancer le test pour vérifier qu'il passe**

Run: `cd sim && node tools/selftest.mjs`
Expected: PASS sur `un matériau de tuile neuf n'assombrit rien`.

Puis vérifier qu'on n'a rien cassé à l'image :

Run: `cd sim && npm run dev` puis ouvrir `http://localhost:5173/?scene=tour-eiffel`
Expected: la scène est **strictement identique** à avant. Aucun assombrissement n'est encore câblé, `uDim` vaut 1 partout. Si l'image a changé, c'est un bug, pas un effet.

- [ ] **Step 5 : commit**

```bash
cd sim && git add src/TileMaterial.js src/loader.js tools/selftest.mjs
git commit -m "Tuiles : uDim, l'assombrissement des nuages

Un scalaire, sans structure spatiale : la géométrie n'a pas de normales
et les tuiles portent déjà l'ombrage cuit d'Apple. Défaut 1.0,
bit-identique à l'absence de nuages.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4 : le dôme et son dégradé

Le dôme arrive **sans nuages**. C'est délibéré : le changement le plus risqué de ce plan est le remplacement de `scene.background`, et il doit être validé seul, avant qu'un FBM ne vienne masquer ce qu'il a cassé.

**Files:**
- Create: `sim/src/sky.js`
- Modify: `sim/src/main.js` (imports, instanciation près de la ligne 76, `weatherSky()` ligne 575, boucle de rendu lignes 655-675)

**Interfaces:**
- Consumes: `CloudField` (tâche 1) pour `cover` et `base`.
- Produces:
  - `class SkyDome` — `constructor(scene, { sky })` où `sky` est le hex `SKY` existant ; `setState({ cover, base, altitudeAGL, windDir, windSpeed, rainScale, fogMix })` ; `get horizon()` rendant un `THREE.Color` **muté, jamais remplacé** (`lens.js` garde une référence sur l'objet `scene.background`, même contrainte que le commentaire de `main.js:667`) ; `update(camera, dt)` ; `dispose()`.
  - Constantes exportées : `CLEAR_ZENITH`, `CLEAR_HORIZON`, `OVERCAST_ZENITH`, `OVERCAST_HORIZON`.

**Pourquoi `weatherSky()` descend dans `sky.js`.** Première rédaction de ce plan : `SkyDome` rendait sa couleur de socle, et `main.js` appliquait les lerps pluie/brouillard par-dessus pour `setFog()` et `scene.background`. Les tuiles lointaines se seraient donc fondues vers une couleur **que le dôme ne montrait pas** — exactement la ligne d'horizon dédoublée que D4 existe pour empêcher, réintroduite par la porte de derrière. Les lerps et les constantes `RAIN_SKY` / `FOG_SKY` déménagent donc dans `sky.js`, et `weatherSky()` disparaît de `main.js`. Une seule fonction décide toujours de la couleur de l'air ; elle habite maintenant à côté du dôme qui la peint.

- [ ] **Step 1 : écrire le test qui échoue**

Le rendu ne se teste pas en headless, mais l'invariant de couleur de D5, si — `THREE.Color` tourne en node. Ajouter à la section `nuages` de `selftest.mjs` :

```js
	// D5, l'invariant reformulé : le zénith gagne de la profondeur, mais la
	// couleur d'HORIZON par ciel clair reste exactement celle que la scène
	// utilisait avant qu'il y ait un ciel. C'est elle que setFog() pousse sur
	// les tuiles, donc c'est elle qui décide si la ligne d'horizon se dédouble.
	{
		const { CLEAR_HORIZON, CLEAR_ZENITH, OVERCAST_HORIZON } = await import('../src/sky.js');
		check('l\'horizon par ciel clair est exactement le SKY historique',
			CLEAR_HORIZON === 0x9fb8cc, `0x${CLEAR_HORIZON.toString(16)}`);
		// Un ciel clair est plus profond au zénith qu'à l'horizon : c'est de la
		// diffusion, pas un choix graphique. Garder le dégradé plat aurait été
		// le seul cas où le rendu serait faux.
		const lum = (h) => ((h >> 16 & 255) * 0.2126 + (h >> 8 & 255) * 0.7152 + (h & 255) * 0.0722);
		check('et le zénith clair est plus profond que son horizon',
			lum(CLEAR_ZENITH) < lum(CLEAR_HORIZON));
		check('un ciel couvert est plus terne qu\'un ciel clair',
			lum(OVERCAST_HORIZON) < lum(CLEAR_HORIZON) * 1.05);
	}
```

- [ ] **Step 2 : lancer le test pour vérifier qu'il échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot find module '.../src/sky.js'`.

- [ ] **Step 3 : écrire `src/sky.js`**

```js
// Le ciel : ce qu'on voit quand on lève les yeux, et la couleur que l'air a
// prise. Le pendant rendu de cloud.js, comme rainfall.js l'est de rain.js.
//
// C'est un dôme, pas un fond : une sphère BackSide de rayon 1 recollée sur la
// caméra à chaque frame, avec depthTest coupé. Rayon 1 et depth coupé rendent
// near et far hors sujet — rien ne peut clipper, et le dôme ne consomme pas de
// budget de profondeur.
//
// scene.background lui survit et change de sens : il porte désormais la couleur
// d'HORIZON du dôme. Le dôme couvre l'écran, donc ce fond n'est jamais vu — mais
// rainfall.js, lens.js et le HUD le lisent, et c'est aussi ce que setFog()
// pousse sur les tuiles. Une seule couleur d'air pour tout le monde, donc la
// ligne d'horizon ne se dédouble pas.

import * as THREE from 'three';

// ColorManagement est coupé et le rendu est en NoToneMapping (HANDOFF bug #10) :
// ces valeurs sont du sRGB, elles sortent telles quelles, il n'y a rien à
// convertir. Ne pas les passer par convertSRGBToLinear().
//
// CLEAR_HORIZON est exactement le SKY historique de main.js : c'est l'invariant
// que D5 protège, parce que c'est cette couleur-là que les tuiles lointaines
// rejoignent en se fondant.
export const CLEAR_HORIZON = 0x9fb8cc;
// Un ciel clair est plus profond au zénith qu'à l'horizon — c'est de la
// diffusion de Rayleigh sur une épaisseur d'air plus courte, pas un choix
// graphique. L'écart est délibérément modeste : la photogrammétrie d'Apple est
// cuite sous un ciel laiteux, et un zénith trop saturé ne lui ressemblerait plus.
export const CLEAR_ZENITH = 0x6d93bd;
// Un couvercle de stratus est presque plat et franchement plus terne. Il garde
// une trace de dégradé — le sol renvoie de la lumière sous la couche, donc le
// bas est toujours un peu plus clair.
export const OVERCAST_ZENITH = 0x8a8f94;
export const OVERCAST_HORIZON = 0xa8adb1;

// La pluie et le brouillard, déménagés depuis main.js : ils décalent la couleur
// de l'air, et l'air est ce que ce fichier peint. Les garder dans main.js
// laissait les tuiles se fondre vers une couleur que le dôme ne montrait pas.
const RAIN_SKY = 0x8d99a2;
const FOG_SKY = 0xc9d0d4;

// Les nuages eux-mêmes. Pas d'éclairage : la corrélation entre densité et
// luminosité suffit à les lire comme volumiques, et c'est tout ce qu'on peut
// faire sans normale.
const CLOUD_LIT = 0xf2f4f6;
const CLOUD_DARK = 0x9aa1a8;

// Taille des motifs, en mètres. Un cumulus fait quelques centaines de mètres ;
// c'est la première octave qui porte cette échelle, les suivantes la détaillent.
const FEATURE_SCALE = 420;

export class SkyDome {
	constructor(scene, { sky = CLEAR_HORIZON } = {}) {
		this._horizon = new THREE.Color(sky);
		this._zenith = new THREE.Color(CLEAR_ZENITH);
		this._drift = new THREE.Vector2(0, 0);
		this._windDir = 0;
		this._windSpeed = 0;

		this.material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			side: THREE.BackSide,
			depthTest: false,
			depthWrite: false,
			fog: false,
			uniforms: {
				uZenith: { value: this._zenith },
				uHorizon: { value: this._horizon },
				uCloudLit: { value: new THREE.Color(CLOUD_LIT) },
				uCloudDark: { value: new THREE.Color(CLOUD_DARK) },
				uCover: { value: 0 },
				uHeight: { value: 1e6 },     // mètres de la caméra à la base, signé
				uCamXZ: { value: new THREE.Vector2(0, 0) },
				uDrift: { value: this._drift },
				uScale: { value: 1 / FEATURE_SCALE },
			},
			vertexShader: /* glsl */`
				out vec3 vDir;
				void main() {
					// Sphère unité recollée sur la caméra sans rotation propre :
					// la position d'un sommet EST la direction de vue.
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform vec3 uZenith, uHorizon, uCloudLit, uCloudDark;
				uniform float uCover, uHeight, uScale;
				uniform vec2 uCamXZ, uDrift;

				in vec3 vDir;
				out vec4 outColor;

				void main() {
					vec3 d = normalize(vDir);
					// Dégradé. La racine tasse le dégradé vers l'horizon, où
					// l'épaisseur d'air traversée change vite ; en haut il est
					// presque uniforme, comme un vrai ciel.
					vec3 col = mix(uHorizon, uZenith, sqrt(clamp(d.y, 0.0, 1.0)));
					outColor = vec4(col, 1.0);
				}
			`,
		});

		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
		// Il passe avant tout le reste et ne teste pas la profondeur : il est le
		// fond. frustumCulled coupé parce que sa bounding sphere est calculée à
		// l'origine, pas là où on le déplace chaque frame.
		this.mesh.renderOrder = -1;
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;
		scene.add(this.mesh);
		this.scene = scene;
	}

	// La couleur de l'air, mutée et jamais remplacée : main.js pose cet objet
	// dans scene.background et lens.js en garde la référence (même contrainte
	// que le commentaire de main.js sur scene.background.set()).
	get horizon() { return this._horizon; }

	// Tout ce que le dôme a besoin de savoir du monde, en un appel. Rien n'est
	// remodélisé ici : cover et base viennent de CloudField, le vent de
	// physics.wind, rainScale et fogMix des modèles existants.
	setState({ cover = 0, base = 0, altitudeAGL = 0, windDir = 0, windSpeed = 0,
		rainScale = 1, fogMix = 0 } = {}) {
		this._windDir = windDir;
		this._windSpeed = windSpeed;
		this.material.uniforms.uCover.value = cover;
		// Signé : positif quand la couche est au-dessus de nous, négatif quand
		// on l'a percée. Le shader s'en sert pour savoir de quel côté regarder.
		this.material.uniforms.uHeight.value = base - altitudeAGL;
		this._applyColours(cover, rainScale, fogMix);
		return this;
	}

	// La couleur de l'air, en un seul endroit : la couverture pose le socle,
	// puis la pluie, puis le brouillard — dans cet ordre, celui de l'ancien
	// weatherSky(). Le zénith et l'horizon subissent le MÊME traitement, sinon
	// une averse creuserait un dégradé qui n'existe pas sous la pluie.
	_applyColours(cover, rainScale, fogMix) {
		const wet = Math.min(1, (rainScale - 1) * 1.2);
		this._zenith.setHex(CLEAR_ZENITH).lerp(_tmp.setHex(OVERCAST_ZENITH), cover)
			.lerp(_tmp.setHex(RAIN_SKY), wet).lerp(_tmp.setHex(FOG_SKY), fogMix);
		this._horizon.setHex(CLEAR_HORIZON).lerp(_tmp.setHex(OVERCAST_HORIZON), cover)
			.lerp(_tmp.setHex(RAIN_SKY), wet).lerp(_tmp.setHex(FOG_SKY), fogMix);
	}

	update(camera, dt) {
		// Le dôme suit la caméra en translation seulement : il ne tourne jamais,
		// donc les directions de vue restent des directions monde.
		this.mesh.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z);
		this.mesh.matrixWorld.copy(this.mesh.matrix);
		this.material.uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
		// La dérive, en mètres parcourus. Convention d'axes de wind.js : un vent
		// de secteur `dir` SOUFFLE vers (-sin, cos) — voir la note d'axes de
		// wind.js, et le check « un vent de nord souffle vers le sud » de
		// selftest.mjs qui la verrouille.
		const a = (this._windDir * Math.PI) / 180;
		this._drift.x += -Math.sin(a) * this._windSpeed * dt;
		this._drift.y += Math.cos(a) * this._windSpeed * dt;
		return this;
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.material.dispose();
	}
}

const _tmp = new THREE.Color();
```

Dans `sim/src/main.js` :

1. Import, à côté de celui de `fog.js` :

```js
import { CloudField } from './cloud.js';
import { SkyDome } from './sky.js';
```

2. Instanciation, à côté de `const fog = new FogField(...)` :

```js
// Et le ciel au-dessus : quelle fraction est couverte, à quelle hauteur, et de
// combien le sol s'assombrit. Le monde le décide (#41), pas un réglage.
const cloud = new CloudField();
```

3. Après `scene.background = new THREE.Color(SKY);` (ligne 76), ajouter :

```js
// Le dôme. scene.background reste posé au-dessus : il n'est plus jamais vu —
// le dôme couvre l'écran — mais il porte désormais la couleur d'HORIZON, que
// rainfall.js, lens.js et les tuiles lisent tous. Une seule couleur d'air.
const skyDome = new SkyDome(scene, { sky: SKY });
```

4. **Supprimer** `weatherSky()` (ligne 575) et les constantes `CLEAR_SKY`, `RAIN_SKY`, `FOG_SKY` (lignes 571-573) ainsi que le scratch `_sky` : leur logique vit désormais dans `SkyDome._applyColours()`, à côté du dôme qui la peint. `skyDome.horizon` rend directement la couleur d'air finale, pluie et brouillard compris.

**Note pour l'implémenteur :** vérifier avec `grep -n "CLEAR_SKY\|RAIN_SKY\|FOG_SKY\|weatherSky\|_sky\b" src/main.js` qu'il ne reste aucun appelant avant de supprimer. S'il en reste un, c'est un consommateur qu'on n'avait pas vu — le router vers `skyDome.horizon`, ne pas ressusciter la fonction.

5. Dans la boucle de rendu, dans le bloc `if (!frozen) {` (ligne 653), après `fog.update(dt);` :

```js
		cloud.update(dt);
		// L'altitude au-dessus du sol, pour le plafond. Prise par rapport au
		// spawn plutôt que par un raycast : la base des nuages est à des
		// centaines de mètres, le relief local est du bruit devant, et le
		// raycast de plus bas dans cette frame n'a pas encore eu lieu.
		const altitudeAGL = physics.position.y - spawnY;
```

puis, juste après, en passant la pluie et le brouillard au dôme dans le même appel :

```js
		skyDome.setState({
			cover: cloud.cover, base: cloud.base, altitudeAGL,
			windDir: physics.wind.direction, windSpeed: physics.wind.speed,
			rainScale: rain.fogScale, fogMix: fog.skyMix,
		});
```

puis remplacer `const sky = weatherSky(rain.fogScale, fog.skyMix);` par :

```js
		// La couleur que le dôme peint réellement cette frame : c'est elle que
		// les tuiles doivent rejoindre, et pas une autre.
		const sky = skyDome.horizon;
```

6. Toujours dans la boucle, **hors** du `if (!frozen)` (pour que le dôme reste recollé même en pause), juste avant `rainfall.update({...})` :

```js
	skyDome.update(camera, frozen ? 0 : dt);
```

**Note pour l'implémenteur :** trois accesseurs sont supposés ici et doivent être **vérifiés dans le code avant d'être écrits**, pas devinés — `physics.wind.direction` et `physics.wind.speed` dans `src/wind.js`, et `physics.position` dans `src/physics.js`. `main.js` manipule déjà une position sous le nom `p` dans la boucle ; si elle est disponible à cet endroit, la réutiliser plutôt que d'en redemander une. Ne pas inventer d'accesseur.

- [ ] **Step 4 : lancer les tests, puis vérifier en vol**

Run: `cd sim && node tools/selftest.mjs`
Expected: PASS sur les trois checks de couleur, total `all checks passed`.

Run: `cd sim && npm run dev` puis `http://localhost:5173/?scene=tour-eiffel`
Expected, et c'est **le point de contrôle le plus important du plan** :
- le ciel est un dégradé : plus profond en haut, `#9fb8cc` à l'horizon ;
- **la ligne d'horizon ne se dédouble pas** — le fondu des tuiles lointaines rejoint exactement la couleur du dôme, sans liseré ni saut ;
- le dôme ne clippe jamais, quelle que soit l'orientation ou l'altitude ;
- il ne masque rien : aucune tuile, aucune goutte, aucun élément de HUD ne disparaît derrière ;
- l'image au sol est **strictement inchangée**.

Si un liseré apparaît à l'horizon, ne pas le corriger en décalant une couleur : c'est que `setFog()` et le dôme ne reçoivent pas la même valeur. Remonter au câblage.

- [ ] **Step 5 : commit**

```bash
cd sim && git add src/sky.js src/main.js tools/selftest.mjs
git commit -m "Ciel : le dôme et son dégradé

Sphère BackSide de rayon 1 recollée sur la caméra, depthTest coupé.
scene.background survit et porte désormais la couleur d'horizon, que
les tuiles, rainfall.js et lens.js lisent tous — une seule couleur d'air,
donc pas de ligne d'horizon dédoublée. Sans nuages encore : ce
remplacement se valide seul.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5 : les nuages dans le dôme

**Files:**
- Modify: `sim/src/sky.js` (fragment shader uniquement)

**Interfaces:**
- Consumes: les uniformes posés en tâche 4 (`uCover`, `uHeight`, `uCamXZ`, `uDrift`, `uScale`, `uCloudLit`, `uCloudDark`).
- Produces: aucune API nouvelle. C'est un changement purement interne au shader.

Pas de test qui échoue en tête de cette tâche, et c'est délibéré : un fragment shader ne s'exécute pas sans contexte WebGL, donc il n'y a rien qu'un check headless puisse observer. Le harnais de non-régression a été posé en tâche 4 ; ici le cycle de vérification est le navigateur, et l'étape 2 est la non-régression AVANT toute vérification d'effet — le même ordre que TDD, avec un autre outil.

- [ ] **Step 1 : écrire le fragment shader**

Remplacer intégralement le `fragmentShader` de `sim/src/sky.js` par :

```glsl
				uniform vec3 uZenith, uHorizon, uCloudLit, uCloudDark;
				uniform float uCover, uHeight, uScale;
				uniform vec2 uCamXZ, uDrift;

				in vec3 vDir;
				out vec4 outColor;

				float hash21(vec2 p) {
					p = fract(p * vec2(123.34, 456.21));
					p += dot(p, p + 45.32);
					return fract(p.x * p.y);
				}

				float vnoise(vec2 p) {
					vec2 i = floor(p), f = fract(p);
					vec2 u = f * f * (3.0 - 2.0 * f);
					float a = hash21(i);
					float b = hash21(i + vec2(1.0, 0.0));
					float c = hash21(i + vec2(0.0, 1.0));
					float d = hash21(i + vec2(1.0, 1.0));
					return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
				}

				// Somme des amplitudes 0.5 + 0.25 + ... sur cinq octaves.
				// Diviser par elle ramène le FBM dans [0, 1], donc le seuil de
				// couverture plus bas peut être exact plutôt qu'approché.
				const float FBM_NORM = 0.96875;

				float fbm(vec2 p) {
					float v = 0.0, a = 0.5;
					for (int i = 0; i < 5; i++) {
						// Chaque octave dérive un peu plus que la précédente, donc
						// la couche se DÉFORME au lieu de glisser comme une plaque
						// rigide. C'est le seul endroit où les nuages vivent.
						v += a * vnoise(p + uDrift * uScale * (1.0 + float(i) * 0.35));
						// 2.03 et pas 2.0 : un doublement exact réaligne les octaves
						// sur le même réseau et imprime une grille visible.
						p = p * 2.03 + 17.1;
						a *= 0.5;
					}
					return v / FBM_NORM;
				}

				void main() {
					vec3 d = normalize(vDir);
					vec3 col = mix(uHorizon, uZenith, sqrt(clamp(d.y, 0.0, 1.0)));

					// De quel côté est la couche. uHeight est signé : positif tant
					// qu'elle est au-dessus, négatif une fois qu'on l'a percée — et
					// alors on la regarde vers le BAS. Ça coûte un signe, et c'est
					// la récompense d'un plafond traversable.
					float dy = (uHeight >= 0.0) ? d.y : -d.y;

					// Sous l'horizon du bon côté, il n'y a rien à dessiner : les
					// tuiles couvrent cette zone de toute façon.
					if (dy > 0.001) {
						// Intersection du rayon de vue avec le plan horizontal de
						// la base. C'est ça qui fait converger les nuages à
						// l'horizon sans qu'on ait à le programmer.
						vec2 p = uCamXZ + d.xz * (abs(uHeight) / dy);

						// Le seuil de couverture. Les bornes sont choisies pour que
						// les deux extrémités soient EXACTES : à uCover = 0 le bord
						// est à 1.18 et aucune valeur du FBM ne peut le franchir
						// (D5, ciel clair = rien du tout) ; à uCover = 1 il est à
						// -0.18 et tout le franchit.
						float w = 0.18;
						float edge = mix(1.0 + w, -w, uCover);
						float density = smoothstep(edge - w, edge + w, fbm(p * uScale));

						// Quand dy tend vers 0 le point d'échantillonnage part à
						// l'infini. On fond sur les derniers degrés — ce qui est
						// aussi ce que fait l'atmosphère, les nuages se compriment
						// en bande à l'horizon. La dégénérescence numérique et le
						// rendu juste sont le même geste.
						density *= smoothstep(0.0, 0.14, dy);

						// Pas d'éclairage, pas de normale : les paquets épais sont
						// plus sombres, et cette seule corrélation suffit à les
						// lire comme volumiques.
						col = mix(col, mix(uCloudLit, uCloudDark, density), density);
					}

					outColor = vec4(col, 1.0);
				}
```

- [ ] **Step 2 : vérifier en vol le ciel clair — la non-régression d'abord**

Run: `cd sim && npm run dev` puis `http://localhost:5173/?scene=tour-eiffel`
Expected: par temps neutre (`cover = 0`), le ciel est **exactement** le dégradé de la tâche 4. Pas un seul nuage, pas un voile, pas une tache. Si quoi que ce soit apparaît, le seuil `edge` est faux et D5 est violé — corriger là, pas ailleurs.

- [ ] **Step 3 : vérifier en vol les nuages**

Dans la console du navigateur, forcer la couverture par le canal de debug :

```js
__sim.cloud.setParams({ cover: 0.5, variability: 0.6 });
```

Expected :
- des nuages identifiables, à une échelle de quelques centaines de mètres ;
- ils **convergent vers l'horizon**, ils ne sont pas plaqués à taille constante ;
- aucune grille visible, aucun motif qui se répète de façon évidente ;
- pas de couture ni de scintillement quand on tourne la caméra.

Puis à `cover: 0.95` : le ciel est bouché, une plaque continue avec de la structure.
Puis à `cover: 1` : entièrement couvert, sans trou.

- [ ] **Step 4 : vérifier la dérive et la déformation**

```js
__sim.setWind({ x: 8, y: 0, z: 0 }, 0);
__sim.cloud.setParams({ cover: 0.6, variability: 0.5 });
```

Expected : la couche **dérive** dans le sens du vent, et les motifs se **déforment** lentement au lieu de translater en bloc. Vérifier que le sens est le bon, en s'appuyant sur la convention d'axes de `wind.js` (le check « un vent de nord souffle vers le sud » de `selftest.mjs` la verrouille). Un sens inversé est un bug, pas une préférence.

- [ ] **Step 5 : commit**

```bash
cd sim && git add src/sky.js
git commit -m "Ciel : la couche nuageuse

FBM cinq octaves haché dans le shader, échantillonné à l'intersection du
rayon de vue avec le plan de la base — d'où la convergence à l'horizon,
gratuite. Dérive et déformation prises sur le vent. Le seuil de
couverture est exact aux deux bouts : ciel clair = aucun pixel de nuage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6 : le plafond et l'assombrissement, câblés

**Files:**
- Modify: `sim/src/main.js` (boucle de rendu, lignes ~655-675 ; bloc de debug `window.__sim` lignes ~349-360 et ~410-413)

**Interfaces:**
- Consumes: `cloud.extinctionAt()` et `cloud.dim` (tâche 1), `setDim()` (tâche 3), `skyDome` (tâche 4).
- Produces: `window.__sim.cloud` exposé, et le bloc d'état gagne `cloudCover`, `cloudBase`, `ceilingAGL`.

- [ ] **Step 1 : câbler l'extinction et l'assombrissement**

Dans `sim/src/main.js`, dans la boucle de rendu, remplacer la ligne qui calcule `density` par :

```js
		// Les extinctions s'additionnent, donc les densités s'additionnent. Le
		// plafond est le troisième terme, après l'air et la pluie : entrer dans
		// un nuage EST un voile uniforme, il n'y a pas de gradient à voir depuis
		// l'intérieur, donc le piloter par l'altitude de la caméra plutôt que
		// par fragment est juste ici — et gratuit, puisque ce terme est déjà
		// poussé une fois par frame.
		const density = fog.density + extinctionOf(rain.visibility) + cloud.extinctionAt(altitudeAGL);
```

Ajouter `lastDim` à côté de `lastDensity` et `lastSkyHex` (ligne ~556) :

```js
let lastDim = 1;
```

et dans le bloc de mise à jour conditionnelle, après `rainfall?.setSky(scene.background);`, refermer puis ajouter :

```js
		// Même motif que le fondu : on ne retouche pas chaque matériau de chunk
		// à chaque frame pour une valeur qui bouge sur des minutes.
		if (cloud.dim !== lastDim) {
			lastDim = cloud.dim;
			setDim(cloud.dim);
		}
```

**Note pour l'implémenteur :** `setDim` doit être ajouté à l'import existant depuis `./loader.js` en tête de `main.js`, à côté de `setFog`.

- [ ] **Step 2 : exposer le canal de debug**

Dans le bloc `window.__sim`, à côté de `fog` et `rain`, ajouter `cloud`, et dans le bloc d'état retourné (là où `range`, `density` et `glare` sont posés, ligne ~410) ajouter :

```js
					cloudCover: +cloud.cover.toFixed(3),
					cloudBase: Math.round(cloud.base),
					// Négatif tant qu'on est sous le plafond, positif une fois
					// dedans ou au-dessus. C'est le chiffre qu'on regarde quand
					// on vérifie qu'un whiteout arrive au bon moment.
					ceilingAGL: Math.round((physics.position.y - spawnY) - cloud.base),
```

- [ ] **Step 3 : vérifier le monde neutre**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`.

Run: `cd sim && npm run dev` puis `http://localhost:5173/?scene=tour-eiffel`
Expected: par temps neutre, l'image au sol est **strictement inchangée** et la portée de visibilité affichée par le HUD est la même qu'avant cette tâche. `__sim` doit confirmer :

```js
__sim.state().cloudCover   // 0
__sim.state().density      // identique à la valeur d'avant la tâche
```

- [ ] **Step 4 : vérifier l'assombrissement et le plafond en vol**

```js
__sim.cloud.setParams({ cover: 0.9, variability: 0.4 });
```

Expected :
- le sol s'assombrit visiblement mais **reste parfaitement lisible** — on doit encore pouvoir voler à la texture ;
- l'assombrissement est **uniforme**, sans aucune tache ni motif (D0) ;
- il **respire** lentement sur quelques minutes de vol, sans à-coup ni palier visible (D3) — c'est le « soleil masqué temporairement ».

Puis monter vers le plafond en surveillant `__sim.state().ceilingAGL` :

Expected :
- rien ne change tant que `ceilingAGL` est très négatif ;
- une laiteuse s'installe dans les dernières dizaines de mètres avant 0 ;
- autour de 0 et au-dessus, whiteout : le sol disparaît ;
- **en continuant à monter, on ressort au-dessus de la couche** et la visibilité revient (D1).

Vérifier aussi qu'une fois **au-dessus**, les nuages du dôme apparaissent bien **sous** l'horizon et non au-dessus.

- [ ] **Step 5 : commit**

```bash
cd sim && git add src/main.js
git commit -m "Ciel : câbler le plafond et l'assombrissement

L'extinction du plafond s'ajoute à celles de l'air et de la pluie — les
extinctions s'additionnent. uDim poussé sur les chunks sur le même motif
de détection de changement que le fondu. __sim expose cloudCover,
cloudBase et ceilingAGL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7 : calibrer `DIM_MAX`, documenter, clore

C'est la tâche que D6 réserve. `DIM_MAX` est aujourd'hui à `0.72`, une valeur **posée et non mesurée**. Elle se mesure ici.

**Files:**
- Modify: `sim/src/cloud.js` (la constante `DIM_MAX` et son commentaire)
- Modify: `sim/HANDOFF.md`
- Modify: `sim/tools/selftest.mjs` si le seuil du check de lisibilité doit suivre

- [ ] **Step 1 : mesurer**

En vol, sur au moins **deux scènes différentes** (les textures d'Apple n'ont pas la même exposition partout — une scène claire et une scène sombre ne tolèrent pas le même assombrissement) :

```js
__sim.cloud.setParams({ cover: 1, variability: 0 });
```

Faire varier `DIM_MAX` par rechargement, et chercher **la valeur la plus basse qui garde la photogrammétrie lisible en vol** — le critère est opérationnel, pas esthétique : on doit encore distinguer les obstacles assez tôt pour les éviter à vitesse de croisière. Voler réellement le circuit, pas regarder une capture fixe.

Noter la valeur retenue, les deux scènes testées, et le critère.

- [ ] **Step 2 : figer la constante**

Remplacer le commentaire `// D6 — PROVISOIRE, à calibrer en vol` par la valeur mesurée et sa justification, dans la forme du dépôt — ce que le nombre vaut, et **comment il a été obtenu** :

```js
// Mesuré, pas choisi. La radiométrie dit qu'un ciel couvert laisse passer 15 à
// 30 % de l'éclairement du ciel clair ; l'appliquer casserait l'image, parce
// que la photogrammétrie est cuite avec un éclairage ensoleillé, qu'on ne peut
// pas la ré-éclairer, et qu'on vole *à* cette texture. La contrainte n'est donc
// pas l'éclairement mais la lisibilité : c'est la valeur la plus basse à
// laquelle on distingue encore un obstacle assez tôt pour l'éviter à vitesse de
// croisière, mesurée en vol sur <scène claire> et <scène sombre>.
export const DIM_MAX = <valeur mesurée>;
```

Si la valeur mesurée descend sous `0.5`, ajuster le seuil du check `il n'assombrit jamais au point de rendre l'image illisible` dans `selftest.mjs` — mais seulement après avoir vérifié que la mesure est bien reproductible sur les deux scènes.

- [ ] **Step 3 : vérifier**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`, y compris `couvert plein : l'assombrissement atteint DIM_MAX`, qui lit la constante et suit donc automatiquement.

- [ ] **Step 4 : documenter**

Dans `sim/HANDOFF.md`, ajouter à l'état **vérifié** :

- le ciel est un dôme dégradé avec couche nuageuse procédurale, couverture pilotée par `cloudPct` du world state ;
- plafond traversable, whiteout à l'approche, sortie au-dessus de la couche ;
- assombrissement global du sol sans motif, `DIM_MAX` mesuré en vol (donner la valeur et les scènes) ;
- l'invariant historique « le pixel de ciel sort `#9fb8cc` » est **reformulé** : c'est désormais la couleur d'**horizon** par ciel clair qui vaut exactement `#9fb8cc`, et c'est elle que `setFog()` pousse sur les tuiles. Le zénith est plus profond, délibérément.

et à l'état **non vérifié** ce qui n'a pas été mesuré : le coût en fill rate du dôme à FOV 120 sur GPU modeste, et le comportement à très haute altitude au-dessus de la couche.

- [ ] **Step 5 : commit, pousser, clore**

```bash
cd sim && git add src/cloud.js tools/selftest.mjs HANDOFF.md
git commit -m "Nuages : DIM_MAX mesuré en vol, HANDOFF à jour

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin issue-22-nuages-ciel
```

Puis, depuis la racine du dépôt :

```bash
gh issue comment 22 --repo lionrayonnant/FPVTP --body "<résumé : ce qui est livré, la décision D0 sur les ombres et pourquoi, la valeur mesurée de DIM_MAX, et l'invariant #9fb8cc reformulé>"
```

**Ne pas fermer l'issue sans revue.** Le volet « ombres portées » de son titre est livré autrement que ce que le titre annonce (D0), et cette substitution doit être visible et acceptée avant clôture. Passer l'issue en `Done` sur le Project 2 seulement après.

---

## Suivi à ouvrir

À créer comme issues plutôt qu'à laisser en TODO dans le code, conformément au workflow du dépôt :

- **Effet du plafond sur l'air.** Une couche nuageuse basse s'accompagne d'une inversion et d'une turbulence sous la couche. Cette spec ne touche pas à l'aérodynamique ; le lien plafond → `wind.js` est un vrai sujet, et il est distinct.
- **Nuages et rendu de la pluie.** `rainfall.js` colore ses stries avec la couleur du ciel, qui devient maintenant un dégradé. Il lit l'horizon, ce qui est le bon choix par défaut, mais mérite d'être regardé sous une averse par ciel bouché.
- **Coût en fill rate.** Le dôme ajoute un plein écran de fragments à FOV 120. À mesurer sur GPU modeste, et à optimiser (rendu en demi-résolution) seulement si la mesure le demande.
