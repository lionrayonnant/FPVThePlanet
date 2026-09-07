# FPVThePlanet!

Un simulateur de drone FPV qui vole au-dessus de vraies villes, dans le
navigateur. La géométrie et les textures sont de la photogrammétrie 3D — pas un
décor modélisé à la main — et le pilotage passe par un modèle de vol de quad
Betaflight, manette comprise.

Autour du vol, un terminal d'opérateur : on choisit un terrain, on scanne une
cible, on décroche un accès, on vole, on rentre, et la session part dans une
archive qui se relit.

```bash
cd sim
npm install
npm run dev          # http://localhost:5173
```

Le jeu est écrit en JavaScript sans transpileur : Three.js pour le rendu,
Rapier (WASM) pour la physique, Vite pour le développement et le build. Le
serveur est du `node:http` nu, sans une seule dépendance.

## Jouer sans Vite

`npm run dev` est l'environnement de développement. Un build se sert avec le
serveur autonome, qui porte l'API du jeu et les fichiers :

```bash
cd sim
npm run build
node server/index.mjs --data ~/.local/share/fpvtp --dist dist --open
```

Il écoute sur `127.0.0.1` et refuse une autre adresse tant qu'on ne lui passe
pas `--mode shared` — auquel cas il réclame une clé d'opérateur à chaque
requête. `deploy/` contient de quoi le mettre derrière Caddy sur un serveur, et
`sim/electron/` de quoi en faire une application installable.

## D'où vient le terrain

Les tuiles viennent de Google Earth, par son protocole interne `rocktree`
(`sim/tools/lib/providers/google-earth.mjs`). En mode LIVE, c'est le navigateur
du joueur qui va les chercher directement ; rien ne transite par le serveur.

L'**acquisition** — télécharger une zone, la décoder et l'écrire sur disque
comme terrain jouable — est une autre affaire, et elle est **fermée par
défaut**. Elle ne s'active qu'avec `FPVTP_ACQUIRE=1` dans l'environnement, et
jamais en `--mode shared`, quoi qu'il arrive. Ni l'intégration continue ni les
applications construites pour être distribuées ne posent cette variable.

## Où lire la suite

| | |
|---|---|
| [`sim/README.md`](sim/README.md) | l'essentiel : commandes, ajout de cartes, pipeline de pré-traitement, modèle de vol, réglage du PID |
| [`sim/HANDOFF.md`](sim/HANDOFF.md) | ce qui est vérifié et ce qui ne l'est pas, à un instant donné |
| [`sim/docs/`](sim/docs/) | la direction artistique, la feuille de route, et les spécifications de conception |
| [`CHANGELOG.md`](CHANGELOG.md) | ce qui a changé, version par version |
| [`deploy/README.md`](deploy/README.md) | installer le serveur sur une machine |

## Licence

[GNU AGPL-3.0-only](LICENSE). En clair : le code est libre, et quiconque en
héberge une version modifiée pour d'autres personnes doit en publier les
sources.

Ce qui est embarqué et vient d'ailleurs, avec sa propre licence :

- [Three.js](https://threejs.org/), [Rapier](https://rapier.rs/),
  [Leaflet](https://leafletjs.com/) et
  [Leaflet-Geoman](https://geoman.io/leaflet-geoman) — voir `sim/package.json` ;
- les fontes **IBM Plex Mono** et **Departure Mono**, sous SIL Open Font
  License, dont le texte voyage avec elles dans `sim/public/fonts/` ;
- la musique de `sim/public/music/`, générée pour ce projet ;
- l'imagerie de terrain reste © Google, et n'est jamais redistribuée : elle
  est téléchargée par chaque installation, et rien de cuit n'est publié ici.
