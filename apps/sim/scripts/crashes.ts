// Lists every near-collision in a heavy traffic run, with what each car was doing.
//   npx tsx apps/sim/scripts/crashes.ts
import { generateCity } from '@carmacar/shared';
import { World, type Car } from '../src/world';

const city = generateCity();
const seed = Number(process.argv[2] ?? 12);
const world = new World(city, seed, null);
world.populateParked(0.5);
world.addScouts(8);
world.setDemand(World.makeDemand(city, seed + 1, 60, 200, 0));

const seen = new Set<string>();
const kinds = new Map<string, number>();
const describe = (c: Car) => {
  const along = c.path ? Math.round(c.path.length - c.s) : -1;
  return `${c.id} ${c.mode} v=${c.speed.toFixed(1)} junction=${c.junction ?? '-'} turn=${c.movement?.turn ?? '-'} toPathEnd=${along} edge=${c.edge.from}>${c.edge.to} endsAtStall=${c.endsAtStall}`;
};

for (let t = 0; t < 500; t += 1 / 20) {
  world.tick(1 / 20);
  const moving = [...world.cars.values()].filter((c) => c.phase === 'drive');
  for (let i = 0; i < moving.length; i++) {
    for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i];
      const b = moving[j];
      if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) >= 2.6) continue;
      const key = [a.id, b.id].sort().join('+');
      if (seen.has(key)) continue;
      seen.add(key);
      const dot = a.heading.x * b.heading.x + a.heading.z * b.heading.z;
      const kind = `${a.junction || b.junction ? 'junction' : 'street'} ${dot > 0.7 ? 'same-way' : dot < -0.7 ? 'head-on' : 'crossing'}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (seen.size <= 6) console.log(`t=${t.toFixed(1)} ${kind}\n  ${describe(a)}\n  ${describe(b)}`);
    }
  }
}
console.log(`\n${seen.size} pairs`, Object.fromEntries(kinds));
