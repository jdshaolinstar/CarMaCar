// Turns raw OpenStreetMap roads into a compact directed network the metro simulator can run.
// Plain code, not a model: a city's map is far too large to pass through one. Any city works.

/** Metres per degree, at a given latitude, close enough across one metro area. */
const METERS_PER_DEGREE = 111_320;

export type RoadClass = 'freeway' | 'ramp' | 'arterial' | 'collector';

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OsmFile {
  elements: (OsmNode | OsmWay)[];
}

/** Stored as flat typed arrays so 100,000 edges stay small in memory and quick to save. */
export interface Network {
  nodeCount: number;
  /** Metres east and north of the map's centre. */
  nodeX: Float32Array;
  nodeY: Float32Array;
  edgeCount: number;
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
  edgeLength: Float32Array;
  /** Free-flow speed in metres per second. */
  edgeSpeed: Float32Array;
  /** Vehicles per hour the edge can discharge. */
  edgeCapacity: Float32Array;
  /** Vehicles that fit on the edge before it blocks the one behind it. */
  edgeStorage: Int32Array;
  edgeClass: Uint8Array;
  /** Edges leaving each node: outgoing[outStart[n]] up to outStart[n + 1]. */
  outStart: Int32Array;
  outgoing: Int32Array;
  /** Set where the edge ends at a traffic signal. */
  edgeSignal: Uint8Array;
  center: { lat: number; lon: number };
}

export const ROAD_CLASSES: RoadClass[] = ['freeway', 'ramp', 'arterial', 'collector'];

interface ClassRule {
  road: RoadClass;
  speed: number;
  /** Per lane, per hour. */
  capacity: number;
  lanes: number;
}

const MPH = 0.44704;
const RULES: Record<string, ClassRule> = {
  motorway: { road: 'freeway', speed: 65 * MPH, capacity: 1900, lanes: 4 },
  motorway_link: { road: 'ramp', speed: 30 * MPH, capacity: 1200, lanes: 1 },
  trunk: { road: 'arterial', speed: 50 * MPH, capacity: 1300, lanes: 3 },
  trunk_link: { road: 'ramp', speed: 30 * MPH, capacity: 1100, lanes: 1 },
  primary: { road: 'arterial', speed: 40 * MPH, capacity: 900, lanes: 3 },
  primary_link: { road: 'ramp', speed: 25 * MPH, capacity: 900, lanes: 1 },
  secondary: { road: 'arterial', speed: 35 * MPH, capacity: 800, lanes: 2 },
  secondary_link: { road: 'ramp', speed: 25 * MPH, capacity: 800, lanes: 1 },
  tertiary: { road: 'collector', speed: 30 * MPH, capacity: 700, lanes: 1 },
  tertiary_link: { road: 'ramp', speed: 20 * MPH, capacity: 700, lanes: 1 },
};
const VEHICLE_SPACE_METERS = 7.5;

function parseSpeed(tag: string | undefined): number | null {
  if (!tag) return null;
  const match = /^(\d+)\s*(mph)?/.exec(tag);
  if (!match) return null;
  return Number(match[1]) * (match[2] ? MPH : 1 / 3.6);
}

/** Connects every node to the largest connected part, by keeping only the nodes that can reach it and be reached. */
function largestStronglyConnected(nodeCount: number, from: number[], to: number[]) {
  const forward = Array.from({ length: nodeCount }, () => [] as number[]);
  const backward = Array.from({ length: nodeCount }, () => [] as number[]);
  for (let i = 0; i < from.length; i++) {
    forward[from[i]].push(to[i]);
    backward[to[i]].push(from[i]);
  }
  const seen = new Uint8Array(nodeCount);
  const order: number[] = [];
  // Kosaraju, written with explicit stacks: a metro network is far too deep for recursion.
  for (let start = 0; start < nodeCount; start++) {
    if (seen[start]) continue;
    const stack: [number, number][] = [[start, 0]];
    seen[start] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [node, index] = top;
      if (index < forward[node].length) {
        top[1]++;
        const next = forward[node][index];
        if (!seen[next]) {
          seen[next] = 1;
          stack.push([next, 0]);
        }
      } else {
        order.push(node);
        stack.pop();
      }
    }
  }
  const component = new Int32Array(nodeCount).fill(-1);
  let count = 0;
  const sizes: number[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i];
    if (component[start] >= 0) continue;
    const stack = [start];
    component[start] = count;
    let size = 0;
    while (stack.length > 0) {
      const node = stack.pop()!;
      size++;
      for (const prev of backward[node]) {
        if (component[prev] < 0) {
          component[prev] = count;
          stack.push(prev);
        }
      }
    }
    sizes.push(size);
    count++;
  }
  const largest = sizes.indexOf(Math.max(...sizes));
  return { component, largest };
}

