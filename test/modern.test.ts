import { describe, expect, it } from 'vitest';
import { BUILDINGS, UNITS } from '../src/shared/data';
import { FP_BITS } from '../src/shared/fixed';
import { World } from '../src/shared/sim';
import type { BuildingTypeId, Entity, GameSetup, VillagerRole } from '../src/shared/types';
import { MODERN_MILITARY_CAP, MODERN_VILLAGER_CAP, VILLAGER_ROLES } from '../src/shared/types';

function makeModern(seed = 29): World {
  const setup: GameSetup = {
    seed,
    mapSize: 64,
    mode: 'modern',
    players: [
      { name: 'Modern', color: 0, isAI: false, aiLevel: 0 },
      { name: 'Enemy', color: 1, isAI: false, aiLevel: 0 },
    ],
  };
  return new World(setup);
}

function tick(world: World, count: number) {
  for (let index = 0; index < count; index++) world.step({ tick: world.tick, commands: [] });
}

function own(world: World, predicate: (entity: Entity) => boolean): Entity[] {
  return [...world.entities.values()].filter((entity) => entity.owner === 0 && predicate(entity));
}

function roleCounts(world: World): Record<VillagerRole, number> {
  const counts = Object.fromEntries(VILLAGER_ROLES.map((role) => [role, 0])) as Record<VillagerRole, number>;
  for (const villager of own(world, (entity) => entity.kind === 'unit' && entity.type === 'villager')) counts[villager.villagerRole]++;
  return counts;
}

function legalSpot(world: World, type: BuildingTypeId): { tx: number; ty: number } {
  const townCenter = own(world, (entity) => entity.type === 'towncenter')[0];
  for (let radius = 4; radius < 16; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const tx = (townCenter.x >> FP_BITS) + x;
        const ty = (townCenter.y >> FP_BITS) + y;
        if (world.canPlaceBuilding(0, type, tx, ty)) return { tx, ty };
      }
    }
  }
  throw new Error(`no legal ${type} location`);
}

