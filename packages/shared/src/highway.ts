// The ring highway, and the TES logic that manages it. This file is product code: the controller
// only ever sees what connected cars report and what ramp cameras count, never the simulator's truth.

export const MPH = 0.44704;

export interface Interchange {
  id: number;
  name: string;
  /** Where the off-ramp leaves the mainline, in metres round the ring. */
  offAt: number;
  /** Where the on-ramp's merge lane starts. */
  onAt: number;
}

export interface HighwayLayout {
  length: number;
  lanes: number;
  rampLength: number;
  mergeLength: number;
  rampSpeed: number;
  /** Stop-line signal timing at the end of each off-ramp. */
  cycleSeconds: number;
  baseRampGreen: number;
  minRampGreen: number;
  maxRampGreen: number;
  allRedSeconds: number;
  /** Roughly how many cars fit on an off-ramp. */
  rampStorage: number;
  /** Cars per second a ramp discharges during green. */
  saturationFlow: number;
  interchanges: Interchange[];
}

const INTERCHANGE_NAMES = ['Pine', 'Market', 'Mission', 'Harbor', 'Stadium'];
const CAR_SPACE = 7.5;

export function highwayLayout(length = 2200): HighwayLayout {
  const spacing = length / INTERCHANGE_NAMES.length;
  const rampLength = 150;
  return {
    length,
    lanes: 3,
    rampLength,
    mergeLength: 160,
    rampSpeed: 16,
    cycleSeconds: 60,
    baseRampGreen: 24,
    minRampGreen: 14,
    maxRampGreen: 40,
    allRedSeconds: 3,
    rampStorage: Math.floor(rampLength / CAR_SPACE),
    saturationFlow: 0.5,
    interchanges: INTERCHANGE_NAMES.map((name, id) => ({ id, name, offAt: id * spacing, onAt: id * spacing + 110 })),
  };
}

/** Metres ahead round the ring from `from` to `to`. */
export function ringAhead(layout: HighwayLayout, from: number, to: number) {
  return ((to - from) % layout.length + layout.length) % layout.length;
}

/** Seconds of surface street from an exit to a part of town. The home exit is the shortest. */
export function surfaceSeconds(layout: HighwayLayout, zone: number, exit: number) {
  const n = layout.interchanges.length;
  const hops = Math.min((exit - zone + n) % n, (zone - exit + n) % n);
  return 30 + hops * 75;
}

export interface HighwayCarReport {
  carId: string;
  place: 'main' | 'offramp';
  /** Ring position when on the mainline. */
  s: number;
  lane: number;
  speed: number;
  exit: number;
  /** The part of town the driver is heading for. */
  zone: number;
}

export interface HighwayAdvice {
  exit: number;
  /** Move to the exit lane now, while it is easy. */
  prepare: boolean;
  /** Stay out of the right lane: a busy exit is ahead and this car isn't taking it. */
  keepLeft: boolean;
  /** Suggested speed, when a queue is building ahead. */
  speed: number | null;
}

export interface HighwayTesOptions {
  /** Ramp cameras count every car, including those not on the network. */
  cameras: boolean;
  prepare: boolean;
  keepLeft: boolean;
  rebalance: boolean;
  smartSignals: boolean;
  harmonize: boolean;
}

export const PREPARE_METERS = 800;
const COMMIT_METERS = 450;
const KEEP_LEFT_METERS = 400;
const ARRIVAL_HORIZON_SECONDS = 90;
const SWITCH_SAVING_SECONDS = 25;
const REPORT_EXPIRY_SECONDS = 6;
const CAMERA_EXPIRY_SECONDS = 12;
const HARMONIZE_NEAR = 150;
const HARMONIZE_FAR = 700;
const HARMONIZE_FACTOR = 0.75;
/** A busy exit, as a share of what the ramp can hold, at which through cars are asked to keep left. */
const BUSY_RAMP_SHARE = 0.5;

export interface ExitEstimate {
  exit: number;
  /** Estimated cars on the ramp now. */
  queue: number;
  /** Estimated cars arriving soon, scaled up for cars that aren't reporting. */
  arriving: number;
  /** Estimated seconds of wait for a car arriving now. */
  waitSeconds: number;
  /** Cross-street queue from the camera, if any. */
  crossQueue: number;
  rampGreen: number;
}

export class HighwayTes {
  private readonly reports = new Map<string, HighwayCarReport & { at: number }>();
  private readonly rampCounts = new Map<number, { count: number; cross: number; at: number }>();
  /** Reporting share of cars on the ramps, learned by comparing GPS against camera counts. */
  private share = 1;

  constructor(
    readonly layout: HighwayLayout,
    readonly options: HighwayTesOptions,
    readonly speedLimit: () => number,
  ) {}

  reportCar(report: HighwayCarReport, now: number) {
    this.reports.set(report.carId, { ...report, at: now });
  }

  forgetCar(carId: string) {
    this.reports.delete(carId);
  }

  /** A camera on the ramp counted these cars. It cannot tell who they are or where they are going. */
  reportRampCamera(exit: number, count: number, crossCount: number, now: number) {
    if (!this.options.cameras) return;
    this.rampCounts.set(exit, { count, cross: crossCount, at: now });
  }

  /** The fraction of traffic TES can see. Without cameras it has no way to know, so it assumes all of it. */
  get reportingShare() {
    return this.share;
  }

