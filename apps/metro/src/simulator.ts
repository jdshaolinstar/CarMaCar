// A queue-based traffic simulator for a whole metro area. Each road is a first-in, first-out queue
// with a free-flow travel time, a discharge rate and a storage limit, so a full road holds cars back
// on the road behind it and jams spread as they do in real traffic. It does not model individual
// lanes or car physics, which is what lets it run hundreds of thousands of cars.
//
// A run can use a sample of real trips. With a 10% sample, road capacity and storage are scaled to
// 10%, so each simulated car stands for ten real ones. Large transport models work the same way.
import type { Network } from './network';

export interface Trip {
  /** Seconds after the simulation starts. */
  depart: number;
  originZone: number;
  destinationZone: number;
  /** Whether this driver has to find a space on the street at the end. */
  needsStreetParking: boolean;
  /** Fixed per driver, so the same people adopt TES as the share rises. */
  adoptionRoll: number;
}

export type RoutingMode = 'free-flow' | 'live-traffic' | 'coordinated';

export interface RunConfig {
  sampleRate: number;
  /** The one calibration setting: stands in for the small streets the map leaves out. */
  capacityScale: number;
  /** Share of drivers on TES. The rest use the baseline. */
  tesShare: number;
  /** What everyone not on TES does. Today's apps route on live traffic. */
  baseline: RoutingMode;
  /** How often routes are recalculated. */
  rerouteSeconds: number;
  horizonSeconds: number;
  /** Share of parked-map readings that are right. From measured camera accuracy. */
  mapAccuracy: number;
  /** How full street parking is before anyone arrives. */
  parkingStart: number;
  /** Whether TES tells drivers where free parking is. */
  tesParking: boolean;
  /** Strength of the push toward spreading traffic, from 0 for selfish to 1 for system optimal. */
  coordination: number;
  seed: number;
  onFrame?: (frame: Frame) => void;
  frameSeconds?: number;
  /** Extra travel cost per edge, for strategy from a supervisor. Multiplies free-flow time. */
  edgeWeights?: Float32Array;
  /** Replaces the road cost TES routes on. This is where a tuned or generated algorithm plugs in. */
  roadCost?: (road: RoadState) => number;
  /** How many batches TES plans each reroute, so each batch sees the plans of the last. */
  tesSlices?: number;
  /** Set false to count load against the whole road, as early runs did. A few TES cars then see every road as empty. */
  shareAwareLoad?: boolean;
}

/** What a TES routing algorithm can see about one road at the moment it plans. */
export interface RoadState {
  /** Seconds to cross when empty. */
  freeSeconds: number;
  /** Seconds to cross, as measured by cars just now. */
  liveSeconds: number;
  /** Cars TES has already planned onto this road, as a share of what it can pass this interval. */
  load: number;
  lengthKm: number;
  capacityPerHour: number;
  isFreeway: boolean;
  isRamp: boolean;
  isArterial: boolean;
  hasSignal: boolean;
  /** Clock hour, such as 7.5 for 7:30 AM. */
  hour: number;
}

export interface RoutingParams {
  /** How strongly planned traffic raises a road's cost. */
  alpha: number;
  /** How sharply that cost rises as a road fills. */
  power: number;
  /** Push toward spreading traffic, from 0 for selfish to 1 for system optimal. */
  coordination: number;
  /** Batches planned per reroute. */
  slices: number;
}

/** The values tuned by hand during development. A Lab session is judged against these. */
export const HAND_TUNED: RoutingParams = { alpha: 0.15, power: 4, coordination: 0.5, slices: 4 };

/** The standard TES road cost, as a function of its settings. */
export const paramCost = (p: RoutingParams) => (road: RoadState) =>
  Math.max(road.liveSeconds, road.freeSeconds * (1 + p.alpha * Math.pow(road.load, p.power) * (1 + 4 * p.coordination)));

export interface Frame {
  time: number;
  /** Cars on each edge, in simulated cars. */
  onEdge: Int32Array;
  moving: number;
  arrived: number;
  meanSpeedKph: number;
}

