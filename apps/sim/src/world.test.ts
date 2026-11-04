import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCity } from '@carmacar/shared';
import { DelayedMapService, runOnce } from './evaluate';
import { World } from './world';

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

test('rerouting during a final approach never teleports the car', () => {
  const world = new World(city, 9, null);
  const hero = world.addHero();
  // Start the car on a street whose stalls are on its right.
  const first = city.stalls[6];
  hero.edge = world.graph.approachEdge(first);
  hero.pos = world.graph.lanePoint(hero.edge, hero.startAlong);
  const second = city.stalls.find((s) => s.segmentId !== first.segmentId)!;
  world.targetStall(hero, first.id);
  for (let i = 0; i < 40 && !hero.endsAtStall; i++) world.tick(0.05);
  assert.ok(hero.endsAtStall, 'hero should be on final approach');
  world.targetStall(hero, second.id);
  let last = { ...hero.pos };
  for (let t = 0; t < 120 && hero.phase === 'drive'; t += 0.05) {
    world.tick(0.05);
    const step = Math.hypot(hero.pos.x - last.x, hero.pos.z - last.z);
    assert.ok(step < 2, `jumped ${step.toFixed(1)} m at t=${t.toFixed(1)}`);
    last = { ...hero.pos };
  }
  assert.equal(hero.stallId, second.id);
  assert.notEqual(world.stallOwner.get(first.id), hero.id);
});

test('the evaluator counts drivers who never found a space', async () => {
  // A nearly full city over a short window: some drivers must still be looking at the end.
  const config = { seed: 3, drivers: 40, spanSeconds: 60, parkedShare: 0.98, networkShare: 0, staleSeconds: 30, horizonSeconds: 120 };
  const result = await runOnce(city, config);
  assert.ok(result.stillSearching > 0, `searching ${result.stillSearching}`);
  assert.equal(result.drivers, result.parked + result.stillSearching);
});

test('reservations stop network cars racing for one stall', async () => {
  let world: World | undefined;
  const service = new DelayedMapService(city, () => world!, 0);
  world = new World(city, 4, service);
  const a = service.findNow('car1', 'd0', []);
  const b = service.findNow('car2', 'd0', []);
  assert.ok(a && b);
  assert.notEqual(a, b);
});