describe('modern mode economy', () => {
  it('starts with one autonomous villager in every role', () => {
    const world = makeModern();
    expect(own(world, (entity) => entity.type === 'villager')).toHaveLength(5);
    expect(roleCounts(world)).toEqual({ food: 1, wood: 1, gold: 1, stone: 1, builder: 1 });
  });

  it('automatically pays for and trains villagers while manual training is rejected', () => {
    const world = makeModern();
    const townCenter = own(world, (entity) => entity.type === 'towncenter')[0];
    tick(world, 1);
    expect(townCenter.trainQueue.filter((item) => item.unit === 'villager')).toHaveLength(1);
    expect(world.players[0].stock.food).toBe(200);
    world.applyCommand(0, { t: 'train', building: townCenter.id, unit: 'villager' });
    expect(townCenter.trainQueue.filter((item) => item.unit === 'villager')).toHaveLength(1);
    tick(world, UNITS.villager.trainTime + 2);
    expect(world.players[0].villagerPop).toBe(6);
    expect(roleCounts(world).food).toBe(2);
  });

  it('sends new villagers to the selected role and defaults that selection to Farmer', () => {
    const world = makeModern();
    expect(world.players[0].villagerSpawnRole).toBe('food');
    world.applyCommand(0, { t: 'setVillagerSpawnRole', role: 'wood' });
    expect(world.players[0].villagerSpawnRole).toBe('wood');
    tick(world, UNITS.villager.trainTime + 3);
    expect(roleCounts(world).wood).toBe(2);
    expect(roleCounts(world).food).toBe(1);
  });

  it('gathers directly into stock without any drop-off building', () => {
    const world = makeModern();
    tick(world, 1);
    const before = world.players[0].stock.wood;
    tick(world, 1600);
    expect(world.players[0].stock.wood).toBeGreaterThan(before);
    expect(world.players[0].stats.gathered.wood).toBeGreaterThan(0);
    const woodcutter = own(world, (entity) => entity.type === 'villager' && entity.villagerRole === 'wood')[0];
    expect(woodcutter.carry).toBe(0);
  });

  it('rejects direct villager movement, gathering, stopping, and deletion', () => {
    const world = makeModern();
    tick(world, 1);
    const villager = own(world, (entity) => entity.type === 'villager' && entity.villagerRole === 'wood')[0];
    const originalOrder = villager.order;
    const originalTarget = villager.targetId;
    world.applyCommand(0, { t: 'move', units: [villager.id], x: 1, y: 1 });
    world.applyCommand(0, { t: 'stop', units: [villager.id] });
    world.applyCommand(0, { t: 'delete', id: villager.id });
    expect(world.entities.has(villager.id)).toBe(true);
    expect(villager.order).toBe(originalOrder);
    expect(villager.targetId).toBe(originalTarget);
  });

  it('places buildings globally and builder-role villagers complete them', () => {
    const world = makeModern();
    const spot = legalSpot(world, 'barracks');
    world.applyCommand(0, { t: 'build', units: [], building: 'barracks', ...spot });
    const barracks = own(world, (entity) => entity.type === 'barracks')[0];
    expect(barracks).toBeDefined();
    tick(world, 2);
    const builder = own(world, (entity) => entity.type === 'villager' && entity.villagerRole === 'builder')[0];
    expect(builder.order).toBe('build');
    expect(builder.targetId).toBe(barracks.id);
    tick(world, BUILDINGS.barracks.buildTime + 900);
    expect(world.isBuildingComplete(barracks)).toBe(true);
  });

  it('forbids extra town centers, farms, houses, and resource drop-off camps', () => {
    const world = makeModern();
    for (const type of ['towncenter', 'farm', 'house', 'lumbercamp', 'minecamp'] as BuildingTypeId[]) {
      const before = own(world, (entity) => entity.type === type).length;
      expect(world.canPlaceBuilding(0, type, 1, 1)).toBe(false);
      world.applyCommand(0, { t: 'build', units: [], building: type, tx: 1, ty: 1 });
      expect(own(world, (entity) => entity.type === type)).toHaveLength(before);
    }
  });

  it('defeats a Modern player when their town center is destroyed', () => {
    const world = makeModern();
    const townCenter = own(world, (entity) => entity.type === 'towncenter')[0];
    world.applyCommand(0, { t: 'delete', id: townCenter.id });
    tick(world, 1);
    expect(world.players[0].alive).toBe(false);
    expect(world.gameOver).toBe(true);
    expect(world.winner).toBe(1);
  });

  it('reallocates roles without allowing any role below one', () => {
    const world = makeModern();
    const townCenter = own(world, (entity) => entity.type === 'towncenter')[0];
    world.createUnit(0, 'villager', townCenter.x, townCenter.y);
    expect(roleCounts(world).food).toBe(2);
    world.applyCommand(0, { t: 'allocateVillager', role: 'wood', delta: 1 });
    expect(roleCounts(world)).toEqual({ food: 1, wood: 2, gold: 1, stone: 1, builder: 1 });
    world.applyCommand(0, { t: 'allocateVillager', role: 'food', delta: -1 });
    expect(roleCounts(world).food).toBe(1);
  });

  it('tracks independent 25-villager and 200-military caps', () => {
    const world = makeModern();
    const townCenter = own(world, (entity) => entity.type === 'towncenter')[0];
    for (let index = 5; index < MODERN_VILLAGER_CAP; index++) world.createUnit(0, 'villager', townCenter.x, townCenter.y);
    for (let index = 0; index < MODERN_MILITARY_CAP; index++) world.createUnit(0, 'barbarian', townCenter.x, townCenter.y);
    tick(world, 1);
    expect(world.players[0].villagerPop).toBe(MODERN_VILLAGER_CAP);
    expect(world.players[0].militaryPop).toBe(MODERN_MILITARY_CAP);
    expect(world.players[0].pop).toBe(MODERN_MILITARY_CAP);
    expect(world.players[0].popCap).toBe(MODERN_MILITARY_CAP);
    expect(townCenter.trainQueue.some((item) => item.unit === 'villager')).toBe(false);
    const spot = legalSpot(world, 'barracks');
    const barracks = world.createBuilding(0, 'barracks', spot.tx, spot.ty, true);
    world.applyCommand(0, { t: 'train', building: barracks.id, unit: 'barbarian' });
    expect(barracks.trainQueue).toHaveLength(0);
  });

  it('lets Modern AI rebalance, advance, construct, and field an army', () => {
    const world = new World({
      seed: 8080,
      mapSize: 64,
      mode: 'modern',
      players: [
        { name: 'AI 1', color: 0, isAI: true, aiLevel: 1 },
        { name: 'AI 2', color: 1, isAI: true, aiLevel: 1 },
      ],
    });
    tick(world, 7000);
    for (const player of world.players) {
      expect(player.villagerPop).toBe(MODERN_VILLAGER_CAP);
      expect(player.age).toBeGreaterThanOrEqual(1);
      expect(player.militaryPop).toBeGreaterThan(0);
    }
  });
});
