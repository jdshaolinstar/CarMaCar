// Shows what drivers who never parked were doing at the end of a run.
//   npx tsx apps/sim/scripts/stuck.ts [seed]
import { generateCity } from '@carmacar/shared';
import { TesService } from '../src/evaluate';
import { World } from '../src/world';

const city = generateCity();
const seed = Number(process.argv[2] ?? 1);
const holder: { world?: World } = {};
const world = new World(city, seed, null);
holder.world = world;
const tes = new TesService(city, () => holder.world!, 20, 0.1, true, false);
world.setParking(tes);
world.populateParked(0.8);
world.setDemand(World.makeDemand(city, seed + 1, 60, 240, { autopilot: 1 }));

for (let i = 0; i < 7000; i++) {
  world.tick(0.1);
  tes.feed();
  for (let k = 0; k < 4; k++) await Promise.resolve();
}

const cars = [...world.cars.values()].filter((c) => (c.role === 'network' || c.role === 'manual') && c.phase === 'drive' && c.mode !== 'exit');
console.log(`parked ${world.parkedLog.length}, still driving ${cars.length}`);
for (const c of cars.slice(0, 12)) {
  console.log(
    `${c.id} ${c.mode} v=${c.speed.toFixed(1)} age=${Math.round(world.time - c.spawnedAt)} L${c.level} in=${c.insideGarage} legs=${c.garageLegs.length} lift=${c.pendingLift} merge=${!!c.waitingToMerge} pos=${c.pos.x.toFixed(0)},${c.pos.z.toFixed(0)} target=${c.targetStallId} ends=${c.endsAtStall} await=${c.awaitingParking} queue=${c.queue.length} edge=${c.edge.from}>${c.edge.to}`,
  );
}
