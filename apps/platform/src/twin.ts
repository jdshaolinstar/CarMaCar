// One live parking map per visitor session. Its only input is what vision observed.
import type {
  AgentEvent,
  ParkingVision,
  TrashVision,
  CityMap,
  FrameReport,
  Stall,
  StallState,
  TripPlan,
  TwinSnapshot,
  TwinStall,
  Vec2,
} from '@carmacar/shared';
import { distance, RoadGraph, TrafficEngine } from '@carmacar/shared';
import type { StallObservation } from './vision/stalls';

/** Old evidence fades on this timescale, so a changed stall flips on the next pass. */
const EVIDENCE_TAU_MS = 12_000;
const KEEP_EVIDENCE_MS = 60_000;
const MIN_SCORE = 0.02;
const MAX_FRAMES = 12;
const MAX_EVENTS = 60;

interface TrashPin {
  x: number;
  z: number;
  misses: number;
  category: string;
}

const TRASH_MATCH_METRES = 3;
const TRASH_MISSES_TO_CLEAR = 2;

interface Evidence {
  at: number;
  signed: number;
}

export class Twin {
  private readonly evidence = new Map<string, Evidence[]>();
  private readonly state = new Map<string, TwinStall>();
  private readonly frames: FrameReport[] = [];
  private readonly events: AgentEvent[] = [];
  private readonly arrivedCars = new Set<string>();
  readonly trips = new Map<string, TripPlan>();
  readonly karma = new Map<string, number>();
  readonly graph: RoadGraph;
  readonly tes: TrafficEngine;
  tesEnabled = true;
  smartLights = false;
  parkingVision: ParkingVision = 'sam';
  trashVision: TrashVision = 'spark';
  strategist = false;
  trashScanBusy = false;
  trashNote: string | null = null;
  cameraTrafficCounts = 0;
  frameCount = 0;
  private readonly trash = new Map<string, TrashPin>();
  private nextTrashId = 1;
  lastSeen = Date.now();

  constructor(private readonly city: CityMap) {
    this.graph = new RoadGraph(city);
    this.tes = new TrafficEngine(city, this.graph);
    for (const s of city.stalls) {
      this.state.set(s.id, { state: 'unknown', confidence: 0, updatedAt: null, reservedBy: null });
    }
  }

  stall(id: string) {
    return this.state.get(id);
  }

  /** Applies a frame's observations. Returns stalls whose state changed. */
  observe(observations: StallObservation[], at: number): { stallId: string; from: StallState; to: StallState }[] {
    const changed: { stallId: string; from: StallState; to: StallState }[] = [];
    for (const o of observations) {
      const list = (this.evidence.get(o.stallId) ?? []).filter((e) => at - e.at < KEEP_EVIDENCE_MS);
      list.push({ at, signed: o.state === 'occupied' ? o.weight : -o.weight });
      this.evidence.set(o.stallId, list);

      let score = 0;
      let total = 0;
      for (const e of list) {
        const decay = Math.exp(-(at - e.at) / EVIDENCE_TAU_MS);
        score += e.signed * decay;
        total += Math.abs(e.signed) * decay;
      }
      const stall = this.state.get(o.stallId)!;
      const before = stall.state;
      if (Math.abs(score) >= MIN_SCORE) stall.state = score > 0 ? 'occupied' : 'free';
      stall.confidence = total > 0 ? Math.abs(score) / total : 0;
      stall.updatedAt = at;
      if (stall.state !== before) changed.push({ stallId: o.stallId, from: before, to: stall.state });
    }
    return changed;
  }

  addFrame(report: FrameReport) {
    this.frames.unshift(report);
    this.frames.length = Math.min(this.frames.length, MAX_FRAMES);
  }

  addEvent(event: Omit<AgentEvent, 'at'>) {
    this.events.unshift({ ...event, at: Date.now() });
    this.events.length = Math.min(this.events.length, MAX_EVENTS);
  }

