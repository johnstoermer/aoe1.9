// AOE 1.9 lobby + relay server.
//
// Rooms are 4-letter codes. Before start the server is a plain lobby; after
// start it becomes the tick sequencer: every 1000/TICK_RATE ms it drains each
// player's pending commands into a numbered Frame and broadcasts it. The
// server never simulates — determinism lives in the clients — but it does
// compare the state hashes clients report and announces desyncs.
//
// In production it also serves the built client from dist/.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_PORT, PROTOCOL_VERSION, type C2S, type RoomInfo, type S2C } from '../shared/protocol';
import type { Command, Frame, GameSetup } from '../shared/types';
import { MAX_PLAYERS, TICK_MS } from '../shared/types';
import { hashString } from '../shared/prng';

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);

interface Peer {
  id: number;
  ws: WebSocket;
  name: string;
  room: Room | null;
  alive: boolean;
}

interface Slot {
  name: string;
  isAI: boolean;
  aiLevel: number;
  color: number;
  ready: boolean;
  peer: Peer | null;
}

class Room {
  code: string;
  host: Peer;
  slots: Slot[] = [];
  mapSize = 80;
  started = false;
  // in-game state
  tick = 0;
  pending = new Map<number, Command[]>(); // player index -> queued commands
  history: Frame[] = [];
  hashes = new Map<number, Map<number, number>>(); // tick -> player -> hash
  desyncAnnounced = false;
  timer: ReturnType<typeof setInterval> | null = null;

  constructor(code: string, host: Peer) {
    this.code = code;
    this.host = host;
    this.slots.push(this.slotFor(host));
  }

  slotFor(peer: Peer): Slot {
    return { name: peer.name, isAI: false, aiLevel: 1, color: this.freeColor(), ready: false, peer };
  }

  freeColor(): number {
    for (let c = 0; c < MAX_PLAYERS; c++) {
      if (!this.slots.some((s) => s.color === c)) return c;
    }
    return 0;
  }

  info(): RoomInfo {
    return {
      code: this.code,
      hostPeer: this.host.id,
      mapSize: this.mapSize,
      started: this.started,
      slots: this.slots.map((s) => ({
        name: s.name, isAI: s.isAI, aiLevel: s.aiLevel, color: s.color,
        ready: s.isAI ? true : s.ready, peer: s.peer ? s.peer.id : -1,
      })),
    };
  }

  broadcast(msg: S2C, except?: Peer) {
    for (const s of this.slots) {
      if (s.peer && s.peer !== except) send(s.peer, msg);
    }
  }

  syncLobby() {
    for (const s of this.slots) {
      if (s.peer) send(s.peer, { t: 'room', room: this.info(), yourSlot: this.slots.indexOf(s) });
    }
  }

  playerIndexOf(peer: Peer): number {
    return this.slots.findIndex((s) => s.peer === peer);
  }

  start() {
    this.started = true;
    const setup: GameSetup = {
      seed: (hashString(this.code) ^ (Date.now() & 0x7fffffff)) >>> 0,
      mapSize: this.mapSize,
      players: this.slots.map((s) => ({
        name: s.name, color: s.color, isAI: s.isAI, aiLevel: s.aiLevel,
      })),
    };
    for (let i = 0; i < this.slots.length; i++) {
      const peer = this.slots[i].peer;
      if (peer) send(peer, { t: 'begin', setup, yourPlayer: i });
    }
    this.timer = setInterval(() => this.emitFrame(), TICK_MS);
    log(`room ${this.code}: started (${this.slots.length} players, map ${this.mapSize}, seed ${setup.seed})`);
  }

