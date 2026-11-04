// Shows what drivers who never parked were doing at the end of a run.
//   npx tsx apps/sim/scripts/stuck.ts [seed]
import { generateCity } from '@carmacar/shared';
import { DelayedMapService } from '../src/evaluate';
import { World } from '../src/world';

const city = generateCity();
const seed = Number(process.argv[2] ?? 1);
const holder: { world?: World } = {};
const world = new World(city, seed, null);
holder.world = world;
const service = new DelayedMapService(city, () => holder.world!, 30);
world.setParking(service);
world.populateParked(0.75);
world.setDemand(World.makeDemand(city, seed + 1, 40, 240, { guided: 1 }));

for (let i = 0; i < 7000; i++) {
  world.tick(0.1);
  for (let k = 0; k < 4; k++) await Promise.resolve();
}

const cars = [...world.cars.values()].filter((c) => c.phase === 'drive' && c.speed < 0.5);
console.log(`parked ${world.parkedLog.length}, still driving ${cars.length}`);
for (const c of cars.slice(0, 12)) {
  console.log(
    `${c.id} ${c.mode} v=${c.speed.toFixed(1)} age=${Math.round(world.time - c.spawnedAt)} L${c.level} in=${c.insideGarage} legs=${c.garageLegs.length} lift=${c.pendingLift} merge=${!!c.waitingToMerge}/${c.merging} pos=${c.pos.x.toFixed(0)},${c.pos.z.toFixed(0)} target=${c.targetStallId} ends=${c.endsAtStall} await=${c.awaitingParking} queue=${c.queue.length} edge=${c.edge.from}>${c.edge.to}`,
  );
}
