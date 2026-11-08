# Phase 0 spikes

Short experiments that proved the risky parts before the contracts froze (PLAN.md §7, Phase 0). Each folder has a
`RESULTS.md` with the measured numbers. **Reference code only:** not shipped, not built, not run by the gate. Later
tracks lift from it (Track B and G: `b-traffic/src/traffic.ts`).

| Spike | What it proved | Results |
|---|---|---|
| a, render | Instanced world + 150 agents per side in split screen within the frame budget; the perf harness (`scripts/perf.ts`) | `a-render/RESULTS.md` |
| b, traffic | PIBT one brain vs per-vendor many brains with a recovery ladder: speed, the gap, deadlocks, cross-engine determinism | `b-traffic/RESULTS.md` |
| c, assets | SimReady pipeline within budget, code-built AMR / humanoid / autonomous forklift, CC0 worker, licenses | merged into `scripts/assets/`, `public/assets/`, `src/render/models/`, `CREDITS.md`; results in `c-assets-RESULTS.md` |
