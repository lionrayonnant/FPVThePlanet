# Soleil — plan d'implémentation (issue #23)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** donner au sim un soleil réel — position depuis lat/lon et heure, ciel dont la couleur en est dérivée, éblouissement et exposition automatique dans la passe `lens.js` — sans jamais ré-éclairer la géométrie photogrammétrique.

**Architecture:** un modèle pur `src/sun.js` (aucun THREE, aucun DOM, comme `wind.js`/`rain.js`/`fog.js`) calcule la position solaire NOAA, l'extinction atmosphérique et un AGC de caméra ; `lens.js` gagne un bloc `#if SUN` dans sa passe unique ; `main.js` câble les deux et rend la couleur du ciel dynamique là où elle était une constante.

**Tech Stack:** JavaScript ES modules, Three.js r16x, GLSL (WebGL2), Rapier (via `physics.obstructionBetween`), `node tools/selftest.mjs` comme banc headless.

**Spec:** `sim/docs/superpowers/specs/2026-08-29-soleil-issue-23-design.md`

## Global Constraints

- Toutes les tâches se font depuis `sim/`. Branche `issue-23-soleil`.
- `src/sun.js` est **pur** : aucun `import * as THREE`, aucun DOM, aucun `node:`. C'est la condition pour que `tools/selftest.mjs` puisse l'importer.
- Convention d'axes après `prep.mjs` : **X = est, Y = haut, Z = sud**. Un azimut A horaire depuis le nord et une élévation E donnent `dir = (sin A·cos E, sin E, −cos A·cos E)`.
- **Aucune** lumière Three.js, aucun `scene.environment`, aucun `renderer.shadowMap`, aucun calcul de normales. La géométrie n'est jamais ré-éclairée.
- `THREE.ColorManagement.enabled = false` et `NoToneMapping` : les octets sRGB traversent le pipeline sans conversion. Toute couleur calculée ici est directement l'octet affiché. Ne rien ré-encoder.
- Constante de référence : `SKY = 0x9fb8cc` dans `main.js:35`. Le calibrage doit la reproduire **exactement** pour un soleil à 60°, ciel clair, 0 % de nuage, visibilité 25 000 m.
- Commentaires en français pour le code neuf (convention des fichiers récents : `entry-state.js`, `weather.js`, `hack.js`).
- Indentation : **tabulations**, comme tout le dépôt.
- `npm run selftest` doit rester vert à la fin de chaque tâche.
- Un commit par tâche.

---

## Structure des fichiers

| fichier | responsabilité |
|---|---|
| `src/sun.js` (créé) | position solaire, extinction atmosphérique, couleur du ciel, AGC. Pur. |
| `tools/selftest.mjs` (modifié) | nouvelle section `soleil` |
| `tools/lib/weather.mjs` (modifié) | `toSimParams()` gagne un bloc `sun` |
| `src/weather.js` (modifié) | `applyWeather()` écrit dans `SunField` ; `CALM` gagne son bloc `sun` |
| `src/lens.js` (modifié) | uniformes + `setSun()` + bloc `#if SUN` |
| `src/main.js` (modifié) | instanciation, ciel dynamique, occlusion, `__sim.debug().sun` |
| `HANDOFF.md`, `README.md` (modifiés) | état vérifié |

---

## Task 1 : position solaire, réfraction, masse d'air

**Files:**
- Create: `src/sun.js`
- Test: `tools/selftest.mjs` (nouvelle section, à la fin, avant le `console.log` final)

**Interfaces:**
- Consumes: rien.
- Produces: `sunPosition({ lat, lon, date }) -> { elevation, azimuth, declination, hourAngle, eqTime }` (radians, sauf `eqTime` en minutes) ; `sunVector(azimuth, elevation) -> { x, y, z }` ; `refracted(elevationDeg) -> number` (degrés) ; `airMass(elevationDeg) -> number` ; les constantes `D2R`, `R2D`.

- [ ] **Step 1 : écrire les checks qui échouent**

Dans `tools/selftest.mjs`, ajouter l'import en tête, à la suite des autres :

```js
import { sunPosition, sunVector, refracted, airMass } from '../src/sun.js';
```

Puis, à la fin du fichier, juste **avant** le `console.log(`\n${failures === 0 ...`)` final :

```js
console.log('\nsoleil — position');
{
	const R2D = 180 / Math.PI;
	// L'obliquité de l'écliptique : ce qui rend les attentes ci-dessous
	// analytiques et non des sorties du code recopiées.
	const OBLIQUITY = 23.44;

	// Balaye une journée UTC minute par minute et rend le maximum d'élévation.
	// C'est le midi solaire, sans avoir à connaître le fuseau du lieu.
	function noon(lat, lon, dayISO) {
		let best = -Infinity, at = null;
		for (let m = 0; m < 1440; m++) {
			const d = new Date(`${dayISO}T00:00:00Z`);
			d.setUTCMinutes(m);
			const p = sunPosition({ lat, lon, date: d });
			if (p.elevation > best) { best = p.elevation; at = d; }
		}
		return { elevationDeg: best * R2D, at };
	}

	const PARIS = { lat: 48.8566, lon: 2.3522 };
	const TOKYO = { lat: 35.6762, lon: 139.6503 };
	const SYDNEY = { lat: -33.8688, lon: 151.2093 };

	// Au solstice, l'élévation méridienne vaut 90° − |latitude − déclinaison|,
	// et la déclinaison vaut ±l'obliquité. Aucune table à consulter.
	const cases = [
		['Paris, solstice d\'été', PARIS, '2026-06-21', 90 - Math.abs(PARIS.lat - OBLIQUITY)],
		['Paris, solstice d\'hiver', PARIS, '2026-12-21', 90 - Math.abs(PARIS.lat + OBLIQUITY)],
		['Tokyo, solstice d\'été', TOKYO, '2026-06-21', 90 - Math.abs(TOKYO.lat - OBLIQUITY)],
		['Sydney, solstice de décembre', SYDNEY, '2026-12-21', 90 - Math.abs(SYDNEY.lat + OBLIQUITY)],
	];
	for (const [label, place, day, expected] of cases) {
		const n = noon(place.lat, place.lon, day);
		check(`${label} : élévation méridienne`, Math.abs(n.elevationDeg - expected) < 0.3,
			`${n.elevationDeg.toFixed(2)}° vs ${expected.toFixed(2)}°`);
	}

	// À l'équinoxe la déclinaison est nulle, donc l'élévation méridienne vaut
	// 90° − latitude quelle que soit la longitude.
	const eq = noon(PARIS.lat, PARIS.lon, '2026-03-20');
	check('Paris, équinoxe : élévation méridienne = 90° − latitude',
		Math.abs(eq.elevationDeg - (90 - PARIS.lat)) < 0.3,
		`${eq.elevationDeg.toFixed(2)}° vs ${(90 - PARIS.lat).toFixed(2)}°`);

	// LE piège de l'issue. Z est le SUD après prep.mjs : au midi solaire dans
	// l'hémisphère nord le soleil est plein sud, donc z > 0 et x ≈ 0. Se
	// tromper de signe ici mettrait silencieusement le soleil dans le mauvais
	// demi-ciel, et rien d'autre ne l'attraperait.
	{
		const p = sunPosition({ lat: PARIS.lat, lon: PARIS.lon, date: eq.at });
		const v = sunVector(p.azimuth, p.elevation);
		check('convention d\'axes : midi solaire au nord ⇒ le soleil est au sud (z > 0)',
			v.z > 0.5 && Math.abs(v.x) < 0.05, `z=${v.z.toFixed(3)} x=${v.x.toFixed(3)}`);
		check('azimut au midi solaire ≈ 180° (plein sud)',
			Math.abs(p.azimuth * R2D - 180) < 1, `${(p.azimuth * R2D).toFixed(2)}°`);
		check('le vecteur solaire est unitaire',
			Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9);
	}
	{
		const n = noon(SYDNEY.lat, SYDNEY.lon, '2026-12-21');
		const p = sunPosition({ lat: SYDNEY.lat, lon: SYDNEY.lon, date: n.at });
		const v = sunVector(p.azimuth, p.elevation);
		check('hémisphère sud : midi solaire ⇒ le soleil est au nord (z < 0)',
			v.z < -0.05, `z=${v.z.toFixed(3)}`);
	}

	// Réfraction : elle relève le soleil, d'environ un demi-degré à l'horizon,
	// et de presque rien au zénith.
	check('la réfraction relève le soleil à l\'horizon d\'environ 0,5°',
		refracted(0) - 0 > 0.4 && refracted(0) - 0 < 0.7, `${(refracted(0)).toFixed(3)}°`);
	check('la réfraction est négligeable au zénith',
		Math.abs(refracted(90) - 90) < 0.01, `${refracted(90).toFixed(4)}°`);

	// Masse d'air : 1 au zénith par définition, ~2 à 30°, et FINIE à l'horizon —
	// c'est tout l'intérêt de Kasten & Young sur 1/sin h, qui y diverge.
	check('masse d\'air = 1 au zénith', Math.abs(airMass(90) - 1) < 0.002, airMass(90).toFixed(4));
	check('masse d\'air ≈ 2 à 30° d\'élévation', Math.abs(airMass(30) - 2) < 0.02, airMass(30).toFixed(3));
	check('masse d\'air finie et < 40 à l\'horizon',
		Number.isFinite(airMass(0)) && airMass(0) > 30 && airMass(0) < 40, airMass(0).toFixed(2));
	check('la masse d\'air croît quand le soleil descend',
		airMass(10) > airMass(30) && airMass(30) > airMass(60));
}
```

- [ ] **Step 2 : lancer et vérifier que ça échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot find module '.../src/sun.js'`.

- [ ] **Step 3 : écrire `src/sun.js`**

```js
// Le soleil, comme modèle : où il est, ce que l'atmosphère lui fait, et ce que
// la caméra en fait.
//
// Ni THREE, ni DOM, ni `node:` — même règle et même raison que wind.js, rain.js
// et fog.js : c'est la moitié que tools/selftest.mjs peut vérifier sans
// navigateur. lens.js dessine, main.js câble.
//
// L'imagerie est de la photogrammétrie NON éclairée, avec son ombrage cuit dans
// les textures (TileMaterial.js). Ce fichier ne ré-éclaire donc RIEN : il ne
// produit qu'une direction, une couleur de ciel et un gain d'exposition. Un
// soleil mobile qui ré-éclairerait la ville la double-ombrerait avec les ombres
// du survol d'Apple, et c'est la décision d'architecture de l'issue #23.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Position
//
// Algorithme NOAA (Solar Position Calculator), lui-même tiré des Astronomical
// Algorithms de Meeus. Meilleur que 0,02° sur les dates qui nous concernent —
// très au-delà de ce qu'un disque solaire de 0,5° demande, mais c'est
// l'algorithme standard et il n'y a rien à gagner à l'approximer.

// Jour julien depuis un instant. Date.getTime() est en UTC par construction, ce
// qui est exactement ce qu'il faut : la position du soleil est fonction de
// l'instant absolu et de la position géodésique, et d'AUCUN fuseau horaire.
// C'est ce qui permet au sim de n'avoir ni base de fuseaux ni réglage d'heure.
function julianDay(date) {
	return date.getTime() / 86400000 + 2440587.5;
}

export function sunPosition({ lat, lon, date = new Date() }) {
	const jd = julianDay(date);
	const t = (jd - 2451545) / 36525;                         // siècles juliens depuis J2000

	const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;   // longitude moyenne
	const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);            // anomalie moyenne
	const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);       // excentricité
	const Mr = M * D2R;

	// Équation du centre : l'écart entre l'anomalie moyenne et la vraie, dû à
	// l'ellipticité de l'orbite.
	const C = Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
		+ Math.sin(2 * Mr) * (0.019993 - 0.000101 * t)
		+ Math.sin(3 * Mr) * 0.000289;

	const trueLong = L0 + C;
	// Nutation en longitude, réduite à son terme dominant.
	const omega = 125.04 - 1934.136 * t;
	const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);

	const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
	const eps = eps0 + 0.00256 * Math.cos(omega * D2R);       // obliquité corrigée

	const declination = Math.asin(Math.sin(eps * D2R) * Math.sin(appLong * D2R));

	// Équation du temps, en minutes : de combien le soleil vrai est en avance ou
	// en retard sur le soleil moyen. C'est elle qui fait qu'un midi solaire n'est
	// pas à midi, et l'ignorer décalerait le soleil de ±16 minutes selon la
	// saison — soit jusqu'à 4° d'azimut.
	const y = Math.tan(eps * D2R / 2) ** 2;
	const eqTime = 4 * R2D * (y * Math.sin(2 * L0 * D2R)
		- 2 * e * Math.sin(Mr)
		+ 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * D2R)
		- 0.5 * y * y * Math.sin(4 * L0 * D2R)
		- 1.25 * e * e * Math.sin(2 * Mr));

	// Minutes écoulées depuis minuit UTC. Le −0,5 ramène le jour julien (qui
	// commence à midi) sur le jour civil.
	const utcMinutes = (((jd - 0.5) % 1) + 1) % 1 * 1440;
	const trueSolarMinutes = utcMinutes + eqTime + 4 * lon;   // 4 min par degré de longitude
	let ha = trueSolarMinutes / 4 - 180;                      // angle horaire, degrés
	if (ha < -180) ha += 360;
	if (ha > 180) ha -= 360;

	const phi = lat * D2R;
	const har = ha * D2R;
	const cosZenith = Math.sin(phi) * Math.sin(declination)
		+ Math.cos(phi) * Math.cos(declination) * Math.cos(har);
	const elevation = Math.PI / 2 - Math.acos(clamp(cosZenith, -1, 1));

	// Azimut horaire depuis le nord — la convention de l'issue, et celle d'une
	// boussole. Le +π vient de ce que atan2 sous cette forme rend l'azimut
	// depuis le SUD.
	let azimuth = Math.atan2(Math.sin(har),
		Math.cos(har) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) + Math.PI;
	azimuth = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

	return { elevation, azimuth, declination, hourAngle: har, eqTime };
}

