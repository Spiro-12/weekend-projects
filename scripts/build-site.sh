#!/usr/bin/env bash
# Builds every NN-* project into _site/ for GitHub Pages.
set -euo pipefail
rm -rf _site && mkdir -p _site
links=""
for dir in [0-9][0-9]-*/; do
  name="${dir%/}"
  [ -d "$name" ] || continue
  if [ -f "$name/package.json" ] && grep -q '"build"' "$name/package.json"; then
    (cd "$name" && npm ci && npm run build)
    cp -r "$name/dist" "_site/$name"
  else
    cp -r "$name" "_site/$name"
  fi
  links="$links<li><a href=\"$name/\">$name</a></li>"
done
cat > _site/index.html <<HTML
<!doctype html><html><head><meta charset="utf-8"><title>Weekend Projects</title>
<style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px}a{font-size:1.2em}</style>
</head><body><h1>Weekend Projects</h1><p>One new fun project every weekend.</p><ul>$links</ul></body></html>
HTML
