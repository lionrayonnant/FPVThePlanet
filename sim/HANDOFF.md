# Handoff — POC simulateur de drone FPV (Paris / Tour Eiffel)

État au 2026-08-26. Écrit pour reprendre le travail sans redériver le contexte.

## Statut : ça vole

Le POC fonctionne de bout en bout, vérifié à la fois en headless (SwiftShader)
et sur le vrai GPU de l'utilisateur (AMD RX 9060 XT) via MCP chrome-devtools,
manette EdgeTX réelle branchée et détectée.

Les textures étaient fausses (motifs retournés, larges plaques grises) : c'était
un seul bug, l'axe V des UV, corrigé — voir le n°9. **La « limite connue » sur
les façades grises que décrivait une version précédente de ce document n'existe
pas** ; c'était ce bug.

## Comment reprendre

```bash
cd sim
npm install          # si node_modules absent
npm run dev           # http://localhost:5173 — menu de sélection de carte
npm run selftest      # 15 vérifications sans navigateur (scène tour-eiffel par défaut)
```

Deux cartes prêtes à l'emploi dans `public/scenes/` (gitignored, ~900 Mo à
deux) : `tour-eiffel` et `ile-de-la-cite-et-ile-saint-louis`. Pour en ajouter
une autre : `npm run add-map -- "Nom" <lat> <lon>` — voir `README.md` section
« Ajouter une carte » pour le détail des options et le dimensionnement de
`--radius`.

Plan d'origine (contexte de la décision d'architecture) :
`/home/user/.claude/plans/j-ai-une-carte-de-flickering-cat.md`

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

Architecture (voir aussi `README.md`, plus détaillé sur le repère de coordonnées
et le format binaire) :

