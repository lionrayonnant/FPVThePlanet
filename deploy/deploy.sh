#!/usr/bin/env bash
#
# deploy.sh <tag> — ships a version of FPVTP! to the VPS.
#
# Slice T4 of the deployment design:
# sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md
#
# This script runs AS ROOT on a production machine. It is written to fail
# loudly and early rather than to guess.
#
# Usage:
#     sudo /opt/fpvtp/deploy.sh v1.0.0
#
# What it does, in order:
#     a. downloads the `linux-x64` asset of the GitHub Release for the given
#        tag (the repository is public, so no token is required);
#     b. unpacks it into /opt/fpvtp/releases/<tag>;
#     c. points the /opt/fpvtp/current link at it;
#     d. systemctl restart fpvtp;
#     e. checks that the server answers on /__map-api/scenes;
#     f. drops the desktop installers and their feed files into
#        /srv/fpvtp-updates (the directory the second Caddy block serves).
#
# ---------------------------------------------------------------------------
# ROLLING BACK
# ---------------------------------------------------------------------------
# This script NEVER erases the previous release: it stays whole in
# /opt/fpvtp/releases/<previous tag>. Rolling back is therefore two commands,
# and nothing else:
#
#     ln -sfn /opt/fpvtp/releases/<previous tag> /opt/fpvtp/current
#     systemctl restart fpvtp
#
# The script prints the exact path of the previous release at the moment it
# switches, and prints it again if it fails: keep that line in view.
# The rollback is NOT automatic, deliberately — an automatic rollback that
# fails in turn leaves the machine in a state nobody has described.
# The data (/var/lib/fpvtp) is never touched, neither on delivery nor on
# rollback.
#
# To free space, erase old releases by hand, keeping at least the running one
# and the previous one:
#     ls -1t /opt/fpvtp/releases
# ---------------------------------------------------------------------------

set -euo pipefail

# --- Settings (the only things to re-read if the machine changes) -----------
REPO="lionrayonnant/FPVThePlanet"
ROOT="/opt/fpvtp"
RELEASES_DIR="${ROOT}/releases"
CURRENT_LINK="${ROOT}/current"
# Optional since the repository went public: a token is no longer needed to
# read a Release, it only raises the GitHub API rate limit (60 requests/hour
# unauthenticated, per IP). A VPS that shares its address with other API
# callers is the case where this matters.
TOKEN_FILE="/etc/fpvtp/token"
SERVICE="fpvtp"
SERVICE_USER="fpvtp"
SERVICE_GROUP="fpvtp"
UPDATES_DIR="/srv/fpvtp-updates"
# The health check's address is READ from the unit below rather than repeated
# here — these two are only the fallback, and they are the server's own
# defaults (server/index.mjs: FPVTP_HOST 127.0.0.1, FPVTP_PORT 8080), used when
# the unit sets neither. Repeating the port is how a unit edited on the machine
# ends up deployed green while the script checked a port nobody listens on.
HEALTH_HOST_FALLBACK="127.0.0.1"
HEALTH_PORT_FALLBACK="8080"
HEALTH_PATH="/__map-api/scenes"
HEALTH_TRIES=30

# --- Small helpers ----------------------------------------------------------
say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m/!\\\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

# Erases a directory, but ONLY if the variable is non-empty and the path sits
# under an expected root. `rm -rf "$X"` with X empty is `rm -rf ""` — harmless
# here, but `rm -rf "$X"/*` is not, and a typo in a path is worse still. Every
# deletion goes through this function.
safe_rm_rf() {
	local victim="${1:-}" root="${2:-}"
	[ -n "$victim" ] || die "safe_rm_rf called with no path (script bug)"
	[ -n "$root" ]   || die "safe_rm_rf called with no root (script bug)"
	case "$victim" in
		"$root"/?*) ;;
		*) die "refusing to erase \"$victim\": outside $root" ;;
	esac
	[ -e "$victim" ] || return 0
	rm -rf -- "$victim"
}

STAGING=""
cleanup() {
	if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
		rm -rf -- "$STAGING"
	fi
}
trap cleanup EXIT

