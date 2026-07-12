// Scripted skirmish AI. Runs inside the deterministic sim (identically on
// every client), issuing the same validated commands a human would. Classic
// "computer player" rules: it sees the whole map but plays by the same
// economy/combat mechanics.

import { BUILDINGS, RESOURCE_NODES, TECHS, UNITS, totalBuildTicks } from './data';
import { FP_BITS, distSq, fp } from './fixed';
import type { World } from './sim';
import type { BuildingTypeId, Entity, Resource, TechId, UnitTypeId } from './types';
import { TICK_RATE } from './types';

interface AiTuning {
  villagerTarget: [number, number, number]; // per age
  ageUpVillagers: [number, number];         // villagers needed before age2/age3
  waveCooldown: number;                     // ticks between attacks
  waveStart: number;                        // first wave size
  waveMax: number;
  maxFarms: [number, number, number];
}

const TUNING: AiTuning[] = [
  { // easy
    villagerTarget: [12, 14, 16], ageUpVillagers: [12, 15],
    waveCooldown: 100 * TICK_RATE, waveStart: 5, waveMax: 10, maxFarms: [4, 6, 8],
  },
  { // normal
    villagerTarget: [16, 20, 24], ageUpVillagers: [15, 19],
    waveCooldown: 60 * TICK_RATE, waveStart: 6, waveMax: 18, maxFarms: [6, 10, 12],
  },
  { // hard
    villagerTarget: [18, 24, 28], ageUpVillagers: [14, 20],
    waveCooldown: 40 * TICK_RATE, waveStart: 7, waveMax: 26, maxFarms: [7, 12, 16],
  },
];

const GATHER_SHARE: Record<number, Record<Resource, number>> = {
  0: { food: 55, wood: 33, gold: 12, stone: 0 },
  1: { food: 44, wood: 32, gold: 20, stone: 4 },
  2: { food: 40, wood: 30, gold: 24, stone: 6 },
};

export function aiThink(world: World, pid: number) {
  const p = world.players[pid];
  const tune = TUNING[Math.min(p.aiLevel, TUNING.length - 1)];

  // ---- survey our empire -----------------------------------------------
  const villagers: Entity[] = [];
  const military: Entity[] = [];
  const buildings = new Map<BuildingTypeId, Entity[]>();
  let tc: Entity | null = null;
  for (const e of world.entities.values()) {
    if (e.owner !== pid) continue;
    if (e.kind === 'unit') {
      (e.type === 'villager' ? villagers : military).push(e);
    } else if (e.kind === 'building') {
      const list = buildings.get(e.type as BuildingTypeId) ?? [];
      list.push(e);
      buildings.set(e.type as BuildingTypeId, list);
      if (e.type === 'towncenter' && world.isBuildingComplete(e)) tc = e;
    }
  }
  if (!tc) {
    // town center lost: no economy left to run, but the army keeps fighting
    const anchor = [...buildings.values()].flat()[0] ?? military[0];
    if (anchor) directArmy(world, pid, military, anchor, tune);
    return;
  }

  const has = (t: BuildingTypeId) => (buildings.get(t) ?? []).some((b) => world.isBuildingComplete(b));
  const countAll = (t: BuildingTypeId) => (buildings.get(t) ?? []).length;
  const completed = (t: BuildingTypeId) => (buildings.get(t) ?? []).filter((b) => world.isBuildingComplete(b));

  // ---- economy: keep villagers busy and balanced -------------------------
  assignGatherers(world, pid, villagers, tc, tune);

  // housing ahead of demand
  if (p.popCap < 75 && p.popCap - p.pop < 4 && !hasFoundation(buildings, 'house')) {
    tryBuild(world, pid, villagers, 'house', tc, 9);
  }

  // drop-off camps near far woodlines/mines
  buildCampsIfWorthIt(world, pid, villagers, buildings);

  // farms once wild food thins out
  const farms = countAll('farm');
  if (farms < tune.maxFarms[p.age] && wildFoodNear(world, tc) < 3 && !hasFoundation(buildings, 'farm')) {
    tryBuild(world, pid, villagers, 'farm', tc, 8);
  }

  // ---- military production chain -----------------------------------------
  if (villagers.length >= 8 && countAll('barracks') === 0) tryBuild(world, pid, villagers, 'barracks', tc, 12);
  if (p.age >= 1) {
    if (countAll('blacksmith') === 0) tryBuild(world, pid, villagers, 'blacksmith', tc, 10);
    if (countAll('archeryrange') === 0 && has('barracks')) tryBuild(world, pid, villagers, 'archeryrange', tc, 12);
  }
  if (p.age >= 2) {
    if (countAll('workshop') === 0 && has('archeryrange')) tryBuild(world, pid, villagers, 'workshop', tc, 12);
    if (countAll('barracks') === 1 && p.stock.wood > 400) tryBuild(world, pid, villagers, 'barracks', tc, 12);
  }

  // ---- research -----------------------------------------------------------
  researchWants(world, pid, tc, completed('blacksmith')[0], villagers.length, tune);

  // ---- training -----------------------------------------------------------
  const villTarget = tune.villagerTarget[p.age];
  for (const b of completed('towncenter')) {
    if (villagers.length < villTarget && b.trainQueue.length < 2 && world.canAfford(pid, UNITS.villager.cost)) {
      world.applyCommand(pid, { t: 'train', building: b.id, unit: 'villager' });
    }
  }
  // once the economy can support aging up, bank food instead of spending
  // every scrap on troops
  const savingForAge =
    (p.age === 0 && villagers.length >= tune.ageUpVillagers[0] && !world.techPending(pid, 'age2'))
    || (p.age === 1 && villagers.length >= tune.ageUpVillagers[1] && !world.techPending(pid, 'age3'));
  trainMilitary(world, pid, completed, savingForAge);

  // ---- combat --------------------------------------------------------------
  directArmy(world, pid, military, tc, tune);
}

