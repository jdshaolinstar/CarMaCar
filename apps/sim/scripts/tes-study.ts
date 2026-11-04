// Compares city modes on identical drivers. Run: npx tsx apps/sim/scripts/tes-study.ts
// Simulated. Same city, same drivers, same seeds. Only how cars navigate changes.
import { writeFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';
import { runOnce, type RunConfig, type RunResult } from '../src/evaluate';

const city = generateCity();
const SEEDS = (process.argv[2] ?? '1,2,3,4,5,6').split(',').map(Number);
const cinema = city.destinations.find((d) => d.kind === 'cinema')!.id;

const SCENARIOS: { name: string; config: Partial<RunConfig> }[] = [
  { name: 'Everyday traffic', config: { drivers: 60, spanSeconds: 240, parkedShare: 0.8, horizonSeconds: 700 } },
  { name: 'Spiderdude at 8pm', config: { drivers: 110, spanSeconds: 120, parkedShare: 0.7, horizonSeconds: 700, destinations: [cinema] } },
];

const MODES: { name: string; config: Partial<RunConfig> }[] = [
  { name: 'TES off', config: { networkShare: 0 } },
  { name: 'TES on, 60% guided', config: { tes: true, networkShare: 0.6 } },
  { name: 'TES on, 30% guided, 30% autopilot', config: { tes: true, networkShare: 0.3, autopilotShare: 0.3 } },
  { name: 'TES on, 100% autopilot', config: { tes: true, networkShare: 0, autopilotShare: 1 } },
  { name: 'Same, plus smart lights', config: { tes: true, networkShare: 0, autopilotShare: 1, smartLights: true } },
];

const output: unknown[] = [];
for (const scenario of SCENARIOS.filter((x) => !process.argv[3] || x.name.startsWith(process.argv[3]))) {
  console.log(`\n${scenario.name}`);
  console.log('mode                               parked  search  time(s)  driven(m)  walk(m)  city km');
  for (const mode of MODES) {
    const runs: RunResult[] = [];
    for (const seed of SEEDS) {
      runs.push(await runOnce(city, { seed, staleSeconds: 20, networkShare: 0, ...scenario.config, ...mode.config } as RunConfig));
    }
    const avg = (f: (r: RunResult) => number) => runs.reduce((t, r) => t + f(r), 0) / runs.length;
    const row = {
      scenario: scenario.name,
      mode: mode.name,
      parked: avg((r) => r.parked),
      searching: avg((r) => r.stillSearching),
      seconds: avg((r) => r.meanSeconds),
      meters: avg((r) => r.meanMeters),
      walk: avg((r) => r.meanWalkMeters),
      km: avg((r) => r.totalKm),
    };
    output.push(row);
    console.log(
      `${mode.name.padEnd(34)} ${row.parked.toFixed(0).padStart(6)}  ${row.searching.toFixed(0).padStart(6)}  ${row.seconds.toFixed(0).padStart(7)}  ${row.meters.toFixed(0).padStart(9)}  ${row.walk.toFixed(0).padStart(7)}  ${row.km.toFixed(1).padStart(7)}`,
    );
  }
}
writeFileSync(new URL(`./tes-results-${process.argv[3] ?? 'all'}.json`, import.meta.url), JSON.stringify(output, null, 2));
