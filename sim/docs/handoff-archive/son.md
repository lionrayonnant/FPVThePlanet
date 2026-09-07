# Son — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> Synthèse Web Audio depuis les quatre moteurs, et la correction de fatigue auditive.
> Pour retrouver une section : `grep -n "^#" son.md`.

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
  (`fpvtp.audioVolume`) et bien relu après rechargement. Aucune erreur console.

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

