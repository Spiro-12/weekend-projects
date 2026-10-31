# Silent Speech on AirPods: Plan

## Goal
Silently mouth one of ~6 short sentences while wearing AirPods Pro 3. A live web dashboard shows your jaw signal, recognizes the sentence, and does the action (skip song, send a text, ask an AI).
Visitors without AirPods can watch a replay of real recorded sessions.

## How it fits together
```
AirPods Pro 3 ──> Mac app (Swift, reads CMHeadphoneMotionManager)
                    └─ WebSocket server on localhost:8765
                          └─> Web dashboard (static, GitHub Pages)
                                ├─ live charts + 3D head
                                ├─ record / enroll samples
                                ├─ DTW classifier (JS, in browser)
                                └─ action when a sentence is recognized
```
Mac app instead of iPhone: no signing hassle, and the browser can talk to `ws://localhost` from an HTTPS page.

## Phase 1: Data pipe + "can we even see it?" (go / no go)
Parallel:
- **A. Mac app** (agent writes Swift, you build in Xcode): stream motion at full rate over WebSocket, show measured Hz.
- **B. Dashboard shell** (agent): live charts, 3D head, record button, saves labeled samples as JSON. Works with a fake data generator so it's testable without AirPods.
- **C. Classifier core** (agent): DTW + kNN in JS with unit tests on synthetic data.

**Test (you, 10 min):** run app, open dashboard, mouth "next song" silently 5 times.
- Pass = you can see a clear bump on the charts each time, and the rate is ~25 Hz.
- Fail = pivot to jaw gestures (clench, teeth taps), which papers show work at ~90%+.

## Phase 2: Collect data + pick the best model
- **You (~15 min):** record 6 sentences x 15 reps + 15 "none" samples in the dashboard. Export JSON into the repo.
Parallel:
- **A.** DTW + kNN leave one out accuracy.
- **B.** MiniRocket (Python, offline).
- **C.** Small 1D CNN with augmentation (Python, offline).

**Test:** confusion matrix for all 3. Pass = best model ≥ 80% on 6 sentences. If not, drop the most confused sentences and retest.

## Phase 3: Make it awesome
Parallel:
- **A.** Live recognition in the dashboard with big animated result + confidence + top 3 matches.
- **B.** Actions: music control, "text mom" via a share link, and send a sentence to an AI for a reply.
- **C.** Replay mode for visitors + project README + demo GIF + root README row.

**Test:** you do a 60 second live run end to end. Record it for the GIF.

## Phase 4: Stretch (only if time)
- Auto detect when you start mouthing (no push to talk).
- LibrePods private Bluetooth route for higher sample rate.
- Use the iPhone's own motion as a reference to cancel head movement (the MuteIt trick).

## Open decisions
- Final sentence list (draft below, pick in Phase 1).
- Which actions to wire up.

Draft sentences (different lengths and mouth shapes):
1. "Next song"
2. "Hey, what's up?"
3. "Text mom I'm on my way"
4. "Turn the volume up"
5. "Yes"
6. "Call me back later"