export interface RunResult {
  trips: number;
  finished: number;
  /** Includes unfinished trips, counted to the horizon. */
  meanMinutes: number;
  /** Time to reach the destination zone, without the search for parking. */
  meanDriveMinutes: number;
  /** Minutes spent waiting to join the first road. Large values mean the entry points are too few. */
  meanEntryWaitMinutes: number;
  rushMeanMinutes: number;
  /** The typical driver. A small tail of stuck trips cannot move this the way it moves the mean. */
  medianMinutes: number;
  /** Mean of trips that arrived. Compare with meanMinutes to see how much the unfinished tail adds. */
  finishedMeanMinutes: number;
  p90Minutes: number;
  vehicleHours: number;
  vehicleKm: number;
  delayHours: number;
  fuelLitres: number;
  cruisingHours: number;
  meanCruiseMinutes: number;
  foundParking: number;
  gaveUpParking: number;
  /** Simulated times the sample rate, so these stand for the whole population. */
  scaled: { vehicleHours: number; vehicleKm: number; delayHours: number; fuelLitres: number };
}

const STEP = 2;
/** With a small sample a short road could hold less than one car, which would jam it for nothing. */
const MIN_STORAGE = 3;
/** After this long at the front of a blocked queue, a car squeezes through, as in real gridlock. */
const STUCK_SECONDS = 120;
const CRUISE_LIMIT_EDGES = 40;
/** How many roads outward TES looks for a free space. */
const SPACE_SEARCH_LIMIT = 400;
/** A road with this share of its spaces free is one where a driver always finds one. */
const SPOT_CHANCE_SHARE = 0.2;
const SPACE_METERS = 7;
const CURB_SHARE = 0.35;
/** Fixed start and end of each trip, on small roads the network leaves out. */
const ACCESS_SECONDS = 180;
const SIGNAL_SECONDS = 22;
/** How far one driver's idea of a road's time can differ from another's. */
const ROUTE_VARIATION = 0.25;
/** Lower bound on TES's share of a road, so tiny adoption doesn't make every road look full. */
const MIN_ROAD_SHARE = 0.05;
/** Simulated time zero is 5 AM. */
const SIM_CLOCK_START_HOUR = 5;

/** A simple speed-based fuel curve: litres per km, worst in stop-and-go and at very high speed. */
export function fuelPerKm(kph: number) {
  const v = Math.max(kph, 4);
  return 0.045 + 1.6 / v + 0.0000016 * v * v;
}

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

class MinHeap {
  private readonly keys: Float64Array;
  private readonly values: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
  }

  push(key: number, value: number) {
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.values[i] = value;
  }

  pop(): number {
    const top = this.values[0];
    const key = this.keys[--this.size];
    const value = this.values[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.values[i] = this.values[child];
      i = child;
    }
    this.keys[i] = key;
    this.values[i] = value;
    return top;
  }
}

export class Router {
  private readonly dist: Float64Array;
  private readonly via: Int32Array;
  private readonly heap: MinHeap;

  constructor(private readonly network: Network) {
    this.dist = new Float64Array(network.nodeCount);
    this.via = new Int32Array(network.nodeCount);
    this.heap = new MinHeap(network.edgeCount + network.nodeCount + 8);
  }

  /** Cheapest edges from any of `sources` to every node. Returns the edge used to reach each node. */
  tree(sources: Int32Array | number[], cost: Float32Array) {
    const { dist, via, heap, network } = this;
    dist.fill(Infinity);
    via.fill(-1);
    heap.size = 0;
    for (const s of sources) {
      dist[s] = 0;
      heap.push(0, s);
    }
    const { outStart, outgoing, edgeTo } = network;
    const settled = new Uint8Array(network.nodeCount);
    while (heap.size > 0) {
      const node = heap.pop();
      if (settled[node]) continue;
      settled[node] = 1;
      const here = dist[node];
      for (let i = outStart[node]; i < outStart[node + 1]; i++) {
        const edge = outgoing[i];
        const next = edgeTo[edge];
        const total = here + cost[edge];
        if (total < dist[next]) {
          dist[next] = total;
          via[next] = edge;
          heap.push(total, next);
        }
      }
    }
    return { dist, via };
  }
}

