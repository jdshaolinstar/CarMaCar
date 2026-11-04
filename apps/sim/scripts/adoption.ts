// Prints the adoption curve. Run: npx tsx apps/sim/scripts/adoption.ts
import { writeFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';
import { runOnce, type RunResult } from '../src/evaluate';

const city = generateCity();
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SHARES = [0, 0.25, 0.5, 0.75, 1];
const OCCUPANCY = [0.75, 0.9, 0.95];
const base = { drivers: 40, spanSeconds: 240, staleSeconds: 30, horizonSeconds: 700 };

const output: unknown[] = [];
for (const parkedShare of OCCUPANCY) {
  console.log(`\nStreets ${Math.round(parkedShare * 100)}% full, map up to ${base.staleSeconds}s old, ${SEEDS.length} seeds, ${base.drivers} drivers each`);
  console.log('network  parked  searching  time(s)  driven(m)  walk(m)  city km');
  for (const networkShare of SHARES) {
    const runs: RunResult[] = [];
    for (const seed of SEEDS) runs.push(await runOnce(city, { ...base, seed, parkedShare, networkShare }));
    const avg = (f: (r: RunResult) => number) => runs.reduce((t, r) => t + f(r), 0) / runs.length;
    const row = {
      parkedShare,
      networkShare,
      parked: avg((r) => r.parked),
      stillSearching: avg((r) => r.stillSearching),
      seconds: avg((r) => r.meanSeconds),
      meters: avg((r) => r.meanMeters),
      walk: avg((r) => r.meanWalkMeters),
      km: avg((r) => r.totalKm),
    };
    output.push(row);
    console.log(
      `${String(networkShare * 100).padStart(5)}%  ${row.parked.toFixed(1).padStart(6)}  ${row.stillSearching.toFixed(1).padStart(9)}  ${row.seconds.toFixed(0).padStart(7)}  ${row.meters.toFixed(0).padStart(9)}  ${row.walk.toFixed(0).padStart(7)}  ${row.km.toFixed(1).padStart(7)}`,
    );
  }
}
writeFileSync(new URL('./adoption-results.json', import.meta.url), JSON.stringify(output, null, 2));
