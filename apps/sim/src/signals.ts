// Traffic lights and intersection right-of-way. Part of the simulated world, not the platform.
import { dot, rightOf, type CityMap, type SignalAxis, type Vec2 } from '@carmacar/shared';

export type LightState = 'green' | 'yellow' | 'red';
export type SignalMode = 'fixed' | 'smart' | 'off';

const GREEN_SECONDS = 12;
const YELLOW_SECONDS = 2.5;
const ALL_RED_SECONDS = 1.5;
const AXIS_SECONDS = GREEN_SECONDS + YELLOW_SECONDS + ALL_RED_SECONDS;
const CYCLE_SECONDS = AXIS_SECONDS * 2;
const MIN_GREEN_SECONDS = 7;
const MAX_GREEN_SECONDS = 30;

interface SmartLight {
  axis: SignalAxis;
  phase: 'green' | 'yellow' | 'allRed';
  since: number;
  wants: SignalAxis | null;
}

export interface Movement {
  entering: Vec2;
  leaving: Vec2;
  turn: 'straight' | 'left' | 'right';
}

export function movementOf(entering: Vec2, leaving: Vec2): Movement {
  const sideways = dot(leaving, rightOf(entering));
  const turn = Math.abs(sideways) < 0.5 ? 'straight' : sideways > 0 ? 'right' : 'left';
  return { entering, leaving, turn };
}

/** Whether two cars could hit each other if they used an intersection at the same time. */
export function movementsConflict(a: Movement, b: Movement): boolean {
  const facing = dot(a.entering, b.entering);
  if (facing > 0.9) return false; // Same direction: normal car following handles it.
  if (facing < -0.9) return a.turn === 'left' || b.turn === 'left'; // Left turns cross oncoming traffic, and each other.
  return true; // Crossing traffic.
}

export class Signals {
  mode: SignalMode = 'fixed';
  /** Nodes with lights. Corners have only one way through, so they need none. */
  readonly nodes: string[];
  private readonly offsets = new Map<string, number>();
  private readonly smart = new Map<string, SmartLight>();

  constructor(city: CityMap) {
    const degree = new Map<string, number>();
    for (const s of city.segments) {
      degree.set(s.a, (degree.get(s.a) ?? 0) + 1);
      degree.set(s.b, (degree.get(s.b) ?? 0) + 1);
    }
    this.nodes = city.nodes.filter((n) => (degree.get(n.id) ?? 0) >= 3).map((n) => n.id);
    // Staggered starts, so the whole city does not change at once.
    this.nodes.forEach((id, i) => {
      this.offsets.set(id, (i * 5.5) % CYCLE_SECONDS);
      this.smart.set(id, { axis: i % 2 === 0 ? 'ew' : 'ns', phase: 'green', since: 0, wants: null });
    });
  }

  has(nodeId: string) {
    return this.offsets.has(nodeId);
  }

  /** Smart mode: asks a light to favor a direction. It still runs safe yellow and all-red phases. */
  request(nodeId: string, axis: SignalAxis) {
    const light = this.smart.get(nodeId);
    if (light) light.wants = axis === light.axis ? null : axis;
  }

  /** Advances smart lights. Fixed lights are a pure function of time. */
  tick(time: number) {
    if (this.mode !== 'smart') return;
    for (const light of this.smart.values()) {
      const held = time - light.since;
      if (light.phase === 'green') {
        const shouldChange = (light.wants && held >= MIN_GREEN_SECONDS) || held >= MAX_GREEN_SECONDS;
        if (shouldChange) {
          light.phase = 'yellow';
          light.since = time;
        }
      } else if (light.phase === 'yellow' && held >= YELLOW_SECONDS) {
        light.phase = 'allRed';
        light.since = time;
      } else if (light.phase === 'allRed' && held >= ALL_RED_SECONDS) {
        light.axis = light.axis === 'ew' ? 'ns' : 'ew';
        light.phase = 'green';
        light.since = time;
        light.wants = null;
      }
    }
  }

  /** The light facing a car travelling in `direction`. */
  state(nodeId: string, direction: Vec2, time: number): LightState {
    if (this.mode === 'off') return 'green';
    const offset = this.offsets.get(nodeId);
    if (offset === undefined) return 'green';
    const eastWest = Math.abs(direction.x) > Math.abs(direction.z);
    if (this.mode === 'smart') {
      const light = this.smart.get(nodeId)!;
      if ((light.axis === 'ew') !== eastWest || light.phase === 'allRed') return 'red';
      return light.phase === 'green' ? 'green' : 'yellow';
    }
    const t = (time + offset) % CYCLE_SECONDS;
    const local = eastWest ? t : (t + AXIS_SECONDS) % CYCLE_SECONDS;
    if (local < GREEN_SECONDS) return 'green';
    if (local < GREEN_SECONDS + YELLOW_SECONDS) return 'yellow';
    return 'red';
  }
}
