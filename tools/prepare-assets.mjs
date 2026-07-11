#!/usr/bin/env node
// Copies the curated subset of game assets from the KayKit asset collection
// (https://github.com/johnstoermer/assets) into public/assets.
//
// Usage: ASSETS_SRC=/path/to/assets node tools/prepare-assets.mjs
//
// For .gltf files the script parses the JSON and also copies every buffer
// (.bin) and image the file references, so a copied model is always loadable.
// The curated output is small enough to commit, which keeps the game runnable
// with a plain `npm install && npm run dev`.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = process.env.ASSETS_SRC ?? '/workspace/assets';
const DST = resolve(dirname(new URL(import.meta.url).pathname), '..', 'public', 'assets');

if (!existsSync(SRC)) {
  console.error(`Asset source not found: ${SRC} (set ASSETS_SRC)`);
  process.exit(1);
}

const HEX = 'KayKit Medieval Hexagon Pack 1.0.1/Assets/gltf';
const ADV = 'KayKit Adventurers 2.0';
const ANIM = 'KayKit Character Animations 1.1/Animations/gltf/Rig_Medium';
const NATURE = 'KayKit Forest Nature Pack 1.0/Assets/gltf';
const RES = 'KayKit Resource Bits 1.0/Assets/gltf';
const SFX = 'Sound Effects';
const VFX = 'Visual Effects';

const COLORS = ['blue', 'red', 'green', 'yellow'];
const BUILDINGS = [
  'townhall', 'home_A', 'barracks', 'archeryrange', 'workshop', 'lumbermill',
  'mine', 'blacksmith', 'watchtower', 'castle', 'market',
];

let copied = 0;
const manifest = { models: [], sfx: [], vfx: [] };

