# PHASE 27 lot A — la Home et le GLOBAL SCANNER ne font plus qu'un écran

> **Pour un exécutant agentique :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les
> étapes sont en cases à cocher (`- [ ]`).

**But :** faire de FIELD un seul écran en deux colonnes — menus ou rail du
scanner à gauche, une carte vivante à droite qui ne se démonte jamais — et
réduire l'acquisition à un seul bouton.

**Architecture :** `runScanner()` n'est pas réécrit. Il cesse de créer son
propre plein cadre et reçoit deux hôtes (`mapHost`, `railHost`) ; il rend
désormais une poignée (`{ done, setAreaFrames, focusBounds, destroy }`) au lieu
d'une promesse nue. La Home possède les deux colonnes et décide de ce que porte
celle de gauche ; le scanner possède la carte et la garde vivante d'un état à
l'autre.

**Pile :** Vite, Leaflet 1.9 + Geoman, aucun framework. Tests : Node pur
(`tools/*-selftest.mjs`) et faux DOM (`tools/lib/fake-dom.mjs`).

**Spec :** `docs/superpowers/specs/2026-09-05-home-scanner-fusion-design.md`

**Issue :** #211

## Contraintes globales

- **Coordonnées** : ENU mètres après prep — X=est, Y=haut, Z=sud. Sans objet
  ici, mais ne rien introduire qui contredise.
- **Tout le texte d'interface est en anglais** (décision D5). Les commentaires
  de code sont en français, comme tout le dépôt.
- **Pas de coins arrondis, pas d'UI SaaS, pas de meuble de navigateur**
  (Bible §38, §44). Aucune `confirm()`, `alert()` ni `prompt()`.
- **Une seule carte dans le jeu** (Bible §4) : les couches viennent de
  `src/map-layers.js`, les filtres de `.map-mono` dans `style.css`. Ne pas
  dupliquer.
- **Aucune couleur en dur** hors de `src/tokens.css` — `palette-selftest`
  échoue sinon.
- **Ne jamais lire** `public/scenes/`, `flyover-reverse-engineering/cache/` ni
  `downloaded_files/` avec un outil de lecture de fichier.
- **Sceaux de non-régression** : `tools/terminal-model.mjs` n'est pas modifié,
  et `model.footer` part mot pour mot dans le même `pre.terminal-foot`.
- Vérification : `npm run selftest:operator` doit rester au même nombre
  d'assertions ou plus, et n'échouer que sur `landing-selftest` (résidu #196,
  il exige une scène `tour-eiffel` cuite sur disque).

---

### Tâche 1 : `acquireStep()` — l'enchaînement sonde → acquisition, en pur

Rend l'enchaînement testable sans serveur et sans navigateur. `scanner.js` ne
fera plus que l'exécuter.

**Fichiers :**
- Modifier : `tools/scanner-model.mjs` (ajouter en fin de fichier)
- Modifier : `tools/scanner-selftest.mjs` (ajouter avant le `console.log` final)

**Interfaces :**
- Consomme : `coverageLine({ plan, probe, provider })` déjà exporté par
  `tools/scanner-model.mjs:217` — rend `{ status, label, detail }` avec
  `status` parmi `'ok' | 'none' | 'error' | 'unprobed' | 'busy'`.
- Produit : `acquireStep({ zone, source, name, plan, probe })` →
  `{ action, label, disabled, why }` où `action` vaut `'probe' | 'acquire' | null`.

- [ ] **Étape 1 : écrire le test qui échoue**

Ajouter dans `tools/scanner-selftest.mjs`, juste avant la ligne
`console.log(...)` finale :

