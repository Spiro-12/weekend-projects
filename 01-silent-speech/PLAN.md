# Silent Speech on AirPods: Build Plan

## Context
Weekend project 01 for `Spiro-12/weekend-projects`. Research (see `01-silent-speech/RESEARCH.md`) says AirPods only expose a head motion sensor (~25 Hz, one bud, native app only), and a 2025 paper got 91% word accuracy from that kind of signal. So we treat each whole sentence as one class: mouth one of 7 sentences silently, recognize it, and **do the real thing on the Mac**. Hook: "$0 silent speech on the AirPods you already own" vs Subvocal's $499 glasses and Apple's $2B Q.ai buy. Nobody has open sourced this yet.

Time: Saturday + Sunday. Lots of parallel agents. Spiro does physical tests and Xcode builds; agents do everything else.

## Who does what (updated)
Spiro is not technical. Claude reviews, merges, installs and builds (on his Mac through Remote Control). Spiro only does physical things. This overrides the "You" steps below.

| Phase | Claude | Spiro |
|---|---|---|
| 0 | Review, CI, merge, install xcodegen on the Mac | Set up Remote Control once (2 min) |
| 1 | Build + fix the Mac app on his Mac and on GitHub's Macs (CI) | AirPods in, click Allow on popups, ~3 min pilot |
| 2 | Write `~/.silentspeech/actions.json` on his Mac (numbers asked in chat, never in the repo). Calendar: Mac app reads Calendar, summarizes with Apple's on device AI (Foundation Models), speaks it. No Shortcut | ~40 min of recording |
| 3 | Record the screen, export the replay, make the GIF, commit | 90 s demo run |

Every PR goes through the ship checklist in the root `CLAUDE.md` before merge.

## Sentences and what they do
| id | Sentence | Real action on the Mac |
|---|---|---|
| `text_mom` | Text mom I'm on my way | iMessage "On my way!" to Mom |
| `volume_up` | Turn the volume up | System volume +15% |
| `call_back` | Call me back later | iMessage "Can't talk now, call me back later" to a set contact |
| `demo_48h` | I created this demo in 48 hours | Mac **speaks the sentence out loud** + confetti on the dashboard (the closing shot of the video) |
| `help` | I need help right now | iMessage "I need help right now" to emergency contact + red full screen alert + alarm. Never calls 911 |
| `calendar` | What's on my calendar today? | Mac app reads today's events (EventKit), summarizes with Apple's on device AI (Foundation Models), speaks it in your AirPods. Fallback: plain readout |
| `focus_music` | Play my focus music | Plays your "Focus" playlist in Music (or Spotify) |
| `none` | still / swallow / nod / glance | nothing |

Phone numbers and playlist names live only on the Mac in `~/.silentspeech/actions.json` (never committed; public repo). The browser can only ask for an action by id.

Risk: 4 sentences are ~5 syllables. If they get confused in Phase 2, we tweak wording or drop the worst one. Ids stay fixed, so wording changes are one line.

## How it fits together
```
AirPods Pro 3 → Mac app "SilentSpeechBridge" (Swift)
                  ├ reads CMHeadphoneMotionManager
                  ├ WebSocket server ws://127.0.0.1:8765 (loopback only, origin allowlist)
                  └ runs actions (AppleScript, Shortcuts, say)
                        ⇅ JSON
Web dashboard (Vite + TS, static on GitHub Pages)
  live charts · 3D head · enroll/record · DTW classifier · result + actions · replay for visitors
Python bench (offline): DTW vs MiniRocket vs 1D CNN, honest accuracy numbers
```

## Folder layout
```
01-silent-speech/
  README.md RESEARCH.md PLAN.md PROTOCOL.md
  package.json vite.config.ts  (root web/, base /weekend-projects/01-silent-speech/, outDir dist/)
  shared/classes.json  shared/fixtures/
  web/src/{core,sources,panels,ml}/  web/public/{models,replay,results}/
  tests/{unit,e2e}/ tests/mock-bridge.ts   scripts/
  mac/ (XcodeGen project.yml + 6 Swift files + SETUP.md + actions.example.json)
  ml/ (uv Python project)   data/raw/ (your recordings)
  tracks/ (one brief per agent track)
```
`scripts/build-site.sh` already builds it, no change. `pages.yml` bumps Node 20 → 22.

Panels and data sources auto load (`import.meta.glob`), so each UI agent only adds its own files and never edits a shared one. That's what lets 5 agents work at once without stepping on each other.

