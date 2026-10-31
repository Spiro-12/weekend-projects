# Silent Speech Protocol v1

The contracts every part follows. **Frozen after Phase 0.** Only the lead changes them, in one commit that updates this file, `web/src/core/contracts.ts`, `mac/SilentSpeechBridge/Protocol.swift` and `shared/fixtures/*` together.

Source of truth for types: `web/src/core/contracts.ts`. Validators: `web/src/core/validate.ts`. Examples: `shared/fixtures/`.

## 1. Classes
`shared/classes.json`: `[{ id, sentence, action }]`. Ids are fixed; sentence wording can change. `none` has `action: null`.

## 2. WebSocket (`ws://127.0.0.1:8765`, JSON text frames)
The Mac app binds **IPv4 loopback only** (127.0.0.1:8765), so the dashboard defaults to `ws://127.0.0.1:8765` (not `localhost`, which may resolve to ::1 first).

Mac → browser:
| type | when | fields |
|---|---|---|
| `hello` | once on connect | `v:1, app, version, actions[], armed` |
| `status` | every 1 s + on change | `headphones (connected/disconnected/unavailable), auth (authorized/denied/notDetermined/restricted), loc (left/right/default/unknown), hz, gapPct, clients, armed, simulated` |
| `motion` | every sample (~25 to 50 Hz, whatever the AirPods give; not batched) | `seq, t, q[w,x,y,z], rr[3] rad/s, ua[3] g, g?[3]` |
| `actionResult` | reply to `action` | `id, action, ok, dryRun, message, error?, ms` |
| `error` | bad request | `code (bad_json/unknown_action/cooldown/unpaired), message, id?` |

Browser → Mac:
| type | fields |
|---|---|
| `action` | `id, action, label, confidence, token` |

Rules:
- `seq` goes up by 1 per sample. A jump = dropped samples. `t` = `CMLogItem.timestamp` (seconds since boot). Simulate mode uses `ProcessInfo.processInfo.systemUptime` (same clock) and keeps `seq` counting.
- `hz` = samples in the last 2 s / 2. `gapPct` = % of intervals > 60 ms in the last 10 s.
- Numbers rounded to 5 decimals.
- **Unknown `type`: ignore it silently, both sides.** It is not an error and not "invalid". Browser side: use `parseServerFrame` (returns `msg` / `unknown` / `invalid`); count only `invalid`. Mac side: a valid JSON object whose `type` isn't `action` is ignored; broken JSON or a broken `action` → `error bad_json`.
- **Security (Mac app):**
  - Listen on loopback only, **and** reject any connection whose remote endpoint isn't `127.0.0.1` / `::1`.
  - Origin (header name compared case insensitively) must be one of `https://spiro-12.github.io`, `http://localhost:5173`, `http://localhost:4173`, `http://127.0.0.1:5173`, `http://127.0.0.1:4173`. Others are rejected at the handshake.
  - **Missing Origin is rejected** unless the app's "Allow non browser clients" dev toggle is on (off by default).
  - "Armed" is off by default.
- **Pairing (Phase 2):** on first launch the Mac app creates `~/.silentspeech/token` (32 random lowercase hex, file mode 0600). Its "Open dashboard" link is `https://spiro-12.github.io/weekend-projects/01-silent-speech/?mode=live#pair=<token>`. The dashboard keeps the token **in memory only** (never in localStorage, which every page on spiro-12.github.io shares), removes the hash from the address bar, and sends it as `token` in every `action`. Reloading means opening the dashboard from the Mac app's link again. The Mac app compares it in constant time; a wrong or empty token → `error unpaired` (checked before anything else about the action). Motion streaming needs no token. The token never goes in git or chat. (The browser's own history may still hold the URL the Mac app opened; low risk on Spiro's own machine.)
- `action` must be in `hello.actions`. Not armed → reply `ok:true, dryRun:true`, do nothing. Cooldown per action: 3 s, but **30 s for actions that message people** (`text_mom`, `call_back`, `help`) → `error cooldown`.
- **The Mac replies to every `action` within 1 s.** Long actions (e.g. `calendar`) reply right away with `ok:true, message:"Working on it"` and finish in the background.
- The mock bridge (`tests/mock-bridge.ts`) follows all of this and says `app: "MockBridge"` in `hello`. Tests that send actions must check that first, so they can never fire the real Mac app.
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
**`clip.loc`** (optional, Phase 2): which bud had the sensor for this clip (`status.loc` at record time). Missing → use the file's `device.loc`. The Record panel writes it on export.