// --------------------------------------------------------------------------

function hasFoundation(buildings: Map<BuildingTypeId, Entity[]>, t: BuildingTypeId): boolean {
  return (buildings.get(t) ?? []).some((b) => b.buildProgress < totalBuildTicks(t));
}

/** Count wild food (berries) within ~10 tiles of the TC. */
function wildFoodNear(world: World, tc: Entity): number {
  let n = 0;
  for (const e of world.entities.values()) {
    if (e.kind === 'resource' && e.type === 'berries' && e.amount > 0
      && distSq(e.x, e.y, tc.x, tc.y) < fp(11) * fp(11)) n++;
  }
  return n;
}

function assignGatherers(world: World, pid: number, villagers: Entity[], tc: Entity, tune: AiTuning) {
  const p = world.players[pid];
  const share = GATHER_SHARE[p.age];

  // current allocation, by what each gatherer's target yields
  const counts: Record<Resource, number> = { food: 0, wood: 0, gold: 0, stone: 0 };
  const idle: Entity[] = [];
  let working = 0;
  for (const v of villagers) {
    if (v.order === 'gather') {
      const t = world.entities.get(v.targetId);
      const gives: Resource | null = t
        ? (t.kind === 'resource' ? RESOURCE_NODES[t.type as keyof typeof RESOURCE_NODES].gives
          : t.type === 'farm' ? 'food' : null)
        : null;
      if (gives) { counts[gives]++; working++; }
    } else if (v.order === 'idle') {
      idle.push(v);
    } else if (v.order === 'build') {
      working++;
    }
  }

  const total = Math.max(1, working + idle.length);
  // don't keep piling onto a resource we're already hoarding
  const effShare = (r: Resource) => (p.stock[r] > 800 ? Math.min(share[r], 6) : share[r]);
  const want = (r: Resource) => Math.round((effShare(r) * total) / 100);

  // how crowded each node already is, so assignments spread out
  const crowd = new Map<number, number>();
  for (const v of villagers) {
    if (v.order === 'gather' && v.targetId) crowd.set(v.targetId, (crowd.get(v.targetId) ?? 0) + 1);
  }

  // send idle villagers at the biggest deficit first
  for (const v of idle) {
    let bestR: Resource | null = null;
    let bestDeficit = 0;
    for (const r of ['food', 'wood', 'gold', 'stone'] as Resource[]) {
      const deficit = want(r) - counts[r];
      if (deficit > bestDeficit) { bestDeficit = deficit; bestR = r; }
    }
    const target = bestR ?? 'food';
    const node = nearestGatherTarget(world, pid, tc.x, tc.y, target, crowd);
    if (node) {
      world.applyCommand(pid, { t: 'gather', units: [v.id], target: node.id });
      crowd.set(node.id, (crowd.get(node.id) ?? 0) + 1);
      counts[target]++;
    }
  }
}

