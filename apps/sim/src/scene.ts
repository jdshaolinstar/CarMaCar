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
} from '@babylonjs/core';
import { add, rightOf, scale, SPACING_X, SPACING_Z, type CameraPose, type CityMap, type StallState, type Vec2 } from '@carmacar/shared';
import type { LightState } from './signals';
import type { Car, World } from './world';

export type CameraView = 'city' | 'chase' | 'dash';

/** Everything on this layer is invisible to capture cameras, so overlays cannot leak into frames. */
const OVERLAY_LAYER = 0x10000000;
const WORLD_LAYER = 0x0fffffff;
/** Building labels: shown to people, hidden from capture cameras. */
const LABEL_LAYER = 0x20000000;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FOV_Y = 0.9;

const STATE_COLOR: Record<StallState, Color3> = {
  free: Color3.FromHexString('#1FA35C'),
  occupied: Color3.FromHexString('#D8392B'),
  unknown: Color3.FromHexString('#8D969C'),
};

const VARIANTS = [
  { length: 4.4, width: 1.8, deck: 0.92, cabin: 0.58, cabinLength: 2.3, cabinOffset: -0.15 },
  { length: 3.9, width: 1.75, deck: 0.95, cabin: 0.62, cabinLength: 2.2, cabinOffset: -0.45 },
  { length: 4.7, width: 1.95, deck: 1.1, cabin: 0.72, cabinLength: 2.9, cabinOffset: -0.35 },
  { length: 5.0, width: 1.95, deck: 1.2, cabin: 0.95, cabinLength: 3.9, cabinOffset: -0.45 },
];

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
  private readonly chase: FreeCamera;
  private readonly capture: FreeCamera;
  private readonly shadows: ShadowGenerator;
  private readonly carMeshes = new Map<string, InstancedMesh>();
  private readonly templates = new Map<string, Mesh>();
  private readonly stallMarkers = new Map<string, Mesh>();
  private readonly stallMaterials: Record<StallState, StandardMaterial>;
  private followId: string | null = null;
  private view: CameraView = 'city';
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
    hemi.intensity = 0.8;
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.35), this.scene);
    sun.position = new Vector3(120, 180, -100);
    sun.intensity = 0.62;
    this.shadows = new ShadowGenerator(4096, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.001;
    this.shadows.normalBias = 0.02;

    this.overview = new ArcRotateCamera('overview', -Math.PI / 2, 0.5, 330, new Vector3(30, 0, 0), this.scene);
    this.overview.lowerRadiusLimit = 40;
    this.overview.upperRadiusLimit = 460;
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
    this.capture.layerMask = WORLD_LAYER;

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
    this.buildBuildings();
    this.buildStalls();
    this.buildDestinationSigns();
    this.buildBuildingLabels();
    this.buildSignals();
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

    const addBuilding = (x: number, z: number, w: number, d: number) => {
      const h = 6 + ((n * 37) % 10);
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
    for (let i = 0; i < xLines.length - 1; i++) {
      for (let j = 0; j < zLines.length - 1; j++) fillBlock(xLines[i], xLines[i + 1], zLines[j], zLines[j + 1]);
    }

    palettes.forEach(([wall, glass], i) => {
      const parts = byPalette[i];
      if (parts.length === 0) return;
      const merged = Mesh.MergeMeshes(parts, true, true)!;
      const m = new StandardMaterial(`facade${i}`, this.scene);
      m.diffuseTexture = facadeTexture(this.scene, wall, glass);
      m.specularColor = new Color3(0.06, 0.06, 0.06);
      merged.material = m;
      merged.isPickable = false;
      this.shadows.addShadowCaster(merged);
    });
  }

  private buildStalls() {
    const white = this.solid('#f2f2f2');
    for (const s of this.city.stalls) {
      const rotation = Math.atan2(s.axis.x, s.axis.z);
      // Painted lines at each end of the stall: real paint that cameras see.
      for (const sign of [-0.5, 0.5]) {
        const end = add(s.center, scale(s.axis, sign * s.length));
        const line = MeshBuilder.CreateGround('stall-line', { width: s.width, height: 0.12 }, this.scene);
        line.position.set(end.x, 0.02, end.z);
        line.rotation.y = rotation;
        line.material = white;
        line.isPickable = false;
      }
      // The overlay only the overview camera can see.
      const marker = MeshBuilder.CreateGround(`stall-${s.id}`, { width: s.width * 0.9, height: s.length * 0.9 }, this.scene);
      marker.position.set(s.center.x, 0.06, s.center.z);
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
    for (const d of this.city.destinations) {
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
      const pos = add(d, scale(d.normal, 8));
      plate.position.set(pos.x, 26, pos.z);
      this.labels.push(plate);
    }
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

  private carTemplate(variant: number, hex: string): Mesh {
    const key = `${variant}${hex}`;
    const existing = this.templates.get(key);
    if (existing) return existing;
    const v = VARIANTS[variant % VARIANTS.length];
    const paint = Color3.FromHexString(hex).toColor4();
    const glass = Color3.FromHexString('#1f2933').toColor4();
    const dark = Color3.FromHexString('#16181a').toColor4();
    const lamp = Color3.FromHexString('#fff3c4').toColor4();
    const tail = Color3.FromHexString('#b3261e').toColor4();
    const parts: Mesh[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: Color4) => {
      const b = MeshBuilder.CreateBox('part', { width: w, height: h, depth: d, faceColors: Array(6).fill(color) }, this.scene);
      b.position.set(x, y, z);
      parts.push(b);
    };
    const bodyHeight = v.deck - 0.31;
    box(v.width, bodyHeight, v.length, 0, 0.31 + bodyHeight / 2, 0, paint);
    box(v.width * 0.9, v.cabin, v.cabinLength, 0, v.deck + v.cabin / 2, v.cabinOffset, glass);
    box(v.width * 0.86, 0.08, v.cabinLength * 0.92, 0, v.deck + v.cabin + 0.04, v.cabinOffset, paint);
    for (const sx of [-1, 1]) {
      box(0.32, 0.16, 0.05, sx * (v.width / 2 - 0.3), v.deck - 0.18, v.length / 2, lamp);
      box(0.32, 0.16, 0.05, sx * (v.width / 2 - 0.3), v.deck - 0.18, -v.length / 2, tail);
      for (const sz of [-1, 1]) {
        const wheel = MeshBuilder.CreateCylinder('wheel', { diameter: 0.66, height: 0.24, tessellation: 14, faceColors: Array(3).fill(dark) }, this.scene);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (v.width / 2 - 0.02), 0.33, sz * (v.length / 2 - 0.85));
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

  private syncCars() {
    for (const [id, mesh] of this.carMeshes) {
      if (!this.world.cars.has(id)) {
        this.shadows.removeShadowCaster(mesh);
        mesh.dispose();
        this.carMeshes.delete(id);
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
      mesh.position.set(car.pos.x, 0, car.pos.z);
      mesh.rotation.y = Math.atan2(car.heading.x, car.heading.z);
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

  private updateChase() {
    const car = this.followId ? this.world.cars.get(this.followId) : null;
    if (!car) return;
    if (this.view === 'dash') {
      const eye = add(car.pos, scale(car.heading, 2.7));
      this.chase.position.set(eye.x, 1.25, eye.z);
      const look = add(car.pos, scale(car.heading, 30));
      this.chase.setTarget(new Vector3(look.x, 1.1, look.z));
    } else {
      const eye = add(car.pos, scale(car.heading, -9));
      this.chase.position.set(eye.x, 4.2, eye.z);
      const look = add(car.pos, scale(car.heading, 10));
      this.chase.setTarget(new Vector3(look.x, 1.2, look.z));
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
  captureFrame(pose: CameraPose): Promise<string> {
    const run = this.captureChain.then(() => this.renderFrame(pose));
    this.captureChain = run.catch(() => undefined);
    return run;
  }

  // Uses its own offscreen target. Babylon's screenshot helper resizes the main canvas,
  // which collides with the render loop and leaves ghost trails on screen.
  private renderFrame(pose: CameraPose): Promise<string> {
    return new Promise((resolve, reject) => {
      this.capture.position.set(...pose.position);
      this.capture.setTarget(new Vector3(...pose.target));
      this.capture.getViewMatrix(true);
      // Rebuilt each time so cars that spawned since the last frame are included.
      this.frameTarget.renderList = this.scene.meshes.filter((m) => m.layerMask !== OVERLAY_LAYER && m.layerMask !== LABEL_LAYER);
      this.frameTarget.resetRefreshCounter();
      this.scene.onAfterRenderObservable.addOnce(async () => {
        try {
          const pixels = (await this.frameTarget.readPixels(0, 0, null, true)) as Uint8Array;
          resolve(this.encodeJpeg(pixels));
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
      this.updateChase();
      this.updateLights();
      this.scene.render();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }
}
