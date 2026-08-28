# FPVThePlanet! — Roadmap d'implémentation DA / UX

## Consigne générale pour Claude Code

Transformer progressivement FPVThePlanet! en l'expérience décrite dans `Art Direction & Experience Bible`.

Le développement doit être **incremental et jouable après chaque phase**.

Pour chaque phase :

1. inspecter l'architecture existante avant de modifier ;
2. réutiliser les systèmes déjà présents autant que possible ;
3. ne pas réimplémenter les systèmes physiques qui existent déjà ;
4. préserver `npm run selftest` et les fonctionnalités actuelles sauf lorsqu'une évolution est explicitement demandée ;
5. créer les issues/features nécessaires à partir de la phase ;
6. avant de coder une feature importante, identifier ses données, son état et ses dépendances ;
7. privilégier les systèmes découplés et déterministes ;
8. documenter les nouvelles décisions d'architecture dans le repository ;
9. vérifier que le jeu reste utilisable sans compte serveur permanent ;
10. ne jamais transformer les éléments de DA en dépendances du moteur physique.

Les mécanismes de hacking doivent rester des **abstractions de gameplay inspirées de systèmes réels**, sans implémenter de procédures offensives utilisables contre des drones réels.

---

## Sommaire

Document long. `grep -n '^#' "docs/FPVThePlanet! — Roadmap d'implémentation DA - UX.md"`
donne la ligne de chaque phase ; lire ensuite la plage voulue plutôt que tout le fichier.

- PHASE 0 — Audit et architecture
- PHASE 1 — Operator / local-first state
- PHASE 2 — Operator Terminal / Home
- PHASE 3 — Global Scanner
- PHASE 4 — Persistent world / weather
- PHASE 5 — Terrain acquisition / cache
- PHASE 6 — Session model
- PHASE 7 — Target generation
- PHASE 8 — Target scan / choix de cible
- PHASE 9 — Documentary hacking system
- PHASE 10 — Control Vector + QTE
- PHASE 11 — Entry State
- PHASE 12 — Double HUD
- PHASE 13 — First-second flight experience
- PHASE 14 — Flight / crash / termination
- PHASE 15 — Session Complete
- PHASE 16 — Photos
- PHASE 17 — Session Log / Target Log
- PHASE 18 — Audio final
- PHASE 19 — Visual language pass
- PHASE 20 — ASCII / Pixel / Demo Scene
- PHASE 21 — Lore / RTC v0
- PHASE 22 — Open-source lore hooks
- PHASE 23 — Multiplayer / shared server operator isolation
- PHASE 24 — Performance / persistence / cleanup
- PHASE 25 — Cohérence finale
- Ordre de priorité recommandé (P0 → P3)
- Critère de réussite global

---

# PHASE 0 — Audit et architecture

### Objectif

Comprendre précisément l'état actuel du jeu avant d'engager la transformation.

### Travail

Auditer :

- scènes et chargement ;
- `scenes.json` ;
- `add-map.html` ;
- pipeline `add-map` ;
- stockage actuel ;
- HUD ;
- input ;
- audio ;
- météo ;
- pluie ;
- brouillard ;
- link ;
- lens ;
- physics ;
- crash / respawn ;
- caméra ;
- menu actuel.

Identifier ce qui peut être conservé directement.

Identifier également les limites navigateur concernant :

- détection hardware ;
- stockage local ;
- GPU ;
- mémoire ;
- gamepad ;
- audio ;
- réseau.

### Livrables

Créer une courte documentation :

```text
docs/fpv-rework-architecture.md
```

avec :

```text
CURRENT SYSTEM
      ↓
NEW OPERATOR LAYER
      ↓
WORLD STATE
      ↓
AREA CACHE
      ↓
TARGET GENERATION
      ↓
SESSION
      ↓
FLIGHT
```

### Important

Ne modifier aucun comportement de gameplay à cette phase.

---

# PHASE 1 — Operator / local-first state

