# FPVThePlanet! — Art Direction & Experience Bible

### Direction validée — v0.1

---

## Sommaire

Ce document est long. Pour lire une section sans charger tout le fichier :
`grep -n '^#' "docs/FPVThePlanet! — Art Direction & Experience Bible.md"` donne
le numéro de ligne de chaque titre, puis lire la plage voulue.

1. Vision · 2. Piliers de l'expérience · 3. La boucle fondamentale ·
4. Global Scanner · 5. Informations météo · 6. Activité drone · 7. Terrain local ·
8. Acquire Area · 9. Logs RTC · 10. Le Crew · 11. Language · 12. Operator ·
13. Premier lancement — Bootstrapping · 14. Control Vector · 15. Acquisition d'une cible ·
16. Hacking · 17. Types de hacks · 18. Rituels d'acquisition · 19. Demo Scene · 20. Entry State ·
21. Profils de drones · 22. Ce qui est connu du drone · 23. Double HUD ·
24. Perte du signal et crash · 25. Fin propre d'une session · 26. Randomart · 27. Photos ·
28. Session Log · 29. Terrain et mémoire · 30. Home — Operator Terminal · 31. Settings ·
32. Avatar opérateur — futur · 33. Comptes / local-first · 34. Son ·
35. Signature sonore du boot · 36. Son des rituels · 37. Voix ·
38. Direction visuelle · 39. Typographie · 40. ASCII · 41. Pixel art · 42. CRT et image ·
43. Le double système de rendu · 44. Principes anti-dérive · 45. La règle maîtresse ·
46. État actuel / priorités · 47. La phrase qui résume FPVThePlanet!

---

## 1. Vision

**FPVThePlanet!** est un simulateur FPV libre présenté comme un **outil clandestin de reverse engineering permettant d'intercepter et de prendre le contrôle de drones à travers le monde**.

Le logiciel semble provenir de la culture informatique underground de la fin des années 1990 / début 2000 : crackers, demo scene, hardware hackers, outils DOS/Unix, radio et électronique.

La référence temporelle principale se situe autour de **1998–2003**, avec une sensation proche de l'époque PS2.

La règle fondamentale est :

> **Le jeu ne doit pas donner l'impression de simuler un logiciel rétro. Il doit donner l'impression qu'un tel logiciel aurait réellement pu exister à cette époque.**

Le monde 3D n'est pas artificiellement « rétro ».

La photogrammétrie reste brute.

La nostalgie vient de l'interface, du signal vidéo, du son, de la typographie, de la densité des informations et de la culture du logiciel.

---

# 2. Piliers de l'expérience

### 1. Information, not assistance

FPVTP! montre ce qu'il sait.

Il ne dit pas au joueur quoi faire.

La météo peut être mauvaise. Un Tinywhoop peut être une très mauvaise idée dans une tempête. Le jeu ne l'interdit pas.

Le joueur décide.

### 2. Terrain persistent, flights ephemeral

Le terrain capturé peut être conservé.

Le vol, lui, est éphémère.

Un drone n'existe que pendant la session qui l'a produit.

Après un crash, il est perdu.

Après une fin propre, il devient une archive,m réutilisable.

### 3. Quiet by default, spectacular by interruption

L'interface quotidienne est sobre.

Les couleurs demo scene, les animations et les sons IDM spectaculaires apparaissent uniquement lors de certains événements.

La démesure doit provoquer un **pic d'adrénaline**, préparer psychologiquement le joueur au vol, puis disparaître brutalement lorsque le flux FPV commence.

### 4. Realism documentary first

Les systèmes de hacking s'appuient sur de vrais concepts de sécurité drone.

La V1 privilégie un **réalisme documentaire** : les familles de vulnérabilités et les systèmes évoqués sont réels, mais les procédures de jeu restent abstraites et sûres.

Une éventuelle V2 pourrait approfondir la simulation technique.

---

# 3. La boucle fondamentale

L'expérience doit être extrêmement simple :

```text
I DECIDE
    ↓
I LAUNCH THE COLLECTION
    ↓
LONG REAL ACQUISITION
    ↓
I LEAVE THE COMPUTER
    ↓
I COME BACK
    ↓
I CHOOSE A DRONE
    ↓
I HACK IT
    ↓
JACK IN
    ↓
I FLY
    ↓
LAND  ──────────────→  SESSION SAVED
  │
  └─ CRASH ─────────→ TARGET LOST
```

La boucle longue n'est donc pas un défaut technique.

Le délai réel de récupération et de préparation des données devient une **opération d'acquisition** dans la fiction.

---

# 4. GLOBAL SCANNER

