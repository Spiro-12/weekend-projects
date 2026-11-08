# Phase 1 tracks: P0 core

The rules are in `tracks/README.md`; read it first, along with `PROTOCOL.md` and `src/contracts/types.ts`. Branch `p1-<letter>-<name>` off `p1`. Commit with `scripts/git-as-claude.sh`. Don't push and don't open a PR; the lead merges.

| Track | Brief | Owns | Port |
|---|---|---|---|
| A sim core | `p1-a-sim-core.md` | `src/sim/core/**`, `src/sim/faults/**`, `tests/unit/sim/**` | none |
| B one-brain traffic | `p1-b-traffic.md` | `src/sim/traffic/central/**`, `tests/unit/traffic/**` | none |
| C KPIs + economics | `p1-c-kpi-econ.md` | `src/kpi/**`, `src/econ/**`, `tests/unit/{kpi,econ}/**` | none |
| D world + assets + credits | `p1-d-world.md` | `src/render/world/**`, `scripts/assets/**`, `public/assets/**`, `CREDITS.md`, `src/ui/panels/about.tsx`, `tests/e2e/world-*` | 5201 |
| E agents + camera + effects | `p1-e-agents.md` | `src/render/{agents,models,camera,fx}/**`, `tests/e2e/agents-*` | 5202 |
| F UI panels | `p1-f-ui.md` | `src/ui/panels/{kpi,money,fleet,follow,time,scenario,live}*`, `src/ui/explain/**`, `src/ui/panels.css`, `tests/e2e/ui-*` | 5203 |

**Independence:** each track builds against the lead's interfaces and fakes:

| Track | Builds against |
|---|---|
| A | `NaiveController` |
| B | its own test harness |
| C | the fake runner |
| D, E | FakeSim |
| F | FakeSim + the fake runner + the fake economics |

**Lead integration:**
- Merge order: C → B → A → D → E → F.
- Switch `src/sim/index.ts` to the core, with B's controller.
- Switch the runner to C's recorder and the host to C's economics.
- Re-run A's numeric checks with real traffic, calibrate the default scenario, write the golden files, measure perf with nothing else running. Then Gate 1 and PR #2.
