// Wire protocol between client and lobby/relay server. JSON over WebSocket.
//
// Multiplayer model: server-sequenced lockstep. Clients never exchange state —
// they send commands, the server stamps them into numbered frames at the sim
// tick rate, and every client (plus the in-sim AI) executes the identical
// frame stream. Desyncs are detected by comparing periodic state hashes.

import type { Command, Frame, GameSetup } from './types';

export const PROTOCOL_VERSION = 1;
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
  slots: LobbySlot[];
  started: boolean;
}

export type C2S =
  | { t: 'hello'; name: string; version: number }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'setName'; name: string }
  | { t: 'setColor'; color: number }
  | { t: 'setMapSize'; mapSize: number }        // host only
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
  | { t: 'chat'; from: string; text: string }
  | { t: 'desync'; tick: number }
  | { t: 'peerLeft'; player: number; name: string }
  | { t: 'ping'; nonce: number };

export const MAP_SIZES = [
  { name: 'Small', tiles: 64 },
  { name: 'Medium', tiles: 80 },
  { name: 'Large', tiles: 96 },
];
