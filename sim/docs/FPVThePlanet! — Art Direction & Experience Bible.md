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
13. Premier lancement — Bootstrapping · 15. Acquisition d'une cible ·
16. Hacking · 17. Types de hacks · 19. Demo Scene · 20. Entry State ·
21. Profils de drones · 22. Ce qui est connu du drone · 23. Double HUD ·
24. Perte du signal et crash · 25. Fin propre d'une session · 26. Randomart · 27. Photos ·
28. Session Log · 29. Terrain et mémoire · 30. Home — Operator Terminal · 31. Settings ·
32. Avatar opérateur — futur · 33. Comptes / local-first · 34. Son ·
35. Signature sonore du boot · 37. Voix ·
38. Direction visuelle · 39. Typographie · 40. ASCII · 41. Pixel art · 42. CRT et image ·
43. Le double système de rendu · 44. Principes anti-dérive · 45. La règle maîtresse ·
46. État actuel / priorités · 47. La phrase qui résume FPVThePlanet! ·
48. BENCH — le banc

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

> **Révisé 2026-09-08 (D16) — un briefing existe.** Il vit avant le premier vol
> et dans `SETTINGS`, jamais à l'entrée en vol. Il ne dit toujours pas quoi
> faire : il énonce ce qu'une chose est et ce qu'une touche fait, une fois,
> puis il s'efface. Le pilier tient — c'est de l'information, pas de
> l'assistance.

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

# 15. Acquisition d'une cible

Une fois le terrain acquis :

```text
TARGET SCAN

SIGNALS DETECTED

01   -54 dBm   ANALOG    CINEWHOOP
02   -59 dBm   UNKNOWN   5"
03   -67 dBm   DIGITAL   LONG RANGE
04   -71 dBm   UNKNOWN   5"
```

Le joueur choisit, et le choix EST l'activation de la ligne : un seul écran,
une seule frappe.

