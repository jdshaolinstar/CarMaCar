// Lists every near-collision in a heavy traffic run, with what each car was doing.
//   npx tsx apps/sim/scripts/crashes.ts [seed] [networkShare]
import { generateCity } from '@carmacar/shared';
import { DelayedMapService } from '../src/evaluate';
import { World, type Car } from '../src/world';

const city = generateCity();
const seed = Number(process.argv[2] ?? 12);
const share = Number(process.argv[3] ?? 0);
let world: World | undefined;
const service = new DelayedMapService(city, () => world!, 20);
world = new World(city, seed, share > 0 ? service : null);
world.populateParked(0.6);
world.addScouts(8);
world.setDemand(World.makeDemand(city, seed + 1, 60, 200, share));

const seen = new Set<string>();
const kinds = new Map<string, number>();
const describe = (c: Car) => {
  const left = c.path ? Math.round(c.path.length - c.s) : -1;
  return `${c.id} ${c.role} L${c.level} in=${c.insideGarage} legs=${c.garageLegs.length} pos=${c.pos.x.toFixed(0)},${c.pos.z.toFixed(0)} ${c.mode} v=${c.speed.toFixed(1)} junction=${c.junction ?? '-'} toPathEnd=${left} edge=${c.edge.from}>${c.edge.to} stall=${c.endsAtStall}:${c.targetStallId}`;
};

for (let t = 0; t < 500; t += 1 / 20) {
  world.tick(1 / 20);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const moving = [...world.cars.values()].filter((c) => c.phase === 'drive' && c.liftT <= 0);
  for (let i = 0; i < moving.length; i++) {
    for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i];
      const b = moving[j];
      if (a.level !== b.level || a.merging || b.merging || world.time - a.mergedAt < 3 || world.time - b.mergedAt < 3 || Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) >= 2.6) continue;
      const key = [a.id, b.id].sort().join('+');
      if (seen.has(key)) continue;
      seen.add(key);
      const dot = a.heading.x * b.heading.x + a.heading.z * b.heading.z;
      const kind = `${a.junction || b.junction ? 'junction' : a.insideGarage || b.insideGarage ? 'garage' : 'street'} ${dot > 0.7 ? 'same-way' : dot < -0.7 ? 'head-on' : 'crossing'}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (seen.size <= 6) console.log(`t=${t.toFixed(1)} ${kind}\n  ${describe(a)}\n  ${describe(b)}`);
    }
  }
}
console.log(`\n${seen.size} pairs`, Object.fromEntries(kinds));
