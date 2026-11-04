// Babylon rendering. Reads the world, draws it, and takes camera frames.
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  FreeCamera,
  HemisphericLight,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
  Vector4,
  VertexData,
} from '@babylonjs/core';
import { add, pointOnRing, rightOf, scale, SPACING_X, SPACING_Z, type CameraPose, type CityMap, type StallState, type Vec2 } from '@carmacar/shared';
import type { LightState } from './signals';
import { LIFT_SECONDS, type Car, type LitterKind, type Walker, type World } from './world';

export type CameraView = 'city' | 'chase' | 'dash';
export type TimeOfDay = 'day' | 'dusk' | 'night';

/** Everything on this layer is invisible to capture cameras, so overlays cannot leak into frames. */
const OVERLAY_LAYER = 0x10000000;
/** City view distance for the demo town, and that town's width. Larger cities scale from these. */
const HOME_RADIUS = 330;
const HOME_SPAN = 372;
const UPPER_RADIUS_RATIO = 1.39;
const SKYLINE_BETA = 0.95;
const WORLD_LAYER = 0x0fffffff;
/** Hidden from people by the garage level view. Capture cameras still see it. */
const CAPTURE_ONLY_LAYER = 0x40000000;
/** Building labels: shown to people, hidden from capture cameras. */
const LABEL_LAYER = 0x20000000;
/** Seen by people, never by capture cameras. Used for anything that exists only to look good. */
export const DISPLAY_ONLY_LAYER = LABEL_LAYER;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FOV_Y = 0.9;

const STATE_COLOR: Record<StallState, Color3> = {
  free: Color3.FromHexString('#1FA35C'),
  occupied: Color3.FromHexString('#D8392B'),
  unknown: Color3.FromHexString('#8D969C'),
};

const VARIANTS: { width: number; length: number; profile: [number, number][]; glass: number[]; windows: [number, number][] }[] = [
  // Sedan
  {
    width: 1.8,
    length: 4.4,
    profile: [[2.2, 0.32], [2.2, 0.66], [2.05, 0.74], [0.98, 0.86], [0.3, 1.34], [-0.95, 1.36], [-1.72, 0.94], [-2.2, 0.88], [-2.2, 0.32]],
    glass: [3, 5],
    windows: [[0.85, 0.9], [0.28, 1.28], [-0.92, 1.3], [-1.55, 0.94]],
  },
  // Hatchback
  {
    width: 1.75,
    length: 3.9,
    profile: [[1.95, 0.32], [1.95, 0.68], [1.8, 0.78], [0.95, 0.9], [0.3, 1.42], [-1.45, 1.42], [-1.92, 0.92], [-1.95, 0.32]],
    glass: [3, 5],
    windows: [[0.8, 0.94], [0.28, 1.36], [-1.4, 1.36], [-1.75, 0.96]],
  },
  // SUV
  {
    width: 1.95,
    length: 4.7,
    profile: [[2.35, 0.42], [2.35, 0.84], [2.15, 0.98], [1.2, 1.08], [0.65, 1.72], [-1.95, 1.74], [-2.3, 1.08], [-2.35, 0.42]],
    glass: [3, 5],
    windows: [[1.05, 1.12], [0.62, 1.64], [-1.88, 1.66], [-2.12, 1.12]],
  },
  // Van
  {
    width: 1.95,
    length: 5.0,
    profile: [[2.5, 0.4], [2.5, 0.92], [2.3, 1.1], [1.7, 1.24], [1.1, 2.0], [-2.45, 2.02], [-2.5, 0.4]],
    glass: [3],
    windows: [[1.55, 1.3], [1.08, 1.92], [0.2, 1.92], [0.2, 1.3]],
  },
];

/** Windows only: dark walls with some rooms lit, used as the emissive layer at night. */
function nightTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('facade-night', { width: 512, height: 512 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 512, 512);
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      const seeded = (x * 7 + y * 13) % 5;
      if (seeded === 0 || seeded === 3) continue;
      ctx.fillStyle = seeded === 1 ? '#ffd98a' : seeded === 2 ? '#ffc35c' : '#bcd6ff';
      ctx.fillRect(x * 128 + 24, y * 128 + 26, 80, 76);
    }
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