export interface Zones {
  count: number;
  /** Network nodes where traffic enters and leaves each zone. */
  connectors: Int32Array[];
}

export class MetroSim {
  readonly time = { now: 0 };
  private readonly n: Network;
  private readonly capacityPerStep: Float32Array;
  private readonly storage: Int32Array;
  private readonly freeSeconds: Float32Array;
  /** Real spaces, not scaled. Each simulated car takes its full share of them. */
  private readonly curbSpaces: Float32Array;
  private readonly curbUsed: Float32Array;
  private readonly head: Int32Array;
  private readonly tail: Int32Array;
  private readonly count: Int32Array;
  private readonly credit: Float32Array;
  private readonly blockedSince: Float32Array;
  private readonly active: Uint8Array;
  private activeEdges: Int32Array;
  private activeCount = 0;
  private readonly nextCar: Int32Array;
  private readonly earliest: Float32Array;
  private readonly routeAt: Int32Array;
  private readonly routeEnd: Int32Array;
  /** When the car actually started, then when its drive and its whole trip ended. */
  private readonly departedAt: Float32Array;
  private readonly driveEnd: Float32Array;
  private readonly tripEnd: Float32Array;
  private readonly enteredAt: Float32Array;
  private readonly cruiseCount: Uint8Array;
  private readonly onTes: Uint8Array;
  private readonly done: Uint8Array;
  private pool: Int32Array;
  private poolUsed = 0;
  private readonly random: () => number;
  private readonly router: Router;
  private readonly plannedVolume: Float32Array;
  private planningTime = 0;
  /** One object reused for every road, because this runs millions of times. */
  private readonly roadState: RoadState = { freeSeconds: 0, liveSeconds: 0, load: 0, lengthKm: 0, capacityPerHour: 0, isFreeway: false, isRamp: false, isArterial: false, hasSignal: false, hour: 0 };
  private readonly standardCost: (road: RoadState) => number;
  private readonly observed: Float32Array;
  private readonly edgeTimeSum: Float32Array;
  private readonly edgeTimeCount: Int32Array;
  private readonly cost: Float32Array;
  /** Seconds of delay on each road, for reports. */
  readonly delayByEdge: Float32Array;
  private readonly searchStamp: Int32Array;
  private readonly searchPrevious: Int32Array;
  private readonly searchQueue = new Int32Array(SPACE_SEARCH_LIMIT * 8);
  private searchId = 0;
  private newRoute = false;
  private noiseRound = 1;
  private readonly varied: Float32Array;
  private readonly reserved: Uint8Array;
  private carTimeOnEdge = 0;
  private carKm = 0;
  private delaySeconds = 0;
  private fuel = 0;
  private cruisingSeconds = 0;
  private cruisers = 0;
  private found = 0;
  private gaveUp = 0;
  private arrived = 0;