```
tools/add-map.mjs       téléchargement (Go) + prep + enregistrement, une commande par carte
tools/prep.mjs          OBJ+MTL+JPEG -> binaires (hors ligne, ~10s, par carte)
tools/selftest.mjs      vérifications géodésie / vol / collision, sans navigateur
src/loader.js            fetch + pool de workers -> BufferGeometry & DataArrayTexture, setScene(slug)
src/worker.js            parse le binaire, découpe la planche en layers, progress bytes
src/TileMaterial.js      shader GLSL3 sampler2DArray + brouillard
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
  `--radius`, options d'`add-map.mjs`) dans `README.md`.

Décisions actées (voir le plan pour le raisonnement complet) : navigateur
three.js plutôt que moteur natif, physique Rapier plutôt qu'intégrateur maison,
collision en pleine résolution (3,7M tris, pas de décimation), contrôleur de
vol maison avec interface étroite pour rester substituable par un pont
Betaflight SITL plus tard.

## Modèle de vol réaliste (ajouté 2026-08-26, session suivante)

Le POC volait, mais avec un modèle « poussée + couple sur une sphère » : une
sphère isotrope de 0,15 m d'inertie 0,0054 sur les trois axes, une poussée
instantanée linéaire en gaz, une traînée quadratique isotrope, et une boucle de
taux purement proportionnelle. Ça vole ; ça ne ressemble pas à un quad.

Remplacé par un modèle physique d'un 5 pouces ordinaire (2207/2450KV sur 4S,
hélices 5x4.3x3), découpé en deux fichiers qui ne se connaissent pas :

- **`src/quad.js`** — la cellule et l'air. Quatre moteurs individuels avec
  retard du premier ordre (22 ms en montée, 45 ms en descente : seule la
  traînée ralentit une hélice, c'est pour ça qu'un rattrapage inversé est
  difficile) ; poussée ∝ ω², couple de traînée d'hélice → le lacet vient de la
  réaction, pas d'un coefficient ; couple de roulis/tangage calculé par
  `Σ r × F` à partir de la position des moteurs ; perte de poussée avec le flux
  axial, traînée de rotor (H-force, ∝ régime — c'est ce qui fait qu'on ne
  décélère plus quand on coupe les gaz à vitesse) ; traînée de corps
  anisotrope ; effet de sol ; propwash en descente verticale ; batterie 4S 1300
  avec sag sous charge et décharge.
- **`src/flightController.js`** — Betaflight et rien d'autre. Actual rates
  (centre / max / expo indépendants), trois presets (cinéma / freestyle /
  race, touche `P`), PID complet avec I-term relax façon Betaflight, D sur la
  mesure filtrée, TPA, feedforward, lissage RC, mixeur airmode avec mise à
  l'échelle du mix et glissement des gaz.

Le contrat a changé : `update(sticks, state, dt) -> {motors[4], throttle, axes}`
au lieu de `-> {thrust, torque}`. Ce n'est **pas** un élargissement de
l'interface : un vrai pont Betaflight SITL renvoie quatre sorties moteur, donc
on s'en est rapproché.

### Ce qui a été mesuré plutôt que choisi

`tools/tune-pid.mjs` (`npm run tune`) intègre les équations d'Euler avec le vrai
tenseur d'inertie et le vrai retard moteur, sans Rapier ni navigateur, et
mesure temps de montée / dépassement / stabilisation / rebond. Il a trouvé
trois erreurs que personne n'aurait vues en vol :

1. **Le feedforward était 7× trop fort.** Il a une valeur correcte, pas une
   valeur « à goûter » : c'est le mix qui produit exactement l'accélération
   angulaire demandée, `I * d(taux)/dt`. Dérivé, pas réglé.
2. **Ki était réglé indépendamment de Kp** et saturait sa limite en 50 ms, ce
   qui ajoutait un biais constant → 56 % de dépassement. Ki est maintenant lié
   à Kp par une constante de temps intégrale (0,35 s), donc l'intégrale reste
   ce pour quoi elle existe : un bras tordu, une sangle lourde, un vent
   traversier.
3. **L'i-term relax était sur la pente de consigne**, donc actif seulement à
   l'instant où le manche bouge. Betaflight le fait sur un passe-haut de la
   consigne, qui reste non nul pendant toute la figure. Corrigé.

Le banc a aussi eu un bug à lui : il partait manche à fond à t=0, ce qui amorce
les filtres de lissage RC sur cette valeur dès le premier échantillon — donc
aucun lissage, donc aucun feedforward, donc il mesurait un contrôleur que
personne ne pilote. Le manche part maintenant au centre.

Résultat après réglage (freestyle, 820 °/s) : montée 58 ms, dépassement 0,9 %,
stabilisation 66 ms, rebond 0,6 %. Les seuils de réussite du banc sont eux-mêmes
dérivés de l'accélération angulaire *soutenue* mesurée sur `quad.js`, pas de
constantes : sinon le preset race échouerait pour avoir demandé plus de travail,
et le lacet échouerait toujours (un huitième du couple du roulis contre deux
fois son inertie — c'est la cellule, pas le réglage).

### Vérifications

- `npm run tune` : 9 combinaisons axe/preset dans les cibles, réjection de
  perturbation 68 ms (roulis) / 104 ms (lacet), airmode identique de 0 à 100 %
  de gaz.
- `npm run selftest` : 22/22 sur la scène Tour Eiffel, dont six nouveaux
  contrôles de propulsion (position du manche en vol stationnaire 24 %,
  autorité airmode à gaz coupés, lacet plus lent que le tangage, vitesse
  terminale à plat, sag et décharge de la batterie).
- Rejeu de la boucle `frame()` de `main.js` sur la vraie scène (2000 pas) :
  aucun champ HUD indéfini ou non fini ; montée 0→56 m en 3 s à 46 A, stationnaire
  à 8 A, punch-out à 70 A avec le pack à 15,97 V, propwash à 1,00 en chute
  verticale, crash détecté à l'arrivée au sol.
- **Non vérifié dans le navigateur** : le profil Chrome de l'utilisateur était
  occupé, donc le MCP chrome-devtools n'a pas pu s'attacher. `vite build` passe
  et toutes les références d'éléments du HUD résolvent statiquement, mais
  personne n'a encore *vu* la page. À faire au prochain lancement.

### Ressenti : ce qui devrait être différent en vol

Poussée/poids passée de 4,0 à 5,5 (avec le sag), stationnaire à 24 % de gaz au
lieu de 25 % d'une courbe linéaire fausse, inertie de roulis divisée par 1,8 →
beaucoup plus vif, lacet ~2× plus lent que le roulis au lieu d'identique,
décélération qui dépend du régime, batterie qui s'épuise en ~2,5 min de vol
soutenu, et propwash qui secoue en descente verticale.

## Son : synthèse depuis les quatre moteurs (ajouté 2026-08-26)

`src/audio.js` synthétise tout le son du sim en Web Audio à partir de
`physics.propulsion` — aucun fichier audio n'est chargé.

Le principe qui compte : **un jeu d'oscillateurs par moteur**, pas un pour
l'ensemble. Les quatre régimes divergent dès qu'on touche un manche, et le
battement entre eux est précisément ce qui fait qu'un quad sonne comme un quad.
Chacun chante sa fréquence de passage de pale (`omega/2π × QUAD.bladeCount`,
constante ajoutée dans `quad.js`) plus ses 2e et 3e harmoniques, et du bruit
passe-bande centré sur cette même fréquence.

- Le **niveau suit la poussée** (`propulsion.thrust[i]`), pas la commande
  moteur : un moteur déchargé en piqué est plus discret que la même commande en
  montée, ce qui est la moitié de la raison pour laquelle un punch-out s'entend.
- **Panoramique** ±0,5 selon le signe de `MOTORS[i].x`.
- **Souffle** : bruit passe-bande dont le centre et le niveau suivent
  `physics.airspeed` — la vitesse *air*, nouvellement exposée par `physics.js`,
  parce qu'avec du vent arrière un quad rapide est presque silencieux.
- **Propwash** : le même bruit, passe-bas, piloté par `propulsion.propwash`.
- **Impacts** : one-shots déclenchés par la force de contact que `physics.step()`
  renvoyait déjà et que `main.js` jetait ; loi logarithmique sur le niveau,
  un impact au plus toutes les 80 ms.

Contraintes de mise en œuvre, toutes vérifiées :

- Le graphe est construit une seule fois dans `start()`. `update()` ne bouge que
  des `AudioParam` via `setTargetAtTime` — aucune allocation par image. Les
  seuls nœuds créés après coup sont les trois d'un impact, qui se déconnectent
  dans `onended`.
- `update()` est appelé une fois par image, pas à 250 Hz.
- L'`AudioContext` naît au clic du menu (le geste utilisateur exigé par la
  politique d'autoplay), avec un filet sur le clic du canvas pour le chemin
  `?scene=<slug>` qui saute le menu.
- Silence en caméra libre : la physique n'y avance pas, donc les régimes gèlent
  et une note tenue serait pire que rien.

### Vérifications navigateur (chrome-devtools MCP, scène Tour Eiffel)

- `AudioContext` en `running` après le clic du menu, 48 kHz.
- Fréquences fondamentales : **528 Hz à 20 % de gaz**, **1419 Hz à fond**
  (cohérent avec le sag du pack), harmoniques exactement à 2f. Les quatre sont
  identiques en ligne droite et **divergent** (921–956 Hz) manche de roulis à
  fond — c'est le point de tout l'exercice.
- Panoramiques à `[+0.5, +0.5, -0.5, -0.5]`, conformes à l'ordre Betaflight.
- **Zéro nœud alloué sur 3 s de vol stationnaire** ; une chute de 12 m produit
  3 one-shots d'impact, la limite anti-spam tient.
- Souffle : gain 0,0003 au stationnaire, 0,145 à 586 Hz en piqué à 13,6 m/s ;
  propwash au maximum gaz coupés en descente.
- `C` coupe le son (gain maître → 0) et le rétablit au retour en FPV.
- Volume : curseur dans le panneau `Tab`, persisté dans `localStorage`
  (`fpvmaps.audioVolume`) et bien relu après rechargement. Aucune erreur console.

### Correction de la fatigue auditive (session suivante)

L'utilisateur a volé et a confirmé que ça marche, mais que **c'était désagréable
sur la durée d'une session**. Mesuré au lieu d'être deviné, avec un
`AnalyserNode` branché sur le bus master et une répartition de l'énergie par
bande :

| état | 2–4 kHz | 4–8 kHz | >8 kHz |
|---|---|---|---|
| avant, en virage | **43 %** | 14 % | 6 % |
| avant, plein gaz | 21 % | 12 % | 7 % |
| après, en virage | **11,6 %** | 0,1 % | 0 % |
| après, plein gaz | 14,2 % | 2,5 % | 0,1 % |

2–4 kHz est le sommet de la courbe d'isosonie : c'est là que l'oreille est la
plus sensible, et donc là que se fabrique la fatigue. Deux causes, toutes deux
dans le code et pas dans le réglage :

1. **La fondamentale était une `sawtooth`.** Une dent de scie porte déjà toute
   la série harmonique en 1/n jusqu'à Nyquist — et on ajoutait 2f et 3f
   explicitement par-dessus. Série doublée, énergie de 3 à 20 kHz, rien pour la
   borner. Les trois oscillateurs sont maintenant des sinus : ce qui est écrit
   dans `harmonics` est ce qui sort.
2. **Les quatre moteurs tombaient sur exactement la même fréquence** à commande
   égale (1419,0 Hz pour les quatre à plein gaz), donc quatre oscillateurs
   cohérents s'additionnant en une seule sinusoïde forte — la signature même du
   son de synthé. Des vrais moteurs ne s'accordent jamais mieux qu'à une
   fraction de pour cent près. Un désaccord fixe par moteur (`detune`, en cents)
   plus une lente dérive (un LFO par moteur, à des taux volontairement sans
   rapport) rend le chœur : le battement recherché est entre fréquences
   *presque* identiques, pas identiques.

S'y ajoutent un passe-bas par moteur (2600 Hz) qui borne l'énergie dans la bande
dure quel que soit le régime, un passe-bas général (6000 Hz) — rien n'atteint un
pilote avec son octave supérieure intacte — et un **limiteur** au-dessus de
tout : le pire cas mesuré (plein gaz + souffle + impact) atteignait 0,83 à
volume 1, soit 1,6 dB de marge, que quatre oscillateurs désaccordés finissent
par manger en s'alignant en phase. Le limiteur ne réduit rien au stationnaire
(0 dB), −0,27 dB en virage, −1,33 dB à plein gaz.

Enfin, un curseur **Timbre** dans le panneau `Tab` (persisté), parce que « trop
sombre » contre « trop agressif » dépend du casque et de l'oreille et qu'aucune
mesure ici ne peut le trancher. Il multiplie les deux coupures, de ×0,5 à ×2,0,
centré *géométriquement* sur 1,0 pour que le milieu du curseur soit exactement
le réglage auquel les spectres ci-dessus ont été mesurés.

**Non vérifié** : le rendu à l'oreille. Aucun agent ne peut écouter ; la
structure, les fréquences et l'absence de fuite sont garanties, le jugement
« est-ce que ça sonne comme un quad » reste à l'utilisateur. Les niveaux
relatifs (harmoniques, bruit moteur, souffle) sont des points de départ
raisonnables, pas des valeurs mesurées — c'est le seul endroit du projet où
« choisi plutôt que mesuré » est assumé, faute de référence audio.

**Verdict de vol sur la correction (2026-08-27)** : « pas mal, mais un peu
étouffé ». Donc le sens de la correction était bon et son amplitude est allée
un cran trop loin. C'est cohérent avec les mesures : au stationnaire il ne reste
plus *rien* au-dessus de 2 kHz (le fondamental est à ~530 Hz et la 3e
harmonique à ~1590 Hz passe encore, mais le bruit moteur est coupé net), et
c'est là qu'on perd la présence. À reprendre à tête reposée, dans l'ordre de ce
qui est le plus probablement en cause :

1. Remonter `motorTone` (2600 Hz), qui est la coupure la plus agressive des
   deux ; 3200–3600 Hz rendrait de la présence sans revenir dans 4–8 kHz.
2. Puis `airCut` (6000 Hz), plus haut, qui ne sert que de filet.
3. En dernier recours seulement, remonter `harmonics[2]` (0,14) — c'est le
   levier qui rouvre le plus vite le problème de fatigue.

Le curseur **Timbre** permet de chercher le point avant de figer une constante :
s'il faut le mettre franchement au-dessus de « neutre » pour que ce soit bien,
c'est la constante qu'il faut bouger, pas le curseur. Ne pas revenir à la
`sawtooth` ni supprimer le désaccord entre moteurs : ce sont eux qui causaient
la fatigue, pas le manque de brillance. Suivi dans #11.

Deux pièges rencontrés et corrigés au passage. `Number(localStorage.getItem(k))`
vaut `0` quand la clé est absente, ce qui transformait silencieusement un
premier lancement en sim muet ; la lecture teste maintenant `null` d'abord. Et
le milieu d'un curseur à échelle logarithmique n'est le neutre que si la plage
est centrée géométriquement : `[0,5 ; 2,4]` mettait « neutre » à ×1,095, donc
6573 Hz au lieu des 6000 Hz mesurés.

## Rendu FPV : l'optique de l'objectif (ajouté 2026-08-27)

`src/lens.js`, une seule passe plein écran entre la scène et l'écran. Barillet,
aberration chromatique latérale, mollesse des bords, vignettage et flou de
mouvement, tous ensemble. Ferme #10, moins la partie « dégradation du lien
vidéo », partie depuis dans #12 et faite (section plus bas).

Une passe et pas quatre : les quatre effets d'objectif ont la même cause
physique et s'expriment tous comme une fonction du rayon depuis le centre de
l'image. C'est **une** décision d'échantillonnage, pas quatre. Une chaîne de
quatre `ShaderPass` paierait quatre allers-retours plein écran pour les mêmes
pixels.

### Le flou de mouvement n'a pas besoin de la profondeur

C'est le point qui rendait l'issue plus facile qu'elle n'en avait l'air. Le
monde est statique et la caméra est le seul objet qui bouge, donc le flou de
rotation — le seul qui compte à 800 °/s — se reconstruit **exactement** en
reprojetant les rayons de vue à travers la rotation faite pendant la pose. Aucun
tampon de profondeur, donc la contrainte `camera.near = 0,15` ne s'applique
même pas. Ce que l'approximation laisse tomber, c'est la parallaxe de
translation.

La rotation est prise sur la pose de la caméra (`q_prev⁻¹ · q_cur`, slerpée vers
l'identité par `obturation/dt`) et non sur `physics.angularVelocity` : ça marche
aussi en caméra libre, où le pas de physique est sauté. Vérifié : pas de NaN
dans `uReproj` après un passage en `C`.

### Le barillet ne demande aucun survol de champ

Le plan prévoyait d'élargir `camera.fov` pour éviter des coins noirs. Inutile :
il suffit de **normaliser le barillet au coin**, `q · (1 + k1r² + k2r⁴) / (1 + k1
+ k2)`. Le coin échantillonne alors exactement le coin rendu, tout le champ
survit à la déformation, et rien ne sort de l'image. Ce que la distorsion coûte
réellement, ce n'est pas du champ, c'est un grossissement du centre — ×1,26 au
réglage par défaut. `camera.fov` n'est pas touché, donc le curseur FOV garde son
sens et la culling reste juste.

### Ce qui a été mesuré plutôt que choisi

Fenêtre 2560×1265, RX 9060 XT, scène Tour Eiffel, `readPixels` synchrone comme
pour les mesures précédentes :

| | ms/frame |
|---|---|
| sans la passe (référence) | 1,17 |
| passe complète, 16 taps | 2,31 |
| passe à 1 tap (objectif à 0, obturation à 0) | 1,84 |

La passe coûte **1,14 ms** sur un budget de 10 ms. Deux choses que la mesure
contredit :

- **Couper le flou de mouvement ne récupère presque rien.** Les 15 taps
  supplémentaires coûtent 0,47 ms ; le reste (0,67 ms) est la passe elle-même
  plus la résolution MSAA, et se paie que le flou soit actif ou non. L'issue le
  désignait comme « le premier candidat à couper si les images chutent » —
  c'est le mauvais levier, le vrai serait de couper la passe entière.
- **8 taps ne suffisaient pas.** Un roulis à 800 °/s étale le coin sur ~160 px ;
  8 échantillons là-dedans laissent 20 px de trou et donnent des stries, pas du
  flou (capture faite, c'était net). 16 taps plus un dither par pixel
  transforment le reste en grain — ce qui, sur un retour vidéo, est la bonne
  erreur à faire.

`k1 = 0,30`, `k2 = 0,10`, aberration 0,006, mollesse 0,0035 uv et vignettage
0,55 à pleine échelle sont **choisis à l'œil**, pas mesurés sur une vraie
optique. Les valeurs par défaut (objectif 60 %, vignettage 50 %, obturation
8 ms = 1/125 s) le sont aussi.

### Vérifications navigateur (chrome-devtools MCP, scène Tour Eiffel)

- **Couleur.** Un pixel de ciel ressort à `#9fb8cc` exactement avec la passe en
  mode neutre, comme sans la passe. C'était la régression à ne pas rouvrir : la
  cible de rendu est en `UnsignedByteType` + `LinearSRGBColorSpace` et il n'y a
  **pas** d'`OutputPass` — voir bug #10 plus bas.
