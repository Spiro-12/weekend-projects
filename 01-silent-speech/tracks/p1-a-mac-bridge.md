# Track A: Mac bridge app (SilentSpeechBridge)

## Goal
A tiny macOS 14+ SwiftUI app that reads AirPods Pro 3 head motion with `CMHeadphoneMotionManager` and streams it over a WebSocket server on `ws://localhost:8765`, exactly per `PROTOCOL.md` §2. It also receives action requests (stub runner this phase).

**Important:** the agent writing this cannot compile Swift (Linux container). The lead compiles it on GitHub CI (macOS job in `.github/workflows/ci.yml`, `xcodebuild -target SilentSpeechBridge CODE_SIGNING_ALLOWED=NO`) and on Spiro's Mac through Remote Control. Spiro is not technical and never builds anything himself. So: small files, stable APIs, no clever generics, no third party packages. Write it like it must compile on the first try. Swift language mode 5 (avoid Swift 6 strict concurrency errors).

## Owns
`mac/project.yml`, `mac/SETUP.md`, `mac/actions.example.json`, `mac/SilentSpeechBridge/{App,ContentView,MotionStreamer,WebSocketServer,ActionRunner}.swift`, `Info.plist`, `SilentSpeechBridge.entitlements`. Read only: `mac/SilentSpeechBridge/Protocol.swift` (use its types, don't change it).

## Build
- **XcodeGen** `project.yml`: macOS app, deployment target 14.0, bundle id `com.spiro.SilentSpeechBridge`, `SWIFT_VERSION: 5.0`, `ENABLE_HARDENED_RUNTIME: NO`, App Sandbox **off** (entitlements file with `com.apple.security.app-sandbox = false`), `CODE_SIGN_STYLE: Automatic`, `DEVELOPMENT_TEAM` left empty (Spiro picks his Personal Team in Xcode), `INFOPLIST_FILE` pointing at our Info.plist.
- Info.plist: `NSMotionUsageDescription` ("Reads your AirPods head motion to recognize silent speech."), `NSAppleEventsUsageDescription` ("Sends texts, changes volume and plays music when you silently say a command.").

## Files
- **MotionStreamer.swift**: `CMHeadphoneMotionManager` + `CMHeadphoneMotionManagerDelegate` (connect / disconnect). `startDeviceMotionUpdates(to: OperationQueue)`. Per sample build a `MotionMessage` (seq += 1, `t = motion.timestamp`, quaternion w,x,y,z, rotationRate, userAcceleration, gravity), all through `r5`. Map `sensorLocation` → `BudLocation`, `CMHeadphoneMotionManager.authorizationStatus()` → `AuthState`, `isDeviceMotionAvailable` false → `unavailable`. Measures hz (samples in last 2 s / 2) and gapPct (intervals > 60 ms over last 10 s). **Simulate motion** mode: a Timer at 25 Hz making sine wave samples (so the WebSocket can be tested without AirPods); `status.simulated = true`.
- **WebSocketServer.swift**: `NWListener` with `NWProtocolWebSocket.Options` (`autoReplyPing = true`) on port 8765, `params.requiredInterfaceType = .loopback`, `allowLocalEndpointReuse = true`. Origin check in `setClientRequestHandler`: accept if Origin missing or in `ProtocolV1.allowedOrigins`, else reject. Track connections; on new connection send `hello` then `status`. `broadcast(text:)` for motion. Receive loop: decode with `ProtocolCoding.decodeRequest`; invalid → `error bad_json`; unknown action → `unknown_action`; within 3 s of last run of same action → `cooldown`; else call `ActionRunner` and reply `actionResult`. Send status every 1 s. Handle listener failure (port in use) by showing it in the UI.
- **ActionRunner.swift**: action keys = `["text_mom","volume_up","call_back","demo_48h","help","calendar","focus_music"]`. This phase: always dry run → `ok:true, dryRun:true, message:"Dry run: <action>"`. Structure it so Phase 2 can add real kinds (imessage, volume, music, shortcut, say). Loads `~/.silentspeech/actions.json` if present (ignore errors). `actions.example.json` shows the future shape: `{ "text_mom": { "kind": "imessage", "to": "+15555550100", "text": "On my way!" }, ... }`.
- **App.swift**: `@main` App, one window. `ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason:)` so App Nap doesn't stop streaming in the background.
- **ContentView.swift**: shows headphones state, auth, bud, live Hz, gap %, clients count, port status; toggles **Simulate motion** and **Armed** (off by default; armed changes go out in `status` and future `hello`); last 20 log lines (connections, actions). A "Open dashboard" link to `https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live`.
- Keep everything on the main actor / main queue where it touches UI state. Use `DispatchQueue.main.async` from the motion queue and NWConnection callbacks.

## SETUP.md (for the lead, who runs it on Spiro's Mac; short, numbered)
`brew install xcodegen` → `cd mac && xcodegen` → `xcodebuild -project SilentSpeechBridge.xcodeproj -target SilentSpeechBridge -configuration Debug build` (sign to run locally, `CODE_SIGN_IDENTITY=-`) → `open build/Debug/SilentSpeechBridge.app` → Spiro clicks Allow on Motion. Test: Simulate on, open the dashboard with `?mode=live`, see ~25 Hz. Then AirPods in, Simulate off. Troubleshooting: AirPods must be the Mac's audio output and in ear; `tccutil reset AppleEvents com.spiro.SilentSpeechBridge`; port in use → quit other copy; try Chrome if Safari blocks ws://localhost.

## Gate
No compiler here, so:
1. Self review every file against `Protocol.swift` field names and `shared/fixtures/ws-messages.jsonl`.
2. Double check every Apple API name and signature you use (CoreMotion, Network.framework `NWProtocolWebSocket.Options.setClientRequestHandler`, `NWProtocolWebSocket.Metadata`, `NWConnection.ContentContext`). If unsure of an API, use a simpler one you are sure of.
3. `project.yml` must work with `xcodebuild -target SilentSpeechBridge` (no shared scheme needed) and with `CODE_SIGNING_ALLOWED=NO`.
4. In your report list any API you are less than sure about, so the lead knows where a compile error is likely.
