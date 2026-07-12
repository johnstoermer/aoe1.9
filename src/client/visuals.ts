// Mapping from sim entity types to renderable assets: model paths, scales,
// yaw offsets, and which animation clips drive each activity. Purely
// presentational — nothing here feeds back into the simulation.

import { COLOR_KEYS } from '../shared/data';

export const A = '/assets/models';

export interface UnitVisual {
  /** Model path; '{c}' is replaced with the player color key. */
  model: string;
  /** Target world height (tiles) — the model is auto-fitted to this. */
  height: number;
  /** Extra yaw so the model's forward matches the facing direction. */
  yaw: number;
  anims: {
    idle: string;
    move: string;
    attack?: string[];
    death: string;
  };
  /** Animation played per gather kind (villager only). */
  gather?: Record<string, string>;
  rig: boolean; // skinned character using the shared animation library
  rigSize?: 'medium' | 'large';
  weapon?: string;
}

export interface EquipmentPlacement {
  hand: 'left' | 'right';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

const IDENTITY_PLACEMENT: EquipmentPlacement = {
  hand: 'right', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
};

const X90_PLACEMENT: EquipmentPlacement = {
  hand: 'right', position: [0, 0, 0], rotation: [90, 0, 0], scale: [1, 1, 1],
};

export const DEFAULT_EQUIPMENT_PLACEMENTS: Record<string, EquipmentPlacement> = {
  villager: structuredClone(X90_PLACEMENT),
  barbarian: structuredClone(X90_PLACEMENT),
  knight: structuredClone(X90_PLACEMENT),
  bowman: { ...structuredClone(X90_PLACEMENT), hand: 'left' },
  crossbowman: structuredClone(IDENTITY_PLACEMENT),
  bruiser: structuredClone(X90_PLACEMENT),
  vanguard: structuredClone(X90_PLACEMENT),
};

const placementKey = (type: string) => `aoe19-equipment-v3-${type}`;

export function kayKitHandForEquipment(path: string): 'left' | 'right' {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name.includes('shield') || (name.startsWith('bow.') || name.startsWith('bow_'))) return 'left';
  return 'right';
}

export function getEquipmentPlacement(type: string): EquipmentPlacement {
  const fallback = DEFAULT_EQUIPMENT_PLACEMENTS[type] ?? {
    ...IDENTITY_PLACEMENT,
    hand: kayKitHandForEquipment(UNIT_VISUALS[type]?.weapon ?? ''),
  };
  try {
    const saved = localStorage.getItem(placementKey(type));
    if (saved) return { ...structuredClone(fallback), ...JSON.parse(saved) } as EquipmentPlacement;
  } catch {}
  return structuredClone(fallback);
}

export function saveEquipmentPlacement(type: string, placement: EquipmentPlacement) {
  localStorage.setItem(placementKey(type), JSON.stringify(placement));
}

export function resetEquipmentPlacement(type: string): EquipmentPlacement {
  localStorage.removeItem(placementKey(type));
  return getEquipmentPlacement(type);
}

export const UNIT_VISUALS: Record<string, UnitVisual> = {
  villager: {
    model: `${A}/units/Farmer_{ab}.glb`, height: 0.68, yaw: 0, rig: true, weapon: `${A}/weapons/hammer_A.gltf`,
    anims: { idle: 'Idle_A', move: 'Walking_A', attack: ['Melee_Unarmed_Attack_Punch_A'], death: 'Death_A' },
    gather: {
      tree: 'Chop', gold: 'Pickaxe', stone: 'Pickaxe',
      berries: 'PickUp', farm: 'Work_A', build: 'Hammer', carry: 'Walking_A',
    },
  },
  barbarian: {
    model: `${A}/units/Barbarian.glb`, height: 0.74, yaw: 0, rig: true, weapon: `${A}/weapons/sword_1handed.gltf`,
    anims: {
      idle: 'Idle_B', move: 'Running_A',
      attack: ['Melee_1H_Attack_Slice_Horizontal', 'Melee_1H_Attack_Chop', 'Melee_1H_Attack_Stab'],
      death: 'Death_A',
    },
  },
  knight: {
    model: `${A}/units/Knight.glb`, height: 0.76, yaw: 0, rig: true, weapon: `${A}/weapons/sword_1handed.gltf`,
    anims: { idle: 'Melee_1H_Idle', move: 'Running_A', attack: ['Melee_1H_Attack_Slice_Horizontal'], death: 'Death_A' },
  },
  bowman: {
    model: `${A}/units/Ranger.glb`, height: 0.72, yaw: 0, rig: true, weapon: `${A}/weapons/bow.gltf`,
    anims: { idle: 'Idle_A', move: 'Running_A', attack: ['Ranged_Bow_Release'], death: 'Death_B' },
  },
  crossbowman: {
    model: `${A}/units/Rogue.glb`, height: 0.72, yaw: 0, rig: true, weapon: `${A}/weapons/crossbow_2handed.gltf`,
    anims: { idle: 'Ranged_2H_Idle', move: 'Running_A', attack: ['Ranged_Crossbow_Shoot'], death: 'Death_B' },
  },
  bruiser: {
    model: `${A}/units/Barbarian_Large.glb`, height: 0.9, yaw: 0, rig: true, rigSize: 'large', weapon: `${A}/weapons/axe_2handed_Large.gltf`,
    anims: { idle: 'Melee_2H_Idle', move: 'Running_A', attack: ['Melee_2H_Attack', 'Melee_2H_Slam'], death: 'Death_A' },
  },
  vanguard: {
    model: `${A}/units/BlackKnight.glb`, height: 0.94, yaw: 0, rig: true, rigSize: 'large', weapon: `${A}/weapons/axe_2handed_Large.gltf`,
    anims: {
      idle: 'Melee_2H_Idle', move: 'Running_A',
      attack: ['Melee_2H_Attack', 'Melee_2H_Slam'],
      death: 'Death_A',
    },
  },
  catapult: {
    model: `${A}/props/{c}/catapult_{c}_full.gltf`, height: 0.62, yaw: 0, rig: false,
    anims: { idle: '', move: '', death: '' },
  },
};