## Contracts (frozen in Phase 0, written in full to `PROTOCOL.md`)
- **WebSocket** (JSON, `v:1`). Mac → browser: `hello` (actions list, armed), `status` every 1 s (headphones, auth, bud, hz, gapPct), `motion` per sample `{seq, t, q[4], rr[3], ua[3]}`, `actionResult`. Browser → Mac: `action {id, action, confidence}`. Actions dry run unless "Armed" is on in the Mac app; 3 s cooldown.
- **Dataset file** `ss-dataset v1`: session info + clips `{label, rep, pressT, releaseT, samples[]}`. **Replay file** `ss-session v1`: continuous samples + push to talk events + ground truth.
- **Preprocessing v1** (same in JS and Python): resample to a 50 Hz grid → rotationRate + userAcceleration (6 ch) → 1 Hz high pass → resample to 64 points → z score.
- **Classifier API** (`web/src/ml/index.ts`): `train`, `loadModel`, `predict → {label, confidence, accepted, top3}`, `evaluate(loo|loso)`. Any winning model implements the same interface.
- **Fake data generator** (`synth.ts`, seeded): fake jaw bursts per class so every track is testable with no AirPods.

## Phases
Each track = one agent in its own git worktree + branch, owning only its files. Each track gets a self contained brief in `tracks/`, so I can spawn it or you can hand it to one of your own Claude sessions. Track branches merge into a phase branch → **one PR per phase** → you merge to main → deploys.

### Phase 0: Contracts + skeleton (me, ~1 h) · Saturday morning
- Me: `PROTOCOL.md`, `classes.json`, TS types + validators, `synth.ts`, fixtures, app shell (Space = push to talk, ring buffer, auto loading), fake source, `Protocol.swift`, all npm deps installed once, Playwright + mock bridge setup, Node 22, `.gitignore`, track briefs.
- **You meanwhile (15 min):** `brew install xcodegen`, make AirPods the Mac's sound output.
- **Gate (auto):** typecheck + unit tests pass, fake mode e2e shows ≥40 samples in 2 s, `build-site.sh` builds the right base path. **PR #1** → you merge → Pages live.

### Phase 1: Data pipe + core, 5 agents in parallel · Saturday
| Track | Builds | Auto gate |
|---|---|---|
| A Mac bridge | Motion streaming, WebSocket server, Hz/gap meter, **"Simulate motion" toggle**, Armed toggle, stub actions, SETUP.md | Can't compile here: I review against `Protocol.swift` + fixtures |
| B Live + viz | WebSocket source with reconnect, status panel, 6 channel live chart, 3D head | Against mock bridge: connects, 23 to 27 Hz, 0 bad messages, reconnects |
| C Enroll | Guided recording (shuffled prompts, Space to record, redo), autosave, export JSON, live accuracy + mini confusion matrix | Fake mode: 9 clips recorded, export valid |
| D DTW | Preprocess, DTW, kNN, evaluate, CLI, model export | Synthetic accuracy ≥95%, predict <20 ms |
| E Python bench | uv project, loaders, DTW + MiniRocket + CNN, reports | pytest passes, synthetic ≥90%, JS and Python DTW agree |

**You (~1 h):** `xcodegen`, build in Xcode with your free Personal Team, paste any errors to me (expect 1 to 3 rounds). Test "Simulate motion", then real AirPods. Open the Pages URL in Chrome, check 23 to 27 Hz (or 45 to 55 Hz) and <5% gaps for 60 s with Chrome in front. Then pilot: 3 classes × 5 reps (~3 min), export to `data/raw/pilot.json`.

**GO / NO GO:**
- **GO:** clear bumps every rep, pilot accuracy ≥80% (chance 33%) → Phase 2.
- **MAYBE (50 to 80%):** exaggerate jaw, try ANC off, I tune settings on the pilot data, retest.
- **NO GO (<50% or flat lines):** swap `classes.json` to jaw gestures (clench, teeth taps, open wide). Nothing else changes.

**PR #2** after GO.

