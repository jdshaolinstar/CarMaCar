// Street routing, shared so the platform can plan and the sim can drive the result.
import { add, distance, dot, LANE_OFFSET, rightOf, scale, sub, type CityMap, type Segment, type Stall, type Vec2 } from './city';

export interface DirectedEdge {
  from: string;
  to: string;
}

const edgeKey = (e: DirectedEdge) => `${e.from}>${e.to}`;

export class RoadGraph {
  private readonly nodes: Map<string, { x: number; z: number }>;
  private readonly segmentsByNode = new Map<string, Segment[]>();
  private readonly segments: Map<string, Segment>;
  /** Distance from an intersection center where a car starts its turn. */
  readonly corner: number;

  constructor(readonly city: CityMap) {
    this.corner = city.roadHalfWidth + 2;
    this.nodes = new Map(city.nodes.map((n) => [n.id, n]));
    this.segments = new Map(city.segments.map((s) => [s.id, s]));
    for (const s of city.segments) {
      for (const id of [s.a, s.b]) {
        const list = this.segmentsByNode.get(id) ?? [];
        list.push(s);
        this.segmentsByNode.set(id, list);
      }
    }
  }

  node(id: string) {
    return this.nodes.get(id)!;
  }

  segment(id: string) {
    return this.segments.get(id)!;
  }

  segmentBetween(a: string, b: string): Segment {
    const found = (this.segmentsByNode.get(a) ?? []).find((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a));
    if (!found) throw new Error(`No street between ${a} and ${b}`);
    return found;
  }

  /** Streets leaving `node`, excluding an immediate U-turn back to `from`. */
  next(node: string, from?: string): DirectedEdge[] {
    return (this.segmentsByNode.get(node) ?? [])
      .map((s) => ({ from: node, to: s.a === node ? s.b : s.a }))
      .filter((e) => e.to !== from);
  }

  edgeLength(e: DirectedEdge) {
    return this.segmentBetween(e.from, e.to).length;
  }

  /** Unit direction of travel along a directed edge. */
  edgeDir(e: DirectedEdge): Vec2 {
    const s = this.segmentBetween(e.from, e.to);
    return s.a === e.from ? s.dir : scale(s.dir, -1);
  }

  garage(id: string) {
    return this.city.garages.find((g) => g.id === id)!;
  }

  /** The directed edge from which a stall sits on the driver's right, or a garage door does. */
  approachEdge(stall: Stall): DirectedEdge {
    if (stall.garageId) {
      const g = this.garage(stall.garageId);
      return { from: g.entryFrom, to: g.entryTo };
    }
    const s = this.segment(stall.segmentId);
    const forward: DirectedEdge = { from: s.a, to: s.b };
    return dot(rightOf(s.dir), stall.normal) > 0 ? forward : { from: s.b, to: s.a };
  }

  /** Distance from the start of the approach edge to a point beside the stall. */
  alongApproach(stall: Stall): number {
    if (stall.garageId) return this.garage(stall.garageId).entryAlong;
    const s = this.segment(stall.segmentId);
    return this.approachEdge(stall).from === s.a ? stall.along : s.length - stall.along;
  }

  /** Cost to reach every street from `start`, for comparing many destinations at once. */
  secondsFrom(start: DirectedEdge, edgeCost: (edge: DirectedEdge) => number): Map<string, number> {
    const best = new Map<string, number>([[edgeKey(start), 0]]);
    const open: { edge: DirectedEdge; cost: number }[] = [{ edge: start, cost: 0 }];
    while (open.length > 0) {
      open.sort((a, b) => a.cost - b.cost);
      const { edge, cost } = open.shift()!;
      if (cost > (best.get(edgeKey(edge)) ?? Infinity)) continue;
      for (const next of this.next(edge.to, edge.from)) {
        const nextCost = cost + edgeCost(next);
        if (nextCost < (best.get(edgeKey(next)) ?? Infinity)) {
          best.set(edgeKey(next), nextCost);
          open.push({ edge: next, cost: nextCost });
        }
      }
    }
    return best;
  }

