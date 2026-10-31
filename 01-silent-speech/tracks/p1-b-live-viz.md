# Track B: Live source + status, charts, 3D head

## Goal
Connect the dashboard to the Mac bridge and make the signal visible and beautiful.

## Owns
`web/src/sources/live.ts`, `web/src/panels/status.ts`, `web/src/panels/charts.ts`, `web/src/panels/head3d.ts`, `tests/e2e/live.spec.ts`, `tests/e2e/viz.spec.ts`.
Use (read only): `core/app.ts` (`SourceDef`, `MotionSource`, `Panel`, bus events), `core/validate.ts` (`parseServerFrame`), `tests/mock-bridge.ts` (`startMockBridge`), `playwright.config.ts` (`MOCK_WS`, `BASE`). Your ports: `E2E_WEB_PORT=4201 E2E_MOCK_PORT=18801` (see `tracks/README.md`).

## Build
- **sources/live.ts** (`kind: 'live'`): WebSocket to `opts.ws ?? 'ws://localhost:8765'`. **`start()` resolves immediately and never rejects** (a bad `?ws=` URL just means `conn: closed` + retries). Emit `conn` (connecting/open/closed), and for each frame `parseServerFrame` → `msg`: emit `hello` / `status` / `motion` (strip `type`) / route `actionResult` + `error` to pending `sendAction` calls; `unknown`: ignore; `invalid`: emit `invalid`. Auto reconnect with backoff 0.5 s → 5 s max, forever until `stop()`. **After `stop()`, emit nothing** (close the socket, ignore late frames). `sendAction(req)`: send, resolve on `actionResult` with same id; an `error` with same id resolves `{ok:false, dryRun:false, error: code, message}`; 5 s timeout resolves `ok:false, error:'timeout'`.
- **panels/status.ts** (order 10): headphones, auth, bud, armed, simulated, bridge Hz, browser measured Hz (arrival rate over 2 s), gap % (bridge) + browser seen seq jumps, invalid frame count, connection state + url. Color: green if 23 to 27 Hz or 45 to 55 Hz (AirPods Pro 3 may stream at 50) and gaps < 5%. `data-testid`s: `status-bridge-hz`, `status-browser-hz`, `status-gaps`, `status-invalid`, `status-conn`, `status-headphones`.
- **panels/charts.ts** (order 20, wide card): canvas strip chart of the last 10 s, 6 channels (rr.x/y/z, ua.x/y/z) in 2 stacked groups (rotation, acceleration), auto scaling with smoothing, shade push to talk windows (bus `ptt`), DPR aware, requestAnimationFrame, no libraries. Also a "jaw energy" bar (RMS of high passed rr over last 0.3 s). `data-testid=chart-canvas`.
- **panels/head3d.ts** (order 30): three.js (**lazy** `await import('three')` inside mount) simple stylized head (sphere + nose + two AirPods) rotated by quaternion `q` (map CoreMotion axes sensibly; Recenter button stores current q as reference). Hide gracefully if WebGL is unavailable (show a note).

Look: dark, clean, matches `web/src/styles.css`. This is a portfolio piece; make the chart look great.

## Gate
- `npm run typecheck && npm test && npx playwright test` all green.
- `tests/e2e/live.spec.ts` against the mock bridge (Playwright config starts one at `MOCK_WS`; for restart / bad frame tests start your own with `startMockBridge({ port: 0, allowOrigins: [new URL(BASE).origin] })` inside the test): connects, browser Hz 23 to 27, 0 invalid frames, reconnects after the bridge restarts, `badEvery` frames counted as invalid, `app.sendAction` round trips (dry run). **Before sending any action, assert `app.lastHello.app === 'MockBridge'`.** Use `volume_up` for action tests (the shared mock has a 30 s cooldown on actions that message people).
- Fallback test: with `localStorage['ss.liveSeen']='1'` and no `?mode` but `?ws=ws://127.0.0.1:1` (nothing there), the page ends up on `fake` (or `replay`) within 2.5 s.
- `tests/e2e/viz.spec.ts`: in `?mode=fake`, chart canvas pixels change over time; head panel mounts with no page errors.
