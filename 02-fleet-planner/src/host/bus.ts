// Typed event bus (same pattern as project 01). Handlers that throw are logged, never fatal.
export type Handler<T> = (v: T) => void;

export class Bus<E extends Record<string, unknown>> {
  private h = new Map<keyof E, Set<Handler<never>>>();
  readonly counts: Partial<Record<keyof E, number>> = {};

  on<K extends keyof E>(k: K, fn: Handler<E[K]>): () => void {
    if (!this.h.has(k)) this.h.set(k, new Set());
    this.h.get(k)!.add(fn as Handler<never>);
    return () => this.h.get(k)!.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(k: K, v: E[K]): void {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
    for (const fn of this.h.get(k) ?? []) {
      try {
        (fn as Handler<E[K]>)(v);
      } catch (e) {
        console.error(`[bus] ${String(k)} handler failed`, e);
      }
    }
  }
}
