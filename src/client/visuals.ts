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
}

export const UNIT_VISUALS: Record<string, UnitVisual> = {
  villager: {
    model: `${A}/units/Farmer_{ab}.glb`, height: 0.68, yaw: 0, rig: true,
    anims: { idle: 'Idle_A', move: 'Walking_A', attack: ['Melee_Unarmed_Attack_Punch_A'], death: 'Death_A' },
    gather: {
      tree: 'Chop', gold: 'Pickaxe', stone: 'Pickaxe',
      berries: 'PickUp', farm: 'Work_A', build: 'Hammer', carry: 'Walking_A',
    },
  },
  militia: {
    model: `${A}/units/Knight.glb`, height: 0.74, yaw: 0, rig: true,
    anims: {
      idle: 'Idle_B', move: 'Running_A',
      attack: ['Melee_1H_Attack_Slice_Horizontal', 'Melee_1H_Attack_Chop', 'Melee_1H_Attack_Stab'],
      death: 'Death_A',
    },
  },
  archer: {
    model: `${A}/units/Ranger.glb`, height: 0.72, yaw: 0, rig: true,
    anims: { idle: 'Idle_A', move: 'Running_A', attack: ['Ranged_Bow_Release'], death: 'Death_B' },
  },
  champion: {
    model: `${A}/units/BlackKnight.glb`, height: 0.8, yaw: 0, rig: true,
    anims: {
      idle: 'Melee_2H_Idle', move: 'Running_A',
      attack: ['Melee_2H_Attack_Chop', 'Melee_2H_Attack_Slice', 'Melee_2H_Attack_Spin'],
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

/** Per-character team-color remap: which texture hues become the player color. */
export const TEAM_REMAP: Record<string, { hueMin: number; hueMax: number; minSat: number } | null> = {
  villager: null, // farmers stay rustic; team ring carries the color
  militia: { hueMin: 200, hueMax: 260, minSat: 0.25 },  // knight's blue cloth
  archer: { hueMin: 70, hueMax: 160, minSat: 0.22 },    // ranger's green hood
  champion: null,
  catapult: null, // already color-variant models
};

export const SFX = '/assets/sfx';
export const VFX = '/assets/vfx';
