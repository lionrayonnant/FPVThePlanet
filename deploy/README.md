# Préparer un VPS pour FPVTP!

Checklist **humaine**, à suivre **une seule fois** sur une machine neuve.
Ce n'est pas un script de provisionnement : chaque étape se tape à la main,
dans l'ordre, en root. Elle est écrite pour quelqu'un qui ne connaît pas le
projet — rien n'y est laissé à deviner.

Ensuite, chaque nouvelle version se livre en une commande :
`sudo /opt/fpvtp/deploy.sh v0.2.0`.

Le design de référence est
`sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md`
(section « D4 »).

## Ce que la machine fait tourner

| quoi | où |
|---|---|
| le serveur de jeu (Node) | `fpvtp.service`, écoute sur `127.0.0.1:8080` |
| le frontal TLS | Caddy, `fpvtp.example.org` → le port 8080 |
| les installeurs de bureau | Caddy, `updates.fpvtp.example.org` → `/srv/fpvtp-updates` |
| le programme | `/opt/fpvtp/releases/<tag>`, avec `/opt/fpvtp/current` qui pointe la version active |
| les données | `/var/lib/fpvtp` (jamais écrasées par une mise à jour) |
| le jeton GitHub | `/etc/fpvtp/token` |

Le serveur tourne en **mode `shared`**. Deux conséquences à connaître :

- il n'acquiert **jamais** de terrain. `FPVTP_ACQUIRE` n'est pas posée dans
  l'unité systemd et ne doit jamais l'être : le VPS ne sert que du vol LIVE,
  dont la géométrie et les textures sont téléchargées par le navigateur du
  joueur, sans passer par cette machine ;
- il ne stocke donc aucune scène. `/var/lib/fpvtp/scenes` reste vide en
  permanence.

## Prérequis

- Debian ou Ubuntu récente (les commandes ci-dessous sont pour `apt`).
- Deux noms DNS pointant sur l'IP de la machine, par exemple
  `fpvtp.example.org` et `updates.fpvtp.example.org`.
- Les ports 80 et 443 ouverts (Caddy en a besoin pour obtenir les
  certificats). Le port 8080 doit rester **fermé** vers l'extérieur.
- Un jeton GitHub en lecture seule sur `lionrayonnant/FPVThePlanet`, tant que
  le dépôt est privé. Une fois public, l'API des releases répond sans
  authentification : le jeton devient inutile, mais `deploy.sh` le réclame
  encore — poser un jeton vide ne suffira pas, il faudra retirer le contrôle
  (fine-grained token, permission « Contents: Read »).

Outils utilisés par `deploy.sh` : `curl`, `jq`, `tar`, `unzip`, `systemctl`,
`install`. Installez ce qui manque :

```sh
apt update
apt install -y curl jq tar unzip
```

## 1. L'utilisateur système

Un compte sans shell ni maison : il ne sert qu'à faire tourner le service.

```sh
adduser --system --group --no-create-home --shell /usr/sbin/nologin fpvtp
```

## 2. Les répertoires

```sh
# Le programme. Il appartient à root : le service le lit, il ne l'écrit pas.
install -d -o root  -m 0755 /opt/fpvtp
install -d -o root  -m 0755 /opt/fpvtp/releases

# Les données. C'est le seul endroit où le service écrit.
install -d -o fpvtp -g fpvtp -m 0750 /var/lib/fpvtp

# Les installeurs de bureau, servis publiquement par Caddy.
install -d -o root -m 0755 /srv/fpvtp-updates

# Les journaux de Caddy.
install -d -o caddy -g caddy -m 0750 /var/log/caddy   # après l'étape 4
```

## 3. Le jeton GitHub

Le dépôt est privé : sans ce fichier, `deploy.sh` ne peut rien télécharger.
Il s'arrête alors avec un message explicite, il ne plante pas de façon opaque.

```sh
install -d -o root -g root -m 0700 /etc/fpvtp
printf '%s' 'github_pat_xxxxxxxxxxxx' > /etc/fpvtp/token
chmod 0600 /etc/fpvtp/token
chown root:root /etc/fpvtp/token
```

Le fichier est lu par `deploy.sh`, qui tourne en root : le compte `fpvtp`
n'y a pas accès, et c'est voulu.

## 4. Caddy

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Puis installez la configuration de ce répertoire, en remplaçant les deux
`example.org` par le vrai domaine :