Le `GLOBAL SCANNER` est le menu principal après l'initialisation.

Il utilise une vraie carte géographique avec Leaflet.

### Fond par défaut

Carte réelle, monochrome / N&B.

La carte doit rester utile et immédiatement compréhensible.

Le joueur doit pouvoir chercher :

- sa ville ;
- son quartier ;
- un monument ;
- un lieu de vacances ;
- n'importe quel endroit intéressant.

On ne part pas d'une liste de « niveaux ».

### Recherche

```text
GLOBAL SCANNER

SEARCH LOCATION

[ Tokyo________________________ ] [ FIND ]
```

### Zone

Le joueur retrouve le fonctionnement actuel :

```text
SEARCH
    ↓
MOVE / ZOOM
    ↓
DRAW RECTANGLE
    ↓
PROBE AREA
    ↓
ACQUIRE AREA
```

Le rectangle reste la zone demandée.

Le véritable quadrillage utilisé par le système doit idéalement être celui réellement produit par Leaflet / le pipeline lorsqu'il est disponible, plutôt que de reconstruire artificiellement une grille graphique.

### Couches cartographiques

Optionnelle, priorité basse.

Par défaut :

```text
MONO
```

Et éventuellement, si le coût technique est faible :

```text
SATELLITE
TERRAIN
DARK
```

Aucune couche supplémentaire ne doit être développée pour des raisons purement esthétiques.

---

# 5. Informations météo

Chaque zone possède un état météo évoluant sur environ **sept jours glissants**.

L'ordre des conditions n'est pas fixe.

Exemple :

```text
TODAY       CLEAR
SAT         CLEAR
SUN         CLOUD
MON         LIGHT RAIN
TUE         FOG
WED         CLEAR
THU         WINDY
```

Une autre zone peut avoir une séquence complètement différente.

La météo est cohérente dans le temps :

> relancer immédiatement une acquisition ne change pas magiquement la météo.

Elle peut évoluer plus tard.

### Prévision

La prévision reste indicative.

```text
TODAY
CLEAR / LOW WIND

TOMORROW
LIGHT RAIN

CONFIDENCE
██████████░░
```

### Principe

Le joueur choisit lui-même sa combinaison :

```text
STORM
13.7 m/s

MICRO
```

est autorisé.

Le jeu ne décide pas à sa place que le Tinywhoop est « interdit ».

Il conserve cependant des garde-fous techniques contre les situations générées absurdes ou immédiatement impossibles.

---

# 6. Activité drone

La carte ne montre pas des centaines de petits drones.

Elle montre **l'activité radio estimée**.

```text
SIGNAL DENSITY
LOW ───────── HIGH
```

Une zone peut afficher :

```text
TARGETS EST.
~80–120
```

et une autre :

```text
~4–8
```

Les valeurs sont des estimations, pas des vérités omniscientes.

Le joueur peut donc penser :

> « Tokyo, beaucoup de signaux, météo parfaite. Go. »

---

# 7. Terrain local

Une zone déjà capturée devient un **LOCAL TERRAIN CACHE**.

```text
TOKYO / SECTOR 07
TERRAIN
LOCAL CACHE

412 MB
READY
```

Revenir sur cette zone ne rejoue pas une ancienne session.

Cela signifie :

> **Revenir sur le même territoire et rechercher un nouveau drone.**

Chaque nouvel essai peut produire :

- une autre cible ;
- un autre point d'entrée ;
- une autre situation de vol ;
- une autre caméra ;
- une autre configuration ;
- la même météo si le temps n'a pas évolué.

---

# 8. ACQUIRE AREA

C'est la longue opération réelle.

Avant lancement :

```text
AREA ANALYSIS

TILES
88 × 74

REQUESTS
6512

SURFACE
1.82 km²

EST. DATA
412 MB

[ PROBE AREA ]
[ ACQUIRE AREA ]
```

Après lancement :

```text
FPVTP! // 0.97b

AREA ACQUISITION
TOKYO / SECTOR 07

TERRAIN
██████████████░░░░

FETCH
████████████████░░

DECODE
██████████░░░░░░░░

REBUILD
███████░░░░░░░░░░░

RF ANALYSIS
██████████████░░░░

TARGET SEARCH
██████░░░░░░░░░░░░
```

L'écran affiche en parallèle :

- progression réelle du téléchargement ;
- géométrie ;
- textures ;
- statistiques ;
- logs ;
- fragments RTC ;
- activité de l'analyse.

Il ne s'agit pas d'un mini-jeu.

Le joueur peut partir.

---

# 9. Logs RTC