### Objectif

Introduire la notion centrale :

> chaque opérateur possède sa propre expérience.

Créer le modèle :

```text
Operator
├── name
├── controlVector
├── settings
├── terrainCache
├── sessions
├── targetLog
└── worldState
```

### Premier lancement

Créer le bootstrapping :

```text
FPVTP! // 0.97b

OPERATOR BOOTSTRAPPING
```

Afficher les informations réellement accessibles au navigateur.

Certaines informations doivent rester `UNKNOWN`.

Créer le `OPERATOR NAME`.

### Control Vector

Créer :

- configuration initiale ;
- 4–8 inputs ;
- défaut 6 ;
- mémorisation ;
- affichage depuis Home ;
- modification ;
- récupération facile.

Le Vector ne doit jamais servir d'authentification.

### Livrable

Premier lancement complet :

```text
hardware discovery
→ operator name
→ control vector
→ initialization complete
→ operator home
```

---

# PHASE 2 — Operator Terminal / Home

### Objectif

Remplacer progressivement l'actuel menu principal par le terminal de l'opérateur.

Créer :

```text
OPERATOR TERMINAL
```

Contenu :

```text
OPERATOR
CONTROL VECTOR
LAST SESSION
LOCAL TERRAIN
GLOBAL SCANNER
SESSION LOG
TARGET LOG
SETTINGS
```

Footer :

```text
FPVTP! // LOCAL INSTALLATION
OPERATOR NEO
3 LOCAL AREAS
42 SESSIONS
17 TARGETS LOGGED
```

### Priorité UX

Le chemin le plus court doit être :

```text
HOME
→ GLOBAL SCANNER
→ FLY
```

et pour une zone déjà acquise :

```text
HOME
→ REVISIT AREA
→ TARGET
→ FLY
```

### Futur

Prévoir une extension de l'identité opérateur pour permettre plus tard :

```text
Operator Randomart
Avatar
```

Ne pas l'implémenter maintenant.

---

# PHASE 3 — Global Scanner

### Objectif

Transformer la carte actuelle en point d'entrée mondial.

Conserver Leaflet.

### Implémenter

- carte réelle ;
- filtre monochrome ;
- recherche de lieu ;
- déplacement/zoom ;
- sélection d'une zone ;
- rectangle utilisateur ;
- affichage de la zone ;
- interface `GLOBAL SCANNER`.

### Grid

Investiguer avant toute implémentation custom :

> peut-on réutiliser directement le grid / découpage Leaflet ou les données déjà produites par le pipeline ?

Ne pas créer une seconde représentation inutile de la grille.

### Map layers

Optionnelle, faible priorité :

```text
MONO
SATELLITE
TERRAIN
DARK
```

Uniquement si le coût est faible.

### Activité

Préparer le modèle :

```text
TARGET DENSITY
SIGNALS
```

mais ne pas encore rendre toute la génération de drones fonctionnelle.

---

# PHASE 4 — Persistent world / weather

### Objectif

Sortir météo, vent, pluie et brouillard du modèle "réglages utilisateur".

Créer un **World State par opérateur**.

Chaque zone possède une évolution météo temporelle.

### Contraintes

La météo :

- est cohérente dans le temps ;
- ne reroll pas à chaque chargement ;
- possède une trajectoire sur environ 7 jours ;
- n'utilise pas toujours le même ordre de conditions ;
- évolue selon les zones.

Le même jour :

```text
TOKYO
CLEAR
```

reste cohérent lors de plusieurs acquisitions rapprochées.

Le lendemain peut être différent.

### Prévisions

Créer une représentation simple :

```text
TODAY
TOMORROW
+2
+3
...
+6
```

avec :

- régime ;
- vent ;
- visibilité ;
- pluie ;
- brouillard ;
- confiance.

### Important

Ne pas ajouter de filtre utilisateur permettant de choisir la météo.

La météo appartient au monde.

Les simulations existantes de :

