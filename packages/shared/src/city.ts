// The static city map: the "surveyed" layer shared by the sim and the platform.
// It holds roads, stall positions and destinations. It never holds occupancy.

export interface Vec2 {
  x: number;
  z: number;
}

export interface CityNode extends Vec2 {
  id: string;
}

export interface Segment {
  id: string;
  label: string;
  a: string;
  b: string;
  /** Unit vector from a to b. */
  dir: Vec2;
  length: number;
}

export interface Stall {
  id: string;
  segmentId: string;
  center: Vec2;
  /** Unit vector along the street. */
  axis: Vec2;
  /** Unit vector from the street toward the curb. */
  normal: Vec2;
  length: number;
  width: number;
  /** Distance from node a along the segment. */
  along: number;
}

export type DestinationKind = 'cinema' | 'restaurant' | 'grocery' | 'hardware' | 'cafe' | 'clinic' | 'apartments';

export interface Destination extends Vec2 {
  id: string;
  name: string;
  kind: DestinationKind;
  segmentId: string;
  along: number;
  /** Unit vector from the street toward the building entrance. */
  normal: Vec2;
}

export interface CityMap {
  nodes: CityNode[];
  segments: Segment[];
  stalls: Stall[];
  destinations: Destination[];
  roadHalfWidth: number;
  sidewalkWidth: number;
  laneOffset: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export const COLS = 4;
export const ROWS = 3;
export const SPACING_X = 84;
export const SPACING_Z = 72;
export const ROAD_HALF_WIDTH = 6;
export const SIDEWALK_WIDTH = 2.5;
export const LANE_OFFSET = 1.8;

const STALL_LENGTH = 6.5;
const STALL_WIDTH = 2.4;
const INTERSECTION_MARGIN = 12;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, z: a.z * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Right-hand side of a heading in Babylon's left-handed, y-up world. */
export const rightOf = (dir: Vec2): Vec2 => ({ x: dir.z, z: -dir.x });

export const nodeId = (col: number, row: number): string => `n${col}_${row}`;

const DESTINATION_SPECS: { name: string; kind: DestinationKind; segment: string; along: number; side: 1 | -1 }[] = [
  { name: 'Galaxy Cinema', kind: 'cinema', segment: 'H1-1', along: 0.5, side: 1 },
  { name: 'Noodle Bar', kind: 'restaurant', segment: 'H0-0', along: 0.5, side: -1 },
  { name: 'Trattoria Luna', kind: 'restaurant', segment: 'H2-2', along: 0.5, side: 1 },
  { name: 'Taco Verde', kind: 'restaurant', segment: 'V2-0', along: 0.5, side: 1 },
  { name: 'Corner Grocer', kind: 'grocery', segment: 'H0-2', along: 0.5, side: -1 },
  { name: 'Bolt Hardware', kind: 'hardware', segment: 'V1-1', along: 0.5, side: -1 },
  { name: 'Bean There Coffee', kind: 'cafe', segment: 'H2-0', along: 0.5, side: 1 },
  { name: 'Mercy Clinic', kind: 'clinic', segment: 'V3-0', along: 0.5, side: 1 },
  { name: 'Maple Apartments', kind: 'apartments', segment: 'V0-1', along: 0.5, side: -1 },
];

export function generateCity(): CityMap {
  const nodes: CityNode[] = [];
  const originX = -((COLS - 1) * SPACING_X) / 2;
  const originZ = -((ROWS - 1) * SPACING_Z) / 2;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      nodes.push({ id: nodeId(c, r), x: originX + c * SPACING_X, z: originZ + r * SPACING_Z });
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const segments: Segment[] = [];
  const addSegment = (id: string, a: string, b: string) => {
    const na = nodeById.get(a)!;
    const nb = nodeById.get(b)!;
    const length = distance(na, nb);
    const label = String.fromCharCode(65 + segments.length);
    segments.push({ id, label, a, b, length, dir: { x: (nb.x - na.x) / length, z: (nb.z - na.z) / length } });
  };
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) addSegment(`H${r}-${c}`, nodeId(c, r), nodeId(c + 1, r));
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 1; r++) addSegment(`V${c}-${r}`, nodeId(c, r), nodeId(c, r + 1));
  }

  // Parking on one side of each street, alternating so both travel directions pass stalls.
  const stalls: Stall[] = [];
  segments.forEach((seg, index) => {
    const a = nodeById.get(seg.a)!;
    const side = index % 2 === 0 ? 1 : -1;
    const normal = scale(rightOf(seg.dir), side);
    const usable = seg.length - INTERSECTION_MARGIN * 2;
    const count = Math.floor(usable / STALL_LENGTH);
    const start = (seg.length - count * STALL_LENGTH) / 2;
    const offset = ROAD_HALF_WIDTH - STALL_WIDTH / 2;
    for (let i = 0; i < count; i++) {
      const along = start + (i + 0.5) * STALL_LENGTH;
      stalls.push({
        id: `${seg.label}${i + 1}`,
        segmentId: seg.id,
        center: add(add(a, scale(seg.dir, along)), scale(normal, offset)),
        axis: seg.dir,
        normal,
        length: STALL_LENGTH,
        width: STALL_WIDTH,
        along,
      });
    }
  });

  const segmentById = new Map(segments.map((s) => [s.id, s]));
  const destinations: Destination[] = DESTINATION_SPECS.map((spec, i) => {
    const seg = segmentById.get(spec.segment)!;
    const a = nodeById.get(seg.a)!;
    const along = seg.length * spec.along;
    const normal = scale(rightOf(seg.dir), spec.side);
    const pos = add(add(a, scale(seg.dir, along)), scale(normal, ROAD_HALF_WIDTH + SIDEWALK_WIDTH + 1));
    return {
      id: `d${i}`,
      name: spec.name,
      kind: spec.kind,
      segmentId: seg.id,
      along,
      normal,
      x: pos.x,
      z: pos.z,
    };
  });

  const pad = 60;
  return {
    nodes,
    segments,
    stalls,
    destinations,
    roadHalfWidth: ROAD_HALF_WIDTH,
    sidewalkWidth: SIDEWALK_WIDTH,
    laneOffset: LANE_OFFSET,
    bounds: {
      minX: originX - pad,
      maxX: -originX + pad,
      minZ: originZ - pad,
      maxZ: -originZ + pad,
    },
  };
}
