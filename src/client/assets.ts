// Asset pipeline: glTF/GLB loading with caching, conversion of every material
// to flat-lit PS1-style Lambert with nearest-filtered textures and vertex
// snapping, the shared character animation library, team-color texture
// variants, procedural pixel textures, and a tiny offscreen renderer that
// turns 3D models into Win98-style icons.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER_COLORS } from '../shared/data';
import { ANIM_LIBRARY, TEAM_REMAP } from './visuals';

// Shared uniform: all PS1-patched materials snap vertices to this virtual
// resolution (half the render-target size gives the classic wobble).
export const snapUniform = { value: new THREE.Vector2(320, 240) };

// Fog-of-war uniforms, shared by every world material. The R channel of the
// fog texture holds the visibility factor (0 unexplored, ~0.55 explored,
// 1 visible); world XZ maps straight into it.
export const fowUniforms = {
  uFowTex: { value: null as THREE.Texture | null },
  uFowSize: { value: 1 },
  uFowEnabled: { value: 0 },
};

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const loader = new GLTFLoader();
const modelCache = new Map<string, Promise<LoadedModel>>();
const teamMaterialCache = new Map<string, THREE.Material>();

/** Inject PS1 vertex snapping + fog-of-war sampling into any material. */
export function ps1ify(mat: THREE.Material) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnapRes = snapUniform;
    shader.uniforms.uFowTex = fowUniforms.uFowTex;
    shader.uniforms.uFowSize = fowUniforms.uFowSize;
    shader.uniforms.uFowEnabled = fowUniforms.uFowEnabled;
    shader.vertexShader = 'uniform vec2 uSnapRes;\nvarying vec2 vFowPos;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      // PS1 vertex wobble: quantize NDC positions to the low-res grid
      gl_Position.xy = floor(gl_Position.xy / gl_Position.w * uSnapRes + 0.5) / uSnapRes * gl_Position.w;
      {
        // world position for fog-of-war lookup (instancing-aware)
        vec4 fowWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fowWorld = instanceMatrix * fowWorld;
        #endif
        fowWorld = modelMatrix * fowWorld;
        vFowPos = fowWorld.xz;
      }`,
    );
    shader.fragmentShader =
      'uniform sampler2D uFowTex;\nuniform float uFowSize;\nuniform float uFowEnabled;\nvarying vec2 vFowPos;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uFowEnabled > 0.5) {
          float fow = texture2D(uFowTex, vFowPos / uFowSize).r;
          gl_FragColor.rgb *= fow;
        }`,
      );
  };
  mat.needsUpdate = true;
}

export function pixelate(tex: THREE.Texture) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
}

/** Convert a glTF PBR material to flat-shaded retro Lambert. */
function toRetroMaterial(src: THREE.Material): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  const mat = new THREE.MeshLambertMaterial({
    map: s.map ?? null,
    color: s.color ? s.color.clone() : new THREE.Color(0xffffff),
    transparent: s.transparent,
    opacity: s.opacity,
    alphaTest: s.transparent ? 0.35 : 0,
    side: s.side,
  });
  if (mat.map) pixelate(mat.map);
  mat.name = s.name;
  ps1ify(mat);
  return mat;
}

function prepareScene(scene: THREE.Group) {
  const converted = new Map<THREE.Material, THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = mats.map((m) => {
      let c = converted.get(m);
      if (!c) { c = toRetroMaterial(m); converted.set(m, c); }
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0];
  });
}

export function loadModel(path: string): Promise<LoadedModel> {
  let p = modelCache.get(path);
  if (!p) {
    p = loader.loadAsync(path).then((gltf) => {
      prepareScene(gltf.scene as unknown as THREE.Group);
      return { scene: gltf.scene as unknown as THREE.Group, animations: gltf.animations };
    });
    modelCache.set(path, p);
  }
  return p;
}

/** Skinned characters need SkeletonUtils; static props can just clone. */
export function instantiate(model: LoadedModel, skinned: boolean): THREE.Group {
  return (skinned ? skeletonClone(model.scene) : model.scene.clone(true)) as THREE.Group;
}

// ---------------------------------------------------------------------------
// Animation library
// ---------------------------------------------------------------------------

export const animLibrary = new Map<string, THREE.AnimationClip>();

export async function loadAnimationLibrary() {
  const models = await Promise.all(ANIM_LIBRARY.map((p) => loader.loadAsync(p)));
  for (const m of models) {
    for (const clip of m.animations) {
      if (!animLibrary.has(clip.name)) animLibrary.set(clip.name, clip);
    }
  }
}

export function getClip(name: string): THREE.AnimationClip | undefined {
  return animLibrary.get(name);
}