- vent ;
- pluie ;
- brouillard ;

sont réutilisées comme couche dynamique.

---

# PHASE 5 — Terrain acquisition / cache

### Objectif

Transformer `add-map` en expérience diégétique sans casser son fonctionnement réel.

Boucle :

```text
SEARCH
→ DRAW AREA
→ PROBE AREA
→ ACQUIRE AREA
```

### Probe

Conserver le fonctionnement réel existant.

Changer progressivement le langage :

```text
PROBE AREA
```

et afficher :

```text
PHOTOGRAMMETRY
SAMPLE
COVERAGE
```

### Acquire

Lancer le véritable pipeline.

Pendant le téléchargement afficher :

```text
TERRAIN ACQUISITION
FETCH
DECODE
REBUILD
TEXTURES
GEOMETRY
```

Utiliser autant que possible **les vrais états et métriques du pipeline**.

### RTC

Ajouter une couche de logs internes décoratifs.

Elle ne doit jamais bloquer l'opération.

### Fin

Créer :

```text
TERRAIN ACQUIRED
```

Puis :

```text
KEEP TERRAIN
REMOVE TERRAIN
```

### Cache

Le terrain est attaché à l'opérateur.

Une zone conservée est immédiatement réutilisable.

---

# PHASE 6 — Session model

### Objectif

Créer explicitement la notion de session.

```text
Session
├── operator
├── area
├── target
├── weather snapshot
├── start/end
├── result
├── flight telemetry
├── randomart
├── photos
└── comment
```

### Deux fins

```text
LANDED
CRASHED
```

### Crash

Un crash :

```text
TARGET LOST
SESSION TERMINATED
```

Le terrain reste disponible.

Le drone disparaît définitivement.

### Clean termination

Pose + désarmement :

```text
TARGET STATUS
LANDED
```

Puis post-flight analysis.

---

# PHASE 7 — Target generation

### Objectif

Introduire les drones éphémères.

Une cible n'est pas persistante.

Elle appartient à une session.

Chaque acquisition crée une nouvelle cible.

### Archétypes initiaux

```text
5" FREESTYLE
5" RACE
CINEWHOOP
LONG RANGE
HEAVY 5"
MICRO
```

### Génération

Chaque cible reçoit des paramètres cohérents :

- masse ;
- puissance ;
- vitesse ;
- accélération ;
- précision ;
- temps de réponse ;
- agilité ;
- rates ;
- caméra ;
- FOV ;
- vidéo ;
- batterie ;
- qualité link.

Les variations doivent rester dans des plages plausibles.

### Important

Ne pas créer de système de rareté :

```text
COMMON
RARE
EPIC
LEGENDARY
```

Ce sont des machines, pas du loot.

---

# PHASE 8 — Target scan / choix de cible

### Objectif

Après l'acquisition du terrain :

```text
TARGET SCAN
```

Afficher plusieurs signaux.

Exemple :

```text
01   -54 dBm   ANALOG
02   -59 dBm   UNKNOWN
03   -67 dBm   DIGITAL
04   -71 dBm   UNKNOWN
```

### Information partielle

Utiliser :

```text
KNOWN
EST.
UNKNOWN
```

Ne pas afficher :

- caméra ;
- rates ;
- batterie ;
- état de vol ;

s'ils ne sont pas réellement connus.

### Choix

Le joueur sélectionne un signal.

Cette interaction doit être courte.

---

# PHASE 9 — Documentary hacking system

### Objectif

Introduire les familles de hacking inspirées de mécanismes réels.

V1 :

```text
COMMAND INJECTION
LINK HIJACK
TELEMETRY SPOOF
GNSS SPOOF
NETWORK TAKEOVER
FIRMWARE OVERRIDE
```

### Règle

Les concepts sont documentés et crédibles.

Les procédures interactives sont des **abstractions de gameplay**.

Ne pas implémenter une procédure réutilisable d'intrusion contre du matériel réel.

### Architecture

