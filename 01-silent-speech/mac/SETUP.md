# SilentSpeechBridge: build, run, check (Mac)

For the Claude Code session running on Spiro's Mac. **Claude runs every command and reads every result.**
Spiro only types his Mac password into macOS password boxes, clicks **Allow** / **Always Allow** on macOS popups,
and wears the AirPods. Never ask him to click anything in the app (one exception: in Phase 2 he turns on **Armed**
himself, as his deliberate OK), run commands or edit files. Before each popup, tell him in one plain sentence what is
about to appear and what to click.

Repo: `~/weekend-projects`. The app's log: `~/Library/Logs/SilentSpeechBridge.log` (new file each launch).
Read it with `grep -v '#pair='` (not `cat`): after `--print-pair-url` it holds the pairing link, which must never
show up in a chat.
**Quit the app when not in use (it keeps the Mac awake):** `pkill -x SilentSpeechBridge`.

## Get the code (first time)
`~/weekend-projects` is the folder Spiro shares with Claude. It may start empty.
```bash
cd ~/weekend-projects
if [ ! -d .git ]; then git init -q && git remote add origin https://github.com/Spiro-12/weekend-projects.git; fi
git fetch origin && git checkout -f -B main origin/main   # works even if Finder left a .DS_Store here
```
(If the lead says a phase branch is under test, use that branch instead of `main`.)

## 0. Prerequisites (check each, install only what is missing)
Password steps use `osascript ... with administrator privileges`: a normal macOS password box for Spiro, so the
session never sees or types the password. (In a session with a real terminal, plain `sudo` works too.)
1. **Command Line Tools** (enough to build, no Xcode needed): `xcode-select -p`. Missing: `xcode-select --install`,
   tell Spiro "a popup asks to install developer tools, click Install", wait until `xcode-select -p` works.
   **Full Xcode is optional** (about 15 GB; Spiro's Mac didn't have room). Only if `/Applications/Xcode.app` exists:
2. **Xcode license + first launch** (only with full Xcode), once (Spiro: password box):
   ```bash
   if xcodebuild -version >/dev/null 2>&1 && xcodebuild -checkFirstLaunchStatus; then echo "Xcode ready"; else
   osascript -e 'do shell script "xcode-select -s /Applications/Xcode.app/Contents/Developer && xcodebuild -license accept && xcodebuild -runFirstLaunch" with administrator privileges'; fi
   ```
3. **Homebrew**: `command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew`. Missing (Spiro: password box):
   ```bash
   PKG_URL=$(curl -fsSL https://api.github.com/repos/Homebrew/brew/releases/latest | grep -o 'https://[^"]*\.pkg' | head -1)
   curl -fsSL -o /tmp/Homebrew.pkg "$PKG_URL"
   osascript -e 'do shell script "installer -pkg /tmp/Homebrew.pkg -target /" with administrator privileges'
   ```
   If `brew` is not on PATH (new install, or a fresh shell), start each command with this line. It finds the prefix:
   `/opt/homebrew` on Apple silicon, `/usr/local` on Intel.
   ```bash
   for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
   ```
4. **Node + npm**: `command -v node || brew install node`
5. **XcodeGen** (only with full Xcode): `command -v xcodegen || brew install xcodegen`

## 1. Signing identity (once; safe to rerun)
A stable `SilentSpeech Local` identity makes macOS remember the Motion and Automation permissions across rebuilds.
Tell Spiro first: "Two Mac password boxes are coming. Type your password. When one says codesign wants to use a key,
click Always Allow."
```bash
cd ~/weekend-projects/01-silent-speech/mac && ./make-cert.sh
```
It must end with `OK: signing works.` On `FAILED`, run it again. If the identity is already fine there are no popups.

## 2. Build
**Default (no Xcode needed):**
```bash
cd ~/weekend-projects/01-silent-speech/mac && ./build.sh && codesign -dv build/Debug/SilentSpeechBridge.app 2>&1 | grep -E "Authority|Signature"
```
The build prints `OK: built ... (signed: SilentSpeech Local)`, then the codesign lines show `Authority=SilentSpeech Local`. This is how it was first built on Spiro's Mac (Oct 31).