Les logs rendent l'attente intéressante sans la rendre obligatoire.

```text
[RTC // INTERNAL]

> root
tokyo

> mikhail
obviously

> root
there are a lot

> mikhail
drones or tiles

> root
yes

> mikhail
excellent
```

Les conversations sont secondaires et peuvent être ignorées.

---

# 10. LE CREW

Les membres actuellement définis :

### `root`

Cerveau des opérations.

Il tranche.

### `jensen`

Agent double.

Autonomie importante.

Son véritable agenda reste volontairement inexpliqué dans la V1.

### `mikhail`

Russe, garde-fou technique.

Sa nationalité n'est pas sa personnalité.

Il intervient lorsque root confond « ça marche » et « c'est correct ».

Exemple :

```text
> root
ship it

> mikhail
no

> root
why

> mikhail
because it is wrong

> root
it works

> mikhail
that is not the same thing
```

### Lore

Pour la V1 :

> **Le lore est décoratif.**

Il existe dans :

- RTC ;
- changelogs ;
- commentaires de code ;
- vieux fichiers ;
- fragments d'archives.

Il n'y a pas d'intrigue à suivre.

Une piste de **lore profond dans le dépôt open source** est volontairement conservée pour plus tard.

---

# 11. LANGUAGE

Le jeu est **entièrement en anglais**.

Cela concerne :

- interface ;
- menus ;
- boutons ;
- états ;
- logs ;
- RTC ;
- changelogs ;
- commentaires diégétiques ;
- messages d'erreur ;
- descriptions ;
- onboarding ;
- documentation interne.

Les formulations doivent sonner comme de l'anglais natif de logiciel technique, pas comme du français traduit.

---

# 12. OPERATOR

Le joueur est un **opérateur externe**.

Il ne fait pas partie du crew.

Au premier lancement, il crée un `OPERATOR NAME`.

```text
OPERATOR BOOTSTRAPPING

OPERATOR NAME

[ NEO________________ ]

[ REGISTER ]
```

L'expérience est **propre à chaque opérateur**.

Le serveur partagé temporaire peut héberger plusieurs opérateurs, mais la cible à long terme est **local-first** : chacun peut faire tourner sa propre installation sur son PC.

---

# 13. Premier lancement — Bootstrapping

Le premier lancement inspecte réellement l'environnement disponible au navigateur.

```text
SYSTEM

PLATFORM ............ WIN32
BROWSER ............. CHROME
LANGUAGE ............ FR-FR
TIMEZONE ............ EUROPE/PARIS

DISPLAY
2560 × 1440
144 Hz

RENDERER
WEBGL2

GPU
NVIDIA RTX 4070

INPUT
GAMEPAD DETECTED
4 AXES

AUDIO
HEADPHONES

NETWORK
ONLINE

TERRAIN CACHE
EMPTY
```

Certaines choses restent `UNKNOWN`.

Le but est de produire un petit malaise :

> « Pourquoi ce logiciel sait ça ? »

Mais aucune information inaccessible au navigateur ne doit être simulée comme réelle.

Des commentaires internes peuvent apparaître :

```text
// root: 144hz
// vex: acceptable

// root: radio detected
// vex: good
```

---

# 14. CONTROL VECTOR

Le joueur crée sa propre signature lors du premier piratage / initialisation.

4 à 8 inputs.

6 par défaut.

```text
DEFINE CONTROL VECTOR

4–8 INPUTS
DEFAULT LENGTH: 6

THIS VECTOR WILL BE REQUIRED
FOR FUTURE TARGET ACQUISITIONS.

WRITE IT DOWN.

_ _ _ _ _ _

[ CONFIRM VECTOR ]
```

Puis :

```text
CONTROL VECTOR REGISTERED

↑ → ↓ ← ↑ ←

KEEP THIS VECTOR.
YOU WILL NEED IT.
```

Le Vector :

- appartient à l'opérateur ;
- reste identique d'une zone à l'autre ;
- n'est jamais un mot de passe ;
- n'est jamais nécessaire pour ouvrir le jeu ;
- peut être rappelé depuis la Home ;
- peut être modifié dans `OPERATOR`.

Le jeu doit toujours permettre sa récupération.

---

# 15. Acquisition d'une cible

Une fois le terrain acquis :

```text
TARGET SCAN

SIGNALS DETECTED

01   -54 dBm   ANALOG
02   -59 dBm   UNKNOWN
03   -67 dBm   DIGITAL
04   -71 dBm   UNKNOWN
```

Le joueur choisit.

Avant le hack, FPVTP! n'affiche que ce qu'il sait réellement :

