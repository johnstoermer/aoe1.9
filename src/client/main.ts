// Application entry: screen flow (menu → skirmish/lobby → game → back),
// wiring GameClient + Hud + InputController together for both the local
// single-player path and the server-backed multiplayer path.

import './style.css';
import { hashString } from '../shared/prng';
import type { GameSetup } from '../shared/types';
import { audio } from './audio';
import { GameClient } from './game';
import { InputController } from './input';
import { LocalTransport, type Transport } from './transport';
import { NetClient } from './net';
import {
  LobbyScreen, showAbout, showLoading, showMainMenu, showMultiplayerConnect,
  showSkirmishSetup, type SkirmishConfig,
} from './ui/menus';
import { Hud } from './ui/hud';
import { toast } from './ui/widgets';
import { showAnimationTester } from './debug/animationTester';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay-canvas') as HTMLCanvasElement;

let teardown: (() => void) | null = null;

function switchScreen(builder: () => () => void) {
  teardown?.();
  teardown = builder();
}

// ---------------------------------------------------------------------------
// Game session
// ---------------------------------------------------------------------------

interface SessionOpts {
  setup: GameSetup;
  you: number;
  transport: Transport;
  net?: NetClient; // present in multiplayer for chat/desync events
  debug?: boolean;
}

function startGame(opts: SessionOpts) {
  teardown?.();
  teardown = null;
  const loading = showLoading('Loading AOE 1.9');

  let hud: Hud | null = null;
  let input: InputController | null = null;

  const game = new GameClient(canvas, overlay, opts.setup, opts.you, opts.transport, {
    onSelectionChange: () => hud?.refresh(),
    onToast: (text, warn) => toast(text, warn),
    onPlayerUpdate: () => {},
    onGameOver: (winner) => hud?.showGameOver(winner),
    onDesync: () => hud?.showDesync(),
  });
  // handle for e2e tests and console debugging
  (window as unknown as { __game?: GameClient }).__game = game;

  const quitToMenu = () => {
    input?.dispose();
    hud?.dispose();
    game.dispose();
    opts.net?.close();
    showMenu();
  };

  void game.start((pct, label) => loading.setProgress(pct, `Loading ${label}…`))
    .then(() => {
      loading.close();
      if (opts.debug) game.enableGodMode();
      hud = new Hud(game);
      hud.onQuit = quitToMenu;
      input = new InputController(game, {
        onHotkey: (k) => hud!.onHotkey(k),
        onEscape: () => hud!.onEscape(),
      });
      game.preFrame = () => {
        input!.update();
        hud!.update(1 / 60);
      };

      if (opts.net) {
        hud.onSendChat = (text) => opts.net!.send({ t: 'chat', text });
        opts.net.handler.onChat = (from, text) => hud?.addChat(from, text);
        opts.net.handler.onPeerLeft = (_player, name) => toast(`${name} left the game.`, true);
        opts.net.handler.onDesync = () => game.markDesynced();
        opts.net.handler.onClose = () => toast('Connection to server lost.', true);
      }
    })
    .catch((err) => {
      console.error(err);
      loading.close();
      toast(`Failed to load the game: ${String(err)}`, true);
      quitToMenu();
    });
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showMenu() {
  switchScreen(() => showMainMenu({
    onSinglePlayer: () => switchScreen(() => showSkirmishSetup({
      onStart: startSkirmish,
      onBack: showMenu,
    })),
    onMultiplayer: showMultiplayerFlow,
    onAbout: () => switchScreen(() => showAbout(showMenu)),
    onAnimationTester: () => switchScreen(() => showAnimationTester(showMenu)),
    onGodMode: startGodMode,
  }));
}

function startGodMode() {
  const setup: GameSetup = {
    seed: 1919,
    mapSize: 64,
    mapType: 'arabia',
    mode: 'modern',
    gameSpeed: 1,
    discovered: true,
    players: [
      { name: 'God Mode', color: 0, isAI: false, aiLevel: 0 },
      { name: 'Target Dummies', color: 1, isAI: false, aiLevel: 0 },
    ],
  };
  const transport = new LocalTransport(setup);
  startGame({ setup, you: 0, transport, debug: true });
}

function startSkirmish(cfg: SkirmishConfig) {
  const seedNum = /^\d+$/.test(cfg.seed) ? Number(cfg.seed) >>> 0 : hashString(cfg.seed);
  const setup: GameSetup = {
    seed: seedNum || 1,
    mapSize: cfg.mapSize,
    mapType: cfg.mapType,
    mode: cfg.mode,
    gameSpeed: cfg.gameSpeed,
    discovered: cfg.discovered,
    players: [
      { name: cfg.playerName, color: 0, isAI: false, aiLevel: 0 },
      ...Array.from({ length: cfg.aiCount }, (_, i) => ({
        name: `Computer ${i + 1} (${['Easy', 'Normal', 'Hard'][cfg.aiLevel]})`,
        color: i + 1,
        isAI: true,
        aiLevel: cfg.aiLevel,
      })),
    ],
  };
  const transport = new LocalTransport(setup);
  transport.speed = setup.gameSpeed ?? 3;
  startGame({ setup, you: 0, transport });
}

function showMultiplayerFlow() {
  switchScreen(() => showMultiplayerConnect({
    onBack: showMenu,
    onCreate: (name) => void connectAnd(name, (net) => net.send({ t: 'create' })),
    onJoin: (name, code) => {
      if (code.length !== 4) { toast('Enter the 4-letter game code.', true); return; }
      void connectAnd(name, (net) => net.send({ t: 'join', code }));
    },
  }));
}

async function connectAnd(name: string, then: (net: NetClient) => void) {
  const net = new NetClient();
  try {
    await net.connect();
  } catch {
    toast('Could not reach the game server. Is it running?', true);
    return;
  }
  net.hello(name);

  let lobby: LobbyScreen | null = null;
  net.handler.onError = (msg) => toast(msg, true);
  net.handler.onRoom = (room, yourSlot) => {
    if (!lobby) {
      teardown?.();
      teardown = null;
      lobby = new LobbyScreen({
        setColor: (c) => net.send({ t: 'setColor', color: c }),
        setMapSize: (m) => net.send({ t: 'setMapSize', mapSize: m }),
        setMapType: (mapType) => net.send({ t: 'setMapType', mapType }),
        setMode: (mode) => net.send({ t: 'setMode', mode }),
        setGameSpeed: (gameSpeed) => net.send({ t: 'setGameSpeed', gameSpeed }),
        setDiscovered: (discovered) => net.send({ t: 'setDiscovered', discovered }),
        addAI: (level) => net.send({ t: 'addAI', level }),
        removeSlot: (i) => net.send({ t: 'removeSlot', index: i }),
        setReady: (r) => net.send({ t: 'ready', ready: r }),
        start: () => net.send({ t: 'start' }),
        sendChat: (text) => net.send({ t: 'chat', text }),
        leave: () => {
          net.send({ t: 'leave' });
          net.close();
          lobby?.close();
          lobby = null;
          showMenu();
        },
      }, net.peerId);
      teardown = () => lobby?.close();
    }
    lobby.update(room, yourSlot);
  };
  net.handler.onChat = (from, text) => lobby?.addChat(from, text);
  net.handler.onLeft = () => {
    lobby?.close();
    lobby = null;
    showMenu();
  };
  net.handler.onClose = () => {
    if (lobby) {
      toast('Connection to server lost.', true);
      lobby.close();
      lobby = null;
      showMenu();
    }
  };
  net.handler.onBegin = (setup, yourPlayer) => {
    lobby?.close();
    lobby = null;
    startGame({ setup, you: yourPlayer, transport: net, net });
  };
  then(net);
}

// ---------------------------------------------------------------------------

// unlock audio on the very first interaction anywhere
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

showMenu();
