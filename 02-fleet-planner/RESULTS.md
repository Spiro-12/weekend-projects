# Fleet Planner: results and assumptions

The honest numbers, every modeling assumption, and every budget change. Phase 2 adds the one-brain vs many-brains
results and the sweep knee.

## Budget changes
| Budget | Was | Now | Why |
|---|---|---|---|
| Initial JS + CSS (gz) | 250 KB (tightened from the plan's 300 KB after Phase 0) | 280 KB | Phase 1 puts the real sim core and the one-brain planner on the main thread: the live view runs them every frame, so they can't load later (about +20 KB). The money model and FakeSim are kept out of the first-view bundle (money loads lazily). Still under the plan's 300 KB. |

## Keeps up
"Keeps up" (PROTOCOL §6) = **capacity ≥ demand** (the same settings run with the order queue always full) **and** the
open-order backlog grows by at most 5% of demand per hour over the measured window. Capacity decides; the trend is a
second check on the normal run. Phase 1 integration first used the trend alone at 5% (was 2%); the integration review
showed that passes a people-only crew that is really 3% short (19 pickers: capacity 582.5 orders/h for 600 ordered),
which made robots look worse than they are. Every fleet sees the same orders at one seed, but how they bunch up in a
2-hour window still moves a healthy fleet's trend (+15.4/h on seed 99 with 12.6% spare capacity), so the trend alone
can't tell short from unlucky. The same rule sizes the people-only baseline crew, so both sides are judged alike.

## Baseline crew search
The people-only crew is found in at most 4 searches (1 capacity run, then up to 3 crews, each of which also needs its own capacity run: up to 7 simulations, about 3 to 8 s for the large building on one worker), not by brute force. On the default
scenario it is 20 pickers + 1 driver, and the `zero-robots` golden test checks both that the search returns exactly that
crew and that one picker fewer doesn't keep up. Against brute force on test models the search lands on the minimum
in most cases and is never under it; a crew that comes out too big makes people-only look a little more expensive.

## Phase 1 calibration (one brain; measured at the end of Phase 1 integration)
All runs: 30 min warm-up + 2 h measured. Uplift = units per picker-hour with cart robots ÷ people only, both at capacity.

| Scenario | Seed | Capacity (spare) | Uplift | Deadlocks/shift (over 2 min) | Buy: payback, 3-year net | Rent: payback, 3-year net |
|---|---|---|---|---|---|---|
| Default (32 cart robots, 12 pickers, 1 driver; 600/h) | 42 | 648.5 (8.1%) | 1.70x (121.5 vs 71.6) | 4 (0) | 30 months, +$296,507 | 14 months, +$552,507 |
| | 7 | 669.5 (11.6%) | 1.77x | 4 (0) | same | same |
| | 99 | 675.5 (12.6%) | 1.78x | 16 (0) | same | same |
| Small (14 cart robots, 6 pickers, 1 driver; 300/h) | 42 / 7 / 99 | 370.5 / 404 / 398 (24 to 35%) | 1.77 to 1.88x | 0 to 4 (0) | 38 months, −$33,811 | 24 months, +$78,189 |
| Large (60 cart robots, 22 pickers, 2 drivers; 900/h) | 42 | 923 (2.6%) | 1.54x | 8 (0) | 37 months, −$98,178 | 22 months, +$381,822 |
| | 7 | 1,007.5 (11.9%) | 1.66x | 72 (0), 1 reset/h | 44 months, −$487,641 | 36 months, −$7,641 |
| | 99 | 1,019 (13.2%) | 1.68x | 0 (0) | 43 months, −$425,241 | 33 months, +$54,759 |
| Default + 1 humanoid + 1 autonomous forklift (pilot) | 42 / 7 / 99 | 661 / 685 / 678 | 1.72 to 1.76x | 0 to 8 (0) | 46 months, −$402,893 | 36 months, −$3,493 |

- **Picker uplift 1.70 to 1.88x** at the default and small sizes: inside the case studies' 1.8 to 2.2x band at its low end,
  below vendor claims of 2 to 3x. The large building is lower (1.54 to 1.68x): longer walks within bigger zones.
- **Manual picking** lands at 70 to 72 units/picker-hour on the default layout (case-study "before" baselines: about 75).
- **The default pays back in 30 months bought, 14 months rented.** 80% of buyers want payback within 3 years, so it
  passes, but not by much. Money is the same on every seed: crews and fleets are fixed, and no seed had manual resets.
- **Humanoids and autonomous forklifts don't pay back yet** on these numbers (a pilot of one each adds about 16 months),
  which matches RESEARCH.md. They are one click away in the fleet panel.
- **The large building at seed 42 has only 2.6% spare capacity:** it keeps up, but barely. Large went from 1,200/h to
  900/h because its 10 pack stations cap at 1,200/h, so it could never keep up with margin.
- **Saturation** (cart robots 4 / 12 / 24 / 36 / 48 / 60 at capacity): 139 / 359 / 593.5 / 670 / 662.5 / 652.5 orders/h.
  It rises, then eases slightly past the knee (crowding). The golden test checks ≥ 95% of the peak past the knee.

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
- **Held robots the planner pushes aside wait where they land:** about 18% of held time is on main or cross aisles.
  Sending them back to a pick-aisle cell cost up to 10% capacity when over-fleeted, so it is not done.

## Open items for Phase 2
- **Faster order-rate changes:** a capacity run doesn't use the order rate for its verdict, but the run cache key
  includes it, so every order-rate slider step reruns the capacity run. Check whether saturate runs are truly independent
  of `orders.perHour` (arrival draws still happen) and, if so, leave it out of the capacity half's key.
- **Phones with one runner worker** run demand and capacity one after the other: up to about 2 s per evaluate for the
  large building in Node, more on a phone. Measure on Spiro's phone with the sweep (Track J).
- **Traffic modes:** every mode runs the one-brain planner until Track G lands; add a guard before the UI offers another mode.
- **The sweep** may want bare demand runs in the browser: export the unwrapped worker runner then.