```text
TARGET 02

LOCATION
KNOWN

SIGNAL
-59 dBm

DEVICE
PARTIAL

VIDEO
UNKNOWN

CONTROL
UNKNOWN

FLIGHT STATE
UNKNOWN
```

Trois niveaux d'information :

`KNOWN`

→ réellement mesuré.

`EST.`

→ déduction.

`UNKNOWN`

→ véritable inconnue.

---

# 16. Hacking

La V1 utilise un **réalisme documentaire**.

Les familles de systèmes / vulnérabilités peuvent s'inspirer de systèmes réels de communication drone :

- command injection ;
- control/link hijacking ;
- telemetry spoofing ;
- GNSS spoofing ;
- network / companion takeover ;
- firmware/configuration compromise.

MAVLink est un exemple concret de protocole drone où, sans signature, des commandes peuvent être acceptées par le véhicule ; PX4 documente notamment des risques allant des changements de paramètres et missions jusqu'à l'armement/désarmement ou certaines commandes critiques. ArduPilot documente également MAVLink2 Signing comme mécanisme d'authentification des commandes sur les liens concernés. Le spoofing GNSS est également documenté expérimentalement sur des UAV, avec la difficulté importante de transformer un spoofing en contrôle complet et stable.

Le jeu ne doit pas reproduire des procédures offensives réelles à l'identique.

Les noms et principes sont crédibles ; leur traduction en interaction est une abstraction ludique.

---

# 17. Types de hacks

Chaque famille possède **4 variantes de rituel**.

| Hack                | Grammaire visuelle              |
| ------------------- | ------------------------------- |
| `COMMAND INJECTION` | paquets, séquences, bursts      |
| `LINK HIJACK`       | porteuse radio, synchronisation |
| `TELEMETRY SPOOF`   | oscilloscope, données           |
| `GNSS SPOOF`        | vecteurs, position, navigation  |
| `NETWORK TAKEOVER`  | nœuds, terminaux, routes        |
| `FIRMWARE OVERRIDE` | offsets, mémoire, patch         |

Le type de hack est une propriété de la cible.

Il ne détermine **pas** la difficulté du vol.

---

# 18. Rituels d'acquisition

Chaque type de hack possède quatre variantes :

```text
V1 ≈ 1 sec
V2 ≈ 2 sec
V3 ≈ 3 sec
V4 ≈ 4 sec
```

Le jeu choisit aléatoirement la variante.

Le joueur intervient manuellement avec son `CONTROL VECTOR`.

Le Vector reste toujours le même.

Ce qui change est la mise en scène.

```text
AUTOMATED BYPASS ........ OK
CONTROL CHANNEL ......... READY

MANUAL OVERRIDE REQUIRED

↑ → ↓ ← ↑ ←
```

Le joueur entre son vecteur.

Puis :

**1 à 4 secondes de folie demo scene.**

Ensuite :

```text
CONTROL ACQUIRED
```

et coupure immédiate vers le flux.

---

# 19. Demo Scene

La demo scene est **événementielle**.

Pas de cyan/magenta en permanence.

Pas de glitch permanent.

Pas de HUD psychédélique.

Les couleurs exceptionnelles :

- cyan ;
- magenta ;
- violet ;
- bleu électrique.

sont réservées aux :

- `JACK IN` ;
- hacks ;
- événements décisifs ;
- reconnexions exceptionnelles ;
- éventuellement autres événements futurs.

La règle :

> **Une à quatre secondes de folie, puis retour au calme.**

Ces événements doivent provoquer une **montée d'adrénaline avant le pilotage**.

---

# 20. Entry State

Le type de hack et la situation de départ du drone sont **indépendants**.

Distribution initiale :

```text
60%  COMFORTABLE
25%  ACTIVE
12%  CHALLENGING
3%   HOLY SHIT
```

### Comfortable

Drone suffisamment stable, espace de sécurité.

### Active

Mouvement clair, virage, vitesse déjà présente.

### Challenging

Vitesse importante, angle, turbulence ou environnement plus exigeant.

### Holy shit

Situation spectaculaire mais récupérable.

Le générateur doit respecter une enveloppe de sécurité géométrique pour éviter un spawn absurde contre un obstacle.

Le joueur doit parfois avoir une ou deux secondes de panique.

Mais il ne doit jamais être tué arbitrairement par le générateur.

---

# 21. Profils de drones

Six grandes familles :

```text
5" FREESTYLE
5" RACE
CINEWHOOP
LONG RANGE
HEAVY 5"
MICRO
```

Chaque famille définit des plages plausibles de :

- vitesse ;
- accélération ;
- précision ;
- temps de réponse ;
- inertie ;
- agilité.

