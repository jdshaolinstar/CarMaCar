// Turns a small real map area into a CityMap the 3D sim can run.
// Run: node --import tsx apps/metro/scripts/real-block.ts <block.json> <city.json> [columns] [rows]
//
// The 3D sim needs straight streets that meet at right angles, so this keeps a real grid and rejects
// anything else. Street names, spacing, building footprints and heights are real. The grid is rotated to
// line up with the sim's axes, and streets are straightened to their average line. Parking stalls and the
// garage interiors are generated, because the map data doesn't describe them.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCity, type CityLayout, type DestinationKind, type DestinationSpec, type GarageSpec, type RealBuilding, type Vec2 } from '../../../packages/shared/src/index';

interface Shape {
  id: number;
  points: [number, number][];
  tags: Record<string, string>;
}

const STREET_TYPES = new Set(['primary', 'secondary', 'tertiary', 'trunk', 'residential', 'unclassified']);
/** Two carriageways of one street, or streets closer than this, count as one line. */
const MIN_STREET_GAP = 45;
const ROAD_CLEARANCE = 9.5;
const METRES_PER_LEVEL = 4;
const UNKNOWN_HEIGHT = 14;
const MIN_BUILDING_SIDE = 5;
/** How far a building's center can be from the street it fronts and still be used as a destination. */
const DESTINATION_REACH = 90;
/** Which real places to feature, by words in their name. */
const KINDS: [RegExp, DestinationKind][] = [
  [/theat|cinema|orpheum|palace|los angeles theatre/i, 'cinema'],
  [/market|grocer/i, 'grocery'],
  [/caf|coffee|blue bottle/i, 'cafe'],
  [/restaurant|grill|deli|clifton|philippe|kitchen|bar\b/i, 'restaurant'],
  [/clinic|medical|hospital/i, 'clinic'],
  [/apartment|lofts?\b|residen|tower/i, 'apartments'],
];

const [source, target] = [process.argv[2], process.argv[3]];
const maxColumns = Number(process.argv[4] ?? 4);
const maxRows = Number(process.argv[5] ?? 4);
const raw = JSON.parse(readFileSync(source, 'utf8')) as { box: [number, number, number, number]; shapes: Shape[] };
const [south, west, north, east] = raw.box;
const centerLat = (south + north) / 2;
const centerLon = (west + east) / 2;
const metres = ([lat, lon]: [number, number]): Vec2 => ({
  x: (lon - centerLon) * 111_320 * Math.cos((centerLat * Math.PI) / 180),
  z: (lat - centerLat) * 111_320,
});

const roads = raw.shapes.filter((s) => STREET_TYPES.has(s.tags.highway) && s.tags.name);

// The grid's angle: road direction folded into a quarter turn, weighted by length.
function gridAngle() {
  let sin = 0;
  let cos = 0;
  for (const road of roads) {
    const p = road.points.map(metres);
    for (let i = 1; i < p.length; i++) {
      const dx = p[i].x - p[i - 1].x;
      const dz = p[i].z - p[i - 1].z;
      const length = Math.hypot(dx, dz);
      const angle = Math.atan2(dz, dx) * 4;
      sin += Math.sin(angle) * length;
      cos += Math.cos(angle) * length;
    }
  }
  return Math.atan2(sin, cos) / 4;
}
const angle = gridAngle();
const turn = (p: Vec2): Vec2 => ({
  x: p.x * Math.cos(angle) + p.z * Math.sin(angle),
  z: -p.x * Math.sin(angle) + p.z * Math.cos(angle),
});
const local = (p: [number, number]) => turn(metres(p));

