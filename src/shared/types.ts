// Core simulation types. Everything the sim stores is a number, a string
// enum, or a small array of numbers — no floats, no Dates, no Maps keyed by
// anything non-deterministic.

export const TICK_RATE = 15; // sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_PLAYERS = 4;
export const POP_CAP = 75;

export type Resource = 'food' | 'wood' | 'gold' | 'stone';
export const RESOURCES: Resource[] = ['food', 'wood', 'gold', 'stone'];

export type UnitTypeId = 'villager' | 'militia' | 'archer' | 'champion' | 'catapult';
export type BuildingTypeId =
  | 'towncenter' | 'house' | 'farm' | 'lumbercamp' | 'minecamp'
  | 'barracks' | 'archeryrange' | 'workshop' | 'blacksmith'
  | 'watchtower' | 'castle';
export type ResourceNodeTypeId = 'tree' | 'berries' | 'gold' | 'stone';
export type TechId =
  | 'age2' | 'age3'
  | 'forging' | 'ironcasting'       // melee attack +1 each
  | 'fletching' | 'bodkin'          // ranged attack +1 each
  | 'scalearmor' | 'chainarmor';    // armor +1 each

export type EntityKind = 'unit' | 'building' | 'resource' | 'projectile';

export type UnitOrder =
  | 'idle'      // stand, auto-acquire if military
  | 'move'      // go to orderX/Y
  | 'attackmove'// go to orderX/Y, engage anything en route
  | 'attack'    // chase + attack targetId
  | 'gather'    // harvest resource targetId (villager)
  | 'build';    // construct building targetId (villager)

export interface Entity {
  id: number;
  kind: EntityKind;
  /** Unit/building/resource type id ('villager', 'towncenter', 'tree', ...). */
  type: string;
  owner: number; // player index, -1 for gaia
  x: number;     // fixed-point world position (center)
  y: number;
  hp: number;
  maxHp: number;

  // -- units --
  order: UnitOrder;
  orderX: number;
  orderY: number;
  targetId: number;        // current order target (0 = none)
  engagedId: number;       // combat target actually being fought (0 = none)
  path: number[];          // waypoints [x0,y0,x1,y1,...] fixed-point, reversed (pop from end)
  repath: number;          // cooldown ticks until allowed to repath
  attackCd: number;        // ticks until next swing may start
  swingTick: number;       // >0: ticks until current swing lands its damage
  carry: number;           // villager cargo amount
  carryKind: Resource;
  gatherTimer: number;
  queuedOrders: QueuedOrder[]; // shift-queued follow-up orders

  // -- buildings --
  buildProgress: number;   // 0..buildTime, ticks of construction applied
  trainQueue: TrainItem[];
  rallyX: number;
  rallyY: number;
  rallyTargetId: number;
  tileX: number;           // top-left tile of footprint
  tileY: number;

  // -- resource nodes --
  amount: number;

  // -- projectiles --
  fromId: number;
  projT: number;           // ticks elapsed
  projDur: number;         // total flight ticks
  srcX: number;
  srcY: number;
  splash: number;          // fixed-point splash radius (0 = single target)
  dmg: number;
}

export interface QueuedOrder {
  order: UnitOrder;
  x: number;
  y: number;
  targetId: number;
}

export interface TrainItem {
  unit?: UnitTypeId;
  tech?: TechId;
  progress: number; // ticks
}

export interface PlayerState {
  id: number;
  name: string;
  color: number;           // index into PLAYER_COLORS
  isAI: boolean;
  aiLevel: number;         // 0 easy, 1 normal, 2 hard
  alive: boolean;
  resigned: boolean;
  age: number;             // 0..2
  stock: Record<Resource, number>;
  pop: number;
  popCap: number;
  techs: Partial<Record<TechId, boolean>>;
  // running score/statistics, shown on the post-game screen
  stats: {
    gathered: Record<Resource, number>;
    unitsTrained: number;
    unitsLost: number;
    unitsKilled: number;
    buildingsRazed: number;
    buildingsLost: number;
  };
}

// ---------------------------------------------------------------------------
// Commands: the only way anything enters the simulation. Serializable JSON.
// ---------------------------------------------------------------------------

export type Command =
  | { t: 'move'; units: number[]; x: number; y: number; queue?: boolean }
  | { t: 'attackmove'; units: number[]; x: number; y: number; queue?: boolean }
  | { t: 'attack'; units: number[]; target: number; queue?: boolean }
  | { t: 'gather'; units: number[]; target: number; queue?: boolean }
  | { t: 'build'; units: number[]; building: BuildingTypeId; tx: number; ty: number }
  | { t: 'buildmore'; units: number[]; target: number } // help an existing foundation
  | { t: 'train'; building: number; unit: UnitTypeId }
  | { t: 'research'; building: number; tech: TechId }
  | { t: 'cancelqueue'; building: number; index: number }
  | { t: 'rally'; building: number; x: number; y: number; target?: number }
  | { t: 'stop'; units: number[] }
  | { t: 'delete'; id: number }
  | { t: 'resign' };

/** One sim tick's worth of ordered player commands, as sequenced by the server. */
export interface Frame {
  tick: number;
  commands: { player: number; cmds: Command[] }[];
}

// ---------------------------------------------------------------------------
// Events: presentation-layer notifications emitted by the sim each tick.
// Deterministic, but consumed only by the client (audio/particles/alerts) —
// they are never fed back into the simulation.
// ---------------------------------------------------------------------------

export type SimEventType =
  | 'swing' | 'meleeHit' | 'arrowFire' | 'arrowHit' | 'catapultFire' | 'explosion'
  | 'died' | 'buildingRazed' | 'treeFall' | 'nodeDepleted'
  | 'gatherTick' | 'buildTick' | 'deposit'
  | 'buildingPlaced' | 'buildingDone' | 'unitTrained' | 'researchDone' | 'ageUp'
  | 'popBlocked' | 'underAttack' | 'playerDefeated' | 'gameOver';

export interface SimEvent {
  type: SimEventType;
  x: number;
  y: number;
  ent?: number;       // entity id it concerns
  entType?: string;
  player?: number;    // owning/affected player
  data?: number;      // event-specific extra (damage, resource kind index, winner...)
}

export interface GameSetup {
  seed: number;
  mapSize: number; // tiles per side
  players: { name: string; color: number; isAI: boolean; aiLevel: number }[];
}
