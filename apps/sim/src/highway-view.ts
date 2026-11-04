// Draws the ring highway. All of it stays disabled until the highway system is switched on, so the
// city, and every frame its cameras take, looks exactly the same without it.
import {
  Color3,
  DynamicTexture,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import {
  alongPolyline,
  DECK_HEIGHT,
  HighwayShape,
  LANE_WIDTH,
  polylineLength,
  surfaceSeconds,
  type CityMap,
  type HighwayLayout,
  type InterchangeShape,
  type RoadPoint,
} from '@carmacar/shared';
import type { HighwayCar, HighwaySim } from './highway';

/** Hidden from capture cameras, like the other overlays. */
const OVERLAY_LAYER = 0x10000000;
const SHOULDER = 1.3;
const RIGHT_EDGE = LANE_WIDTH * 1.5 + SHOULDER;
const LEFT_EDGE = -RIGHT_EDGE;
const RAMP_HALF_WIDTH = 3.3;
const STRIP_METERS = 20;
const MERGE_RIGHT = LANE_WIDTH * 2;
const LANE_SLIDE_SPEED = 1.8;
const TOWN_STREET_SPEED = 12;
const TREE_COUNT = 240;
export const TES_CAR_COLOR = '#19B5FF';
const CAR_COLORS = ['#c62828', '#eceff1', '#212121', '#2e7d32', '#9e9e9e', '#f9a825', '#6a1b9a', '#37474f', '#ad1457'];

const smooth = (t: number) => t * t * (3 - 2 * t);
const GROUND_ROAD = 0.18;
/** Ramps stay level until they clear the deck, then slope to the ground. */
const LEVEL_SHARE = 0.28;
const offRampHeight = (f: number) => GROUND_ROAD + (DECK_HEIGHT - GROUND_ROAD) * (1 - smooth(Math.min(1, Math.max(0, (f - LEVEL_SHARE) / (0.97 - LEVEL_SHARE)))));
const onRampHeight = (f: number) => offRampHeight(1 - f);

export interface HighwayCarPose {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
}

export class HighwayView {
  readonly shape: HighwayShape;
  readonly interchanges: InterchangeShape[];
  private readonly root: TransformNode;
  private readonly meshes = new Map<string, InstancedMesh>();
  private readonly laterals = new Map<string, number>();
  private readonly poses = new Map<string, HighwayCarPose>();
  private readonly strips: Mesh[] = [];
  private readonly stripColors: StandardMaterial[] = [];
  private readonly lamps: Mesh[] = [];
  private readonly lampRed: StandardMaterial;
  private readonly lampGreen: StandardMaterial;
  private readonly offLengths: number[];
  private readonly onLengths: number[];
  private stripClock = 0;

  constructor(
    private readonly scene: Scene,
    city: CityMap,
    readonly layout: HighwayLayout,
    private readonly carTemplate: (variant: number, color: string) => Mesh,
  ) {
    this.root = new TransformNode('highway', scene);
    this.shape = new HighwayShape(layout);
    const xs = city.nodes.map((n) => n.x);
    const zs = city.nodes.map((n) => n.z);
    const town = {
      minX: Math.min(...xs) - 84,
      maxX: Math.max(...xs) + 84,
      minZ: Math.min(...zs) - 72,
      maxZ: Math.max(...zs) + 72,
    };
    this.interchanges = layout.interchanges.map((ic) => this.shape.interchange(ic, town));
    this.offLengths = this.interchanges.map((s) => polylineLength(s.offRamp));
    this.onLengths = this.interchanges.map((s) => polylineLength(s.onRamp.slice(0, 29)));
    this.lampRed = this.lamp('#ff3b30');
    this.lampGreen = this.lamp('#35e07a');
    this.buildLand(town);
    this.buildMainline();
    this.buildRamps();
    this.buildSigns();
    this.buildTrafficStrip();
    this.root.setEnabled(false);
  }

  private material(hex: string) {
    const m = new StandardMaterial(`hw-${hex}`, this.scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(0.03, 0.03, 0.03);
    return m;
  }

  private lamp(hex: string) {
    const m = new StandardMaterial(`hw-lamp-${hex}`, this.scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.emissiveColor = Color3.FromHexString(hex);
    m.specularColor = Color3.Black();
    return m;
  }

  private adopt<T extends Mesh>(mesh: T) {
    mesh.parent = this.root;
    mesh.isPickable = false;
    return mesh;
  }

  private ribbon(name: string, a: Vector3[], b: Vector3[], material: StandardMaterial, closed = false) {
    const mesh = MeshBuilder.CreateRibbon(name, { pathArray: [a, b], closePath: closed, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    mesh.material = material;
    return this.adopt(mesh);
  }

  private buildLand(town: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    const grass = this.material('#5d8a4a');
    const size = 5000;
    const piece = (w: number, d: number, x: number, z: number) => {
      const g = MeshBuilder.CreateGround('hw-land', { width: w, height: d }, this.scene);
      g.position.set(x, 0.1, z);
      g.material = grass;
      this.adopt(g);
    };
    const half = size / 2;
    piece(half + town.minX, size, (-half + town.minX) / 2, 0);
    piece(half - town.maxX, size, (half + town.maxX) / 2, 0);
    piece(town.maxX - town.minX, half + town.minZ, (town.minX + town.maxX) / 2, (-half + town.minZ) / 2);
    piece(town.maxX - town.minX, half - town.maxZ, (town.minX + town.maxX) / 2, (half + town.maxZ) / 2);

    // Trees, kept clear of the roads. Fixed positions, so every run looks the same.
    const avoid: { x: number; z: number }[] = [];
    for (let s = 0; s < this.layout.length; s += 16) avoid.push(this.shape.at(s));
    for (const ic of this.interchanges) {
      avoid.push(...ic.offRamp, ...ic.onRamp);
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        avoid.push({ x: ic.junction.x + ((ic.townEnd.x - ic.junction.x) * i) / steps, z: ic.junction.z + ((ic.townEnd.z - ic.junction.z) * i) / steps });
      }
    }
    const crownMaterial = this.material('#3f7038');
    crownMaterial.diffuseColor = Color3.FromHexString('#3f7038');
    const crown = MeshBuilder.CreateIcoSphere('hw-tree', { radius: 3.4, subdivisions: 1, flat: true }, this.scene);
    crown.material = crownMaterial;
    crown.isVisible = false;
    this.adopt(crown);
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < TREE_COUNT; i++) {
      const x = (next() - 0.5) * 1000;
      const z = (next() - 0.5) * 840;
      const tall = 0.8 + next() * 0.9;
      if (x > town.minX - 6 && x < town.maxX + 6 && z > town.minZ - 6 && z < town.maxZ + 6) continue;
      if (avoid.some((p) => Math.hypot(p.x - x, p.z - z) < 15)) continue;
      const tree = crown.createInstance('hw-tree');
      tree.position.set(x, 3.2 * tall, z);
      tree.scaling.set(tall, tall * 1.3, tall);
      tree.parent = this.root;
      tree.isPickable = false;
    }
  }

  private inGap(s: number) {
    const { length, mergeLength } = this.layout;
    return this.layout.interchanges.some((ic) => {
      const fromOff = (s - ic.offAt + length) % length;
      const fromOn = (s - ic.onAt + length) % length;
      return fromOff < 75 || length - fromOff < 4 || fromOn < mergeLength + 8 || length - fromOn < 45;
    });
  }

  private buildMainline() {
    const { length, mergeLength, interchanges } = this.layout;
    const deck = this.material('#34383c');
    const concrete = this.material('#a7a9a4');
    const white = this.material('#eef0ec');
    white.emissiveColor = new Color3(0.2, 0.2, 0.2);
    const yellow = this.material('#e6c34a');
    yellow.emissiveColor = new Color3(0.15, 0.12, 0.03);

    const line = (right: number, y: number) => {
      const path: Vector3[] = [];
      for (let s = 0; s < length; s += 4) {
        const p = this.shape.at(s, right);
        path.push(new Vector3(p.x, y, p.z));
      }
      return path;
    };
    this.ribbon('hw-deck', line(LEFT_EDGE, DECK_HEIGHT), line(RIGHT_EDGE, DECK_HEIGHT), deck, true);
    this.ribbon('hw-underside', line(LEFT_EDGE, DECK_HEIGHT - 0.7), line(LEFT_EDGE, DECK_HEIGHT), concrete, true);
    this.ribbon('hw-left-wall', line(LEFT_EDGE, DECK_HEIGHT), line(LEFT_EDGE, DECK_HEIGHT + 0.9), concrete, true);
    this.ribbon('hw-edge-left', line(LEFT_EDGE + 1, DECK_HEIGHT + 0.03), line(LEFT_EDGE + 1.18, DECK_HEIGHT + 0.03), yellow, true);
    this.ribbon('hw-edge-right', line(RIGHT_EDGE - 1.18, DECK_HEIGHT + 0.03), line(RIGHT_EDGE - 1, DECK_HEIGHT + 0.03), white, true);

    // The right wall stops at each ramp, or cars would drive through it.
    let run: { low: Vector3[]; high: Vector3[] } = { low: [], high: [] };
    const flush = () => {
      if (run.low.length > 1) this.ribbon('hw-right-wall', run.low, run.high, concrete);
      run = { low: [], high: [] };
    };
    for (let s = 0; s <= length; s += 4) {
      if (this.inGap(s)) {
        flush();
        continue;
      }
      const p = this.shape.at(s, RIGHT_EDGE);
      run.low.push(new Vector3(p.x, DECK_HEIGHT, p.z));
      run.high.push(new Vector3(p.x, DECK_HEIGHT + 0.9, p.z));
    }
    flush();

    // Extra deck for each merge lane.
    for (const ic of interchanges) {
      const left: Vector3[] = [];
      const right: Vector3[] = [];
      for (let m = 0; m <= mergeLength + 30; m += 6) {
        const taper = m > mergeLength ? (m - mergeLength) / 30 : 0;
        const a = this.shape.at(ic.onAt + m, RIGHT_EDGE - 0.2);
        const b = this.shape.at(ic.onAt + m, RIGHT_EDGE + (MERGE_RIGHT - RIGHT_EDGE + LANE_WIDTH / 2) * (1 - taper));
        left.push(new Vector3(a.x, DECK_HEIGHT - 0.005, a.z));
        right.push(new Vector3(b.x, DECK_HEIGHT - 0.005, b.z));
      }
      this.ribbon('hw-merge', left, right, deck);
    }

    // Dashed lane lines, all merged into one mesh.
    const dashes: Mesh[] = [];
    for (const right of [LANE_WIDTH / 2, -LANE_WIDTH / 2]) {
      for (let s = 0; s < length; s += 13) {
        const p = this.shape.at(s, right);
        const dash = MeshBuilder.CreateBox('hw-dash', { width: 0.16, height: 0.02, depth: 4.5 }, this.scene);
        dash.position.set(p.x, DECK_HEIGHT + 0.03, p.z);
        dash.rotation.y = Math.atan2(p.tx, p.tz);
        dashes.push(dash);
      }
    }
    const lines = Mesh.MergeMeshes(dashes, true, true)!;
    lines.material = white;
    this.adopt(lines);

    // Pillars.
    const pillar = MeshBuilder.CreateCylinder('hw-pillar', { diameter: 1.7, height: DECK_HEIGHT, tessellation: 10 }, this.scene);
    pillar.material = concrete;
    pillar.isVisible = false;
    this.adopt(pillar);
    const beam = MeshBuilder.CreateBox('hw-beam', { width: 15, height: 0.9, depth: 2.2 }, this.scene);
    beam.material = concrete;
    beam.isVisible = false;
    this.adopt(beam);
    for (let s = 0; s < length; s += 42) {
      const p = this.shape.at(s);
      const side = { x: p.tz, z: -p.tx };
      for (const off of [-4.5, 4.5]) {
        const post = pillar.createInstance('hw-pillar');
        post.position.set(p.x + side.x * off, DECK_HEIGHT / 2, p.z + side.z * off);
        post.parent = this.root;
        post.isPickable = false;
      }
      const cap = beam.createInstance('hw-beam');
      cap.position.set(p.x, DECK_HEIGHT - 0.6, p.z);
      cap.rotation.y = Math.atan2(p.tx, p.tz);
      cap.parent = this.root;
      cap.isPickable = false;
    }
  }

  private buildRamps() {
    const deck = this.material('#3b3f43');
    const concrete = this.material('#a7a9a4');
    const street = this.material('#44484c');
    const pole = this.material('#30343a');

    const strip = (points: RoadPoint[], height: (i: number, f: number) => number) => {
      const left: Vector3[] = [];
      const right: Vector3[] = [];
      const wallL: Vector3[] = [];
      const wallR: Vector3[] = [];
      const topL: Vector3[] = [];
      const topR: Vector3[] = [];
      points.forEach((p, i) => {
        const side = { x: p.tz, z: -p.tx };
        const y = height(i, i / (points.length - 1));
        left.push(new Vector3(p.x - side.x * RAMP_HALF_WIDTH, y, p.z - side.z * RAMP_HALF_WIDTH));
        right.push(new Vector3(p.x + side.x * RAMP_HALF_WIDTH, y, p.z + side.z * RAMP_HALF_WIDTH));
        const wy = y + 0.8;
        wallL.push(left[i].clone());
        wallR.push(right[i].clone());
        topL.push(new Vector3(left[i].x, wy, left[i].z));
        topR.push(new Vector3(right[i].x, wy, right[i].z));
      });
      this.ribbon('hw-ramp', left, right, deck);
      this.ribbon('hw-ramp-wall', wallL, topL, concrete);
      this.ribbon('hw-ramp-wall', wallR, topR, concrete);
    };

    this.interchanges.forEach((shape, i) => {
      strip(shape.offRamp, (_k, f) => offRampHeight(f));
      const rise = shape.onRamp.slice(0, 29);
      strip(rise, (_k, f) => onRampHeight(f));

      const width = 5;
      const dx = shape.townEnd.x - shape.junction.x;
      const dz = shape.townEnd.z - shape.junction.z;
      const length = Math.hypot(dx, dz) || 1;
      const side = { x: (dz / length) * width, z: (-dx / length) * width };
      const a = [new Vector3(shape.junction.x - side.x, 0.14, shape.junction.z - side.z), new Vector3(shape.townEnd.x - side.x, 0.14, shape.townEnd.z - side.z)];
      const b = [new Vector3(shape.junction.x + side.x, 0.14, shape.junction.z + side.z), new Vector3(shape.townEnd.x + side.x, 0.14, shape.townEnd.z + side.z)];
      this.ribbon('hw-town-street', a, b, street);

      const stop = shape.offRamp[shape.offRamp.length - 1];
      const mast = MeshBuilder.CreateCylinder('hw-signal-pole', { diameter: 0.24, height: 5.4 }, this.scene);
      mast.position.set(stop.x + stop.tz * 4.2, 2.7, stop.z - stop.tx * 4.2);
      mast.material = pole;
      this.adopt(mast);
      const lamp = MeshBuilder.CreateSphere('hw-signal', { diameter: 1.1, segments: 8 }, this.scene);
      lamp.position.set(stop.x + stop.tz * 4.2, 5.7, stop.z - stop.tx * 4.2);
      lamp.material = this.lampRed;
      this.adopt(lamp);
      this.lamps[i] = lamp;
    });
  }

  private buildSigns() {
    const steel = this.material('#6c7176');
    for (const ic of this.layout.interchanges) {
      const p = this.shape.at(ic.offAt - 150);
      const heading = Math.atan2(p.tx, p.tz);
      const side = { x: p.tz, z: -p.tx };
      for (const off of [-8, 8]) {
        const post = MeshBuilder.CreateCylinder('hw-gantry', { diameter: 0.4, height: 6.5 }, this.scene);
        post.position.set(p.x + side.x * off, DECK_HEIGHT + 3.25, p.z + side.z * off);
        post.material = steel;
        this.adopt(post);
      }
      const texture = new DynamicTexture(`hw-sign-${ic.id}`, { width: 512, height: 128 }, this.scene, true);
      const ctx = texture.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = '#0d6b3a';
      ctx.fillRect(0, 0, 512, 128);
      ctx.strokeStyle = '#f4f5f2';
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, 496, 112);
      ctx.fillStyle = '#f4f5f2';
      ctx.font = '800 58px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`Exit ${ic.id + 1}  ${ic.name}`, 256, 84);
      texture.update();
      const material = new StandardMaterial(`hw-sign-${ic.id}`, this.scene);
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.specularColor = Color3.Black();
      const plate = MeshBuilder.CreatePlane(`hw-sign-${ic.id}`, { width: 17, height: 4.25, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
      plate.position.set(p.x, DECK_HEIGHT + 6.6, p.z);
      plate.rotation.y = heading;
      plate.material = material;
      this.adopt(plate);
    }
  }

  /** A band along the road that shows live speed from above. For people, not for cameras. */
  private buildTrafficStrip() {
    this.stripColors.push(this.lamp('#35e07a'), this.lamp('#f2b90f'), this.lamp('#ff3b30'));
    const count = Math.floor(this.layout.length / STRIP_METERS);
    for (let i = 0; i < count; i++) {
      const p = this.shape.at((i + 0.5) * STRIP_METERS, LEFT_EDGE - 1.6);
      const strip = MeshBuilder.CreateGround('hw-strip', { width: 2.2, height: STRIP_METERS - 1 }, this.scene);
      strip.position.set(p.x, DECK_HEIGHT + 0.1, p.z);
      strip.rotation.y = Math.atan2(p.tx, p.tz);
      strip.material = this.stripColors[0];
      strip.layerMask = OVERLAY_LAYER;
      this.adopt(strip);
      this.strips.push(strip);
    }
  }

  setEnabled(on: boolean) {
    this.root.setEnabled(on);
  }

  private updateStrip(sim: HighwaySim) {
    const totals = this.strips.map(() => ({ speed: 0, cars: 0 }));
    for (const car of sim.cars) {
      if (car.place !== 'main') continue;
      const bucket = totals[Math.floor(car.s / STRIP_METERS) % totals.length];
      bucket.speed += car.v;
      bucket.cars++;
    }
    const limit = sim.config.speedLimit;
    totals.forEach((t, i) => {
      const share = t.cars ? t.speed / t.cars / limit : 1;
      this.strips[i].material = this.stripColors[share > 0.7 ? 0 : share > 0.4 ? 1 : 2];
    });
  }

  private poseOf(car: HighwayCar, sim: HighwaySim, dt: number): HighwayCarPose | null {
    const { rampLength, mergeLength } = this.layout;
    if (car.place === 'main') {
      const target = (1 - car.lane) * LANE_WIDTH;
      const current = this.laterals.get(car.id) ?? target;
      const step = Math.max(-LANE_SLIDE_SPEED * dt, Math.min(LANE_SLIDE_SPEED * dt, target - current));
      const right = current + step;
      this.laterals.set(car.id, right);
      const p = this.shape.at(car.s, right);
      return { x: p.x, y: DECK_HEIGHT + 0.04, z: p.z, tx: p.tx, tz: p.tz };
    }
    if (car.place === 'onramp') {
      const ic = this.layout.interchanges[car.entry];
      if (car.s >= rampLength) {
        this.laterals.set(car.id, MERGE_RIGHT);
        const p = this.shape.at(ic.onAt + Math.min(car.s - rampLength, mergeLength), MERGE_RIGHT);
        return { x: p.x, y: DECK_HEIGHT + 0.04, z: p.z, tx: p.tx, tz: p.tz };
      }
      const shape = this.interchanges[car.entry];
      const f = car.s / rampLength;
      const p = alongPolyline(shape.onRamp.slice(0, 29), f * this.onLengths[car.entry]);
      return { x: p.x, y: onRampHeight(f) + 0.02, z: p.z, tx: p.tx, tz: p.tz };
    }
    if (car.place === 'offramp') {
      const shape = this.interchanges[car.exit];
      const f = Math.min(1, car.s / rampLength);
      const p = alongPolyline(shape.offRamp, f * this.offLengths[car.exit]);
      return { x: p.x, y: offRampHeight(f) + 0.02, z: p.z, tx: p.tx, tz: p.tz };
    }
    if (car.place === 'surface') {
      // Cars carry on down the street to town and leave the highway model at the edge of it.
      const shape = this.interchanges[car.exit];
      const started = car.doneAt - surfaceSeconds(this.layout, car.zone, car.exit);
      const gone = (sim.time - started) * TOWN_STREET_SPEED;
      const dx = shape.townEnd.x - shape.junction.x;
      const dz = shape.townEnd.z - shape.junction.z;
      const length = Math.hypot(dx, dz) || 1;
      if (gone > length) return null;
      return { x: shape.junction.x + (dx / length) * gone, y: 0.16, z: shape.junction.z + (dz / length) * gone, tx: dx / length, tz: dz / length };
    }
    return null;
  }

  /** Where a car is drawn right now, so a camera can follow it. */
  pose(carId: string) {
    return this.poses.get(carId) ?? null;
  }

  sync(sim: HighwaySim, dt: number) {
    this.poses.clear();
    for (const car of sim.cars) {
      const pose = this.poseOf(car, sim, dt);
      let mesh = this.meshes.get(car.id);
      if (!pose) {
        if (mesh) {
          mesh.dispose();
          this.meshes.delete(car.id);
          this.laterals.delete(car.id);
        }
        continue;
      }
      if (!mesh) {
        const number = Number(car.id.slice(1));
        const color = car.driver === 'human' ? CAR_COLORS[number % CAR_COLORS.length] : TES_CAR_COLOR;
        mesh = this.carTemplate(number % 4, color).createInstance(`hw-${car.id}`);
        mesh.isPickable = false;
        mesh.parent = this.root;
        this.meshes.set(car.id, mesh);
      }
      mesh.position.set(pose.x, pose.y, pose.z);
      mesh.rotation.y = Math.atan2(pose.tx, pose.tz);
      this.poses.set(car.id, pose);
    }
    this.lamps.forEach((lamp, i) => (lamp.material = sim.rampIsGreen(i) ? this.lampGreen : this.lampRed));
    this.stripClock += dt;
    if (this.stripClock >= 1) {
      this.stripClock = 0;
      this.updateStrip(sim);
    }
  }

  clearCars() {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.laterals.clear();
    this.poses.clear();
  }
}
