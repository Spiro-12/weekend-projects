# Fleet Planner: results and assumptions

The honest numbers, every modeling assumption, and every budget change. Phase 2 adds the one-brain vs many-brains
results and the sweep knee.

## Budget changes
| Budget | Was | Now | Why |
|---|---|---|---|
| Initial JS + CSS (gz) | 250 KB (tightened from the plan's 300 KB after Phase 0) | 280 KB | Phase 1 puts the real sim core and the one-brain planner on the main thread: the live view runs them every frame, so they can't load later (about +20 KB). The money model and FakeSim are kept out of the first-view bundle (money loads lazily). Still under the plan's 300 KB. |

## Keeps up
"Keeps up" = the open-order backlog grows by at most 5% of demand per hour over the 2-hour measured window (was 2%).
Random order arrivals alone move that 2-hour trend by about ±3% (±19 orders/h at 600/h), so a 2% line called fleets
with spare capacity "falling behind" on an unlucky arrival stream (seen in Phase 1 integration). A real shortfall shows
as a steady trend well above 5%. The same line sizes the people-only baseline crew, so both sides are judged alike.

## Baseline crew search
The people-only crew is found in at most 4 runs (so the money panel stays fast), not by brute force. Against brute force
on test models it lands on the true minimum about 71% of the time and is never under it; with a misleading driver
reading at very high demand (1,200 orders/h) it can end up to 2 people over. A crew that is too big makes people-only
look a little more expensive, so at worst robots look slightly better than they are. Phase 1 lead check: the default
scenario's crew equals the brute-force minimum (see the golden tests).

## Phase 1 calibration (default scenario, one brain, seed 42)
| Measure | Value | Target / source |
|---|---|---|
| Manual picker (people only, carts) | 71.6 units/picker-hour | about 75 (case-study "before" baselines) |
| Picker with cart robots | 122.1 units/picker-hour | about 135 (case studies) |
| Picker uplift | 1.71x | 1.5 to 2.2x (case studies 1.8 to 2.2x; vendor claims 2 to 3x) |
| Capacity (saturate) | 648.5 orders/h | 8% over the 600/h demand |
| Deadlocks | 8 per shift, all under 2 minutes; 0 manual resets | |

**Default fleet:** 32 cart robots, 12 pickers, 1 forklift driver (no autonomous forklifts or humanoids). It keeps up on
seeds 42, 7 and 99 and pays back in 30 to 37 months when bought. Auto-sized people-only crew: 19 pickers + 1 driver
(equal to the brute-force minimum). Humanoids and autonomous forklifts are one click away; on these numbers they don't
pay back yet (a pilot of one each pushes payback past 70 months), which matches RESEARCH.md.

**Small:** 14 cart robots, 6 pickers, 1 driver at 300 orders/h (about 30% spare capacity, payback about 38 months).
**Large:** 900 orders/h (was 1,200: its 10 pack stations cap at 1,200, so it could never keep up with margin); 60 cart
robots, 22 pickers, 2 drivers; 9 to 12% spare capacity, payback 43 to 50 months (longer walks in a bigger building).

**Saturation:** capacity rises with cart robots and flattens past about 36; past the knee it stays at 90 to 99% of its
peak (crowding costs a little). The plan's "flat ±3%" was too tight for that; the golden test checks ≥ 90% (no collapse).

**Modeling rules added in calibration** (src/sim/core/constants.ts has each with its reasoning and range):
- **Picking with a cart robot:** a picker picking into a cart robot's tote takes 60% of the manual pick time. The robot
  parks at the shelf and its screen shows the item, so the search part of the pick goes away (Tompkins' time split).
- **Manual carts:** 60 s cart setup per trip, 3 s put-to-cart per line on multi-order carts, 10 s per tote at packing.
- **Zones:** 2 pickers per zone, zone bleed into neighbouring zones, and a zone admits at most about 1 cart robot per
  5 faces.
- **WMS release control:** at most 3 carriers per pack station; batches released when full or 60 s old; robots hold
  (state "wait") when their zones or pack stations are full.
- **People:** they give way to a robot's cell claim for at most 30 s, and give up a meeting with a robot that has been
  stuck for 30 s.
