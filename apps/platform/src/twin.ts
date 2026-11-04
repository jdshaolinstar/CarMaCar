// One live parking map per visitor session. Its only input is what vision observed.
import type {
  AgentEvent,
  CityMap,
  FrameReport,
  Stall,
  StallState,
  TripPlan,
  TwinSnapshot,
  TwinStall,
  Vec2,
} from '@carmacar/shared';
import { distance } from '@carmacar/shared';
import type { StallObservation } from './vision/stalls';

/** Old evidence fades on this timescale, so a changed stall flips on the next pass. */
const EVIDENCE_TAU_MS = 12_000;
const KEEP_EVIDENCE_MS = 60_000;
const MIN_SCORE = 0.02;
const MAX_FRAMES = 12;
const MAX_EVENTS = 60;

interface Evidence {
  at: number;
  signed: number;
}

export class Twin {
  private readonly evidence = new Map<string, Evidence[]>();
  private readonly state = new Map<string, TwinStall>();
  private readonly frames: FrameReport[] = [];
  private readonly events: AgentEvent[] = [];
  readonly trips = new Map<string, TripPlan>();
  readonly karma = new Map<string, number>();
  frameCount = 0;
  lastSeen = Date.now();

  constructor(private readonly city: CityMap) {
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
    for (const t of this.state.values()) {
      if (t.reservedBy === carId) t.reservedBy = null;
    }
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
    };
  }
}
