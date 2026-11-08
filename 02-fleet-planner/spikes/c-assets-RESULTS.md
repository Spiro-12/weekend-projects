# Spike c: assets, results

Measured 2026-11-08 on Spiro's M2 MacBook Air (two other spikes running). Gzip is level 6, like `scripts/serve-gz.ts`.
Rebuild: `npx tsx scripts/assets/build-assets.ts` (idempotent: a second run gives byte-identical files).

## Verdict

| Budget | Result | Pass |
|---|---|---|
| First tier (hi, all first-tier models + worker + meshopt decoder) ≤ 4 MB gz | **1.33 MB** | yes |
| Everything (hi + lo + lazy hero pallets + decoder) ≤ 15 MB gz | **2.01 MB** | yes |
| Phone low tier (lo where it exists, else hi, + decoder) ≤ 2 MB gz | **0.43 MB** | yes |
| Forklift ≤ 15k triangles | counterbalance 14,862 · stacker 11,979 · autonomous stacker 11,194 visible | yes |
| Humanoid ≤ 10k | 3,752 | yes |
| Worker ≤ 15k | 12,566 | yes |
| AMR ≤ 8k | 950 | yes |
| Rack-bay props ≤ 2k | loaded pallet 1,200 (lo 1,020) · wrapped 1,510 (lo 1,330) · tote 1,124 · cartons 300 | yes |
| Carton ≤ 50 at far LOD | carton_a 50 · carton_c 50 · **carton_b 56** | 2 of 3 (see below) |
| Pallet ≤ 300 | 300 (lo 120) | yes |
| Licenses CC BY 4.0 or CC0 only | 15 SimReady sources CC BY 4.0, Quaternius CC0 | yes |
| Forklift decals clean | decal materials dropped, all vehicle textures baked away | yes |

`carton_b` (the cube carton): meshopt's seam-aware simplifier stops at 56 triangles. Forcing 50 collapses across the
UV seams and skews the box into a wedge (seen in the first contact sheet), so I set its low tier to 56. The
far-LOD carton used in the composed pallets is `carton_a` at 50.

## Per asset

| Key | Source | First tier | Tris hi / lo | Draw calls hi / lo | KB hi (gz) | KB lo (gz) | Textures hi / lo |
|---|---|---|---|---|---|---|---|
| carton_a | box_cardboard_a01 | yes | 300 / 50 | 1 / 1 | 24.7 (22.6) | 4.9 (3.4) | 3x 512 WebP / 1x 256 |
| carton_b | box_cardboard_b01 | yes | 300 / 56 | 1 / 1 | 30.4 (28.5) | 5.6 (4.0) | 3x 512 WebP / 1x 256 |
| carton_c | box_cardboard_c01 | yes | 300 / 50 | 1 / 1 | 28.1 (26.1) | 5.3 (3.7) | 3x 512 WebP / 1x 256 |
| column | structure_wall_column_a01 | yes | 999 / 298 | 2 / 2 | 118.4 (113.4) | 13.0 (9.6) | 3x 512 WebP / 1x 256 |
| conveyor | conveyor_belt_a05 | yes | 7,723 / 1,920 | 2 / 2 | 162.1 (129.3) | 40.2 (31.0) | none (vertex colour) |
| dock_gate | barrier_gate_safetyDock_a02 | yes | 2,984 / 799 | 2 / 2 | 59.1 (47.5) | 19.9 (15.0) | none |
| forklift | vehicle_forklift_blue_c01 | yes | 14,862 / 3,964 | 5 / 5 | 333.6 (266.4) | 94.4 (71.8) | none |
| guard_rail | rail_guard_a09 | yes | 1,495 / 391 | 2 / 2 | 31.8 (24.5) | 11.1 (7.4) | none |
| light_panel | lighting_overheadLed_lightPanel_a01 | yes | 1,991 / 596 | 3 / 3 | 34.2 (22.9) | 14.8 (8.8) | none (emissive kept) |
| pack_table | table_packing_heavyduty_c01 | yes | 2,996 / 789 | 2 / 2 | 55.7 (43.6) | 18.6 (13.0) | none |
| pallet | pallet_a01 | yes | 300 / 120 | 1 / 1 | 71.4 (68.1) | 12.8 (10.4) | 3x 512 WebP / 1x 256 |
| pallet_loaded | composed: pallet_a01 + 18 x box_cardboard_a01 | yes | 1,200 / 1,020 | 2 / 2 | 107.2 (95.3) | 31.8 (20.9) | 6x 512 / 2x 256 |
| pallet_wrapped | composed: pallet_a01 + 24 x box_cardboard_c01 + film | yes | 1,510 / 1,330 | 3 / 3 | 116.0 (98.6) | 37.3 (20.9) | 6x 512 / 2x 256 |
| pallet_loaded_hero | pallet_assembly_a05 | lazy | 11,994 | 3 | 232.6 (205.5) | | 6x 512 |
| pallet_wrapped_hero | pallet_assembly_transparent_a02 | lazy | 11,996 | 3 | 222.6 (199.0) | | 3x 512 |
| stacker | vehicle_forklift_blue_a01 | yes | 11,979 / 3,469 | 4 / 4 | 248.3 (205.8) | 85.7 (68.1) | none |
| tote | crate_blue_a08 | yes | 1,124 / 296 | 1 / 1 | 25.8 (19.6) | 8.4 (6.4) | none |
| worker | Quaternius UBC + UAL | yes | 12,566 | 1 | 221.5 (138.9) | | none (vertex colour); clips walk, idle, push |
| meshopt decoder | three/examples/jsm/libs/meshopt_decoder.module.js | yes | | | (7.5) | | |