```text
TARGET
 ↓
TARGET HACK TYPE
 ↓
AUTOMATED ANALYSIS
 ↓
MANUAL OVERRIDE
 ↓
CONTROL VECTOR
 ↓
RITUAL
 ↓
JACK IN
```

---

# PHASE 10 — Control Vector + QTE

### Objectif

Le Vector devient la signature personnelle de l'opérateur.

Le système automatique arrive à :

```text
CONTROL CHANNEL READY
MANUAL OVERRIDE REQUIRED
```

Le joueur entre son Vector.

### Variantes

Le Vector reste fixe.

Le rituel varie.

```text
V1 ≈ 1 sec
V2 ≈ 2 sec
V3 ≈ 3 sec
V4 ≈ 4 sec
```

Chaque type de hack possède ses quatre variantes.

Cela crée :

```text
6 hack types
×
4 rituals
=
24 ritual variants
```

à produire à terme.

### Priorité

Commencer avec :

```text
1 hack type
×
4 rituals
```

puis généraliser la grammaire.

Ne pas produire 24 séquences indépendantes à la main.

---

# PHASE 11 — Entry State

### Objectif

Après `JACK IN`, le joueur découvre un drone **déjà en vol**.

Le hack et l'entry state sont indépendants.

Distribution :

```text
60% COMFORTABLE
25% ACTIVE
12% CHALLENGING
3% HOLY SHIT
```

### Exemples

`COMFORTABLE`

- altitude confortable ;
- espace dégagé ;
- vitesse faible/modérée.

`ACTIVE`

- mouvement clair ;
- trajectoire déjà dynamique.

`CHALLENGING`

- vitesse élevée ;
- virage ;
- turbulence ;
- configuration exigeante.

`HOLY SHIT`

- situation spectaculaire ;
- marge de récupération réelle.

### Safety constraints

Le générateur doit empêcher :

```text
immediate collision
spawn inside terrain
impossible geometry
```

Mais **ne doit pas protéger le joueur contre un mauvais choix météo/drone**.

---

# PHASE 12 — Double HUD

### Objectif

Implémenter deux systèmes indépendants.

```text
DRONE CAMERA
 ↓
DRONE OSD
 ↓
VIDEO / LINK
 ↓
FPVTP OSD
 ↓
LENS
```

### Drone OSD

Variable selon la cible :

```text
BAT
ALT
GPS
SPD
THR
...
```

### FPVTP OSD

Stable :

```text
FPVTP! // 0.97b
OPERATOR // NEO
SESSION 18:42
WIND 2.4 m/s
VIS 14.2 km
LINK -63 dBm
PHOTO READY
```

### Important

Les deux HUD peuvent se chevaucher.

Ne pas construire un système qui essaie toujours de les séparer proprement.

Cela fait partie de l'esthétique.

---

# PHASE 13 — First-second flight experience

### Objectif

Rendre l'entrée dans le drone physiquement immédiate.

Après le rituel :

```text
CONTROL ACQUIRED
```

→ cut direct vers un drone déjà actif.

Pas de :

```text
3
2
1
GO
```

Pas de tutoriel.

Le joueur reprend immédiatement les sticks.

### Variation

Même hack :

```text
calm entry
```

ou :

```text
fast entry
```

ou :

```text
turning entry
```

selon l'entry state tiré indépendamment.

---

# PHASE 14 — Flight / crash / termination

### Objectif

Réorganiser la fin du vol.

### Crash

Seulement :

- dernier frame ;
- bruit ;
- noir ;
- erreur vidéo ;
- perte du lien.

Puis :

```text
LINK LOST

TARGET LOST

SESSION TERMINATED
```

Le joueur sort manuellement du contrôle.

Pas de `GAME OVER`.

Pas de musique.

Pas de blague.

### Landing

```text
LANDING DETECTED
MOTORS DISARMED

END SESSION
```

Puis `SESSION COMPLETE`.

---