- **Antialiasing.** La cible est construite avec `samples: 4`. Rendre hors écran
  contourne le `antialias: true` du renderer, et les arêtes de toit crénelées
  qui en résultent se lisent comme un bug de shader alors que c'est une cible
  mal déclarée.
- **Barillet.** Capture avant/après sur l'horizon et le fût de la Tour : la
  ligne se courbe, les coins restent remplis, le contenu des coins est le même.
- **Flou.** Roulis de 800 °/s tenu sur deux frames : traînée en arc autour de
  l'axe de roulis, centre lisible, bords étalés.
- **Panneau `Tab`.** Case maîtresse coupe la passe et grise les trois curseurs ;
  les quatre réglages reviennent après rechargement.
- `__sim.debug()` : 6 draw calls (5 scène + 1 quad), 3 742 192 triangles.

### Dette connue

- `renderer.info.autoReset` est passé à `false` et `lens.render()` fait le reset
  une fois par frame. Sans ça, `info` ne décrivait plus que le quad plein écran
  (1 draw call, 1 triangle) parce qu'il se remet à zéro à chaque appel de
  `render()` et qu'il y en a deux maintenant. Tout code futur qui appelle
  `renderer.render()` hors de `lens.render()` faussera les compteurs.
- Le flou ignore la translation. À 25 m/s le long d'une façade proche, la
  parallaxe devrait baver et ne bave pas. **Non vérifié** que ça se voie en vol.
