# Limites de zone : geofence, plancher et sol lointain

Issue [#139](https://github.com/lionrayonnant/FPVTP/issues/139) — 2026-08-30

## Le problème

Au-delà des tuiles téléchargées il n'y a rien. On sort de la carte sans rien
rencontrer, et on peut revenir **sous** la dalle de terrain.

Ce n'est pas un cas limite qu'on découvrirait en cherchant. En air « clair »
la portée météorologique est d'environ 2,3 km (`baseFogDensity` 0,00085 dans
`src/fog.js`) pour une bbox de ±642 m sur `tour-eiffel` : le bord est
pleinement visible en vol normal, avec du ciel dessous.

`manifest.bbox` existe déjà, et `src/entry-state.js` s'en sert avec un
`EDGE_MARGIN` de 10 m pour ne pas tirer un point d'entrée hors des chunks
chargés. Mais rien ne lit cette bbox **en vol**.

## La fiction

**La zone scannée**, pas la portée radio.

Le pilote a dessiné lui-même son rectangle dans le Global Scanner. Hors de ce
rectangle il n'y a pas de données : pas de couverture, pas de lien. La limite
n'est donc pas une contrainte de jeu plaquée sur le monde, c'est la forme de
ce que le joueur a demandé.

Deux alternatives écartées :

- **Portée radio (cercle centré sur le pilote).** Très cohérent avec
  `link.js`, mais le spawn n'est pas centré dans la bbox — sur `tour-eiffel`
  il est à (−120, 140) dans une boîte de ±642 m. Un cercle inscrit gaspille la
  moitié de la carte téléchargée ; un cercle circonscrit déborde dans le vide.
- **Mur invisible.** Ne se raconte pas. Le dépôt n'a aucune surface qui ne
  soit pas de la géométrie réelle.

Le plancher tombe de la même fiction, et gratuitement : sous la dalle, une
liaison 5,8 GHz n'existe pas.

## Architecture

### `src/geofence.js` — nouveau, pur

Ni THREE, ni Rapier, ni DOM. Même règle et même raison que `wind.js`,
`fog.js`, `link.js` et `flight-end.js` : c'est la moitié que
`tools/selftest.mjs` peut vérifier sans navigateur.

```js
const fence = new Geofence(manifest.bbox);
fence.update(position);   // → this.out, objet réutilisé
```

Sortie, écrite une fois par frame dans le même objet :

| champ | sens |
|---|---|
| `zone` | `NOMINAL` \| `CAUTION` \| `HOLD` \| `LOST` |
| `marginM` | distance signée au bord du volume — positive dedans, négative dehors |
| `push` | `{x, y, z}` — accélération de rappel en m/s², déjà orientée |
| `lossDb` | perte à ajouter au budget de liaison |
| `warning` | `''` ou `'NO COVERAGE'` |

### Le volume

Une boîte alignée sur les axes. Horizontalement c'est **la bbox brute** :
`marginM = 0` tombe exactement là où le maillage s'arrête, donc pas un mètre
de carte téléchargée n'est gaspillé. `CAUTION` et `HOLD` sont des couloirs
*dedans*, `LOST` est dehors. Plancher à `bbox.min.y − FLOOR_DEPTH`, et **pas
de plafond**.

Le plancher est **sous** le minimum du terrain, et le signe compte. La
première rédaction de ce spec le mettait au-dessus (`bbox.min.y +
FLOOR_MARGIN`), ce qui aurait poussé le drone vers le haut au point le plus
bas de la carte — la surface de la Seine sur `ile-de-la-cite`, où voler à
deux mètres de l'eau est un vol parfaitement normal. `bbox.min.y` est le
minimum de **tout le maillage** : on ne peut être en dessous qu'en étant sous
la dalle ou dans la géométrie. C'est exactement l'événement qu'on veut
attraper, et il n'y en a pas d'autre.

La distance signée est le SDF classique d'une AABB, qui donne gratuitement la
direction du rappel (son gradient) :

```
q  = max(pmin − p, p − pmax)        par axe ; l'axe +y n'a pas de borne
sdf = ‖max(q, 0)‖ + min(max(qx, qy, qz), 0)
```

`marginM = −sdf`. Un seul calcul sert aux quatre zones, à la perte de lien et
à la force.

### Les quatre anneaux

