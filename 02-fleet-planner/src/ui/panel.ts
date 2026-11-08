// Panel contract (PROTOCOL §9). Each file in src/ui/panels/ default-exports one Panel and is mounted automatically.
import type { ComponentType } from 'preact';
import type { Host } from '../host/index.ts';

export type Slot = 'kpi' | 'left' | 'right' | 'bottom' | 'overlay';

export interface Panel {
  id: string;
  /** Where it goes. On phones, 'left', 'right' and 'bottom' panels become tabs in a bottom sheet. */
  slot: Slot;
  /** Lower comes first within a slot. */
  order: number;
  title: string;
  Component: ComponentType<{ host: Host }>;
  /** Hide in some views (e.g. split screen). */
  when?: (view: 'single' | 'split') => boolean;
}

export const definePanel = (p: Panel): Panel => p;