- Les coefficients d'objectif ne correspondent à aucune caméra réelle mesurée.
  Un vrai calibrage (mire, `k1`/`k2` ajustés sur une Runcam ou une DJI O3)
  serait l'étape suivante si le rendu paraît faux.

## Rendu du lien vidéo : RSSI par raycast (ajouté 2026-08-27)

Ferme #12, la moitié de #10 qui avait été mise de côté. Trois fichiers, une
direction de dépendance : `src/physics.js` mesure la géométrie, `src/link.js`
en fait des dB (aucune dépendance : ni Rapier, ni three, ni DOM — donc testable
dans `tools/selftest.mjs`), `src/lens.js` en fait une image. Arbitrage tranché
avec l'utilisateur : **les deux rendus**, analogique et numérique, au choix dans
`Tab`, et un curseur de sévérité réglé par défaut sur « rupture possible ».

### Un seul rayon ne suffisait pas, et deux non plus

Le plan disait « deux raycasts, un depuis chaque bout, l'écart est l'épaisseur
de matière ». C'est juste, et ça a quand même échoué à la première mesure : un
tir vers un point **sous le sol** rendait une épaisseur de **zéro**. Le maillage
de collision est une soupe de surfaces, pas un solide — le terrain est une
feuille unique, avec une face avant et aucune face arrière. Sa profondeur est
donc honnêtement nulle, alors même qu'il bloque tout.

