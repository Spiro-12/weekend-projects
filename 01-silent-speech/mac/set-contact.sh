#!/bin/bash
# Asks Spiro for his own mobile number in a macOS dialog ON THE MAC, so no chat and no command line ever holds it,
# and writes it as the contact ("to") of text_mom, call_back and help in ~/.silentspeech/actions.json (mode 600).
# Other entries are kept; with no file yet it starts from actions.example.json. Prints only the masked number (••67).
# Usage (SETUP.md Phase 2, step P4): ./set-contact.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "FAILED: node is missing (SETUP.md step 0.4)"; exit 1; }

PROMPT="Your own mobile number, with + and country code (example +61 412 345 678):"
for TRY in 1 2 3; do
  # The number only ever lives in this variable and the environment of the node step below (not its arguments).
  if ! NUM=$(osascript -e "text returned of (display dialog \"$PROMPT\" default answer \"\" with title \"Silent Speech\" buttons {\"Cancel\", \"Save\"} default button \"Save\" giving up after 300)" 2>/dev/null); then
    echo "Cancelled: nothing saved."
    exit 1
  fi
  set +e
  SS_NUM="$NUM" node - <<'JS'
const fs = require('fs');
const os = require('os');
const path = require('path');
const raw = (process.env.SS_NUM || '').trim();
const digits = raw.replace(/[^0-9]/g, '');
// Same rule as the app (ActionRunner.cleanContact): + and the country code, 8 to 15 digits, no other characters.
if (!/^\+[1-9][0-9 ().-]*$/.test(raw) || digits.length < 8 || digits.length > 15) process.exit(3);
const dir = path.join(os.homedir(), '.silentspeech');
const file = path.join(dir, 'actions.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { console.log('FAILED: ~/.silentspeech/actions.json is not valid JSON (nothing saved)'); process.exit(1); }
  cfg = JSON.parse(fs.readFileSync('actions.example.json', 'utf8'));
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.log('FAILED: actions.json is not a JSON object'); process.exit(1); }
const texts = { text_mom: 'On my way!', call_back: "Can't talk now, call me back later", help: 'I need help right now' };
for (const action of Object.keys(texts)) {
  const old = cfg[action] && typeof cfg[action] === 'object' ? cfg[action] : {};
  cfg[action] = { ...old, kind: 'imessage', to: '+' + digits, text: typeof old.text === 'string' && old.text ? old.text : texts[action] };
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
const tmp = file + '.tmp';
fs.rmSync(tmp, { force: true });
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`Saved: text_mom, call_back and help now text the number ending in ${digits.slice(-2)} (••${digits.slice(-2)})`);
JS
  CODE=$?
  set -e
  NUM=""
  [ "$CODE" = "0" ] && exit 0
  [ "$CODE" != "3" ] && exit "$CODE"
  echo "That did not look like + and a country code (try $TRY of 3)."
  PROMPT="That did not look right. Type it with + and the country code first (example +61 412 345 678):"
done
echo "FAILED: no valid number after 3 tries, nothing saved."
exit 1