```js
// --- acquireStep : un seul bouton pour sonder et acquérir ------------------

const SRC = { id: 'flyover', label: 'APPLE FLYOVER' };
const ZONE = { bbox: { south: 48.84, west: 2.33, north: 48.86, east: 2.35 } };

t('acquireStep : sans zone, le bouton est fermé et dit ce qui manque', () => {
	const s = acquireStep({ zone: null, source: SRC, name: 'paris' });
	assert.equal(s.disabled, true);
	assert.equal(s.action, null);
	assert.match(s.why, /AREA/);
});

t('acquireStep : sans source, fermé — la source est désignée, jamais devinée', () => {
	const s = acquireStep({ zone: ZONE, source: null, name: 'paris' });
	assert.equal(s.disabled, true);
	assert.match(s.why, /SOURCE/);
});

t('acquireStep : sans nom, fermé — acquérir écrit sur le disque', () => {
	const s = acquireStep({ zone: ZONE, source: SRC, name: '   ' });
	assert.equal(s.disabled, true);
	assert.match(s.why, /DESIGNATION/);
});

t('acquireStep : tout est là et rien n\'est sondé → on sonde', () => {
	const s = acquireStep({ zone: ZONE, source: SRC, name: 'paris' });
	assert.equal(s.disabled, false);
	assert.equal(s.action, 'probe');
	assert.equal(s.label, 'ACQUIRE AREA');
});

t('acquireStep : couverture confirmée → on acquiert, sans 2e pression', () => {
	const s = acquireStep({
		zone: ZONE, source: SRC, name: 'paris',
		plan: { columns: 4 }, probe: { status: 'ok' },
	});
	assert.equal(s.action, 'acquire');
	assert.equal(s.label, 'ACQUIRE AREA');
});

t('acquireStep : rien ici → arrêt, et le libellé demande la confirmation', () => {
	const s = acquireStep({
		zone: ZONE, source: SRC, name: 'paris',
		plan: { columns: 0 }, probe: null,
	});
	assert.equal(s.action, 'acquire');
	assert.equal(s.label, 'ACQUIRE ANYWAY');
	assert.equal(s.disabled, false);
});

t('acquireStep : sonde injoignable → même arrêt, détail différent', () => {
	// Un échec de sonde n'est PAS un verdict de couverture : coverageLine
	// distingue déjà les deux, et c'est à l'opérateur de décider s'il engage
	// dix minutes sur une sonde qui n'a pas répondu.
	const s = acquireStep({
		zone: ZONE, source: SRC, name: 'paris',
		plan: { columns: 4 }, probe: { status: 'error', message: 'network' },
	});
	assert.equal(s.action, 'acquire');
	assert.equal(s.label, 'ACQUIRE ANYWAY');
	assert.notEqual(s.why, acquireStep({
		zone: ZONE, source: SRC, name: 'paris', plan: { columns: 0 }, probe: null,
	}).why, 'injoignable et « rien ici » ne se disent pas pareil');
});
```

Ajouter `acquireStep` à la liste d'imports en haut de
`tools/scanner-selftest.mjs` (elle importe déjà depuis `./scanner-model.mjs`).

- [ ] **Étape 2 : lancer le test, vérifier qu'il échoue**

Lancer : `node tools/scanner-selftest.mjs`
Attendu : `SyntaxError: … does not provide an export named 'acquireStep'`

- [ ] **Étape 3 : écrire l'implémentation minimale**

Ajouter en fin de `tools/scanner-model.mjs` :

```js
// L'enchaînement sonde → acquisition, réduit à UN bouton (issue #211).
//
// Avant, deux boutons et une modale : [ PROBE AREA ], puis [ ACQUIRE AREA ]
// qui ouvrait un `confirm()` si l'on n'avait pas sondé. Une modale de
// navigateur est exactement le meuble que la Bible §44 refuse, et que #205 a
// chassé des <select> et des <input type=range>.
//
// Désormais : une pression sonde et enchaîne sur l'acquisition si la couverture
// est confirmée. Si elle ne l'est pas — rien ici, ou sonde injoignable — la
// séquence S'ARRÊTE, le verdict dit pourquoi, et le bouton devient
// ACQUIRE ANYWAY. La deuxième pression EST la confirmation, dans la langue du
// jeu plutôt que dans celle du navigateur.
//
// Fonction pure : c'est elle qu'on teste, scanner.js ne fait que l'exécuter.
export function acquireStep({ zone, source, name, plan = null, probe = null } = {}) {
	const clean = String(name ?? '').trim();
	// Ordre délibéré : on nomme le premier manque, pas tous. « DRAW AN AREA »
	// et « PICK A SOURCE » ne se disent pas en même temps sur un bouton.
	if (!zone) return { action: null, label: 'ACQUIRE AREA', disabled: true, why: 'DRAW AN AREA FIRST' };
	if (!source) return { action: null, label: 'ACQUIRE AREA', disabled: true, why: 'PICK A SOURCE FIRST' };
	if (!slugify(clean)) return { action: null, label: 'ACQUIRE AREA', disabled: true, why: 'DESIGNATION REQUIRED' };

	// Rien n'a encore été demandé au fournisseur : la pression sonde.
	if (!plan && !probe) return { action: 'probe', label: 'ACQUIRE AREA', disabled: false, why: null };

	const v = coverageLine({ plan, probe, provider: source });
	// Couverture confirmée : on enchaîne sans demander une deuxième pression.
	if (v.status === 'ok') return { action: 'acquire', label: 'ACQUIRE AREA', disabled: false, why: null };
	// Tout le reste — rien ici, injoignable, pas encore sondé — s'arrête et
	// demande un geste explicite. `why` porte le détail de coverageLine, qui
	// distingue déjà « injoignable » de « rien ici ».
	return { action: 'acquire', label: 'ACQUIRE ANYWAY', disabled: false, why: v.detail ?? v.label };
}
```