D'où la forme finale : `obstructionBetween()` rend `{ blocked, span }` et pas un
seul nombre. Un immeuble a bien deux murs et rend sa vraie profondeur ; une
crête ou un toit fin rendent `blocked: true, span: 0`. Côté modèle, `blocked`
paie un terme fixe de **12 dB** — la diffraction par l'arête, qui est le vrai
mécanisme physique quand le signal contourne un obstacle sans épaisseur — et
`span` paie 8 dB/m par-dessus. Sans ce terme, voler derrière une colline
n'aurait rien coûté.

### Le gel d'image, et le piège du swapBuffers

En mode numérique, une trame sautée se fait en **ne rendant pas la scène** :
`renderPass.enabled = false`, et la passe d'objectif relit la dernière image
dans le `readBuffer` du composer. Une frame gelée coûte donc *moins* qu'une
frame normale (0,59 ms contre 1,42), ce qui est aussi vrai du vrai matériel.

Sauf que `RenderPass` écrit dans le `readBuffer` sans échanger, mais le
`ShaderPass` final a `needsSwap = true` et `EffectComposer.render()` échange
même après la dernière passe. Le `readBuffer` alterne donc d'une frame sur
l'autre, et un gel naïf rejoue l'**avant**-dernière image. Mesuré, pas déduit :

| | image tenue |
|---|---|
| `needsSwap = true` (trois.js par défaut) | l'avant-dernière |
| `needsSwap = false` (ce qu'on fait) | la dernière |

La passe finale rend à l'écran et personne ne consomme son `writeBuffer`, donc
la mettre à `false` est sans effet de bord. **Toute passe ajoutée après elle
casserait ça.**

### Le bruit analogique par ligne shredde l'image

Première version : un décalage horizontal aléatoire et indépendant par ligne.
Capture faite à qualité 0,5 — l'image était illisible, réduite en confettis,
alors que 0,5 doit être « bruité mais parfaitement volable ». La gigue de
synchro réelle est **corrélée** d'une ligne à l'autre : l'oscillateur ligne
dérive, il ne se retire pas aux dés à chaque ligne. La version qui marche est
une ondulation lente que toute l'image partage (±0,0022 uv) plus environ un
pixel de bruit réellement par ligne, les déchirures franches étant réservées à
`uLink < 0,5`.

### Ce qui a été mesuré

Fenêtre 2560×1265, RX 9060 XT, Tour Eiffel, `readPixels` synchrone, cinq
tournées entrelacées, médiane :

| | ms/frame | delta |
|---|---|---|
| sans la passe (référence) | 1,41 | — |
| passe, lien coupé (`LINK_MODE 0`) | 2,28 | +0,87 |
| passe + analogique, lien parfait | 2,40 | +0,99 |
| passe + analogique, q=0,50 | 2,35 | +0,95 |
| passe + numérique, lien parfait | 2,29 | +0,88 |
| passe + numérique, q=0,30 | 2,29 | +0,88 |
| passe + numérique, image gelée | 0,60 | −0,80 |

Le lien coûte donc **au plus 0,12 ms**, entièrement dus aux quatre taps de
chrominance de l'aspect analogique de base ; le numérique est gratuit. Les
raycasts : 0,0018 ms en vue dégagée, 0,016 ms au pire à travers 125 m de ville
— six fois un `groundBelow()`, que la boucle de rendu payait déjà chaque frame.
**Aucune cadence réduite n'était nécessaire** ; le `_aglEvery` prévu dans le
plan n'existe pas.

### Vérifications navigateur

- **Couleur.** Un pixel de ciel ressort à `#9fb8cc` *exactement* sans la passe,
  avec la passe et lien coupé, à sévérité 0, et en **numérique** à qualité 1.
  C'est la régression de #10 à ne pas rouvrir. L'**analogique** à qualité 1 rend
  `#95acbe` — délibérément, c'est l'image lavée — et à sévérité 0,5 rend
  `#9cb4c7`, exactement le milieu, donc le curseur est bien linéaire.
- **Gel.** Tient la dernière image, la tient encore sur une deuxième frame
  gelée, reprend en direct ensuite. Test fait obturation fermée : avec le flou
  de mouvement, une même pose ne rend pas deux fois le même pixel et la
  comparaison ne veut rien dire.
- **Comportement.** 149 m au-dessus du pilote : 100 %. Coin de la tuile à 884 m
  en vue directe : 62 %. Un immeuble : ~50 %. 300 m au niveau de la rue avec
  125 m de ville en travers : 0 %.
- **Panneau `Tab`.** Section « Lien vidéo » ; le sélecteur bascule bien le
  `#define`, le curseur à 0 compile l'effet hors du shader, la case maîtresse
  « Rendu FPV » grise les deux, et les deux clés survivent au rechargement. Le
  balayage `fpvmaps.` du bouton de réinitialisation les couvre déjà.
- Aucun message d'erreur ni d'avertissement en console.

## Lien vidéo : la première calibration était injouable (corrigé 2026-08-27)

Le premier jet passait les tests et rendait le sim désagréable. Retour de
l'utilisateur, avec des captures de vrais retours analogique et numérique à
l'appui : « trop fort et injouable » par défaut, et « on a rien et d'un coup
pouf c'est brouillé ». Les deux critiques portaient sur des choses différentes
et les deux étaient justes.

### L'analogique n'a pas seulement un mode dégradé, il a un aspect

C'est la moitié qui manquait, et aucun test ne pouvait l'attraper : le premier
jet partait d'une image *parfaite* et y ajoutait du bruit quand le lien
faiblissait. Un vrai retour composite est mou, lavé et bavé en couleur **dès la
première trame** — la bande passante de chrominance vaut une fraction de celle
de luminance, donc la couleur déborde latéralement pendant que les contours
restent nets. Sans cette base, le mode analogique à plein signal était
littéralement identique au mode numérique, ce qui vide de son sens le choix
entre les deux.

Quatre taps horizontaux, hors de la boucle principale : c'est une propriété du
signal, pas de l'objectif, donc ça n'a rien à faire sur le motif
d'échantillonnage de l'objectif. Piège rencontré : quatre taps régulièrement
espacés sur 25 px forment un **peigne**, pas un flou, et sur une arête de
chrominance franche comme la Tour Eiffel contre le ciel ce peigne se lit comme
une image dédoublée. Corrigé avec le même `dither` par pixel que la boucle de
taps — exactement le remède déjà employé pour le banding du flou de mouvement.

### Le « pouf » venait du modèle, pas du shader

`8 dB/m` linéaire était la cause unique et suffisante : contourner un angle
fait passer l'épaisseur de 0 à 10+ m d'une frame à l'autre, soit **80 dB en une
marche**. Tout immeuble tuait le lien instantanément, quelle que soit sa
distance ou sa finesse. Trois changements, tous dans `link.js` :

| | avant | après |
|---|---|---|
| profondeur | 8 dB/m linéaire, plafond 60 | saturante, 38 dB d'asymptote sur 14 m |
| plage du fondu | 26 → 60 dB (34 de large) | 18 → 76 dB (58 de large) |
| constantes de temps | 0,05 s / 0,35 s | 0,30 s / 0,70 s |

La saturation fait payer l'essentiel par les premiers mètres, ce qui est aussi
plus juste : après un mur le signal est déjà dans le bruit, et le neuvième mur
ne peut plus enlever grand-chose que le deuxième n'ait déjà pris. Le fondu large
absorbe les marches que la géométrie fournit forcément. Et les constantes de
temps sont la seule chose qui sépare un fondu d'un interrupteur, puisque la
géométrie, elle, est binaire.

Résultat mesuré : contourner un angle prend **783 ms** avec un changement
maximal de **0,025 par frame** (contre trois frames avant), et la distance seule
donne une échelle continue 1,00 → 0,90 → 0,80 → 0,73 → 0,69 → 0,66 → 0,64.

Le fondu commence aussi **plus tôt** (18 dB, soit ~80 m) : il y a alors toujours
un peu de dégradation à lire, qui glisse pendant tout le vol, au lieu d'une
image parfaite jusqu'à la seconde où il n'y a plus rien. C'est ça qui rend le
lien lisible — on est prévenu qu'on manque de marge avant d'en manquer.

### Ce que les tests ne voyaient pas, et le voient maintenant

Les 11 vérifications d'origine passaient toutes sur la calibration injouable :
elles décrivaient les propriétés du modèle sans jamais décrire son **allure**.
Cinq ajouts, dont **trois échouent** sur l'ancienne calibration (vérifié en la
remettant en place, pas supposé) :

