// The Traffic Efficiency System. Takes everything known about traffic and parking and recommends
// a route and a stall for each car. It lives in shared code so the live platform and the offline
// studies run exactly the same logic. It is deterministic: Muse Spark sets goals, it does not route.
import { distance, type CityMap, type Stall, type Vec2 } from './city';
import type { DirectedEdge, RoadGraph } from './route';

export interface VehicleReport {
  carId: string;
  edge: DirectedEdge;
  speed: number;
}

export type SignalAxis = 'ew' | 'ns';

const FREE_SPEED = 11;
const SECONDS_PER_MOVING_CAR = 1;
const SECONDS_PER_STOPPED_CAR = 3.5;
const SECONDS_PER_PLANNED_CAR = 0.6;
const SECONDS_PER_UNSEEN_CAR = 1.5;
const GPS_FRESH_SECONDS = 5;
const CAMERA_FRESH_SECONDS = 30;
const WALKING_SPEED = 1.3;
/** A minute walking feels worse than a minute driving. */
const WALK_WEIGHT = 1.5;
const GARAGE_ENTRY_SECONDS = 15;
const SECONDS_PER_GARAGE_LEVEL = 6;

const keyOf = (e: DirectedEdge) => `${e.from}>${e.to}`;

interface EdgeLoad {
  moving: number;
  stopped: number;
  planned: number;
  unseen: number;
}

const emptyLoad = (): EdgeLoad => ({ moving: 0, stopped: 0, planned: 0, unseen: 0 });

export class TrafficEngine {
  private readonly reports = new Map<string, { report: VehicleReport; at: number }>();
  private readonly cameraCounts = new Map<string, { count: number; at: number }>();
  private readonly planned = new Map<string, DirectedEdge[]>();
  private load = new Map<string, EdgeLoad>();
  private loadAt = -Infinity;
  /** Extra seconds to avoid a street, set by an operator's goals. Street name to seconds. */
  readonly streetPenalties = new Map<string, number>();

  constructor(
    private readonly city: CityMap,
    private readonly graph: RoadGraph,
  ) {}

  /** A participating car's GPS. Exact, but it only covers people who share their location. */
  reportVehicle(report: VehicleReport, now: number) {
    this.reports.set(report.carId, { report, at: now });
  }

  /** Vehicles a camera saw on a street. Covers everyone, including cars not on the network. */
  reportCameraCount(segmentId: string, count: number, now: number) {
    this.cameraCounts.set(segmentId, { count, at: now });
  }

  forgetCar(carId: string) {
    this.reports.delete(carId);
    this.planned.delete(carId);
  }

  private refreshLoad(now: number) {
    if (now === this.loadAt) return;
    this.loadAt = now;
    const load = new Map<string, EdgeLoad>();
    const at = (e: DirectedEdge) => {
      const key = keyOf(e);
      let entry = load.get(key);
      if (!entry) {
        entry = emptyLoad();
        load.set(key, entry);
      }
      return entry;
    };
    const seenOnSegment = new Map<string, number>();
    for (const [carId, { report, at: reportedAt }] of this.reports) {
      if (now - reportedAt > GPS_FRESH_SECONDS) {
        this.reports.delete(carId);
        continue;
      }
      const entry = at(report.edge);
      if (report.speed < 1) entry.stopped++;
      else entry.moving++;
      const seg = this.graph.segmentBetween(report.edge.from, report.edge.to).id;
      seenOnSegment.set(seg, (seenOnSegment.get(seg) ?? 0) + 1);
    }
    for (const chain of this.planned.values()) {
      for (const edge of chain) at(edge).planned++;
    }
    // A camera count above what GPS explains means cars that are not on the network.
    for (const [segmentId, { count, at: seenAt }] of this.cameraCounts) {
      if (now - seenAt > CAMERA_FRESH_SECONDS) continue;
      const unseen = Math.max(0, count - (seenOnSegment.get(segmentId) ?? 0));
      const seg = this.graph.segment(segmentId);
      at({ from: seg.a, to: seg.b }).unseen += unseen / 2;
      at({ from: seg.b, to: seg.a }).unseen += unseen / 2;
    }
    this.load = load;
  }

  /** How much longer a street takes than in free-flowing traffic. Ignores operator goals. */
  congestion(edge: DirectedEdge, now: number): number {
    const seg = this.graph.segmentBetween(edge.from, edge.to);
    const penalty = this.streetPenalties.get(seg.street) ?? 0;
    return (this.edgeSeconds(edge, now) - penalty) / (seg.length / FREE_SPEED);
  }

  /** Estimated seconds to drive a street right now. */
  edgeSeconds(edge: DirectedEdge, now: number): number {
    this.refreshLoad(now);
    const load = this.load.get(keyOf(edge)) ?? emptyLoad();
    const seg = this.graph.segmentBetween(edge.from, edge.to);
    return (
      seg.length / FREE_SPEED +
      load.moving * SECONDS_PER_MOVING_CAR +
      load.stopped * SECONDS_PER_STOPPED_CAR +
      load.planned * SECONDS_PER_PLANNED_CAR +
      load.unseen * SECONDS_PER_UNSEEN_CAR +
      (this.streetPenalties.get(seg.street) ?? 0)
    );
  }

  /** The quickest route given current traffic. Other cars then see this car's plan. */
  planRoute(carId: string, start: DirectedEdge, goal: DirectedEdge, now: number): DirectedEdge[] {
    const chain = this.graph.route(start, goal, (edge) => this.edgeSeconds(edge, now));
    this.planned.set(carId, chain.slice(1));
    return chain;
  }

  /** The stall with the lowest combined cost of driving there and walking on. */
  chooseStall(start: DirectedEdge, destination: Vec2, available: (stall: Stall) => boolean, now: number): Stall | null {
    const seconds = this.graph.secondsFrom(start, (edge) => this.edgeSeconds(edge, now));
    let best: Stall | null = null;
    let bestScore = Infinity;
    for (const stall of this.city.stalls) {
      if (!available(stall)) continue;
      const drive = seconds.get(keyOf(this.graph.approachEdge(stall)));
      if (drive === undefined) continue;
      const walk = (distance(stall.center, destination) / WALKING_SPEED) * WALK_WEIGHT;
      const garage = stall.garageId ? GARAGE_ENTRY_SECONDS + (stall.level ?? 0) * SECONDS_PER_GARAGE_LEVEL : 0;
      const score = drive + walk + garage;
      if (score < bestScore) {
        bestScore = score;
        best = stall;
      }
    }
    return best;
  }

  /** Which direction each light should favor: wherever the most cars are waiting or arriving. */
  signalPlan(nodes: string[], now: number): Map<string, SignalAxis> {
    this.refreshLoad(now);
    const plan = new Map<string, SignalAxis>();
    for (const nodeId of nodes) {
      const pressure: Record<SignalAxis, number> = { ew: 0, ns: 0 };
      for (const out of this.graph.next(nodeId)) {
        const incoming = { from: out.to, to: nodeId };
        const load = this.load.get(keyOf(incoming));
        if (!load) continue;
        const dir = this.graph.edgeDir(incoming);
        const axis: SignalAxis = Math.abs(dir.x) > Math.abs(dir.z) ? 'ew' : 'ns';
        pressure[axis] += load.stopped * 2 + load.moving + load.planned * 0.5 + load.unseen;
      }
      if (pressure.ew !== pressure.ns) plan.set(nodeId, pressure.ew > pressure.ns ? 'ew' : 'ns');
    }
    return plan;
  }
}
