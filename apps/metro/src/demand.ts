// Turns Census home-to-work flows into driving trips for a morning commute.
// LODES gives real commuting patterns by census block. How many people drive, and when they leave,
// are stated assumptions below, since LODES does not record either.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Network } from './network';
import type { Trip, Zones } from './simulator';

export const ZONE_SIZE_METERS = 2500;
/** Where a zone's traffic joins the network. Too few would turn each into a false bottleneck. */
const CONNECTORS_PER_ZONE = Number(process.env.CONNECTORS ?? 10);
const MAX_SNAP_CELLS = 4;
/** Workers who drive themselves on a typical weekday. An assumption, in line with regional surveys. */
export const DRIVE_SHARE = 0.68;
/** Workers who commute on a given weekday, allowing for days off and remote work. */
export const ATTENDANCE = 0.8;
/** Morning commuters who need street parking. Most workers use a lot or garage. */
export const STREET_PARKING_SHARE = 0.25;
export const SIM_START_HOUR = 5;
/** Hours after the start, so 2.75 is 7:45 AM. */
const PEAK_HOUR = 2.75;
/** Standard deviation of departure time. */
const SPREAD_HOURS = Number(process.env.SPREAD ?? 1.2);

export interface ZoneGrid extends Zones {
  /** Zone for each grid cell, or -1. */
  cellZone: Int32Array;
  columns: number;
  rows: number;
  originX: number;
  originY: number;
  zoneX: Float32Array;
  zoneY: Float32Array;
}

export function buildZones(network: Network): ZoneGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < network.nodeCount; i++) {
    minX = Math.min(minX, network.nodeX[i]);
    maxX = Math.max(maxX, network.nodeX[i]);
    minY = Math.min(minY, network.nodeY[i]);
    maxY = Math.max(maxY, network.nodeY[i]);
  }
  const columns = Math.ceil((maxX - minX) / ZONE_SIZE_METERS) + 1;
  const rows = Math.ceil((maxY - minY) / ZONE_SIZE_METERS) + 1;
  const perCell = new Map<number, { node: number; degree: number }[]>();
  for (let node = 0; node < network.nodeCount; node++) {
    const degree = network.outStart[node + 1] - network.outStart[node];
    // Freeway nodes make poor entry points: nobody starts a trip on a freeway.
    let local = false;
    for (let i = network.outStart[node]; i < network.outStart[node + 1]; i++) {
      if (network.edgeClass[network.outgoing[i]] >= 2) local = true;
    }
    if (!local) continue;
    const cell = Math.floor((network.nodeX[node] - minX) / ZONE_SIZE_METERS) + columns * Math.floor((network.nodeY[node] - minY) / ZONE_SIZE_METERS);
    const list = perCell.get(cell) ?? [];
    list.push({ node, degree });
    perCell.set(cell, list);
  }
  const cellZone = new Int32Array(columns * rows).fill(-1);
  const connectors: Int32Array[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [cell, list] of perCell) {
    list.sort((a, b) => b.degree - a.degree);
    const step = Math.max(1, Math.floor(list.length / CONNECTORS_PER_ZONE));
    const chosen = new Int32Array(Math.min(CONNECTORS_PER_ZONE, list.length));
    for (let i = 0; i < chosen.length; i++) chosen[i] = list[i * step].node;
    cellZone[cell] = connectors.length;
    connectors.push(chosen);
    xs.push(network.nodeX[chosen[0]]);
    ys.push(network.nodeY[chosen[0]]);
  }
  return {
    count: connectors.length,
    connectors,
    cellZone,
    columns,
    rows,
    originX: minX,
    originY: minY,
    zoneX: Float32Array.from(xs),
    zoneY: Float32Array.from(ys),
  };
}