**Exclusion list** `data/raw/exclude.json`: `{ "format": "ss-exclude", "v": 1, "reason": "...", "ids": ["<clip id>", ...] }`. Every training and evaluation script takes `--exclude <file>` and skips those clip ids. Raw recordings are never edited.

## 4. Replay file `ss-session` v1
Continuous recording for visitor replay: `hello, status, samples[], events[] (ptt / prediction / action), truth[] {t0, t1, label}`. Replay re runs the current model on each push to talk window and marks it right or wrong against `truth`.

## 5. Preprocessing spec v1 (JS and Python must match exactly)
Input clips have at least 10 samples (shorter ones are rejected at recording).
0. **Bud normalization** (`budNorm`, default `'mirror'`): if the clip's bud is `right` (`clip.loc`, else the dataset's `device.loc`; at predict time `ctx.loc` from `status.loc`), mirror every sample into the left-bud frame: `rr → [rr.x, −rr.y, −rr.z]`, `ua → [−ua.x, ua.y, ua.z]` (a sagittal reflection: ua is a vector, rr a pseudo vector). `left`, `default`, `unknown` → unchanged. `'none'` turns this off. (Real data: right-bud s1 on a left-bud model 34% raw → 63% mirrored.)
`hz` in datasets/status is the measured input rate (25 or 50). Preprocessing doesn't depend on it.
1. **Uniform grid at `GRID_HZ = 50`:** sort by `t`, drop duplicate `t`. Grid `t_k = t_0 + k/50` for `k = 0 .. floor((t_last - t_0) * 50 + 1e-6)` (includes the last point when it lands on the grid; the epsilon is 1e-6, not 1e-9, because real Mac timestamps are around 1e6 s and float error there is about 1e-8). Linear interpolation per channel. (50 Hz because the first real test showed AirPods Pro 3 stream at ~50 Hz; 25 Hz input just gets upsampled, which is harmless.)
2. **Channels** `rr.x rr.y rr.z ua.x ua.y ua.z` (configurable, in that order).
3. **High pass:** 2nd order Butterworth, 1.0 Hz, zero phase, per channel. Coefficients = `scipy.signal.butter(2, 1.0, 'highpass', fs=50)`. Filtering = `scipy.signal.filtfilt(b, a, x, padtype='odd', padlen=min(9, n-1))` including scipy's initial conditions (`lfilter_zi`). JS must reproduce this.
4. **Resample to L** (default 96 since Phase 2; was 64): value at position `j*(n-1)/(L-1)`, `j = 0..L-1`, linear interpolation.
5. **Normalize:**
   - `global`: per channel `mean` and population `std` (ddof 0, floor 1e-8) over every value of every training clip after step 4. Apply to train and test.
   - `clip` (**default since Phase 2**: sessions differ a lot in per channel loudness, and per clip scaling cancels that, about +10 points LOSO on real data): each clip z scored per channel by its own mean/std, with std floor per channel = 0.5 × median (over training clips) of the per clip std of that channel.

