// Validators for the data files (PROTOCOL §2-§4). Hand-written, no dependencies. Each returns a list of problems
// (empty = valid) so tests, the scenario loader and the AI consultant (Phase 3) can all show readable errors.
import {
  AGENT_TYPES,
  ROBOT_TYPES,
  type AgentsFile,
  type LayoutFile,
  type Scenario,
  type Sourced,
  type SourcesFile,
} from './types.ts';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every Sourced number in a nested object, with its path. */
export function collectSourced(obj: unknown, path = ''): { path: string; s: Sourced }[] {
  const out: { path: string; s: Sourced }[] = [];
  const walk = (o: unknown, p: string) => {
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    if ('value' in r && 'src' in r && 'unit' in r) {
      out.push({ path: p, s: r as unknown as Sourced });
      return;
    }
    for (const [k, v] of Object.entries(r)) walk(v, p ? `${p}.${k}` : k);
  };
  walk(obj, path);
  return out;
}

export function validateSources(agents: AgentsFile, sources: SourcesFile): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const s of sources.sources) {
    if (ids.has(s.id)) errs.push(`sources: duplicate id ${s.id}`);
    ids.add(s.id);
    if (!/^https?:\/\//.test(s.url)) errs.push(`sources: ${s.id} has no URL`);
    if (!s.title || !s.publisher || !s.accessed) errs.push(`sources: ${s.id} is missing title, publisher or accessed date`);
  }
  for (const { path, s } of collectSourced(agents)) {
    if (!isNum(s.value)) errs.push(`${path}: value is not a number`);
    if (!s.unit) errs.push(`${path}: no unit`);
    if (s.src === 'estimate') {
      if (!s.note || s.note.length < 10) errs.push(`${path}: estimate without a reasoning note`);
    } else if (!ids.has(s.src)) errs.push(`${path}: unknown source id '${s.src}'`);
    if (s.range && !(s.range[0] <= s.value && s.value <= s.range[1])) errs.push(`${path}: value ${s.value} outside its range ${s.range}`);
  }
  return errs;
}

export function validateAgents(f: AgentsFile): string[] {
  const errs: string[] = [];
  if (f.format !== 'fp-agents' || f.v !== 1) errs.push('agents: wrong format or version');
  for (const t of AGENT_TYPES) if (!f.agents.some((a) => a.id === t)) errs.push(`agents: missing type ${t}`);
  for (const a of f.agents) {
    if (a.kind === 'robot') {
      if (!a.battery) errs.push(`agents.${a.id}: robots need a battery`);
      if (!a.cost.buyUsd || !a.cost.raasUsdPerMonth) errs.push(`agents.${a.id}: robots need buy and rent prices`);
    } else if (!a.cost.wageUsdPerHour) errs.push(`agents.${a.id}: people need a wage`);
    if (a.can.includes('pick') && !a.pickSecPerLine) errs.push(`agents.${a.id}: pickers need pickSecPerLine`);
    if (a.can.includes('carry_pallet') && !a.palletSecPerMove) errs.push(`agents.${a.id}: pallet movers need palletSecPerMove`);
    if (!isInt(a.safetyCells) || a.safetyCells < 0) errs.push(`agents.${a.id}: safetyCells must be a non-negative integer`);
    if (!isInt(a.turnTicks) || a.turnTicks < 0) errs.push(`agents.${a.id}: turnTicks must be a non-negative integer`);
  }
  return errs;
}

const CELL_CHARS = new Set(['#', '.', '=', 'D', 'S', 'P', 'C', 'K', 'X', '>', '<', '^', 'v']);

export function validateLayout(l: LayoutFile): string[] {
  const errs: string[] = [];
  if (l.format !== 'fp-layout' || l.v !== 1) errs.push('layout: wrong format or version');
  const h = l.grid.length;
  const w = l.grid[0]?.length ?? 0;
  if (h < 5 || w < 5) errs.push('layout: grid too small');
  l.grid.forEach((row, y) => {
    if (row.length !== w) errs.push(`layout: row ${y} has ${row.length} cells, expected ${w}`);
    for (const ch of row) if (!CELL_CHARS.has(ch)) errs.push(`layout: unknown cell '${ch}' in row ${y}`);
    if (y === 0 || y === h - 1) {
      if (/[^XD]/.test(row)) errs.push(`layout: border row ${y} must be walls or dock doors`);
    } else if (row[0] !== 'X' || row[w - 1] !== 'X') errs.push(`layout: row ${y} must start and end with a wall`);
  });
  if (!isInt(l.cellMm) || l.cellMm <= 0) errs.push('layout: cellMm must be a positive integer');
  for (const z of l.zones) if (z.x < 0 || z.y < 0 || z.x + z.w > w || z.y + z.h > h) errs.push(`layout: zone ${z.id} is outside the grid`);
  return errs;
}