function zoneAt(grid: ZoneGrid, x: number, y: number) {
  const cx = Math.floor((x - grid.originX) / ZONE_SIZE_METERS);
  const cy = Math.floor((y - grid.originY) / ZONE_SIZE_METERS);
  for (let radius = 0; radius <= MAX_SNAP_CELLS; radius++) {
    let best = -1;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const col = cx + dx;
        const row = cy + dy;
        if (col < 0 || row < 0 || col >= grid.columns || row >= grid.rows) continue;
        const z = grid.cellZone[col + row * grid.columns];
        if (z < 0) continue;
        const d = (grid.zoneX[z] - x) ** 2 + (grid.zoneY[z] - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = z;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

async function readLines(path: string, onLine: (fields: string[]) => void) {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    onLine(line.split(','));
  }
}

export interface OdMatrix {
  origins: Int32Array;
  destinations: Int32Array;
  workers: Int32Array;
  total: number;
}

/** Reads California's block-to-block flows, keeping trips with both ends on this map. */
export async function readCommutes(network: Network, grid: ZoneGrid, flowsPath: string, blocksPath: string): Promise<OdMatrix> {
  const { center } = network;
  const xScale = 111_320 * Math.cos((center.lat * Math.PI) / 180);
  const blockZone = new Map<string, number>();
  let header: string[] | null = null;
  const lines = createInterface({ input: createReadStream(blocksPath).pipe(createGunzip()), crlfDelay: Infinity });
  let latColumn = -1;
  let lonColumn = -1;
  for await (const line of lines) {
    if (!header) {
      header = line.split(',');
      latColumn = header.indexOf('blklatdd');
      lonColumn = header.indexOf('blklondd');
      continue;
    }
    // Place names hold commas inside quotes, so coordinates are read from the end of the line.
    const fields = line.split(',');
    const fromEnd = header.length;
    const lat = Number(fields[fields.length - (fromEnd - latColumn)]);
    const lon = Number(fields[fields.length - (fromEnd - lonColumn)]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const x = (lon - center.lon) * xScale;
    const y = (lat - center.lat) * 111_320;
    if (x < grid.originX || y < grid.originY || x > grid.originX + grid.columns * ZONE_SIZE_METERS || y > grid.originY + grid.rows * ZONE_SIZE_METERS) continue;
    const zone = zoneAt(grid, x, y);
    if (zone >= 0) blockZone.set(line.slice(0, 15), zone);
  }

  const pairs = new Map<number, number>();
  await readLines(flowsPath, (fields) => {
    const work = blockZone.get(fields[0]);
    const home = blockZone.get(fields[1]);
    if (work === undefined || home === undefined) return;
    const key = home * grid.count + work;
    pairs.set(key, (pairs.get(key) ?? 0) + Number(fields[2]));
  });
  const origins = new Int32Array(pairs.size);
  const destinations = new Int32Array(pairs.size);
  const workers = new Int32Array(pairs.size);
  let i = 0;
  let total = 0;
  for (const [key, count] of pairs) {
    origins[i] = Math.floor(key / grid.count);
    destinations[i] = key % grid.count;
    workers[i++] = count;
    total += count;
  }
  return { origins, destinations, workers, total };
}

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Morning departures: a bell around 7:30 AM, spread across about four hours. */
function departureSeconds(random: () => number) {
  const peak = PEAK_HOUR * 3600;
  const spread = SPREAD_HOURS * 3600;
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.max(0, peak + normal * spread);
}

/** Draws a sample of trips. `peopleDriving` is the whole population; the sample stands in for it. */
export function sampleTrips(matrix: OdMatrix, cars: number, seed: number) {
  const random = mulberry(seed);
  const trips: Trip[] = [];
  const peopleDriving = matrix.total * DRIVE_SHARE * ATTENDANCE;
  const sampleRate = cars / peopleDriving;
  const rate = cars / matrix.total;
  for (let i = 0; i < matrix.workers.length; i++) {
    if (matrix.origins[i] === matrix.destinations[i]) continue;
    const expected = matrix.workers[i] * rate;
    let n = Math.floor(expected);
    if (random() < expected - n) n++;
    for (let k = 0; k < n; k++) {
      trips.push({
        depart: departureSeconds(random),
        originZone: matrix.origins[i],
        destinationZone: matrix.destinations[i],
        needsStreetParking: random() < STREET_PARKING_SHARE,
        adoptionRoll: random(),
      });
    }
  }
  return { trips, sampleRate, peopleDriving };
}
