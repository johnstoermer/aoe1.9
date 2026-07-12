// Front-end screens: Win98 desktop with taskbar, main menu, single-player
// skirmish setup, and the multiplayer connect/lobby flow.

import { GAME_SPEEDS, MAP_SIZES, MAP_TYPES, type RoomInfo } from '../../shared/protocol';
import type { GameMode, MapTypeId } from '../../shared/types';
import { PLAYER_COLORS } from '../../shared/data';
import { MAX_PLAYERS } from '../../shared/types';
import { audio } from '../audio';
import { el, makeWindow } from './widgets';

export interface SkirmishConfig {
  playerName: string;
  mapSize: number;
  mapType: MapTypeId;
  mode: GameMode;
  gameSpeed: number;
  discovered: boolean;
  aiCount: number;
  aiLevel: number;
  seed: string;
}

const NAME_KEY = 'aoe19-name';

export function savedName(): string {
  return localStorage.getItem(NAME_KEY) || `Chieftain${100 + Math.floor(Math.random() * 900)}`;
}

export function saveName(name: string) {
  localStorage.setItem(NAME_KEY, name);
}

function screen(className = ''): HTMLDivElement {
  const s = el('div', { class: `screen desktop ${className}` }) as HTMLDivElement;
  document.getElementById('ui-root')!.appendChild(s);
  return s;
}

function titleBlock(): HTMLElement {
  return el('div', { class: 'title-block' },
    el('h1', { text: 'AOE 1.9' }),
  );
}

// ---------------------------------------------------------------------------

export function showMainMenu(cb: {
  onSinglePlayer(): void;
  onMultiplayer(): void;
  onAbout(): void;
  onAnimationTester(): void;
  onGodMode(): void;
}): () => void {
  const s = screen();
  const wrap = el('div', { class: 'main-menu-shell' });
  wrap.appendChild(titleBlock());
  const win = makeWindow('Main Menu', { width: 340, closable: false, className: 'menu-window' });

  const sp = el('button', { text: 'Single Player' });
  sp.addEventListener('click', () => { audio.unlock(); audio.play('click'); cb.onSinglePlayer(); });
  const mp = el('button', { text: 'Multiplayer' });
  mp.addEventListener('click', () => { audio.unlock(); audio.play('click'); cb.onMultiplayer(); });
  const about = el('button', { text: 'About / Controls' });
  about.addEventListener('click', () => { audio.unlock(); audio.play('click'); cb.onAbout(); });
  win.body.append(sp, mp, about);

  wrap.appendChild(win.root);
  s.appendChild(wrap);

  const debugMenu = el('div', { class: 'debug-context-menu window' });
  const animationTester = el('button', { text: 'Character Animation Tester' });
  animationTester.addEventListener('click', cb.onAnimationTester);
  const godMode = el('button', { text: 'Debug / Test / God Mode' });
  godMode.addEventListener('click', cb.onGodMode);
  debugMenu.append(animationTester, godMode);
  s.appendChild(debugMenu);
  const hideDebug = (event: PointerEvent) => {
    if (!debugMenu.contains(event.target as Node)) debugMenu.style.display = 'none';
  };
  s.addEventListener('contextmenu', (event) => {
    if (event.target !== s) return;
    event.preventDefault();
    debugMenu.style.left = `${Math.min(event.clientX, innerWidth - 230)}px`;
    debugMenu.style.top = `${Math.min(event.clientY, innerHeight - 70)}px`;
    debugMenu.style.display = 'flex';
  });
  window.addEventListener('pointerdown', hideDebug);
  return () => {
    window.removeEventListener('pointerdown', hideDebug);
    s.remove();
  };
}