- [ ] **Étape 4 : lancer le test, vérifier qu'il passe**

Lancer : `node tools/scanner-selftest.mjs`
Attendu : les 7 nouveaux tests en `ok`, et le total passe de 29 à 36.

- [ ] **Étape 5 : commiter**

```bash
git add tools/scanner-model.mjs tools/scanner-selftest.mjs
git commit -m "feat(scanner): acquireStep, l'enchaînement sonde→acquisition en pur (#211)"
```

---

### Tâche 2 : un seul bouton dans le scanner, et plus de `confirm()`

Câble `acquireStep()`. Le scanner reste plein cadre — la simplification atterrit
et se vérifie **avant** tout changement de mise en page.

**Fichiers :**
- Modifier : `src/scanner.js` — bloc `PANEL` (~ligne 88-113), `updateButtons()`
  (~583), le gestionnaire `.sc-probe` (~451), le gestionnaire `.sc-acquire`
  (~699)
- Modifier : `src/style.css` si un style visait `.sc-probe`

**Interfaces :**
- Consomme : `acquireStep({ zone, source, name, plan, probe })` de la tâche 1.
- Produit : rien de nouveau vers l'extérieur.

- [ ] **Étape 1 : retirer `[ PROBE AREA ]` du panneau**

Dans le gabarit `PANEL` de `src/scanner.js`, supprimer la ligne
`<button type="button" class="sc-cta sc-probe" disabled>[ PROBE AREA ]</button>`.
Garder `.sc-verdict` et `.sc-detail` : ce sont eux qui portent le verdict.

- [ ] **Étape 2 : fusionner les deux gestionnaires**

Remplacer les deux gestionnaires `$('.sc-probe').onclick` et
`$('.sc-acquire').onclick` par un seul, sur `.sc-acquire`. Extraire le corps de
l'ancien `.sc-probe` dans une fonction `async function runProbe()` — **son code
ne change pas**, y compris le `sayOnce('PROBE_AREA', …)` sans `await` et le
`if (plan.columns === 0) return;`. Extraire le corps de l'acquisition dans
`async function startJob()`, **sans** le bloc `confirm()`.

Le nouveau gestionnaire :

```js
	// Un seul bouton (#211). La première pression sonde ; si la couverture est
	// confirmée, elle enchaîne sur l'acquisition sans en demander une seconde.
	// Sinon elle s'arrête, le verdict dit pourquoi, et le bouton devient
	// ACQUIRE ANYWAY — la deuxième pression EST la confirmation. Plus de
	// confirm() : une modale de navigateur, refusée par §44.
	$('.sc-acquire').onclick = async () => {
		const step = acquireStep({
			zone: state.zone, source: provider(), name: $('.sc-name').value,
			plan: state.plan, probe: state.probe,
		});
		if (step.disabled || !step.action) return;
		if (step.action === 'probe') {
			await runProbe();
			// La sonde a rempli state.plan / state.probe : on redemande au modèle
			// s'il faut enchaîner. C'est lui qui décide, pas ce gestionnaire.
			const next = acquireStep({
				zone: state.zone, source: provider(), name: $('.sc-name').value,
				plan: state.plan, probe: state.probe,
			});
			if (next.action === 'acquire' && next.label === 'ACQUIRE AREA') await startJob();
			else updateButtons();
			return;
		}
		await startJob();
	};
```

