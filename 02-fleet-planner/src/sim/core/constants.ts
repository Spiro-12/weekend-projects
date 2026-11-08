// Track A sim-core constants. Every estimate carries its reasoning, the same rule as data/agents.json (PROTOCOL §2).

/**
 * Order totes one cart robot (AMR) carries per trip. Orders are never split, so this is also the orders per AMR batch.
 * Estimate: Locus-style cart robots carry a small tote rack; 2 to 4 order totes per trip is typical in e-commerce
 * each-picking. We use 4, the top of that range: with 3 the robots spent too much of each trip driving to packing
 * (calibration with the one-brain planner: 4 totes lifted picker uplift by about 0.1× at every fleet size).
 */
export const TOTES_PER_AMR = 4;

/**
 * Orders a person (or a humanoid) picks per manual cart trip when there are no cart robots.
 * Estimate: multi-order pick carts hold 6 to 8 totes; 6 is the common small cart.
 */
export const ORDERS_PER_CART = 6;

/**
 * Ticks from "packed" to "shipped" (orderPacked → orderShipped): the carton rides the take-away conveyor to the shipping
 * sorter. Estimate: about 40 to 60 m of conveyor at 1.5 to 2 m/s ≈ 30 s = 60 ticks. A fixed delay, so it adds to order
 * time but never changes throughput.
 */
export const CONVEYOR_TICKS = 60;

/** PROTOCOL §5 rule 3 (robot cell claim): a robot blocked this many ticks claims the cell it wants; people let it go. */
export const CLAIM_AFTER_TICKS = 3;

/** PROTOCOL §5 rule 4 (people's manners): a person blocked this many ticks steps to the side. */
export const STEP_ASIDE_AFTER = 4;

/** A person blocked this many ticks (30 s) stops giving way to robot cell claims (rule 3), so no claim can hold a
 *  person for ever. Robots have the 5-minute reset; people need their own way out (seen in testing: a driver stuck
 *  for an hour on a cell a gridlocked robot kept claiming). */
export const PEOPLE_PATIENCE_TICKS = 60;

/** Below this battery percent a robot drops its task at the next safe point and goes to charge (the brief: "immediately
 *  below 10%"). Above it and below the spec's chargeAtPct it charges after its current task. */
export const CRITICAL_BATTERY_PCT = 10;

/**
 * Hand-off dwell at a pack station for carriers whose spec has no handoffSec (a person or humanoid with a manual cart).
 * Estimate: the same 10 s as the cart robot's tote hand-off (data/agents.json amr.handoffSec).
 */
export const DEFAULT_HANDOFF_SEC = 10;

/** Idle people waiting on the pack lane's home cells use every 2nd cell, so the lane stays passable. */
export const HOME_SPACING = 2;

/**
 * Saturate mode ("the queue is always full", PROTOCOL §4): unassigned orders are topped up every tick to this many per
 * picking agent (cart robots, humanoids, pickers), plus a floor. Orders are released oldest first (FIFO), so the queue
 * size never changes throughput; it only has to be big enough that nobody waits for work.
 */
export const SATURATE_ORDERS_PER_AGENT = 6;
export const SATURATE_MIN_QUEUE = 16;

/**
 * Zone admission: at most this many cart robots per zone worker head to or wait in one pick zone at a time. More go to
 * their other stops first; a robot whose remaining zones are all full holds where it is (pushable, state 'wait') until
 * one has room, and a new batch is released to a robot only if one of its zones has room (WMS release control).
 * Without the hold, robots drove into full hot zones anyway past about 50 cart robots and locked up the cross aisle at
 * the hot aisle's mouth (seen in calibration). Estimate: a hot zone near packing is only a few rows of one aisle; 3 waiting robots still leave the
 * picker a lane to walk in, while 2-lane aisles full of waiting robots wall the picker in (seen in testing). Cart-robot
 * fleet managers cap robots per zone for the same reason.
 */
export const ZONE_MAX_AMRS = 3;

/** ...and a zone admits at most one cart robot per this many of its faces (at least 2): the small hot zones near
 *  packing (about 20 faces, a few rows of one aisle) otherwise took 6 robots each, and two of them side by side filled
 *  one aisle with robots, pickers and drivers until it locked (seen in calibration). Estimate: a robot waiting at a face
 *  plus room to pass is about 5 faces of a 2-lane aisle. */
export const ZONE_FACES_PER_AMR = 5;

/**
 * A free zone worker is sent to a cart robot still on its way into the zone once the robot is within this many cells
 * of its face (18 m, about 20 s at 1 m/s), so the two arrive together instead of the robot waiting for the walk. Cart
 * robot systems show pickers the next robot coming to them for the same reason. Estimate: further out, pickers
 * spent a quarter of their time waiting for robots held up in traffic (seen in testing).
 */
export const PRESEND_CELLS = 12;

/**
 * WMS batching window: a batch is the oldest queued order plus the closest-lying orders among the next BATCH_WINDOW
 * (cluster picking, used for cart robots and manual carts alike). Estimate: WMS waves release a few minutes of orders
 * at a time; 20 orders is about 2 minutes at 600 orders/h, so no order waits long for company.
 */
export const BATCH_WINDOW = 20;

