// Resource nodes and decoration, all instanced: hundreds of trees in a
// handful of draw calls. Nodes map to instance slots; depleting a node frees
// its slot and drops a remnant (stump / rock chunks) in its place.

import * as THREE from 'three';
import type { GameMap } from '../../shared/map';
import { Prng } from '../../shared/prng';
import type { Entity } from '../../shared/types';
import { loadModel, type LoadedModel } from '../assets';
import { DOODAD_MODELS } from '../visuals';

interface InstanceRef {
  mesh: THREE.InstancedMesh;
  slot: number;
}

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Extract the first mesh (geometry+material) from a loaded model, baking
 *  the mesh's own transform into the geometry. */
function meshOf(model: LoadedModel): { geo: THREE.BufferGeometry; mat: THREE.Material } {
  let found: THREE.Mesh | null = null;
  model.scene.updateMatrixWorld(true);
  model.scene.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  if (!found) throw new Error('model has no mesh');
  const m = found as THREE.Mesh;
  const geo = m.geometry.clone();
  geo.applyMatrix4(m.matrixWorld);
  // normalize: base at y=0, centered in x/z
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -bb.min.y, -cz);
  geo.computeBoundingBox();
  return { geo, mat: Array.isArray(m.material) ? m.material[0] : m.material };
}

class InstancePool {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private top = 0;
  /** world size the geometry is scaled to (max horizontal extent). */
  private baseScale: number;

  constructor(model: LoadedModel, capacity: number, targetSize: number, tint?: THREE.Color) {
    const { geo, mat } = meshOf(model);
    const bb = geo.boundingBox!;
    const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 0.001);
    this.baseScale = targetSize / w;
    const material = tint ? (() => {
      const c = (mat as THREE.MeshLambertMaterial).clone();
      c.color.multiply(tint);
      return c;
    })() : mat;
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  add(x: number, y: number, rot: number, scaleJitter: number): number {
    const slot = this.free.pop() ?? this.top++;
    if (slot >= this.mesh.instanceMatrix.count) return -1;
    const s = this.baseScale * scaleJitter;
    tmpQuat.setFromAxisAngle(Y_AXIS, rot);
    tmpMat.compose(tmpPos.set(x, 0, y), tmpQuat, tmpScale.set(s, s, s));
    this.mesh.setMatrixAt(slot, tmpMat);
    this.mesh.count = Math.max(this.mesh.count, slot + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    return slot;
  }

  remove(slot: number) {
    tmpMat.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(slot, tmpMat);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(slot);
  }
}

export class Doodads {
  readonly group = new THREE.Group();
  private pools = new Map<string, InstancePool>();
  private byEntity = new Map<number, InstanceRef[]>();
  private models = new Map<string, LoadedModel>();

  static async load(): Promise<Doodads> {
    const d = new Doodads();
    const jobs: Promise<void>[] = [];
    for (const [key, paths] of Object.entries(DOODAD_MODELS)) {
      paths.forEach((p, i) => {
        jobs.push(loadModel(p).then((m) => { d.models.set(`${key}${i}`, m); }));
      });
    }
    await Promise.all(jobs);
    return d;
  }

  /** Create pools sized for this map and scatter decorative grass. */
  init(map: GameMap, nodeCount: (type: string) => number) {
    const mk = (key: string, model: string, capacity: number, size: number, tint?: number) => {
      if (capacity <= 0) return;
      const pool = new InstancePool(this.models.get(model)!, capacity, size, tint !== undefined ? new THREE.Color(tint) : undefined);
      this.pools.set(key, pool);
      this.group.add(pool.mesh);
    };
    const trees = nodeCount('tree') + 8;
    mk('tree0', 'tree0', Math.ceil(trees * 0.6), 1.15);
    mk('tree1', 'tree1', Math.ceil(trees * 0.6), 1.05);
    mk('stump0', 'stump0', Math.ceil(trees * 0.7), 0.5);
    mk('stump1', 'stump1', Math.ceil(trees * 0.7), 0.48);
    const gold = nodeCount('gold') + 4;
    mk('goldRock', 'goldRock0', gold, 0.95);
    mk('goldNug', 'gold0', gold * 2, 0.55);
    const stone = nodeCount('stone') + 4;
    mk('stone0', 'stone0', stone, 0.9);
    mk('stone1', 'stone1', stone, 0.9);
    mk('stoneRemnant', 'stone2', stone + gold, 0.55);
    const berries = nodeCount('berries') + 4;
    mk('bush0', 'berries0', berries, 0.85);
    mk('berryDots', 'gold0', berries, 0.4, 0xe83050); // tinted nugget cluster reads as berries
    // decorative grass tufts
    const rng = new Prng(1234577);
    const tufts = Math.floor(map.size * map.size / 9);
    mk('grass0', 'grass0', tufts, 0.5);
    mk('grass1', 'grass1', tufts, 0.55);
    const blocked = new Set(map.nodes.map((n) => n.ty * map.size + n.tx));
    for (let i = 0; i < tufts; i++) {
      const x = rng.range(1, map.size - 2);
      const y = rng.range(1, map.size - 2);
      if (blocked.has(y * map.size + x)) continue;
      const pool = this.pools.get(rng.int(2) === 0 ? 'grass0' : 'grass1')!;
      pool.add(x + rng.int(100) / 100, y + rng.int(100) / 100, rng.int(100) / 16, 0.7 + rng.int(60) / 100);
    }
  }

  addNode(ent: Entity) {
    const refs: InstanceRef[] = [];
    const rot = ((ent.id * 137) % 100) / 100 * Math.PI * 2;
    const jitter = 0.88 + ((ent.id * 61) % 30) / 100;
    const x = ent.tileX + 0.5;
    const y = ent.tileY + 0.5;
    const use = (key: string, size = 1, dx = 0, dy = 0) => {
      const pool = this.pools.get(key);
      if (!pool) return;
      const slot = pool.add(x + dx, y + dy, rot, jitter * size);
      if (slot >= 0) refs.push({ mesh: pool.mesh, slot });
      (refs[refs.length - 1] as InstanceRef & { key?: string }).key = key;
    };
    switch (ent.type) {
      case 'tree':
        use(ent.id % 2 === 0 ? 'tree0' : 'tree1');
        break;
      case 'gold':
        use('goldRock');
        use('goldNug', 1, 0.12, 0.1);
        break;
      case 'stone':
        use(ent.id % 2 === 0 ? 'stone0' : 'stone1');
        break;
      case 'berries':
        use('bush0');
        use('berryDots', 1, 0.05, -0.04);
        break;
    }
    this.byEntity.set(ent.id, refs);
  }

  /** Node depleted: free instances, optionally leaving a remnant. */
  removeNode(entId: number, entType: string, tileX: number, tileY: number) {
    const refs = this.byEntity.get(entId);
    if (refs) {
      for (const r of refs) {
        for (const [key, pool] of this.pools) {
          if (pool.mesh === r.mesh) {
            pool.remove(r.slot);
            void key;
            break;
          }
        }
      }
      this.byEntity.delete(entId);
    }
    const rot = ((entId * 89) % 100) / 100 * Math.PI * 2;
    if (entType === 'tree') {
      this.pools.get(entId % 2 === 0 ? 'stump0' : 'stump1')?.add(tileX + 0.5, tileY + 0.5, rot, 1);
    } else if (entType === 'gold' || entType === 'stone') {
      this.pools.get('stoneRemnant')?.add(tileX + 0.5, tileY + 0.5, rot, 1);
    }
  }
}
