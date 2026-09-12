# Pipeline d'ajout de cartes — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> Couvre la GUI d'ajout, le pré-traitement d'origine, le passage au multi-cartes et le support HEIC. Voir aussi `docs/manual.md`.
> Pour retrouver une section : `grep -n "^#" map-pipeline.md`.

## GUI d'ajout de cartes (issue #26) — vérifié

`npm run dev` sert désormais `/add-map.html` : recherche de lieu, carte satellite,
rectangle, estimations, sonde de couverture, extraction avec logs en direct.

**Ce qui est vérifié :**

- Non-régression du CLI : `npm run add-map -- "Tour Eiffel" 48.8582 2.2970` produit
  exactement les mêmes phases et les mêmes tailles qu'avant la refonte (diff des
  logs de prep : identique), et `selftest` sur `tour-eiffel` passe ses 15 checks.
- Mode bbox du Go exporter : `--bbox s,w,n,e` extrait un rectangle asymétrique
  (mesuré : 41 x 17 tuiles = 1031 x 427 m). L'appel positionnel historique est
  inchangé, même dossier d'export, même comportement.
- `--plan` : JSON sur stdout en 0,8 s, zéro requête de tuile. Sur une zone hors
  couverture il rend `columns: 0` — un verdict « pas de données ici » gratuit.
- Sonde de couverture : 735 ms, verdicts corrects sur Tour Eiffel (couvert),
  Brest et plein Atlantique (non couvert), Antarctique (aucune région).
- Extraction complète depuis le navigateur : 143 colonnes → 192 tuiles → 17 Mo,
  SSE de bout en bout, scène jouable dans le simu.
- `npm run build` ne contient ni la page, ni l'API, ni Leaflet.

**Les estimations sont mesurées, pas devinées.** `tools/lib/estimates.json` tient
les constantes relevées sur les 7 cartes existantes plus un export neuf de contrôle
(304 colonnes, 6080 sondes, 497 tuiles, 85 Mo, 7 s ; prep 1,8 s). Les huit
échantillons tombent tous dans les fourchettes rendues par `estimateCost()`. Pour
recalibrer après avoir ajouté des cartes, refaire le relevé `du -sb` par dossier
brut et par scène et mettre à jour le fichier — les valeurs y sont commentées avec
leur provenance.

**Ce qui est volontairement grossier :** entre un lotissement et Manhattan, le même
nombre de colonnes rend du simple au quadruple de données (191 vs 795 ko/colonne
mesurés). L'interface affiche donc une fourchette et un ordre de grandeur de durée,
jamais un chiffre unique. Ne pas « améliorer » ça en affichant une valeur précise :
elle serait fausse.

**Non vérifié :** l'extraction d'une grosse zone (> 5000 colonnes) depuis la GUI —
seuls des exports de quelques centaines de colonnes ont été menés au bout par
l'interface. Le chemin est le même, mais la barre de progression s'appuie sur
l'estimation du nombre de tuiles, donc son échelle n'a pas été éprouvée en grand.
L'annulation en cours de téléchargement n'a été testée que par l'API, pas par le
bouton.

**Reporté en issues de suivi :** polygone libre, multi-zones, import GeoJSON/KML/GPX,
prévisualisation 3D avant extraction.

## Ce qui a été construit

Le problème n'était pas le drone, c'était que la tuile source (512 Mo d'OBJ
ASCII en ECEF + 4732 JPEG 512×512, soit 4732 draw calls et ~4,9 Go de VRAM)
n'est chargeable par aucun moteur telle quelle. `tools/prep.mjs` la
pré-traite une fois en ~10s :

| | source | après `prep` |
|---|---|---|
| Géométrie | 512 Mo ASCII, ECEF | 127 Mo binaire, **ENU en mètres** |
| Textures | 4732 fichiers 512² | 19 planches 4096², cellules 256² (83 Mo) |
| Draw calls | 4732 | **5** |
| VRAM textures | ~4,9 Go | ~1,65 Go |
| Résolution | 12,6 texels/m | 6,3 texels/m (16 cm/texel) |

Architecture (voir aussi `docs/manual.md`, plus détaillé sur le repère de coordonnées
et le format binaire) :

```
tools/add-map.mjs       téléchargement (Go) + prep + enregistrement, une commande par carte
tools/prep.mjs          OBJ+MTL+JPEG -> binaires (hors ligne, ~10s, par carte)
tools/selftest.mjs      vérifications géodésie / vol / collision, sans navigateur
src/loader.js            fetch + pool de workers -> BufferGeometry & DataArrayTexture, setScene(slug)
src/worker.js            parse le binaire, découpe la planche en layers, progress bytes
src/TileMaterial.js      shader GLSL3 sampler2DArray + brouillard
src/fog.js               modèle de visibilité : densité, respiration, voile, couleur de l'air
src/physics.js           monde Rapier (WASM), trimesh statique 3,7M tris, corps du drone
src/flightController.js  rates acro -> couple, interface étroite (substituable par SITL)
src/input.js             Gamepad + clavier/souris, sélection par mouvement, mapping EdgeTX
src/hud.js                overlay, menu de sélection de carte, écran de chargement avec horloge
src/main.js               boucle, choix de carte -> boot par étapes, window.__sim (hooks de debug)
```

## Système multi-cartes (ajouté 2026-08-26, session suivante)

L'utilisateur voulait pouvoir télécharger de nouvelles cartes lui-même et les
choisir dans un menu plutôt qu'être limité à la tuile Tour Eiffel codée en dur.

