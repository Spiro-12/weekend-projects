# Agent tracks

Each file here is a self-contained brief for one agent: "Do the track in `02-fleet-planner/tracks/<file>`".

## Rules for every track
1. **Read first:** `02-fleet-planner/PLAN.md` (sections 4 to 9), `PROTOCOL.md` (from Phase 1 on) and `src/contracts/types.ts`.
   - **Do not change contracts or lead-owned files:** `src/contracts/*`, `data/*`, `fixtures/*`, `src/sim/{rng,world,detect,fake,index,layout-gen,motion}.ts`, `src/sim/traffic/{types,naive}.ts`, `src/host/*` (except `sweep/`), `src/render/core/*` (renderer, camera, layers, assets, tiers, tours, perf), the `src/ui/` shell (`shell.tsx`, `panel.ts`, `params.ts`, `styles.css`, `perf-overlay.tsx`), `src/app/*`, `package.json`, the lockfile and the config files.
   - Need a change there? Stop and put it in your final report as a "contract change request".
2. **Touch only the files your brief says you own.** New files inside your area are fine.
3. **Work in your own git worktree.** Branch `p<phase>-<letter>-<name>` off the phase branch: `git checkout -b <your-branch> p<phase>`.
   - Run `npm ci` in `02-fleet-planner/` first.
   - Commit only your files, with `scripts/git-as-claude.sh commit -m "..."` (it sets the right author).
   - Commit your work to your branch. Push only if your brief says so (`scripts/git-as-claude.sh push -u origin <branch>`).
   - Never push to `main` or the phase branch. Never open or merge PRs; the lead does that.
4. **Ports:** parallel tracks share one Mac. Always run Playwright with your own port: `E2E_WEB_PORT=<port> npx playwright test` or `E2E_WEB_PORT=<port> npm run gate`.

   | Who | Port |
   |---|---|
   | lead | 5180 |
   | spikes a / c / b | 5191 / 5192 / 5193 |
   | D / E / F | 5201 / 5202 / 5203 |
   | H / I / J / K | 5211 / 5212 / 5213 / 5214 |
   | L / M / N | 5221 / 5222 / 5223 |

   Never use 4173, 42xx, 43xx, 8765 or 18xxx.
5. **Determinism:** inside `src/sim`, `src/kpi`, `src/econ` and `src/contracts` there is no `Math.random`, `Date`, `performance.now`, `Math.sin/cos/tan/exp/log/pow/atan2/hypot/sqrt`, and no non-integer sim state (PROTOCOL §8).
6. **Your gate before you finish:** from `02-fleet-planner/`, `npm run typecheck && npm test` plus your brief's own checks, all green.
7. **Performance:** fps and load-time numbers measured while other tracks are running are noisy. Report them, but the lead re-measures at the gate with nothing else running.
8. **After you:** a separate reviewer agent checks your branch against your brief and the contracts. Expect fix requests.
9. **Final report:**
   - what you built (files)
   - how you tested it
   - measured numbers vs the brief's budgets
   - anything the lead must check
   - contract change requests
   - open risks

Plain words, no padding.
