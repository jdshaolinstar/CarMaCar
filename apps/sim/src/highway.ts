// A multi-lane ring highway, simulated car by car. This is the simulated world, not the product:
// HighwayTes in the shared package sees only reports and camera counts, as the real one would.
//
// Drivers follow the Intelligent Driver Model. Lane changes are gap-accepting, with drivers growing
// more forceful as their exit nears. Congestion is not scripted: it comes from cars cutting across
// lanes late, ramps filling up, and queues reaching back onto the mainline.
//
// Every driver keeps the same following distance whatever guides them, so any gain from TES comes
// from knowing where cars are going, not from packing autopilot cars closer together.
import { HighwayTes, ringAhead, surfaceSeconds, type HighwayAdvice, type HighwayLayout, type HighwayTesOptions } from '@carmacar/shared';

export type HighwayDriver = 'human' | 'guided' | 'autopilot';
type Place = 'waiting' | 'onramp' | 'main' | 'offramp' | 'surface' | 'done';

export interface HighwayCar {
  id: string;
  driver: HighwayDriver;
  place: Place;
  spawnAt: number;
  entry: number;
  zone: number;
  exit: number;
  /** Ring position on the mainline, or distance along a ramp. */
  s: number;
  lane: number;
  v: number;
  a: number;
  desire: number;
  /** How far from the exit a human starts heading for the exit lane. */
  decisionMeters: number;
  willComply: boolean;
  laneCooldown: number;
  advice: HighwayAdvice | null;
  doneAt: number;
  missed: number;
  /** Seconds spent stopped in the wrong lane, waiting to be let in at the exit. */
  gaveWay: number;
  length: number;
}

export interface HighwayDemand {
  at: number;
  entry: number;
  zone: number;
  desire: number;
  decisionMeters: number;
  /** Fixed per driver, so the same people become guided or autopilot as adoption rises. */
  adoptionRoll: number;
  complianceRoll: number;
}

export interface HighwayMix {
  guidedShare: number;
  autopilotShare: number;
}

export interface HighwayConfig {
  speedLimit: number;
  demand: HighwayDemand[];
  mix: HighwayMix;
  /** Off means no TES at all: fixed lights, no advice. */
  tes: HighwayTesOptions | null;
  horizonSeconds: number;
  /** Cross-street arrivals per second at each ramp's stop line. */
  crossRate: number;
  /** Chance a ramp camera sees a given car. */
  cameraRecall: number;
  seed: number;
}

export interface HighwayResult {
  trips: number;
  finished: number;
  /** Includes unfinished trips, counted up to the horizon, so a stuck road can't flatter itself. */
  meanTripSeconds: number;
  /** Mainline speed averaged over car-seconds. */
  meanMainlineMph: number;
  /** Share of mainline car-seconds below 30 mph. */
  slowShare: number;
  missedExits: number;
  /** Seconds, summed over ramps, that a full ramp held cars back on the mainline. */
  spillbackSeconds: number;
  hardBrakeSeconds: number;
  /** Mean cross-street wait, so green time for the ramp is not treated as free. */
  crossDelaySeconds: number;
  /** Cross-street cars waiting at the end, when the street has fallen behind. */
  crossQueueLeft: number;
  /** Highway trip time plus cross-street waiting, in vehicle-hours. The fair total. */
  systemHours: number;
  /** Cars that overlapped. Should always be zero. */
  overlaps: number;
}

