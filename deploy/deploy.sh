#!/usr/bin/env bash
#
# deploy.sh <tag> — livre une version de FPVTP! sur le VPS.
#
# Tranche T4 du design de déploiement :
# sim/docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md
#
# Ce script tourne EN ROOT sur une machine de production. Il est écrit pour
# échouer bruyamment et tôt plutôt que pour deviner.
#
# Usage :
#     sudo /opt/fpvtp/deploy.sh v0.2.0
#
# Ce qu'il fait, dans l'ordre :
#     a. télécharge l'asset `linux-x64` de la GitHub Release du tag donné
#        (le dépôt est PRIVÉ : jeton lecture seule attendu dans /etc/fpvtp/token) ;
#     b. décompresse dans /opt/fpvtp/releases/<tag> ;
#     c. bascule le lien /opt/fpvtp/current dessus ;
#     d. systemctl restart fpvtp ;
#     e. vérifie que le serveur répond sur /__map-api/scenes ;
#     f. dépose les installeurs de bureau et leurs fichiers de flux dans
#        /srv/fpvtp-updates (le répertoire que sert le second bloc Caddy).
#
# ---------------------------------------------------------------------------
# REVENIR EN ARRIÈRE (rollback)
# ---------------------------------------------------------------------------
# Ce script n'efface JAMAIS la release précédente : elle reste entière dans
# /opt/fpvtp/releases/<tag précédent>. Revenir en arrière est donc deux
# commandes, et rien d'autre :
#
#     ln -sfn /opt/fpvtp/releases/<tag précédent> /opt/fpvtp/current
#     systemctl restart fpvtp
#
# Le script affiche le chemin exact de la release précédente au moment de la
# bascule, et le ré-affiche s'il échoue : gardez cette ligne sous les yeux.
# Le rollback n'est PAS automatique, à dessein — un rollback automatique qui
# échoue à son tour laisse la machine dans un état que personne n'a décrit.
# Les données (/var/lib/fpvtp) ne sont jamais touchées, ni à la livraison ni
# au rollback.
#
# Pour faire de la place, effacez à la main les vieilles releases, en gardant
# au moins celle qui tourne et la précédente :
#     ls -1t /opt/fpvtp/releases
# ---------------------------------------------------------------------------

set -euo pipefail

# --- Réglages (les seules choses à relire si la machine change) -------------
REPO="lionrayonnant/FPVTP"
ROOT="/opt/fpvtp"
RELEASES_DIR="${ROOT}/releases"
CURRENT_LINK="${ROOT}/current"
TOKEN_FILE="/etc/fpvtp/token"
SERVICE="fpvtp"
SERVICE_USER="fpvtp"
SERVICE_GROUP="fpvtp"
UPDATES_DIR="/srv/fpvtp-updates"
# Doit correspondre à FPVTP_HOST/FPVTP_PORT dans deploy/fpvtp.service.
HEALTH_URL="http://127.0.0.1:8080/__map-api/scenes"
HEALTH_TRIES=30

# --- Petits utilitaires -----------------------------------------------------
say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m/!\\\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERREUR\033[0m %s\n' "$*" >&2; exit 1; }

# Efface un répertoire, mais SEULEMENT s'il est non vide comme variable et
# bien situé sous une racine attendue. `rm -rf "$X"` avec X vide vaut
# `rm -rf ""` — inoffensif ici, mais `rm -rf "$X"/*` ne l'est pas, et une
# faute de frappe dans un chemin l'est encore moins. On passe par cette
# fonction partout.
safe_rm_rf() {
	local victime="${1:-}" racine="${2:-}"
	[ -n "$victime" ] || die "safe_rm_rf appelée sans chemin (bug du script)"
	[ -n "$racine" ]  || die "safe_rm_rf appelée sans racine (bug du script)"
	case "$victime" in
		"$racine"/?*) ;;
		*) die "refus d'effacer « $victime » : hors de $racine" ;;
	esac
	[ -e "$victime" ] || return 0
	rm -rf -- "$victime"
}

