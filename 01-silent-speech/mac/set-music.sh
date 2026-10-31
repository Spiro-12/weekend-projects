#!/bin/bash
# Sets the Spotify playlist (or album, track...) for focus_music in ~/.silentspeech/actions.json, touching only that
# entry and never printing the rest of the file (it holds Spiro's number).
# Usage: ./set-music.sh "spotify:playlist:<id>"   or   ./set-music.sh "https://open.spotify.com/playlist/<id>"
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "FAILED: node is missing (SETUP.md step 0.4)"; exit 1; }
[ $# -eq 1 ] || { echo "Usage: ./set-music.sh \"spotify:playlist:<id>\""; exit 2; }
SS_URI="$1" node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const raw = (process.env.SS_URI || "").trim();
// Same rule as the app (ActionRunner.spotifyURI).
const kinds = "(playlist|album|track|artist|show|episode)";
let uri = null;
if (new RegExp(`^spotify:${kinds}:[A-Za-z0-9]{10,40}$`).test(raw)) uri = raw;
const m = new RegExp(`^https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?${kinds}/([A-Za-z0-9]{10,40})(\\?.*)?$`).exec(raw);
if (!uri && m) uri = `spotify:${m[1]}:${m[2]}`;
if (!uri) { console.log("FAILED: not a spotify: URI or open.spotify.com link (nothing saved)"); process.exit(1); }
const dir = path.join(os.homedir(), ".silentspeech"), file = path.join(dir, "actions.json");
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
  if (e.code !== "ENOENT") { console.log("FAILED: ~/.silentspeech/actions.json is not valid JSON (nothing saved)"); process.exit(1); }
  cfg = JSON.parse(fs.readFileSync("actions.example.json", "utf8"));
}
cfg.focus_music = { kind: "spotify", uri };
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const tmp = file + ".tmp";
fs.rmSync(tmp, { force: true });
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`Saved: focus_music plays ${uri}`);
'
