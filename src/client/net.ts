// WebSocket client: lobby messaging plus the in-game Transport implementation
// (frames arrive from the server; commands go back; hashes are compared).

import { PROTOCOL_VERSION, type C2S, type RoomInfo, type S2C } from '../shared/protocol';
import type { Command, Frame, GameSetup } from '../shared/types';
import { TICK_MS } from '../shared/types';
import type { Transport } from './transport';

export type NetHandler = {
  onRoom?(room: RoomInfo, yourSlot: number): void;
  onLeft?(): void;
  onBegin?(setup: GameSetup, yourPlayer: number): void;
  onChat?(from: string, text: string): void;
  onError?(msg: string): void;
  onDesync?(tick: number): void;
  onPeerLeft?(player: number, name: string): void;
  onClose?(): void;
};

export class NetClient implements Transport {
  private ws: WebSocket | null = null;
  handler: NetHandler = {};
  peerId = -1;
  room: RoomInfo | null = null;
  yourSlot = -1;

  private frameQueue: Frame[] = [];
  private lastFrameArrival = performance.now();
  private latestTick = -1;
  private playerName = 'Player';
  private roomCode = '';
  private inGame = false;
  private reconnecting = false;
  connected = false;

  connect(): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = (err: unknown) => reject(err instanceof Error ? err : new Error('Could not reach the game server.'));
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = (e) => {
        if (!this.connected) fail(e);
      };
      ws.onclose = () => {
        this.connected = false;
        if (this.inGame && this.roomCode && !this.reconnecting) void this.reconnect();
        else if (!this.reconnecting) this.handler.onClose?.();
      };
      ws.onmessage = (e) => {
        let msg: S2C;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        this.dispatch(msg);
      };
    });
  }

  private dispatch(msg: S2C) {
    switch (msg.t) {
      case 'welcome':
        this.peerId = msg.peer;
        break;
      case 'room':
        this.room = msg.room;
        this.roomCode = msg.room.code;
        this.yourSlot = msg.yourSlot;
        this.handler.onRoom?.(msg.room, msg.yourSlot);
        break;
      case 'left':
        this.room = null;
        this.handler.onLeft?.();
        break;
      case 'begin':
        this.frameQueue = [];
        this.latestTick = -1;
        this.inGame = true;
        this.handler.onBegin?.(msg.setup, msg.yourPlayer);
        break;
      case 'reconnected':
        this.frameQueue.push(...msg.frames);
        if (msg.frames.length) this.latestTick = msg.frames[msg.frames.length - 1].tick;
        this.lastFrameArrival = performance.now();
        this.reconnecting = false;
        break;
      case 'frame':
        this.frameQueue.push(msg.frame);
        this.latestTick = msg.frame.tick;
        this.lastFrameArrival = performance.now();
        break;
      case 'frames':
        this.frameQueue.push(...msg.frames);
        if (msg.frames.length) {
          this.latestTick = msg.frames[msg.frames.length - 1].tick;
          this.lastFrameArrival = performance.now();
        }
        break;
      case 'chat':
        this.handler.onChat?.(msg.from, msg.text);
        break;
      case 'error':
        this.handler.onError?.(msg.msg);
        break;
      case 'desync':
        this.handler.onDesync?.(msg.tick);
        break;
      case 'peerLeft':
        this.handler.onPeerLeft?.(msg.player, msg.name);
        break;
      case 'ping':
        this.send({ t: 'pong', nonce: msg.nonce });
        break;
    }
  }

  send(msg: C2S) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  hello(name: string) {
    this.playerName = name;
    this.send({ t: 'hello', name, version: PROTOCOL_VERSION });
  }

  private async reconnect() {
    this.reconnecting = true;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 + attempt * 400)));
      try {
        await this.connect();
        this.hello(this.playerName);
        this.send({ t: 'reconnect', code: this.roomCode, name: this.playerName, tick: this.latestTick + 1 });
        return;
      } catch {}
    }
    this.reconnecting = false;
    this.handler.onClose?.();
  }

  // --- Transport ---------------------------------------------------------------

  pollFrames(): Frame[] {
    const out = this.frameQueue;
    this.frameQueue = [];
    return out;
  }

  sendCommands(cmds: Command[]) {
    if (cmds.length) this.send({ t: 'cmds', cmds });
  }

  reportHash(tick: number, hash: number) {
    this.send({ t: 'hash', tick, hash });
  }

  bufferedTicks(currentTick: number): number {
    return Math.max(0, this.latestTick - currentTick);
  }

  alphaHint(): number {
    return (performance.now() - this.lastFrameArrival) / TICK_MS;
  }

  stop() {
    // leave the room but keep the socket for the post-game lobby
    this.send({ t: 'leave' });
    this.inGame = false;
  }

  close() {
    this.inGame = false;
    this.ws?.close();
    this.ws = null;
  }
}