// Group road pieces by street name, then keep streets that run the length of the area.
interface Line {
  name: string;
  at: number;
  span: number;
}
function streets(vertical: boolean): Line[] {
  const byName = new Map<string, { sum: number; weight: number; low: number; high: number }>();
  for (const road of roads) {
    const p = road.points.map(local);
    for (let i = 1; i < p.length; i++) {
      const dx = p[i].x - p[i - 1].x;
      const dz = p[i].z - p[i - 1].z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      const along = vertical ? Math.abs(dz) : Math.abs(dx);
      if (along / length < 0.95) continue;
      const entry = byName.get(road.tags.name) ?? { sum: 0, weight: 0, low: Infinity, high: -Infinity };
      const cross = vertical ? p[i].x + p[i - 1].x : p[i].z + p[i - 1].z;
      entry.sum += (cross / 2) * length;
      entry.weight += length;
      const a = vertical ? p[i].z : p[i].x;
      const b = vertical ? p[i - 1].z : p[i - 1].x;
      entry.low = Math.min(entry.low, a, b);
      entry.high = Math.max(entry.high, a, b);
      byName.set(road.tags.name, entry);
    }
  }
  const lines = [...byName].map(([name, e]) => ({ name, at: e.sum / e.weight, span: e.high - e.low }));
  return lines.sort((a, b) => a.at - b.at);
}

/** Longest streets win. A street too close to one already kept is dropped. */
function pick(lines: Line[], count: number, reach: number): Line[] {
  const kept: Line[] = [];
  for (const line of [...lines].sort((a, b) => b.span - a.span)) {
    if (line.span < reach * 0.55) continue;
    if (kept.some((k) => Math.abs(k.at - line.at) < MIN_STREET_GAP)) continue;
    kept.push(line);
  }
  // Take a run of neighboring streets, so the result is one connected piece of the city.
  const ordered = kept.sort((a, b) => a.at - b.at);
  const start = Math.max(0, Math.floor((ordered.length - count) / 2));
  return ordered.slice(start, start + count);
}

const allX = roads.flatMap((r) => r.points.map((p) => local(p).x));
const allZ = roads.flatMap((r) => r.points.map((p) => local(p).z));
const columns = pick(streets(true), maxColumns, Math.max(...allZ) - Math.min(...allZ));
const rowsPicked = pick(streets(false), maxRows, Math.max(...allX) - Math.min(...allX));
if (columns.length < 3 || rowsPicked.length < 3) throw new Error(`Not enough of a grid: ${columns.length} by ${rowsPicked.length}`);

// Center on the grid, so the sim's camera and bounds work as they do for the demo town.
const midX = (columns[0].at + columns[columns.length - 1].at) / 2;
const midZ = (rowsPicked[0].at + rowsPicked[rowsPicked.length - 1].at) / 2;
const xs = columns.map((c) => Math.round(c.at - midX));
const zs = rowsPicked.map((r) => Math.round(r.at - midZ));
const placed = (p: [number, number]): Vec2 => {
  const q = local(p);
  return { x: q.x - midX, z: q.z - midZ };
};

const margin = 40;
const inArea = (b: { x: number; z: number }) => b.x > xs[0] - margin && b.x < xs[xs.length - 1] + margin && b.z > zs[0] - margin && b.z < zs[zs.length - 1] + margin;

function heightOf(tags: Record<string, string>) {
  const height = Number.parseFloat(tags.height ?? '');
  if (Number.isFinite(height) && height > 2) return height;
  const levels = Number.parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return levels * METRES_PER_LEVEL;
  return UNKNOWN_HEIGHT;
}

/** Cuts a box back so it stops short of any street, keeping the side its center is on. */
function clearStreets(low: number, high: number, center: number, lines: number[]): [number, number] {
  let a = low;
  let b = high;
  for (const line of lines) {
    const near = line - ROAD_CLEARANCE;
    const far = line + ROAD_CLEARANCE;
    if (center < near) b = Math.min(b, near);
    else if (center > far) a = Math.max(a, far);
    else return [0, 0];
  }
  return [a, b];
}

interface Place extends RealBuilding {
  id: number;
  kind?: DestinationKind;
}

const footprints: Place[] = [];
for (const shape of raw.shapes) {
  if (!shape.tags.building || shape.points.length < 3) continue;
  const corners = shape.points.map(placed);
  const lowX = Math.min(...corners.map((c) => c.x));
  const highX = Math.max(...corners.map((c) => c.x));
  const lowZ = Math.min(...corners.map((c) => c.z));
  const highZ = Math.max(...corners.map((c) => c.z));
  const centerX = (lowX + highX) / 2;
  const centerZ = (lowZ + highZ) / 2;
  const [x0, x1] = clearStreets(lowX, highX, centerX, xs);
  const [z0, z1] = clearStreets(lowZ, highZ, centerZ, zs);
  if (x1 - x0 < MIN_BUILDING_SIDE || z1 - z0 < MIN_BUILDING_SIDE) continue;
  const box = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
  if (!inArea(box)) continue;
  footprints.push({ id: shape.id, ...round(box), h: Math.round(heightOf(shape.tags)), name: shape.tags.name, kind: KINDS.find(([test]) => test.test(shape.tags.name ?? ''))?.[1] });
}

