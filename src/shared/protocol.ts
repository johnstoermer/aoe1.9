// Wire protocol between client and lobby/relay server. JSON over WebSocket.
//
// Multiplayer model: server-sequenced lockstep. Clients never exchange state —
// they send commands, the server stamps them into numbered frames at the sim
// tick rate, and every client (plus the in-sim AI) executes the identical
// frame stream. Desyncs are detected by comparing periodic state hashes.

import type { Command, Frame, GameMode, GameSetup, MapTypeId } from './types';

export const PROTOCOL_VERSION = 4;
export const DEFAULT_PORT = 8080;
export const HASH_PERIOD = 60; // report a state hash every N ticks (4s)

export interface LobbySlot {
  name: string;
  isAI: boolean;
  aiLevel: number;
  color: number;
  ready: boolean;
  /** Peer id for humans, -1 for AI slots. */
  peer: number;
}

export interface RoomInfo {
  code: string;
  hostPeer: number;
  mapSize: number;
  mapType: MapTypeId;
  mode: GameMode;
  gameSpeed: number;
  discovered: boolean;
  slots: LobbySlot[];
  started: boolean;
}

export type C2S =
  | { t: 'hello'; name: string; version: number }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'reconnect'; code: string; name: string; tick: number }
  | { t: 'leave' }
  | { t: 'setName'; name: string }
  | { t: 'setColor'; color: number }
  | { t: 'setMapSize'; mapSize: number }        // host only
  | { t: 'setMapType'; mapType: MapTypeId }     // host only
  | { t: 'setMode'; mode: GameMode }             // host only
  | { t: 'setGameSpeed'; gameSpeed: number }    // host only
  | { t: 'setDiscovered'; discovered: boolean } // host only
  | { t: 'addAI'; level: number }               // host only
  | { t: 'removeSlot'; index: number }          // host only
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }                              // host only
  | { t: 'chat'; text: string }
  | { t: 'cmds'; cmds: Command[] }              // in-game: enqueue for next frame
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'pong'; nonce: number };

export type S2C =
  | { t: 'welcome'; peer: number; version: number }
  | { t: 'error'; msg: string }
  | { t: 'room'; room: RoomInfo; yourSlot: number }
  | { t: 'left' }
  | { t: 'begin'; setup: GameSetup; yourPlayer: number }
  | { t: 'frame'; frame: Frame }
  | { t: 'frames'; frames: Frame[] }            // catch-up batch
  | { t: 'reconnected'; player: number; frames: Frame[] }
  | { t: 'chat'; from: string; text: string }
  | { t: 'desync'; tick: number }
  | { t: 'peerLeft'; player: number; name: string }
  | { t: 'ping'; nonce: number };

export const MAP_SIZES = [
  { name: 'Small', tiles: 64 },
  { name: 'Medium', tiles: 80 },
  { name: 'Large', tiles: 96 },
];

export const MAP_TYPES: { id: MapTypeId; name: string; description: string }[] = [
  { id: 'arabia', name: 'Arabia', description: 'Dry open ground, scattered forests and fast aggression.' },
  { id: 'arena', name: 'Arena', description: 'Green bases enclosed by stone walls for safer booming.' },
  { id: 'blackforest', name: 'Black Forest', description: 'Snowy dense pine forests and narrow chokepoints.' },
];

export const GAME_SPEEDS = [1, 2, 3, 4];
