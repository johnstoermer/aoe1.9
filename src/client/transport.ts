// Frame sources. The game loop doesn't care whether frames come from the
// multiplayer server or from a local metronome — both implement Transport.

import { HASH_PERIOD } from '../shared/protocol';
import type { Command, Frame, GameSetup } from '../shared/types';
import { TICK_MS } from '../shared/types';

export interface Transport {
  /** Frames ready to be simulated, in tick order. */
  pollFrames(): Frame[];
  sendCommands(cmds: Command[]): void;
  /** Report a state hash for desync detection (no-op locally). */
  reportHash(tick: number, hash: number): void;
  /** How many ticks the source is ahead of us (drives catch-up). */
  bufferedTicks(currentTick: number): number;
  /** Sub-tick progress 0..1 for render interpolation. */
  alphaHint(): number;
  stop(): void;
}

/**
 * Single-player: produce frames on a local clock. Commands issued now are
 * stamped into the next frame, mirroring the server's behavior with zero
 * network in between.
 */
export class LocalTransport implements Transport {
  private nextTick = 0;
  private pending: Command[] = [];
  private acc = 0;
  private last = performance.now();
  private frames: Frame[] = [];
  readonly setup: GameSetup;

  constructor(setup: GameSetup) {
    this.setup = setup;
  }

  pollFrames(): Frame[] {
    const now = performance.now();
    this.acc += now - this.last;
    this.last = now;
    // don't let a background tab burst thousands of ticks at once
    if (this.acc > 2000) this.acc = 2000;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      const commands = this.pending.length > 0 ? [{ player: 0, cmds: this.pending }] : [];
      this.pending = [];
      this.frames.push({ tick: this.nextTick++, commands });
    }
    const out = this.frames;
    this.frames = [];
    return out;
  }

  sendCommands(cmds: Command[]) {
    this.pending.push(...cmds);
  }

  reportHash() {}

  bufferedTicks(): number {
    return 0;
  }

  alphaHint(): number {
    return this.acc / TICK_MS;
  }

  stop() {}
}

export { HASH_PERIOD };
