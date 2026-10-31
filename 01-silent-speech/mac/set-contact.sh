#!/bin/bash
# Asks Spiro for his own mobile number in a macOS box ON THE MAC, shows it back for a Yes / No check, and only on Yes
# writes it as the contact ("to") of text_mom, call_back and help in ~/.silentspeech/actions.json (mode 600).
# The number never goes in a command line (only in variables and the environment), a chat or the repo: the script
# prints only its last 2 digits. Other entries in the file are kept; with no file yet it starts from
# actions.example.json. 3 tries (a bad number or a No counts as one), at most about 9 minutes in all.
# Usage (SETUP.md Phase 2, step P4): ./set-contact.sh      (run it with a 10 minute timeout)
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "FAILED: node is missing (SETUP.md step 0.4)"; exit 1; }

# One node program, two modes (SS_MODE): check prints the number as + and digits (exit 3 if it is not one),
# save writes it. The number comes in through the environment (SS_NUM), never as an argument.
JS=$(cat <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const raw = (process.env.SS_NUM || '').trim();
const digits = raw.replace(/[^0-9]/g, '');
// Same rule as the app (ActionRunner.cleanContact): + and the country code, 8 to 15 digits, nothing else.
if (!/^\+[1-9][0-9 ().-]*$/.test(raw) || digits.length < 8 || digits.length > 15) process.exit(3);
const num = '+' + digits;
if (process.env.SS_MODE === 'check') { process.stdout.write(num); process.exit(0); }
const dir = path.join(os.homedir(), '.silentspeech');
const file = path.join(dir, 'actions.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { console.log('FAILED: ~/.silentspeech/actions.json is not valid JSON (nothing saved)'); process.exit(1); }
  cfg = JSON.parse(fs.readFileSync('actions.example.json', 'utf8'));
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.log('FAILED: actions.json is not a JSON object (nothing saved)'); process.exit(1); }
const texts = { text_mom: 'On my way!', call_back: "Can't talk now, call me back later", help: 'I need help right now' };
for (const action of Object.keys(texts)) {
  const old = cfg[action] && typeof cfg[action] === 'object' ? cfg[action] : {};
  cfg[action] = { ...old, kind: 'imessage', to: num, text: typeof old.text === 'string' && old.text ? old.text : texts[action] };
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
const tmp = file + '.tmp';
fs.rmSync(tmp, { force: true });
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`Saved: text_mom, call_back and help now text the number ending in ${digits.slice(-2)} (••${digits.slice(-2)})`);
NODE
)

ASK="Your own mobile number, with + and country code (for example +61 4xx xxx xxx):"
for TRY in 1 2 3; do
  if [ "$SECONDS" -gt 420 ]; then echo "Timed out: nothing saved."; exit 1; fi
  # The box text comes from the environment too, so nothing is pasted into the AppleScript source.
  if ! TYPED=$(SS_ASK="$ASK" osascript \
      -e 'display dialog (system attribute "SS_ASK") default answer "" with title "Silent Speech" buttons {"Cancel", "Next"} default button "Next" giving up after 120' \
      -e 'text returned of result' 2>/dev/null); then
    echo "Cancelled: nothing saved."
    exit 1
  fi
  set +e
  NUM=$(SS_MODE=check SS_NUM="$TYPED" node -e "$JS")
  CODE=$?
  set -e
  if [ "$CODE" = "3" ]; then
    echo "That did not look like + and a country code (try $TRY of 3)."
    ASK="That did not look right. Type it with + and the country code first (for example +61 4xx xxx xxx):"
    continue
  fi
  [ "$CODE" = "0" ] || exit "$CODE"
  # Show it back exactly as it will be used. Default is No; giving up counts as No.
  ANSWER=$(SS_NUM="$NUM" SS_TYPED="$TYPED" osascript \
      -e 'set shown to "Texts will go to " & (system attribute "SS_NUM") & "  (you typed: " & (system attribute "SS_TYPED") & "). Right?"' \
      -e 'button returned of (display dialog shown with title "Silent Speech" buttons {"No", "Yes"} default button "No" giving up after 120)' 2>/dev/null || true)
  if [ "$ANSWER" = "Yes" ]; then
    SS_MODE=save SS_NUM="$NUM" node -e "$JS"
    exit $?
  fi
  echo "Not confirmed (try $TRY of 3)."
  ASK="OK, let's try again. Your own mobile number, with + and country code (for example +61 4xx xxx xxx):"
done
echo "FAILED: no confirmed number after 3 tries, nothing saved."
exit 1
