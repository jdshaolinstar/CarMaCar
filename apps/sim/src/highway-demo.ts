// Runs the highway live: the one on screen, plus the same drivers without TES, for a fair comparison.
import { highwayLayout, MPH, type HighwayTesOptions } from '@carmacar/shared';
import { HighwaySim, makeHighwayDemand, type HighwayConfig, type HighwayMix } from './highway';
import type { HighwayView } from './highway-view';

export type HighwayModeId = 'off' | 'gps30' | 'cameras30' | 'cameras60' | 'autopilot';
export type HighwayScenario = 'rush' | 'stadium';

const TES: HighwayTesOptions = { cameras: true, prepare: true, keepLeft: true, rebalance: true, smartSignals: false, harmonize: false };
const NO_ADOPTION: HighwayMix = { guidedShare: 0, autopilotShare: 0 };

export const HIGHWAY_MODES: Record<HighwayModeId, { label: string; tes: HighwayTesOptions | null; mix: HighwayMix }> = {
  off: { label: 'TES off', tes: null, mix: NO_ADOPTION },
  gps30: { label: '30% guided, GPS only', tes: { ...TES, cameras: false }, mix: { guidedShare: 0.3, autopilotShare: 0 } },
  cameras30: { label: '30% guided, plus cameras', tes: TES, mix: { guidedShare: 0.3, autopilotShare: 0 } },
  cameras60: { label: '60% guided, plus cameras', tes: TES, mix: { guidedShare: 0.6, autopilotShare: 0 } },
  autopilot: { label: '100% autopilot', tes: TES, mix: { guidedShare: 0, autopilotShare: 1 } },
};

const SCENARIOS: Record<HighwayScenario, { perHour: number; zones: number[] }> = {
  rush: { perHour: 3200, zones: [1, 1, 1, 1, 1] },
  stadium: { perHour: 2400, zones: [1, 1, 1, 1, 5] },
};

const SPAN_SECONDS = 1500;
const HORIZON_SECONDS = 1900;
/** Started this far in, so a demo opens with traffic already on the road. */
const WARM_UP_SECONDS = 420;
const STEP = 0.25;
const RECENT_TRIPS_SECONDS = 240;
const CROSS_RATE = 0.2;
// Measured: SAM counted 93% of cars on 74 rendered ramp frames.
const CAMERA_RECALL = 0.93;

export interface HighwaySettings {
  mode: HighwayModeId;
  limitMph: number;
  scenario: HighwayScenario;
  smartLights: boolean;
}

export interface HighwayLive {
  mph: number;
  slowShare: number;
  tripSeconds: number | null;
  missed: number;
  onRoad: number;
}

export const highwayDemoLayout = () => highwayLayout();

function live(sim: HighwaySim): HighwayLive {
  let moving = 0;
  let slow = 0;
  let speed = 0;
  let recent = 0;
  let recentTotal = 0;
  let missed = 0;
  for (const car of sim.cars) {
    missed += car.missed;
    if (car.place === 'main') {
      moving++;
      speed += car.v;
      if (car.v < 30 * MPH) slow++;
    } else if ((car.place === 'done' || car.place === 'surface') && sim.time - car.doneAt < RECENT_TRIPS_SECONDS && car.doneAt <= sim.time) {
      recent++;
      recentTotal += car.doneAt - car.spawnAt;
    }
  }
  return {
    mph: moving ? speed / moving / MPH : 0,
    slowShare: moving ? slow / moving : 0,
    tripSeconds: recent ? recentTotal / recent : null,
    missed,
    onRoad: moving,
  };
}

export class HighwayDemo {
  sim!: HighwaySim;
  baseline!: HighwaySim;
  private carry = 0;
  settings: HighwaySettings = { mode: 'off', limitMph: 65, scenario: 'rush', smartLights: false };

  constructor(
    private readonly view: HighwayView,
    private readonly seed: number,
  ) {
    this.restart();
  }

  private config(mode: HighwayModeId): HighwayConfig {
    const { limitMph, scenario, smartLights } = this.settings;
    const { perHour, zones } = SCENARIOS[scenario];
    const { tes, mix } = HIGHWAY_MODES[mode];
    return {
      speedLimit: limitMph * MPH,
      demand: makeHighwayDemand(this.view.layout, this.seed, perHour, SPAN_SECONDS, zones),
      mix,
      tes: tes ? { ...tes, smartSignals: smartLights && tes.cameras } : null,
      horizonSeconds: HORIZON_SECONDS,
      crossRate: CROSS_RATE,
      cameraRecall: CAMERA_RECALL,
      seed: this.seed,
    };
  }

  /** Starts again from the same drivers, so switching modes is always a fair comparison. */
  restart() {
    this.view.clearCars();
    this.sim = new HighwaySim(this.view.layout, this.config(this.settings.mode));
    this.baseline = new HighwaySim(this.view.layout, this.config('off'));
    while (this.sim.time < WARM_UP_SECONDS) {
      this.sim.step(STEP);
      this.baseline.step(STEP);
    }
  }

  apply(settings: Partial<HighwaySettings>) {
    this.settings = { ...this.settings, ...settings };
    this.restart();
  }

  tick(dt: number) {
    this.carry += dt;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      this.sim.step(STEP);
      this.baseline.step(STEP);
    }
    if (this.sim.time >= HORIZON_SECONDS) this.restart();
    this.view.sync(this.sim, dt);
  }

  stats() {
    return { live: live(this.sim), baseline: live(this.baseline), reportingShare: this.sim.tes?.options.cameras ? this.sim.tes.reportingShare : null };
  }

  /** A car on the mainline to ride along with, preferring one TES is guiding. */
  pickCar() {
    const onRoad = this.sim.cars.filter((c) => c.place === 'main' && this.view.pose(c.id));
    return (onRoad.find((c) => c.driver !== 'human') ?? onRoad[0])?.id ?? null;
  }
}