| zone | condition | effet |
|---|---|---|
| `NOMINAL` | `marginM > R_CAUTION` | rien |
| `CAUTION` | `R_HOLD < marginM ≤ R_CAUTION` | `warning` clignotant + pré-perte de lien |
| `HOLD` | `0 ≤ marginM ≤ R_HOLD` | rappel vers l'intérieur, plafonné |
| `LOST` | `marginM < 0` | dehors : la perte de lien achève l'image |

`LOST` dit « hors du volume », pas « la session est finie ». La fin est armée
par `main.js` plus loin, à `marginM < −R_HOLD` — là où la clôture a fini de
dépenser le budget de liaison. Les deux coïncident par construction : l'image
meurt exactement au mètre où la session s'arrête.

**Hystérésis sur les deux frontières intérieures.** Sans elle, un
stationnaire pile sur `R_CAUTION` fait strober l'avertissement de l'OSD.
`link.js` a déjà exactement ce problème et exactement cette réponse
(`FREEZE_ENTER` / `FREEZE_LEAVE`, et son commentaire : « at a single threshold
the picture strobes between frozen and clean while you hover on the
boundary »). On reprend la forme : `_ENTER` / `_LEAVE`.

L'écart est posé à 15 % du seuil et n'a pas besoin d'être mieux que ça : il
lui suffit de dépasser la dérive d'un stationnaire tenu, qui se compte en
dizaines de centimètres quand `R_CAUTION` se comptera en dizaines de mètres.
Il n'y a pas deux ordres de grandeur à arbitrer.

### Le rappel n'emprisonne pas

Direction : l'intérieur, le long du gradient du SDF. Amplitude : rampe de 0 à
`marginM = R_HOLD` jusqu'à `A_MAX` à `marginM = 0`, puis constante dehors.

`A_MAX = 0,6 g ≈ 5,9 m/s²` — 60 % de ce que le drone dépense simplement à
tenir un stationnaire. C'est un chiffre choisi, et il est choisi pour ce qu'il
**ne** fait **pas** : il ne dépasse pas la poussée disponible. Un pilote qui
lâche les manches est ramené ; un pilote qui insiste plein gaz passe, et perd
sa session. Ce n'est pas un mur, c'est le failsafe du drone qui se bat contre
toi — un comportement qu'un pilote FPV reconnaît.

Câblage : `main.js` lit `fence.out.push` et appelle `physics.addForce`.
**Pas** dans `quad.js` : ce fichier ne connaît que l'aéro et l'airframe, et
une clôture n'est ni l'un ni l'autre (CLAUDE.md).

### La perte de lien : progressive, et pas défaisable

Arbitré : la coupure passe par le budget de liaison existant, additive en dB
comme `_baseLoss` et `shadow`. L'image se dégrade puis meurt ; on ne se fait
pas éteindre par un `if`.

La courbe ne s'invente rien — elle dépense les constantes que `link.js` a déjà
calibrées, sur la distance que le selftest aura mesurée :

- **Dedans**, de `R_CAUTION` à la limite : 8 dB, soit `KNIFE_EDGE_DB`. C'est le
  plus petit incident que le modèle juge significatif — assez pour se lire
  comme une dégradation, pas assez pour compter. C'est le principe déjà écrit
  dans `link.js` : « you are told you are running out of margin before you run
  out ».
- **Dehors**, de la limite à `R_HOLD` de profondeur : les 50 dB restants. À
  `R_HOLD` dehors la clôture a donc dépensé `LOSS_DEAD − LOSS_CLEAN` = 58 dB.

**Correction, 2026-08-30 (mesurée en implémentant).** Cette première rédaction
disait que 58 dB « tuent n'importe quel lien, si propre soit-il ». C'est faux,
et faux d'une façon qui se calcule :
`qualityOf(l) = 1 − clamp01((l − LOSS_CLEAN)/(LOSS_DEAD − LOSS_CLEAN))`, donc
58 dB ajoutés à un lien propre (perte ambiante ≈ 0) rendent
`1 − (58−18)/58 = 0,31`, pas 0 — mesuré à 0,31034482758620685 en implémentant
la formule à la lettre. 58 dB est la **largeur de la bande de fondu**, de
`LOSS_CLEAN` à `LOSS_DEAD` ; ce n'est pas un budget absolu depuis zéro, qui
vaudrait 76 dB.

