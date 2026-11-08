# Track F: UI panels, branch `p1-f-ui`, port 5203

## Goal
The panels a warehouse owner and a salesperson actually use: KPI tiles, a money panel where **every number explains itself on hover**, live fleet controls, a follow card for the clicked robot, time controls, a scenario picker. Dark, clean, in the league of the reference demos. Works on a phone.

Read PLAN.md §1, §4 and §9; PROTOCOL.md §6, §7, §9 and §10; `src/ui/panel.ts` (panel contract), `src/ui/shell.tsx` (slots, phone bottom sheet), `src/ui/styles.css` (tokens), `src/host/index.ts` (signals and methods you use), `src/contracts/types.ts` (`RunResult`, `Kpis`, `MoneyReport`, `Explained`, `AgentView`, `TaskView`), `fixtures/econ.json` and `fixtures/runresult.json`. Look at the reference frames described in RESEARCH.md Part D §7 (Airsup: KPI tiles across the top, a selected-agent card with a task timeline, an order list).

## You own
- `src/ui/panels/{kpi,money,fleet,follow,time,scenario,live}.tsx` and any `src/ui/panels/<name>/` helper folders
- `src/ui/explain/**` (the hover popover + number formatting)
- `src/ui/panels.css`: your styles, imported from your panels
- `tests/e2e/ui-*.spec.ts`

`kpi.tsx` exists (the lead's Phase 0 version); you replace it. `about.tsx` (credits) belongs to Track D. Don't edit `shell.tsx`, `panel.ts`, `styles.css`, `host/*`. If you need a host method or signal that doesn't exist, ask in your report.

## What you build against
- **The fake runner and the fake economics** (`host.demoData` is true: show the "demo data" badge exactly as now).
- **FakeSim** for the live view.

The lead swaps in the real sim, runner and economics at integration. Your code must not care which is plugged in.

## Build
1. **KPI tiles** (slot `kpi`):
   - **Tiles:** orders/hour (with demand), robot utilization, jams/hour (with deadlocks per shift), average order time (with p90), cost per order (from `host.money`).
   - **States:** "recalculating" while `host.pending`. A clear warning state when `keepsUp` is false ("backlog growing").
   - **Hover** shows how the number is measured: the KPI definition from PROTOCOL §6 in plain words, plus "simulated: 30 min warm-up + 2 h measured, same orders every run".
2. **Money panel** (slot `right`, the hero of the UI):
   - **Buy / Rent toggle** (`host.setFinancing`).
   - **Big numbers:** payback in months, and 3-year net savings. Also: upfront cost, yearly robot cost, yearly labor (this option vs people only), cost per order (both).
   - **Flags shown as words, not numbers:** "Never pays back at these numbers" and "Can't keep up with the orders".
   - **A per-type breakdown** (`money.lines`).
   - **The baseline:** "Compared with: N pickers + M drivers, people only (sized to keep up with the same orders)".
   - **Every number hovers (and taps on phones) to an `ExplainPopover`:**
     - the formula with real numbers
     - a table of inputs, each with its origin badge: `source` (title + publisher as a link to the URL from `host.data.sources`), `estimate` (with the note), `simulated`, `your input`
     - the "not modeled" note
   - Keyboard accessible (focusable, Esc closes).
3. **Fleet controls** (slot `right`, below money):
   - **Steppers + sliders** per type: cart robots, autonomous forklifts, humanoids, pickers, forklift drivers. Each shows the "based on" products on hover.
   - **Order volume** slider (orders/hour).
   - A **"People only"** button (`host.peopleOnly()`).
   - Changes apply live (`host.setFleet`, `host.setOrderRate`); the runner recalculates (already debounced in the host).
   - Show estimates with a small "estimate" badge where the spec is an estimate (from `host.data.agents`).
4. **Follow card** (slot `left`, only while `host.selected` is set):
   - Content: name, type, vendor, state, battery bar, current task (kind, stage, lines, how long), and a short task timeline of the last few state changes (keep your own small history per selected agent from snapshots).
   - **Updates** by subscribing to `host.live.onUpdate` at ≤ 4 Hz.
   - Close button = `host.select(0, null)`.
5. **Time controls** (slot `bottom`): pause/play, 1x / 10x / 60x (`host.setSpeed`, `host.setPaused`), sim clock (hh:mm from `snapshot.tick`).
6. **Live strip** (slot `bottom`): live counters from the snapshot (shipped, open orders, active jams, deadlocks), labeled "live view". This shows the 3D view and the tiles agree.
7. **Scenario picker:** small/default/large building (`host.setScenario`) in the brand bar area, or slot `left` when nothing is selected.
8. **Phone:** the shell turns `left`/`right`/`bottom` into bottom-sheet tabs. Make every panel readable at 390 px wide; tiles scroll sideways; the popover becomes a bottom sheet.
9. **`data-testid`** on every tile, control and number:
   - `kpi-*`, `money-payback`, `money-3yr`, `money-capex`, `fleet-<type>`, `fleet-people-only`, `order-rate`
   - `follow-card`, `explain-popover`, `speed-<x>`, `pause`

## Look
- Dark frosted cards (existing tokens), tabular numbers, one accent (warehouse yellow) for the big money numbers.
- Calm motion: numbers tween when they change.
- Use the system font, no web fonts (download budget).
- It must not look like an admin dashboard. Study the Airsup reference: compact tiles, generous spacing, few borders.

## Tests (`tests/e2e/ui-*.spec.ts`, port 5203: `E2E_WEB_PORT=5203 npm run gate`)
1. **Controls:**
   - Each control changes `host.settings` as expected.
   - "People only" ⇒ `money-capex` shows $0 and payback shows the flag text.
   - Raising cart robots changes the numbers.
2. **Explain popovers:** hovering `money-payback` shows `explain-popover` with a formula and at least one source link whose href matches `data/sources.json`. An estimate input shows its note.
3. **Follow card:** `host.select(0, id)` shows `follow-card` with that agent's name; the close button clears the selection.
4. **Time:** 10x makes `snapshot.tick` advance about 10× faster than 1x (loose bounds).
5. **Phone** (390×844, touch): tabs open each panel, and a tap on a money number opens the popover. Save a screenshot to `test-results/` and look at it.
6. No console errors.

Also take desktop and phone screenshots (`npx tsx scripts/shots.ts --url http://localhost:5203/weekend-projects/02-fleet-planner/` while your build is served) and **look at them critically** before you finish.

## Done when
`E2E_WEB_PORT=5203 npm run gate` is green, your screenshots look right on desktop and phone, and the work is committed on your branch. Report: what you built, the screenshots' paths, and any host/contract requests.
