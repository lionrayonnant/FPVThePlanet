#!/usr/bin/env bash
# Génération du corpus de dialogue (PHASE 21) — les dix événements restants.
#
#   ./tools/dialogue/run-corpus.sh                 # local seul (gratuit, ~8 h)
#   ./tools/dialogue/run-corpus.sh --with-hosted   # + les VERY_RARE via l'abonnement
#
# Hybride assumé : le modèle local suffit pour le volume (COMMON/UNCOMMON/RARE),
# mais ses VERY_RARE ne se distinguaient que par leur brièveté. Les lignes qu'un
# joueur remarque et raconte passent donc par le modèle hébergé — mesuré à UNE
# invocation par événement, le coût dominant étant le cache par appel, pas le
# contenu.
set -uo pipefail
cd "$(dirname "$0")/../.."

WITH_HOSTED=0
[ "${1:-}" = "--with-hosted" ] && WITH_HOSTED=1

EVENTS=(AREA_SEARCH PROBE_AREA TERRAIN_PROGRESS TARGET_SCAN TARGET_SELECTED
        TARGET_ANALYSIS HACK MANUAL_OVERRIDE JACK_IN WEATHER)
LOG="/tmp/corpus-$(date +%Y%m%d-%H%M).log"
echo "journal : $LOG"

# Le garde-fou qui a manqué la première fois : une faute d'argument faisait
# retomber le générateur sur le backend hébergé sans rien dire, et 22 lots sont
# partis en facturation. On lit désormais la ligne « backend : » du bilan et on
# s'arrête net si ce n'est pas celui demandé.
run() {  # run <backend> <event> <count> <batch> <rarity>
	local backend=$1 event=$2 count=$3 batch=$4 rarity=$5
	echo "--- $event / $rarity / $count via $backend" | tee -a "$LOG"
	local out
	out=$(node tools/dialogue/generate.mjs --event "$event" --count "$count" \
		--batch "$batch" --rarity "$rarity" --backend "$backend" 2>&1)
	echo "$out" >> "$LOG"
	if ! grep -q "^backend : $backend" <<< "$out"; then
		echo "ARRÊT — backend attendu '$backend', bilan :" | tee -a "$LOG"
		grep "^backend :" <<< "$out" | tee -a "$LOG"
		exit 1
	fi
	grep -E "gardées|écrit" <<< "$out" | tail -2 | tee -a "$LOG"
}

for ev in "${EVENTS[@]}"; do
	run ollama "$ev" 400 20 COMMON
	run ollama "$ev" 150 15 UNCOMMON
	run ollama "$ev"  60 12 RARE
	[ "$WITH_HOSTED" = "1" ] && run claude "$ev" 20 20 VERY_RARE
done

echo "=== terminé ===" | tee -a "$LOG"
node tools/dialogue-selftest.mjs | tail -2 | tee -a "$LOG"
