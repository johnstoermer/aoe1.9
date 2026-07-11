// Unit views: skinned KayKit characters driven by the shared animation
// library with crossfade blending, auto-fitted to gameplay scale, plus blob
// shadows, catapult special-casing, corpses, and projectile views.

import * as THREE from 'three';
import { COLOR_KEYS, PLAYER_COLORS, UNITS } from '../../shared/data';
import { toTiles } from '../../shared/fixed';
import type { Entity } from '../../shared/types';
import { applyTeamColor, getClip, instantiate, loadModel, ps1ify, type LoadedModel } from '../assets';
import { ARROW_MODEL, BOULDER_MODEL, UNIT_VISUALS } from '../visuals';

// Geometries and helper materials are shared across all unit views (units
// are created and destroyed constantly; per-view geometry would leak GPU
// buffers since three.js only frees them on explicit dispose()).
let blobShadowMat: THREE.MeshBasicMaterial | null = null;
let blobShadowGeo: THREE.CircleGeometry | null = null;
const pickGeoCache = new Map<string, THREE.CylinderGeometry>();
const pickMat = new THREE.MeshBasicMaterial();
pickMat.visible = false;

function makeBlobShadow(radius: number): THREE.Mesh {
  if (!blobShadowMat) {
    blobShadowMat = new THREE.MeshBasicMaterial({
      color: 0x1a2418, transparent: true, opacity: 0.34, depthWrite: false,
    });
    blobShadowGeo = new THREE.CircleGeometry(1, 12);
  }
  const m = new THREE.Mesh(blobShadowGeo!, blobShadowMat);
  m.scale.setScalar(radius);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.03;
  m.renderOrder = 2;
  return m;
}

function pickGeoFor(type: string, radius: number, height: number): THREE.CylinderGeometry {
  let g = pickGeoCache.get(type);
  if (!g) {
    g = new THREE.CylinderGeometry(radius, radius, height, 6);
    pickGeoCache.set(type, g);
  }
  return g;
}

/** Fit an object so its bounding height (or width) matches the target. */
export function fitTo(obj: THREE.Object3D, target: number, byHeight: boolean): number {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const current = byHeight ? size.y : Math.max(size.x, size.z);
  const s = current > 0.0001 ? target / current : 1;
  obj.scale.setScalar(s);
  return s;
}

/** Recenter a static model: bbox center on origin, base on the ground. */
export function centerOnGround(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x;
  obj.position.z -= c.z;
  obj.position.y -= box.min.y;
}

export function modelPathFor(type: string, owner: number, entId: number): string {
  const v = UNIT_VISUALS[type];
  return v.model
    .replace(/\{c\}/g, COLOR_KEYS[owner] ?? 'blue')
    .replace('{ab}', entId % 2 === 0 ? 'A' : 'B');
}

export class UnitView {
  readonly group = new THREE.Group();
  readonly pickMesh: THREE.Mesh;
  readonly type: string;
  readonly owner: number;
  mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentLoop = '';
  private oneShot: THREE.AnimationAction | null = null;
  private yawCurrent = 0;
  private yawOffset: number;
  private lastX = 0;
  private lastY = 0;
  /** wander phase for the catapult rock */
  private phase = Math.random() * Math.PI * 2;
  moving = false;
  dead = false;

  constructor(ent: Entity, model: LoadedModel) {
    const v = UNIT_VISUALS[ent.type];
    this.type = ent.type;
    this.owner = ent.owner;
    this.yawOffset = v.yaw;

    const obj = instantiate(model, v.rig);
    fitTo(obj, v.height, true);
    if (!v.rig) centerOnGround(obj);
    if (v.rig) applyTeamColor(obj, ent.type, ent.owner);
    this.group.add(obj);

    const r = toTiles(UNITS[ent.type as keyof typeof UNITS].radius);
    this.group.add(makeBlobShadow(r * 1.5));

    if (v.rig) {
      this.mixer = new THREE.AnimationMixer(obj);
      this.setLoop(v.anims.idle);
    }

    // invisible cylinder for mouse picking
    this.pickMesh = new THREE.Mesh(pickGeoFor(ent.type, Math.max(0.3, r * 1.5), v.height + 0.25), pickMat);
    this.pickMesh.position.y = v.height / 2;
    this.pickMesh.userData.entId = ent.id;
    this.group.add(this.pickMesh);

    this.lastX = toTiles(ent.x);
    this.lastY = toTiles(ent.y);
    this.group.position.set(this.lastX, 0, this.lastY);
  }

  private action(name: string): THREE.AnimationAction | null {
    if (!this.mixer) return null;
    let a = this.actions.get(name);
    if (!a) {
      const clip = getClip(name);
      if (!clip) return null;
      a = this.mixer.clipAction(clip);
      this.actions.set(name, a);
    }
    return a;
  }

  setLoop(name: string, fade = 0.16, timeScale = 1) {
    if (!this.mixer || this.currentLoop === name) {
      const cur = this.action(name);
      if (cur) cur.timeScale = timeScale;
      return;
    }
    const next = this.action(name);
    if (!next) return;
    const prev = this.currentLoop ? this.action(this.currentLoop) : null;
    this.currentLoop = name;
    next.reset();
    next.timeScale = timeScale;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.enabled = true;
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    else next.fadeIn(fade);
    next.play();
  }

