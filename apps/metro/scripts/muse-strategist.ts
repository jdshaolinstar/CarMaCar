// Asks Muse Spark to review a metro run and steer TES, then measures whether that helped.
// Run from the repo root: npx tsx --env-file=.env apps/metro/scripts/muse-strategist.ts <cars> <seed>
// Muse reads a short digest of the run, never the map: the network is far too large for that, and
// routing hundreds of thousands of cars is a job for code. It chooses strategy; TES carries it out.
import { writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import { sampleTrips } from '../src/demand';
import { roadWeights, worstRoads } from '../src/digest';
import { loadCity } from '../src/load';
import { MetroSim, type RunConfig, type RunResult } from '../src/simulator';

const MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const cars = Number(process.argv[2] ?? 50000);
const seed = Number(process.argv[3] ?? 1);
const tesShare = Number(process.argv[4] ?? 0.6);
const ROUNDS = 2;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'changes'],
  properties: {
    reasoning: { type: 'string', description: 'Two short sentences on the pattern you see and your plan.' },
    changes: {
      type: 'array',
      description: 'Up to 12 roads to change. Use exact road names from the list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['road', 'factor'],
        properties: {
          road: { type: 'string' },
          factor: { type: 'number', description: 'Route-cost multiplier for TES drivers. 1.3 steers some away, 0.9 attracts them.' },
        },
      },
    },
  },
};

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: 'https://api.meta.ai/v1' });
const { network, grid, matrix } = await loadCity('la');
const { trips, sampleRate } = sampleTrips(matrix, cars, seed);

function simulate(edgeWeights?: Float32Array) {
  const config: RunConfig = {
    sampleRate,
    capacityScale: Number(process.env.CAPACITY ?? 2.3),
    tesShare,
    baseline: 'live-traffic',
    rerouteSeconds: 300,
    horizonSeconds: 6.5 * 3600,
    mapAccuracy: 0.97,
    parkingStart: 0.85,
    tesParking: true,
    coordination: 0.5,
    seed,
    edgeWeights,
  };
  const sim = new MetroSim(network, grid, trips, config);
  const result = sim.run();
  return { result, roads: worstRoads(network, sim.delayByEdge, sampleRate, 25) };
}

const brief = (r: RunResult) => ({
  averageTripMinutes: +r.meanMinutes.toFixed(1),
  rushTripMinutes: +r.rushMeanMinutes.toFixed(1),
  delayHours: Math.round(r.scaled.delayHours),
  vehicleKm: Math.round(r.scaled.vehicleKm),
});

let totalTokens = 0;
async function ask(previous: unknown, roads: unknown) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          "You supervise a regional traffic system for Los Angeles during the morning commute. Its routing code assigns each connected driver a route. You set strategy by raising or lowering the cost of named roads for those drivers. Steering too much traffic off a road just moves the jam, so prefer small changes and judge them by the results you are shown.",
      },
      {
        role: 'user',
        content: `Results so far: ${JSON.stringify(previous)}\nRoads losing the most time, worst first: ${JSON.stringify(roads)}\nDecide your changes for the next run.`,
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'road_changes', strict: true, schema: SCHEMA } },
  } as never);
  totalTokens += (response as any).usage?.total_tokens ?? 0;
  return JSON.parse((response as any).choices[0].message.content ?? '{}') as { reasoning: string; changes: { road: string; factor: number }[] };
}

console.log(`Baseline run: ${cars} cars, ${tesShare * 100}% on TES`);
const base = simulate();
console.log(brief(base.result));
const history: unknown[] = [{ run: 'no strategy', ...brief(base.result) }];
const log: unknown[] = [];
let roads = base.roads;
let best = base.result;
let changes: { road: string; factor: number }[] = [];

for (let round = 1; round <= ROUNDS; round++) {
  const plan = await ask(history, roads);
  console.log(`Muse, round ${round}: ${plan.reasoning}`);
  console.log(plan.changes);
  // Muse's changes build on the last set. A road named again takes its new factor.
  const merged = new Map(changes.map((c) => [c.road, c.factor]));
  for (const change of plan.changes) merged.set(change.road, change.factor);
  changes = [...merged].map(([road, factor]) => ({ road, factor }));
  const { weights, matched } = roadWeights(network, changes);
  const run = simulate(weights);
  console.log(brief(run.result), `matched ${matched} of ${changes.length} roads`);
  history.push({ run: `round ${round}`, changes: plan.changes, ...brief(run.result) });
  log.push({ round, reasoning: plan.reasoning, changes: plan.changes, result: brief(run.result) });
  roads = run.roads;
  if (run.result.meanMinutes < best.meanMinutes) best = run.result;
}

const gain = ((base.result.meanMinutes - best.meanMinutes) / base.result.meanMinutes) * 100;
console.log(`Best gain over TES alone: ${gain.toFixed(2)}%, tokens ${totalTokens}`);
writeFileSync(new URL(`../data/runs/muse-${cars}-s${seed}.json`, import.meta.url), JSON.stringify({ cars, seed, tesShare, base: brief(base.result), log, gainPercent: gain, tokens: totalTokens }, null, 1));
