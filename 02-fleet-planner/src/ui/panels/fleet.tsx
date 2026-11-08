// Fleet controls (Track F, slot `left`): how many of each robot and person, and how many orders come in.
// Changes go straight to the host (live sim command + a debounced recalculation of the numbers).
import type { AgentSpec, AgentTypeId } from '../../contracts/types.ts';
import type { Host } from '../../host/index.ts';
import { agentContent, capitalize, headlineIsEstimate, TYPE_NAMES } from '../explain/content.ts';
import { num, usd, usdShort } from '../explain/format.ts';
import { Explain } from '../explain/popover.tsx';
import { definePanel } from '../panel.ts';
import '../panels.css';

/** Slider ranges (the stepper and ?agents= can go past them; the slider then stretches). */
const MAX: Record<AgentTypeId, number> = { amr: 150, forklift: 30, humanoid: 30, picker: 120, driver: 30 };
const ORDER_MIN = 25;
const ORDER_MAX = 3000;

function priceLine(spec: AgentSpec, financing: 'buy' | 'raas'): string {
  const c = spec.cost;
  if (spec.kind === 'human') return c.wageUsdPerHour ? `${usd(c.wageUsdPerHour.value)} an hour` : '';
  if (financing === 'raas') return c.raasUsdPerMonth ? `${usd(c.raasUsdPerMonth.value)} a month each` : '';
  return c.buyUsd ? `${usdShort(c.buyUsd.value)} each` : '';
}

function TypeRow({ host, type }: { host: Host; type: AgentTypeId }) {
  const spec = host.data.agents.agents.find((a) => a.id === type);
  const n = host.settings.value.fleet[type];
  const financing = host.settings.value.economics.financing;
  if (!spec) return null;
  const name = capitalize(TYPE_NAMES[type][1]);
  const max = Math.max(MAX[type], n);
  return (
    <div class="frow" data-testid={`fleet-${type}`}>
      <div class="frow-top">
        <Explain id={`fleet-${type}-info`} class="frow-name" content={() => agentContent(spec, host.data.sources.sources)} label={`${name}: what the numbers are based on`}>
          {name}
          <span class="info" aria-hidden="true">
            i
          </span>
        </Explain>
        <div class="stepper">
          <button type="button" aria-label={`One fewer: ${name}`} data-testid={`fleet-${type}-minus`} disabled={n <= 0} onClick={() => host.setFleet(type, n - 1)}>
            −
          </button>
          <span class="count" data-testid={`fleet-${type}-count`} aria-live="polite">
            {num(n)}
          </span>
          <button type="button" aria-label={`One more: ${name}`} data-testid={`fleet-${type}-plus`} onClick={() => host.setFleet(type, n + 1)}>
            +
          </button>
        </div>
      </div>
      <div class="frow-sub">
        <span>{priceLine(spec, financing)}</span>
        {headlineIsEstimate(spec, financing) && (
          <span class="est" title="Not published by a vendor: our estimate. Hover the name to see the reasoning.">
            estimate
          </span>
        )}
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={n}
        aria-label={name}
        data-testid={`fleet-${type}-slider`}
        style={{ '--fill': `${(n / max) * 100}%` }}
        onInput={(e) => host.setFleet(type, Number((e.currentTarget as HTMLInputElement).value))}
      />
    </div>
  );
}

function FleetPanel({ host }: { host: Host }) {
  const s = host.settings.value;
  const rate = s.orders.perHour;
  const robots = s.fleet.amr + s.fleet.forklift + s.fleet.humanoid;
  return (
    <div class="card fleet">
      <div class="panel-head">
        <h2>Fleet</h2>
        <button
          type="button"
          class={`people-only${robots === 0 ? ' active' : ''}`}
          data-testid="fleet-people-only"
          aria-pressed={robots === 0}
          title="Remove every robot: today's warehouse, people only"
          onClick={() => host.peopleOnly()}
        >
          People only
        </button>
      </div>
      <div class="fgroup">Robots</div>
      <TypeRow host={host} type="amr" />
      <TypeRow host={host} type="forklift" />
      <TypeRow host={host} type="humanoid" />
      <div class="fgroup">People per shift</div>
      <TypeRow host={host} type="picker" />
      <TypeRow host={host} type="driver" />
      <div class="frow orders">
        <div class="frow-top">
          <span class="frow-name plain">Orders coming in</span>
          <span class="count wide" data-testid="order-rate-value">
            {num(rate)} <small>an hour</small>
          </span>
        </div>
        <input
          type="range"
          min={ORDER_MIN}
          max={Math.max(ORDER_MAX, rate)}
          step={25}
          value={rate}
          aria-label="Orders coming in per hour"
          data-testid="order-rate"
          style={{ '--fill': `${((rate - ORDER_MIN) / (Math.max(ORDER_MAX, rate) - ORDER_MIN)) * 100}%` }}
          onInput={(e) => host.setOrderRate(Number((e.currentTarget as HTMLInputElement).value))}
        />
      </div>
    </div>
  );
}

export default definePanel({ id: 'fleet', slot: 'left', order: 10, title: 'Fleet', Component: FleetPanel });
