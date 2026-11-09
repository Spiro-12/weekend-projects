// The order stream (PROTOCOL §4, §8). Contents come from the counter-based hash32(seed, n, …), so order #n is the same
// at every order rate and every fleet (common random numbers: both sides of the split screen see the same orders).
//
// Units: one unit per order line, so units/h = lines/h (the UI says so). A line is one pick at one face.
import type { Scenario } from '../../contracts/types.ts';
import { hash32, scale } from '../rng.ts';

export const OS_QUEUED = 0; // waiting to be released to a cart robot or a manual cart
export const OS_PICKING = 1; // in a pick task
export const OS_PACK = 2; // at its pack station (queued or being packed)
export const OS_CONVEYOR = 3; // packed, on the conveyor to shipping

const SALT_LINES = 0x4c494e45; // 'LINE'

export interface Order {
  id: number;
  arrived: number;
  /** Face id (= ABC rank, world.faces index) of each line. */
  faces: number[];
  stage: number;
  /** Pick task holding it, or -1. */
  task: number;
  /** Pack station (index) it goes to / sits at, or -1. */
  station: number;
}

export class OrderBook {
  /** Open orders (arrived, not shipped). Orders are created in id order, so iteration order = ascending id. */
  readonly open = new Map<number, Order>();
  /** Unassigned orders, lowest id (oldest) first, from `head`. */
  private queue: number[] = [];
  private head = 0;
  nextId = 0;
  shipped = 0;
  private readonly cum: number[] = [];
  private readonly wsum: number;
  private readonly nA: number;
  private readonly aPicksPct: number;

  constructor(
    private readonly seed: number,
    orders: Scenario['orders'],
    private readonly faceCount: number,
  ) {
    let s = 0;
    for (const w of orders.linesWeights) {
      s += Math.max(0, Math.floor(w));
      this.cum.push(s);
    }
    this.wsum = s;
    this.aPicksPct = orders.sku.aPicksPct;
    // A faces: the aPct% of faces closest to packing (rank order), at least one.
    const F = faceCount;
    this.nA = F <= 1 ? F : Math.min(F, Math.max(1, Math.floor((F * orders.sku.aPct + 50) / 100)));
  }

  /** Number of A faces (ranks 0 … nA − 1). */
  get aFaces(): number {
    return this.nA;
  }

  /** Lines in order #n, from the linesWeights (weights for 1, 2, 3, … lines). */
  linesOf(n: number): number {
    if (this.wsum <= 0) return 1;
    const r = scale(hash32(this.seed, n, 0, SALT_LINES), this.wsum);
    for (let i = 0; i < this.cum.length; i++) if (r < this.cum[i]) return i + 1;
    return this.cum.length;
  }

  /** Face (rank) of line k of order #n: aPicksPct of lines go to the A faces, the rest to the others (ABC skew). */
  faceOf(n: number, k: number): number {
    const F = this.faceCount;
    const nA = this.nA;
    const u2 = hash32(this.seed, n, k + 1, 2);
    if (nA >= F || scale(hash32(this.seed, n, k + 1, 1), 100) < this.aPicksPct) return scale(u2, nA);
    return nA + scale(u2, F - nA);
  }

  create(tick: number): Order {
    const id = this.nextId++;
    const lines = this.linesOf(id);
    const faces: number[] = [];
    for (let k = 0; k < lines; k++) faces.push(this.faceOf(id, k));
    const o: Order = { id, arrived: tick, faces, stage: OS_QUEUED, task: -1, station: -1 };
    this.open.set(id, o);
    this.queue.push(id);
    return o;
  }

  get queued(): number {
    return this.queue.length - this.head;
  }

  /** The oldest unassigned order, removed from the queue. */
  take(): Order | null {
    if (this.head >= this.queue.length) return null;
    const id = this.queue[this.head++];
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return this.open.get(id)!;
  }

  /** Orders going back to the queue (a breakdown or a dropped task): oldest first, so they leave again first. */
  requeue(ids: readonly number[]): void {
    for (const id of ids) {
      const o = this.open.get(id);
      if (!o) continue;
      o.stage = OS_QUEUED;
      o.task = -1;
      o.station = -1;
      let lo = this.head;
      let hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.queue[mid] < id) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, id);
    }
  }

  ship(id: number): Order | null {
    const o = this.open.get(id);
    if (!o) return null;
    this.open.delete(id);
    this.shipped++;
    return o;
  }

  /** Up to n queued order ids, oldest first, without taking them. */
  peek(n: number, out: number[]): number[] {
    out.length = 0;
    for (let i = this.head; i < this.queue.length && out.length < n; i++) out.push(this.queue[i]);
    return out;
  }

  /** Take a specific queued order (a batching companion). */
  takeId(id: number): Order | null {
    for (let i = this.head; i < this.queue.length; i++)
      if (this.queue[i] === id) {
        this.queue.splice(i, 1);
        return this.open.get(id)!;
      }
    return null;
  }

  /** Queue contents for hash(), oldest first. */
  queueIds(): number[] {
    return this.queue.slice(this.head);
  }
}
