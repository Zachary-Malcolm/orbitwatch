#!/usr/bin/env bash
# Mirror CelesTrak groups into public/data for the deploy (run by .github/workflows/deploy.yml).
# Usage: scripts/mirror-celestrak.sh <name> <group> [group...]   -> public/data/<name>.tle and <name>.json
#
# CelesTrak blocks any address that downloads the same group twice within 2 hours. So if the copy already
# published on the site is younger than that (several pushes in a row), it is reused instead; only the
# scheduled refresh, or a push after a quiet spell, downloads from CelesTrak. Every request has a time
# limit, so a slow or unresponsive server fails the step instead of hanging the deploy.
set -euo pipefail

name=$1
shift
out=public/data
site=${PAGES_URL:?set PAGES_URL to the published site}
celestrak=${CELESTRAK_URL:-https://celestrak.org}
agent="OrbitWatch (github.com/${GITHUB_REPOSITORY:-Zachary-Malcolm/orbitwatch})"
mkdir -p "$out"

if meta=$(curl -fsS --max-time 20 "$site/data/$name.json" 2>/dev/null) &&
  fetched=$(sed -n 's/.*"fetchedAt":"\([^"]*\)".*/\1/p' <<<"$meta") && [ -n "$fetched" ] &&
  then_s=$(date -u -d "$fetched" +%s 2>/dev/null); then
  age=$(($(date -u +%s) - then_s))
  if ((age < 110 * 60)) && curl -fsS --max-time 60 "$site/data/$name.tle" -o "$out/$name.tle" && grep -q '^1 ' "$out/$name.tle"; then
    echo "$meta" >"$out/$name.json"
    echo "Reused the published $name catalogue: $((age / 60)) min old, $(grep -c '^1 ' "$out/$name.tle") element sets"
    exit 0
  fi
fi

: >"$out/$name.tle"
for group in "$@"; do
  curl -fsS --retry 3 --connect-timeout 20 --max-time 120 -A "$agent" \
    "$celestrak/NORAD/elements/gp.php?GROUP=$group&FORMAT=tle" >>"$out/$name.tle"
done
grep -q '^1 ' "$out/$name.tle"
echo "{\"fetchedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >"$out/$name.json"
echo "Mirrored $(grep -c '^1 ' "$out/$name.tle") $name element sets from CelesTrak"
