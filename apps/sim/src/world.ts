// The simulated city. Pure logic with no rendering and no vision.
// Truth about who is parked where lives here, and it stays in the browser.
import {
  add,
  distance,
  dot,
  rightOf,
  RoadGraph,
  scale,
  sub,
  type CityMap,
  type DirectedEdge,
  type Garage,
  Path,
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
  /** Garage floor this car is on. Zero is street level. */
  level: number;
  insideGarage: boolean;
  garageLegs: GarageLeg[];
  /** Seconds left on the transporter. */
  liftT: number;
  liftFrom: number;
  /** Waiting for a safe landing on this floor. */
  pendingLift: number | null;
  waitingToMerge: Vec2 | null;
  /** Pulling out of a garage. Street traffic gives way. */
  merging: boolean;
  mergedAt: number;
  /** Set while a person is driving this car. */
  control: { throttle: number; steer: number } | null;
  spawnedAt: number;
  meters: number;
  metersSinceCapture: number;
  /** A follow-up stop for trips with several legs. */
  nextLegs: { destinationId: string; stayMinutes: number | null }[];
  tripId: string | null;
}

export interface GarageLeg {
  path: Path;
  level: number;
  /** Ride the transporter to this leg's level before driving it. */
  lift?: boolean;
  /** The last leg, out onto the street. Waits for a gap in traffic first. */
  merge?: boolean;
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
const GARAGE_SPEED = 5;
const GARAGE_LANE_OFFSET = 1.6;
const GARAGE_MERGE_AHEAD = 8;
export const LIFT_SECONDS = 1.6;
const PAD_REACH = 5;
const LANDING_LENGTH = 6;
/** Street traffic covers this in about 3 seconds, the time a car takes to pull out. */
const MERGE_GAP = 36;
const HUB_RADIUS = 9;
const AISLE_CLEARANCE = 13;
const PULL_OUT_GAP = 26;

const MANUAL_ACCELERATION = 5;
const MANUAL_BRAKING = 10;
const MANUAL_COASTING = 1.5;
const MANUAL_TOP_SPEED = 15;
const MANUAL_REVERSE_SPEED = 5;
const MANUAL_STEERING = 0.6;
const WHEELBASE = 2.7;
const CAR_RADIUS = 1.05;
const DRIVER_HALF_WIDTH = 1;

const stoppingDistance = (speed: number) => (speed * speed) / (2 * COMFORT_BRAKING);

/** Fastest speed from which a car can still stop within `distance` metres. */
const brakingSpeed = (distance: number) => Math.sqrt(2 * COMFORT_BRAKING * Math.max(0, distance));
const PARK_SECONDS = 2.4;
const PARKED_MIN_SECONDS = 90;
const PARKED_MAX_SECONDS = 420;
const LIVE_PARKED_MIN_SECONDS = 25;
const LIVE_PARKED_MAX_SECONDS = 500;
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
  /** Garage and level to the car currently crossing that hub. */
  private readonly hubTurns = new Map<string, string>();
  time = 0;
  /** Live city: cars take new trips instead of leaving. The adoption study keeps this off. */
  keepCarsInCity = false;
  /** Share of cars that use the parking network. */
  networkShare = 0.7;
  /** System switch: new background drivers and cars pulling out. */
  driversEnabled = true;
  /** System switch: the platform directs network cars to stalls. */
  guidance = true;
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

