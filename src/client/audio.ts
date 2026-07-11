// WebAudio manager: pooled one-shot SFX with pitch jitter, screen-space
// panning, distance attenuation relative to the camera focus, and per-key
// rate limiting so forty villagers chopping doesn't become white noise.

import { SFX } from './visuals';

export interface SoundSpec {
  files: string[];
  volume: number;
  jitter: number;       // ± pitch variation
  minInterval: number;  // ms between plays of this key
  maxDist?: number;     // world-units cutoff for positional sounds
}

const LIBRARY: Record<string, SoundSpec> = {
  chop: { files: ['chop_1.ogg', 'chop_2.ogg'], volume: 0.5, jitter: 0.12, minInterval: 90, maxDist: 22 },
  treeFall: { files: ['tree_fall.ogg'], volume: 0.6, jitter: 0.08, minInterval: 300, maxDist: 26 },
  mine: { files: ['mine_1.ogg', 'mine_2.ogg', 'mine_3.ogg'], volume: 0.5, jitter: 0.12, minInterval: 90, maxDist: 22 },
  rockBreak: { files: ['rock_break.ogg'], volume: 0.6, jitter: 0.08, minInterval: 300, maxDist: 26 },
  build: { files: ['chop_1.ogg', 'chop_2.ogg'], volume: 0.42, jitter: 0.2, minInterval: 120, maxDist: 22 },
  buildDone: { files: ['build_done.ogg'], volume: 0.6, jitter: 0.04, minInterval: 200, maxDist: 40 },
  swingLight: { files: ['swing_light_1.ogg', 'swing_light_2.ogg'], volume: 0.38, jitter: 0.15, minInterval: 70, maxDist: 24 },
  swingHeavy: { files: ['swing_heavy_1.ogg', 'swing_heavy_2.ogg'], volume: 0.45, jitter: 0.12, minInterval: 90, maxDist: 24 },
  hitBody: { files: ['hit_body_1.ogg', 'hit_body_2.ogg', 'hit_body_3.ogg'], volume: 0.5, jitter: 0.14, minInterval: 70, maxDist: 24 },
  hitSlash: { files: ['hit_slash_1.ogg'], volume: 0.5, jitter: 0.14, minInterval: 90, maxDist: 24 },
  hitCrit: { files: ['hit_crit.ogg'], volume: 0.55, jitter: 0.1, minInterval: 200, maxDist: 24 },
  hitMetal: { files: ['hit_metal.ogg', 'sword_clash.ogg'], volume: 0.45, jitter: 0.12, minInterval: 110, maxDist: 24 },
  death: { files: ['death_1.ogg', 'death_2.ogg'], volume: 0.55, jitter: 0.1, minInterval: 120, maxDist: 30 },
  arrow: { files: ['arrow_shoot_1.ogg'], volume: 0.35, jitter: 0.18, minInterval: 60, maxDist: 26 },
  catapult: { files: ['catapult_shoot.ogg'], volume: 0.6, jitter: 0.08, minInterval: 250, maxDist: 40 },
  explosion: { files: ['explosion_1.ogg', 'explosion_2.ogg'], volume: 0.65, jitter: 0.1, minInterval: 150, maxDist: 46 },
  collapse: { files: ['explosion_big.ogg'], volume: 0.7, jitter: 0.06, minInterval: 400, maxDist: 60 },
  trainDone: { files: ['train_done.ogg'], volume: 0.5, jitter: 0.05, minInterval: 250 },
  ageUp: { files: ['age_up.ogg'], volume: 0.75, jitter: 0, minInterval: 500 },
  research: { files: ['upgrade.ogg'], volume: 0.6, jitter: 0.02, minInterval: 300 },
  alert: { files: ['alert.ogg'], volume: 0.7, jitter: 0, minInterval: 1500 },
  uiOpen: { files: ['ui_open.ogg'], volume: 0.5, jitter: 0, minInterval: 60 },
  uiClose: { files: ['ui_close.ogg'], volume: 0.5, jitter: 0, minInterval: 60 },
  click: { files: ['ui_click.ogg'], volume: 0.4, jitter: 0.06, minInterval: 40 },
  victory: { files: ['age_up.ogg'], volume: 0.8, jitter: 0, minInterval: 1000 },
  defeat: { files: ['explosion_big.ogg'], volume: 0.6, jitter: 0, minInterval: 1000 },
  footstep: { files: ['footstep_grass_1.ogg', 'footstep_grass_2.ogg', 'footstep_grass_3.ogg', 'footstep_grass_4.ogg'], volume: 0.16, jitter: 0.2, minInterval: 100, maxDist: 14 },
};

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private lastPlay = new Map<string, number>();
  /** Camera focus point in world units, fed by the game each frame. */
  listener = { x: 0, y: 0, zoom: 18 };
  volume = 0.8;
  muted = false;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    void this.preload();
  }

  private async preload() {
    const wanted = new Set<string>();
    for (const spec of Object.values(LIBRARY)) spec.files.forEach((f) => wanted.add(f));
    await Promise.all([...wanted].map(async (f) => {
      try {
        const res = await fetch(`${SFX}/${f}`);
        const buf = await res.arrayBuffer();
        const audio = await this.ctx!.decodeAudioData(buf);
        this.buffers.set(f, audio);
      } catch {
        // missing sound: play nothing rather than crash
      }
    }));
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** Play a sound, optionally positioned in world space (tiles). */
  play(key: string, wx?: number, wy?: number) {
    if (!this.ctx || !this.master || this.muted) return;
    const spec = LIBRARY[key];
    if (!spec) return;
    const now = performance.now();
    if (now - (this.lastPlay.get(key) ?? -9999) < spec.minInterval) return;

    let gain = spec.volume;
    let pan = 0;
    if (wx !== undefined && wy !== undefined && spec.maxDist) {
      const dx = wx - this.listener.x;
      const dy = wy - this.listener.y;
      const dist = Math.hypot(dx, dy);
      const range = spec.maxDist + this.listener.zoom * 0.6;
      if (dist > range) return;
      gain *= Math.max(0.12, 1 - (dist / range) * 0.9);
      pan = Math.max(-0.8, Math.min(0.8, dx / (this.listener.zoom * 1.2)));
    }
    const file = spec.files[(Math.random() * spec.files.length) | 0];
    const buffer = this.buffers.get(file);
    if (!buffer) return;
    this.lastPlay.set(key, now);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * spec.jitter;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.master);
    src.start();
  }
}

export const audio = new AudioManager();
