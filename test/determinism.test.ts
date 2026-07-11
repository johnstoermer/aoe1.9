import { describe, expect, it } from 'vitest';
import { World } from '../src/shared/sim';
import type { Command, Frame, GameSetup } from '../src/shared/types';

function setup(seed: number, ais = true): GameSetup {
  return {
    seed,
    mapSize: 64,
    players: [
      { name: 'P0', color: 0, isAI: ais, aiLevel: 1 },
      { name: 'P1', color: 1, isAI: true, aiLevel: 2 },
    ],
  };
}

/** Scripted human-ish commands injected at fixed ticks. */
function commandScript(w: World): Map<number, Command[]> {
  const script = new Map<number, Command[]>();
  const villagers: number[] = [];
  let tree = 0, berries = 0, tc = 0;
  for (const e of w.entities.values()) {
    if (e.kind === 'unit' && e.owner === 0) villagers.push(e.id);
    if (e.kind === 'building' && e.owner === 0 && e.type === 'towncenter') tc = e.id;
    if (e.kind === 'resource' && e.type === 'tree' && !tree) tree = e.id;
    if (e.kind === 'resource' && e.type === 'berries' && !berries) berries = e.id;
  }
  script.set(5, [
    { t: 'gather', units: villagers.slice(0, 2), target: tree },
    { t: 'gather', units: villagers.slice(2), target: berries },
  ]);
  script.set(20, [{ t: 'train', building: tc, unit: 'villager' }]);
  script.set(400, [{ t: 'move', units: villagers.slice(0, 1), x: 5000, y: 5000 }]);
  return script;
}

function run(seed: number, ticks: number): number[] {
  const w = new World(setup(seed));
  const script = commandScript(w);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const cmds = script.get(t);
    const frame: Frame = { tick: t, commands: cmds ? [{ player: 0, cmds }] : [] };
    w.step(frame);
    if (t % 100 === 0) hashes.push(w.hash());
  }
  hashes.push(w.hash());
  return hashes;
}

describe('simulation determinism', () => {
  it('same seed + same commands => identical hash stream (AI included)', () => {
    const a = run(4242, 3000);
    const b = run(4242, 3000);
    expect(a).toEqual(b);
  });

  it('different seeds diverge', () => {
    const a = run(1, 500);
    const b = run(2, 500);
    expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
  });

  it('a dropped command changes the outcome (hash actually covers state)', () => {
    const w1 = new World(setup(99, false));
    const w2 = new World(setup(99, false));
    let villager = 0;
    for (const e of w1.entities.values()) {
      if (e.kind === 'unit' && e.owner === 0) { villager = e.id; break; }
    }
    for (let t = 0; t < 100; t++) {
      const move: Command[] = [{ t: 'move', units: [villager], x: 9000, y: 9000 }];
      w1.step({ tick: t, commands: t === 10 ? [{ player: 0, cmds: move }] : [] });
      w2.step({ tick: t, commands: [] });
    }
    expect(w1.hash()).not.toBe(w2.hash());
  });
});
