// CPU-simulated particle system rendered as two THREE.Points layers (alpha
// and additive blending) sharing a 2×2 procedural atlas, plus the selection
// ring instances. Chunky quads, stepped fades — PS1 fireworks.

import * as THREE from 'three';
import { particleTextures } from '../assets';

const MAX = 2048;

const FRAME_DISC = 0;
const FRAME_SPARK = 1;
const FRAME_SMOKE = 2;
const FRAME_SQUARE = 3;

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aFrame;
varying vec4 vColor;
varying float vFrame;
void main() {
  vColor = aColor;
  vFrame = aFrame;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (240.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D tAtlas;
varying vec4 vColor;
varying float vFrame;
void main() {
  vec2 base = vec2(mod(vFrame, 2.0), floor(vFrame / 2.0)) * 0.5;
  vec4 tex = texture2D(tAtlas, base + gl_PointCoord * 0.5);
  vec4 c = tex * vColor;
  if (c.a < 0.02) discard;
  gl_FragColor = c;
}
`;

interface Particle {
  alive: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size0: number; size1: number;
  r: number; g: number; b: number; a: number;
  gravity: number; drag: number;
  frame: number;
  additive: boolean;
}

export interface EmitOpts {
  x: number; y: number; z: number;
  count: number;
  spread?: number;          // initial position jitter
  vel?: [number, number, number];
  velVar?: number;
  gravity?: number;
  drag?: number;
  life: number;             // seconds
  lifeVar?: number;
  size: number;
  sizeEnd?: number;
  color: number | number[];
  alpha?: number;
  frame?: number;
  additive?: boolean;
}

function buildAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d')!;
  const put = (tex: THREE.CanvasTexture, x: number, y: number) => {
    ctx.drawImage(tex.image as HTMLCanvasElement, x, y);
  };
  put(particleTextures.disc(), 0, 0);
  put(particleTextures.spark(), 24 + 4, 4);
  put(particleTextures.smoke(), 0, 24);
  ctx.fillStyle = '#fff';
  ctx.fillRect(24 + 8, 24 + 8, 8, 8); // square chip
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

class Layer {
  points: THREE.Points;
  geo = new THREE.BufferGeometry();
  pos: Float32Array;
  size: Float32Array;
  color: Float32Array;
  frame: Float32Array;

  constructor(atlas: THREE.Texture, additive: boolean) {
    this.pos = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.color = new Float32Array(MAX * 4);
    this.frame = new Float32Array(MAX);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aFrame', new THREE.BufferAttribute(this.frame, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { tAtlas: { value: atlas } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 32 : 31;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private pool: Particle[] = [];
  private alphaLayer: Layer;
  private addLayer: Layer;

  constructor() {
    const atlas = buildAtlas();
    this.alphaLayer = new Layer(atlas, false);
    this.addLayer = new Layer(atlas, true);
    this.group.add(this.alphaLayer.points, this.addLayer.points);
    for (let i = 0; i < MAX; i++) {
      this.pool.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size0: 1, size1: 1, r: 1, g: 1, b: 1, a: 1,
        gravity: 0, drag: 0, frame: 0, additive: false,
      });
    }
  }

  emit(o: EmitOpts) {
    const colors = Array.isArray(o.color) ? o.color : [o.color];
    let spawned = 0;
    for (const p of this.pool) {
      if (p.alive) continue;
      p.alive = true;
      const spread = o.spread ?? 0.1;
      p.x = o.x + (Math.random() - 0.5) * spread * 2;
      p.y = o.z + Math.random() * 0.1;
      p.z = o.y + (Math.random() - 0.5) * spread * 2;
      const [vx, vy, vz] = o.vel ?? [0, 1.2, 0];
      const vv = o.velVar ?? 0.7;
      p.vx = vx + (Math.random() - 0.5) * 2 * vv;
      p.vy = vy + (Math.random() - 0.5) * 2 * vv * 0.6 + Math.random() * vv * 0.4;
      p.vz = vz + (Math.random() - 0.5) * 2 * vv;
      p.maxLife = p.life = o.life * (1 + (Math.random() - 0.5) * 2 * (o.lifeVar ?? 0.25));
      p.size0 = o.size;
      p.size1 = o.sizeEnd ?? o.size * 0.5;
      const c = new THREE.Color(colors[(Math.random() * colors.length) | 0]);
      p.r = c.r; p.g = c.g; p.b = c.b;
      p.a = o.alpha ?? 1;
      p.gravity = o.gravity ?? 2.2;
      p.drag = o.drag ?? 0.5;
      p.frame = o.frame ?? FRAME_DISC;
      p.additive = o.additive ?? false;
      if (++spawned >= o.count) break;
    }
  }

  update(dt: number) {
    let ai = 0, di = 0;
    const A = this.addLayer, D = this.alphaLayer;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0 || p.y < -0.2) { p.alive = false; continue; }
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag; p.vz *= drag;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02 && p.vy < 0) { p.y = 0.02; p.vy *= -0.25; p.vx *= 0.6; p.vz *= 0.6; }

      const t = 1 - p.life / p.maxLife;
      // stepped alpha (quantized like the rest of the look)
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      const alpha = Math.round(Math.max(0, Math.min(1, fade)) * 4) / 4 * p.a;
      const size = p.size0 + (p.size1 - p.size0) * t;
      const L = p.additive ? A : D;
      const i = p.additive ? ai++ : di++;
      if (i >= MAX) continue;
      L.pos[i * 3] = p.x; L.pos[i * 3 + 1] = p.y; L.pos[i * 3 + 2] = p.z;
      L.size[i] = size;
      L.color[i * 4] = p.r; L.color[i * 4 + 1] = p.g; L.color[i * 4 + 2] = p.b; L.color[i * 4 + 3] = alpha;
      L.frame[i] = p.frame;
    }
    for (const [L, n] of [[A, ai], [D, di]] as [Layer, number][]) {
      L.geo.setDrawRange(0, n);
      L.geo.attributes.position.needsUpdate = true;
      (L.geo.attributes as Record<string, THREE.BufferAttribute>).aSize.needsUpdate = true;
      (L.geo.attributes as Record<string, THREE.BufferAttribute>).aColor.needsUpdate = true;
      (L.geo.attributes as Record<string, THREE.BufferAttribute>).aFrame.needsUpdate = true;
    }
  }

  // --- game-flavored spawners ------------------------------------------------

  hitSpark(x: number, y: number) {
    this.emit({ x, y, z: 0.55, count: 6, life: 0.3, size: 1.6, color: [0xffe090, 0xffffff], additive: true, frame: FRAME_SPARK, velVar: 1.6, gravity: 4 });
  }

  bluntHit(x: number, y: number) {
    this.emit({ x, y, z: 0.5, count: 5, life: 0.35, size: 1.4, color: [0xd8c8a8, 0x9a8a6a], frame: FRAME_SQUARE, velVar: 1.4, gravity: 5 });
  }

  woodChips(x: number, y: number) {
    this.emit({ x, y, z: 0.55, count: 5, life: 0.5, size: 1.1, color: [0xc8a878, 0x8a6038, 0xdfc79b], frame: FRAME_SQUARE, velVar: 1.5, gravity: 6 });
  }

  stoneChips(x: number, y: number, gold = false) {
    this.emit({
      x, y, z: 0.45, count: 5, life: 0.5, size: 1.1,
      color: gold ? [0xf0d878, 0xd0a020, 0xa8b0b0] : [0xc0c8c8, 0x909898, 0x788080],
      frame: FRAME_SQUARE, velVar: 1.5, gravity: 6,
    });
  }

  gatherSparkle(x: number, y: number) {
    this.emit({ x, y, z: 0.5, count: 2, life: 0.5, size: 1.2, color: 0xfff0a0, additive: true, frame: FRAME_SPARK, velVar: 0.4, gravity: -0.4 });
  }

  dust(x: number, y: number, count = 6, size = 2.2) {
    this.emit({ x, y, z: 0.15, count, life: 0.9, size, sizeEnd: size * 2, color: [0xbfae8e, 0xa89878], alpha: 0.55, frame: FRAME_SMOKE, velVar: 0.7, vel: [0, 0.8, 0], gravity: -0.15, drag: 1.6 });
  }

  buildingSmoke(x: number, y: number, z: number) {
    this.emit({ x, y, z, count: 1, life: 1.6, size: 2.4, sizeEnd: 4.6, color: [0x555555, 0x777777], alpha: 0.5, frame: FRAME_SMOKE, vel: [0, 1.1, 0], velVar: 0.25, gravity: -0.5, drag: 0.8 });
  }

  fire(x: number, y: number, z: number) {
    this.emit({ x, y, z, count: 2, life: 0.5, size: 1.8, sizeEnd: 0.8, color: [0xffa030, 0xffd060, 0xff6020], additive: true, frame: FRAME_DISC, vel: [0, 1.4, 0], velVar: 0.35, gravity: -1.2, drag: 0.6 });
  }

  explosion(x: number, y: number) {
    this.emit({ x, y, z: 0.35, count: 14, life: 0.5, size: 3.2, sizeEnd: 1.2, color: [0xffc860, 0xff8030, 0xfff0a0], additive: true, frame: FRAME_DISC, velVar: 2.8, gravity: 1.5, drag: 1.4 });
    this.emit({ x, y, z: 0.3, count: 10, life: 1.3, size: 2.6, sizeEnd: 5.4, color: [0x6a5a48, 0x8a7a62], alpha: 0.6, frame: FRAME_SMOKE, velVar: 1.1, vel: [0, 1.6, 0], gravity: -0.2, drag: 1.4 });
    this.emit({ x, y, z: 0.4, count: 10, life: 0.8, size: 1.3, color: [0x5a4a3a, 0x3a3028], frame: FRAME_SQUARE, velVar: 3.2, gravity: 7 });
  }

  collapse(x: number, y: number, w: number) {
    this.emit({ x, y, z: 0.3, count: 22, life: 1.4, size: 3, sizeEnd: 6, spread: w * 0.45, color: [0xb0a088, 0x8a7a66, 0xcabfa8], alpha: 0.7, frame: FRAME_SMOKE, velVar: 0.9, vel: [0, 1.4, 0], gravity: -0.2, drag: 1.1 });
    this.emit({ x, y, z: 0.4, count: 16, life: 0.9, size: 1.4, spread: w * 0.4, color: [0x9a8a72, 0x6a5a48], frame: FRAME_SQUARE, velVar: 2.6, gravity: 7 });
  }

  deathPoof(x: number, y: number) {
    this.emit({ x, y, z: 0.3, count: 7, life: 0.7, size: 1.8, sizeEnd: 3.2, color: [0xcabfa8, 0xa89a82], alpha: 0.5, frame: FRAME_SMOKE, velVar: 0.6, gravity: -0.3, drag: 1.2 });
  }

  spawnFlash(x: number, y: number, color: number) {
    this.emit({ x, y, z: 0.35, count: 8, life: 0.45, size: 1.6, color, additive: true, frame: FRAME_SPARK, velVar: 1, gravity: -0.5 });
  }

  rallyPing(x: number, y: number, color: number) {
    this.emit({ x, y, z: 0.15, count: 6, life: 0.5, size: 1.3, color, additive: true, frame: FRAME_DISC, velVar: 0.5, vel: [0, 1.8, 0], gravity: 2 });
  }
}

// ---------------------------------------------------------------------------
// Selection rings
// ---------------------------------------------------------------------------

export class SelectionRings {
  readonly mesh: THREE.InstancedMesh;
  private mat4 = new THREE.Matrix4();
  private color = new THREE.Color();

  constructor(capacity = 220) {
    const geo = new THREE.RingGeometry(0.82, 1, 20);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
  }

  begin() {
    this.mesh.count = 0;
  }

  add(x: number, y: number, radius: number, colorHex: number) {
    const i = this.mesh.count;
    if (i >= 220) return;
    this.mat4.makeScale(radius, 1, radius);
    this.mat4.setPosition(x, 0.045, y);
    this.mesh.setMatrixAt(i, this.mat4);
    this.mesh.setColorAt(i, this.color.setHex(colorHex));
    this.mesh.count = i + 1;
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
