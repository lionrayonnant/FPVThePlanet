# Bugs de la phase POC — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> Les dix bugs trouvés et corrigés pendant la mise au point du POC, et la méthode qui les a trouvés.
> Pour retrouver une section : `grep -n "^#" bugs.md`.

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