  constructor(
    private readonly network: Network,
    private readonly zones: Zones,
    private readonly trips: Trip[],
    private readonly config: RunConfig,
  ) {
    const n = (this.n = network);
    const edges = n.edgeCount;
    const cars = trips.length;
    this.capacityPerStep = new Float32Array(edges);
    this.storage = new Int32Array(edges);
    this.freeSeconds = new Float32Array(edges);
    this.curbSpaces = new Float32Array(edges);
    this.curbUsed = new Float32Array(edges);
    const random = (this.random = mulberry(config.seed));
    for (let e = 0; e < edges; e++) {
      this.capacityPerStep[e] = (n.edgeCapacity[e] / 3600) * STEP * config.sampleRate * config.capacityScale;
      this.storage[e] = Math.max(MIN_STORAGE, Math.round(n.edgeStorage[e] * config.sampleRate * config.capacityScale));
      this.freeSeconds[e] = n.edgeLength[e] / n.edgeSpeed[e] + (n.edgeSignal[e] ? SIGNAL_SECONDS : 0);
      if (n.edgeClass[e] >= 2) {
        this.curbSpaces[e] = (n.edgeLength[e] / SPACE_METERS) * CURB_SHARE;
        this.curbUsed[e] = this.curbSpaces[e] * config.parkingStart * (0.8 + random() * 0.4);
      }
    }
    this.head = new Int32Array(edges).fill(-1);
    this.tail = new Int32Array(edges).fill(-1);
    this.count = new Int32Array(edges);
    this.credit = new Float32Array(edges);
    this.blockedSince = new Float32Array(edges).fill(-1);
    this.active = new Uint8Array(edges);
    this.activeEdges = new Int32Array(edges);
    this.nextCar = new Int32Array(cars).fill(-1);
    this.earliest = new Float32Array(cars);
    this.routeAt = new Int32Array(cars);
    this.routeEnd = new Int32Array(cars);
    this.departedAt = new Float32Array(cars);
    this.driveEnd = new Float32Array(cars);
    this.tripEnd = new Float32Array(cars);
    this.enteredAt = new Float32Array(cars);
    this.cruiseCount = new Uint8Array(cars);
    this.onTes = new Uint8Array(cars);
    this.done = new Uint8Array(cars);
    trips.forEach((t, i) => (this.onTes[i] = t.adoptionRoll < config.tesShare ? 1 : 0));
    this.pool = new Int32Array(Math.max(1024, cars * 40));
    this.router = new Router(network);
    this.plannedVolume = new Float32Array(edges);
    this.standardCost = paramCost({ ...HAND_TUNED, coordination: config.coordination });
    this.observed = new Float32Array(edges);
    this.edgeTimeSum = new Float32Array(edges);
    this.edgeTimeCount = new Int32Array(edges);
    this.cost = new Float32Array(edges);
    this.delayByEdge = new Float32Array(edges);
    this.varied = new Float32Array(edges);
    this.searchStamp = new Int32Array(edges);
    this.searchPrevious = new Int32Array(edges);
    this.reserved = new Uint8Array(cars);
    for (let e = 0; e < edges; e++) this.observed[e] = this.freeSeconds[e];
  }

  private activate(edge: number) {
    if (!this.active[edge]) {
      this.active[edge] = 1;
      this.activeEdges[this.activeCount++] = edge;
      // An empty road isn't holding anyone up, so the car arriving at it can leave when it reaches the end.
      this.credit[edge] = Math.max(this.credit[edge], 1);
    }
  }

  private enter(car: number, edge: number, now: number) {
    this.count[edge]++;
    this.earliest[car] = now + this.freeSeconds[edge];
    this.nextCar[car] = -1;
    if (this.tail[edge] < 0) this.head[edge] = car;
    else this.nextCar[this.tail[edge]] = car;
    this.tail[edge] = car;
    this.activate(edge);
  }

  private reservePool(extra: number) {
    if (this.poolUsed + extra <= this.pool.length) return;
    const bigger = new Int32Array(Math.ceil((this.poolUsed + extra) * 1.5));
    bigger.set(this.pool.subarray(0, this.poolUsed));
    this.pool = bigger;
  }

