# Agent tracks

Each file here is a self contained brief for one agent. Hand it to a Claude session as is: "Do the track in `01-silent-speech/tracks/<file>`".

## Rules for every track
1. Read `01-silent-speech/PROTOCOL.md` and `web/src/core/contracts.ts` first. **Do not change contracts**, `core/*`, `main.ts`, `package.json`, the lockfile, or fixtures. Need a change? Stop and say so in your final report.
2. Only touch the files your brief says you own. New files inside your area are fine.
3. Branch: `p1-<letter>-<name>` off the phase branch `p1`. Commit only your files. Push your branch. Do not open a PR, the lead merges.
4. Before you finish, run from `01-silent-speech/`: `npm run typecheck && npm test` (+ `npx playwright test` if you touched web code). All green.
5. Final report: what you built, how you tested it, anything the lead must check, any contract change you need.

## Phase 1 tracks (run all 5 at once)
| Track | Brief | Owns |
|---|---|---|
| A | `p1-a-mac-bridge.md` | `mac/**` (except `Protocol.swift`) |
| B | `p1-b-live-viz.md` | `web/src/sources/live.ts`, `web/src/panels/{status,charts,head3d}.ts`, `tests/e2e/{live,viz}.spec.ts` |
| C | `p1-c-enroll.md` | `web/src/panels/enroll.ts`, `web/src/store.ts`, `tests/e2e/enroll.spec.ts`, `tests/unit/store.test.ts` |
| D | `p1-d-dtw.md` | `web/src/ml/**`, `tests/unit/ml/**`, `scripts/{eval-dtw,export-model}.ts`, `ml/results/dtw-knn/` |
| E | `p1-e-python-bench.md` | `ml/**` (except `ml/results/dtw-knn/`) |

Merge order: D before C (C calls `ml.evaluate` / `ml.train`). A, B, E any time.