const IDM = { minGap: 2, headway: 1.4, accel: 1.4, comfort: 2.0 };
const CAR_LENGTH = 4.6;
const STEP = 0.25;
const REPORT_EVERY = 2;
const ADVICE_EVERY = 5;
const SLOW_MPH = 30;
const HARD_BRAKE = -3.5;
const LANE_COOLDOWN = 3;
const READING_FRESH_SECONDS = 15;
const EXIT_SLOWDOWN_METERS = 220;
const LAST_CHANCE_METERS = 90;
const STOP_AND_WAIT_METERS = 35;
const EXIT_PATIENCE_SECONDS = 25;
const CROSS_GREEN_FLOW = 0.5;
const CROSS_SERVED_SHARE = 1;

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a day's drivers. Same seed, same people, so modes are compared on identical demand. */
export function makeHighwayDemand(layout: HighwayLayout, seed: number, perHour: number, spanSeconds: number, zoneWeights: number[], earlier = 1): HighwayDemand[] {
  const random = mulberry(seed);
  const count = Math.round((perHour * spanSeconds) / 3600);
  const total = zoneWeights.reduce((a, b) => a + b, 0);
  const n = layout.interchanges.length;
  const demand: HighwayDemand[] = [];
  for (let i = 0; i < count; i++) {
    const entry = Math.floor(random() * n);
    let pick = random() * total;
    let zone = 0;
    while (pick > zoneWeights[zone] && zone < n - 1) pick -= zoneWeights[zone++];
    if (zone === entry) zone = (zone + 1 + Math.floor(random() * (n - 1))) % n;
    // Most people move over a few hundred metres out. Some leave it very late.
    const decisionMeters = (120 + 480 * random() * random()) * earlier;
    demand.push({
      at: random() * spanSeconds,
      entry,
      zone,
      desire: 0.93 + random() * 0.19,
      decisionMeters,
      adoptionRoll: random(),
      complianceRoll: random(),
    });
  }
  return demand.sort((a, b) => a.at - b.at);
}

function idm(v: number, desired: number, gap: number, closing: number) {
  const free = 1 - (v / Math.max(desired, 0.5)) ** 4;
  if (gap >= 1e6) return IDM.accel * free;
  const wanted = IDM.minGap + Math.max(0, v * IDM.headway + (v * closing) / (2 * Math.sqrt(IDM.accel * IDM.comfort)));
  return IDM.accel * (free - (wanted / Math.max(gap, 0.1)) ** 2);
}

export class HighwaySim {
  readonly cars: HighwayCar[] = [];
  readonly tes: HighwayTes | null;
  time = 0;
  private readonly lanes: HighwayCar[][];
  private readonly onRamps: HighwayCar[][];
  private readonly offRamps: HighwayCar[][];
  private readonly waiting: HighwayCar[][];
  private readonly cycleStart: number[];
  private readonly rampGreen: number[];
  private readonly crossQueue: number[];
  private readonly random: () => number;
  /** Real counts from a vision model. When one is fresh it replaces the simulated camera for that ramp. */
  private readonly rampReadings = new Map<number, { count: number; at: number }>();
  private nextDemand = 0;
  private lastReport = -Infinity;
  private lastAdvice = -Infinity;
  private carTime = 0;
  private carDistance = 0;
  private slowTime = 0;
  private spillback = 0;
  private hardBrake = 0;
  private crossDelay = 0;
  private crossServed = 0;
  private overlaps = 0;
  private missed = 0;

  constructor(
    readonly layout: HighwayLayout,
    readonly config: HighwayConfig,
  ) {
    const n = layout.interchanges.length;
    this.lanes = Array.from({ length: layout.lanes }, () => []);
    this.onRamps = Array.from({ length: n }, () => []);
    this.offRamps = Array.from({ length: n }, () => []);
    this.waiting = Array.from({ length: n }, () => []);
    this.cycleStart = Array(n).fill(0);
    this.rampGreen = Array(n).fill(layout.baseRampGreen);
    this.crossQueue = Array(n).fill(0);
    this.random = mulberry(config.seed + 7919);
    this.tes = config.tes ? new HighwayTes(layout, config.tes, () => this.config.speedLimit) : null;
  }

  private spawn() {
    const { demand, mix } = this.config;
    while (this.nextDemand < demand.length && demand[this.nextDemand].at <= this.time) {
      const d = demand[this.nextDemand];
      const driver: HighwayDriver =
        d.adoptionRoll < mix.autopilotShare ? 'autopilot' : d.adoptionRoll < mix.autopilotShare + mix.guidedShare ? 'guided' : 'human';
      const car: HighwayCar = {
        id: `H${this.nextDemand}`,
        driver,
        place: 'waiting',
        spawnAt: d.at,
        entry: d.entry,
        zone: d.zone,
        exit: d.zone,
        s: 0,
        lane: 0,
        v: 0,
        a: 0,
        desire: d.desire,
        decisionMeters: d.decisionMeters,
        willComply: driver === 'autopilot' || d.complianceRoll < 0.75,
        laneCooldown: 0,
        advice: null,
        doneAt: 0,
        missed: 0,
        gaveWay: 0,
        length: CAR_LENGTH,
      };
      this.cars.push(car);
      this.waiting[d.entry].push(car);
      this.nextDemand++;
    }
    for (let i = 0; i < this.waiting.length; i++) {
      const head = this.waiting[i][0];
      const ramp = this.onRamps[i];
      const tail = ramp[0];
      if (head && (!tail || tail.s > 12)) {
        this.waiting[i].shift();
        head.place = 'onramp';
        head.s = 0;
        head.v = 10;
        ramp.unshift(head);
      }
    }
  }