### Phase 2: Real data + model shootout + actions, 6 agents in parallel · Saturday night / Sunday morning
**You (~40 min):** record 3 sessions × 7 sentences × 5 reps + none (AirPods out and in between sessions). Push `data/raw/s1..s3.json`. Fill in `~/.silentspeech/actions.json` (use **your own number** as "Mom" at first). Build the "Silent Calendar" Shortcut (I'll give exact steps).

Product tracks start right away (they don't need data); model tracks start when data lands.
| Track | Builds |
|---|---|
| F DTW tuning | Sweeps channels / length / band / k, picks the "none" threshold (≤5% false triggers) |
| G MiniRocket | Leave one out + leave one session out scores |
| H 1D CNN | Same, with augmentation (10 min cap on torch install, else skip) |
| I Mac actions | iMessage, volume, music, Shortcuts, `say`, help alert, Test buttons, cooldown, log |
| J Result panel | Big animated sentence, confidence ring, top 3, "not sure" state, sends action, confetti + red alert UI |
| K Replay | Visitor mode: plays a recorded session when no bridge is found, marks right/wrong, fake action toasts; session recorder |

**Gate (auto):** all e2e pass (right label, `none` fires nothing, exactly one action per prediction, replay ≥90% on synthetic, visitor fallback works). `RESULTS.md` with 3 models × 2 test styles.
**Gate (you):** each action fires when Armed, nothing when not. **Pass = best model ≥80%** (headline number is leave one session out). If not, drop the most confused sentence and rerun. **PR #3.**

### Phase 3: Integrate + ship, 3 agents in parallel · Sunday
| Track | Builds |
|---|---|
| L Port (only if a Python model beats DTW by ≥5 pts) | Hand written TS forward pass + parity test. Otherwise skipped |
| M Publish | Final model to `web/public/models/`, "How well does it work?" panel with real numbers |
| N Docs | Project README (hook, live link, GIF, what/why/how), root README row |

**You (~45 min):** 60 to 90 s live run with the recorder on (each sentence twice, ending on "I created this demo in 48 hours"). Export to `web/public/replay/demo-session.json`. Screen record → GIF.
**Gate:** Pages URL on your iPhone plays the replay; on the Mac live, ≥6 of 7 sentences work and fire. **PR #4** → ship.

### Phase 4: Stretch (only if time left)
Auto detect when you start mouthing (no Space key), iPhone bridge, LibrePods route for faster data, cancel head motion.

## Top risks
| Risk | Fallback |
|---|---|
| Motion stops when Mac app isn't in front | App Nap off; else load the dashboard inside the Mac app (WKWebView) |
| No motion on macOS at all | iOS target from the same Swift files + dashboard on the Mac's local dev server |
| Browser blocks ws://localhost from https | Use Chrome + allow local network prompt; else local dev server |
| macOS permissions (Automation, Motion) | No sandbox; sign with a stable local self signed identity so permissions stick across rebuilds (fallback: his Apple ID once) |
| Weak signal / confusion | Exaggerate jaw, ANC off, settings sweep, drop/rename sentences, jaw gesture pivot |
| A random website trying to send your texts | Loopback only, origin allowlist, action ids only, Armed off by default, cooldown |
| I can't compile Swift | 6 small files, stable APIs, Simulate toggle, quick paste errors loop |

## Verification (end to end)
1. `npm ci && npm run typecheck && npm test && npx playwright test` in `01-silent-speech/` (fake source + mock bridge, headless Chromium).
2. `uv run pytest && uv run python -m silent.report` in `ml/`.
3. `bash scripts/build-site.sh` → `_site/01-silent-speech/` has the right asset paths.
4. Manual: Mac app + AirPods → Pages URL in Chrome → mouth each sentence → right label + real action. iPhone with no bridge → replay plays.

## First step after approval
Update `01-silent-speech/PLAN.md` with this plan, then start Phase 0 on branch `p0-skeleton`.

## Follow ups found in Phase 1 reviews (do in Phase 2)
- **Pairing before real actions:** the Mac app trusts every page on `spiro-12.github.io` and local dev servers. Before Armed can send real texts, add pairing (Mac app shows a code, dashboard stores it, actions must carry it).
- **LOO confidence parity:** if Track D's fast LOO path computes dRef with all-clip norm stats, port the same shortcut to Python `dtw-py` and add a LOO snapshot test (LOSO stays exact and is the published headline).
- **report.py:** tag every row of a dataset group as synthetic when any row is; compare datasets by session ids / clip id hash, not file name.
- **Phase 2 tuning:** track "correct accepted" rate, not only none false accepts; recheck dRef factors (1.7 / 0.1 / 1.25) and the threshold on real data; watch quiet (0.5x amplitude) speakers.
- **Never auto retry** an action that returned `timeout` or `disconnected` (outcome unknown).
- Track B nits: hovering a stale chart with a still mouse redraws 60/s; DPR change while idle; head angle text keeps last values after a source switch; tests don't count draws (idle) or check canvas label thinning.
