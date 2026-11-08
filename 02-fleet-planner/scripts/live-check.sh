#!/usr/bin/env bash
# After a Pages deploy: confirm the live page serves the current build, measure over-the-wire bytes, take shots.
# Usage: bash scripts/live-check.sh   (run from 02-fleet-planner/ after `npm run build` of the same commit)
set -euo pipefail
URL="https://spiro-12.github.io/weekend-projects/02-fleet-planner/"
want=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
html=$(curl -fsS --max-time 20 "$URL")
echo "$html" | grep -qF "/weekend-projects/02-fleet-planner/$want" || { echo "live page does not serve this build ($want)"; exit 1; }
js=$(curl -fsS --compressed -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip' "$URL$want")
css=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.css' dist/index.html | head -1)
cssb=$(curl -fsS --compressed -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip' "$URL$css")
man=$(curl -fsS --compressed -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip' "${URL}assets/manifest.json")
echo "live build $want OK; over the wire: JS $js B, CSS $cssb B, manifest $man B"
npx tsx scripts/shots.ts --url "$URL" --out tests/visual/out/live --tier medium