  emitFrame() {
    const commands: Frame['commands'] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const cmds = this.pending.get(i);
      if (cmds && cmds.length > 0) {
        commands.push({ player: i, cmds });
        this.pending.delete(i);
      }
    }
    const frame: Frame = { tick: this.tick++, commands };
    this.history.push(frame);
    this.broadcast({ t: 'frame', frame });
  }

  recordHash(player: number, tick: number, hash: number) {
    let perTick = this.hashes.get(tick);
    if (!perTick) this.hashes.set(tick, (perTick = new Map()));
    perTick.set(player, hash);
    const humans = this.slots.filter((s) => !s.isAI && s.peer).length;
    if (perTick.size >= humans && humans > 1) {
      const values = [...perTick.values()];
      if (values.some((v) => v !== values[0]) && !this.desyncAnnounced) {
        this.desyncAnnounced = true;
        log(`room ${this.code}: DESYNC at tick ${tick}`);
        this.broadcast({ t: 'desync', tick });
      }
      this.hashes.delete(tick);
    }
    // drop stale hash records
    if (this.hashes.size > 50) {
      const oldest = Math.min(...this.hashes.keys());
      this.hashes.delete(oldest);
    }
  }

  removePeer(peer: Peer) {
    const idx = this.slots.findIndex((s) => s.peer === peer);
    if (idx === -1) return;
    if (this.started) {
      // keep the slot (units go idle); tell the others
      this.slots[idx].peer = null;
      this.broadcast({ t: 'peerLeft', player: idx, name: this.slots[idx].name });
      if (this.slots.every((s) => !s.peer)) this.close();
    } else {
      this.slots.splice(idx, 1);
      if (peer === this.host && this.slots.length > 0) {
        const nextHost = this.slots.find((s) => s.peer);
        if (nextHost && nextHost.peer) this.host = nextHost.peer;
        else { this.close(); return; }
      }
      if (this.slots.length === 0) { this.close(); return; }
      this.syncLobby();
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    rooms.delete(this.code);
    log(`room ${this.code}: closed`);
  }
}

const rooms = new Map<string, Room>();
let peerSeq = 1;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function send(peer: Peer, msg: S2C) {
  if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(msg));
}

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(code)) return code;
  }
}

