// GameClient: owns the World, steps it from a Transport's frames, keeps the
// 3D views in sync (with render-side interpolation), translates sim events
// into particles/audio/alerts, and executes player intent (selection,
// commands, building placement) by sending commands back through the
// transport. Works identically for single-player and multiplayer.

import * as THREE from 'three';
import { AGE_NAMES, BUILDINGS, PLAYER_COLORS, TECHS, UNITS, isBuildingType, totalBuildTicks } from '../shared/data';
import { FP, FP_BITS, fp, toTiles } from '../shared/fixed';
import { HASH_PERIOD } from '../shared/protocol';
import { World } from '../shared/sim';
import type { BuildingTypeId, Command, Entity, GameSetup, SimEvent, TechId, UnitTypeId } from '../shared/types';
import { TICK_MS, TICK_RATE } from '../shared/types';
import { audio } from './audio';
import { loadAnimationLibrary, loadModel } from './assets';
import { BuildingView, RubbleView, loadBuildingModels, loadRubbleModel } from './render/buildings';
import { Doodads } from './render/doodads';
import { Particles, SelectionRings } from './render/effects';
import { GameRenderer } from './render/renderer';
import { PlacementGhost, Terrain } from './render/terrain';
import {
  ProjectileView, UnitView, fallbackModel, loadProjectileModel, loadUnitModel, playerColorHex,
} from './render/units';
import type { Transport } from './transport';
import { buildingModelPath } from './render/buildings';
import { CONSTRUCTION_MODELS, UNIT_VISUALS } from './visuals';

export interface GameCallbacks {
  onSelectionChange(): void;
  onToast(text: string, warn?: boolean): void;
  onGameOver(winner: number): void;
  onPlayerUpdate(): void;
  onDesync?(): void;
}

interface Corpse {
  view: UnitView;
  t: number;
}

export class GameClient {
  readonly world: World;
  readonly you: number;
  readonly renderer: GameRenderer;
  readonly transport: Transport;
  readonly cb: GameCallbacks;

  readonly selection = new Set<number>();
  private groups = new Map<number, number[]>();

  private terrain!: Terrain;
  private doodads!: Doodads;
  private particles = new Particles();
  private rings = new SelectionRings();
  private ghost = new PlacementGhost();
  private raycaster = new THREE.Raycaster();

  private unitViews = new Map<number, UnitView>();
  private buildingViews = new Map<number, BuildingView>();
  private projViews = new Map<number, ProjectileView>();
  private corpses: Corpse[] = [];
  private rubble: RubbleView[] = [];
  private prevPos = new Map<number, { x: number; y: number }>();

  private overlay: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;

  // placement mode
  placing: BuildingTypeId | null = null;
  private ghostTile = { x: 0, y: 0 };
  private wallStart: { x: number; y: number } | null = null;
  attackMoveMode = false;

  // camera control state (fed by input controller)
  readonly panInput = { x: 0, y: 0 };
  private lastFogTick = -1;
  private lastFrameAt = performance.now();
  private raf = 0;
  private disposed = false;
  /** hook run at the start of every render frame (input aggregation). */
  preFrame: (() => void) | null = null;
  /** minimap alert pings: world pos + ttl */
  readonly pings: { x: number; y: number; t: number }[] = [];
  fps = 60;
  desynced = false;
  debugMode = false;

  constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    setup: GameSetup,
    you: number,
    transport: Transport,
    cb: GameCallbacks,
  ) {
    this.world = new World(setup);
    this.you = you;
    this.transport = transport;
    this.cb = cb;
    this.renderer = new GameRenderer(canvas);
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext('2d')!;
  }

  /** Load all assets referenced by the current world, then start the loop. */
  async start(onProgress: (pct: number, label: string) => void) {
    let done = 0;
    const total = 6;
    const tick = (label: string) => onProgress(Math.round(++done / total * 100), label);

    await loadAnimationLibrary();
    tick('Animations');
    this.doodads = await Doodads.load();
    tick('Nature');
    // preload every model this match can need (all players' colors)
    const owners = this.world.players.map((p) => p.color);
    const unitTypes = Object.keys(UNITS) as UnitTypeId[];
    await Promise.all(unitTypes.flatMap((t) => owners.flatMap((o) => [
      loadUnitModel(t, o, 0).catch(() => null),
      loadUnitModel(t, o, 1).catch(() => null),
    ])));
    tick('Units');
    await Promise.all((Object.keys(BUILDINGS) as BuildingTypeId[]).filter((t) => t !== 'woodwall' && t !== 'stonewall').flatMap((t) =>
      owners.map((o) => loadModel(buildingModelPath(t, o)).catch(() => null))));
    await Promise.all(CONSTRUCTION_MODELS.map((m) => loadModel(m).catch(() => null)));
    await loadRubbleModel().catch(() => null);
    tick('Buildings');
    await Promise.all(this.world.players.map((p) =>
      loadProjectileModel('arrow', p.color).catch(() => null)));
    await loadProjectileModel('boulder', 0).catch(() => null);
    tick('Projectiles');

    // scene assembly
    this.terrain = new Terrain(this.world.map);
    const scene = this.renderer.scene;
    scene.add(this.terrain.mesh);
    this.doodads.init(this.world.map, (t) => this.world.map.nodes.filter((n) => n.type === t).length);
    scene.add(this.doodads.group);
    scene.add(this.particles.group);
    scene.add(this.rings.mesh);
    scene.add(this.ghost.group);

    for (const e of this.world.entities.values()) {
      if (e.kind === 'resource') this.doodads.addNode(e);
      else void this.ensureView(e);
    }
    tick('World');

    // start viewing your town center
    const spawn = this.world.map.spawns[this.you] ?? this.world.map.spawns[0];
    this.renderer.focus.set(spawn.tx + 1.5, 0, spawn.ty + 3.5);
    this.terrain.updateFog(this.world.visibility[this.you]);

    this.lastFrameAt = performance.now();
    const loop = () => {
      if (this.disposed) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async ensureView(e: Entity) {
    if (e.kind === 'unit' && !this.unitViews.has(e.id)) {
      this.unitViews.set(e.id, null as unknown as UnitView); // reserve
      const model = await loadUnitModel(e.type, this.world.players[e.owner].color, e.id).catch(() => fallbackModel());
      if (this.disposed || !this.world.entities.has(e.id)) { this.unitViews.delete(e.id); return; }
      const view = new UnitView(e, model);
      this.unitViews.set(e.id, view);
      this.renderer.scene.add(view.group);
    } else if (e.kind === 'building' && !this.buildingViews.has(e.id)) {
      this.buildingViews.set(e.id, null as unknown as BuildingView);
      const color = this.world.players[e.owner].color;
      const { finalModel, phases, flag } = await loadBuildingModels(e.type, color)
        .catch(() => ({ finalModel: fallbackModel(0x777777), phases: [], flag: null }));
      if (this.disposed || !this.world.entities.has(e.id)) { this.buildingViews.delete(e.id); return; }
      const view = new BuildingView(e, finalModel, phases, flag);
      this.buildingViews.set(e.id, view);
      this.renderer.scene.add(view.group);
    } else if (e.kind === 'projectile' && !this.projViews.has(e.id)) {
      this.projViews.set(e.id, null as unknown as ProjectileView);
      const color = e.owner >= 0 ? this.world.players[e.owner].color : 0;
      const model = await loadProjectileModel(e.type, color).catch(() => fallbackModel(0x333333));
      if (this.disposed || !this.world.entities.has(e.id)) { this.projViews.delete(e.id); return; }
      const view = new ProjectileView(e, model);
      this.projViews.set(e.id, view);
      this.renderer.scene.add(view.group);
    }
  }

  private removeView(id: number) {
    const u = this.unitViews.get(id);
    if (u) { this.renderer.scene.remove(u.group); this.unitViews.delete(id); }
    const b = this.buildingViews.get(id);
    if (b) { this.renderer.scene.remove(b.group); this.buildingViews.delete(id); }
    const p = this.projViews.get(id);
    if (p) { this.renderer.scene.remove(p.group); this.projViews.delete(id); }
    if (this.selection.delete(id)) this.cb.onSelectionChange();
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private frame() {
    this.preFrame?.();
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, dt)) * 0.05;

    // --- advance the sim by whatever frames the transport has ---------------
    const frames = this.transport.pollFrames();
    for (const f of frames) {
      // remember previous positions for interpolation
      this.prevPos.clear();
      for (const e of this.world.entities.values()) {
        if (e.kind === 'unit' || e.kind === 'projectile') {
          this.prevPos.set(e.id, { x: toTiles(e.x), y: toTiles(e.y) });
        }
      }
      this.world.step(f);
      this.processEvents(this.world.events);
      if (this.world.tick % HASH_PERIOD === 0) {
        this.transport.reportHash(this.world.tick, this.world.hash());
      }
    }
    if (frames.length > 0) this.syncViews();

    const alpha = Math.max(0, Math.min(1, this.transport.alphaHint()));

    // --- camera -----------------------------------------------------------------
    const pan = this.renderer.zoom * 0.85 * dt;
    this.renderer.focus.x += this.panInput.x * pan;
    this.renderer.focus.z += this.panInput.y * pan;
    const s = this.world.size;
    this.renderer.focus.x = Math.max(2, Math.min(s - 2, this.renderer.focus.x));
    this.renderer.focus.z = Math.max(2, Math.min(s + 2, this.renderer.focus.z));
    this.renderer.updateCamera(dt);
    audio.listener.x = this.renderer.focus.x;
    audio.listener.y = this.renderer.focus.z;
    audio.listener.zoom = this.renderer.zoom;

    // --- views ---------------------------------------------------------------
    this.updateEntityViews(dt, alpha);
    this.particles.update(dt);
    this.updateRings();
    this.updateGhost();

    // fog texture refresh (a few times a second is plenty)
    if (this.world.tick !== this.lastFogTick && this.world.tick % 3 === 0) {
      this.lastFogTick = this.world.tick;
      this.terrain.updateFog(this.world.visibility[this.you]);
    }

    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].t -= dt;
      if (this.pings[i].t <= 0) this.pings.splice(i, 1);
    }

    this.renderer.render();
    this.drawOverlay();
  }

  /** Create/remove views to match the entity table. */
  private syncViews() {
    for (const e of this.world.entities.values()) {
      if (e.kind === 'resource') continue;
      if (e.kind === 'unit' ? !this.unitViews.has(e.id)
        : e.kind === 'building' ? !this.buildingViews.has(e.id)
          : !this.projViews.has(e.id)) {
        void this.ensureView(e);
      }
    }
    for (const id of [...this.unitViews.keys()]) {
      if (!this.world.entities.has(id)) this.removeView(id);
    }
    for (const id of [...this.buildingViews.keys()]) {
      if (!this.world.entities.has(id)) this.removeView(id);
    }
    for (const id of [...this.projViews.keys()]) {
      if (!this.world.entities.has(id)) this.removeView(id);
    }
  }

  private updateEntityViews(dt: number, alpha: number) {
    for (const [id, view] of this.unitViews) {
      if (!view) continue;
      const e = this.world.entities.get(id);
      if (!e) continue;
      const prev = this.prevPos.get(id);
      const cx = toTiles(e.x), cy = toTiles(e.y);
      const x = prev ? prev.x + (cx - prev.x) * alpha : cx;
      const y = prev ? prev.y + (cy - prev.y) * alpha : cy;
      const simMoving = !!prev && Math.hypot(cx - prev.x, cy - prev.y) > 0.001;

      // facing: toward engaged target or order point
      let fx = 0, fy = 0;
      const tgt = this.world.entities.get(e.engagedId || (e.order === 'gather' || e.order === 'build' || e.order === 'attack' ? e.targetId : 0));
      if (tgt) { fx = toTiles(tgt.x) - cx; fy = toTiles(tgt.y) - cy; }
      view.update(dt, x, y, fx, fy, simMoving);
      view.group.visible = e.owner === this.you || this.world.isVisibleTo(this.you, e);

      // ambient loop: movement vs job vs idle
      if (view.mixer && !view.dead) {
        const vis = view.moving;
        const unitData = UNITS[e.type as UnitTypeId];
        const anims = viewAnims(e.type);
        if (vis) {
          view.setMovementLoop(anims.move, anims.idle, Math.max(0.7, toTiles(unitData.speed) * TICK_RATE / 1.1));
        } else if (e.order !== 'gather' && e.order !== 'build') {
          view.setLoop(anims.idle);
        }
        // gather/build one-shots arrive via events; when standing between
        // swings fall back to idle softly
        else if (!view.busy()) {
          view.setLoop(anims.idle, 0.3);
        }
      }
      // soft footsteps for units walking near the camera
      if (view.moving && view.group.visible && Math.random() < dt * 1.6) {
        audio.play('footstep', x, y);
      }
    }

    for (const [id, view] of this.buildingViews) {
      if (!view) continue;
      const e = this.world.entities.get(id);
      if (!e) continue;
      view.setProgress(e);
      const tx = e.x >> FP_BITS, ty = e.y >> FP_BITS;
      view.group.visible = this.world.isExplored(this.you, tx, ty);
      // damaged buildings smoke and burn
      if (e.hp < e.maxHp * 0.45 && this.world.isBuildingComplete(e) && Math.random() < dt * 6) {
        const spot = view.smokeSpots[(Math.random() * view.smokeSpots.length) | 0];
        this.particles.buildingSmoke(view.group.position.x + spot.x, view.group.position.z + spot.z, spot.h);
        if (e.hp < e.maxHp * 0.25 && Math.random() < 0.5) {
          this.particles.fire(view.group.position.x + spot.x, view.group.position.z + spot.z, spot.h * 0.7);
        }
      }
    }

    for (const [id, view] of this.projViews) {
      if (!view) continue;
      const e = this.world.entities.get(id);
      if (!e) continue;
      const prev = this.prevPos.get(id);
      view.update(e, alpha, prev?.x ?? toTiles(e.x), prev?.y ?? toTiles(e.y));
      view.group.visible = this.world.isVisibleTo(this.you, e);
      if (view.isBoulder) {
        view.smokeTimer -= dt;
        if (view.smokeTimer <= 0) {
          view.smokeTimer = 0.05;
          this.particles.emit({
            x: view.group.position.x, y: view.group.position.z, z: view.group.position.y,
            count: 1, life: 0.5, size: 1.2, sizeEnd: 2, color: 0x9a9a9a, alpha: 0.4,
            frame: 2, vel: [0, 0.2, 0], velVar: 0.1, gravity: -0.1,
          });
        }
      }
    }

    // corpses fade out
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      c.view.update(dt, c.view.group.position.x, c.view.group.position.z, 0, 0);
      if (c.t > 3.2) c.view.group.position.y = -(c.t - 3.2) * 0.25;
      if (c.t > 5) {
        this.renderer.scene.remove(c.view.group);
        this.corpses.splice(i, 1);
      }
    }

    for (let i = this.rubble.length - 1; i >= 0; i--) {
      if (!this.rubble[i].update(dt)) {
        this.renderer.scene.remove(this.rubble[i].group);
        this.rubble.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sim events → presentation
  // -------------------------------------------------------------------------

  private processEvents(events: SimEvent[]) {
    for (const ev of events) {
      const x = toTiles(ev.x), y = toTiles(ev.y);
      const visible = this.eventVisible(ev);
      switch (ev.type) {
        case 'swing': {
          const view = this.unitViews.get(ev.ent!);
          const e = this.world.entities.get(ev.ent!);
          if (view && e) {
            const visual = viewAnims(e.type);
            const sequence = visual.attackSequence;
            if (sequence && sequence.length > 0) {
              const durations = e.type === 'bowman' ? [0.5, 0.55] : [0.3, 0.8];
              view.playSequence(sequence, durations);
            } else if (visual.attack && visual.attack.length > 0) {
              const anims = visual.attack;
              const clip = anims[(ev.ent! * 31 + this.world.tick) % anims.length];
              const dur = UNITS[e.type as UnitTypeId].swingTime / TICK_RATE + 0.25;
              view.playOnce(clip, dur);
            }
            if (visible) {
              const kind = e.type === 'bruiser' || e.type === 'vanguard' || e.type === 'catapult' ? 'swingHeavy' : 'swingLight';
              if (e.type !== 'bowman' && e.type !== 'crossbowman') audio.play(kind, x, y);
            }
          }
          break;
        }
        case 'meleeHit': {
          if (!visible) break;
          const victim = this.world.entities.get(ev.ent!);
          if (victim?.kind === 'building') {
            this.particles.dust(x, y, 4, 1.6);
            audio.play('mine', x, y);
          } else {
            const armored = victim && victim.kind === 'unit' && UNITS[victim.type as UnitTypeId].armor > 0;
            if (armored) { this.particles.hitSpark(x, y); audio.play('hitMetal', x, y); }
            else { this.particles.bluntHit(x, y); audio.play((ev.data ?? 0) > 7 ? 'hitCrit' : 'hitBody', x, y); }
          }
          break;
        }
        case 'arrowFire':
          if (visible) audio.play('arrow', x, y);
          break;
        case 'arrowHit':
          if (!visible) break;
          if (ev.ent) {
            this.particles.hitSpark(x, y);
            audio.play('hitBody', x, y);
          } else {
            this.particles.dust(x, y, 2, 1);
          }
          break;
        case 'catapultFire':
          if (visible) {
            audio.play('catapult', x, y);
            this.particles.dust(x, y, 5, 1.6);
          }
          break;
        case 'explosion':
          if (visible) {
            this.particles.explosion(x, y);
            audio.play('explosion', x, y);
            this.shakeIfNear(x, y, 0.25);
          }
          break;
        case 'died': {
          const view = this.unitViews.get(ev.ent!);
          if (view) {
            view.playDeath();
            this.unitViews.delete(ev.ent!);
            view.pickMesh.userData.entId = undefined;
            this.corpses.push({ view, t: 0 });
          }
          if (visible) {
            this.particles.deathPoof(x, y);
            audio.play('death', x, y);
          }
          break;
        }
        case 'buildingRazed': {
          if (visible || ev.player === this.you) {
            this.particles.collapse(x, y, ev.data ?? 2);
            audio.play('collapse', x, y);
            this.shakeIfNear(x, y, 0.4);
          }
          const view = this.buildingViews.get(ev.ent!);
          if (view) {
            void loadRubbleModel().then((m) => {
              if (this.disposed) return;
              const r = new RubbleView(m, x, y, ev.data ?? 2);
              this.rubble.push(r);
              this.renderer.scene.add(r.group);
            });
          }
          break;
        }
        case 'treeFall':
          this.doodads.removeNode(ev.ent!, 'tree', (ev.x >> FP_BITS), (ev.y >> FP_BITS));
          if (visible) {
            audio.play('treeFall', x, y);
            this.particles.emit({ x, y, z: 0.8, count: 8, life: 0.8, size: 1.2, color: [0x4d7c3a, 0x3f6830], frame: 3, velVar: 1.2, gravity: 4 });
          }
          break;
        case 'nodeDepleted':
          this.doodads.removeNode(ev.ent!, ev.entType ?? '', (ev.x >> FP_BITS), (ev.y >> FP_BITS));
          if (visible) audio.play('rockBreak', x, y);
          break;
        case 'gatherTick': {
          const view = this.unitViews.get(ev.ent!);
          const kind = ev.entType ?? '';
          if (view && !view.dead) {
            const anim = gatherAnim(kind);
            if (anim) view.playOnce(anim);
          }
          if (!visible) break;
          if (kind === 'tree') { this.particles.woodChips(x, y); audio.play('chop', x, y); }
          else if (kind === 'gold') { this.particles.stoneChips(x, y, true); audio.play('mine', x, y); }
          else if (kind === 'stone') { this.particles.stoneChips(x, y); audio.play('mine', x, y); }
          else this.particles.gatherSparkle(x, y);
          break;
        }
        case 'buildTick': {
          const view = this.unitViews.get(ev.ent!);
          if (view && !view.dead) view.playOnce('Hammer');
          if (visible) {
            this.particles.dust(x, y, 2, 1.1);
            audio.play('build', x, y);
          }
          break;
        }
        case 'deposit':
          break;
        case 'buildingPlaced':
          if (visible) this.particles.dust(x, y, 8, 2);
          break;
        case 'buildingDone':
          if (ev.player === this.you) audio.play('buildDone', x, y);
          if (visible) this.particles.dust(x, y, 6, 1.8);
          break;
        case 'unitTrained':
          if (ev.player === this.you) {
            audio.play('trainDone');
            this.particles.spawnFlash(x, y, playerColorHex(this.world.players[ev.player!].color));
          }
          this.cb.onPlayerUpdate();
          break;
        case 'researchDone':
          if (ev.player === this.you) {
            audio.play('research');
            this.cb.onToast(`Research complete: ${ev.entType}`);
          }
          break;
        case 'ageUp': {
          const p = this.world.players[ev.player!];
          if (ev.player === this.you) audio.play('ageUp');
          this.cb.onToast(`${p.name} has advanced to the ${AGE_NAMES[p.age]}!`);
          this.cb.onPlayerUpdate();
          break;
        }
        case 'popBlocked':
          if (ev.player === this.you) {
            this.cb.onToast('Population limit reached — build more Houses!', true);
          }
          break;
        case 'underAttack':
          if (ev.player === this.you) {
            audio.play('alert');
            this.cb.onToast('Your empire is under attack!', true);
            this.pings.push({ x, y, t: 5 });
          }
          break;
        case 'playerDefeated': {
          const p = this.world.players[ev.player!];
          this.cb.onToast(`${p.name} has been defeated.`, ev.player === this.you);
          if (ev.player === this.you) audio.play('defeat');
          break;
        }
        case 'gameOver':
          audio.play(ev.data === this.you ? 'victory' : 'defeat');
          this.cb.onGameOver(ev.data ?? -1);
          break;
      }
    }
    if (events.length > 0) this.cb.onPlayerUpdate();
  }

  private eventVisible(ev: SimEvent): boolean {
    const tx = Math.max(0, Math.min(this.world.size - 1, ev.x >> FP_BITS));
    const ty = Math.max(0, Math.min(this.world.size - 1, ev.y >> FP_BITS));
    return this.world.visibility[this.you][ty * this.world.size + tx] === 2;
  }

  private shakeIfNear(x: number, y: number, amt: number) {
    const d = Math.hypot(x - this.renderer.focus.x, y - this.renderer.focus.z);
    if (d < 26) this.renderer.addShake(amt * Math.max(0.2, 1 - d / 26));
  }

  // -------------------------------------------------------------------------
  // Selection & commands (called by the input controller / HUD)
  // -------------------------------------------------------------------------

  pickEntity(sx: number, sy: number): Entity | null {
    this.raycaster.setFromCamera(new THREE.Vector2(
      (sx / window.innerWidth) * 2 - 1,
      -(sy / window.innerHeight) * 2 + 1,
    ), this.renderer.camera);
    const meshes: THREE.Object3D[] = [];
    for (const v of this.unitViews.values()) if (v && v.group.visible) meshes.push(v.pickMesh);
    for (const v of this.buildingViews.values()) if (v && v.group.visible) meshes.push(v.pickMesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      const id = h.object.userData.entId as number | undefined;
      if (id !== undefined && this.world.entities.has(id)) return this.world.entities.get(id)!;
    }
    // fall through to resource nodes by ground position
    const g = this.renderer.screenToGround(sx, sy);
    if (g) {
      const tx = Math.floor(g.x), ty = Math.floor(g.y);
      for (const e of this.world.entities.values()) {
        if (e.kind === 'resource' && e.tileX === tx && e.tileY === ty) return e;
      }
    }
    return null;
  }

  select(ids: number[], additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (this.selection.has(id) && additive && ids.length === 1) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.pruneSelection();
    this.cb.onSelectionChange();
  }

  private pruneSelection() {
    // mixed selections collapse to own-units > own-buildings > other single
    const ents = [...this.selection].map((id) => this.world.entities.get(id)).filter(Boolean) as Entity[];
    const ownUnits = ents.filter((e) => e.kind === 'unit' && e.owner === this.you);
    if (ownUnits.length > 0) {
      this.selection.clear();
      ownUnits.forEach((e) => this.selection.add(e.id));
      return;
    }
    const ownBuildings = ents.filter((e) => e.kind === 'building' && e.owner === this.you);
    if (ownBuildings.length > 0) {
      this.selection.clear();
      this.selection.add(ownBuildings[0].id);
      return;
    }
    if (ents.length > 1) {
      this.selection.clear();
      this.selection.add(ents[0].id);
    }
  }

  selectedEntities(): Entity[] {
    const out: Entity[] = [];
    for (const id of this.selection) {
      const e = this.world.entities.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  selectedOwnUnits(): Entity[] {
    return this.selectedEntities().filter((e) => e.kind === 'unit' && e.owner === this.you);
  }

  marqueeSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const picked: number[] = [];
    for (const e of this.world.entities.values()) {
      if (e.kind !== 'unit' || e.owner !== this.you) continue;
      const s = this.renderer.worldToScreen(toTiles(e.x), toTiles(e.y), 0.4);
      if (!s.behind && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) picked.push(e.id);
    }
    if (picked.length > 0) this.select(picked, additive);
    else if (!additive) { this.selection.clear(); this.cb.onSelectionChange(); }
  }

  selectSameTypeOnScreen(seed: Entity) {
    const picked: number[] = [];
    for (const e of this.world.entities.values()) {
      if (e.kind !== seed.kind || e.type !== seed.type || e.owner !== seed.owner) continue;
      const s = this.renderer.worldToScreen(toTiles(e.x), toTiles(e.y), 0.4);
      if (!s.behind && s.x >= 0 && s.x <= window.innerWidth && s.y >= 0 && s.y <= window.innerHeight) {
        picked.push(e.id);
      }
    }
    this.select(picked.length ? picked : [seed.id]);
  }

  /** Right-click context command at a screen point. */
  contextCommand(sx: number, sy: number, queue: boolean) {
    const units = this.selectedOwnUnits();
    const target = this.pickEntity(sx, sy);
    const ground = this.renderer.screenToGround(sx, sy);

    if (units.length === 0) {
      // building selected: set rally
      const b = this.selectedEntities().find((e) => e.kind === 'building' && e.owner === this.you);
      if (b && ground) {
        const cmd: Command = {
          t: 'rally', building: b.id,
          x: fp(ground.x), y: fp(ground.y),
          target: target && target.id !== b.id ? target.id : undefined,
        };
        this.transport.sendCommands([cmd]);
        this.particles.rallyPing(ground.x, ground.y, playerColorHex(this.world.players[this.you].color));
        audio.play('click');
      }
      return;
    }

    const ids = units.map((u) => u.id);
    let cmd: Command | null = null;
    if (target && target.owner >= 0 && target.owner !== this.you && target.kind !== 'resource') {
      cmd = { t: 'attack', units: ids, target: target.id, queue };
      audio.play('click');
    } else if (target && target.kind === 'building' && target.owner === this.you && !this.world.isBuildingComplete(target)) {
      if (units.some((u) => u.type === 'villager')) {
        cmd = { t: 'buildmore', units: ids.filter((id) => this.world.entities.get(id)?.type === 'villager'), target: target.id, queue };
        audio.play('click');
      }
    } else if (target && target.kind === 'building' && target.owner === this.you && target.type === 'towncenter'
      && units.some((u) => u.type === 'villager')) {
      cmd = { t: 'garrison', units: ids.filter((id) => this.world.entities.get(id)?.type === 'villager'), building: target.id };
      audio.play('click');
    } else if (target && (target.kind === 'resource' || (target.kind === 'building' && target.type === 'farm' && target.owner === this.you))) {
      if (units.some((u) => u.type === 'villager')) {
        cmd = { t: 'gather', units: ids.filter((id) => this.world.entities.get(id)?.type === 'villager'), target: target.id, queue };
        audio.play('click');
      }
    } else if (ground) {
      cmd = { t: 'move', units: ids, x: fp(ground.x), y: fp(ground.y), queue };
      this.particles.rallyPing(ground.x, ground.y, 0x50ff70);
      audio.play('click');
    }
    if (cmd) this.transport.sendCommands([cmd]);
  }

  attackMoveTo(sx: number, sy: number) {
    const units = this.selectedOwnUnits();
    const ground = this.renderer.screenToGround(sx, sy);
    if (units.length === 0 || !ground) return;
    this.transport.sendCommands([{ t: 'attackmove', units: units.map((u) => u.id), x: fp(ground.x), y: fp(ground.y) }]);
    this.particles.rallyPing(ground.x, ground.y, 0xff5050);
    audio.play('click');
    this.attackMoveMode = false;
  }

  issueStop() {
    const units = this.selectedOwnUnits();
    if (units.length) this.transport.sendCommands([{ t: 'stop', units: units.map((u) => u.id) }]);
  }

  issueDelete() {
    const own = this.selectedEntities().filter((e) => e.owner === this.you);
    if (own.length) this.transport.sendCommands(own.map((e) => ({ t: 'delete', id: e.id } as Command)));
  }

  issueTrain(buildingId: number, unit: UnitTypeId) {
    this.transport.sendCommands([{ t: 'train', building: buildingId, unit }]);
    audio.play('click');
  }

  issueResearch(buildingId: number, tech: TechId) {
    this.transport.sendCommands([{ t: 'research', building: buildingId, tech }]);
    audio.play('click');
  }

  issueCancelQueue(buildingId: number, index: number) {
    this.transport.sendCommands([{ t: 'cancelqueue', building: buildingId, index }]);
    audio.play('click');
  }

  issueUngarrison(buildingId: number) {
    this.transport.sendCommands([{ t: 'ungarrison', building: buildingId }]);
  }

  resign() {
    this.transport.sendCommands([{ t: 'resign' }]);
  }

  // --- building placement ----------------------------------------------------

  enterPlacement(type: BuildingTypeId) {
    if (!isBuildingType(type)) return;
    this.placing = type;
    this.wallStart = null;
    const color = this.world.players[this.you].color;
    void loadBuildingModels(type, color).then(({ finalModel: m }) => {
      if (this.placing !== type) return;
      const obj = m.scene.clone(true);
      const d = BUILDINGS[type];
      // fit to footprint like the real view
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const target = Math.min(d.w, d.h);
      const sc = target / Math.max(size.x, size.z, 0.01);
      obj.scale.setScalar(sc);
      const box2 = new THREE.Box3().setFromObject(obj);
      const c = box2.getCenter(new THREE.Vector3());
      obj.position.set(-c.x, -box2.min.y, -c.z);
      this.ghost.setPreview(obj);
    });
    audio.play('uiOpen');
  }

  cancelPlacement() {
    if (this.placing) audio.play('uiClose');
    this.placing = null;
    this.wallStart = null;
    this.ghost.setPreview(null);
    this.ghost.hide();
  }

  updatePlacementCursor(sx: number, sy: number) {
    if (!this.placing) return;
    const g = this.renderer.screenToGround(sx, sy);
    if (!g) return;
    const d = BUILDINGS[this.placing];
    this.ghostTile.x = Math.round(g.x - d.w / 2);
    this.ghostTile.y = Math.round(g.y - d.h / 2);
    const ok = this.world.canPlaceBuilding(this.you, this.placing, this.ghostTile.x, this.ghostTile.y)
      && this.world.canAfford(this.you, d.cost);
    if ((this.placing === 'woodwall' || this.placing === 'stonewall') && this.wallStart) {
      this.ghost.showLine(this.wallTiles(this.wallStart, this.ghostTile), (x, y) => this.world.canPlaceBuilding(this.you, this.placing!, x, y));
    } else {
      this.ghost.show(this.ghostTile.x, this.ghostTile.y, d.w, d.h, ok);
    }
  }

  confirmPlacement(keepPlacing: boolean) {
    if (!this.placing) return;
    const type = this.placing;
    const villagers = this.selectedOwnUnits().filter((u) => u.type === 'villager');
    if (villagers.length === 0) { this.cancelPlacement(); return; }
    const d = BUILDINGS[type];
    if (type === 'woodwall' || type === 'stonewall') {
      if (!this.wallStart) {
        if (!this.world.canPlaceBuilding(this.you, type, this.ghostTile.x, this.ghostTile.y)) return;
        this.wallStart = { ...this.ghostTile };
        return;
      }
      const tiles = this.wallTiles(this.wallStart, this.ghostTile)
        .filter((tile) => this.world.canPlaceBuilding(this.you, type, tile.x, tile.y));
      const affordable = Math.min(tiles.length, Math.floor((this.world.players[this.you].stock[type === 'woodwall' ? 'wood' : 'stone']) / 8));
      this.transport.sendCommands(tiles.slice(0, affordable).map((tile, index) => ({
        t: 'build', units: villagers.map((villager) => villager.id), building: type,
        tx: tile.x, ty: tile.y, queue: index > 0,
      })));
      this.cancelPlacement();
      return;
    }
    if (!this.world.canPlaceBuilding(this.you, type, this.ghostTile.x, this.ghostTile.y)
      || !this.world.canAfford(this.you, d.cost)) {
      this.cb.onToast('Cannot place building there.', true);
      return;
    }
    this.transport.sendCommands([{
      t: 'build', units: villagers.map((v) => v.id), building: type,
      tx: this.ghostTile.x, ty: this.ghostTile.y, queue: keepPlacing,
    }]);
    audio.play('click');
    if (!keepPlacing) this.cancelPlacement();
  }

  private wallTiles(start: { x: number; y: number }, end: { x: number; y: number }) {
    const tiles: { x: number; y: number }[] = [];
    let x = start.x, y = start.y;
    const dx = Math.abs(end.x - x), dy = Math.abs(end.y - y);
    const sx = x < end.x ? 1 : -1, sy = y < end.y ? 1 : -1;
    let error = dx - dy;
    for (;;) {
      tiles.push({ x, y });
      if (x === end.x && y === end.y) break;
      const twice = error * 2;
      if (twice > -dy) { error -= dy; x += sx; }
      if (twice < dx) { error += dx; y += sy; }
    }
    return tiles;
  }

  revealMap() {
    this.world.visibility[this.you].fill(2);
    this.terrain.updateFog(this.world.visibility[this.you]);
  }

  enableGodMode() {
    this.debugMode = true;
    this.debugSetAge(2);
    this.debugAddResources();
    this.debugUnlockAll();
    this.revealMap();
  }

  debugAddResources() {
    const stock = this.world.players[this.you].stock;
    stock.food = stock.wood = stock.gold = stock.stone = 99999;
  }

  debugSetAge(age: number) {
    this.world.players[this.you].age = Math.max(0, Math.min(2, age | 0));
  }

  debugUnlockAll() {
    const player = this.world.players[this.you];
    for (const tech of Object.keys(TECHS) as TechId[]) player.techs[tech] = true;
    player.age = 2;
  }

  debugSpawnUnit(type: UnitTypeId, count = 1, owner = this.you) {
    const centerX = fp(this.renderer.focus.x);
    const centerY = fp(this.renderer.focus.z);
    for (let index = 0; index < Math.min(25, count); index++) {
      const angle = index * 2.4;
      this.world.createUnit(owner, type, centerX + fp(Math.cos(angle) * (1 + index * 0.08)), centerY + fp(Math.sin(angle) * (1 + index * 0.08)));
    }
  }

  debugSpawnBuilding(type: BuildingTypeId, owner = this.you) {
    const data = BUILDINGS[type];
    const originX = Math.round(this.renderer.focus.x - data.w / 2);
    const originY = Math.round(this.renderer.focus.z - data.h / 2);
    for (let radius = 0; radius < 12; radius++) {
      for (let y = originY - radius; y <= originY + radius; y++) {
        for (let x = originX - radius; x <= originX + radius; x++) {
          if (!this.world.canPlaceBuilding(this.you, type, x, y)) continue;
          this.world.createBuilding(owner, type, x, y, true);
          return;
        }
      }
    }
    this.cb.onToast('No free test location near the camera.', true);
  }

  debugCompleteAndHeal() {
    for (const entity of this.world.entities.values()) {
      if (entity.owner !== this.you) continue;
      entity.hp = entity.maxHp;
      if (entity.kind === 'building') entity.buildProgress = totalBuildTicks(entity.type as BuildingTypeId);
    }
  }

  // --- camera helpers ----------------------------------------------------------

  focusCamera(x: number, y: number) {
    this.renderer.focus.x = x;
    this.renderer.focus.z = y;
  }

  focusTownCenter() {
    for (const e of this.world.entities.values()) {
      if (e.kind === 'building' && e.owner === this.you && e.type === 'towncenter') {
        this.focusCamera(toTiles(e.x), toTiles(e.y) + 2);
        this.select([e.id]);
        return;
      }
    }
  }

  private idleCursor = 0;

  selectNextIdleVillager() {
    const idle: Entity[] = [];
    for (const e of this.world.entities.values()) {
      if (e.kind === 'unit' && e.owner === this.you && e.type === 'villager' && e.order === 'idle') idle.push(e);
    }
    if (idle.length === 0) { this.cb.onToast('No idle villagers.'); return; }
    const pick = idle[this.idleCursor++ % idle.length];
    this.select([pick.id]);
    this.focusCamera(toTiles(pick.x), toTiles(pick.y) + 1.5);
  }

  idleVillagerCount(): number {
    let n = 0;
    for (const e of this.world.entities.values()) {
      if (e.kind === 'unit' && e.owner === this.you && e.type === 'villager' && e.order === 'idle') n++;
    }
    return n;
  }

  setGroup(n: number) {
    const units = this.selectedOwnUnits();
    if (units.length) this.groups.set(n, units.map((u) => u.id));
  }

  recallGroup(n: number, focus: boolean) {
    const ids = (this.groups.get(n) ?? []).filter((id) => this.world.entities.has(id));
    if (ids.length === 0) return;
    this.select(ids);
    if (focus) {
      const e = this.world.entities.get(ids[0])!;
      this.focusCamera(toTiles(e.x), toTiles(e.y));
    }
  }

  markDesynced() {
    if (this.desynced) return;
    this.desynced = true;
    this.cb.onDesync?.();
  }

  // -------------------------------------------------------------------------
  // Overlay: selection rings, health bars, ghost
  // -------------------------------------------------------------------------

  private updateRings() {
    this.rings.begin();
    for (const id of this.selection) {
      const e = this.world.entities.get(id);
      if (!e) continue;
      const color = e.owner >= 0 ? playerColorHex(this.world.players[e.owner].color) : 0xf0f0f0;
      if (e.kind === 'unit') {
        const view = this.unitViews.get(id);
        if (view) this.rings.add(view.group.position.x, view.group.position.z, toTiles(UNITS[e.type as UnitTypeId].radius) * 2.1, color);
        const target = this.world.entities.get(e.engagedId || e.targetId);
        if (target) {
          const radius = target.kind === 'building' ? Math.max(this.world.footprint(target).w, this.world.footprint(target).h) * 0.55 : 0.48;
          this.rings.add(toTiles(target.x), toTiles(target.y), radius, 0xffd040);
        }
      } else if (e.kind === 'building') {
        const f = this.world.footprint(e);
        this.rings.add(f.x + f.w / 2, f.y + f.h / 2, Math.max(f.w, f.h) * 0.62, color);
        // rally marker while selected
        if (e.owner === this.you && e.rallyX >= 0) {
          const pulse = 0.3 + 0.1 * Math.sin(performance.now() / 240);
          this.rings.add(toTiles(e.rallyX), toTiles(e.rallyY), pulse, color);
        }
      } else if (e.kind === 'resource') {
        this.rings.add(e.tileX + 0.5, e.tileY + 0.5, 0.62, 0xf0f0f0);
      }
    }
    this.rings.commit();
  }

  private updateGhost() {
    if (!this.placing) this.ghost.hide();
  }

  private drawOverlay() {
    const ctx = this.overlayCtx;
    const w = window.innerWidth, h = window.innerHeight;
    if (this.overlay.width !== w) this.overlay.width = w;
    if (this.overlay.height !== h) this.overlay.height = h;
    ctx.clearRect(0, 0, w, h);

    // health bars: selected always; damaged if visible
    for (const e of this.world.entities.values()) {
      if (e.kind !== 'unit' && e.kind !== 'building') continue;
      const selected = this.selection.has(e.id);
      const damaged = e.hp < e.maxHp;
      const foundation = e.kind === 'building' && !this.world.isBuildingComplete(e);
      if (!selected && !damaged && !foundation) continue;
      if (e.owner !== this.you && !this.world.isVisibleTo(this.you, e)) continue;
      if (e.kind === 'building' && !this.world.isExplored(this.you, e.x >> FP_BITS, e.y >> FP_BITS)) continue;

      const isUnit = e.kind === 'unit';
      const height = isUnit ? 1.0 : Math.max(1.6, this.world.footprint(e).h * 0.8);
      const s = this.renderer.worldToScreen(toTiles(e.x), toTiles(e.y), height);
      if (s.behind) continue;
      const bw = isUnit ? 26 : 40;
      const x = Math.round(s.x - bw / 2), y = Math.round(s.y);
      const pct = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 1, y - 1, bw + 2, 5);
      ctx.fillStyle = '#502020';
      ctx.fillRect(x, y, bw, 3);
      ctx.fillStyle = pct > 0.55 ? '#20c030' : pct > 0.25 ? '#d0c020' : '#d03020';
      ctx.fillRect(x, y, Math.round(bw * pct), 3);
      if (foundation) {
        const total = totalBuildTicks(e.type as BuildingTypeId);
        const bp = e.buildProgress / total;
        ctx.fillStyle = '#000';
        ctx.fillRect(x - 1, y + 5, bw + 2, 5);
        ctx.fillStyle = '#203050';
        ctx.fillRect(x, y + 6, bw, 3);
        ctx.fillStyle = '#40a0e0';
        ctx.fillRect(x, y + 6, Math.round(bw * bp), 3);
      }
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.transport.stop();
    this.renderer.dispose();
    this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

// --- small helpers -----------------------------------------------------------

function viewAnims(type: string) {
  return UNIT_VISUALS[type]?.anims ?? { idle: 'Idle_A', move: 'Walking_A', death: 'Death_A', attack: [] };
}

function gatherAnim(kind: string): string | null {
  const g = UNIT_VISUALS.villager.gather!;
  return g[kind] ?? null;
}
