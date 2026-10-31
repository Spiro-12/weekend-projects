# Track B: Live source + status, charts, 3D head

## Goal
Connect the dashboard to the Mac bridge and make the signal visible and beautiful.

## Owns
`web/src/sources/live.ts`, `web/src/panels/status.ts`, `web/src/panels/charts.ts`, `web/src/panels/head3d.ts`, `tests/e2e/live.spec.ts`, `tests/e2e/viz.spec.ts`.
Use (read only): `core/app.ts` (`SourceDef`, `MotionSource`, `Panel`, bus events), `core/validate.ts` (`parseServerMsg`), `tests/mock-bridge.ts` (`startMockBridge`).

## Build
- **sources/live.ts** (`kind: 'live'`): WebSocket to `opts.ws ?? 'ws://localhost:8765'`. Emit `conn` (connecting/open/closed), and for each frame `parseServerMsg` → emit `hello` / `status` / `motion` (strip `type`) / route `actionResult` + `error` to pending `sendAction` calls; invalid frames → emit `invalid`. Auto reconnect with backoff 0.5 s → 5 s max, forever until `stop()`. `sendAction(req)`: send, resolve on `actionResult` with same id; an `error` with same id resolves `{ok:false, dryRun:false, error: code, message}`; 5 s timeout resolves `ok:false, error:'timeout'`.
- **panels/status.ts** (order 10): headphones, auth, bud, armed, simulated, bridge Hz, browser measured Hz (arrival rate over 2 s), gap % (bridge) + browser seen seq jumps, invalid frame count, connection state + url. Color: green if 23 to 27 Hz and gaps < 5%. `data-testid`s: `status-bridge-hz`, `status-browser-hz`, `status-gaps`, `status-invalid`, `status-conn`, `status-headphones`.
- **panels/charts.ts** (order 20, wide card): canvas strip chart of the last 10 s, 6 channels (rr.x/y/z, ua.x/y/z) in 2 stacked groups (rotation, acceleration), auto scaling with smoothing, shade push to talk windows (bus `ptt`), DPR aware, requestAnimationFrame, no libraries. Also a "jaw energy" bar (RMS of high passed rr over last 0.3 s). `data-testid=chart-canvas`.
- **panels/head3d.ts** (order 30): three.js (**lazy** `await import('three')` inside mount) simple stylized head (sphere + nose + two AirPods) rotated by quaternion `q` (map CoreMotion axes sensibly; Recenter button stores current q as reference). Hide gracefully if WebGL is unavailable (show a note).

Look: dark, clean, matches `web/src/styles.css`. This is a portfolio piece; make the chart look great.

## Gate
- `npm run typecheck && npm test && npx playwright test` all green.
- `tests/e2e/live.spec.ts` against the mock bridge (Playwright config already starts one on :8765; for restart tests start your own with `startMockBridge({ port: 18766 })` inside the test and use `?mode=live&ws=ws://127.0.0.1:18766`): connects, browser Hz 23 to 27, 0 invalid frames, reconnects after the bridge restarts, `badEvery` frames are counted as invalid, `app.sendAction` round trips (dry run result).
- `tests/e2e/viz.spec.ts`: in `?mode=fake`, chart canvas pixels change over time; head panel mounts with no page errors.
