# Credits

## 3D models

3D models from **NVIDIA SimReady Assets** by NVIDIA Corporation (https://huggingface.co/datasets/nvidia/simready-assets), licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Web conversions from **SimReady GLB** by codepawl (https://huggingface.co/datasets/codepawl/simready-glb), CC BY 4.0. **Modified** for Fleet Planner: re-compressed, simplified, textures resized and re-encoded, pivots and materials adjusted. Provided "as is" without warranties, see the license. NVIDIA and SimReady are trademarks of NVIDIA Corporation; Fleet Planner is not affiliated with or endorsed by NVIDIA.

Models used (source revision: codepawl/simready-glb `3be2abd90406285b34f868907290aa4992dece7b`, `glb/` tier; license checked against nvidia/simready-assets `7879e0e50423290300ac20ecd6e727325f680b60`):

| In the app | Source model | Changes |
|---|---|---|
| `pallet` | [pallet_a01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/pallet_a01) | simplified to 300 / 120 triangles, textures 512 / 256 px WebP, origin moved to the floor |
| `carton_a` | [box_cardboard_a01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/box_cardboard_a01) | simplified, textures resized, origin moved |
| `carton_b` | [box_cardboard_b01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/box_cardboard_b01) | simplified, textures resized, origin moved |
| `carton_c` | [box_cardboard_c01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/box_cardboard_c01) | simplified, textures resized, origin moved |
| `pallet_loaded` | pallet_a01 + box_cardboard_a01 | composed: a pallet with 18 scaled cartons |
| `pallet_wrapped` | pallet_a01 + box_cardboard_c01 | composed: a pallet with 24 scaled cartons and a see-through stretch-film box |
| `pallet_loaded_hero` | [pallet_assembly_a05](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/pallet_assembly_a05) | simplified, label and strap materials baked to vertex colours, textures resized |
| `pallet_wrapped_hero` | [pallet_assembly_transparent_a02](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/pallet_assembly_transparent_a02) | simplified, transmission film replaced by a plain see-through material, baked materials |
| `tote` | [crate_blue_a08](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/crate_blue_a08) | simplified, texture baked to vertex colours |
| `conveyor` | [conveyor_belt_a05](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/conveyor_belt_a05) | simplified, rollers merged, decal labels removed, textures baked to vertex colours |
| `pack_table` | [table_packing_heavyduty_c01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/table_packing_heavyduty_c01) | simplified, textures baked to vertex colours |
| `forklift` | [vehicle_forklift_blue_c01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/vehicle_forklift_blue_c01) | simplified, decals removed, small parts dropped, parts merged into body / forks / carriage / mast, textures baked to vertex colours |
| `stacker` (and the autonomous forklift built on it) | [vehicle_forklift_blue_a01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/vehicle_forklift_blue_a01) | simplified, decals removed, parts merged into body / forks / tiller, textures baked to vertex colours; the autonomous version hides the tiller and adds a sensor mast and lights |
| `dock_gate` | [barrier_gate_safetyDock_a02](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/barrier_gate_safetyDock_a02) | simplified, textures baked to vertex colours |
| `guard_rail` | [rail_guard_a09](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/rail_guard_a09) | simplified, textures baked to vertex colours |
| `light_panel` | [lighting_overheadLed_lightPanel_a01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/lighting_overheadLed_lightPanel_a01) | simplified, textures baked to vertex colours, emissive kept |
| `column` | [structure_wall_column_a01](https://huggingface.co/datasets/nvidia/simready-assets/tree/main/structure_wall_column_a01) | simplified, textures resized |

## Characters

`worker`: "Universal Base Characters" (Superhero Male body) and "Universal Animation Library" (walk, idle and push clips) by **Quaternius** (https://quaternius.com), **CC0 1.0** (https://creativecommons.org/publicdomain/zero/1.0/). No credit is required; we give it anyway. Modified: skin texture replaced by painted work clothes (hi-vis vest with reflective bands, navy shirt, trousers, boots, gloves, white hard hat), animations copied onto the body by bone name, re-compressed.

## Built in code

The cart robot (AMR), the humanoid robot and the autonomous-forklift sensor kit are our own geometry (`src/render/models/`), with no third-party assets or brands.

The building (walls, windows, dock doors, trailers, steel columns and roof trusses), the pallet racking, the far-field rack loads, the floor markings, the chargers and the wall signs are generated in code (`src/render/world/`), with textures painted on canvases at load time. No third-party assets.

## Where the credits show

The app's "i" button (bottom-left on desktop, top-right on phones) opens **About & credits**, which shows the NVIDIA line above word for word, every shipped model's credit from `public/assets/manifest.json`, the Quaternius line and the license links (`src/ui/panels/about.tsx`). An e2e test (`tests/e2e/world-credits.spec.ts`) checks that every manifest model appears there and in this file.