/**
 * Zone workers per pick zone: two. Two people sharing a zone pool its robots (a robot gets the sooner of the two),
 * which beat one picker per smaller zone in calibration with the one-brain planner (1.68x vs 1.62x uplift at 42 cart
 * robots, 14 pickers). Zones are cut within aisles by expected work, so the zones near packing are a few rows of one
 * aisle. Estimate.
 */
export const ZONE_PICKERS = 2;

/**
 * Zone bleed: a free picker also serves a cart robot that has waited BLEED_WAIT_TICKS (5 s) at a face in a neighbouring
 * zone, counted BLEED_PENALTY_CELLS further away than it is, so its own zone comes first. It also covers a zone whose
 * pickers are both on a break, charging (humanoids) or broken. Estimate: cart-robot sites let associates help the next
 * zone ("dynamic zones") rather than leave robots waiting.
 */
export const BLEED_WAIT_TICKS = 10;
export const BLEED_PENALTY_CELLS = 4;

// ───────── manual cart picking (the people-only baseline) ─────────
// What a cart picker does that a cart robot takes over. In the Locus model the robot is inducted with its totes by the
// system, its screen tells the picker which tote each unit goes in, and the packer unloads it; with a manual cart the
// picker does all three. Together with the walking, these are the real gain of cart robots.

/**
 * Cart induct at the start of every manual trip: fetch an empty cart, label or scan its order totes, start the batch.
 * Estimate: 60 to 120 s per trip in multi-order cart operations; we use 60 s, the low end, so the manual baseline is not
 * flattered against the robots (with the two below it lands people-only near the 75 units/picker-hour of case studies).
 */
export const CART_SETUP_SEC = 60;

/**
 * Put-to-cart on a multi-order cart: after each pick the picker scans the unit and the right tote and drops it in
 * (sort while picking). Estimate: 3 to 5 s per line; we use 3 s, the low end. A single-order cart has nothing to sort.
 */
export const PUT_TO_CART_SEC = 3;

/**
 * Hand-off at the pack station per tote from a manual cart (lift the tote off, scan it in). Estimate: 8 to 12 s per
 * tote; we use 10 s, the same as the cart robot's whole hand-off (data/agents.json amr.handoffSec), which the packer
 * does from the robot.
 */
export const TOTE_HANDOFF_SEC = 10;

/**
 * A person picking into a cart robot's tote takes this percentage of pickSecPerLine. The robot parks at the location and
 * its screen shows the item and the tote, so the "search" part of a pick goes away; the reach and extract stay.
 * Source: Tompkins' split of manual picker time (travel 50%, search 20%, extract 15%, setup 10%, other 5%; RESEARCH.md
 * Part A [78]): of the 40 non-travel, non-setup points, search is 20, so a screen-guided pick is about half to two
 * thirds of a manual one. Range 50 to 70%; we use 60%. Humanoids keep their own spec rate.
 */
export const ASSISTED_PICK_PCT = 60;

/**
 * Wait-age credit when a picker chooses its next cart robot: a robot already waiting at its stop counts one cell nearer
 * for every WAIT_CREDIT_TICKS (10 s) it has waited, up to WAIT_CREDIT_MAX_CELLS. Nearest-first alone left a far robot
 * in an edge zone (one neighbour to bleed from) waiting about 15 minutes. Estimate: cart-robot screens show the oldest
 * waiting robot first once it has waited a while.
 */
export const WAIT_CREDIT_TICKS = 20;
export const WAIT_CREDIT_MAX_CELLS = 10;

/**
 * Pack admission (WMS release control): a carrier with all its lines picked drives to pack only when the least-loaded
 * station with a free queue slot exists; a station's queue is the carriers heading to it or handing off there, at most
 * PACK_QUEUE_SLOTS. Otherwise it holds: on its pick-aisle cell, or the nearest free one if it is on a main or cross
 * aisle, state 'wait'. Held carriers are released first in, first out. Estimate from the lane geometry: a 2-cell
 * station has 2 hand-off cells and about 1 approach cell in the 2-wide pack lane before robots spill into the cross
 * aisle, so 3. Without it, robots delivering faster than 6 stations pack queued into the cross aisle and the floor
 * locked up past about 50 cart robots (seen in calibration: 337 manual resets in 2.5 h at 56 robots).
 */
export const PACK_QUEUE_SLOTS = 3;

/**
 * Batch release: a cart robot (or manual cart) gets a batch only when TOTES_PER_AMR (ORDERS_PER_CART) orders are queued,
 * or when the oldest queued order has waited this long. Estimate: WMS waves and batch release hold orders for a
 * minute or so to fill a trip. Without it, at 600 orders/h with idle robots, two thirds of trips left with one order,
 * so demand mode needed twice the trips that saturate capacity suggested and fell behind (seen in calibration).
 */
export const BATCH_MAX_WAIT_SEC = 60;

/**
 * A picker waiting at a face for an incoming cart robot gives the meeting up once that robot has been blocked this
 * many ticks (30 s), and stands down like an idle person (it steps off cells robots claim and lets pickers pass).
 * Pickers standing in both lanes of an aisle for robots that their own bodies were blocking formed wait-for cycles
 * that only manual resets broke (seen in calibration with drivers doing all the pallet work). Estimate.
 */
export const MEET_GIVEUP_TICKS = 60;
