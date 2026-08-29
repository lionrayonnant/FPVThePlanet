# Plan — Intro demoscene + explosion des rituels (issues #106, #107)

Deux chantiers audio/visuels validés par l'utilisateur le 2026-08-29.
Branche `intro-rituals-audio`, worktree `.claude/worktrees/intro-rituals-audio`.

## Global Constraints

- Tout est SYNTHÉTISÉ (Web Audio), aucun échantillon chargé, aucune voix parlée (Bible §37).
- Le vocabulaire sonore est CLOS et vérifié par `sim/tools/ui-audio-selftest.mjs` (sweep de src/) : toute extension passe par `UI_EVENTS`/le modèle pur, jamais par un `play()` dynamique.
- Modèles purs dans `sim/tools/*-model.mjs` : AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Le rendu vit dans `sim/src/`.
- Écrans clients (`intro.js`, `ritual.js`) : aucun import Three/Rapier/physics ; jamais importés par le moteur.
- Palette demo (cyan, magenta, violet, electric blue) réservée aux événements spectaculaires — l'intro et le rituel en sont ; le reste de l'UI reste calme (Bible §19, roadmap PHASE 19).
- Identité sonore PAR FAMILLE de hack conservée (Bible §36) : la variante change durée/étalement, jamais la suite de voix.
- Style du code existant : indentation tabs, commentaires en français expliquant le POURQUOI, mêmes idiomes (`_shot`, une seule source de bruit mémorisée, programmation d'un coup sur l'horloge audio).
- `cd sim && npm run selftest:operator` doit passer à la fin de chaque tâche.
- TDD : étendre les selftests existants (`ui-audio-selftest.mjs`, `ui-audio-render-selftest.mjs`) et en créer pour tout nouveau modèle pur.

## Task 1 — Rituels : tension pendant la saisie + explosion en couches stéréo (#107)

Fichiers : `sim/tools/ui-audio-model.mjs`, `sim/src/ui-audio.js`, `sim/src/ritual.js`, selftests associés.

**Tension (saisie du vecteur)** :
- Nouvelle API de rendu `uiAudio.ritualTension(k)` (k = progression 0..1 de la saisie), même famille d'idiome que `setLinkQuality` : une branche construite au premier appel du rituel, seuls les AudioParam bougent ensuite, démontée/tue à `ritualTension(0)` + fin du rituel.
- Sonorité : riser — bruit filtré (bandpass qui monte en fréquence avec k) + pulsation (LFO ou pulse dont le tempo accélère avec k). Les constantes de mapping (plages de fréquences, gains, tau) vivent dans le modèle pur (`RITUAL_TENSION` exporté) pour rester testables.
- `ritual.js` : chaque flèche correcte → `ritualTension(typed.length / vector.length)` ; mismatch → retombée à 0 (audible, pas un mute sec) ; `startBurst()` → coupe la tension et lance l'explosion.

**Explosion (complétion)** :
- Nouvelles voix dans le modèle : `blast` (souffle large bande : bruit + lowpass qui chute) et support d'un champ `pan` (-1..1) sur tout événement, rendu via `StereoPannerNode`.
- Partitions `RITUAL_SCORES` retravaillées : garder l'identité de famille sur la première moitié, puis densifier la fin — montée (sweep + accélération), détonation en couches (sub `impact` plus grave et plus fort + `blast`), puis « shrapnels » : clicks/glitchs éparpillés APRÈS l'impact avec des `pan` répartis sur tout le champ stéréo. Chaque famille garde ses timbres, l'explosion part « dans tous les sens ».
- `scoreFor()` inchangé dans son contrat (at normalisé → atMs), il transporte `pan`.
- Selftests : nouvelles voix dans `VOICES`, `pan` transporté, tension = modèle pur testé (mapping monotone), rendu : la branche tension ne crée pas de nœud par appel, l'explosion atteint la destination.

## Task 2 — Intro demoscene au lancement (#106)

Fichiers : nouveaux `sim/tools/intro-model.mjs`, `sim/tools/intro-selftest.mjs`, `sim/src/intro.js` ; modifiés `sim/tools/ui-audio-model.mjs` (+`INTRO` au vocabulaire, `INTRO_SCORE`), `sim/src/ui-audio.js` (`playIntro()`), `sim/src/main.js` (wiring), `sim/src/style.css`, `sim/tools/ui-audio-selftest.mjs`, `package.json` (ajout de intro-selftest à selftest:operator).

**Modèle pur (`intro-model.mjs`)** : timeline de l'intro — phases nommées avec durées (ex. reveal logo ≈1.5 s, plasma/raster+scrolltext ≈4 s, résolution ≈1.5 s ; total ~7 s), sémantique de skip (skippable à tout instant, le skip saute à la résolution), constantes exportées et testées.

**Visuel (`intro.js`)** : overlay plein écran monté par `main.js` avant le Home.
- Écran d'attente `FPVTP! // PRESS ANY KEY` (résout la contrainte de geste utilisateur pour l'AudioContext). Style calme (palette UI).
- Au geste : intro cracktro ~7 s — logo FPVTP! ASCII sur sinus-scroll (déformation verticale par colonne), raster bars/plasma en palette demo, scrolltext horizontal type greetings (« FPVTP! CREW PRESENTS… »). Réutiliser les primitives de `hack-grammars.js` (`RITUAL_PRIMITIVES`) quand ça colle, sinon rAF + pre/CSS dans le même esprit.
- N'importe quelle touche/clic pendant l'intro → skip net vers la fin.
- Promise résolue à la fin → `main.js` enchaîne sur le flux existant.

**Audio** : `INTRO` ajouté au vocabulaire clos ; `INTRO_SCORE` dans le modèle — séquence chiptune/IDM synthétisée (arpèges + basse pulse + clicks percussifs, voix existantes du rendu), ~5.5 s, qui se RÉSOUT sur la `BOOT_SIGNATURE` existante (les 5 notes concluent l'intro). Programmée d'un coup sur l'horloge audio. Skip → coupe la partition (gain master de l'intro à 0 rapide) et joue immédiatement la signature de boot seule.

**Wiring `main.js`** : si `?scene=` est présent → aucun changement (bypass total, `armBoot()` comme aujourd'hui). Sinon : l'intro remplace `armBoot()` (c'est elle qui fait jouer la signature de boot à sa résolution — pas deux fois). L'intro passe AVANT la résolution de l'opérateur/Home.

**Selftests** : timeline/skip du modèle pur ; vocabulaire à 8 événements ; INTRO atteint la destination ; sweep de src/ toujours vert.
