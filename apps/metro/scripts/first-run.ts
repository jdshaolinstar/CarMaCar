// A quick single run, to see speed and whether the numbers are sane.
// Run: npx tsx apps/metro/scripts/first-run.ts [cars] [mode] [tesShare]
import { sampleTrips } from '../src/demand';
import { loadCity } from '../src/load';
import { MetroSim, type RoutingMode } from '../src/simulator';

const cars = Number(process.argv[2] ?? 20000);
const baseline = (process.argv[3] ?? 'live-traffic') as RoutingMode;
const tesShare = Number(process.argv[4] ?? 0);

const t0 = Date.now();
const { network, grid, matrix } = await loadCity('la');
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s. zones ${grid.count}, OD pairs ${matrix.workers.length}, workers ${matrix.total}`);
const { trips, sampleRate, peopleDriving } = sampleTrips(matrix, cars, 1);
console.log(`trips ${trips.length}, standing for ${Math.round(peopleDriving)} drivers, sample ${(sampleRate * 100).toFixed(2)}%`);
const t1 = Date.now();
const sim = new MetroSim(network, grid, trips, {
  sampleRate,
  tesShare,
  baseline,
  rerouteSeconds: Number(process.argv[5] ?? 300),
  horizonSeconds: 6.5 * 3600,
  mapAccuracy: 0.97,
  parkingStart: 0.85,
  tesParking: true,
  coordination: 0.5,
  seed: 1,
  frameSeconds: 1800,
  onFrame: (f) => console.log(`  ${(5 + f.time / 3600).toFixed(1)}h moving ${f.moving} arrived ${f.arrived} kph ${f.meanSpeedKph.toFixed(0)}`),
});
const result = sim.run();
console.log(`ran in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
console.log(JSON.stringify(result, null, 1));
