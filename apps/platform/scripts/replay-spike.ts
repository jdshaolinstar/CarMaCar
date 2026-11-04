// Replays saved SAM results through the live stall logic, so geometry changes can be measured for free.
//   cd apps/platform && npx tsx scripts/replay-spike.ts
import { readdirSync, readFileSync } from 'node:fs';
import { decodeMaskToRaster, decodeMaskToSVGPath, recordsOfKind } from '@meta-sam/parser';
import type { CameraPose, Stall } from '@carmacar/shared';
import { analyzeFrame } from '../src/vision/stalls';
import type { VehicleMask } from '../src/vision/provider';

const SPIKE = '../../spikes/vision';
const map = JSON.parse(readFileSync(`${SPIKE}/map.json`, 'utf8'));
const stalls: Stall[] = map.stalls.map((s: any) => ({
  id: s.id,
  segmentId: 'spike',
  center: { x: (s.x1 + s.x2) / 2, z: (s.z1 + s.z2) / 2 },
  axis: { x: 1, z: 0 },
  normal: { x: 0, z: 1 },
  length: s.x2 - s.x1,
  width: s.z2 - s.z1,
  along: 0,
}));

function masksFrom(result: any): VehicleMask[] {
  const boxes = new Map(recordsOfKind(result.records, 'box').map((b: any) => [b.objectId, b]));
  return recordsOfKind(result.records, 'mask').map((m: any) => {
    const b: any = boxes.get(m.objectId);
    return {
      objectId: m.objectId,
      box: [b.left, b.top, b.right, b.bottom],
      raster: decodeMaskToRaster(m.mask),
      width: m.mask.width,
      height: m.mask.height,
      svgPath: decodeMaskToSVGPath(m.mask),
    };
  });
}

const layouts = [
  { name: 'A', prefix: 'front-', truth: 'truth.json' },
  { name: 'B', prefix: 'b-', truth: 'truth-b.json' },
  { name: 'C', prefix: 'c-', truth: 'truth-c.json' },
];

let allRight = 0;
let allWrong = 0;
for (const { name, prefix, truth: truthFile } of layouts) {
  const truth = JSON.parse(readFileSync(`${SPIKE}/${truthFile}`, 'utf8'));
  // "___vehicle" files are the repeat-run copies. Counting them would double-count frames.
  const files = readdirSync(`${SPIKE}/cache`).filter((f) => f.startsWith(prefix) && f.endsWith('__vehicle.json') && !f.includes('___'));
  let right = 0;
  const misses: string[] = [];
  for (const file of files) {
    const frame = file.split('__')[0];
    const pose: CameraPose = JSON.parse(readFileSync(`${SPIKE}/frames/${frame}.json`, 'utf8'));
    const result = JSON.parse(readFileSync(`${SPIKE}/cache/${file}`, 'utf8'));
    for (const o of analyzeFrame(masksFrom(result), pose, stalls).observations) {
      if ((o.state === 'occupied') === truth[o.stallId]) right++;
      else misses.push(`${frame}:${o.stallId}=${o.state}`);
    }
  }
  allRight += right;
  allWrong += misses.length;
  console.log(`Layout ${name}: ${right}/${right + misses.length} correct  ${misses.join(' ')}`);
}
console.log(`Total: ${allRight}/${allRight + allWrong} (${((100 * allRight) / (allRight + allWrong)).toFixed(1)}%)`);