  private connected(car: HighwayCar) {
    return car.driver !== 'human' && this.tes !== null;
  }

  private listen() {
    if (!this.tes) return;
    const now = this.time;
    if (now - this.lastReport >= REPORT_EVERY) {
      this.lastReport = now;
      for (const lane of this.lanes) {
        for (const car of lane) {
          if (this.connected(car)) {
            this.tes.reportCar({ carId: car.id, place: 'main', s: car.s, lane: car.lane, speed: car.v, exit: car.exit, zone: car.zone }, now);
          }
        }
      }
      for (const ramp of this.offRamps) {
        for (const car of ramp) {
          if (this.connected(car)) {
            this.tes.reportCar({ carId: car.id, place: 'offramp', s: 0, lane: 0, speed: car.v, exit: car.exit, zone: car.zone }, now);
          }
        }
      }
    }
    if (now - this.lastAdvice >= ADVICE_EVERY) {
      this.lastAdvice = now;
      this.offRamps.forEach((ramp, i) => {
        let seen = 0;
        for (let k = 0; k < ramp.length; k++) if (this.random() < this.config.cameraRecall) seen++;
        const reading = this.rampReadings.get(i);
        if (reading && now - reading.at <= READING_FRESH_SECONDS) seen = reading.count;
        this.tes!.reportRampCamera(i, seen, Math.round(this.crossQueue[i]), now);
      });
      const advice = this.tes.advise(now);
      for (const lane of this.lanes) {
        for (const car of lane) {
          if (!this.connected(car)) continue;
          const a = advice.get(car.id);
          if (!a) continue;
          if (car.willComply) {
            car.advice = a;
            car.exit = a.exit;
          } else {
            car.advice = { ...a, exit: car.exit, keepLeft: false, speed: null };
          }
        }
      }
    }
  }

  /** Takes a count that a vision model read from a real frame of this ramp. */
  setRampReading(exit: number, count: number) {
    this.rampReadings.set(exit, { count, at: this.time });
  }

  /** Ramps currently running on real vision counts. */
  get visionRamps() {
    return [...this.rampReadings.values()].filter((r) => this.time - r.at <= READING_FRESH_SECONDS).length;
  }

  private updateSignals(dt: number) {
    const { cycleSeconds } = this.layout;
    for (let i = 0; i < this.rampGreen.length; i++) {
      if (this.time - this.cycleStart[i] >= cycleSeconds) {
        this.cycleStart[i] += cycleSeconds;
        if (this.tes) this.rampGreen[i] = this.tes.rampGreen(i, this.time);
      }
      this.crossQueue[i] += this.config.crossRate * dt;
      if (this.crossGreen(i)) {
        const served = Math.min(this.crossQueue[i], CROSS_GREEN_FLOW * CROSS_SERVED_SHARE * dt);
        this.crossQueue[i] -= served;
        this.crossServed += served;
      }
      this.crossDelay += this.crossQueue[i] * dt;
    }
  }

  private phaseTime(i: number) {
    // Offset each ramp so all five don't change together.
    return (this.time - this.cycleStart[i] + i * 11) % this.layout.cycleSeconds;
  }

  rampIsGreen(i: number) {
    return this.phaseTime(i) < this.rampGreen[i];
  }

  private crossGreen(i: number) {
    const t = this.phaseTime(i);
    return t >= this.rampGreen[i] + this.layout.allRedSeconds && t < this.layout.cycleSeconds - this.layout.allRedSeconds;
  }

  private sortLanes() {
    for (const lane of this.lanes) lane.sort((a, b) => a.s - b.s);
  }

