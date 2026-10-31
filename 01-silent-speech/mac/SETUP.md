# SilentSpeechBridge: build, run, check (Mac)

For the Claude Code session running on Spiro's Mac. **Claude runs every command and reads every result.**
Spiro only types his Mac password into macOS password boxes, clicks **Allow** / **Always Allow** on macOS popups,
and wears the AirPods. Never ask him to click anything in the app, run commands or edit files. Before each popup,
tell him in one plain sentence what is about to appear and what to click.

Repo: `~/weekend-projects`. The app's log: `~/Library/Logs/SilentSpeechBridge.log` (new file each launch).
**Quit the app when not in use (it keeps the Mac awake):** `pkill -x SilentSpeechBridge`.

## Get the code (first time)
`~/weekend-projects` is the folder Spiro shares with Claude. It may start empty.
```bash
cd ~/weekend-projects && if [ ! -d .git ]; then git clone https://github.com/Spiro-12/weekend-projects.git . ; fi
git fetch origin && git checkout p1 && git pull --ff-only   # Phase 1 work lives on branch p1 until it is merged to main
```
(After Phase 1 merges, use `main` instead of `p1`.)

## 0. Prerequisites (check each, install only what is missing)
Password steps use `osascript ... with administrator privileges`: a normal macOS password box for Spiro, so the
session never sees or types the password. (In a session with a real terminal, plain `sudo` works too.)
1. **Xcode** (full Xcode, not only the command line tools): `ls -d /Applications/Xcode.app`.
   Missing: `open "macappstore://apps.apple.com/app/id497799835"`, ask Spiro to click **Get** / **Install**
   (his Apple ID, about 10 GB), wait until `/Applications/Xcode.app` exists.
2. **Xcode license + first launch**, once (Spiro: password box):
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
5. **XcodeGen**: `command -v xcodegen || brew install xcodegen`

## 1. Signing identity (once; safe to rerun)
A stable `SilentSpeech Local` identity makes macOS remember the Motion and Automation permissions across rebuilds.
Tell Spiro first: "Two Mac password boxes are coming. Type your password. When one says codesign wants to use a key,
click Always Allow."
```bash
cd ~/weekend-projects/01-silent-speech/mac && ./make-cert.sh
```
It must end with `OK: signing works.` On `FAILED`, run it again. If the identity is already fine there are no popups.

## 2. Build
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
clients" on (dev). No option arms actions: Armed is off at every launch. `open --args` only reaches a fresh process,
so quit the old copy first and wait until it is gone:
```bash
cd ~/weekend-projects/01-silent-speech/mac && pkill -x SilentSpeechBridge; while pgrep -x SilentSpeechBridge >/dev/null; do sleep 0.2; done; open build/Debug/SilentSpeechBridge.app --args --simulate; sleep 3; cat ~/Library/Logs/SilentSpeechBridge.log
```
The log shows `Listening on ws://127.0.0.1:8765` and `Launch option --simulate`.
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
  dry run answered in under 1 s, again gives `cooldown`, and every frame is valid protocol v1. It only sends
  `volume_up`, and only while the app says it is not Armed.
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
4. `npx tsx mac/check-bridge.ts` from `01-silent-speech`: all PASS, and the INFO line shows hz 25 to 50 and gapPct under 5.
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
- **Actions (Phase 2)**: `mkdir -p ~/.silentspeech && cp actions.example.json ~/.silentspeech/actions.json`, then real
  numbers go in that copy only (never in the repo). Phase 1 ignores it: every action is a dry run.