  /** Builds the cost each group of drivers sees right now. */
  private fillCost(mode: RoutingMode) {
    const { cost, freeSeconds, observed, plannedVolume, n } = this;
    const weights = this.config.edgeWeights;
    const { sampleRate, rerouteSeconds, capacityScale, tesShare } = this.config;
    const roadShare = this.config.shareAwareLoad === false ? 1 : Math.max(tesShare, MIN_ROAD_SHARE);
    const roadCost = this.config.roadCost ?? this.standardCost;
    const road = this.roadState;
    road.hour = SIM_CLOCK_START_HOUR + this.planningTime / 3600;
    for (let e = 0; e < n.edgeCount; e++) {
      let seconds = freeSeconds[e];
      if (mode === 'live-traffic') {
        seconds = observed[e];
      } else if (mode === 'coordinated') {
        // Planned traffic, not only traffic already there, and each car's effect on the cars behind it.
        const capacity = (n.edgeCapacity[e] * sampleRate * capacityScale * roadShare * rerouteSeconds) / 3600;
        road.freeSeconds = freeSeconds[e];
        road.liveSeconds = observed[e];
        road.load = plannedVolume[e] / Math.max(capacity, 0.01);
        road.lengthKm = n.edgeLength[e] / 1000;
        road.capacityPerHour = n.edgeCapacity[e] * capacityScale;
        road.isFreeway = n.edgeClass[e] === 0;
        road.isRamp = n.edgeClass[e] === 1;
        road.isArterial = n.edgeClass[e] === 2;
        road.hasSignal = n.edgeSignal[e] > 0;
        const value = roadCost(road);
        // A generated algorithm that misbehaves on a road falls back to live traffic for that road.
        seconds = value > 0 && Number.isFinite(value) ? value : observed[e];
      }
      cost[e] = weights ? seconds * weights[e] : seconds;
    }
  }

  /** A quick repeatable value from 0 to 1 for a road and a group of drivers, changing each reroute. */
  private fastNoise(edge: number, group: number) {
    let h = Math.imul(edge + 1, 0x9e3779b1) ^ Math.imul(group + 1, 0x85ebca6b) ^ this.noiseRound;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  }

  /** Writes each car's route from its zone's tree, cheapest first. */
  private assign(group: number[], mode: RoutingMode) {
    const { zones, router, trips, n, varied } = this;
    const byOrigin = new Map<number, number[]>();
    for (const car of group) {
      const list = byOrigin.get(trips[car].originZone);
      if (list) list.push(car);
      else byOrigin.set(trips[car].originZone, [car]);
    }
    const stack: number[] = [];
    // Coordinated cars are assigned in slices, so each slice sees the plans of the last.
    const slices = mode === 'coordinated' ? (this.config.tesSlices ?? HAND_TUNED.slices) : 1;
    for (let slice = 0; slice < slices; slice++) {
      this.fillCost(mode);
      for (const [origin, cars] of byOrigin) {
        // App users get slightly different answers, so they don't all pile onto one route at once.
        if (mode === 'live-traffic') {
          for (let e = 0; e < n.edgeCount; e++) varied[e] = this.cost[e] * (1 + ROUTE_VARIATION * this.fastNoise(e, origin));
        }
        const { via } = router.tree(zones.connectors[origin], mode === 'live-traffic' ? varied : this.cost);
        for (let k = slice; k < cars.length; k += slices) {
          const car = cars[k];
          const connectors = zones.connectors[trips[car].destinationZone];
          let goal = connectors[Math.floor(this.random() * connectors.length)];
          if (via[goal] < 0 && connectors.length > 1) goal = connectors[0];
          stack.length = 0;
          let node = goal;
          while (via[node] >= 0 && stack.length < 5000) {
            const edge = via[node];
            stack.push(edge);
            node = n.edgeFrom[edge];
          }
          this.reservePool(stack.length + 1);
          this.routeAt[car] = this.poolUsed;
          for (let i = stack.length - 1; i >= 0; i--) {
            const edge = stack[i];
            this.pool[this.poolUsed++] = edge;
            if (mode === 'coordinated') this.plannedVolume[edge] += 1;
          }
          this.routeEnd[car] = this.poolUsed;
        }
      }
    }
  }