// ---------------------------------------------------------------------------
// Direction dans les axes du sim
//
// LE piège de cette issue. Après prep.mjs : X = est, Y = haut, Z = SUD. Le Z
// positif vers le sud est l'inverse de la convention habituelle et mettrait
// silencieusement le soleil dans le mauvais demi-ciel — rien d'autre dans le
// sim ne le remarquerait. Le selftest le vérifie explicitement, pour toujours.
export function sunVector(azimuth, elevation) {
	const ce = Math.cos(elevation);
	return { x: Math.sin(azimuth) * ce, y: Math.sin(elevation), z: -Math.cos(azimuth) * ce };
}

// ---------------------------------------------------------------------------
// Optique atmosphérique

// Réfraction astronomique, Bennett (1982), en degrés. Elle relève le soleil
// d'environ 0,57° à l'horizon — c'est-à-dire d'un peu plus que son propre
// diamètre, raison pour laquelle on le voit encore quand il est géométriquement
// couché. Gardée séparée de sunPosition() parce que l'une est de l'astronomie et
// l'autre de l'optique : le rendu veut le soleil qu'on VOIT.
export function refracted(elevationDeg) {
	return elevationDeg + (1 / Math.tan((elevationDeg + 7.31 / (elevationDeg + 4.4)) * D2R)) / 60;
}