  private parkedSeconds() {
    const min = this.keepCarsInCity ? LIVE_PARKED_MIN_SECONDS : PARKED_MIN_SECONDS;
    const max = this.keepCarsInCity ? LIVE_PARKED_MAX_SECONDS : PARKED_MAX_SECONDS;
    return min + this.rng() * (max - min);
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
      level: 0,
      insideGarage: false,
      garageLegs: [],
      liftT: 0,
      liftFrom: 0,
      pendingLift: null,
      waitingToMerge: null,
      merging: false,
      mergedAt: -Infinity,
      control: null,
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
    car.heading = stall.garageId ? stall.normal : this.graph.edgeDir(car.edge);
    car.level = stall.level ?? 0;
    car.insideGarage = !!stall.garageId;
    car.leaveAt = permanent ? Infinity : this.time + this.parkedSeconds();
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

  /** Adds or removes survey cars to reach a count. */
  setScoutCount(count: number) {
    const scouts = [...this.cars.values()].filter((c) => c.role === 'scout');
    if (scouts.length < count) this.addScouts(count - scouts.length);
    for (const car of scouts.slice(count)) {
      this.leaveJunction(car);
      this.cars.delete(car.id);
    }
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
    const onNetwork = this.keepCarsInCity ? this.rng() < this.networkShare : item.onNetwork;
    const car = this.blankCar(onNetwork ? 'network' : 'manual', item.startEdge, item.variant, item.color);
    car.destinationId = item.destinationId;
    car.mode = 'cruise';
    if (item.onNetwork) this.requestParking(car);
  }

  private requestParking(car: Car) {
    if (!this.parking || !this.guidance || !car.destinationId || car.awaitingParking) return;
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
    if (car.insideGarage) return; // Already committed to this garage.
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
    // A car mid-block is already committed to its next street, so the route has to start there.
    // Starting from the current street gives a queue that does not connect to where the car ends up.
    const committed = car.path && !car.endsAtStall ? this.pendingEdge.get(car.id) : undefined;
    const from = committed ?? car.edge;
    const fromAlong = committed ? this.graph.corner : car.startAlong;
    const sameEdge = approach.from === from.from && approach.to === from.to;
    if (sameEdge && this.graph.alongApproach(stall) > fromAlong + 2) {
      car.queue = [];
      return;
    }
    car.queue = this.graph.route(from, approach).slice(1);
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
    if (car.garageLegs.length > 0) {
      this.nextGarageLeg(car);
      return;
    }
    if (car.insideGarage && !car.endsAtStall) {
      // Out of the garage and back in the lane.
      car.insideGarage = false;
      car.merging = false;
      car.mergedAt = this.time;
      this.beginPath(car);
      return;
    }
    const arrivingAt = car.endsAtStall && car.targetStallId ? this.stalls.get(car.targetStallId) : null;
    if (arrivingAt?.garageId && !car.insideGarage) {
      // Reached the door: turn in.
      car.insideGarage = true;
      car.garageLegs = this.entryLegs(this.garageOf(arrivingAt), arrivingAt, car.pos);
      this.nextGarageLeg(car);
      return;
    }
    if (arrivingAt?.garageId && this.stallOwner.has(arrivingAt.id)) {
      const g = this.garageOf(arrivingAt);
      const other = this.city.stalls.find((s) => s.garageId === g.id && (s.level ?? 0) === car.level && !this.stallOwner.has(s.id));
      this.parking?.release(car.id);
      if (other) {
        car.targetStallId = other.id;
        car.path = Path.from([car.pos, this.aislePoint(g, other, false)]);
        car.s = 0;
      } else {
        car.targetStallId = null;
        car.mode = 'cruise';
        this.leaveGarage(car, arrivingAt);
      }
      return;
    }
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
        this.pendingEdge.delete(car.id);
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
    car.leaveAt = this.time + this.parkedSeconds();
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
    // A driver at the keyboard finds their own way out.
    if (stall.garageId && !car.control) this.leaveGarage(car, stall);
    const next = car.nextLegs.shift();
    if (next) {
      car.destinationId = next.destinationId;
      car.mode = 'cruise';
      car.spawnedAt = this.time;
      this.requestParking(car);
    } else if (car.role === 'hero') {
      car.mode = 'wander';
    } else if (this.keepCarsInCity) {
      this.startNewTrip(car);
    } else {
      car.mode = 'exit';
    }
  }

  /** A car that has finished one trip picks another, so the city keeps moving. */
  private startNewTrip(car: Car) {
    car.role = this.rng() < this.networkShare ? 'network' : 'manual';
    car.destinationId = this.pick(this.city.destinations).id;
    car.mode = 'cruise';
    car.spawnedAt = this.time;
    if (car.role === 'network') this.requestParking(car);
  }

  /** Reacts to the platform's map: network cars drop stalls cameras say are taken and retry when unassigned. */
  syncWithTwin(twin: TwinSnapshot) {
    if (!this.guidance) return;
    for (const car of this.cars.values()) {
      if (car.role !== 'network' || car.phase !== 'drive' || car.insideGarage) continue;
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
      car.leaveAt = this.time;
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
      if (stall.garageId || stall.segmentId !== seg.id || this.stallOwner.has(stall.id)) continue;
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

  // Garages. Cars follow a short list of legs: door to transporter, up, then along the aisle.

  private garageOf(stall: Stall): Garage {
    return this.graph.garage(stall.garageId!);
  }

  /** Point in the entry spine's lane, on the right of a car heading in or out. */
  private spinePoint(g: Garage, base: Vec2, headingIn: boolean): Vec2 {
    const heading = headingIn ? g.inward : scale(g.inward, -1);
    return add(base, scale(rightOf(heading), GARAGE_LANE_OFFSET));
  }

  /** Point in the aisle lane beside a stall, for a car heading toward or away from the hub. */
  private aislePoint(g: Garage, stall: Stall, towardHub: boolean): Vec2 {
    const u = dot(sub(stall.center, g.hub), g.aisle);
    const direction = Math.sign(u) * (towardHub ? -1 : 1);
    const heading = scale(g.aisle, direction);
    return add(add(g.hub, scale(g.aisle, u)), scale(rightOf(heading), GARAGE_LANE_OFFSET));
  }

  private entryLegs(g: Garage, stall: Stall, from: Vec2): GarageLeg[] {
    const level = stall.level ?? 0;
    const spineIn = (p: Vec2) => this.spinePoint(g, p, true);
    const toPad = [from, spineIn(g.door), spineIn(g.pad)];
    const aisle = this.aislePoint(g, stall, false);
    const toStall = [spineIn(g.pad), spineIn(g.hub), this.aisleEntry(g, stall, false), aisle];
    if (level === 0) return [{ path: Path.from([...toPad, ...toStall.slice(1)]), level: 0 }];
    return [{ path: Path.from(toPad), level: 0 }, { path: Path.from(toStall), level, lift: true }];
  }

  /** Where a car settles into its aisle lane just off the hub, so it never drifts across the aisle. */
  private aisleEntry(g: Garage, stall: Stall, towardHub: boolean): Vec2 {
    const lane = this.aislePoint(g, stall, towardHub);
    const u = dot(sub(stall.center, g.hub), g.aisle);
    return add(lane, scale(g.aisle, -u + Math.sign(u) * 3.5));
  }

  private exitLegs(g: Garage, from: Vec2, level: number, merge: Vec2, stall: Stall): GarageLeg[] {
    const spineOut = (p: Vec2) => this.spinePoint(g, p, false);
    const toPad = [from, this.aisleEntry(g, stall, true), spineOut(g.hub), spineOut(g.pad)];
    const toDoor = [spineOut(g.pad), spineOut(g.door)];
    const leaveLeg: GarageLeg = { path: Path.from([spineOut(g.door), merge]), level: 0, merge: true };
    if (level === 0) return [{ path: Path.from([...toPad, ...toDoor.slice(1)]), level: 0 }, leaveLeg];
    return [{ path: Path.from(toPad), level }, { path: Path.from(toDoor), level: 0, lift: true }, leaveLeg];
  }

  private nextGarageLeg(car: Car) {
    const leg = car.garageLegs.shift()!;
    car.path = leg.path;
    car.s = 0;
    if (leg.lift) car.pendingLift = leg.level;
    if (leg.merge) car.waitingToMerge = leg.path.points[leg.path.points.length - 1];
  }

  private leaveGarage(car: Car, stall: Stall) {
    const g = this.garageOf(stall);
    car.edge = this.graph.approachEdge(stall);
    car.startAlong = g.entryAlong + GARAGE_MERGE_AHEAD;
    car.garageLegs = this.exitLegs(g, car.pos, car.level, this.graph.lanePoint(car.edge, car.startAlong), stall);
    car.endsAtStall = false;
    this.nextGarageLeg(car);
  }

  /**
   * Whether a car can land on another floor without hitting anyone in its own lane.
   * Only this lane counts: checking the whole pad would let an entering car and an exiting
   * car wait on each other forever.
   */
  private landingClear(car: Car, level: number): boolean {
    for (const other of this.cars.values()) {
      if (other === car || other.level !== level || other.phase === 'parked') continue;
      const rel = sub(other.pos, car.pos);
      if (Math.abs(dot(rel, car.heading)) < LANDING_LENGTH && Math.abs(dot(rel, rightOf(car.heading))) < 1.4) return false;
    }
    return true;
  }

  /**
   * Where the aisle meets the entry spine, cars cross paths, so one car goes through at a time.
   * Returns false if this car has to wait.
   */
  private takeHubTurn(car: Car): boolean {
    const g = this.isInsideGarage(car.pos);
    if (!g) return true;
    const key = `${g.id}:${car.level}`;
    const holder = this.hubTurns.get(key);
    const near = distance(car.pos, g.hub) < HUB_RADIUS;
    if (!near) {
      if (holder === car.id) this.hubTurns.delete(key);
      return true;
    }
    if (holder && holder !== car.id && this.cars.has(holder)) return false;
    this.hubTurns.set(key, car.id);
    return true;
  }

  /** Whether the aisle outside a garage stall is free to back out into. */
  private aisleClear(car: Car, stall: Stall): boolean {
    const exit = this.aislePoint(this.garageOf(stall), stall, true);
    for (const other of this.cars.values()) {
      if (other !== car && other.level === car.level && other.phase !== 'parked' && distance(other.pos, exit) < AISLE_CLEARANCE) return false;
    }
    return true;
  }

  /** Moves a car between levels. Only works on the transporter pad. */
  useTransporter(car: Car, level: number): boolean {
    const g = this.city.garages.find((x) => distance(x.pad, car.pos) < PAD_REACH);
    if (!g || level < 0 || level >= g.levels || level === car.level || Math.abs(car.speed) > 2) return false;
    car.speed = 0;
    car.liftT = LIFT_SECONDS;
    car.liftFrom = car.level;
    car.level = level;
    return true;
  }

  isInsideGarage(point: Vec2): Garage | null {
    for (const g of this.city.garages) {
      const rel = sub(point, g.door);
      const u = Math.abs(dot(rel, g.aisle));
      const v = dot(rel, g.inward);
      if (u <= g.width / 2 - 1 && v >= 0 && v <= g.depth - 1) return g;
    }
    return null;
  }

  private isOnDriveway(point: Vec2): boolean {
    for (const g of this.city.garages) {
      const rel = sub(point, g.door);
      if (Math.abs(dot(rel, g.aisle)) <= 4 && dot(rel, g.inward) >= -8 && dot(rel, g.inward) <= 1) return true;
    }
    return false;
  }

  /** Hands a moving car to the keyboard. */
  takeControl(car: Car) {
    if (car.phase === 'parked') {
      car.control = { throttle: 0, steer: 0 };
      car.leaveAt = this.time;
      return true;
    }
    if (car.phase !== 'drive') return false;
    this.leaveJunction(car);
    car.control = { throttle: 0, steer: 0 };
    car.path = null;
    car.queue = [];
    car.stopS = Infinity;
    car.movement = null;
    car.endsAtStall = false;
    return true;
  }

  /** Gives a car back to the simulation. It rejoins the lane of the street it is on. */
  releaseControl(car: Car) {
    car.control = null;
    if (car.phase !== 'drive') return;
    const inside = this.isInsideGarage(car.pos);
    if (inside) {
      // Hand the car back cleanly: it drives itself out.
      const anyStall = this.city.stalls.find((s) => s.garageId === inside.id)!;
      car.targetStallId = null;
      car.mode = car.role === 'hero' ? 'wander' : 'cruise';
      this.leaveGarage(car, anyStall);
      return;
    }
    this.updateEdge(car);
    const along = dot(sub(car.pos, this.graph.node(car.edge.from)), this.graph.edgeDir(car.edge));
    const length = this.graph.edgeLength(car.edge);
    car.startAlong = Math.min(Math.max(along, this.graph.corner), length - this.graph.corner - 1);
    car.mode = car.targetStallId ? 'toStall' : 'wander';
    car.queue = [];
    if (car.targetStallId) this.planQueue(car);
  }

  /** Parks a driven car in the stall it is sitting in, or pulls out if it is already parked. */
  togglePark(car: Car): string | null {
    if (car.phase === 'parked') {
      car.leaveAt = this.time;
      return null;
    }
    if (car.phase !== 'drive' || Math.abs(car.speed) > 2) return null;
    let found: Stall | null = null;
    for (const stall of this.city.stalls) {
      if ((stall.level ?? 0) !== car.level || !!stall.garageId !== car.insideGarage) continue;
      if (!this.stallOwner.has(stall.id) && distance(stall.center, car.pos) < 4.5) found = stall;
    }
    if (!found) return null;
    this.stallOwner.set(found.id, car.id);
    car.stallId = found.id;
    car.targetStallId = found.id;
    car.phase = 'parked';
    car.speed = 0;
    car.pos = found.center;
    car.heading = found.garageId ? found.normal : this.graph.edgeDir(this.graph.approachEdge(found));
    car.leaveAt = Infinity;
    this.parking?.arrived(car.id);
    return found.id;
  }

  /** Cars can use roads and sidewalks. Everything else is a building or a block. */
  isDrivable(point: Vec2, level = 0): boolean {
    if (this.isInsideGarage(point)) return true;
    if (level > 0) return false; // Upper floors have walls all round.
    if (this.isOnDriveway(point)) return true;
    const reach = this.city.roadHalfWidth + this.city.sidewalkWidth - DRIVER_HALF_WIDTH;
    for (const seg of this.city.segments) {
      const rel = sub(point, this.graph.node(seg.a));
      const along = dot(rel, seg.dir);
      if (along < -reach || along > seg.length + reach) continue;
      if (Math.abs(rel.x * seg.dir.z - rel.z * seg.dir.x) <= reach) return true;
    }
    return false;
  }

  /** Each car is two circles, front and rear, which fits a long thin shape better than one. */
  private hitsCar(car: Car, point: Vec2, heading: Vec2): boolean {
    const mine = [add(point, scale(heading, 1.4)), add(point, scale(heading, -1.4))];
    for (const other of this.cars.values()) {
      if (other === car || other.level !== car.level || distance(other.pos, point) > 8) continue;
      const theirs = [add(other.pos, scale(other.heading, 1.4)), add(other.pos, scale(other.heading, -1.4))];
      for (const a of mine) {
        for (const b of theirs) {
          if (distance(a, b) < CAR_RADIUS * 2) return true;
        }
      }
    }
    return false;
  }

  /** The directed street a car is on, judged by position and which way it faces. */
  private updateEdge(car: Car) {
    let best: DirectedEdge | null = null;
    let bestDistance = Infinity;
    for (const seg of this.city.segments) {
      const rel = sub(car.pos, this.graph.node(seg.a));
      const along = Math.min(Math.max(dot(rel, seg.dir), 0), seg.length);
      const d = distance(car.pos, add(this.graph.node(seg.a), scale(seg.dir, along)));
      if (d < bestDistance - 0.01) {
        bestDistance = d;
        best = dot(car.heading, seg.dir) >= 0 ? { from: seg.a, to: seg.b } : { from: seg.b, to: seg.a };
      }
    }
    if (best) car.edge = best;
  }

  private driveByHand(car: Car, dt: number) {
    const { throttle, steer } = car.control!;
    if (throttle > 0) car.speed += (car.speed < 0 ? MANUAL_BRAKING : MANUAL_ACCELERATION) * throttle * dt;
    else if (throttle < 0) car.speed += (car.speed > 0 ? MANUAL_BRAKING : MANUAL_ACCELERATION) * throttle * dt;
    else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), MANUAL_COASTING * dt);
    car.speed = Math.min(MANUAL_TOP_SPEED, Math.max(-MANUAL_REVERSE_SPEED, car.speed));

    const yaw = (steer * car.speed * MANUAL_STEERING) / WHEELBASE;
    const turned = add(car.heading, scale(rightOf(car.heading), yaw * dt));
    const length = Math.hypot(turned.x, turned.z);
    const heading = { x: turned.x / length, z: turned.z / length };
    const next = add(car.pos, scale(heading, car.speed * dt));

    if (!this.isDrivable(next, car.level) || this.hitsCar(car, next, heading)) {
      car.speed *= -0.25; // A small bounce, so the driver can back away.
      return;
    }
    const moved = Math.abs(car.speed) * dt;
    car.pos = next;
    car.heading = heading;
    car.meters += moved;
    car.metersSinceCapture += moved;
    car.insideGarage = this.isInsideGarage(car.pos) !== null;
    this.updateEdge(car);
  }

  /** Distance to the nearest car on the road this car is about to drive, following its path around corners. */
  private gapAhead(car: Car): number {
    const path = car.path;
    // A merging car has priority. If both sides yielded they would wait on each other forever.
    if (!path || car.merging) return Infinity;
    const nearby = [...this.cars.values()].filter(
      (other) => other !== car && other.phase !== 'parked' && other.level === car.level && distance(other.pos, car.pos) < GAP_LOOKAHEAD + 5,
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
        const reach = other.phase === 'parkOut' || other.merging ? 4.5 : 1.9;
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
      if (other === ignore || other.phase === 'parked' || (other.insideGarage && !other.merging)) continue;
      if (distance(other.pos, point) < radius) return false;
    }
    return true;
  }

  tick(dt: number) {
    this.time += dt;
    while (this.driversEnabled && this.demand.length > 0 && this.demand[0].at <= this.time) {
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
        const wantsToLeave = this.time >= car.leaveAt && (this.driversEnabled || car.control !== null);
        const stall = car.stallId ? this.stalls.get(car.stallId) : null;
        const roomToPull = stall?.garageId ? this.aisleClear(car, stall) : this.laneClear(car.pos, PULL_OUT_GAP, car);
        if (wantsToLeave && roomToPull) this.beginLeaving(car);
        continue;
      }
      if (car.phase === 'parkIn' || car.phase === 'parkOut') {
        car.parkT += dt / PARK_SECONDS;
        const stall = this.stalls.get(car.stallId!)!;
        const t = Math.min(car.parkT, 1);
        const smooth = t * t * (3 - 2 * t);
        const dir = stall.garageId ? stall.normal : this.graph.edgeDir(this.graph.approachEdge(stall));
        if (car.phase === 'parkIn') {
          car.pos = add(scale(car.parkFrom, 1 - smooth), scale(stall.center, smooth));
          car.heading = dir;
          if (t >= 1) this.finishParking(car);
        } else {
          const exit = stall.garageId
            ? this.aislePoint(this.garageOf(stall), stall, true)
            : add(stall.center, add(scale(stall.normal, -3), scale(dir, 3)));
          car.pos = add(scale(stall.center, 1 - smooth), scale(exit, smooth));
          if (t >= 1) this.finishLeaving(car);
        }
        continue;
      }

      if (car.pendingLift !== null) {
        car.speed = 0;
        if (!this.landingClear(car, car.pendingLift)) continue;
        car.liftT = LIFT_SECONDS;
        car.liftFrom = car.level;
        car.level = car.pendingLift;
        car.pendingLift = null;
      }
      if (car.liftT > 0) {
        car.liftT -= dt;
        car.speed = 0;
        continue;
      }
      if (car.control) {
        this.driveByHand(car, dt);
        continue;
      }
      if (car.waitingToMerge) {
        if (!this.laneClear(car.waitingToMerge, MERGE_GAP, car)) {
          car.speed = 0;
          continue;
        }
        car.waitingToMerge = null;
        car.merging = true;
      }
      if (car.insideGarage && !this.takeHubTurn(car)) {
        car.speed = 0;
        continue;
      }

      if (!car.path) this.beginPath(car);
      const path = car.path;
      if (!path) continue;

      // Drivers slow down when they near their spot, which also gives cameras time to look at it.
      const nearingStall = car.endsAtStall && path.length - car.s < APPROACH_DISTANCE;
      let limit = car.insideGarage ? GARAGE_SPEED : nearingStall ? APPROACH_SPEED : CRUISE_SPEED;
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