| vérification | ancienne | nouvelle |
|---|---|---|
| un immeuble dégrade sans tuer (0,25 < q < 0,75) | **0,00** | 0,49 |
| contourner un angle est un glissement (< 0,06 par frame) | **0,358** | 0,025 |
| la transition dure assez pour être lue (> 12 frames) | **2 frames** | 47 frames |
| effleurer une arête coûte moins que passer derrière | 0,88 vs 0,00 | 0,86 vs 0,49 |
| la qualité glisse continûment avec la distance | passe | passe |

Les deux dernières passaient déjà, et c'est cohérent : la falaise était
entièrement dans le terme d'occlusion, jamais dans celui de distance. Il faut
donc lire ce tableau comme disant que **trois** de ces tests auraient attrapé le
problème et que deux ne pouvaient pas.

Et le test « un immeuble coûte bien plus que la distance » a dû être **corrigé** :
son seuil (`< 0,05`) encodait précisément le comportement à supprimer. Un test
qui passe ne prouve pas que le seuil est le bon.

### Dette connue

- Les constantes du bilan de liaison (18 dB pour le début de la chute, 76 dB
  pour la rupture, 8 dB d'arête, 38 dB d'asymptote de profondeur sur 14 m) sont
  **calibrées à l'œil sur des captures**, pas mesurées sur un vrai lien : elles
  produisent le comportement voulu mais ne viennent d'aucune mesure. Idem pour
  la largeur de bave de chrominance (0,008 uv) et le contraste analogique.
- **Pas de diagramme d'antenne.** Un dipôle a un creux dans l'axe, donc voler
  juste au-dessus du pilote devrait coûter quelque chose et ne coûte rien ici.
  Suivi séparément.
- Le sol est un émetteur ponctuel sans multitrajet : pas de réflexions, pas de
  zone de Fresnel. Une arête franche donne une transition franche.
- La contrainte `needsSwap = false` de la passe finale est silencieuse : rien ne
  la vérifie au démarrage, et l'ajouter une passe après casserait le gel.

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

## Bugs trouvés et corrigés cette session

Par ordre de découverte — plusieurs ont nécessité de mesurer plutôt que
deviner, et deux diagnostics initiaux se sont révélés faux avant la bonne piste :

1. **URL des workers.** Les workers résolvaient les chemins relatifs contre
   `/src/` au lieu de la racine. Corrigé avec `import.meta.env.BASE_URL`.

2. **`world.step()` requis avant `castRay()`.** Rapier ne peuple sa query
   pipeline qu'après un premier pas de simulation ; sans ça tous les raycasts
   (sol, spawn) échouaient silencieusement. `Physics` fait maintenant un
   `world.step()` dans son constructeur avant tout raycast.