Chaque individu possède ensuite des variations sur :

1. rates ;
2. caméra ;
3. FOV ;
4. vidéo ;
5. batterie ;
6. masse ;
7. qualité du link.

Les paramètres restent cohérents entre eux.

Un 5" Race ne devient pas soudainement un Cinewhoop avec une valeur différente.

Mais deux 5" Race peuvent être assez différents pour produire deux expériences réellement distinctes.

---

# 22. Ce qui est connu du drone

Avant l'acquisition :

```text
LOCATION       KNOWN
SIGNAL         KNOWN
CLASS          PARTIAL / EST.
VIDEO          PARTIAL
CAMERA         UNKNOWN
FOV            UNKNOWN
RATES          UNKNOWN
BATTERY        UNKNOWN
FLIGHT STATE   UNKNOWN
```

Pendant le vol :

> **Le joueur apprend la machine par ses sensations et son OSD.**

FPVTP! ne fait pas apparaître de gros panneaux d'analyse.

Après le vol :

> **FPVTP! analyse la session.**

---

# 23. Double HUD

Le flux vidéo contient deux systèmes superposés.

### HUD du drone

Il appartient à la cible.

Il peut changer énormément :

```text
BAT 15.3V
ALT 82
GPS 48.8582
SPD 72
THR 47%
```

Il peut être riche ou quasiment vide.

Il peut être analogique ou numérique.

### HUD FPVTP!

Il appartient à l'opérateur :

```text
FPVTP! // 0.97b

OPERATOR // NEO
SESSION 18:42

WIND 2.4 m/s
VIS 14.2 km
LINK -63 dBm

PHOTO READY
```

Le HUD FPVTP! ne sait pas forcément comment est disposé celui du drone.

Ils peuvent se superposer.

Certaines informations peuvent devenir illisibles parce que les deux couches se rencontrent.

C'est une caractéristique voulue :

> **FPVTP! injecte une interface générique dans un flux qui n'est pas le sien.**

---

# 24. Perte du signal et crash

Il n'y a pas de `GAME OVER`.

En cas de crash :

```text
[ LAST FRAME ]

VIDEO ERROR
```

ou :

- bruit ;
- noir ;
- dernière image ;
- désynchronisation ;
- perte de signal.

Puis :

```text
LINK LOST

TARGET LOST

SESSION TERMINATED
```

Le joueur doit lui-même sortir du contrôle.

Pas de commentaire ironique.

Pas de musique — la musique du vol s'est éteinte avec le vol (coupée net au
crash, relâchée en fondu à la pose, cf. §34 révisé, issue #122). L'écran de fin
reste silencieux : c'est le contraste qui le rend lourd.

Pas de récompense.

Pas de grand écran de mort.

Le sentiment recherché :

> **« Je viens de perdre une machine distante. »**

Le terrain reste conservé.

Le drone, lui, est perdu.

---

# 25. Fin propre d'une session

Si le joueur pose le drone et désarme :

```text
SESSION TERMINATED

TARGET STATUS
LANDED
```

Puis analyse :

```text
POST-FLIGHT ANALYSIS

PROFILE
5" FREESTYLE
CONFIDENCE 84%

OBSERVED
MAX SPEED       87.4 m/s
MAX RATE        ~820°/s
FLIGHT TIME     18:42

ESTIMATED
MASS            ~410 g
FOV             ~148°
RESPONSE        ~31 ms
```

Certaines informations peuvent rester :

```text
UNKNOWN
CAMERA MODEL
FLIGHT CONTROLLER
MOTOR SETUP
```

---

# 26. Randomart

Le Randomart est inspiré du concept SSH.

Il est associé à la session / cible.

Il apparaît :

- lors de la connexion ;
- dans les archives ;
- lors de certains événements comme une reconnexion ;
- après une acquisition.

Il peut apparaître de nouveau pendant une reconnexion ou après un événement de liaison.

Le Randomart n'est pas seulement décoratif :

> **c'est l'empreinte visuelle de l'expérience.**

Le `CONTROL VECTOR` est la signature du joueur.

Le `RANDOMART` est la signature de la session / cible.

---

# 27. Photos

Le joueur peut prendre des photos depuis le flux vidéo.

Ce sont de **vraies captures du pipeline caméra du drone**, pas des screenshots propres du moteur.

Elles héritent donc :

- résolution ;
- ratio ;
- FOV ;
- qualité caméra ;
- analogique / numérique ;
- bruit ;
- perte de signal ;
- pluie ;
- brouillard ;
- optique.

Principe :

