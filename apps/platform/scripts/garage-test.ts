// Runs saved garage camera frames through the real SAM pipeline and scores them.
//   cd apps/platform && npx tsx --env-file=../../.env scripts/garage-test.ts <frames.json>
import { readFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';
import OpenAI from 'openai';
import { SamProvider } from '../src/vision/sam';
import { analyzeFrame } from '../src/vision/stalls';

const text = readFileSync(process.argv[2], 'utf8');
const data = JSON.parse(text.match(/\{[\s\S]*\}/)![0]);
const truth = new Set<string>(data.truth);
const city = generateCity();
const vision = new SamProvider(new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY }));

let right = 0;
const wrong: string[] = [];
let read = 0;
for (const shot of data.shots) {
  const jpeg = Buffer.from(shot.url.split(',')[1], 'base64');
  const started = Date.now();
  const masks = await vision.findVehicles(jpeg);
  const { observations } = analyzeFrame(masks, shot.pose, city.stalls);
  read += observations.length;
  for (const o of observations) {
    if ((o.state === 'occupied') === truth.has(o.stallId)) right++;
    else wrong.push(`${o.stallId}=${o.state}`);
  }
  console.log(`${shot.name} L${shot.pose.level + 1}: ${masks.length} vehicles, ${observations.length} stalls read, ${Date.now() - started} ms`);
}
const total = right + wrong.length;
console.log(`\nStall readings: ${right}/${total} correct, of ${city.stalls.filter((s) => s.garageId).length} garage stalls`);
console.log(`Wrong: ${wrong.join(' ') || 'none'}`);
