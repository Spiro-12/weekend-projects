// Full-look downloads wait for the first useful view (PLAN §9 budget: the first view needs ≤ 0.4 MB). The app opens
// the gate when the first useful view is on screen, or after a few seconds at the latest, so a slow first view can
// never hold the models back for good. Tiny on purpose: main.ts and the lazily loaded asset loader both import it.
let open!: () => void;
export const afterFirstView: Promise<void> = new Promise((r) => (open = r));
export function openLoadGate(): void {
  open();
}