> **A photograph is a frame captured from the target's video pipeline.**

Une session peut contenir plusieurs captures.

---

# 28. Session Log

Le journal conserve :

- date ;
- zone ;
- cible ;
- résultat ;
- météo ;
- durée ;
- vitesse ;
- altitude ;
- Randomart ;
- photos ;
- commentaire.

Exemple :

```text
SESSION 00421

TOKYO / SECTOR 07
28.08.26 / 21:42

TARGET 042
RANDOMART
[...]

WEATHER
CLEAR
WIND 2.4 m/s
VIS 14.2 km

FLIGHT
18m 42s

CAPTURES
07

OPERATOR NOTE
"best signal so far"
```

### Revisiter

`REVISIT AREA` ne rejoue pas la session.

Cela :

- revient sur la zone ;
- réutilise le terrain si conservé ;
- utilise la météo actuelle ;
- génère une nouvelle cible ;
- génère une nouvelle situation.

---

# 29. Terrain et mémoire

Fin de session :

```text
LOCAL TERRAIN

TOKYO / SECTOR 07
412 MB

KEEP TERRAIN DATA?

[ KEEP ]
[ REMOVE ]
```

`KEEP` :

→ le terrain reste disponible.

`REMOVE` :

→ les données lourdes sont supprimées.

Mais la session peut rester dans le journal.

Donc :

> **Supprimer le terrain ne supprime pas le souvenir.**

---

# 30. Home — Operator Terminal

Après le bootstrapping, l'écran principal devient :

```text
FPVTP! // 0.97b
OPERATOR // NEO

LAST SESSION
TOKYO / SECTOR 07
TARGET 042

[ VIEW SESSION ]
[ REVISIT AREA ]

LOCAL TERRAIN
────────────────────────
TOKYO / SECTOR 07   412 MB
PARIS / EIFFEL      290 MB

[ OPEN ]

CONTROL VECTOR
↑ → ↓ ← ↑ ←

[ SHOW VECTOR ]

                    [ GLOBAL SCANNER ]

SESSION LOG
TARGET LOG
SETTINGS
OPERATOR
```

Footer :

```text
FPVTP! // LOCAL INSTALLATION
OPERATOR NEO
3 LOCAL AREAS
42 SESSIONS
17 TARGETS LOGGED
```

La Home est calme.

Elle ne doit pas devenir un dashboard.

---

# 31. Settings

Les anciens réglages météo, vent, pluie, brouillard et link ne doivent plus être présents comme options utilisateur.

Ils appartiennent désormais au monde et à la session.

`SETTINGS` contient uniquement ce qui relève réellement du joueur :

```text
CONTROLS
GAMEPAD / KEYBOARD
MOUSE
AUDIO
ACCESSIBILITY
VIDEO / PERFORMANCE
```

Et éventuellement :

```text
OPERATOR
CONTROL VECTOR
ACCOUNT
```

---

# 32. Avatar opérateur — futur

Un avatar ou un **Operator Randomart** pourra éventuellement être ajouté plus tard.

Il n'est pas nécessaire à la V1.

Le système d'identité doit d'abord fonctionner avec :

```text
OPERATOR NAME
CONTROL VECTOR
SESSION HISTORY
LOCAL TERRAIN
```

---

# 33. Comptes / local-first

L'expérience est attachée à l'opérateur.

Dans la phase de test, plusieurs opérateurs peuvent utiliser le même serveur :

```text
NEO
VEX
MIKHAIL
...
```

Mais chaque opérateur possède son propre état :

```text
identity
control vector
terrain cache
sessions
photos
comments
target history
world state
```

Le serveur partagé n'est donc qu'une commodité temporaire.

La cible finale reste :

> **chaque personne possède sa propre installation FPVTP! sur son ordinateur.**

Le Control Vector n'est jamais le mécanisme de connexion au compte.

Il est uniquement le rituel de prise de contrôle.

---

# 34. Son

### Le vol a une musique. (révisé — issue #122)

> **Décision révisée.** Cette section disait « Pas de musique pendant le vol ».
> Elle a été renversée par l'issue #122 : le jeu a une identité musicale, et
> elle est portée par le vol autant que par les menus. Ce qui suit est la règle
> en vigueur ; le reste de la section 34 (le vocabulaire d'interface clos, le
> système qui ne bipe pas) est inchangé.

Chaque famille de drone a son genre, avec un ADN commun : fin 90 / début 2000,
electronica, IDM, techno, trance. Pas de modern EDM, pas de musique de film.

