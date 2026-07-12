// The deterministic simulation. A World advances one tick at a time by
// consuming Frames (server-sequenced player commands). Given the same
// GameSetup and the same frame stream, every client computes bit-identical
// state — verified continuously via hash().
//
// Sim code rules: integer math only (see fixed.ts), all randomness through
// this.prng, all iteration in insertion/id order, no reads from anything
// outside (World, Frame).

import {
  BUILDINGS, CARRY_CAPACITY, FARM_GATHER_TICKS, RESOURCE_NODES, START_STOCK,
  START_VILLAGERS, TECHS, UNITS, buildRate, isBuildingType, isUnitType, totalBuildTicks,
} from './data';
import { FP, FP_BITS, clamp, dist, distSq, fp, isqrt, scaleTo } from './fixed';
import { GameMap, dirCos, dirSin, generateMap } from './map';
import { Grid, findPath } from './path';
import { Prng } from './prng';
import type {
  BuildingTypeId, Command, Entity, Frame, GameSetup, PlayerState, QueuedOrder,
  Resource, SimEvent, SimEventType, TechId, UnitTypeId, VillagerRole,
} from './types';
import { MODERN_MILITARY_CAP, MODERN_VILLAGER_CAP, POP_CAP, TICK_RATE, VILLAGER_ROLES } from './types';
import { aiThink } from './ai';

const ARROW_SPEED = Math.round(fp(6.5) / TICK_RATE);   // fp per tick
const BOULDER_SPEED = Math.round(fp(4.5) / TICK_RATE);
const VIS_PERIOD = 3;
const ACQUIRE_PERIOD = 5;
const ALERT_COOLDOWN = 8 * TICK_RATE;
const ARRIVE_DIST = fp(0.35);
// Reach distances are measured edge-to-edge and must cover standing on a
// diagonally-adjacent tile (edge distance up to ~1.02 tiles for 1x1 nodes,
// ~0.71 for building corners), since paths only promise adjacency.
const REACH_NODE = fp(1.05);
const REACH_BUILDING = fp(0.8);
/** Max collision push per pair per tick — well under unit walk speed. */
const PUSH_MAX = Math.round(fp(0.045));
/** Extra melee reach against buildings, for corner-adjacent attackers. */
const MELEE_BUILDING_BONUS = fp(0.5);

export class World {
  readonly setup: GameSetup;
  readonly size: number;
  readonly map: GameMap;
  readonly grid: Grid;
  readonly players: PlayerState[] = [];
  readonly entities = new Map<number, Entity>();
  readonly prng: Prng;
  /** Presentation events for the tick that just ran. */
  events: SimEvent[] = [];
  tick = 0;
  gameOver = false;
  winner = -1;

  /** Per-player fog state: 0 unexplored, 1 explored, 2 visible. */
  readonly visibility: Uint8Array[] = [];
  /** Minimal persistent AI state (hashed): last wave tick + size per player. */
  readonly aiStates: { lastWave: number; waveSize: number }[] = [];

  private idSeq = 1;
  private lastAlert: number[] = [];
  // per-tick indexes, rebuilt at the start of every tick
  private buckets = new Map<number, number[]>();
  private buildingIds: number[] = [];
  private buildersByTarget = new Map<number, number>();
  private sightOffsets = new Map<number, Int16Array>();

  constructor(setup: GameSetup) {
    this.setup = setup;
    this.size = setup.mapSize;
    this.prng = new Prng(setup.seed);
    this.map = generateMap(setup.seed, setup.mapSize, setup.players.length, setup.mapType ?? 'arabia');
    this.grid = new Grid(setup.mapSize);

    for (let i = 0; i < setup.players.length; i++) {
      const p = setup.players[i];
      this.players.push({
        id: i, name: p.name, color: p.color, isAI: p.isAI, aiLevel: p.aiLevel,
        alive: true, resigned: false, age: 0,
        stock: { ...START_STOCK }, pop: 0, popCap: 0, villagerPop: 0, militaryPop: 0, techs: {},
        stats: {
          gathered: { food: 0, wood: 0, gold: 0, stone: 0 },
          unitsTrained: 0, unitsLost: 0, unitsKilled: 0, buildingsRazed: 0, buildingsLost: 0,
        },
      });
      const visibility = new Uint8Array(this.size * this.size);
      if (setup.discovered !== false) visibility.fill(1);
      this.visibility.push(visibility);
      this.aiStates.push({ lastWave: 0, waveSize: 6 });
      this.lastAlert.push(-ALERT_COOLDOWN);
    }

    // resource nodes
    for (const n of this.map.nodes) {
      const data = RESOURCE_NODES[n.type];
      const e = this.newEntity('resource', n.type, -1, (n.tx << FP_BITS) + FP / 2, (n.ty << FP_BITS) + FP / 2);
      e.amount = data.amount;
      e.tileX = n.tx;
      e.tileY = n.ty;
      if (data.blocks) this.grid.setRect(n.tx, n.ty, 1, 1, 1);
    }

    // town centers + starting villagers
    for (let i = 0; i < setup.players.length; i++) {
      const s = this.map.spawns[i];
      const tc = this.createBuilding(i, 'towncenter', s.tx, s.ty, true);
      const startingVillagers = this.isModern() ? VILLAGER_ROLES.length : START_VILLAGERS;
      for (let v = 0; v < startingVillagers; v++) {
        const k = 8 + v * 3; // fan out south of the TC
        const x = tc.x + ((fp(2.2) * dirCos(k)) >> 12);
        const y = tc.y + ((fp(2.2) * dirSin(k)) >> 12);
        this.createUnit(i, 'villager', x, y);
      }
      if (setup.mapType === 'arena') this.createArenaWalls(i, s.tx + 1, s.ty + 1);
    }
    this.updateVisibility(true);
  }

  // -------------------------------------------------------------------------
  // Entity construction
  // -------------------------------------------------------------------------

  private newEntity(kind: Entity['kind'], type: string, owner: number, x: number, y: number): Entity {
    const e: Entity = {
      id: this.idSeq++, kind, type, owner, x, y, hp: 1, maxHp: 1,
      order: 'idle', orderX: 0, orderY: 0, targetId: 0, engagedId: 0,
      path: [], repath: 0, attackCd: 0, swingTick: 0,
      carry: 0, carryKind: 'food', villagerRole: 'builder', gatherTimer: 0, queuedOrders: [],
      buildProgress: 0, trainQueue: [], rallyX: -1, rallyY: -1, rallyTargetId: 0, rallyResource: '',
      tileX: 0, tileY: 0, amount: 0,
      fromId: 0, projT: 0, projDur: 0, srcX: 0, srcY: 0, splash: 0, dmg: 0,
      garrisonedIn: 0, garrisonedIds: [], lastCombatTick: -100000,
    };
    this.entities.set(e.id, e);
    return e;
  }

  private createArenaWalls(owner: number, cx: number, cy: number) {
    const radius = 6;
    for (let x = cx - radius; x <= cx + radius; x++) {
      this.createBuilding(owner, 'stonewall', x, cy - radius, true);
      if (Math.abs(x - cx) > 1) this.createBuilding(owner, 'stonewall', x, cy + radius, true);
    }
    for (let y = cy - radius + 1; y < cy + radius; y++) {
      this.createBuilding(owner, 'stonewall', cx - radius, y, true);
      this.createBuilding(owner, 'stonewall', cx + radius, y, true);
    }
  }

  createUnit(owner: number, type: UnitTypeId, x: number, y: number): Entity {
    const d = UNITS[type];
    const e = this.newEntity('unit', type, owner, x, y);
    e.hp = e.maxHp = d.hp;
    if (type === 'villager' && this.isModern()) e.villagerRole = this.nextModernVillagerRole(owner, e.id);
    return e;
  }

  private nextModernVillagerRole(owner: number, excludeId = 0): VillagerRole {
    const counts = Object.fromEntries(VILLAGER_ROLES.map((role) => [role, 0])) as Record<VillagerRole, number>;
    for (const entity of this.entities.values()) {
      if (entity.id !== excludeId && entity.kind === 'unit' && entity.type === 'villager' && entity.owner === owner) counts[entity.villagerRole]++;
    }
    return VILLAGER_ROLES.reduce((best, role) => counts[role] < counts[best] ? role : best, VILLAGER_ROLES[0]);
  }