```sh
cp deploy/Caddyfile /etc/caddy/Caddyfile
$EDITOR /etc/caddy/Caddyfile          # les deux noms de domaine
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

`caddy validate` doit dire `Valid configuration` avant d'aller plus loin.

## 5. Le service

```sh
cp deploy/fpvtp.service /etc/systemd/system/fpvtp.service
systemctl daemon-reload
systemctl enable fpvtp        # au démarrage de la machine
```

Ne le démarrez pas encore : `/opt/fpvtp/current` n'existe pas tant qu'aucune
version n'a été livrée. C'est `deploy.sh` qui s'en charge.

## 6. Le script de livraison

```sh
cp deploy/deploy.sh /opt/fpvtp/deploy.sh
chmod 0755 /opt/fpvtp/deploy.sh
```

## 7. La première livraison

```sh
sudo /opt/fpvtp/deploy.sh v0.2.0
```

Le script télécharge la release, la décompresse, bascule
`/opt/fpvtp/current`, redémarre le service, vérifie qu'il répond, puis dépose
les installeurs de bureau dans `/srv/fpvtp-updates`.

Il affiche, au moment de la bascule, le chemin de la release précédente :
revenir en arrière est toujours

```sh
ln -sfn /opt/fpvtp/releases/<tag précédent> /opt/fpvtp/current
systemctl restart fpvtp
```

Le déclenchement reste **manuel** pour l'instant : on lance `deploy.sh` en
SSH, à la main. Une étape `deploy` automatique dans
`.github/workflows/release.yml` (conditionnée à des secrets `DEPLOY_HOST` /
`DEPLOY_KEY`) viendra **après** qu'une première livraison manuelle aura
réussi — pas avant, parce que `release.yml` lui-même n'a encore jamais tourné
sur un runner.

## 8. Les opérateurs existants (facultatif)

Pour reprendre des sessions déjà jouées en local, copiez leur état :

```sh
rsync -a sim/operator-state/ root@vps:/var/lib/fpvtp/operator-state/
chown -R fpvtp:fpvtp /var/lib/fpvtp/operator-state
```

En mode `shared`, un opérateur sans clé est inutilisable tant qu'on ne lui en
a pas généré une — c'est le cas de tous les fichiers d'avant la tranche T3.
Depuis le répertoire du programme :

```sh
sudo -u fpvtp /opt/fpvtp/current/node/bin/node \
  /opt/fpvtp/current/app/server/index.mjs key <operatorId>
```

La clé s'affiche **une seule fois** : transmettez-la à la personne concernée,
elle la saisira sur l'écran `OPERATOR KEY`. Relancer la commande en délivre
une neuve et invalide la précédente. C'est aussi la seule voie de
récupération quand quelqu'un perd la sienne : il n'y a ni mot de passe, ni
adresse e-mail, ni réinitialisation en libre service.

---

## Le runtime Node, et la forme de l'archive

`fpvtp.service` lance `/opt/fpvtp/current/node/bin/node` avec
`/opt/fpvtp/current/app` comme répertoire de travail. L'asset `linux-x64`
attendu par `deploy.sh` a donc cette forme :

```
<archive>/
  app/          server/ tools/ src/ dist/ package.json
  node/bin/node