**With full Xcode** (optional, same result):
```bash
cd ~/weekend-projects/01-silent-speech/mac && xcodegen && \
xcodebuild -quiet -project SilentSpeechBridge.xcodeproj -target SilentSpeechBridge -configuration Debug build CODE_SIGN_IDENTITY="SilentSpeech Local" && \
codesign -dv build/Debug/SilentSpeechBridge.app 2>&1 | grep -E "Authority|Signature"
```
Expect `Authority=SilentSpeech Local`. Rerun `xcodegen` after any pull that adds files or changes `project.yml`.
- xcodebuild refuses the identity: build unsigned, then sign. No `--deep`: the app is one executable with nothing
  nested inside (`ENABLE_DEBUG_DYLIB` is off). Add `--deep` only if `codesign --verify --strict` then complains about
  unsigned nested code.
  ```bash
  xcodebuild -quiet -project SilentSpeechBridge.xcodeproj -target SilentSpeechBridge -configuration Debug build CODE_SIGNING_ALLOWED=NO && \
  codesign --force --sign "SilentSpeech Local" --entitlements SilentSpeechBridge/SilentSpeechBridge.entitlements build/Debug/SilentSpeechBridge.app && \
  codesign --verify --strict build/Debug/SilentSpeechBridge.app && echo signed
  ```
- No identity at all: leave out `CODE_SIGN_IDENTITY=...` (ad hoc). Works, but macOS asks for permissions after every rebuild.
- Last resort: Spiro adds his Apple ID once in Xcode > Settings > Accounts; build with
  `CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team id> CODE_SIGN_IDENTITY="Apple Development" -allowProvisioningUpdates`.

## 3. Launch (always like this)
Launch options (read once at startup): `--simulate` = Simulate motion on, `--allow-no-origin` = "Allow non browser
clients" on (dev), `--print-pair-url` = write the dashboard link with `#pair=<token>` to the log file (Phase 2).
No option arms actions: Armed is off at every launch. `open --args` only reaches a fresh process,
so quit the old copy first and wait until it is gone:
```bash
cd ~/weekend-projects/01-silent-speech/mac && pkill -x SilentSpeechBridge; while pgrep -x SilentSpeechBridge >/dev/null; do sleep 0.2; done; open build/Debug/SilentSpeechBridge.app --args --simulate; sleep 3; grep -v '#pair=' ~/Library/Logs/SilentSpeechBridge.log
```
The log shows `Listening on ws://127.0.0.1:8765`, `Launch option --simulate` and `Pairing: token ready` (or, the
very first time, `Pairing: made a new token`).
First launch: tell Spiro "a popup may ask about Motion, click Allow".

## 4. Simulate + security check
App running with `--simulate` (step 3).
```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
cd ~/weekend-projects/01-silent-speech && npm ci && npx tsx mac/check-bridge.ts
```
- `lsof` shows only `127.0.0.1:8765`.
- Every line of the check is `PASS`: (a) lsof says 127.0.0.1 only, and the port is refused on each of the Mac's
  network addresses; (b) Origin `https://evil.example` rejected; (c) Origin `https://spiro-12.github.io` connects,
  gets `hello` from `SilentSpeechBridge`, then `status`; (d) no Origin rejected; (e) over 40 Hz with `seq` +1 each
  step, unknown `type` ignored, broken JSON gives `bad_json`, unknown action gives `unknown_action`, `volume_up` is a
  dry run answered in under 1 s, again gives `cooldown`, and every frame is valid protocol v1; (f) pairing: the
  token file is 32 hex, mode 600 in a 700 folder, and not in the log; no / empty / wrong token gives `unpaired`
  (also before `unknown_action` and during a cooldown), and an unpaired action does not use up the cooldown. It only
  sends `volume_up` (plus one made up action name), and only while the app says it is not Armed. It reads the token
  from `~/.silentspeech/token` and never prints it.
- Toggle check: relaunch (step 3) with `--args --simulate --allow-no-origin`, run
  `npx tsx mac/check-bridge.ts --expect-no-origin-open` (all PASS), then relaunch with `--args --simulate` again.
- Dashboard: `open -a "Google Chrome" "https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live"`
  (before Phase 1 is on Pages: `npm run dev` in `01-silent-speech`, then
  `http://localhost:5173/weekend-projects/01-silent-speech/?mode=live`). If Chrome asks to let the page reach apps
  on this device, Spiro clicks **Allow**. The log shows `Dashboard connected`; the dashboard shows about 50 Hz.

## 5. Real AirPods
1. Tell Spiro: "Put both AirPods in." They must be the Mac's sound output:
   `system_profiler SPAudioDataType | grep -B8 "Default Output Device: Yes"` should name the AirPods. If not:
   `brew install switchaudio-osx && SwitchAudioSource -a -t output` (find the name), then `SwitchAudioSource -t output -s "<AirPods name>"`.