3. **Accumulation de force.** `body.addForce()` persiste tant qu'on n'appelle
   pas `resetForces()` — sans ça la poussée s'additionnait à chaque pas et le
   drone partait en accélération quadratique (234 m/s après 1s à gaz nul).
   `Physics.step()` appelle `resetForces()`/`resetTorques()` en tout début de
   pas.

4. **Z-fighting / ville en éclats.** `camera.near = 0.05` quantifiait le depth
   buffer à ~40 cm à l'autre bout de la tuile ; la photogrammétrie, pleine de
   surfaces quasi coplanaires, partait en fragments. **Fausse piste explorée
   d'abord** : le winding des faces (`side: DoubleSide`) — testé, aucun effet,
   annulé. Le vrai fix : `near = 0.15`, qui vaut aussi le rayon du collider du
   drone (rien ne peut être plus près de la caméra sans collision déjà
   survenue).

5. **Seuil de crash mal calibré + spawn trop haut.** Le spawn (chute de 1 m)
   déclenchait un crash à un seuil de 120 N choisi sans mesure. Mesuré les
   forces d'impact réelles (`_impacttest.mjs`, supprimé après usage) :
   atterrissage doux ~290 N, dur ~1600 N, impact tour à 25 m/s ~2450 N. Seuil
   réglé à 1500 N, hauteur de spawn réduite à 0,25 m dans `prep.mjs`.

6. **`compileAsync()` bloquait indéfiniment.** Cette API appelle `compile()`
   de façon synchrone (le travail réel est donc déjà fait), puis interroge le
   driver toutes les 10 ms via `KHR_parallel_shader_compile` et n'aboutit que
   si le driver signale `COMPLETION_STATUS_KHR`. Sur le driver de
   l'utilisateur ce drapeau n'est jamais levé → attente infinie, écran figé
   sur « compilation du shader ». Remplacé par `renderer.compile()`
   synchrone (2-3 ms).

7. **`#loading` restait affiché malgré `.hidden = true`.** Le vrai bug
   derrière « bloqué sur premier rendu / gpu-upload » signalé par
   l'utilisateur après le fix n°6 — **le jeu chargeait en fait correctement**
   (1,4-2,2s, timeline complète), mais l'overlay `#loading` a sa propre règle
   `display: grid` qui bat la règle `[hidden] { display: none }` de la
   feuille de style utilisateur en spécificité CSS. Deux fausses pistes
   explorées avant de trouver ça : GPU/driver (écarté par des mesures
   `compile()`/`readPixels` cohérentes), puis captures d'écran puppeteer
   supposées être un « artefact de compositeur figé » — c'était en fait le
   bug lui-même, contourné par mes lectures `canvas.toDataURL()` qui
   ignorent l'overlay DOM. Fix : règle globale
   `[hidden] { display: none !important; }` dans `style.css`, plus robuste
   que corriger au cas par cas (2 règles `[id][hidden]` ad hoc supprimées).

8. **Sélection de manette incorrecte.** Le clavier Keychron de l'utilisateur
   s'énumère comme un gamepad (6 axes, tous au repos) ; `getGamepad()`
   prenait le premier périphérique trouvé, donnant 50% de gaz en continu
   (axes centrés → milieu de plage). Corrigé : le périphérique actif est
   maintenant celui dont un axe s'écarte de sa position de référence capturée
   à la connexion (seuil 0,2). Ajouté aussi une disposition par défaut
   spécifique EdgeTX/Radiomaster/TX16S/FrSky/Jumper (roll=axe0, pitch=axe1,
   throttle=axe2, yaw=axe3) détectée par regex sur l'id du périphérique,
   distincte du défaut type manette de jeu.

9. **Axe V des UV inversé — le bug des « textures cassées ».** L'OBJ place
   l'origine UV en bas à gauche ; `THREE.DataArrayTexture` force `flipY = false`
   (et `texImage3D` n'a de toute façon pas d'`UNPACK_FLIP_Y`), donc la ligne 0
   des données est le haut de l'image. Blender applique la convention OBJ, d'où
   « ça s'ouvre nickel dans Blender ». Deux conséquences visibles, longtemps
   prises pour deux problèmes distincts : motifs retournés, **et** larges
   plaques grises — le remplissage gris de Flyover vit dans la marge *non
   utilisée* de chaque imagette, et le V non retourné y projetait 21 % des
   échantillons. Corrigé dans `prep.mjs` au moment d'écrire les `vt`
   (`tv.push(1 - v)`), à la frontière OBJ → moteur, à côté d'ECEF → ENU.

10. **Ciel et brouillard trop sombres.** `ColorManagement.enabled` vaut `true`
   par défaut, donc `new THREE.Color(0x9fb8cc)` stocke du linéaire. Le pipeline
   est volontairement pass-through (`outputColorSpace = LinearSRGBColorSpace`,
   shader custom sans `<colorspace_fragment>`), donc cette valeur linéaire
   partait telle quelle dans un framebuffer interprété sRGB : ciel `#587a9a` au
   lieu de `#9fb8cc`. Corrigé par `THREE.ColorManagement.enabled = false` dans
   `main.js`. Vérifié par `readPixels` : le ciel rend maintenant exactement
   `#9fb8cc`.

## Comment ces bugs ont été trouvés

- **`tools/selftest.mjs`** (13 checks) pilote `Physics`/`FlightController`
  directement en Node, sans navigateur — a validé géodésie, hover, montée,
  taux de roulis, non-tunneling CCD, seuils de crash.
- **MCP chrome-devtools**, une fois connecté au vrai Chromium de l'utilisateur
  (`--executablePath=/usr/bin/chromium` ajouté dans `~/.claude.json`, backup
  `.claude.json.bak`), a permis d'inspecter l'état réel du DOM
  (`getComputedStyle`, `getBoundingClientRect`) et de trouver le bug CSS en
  quelques minutes après plusieurs échanges de fausses pistes en aveugle.