| famille | genre |
|---|---|
| 5" FREESTYLE | electro / breakbeat — polyvalent, nerveux, libre |
| 5" RACE | hard techno — vitesse, concentration, pression |
| CINEWHOOP | electronica atmosphérique — observation, paysage |
| LONG RANGE | dub techno — distance, endurance, solitude |
| HEAVY 5" | industrial techno — masse, puissance, inertie |
| MICRO | trance — petit, vif, joueur |
| (menus) | ambiance froide et complotiste |

L'arc : la musique s'installe **sourdement** au lancement du HACK — filtrée,
lointaine, la musique de la pièce d'à côté. Elle se retire pendant le rituel,
qui garde sa culmination. Elle **explose au drop** sur le drone. Puis elle vit
avec le vol : son intensité suit ce que le pilote subit, pas seulement ce qu'il
fait. Au crash elle meurt à l'instant du choc, avec l'image. À la pose, elle
relâche.

**La musique ne dit jamais au joueur quelle catégorie il a reçue.** Elle lui en
donne une intuition, avant que l'écran ne nomme quoi que ce soit. C'est la forme
sonore de :

> You don't read the drone. You feel it.

### L'acoustique du lieu (issue #122)

Le monde répond. Ce n'est pas de la réverbération décorative : le retard, la
quantité et la couleur des réflexions suivent la géométrie réelle, mesurée par
les mêmes rayons que l'ombre de vent.

Raser une façade claque. Passer sous un pont referme. Monter ouvre le ciel et
tout s'assèche. C'est la sensation de proximité, et c'est le cœur du FPV.

Ce qu'on ne fait PAS : spatialiser en binaural. En FPV le drone est la caméra,
les moteurs sont solidaires de la tête — un HRTF sur une source qui ne bouge
jamais par rapport à l'auditeur ne dirait rien. Ce qui change en vol, c'est ce
que le monde renvoie.

Le vol appartient toujours à :

- moteurs ;
- vent ;
- pluie ;
- propwash ;
- impacts ;
- liaison radio ;
- signal vidéo.

### Interface

Très peu de sons, mais chacun doit être reconnaissable immédiatement.

Familles :

`SYSTEM`

→ boot, terrain ready, target found.

`LINK`

→ carrier, perte, reconnexion.

`RITUAL`

→ hack.

Le système ne doit pas biper à chaque clic.

Principe :

> **An event that doesn't need to be heard doesn't need a sound.**

---

# 35. Signature sonore du boot

Le son recherché est **le véritable son utilisé par un drone lors de son démarrage**, et non une simple imitation musicale ou un motif inventé.

La référence sonore est :

> `tututuuut tuuuuu-tuu`

Ce son doit être utilisé comme **signature authentique du démarrage du drone**, pas comme motif omniprésent.

Il peut également servir de référence pour le boot FPVTP!, avec un traitement synthétique ou filtré si nécessaire, tout en conservant son identité reconnaissable.

Mais :

- le crash n'en reprend pas le motif ;
- la perte de liaison reste réaliste ;
- la reconnexion possède son propre son de reconnexion.

---

# 36. Son des rituels

Les rituels utilisent une esthétique **demo scene / IDM expérimentale**.

Pas de chanson traditionnelle.

Plutôt :

- clicks ;
- pulses ;
- basses synthétiques ;
- séquences irrégulières ;
- glitch ;
- modulation ;
- montée ;
- impact final.

Le type de hack possède son identité sonore.

La durée reste :

```text
V1 ≈ 1 sec
V2 ≈ 2 sec
V3 ≈ 3 sec
V4 ≈ 4 sec
```

Puis :

**silence → moteur → vol.**

---

# 37. Voix

V1 :

> **aucune voix.**

Pas de narrateur.

Pas de voix de pirate.

Pas de commandes vocales.

L'éventuelle voix synthétique ou radio est repoussée à une version ultérieure.

---

# 38. Direction visuelle

### Interface quotidienne

DOS / Unix / hardware.

```text
┌─ AREA ANALYSIS ──────────────────────────────┐
│                                               │
│ TILES          88 × 74                       │
│ REQUESTS       6512                          │
│ SURFACE        1.82 km²                      │
│                                               │
└───────────────────────────────────────────────┘
```

Traits fins.

Angles droits.

Très peu d'ombres.

Pas de coins arrondis.

Pas de glassmorphism.

Pas de dashboard moderne.

### Couleurs de base

Noir / gris / blanc cassé.

Les couleurs d'état :

- vert ;
- jaune ;
- orange ;
- rouge.

Uniquement lorsqu'elles transmettent une information.

### Cyan / magenta

Réservés aux événements demo scene.

---

# 39. Typographie

Trois niveaux maximum :