// Masse d'air relative, Kasten & Young (1989). 1/sin h diverge à l'horizon,
// là où la vraie masse d'air plafonne à ~38 ; c'est toute la raison de cette
// formule plutôt que de la naïve.
export function airMass(elevationDeg) {
	const h = Math.max(elevationDeg, 0);
	return 1 / (Math.sin(h * D2R) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}
```

- [ ] **Step 4 : lancer et vérifier que ça passe**

Run: `cd sim && node tools/selftest.mjs 2>&1 | sed -n '/soleil — position/,$p'`
Expected: toutes les lignes `PASS`, et le total du fichier reste `all checks passed`.

- [ ] **Step 5 : commit**

```bash
git add src/sun.js tools/selftest.mjs
git commit -m "Soleil : position NOAA, réfraction, masse d'air (issue #23)

La convention d'axes (Z = sud) est vérifiée explicitement : c'est le seul
endroit où on peut se tromper de demi-ciel sans que rien ne le remarque.
Les attentes du banc sont analytiques (90° − |lat − obliquité| au solstice),
pas des sorties du code recopiées."
```

---

## Task 2 : extinction, couleur du ciel, calibrage

**Files:**
- Modify: `src/sun.js`
- Test: `tools/selftest.mjs`

**Interfaces:**
- Consumes: `refracted()`, `airMass()`, `D2R` de la tâche 1.
- Produces:
  - `TAU_RAYLEIGH: number[3]`, `REF_ELEV = 60`, `REF_VIS = 25000`, `SKY_REF = 0x9fb8cc`
  - `tauAerosol(visibilityM) -> number[3]`
  - `transmittance(airMass, visibilityM) -> number[3]`
  - `skyChroma(elevationDeg, visibilityM, cloudPct) -> number[3]` (somme ≈ 1 hors nuit)
  - `ambientLevel(elevationDeg, cloudPct) -> number` (1 à la référence)
  - `skyLevel(elevationDeg, cloudPct) -> number` (1 à la référence)
  - `skyColor(elevationDeg, visibilityM, cloudPct) -> { r, g, b }` (0..1, déjà balancée)
  - `sunDisc(elevationDeg, visibilityM, cloudPct) -> { color: {r,g,b}, amount: number }`

- [ ] **Step 1 : écrire les checks qui échouent**

Compléter l'import dans `tools/selftest.mjs` :

```js
import {
	sunPosition, sunVector, refracted, airMass,
	transmittance, skyColor, skyChroma, ambientLevel, skyLevel, sunDisc,
	REF_ELEV, REF_VIS, SKY_REF,
} from '../src/sun.js';
```

Et ajouter, après la section `soleil — position` :

```js
console.log('\nsoleil — atmosphère et couleur du ciel');
{
	const byte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
	const hex = (c) => (byte(c.r) << 16) | (byte(c.g) << 8) | byte(c.b);
	const CLEAR = REF_VIS;

	// LE check de non-régression visuelle. Le modèle mono-diffusion ne retombe
	// pas spontanément sur la couleur que le sim utilise depuis toujours : une
	// balance des blancs constante l'y ramène, et c'est ce qui garantit que ce
	// ticket ne change RIEN dans les conditions où le sim tournait déjà.
	const ref = skyColor(REF_ELEV, CLEAR, 0);
	check('calibrage : soleil haut, ciel clair, sans nuage ⇒ exactement SKY',
		hex(ref) === SKY_REF,
		`#${hex(ref).toString(16).padStart(6, '0')} vs #${SKY_REF.toString(16)}`);
	check('la référence n\'est pas saturée (il reste de la marge en haut)',
		ref.r < 1 && ref.g < 1 && ref.b < 1);

	// À midi le ciel est bleu : c'est Rayleigh, et ça doit sortir du modèle et
	// non d'une couleur choisie.
	check('soleil haut : le ciel est bleu (b > g > r)',
		ref.b > ref.g && ref.g > ref.r,
		`${ref.r.toFixed(3)} ${ref.g.toFixed(3)} ${ref.b.toFixed(3)}`);

	// Et au ras de l'horizon il ne l'est plus : la lumière qui atteint le volume
	// diffusant a traversé 30 masses d'air et n'a plus de bleu à donner.
	const low = skyColor(2, CLEAR, 0);
	check('soleil rasant : le ciel bascule au chaud (r > b)', low.r > low.b,
		`${low.r.toFixed(3)} ${low.g.toFixed(3)} ${low.b.toFixed(3)}`);
	check('la bascule est monotone entre 60° et 2°', (() => {
		// La chaleur doit DÉCROÎTRE quand le soleil monte, donc en balayant les
		// élévations croissantes chaque valeur doit être sous la précédente.
		let prev = Infinity, ok = true;
		for (const e of [2, 5, 10, 20, 40, 60]) {
			const c = skyColor(e, CLEAR, 0);
			const warmth = c.r / Math.max(1e-6, c.b);
			if (warmth > prev) ok = false;
			prev = warmth;
		}
		return ok;
	})());

	// Transmittance : le disque rougit parce que le bleu part en premier.
	{
		const high = transmittance(airMass(refracted(60)), CLEAR);
		const graze = transmittance(airMass(refracted(2)), CLEAR);
		check('la transmittance décroît quand le soleil descend', graze[1] < high[1],
			`${graze[1].toFixed(4)} < ${high[1].toFixed(4)}`);
		check('le rougissement croît quand le soleil descend',
			graze[0] / graze[2] > high[0] / high[2],
			`${(graze[0] / graze[2]).toFixed(1)} > ${(high[0] / high[2]).toFixed(2)}`);
		check('la transmittance reste dans 0..1', high.concat(graze).every((v) => v >= 0 && v <= 1));
	}

	// Niveaux : 1 à la référence, décroissants, jamais nuls (le plancher de nuit
	// est ce qui rend la nuit jouable, et il est assumé comme tel).
	check('les niveaux valent 1 à la référence',
		Math.abs(ambientLevel(REF_ELEV, 0) - 1) < 1e-9 && Math.abs(skyLevel(REF_ELEV, 0) - 1) < 1e-9);
	check('l\'ambiance décroît quand le soleil descend',
		ambientLevel(60, 0) > ambientLevel(20, 0) && ambientLevel(20, 0) > ambientLevel(2, 0));
	check('l\'ambiance atteint un plancher sous l\'horizon et n\'y descend plus',
		ambientLevel(-20, 0) === ambientLevel(-40, 0) && ambientLevel(-20, 0) > 0,
		ambientLevel(-20, 0).toFixed(4));
	check('le ciel reste plus lumineux que le sol quand le soleil est bas',
		skyLevel(5, 0) / ambientLevel(5, 0) > 1.5,
		(skyLevel(5, 0) / ambientLevel(5, 0)).toFixed(2));

	// Nuit : le ciel repasse au bleu profond, il n'est ni noir ni orange.
	const night = skyChroma(-20, CLEAR, 0);
	check('nuit pleine : le ciel est bleu, pas orange', night[2] > night[0],
		`${night[0].toFixed(3)} ${night[1].toFixed(3)} ${night[2].toFixed(3)}`);
	check('nuit pleine : le ciel n\'est pas noir', skyLevel(-20, 0) > 0.02);

	// Couplages exigés par l'issue : le soleil ne peut pas contredire le régime
	// météo affiché au joueur.
	const clearDisc = sunDisc(40, CLEAR, 0);
	check('ciel couvert à 100 % : plus de disque du tout', sunDisc(40, CLEAR, 100).amount === 0);
	check('ciel couvert à 40 % (régime CLOUD) : le soleil est atténué sans disparaître', (() => {
		const a = sunDisc(40, CLEAR, 40).amount;
		return a > 0.1 * clearDisc.amount && a < 0.8 * clearDisc.amount;
	})(), `${sunDisc(40, CLEAR, 40).amount.toFixed(3)} vs ${clearDisc.amount.toFixed(3)}`);
	check('brouillard à 500 m : le disque est éteint',
		sunDisc(40, 500, 0).amount < 0.02 * clearDisc.amount,
		sunDisc(40, 500, 0).amount.toExponential(2));
	check('le disque rougit quand le soleil descend', (() => {
		const h = sunDisc(60, CLEAR, 0).color, l = sunDisc(3, CLEAR, 0).color;
		return l.r / Math.max(1e-6, l.b) > h.r / Math.max(1e-6, h.b);
	})());
	check('sous l\'horizon il n\'y a plus de disque', sunDisc(-1, CLEAR, 0).amount === 0);

	// Le brouillard blanchit le ciel : c'est la diffusion multiple, et c'est ce
	// qui empêche le modèle mono-diffusion de rendre un ciel noir dans la purée.
	{
		const c = skyChroma(40, 300, 0);
		const spread = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
		check('purée de pois : le ciel devient neutre, pas noir', spread < 0.05, spread.toFixed(4));
	}

	// Déterminisme : aucun état caché, aucun PRNG. Deux appels identiques
	// rendent la même chose au bit près.
	check('skyColor est pur', (() => {
		const a = skyColor(17, 8000, 33), b = skyColor(17, 8000, 33);
		return a.r === b.r && a.g === b.g && a.b === b.b;
	})());
}
```

- [ ] **Step 2 : lancer et vérifier que ça échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `The requested module '../src/sun.js' does not provide an export named 'transmittance'`.

- [ ] **Step 3 : ajouter le modèle atmosphérique à `src/sun.js`**

À la suite de `airMass()` :

```js
// ---------------------------------------------------------------------------
// Extinction spectrale
//
// Tout ce qui suit est MESURÉ, pas choisi à l'œil : c'est ce qui permet à la
// couleur du ciel d'être dérivée plutôt que peinte, et donc de ne jamais
// contredire le régime météo que le terminal a affiché au joueur.

// Les longueurs d'onde effectives de nos trois canaux, en µm.
const LAMBDA = [0.610, 0.550, 0.470];

// Épaisseur optique de Rayleigh au niveau de la mer, Hansen & Travis (1974) :
// tau = 0,008735 · lambda^(−4,08). Soit 0,066 / 0,100 / 0,190 — le bleu est
// diffusé trois fois plus que le rouge, et c'est là toute la couleur du ciel.
export const TAU_RAYLEIGH = LAMBDA.map((l) => 0.008735 * Math.pow(l, -4.08));

// Aérosols. Le bulletin météo donne une visibilité en mètres ; Koschmieder la
// convertit en coefficient d'extinction horizontal à 550 nm, et une hauteur
// d'échelle en épaisseur optique verticale. C'est ce qui fait tomber TOUT SEUL
// le couplage brouillard demandé par l'issue, sans une seule constante inventée
// pour l'occasion : la même visibilité pilote déjà fog.js.
const KOSCHMIEDER = 3.912;          // = ln(1/0.02), le contraste seuil de 2 %
const AEROSOL_SCALE_HEIGHT = 1200;  // m, valeur des atmosphères de référence
const ANGSTROM = 1.3;               // exposant continental standard

export function tauAerosol(visibilityM) {
	const t550 = (KOSCHMIEDER / Math.max(1, visibilityM)) * AEROSOL_SCALE_HEIGHT;
	return LAMBDA.map((l) => t550 * Math.pow(l / 0.550, -ANGSTROM));
}

// Ce qui reste du faisceau direct après la traversée. C'est la formule qui fait
// le coucher de soleil : à 30 masses d'air le bleu est parti et le rouge reste.
export function transmittance(m, visibilityM) {
	const ta = tauAerosol(visibilityM);
	return TAU_RAYLEIGH.map((tr, i) => Math.exp(-(tr + ta[i]) * m));
}

// ---------------------------------------------------------------------------
// La couleur du ciel
//
// La scène n'a qu'UNE couleur de ciel — c'est celle que lisent scene.background,
// le fog des tuiles, rainfall.js et le uSky de lens.js. Elle est donc la couleur
// moyenne du dôme, et pas celle d'une direction particulière.
//
// Chroma et luminance sont calculées séparément, et c'est délibéré : elles ne
// suivent pas la même loi. Quand le soleil se couche, l'éclairement du sol
// s'effondre bien plus vite que la luminance du ciel — c'est exactement pour ça
// qu'un ciel de fin de journée est éclatant au-dessus d'une ville déjà sombre.
// Les confondre donnait un crépuscule uniformément gris.

export const REF_ELEV = 60;         // l'élévation de calibrage
export const REF_VIS = 25000;       // et sa visibilité : de l'air clair
export const SKY_REF = 0x9fb8cc;    // la couleur que main.js utilise depuis toujours

// De combien le dôme subit le trajet oblique du faisceau. Pas 1 : le zénith ne
// le voit pas du tout et l'horizon le voit entièrement, et la moyenne du dôme
// est entre les deux. À 1 le ciel virait au brun bien trop haut dans le ciel.
// Choisi à l'œil, comme K1/K2 dans lens.js — et déclaré comme tel.
const SKY_SLANT = 0.6;
// Au-delà d'une épaisseur optique de vue de cet ordre, la diffusion multiple
// domine et lave la couleur : c'est pour ça qu'un brouillard est blanc et non
// bleu foncé. Sans ce terme, le modèle mono-diffusion rendait un ciel NOIR dans
// la purée de pois, ce qui est le contraire de ce qu'on voit.
const MS_TAU = 2.0;
// Le ciel de nuit, en chromaticité. Bleu profond, jamais noir : l'imagerie est
// photographiée en plein jour et une ville rigoureusement noire serait à la fois
// fausse et injouable.
const NIGHT_CHROMA = [0.250, 0.330, 0.420];

const clamp01 = (v) => clamp(v, 0, 1);
const smoothstep = (a, b, x) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const normalize3 = (c) => {
	const s = c[0] + c[1] + c[2] || 1;
	return [c[0] / s, c[1] / s, c[2] / s];
};

export function skyChroma(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	const m = airMass(refracted(elevationDeg));
	const mSky = 1 + (m - 1) * SKY_SLANT;
	const ta = tauAerosol(visibilityM);
	// Ce qui atteint le volume diffusant, après le trajet oblique.
	const T = TAU_RAYLEIGH.map((tr, i) => Math.exp(-(tr + ta[i]) * mSky));
	// Ce que ce volume rediffuse vers nous. Rayleigh est sélectif (le bleu) ;
	// la diffusion de Mie par les aérosols est quasi neutre, ce qui est
	// précisément pourquoi la brume blanchit le ciel au lieu de le bleuir.
	const grey = 1 - Math.exp(-ta[1]);
	const single = normalize3(T.map((t, i) => t * ((1 - Math.exp(-TAU_RAYLEIGH[i])) + grey)));

	// Lavage par diffusion multiple, piloté par l'épaisseur optique de la VUE et
	// non par celle du faisceau : sinon un coucher de soleil par temps clair
	// virait au gris, alors que c'est le brouillard qui lave, pas la distance
	// que le faisceau a parcourue avant d'arriver.
	const ms = clamp01(1 - Math.exp(-(TAU_RAYLEIGH[1] + ta[1]) / MS_TAU));
	const w = clamp01(ms + (1 - ms) * Math.pow(clamp01(cloudPct / 100), 1.5));
	const day = single.map((c) => c * (1 - w) + w / 3);

	// Sous l'horizon la diffusion simple ne décrit plus rien : la lumière vient
	// de la haute atmosphère, plusieurs fois diffusée. Le modèle passe la main,
	// mais sur les seuils crépusculaires réels — civil −6°, nautique −12°,
	// astronomique −18° — et non sur des paliers ronds.
	const night = smoothstep(-2, -14, elevationDeg);
	return day.map((c, i) => c * (1 - night) + NIGHT_CHROMA[i] * night);
}

// ---------------------------------------------------------------------------
// Les deux niveaux
//
// LUM_* : l'éclairement du sol, ce qui décide de l'exposition.
// SKY_* : la luminance du dôme, qui tombe beaucoup plus lentement.

const AMBIENT_EXP = 0.6;      // ajustement standard de l'éclairement diffus en (sin h)^n
const SKY_EXP = 0.25;         // le ciel s'assombrit bien plus lentement que le sol
// Loi crépusculaire : la luminance du ciel perd une décade tous les 6° de
// dépression solaire. C'est un résultat mesuré, pas une rampe. Le dôme la perd
// plus lentement que le sol, d'où les deux décades différentes.
const JOIN = 3;               // au-dessus, la loi diurne ; en dessous, la crépusculaire
const AMBIENT_DECADE = 6;
const SKY_DECADE = 9;
// Les deux planchers de nuit. C'est LE seul endroit où la jouabilité l'emporte
// sur la physique : le vrai rapport jour/nuit est de l'ordre de 10^7, et une
// ville à 10^-7 serait un écran noir. Le couple (plancher, E_MAX) est calibré
// pour que la nuit pleine rende une image sombre mais pilotable — le banc le
// vérifie, plutôt que de faire confiance à ces deux nombres.
const NIGHT_AMBIENT = 0.05;
const NIGHT_SKY = 0.10;
// Un ciel couvert divise l'éclairement du sol par ~3 et laisse le dôme presque
// aussi lumineux — c'est le couvercle blanc au-dessus d'une ville éteinte.
const OVERCAST_AMBIENT = 0.35;
const OVERCAST_SKY = 0.75;

function level(elevationDeg, exponent, decade, floor) {
	const ref = Math.pow(Math.sin(REF_ELEV * D2R), exponent);
	const day = elevationDeg > 0 ? Math.pow(Math.sin(elevationDeg * D2R), exponent) / ref : 0;
	const join = Math.pow(Math.sin(JOIN * D2R), exponent) / ref;
	// La loi crépusculaire ne vaut QUE sous le raccord : au-dessus,
	// 10^((h−3)/6) diverge et écraserait le jour.
	const twilight = elevationDeg < JOIN ? join * Math.pow(10, (elevationDeg - JOIN) / decade) : 0;
	return Math.max(floor, day, twilight);
}

const cloudFactor = (cloudPct, overcast) =>
	1 - Math.pow(clamp01(cloudPct / 100), 1.2) * (1 - overcast);

export function ambientLevel(elevationDeg, cloudPct = 0) {
	return level(elevationDeg, AMBIENT_EXP, AMBIENT_DECADE, NIGHT_AMBIENT)
		* cloudFactor(cloudPct, OVERCAST_AMBIENT);
}

export function skyLevel(elevationDeg, cloudPct = 0) {
	return level(elevationDeg, SKY_EXP, SKY_DECADE, NIGHT_SKY)
		* cloudFactor(cloudPct, OVERCAST_SKY);
}

// ---------------------------------------------------------------------------
// Balance des blancs
//
// Le modèle rend une radiance relative ; la caméra, elle, a une balance des
// blancs, et sur une caméra FPV elle est verrouillée. La nôtre est calibrée une
// fois pour toutes sur le ciel clair de midi, et le nombre qui en sort est
// exactement ce qui fait retomber la référence sur #9FB8CC.
//
// C'est ce qui tient la promesse de non-régression : dans les conditions où le
// sim tournait déjà, il rend exactement la même image. Toute la VARIATION —
// coucher, couvert, nuit — continue de sortir du modèle.
const WHITE_BALANCE = (() => {
	const ref = skyChroma(REF_ELEV, REF_VIS, 0);
	const target = [(SKY_REF >> 16 & 255) / 255, (SKY_REF >> 8 & 255) / 255, (SKY_REF & 255) / 255];
	return target.map((t, i) => t / ref[i]);
})();

// De combien le ciel est plus lumineux que ce pour quoi la caméra expose. Le
// rapport brut atteint 2,5 au crépuscule et brûlerait le ciel en blanc pur, ce
// qui emporterait justement la couleur d'heure dorée qu'on cherche. Comprimé en
// loi de puissance : la variation reste lisible, la teinte survit.
const SKY_COMPRESS = 0.35;

// La couleur que main.js pousse vers ses quatre consommateurs.
export function skyColor(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	const rel = Math.pow(skyLevel(elevationDeg, cloudPct) / ambientLevel(elevationDeg, cloudPct),
		SKY_COMPRESS);
	const c = skyChroma(elevationDeg, visibilityM, cloudPct);
	return { r: c[0] * WHITE_BALANCE[0] * rel, g: c[1] * WHITE_BALANCE[1] * rel, b: c[2] * WHITE_BALANCE[2] * rel };
}

// ---------------------------------------------------------------------------
// Le disque

// Un ciel couvert ne divise pas le soleil par deux : il l'efface. Le carré
// laisse un soleil encore perceptible à 40 % de couverture (le régime CLOUD) et
// rigoureusement rien à 100 % (OVERCAST). Exposant à l'œil, déclaré comme tel.
const CLOUD_KILL = 2;

export function sunDisc(elevationDeg, visibilityM = REF_VIS, cloudPct = 0) {
	// Réfracté : le disque qu'on VOIT est encore là quand le soleil est
	// géométriquement couché.
	const h = refracted(elevationDeg);
	if (h <= 0) return { color: { r: 0, g: 0, b: 0 }, amount: 0 };

	const T = transmittance(airMass(h), visibilityM);
	const ref = transmittance(airMass(REF_ELEV), REF_VIS);
	// Luminance relative du faisceau, par rapport à la référence de calibrage.
	// Rec.709, la même base que partout ailleurs dans le projet.
	const lum = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
	const amount = clamp01(lum(T) / lum(ref))
		* Math.pow(1 - clamp01(cloudPct / 100), CLOUD_KILL)
		// Le disque disparaît dans le dernier degré plutôt que de s'éteindre
		// d'un coup au passage de l'horizon.
		* smoothstep(0, 1, h);
	const n = normalize3(T);
	// Normalisée puis remise à une luminance de 1 : la couleur du disque, sa
	// force est portée par `amount`. Sinon l'un multiplierait l'autre deux fois.
	const k = 1 / Math.max(1e-6, lum(n));
	return { color: { r: n[0] * k, g: n[1] * k, b: n[2] * k }, amount };
}
```

- [ ] **Step 4 : lancer et vérifier que ça passe**

Run: `cd sim && node tools/selftest.mjs 2>&1 | sed -n '/soleil — atmosphère/,$p'`
Expected: toutes les lignes `PASS`. En particulier `calibrage : … exactement SKY` — si celle-là échoue, le ciel de toutes les scènes existantes a changé et rien d'autre ne l'attraperait.

- [ ] **Step 5 : commit**

```bash
git add src/sun.js tools/selftest.mjs
git commit -m "Soleil : extinction atmosphérique et couleur du ciel dérivée (issue #23)

Rayleigh (Hansen & Travis) + aérosols déduits de la visibilité du bulletin
par Koschmieder : le couplage brouillard/nuages demandé par l'issue tombe
tout seul, sans constante inventée. Chroma et luminance sont séparées parce
qu'elles ne suivent pas la même loi — un ciel de fin de journée est éclatant
au-dessus d'une ville déjà sombre.

Une balance des blancs constante, calibrée une fois, fait retomber la
référence sur #9FB8CC exactement : dans les conditions où le sim tournait
déjà, il rend la même image."
```

---

## Task 3 : `SunField` et l'AGC

**Files:**
- Modify: `src/sun.js`
- Test: `tools/selftest.mjs`

**Interfaces:**
- Consumes: tout ce que les tâches 1 et 2 exportent.
- Produces: `class SunField` avec
  - `constructor({ lat, lon })`
  - `setWeather({ cloudPct, visibilityM })`
  - `update(dt, { date = new Date(), sunInFrame = 0 } = {})`
  - lecture seule : `elevation` (degrés), `azimuth` (degrés), `dir {x,y,z}`, `sky {r,g,b}`, `sunColor {r,g,b}`, `sunAmount`, `exposure`, `ambient`
  - `get active()`
  - constantes exportées `E_MIN`, `E_MAX`, `TAU_CLOSE`, `TAU_OPEN`

- [ ] **Step 1 : écrire les checks qui échouent**

Compléter l'import :

```js
import {
	sunPosition, sunVector, refracted, airMass,
	transmittance, skyColor, skyChroma, ambientLevel, skyLevel, sunDisc,
	SunField, REF_ELEV, REF_VIS, SKY_REF, E_MIN, E_MAX,
} from '../src/sun.js';
```

Et ajouter la section :

```js
console.log('\nsoleil — exposition (AGC) et SunField');
{
	const PARIS = { lat: 48.8566, lon: 2.3522 };
	// Un midi d'équinoxe à Paris : soleil haut, ciel clair. C'est le point de
	// calibrage, et le seul instant où le sim doit rendre EXACTEMENT l'image
	// qu'il rendait avant ce ticket.
	const NOON = new Date('2026-06-21T11:52:00Z');
	const MIDNIGHT = new Date('2026-06-21T23:52:00Z');

	const settle = (field, date, sunInFrame, seconds = 20) => {
		for (let t = 0; t < seconds; t += 1 / 60) field.update(1 / 60, { date, sunInFrame });
		return field;
	};

	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('midi d\'été à Paris : le soleil est haut', sun.elevation > 55,
			`${sun.elevation.toFixed(1)}°`);
		check('et au sud : le vecteur pointe vers +Z', sun.dir.z > 0.3, sun.dir.z.toFixed(3));
		check('l\'exposition au repos par ciel clair et soleil haut est ~1',
			Math.abs(sun.exposure - 1) < 0.02, sun.exposure.toFixed(4));
	}

	// L'asymétrie de l'AGC : c'est ELLE, et rien d'autre, qui produit la
	// mécanique que l'issue met en avant — on passe face au soleil, la ville
	// s'éteint, et elle met une seconde à revenir.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		const before = sun.exposure;

		// Fermeture : le soleil entre dans le cadre.
		let closeTime = null;
		for (let t = 0; t < 5; t += 1 / 60) {
			sun.update(1 / 60, { date: NOON, sunInFrame: 1 });
			if (closeTime === null && sun.exposure < before * 0.5) closeTime = t;
		}
		const closed = sun.exposure;
		check('le soleil dans le cadre ferme l\'exposition', closed < before * 0.4,
			`${closed.toFixed(3)} vs ${before.toFixed(3)}`);
		check('la fermeture est rapide (moins de 0,5 s pour perdre la moitié)',
			closeTime !== null && closeTime < 0.5, `${closeTime?.toFixed(2)} s`);

		// Réouverture : le soleil sort du cadre.
		let openTime = null;
		for (let t = 0; t < 10; t += 1 / 60) {
			sun.update(1 / 60, { date: NOON, sunInFrame: 0 });
			if (openTime === null && sun.exposure > before * 0.5) openTime = t;
		}
		check('la réouverture est lente (plus de 0,5 s pour reprendre la moitié)',
			openTime !== null && openTime > 0.5, `${openTime?.toFixed(2)} s`);
		check('la caméra ferme nettement plus vite qu\'elle ne rouvre',
			openTime > closeTime * 3, `${openTime?.toFixed(2)} s vs ${closeTime?.toFixed(2)} s`);
		check('et elle finit par revenir là où elle était',
			Math.abs(sun.exposure - before) < 0.02);
	}

	// La nuit sort de l'AGC arrivé en butée, pas d'un facteur « nuit ». Le
	// critère est de jouabilité : une image sombre qu'on peut encore piloter.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, MIDNIGHT, 0, 60);
		check('minuit : le soleil est sous l\'horizon', sun.elevation < 0,
			`${sun.elevation.toFixed(1)}°`);
		check('minuit : le disque est éteint', sun.sunAmount === 0);
		check('nuit pleine : l\'image est sombre mais pilotable (15 à 35 %)',
			sun.exposure > 0.15 && sun.exposure < 0.35, sun.exposure.toFixed(3));
		check('nuit pleine : le ciel reste bleu', sun.sky.b > sun.sky.r,
			`${sun.sky.r.toFixed(3)} ${sun.sky.g.toFixed(3)} ${sun.sky.b.toFixed(3)}`);
	}

	// dt = 0 fige le modèle. Même règle que setRain() dans lens.js : il n'y a
	// pas d'horloge interne qu'on pourrait oublier d'arrêter (#24).
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		const held = sun.exposure;
		for (let i = 0; i < 100; i++) sun.update(0, { date: NOON, sunInFrame: 1 });
		check('dt = 0 fige l\'AGC', sun.exposure === held);
	}

	// L'exposition reste bornée quoi qu'on lui envoie : elle multiplie l'image
	// entière, un débordement serait un écran blanc.
	{
		const sun = new SunField(PARIS);
		let outOfRange = 0;
		for (const cloud of [0, 50, 100]) {
			for (const vis of [200, 5000, 25000]) {
				sun.setWeather({ cloudPct: cloud, visibilityM: vis });
				for (const h of [0, 6, 12, 18]) {
					const d = new Date(`2026-06-21T${String(h).padStart(2, '0')}:00:00Z`);
					for (const f of [0, 0.3, 1]) {
						settle(sun, d, f, 5);
						if (!(sun.exposure > 0) || sun.exposure > E_MAX) outOfRange++;
					}
				}
			}
		}
		check('l\'exposition reste bornée sur toute la combinatoire', outOfRange === 0,
			`${outOfRange} débordement(s)`);
	}

	// Le no-op. Attention à ce qui est testé ici : `active` dit « le soleil
	// change quelque chose à l'image », et il est VRAI dès que le soleil est
	// levé, caméra ou pas — SunField ne connaît pas la caméra. Le vrai test de
	// no-op du shader vit dans lens.setSun(), qui seul sait si le soleil est
	// devant l'objectif.
	//
	// Ce qui doit être exact ici, c'est le calibrage de l'exposition : par ciel
	// clair, soleil haut et hors cadre, le gain vaut 1 et l'image est celle que
	// le sim rendait avant ce ticket.
	{
		const sun = new SunField(PARIS);
		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('calibrage : soleil haut, ciel clair, hors cadre ⇒ gain exactement 1',
			sun.exposure === 1, sun.exposure.toFixed(6));
		check('mais il y a bien un soleil dans le ciel', sun.sunAmount > 0.5,
			sun.sunAmount.toFixed(3));

		// Le seul cas où le bloc est vraiment un no-op : plus de disque du tout,
		// et un gain encore à 1.
		sun.setWeather({ cloudPct: 100, visibilityM: REF_VIS });
		settle(sun, NOON, 0);
		check('couvert total, soleil haut : le bloc est un no-op',
			sun.active === false, `expo=${sun.exposure.toFixed(4)} amount=${sun.sunAmount}`);

		sun.setWeather({ cloudPct: 0, visibilityM: REF_VIS });
		settle(sun, MIDNIGHT, 0, 60);
		check('la nuit, le bloc reste actif (sinon la nuit ne s\'assombrirait pas)',
			sun.active === true && sun.sunAmount === 0);
	}

	// Sans coordonnées, pas de soleil inventé.
	check('une zone sans lat/lon ne construit pas de soleil',
		SunField.forOrigin({}) === null && SunField.forOrigin({ latitude: 1, longitude: 2 }) !== null);
}
```

- [ ] **Step 2 : lancer et vérifier que ça échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `does not provide an export named 'SunField'`.

- [ ] **Step 3 : ajouter `SunField` à `src/sun.js`**

```js
// ---------------------------------------------------------------------------
// L'AGC
//
// Une caméra FPV a un gain automatique, et c'est lui qu'on modélise — pas un
// correcteur de gamma. Côté CPU, sans aucun readback GPU : le posemètre est
// estimé analytiquement depuis l'état du ciel et l'angle au soleil, ce qui rend
// tout ceci déterministe et vérifiable au banc.