export function showAbout(onBack: () => void): () => void {
  const s = screen();
  const win = makeWindow('About AOE 1.9', { width: 520, onClose: onBack });
  win.body.innerHTML = `
    <p><b>AOE 1.9</b> is a streamlined, open-source RTS in the spirit of Age of Empires II:
    gather food, wood, gold and stone; advance through three ages; raise an army; raze your rivals.</p>
    <p><b>Modern Mode</b> uses autonomous villager roles, automatic villager production, global building placement,
    and separate 25-villager / 200-military caps. <b>Classic Mode</b> preserves direct villager control, drop-offs,
    Houses, and the original shared population system.</p>
    <fieldset><legend>Controls</legend>
      <p>
      <b>Left click / drag</b> select &nbsp; <b>Right click</b> move / gather / attack / rally<br>
      <b>Shift</b> queue orders &nbsp; <b>A</b> attack-move &nbsp; <b>S</b> stop &nbsp; <b>Delete</b> delete<br>
      <b>Ctrl+1–9</b> set control group &nbsp; <b>1–9</b> recall (twice to center)<br>
      <b>H</b> town center &nbsp; <b>.</b> idle villager &nbsp; <b>Esc</b> cancel<br>
      <b>Arrows / edge / middle-drag</b> pan camera &nbsp; <b>Wheel</b> zoom
      </p>
    </fieldset>
    <p>Made with three.js, 98.css, and KayKit's wonderful CC0 model packs.</p>`;
  const back = el('button', { text: 'Back' });
  back.addEventListener('click', onBack);
  win.body.appendChild(el('div', { class: 'dialog-buttons' }, back));
  s.appendChild(win.root);
  return () => s.remove();
}

// ---------------------------------------------------------------------------

export function showSkirmishSetup(cb: {
  onStart(config: SkirmishConfig): void;
  onBack(): void;
}): () => void {
  const s = screen();
  const win = makeWindow('Single Player — Skirmish', { width: 420, onClose: cb.onBack });

  const nameRow = el('div', { class: 'field-row' });
  nameRow.appendChild(el('label', { text: 'Your name' }));
  const nameInput = el('input', { type: 'text', value: savedName(), maxlength: '20' }) as HTMLInputElement;
  nameRow.appendChild(nameInput);

  const mapRow = el('div', { class: 'field-row' });
  mapRow.appendChild(el('label', { text: 'Map size' }));
  const mapSel = el('select') as HTMLSelectElement;
  for (const m of MAP_SIZES) mapSel.appendChild(el('option', { value: String(m.tiles), text: `${m.name} (${m.tiles}×${m.tiles})` }));
  mapSel.value = '80';
  mapRow.appendChild(mapSel);

  const mapTypeRow = el('div', { class: 'field-row' });
  mapTypeRow.appendChild(el('label', { text: 'Map' }));
  const mapTypeSel = el('select') as HTMLSelectElement;
  for (const map of MAP_TYPES) mapTypeSel.appendChild(el('option', { value: map.id, text: map.name, title: map.description }));
  mapTypeRow.appendChild(mapTypeSel);

  const modeRow = el('div', { class: 'field-row' });
  modeRow.appendChild(el('label', { text: 'Rules' }));
  const modeSel = el('select') as HTMLSelectElement;
  modeSel.append(
    el('option', { value: 'modern', text: 'Modern Mode — autonomous economy' }),
    el('option', { value: 'classic', text: 'Classic Mode — direct villagers' }),
  );
  modeRow.appendChild(modeSel);

  const speedRow = el('div', { class: 'field-row' });
  speedRow.appendChild(el('label', { text: 'Game speed' }));
  const speedSel = el('select') as HTMLSelectElement;
  for (const speed of GAME_SPEEDS) speedSel.appendChild(el('option', { value: String(speed), text: `${speed}×` }));
  speedSel.value = '3';
  speedRow.appendChild(speedSel);

  const discoveredRow = el('div', { class: 'field-row' });
  const discovered = el('input', { type: 'checkbox' }) as HTMLInputElement;
  discovered.checked = true;
  discoveredRow.append(discovered, el('label', { text: 'Start with the full map discovered' }));

  const aiRow = el('div', { class: 'field-row' });
  aiRow.appendChild(el('label', { text: 'Opponents' }));
  const aiSel = el('select') as HTMLSelectElement;
  for (let i = 1; i <= MAX_PLAYERS - 1; i++) aiSel.appendChild(el('option', { value: String(i), text: `${i} computer${i > 1 ? 's' : ''}` }));
  aiRow.appendChild(aiSel);

  const lvlRow = el('div', { class: 'field-row' });
  lvlRow.appendChild(el('label', { text: 'Difficulty' }));
  const lvlSel = el('select') as HTMLSelectElement;
  ['Easy', 'Normal', 'Hard'].forEach((n, i) => lvlSel.appendChild(el('option', { value: String(i), text: n })));
  lvlSel.value = '1';
  lvlRow.appendChild(lvlSel);

  const seedRow = el('div', { class: 'field-row' });
  seedRow.appendChild(el('label', { text: 'Map seed' }));
  const seedInput = el('input', { type: 'text', value: String(Math.floor(Math.random() * 1e6)), maxlength: '24' }) as HTMLInputElement;
  seedRow.appendChild(seedInput);

  const buttons = el('div', { class: 'dialog-buttons' });
  const start = el('button', { text: 'Start Game' });
  start.addEventListener('click', () => {
    saveName(nameInput.value.trim() || 'Player');
    audio.play('click');
    cb.onStart({
      playerName: nameInput.value.trim() || 'Player',
      mapSize: Number(mapSel.value),
      mapType: mapTypeSel.value as MapTypeId,
      mode: modeSel.value as GameMode,
      gameSpeed: Number(speedSel.value),
      discovered: discovered.checked,
      aiCount: Number(aiSel.value),
      aiLevel: Number(lvlSel.value),
      seed: seedInput.value,
    });
  });
  const back = el('button', { text: 'Back' });
  back.addEventListener('click', cb.onBack);
  buttons.append(start, back);

  win.body.append(nameRow, modeRow, mapTypeRow, mapRow, speedRow, discoveredRow, aiRow, lvlRow, seedRow, buttons);
  s.appendChild(win.root);
  return () => s.remove();
}

