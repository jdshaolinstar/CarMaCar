// Measures Muse Spark on saved trash frames: as a checker of SAM candidates, and on its own.
//   cd apps/platform && npx tsx --env-file=../../.env scripts/spark-trash-test.ts <frames.json> [model]
import { readFileSync } from 'node:fs';
import { pinhole } from '@carmacar/shared';
import OpenAI from 'openai';
import { SamProvider } from '../src/vision/sam';
import { SparkVision } from '../src/vision/spark';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8').match(/\{[\s\S]*\}/)![0]);
const model = process.argv[3] ?? 'muse-spark-1.3-contributor';
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });
const sam = new SamProvider(client);
let tokens = 0;
const spark = new SparkVision(client, model, (n) => (tokens += n));
const sidewalkY = 0.3;

const nearReal = (shot: any, box: number[]) => {
  const g = pinhole({ ...shot.pose, floorY: sidewalkY }).toGround((box[0] + box[2]) / 2, box[3]);
  return !!g && Math.min(...data.truth.map((t: any) => Math.hypot(t.x - g.x, t.z - g.z))) < 3;
};

let checked = 0;
let keptReal = 0;
let rejectedReal = 0;
const categories: Record<string, number> = {};
let found = 0;
let foundReal = 0;
let checkMs = 0;
let findMs = 0;
let calls = 0;

for (const shot of data.shots) {
  const jpeg = Buffer.from(shot.url.split(',')[1], 'base64');
  const masks = await sam.findConcept(jpeg, 'garbage bag');
  for (const m of masks) {
    const started = Date.now();
    const category = await spark.checkTrash(jpeg, m.box, shot.pose.width, shot.pose.height);
    checkMs += Date.now() - started;
    calls++;
    checked++;
    categories[category] = (categories[category] ?? 0) + 1;
    if (nearReal(shot, m.box)) {
      if (category === 'not trash') rejectedReal++;
      else keptReal++;
    }
  }
  const started = Date.now();
  const items = await spark.findTrash(jpeg, shot.pose);
  findMs += Date.now() - started;
  found += items.length;
  foundReal += items.filter((i) => nearReal(shot, i.box)).length;
}

console.log(`SAM + Spark check: ${checked} candidates, kept ${keptReal} real, rejected ${rejectedReal} real, ${Math.round(checkMs / Math.max(calls, 1))} ms each`);
console.log(`  categories: ${JSON.stringify(categories)}`);
console.log(`Spark alone: ${found} items in ${data.shots.length} frames, ${foundReal} near real litter, ${Math.round(findMs / data.shots.length)} ms per frame`);
console.log(`Tokens: ${tokens}`);