export function validateScenario(s: Scenario, layouts?: string[]): string[] {
  const errs: string[] = [];
  const int = (v: unknown, p: string, min = 0) => {
    if (!isInt(v) || v < min) errs.push(`scenario.${p}: must be an integer ≥ ${min}`);
  };
  if (s.format !== 'fp-scenario' || s.v !== 1) errs.push('scenario: wrong format or version');
  if (!s.id || !s.name) errs.push('scenario: needs id and name');
  if (layouts && !layouts.includes(s.layout)) errs.push(`scenario.layout: unknown layout '${s.layout}'`);
  if (!isInt(s.seed) || s.seed < 0 || s.seed > 0xffffffff) errs.push('scenario.seed: must be a uint32');
  int(s.run?.warmupMin, 'run.warmupMin');
  int(s.run?.measureMin, 'run.measureMin', 1);
  int(s.shift?.hoursPerShift, 'shift.hoursPerShift', 1);
  int(s.shift?.shiftsPerDay, 'shift.shiftsPerDay', 1);
  int(s.shift?.daysPerYear, 'shift.daysPerYear', 1);
  if (s.shift && s.shift.hoursPerShift * s.shift.shiftsPerDay > 24) errs.push('scenario.shift: more than 24 h a day');
  if (!['demand', 'saturate'].includes(s.orders?.mode)) errs.push('scenario.orders.mode: demand or saturate');
  int(s.orders?.perHour, 'orders.perHour');
  if (s.orders && s.orders.perHour > 28_800) errs.push('scenario.orders.perHour: at most 28,800 (4 arrival draws per tick)');
  if (!Array.isArray(s.orders?.linesWeights) || !s.orders.linesWeights.length || s.orders.linesWeights.some((w) => !isInt(w) || w < 0))
    errs.push('scenario.orders.linesWeights: non-empty list of non-negative integers');
  int(s.orders?.sku?.aPct, 'orders.sku.aPct', 1);
  int(s.orders?.sku?.aPicksPct, 'orders.sku.aPicksPct', 1);
  int(s.pallets?.linesPerReplenish, 'pallets.linesPerReplenish', 1);
  int(s.pallets?.inboundPerHour, 'pallets.inboundPerHour');
  int(s.pack?.stations, 'pack.stations', 1);
  int(s.pack?.secPerOrder, 'pack.secPerOrder', 1);
  for (const t of AGENT_TYPES) int(s.fleet?.[t], `fleet.${t}`);
  for (const t of ROBOT_TYPES) {
    const v = s.vendors?.[t];
    if (!v || !v.length) {
      errs.push(`scenario.vendors.${t}: at least one vendor`);
      continue;
    }
    const total = v.reduce((a, b) => a + b.pct, 0);
    if (total !== 100) errs.push(`scenario.vendors.${t}: percentages add up to ${total}, not 100`);
    for (const x of v) if (!/^[A-Z]$/.test(x.id)) errs.push(`scenario.vendors.${t}: vendor ids are single capital letters`);
  }
  if (!['central', 'siloed', 'shared-status'].includes(s.traffic?.mode)) errs.push('scenario.traffic.mode: central, siloed or shared-status');
  int(s.traffic?.silo?.sensorCells, 'traffic.silo.sensorCells', 1);
  int(s.traffic?.silo?.waitTicks, 'traffic.silo.waitTicks', 1);
  int(s.traffic?.silo?.resetMin, 'traffic.silo.resetMin', 1);
  int(s.traffic?.silo?.retaskSec, 'traffic.silo.retaskSec', 1);
  if (!['buy', 'raas'].includes(s.economics?.financing)) errs.push('scenario.economics.financing: buy or raas');
  const b = s.economics?.baseline;
  if (b !== 'auto') {
    int(b?.picker, 'economics.baseline.picker', 1);
    int(b?.driver, 'economics.baseline.driver');
  }
  for (const [k, e] of (s.events ?? []).entries()) {
    int(e.atMin, `events[${k}].atMin`);
    if (e.type === 'breakdown' || e.type === 'personInAisle' || e.type === 'orderSurge') int(e.forMin, `events[${k}].forMin`, 1);
    if (e.type === 'orderSurge') int(e.factorPct, `events[${k}].factorPct`, 1);
    if (e.type === 'chargers') int(e.count, `events[${k}].count`);
    if (e.type === 'breakdown' && !/^(amr|forklift|humanoid|picker|driver):\d+$/.test(e.agent))
      errs.push(`scenario.events[${k}].agent: '<type>:<n>' (the n-th agent of that type in spawn order, 0-based)`);
  }
  return errs;
}
