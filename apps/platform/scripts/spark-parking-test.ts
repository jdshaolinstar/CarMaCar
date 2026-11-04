// Checks that Muse Spark can read parking directly, on a saved garage frame.
//   cd apps/platform && npx tsx --env-file=../../.env scripts/spark-parking-test.ts <frames.json>
import { readFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';
import OpenAI from 'openai';
import { SparkVision } from '../src/vision/spark';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8').match(/\{[\s\S]*\}/)![0]);
const city = generateCity();
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });
const spark = new SparkVision(client, 'muse-spark-1.3-contributor', () => {});
const truth = new Set<string>(data.truth);

let right = 0;
let wrong = 0;
for (const shot of data.shots.slice(0, 3)) {
  const started = Date.now();
  const observations = await spark.readStalls(Buffer.from(shot.url.split(',')[1], 'base64'), shot.pose, city.stalls);
  for (const o of observations) {
    if ((o.state === 'occupied') === truth.has(o.stallId)) right++;
    else wrong++;
  }
  console.log(`${shot.name}: ${observations.length} stalls, ${Date.now() - started} ms`);
}
console.log(`Correct: ${right} of ${right + wrong}`);