- `public/scene/` (singulier, une seule carte possible) devient
  `public/scenes/<slug>/` (une par carte) + `public/scenes.json` (manifeste :
  slug, nom, lat, lon). `loader.js` ne fetch plus un chemin fixe : `setScene(slug)`
  doit être appelé avant `loadManifest()`.
- `tools/add-map.mjs` enchaîne `go run cmd/export-obj` (dans
  `../flyover-reverse-engineering`) → `prep.mjs` → mise à jour de
  `scenes.json`, en une commande (`npm run add-map -- "Nom" lat lon`).
- `main.js` fetch `scenes.json` et affiche le menu (`hud.showMenu`) avant tout
  chargement lourd ; `?scene=<slug>` dans l'URL le saute.
- Deuxième carte ajoutée en conditions réelles pour valider le pipeline :
  Île de la Cité + Île Saint-Louis (48.8534, 2.3510 ; `--radius 35` car zone
  allongée, ~1,7 km ; 602 Mo préparés). Chargée avec succès via le menu,
  vérifiée par capture MCP chrome-devtools (quais, arbres, bâtiments,
  0 erreur console).
- **Dette connue** : `tools/selftest.mjs` a 3 checks sur 15 codés en dur pour
  la Tour Eiffel (dimension de tuile, position d'origine, hauteur de la tour) —
  échouent par construction sur toute autre carte. Les 12 autres (vol, sol,
  collision/CCD, UV) sont génériques et ont été revérifiés sur la carte des
  îles. Pas généralisé faute de demande explicite ; à faire si `selftest`
  doit devenir un vrai gate multi-cartes.
- Doc utilisateur complète (comment ajouter une carte, dimensionner
  `--radius`, options d'`add-map.mjs`) dans `docs/manual.md`.

Décisions actées (voir le plan pour le raisonnement complet) : navigateur
three.js plutôt que moteur natif, physique Rapier plutôt qu'intégrateur maison,
collision en pleine résolution (3,7M tris, pas de décimation), contrôleur de
vol maison avec interface étroite pour rester substituable par un pont
Betaflight SITL plus tard.

## Couverture Flyover : les régions récentes servent du HEIC (ajouté 2026-08-27)

`npm run add-map` sur la cathédrale de Reims échouait, et le diagnostic
naturel — « Apple Flyover ne couvre pas Reims » — était **faux** : Flyover
fonctionne sur place depuis un iPhone. Trois couches d'erreur se masquaient
l'une l'autre.

1. **Le parseur C3M lisait le mauvais octet de version.** `pkg/fly/c3m`
   faisait son `switch` sur `data[4]`, alors que l'octet de version est
   `data[3]` — celui-là même que `parseC3Mv3` vérifie deux lignes plus bas.
   `data[4]` est un octet de drapeaux qui vaut *aussi* 0x03 sur les régions
   anciennes contre lesquelles l'amont a été écrit, d'où l'illusion que ça
   marchait. Les régions récentes y mettent 0x07 : toutes leurs tuiles étaient
   classées « C3M v1, parseur non implémenté ».

2. **Les textures ont changé de format.** Une fois l'en-tête lu correctement,
   les matériaux annoncent `textureFormat 13` = HEIC (HEVC dans un conteneur
   HEIF) au lieu de 0 = JPEG. L'enregistrement du matériau est identique par
   ailleurs : 16 octets, seul l'octet de format change. Le partage se fait sur
   l'âge de la capture, pas sur la géographie : les villes historiques nommées
   (`'paris'`, région 48) restent en JPEG, les triggers de grille
   auto-générés (`Reg_z9_261_175` pour Reims, région 8522415) sont en HEIC.

   Rien en aval ne décode du HEVC — le `sharp` embarqué a un libheif AV1
   seulement (il lit les métadonnées, `512x512`, puis échoue au décodage), et
   Go n'a pas de décodeur utilisable. L'export transcode donc en JPEG en
   sortant vers un binaire système (`heif-convert`, `magick` ou `ffmpeg`,
   premier trouvé), ~15 ms par tuile, ce qui disparaît dans le parallélisme
   16 voies de l'exporteur. Le contrat sur disque reste OBJ + MTL + JPEG et
   `prep.mjs` n'a pas bougé.

3. **L'échec était silencieux.** `cmd/export-obj` traitait *toute* erreur de
   `getTile` comme « pas de tuile ici », donc 52 000 échecs de décodage
   ressemblaient exactement à 52 000 absences de couverture : `0 exported`.
   Un corps vide vaut maintenant `errNoTile` (vrai « rien ici ») ; un corps
   qui commence par la magie `C3M` et échoue quand même est un trou dans
   *notre* parseur et est signalé, avec un compte en fin de scan.

Vérifié : Reims renvoie des tuiles à tous les zooms, textures conformes
(maçonnerie gothique, contreforts, statuaire), carte complète construite et
jouable. Corollaire à garder en tête : **`0 exported` ne prouve plus rien à
lui seul** — sans le message « tuile reçue mais non décodée », alors seulement
l'absence de couverture est réelle.

Chemin de diagnostic, si un cas semblable revient : comparer les octets bruts
d'une tuile de la zone qui échoue avec ceux d'une tuile de Paris. C'est ce qui
a rendu les trois bugs évidents en quelques minutes — `43 33 4d 03 **03** 03`
contre `43 33 4d 03 **07** 03` — après une demi-heure passée à tirer la mauvaise
conclusion depuis la seule sortie `0 exported`.