export function getAnimationClips(): THREE.AnimationClip[] {
  return [...animLibrary.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Team colors: remap accent hues in character textures to the player color
// ---------------------------------------------------------------------------

function remapTexture(tex: THREE.Texture, hueMin: number, hueMax: number, minSat: number, target: THREE.Color): THREE.Texture {
  const img = tex.image as HTMLImageElement | HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const tgt = { h: 0, s: 0, l: 0 };
  target.getHSL(tgt);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) continue;
    const s = d / (1 - Math.abs(2 * l - 1));
    if (s < minSat) continue;
    let h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < hueMin || h > hueMax) continue;
    // keep luminance/saturation, adopt the team hue
    const c = new THREE.Color().setHSL(tgt.h, Math.min(1, s * 0.9 + 0.1), l);
    px[i] = Math.round(c.r * 255);
    px[i + 1] = Math.round(c.g * 255);
    px[i + 2] = Math.round(c.b * 255);
  }
  ctx.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(canvas);
  out.flipY = tex.flipY;
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  pixelate(out);
  return out;
}

/** Apply team-color materials to a freshly cloned character. */
export function applyTeamColor(root: THREE.Object3D, unitType: string, player: number) {
  const cfg = TEAM_REMAP[unitType];
  if (!cfg) return;
  const color = new THREE.Color(PLAYER_COLORS[player]?.hex ?? 0xffffff);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = mats.map((m) => {
      const lm = m as THREE.MeshLambertMaterial;
      if (!lm.map) return m;
      const key = `${unitType}:${player}:${lm.uuid}`;
      let cached = teamMaterialCache.get(key);
      if (!cached) {
        const clone = lm.clone();
        clone.map = remapTexture(lm.map, cfg.hueMin, cfg.hueMax, cfg.minSat, color);
        ps1ify(clone);
        teamMaterialCache.set(key, (cached = clone));
      }
      return cached;
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0];
  });
}

// ---------------------------------------------------------------------------
// Procedural pixel textures (particles, terrain, minimap glyphs)
// ---------------------------------------------------------------------------

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