### DISPLAY

Pour :

`FPVTP!`

`TARGET ACQUIRED`

`JACK IN`

### UI

Pour les titres :

`GLOBAL SCANNER`

`SESSION LOG`

### DATA

Pour :

```text
RSSI -63 dBm
WIND 2.4 m/s
BAT 15.2 V
```

Le langage typographique doit rester monospace / bitmap / compact.

---

# 40. ASCII

Trois usages.

### Information

```text
[+] SIGNAL FOUND
[!] LINK LOST
[*] TERRAIN READY
```

### Technique

```text
RX ───┤ FC ├── MOTOR
```

### Demo scene

Gros ASCII art uniquement pendant les événements.

---

# 41. Pixel art

Petite bibliothèque d'icônes :

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

Pas d'emoji.

Pas d'icônes Material Design.

---

# 42. CRT et image

Pas de filtre rétro global.

La photogrammétrie doit rester brute.

Le rendu FPV possède déjà :

- optique ;
- barillet ;
- aberration ;
- vignettage ;
- mouvement ;
- analogique / numérique ;
- brouillard ;
- pluie.

La sensation PS2 vient de la **matière naturelle du système**, pas d'un shader « PS2 ».

---

# 43. Le double système de rendu

Conceptuellement :

```text
WORLD
  ↓
DRONE CAMERA
  ↓
DRONE OSD
  ↓
VIDEO / LINK DEGRADATION
  ↓
FPVTP OSD
  ↓
LENS
  ↓
SCREEN
```

Le HUD FPVTP! est une couche locale.

Le HUD drone est une couche distante.

Cette séparation explique naturellement leurs collisions visuelles.

---

# 44. Principes anti-dérive

FPVThePlanet! ne doit pas devenir :

### Cyberpunk

Pas de néons permanents, pas de code vert, pas de ville noire et humide « pour faire hacker ».

### Y2K glossy

Pas de chrome généralisé, pas de plastique, pas de gradients permanents.

### Fake PS2

Pas de low-res artificiel appliqué partout.

### Glitch art

Pas de glitch permanent.

### Terminal pur

DOS/Unix est une grammaire, pas l'intégralité de l'interface.

### Dashboard moderne

Pas de cards modernes, métriques géantes, coins arrondis ou UI SaaS.

---

# 45. La règle maîtresse

> **FPVTP! is quiet by default, spectacular by interruption.**

L'interface quotidienne est austère.

Le monde est réel.

Le drone est imprévisible.

Le hacking est spectaculaire pendant quelques secondes.

Puis tout disparaît.

Le joueur reprend immédiatement les sticks.

---

# 46. État actuel / priorités

## VALIDÉ

- identité FPVTP!;
- esthétique 1998–2003 / PS2 ;
- hacker / cracker + demo scene ;
- UI DOS/Unix ;
- anglais intégral ;
- Global Scanner ;
- Leaflet + carte N&B ;
- acquisition réelle longue ;
- deuxième étape de sélection du drone ;
- drones variables ;
- météo persistante ;
- terrain local persistant ;
- drones non persistants ;
- crash = perte du drone ;
- atterrissage = fin propre ;
- Control Vector ;
- Randomart ;
- double HUD ;
- sessions ;
- photos ;
- commentaires ;
- son sans musique pendant le vol ;
- IDM / demo scene pour les rituels ;
- crew décoratif.

## À PROTOTYPER

- rendu exact de la carte monochrome ;
- meilleure utilisation du grid Leaflet si disponible ;
- interface `ACQUIRE AREA` ;
- génération des signaux ;
- six archétypes ;
- génération cohérente des builds ;
- quatre familles / six familles de hacks documentaires ;
- 4 variantes de rituels par hack ;
- génération des entry states ;
- double OSD ;
- génération des Randomarts ;
- météo 7 jours ;
- système de photos ;
- persistance opérateur.

## PLUS TARD

- simulation technique plus profonde des protocoles ;
- lore construit autour de Jensen ;
- avatar / Operator Randomart ;
- éventuellement davantage de membres du crew ;
- davantage de familles de drones ;
- couches cartographiques supplémentaires ;
- fonctions sociales éventuelles ;
- voix / radio parlée ;
- lore plus profond dans le dépôt open source.

---

# 47. La phrase qui résume FPVThePlanet!

> **Choose a place. Acquire the terrain. Find a signal. Take the sticks.**

Et la philosophie du système :

> **The world persists. The machine doesn't.**

Enfin, le ton général :

> **A clandestine FPV reverse-engineering tool from an alternate 2001, built by obsessive hackers who took radio, flight and software much too seriously.**