// Les bornes du gain. E_MAX est ce qui produit la nuit : arrivée en butée, la
// caméra ne compense plus et l'image s'assombrit — exactement ce que fait une
// vraie caméra. Le couple (E_MAX, planchers de nuit) est calibré pour que la
// nuit pleine rende entre 15 et 35 % de la luminance de jour, et c'est le banc
// qui le vérifie.
export const E_MIN = 0.15;
export const E_MAX = 4.0;
// Ce que pèse le disque solaire dans une moyenne pondérée du cadre. Grand : un
// soleil couvre une fraction dérisoire de l'image et domine pourtant la mesure.
const SUN_METER_WEIGHT = 6.0;
// Les caméras ferment vite et rouvrent lentement. Cette asymétrie EST la
// mécanique que l'issue #23 met en avant ; symétrique, l'effet ne se remarque
// même pas.
export const TAU_CLOSE = 0.15;
export const TAU_OPEN = 1.2;
// En dessous, l'écart à 1 n'est plus visible et le bloc shader peut être
// compilé dehors. Un demi-niveau sur 255 : ce qui ne peut pas changer un octet.
const NOOP_EPS = 1 / 512;

export class SunField {
	// null plutôt qu'un soleil inventé quand la scène n'a pas d'origine
	// géodésique — la même règle que la météo, qui se rabat sur CALM.
	static forOrigin(origin = {}) {
		const lat = origin.latitude, lon = origin.longitude;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
		return new SunField({ lat, lon });
	}

