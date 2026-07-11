// Small Win98 UI toolkit on top of 98.css: windows (draggable), modal
// dialogs, tooltips, toasts. Everything is plain DOM — no framework.

import { audio } from '../audio';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

export interface Win98Window {
  root: HTMLDivElement;
  body: HTMLDivElement;
  close(): void;
}

export function makeWindow(title: string, opts: {
  width?: number;
  closable?: boolean;
  onClose?: () => void;
  draggable?: boolean;
  className?: string;
} = {}): Win98Window {
  const root = el('div', { class: `window ${opts.className ?? ''}` }) as HTMLDivElement;
  if (opts.width) root.style.width = `${opts.width}px`;

  const titleBar = el('div', { class: 'title-bar' },
    el('div', { class: 'title-bar-text', text: title }),
  );
  const controls = el('div', { class: 'title-bar-controls' });
  if (opts.closable !== false) {
    const btn = el('button', { 'aria-label': 'Close' });
    btn.addEventListener('click', () => {
      audio.play('uiClose');
      opts.onClose?.();
      root.remove();
    });
    controls.appendChild(btn);
  }
  titleBar.appendChild(controls);
  const body = el('div', { class: 'window-body' }) as HTMLDivElement;
  root.append(titleBar, body);

  if (opts.draggable !== false) {
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    titleBar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const r = root.getBoundingClientRect();
      // switch to absolute positioning on first drag
      root.style.position = 'absolute';
      root.style.left = `${r.left}px`;
      root.style.top = `${r.top}px`;
      root.style.margin = '0';
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      titleBar.setPointerCapture(e.pointerId);
    });
    titleBar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, drag.left + e.clientX - drag.x))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, drag.top + e.clientY - drag.y))}px`;
    });
    titleBar.addEventListener('pointerup', () => { drag = null; });
  }

  return { root, body, close: () => root.remove() };
}

export function modal(title: string, content: (body: HTMLElement, close: () => void) => void, opts: {
  width?: number; closable?: boolean;
} = {}): () => void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const win = makeWindow(title, {
    width: opts.width ?? 380,
    closable: opts.closable,
    onClose: () => backdrop.remove(),
    draggable: true,
  });
  const close = () => backdrop.remove();
  content(win.body, close);
  backdrop.appendChild(win.root);
  document.getElementById('ui-root')!.appendChild(backdrop);
  audio.play('uiOpen');
  return close;
}

export function confirmDialog(title: string, message: string, okLabel: string, onOk: () => void) {
  modal(title, (body, close) => {
    body.appendChild(el('p', { text: message }));
    const row = el('div', { class: 'dialog-buttons' });
    const ok = el('button', { text: okLabel });
    ok.addEventListener('click', () => { close(); onOk(); });
    const cancel = el('button', { text: 'Cancel' });
    cancel.addEventListener('click', close);
    row.append(ok, cancel);
    body.appendChild(row);
  });
}

// --- tooltip ---------------------------------------------------------------

let tooltipEl: HTMLDivElement | null = null;

export function bindTooltip(target: HTMLElement, text: () => string) {
  if (!tooltipEl) {
    tooltipEl = el('div', { id: 'tooltip' }) as HTMLDivElement;
    document.body.appendChild(tooltipEl);
  }
  const show = (e: MouseEvent) => {
    const t = text();
    if (!t) return;
    tooltipEl!.textContent = t;
    tooltipEl!.style.display = 'block';
    position(e);
  };
  const position = (e: MouseEvent) => {
    const pad = 14;
    const r = tooltipEl!.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY - r.height - 8;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y < 0) y = e.clientY + pad;
    tooltipEl!.style.left = `${x}px`;
    tooltipEl!.style.top = `${y}px`;
  };
  target.addEventListener('mouseenter', show);
  target.addEventListener('mousemove', position);
  target.addEventListener('mouseleave', () => { tooltipEl!.style.display = 'none'; });
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

// --- toasts ------------------------------------------------------------------

let alertsBox: HTMLDivElement | null = null;

export function toast(text: string, warn = false) {
  if (!alertsBox || !alertsBox.isConnected) {
    alertsBox = el('div', { id: 'alerts' }) as HTMLDivElement;
    document.getElementById('ui-root')!.appendChild(alertsBox);
  }
  const t = el('div', { class: `alert-toast ${warn ? 'warn' : ''}`, text });
  alertsBox.appendChild(t);
  while (alertsBox.children.length > 4) alertsBox.firstChild!.remove();
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.4s';
    setTimeout(() => t.remove(), 450);
  }, 3600);
}

export function costText(cost: Record<string, number | undefined>): string {
  return Object.entries(cost)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}