function sanitizeName(name: unknown): string {
  return String(name ?? '').replace(/[^\w \-'.]/g, '').trim().slice(0, 20) || 'Player';
}

function handleMessage(peer: Peer, msg: C2S) {
  const room = peer.room;
  switch (msg.t) {
    case 'hello': {
      peer.name = sanitizeName(msg.name);
      if (msg.version !== PROTOCOL_VERSION) {
        send(peer, { t: 'error', msg: 'Version mismatch — refresh the page.' });
      }
      break;
    }
    case 'create': {
      if (room) return;
      const r = new Room(makeCode(), peer);
      rooms.set(r.code, r);
      peer.room = r;
      r.syncLobby();
      log(`room ${r.code}: created by ${peer.name}`);
      break;
    }
    case 'join': {
      if (room) return;
      const code = String(msg.code ?? '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { send(peer, { t: 'error', msg: `No game found with code ${code || '—'}.` }); return; }
      if (r.started) { send(peer, { t: 'error', msg: 'That game has already started.' }); return; }
      if (r.slots.length >= MAX_PLAYERS) { send(peer, { t: 'error', msg: 'That game is full.' }); return; }
      peer.room = r;
      r.slots.push(r.slotFor(peer));
      r.syncLobby();
      break;
    }
    case 'leave': {
      if (!room) return;
      room.removePeer(peer);
      peer.room = null;
      send(peer, { t: 'left' });
      break;
    }
    case 'setName': {
      peer.name = sanitizeName(msg.name);
      if (room && !room.started) {
        const slot = room.slots.find((s) => s.peer === peer);
        if (slot) slot.name = peer.name;
        room.syncLobby();
      }
      break;
    }
    case 'setColor': {
      if (!room || room.started) return;
      const slot = room.slots.find((s) => s.peer === peer);
      const color = Number(msg.color) | 0;
      if (!slot || color < 0 || color >= MAX_PLAYERS) return;
      if (room.slots.some((s) => s !== slot && s.color === color)) return;
      slot.color = color;
      room.syncLobby();
      break;
    }
    case 'setMapSize': {
      if (!room || room.started || peer !== room.host) return;
      const size = Number(msg.mapSize) | 0;
      if (![64, 80, 96].includes(size)) return;
      room.mapSize = size;
      room.syncLobby();
      break;
    }
    case 'addAI': {
      if (!room || room.started || peer !== room.host) return;
      if (room.slots.length >= MAX_PLAYERS) return;
      const level = Math.max(0, Math.min(2, Number(msg.level) | 0));
      room.slots.push({
        name: `Computer (${['Easy', 'Normal', 'Hard'][level]})`,
        isAI: true, aiLevel: level, color: room.freeColor(), ready: true, peer: null,
      });
      room.syncLobby();
      break;
    }
    case 'removeSlot': {
      if (!room || room.started || peer !== room.host) return;
      const idx = Number(msg.index) | 0;
      const slot = room.slots[idx];
      if (!slot || slot.peer === peer) return;
      if (slot.peer) {
        send(slot.peer, { t: 'left' });
        slot.peer.room = null;
      }
      room.slots.splice(idx, 1);
      room.syncLobby();
      break;
    }
    case 'ready': {
      if (!room || room.started) return;
      const slot = room.slots.find((s) => s.peer === peer);
      if (slot) slot.ready = !!msg.ready;
      room.syncLobby();
      break;
    }
    case 'start': {
      if (!room || room.started || peer !== room.host) return;
      if (room.slots.length < 2) { send(peer, { t: 'error', msg: 'Add another player or a computer opponent first.' }); return; }
      const allReady = room.slots.every((s) => s.isAI || s.ready || s.peer === room.host);
      if (!allReady) { send(peer, { t: 'error', msg: 'Not everyone is ready yet.' }); return; }
      room.start();
      break;
    }
    case 'chat': {
      if (!room) return;
      const text = String(msg.text ?? '').slice(0, 200);
      if (text) room.broadcast({ t: 'chat', from: peer.name, text });
      break;
    }
    case 'cmds': {
      if (!room || !room.started) return;
      const player = room.playerIndexOf(peer);
      if (player === -1 || !Array.isArray(msg.cmds) || msg.cmds.length === 0) return;
      const list = room.pending.get(player) ?? [];
      if (list.length > 200) return; // flood guard
      list.push(...msg.cmds.slice(0, 50));
      room.pending.set(player, list);
      break;
    }
    case 'hash': {
      if (!room || !room.started) return;
      const player = room.playerIndexOf(peer);
      if (player !== -1) room.recordHash(player, Number(msg.tick) | 0, Number(msg.hash) >>> 0);
      break;
    }
    case 'pong':
      break;
  }
}

// --- static file serving (production build) ---------------------------------

const DIST = resolve(process.cwd(), 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(port: number): Promise<RunningServer> {
  const httpServer = createServer(async (req, res) => {
    try {
      const url = (req.url ?? '/').split('?')[0];
      let file = normalize(join(DIST, url === '/' ? 'index.html' : url));
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      try {
        const s = await stat(file);
        if (s.isDirectory()) file = join(file, 'index.html');
      } catch {
        file = join(DIST, 'index.html'); // SPA fallback
      }
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const peer: Peer = { id: peerSeq++, ws, name: 'Player', room: null, alive: true };
    send(peer, { t: 'welcome', peer: peer.id, version: PROTOCOL_VERSION });

    ws.on('message', (raw) => {
      let msg: C2S;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        handleMessage(peer, msg);
      } catch (err) {
        log(`error handling ${String((msg as { t?: string }).t)}: ${String(err)}`);
      }
    });
    ws.on('pong', () => { peer.alive = true; });
    ws.on('close', () => {
      if (peer.room) peer.room.removePeer(peer);
      peer.room = null;
    });
  });

  // keepalive: drop dead sockets so rooms don't hang
  const keepalive = setInterval(() => {
    for (const ws of wss.clients) ws.ping();
  }, 15000);

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const actual = (httpServer.address() as { port: number }).port;
      log(`AOE 1.9 server listening on :${actual} (ws path /ws)`);
      resolve({
        port: actual,
        close: () => new Promise<void>((done) => {
          clearInterval(keepalive);
          for (const r of rooms.values()) r.close();
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => httpServer.close(() => done()));
        }),
      });
    });
  });
}

// started directly (npm run dev/start) — not when imported by tests
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  void startServer(PORT);
}
