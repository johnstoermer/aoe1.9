// In-game HUD, all Win98: top resource bar, minimap window, command card +
// selection panel window, pause/settings dialogs, chat, and the game-over
// screen with the classic score table.

import { AGE_NAMES, BUILDINGS, PLAYER_COLORS, TECHS, UNITS } from '../../shared/data';
import { FP_BITS, toTiles } from '../../shared/fixed';
import type { BuildingTypeId, Entity, TechId, UnitTypeId } from '../../shared/types';
import { POP_CAP } from '../../shared/types';
import { audio } from '../audio';
import { drawResourceIcon, glyphIcon, renderModelIcon } from '../assets';
import type { GameClient } from '../game';
import { loadModel, instantiate } from '../assets';
import { buildingModelPath } from '../render/buildings';
import { modelPathFor } from '../render/units';
import { applyTeamColor } from '../assets';
import { fitTo } from '../render/units';
import { bindTooltip, confirmDialog, costText, el, hideTooltip, makeWindow, modal, toast } from './widgets';

const MINIMAP_SIZE = 176;

export class Hud {
  private game: GameClient;
  private root: HTMLDivElement;
  private resBar!: HTMLDivElement;
  private resSpans = new Map<string, HTMLSpanElement>();
  private ageSpan!: HTMLSpanElement;
  private idleBtn!: HTMLButtonElement;
  private cmdGrid!: HTMLDivElement;
  private selInfo!: HTMLDivElement;
  private minimap!: HTMLCanvasElement;
  private minimapBase!: HTMLCanvasElement;
  private chatLog!: HTMLDivElement;
  private chatInputRow!: HTMLDivElement;
  private chatInput!: HTMLInputElement;
  private unitIconCache = new Map<string, string>();
  private hotkeyMap = new Map<string, () => void>();
  private minimapTimer = 0;
  private refreshTimer = 0;
  private disposers: (() => void)[] = [];
  onSendChat: ((text: string) => void) | null = null;
  onQuit: () => void = () => {};

  constructor(game: GameClient) {
    this.game = game;
    this.root = el('div', { id: 'hud' }) as HTMLDivElement;
    document.getElementById('ui-root')!.appendChild(this.root);
    this.buildResourceBar();
    this.buildMinimap();
    this.buildPanel();
    this.buildChat();
    this.renderMinimapBase();
    this.refresh();
    this.update(0.05);
  }