# PHASE 15 — Session Complete

### Objectif

Créer le rapport après-vol.

Contient :

- cible ;
- profil ;
- conditions ;
- durée ;
- vitesse ;
- altitude ;
- Randomart ;
- captures ;
- analyse ;
- note opérateur.

### Randomart

Le générer pour la session.

Le même Randomart doit revenir dans les archives / reconnexions associées.

### Commentaire

Créer :

```text
OPERATOR NOTE
```

texte libre.

### Terrain

Proposer :

```text
KEEP TERRAIN
REMOVE TERRAIN
```

La suppression du terrain ne supprime pas la session.

---

# PHASE 16 — Photos

### Objectif

Ajouter une touche de capture pendant le vol.

La photo doit être générée depuis le **flux vidéo du drone**, et non depuis le rendu final propre du jeu.

Elle doit donc conserver :

- FOV ;
- résolution ;
- ratio ;
- OSD ;
- analogique / numérique ;
- bruit ;
- météo ;
- optique ;
- dégradation du link.

Créer `CAPTURES` dans les sessions.

---

# PHASE 17 — Session Log / Target Log

### Objectif

Permettre de retrouver facilement tout ce que l'opérateur a vécu.

### Session Log

Filtres simples :

```text
ALL
LANDED
CRASHED
WITH PHOTOS
```

Chaque entrée :

```text
date
area
target
result
duration
```

Actions :

```text
VIEW SESSION
REVISIT AREA
DELETE SESSION
```

### Target Log

Important :

> le Target Log est un historique, pas un stock de drones disponibles.

Une cible crashée est perdue.

Une cible posée est terminée.

Le log conserve seulement la trace.

---

# PHASE 18 — Audio final

### Objectif

Mettre en place le langage sonore.

### Pas de musique pendant le vol

Le vol est :

- moteurs ;
- air ;
- pluie ;
- propwash ;
- impacts ;
- radio / link.

### UI

Très peu de sons.

Vocabulaire identifiable :

```text
TARGET FOUND
TERRAIN READY
LINK LOST
LINK RESTORED
ERROR
```

### Boot

Utiliser la référence de démarrage :

```text
tututuuut tuuuuu-tuu
```

uniquement comme signature de boot / démarrage.

### Rituals

IDM / demo scene.

Chaque hack a sa signature sonore.

V1–V4 changent durée et construction.

---

# PHASE 19 — Visual language pass

### Objectif

Appliquer la DA aux écrans maintenant que les systèmes fonctionnent.

### Base UI

DOS / Unix / hardware.

Palette :

```text
BLACK
DARK GREY
GREY
LIGHT GREY
WARM WHITE
```

Couleurs fonctionnelles :

```text
GREEN
YELLOW
ORANGE
RED
```

### Demo palette

Réservée aux événements :

```text
CYAN
MAGENTA
VIOLET
ELECTRIC BLUE
```

### Règle

> **UI calm. Events spectacular.**

Ne pas styliser tous les écrans comme des intros demo scene.

---

# PHASE 20 — ASCII / Pixel / Demo Scene

### Objectif

Créer le langage graphique signature.

### ASCII

Trois niveaux :

```text
information
technical diagrams
demo scene spectacle
```

### Pixel art

Petite bibliothèque :

```text
drone
radio
antenna
battery
camera
GPS
map
link
terrain
```

### Demo scene

Créer une bibliothèque de primitives :

```text
ASCII bursts
scan patterns
signal waves
vector animations
color flashes
text deformation
```

Les rituels sont composés à partir de ces primitives.

---

# PHASE 21 — Lore / RTC v0

### Objectif

Ajouter la personnalité du logiciel sans créer de dette narrative.

Crew :

```text
root
jensen
mikhail
```

### Règles

- lore décoratif ;
- aucune intrigue nécessaire ;
- dialogues très courts ;
- humour interne ;
- commentaires de code ;
- changelog ;
- archives RTC.

