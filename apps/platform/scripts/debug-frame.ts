// Prints where each detected vehicle lands on the ground in a saved spike frame.
//   cd apps/platform && npx tsx scripts/debug-frame.ts c-03
import { readFileSync } from 'node:fs';
import { decodeMaskToRaster, recordsOfKind } from '@meta-sam/parser';
import { pinhole, type CameraPose } from '@carmacar/shared';
import { lowerHull } from '../src/vision/stalls';

const SPIKE = '../../spikes/vision';
const frame = process.argv[2];
const pose: CameraPose = JSON.parse(readFileSync(`${SPIKE}/frames/${frame}.json`, 'utf8'));
const result = JSON.parse(readFileSync(`${SPIKE}/cache/${frame}__vehicle.json`, 'utf8'));
const cam = pinhole(pose);
console.log('camera', pose.position, 'target', pose.target);

const boxes = new Map(recordsOfKind(result.records, 'box').map((b: any) => [b.objectId, b]));
for (const m of recordsOfKind(result.records, 'mask') as any[]) {
  const b: any = boxes.get(m.objectId);
  const raster = decodeMaskToRaster(m.mask);
  const { width: W, height: H } = m.mask;
  const sx = (b.right - b.left) / W;
  const sy = (b.bottom - b.top) / H;
  const contour: { col: number; row: number }[] = [];
  for (let col = 0; col < W; col++) {
    for (let row = H - 1; row >= 0; row--) {
      if (raster[row * W + col]) {
        contour.push({ col, row });
        break;
      }
    }
  }
  const toWorld = (p: { col: number; row: number }) => cam.toGround(b.left + (p.col + 0.5) * sx, b.top + (p.row + 1) * sy);
  const raw = contour.map(toWorld).filter(Boolean) as { x: number; z: number }[];
  const hull = lowerHull(contour).map(toWorld).filter(Boolean) as { x: number; z: number }[];
  const range = (pts: { x: number; z: number }[], k: 'x' | 'z') =>
    `${Math.min(...pts.map((p) => p[k])).toFixed(1)}..${Math.max(...pts.map((p) => p[k])).toFixed(1)}`;
  console.log(
    `obj ${m.objectId} box ${[b.left, b.top, b.right, b.bottom].map((n: number) => Math.round(n)).join(',')} mask ${W}x${H}`,
    `\n  raw  x ${range(raw, 'x')}  z ${range(raw, 'z')}`,
    `\n  hull x ${range(hull, 'x')}  z ${range(hull, 'z')}`,
  );
}