export interface BuildingVisual {
  model: string; // '{c}' replaced with color key; neutral models have none
  /** Fraction of the footprint the model is fitted to. */
  fit: number;
  yaw: number;
}

export const BUILDING_VISUALS: Record<string, BuildingVisual> = {
  towncenter: { model: `${A}/buildings/{c}/building_townhall_{c}.gltf`, fit: 1.05, yaw: 0 },
  house: { model: `${A}/buildings/{c}/building_home_A_{c}.gltf`, fit: 0.95, yaw: 0 },
  farm: { model: `${A}/buildings/neutral/building_grain.gltf`, fit: 0.98, yaw: 0 },
  lumbercamp: { model: `${A}/buildings/{c}/building_lumbermill_{c}.gltf`, fit: 1.0, yaw: 0 },
  minecamp: { model: `${A}/buildings/{c}/building_mine_{c}.gltf`, fit: 1.0, yaw: 0 },
  barracks: { model: `${A}/buildings/{c}/building_barracks_{c}.gltf`, fit: 1.0, yaw: 0 },
  archeryrange: { model: `${A}/buildings/{c}/building_archeryrange_{c}.gltf`, fit: 1.0, yaw: 0 },
  workshop: { model: `${A}/buildings/{c}/building_workshop_{c}.gltf`, fit: 1.0, yaw: 0 },
  blacksmith: { model: `${A}/buildings/{c}/building_blacksmith_{c}.gltf`, fit: 0.95, yaw: 0 },
  watchtower: { model: `${A}/buildings/{c}/building_watchtower_{c}.gltf`, fit: 1.15, yaw: 0 },
  castle: { model: `${A}/buildings/{c}/building_castle_{c}.gltf`, fit: 1.05, yaw: 0 },
  woodwall: { model: `${A}/buildings/neutral/fence_wood_straight.gltf`, fit: 1.0, yaw: 0 },
  stonewall: { model: `${A}/buildings/neutral/wall_straight.gltf`, fit: 1.0, yaw: 0 },
};

export const CONSTRUCTION_MODELS = [
  `${A}/buildings/neutral/building_dirt.gltf`,       // 0..40%
  `${A}/buildings/neutral/building_stage_A.gltf`,    // 40..75%
  `${A}/buildings/neutral/building_scaffolding.gltf`, // 75..100%
];
export const RUBBLE_MODEL = `${A}/buildings/neutral/building_destroyed.gltf`;

export const DOODAD_MODELS = {
  tree: [`${A}/doodads/tree_single_A.gltf`, `${A}/doodads/tree_single_B.gltf`],
  stump: [`${A}/doodads/tree_single_A_cut.gltf`, `${A}/doodads/tree_single_B_cut.gltf`],
  stone: [`${A}/doodads/rock_single_A.gltf`, `${A}/doodads/rock_single_B.gltf`, `${A}/doodads/rock_single_C.gltf`],
  gold: [`${A}/doodads/resbits/Gold_Nuggets.gltf`],
  goldRock: [`${A}/doodads/rock_single_D.gltf`, `${A}/doodads/rock_single_E.gltf`],
  berries: [`${A}/doodads/nature/Bush_1_A_Color1.gltf`, `${A}/doodads/nature/Bush_2_A_Color1.gltf`],
  grass: [`${A}/doodads/nature/Grass_1_A_Color1.gltf`, `${A}/doodads/nature/Grass_2_A_Color1.gltf`],
};

export const ARROW_MODEL = (c: number) =>
  `${A}/props/${COLOR_KEYS[c]}/projectile_arrow_${COLOR_KEYS[c]}_full.gltf`;
export const BOULDER_MODEL = `${A}/buildings/neutral/projectile_catapult.gltf`;
export const FLAG_MODEL = (c: number) => `${A}/props/${COLOR_KEYS[c]}/flag_${COLOR_KEYS[c]}.gltf`;

export const ANIM_LIBRARY = [
  `${A}/anims/Rig_Medium_General.glb`,
  `${A}/anims/Rig_Medium_MovementBasic.glb`,
  `${A}/anims/Rig_Medium_CombatMelee.glb`,
  `${A}/anims/Rig_Medium_CombatRanged.glb`,
  `${A}/anims/Rig_Medium_Tools.glb`,
];

export const LARGE_ANIM_LIBRARY = [
  `${A}/anims/Rig_Large_General.glb`,
  `${A}/anims/Rig_Large_MovementBasic.glb`,
  `${A}/anims/Rig_Large_MovementAdvanced.glb`,
  `${A}/anims/Rig_Large_CombatMelee.glb`,
  `${A}/anims/Rig_Large_Simulation.glb`,
  `${A}/anims/Rig_Large_Special.glb`,
];

/** Per-character team-color remap: which texture hues become the player color. */
export const TEAM_REMAP: Record<string, { hueMin: number; hueMax: number; minSat: number } | null> = {
  villager: null, // farmers stay rustic; team ring carries the color
  barbarian: null,
  knight: { hueMin: 200, hueMax: 260, minSat: 0.25 },
  bowman: { hueMin: 70, hueMax: 160, minSat: 0.22 },
  crossbowman: null,
  bruiser: null,
  vanguard: null,
  catapult: null, // already color-variant models
};

export const SFX = '/assets/sfx';
export const VFX = '/assets/vfx';