  /** Register a window-level listener that dies with this Hud. */
  private listen(target: EventTarget, type: string, fn: (e: Event) => void) {
    target.addEventListener(type, fn);
    this.disposers.push(() => target.removeEventListener(type, fn));
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.disposers.length = 0;
    hideTooltip();
    // any modal this Hud opened (menu, game over) must not outlive it
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Resource bar
  // -------------------------------------------------------------------------

  private buildResourceBar() {
    this.resBar = el('div', { class: 'resource-bar' }) as HTMLDivElement;
    for (const kind of ['food', 'wood', 'gold', 'stone', 'pop']) {
      const icon = el('img', { src: drawResourceIcon(kind), alt: kind });
      const span = el('span', { text: '0' });
      const box = el('div', { class: 'res' }, icon, span);
      bindTooltip(box, () => kind === 'pop' ? 'Population / cap (build Houses to raise it)' : `Stockpiled ${kind}`);
      this.resSpans.set(kind, span);
      this.resBar.appendChild(box);
    }
    this.ageSpan = el('span', { class: 'age-label', text: AGE_NAMES[0] });
    this.resBar.appendChild(this.ageSpan);
    this.resBar.appendChild(el('div', { class: 'spacer' }));

    this.idleBtn = el('button', { text: 'Idle: 0' }) as HTMLButtonElement;
    this.idleBtn.addEventListener('click', () => this.game.selectNextIdleVillager());
    bindTooltip(this.idleBtn, () => 'Select next idle villager (.)');
    this.resBar.appendChild(this.idleBtn);

    const menuBtn = el('button', { text: 'Menu' });
    menuBtn.addEventListener('click', () => this.openMenu());
    this.resBar.appendChild(menuBtn);
    this.root.appendChild(this.resBar);
  }

  private refreshResources() {
    const p = this.game.world.players[this.game.you];
    for (const kind of ['food', 'wood', 'gold', 'stone'] as const) {
      const span = this.resSpans.get(kind)!;
      span.textContent = String(p.stock[kind]);
    }
    const pop = this.resSpans.get('pop')!;
    pop.textContent = `${p.pop}/${p.popCap}`;
    pop.className = p.pop >= p.popCap && p.popCap < POP_CAP ? 'low' : '';
    this.ageSpan.textContent = AGE_NAMES[p.age];
    const idle = this.game.idleVillagerCount();
    this.idleBtn.textContent = `Idle: ${idle}`;
    (this.idleBtn.style as CSSStyleDeclaration).fontWeight = idle > 0 ? 'bold' : 'normal';
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------

  private buildMinimap() {
    const win = makeWindow('World', { closable: false, draggable: false, className: 'hud-window' });
    win.root.id = 'minimap-window';
    this.minimap = el('canvas', { id: 'minimap-canvas' }) as HTMLCanvasElement;
    this.minimap.width = this.minimap.height = MINIMAP_SIZE;
    win.body.appendChild(this.minimap);
    this.root.appendChild(win.root);

    this.minimapBase = document.createElement('canvas');
    this.minimapBase.width = this.minimapBase.height = MINIMAP_SIZE;

    const toWorld = (e: MouseEvent) => {
      const r = this.minimap.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * this.game.world.size;
      const y = (e.clientY - r.top) / r.height * this.game.world.size;
      return { x, y };
    };
    let dragging = false;
    this.minimap.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        dragging = true;
        const { x, y } = toWorld(e);
        this.game.focusCamera(x, y);
      }
    });
    this.listen(window, 'pointermove', (e) => {
      if (dragging) {
        const { x, y } = toWorld(e as MouseEvent);
        this.game.focusCamera(x, y);
      }
    });
    this.listen(window, 'pointerup', () => { dragging = false; });
  }

  /** Terrain + resources baked once (nodes rarely change enough to matter). */
  private renderMinimapBase() {
    const ctx = this.minimapBase.getContext('2d')!;
    const s = this.game.world.size;
    const scale = MINIMAP_SIZE / s;
    const colors = ['#4d7c3a', '#5d8f46', '#8a6f47', '#3f6830'];
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = colors[this.game.world.map.terrain[y * s + x]];
        ctx.fillRect(x * scale, y * scale, scale + 0.5, scale + 0.5);
      }
    }
    for (const e of this.game.world.entities.values()) {
      if (e.kind !== 'resource') continue;
      ctx.fillStyle = e.type === 'tree' ? '#1e4718'
        : e.type === 'gold' ? '#e8c040'
          : e.type === 'stone' ? '#a8b0b0' : '#c04858';
      ctx.fillRect(e.tileX * scale, e.tileY * scale, Math.max(1.4, scale), Math.max(1.4, scale));
    }
  }

  private drawMinimap() {
    const ctx = this.minimap.getContext('2d')!;
    const s = this.game.world.size;
    const scale = MINIMAP_SIZE / s;
    ctx.drawImage(this.minimapBase, 0, 0);

    // fog
    const vis = this.game.world.visibility[this.game.you];
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = vis[y * s + x];
        if (v === 1) ctx.fillRect(x * scale, y * scale, scale + 0.5, scale + 0.5);
      }
    }
    ctx.fillStyle = '#000';
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        if (vis[y * s + x] === 0) ctx.fillRect(x * scale, y * scale, scale + 0.5, scale + 0.5);
      }
    }

    // entities
    for (const e of this.game.world.entities.values()) {
      if (e.owner < 0) continue;
      if (e.kind === 'unit') {
        if (e.owner !== this.game.you && !this.game.world.isVisibleTo(this.game.you, e)) continue;
        ctx.fillStyle = PLAYER_COLORS[this.game.world.players[e.owner].color].css;
        ctx.fillRect(toTiles(e.x) * scale - 1, toTiles(e.y) * scale - 1, 2.4, 2.4);
      } else if (e.kind === 'building') {
        if (!this.game.world.isExplored(this.game.you, e.x >> FP_BITS, e.y >> FP_BITS)) continue;
        ctx.fillStyle = PLAYER_COLORS[this.game.world.players[e.owner].color].css;
        const f = this.game.world.footprint(e);
        ctx.fillRect(f.x * scale, f.y * scale, Math.max(2.5, f.w * scale), Math.max(2.5, f.h * scale));
      }
    }

    // alert pings
    for (const ping of this.game.pings) {
      const r = (1 - (ping.t % 1)) * 8 + 2;
      ctx.strokeStyle = ping.t % 0.5 > 0.25 ? '#ff4040' : '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ping.x * scale, ping.y * scale, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // camera viewport
    const cam = this.game.renderer;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    const halfW = cam.zoom * 0.75;
    const halfH = cam.zoom * 0.55;
    ctx.strokeRect(
      (cam.focus.x - halfW) * scale, (cam.focus.z - halfH) * scale,
      halfW * 2 * scale, halfH * 2 * scale,
    );
  }

  // -------------------------------------------------------------------------
  // Selection panel + command card
  // -------------------------------------------------------------------------

  private buildPanel() {
    const win = makeWindow('Command', { closable: false, draggable: false, className: 'hud-window' });
    win.root.id = 'panel-window';
    this.selInfo = el('div', { class: 'sel-info' }) as HTMLDivElement;
    this.cmdGrid = el('div', { class: 'cmd-grid' }) as HTMLDivElement;
    win.body.append(this.selInfo, this.cmdGrid);
    this.root.appendChild(win.root);
  }

  /** Rebuild the panel + command card from the current selection. */
  refresh() {
    hideTooltip(); // hovered elements are about to be replaced
    this.hotkeyMap.clear();
    this.selInfo.textContent = '';
    this.cmdGrid.textContent = '';
    const sel = this.game.selectedEntities();

    if (sel.length === 0) {
      this.selInfo.appendChild(el('p', { text: 'Nothing selected.' }));
      this.selInfo.appendChild(el('p', { html: '<kbd>H</kbd> town center &nbsp; <kbd>.</kbd> idle villager' }));
      return;
    }

    if (sel.length === 1) {
      this.renderSingle(sel[0]);
    } else {
      this.renderMulti(sel);
    }

    const own = sel.filter((e) => e.owner === this.game.you);
    if (own.length === 0) return;
    const units = own.filter((e) => e.kind === 'unit');
    const villagers = units.filter((e) => e.type === 'villager');
    const military = units.filter((e) => e.type !== 'villager');

    if (villagers.length > 0) this.buildVillagerCommands();
    if (military.length > 0) this.buildMilitaryCommands();
    if (units.length > 0) this.addStopButton();
    if (own.length === 1 && own[0].kind === 'building') this.buildBuildingCommands(own[0]);
  }

  private entIcon(e: Entity): string {
    const key = `${e.kind}:${e.type}:${e.owner >= 0 ? this.game.world.players[e.owner].color : -1}:${e.kind === 'unit' ? e.id % 2 : 0}`;
    const cached = this.unitIconCache.get(key);
    if (cached) return cached;
    // resources get simple glyphs; models render async-ish (icon appears next refresh)
    if (e.kind === 'resource') {
      const g = e.type === 'tree' ? glyphIcon('🌲', '#2c5223', '#fff')
        : e.type === 'gold' ? glyphIcon('$', '#d0a020', '#5a4008')
          : e.type === 'stone' ? glyphIcon('#', '#a8b0b0', '#333')
            : glyphIcon('%', '#c04858', '#fff');
      this.unitIconCache.set(key, g);
      return g;
    }
    const color = this.game.world.players[e.owner]?.color ?? 0;
    const path = e.kind === 'unit' ? modelPathFor(e.type, color, e.id) : buildingModelPath(e.type, color);
    void loadModel(path).then((m) => {
      const url = renderModelIcon(key, () => {
        const o = instantiate(m, e.kind === 'unit');
        if (e.kind === 'unit') applyTeamColor(o, e.type, color);
        fitTo(o, 1, e.kind === 'unit');
        return o;
      });
      this.unitIconCache.set(key, url);
      // refresh portraits that were waiting on this icon
      this.refresh();
    }).catch(() => {});
    this.unitIconCache.set(key, glyphIcon('…'));
    return this.unitIconCache.get(key)!;
  }

  private renderSingle(e: Entity) {
    const name = e.kind === 'unit' ? UNITS[e.type as UnitTypeId]?.name
      : e.kind === 'building' ? BUILDINGS[e.type as BuildingTypeId]?.name
        : e.type === 'berries' ? 'Berry Bush' : e.type === 'gold' ? 'Gold Mine' : e.type === 'stone' ? 'Stone Mine' : 'Tree';
    const ownerName = e.owner >= 0 ? this.game.world.players[e.owner].name : 'Gaia';
    const ownerColor = e.owner >= 0 ? PLAYER_COLORS[this.game.world.players[e.owner].color].css : '#888';

    const rows = el('div', { class: 'portrait-row' });
    rows.appendChild(el('img', { class: 'portrait', src: this.entIcon(e) }));
    const info = el('div');
    info.appendChild(el('div', {}, el('b', { text: name ?? e.type })));
    const ownerLine = el('div', {});
    ownerLine.append(el('span', { style: `color:${ownerColor}`, text: '■ ' }), ownerName);
    info.appendChild(ownerLine);
    if (e.kind === 'unit') {
      const d = UNITS[e.type as UnitTypeId];
      info.appendChild(el('div', { text: `Attack ${d.attack}  Armor ${d.armor}` }));
      if (e.type === 'villager' && e.carry > 0) {
        info.appendChild(el('div', { text: `Carrying ${e.carry} ${e.carryKind}` }));
      }
    } else if (e.kind === 'resource') {
      info.appendChild(el('div', { text: `${e.amount} remaining` }));
    } else if (e.kind === 'building' && !this.game.world.isBuildingComplete(e)) {
      info.appendChild(el('div', { text: 'Under construction' }));
    }
    rows.appendChild(info);
    this.selInfo.appendChild(rows);

    if (e.kind !== 'resource') {
      const hpbar = el('div', { class: 'hpbar' }, el('div'));
      (hpbar.firstChild as HTMLElement).style.transform = `scaleX(${Math.max(0, e.hp / e.maxHp)})`;
      this.selInfo.appendChild(hpbar);
      this.selInfo.appendChild(el('div', { text: `${e.hp} / ${e.maxHp} HP` }));
    }

    // training queue for own buildings
    if (e.kind === 'building' && e.owner === this.game.you && e.trainQueue.length > 0) {
      const row = el('div', { class: 'queue-row' });
      e.trainQueue.forEach((item, i) => {
        const label = item.unit ? UNITS[item.unit].name : TECHS[item.tech!].name;
        const total = item.unit ? UNITS[item.unit].trainTime : TECHS[item.tech!].time;
        const img = el('img', {
          src: item.unit ? glyphIcon(label[0]) : glyphIcon('★', '#c8b060'),
          title: `${label} — click to cancel`,
        });
        bindTooltip(img, () => `${label} ${Math.round(item.progress / total * 100)}%\nClick to cancel (refund)`);
        img.addEventListener('click', () => this.game.issueCancelQueue(e.id, i));
        row.appendChild(img);
      });
      this.selInfo.appendChild(row);
      const head = e.trainQueue[0];
      const total = head.unit ? UNITS[head.unit].trainTime : TECHS[head.tech!].time;
      const pbar = el('div', { class: 'hpbar' }, el('div'));
      (pbar.firstChild as HTMLElement).style.transform = `scaleX(${head.progress / total})`;
      (pbar.firstChild as HTMLElement).style.background = '#000080';
      this.selInfo.appendChild(pbar);
    }
  }

  private renderMulti(sel: Entity[]) {
    this.selInfo.appendChild(el('div', { html: `<b>${sel.length} units selected</b>` }));
    const grid = el('div', { class: 'sel-multi' });
    for (const e of sel.slice(0, 24)) {
      const img = el('img', { src: this.entIcon(e) });
      bindTooltip(img, () => `${UNITS[e.type as UnitTypeId]?.name ?? e.type} — ${e.hp}/${e.maxHp} HP\nClick to select only this unit`);
      img.addEventListener('click', () => this.game.select([e.id]));
      grid.appendChild(img);
    }
    this.selInfo.appendChild(grid);
  }

  // --- command card builders ---------------------------------------------------

  private cmdButton(opts: {
    icon: string; hotkey?: string; tooltip: () => string;
    disabled?: boolean; onClick: () => void; count?: number; progress?: number;
  }) {
    const btn = el('button', { class: 'cmd-btn' }) as HTMLButtonElement;
    btn.appendChild(el('img', { src: opts.icon }));
    if (opts.hotkey) btn.appendChild(el('span', { class: 'hotkey', text: opts.hotkey.toUpperCase() }));
    if (opts.count !== undefined && opts.count > 0) btn.appendChild(el('span', { class: 'count', text: String(opts.count) }));
    if (opts.disabled) btn.disabled = true;
    if (opts.progress !== undefined) {
      btn.classList.add('progress');
      btn.style.setProperty('--pct', `${Math.round(opts.progress * 100)}%`);
    }
    bindTooltip(btn, opts.tooltip);
    btn.addEventListener('click', () => { if (!btn.disabled) opts.onClick(); });
    if (opts.hotkey && !opts.disabled) this.hotkeyMap.set(opts.hotkey, opts.onClick);
    this.cmdGrid.appendChild(btn);
    return btn;
  }

  private buildingIconFor(type: BuildingTypeId): string {
    const color = this.game.world.players[this.game.you].color;
    const key = `cmd:${type}:${color}`;
    const cached = this.unitIconCache.get(key);
    if (cached) return cached;
    void loadModel(buildingModelPath(type, color)).then((m) => {
      const url = renderModelIcon(key, () => {
        const o = instantiate(m, false);
        fitTo(o, 1, false);
        return o;
      });
      this.unitIconCache.set(key, url);
      this.refresh();
    }).catch(() => {});
    this.unitIconCache.set(key, glyphIcon(type[0].toUpperCase()));
    return this.unitIconCache.get(key)!;
  }

  private unitIconFor(type: UnitTypeId): string {
    const color = this.game.world.players[this.game.you].color;
    const key = `cmdu:${type}:${color}`;
    const cached = this.unitIconCache.get(key);
    if (cached) return cached;
    void loadModel(modelPathFor(type, color, 0)).then((m) => {
      const url = renderModelIcon(key, () => {
        const o = instantiate(m, UNITS[type].building !== 'workshop');
        applyTeamColor(o, type, color);
        fitTo(o, 1, true);
        return o;
      });
      this.unitIconCache.set(key, url);
      this.refresh();
    }).catch(() => {});
    this.unitIconCache.set(key, glyphIcon(type[0].toUpperCase()));
    return this.unitIconCache.get(key)!;
  }

  private buildVillagerCommands() {
    const world = this.game.world;
    const p = world.players[this.game.you];
    const buildables = (Object.keys(BUILDINGS) as BuildingTypeId[]).filter((b) => BUILDINGS[b].age <= p.age);
    for (const b of buildables) {
      const d = BUILDINGS[b];
      this.cmdButton({
        icon: this.buildingIconFor(b),
        hotkey: d.hotkey,
        disabled: !world.canAfford(this.game.you, d.cost),
        tooltip: () => `Build ${d.name} — ${costText(d.cost)}\n${d.popCap ? `+${d.popCap} population. ` : ''}${d.dropOff ? `Drop-off: ${d.dropOff.join(', ')}. ` : ''}${d.attack ? 'Shoots arrows at enemies. ' : ''}`,
        onClick: () => this.game.enterPlacement(b),
      });
    }
  }

  private buildMilitaryCommands() {
    this.cmdButton({
      icon: glyphIcon('⚔', '#a03030', '#fff'),
      hotkey: 'a',
      tooltip: () => 'Attack-move: engage everything on the way (A, then click)',
      onClick: () => { this.game.attackMoveMode = true; },
    });
  }

  private addStopButton() {
    this.cmdButton({
      icon: glyphIcon('✋', '#d4d0c8', '#802020'),
      hotkey: 's',
      tooltip: () => 'Stop (S)',
      onClick: () => this.game.issueStop(),
    });
  }

  private buildBuildingCommands(b: Entity) {
    const world = this.game.world;
    const p = world.players[this.game.you];
    if (!world.isBuildingComplete(b)) return;

    // trainable units
    for (const [id, d] of Object.entries(UNITS) as [UnitTypeId, typeof UNITS[UnitTypeId]][]) {
      if (d.building !== b.type) continue;
      const locked = p.age < d.age;
      this.cmdButton({
        icon: this.unitIconFor(id),
        hotkey: d.hotkey,
        disabled: locked || !world.canAfford(this.game.you, d.cost) || b.trainQueue.length >= 5,
        count: b.trainQueue.filter((q) => q.unit === id).length,
        tooltip: () => locked
          ? `${d.name} — requires ${AGE_NAMES[d.age]}`
          : `Train ${d.name} — ${costText(d.cost)}\nHP ${d.hp}, attack ${d.attack}${d.attackKind !== 'melee' ? ` (range ${(d.attackRange / 256).toFixed(1)})` : ''}`,
        onClick: () => this.game.issueTrain(b.id, id),
      });
    }

    // researches
    for (const [id, d] of Object.entries(TECHS) as [TechId, typeof TECHS[TechId]][]) {
      if (d.building !== b.type) continue;
      if (world.hasTech(this.game.you, id)) continue;
      if (id === 'age2' && p.age >= 1) continue;
      if (id === 'age3' && p.age >= 2) continue;
      const locked = p.age < d.age || (d.requires !== undefined && !world.hasTech(this.game.you, d.requires));
      const pending = world.techPending(this.game.you, id);
      const icon = id === 'age2' ? glyphIcon('II', '#c8b060', '#403010')
        : id === 'age3' ? glyphIcon('III', '#c8b060', '#403010')
          : glyphIcon(d.name[0], '#9098c0', '#202850');
      this.cmdButton({
        icon,
        hotkey: d.hotkey,
        disabled: locked || pending || !world.canAfford(this.game.you, d.cost) || b.trainQueue.length >= 5,
        tooltip: () => `${d.name} — ${costText(d.cost)}\n${d.desc}${locked && d.requires ? `\nRequires ${TECHS[d.requires].name}` : ''}`,
        onClick: () => this.game.issueResearch(b.id, id),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  private buildChat() {
    this.chatLog = el('div', { id: 'chat-log' }) as HTMLDivElement;
    this.chatInputRow = el('div', { id: 'chat-input-row', class: 'field-row' }) as HTMLDivElement;
    this.chatInput = el('input', { type: 'text', maxlength: '160' }) as HTMLInputElement;
    this.chatInputRow.appendChild(this.chatInput);
    this.root.append(this.chatLog, this.chatInputRow);

    this.listen(window, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key !== 'Enter' || !this.onSendChat) return;
      const active = document.activeElement === this.chatInput;
      if (active) {
        const text = this.chatInput.value.trim();
        if (text) this.onSendChat(text);
        this.chatInput.value = '';
        this.chatInputRow.style.display = 'none';
        this.chatInput.blur();
      } else if ((e.target as HTMLElement).tagName !== 'INPUT') {
        this.chatInputRow.style.display = 'block';
        this.chatInput.focus();
      }
    });
  }

  addChat(from: string, text: string) {
    const line = el('div', { text: `${from}: ${text}` });
    this.chatLog.appendChild(line);
    while (this.chatLog.children.length > 8) this.chatLog.firstChild!.remove();
    setTimeout(() => line.remove(), 12000);
  }

  // -------------------------------------------------------------------------
  // Menus & endgame
  // -------------------------------------------------------------------------

  private openMenu() {
    if (document.querySelector('.modal-backdrop')) return; // one modal at a time
    audio.play('uiOpen');
    modal('Game Menu', (body, done) => {
      const resume = el('button', { text: 'Resume Game' });
      resume.addEventListener('click', done);

      const volRow = el('div', { class: 'field-row' });
      volRow.appendChild(el('label', { text: 'Sound volume' }));
      const vol = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(audio.volume * 100)) });
      vol.addEventListener('input', () => audio.setVolume(Number((vol as HTMLInputElement).value) / 100));
      volRow.appendChild(vol);

      // game speed — single-player only (the server owns multiplayer pacing)
      const transport = this.game.transport as { speed?: number };
      let speedRow: HTMLElement | null = null;
      if (typeof transport.speed === 'number') {
        speedRow = el('div', { class: 'field-row' });
        speedRow.appendChild(el('label', { text: 'Game speed' }));
        const sel = el('select') as HTMLSelectElement;
        for (const s of [1, 1.5, 2, 4]) sel.appendChild(el('option', { value: String(s), text: `${s}×` }));
        sel.value = String(transport.speed);
        sel.addEventListener('change', () => { transport.speed = Number(sel.value); });
        speedRow.appendChild(sel);
      }

      const resign = el('button', { text: 'Resign' });
      resign.addEventListener('click', () => {
        done();
        confirmDialog('Resign', 'Give up this game?', 'Resign', () => this.game.resign());
      });
      const quit = el('button', { text: 'Quit to Menu' });
      quit.addEventListener('click', () => {
        done();
        confirmDialog('Quit', 'Leave the game and return to the main menu?', 'Quit', () => this.onQuit());
      });
      body.style.display = 'flex';
      (body.style as CSSStyleDeclaration).flexDirection = 'column';
      body.style.gap = '8px';
      body.append(resume, volRow);
      if (speedRow) body.append(speedRow);
      body.append(resign, quit);
    });
  }

  showGameOver(winner: number) {
    const world = this.game.world;
    const youWon = winner === this.game.you;
    modal(youWon ? 'Victory!' : 'Defeat', (body) => {
      // player names are remote input — never innerHTML them
      const headline = el('p', {});
      headline.append(
        el('b', { text: winner >= 0 ? world.players[winner].name : '' }),
        winner >= 0
          ? (youWon ? ' — you are victorious!' : ' has conquered the known world.')
          : 'The game has ended.',
      );
      body.appendChild(headline);
      const table = el('table', { class: 'stats-table' });
      table.appendChild(el('tr', {},
        el('th', { text: 'Player' }), el('th', { text: 'Age' }), el('th', { text: 'Gathered' }),
        el('th', { text: 'Trained' }), el('th', { text: 'Kills' }), el('th', { text: 'Losses' }), el('th', { text: 'Razed' }),
      ));
      for (const p of world.players) {
        const gathered = Object.values(p.stats.gathered).reduce((a, b) => a + b, 0);
        const nameCell = el('td', {});
        nameCell.append(
          el('span', { style: `color:${PLAYER_COLORS[p.color].css}`, text: '■ ' }),
          `${p.name}${p.id === winner ? ' 👑' : ''}`,
        );
        table.appendChild(el('tr', {},
          nameCell,
          el('td', { text: AGE_NAMES[p.age] }),
          el('td', { text: String(gathered) }),
          el('td', { text: String(p.stats.unitsTrained) }),
          el('td', { text: String(p.stats.unitsKilled) }),
          el('td', { text: String(p.stats.unitsLost) }),
          el('td', { text: String(p.stats.buildingsRazed) }),
        ));
      }
      body.appendChild(table);
      const row = el('div', { class: 'dialog-buttons' });
      const keep = el('button', { text: 'Keep Watching' });
      keep.addEventListener('click', () => (document.querySelector('.modal-backdrop') as HTMLElement)?.remove());
      const quit = el('button', { text: 'Back to Menu' });
      quit.addEventListener('click', () => this.onQuit());
      row.append(keep, quit);
      body.appendChild(row);
    }, { width: 480, closable: false });
  }

  showDesync() {
    toast('Simulation desync detected — this game is out of sync.', true);
  }

  // -------------------------------------------------------------------------

  onHotkey(key: string): boolean {
    const fn = this.hotkeyMap.get(key);
    if (fn) { fn(); return true; }
    return false;
  }

  onEscape(): boolean {
    const backdrop = document.querySelector('.modal-backdrop');
    if (backdrop) { backdrop.remove(); return true; }
    return false;
  }

  /** Called every frame by main; throttles its own redraw work. */
  update(dt: number) {
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 0) {
      this.minimapTimer = 0.25;
      this.drawMinimap();
    }
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) {
      this.refreshTimer = 0.5;
      this.refreshResources();
      // keep costs/queue display fresh
      this.refresh();
    }
  }
}
