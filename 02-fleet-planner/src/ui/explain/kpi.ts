// KPI tile hovers (Track F): how each number is measured, from PROTOCOL §6, in plain words.
import { ROBOT_TYPES, type AgentsFile, type RunResult, type Scenario } from '../../contracts/types.ts';
import { runLine, type ExplainContent, type ExplainRow } from './content.ts';
import { minutes, n1, num } from './format.ts';

export type KpiId = 'oph' | 'util' | 'jams' | 'order-time';

const sim = (label: string, value: string, note?: string): ExplainRow => ({ label, value, from: 'sim', note });

export function kpiContent(id: KpiId, r: RunResult | null, s: Scenario, agents: AgentsFile): ExplainContent {
  const k = r?.kpis;
  const run = runLine(s);
  const label = (t: string) => agents.agents.find((a) => a.id === t)?.label ?? t;
  switch (id) {
    case 'oph': {
      const behind = k && !k.keepsUp;
      return {
        title: 'Orders shipped per hour',
        value: k ? `${n1(k.oph)} orders an hour` : undefined,
        text: [
          'Orders shipped per hour during the measured time. It can never be higher than the orders coming in.',
          ...(behind
            ? [`Falling behind: open orders grow by about ${num(k.backlogTrendPerHour)} an hour. A plan keeps up only if that growth stays under 2% of the orders coming in.`]
            : []),
        ],
        inputs: [
          { label: 'Orders coming in', value: `${num(s.orders.perHour)} an hour`, from: 'user' },
          ...(k
            ? [
                sim('Orders shipped', `${n1(k.oph)} an hour`),
                sim('Open orders at the end', num(k.backlogEnd)),
                sim('Open orders change', `${k.backlogTrendPerHour > 0 ? '+' : ''}${n1(k.backlogTrendPerHour)} an hour`),
              ]
            : []),
        ],
        run,
      };
    }
    case 'util': {
      const rows = k
        ? ROBOT_TYPES.filter((t) => (r?.fleet[t] ?? 0) > 0 && k.byType[t]).map((t) => {
            const b = k.byType[t]!;
            return sim(`${label(t)} busy`, `${num(b.utilizationPct)}%`, `Idle ${num(b.idlePct)}%, charging ${num(b.chargingPct)}%, blocked ${num(b.blockedPct)}%, waiting ${num(b.waitPct)}%.`);
          })
        : [];
      return {
        title: 'Robot utilization',
        value: k ? `${num(k.robotUtilizationPct)}%` : undefined,
        text: [
          'The share of robot time spent driving to a job or doing it. Charging, waiting, blocked and idle time are not busy. Time a robot is broken down is left out.',
          ...(rows.length === 0 && k ? ['There are no robots in this plan.'] : []),
        ],
        inputs: rows,
        run,
      };
    }
    case 'jams':
      return {
        title: 'Jams and deadlocks',
        value: k ? `${n1(k.jamsPerHour)} jams an hour` : undefined,
        text: [
          'A jam is 3 or more robots or people stopped for 10 seconds or more within 7.5 m of each other.',
          `A deadlock is a loop of robots each waiting for the next one, lasting 5 seconds or more. Counted per ${num(s.shift.hoursPerShift)}-hour shift.`,
        ],
        inputs: k
          ? [
              sim('Jams', `${n1(k.jamsPerHour)} an hour`),
              sim('Deadlocks', `${n1(k.deadlocksPerShift)} per shift`),
              sim('Deadlocks over 2 minutes', `${n1(k.deadlocksOver2MinPerShift)} per shift`),
              ...(k.resetsPerHour > 0 ? [sim('Manual robot resets', `${n1(k.resetsPerHour)} an hour`, 'Someone walks over to free a stuck robot.')] : []),
            ]
          : [],
        run,
      };
    case 'order-time':
      return {
        title: 'Order time',
        value: k ? `${minutes(k.avgOrderSec)} min on average` : undefined,
        text: ['Time from an order arriving to it shipping, for orders shipped during the measured time.', ...(k ? [`9 in 10 orders ship within ${minutes(k.p90OrderSec)} min.`] : [])],
        inputs: k ? [sim('Average', `${minutes(k.avgOrderSec)} min`), sim('9 in 10 orders within', `${minutes(k.p90OrderSec)} min`)] : [],
        run,
      };
  }
}
