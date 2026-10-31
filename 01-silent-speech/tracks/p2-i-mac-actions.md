# Track I: real actions + pairing in the Mac app

## Goal
Make the 7 sentences do real things on Spiro's Mac, safely: only when Armed, only from the paired dashboard, texts only to the numbers in `~/.silentspeech/actions.json` (for now: Spiro's own number).

## Owns
`mac/**` except `mac/SilentSpeechBridge/Protocol.swift` (lead; it already has `token` on `ActionRequest`, `ErrorCode.unpaired`, `ProtocolV1.tokenPath`).

## Build
1. **Pairing** (PROTOCOL §2): on launch, read or create `~/.silentspeech/token` (32 lowercase hex from `SecRandomCopyBytes`, dir 0700, file 0600). Every `action` must carry the matching token (constant time compare) or gets `error unpaired`, checked first. "Open dashboard" link and a new `--print-pair-url` launch option (prints the full URL with `#pair=` to the log, nothing else) so the Claude session on the Mac can open it. Never log the token anywhere else.
2. **ActionRunner** real kinds, only when Armed (else dry run as today). Config `~/.silentspeech/actions.json` (update `actions.example.json`):
   - `text_mom`, `call_back`, `help`: `{ "kind": "imessage", "to": "+1...", "text": "..." }` via `NSAppleScript` to Messages on the main thread (escape quotes and backslashes; `help` also plays an alert sound and shows a notice in the window). Missing `to` → `ok:false`, "No contact set for <action>".
   - `volume_up`: `{ "kind": "volume", "step": 15 }` via AppleScript `set volume output volume`.
   - `focus_music`: `{ "kind": "spotify", "uri": "spotify:playlist:..." }` (default: a public focus playlist URI) via AppleScript to Spotify; Spotify missing → `ok:false` with a clear message.
   - `demo_48h`: `{ "kind": "say", "text": "I created this demo in 48 hours" }` via `AVSpeechSynthesizer` (plays through the AirPods).
   - `calendar`: EventKit full access (add `NSCalendarsFullAccessUsageDescription`), today's events; on macOS 26 with `#if canImport(FoundationModels)` + availability check, a one sentence friendly summary from the on device model; otherwise a plain readout ("You have 3 things today: ..."). Speak it. Reply `Working on it` within 1 s (existing watchdog), finish in the background.
   - Keep cooldowns (3 s, 30 s for texts). Log every real action (no phone numbers in the log: mask all but last 2 digits).
3. **`mac/fire-action.ts`** (run with `npx tsx` from `01-silent-speech`): sends one paired action to the real app (`--action volume_up`), prints the result. Refuses messaging actions unless `--yes-really` is given. Used by the Mac session to test each action without speaking.
4. **check-bridge.ts**: pairing checks (no token → unpaired, wrong → unpaired, right → dry run when not Armed).
5. **SETUP.md**: a Phase 2 section for the Mac session: write `actions.json` by asking Spiro **on the Mac** for his own number (never commit it, never paste it into another chat); expected popups (Automation for Messages / Spotify / System Events, Calendar); Spiro clicks Armed himself; fire each action once with fire-action.ts; expected results.

## Gate
CI Mac job green (xcodebuild + build.sh), zero warnings. List anything you're unsure about (AppleScript to Messages on macOS 26, Spotify scripting, Foundation Models API names) so the real test on Spiro's Mac checks it.
