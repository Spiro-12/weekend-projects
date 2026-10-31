# SilentSpeechBridge: build, run, check (Mac)

For the Claude session on Spiro's Mac (Remote Control, `~/Documents/weekend-projects`). Claude runs every command.
Spiro only: clicks **Allow** on popups, types his Mac password once (step 3), puts his AirPods in (step 9).

Needs macOS 14+, Xcode (full Xcode, for `xcodebuild`), Homebrew, AirPods with head tracking.

## Build and run
1. `brew install xcodegen`
2. `cd ~/Documents/weekend-projects/01-silent-speech/mac && xcodegen`
   Makes `SilentSpeechBridge.xcodeproj` (git ignored). Run it again after a pull that adds files or changes `project.yml`.
3. **Once: a stable signing identity** named `SilentSpeech Local`, so macOS remembers the Motion and Automation
   permissions across rebuilds (ad hoc signing forgets them every build). Skip if this already prints it:
   `security find-identity -v -p codesigning | grep "SilentSpeech Local"`
   ```bash
   mkdir -p ~/.silentspeech/cert && cd ~/.silentspeech/cert
   cat > cert.cnf <<'EOF'
   [ req ]
   distinguished_name = dn
   x509_extensions = ext
   prompt = no
   [ dn ]
   CN = SilentSpeech Local
   [ ext ]
   basicConstraints = critical, CA:false
   keyUsage = critical, digitalSignature
   extendedKeyUsage = critical, codeSigning
   EOF
   /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config cert.cnf -keyout key.pem -out cert.pem
   /usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "SilentSpeech Local" -out local.p12 -passout pass:silentspeech
   security import local.p12 -k ~/Library/Keychains/login.keychain-db -P silentspeech -T /usr/bin/codesign
   security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem   # Spiro types his password once
   security find-identity -v -p codesigning | grep "SilentSpeech Local"
   cd ~/Documents/weekend-projects/01-silent-speech/mac
   ```
   Use `/usr/bin/openssl` (LibreSSL). A Homebrew OpenSSL 3 `.p12` is rejected by `security import` unless you add `-legacy`.
4. Build:
   ```bash
   xcodebuild -project SilentSpeechBridge.xcodeproj -target SilentSpeechBridge -configuration Debug build CODE_SIGN_IDENTITY="SilentSpeech Local"
   ```
   - No certificate yet: leave out `CODE_SIGN_IDENTITY=...` (ad hoc; works, but permissions are asked again after each rebuild).
   - xcodebuild refuses the identity: build unsigned, then sign:
     ```bash
     xcodebuild -project SilentSpeechBridge.xcodeproj -target SilentSpeechBridge -configuration Debug build CODE_SIGNING_ALLOWED=NO
     codesign --force --sign "SilentSpeech Local" --entitlements SilentSpeechBridge/SilentSpeechBridge.entitlements build/Debug/SilentSpeechBridge.app
     ```
   - Last resort: Spiro adds his Apple ID once in Xcode > Settings > Accounts (Personal Team), then build with
     `CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team id> CODE_SIGN_IDENTITY="Apple Development" -allowProvisioningUpdates`.
5. Check the signature: `codesign -dv build/Debug/SilentSpeechBridge.app 2>&1 | grep -E "Authority|Signature"`
   shows `Authority=SilentSpeech Local` (or `Signature=adhoc`).
6. Quit any old copy (`pkill -x SilentSpeechBridge`), then `open build/Debug/SilentSpeechBridge.app`.
   If macOS asks about Motion, Spiro clicks **Allow**. The window shows `Listening on ws://localhost:8765`.

## Test
7. **Simulate:** turn on **Simulate motion** in the app. Open the dashboard in Chrome:
   https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live (the app's "Open dashboard" link).
   Before Phase 1 is live on Pages: `cd 01-silent-speech && npm ci && npm run dev`, then open
   http://localhost:5173/weekend-projects/01-silent-speech/?mode=live. Expect ~50 Hz and "Dashboards open: 1" in the app.
   If Chrome asks to let the page reach apps on this device, Spiro clicks **Allow**.
8. **Security check** (Armed off, "Allow non browser clients" off, Simulate on). All must pass:
   - (a) `lsof -nP -iTCP:8765 -sTCP:LISTEN` lists only `127.0.0.1:8765` and/or `[::1]:8765`. `*:8765` = tell the lead.
   - (b) to (e): `cd ~/Documents/weekend-projects/01-silent-speech && npm ci && node mac/check-bridge.mjs`
     prints only `PASS` lines: (b) Origin `https://evil.example` rejected, (c) Origin `https://spiro-12.github.io`
     connects and gets `hello` then `status`, (d) no Origin rejected, (e) protocol: motion rate, unknown `type`
     ignored, broken JSON gives `bad_json`, unknown action gives `unknown_action`, an action is a dry run answered
     in under 1 s, the same action again gives `cooldown`. (It only sends actions when the app is not Armed.)
   - Toggle check: turn on "Allow non browser clients", run the script again: (d) now FAILs (it connects). Turn it off.
9. **Real AirPods:** Spiro puts both AirPods in; they must be the Mac's sound output. Turn Simulate off.
   Expect Headphones: Connected, Live rate 25 to 50 Hz, Gaps under 5 %. Watch 60 s with Chrome in front,
   then 60 s with another app in front (App Nap is off, so the rate should hold).

## Troubleshooting
- **Headphones "Not connected"**: AirPods must be connected to this Mac, be the current sound output
  (Control Center > Sound) and be in the ears. Take them out and put them back in.
- **Motion permission Denied**: System Settings > Privacy & Security, allow SilentSpeechBridge. Or
  `tccutil reset All com.spiro.SilentSpeechBridge`, relaunch, and Spiro clicks Allow again.
- **Automation (Phase 2 actions) stuck**: `tccutil reset AppleEvents com.spiro.SilentSpeechBridge`, relaunch.
- **"Port 8765 is in use"**: quit the other copy (`pkill -x SilentSpeechBridge`; `lsof -nP -iTCP:8765` shows who has it),
  then press **Retry** in the app.
- **Dashboard can't connect**: try Chrome if Safari blocks `ws://localhost`. The page's origin must be on the
  allowlist in `Protocol.swift` (Pages or localhost:5173/4173). The app's Log shows "Blocked a website: ..." if not.
- **See the log in Terminal**: run `build/Debug/SilentSpeechBridge.app/Contents/MacOS/SilentSpeechBridge` directly.
- **Actions (Phase 2)**: `mkdir -p ~/.silentspeech && cp actions.example.json ~/.silentspeech/actions.json`, then put the
  real numbers in that copy only (never in the repo). Phase 1 ignores it: every action is a dry run.