function nearestGatherTarget(
  world: World, pid: number, x: number, y: number, gives: Resource,
  crowd?: Map<number, number>,
): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of world.entities.values()) {
    let ok = false;
    if (e.kind === 'resource' && e.amount > 0) ok = RESOURCE_NODES[e.type as keyof typeof RESOURCE_NODES].gives === gives;
    else if (e.kind === 'building' && e.type === 'farm' && e.owner === pid && world.isBuildingComplete(e)) ok = gives === 'food';
    if (!ok) continue;
    // a busy node counts as farther away, spreading gatherers out
    const busy = crowd?.get(e.id) ?? 0;
    const d2 = distSq(e.x, e.y, x, y) + busy * busy * fp(5) * fp(5);
    if (d2 < bestD) { bestD = d2; best = e; }
  }
  return best;
}

/** Place a drop-off camp when gatherers walk too far with their loads. */
function buildCampsIfWorthIt(world: World, pid: number, villagers: Entity[], buildings: Map<BuildingTypeId, Entity[]>) {
  for (const [camp, kinds] of [['lumbercamp', ['wood']], ['minecamp', ['gold', 'stone']]] as
    [BuildingTypeId, Resource[]][]) {
    if (hasFoundation(buildings, camp)) continue;
    if (!world.canAfford(pid, BUILDINGS[camp].cost)) continue;
    // find a gatherer of the right kind whose node is far from every drop-off
    for (const v of villagers) {
      if (v.order !== 'gather') continue;
      const node = world.entities.get(v.targetId);
      if (!node || node.kind !== 'resource') continue;
      const gives = RESOURCE_NODES[node.type as keyof typeof RESOURCE_NODES].gives;
      if (!kinds.includes(gives)) continue;
      if (nearestDropDistSq(world, pid, gives, node.x, node.y) > fp(6) * fp(6)) {
        tryBuildAt(world, pid, [v], camp, node.x >> FP_BITS, node.y >> FP_BITS, 4);
        return;
      }
    }
  }
}

function nearestDropDistSq(world: World, pid: number, kind: Resource, x: number, y: number): number {
  let best = Infinity;
  for (const e of world.entities.values()) {
    if (e.kind !== 'building' || e.owner !== pid || !world.isBuildingComplete(e)) continue;
    const drop = BUILDINGS[e.type as BuildingTypeId].dropOff;
    if (!drop || !drop.includes(kind)) continue;
    const d2 = distSq(e.x, e.y, x, y);
    if (d2 < best) best = d2;
  }
  return best;
}

function tryBuild(world: World, pid: number, villagers: Entity[], type: BuildingTypeId, near: Entity, radius: number): boolean {
  return tryBuildAt(world, pid, villagers, type, near.x >> FP_BITS, near.y >> FP_BITS, radius);
}

function tryBuildAt(world: World, pid: number, villagers: Entity[], type: BuildingTypeId, cx: number, cy: number, radius: number): boolean {
  if (!world.canAfford(pid, BUILDINGS[type].cost)) return false;
  const spot = findSpot(world, pid, type, cx, cy, radius);
  if (!spot) return false;
  // send the nearest non-military-critical villager (prefer idle, then gatherers)
  const builder = pickBuilder(world, villagers, spot.x, spot.y);
  if (!builder) return false;
  world.applyCommand(pid, { t: 'build', units: [builder.id], building: type, tx: spot.x, ty: spot.y });
  return true;
}

function pickBuilder(world: World, villagers: Entity[], tx: number, ty: number): Entity | null {
  let best: Entity | null = null;
  let bestScore = Infinity;
  for (const v of villagers) {
    if (v.order === 'build') continue;
    const d2 = distSq(v.x, v.y, (tx << FP_BITS), (ty << FP_BITS));
    const score = d2 + (v.order === 'idle' ? 0 : fp(6) * fp(6));
    if (score < bestScore) { bestScore = score; best = v; }
  }
  return best;
}

/** Spiral out from (cx, cy) looking for a legal placement. Deterministic scan. */
function findSpot(world: World, pid: number, type: BuildingTypeId, cx: number, cy: number, radius: number): { x: number; y: number } | null {
  for (let r = 2; r <= radius; r++) {
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const x = cx + i, y = cy + j;
        if (world.canPlaceBuilding(pid, type, x, y)) return { x, y };
      }
    }
  }
  return null;
}

