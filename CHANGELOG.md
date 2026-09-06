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
