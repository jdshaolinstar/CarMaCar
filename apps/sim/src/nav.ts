// Turn-by-turn directions for a car, using the same road graph the platform plans on.
import { dot, sub, type DirectedEdge, type Path } from '@carmacar/shared';
import { movementOf } from './signals';
import type { Car, World } from './world';

export type NavIcon = 'straight' | 'left' | 'right' | 'arrive' | 'park';

export interface NavStep {
  icon: NavIcon;
  distance: string;
  instruction: string;
  /** Road ahead, for drawing on the map and in the world. */
  path: Path;
}

const roundDistance = (metres: number) => `${Math.max(5, Math.round(metres / 5) * 5)} m`;

const TURN_WORDS = { left: 'Turn left', right: 'Turn right', straight: 'Continue straight' };

export function navigate(world: World, car: Car): NavStep | null {
  const stall = car.targetStallId ? world.stalls.get(car.targetStallId) : null;
  const destination = world.city.destinations.find((d) => d.id === car.destinationId);
  if (!stall && !destination) return null;

  const graph = world.graph;
  const start = car.edge;
  const along = dot(sub(car.pos, graph.node(start.from)), graph.edgeDir(start));
  const segment = destination ? graph.segment(destination.segmentId) : null;
  const goal: DirectedEdge = stall ? graph.approachEdge(stall) : { from: segment!.a, to: segment!.b };
  const goalAlong = stall ? graph.alongApproach(stall) : destination!.along;
  const onGoal = goal.from === start.from && goal.to === start.to;

  const chain = onGoal && goalAlong > along ? [start] : graph.route(start, goal);
  const lastLength = graph.edgeLength(chain[chain.length - 1]);
  const path = graph.buildPath(chain, Math.max(0, Math.min(along, graph.edgeLength(start))), Math.min(goalAlong, lastLength));

  if (chain.length === 1) {
    const left = goalAlong - along;
    if (stall && left < 9) return { icon: 'park', distance: 'Here', instruction: `Press P to park in ${stall.id}`, path };
    const place = stall ? `Stall ${stall.id}` : destination!.name;
    return { icon: 'arrive', distance: roundDistance(left), instruction: `${place} is ahead`, path };
  }

  const next = chain[1];
  const turn = movementOf(graph.edgeDir(start), graph.edgeDir(next)).turn;
  const street = graph.segmentBetween(next.from, next.to).street;
  const toCorner = graph.edgeLength(start) - along;
  return { icon: turn, distance: roundDistance(toCorner), instruction: `${TURN_WORDS[turn]} onto ${street}`, path };
}