  /** Nearest free, unreserved stall to a destination, preferring fresher sightings. */
  findParking(target: Vec2, exclude: string[] = []): { stall: Stall; walkMeters: number } | null {
    const now = Date.now();
    let best: { stall: Stall; walkMeters: number; score: number } | null = null;
    for (const s of this.city.stalls) {
      const t = this.state.get(s.id)!;
      if (t.state !== 'free' || t.reservedBy || exclude.includes(s.id)) continue;
      const walkMeters = distance(s.center, target);
      const ageSeconds = t.updatedAt ? (now - t.updatedAt) / 1000 : 600;
      const score = walkMeters + ageSeconds * 0.25;
      if (!best || score < best.score) best = { stall: s, walkMeters, score };
    }
    return best ? { stall: best.stall, walkMeters: Math.round(best.walkMeters) } : null;
  }

  reserve(stallId: string, carId: string): boolean {
    const t = this.state.get(stallId);
    if (!t || (t.reservedBy && t.reservedBy !== carId)) return false;
    this.release(carId);
    t.reservedBy = carId;
    return true;
  }

  release(carId: string) {
    this.arrivedCars.delete(carId);
    for (const t of this.state.values()) {
      if (t.reservedBy === carId) t.reservedBy = null;
    }
  }

  /**
   * The holder has finished driving. The stall stays held so nobody else is sent there, but the map
   * state does not change: it still takes a camera to mark a stall occupied.
   */
  markArrived(carId: string) {
    this.arrivedCars.add(carId);
  }

  hasArrived(carId: string) {
    return this.arrivedCars.has(carId);
  }

  /** Updates trash pins from one scanned frame. A pin clears only after cameras see the spot empty twice. */
  observeTrash(sightings: (Vec2 & { category?: string })[], inView: (point: Vec2) => boolean) {
    const matched = new Set<string>();
    for (const seen of sightings) {
      let hit: string | null = null;
      for (const [id, pin] of this.trash) {
        if (distance(pin, seen) < TRASH_MATCH_METRES) hit = id;
      }
      if (hit) {
        matched.add(hit);
        this.trash.get(hit)!.misses = 0;
      } else {
        const id = `t${this.nextTrashId++}`;
        this.trash.set(id, { x: seen.x, z: seen.z, misses: 0, category: seen.category ?? 'trash' });
        matched.add(id);
      }
    }
    for (const [id, pin] of this.trash) {
      if (matched.has(id) || !inView(pin)) continue;
      pin.misses++;
      if (pin.misses >= TRASH_MISSES_TO_CLEAR) this.trash.delete(id);
    }
  }

  /** Is this stall free and unclaimed, as far as the map knows? */
  available(stall: Stall, exclude: string[]) {
    const t = this.state.get(stall.id)!;
    return t.state === 'free' && !t.reservedBy && !exclude.includes(stall.id);
  }

  private trafficLevels(): Record<string, number> {
    const now = Date.now() / 1000;
    const levels: Record<string, number> = {};
    for (const seg of this.city.segments) {
      const worst = Math.max(this.tes.congestion({ from: seg.a, to: seg.b }, now), this.tes.congestion({ from: seg.b, to: seg.a }, now));
      levels[seg.id] = +worst.toFixed(2);
    }
    return levels;
  }

  snapshot(frameLimit: number, budgetExhausted: boolean): TwinSnapshot {
    return {
      now: Date.now(),
      stalls: Object.fromEntries(this.state),
      frames: this.frames,
      agentEvents: this.events,
      trips: [...this.trips.values()],
      karma: Object.fromEntries(this.karma),
      usage: { frames: this.frameCount, frameLimit, budgetExhausted },
      traffic: this.trafficLevels(),
      cameraTrafficCounts: this.cameraTrafficCounts,
      avoidedStreets: [...this.tes.streetPenalties.keys()],
      trashPins: [...this.trash].map(([id, pin]) => ({ id, x: pin.x, z: pin.z, category: pin.category })),
      trashNote: this.trashNote,
    };
  }
}
