// A game on top of the simulation: a timed round of picking up trash against other pedestrians.
// It has its own random numbers and never touches a car, so traffic runs exactly as it would without it.
import { distance, pointOnRing, type Vec2 } from '@carmacar/shared';
import type { Litter, LitterKind, Walker, World } from './world';

export const HUNT_POINTS: Record<LitterKind, number> = { can: 5, box: 10, bag: 15, treasure: 100 };
export const ROUND_SECONDS = 180;
const COMBO_SECONDS = 15;
const MAX_COMBO = 3;
const EXTRA_LITTER = 36;
const TREASURES = 3;
const RIVAL_NAMES = ['Gus', 'Tia', 'Bo'];
/** How far a rival can spot trash that no camera has reported. Pinned trash they can head for from further. */
const RIVAL_SIGHT_METERS = 14;
const HOT_METERS = 25;
const WARM_METERS = 70;
const REACH_METERS = 2.2;

export interface HuntPlayer {
  id: string;
  name: string;
  score: number;
  isYou: boolean;
}

export type TreasureHint = 'hot' | 'warm' | 'cold' | 'gone';

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class TrashHunt {
  readonly players: HuntPlayer[];
  timeLeft = ROUND_SECONDS;
  combo = 1;
  picked = 0;
  over = false;
  /** The last pickup, for the on-screen message. */
  last: { kind: LitterKind; points: number } | null = null;
  private lastPickupAt = -Infinity;
  private clock = 0;
  private readonly samaritansWere: boolean;
  private readonly you: HuntPlayer;

  constructor(
    private readonly world: World,
    private readonly walker: Walker,
    seed: number,
  ) {
    this.you = { id: walker.id, name: 'You', score: 0, isYou: true };
    const rivals = world.walkers.filter((w) => w.role === 'samaritan').slice(0, RIVAL_NAMES.length);
    this.players = [this.you, ...rivals.map((w, i) => ({ id: w.id, name: RIVAL_NAMES[i], score: 0, isYou: false }))];
    this.samaritansWere = world.samaritansEnabled;
    world.samaritansEnabled = true;
    world.rivalSight = RIVAL_SIGHT_METERS;
    world.onLitterPicked = (w, item) => this.score(w, item);

    const random = mulberry(seed);
    const place = (): Vec2 => {
      const ring = world.city.sidewalks[Math.floor(random() * world.city.sidewalks.length)];
      return pointOnRing(ring, random() * ring.length, (random() - 0.5) * 1.6);
    };
    const kinds: LitterKind[] = ['bag', 'box', 'can'];
    for (let i = 0; i < EXTRA_LITTER; i++) world.addLitter(place(), kinds[Math.floor(random() * kinds.length)]);
    for (let i = 0; i < TREASURES; i++) world.addLitter(place(), 'treasure');
  }

  private score(w: Walker, item: Litter) {
    if (this.over) return;
    const player = this.players.find((p) => p.id === w.id);
    if (!player) return;
    const points = HUNT_POINTS[item.kind];
    if (!player.isYou) {
      player.score += points;
      return;
    }
    this.combo = this.clock - this.lastPickupAt <= COMBO_SECONDS ? Math.min(MAX_COMBO, this.combo + 1) : 1;
    this.lastPickupAt = this.clock;
    this.picked++;
    player.score += points * this.combo;
    this.last = { kind: item.kind, points: points * this.combo };
  }

  tick(dt: number) {
    if (this.over) return;
    this.clock += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.clock - this.lastPickupAt > COMBO_SECONDS) this.combo = 1;
    if (this.timeLeft === 0) this.finish();
  }

  /** Ends the round and puts everything it changed back. */
  finish() {
    if (this.over) return;
    this.over = true;
    this.world.samaritansEnabled = this.samaritansWere;
    this.world.rivalSight = 0;
    this.world.onLitterPicked = null;
    for (const item of [...this.world.litter.values()]) if (item.kind === 'treasure') this.world.litter.delete(item.id);
  }

  get standings() {
    return [...this.players].sort((a, b) => b.score - a.score);
  }

  get place() {
    return this.standings.findIndex((p) => p.isYou) + 1;
  }

  /** Warmer as you get closer to gold, without saying where it is. */
  treasureHint(): TreasureHint {
    let nearest = Infinity;
    for (const item of this.world.litter.values()) {
      if (item.kind === 'treasure') nearest = Math.min(nearest, distance(item.pos, this.walker.pos));
    }
    if (nearest === Infinity) return 'gone';
    return nearest < HOT_METERS ? 'hot' : nearest < WARM_METERS ? 'warm' : 'cold';
  }

  /** True when something is within reach of the player. */
  inReach() {
    for (const item of this.world.litter.values()) if (distance(item.pos, this.walker.pos) < REACH_METERS) return true;
    return false;
  }
}