Code-built (`src/render/models/`, 0 bytes of assets):

| Model | Triangles | Meshes (draw calls) | Named parts |
|---|---|---|---|
| `amr.ts` `buildAmr()` | 950 | 6 | `body` (group), `totes`, `light` |
| `humanoid.ts` `buildHumanoid()` | 3,752 | 26 | `pelvis > torso > head`, `armL/armR > forearmL/forearmR`, `legL/legR > shinL/shinR`; `poseHumanoid(h, phase, amount)` walks it |
| `autonomous-forklift.ts` `dressAutonomousForklift(stackerClone)` | 11,194 visible (stacker minus tiller, plus about 250) | 9 | stacker's `body`, `forks`; adds `sensorMast`, `lidar`, `scanner`, `warning`, `blueLight`, `safetySpot` |

Manifest: `public/assets/manifest.json`, model key → `{ url, urlLo?, scale, offset, size, tris, trisLo?, drawCalls, drawCallsLo?,
bytes, gzBytes, bytesLo?, gzBytesLo?, textures, texturesLo?, parts, clips?, license, credit, source, firstTier, label }`,
plus `decoder.gzBytes` and the pinned revisions. URLs are relative to the app base (`import.meta.env.BASE_URL`).
Moving parts are separate child nodes, translation only, so no pivots are needed: forklift `forks` + `carriage` lift
together and `mast` extends for high lifts; stacker `forks` lifts and `tiller` can be hidden.

## How the pipeline works (`scripts/assets/`)

- `fetch.ts`: downloads `glb/<asset>.glb` from codepawl at the pinned revision into `.cache/simready/` (gitignored), and reads NVIDIA's `com.nvidia.simready.packaging.json` + `.metadata/LICENSE.txt` per asset (pinned nvidia revision) plus codepawl's `manifest.jsonl` row. A model ships only if all three say CC BY 4.0 (or CC0).
- `build-assets.ts`, per model and tier: drop decals and tiny parts → bake world transforms → keep 0 to 2 materials textured and bake the rest (texture × factor sampled per vertex) into vertex colours on shared untextured materials (painted / metal / film / emissive) → join per material and per moving part → simplify to the triangle budget (meshopt seam-aware, then permissive, then sloppy as fallbacks; baked meshes are welded by position and get crease-aware normals at 40°) → origin on the floor at the footprint centre → WebP textures (1024 max, 512 used, 256 low) → meshopt (`EXT_meshopt_compression` + quantization). At most 3 materials per model.
- `compose.ts`: the in-rack loads. The SimReady pallet assemblies crumple when decimated from 89k to 2k triangles (first contact sheet), so `pallet_loaded` / `pallet_wrapped` are composed from our pallet plus scaled 50-triangle cartons. Deterministic jitter, no `Math.random`.
- `build-worker.ts` + `fetch-quaternius.sh`: see the worker section.
- Helpers: `inspect.ts` (node tree, materials), `bounds.ts` (pick moving parts), `dump-textures.ts` (decal check), `montage.ts`.

Not used: KTX2. WebP keeps the decoder at 7.5 KB; the vertex-colour bake removed most textures anyway. Video memory
for the textured first tier is 27 textures at 512 px, about 36 MB with mipmaps, fine for phones.

## Licenses

- All 15 SimReady sources: `packaging.json` license `CC-BY-4.0`, `LICENSE.txt` is the CC BY 4.0 legal code ("Attribution 4.0 International"), codepawl row `CC-BY-4.0`. Checked by the pipeline on every build.
- Quaternius: `License_Standard.txt` (Universal Base Characters [Standard]) and `License.txt` (Universal Animation Library [Standard]) both say "CC0 1.0 Universal", no QAL. Checked by `build-worker.ts` on every build.
- Decals, viewed as PNG:
  - `vehicle_forklift_blue_c01` decal sheet: generic safety labels and dashboard icons, plus a faint "LESTAK LOGISTICS" watermark (I could not tell if it is a real company).
  - `vehicle_forklift_blue_a01`: generic WARNING / DANGER / CAUTION labels.
  - `conveyor_belt_a05`: an "A&M SYSTEMS" logo and a "GATES" belt-tension label (real-looking brand names).
  - All three decal materials are dropped by the pipeline, and every vehicle and conveyor texture is baked to vertex colours, so no printed text survives.
  - Pallet and carton textures: generic stamps ("SAFETY", "type 1", recycle mark). The pallet-assembly label sheet (CE, EAC, FRAGILE, barcodes) only feeds the hero pallets, where it is baked to vertex colours.
