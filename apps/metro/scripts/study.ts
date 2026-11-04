// The metro study: one morning on real roads with real commute patterns, under different routing.
// Run: npx tsx apps/metro/scripts/study.ts <city> <cars> <run ids, comma separated> [seed]
// Each run writes its result, and playback frames for the viewer.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sampleTrips, SIM_START_HOUR } from '../src/demand';
import { compileAlgorithm } from '../src/lab-sandbox';
import { loadCity } from '../src/load';
import { MetroSim, paramCost, type RoutingMode, type RoutingParams } from '../src/simulator';

const FRAME_MINUTES = 10;
export const HORIZON_HOURS = 6.5;
const OUT = new URL('../data/runs/', import.meta.url);

const RUNS: Record<string, { label: string; baseline: RoutingMode; tesShare: number; tesParking: boolean; shareAware?: boolean }> = {
  shortest: { label: 'No traffic data', baseline: 'free-flow', tesShare: 0, tesParking: false },
  apps: { label: "Today's apps", baseline: 'live-traffic', tesShare: 0, tesParking: false },
  tes10: { label: '10% on TES', baseline: 'live-traffic', tesShare: 0.1, tesParking: true },
  tes30: { label: '30% on TES', baseline: 'live-traffic', tesShare: 0.3, tesParking: true },
  tes60: { label: '60% on TES', baseline: 'live-traffic', tesShare: 0.6, tesParking: true },
  tes100: { label: 'Everyone on TES', baseline: 'live-traffic', tesShare: 1, tesParking: true },
  lab60: { label: '60% on TES, Muse algorithm', baseline: 'live-traffic', tesShare: 0.6, tesParking: true },
  tes30s: { label: '30% on TES', baseline: 'live-traffic', tesShare: 0.3, tesParking: true, shareAware: true },
  tes60s: { label: '60% on TES', baseline: 'live-traffic', tesShare: 0.6, tesParking: true, shareAware: true },
  lab30: { label: '30% on TES, Muse algorithm', baseline: 'live-traffic', tesShare: 0.3, tesParking: true },
  tes60np: { label: '60% on TES, no parking guidance', baseline: 'live-traffic', tesShare: 0.6, tesParking: false },
};

/** A finished Lab session, for applying its winner at full size. Set LAB to its JSON file. */
const lab = process.env.LAB ? (JSON.parse(readFileSync(process.env.LAB, 'utf8')) as { winner: { code?: string; params?: RoutingParams } }) : null;

const city = process.argv[2] ?? 'la';
const cars = Number(process.argv[3] ?? 200000);
const ids = (process.argv[4] ?? 'apps').split(',');
const seed = Number(process.argv[5] ?? 1);
const rerouteSeconds = Number(process.env.REROUTE ?? 300);
const coordination = Number(process.env.COORDINATION ?? 0.5);

mkdirSync(OUT, { recursive: true });
const { network, grid, matrix } = await loadCity(city);
const { trips, sampleRate, peopleDriving } = sampleTrips(matrix, cars, seed);
console.log(`${trips.length} cars for ${Math.round(peopleDriving)} drivers, sample ${(sampleRate * 100).toFixed(2)}%`);

for (const id of ids) {
  const run = RUNS[id];
  const started = Date.now();
  const frameCount = Math.ceil((HORIZON_HOURS * 60) / FRAME_MINUTES);
  const frames = new Uint8Array(frameCount * network.edgeCount);
  const perFrame: { moving: number; arrived: number; kph: number }[] = [];
  const sim = new MetroSim(network, grid, trips, {
    sampleRate,
    capacityScale: Number(process.env.CAPACITY ?? 1),
    tesShare: run.tesShare,
    baseline: run.baseline,
    rerouteSeconds,
    horizonSeconds: HORIZON_HOURS * 3600,
    mapAccuracy: 0.97,
    parkingStart: Number(process.env.PARKING ?? 0.85),
    tesParking: run.tesParking,
    coordination,
    seed,
    roadCost: lab?.winner.code ? compileAlgorithm(lab.winner.code) : lab?.winner.params ? paramCost(lab.winner.params) : undefined,
    tesSlices: lab?.winner.params?.slices,
    shareAwareLoad: run.shareAware,
    frameSeconds: FRAME_MINUTES * 60,
    onFrame: (f) => {
      const index = perFrame.length;
      if (index >= frameCount) return;
      perFrame.push({ moving: f.moving, arrived: f.arrived, kph: Math.round(f.meanSpeedKph) });
      const offset = index * network.edgeCount;
      for (let e = 0; e < network.edgeCount; e++) {
        const held = Math.max(1, network.edgeStorage[e] * sampleRate);
        frames[offset + e] = Math.min(255, Math.round((f.onEdge[e] / held) * 255));
      }
      if (index % 6 === 0) console.log(`${id} ${(SIM_START_HOUR + f.time / 3600).toFixed(1)}h on road ${f.moving} arrived ${f.arrived}`);
    },
  });
  const result = sim.run();
  const name = `${city}-${cars}-${id}-s${seed}${process.env.TAG ? `-${process.env.TAG}` : ''}`;
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ id, ...run, city, cars, seed, sampleRate, peopleDriving, rerouteSeconds, coordination, result, perFrame }, null, 1));
  writeFileSync(new URL(`${name}.bin`, OUT), frames);
  console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(0)} s, trip ${result.meanMinutes.toFixed(1)} min, rush ${result.rushMeanMinutes.toFixed(1)}, finished ${result.finished}/${result.trips}`);
}