	constructor({ lat, lon }) {
		this.lat = lat;
		this.lon = lon;
		this.cloudPct = 0;
		this.visibilityM = REF_VIS;

		this.elevation = 0;          // degrés, géométrique
		this.azimuth = 0;            // degrés, horaire depuis le nord
		this.dir = { x: 0, y: 1, z: 0 };
		this.sky = { r: 0, g: 0, b: 0 };
		this.sunColor = { r: 1, g: 1, b: 1 };
		this.sunAmount = 0;
		this.ambient = 1;
		// Démarrée à sa valeur d'équilibre plutôt qu'à 1 : sinon la première
		// seconde de chaque vol est une rampe d'exposition que personne n'a
		// demandée.
		this.exposure = 1;
		this._settled = false;
	}

	// Écrit par weather.js. Le bulletin du jour, pas une série horaire : le
	// soleil lit la météo comme wind/rain/fog, il ne la réinvente pas.
	setWeather({ cloudPct = 0, visibilityM = REF_VIS } = {}) {
		this.cloudPct = clamp(Number(cloudPct) || 0, 0, 100);
		this.visibilityM = Number.isFinite(visibilityM) ? Math.max(1, visibilityM) : REF_VIS;
		this._settled = false;
		return this;
	}

	// dt vient de l'appelant et vaut ZÉRO quand le sim est gelé — même règle et
	// même piège que FpvLens.setRain() : pas d'horloge interne qu'on pourrait
	// oublier d'arrêter sur une image figée.
	//
	// sunInFrame est 0..1 : combien le disque, occlusion comprise, pèse dans ce
	// que le posemètre voit. main.js le calcule, parce que lui seul connaît la
	// caméra et la géométrie.
	update(dt, { date = new Date(), sunInFrame = 0 } = {}) {
		const p = sunPosition({ lat: this.lat, lon: this.lon, date });
		this.elevation = p.elevation * R2D;
		this.azimuth = p.azimuth * R2D;
		this.dir = sunVector(p.azimuth, p.elevation);

		const c = skyColor(this.elevation, this.visibilityM, this.cloudPct);
		this.sky.r = c.r; this.sky.g = c.g; this.sky.b = c.b;

		const disc = sunDisc(this.elevation, this.visibilityM, this.cloudPct);
		this.sunColor = disc.color;
		this.sunAmount = disc.amount;

		this.ambient = ambientLevel(this.elevation, this.cloudPct);
		// Ce que le posemètre voit : l'ambiance, plus le disque s'il est dans le
		// cadre. Le disque est pondéré par sa propre force, donc un soleil déjà
		// mangé par les nuages ne ferme pas le diaphragme.
		const metered = this.ambient + SUN_METER_WEIGHT * clamp01(sunInFrame) * this.sunAmount;
		// Le gain que la caméra cherche, puis l'exposition finale : l'ambiance
		// EST la luminance de la scène, le gain la corrige, et c'est le produit
		// qui multiplie l'image. À la référence les deux valent 1.
		const target = this.ambient * clamp(1 / metered, E_MIN, E_MAX);

		if (!this._settled) {
			// Premier pas : on part à l'équilibre, sans rampe d'ouverture.
			this.exposure = target;
			this._settled = true;
		} else if (dt > 0) {
			const tau = target < this.exposure ? TAU_CLOSE : TAU_OPEN;
			this.exposure += (target - this.exposure) * (1 - Math.exp(-dt / tau));
		}
		return this;
	}