function round<T extends Record<string, number>>(values: T): T {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.round(v * 10) / 10])) as T;
}

const rowsCount = zs.length;
const segmentFor = (b: Vec2) => {
  // The nearest stretch of street to this building, and which side of it the building is on.
  let best: { segment: string; along: number; side: 1 | -1; gap: number } | null = null;
  for (let r = 0; r < rowsCount; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      if (b.x < xs[c] || b.x > xs[c + 1]) continue;
      const gap = Math.abs(b.z - zs[r]);
      // A heading of +x has its right-hand side at -z.
      if (!best || gap < best.gap) best = { segment: `H${r}-${c}`, along: (b.x - xs[c]) / (xs[c + 1] - xs[c]), side: b.z < zs[r] ? 1 : -1, gap };
    }
  }
  return best;
};

const destinations: DestinationSpec[] = [];
const usedNames = new Set<string>();
const featured = footprints.filter((f) => f.name && f.kind).sort((a, b) => b.w * b.d - a.w * a.d);
for (const place of featured) {
  if (destinations.length >= 12 || usedNames.has(place.name!)) continue;
  const spot = segmentFor(place);
  if (!spot || spot.gap > DESTINATION_REACH) continue;
  usedNames.add(place.name!);
  destinations.push({ name: place.name!, kind: place.kind!, segment: spot.segment, along: round({ a: spot.along }).a, side: spot.side });
}
// The app's playbooks expect a cinema. Downtown has theaters, but the data may not name one in this area.
if (!destinations.some((d) => d.kind === 'cinema')) throw new Error('No theater found in this area. Pick a different box.');

// One parking structure, on the middle block of the widest row of blocks, at a real structure if one is mapped.
const GARAGE_WIDTH = 60;
const GARAGE_DEPTH = 32;
const middle = Math.floor((xs.length - 2) / 2);
const blockRow = zs.slice(1).map((z, i) => z - zs[i]).reduce((best, gap, i, gaps) => (gap > gaps[best] ? i : best), 0);
const doorX = (xs[middle] + xs[middle + 1]) / 2;
const doorZ = zs[blockRow] + 15;
const garages: GarageSpec[] = [{ id: 'GA', name: 'Garage A', segment: `H${blockRow}-${middle}`, door: { x: doorX, z: doorZ }, inward: { x: 0, z: 1 }, entryFromEnd: true }];
const clearOfGarage = (b: RealBuilding) => !(Math.abs(b.x - doorX) < GARAGE_WIDTH / 2 + b.w / 2 + 2 && b.z + b.d / 2 > doorZ - 2 && b.z - b.d / 2 < doorZ + GARAGE_DEPTH + 2);

const buildings: RealBuilding[] = footprints.filter(clearOfGarage).map(({ x, z, w, d, h, name }) => ({ x, z, w, d, h, ...(name ? { name } : {}) }));
const layout: CityLayout = {
  xs,
  zs,
  rowStreets: rowsPicked.map((r) => r.name),
  columnStreets: columns.map((c) => c.name),
  garages,
  destinations,
  buildings,
};
const city = buildCity(layout);
writeFileSync(target, JSON.stringify(city));
console.log(`grid turned ${((angle * 180) / Math.PI).toFixed(1)} degrees`);
console.log('north-south:', columns.map((c) => c.name).join(', '), xs.join(' '));
console.log('east-west:', rowsPicked.map((r) => r.name).join(', '), zs.join(' '));
console.log(`${city.segments.length} street segments, ${city.stalls.length} stalls, ${buildings.length} buildings, tallest ${Math.max(...buildings.map((b) => b.h))} m`);
console.log('places:', destinations.map((d) => `${d.name} (${d.kind})`).join('; '));