2. Relaunch without options (step 3, ending in `open build/Debug/SilentSpeechBridge.app` with no `--args`).
3. `grep -E "Headphones|Motion" ~/Library/Logs/SilentSpeechBridge.log` shows `Headphones: connected`.
4. `npx tsx mac/check-bridge.ts` from `01-silent-speech`: all PASS, and the INFO line shows hz 25 to 55 and gapPct under 5 (AirPods Pro 3 measured 50 Hz, 0% gaps).
   Then put another app in front and wait, to prove App Nap is off:
   `open -a Finder && sleep 60 && cd ~/weekend-projects/01-silent-speech && npx tsx mac/check-bridge.ts`
   gives the same result.
5. Leave the app running for the dashboard, or quit it: `pkill -x SilentSpeechBridge`.

## Troubleshooting
- **Headphones not connected**: AirPods in both ears, connected to this Mac, current sound output (step 5.1).
  Ask Spiro to take them out and put them back in.
- **Motion permission denied** (log: `Motion permission: denied`): `tccutil reset All com.spiro.SilentSpeechBridge`,
  relaunch, tell Spiro to click **Allow** on the Motion popup.
- **Automation (Phase 2 actions) stuck**: `tccutil reset AppleEvents com.spiro.SilentSpeechBridge`, relaunch.
- **Port 8765 is in use** (log says so): `lsof -nP -iTCP:8765` shows who has it; `pkill -x SilentSpeechBridge` for an
  old copy. The app retries by itself every 2 s.
- **Dashboard can't connect**: the log shows `Blocked a website: <origin>` if its origin is not on the allowlist in
  `Protocol.swift`. Use Chrome if Safari blocks `ws://127.0.0.1`.
- **Keychain popup during a build**: rerun `./make-cert.sh` and have Spiro click **Always Allow**.
- **Actions (Phase 2)**: see "Phase 2" below. Real numbers go only in `~/.silentspeech/actions.json` (never in the repo).
- **Automation popup was answered Don't Allow** (log: `Not allowed to control Messages` / `Spotify`):
  `tccutil reset AppleEvents com.spiro.SilentSpeechBridge`, relaunch (step 3), fire the action again, Spiro clicks **OK**.
- **Calendar popup was answered Don't Allow** (log: `No calendar access`): `tccutil reset Calendar com.spiro.SilentSpeechBridge`,
  relaunch, fire `calendar` again, Spiro clicks **Allow Full Access**.
- **Text fails with "Can't get account"**: Messages on this Mac is not signed in to iMessage. Open Messages; signing in
  is an account step for Spiro (his Apple ID password).
- **Spotify: "did not start (player state: paused)"**: Spotify is not logged in, or the playlist is not available.
  Put another `uri` in `~/.silentspeech/actions.json` (a `spotify:playlist:...` URI or an `open.spotify.com` link).
