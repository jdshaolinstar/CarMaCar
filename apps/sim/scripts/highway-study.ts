// Does knowing every exit in advance help? Run: npx tsx apps/sim/scripts/highway-study.ts [seeds] [perHour]
// Simulated. Same drivers, same seeds. Only what TES knows and who follows it changes.
import { writeFileSync } from 'node:fs';
import { highwayLayout, MPH, type HighwayTesOptions } from '@carmacar/shared';
import { HighwaySim, makeHighwayDemand, type HighwayConfig, type HighwayMix, type HighwayResult } from '../src/highway';

const layout = { ...highwayLayout(), baseRampGreen: Number(process.env.GREEN ?? 24) };
const SEEDS = (process.argv[2] ?? '1,2,3,4').split(',').map(Number);
const SPAN = 1500;
const HORIZON = 2700;

const SCENARIOS = [
  { name: 'Rush hour', perHour: Number(process.argv[3] ?? 3200), zones: [1, 1, 1, 1, 1] },
  { name: 'Stadium event', perHour: Number(process.argv[4] ?? 3000), zones: [1, 1, 1, 1, 5] },
];
const LIMITS = [55, 65, 75];

const everything: HighwayTesOptions = { cameras: true, prepare: true, keepLeft: true, rebalance: true, smartSignals: true, harmonize: false };
const none: HighwayTesOptions = { cameras: false, prepare: false, keepLeft: false, rebalance: false, smartSignals: false, harmonize: false };
const auto = { guidedShare: 0, autopilotShare: 1 };
const LEVERS: { name: string; tes: HighwayTesOptions | null; mix: HighwayMix }[] = [
  { name: 'TES off', tes: null, mix: { guidedShare: 0, autopilotShare: 0 } },
  { name: 'Lights only, cameras', tes: { ...none, cameras: true, smartSignals: true }, mix: { guidedShare: 0, autopilotShare: 0 } },
  { name: 'Early lane moves', tes: { ...none, prepare: true }, mix: auto },
  { name: 'Keep right lane clear', tes: { ...none, keepLeft: true }, mix: auto },
  { name: 'Exit choice', tes: { ...none, cameras: true, rebalance: true }, mix: auto },
  { name: 'Slow upstream', tes: { ...none, cameras: true, harmonize: true }, mix: auto },
  { name: 'Lanes + keep clear', tes: { ...none, prepare: true, keepLeft: true }, mix: auto },
  { name: 'All but lights', tes: { ...everything, smartSignals: false }, mix: auto },
  { name: 'All', tes: everything, mix: auto },
];
const FULL: { name: string; tes: HighwayTesOptions | null; mix: HighwayMix }[] = [
  { name: 'TES off', tes: null, mix: { guidedShare: 0, autopilotShare: 0 } },
  { name: '30% guided, GPS only', tes: { ...everything, cameras: false }, mix: { guidedShare: 0.3, autopilotShare: 0 } },
  { name: '30% guided, plus cameras', tes: everything, mix: { guidedShare: 0.3, autopilotShare: 0 } },
  { name: '60% guided, plus cameras', tes: everything, mix: { guidedShare: 0.6, autopilotShare: 0 } },
  { name: '100% autopilot', tes: everything, mix: { guidedShare: 0, autopilotShare: 1 } },
];

const output: unknown[] = [];
const only = process.env.LEVERS ? undefined : process.argv[5];
const MODES = process.env.LEVERS ? LEVERS : FULL;
const LIMITS_RUN = process.env.LIMITS ? process.env.LIMITS.split(',').map(Number) : LIMITS;
for (const scenario of SCENARIOS) {
  console.log(`\n${scenario.name}, ${scenario.perHour} trips per hour`);
  console.log('limit  mode                       finished  trip(s)  mph   slow%  missed  spill(s)  hard(s)  cross(s) left  sys-h  overlaps');
  for (const mph of LIMITS_RUN) {
    for (const mode of MODES) {
      if (only && !mode.name.startsWith(only)) continue;
      const runs: HighwayResult[] = [];
      for (const seed of SEEDS) {
        const config: HighwayConfig = {
          speedLimit: mph * MPH,
          demand: makeHighwayDemand(layout, seed, scenario.perHour, SPAN, scenario.zones),
          mix: mode.mix,
          tes: mode.tes,
          horizonSeconds: HORIZON,
          crossRate: Number(process.env.CROSS ?? 0.2),
          cameraRecall: 0.97,
          seed,
        };
        runs.push(new HighwaySim(layout, config).run());
      }
      const avg = (f: (r: HighwayResult) => number) => runs.reduce((t, r) => t + f(r), 0) / runs.length;
      const row = {
        scenario: scenario.name,
        limit: mph,
        mode: mode.name,
        trips: avg((r) => r.trips),
        finished: avg((r) => r.finished),
        seconds: avg((r) => r.meanTripSeconds),
        mph: avg((r) => r.meanMainlineMph),
        slow: avg((r) => r.slowShare),
        missed: avg((r) => r.missedExits),
        spill: avg((r) => r.spillbackSeconds),
        hard: avg((r) => r.hardBrakeSeconds),
        cross: avg((r) => r.crossDelaySeconds),
        crossLeft: avg((r) => r.crossQueueLeft),
        systemHours: avg((r) => r.systemHours),
        overlaps: avg((r) => r.overlaps),
      };
      output.push(row);
      console.log(
        `${String(mph).padStart(5)}  ${mode.name.padEnd(26)} ${row.finished.toFixed(0).padStart(5)}/${row.trips.toFixed(0)}  ${row.seconds.toFixed(0).padStart(6)}  ${row.mph.toFixed(0).padStart(3)}  ${(row.slow * 100).toFixed(0).padStart(5)}  ${row.missed.toFixed(0).padStart(6)}  ${row.spill.toFixed(0).padStart(8)}  ${row.hard.toFixed(0).padStart(7)}  ${row.cross.toFixed(0).padStart(7)} ${row.crossLeft.toFixed(0).padStart(4)}  ${row.systemHours.toFixed(0).padStart(5)}  ${row.overlaps.toFixed(0).padStart(8)}`,
      );
    }
  }
}
if (!only && !process.env.LEVERS) writeFileSync(new URL('./highway-results.json', import.meta.url), JSON.stringify(output, null, 2));
