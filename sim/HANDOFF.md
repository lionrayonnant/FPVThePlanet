# Handoff — POC simulateur de drone FPV (Paris / Tour Eiffel)

État au 2026-08-27, réorganisé le 2026-08-29. Écrit pour reprendre le travail
sans redériver le contexte.

Ce fichier ne garde que **l'état courant**. Les récits de session détaillés —
pourquoi chaque sous-système est comme il est, ce qui a été mesuré, les pièges
rencontrés — sont dans `docs/handoff-archive/`. Les y lire seulement quand on
touche au sous-système concerné.

| fichier | contenu |
|---|---|
| [pipeline-cartes.md](docs/handoff-archive/pipeline-cartes.md) | GUI d'ajout de cartes, prep d'origine, passage au multi-cartes, support HEIC |
| [modele-de-vol.md](docs/handoff-archive/modele-de-vol.md) | `quad.js` / `flightController.js`, le banc `tune-pid` |
| [son.md](docs/handoff-archive/son.md) | synthèse Web Audio depuis les quatre moteurs, fatigue auditive |
| [rendu-fpv.md](docs/handoff-archive/rendu-fpv.md) | `lens.js` (optique), lien vidéo RSSI par raycast |
| [meteo.md](docs/handoff-archive/meteo.md) | vent, pluie, gouttes sur la lentille, brouillard |
| [bugs.md](docs/handoff-archive/bugs.md) | les 10 bugs du POC et la méthode qui les a trouvés |

## Statut : ça vole

Le POC fonctionne de bout en bout, vérifié à la fois en headless (SwiftShader)
et sur le vrai GPU de l'utilisateur (AMD RX 9060 XT) via MCP chrome-devtools,
manette EdgeTX réelle branchée et détectée.

Les textures étaient fausses (motifs retournés, larges plaques grises) : c'était
un seul bug, l'axe V des UV, corrigé — voir [handoff-archive/bugs.md](docs/handoff-archive/bugs.md) n°9. **La « limite connue » sur
les façades grises que décrivait une version précédente de ce document n'existe
pas** ; c'était ce bug.


## Comment reprendre

```bash
cd sim
npm install          # si node_modules absent
npm run dev           # http://localhost:5173 — terminal opérateur (PHASE 02), puis vol
                      #   ?scene=<slug> saute le terminal (dev)
npm run selftest      # 15 vérifications sans navigateur (scène tour-eiffel par défaut)
```

Deux cartes prêtes à l'emploi dans `public/scenes/` (gitignored, ~900 Mo à
deux) : `tour-eiffel` et `ile-de-la-cite-et-ile-saint-louis`. Pour en ajouter
une autre : `npm run add-map -- "Nom" <lat> <lon>` — voir `README.md` section
« Ajouter une carte » pour le détail des options et le dimensionnement de
`--radius`.

Plan d'origine (contexte de la décision d'architecture) :
`/home/user/.claude/plans/j-ai-une-carte-de-flickering-cat.md`


## Vérifié

- `npm run selftest` : 15/15 PASS (géodésie, sol, vol, collision/CCD, textures).
  Les deux checks textures mesurent 14,7 |dRGB| et 0,8 % de gris.
- Rendu réel sur GPU utilisateur (RX 9060 XT, ANGLE/radeonsi) : **5 draw calls,
  3 742 191 triangles**, coût GPU **1,68 ms/frame** à 256 px (mesuré par sync
  `readPixels` ; c'était ~1 ms à 128 px). Large marge sur un budget de 10 ms.
- Chargement complet : **~2,7 s**, dont `chunks` 1,05 s, `collision-build`
  1,30 s, `gpu-upload` 0,24 s pour 1,65 Go.
- Manette EdgeTX Radiomaster Pocket détectée et mappée correctement en
  conditions réelles.
- **GLOBAL SCANNER (PHASE 03)**, vérifié en direct via MCP chrome-devtools sur
  le serveur de dev : recherche Nominatim, cadrage, rectangle Geoman, grille de
  tuiles réelle, `PROBE AREA` (plan Go + échantillon : « 27 tiles came back »),
  `ACQUIRE AREA` (pipeline complet, 100 tuiles, 9 Mo sur disque), puis `[ FLY ]`
  qui charge la carte fraîchement acquise (3 draw calls, 118 011 triangles,
  100 fps). La carte d'essai a été supprimée après coup.
- Captures MCP chrome-devtools au ras du sol (piste d'athlétisme du stade Émile
  Anthoine, Champ-de-Mars, façades) : textures à l'endroit, lisibles, aucune
  plaque grise. `take_screenshot` du MCP capture bien le canvas WebGL, contrairement
  au `page.screenshot()` de puppeteer utilisé lors de la session précédente.

## Non vérifié / à faire

- **Le scanner sur une zone hors couverture Flyover** : le chemin `columns === 0`
  et le grisé des colonnes élaguées (`prunedBands`) sont testés unitairement,
  jamais vus en vrai — toutes les zones sondées à la main étaient couvertes.
- **Ressenti de pilotage réel** (l'utilisateur n'a pas encore volé "pour de
  vrai" avec retour subjectif sur l'acro, les rates, l'expo).
- **Écran de réglages manette** (Tab, remapping avec barres de niveau) —
  code écrit, jamais testé interactivement par l'utilisateur.
- Modes `angle` et `altitude` du contrôleur de vol — testés uniquement par
  construction du code, pas en vol piloté.
- L'état opérateur (`/__operator`) n'existe que sous le serveur de dev ; exposer
  ce serveur (p. ex. via `vite.ngrok.config.js`) expose aussi l'état opérateur.

## Le seul arbitrage restant : la résolution

Ce n'est pas le gris (voir [handoff-archive/bugs.md](docs/handoff-archive/bugs.md) n°9), c'est la finesse. Mesuré sur la géométrie :
853 m² de surface par matériau pour ~50 % d'une texture 512², soit **12,6
texels/m (8 cm/texel) au plafond de la source**. Le pipeline tourne à 256 px de
cellule, soit 6,3 texels/m (16 cm/texel) pour 1,65 Go de VRAM.

Aller au natif coûte cher : chaque doublement de `--cell` quadruple la VRAM.
`--cell 512` en RGBA8 demande ~6,6 Go, ce qui passe sur 16 Go mais sans marge.
La vraie sortie serait la compression BC1 (natif à ~830 Mo de VRAM), au prix
d'un encodeur DXT1 et d'une chaîne de mips à écrire dans `prep.mjs` et de
~620 Mo de binaire à servir. À trancher seulement si 16 cm/texel gêne
réellement en vol.

## Leviers de secours si besoin

- `npm run prep:light` : cellules 128px au lieu de 256 (VRAM 1,65 Go → 413 Mo,
  résolution 6,3 → 3,2 texels/m) — à garder en réserve pour une machine plus
  faible. `--cell` accepte n'importe quelle valeur : les planches restent
  plafonnées à 4096² et le nombre de planches par chunk s'ajuste tout seul.
- Paramètres d'URL de debug (voir `src/main.js`, `OPTS`) :
  `?mipmaps=0` (coupe la génération de mipmaps), `?chunks=N` (charge N
  chunks au lieu de 5), `?aniso=0`, `?collision=0`.
- `window.__sim` dans la console navigateur : `.debug()`, `.teleport(x,y,z)`,
  `.lookAt(x,y,z)`, `.timeline`, `.physics`, `.controller`, `.input`, `.audio`,
  `.setWeather({speed, direction, gust, turbulence})`,
  `.setRain({intensity, variability})` (0..1 chacun ; intensité 1 = 25 mm/h).

