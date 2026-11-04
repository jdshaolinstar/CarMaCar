// Asks Muse Spark to write the city-facing summary of a finished study.
// Run from the repo root: npx tsx --env-file=.env apps/metro/scripts/muse-summary.ts <cars> <seed> <run id>
// Muse explains; it does not measure. It sees numbers the simulator produced, and a summary that
// contains any other number is rejected, so a figure on screen always traces back to a run.
import { readFileSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import { loadNetwork } from '../src/load';

const MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const cars = Number(process.argv[2] ?? 200000);
const seed = Number(process.argv[3] ?? 1);
const targetId = process.argv[4] ?? 'tes100';
const FRAME_HOURS = 10 / 60;
/** A road this full, as a share of what it can hold, counts as jammed. */
const JAMMED = 0.48;
const ROADS = 10;

const network = loadNetwork('la');
const tag = process.env.TAG ? `-${process.env.TAG}` : '';
const runFile = (id: string, ext: string) => new URL(`../data/runs/la-${cars}-${id}-s${seed}${tag}.${ext}`, import.meta.url);

/** Road-km jammed, summed over the morning and grouped by road name, from the stored frames. */
function jammedRoads(id: string) {
  const frames = readFileSync(runFile(id, 'bin'));
  const frameCount = Math.floor(frames.length / network.edgeCount);
  const hours = new Float64Array(network.names.length);
  for (let f = 0; f < frameCount; f++) {
    const offset = f * network.edgeCount;
    for (let e = 0; e < network.edgeCount; e++) {
      const name = network.edgeName[e];
      if (name >= 0 && frames[offset + e] / 255 >= JAMMED) hours[name] += (network.edgeLength[e] / 1000) * FRAME_HOURS;
    }
  }
  return hours;
}

const results = (id: string) => JSON.parse(readFileSync(runFile(id, 'json'), 'utf8'));
const base = results('apps');
const target = results(targetId);
const baseJam = jammedRoads('apps');
const targetJam = jammedRoads(targetId);

const order = [...baseJam.keys()].sort((a, b) => baseJam[b] - baseJam[a]).slice(0, ROADS);
const roads = order.map((i) => ({ road: network.names[i], jammedKmHoursToday: Math.round(baseJam[i]), jammedKmHoursWithTes: Math.round(targetJam[i]) }));
const percent = (a: number, b: number) => Math.round(((a - b) / a) * 1000) / 10;
const facts = {
  driversModeled: Math.round(base.peopleDriving),
  tesShareOfDrivers: `${Math.round(target.tesShare * 100)}%`,
  averageCommuteMinutes: { today: +base.result.meanMinutes.toFixed(1), withTes: +target.result.meanMinutes.toFixed(1) },
  rushHourCommuteMinutes: { today: +base.result.rushMeanMinutes.toFixed(1), withTes: +target.result.rushMeanMinutes.toFixed(1) },
  vehicleHours: { today: Math.round(base.result.scaled.vehicleHours), withTes: Math.round(target.result.scaled.vehicleHours), percentLess: percent(base.result.scaled.vehicleHours, target.result.scaled.vehicleHours) },
  delayHours: { today: Math.round(base.result.scaled.delayHours), withTes: Math.round(target.result.scaled.delayHours), percentLess: percent(base.result.scaled.delayHours, target.result.scaled.delayHours) },
  vehicleKm: { today: Math.round(base.result.scaled.vehicleKm), withTes: Math.round(target.result.scaled.vehicleKm) },
  fuelLitres: { today: Math.round(base.result.scaled.fuelLitres), withTes: Math.round(target.result.scaled.fuelLitres), percentLess: percent(base.result.scaled.fuelLitres, target.result.scaled.fuelLitres) },
  roads,
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'findings', 'caution'],
  properties: {
    headline: { type: 'string', description: 'One sentence for a city transportation director.' },
    findings: { type: 'array', description: 'Exactly three short sentences, each about a different finding.', items: { type: 'string' } },
    caution: { type: 'string', description: 'One sentence on what this modeled result does not prove.' },
  },
};

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: 'https://api.meta.ai/v1' });
let tokens = 0;

async function ask(feedback: string) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          "You brief a city transportation director on a simulated morning commute on Los Angeles's real road network. Use only numbers from the facts, written exactly as given or rounded from them to fewer digits. Do not calculate new numbers, percentages or dollar values. Say modeled, not measured. If something got worse or barely changed, say so.",
      },
      { role: 'user', content: `Facts: ${JSON.stringify(facts)}${feedback}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'city_summary', strict: true, schema: SCHEMA } },
  } as never);
  tokens += (response as any).usage?.total_tokens ?? 0;
  return JSON.parse((response as any).choices[0].message.content ?? '{}') as { headline: string; findings: string[]; caution: string };
}

/** Numbers in Muse's text that no fact supports, allowing for rounding and thousands or millions. */
function unsupported(text: string) {
  const known = JSON.stringify(facts).match(/\d+(\.\d+)?/g)!.map(Number);
  const allowed = known.flatMap((n) => [n, n / 1e3, n / 1e6]);
  const found = text.replace(/\b\d{1,3}(,\d{3})+\b/g, (m) => m.replace(/,/g, '')).match(/\d+(\.\d+)?/g) ?? [];
  return found.filter((token) => {
    const value = Number(token);
    const places = token.split('.')[1]?.length ?? 0;
    const step = 10 ** -places;
    return !allowed.some((n) => Math.abs(n - value) <= step / 2 + 1e-9);
  });
}

let summary = await ask('');
let wrong = unsupported([summary.headline, ...summary.findings, summary.caution].join(' '));
if (wrong.length) {
  console.log('Rejected, numbers not in the facts:', wrong);
  summary = await ask(`\nYour last draft used numbers that are not in the facts: ${wrong.join(', ')}. Remove them.`);
  wrong = unsupported([summary.headline, ...summary.findings, summary.caution].join(' '));
}
if (wrong.length) throw new Error(`Summary still has unsupported numbers: ${wrong.join(', ')}`);

console.log(JSON.stringify(summary, null, 1));
console.log(`tokens ${tokens}`);
writeFileSync(new URL('../../sim/public/metro/la-muse.json', import.meta.url), JSON.stringify({ model: MODEL, runId: targetId, facts, ...summary }, null, 1));
