// Building views: construction phases (dirt plot → framing → scaffolding →
// final colored model), damage smoke/fire anchors, rally flags, rubble.

import * as THREE from 'three';
import { BUILDINGS, totalBuildTicks } from '../../shared/data';
import type { BuildingTypeId, Entity } from '../../shared/types';
import { instantiate, loadModel, type LoadedModel } from '../assets';
import { BUILDING_VISUALS, CONSTRUCTION_MODELS, FLAG_MODEL, RUBBLE_MODEL } from '../visuals';
import { COLOR_KEYS } from '../../shared/data';
import { centerOnGround, fitTo } from './units';

export function buildingModelPath(type: string, owner: number): string {
  const v = BUILDING_VISUALS[type];
  return v.model.replace(/\{c\}/g, COLOR_KEYS[owner] ?? 'blue');
}

export class BuildingView {
  readonly group = new THREE.Group();
  readonly pickMesh: THREE.Mesh;
  readonly type: string;
  readonly owner: number;
  private phases: THREE.Object3D[] = [];
  private final: THREE.Object3D;
  private flag: THREE.Object3D | null = null;
  private stage = -1;
  readonly w: number;
  readonly h: number;
  /** particle anchor points for damage smoke/fire */
  readonly smokeSpots: { x: number; z: number; h: number }[] = [];

  constructor(ent: Entity, finalModel: LoadedModel, phaseModels: LoadedModel[], flagModel: LoadedModel | null) {
    const data = BUILDINGS[ent.type as BuildingTypeId];
    const v = BUILDING_VISUALS[ent.type];
    this.type = ent.type;
    this.owner = ent.owner;
    this.w = data.w;
    this.h = data.h;
    const footprint = Math.min(data.w, data.h) * v.fit;

    this.final = instantiate(finalModel, false);
    const finalWrap = new THREE.Group();
    finalWrap.add(this.final);
    fitTo(this.final, footprint, false);
    centerOnGround(this.final);
    finalWrap.rotation.y = v.yaw + (((ent.id * 7) % 4) * Math.PI) / 2 * (ent.type === 'farm' || ent.type === 'house' ? 1 : 0);
    this.group.add(finalWrap);
    this.final = finalWrap;

    for (const pm of phaseModels) {
      const inner = instantiate(pm, false);
      fitTo(inner, Math.min(data.w, data.h) * 0.92, false);
      centerOnGround(inner);
      const o = new THREE.Group();
      o.add(inner);
      o.visible = false;
      this.group.add(o);
      this.phases.push(o);
    }

    if (flagModel && data.attack === undefined && ent.type !== 'farm') {
      // small team flag on production/economy buildings
      const inner = instantiate(flagModel, false);
      fitTo(inner, 0.72, true);
      centerOnGround(inner);
      this.flag = new THREE.Group();
      this.flag.add(inner);
      this.flag.position.set(-data.w * 0.34, 0, -data.h * 0.34);
      this.group.add(this.flag);
    }

    const box = new THREE.Box3().setFromObject(this.final);
    const height = Math.max(0.5, box.max.y);
    const pickGeo = new THREE.BoxGeometry(data.w * 0.94, height, data.h * 0.94);
    const pickMat = new THREE.MeshBasicMaterial();
    pickMat.visible = false;
    this.pickMesh = new THREE.Mesh(pickGeo, pickMat);
    this.pickMesh.position.y = height / 2;
    this.pickMesh.userData.entId = ent.id;
    this.group.add(this.pickMesh);

    // deterministic smoke anchor spots inside the footprint
    for (let i = 0; i < Math.max(2, data.w); i++) {
      const a = (ent.id * 37 + i * 97) % 100 / 100;
      const b = (ent.id * 53 + i * 71) % 100 / 100;
      this.smokeSpots.push({
        x: (a - 0.5) * data.w * 0.6,
        z: (b - 0.5) * data.h * 0.6,
        h: height * (0.45 + 0.4 * ((i * 29) % 10) / 10),
      });
    }

    this.group.position.set(ent.tileX + data.w / 2, 0, ent.tileY + data.h / 2);
    this.setProgress(ent, true);
  }

  /** Swap visible model by construction progress. */
  setProgress(ent: Entity, force = false) {
    const total = totalBuildTicks(ent.type as BuildingTypeId);
    const pct = ent.buildProgress / total;
    const stage = pct >= 1 ? 3 : pct > 0.7 ? 2 : pct > 0.35 ? 1 : 0;
    if (stage === this.stage && !force) return;
    this.stage = stage;
    this.final.visible = stage === 3;
    if (this.flag) this.flag.visible = stage === 3;
    this.phases.forEach((p, i) => { p.visible = stage < 3 && i === Math.min(stage, this.phases.length - 1); });
  }
}

export class RubbleView {
  readonly group = new THREE.Group();
  life = 26;

  constructor(model: LoadedModel, x: number, y: number, w: number) {
    const o = instantiate(model, false);
    fitTo(o, Math.max(1.4, w * 0.95), false);
    centerOnGround(o);
    this.group.add(o);
    this.group.position.set(x, 0, y);
    this.group.rotation.y = (x * 31 + y * 17) % 6;
  }

  /** Returns false when fully faded. */
  update(dt: number): boolean {
    this.life -= dt;
    if (this.life < 4) {
      this.group.position.y = -(4 - this.life) * 0.12;
    }
    return this.life > 0;
  }
}

export async function loadBuildingModels(type: string, owner: number) {
  const [finalModel, ...phases] = await Promise.all([
    loadModel(buildingModelPath(type, owner)),
    ...CONSTRUCTION_MODELS.map((p) => loadModel(p)),
  ]);
  const flag = type === 'farm' ? null : await loadModel(FLAG_MODEL(owner)).catch(() => null);
  return { finalModel, phases, flag };
}

export async function loadRubbleModel(): Promise<LoadedModel> {
  return loadModel(RUBBLE_MODEL);
}
