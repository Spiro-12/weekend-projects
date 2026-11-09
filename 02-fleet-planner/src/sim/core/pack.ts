// Pack stations and the shipping conveyor (the brief §4). Packers are not agents (fixed labor in the money model):
// each station packs one order at a time (pack.secPerOrder), oldest delivered first. Packed orders ship after a fixed
// conveyor delay (CONVEYOR_TICKS).
import type { World } from '../world.ts';

export interface PackStation {
  id: number;
  /** The layout's service cell (the travel goal). */
  service: number;
  /** Order ids delivered and waiting to be packed, oldest first. */
  queue: number[];
  /** Order being packed, or -1, and the tick it is done. */
  packing: number;
  packEnd: number;
  /** Orders sent here and not packed yet (on their way, queued, or being packed): the WMS balances on this. */
  load: number;
}

export class PackFloor {
  readonly stations: PackStation[] = [];
  /** stationAt[cell] = station index + 1 for every free-standing cell next to a station (where a carrier can hand off). */
  readonly stationAt: Int32Array;
  private convOrder: number[] = [];
  private convTick: number[] = [];
  private convHead = 0;

  constructor(world: World, count: number) {
    this.stationAt = new Int32Array(world.n);
    const n = Math.max(1, Math.min(count, world.packStations.length));
    for (let i = 0; i < n && i < world.packStations.length; i++) {
      const s = world.packStations[i];
      this.stations.push({ id: i, service: s.service, queue: [], packing: -1, packEnd: 0, load: 0 });
      for (const c of s.cells)
        for (let d = 0; d < 4; d++) {
          const j = world.nbr[c * 4 + d];
          if (j >= 0 && world.passable[0][j] && !world.isPocket[j] && this.stationAt[j] === 0) this.stationAt[j] = i + 1;
        }
    }
  }

  /** The WMS rule (PROTOCOL §5 rule 8): the least-loaded station; ties go to the nearest, then the lowest id. */
  leastLoaded(distTo: (station: PackStation) => number, except = -1, open?: (station: PackStation) => boolean): number {
    let best = -1;
    let bestLoad = 0;
    let bestD = 0;
    for (const s of this.stations) {
      if (s.id === except && this.stations.length > 1) continue;
      if (open && !open(s)) continue;
      const d = distTo(s);
      if (best < 0 || s.load < bestLoad || (s.load === bestLoad && d < bestD)) {
        best = s.id;
        bestLoad = s.load;
        bestD = d;
      }
    }
    return best;
  }

  /** Packed order onto the conveyor. */
  convey(order: number, shipTick: number): void {
    this.convOrder.push(order);
    this.convTick.push(shipTick);
  }

  /** Orders whose conveyor ride ends at or before `tick`, in order. */
  arriving(tick: number, out: number[]): void {
    out.length = 0;
    while (this.convHead < this.convOrder.length && this.convTick[this.convHead] <= tick) out.push(this.convOrder[this.convHead++]);
    if (this.convHead > 256 && this.convHead * 2 > this.convOrder.length) {
      this.convOrder = this.convOrder.slice(this.convHead);
      this.convTick = this.convTick.slice(this.convHead);
      this.convHead = 0;
    }
  }

  stateWords(out: number[]): void {
    for (const s of this.stations) {
      out.push(s.id, s.packing, s.packEnd, s.load, s.queue.length);
      for (const o of s.queue) out.push(o);
    }
    out.push(this.convOrder.length - this.convHead);
    for (let i = this.convHead; i < this.convOrder.length; i++) out.push(this.convOrder[i], this.convTick[i]);
  }
}
