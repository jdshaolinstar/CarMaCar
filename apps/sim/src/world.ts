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
  type TripPlan,
  type TwinSnapshot,
  type Vec2,
} from '@carmacar/shared';
import { movementOf, movementsConflict, Signals, type Movement } from './signals';

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
  /** Distance along the current path of the next stop line. Infinity when there is none. */
  stopS: number;
  movement: Movement | null;
  /** The intersection this car is inside. */
  junction: string | null;
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
  /** The driver is done with their reservation. This does not tell the platform the stall's state. */
  arrived(carId: string): void;
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
const APPROACH_SPEED = 4.5;
const APPROACH_DISTANCE = 30;
/** Center-to-center distance kept behind the car ahead. */
const FOLLOW_GAP = 6.5;
const GAP_LOOKAHEAD = 24;
const GAP_STEP = 1.5;
const STOP_LOOKAHEAD = 40;
const STOP_LINE_SETBACK = 1;
const ACCELERATION = 3;
const COMFORT_BRAKING = 4;
const HARD_BRAKING = 8;

const CLAIM_MARGIN = 2;

const stoppingDistance = (speed: number) => (speed * speed) / (2 * COMFORT_BRAKING);

/** Fastest speed from which a car can still stop within `distance` metres. */
const brakingSpeed = (distance: number) => Math.sqrt(2 * COMFORT_BRAKING * Math.max(0, distance));
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
  readonly signals: Signals;
  /** Node id to the cars currently inside that intersection. */
  private readonly junctions = new Map<string, Set<string>>();
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
    this.signals = new Signals(city);
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
      stopS: Infinity,
      movement: null,
      junction: null,
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
      let edge = this.randomEdge();
      for (let tries = 0; tries < 20 && !this.laneClear(this.graph.lanePoint(edge, this.graph.corner), 9); tries++) {
        edge = this.randomEdge();
      }
      ids.push(this.blankCar('scout', edge, 0, '#00acc1').id);
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

  /** Abandons a final approach. The car keeps rolling to the end of its path, then carries on down the street. */
  private leaveFinalApproach(car: Car) {
    const stall = car.endsAtStall && car.targetStallId ? this.stalls.get(car.targetStallId) : null;
    if (!stall) return;
    car.endsAtStall = false;
    this.pendingEdge.delete(car.id);
    car.startAlong = this.graph.alongApproach(stall);
  }

  /** Point a car at a stall. It re-plans at the next corner. */
  targetStall(car: Car, stallId: string) {
    this.leaveFinalApproach(car);
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
    car.stopS = Infinity;
    car.movement = null;
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
    this.pendingEdge.set(car.id, next);
    if (this.signals.has(car.edge.to)) {
      const stopAlong = this.graph.edgeLength(car.edge) - this.graph.corner - STOP_LINE_SETBACK;
      car.stopS = Math.max(0, stopAlong - car.startAlong);
      car.movement = movementOf(this.graph.edgeDir(car.edge), this.graph.edgeDir(next));
    }
  }

  private readonly pendingEdge = new Map<string, DirectedEdge>();

  private finishPath(car: Car) {
    this.leaveJunction(car);
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
    this.parking?.arrived(car.id);
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
      car.mode = car.role === 'hero' ? 'wander' : 'exit';
    }
  }

  /** Reacts to the platform's map: network cars drop stalls cameras say are taken and retry when unassigned. */
  syncWithTwin(twin: TwinSnapshot) {
    for (const car of this.cars.values()) {
      if (car.role !== 'network' || car.phase !== 'drive') continue;
      if (car.targetStallId) {
        const stall = twin.stalls[car.targetStallId];
        if (stall && stall.reservedBy !== car.id) {
          this.leaveFinalApproach(car);
          car.excludeStalls.push(car.targetStallId);
          car.targetStallId = null;
          car.mode = 'cruise';
          this.requestParking(car);
        }
      } else {
        this.requestParking(car);
      }
    }
  }

  /** Applies a trip plan from the agent to a car. */
  applyPlan(car: Car, plan: TripPlan) {
    const [first, ...rest] = plan.legs;
    if (!first) return;
    car.tripId = plan.tripId;
    car.destinationId = first.destinationId;
    car.nextLegs = rest.map((leg) => ({ destinationId: leg.destinationId, stayMinutes: leg.stayMinutes }));
    if (car.phase === 'parked') {
      this.beginLeaving(car);
      car.nextLegs.unshift({ destinationId: first.destinationId, stayMinutes: first.stayMinutes });
      return;
    }
    if (first.stallId) this.targetStall(car, first.stallId);
    else {
      car.mode = 'cruise';
      this.requestParking(car);
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

  /** Distance to the nearest car on the road this car is about to drive, following its path around corners. */
  private gapAhead(car: Car): number {
    const path = car.path;
    if (!path) return Infinity;
    const nearby = [...this.cars.values()].filter(
      (other) => other !== car && other.phase !== 'parked' && distance(other.pos, car.pos) < GAP_LOOKAHEAD + 5,
    );
    if (nearby.length === 0) return Infinity;
    const end = path.sample(path.length);
    for (let ahead = GAP_STEP; ahead <= GAP_LOOKAHEAD; ahead += GAP_STEP) {
      const along = car.s + ahead;
      const beyond = along - path.length;
      // Past the end of this path the car carries straight on into its next street.
      const point = beyond > 0 ? add(end.point, scale(end.tangent, beyond)) : path.sample(along).point;
      for (const other of nearby) {
        // A car pulling out of a stall is about to be in this lane, so give it room.
        const reach = other.phase === 'parkOut' ? 4.5 : 1.9;
        if (distance(other.pos, point) < reach) return ahead;
      }
    }
    return Infinity;
  }

  private mayEnterJunction(car: Car, toStopLine: number): boolean {
    const nodeId = car.edge.to;
    const direction = this.graph.edgeDir(car.edge);
    const light = this.signals.state(nodeId, direction, this.time);
    // On yellow, a car too close to stop safely carries on.
    if (light === 'red' || (light === 'yellow' && stoppingDistance(car.speed) < toStopLine)) return false;
    const mine = car.movement;
    if (!mine) return true;
    for (const id of this.junctions.get(nodeId) ?? []) {
      const other = this.cars.get(id);
      if (other?.movement && movementsConflict(mine, other.movement)) return false;
    }
    return true;
  }

  private enterJunction(car: Car) {
    const nodeId = car.edge.to;
    const inside = this.junctions.get(nodeId) ?? new Set<string>();
    inside.add(car.id);
    this.junctions.set(nodeId, inside);
    car.junction = nodeId;
  }

  private leaveJunction(car: Car) {
    if (car.junction) this.junctions.get(car.junction)?.delete(car.id);
    car.junction = null;
  }

  /** Whether a stretch of lane is clear enough to pull out or spawn into. */
  private laneClear(point: Vec2, radius: number, ignore?: Car): boolean {
    for (const other of this.cars.values()) {
      if (other !== ignore && other.phase !== 'parked' && distance(other.pos, point) < radius) return false;
    }
    return true;
  }

  tick(dt: number) {
    this.time += dt;
    while (this.demand.length > 0 && this.demand[0].at <= this.time) {
      const item = this.demand[0];
      // Join the road only where there is room. Otherwise wait for the next tick.
      if (!this.laneClear(this.graph.lanePoint(item.startEdge, this.graph.corner), 9)) break;
      this.spawnDriver(this.demand.shift()!);
    }

    this.scanTimer -= dt;
    const scanning = this.scanTimer <= 0;
    if (scanning) this.scanTimer = 0.5;

    for (const car of [...this.cars.values()]) {
      if (car.phase === 'parked') {
        // Wait for a gap before pulling out into the lane.
        if (this.time >= car.leaveAt && this.laneClear(car.pos, 18, car)) this.beginLeaving(car);
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

      // Drivers slow down when they near their spot, which also gives cameras time to look at it.
      const nearingStall = car.endsAtStall && path.length - car.s < APPROACH_DISTANCE;
      let limit = nearingStall ? APPROACH_SPEED : CRUISE_SPEED;
      limit = Math.min(limit, brakingSpeed(this.gapAhead(car) - FOLLOW_GAP));

      const toStopLine = car.stopS - car.s;
      if (!car.junction && toStopLine < STOP_LOOKAHEAD) {
        // Commit at the last point the car could still stop, so nothing can cut in after that.
        const atBrakingPoint = toStopLine <= stoppingDistance(car.speed) + CLAIM_MARGIN;
        const clear = this.mayEnterJunction(car, toStopLine);
        if (clear && atBrakingPoint) this.enterJunction(car);
        else if (!clear) limit = Math.min(limit, brakingSpeed(toStopLine));
      }

      const change = limit - car.speed;
      car.speed += Math.sign(change) * Math.min(Math.abs(change), (change > 0 ? ACCELERATION : HARD_BRAKING) * dt);
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
