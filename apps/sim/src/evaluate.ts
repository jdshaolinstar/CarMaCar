// Headless adoption study. Same drivers, same city, only the share of cars on the network changes.
// The parking service here reads a delayed copy of the truth, standing in for the live map so that
// hundreds of runs are possible. It is not the vision pipeline, and results must be labelled that way.
import { distance, type CityMap, type Vec2 } from '@carmacar/shared';
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

export interface RunConfig {
  seed: number;
  drivers: number;
  spanSeconds: number;
  parkedShare: number;
  networkShare: number;
  staleSeconds: number;
  horizonSeconds: number;
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
  const service = new DelayedMapService(city, () => holder.world!, config.staleSeconds);
  const world = new World(city, config.seed, service);
  holder.world = world;
  world.populateParked(config.parkedShare);
  world.setDemand(World.makeDemand(city, config.seed + 1, config.drivers, config.spanSeconds, config.networkShare));

  const dt = 1 / 10;
  const steps = config.horizonSeconds / dt;
  for (let i = 0; i < steps; i++) {
    world.tick(dt);
    // Lets the async parking replies land, as they would over the network.
    if (i % 5 === 0) await Promise.resolve();
    if (i % 20 === 0) await new Promise((r) => setImmediate(r));
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