L'exigence liante n'était pas le nombre, c'était que l'image meure **exactement
au mètre où la session s'arrête**, quel que soit l'ambiant. La perte terminale
part donc de `LOSS_CLEAN` et non de la perte courante :
`quality = min(quality, qualityOf(LOSS_CLEAN + terminalLoss))`. À
`terminalLoss = 0` c'est `qualityOf(18) = 1`, donc un no-op exact ; à
`FENCE_SPAN` c'est 0, y compris pour un drone déjà à l'ombre d'un bâtiment.
Porter `FENCE_SPAN` à 76 aurait été l'autre correction possible, mais elle
casse le déterminisme : un lien déjà dégradé serait mort avant `R_HOLD`.

La symétrie est voulue : la distance qu'il faut pour s'arrêter est exactement
celle que l'image coûte.

**Le piège trouvé en lisant `link.js`.** La borne de jouabilité de l'issue #79
(`link.js:172-182`) écrête `this._loss` lui-même et replaque la qualité à
`COOLDOWN_FLOOR_Q` = 0,30 après 2 s d'écran noir. Une perte de clôture routée
par le chemin ordinaire serait donc **annulée** : on sortirait de la zone,
l'écran mourrait deux secondes, puis reviendrait. Cette borne existe pour
qu'on ne reste jamais coincé aveugle *en vol* — or ici on ne vole plus.

La clôture a donc son propre canal :

```js
link.setTerminalLoss(db);   // appliqué APRÈS la borne, sur la sortie
```

Pas de lissage sur ce canal : `TAU_FALL`/`TAU_RISE` existent parce que la
géométrie des obstacles est une fonction en escalier. Une position ne l'est
pas — la perte de clôture varie déjà continûment.

### La fin de session

À `marginM < −R_HOLD`, `main.js` arme `flight-end.js`.

`CRASHING` réutilisé, mais **pas** `TIMELINE` : cette chronologie commence par
0,9 s d'image morte à laisser pourrir à l'écran, ce qui suppose un impact.
Ici l'image est déjà morte, progressivement, sur les `R_HOLD` derniers mètres
— il n'y a rien à laisser pourrir. Un troisième calendrier, `FENCE_TIMELINE`,
plus proche de `LANDING_TIMELINE` dans l'esprit : le noir monte tout de suite,
et la première ligne nomme la cause.

```
OUT OF COVERAGE
(blanc)
SIGNAL LOST
SESSION TERMINATED
(blanc)
[ENTER] DISCONNECT
```

Mise en scène, pas mesure — comme `TIMELINE` le dit déjà de la sienne.

