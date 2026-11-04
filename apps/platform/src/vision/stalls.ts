// Turns vehicle masks into per-stall observations using geometry alone.
// This is the deterministic layer: same masks and pose, same answer, every time.
import { dot, pinhole, sub, type CameraPose, type PinholeCamera, type Stall, type StallState, type Vec2 } from '@carmacar/shared';
import type { VehicleMask } from './provider';

export const MAX_RANGE = 26;
const MIN_CONTACT = 0.3;
const MIN_IN_FRAME = 0.95;
const MIN_VISIBLE = 0.6;
// A car's road contact can sit slightly outside the stall lines.
const STREET_SIDE_SLACK = 1.2;
/** Metres past the stall's center line, toward the curb, that a contact point may sit. */
const NEAR_SIDE_LIMIT = 0.1;
// Spike street frames measured 0.026 to 0.054 bytes per pixel.
const MIN_JPEG_BYTES_PER_PIXEL = 0.015;

export interface StallObservation {
  stallId: string;
  state: StallState;
  /** Closer frames count for more. */
  weight: number;
}

export interface FrameAnalysis {
  observations: StallObservation[];
  /** objectId to the stall it was assigned to. */
  assignments: Map<string, string>;
  /** Vehicles in the road, not parked, by street. Counts everyone, on the network or not. */
  roadVehicles: Map<string, number>;
}

interface Located {
  mask: VehicleMask;
  ground: Vec2[];
  covered(x: number, y: number): boolean;
}

/** The bottom envelope of a contour in image space, with one point per column. Rows grow downward. */
export function lowerHull(points: { col: number; row: number }[]): { col: number; row: number }[] {
  const hull: { col: number; row: number }[] = [];
  for (const p of points) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      if ((b.row - a.row) * (p.col - a.col) > (p.row - a.row) * (b.col - a.col)) break;
      hull.pop();
    }
    hull.push(p);
  }
  const filled: { col: number; row: number }[] = [];
  for (let i = 1; i < hull.length; i++) {
    const a = hull[i - 1];
    const b = hull[i];
    for (let col = a.col; col < b.col; col++) {
      filled.push({ col, row: a.row + ((b.row - a.row) * (col - a.col)) / (b.col - a.col) });
    }
  }
  if (hull.length > 0) filled.push(hull[hull.length - 1]);
  return filled;
}

function locate(mask: VehicleMask, cam: PinholeCamera): Located {
  const [left, top, right, bottom] = mask.box;
  const sx = (right - left) / mask.width;
  const sy = (bottom - top) / mask.height;
  const contour: { col: number; row: number }[] = [];
  for (let col = 0; col < mask.width; col++) {
    for (let row = mask.height - 1; row >= 0; row--) {
      if (mask.raster[row * mask.width + col]) {
        contour.push({ col, row });
        break;
      }
    }
  }
  // Only the wheels touch the road. The body floats about 0.3 m up, and from a low camera that
  // reads as several metres too far away, landing the car in the next stall. The lower hull of
  // the mask's bottom edge runs between the wheels, which is the true ground line.
  const ground: Vec2[] = [];
  for (const { col, row } of lowerHull(contour)) {
    const point = cam.toGround(left + (col + 0.5) * sx, top + (row + 1) * sy);
    if (point) ground.push(point);
  }
  return {
    mask,
    ground,
    covered(x, y) {
      if (x < left || x >= right || y < top || y >= bottom) return false;
      const col = Math.floor((x - left) / sx);
      const row = Math.floor((y - top) / sy);
      return mask.raster[row * mask.width + col] === 1;
    },
  };
}

/** Fraction of the stall's length that this car's road-contact line spans. */
function contactSpan(car: Located, stall: Stall): number {
  const along: number[] = [];
  for (const p of car.ground) {
    const rel = sub(p, stall.center);
    const s = dot(rel, stall.axis);
    const t = dot(rel, stall.normal);
    const inLength = Math.abs(s) < stall.length / 2;
    // Only the car's street-facing side counts. Its far wheels and front rise up the image and
    // back-project metres away, which used to land a car in the next stall along.
    const inWidth = t > -stall.width / 2 - STREET_SIDE_SLACK && t < NEAR_SIDE_LIMIT;
    if (inLength && inWidth) along.push(s);
  }
  return along.length > 1 ? (Math.max(...along) - Math.min(...along)) / stall.length : 0;
}

export interface RoadSegment {
  id: string;
  start: Vec2;
  dir: Vec2;
  length: number;
  halfWidth: number;
}

function isOnRoad(point: Vec2, seg: RoadSegment) {
  const rel = sub(point, seg.start);
  const along = dot(rel, seg.dir);
  return along >= 0 && along <= seg.length && Math.abs(rel.x * seg.dir.z - rel.z * seg.dir.x) <= seg.halfWidth;
}

