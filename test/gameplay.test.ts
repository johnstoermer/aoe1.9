import { describe, expect, it } from 'vitest';
import { BUILDINGS, UNITS } from '../src/shared/data';
import { FP_BITS, fp } from '../src/shared/fixed';
import { World } from '../src/shared/sim';
import type { Entity, GameSetup } from '../src/shared/types';

function makeWorld(seed = 7): World {
  const setup: GameSetup = {
    seed,
    mapSize: 64,
    players: [
      { name: 'Human', color: 0, isAI: false, aiLevel: 0 },
      { name: 'Enemy', color: 1, isAI: false, aiLevel: 0 },
    ],
  };
  return new World(setup);
}

function tickN(w: World, n: number, cmdsAt: Record<number, Parameters<World['applyCommand']>[]> = {}) {
  const start = w.tick;
  for (let i = 0; i < n; i++) {
    const t = w.tick;
    w.step({ tick: t, commands: [] });
    const cmds = cmdsAt[t - start];
    if (cmds) for (const [player, cmd] of cmds) w.applyCommand(player, cmd);
  }
}

function firstOwn(w: World, owner: number, pred: (e: Entity) => boolean): Entity {
  for (const e of w.entities.values()) {
    if (e.owner === owner && pred(e)) return e;
  }
  throw new Error('entity not found');
}

function nearestNode(w: World, type: string, x: number, y: number): Entity {
  let best: Entity | null = null;
  let bd = Infinity;
  for (const e of w.entities.values()) {
    if (e.kind !== 'resource' || e.type !== type) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best!;
}

describe('gameplay flows', () => {
  it('villagers gather wood and deposit it at the town center', () => {
    const w = makeWorld();
    const tc = firstOwn(w, 0, (e) => e.type === 'towncenter');
    const tree = nearestNode(w, 'tree', tc.x, tc.y);
    const villagers = [...w.entities.values()].filter((e) => e.kind === 'unit' && e.owner === 0);
    w.applyCommand(0, { t: 'gather', units: villagers.map((v) => v.id), target: tree.id });
    const wood0 = w.players[0].stock.wood;
    tickN(w, 1200);
    expect(w.players[0].stock.wood).toBeGreaterThan(wood0);
    expect(w.players[0].stats.gathered.wood).toBeGreaterThan(0);
  });

  it('a house foundation is built by villagers and raises the pop cap', () => {
    const w = makeWorld();
    const tc = firstOwn(w, 0, (e) => e.type === 'towncenter');
    const villagers = [...w.entities.values()].filter((e) => e.kind === 'unit' && e.owner === 0);
    const capBefore = 5;
    // find a legal spot near the TC
    let placed = false;
    outer:
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const tx = (tc.x >> FP_BITS) + dx, ty = (tc.y >> FP_BITS) + dy;
        if (w.canPlaceBuilding(0, 'house', tx, ty)) {
          w.applyCommand(0, { t: 'build', units: villagers.map((v) => v.id), building: 'house', tx, ty });
          placed = true;
          break outer;
        }
      }
    }
    expect(placed).toBe(true);
    expect(w.players[0].stock.wood).toBe(250 - BUILDINGS.house.cost.wood!);
    tickN(w, BUILDINGS.house.buildTime * 3);
    expect(w.players[0].popCap).toBeGreaterThan(capBefore);
  });

  it('the town center trains villagers over time and spends food', () => {
    const w = makeWorld();
    const tc = firstOwn(w, 0, (e) => e.type === 'towncenter');
    tickN(w, 1); // populate per-tick counters
    const before = w.players[0].pop;
    w.applyCommand(0, { t: 'train', building: tc.id, unit: 'villager' });
    expect(w.players[0].stock.food).toBe(250 - UNITS.villager.cost.food!);
    tickN(w, UNITS.villager.trainTime + 20);
    expect(w.players[0].pop).toBe(before + 1);
  });

  it('militia beats a villager in a straight fight', () => {
    const w = makeWorld();
    const villager = firstOwn(w, 0, (e) => e.kind === 'unit');
    // conjure an enemy militia next to it (test-only backdoor)
    const militia = w.createUnit(1, 'militia', villager.x + fp(1), villager.y);
    w.applyCommand(1, { t: 'attack', units: [militia.id], target: villager.id });
    tickN(w, 300);
    expect(w.entities.has(villager.id)).toBe(false);
    expect(w.entities.has(militia.id)).toBe(true);
    expect(w.players[1].stats.unitsKilled).toBe(1);
  });

  it('losing every building and unit defeats the player and ends the game', () => {
    const w = makeWorld();
    // hand player 1 an army of champions parked on player 0's base
    const tc0 = firstOwn(w, 0, (e) => e.type === 'towncenter');
    const troops: number[] = [];
    for (let i = 0; i < 8; i++) {
      const u = w.createUnit(1, 'champion', tc0.x + fp(2 + (i % 3)), tc0.y + fp(i % 2 ? 2 : -2));
      troops.push(u.id);
    }
    w.applyCommand(1, { t: 'attackmove', units: troops, x: tc0.x, y: tc0.y });
    tickN(w, 3000);
    expect(w.players[0].alive).toBe(false);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(1);
  });

  it('research advances the age and unlocks age-gated units', () => {
    const w = makeWorld();
    const tc = firstOwn(w, 0, (e) => e.type === 'towncenter');
    w.players[0].stock.food = 5000;
    w.players[0].stock.gold = 5000;
    w.applyCommand(0, { t: 'research', building: tc.id, tech: 'age2' });
    expect(w.techPending(0, 'age2')).toBe(true);
    tickN(w, 800);
    expect(w.players[0].age).toBe(1);
    w.applyCommand(0, { t: 'research', building: tc.id, tech: 'age3' });
    tickN(w, 1100);
    expect(w.players[0].age).toBe(2);
  });

  it('rejects invalid commands: foreign units, bad placement, unaffordable', () => {
    const w = makeWorld();
    const enemyUnit = firstOwn(w, 1, (e) => e.kind === 'unit');
    const before = w.hash();
    // trying to move the opponent's villager does nothing
    w.applyCommand(0, { t: 'move', units: [enemyUnit.id], x: 1000, y: 1000 });
    // placing a building on the town center does nothing
    const tc = firstOwn(w, 0, (e) => e.type === 'towncenter');
    w.applyCommand(0, { t: 'build', units: [firstOwn(w, 0, (e) => e.kind === 'unit').id], building: 'house', tx: tc.tileX, ty: tc.tileY });
    // researching an age we cannot afford does nothing
    w.players[0].stock.food = 0;
    w.applyCommand(0, { t: 'research', building: tc.id, tech: 'age2' });
    w.players[0].stock.food = 250;
    expect(w.hash()).toBe(before);
  });
});