  createBuilding(owner: number, type: BuildingTypeId, tx: number, ty: number, completed = false): Entity {
    const d = BUILDINGS[type];
    const e = this.newEntity('building', type, owner,
      (tx << FP_BITS) + (d.w * FP) / 2, (ty << FP_BITS) + (d.h * FP) / 2);
    e.tileX = tx;
    e.tileY = ty;
    e.maxHp = d.hp;
    e.buildProgress = completed ? totalBuildTicks(type) : 0;
    e.hp = completed ? d.hp : Math.max(1, d.hp >> 3);
    if (type !== 'farm') this.grid.setRect(tx, ty, d.w, d.h, 1);
    this.buildingIds.push(e.id); // keep the per-tick index coherent mid-tick
    return e;
  }

  // -------------------------------------------------------------------------
  // Public queries (used by client + AI)
  // -------------------------------------------------------------------------

  isBuildingComplete(e: Entity): boolean {
    return e.kind === 'building' && e.buildProgress >= totalBuildTicks(e.type as BuildingTypeId);
  }

  isModern(): boolean {
    return this.setup.mode === 'modern';
  }

  footprint(e: Entity): { x: number; y: number; w: number; h: number } {
    if (e.kind === 'building') {
      const d = BUILDINGS[e.type as BuildingTypeId];
      return { x: e.tileX, y: e.tileY, w: d.w, h: d.h };
    }
    return { x: e.x >> FP_BITS, y: e.y >> FP_BITS, w: 1, h: 1 };
  }

  /** Fixed-point distance from a point to an entity's edge (rect for buildings, circle otherwise). */
  edgeDist(x: number, y: number, e: Entity): number {
    if (e.kind === 'building') {
      const d = BUILDINGS[e.type as BuildingTypeId];
      const x0 = e.tileX << FP_BITS, y0 = e.tileY << FP_BITS;
      const cx = clamp(x, x0, x0 + d.w * FP);
      const cy = clamp(y, y0, y0 + d.h * FP);
      return dist(x, y, cx, cy);
    }
    const r = e.kind === 'unit' ? UNITS[e.type as UnitTypeId].radius
      : e.kind === 'resource' ? RESOURCE_NODES[e.type as keyof typeof RESOURCE_NODES].radius : 0;
    return Math.max(0, dist(x, y, e.x, e.y) - r);
  }

  isVisibleTo(player: number, e: Entity): boolean {
    const tx = clamp(e.x >> FP_BITS, 0, this.size - 1);
    const ty = clamp(e.y >> FP_BITS, 0, this.size - 1);
    return this.visibility[player][ty * this.size + tx] === 2;
  }

  isExplored(player: number, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return false;
    return this.visibility[player][ty * this.size + tx] >= 1;
  }

  canAfford(player: number, cost: Partial<Record<Resource, number>>): boolean {
    const s = this.players[player].stock;
    for (const k in cost) if (s[k as Resource] < cost[k as Resource]!) return false;
    return true;
  }

  hasTech(player: number, tech: TechId): boolean {
    return this.players[player].techs[tech] === true;
  }

  /** Whether tech is researched OR currently queued anywhere (for UI + AI). */
  techPending(player: number, tech: TechId): boolean {
    if (this.hasTech(player, tech)) return true;
    if (tech === 'age2' && this.players[player].age >= 1) return true;
    if (tech === 'age3' && this.players[player].age >= 2) return true;
    for (const id of this.buildingIds) {
      const b = this.entities.get(id); // id may be stale within a tick (razed/deleted)
      if (b && b.owner === player && b.trainQueue.some((q) => q.tech === tech)) return true;
    }
    return false;
  }

