// Rendering core: PS1-era pipeline. The scene renders into a low-resolution
// target (nearest-filtered), then a post pass upscales it with ordered
// dithering and 5-bit color quantization. Combined with vertex snapping
// (assets.ts), Lambert-only lighting and short fog, this gives the authentic
// wobbly-crunchy look — at 2024 frame rates.

import * as THREE from 'three';
import { snapUniform } from '../assets';

/** Scene pixels are ~1/PIXEL_SCALE of the css resolution. */
const PIXEL_SCALE = 3;

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRtSize;
varying vec2 vUv;

float bayer(vec2 p) {
  // 4x4 Bayer matrix, values 0..15
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  // unrolled lookup (GLSL ES 1.0 friendly)
  float m = 0.0;
  if (i == 0) m = 0.0;  else if (i == 1) m = 8.0;  else if (i == 2) m = 2.0;  else if (i == 3) m = 10.0;
  else if (i == 4) m = 12.0; else if (i == 5) m = 4.0; else if (i == 6) m = 14.0; else if (i == 7) m = 6.0;
  else if (i == 8) m = 3.0;  else if (i == 9) m = 11.0; else if (i == 10) m = 1.0; else if (i == 11) m = 9.0;
  else if (i == 12) m = 15.0; else if (i == 13) m = 7.0; else if (i == 14) m = 13.0; else m = 5.0;
  return (m + 0.5) / 16.0 - 0.5;
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  // the render target is linear; convert to display gamma first
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  // dither in RT pixel space, then crush to 5 bits per channel
  c += bayer(vUv * uRtSize) * (1.0 / 36.0);
  c = floor(clamp(c, 0.0, 1.0) * 31.0 + 0.5) / 31.0;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(46, 1, 0.5, 220);

  private rt: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial;

  // camera rig
  focus = new THREE.Vector3(40, 0, 40);
  zoom = 17;         // distance to focus
  targetZoom = 17;
  readonly pitch = 0.94; // rad above horizon
  private shake = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.rt = new THREE.WebGLRenderTarget(640, 360, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    this.postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uRtSize: { value: new THREE.Vector2(640, 360) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    // atmosphere: short draw distance vanishing into haze
    const fogColor = new THREE.Color(0x7f9db4);
    this.scene.fog = new THREE.Fog(fogColor, 34, 95);
    this.scene.background = fogColor;

    const hemi = new THREE.HemisphereLight(0xcfe4f0, 0x51603f, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffeeC8, 1.7);
    sun.position.set(30, 55, 18);
    this.scene.add(sun);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const rw = Math.max(320, Math.round(w / PIXEL_SCALE));
    const rh = Math.max(180, Math.round(h / PIXEL_SCALE));
    this.rt.setSize(rw, rh);
    this.postMat.uniforms.uRtSize.value.set(rw, rh);
    snapUniform.value.set(rw / 2, rh / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addShake(amount: number) {
    this.shake = Math.min(0.6, this.shake + amount);
  }

  /** Position the rig: camera south of focus, looking north-down. */
  updateCamera(dt: number) {
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 10);
    const p = this.pitch;
    const off = new THREE.Vector3(0, Math.sin(p) * this.zoom, Math.cos(p) * this.zoom);
    this.camera.position.copy(this.focus).add(off);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake *= Math.pow(0.001, dt); // rapid decay
    }
    this.camera.lookAt(this.focus);
    // keep the fog band tracking zoom so far ground fades, not gameplay
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.zoom * 1.9;
    fog.far = this.zoom * 4.6;
  }

  render() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
  }

  /** Ray from a screen point onto the ground plane (y = 0), in world tiles. */
  screenToGround(sx: number, sy: number): { x: number; y: number } | null {
    const ndc = new THREE.Vector2(
      (sx / window.innerWidth) * 2 - 1,
      -(sy / window.innerHeight) * 2 + 1,
    );
    const ray = new THREE.Ray();
    ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    ray.direction.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(ray.origin).normalize();
    if (Math.abs(ray.direction.y) < 1e-5) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.z + ray.direction.z * t };
  }

  worldToScreen(x: number, y: number, h = 0): { x: number; y: number; behind: boolean } {
    const v = new THREE.Vector3(x, h, y).project(this.camera);
    return {
      x: (v.x + 1) / 2 * window.innerWidth,
      y: (1 - v.y) / 2 * window.innerHeight,
      behind: v.z > 1,
    };
  }

  dispose() {
    this.rt.dispose();
    this.renderer.dispose();
  }
}
