// The simulated city. Pure logic with no rendering and no vision.
// Truth about who is parked where lives here, and it stays in the browser.
import {
  add,
  distance,
  dot,
  RoadGraph,
  scale,
  sub,
  type CityMap,
  type DirectedEdge,
  type Path,
  type Stall,
  type Vec2,
} from '@carmacar/shared';

export type Role = 'parked' | 'scout' | 'network' | 'manual' | 'hero';
type Phase = 'drive' | 'parkIn' | 'parked' | 'parkOut';
type Mode = 'wander' | 'toStall' | 'cruise' | 'exit';

export interface Car {
  id: string;
  role: Role;
  variant: number;
  color: string;
  pos: Vec2;
  heading: Vec2;
  speed: number;
  phase: Phase;
  mode: Mode;
  edge: DirectedEdge;
  startAlong: number;
  path: Path | null;
  s: number;
  queue: DirectedEdge[];
  endsAtStall: boolean;
  stallId: string | null;
  targetStallId: string | null;
  destinationId: string | null;
  excludeStalls: string[];
  awaitingParking: boolean;
  parkT: number;
  parkFrom: Vec2;
  parkFromHeading: Vec2;
  leaveAt: number;
  spawnedAt: number;
  meters: number;
  metersSinceCapture: number;
  /** A follow-up stop for trips with several legs. */
  nextLegs: { destinationId: string; stayMinutes: number | null }[];
  tripId: string | null;
}

export interface ParkingService {
  find(carId: string, destinationId: string, from: Vec2, exclude: string[]): Promise<string | null>;
  release(carId: string): void;
}

export interface ParkedRecord {
  role: Role;
  seconds: number;
  meters: number;
  walkMeters: number;
}

export interface DemandItem {
  at: number;
  destinationId: string;
  startEdge: DirectedEdge;
  variant: number;
  color: string;
  onNetwork: boolean;
}

const CRUISE_SPEED = 11;
const FOLLOW_GAP = 8.5;
const PARK_SECONDS = 2.4;
const PARKED_MIN_SECONDS = 90;
const PARKED_MAX_SECONDS = 420;
export const CAR_COLORS = ['#c62828', '#1565c0', '#eceff1', '#212121', '#2e7d32', '#9e9e9e', '#f9a825', '#6a1b9a', '#37474f', '#ad1457'];

