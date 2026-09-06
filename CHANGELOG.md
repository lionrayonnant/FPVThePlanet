# Changelog

Toutes les modifications notables de FPVThePlanet! sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
versionnage suit [SemVer](https://semver.org/lang/fr/). La source de vérité du
numéro est le champ `version` de `sim/package.json` ; chaque version publiée
porte un tag git `vX.Y.Z` et une GitHub Release.

Rubriques : `Ajouté`, `Modifié`, `Corrigé`, `Retiré`, `Déprécié`, `Sécurité`.

Ce qui précède la première version se lit dans le `git log` : le dépôt a vécu
98 commits avant d'être versionné.

Note : les numéros de build de l'écran `BUILD NOTES`
(`sim/tools/buildnotes-model.mjs`) sont du lore diégétique et n'ont aucun
rapport avec les versions ci-dessous.

## [Non publié]

### Ajouté

- Calibrage automatique des radios et des manettes (#277) : un assistant guidé
  dans le panneau Tab (`CALIBRATE`) qui MESURE le périphérique au lieu de le
  deviner à partir de sa chaîne USB. Une consigne à la fois — neutre, gaz,
  lacet, tangage, roulis — d'où sortent le neutre réel de chaque axe, la course
  réelle, le bruit au repos (qui devient le deadband) et le mode de course du
  gaz, observé en lâchant le manche plutôt que déduit de la marque. Deux axes
  poussés ensemble, ou un axe déjà pris, font redemander la consigne au lieu
  d'attribuer un mappage faux en silence. `src/calibration.js` est une machine à
  états pure, couverte par `tools/calibration-selftest.mjs`.
- `node tools/sync-scenes.mjs --adopt` réenregistre dans `scenes.json` les
  scènes présentes dans `public/scenes/` mais absentes du catalogue (#275) :
  les deux dérivent dans les deux sens, l'outil ne savait retirer que les
  fantômes. Chaque entrée est reconstruite depuis le `manifest.json` de la
  scène. L'adoption est explicite : `scenes.json` est versionné.
- `npm run selftest:ci` couvre le chargeur face à un fichier absent
  (`tools/loader-guard-selftest.mjs`).

- Versionnage du dépôt (#257) : `CHANGELOG.md`, version SemVer dans
  `sim/package.json`, tags `vX.Y.Z`.
- `npm run release -- patch|minor|major|X.Y.Z` : bump de la version, datation
  de la section « Non publié », commit `chore(release)` et tag annoté. Le push
  reste manuel.
- Workflow GitHub `release.yml` : sur un tag `v*`, build du sim puis création
  de la GitHub Release, corps repris du CHANGELOG et archive `dist` attachée.
- La version est exposée au runtime : `__APP_VERSION__` injecté par Vite et
  `window.FPVTP_VERSION` dans la console au démarrage.
- `npm run selftest:release` couvre le modèle pur du versionnage.
- Intégration continue (`.github/workflows/ci.yml`) : sur push `main` et sur
  chaque pull request, `npm run selftest:ci` (~1 430 vérifications, ~2 min) et
  `npm run build` pour le sim, `go vet` / `go build` / `go test` pour
  l'exporteur. La release passe par les mêmes selftests avant de publier.
- `npm run selftest:ci` : la chaîne qui ne demande ni scène installée, ni
  réseau, ni navigateur.
- `npm run add-music` refuse une graine de base déjà présente dans
  `public/music.json` et en propose une libre (#122) : la réutiliser ne
  générait pas d'autres morceaux mais exactement les mêmes, que le worker
  sautait ensuite comme déjà présents — un échec silencieux.

### Modifié

- `tools/landing-selftest.mjs` se retire en disant `SKIP` quand la scène
  `public/scenes/tour-eiffel` (gitignorée) est absente, au lieu de casser la
  chaîne sur un `ENOENT`.

### Corrigé

- Le calibrage ne voyait pas un gaz rangé en gâchette (#279) : Firefox applique
  le `mapping: "standard"` à une Radiomaster Pocket et range son manche des gaz
  dans l'emplacement de la gâchette L2 — le gaz sort sur `buttons[6].value`,
  analogique (`0.997`, valeur qu'un bouton numérique ne peut pas rendre), et le
  quatrième axe reste mort. `calibration.js` ne lisait que `pad.axes` : la
  consigne `THROTTLE — FULL UP` ne pouvait pas aboutir, quel que soit le geste.
  Axes et boutons entrent désormais dans un vecteur unique (`padSignals()`), les
  boutons ramenés sur la course des axes — repos à `-1`, comme un manche à
  friction parqué en bas. Le remap manuel et le récapitulatif suivent, et
  nomment `btn 6` plutôt qu'un `axis 14` qui n'existe pas.
- L'assistant de calibrage restait muet devant un périphérique qui ne rapporte
  rien (#279) : un pad muet passe l'étape `HANDS OFF` *mieux* qu'un vrai — bruit
  nul, donc aucun rejet — puis laissait le pilote devant une consigne qui ne
  bougeait jamais. Après six secondes sans le moindre geste, il le dit.

- Le mappage manette n'était pas attaché au périphérique (#277) : `_savedMap`
  était un booléen global et `fpvmaps.gamepadMap` une entrée unique, si bien
  qu'un remap fait pour une radio restait collé en branchant une DualShock 4 —
  dont les axes sont dans un autre ordre ET dont le gaz est en demi-course. Les
  calibrages sont désormais rangés par identifiant de périphérique.
- Une scène absente ne fait plus échouer le boot sur un `SyntaxError:
  Unexpected token '<'` (#275). Un fichier statique manquant ne rend **pas**
  404 : Vite, et tout hébergement avec un fallback SPA, rabat la requête sur
  `index.html` et répond 200 `text/html`. `res.ok` ne disait donc rien, et le
  `res.json()` suivant mourait sur `<!doctype`. Le chargeur regarde désormais le
  type de contenu, et son message nomme la scène et dit quoi lancer.
- Le garde-fou anti-scènes-fantômes de `loadSceneList()` filtre enfin quelque
  chose (#275) : il gardait toute scène dont le `HEAD` répondait `ok`, ce qui
  était **toujours** vrai — c'est lui qui laissait choisir une scène absente.

- La vue embarquée montrait la machine entière (#264) : le boîtier de caméra,
  centré sur l'oeil, plus la batterie et la GoPro derrière lui remplissaient le
  cadre — on ne voyait plus ni le monde ni ses propres hélices. Le niveau
  `onboard` ne porte plus que les quatre rotors, et `eyeOf(profile)` donne
  enfin une définition unique à la position de l'oeil.
- La borne DA ne mesurait que les disques d'hélice (#264) : les conduits, les
  bras et les moteurs étaient dans le cadre sans que rien ne les regarde.
  `tools/lens-coverage.mjs` mesure le maillage tel qu'il est affiché, et le
  selftest borne famille par famille — ce qui est garanti pour les six, c'est
  que la moitié haute du cadre reste libre.

[Non publié]: https://github.com/lionrayonnant/FPVTP/commits/main
