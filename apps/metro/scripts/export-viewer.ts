// Packs finished runs into the small files the 2D viewer plays back.
// Run: npx tsx apps/metro/scripts/export-viewer.ts <cars> <run ids> <seed>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SIM_START_HOUR } from '../src/demand';
import { loadNetwork } from '../src/load';

const cars = Number(process.argv[2] ?? 200000);
const ids = (process.argv[3] ?? 'apps,tes30,tes60,tes100').split(',');
const seed = Number(process.argv[4] ?? 1);
const tag = process.env.TAG ? `-${process.env.TAG}` : '';
const FRAME_MINUTES = 10;
/** Very short segments add file size without changing the picture. */
const MIN_LENGTH_METERS = 90;
const SHRINK = 4;

const network = loadNetwork('la');
const out = new URL('../../sim/public/metro/', import.meta.url);
mkdirSync(out, { recursive: true });

const keep: number[] = [];
for (let e = 0; e < network.edgeCount; e++) {
  if (network.edgeLength[e] >= MIN_LENGTH_METERS || network.edgeClass[e] <= 1) keep.push(e);
}

// Layout: counts, then node positions, then padding to 4 bytes, then edge ends, then road storage.
const nodes = new Int16Array(network.nodeCount * 2);
for (let i = 0; i < network.nodeCount; i++) {
  nodes[i * 2] = Math.round(network.nodeX[i] / SHRINK);
  nodes[i * 2 + 1] = Math.round(network.nodeY[i] / SHRINK);
}
const header = Uint32Array.of(network.nodeCount, keep.length);
const ends = new Uint32Array(keep.length * 2);
const storage = new Uint16Array(keep.length);
const classes = new Uint8Array(keep.length);
keep.forEach((e, i) => {
  ends[i * 2] = network.edgeFrom[e];
  ends[i * 2 + 1] = network.edgeTo[e];
  storage[i] = Math.min(65535, network.edgeStorage[e]);
  classes[i] = network.edgeClass[e];
});
const nodeBytes = Buffer.from(nodes.buffer);
const padding = Buffer.alloc((4 - ((8 + nodeBytes.length) % 4)) % 4);
writeFileSync(
  new URL('la-network.bin', out),
  Buffer.concat([Buffer.from(header.buffer), nodeBytes, padding, Buffer.from(ends.buffer), Buffer.from(storage.buffer), Buffer.from(classes.buffer)]),
);

// Real lots and garages, from OpenStreetMap.
const places = JSON.parse(readFileSync(new URL('../data/la-parking.json', import.meta.url), 'utf8')) as { lat: number; lon: number; garage: boolean }[];
const xScale = 111_320 * Math.cos((network.center.lat * Math.PI) / 180);
const parking = new Int16Array(places.length * 3);
places.forEach((p, i) => {
  parking[i * 3] = Math.round(((p.lon - network.center.lon) * xScale) / SHRINK);
  parking[i * 3 + 1] = Math.round(((p.lat - network.center.lat) * 111_320) / SHRINK);
  parking[i * 3 + 2] = p.garage ? 1 : 0;
});
writeFileSync(new URL('la-parking.bin', out), Buffer.from(parking.buffer));

const runs = [];
let frames = 0;
let sampleRate = 1;
let drivers = 0;
for (const id of ids) {
  const name = `la-${cars}-${id}-s${seed}${tag}`;
  const run = JSON.parse(readFileSync(new URL(`../data/runs/${name}.json`, import.meta.url), 'utf8'));
  const raw = readFileSync(new URL(`../data/runs/${name}.bin`, import.meta.url));
  frames = run.perFrame.length;
  sampleRate = run.sampleRate;
  drivers = run.peopleDriving;
  const packed = new Uint8Array(frames * keep.length);
  for (let f = 0; f < frames; f++) {
    const from = f * network.edgeCount;
    const to = f * keep.length;
    keep.forEach((e, i) => (packed[to + i] = raw[from + e]));
  }
  writeFileSync(new URL(`la-run-${id}.bin`, out), packed);
  const r = run.result;
  runs.push({
    id,
    label: run.label,
    tesShare: run.tesShare,
    meanMinutes: r.meanMinutes,
    rushMeanMinutes: r.rushMeanMinutes,
    vehicleHours: r.scaled.vehicleHours,
    delayHours: r.scaled.delayHours,
    vehicleKm: r.scaled.vehicleKm,
    fuelLitres: r.scaled.fuelLitres,
    cruisingHours: r.cruisingHours / run.sampleRate,
    finishedShare: r.finished / r.trips,
    perFrame: run.perFrame,
  });
}

writeFileSync(
  new URL('la-summary.json', out),
  JSON.stringify({
    city: 'Los Angeles basin',
    drivers: Math.round(drivers),
    simulatedCars: cars,
    sampleRate,
    startHour: SIM_START_HOUR,
    frameMinutes: FRAME_MINUTES,
    frames,
    nodes: network.nodeCount,
    edges: keep.length,
    note: 'Simulated morning commute. Roads (c) OpenStreetMap contributors, ODbL. Commute flows from US Census LODES 2023. Road capacity is calibrated so the baseline matches the Census average commute. Not a measurement of real traffic.',
    runs,
  }),
);
console.log(`Wrote ${keep.length} roads, ${frames} frames, ${runs.length} runs`);
