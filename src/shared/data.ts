// All gameplay numbers live here, in one data-driven table set, so balance
// tweaks and new content never touch system code.
//
// Conventions: times are sim ticks (15/s), distances/ranges are fixed-point
// tiles (fp), speeds are fp per tick, sight radii are whole tiles.

import { fp } from './fixed';
import type { BuildingTypeId, Resource, ResourceNodeTypeId, TechId, UnitTypeId } from './types';
import { TICK_RATE } from './types';

const secs = (s: number) => Math.round(s * TICK_RATE);
const speed = (tilesPerSec: number) => Math.round(fp(tilesPerSec) / TICK_RATE);

export type Cost = Partial<Record<Resource, number>>;

export interface UnitData {
  name: string;
  cost: Cost;
  trainTime: number;
  hp: number;
  attack: number;
  /** 'melee' swings; 'arrow'/'boulder' spawn projectiles. */
  attackKind: 'melee' | 'arrow' | 'boulder';
  attackRange: number;   // fp; melee reach beyond radii for melee units
  attackCd: number;      // ticks between swings
  swingTime: number;     // ticks from swing start to damage landing
  armor: number;
  speed: number;         // fp per tick
  radius: number;        // fp collision radius
  sight: number;         // tiles
  age: number;           // minimum age (0-based)
  building: BuildingTypeId; // trained at
  hotkey: string;
  splash?: number;       // fp splash radius (boulder)
  minRange?: number;     // fp
}

export const UNITS: Record<UnitTypeId, UnitData> = {
  villager: {
    name: 'Villager', cost: { food: 50 }, trainTime: secs(17),
    hp: 25, attack: 3, attackKind: 'melee', attackRange: fp(0.2), attackCd: secs(2.0),
    swingTime: secs(0.45), armor: 0, speed: speed(0.95), radius: fp(0.26), sight: 5,
    age: 0, building: 'towncenter', hotkey: 'v',
  },
  militia: {
    name: 'Man-at-Arms', cost: { food: 60, gold: 20 }, trainTime: secs(15),
    hp: 45, attack: 5, attackKind: 'melee', attackRange: fp(0.25), attackCd: secs(1.8),
    swingTime: secs(0.4), armor: 1, speed: speed(1.0), radius: fp(0.28), sight: 5,
    age: 0, building: 'barracks', hotkey: 'm',
  },
  archer: {
    name: 'Archer', cost: { wood: 25, gold: 45 }, trainTime: secs(20),
    hp: 30, attack: 4, attackKind: 'arrow', attackRange: fp(4.5), attackCd: secs(2.0),
    swingTime: secs(0.5), armor: 0, speed: speed(1.0), radius: fp(0.26), sight: 7,
    age: 1, building: 'archeryrange', hotkey: 'a',
  },
  champion: {
    name: 'Champion', cost: { food: 60, gold: 45 }, trainTime: secs(20),
    hp: 80, attack: 10, attackKind: 'melee', attackRange: fp(0.25), attackCd: secs(2.0),
    swingTime: secs(0.45), armor: 2, speed: speed(0.95), radius: fp(0.3), sight: 5,
    age: 2, building: 'barracks', hotkey: 'c',
  },
  catapult: {
    name: 'Catapult', cost: { wood: 160, gold: 135 }, trainTime: secs(30),
    hp: 60, attack: 35, attackKind: 'boulder', attackRange: fp(7), attackCd: secs(5),
    swingTime: secs(0.8), armor: 0, speed: speed(0.6), radius: fp(0.42), sight: 8,
    age: 2, building: 'workshop', hotkey: 't', splash: fp(1.1), minRange: fp(1.5),
  },
};

export interface BuildingData {
  name: string;
  cost: Cost;
  buildTime: number;     // villager-ticks of work
  hp: number;
  w: number;             // footprint in tiles
  h: number;
  sight: number;
  age: number;
  popCap?: number;       // population room provided
  dropOff?: Resource[];  // villager deposit point for these resources
  attack?: number;       // towers/TC/castle arrow damage
  attackRange?: number;  // fp
  attackCd?: number;
  provides?: ResourceNodeTypeId; // farm acts as a food node once built
  hotkey: string;
}

