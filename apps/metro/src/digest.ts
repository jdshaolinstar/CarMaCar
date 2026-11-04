// Boils a whole metro run down to something a model, or a person, can read: the roads losing the most time.
import type { Network } from './network';

export interface RoadDelay {
  road: string;
  /** Vehicle-hours of delay, scaled up to the whole population. */
  delayHours: number;
  km: number;
  kind: 'freeway' | 'surface';
}

export function worstRoads(network: Network, delayByEdge: Float32Array, sampleRate: number, count: number): RoadDelay[] {
  const seconds = new Float64Array(network.names.length);
  const metres = new Float64Array(network.names.length);
  const freeway = new Uint8Array(network.names.length);
  for (let e = 0; e < network.edgeCount; e++) {
    const name = network.edgeName[e];
    if (name < 0) continue;
    seconds[name] += delayByEdge[e];
    metres[name] += network.edgeLength[e];
    if (network.edgeClass[e] === 0) freeway[name] = 1;
  }
  const order = [...seconds.keys()].sort((a, b) => seconds[b] - seconds[a]).slice(0, count);
  return order.map((i) => ({
    road: network.names[i],
    delayHours: Math.round(seconds[i] / 3600 / sampleRate),
    km: Math.round(metres[i] / 1000),
    kind: freeway[i] ? 'freeway' : 'surface',
  }));
}

/** Turns "avoid this road by this factor" into weights the router can use. */
export function roadWeights(network: Network, changes: { road: string; factor: number }[]) {
  const weights = new Float32Array(network.edgeCount).fill(1);
  const byName = new Map(network.names.map((name, i) => [name, i]));
  let matched = 0;
  for (const change of changes) {
    const id = byName.get(change.road);
    if (id === undefined) continue;
    matched++;
    for (let e = 0; e < network.edgeCount; e++) if (network.edgeName[e] === id) weights[e] = Math.max(0.7, Math.min(3, change.factor));
  }
  return { weights, matched };
}