STAGING=""
cleanup() {
	if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
		rm -rf -- "$STAGING"
	fi
}
trap cleanup EXIT

# --- 0. Contrôles préalables ------------------------------------------------
TAG="${1:-}"
[ -n "$TAG" ] || die "usage: $0 <tag>   (exemple: $0 v0.2.0)"
case "$TAG" in
	v[0-9]*) ;;
	*) die "tag « $TAG » inattendu : on attend la forme vX.Y.Z, celle des tags de release" ;;
esac
# Le tag entre dans des chemins : rien d'exotique n'y est admis.
case "$TAG" in
	*/*|*..*|*' '*) die "tag « $TAG » : caractère interdit dans un nom de release" ;;
esac

[ "$(id -u)" -eq 0 ] || die "à lancer en root (sudo) : bascule de /opt/fpvtp et systemctl restart"

for outil in curl jq tar unzip systemctl install; do
	command -v "$outil" >/dev/null 2>&1 || die "outil manquant : $outil (voir deploy/README.md, « Prérequis »)"
done

# Le jeton : la panne la plus probable, donc le message le plus explicite.
if [ ! -f "$TOKEN_FILE" ]; then
	die "jeton absent : $TOKEN_FILE n'existe pas.
     Le dépôt ${REPO} est privé : le téléchargement de la release demande un
     jeton GitHub en lecture seule (portée « Contents: read » sur ce dépôt).
     Créez-le puis :
         install -d -m 0700 /etc/fpvtp
         printf '%s' 'ghp_xxxxxxxx' > ${TOKEN_FILE}
         chmod 0600 ${TOKEN_FILE}"
fi
TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || die "jeton vide : $TOKEN_FILE existe mais ne contient rien d'exploitable."

[ -d "$RELEASES_DIR" ] || die "$RELEASES_DIR n'existe pas — la machine n'a pas été préparée (deploy/README.md)."
systemctl list-unit-files "${SERVICE}.service" --no-legend | grep -q . \
	|| die "unité ${SERVICE}.service inconnue de systemd — installez deploy/fpvtp.service (deploy/README.md)."

STAGING="$(mktemp -d /tmp/fpvtp-deploy.XXXXXXXX)"

# `curl` vers l'API GitHub, avec le jeton passé par en-tête. Le jeton n'apparaît
# jamais dans une ligne de commande visible par `ps` : il est dans une variable
# et `curl` la lit par -H, pas dans l'URL.
gh_api() {
	curl --fail-with-body --silent --show-error --location \
		--retry 3 --retry-delay 2 --connect-timeout 15 \
		-H "Authorization: Bearer ${TOKEN}" \
		-H "Accept: application/vnd.github+json" \
		-H "X-GitHub-Api-Version: 2022-11-28" \
		"$@"
}

# --- a. La release et ses assets -------------------------------------------
say "Release ${TAG} du dépôt ${REPO}"
RELEASE_JSON="${STAGING}/release.json"
if ! gh_api -o "$RELEASE_JSON" "https://api.github.com/repos/${REPO}/releases/tags/${TAG}"; then
	die "release ${TAG} introuvable, ou jeton refusé.
     Vérifiez que le tag existe (gh release view ${TAG}) et que le jeton de
     ${TOKEN_FILE} a bien la lecture du contenu de ${REPO}."
fi

# Un asset = (id, nom). On les liste une fois, on pioche dedans ensuite.
ASSETS="${STAGING}/assets.tsv"
jq -r '.assets[] | "\(.id)\t\(.name)"' "$RELEASE_JSON" > "$ASSETS"
[ -s "$ASSETS" ] || die "la release ${TAG} n'a aucun asset attaché."

# Télécharge un asset par son id. L'API sert le binaire quand on demande
# `application/octet-stream` — c'est la seule voie pour un dépôt privé, l'URL
# `browser_download_url` n'accepte pas le jeton.
telecharger_asset() {
	local id="$1" dest="$2"
	# `< /dev/null` : cette fonction est appelée depuis une boucle
	# `while read` qui lit un fichier sur stdin ; curl ne doit pas y toucher.
	gh_api -H "Accept: application/octet-stream" -o "$dest" \
		"https://api.github.com/repos/${REPO}/releases/assets/${id}" < /dev/null
}

# Le premier asset dont le nom contient « linux-x64 ».
SERVER_ID=""; SERVER_NAME=""
while IFS=$'\t' read -r id nom; do
	case "$nom" in
		*linux-x64*) SERVER_ID="$id"; SERVER_NAME="$nom"; break ;;
	esac
done < "$ASSETS"

if [ -z "$SERVER_ID" ]; then
	die "aucun asset « linux-x64 » dans la release ${TAG}.
     Assets présents :
$(sed 's/^[0-9]*\t/       - /' "$ASSETS")
     C'est le prérequis connu et non encore satisfait : au 2026-09-07,
     .github/workflows/release.yml ne publie qu'un « fpvtp-sim-<tag>.zip »
     contenant le seul dist/, sans server/, sans tools/ et sans runtime Node.
     Voir deploy/README.md, section « Le runtime Node »."
fi

say "Asset serveur : ${SERVER_NAME}"
ARCHIVE="${STAGING}/${SERVER_NAME}"
telecharger_asset "$SERVER_ID" "$ARCHIVE" || die "échec du téléchargement de ${SERVER_NAME}."

# --- b. Décompression -------------------------------------------------------
# On décompresse dans un dossier temporaire PUIS on déplace : une release
# n'apparaît sous son nom définitif que complète.
EXTRACT="${STAGING}/extract"
mkdir -p "$EXTRACT"
case "$SERVER_NAME" in
	*.zip)              unzip -q "$ARCHIVE" -d "$EXTRACT" ;;
	*.tar.gz|*.tgz)     tar -xzf "$ARCHIVE" -C "$EXTRACT" ;;
	*.tar.xz)           tar -xJf "$ARCHIVE" -C "$EXTRACT" ;;
	*) die "format d'archive non géré : ${SERVER_NAME} (zip, tar.gz ou tar.xz attendus)" ;;
esac

# Si l'archive a un unique dossier racine, c'est lui la release.
SOURCE="$EXTRACT"
if [ "$(find "$EXTRACT" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
	seul="$(find "$EXTRACT" -mindepth 1 -maxdepth 1)"
	[ -d "$seul" ] && SOURCE="$seul"
fi

# La forme que l'unité systemd exige, vérifiée AVANT de basculer quoi que ce
# soit : ExecStart pointe /opt/fpvtp/current/node/bin/node et
# WorkingDirectory /opt/fpvtp/current/app.
[ -f "${SOURCE}/app/server/index.mjs" ] \
	|| die "archive inattendue : app/server/index.mjs absent.
     fpvtp.service lance « server/index.mjs » depuis <release>/app.
     Contenu trouvé à la racine de l'archive :
$(find "$SOURCE" -mindepth 1 -maxdepth 1 -printf '       - %f\n' | sort)"
[ -x "${SOURCE}/node/bin/node" ] \
	|| die "archive inattendue : node/bin/node absent ou non exécutable.
     fpvtp.service lance <release>/node/bin/node : le runtime Node doit
     voyager dans l'archive (voir deploy/README.md, « Le runtime Node »)."

DEST="${RELEASES_DIR}/${TAG}"
if [ -e "$DEST" ]; then
	warn "${DEST} existe déjà : il est remplacé (re-livraison du même tag)."
	safe_rm_rf "$DEST" "$RELEASES_DIR"
fi
mv -- "$SOURCE" "$DEST"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$DEST"
say "Déployé dans ${DEST}"

# --- c. Bascule du lien -----------------------------------------------------
PRECEDENT=""
if [ -L "$CURRENT_LINK" ]; then
	PRECEDENT="$(readlink -f "$CURRENT_LINK" || true)"
elif [ -e "$CURRENT_LINK" ]; then
	die "${CURRENT_LINK} existe et n'est PAS un lien symbolique.
     Le script ne touche pas à ça : déplacez-le à la main, puis relancez."
fi

if [ -n "$PRECEDENT" ]; then
	say "Release précédente conservée : ${PRECEDENT}"
	say "Rollback = ln -sfn '${PRECEDENT}' '${CURRENT_LINK}' && systemctl restart ${SERVICE}"
else
	say "Première livraison : aucune release précédente à conserver."
fi

ln -sfn "$DEST" "$CURRENT_LINK"
say "${CURRENT_LINK} -> ${DEST}"

# --- d. Redémarrage ---------------------------------------------------------
say "systemctl restart ${SERVICE}"
systemctl restart "$SERVICE"

# --- e. Vérification --------------------------------------------------------
# On accepte 200, mais aussi 401 et 403 : à partir de la tranche T3, le mode
# `shared` demande une clé d'opérateur sur /__map-api/*, et un refus
# d'authentification prouve tout autant que le serveur Node est vivant et
# répond. Ce qui n'est PAS accepté : pas de réponse du tout, ou une 5xx.
say "Vérification : ${HEALTH_URL}"
code=""
for _ in $(seq 1 "$HEALTH_TRIES"); do
	code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
		--max-time 5 "$HEALTH_URL" || true)"
	case "$code" in
		200|401|403) break ;;
	esac
	sleep 1
done

case "$code" in
	200|401|403)
		say "Le serveur répond (HTTP ${code})."
		;;
	*)
		printf '\n' >&2
		warn "Le serveur ne répond pas correctement sur ${HEALTH_URL} (code « ${code:-aucun} »)."
		warn "Journal des 40 dernières lignes :"
		journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
		if [ -n "$PRECEDENT" ]; then
			die "livraison échouée. Pour revenir en arrière :
         ln -sfn '${PRECEDENT}' '${CURRENT_LINK}' && systemctl restart ${SERVICE}"
		fi
		die "livraison échouée, et aucune release précédente vers laquelle revenir."
		;;
esac

# --- f. Les installeurs de bureau (Electron, D3) ----------------------------
# Sans authentification, publics, servis par le second bloc du Caddyfile.
# Ils ne conditionnent PAS le succès de la livraison du serveur : si la
# release n'en contient pas encore (tranche T2 non livrée), on prévient et on
# s'arrête là, le serveur tourne déjà.
say "Artefacts de bureau -> ${UPDATES_DIR}"
if [ ! -d "$UPDATES_DIR" ]; then
	warn "${UPDATES_DIR} n'existe pas : rien n'est déposé. Créez-le (deploy/README.md)."
	exit 0
fi

deposes=0
while IFS=$'\t' read -r id nom; do
	case "$nom" in
		*.exe|*.AppImage|*.blockmap|latest.yml|latest-linux.yml)
			tmp="${STAGING}/desktop-${nom}"
			if ! telecharger_asset "$id" "$tmp"; then
				warn "échec du téléchargement de ${nom} — ignoré."
				continue
			fi
			# install(1) écrit dans un fichier temporaire puis renomme : le
			# fichier servi par Caddy n'est jamais vu à moitié écrit.
			install -m 0644 -- "$tmp" "${UPDATES_DIR}/${nom}"
			say "  ${nom}"
			deposes=$((deposes + 1))
			;;
	esac
done < "$ASSETS"

if [ "$deposes" -eq 0 ]; then
	warn "Aucun installeur ni fichier de flux dans la release ${TAG}."
	warn "Attendu à partir de la tranche T2 : *.exe, *.AppImage, latest.yml, latest-linux.yml."
else
	say "${deposes} artefact(s) de bureau déposé(s)."
fi

say "Livraison de ${TAG} terminée."
