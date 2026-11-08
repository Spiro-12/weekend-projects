// Layer interfaces (lead-owned, PROTOCOL §9). Track D implements WorldLayer in src/render/world/index.ts and Track E
// implements AgentLayer in src/render/agents/index.ts; main.ts only talks to these interfaces.
import type { Camera, Group, Raycaster, Vector3 } from 'three';
import type { LayoutFile, Snapshot } from '../../contracts/types.ts';
import type { Tier } from '../../host/index.ts';
import type { RendererCore } from './renderer.ts';

export interface WorldLayer {
  group: Group;
  /** Building size in metres (x across, z along rows). */
  sizeX: number;
  sizeZ: number;
  /** Resolves when the full first-tier look (GLB models) has replaced the procedural first view. */
  fullLook: Promise<void>;
  setTier(t: Tier): void;
  /** Per-frame hook (animated conveyors, lights). */
  update?(dtMs: number, nowMs: number): void;
  dispose(): void;
}

export interface WorldLayerOptions {
  layout: LayoutFile;
  tier: Tier;
  core: RendererCore;
  /** Base URL for public/ assets (import.meta.env.BASE_URL). */
  baseUrl: string;
}

export interface AgentLayer {
  group: Group;
  /** Interpolate every agent to `renderTick` and update instances, effects and labels. */
  update(snap: Snapshot, renderTick: number, selectedId: number | null, dtMs: number): void;
  positionOf(id: number): Vector3 | null;
  /** Position and smoothed yaw, for the follow camera. */
  followTarget(id: number): { pos: Vector3; yaw: number } | null;
  /** Agent id under the ray, or null. */
  pick(ray: Raycaster): number | null;
  /** Screen position (CSS px in the canvas) of an agent, or null. */
  project(id: number, camera: Camera, w: number, h: number): { x: number; y: number } | null;
  count(): number;
  setTier(t: Tier): void;
  dispose(): void;
}

export interface AgentLayerOptions {
  layout: LayoutFile;
  tier: Tier;
  core: RendererCore;
  baseUrl: string;
}