export function buildNetwork(osm: OsmFile): Network {
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const element of osm.elements) {
    if (element.type === 'node') nodes.set(element.id, element);
    else if (element.type === 'way') ways.push(element);
  }

  // A node matters if two roads meet there, or a road ends there. Everything between is shape.
  const uses = new Map<number, number>();
  for (const way of ways) {
    way.nodes.forEach((id, i) => {
      const weight = i === 0 || i === way.nodes.length - 1 ? 2 : 1;
      uses.set(id, (uses.get(id) ?? 0) + weight);
    });
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const n of nodes.values()) {
    minLat = Math.min(minLat, n.lat);
    maxLat = Math.max(maxLat, n.lat);
    minLon = Math.min(minLon, n.lon);
    maxLon = Math.max(maxLon, n.lon);
  }
  const center = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const xScale = METERS_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180);
  const project = (n: OsmNode) => ({ x: (n.lon - center.lon) * xScale, y: (n.lat - center.lat) * METERS_PER_DEGREE });

  const index = new Map<number, number>();
  const px: number[] = [];
  const py: number[] = [];
  const signalNodes = new Set<number>();
  const nodeIndex = (id: number) => {
    let i = index.get(id);
    if (i === undefined) {
      i = px.length;
      index.set(id, i);
      const p = project(nodes.get(id)!);
      px.push(p.x);
      py.push(p.y);
    }
    return i;
  };

  const from: number[] = [];
  const to: number[] = [];
  const length: number[] = [];
  const speed: number[] = [];
  const capacity: number[] = [];
  const storage: number[] = [];
  const roadClass: number[] = [];
  const signal: number[] = [];

  for (const way of ways) {
    const rule = RULES[way.tags?.highway ?? ''];
    if (!rule) continue;
    if (way.nodes.some((id) => !nodes.has(id))) continue;
    const oneway = way.tags?.oneway === 'yes' || way.tags?.oneway === '1' || rule.road === 'freeway' || rule.road === 'ramp';
    const reverse = way.tags?.oneway === '-1';
    const taggedLanes = Number(way.tags?.lanes);
    const totalLanes = Number.isFinite(taggedLanes) && taggedLanes > 0 ? taggedLanes : rule.lanes * (oneway ? 1 : 2);
    const lanes = Math.max(1, oneway || reverse ? totalLanes : Math.round(totalLanes / 2));
    const limit = parseSpeed(way.tags?.maxspeed) ?? rule.speed;

    let segmentStart = 0;
    let metres = 0;
    let hasSignal = false;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = project(nodes.get(way.nodes[i - 1])!);
      const b = project(nodes.get(way.nodes[i])!);
      metres += Math.hypot(b.x - a.x, b.y - a.y);
      const id = way.nodes[i];
      if (nodes.get(id)?.tags?.highway === 'traffic_signals') {
        hasSignal = true;
        signalNodes.add(id);
      }
      const isJoint = i === way.nodes.length - 1 || (uses.get(id) ?? 0) > 1;
      if (!isJoint) continue;
      const u = nodeIndex(way.nodes[segmentStart]);
      const v = nodeIndex(id);
      const add = (a0: number, b0: number) => {
        from.push(a0);
        to.push(b0);
        length.push(Math.max(metres, 5));
        speed.push(limit);
        capacity.push(rule.capacity * lanes);
        storage.push(Math.max(1, Math.floor((metres * lanes) / VEHICLE_SPACE_METERS)));
        roadClass.push(ROAD_CLASSES.indexOf(rule.road));
        signal.push(hasSignal ? 1 : 0);
      };
      if (!reverse) add(u, v);
      if (!oneway || reverse) add(v, u);
      segmentStart = i;
      metres = 0;
      hasSignal = false;
    }
  }

  // Drop islands: a trip can only be routed where every place can reach every other.
  const { component, largest } = largestStronglyConnected(px.length, from, to);
  const remap = new Int32Array(px.length).fill(-1);
  let kept = 0;
  for (let i = 0; i < px.length; i++) if (component[i] === largest) remap[i] = kept++;
  const edges: number[] = [];
  for (let e = 0; e < from.length; e++) if (remap[from[e]] >= 0 && remap[to[e]] >= 0) edges.push(e);

  const network: Network = {
    nodeCount: kept,
    nodeX: new Float32Array(kept),
    nodeY: new Float32Array(kept),
    edgeCount: edges.length,
    edgeFrom: new Int32Array(edges.length),
    edgeTo: new Int32Array(edges.length),
    edgeLength: new Float32Array(edges.length),
    edgeSpeed: new Float32Array(edges.length),
    edgeCapacity: new Float32Array(edges.length),
    edgeStorage: new Int32Array(edges.length),
    edgeClass: new Uint8Array(edges.length),
    outStart: new Int32Array(kept + 1),
    outgoing: new Int32Array(edges.length),
    edgeSignal: new Uint8Array(edges.length),
    center,
  };
  for (let i = 0; i < px.length; i++) {
    if (remap[i] < 0) continue;
    network.nodeX[remap[i]] = px[i];
    network.nodeY[remap[i]] = py[i];
  }
  edges.forEach((e, i) => {
    network.edgeFrom[i] = remap[from[e]];
    network.edgeTo[i] = remap[to[e]];
    network.edgeLength[i] = length[e];
    network.edgeSpeed[i] = speed[e];
    network.edgeCapacity[i] = capacity[e];
    network.edgeStorage[i] = storage[e];
    network.edgeClass[i] = roadClass[e];
    network.edgeSignal[i] = signal[e];
  });
  for (let i = 0; i < edges.length; i++) network.outStart[network.edgeFrom[i] + 1]++;
  for (let n = 0; n < kept; n++) network.outStart[n + 1] += network.outStart[n];
  const fill = network.outStart.slice();
  for (let i = 0; i < edges.length; i++) network.outgoing[fill[network.edgeFrom[i]]++] = i;
  return network;
}

export function describeNetwork(network: Network) {
  const lanesKm = ROAD_CLASSES.map((name, c) => {
    let metres = 0;
    let count = 0;
    for (let e = 0; e < network.edgeCount; e++) {
      if (network.edgeClass[e] === c) {
        metres += network.edgeLength[e];
        count++;
      }
    }
    return { name, edges: count, km: Math.round(metres / 1000) };
  });
  let signals = 0;
  for (let e = 0; e < network.edgeCount; e++) signals += network.edgeSignal[e];
  return { nodes: network.nodeCount, edges: network.edgeCount, signals, byClass: lanesKm };
}