- **Dashboard says "not paired"** (the app's log: `Refused an unpaired action`): open the dashboard again with the pair
  link (Phase 2, step P3). Each address (GitHub Pages, localhost) pairs on its own.

## Phase 2: pairing + real actions
Spiro's part: wear the AirPods, click **OK** / **Allow** on popups, turn on **Armed** himself, say yes before each
real text, and answer yes/no on what he heard and saw. Claude does the rest. Texts only ever go to the numbers in
`~/.silentspeech/actions.json`, and for now that is only Spiro's own number.

**P1. Build and launch** (use the branch the lead names, e.g. `p2`, instead of `main` while it is under test):
```bash
cd ~/weekend-projects && git fetch origin && git checkout -f -B p2 origin/p2
cd 01-silent-speech && npm ci && cd mac && ./build.sh
pkill -x SilentSpeechBridge; while pgrep -x SilentSpeechBridge >/dev/null; do sleep 0.2; done
open build/Debug/SilentSpeechBridge.app --args --simulate --print-pair-url; sleep 3
grep -v '#pair=' ~/Library/Logs/SilentSpeechBridge.log
```
Expect `Pairing: token ready` (or `Pairing: made a new token` the first time) and
`Launch option --print-pair-url: the pair link is in the log file`.

**P2. Token check.** Never `cat` the token, never paste it anywhere:
`stat -f '%Sp %N' ~/.silentspeech ~/.silentspeech/token` shows `drwx------` and `-rw-------`. Then
`cd ~/weekend-projects/01-silent-speech && npx tsx mac/check-bridge.ts`: every line PASS, including the `(f)` lines.

**P3. Pair the dashboard.** This opens the link without printing it:
```bash
URL=$(grep -o 'https://[^ ]*#pair=[0-9a-f]*' ~/Library/Logs/SilentSpeechBridge.log | tail -1)
[ -n "$URL" ] && open -a "Google Chrome" "$URL" && echo "opened the pair link"
```
(The app's "Open dashboard" link does the same.) Before Phase 2 is on Pages, use the dev server instead:
`npm run dev` in `01-silent-speech`, then
`open -a "Google Chrome" "http://localhost:5173/weekend-projects/01-silent-speech/?mode=live#pair=$(cat ~/.silentspeech/token)"`
(the shell fills in the token; nothing is printed). The dashboard keeps the token and removes it from the address bar.

**P4. Contacts.** Ask Spiro, in this Mac session only: "What is your own mobile number, the one your iPhone uses for
iMessage? I only use it on this Mac, to send test texts to yourself." Never commit it, never paste it into another
chat or the repo. Then (his number in place of the X's):
```bash
NUM='+1XXXXXXXXXX'
cd ~/weekend-projects/01-silent-speech/mac && sed "s/+15555550100/$NUM/g" actions.example.json > ~/.silentspeech/actions.json \
  && chmod 600 ~/.silentspeech/actions.json && grep -c -- "$NUM" ~/.silentspeech/actions.json
```
Expect `3` (text_mom, call_back and help all go to him). The app reads the file again before each armed action, so no
relaunch is needed. On the first armed action the log shows `Loaded actions.json: calendar, call_back, demo_48h,
focus_music, help, text_mom, volume_up`. `kind` must stay as in the example (the app skips an entry with another kind).

**P5. Armed (Spiro, by hand).** Tell him: "In the Silent Speech Bridge window, under Settings, click the switch next
to Armed so it turns on. That lets the app really do things. Click it again any time to stop." Never arm it any other
way (no launch option, no scripted clicks). Check: `grep "Armed:" ~/Library/Logs/SilentSpeechBridge.log | tail -1`
shows `Armed: actions from the paired dashboard will really run`. While Armed, `check-bridge.ts` refuses to run (on purpose).

**P6. Fire each action once,** from `~/weekend-projects/01-silent-speech`, AirPods in and set as the sound output
(step 5.1). `fire-action.ts` sends one paired action, prints the reply (it must say `REAL`), then prints the app's
log lines for it until `<action> done` or `<action> failed`. While a popup waits for a click, the app's window freezes
(the AppleScript waits for the answer): that is expected.

| # | Command (`npx tsx mac/fire-action.ts ...`) | Popup the first time (Spiro clicks) | Expected |
|---|---|---|---|
| 1 | `--action volume_up` | none | reply `Volume 40% to 55%` (any numbers 15 apart, max 100); the Mac's volume goes up |
| 2 | `--action demo_48h` | none | AirPods say "I created this demo in 48 hours"; log `demo_48h done: said it out loud` |
| 3 | `--action focus_music` | "Silent Speech Bridge wants access to control Spotify": **OK** | Spotify opens if needed and plays Deep Focus; log `focus_music done: Spotify is playing`. No Spotify: reply `Spotify is not installed on this Mac` (fine) |
| 4 | `--action calendar` | "would like full access to your calendar": **Allow Full Access** | reply `Working on it`, then the AirPods say one sentence about today; log `calendar done: N event(s) today, said a summary from the on device model` (or `the plain list` when Apple Intelligence is off) |
| 5 | `--action text_mom --yes-really` | "wants access to control Messages": **OK** | his iPhone gets "On my way!" from himself; log `text_mom done: sent to ••NN with Messages` |
| 6 | `--action call_back --yes-really` | none | text "Can't talk now, call me back later" |
| 7 | `--action help --yes-really` | none | alert sound, red "Help was asked for at ..." notice in the app window, text "I need help right now" |

Before **each** of 5, 6 and 7 ask Spiro: "I'm about to send a test text from your Mac to your own number. OK?" and
wait for his yes. Each texting action has its own 30 s cooldown (again sooner: `error cooldown`, expected); the others 3 s.
Script for Spiro while testing: "Keep both AirPods in. You'll hear a sentence, then music, then a sentence about your
calendar, and get 3 texts from yourself. After each one, tell me yes or no: did it happen?" For 4, also ask what he
heard and whether it matches his calendar; for 7, whether he heard the alert and saw the red notice.

**P7. Disarm and finish.** Relaunch without Armed (step 3: Armed is off at every launch), then
`npx tsx mac/fire-action.ts --action volume_up` must say `dry run`. Report every row of P6 to the lead (reply text,
the log's `done` / `failed` line, Spiro's yes/no), with phone numbers masked like the log does (`••NN`).
