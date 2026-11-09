// Calm motion: panel numbers ease to their new value instead of jumping (Track F). Off for reduced motion.
import { useEffect, useRef, useState } from 'preact/hooks';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useTween(target: number | null, ms = 450): number | null {
  const [shown, setShown] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    if (target === null || from === null || from === target || reduced()) {
      cur.current = target;
      setShown(target);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / ms);
      const x = u >= 1 ? target : from + (target - from) * (1 - (1 - u) ** 3);
      cur.current = x;
      setShown(x);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return target === null ? null : shown;
}

/** A tweened number, formatted. Shows "—" when there is no value. */
export function Num({ value, format }: { value: number | null | undefined; format: (v: number) => string }) {
  const v = useTween(value ?? null);
  return <>{v === null ? '—' : format(v)}</>;
}