function facadeTexture(scene: Scene, wall: string, glass: string): DynamicTexture {
  const tex = new DynamicTexture('facade', { width: 128, height: 128 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = glass;
  ctx.fillRect(24, 26, 80, 76);
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

export class CityScene {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly overview: ArcRotateCamera;
  /** How far back the city view sits, scaled so a larger city still fits. */
  private get homeRadius() {
    const { minX, maxX, minZ, maxZ } = this.city.bounds;
    return HOME_RADIUS * Math.max(1, Math.max(maxX - minX, maxZ - minZ) / HOME_SPAN);
  }
  private readonly chase: FreeCamera;
  private readonly capture: FreeCamera;
  private readonly shadows: ShadowGenerator;
  private readonly carMeshes = new Map<string, InstancedMesh>();
  private readonly templates = new Map<string, Mesh>();
  private readonly stallMarkers = new Map<string, Mesh>();
  private readonly stallMaterials: Record<StallState, StandardMaterial>;
  private followId: string | null = null;
  private view: CameraView = 'city';
  private readonly hemi: HemisphericLight;
  private readonly sun: DirectionalLight;
  private readonly facadeMaterials: StandardMaterial[] = [];
  /** Where each building stands, for the detail that graphics levels add. */
  readonly buildingBoxes: { x: number; z: number; w: number; d: number; h: number }[] = [];
  private readonly buildingMeshes: Mesh[] = [];
  private readonly flatBuildings: Mesh[] = [];
  private readonly carBlocks = new Map<string, InstancedMesh>();
  private readonly blockTemplates = new Map<string, Mesh>();
  private blockCars = false;
  private readonly nightLights: Mesh[] = [];
  private followedWalker: Walker | null = null;
  private walkerEyes = false;
  private personMesh!: (color: string) => Mesh;
  private followedPose: (() => { x: number; y: number; z: number; tx: number; tz: number } | null) | null = null;
  private readonly walkerMeshes = new Map<string, InstancedMesh>();
  private readonly litterMeshes = new Map<string, InstancedMesh>();
  private litterTemplates!: Record<LitterKind, Mesh>;
  private readonly garageParts: { mesh: Mesh; level: number }[] = [];
  private garageTopLevel = Infinity;
  private routeLine: Mesh | null = null;
  private readonly labels: Mesh[] = [];
  private readonly lights: { nodeId: string; dir: Vec2; lamp: Mesh; bar: Mesh }[] = [];
  private lightMaterials!: Record<LightState, StandardMaterial>;
  private readonly frameTarget: RenderTargetTexture;
  private readonly encodeContext: CanvasRenderingContext2D;
  private captureChain: Promise<unknown> = Promise.resolve();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly city: CityMap,
    private readonly world: World,
  ) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.62, 0.78, 0.93, 1);

    const hemi = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    this.hemi = hemi;
    hemi.intensity = 0.8;
    // Bounced light, so garage ceilings are not pitch black.
    hemi.groundColor = new Color3(0.6, 0.6, 0.6);
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.35), this.scene);
    this.sun = sun;
    sun.position = new Vector3(120, 180, -100);
    sun.intensity = 0.62;
    this.shadows = new ShadowGenerator(4096, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.001;
    this.shadows.normalBias = 0.02;

    this.overview = new ArcRotateCamera('overview', -Math.PI / 2, 0.5, 330, new Vector3(30, 0, 0), this.scene);
    this.overview.lowerRadiusLimit = 40;
    this.overview.upperRadiusLimit = this.homeRadius * UPPER_RADIUS_RATIO;
    this.overview.radius = this.homeRadius;
    // Real skylines read better from an angle than straight down.
    if (city.buildings) this.overview.beta = SKYLINE_BETA;
    if (city.buildings) this.overview.target.set(0, 0, 0);
    this.overview.upperBetaLimit = 1.35;
    this.overview.wheelPrecision = 2;
    this.overview.panningSensibility = 12;
    this.overview.layerMask = WORLD_LAYER | OVERLAY_LAYER | LABEL_LAYER;
    this.overview.attachControl(canvas, true);

    this.chase = new FreeCamera('chase', new Vector3(0, 3, 0), this.scene);
    this.chase.fov = 1.0;
    this.chase.minZ = 0.2;
    this.chase.maxZ = 900;
    this.chase.layerMask = WORLD_LAYER | LABEL_LAYER;

    this.capture = new FreeCamera('capture', new Vector3(0, 1.4, 0), this.scene);
    this.capture.fov = FOV_Y;
    this.capture.minZ = 0.1;
    this.capture.maxZ = 500;
    this.capture.layerMask = WORLD_LAYER | CAPTURE_ONLY_LAYER;

    this.scene.activeCamera = this.overview;

    this.frameTarget = new RenderTargetTexture('frame', { width: FRAME_WIDTH, height: FRAME_HEIGHT }, this.scene, false, true);
    this.frameTarget.activeCamera = this.capture;
    this.frameTarget.samples = 4;
    this.frameTarget.clearColor = new Color4(0.62, 0.78, 0.93, 1);
    this.frameTarget.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    this.scene.customRenderTargets.push(this.frameTarget);
    const encoder = document.createElement('canvas');
    encoder.width = FRAME_WIDTH;
    encoder.height = FRAME_HEIGHT;
    this.encodeContext = encoder.getContext('2d')!;

    this.stallMaterials = {
      free: this.overlayMaterial('free'),
      occupied: this.overlayMaterial('occupied'),
      unknown: this.overlayMaterial('unknown'),
    };
    this.buildGround();
    this.buildGarages();
    this.buildBuildings();
    this.buildStalls();
    this.buildDestinationSigns();
    this.buildBuildingLabels();
    this.buildSignals();
    this.buildPeopleAndLitter();
    this.buildStreetLife();
    for (const mesh of this.nightLights) mesh.setEnabled(false);
  }

  private garageAt(x0: number, x1: number, z0: number, z1: number) {
    return this.city.garages.some((g) => g.x > x0 && g.x < x1 && g.z > z0 && g.z < z1);
  }

  private floorY(level: number | undefined) {
    return (level ?? 0) * (this.city.garages[0]?.floorHeight ?? 0);
  }

  /** Concrete decks, pillars, low walls and the transporter pad. Purely visual. */
  private buildGarages() {
    const concrete = this.solid('#8b8f93');
    const deck = this.solid('#5f6368');
    const pad = new StandardMaterial('transporter', this.scene);
    pad.diffuseColor = Color3.FromHexString('#37D3E8');
    pad.emissiveColor = Color3.FromHexString('#37D3E8').scale(0.6);
    pad.specularColor = Color3.Black();
    const glow = this.lampMaterial('#F4F5F2');

    for (const g of this.city.garages) {
      const rotation = Math.atan2(g.inward.x, g.inward.z);
      const place = (mesh: Mesh, u: number, v: number, y: number, level: number) => {
        const p = add(add(g.door, scale(g.aisle, u)), scale(g.inward, v));
        mesh.position.set(p.x, y, p.z);
        mesh.rotation.y = rotation;
        mesh.isPickable = false;
        this.garageParts.push({ mesh, level });
      };
      const box = (w: number, h: number, d: number, u: number, v: number, y: number, level: number, material: StandardMaterial) => {
        const b = MeshBuilder.CreateBox('garage', { width: w, height: h, depth: d }, this.scene);
        b.material = material;
        place(b, u, v, y, level);
      };
      for (let level = 0; level < g.levels; level++) {
        const y = level * g.floorHeight;
        if (level === 0) box(g.width, 0.04, g.depth, 0, g.depth / 2, 0.02, level, deck);
        else box(g.width, 0.3, g.depth, 0, g.depth / 2, y - 0.15, level, deck);

        // Low walls, leaving the door open on the ground floor.
        box(0.3, 1.1, g.depth, -g.width / 2, g.depth / 2, y + 0.55, level, concrete);
        box(0.3, 1.1, g.depth, g.width / 2, g.depth / 2, y + 0.55, level, concrete);
        box(g.width, 1.1, 0.3, 0, g.depth, y + 0.55, level, concrete);
        if (level === 0) {
          box(g.width / 2 - 4, 1.1, 0.3, -(g.width / 4 + 2), 0, y + 0.55, level, concrete);
          box(g.width / 2 - 4, 1.1, 0.3, g.width / 4 + 2, 0, y + 0.55, level, concrete);
        } else {
          box(g.width, 1.1, 0.3, 0, 0, y + 0.55, level, concrete);
        }

        if (level < g.levels - 1) {
          for (const u of [-29, -14.5, 14.5, 29]) {
            for (const v of [1, g.depth - 1]) box(0.6, g.floorHeight, 0.6, u, v, y + g.floorHeight / 2, level, concrete);
          }
          box(40, 0.06, 0.4, 0, 21, y + g.floorHeight - 0.34, level, glow);
        }

        const disc = MeshBuilder.CreateDisc('transporter', { radius: 3.2, tessellation: 28 }, this.scene);
        disc.rotation.x = Math.PI / 2;
        disc.bakeCurrentTransformIntoVertices();
        disc.material = pad;
        place(disc, 0, 8, y + 0.05, level);
      }
    }
  }

  /** Hides upper floors from people so they can see inside. Capture cameras still see everything. */
  setGarageView(topLevel: number) {
    this.garageTopLevel = topLevel;
    for (const { mesh, level } of this.garageParts) {
      mesh.layerMask = level > topLevel ? CAPTURE_ONLY_LAYER : WORLD_LAYER;
    }
    for (const [id, marker] of this.stallMarkers) {
      const level = this.world.stalls.get(id)?.level ?? 0;
      marker.setEnabled(level <= topLevel);
    }
  }

  private buildPeopleAndLitter() {
    const skin = Color3.FromHexString('#d7a77f').toColor4();
    const legs = Color3.FromHexString('#2b3440').toColor4();
    const person = (hex: string) => {
      const shirt = Color3.FromHexString(hex).toColor4();
      const body = MeshBuilder.CreateCylinder('torso', { diameterTop: 0.42, diameterBottom: 0.34, height: 0.72, tessellation: 8, faceColors: Array(3).fill(shirt) }, this.scene);
      body.position.y = 1.2;
      const lower = MeshBuilder.CreateCylinder('legs', { diameter: 0.32, height: 0.84, tessellation: 8, faceColors: Array(3).fill(legs) }, this.scene);
      lower.position.y = 0.42;
      const head = MeshBuilder.CreateSphere('head', { diameter: 0.3, segments: 6 }, this.scene);
      head.position.y = 1.72;
      head.setVerticesData('color', new Array((head.getTotalVertices()) * 4).fill(0).map((_, i) => [skin.r, skin.g, skin.b, 1][i % 4]));
      const merged = Mesh.MergeMeshes([body, lower, head], true, true)!;
      const material = new StandardMaterial(`person-${hex}`, this.scene);
      material.specularColor = Color3.Black();
      merged.material = material;
      merged.useVertexColors = true;
      merged.isVisible = false;
      merged.isPickable = false;
      return merged;
    };
    const templates = new Map<string, Mesh>();
    this.personMesh = (color) => {
      if (!templates.has(color)) templates.set(color, person(color));
      return templates.get(color)!;
    };
    for (const w of this.world.walkers) {
      const mesh = this.personMesh(w.color).createInstance(w.id);
      mesh.isPickable = false;
      this.walkerMeshes.set(w.id, mesh);
    }
    // Lumpy, flat-shaded and tied at the top. A smooth sphere reads as a ball, even to SAM.
    const lumpyBag = (size: number, x: number, z: number, hex: string) => {
      const color = Color3.FromHexString(hex).toColor4();
      const sack = MeshBuilder.CreateSphere('sack', { diameterX: size, diameterY: size * 1.05, diameterZ: size * 0.9, segments: 5, updatable: true }, this.scene);
      const points = sack.getVerticesData('position')!;
      for (let i = 0; i < points.length; i += 3) {
        const [px, py, pz] = [points[i], points[i + 1], points[i + 2]];
        const bump = 1 + 0.2 * Math.sin(px * 13 + py * 7) * Math.cos(pz * 11 + py * 5);
        points[i] = px * bump;
        points[i + 1] = py * bump * (py > 0 ? 1.15 : 0.85);
        points[i + 2] = pz * bump;
      }
      sack.setVerticesData('position', points);
      const neck = MeshBuilder.CreateCylinder('neck', { diameterTop: size * 0.3, diameterBottom: size * 0.12, height: size * 0.3, tessellation: 6 }, this.scene);
      neck.position.y = size * 0.68;
      neck.bakeCurrentTransformIntoVertices();
      const merged = Mesh.MergeMeshes([sack, neck], true, true)!;
      merged.convertToFlatShadedMesh();
      merged.setVerticesData('color', new Array(merged.getTotalVertices() * 4).fill(0).map((_, i) => [color.r, color.g, color.b, 1][i % 4]));
      merged.position.set(x, size * 0.45, z);
      merged.bakeCurrentTransformIntoVertices();
      return merged;
    };
    const crushedBox = (w: number, x: number, z: number, angle: number) => {
      const brown = Color3.FromHexString('#b58a5a').toColor4();
      const flap = Color3.FromHexString('#8f6a43').toColor4();
      const body = MeshBuilder.CreateBox('carton', { width: w, height: w * 0.55, depth: w * 0.75, faceColors: [brown, brown, flap, flap, flap, brown] }, this.scene);
      body.rotation.set(0.25, angle, 0.15);
      body.position.set(x, w * 0.3, z);
      body.bakeCurrentTransformIntoVertices();
      return body;
    };
    const bag = Mesh.MergeMeshes(
      [lumpyBag(0.85, 0, 0, '#1b1d20'), lumpyBag(0.62, 0.62, 0.2, '#25282c'), lumpyBag(0.55, -0.5, 0.35, '#e4e6e3'), crushedBox(0.55, 0.15, -0.6, 0.6)],
      true,
      true,
    )!;
    const box = Mesh.MergeMeshes([crushedBox(0.8, 0, 0, 0.3), crushedBox(0.6, 0.55, 0.3, 1.1), lumpyBag(0.55, -0.55, 0.3, '#1b1d20')], true, true)!;
    const can = Mesh.MergeMeshes([lumpyBag(0.7, 0, 0, '#2a2d31'), crushedBox(0.5, 0.5, 0.2, 0.9)], true, true)!;
    const litterMaterial = new StandardMaterial('litter', this.scene);
    litterMaterial.specularColor = new Color3(0.35, 0.35, 0.35);
    for (const t of [bag, box, can]) {
      t.material = litterMaterial;
      t.useVertexColors = true;
    }
    const gold = MeshBuilder.CreatePolyhedron('treasure', { type: 1, size: 0.42 }, this.scene);
    const goldMaterial = new StandardMaterial('treasure', this.scene);
    goldMaterial.diffuseColor = Color3.FromHexString('#ffc81f');
    goldMaterial.emissiveColor = Color3.FromHexString('#b37a00');
    goldMaterial.specularColor = new Color3(0.9, 0.8, 0.4);
    gold.material = goldMaterial;
    gold.position.y = 0.6;
    gold.bakeCurrentTransformIntoVertices();
    this.litterTemplates = { bag, box, can, treasure: gold };
    for (const t of [bag, box, can, gold]) {
      t.isVisible = false;
      t.isPickable = false;
    }
  }

  private syncPeopleAndLitter() {
    const y = this.city.sidewalkHeight;
    for (const w of this.world.walkers) {
      const mesh = this.walkerMeshes.get(w.id);
      if (!mesh) continue;
      mesh.position.set(w.pos.x, y, w.pos.z);
      mesh.rotation.y = Math.atan2(w.heading.x, w.heading.z);
    }
    for (const [id, mesh] of this.litterMeshes) {
      if (!this.world.litter.has(id)) {
        mesh.dispose();
        this.litterMeshes.delete(id);
      }
    }
    for (const item of this.world.litter.values()) {
      if (this.litterMeshes.has(item.id)) continue;
      const mesh = this.litterTemplates[item.kind].createInstance(item.id);
      mesh.isPickable = false;
      mesh.position.set(item.pos.x, y, item.pos.z);
      mesh.rotation.y = (item.pos.x * 7 + item.pos.z * 3) % 6.28;
      this.litterMeshes.set(item.id, mesh);
    }
  }

  private overlayMaterial(state: StallState) {
    const m = new StandardMaterial(`overlay-${state}`, this.scene);
    m.diffuseColor = STATE_COLOR[state];
    m.emissiveColor = STATE_COLOR[state].scale(0.75);
    m.specularColor = Color3.Black();
    m.alpha = 0.72;
    return m;
  }

  private flat(name: string, width: number, depth: number, x: number, z: number, material: StandardMaterial, y = 0.02) {
    const g = MeshBuilder.CreateGround(name, { width, height: depth }, this.scene);
    g.position.set(x, y, z);
    g.material = material;
    g.receiveShadows = true;
    g.isPickable = false;
    return g;
  }

  private solid(hex: string, spec = 0.04) {
    const m = new StandardMaterial(hex, this.scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(spec, spec, spec);
    return m;
  }

  private buildGround() {
    const asphalt = this.solid('#55585c');
    const ground = this.flat('asphalt', 1400, 1400, 0, 0, asphalt, 0);
    ground.isPickable = true;

    const yellow = this.solid('#e6c34a');
    const walk = this.solid('#9a9a94');
    const { nodes, segments, roadHalfWidth } = this.city;
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const edge = roadHalfWidth;

    // Sidewalk-height blocks between the streets, plus a ring around the map so it does not end in a void.
    const xs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
    const zs = [...new Set(nodes.map((n) => n.z))].sort((a, b) => a - b);
    const xLines = [xs[0] - SPACING_X, ...xs, xs[xs.length - 1] + SPACING_X];
    const zLines = [zs[0] - SPACING_Z, ...zs, zs[zs.length - 1] + SPACING_Z];
    const parts: Mesh[] = [];
    for (let i = 0; i < xLines.length - 1; i++) {
      for (let j = 0; j < zLines.length - 1; j++) {
        if (this.garageAt(xLines[i], xLines[i + 1], zLines[j], zLines[j + 1])) continue;
        const w = xLines[i + 1] - xLines[i] - edge * 2;
        const d = zLines[j + 1] - zLines[j] - edge * 2;
        const block = MeshBuilder.CreateBox('block', { width: w, depth: d, height: 0.3 }, this.scene);
        block.position.set((xLines[i] + xLines[i + 1]) / 2, 0.15, (zLines[j] + zLines[j + 1]) / 2);
        parts.push(block);
      }
    }
    const blocks = Mesh.MergeMeshes(parts, true, true)!;
    blocks.material = walk;
    blocks.receiveShadows = true;
    blocks.isPickable = false;

    for (const s of segments) {
      const a = nodeById.get(s.a)!;
      const mid = add(a, scale(s.dir, s.length / 2));
      const horizontal = Math.abs(s.dir.x) > 0.5;
      const len = s.length - edge * 2;
      this.flat('center', horizontal ? len : 0.18, horizontal ? 0.18 : len, mid.x, mid.z, yellow);
    }
  }

  /** Crosswalks, trees and street lamps, the things that make a street read as a street. */
  private buildStreetLife() {
    const paint = this.solid('#e9e9e4');
    const stripes: Mesh[] = [];
    const { graph, signals } = this.world;
    for (const nodeId of signals.nodes) {
      for (const out of graph.next(nodeId)) {
        const dir = graph.edgeDir(out);
        const across = rightOf(dir);
        const base = add(graph.node(nodeId), scale(dir, graph.corner - 0.8));
        for (let i = -4; i <= 4; i++) {
          const spot = add(base, scale(across, i * 1.3));
          const stripe = MeshBuilder.CreateGround('crosswalk', { width: 0.6, height: 2.2 }, this.scene);
          stripe.position.set(spot.x, 0.025, spot.z);
          stripe.rotation.y = Math.atan2(dir.x, dir.z);
          stripe.bakeCurrentTransformIntoVertices();
          stripes.push(stripe);
        }
      }
    }
    const crosswalks = Mesh.MergeMeshes(stripes, true, true)!;
    crosswalks.material = paint;
    crosswalks.isPickable = false;
    crosswalks.receiveShadows = true;

    const trunk = this.solid('#5d4632');
    const leaf = this.solid('#3f7d46');
    const metal = this.solid('#3a3f44');
    const lampGlow = this.lampMaterial('#FFE3A8');
    const lampPool = new StandardMaterial('lamp-pool', this.scene);
    lampPool.emissiveColor = Color3.FromHexString('#FFD9A0');
    lampPool.diffuseColor = Color3.Black();
    lampPool.specularColor = Color3.Black();
    lampPool.alpha = 0.16;
    const treeParts: Mesh[] = [];
    const lampParts: Mesh[] = [];
    const y = this.city.sidewalkHeight;
    const spots: { pos: Vec2; tree: boolean }[] = [];
    for (const ring of this.city.sidewalks) {
      for (let s = 9, i = 0; s < ring.length - 4; s += 14, i++) {
        spots.push({ pos: pointOnRing(ring, s, -0.95), tree: i % 3 !== 2 });
      }
    }
    for (const { pos, tree } of spots) {
      if (tree) {
        const bole = MeshBuilder.CreateCylinder('trunk', { diameterTop: 0.16, diameterBottom: 0.26, height: 2.4, tessellation: 6 }, this.scene);
        bole.position.set(pos.x, y + 1.2, pos.z);
        bole.material = trunk;
        treeParts.push(bole);
        const crown = MeshBuilder.CreateIcoSphere('crown', { radius: 1.5, subdivisions: 1, flat: true }, this.scene);
        crown.position.set(pos.x, y + 3.5, pos.z);
        crown.scaling.y = 1.15;
        crown.material = leaf;
        treeParts.push(crown);
      } else {
        const pole = MeshBuilder.CreateCylinder('lamp', { diameterTop: 0.09, diameterBottom: 0.16, height: 5.5, tessellation: 6 }, this.scene);
        pole.position.set(pos.x, y + 2.75, pos.z);
        pole.material = metal;
        lampParts.push(pole);
        const glow = MeshBuilder.CreateSphere('lamp-glow', { diameter: 0.5, segments: 6 }, this.scene);
        glow.position.set(pos.x, y + 5.6, pos.z);
        glow.material = lampGlow;
        glow.isPickable = false;
        const pool = MeshBuilder.CreateDisc('lamp-pool', { radius: 7, tessellation: 20 }, this.scene);
        pool.rotation.x = Math.PI / 2;
        pool.position.set(pos.x, 0.09, pos.z);
        pool.material = lampPool;
        pool.isPickable = false;
        this.nightLights.push(glow, pool);
      }
    }
    for (const parts of [treeParts, lampParts]) {
      if (parts.length === 0) continue;
      const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
      merged.isPickable = false;
      this.shadows.addShadowCaster(merged);
    }
  }

  private buildBuildings() {
    const palettes = [
      ['#8d6e63', '#2a3440'],
      ['#90a4ae', '#26323b'],
      ['#a1887f', '#2f3a44'],
      ['#78909c', '#222c34'],
      ['#bcaaa4', '#33404b'],
      ['#607d8b', '#1f2930'],
    ];
    const byPalette: Mesh[][] = palettes.map(() => []);
    const nodes = this.city.nodes;
    const xs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
    const zs = [...new Set(nodes.map((n) => n.z))].sort((a, b) => a - b);
    const inset = this.city.roadHalfWidth + this.city.sidewalkWidth;
    let n = 0;

    const addBuilding = (x: number, z: number, w: number, d: number, height?: number) => {
      const h = height ?? 6 + ((n * 37) % 10);
      const uvW = w / 4;
      const uvD = d / 4;
      const uvH = h / 4;
      const roof = new Vector4(0, 0, 0.01, 0.01);
      const box = MeshBuilder.CreateBox(
        'building',
        {
          width: w,
          depth: d,
          height: h,
          faceUV: [
            new Vector4(0, 0, uvW, uvH),
            new Vector4(0, 0, uvW, uvH),
            new Vector4(0, 0, uvD, uvH),
            new Vector4(0, 0, uvD, uvH),
            roof,
            roof,
          ],
          wrap: true,
        },
        this.scene,
      );
      box.position.set(x, h / 2, z);
      this.buildingBoxes.push({ x, z, w, d, h });
      byPalette[n % palettes.length].push(box);
      n++;
    };

    const fillBlock = (x0: number, x1: number, z0: number, z1: number) => {
      const depth = 16;
      const lot = 15;
      for (let x = x0 + inset + lot / 2; x + lot / 2 <= x1 - inset; x += lot + 0.5) {
        addBuilding(x, z0 + inset + depth / 2, lot, depth);
        addBuilding(x, z1 - inset - depth / 2, lot, depth);
      }
      for (let z = z0 + inset + depth + lot / 2 + 0.5; z + lot / 2 <= z1 - inset - depth - 0.5; z += lot + 0.5) {
        addBuilding(x0 + inset + depth / 2, z, depth, lot);
        addBuilding(x1 - inset - depth / 2, z, depth, lot);
      }
    };

    const xLines = [xs[0] - SPACING_X, ...xs, xs[xs.length - 1] + SPACING_X];
    const zLines = [zs[0] - SPACING_Z, ...zs, zs[zs.length - 1] + SPACING_Z];
    if (this.city.buildings) {
      for (const b of this.city.buildings) addBuilding(b.x, b.z, b.w, b.d, b.h);
    } else {
      for (let i = 0; i < xLines.length - 1; i++) {
        for (let j = 0; j < zLines.length - 1; j++) {
          if (!this.garageAt(xLines[i], xLines[i + 1], zLines[j], zLines[j + 1])) {
            fillBlock(xLines[i], xLines[i + 1], zLines[j], zLines[j + 1]);
          }
        }
      }
    }

    palettes.forEach(([wall, glass], i) => {
      const parts = byPalette[i];
      if (parts.length === 0) return;
      const merged = Mesh.MergeMeshes(parts, true, true)!;
      const m = new StandardMaterial(`facade${i}`, this.scene);
      m.diffuseTexture = facadeTexture(this.scene, wall, glass);
      const lit = nightTexture(this.scene);
      lit.uScale = 0.25;
      lit.vScale = 0.25;
      lit.level = 0;
      m.emissiveTexture = lit;
      this.facadeMaterials.push(m);
      m.specularColor = new Color3(0.06, 0.06, 0.06);
      merged.material = m;
      merged.isPickable = false;
      this.shadows.addShadowCaster(merged);
      this.buildingMeshes.push(merged);
    });
  }

  /** The two cameras people look through. Capture cameras are left out on purpose. */
  get viewingCameras() {
    return [this.overview, this.chase];
  }

  setViewDistance(metres: number) {
    this.chase.maxZ = metres;
  }

  /** Lowest graphics levels. Capture cameras keep seeing the normal buildings. */
  setFlatBuildings(on: boolean) {
    if (on && this.flatBuildings.length === 0) {
      const walls = ['#a79a8c', '#9ca9b0', '#a99b8e', '#94a3ab', '#b5a99f', '#8ea0aa'];
      this.buildingMeshes.forEach((mesh, i) => {
        const flat = mesh.clone(`flat-${i}`, null)!;
        flat.material = this.solid(walls[i % walls.length]);
        flat.layerMask = DISPLAY_ONLY_LAYER;
        flat.isPickable = false;
        this.flatBuildings.push(flat);
      });
    }
    for (const flat of this.flatBuildings) flat.setEnabled(on);
    for (const mesh of this.buildingMeshes) mesh.layerMask = on ? CAPTURE_ONLY_LAYER : WORLD_LAYER;
  }

  /** The lowest graphics level. Capture cameras keep seeing the normal cars. */
  setBlockCars(on: boolean) {
    this.blockCars = on;
    if (!on) {
      for (const block of this.carBlocks.values()) block.dispose();
      this.carBlocks.clear();
    }
  }

  private blockTemplate(hex: string) {
    let template = this.blockTemplates.get(hex);
    if (!template) {
      template = MeshBuilder.CreateBox(`block-${hex}`, { width: 1.8, height: 1.35, depth: 4.4 }, this.scene);
      template.material = this.solid(hex);
      template.layerMask = DISPLAY_ONLY_LAYER;
      template.isVisible = false;
      template.isPickable = false;
      this.blockTemplates.set(hex, template);
    }
    return template;
  }

  private buildStalls() {
    const white = this.solid('#f2f2f2');
    for (const s of this.city.stalls) {
      const rotation = Math.atan2(s.axis.x, s.axis.z);
      // Painted lines at each end of the stall: real paint that cameras see.
      for (const sign of [-0.5, 0.5]) {
        const end = add(s.center, scale(s.axis, sign * s.length));
        const line = MeshBuilder.CreateGround('stall-line', { width: s.width, height: 0.12 }, this.scene);
        line.position.set(end.x, this.floorY(s.level) + 0.06, end.z);
        line.rotation.y = rotation;
        line.material = white;
        line.isPickable = false;
      }
      // The overlay only the overview camera can see.
      const marker = MeshBuilder.CreateGround(`stall-${s.id}`, { width: s.width * 0.9, height: s.length * 0.9 }, this.scene);
      marker.position.set(s.center.x, this.floorY(s.level) + 0.1, s.center.z);
      marker.rotation.y = rotation;
      marker.material = this.stallMaterials.unknown;
      marker.layerMask = OVERLAY_LAYER;
      marker.metadata = { stallId: s.id };
      this.stallMarkers.set(s.id, marker);
    }
  }

  private buildDestinationSigns() {
    for (const d of this.city.destinations) {
      const tex = new DynamicTexture(`sign-${d.id}`, { width: 512, height: 96 }, this.scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = '#0B4EA2';
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 52px Overpass, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(d.name, 256, 52);
      tex.update();
      const m = new StandardMaterial(`sign-${d.id}`, this.scene);
      m.diffuseTexture = tex;
      m.emissiveColor = new Color3(0.6, 0.6, 0.6);
      m.backFaceCulling = false;
      const plate = MeshBuilder.CreatePlane(`sign-${d.id}`, { width: 13, height: 2.4 }, this.scene);
      plate.material = m;
      plate.isPickable = false;
      const pos = add(d, scale(d.normal, 1.2));
      plate.position.set(pos.x, 7, pos.z);
      plate.rotation.y = Math.atan2(d.normal.x, d.normal.z);
    }
  }

  /** Floating names above each destination. On their own layer, so cameras never see them. */
  private buildBuildingLabels() {
    const places = [
      ...this.city.destinations.map((d) => ({ id: d.id, name: d.name, spot: add(d, scale(d.normal, 8)), y: 26 })),
      ...this.city.garages.map((g) => ({ id: g.id, name: g.name, spot: { x: g.x, z: g.z }, y: 18 })),
    ];
    for (const d of places) {
      const tex = new DynamicTexture(`label-${d.id}`, { width: 640, height: 112 }, this.scene, true);
      tex.hasAlpha = true;
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 640, 112);
      ctx.font = '800 58px Overpass, Arial, sans-serif';
      const width = Math.min(ctx.measureText(d.name).width + 48, 632);
      ctx.fillStyle = '#0B4EA2';
      ctx.fillRect(320 - width / 2, 8, width, 96);
      ctx.strokeStyle = '#F4F5F2';
      ctx.lineWidth = 5;
      ctx.strokeRect(320 - width / 2 + 7, 15, width - 14, 82);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(d.name, 320, 62, width - 30);
      tex.update();
      const m = new StandardMaterial(`label-${d.id}`, this.scene);
      m.diffuseTexture = tex;
      m.emissiveColor = Color3.White();
      m.disableLighting = true;
      m.useAlphaFromDiffuseTexture = true;
      const plate = MeshBuilder.CreatePlane(`label-${d.id}`, { width: 34, height: 6 }, this.scene);
      plate.material = m;
      plate.isPickable = false;
      plate.billboardMode = Mesh.BILLBOARDMODE_ALL;
      plate.layerMask = LABEL_LAYER;
      plate.position.set(d.spot.x, d.y, d.spot.z);
      this.labels.push(plate);
    }
  }

  /** Sets the lighting. Capture cameras see the same light, so this also tests vision at night. */
  setTimeOfDay(time: TimeOfDay) {
    const look = {
      day: { hemi: 0.8, sun: 0.62, sky: [0.62, 0.78, 0.93], ground: 0.6, night: 0 },
      dusk: { hemi: 0.5, sun: 0.3, sky: [0.93, 0.56, 0.42], ground: 0.42, night: 0.6 },
      night: { hemi: 0.3, sun: 0.04, sky: [0.04, 0.06, 0.12], ground: 0.26, night: 1 },
    }[time];
    this.hemi.intensity = look.hemi;
    this.hemi.groundColor = new Color3(look.ground, look.ground, look.ground);
    this.sun.intensity = look.sun;
    const sky = new Color4(look.sky[0], look.sky[1], look.sky[2], 1);
    this.scene.clearColor = sky;
    this.frameTarget.clearColor = sky;
    for (const m of this.facadeMaterials) {
      if (m.emissiveTexture) m.emissiveTexture.level = look.night;
    }
    for (const mesh of this.nightLights) mesh.setEnabled(look.night > 0);
  }

  /** The route line drawn on the road for whoever is driving. */
  setRoute(points: Vec2[] | null) {
    this.routeLine?.dispose();
    this.routeLine = null;
    if (!points || points.length < 2) return;
    const line = MeshBuilder.CreateLines(
      'route',
      { points: points.map((p) => new Vector3(p.x, 0.12, p.z)) },
      this.scene,
    );
    line.color = Color3.FromHexString('#FF8A1F');
    line.isPickable = false;
    line.layerMask = LABEL_LAYER;
    this.routeLine = line;
  }

  setLabelsVisible(visible: boolean) {
    for (const label of this.labels) label.setEnabled(visible);
  }

  private buildSignals() {
    this.lightMaterials = {
      green: this.lampMaterial('#2FE36F'),
      yellow: this.lampMaterial('#FFC928'),
      red: this.lampMaterial('#FF3B2F'),
    };
    const pole = this.solid('#2b2f33');
    const { graph, signals } = this.world;
    for (const nodeId of signals.nodes) {
      for (const leaving of graph.next(nodeId)) {
        const edge = { from: leaving.to, to: leaving.from };
        const dir = graph.edgeDir(edge);
        const right = rightOf(dir);
        const stopLine = add(graph.node(nodeId), scale(dir, -(graph.corner + 1)));
        const post = add(stopLine, scale(right, this.city.roadHalfWidth + 0.7));
        const mast = MeshBuilder.CreateCylinder('signal-pole', { diameter: 0.2, height: 5 }, this.scene);
        mast.position.set(post.x, 2.5, post.z);
        mast.material = pole;
        mast.isPickable = false;
        const lamp = MeshBuilder.CreateSphere('signal-lamp', { diameter: 0.7, segments: 8 }, this.scene);
        lamp.position.set(post.x, 5.2, post.z);
        lamp.isPickable = false;
        // A bar across the lane so the light's state reads from the overview camera.
        const barCenter = add(stopLine, scale(right, this.city.laneOffset));
        const bar = MeshBuilder.CreateGround('signal-bar', { width: 3.4, height: 1 }, this.scene);
        bar.position.set(barCenter.x, 0.07, barCenter.z);
        bar.rotation.y = Math.atan2(dir.x, dir.z);
        bar.isPickable = false;
        bar.layerMask = OVERLAY_LAYER;
        this.lights.push({ nodeId, dir, lamp, bar });
      }
    }
  }

  private lampMaterial(hex: string) {
    const m = new StandardMaterial(`lamp-${hex}`, this.scene);
    m.emissiveColor = Color3.FromHexString(hex);
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    return m;
  }

  private updateLights() {
    for (const { nodeId, dir, lamp, bar } of this.lights) {
      const material = this.lightMaterials[this.world.signals.state(nodeId, dir, this.world.time)];
      lamp.material = material;
      bar.material = material;
    }
  }

  /** A car body built from a side profile, which gives real shapes rather than stacked boxes. */
  private carBody(profile: [number, number][], glassEdges: number[], windows: [number, number][], width: number, paint: Color4, glass: Color4): Mesh {
    const half = width / 2;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const push = (x: number, y: number, z: number, c: Color4) => {
      positions.push(x, y, z);
      colors.push(c.r, c.g, c.b, 1);
      return positions.length / 3 - 1;
    };
    const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
    // Skin across the top, front and back.
    profile.forEach(([z0, y0], i) => {
      const [z1, y1] = profile[(i + 1) % profile.length];
      const color = glassEdges.includes(i) ? glass : paint;
      quad(push(-half, y0, z0, color), push(-half, y1, z1, color), push(half, y1, z1, color), push(half, y0, z0, color));
    });
    // Both sides, as fans from the middle of the shape.
    const cz = profile.reduce((t, p) => t + p[0], 0) / profile.length;
    const cy = profile.reduce((t, p) => t + p[1], 0) / profile.length;
    for (const side of [-1, 1]) {
      const x = side * half;
      const center = push(x, cy, cz, paint);
      profile.forEach(([z0, y0], i) => {
        const [z1, y1] = profile[(i + 1) % profile.length];
        const a = push(x, y0, z0, paint);
        const b = push(x, y1, z1, paint);
        if (side > 0) indices.push(center, b, a);
        else indices.push(center, a, b);
      });
      // Side windows sit just proud of the door.
      const wx = side * (half + 0.012);
      const wc = windows.reduce((t, p) => [t[0] + p[0] / windows.length, t[1] + p[1] / windows.length], [0, 0]);
      const wCenter = push(wx, wc[1], wc[0], glass);
      windows.forEach(([z0, y0], i) => {
        const [z1, y1] = windows[(i + 1) % windows.length];
        const a = push(wx, y0, z0, glass);
        const b = push(wx, y1, z1, glass);
        if (side > 0) indices.push(wCenter, b, a);
        else indices.push(wCenter, a, b);
      });
    }
    const mesh = new Mesh('car-body', this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    // Unused, but merging needs every part to carry the same attributes.
    data.uvs = new Array((positions.length / 3) * 2).fill(0);
    data.applyToMesh(mesh);
    return mesh;
  }

  carTemplate(variant: number, hex: string): Mesh {
    const key = `${variant}${hex}`;
    const existing = this.templates.get(key);
    if (existing) return existing;
    const v = VARIANTS[variant % VARIANTS.length];
    const paint = Color3.FromHexString(hex).toColor4();
    const glass = Color3.FromHexString('#16202a').toColor4();
    const dark = Color3.FromHexString('#141618').toColor4();
    const lamp = Color3.FromHexString('#fff3c4').toColor4();
    const tail = Color3.FromHexString('#b3261e').toColor4();
    const parts: Mesh[] = [this.carBody(v.profile, v.glass, v.windows, v.width, paint, glass)];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: Color4) => {
      const b = MeshBuilder.CreateBox('part', { width: w, height: h, depth: d, faceColors: Array(6).fill(color) }, this.scene);
      b.position.set(x, y, z);
      b.bakeCurrentTransformIntoVertices();
      parts.push(b);
    };
    const frontZ = v.profile[0][0];
    const rearZ = v.profile[v.profile.length - 1][0];
    const lampY = v.profile[1][1] - 0.14;
    box(v.width * 0.96, 0.16, 0.08, 0, 0.42, frontZ + 0.02, dark);
    box(v.width * 0.96, 0.16, 0.08, 0, 0.42, rearZ - 0.02, dark);
    for (const sx of [-1, 1]) {
      box(0.36, 0.14, 0.05, sx * (v.width / 2 - 0.3), lampY, frontZ + 0.02, lamp);
      box(0.36, 0.14, 0.05, sx * (v.width / 2 - 0.3), lampY, rearZ - 0.02, tail);
      box(0.2, 0.1, 0.1, sx * (v.width / 2 + 0.08), v.windows[0][1] + 0.02, v.windows[0][0], dark);
      for (const axle of [frontZ - 0.82, rearZ + 0.82]) {
        const wheel = MeshBuilder.CreateCylinder('wheel', { diameter: 0.68, height: 0.24, tessellation: 16, faceColors: Array(3).fill(dark) }, this.scene);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (v.width / 2 - 0.08), 0.34, axle);
        wheel.bakeCurrentTransformIntoVertices();
        parts.push(wheel);
      }
    }
    const merged = Mesh.MergeMeshes(parts, true, true)!;
    merged.name = `car-${key}`;
    const material = new StandardMaterial(`car-${key}`, this.scene);
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    merged.material = material;
    merged.useVertexColors = true;
    merged.isVisible = false;
    merged.isPickable = false;
    this.templates.set(key, merged);
    return merged;
  }

  /** Height of a car, including its ride on the transporter. */
  /** Ground height under a car, for things drawn around it. */
  carFloor(car: Car) {
    return this.carHeight(car);
  }

  /** Whether a car is on a garage level the viewer is showing. */
  carIsVisible(car: Car) {
    return car.level <= this.garageTopLevel;
  }

  private carHeight(car: Car) {
    const y = this.floorY(car.level);
    if (car.liftT <= 0) return y;
    const from = this.floorY(car.liftFrom);
    return y + (from - y) * (car.liftT / LIFT_SECONDS);
  }

  private syncCars() {
    for (const [id, mesh] of this.carMeshes) {
      if (!this.world.cars.has(id)) {
        this.shadows.removeShadowCaster(mesh);
        mesh.dispose();
        this.carMeshes.delete(id);
        this.carBlocks.get(id)?.dispose();
        this.carBlocks.delete(id);
      }
    }
    for (const car of this.world.cars.values()) {
      let mesh = this.carMeshes.get(car.id);
      if (!mesh) {
        mesh = this.carTemplate(car.variant, car.color).createInstance(car.id);
        mesh.isPickable = false;
        this.shadows.addShadowCaster(mesh);
        this.carMeshes.set(car.id, mesh);
      }
      mesh.position.set(car.pos.x, this.carHeight(car), car.pos.z);
      mesh.rotation.y = Math.atan2(car.heading.x, car.heading.z);
      const hidden = car.level > this.garageTopLevel;
      mesh.layerMask = hidden || this.blockCars ? CAPTURE_ONLY_LAYER : WORLD_LAYER;
      if (!this.blockCars) continue;
      let block = this.carBlocks.get(car.id);
      if (!block) {
        block = this.blockTemplate(car.color).createInstance(`block-${car.id}`);
        block.layerMask = DISPLAY_ONLY_LAYER;
        block.isPickable = false;
        this.carBlocks.set(car.id, block);
      }
      block.position.set(mesh.position.x, mesh.position.y + 0.75, mesh.position.z);
      block.rotation.y = mesh.rotation.y;
      block.setEnabled(!hidden);
    }
  }

  setStallStates(states: Record<string, { state: StallState }>) {
    for (const [id, marker] of this.stallMarkers) {
      const state = states[id]?.state ?? 'unknown';
      marker.material = this.stallMaterials[state];
    }
  }

  /** Picks what the main view shows: the city, or a car from behind or from its dashboard. */
  setView(view: CameraView, carId: string | null) {
    this.view = view;
    this.followId = view === 'city' ? null : carId;
    this.scene.activeCamera = view === 'city' ? this.overview : this.chase;
  }

  /** Redraws a pedestrian after their color changes. */
  recolorWalker(w: Walker) {
    this.walkerMeshes.get(w.id)?.dispose();
    const mesh = this.personMesh(w.color).createInstance(w.id);
    mesh.isPickable = false;
    this.walkerMeshes.set(w.id, mesh);
  }

  /** Switches a followed person between seeing through their eyes and from behind them. */
  setWalkerEyes(on: boolean) {
    this.walkerEyes = on;
    const id = this.followedWalker?.id;
    if (id) this.walkerMeshes.get(id)?.setEnabled(!on);
  }

  /** Follows a person on foot, or stops following. */
  followWalker(walker: Walker | null) {
    if (!walker) this.setWalkerEyes(false);
    this.followedWalker = walker;
    this.scene.activeCamera = walker ? this.chase : this.followId ? this.chase : this.overview;
  }

  /** Follows something outside the city world, such as a car on the highway. */
  followPose(getPose: (() => { x: number; y: number; z: number; tx: number; tz: number } | null) | null) {
    this.followedPose = getPose;
    this.scene.activeCamera = getPose ? this.chase : this.overview;
  }

  /** Pulls the city view back far enough to see the whole highway, or returns to the town. */
  frameHighway(on: boolean) {
    this.overview.upperRadiusLimit = on ? 1100 : this.homeRadius * UPPER_RADIUS_RATIO;
    this.overview.radius = on ? 900 : this.homeRadius;
    this.overview.beta = on ? 0.62 : 0.5;
    this.overview.target.set(on ? 0 : 30, 0, 0);
  }

  private updateChase() {
    const follow = this.followedPose?.();
    if (follow) {
      this.chase.position.set(follow.x - follow.tx * 11, follow.y + 4.4, follow.z - follow.tz * 11);
      this.chase.setTarget(new Vector3(follow.x + follow.tx * 12, follow.y + 1.2, follow.z + follow.tz * 12));
      return;
    }
    const w = this.followedWalker;
    if (w) {
      const y = this.city.sidewalkHeight;
      if (this.walkerEyes) {
        const eye = add(w.pos, scale(w.heading, 0.2));
        this.chase.position.set(eye.x, y + 1.65, eye.z);
        const look = add(w.pos, scale(w.heading, 7));
        this.chase.setTarget(new Vector3(look.x, y + 0.4, look.z));
        return;
      }
      const eye = add(w.pos, scale(w.heading, -4.4));
      this.chase.position.set(eye.x, y + 2.6, eye.z);
      const look = add(w.pos, scale(w.heading, 8));
      this.chase.setTarget(new Vector3(look.x, y + 1, look.z));
      return;
    }
    const car = this.followId ? this.world.cars.get(this.followId) : null;
    if (!car) return;
    const floor = this.carHeight(car);
    if (this.view === 'dash') {
      const eye = add(car.pos, scale(car.heading, 2.7));
      this.chase.position.set(eye.x, floor + 1.25, eye.z);
      const look = add(car.pos, scale(car.heading, 30));
      this.chase.setTarget(new Vector3(look.x, floor + 1.1, look.z));
    } else {
      // Under a garage ceiling the camera has to sit lower and closer.
      const back = car.insideGarage ? 6.5 : 9;
      const height = car.insideGarage ? 2.5 : 4.2;
      const eye = add(car.pos, scale(car.heading, -back));
      this.chase.position.set(eye.x, floor + height, eye.z);
      const look = add(car.pos, scale(car.heading, 10));
      this.chase.setTarget(new Vector3(look.x, floor + 1.2, look.z));
    }
  }

  /** The car nearest a clicked point in the 3D view. */
  pickCar(x: number, y: number): string | null {
    const p = this.scene.pick(x, y, (m) => m.name === 'asphalt')?.pickedPoint;
    if (!p) return null;
    let best: string | null = null;
    let bestDist = 9;
    for (const car of this.world.cars.values()) {
      const d = Math.hypot(car.pos.x - p.x, car.pos.z - p.z);
      if (d < bestDist) {
        bestDist = d;
        best = car.id;
      }
    }
    return best;
  }

  /** The stall nearest a clicked point in the 3D view. */
  pickStall(x: number, y: number): string | null {
    const hit = this.scene.pick(x, y, (m) => m.name === 'asphalt');
    const p = hit?.pickedPoint;
    if (!p) return null;
    let best: string | null = null;
    let bestDist = 4.5;
    for (const s of this.city.stalls) {
      const d = Math.hypot(s.center.x - p.x, s.center.z - p.z);
      if (d < bestDist) {
        bestDist = d;
        best = s.id;
      }
    }
    return best;
  }

  /** A forward quarter view from the front of a car, turned toward the stall side of the street. */
  poseFor(car: Car, stallSide: Vec2): CameraPose {
    const front = add(car.pos, scale(car.heading, 2.6));
    const target = add(add(front, scale(car.heading, 16)), scale(stallSide, 4.5));
    return {
      position: [front.x, 1.4, front.z],
      target: [target.x, 1.2, target.z],
      fovY: FOV_Y,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    };
  }

  /** Renders a real frame from the camera. Returns a JPEG data URL. */
  /** The pose is worked out at render time, so it always matches the photo, even at a low frame rate. */
  captureFrame(getPose: () => CameraPose, onRendered?: () => void): Promise<{ dataUrl: string; pose: CameraPose }> {
    const run = this.captureChain.then(() => this.renderFrame(getPose, onRendered));
    this.captureChain = run.catch(() => undefined);
    return run;
  }

  // Uses its own offscreen target. Babylon's screenshot helper resizes the main canvas,
  // which collides with the render loop and leaves ghost trails on screen.
  private renderFrame(getPose: () => CameraPose, onRendered?: () => void): Promise<{ dataUrl: string; pose: CameraPose }> {
    return new Promise((resolve, reject) => {
      let pose: CameraPose;
      this.scene.onBeforeRenderObservable.addOnce(() => {
        pose = getPose();
        this.capture.fov = pose.fovY;
        this.capture.position.set(...pose.position);
        this.capture.setTarget(new Vector3(...pose.target));
        this.capture.getViewMatrix(true);
        // Rebuilt each time so cars that spawned since the last frame are included.
        this.frameTarget.renderList = this.scene.meshes.filter((m) => m.layerMask !== OVERLAY_LAYER && m.layerMask !== LABEL_LAYER);
        this.frameTarget.resetRefreshCounter();
      });
      this.scene.onAfterRenderObservable.addOnce(async () => {
        onRendered?.();
        try {
          const pixels = (await this.frameTarget.readPixels(0, 0, null, true)) as Uint8Array;
          resolve({ dataUrl: this.encodeJpeg(pixels), pose });
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private encodeJpeg(pixels: Uint8Array): string {
    const row = FRAME_WIDTH * 4;
    const image = this.encodeContext.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    // Render targets read bottom-up.
    for (let y = 0; y < FRAME_HEIGHT; y++) {
      const from = (FRAME_HEIGHT - 1 - y) * row;
      image.data.set(pixels.subarray(from, from + row), y * row);
    }
    this.encodeContext.putImageData(image, 0, 0);
    return this.encodeContext.canvas.toDataURL('image/jpeg', 0.85);
  }

  start(onFrame: (dt: number) => void) {
    this.engine.runRenderLoop(() => {
      onFrame(Math.min(this.engine.getDeltaTime() / 1000, 0.1));
      this.syncCars();
      this.syncPeopleAndLitter();
      this.updateChase();
      this.updateLights();
      this.scene.render();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }
}
