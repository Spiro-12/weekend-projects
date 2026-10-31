# Track K: replay for visitors + session recorder

## Goal
Visitors without AirPods see a real recorded session replayed live, with honest right/wrong marks. Spiro can record the Phase 3 demo session.

## Owns
`web/src/sources/replay.ts`, `web/src/panels/replay.ts`, `web/src/panels/session-recorder.ts` (+ subfolders), `scripts/build-replay.ts`, `web/public/replay/`, `tests/e2e/replay.spec.ts`, `tests/unit/replay*.test.ts`. Ports 4304 / 18904.

## Build
1. **`sources/replay.ts`** (`kind: 'replay'`): loads `ss-session` (default `${BASE_URL}replay/demo-session.json`, `?session=` override), plays samples in real time on the sample clock, emits `hello`/`status` (`simulated: true`, `armed: false`), calls `app.ptt(down, t)` at the recorded push to talk events (so the shell cuts clips and predicts with whatever `app.model` is), loops, speed 1× / 2×. On start it switches the app to Recognize mode. `start()` resolves immediately and never rejects (PROTOCOL §7). It is the visitor default (the shell already prefers replay over fake).
2. **`panels/replay.ts`**: a slim banner "Replay of a real session: Spiro, AirPods Pro 3, Oct 31" with play/pause, speed, and a running score: each push to talk window marked right or wrong against `truth` (match predictions to truth windows by clip time). Hidden for other sources.
3. **`scripts/build-replay.ts`**: builds `web/public/replay/demo-session.json` from **s3 only** (held out from Track F's public model; see `data/raw/README.md`), skipping `exclude.json` ids: each of the 7 sentences twice plus 2 `none`, shuffled, stitched into one continuous stream (re-time samples so `t` is continuous and `seq` +1, fill gaps between takes with quiet motion taken from the takes' own padding, about 1.5 to 2.5 s gaps), with `ptt` events at each take's press/release and `truth` windows. Keep it under ~1 MB. Validate with `validateSession`.
4. **`panels/session-recorder.ts`**: in live mode, Record session / Stop / Export: captures motion, ptt events, predictions and action results into an `ss-session` file (for Phase 3's demo run). Hidden unless live.

## Gate
`npm run typecheck && npm test && E2E_WEB_PORT=4304 E2E_MOCK_PORT=18904 npx playwright test` green. e2e: a visitor (no `?mode`) gets replay within 2 s with no console errors and no WebSocket; with a model loaded (use `ml.train` on the synthetic fixture in tests, or the real public model if Track F's file exists on your branch) the replay marks windows and the score shows; loop and speed work; the recorder exports a session that passes `validateSession`. Screenshots checked.