- [ ] **Étape 3 : le libellé et l'état du bouton viennent du modèle**

Dans `updateButtons()`, remplacer les deux lignes `.sc-probe` / `.sc-acquire`
par :

```js
		const step = acquireStep({
			zone: state.zone, source: src, name, plan: state.plan, probe: state.probe,
		});
		const acq = $('.sc-acquire');
		acq.disabled = step.disabled;
		acq.textContent = `[ ${step.label} ]`;
		note('.sc-acquire-note', step.disabled ? step.why : null, null);
```

Laisser la ligne `.sc-fly-live` telle quelle : voler en direct ne dépend que de
la zone (#206), et le modèle d'acquisition n'a rien à en dire.

- [ ] **Étape 4 : vérifier qu'aucune `confirm()` ne subsiste**

Lancer : `grep -n "confirm(\|alert(\|prompt(" src/*.js`
Attendu : aucune ligne dans `src/scanner.js`.

- [ ] **Étape 5 : lancer la chaîne**

Lancer : `npm run selftest:operator 2>&1 | grep -ciE '^\s*ok'`
Attendu : au moins 842 (835 + les 7 de la tâche 1), aucun `AssertionError`.

Lancer : `npm run build`
Attendu : exit 0.

- [ ] **Étape 6 : commiter**

```bash
git add src/scanner.js src/style.css
git commit -m "feat(scanner): un seul bouton pour sonder et acquérir, plus de confirm() (#211)"
```

---

### Tâche 3 : `runScanner()` reçoit ses hôtes et rend une poignée

Le changement structurel. Le corps du scanner ne bouge pas ; son montage et sa
résolution, si.

**Fichiers :**
- Modifier : `src/scanner.js` — signature (~198), montage (~200-203),
  `cleanup()` (~666), le `return new Promise(...)` final
- Modifier : `src/terminal.js` — `globalScanner()` (~89)
- Modifier : `src/style.css` — `.scanner`, `.scanner-map`, `.scanner-panel`

**Interfaces :**
- Produit :
  ```
  runScanner({ mapHost, railHost, onZone, onPickArea })
    → { done: Promise<{slug}|{live:[lat,lon]}|undefined>,
        setAreaFrames(scenes), focusBounds(bounds), destroy() }
  ```
  - `mapHost` : élément où monter la carte. **Le scanner ne le supprime
    jamais** — il appartient à l'appelant.
  - `railHost` : élément où monter le rail. Le scanner le vide et le remplit.
  - `onZone(zone | null)` : appelé chaque fois qu'une zone apparaît ou
    disparaît. C'est le signal repos ↔ travail.
  - `onPickArea(slug)` : appelé au clic sur le cadre d'une zone acquise. C'est
    le sens carte → liste de la sélection.
  - `setAreaFrames(scenes)` : dessine le cadre de chaque zone acquise.
  - `focusBounds(bounds)` : recadre la carte, sans toucher au tracé.
  - `destroy()` : `map.remove()` + `nav.detach()` + `stopSearch()`. À appeler
    quand la Home meurt, jamais entre deux états.

- [ ] **Étape 1 : changer la signature et le montage**

```js
export function runScanner({ mapHost, railHost, onZone = null } = {}) {
	// Le plein cadre a disparu : la Home possède les deux colonnes et nous
	// donne où nous poser. `mapHost` ne nous appartient PAS — c'est ce qui
	// permet à la carte de survivre au passage repos → travail (#211).
	const el = railHost;
	railHost.classList.add('scanner-panel');
	mapHost.classList.add('scanner-map', 'map-mono');
	railHost.innerHTML = PANEL;

	const $ = (sel) => railHost.querySelector(sel);
	const panel = railHost;
```

Puis, partout où le code faisait `L.map($('.scanner-map'), …)`, utiliser
`mapHost`.

- [ ] **Étape 2 : `cleanup()` ne détruit plus la carte**

```js
	// Ne détruit QUE ce que le scanner a créé. `mapHost` appartient à la Home,
	// et la carte doit survivre à la fermeture du rail — c'est la promesse
	// centrale de l'écran. La carte se démonte par destroy(), quand la Home
	// meurt, jamais entre deux états.
	function cleanup() {
		stopSearch?.();
		nav.detach();
		railHost.replaceChildren();
	}
```

- [ ] **Étape 3 : signaler les changements de zone**

Dans `setZone()`, après `state.zone = …`, ajouter `onZone?.(state.zone);`
Dans `clearZone()`, après `state.zone = … = null;`, ajouter `onZone?.(null);`

- [ ] **Étape 4 : les cadres des zones acquises et le recadrage**

Ajouter, à côté des autres couches (`lattice`, `pruned`, `outline`, `snapped`) :

```js
	// Les zones déjà acquises, à leur vraie place sur la carte vivante. Même
	// encre que le rectangle `snapped` : ce que la Home montre et ce que
	// l'acquisition avait dessiné doivent se reconnaître (#207).
	const areaFrames = L.layerGroup().addTo(map);
```

Et les deux méthodes :

```js
	function setAreaFrames(scenes) {
		areaFrames.clearLayers();
		for (const sc of scenes ?? []) {
			const b = previewBounds(sc);
			// previewBounds rend null pour une zone sans emprise connue : elle
			// n'a pas de cadre, et reste sélectionnable par la liste seule. Un
			// repli sur (0, 0) montrerait le golfe de Guinée.
			if (!b) continue;
			L.rectangle(b, { color: token('--warm-white'), weight: 1, fill: false, interactive: true })
				.on('click', () => onPickArea?.(sc.slug))
				.addTo(areaFrames);
		}
	}
	function focusBounds(b) { if (b) map.fitBounds(b, { padding: [24, 24] }); }
```

Ajouter `onPickArea` aux options de `runScanner` et les imports
`previewBounds` (`../tools/map-preview-model.mjs`) et `token` (`./palette.js`)
en haut du fichier — vérifier d'abord s'ils y sont déjà.

- [ ] **Étape 5 : rendre la poignée**

```js
	return {
		done: new Promise((resolve) => { resolveScanner = resolve; }),
		setAreaFrames,
		focusBounds,
		// La carte ne meurt qu'ici. `map.remove()` retire les écouteurs que
		// Leaflet a posés sur window : sans lui, une Home ouverte trois fois
		// laisse trois cartes vivantes derrière elle.
		destroy: () => { cleanup(); map.remove(); },
	};
```

- [ ] **Étape 6 : adapter l'appelant provisoire**

Dans `src/terminal.js`, `globalScanner()` devient provisoirement :

```js
		const host = document.createElement('div');
		host.className = 'scanner';
		const mapHost = document.createElement('div');
		const railHost = document.createElement('aside');
		host.append(mapHost, railHost);
		root.appendChild(host);
		const sc = runScanner({ mapHost, railHost });
		const choice = await sc.done;
		sc.destroy();
		host.remove();
		return choice;
```

C'est un échafaudage : la tâche 4 le supprime. Il existe pour que la tâche 3
soit vérifiable seule.

- [ ] **Étape 7 : vérifier au rendu réel**

Lancer `npm run dev`, puis le harnais CDP de la passe #209 : ouvrir la Home,
cliquer `[ GLOBAL SCANNER ]`, capturer. Attendu : le scanner s'affiche comme
avant, la recherche fonctionne, dessiner une boîte remplit AREA ANALYSIS.

- [ ] **Étape 8 : commiter**

```bash
git add src/scanner.js src/terminal.js src/style.css
git commit -m "refactor(scanner): reçoit ses hôtes et rend une poignée, la carte lui survit (#211)"
```

---

### Tâche 4 : la Home en deux colonnes, deux états

**Fichiers :**
- Modifier : `src/terminal.js` — `runTerminal()` (~570-720)
- Modifier : `src/style.css` — bloc `.terminal-home`
- Modifier : `tools/terminal-render-selftest.mjs`

**Interfaces :**
- Consomme : la poignée de la tâche 3.
- Produit : rien vers l'extérieur — `runTerminal` garde exactement sa
  résolution (`{slug, resume}`, `{live:[lat,lon]}`, `null`).

- [ ] **Étape 1 : écrire les tests qui échouent**

Ajouter dans `tools/terminal-render-selftest.mjs` :

```js
await ta('home : deux colonnes, et la carte est dans celle de droite', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(dom.root.querySelector('.terminal-left'), 'la colonne des menus');
	assert.ok(dom.root.querySelector('.terminal-right'), 'la colonne de la carte');
	assert.equal(btn('GLOBAL SCANNER'), undefined, 'plus d\'ailleurs où aller');
	await close(p);
});

await ta('home : la carte SURVIT au passage repos → travail', async () => {
	// C'est la promesse centrale de l'écran. Si ce test tombe, la fusion n'a
	// plus d'intérêt : autant garder deux écrans.
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const avant = dom.root.querySelector('.terminal-map');
	dom.root.querySelector('.terminal-left').dataset.state = 'probe';   // simule un tracé
	assert.equal(dom.root.querySelector('.terminal-map'), avant, 'le MÊME nœud, pas un équivalent');
	await close(p);
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node tools/terminal-render-selftest.mjs`
Attendu : `AssertionError` sur « la colonne des menus ».

- [ ] **Étape 3 : construire les deux colonnes**

Dans `runTerminal()`, remplacer le corps de `render()` : `s.box` reçoit deux
enfants permanents, `div.terminal-left` et `div.terminal-right`. **Seule la
colonne gauche est reconstruite** par `render()` ; la droite est créée une fois,
hors de `render()`, et n'est jamais vidée.

Supprimer `disposeMap()`, `miniMap`, l'import dynamique de `./mini-map.js` et
le bloc `.terminal-map-none` : la carte du scanner remplace la vignette.

Monter le scanner une fois, après la première construction des colonnes :

```js
	// Le scanner est monté UNE fois et vit aussi longtemps que la Home. Son
	// rail n'apparaît que quand une zone est tracée ; sa carte, elle, est
	// toujours là. C'est ce qui fait de l'écran un seul écran (#211).
	const { runScanner } = await import('./scanner.js');
	const rail = document.createElement('aside');
	scanner = runScanner({
		mapHost: right, railHost: rail,
		onZone: (zone) => { drawing = !!zone; renderLeft(); },
		onPickArea: (slug) => { selected = slug; renderLeft(); },
	});
	scanner.setAreaFrames(Array.isArray(scenes) ? scenes : []);
	scanner.done.then((choice) => {
		if (choice?.slug) return fly(choice.slug);
		if (choice?.live) return flyLive(choice.live);
	});
```

`renderLeft()` monte `rail` dans `left` quand `drawing` est vrai, et le menu
sinon. `quit()` appelle `scanner?.destroy()` avant `s.remove()`.

- [ ] **Étape 4 : supprimer `[ GLOBAL SCANNER ]` et `globalScanner()`**

Retirer le bouton du bloc `terminal-acts`, et supprimer la fonction
`globalScanner()` ainsi que le drapeau `scannerOpen` : plus personne ne les
appelle.

- [ ] **Étape 5 : le CSS des deux colonnes**

```css
/* FIELD est un seul écran (Bible §4 : « le GLOBAL SCANNER est le menu
   principal »). Deux colonnes : à gauche ce qu'on lit et ce qu'on choisit, à
   droite le monde. La carte ne bouge pas quand la gauche change d'état — c'est
   toute la raison d'être de cette mise en page. */
.terminal-home .terminal-box { width: 100%; max-width: none; display: grid;
	grid-template-columns: minmax(320px, 34%) 1fr; gap: 0; height: 100vh; }
.terminal-left { display: flex; flex-direction: column; gap: var(--space-4);
	padding: var(--space-5); overflow-y: auto; }
.terminal-right { position: relative; }
.terminal-map { position: absolute; inset: 0; height: auto; }
/* Sous 1100px on empile. Le rail remplace toujours le bloc de texte, jamais la
   carte : la promesse tient aussi empilée. */
@media (max-width: 1100px) {
	.terminal-home .terminal-box { grid-template-columns: 1fr;
		grid-template-rows: 40vh 1fr; height: 100vh; }
}
```

`.bootstrap` étant en `align-content: safe center` (passe #209), ajouter
`.terminal-home { align-content: stretch; justify-items: stretch; padding: 0; }`
pour que la Home occupe le cadre plein.

- [ ] **Étape 6 : lancer les tests**

Lancer : `node tools/terminal-render-selftest.mjs`
Attendu : les 12 tests en `ok`.

- [ ] **Étape 7 : vérifier au rendu réel**

Harnais CDP : capturer la Home au repos, puis après un tracé. Attendu : la
carte occupe la droite et **ne bouge pas** entre les deux ; la colonne gauche
passe du menu au rail.

- [ ] **Étape 8 : commiter**

```bash
git add src/terminal.js src/style.css tools/terminal-render-selftest.mjs
git commit -m "feat(terminal): FIELD devient un seul écran en deux colonnes (#211)"
```

---

### Tâche 5 : la sélection dans les deux sens

**Fichiers :**
- Modifier : `src/terminal.js` — la liste compacte
- Modifier : `tools/terminal-render-selftest.mjs`

- [ ] **Étape 1 : écrire le test qui échoue**

```js
await ta('home : choisir une zone recadre la carte, sans la remonter', async () => {
	reset();
	const p = runTerminal(dom.root, { settings: null, api: api(operator()), back: true });
	await new Promise((r) => setTimeout(r, 0));
	const carte = dom.root.querySelector('.terminal-map');
	const avant = btn('FLY —').textContent;
	dom.root.querySelectorAll('.terminal-area').at(1).click();
	await new Promise((r) => setTimeout(r, 0));
	assert.notEqual(btn('FLY —').textContent, avant, 'le CTA se réétiquette');
	assert.equal(dom.root.querySelector('.terminal-map'), carte, 'la carte n\'a pas été remontée');
	await close(p);
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec**

Lancer : `node tools/terminal-render-selftest.mjs`

- [ ] **Étape 3 : implémenter**

Dans le `onActivate` de `areaRow()`, remplacer `render()` par :

```js
	onActivate: (picked) => {
		selected = picked.slug;
		// La liste SÉLECTIONNE, elle ne fait pas voler (#123) : elle recadre la
		// carte et réétiquette [ FLY ]. On ne re-rend QUE la colonne gauche —
		// re-rendre tout remonterait la carte, ce que cet écran promet de ne
		// jamais faire.
		scanner?.focusBounds(previewBounds(picked));
		renderLeft();
	},
```

- [ ] **Étape 4 : lancer les tests**

Attendu : 13 tests en `ok`.

- [ ] **Étape 5 : commiter**

```bash
git add src/terminal.js tools/terminal-render-selftest.mjs
git commit -m "feat(terminal): la liste et la carte désignent la même zone dans les deux sens (#211)"
```

---

### Tâche 6 : vérification d'ensemble

- [ ] **Étape 1 : la chaîne complète**

Lancer : `npm run selftest:operator > /tmp/st.log 2>&1; grep -ciE '^\s*ok' /tmp/st.log; grep -c AssertionError /tmp/st.log`
Attendu : ≥ 844 `ok`, 0 `AssertionError`, échec final sur `landing-selftest`
uniquement.

- [ ] **Étape 2 : le build**

Lancer : `npm run build`
Attendu : exit 0. Vérifier que Leaflet reste dans son chunk asynchrone
(`scanner-*.js`) et que le chunk d'entrée n'explose pas.

- [ ] **Étape 3 : les sceaux de non-régression, au rendu réel**

Harnais CDP, dans l'ordre : `SELECT OPERATION MODE` → BENCH décolle ; retour →
FIELD → la Home deux colonnes ; ARCHIVE et ses six écrans ; `MORE…` ; un tracé
→ le rail → `[ ACQUIRE AREA ]` ; `?scene=paristest` saute le terminal.

- [ ] **Étape 4 : le pied, mot pour mot**

Lancer : `grep -n "terminal-foot" src/terminal.js`
Vérifier que `foot.textContent = model.footer;` est inchangé et que
`tools/terminal-model.mjs` n'apparaît pas dans `git diff --name-only main`.

- [ ] **Étape 5 : mettre à jour HANDOFF.md**

Ajouter à la section « Vérifié » ce que le lot A livre, et à « Non vérifié » ce
qui reste : la nav manette dans les deux colonnes, et le lot B (#212).

- [ ] **Étape 6 : commiter et pousser**

```bash
git add sim/HANDOFF.md
git commit -m "docs(handoff): PHASE 27 lot A — FIELD en un seul écran (#211)"
git push
```
