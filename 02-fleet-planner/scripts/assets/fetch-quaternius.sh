#!/usr/bin/env bash
# Download a free ("name your own price", $0) Quaternius pack zip from its official itch.io page, the download
# channel quaternius.com links to. No account, no payment: it follows itch's "No thanks, just take me to the
# downloads" flow. The zip is untrusted data: it lands in .cache/quaternius/ (gitignored) and is only read by
# build-worker.ts (glTF files only, nothing is executed).
# Usage: bash scripts/assets/fetch-quaternius.sh <itch-slug> "<upload file name>"
#   e.g. bash scripts/assets/fetch-quaternius.sh universal-base-characters "Universal Base Characters[Standard].zip"
set -euo pipefail
slug="$1"; want="$2"
dir="$(cd "$(dirname "$0")/../.." && pwd)/.cache/quaternius"
mkdir -p "$dir"
out="$dir/$want"
if [[ -s "$out" ]]; then echo "cached: $out"; exit 0; fi
jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT
page="https://quaternius.itch.io/$slug"
html="$(curl -sSL -c "$jar" -b "$jar" -m 60 "$page")"
csrf="$(printf '%s' "$html" | grep -o 'name="csrf_token" value="[^"]*"' | head -1 | sed 's/.*value="//; s/"$//')"
[[ -n "$csrf" ]] || { echo "no csrf token on $page" >&2; exit 1; }
dl="$(curl -sS -c "$jar" -b "$jar" -m 60 -X POST --data-urlencode "csrf_token=$csrf" "$page/download_url" |
  python3 -I -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
dlhtml="$(curl -sSL -c "$jar" -b "$jar" -m 60 "$dl")"
csrf2="$(printf '%s' "$dlhtml" | grep -o 'name="csrf_token" value="[^"]*"' | head -1 | sed 's/.*value="//; s/"$//')"
# Each upload row: data-upload_id="N" ... title="<file name>"
uid="$(printf '%s' "$dlhtml" | python3 -I -c '
import re,sys
html=sys.stdin.read(); want=sys.argv[1]
for m in re.finditer(r"data-upload_id=\"(\d+)\"", html):
    seg=html[m.end():m.end()+1500]
    t=re.search(r"title=\"([^\"]+)\"", seg)
    if t and t.group(1)==want: print(m.group(1)); break
' "$want")"
[[ -n "$uid" ]] || { echo "upload '$want' not found on the download page (paid tier?)" >&2; exit 1; }
cdn="$(curl -sS -c "$jar" -b "$jar" -m 60 -X POST -H "Referer: $dl" --data-urlencode "csrf_token=${csrf2:-$csrf}" \
  "$page/file/$uid?source=game_download&after_download_lightbox=1&as_props=1" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
curl -sSL -m 900 -o "$out.part" "$cdn"
mv "$out.part" "$out"
ls -la "$out"