  private updateObserved() {
    const { edgeTimeSum, edgeTimeCount, observed, freeSeconds, n } = this;
    for (let e = 0; e < n.edgeCount; e++) {
      // Blend in what cars measured. An empty road drifts back toward free flow.
      const measured = edgeTimeCount[e] > 0 ? edgeTimeSum[e] / edgeTimeCount[e] : freeSeconds[e];
      observed[e] = observed[e] * 0.4 + Math.max(measured, freeSeconds[e]) * 0.6;
      edgeTimeSum[e] = 0;
      edgeTimeCount[e] = 0;
    }
    this.plannedVolume.fill(0);
    this.noiseRound = Math.imul(this.noiseRound + 1, 0x27d4eb2f);
  }

  /** Picks the next edge when a car has reached its destination and needs a space. */
  private continueSearch(car: number, edge: number, now: number): number {
    const trip = this.trips[car];
    const { curbSpaces, curbUsed, n, config } = this;
    if (!trip.needsStreetParking) return -1;
    const here = n.edgeTo[edge];
    if (this.reserved[car]) {
      this.found++;
      return -1;
    }
    // A free space on the road just driven, if the driver finds it.
    const share = 1 / config.sampleRate;
    const free = curbSpaces[edge] - curbUsed[edge];
    // Each space on the road is seen in passing, so a nearly full road is easy to drive past.
    if (free > 0 && this.random() < Math.min(1, free / Math.max(curbSpaces[edge] * SPOT_CHANCE_SHARE, 1))) {
      curbUsed[edge] += Math.min(share, free);
      this.found++;
      return -1;
    }
    if (this.cruiseCount[car] >= CRUISE_LIMIT_EDGES) {
      this.gaveUp++;
      return -1;
    }
    this.cruiseCount[car]++;
    const start = n.outStart[here];
    const options = n.outStart[here + 1] - start;
    if (options === 0) return -1;
    if (this.onTes[car] && config.tesParking && this.random() < config.mapAccuracy) {
      const first = this.routeToSpace(car, here);
      if (first >= 0) return first;
    }
    return n.outgoing[start + Math.floor(this.random() * options)];
  }

  /** Searches outward from a junction for the nearest road the live map says has a free space. */
  private routeToSpace(car: number, start: number) {
    const { n, curbSpaces, curbUsed, searchPrevious, searchStamp } = this;
    const stamp = ++this.searchId;
    const queue = this.searchQueue;
    let head = 0;
    let tail = 0;
    for (let i = n.outStart[start]; i < n.outStart[start + 1]; i++) {
      const edge = n.outgoing[i];
      searchStamp[edge] = stamp;
      searchPrevious[edge] = -1;
      queue[tail++] = edge;
    }
    while (head < tail && head < SPACE_SEARCH_LIMIT) {
      const edge = queue[head++];
      if (curbSpaces[edge] - curbUsed[edge] >= 1 / this.config.sampleRate) {
        const path: number[] = [];
        for (let e = edge; e >= 0; e = searchPrevious[e]) path.push(e);
        this.reservePool(path.length);
        const begin = this.poolUsed;
        for (let i = path.length - 1; i >= 0; i--) this.pool[this.poolUsed++] = path[i];
        this.routeAt[car] = begin;
        this.routeEnd[car] = this.poolUsed;
        // The space is held for this driver, as a reservation would.
        curbUsed[edge] += 1 / this.config.sampleRate;
        this.reserved[car] = 1;
        this.newRoute = true;
        return path[path.length - 1];
      }
      const node = n.edgeTo[edge];
      for (let i = n.outStart[node]; i < n.outStart[node + 1] && tail < queue.length; i++) {
        const next = n.outgoing[i];
        if (searchStamp[next] === stamp) continue;
        searchStamp[next] = stamp;
        searchPrevious[next] = edge;
        queue[tail++] = next;
      }
    }
    return -1;
  }

