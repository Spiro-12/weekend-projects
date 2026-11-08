// The SimReady shortlist (RESEARCH.md Part B §7) and how each model is processed.
// Every model comes from ONE pinned revision of codepawl/simready-glb (`glb/` tier: full triangles, 1024 px WebP),
// and its license is checked against NVIDIA's per-asset packaging file at a pinned revision of nvidia/simready-assets.

export const CODEPAWL_REV = '3be2abd90406285b34f868907290aa4992dece7b';
export const NVIDIA_REV = '7879e0e50423290300ac20ecd6e727325f680b60';
export const codepawlUrl = (path: string) =>
  `https://huggingface.co/datasets/codepawl/simready-glb/resolve/${CODEPAWL_REV}/${path}`;
export const nvidiaUrl = (path: string) =>
  `https://huggingface.co/datasets/nvidia/simready-assets/resolve/${NVIDIA_REV}/${path}`;
export const nvidiaPage = (asset: string) => `https://huggingface.co/datasets/nvidia/simready-assets/tree/main/${asset}`;

export interface TierSpec {
  /** Triangle budget for the whole model. */
  tris: number;
  /** Max texture edge (px) for textures that are kept. */
  tex: number;
  /** Keep normal maps (default: hi yes, lo no). */
  normals?: boolean;
}

export interface AssetSpec {
  /** Model key in public/assets/manifest.json and the output file name. */
  key: string;
  /** Asset folder name in the dataset. */
  src: string;
  /** What it is, for the credits and the preview. */
  label: string;
  firstTier: boolean;
  hi: TierSpec;
  /** Low tier (phones, far LOD, in-rack). Writes `<key>-lo.glb`. */
  lo?: TierSpec;
  /**
   * Materials (by name) that keep their textures. All others are baked into vertex colours on shared untextured
   * materials (painted / metal / film / emissive). Default: all if the model has ≤ 3 materials, else none.
   */
  keep?: RegExp;
  /** Drop nodes whose name (or mesh or material name) matches: decals, tiny hardware, hanging rods. */
  drop?: RegExp;
  /** Drop parts whose bounding-box diagonal is below this (metres). */
  minPart?: number;
  /** Moving parts kept as separate named nodes (node name or any ancestor name matches). Everything else is `body`. */
  parts?: Record<string, RegExp>;
  /** Materials that become cheap see-through film (shrink wrap) instead of KHR_materials_transmission. */
  film?: RegExp;
  /** Materials that stay emissive (light panels). */
  emissive?: RegExp;
  note?: string;
}

export const SHORTLIST: AssetSpec[] = [
  // ── Pallets and loads ──
  { key: 'pallet', src: 'pallet_a01', label: 'Wooden EUR pallet', firstTier: true,
    hi: { tris: 300, tex: 512 }, lo: { tris: 120, tex: 256 } },
  // The SimReady assemblies crumple when decimated to rack budgets, so in-rack loads are composed from the pallet
  // and cartons (compose.ts: pallet_loaded, pallet_wrapped). These are close-up hero versions, lazy-loaded.
  { key: 'pallet_loaded_hero', src: 'pallet_assembly_a05', label: 'Pallet of strapped cartons (close-up)', firstTier: false,
    hi: { tris: 12000, tex: 512 }, keep: /cardboard__brown|wood__recycled/ },
  { key: 'pallet_wrapped_hero', src: 'pallet_assembly_transparent_a02', label: 'Shrink-wrapped pallet (close-up)', firstTier: false,
    hi: { tris: 12000, tex: 512 }, keep: /cardboard__brown/, film: /wrap|film|plastic|transparent|foil/i },
  // ── Cartons and totes ──
  { key: 'carton_a', src: 'box_cardboard_a01', label: 'Carton 70 x 51 x 52 cm', firstTier: true,
    hi: { tris: 300, tex: 512 }, lo: { tris: 50, tex: 256 } },
  { key: 'carton_b', src: 'box_cardboard_b01', label: 'Cube carton 51 cm', firstTier: true,
    hi: { tris: 300, tex: 512 }, lo: { tris: 56, tex: 256 } }, // seam-aware stops at 56; 50 needs seam collapse, which skews it
  { key: 'carton_c', src: 'box_cardboard_c01', label: 'Flat carton 51 x 26 x 51 cm', firstTier: true,
    hi: { tris: 300, tex: 512 }, lo: { tris: 50, tex: 256 } },
  { key: 'tote', src: 'crate_blue_a08', label: 'Plastic tote', firstTier: true,
    hi: { tris: 2000, tex: 512 }, lo: { tris: 300, tex: 256 }, keep: /^$/,
    note: 'baked to vertex colour: the perforated walls tear when simplified with UV seams' },
  // ── Stations ──
  { key: 'conveyor', src: 'conveyor_belt_a05', label: 'Roller conveyor section', firstTier: true,
    hi: { tris: 8000, tex: 512 }, lo: { tris: 2000, tex: 256 }, keep: /^$/, minPart: 0.02, drop: /decal/i },
  { key: 'pack_table', src: 'table_packing_heavyduty_c01', label: 'Heavy-duty packing table', firstTier: true,
    hi: { tris: 3000, tex: 512 }, lo: { tris: 800, tex: 256 }, keep: /^$/ },
  // ── Vehicles ──
  { key: 'forklift', src: 'vehicle_forklift_blue_c01', label: 'Counterbalance forklift (driven)', firstTier: true,
    hi: { tris: 15000, tex: 512 }, lo: { tris: 4000, tex: 256 }, keep: /^$/, minPart: 0.03,
    drop: /decal/i, parts: { forks: /fork[12]_c01/, carriage: /mast_stage[34]_c01/, mast: /mast_stage2_c01/ },
    note: 'forks + carriage lift together; mast = inner upright (extends for high lifts).' },
  { key: 'stacker', src: 'vehicle_forklift_blue_a01', label: 'Walk-behind pallet stacker (autonomous base)', firstTier: true,
    hi: { tris: 12000, tex: 512 }, lo: { tris: 3500, tex: 256 }, keep: /^$/, minPart: 0.02,
    drop: /decal/i, parts: { forks: /sm_fork_a01|forkwheels/, tiller: /rudder_a01|handle_a01|button\d_a01/ },
    note: 'forks lift on their own; tiller is a separate node so the autonomous version can hide it.' },
  // ── Building and safety ──
  { key: 'dock_gate', src: 'barrier_gate_safetyDock_a02', label: 'Dock safety gate', firstTier: true,
    hi: { tris: 3000, tex: 512 }, lo: { tris: 800, tex: 256 }, keep: /^$/ },
  { key: 'guard_rail', src: 'rail_guard_a09', label: 'Steel guard rail', firstTier: true,
    hi: { tris: 1500, tex: 512 }, lo: { tris: 400, tex: 256 }, keep: /^$/ },
  { key: 'light_panel', src: 'lighting_overheadLed_lightPanel_a01', label: 'High-bay LED light panel', firstTier: true,
    hi: { tris: 2000, tex: 512 }, lo: { tris: 600, tex: 256 }, keep: /^$/, emissive: /.*/ },
  { key: 'column', src: 'structure_wall_column_a01', label: 'Building column', firstTier: true,
    hi: { tris: 1000, tex: 512 }, lo: { tris: 300, tex: 256 }, keep: /concrete/ },
];