  /** Play a clip once (attack swing, chop, hammer), then resume the loop. */
  playOnce(name: string, duration?: number) {
    const a = this.action(name);
    if (!a || !this.mixer) return;
    if (this.oneShot === a && a.isRunning()) return;
    const clip = a.getClip();
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = duration ? clip.duration / duration : 1;
    const loop = this.currentLoop ? this.action(this.currentLoop) : null;
    if (loop) loop.setEffectiveWeight(0.15);
    a.fadeIn(0.06);
    a.play();
    this.oneShot = a;
    const onDone = (e: { action: THREE.AnimationAction }) => {
      if (e.action !== a) return;
      this.mixer!.removeEventListener('finished', onDone);
      if (this.dead) return; // death pose owns the rig now
      a.fadeOut(0.14);
      // only restore if a newer one-shot hasn't taken over
      if (this.oneShot === a) {
        if (loop && this.currentLoop === loop.getClip().name) loop.setEffectiveWeight(1);
        this.oneShot = null;
      }
    };
    this.mixer.addEventListener('finished', onDone);
  }

  /** True while a one-shot (attack/gather swing) is playing. */
  busy(): boolean {
    return this.oneShot !== null && this.oneShot.isRunning();
  }

  playDeath() {
    this.dead = true;
    this.oneShot = null;
    if (!this.mixer) {
      // catapult: tip over
      return;
    }
    const v = UNIT_VISUALS[this.type];
    for (const a of this.actions.values()) a.fadeOut(0.08);
    const death = this.action(v.anims.death);
    if (death) {
      death.reset();
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
      death.fadeIn(0.05);
      death.play();
    }
  }

  /** Called each render frame with interpolated sim position (tiles). */
  update(dt: number, x: number, y: number, facingX: number, facingY: number) {
    this.group.position.set(x, 0, y);
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
    this.moving = speed > 0.12;
    this.lastX = x;
    this.lastY = y;

    let want = this.yawCurrent;
    if (this.moving) want = Math.atan2(dx, dy);
    else if (facingX !== 0 || facingY !== 0) want = Math.atan2(facingX, facingY);
    let d = want - this.yawCurrent;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yawCurrent += d * Math.min(1, dt * 11);
    this.group.rotation.y = this.yawCurrent + this.yawOffset;

    if (!this.mixer && this.type === 'catapult') {
      // roll-rock while moving
      this.phase += dt * (this.moving ? 9 : 0);
      this.group.rotation.z = this.moving ? Math.sin(this.phase) * 0.04 : 0;
      if (this.dead) {
        this.group.rotation.z = Math.min(1.1, this.group.rotation.z + dt * 3);
        this.group.position.y = Math.max(-0.3, this.group.position.y - dt * 0.3);
      }
    }
    this.mixer?.update(dt);
  }
}

// ---------------------------------------------------------------------------

export class ProjectileView {
  readonly group = new THREE.Group();
  private inner: THREE.Object3D;
  readonly isBoulder: boolean;
  private arcH: number;
  smokeTimer = 0;

  constructor(ent: Entity, model: LoadedModel) {
    this.isBoulder = ent.type === 'boulder';
    this.inner = instantiate(model, false);
    fitTo(this.inner, this.isBoulder ? 0.34 : 0.5, false);
    this.group.add(this.inner);
    const dist = Math.hypot(ent.orderX - ent.srcX, ent.orderY - ent.srcY) / 256;
    this.arcH = this.isBoulder ? Math.min(3.4, dist * 0.42) : Math.min(1.6, dist * 0.18);
  }

  update(ent: Entity, alpha: number, prevX: number, prevY: number) {
    const x = prevX + (toTiles(ent.x) - prevX) * alpha;
    const y = prevY + (toTiles(ent.y) - prevY) * alpha;
    const t = Math.min(1, (ent.projT + alpha) / Math.max(1, ent.projDur));
    const h = 0.6 + 4 * this.arcH * t * (1 - t);
    this.group.position.set(x, h, y);
    // face along the velocity (incl. vertical arc slope)
    const dxdt = toTiles(ent.orderX - ent.srcX);
    const dydt = toTiles(ent.orderY - ent.srcY);
    const dhdt = 4 * this.arcH * (1 - 2 * t);
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y = Math.atan2(dxdt, dydt);
    const horiz = Math.hypot(dxdt, dydt);
    this.group.rotation.x = -Math.atan2(dhdt, Math.max(0.001, horiz));
    if (this.isBoulder) this.inner.rotation.x -= 0.3;
  }
}

export async function loadUnitModel(type: string, owner: number, entId: number): Promise<LoadedModel> {
  return loadModel(modelPathFor(type, owner, entId));
}

/** `color` is the player color index (not the player index). */
export async function loadProjectileModel(type: string, color: number): Promise<LoadedModel> {
  if (type === 'boulder') return loadModel(BOULDER_MODEL);
  return loadModel(ARROW_MODEL(Math.max(0, color)));
}

/** Fallback capsule so a missing model never crashes the game. */
export function fallbackModel(color = 0x8844aa): LoadedModel {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  ps1ify(mat);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.4, 2, 6), mat);
  mesh.position.y = 0.4;
  g.add(mesh);
  return { scene: g, animations: [] };
}

export function playerColorHex(player: number): number {
  return PLAYER_COLORS[player]?.hex ?? 0xdddddd;
}