  private learnShare(now: number) {
    if (!this.options.cameras) return;
    let seen = 0;
    let counted = 0;
    for (const [exit, camera] of this.rampCounts) {
      if (now - camera.at > CAMERA_EXPIRY_SECONDS) continue;
      counted += camera.count;
      for (const r of this.reports.values()) if (r.place === 'offramp' && r.exit === exit && now - r.at <= REPORT_EXPIRY_SECONDS) seen++;
    }
    // Needs enough cars to be meaningful, then moves slowly so one bad count doesn't swing it.
    if (counted >= 6) this.share += (Math.min(1, Math.max(0.05, seen / counted)) - this.share) * 0.15;
  }

  estimates(now: number): ExitEstimate[] {
    this.learnShare(now);
    const { interchanges, cycleSeconds, saturationFlow, rampStorage } = this.layout;
    const limit = this.speedLimit();
    return interchanges.map((ic) => {
      let onRamp = 0;
      let arriving = 0;
      for (const r of this.reports.values()) {
        if (r.exit !== ic.id || now - r.at > REPORT_EXPIRY_SECONDS) continue;
        if (r.place === 'offramp') onRamp++;
        else if (ringAhead(this.layout, r.s, ic.offAt) / Math.max(limit * 0.6, 1) < ARRIVAL_HORIZON_SECONDS) arriving++;
      }
      const camera = this.rampCounts.get(ic.id);
      const fresh = camera && now - camera.at <= CAMERA_EXPIRY_SECONDS ? camera : null;
      const queue = fresh ? fresh.count : onRamp / this.share;
      const scaledArriving = arriving / this.share;
      const crossQueue = fresh?.cross ?? 0;
      const rampGreen = this.chooseGreen(queue, scaledArriving, crossQueue);
      const discharge = (saturationFlow * rampGreen) / cycleSeconds;
      const overflow = Math.max(0, queue - rampStorage * 0.4);
      return { exit: ic.id, queue, arriving: scaledArriving, crossQueue, rampGreen, waitSeconds: (queue + overflow) / discharge };
    });
  }

  private chooseGreen(queue: number, arriving: number, crossQueue: number) {
    const { baseRampGreen, minRampGreen, maxRampGreen } = this.layout;
    if (!this.options.smartSignals) return baseRampGreen;
    const ramp = queue + arriving * 0.5;
    const pressure = (ramp + 1) / (ramp + crossQueue + 2);
    return Math.round(Math.min(maxRampGreen, Math.max(minRampGreen, baseRampGreen * 2 * pressure)));
  }

  /** Green seconds for the ramp this cycle. */
  rampGreen(exit: number, now: number) {
    return this.estimates(now)[exit].rampGreen;
  }

  advise(now: number): Map<string, HighwayAdvice> {
    const advice = new Map<string, HighwayAdvice>();
    const estimates = this.estimates(now);
    const load = estimates.map((e) => ({ ...e }));
    const { interchanges, length, rampStorage, cycleSeconds, saturationFlow } = this.layout;
    const limit = this.speedLimit();
    const cars = [...this.reports.values()].filter((r) => r.place === 'main' && now - r.at <= REPORT_EXPIRY_SECONDS);
    // Closest to their exits first, so the cars with the least room decide first.
    cars.sort((a, b) => ringAhead(this.layout, a.s, interchanges[a.exit].offAt) - ringAhead(this.layout, b.s, interchanges[b.exit].offAt));

    for (const car of cars) {
      let exit = car.exit;
      const distance = ringAhead(this.layout, car.s, interchanges[exit].offAt);
      if (this.options.rebalance && distance > COMMIT_METERS) {
        const cost = (id: number) =>
          ringAhead(this.layout, car.s, interchanges[id].offAt) / Math.max(limit * 0.8, 1) + load[id].waitSeconds + surfaceSeconds(this.layout, car.zone, id);
        let best = exit;
        let bestCost = cost(exit) - SWITCH_SAVING_SECONDS;
        for (const ic of interchanges) {
          if (ringAhead(this.layout, car.s, ic.offAt) < COMMIT_METERS) continue;
          const c = cost(ic.id);
          if (c < bestCost) {
            best = ic.id;
            bestCost = c;
          }
        }
        if (best !== exit) {
          // Count this car against its new exit at once, so the next car sees it and traffic doesn't herd.
          const step = 1 / this.share;
          const discharge = (id: number) => (saturationFlow * load[id].rampGreen) / cycleSeconds;
          load[exit].arriving = Math.max(0, load[exit].arriving - step);
          load[exit].waitSeconds = Math.max(0, load[exit].waitSeconds - step / discharge(exit));
          load[best].arriving += step;
          load[best].waitSeconds += step / discharge(best);
          exit = best;
        }
      }

      const toExit = ringAhead(this.layout, car.s, interchanges[exit].offAt);
      const prepare = this.options.prepare && toExit <= PREPARE_METERS;
      let keepLeft = false;
      let speed: number | null = null;
      for (const ic of interchanges) {
        const ahead = ringAhead(this.layout, car.s, ic.offAt);
        const e = load[ic.id];
        if (this.options.keepLeft && ic.id !== exit && ahead < KEEP_LEFT_METERS && e.queue + e.arriving >= rampStorage * BUSY_RAMP_SHARE) keepLeft = true;
        if (this.options.harmonize && ahead > HARMONIZE_NEAR && ahead < HARMONIZE_FAR && e.queue >= rampStorage * 0.8) speed = limit * HARMONIZE_FACTOR;
      }
      advice.set(car.carId, { exit, prepare, keepLeft, speed });
    }
    void length;
    return advice;
  }
}