function researchWants(world: World, pid: number, tc: Entity, smith: Entity | undefined, villCount: number, tune: AiTuning) {
  const p = world.players[pid];
  // age up
  if (p.age === 0 && villCount >= tune.ageUpVillagers[0] && !world.techPending(pid, 'age2')
    && world.canAfford(pid, TECHS.age2.cost) && tc.trainQueue.length === 0) {
    world.applyCommand(pid, { t: 'research', building: tc.id, tech: 'age2' });
  } else if (p.age === 1 && villCount >= tune.ageUpVillagers[1] && !world.techPending(pid, 'age3')
    && world.canAfford(pid, TECHS.age3.cost) && tc.trainQueue.length === 0) {
    world.applyCommand(pid, { t: 'research', building: tc.id, tech: 'age3' });
  }
  // blacksmith line, opportunistically, keeping a food buffer for aging up
  if (!smith) return;
  if (smith.trainQueue.length > 0) return;
  const wants: TechId[] = ['forging', 'fletching', 'scalearmor', 'ironcasting', 'bodkin', 'chainarmor'];
  for (const t of wants) {
    const d = TECHS[t];
    if (p.age < d.age || world.techPending(pid, t)) continue;
    if (d.requires && !world.hasTech(pid, d.requires)) continue;
    if (!world.canAfford(pid, { ...d.cost, food: (d.cost.food ?? 0) + 250 })) continue;
    world.applyCommand(pid, { t: 'research', building: smith.id, tech: t });
    return;
  }
}

function trainMilitary(
  world: World, pid: number,
  completed: (t: BuildingTypeId) => Entity[], savingForAge: boolean,
) {
  const p = world.players[pid];
  // keep a buffer so military doesn't starve the age-up
  const reserve = savingForAge ? 420 : p.age < 2 ? 120 : 0;
  const buffered = (u: UnitTypeId) => {
    const c = UNITS[u].cost;
    return world.canAfford(pid, { ...c, food: (c.food ?? 0) + reserve, gold: (c.gold ?? 0) + (savingForAge && p.age === 1 ? 160 : 0) });
  };
  for (const b of completed('barracks')) {
    if (b.trainQueue.length >= 2) continue;
    const unit: UnitTypeId = p.age >= 2
      ? (world.prng.int(2) === 0 ? 'knight' : 'vanguard')
      : (p.age >= 1 && world.prng.int(3) === 0 ? 'bruiser' : 'barbarian');
    if (UNITS[unit].age <= p.age && buffered(unit)) {
      world.applyCommand(pid, { t: 'train', building: b.id, unit });
    }
  }
  for (const b of completed('archeryrange')) {
    if (b.trainQueue.length >= 2) continue;
    const ranged: UnitTypeId = p.age >= 2 ? 'crossbowman' : 'bowman';
    if (buffered(ranged)) world.applyCommand(pid, { t: 'train', building: b.id, unit: ranged });
  }
  for (const b of completed('workshop')) {
    if (b.trainQueue.length >= 1) continue;
    if (buffered('catapult')) world.applyCommand(pid, { t: 'train', building: b.id, unit: 'catapult' });
  }
}

function directArmy(world: World, pid: number, military: Entity[], tc: Entity, tune: AiTuning) {
  const state = world.aiStates[pid];

  // defense first: enemies near our town center
  const intruder = world.findNearestEnemy(pid, tc.x, tc.y, fp(13), true);
  if (intruder && intruder.kind === 'unit') {
    const defenders = military.filter((m) => m.order === 'idle' || m.order === 'move');
    if (defenders.length > 0) {
      world.applyCommand(pid, {
        t: 'attackmove', units: defenders.map((d) => d.id), x: intruder.x, y: intruder.y,
      });
    }
    return;
  }

  // attack waves
  const idleArmy = military.filter((m) => m.order === 'idle');
  if (idleArmy.length >= state.waveSize && world.tick - state.lastWave >= tune.waveCooldown) {
    const target = nearestEnemyBuilding(world, pid, tc);
    if (target) {
      world.applyCommand(pid, {
        t: 'attackmove', units: idleArmy.map((m) => m.id), x: target.x, y: target.y,
      });
      state.lastWave = world.tick;
      state.waveSize = Math.min(state.waveSize + 3, tune.waveMax);
    }
  } else if (state.lastWave === 0) {
    state.waveSize = tune.waveStart;
  }
}

function nearestEnemyBuilding(world: World, pid: number, from: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of world.entities.values()) {
    if (e.kind !== 'building' || e.owner < 0 || e.owner === pid) continue;
    if (!world.players[e.owner].alive) continue;
    const d2 = distSq(e.x, e.y, from.x, from.y);
    if (d2 < bestD) { bestD = d2; best = e; }
  }
  return best;
}