export const BUILDINGS: Record<BuildingTypeId, BuildingData> = {
  towncenter: {
    name: 'Town Center', cost: { wood: 350, stone: 100 }, buildTime: secs(90),
    hp: 2200, w: 3, h: 3, sight: 9, age: 2, popCap: 5,
    dropOff: ['food', 'wood', 'gold', 'stone'],
    attack: 5, attackRange: fp(6), attackCd: secs(1.9), hotkey: 'n',
  },
  house: {
    name: 'House', cost: { wood: 30 }, buildTime: secs(15),
    hp: 500, w: 2, h: 2, sight: 3, age: 0, popCap: 5, hotkey: 'e',
  },
  farm: {
    name: 'Farm', cost: { wood: 60 }, buildTime: secs(12),
    hp: 250, w: 2, h: 2, sight: 2, age: 0, provides: 'berries', hotkey: 'f',
  },
  lumbercamp: {
    name: 'Lumber Camp', cost: { wood: 100 }, buildTime: secs(20),
    hp: 600, w: 2, h: 2, sight: 4, age: 0, dropOff: ['wood'], hotkey: 'l',
  },
  minecamp: {
    name: 'Mining Camp', cost: { wood: 100 }, buildTime: secs(20),
    hp: 600, w: 2, h: 2, sight: 4, age: 0, dropOff: ['gold', 'stone'], hotkey: 'g',
  },
  barracks: {
    name: 'Barracks', cost: { wood: 175 }, buildTime: secs(35),
    hp: 1100, w: 3, h: 3, sight: 5, age: 0, hotkey: 'b',
  },
  archeryrange: {
    name: 'Archery Range', cost: { wood: 175 }, buildTime: secs(35),
    hp: 1000, w: 3, h: 3, sight: 5, age: 1, hotkey: 'r',
  },
  workshop: {
    name: 'Siege Workshop', cost: { wood: 200, stone: 50 }, buildTime: secs(40),
    hp: 1000, w: 3, h: 3, sight: 5, age: 2, hotkey: 'k',
  },
  blacksmith: {
    name: 'Blacksmith', cost: { wood: 150 }, buildTime: secs(30),
    hp: 900, w: 2, h: 2, sight: 4, age: 1, hotkey: 's',
  },
  watchtower: {
    name: 'Watchtower', cost: { wood: 50, stone: 125 }, buildTime: secs(35),
    hp: 850, w: 1, h: 1, sight: 9, age: 1,
    attack: 6, attackRange: fp(6.5), attackCd: secs(2.0), hotkey: 'w',
  },
  castle: {
    name: 'Castle', cost: { stone: 650 }, buildTime: secs(150),
    hp: 3500, w: 4, h: 4, sight: 10, age: 2,
    attack: 11, attackRange: fp(7.5), attackCd: secs(1.7), hotkey: 'x',
  },
};

export interface ResourceNodeData {
  name: string;
  amount: number;
  /** Which stockpile it fills. */
  gives: Resource;
  gatherTicks: number; // ticks per +1 resource
  radius: number;      // fp, for approach distance
  blocks: boolean;     // occupies its tile in the pathing grid
}

export const RESOURCE_NODES: Record<ResourceNodeTypeId, ResourceNodeData> = {
  tree:    { name: 'Tree',       amount: 100, gives: 'wood',  gatherTicks: secs(1.1), radius: fp(0.4), blocks: true },
  berries: { name: 'Berry Bush', amount: 150, gives: 'food',  gatherTicks: secs(1.2), radius: fp(0.4), blocks: true },
  gold:    { name: 'Gold Mine',  amount: 800, gives: 'gold',  gatherTicks: secs(1.3), radius: fp(0.5), blocks: true },
  stone:   { name: 'Stone Mine', amount: 600, gives: 'stone', gatherTicks: secs(1.3), radius: fp(0.5), blocks: true },
};