  /** Index of the first car in a sorted lane at or beyond `s`. */
  private seek(lane: HighwayCar[], s: number) {
    let low = 0;
    let high = lane.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lane[mid].s < s) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private neighbors(lane: HighwayCar[], s: number, self: HighwayCar | null) {
    const L = this.layout.length;
    if (lane.length === 0) return { ahead: null, behind: null };
    const i = this.seek(lane, s);
    let aheadIndex = i % lane.length;
    if (lane[aheadIndex] === self) aheadIndex = (aheadIndex + 1) % lane.length;
    let behindIndex = (i - 1 + lane.length) % lane.length;
    if (lane[behindIndex] === self) behindIndex = (behindIndex - 1 + lane.length) % lane.length;
    const ahead = lane[aheadIndex] === self ? null : lane[aheadIndex];
    const behind = lane[behindIndex] === self ? null : lane[behindIndex];
    void L;
    return { ahead, behind };
  }

  private gapTo(s: number, lead: HighwayCar) {
    return ringAhead(this.layout, s, lead.s) - lead.length;
  }

  private exitDistance(car: HighwayCar) {
    return ringAhead(this.layout, car.s, this.layout.interchanges[car.exit].offAt);
  }

  private desiredSpeed(car: HighwayCar) {
    const limit = this.config.speedLimit * car.desire;
    return car.advice?.speed ? Math.min(limit, car.advice.speed * car.desire) : limit;
  }

  /** Acceleration if `car` were following `ahead` at position `s`. */
  private followAccel(car: HighwayCar, s: number, ahead: HighwayCar | null, desired: number) {
    if (!ahead) return idm(car.v, desired, 1e7, 0);
    return idm(car.v, desired, this.gapTo(s, ahead), car.v - ahead.v);
  }

  private wantsExitSoon(car: HighwayCar) {
    const distance = this.exitDistance(car);
    return distance < (car.advice?.prepare ? Infinity : car.decisionMeters);
  }

  /** Whether `car` can slot in at `s` in `lane`. `urgency` from 0 to 1 loosens what it will accept. */
  private canEnter(car: HighwayCar, s: number, lane: HighwayCar[], urgency: number) {
    const { ahead, behind } = this.neighbors(lane, s, car);
    // Real drivers take gaps of about a second and expect the car behind to ease off.
    const minGap = 3.5 - 2 * urgency;
    const limit = -3.5 - 2 * urgency;
    if (ahead) {
      const gap = this.gapTo(s, ahead);
      if (gap < minGap || idm(car.v, this.desiredSpeed(car), gap, car.v - ahead.v) < limit) return false;
    }
    if (behind) {
      const gap = ringAhead(this.layout, behind.s, s) - car.length;
      if (gap < minGap || idm(behind.v, this.desiredSpeed(behind), gap, behind.v - car.v) < limit) return false;
    }
    return true;
  }

  private moveLane(car: HighwayCar, from: number, to: number) {
    const source = this.lanes[from];
    source.splice(source.indexOf(car), 1);
    const target = this.lanes[to];
    target.splice(this.seek(target, car.s), 0, car);
    car.lane = to;
    car.laneCooldown = LANE_COOLDOWN;
  }

  private considerLaneChange(car: HighwayCar, dt: number) {
    car.laneCooldown -= dt;
    if (car.laneCooldown > 0) return;
    const distance = this.exitDistance(car);
    const lanes = this.lanes;

    if (this.wantsExitSoon(car)) {
      if (car.lane === 0) return;
      const urgency = 1 - Math.min(1, distance / Math.max(car.decisionMeters, 300));
      if (this.canEnter(car, car.s, lanes[car.lane - 1], urgency)) this.moveLane(car, car.lane, car.lane - 1);
      return;
    }

    const desired = this.desiredSpeed(car);
    const here = this.neighbors(lanes[car.lane], car.s, car);
    const current = this.followAccel(car, car.s, here.ahead, desired);
    const keepLeft = car.advice?.keepLeft ?? false;
    for (const delta of [1, -1]) {
      const to = car.lane + delta;
      if (to < 0 || to >= lanes.length) continue;
      if (keepLeft && to === 0) continue;
      const target = lanes[to];
      if (!this.canEnter(car, car.s, target, 0)) continue;
      const gain = this.followAccel(car, car.s, this.neighbors(target, car.s, car).ahead, desired) - current;
      // A small pull back to the right lane, as on a real road, and a push out of it when TES asks.
      const pull = delta === -1 ? 0.12 : 0;
      const push = keepLeft && car.lane === 0 && delta === 1 ? 1 : 0;
      if (gain + pull + push > 0.3) {
        this.moveLane(car, car.lane, to);
        return;
      }
    }
  }

