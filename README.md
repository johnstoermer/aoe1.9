# AOE 1.9

A streamlined, open-source real-time strategy game in the spirit of **Age of
Empires II**, built with [three.js](https://threejs.org). Fully online
multiplayer over deterministic lockstep, a scripted skirmish AI, authentic
PS1-era rendering, and a UI that is 100% Windows 98.

Gather **food, wood, gold and stone** → advance through **three ages** →
raise an army of men-at-arms, archers, champions and catapults → raze every
rival town. Intentionally simpler than AoE II, but polished: animation
blending, hit sparks and boulder explosions, positional audio, fog of war,
control groups, shift-queued orders, rally points, and a minimap in a sunken
Win98 panel.

Every single-player and multiplayer lobby offers two rulesets:

- **Modern Mode** (default): villagers are autonomous workers managed through
  Farmer, Woodcutter, Gold Miner, Stone Miner, and Builder allocations. They
  train automatically up to a separate 25-villager cap, gather directly into
  stockpiles, and builders claim globally placed foundations. Military has a
  fixed, separate cap of 200; Town Centers, Farms, Houses, and resource
  drop-off camps cannot be built. Losing the starting Town Center is defeat.
- **Classic Mode**: the original direct-control economy remains intact with
  manually trained villagers, resource drop-offs, Houses, and a shared
  housing-based population cap.

## Quick start

```bash
npm install
npm run dev        # game server on :8080 + vite dev client on :5173
```

Open http://localhost:5173 — *Single Player* for a skirmish against the
computer, *Multiplayer* to host a lobby and share the 4-letter game code.

Production:

```bash
npm run build      # typecheck + bundle to dist/
npm start          # serves dist/ and the websocket lobby on :8080
```

Tests (fixed-point math, pathfinding, gameplay flows, sim determinism, and a
full two-client lockstep server integration):

```bash
npm test
```

## How it plays

| | |
|---|---|
| **Left click / drag** | select unit(s) |
| **Right click** | move / gather / attack / build / set rally |
| **Shift** | queue orders, keep placing buildings |
| **A** then click | attack-move · **S** stop · **Delete** delete |
| **Ctrl+1–9 / 1–9** | set / recall control groups (recall twice to center) |
| **H** | town center · **.** next idle villager · **Esc** cancel |
| **Arrows / screen edge / middle-drag** | pan · **Wheel** zoom |

In Modern Mode, use the persistent **Modern Economy** panel to allocate
villager roles and place buildings; villagers themselves cannot be selected.
In Classic Mode, villagers gather from berries, trees, gold and stone mines
(drop-off at the Town Center, Lumber Camp or Mining Camp), plant farms, and
build Houses to raise the shared population cap (75 max). The Blacksmith sells attack/armor
upgrades; the Town Center researches the **Feudal** and **Castle** ages,
unlocking the Archery Range, Watchtower, Siege Workshop, Castle and better
troops. Catapult boulders splash — including your own troops, as tradition
demands. A player with no buildings and no units left is defeated; last
empire standing wins.

## Architecture

```
src/
├── shared/     the deterministic simulation — runs identically everywhere
│   ├── fixed.ts        integer fixed-point math (no floats in the sim)
│   ├── prng.ts         seeded PRNG (mulberry32)
│   ├── data.ts         all unit/building/tech/resource stats, data-driven
│   ├── map.ts          seeded map generation + connectivity carving
│   ├── path.ts         A* with binary heap, adjacency goals, LOS smoothing
│   ├── sim.ts          World: command validation, economy, combat, fog,
│   │                   projectiles, victory, FNV-1a state hash
│   ├── ai.ts           scripted skirmish AI (runs inside the sim)
│   └── protocol.ts     client↔server message types
├── server/     lobby + relay (no game logic): rooms with 4-letter codes,
│               sequences commands into numbered frames at 15 Hz, compares
│               client state hashes to detect desyncs, serves dist/
└── client/     three.js presentation + input + Win98 UI
    ├── game.ts         GameClient: steps the world from a Transport,
    │                   interpolation, events → particles/audio/alerts
    ├── transport.ts    LocalTransport (single player) — same interface
    ├── net.ts          NetClient (multiplayer websocket transport)
    ├── render/         PS1 pipeline, terrain, instanced doodads, units
    │                   (shared KayKit rig + crossfade), buildings with
    │                   construction phases, particles, fog-of-war shader
    ├── ui/             98.css windows: menus, lobby, HUD, command card
    └── assets.ts       glTF loading, retro material patching, team-color
                        texture remapping, model→icon renderer
```

**Determinism.** The simulation uses integer-only math (fixed point at 256
units/tile), a seeded PRNG, and ordered iteration — no floats, no `Date`, no
`Math.random`. Multiplayer is server-sequenced lockstep: clients send
commands; the server stamps them into numbered frames; every client (and the
in-sim AI) executes the identical frame stream. Clients report FNV-1a state
hashes every 4 seconds and the server flags any divergence. The same
machinery runs single player through a local frame source, so SP and MP share
one code path.

**PS1 look.** The scene renders into a low-resolution target (⅓ display
resolution, nearest-filtered) through Lambert-only materials with
nearest-filtered textures, a vertex-snapping shader patch for that
characteristic wobble, short fog, and a post pass that applies 4×4 Bayer
ordered dithering and 5-bit color quantization. Fog of war is sampled
per-fragment from a visibility texture by every world material, so trees,
buildings and terrain all darken consistently.

**Win98 look.** [98.css](https://jdan.github.io/98.css/) plus a small
hand-rolled toolkit (draggable windows, modals, tooltips, toasts). Command
card icons are photographed at runtime from the actual 3D models by a tiny
offscreen renderer, so every button shows the correct player-colored unit or
building.

## Assets

All game assets come from [johnstoermer/assets](https://github.com/johnstoermer/assets):

- **KayKit** model packs (CC0) by [Kay Lousberg](https://kaylousberg.com/):
  Medieval Hexagon (buildings, trees, props, projectiles), Adventurers +
  Character Animations (rigged units and the shared animation library),
  Mystery Monthly (farmer villagers, the Black Knight champion), Resource
  Bits and Forest Nature packs.
- Sound effects and VFX textures from the same collection.

`tools/prepare-assets.mjs` copies the curated subset (≈20 MB) into
`public/assets/`, which is committed so the game runs after a plain
`npm install`. To regenerate: clone the assets repo and run
`ASSETS_SRC=/path/to/assets npm run assets`.

## Extending

Stats live in `src/shared/data.ts` — new units, buildings and techs are data
entries plus a model mapping in `src/client/visuals.ts`. The sim treats
anything in those tables generically (training, costs, combat, drop-off,
aging). Map scripts are a single function in `src/shared/map.ts`.