```

**C'est ce que `.github/workflows/release.yml` produit** depuis l'intégration
des tranches T2-T4 : l'étape « Archive du serveur pour le VPS » copie
`server/ tools/ src/ dist/ package.json` dans `app/`, télécharge le tarball
officiel de la version de Node qui vient de faire passer les selftests, et
publie le tout sous le nom `fpvtp-server-<tag>-linux-x64.tar.gz`. L'ancien
`fpvtp-sim-<tag>.zip` (le `dist/` seul) reste attaché à la Release, mais ce
n'est pas lui que `deploy.sh` installe.

**Aucun `npm install` sur le VPS, et c'est voulu** : le serveur n'a besoin
d'aucune dépendance npm pour démarrer — mesuré le 2026-09-07 sur une archive
construite exactement comme celle de la CI, **sans `node_modules`** :

```
FPVTP! v0.0.0 — mode shared — acquisition fermée — données … — http://127.0.0.1:8299/
GET /                       → 200 text/html
GET /__map-api/scenes       → 401   (clé d'opérateur requise, mode shared)
GET /__operator             → 404   (pas d'annuaire public en shared)
POST /__map-api/jobs        → 401
```

L'archive ne contient donc PAS `node_modules`. Les modules natifs (`sharp`,
Rapier) ne servent qu'à l'acquisition de terrain, fermée sur le VPS.

Note sur le contrôle de santé : le `401` ci-dessus est la réponse NORMALE de
`/__map-api/scenes` en mode `shared` une fois la clé d'opérateur en place.
`deploy.sh` accepte 200, 401 et 403 — ce qu'il vérifie, c'est que Node répond,
pas qu'il ouvre la porte.

Note sur ce que `shared` refuse en plus (#78) : `DELETE /__map-api/scenes/:slug`
et `DELETE /__map-api/jobs/:id` rendent `403`, clé d'opérateur valide ou non.
L'inscription est libre et il n'y a ni rôle ni propriétaire : sans ce refus,
n'importe quel joueur inscrit effacerait un terrain pour toute l'instance, sans
moyen de le reconstruire (l'acquisition est fermée en `shared`). Une scène ne se
retire donc que depuis le shell de la machine.

Variante possible si l'on préfère : installer Node sur la machine (`apt` ou
NodeSource) et changer l'`ExecStart` en `/usr/bin/node`. Ce répertoire suit
la forme décrite par le design (runtime embarqué), parce qu'elle rend la
version de Node solidaire de la version du jeu — mais le choix reste ouvert
tant que la première livraison n'a pas eu lieu.

## Sauvegardes

Une seule chose est à sauvegarder : `/var/lib/fpvtp/operator-state`. C'est
petit (de l'ordre de 174 Ko par opérateur sans les captures, quelques Mo
avec). Un `tar` quotidien suffit largement — par exemple dans
`/etc/cron.daily/fpvtp-backup` :

```sh
#!/bin/sh
set -eu
dest=/var/backups/fpvtp
mkdir -p "$dest"
tar -czf "$dest/operator-state-$(date +%F).tar.gz" -C /var/lib/fpvtp operator-state
find "$dest" -name 'operator-state-*.tar.gz' -mtime +30 -delete
```

Rien d'autre n'est à sauvegarder :

- `/opt/fpvtp` se reconstruit avec `deploy.sh` depuis une release GitHub ;
- **aucune scène n'est jamais écrite sur le VPS** (l'acquisition y est fermée,
  cf. plus haut), donc `/var/lib/fpvtp/scenes` reste vide et il n'y a pas de
  surveillance d'espace disque particulière à mettre en place ;
- le cache météo (`/var/lib/fpvtp/…`) se reconstruit tout seul.

## Vérifier que ça tourne

```sh
systemctl status fpvtp
journalctl -u fpvtp -f
curl -s localhost:8080/__map-api/scenes        # doit répondre du JSON
curl -sI https://fpvtp.example.org/            # doit répondre en HTTPS
curl -s  https://updates.fpvtp.example.org/latest-linux.yml
```

Au démarrage, le serveur écrit une ligne qui dit tout :

```
FPVTP! v0.2.0 — mode shared — données /var/lib/fpvtp — http://127.0.0.1:8080/
```

Si `mode` n'y dit pas `shared`, ou si le répertoire de données n'est pas
`/var/lib/fpvtp`, l'unité systemd n'a pas été prise en compte : relancez
`systemctl daemon-reload` puis `systemctl restart fpvtp`.

## Ce qui n'a pas pu être vérifié

Ces fichiers ont été écrits sans accès à un VPS. Ont été réellement
mesurés : la syntaxe de `deploy.sh` (`bash -n`), la validité des directives
de `fpvtp.service` (`systemd-analyze verify`), et le fait que
`sim/server/index.mjs` lit bien `FPVTP_MODE`, `FPVTP_DATA_DIR`, `FPVTP_HOST`
et `FPVTP_PORT` (serveur démarré en mode `shared` avec ces variables, réponse
`200 {"scenes":[]}` sur `/__map-api/scenes`).

A été mesuré ensuite, à l'intégration des trois tranches : une archive
construite exactement comme celle de la CI (`app/` + `node/`, **sans
`node_modules`**) démarre en mode `shared` et sert le jeu — voir la section
« Le runtime Node » plus haut pour les codes de réponse relevés.

N'ont **pas** été vérifiés, et le seront à la première livraison réelle : le
`Caddyfile` (Caddy n'était pas installé, `caddy validate` n'a pas pu être
joué), le durcissement systemd sous charge réelle, le téléchargement d'un
asset de release privée, `electron-updater` contre le bloc `updates.`, et
l'ensemble du chemin de bout en bout. `release.yml` lui-même n'a jamais
tourné sur un runner.