/** A real street frame is busy. A near-uniform frame is a camera fault, not an empty street. */
export function isUsableFrame(jpeg: Buffer, width: number, height: number): boolean {
  return jpeg.length / (width * height) >= MIN_JPEG_BYTES_PER_PIXEL;
}

export function analyzeFrame(masks: VehicleMask[], pose: CameraPose, stalls: Stall[], segments: RoadSegment[] = []): FrameAnalysis {
  const cam = pinhole(pose);
  const eye = { x: pose.position[0], z: pose.position[2] };
  // Walls and floors block the view: a camera only reads stalls in the same space as itself.
  const sameSpace = (s: Stall) => s.garageId === pose.garageId && (s.level ?? 0) === (pose.level ?? 0);
  const nearby = stalls.filter((s) => sameSpace(s) && Math.hypot(s.center.x - eye.x, s.center.z - eye.z) <= MAX_RANGE);
  const cars = masks.map((m) => locate(m, cam));

  // One car, one stall: each car counts only for the stall it overlaps most.
  const assignments = new Map<string, string>();
  const bestContact = new Map<string, number>();
  for (const car of cars) {
    let best: Stall | null = null;
    let bestSpan = 0;
    for (const stall of nearby) {
      const span = contactSpan(car, stall);
      if (span > bestSpan) {
        bestSpan = span;
        best = stall;
      }
    }
    if (best) {
      assignments.set(car.mask.objectId, best.id);
      bestContact.set(best.id, Math.max(bestContact.get(best.id) ?? 0, bestSpan));
    }
  }

  const observations: StallObservation[] = [];
  for (const stall of nearby) {
    const dist = Math.hypot(stall.center.x - eye.x, stall.center.z - eye.z);
    let state: StallState = 'unknown';
    if ((bestContact.get(stall.id) ?? 0) >= MIN_CONTACT) {
      state = 'occupied';
    } else {
      // "Free" sends a driver somewhere, so the whole stall must be in view.
      let inFrame = 0;
      let visible = 0;
      const samples = 21;
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 3; j++) {
          const s = ((i + 0.5) / 7 - 0.5) * stall.length;
          const t = ((j + 0.5) / 3 - 0.5) * stall.width;
          const px = cam.project([
            stall.center.x + stall.axis.x * s + stall.normal.x * t,
            pose.floorY ?? 0,
            stall.center.z + stall.axis.z * s + stall.normal.z * t,
          ]);
          if (!px || px[0] < 0 || px[0] >= pose.width || px[1] < 0 || px[1] >= pose.height) continue;
          inFrame++;
          if (!cars.some((c) => c.covered(px[0], px[1]))) visible++;
        }
      }
      if (inFrame / samples >= MIN_IN_FRAME && visible / samples >= MIN_VISIBLE) state = 'free';
    }
    if (state !== 'unknown') observations.push({ stallId: stall.id, state, weight: 1 / Math.max(dist, 8) });
  }
  const roadVehicles = new Map<string, number>();
  if (!pose.garageId) {
    for (const car of cars) {
      if (assignments.has(car.mask.objectId) || car.ground.length === 0) continue;
      const nearest = car.ground[Math.floor(car.ground.length / 2)];
      const seg = segments.find((s) => isOnRoad(nearest, s));
      if (seg) roadVehicles.set(seg.id, (roadVehicles.get(seg.id) ?? 0) + 1);
    }
  }
  return { observations, assignments, roadVehicles };
}

const TRASH_MIN_RANGE = 3;
const TRASH_MAX_RANGE = 24;

/** Where trash sits on the sidewalk, from masks. Uses the bottom of each box, which touches the ground. */
export function locateTrash(masks: VehicleMask[], pose: CameraPose, sidewalkHeight: number): Vec2[] {
  const cam = pinhole({ ...pose, floorY: sidewalkHeight });
  const eye = { x: pose.position[0], z: pose.position[2] };
  const found: Vec2[] = [];
  for (const mask of masks) {
    const [left, , right, bottom] = mask.box;
    const point = cam.toGround((left + right) / 2, bottom);
    if (!point) continue;
    const range = Math.hypot(point.x - eye.x, point.z - eye.z);
    if (range >= TRASH_MIN_RANGE && range <= TRASH_MAX_RANGE) found.push(point);
  }
  return found;
}

/** Whether a spot is clearly in view, so that seeing nothing there means something. */
export function trashSpotInView(point: Vec2, pose: CameraPose, sidewalkHeight: number): boolean {
  const px = pinhole(pose).project([point.x, sidewalkHeight, point.z]);
  if (!px || px[0] < 40 || px[0] > pose.width - 40 || px[1] < 40 || px[1] > pose.height - 40) return false;
  const range = Math.hypot(point.x - pose.position[0], point.z - pose.position[2]);
  return range >= 5 && range <= 14;
}
