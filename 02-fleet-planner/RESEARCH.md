# Fleet Planner: Research

Research for weekend project 02, done 2026-11-08 by four research agents working in parallel (specs and prices, assets, tech, market). Every number has a numbered footnote to the source list at the end of its part, or is labeled **ESTIMATE** with its reasoning. The build plan that uses this research is [PLAN.md](PLAN.md) (section 3 has the short version).

## Contents
- [Part A: Agent specs and prices](#part-a-agent-specs-and-prices): speeds, payloads, batteries, buy and rent prices, wages, productivity, recommended sim defaults
- [Part B: SimReady asset survey](#part-b-simready-asset-survey): what the NVIDIA SimReady GLB set has (and lacks), sizes, licenses, the humanoid and worker answer, download budget
- [Part C: Rendering, pathfinding and determinism tech](#part-c-rendering-pathfinding-and-determinism-tech): three.js vs others, PIBT traffic for one brain and many brains, determinism rules, measurement, the social clip
- [Part D: Market and why-now](#part-d-market-and-why-now): mixed fleets, VDA 5050 v3 and ISO 21423, orchestration startups, NVIDIA SimReady Central, context numbers, competition, the reference posts

## Headline findings
- Buyers use **3.4 robot brands** on average and **80% want payback within 3 years**; **45%** name integration as the top barrier, ahead of cost at 41% (Part D).
- Mixed fleets today run in separate zones or take turns at shared spots; **ISO 21423** (2 Nov 2026) and **VDA 5050 v3.0** (Apr 2026) are the new interoperability standards (Part D).
- NVIDIA's **SimReady Central** (21 Oct 2026) offers 2,000+ free assets for testing "before real-world deployment" (Part D). The community GLB conversion is CC BY 4.0 but has **no people, no humanoid and no AMR**, and many models are far too heavy for the browser as shipped (Part B).
- AMR "2 to 3x" productivity claims come from vendors; case studies work out to about **1.8x** (Part A).
- **Humanoids don't pay back yet**: about $8,500/month plus setup for roughly half a person's output (Part A).
- PIBT traffic runs at about **0.03 ms per tick for 150 agents**; a naive "many brains" model gridlocks and needs a recovery ladder (Part C).


---

# Part A: Agent specs and prices


Research date: 2026-11-08. Every number carries a footnote [n] to the numbered source list, or the label **ESTIMATE** with how it was derived.
Tags: **(V)** = vendor or marketing claim, **(2nd)** = secondary or aggregator source (weaker), **(old)** = source dated before 2024.


---

### 1. Cart robots / AMRs (person-to-goods tote picking, tote and cart transport)

| Product | Top speed (m/s) | Payload (kg) | Runtime (h) | Charge | Footprint (L x W m) | Buy price (USD) | RaaS price | Tasks | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Locus Origin (Origin 2) | ~1.8 [3] (2nd), not found in a Locus doc | 36 [1](V) | 14 per charge [1](V); "8 h typical" in a 2023 EU distributor PDF [4] | 50 min to full [1](V) | 0.56 dia., 1.47 m tall (22 in dia. x 57.8 in) [1] | not public | ~$1,000/mo (2017) [5](old); $950/mo (Forrester TEI 2019, Locus commissioned) [6](old,V); ~$2,000/mo all-in, analyst estimate [7](2nd) | pick assist (tote to person), tote transport | Locus says 2-3x pick rates [56](V); bot:picker ratio 3.5:1 in TEI model [6](old) |
| Locus Vector | not found | 272 (600 lb) [2](V) | 8-10 [8](2nd) | ~60 min; opportunity charging [8](2nd) | 0.76 x 0.57 x 0.51 h [2] | not public | not public | cart, shelf, case transport (mecanum omnidirectional) | |
| Zebra/Fetch Fetch100 Flex / FlexShelf | 1.75 [12](V) | 75 total; 25-30 per shelf [13](V) | ~9 continuous [12](V) | not found | not found | not public | not public | tote/bin picking, transport | **Zebra is exiting or winding down the Fetch AMR unit (SEC filing Dec 9, 2025)** [14]. Do not use as a default. |
| OTTO 100 (Rockwell) | 2.0 [15](V) | 150 (incl. cart/attachments) [15] | 6 (90%-10%) [15] | not found | not found | not public | not public | cart and tote transport | |
| OTTO 600 | 1.4 [17](2nd) | 600 [17](2nd) | not found | not found | 1.05 x 0.70 x 0.32 h [17](2nd) | not public | not public | cart/pallet transport | |
| OTTO 1500 | 2.0 [16](V) | 1,900 (incl. attachment) [16] | 10 (90%-10%) [16] | 60 min (10-90%) [16] | not found | not public | not public | heavy cart, pallet transport | |
| MiR250 | 2.0 [9](V) | 250 [9] | "up to 20 h/day" with battery swap [9](V); per-charge runtime not given | not found | 0.80 x 0.58 x 0.30 h [9] | not public | not public | cart/shelf transport (Hook, Shelf Carrier tops) | needs 80 cm passage width [9] |
| MiR600 | 2.0 at max payload, flat floor [10](V) | 600 (500 with lift) [10] | 8 h 20 m at max payload; 10 h 45 m empty [10](V) | 45-70 min (10-90%), distributors disagree [10] | 1.35 x 0.91 x 0.32 h [10] | not public | not public | pallet/cart transport | |
| 6 River Systems Chuck (Ocado) | 1.2 for Chuck Pallet (2nd) [19] | 90.7 (200 lb) [18](old); 160 lb on another listing [19] | ~8 [19](2nd) | not found | not found | not public | ~$30k/yr per unit, unverified (2nd) [19] | pick assist (cart to person) | Ocado bought 6RS in 2023; the 6RS team was reportedly cut [20]. Treat as legacy. |
| Geek+ P800R (shelf-to-person) | 2.0 loaded / 1.6 empty [21](V) | 600 (current V6); older P800 rated 1,000 [21] | not found | not found | lifts shelves up to 0.88 x 0.88 [21] | ~$30,000/unit, aggregator estimate [24](2nd) | per-transaction billing reported [24](old,2nd) | shelf-to-person (goods to person) | Geek+ claims 2-3x vs manual [22](V); subscription orders are ~6.5% of Geek+ H1-2026 orders [23] |
| Geek+ RS series (tote ACR) | 1.8 loaded / 1.5 empty [21b](V) | 40 per tote [21b] | not found | not found | not found | not public | not public | tote retrieval up to 7.9 m racking | |
| inVia Picker | not found | 18 per tote [25](old) | 10 (hot-swap batteries) [25](old) | hot swap | not found | not public | monthly subscription, priced per pick; ~$0.10/pick claim [26](old,V) | goods-to-box picking, tote transport | |
| Brightpick Autopicker 2.0 | not found ("20% faster travel") [29] | 2.5 per pick; 30 per tote [27] | up to 12 [27](V) | 1 h charge gives 6 h work [27](V) | not found; 2.15 m min. clear height; ~200 kg robot [27] | CapEx option, no price [28] | **$2,190/robot/mo (US), minimum 15 robots, minimum 3-yr term** [27][28](V); launched at $1,900 [29] | autonomous piece picking (robot picks), tote transport | 70-80 picks/h per robot [29](V); payback claim: RaaS under 6 months, CapEx 1-3 yr [27](V) |

**AMR safety rules.** ISO 3691-4 (2023) and ANSI/ITSDF B56.5 / RIA R15.08 do not set one fixed speed near people. Speed must fit the safety-scanner protective field and braking distance. Sites define slow and no-go zones by risk assessment [49]. Example: 0.3 m/s while scanners are muted during docking [49](2nd).
**AMR cost extras.** Fleet software: $200-800 per robot per month, from a vendor-affiliated guide [53](2nd, weak). Maintenance: 10-20% of purchase price per year [53](2nd); service contracts 10-15% per year [54](2nd). Unit price is about 40-70% of deployed cost [54](2nd). Full warehouse robot rollouts average about $1M (Interact Analysis via CFO Dive) [51c](2nd). Singapore's productivity grant caps AMR equipment at S$37,500 per unit [55], a public reference price point.

---

### 2. Autonomous forklifts / pallet movers

| Product | Top speed (m/s) | Payload (kg) | Lift height | Runtime / charge | Footprint (L x W m) | Buy price | RaaS | Tasks | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Vecna CPJ (cobot pallet jack) | 1.25 (2.8 mph) [31](V) | 1,500 (3,300 lb) [31] | ground (pallet jack) | 4 h run, 2 h charge (2026 sheet); product page says quick-change battery every 2.5 h [31][32] | 1.74 x 0.93 x 2.20 h (68.5 x 36.5 x 86.5 in) [32] | not public | Vecna: one "annual fee incl. implementation and maintenance" [33](V); "$10 per robot-hour or less" (2nd, unverified) [34] | pallet move, tugging | |
| Seegrid Palion Lift CR1 | 2.2 (5 mph) [35](V) | 1,814 (4,000 lb) [35] | 4.6 m (15 ft) [35] | not found | not found | not public; $150-250k is an aggregator *estimate* [36](2nd) | not public | putaway, replenishment, pallet move | Lift RS1: 1,588 kg (3,500 lb) to 1.8 m (6 ft) [36] |
| Seegrid Palion Tow Tractor S8 | not found | 4,536 towed (10,000 lb) [37] | n/a | not found | not found | not public | not public | cart train towing | |
| OTTO Lifter (Rockwell) | 1.5 [38](V) | 1,200 [38] | 1.0 m autonomous; 2.7 m manual [38] | charge 60 min (10-90%) [38] | not found | not public | not public | pallet move, low stacking | |
| BALYO (Reachy etc.) | not found | ~1,700 (1.7 t) [40] | 11 m (36 ft) reach; VNA to 17 m (56 ft) [40] | not found | aisle 2.97 m (9 ft 9 in) [40] | not public | not public | putaway, replenishment | 2025 revenue EUR 31.4M [39]; take-private offer Dec 2025 [39] |
| Third Wave Automation TWA Reach | not found | not found | up to 9.3 m (366 in) base [41] | not found | aisles >= 3.05 m (10 ft) [41] | not public | RaaS, fixed monthly fee, no number [41] | putaway, replenishment, remote-assist modes | one remote operator can watch several trucks (up to 10, 2nd) [41]; Raymond/Toyota partner [42] |
| Fox Robotics FoxBot Mk3 | not found | not found | n/a | not found | not found | not public | not public | trailer load and unload | Mk3: >50 double- or 25 single-stacked pallets in <1 h [43](V); real average ~25 pallets/h, best sites ~30 [44]; 1 person can supervise up to 6 [43](V) |
| VisionNav VNP15 | 1.5 (CE sheet) to 2.1 (catalog), conflicting [45] | 1,500 [45] | 3.0 m [45] | not found | not found | not public | not public | pallet move, stacking | |
| Raymond Courier 3030 (Toyota) | 1.8 (4 mph, 2024 upgrade from 3 mph) [46](V) | 1,134 (2,500 lb) [46] | 1.83 m (72 in) [46] | not found | not found | not public | not public | pallet move, low stacking | |
| Jungheinrich EKS 215a | 1.9 laden / 2.5 empty (7 / 9 km/h); load-direction travel limited to ~5-6 km/h [47](V) | 1,500 (spec sheet); 700 kg to 6 m in press [47] | 6 m [47] | not found | not found | not public | not public | putaway, replenishment | |
| Linde automated (L-MATIC) | not found | not found | not found | not found | not found | not public | not public | | no data retrieved |

**Market price ranges (all secondary, all weak):** autonomous forklift $100k-250k to buy, or $3k-8k/mo RaaS, payback 18-30 months on multi-shift sites [48](2nd). Another source gives $60k-150k+ autonomous vs $20k-40k manual [48b](2nd). Manual forklift $25k-60k [48](2nd).

---

### 3. Humanoids in warehouse roles (most prices are targets, not quotes)

| Product | Speed (m/s) | Payload (kg) | Runtime / charge | Footprint | Price | RaaS | Tasks / status |
|---|---|---|---|---|---|---|---|
| Agility Digit 4 (shipping) | ~1.5 (2nd) [61] | 16 (35 lb) (2nd) [61] | 2:1 work-to-charge ratio (2024) [57] | ESTIMATE ~0.6 x 0.5 m | Purchase ~$200k + $20k deployment + $36k/yr software and maintenance (S-4-based analysis) [58] | **$8,500/robot/mo incl. software and maintenance, plus ~$25k one-time deployment** (S-4-based analysis) [58][59]; implies ~$49/h on one shift, ~$25.76/h at 330 h/mo [58] | Tote moving at GXO Flowery Branch GA, multi-year RaaS signed June 2024; Statesville NC and Lebanon TN start early 2027 [62] |
| Agility Digit 5 (announced 2026-09-15, not shipping) | not found | 23 (50 lb, "repeatedly") [63](V) | 90 min run / 9 min charge = 10:1, ">20 productive h/day" [63](V) | 1.80 m tall (5 ft 11 in); reach 2.2 m (7.2 ft) [63] | BOM ~$150k at launch, target $30k at 10k units/yr [59](V) | same $8,500/mo model [58]; $300M conditional order for 1,000 robots, 3-yr service [59] | early access H1 2027, general availability end 2027 [59][63] |
| Apptronik Apollo | not found | 25 [64](old) | ~4 h, swappable battery [64](old) | 1.73 m tall, 72.5 kg [64] | target "under $50k" at scale [65](V target) | RaaS said to be offered, unconfirmed [65] | pilots and trials only (Mercedes, GXO, Jabil) [65] |
| Figure 03 | 1.2 [66](V) | 20 [66](V) | 5 h [66](V) | 1.73 m, 61 kg [66] | no list price; ~$20k target is unconfirmed (2nd) | not public | Figure 02 BMW pilot ended Nov 2025; Figure 03 at BMW from mid-2026 (vendor claim, 2nd) |
| Tesla Optimus | 1.2-2.2 claims (2nd) | ~20 (Gen 2) (2nd) | ~2.3 kWh pack; runtime claims 2-8 h (2nd) | 1.73 m, 57 kg (2nd) | **Musk target $20-30k long run** [67](target) | none | not for sale; external sales not expected before 2027 [67] |
| Unitree G1 | not listed [68] | **~2 per arm** [68] | ~2 h, quick-release battery [68] | 1.32 m tall, ~35 kg [68] | **$13,500 list (official site, Nov 2026)** [68]; was $16,000 at 2024 launch [70](old) | none | research/education. Not a warehouse worker (2 kg arm). |
| Unitree H1 / H1-2 | 3.3 (H1, record); <2 (H1-2) [69] | H1-2 arm ~7 rated / 21 peak [69] | 864 Wh battery; runtime not listed [69] | 1.78-1.80 m; 47-70 kg [69] | ~$90k at 2024 launch [70](old); official site does not list a price | none | research |
| Boston Dynamics Atlas (product, CES 2026) | not found | up to 50 (110 lb) [71](V) | ~4 h; swaps its own batteries [71][72] | reach 2.3 m; 56 DoF [71] | not announced | none | 2026 output all committed to Hyundai RMAC and Google DeepMind; other customers from 2027 [71] |
| UBTech Walker S2 | not found | 15 (2nd) [74] | autonomous battery swap ~3 min [73] | not found | not disclosed; reseller listings $145k-243k [74](2nd) | none | mass production from Nov 2025; >800M yuan of Walker-series orders [75] |
| 1X NEO | not found | 25 carry (2nd) | not found | 1.68 m, ~30 kg (2nd) | **$20,000 or $499/mo (6-mo minimum)** [76] | consumer subscription | home robot, not warehouse |

**Humanoid ROI reality check:** after 45 humanoid pilots, GXO's CEO said (Aug 2026): "We have not achieved ROI on humanoids yet ... a couple of years away" [62].

---

### 4. Human pickers and forklift operators

| Field | Value | Source |
|---|---|---|
| Unloaded comfortable walking speed | 1.27-1.46 m/s (adults 20-79) | Bohannon 1997 via [80](old) |
| Speed pushing a picking cart | 0.25-1.1 m/s, depends on cart weight and handle height | Resnick & Chaffin 1995 via WSC 2017 [79](old) |
| Share of picker time spent walking (manual picker-to-parts) | ~50% (travel 50, search 20, extract 15, setup 10, other 5) | Tompkins, via [78] and [79](old) |
| Manual cart picking rate, "before" baselines in vendor case studies | 71 UPH (Verst), 78 UPH (DHL), 119 UPH (MyPillow), 30-40 UPH (Kenco), 40-45 lines/h (UPS) | [84][85][86][87][88](V) |
| AMR-assisted rate, same sites | 155, 150, 210, 120-150 UPH; 80-90 lines/h, so 1.8-2.2x (Kenco ~3-4x outlier) | same (V) |
| Vendor uplift claim | "2-3x" (Locus) [56]; "2-3x" (Geek+ shelf-to-person) [22] | (V) |
| Independent evidence | Field study of 2.09M location visits (follow-me truck cobot): hybrid picking was faster, mainly on short-distance orders [81]. "Up to 33.57%" time cut seen only in an author-profile snippet, not verified. Simulation: throughput peaks near 2 AMRs per picker [82]. | [81][82] |
| Wider ranges | Manual piece picking 60-400 picks/h depending on layout [89](2nd). WERC median 35 lines picked and shipped per person-hour, best-in-class >= 92.8 (2018 report; covers all DC labor) [90](old) | |
| Carry / lift limit | NIOSH load constant 23 kg (51 lb) under ideal conditions | [83] |
| Forklift putaway rate | 18-30 pallets per labor hour [91](2nd); 32/h for full-pallet putaway [92](old); 20 pallets/h job target [91] | |
| Forklift speed rules | OSHA sets no numeric speed limit: slow down, sound horn, yield to pedestrians [93]. Vendor guidance: 3 mph (1.34 m/s) in rack aisles, 5 mph (2.2 m/s) indoors, 7 mph outdoors [94](V) | |

**Wages (BLS OEWS May 2025, the latest release; May 2024 was replaced).** 43-5081 is now coded **53-7065**.

| Occupation (SOC) | Median annual | Median hourly | Source |
|---|---|---|---|
| Stockers and Order Fillers (53-7065, formerly 43-5081) | $37,330 | **$17.95** (= annual / 2,080; BLS OOH does not print hourly) | [95] |
| Laborers and Freight, Stock, and Material Movers, Hand (53-7062) | $40,240 | **$19.35** (matches O*NET $19.35) | [95][96] |
| Industrial Truck and Tractor Operators (53-7051) | $46,420 | **$22.32** (matches O*NET $22.32) | [97][98] |
| Hand laborers and material movers (group) | $38,220 | $18.38 (published) | [95] |

- **Fully loaded multiplier (BLS ECEC, June 2026, private industry):** all workers: wages 70.0%, benefits 30.0%, so the multiplier is 1/0.700 = **1.43** [99]. Transportation and material moving occupations: wages $24.97 (68.6%), benefits $11.41 (31.4%), so **1.46** [100].
- **Turnover (BLS JOLTS 2025, transportation, warehousing and utilities):** monthly average quits 2.2%, total separations 4.0%, layoffs 1.6% [101][102][103]. That is about **26% quits per year and ~48% total separations per year** (x12; derived). Warehousing alone is not broken out.
- **Shifts:** BLS: mostly full time, nights and weekends common [95]. Some machine operators work >40 h a week and overnight [97]. Default 2 x 8 h shifts, 5 days/wk is an **ESTIMATE**.

---

### 5. RaaS pricing evidence and buyer payback

| Vendor | Published / reported RaaS | Source quality |
|---|---|---|
| Brightpick | $2,190/robot/mo (US), 15-robot min, 3-yr min [27][28]; $1,900 at June 2025 launch [29] | primary (V), best public price found |
| Locus | $1,000/mo (2017) [5]; $950/mo (2019 TEI) [6]; ~$2,000/mo all-in (analyst estimate) [7] | old or secondary |
| Agility Digit | $8,500/mo + ~$25k deployment (S-4-based) [58][59] | analyst readings of the SEC filing [60] |
| Formic | customer pays $15/h for a palletizer vs $21/h labor [104] | customer anecdote |
| Vecna | annual fee [33]; "$10/robot-hour" (2nd) [34] | weak |
| inVia | monthly subscription, priced per pick [26] | old |
| Geek+ | subscription is ~6.5% of H1-2026 orders [23] | primary |
| Third Wave | fixed monthly fee, no number [41] | no number |
| 1X NEO (consumer) | $499/mo [76] | primary |

**Payback expectations:** Interact Analysis: robots typically take 2-3 years to reach ROI [105](2nd); a later Interact "Voice of Market" summary says 61% now expect a return within 12 months [106](2nd). SCMR/Peerless 2025 survey: payback 6-24 months [51c](2nd). Autonomous forklifts: 18-30 months multi-shift [48](2nd). Vendor claims: Brightpick RaaS under 6 months, CapEx 1-3 yr [27]; Agility "under 2 yr ROI vs $30/h fully loaded human" (2024) [57]. GXO: no humanoid ROI yet [62].

---

### 6. Recommended sim defaults

| Field | AMR (cart-to-person, Locus-type) | Autonomous forklift / pallet mover | Humanoid (Digit-type) | Human picker | Human forklift driver |
|---|---|---|---|---|---|
| Top speed (m/s) | 1.8. Products listed at 1.75-2.0 [3][9][12][15] | 1.5. Range 1.25-2.2 [31][35][38][46][47] | 1.2. Figure 03 official [66]; Digit ~1.5 (2nd) | 1.3 unloaded [80] | 2.2 (5 mph) indoor vendor guidance [94] |
| Operating speed in shared aisles (m/s) | 1.0. ESTIMATE: robots slow near people per ISO 3691-4 zoning [49]; ~walking speed | 1.0. ESTIMATE: EKS 215a limits load-direction travel to ~1.5 m/s [47]; slower near people | 0.8. ESTIMATE: ~2/3 of top speed | 1.0 with cart. Within 0.25-1.1 m/s cart range [79] | 1.34 (3 mph in rack aisles) [94] |
| Payload (kg) | 36 [1] | 1,500 [31][45][47] | 16 (Digit 4) [61]; 23 for Digit 5 option [63] | 23 per lift [83]; cart ~6-8 totes (ESTIMATE) | 2,268 (5,000 lb counterbalance). ESTIMATE: common class rating, not sourced |
| Runtime (h) | 10. ESTIMATE: median of 6-14 h vendor claims [1][12][15][27] | 6. ESTIMATE: Vecna 4 h [31]; Li-ion swap/opportunity charge | 2:1 run:charge, so 67% availability [57]; Digit 5 claim 10:1 [63] | 8 h shift (ESTIMATE) | 8 h shift (ESTIMATE) |
| Charge time / duty cycle | 1 h full charge; opportunity charging [1][16] | 1 h (10-90%) [38] | 1 h charge per 2 h work [57] | 2 x 15 min breaks + 30 min meal (ESTIMATE) | same (ESTIMATE) |
| Footprint (L x W m) | 0.6 x 0.6 (Origin 0.56 dia.) [1] | 1.8 x 1.0 (Vecna CPJ 1.74 x 0.93) [32] | 0.6 x 0.5 (ESTIMATE) | 0.6 x 0.6 person; cart 1.2 x 0.6 (ESTIMATE) | 2.5 x 1.2 counterbalance (ESTIMATE) |
| Buy price (USD) | $35,000. ESTIMATE: Agility buy ≈ 2 yr of RaaS [58], applied to $1,500/mo; within $15k-50k guides [53][54] | $150,000. ESTIMATE: midpoint of 2nd-hand ranges [36][48] | $200,000 + $20k deploy [58] | n/a | truck $35,000. ESTIMATE in $25k-60k range [48] |
| RaaS price | $1,500/robot/mo. ESTIMATE: Locus $1,000 in 2017 ≈ $1,330 CPI-adjusted; analyst ~$2,000 [7]; Brightpick $2,190 is a picking robot [27] | $5,000/mo. ESTIMATE: midpoint of $3k-8k [48] | $8,500/mo + $25k deploy [58][59] | n/a | n/a |
| Wage, base $/h | n/a | n/a | n/a | $17.95 (53-7065) [95] | $22.32 (53-7051) [97][98] |
| Fully loaded $/h | n/a | n/a | n/a | $26.20 = 17.95 x 1.46 [100] | $32.60 = 22.32 x 1.46 [100] |
| Productivity | 1.8x picker uplift: 75 to 135 UPH. Vendor sites 1.8-2.2x [84-88]; claims 2-3x [56] | 12 pallet moves/h. ESTIMATE: ~half of human putaway rate; FoxBot ~25/h is trailer unload only [44] | 0.5x human rate on tote moves. ESTIMATE (weakest; no public rate) | 75 UPH manual cart picking. Median of vendor "before" baselines [84-88]; WERC median 35 lines/person-h all labor [90] | 20 pallet moves/h [91][92] |
| Walking share of time | n/a | n/a | n/a | 50% (Tompkins) [78] | n/a |
| Ratio | 3 bots per picker. ESTIMATE: 3.5:1 in TEI [6]; 2:1 throughput peak in simulation [82] | 1 supervisor per 6 trucks (Fox claim) [43] | n/a | n/a | n/a |
| Fleet software | included in RaaS; if bought, $400/robot/mo. ESTIMATE: mid of $200-800 [53] | included in RaaS (ESTIMATE) | included in RaaS; $36k/yr if bought [58] | n/a | n/a |
| Deployment one-time | 30% of hardware. ESTIMATE: unit price ≈ 40-70% of deployed cost [54] | 30% of hardware (ESTIMATE) | $25k per robot [58] | training: ESTIMATE 1-2 weeks | certification: ESTIMATE |
| Maintenance %/yr | 12%. ESTIMATE: mid of 10-15% [54] | 12% (ESTIMATE) | 18% = $36k / $200k [58] | n/a | 10% of truck (ESTIMATE) |
| Shifts | 2 x 8 h, 5 days (ESTIMATE) | same | up to 20 h/day claimed for Digit 5 [63] | 2 x 8 h, 5 days (ESTIMATE) [95] | same [97] |
| Turnover / yr | n/a | n/a | n/a | 48% total separations; 26% quits [101][102] | same sector rate [101][102] |
| Payback hurdle | 24 months. Interact 2-3 yr typical [105]; 61% want <12 mo [106] | 18-30 months [48] | under 2 yr claimed [57]; GXO: not yet [62] | n/a | n/a |

---

### 7. Sources (all accessed 2026-11-08)

1. Locus Robotics, Origin product sheet (Origin 2), 2026. https://locusrobotics.com/wp-content/uploads/2026/06/Origin-Product-Sheet-2-2.pdf; specs mirrored at https://www.barcodesinc.com/solutions/locus-origin/
2. Locus Robotics, Locus Vector Datasheet 2026. https://locusrobotics.com/wp-content/uploads/2026/04/Locus-Vector-Datasheet-2026.pdf
3. Robotomated, Locus Origin listing (2nd). https://robotomated.com/explore/warehouse/locus-origin ; 6RS comparison page also gives 1.8 m/s (competitor source)
4. Globos (EU distributor), Locus Origin PDF, Dec 2023. https://globos.de/wp-content/uploads/2023/12/locus-amr-origin_en.pdf
5. Logistics Viewpoints, "A Warehouse Labor Shortage? Robots to the Rescue", 2017-11-20. https://logisticsviewpoints.com/2017/11/20/looming-warehouse-labor-shortage/
6. Forrester (commissioned by Locus), Total Economic Impact of Locus Robotics, Nov 2019. Could not open; figures from the search index. https://webcf.waybackmachine.org/web/20220915203103/https://locusrobotics.com/wp-content/uploads/Total-Economic-Impact-of-Locus-Robotics_NOV_2019F.pdf
7. Sacra, Locus Robotics profile (analyst estimate). https://sacra.com/c/locus-robotics
8. ICS / aggregator Vector listings (2nd). https://www.ics.gr/en/locus-vector-amr-autonomous-mobile-robot
9. Mobile Industrial Robots, MiR250 product page. https://www.mobile-industrial-robots.com/products/robots/mir250
10. MiR600 spec sheet via MiR and Konica Minolta AU. https://mobile-industrial-robots.com/products/robots/mir600 ; https://www.konicaminolta.com.au/products/robotics/mir600 ; https://howtorobot.com/sites/default/files/2021-08/MiR600%20%26%20MiR1350_Onepager.pdf
12. Zebra, Fetch100 Flex brochure. https://WWW.ZEBRA.COM/content/dam/zebra_dam/en/brochure/portfolio/fetch100-flex-brochure-en-us.pdf
13. CSSI, Fetch FlexShelf brochure. https://cssi.com/wp-content/uploads/cssi_fetch-flexshelf-AMR-brochure.pdf
14. The Robot Report, "Zebra Technologies winding down Fetch-based mobile robot group", 2025-12-12. https://www.therobotreport.com/zebra-technologies-winding-down-fetch-based-mobile-robot-group/ ; Supply Chain 24/7 (SEC filing Dec 9, 2025) https://www.supplychain247.com/article/zebra-plans-exit-warehouse-robotics-fetch
15. OTTO Motors, OTTO 100 data sheet. https://s3.amazonaws.com/assets.ottomotors.com/pdf/OTTO-100-Data-Sheet.pdf
16. OTTO Motors, OTTO 1500 spec. https://res.cloudinary.com/wernerelectric/image/upload/f_pdf,q_auto:good/Yaskawa/OTTO-1500-SPEC.pdf
17. OTTO 600 aggregator listing (2nd). https://theresanaiforthat.com/robot/otto-600/
18. Robotics & Automation News, 6 River Systems enhancements, 2020 (old). https://roboticsandautomationnews.com/?p=31118
19. Material Handling 247 Chuck listing; Robotomated Chuck Pallet comparison (2nd). https://www.materialhandling247.com/product/chuck_automatic_guided_vehicle ; https://robotomated.com/compare/6rs-chuck-pallet-vs-berkshire-grey-bgs-mobile
20. The Robot Report, Ocado acquiring 6 River Systems, 2023. https://www.therobotreport.com/ocado-acquiring-6-river-systems-from-shopify/
21. Geek+, P series page. https://www.geekplus.com/technology-detail-page/p-series ; [21b] RS series https://www.geekplus.com/technology-detail-page/rs-series
22. Geek+, Shelf-to-person page. https://geekplus.com/shelf-to-person-picking
23. Geek+ 2026 interim results (PR Newswire Asia). https://en.prnasia.com/releases/apac/subscription-based-services-boom-geek-reports-2026-interim-results-orders-up-35-5-breakthroughs-across-the-business-spectrum-546157.shtml
24. Robotomated P800 listing (2nd), updated 2026-09-22. https://robotomated.com/explore/warehouse/geekplus-p800 ; Nanalyze 2019 (old) https://nanalyze.com/2019/10/automated-warehouse-robots-china/
25. inVia Robotics, Picker robot page; BusinessWire 2016 (old). https://inviarobotics.com/?p=5175
26. PYMNTS, "inVia, The Monthly Robot Subscription Service" (old). https://pymnts.com/?p=300877
27. Brightpick FAQ. https://brightpick.ai/faq/
28. Brightpick pricing. https://brightpick.ai/pricing/
29. Brightpick, Autopicker 2.0 launch, 2025-06-03/24. https://brightpick.ai/brightpick-launches-autopicker-2/
31. Vecna, CPJ 2026 spec sheet. https://www.vecnarobotics.com/wp-content/uploads/2025/11/CPJ-CobotPalletJack-2026.pdf
32. Vecna, CPJ product page; Plant Automation listing. https://www.vecnarobotics.com/autonomous-vehicles/cpj ; https://www.plantautomation-technology.com/products/vecna-robotics/vecna-cpj
33. Vecna, Intro to RaaS. https://www.vecnarobotics.com/the-vecna-system/move-faster-with-raas/
34. Robotics.press Vecna profile (2nd). https://www.robotics.press/news/vecna-robotics-company-profile/
35. Seegrid, Lift CR1 brochure. https://hub.seegrid.com/seegrid-lift-cr1-amr-brochure
36. OriginOfBots CR1 page (price estimate, 2nd). https://www.originofbots.com/robot/lift-cr1-amr-by-seegrid-details-specifications-rating
37. New Equipment Digest, Palion Tow Tractor S8. https://www.newequipment.com/home/product/55121644/52861-seegrid-palion-tow-tractor-series-8
38. OTTO Lifter spec. https://res.cloudinary.com/wernerelectric/image/upload/f_pdf,q_auto:good/Yaskawa/OTTO-LIFTER-SPEC.pdf
39. BALYO FY2024 results (BusinessWire 2025-03-20); FY2025 and buy-out per search index. https://www.businesswire.com/news/home/20250320519798/en
40. MHI, BALYO MODEX 2024 preview. https://og.mhi.org/media/news/49966
41. New Equipment Digest, TWA reach trucks. https://www.newequipment.com/product-news/material-handling-packaging/product/21284149/third-wave-automation-twa-reach-trucks-offer-autonomous-and-remote-operation-capabilities
42. PR Newswire, Third Wave $27M Series C (Woven Capital), Nov 2024. https://prnewswire.com/news-releases/third-wave-automation-closes-27-million-series-c-funding-to-scale-autonomous-forklifts-302290953.html
43. BusinessWire, FoxBot Mk3, 2025-03-12. https://www.businesswire.com/news/home/20250312132945/en
44. MH&W podcast ep. 544, Fox Robotics. https://www.mhwmag.com/podcasts/episode-544-warehouse-dock-automation-with-fox-robotics/
45. VisionNav VNP15 CE spec, 2023 (old). https://howtorobot.com/sites/default/files/2023-04/VNP15%28L%29-07-CE-EN-2023V1.1.pdf
46. MH&L News, Raymond Courier automated stacker, 2024. https://www.mhlnews.com/new-products/article/55017598/automated-stacker
47. Jungheinrich EKS 215a spec sheet. https://lifttrucks.ringpower.com/uploads/eqYjjAJ9/eks_215a_spec_sheet-english.pdf
48. Robotomated autonomous forklift guide (2nd). https://robotomated.com/learn/warehouse/autonomous-forklift-guide ; [48b] Food Logistics manual vs automated. https://www.foodlogistics.com/warehousing/news/12289632/a-comparison-of-manual-forklifts-to-automated
49. Pilz, ISO 3691-4 article, 2023-09-28; Fabrico ISO 3691-4 guide. https://www.pilz.com/en-FR/company/news/articles/238928 ; https://www.fabrico.io/blog/iso-3691-4-driverless-industrial-trucks/
51c. SAPinsider (SCMR/Peerless 2025 survey; Interact via CFO Dive). https://sapinsider.org/articles/how-leaders-unlock-warehouse-automation-roi-in-the-new-age-of-supply-chains/
53. AMR cost guide (vendor-affiliated, weak). https://aicms-reeman-robotics.vercel.app/posts/amr-cost-guide-pricing-tiers-hidden-costs-and-roi-drivers
54. Industrial mobile robot prices Australia 2026 (2nd). https://img0.hospitalityhub.com.au/industrial-mobile-robot-prices-australia-2026-labour-payback-for-warehouse-and-manufacturing-automation/f/27708
55. GoBusiness Singapore, PSG AMR solution cap. https://gobusiness.gov.sg/productivity-solutions-grant/solutionrepo/eqt-Autonomous-Mobl-Robot-Eng-Srvcs
56. SAP partner listing for Locus ("2-3 times faster"); Locus CMO podcast (~80% less walking). https://www.sap.com/denmark/products/scm/partners/locus-robotics-inc-locus-autonomous-mobile-robots-for-sap-ewm.html ; https://trans.info/en/alcott-global-leaders-in-tech-ecommerce-podcast-karen-leavitt-cmo-of-locus-robotics-233869
57. The Robot Report, "Here's what it could cost to hire a Digit humanoid", 2024-07-17. https://www.therobotreport.com/heres-what-it-could-cost-to-hire-a-digit-humanoid/
58. Dynamo Ventures, "Agility Robotics: the $8,500 question", 2026-09-10 (reads the S-4). https://dynamo.vc/insights-and-news/agility-robotics-the-8500-question
59. Humanoids Daily, Agility investor day, 2026-10-06. https://www.humanoidsdaily.com/news/agility-investor-day-digit-5-launch-costs-and-a-300m-order-that-unlocks-skill-by-skill
60. SEC, Churchill Capital Corp XI Form S-4 (Agility merger), filed 2026-09-04. Too large to fetch directly. https://www.sec.gov/Archives/edgar/data/0002074973/000121390026097764/ea0297114-04.htm
61. Humanoid.guide Digit listing (2nd). https://humanoid.guide/product/digit/
62. BERI, GXO Digit expansion / CEO "no ROI yet", 2026-10-27. https://www.beri.net/article/gxo-agility-digit-humanoid-expansion-statesville-lebanon-raas-no-roi-yet-45-pilots-warehouse-automation
63. Supply Chain 24/7, "Agility Robotics Unveils Digit 5", Sep 2026; RuntimeWire. https://www.supplychain247.com/article/agility-robotics-digit-5-humanoid-warehouse-work ; https://runtimewire.com/article/agility-digit-5-humanoid-spac-safety
64. The Robot Report, "Apptronik unveils Apollo", Aug 2023 (old). https://www.therobotreport.com/apptronik-unveils-apollo-humanoid-robot/
65. Startup Fortune, Apollo status (corrected), 2026-07-15. https://startupfortune.com/apptroniks-apollo-robot-has-left-the-lab-and-is-now-working-factory-shifts-at-mercedes-benz/
66. Figure AI, Figure 03 page. https://www.figure.ai/figure
67. Not a Tesla App, Optimus $20k target. https://www.notateslaapp.com/news/3314/tesla-eyes-20k-price-target-for-optimus-extremely-fast-production-ramp
68. Unitree, G1 page (official). https://www.unitree.com/g1
69. Unitree, H1 page (official). https://www.unitree.com/h1
70. The Robot Report, "Unitree unveils G1 for $16K", 2024-05-15. https://www.therobotreport.com/unitree-robotics-unveils-g1-humanoid-for-16k/
71. Robotics 24/7, "CES 2026: Boston Dynamics unveils new Atlas", Jan 2026. https://www.robotics247.com/article/ces-2026-boston-dynamics-unveils-new-atlas-humanoid-robot
72. FOX5 Las Vegas, 2026-01-08. https://www.fox5vegas.com/2026/01/08/hyundai-unveils-humanoid-robot-ces-2026/
73. China Services Info, Walker S2 autonomous battery swap, 2025-07-29. https://www.chinaservicesinfo.com/s/202507/29/WS68887d96498edec913cdf6dd/humanoid-robot-walker-s2-launches-autonomous-battery-swapping.html
74. RobotShop Walker S2 listing (2nd). https://www.robotshop.com/products/ubtech-walker-s2-industrial-humanoid-robot
75. Robotics Tomorrow, Walker S2 mass production, Nov 2025. https://www.roboticstomorrow.com/story/2025/11/ubtech-humanoid-robot-walker-s2-begins-mass-production-and-delivery-with-orders-exceeding-800-million-yuan/25810/
76. Notebookcheck, 1X NEO preorders. https://www.notebookcheck.net/1X-opens-pre-orders-for-20-000-NEO-humanoid-home-robot.1149203.0.html
78. Georgia Tech, Order Picking Systems chapter (Tompkins breakdown). https://www2.isye.gatech.edu/~mgoetsch/cali\Logistics%20Systems%20Design\Full%20Text%20PDF\Order%20Picking%20Systems.pdf ; de Koster, Le-Duc, Roodbergen (2007) EJOR 182(2):481-501 (old)
79. Winter Simulation Conference 2017 paper (travel = 50% of picking time; Resnick & Chaffin 0.25-1.1 m/s). https://www.informs-sim.org/wsc17papers/includes/files/263.pdf
80. Shirley Ryan AbilityLab, gait speed norms (Bohannon 1997). https://www.sralab.org/rehabilitation-measures/gait-speed
81. Koreis, Loske, Klumpp, "Together, we travel", Int. J. Logistics Mgmt, 2023-11-21. https://emerald.com/insight/content/doi/10.1108/IJLM-03-2023-0127/full/html
82. DC Velocity on Khalilabadi et al., Transportation Science (Erasmus), 2026-06-15. https://www.dcvelocity.com/material-handling/order-fulfillment-packing/robotic-picking-and-loading/research-warehouse-workers-do-best-when-they-switch-between-co-bots
83. CDC/NIOSH stacks, revised lifting equation (load constant 23 kg). https://stacks.cdc.gov/view/cdc/186586/cdc_186586_DS1.pdf
84. Locus case study, MyPillow (119 to 210 UPH). https://locusrobotics.com/resources/case-study/mypillow-increases-uph-by-87-with-locusbots
85. Locus case study, Verst (71 to 155 UPH). https://locusrobotics.com/resources/case-study/verst-fulfillment-productivity-soars-more-than-100-with-locus
86. Locus case study, Kenco (30-40 to 120-150 UPH). https://locusrobotics.com/resources/case-study/locusbots-increasing-throughput-for-kenco
87. Locus video, UPS (40-45 to 80-90 LPH). https://locusrobotics.com/video/ups-exceeds-expectations-with-locus-robotics
88. Prologis Groundbreakers, DHL (78 to 150 UPH). https://dev.groundbreakersmag.prologis.com/groundbreaker/groundbreakers-14
89. Racklify, pick rate glossary (2nd). https://racklify.com/encyclopedia/what-is-pick-rate-how-warehouses-measure-productivity/
90. WERC DC Measures 2018 via Honeywell (2020); SCDigest 2008 (old). https://www.honeywell.com/us/en/news/featured-stories/2020/02/which-metrics-matter-most-to-dc-operations ; https://www.scdigest.com/assets/On_Target/08-06-03-1.php?cid=1713
91. MetricRig, pallets per hour benchmark (2nd). https://metricrig.pages.dev/answers/pallets-per-hour-warehouse-benchmark
92. Cisco-Eagle, order picking methods and productivity, 2014 (old). https://www.cisco-eagle.com/blog/2014/02/12/quick-guide-to-order-picking-methods-productivity
93. OSHA eTool, powered industrial trucks: pedestrian traffic. https://osha.gov/etools/powered-industrial-trucks/workplace/pedestrian-traffic
94. Cisco-Eagle, forklift pedestrian safety brochure (V). https://www.cisco-eagle.com/uploads/brochures/forklift-pedestrian-safety.pdf
95. BLS Occupational Outlook Handbook, Hand laborers and material movers (May 2025 wages). https://www.bls.gov/ooh/transportation-and-material-moving/hand-laborers-and-material-movers.htm
96. O*NET, national wages 53-7062. https://www.onetonline.org/link/localwages/53-7062.00
97. BLS OOH, Material moving machine operators (May 2025). https://www.bls.gov/ooh/transportation-and-material-moving/material-moving-machine-operators.htm
98. O*NET, national wages 53-7051. https://www.onetonline.org/link/localwages/53-7051.00
99. BLS ECEC news release, June 2026 data (released Sep 2026). https://www.bls.gov/news.release/ecec.nr0.htm
100. BLS ECEC Table 4, private industry by occupational group, June 2026. https://www.bls.gov/news.release/ecec.t04.htm
101. BLS JOLTS annual quits rates (Table 22), 2021-2025. https://www.bls.gov/news.release/jolts.t22.htm
102. BLS JOLTS annual total separations rates (Table 20). https://www.bls.gov/news.release/jolts.t20.htm
103. BLS JOLTS annual layoffs and discharges rates (Table 24). https://www.bls.gov/news.release/jolts.t24.htm
104. Supermarket News NZ, "Hourly Robot Rentals for Distribution" (Formic $15/h). https://supermarketnews.co.nz/news/hourly-robot-rentals-for-distribution
105. NBWA citing Interact Analysis (2-3 yr ROI). https://nbwa.org/?p=7918
106. Pulse.bot citing Interact Analysis "Voice of Market" (61% expect ROI <12 mo). https://www.pulse.bot/ecommerce/blogs/fulfillment-capital-spending-rises-as-payback-expectations-increase-84829276-48d5-4fc4-89f0-42f448cbbf7e/

---

### 8. Conflicts and caveats

- **Old wage SOC code.** 43-5081 no longer exists; it is now 53-7065. BLS pages could not be fetched directly (bot wall). Hourly figures are annual medians / 2,080 from BLS OOH, and they match O*NET where O*NET was available. May 2025 is the latest OEWS; it replaced the May 2024 data asked for.
- **Locus Origin runtime:** 14 h (Locus) vs 8 h typical (2023 EU distributor) vs 12 h (aggregators). The Locus figure is probably a best case. **Locus does not publish speed or price.**
- **Locus RaaS figures are old** ($1,000 in 2017, $950 in 2019 from a Locus-commissioned study) or analyst estimates (~$2,000).
- **Fetch/Zebra is being wound down** (Dec 2025), and 6RS Chuck is a legacy Ocado product with its team reportedly cut. Don't present either as a buyable current default.
- **Geek+ P800 payload** is 600 kg on the current spec, 1,000 kg on older P800 material.
- **Vecna CPJ runtime:** 4 h run / 2 h charge (2026 sheet) vs "swap every 2.5 h" (product page).
- **FoxBot throughput:** 60 pallets/h (2024 marketing) vs 50/25 (Mk3 spec) vs ~25 real average. The sim uses ~25.
- **Autonomous forklift prices:** no vendor publishes one. All ranges are secondary blogs, so these are the weakest numbers.
- **Agility $8,500/mo** comes from two analyst readings of the S-4. I could not open the S-4 to confirm the wording (file too large). The SPAC vote was set for 2026-11-02; whether it closed is unknown. Digit 5 specs are vendor claims for a product not shipping until H1 2027. Digit 4 speed and payload are from aggregators.
- **Humanoid prices are targets:** Optimus $20-30k, Apollo <$50k, Figure ~$20k (unconfirmed), Digit 5 BOM target $30k. Unitree's prices are real list prices, but G1 lifts only ~2 kg per arm.
- **Productivity uplift:** the 2-3x claims are vendor marketing. The "before" baselines (30-119 UPH) differ a lot by site. Independent field evidence (Koreis et al. 2023) shows a smaller, distance-dependent gain. The "33.57%" figure could not be verified. Use 1.8x with a 1.3x-3x sensitivity slider.
- **WERC current benchmarks are paywalled.** The 35 lines per person-hour median is from the 2018 report and covers all DC labor, not pickers alone.
- **Turnover** uses the combined transportation, warehousing and utilities sector. The "49% warehouse turnover" stat online is roughly the same as JOLTS total separations x12. Quits alone are ~26%.
- **Payback surveys conflict** (6 months to 5 years). Interact Analysis items are from secondary summaries.
- **Not verified / not found:** Locus Origin top speed and current price; OTTO 600 runtime; Seegrid, Vecna, Fox, Third Wave and BALYO prices; Vecna $10/robot-hour; Linde L-MATIC specs; inVia speed and price; Brightpick travel speed and footprint; Atlas price; Walker S2 price; Optimus specs; humanoid tote-handling rate (no public number).

---

# Part B: SimReady asset survey


Date: 2026-11-08. Main source: `codepawl/simready-glb` on Hugging Face (HF) at revision `3be2abd90406285b34f868907290aa4992dece7b` (last modified 2026-11-07).

> **How I measured.** I never saved a GLB to disk. I read every GLB's internals with HTTP Range requests: the 12-byte header, the JSON chunk, and the first 40 bytes of each image to get its size. A `python3 -I` stdlib script did the parsing in memory. Gzip ratios came from piping whole files through gzip in memory. One thing I could not do: look at thumbnails. The thumbnails could not be loaded during research. Visual checks are marked "VERIFY".

---

### 1. Short answers

| Question | Answer |
|---|---|
| Humanoid robot in the set? | **No.** No bipedal or humanoid robot. The closest is a UV-disinfection robot (`lamp_uvc_robot_a01`) and a floor-sweeping robot (`robotics_small_bot_a01`). |
| Human worker characters? | **No.** No people at all. Only PPE props (hard hats, gloves, earmuffs). The 67 `bodyPart_*` files are **car** body parts. |
| Any rigging or animation? | **None.** All 2,595 files have 0 `animations` and 0 `skins`. Moving parts come as joint data instead (`node.extras.joints` plus `KHR_physics_rigid_bodies`), so we animate forks, masts and wheels ourselves. |
| Forklifts | 3 generic NVIDIA designs in 5 colour variants, plus 3 manual pallet jacks. No autonomous forklift. |
| AMRs | **None.** No Nova Carter, no iw.hub, no generic AMR. There is a robot charger and some robot trolleys (kitting carts). |
| License | CC BY 4.0, checked at the source. NVIDIA's own per-asset `com.nvidia.simready.packaging.json` says `"license": "CC-BY-4.0"` for **all 38 assets on my shortlist**, and `.metadata/LICENSE.txt` is the full CC BY 4.0 legal code. Low doubt. Notes in §6. |
| First-view budget | **About 3.1 MB gzipped** for the SimReady kit, using codepawl's lod tiers as they are and served gzipped from GitHub Pages. That becomes **about 4.5 MB** with a human character and decoders, and **about 3.3 to 3.8 MB** after our own repack. |
| CORS on HF | Yes. The `resolve` 302 echoes `Access-Control-Allow-Origin: <origin>` and the CDN sends `*`. Range requests work. **HF does not gzip.** GitHub Pages **does** gzip `.glb` (`content-encoding: gzip` seen on threejs.org). |

---

### 2. Dataset overview

**Contents:** 2,595 assets, 175 categories. NVIDIA's source set (`nvidia/simready-assets`) now lists 2,677 assets. I did not check why 82 are missing; my guess is newer additions or failed conversions.

**Tiers:** one file per asset in each tier, all with the same node names, so we can swap between them.

| Tier | Path | Triangles | Textures | Geometry | Set size | Median file |
|---|---|---|---|---|---|---|
| WebP | `glb/<a>.glb` | 100% | 1024 px WebP (measured: every image was 1024x1024, one 1024x512) | `EXT_meshopt_compression` + `KHR_mesh_quantization` | 3.19 GB | 0.416 MB |
| lod0 KTX2 | `glb_ktx2/<a>.glb` | 100% | 1024 px KTX2 (`KHR_texture_basisu`; ETC1S for colour and ORM, UASTC+RDO for normals) | meshopt | 4.30 GB | 0.678 MB |
| lod1 | `lods/<a>/<a>_lod1.glb` | 50% | 512 KTX2 | meshopt | | |
| lod2 | `lods/<a>/<a>_lod2.glb` | 20% | 256 KTX2 (measured) | meshopt | 0.91 GB | |
| lod3 | `lods/<a>/<a>_lod3.glb` | 6% | 128 KTX2 | meshopt | 0.43 GB | |
| mobile | `mobile/<a>/<a>.glb` | 25% | 512 or 256 KTX2 (measured) | meshopt | 1.25 GB | 0.188 MB |
| engine | `engine/<a>/<a>.glb` | 100% | JPEG | none | 14.6 GB | |

- **Draco:** not used anywhere. Every web tier needs `MeshoptDecoder`. The KTX2 tiers also need `KTX2Loader` and the Basis transcoder.
- **Units and axes:** metres, Y-up (converted from USD Z-up). Root nodes have identity transforms. Examples: `pallet_a01` is 1.20 x 0.21 x 0.80 m, and `rack_long_empty_a01` is 4.00 x 3.01 x 1.08 m.
- **Pivots:** some assets are not floor-aligned. `conveyor_belt_a05` has min y of -0.74 and `handTruck_*` -0.44. `pallet_block_a01` stands on its edge (1.0 x 1.2 x 1.2 m, min y -0.6). Fix this with `gltf-transform center --pivot below`, or a bounding-box drop at load time.
- **Extensions:** `KHR_texture_transform` appears often. `KHR_materials_transmission` and `KHR_materials_ior` appear on glass and shrink wrap. `KHR_materials_emissive_strength` appears in a few. Physics data (`KHR_physics_rigid_bodies` and the hulls) is small: under 7 KB of JSON plus up to about 20 KB of hulls.

**Catalog files:**
- `thumbs/metadata.jsonl` (2,595 rows): category, size_mb, triangles, draw_calls, textures, rigid_bodies, joints.
- `manifest.jsonl`: before and after sizes, triangles, textures, largest texture edge, **bounds** (gives real dimensions), and physics counts.
- `metadata.jsonl` points at the `engine/` tier.
- `thumbs/*.webp` are 512 px renders, about 10 KB each. They would work for an asset-picker UI.
- `glb_ktx2/gpu_variants.jsonl`.

**Video memory (README, median of 20 models):** WebP 33.6 MiB, lod0 9.3, lod1 2.5, lod2 0.69, lod3 0.19 per model. **Don't use `glb/` WebP for many different assets**, especially on phones. A WebP texture decodes to full RGBA; one forklift at `glb/` tier has 31 textures, which is roughly 170 MB of video memory.

---

### 3. Candidates by category

Sizes are in MB. "Tri" and "DC" (draw calls, which equals primitives) are for the `glb/` tier; the lod tiers keep the stated percentage of triangles. "Tex" is the number of 1024 px textures in the `glb/` tier. Every candidate is full PBR: base colour, ORM or metal-rough, and normal maps.

#### Racks and shelving
| Asset | Size (m) | glb | mobile | lod1 / lod2 / lod3 | Tri | DC | Tex | Notes |
|---|---|---|---|---|---|---|---|---|
| **rack_long_empty_a01** | 4.0 x 3.0 x 1.08 | 0.795 | 0.413 | 0.618 / **0.241** / **0.120** | 44,080 | 3 | 9 | **Pick.** Single-deep selective pallet rack bay, 3 materials (painted uprights and beams, metal). Instance it. |
| rack_large_empty_a01 / a02 | 4.0 x 3.0 x 2.07 | 0.793 / 0.873 | 0.413 / 0.443 | 0.619 / 0.242 / 0.121 | 44,104 | 3 | 9 | Back-to-back (double-deep) version, same textures. |
| rack_h3m_s01 / s02 | 3.49 x 3.0 x 1.32 | 2.685 / 2.543 | 0.872 | 1.531 / 0.708 / 0.360 | 301,384 | 3 | 4 | Blue and orange rack, too many triangles. Gzips to 0.41 of its size. |
| rack_f04 / f10 | 2.11 x 2.69 / 1.95 | 1.147 / 2.525 | 0.403 / 0.808 | | 151k / 347k | 3 | 8 | Pivot below the floor (f04). |
| rack_bulk_storage_a03 | 2.45 x 2.43 x 1.23 | 3.471 | 0.939 | 1.749 / 0.744 / 0.347 | 324,572 | 3 | 5 | Bulk rack with wood decking. |
| rack_composition_a04/a05/a06/a08/a20 | about 2.45 x 3.6 x 1.29 | 7.1 to 9.2 | 2.5 to 3.3 | lod3 0.87 to 1.43 | 694k to 840k | 27 to 85 | 22 to 36 | Racks already **filled** with pallets and boxes. Look rich but are heavy. Better to fill racks ourselves with instances. |
| rack_composition_l03..l10 | about 3.1 x 2.9 x 1.3 | 10.9 to 27.4 | 3.9 to 4.4 | | 1.8M to 4.0M | 55 to 193 | | Too heavy. |
| storageSystem_rack_heavyDuty_f01 | 1.3 x 0.93 x 1.09 | 0.397 | 0.128 | | 37,421 | 1 | 2 | Small heavy-duty rack. |
| shelve_steel_heavyDuty_a06 | 0.92 x 2.44 x 0.61 | 1.968 | 0.641 | lod2 0.518 | 261,756 | 2 | 4 | Long-span shelving for a pick area. |
| storage_shelf_basic_b01 / c01 | 0.51 x 2.03 x 1.51 | 1.894 / 2.976 | 0.650 / 1.033 | | 231k / 458k | 3 / 6 | | Small-parts shelving. |

**Gap:** the racks are only **3 m tall** and have no separate upright or beam parts. Real warehouses use 6 to 12 m racks. **Recommendation:** build the main rack field procedurally from instanced uprights, beams and wire decks, reusing the SimReady rack textures (CC BY allows changes). Use `rack_long_empty_a01` for close-up hero bays.

#### Pallets and loaded pallets
| Asset | Size (m) | glb | mobile | lod2 / lod3 | Tri | DC | Notes |
|---|---|---|---|---|---|---|---|
| **pallet_a01** | 1.2 x 0.21 x 0.8 | 0.249 | 0.129 | **0.062** / 0.024 | 2,052 | 1 | **Pick.** EUR-size wooden pallet; textures are 90% of the bytes. |
| pallet_b01 / b03 | 1.21 x 0.21 x 1.0 | 0.226 / 0.205 | 0.128 | | 2,160 / 2,916 | 1 | US-style 1.2 x 1.0 m. |
| pallet_block_a01..a09, b02, b03, c01 | | 0.15 to 0.26 | | | 2k to 18k | 1 to 2 | Some are rotated on edge. |
| pallet_rackable_solid_top_blue_a02 | 1.01 x 0.15 x 1.21 | 0.216 | 0.109 | | 24,078 | 1 | Plastic pallet. |
| pallet_steel_galvanized_a01 | 1.22 x 0.12 x 1.22 | 1.627 | 0.542 | | 229,539 | 1 | |
| **pallet_assembly_a05** | 0.92 x 1.04 x 0.93 | 1.284 | 0.529 | **0.323 / 0.130** | 89,382 | 6 | **Pick.** Stacked cartons, strapped. |
| pallet_assembly_b01 | 1.33 x 0.56 x 1.11 | 1.119 | 0.497 | 0.288 / 0.111 | 53,034 | 5 | Low load under a green tarp. |
| pallet_assembly_c01/c02, d01/d02 | | 2.4 to 3.4 | | | 249k to 389k | 4 to 6 | Tarp-covered (yellow, blue). |
| pallet_assembly_brown_e04/e05/f05/f06 | | 1.5 to 2.3 | | | 73k to 203k | 7 | Strapped cartons. |
| **pallet_assembly_yellow_a01..a06 / red_a01..a06 / transparent_a01..a06** | about 0.67 x 0.5 x 0.66 (a01) | 1.76 to 2.79 | 0.685 (a01) | 0.452 / **0.174** | 212k to 292k | 7 | **Shrink-wrapped** (covering mesh uses `KHR_materials_transmission`). Swap that for a cheap transparent standard material. |
| pallet_assembly_white_e02, mixed_e05 | | 2.45 / 2.77 | 1.007 | | 282k / 336k | 9 | Stretch film (transmission). |
| pallet_composition_a13 / a59 | 1.0 x 1.04 x 1.22 | 1.055 / 1.827 | 0.476 / 0.423 | | 68k / 40k | 5 / 12 | Pallet of mixed box types. |

#### Cartons, totes and crates
| Asset | Size (m) | glb | lod2 | Tri | DC | Notes |
|---|---|---|---|---|---|---|
| **box_cardboard_a01..a03** | 0.70 x 0.51 x 0.52 | **0.056 to 0.07** | 0.047 | **554** | 1 | **Pick.** Very light. Instance by the thousand. |
| **box_cardboard_b01..b03** | 0.51 x 0.52 x 0.51 | 0.07 to 0.08 | | 560 | 1 | Cube carton. |
| **box_cardboard_c01..c03** | 0.51 x 0.26 x 0.51 | 0.077 to 0.09 | | **300** | 1 | Flat carton. |
| box_cardboard_d01..d03 | 0.34 x 0.17 x 0.26 | 0.09 to 0.11 | | 354 | 1 | Small parcel. |
| box_cardboard_large_a02/a03/b01/b02 | 1.0 x 0.54 x 1.09 (b01) | 0.68 to 0.99 | 0.178 | 3.7k to 18.6k | 4 to 6 | Large carton. |
| box_cardboard_open_a01..a06, folded_* | | 0.27 to 1.31 | | 1.2k to 74k | 2 to 5 | Open or flat-folded boxes for pack stations. |
| box_corrugated_brown/white_* (40 kinds), box_cube_*, box_flat_*, box_long_*, box_multiDepth_*, box_printer_* (about 100) | 0.15 to 0.5 m | 0.28 to 0.60 | about 0.09 | 1.9k to 16k | 3 to 7 | Printed shipping boxes, 6 to 7 textures each. Fine as variety, but the textures make each one 5 to 8 times the size of box_cardboard. |
| crate_black/blue/gray/green/orange/red/violet/white/yellow_a01..a20 | 0.61 x 0.09 to 0.25 x 0.41 | 0.32 to 0.82 | 0.124 (blue_a08) | **38k to 108k** | 1 | Plastic **totes**. Far too many triangles to instance in bulk. Use lod3 (0.055 to 0.074) or a procedural tote. |
| crate_plywood_a04 / b01..b06 | 1.22 x 0.47 x 1.22 | 0.376 / 1.05 to 1.42 | | 3.5k to 46k | 3 to 6 | Wooden pallet crates. |
| storage_box_a01..c01 | | 1.9 to 2.5 | | 199k to 275k | 10 to 29 | Lidded storage boxes. Heavy. |

#### Conveyors
| Asset | Size (m) | glb | mobile | lod2 | Tri | DC | Notes |
|---|---|---|---|---|---|---|---|
| **conveyor_belt_a05** | 1.53 x 1.91 x 2.07 | 2.140 | 0.947 | **0.631** | 228,964 | 37 | **Pick.** Belt section with each roller a separate part (29 joints). Merge the rollers and animate a UV scroll. Pivot is below the floor. |
| conveyor_belt_a02 | 3.15 x 1.75 x 3.11 | 2.640 | 1.110 | 0.781 | 289,480 | 35 | Larger roller section. |
| conveyor_belt_a35 | 2.0 x 2.56 x 1.26 | 3.450 | 1.323 | 0.895 | 398,664 | 9 | One merged mesh, no joints. Simplest. |
| conveyor_belt_a08 | 1.53 x 1.2 x 2.75 | 5.096 | 2.093 | 1.474 | 626,564 | 61 | Has buttons. |
| conveyor_belt_a47 | 3.4 x 1.2 x 4.45 | 7.859 | 2.989 | 2.212 | 950,458 | 96 | |
| conveyor_belt_a61 | 1.54 x 2.59 x 4.65 | 9.341 | 3.573 | 2.686 | 1,143,281 | 62 | Scanner tunnel with LEDs and screen. A nice hero piece, lazy-load it. |

#### Pick, pack and work stations
| Asset | Size (m) | glb | mobile | lod2 | Tri | Notes |
|---|---|---|---|---|---|---|
| **table_packing_heavyduty_c01** | 1.87 x 0.99 x 1.22 | 2.284 | 0.498 | **0.356** | 98,594 | **Pick** for the pack station. |
| table_packing_heavyduty_c02 | 2.47 x 0.99 x 0.76 | 2.906 | 0.704 | 0.527 | 177,119 | |
| table_deluxe_packing_a01 | 2.44 x 2.26 x 0.97 | 3.281 | 1.316 | 0.957 | 362,208 | Has bubble-wrap and paper rolls (transmission). Hero piece. |
| table_metal_stainless_a03 | 1.8 x 1.64 x 0.7 | 0.177 | 0.130 | | 13,912 | Pivot offset. |
| workstation_factory_a01 | 2.17 x 5.82 x 3.1 | 22.07 | 7.49 | 6.04 | 2.84M | Too heavy. |
| desk_a01, warehouse_computer_keyboard_a01, monitor_* | | 0.2 to 1.7 | | | | Props for a pick station. |
| equipment_liftTable_scissorMobile_a01 | 1.31 x 1.26 x 0.74 | 3.767 | 1.560 | 1.146 | 443k | Lift table. |

#### Docks, building shell and structure
| Asset | Size (m) | glb | mobile | lod2 | Tri | Notes |
|---|---|---|---|---|---|---|
| **barrier_gate_safetyDock_a02** | 3.16 x 1.19 x 0.15 | 0.501 | 0.237 | **0.168** | 74,600 | Yellow swing safety gate for a loading dock. The **only** dock item. |
| structure_wall_entrance_a01 | 4.77 x 11.1 x 12.0 | 6.220 | 2.363 | 1.496 | 451,752 | Entrance wall section (concrete, steel, barriers). Heavy. |
| structure_wall_straight_a01 | 0.74 x 11.1 x 6.0 | 2.353 | 0.819 | 0.492 | 103,006 | Wall module. Its concrete textures are worth reusing. |
| **structure_wall_column_a01** | 0.74 x 8.5 x 0.74 | 0.647 | 0.198 | **0.124** | 9,614 | Building column. Instance it. |
| modular_warehouse_h10m_center / straight / corner_in / corner_out | 10 to 20 m, 12.3 m tall | 3.9 to 9.6 | 1.7 to 2.5 | 1.2 to 2.0 | 158k to 926k | 10 m warehouse shell modules. Too heavy to tile a whole building, but a reference for look and materials. |
| warehouse_h10m_* | 11 x 12.5 x 10 | 11.7 to 12.8 | 5.46 | 4.57 | 1.4M to 1.6M | Shell with fan, lamps and glass. Too heavy. |
| environment_floor_a01 | 6 x 0.1 x 6 | 0.307 | 0.199 | 0.088 | 8,738 | Concrete floor tile with a yellow strip and a steel plate. Source of concrete textures. |
| structure_beam_*, structure_ceiling_a01, grid_ceiling_a01 | | 0.04 to 0.93 | | | 1.6k to 30k | Steel beams and ceiling grid. |
| ramp_long_a01 | 2.24 x 0.5 x 0.35 | 0.117 | | | 1,348 | Small ramp. |

**Not in the set:** dock levellers, overhead or sectional dock doors, dock bumpers, dock lights, trucks and trailers. These must be built procedurally.

#### Charging
| Asset | Size (m) | glb | mobile | lod3 | Tri | DC | Notes |
|---|---|---|---|---|---|---|---|
| equipment_robot_charger_a01 | 1.97 x 1.62 x 5.9 | 6.966 | 3.155 | **1.073** | 1,186,691 | 120 | 4-bay robot charger with a transformer cabinet (copper contacts, emissive). Usable at lod3, lazy-loaded. For AMR docking pads, build them procedurally. |

#### Robots (none is a warehouse AMR or a humanoid)
| Asset | Size (m) | glb | mobile | lod3 | Tri | What it is |
|---|---|---|---|---|---|---|
| robotics_small_bot_a01 | 0.75 x 0.19 x 0.69 | 4.617 | 1.620 | 0.487 | 559,808 | Floor-cleaning robot (left and right sweeper brushes, wheels, sensor, LEDs). Its low shape could pass for a small AMR from a distance, but the sweepers give it away. |
| equipment_robot_trolley_a01/b01/c01 | 1.5 x 2.1 to 2.6 x 1.5 | 19.4 to 19.9 | 6.8 to 7.3 | 2.1 to 2.2 | 3.4M to 3.7M | Automotive kitting trolleys (texture names say "dt_automotive_factory_robot_trolley"). These are carts that an AMR carries or tows, not the robot. Very heavy. |
| lamp_uvc_robot_a01 | 0.58 x 1.86 x 0.63 | 1.682 | 0.735 | 0.242 | 272,095 | Hospital UV-disinfection robot. |
| robotic_system_*, robot_surgical_c01 | | 3.6 to 9.0 | | | 0.6M to 1.3M | Surgical robots. Not useful. |

#### Forklifts and pallet jacks
| Asset | Size (m) | glb | mobile | lod1 / lod2 / lod3 | Tri | DC | Moving parts (joint extras) |
|---|---|---|---|---|---|---|---|
| **vehicle_forklift_blue_c01** / red_c01 | 1.36 x 2.17 x 3.73 | 7.779 / 7.591 | 3.166 | 4.807 / 2.386 / **1.158** | 997,893 | 206 to 208 | **Sit-down counterbalance forklift.** 4-stage mast (about 1.7 m each), 2 forks with 1.5 m slides, seat, pedals, steering. Merge parts to cut draw calls. |
| vehicle_forklift_red_b01 | 1.13 x 2.93 x 3.03 | 6.278 | 2.560 | 4.003 / 1.978 / 0.951 | 872,884 | 158 | **Order picker** ("man-up"): the cabin rises 1.96 m and the lift rises 2 m. |
| **vehicle_forklift_blue_a01** / orange_a01 | 0.82 x 1.96 x 1.89 | 2.551 | 1.082 | 1.676 / **0.803** / 0.377 | 329,976 | 56 | **Walk-behind pallet stacker** with tiller ("rudder") and forks rising 1.51 m. Best base for an **autonomous stacker** look (add a lidar mast and remove the tiller). |
| palletJack_lowProfile_a01 | 0.65 x 1.37 x 1.63 | 1.381 | 0.557 | 0.850 / 0.414 / 0.187 | 180,737 | 16 | Manual pallet jack. |
| palletJack_heavyDuty_a01 / scale_a01 | | 2.396 / 1.368 | | | 380k / 193k | 20 | |
| handTruck_convertible_* (4), tiltTruck_* (3) | | 0.96 to 1.72 | | | 109k to 198k | 17 to 23 | |

**Trademarks:** names and textures are generic NVIDIA work (`T_Forklift_A1_*`, `unique_forklift_c_*`). Forklifts a01 and b01 have **decal textures** (`T_ForkliftDecal_A1_Albedo`, `decal_black/white`) that I could not look at. **VERIFY there are no real-brand logos** before shipping.

#### Safety, signs and floor marking
| Asset | glb | lod2 | Tri | Notes |
|---|---|---|---|---|
| **rail_guard_a09** (2.79 x 1.01 x 0.25) | 0.852 | **0.244** | 122,752 | Steel guard rail. Instance it. |
| rail_corner_a01 | 0.192 | | 1,098 | Corner protector. |
| **barrier_fence_metal_a02 / a03** (1.23 x 1.07) | 0.204 / 0.214 | 0.069 | 3.4k / 4.9k | Mobile fence panel. Instance it. |
| barrier_gate_safety_a02 (6.1 m) | 1.928 | 0.749 | 207,938 | Long sliding safety gate. |
| barrier_wall_plastic_orange_a03 / environment_barricade_a01 | 2.285 / 1.152 | 0.613 / 0.290 | 287k / 111k | Orange plastic barrier. |
| sign_floor_movable_a01, sign_warning_a04, sign_wetFloor_a01/a02/b02, safetyBoard_hseInformation_a01 | 0.20 to 1.47 | 0.08 to 0.49 | 5k to 174k | The other 20 signs are hospital signs. |
| **tape_safety_yellow / white / yellow_black_*** (16 kinds, 2 to 12 m x 5 to 15 cm) | 0.05 to 0.09 | | **10 to 144** | Floor tape: plain textured quads. Lift their textures for procedural lane lines. |
| fireExtinguisher_stand_a01, fireProtection_*, safety_eyewashStation_*, safety_firstAid*, equipment_alarm_siren_a01 | 0.25 to 4.9 | | | Wall and floor safety props. |

**Missing:** traffic cones, bollards, aisle and location signs, pedestrian walkway markings.

#### Lights and ceiling
| Asset | glb | lod2 | Tri | Notes |
|---|---|---|---|---|
| **lighting_overheadLed_lightPanel_a01** (6.0 x 1.46 x 3.6, hanging) | 0.840 | **0.197** | 29,464 | High-bay LED panel with emissive. Instance it. |
| lighting_overheadLed_rectangularFrame_a01 / hexGrid_a01..a04 | 1.0 to 1.4 | 0.34 to 0.67 | 189k to 213k | Decorative LED frames. |
| lamp_ceiling_1m_rectangle_a01 / 50cm_square_* | 0.22 to 0.33 | 0.097 | 24k to 43k | Small ceiling lamps. |
| ventilation_ceilingFan_hvls_a01 (5.6 m) | 3.820 | 0.984 | 381,600 | Large warehouse ceiling fan. Nice detail; can spin (1 joint). Lazy-load it. |

#### Other props
| Asset | glb | lod2 | Tri | Notes |
|---|---|---|---|---|
| ladder_rolling_yellow_a02 / ladder_step_rolling_a01 | 2.13 / 2.73 | 0.598 / 0.679 | 269k / 338k | Rolling warehouse ladders. |
| trashCan_wheeled_black_a01, wasteManagement_trashBin_wheeled_a01, bin_waste_a01..b01, container_recycle_* | 0.2 to 2.1 | 0.13 to 0.52 | 14k to 306k | Bins. |
| drum_steel_a01, drum_plastic_*, ibcTank_a02, pail_* | 0.06 to 1.1 | 0.07 to 0.31 | 7k to 135k | Drums, IBC tank, pails. |
| cart_mobile_a01..f01, equipment_utility_cart_e01, trolley_*, construction_wheelbarrow_metal_a01 | 0.8 to 2.8 | 0.40 to 0.71 | 68k to 350k | Carts. |
| storage_locker_*, facilityFurniture_lockerUnit_*, machine_vending_*, facilitySystem_beverageStation_* | | | | Break-room props. |

---

### 4. Humanoid robot and human worker

**SimReady has neither.** Fallbacks below. I checked licenses on the source pages and pulled numbers from the Sketchfab API. **The look of each one still needs a visual check.** Downloading from Sketchfab needs a free **Sketchfab account**, which is an account task for Spiro under CLAUDE.md.

#### Human worker (we want a walk cycle; a hi-vis vest is ideal)
| Option | License | Author | Size | Triangles | Animation | Realism | Verdict |
|---|---|---|---|---|---|---|---|
| **Nathan Animated 003 - Walking 3D Man** ([sketchfab](https://sketchfab.com/3d-models/nathan-animated-003-walking-3d-man-143a2b1ea5eb4385ae90a73657aca3bc)) | **CC BY 4.0**, posted by the official Renderpeople account | Renderpeople | Download size unknown (8K textures). About 1 to 1.4 MB after resizing to 1024 and meshopt (estimate). | 21.5k | 1 mocap walk loop, baked at 30 fps | **Photoreal scan**, casual clothes | **Chosen for realism.** Paint a hi-vis vest into its colour texture (CC BY allows changes; credit must say it was modified). The page carries a NoAI notice, which doesn't affect our use. |
| Renderpeople Eric / Claudia / Carla Rigged, Sophia Animated | CC BY 4.0 (same account) | Renderpeople | | 16k to 21k | Rigged, no clips (Sophia has 1) | Photoreal | Variety. Retarget the walk or the CC0 UAL clips onto them. |
| Quaternius **Universal Base Characters** + **Universal Animation Library** ([UBC](https://quaternius.com/packs/universalbasecharacters.html), [UAL](https://quaternius.com/packs/universalanimationlibrary.html)) | **CC0** on both pack pages | Quaternius | UBC Standard zip is 122 MB (whole pack). One character is about 13k triangles. | about 13k | UAL: 120+ clips (8-way locomotion, jog, sprint, push), humanoid rig | Semi-stylized base bodies, no clothes | **Cleanest license, most clips.** Needs a vest and clothing texture. A guide notes Quaternius moved *new* packs to its own "QAL v1.0" license, so check the LICENSE inside each zip. |
| Microsoft Rocketbox ([github](https://github.com/microsoft/Microsoft-Rocketbox)) | **MIT** | Microsoft | FBX, several detail levels | low to mid poly | 417 clips (MoveBox) | Realistic | Good library, but needs FBX to GLB conversion in Blender, and the repo is archived. I didn't confirm whether it has worker outfits. |
| Sketchfab "Construction Worker" by katelaruine | CC BY 4.0 | katelaruine | | 26.8k | 5 clips | ? | Possible vest and walk. VERIFY the look. |
| three.js `Soldier.glb` / `Xbot.glb` / `Michelle.glb` | Mixamo-derived; no license stated in the three.js repo | Adobe Mixamo | 2.2 to 3.3 MB | | yes | | **Avoid.** Mixamo terms don't clearly allow redistributing the raw files from a public repo (Adobe FAQ returned 403). |
| Ready Player Me | | | | | | | **Gone.** Netflix bought it in Dec 2025 and the service shut down on 31 Jan 2026. |

Other worker scans with hi-vis on Sketchfab (restore50, mr.sinankaba, asdasdasdsda) are CC BY but **static, unrigged, 225k to 516k triangles**. They don't fit.

#### Humanoid robot (generic, no brand)
| Option | License | Triangles | Animation | Notes |
|---|---|---|---|---|
| **Ralph 1.0** / **NORA** by newyearstudios ([Ralph](https://sketchfab.com/3d-models/none-074d4925ebf9428c8ac251808cc138c8), [NORA](https://sketchfab.com/3d-models/none-333f5adb95b340b19fc5a6113b247993)) | CC BY 4.0 | 34k / 47k | 9 / 10 clips | "Game-ready" rigged mid-poly robots. **Chosen if the visual check passes.** Estimate about 0.8 to 1.5 MB after repack. |
| Astra Lumen II by pinckneyb (2026) | CC BY 4.0 | 36.5k | 1 | Friendly companion android (white armour, rose metal, digital face). Less industrial. |
| Animated humanoid robot by pinguinoconpulgares | CC BY 4.0 | 10.8k | 4 (walk, run, idle) | 2016, Blender. Light. |
| Postapo Humanoid Robot by Marcin.Kwiatkowski | CC BY 4.0 | 75k | 8 | Post-apocalyptic look; wrong mood. |
| **RobotExpressive** (three.js examples) | **CC0** (repo README: Tomás Laulhé / Quaternius, modified by Don McCurdy) | small | about 14 clips (walk, run, idle, wave, and more) | 464 KB raw, **134 KB gzipped** on threejs.org. Cartoon style. **Safe placeholder for development.** |
| NVIDIA Isaac Sim humanoids, people and robots | **NVIDIA Isaac Sim Additional Software and Materials License**: no redistribution or derivatives outside the permitted terms | | | **Don't use** in a public web app. |

---

### 5. Forklifts, AMRs and trademarks

- **Forklifts:** listed in §3. They are generic NVIDIA designs (counterbalance c01, order picker b01, walk-behind stacker a01). Low trademark risk, apart from the decal check.
- **AMRs:** none. **Recommendation: build a generic AMR in code.** For a lift-under AMR it is a rounded deck about 1.0 x 0.7 x 0.3 m with a lidar puck, LED strip and casters; for a tugger it gets a hitch; for a tote AMR it gets a shelf tower. Use SimReady PBR textures (glossy white plastic, rubber, emissive). It costs about 0 KB of assets, can be instanced, and has no brand.
  - Sketchfab "Basic Mobile Robot for Sim" by bulentbaslar (CC BY, 19.8k triangles, made for Isaac Sim and ROS) is a generic alternative. VERIFY its look.
- **Avoid these branded models:** "UR_ Cobot & Mir_AMR" (Universal Robots, MiR), "Industrial 3D AGV & Trolley - Omron", "keenon X101/S300", "AGV - MaxMover", "United AMR".
- **iw.hub** (idealworks / BMW Group) and **Nova Carter** (NVIDIA / Segway) only exist as Isaac Sim assets under NVIDIA's restricted license, and both names are trademarks. Don't use them. Make generic look-alikes with no names or logos.
- **Autonomous forklift:** reuse `vehicle_forklift_blue_a01` (stacker) or `c01`, add a lidar mast and a blue safety spot light, and remove the operator controls.

---

### 6. License and attribution

**Checks done:**
1. `nvidia/simready-assets` card says `license: cc-by-4.0`.
2. `vehicle_forklift_blue_a01/.metadata/LICENSE.txt` is the full CC BY 4.0 legal code. It has no NVIDIA copyright line.
3. `com.nvidia.simready.packaging.json` says `"license": "CC-BY-4.0"` for **all 38 assets on my shortlist** (§7).
4. codepawl states it checked each `LICENSE.txt` is CC BY 4.0, and every row of `manifest.jsonl` says `CC-BY-4.0`.
5. codepawl's conversion is itself an adaptation under CC BY 4.0. Credit both.

**Remaining doubts (low):**
- The license file has no copyright holder line. Credit "NVIDIA Corporation" as creator, as both the codepawl card and NVIDIA's card do.
- CC BY **does not license trademarks** (§2(b)(2)) and **forbids implying endorsement** (§2(a)(6)). Credit "NVIDIA SimReady" as a fact only. Don't brand the app "SimReady", don't use NVIDIA logos, and don't claim NVIDIA is involved.
- NVIDIA says licensing is set **per asset**. Re-run the packaging-json check for every asset we ship (a 10-line script).
- The forklift decals are unverified.

**What CC BY 4.0 §3(a) requires:**
- Keep the creator's name, any copyright notice, a notice pointing to the license, a notice pointing to the disclaimer of warranties, and a link to the material where practicable.
- Say if we changed the material, and keep earlier change notes.
- Say it is under CC BY 4.0 and give a link to the license.
- All of this can be done "in any reasonable manner based on the medium". A Credits page linked from the app footer works.

**Suggested attribution text (Credits page, plus a short line in the footer or About):**
> 3D models from **NVIDIA SimReady Assets** by NVIDIA Corporation (https://huggingface.co/datasets/nvidia/simready-assets), licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Web conversions from **SimReady GLB** by codepawl (https://huggingface.co/datasets/codepawl/simready-glb), CC BY 4.0. **Modified** for Fleet Planner: re-compressed, simplified, textures resized and re-encoded, pivots and materials adjusted. Provided "as is" without warranties, see the license. NVIDIA and SimReady are trademarks of NVIDIA Corporation; Fleet Planner is not affiliated with or endorsed by NVIDIA.
>
> Models used: rack_long_empty_a01, pallet_a01, pallet_assembly_a05, ... (one line per asset, each linking to `.../nvidia/simready-assets/tree/main/<asset>`).
>
> "Nathan Animated 003 - Walking 3D Man" by Renderpeople (https://sketchfab.com/3d-models/nathan-animated-003-walking-3d-man-143a2b1ea5eb4385ae90a73657aca3bc), CC BY 4.0. Modified: hi-vis vest painted, textures resized, converted to GLB.
>
> (Same form for any other CC BY model. CC0 items such as Quaternius and RobotExpressive need no credit, but crediting them is courteous.)

Also ship a `CREDITS.md` or `LICENSES/` folder next to the self-hosted GLBs in the repo.

---

### 7. Recommended asset list and download budget

#### A. First useful view
Codepawl tiers as they are, self-hosted on GitHub Pages. Sizes **measured**; gzip at level 6, which is about what Pages sends.

| Role | Asset (tier) | Raw MB | Gzip MB | Triangles | Instanced? |
|---|---|---|---|---|---|
| Rack bay, near | rack_long_empty_a01 (lod2) | 0.241 | 0.180 | about 8.8k | yes (3 meshes) |
| Rack bay, far | rack_long_empty_a01 (lod3) | 0.120 | 0.075 | 5,258 (measured) | yes |
| Empty pallet | pallet_a01 (lod2) | 0.062 | 0.058 | about 410 | yes |
| Loaded pallet, near | pallet_assembly_a05 (lod2) | 0.323 | 0.279 | about 17.9k | yes |
| Loaded pallet, in racks | pallet_assembly_a05 (lod3) | 0.130 | 0.103 | about 5.4k | yes |
| Shrink-wrapped pallet | pallet_assembly_yellow_a01 (lod3) | 0.174 | 0.139 | about 12.7k | yes |
| Carton A | box_cardboard_a01 (glb) | 0.056 | 0.053 | 554 | yes, by the thousand |
| Carton B (flat) | box_cardboard_c01 (glb) | 0.077 | 0.075 | 300 | yes |
| Tote | crate_blue_a08 (lod2) | 0.124 | 0.097 | about 9.6k | yes (use lod3 in bulk) |
| Conveyor segment | conveyor_belt_a05 (lod2) | 0.631 | 0.465 | about 45.8k | yes (after merging rollers) |
| Pack station | table_packing_heavyduty_c01 (lod2) | 0.356 | 0.304 | about 19.7k | yes if more than 3 |
| Counterbalance forklift | vehicle_forklift_blue_c01 (lod3) | 1.158 | 0.663 | 61.7k | unique (animated parts) |
| Dock safety gate | barrier_gate_safetyDock_a02 (lod2) | 0.168 | 0.125 | about 14.9k | yes |
| Guard rail | rail_guard_a09 (lod2) | 0.244 | 0.199 | about 24.5k | yes |
| High-bay light | lighting_overheadLed_lightPanel_a01 (lod2) | 0.197 | 0.164 | about 5.9k | yes |
| Building column | structure_wall_column_a01 (lod2) | 0.124 | 0.115 | about 1.9k | yes |
| **SimReady subtotal** | | **4.19** | **3.09** | | |
| Optional: stacker / autonomous stacker | vehicle_forklift_blue_a01 (lod2) | 0.803 | 0.539 | about 66k | unique |
| Optional: fence panel | barrier_fence_metal_a02 (glb) | 0.204 | 0.189 | 3.4k | yes |
| Human worker (Renderpeople, repacked) | estimate | | about 1.0 to 1.4 | 21.5k | unique (SkinnedMesh clones) |
| Humanoid robot | estimate (Ralph about 1.0, or RobotExpressive 0.13) | | 0.13 to 1.0 | | unique, or lazy-load |
| AMRs, walls, floor, dock doors, bollards, lane lines | procedural | | about 0 | | yes |
| Decoders | meshopt decoder plus Basis transcoder, estimate | | about 0.2 to 0.3 | | |
| Lighting environment | RoomEnvironment (free), or a 512 px CC0 warehouse HDRI from Poly Haven (estimate) | | 0 to 0.4 | | |

**First-view total, as is:** about **3.1 MB** (SimReady) + about 1.2 (worker) + about 0.25 (decoders) = **about 4.5 MB gzipped**. Load the humanoid robot lazily (only when selected). With our repack (§8): **about 3.3 to 3.8 MB**.

- Measured raw total for all 18 items above: 5.19 MB raw / **3.82 MB gzipped**.
- At about 25 Mbps this is 1.5 s to transfer, plus 0.5 to 1 s to decode, which fits the 5 s goal.
- Stream it in stages: shell, floor and instanced boxes first (under 0.5 MB), then the props.

#### B. Lazy-loaded (on zoom, on select, or after first view)
Measured total for 26 files: **23.96 MB raw / 18.27 MB gzipped**.

- **lod1 swaps for close-ups:** rack 0.62, pallet_assembly_a05 0.84, yellow_a01 1.12, b01 0.84, forklift c01 4.81, forklift a01 1.68, conveyor a05 1.40, packing table 1.04.
- **Hero and extra props:** forklift_red_b01 (lod2) 1.98, palletJack_lowProfile (lod1) 0.85, conveyor_a35 (lod2) 0.90, table_deluxe_packing (lod2) 0.96, robot charger (lod3) 1.07, rolling ladder (lod2) 0.60, wheeled trash can 0.27, fire extinguisher stand 0.28, floor sign 0.49, HVLS fan 0.98, steel drum 0.27, IBC tank 0.31, hand truck 0.32, utility cart 0.71, heavy-duty shelf 0.52, large carton 0.18, orange barrier 0.61, eyewash station 0.33.
- **Full `glb/` tier:** only for a single object in "inspect" mode.

**Grand total,** everything including characters: about **22 to 25 MB gzipped** as is, about **12 to 15 MB** after our repack. That is well inside GitHub Pages limits.

#### C. Phones
- Use **lod3** for every prop, plus box_cardboard (glb) and procedural racks.
- First view about **1.5 to 2 MB**.
- Cap the scene at about 0.5 to 1M triangles and under 150 draw calls.
- Codepawl did **not** test phones or Safari with KTX2, so test on a real iPhone early.

#### Instanced or unique
- **Instance** (`InstancedMesh` per primitive, or `BatchedMesh` per material): rack bays (or procedural uprights and beams), pallets, loaded pallets (2 to 4 kinds), cartons (2 to 4 kinds), totes, guard rails, fences, columns, light panels, bollards, floor tape, conveyor segments, AMRs (rigid: update instance matrices each frame), pack stations.
- **Unique:** forklifts (node animation of fork, mast and wheels from the joint data), humans (SkinnedMesh via `SkeletonUtils.clone`, 5 to 20 of them), the humanoid robot, the charger, hero conveyor a61.
- **Budgets:** laptop about 2 to 4M visible triangles and under 300 draw calls. A rack field of 100 bays is 0.5 to 0.9M triangles. 2,000 cartons is 0.6 to 1.1M triangles. Swap LODs by distance.

---

### 8. Re-compression plan (gltf-transform v4, run at build time in Node)

The pipeline below runs per asset, or on a merged "kit". The `glTF-Transform v4.5.1` generator string means codepawl's files reopen cleanly.

```bash
## 1. merge first-view assets into one kit so shared textures dedup (wood, glossy metal, cardboard repeat across pallets and assemblies)
gltf-transform merge pallet_a01.glb pallet_assembly_a05.glb ... kit.glb
gltf-transform dedup kit.glb kit.glb && gltf-transform prune kit.glb kit.glb
## 2. set each asset's origin to bottom-centre
gltf-transform center in.glb out.glb --pivot below
## 3. cut draw calls: merge primitives that share a material (keep moving parts separate with flatten/join options)
gltf-transform join in.glb out.glb   # forklift c01: about 208 draw calls -> about 30
## 4. simplify props (weld first)
gltf-transform weld in.glb out.glb && gltf-transform simplify in.glb out.glb --ratio 0.1 --error 0.001
## 5. textures: 512 hero / 256 props, KTX2 (ETC1S for colour and ORM, UASTC for normals); needs KTX-Software `toktx`
gltf-transform resize in.glb out.glb --width 512 --height 512
gltf-transform etc1s in.glb out.glb --slots "{baseColorTexture,metallicRoughnessTexture,occlusionTexture,emissiveTexture}"
gltf-transform uastc in.glb out.glb --slots "{normalTexture}" --level 2 --rdo
## 6. geometry
gltf-transform meshopt in.glb out.glb --level high
```

**Estimated savings**

| Step | Saving |
|---|---|
| Simplify heavy props to 5 to 10% of triangles (forklifts, conveyors, charger, assemblies) | -75 to 90% of geometry bytes. Example: forklift c01 at lod3 is already 0.71 MB of geometry for 62k triangles; at 25k it would be about 0.3 MB. |
| Drop normal maps on small props (cartons, pallets) | -1/3 of their textures |
| Merge plus dedup shared textures across the kit | about -10 to 30% of texture bytes (estimate) |
| KTX2 at 512 / 256 instead of WebP 1024 | Video memory -75 to 98% (33.6 to 9.3 / 0.69 / 0.19 MiB median); download about the same or smaller |
| Physics extension and hulls | Small (under 30 KB a file). gltf-transform drops the unregistered `KHR_physics_rigid_bodies` on read. Keep the node `extras.joints` because they drive our animations. |
| **GitHub Pages gzip** (measured) | rack_h3m 0.41x, forklift c01 0.54x, conveyor a05 0.57x, rack_long 0.68x, mobile forklift 0.72x, lod2 rack 0.75x. Texture-heavy files about 0.95x. **HF serves without compression**, so self-hosting on Pages saves 25 to 45% on geometry-heavy files. |
| Material swap | Replace `KHR_materials_transmission` (shrink wrap, glass, bubble wrap) with `transparent` MeshStandardMaterial (opacity about 0.35, roughness 0.3). three.js transmission adds an extra render pass, which is costly on phones. |

**Hosting**
- Self-host the processed GLBs on GitHub Pages under `/weekend-projects/NN-fleet-planner/assets/`.
- Pages limits: published site **1 GB** max, soft **100 GB a month** bandwidth, 10-minute deploy timeout, 429 responses if rate-limited. Git warns at 50 MB per file and blocks at 100 MB.
- Our set is about 15 to 30 MB, so bandwidth is about 4,000 to 7,000 full loads a month, which is fine for a portfolio.
- If we ever hotlink HF instead: CORS is fine and Range requests work, but there is no compression, signed CDN redirects, and the dataset can change (it has already had several updates), so pin `resolve/3be2abd9.../`.

---

### 9. Visual quality and gaps

- **Quality:** real PBR throughout, with per-asset base colour, ORM and normal maps, and per-surface materials (painted metal, rubber, cardboard, recycled wood, nylon wrap). Originals had up to 4K textures; codepawl caps them at 1024. MDL-only shader effects are lost in conversion (README).
  - Expect the "SimReady" look to depend mostly on **lighting**: an environment map (PMREM), ACES or AgX tone mapping, SSAO or baked AO, soft shadows, and emissive high-bay lights.
  - VERIFY by eye: I could not open thumbnails here.
- **We must build these procedurally:**
  1. Building shell: walls (corrugated metal), roof trusses and skylights, columns (or instance `structure_wall_column_a01`).
  2. Concrete floor with polished-concrete roughness variation, plus **floor markings**: lane lines, pedestrian walkways, rack-foot lines, AMR zones, dock staging squares. Reuse the `tape_safety_*` and `environment_floor_a01` textures.
  3. **Dock doors** (sectional or roll-up), dock levellers, bumpers, dock lights, and **truck trailers** (none in the set).
  4. **Tall racks:** 6 to 12 m procedural uprights, beams and wire decks.
  5. **AMRs** (all kinds) and AMR charging pads.
  6. Traffic cones, bollards, column guards, aisle and location signs (canvas textures).
  7. Pick stations: compose from a packing table, monitor, tote and light.
  8. Totes in bulk: a low-poly procedural tote (the SimReady crates are 38k+ triangles).
  9. Shrink-wrap material swap, belt UV scroll, forklift fork and mast animation from the joint extras.

---

### 10. Top risks
1. **No people, no humanoid, no AMR** in SimReady. The realism of the external character and robot may not match the SimReady look. Pick after a visual check. Sketchfab downloads need Spiro's account.
2. **Too many triangles and draw calls** in most SimReady props (forklift c01 is 1M triangles and 208 draw calls; totes 38k to 108k). The raw `glb/` tier can't be used at scale, so stick to lod tiers plus our repack.
3. **Video memory on phones** if the WebP tier is used. Use KTX2 lod tiers. KTX2 on iOS Safari was not tested by codepawl.
4. **Trademark and decals.** Check the forklift decal textures. Use generic AMR designs and avoid branded Sketchfab models. Keep NVIDIA as a credit only, never as branding.
5. **Rack height (3 m) and pivots not at floor level.** Needs procedural racks and a pivot pass.
6. **Source changes.** codepawl updated the set several times in 10 days, and NVIDIA's set grew to 2,677. Pin the revision and self-host.
7. **Quaternius license drift** (QAL for new packs). Check the license inside each downloaded zip.

---

### 11. Sources
- https://huggingface.co/datasets/codepawl/simready-glb (card / README; `manifest.jsonl`, `thumbs/metadata.jsonl`; HF API `api/datasets/codepawl/simready-glb` and `/tree/main/<tier>?recursive=true`)
- https://huggingface.co/datasets/nvidia/simready-assets (card; `<asset>/com.nvidia.simready.packaging.json`; `<asset>/.metadata/LICENSE.txt`)
- https://docs.omniverse.nvidia.com/simready/latest/simready-central.html and https://unite.ai/nvidia-opens-simready-central-a-free-library-of-3d-simulation-assets (licensing is per asset; CC BY 4.0 recommended)
- https://creativecommons.org/licenses/by/4.0/legalcode.en (§2(a)(6), §2(b)(2), §3(a)(1) and (2))
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; header check on threejs.org `.glb` (served with gzip)
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/README.md (CC0)
- https://quaternius.com/packs/universalbasecharacters.html ; https://quaternius.com/packs/universalanimationlibrary.html ; https://app.cinevva.com/id/guides/free-rigged-3d-character-models (QAL note)
- https://github.com/microsoft/Microsoft-Rocketbox (MIT)
- Sketchfab Data API `api.sketchfab.com/v3/search` and `/v3/models/<uid>`; https://sketchfab.com/3d-models/nathan-animated-003-walking-3d-man-143a2b1ea5eb4385ae90a73657aca3bc
- https://docs.isaacsim.omniverse.nvidia.com/latest/common/license-faq.html ; https://docs.isaacsim.omniverse.nvidia.com/5.1.0/common/license-isaac-sim-additional.html
- https://en.wikipedia.org/wiki/Ready_Player_Me ; https://www.pocketgamer.biz/netflix-acquires-avatar-creation-platform-ready-player-me

---

# Part C: Rendering, pathfinding and determinism tech


Date: 2026-11-08. Research only, nothing in the repo was changed.

Notes on evidence:
- **[measured]**: measured during this research on Spiro's Mac (Apple Silicon, Node, three 0.187 from `01-silent-speech/node_modules`, esbuild minify plus gzip -9). The PIBT and many-brains numbers come from throwaway in-memory sketches run with `node -e`, not from product code.
- **[source]**: a cited paper or document.
- **[est]**: my estimate, to be proven in a spike.

---

### 0. TL;DR

| Layer | Pick | Why |
|---|---|---|
| 3D | **three.js r187, vanilla, `WebGLRenderer` (WebGL2)** | Smallest mature engine. Same stack as project 01. WebGPURenderer is still marked experimental, has a split-screen viewport bug, and costs +110 KB gz. |
| Static scenery | InstancedMesh (racks, boxes, pallets), BatchedMesh (assorted props), merged floor | About 40 draw calls per view for the whole warehouse |
| Glow routes | Instanced floor ribbons with an additive soft-falloff shader. UnrealBloomPass on the high tier only. | 1-2 draw calls, no post-processing needed on phones |
| Pathfinding | **PIBT** (Okumura et al.), hand-written in TS, on a lane/grid graph | **0.03 ms/tick at 150 agents in JS [measured]**. Runs one brain and many brains with the same code. |
| Many brains | K independent PIBT instances. Foreign robots are sensor obstacles. Recovery ladder: detour, step-aside, human reset. | Produces believable jams and deadlocks that recover on their own **[measured]** |
| Determinism | Integer ticks and cells, sfc32 PRNG in separate streams, no transcendental Math in the core, total-order sorts | Same hash on every rerun **[measured]**. Cross-engine test in Playwright. |
| UI | **Preact 11 + @preact/signals** for panels. Plain TS for 3D. | 5.0 KB gz |
| Charts | **uPlot 1.6.32** plus hand-rolled SVG sparklines | 21.9 KB gz versus Chart.js 69.6 KB gz |
| Perf tests | `renderer.info` draw-call and triangle budgets in CI. Real fps only on the Mac with GPU-verified Chromium. Byte budgets via `request.sizes()`. | SwiftShader fps on Linux CI is meaningless |
| Social clip | **Deterministic frame stepping, WebCodecs VideoEncoder, Mediabunny MP4**, driven by Playwright on the Mac. ffmpeg only for the final polish. | Perfect 60 fps regardless of machine speed |

---

### 1. Rendering

#### 1.1 Engine options

| Option | Pros | Cons | Bundle (gz) | Maturity |
|---|---|---|---|---|
| **three.js vanilla (WebGLRenderer)** | Biggest ecosystem. Full control of instancing and shaders. EffectComposer, UnrealBloomPass, Line2 and CSS2D all work. Project 01 already uses it with Vite + Vitest + Playwright. | Build your own app scaffolding, tiers, picking | Realistic app import set (renderer, InstancedMesh, BatchedMesh, StandardMaterial, GLTFLoader, KTX2Loader, MeshoptDecoder, EffectComposer + UnrealBloomPass + OutputPass, Line2, OrbitControls) = **207 KB gz / 789 KB min** [measured]. Full `three` namespace = 190 KB gz. | Very mature, r187 released 30 Oct ([releases](https://github.com/mrdoob/three.js/releases)) |
| three.js WebGPURenderer (`three/webgpu`, auto WebGL2 fallback) | WebGPU compute, lower driver overhead, TSL node materials, future direction | Manual: "still in an experimental state". No ShaderMaterial, no onBeforeCompile, no EffectComposer, so every custom shader must be rewritten in TSL ([manual](https://threejs.org/manual/pages/webgpurenderer.html)). Split-screen RenderPipeline bug: viewport and scissor are ignored with two pipelines on one canvas, WebGPU backend, r184 ([forum](https://discourse.threejs.org/t/renderpipeline-does-not-support-split-screen-multiple-viewports-with-webgpu-backend/92444)), which hits our hero feature directly. | Equivalent app set = **318 KB gz / 1,195 KB min** [measured], so +110 KB gz | Improving fast, not yet the recommended default for WebGL2 apps |
| react-three-fiber | Declarative scene, drei helpers, PerformanceMonitor | Adds React. Per-frame agent updates bypass React anyway. One more abstraction for Claude to debug. | @react-three/fiber 9.8.2 = 57.7 KB gz ([bundlephobia](https://bundlephobia.com/package/@react-three/fiber)) + react/react-dom about 46 KB gz ([measured in a Vite bench](https://github.com/guoyunhe/test-react-bundle-size)) = about **+104 KB** on top of three | Mature |
| Babylon.js | Mature WebGPU, built-in GlowLayer (selective glow), thin instances, great inspector | Heavy. Smaller fit with our repo. Slower first load. | @babylonjs/core 9.35.0 full = **1.84 MB gz** ([bundlephobia](https://bundlephobia.com/package/@babylonjs/core)). Tree-shaken scenes are smaller (not measured). | Mature |
| PlayCanvas engine | Strong mobile perf, VAT crowd work ([PR 9123](https://github.com/playcanvas/engine/pull/9123): 10k characters, 6 draw calls) | Editor-centric. Weaker tree-shaking. | playcanvas 2.23.3 = **637 KB gz** ([bundlephobia](https://bundlephobia.com/package/playcanvas)) | Mature |

**Recommendation: vanilla three.js r187 with `WebGLRenderer`.** The three manual says WebGLRenderer "remains the recommended choice for pure WebGL 2 applications". Our scene is small in draw calls (about 40 per view, section 1.3), so WebGPU's lower driver overhead buys little. Keep shaders small and isolated so a later TSL port is cheap. Re-evaluate WebGPU when the split-viewport bug is fixed.

#### 1.2 WebGL2 vs WebGPU, browser support (late 2026)

- WebGPU ships in Chrome/Edge 113+ desktop (Windows D3D12, macOS, ChromeOS) and in Chrome 121+ Android (Android 12+, Qualcomm/ARM GPUs). Firefox 141+ Windows and Firefox 145+ on macOS Tahoe ARM. Safari 26 on macOS/iOS/iPadOS/visionOS 26. Firefox on Linux and Android, and Intel Macs, are still in progress ([web.dev, Nov 25 2025](https://web.dev/blog/webgpu-supported-major-browsers); [gpuweb status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). Wikipedia notes Firefox Linux and Android were still pre-release as of Aug 2026 ([wiki](https://en.wikipedia.org/wiki/WebGPU)).
- Global reach estimates range from about 74% (web3dsurvey `navigator.gpu`) to about 76-85% (caniuse-derived, third-party) ([web3dsurvey](https://web3dsurvey.com/webgpu), [caniuse](https://caniuse.com/webgpu)). iPhones that can't run iOS 26 have no WebGPU.
- WebGL2 is effectively universal (Safari 15+, all current Chrome and Firefox).
- **Decision:** WebGL2 everywhere. The cost of WebGPU (TSL rewrite, experimental status, viewport bug, +110 KB) is higher than its benefit for about 100 draw calls.

#### 1.3 Hitting 60 fps: techniques and budgets

**Budgets.** No authoritative source exists. These are consensus planning numbers from blogs, so verify them in the spike:
- Phone: under 100 draw calls for smooth 60 fps on most phones, 150-200 for 2023-24 budget Android, 300-500 for 2025+ flagships ([hyperyond](https://hyperyond-website.pages.dev/blog/webgl-performance-optimization-2025), [abratabia](https://abratabia.com/mobile-browser-performance/reducing-draw-calls.php)). Web draw calls cost 2-3x more than native.
- Desktop: 2,000-5,000 draw calls before CPU-bound (same sources).
- **Our budget [est]:** laptop ≤ 150 draw calls and ≤ 2.5M triangles per frame (both views together). Phone ≤ 60 draw calls and ≤ 500k triangles. DPR cap: 2 on laptop high, 1.5 medium, 1.0-1.25 phone.
- Split screen renders the scene twice, so per-view budgets are half. Each camera culls separately.

**Planned draw-call inventory per view [est] (about 40):**

| Item | Technique | Draw calls |
|---|---|---|
| Floor, lane paint, walls, dock pits | One merged static geometry (2 materials) | 2-3 |
| Rack frames/beams | InstancedMesh per sub-mesh (3-4 bay variants) | 3-6 |
| Boxes/totes (thousands) | InstancedMesh per box variant. Per-instance color. Picked box = scale 0. | 3-5 |
| Pallets | InstancedMesh | 1 |
| Assorted props (conveyors, chargers, pack stations, dock doors) | BatchedMesh per material (many geometries, one draw, per-object visibility and culling) | 3-6 |
| AMRs / forklifts / humanoids | InstancedMesh per rigid part (body, wheels, forks, lights). Parts animated via per-instance matrices. | about 12 |
| Humans | ≤ 20 SkinnedMesh on laptop. Phone: rigid capsule humans, or a VAT later. | ≤ 20 |
| Blob shadows under agents | One instanced quad mesh | 1 |
| Route ribbons, rings, deadlock markers | Instanced quads | 2-3 |

**InstancedMesh vs BatchedMesh.** One geometry with many copies means InstancedMesh, which is fastest. Many different geometries sharing a material means BatchedMesh (multi-draw, per-object culling and sorting, per-instance geometry swap, so you get instance LOD via `setGeometryIdAt`). BatchedMesh stores per-instance data in a DataTexture and is reported slower at very high instance counts (>100k) ([forum](https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221)). r186/r187 fixed BatchedMesh sort corruption, draw offsets, a memory leak, and setGeometryIdAt visibility ([releases](https://github.com/mrdoob/three.js/releases)), so pin r187 or later.

**Lighting/realism without cost.** Use one PMREM RoomEnvironment for reflections, AgX/ACES tone mapping, fog for depth, and a dark glossy floor.
- Racks never move, so bake their contact shadows. One-time runtime bake: render the rack footprints top-down to a render target, blur it, multiply it onto the floor. This costs zero download.
- Agents get instanced blob shadows. One real-time directional shadow (1024-2048 map, agents only) on the high tier. Phones get no real-time shadows.

**LOD.** Agents use near/far geometry: two instanced meshes, or a BatchedMesh geometry swap by camera distance, recomputed each frame for ≤ 300 agents, which is cheap. Far rack bays drop the box layer beyond about 30 m on the low tier.

**Asset compression.**
- **meshopt** (EXT_meshopt_compression): decoder is **7.7 KB gz** [measured]. Always use it.
- **Draco**: decoder wasm is 63 KB gz [measured]. Skip it.
- **KTX2/Basis**: transcoder is **245 KB gz wasm + 15 KB gz js** [measured]. Use it only if the asset audit shows more than about 1-2 MB of textures or phone GPU-memory pressure. Otherwise use small WebP textures (EXT_texture_webp) and palette/vertex colors.
- Run all GLBs through `gltf-transform` (dedupe, simplify, weld, flatten, join, resize textures, meshopt).

**SimReady reality check.**
- NVIDIA ships SimReady as OpenUSD (e.g. SimReady Warehouse 01 pack 13.9 GB, Warehouse Assets Pack of 763 assets) ([NVIDIA docs](https://docs.omniverse.nvidia.com/usd/latest/usd_content_samples/downloadable_packs.html)). It is not GLB.
- A community GLB conversion exists: 2,595 assets, all CC-BY-4.0, meshopt + WebP ([codepawl/simready-glb](https://huggingface.co/datasets/codepawl/simready-glb)). Its stats are a warning: up to **5.57M triangles and 321 draw calls per asset**.
- Every asset needs decimation to budget: AMR ≤ 8k tris, forklift ≤ 15k, humanoid ≤ 10k, rack bay ≤ 2k, box ≤ 50, pallet ≤ 300. Merge to 1-3 materials each.
- Licenses must be checked per package (NVIDIA allows non-CC licenses into the library, see [SimReady Central](https://docs.omniverse.nvidia.com/simready/latest/simready-central.html)). CC-BY needs on-page attribution.

**First useful view in about 5 s.** Show a procedural low-poly warehouse immediately (racks and boxes from BoxGeometry, a few KB of code), then stream GLBs and swap them in. JS target ≤ 300 KB gz. First-view assets ≤ 3 MB.

#### 1.4 Glow route lines

| Option | Pros | Cons | Cost |
|---|---|---|---|
| **Instanced floor ribbons** (one InstancedMesh of quads, one instance per path segment, additive blend, soft-edge falloff plus animated flow in a tiny shader) | World-space width that lies on the floor like the Omniverse look. One draw call for about 5k segments. Glows without post-processing. | Write about 80 lines of shader | 1-2 draws |
| Line2 / LineSegments2 (fat lines) | Built in, screen-space width | Screen-space width looks wrong on the floor. A report shows fps drops to 10 at 1000+ separate lines unless batched into one geometry ([forum](https://discourse.threejs.org/t/improving-the-performance-of-high-density-lines/67635)). | +about 0 KB beyond three |
| TubeGeometry | Real 3D | Geometry rebuild on every route change. Many vertices. | High CPU |
| UnrealBloomPass (selective via emissive > threshold) | Real HDR glow | Several full-screen mip passes. One report: 40 fps and 90% GPU on a Core i7 with a single bloomed object ([forum](https://discourse.threejs.org/t/unreal-bloom-optimize/35476)). Fiddly with scissor split screen. | +about 15-20 KB gz code, 1-3 ms GPU at 1080p on iGPU [est] |

**Recommendation:** use the ribbons for every tier (they look like glow already). Add bloom only on the high tier at half resolution with mipmap blur. For split screen, render both viewports into the composer's target, then run one bloom pass.

#### 1.5 Labels, agents, split screen, adaptive quality

- **Labels.** Use CSS2DRenderer for ≤ 20 labels (followed robot, hovered agent, deadlock tags). CSS2D lags at about 300 labels, and troika text costs one draw call per label ([forum](https://discourse.threejs.org/t/how-to-create-lots-of-optimized-2d-text-labels/66927), [forum](https://discourse.threejs.org/t/100-dynamic-troika-three-text-labels-with-1s-updates/90287)). No always-on labels for 150 agents. Use hover tooltips via InstancedMesh raycast (`instanceId`).
- **Animating 100-300 agents.** Robots are rigid, so use per-part instanced matrices: wheels spin, forks lift, humanoid legs swing procedurally. That is about 1,000 matrix writes per frame, trivial.
  - Skinned humans cost one draw call per mesh plus CPU bone updates. That is fine for ≤ 20.
  - For crowds, vertex animation textures (VAT) render one draw call per mesh for thousands. PlayCanvas reports 10k characters at 6 draw calls and about 2.1 ms CPU ([PR](https://github.com/playcanvas/engine/pull/9123)). Blending between clips is harder. Defer VAT unless phones need it.
- **Split screen.** One renderer, one canvas, `setScissorTest(true)` plus `setViewport`/`setScissor` per half, `autoClear=false`, clear depth per view. This is the three manual's recommended approach. Multiple canvases hit WebGL context limits and can't share GPU resources ([manual](https://threejs.org/manual/en/multiple-scenes.html)).
  - Two sims share one scene graph for static scenery. Each side has its own agent instanced meshes, toggled visible per viewport via layers.
  - Phones stack the views vertically.
- **Adaptive quality.** Hand-roll about 50 lines; skip `@pmndrs/detect-gpu` because it fetches benchmark data from a CDN by default ([repo](https://github.com/pmndrs/detect-gpu)).
  - Tiers: high (DPR ≤ 2, bloom, agent shadow map), medium (DPR 1.5, ribbons only, blob shadows), low (DPR 1, far racks without boxes, simpler humans).
  - Start at low on coarse pointer and small screens, medium otherwise.
  - Demote when p95 frame time > 20 ms over 2 s. Promote when p95 < 12 ms over 5 s (hysteresis).
  - Freeze the tier in tests and capture.
  - Handle `webglcontextlost` (iOS kills contexts under memory pressure) with a friendly reload message.

---

### 2. Multi-agent pathfinding

#### 2.1 Algorithm options

| Option | Fit / believability | Speed evidence | Both modes? | Verdict |
|---|---|---|---|---|
| **PIBT**: Priority Inheritance with Backtracking (Okumura, Machida, Défago, Tamura; AIJ 2022, [arXiv 1901.11282](https://arxiv.org/abs/1901.11282)) | One-step reactive planner made for lifelong warehouse MAPF. Priority grows with time since last goal. Higher-priority robots "push" lower ones aside, which reads as an orchestrated fleet. Reaches all goals on graphs where every adjacent pair lies on a cycle (e.g. biconnected). | Complexity O(N·(Δ+F+log N)) per step. About **10 ms/step at 10,000 agents** in C++ on a laptop ([paper](https://ar5iv.labs.arxiv.org/html/1901.11282)). **JS [measured]: 0.011 / 0.020 / 0.029 / 0.065 ms per tick at 50/100/150/300 agents** on a 60×40 warehouse grid (1,770 free cells). An 8 h shift (28,800 1-s ticks) at 150 agents takes about 0.9 s. | Yes. One global instance, or K vendor-scoped instances. | **Use** |
| WHCA* / Cooperative A* with reservation table ([Silver 2005](https://ojs.aaai.org/index.php/AIIDE/article/view/18726)) | Real planned space-time routes to draw. Order-dependent, incomplete. | RHCR paper: CA* with w=5 needs 0.05 / 0.21 / 1.07 s per replanning call at 100 / 200 / 300 agents, in **C++** ([RHCR](https://ar5iv.labs.arxiv.org/html/2005.07371)). Too slow for 100-run JS sweeps. | Yes (per-vendor tables) | Only as an optional "route preview" |
| RHCR: rolling-horizon lifelong MAPF (Li, Tinka, Kiesel, Durham, Kumar, Koenig; [AAAI 2021](https://ojs.aaai.org/index.php/AAAI/article/view/17344)) | Best-known warehouse framework (Amazon co-authors). Plans windowed every h steps. Small windows can deadlock; they fix it by growing the window. Still incomplete. | PBS on a 33×46 fulfillment warehouse takes **0.33 s (60 agents), 2.04 s (100), 7.78 s (140)** per call. ECBS w=5 takes 0.07 s at 100 agents, C++ ([paper](https://ar5iv.labs.arxiv.org/html/2005.07371)). | Yes | Too slow in JS. Cite as the "industry-grade orchestrator" reference. |
| LaCAM / LaCAM* ([Okumura AAAI 2023](https://ojs.aaai.org/index.php/AAAI/article/view/26377); IJCAI 2023). Lifelong LaCAM with Local Guidance ([arXiv 2605.16855](https://huggingface.co/papers/2605.16855)) | Built on PIBT. Lifelong variant beats RHCR throughput with about 90% less runtime and gains about 30% over PIBT. Within 1 s/step at 10k agents (C++, M1 Ultra). | | Yes | v2 "smarter orchestrator" upgrade |
| Guided PIBT / Traffic Flow Optimisation (Chen, Harabor, Li, Stuckey; AAAI 2024) and Guidance Graph Optimization ([arXiv 2402.01446](https://www.emergentmind.com/papers/2402.01446)) | Congestion-aware guidance gives large throughput gains for PIBT | Cheap (changes edge costs) | Orchestrator only | **Use a simple version** (one-way aisles / congestion penalty) as an orchestrator advantage |
| CBS / ECBS | Optimal or bounded. RHCR: CBS fails at 200 agents. | Too slow lifelong | | No |
| ORCA / RVO2 ([van den Berg et al.](https://gamma.cs.unc.edu/courses/planning-f17/SLIDES/05_localNavigation_2.pdf)) | Continuous local avoidance, no global plan | Fast | n/a | Not needed. JS ports are stale (2018) or native-only ([rvo2 npm](https://www.npmjs.com/package/rvo2), [palmerabollo/rvo2-js](https://awesome.ecosyste.ms/projects/github.com%2Fpalmerabollo%2Frvo2-js)). |
| WPPL, League of Robot Runners 2023 winner (Jiang et al., [arXiv 2404.16162](https://arxiv.org/html/2404.16162v1)) | Windowed PIBT + LNS + guidance graphs, 1 s/step, up to 10k agents. PIBT initial solution within 250 ms at 10k agents, 20 ms at 800. Lesson: **rotations cut throughput a lot.** Modelling them matters for realism. | | | Design reference |

**No usable JS/TS MAPF library exists.** Only student repos (CBS in JS, CL-CBS in TS). Official PIBT is C++ ([pibt2](https://github.com/Kei18/pibt)). Hand-write PIBT: the sketch used for the benchmark is about 40 lines; production with types and speeds is about 200.

#### 2.2 Recommended design

**Graph.**
- 4-connected grid of 1.5 m cells, aligned to aisles. A 90 × 60 m warehouse is about 60 × 40 = 2,400 cells.
- Racks are obstacles. Pick faces are aisle cells next to racks. Docks, chargers and pack stations are cells with "dwell" tasks.
- Per-agent-type traversable subgraph: forklifts only in aisles ≥ 2 cells wide plus docks. AMRs everywhere. This is the simple form of the large-agent idea from LA-MAPF ([Li et al. AAAI 2019](https://ojs.aaai.org/index.php/AAAI/article/view/4756)).
- Distance maps: BFS per (agent type, goal), cached. Use Uint16Array: 2,400 cells × 2 B × about 700 goals ≈ 3.4 MB.
- Keep chargers and parking as dead-end pockets entered only when the planner grants them. That keeps PIBT's cycle condition on the main graph.

**Time and speeds.**
- Integer tick = 0.5 s of sim time. An 8 h shift is 57,600 ticks.
- Speed is integer ticks per cell: AMR 2 (1.5 m/s), forklift 3 (1.0 m/s), humanoid 3, plus turn costs (AMR 1 tick per 90°, forklift 2).
- An agent mid-move is committed. It holds both from- and to-cells, can't be pushed, and is treated as an obstacle. PIBT only plans agents that are at a cell boundary. This is the simple way to get mixed speeds while keeping PIBT unchanged.
- Forklifts also reserve one safety-field cell ahead along their heading.

**One brain.**
- One global PIBT over all robots of every vendor.
- Priorities: time since last goal, plus task urgency, plus a seeded tie-break.
- Orchestrator perks: guidance costs (congestion penalty or one-way main aisles, as in TFO/GGO), global task assignment (below), and charger scheduling.

**Many brains (K vendors).**
- Each vendor runs its own PIBT over its own robots only.
- Foreign robots are visible only as current-cell obstacles within sensor range. They can't be pushed and their next moves are unknown.
- A physical layer resolves two vendors claiming the same empty cell: a seeded-random robot "arrives first" and the others safety-stop. Stops cascade to followers.
- Recovery ladder (tunable parameters, so the size of the gap is honest and adjustable):
  1. Every `T_wait` (≈ 2.5 s = 5 ticks) while blocked: private detour map with foreign robots within 3 cells as obstacles, valid for 10 ticks.
  2. Every 4×`T_wait`: random step-aside (seeded backoff of 1-3 ticks, where staying is not allowed).
  3. Stuck ≥ 5 min: "manual reset" event. Render a human walking over, move the robot to the nearest free cell, and add the labor cost to the money panel.

**What the sketches showed [measured].** Same 60×40 grid, same order stream on both sides, K=3 vendors, 8 h shift:

| Setup | Tasks/h one brain | Tasks/h many brains | Idle % (one / many) | Deadlocks ≥ 10 ticks per shift (many) |
|---|---|---|---|---|
| 60 robots, 3-wide aisles | 5,567 | 3,643 (−35%) | 2.7 / 33.6 | 32 |
| 120 robots, 3-wide aisles | 9,941 | 4,576 (−54%) | 5.3 / 41.9 | 187 |
| 60 robots, 1-wide aisles | 4,941 | 3,259 (−34%) | 2.8 / 27.9 | 52 |
| 120 robots, 1-wide aisles | 8,335 | 4,533 (−46%) | 5.1 / 34.9 | 579 |

Key findings:
- (a) **Naive many brains (foreign robots as walls, no detour) gridlocks completely**: 96-98% idle, because staying beats a sideways step when the best cell holds a foreign robot. The recovery ladder is required, not optional.
- (b) With the ladder, the hero chart writes itself. Adding robots gives diminishing returns under many brains (60→120 robots: +26%) and near-linear gains under one brain (+79%).
- (c) The gap is likely **overstated**. Calibrate sensor radius, `T_wait` and vendor rules (e.g. vendor-specific one-way conventions) against real-world figures from the other research topics. Expose them as "how smart are the vendors' robots" settings.
- (d) Cost: detour BFS dominates many brains at **0.3-1.2 ms/tick**, versus 0.03 for one brain. Replace the full BFS with a bounded local A* or a cached detour to reach ≤ 0.2 ms/tick.

**Deadlock detection and display.**
- Each tick, build the wait-for graph: edge a→b if a is stopped and its preferred next cell (its top PIBT candidate) is occupied or reserved by b. Out-degree is ≤ 1, so cycle detection is pointer-chasing in O(N). This was implemented in the sketch at negligible cost.
- A deadlock is a cycle that persists ≥ 10 ticks (5 s). A jam is ≥ 3 agents stopped ≥ 10 s within 5 cells.
- Show it with a red pulsing ring and red arrows along the cycle, a "DEADLOCK 0:42" tag, a timeline marker, and KPI tiles (deadlocks/shift, jams/h, idle %, average wait per order).
- Reference implementation pattern: robots as nodes, waits-for as edges, DFS cycle detection ([waremax deadlock.rs](https://docs.rs/waremax-map/0.1.0/waremax_map/deadlock/)). Industry: separate fleet managers "cannot negotiate the same intersection, so shared aisles either deadlock or must be physically segregated" ([Seraphim guide](https://seraphim-site.pages.dev/pages/robotics/fleet-management-robotics)). VDA 5050 is an interface, not a traffic planner ([fabrico](https://www.fabrico.io/blog/what-is-vda-5050-agv-amr-interface/)). A TU Delft thesis builds deadlock detection for mixed AGV fleets ([repo](https://repository.tudelft.nl/file/File_7771bc48-7dbe-4910-894b-54c39a131390)). This supports the premise.

**Humans.**
- Humans are not in any planner and don't reserve cells. Each walks its own grid A* route in continuous fixed-point coordinates (mm, integers) at about 1.3 m/s with a small seeded lateral offset.
- Robots treat the human's cell plus their next cell as blocked this tick. A protective stop applies if a human is in the cell ahead. Slow mode (extra tick per cell) applies if one is within 2 cells.
- Humans only wait for forklift safety fields.
- No ORCA or social-force model in v1. Optional later: social force ([Helbing](https://gamma.cs.unc.edu/courses/planning-f17/SLIDES/05_localNavigation_2.pdf)) for human-human spacing, render-side only.

**Lifelong task assignment.**
- Orders arrive from a seeded stream that is **shared by both split-screen sides**.
- Many brains: the WMS splits tasks by type or zone per vendor. Each vendor runs greedy nearest-idle by BFS distance, as typical fleet managers do.
- One brain: batch assignment every 10 ticks with Hungarian / Jonker-Volgenant over idle robots × open tasks. Cost = travel ticks + age penalty, with deterministic tie-breaks. O(n³) at n=150 is about 3.4M ops, a few ms [est]. Hand-write about 80 lines; npm munkres ports are old.
- Baseline literature: Token Passing / TPTS for MAPD ([Ma, Li, Kumar, Koenig AAMAS 2017](https://www2.cs.sfu.ca/~hangma/pub/aamas17.pdf)). TP is the most efficient, CENTRAL the most effective.
- Battery: < 20% triggers a charger task. The orchestrator staggers charging; vendors charge greedily.

#### 2.3 Target agent counts

- **Laptop:** default fleet of 40-70 robots plus 10-15 humans per side. Supported maximum 150 agents per side (300 rendered in split screen). Render cost is a handful of instanced draw calls. Sim cost at ≤ 0.2 ms/tick per side is about 1 ms per frame at 100x.
- **Phone:** default 25-40 agents per side, maximum 60, low tier, stacked split.
- **Sweep:** 20-100 runs × 8 h. At about 0.1 ms/tick one brain → about 6 s/run. Many brains after the detour optimization → about 10 s/run. 100 runs on a pool of `min(hardwareConcurrency − 1, 8)` workers → about 2-4 min. Stream results into the chart as they finish. Default to 20 runs (≤ 1 min).

---

### 3. Determinism in JS

#### 3.1 PRNG options

| PRNG | State | Quality | Speed | Verdict |
|---|---|---|---|---|
| **sfc32** | 128-bit | Passes PractRand and TestU01 BigCrush. Bryc calls it the best 128-bit JS PRNG ([bryc PRNGs.md](https://github.com/bryc/code/blob/master/jshash/PRNGs.md)). | Fast | **Use.** Seed all 4 words from SplitMix32/xmur3 of (masterSeed, streamId). Discard the first 12 outputs ([simblob](https://simblob.blogspot.com/2022/05/upgrading-prng.html)). |
| xoshiro128** | 128-bit | Weak low bits, fails linear-complexity and binary-rank tests (bryc) | Fast | No |
| mulberry32 | 32-bit | Period about 4e9, skips about a third of 32-bit values (author's own note) | Fastest | No (OK for render-side jitter only) |

All of these use only `|0`, `>>>`, `Math.imul`, `+` and `^`, so they are exact on every engine.

#### 3.2 Rules for the sim core (`sim/` folder)

1. **Integer world.** Ticks, cell ids, speeds and durations are ints. Human positions are int mm. Money is int cents. Floats appear only in reported KPIs, computed at the end from int counts.
2. **No transcendental Math in the core.** ECMA-262 makes sin, cos, atan2, exp, log, hypot, cbrt and **sqrt** "implementation-approximated" and only recommends fdlibm ([read262 Math](https://read262.netlify.app/numbers-and-dates/math-object)). The `**` operator / `Number::exponentiate` is also approximated ([es.discourse](https://es.discourse.group/t/a-proposal-for-the-exponentiation-operator-to-call-math-pow/1333)).
   - Real divergence: a physics engine's state hash differed between Node 20 (V8 11.3) and Chrome 149 (V8 14.9) because of `Math.sin/cos`. Fixed only by replacing them with fdlibm-style kernels ([bounce #8](https://codeberg.org/perplexdotgg/bounce/issues/8)).
   - Exact and safe: abs, floor, round, trunc, sign, min, max, clz32, imul, fround.
   - Use 4/8-direction integer headings and squared distances. Poisson arrivals become a per-tick Bernoulli with an integer threshold, no `log`. Service-time spread uses Irwin-Hall (sum of uniforms) or a precomputed int table.
   - The renderer may use any Math. Render state is never fed back into the sim.
3. **Banned in the core:** `Math.random`, `Date`, `performance.now`, `crypto`, timers, Promise/async, `for…in`, objects-as-maps, `localeCompare`/`Intl`, WeakMap/WeakRef, DOM. Enforce with a `sim/tsconfig.json` without the DOM lib, plus a Vitest test that greps `sim/**` for the banned tokens. No ESLint dependency needed.
4. **Sorting.** Array sort is stable since ES2019. Comparators must be a total order with a final tie-break on agent id (as in the benchmark). Never call default `sort()` on numbers.
5. **Iteration order.** Map and Set iterate in insertion order (spec), so they are deterministic only if insertion is. Prefer typed arrays indexed by id. Integer-like object keys iterate in ascending order before string keys, another reason to avoid objects-as-maps.
6. **Float summation order.** If any float accumulates, sum in fixed index order. Aggregate sweep results by run index, never by worker completion order.
7. **Workers and structured clone.** Send only plain JSON config plus seed. Structured clone keeps numbers bit-exact and Map/Set order, but drops prototypes. Each run is self-contained, so the worker split never affects results.
8. **PRNG streams.** Separate streams for orders, humans, tie-breaks, failures and per-vendor jitter, so adding a feature doesn't shift the order stream. Identical orders on both split-screen sides is what makes the comparison fair.
9. **Tests.**
   - (a) Golden Vitest in Node: seed 1, default fleet, 8 h. KPIs within pinned ranges plus an exact state hash (hash updates require an explicit snapshot bump).
   - (b) **Cross-engine:** run a 1 h shift in Playwright Chromium, Firefox and WebKit and in Node. All final hashes must be equal. Cheap, and it proves no engine-specific math leaked in.
   - The benchmark already showed identical hashes across reruns (`13d9fc54` twice) [measured].

---

### 4. Smooth render of a discrete sim

- **Decouple** sim rate from frame rate using the fixed-timestep accumulator pattern ([Gaffer "Fix Your Timestep" summary](https://hn.jakechampion.name/reader/http://kirbysayshi.com/2013/09/24/interpolated-physics-rendering.html), [Defold example](https://defold.com/examples/physics/interpolation)): `acc += dtReal × speed; while (acc ≥ tickSec && budget) step(); alpha = acc / tickSec`.
- **Render one tick behind** (an interpolation buffer, as in netcode). The renderer always knows both the previous and next cells plus the move after, so it can:
  - lerp position by `alpha`, linearly with no stop-start easing when consecutive moves continue in the same direction;
  - ease only at real starts and stops;
  - round corners with a render-only quadratic Bézier through the cell corner when a turn+move sequence is known;
  - interpolate yaw on the shortest arc (AMRs rotate in place during turn ticks; forklifts arc).
  - Lag is 0.5 s at 1x, invisible to viewers.
- **Multi-tick moves** (2-3 ticks/cell) are interpolated over the move's own start/end ticks, not per tick.
- **Time scale:** 1x / 10x / 100x / Max. Cap sim work per frame (e.g. 4 ms). If the cap is hit, show the effective speed ("running at 74x"), which prevents a spiral of death.
  - At ≥ 10x, keep linear interpolation but shorten trails. At Max, render at most 15 fps snapshots and show a progress bar.
- **Where the live sim runs:** main thread is fine. At ≤ 0.2 ms/tick, 100x is 200 ticks/s, about 40 ms per real second, about 0.7 ms per frame per side. Max mode and sweeps run in workers. Keep the core worker-safe from day 1.
- **Follow cam:** critically damped spring on the interpolated robot pose. "Pull out" is an eased camera path to a fitted overview of the floor bounds. OrbitControls is enough; `camera-controls` (yomotsu) is optional if transitions get complex.

---

### 5. UI layer and charts

| UI option | Pros | Cons | gz size |
|---|---|---|---|
| Plain TS + small DOM helpers | Zero deps, matches project 01 | Hand-managed updates for many reactive tiles, hover explainers and controls get messy | 0 |
| **Preact 11 + @preact/signals** | JSX components. Signals update KPI tiles without re-rendering. React knowledge applies. Tiny. | One dependency | **5.0 KB** (preact 11.2.0, [bundlephobia](https://bundlephobia.com/package/preact)) + signals about 2 KB [est] |
| Lit | Web components, small | Templating less familiar, class-based | about 5-7 KB [est] |
| React 18/19 | Biggest ecosystem | about 46 KB gz ([bench](https://github.com/guoyunhe/test-react-bundle-size)) | 46 KB |

**Pick Preact + signals.** The money panel with hover explanations, fleet controls, sweep progress and results tables is enough reactive UI to justify 7 KB. The 3D layer stays imperative TS. Read sim KPIs at 4 Hz into signals.

| Chart option | Pros | Cons | gz size |
|---|---|---|---|
| **uPlot 1.6.32** | Very fast (canvas), small, line+band charts (throughput vs fleet size with min/max band across seeds; cumulative cash and payback curve), live-update friendly | Bar and categorical charts need a plugin. Plain styling. | **21.9 KB** ([bundlephobia](https://bundlephobia.com/package/uplot)) |
| Chart.js 4.6.1 | Rich chart types, animations, tooltips | 3x the size. Tree-shaken line chart is about 25 KB per a third-party blog. | **69.6 KB** full ([bundlephobia](https://bundlephobia.com/package/chart.js)) |
| Hand-rolled SVG | 0 KB, perfect styling | Axes, ticks and hover all hand-written | 0 |

**Pick uPlot** for the sweep and payback charts. Hand-rolled SVG for KPI sparklines and the one bar comparison (orders/h left vs right).

---

### 6. Testing and measurement

**fps (real numbers only on real GPUs).**
- Linux CI headless uses SwiftShader software GL, so fps there is meaningless. Chromium docs list `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader` for WebGL in headless, GPU-less runs ([Chromium SwiftShader doc](https://chromium.googlesource.com/chromium/src/+/205191a32c9db91062c5342e901b2da2d67a49e5/docs/gpu/swiftshader.md)).
- **CI-safe proxies:** at 3 fixed camera poses (overview, follow-cam, split) assert `renderer.info.render.calls` ≤ budget and `.triangles` ≤ budget. Assert `renderer.info.memory.geometries/textures` stay flat after 60 s at 100x (no leaks). Assert sim ms/tick in a Vitest bench in Node with generous limits.
- **On Spiro's Mac:** a local `npm run perf` Playwright script.
  - Run Chromium headed, or `channel: 'chrome'`. Headless on Apple Silicon has had WebGL issues ([chromium-dev](https://groups.google.com/a/chromium.org/g/chromium-dev/c/8eR2GctzGuw)). Flags to try: `--enable-gpu --use-angle=metal --ignore-gpu-blocklist`.
  - **Gate:** check `WEBGL_debug_renderer_info` `UNMASKED_RENDERER_WEBGL` contains "Apple"/"Metal" and not "SwiftShader" before trusting any number. One report found WebGPU about 25x slower in macOS headless versus headed ([HF note](https://huggingface.co/spaces/whitphx/transformersjs-performance-leaderboard-backend/commit/317d5b553293d9f133cfd8596ee8e30522020fe6)).
  - Run a 20 s scripted camera tour. Record rAF deltas: p50/p95/p99 frame time and the count of frames > 33 ms. Run 3 times.
  - Also run an uncapped headroom pass with `--disable-gpu-vsync --disable-frame-rate-limit`.
  - Optional: CDP `Emulation.setCPUThrottlingRate(4)` to mimic a weaker laptop (CPU only).
- **Phone:** Spiro opens `?perf=1` on his iPhone. A HUD shows tier, p50/p95 fps and draw calls. He sends a screenshot.

**Download bytes.**
- `page.on('requestfinished')`, sum `request.sizes()` `responseBodySize` (encoded on-the-wire bytes, [docs](https://playwright.dev/docs/api/class-request#request-sizes)) plus `responseHeadersSize`.
- Chromium-only alternative: CDP `Network.loadingFinished.encodedDataLength`, closest to DevTools ([page-weight post](https://blog-olive-nine-11.vercel.app/blog/measuring-page-weight)).
- Caveat: a local static server may not gzip like GitHub Pages does. Either serve dist with gzip in tests, or also compute gzip sizes of `dist/` files in a build script, and re-check against the live Pages URL after deploy.
- Budgets: JS ≤ 300 KB gz, first-view total ≤ 3.5 MB.
- First useful frame ≤ 5 s under CDP `Network.emulateNetworkConditions` (10 Mbps, 40 ms RTT) plus 4x CPU throttle. The app sets `performance.mark('first-warehouse-frame')`.

**Screenshots (visual regression).**
- Linux CI only (SwiftShader). `?test=1&seed=1&tick=1200&paused=1&quality=fixed` freezes the sim tick, shader time uniform, camera, tier and DPR. Use `deviceScaleFactor: 1` and a fixed viewport. The app sets `window.__ready = true` after the frame renders.
- `expect(canvas).toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`. QA Wolf suggests 0.01 for canvas ([docs](https://docs.qawolf.com/qawolf/visual-diffing.md)).
- Playwright's `animations: 'disabled'` does nothing to WebGL, so the app must freeze its own time.
- Generate baselines in the same CI image (workflow_dispatch "update snapshots"). Mac GPU output will not match.
- Add GPU-independent "semantic pixel" checks too: floor region dark, yellow lane pixels present, route-ribbon hue present, canvas not blank.
- `page.screenshot` doesn't need `preserveDrawingBuffer`. Only in-page `toDataURL` readback after the frame does; enable it only in test or capture mode.

---

### 7. The 30 s social clip

| Option | Smooth 60 fps on any machine? | Quality | Effort | Verdict |
|---|---|---|---|---|
| **Deterministic frame stepping + WebCodecs `VideoEncoder` + Mediabunny MP4 (in-page)**, driven by Playwright | **Yes.** Frame i has timestamp `i·1e6/60` µs no matter how long it took to render ([MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API)). | Controlled bitrate (12-20 Mbps H.264 High) | Medium | **Recommend** |
| Frame stepping + `canvas.toBlob(PNG)` per frame → Node via `exposeBinding` → `ffmpeg -framerate 60 -i %05d.png -c:v libx264 -crf 16 -pix_fmt yuv420p` | Yes | Best (lossless intermediates) | Medium. 1,800 PNGs at 1080p is several GB on disk. | Fallback |
| Playwright `recordVideo` / `page.screencast` | No. Real-time capture. recordVideo is VP8 at a hard-coded 1 Mbit/s ([dev.to](https://dev.to/mutsuntsai/replacing-playwrights-hardcoded-vp8-encoder-a-deep-dive-into-pagescreencast-43ee), [issue 31424](https://github.com/microsoft/playwright/issues/31424)). Screencast defaults to 25 fps; `fps` option added in v1.64; frames are JPEG ([docs](https://playwright.dev/docs/api/class-screencast)). | Low-medium | Low | No |
| `canvas.captureStream()` + MediaRecorder | No. Real-time, slow content drops frames, no per-frame control ([WICG](https://discourse.WICG.io/t/allow-non-realtime-use-of-mediarecorder/2308)). Stalls in background tabs ([bugzilla](https://bugzilla.mozilla.org/show_bug.cgi?id=1344524)). Silent failures at 720p on some Android devices. | Uncontrolled | Low | No |

**Plan.**
- `?capture=clip1` turns off the rAF loop, freezes the tier and sets the canvas to exactly 1920×1080 (side by side) or 1080×1920 (stacked, for Reels).
- It exposes `window.__capture.step(i)`. That advances the sim and camera script to t = i/60 s, renders both viewports, makes `new VideoFrame(canvas, {timestamp: i*1e6/60, duration: 1e6/60})`, encodes it (keyframe every 60 frames) and closes the frame.
- Mediabunny MP4 writing is about 17 KB gz, tree-shakable, MPL-2.0, and replaces the deprecated mp4-muxer ([mediabunny.dev](https://mediabunny.dev/)). Load it via dynamic import only in capture mode, so normal visitors pay zero bytes.
- A Playwright script (`npm run clip`) on Spiro's Mac drives 1,800 steps and saves the download.
- WebCodecs is supported in Safari 26+ and Chrome ([caniuse](https://caniuse.com/webcodecs)). H.264 availability depends on the build, so check `VideoEncoder.isConfigSupported({codec:'avc1.640028',…})` first. Playwright's bundled Chromium may lack it; use `channel: 'chrome'`, or encode VP9 and transcode with ffmpeg.
- ffmpeg is only for final polish: transcode, `+faststart`, add music or captions.
- Verify with `ffprobe`: exactly 1,800 frames at a constant 60 fps.

---

### 8. Recommended stack and dependency list

Runtime dependencies:
- `three@0.187.x`: renderer, GLTFLoader + MeshoptDecoder, InstancedMesh/BatchedMesh, EffectComposer + UnrealBloomPass (high tier), CSS2DRenderer. Mature, smallest full-featured engine, already used in project 01.
- `preact@11` + `@preact/signals`: reactive panels for about 7 KB gz instead of 46 KB for React.
- `uplot@1.6.32`: fast canvas line and band charts for the sweep and payback, 21.9 KB gz versus 69.6 KB for Chart.js.
- `mediabunny` (capture mode only, dynamic import): MP4 muxing for WebCodecs output, about 17 KB gz, zero normal-visitor cost.

Dev and build dependencies:
- `vite@8`, `typescript@7`, `vitest@5`, `@playwright/test@1.6x`: same toolchain as project 01. Playwright ≥ 1.64 for screencast `fps` if ever needed.
- `@gltf-transform/cli` (with meshoptimizer): build-time GLB decimation, compression and texture resizing to hit per-asset budgets.
- System `ffmpeg` (Mac only, clip post-processing), installed by Claude via Homebrew when needed.

Hand-written (no dependency, each small and testable):
- sfc32 + SplitMix32 seeding (about 20 lines)
- PIBT with committed multi-tick moves (about 200 lines)
- BFS distance maps with Uint16 cache
- Wait-for-graph cycle detector (about 30 lines)
- Recovery ladder
- Hungarian/JV assignment (about 80 lines)
- Fixed-timestep loop with an interpolation buffer
- Adaptive-quality monitor (about 50 lines)
- Instanced ribbon shader (about 80 lines)
- Banned-API grep test

Deliberately not used:
- r3f/drei: +104 KB, abstraction not needed for imperative instancing
- Babylon (1.84 MB gz full core) and PlayCanvas (637 KB gz)
- WebGPURenderer: experimental, split-viewport bug, +110 KB
- Chart.js
- ORCA/RVO2 JS ports: stale
- MAPF npm packages: none mature
- `@pmndrs/detect-gpu`: CDN benchmark fetch
- Draco: meshopt is smaller and faster to decode
- KTX2: until the asset audit shows it pays for its 260 KB transcoder

---

### 9. Risks to prove with a spike (pass/fail)

1. **Render budget on real hardware.**
   - Scene: 90×60 m warehouse, 400 rack bays, 20k boxes, 150 agents per side, route ribbons, split screen.
   - Pass: Spiro's Mac, headed Chrome, GPU-verified: p95 frame time ≤ 16.7 ms at DPR ≤ 2 (medium tier); ≤ 150 draw calls total; ≤ 2.5M triangles.
   - Pass: Spiro's iPhone, low tier: p50 ≥ 30 fps over 2 min with no context loss.
2. **SimReady asset pipeline.**
   - Find GLB or USD-to-GLB sources for an AMR, forklift, humanoid, rack, box and pallet. If SimReady lacks robots, note the alternatives.
   - Pass: each within its triangle budget (AMR ≤ 8k, forklift ≤ 15k, humanoid ≤ 10k, rack ≤ 2k, box ≤ 50); each ≤ 400 KB; first-view total ≤ 3 MB; license confirmed CC-BY-4.0 with an attribution line.
3. **Sim speed.**
   - Pass: one brain ≤ 0.1 ms/tick at 150 agents (sketch: 0.03).
   - Pass: many brains ≤ 0.2 ms/tick after replacing full-BFS detours (sketch: 0.3-1.2).
   - Pass: 8 h shift ≤ 10 s; 100-run sweep ≤ 4 min on the Mac worker pool.
4. **Many-brains believability.**
   - Pass at the default fleet: many brains gives 10-40% fewer orders/h than one brain (calibrated to topic a/b figures); ≥ 1 visible deadlock per sim-hour that self-recovers in ≤ 2 min; ≤ 2 manual resets per shift; no permanent gridlock.
   - Pass: one brain has 0 deadlocks lasting > 10 s.
   - Spiro watches a 2-minute split-screen and answers yes or no: "does the left look like real robots getting stuck?"
5. **Determinism.**
   - Pass: identical final state hash for seed 1, 1 h shift, in Node, Chromium, Firefox and WebKit, and in main thread versus worker.
   - Pass: the banned-API grep test finds 0 hits in `sim/`.
6. **GPU-true perf measurement on the Mac.**
   - Pass: a Playwright-launched Chromium reports an Apple/Metal renderer (not SwiftShader); 3 repeated runs of the perf tour agree within ±5% on p95 frame time.
7. **Deterministic CI screenshots.**
   - Pass: the same frozen frame rendered twice in one SwiftShader run is pixel-identical; diff ≤ 0.1% across 5 CI runs.
8. **Clip capture.**
   - Pass: 1,800 frames at 1920×1080 rendered and encoded on the Mac in ≤ 5 min; `ffprobe` shows exactly 1,800 frames at constant 60 fps; H.264 MP4 plays in QuickTime and uploads to Instagram (Spiro checks on his phone).
9. **First useful view.**
   - Pass: Playwright run with 10 Mbps / 40 ms RTT and 4x CPU throttle reaches `first-warehouse-frame` in ≤ 5 s with ≤ 3.5 MB transferred; JS ≤ 300 KB gz.
10. **Split-screen + bloom (high tier).**
    - Pass: both viewports render correctly with one bloom pass; enabling bloom costs ≤ 3 ms on the Mac at 1080p; auto-disabled on low and medium.

---

# Part D: Market and why-now



Each claim has a verdict, evidence bullets and numbered footnotes [n] that point to the source list at the end. Quotes are kept to a short phrase per source. Where a source is a vendor, an aggregator or secondary press, the bullet says so.

---

### Claim 1. Warehouses increasingly run mixed fleets from several vendors whose software does not coordinate

**Verdict: PARTLY VERIFIED.** Companies clearly use several robot brands, and software from different brands clearly does not coordinate without extra work. What is weaker is "the same floor": the best survey says buyers like to stick to one brand inside a single building. No public source gives a hard share of sites with several vendors on one floor.

- Interact Analysis surveyed 300 buyers and users worldwide (2024). They used **3.4 mobile robot brands on average**, and **123 brands** were named in total [1].
- The same coverage says customers **prefer the same brand across workflows in one building**, but not across their whole network [2]. So the brand mix shows up at company level more than on one floor.
- Awareness of the interop standard is low. Only **20% were "fully aware" of VDA 5050**, and **8%** said it was or soon would be required in their purchasing [1].
- Trade press in 2021 found same-floor multi-vendor deployments "still relatively rare". Most vendors handed goods to each other rather than sharing aisles [3]. That is dated, but it matches the survey above.
- November 2026: A3's director of robotics standards said industrial users have "asked for an interoperability standard for years" [4]. GM said it runs mobile robots from **several brands at sites worldwide** and backs the new ISO standard. A3 named GM and P&G as end users involved [5] (MarketScale summarizing A3).
- On how bad it is without interop, Aaron Prather (as summarized by MarketScale [5]) says robots that can't interoperate can't negotiate right-of-way or coordinate routes, so **humans have to step in**.
- Doors, lifts and chargers: robots, control systems and infrastructure "frequently come from different manufacturers," so every project needs custom work [6] (VDMA in an IFR blog post, Oct 2026).
- Integration is the top stated barrier. In Interact Analysis "Voice of the Market" (Jul 2026), **45%** blamed integration complexity, ahead of upfront cost (41%) and budget (38%) [7]. In a Kardex/Peerless survey (vendor-sponsored, 2026), only **23%** said their warehouse systems were fully integrated [8].
- Big 3PLs built their own glue. DHL and GXO built in-house middleware or integration platforms for multi-vendor fleets [9] (low-tier blog, Feb 2025; treat as color only).

**Wording that holds up:** "Warehouses buy from several robot brands, but those robots' software doesn't talk to each other, so sites keep them apart or add custom glue." Avoid "most warehouses run mixed fleets on one floor."

---

### Claim 2. Interoperability standards are emerging

**Verdict: VERIFIED, and it's the strongest why-now in this research.** VDA 5050 v3.0 came out in April 2026. ISO 21423:2026 was published in early **November 2026**, the week of this research.

#### VDA 5050 (VDA + VDMA, Germany)
- **v3.0 released April 2026.** The VDA press release is dated 20 April 2026 [10]. Some trade sources say 19 March 2026, which is likely the GitHub tag date. GitHub `main` shows **3.0.0**; the roadmap lists 3.0.1, 3.1.0 and a 4.0.0 that is "not planned" [11].
- **What it is:** an open interface between mobile robots and one central fleet control ("master control") over **MQTT + JSON** [11]. It is a protocol, not a fleet manager. Both the fleet control and every robot must implement it [12].
- **Topics [11]:**
  - `order` (fleet control to robot)
  - `instantActions` (pause, cancel and so on)
  - `state` (robot to fleet control)
  - `visualization` (fast position and planned path)
  - `connection`
  - `factsheet` (what the robot can do)
  - new in v3, optional: `zoneSet` and `responses`
- **Traffic control works by "base and horizon."** Fleet control releases nodes and edges a few at a time. The robot only drives the released "base", and it stops at the last released node (the decision point) unless fleet control extends the base in time [11]. This is the central "one brain" model.
- **v3 zones [11]:** BLOCKED, LINE_GUIDED, RELEASE, COORDINATED_REPLANNING, SPEED_LIMIT, ACTION, PRIORITY, PENALTY, DIRECTED (one-way), BIDIRECTED.
  - A **RELEASE** zone is a standard mutex. The robot sends an ACCESS request, and fleet control answers GRANTED, QUEUED, REVOKED or REJECTED.
  - With no answer, the robot must not enter.
  - A grant can carry a `leaseExpiry`. If access is lost inside the zone, the robot follows STOP, CONTINUE or EVACUATE.
- **v3 also adds path sharing for free-navigating robots.** They send their planned path so fleet control can keep shaping traffic [10]. VDMA calls v3 "a toolkit for mobile robots of all kinds" [10].
- **Companion specs:**
  - **LIF** (Layout Interchange Format) shares lanes, nodes and stations between integrators and fleet control. It is being revised for v3, with the draft open for comment from 24 Aug 2026 [13].
  - **M2X** covers robots talking to doors, elevators, gates, chargers and transfer stations. It builds on VDA 5050; the draft was v0.2.1 in June 2025 [6][14].
- **Known gaps [12]:** no shared map format, no cross-robot fault recovery, security left to integrators, and each new vehicle type usually needs custom work. That is BlueBotics' view, and BlueBotics is a vendor.
- **Adopters:**
  - OTTO by Rockwell is certified on SYNAOS, idealworks and NAiSE VDA 5050 platforms (May 2026) [15].
  - Seegrid is aiming for full compliance in 2026 [16].
  - MiR has a VDA 5050 adapter built with input from Siemens SIMOVE and others [17].
  - BlueBotics ANT server [12] and Siemens SIMOVE Fleetmanager [17] also support it.

#### MassRobotics AMR Interoperability Standard (US)
- **v1.0, May 2021, open on GitHub, self-certified** [18].
- It covers **status sharing only**: ID, maker and model, size, operating state, location with timestamp, speed and heading, and next destination [18].
- It explicitly "isn't a fleet management, vehicle navigation, or safety system" [18]. It does not cover tasking, chargers or maps.
- v2.0 (mission API, charging) was announced in 2022 [18]. **I found no evidence v2.0 shipped**, so treat it as stalled. ISO 21423 now carries this work forward.

#### ISO 21423:2026 (new, the headline why-now)
- **Published, announced by A3 on 2 Nov 2026** [4][5][19]. Developed by **ISO/TC 299 WG10**, with about 90 participants [5].
- Shared data: robots, fleet managers and other equipment can **exchange location, speed, direction, condition, tasking and availability, and ask each other for actions**. It also covers **lifts, automated doors, alarms**, ERP and machines that robots tend [4][5].
- It **builds on MassRobotics + VDA 5050** and uses MQTT and JSON [5].
- It supports **both central and distributed** control. A3 frames VDA 5050 as best for centrally controlled sites and ISO 21423 as the more flexible complement [5].
- Price: $373, or $320 for A3 members [4]. A3 calls it the first non-safety robot standard it has helped produce [19].
- Caveat: the ISO catalogue may still show "under publication" [19]. The A3 announcement is the authoritative date.

#### Other standards
- **Open-RMF** (open source, OSRF):
  - Every fleet adapter reports planned itineraries to a shared **traffic schedule** and negotiates conflicts.
  - Adapter levels: full control, **traffic light** (RMF can only pause and resume a robot), and read-only [20][21].
  - **Mutex groups** let only one robot at a time lock a set of lanes or spots [21].
  - **Door and lift supervisors** handle open, close, hold and lift sessions [20].
  - It started at Changi General Hospital in Singapore [22].
- **Singapore SS 713:2025** covers data exchange between robots, lifts and automated doorways. The door must acknowledge, open fully, hold until the robot clears, and report its state. **TR 130** covers robots talking to central command systems [22][23]. ISO/AWI 26159-2 (lifts and automatic doors) is an ISO work item [14].
- **IEEE 1872.x** covers robot ontologies: CORA 2015, 1872.2-2021 for autonomous robots, and an active P1872.3 project on reasoning across multiple robots [24]. These are knowledge models, **not an operational traffic protocol**. Mention them only as background.
- **ISO 23247** is a digital-twin framework for manufacturing. That comes from background knowledge and was not re-verified here. It is **not** a robot interop standard, so don't cite it as one.

---

### Claim 3. Robot orchestration startups and platforms are emerging

**Verdict: VERIFIED, with a funding caveat.** The category is busy and getting crowded. But most pure orchestration startups have raised small rounds, and big money goes to robot "brains" (Mujin) or to WMS players building their own layer. One big incumbent (Zebra) is leaving AMRs altogether.

| Company | Positioning | Latest disclosed funding / news | Source |
|---|---|---|---|
| SVT Robotics | "Agnostic" integration platform (SOFTBOT) between robots and WMS | $25M Series A, Nov 2021 (Tiger Global); nothing disclosed since | [25] |
| InOrbit | Robot ops and orchestration ("Space Intelligence"); ISO 21423 contributor | $10M Series A, 30 Sep 2025; OpenRobOps open-source fleet manager Feb 2026 | [26] |
| Formant | Robot data and fleet ops cloud | $21M, Oct 2023 (BMW i Ventures); no 2025–26 round found | [27] |
| Meili Robots (DK) | Vendor-agnostic fleet manager (VDA 5050, ROS) | Tiny rounds (<$0.5M, sources conflict); multi-floor release Jan 2026 | [28] |
| Roboteon | Multi-vendor fulfillment and orchestration (SAP EWM, D365) | No funding disclosed; free "vendor-independent" ROI simulation Feb 2026; manufacturing push Jul 2026 | [29][30] |
| Botsync (SG) | AMRs + vendor-agnostic SyncOS | Extended Series A (SGInnovate), Jan 2026, amount undisclosed | [31] |
| Konnex | "Robots like apps" coordination layer | $15M, Jan 2026 (secondary) | [32] |
| Mujin (JP) | MujinOS "robot brain" platform | $233M Series D (equity + debt), Dec 2025; MujinOS subscription Apr 2026 | [33] |
| GreyOrange | GreyMatter orchestration; GreyMatter Foundry simulator (Apr 2026) | Funding totals unverified | [34][35] |
| Locus Robotics | LocusONE orchestrates **its own** robot types (multi-form-factor, not multi-vendor) | — | [36] |
| BlueBotics | ANT server (VDA 5050) | — | [12] |
| Synkar | Sidewalk-delivery robots + SARA cloud; **not a warehouse orchestrator** | Seed with iFood 2021 | [37] |
| Rapyuta, Freedom Robotics | Not verified this pass (Rapyuta "$16M Series A" on Caplight is unclear) | — | — |

**Big players**
- **Zebra Technologies** is *exiting* its Fetch AMR business. A 9 Dec 2025 SEC filing says it plans to "dispose or exit," with charges of up to $80M [38]. That's a useful warning: hardware AMR margins are hard.
- **Rockwell / OTTO:** VDA 5050 certifications for mixed fleets (May 2026), plus Rockwell orchestration software [15].
- **Siemens:** SIMOVE Fleetmanager runs mixed fleets over VDA 5050 and links to Plant Simulation for virtual commissioning [17].
- **NVIDIA:** "Mega" Omniverse Blueprint (CES, Jan 2025) for testing robot fleets in a digital twin. It is still marked **preview** on build.nvidia.com; I found no GA. KION, Dematic, Accenture, idealworks and Foxconn are integrating it [39][40].
- **WMS vendors:** Blue Yonder Robotics Hub ("vendor-agnostic" SaaS layer) [41], and Manhattan says its WMS has a built-in robotics layer [36] (via aggregator).

---

### Claim 4. NVIDIA released free SimReady 3D assets so equipment makers can let customers test equipment in simulation before buying

**Verdict: MOSTLY VERIFIED.** Release, date, free and open, and the OEM angle are all confirmed. Two nuances matter: NVIDIA says customers can evaluate "before real-world deployment", not "before buying", and the license is set per contributor.

- **The X post** (@nvidiaomniverse, **21 Oct 2026**) announces the **SimReady Central Library**: "over 2,000" simulation-ready 3D assets on **Hugging Face**, open source. It says equipment makers can help customers evaluate equipment in simulation before real-world deployment. Stats: 25.7K views, 108 likes, 27 reposts, 63 bookmarks; the account has 27.2K followers [42]. The link resolves to the HF blog [43].
- **HF blog** (NVIDIA authors John Kosnik, Frank DeLise, Pomi Lee; 21 Oct 2026) [43]:
  - 2,000+ **free, ungated** OpenUSD assets. Categories include robot arms, grippers, **warehouse equipment, racks**, and cooling gear.
  - Contributors: Vertiv, Comau, FANUC, Franka, Robotiq, Standard Bots, Universal Robots, Palatial, LG and ForgeCAD.
  - OEMs' customers can "test and simulate scenarios faster".
- **License** [44][45]:
  - There is no single license. Each contributor declares one, and any type is allowed, including non-commercial.
  - NVIDIA recommends **CC-BY-4.0**, and only CC-BY-4.0 assets are included in the Isaac Sim browser and distributed in China.
  - The index dataset card lists Apache-2.0 and says the service is **alpha**.
  - **Check each asset's license** before shipping. Use CC-BY-4.0 assets and credit them.
- **Count varies:** "over 2,000" (NVIDIA), 2,575 (MoguraVR, LinkedIn), 2,595 (CodePawl's GLB conversion), and 3,599 search results in the live UI (Unite.AI) [46][47]. Use "2,000+".
- **Earlier warehouse set:** `nvidia/PhysicalAI-SimReady-Warehouse-01` has **753 OpenUSD assets, CC-BY-4.0**, v1.1.0 from May 2025, about 15 GB [48]. Its preview shows mostly small props; I couldn't confirm pallets, racks or forklifts.
- **Browser-ready version:** CodePawl (the author of reference post 1) published **2,595 SimReady assets as GLB** on HF under **CC-BY-4.0**. It shrank about 225 GB to 3.8 GB, with one example dropping from 888 MB to 9.3 MB [47][49]. **This is the practical source for a browser app**, but check each asset's upstream license.
- **Isaac Sim 5.0** was open-sourced under **Apache 2.0** (GA Aug 2025). The license covers the code only; Omniverse Kit and NVIDIA's assets have their own licenses [50].
- **Mega blueprint:** see Claim 3 [39][40]. It is the "big company" version of what Fleet Planner does: it needs GPUs, NVIDIA's stack and an integrator.

---

### Claim 5. Context numbers

**Verdict: VERIFIED for market, payback, hesitation and humanoids. PARTLY for labor.** Turnover has no good primary source.

#### Market size and growth
- **Mobile robots (AGV/AMR):** just under **$5B (2024) to $14B (2030), about 19% CAGR** (Interact Analysis, Jan 2026). That forecast was **cut 12%** from May 2025 because of tariff uncertainty [51][52].
- **Warehouse automation orders:** **+7% in 2025**, about **+6% expected in 2026** (Interact Analysis, secondary) [53].
- **North American warehouse robot purchases:** over **36,700 robots in 2025** (most since 2022), and about **18,000 in H1 2026** (+2% YoY, about $1.2B, +7%) [54] (ITIF citing the WSJ).
- Robot adoption: **52%** of surveyed companies use robots (up from 48%), and **32%** more plan to within 3 years. The sample was small: 166 people (Peerless/MHI 2026) [55].

#### Labor
- **About 392,000 unfilled jobs** in transportation, warehousing and utilities in June 2026, **up 87,000 YoY** [54].
- Average warehouse wage was **about $27/hr** (Jun 2026), **+5% YoY and +41% in a decade** [54].
- BLS job-openings rate for transportation, warehousing and utilities was **4.1%** in 2025 (annual average) [56].
- Accenture projects a gap of about **1.1M US supply chain workers by 2035** [57].
- **Turnover: NOT VERIFIED.** BLS doesn't publish a warehouse-only rate. Figures of 36%, 49% and ">50%" come from vendor blogs with no primary source. Don't put a turnover number in the README, or write "high turnover" with no number.

#### Payback buyers require
- **80%** of buyers expect ROI **within 3 years**, and most expect **18 months to 3 years**; 3PLs expect faster (Interact Analysis, 300 buyers) [1]. **This is the best number for the app's "pays back in X" bar.**
- Vendors claim faster: Locus "under 12 months", MiR and Seegrid "under 18 months" [58][59]. Treat those as marketing.
- Older benchmark: Tompkins found buyers expect payback within 24 months (2012-era data) [60].

#### Robots-as-a-Service
- How companies want to pay: 36% hybrid, **36% pure CapEx, 29% RaaS** (2026 survey) [55].
- Among current users: 53% hybrid (buy hardware, subscribe to software), 37% CapEx, **11% RaaS** [55].
- The often-quoted "64%" from MHI mixes **RaaS and SaaS** (2024) [61]. Don't quote it as RaaS.
- Humanoids are sold as RaaS: GXO's Digit deal was "the first RaaS agreement for humanoids" [62].

#### Why buyers hesitate
- Integration complexity is the top barrier at **45%**, then upfront cost at 41% and budget at 38% (Interact Analysis, Jul 2026) [7].
- In a DHL survey of 350 North American leaders, **57%** fear disrupting operations, **56%** lack internal expertise, and **41%** cite money. Only **34%** are fully satisfied with their robot deployments [63]. The report year isn't shown on the page; it's a "Nov 13" piece about DHL's "Insight 2030" report.
- At MODEX 2026, buyers often fell back on proven options because the career risk was as big as the technical risk [64] (podcast summary; color only).
- "Can't see it working in my building" isn't a survey line item, but vendors sell straight at it. GreyOrange: automation "should not be a leap of faith" [35]. Roboteon offers a free simulation on your own layout and order data [30].

#### Humanoids in warehouses (status Nov 2026)
- **Agility Digit at GXO** [62][65]:
  - At Flowery Branch, GA since late 2023, under a multi-year RaaS deal from June 2024. It has moved **more than 100,000 totes**.
  - Expansion announced 26 Oct 2026: two more US sites, starting with Digit 4 in **early 2027**. Sources disagree on locations (Statesville NC / Lebanon TN vs IN).
  - **Digit 5** was unveiled 15 Sep 2026, with general availability **expected by end of 2027** [66].
- **GXO overall:** about **20,000 robots by end of 2026, zero humanoids in production**, and 45 humanoid pilots. The CEO said they have "not achieved ROI on humanoids yet" [62][65].
- **Schaeffler + Agility:** an investment and plan to buy, announced Nov 2024. **A 2026 live deployment is unverified** (only a tracker blog claims it).
- **Figure at BMW Spartanburg:** Figure 02 ran about 10 months (BMW's figure; others say 11) and helped build **30,000+ X3s**. **Figure 03** has been deployed for logistics sequencing since **25 Jun 2026** (BMW press) [67]. That's a factory, not a warehouse.
- **Apptronik:** $520M extension, Feb 2026 (about $935M total Series A). The **GXO and Mercedes work is still pilots** [68].
- **Gartner (21 Jan 2026):** **fewer than 20 companies** will have humanoids in production for supply chain and manufacturing by 2028, out of about 200 proofs of concept [69].
- Interact Analysis: about 40,000 humanoid shipments worldwide by 2032 (secondary; low adoption until then) [70].
- **README line that holds up:** "Humanoids are in pilots; the robots buyers actually deploy at scale in 2026 are AMRs, AGVs and autonomous forklifts."

---

### Claim 6. Competition and alternatives for "help me decide which robots to buy"

**Verdict: VERIFIED that alternatives exist. VERIFIED that none is free, instant, in the browser, vendor-neutral and explainable at once.** The two closest are new in 2026: GreyMatter Foundry (from a vendor) and Roboteon's free analysis (a 2–3 week service).

| Option | Examples | What it's good at | Gap Fleet Planner fills |
|---|---|---|---|
| Vendor ROI calculators | OTTO (labor-only inputs) [71], MiR (fleet size + ROI) [72], Kinexon (free fleet size and ROI) [73], Mobot [74], Locus (ROI guidance) [58] | Fast and free | One vendor's robots, spreadsheet math, no traffic, no mixed-fleet penalty, numbers tilted to the seller |
| Vendor "neutral" simulators | **GreyOrange GreyMatter Foundry** (Apr 2026: flow, sizing, layout, AI copilot; claims ≥95% accuracy, best within its own partner network) [35]; **Roboteon** free Robotics Investment Impact Analysis ("vendor-independent", 2–3 weeks, delivered as a service) [30] | Higher fidelity, uses real data | Sales-led, not self-serve, not instant, not open or explainable |
| Desktop simulation suites | FlexSim (free Express is capped at about 30 objects) [75], AnyLogic (free PLE is non-commercial, size-limited) [76], Simio, Emulate3D (Rockwell), Visual Components, Siemens Plant Simulation (pairs with SIMOVE) [17] | Deep, accurate discrete-event models | Paid licenses (quote-based; one reseller anchor is about $6K/yr for FlexSim, weak) [77], need a trained modeler, weeks of work |
| GPU digital twins | NVIDIA Omniverse / Isaac Sim / Mega [39][50] | Photoreal physics, robot-brain testing | Needs RTX GPUs, developers and an integrator; preview status |
| Consultants and integrators | Material-handling consultants and integrators (not researched by name) | Site-specific design | Expensive and slow; often tied to integrators who resell some vendors |

**The gap (for README and pitch):** No tool lets a warehouse owner open a link and, in minutes:
- see robots from several vendors in a 3D model of a warehouse like theirs;
- see **the hidden cost of "many brains"** (waiting at shared doors, crossings and chargers) next to one orchestrator;
- get a **payback date measured against the under-3-year bar buyers actually use** [1], with every assumption visible.

Vendor calculators ignore other vendors. Simulators need experts. GPU twins need a GPU and an integrator. The new standards (VDA 5050 v3, ISO 21423) make "one brain" realistic for the first time, and the free SimReady assets make the 3D model cheap to build.

---

### Claim 7. Reference posts (social proof)

**Verdict: VERIFIED** (via api.fxtwitter.com, 2026-11-08).

1. **An Xuan (@anxuanng)**, 31 Oct 2026: "Opus 5.5 built a live warehouse from NVIDIA's free SimReady models" [78].
   - **163,827 views, 2,566 likes, 195 reposts, 2,394 bookmarks**, 30 replies, 23 quotes. 24.6s video, 1080p.
   - The author has **1,786 followers**, so views are about 92 times the follower count. Bio "Worlds, rendered."; site codepawl.com.
   - It quotes his own 28 Oct post: "NVIDIA put 2,595 free 3D models on Hugging Face." That post got 176K views and 1,065 bookmarks. It says he cut the set from about 225 GB to 3.8 GB for the browser and released it free under CC BY 4.0 as `codepawl/simready-glb` [47][49].
   - Tools: Claude Opus 5.5, NVIDIA SimReady, his own GLB pipeline (Three.js-tagged dataset).
2. **Konstantin Saifoulline (@konstantinsaifo)**, 4 Nov 2026: "Claude Opus 5.5 built the fulfilment center using free NVIDIA SimReady models and Airsup." He adds it shows a live warehouse with 22 aisles, pickers, racks and trailers [79].
   - **15,358 views, 284 likes, 49 reposts, 225 bookmarks**, 13 replies. 28s video. The author has 4,811 followers.
   - He is the **founder of Airsup**, which builds live digital twins of factories from existing drawings and data [80]. So the post doubles as an ad for his product.
3. **NVIDIA Omniverse source post**, 21 Oct 2026: 25.7K views, 108 likes [42]. The two builder posts got **far more reach than NVIDIA's own announcement**: about 6 times the views for post 1.

**Takeaway:** Bookmarks run unusually high relative to likes (about 0.9 and 0.8), so people save this kind of post to use later. A live 3D warehouse made from free NVIDIA assets with an AI coding agent is a proven format. Fleet Planner adds what both lack: a business answer (which robots, how many, payback) and the many-brains vs one-brain story.

---

### How mixed fleets coordinate today (mechanisms to simulate on the "many brains" side)

These are ranked from most to least common in practice, with sources. In the sim, each vendor fleet has its **own planner that only knows its own robots**. Other vendors' robots are just obstacles or locks.

1. **Separation by area plus handoff points.** Each vendor gets its own zone or aisles, and goods pass between them at fixed handoff spots: conveyor ends, drop stations, staging lanes [2][3].
   - *Sim:* vendor A's robots can't enter vendor B's zone. Cross-zone jobs go through a handoff spot, which adds a queue and dwell time there.
2. **Zone locks (mutexes) on shared spots.** Crossings, narrow aisles, dock doors and charger bays are split into zones, and **only one vehicle can hold a zone at a time**. Classic AGV systems do this with a master PLC handing out zone "bit flags" [81]. Open-RMF does it with **mutex groups** [21]. VDA 5050 v3 does it with **RELEASE zones** (request, then GRANTED, QUEUED, REVOKED or REJECTED, with a lease timeout) [11].
   - The well-known failure: **deadlock**, where robot 1 holds zone A and waits for B while robot 2 holds B and waits for A [81].
   - *Sim:* first-come-first-served locks with a safety buffer. Waiting robots idle. Add a deadlock detector that freezes both robots until a "human reset" after N seconds.
3. **Traffic lights at crossings.** Dedicated crossings with traffic rules let new AMRs share a floor with older AGVs [82]. Open-RMF's "traffic light" adapter can only **pause and resume** a vendor's robots, not reroute them [20][21].
   - *Sim:* a light at each crossing, fixed green time per direction, so no robot gets priority for an urgent job.
4. **Door and elevator managers.**
   - Doors must confirm "fully open", hold until the robot clears, then report state (SS 713) [23].
   - Lifts run one session at a time (Open-RMF lift supervisor) [20].
   - Today most of this is custom work per project [6]. M2X and ISO 21423 aim to make it standard [5][14].
   - *Sim:* one shared dock door or lift with a single-occupancy queue, a fixed door cycle time, and no look-ahead booking across vendors.
5. **Status sharing only (MassRobotics / ISO 21423 "read-only").** Robots broadcast position, speed and heading so others *can* yield, but nobody plans for both [18][5].
   - *Sim:* a robot slows or stops when another vendor's robot is within X meters ahead, with no joint replanning.
6. **Humans as the tie-breaker.** When robots from different vendors can't negotiate right-of-way, people step in [5].
   - *Sim:* a "help needed" counter and minutes of supervisor time per shift. That converts straight into $ in the payback math.
7. **Separate task queues and chargers.** Each vendor's fleet manager takes only its own jobs from the WMS, often through middleware such as SVT, Roboteon or Blue Yonder Robotics Hub. Chargers aren't shared, and dashboards are split [18][9][41].
   - *Sim:* jobs pinned to a vendor pool, so an idle vendor-A robot can't take vendor B's backlog.

**"One brain" side (the orchestrator)** is modeled on the VDA 5050 central master control [11]:
- a global time-space reservation table that releases a few nodes at a time (base/horizon);
- priority by job urgency;
- RELEASE zones booked ahead instead of first-come;
- any robot can take any compatible job;
- one shared charger schedule;
- lift and door sessions booked in advance;
- no human tie-breaks.

The headline metrics in both panes: wait time at shared spots, throughput (picks/hr), robots needed for the target, help calls per shift, and payback months.

---

### Suggested README why-now paragraph

> Companies that use warehouse robots buy from 3.4 robot brands on average, one large survey found.[1] But robots from different brands usually cannot plan around each other, so warehouses keep them apart or make them wait their turn at shared doors and crossings.[2][3][5] That is starting to change: a new world standard, ISO 21423, came out in November 2026 so robots from different makers can share where they are and what they are doing.[4] At the same time, NVIDIA gave away more than 2,000 free 3D models of real equipment so buyers can test machines in a simulation first.[43] Most buyers want their money back within three years and say connecting new machines is the hardest part, so seeing the plan work before you buy matters more than ever.[1][7]

---

### Source list (accessed 2026-11-08 unless noted)

1. Interact Analysis survey of 300 mobile robot buyers (3.4 brands, VDA 5050 awareness, ROI within 3 years). https://www.automatedwarehouseonline.com/interact-analysis-asks-what-customers-want-from-mobile-robots-in-global-survey/ (Automated Warehouse, reposting Interact Analysis, 27 Jul 2024)
2. "Customers not loyal to one mobile robot brand" (same building vs network). https://www.sdcexec.com/home/article/22916046/interact-analysis-supply-chain-customers-not-loyal-to-one-mobile-robot-brand-or-type-heres-why (SDCExec, 2024; the page returned 403, so the phrase was taken from the search snippet)
3. "Robot fleets grow demand for WMS software, interoperability layer." https://www.robotics247.com/article/robot_fleets_grow_demands_warehouse_management_software_interoperability_layer (Robotics 24/7, E. Demaitre, 14 May 2021)
4. "New ISO interoperability standard covers collaboration among mobile robots from multiple vendors." https://www.therobotreport.com/new-iso-interoperability-standard-covers-collaboration-among-mobile-robots-from-multiple-vendors/ (The Robot Report, 3 Nov 2026). Also: https://www.robotics247.com/article/iso-21423-helps-mobile-robots-from-different-vendors-communicate-together (Robotics 24/7, 3 Nov 2026)
5. "A $373 ISO standard lets mobile robots from different vendors share a floor." https://www.marketscale.com/industries/industrial-iot/a-373-iso-standard-lets-mobile-robots-from-different-vendors-share-a-floor (MarketScale, 2–3 Nov 2026, updated 5 Nov)
6. "When mobile robots call elevators." https://ifr.org/post/when-mobile-robots-call-elevators (IFR blog, A. Scherb/VDMA, 6 Oct 2026)
7. "Material transportation automation is a top priority, finds Interact Analysis" (Voice of the Market). https://www.automatedwarehouseonline.com/?p=11798 (Automated Warehouse, 2 Jul 2026)
8. Kardex/Peerless 2026 Integrated Warehouse Systems Survey. https://info.kardex.com/kardex-2026-integrated-warehouse-systems-survey-report (Kardex/Peerless, 2026; via search snippet)
9. "Why warehouse robots don't work together." https://supplychain360.io/?p=7905 (Supply Chain 360, A. Scott, 24 Feb 2025; low-tier)
10. "Version 3.0 of VDA 5050 released." https://www.vda.de/en/press/press-releases/2026/260421_PM_VDA_5050_EN (VDA/VDMA press release, 20 Apr 2026)
11. VDA 5050 GitHub repo and spec. https://github.com/VDA5050/VDA5050 and https://raw.githubusercontent.com/VDA5050/VDA5050/main/VDA5050_EN.md (VDA/VDMA, v3.0.0, 2026)
12. "VDA 5050 Explained." https://bluebotics.com/blog/vda-5050-explained-agv-communication-standard (BlueBotics blog, 2026; vendor)
13. VDMA mobile robots topic page (v3, LIF revision, M2X). https://www.vdma.eu/en/level-2-minimal/-/category/3776794/fvlv/835169 (VDMA, 2026)
14. M2X project page. https://m2x-project.github.io/m2x (TU Dortmund/Fraunhofer IML/VDMA, v0.2.1 Jun 2025). ISO/AWI 26159-2: https://www.iso.org/standard/92741.html
15. "OTTO expands VDA 5050 support for mixed fleet control." https://control.com/news/otto-expands-vda-5050-support-for-mixed-fleet-control/ (Control.com, May 2026)
16. "Seegrid AMRs to meet interoperability standard by 2026." https://www.dcvelocity.com/material-handling/internal-movement/autonomous-mobile-robots-amrs/seegrid-amrs-to-meet-interoperability-standard-by-2026 (DC Velocity)
17. SIMOVE Fleetmanager product page. https://www.siemens.com/en-gb/products/simove/fleetmanager/ (Siemens, 2026; vendor). MiR VDA 5050 adapter: https://mobile-industrial-robots.com/blog/mir-expands-with-vda5050
18. "What is the MassRobotics AMR Interoperability Standard?" https://www.massrobotics.org/what-is-the-massrobotics-amr-interoperability-standard/ (MassRobotics/BlueBotics, K. Choi). Also: https://logisticsviewpoints.com/2022/09/14/massrobotics-amr-interoperability-version-2-0/ (Logistics Viewpoints, 14 Sep 2022)
19. "New ISO standard enables interoperability for mobile robots." https://www.designnews.com/automation/new-iso-standard-enables-interoperability-for-mobile-robots (Design News, 2 Nov 2026; via search snippet). A3 release: https://www.automate.org/robotics/news/new-iso-interoperability-standard-helps-mobile-robots-from-different-vendors-work-together (A3, Nov 2026; 403 to the fetcher)
20. "RMF Core Overview" (Programming Multiple Robots with ROS 2 book). https://osrf.github.io/ros2multirobotbook/rmf-core.html (OSRF)
21. "New release of Open-RMF on Iron and Rolling" (mutex groups). https://discourse.openrobotics.org/t/new-release-of-open-rmf-on-iron-and-rolling/35397 and the traffic-light adapter thread https://discourse.openrobotics.org/t/feature-and-limitation-of-traffic-light-adapter/50134 (Open Robotics Discourse; via search snippets)
22. Singapore open-source robotics initiatives (RMF, SS 713, TR 130). https://www.a-star.edu.sg/news/press-releases/singapore-robotics-open-source-initiatives (A*STAR / National Robotics Programme)
23. "ACCESSCO advances AGV–entrance integration" (SS 713:2025 details). https://www.malaymail.com/news/money/mediaoutreach/2026/10/19/accessco-advances-agventrance-integration-for-singapores-next-generation-of-smart-buildings/494678 (Media OutReach press release, 19 Oct 2026; vendor)
24. IEEE P1872.3 project page. https://standards.ieee.org/ieee/1872.3/12592/ (IEEE SA). IEEE 1872-2015: https://standards.ieee.org/standard/1872-2015.html
25. "SVT Robotics raises $25M in Series A funding." https://www.therobotreport.com/svt-robotics-raises-25m-in-series-a-funding/ (The Robot Report, Nov 2021)
26. "InOrbit raises Series A to scale robot operations offering." https://www.automatedwarehouseonline.com/inorbit-raises-series-a-scale-robot-operations-offering/ (Automated Warehouse, Sep/Oct 2025). Also https://www.inorbit.ai/press/series-a-investment
27. "Formant brings in $21M to expand enterprise focus." https://www.therobotreport.com/formant-brings-in-21m-to-expand-enterprise-focus/ (The Robot Report, Oct 2023)
28. "Meili Robots launches Code License for fleet management system." https://www.robotics247.com/article/meili-robots-launches-code-license-for-fleet-management-system (Robotics 24/7, Apr 2025). Funding: https://www.vcbacked.co/company/meili-robots
29. "Roboteon delivers unified fleet management and orchestration…" https://www.businesswire.com/news/home/20260721596769/en/ (Business Wire, 21 Jul 2026)
30. "Roboteon launches complimentary Robotics Investment Impact Analysis." https://www.roboticstomorrow.com/news/2026/02/25/unlock-the-roi-of-mobile-robots-roboteon-launches-new-complimentary-robotics-investment-impact-analysis/26187/ (Robotics Tomorrow, 25 Feb 2026)
31. "AMR and orchestration startup Botsync secures additional Series A funding." https://www.robotics247.com/article/amr-and-orchestration-startup-botsync-secures-additional-series-a-funding (Robotics 24/7, Jan 2026)
32. "Konnex raises $15 million…" https://www.pulse.bot/robotics/news/konnex-raises-15-million-to-develop-autonomous-robotics-platform-f352e8a9-50d1-4c03-a6fa-25bfbe5e2ecf/ (aggregator, Jan 2026; unverified with the company)
33. "Mujin raises US$233 million…" https://www.businesswire.com/news/home/20251202560677/en/ (Business Wire, 2 Dec 2025)
34. "GreyOrange demos vendor-agnostic fulfillment orchestration." https://www.dcvelocity.com/articles/60176-greyorange-demos-vendor-agnostic-fulfillment-orchestration (DC Velocity)
35. "MODEX 2026: GreyOrange launches GreyMatter Foundry." https://www.robotics247.com/article/modex-2026-greyorange-launches-greymatter-foundry (Robotics 24/7, 13 Apr 2026). Also https://www.automatedwarehouseonline.com/?p=11187
36. "Introducing LocusONE." https://locusrobotics.com/news/introducing-locus-one-warehouse-orchestration-platform (Locus Robotics, Mar 2023). Manhattan claim via https://sacra.com/c/locus-robotics (aggregator)
37. "Synkar offers sidewalk delivery as a service." https://www.therobotreport.com/synkar-offers-sidewalk-delivery-as-a-service/ (The Robot Report)
38. "Zebra Technologies winding down Fetch-based mobile robot group." https://www.therobotreport.com/zebra-technologies-winding-down-fetch-based-mobile-robot-group/ (The Robot Report, Dec 2025). Also https://www.robotics247.com/article/zebra_technologies_announces_plan_to_dispose_or_exit_robotics_automation_business_unit
39. "NVIDIA unveils 'Mega' Omniverse Blueprint for building industrial robot fleet digital twins." https://blogs.nvidia.com/blog/mega-omniverse-blueprint/ (NVIDIA blog, 6 Jan 2025)
40. Mega blueprint card (preview). https://build.nvidia.com/nvidia/mega-multi-robot-fleets-for-industrial-automation/blueprintcard (NVIDIA). Also https://techcrunch.com/2025/01/06/nvidia-details-mega-warehouse-robot-fleet-management-simulator/
41. Blue Yonder Robotics Hub. https://blueyonder.com/solutions/warehouse-management/robotics-hub (Blue Yonder; vendor)
42. NVIDIA Omniverse X post. https://x.com/nvidiaomniverse/status/2112986174906384735 via https://api.fxtwitter.com/nvidiaomniverse/status/2112986174906384735 (21 Oct 2026)
43. "SimReady Central: assets for robotics and AI factories." https://huggingface.co/blog/nvidia/simready-central-assets-robotics-ai-factories (Hugging Face blog by NVIDIA, 21 Oct 2026)
44. SimReady Central Library docs. https://docs.omniverse.nvidia.com/simready/latest/simready-central.html (NVIDIA)
45. SimReady Central index dataset card. https://huggingface.co/datasets/nvidia/simready-central-library (NVIDIA/HF; alpha, Apache-2.0 metadata)
46. "NVIDIA opens SimReady Central, a free library of 3D simulation assets." https://unite.ai/nvidia-opens-simready-central-a-free-library-of-3d-simulation-assets (Unite.AI, 21 Oct 2026)
47. CodePawl SimReady GLB dataset. https://huggingface.co/datasets/codepawl/simready-glb (CodePawl/HF, CC-BY-4.0, Oct 2026)
48. NVIDIA PhysicalAI-SimReady-Warehouse-01. https://huggingface.co/datasets/nvidia/PhysicalAI-SimReady-Warehouse-01 (NVIDIA/HF, v1.1.0, 18 May 2025, CC-BY-4.0)
49. An Xuan quoted post (28 Oct 2026), embedded in [78] via fxtwitter
50. Isaac Sim 5.0.0 release notes and license FAQ. https://docs.isaacsim.omniverse.nvidia.com/5.0.0/overview/release_notes.html and https://docs.isaacsim.omniverse.nvidia.com/latest/common/license-faq.html (NVIDIA, 2025)
51. "Mobile robot sales projected to reach $14B by 2030." https://www.cfodive.com/news/mobile-robot-sales-projected-reach-14b-2030/809950/ (CFO Dive, Jan 2026)
52. "Mobile robot market grows faster than fixed automation, finds Interact Analysis." https://www.automatedwarehouseonline.com/mobile-robot-market-grows-faster-than-fixed-automation-finds-interact-analysis/ (Automated Warehouse, Jan 2026)
53. "Report: warehouse automation order intake up by 7%." https://www.robotics247.com/article/report-warehouse-automation-order-intake-up-by-7 (Robotics 24/7, 2026, citing Interact Analysis)
54. "Robot purchases in the North American warehousing industry, first half of 2026." https://itif.org/publications/2026/08/24/robot-purchases-north-american-warehousing-industry-first-half-of-2026/ (ITIF, M. Ostertag, 24 Aug 2026, citing the WSJ, 17 Aug 2026)
55. "2026 Intralogistics Robotics Survey: robotics moves into the mainstream." https://www.mmh.com/article/2026_intralogistics_robotics_survey_robotics_moves_into_the_mainstream (Modern Materials Handling / Peerless Research Group with MHI, 2026; via search snippets, page 403)
56. BLS JOLTS Table 16, annual job openings rates by industry. https://www.bls.gov/news.release/jolts.t16.htm (US BLS, 2026)
57. "US businesses face shortage of 1.1M supply chain workers by 2035: Accenture." https://www.sdcexec.com/professional-development/hiring/news/22968704/accenture-us-businesses-face-shortage-of-11m-supply-chain-workers-by-2035-accenture (SDCExec, 2026). Also https://www.accenture.com/us-en/insights/supply-chain/talent-supply-chain
58. Locus ROI FAQ. https://locusrobotics.com/faqs/roi-business-impact (Locus Robotics; vendor)
59. "How to calculate a compelling ROI for AMR." https://mobile-industrial-robots.com/blog/calculate-roi-amr (MiR; vendor). Seegrid: https://hub.seegrid.com/blog/maximizing-roi-with-seegrid-amrs (vendor)
60. "Report names top reasons companies invest in distribution center technology" (Tompkins). https://www.inddist.com/operations/article/13763583/report-names-top-reasons-companies-invest-in-distribution-center-technology (Industrial Distribution, about 2012)
61. "Warehouse robotics adoption increases." https://www.supplychaindive.com/news/warehouse-robotics-adoption-increases-supply-chains/812369/ (Supply Chain Dive, MHI data)
62. "Agility, GXO Logistics plan expanded deployment of Digit humanoid." https://www.therobotreport.com/agility-gxo-logistics-plan-expanded-deployment-digit-humanoid/ (The Robot Report, 26 Oct 2026)
63. "Only 34% of leaders are satisfied with warehouse robotics" (DHL Insight 2030). https://www.warehouseautomation.ca/news/dhl-report (Warehouse Automation, "Nov 13", year not shown)
64. "Warehouse automation trends from MODEX 2026." https://www.mhwmag.com/podcasts/warehouse-automation-trends-from-modex-2026/ (MHW, 2026; via search snippet)
65. "GXO plans 20,000 robots in 2026, none of them will be humanoids." https://automate.org/robotics/industry-insights/gxo-plans-20-000-robots-in-2026-none-of-them-will-be-humanoids (A3, 2026; via search snippet). Also https://www.beri.net/article/gxo-agility-digit-humanoid-expansion-statesville-lebanon-raas-no-roi-yet-45-pilots-warehouse-automation
66. "Agility Robotics unveils Digit 5." https://www.supplychain247.com/article/agility-robotics-digit-5-humanoid-warehouse-work (Supply Chain 24/7, Sep 2026)
67. BMW Group press release, Figure 03 at Spartanburg. https://www.press.bmwgroup.com/global/article/detail/T0458778EN (BMW Group, 25 Jun 2026). Also https://www.therobotreport.com/bmw-group-deploys-figure-03-humanoid-after-tests-previous-version/
68. "GXO Logistics, Apptronik test Apollo humanoid robot in warehouse." https://www.therobotreport.com/gxo-logistics-apptronik-test-apollo-humanoid-robot-warehouse/ (The Robot Report). Funding: https://siliconangle.com/?p=730521 (SiliconANGLE, 11 Feb 2026)
69. "Gartner predicts fewer than 20 companies will scale humanoid robots… by 2028." https://www.gartner.com/en/newsroom/press-releases/2026-01-21-gartner-predicts-fewer-than-20-companies-will-scale-humanoid-robots-for-manufacturing-and-supply-chain-to-production-stage-by-2028 (Gartner, 21 Jan 2026)
70. "The humanoid robot pitch meets warehouse reality." https://www.fulfill.com/news/humanoid-robots-eye-warehouses-but-adoption-remains-under-5 (Fulfill, 2026, citing Interact Analysis; secondary)
71. OTTO ROI calculator. https://www.ottomotors.com/resources/roi-calculator (OTTO/Rockwell; vendor)
72. MiR calculator and ROI calculator. https://www.itismagazine.it/tendenze/mir-presenta-mir-calculator-e-roi-calculator (ITIS Magazine)
73. Kinexon free AMR/AGV fleet size and ROI calculator. https://kinexon.com/resources/amr-agv-fleet-size-roi-calculator (Kinexon; vendor)
74. Mobot ROI calculator. https://www.mobot.pl/en/roi/ (Mobot; vendor)
75. FlexSim feature limits by license type. https://forums.autodesk.com/t5/flexsim-knowledge-base/flexsim-feature-limitations-by-license-type/ta-p/13530769 (FlexSim/Autodesk forum)
76. AnyLogic editions. https://anylogic.help/anylogic/ui/editions.html (AnyLogic)
77. FlexSim on Capterra and Gartner (pricing anchors). https://capterra.com/p/107009/FlexSim/ (aggregator; weak)
78. An Xuan X post. https://x.com/anxuanng/status/2116504653215248436 via https://api.fxtwitter.com/anxuanng/status/2116504653215248436 (31 Oct 2026)
79. Konstantin Saifoulline X post. https://x.com/konstantinsaifo/status/2117886718062027230 via https://api.fxtwitter.com/konstantinsaifo/status/2117886718062027230 (4 Nov 2026)
80. Airsup homepage. https://airsup.ai (Airsup, 2026)
81. AGV zone control and deadlock (PLC guide) and IEEE Access zone-partition paper. https://industrialmonitordirect.com/blogs/knowledgebase/panasonic-fp7-designing-multi-agv-warehouse-control and https://doaj.org/article/bbb9f39f2e3848c883812ab58287a94a (IEEE Access, Jan 2023)
82. "How to manage diverse AGV & AMR fleets." https://kinexon.com/insights/multi-vendor-amr-and-agv-solutions (Kinexon; vendor)

#### Not verified or dropped
- Warehouse turnover percentages (no primary source).
- Schaeffler 2026 live Digit unit.
- MassRobotics v2.0 release.
- Mega general availability.
- Rapyuta $16M round.
- Freedom Robotics status.
- An exact 2030 warehouse automation $ figure from Interact.
- "NVIDIA to acquire Hugging Face": a single Spanish-language source; ignore.