- Un harness puppeteer jetable dans le scratchpad de session (supprimé avec
  la session, non versionné) a servi pour les mesures headless avant que le
  MCP soit disponible : timing par étape, screenshots via `canvas.toDataURL()`
  (les captures `page.screenshot()` classiques ratent le canvas WebGL ici),
  bisection de backends ANGLE.
- **Sommets partagés entre matériaux** — la mesure qui a tranché le bug n°9 sans
  ouvrir de navigateur : 66 035 sommets de `chunk0` appartiennent à deux
  matériaux différents ; au même point du monde, les deux textures doivent
  donner la même couleur. Écart moyen |dRGB| 42,4 avec le V d'origine, 14,8 avec
  le V retourné. Le même échantillonnage, pondéré par l'aire monde, a mesuré le
  gris visible : 20,9 % contre 0,9 %. Les deux sont maintenant des checks du
  selftest, avec des seuils calibrés sur ces valeurs (25 et 5 %).
- **Toujours mesurer avant de régler un seuil** (crash) ou de choisir une
  valeur (near plane) — deux cas cette session où une valeur choisie à vue
  était fausse. Et **avant de déclarer qu'un défaut vient des données** : la
  « limite connue » sur les façades grises tenait depuis une session entière
  sans avoir jamais été mesurée, et elle était fausse.

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
- Captures MCP chrome-devtools au ras du sol (piste d'athlétisme du stade Émile
  Anthoine, Champ-de-Mars, façades) : textures à l'endroit, lisibles, aucune
  plaque grise. `take_screenshot` du MCP capture bien le canvas WebGL, contrairement
  au `page.screenshot()` de puppeteer utilisé lors de la session précédente.

## Non vérifié / à faire

- **Ressenti de pilotage réel** (l'utilisateur n'a pas encore volé "pour de
  vrai" avec retour subjectif sur l'acro, les rates, l'expo).
- **Écran de réglages manette** (Tab, remapping avec barres de niveau) —
  code écrit, jamais testé interactivement par l'utilisateur.
- Modes `angle` et `altitude` du contrôleur de vol — testés uniquement par
  construction du code, pas en vol piloté.

## Le seul arbitrage restant : la résolution

Ce n'est pas le gris (voir n°9), c'est la finesse. Mesuré sur la géométrie :
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
  `.setWeather({speed, direction, gust, turbulence})`.

## Le vent (issue #20)

`src/wind.js`, sur le moule de `link.js` : modèle pur, `physics.js` lance les
rayons, `main.js` câble. Voir `README.md` pour le modèle lui-même.

**Vérifié** — 28 checks dans `tools/selftest.mjs`, section `vent` :

- l'air calme est **bit-à-bit identique** à l'absence de modèle de vent. Ce
  n'est pas de la coquetterie : les checks « tenue d'altitude », « vitesse
  terminale » et « immobilité au sol » en dépendent, et un epsilon voudrait
  dire qu'on ajoute puis retranche quelque chose, et ce quelque chose dérive ;
- convention d'axes : vent de nord → souffle vers +Z, vent d'est → vers −X.
  C'est la seule chose ici qui pouvait être exactement à l'envers en ayant
  l'air parfaitement normale ;
- profil monotone, plafonné au-dessus de 300 m, 30 % du vent au ras du sol,
  ×2 entre 10 m et 100 m ;
- rapports de Dryden **mesurés** sur 600 s : σv/σu = 0,72 et σw/σu = 0,53
  (cibles 0,78 et 0,52 ; ~10 % d'erreur d'échantillonnage attendue) ;
- les trois boutons de rafale sont bien trois : doubler la fréquence double les
  arrivées sans changer l'amplitude, allonger la durée ne change pas la
  fréquence ;
- déterminisme : même graine, même météo, et `reset()` revient au départ ;
- sillage réel contre la Tour Eiffel, moyenné sur huit azimuts ;
- coût : 0,008 ms par sonde de dix rayons.

**Mesuré au banc** (`npm run tune`, avant/après le terme ω×r et le couple
`r × F` par moteur) — tous les axes restent dans les cibles :

| | dépassement roulis freestyle | rebond lacet race | stabilisation lacet race |
| --- | --- | --- | --- |
| avant | 0,9 % | 44,1 % | 554 ms |
| après | 0,3 % | 35,7 % | 498 ms |

`BENCH_OMEGA=0 npm run tune` rejoue l'ancien comportement pour refaire la
comparaison.

**Vérifié en vol** (`?scene=tour-eiffel`, chrome-devtools) : profil 3,2 / 11,1 /
17,4 m/s à 2 / 30 / 150 m pour un réglage à 9 m/s ; abri 0,27 et −19 % de
vitesse sous le vent de la tour contre 0,01 au vent ; ascendance +5,2 m/s le
long de la face au vent ; gigue de 0,15 m/s sur une demi-seconde, donc pas de
clignotement ; 100 fps, 6 draw calls, aucune erreur console.

**Deux bugs trouvés en vol et pas au banc**, tous deux invisibles en test
synthétique :

1. un rayon vers le bas qui ne touche rien était lu comme « 400 m d'altitude »,
   ce qui servait le vent de gradient au ras du sol dès qu'on sortait de la
   tuile ou qu'on passait sous la coque. Remplacé par une navigation à
   l'estime depuis la dernière hauteur connue ;
2. l'ascendance se déclenchait **sous le vent** au lieu de la face au vent. Le
   mur qu'un drone est sur le point de heurter est sous le vent de lui, donc
   c'est le rayon 4 qui le trouve, pas le rayon 0.

**Pas vérifié** : le ressenti manche en main. Le banc dit que le modèle est
cohérent et le navigateur dit que les nombres sont les bons, mais « est-ce que
voler dans une tempête est difficile de la bonne façon » ne se mesure pas ici.

**Reste ouvert** : l'issue chapeau #19 garde quatre volets — pluie (#24),
brouillard (#21), nuages (#22), soleil (#23). Le fait transverse qui décidera
des deux derniers : la photogrammétrie est **non éclairée**, son ombrage est
cuit dans les textures, et un soleil mobile double-ombrerait la ville.
