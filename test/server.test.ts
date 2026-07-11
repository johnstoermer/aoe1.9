// Full multiplayer integration: real server, two WebSocket clients, lobby
// flow, lockstep frames, and cross-client hash agreement over a simulated
// battle — the same code path the browser uses, headless.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server/main';
import type { C2S, RoomInfo, S2C } from '../src/shared/protocol';
import { World } from '../src/shared/sim';
import type { Frame, GameSetup } from '../src/shared/types';

class TestClient {
  ws!: WebSocket;
  peer = -1;
  room: RoomInfo | null = null;
  setup: GameSetup | null = null;
  you = -1;
  frames: Frame[] = [];
  desyncAt = -1;
  errors: string[] = [];

  async connect(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as S2C;
      if (msg.t === 'welcome') this.peer = msg.peer;
      else if (msg.t === 'room') this.room = msg.room;
      else if (msg.t === 'begin') { this.setup = msg.setup; this.you = msg.yourPlayer; }
      else if (msg.t === 'frame') this.frames.push(msg.frame);
      else if (msg.t === 'desync') this.desyncAt = msg.tick;
      else if (msg.t === 'error') this.errors.push(msg.msg);
    });
  }

  send(msg: C2S) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('multiplayer server', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer(0);
  });
  afterAll(async () => {
    await server.close();
  });

  it('two clients play a lockstep game and stay in perfect sync', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await a.connect(server.port);
    await b.connect(server.port);
    a.send({ t: 'hello', name: 'Alice', version: 1 });
    b.send({ t: 'hello', name: 'Bob', version: 1 });

    a.send({ t: 'create' });
    await until(() => a.room !== null);
    const code = a.room!.code;

    b.send({ t: 'join', code });
    await until(() => b.room !== null && b.room.slots.length === 2);
    expect(a.room!.slots.length).toBe(2);

    b.send({ t: 'ready', ready: true });
    await until(() => a.room!.slots[1]?.ready === true);
    a.send({ t: 'start' });
    await until(() => a.setup !== null && b.setup !== null);

    expect(a.you).toBe(0);
    expect(b.you).toBe(1);
    expect(a.setup!.seed).toBe(b.setup!.seed);

    // run two real Worlds off the frame streams, issuing commands from both
    const wa = new World(a.setup!);
    const wb = new World(b.setup!);

    // everyone sends their villagers marching to the middle — traffic on both sides
    const mid = (a.setup!.mapSize / 2) * 256;
    const villagersOf = (w: World, owner: number) =>
      [...w.entities.values()].filter((e) => e.kind === 'unit' && e.owner === owner).map((e) => e.id);
    a.send({ t: 'cmds', cmds: [{ t: 'attackmove', units: villagersOf(wa, 0), x: mid, y: mid }] });
    b.send({ t: 'cmds', cmds: [{ t: 'attackmove', units: villagersOf(wb, 1), x: mid, y: mid }] });

    const TARGET = 150; // ten seconds of game time
    await until(() => a.frames.length >= TARGET && b.frames.length >= TARGET, 20000);

    for (let i = 0; i < TARGET; i++) {
      expect(a.frames[i].tick).toBe(i);
      expect(b.frames[i]).toEqual(a.frames[i]); // identical sequenced commands
      wa.step(a.frames[i]);
      wb.step(b.frames[i]);
      if (i % 30 === 0) expect(wb.hash()).toBe(wa.hash());
      // report hashes like real clients so the server can cross-check
      if (i % 60 === 0) {
        a.send({ t: 'hash', tick: i, hash: wa.hash() });
        b.send({ t: 'hash', tick: i, hash: wb.hash() });
      }
    }
    expect(wa.hash()).toBe(wb.hash());
    expect(a.desyncAt).toBe(-1);
    expect(b.desyncAt).toBe(-1);

    a.close();
    b.close();
  }, 40000);

  it('flags a desync when clients report different hashes', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await a.connect(server.port);
    await b.connect(server.port);
    a.send({ t: 'hello', name: 'A', version: 1 });
    b.send({ t: 'hello', name: 'B', version: 1 });
    a.send({ t: 'create' });
    await until(() => a.room !== null);
    b.send({ t: 'join', code: a.room!.code });
    await until(() => b.room !== null);
    b.send({ t: 'ready', ready: true });
    await until(() => a.room!.slots[1]?.ready === true);
    a.send({ t: 'start' });
    await until(() => a.setup !== null && b.setup !== null);

    a.send({ t: 'hash', tick: 60, hash: 111 });
    b.send({ t: 'hash', tick: 60, hash: 222 });
    await until(() => a.desyncAt === 60 && b.desyncAt === 60);

    a.close();
    b.close();
  }, 20000);

  it('rejects joining nonexistent or full rooms', async () => {
    const a = new TestClient();
    await a.connect(server.port);
    a.send({ t: 'hello', name: 'X', version: 1 });
    a.send({ t: 'join', code: 'ZZZZ' });
    await until(() => a.errors.length > 0);
    expect(a.errors[0]).toMatch(/No game found/);
    a.close();
  }, 10000);
});