  private tryMerges() {
    const { interchanges, rampLength, mergeLength, length } = this.layout;
    for (let i = 0; i < this.onRamps.length; i++) {
      const ramp = this.onRamps[i];
      for (let k = ramp.length - 1; k >= 0; k--) {
        const car = ramp[k];
        if (car.s < rampLength) break;
        const along = car.s - rampLength;
        const s = (interchanges[i].onAt + along) % length;
        const urgency = Math.min(1, along / mergeLength);
        if (!this.canEnter(car, s, this.lanes[0], urgency)) continue;
        ramp.splice(k, 1);
        car.place = 'main';
        car.s = s;
        car.lane = 0;
        car.laneCooldown = LANE_COOLDOWN;
        this.lanes[0].splice(this.seek(this.lanes[0], s), 0, car);
      }
    }
  }

  private accelMain(car: HighwayCar, ahead: HighwayCar | null) {
    const { rampSpeed, rampLength } = this.layout;
    let desired = this.desiredSpeed(car);
    const distance = this.exitDistance(car);
    const exiting = this.wantsExitSoon(car);
    if (exiting && car.lane === 0 && distance < EXIT_SLOWDOWN_METERS) desired = Math.min(desired, Math.sqrt(rampSpeed ** 2 + 2.4 * distance));
    // Stuck in the wrong lane near the exit: slow down hunting for a gap, as people do.
    if (exiting && car.lane > 0 && distance < LAST_CHANCE_METERS) desired = Math.min(desired, 7 + distance * 0.2);
    let accel = this.followAccel(car, car.s, ahead, desired);
    // Most would rather stop in the lane and wait to be let in than miss the exit. This is what
    // blocks a through lane in real traffic. After a while they give up and carry on.
    if (exiting && car.lane > 0 && distance < STOP_AND_WAIT_METERS && car.gaveWay < EXIT_PATIENCE_SECONDS) {
      accel = Math.min(accel, idm(car.v, desired, Math.max(distance - 2, 0.1), car.v));
      if (car.v < 1) car.gaveWay += STEP;
    }
    if (exiting && car.lane === 0 && distance < 200) {
      const ramp = this.offRamps[car.exit];
      const tail = ramp[0];
      if (tail) accel = Math.min(accel, idm(car.v, desired, distance + tail.s - tail.length, car.v - tail.v));
      if (tail && tail.s < 8) accel = Math.min(accel, idm(car.v, desired, Math.max(distance - 0.5, 0.1), car.v));
    }
    void rampLength;
    return accel;
  }

  private integrate(car: HighwayCar, dt: number) {
    const next = Math.max(0, car.v + car.a * dt);
    const moved = dt * (car.v + next) * 0.5;
    car.v = next;
    return moved;
  }

  private advanceMain(dt: number) {
    const { length } = this.layout;
    const limitSlow = SLOW_MPH * 0.44704;
    const moves: { car: HighwayCar; moved: number; distance: number }[] = [];

    for (const lane of this.lanes) {
      for (let i = 0; i < lane.length; i++) {
        const car = lane[i];
        const ahead = lane.length > 1 ? lane[(i + 1) % lane.length] : null;
        car.a = this.accelMain(car, ahead);
      }
    }
    for (const lane of this.lanes) {
      for (let i = 0; i < lane.length; i++) {
        const car = lane[i];
        const distance = this.exitDistance(car);
        const moved = this.integrate(car, dt);
        moves.push({ car, moved, distance });
        this.carTime += dt;
        this.carDistance += moved;
        if (car.v < limitSlow) this.slowTime += dt;
        if (car.a < HARD_BRAKE) this.hardBrake += dt;
      }
    }
    const gore = this.layout.rampLength > 0 ? 1 : 1;
    void gore;
    for (const { car, moved, distance } of moves) {
      car.s = (car.s + moved) % length;
      if (moved < distance) continue;
      const ramp = this.offRamps[car.exit];
      const list = this.lanes[car.lane];
      if (car.lane !== 0) {
        // Past the exit and in the wrong lane: they try the next one and find their way back.
        car.exit = (car.exit + 1) % this.layout.interchanges.length;
        car.missed++;
        this.missed++;
        car.gaveWay = 0;
        car.advice = null;
        continue;
      }
      list.splice(list.indexOf(car), 1);
      car.place = 'offramp';
      car.s = 0;
      ramp.unshift(car);
    }
    for (let i = 0; i < this.offRamps.length; i++) {
      const tail = this.offRamps[i][0];
      if (tail && tail.s < 8 && tail.v < 2) this.spillback += dt;
    }
  }

