// Runs one SimTest for the Lab. The Lab starts this as a separate process with the API key removed
// from its environment, so generated code never shares a process with a credential.
// Run by algo-lab.ts: node --import tsx apps/metro/scripts/lab-worker.ts <job.json> <result.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { sampleTrips } from '../src/demand';
import { compileAlgorithm } from '../src/lab-sandbox';
import { loadCity } from '../src/load';
import { HAND_TUNED, MetroSim, paramCost, type RoutingParams } from '../src/simulator';

interface Job {
  cars: number;
  capacity: number;
  seed: number;
  tesShare: number;
  rerouteSeconds: number;
  code?: string;
  params?: RoutingParams;
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
const { network, grid, matrix } = await loadCity('la');
const { trips, sampleRate } = sampleTrips(matrix, job.cars, job.seed);
const started = Date.now();
const sim = new MetroSim(network, grid, trips, {
  sampleRate,
  capacityScale: job.capacity,
  tesShare: job.tesShare,
  baseline: 'live-traffic',
  rerouteSeconds: job.rerouteSeconds,
  horizonSeconds: 6.5 * 3600,
  mapAccuracy: 0.97,
  parkingStart: 0.85,
  tesParking: true,
  coordination: HAND_TUNED.coordination,
  seed: job.seed,
  roadCost: job.code ? compileAlgorithm(job.code) : job.params ? paramCost(job.params) : undefined,
  tesSlices: job.params?.slices ?? HAND_TUNED.slices,
});
const r = sim.run();
writeFileSync(
  process.argv[3],
  JSON.stringify({
    meanMinutes: r.meanMinutes,
    rushMeanMinutes: r.rushMeanMinutes,
    vehicleHours: r.scaled.vehicleHours,
    delayHours: r.scaled.delayHours,
    vehicleKm: r.scaled.vehicleKm,
    finishedShare: r.finished / r.trips,
    seconds: Math.round((Date.now() - started) / 1000),
  }),
);
