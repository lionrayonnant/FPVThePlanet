# Préparer un VPS pour FPVTP!

Checklist **humaine**, à suivre **une seule fois** sur une machine neuve.
Ce n'est pas un script de provisionnement : chaque étape se tape à la main,
dans l'ordre, en root. Elle est écrite pour quelqu'un qui ne connaît pas le
projet — rien n'y est laissé à deviner.

Ensuite, chaque nouvelle version se livre en une commande :
`sudo /opt/fpvtp/deploy.sh v0.2.0`.

Le design de référence est
`sim/docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md`
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
- Un jeton GitHub en lecture seule sur le dépôt privé `lionrayonnant/FPVTP`
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
a pas généré une. La commande qui le fait
(`node server/index.mjs key <operatorId>`) est prévue par le design mais
**n'existe pas encore** dans `sim/server/index.mjs` : elle arrive avec la
tranche T3. D'ici là, cette étape 8 n'est pas praticable.

---

## Le runtime Node — prérequis non satisfait aujourd'hui, à lire

`fpvtp.service` lance `/opt/fpvtp/current/node/bin/node`, c'est-à-dire un
runtime Node **embarqué dans l'archive de release**, et
`/opt/fpvtp/current/app` comme répertoire de travail. Autrement dit, l'asset
`linux-x64` attendu par `deploy.sh` doit avoir cette forme :

```
<archive>/
  app/          server/ tools/ src/ dist/ package.json
  node/bin/node
```

**Ce n'est pas ce que la CI produit au 2026-09-07.**
`.github/workflows/release.yml` publie un seul asset,
`fpvtp-sim-<tag>.zip`, qui ne contient que `dist/` — ni `server/`, ni
`tools/`, ni `src/`, ni runtime Node (vérifié en lisant le workflow : l'étape
« Archive du build » est un `zip -qr … dist`). Rien de ce répertoire ne peut
donc encore aboutir à un service qui démarre.

`deploy.sh` ne masque pas ce trou : il vérifie la présence de
`app/server/index.mjs` et de `node/bin/node` **avant** de basculer quoi que ce
soit, et s'arrête avec un message qui renvoie ici.

Ce qui manque, du côté de la release (hors périmètre de ce répertoire) :

1. produire un asset `linux-x64` contenant l'arborescence ci-dessus ;
2. y joindre un runtime Node. Le serveur du jeu n'a besoin d'**aucune
   dépendance npm** pour démarrer — mesuré le 2026-09-07 : `node
   server/index.mjs` démarre et répond sur `/__map-api/scenes` dans une copie
   de travail **sans `node_modules`** — donc « embarquer Node » veut
   simplement dire déposer les binaires officiels
   (`node-vXX.Y.Z-linux-x64.tar.xz`) à côté du programme, sans installer de
   paquets. Les modules natifs (`sharp`) ne sont utilisés que par
   l'acquisition de terrain, qui est fermée sur le VPS.

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

N'ont **pas** été vérifiés, et le seront à la première livraison réelle : le
`Caddyfile` (Caddy n'était pas installé, `caddy validate` n'a pas pu être
joué), le durcissement systemd sous charge réelle, le téléchargement d'un
asset de release privée, et l'ensemble du chemin de bout en bout.