	// Faux uniquement quand le bloc shader serait rigoureusement un no-op :
	// aucun disque, et une exposition indiscernable de 1. C'est plus étroit
	// qu'il n'y paraît — la nuit, sunAmount est nul mais l'AGC est en butée,
	// donc le bloc doit rester compilé, sans quoi la nuit ne s'assombrirait pas.
	get active() {
		return this.sunAmount > 0 || Math.abs(this.exposure - 1) > NOOP_EPS;
	}
}
```

- [ ] **Step 4 : lancer et vérifier que ça passe**

Run: `cd sim && node tools/selftest.mjs 2>&1 | sed -n '/soleil — exposition/,$p'`
Expected: toutes les lignes `PASS`, et `all checks passed` à la fin du fichier.

- [ ] **Step 5 : commit**

```bash
git add src/sun.js tools/selftest.mjs
git commit -m "Soleil : SunField et l'AGC de la caméra (issue #23)

L'exposition est un gain automatique modélisé côté CPU — pas de readback GPU,
donc déterministe et vérifiable au banc. Son asymétrie (0,15 s pour fermer,
1,2 s pour rouvrir) est la mécanique que l'issue met en avant : on passe face
au soleil, la ville s'éteint, et elle met une seconde à revenir.

La nuit sort de ce même AGC arrivé en butée, pas d'un facteur « nuit »."
```

---

## Task 4 : le bloc `sun` dans la traduction météo

**Files:**
- Modify: `tools/lib/weather.mjs` (`toSimParams`)
- Modify: `src/weather.js` (`applyWeather`, `CALM`)
- Test: `tools/selftest.mjs`

**Interfaces:**
- Consumes: `SunField.setWeather()` de la tâche 3.
- Produces: `toSimParams(day).sun = { cloudPct, visibilityM }` ; `applyWeather(snapshot, { physics, rain, fog, sun })`.

- [ ] **Step 1 : écrire les checks qui échouent**

Dans `tools/selftest.mjs`, la section météo existante importe déjà le modèle. Ajouter en tête de fichier :

```js
import { toSimParams as weatherToSimParams, sanitize as weatherSanitize } from './lib/weather.mjs';
```

Et à la suite des sections soleil :

```js
console.log('\nsoleil — traduction depuis le bulletin');
{
	// La couverture passe telle quelle : c'est déjà la grandeur que sun.js veut.
	const overcast = weatherToSimParams(weatherSanitize({
		windSpeed: 2, windGust: 3, windDir: 180, rateMmH: 0, visibilityM: 20000, cloudPct: 95,
	}));
	check('la couverture nuageuse arrive jusqu\'au soleil', overcast.sun.cloudPct === 95,
		String(overcast.sun.cloudPct));

	// LA règle : la visibilité passée au soleil est celle de l'air HORS pluie,
	// exactement celle que fog.js reçoit. Sinon la même averse compterait deux
	// fois — une fois dans le brouillard, une fois dans l'extinction du disque.
	const rainy = weatherToSimParams(weatherSanitize({
		windSpeed: 4, windGust: 6, windDir: 200, rateMmH: 6, precipMm: 12,
		visibilityM: 3000, cloudPct: 90,
	}));
	// L'air seul voit plus loin que l'air + la pluie : si les deux sont égaux,
	// c'est que l'averse a été comptée deux fois.
	const rainyTotal = weatherSanitize({
		windSpeed: 4, windGust: 6, windDir: 200, rateMmH: 6, precipMm: 12,
		visibilityM: 3000, cloudPct: 90,
	}).visibilityM;
	check('sous la pluie, le soleil reçoit la visibilité de l\'air, meilleure que la totale',
		rainy.sun.visibilityM > rainyTotal * 1.05,
		`air ${Math.round(rainy.sun.visibilityM)} m vs totale ${Math.round(rainyTotal)} m`);
	check('la visibilité transmise est finie et positive',
		Number.isFinite(rainy.sun.visibilityM) && rainy.sun.visibilityM > 0);

	// Le brouillard, lui, arrive bien jusqu'au soleil.
	const foggy = weatherToSimParams(weatherSanitize({
		windSpeed: 1, windGust: 1, windDir: 0, rateMmH: 0, visibilityM: 400, cloudPct: 80,
	}));
	check('un vrai brouillard réduit la visibilité vue par le soleil',
		foggy.sun.visibilityM < 1000, `${Math.round(foggy.sun.visibilityM)} m`);
}
```

- [ ] **Step 2 : lancer et vérifier que ça échoue**

Run: `cd sim && node tools/selftest.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'cloudPct')`.

- [ ] **Step 3 : ajouter le bloc `sun`**

Dans `tools/lib/weather.mjs`, dans `toSimParams()`, juste avant le `return` final, la variable `airVis` existe déjà (elle est calculée pour `fog.js`). Ajouter le bloc au `return` :

```js
	return {
		wind: { speed, direction: d.windDir, gust, turbulence },
		rain: { intensity: rainIntensity, variability: rainVariability(d) },
		fog: { intensity: fogIntensity, variability: fogVariability },
		// Le soleil (#23) prend la couverture telle quelle, et la MÊME visibilité
		// hors pluie que fog.js : c'est l'extinction de l'air, et l'averse a déjà
		// la sienne. Lui passer la visibilité totale ferait compter deux fois la
		// même pluie — une fois dans le brouillard, une fois sur le disque.
		sun: { cloudPct: d.cloudPct, visibilityM: airVis },
	};
```

Dans `src/weather.js`, `applyWeather()` :

```js
export function applyWeather(snapshot, { physics, rain, fog, sun } = {}) {
	const d = model.today(snapshot);
	if (!d) return null;
	const p = model.toSimParams(d);
	physics?.setWeather(p.wind);
	rain?.setParams(p.rain);
	fog?.setParams(p.fog);
	sun?.setWeather(p.sun);
	return p;
}
```

Et `CALM`, qui est le monde neutre sur lequel le selftest se rabat :

```js
export const CALM = {
	wind: { speed: 0, direction: 0, gust: 0, turbulence: 0.5 },
	rain: { intensity: 0, variability: 0.5 },
	fog: { intensity: 0, variability: 0.5 },
	// Ciel dégagé, air clair : le soleil n'est pas neutralisé pour autant, il
	// est simplement au-dessus d'une zone sans météo connue.
	sun: { cloudPct: 0, visibilityM: 25000 },
};
```

- [ ] **Step 4 : lancer et vérifier que ça passe**

Run: `cd sim && node tools/selftest.mjs`
Expected: `all checks passed`. La section météo existante doit rester intacte — le bloc `sun` est purement additif.

- [ ] **Step 5 : commit**

```bash
git add tools/lib/weather.mjs src/weather.js tools/selftest.mjs
git commit -m "Météo : le bulletin parle aussi au soleil (issue #23)

toSimParams() gagne un bloc sun, au seul endroit où le monde parle aux
modèles. Il reçoit la MÊME visibilité hors pluie que fog.js : lui passer la
visibilité totale ferait compter la même averse deux fois."
```

---

## Task 5 : le bloc `#if SUN` dans `lens.js`

**Files:**
- Modify: `src/lens.js`

**Interfaces:**
- Consumes: rien de `sun.js` (le lens ne connaît pas le modèle, on lui pousse des nombres — même contrat que `setGlare()`).
- Produces: `FpvLens.setSun({ x, y, front, color, amount, exposure })` où `x`,`y` sont les coordonnées du soleil dans l'espace carré de la passe (celui de `base`, cf. `uAspect`), `front` vaut 1 devant la caméra et 0 derrière, `color` est un `THREE.Color`, `amount` et `exposure` des flottants.

- [ ] **Step 1 : ajouter les constantes de dessin**

À la suite du bloc `GLARE_*` (vers `src/lens.js:105`) :

```js
// Le soleil (#23). L'imagerie est non éclairée et le restera : le soleil
// n'existe ici que comme événement optique dans le barillet — un disque, un
// halo, un voile — et comme gain d'exposition. Rien de tout cela ne touche à la
// géométrie.
//
// Rayon, étalement et force sont choisis à l'œil, exactement comme K1/K2/CA et
// GLARE_R : il n'y a pas d'optique à mesurer ici. Ce qui n'est PAS à l'œil,
// c'est qu'ils sont tous multipliés par uSunAmount, qui descend de la
// transmittance atmosphérique et de la couverture nuageuse — le voile ne peut
// donc jamais contredire le régime météo affiché au joueur avant le vol.
const SUN_DISC = 0.020;    // rayon du disque, en unités de l'espace carré
const SUN_HALO = 0.32;     // rayon du lobe autour du disque
const SUN_HALO_GAIN = 0.9; // ce que le halo ajoute au plus fort
const SUN_VEIL = 0.22;     // remontée des noirs quand le soleil est dans le champ
```

- [ ] **Step 2 : ajouter les uniformes et le define**

Dans `LensShader.defines`, ajouter `SUN: 0` :

```js
	defines: { TAPS: MAX_TAPS, LINK_MODE: LINK_OFF, DROPS: 0, GLARE: 0, SUN: 0 },
```

Dans `LensShader.uniforms`, après `uSky` :

```js
		// Le soleil : sa position dans l'espace carré de la passe (xy), s'il est
		// devant la caméra (z = 1) ou derrière (z = 0), sa couleur, sa force
		// (transmittance × nuages × occlusion) et le gain d'exposition.
		uSunPos: { value: new THREE.Vector3(0, 0, 0) },
		uSunColor: { value: new THREE.Color(1, 1, 1) },
		uSunAmount: { value: 0 },
		// Multiplie l'image entière. Vaut exactement 1 quand la caméra est à son
		// point de calibrage, et c'est ce qui rend le cas de référence identique
		// au bit près à la passe telle qu'elle était avant ce ticket.
		uExposure: { value: 1 },
```