> **Révision (issue #49) — la fiche pré-hack est devenue la ligne.** Le premier
> jet ouvrait un second écran, `TARGET 02`, avec ses sept champs et un
> `CONFIRM`. Quatre de ces champs — `LOCATION KNOWN`, `DEVICE PARTIAL`,
> `CONTROL UNKNOWN`, `FLIGHT STATE UNKNOWN` — portaient la même valeur pour
> toutes les cibles de tous les scans : ils décrivaient le jeu, pas le signal,
> et n'ont donc jamais départagé deux choix. Un cinquième, `CONDITIONS`, était
> déjà lisible en tête de la liste. Ce qui restait — le signal, le mode vidéo,
> le bucket du device — tient sur la ligne, où il se compare d'un coup d'œil au
> lieu de demander un aller-retour par cible.
>
> Ce qui ne change pas : les trois niveaux ci-dessous. Le device reste un `EST.`
> et le mode vidéo non mesuré reste `UNKNOWN` nu. Un cluster (issue #29) garde
> ses trois mentions — `(STRONGEST OF GROUP)`, `MESH — MULTIPLE EMITTERS`,
> `COUNT UNKNOWN` — et ne révèle toujours ni la machine ni la taille du groupe.

> **Révision (2026-09-09, issue #33) — le hack se termine par `[ JACK IN ]`, pas
> par un secret à retaper.** L'acquisition se clôturait sur un CONTROL VECTOR :
> une suite de 4 à 8 flèches que le joueur définissait une fois et devait
> retaper de mémoire à **chaque** cible. Le rapport qui a ouvert #33 disait
> « la page de hack peut se figer et rendre confus l'utilisateur » ; la lecture
> du code donnait pire — l'écran n'écoutait que les flèches, ne posait aucun
> Échap, et un joueur qui avait oublié son vecteur restait bloqué jusqu'au
> rechargement de la page, avec toute la boucle de jeu suspendue derrière lui.
> Le geste ne demandait par ailleurs aucune compétence de pilotage : mémoriser
> un secret hors du jeu, pour un coût payé à chaque acquisition. Le CONTROL
> VECTOR est retiré entièrement. L'acquisition se termine désormais sur un
> bouton unique, `[ JACK IN ]`, avec `[ESC] ABORT` monté dès l'affichage de
> l'écran de hack — utilisable pendant tout le chargement, ce qui répare aussi
> l'absence de sortie relevée dans le même diagnostic.

Avant le hack, FPVTP! n'affiche que ce qu'il sait réellement. Trois niveaux
d'information :

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

Chaque famille possède sa propre grammaire visuelle.

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

# 19. Demo Scene

*(révisée le 2026-09-09, issue #33 — voir la note de révision en §15 : la demo
scene ne décore plus l'acquisition, elle vit entièrement dans l'intro.)*

La demo scene est **événementielle** : elle se joue une fois par lancement, à
l'écran `PRESS ANY KEY` (`src/intro.js`), et nulle part ailleurs.

Pas de cyan/magenta en permanence.

Pas de glitch permanent.

Pas de HUD psychédélique.

Les couleurs exceptionnelles — cyan, magenta, violet, bleu électrique — n'ont
plus qu'un seul porteur : l'intro. Elles ne reviennent ni au hack, ni à
l'acquisition d'une cible, ni à aucun autre écran : `[ JACK IN ]` est un bouton
de terminal ordinaire, pas un événement demo scene.

La règle :

> **Une intro, une fois, quelques secondes de folie, puis le calme pour tout
> le reste de la session.**

Cet événement doit provoquer une **montée d'adrénaline avant d'entrer dans le
jeu** — pas avant chaque pilotage.

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

# 22. Ce qui est connu du drone (complété — issue #264)

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

> **Révision (issue #264) — et par l'image.** Les deux hélices avant du drone
> piloté sont dans le champ, comme sur toute image FPV réelle, et elles tournent
> au régime des vrais moteurs : le tangage les bouge ensemble, le lacet et le
> roulis les séparent. C'est un troisième canal d'apprentissage, sans une ligne
> d'interface de plus — il ne nomme pas l'axe, il donne la machine à sentir.
>
> Ce qu'elles occupent est borné, et la borne est mesurée famille par famille,
> jamais posée à la main : les **hélices** au plus **8 % de l'image**, hauteur
> atteinte **au plus 50 % du cadre au pire tirage de caméra, 45 % en médiane**.
> La MACHINE, elle, occupe davantage — les bras, les moteurs et le carénage
> sont dans le cadre eux aussi — et cette part-là est une **signature de
> famille**, pas un réglage : 8 % sur un long range, 14 % sur un freestyle,
> 35 % sur un cinewhoop, 44 % sur un toothpick. Un quad caréné montre son
> carénage ; aucun montage ne l'enlève sans faire disparaître les hélices avec.
> Ce qui est garanti pour toutes, c'est que la **moitié haute du cadre reste
> libre** : on voit toujours où l'on va.
>
> Ce plafond de moitié n'est pas un relâchement : le plan d'hélice a un
> horizon, et pour une caméra plate cet horizon est exactement au milieu du
> cadre. Les hélices vivent dans ce plan — aucune hauteur d'objectif ne les
> fait passer dessous, elle ne fait que les en écarter.

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

# 24. Perte du signal et crash (révisé — issue #264)

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

> **Révision (issue #264).** Après `SESSION TERMINATED`, le portrait fil de fer
> de la machine perdue apparaît. Ce n'est pas une récompense et pas un écran de
> mort : c'est ce qu'il reste. La collection naît de la perte.
>
> Ce qui ne change pas : `POST-FLIGHT ANALYSIS` reste réservé aux sessions
> LANDED, la musique reste coupée net au choc (§34, #122), et la timeline garde
> ses temps — le portrait s'insère à 4,0 s, la sortie reste à 4,6 s. Il ne
> déplace rien.
>
> **Révision 2026-09-08 (D9).** L'atterrissage est retiré : il n'y a plus de
> session LANDED, donc plus de `POST-FLIGHT ANALYSIS` du tout. Un vol se
> termine par un crash, une sortie de zone ou le pilote qui coupe le lien
> (K tenue). Le reste du paragraphe tient : le portrait, la musique coupée net,
> la timeline.

Le sentiment recherché :

> **« Je viens de perdre une machine distante. »**

Le terrain reste conservé.

Le drone, lui, est perdu.

---

# 25. Fin propre d'une session

> **Révision 2026-09-08 (D9).** Cette section ne décrit plus le jeu :
> l'atterrissage est retiré. Il n'y a plus de désarmement, plus de verdict
> `LANDED`, plus d'écran de fin propre. Un vol se termine par un crash, une
> sortie de zone ou le pilote qui coupe le lien (K tenue) — trois façons de
> perdre la machine, jamais de la ramener. Ce qui suit reste pour mémoire.

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

Il est associé à la **cible** : une machine = une empreinte. La graine est
celle de l'exemplaire, celle-là même qui décide de sa famille, de sa livrée,
de son cadre et de ses PID. Retrouver la même machine, c'est retrouver le même
art.

Il apparaît :

- **à l'acquisition** : après `[ JACK IN ]`, le fou trace l'empreinte sous les
  yeux de l'opérateur, puis `CONTROL ACQUIRED` ;
- **au crash** : figé, à côté du portrait de la machine perdue ;
- **dans les archives** : dans la fiche de session, à la place du randomart de
  session, qui a disparu.

Il n'apparaît PAS sur le `TARGET SCAN` : avant le vol, on n'affiche que ce qui
est réellement connu (§15), et l'empreinte d'un exemplaire n'en fait pas
partie. On ne choisit pas un signal sur son art.

Le Randomart n'est pas seulement décoratif :

> **c'est l'empreinte visuelle de l'expérience.**

*(Révision 2026-09-10, issue #57 : la section décrivait un art « associé à la
session / cible » et laissait les deux lectures ouvertes. Elle est tranchée
sur la cible, et la liste des apparitions est celle qui est implémentée.)*

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
ACCOUNT
```

**Construit (2026-09-08, D14/D16).** Le panneau a quatre onglets, et rien de
plus :

```text
CONTROLLER   manette, axes, calibrage
KEYBOARD     le mappage clavier, remappable
AUDIO        volume, musique, luminosité
SYSTEM       vue, lien, [ REPLAY BRIEFING ], [ RESET SETTINGS ], build
```

Aucun curseur de monde n'y est revenu.

---

# 32. Avatar opérateur — futur

Un avatar ou un **Operator Randomart** pourra éventuellement être ajouté plus tard.

Il n'est pas nécessaire à la V1.

Le système d'identité doit d'abord fonctionner avec :

```text
OPERATOR NAME
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
lointaine, la musique de la pièce d'à côté. Elle se retire pendant l'analyse
automatique, qui garde sa culmination jusqu'à `[ JACK IN ]`. Elle **explose au
drop** sur le drone. Puis elle vit
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

Le hack lui-même est silencieux : ni son propre vocabulaire, ni musique
pendant l'analyse (la musique s'y installe sourdement, ci-dessus, mais ne
« sonne » pas). Le vocabulaire d'interface reste clos à ces deux familles.

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
- atterrissage = fin propre ; *(retiré le 2026-09-08, D9 : un vol se termine
  par un crash, une sortie de zone ou un lien coupé)*
- Control Vector ; *(retiré le 2026-09-09, issue #33 : mémoriser un secret
  hors du jeu et le retaper à chaque acquisition, sans reject ni Échap — voir
  la note de révision en §15. Remplacé par un bouton unique, `[ JACK IN ]`)*
- Randomart ;
- double HUD ;
- sessions ;
- photos ;
- commentaires ;
- son sans musique pendant le vol ;
- IDM / demo scene pour l'intro *(recentré le 2026-09-09, issue #33 : la demo
  scene ne décorait plus que l'acquisition/rituel, retirée avec lui — voir §19)*;
- crew décoratif.
- BENCH — le banc, seconde voie du jeu (§48).

## À PROTOTYPER

- rendu exact de la carte monochrome ;
- meilleure utilisation du grid Leaflet si disponible ;
- interface `ACQUIRE AREA` ;
- génération des signaux ;
- six archétypes ;
- génération cohérente des builds ;
- quatre familles / six familles de hacks documentaires ;
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

---

# 48. BENCH — le banc

### Le problème

Tout ce qui précède décrit **une** boucle, et cette boucle est faite de
contraintes : le drone est tiré au sort, la météo appartient au monde, le crash
est terminal, et les réglages qui touchent au monde ont quitté `SETTINGS`.

C'est juste, et ça doit le rester. Mais il manquait l'autre moitié : un endroit
où l'opérateur a le contrôle total, sans contrainte ni frustration.

### Pourquoi un banc existe dans cet univers

FPVTP! est un outil de reverse engineering écrit par des hackers hardware. Un
tel outil a **toujours** un banc : le montage local sur lequel on teste la
chaîne d'interception contre une cible synthétique, avant de la pointer sur une
vraie. C'est la pratique réelle de l'époque, RF comprise — on ne débugge pas son
stack sur une cible qu'on peut griller.

Le banc synthétise donc la cible localement :

```text
NO TARGET       il n'y a personne au bout — un modèle, pas une machine
NO LINK         le flux revient de ta propre installation
NO HACK         on ne s'introduit pas dans son propre banc
NO LOSS         rien de distant n'existe, donc rien ne peut être perdu
NOTHING LOGGED  rien ne s'est passé dans le monde, donc rien n'est écrit
```

Les cinq lignes sont **la même phrase**. C'est simultanément la fiction et la
règle technique, et c'est ce qui empêche le banc d'être une dérogation.

### Ce que le banc ne contredit pas

- **§2.2 — Terrain persistent, flights ephemeral.** Non contredit, poussé à sa
  limite : le vol au banc est maximalement éphémère, il ne laisse *rien*.
- **§24 — pas de GAME OVER, le crash perd la machine.** Non contredit : il n'y a
  aucune machine distante à perdre. « Le drone est détruit » suppose un drone
  qui appartient à quelqu'un. Le choc, lui, reste un choc — la physique ne se
  négocie pas, la machine encaisse et culbute. C'est la *conséquence* qui
  n'existe pas, pas l'impact.
- **§31 — SETTINGS.** Non contredit, et c'est le point important : les curseurs
  météo retirés de `SETTINGS` **n'y reviennent pas**. Ils vivent au banc, qui est
  le seul endroit où la météo n'appartient pas au monde.
- **§47 — The world persists. The machine doesn't.** Au banc il n'y a ni monde
  ni machine : il y a un modèle.

### La structure

La racine du jeu devient :

```text
OPERATOR // NEO

SELECT OPERATION MODE

[ FIELD ]
acquire terrain · find a signal
take a machine that is not yours

[ BENCH ]
your airframe · your conditions
nothing to lose
```

Le curseur se pose sur le dernier mode utilisé : un joueur FIELD fait une touche
de plus par lancement, pas un choix de plus. La Home n'est donc plus la racine —
elle remonte ici.

### Le banc

```text
BENCH

NO TARGET   NO LINK   NO HACK   NO LOSS

AIRFRAME ....... 5" FREESTYLE
BUILD .......... NOMINAL          [ INDIVIDUAL · ROLL ]
TERRAIN ........ PARISTEST        [ LIVE — ANYWHERE ]
ENTRY .......... IDLE ON GROUND   [ COMFORTABLE … HOLY SHIT ]
FENCE .......... ON
TIME ........... 14:30
WIND ........... 0.0 m/s  000°  ×1.0
RAIN ........... 0.0 mm/h
FOG ............ VIS 25.0 km
CLOUD .......... 0 %
LINK ........... LOOPBACK
BATTERY ........ REAL             [ HELD ]

NOTHING HERE IS LOGGED.

[ SPIN UP ]
```

Le même écran s'ouvre **pendant** le vol (touche `B`), et chaque changement part
tout de suite. Un réglage doit se comporter pareil avant et pendant, sinon le
banc ment sur ce qu'il règle.

### Deux principes du banc

**Il informe, il n'interdit pas.** Le banc a exactement un refus : pas de terrain
du tout. Tout le reste est un avertissement. Couper la clôture sur une scène
pré-cuite affiche `FENCE OFF — TERRAIN ENDS AT THE EDGE OF THE ACQUIRED AREA`,
et laisse décoller. C'est le §2.1 appliqué à l'opérateur au lieu du monde.

**Rien n'y est rejeté.** Une valeur hors bornes est ramenée, une configuration
corrompue redevient jouable. Le banc est l'endroit sans frustration : il n'a pas
le droit de refuser d'ouvrir parce qu'une clé lui déplaît.

Et la météo du banc n'obéit pas aux règles de cohérence d'un bulletin — « le vent
chasse le brouillard », « il ne pleut pas sous un ciel bleu ». Elles sont justes
pour un monde et fausses pour un banc : une purée de pois dans une tempête est
précisément le genre de chose qu'on vient y tester. La *traduction*, elle, est la
même que celle du monde : à 12 m/s, le banc et FIELD se pilotent identiquement.

### Ce qui persiste, et ce qui ne persiste pas

La **configuration** du banc persiste ; ce qui s'y est **passé**, non. Reposer
douze réglages à chaque lancement serait exactement la frustration qu'on
supprime. Rien de ce qui est stocké ne dit qu'un vol a eu lieu.

Une photo prise au banc part directement sur le disque de l'opérateur —
`FRAME DUMPED` — et nulle part ailleurs. « Nothing here is logged » parle de ce
que FPVTP! enregistre, pas de ce que tu emportes ; et dumper une frame dans un
fichier est de toute façon le geste juste au banc, là où le vol de terrain rédige
un rapport.

### La phrase du banc

> **Your airframe. Your conditions. Nothing to lose, and nothing to show for it.**
