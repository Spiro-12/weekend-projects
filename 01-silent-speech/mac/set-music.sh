#!/bin/bash
# Sets what focus_music plays in ~/.silentspeech/actions.json, touching only that entry and never printing the rest
# of the file (it holds Spiro's number). One argument:
#   ./set-music.sh "Focus"                                       a playlist in the Music library (Apple Music)
#   ./set-music.sh "https://music.apple.com/.../playlist/..."    an Apple Music link (or music://...)
#   ./set-music.sh "spotify:playlist:<id>"  or an open.spotify.com link: use Spotify instead
# Apple Music: a library playlist name is tried first, then the link (default: a public focus playlist), then the
# library on shuffle.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "FAILED: node is missing (SETUP.md step 0.4)"; exit 1; }
[ $# -eq 1 ] || { echo "Usage: ./set-music.sh \"<Music playlist name | music.apple.com link | spotify: URI>\""; exit 2; }
SS_MUSIC="$1" node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const raw = (process.env.SS_MUSIC || "").trim();
// Same rules as the app (ActionRunner.spotifyURI, appleMusicURL, cleanText).
const kinds = "(playlist|album|track|artist|show|episode)";
let entry = null, said = "";
const sp = new RegExp(`^https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?${kinds}/([A-Za-z0-9]{10,40})(\\?.*)?$`).exec(raw);
if (new RegExp(`^spotify:${kinds}:[A-Za-z0-9]{10,40}$`).test(raw) || sp) {
  const uri = sp ? `spotify:${sp[1]}:${sp[2]}` : raw;
  entry = () => ({ kind: "spotify", uri });
  said = `Spotify ${uri}`;
} else if (/^(https:\/\/music\.apple\.com\/|music:\/\/)[A-Za-z0-9._~:\/?#@!$&()*+,;=%-]{1,300}$/.test(raw)) {
  entry = (old) => ({ kind: "applemusic", ...(old.kind === "applemusic" && old.playlist ? { playlist: old.playlist } : {}), url: raw });
  said = `the Apple Music link ${raw}`;
} else if (/^(https?:|music:|spotify:)/i.test(raw)) {
  console.log("FAILED: links must be music.apple.com, music:// or Spotify (nothing saved)"); process.exit(1);
} else {
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (!name || name.length > 100) { console.log("FAILED: the playlist name is empty or over 100 characters (nothing saved)"); process.exit(1); }
  entry = (old) => ({ kind: "applemusic", playlist: name, ...(old.kind === "applemusic" && old.url ? { url: old.url } : {}) });
  said = `your Music playlist "${name}" (if it is missing: the focus playlist link)`;
}
const dir = path.join(os.homedir(), ".silentspeech"), file = path.join(dir, "actions.json");
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
  if (e.code !== "ENOENT") { console.log("FAILED: ~/.silentspeech/actions.json is not valid JSON (nothing saved)"); process.exit(1); }
  cfg = JSON.parse(fs.readFileSync("actions.example.json", "utf8"));
}
if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) { console.log("FAILED: ~/.silentspeech/actions.json is not a JSON object (nothing saved)"); process.exit(1); }
const old = cfg.focus_music && typeof cfg.focus_music === "object" ? cfg.focus_music : {};
cfg.focus_music = entry(old);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const tmp = file + ".tmp";
fs.rmSync(tmp, { force: true });
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`Saved: focus_music plays ${said}`);
'