export const particleTextures = {
  /** chunky soft disc */
  disc: () => canvasTexture(16, (ctx, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = Math.hypot(x - s / 2 + 0.5, y - s / 2 + 0.5) / (s / 2);
        const a = d < 0.45 ? 1 : d < 0.75 ? 0.7 : d < 1 ? 0.25 : 0;
        if (a > 0) {
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }),
  /** 4-point spark */
  spark: () => canvasTexture(16, (ctx, s) => {
    ctx.fillStyle = '#fff';
    const m = s / 2;
    for (let i = 0; i < m; i++) {
      const w = Math.max(1, Math.round((1 - i / m) * 3));
      ctx.globalAlpha = 1 - (i / m) * 0.8;
      ctx.fillRect(m - w / 2, m - i - 1, w, 1);
      ctx.fillRect(m - w / 2, m + i, w, 1);
      ctx.fillRect(m - i - 1, m - w / 2, 1, w);
      ctx.fillRect(m + i, m - w / 2, 1, w);
    }
  }),
  /** blocky smoke puff */
  smoke: () => canvasTexture(24, (ctx, s) => {
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * s * 0.3;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      const bs = 2 + Math.random() * 4;
      ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.4})`;
      ctx.fillRect(Math.round(x - bs / 2), Math.round(y - bs / 2), Math.round(bs), Math.round(bs));
    }
  }),
};

/** 4-variant terrain atlas: grass, light grass, dirt, dark grass. */
export function makeTerrainAtlas(theme: 'arabia' | 'arena' | 'blackforest' = 'arena'): THREE.CanvasTexture {
  const T = 32;
  return canvasTexture(T * 4, (ctx) => {
    const bases: [string, string[]][] = theme === 'arabia' ? [
      ['#b6985a', ['#c2a564', '#a98a50', '#ceb174', '#927746']],
      ['#c4aa68', ['#d1b776', '#b69a5b', '#dcc58a', '#a58a50']],
      ['#aa844a', ['#ba9252', '#98723e', '#c39d61', '#806035']],
      ['#8f743f', ['#9e8248', '#7d6336', '#ac9155', '#70582f']],
    ] : theme === 'blackforest' ? [
      ['#d4dde0', ['#e4ecee', '#bcc8cc', '#f1f4f5', '#aab8bc']],
      ['#edf1f2', ['#ffffff', '#d7dfe1', '#e5ebed', '#c6d0d3']],
      ['#aeb8b8', ['#bbc5c5', '#939f9f', '#cbd2d2', '#7f8d8d']],
      ['#65766f', ['#72847c', '#53645d', '#81928a', '#465850']],
    ] : [
      ['#4d7c3a', ['#568a41', '#477436', '#5d9347', '#43682f']],
      ['#5d8f46', ['#68a04f', '#548140', '#74a85b', '#4d7a3a']],
      ['#8a6f47', ['#96794e', '#7d6440', '#a08355', '#71583a']],
      ['#3f6830', ['#487536', '#385d2a', '#50803c', '#325426']],
    ];
    for (let v = 0; v < 4; v++) {
      const [base, specks] = bases[v];
      ctx.fillStyle = base;
      ctx.fillRect(v * T, 0, T, T * 4);
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = specks[(Math.random() * specks.length) | 0];
        const x = v * T + ((Math.random() * T) | 0);
        const y = (Math.random() * T * 4) | 0;
        ctx.fillRect(x, y, 1 + ((Math.random() * 2) | 0), 1);
      }
    }
  });
}

/** 16×16 pixel-art icons for the resource bar (drawn, not loaded). */
export function drawResourceIcon(kind: string): string {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  const P = (x: number, y: number, w: number, h: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  };
  switch (kind) {
    case 'food':
      P(5, 4, 7, 8, '#c03028'); P(6, 3, 5, 1, '#c03028'); P(6, 12, 5, 1, '#902020');
      P(7, 1, 2, 3, '#6a4a2a'); P(9, 2, 3, 2, '#30a040'); P(6, 5, 2, 2, '#e86058');
      break;
    case 'wood':
      P(2, 8, 12, 3, '#8a6038'); P(3, 5, 12, 3, '#9a7044');
      P(2, 8, 2, 3, '#c8a878'); P(13, 5, 2, 3, '#c8a878');
      P(4, 11, 12, 3, '#7a5430'); P(4, 11, 2, 3, '#c8a878');
      break;
    case 'gold':
      P(4, 6, 8, 7, '#d0a020'); P(5, 5, 6, 1, '#e8c040'); P(5, 7, 3, 2, '#f0d878');
      P(3, 9, 2, 4, '#b08018'); P(11, 9, 3, 4, '#b08018');
      break;
    case 'stone':
      P(3, 7, 10, 6, '#909898'); P(5, 5, 7, 3, '#a8b0b0'); P(4, 8, 4, 3, '#c0c8c8');
      P(10, 9, 3, 3, '#788080');
      break;
    case 'pop':
      P(4, 7, 8, 6, '#c8a878'); P(3, 7, 10, 1, '#7a5430');
      P(5, 3, 6, 4, '#c03028'); P(4, 5, 8, 2, '#a02820');
      P(7, 9, 2, 4, '#5a3a20');
      break;
  }
  return c.toDataURL();
}

// ---------------------------------------------------------------------------
// Icon renderer: photograph models into 44×44 Win98 command-card icons
// ---------------------------------------------------------------------------

let iconRenderer: THREE.WebGLRenderer | null = null;
const iconCache = new Map<string, string>();

export function renderModelIcon(key: string, build: () => THREE.Object3D): string {
  const hit = iconCache.get(key);
  if (hit) return hit;
  if (!iconRenderer) {
    iconRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
    iconRenderer.setSize(96, 96);
    iconRenderer.setClearColor(0x000000, 0);
    iconRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  // icons must not inherit the in-game fog of war
  const fowWas = fowUniforms.uFowEnabled.value;
  fowUniforms.uFowEnabled.value = 0;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x668866, 1.35));
  const dir = new THREE.DirectionalLight(0xfff2d8, 1.6);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  const obj = build();
  scene.add(obj);

  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const r = Math.max(sphere.radius, 0.001);
  const dirV = new THREE.Vector3(0.85, 0.62, 1).normalize();
  cam.position.copy(sphere.center).addScaledVector(dirV, r * 2.6);
  cam.lookAt(sphere.center);
  iconRenderer.render(scene, cam);
  fowUniforms.uFowEnabled.value = fowWas;
  const url = iconRenderer.domElement.toDataURL();
  iconCache.set(key, url);
  return url;
}

/** Simple lettered scroll icon for techs/actions without a model. */
export function glyphIcon(text: string, bg = '#d4c8a0', fg = '#403020'): string {
  const key = `glyph:${text}:${bg}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 44;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(2, 6, 40, 32);
  ctx.fillStyle = '#a89868';
  ctx.fillRect(2, 6, 40, 3);
  ctx.fillRect(2, 35, 40, 3);
  ctx.fillStyle = fg;
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 3), 22, 22);
  const url = c.toDataURL();
  iconCache.set(key, url);
  return url;
}
