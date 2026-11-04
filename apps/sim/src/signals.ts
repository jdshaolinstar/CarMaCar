// Traffic lights and intersection right-of-way. Part of the simulated world, not the platform.
import { dot, rightOf, type CityMap, type Vec2 } from '@carmacar/shared';

export type LightState = 'green' | 'yellow' | 'red';
export type SignalMode = 'fixed' | 'off';

const GREEN_SECONDS = 12;
const YELLOW_SECONDS = 2.5;
const ALL_RED_SECONDS = 1.5;
const AXIS_SECONDS = GREEN_SECONDS + YELLOW_SECONDS + ALL_RED_SECONDS;
const CYCLE_SECONDS = AXIS_SECONDS * 2;

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

  constructor(city: CityMap) {
    const degree = new Map<string, number>();
    for (const s of city.segments) {
      degree.set(s.a, (degree.get(s.a) ?? 0) + 1);
      degree.set(s.b, (degree.get(s.b) ?? 0) + 1);
    }
    this.nodes = city.nodes.filter((n) => (degree.get(n.id) ?? 0) >= 3).map((n) => n.id);
    // Staggered starts, so the whole city does not change at once.
    this.nodes.forEach((id, i) => this.offsets.set(id, (i * 5.5) % CYCLE_SECONDS));
  }

  has(nodeId: string) {
    return this.offsets.has(nodeId);
  }

  /** The light facing a car travelling in `direction`. */
  state(nodeId: string, direction: Vec2, time: number): LightState {
    if (this.mode === 'off') return 'green';
    const offset = this.offsets.get(nodeId);
    if (offset === undefined) return 'green';
    const t = (time + offset) % CYCLE_SECONDS;
    const eastWest = Math.abs(direction.x) > Math.abs(direction.z);
    const local = eastWest ? t : (t + AXIS_SECONDS) % CYCLE_SECONDS;
    if (local < GREEN_SECONDS) return 'green';
    if (local < GREEN_SECONDS + YELLOW_SECONDS) return 'yellow';
    return 'red';
  }
}