Pas de respawn : `main.js:651` en a déjà posé la règle (« on ne fait pas
réapparaître un drone qu'on a perdu »).

### L'avertissement

Le slot existe : `drone-osd.js:91` a déjà `warning`, son clignotement à 500 ms
et sa chaîne de priorité. On y insère `NO COVERAGE` :

```
LOW VOLTAGE  >  NO COVERAGE  >  RXLOSS
```

`NO COVERAGE` passe devant `RXLOSS` parce qu'en zone `CAUTION` la clôture
*est* la cause du RXLOSS : afficher l'effet plutôt que la cause dirait au
pilote de revenir vers... rien.

### Le sol lointain — `src/ground.js`, nouveau

Un plan à `bbox.min.y − FLOOR_DEPTH − 0,5`, de côté 4× la portée du
brouillard, couleur
d'air légèrement plus sombre que l'horizon pour qu'une ligne d'horizon
existe, lisant les **mêmes** uniformes de brouillard que les tuiles (`setFog`,
`setNight`, `setDim` de `loader.js`).

Sous le point le plus bas du maillage par construction, donc rien ne peut
z-fighter avec la ville ; et sous le plancher de la clôture, donc on ne peut
jamais passer dessous.

**Limite connue, à vérifier en vol.** À 100 m d'altitude au milieu de la
carte, le bord est à ~640 m : à 2,3 km de portée le brouillard n'y mange que
26 %. Le plan sera donc franchement visible, et plat. Le pari est qu'il se
lit comme la plaine derrière la ville, aplatie par la brume — ce qui est
plausible pour Paris et strictement mieux que du ciel sous le sol. Si à
l'écoute visuelle il se lit comme une nappe morte, la correction la moins
chère est un bruit de valeur à grande échelle sur sa couleur, quelques
instructions de shader. À trancher **après** avoir regardé, pas avant.

### Ce qui ne bouge pas

- **Pas de jupe verticale** fermant la tranche de la dalle : invisible une
  fois qu'on ne peut plus passer dessous. À construire le jour où on la voit.
- **Pas d'anneau de tuiles basse résolution.** C'est la vraie réponse « monde
  étendu », mais elle touche l'exporteur Go, `prep.mjs` et la VRAM. Issue
  séparée.
- **Pas de rampe de brouillard masquant le bord.** Masquer le bord
  contredirait la fiction. La zone s'arrête, et le HUD dit pourquoi ; c'est
  plus fort que de le cacher.

## Les seuils : mesurés

`R_HOLD` et `R_CAUTION` ne sont pas posés à l'œil. CLAUDE.md :
mesurés, pas choisis à la main.

### `tools/geofence-measure.mjs`

Sur le patron de `tools/landing-selftest.mjs` : vrai Rapier, vrai
`FlightController`, vrai `quad.js`, une scène réelle, un seul monde. (Le nom
`geofence-selftest.mjs` est pris par les tests unitaires du modèle : le dépôt
sépare les deux patrons, un banc de mesure n'est pas une suite de tests.)

**`R_HOLD` = la distance d'arrêt.** Pour chaque famille de
`drone-profiles.js`, le drone approche plein gaz vers une face ; à l'entrée en
`HOLD` le pilote obéit, et seuls le rappel plafonné plus la traînée propre du
quad le décélèrent. On mesure la pénétration maximale, par recherche de point
fixe. `R_HOLD` = le pire cas sur toutes les familles.

**Correction, 2026-08-30 (trouvée en mesurant).** La première rédaction disait
« les manches reviennent au neutre (le pilote a lu l'avertissement et a
lâché) ». C'est faux dans ce jeu. `FlightController` prend `'acro'` par défaut
et `src/entry-state.js` le force : **en ACRO, des manches centrées ne remettent
pas à plat, elles tiennent l'assiette.** Le drone reste piqué à 42°, plein axe,
et continue d'accélérer — pénétrations mesurées de +37 m à +853 m selon la
famille. La première mesure (29 m) avait été prise en ANGLE, donc elle
répondait à une question que le jeu ne pose pas.

« Obéir » est donc défini par un programme de manche explicite, écrit dans le
commentaire figé de `geofence.js` : **gaz ramenés au stationnaire, et tangage
tiré pour ramener l'appareil à plat, puis centré.** C'est ce qu'un pilote FPV
fait réellement pour s'arrêter en acro. Trois autres hypothèses tacites ont
suivi le même sort : la vitesse d'approche est prise plein gaz et non aux trois
quarts, les gaz de freinage sont balayés de zéro au stationnaire avec le pire
cas retenu, et la marge est la dispersion mesurée du point d'arrêt sur ce
balayage, non plus un mètre posé.

Deux hypothèses restent ouvertes et portent leurs tickets : l'assiette
d'approche est encore plafonnée à 42° (#141), et le pire cas « gaz coupés »
dimensionne sur un pilote qui tombe et s'écraserait avant de franchir (#142).

Un pilote qui insiste **doit** pouvoir passer, c'est la moitié du design.
`R_HOLD` dimensionne le cas où on obéit, pas le cas où on désobéit.

**Une borne, en plus de la mesure.** `R_HOLD` et `R_CAUTION` sont mesurés sur
`tour-eiffel`, dont le demi-côté fait 641 m. Neuf des vingt-quatre scènes ont
un demi-côté sous 340 m, et sur `bastille` (164 m) le couloir mesuré avalerait
89 % de la carte — le banc refuse même d'y tourner, faute d'élan. `Geofence`
borne donc son couloir horizontal à **un tiers du plus petit demi-côté de la
bbox**, les deux seuils à la même échelle pour que le temps d'avertissement
survive à la réduction. Le cœur volable n'est ainsi jamais sous 67 % du plus
petit côté, et les quinze grandes cartes gardent la valeur mesurée intacte.
C'est une borne, pas une mesure : elle ne dit pas que le chiffre est faux,
elle dit ce qu'on en garde quand la carte ne peut pas le payer.

**`R_CAUTION` = `R_HOLD` + délai de lecture × vitesse max.** Le délai est de
la mise en scène et s'assume comme telle, mais il s'ancre sur une constante du
dépôt : `BLINK_PERIOD_MS` = 500 ms (`drone-osd.js:51`). Un avertissement doit
clignoter trois fois pour être lu — soit 1,5 s.

**Le corridor vertical ne se mesure pas, et c'est délibéré.** Une distance
d'arrêt n'a pas de sens ici : on n'arrive pas sous la dalle en fonçant, on y
arrive en se faufilant par un trou du maillage ou en rentrant par le bord. Le
corridor est donc court et posé sur un argument géométrique, pas sur une
mesure — `CAUTION` dès 2 m sous `bbox.min.y`, `HOLD` à 5 m, fin de session à
10 m (`FLOOR_DEPTH` = 10). Deux mètres sous la surface la plus basse de la
carte, on est sous quelque chose ; il n'y a pas de faux positif à écarter,
donc rien à séparer, donc rien à mesurer.

### Vérifications hors-navigateur, dans `tools/selftest.mjs`

1. Le SDF : intérieur, extérieur, faces, arêtes, coins, plancher — contre une
   référence par force brute.
2. Les quatre zones et leur hystérésis : un balayage aller-retour à travers
   chaque frontière ne produit **aucun** doublon de transition.
3. Le rappel : direction toujours rentrante, norme toujours ≤ `A_MAX`,
   continue en `marginM = R_HOLD` (pas de à-coup à l'entrée en `HOLD`).
4. La perte : monotone croissante avec la profondeur, exactement
   `KNIFE_EDGE_DB` à la limite, ≥ `LOSS_DEAD − LOSS_CLEAN` à `−R_HOLD`.
5. La borne #79 : une perte terminale de 58 dB tenue 30 s laisse
   `quality = 0` du début à la fin — la borne ne la relève jamais.
6. Le point d'entrée : sur **chaque** scène de `public/scenes.json`, 10 000
   tirages de `entry-state.js` tombent tous en `NOMINAL`.

### Une dépendance à corriger

`EDGE_MARGIN` = 10 m dans `entry-state.js` sera plus petit que `R_CAUTION`.
En l'état, un point d'entrée pourrait naître déjà en `CAUTION`, voire en
`HOLD` — le vol commencerait sur un avertissement. `entry-state.js` importe
donc `R_CAUTION` depuis `geofence.js` et son `EDGE_MARGIN` local disparaît.

C'est aussi ce que la vérification 6 protège.

## Fichiers

| fichier | ce qui change |
|---|---|
| `src/geofence.js` | **nouveau** — le modèle, pur |
| `src/ground.js` | **nouveau** — le sol lointain |
| `src/main.js` | câblage : `update`, `addForce`, `warning`, l'armement de fin |
| `src/link.js` | `setTerminalLoss(db)`, appliqué après la borne #79 |
| `src/flight-end.js` | `FENCE_TIMELINE` |
| `src/entry-state.js` | `EDGE_MARGIN` → `R_CAUTION` importé |
| `src/drone-osd.js` | rien : le slot `warning` suffit |
| `tools/geofence-selftest.mjs` | **nouveau** — la mesure de `R_HOLD` |
| `tools/selftest.mjs` | les six vérifications |
| `sim/README.md` | la section « limites de zone » |

## Critères d'acceptation

1. En vol, aucun endroit d'où l'on voie du ciel sous le sol.
2. On ne peut pas passer sous la dalle sans être ramené.
3. Sortir sans le vouloir est impossible : l'avertissement précède la limite
   d'au moins 1,5 s à la vitesse maximale de l'appareil.
4. Sortir en le voulant reste possible, et termine la session.
5. `R_HOLD` et `R_CAUTION` sortent de `tools/geofence-selftest.mjs`, avec le
   chiffre et la date en commentaire, comme les seuils de pose de
   `flight-end.js`.
6. `npm run selftest` passe sur toutes les scènes.
7. **Vérifié en vol, à l'œil** : le sol lointain, le ressenti du rappel au
   manche, et la lisibilité de l'avertissement. C'est le critère que rien
   d'automatique ne remplace.