export const CARRY_CAPACITY = 10;
/** Farms never run dry; they just gather a bit slower than wild berries. */
export const FARM_GATHER_TICKS = secs(1.45);

export interface TechData {
  name: string;
  desc: string;
  cost: Cost;
  time: number;
  building: BuildingTypeId;
  age: number;
  requires?: TechId;
  hotkey: string;
}

export const TECHS: Record<TechId, TechData> = {
  age2: {
    name: 'Feudal Age', desc: 'Advance to Age II. Unlocks Archery Range, Blacksmith, Watchtower.',
    cost: { food: 500 }, time: secs(50), building: 'towncenter', age: 0, hotkey: 'q',
  },
  age3: {
    name: 'Castle Age', desc: 'Advance to Age III. Unlocks Siege Workshop, Castle, Champion.',
    cost: { food: 800, gold: 200 }, time: secs(70), building: 'towncenter', age: 1, requires: 'age2', hotkey: 'q',
  },
  forging:    { name: 'Forging',      desc: '+1 melee unit attack.',  cost: { food: 150, gold: 75 },  time: secs(30), building: 'blacksmith', age: 1, hotkey: 'o' },
  ironcasting:{ name: 'Iron Casting', desc: '+1 melee unit attack.',  cost: { food: 220, gold: 120 }, time: secs(40), building: 'blacksmith', age: 2, requires: 'forging', hotkey: 'o' },
  fletching:  { name: 'Fletching',    desc: '+1 ranged attack (archers and towers).', cost: { food: 100, gold: 100 }, time: secs(30), building: 'blacksmith', age: 1, hotkey: 'p' },
  bodkin:     { name: 'Bodkin Arrow', desc: '+1 ranged attack (archers and towers).', cost: { food: 200, gold: 150 }, time: secs(40), building: 'blacksmith', age: 2, requires: 'fletching', hotkey: 'p' },
  scalearmor: { name: 'Scale Armor',  desc: '+1 armor for all units.', cost: { food: 100 },            time: secs(30), building: 'blacksmith', age: 1, hotkey: 'u' },
  chainarmor: { name: 'Chain Armor',  desc: '+1 armor for all units.', cost: { food: 200, gold: 100 }, time: secs(40), building: 'blacksmith', age: 2, requires: 'scalearmor', hotkey: 'u' },
};

export const AGE_NAMES = ['Dark Age', 'Feudal Age', 'Castle Age'];

export const PLAYER_COLORS = [
  { name: 'Blue',   hex: 0x3060c8, css: '#3060c8' },
  { name: 'Red',    hex: 0xc03028, css: '#c03028' },
  { name: 'Green',  hex: 0x30a040, css: '#30a040' },
  { name: 'Yellow', hex: 0xd0a020, css: '#d0a020' },
];
/** Maps player color index to the KayKit building/prop color set name. */
export const COLOR_KEYS = ['blue', 'red', 'green', 'yellow'] as const;

export const START_STOCK: Record<Resource, number> = { food: 250, wood: 250, gold: 100, stone: 50 };
export const START_VILLAGERS = 4;

// Construction progress is tracked in tenths of a villager-tick so that
// diminishing returns stay integer. Everything touching buildProgress goes
// through these two helpers.
export const BUILD_SCALE = 10;

/** Diminishing returns for multiple villagers on one construction site. */
export function buildRate(builders: number): number {
  // 1 builder = 1x, each extra adds 60%: 1, 1.6, 2.2, ...
  return BUILD_SCALE + (builders - 1) * 6;
}

/** Total buildProgress a building needs to be complete. */
export function totalBuildTicks(type: BuildingTypeId): number {
  return BUILDINGS[type].buildTime * BUILD_SCALE;
}

export const isUnitType = (t: string): t is UnitTypeId => t in UNITS;
export const isBuildingType = (t: string): t is BuildingTypeId => t in BUILDINGS;
export const isResourceNodeType = (t: string): t is ResourceNodeTypeId => t in RESOURCE_NODES;
