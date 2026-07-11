// Mouse + keyboard controller: selection (click, shift-click, double-click,
// marquee), context orders, attack-move, building placement, camera pan
// (edges, WASD/arrows, middle-drag), zoom, control groups, and hotkeys.

import type { GameClient } from './game';
import { audio } from './audio';

const EDGE = 24; // px edge-pan band

export interface HotkeyHandler {
  /** Return true if the key was consumed by the command card. */
  onHotkey(key: string): boolean;
  onEscape(): boolean;
}

export class InputController {
  private game: GameClient;
  private hotkeys: HotkeyHandler;
  private marqueeEl: HTMLDivElement;
  private downAt: { x: number; y: number; button: number } | null = null;
  private marqueeActive = false;
  private lastClickAt = 0;
  private lastClickEnt = 0;
  private mouse = { x: 0, y: 0, inside: false };
  private keys = new Set<string>();
  private midPanning = false;
  private disposers: (() => void)[] = [];

  constructor(game: GameClient, hotkeys: HotkeyHandler) {
    this.game = game;
    this.hotkeys = hotkeys;

    this.marqueeEl = document.createElement('div');
    this.marqueeEl.id = 'marquee';
    document.getElementById('app')!.appendChild(this.marqueeEl);

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(window, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(window, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
    this.listen(document, 'mouseleave', () => { this.mouse.inside = false; });
    this.listen(window, 'blur', () => this.keys.clear());
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn));
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.marqueeEl.remove();
  }

  private onPointerDown(e: PointerEvent) {
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.downAt = { x: e.clientX, y: e.clientY, button: e.button };

    if (e.button === 1) {
      this.midPanning = true;
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      if (this.game.placing) {
        this.game.confirmPlacement(e.shiftKey);
        this.downAt = null;
        return;
      }
      if (this.game.attackMoveMode) {
        this.game.attackMoveTo(e.clientX, e.clientY);
        this.downAt = null;
        return;
      }
    }
    if (e.button === 2) {
      if (this.game.placing || this.game.attackMoveMode) {
        this.game.cancelPlacement();
        this.game.attackMoveMode = false;
        this.downAt = null;
        return;
      }
      this.game.contextCommand(e.clientX, e.clientY, e.shiftKey);
      this.downAt = null;
    }
  }

  private onPointerMove(e: PointerEvent) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inside = true;

    if (this.midPanning) {
      this.game.renderer.focus.x -= e.movementX * this.game.renderer.zoom * 0.0016;
      this.game.renderer.focus.z -= e.movementY * this.game.renderer.zoom * 0.0016 / Math.sin(this.game.renderer.pitch);
      return;
    }
    if (this.game.placing) {
      this.game.updatePlacementCursor(e.clientX, e.clientY);
      return;
    }
    if (this.downAt && this.downAt.button === 0) {
      const dx = e.clientX - this.downAt.x;
      const dy = e.clientY - this.downAt.y;
      if (!this.marqueeActive && Math.hypot(dx, dy) > 5) {
        this.marqueeActive = true;
        this.marqueeEl.style.display = 'block';
      }
      if (this.marqueeActive) {
        const x = Math.min(e.clientX, this.downAt.x);
        const y = Math.min(e.clientY, this.downAt.y);
        this.marqueeEl.style.left = `${x}px`;
        this.marqueeEl.style.top = `${y}px`;
        this.marqueeEl.style.width = `${Math.abs(dx)}px`;
        this.marqueeEl.style.height = `${Math.abs(dy)}px`;
      }
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (e.button === 1) {
      this.midPanning = false;
      return;
    }
    if (!this.downAt || e.button !== 0) return;
    const down = this.downAt;
    this.downAt = null;

    if (this.marqueeActive) {
      this.marqueeActive = false;
      this.marqueeEl.style.display = 'none';
      this.game.marqueeSelect(down.x, down.y, e.clientX, e.clientY, e.shiftKey);
      return;
    }

    // plain click select
    const ent = this.game.pickEntity(e.clientX, e.clientY);
    const now = performance.now();
    if (ent) {
      if (now - this.lastClickAt < 350 && this.lastClickEnt === ent.id) {
        this.game.selectSameTypeOnScreen(ent);
      } else {
        this.game.select([ent.id], e.shiftKey);
      }
      this.lastClickAt = now;
      this.lastClickEnt = ent.id;
      audio.play('click');
    } else if (!e.shiftKey) {
      this.game.select([]);
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.game.renderer;
    r.targetZoom = Math.max(9, Math.min(30, r.targetZoom + Math.sign(e.deltaY) * 2.2));
  }

  private onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = e.key.toLowerCase();
    this.keys.add(key);

    if (key === 'escape') {
      if (this.game.placing || this.game.attackMoveMode) {
        this.game.cancelPlacement();
        this.game.attackMoveMode = false;
        return;
      }
      if (this.hotkeys.onEscape()) return;
      this.game.select([]);
      return;
    }

    // control groups
    if (/^[0-9]$/.test(key)) {
      const n = Number(key);
      if (e.ctrlKey) {
        this.game.setGroup(n);
        e.preventDefault();
      } else {
        const again = performance.now() - this.lastGroupAt < 400 && this.lastGroup === n;
        this.game.recallGroup(n, again);
        this.lastGroup = n;
        this.lastGroupAt = performance.now();
      }
      return;
    }

    switch (key) {
      case 'h':
        this.game.focusTownCenter();
        return;
      case '.':
        this.game.selectNextIdleVillager();
        return;
      case 'delete':
        this.game.issueDelete();
        return;
      case 's':
        // stop takes priority if units are selected
        if (this.game.selectedOwnUnits().length > 0) {
          this.game.issueStop();
          return;
        }
        break;
      case 'a':
        if (this.game.selectedOwnUnits().some((u) => u.type !== 'villager')) {
          this.game.attackMoveMode = true;
          return;
        }
        break;
    }

    if (this.hotkeys.onHotkey(key)) {
      e.preventDefault();
    }
  }

  private lastGroup = -1;
  private lastGroupAt = 0;

  /** Per-frame: aggregate pan input from keys + screen edges. */
  update() {
    // cursor reflects the pending click mode
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.cursor = this.game.attackMoveMode ? 'crosshair' : this.game.placing ? 'copy' : 'default';

    let px = 0, py = 0;
    if (this.keys.has('arrowleft')) px -= 1;
    if (this.keys.has('arrowright')) px += 1;
    if (this.keys.has('arrowup')) py -= 1;
    if (this.keys.has('arrowdown')) py += 1;
    if (this.keys.has('w')) py -= 1;
    // 'a'/'s'/'d' conflict with hotkeys — arrows are primary; WASD panning
    // only when nothing is selected
    if (this.game.selection.size === 0) {
      if (this.keys.has('a')) px -= 1;
      if (this.keys.has('s')) py += 1;
      if (this.keys.has('d')) px += 1;
    }
    if (this.mouse.inside && !this.midPanning && document.hasFocus()) {
      if (this.mouse.x < EDGE) px -= 1;
      else if (this.mouse.x > window.innerWidth - EDGE) px += 1;
      if (this.mouse.y < EDGE) py -= 1;
      else if (this.mouse.y > window.innerHeight - EDGE) py += 1;
    }
    const len = Math.hypot(px, py);
    this.game.panInput.x = len > 0 ? px / len : 0;
    this.game.panInput.y = len > 0 ? py / len : 0;
  }
}