export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  readonly graph: RoadGraph;
  readonly cars = new Map<string, Car>();
  /** Ground truth: stall id to the car physically in it. */
  readonly stallOwner = new Map<string, string>();
  readonly stalls: Map<string, Stall>;
  readonly parkedLog: ParkedRecord[] = [];
  time = 0;
  private nextId = 1;
  private demand: DemandItem[] = [];
  private readonly rng: () => number;
  private scanTimer = 0;

  constructor(
    readonly city: CityMap,
    seed: number,
    private readonly parking: ParkingService | null,
  ) {
    this.graph = new RoadGraph(city);
    this.stalls = new Map(city.stalls.map((s) => [s.id, s]));
    this.rng = makeRng(seed);
  }

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rng() * list.length)];
  }

  private blankCar(role: Role, edge: DirectedEdge, variant: number, color: string): Car {
    const id = `${role[0]}${this.nextId++}`;
    const pos = this.graph.lanePoint(edge, this.graph.corner);
    const car: Car = {
      id,
      role,
      variant,
      color,
      pos,
      heading: this.graph.edgeDir(edge),
      speed: 0,
      phase: 'drive',
      mode: 'wander',
      edge,
      startAlong: this.graph.corner,
      path: null,
      s: 0,
      queue: [],
      endsAtStall: false,
      stallId: null,
      targetStallId: null,
      destinationId: null,
      excludeStalls: [],
      awaitingParking: false,
      parkT: 0,
      parkFrom: pos,
      parkFromHeading: { x: 1, z: 0 },
      leaveAt: Infinity,
      spawnedAt: this.time,
      meters: 0,
      metersSinceCapture: 0,
      nextLegs: [],
      tripId: null,
    };
    this.cars.set(id, car);
    return car;
  }

  private randomEdge(): DirectedEdge {
    const seg = this.pick(this.city.segments);
    return this.rng() < 0.5 ? { from: seg.a, to: seg.b } : { from: seg.b, to: seg.a };
  }

  /** Fills stalls with parked cars. */
  populateParked(fraction: number) {
    for (const stall of this.city.stalls) {
      if (this.rng() > fraction) continue;
      this.parkCarInStall(stall, this.pick([0, 0, 1, 2, 3]), this.pick(CAR_COLORS));
    }
  }

  /** Puts a stationary car in a stall. Also how the demo's "place a car" tool works. */
  parkCarInStall(stall: Stall, variant: number, color: string, permanent = false): Car | null {
    if (this.stallOwner.has(stall.id)) return null;
    const car = this.blankCar('parked', this.graph.approachEdge(stall), variant, color);
    car.phase = 'parked';
    car.stallId = stall.id;
    car.pos = stall.center;
    car.heading = this.graph.edgeDir(car.edge);
    car.leaveAt = permanent
      ? Infinity
      : this.time + PARKED_MIN_SECONDS + this.rng() * (PARKED_MAX_SECONDS - PARKED_MIN_SECONDS);
    this.stallOwner.set(stall.id, car.id);
    return car;
  }

  removeCarFromStall(stallId: string) {
    const id = this.stallOwner.get(stallId);
    if (id) this.cars.delete(id);
    this.stallOwner.delete(stallId);
  }

  addScouts(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(this.blankCar('scout', this.randomEdge(), 0, '#00acc1').id);
    }
    return ids;
  }

  addHero(): Car {
    return this.blankCar('hero', { from: 'n0_1', to: 'n1_1' }, 2, '#ff6d00');
  }

  setDemand(items: DemandItem[]) {
    this.demand = [...items].sort((a, b) => a.at - b.at);
  }

  /** Same seed, same drivers: the only thing that differs between runs is who is on the network. */
  static makeDemand(city: CityMap, seed: number, count: number, spanSeconds: number, networkShare: number): DemandItem[] {
    const rng = makeRng(seed);
    const items: DemandItem[] = [];
    for (let i = 0; i < count; i++) {
      const seg = city.segments[Math.floor(rng() * city.segments.length)];
      items.push({
        at: rng() * spanSeconds,
        destinationId: city.destinations[Math.floor(rng() * city.destinations.length)].id,
        startEdge: rng() < 0.5 ? { from: seg.a, to: seg.b } : { from: seg.b, to: seg.a },
        variant: Math.floor(rng() * 4),
        color: CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)],
        onNetwork: rng() < networkShare,
      });
    }
    return items;
  }

  private spawnDriver(item: DemandItem) {
    const car = this.blankCar(item.onNetwork ? 'network' : 'manual', item.startEdge, item.variant, item.color);
    car.destinationId = item.destinationId;
    car.mode = 'cruise';
    if (item.onNetwork) this.requestParking(car);
  }

  private requestParking(car: Car) {
    if (!this.parking || !car.destinationId || car.awaitingParking) return;
    car.awaitingParking = true;
    void this.parking.find(car.id, car.destinationId, car.pos, car.excludeStalls).then((stallId) => {
      car.awaitingParking = false;
      if (!this.cars.has(car.id) || car.phase !== 'drive') return;
      if (stallId) this.targetStall(car, stallId);
    });
  }

  /** Point a car at a stall. It re-plans at the next corner. */
  targetStall(car: Car, stallId: string) {
    car.targetStallId = stallId;
    car.mode = 'toStall';
    car.queue = [];
    this.planQueue(car);
  }

  private planQueue(car: Car) {
    const stall = car.targetStallId ? this.stalls.get(car.targetStallId) : null;
    if (!stall) return;
    const approach = this.graph.approachEdge(stall);
    const sameEdge = approach.from === car.edge.from && approach.to === car.edge.to;
    if (sameEdge && this.graph.alongApproach(stall) > car.startAlong + 2) {
      car.queue = [];
      return;
    }
    car.queue = this.graph.route(car.edge, approach).slice(1);
  }

  private nextEdge(car: Car): DirectedEdge {
    const options = this.graph.next(car.edge.to, car.edge.from);
    const destination = car.destinationId ? this.city.destinations.find((d) => d.id === car.destinationId) : null;
    if (car.mode === 'cruise' && destination) {
      // A driver heads for the destination, then circles nearby looking for a space.
      const ranked = options
        .map((e) => ({ e, d: distance(this.graph.node(e.to), destination) + this.rng() * 40 }))
        .sort((a, b) => a.d - b.d);
      return ranked[0].e;
    }
    return this.pick(options);
  }

  private beginPath(car: Car) {
    const stall = car.targetStallId ? this.stalls.get(car.targetStallId) : null;
    if (car.mode === 'toStall' && stall) {
      const approach = this.graph.approachEdge(stall);
      const onApproach = approach.from === car.edge.from && approach.to === car.edge.to;
      if (onApproach && car.queue.length === 0) {
        car.path = this.graph.buildPath([car.edge], car.startAlong, this.graph.alongApproach(stall));
        car.s = 0;
        car.endsAtStall = true;
        return;
      }
      if (car.queue.length === 0) this.planQueue(car);
    }
    const next = car.queue.shift() ?? this.nextEdge(car);
    car.path = this.graph.buildPath([car.edge, next], car.startAlong, this.graph.corner);
    car.s = 0;
    car.endsAtStall = false;
    car.queue = car.queue;
    this.pendingEdge.set(car.id, next);
  }

  private readonly pendingEdge = new Map<string, DirectedEdge>();

  private finishPath(car: Car) {
    if (car.endsAtStall) {
      const stallId = car.targetStallId!;
      if (this.stallOwner.has(stallId)) {
        // Got here and it was taken. A wrong map costs a driver time, so count it.
        car.excludeStalls.push(stallId);
        car.targetStallId = null;
        car.mode = 'cruise';
        car.startAlong = this.graph.alongApproach(this.stalls.get(stallId)!);
        this.parking?.release(car.id);
        if (car.role !== 'manual') this.requestParking(car);
      } else {
        this.startParking(car, stallId);
        return;
      }
    } else {
      const next = this.pendingEdge.get(car.id);
      if (next) {
        car.edge = next;
        car.startAlong = this.graph.corner;
      }
    }
    if (car.mode === 'exit' && car.meters > 220) {
      this.cars.delete(car.id);
      return;
    }
    this.beginPath(car);
  }

  private startParking(car: Car, stallId: string) {
    const stall = this.stalls.get(stallId)!;
    this.stallOwner.set(stallId, car.id);
    car.phase = 'parkIn';
    car.parkT = 0;
    car.parkFrom = car.pos;
    car.parkFromHeading = car.heading;
    car.stallId = stallId;
    car.path = null;
    car.speed = 0;
  }

  private finishParking(car: Car) {
    const stall = this.stalls.get(car.stallId!)!;
    car.phase = 'parked';
    car.pos = stall.center;
    const destination = this.city.destinations.find((d) => d.id === car.destinationId);
    if (car.role !== 'hero') {
      this.parkedLog.push({
        role: car.role,
        seconds: this.time - car.spawnedAt,
        meters: car.meters,
        walkMeters: destination ? distance(stall.center, destination) : 0,
      });
    }
    this.parking?.release(car.id);
    car.leaveAt = this.time + PARKED_MIN_SECONDS + this.rng() * (PARKED_MAX_SECONDS - PARKED_MIN_SECONDS);
    if (car.role === 'hero') car.leaveAt = this.time + 40;
  }

  private beginLeaving(car: Car) {
    car.phase = 'parkOut';
    car.parkT = 0;
    car.parkFrom = car.pos;
    car.parkFromHeading = car.heading;
  }

  private finishLeaving(car: Car) {
    const stall = this.stalls.get(car.stallId!)!;
    this.stallOwner.delete(stall.id);
    car.edge = this.graph.approachEdge(stall);
    car.startAlong = this.graph.alongApproach(stall) + 3;
    car.stallId = null;
    car.targetStallId = null;
    car.phase = 'drive';
    car.excludeStalls = [];
    car.path = null;
    car.meters = 0;
    const next = car.nextLegs.shift();
    if (next) {
      car.destinationId = next.destinationId;
      car.mode = 'cruise';
      car.spawnedAt = this.time;
      this.requestParking(car);
    } else {
      car.role = car.role === 'hero' ? 'hero' : car.role;
      car.mode = car.role === 'hero' ? 'wander' : 'exit';
    }
  }

  /** Human drivers only know what they can see: a free stall just ahead on their right. */
  private spotStall(car: Car) {
    const destination = this.city.destinations.find((d) => d.id === car.destinationId);
    if (!destination || !car.path) return;
    const seg = this.graph.segmentBetween(car.edge.from, car.edge.to);
    const along = dot(sub(car.pos, this.graph.node(car.edge.from)), this.graph.edgeDir(car.edge));
    if (along < 0 || along > seg.length - this.graph.corner) return;
    // The further they have driven, the less picky they get.
    const walkLimit = 80 + Math.max(0, car.meters - 300) * 0.5;
    let best: Stall | null = null;
    let bestAlong = Infinity;
    for (const stall of this.city.stalls) {
      if (stall.segmentId !== seg.id || this.stallOwner.has(stall.id)) continue;
      const approach = this.graph.approachEdge(stall);
      if (approach.from !== car.edge.from) continue;
      const stallAlong = this.graph.alongApproach(stall);
      if (stallAlong < along + 7 || stallAlong > along + 26) continue;
      if (distance(stall.center, destination) > walkLimit) continue;
      if (stallAlong < bestAlong) {
        bestAlong = stallAlong;
        best = stall;
      }
    }
    if (!best) return;
    car.targetStallId = best.id;
    car.path = this.graph.buildPath([car.edge], along, bestAlong);
    car.s = 0;
    car.endsAtStall = true;
    car.queue = [];
  }

  private gapAhead(car: Car): number {
    let nearest = Infinity;
    for (const other of this.cars.values()) {
      if (other === car || other.phase === 'parked') continue;
      const d = sub(other.pos, car.pos);
      const ahead = dot(d, car.heading);
      if (ahead <= 0 || ahead > FOLLOW_GAP * 2) continue;
      const lateral = Math.abs(d.x * car.heading.z - d.z * car.heading.x);
      if (lateral > 1.5) continue;
      if (dot(other.heading, car.heading) < 0) continue;
      nearest = Math.min(nearest, ahead);
    }
    return nearest;
  }

  tick(dt: number) {
    this.time += dt;
    while (this.demand.length > 0 && this.demand[0].at <= this.time) {
      this.spawnDriver(this.demand.shift()!);
    }

    this.scanTimer -= dt;
    const scanning = this.scanTimer <= 0;
    if (scanning) this.scanTimer = 0.5;

    for (const car of [...this.cars.values()]) {
      if (car.phase === 'parked') {
        if (this.time >= car.leaveAt) this.beginLeaving(car);
        continue;
      }
      if (car.phase === 'parkIn' || car.phase === 'parkOut') {
        car.parkT += dt / PARK_SECONDS;
        const stall = this.stalls.get(car.stallId!)!;
        const t = Math.min(car.parkT, 1);
        const smooth = t * t * (3 - 2 * t);
        const dir = this.graph.edgeDir(this.graph.approachEdge(stall));
        if (car.phase === 'parkIn') {
          car.pos = add(scale(car.parkFrom, 1 - smooth), scale(stall.center, smooth));
          car.heading = dir;
          if (t >= 1) this.finishParking(car);
        } else {
          const exit = add(stall.center, add(scale(stall.normal, -3), scale(dir, 3)));
          car.pos = add(scale(stall.center, 1 - smooth), scale(exit, smooth));
          if (t >= 1) this.finishLeaving(car);
        }
        continue;
      }

      if (!car.path) this.beginPath(car);
      const path = car.path;
      if (!path) continue;

      const gap = this.gapAhead(car);
      const limit = gap < FOLLOW_GAP ? Math.max(0, (gap - 5.5) * 1.2) : CRUISE_SPEED;
      car.speed += Math.sign(limit - car.speed) * Math.min(Math.abs(limit - car.speed), 6 * dt);
      const step = car.speed * dt;
      car.s += step;
      car.meters += step;
      car.metersSinceCapture += step;
      const { point, tangent } = path.sample(car.s);
      car.pos = point;
      car.heading = tangent;

      if (scanning && car.mode === 'cruise' && !car.endsAtStall && car.destinationId) this.spotStall(car);
      if (car.s >= path.length) this.finishPath(car);
    }
  }
}
