// Graphics levels: how good the city looks to a person. Everything here is on display-only layers or
// attached to the viewing cameras, so car and garage cameras render the same frames at every level.
// Vision accuracy was measured on level 3, and that measurement stays valid wherever the slider sits.
import {
  Color3,
  DefaultRenderingPipeline,
  DynamicTexture,
  ImageProcessingConfiguration,
  ImageProcessingPostProcess,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Texture,
  TransformNode,
  type Camera,
} from '@babylonjs/core';
import { pointOnRing, type CityMap } from '@carmacar/shared';
import { DISPLAY_ONLY_LAYER, type CityScene, type TimeOfDay } from './scene';

export const GRAPHICS_LEVELS = [
  { level: 1, name: 'Blocks' },
  { level: 2, name: 'Vehicles' },
  { level: 3, name: 'Buildings' },
  { level: 4, name: 'Street detail' },
  { level: 5, name: 'Lighting' },
];
export const DEFAULT_GRAPHICS_LEVEL = 3;

const PROP_SPACING = 17;
const SKY_DIAMETER = 3000;
const DETAIL_VIEW_DISTANCE = 2000;
const BASE_VIEW_DISTANCE = 900;

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class GraphicsLevels {
  level = DEFAULT_GRAPHICS_LEVEL;
  private detail: TransformNode | null = null;
  private sky: Mesh | null = null;
  private skyMaterial: StandardMaterial | null = null;
  private pipelines: DefaultRenderingPipeline[] = [];
  private grades: { camera: Camera; grade: ImageProcessingPostProcess }[] = [];
  private time: TimeOfDay = 'day';

  constructor(
    private readonly view: CityScene,
    private readonly city: CityMap,
  ) {}

  set(level: number) {
    this.level = level;
    this.view.setBlockCars(level < 2);
    this.view.setFlatBuildings(level < 3);
    if (level >= 4) this.buildDetail();
    this.detail?.setEnabled(level >= 4);
    this.sky?.setEnabled(level >= 4 && this.time !== 'night');
    this.view.setViewDistance(level >= 4 ? DETAIL_VIEW_DISTANCE : BASE_VIEW_DISTANCE);
    this.setLighting(level >= 5);
  }

  setTime(time: TimeOfDay) {
    this.time = time;
    this.sky?.setEnabled(this.level >= 4 && time !== 'night');
    this.tintSky();
  }

  private tintSky() {
    if (!this.skyMaterial) return;
    // This is added to the painted sky, so daytime has to be black or the sky washes out to white.
    this.skyMaterial.emissiveColor = this.time === 'dusk' ? new Color3(0.28, 0.08, 0) : Color3.Black();
  }

  private material(hex: string) {
    const m = new StandardMaterial(`gfx-${hex}`, this.view.scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(0.04, 0.04, 0.04);
    return m;
  }

  private buildDetail() {
    if (this.detail) return;
    const scene = this.view.scene;
    this.detail = new TransformNode('gfx-detail', scene);
    const random = mulberry(4242);
    const parts = new Map<string, Mesh[]>();
    const add = (hex: string, mesh: Mesh) => {
      const list = parts.get(hex) ?? [];
      list.push(mesh);
      parts.set(hex, list);
    };
    const box = (hex: string, w: number, h: number, d: number, x: number, y: number, z: number, turn = 0) => {
      const b = MeshBuilder.CreateBox('gfx', { width: w, height: h, depth: d }, scene);
      b.position.set(x, y, z);
      b.rotation.y = turn;
      add(hex, b);
    };
    const round = (hex: string, diameter: number, h: number, x: number, y: number, z: number) => {
      const c = MeshBuilder.CreateCylinder('gfx', { diameter, height: h, tessellation: 10 }, scene);
      c.position.set(x, y, z);
      add(hex, c);
    };

    // Roofs: a parapet, machinery, and the odd water tank.
    for (const b of this.view.buildingBoxes) {
      const top = b.h;
      for (const [w, d, x, z] of [
        [b.w, 0.3, b.x, b.z - b.d / 2 + 0.15],
        [b.w, 0.3, b.x, b.z + b.d / 2 - 0.15],
        [0.3, b.d, b.x - b.w / 2 + 0.15, b.z],
        [0.3, b.d, b.x + b.w / 2 - 0.15, b.z],
      ]) {
        box('#6e6a64', w, 0.7, d, x, top + 0.35, z);
      }
      if (random() < 0.7) box('#9aa0a4', 2.4, 1.3, 1.8, b.x + (random() - 0.5) * 6, top + 0.65, b.z + (random() - 0.5) * 6);
      if (random() < 0.4) box('#7f868b', 1.4, 0.9, 1.4, b.x + (random() - 0.5) * 7, top + 0.45, b.z + (random() - 0.5) * 7);
      if (random() < 0.12) {
        round('#6b4a32', 2.6, 2.6, b.x, top + 3.1, b.z);
        round('#3c3a38', 0.3, 1.8, b.x, top + 0.9, b.z);
      }
      // Storefront awnings, on some ground floors.
      if (random() < 0.45) {
        const colors = ['#b5382e', '#1f6f54', '#2a5d9e', '#c8892a'];
        const hex = colors[Math.floor(random() * colors.length)];
        const facingZ = Math.abs(b.d) < Math.abs(b.w) || random() < 0.5;
        if (facingZ) {
          const side = b.z > 0 ? -1 : 1;
          box(hex, b.w * 0.8, 0.14, 1.5, b.x, 3.1, b.z + side * (b.d / 2 + 0.7));
        } else {
          const side = b.x > 0 ? -1 : 1;
          box(hex, 1.5, 0.14, b.d * 0.8, b.x + side * (b.w / 2 + 0.7), 3.1, b.z);
        }
      }
    }

    // Sidewalks: bins, benches, hydrants and planters, spaced along each block.
    for (const ring of this.city.sidewalks) {
      for (let s = random() * PROP_SPACING; s < ring.length; s += PROP_SPACING) {
        const p = pointOnRing(ring, s, 0.95);
        const y = this.city.sidewalkHeight;
        const pick = random();
        if (pick < 0.3) round('#2f4a3a', 0.6, 0.95, p.x, y + 0.48, p.z);
        else if (pick < 0.55) {
          box('#6b4a32', 1.6, 0.1, 0.5, p.x, y + 0.48, p.z, random() * 2);
          box('#30343a', 1.5, 0.45, 0.12, p.x, y + 0.23, p.z, random() * 2);
        } else if (pick < 0.72) round('#b5382e', 0.26, 0.72, p.x, y + 0.36, p.z);
        else {
          box('#8b8378', 1.1, 0.5, 1.1, p.x, y + 0.25, p.z);
          const bush = MeshBuilder.CreateIcoSphere('gfx', { radius: 0.62, subdivisions: 1, flat: true }, scene);
          bush.position.set(p.x, y + 0.85, p.z);
          add('#3f7038', bush);
        }
      }
    }

    for (const [hex, meshes] of parts) {
      const merged = Mesh.MergeMeshes(meshes, true, true)!;
      merged.material = this.material(hex);
      merged.layerMask = DISPLAY_ONLY_LAYER;
      merged.isPickable = false;
      merged.parent = this.detail;
    }

    this.sky = MeshBuilder.CreateSphere('gfx-sky', { diameter: SKY_DIAMETER, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    const texture = new DynamicTexture('gfx-sky', { width: 1024, height: 512 }, scene, true);
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    const gradient = ctx.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, '#2467c4');
    gradient.addColorStop(0.42, '#6fb0ea');
    gradient.addColorStop(0.5, '#c9e2f4');
    gradient.addColorStop(1, '#c9e2f4');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.filter = 'blur(7px)';
    for (let i = 0; i < 46; i++) {
      const x = random() * 1024;
      const y = 60 + random() * 170;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + random() * 0.4})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 30 + random() * 70, 7 + random() * 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.filter = 'none';
    texture.update();
    const material = new StandardMaterial('gfx-sky', scene);
    material.emissiveTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.fogEnabled = false;
    this.skyMaterial = material;
    this.sky.material = material;
    this.sky.layerMask = DISPLAY_ONLY_LAYER;
    this.sky.isPickable = false;
    this.tintSky();
  }

  // The pipeline's built-in color grading changes a scene-wide setting, which also changes capture
  // frames and stays changed. So grading here uses its own configuration, on the viewing cameras only.
  private setLighting(on: boolean) {
    const cameras = this.view.viewingCameras;
    if (on && this.pipelines.length === 0) {
      // One pipeline per camera: their effects can't be shared between cameras.
      this.pipelines = cameras.map((camera, i) => {
        const pipeline = new DefaultRenderingPipeline(`gfx-lighting-${i}`, false, this.view.scene, [camera]);
        pipeline.imageProcessingEnabled = false;
        this.view.scene.imageProcessingConfiguration.applyByPostProcess = false;
        pipeline.fxaaEnabled = true;
        pipeline.bloomEnabled = true;
        pipeline.bloomThreshold = 0.92;
        pipeline.bloomWeight = 0.18;
        pipeline.bloomScale = 0.5;
        return pipeline;
      });
      const config = new ImageProcessingConfiguration();
      config.toneMappingEnabled = true;
      config.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
      config.exposure = 1.45;
      config.contrast = 1.35;
      config.vignetteEnabled = true;
      config.vignetteWeight = 1.4;
      this.grades = cameras.map((camera) => {
        const grade = new ImageProcessingPostProcess('gfx-grade', 1, camera, Texture.BILINEAR_SAMPLINGMODE, this.view.engine, false, undefined, config);
        // The frame is already gamma corrected. Converting it again washes the picture out.
        grade.fromLinearSpace = false;
        return { camera, grade };
      });
    } else if (!on && this.pipelines.length > 0) {
      for (const pipeline of this.pipelines) pipeline.dispose();
      this.pipelines = [];
      for (const { camera, grade } of this.grades) grade.dispose(camera);
      this.grades = [];
    }
  }
}
