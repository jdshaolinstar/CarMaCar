// Tries SAM prompts on saved frames and reports how close detections land to real objects.
//   cd apps/platform && npx tsx --env-file=../../.env scripts/concept-test.ts <frames.json> "trash" "garbage bag"
import { readFileSync } from 'node:fs';
import { pinhole } from '@carmacar/shared';
import OpenAI from 'openai';
import { SamProvider } from '../src/vision/sam';

const text = readFileSync(process.argv[2], 'utf8');
const data = JSON.parse(text.match(/\{[\s\S]*\}/)![0]);
const concepts = process.argv.slice(3);
const vision = new SamProvider(new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY }));
const sidewalkY = 0.3;

for (const concept of concepts) {
  let objects = 0;
  let hits = 0;
  let misses = 0;
  let framesWithTarget = 0;
  for (const shot of data.shots) {
    const masks = await vision.findConcept(Buffer.from(shot.url.split(',')[1], 'base64'), concept);
    const cam = pinhole({ ...shot.pose, floorY: sidewalkY });
    objects += masks.length;
    let found = false;
    for (const m of masks) {
      const [l, , r, b] = m.box;
      const g = cam.toGround((l + r) / 2, b);
      const nearest = g ? Math.min(...data.truth.map((t: any) => Math.hypot(t.x - g.x, t.z - g.z))) : Infinity;
      if (nearest < 3) hits++;
      else misses++;
      if (g && Math.hypot(shot.item.x - g.x, shot.item.z - g.z) < 3) found = true;
    }
    if (found) framesWithTarget++;
  }
  console.log(`${concept.padEnd(16)} found target in ${framesWithTarget}/${data.shots.length} frames; ${objects} objects, ${hits} near real litter, ${misses} false`);
}