Dans le `fragmentShader`, après la déclaration `uniform vec3 uSky;` :

```glsl
		#if SUN
			#define SUN_DISC ${SUN_DISC.toFixed(4)}
			#define SUN_HALO ${SUN_HALO.toFixed(3)}
			#define SUN_HALO_GAIN ${SUN_HALO_GAIN.toFixed(2)}
			#define SUN_VEIL ${SUN_VEIL.toFixed(3)}
			uniform vec3 uSunPos;
			uniform vec3 uSunColor;
			uniform float uSunAmount;
			uniform float uExposure;
		#endif
```

- [ ] **Step 3 : dessiner, juste avant le vignettage**

Dans le `main()` du fragment shader, repérer la ligne existante :

```glsl
			c *= 1.0 - uVignette * pow(r, 2.5);
```

et insérer **juste au-dessus** :

```glsl
			#if SUN
				// L'exposition d'abord : c'est le capteur, et tout ce qui suit se
				// produit dans le verre en amont de lui — sauf qu'ici on peint le
				// verre après coup, donc le disque et le halo sont ajoutés APRÈS
				// le gain, sinon la caméra s'auto-atténuerait son propre soleil.
				c *= uExposure;

				if (uSunAmount > 0.0 && uSunPos.z > 0.5) {
					// `base` est déjà l'espace carré, radialement symétrique — le
					// même dans lequel les gouttes sont posées.
					float sd = length(base - uSunPos.xy);
					// Voile : de la lumière qui n'est jamais venue du sujet, entrée
					// de biais dans le barillet. Même argument que le voile de
					// brouillard vingt lignes plus haut — une photo prise vers le
					// soleil n'a pas de noir.
					float veil = uSunAmount * SUN_VEIL
						* (1.0 - smoothstep(0.0, 1.4, sd));
					c += uSunColor * veil;
					// Halo : le lobe autour de la source. En 1/(1+k·d²) plutôt
					// qu'en gaussienne, parce qu'un halo d'objectif a des ailes
					// longues et que c'est ce qu'on en voit.
					float halo = uSunAmount * SUN_HALO_GAIN
						/ (1.0 + 60.0 * (sd / SUN_HALO) * (sd / SUN_HALO));
					c += uSunColor * halo;
					// Disque. Le bord est adouci sur son propre rayon : à 0,5° il
					// ne fait que quelques pixels et un bord dur y crénellerait.
					float disc = uSunAmount
						* (1.0 - smoothstep(SUN_DISC * 0.6, SUN_DISC, sd));
					c += uSunColor * disc * 1.6;
				}
			#endif
```

- [ ] **Step 4 : ajouter `setSun()` à la classe**

Dans le constructeur de `FpvLens`, à la suite de `this._glare = 0;` :

```js
		this._sunOn = false;
```

Et après la méthode `setGlare()` :

```js
	// Le soleil, en nombres déjà cuits par sun.js : le lens ne connaît ni
	// l'astronomie ni l'atmosphère, exactement comme il ne connaît pas la météo
	// derrière setGlare(). `x`/`y` sont dans l'espace carré de la passe, `front`
	// dit si le soleil est devant la caméra, `amount` porte la transmittance,
	// les nuages et l'occlusion, `exposure` est le gain de l'AGC.
	//
	// Le bloc est compilé hors du shader quand il serait rigoureusement un
	// no-op — la même promesse que LINK_OFF et que GLARE à zéro, et la raison
	// pour laquelle une scène par ciel clair et soleil haut rend exactement
	// l'image qu'elle rendait avant ce ticket.
	setSun({ x = 0, y = 0, front = 0, color = null, amount = 0, exposure = 1 } = {}) {
		const a = amount > 0 ? (amount > 1 ? 1 : amount) : 0;
		// `front` compte : le shader ne dessine rien quand le soleil est derrière
		// la caméra, donc le bloc serait compilé pour rien. Reste l'exposition,
		// qui multiplie l'image entière et n'a pas d'orientation.
		const on = (a > 0 && front) || Math.abs(exposure - 1) > 1 / 512;
		this._u.uSunPos.value.set(x, y, front ? 1 : 0);
		if (color) this._u.uSunColor.value.copy(color);
		this._u.uSunAmount.value = a;
		this._u.uExposure.value = exposure;
		// Seule la traversée recompile, pas chaque frame où le soleil bouge.
		if (on !== this._sunOn) {
			this._sunOn = on;
			this._updateDefines();
		}
	}
```

- [ ] **Step 5 : déclarer le define**

`_updateDefines()` (`src/lens.js:720`) ne travaille pas avec un drapeau : il compare
chaque define et sort tôt si rien n'a bougé. Il faut donc toucher **les deux** endroits.

Calculer la valeur à côté de `glare` :

```js
		const glare = this._glare > 0 ? 1 : 0;
		const sun = this._sunOn ? 1 : 0;
```

L'ajouter à la garde de sortie anticipée :

```js
		if (taps === this._taps && defines.LINK_MODE === this._linkMode
			&& defines.DROPS === this._dropBucket && defines.GLARE === glare
			&& defines.SUN === sun) return;
```

Et à l'affectation, à côté de `defines.GLARE = glare;` :

```js
		defines.SUN = sun;
```

Oublier la garde ferait recompiler le shader à chaque frame ; oublier l'affectation
laisserait le bloc soleil éteint pour toujours.

- [ ] **Step 6 : vérifier que rien n'a bougé**