// ---------------------------------------------------------------------------
// Multiplayer
// ---------------------------------------------------------------------------

export function showMultiplayerConnect(cb: {
  onCreate(name: string): void;
  onJoin(name: string, code: string): void;
  onBack(): void;
}): () => void {
  const s = screen();
  const win = makeWindow('Multiplayer', { width: 400, onClose: cb.onBack });

  const nameRow = el('div', { class: 'field-row' });
  nameRow.appendChild(el('label', { text: 'Your name' }));
  const nameInput = el('input', { type: 'text', value: savedName(), maxlength: '20' }) as HTMLInputElement;
  nameRow.appendChild(nameInput);

  const host = el('button', { text: 'Host New Game' });
  host.style.width = '100%';
  host.addEventListener('click', () => {
    saveName(nameInput.value.trim() || 'Player');
    cb.onCreate(nameInput.value.trim() || 'Player');
  });

  win.body.append(nameRow, el('hr'), host, el('p', { text: 'or join a friend:' }));

  const joinRow = el('div', { class: 'field-row' });
  joinRow.appendChild(el('label', { text: 'Game code' }));
  const codeInput = el('input', { type: 'text', maxlength: '4', placeholder: 'ABCD' }) as HTMLInputElement;
  codeInput.style.textTransform = 'uppercase';
  joinRow.appendChild(codeInput);
  const join = el('button', { text: 'Join' });
  join.addEventListener('click', () => {
    saveName(nameInput.value.trim() || 'Player');
    cb.onJoin(nameInput.value.trim() || 'Player', codeInput.value.trim().toUpperCase());
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
  joinRow.appendChild(join);
  win.body.appendChild(joinRow);

  const back = el('button', { text: 'Back' });
  back.addEventListener('click', cb.onBack);
  win.body.appendChild(el('div', { class: 'dialog-buttons' }, back));

  s.appendChild(win.root);
  return () => s.remove();
}

export interface LobbyActions {
  setColor(color: number): void;
  setMapSize(size: number): void;
  setMapType(mapType: MapTypeId): void;
  setMode(mode: GameMode): void;
  setGameSpeed(speed: number): void;
  setDiscovered(discovered: boolean): void;
  addAI(level: number): void;
  removeSlot(index: number): void;
  setReady(ready: boolean): void;
  start(): void;
  sendChat(text: string): void;
  leave(): void;
}

export class LobbyScreen {
  private s: HTMLDivElement;
  private slotsBox: HTMLDivElement;
  private chatBox: HTMLDivElement;
  private startBtn: HTMLButtonElement;
  private readyBtn: HTMLButtonElement;
  private mapSel: HTMLSelectElement;
  private mapTypeSel: HTMLSelectElement;
  private modeSel: HTMLSelectElement;
  private speedSel: HTMLSelectElement;
  private discoveredCheck: HTMLInputElement;
  private codeSpan: HTMLElement;
  private actions: LobbyActions;
  private myPeer: number;

  constructor(actions: LobbyActions, myPeer: number) {
    this.actions = actions;
    this.myPeer = myPeer;
    this.s = screen();
    const win = makeWindow('Game Lobby', { width: 560, className: 'lobby-window', onClose: () => actions.leave() });

    const codeRow = el('div', { class: 'field-row' });
    codeRow.appendChild(el('label', { text: 'Game code:' }));
    this.codeSpan = el('b', { id: 'room-code', text: '----', style: 'font-size:16px; letter-spacing:3px;' });
    codeRow.appendChild(this.codeSpan);
    codeRow.appendChild(el('span', { text: ' — share it with your friends' }));

    this.slotsBox = el('div', { class: 'sunken-panel', style: 'padding:2px; min-height:120px;' }) as HTMLDivElement;

    const modeRow = el('div', { class: 'field-row' });
    modeRow.appendChild(el('label', { text: 'Rules' }));
    this.modeSel = el('select') as HTMLSelectElement;
    this.modeSel.append(
      el('option', { value: 'modern', text: 'Modern Mode' }),
      el('option', { value: 'classic', text: 'Classic Mode' }),
    );
    this.modeSel.addEventListener('change', () => this.actions.setMode(this.modeSel.value as GameMode));
    modeRow.appendChild(this.modeSel);

    const mapRow = el('div', { class: 'field-row' });
    mapRow.appendChild(el('label', { text: 'Map size' }));
    this.mapSel = el('select') as HTMLSelectElement;
    for (const m of MAP_SIZES) this.mapSel.appendChild(el('option', { value: String(m.tiles), text: `${m.name} (${m.tiles}×${m.tiles})` }));
    this.mapSel.addEventListener('change', () => this.actions.setMapSize(Number(this.mapSel.value)));
    mapRow.appendChild(this.mapSel);

    mapRow.appendChild(el('label', { text: 'Map' }));
    this.mapTypeSel = el('select') as HTMLSelectElement;
    for (const map of MAP_TYPES) this.mapTypeSel.appendChild(el('option', { value: map.id, text: map.name }));
    this.mapTypeSel.addEventListener('change', () => this.actions.setMapType(this.mapTypeSel.value as MapTypeId));
    mapRow.appendChild(this.mapTypeSel);

    mapRow.appendChild(el('label', { text: 'Speed' }));
    this.speedSel = el('select') as HTMLSelectElement;
    for (const speed of GAME_SPEEDS) this.speedSel.appendChild(el('option', { value: String(speed), text: `${speed}×` }));
    this.speedSel.addEventListener('change', () => this.actions.setGameSpeed(Number(this.speedSel.value)));
    mapRow.appendChild(this.speedSel);

    this.discoveredCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.discoveredCheck.addEventListener('change', () => this.actions.setDiscovered(this.discoveredCheck.checked));
    mapRow.append(this.discoveredCheck, el('label', { text: 'Discovered fog' }));

    const addAiBtn = el('button', { text: 'Add Computer' });
    addAiBtn.addEventListener('click', () => this.actions.addAI(1));
    mapRow.appendChild(addAiBtn);

    this.chatBox = el('div', { class: 'lobby-chat' }) as HTMLDivElement;
    const chatRow = el('div', { class: 'field-row' });
    const chatInput = el('input', { type: 'text', maxlength: '160', placeholder: 'Say something…' }) as HTMLInputElement;
    chatInput.style.flex = '1';
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && chatInput.value.trim()) {
        this.actions.sendChat(chatInput.value.trim());
        chatInput.value = '';
      }
    });
    chatRow.appendChild(chatInput);

    const buttons = el('div', { class: 'dialog-buttons' });
    this.readyBtn = el('button', { text: 'Ready' }) as HTMLButtonElement;
    let ready = false;
    this.readyBtn.addEventListener('click', () => {
      ready = !ready;
      this.readyBtn.textContent = ready ? 'Not Ready' : 'Ready';
      this.actions.setReady(ready);
    });
    this.startBtn = el('button', { text: 'Start Game' }) as HTMLButtonElement;
    this.startBtn.addEventListener('click', () => this.actions.start());
    const leave = el('button', { text: 'Leave' });
    leave.addEventListener('click', () => this.actions.leave());
    buttons.append(this.startBtn, this.readyBtn, leave);

    win.body.append(codeRow, this.slotsBox, modeRow, mapRow, this.chatBox, chatRow, buttons);
    this.s.appendChild(win.root);
  }

  update(room: RoomInfo, yourSlot: number) {
    this.codeSpan.textContent = room.code;
    this.mapSel.value = String(room.mapSize);
    this.mapTypeSel.value = room.mapType;
    this.modeSel.value = room.mode;
    this.speedSel.value = String(room.gameSpeed);
    this.discoveredCheck.checked = room.discovered;
    const isHost = room.hostPeer === this.myPeer;
    this.mapSel.disabled = !isHost;
    this.mapTypeSel.disabled = !isHost;
    this.modeSel.disabled = !isHost;
    this.speedSel.disabled = !isHost;
    this.discoveredCheck.disabled = !isHost;
    this.startBtn.style.display = isHost ? '' : 'none';
    this.readyBtn.style.display = isHost ? 'none' : '';

    this.slotsBox.textContent = '';
    room.slots.forEach((slot, i) => {
      const row = el('div', { class: 'slot-row' });
      const chip = el('div', { class: 'color-chip' });
      chip.style.background = PLAYER_COLORS[slot.color].css;
      if (i === yourSlot) {
        chip.style.cursor = 'pointer';
        chip.title = 'Click to change color';
        chip.addEventListener('click', () => this.actions.setColor((slot.color + 1) % MAX_PLAYERS));
      }
      row.appendChild(chip);
      row.appendChild(el('span', { class: 'slot-name', text: `${slot.name}${i === yourSlot ? ' (you)' : ''}${room.hostPeer === slot.peer ? ' 👑' : ''}` }));
      row.appendChild(el('span', { text: slot.isAI ? 'Computer' : slot.ready || slot.peer === room.hostPeer ? 'Ready' : 'Not ready' }));
      if (isHost && i !== yourSlot) {
        const kick = el('button', { text: slot.isAI ? 'Remove' : 'Kick' });
        kick.addEventListener('click', () => this.actions.removeSlot(i));
        row.appendChild(kick);
      }
      this.slotsBox.appendChild(row);
    });
  }

  addChat(from: string, text: string) {
    this.chatBox.appendChild(el('div', { text: `${from}: ${text}` }));
    this.chatBox.scrollTop = this.chatBox.scrollHeight;
  }

  close() {
    this.s.remove();
  }
}

// ---------------------------------------------------------------------------

export function showLoading(label: string): { setProgress(pct: number, text: string): void; close(): void } {
  const s = screen();
  const win = makeWindow(label, { width: 340, closable: false });
  const text = el('p', { text: 'Preparing…' });
  const bar = el('div', { class: 'loading-bar' }, el('div'));
  win.body.append(text, bar);
  s.appendChild(win.root);
  return {
    setProgress(pct: number, t: string) {
      (bar.firstChild as HTMLElement).style.width = `${pct}%`;
      text.textContent = t;
    },
    close: () => s.remove(),
  };
}