function copyFile(srcRel, dstRel) {
  const src = join(SRC, srcRel);
  const dst = join(DST, dstRel);
  if (!existsSync(src)) {
    console.warn(`  MISSING: ${srcRel}`);
    return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  copied++;
  return true;
}

// Copy a .gltf plus every buffer/image it references (same-dir relative URIs).
function copyGltf(srcRel, dstDir) {
  const src = join(SRC, srcRel);
  if (!existsSync(src)) {
    console.warn(`  MISSING: ${srcRel}`);
    return;
  }
  const name = srcRel.split('/').pop();
  copyFile(srcRel, join(dstDir, name));
  const gltf = JSON.parse(readFileSync(src, 'utf8'));
  const deps = [
    ...(gltf.buffers ?? []).map((b) => b.uri),
    ...(gltf.images ?? []).map((i) => i.uri),
  ].filter((u) => u && !u.startsWith('data:'));
  const srcDir = dirname(srcRel);
  for (const dep of new Set(deps)) {
    const depDst = join(DST, dstDir, dep);
    if (!existsSync(depDst)) copyFile(join(srcDir, dep), join(dstDir, dep));
  }
  manifest.models.push(join(dstDir, name));
}

function copyGlb(srcRel, dstDir, renameTo) {
  const name = renameTo ?? srcRel.split('/').pop();
  if (copyFile(srcRel, join(dstDir, name))) manifest.models.push(join(dstDir, name));
}

rmSync(DST, { recursive: true, force: true });
mkdirSync(DST, { recursive: true });

console.log('— Buildings (per player color) —');
for (const c of COLORS) {
  for (const b of BUILDINGS) {
    copyGltf(`${HEX}/buildings/${c}/building_${b}_${c}.gltf`, `models/buildings/${c}`);
  }
}
for (const n of ['building_grain', 'building_dirt', 'building_destroyed', 'building_scaffolding',
  'building_stage_A', 'building_stage_B', 'building_stage_C', 'projectile_catapult']) {
  copyGltf(`${HEX}/buildings/neutral/${n}.gltf`, 'models/buildings/neutral');
}

console.log('— Units & shared animation library —');
copyGlb(`${ADV}/Characters/gltf/Knight.glb`, 'models/units');
copyGlb(`${ADV}/Characters/gltf/Ranger.glb`, 'models/units');
copyGlb(`${ADV}/Characters/gltf/Barbarian.glb`, 'models/units');
copyGlb('KayKit Mystery Monthly Series 6/12 - June 2026 - Farmers/characters/Farmer_A.glb', 'models/units');
copyGlb('KayKit Mystery Monthly Series 6/12 - June 2026 - Farmers/characters/Farmer_B.glb', 'models/units');
copyGlb('KayKit Mystery Monthly Series 5/3 - September 2024 - Black Knight/characters/BlackKnight.glb', 'models/units');
for (const a of ['General', 'MovementBasic', 'CombatMelee', 'CombatRanged', 'Tools']) {
  copyGlb(`${ANIM}/Rig_Medium_${a}.glb`, 'models/anims');
}
for (const c of COLORS) {
  copyGltf(`${HEX}/units/${c}/catapult_${c}_full.gltf`, `models/props/${c}`);
  copyGltf(`${HEX}/units/${c}/projectile_arrow_${c}_full.gltf`, `models/props/${c}`);
  copyGltf(`${HEX}/decoration/props/flag_${c}.gltf`, `models/props/${c}`);
}

console.log('— Resource nodes & doodads —');
for (const t of ['tree_single_A', 'tree_single_A_cut', 'tree_single_B', 'tree_single_B_cut',
  'rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E']) {
  copyGltf(`${HEX}/decoration/nature/${t}.gltf`, 'models/doodads');
}
for (const p of ['resource_lumber', 'resource_stone', 'haybale', 'barrel', 'sack', 'target', 'weaponrack', 'bucket_arrows']) {
  copyGltf(`${HEX}/decoration/props/${p}.gltf`, 'models/doodads');
}
for (const r of ['Gold_Nuggets', 'Gold_Nugget_Large', 'Gold_Nugget_Medium', 'Stone_Chunks_Large',
  'Wood_Log_Stack', 'Wood_Log_A', 'Food_Basket_A_Berries', 'Gold_Bars_Stack_Small']) {
  copyGltf(`${RES}/${r}.gltf`, 'models/doodads/resbits');
}
for (const n of ['Bush_1_A_Color1', 'Bush_2_A_Color1', 'Bush_4_A_Color1',
  'Grass_1_A_Color1', 'Grass_2_A_Color1']) {
  copyGltf(`${NATURE}/Color1/${n}.gltf`, 'models/doodads/nature');
}

console.log('— Sound effects —');
const sfxMap = {
  // movement
  'footstep_grass_1.ogg': `${SFX}/Player/Footsteps/Grass/footstep_grass_ufx_1.ogg`,
  'footstep_grass_2.ogg': `${SFX}/Player/Footsteps/Grass/footstep_grass_ufx_2.ogg`,
  'footstep_grass_3.ogg': `${SFX}/Player/Footsteps/Grass/footstep_grass_ufx_3.ogg`,
  'footstep_grass_4.ogg': `${SFX}/Player/Footsteps/Grass/footstep_grass_ufx_4.ogg`,
  // melee combat
  'swing_light_1.ogg': `${SFX}/Melee/Swing/universal_swing_miss_light_ufx_1.ogg`,
  'swing_light_2.ogg': `${SFX}/Melee/Swing/universal_swing_miss_light_ufx_2.ogg`,
  'swing_heavy_1.ogg': `${SFX}/Melee/Swing/universal_swing_miss_heavy_ufx_1.ogg`,
  'swing_heavy_2.ogg': `${SFX}/Melee/Swing/universal_swing_miss_heavy_ufx_2.ogg`,
  'hit_body_1.ogg': `${SFX}/Melee/Hit/blunt_hit_body_ufx_1.ogg`,
  'hit_body_2.ogg': `${SFX}/Melee/Hit/blunt_hit_body_ufx_2.ogg`,
  'hit_body_3.ogg': `${SFX}/Melee/Hit/blunt_hit_body_ufx_4.ogg`,
  'hit_slash_1.ogg': `${SFX}/Melee/Hit/sharp_slash_body_ufx_1.ogg`,
  'hit_crit.ogg': `${SFX}/Melee/Hit/sharp_critical_hit_body_ufx_2.ogg`,
  'hit_metal.ogg': `${SFX}/Melee/Hit/blunt_hit_metal_ufx_1.ogg`,
  'sword_clash.ogg': `${SFX}/Melee/Hit/sword_clash_ufx_1.ogg`,
  'sword_draw.ogg': `${SFX}/Melee/Draw/sword_draw_ufx_1.ogg`,
  'death_1.ogg': `${SFX}/Melee/Hit/sticky_hit_body_ufx_1.ogg`,
  'death_2.ogg': `${SFX}/Melee/Hit/sticky_hit_body_ufx_2.ogg`,
  // ranged
  'arrow_shoot_1.ogg': `${SFX}/Melee/Throw/throw_light_ufx_1.ogg`,
  'catapult_shoot.ogg': `${SFX}/Melee/Throw/throw_heavy_ufx_1.ogg`,
  // gathering / building
  'chop_1.ogg': `${SFX}/Impact & Break/Wood/impact_wood_ufx_1.ogg`,
  'chop_2.ogg': `${SFX}/Impact & Break/Wood/impact_wood_ufx_2.ogg`,
  'tree_fall.ogg': `${SFX}/Impact & Break/Wood/break_wood_ufx_1.ogg`,
  'mine_1.ogg': `${SFX}/Impact & Break/Concrete/impact_concrete_ufx_1.ogg`,
  'mine_2.ogg': `${SFX}/Impact & Break/Concrete/impact_concrete_ufx_2.ogg`,
  'mine_3.ogg': `${SFX}/Impact & Break/Concrete/impact_concrete_ufx_3.ogg`,
  'rock_break.ogg': `${SFX}/Impact & Break/Concrete/break_concrete_ufx_1.ogg`,
  'build_done.ogg': `${SFX}/Misc/item_craft_ufx_1.ogg`,
  // destruction
  'explosion_1.ogg': `${SFX}/Explosions/explosion_close_short_ufx_1.ogg`,
  'explosion_2.ogg': `${SFX}/Explosions/explosion_close_short_ufx_2.ogg`,
  'explosion_big.ogg': `${SFX}/Explosions/explosion_close_long_ufx_1.ogg`,
  // ui / notifications
  'ui_open.ogg': `${SFX}/Misc/inventory_open_ufx_1.wav`,
  'ui_close.ogg': `${SFX}/Misc/inventory_close_ufx_1.wav`,
  'ui_click.ogg': `${SFX}/Misc/item_pickup_ufx_1.ogg`,
  'train_done.ogg': `${SFX}/Misc/item_equip_ufx_1.ogg`,
  'upgrade.ogg': `${SFX}/Misc/item_upgrade_ufx_1.ogg`,
  'age_up.ogg': `${SFX}/Misc/player_level_up_ufx_1.ogg`,
  'alert.ogg': `${SFX}/Misc/new_objective_ufx_1.ogg`,
};
for (const [dst, src] of Object.entries(sfxMap)) {
  if (copyFile(src, `sfx/${dst}`)) manifest.sfx.push(dst);
}

console.log('— VFX textures —');
const vfxMap = {
  'flare_01.png': `${VFX}/ImpactVFX/assets/BinbunVFX/shared/texture/flare/flare_01.png`,
  'flare_02.png': `${VFX}/ImpactVFX/assets/BinbunVFX/shared/texture/flare/flare_02.png`,
  'flash_01.png': `${VFX}/ImpactVFX/assets/BinbunVFX/shared/texture/flash/flash_01.png`,
  'flash_02.png': `${VFX}/ImpactVFX/assets/BinbunVFX/shared/texture/flash/flash_02.png`,
  'cracks_01.png': `${VFX}/ImpactVFX/assets/BinbunVFX/shared/texture/cracks_01.png`,
};
for (const [dst, src] of Object.entries(vfxMap)) {
  if (copyFile(src, `vfx/${dst}`)) manifest.vfx.push(dst);
}

writeFileSync(join(DST, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nDone. ${copied} files → ${DST}`);