Le joueur n'est pas membre du crew.

Il est un opérateur externe.

### Open source

Préparer la possibilité de poursuivre le lore dans :

```text
comments
docs
old files
changelogs
commit history
```

mais ne pas construire une intrigue profonde en V1.

---

# PHASE 22 — Open-source lore hooks

### Objectif

Ajouter quelques emplacements volontairement exploitables dans le repository.

Exemples :

```text
docs/
  archive/
  protocol-notes/
  old-builds/
```

ou commentaires intentionnels.

Ne pas multiplier les éléments.

Laisser explicitement une place à un futur lore profond, notamment autour de Jensen.

---

# PHASE 23 — Multiplayer / shared server operator isolation

### Objectif

Valider le scénario de test réel :

> plusieurs amis utilisent le même serveur.

Chaque opérateur doit avoir :

```text
own identity
own vector
own terrain cache
own sessions
own photos
own comments
own world state
```

Aucune session ne doit polluer celle d'un autre opérateur.

Tester :

```text
NEO
TOKYO

VEX
TOKYO
```

en parallèle.

### Architecture cible

Le jeu reste :

> **local-first**

Le serveur partagé est seulement une étape intermédiaire.

---

# PHASE 24 — Performance / persistence / cleanup

### Objectif

S'assurer que la nouvelle couche UX ne détruit pas les performances.

Vérifier notamment :

- taille des caches ;
- photos ;
- sessions ;
- météo ;
- génération des cibles ;
- Randomart ;
- shaders ;
- double HUD ;
- rituels ;
- temps de démarrage ;
- nettoyage mémoire.

### Important

La récupération de terrain reste le principal coût.

Le système doit donc favoriser :

```text
FIRST VISIT
LONG ACQUISITION

REVISIT
FAST
```

---

# PHASE 25 — Cohérence finale

### Objectif

Faire une passe intégrale comme utilisateur.

Tester le parcours :

```text
FIRST LAUNCH
→ BOOTSTRAP
→ OPERATOR
→ VECTOR
→ GLOBAL SCANNER
→ SEARCH
→ DRAW AREA
→ PROBE
→ ACQUIRE AREA
→ LEAVE COMPUTER
→ RETURN
→ TARGET SCAN
→ TARGET SELECTION
→ HACK
→ VECTOR
→ RITUAL
→ JACK IN
→ FLIGHT
→ LAND
→ SESSION COMPLETE
→ PHOTO
→ NOTE
→ KEEP TERRAIN
→ HOME
→ REVISIT
→ NEW TARGET
→ NEW FLIGHT
```

Puis tester :

```text
CRASH
→ VIDEO LOSS
→ EXIT CONTROL
→ TARGET LOST
→ SESSION LOG
→ REVISIT AREA
→ NEW TARGET
```

Et enfin :

```text
SECOND OPERATOR
→ OWN STATE
→ OWN CACHE
→ OWN SESSIONS
```

---

# Ordre de priorité recommandé

## P0 — rendre la nouvelle boucle fonctionnelle

```text
Operator
Home
Global Scanner
Persistent terrain
Session model
Target generation
Target selection
Control Vector
Entry state
Flight
Crash/Landing
```

## P1 — rendre l'expérience FPVTP!

```text
Double HUD
Session Complete
Randomart
Photos
Session Log
Weather timeline
Target Log
```

## P2 — identité forte

```text
Ritual system
Demo scene
Audio
ASCII
Pixel art
RTC
Crew lore
```

## P3 — polish / futur

```text
additional drones
additional hacks
additional ritual variants
map layers
Operator Randomart
avatar
deep lore
technical hack simulation
social features
```

---

# Critère de réussite global

À la fin du chantier, un nouvel utilisateur doit pouvoir comprendre la boucle sans tutoriel :

> **Choose a place. Acquire the terrain. Find a signal. Take the sticks.**

Et l'expérience doit produire cette sensation :

> **I didn't start a level. I connected to a machine.**