# --- 0. Preflight checks ----------------------------------------------------
TAG="${1:-}"
[ -n "$TAG" ] || die "usage: $0 <tag>   (example: $0 v1.0.0)"
case "$TAG" in
	v[0-9]*) ;;
	*) die "unexpected tag \"$TAG\": the form vX.Y.Z is expected, the one release tags use" ;;
esac
# The tag ends up in paths: nothing exotic is allowed in it.
case "$TAG" in
	*/*|*..*|*' '*) die "tag \"$TAG\": forbidden character in a release name" ;;
esac

[ "$(id -u)" -eq 0 ] || die "run as root (sudo): it switches /opt/fpvtp and calls systemctl restart"

for tool in curl jq tar unzip systemctl install; do
	command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool (see deploy/README.md, \"Prerequisites\")"
done

# The token is optional since the repository is public. When present it only
# raises the API rate limit; when absent the anonymous limit (60 requests per
# hour and per IP) is plenty for one delivery, which spends four or five.
TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
	TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
	if [ -n "$TOKEN" ]; then
		say "GitHub token read from ${TOKEN_FILE} (raised rate limit)."
	else
		warn "${TOKEN_FILE} exists but is empty: continuing without a token."
	fi
fi

[ -d "$RELEASES_DIR" ] || die "$RELEASES_DIR does not exist — the machine has not been prepared (deploy/README.md)."
systemctl list-unit-files "${SERVICE}.service" --no-legend | grep -q . \
	|| die "unit ${SERVICE}.service unknown to systemd — install deploy/fpvtp.service (deploy/README.md)."

# What systemd actually loaded, not what this file remembers. `Environment` is
# printed as one space-separated line of KEY=VALUE.
# `|| true` because `set -o pipefail` is on: a systemctl that fails here must
# fall back to the defaults, not end the deploy.
unit_env() {
	{ systemctl show -p Environment --value "${SERVICE}.service" 2>/dev/null || true; } \
		| tr ' ' '\n' | sed -n "s/^$1=//p" | tail -n 1
}
HEALTH_HOST="$(unit_env FPVTP_HOST)"
HEALTH_PORT="$(unit_env FPVTP_PORT)"
HEALTH_URL="http://${HEALTH_HOST:-$HEALTH_HOST_FALLBACK}:${HEALTH_PORT:-$HEALTH_PORT_FALLBACK}${HEALTH_PATH}"

STAGING="$(mktemp -d /tmp/fpvtp-deploy.XXXXXXXX)"

# `curl` against the GitHub API. When a token is set it goes through a header,
# never through a command line visible to `ps`: it lives in a variable and curl
# reads it with -H, not in the URL.
gh_api() {
	local auth=()
	if [ -n "$TOKEN" ]; then auth=(-H "Authorization: Bearer ${TOKEN}"); fi
	# ${auth[@]+...}: an empty array under `set -u` is an unbound variable on
	# bash < 4.4, and this script runs on whatever the distribution ships.
	curl --fail-with-body --silent --show-error --location \
		--retry 3 --retry-delay 2 --connect-timeout 15 \
		${auth[@]+"${auth[@]}"} \
		-H "Accept: application/vnd.github+json" \
		-H "X-GitHub-Api-Version: 2022-11-28" \
		"$@"
}

# --- a. The release and its assets ------------------------------------------
say "Release ${TAG} of repository ${REPO}"
RELEASE_JSON="${STAGING}/release.json"
if ! gh_api -o "$RELEASE_JSON" "https://api.github.com/repos/${REPO}/releases/tags/${TAG}"; then
	die "release ${TAG} not found, or the API refused the request.
     Check that the tag exists (gh release view ${TAG}). If the API answered
     403, the anonymous rate limit is spent: drop a read-only token in
     ${TOKEN_FILE} and try again."
fi

# An asset is (name, url). They are listed once, then picked from.
ASSETS="${STAGING}/assets.tsv"
jq -r '.assets[] | "\(.name)\t\(.browser_download_url)"' "$RELEASE_JSON" > "$ASSETS"
[ -s "$ASSETS" ] || die "release ${TAG} has no attached asset."

# Downloads an asset from its browser_download_url, which serves the bytes with
# no content negotiation at all.
#
# NOT through the API's /releases/assets/<id> endpoint, which is what this did
# before and which never actually worked: gh_api sets
# `Accept: application/vnd.github+json`, adding a second
# `Accept: application/octet-stream` sends BOTH, and GitHub honours the first —
# so the "archive" was the asset's JSON metadata and tar reported
# "not in gzip format". That endpoint exists for private repositories, where a
# token is required for the download itself. This one is public, so the plain
# URL is both simpler and immune to the whole question.
download_asset() {
	local url="$1" dest="$2"
	# `< /dev/null`: this function is called from a `while read` loop reading a
	# file on stdin; curl must not touch it.
	curl --fail --silent --show-error --location \
		--retry 3 --retry-delay 2 --connect-timeout 15 \
		-o "$dest" "$url" < /dev/null
}

# The first asset whose name contains "linux-x64".
SERVER_URL=""; SERVER_NAME=""
while IFS=$'\t' read -r name url; do
	case "$name" in
		*linux-x64*) SERVER_URL="$url"; SERVER_NAME="$name"; break ;;
	esac
done < "$ASSETS"

if [ -z "$SERVER_URL" ]; then
	die "no \"linux-x64\" asset in release ${TAG}.
     Assets present:
$(cut -f1 "$ASSETS" | sed 's/^/       - /')
     .github/workflows/release.yml publishes
     \"fpvtp-server-<tag>-linux-x64.tar.gz\" — the server, the built game, a
     Node runtime and deploy/. A release that predates that workflow does not
     carry it. See deploy/README.md, section \"The Node runtime\"."
fi

say "Server asset: ${SERVER_NAME}"
ARCHIVE="${STAGING}/${SERVER_NAME}"
download_asset "$SERVER_URL" "$ARCHIVE" || die "download of ${SERVER_NAME} failed."

# What came back must actually be the archive. Without this the first sign of
# trouble is tar's "not in gzip format", which names neither the file nor the
# reason.
case "$(file -b --mime-type "$ARCHIVE" 2>/dev/null || echo unknown)" in
	application/gzip|application/x-gzip|application/x-tar|application/zip|application/x-xz|unknown) ;;
	*) die "downloaded ${SERVER_NAME} is not an archive:
     $(head -c 200 "$ARCHIVE")" ;;
esac

# --- b. Unpacking -----------------------------------------------------------
# Unpack into a temporary folder THEN move: a release only appears under its
# final name once it is complete.
EXTRACT="${STAGING}/extract"
mkdir -p "$EXTRACT"
case "$SERVER_NAME" in
	*.zip)              unzip -q "$ARCHIVE" -d "$EXTRACT" ;;
	*.tar.gz|*.tgz)     tar -xzf "$ARCHIVE" -C "$EXTRACT" ;;
	*.tar.xz)           tar -xJf "$ARCHIVE" -C "$EXTRACT" ;;
	*) die "unsupported archive format: ${SERVER_NAME} (zip, tar.gz or tar.xz expected)" ;;
esac

# If the archive has a single root folder, that folder is the release.
SOURCE="$EXTRACT"
if [ "$(find "$EXTRACT" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
	only="$(find "$EXTRACT" -mindepth 1 -maxdepth 1)"
	[ -d "$only" ] && SOURCE="$only"
fi

# The shape the systemd unit demands, checked BEFORE anything is switched:
# ExecStart points at /opt/fpvtp/current/node/bin/node and WorkingDirectory at
# /opt/fpvtp/current/app.
[ -f "${SOURCE}/app/server/index.mjs" ] \
	|| die "unexpected archive: app/server/index.mjs is missing.
     fpvtp.service runs \"server/index.mjs\" from <release>/app.
     Found at the archive root:
$(find "$SOURCE" -mindepth 1 -maxdepth 1 -printf '       - %f\n' | sort)"
[ -x "${SOURCE}/node/bin/node" ] \
	|| die "unexpected archive: node/bin/node missing or not executable.
     fpvtp.service runs <release>/node/bin/node: the Node runtime must travel
     inside the archive (see deploy/README.md, \"The Node runtime\")."

DEST="${RELEASES_DIR}/${TAG}"
if [ -e "$DEST" ]; then
	warn "${DEST} already exists: it is being replaced (re-delivery of the same tag)."
	safe_rm_rf "$DEST" "$RELEASES_DIR"
fi
mv -- "$SOURCE" "$DEST"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$DEST"
say "Deployed into ${DEST}"

# --- c. Switching the link --------------------------------------------------
PREVIOUS=""
if [ -L "$CURRENT_LINK" ]; then
	PREVIOUS="$(readlink -f "$CURRENT_LINK" || true)"
elif [ -e "$CURRENT_LINK" ]; then
	die "${CURRENT_LINK} exists and is NOT a symbolic link.
     The script will not touch that: move it by hand, then run again."
fi

if [ -n "$PREVIOUS" ]; then
	say "Previous release kept: ${PREVIOUS}"
	say "Rollback = ln -sfn '${PREVIOUS}' '${CURRENT_LINK}' && systemctl restart ${SERVICE}"
else
	say "First delivery: no previous release to keep."
fi

ln -sfn "$DEST" "$CURRENT_LINK"
say "${CURRENT_LINK} -> ${DEST}"

# --- d. Restart -------------------------------------------------------------
say "systemctl restart ${SERVICE}"
systemctl restart "$SERVICE"

# --- e. Health check --------------------------------------------------------
# 200 is accepted, but so are 401 and 403: from slice T3 on, `shared` mode
# demands an operator key on /__map-api/*, and a refused authentication proves
# just as well that the Node server is alive and answering. What is NOT
# accepted: no answer at all, or a 5xx.
say "Checking: ${HEALTH_URL}"
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
		say "The server answers (HTTP ${code})."
		;;
	*)
		printf '\n' >&2
		warn "The server does not answer correctly on ${HEALTH_URL} (code \"${code:-none}\")."
		warn "Last 40 log lines:"
		journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
		if [ -n "$PREVIOUS" ]; then
			die "delivery failed. To roll back:
         ln -sfn '${PREVIOUS}' '${CURRENT_LINK}' && systemctl restart ${SERVICE}"
		fi
		die "delivery failed, and there is no previous release to fall back to."
		;;
esac

# --- f. The desktop installers (Electron, D3) -------------------------------
# Unauthenticated, public, served by the second block of the Caddyfile.
#
# Since the repository went public the auto-updater reads the GitHub Releases
# API directly (electron-builder.yml, `provider: github`), so this mirror is no
# longer what keeps installed apps up to date. It stays useful as a download
# page of your own, and as the feed an FPVTP_UPDATE_URL build would point at.
#
# It does NOT gate the success of the server delivery: if the release carries
# none, a warning is printed and the script stops there, the server already
# running.
say "Desktop artifacts -> ${UPDATES_DIR}"
if [ ! -d "$UPDATES_DIR" ]; then
	warn "${UPDATES_DIR} does not exist: nothing is dropped. Create it (deploy/README.md)."
	exit 0
fi

dropped=0
while IFS=$'\t' read -r name url; do
	case "$name" in
		*.exe|*.AppImage|*.blockmap|latest.yml|latest-linux.yml)
			tmp="${STAGING}/desktop-${name}"
			if ! download_asset "$url" "$tmp"; then
				warn "download of ${name} failed — skipped."
				continue
			fi
			# install(1) writes to a temporary file then renames: the file Caddy
			# serves is never seen half-written.
			install -m 0644 -- "$tmp" "${UPDATES_DIR}/${name}"
			say "  ${name}"
			dropped=$((dropped + 1))
			;;
	esac
done < "$ASSETS"

if [ "$dropped" -eq 0 ]; then
	warn "No installer and no feed file in release ${TAG}."
	warn "Expected: *.exe, *.AppImage, latest.yml, latest-linux.yml."
else
	say "${dropped} desktop artifact(s) dropped."
fi
