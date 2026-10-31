# Silent Speech Protocol v1

The contracts every part follows. **Frozen after Phase 0.** Only the lead changes them, in one commit that updates this file, `web/src/core/contracts.ts`, `mac/SilentSpeechBridge/Protocol.swift` and `shared/fixtures/*` together.

Source of truth for types: `web/src/core/contracts.ts`. Validators: `web/src/core/validate.ts`. Examples: `shared/fixtures/`.

## 1. Classes
`shared/classes.json`: `[{ id, sentence, action }]`. Ids are fixed; sentence wording can change. `none` has `action: null`.

## 2. WebSocket (`ws://localhost:8765`, JSON text frames)

Mac → browser:
| type | when | fields |
|---|---|---|
| `hello` | once on connect | `v:1, app, version, actions[], armed` |
| `status` | every 1 s + on change | `headphones (connected/disconnected/unavailable), auth (authorized/denied/notDetermined/restricted), loc (left/right/default/unknown), hz, gapPct, clients, armed, simulated` |
| `motion` | every sample (~25 Hz, not batched) | `seq, t, q[w,x,y,z], rr[3] rad/s, ua[3] g, g?[3]` |
| `actionResult` | reply to `action` | `id, action, ok, dryRun, message, error?, ms` |
| `error` | bad request | `code (bad_json/unknown_action/cooldown/not_armed), message, id?` |

Browser → Mac:
| type | fields |
|---|---|
| `action` | `id, action, label, confidence` |

Rules:
- `seq` goes up by 1 per sample. A jump = dropped samples. `t` = `CMLogItem.timestamp`.
- `hz` = samples in the last 2 s / 2. `gapPct` = % of intervals > 60 ms in the last 10 s.
- Numbers rounded to 5 decimals. Unknown `type`: ignore it.
- Server listens on **loopback only**. Origin must be one of `https://spiro-12.github.io`, `http://localhost:5173`, `http://localhost:4173`, or missing (CLI tools). Anything else is rejected at the handshake.
- `action` must be in `hello.actions`. Not armed → reply `ok:true, dryRun:true`, do nothing. Cooldown 3 s per action → `error cooldown`.
- Browser URL options: `?mode=live|fake|replay`, `?ws=ws://127.0.0.1:8765`.

## 3. Dataset file `ss-dataset` v1
One file per recording sitting, saved to `data/raw/`.
```jsonc
{ "format": "ss-dataset", "v": 1, "createdAt": "ISO", "session": "s1", "subject": "spiro",
  "source": "airpods" | "fake", "device": { "model": "AirPods Pro 3", "loc": "left" }, "hz": 25,
  "classes": [ /* copy of classes.json */ ],
  "clips": [{ "id": "s1-0007", "label": "text_mom", "rep": 2, "session": "s1", "startedAt": "ISO",
    "pressT": 81234.51, "releaseT": 81237.0, "padSec": 0.3,
    "quality": { "gapPct": 0, "nSamples": 78 }, "samples": [ /* MotionSample */ ] }] }
```
`clip.session` overrides the file's `session` (lets one file hold several sessions, like the synthetic fixture). Samples span `pressT - padSec` to `releaseT + padSec`.

## 4. Replay file `ss-session` v1
Continuous recording for visitor replay: `hello, status, samples[], events[] (ptt / prediction / action), truth[] {t0, t1, label}`. Replay re runs the current model on each push to talk window and marks it right or wrong against `truth`.

## 5. Preprocessing spec v1 (JS and Python must match)
1. Resample onto a uniform 25 Hz grid from first to last `t` (linear interpolation). Handles jitter and dropouts.
2. Channels `rr.x rr.y rr.z ua.x ua.y ua.z` (configurable).
3. High pass: 2nd order Butterworth, 1.0 Hz, zero phase. Match `scipy.signal.butter(2, 1.0, 'highpass', fs=25)` + `filtfilt` with defaults (odd padding, padlen 9).
4. Resample to L = 64 points (linear).
5. Normalize: `global` (default) = per channel z score with mean/std from the training fold. `clip` = per clip z score with std floor = 0.5 × median training std.

## 6. Classifier (`web/src/ml/index.ts`)
- DTW: dependent multivariate (one warp path for all channels), squared Euclidean local cost, Sakoe-Chiba band radius `round(band × L)` (default band 0.1).
- kNN k = 3, distance weighted. `confidence` in [0, 1], `top` = up to 3 labels by score. `accepted = label !== 'none' && confidence >= threshold` (default 0.5, tuned in Phase 2).
- API: `train(clips, opts) → DtwKnnModel`, `loadModel(json)`, `evaluate(clips, opts, 'loo'|'loso') → Metrics`, `preprocess`, `dtw`. Any other winning model implements the same `Classifier` interface.
- `Metrics` (also written by Python) → `ml/results/<model>/<protocol>.json`: `model, protocol, nClips, labels, accuracy, macroF1, confusion (rows true, cols predicted), noneFalseAcceptRate, params, inferMsPerClip, generatedAt`.

## 7. App shell (`web/src/core/app.ts`)
- Panels: `web/src/panels/*.ts` default export `Panel { id, order, title, mount(el, app) }`. Auto mounted in `order`. Add class `wide` to `el.closest('.card')` for full width.
- Sources: `web/src/sources/*.ts` default export `SourceDef { kind, create(app, opts) }`. Push events into `app.bus`.
- Bus events: `motion, status, hello, conn, invalid, ptt, clip, prediction, actionResult, mode, source, model`.
- Push to talk: Space or the big button. `clip` fires after release + 0.3 s pad. In `classify` mode with a model, the shell runs `predict` and emits `prediction`.
- Default source: try `live` 1.5 s, then `replay`, then `fake`.
- Test hooks: `window.__ss = { app, counts }`, `data-testid` on key elements.
