// People option (i): skinned stand-in (three's RobotExpressive, CC0), cloned with SkeletonUtils, one mixer each.
// Loaded lazily (GLTFLoader + SkeletonUtils are a separate chunk). Cost: 19 primitives per clone = 19 draw calls.
import { AnimationMixer, Box3, Group, Vector3, type AnimationAction, type AnimationClip, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Walker } from './walkers.ts';

export interface SkinnedSource {
  scene: Object3D;
  walk: AnimationClip;
  scale: number;
}

export async function loadSkinnedSource(url: string): Promise<SkinnedSource> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const walk = gltf.animations.find((a) => a.name === 'Walking') ?? gltf.animations[0];
  const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3());
  return { scene: gltf.scene, walk, scale: 1.75 / size.y };
}

export class PeopleSkinned {
  readonly group = new Group();
  private clones: Object3D[] = [];
  private mixers: AnimationMixer[] = [];
  private actions: AnimationAction[] = [];

  constructor(
    private people: Walker[],
    src: SkinnedSource,
    castShadow: boolean,
  ) {
    for (let i = 0; i < people.length; i++) {
      const c = clone(src.scene);
      c.scale.setScalar(src.scale);
      c.traverse((o) => {
        o.castShadow = castShadow;
        o.frustumCulled = false;
      });
      const mixer = new AnimationMixer(c);
      const action = mixer.clipAction(src.walk);
      action.play();
      action.time = (i * 0.37) % src.walk.duration;
      this.group.add(c);
      this.clones.push(c);
      this.mixers.push(mixer);
      this.actions.push(action);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      const c = this.clones[i];
      c.position.set(p.x, 0, p.z);
      c.rotation.y = p.yaw + Math.PI / 2; // the model faces +z; our agents face +x
      this.actions[i].timeScale = p.moving ? 1 : 0;
      this.mixers[i].update(dt);
    }
  }
}
