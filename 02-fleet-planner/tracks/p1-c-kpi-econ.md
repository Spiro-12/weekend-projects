# Track C: KPIs and economics, branch `p1-c-kpi-econ` (unit tests only, no port)

## Goal
Turn sim output into the numbers a skeptical ops director trusts: KPI tiles and the money panel. **Every number explains itself** (formula, inputs, sources). The sanity tests in PLAN §9 must hold.

Read PLAN.md §4, §6 and §9; PROTOCOL.md §2, §6 and §7; `src/contracts/types.ts` (`SimStats`, `SimEvent`, `Kpis`, `RunResult`, `Explained`, `MoneyInput`, `MoneyReport`); `src/host/econ-port.ts` (the `EconPort` interface you implement; `fakeEcon` there is the toy version you replace); `data/agents.json` + `data/sources.json`.

## You own
`src/kpi/**`, `src/econ/**`, `tests/unit/kpi/**`, `tests/unit/econ/**`. Both folders are under sim purity (PROTOCOL §8): no DOM, no `Math.pow/sqrt/…`, no `Date`. Plain division and multiplication are fine.

## Build
1. **`src/kpi/index.ts`: `createKpiRecorder(scenario, { warmupTick, endTick }) → KpiRecorder`**
   - `start(stats)` is called once at the end of warm-up.
   - `sample(stats)` is called every 60 ticks.
   - `events(list)` gets every event drained in the window.
   - `finish(stats) → Kpis`.
   - The lead's runner drives it: step to warm-up → `start` → loop {step 60, `events`, `sample`} → `finish`.
   - Implement every KPI in PROTOCOL §6 exactly:
     - `oph`, `robotUtilizationPct`, `byType` shares (from the `ticksByState` delta between start and finish)
     - `jamsPerHour`, `deadlocksPerShift`
     - `avgOrderSec` / `p90OrderSec` (orders shipped inside the window, any arrival time)
     - `backlogEnd`, `backlogTrendPerHour` (least-squares slope of the `openOrders` samples), `keepsUp` (trend ≤ +2% of demand per hour)
     - `unitsPerPickerHour` (from `unitsPicked` and the picker count), `resetsPerHour`
   - `capacityOph` is just `oph` of a saturate run; the runner sets it.
   - Integer-safe: do the arithmetic in plain numbers; no transcendental functions.
2. **`src/kpi/uplift.ts`: `pickerUplift(withRobots: RunResult, peopleOnly: RunResult)`** = units per picker-hour ratio (both are capacity runs).
3. **`src/econ/money.ts`: `computeMoney(input: MoneyInput): MoneyReport`.** The formulas are exactly PROTOCOL §7:
   - `H`, labor (+ supervisor time for manual resets)
   - buy vs rent capex and opex, per-type `lines`
   - annual cost, baseline annual cost, savings
   - payback with `flag: 'never'` / `'doesntKeepUp'`
   - 3-year net, cost per order (both options)

   Packers are the same in every option: list them in labor and say so in the note, but they never change the payback. **Every value is an `Explained`:**
   - `formula` in plain words with the actual numbers substituted, e.g. "payback = $1,092,000 ÷ ($675,000 ÷ 12) = 19.4 months"
   - `inputs[]` with `from: 'source:<id>' | 'estimate' | 'sim' | 'user'` (use the `src` of the `agents.json` field; estimates keep their note)
   - `note` lists what isn't modeled (taxes, depreciation, discounting, interest, residual value, building changes)
4. **`src/econ/baseline.ts`: `findBaseline(scenario, runner)`** = the smallest all-human crew (pickers + drivers) that keeps up on the same orders, or the user's crew if `economics.baseline` is set.
   - **Fast:** at most about 4 `evaluate` calls. Suggested approach:
     1. one people-only capacity run (`{saturate: true}`) at a guess
     2. scale the pickers to demand ÷ per-picker capacity (+10%)
     3. size drivers to the pallet work
     4. verify with a demand run; adjust once if needed
   - Deterministic (the same settings give the same crew).
5. **`src/econ/best-mix.ts`: `bestMix(results: { scenario, result, money }[])`** = the highest 3-year net savings among options that keep up (never ranked by payback). Track J uses it in Phase 2.
6. **`src/econ/index.ts`:** export `econ: EconPort = { computeMoney, findBaseline }`, plus the rest.

## Tests (`tests/unit/kpi`, `tests/unit/econ`), all must pass
- **KPI recorder** on synthetic stats and events: exact values for a hand-built case. The trend is positive when open orders grow and 0 when flat. `keepsUp` flips at +2%.
- **People only ⇒ robot capex and robot opex exactly 0**, and payback "never" or "doesntKeepUp" as appropriate.
- **RaaS:** capex = setup/integration only. Opex = 12 × monthly × count.
- **S ≤ 0 ⇒ `flag: 'never'`.** A candidate that doesn't keep up ⇒ `flag: 'doesntKeepUp'` and no payback number.
- **Monotonic:** more robots never lowers robot capex or opex. A higher wage never lowers the savings of a robot option. A higher robot price never raises them.
- **Every `Explained` input has a `from`,** and every `source:<id>` exists in `data/sources.json`.
- **`findBaseline`** against the fake runner (`createFakeRunner`): at most 4 evaluate calls (count them with a wrapper), the result keeps up, and the crew is the smallest found.
- `npm run typecheck` (both configs) green.

## Done when
All of the above pass on your branch, committed. Your report includes a worked example: the default scenario's money report on the fake runner, with the payback formula string. Contract change requests go in the report, not in the code.