  private moveCars(now: number) {
    const { head, tail, count, credit, capacityPerStep, storage, earliest, pool, routeAt, routeEnd, nextCar, active } = this;
    let writeIndex = 0;
    const edges = this.activeEdges;
    const total = this.activeCount;
    for (let i = 0; i < total; i++) {
      const edge = edges[i];
      credit[edge] = Math.min(credit[edge] + capacityPerStep[edge], capacityPerStep[edge] + 1);
      let car = head[edge];
      while (car >= 0 && earliest[car] <= now && credit[edge] >= 1) {
        let target = -1;
        const at = routeAt[car] + 1;
        if (at < routeEnd[car]) target = pool[at];
        else {
          if (this.driveEnd[car] === 0) this.driveEnd[car] = now;
          target = this.continueSearch(car, edge, now);
        }
        const blocked = target >= 0 && count[target] >= storage[target] && (this.blockedSince[edge] < 0 || now - this.blockedSince[edge] < STUCK_SECONDS);
        if (blocked) {
          if (this.blockedSince[edge] < 0) this.blockedSince[edge] = now;
          break;
        }
        this.blockedSince[edge] = -1;
        const metres = this.n.edgeLength[edge];
        const seconds = now - (earliest[car] - this.freeSeconds[edge]);
        this.edgeTimeSum[edge] += seconds;
        this.edgeTimeCount[edge]++;
        this.carKm += metres / 1000;
        this.carTimeOnEdge += seconds;
        this.delaySeconds += Math.max(0, seconds - this.freeSeconds[edge]);
        this.delayByEdge[edge] += Math.max(0, seconds - this.freeSeconds[edge]);
        this.fuel += fuelPerKm(metres / 1000 / (Math.max(seconds, 1) / 3600)) * (metres / 1000);
        if (this.cruiseCount[car] > 0) this.cruisingSeconds += seconds;
        credit[edge] -= 1;
        const following = nextCar[car];
        head[edge] = following;
        if (following < 0) tail[edge] = -1;
        count[edge]--;
        if (target >= 0) {
          if (this.newRoute) {
            // A route to a parking space was just written, starting at the road this car is joining.
            this.newRoute = false;
          } else if (at < routeEnd[car]) routeAt[car] = at;
          else routeEnd[car] = routeAt[car] = at;
          this.enter(car, target, now);
        } else {
          this.finish(car, now);
        }
        car = following;
      }
      if (head[edge] >= 0) edges[writeIndex++] = edge;
      else active[edge] = 0;
    }
    // Edges activated during this pass were appended after `total`: keep them too.
    for (let i = total; i < this.activeCount; i++) edges[writeIndex++] = edges[i];
    this.activeCount = writeIndex;
  }

  private finish(car: number, now: number) {
    this.done[car] = 1;
    this.arrived++;
    if (this.cruiseCount[car] > 0) this.cruisers++;
    this.tripEnd[car] = now;
    if (this.driveEnd[car] === 0) this.driveEnd[car] = now;
  }

  run(): RunResult {
    const { trips, config, n } = this;
    const order = trips.map((_, i) => i).sort((a, b) => trips[a].depart - trips[b].depart);
    let next = 0;
    const waiting: number[] = [];
    let waitHead = 0;
    const frameEvery = config.frameSeconds ?? 300;
    let nextFrame = 0;
    for (let now = 0; now < config.horizonSeconds; now += STEP) {
      this.time.now = now;
      if (now % config.rerouteSeconds === 0) {
        this.updateObserved();
        const horizon = now + config.rerouteSeconds;
        this.planningTime = now;
        const tes: number[] = [];
        const rest: number[] = [];
        let scan = next;
        while (scan < order.length && trips[order[scan]].depart < horizon) {
          const car = order[scan++];
          (this.onTes[car] ? tes : rest).push(car);
        }
        // TES cars plan around the routes it already knows, so non-TES drivers go first only if
        // they are also coordinated. Apps cannot see each other's plans.
        if (rest.length > 0) this.assign(rest, config.baseline);
        if (tes.length > 0) this.assign(tes, 'coordinated');
      }
      while (next < order.length && trips[order[next]].depart <= now) {
        const car = order[next++];
        this.departedAt[car] = now;
        waiting.push(car);
      }
      // A car joins its first road when there's room.
      let w = waitHead;
      const pending = waiting.length;
      for (; w < pending; w++) {
        const car = waiting[w];
        if (car < 0) continue;
        if (this.routeAt[car] >= this.routeEnd[car]) {
          this.finish(car, now);
          waiting[w] = -1;
          continue;
        }
        const first = this.pool[this.routeAt[car]];
        if (this.count[first] >= this.storage[first]) continue;
        this.enter(car, first, now);
        this.enteredAt[car] = now;
        waiting[w] = -1;
      }
      // Compact the waiting list now and then, keeping only those still waiting.
      if (now % 60 === 0) {
        const still = waiting.slice(waitHead).filter((c) => c >= 0 && !this.done[c]);
        waiting.length = 0;
        waiting.push(...still);
        waitHead = 0;
      }
      this.moveCars(now);
      if (config.onFrame && now >= nextFrame) {
        nextFrame += frameEvery;
        const speedKph = this.carTimeOnEdge > 0 ? this.carKm / (this.carTimeOnEdge / 3600) : 0;
        config.onFrame({ time: now, onEdge: this.count, moving: this.count.reduce((a, b) => a + b, 0), arrived: this.arrived, meanSpeedKph: speedKph });
      }
    }
    return this.summarize(order, n);
  }

