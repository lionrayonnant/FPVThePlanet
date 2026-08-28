# Modèle de vol réaliste — notes de session

> Note de session archivée, détachée de [HANDOFF.md](../../HANDOFF.md) le 2026-08-29 pour alléger le contexte.
> Le passage de « poussée+couple sur une sphère » au modèle quad.js / flightController.js, et le banc tune-pid.
> Pour retrouver une section : `grep -n "^#" modele-de-vol.md`.

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

