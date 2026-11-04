import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCity } from '@carmacar/shared';
import { World, type ParkingService } from './world';

const city = generateCity();

function run(world: World, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 20) world.tick(1 / 20);
}

test('scouts keep driving and stay on the road network', () => {
  const world = new World(city, 1, null);
  world.addScouts(6);
  run(world, 120);
  for (const car of world.cars.values()) {
    assert.ok(car.meters > 300, `${car.id} moved only ${car.meters}`);
    assert.ok(Number.isFinite(car.pos.x) && Number.isFinite(car.pos.z));
  }
});

test('manual drivers find a stall by looking, and stalls are never double-booked', () => {
  const world = new World(city, 2, null);
  world.populateParked(0.6);
  world.setDemand(World.makeDemand(city, 3, 20, 40, 0));
  run(world, 400);
  assert.ok(world.parkedLog.length >= 12, `parked ${world.parkedLog.length}`);
  const owners = [...world.stallOwner.values()];
  assert.equal(new Set(owners).size, owners.length);
  for (const [stallId, carId] of world.stallOwner) {
    const car = world.cars.get(carId);
    assert.ok(car, `stall ${stallId} owned by a missing car`);
    assert.equal(car.stallId, stallId);
  }
});

test('a perfect parking service beats cruising on the same demand', () => {
  const measure = (share: number) => {
    const free = (w: World): ParkingService => ({
      async find(_car, destinationId, _from, exclude) {
        const d = city.destinations.find((x) => x.id === destinationId)!;
        const open = city.stalls
          .filter((s) => !w.stallOwner.has(s.id) && !exclude.includes(s.id))
          .sort((a, b) => Math.hypot(a.center.x - d.x, a.center.z - d.z) - Math.hypot(b.center.x - d.x, b.center.z - d.z));
        return open[0]?.id ?? null;
      },
      release() {},
    });
    const holder: { w?: World } = {};
    const world = new World(city, 5, { find: (...a) => free(holder.w!).find(...a), release() {} });
    holder.w = world;
    world.populateParked(0.75);
    world.setDemand(World.makeDemand(city, 7, 25, 60, share));
    return world;
  };
  const avg = (w: World) => {
    const log = w.parkedLog;
    return log.reduce((t, r) => t + r.meters, 0) / log.length;
  };
  const off = measure(0);
  run(off, 500);
  const on = measure(1);
  // Promises must settle between ticks.
  return (async () => {
    for (let t = 0; t < 500; t += 1 / 20) {
      on.tick(1 / 20);
      if (Math.round(t * 20) % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    assert.ok(on.parkedLog.length > 0 && off.parkedLog.length > 0);
    assert.ok(avg(on) < avg(off), `on ${avg(on)} vs off ${avg(off)}`);
  })();
});
