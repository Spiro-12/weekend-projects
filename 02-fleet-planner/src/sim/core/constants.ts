// Track A sim-core constants. Every estimate carries its reasoning, the same rule as data/agents.json (PROTOCOL §2).

/**
 * Order totes one cart robot (AMR) carries per trip. Orders are never split, so this is also the orders per AMR batch.
 * Estimate: Locus-style cart robots carry a small tote rack; 2 to 4 order totes per trip is typical in e-commerce
 * each-picking. 3 is the middle of that range.
 */
export const TOTES_PER_AMR = 3;

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
 * Zone admission: at most this many cart robots per zone worker head to or wait in one pick zone at a time (more go to
 * their other stops first). Estimate: a hot zone near packing is only a few rows of one aisle; 3 waiting robots still leave the
 * picker a lane to walk in, while 2-lane aisles full of waiting robots wall the picker in (seen in testing). Cart-robot
 * fleet managers cap robots per zone for the same reason.
 */
export const ZONE_MAX_AMRS = 3;

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
 * Zone workers per pick zone. Estimate: two people sharing a zone pool their work (a robot waits for the nearer free
 * one), which cuts robot waiting a lot versus one picker per zone, while walks stay short. One per zone left robots
 * waiting for a busy picker while the neighbour stood idle (seen in testing).
 */
export const ZONE_PICKERS = 2;