  /** Cheapest edge chain from `start` to `goal`, both included. No U-turns. Shortest by default. */
  route(start: DirectedEdge, goal: DirectedEdge, edgeCost: (edge: DirectedEdge) => number = (e) => this.edgeLength(e)): DirectedEdge[] {
    const best = new Map<string, number>([[edgeKey(start), 0]]);
    const previous = new Map<string, DirectedEdge>();
    const open: { edge: DirectedEdge; cost: number }[] = [{ edge: start, cost: 0 }];
    const goalKey = edgeKey(goal);

    while (open.length > 0) {
      open.sort((a, b) => a.cost - b.cost);
      const { edge, cost } = open.shift()!;
      const key = edgeKey(edge);
      if (cost > (best.get(key) ?? Infinity)) continue;
      // The start edge only counts as the goal if we came back around to it.
      if (key === goalKey && (previous.has(key) || edgeKey(start) !== goalKey)) {
        const chain = [edge];
        let cursor = edge;
        while (previous.has(edgeKey(cursor))) {
          cursor = previous.get(edgeKey(cursor))!;
          chain.unshift(cursor);
          if (edgeKey(cursor) === edgeKey(start)) break;
        }
        return chain;
      }
      for (const nextEdge of this.next(edge.to, edge.from)) {
        const nextKey = edgeKey(nextEdge);
        const nextCost = cost + edgeCost(nextEdge);
        if (nextCost < (best.get(nextKey) ?? Infinity) || (nextKey === edgeKey(start) && !previous.has(nextKey))) {
          best.set(nextKey, nextCost);
          previous.set(nextKey, edge);
          open.push({ edge: nextEdge, cost: nextCost });
        }
      }
    }
    throw new Error(`No route to ${goalKey}`);
  }

  /** Point in the driving lane, `along` metres down a directed edge. */
  lanePoint(edge: DirectedEdge, along: number): Vec2 {
    const dir = this.edgeDir(edge);
    return add(add(this.node(edge.from), scale(dir, along)), scale(rightOf(dir), LANE_OFFSET));
  }

  /**
   * Polyline through a chain of edges in the driving lane, with rounded corners.
   * Starts `startAlong` metres down the first edge and ends `endAlong` down the last.
   */
  buildPath(chain: DirectedEdge[], startAlong: number, endAlong: number): Path {
    const CORNER = this.corner;
    const points: Vec2[] = [];
    chain.forEach((edge, i) => {
      const length = this.edgeLength(edge);
      const from = i === 0 ? startAlong : CORNER;
      const to = i === chain.length - 1 ? endAlong : length - CORNER;
      points.push(this.lanePoint(edge, from), this.lanePoint(edge, Math.max(from, to)));
      const next = chain[i + 1];
      if (!next) return;
      // Quadratic corner through where the two lane lines meet.
      const p0 = this.lanePoint(edge, length - CORNER);
      const p2 = this.lanePoint(next, CORNER);
      const d0 = this.edgeDir(edge);
      const d1 = this.edgeDir(next);
      const cross = d0.x * d1.z - d0.z * d1.x;
      const control =
        Math.abs(cross) < 1e-6 ? scale(add(p0, p2), 0.5) : add(p0, scale(d0, dot(sub(p2, p0), rightOf(d1)) / dot(d0, rightOf(d1))));
      for (let k = 1; k < 7; k++) {
        const t = k / 7;
        const a = add(scale(p0, (1 - t) * (1 - t)), scale(control, 2 * t * (1 - t)));
        points.push(add(a, scale(p2, t * t)));
      }
    });
    return Path.from(points);
  }
}

export class Path {
  private constructor(
    readonly points: Vec2[],
    readonly cumulative: number[],
  ) {}

  static from(raw: Vec2[]): Path {
    const points: Vec2[] = [];
    for (const p of raw) {
      const last = points[points.length - 1];
      if (!last || distance(last, p) > 1e-3) points.push(p);
    }
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    return new Path(points, cumulative);
  }

  get length() {
    return this.cumulative[this.cumulative.length - 1];
  }

  sample(s: number): { point: Vec2; tangent: Vec2 } {
    const clamped = Math.min(Math.max(s, 0), this.length);
    let i = 1;
    while (i < this.cumulative.length - 1 && this.cumulative[i] < clamped) i++;
    const a = this.points[i - 1];
    const b = this.points[i] ?? a;
    const span = this.cumulative[i] - this.cumulative[i - 1] || 1;
    const t = (clamped - this.cumulative[i - 1]) / span;
    const d = sub(b, a);
    const len = Math.hypot(d.x, d.z) || 1;
    return { point: add(a, scale(d, t)), tangent: { x: d.x / len, z: d.z / len } };
  }
}
