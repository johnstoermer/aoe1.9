// Ground mesh (one draw call, per-tile atlas UVs), the fog-of-war texture
// (sampled by every world material via ps1ify), and the building placement
// ghost.

import * as THREE from 'three';
import type { GameMap } from '../../shared/map';
import { fowUniforms, makeTerrainAtlas, ps1ify } from '../assets';

export class Terrain {
  readonly mesh: THREE.Mesh;
  private fogTex: THREE.DataTexture;
  private fogData: Uint8Array<ArrayBuffer>;
  private size: number;

  constructor(map: GameMap) {
    this.size = map.size;
    const s = map.size;

    // --- ground ------------------------------------------------------------
    const quads = s * s;
    const pos = new Float32Array(quads * 4 * 3);
    const uv = new Float32Array(quads * 4 * 2);
    const idx = new Uint32Array(quads * 6);
    let vi = 0, ii = 0;
    const pad = 0.004; // inset UVs to avoid atlas bleed
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const variant = map.terrain[y * s + x];
        const u0 = variant * 0.25 + pad, u1 = (variant + 1) * 0.25 - pad;
        // vary the strip vertically so tiles don't repeat obviously
        const vRow = ((x * 7 + y * 13) % 4) * 0.25;
        const v0 = vRow + pad, v1 = vRow + 0.25 - pad;
        const base = vi / 3;
        const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
        for (const [cx, cy] of corners) {
          pos[vi] = cx; pos[vi + 1] = 0; pos[vi + 2] = cy;
          vi += 3;
        }
        uv.set([u0, v1, u1, v1, u1, v0, u0, v0], base * 2);
        idx.set([base, base + 2, base + 1, base, base + 3, base + 2], ii);
        ii += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const atlas = makeTerrainAtlas(map.type);
    atlas.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshLambertMaterial({ map: atlas });
    ps1ify(mat);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;

    // --- fog of war -----------------------------------------------------------
    // R channel = visibility multiplier; every ps1ify'd material samples it.
    this.fogData = new Uint8Array(new ArrayBuffer(s * s * 4));
    for (let i = 3; i < this.fogData.length; i += 4) this.fogData[i] = 255;
    this.fogTex = new THREE.DataTexture(this.fogData, s, s);
    this.fogTex.magFilter = THREE.LinearFilter; // soft edges over chunky tiles
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.needsUpdate = true;
    fowUniforms.uFowTex.value = this.fogTex;
    fowUniforms.uFowSize.value = s;
    fowUniforms.uFowEnabled.value = 1;
  }

  /** visibility: 0 unexplored / 1 explored / 2 visible, per tile. */
  updateFog(visibility: Uint8Array) {
    const d = this.fogData;
    for (let i = 0; i < visibility.length; i++) {
      const v = visibility[i];
      d[i * 4] = v === 2 ? 255 : v === 1 ? 132 : 0;
    }
    this.fogTex.needsUpdate = true;
  }
}

/** Green/red translucent footprint + model preview while placing a building. */
export class PlacementGhost {
  readonly group = new THREE.Group();
  private plate: THREE.Mesh;
  private plateMat: THREE.MeshBasicMaterial;
  private preview: THREE.Object3D | null = null;
  private linePlates: THREE.Mesh[] = [];

  constructor() {
    this.plateMat = new THREE.MeshBasicMaterial({
      color: 0x30d040, transparent: true, opacity: 0.4, depthWrite: false,
    });
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.plateMat);
    this.plate.rotation.x = -Math.PI / 2;
    this.plate.position.y = 0.06;
    this.group.add(this.plate);
    this.group.visible = false;
  }

  setPreview(obj: THREE.Object3D | null) {
    if (this.preview) this.group.remove(this.preview);
    this.preview = obj;
    if (obj) {
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          const mat = (m.material as THREE.Material).clone() as THREE.MeshLambertMaterial;
          mat.transparent = true;
          mat.opacity = 0.65;
          m.material = mat;
        }
      });
      this.group.add(obj);
    }
  }

  show(tx: number, ty: number, w: number, h: number, ok: boolean) {
    this.clearLine();
    this.group.visible = true;
    this.group.position.set(tx + w / 2, 0, ty + h / 2);
    this.plate.scale.set(w, h, 1);
    this.plateMat.color.setHex(ok ? 0x30d040 : 0xd03030);
    if (this.preview) this.preview.position.set(0, 0, 0);
  }

  showLine(tiles: { x: number; y: number }[], valid: (x: number, y: number) => boolean) {
    this.group.visible = true;
    this.group.position.set(0, 0, 0);
    this.plate.visible = false;
    if (this.preview) this.preview.visible = false;
    this.clearLine();
    for (const tile of tiles) {
      const material = this.plateMat.clone();
      material.color.setHex(valid(tile.x, tile.y) ? 0x30d040 : 0xd03030);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(tile.x + 0.5 - this.group.position.x, 0.06, tile.y + 0.5 - this.group.position.z);
      this.group.add(plate);
      this.linePlates.push(plate);
    }
  }

  private clearLine() {
    for (const plate of this.linePlates) this.group.remove(plate);
    this.linePlates.length = 0;
    this.plate.visible = true;
    if (this.preview) this.preview.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
