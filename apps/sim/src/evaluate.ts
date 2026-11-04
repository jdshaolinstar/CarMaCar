// Headless adoption study. Same drivers, same city, only the share of cars on the network changes.
// The parking service here reads a delayed copy of the truth, standing in for the live map so that
// hundreds of runs are possible. It is not the vision pipeline, and results must be labelled that way.
import { distance, TrafficEngine, type CityMap, type DirectedEdge, type Vec2 } from '@carmacar/shared';
import { World, type ParkingService } from './world';

export class DelayedMapService implements ParkingService {
  private snapshot = new Set<string>();
  private nextRefresh = 0;
  private readonly reservations = new Map<string, string>();

  constructor(
    private readonly city: CityMap,
    private readonly world: () => World,
    private readonly staleSeconds: number,
  ) {}

  private refresh() {
    const world = this.world();
    if (world.time >= this.nextRefresh) {
      this.snapshot = new Set(world.stallOwner.keys());
      this.nextRefresh = world.time + this.staleSeconds;
    }
  }

  findNow(carId: string, destinationId: string, exclude: string[]): string | null {
    this.refresh();
    const destination = this.city.destinations.find((d) => d.id === destinationId)!;
    const held = new Set(this.reservations.values());
    let best: string | null = null;
    let bestDist = Infinity;
    for (const stall of this.city.stalls) {
      if (this.snapshot.has(stall.id) || held.has(stall.id) || exclude.includes(stall.id)) continue;
      const d = distance(stall.center, destination);
      if (d < bestDist) {
        bestDist = d;
        best = stall.id;
      }
    }
    if (best) this.reservations.set(carId, best);
    return best;
  }

  async find(carId: string, destinationId: string, _from: Vec2, exclude: string[]) {
    return this.findNow(carId, destinationId, exclude);
  }

  release(carId: string) {
    this.reservations.delete(carId);
  }

  arrived(carId: string) {
    this.reservations.delete(carId);
  }
}

/** The real Traffic Efficiency System, fed the way the platform feeds it, with a delayed parking map. */
export class TesService implements ParkingService {
  readonly engine: TrafficEngine;
  private snapshot = new Set<string>();
  private nextRefresh = 0;
  private nextFeed = 0;
  private readonly reservations = new Map<string, string>();

  constructor(
    private readonly city: CityMap,
    private readonly world: () => World,
    private readonly staleSeconds: number,
    /** Chance per second that a camera counts a given street. */
    private readonly cameraCoverage: number,
    private readonly routing: boolean,
    private readonly smartLights: boolean,
  ) {
    this.engine = new TrafficEngine(city, world().graph);
  }

  /** Called once per simulated tick: GPS from participants, camera counts for everyone. */
  feed() {
    const world = this.world();
    if (world.time < this.nextFeed) return;
    this.nextFeed = world.time + 1;
    const onSegment = new Map<string, number>();
    for (const car of world.cars.values()) {
      if (car.phase !== 'drive' || car.insideGarage) continue;
      const seg = world.graph.segmentBetween(car.edge.from, car.edge.to).id;
      onSegment.set(seg, (onSegment.get(seg) ?? 0) + 1);
      if (car.sharesGps) this.engine.reportVehicle({ carId: car.id, edge: car.edge, speed: car.speed }, world.time);
    }
    for (const seg of this.city.segments) {
      if (Math.random() < this.cameraCoverage) this.engine.reportCameraCount(seg.id, onSegment.get(seg.id) ?? 0, world.time);
    }
    if (this.smartLights) {
      for (const [nodeId, axis] of this.engine.signalPlan(world.signals.nodes, world.time)) world.signals.request(nodeId, axis);
    }
  }

  private refresh() {
    const world = this.world();
    if (world.time >= this.nextRefresh) {
      this.snapshot = new Set(world.stallOwner.keys());
      this.nextRefresh = world.time + this.staleSeconds;
    }
  }

  async find(carId: string, destinationId: string, _from: Vec2, exclude: string[]) {
    this.refresh();
    const world = this.world();
    const car = world.cars.get(carId);
    if (!car) return null;
    const destination = this.city.destinations.find((d) => d.id === destinationId)!;
    const held = new Set(this.reservations.values());
    const stall = this.engine.chooseStall(
      car.edge,
      destination,
      (s) => !this.snapshot.has(s.id) && !held.has(s.id) && !exclude.includes(s.id),
      world.time,
    );
    if (stall) this.reservations.set(carId, stall.id);
    return stall?.id ?? null;
  }

  async route(carId: string, from: DirectedEdge, goal: DirectedEdge) {
    return this.routing ? this.engine.planRoute(carId, from, goal, this.world().time) : null;
  }

  release(carId: string) {
    this.reservations.delete(carId);
  }

  arrived(carId: string) {
    this.reservations.delete(carId);
    this.engine.forgetCar(carId);
  }
}

export interface RunConfig {
  seed: number;
  drivers: number;
  spanSeconds: number;
  parkedShare: number;
  /** Guided cars. Named for the earlier parking network study. */
  networkShare: number;
  autopilotShare?: number;
  gpsShare?: number;
  staleSeconds: number;
  horizonSeconds: number;
  /** Everyone heads to these places, for an event surge. */
  destinations?: string[];
  /** Use the Traffic Efficiency System rather than the plain parking service. */
  tes?: boolean;
  smartLights?: boolean;
  cameraCoverage?: number;
}

export interface RunResult {
  drivers: number;
  parked: number;
  stillSearching: number;
  /** Driver count with those still searching at the end included at their elapsed time. */
  meanSeconds: number;
  meanMeters: number;
  meanWalkMeters: number;
  totalKm: number;
}

export async function runOnce(city: CityMap, config: RunConfig): Promise<RunResult> {
  const holder: { world?: World } = {};
  const world = new World(city, config.seed, null);
  holder.world = world;
  const tes = config.tes
    ? new TesService(city, () => holder.world!, config.staleSeconds, config.cameraCoverage ?? 0.1, true, !!config.smartLights)
    : null;
  world.setParking(tes ?? new DelayedMapService(city, () => holder.world!, config.staleSeconds));
  if (config.smartLights) world.signals.mode = 'smart';
  world.populateParked(config.parkedShare);
  world.setDemand(
    World.makeDemand(city, config.seed + 1, config.drivers, config.spanSeconds, {
      guided: config.networkShare,
      autopilot: config.autopilotShare,
      gps: config.gpsShare,
      destinations: config.destinations,
    }),
  );

  const dt = 1 / 10;
  const steps = config.horizonSeconds / dt;
  for (let i = 0; i < steps; i++) {
    world.tick(dt);
    tes?.feed();
    // Lets the async parking replies land, as they would over the network.
    for (let settle = 0; settle < 4; settle++) await Promise.resolve();
  }

  const log = world.parkedLog.filter((r) => r.role === 'network' || r.role === 'manual');
  const searching = [...world.cars.values()].filter(
    (c) => (c.role === 'network' || c.role === 'manual') && c.phase === 'drive' && c.mode !== 'exit',
  );
  const seconds = [...log.map((r) => r.seconds), ...searching.map((c) => world.time - c.spawnedAt)];
  const meters = [...log.map((r) => r.meters), ...searching.map((c) => c.meters)];
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  return {
    drivers: seconds.length,
    parked: log.length,
    stillSearching: searching.length,
    meanSeconds: mean(seconds),
    meanMeters: mean(meters),
    meanWalkMeters: mean(log.map((r) => r.walkMeters)),
    totalKm: meters.reduce((a, b) => a + b, 0) / 1000,
  };
}