  private summarize(order: number[], _n: Network): RunResult {
    const { trips, config } = this;
    let total = 0;
    let driveTotal = 0;
    let entryTotal = 0;
    let rushTotal = 0;
    let rushCount = 0;
    let finishedTotal = 0;
    const allMinutes = new Float32Array(order.length);
    // Clock zero is 5 AM, so this window is departures from 7 to 9 AM.
    const rushStart = 2 * 3600;
    const rushEnd = 4 * 3600;
    for (let i = 0; i < order.length; i++) {
      const car = order[i];
      const trip = trips[car];
      // Queueing to join the first road counts: that wait is real. So do unfinished trips, up to the horizon.
      const end = this.done[car] ? this.tripEnd[car] : config.horizonSeconds;
      const driveEnd = this.driveEnd[car] || config.horizonSeconds;
      const minutes = (end - trip.depart + ACCESS_SECONDS) / 60;
      total += minutes;
      allMinutes[i] = minutes;
      if (this.done[car]) finishedTotal += minutes;
      driveTotal += (driveEnd - trip.depart + ACCESS_SECONDS) / 60;
      entryTotal += (this.enteredAt[car] ? this.enteredAt[car] - trip.depart : end - trip.depart) / 60;
      if (trip.depart >= rushStart && trip.depart < rushEnd) {
        rushTotal += minutes;
        rushCount++;
      }
    }
    const count = trips.length || 1;
    allMinutes.sort();
    const hours = this.carTimeOnEdge / 3600;
    const scale = 1 / config.sampleRate;
    return {
      trips: trips.length,
      finished: this.arrived,
      meanMinutes: total / count,
      meanDriveMinutes: driveTotal / count,
      meanEntryWaitMinutes: entryTotal / count,
      rushMeanMinutes: rushCount ? rushTotal / rushCount : 0,
      medianMinutes: allMinutes[Math.floor(allMinutes.length / 2)] ?? 0,
      finishedMeanMinutes: this.arrived ? finishedTotal / this.arrived : 0,
      p90Minutes: allMinutes[Math.floor(allMinutes.length * 0.9)] ?? 0,
      vehicleHours: hours,
      vehicleKm: this.carKm,
      delayHours: this.delaySeconds / 3600,
      fuelLitres: this.fuel,
      cruisingHours: this.cruisingSeconds / 3600,
      meanCruiseMinutes: this.cruisers ? this.cruisingSeconds / this.cruisers / 60 : 0,
      foundParking: this.found,
      gaveUpParking: this.gaveUp,
      scaled: { vehicleHours: hours * scale, vehicleKm: this.carKm * scale, delayHours: (this.delaySeconds / 3600) * scale, fuelLitres: this.fuel * scale },
    };
  }
}
