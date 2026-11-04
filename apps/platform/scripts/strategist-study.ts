// Does the Spark Strategist help? Same surge, same drivers, with and without it.
// The simulation pauses while Spark thinks, so its latency is not part of this result.
//   cd apps/platform && npx tsx --env-file=../../.env scripts/strategist-study.ts 1,2,3
import { writeFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';
import OpenAI from 'openai';
import { runOnce, type RunConfig, type RunResult } from '../../sim/src/evaluate';
import { runStrategistCycle } from '../src/strategist';

const city = generateCity();
const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const model = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });
const cinema = city.destinations.find((d) => d.kind === 'cinema')!.id;
let tokens = 0;
let actions = 0;

const scenario: Partial<RunConfig> = {
  drivers: 110,
  spanSeconds: 120,
  parkedShare: 0.7,
  horizonSeconds: 700,
  staleSeconds: 20,
  destinations: [cinema],
  tes: true,
  networkShare: 0.3,
  autopilotShare: 0.3,
  smartLights: true,
};

async function run(seed: number, strategist: boolean): Promise<RunResult> {
  let last: string | null = null;
  return runOnce(city, {
    seed,
    ...scenario,
    hook: strategist
      ? {
          everySeconds: 30,
          async run(tes, world) {
            last = await runStrategistCycle(
              {
                client,
                model,
                engine: tes.engine,
                now: world.time,
                available: (s) => !world.stallOwner.has(s.id),
                log: (kind, detail, name) => {
                  if (kind === 'tool_call') {
                    actions++;
                    console.log(`    t=${Math.round(world.time)} ${name} ${detail}`);
                  } else if (kind === 'error') console.log(`    error ${detail}`);
                },
                onTokens: (n) => (tokens += n),
              },
              last,
            );
          },
        }
      : undefined,
  } as RunConfig);
}

const rows: unknown[] = [];
for (const strategist of [false, true]) {
  const runs: RunResult[] = [];
  for (const seed of seeds) {
    const result = await run(seed, strategist);
    console.log(`${strategist ? 'with' : 'without'} seed ${seed}: parked ${result.parked}, searching ${result.stillSearching}, ${Math.round(result.meanSeconds)} s`);
    runs.push(result);
  }
  const avg = (f: (r: RunResult) => number) => runs.reduce((t, r) => t + f(r), 0) / runs.length;
  const row = { strategist, parked: avg((r) => r.parked), searching: avg((r) => r.stillSearching), seconds: avg((r) => r.meanSeconds), walk: avg((r) => r.meanWalkMeters), km: avg((r) => r.totalKm) };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.log(`Strategist actions: ${actions}, tokens: ${tokens}`);
writeFileSync(new URL('./strategist-results.json', import.meta.url), JSON.stringify(rows, null, 2));