- `CREDITS.md` has the exact credit text from RESEARCH.md Part B §6, the per-model list with links and "modified" notes, and the Quaternius credit.

## Worker

- Downloaded the free ($0, "name your own price") Standard packs from Quaternius's official itch.io pages, which quaternius.com links to. No account was needed. `fetch-quaternius.sh` follows itch's "No thanks, just take me to the downloads" flow.
- UBC Standard only has the Superhero proportions (male and female). Regular and Teen are in the paid Source pack. I used Superhero Male.
- UBC and UAL share the same 65-bone rig, so rotation channels copy over by bone name, with pelvis translation scaled by the pelvis height ratio. The walk looks right in the preview.
- The skin texture is replaced by painted vertex colours (bone + height bands): hi-vis vest with two reflective bands, navy long sleeves, charcoal trousers, boots, gloves, white hard hat, skin on the face. One material, no textures, 139 KB gz with 3 clips.

## Visual judgment (contact sheet: `spikes/c-assets/out/contact-sheet.png`, local only)

Honest read, ours next to the An Xuan and Airsup frames:
- **Close to the references:** the rack bays of cartons on pallets. The composed loads (clean cardboard, tape, a neat grid) look a lot like both references, and are the biggest part of the frame. Pallets, conveyor, guard rail, dock gate and column look right.
- **Forklift:** the counterbalance reads well and its shape is crisp at 15k. The vertex-colour bake makes it look slightly flat and plasticky next to the textured cartons (no normal maps, no wear). The references show red/orange order pickers, while ours is blue. A red variant exists (`vehicle_forklift_red_c01`, same pipeline) if the lead wants a closer match.
- **AMR (code):** clean and plausible, fits the "clean product render" look of the references.
- **Autonomous stacker:** reads as a driverless stacker (mast, puck, blue spot). Fine.
- **Off: humanoid (code).** Blocky and toy-like: box head, capsule limbs, flat white. It is the weakest item next to SimReady realism. It needs more shaping (tapered torso panels, a rounder helmet head, visible actuators) or the Ralph / NORA option.
- **Somewhat off: worker.** At aisle distance it reads clearly as a warehouse worker in a hi-vis vest. Close up, the Superhero proportions (very muscular) and flat painted clothes look game-like, not photoreal. Good enough for overview and aisle cameras. For close follow-cam shots the Renderpeople option (needs Spiro's Sketchfab sign-in) would match better.
- **Tote:** the perforated SimReady crate still shows jagged holes after simplification. Fine at a distance; for totes in bulk the AMR's code-built tote is cleaner.
- **The biggest gap is not an asset:** the references are bright, with white walls, roof trusses, skylights and lots of bounce light. Our preview is a dark void with one key light. The same assets will look much closer once Track D adds the building shell, the ceiling and brighter, warmer lighting.

## Notes for the lead

- Screenshots came from headless Chromium against Vite on 5192. The renderer string is masked ("WebKit WebGL"), so no GPU or perf claims here. The preview scene is not instanced (365 draw calls, 202k triangles) and is not a perf test.
- Downloads beyond the codepawl revision:
  - I read NVIDIA's per-asset license files from `nvidia/simready-assets` (2 small text files per model, pinned revision), because codepawl doesn't carry them.
  - I downloaded the two Quaternius Standard zips from itch.io (the download channel quaternius.com links to).
  - Everything is in the gitignored `.cache/`, parsed only by gltf-transform / sharp / JSON, never executed.
- `public/assets/` is 2.6 MB raw, 34 files.

## Contract change requests

None. The `model` keys this sets up for `data/agents.json`:
- `forklift` (driver)
- `code:autonomous_forklift` (built from `stacker`)
- `code:amr`
- `code:humanoid`
- `worker` (picker)

## Open risks

- Humanoid look (above): the most likely visual-review fail.
- The worker's proportions and the Superhero-only Standard pack: if the reviewer wants realism, the Sketchfab / Renderpeople path needs Spiro.
- Vertex-colour vehicles have no normal maps. If the follow cam gets close, a small 256 px detail/normal texture per vehicle might be worth ~30 KB each.
- Skinned worker × 20 to 40 is untested for performance here (spike a's job).
- `pallet_wrapped` film is a simple open box at 24% opacity. It reads as "wrapped" only faintly. A subtle wrinkle normal map or a slightly whiter film would help.