## 6. Classifier (`web/src/ml/index.ts`)
- DTW: dependent multivariate (one warp path for all channels), squared Euclidean local cost summed over channels, Sakoe-Chiba band radius `r = max(1, floor(band × L + 0.5))` (defaults band 0.05, L 96 → r = 5). Returns the total accumulated cost (no normalization).
- kNN, default **k = 3** since Phase 2 (k = 1 in Phase 1, when there were only 5 to 15 takes per class; with ~30 per class across sessions k = 3 wins). Distance weighted. `confidence` in [0, 1] and must drop when a clip is far from every template (not only relative to other classes), so small or partial models don't accept random motion. `top` = up to 3 labels by score. `accepted = label !== 'none' && confidence >= threshold` (default **0.85**, tuned on real data in Phase 2: 0% wrong accepted, 0% none false accept, 55 to 62% of correct sentences accepted: 55% with settings chosen without the test session, 62% when tuned on all three).
- **Phase 2 defaults** (`DEFAULT_OPTS` in `web/src/ml/preprocess.ts`, which cites the evidence): 6 channels, L 96, hpHz 1, band 0.05, k 3, norm `clip`, budNorm `mirror`, threshold 0.85. Honest real data accuracy (Spiro, 342 clips, 8 classes): **88% LOSO with settings chosen without the test session** (94% when tuned on all three); same bud new session ~97 to 98%; other bud mirrored 67 to 84%.
- **Action thresholds** (dashboard rule, `web/src/panels/result/rule.ts`): only an allowlist of harmless actions (`volume_up`, `focus_music`, `calendar`, `demo_48h`) may fire from confidence 0.5; every other action, including the ones that message people and any added later, needs `accepted` at the model threshold (0.85). Actions only ever fire from a full own model (every class incl. `none`, ≥ 5 takes each, recorded in this browser).
- `predict(samples, ctx?)`: `ctx.loc` is the streaming bud (the shell passes `status.loc`); used by bud normalization.
- API: `train(clips, opts) → DtwKnnModel`, `loadModel(json)`, `evaluate(clips, opts, 'loo'|'loso') → Metrics`, `preprocess`, `dtw`. Any other winning model implements the same `Classifier` interface.
- Datasets are merged and **deduplicated by clip `id`** before training or evaluation (JS and Python).
- `Metrics` (also written by Python) → `ml/results/<model>/<protocol>.json` for real data (`protocol`: `loo`, `loso`, or `xbud` = train on one bud's sessions and test on the other bud's), `ml/results/<model>--<variant>/` for variants (e.g. `--phase1-settings`), `ml/results/synthetic/<model>/` for the synthetic fixture: `model, protocol, nClips, labels, accuracy, macroF1, confusion (rows true, cols predicted), noneFalseAcceptRate, params, inferMsPerClip, generatedAt`.

## 7. App shell (`web/src/core/app.ts`)
- Panels: `web/src/panels/*.ts` default export `Panel { id, order, title, mount(el, app) }`. Auto mounted in `order`. Add class `wide` to `el.closest('.card')` for full width.
- Sources: `web/src/sources/*.ts` default export `SourceDef { kind, create(app, opts) }`. Push events into `app.bus`.
- Bus events: `motion, status, hello, conn, invalid, ptt, clip, prediction, actionResult, mode, source, model`.
- Sources: `start()` must resolve right away (don't wait for a connection) and must never reject. Report state via `conn`.
- Push to talk: Space or the big button, or `app.ptt(down, t?)` (replay passes the sample clock `t`; visitor input is ignored during a replay). `clip` fires after release + 0.3 s pad. **`prediction` is only emitted when the take was started and finished in classify mode**, and carries `model` (the classifier that made it) and `press` (`{ mode, source, conn, simulated }` at key down; `conn` is `app.connSerial`, bumped on every source switch and `conn` event). Pressing before any sample arrives starts the clip at the first sample. In `classify` mode with a model, the shell runs `predict` and emits `prediction` (a throwing model is logged, not fatal).
- Default source: `?mode=` wins. Otherwise, only if `localStorage['ss.liveSeen'] === '1'` (set after a live `hello`), try `live` for 1.5 s. Then `replay` if registered, else `fake`. Public visitors never probe localhost.
- e2e ports come from env (`E2E_WEB_PORT`, `E2E_MOCK_PORT`, see `playwright.config.ts`), so parallel worktrees don't collide. Specs import `MOCK_WS` from the config.
- Test hooks: `window.__ss = { app, counts }`, `data-testid` on key elements.