  canPlaceBuilding(player: number, type: BuildingTypeId, tx: number, ty: number): boolean {
    if (this.isModern() && (type === 'house' || type === 'lumbercamp' || type === 'minecamp')) return false;
    const d = BUILDINGS[type];
    if (this.players[player].age < d.age) return false;
    if (!this.grid.rectFree(tx, ty, d.w, d.h)) return false;
    // farms don't block the grid, but must not overlap other farms/foundations
    for (const id of this.buildingIds) {
      const b = this.entities.get(id); // id may be stale within a tick (razed/deleted)
      if (!b) continue;
      const bd = BUILDINGS[b.type as BuildingTypeId];
      if (b.tileX < tx + d.w && tx < b.tileX + bd.w && b.tileY < ty + d.h && ty < b.tileY + bd.h) return false;
    }
    // all four corners must be explored
    return this.isExplored(player, tx, ty) && this.isExplored(player, tx + d.w - 1, ty) &&
      this.isExplored(player, tx, ty + d.h - 1) && this.isExplored(player, tx + d.w - 1, ty + d.h - 1);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  step(frame: Frame) {
    if (frame.tick !== this.tick) throw new Error(`frame ${frame.tick} != tick ${this.tick}`);
    this.events = [];
    if (this.gameOver) { this.tick++; return; }

    this.rebuildIndexes();

    for (const fc of frame.commands) {
      for (const cmd of fc.cmds) {
        // a malformed command must never crash the sim — and because every
        // client sees the same frame, catching is itself deterministic
        try {
          this.applyCommand(fc.player | 0, cmd);
        } catch {
          // ignore hostile/garbage input
        }
      }
    }
    if (this.isModern()) this.updateModernVillagerProduction();
    for (const p of this.players) {
      if (p.isAI && p.alive && this.tick > TICK_RATE && (this.tick + p.id * 3) % (p.aiLevel >= 2 ? 10 : 15) === 0) {
        aiThink(this, p.id);
      }
    }

    this.updateBuildings();
    if (this.isModern()) this.assignModernVillagerWork();
    this.updateVillagers();
    this.updateCombat();
    this.moveUnits();
    this.resolveCollisions();
    this.updateProjectiles();
    if (this.tick % VIS_PERIOD === 0) this.updateVisibility(false);
    if (this.tick % TICK_RATE === 0) this.checkVictory();

    this.tick++;
  }

  private ev(type: SimEventType, x: number, y: number, extra?: Partial<SimEvent>) {
    this.events.push({ type, x, y, ...extra });
  }

  private rebuildIndexes() {
    this.buckets.clear();
    this.buildingIds.length = 0;
    this.buildersByTarget.clear();
    for (const p of this.players) {
      p.pop = 0;
      p.popCap = this.isModern() ? MODERN_MILITARY_CAP : 0;
      p.villagerPop = 0;
      p.militaryPop = 0;
    }

    for (const e of this.entities.values()) {
      if (e.kind === 'unit') {
        if (e.garrisonedIn) {
          if (!this.isModern() || e.type !== 'villager') this.players[e.owner].pop++;
          if (e.type === 'villager') this.players[e.owner].villagerPop++;
          else this.players[e.owner].militaryPop++;
          continue;
        }
        const ti = (e.y >> FP_BITS) * this.size + (e.x >> FP_BITS);
        let b = this.buckets.get(ti);
        if (!b) this.buckets.set(ti, (b = []));
        b.push(e.id);
        if (!this.isModern() || e.type !== 'villager') this.players[e.owner].pop++;
        if (e.type === 'villager') this.players[e.owner].villagerPop++;
        else this.players[e.owner].militaryPop++;
        if (e.order === 'build') {
          const t = this.entities.get(e.targetId);
          if (t && t.kind === 'building' && this.edgeDist(e.x, e.y, t) <= REACH_BUILDING) {
            this.buildersByTarget.set(t.id, (this.buildersByTarget.get(t.id) ?? 0) + 1);
          }
        }
      } else if (e.kind === 'building') {
        this.buildingIds.push(e.id);
        if (!this.isModern() && this.isBuildingComplete(e)) {
          const cap = BUILDINGS[e.type as BuildingTypeId].popCap;
          if (cap) this.players[e.owner].popCap = Math.min(POP_CAP, this.players[e.owner].popCap + cap);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  applyCommand(player: number, cmd: Command) {
    const p = this.players[player];
    if (!p || !p.alive) return;
    switch (cmd.t) {
      case 'move':
      case 'attackmove': {
        const units = this.commandableUnits(player, cmd.units);
        units.forEach((u, i) => {
          const [ox, oy] = formationOffset(i, units.length);
          this.giveOrder(u, {
            order: cmd.t === 'move' ? 'move' : 'attackmove',
            x: clamp(cmd.x + ox, FP / 2, (this.size << FP_BITS) - FP / 2),
            y: clamp(cmd.y + oy, FP / 2, (this.size << FP_BITS) - FP / 2),
            targetId: 0,
          }, cmd.queue === true);
        });
        break;
      }
      case 'attack': {
        const t = this.entities.get(cmd.target);
        if (!t || t.owner === player || (t.kind !== 'unit' && t.kind !== 'building')) return;
        for (const u of this.commandableUnits(player, cmd.units)) {
          this.giveOrder(u, { order: 'attack', x: t.x, y: t.y, targetId: t.id }, cmd.queue === true);
        }
        break;
      }
      case 'gather': {
        if (this.isModern()) return;
        const t = this.entities.get(cmd.target);
        if (!t || !this.isGatherable(player, t)) return;
        for (const u of this.ownedUnits(player, cmd.units)) {
          if (u.type !== 'villager') continue;
          this.giveOrder(u, { order: 'gather', x: t.x, y: t.y, targetId: t.id }, cmd.queue === true);
        }
        break;
      }
      case 'build': {
        if (!isBuildingType(cmd.building)) return;
        if (this.isModern() && (cmd.building === 'house' || cmd.building === 'lumbercamp' || cmd.building === 'minecamp')) return;
        const d = BUILDINGS[cmd.building];
        const villagers = this.ownedUnits(player, cmd.units).filter((u) => u.type === 'villager');
        if (!this.isModern() && villagers.length === 0) return;
        if (!this.canAfford(player, d.cost) || !this.canPlaceBuilding(player, cmd.building, cmd.tx, cmd.ty)) return;
        this.payCost(player, d.cost);
        const b = this.createBuilding(player, cmd.building, cmd.tx, cmd.ty);
        this.evictUnitsFrom(cmd.tx, cmd.ty, d.w, d.h);
        this.ev('buildingPlaced', b.x, b.y, { ent: b.id, entType: b.type, player });
        if (!this.isModern()) {
          for (const u of villagers) this.giveOrder(u, { order: 'build', x: b.x, y: b.y, targetId: b.id }, cmd.queue === true);
        }
        break;
      }
      case 'buildmore': {
        if (this.isModern()) return;
        const t = this.entities.get(cmd.target);
        if (!t || t.kind !== 'building' || t.owner !== player || this.isBuildingComplete(t)) return;
        for (const u of this.ownedUnits(player, cmd.units)) {
          if (u.type === 'villager') this.giveOrder(u, { order: 'build', x: t.x, y: t.y, targetId: t.id }, cmd.queue === true);
        }
        break;
      }
      case 'train': {
        const b = this.entities.get(cmd.building);
        if (!b || b.kind !== 'building' || b.owner !== player || !this.isBuildingComplete(b)) return;
        if (!isUnitType(cmd.unit)) return;
        if (this.isModern() && cmd.unit === 'villager') return;
        const d = UNITS[cmd.unit];
        if (d.building !== b.type || p.age < d.age) return;
        if (this.isModern() && p.militaryPop + this.queuedUnitCount(player, false) >= MODERN_MILITARY_CAP) return;
        if (b.trainQueue.length >= 5 || !this.canAfford(player, d.cost)) return;
        this.payCost(player, d.cost);
        b.trainQueue.push({ unit: cmd.unit, progress: 0 });
        break;
      }
      case 'research': {
        const b = this.entities.get(cmd.building);
        if (!b || b.kind !== 'building' || b.owner !== player || !this.isBuildingComplete(b)) return;
        const d = TECHS[cmd.tech];
        if (!d || d.building !== b.type || p.age < d.age) return;
        if (this.techPending(player, cmd.tech)) return;
        if (d.requires && !this.hasTech(player, d.requires)) return;
        if (b.trainQueue.length >= 5 || !this.canAfford(player, d.cost)) return;
        this.payCost(player, d.cost);
        b.trainQueue.push({ tech: cmd.tech, progress: 0 });
        break;
      }
      case 'cancelqueue': {
        const b = this.entities.get(cmd.building);
        const index = cmd.index | 0;
        if (!b || b.owner !== player || index < 0 || index >= b.trainQueue.length) return;
        if (this.isModern() && b.trainQueue[index].unit === 'villager') return;
        const item = b.trainQueue.splice(index, 1)[0];
        this.refund(player, item.unit ? UNITS[item.unit].cost : TECHS[item.tech!].cost);
        break;
      }
      case 'rally': {
        const b = this.entities.get(cmd.building);
        if (!b || b.kind !== 'building' || b.owner !== player) return;
        b.rallyX = cmd.x;
        b.rallyY = cmd.y;
        b.rallyTargetId = cmd.target ?? 0;
        b.rallyResource = '';
        const rallyTarget = cmd.target ? this.entities.get(cmd.target) : null;
        if (rallyTarget && this.isGatherable(player, rallyTarget)) {
          b.rallyResource = rallyTarget.kind === 'building'
            ? 'food'
            : RESOURCE_NODES[rallyTarget.type as keyof typeof RESOURCE_NODES].gives;
        }
        break;
      }
      case 'stop': {
        for (const u of this.commandableUnits(player, cmd.units)) {
          this.clearOrder(u);
          u.queuedOrders.length = 0;
        }
        break;
      }
      case 'delete': {
        const e = this.entities.get(cmd.id);
        if (e && e.owner === player && (e.kind === 'unit' || e.kind === 'building')
          && !(this.isModern() && e.kind === 'unit' && e.type === 'villager')) {
          this.kill(e, -1);
        }
        break;
      }
      case 'garrison': {
        if (this.isModern()) return;
        const building = this.entities.get(cmd.building);
        if (!building || building.kind !== 'building' || building.owner !== player
          || building.type !== 'towncenter' || !this.isBuildingComplete(building)) return;
        for (const unit of this.ownedUnits(player, cmd.units)) {
          if (unit.type !== 'villager' || unit.garrisonedIn || building.garrisonedIds.length >= 10) continue;
          unit.garrisonedIn = building.id;
          unit.x = building.x;
          unit.y = building.y;
          this.clearOrder(unit);
          building.garrisonedIds.push(unit.id);
        }
        break;
      }
      case 'ungarrison': {
        const building = this.entities.get(cmd.building);
        if (!building || building.kind !== 'building' || building.owner !== player || building.type !== 'towncenter') return;
        const data = BUILDINGS.towncenter;
        for (const id of building.garrisonedIds) {
          const unit = this.entities.get(id);
          const spot = this.freeTileAround(building.tileX, building.tileY, data.w, data.h);
          if (!unit || !spot) continue;
          unit.garrisonedIn = 0;
          unit.x = (spot.x << FP_BITS) + FP / 2;
          unit.y = (spot.y << FP_BITS) + FP / 2;
        }
        building.garrisonedIds.length = 0;
        break;
      }
      case 'allocateVillager': {
        if (!this.isModern() || !VILLAGER_ROLES.includes(cmd.role) || (cmd.delta !== -1 && cmd.delta !== 1)) return;
        this.adjustModernVillagerAllocation(player, cmd.role, cmd.delta, cmd.from);
        break;
      }
      case 'resign': {
        p.resigned = true;
        break;
      }
    }
  }

  private ownedUnits(player: number, ids: number[]): Entity[] {
    const out: Entity[] = [];
    if (!Array.isArray(ids)) return out;
    for (const id of ids.slice(0, 80)) {
      const e = this.entities.get(id);
      if (e && e.kind === 'unit' && e.owner === player) out.push(e);
    }
    return out;
  }

  private isGatherable(player: number, t: Entity): boolean {
    if (t.kind === 'resource') return t.amount > 0;
    return t.kind === 'building' && t.type === 'farm' && t.owner === player && this.isBuildingComplete(t);
  }

  private giveOrder(u: Entity, o: QueuedOrder, queue: boolean) {
    if (queue && u.order !== 'idle') {
      if (u.queuedOrders.length < 8) u.queuedOrders.push(o);
      return;
    }
    u.queuedOrders.length = 0;
    this.startOrder(u, o);
  }

  private startOrder(u: Entity, o: QueuedOrder) {
    u.order = o.order;
    u.orderX = o.x;
    u.orderY = o.y;
    u.targetId = o.targetId;
    u.engagedId = 0;
    u.path.length = 0;
    u.repath = 0;
    u.gatherTimer = 0;
    u.swingTick = 0;
  }

  private clearOrder(u: Entity) {
    u.order = 'idle';
    u.targetId = 0;
    u.engagedId = 0;
    u.path.length = 0;
    u.swingTick = 0;
    u.gatherTimer = 0;
  }

  /** Order finished: continue with the queued one, or fall idle. */
  private finishOrder(u: Entity) {
    const next = u.queuedOrders.shift();
    if (next) this.startOrder(u, next);
    else this.clearOrder(u);
  }

  private payCost(player: number, cost: Partial<Record<Resource, number>>) {
    const s = this.players[player].stock;
    for (const k in cost) s[k as Resource] -= cost[k as Resource]!;
  }

  private refund(player: number, cost: Partial<Record<Resource, number>>) {
    const s = this.players[player].stock;
    for (const k in cost) s[k as Resource] += cost[k as Resource]!;
  }

  private canSpawnUnit(player: number, type: UnitTypeId): boolean {
    const state = this.players[player];
    if (!this.isModern()) return state.pop < state.popCap;
    return type === 'villager'
      ? state.villagerPop < MODERN_VILLAGER_CAP
      : state.militaryPop < MODERN_MILITARY_CAP;
  }

  private queuedUnitCount(owner: number, villagers: boolean): number {
    let count = 0;
    for (const id of this.buildingIds) {
      const building = this.entities.get(id);
      if (!building || building.owner !== owner) continue;
      count += building.trainQueue.filter((item) => item.unit && (item.unit === 'villager') === villagers).length;
    }
    return count;
  }

  private updateModernVillagerProduction() {
    for (const player of this.players) {
      if (!player.alive || player.villagerPop >= MODERN_VILLAGER_CAP) continue;
      let queued = false;
      let townCenter: Entity | null = null;
      for (const id of this.buildingIds) {
        const building = this.entities.get(id);
        if (!building || building.owner !== player.id || building.type !== 'towncenter' || !this.isBuildingComplete(building)) continue;
        if (building.trainQueue.some((item) => item.unit === 'villager')) queued = true;
        if (!townCenter && building.trainQueue.length < 5) townCenter = building;
      }
      if (queued || !townCenter || !this.canAfford(player.id, UNITS.villager.cost)) continue;
      this.payCost(player.id, UNITS.villager.cost);
      townCenter.trainQueue.push({ unit: 'villager', progress: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Buildings: construction, training, tower fire
  // -------------------------------------------------------------------------

  private updateBuildings() {
    for (const id of this.buildingIds) {
      const b = this.entities.get(id);
      if (!b) continue;
      const d = BUILDINGS[b.type as BuildingTypeId];
      const total = totalBuildTicks(b.type as BuildingTypeId);

      if (b.buildProgress < total) {
        const builders = this.buildersByTarget.get(b.id) ?? 0;
        if (builders > 0) {
          const before = b.buildProgress;
          b.buildProgress = Math.min(total, b.buildProgress + buildRate(builders));
          // hp grows with the work done; combat damage persists instead of
          // being healed back by the progress-scaled floor
          b.hp = Math.min(d.hp, b.hp + Math.max(1, Math.trunc((d.hp * (b.buildProgress - before)) / total)));
          if (b.buildProgress >= total) {
            this.ev('buildingDone', b.x, b.y, { ent: b.id, entType: b.type, player: b.owner });
          }
        }
        continue;
      }

      // training / research queue
      const item = b.trainQueue[0];
      if (item) {
        const time = item.unit ? UNITS[item.unit].trainTime : TECHS[item.tech!].time;
        if (item.progress < time) item.progress++;
        if (item.progress >= time) {
          if (item.unit) {
            if (this.canSpawnUnit(b.owner, item.unit)) {
              b.trainQueue.shift();
              this.spawnTrained(b, item.unit);
            } else if (this.tick % (5 * TICK_RATE) === 0) {
              // held until housing frees up; nag the owner occasionally
              this.ev('popBlocked', b.x, b.y, { ent: b.id, player: b.owner });
            }
          } else {
            b.trainQueue.shift();
            this.completeTech(b.owner, item.tech!, b);
          }
        }
      }

      // defensive fire (towers, town centers, castles)
      if (d.attack) {
        if (b.attackCd > 0) {
          b.attackCd--;
        } else if ((this.tick + b.id) % ACQUIRE_PERIOD === 0) {
          const t = this.findNearestEnemy(b.owner, b.x, b.y, d.attackRange!, true);
          if (t) {
            const dmg = d.attack + this.rangedBonus(b.owner);
            this.spawnProjectile(b, t.id, t.x, t.y, dmg, 0);
            b.attackCd = d.attackCd!;
            this.ev('arrowFire', b.x, b.y, { ent: b.id, player: b.owner });
          }
        }
      }
    }
  }

  private spawnTrained(b: Entity, type: UnitTypeId) {
    const d = BUILDINGS[b.type as BuildingTypeId];
    const spot = this.freeTileAround(b.tileX, b.tileY, d.w, d.h);
    if (!spot) return; // completely walled in: unit is lost (degenerate case)
    const u = this.createUnit(b.owner, type, (spot.x << FP_BITS) + FP / 2, (spot.y << FP_BITS) + FP / 2);
    if (!this.isModern() || type !== 'villager') this.players[b.owner].pop++; // keep the cap honest for same-tick spawns
    if (type === 'villager') this.players[b.owner].villagerPop++;
    else this.players[b.owner].militaryPop++;
    this.players[b.owner].stats.unitsTrained++;
    this.ev('unitTrained', u.x, u.y, { ent: u.id, entType: type, player: b.owner });

    // Resource rallies persist as a category even after the chosen node is depleted.
    if (u.type === 'villager' && b.rallyResource) {
      u.carryKind = b.rallyResource;
      const target = this.entities.get(b.rallyTargetId);
      if (target && this.isGatherable(b.owner, target)) {
        this.startOrder(u, { order: 'gather', x: target.x, y: target.y, targetId: target.id });
      } else {
        this.startOrder(u, { order: 'move', x: b.rallyX, y: b.rallyY, targetId: 0 });
        u.queuedOrders.push({ order: 'gather', x: b.rallyX, y: b.rallyY, targetId: 0 });
      }
      return;
    }
    // send to rally point
    if (b.rallyTargetId) {
      const t = this.entities.get(b.rallyTargetId);
      if (t && u.type === 'villager' && this.isGatherable(b.owner, t)) {
        this.startOrder(u, { order: 'gather', x: t.x, y: t.y, targetId: t.id });
        return;
      }
      if (t && t.owner !== b.owner && (t.kind === 'unit' || t.kind === 'building')) {
        this.startOrder(u, { order: 'attack', x: t.x, y: t.y, targetId: t.id });
        return;
      }
    }
    if (b.rallyX >= 0) {
      this.startOrder(u, { order: 'move', x: b.rallyX, y: b.rallyY, targetId: 0 });
    }
  }

  private completeTech(player: number, tech: TechId, b: Entity) {
    const p = this.players[player];
    p.techs[tech] = true; // also for ages: age3 requires age2 via this flag
    if (tech === 'age2') p.age = Math.max(p.age, 1);
    else if (tech === 'age3') p.age = Math.max(p.age, 2);
    this.ev(tech.startsWith('age') ? 'ageUp' : 'researchDone', b.x, b.y, { player, entType: tech });
  }

  /** Push units standing inside a freshly-placed footprint to its edge. */
  private evictUnitsFrom(tx: number, ty: number, w: number, h: number) {
    const x0 = tx << FP_BITS, y0 = ty << FP_BITS;
    const x1 = (tx + w) << FP_BITS, y1 = (ty + h) << FP_BITS;
    for (const e of this.entities.values()) {
      if (e.kind !== 'unit') continue;
      if (e.x < x0 || e.x >= x1 || e.y < y0 || e.y >= y1) continue;
      const spot = this.freeTileAround(tx, ty, w, h);
      if (spot) {
        e.x = (spot.x << FP_BITS) + FP / 2;
        e.y = (spot.y << FP_BITS) + FP / 2;
        e.path.length = 0;
        e.repath = 0;
      }
    }
  }

  private freeTileAround(tx: number, ty: number, w: number, h: number): { x: number; y: number } | null {
    for (let r = 0; r < 6; r++) {
      for (let j = -1 - r; j <= h + r; j++) {
        for (let i = -1 - r; i <= w + r; i++) {
          const onRing = i === -1 - r || i === w + r || j === -1 - r || j === h + r;
          if (!onRing) continue;
          const x = tx + i, y = ty + j;
          if (!this.grid.isBlocked(x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Villagers: gather + build
  // -------------------------------------------------------------------------

  private adjustModernVillagerAllocation(owner: number, role: VillagerRole, delta: -1 | 1, requestedDonor?: VillagerRole) {
    const byRole = new Map<VillagerRole, Entity[]>(VILLAGER_ROLES.map((candidate) => [candidate, []]));
    for (const entity of this.entities.values()) {
      if (entity.kind === 'unit' && entity.type === 'villager' && entity.owner === owner) byRole.get(entity.villagerRole)!.push(entity);
    }
    const current = byRole.get(role)!;
    let villager: Entity | undefined;
    let destination: VillagerRole;
    if (delta > 0) {
      const donor = requestedDonor && requestedDonor !== role && byRole.get(requestedDonor)!.length > 1
        ? requestedDonor
        : VILLAGER_ROLES.filter((candidate) => candidate !== role && byRole.get(candidate)!.length > 1)
        .sort((a, b) => byRole.get(b)!.length - byRole.get(a)!.length || VILLAGER_ROLES.indexOf(a) - VILLAGER_ROLES.indexOf(b))[0];
      if (!donor) return;
      villager = byRole.get(donor)!.at(-1);
      destination = role;
    } else {
      if (current.length <= 1) return;
      destination = VILLAGER_ROLES.filter((candidate) => candidate !== role)
        .sort((a, b) => byRole.get(a)!.length - byRole.get(b)!.length || VILLAGER_ROLES.indexOf(a) - VILLAGER_ROLES.indexOf(b))[0];
      villager = current.at(-1);
    }
    if (!villager) return;
    villager.villagerRole = destination;
    villager.carry = 0;
    villager.carryKind = destination === 'builder' ? 'food' : destination;
    villager.queuedOrders.length = 0;
    this.clearOrder(villager);
  }

  private assignModernVillagerWork() {
    this.normalizeModernVillagerRoles();
    for (const villager of this.entities.values()) {
      if (villager.kind !== 'unit' || villager.type !== 'villager' || villager.garrisonedIn) continue;
      if (villager.villagerRole === 'builder') {
        const target = this.entities.get(villager.targetId);
        if (villager.order === 'build' && target?.kind === 'building' && target.owner === villager.owner && !this.isBuildingComplete(target)) continue;
        const foundation = this.nearestFoundation(villager.owner, villager.x, villager.y, 0);
        if (foundation) this.startOrder(villager, { order: 'build', x: foundation.x, y: foundation.y, targetId: foundation.id });
        else if (villager.order !== 'idle') this.clearOrder(villager);
        continue;
      }
      const target = this.entities.get(villager.targetId);
      if (villager.order === 'gather' && target && this.modernTargetProvides(villager.owner, target, villager.villagerRole)) continue;
      const resource = this.nearestModernResource(villager.owner, villager.villagerRole, villager.x, villager.y);
      if (resource) {
        villager.carryKind = villager.villagerRole;
        this.startOrder(villager, { order: 'gather', x: resource.x, y: resource.y, targetId: resource.id });
      } else if (villager.order !== 'idle') {
        this.clearOrder(villager);
      }
    }
  }

  private normalizeModernVillagerRoles() {
    for (const player of this.players) {
      const byRole = new Map<VillagerRole, Entity[]>(VILLAGER_ROLES.map((role) => [role, []]));
      for (const entity of this.entities.values()) {
        if (entity.kind === 'unit' && entity.type === 'villager' && entity.owner === player.id) byRole.get(entity.villagerRole)!.push(entity);
      }
      for (const missing of VILLAGER_ROLES) {
        if (byRole.get(missing)!.length > 0) continue;
        const donor = VILLAGER_ROLES.filter((role) => byRole.get(role)!.length > 1)
          .sort((a, b) => byRole.get(b)!.length - byRole.get(a)!.length || VILLAGER_ROLES.indexOf(a) - VILLAGER_ROLES.indexOf(b))[0];
        if (!donor) break;
        const villager = byRole.get(donor)!.pop()!;
        villager.villagerRole = missing;
        villager.carry = 0;
        villager.queuedOrders.length = 0;
        this.clearOrder(villager);
        byRole.get(missing)!.push(villager);
      }
    }
  }

  private modernTargetProvides(owner: number, target: Entity, role: Resource): boolean {
    if (!this.isGatherable(owner, target)) return false;
    if (target.kind === 'building') return role === 'food' && target.type === 'farm';
    return RESOURCE_NODES[target.type as keyof typeof RESOURCE_NODES].gives === role;
  }

  private nearestModernResource(owner: number, role: Resource, x: number, y: number): Entity | null {
    let best: Entity | null = null;
    let bestDistance = Infinity;
    for (const entity of this.entities.values()) {
      if (!this.modernTargetProvides(owner, entity, role)) continue;
      const distance = distSq(x, y, entity.x, entity.y);
      if (distance < bestDistance) { bestDistance = distance; best = entity; }
    }
    return best;
  }

  private updateVillagers() {
    for (const e of this.entities.values()) {
      if (e.kind !== 'unit' || e.type !== 'villager' || e.garrisonedIn) continue;
      if (e.order === 'gather') this.updateGather(e);
      else if (e.order === 'build') this.updateBuild(e);
    }
  }

  private updateGather(u: Entity) {
    const node = this.entities.get(u.targetId);
    const nodeValid = node && this.isGatherable(u.owner, node);

    if (!this.isModern() && (u.carry >= CARRY_CAPACITY || (!nodeValid && u.carry > 0))) {
      // walk to the nearest drop-off
      const drop = this.nearestDropoff(u.owner, u.carryKind, u.x, u.y);
      if (!drop) { if (!nodeValid) this.finishOrder(u); return; }
      if (this.edgeDist(u.x, u.y, drop) <= REACH_BUILDING) {
        const p = this.players[u.owner];
        p.stock[u.carryKind] += u.carry;
        p.stats.gathered[u.carryKind] += u.carry;
        this.ev('deposit', u.x, u.y, { ent: u.id, player: u.owner, data: u.carry });
        u.carry = 0;
        u.path.length = 0;
        if (!nodeValid) this.retargetGather(u, null);
      } else {
        this.ensurePathToEntity(u, drop);
      }
      return;
    }

    if (!nodeValid) {
      if (this.isModern() && u.villagerRole !== 'builder') {
        const resource = this.nearestModernResource(u.owner, u.villagerRole, u.x, u.y);
        if (resource) this.startOrder(u, { order: 'gather', x: resource.x, y: resource.y, targetId: resource.id });
        else this.clearOrder(u);
      } else {
        this.retargetGather(u, node ?? null);
      }
      return;
    }

    const isFarm = node!.kind === 'building';
    const reach = isFarm ? REACH_BUILDING : REACH_NODE;
    if (this.edgeDist(u.x, u.y, node!) <= reach) {
      u.path.length = 0;
      const data = isFarm ? null : RESOURCE_NODES[node!.type as keyof typeof RESOURCE_NODES];
      const ticksPer = isFarm ? FARM_GATHER_TICKS : data!.gatherTicks;
      const gives = isFarm ? 'food' : data!.gives;
      if (u.carryKind !== gives) {
        u.carry = 0; // switching resource types dumps the old load
        u.carryKind = gives;
      }
      if (++u.gatherTimer >= ticksPer) {
        u.gatherTimer = 0;
        if (this.isModern()) {
          const player = this.players[u.owner];
          player.stock[gives]++;
          player.stats.gathered[gives]++;
          this.ev('deposit', u.x, u.y, { ent: u.id, player: u.owner, data: 1 });
        } else {
          u.carry++;
        }
        if (!isFarm) {
          node!.amount--;
          this.ev('gatherTick', node!.x, node!.y, { ent: u.id, entType: node!.type, data: node!.amount });
          if (node!.amount <= 0) this.depleteNode(node!);
        } else {
          this.ev('gatherTick', node!.x, node!.y, { ent: u.id, entType: 'farm' });
        }
      }
    } else {
      this.ensurePathToEntity(u, node!);
    }
  }

  private depleteNode(node: Entity) {
    this.ev(node.type === 'tree' ? 'treeFall' : 'nodeDepleted', node.x, node.y, { ent: node.id, entType: node.type });
    this.grid.setRect(node.tileX, node.tileY, 1, 1, 0);
    this.entities.delete(node.id);
  }

  /** Find another node of the same kind nearby (or a farm for food). */
  private retargetGather(u: Entity, oldNode: Entity | null) {
    if (u.queuedOrders.length > 0) { this.finishOrder(u); return; }
    const wantType = oldNode ? oldNode.type : null;
    let best: Entity | null = null;
    let bestD = fp(12) * fp(12);
    for (const e of this.entities.values()) {
      const sameKind = wantType
        ? (e.type === wantType || (wantType === 'berries' && e.type === 'farm') || (wantType === 'farm' && e.type === 'berries'))
        // after a final deposit we only know what we were carrying — stick to it
        : (e.kind === 'resource' && RESOURCE_NODES[e.type as keyof typeof RESOURCE_NODES].gives === u.carryKind)
          || (e.type === 'farm' && u.carryKind === 'food');
      if (!sameKind || !this.isGatherable(u.owner, e)) continue;
      const d2 = distSq(u.x, u.y, e.x, e.y);
      if (d2 < bestD) { bestD = d2; best = e; }
    }
    if (best) {
      u.targetId = best.id;
      u.path.length = 0;
      u.gatherTimer = 0;
    } else if (u.carry > 0) {
      u.targetId = 0; // deposit branch will run, then finish
    } else {
      this.finishOrder(u);
    }
  }

  private nearestDropoff(player: number, kind: Resource, x: number, y: number): Entity | null {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const id of this.buildingIds) {
      const b = this.entities.get(id);
      if (!b || b.owner !== player || !this.isBuildingComplete(b)) continue;
      const drop = BUILDINGS[b.type as BuildingTypeId].dropOff;
      if (!drop || !drop.includes(kind)) continue;
      const d = this.edgeDist(x, y, b);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private updateBuild(u: Entity) {
    const b = this.entities.get(u.targetId);
    if (!b || b.kind !== 'building' || b.owner !== u.owner) { this.finishOrder(u); return; }
    if (this.isBuildingComplete(b)) {
      if (this.isModern()) {
        const next = this.nearestFoundation(u.owner, u.x, u.y, b.id);
        if (next) this.startOrder(u, { order: 'build', x: next.x, y: next.y, targetId: next.id });
        else this.clearOrder(u);
        return;
      }
      // One builder occupies a completed farm; the rest continue their queue.
      if (b.type === 'farm' && this.isGatherable(u.owner, b)) {
        const farmer = [...this.entities.values()]
          .filter((e) => e.kind === 'unit' && e.type === 'villager' && e.owner === u.owner && e.targetId === b.id)
          .sort((a, c) => a.id - c.id)[0];
        if (farmer?.id === u.id) this.startOrder(u, { order: 'gather', x: b.x, y: b.y, targetId: b.id });
        else this.finishOrder(u);
      } else {
        if (u.queuedOrders.length > 0) this.finishOrder(u);
        else {
          const next = this.nearestFoundation(u.owner, u.x, u.y, b.id);
          if (next) this.startOrder(u, { order: 'build', x: next.x, y: next.y, targetId: next.id });
          else this.finishOrder(u);
        }
      }
      return;
    }
    if (this.edgeDist(u.x, u.y, b) <= REACH_BUILDING) {
      u.path.length = 0;
      if ((this.tick + u.id) % Math.round(TICK_RATE * 0.9) === 0) {
        this.ev('buildTick', u.x, u.y, { ent: u.id, player: u.owner });
      }
    } else {
      this.ensurePathToEntity(u, b);
    }
  }

  private commandableUnits(player: number, ids: number[]): Entity[] {
    const units = this.ownedUnits(player, ids);
    return this.isModern() ? units.filter((unit) => unit.type !== 'villager') : units;
  }

  private nearestFoundation(owner: number, x: number, y: number, exclude: number): Entity | null {
    let best: Entity | null = null;
    let bestDistance = this.isModern() ? Infinity : fp(18) * fp(18);
    for (const entity of this.entities.values()) {
      if (entity.id === exclude || entity.kind !== 'building' || entity.owner !== owner || this.isBuildingComplete(entity)) continue;
      const distance = distSq(x, y, entity.x, entity.y);
      if (distance < bestDistance) { bestDistance = distance; best = entity; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private meleeBonus(player: number): number {
    return (this.hasTech(player, 'forging') ? 1 : 0) + (this.hasTech(player, 'ironcasting') ? 1 : 0);
  }

  private rangedBonus(player: number): number {
    return (this.hasTech(player, 'fletching') ? 1 : 0) + (this.hasTech(player, 'bodkin') ? 1 : 0);
  }

  private armorBonus(player: number): number {
    return (this.hasTech(player, 'scalearmor') ? 1 : 0) + (this.hasTech(player, 'chainarmor') ? 1 : 0);
  }

  private updateCombat() {
    for (const e of this.entities.values()) {
      if (e.kind !== 'unit' || e.garrisonedIn) continue;
      const d = UNITS[e.type as UnitTypeId];
      if (d.regenerates && e.hp < e.maxHp && this.tick - e.lastCombatTick >= 5 * TICK_RATE
        && (this.tick + e.id) % TICK_RATE === 0) e.hp++;

      // a started swing always plays out (its damage is locked in on landing)
      if (e.swingTick > 0) {
        if (--e.swingTick === 0) this.landAttack(e);
        continue;
      }
      if (e.attackCd > 0) e.attackCd--;

      const isMilitary = e.type !== 'villager';

      // resolve who we're fighting
      let target: Entity | undefined;
      if (e.order === 'attack') {
        target = this.entities.get(e.targetId);
        if (!target || target.hp <= 0) { this.finishOrder(e); continue; }
      } else if (e.engagedId) {
        target = this.entities.get(e.engagedId);
        if (!target || target.hp <= 0) { e.engagedId = 0; e.path.length = 0; target = undefined; }
      }

      // auto-acquire for military standing around or attack-moving
      if (!target && isMilitary && (e.order === 'idle' || e.order === 'attackmove')
        && (this.tick + e.id) % ACQUIRE_PERIOD === 0) {
        const found = this.findNearestEnemy(e.owner, e.x, e.y, fp(d.sight), true);
        if (found) {
          e.engagedId = found.id;
          e.path.length = 0;
          target = found;
        }
      }
      if (!target) continue;

      const edge = this.edgeDist(e.x, e.y, target);
      let range = d.attackRange;
      if (d.attackKind === 'melee') {
        range += d.radius; // melee reach is edge-to-edge
        if (target.kind === 'building') range += MELEE_BUILDING_BONUS; // corner-adjacent attackers
      }
      const tooClose = d.minRange !== undefined && edge < d.minRange;

      if (edge <= range && !tooClose) {
        e.path.length = 0;
        if (e.attackCd === 0) {
          e.swingTick = d.swingTime;
          e.attackCd = d.attackCd;
          e.engagedId = target.id;
          this.ev('swing', e.x, e.y, { ent: e.id, entType: e.type, data: target.id, player: e.owner });
        }
      } else {
        // chase
        this.ensurePathToEntity(e, target, tooClose);
      }
    }
  }

  private landAttack(u: Entity) {
    const d = UNITS[u.type as UnitTypeId];
    const target = this.entities.get(u.engagedId || u.targetId);
    if (!target || target.hp <= 0) return;

    if (d.attackKind === 'melee') {
      let reach = d.attackRange + d.radius + fp(0.35); // grace: target may shuffle mid-swing
      if (target.kind === 'building') reach += MELEE_BUILDING_BONUS;
      if (this.edgeDist(u.x, u.y, target) <= reach) {
        const dmg = this.attackDamage(u, target, d.attack + this.meleeBonus(u.owner));
        this.applyDamage(target, dmg, u.owner, u.id, 'melee');
      }
    } else if (d.attackKind === 'arrow') {
      const dmg = this.attackDamage(u, target, d.attack + this.rangedBonus(u.owner));
      this.spawnProjectile(u, target.id, target.x, target.y, dmg, 0);
      this.ev('arrowFire', u.x, u.y, { ent: u.id, player: u.owner });
    } else {
      const dmg = d.attack; // siege damage is not tech-boosted
      this.spawnProjectile(u, 0, target.x, target.y, dmg, d.splash ?? 0);
      this.ev('catapultFire', u.x, u.y, { ent: u.id, player: u.owner });
    }
  }

  private attackDamage(attacker: Entity, target: Entity, base: number): number {
    const data = UNITS[attacker.type as UnitTypeId];
    let damage = base;
    if (target.kind === 'building') damage += data.buildingBonus ?? 0;
    if (target.kind === 'unit') {
      const targetData = UNITS[target.type as UnitTypeId];
      if (data.role === 'archer' && targetData.role === 'infantry') damage = Math.trunc(damage * 7 / 4);
      if (data.role === 'infantry' && targetData.role === 'brute') damage = Math.trunc(damage * 7 / 4);
      if (data.role === 'brute' && targetData.role === 'archer') damage = Math.trunc(damage * 7 / 4);
      if (attacker.type === 'crossbowman' && targetData.role === 'brute') damage = Math.trunc(damage * 3 / 2);
      if (target.type === 'crossbowman' && data.role === 'infantry') damage *= 2;
      if (targetData.role === 'siege') damage += data.siegeBonus ?? 0;
    }
    return Math.max(1, damage);
  }

  private spawnProjectile(from: Entity, targetId: number, tx: number, ty: number, dmg: number, splash: number) {
    const p = this.newEntity('projectile', splash > 0 ? 'boulder' : 'arrow', from.owner, from.x, from.y);
    const speed = splash > 0 ? BOULDER_SPEED : ARROW_SPEED;
    p.srcX = from.x;
    p.srcY = from.y;
    p.orderX = tx;
    p.orderY = ty;
    p.targetId = targetId;
    p.fromId = from.id;
    p.dmg = dmg;
    p.splash = splash;
    p.projDur = Math.max(3, Math.trunc(dist(from.x, from.y, tx, ty) / speed));
    p.projT = 0;
  }

  private updateProjectiles() {
    const done: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.kind !== 'projectile') continue;
      e.projT++;
      // homing arrows track their target
      if (e.targetId) {
        const t = this.entities.get(e.targetId);
        if (t && t.hp > 0) { e.orderX = t.x; e.orderY = t.y; }
        else e.targetId = 0;
      }
      const f = Math.min(FP, Math.trunc((e.projT << FP_BITS) / e.projDur));
      e.x = e.srcX + Math.trunc(((e.orderX - e.srcX) * f) >> FP_BITS);
      e.y = e.srcY + Math.trunc(((e.orderY - e.srcY) * f) >> FP_BITS);
      if (e.projT >= e.projDur) done.push(e);
    }
    for (const e of done) {
      this.entities.delete(e.id);
      if (e.splash > 0) {
        this.ev('explosion', e.orderX, e.orderY, { player: e.owner });
        // splash damages every unit/building near the impact — friend or foe
        for (const t of this.entities.values()) {
          if (t.kind !== 'unit' && t.kind !== 'building') continue;
          const dd = this.edgeDist(e.orderX, e.orderY, t);
          if (dd <= e.splash) {
            const dmg = dd * 2 <= e.splash ? e.dmg : Math.trunc((e.dmg * 3) / 5);
            this.applyDamage(t, dmg, e.owner, e.fromId, 'boulder');
          }
        }
      } else if (e.targetId) {
        const t = this.entities.get(e.targetId);
        if (t && t.hp > 0 && dist(t.x, t.y, e.orderX, e.orderY) <= fp(0.7)) {
          this.applyDamage(t, e.dmg, e.owner, e.fromId, 'arrow');
        } else {
          this.ev('arrowHit', e.orderX, e.orderY, { data: 0 }); // thud into the ground
        }
      }
    }
  }

  private applyDamage(victim: Entity, raw: number, byPlayer: number, byId: number, kind: 'melee' | 'arrow' | 'boulder') {
    const armor = victim.kind === 'unit'
      ? UNITS[victim.type as UnitTypeId].armor + this.armorBonus(victim.owner)
      : 0;
    const dmg = Math.max(1, raw - armor);
    victim.hp -= dmg;
    victim.lastCombatTick = this.tick;
    const attacker = this.entities.get(byId);
    if (attacker) attacker.lastCombatTick = this.tick;
    this.ev(kind === 'melee' ? 'meleeHit' : 'arrowHit', victim.x, victim.y,
      { ent: victim.id, entType: victim.type, data: dmg, player: victim.owner });

    if (victim.owner >= 0 && byPlayer >= 0 && victim.owner !== byPlayer) {
      // "we're under attack!" alert, rate-limited
      if (this.tick - this.lastAlert[victim.owner] >= ALERT_COOLDOWN) {
        this.lastAlert[victim.owner] = this.tick;
        this.ev('underAttack', victim.x, victim.y, { player: victim.owner });
      }
      // idle military fights back
      if (victim.kind === 'unit' && victim.type !== 'villager' && victim.order === 'idle' && !victim.engagedId) {
        const attacker = this.entities.get(byId);
        if (attacker && attacker.kind === 'unit') victim.engagedId = byId;
      }
    }
    if (victim.hp <= 0) this.kill(victim, byPlayer);
  }

  private kill(e: Entity, byPlayer: number) {
    if (e.kind === 'unit') {
      this.players[e.owner].stats.unitsLost++;
      if (byPlayer >= 0 && byPlayer !== e.owner) this.players[byPlayer].stats.unitsKilled++;
      this.ev('died', e.x, e.y, { ent: e.id, entType: e.type, player: e.owner });
    } else if (e.kind === 'building') {
      for (const id of e.garrisonedIds) {
        const unit = this.entities.get(id);
        if (unit) {
          unit.garrisonedIn = 0;
          unit.x = e.x;
          unit.y = e.y;
        }
      }
      e.garrisonedIds.length = 0;
      this.players[e.owner].stats.buildingsLost++;
      if (byPlayer >= 0 && byPlayer !== e.owner) this.players[byPlayer].stats.buildingsRazed++;
      const d = BUILDINGS[e.type as BuildingTypeId];
      if (e.type !== 'farm') this.grid.setRect(e.tileX, e.tileY, d.w, d.h, 0);
      // refund half of what an unbuilt foundation cost
      if (!this.isBuildingComplete(e) && byPlayer === -1) {
        const half: Partial<Record<Resource, number>> = {};
        for (const k in d.cost) half[k as Resource] = Math.trunc(d.cost[k as Resource]! / 2);
        this.refund(e.owner, half);
      }
      this.ev('buildingRazed', e.x, e.y, { ent: e.id, entType: e.type, player: e.owner, data: d.w });
    }
    this.entities.delete(e.id);
  }

  /** Squared edge distance — the cheap form for range scans (no sqrt). */
  private edgeDistSq(x: number, y: number, e: Entity): number {
    if (e.kind === 'building') {
      const d = BUILDINGS[e.type as BuildingTypeId];
      const x0 = e.tileX << FP_BITS, y0 = e.tileY << FP_BITS;
      const cx = clamp(x, x0, x0 + d.w * FP);
      const cy = clamp(y, y0, y0 + d.h * FP);
      return distSq(x, y, cx, cy);
    }
    return distSq(x, y, e.x, e.y);
  }

  /**
   * Nearest enemy of `player` within `range` (fp) of (x, y). Prefers units
   * over buildings when `preferUnits`; villager targets rank below military.
   */
  findNearestEnemy(player: number, x: number, y: number, range: number, preferUnits: boolean): Entity | null {
    let best: Entity | null = null;
    let bestScore = Infinity;
    const r2 = range * range;
    for (const e of this.entities.values()) {
      if (e.kind !== 'unit' && e.kind !== 'building') continue;
      if (e.owner < 0 || e.owner === player) continue;
      if (!this.players[e.owner].alive) continue;
      const dd2 = this.edgeDistSq(x, y, e);
      if (dd2 > r2) continue;
      let score = dd2;
      if (preferUnits && e.kind === 'building') score += fp(50) * fp(50);
      if (e.kind === 'unit' && e.type === 'villager') score += fp(4) * fp(4);
      if (e.kind === 'building' && !this.isBuildingComplete(e)) score += fp(30) * fp(30);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  /** Ensure the unit has a path toward the entity (or away, if fleeing min-range). */
  private ensurePathToEntity(u: Entity, t: Entity, backOff = false) {
    if (u.repath > 0) { u.repath--; return; }
    if (u.path.length > 0) {
      // still following a plan; replan only if a mobile target strayed from it
      if (t.kind === 'building' || t.kind === 'resource') return;
      const gx = u.path[u.path.length - 2], gy = u.path[u.path.length - 1];
      if (distSq(gx, gy, t.x, t.y) < fp(1.5) * fp(1.5)) return;
    }
    const sx = u.x >> FP_BITS, sy = u.y >> FP_BITS;
    if (backOff) {
      // step directly away from the target (catapult min range)
      const [dx, dy] = scaleTo(u.x - t.x, u.y - t.y, fp(2));
      u.path = [clamp(u.x + dx, FP, (this.size - 1) << FP_BITS), clamp(u.y + dy, FP, (this.size - 1) << FP_BITS)];
      u.repath = 6;
      return;
    }
    const f = this.footprint(t);
    const path = findPath(this.grid, sx, sy, t.kind === 'building' ? f : { x: f.x, y: f.y, w: 1, h: 1 });
    u.path = path ?? [];
    // go straight at it when close (path returns [] for already-adjacent)
    if (u.path.length === 0 && path !== null) u.path = [t.x, t.y];
    u.repath = 8;
  }

  private ensurePathToPoint(u: Entity) {
    if (u.repath > 0) { u.repath--; return; }
    const sx = u.x >> FP_BITS, sy = u.y >> FP_BITS;
    let tx = u.orderX >> FP_BITS, ty = u.orderY >> FP_BITS;
    if (this.grid.isBlocked(tx, ty)) {
      const free = this.grid.nearestFree(tx, ty);
      if (!free) { this.finishOrder(u); return; }
      tx = free.x; ty = free.y;
      u.orderX = (tx << FP_BITS) + FP / 2;
      u.orderY = (ty << FP_BITS) + FP / 2;
    }
    const path = findPath(this.grid, sx, sy, { x: tx, y: ty, w: 0, h: 0 });
    if (path === null) { this.finishOrder(u); return; }
    u.path = path;
    u.path.push(u.orderX, u.orderY); // final exact point
    u.repath = 10;
  }

  private moveUnits() {
    for (const e of this.entities.values()) {
      if (e.kind !== 'unit' || e.garrisonedIn || e.swingTick > 0) continue;
      const d = UNITS[e.type as UnitTypeId];

      if ((e.order === 'move' || e.order === 'attackmove') && !e.engagedId) {
        if (distSq(e.x, e.y, e.orderX, e.orderY) <= ARRIVE_DIST * ARRIVE_DIST) {
          this.finishOrder(e);
        } else if (e.path.length === 0) {
          this.ensurePathToPoint(e);
        }
      }
      if (e.path.length === 0) continue;

      let budget = d.speed;
      let guard = 8;
      // a unit standing on a blocked tile (a building went up under it) must
      // be allowed to walk out — only fresh obstructions cancel the path
      const escaping = this.grid.isBlocked(e.x >> FP_BITS, e.y >> FP_BITS);
      while (budget > 0 && e.path.length >= 2 && guard-- > 0) {
        const wx = e.path[0], wy = e.path[1];
        const dd = dist(e.x, e.y, wx, wy);
        if (dd <= budget) {
          e.x = wx; e.y = wy;
          e.path.splice(0, 2);
          budget -= dd;
        } else {
          const [mx, my] = scaleTo(wx - e.x, wy - e.y, budget);
          const nx = e.x + mx, ny = e.y + my;
          if (!escaping && this.grid.isBlocked(nx >> FP_BITS, ny >> FP_BITS)) {
            // something new stands in the way — replan next tick
            e.path.length = 0;
            e.repath = 0;
            break;
          }
          e.x = nx; e.y = ny;
          budget = 0;
        }
      }
    }
  }

  private resolveCollisions() {
    const size = this.size;
    for (const [ti, ids] of this.buckets) {
      const bx = ti % size, by = (ti / size) | 0;
      for (const idA of ids) {
        const a = this.entities.get(idA);
        if (!a) continue;
        const ra = UNITS[a.type as UnitTypeId].radius;
        // compare against neighbors in this + east/south buckets to visit each pair once
        for (const [ox, oy] of NEIGHBOR_OFFSETS) {
          const nx = bx + ox, ny = by + oy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const others = this.buckets.get(ny * size + nx);
          if (!others) continue;
          for (const idB of others) {
            if (ox === 0 && oy === 0 && idB <= idA) continue;
            const b = this.entities.get(idB);
            if (!b) continue;
            const rb = UNITS[b.type as UnitTypeId].radius;
            const want = ra + rb;
            const d2 = distSq(a.x, a.y, b.x, b.y);
            if (d2 >= want * want) continue;
            const dd = isqrt(d2);
            let px: number, py: number;
            if (dd === 0) {
              // exactly stacked: deterministic pseudo-direction from ids
              const k = (idA * 7 + idB * 13) % 32;
              px = (dirCos(k) * PUSH_MAX) >> 12;
              py = (dirSin(k) * PUSH_MAX) >> 12;
            } else {
              // soft separation, capped so walkers can squeeze past a crowd
              // instead of deadlocking against it
              const overlap = want - dd;
              [px, py] = scaleTo(a.x - b.x, a.y - b.y, Math.min((overlap >> 1) + 1, PUSH_MAX));
            }
            // moving units shoulder through: the stander takes most of the push
            const aMoving = a.path.length > 0;
            const bMoving = b.path.length > 0;
            let wa = 5, wb = 5;
            if (aMoving && !bMoving) { wa = 2; wb = 8; }
            else if (!aMoving && bMoving) { wa = 8; wb = 2; }
            this.nudge(a, Math.trunc((px * wa) / 5), Math.trunc((py * wa) / 5));
            this.nudge(b, -Math.trunc((px * wb) / 5), -Math.trunc((py * wb) / 5));
          }
        }
      }
    }
  }

  private nudge(u: Entity, dx: number, dy: number) {
    const nx = clamp(u.x + dx, FP / 4, (this.size << FP_BITS) - FP / 4);
    const ny = clamp(u.y + dy, FP / 4, (this.size << FP_BITS) - FP / 4);
    if (!this.grid.isBlocked(nx >> FP_BITS, ny >> FP_BITS)) {
      u.x = nx;
      u.y = ny;
    }
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  private offsetsFor(radius: number): Int16Array {
    let o = this.sightOffsets.get(radius);
    if (o) return o;
    const list: number[] = [];
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        if (i * i + j * j <= radius * radius + radius) list.push(i, j);
      }
    }
    o = new Int16Array(list);
    this.sightOffsets.set(radius, o);
    return o;
  }

  private updateVisibility(first: boolean) {
    for (const vis of this.visibility) {
      for (let i = 0; i < vis.length; i++) if (vis[i] === 2) vis[i] = 1;
    }
    for (const e of this.entities.values()) {
      if (e.owner < 0) continue;
      if (e.kind === 'unit' && e.garrisonedIn) continue;
      let sight = 0;
      if (e.kind === 'unit') sight = UNITS[e.type as UnitTypeId].sight;
      else if (e.kind === 'building') {
        sight = this.isBuildingComplete(e) ? BUILDINGS[e.type as BuildingTypeId].sight : 2;
      } else continue;
      const vis = this.visibility[e.owner];
      const cx = e.x >> FP_BITS, cy = e.y >> FP_BITS;
      const offs = this.offsetsFor(sight);
      for (let k = 0; k < offs.length; k += 2) {
        const x = cx + offs[k], y = cy + offs[k + 1];
        if (x >= 0 && y >= 0 && x < this.size && y < this.size) vis[y * this.size + x] = 2;
      }
    }
    if (first) return;
  }

  // -------------------------------------------------------------------------
  // Victory
  // -------------------------------------------------------------------------

  private checkVictory() {
    for (const p of this.players) {
      if (!p.alive) continue;
      let buildings = 0, units = 0;
      for (const e of this.entities.values()) {
        if (e.owner !== p.id) continue;
        if (e.kind === 'building') buildings++;
        else if (e.kind === 'unit') units++;
      }
      if (p.resigned || (buildings === 0 && units === 0)) {
        p.alive = false;
        this.ev('playerDefeated', 0, 0, { player: p.id });
        // remaining entities of a defeated player are removed
        for (const e of [...this.entities.values()]) {
          if (e.owner === p.id) this.kill(e, -1);
        }
      }
    }
    const alive = this.players.filter((p) => p.alive);
    if (!this.gameOver && alive.length <= 1 && this.players.length > 1) {
      this.gameOver = true;
      this.winner = alive.length === 1 ? alive[0].id : -1;
      this.ev('gameOver', 0, 0, { data: this.winner });
    }
  }

  // -------------------------------------------------------------------------
  // State hash (desync detection)
  // -------------------------------------------------------------------------

  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v & 0xffff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >> 16) & 0xffff;
      h = Math.imul(h, 0x01000193);
    };
    mix(this.tick);
    mix(this.prng.state);
    for (const p of this.players) {
      mix(p.stock.food); mix(p.stock.wood); mix(p.stock.gold); mix(p.stock.stone);
      mix(p.age + (p.alive ? 16 : 0));
      mix(p.pop + p.popCap * 256);
      mix(p.villagerPop + p.militaryPop * 256);
      mix(this.aiStates[p.id].lastWave);
    }
    for (const e of this.entities.values()) {
      mix(e.id);
      mix(e.x); mix(e.y);
      mix(e.hp);
      mix(e.owner + 2);
      mix(ORDER_INDEX[e.order] + (e.targetId << 3));
      mix(e.carry + e.amount * 64 + e.buildProgress + ROLE_INDEX[e.villagerRole] * 0x100000);
      mix(e.attackCd + e.swingTick * 512);
      mix(e.trainQueue.length + (e.trainQueue.length ? e.trainQueue[0].progress << 3 : 0));
      mix(e.rallyTargetId + (RESOURCE_INDEX[e.rallyResource] << 20));
    }
    return h >>> 0;
  }
}

const ORDER_INDEX: Record<Entity['order'], number> = {
  idle: 0, move: 1, attackmove: 2, attack: 3, gather: 4, build: 5,
};

const RESOURCE_INDEX: Record<Resource | '', number> = { '': 0, food: 1, wood: 2, gold: 3, stone: 4 };
const ROLE_INDEX: Record<VillagerRole, number> = { food: 0, wood: 1, gold: 2, stone: 3, builder: 4 };

const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [0, 1], [1, 1], [-1, 1],
];

/**
 * Deterministic spread offsets so a group move doesn't send everyone to the
 * exact same point: hex-ish spiral in fixed-point around the target.
 */
export function formationOffset(i: number, count: number): [number, number] {
  if (count <= 1 || i === 0) return [0, 0];
  let ring = 1, idx = i - 1, cap = 6;
  while (idx >= cap) { idx -= cap; ring++; cap = ring * 6; }
  const k = Math.trunc((32 * idx) / cap);
  const r = fp(0.62) * ring;
  return [(r * dirCos(k)) >> 12, (r * dirSin(k)) >> 12];
}