  private advanceRamps(dt: number) {
    const { rampLength, mergeLength, rampSpeed } = this.layout;
    for (let i = 0; i < this.onRamps.length; i++) {
      const ramp = this.onRamps[i];
      for (let k = 0; k < ramp.length; k++) {
        const car = ramp[k];
        const ahead = ramp[k + 1];
        const merging = car.s >= rampLength;
        const desired = merging ? this.config.speedLimit * car.desire : rampSpeed;
        const end = rampLength + mergeLength - car.s;
        let accel = ahead ? idm(car.v, desired, ahead.s - ahead.length - car.s, car.v - ahead.v) : idm(car.v, desired, 1e7, 0);
        accel = Math.min(accel, idm(car.v, desired, Math.max(end, 0.1), car.v));
        car.a = accel;
      }
      for (const car of ramp) car.s = Math.min(car.s + this.integrate(car, dt), rampLength + mergeLength - 0.2);
    }
    for (let i = 0; i < this.offRamps.length; i++) {
      const ramp = this.offRamps[i];
      const green = this.rampIsGreen(i);
      for (let k = 0; k < ramp.length; k++) {
        const car = ramp[k];
        const ahead = ramp[k + 1];
        let accel = ahead ? idm(car.v, rampSpeed, ahead.s - ahead.length - car.s, car.v - ahead.v) : idm(car.v, rampSpeed, 1e7, 0);
        const toLine = rampLength - car.s;
        // Cars too close to stop go through; the rest hold at the line.
        if (!green && !(k === ramp.length - 1 && toLine < (car.v * car.v) / 6)) accel = Math.min(accel, idm(car.v, rampSpeed, Math.max(toLine, 0.1), car.v));
        car.a = accel;
      }
      for (const car of ramp) car.s += this.integrate(car, dt);
      for (let k = ramp.length - 1; k >= 0; k--) {
        const car = ramp[k];
        if (car.s < rampLength) break;
        ramp.splice(k, 1);
        car.place = 'surface';
        car.doneAt = this.time + surfaceSeconds(this.layout, car.zone, car.exit);
        this.tes?.forgetCar(car.id);
      }
    }
  }

  private checkOverlaps() {
    for (const lane of this.lanes) {
      for (let i = 0; i < lane.length && lane.length > 1; i++) {
        const lead = lane[(i + 1) % lane.length];
        if (lead !== lane[i] && this.gapTo(lane[i].s, lead) < -0.5) this.overlaps++;
      }
    }
  }

  private finishTrips() {
    for (const car of this.cars) if (car.place === 'surface' && this.time >= car.doneAt) car.place = 'done';
  }

  step(dt = STEP) {
    this.time += dt;
    this.spawn();
    this.updateSignals(dt);
    this.sortLanes();
    this.listen();
    this.tryMerges();
    for (const lane of this.lanes) for (const car of [...lane]) this.considerLaneChange(car, dt);
    this.sortLanes();
    this.advanceMain(dt);
    this.advanceRamps(dt);
    this.sortLanes();
    this.checkOverlaps();
    this.finishTrips();
  }

  run(): HighwayResult {
    while (this.time < this.config.horizonSeconds) this.step();
    return this.result();
  }

  result(): HighwayResult {
    const trips = this.config.demand.length;
    const started = this.cars.length;
    let total = 0;
    let finished = 0;
    for (const car of this.cars) {
      if (car.place === 'done') {
        finished++;
        total += car.doneAt - car.spawnAt;
      } else {
        total += this.time - car.spawnAt;
      }
    }
    return {
      trips,
      finished,
      meanTripSeconds: started ? total / started : 0,
      meanMainlineMph: this.carTime ? this.carDistance / this.carTime / 0.44704 : 0,
      slowShare: this.carTime ? this.slowTime / this.carTime : 0,
      missedExits: this.missed,
      spillbackSeconds: this.spillback,
      hardBrakeSeconds: this.hardBrake,
      crossDelaySeconds: this.crossServed ? this.crossDelay / this.crossServed : 0,
      crossQueueLeft: this.crossQueue.reduce((a, b) => a + b, 0),
      systemHours: (total + this.crossDelay) / 3600,
      overlaps: this.overlaps,
    };
  }
}