Run: `cd sim && node tools/selftest.mjs && npm run build`
Expected: `all checks passed`, et le build Vite réussit (c'est ce qui attrape une erreur de syntaxe GLSL en template string, que le selftest ne voit pas).

- [ ] **Step 7 : commit**

```bash
git add src/lens.js
git commit -m "lens.js : le bloc soleil dans la passe unique (issue #23)

Exposition, voile, halo, disque — tout dans la passe existante, puisque
toneMapping est volontairement à NoToneMapping. Compilé hors du shader quand
il serait un no-op, la même promesse que LINK_OFF et GLARE."
```

---

## Task 6 : câblage dans `main.js`

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `SunField` (tâche 3), `applyWeather` avec `sun` (tâche 4), `lens.setSun()` (tâche 5), `physics.obstructionBetween()` (existant).
- Produces: `window.__sim.debug().sun`.

- [ ] **Step 1 : import et instance**

À la suite de l'import de `fog.js` (`src/main.js:19`) :

```js
import { SunField } from './sun.js';
```

À la suite de la construction de `fog` (vers `src/main.js:107`) :

```js
// Et la lumière : où est le soleil, ce que l'atmosphère lui fait, et ce que la
// caméra en fait. Construit dans boot(), une fois le manifest lu — il lui faut
// la lat/lon de la scène, et sans elle il n'existe pas plutôt que d'inventer un
// soleil. Modèle pur : il ne ré-éclaire RIEN, l'imagerie reste non éclairée.
let sun = null;
```

- [ ] **Step 2 : construire et alimenter depuis la météo**

Dans `boot()`, dans le bloc météo (vers `src/main.js:265`), remplacer :

```js
	const o = manifest.origin ?? {};
	weather = await worldWeather({ lat: o.latitude, lon: o.longitude });
	const applied = applyWeather(weather, { physics, rain, fog }) ?? CALM;
```

par :

```js
	const o = manifest.origin ?? {};
	// La lat/lon exacte de la scène : la même qui sert de clé de zone à la
	// météo, et la seule chose dont la position du soleil a besoin en plus de
	// l'instant. Aucun fuseau horaire n'entre ici — la position du soleil est
	// fonction de l'instant UTC et du lieu, point.
	sun = SunField.forOrigin(o);
	weather = await worldWeather({ lat: o.latitude, lon: o.longitude });
	const applied = applyWeather(weather, { physics, rain, fog, sun }) ?? CALM;
```

et compléter le repli juste en dessous :

```js
	} else {
		// Scène sans origine connue : monde neutre plutôt que météo inventée.
		physics.setWeather(CALM.wind);
		rain.setParams(CALM.rain);
		fog.setParams(CALM.fog);
		sun?.setWeather(CALM.sun);
	}
```

- [ ] **Step 3 : rendre le ciel dynamique**

`weatherSky()` (`src/main.js:575`) part aujourd'hui d'une constante. Le soleil devient sa base — un seul ciel, les quatre consommateurs existants (`scene.background`, `setFog()`, `rainfall`, `uSky`) le lisent sans rien changer chez eux :

```js
function weatherSky(rainScale, fogMix) {
	// Le ciel clair n'est plus une constante : c'est celui que sun.js dérive de
	// la hauteur du soleil, de la visibilité de l'air et de la couverture. Sans
	// soleil (scène sans origine géodésique), CLEAR_SKY reste la constante
	// d'origine et cette fonction rend exactement ce qu'elle rendait.
	const base = sun ? _sunSky.setRGB(sun.sky.r, sun.sky.g, sun.sky.b) : CLEAR_SKY;
	// rainScale is 1 in the clear and about 2 in a downpour.
	return _sky.copy(base)
		.lerp(RAIN_SKY, Math.min(1, (rainScale - 1) * 1.2))
		.lerp(FOG_SKY, fogMix);
}
```

et déclarer la couleur réutilisée à côté de `_sky` :

```js
// Réutilisée plutôt que réallouée : weatherSky() tourne à chaque frame.
const _sunSky = new THREE.Color();
```

- [ ] **Step 4 : avancer le soleil, mesurer l'occlusion, pousser au lens**

Dans `frame()`, dans le bloc `if (!frozen) { … }` de la météo, **avant** la ligne `const sky = weatherSky(...)`, insérer :

```js
		// Le soleil. Avancé sur l'horloge de la frame comme la pluie et le
		// brouillard, et pour la même raison : rien de ce qu'il fait ne
		// redescend dans le modèle de vol.
		if (sun) {
			// Le soleil traverse-t-il un bâtiment ? Sans cette question, le
			// disque se dessine à travers la Tour Eiffel et tout l'effet
			// s'effondre. Un seul rayon, la méthode existe déjà (elle sert au
			// lien vidéo) — la sonde de vent en tire dix à 20,8 Hz, donc le coût
			// est dans le bruit.
			const sp = physics.position;
			const far = 2000;
			const blocked = physics.obstructionBetween(
				sp.x, sp.y, sp.z,
				sp.x + sun.dir.x * far, sp.y + sun.dir.y * far, sp.z + sun.dir.z * far,
			).blocked ? 1 : 0;
			// Lissé : un rayon unique bascule 0/1 d'une frame à l'autre en
			// frôlant une arête, et un disque qui clignote est pire qu'aucun
			// disque. 80 ms, assez court pour qu'un immeuble le coupe net.
			sunVisible += ((1 - blocked) - sunVisible) * (1 - Math.exp(-dt / 0.08));

			// Où le soleil tombe dans le cadre. Une caméra à 120° de champ voit
			// un demi-ciel : « dans le cadre » n'est donc pas un booléen mais la
			// place que le disque prend dans ce que le posemètre moyenne.
			_sunWorld.set(sun.dir.x, sun.dir.y, sun.dir.z);
			const axis = _camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
			const cosAngle = axis.dot(_sunWorld);
			// 1 quand le soleil est pile dans l'axe, 0 au bord du champ.
			const halfFov = (camera.fov * Math.PI / 180) / 2;
			const inFrame = Math.max(0, (cosAngle - Math.cos(halfFov)) / (1 - Math.cos(halfFov)));
			sunInFrame = inFrame * sunVisible;

			sun.update(dt, { sunInFrame });
		}
```

Puis, juste après le `lens.setGlare(fog.glare);` existant :

```js
		// Et la lumière qui vient d'une direction plutôt que de partout. La
		// projection est faite ici parce que main.js est le seul à connaître la
		// caméra ; lens.js ne reçoit que des nombres, comme pour setGlare().
		if (sun) {
			_sunView.copy(_sunWorld).applyQuaternion(_camInv.copy(camera.quaternion).invert());
			// Espace carré de la passe : x est étiré par l'aspect, exactement
			// comme `base` dans le shader.
			// L'espace `base` du shader, et pas un espace écran inventé ici.
			// lens.js:226-227 le définit : base.x = ndc.x · uAspect et
			// dir = (base.xy · uTanHalf, −1), avec uTanHalf = tan(fovY/2)
			// (lens.js:761). Donc base = (v.x/−v.z, v.y/−v.z) / tan(fovY/2) —
			// SANS facteur 0,5 et SANS multiplier une seconde fois par l'aspect,
			// qui est déjà porté par l'amplitude de base.x. La caméra regarde
			// vers −Z, d'où le signe.
			const front = _sunView.z < 0;
			const tanHalf = Math.tan(camera.fov * Math.PI / 360);
			const invZ = 1 / Math.max(1e-4, -_sunView.z);
			lens.setSun({
				x: (_sunView.x * invZ) / tanHalf,
				y: (_sunView.y * invZ) / tanHalf,
				front,
				color: _sunColor.setRGB(sun.sunColor.r, sun.sunColor.g, sun.sunColor.b),
				amount: sun.sunAmount * sunVisible,
				exposure: sun.exposure,
			});
		}
```

Déclarer les objets réutilisés à côté de `drift` (`src/main.js:584`) :

```js
// L'état du soleil entre deux frames, et les vecteurs réutilisés plutôt que
// réalloués — même règle que `drift` juste au-dessus.
let sunVisible = 1;    // 0..1, occlusion lissée
let sunInFrame = 0;    // 0..1, ce que le posemètre voit du disque
const _sunWorld = new THREE.Vector3();
const _sunView = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camInv = new THREE.Quaternion();
const _sunColor = new THREE.Color();
```

- [ ] **Step 5 : exposer dans `__sim.debug()`**

Dans l'objet rendu par `debug()`, à côté du bloc `fog` (vers `src/main.js:407`) :

```js
				// Ce qui permet de vérifier le soleil dans le vrai navigateur
				// plutôt que de regarder une capture et d'y croire.
				sun: sun && {
					elevation: +sun.elevation.toFixed(2),
					azimuth: +sun.azimuth.toFixed(2),
					dir: { x: +sun.dir.x.toFixed(3), y: +sun.dir.y.toFixed(3), z: +sun.dir.z.toFixed(3) },
					amount: +sun.sunAmount.toFixed(3),
					visible: +sunVisible.toFixed(3),
					inFrame: +sunInFrame.toFixed(3),
					exposure: +sun.exposure.toFixed(3),
					ambient: +sun.ambient.toFixed(3),
					sky: '#' + scene.background.getHexString(),
					active: sun.active,
				},
```

Et l'ajouter au handle de debug à côté de `fog` dans l'objet `window.__sim` (vers `src/main.js:310`) : `physics, controller, camera, renderer, scene, input, timeline, audio, lens, link, rain, fog, sun`.

- [ ] **Step 6 : vérifier**

Run: `cd sim && node tools/selftest.mjs && npm run build`
Expected: `all checks passed` et un build réussi.

- [ ] **Step 7 : commit**

```bash
git add src/main.js
git commit -m "Câbler le soleil : ciel dynamique, occlusion, exposition (issue #23)

weatherSky() ne part plus d'une constante mais du ciel que sun.js dérive —
un seul ciel, et les quatre consommateurs existants (background, fog des
tuiles, rainfall, uSky) le lisent sans changer.

L'occlusion est un rayon par frame via obstructionBetween(), qui existe déjà
pour le lien vidéo : sans elle le soleil se dessine à travers la Tour Eiffel."
```

---

## Task 7 : vérification en vol et documentation

**Files:**
- Modify: `HANDOFF.md`, `README.md`

- [ ] **Step 1 : lancer le sim**

```bash
cd sim && npm run dev
```

Puis, via chrome-devtools MCP, ouvrir `http://localhost:5173/?scene=tour-eiffel`.

- [ ] **Step 2 : lire l'état, ne pas regarder une capture**

Dans la console de la page :

```js
window.__sim.debug().sun
```

Vérifier, à l'heure réelle de la session :
- `elevation` cohérente avec l'heure qu'il est à Paris (soleil haut en milieu de journée, négatif la nuit) ;
- `dir.z > 0` si le soleil est au sud ;
- `sky` cohérent avec l'élévation (`#9fb8cc`-ish à midi, chaud en fin de journée, bleu sombre la nuit) ;
- `active` faux uniquement par soleil haut, ciel clair, soleil hors cadre.

- [ ] **Step 3 : les trois passages de la spec**

1. **Soleil dans le cadre** — piloter face au soleil : `inFrame` monte, `exposure` chute en une fraction de seconde, la ville s'assombrit ; en tournant le dos, `exposure` remonte en ~1 s. C'est la mécanique de l'issue ; si elle ne se remarque pas, `SUN_METER_WEIGHT` est trop faible.
2. **Soleil derrière un bâtiment** — se placer pour que la tour coupe le soleil : `visible` tombe, le disque disparaît, `exposure` ne bouge quasiment pas (un soleil caché ne ferme pas le diaphragme).
3. **Jour couvert** — forcer un ciel bouché avec `window.__sim.sun.setWeather({ cloudPct: 100, visibilityM: 20000 })` : plus de disque, `amount` à 0, ciel gris clair.

- [ ] **Step 4 : non-régression visuelle**

Vérifier qu'à midi par ciel clair `scene.background.getHexString()` rend `9fb8cc` et que `__sim.debug().sun.active` est `false` : c'est la preuve, dans le vrai navigateur, que le ticket ne change rien là où le sim tournait déjà.

- [ ] **Step 5 : documenter**

Dans `HANDOFF.md`, section « Vérifié », ajouter une entrée pour le soleil : ce qui est vérifié au banc (le nombre de checks), ce qui est vérifié en vol (les trois passages), et ce qui ne l'est pas — le ressenti d'un vol complet du lever au coucher, qui demande d'attendre l'heure.

Dans `README.md`, une ligne dans la description des modèles météo : le soleil vient de la lat/lon de la scène et de l'heure réelle, il n'y a **aucun réglage d'heure** et c'est délibéré.

- [ ] **Step 6 : commit et pousser**

```bash
git add HANDOFF.md README.md
git commit -m "HANDOFF/README : le soleil (issue #23)"
git push -u origin issue-23-soleil
```

- [ ] **Step 7 : ouvrir la PR et fermer l'issue**

```bash
gh pr create --repo lionrayonnant/FPVTP --base main \
  --title "Soleil : position depuis lat/lon + heure, éblouissement, exposition (#23)" \
  --body "Ferme #23. Voir sim/docs/superpowers/specs/2026-08-29-soleil-issue-23-design.md."
```

---

## Auto-revue du plan

- **Couverture de la spec.** §1 (option (a), rien de ré-éclairé) → contraintes globales + en-tête de `sun.js` ; §2 (heure = instant UTC, pas de fuseau) → tâche 1 `julianDay` + tâche 6 étape 2 ; §3.1-3.2 (position, axes) → tâche 1 ; §3.3-3.5 (extinction, ciel, crépuscule) → tâche 2 ; §3.6-3.7 (AGC, API) → tâche 3 ; §4 (le ciel cesse d'être une constante) → tâche 6 étape 3 ; §5 (bloc `#if SUN`, occlusion, uniformes) → tâches 5 et 6 ; §6 (bloc `sun` dans weather) → tâche 4 ; §7 (câblage, debug) → tâche 6 ; §8 (vérification) → checks de chaque tâche + tâche 7.
- **Cohérence des noms.** `sunPosition`/`sunVector`/`refracted`/`airMass` (T1) sont consommés par T2 et T3 ; `skyColor`/`sunDisc`/`ambientLevel` (T2) par `SunField.update()` (T3) ; `SunField.setWeather()` (T3) par `applyWeather()` (T4) ; `lens.setSun()` (T5) par `main.js` (T6). `visibilityM` et `cloudPct` portent le même nom du bulletin jusqu'au modèle.
- **Point de vigilance pour l'exécutant.** À la tâche 5 étape 5, `_updateDefines()` doit être **lu avant d'être modifié** : le plan donne l'intention, pas les noms de variables locales exacts.
