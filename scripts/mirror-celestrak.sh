#!/usr/bin/env bash
# Mirror CelesTrak groups into public/data for the deploy (run by .github/workflows/deploy.yml).
# Usage: scripts/mirror-celestrak.sh <name> <group> [group...]   -> public/data/<name>.tle and <name>.json
#
# CelesTrak blocks any address that downloads the same group twice within 2 hours, and GitHub's build
# machines share addresses, so a download can be refused through no fault of ours. In order:
#   1. If the copy already published on the site is under 2 hours old, reuse it (no download at all).
#   2. Otherwise download from CelesTrak (every request has a time limit, so a stalled server fails the
#      step instead of hanging the deploy). The download goes to a temporary file and is only used if
#      it's a real catalogue, so a failed download can never publish an empty or partial file.
#   3. If CelesTrak refuses, fall back to the last good copy: the one this script saved in the build
#      cache on an earlier run (.celestrak-cache, restored by the workflow), or else the published copy
#      at any age. The data keeps its real fetch time, so the site shows honestly how old it is.
# Every good copy is also saved to .celestrak-cache for step 3 next time.
set -euo pipefail

name=$1
shift
out=public/data
cache=.celestrak-cache
site=${PAGES_URL:?set PAGES_URL to the published site}
celestrak=${CELESTRAK_URL:-https://celestrak.org}
agent="OrbitWatch (github.com/${GITHUB_REPOSITORY:-Zachary-Malcolm/orbitwatch})"
mkdir -p "$out" "$cache"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

is_catalogue() { [ -s "$1" ] && grep -q '^1 ' "$1"; }
age_min() { echo $((($(date -u +%s) - $(date -u -d "$1" +%s)) / 60)); }
fetched_at() { sed -n 's/.*"fetchedAt":"\([^"]*\)".*/\1/p' <<<"$1"; }

# Use a catalogue (text file + its JSON metadata) as the published copy, and keep it as the last good one.
publish() {
  cp "$1" "$out/$name.tle"
  echo "$2" >"$out/$name.json"
  cp "$1" "$cache/$name.tle"
  echo "$2" >"$cache/$name.json"
}

# 1. Reuse the published copy if it's recent.
published_meta=$(curl -fsS --max-time 20 "$site/data/$name.json" 2>/dev/null || true)
published_at=$(fetched_at "$published_meta")
if [ -n "$published_at" ] && date -u -d "$published_at" >/dev/null 2>&1 &&
  curl -fsS --max-time 60 "$site/data/$name.tle" -o "$tmp" 2>/dev/null && is_catalogue "$tmp"; then
  if (($(age_min "$published_at") < 110)); then
    publish "$tmp" "$published_meta"
    echo "Reused the published $name catalogue: $(age_min "$published_at") min old, $(grep -c '^1 ' "$tmp") element sets"
    exit 0
  fi
  cp "$tmp" "$tmp.published" # a valid older copy, kept for step 3
fi

# 2. Download from CelesTrak.
: >"$tmp"
downloaded=true
for group in "$@"; do
  if ! curl -fsS --retry 3 --connect-timeout 20 --max-time 120 -A "$agent" \
    "$celestrak/NORAD/elements/gp.php?GROUP=$group&FORMAT=tle" >>"$tmp"; then
    downloaded=false
    break
  fi
done
if $downloaded && is_catalogue "$tmp"; then
  publish "$tmp" "{\"fetchedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
  echo "Mirrored $(grep -c '^1 ' "$tmp") $name element sets from CelesTrak"
  exit 0
fi
echo "CelesTrak download of $name failed; falling back to the last good copy"

# 3. Fall back to the last good copy.
if is_catalogue "$cache/$name.tle" && [ -n "$(fetched_at "$(cat "$cache/$name.json" 2>/dev/null)")" ]; then
  cp "$cache/$name.tle" "$out/$name.tle"
  cp "$cache/$name.json" "$out/$name.json"
  echo "Using the $name catalogue saved by an earlier run: $(age_min "$(fetched_at "$(cat "$cache/$name.json")")") min old"
  exit 0
fi
if [ -f "$tmp.published" ]; then
  publish "$tmp.published" "$published_meta"
  rm -f "$tmp.published"
  echo "Using the published $name catalogue: $(age_min "$published_at") min old"
  exit 0
fi
rm -f "$out/$name.tle" "$out/$name.json"
echo "No $name catalogue available; the site will fetch CelesTrak directly"
exit 1
