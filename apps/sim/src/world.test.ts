import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCity } from '@carmacar/shared';
import { DelayedMapService, runOnce } from './evaluate';
import { navigate } from './nav';
import { World, type Car } from './world';

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

/** Known issue in HANDOFF.md: garage doors can see one low-speed contact. Nothing else is excused. */
const isMerging = (car: Car, world: World) => car.merging || world.time - car.mergedAt < 3;

/** Moving cars closer than this are overlapping. Lanes are 3.6 m apart, so passing traffic is fine. */
const CRASH_DISTANCE = 2.6;

function countCrashes(world: World, seconds: number) {
  const seen = new Set<string>();
  for (let t = 0; t < seconds; t += 1 / 20) {
    world.tick(1 / 20);
    const moving = [...world.cars.values()].filter((c) => c.phase === 'drive' && c.liftT <= 0);
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i];
        const b = moving[j];
        if (a.level !== b.level || isMerging(a, world) || isMerging(b, world)) continue;
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < CRASH_DISTANCE) seen.add([a.id, b.id].sort().join('+'));
      }
    }
  }
  return seen.size;
}

test('heavy traffic never crashes, with lights on', () => {
  for (const seed of [12, 21, 34, 55]) {
    const world = new World(city, seed, null);
    world.populateParked(0.5);
    world.addScouts(8);
    world.setDemand(World.makeDemand(city, seed + 1, 60, 200, 0));
    assert.equal(countCrashes(world, 500), 0, `seed ${seed}`);
  }
});

test('traffic keeps moving and drivers still park', () => {
  const world = new World(city, 14, null);
  world.populateParked(0.5);
  world.addScouts(8);
  world.setDemand(World.makeDemand(city, 15, 60, 200, 0));
  run(world, 500);
  assert.ok(world.parkedLog.length >= 50, `parked ${world.parkedLog.length} of 60`);
  const scoutsMoved = [...world.cars.values()].filter((c) => c.role === 'scout').every((c) => c.meters > 1000);
  assert.ok(scoutsMoved, 'scouts should not be gridlocked');
});

test('a car waits at a red light', () => {
  const world = new World(city, 16, null);
  const hero = world.addHero();
  hero.edge = { from: 'n0_1', to: 'n1_1' };
  // The one thing that must never happen: crossing the stop line on a solid red.
  let ranRed = false;
  let stoppedAtRed = false;
  for (let t = 0; t < 300; t += 1 / 20) {
    const edge = hero.edge;
    const wasWaiting = !hero.junction;
    world.tick(1 / 20);
    const state = world.signals.state(edge.to, world.graph.edgeDir(edge), world.time);
    if (wasWaiting && hero.junction && state === 'red') ranRed = true;
    if (hero.speed < 0.1 && state === 'red' && hero.stopS - hero.s < 3) stoppedAtRed = true;
  }
  assert.equal(ranRed, false);
  assert.ok(stoppedAtRed, 'expected the car to meet at least one red light');
});

test('a driven car moves, and buildings stop it', () => {
  const world = new World(city, 18, null);
  const hero = world.addHero();
  world.takeControl(hero);
  hero.control!.throttle = 1;
  run(world, 3);
  assert.ok(hero.speed > 5, `speed ${hero.speed}`);
  const before = { ...hero.pos };
  // Turn hard right and hold the throttle: the car must never end up inside a block.
  hero.control!.steer = 1;
  for (let t = 0; t < 30; t += 1 / 20) {
    world.tick(1 / 20);
    assert.ok(world.isDrivable(hero.pos), `left the road at ${JSON.stringify(hero.pos)}`);
  }
  assert.notDeepEqual(hero.pos, before);
});

test('a driven car cannot pass through a parked car', () => {
  const world = new World(city, 19, null);
  const stall = city.stalls[3];
  world.parkCarInStall(stall, 0, '#c62828', true);
  const hero = world.addHero();
  world.takeControl(hero);
  const dir = world.graph.edgeDir(world.graph.approachEdge(stall));
  hero.heading = dir;
  hero.pos = { x: stall.center.x - dir.x * 12, z: stall.center.z - dir.z * 12 };
  hero.control!.throttle = 1;
  for (let t = 0; t < 10; t += 1 / 20) {
    world.tick(1 / 20);
    const gap = Math.hypot(hero.pos.x - stall.center.x, hero.pos.z - stall.center.z);
    assert.ok(gap > 2.5, `overlapped at ${gap.toFixed(2)} m`);
  }
});

test('directions name the next turn and the stall', () => {
  const world = new World(city, 20, null);
  const hero = world.addHero();
  const stall = city.stalls.find((s) => s.segmentId === 'H0-2')!;
  hero.targetStallId = stall.id;
  const step = navigate(world, hero)!;
  assert.ok(step, 'expected directions');
  assert.match(step.instruction, /Turn|Continue/);
  assert.ok(step.path.length > 50);
  hero.edge = world.graph.approachEdge(stall);
  hero.pos = world.graph.lanePoint(hero.edge, world.graph.alongApproach(stall) - 3);
  assert.equal(navigate(world, hero)!.icon, 'park');
});

test('parking by hand fills the stall', () => {
  const world = new World(city, 21, null);
  const stall = city.stalls[8];
  const hero = world.addHero();
  world.takeControl(hero);
  hero.pos = { x: stall.center.x, z: stall.center.z };
  assert.equal(world.togglePark(hero), stall.id);
  assert.equal(world.stallOwner.get(stall.id), hero.id);
  assert.equal(hero.phase, 'parked');
});

test('mixed network and manual traffic never crashes', async () => {
  for (const seed of [12, 34, 77]) {
    let world: World | undefined;
    const service = new DelayedMapService(city, () => world!, 20);
    world = new World(city, seed, service);
    world.populateParked(0.6);
    world.addScouts(8);
    world.setDemand(World.makeDemand(city, seed + 1, 60, 200, 0.7));
    const seen = new Set<string>();
    for (let t = 0; t < 500; t += 1 / 20) {
      world.tick(1 / 20);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const moving = [...world.cars.values()].filter((c) => c.phase === 'drive' && c.liftT <= 0);
      for (let i = 0; i < moving.length; i++) {
        for (let j = i + 1; j < moving.length; j++) {
          const a = moving[i];
          const b = moving[j];
          if (a.level !== b.level || isMerging(a, world) || isMerging(b, world)) continue;
          if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < CRASH_DISTANCE) seen.add([a.id, b.id].sort().join('+'));
        }
      }
    }
    assert.equal(seen.size, 0, `seed ${seed}`);
  }
});

test('network drivers all get parked, without jams or broken routes', async () => {
  for (const seed of [1, 2, 3]) {
    const result = await runOnce(city, {
      seed,
      drivers: 40,
      spanSeconds: 240,
      parkedShare: 0.75,
      networkShare: 1,
      staleSeconds: 30,
      horizonSeconds: 700,
    });
    assert.equal(result.drivers, 40, `seed ${seed}: drivers lost`);
    assert.ok(result.parked >= 38, `seed ${seed}: parked ${result.parked} of 40`);
  }
});

test('parked cars in the live city pull out and go somewhere', () => {
  const world = new World(city, 22, null);
  world.keepCarsInCity = true;
  world.networkShare = 0;
  world.populateParked(0.6);
  const startingIds = new Set(world.cars.keys());
  run(world, 300);
  const travelled = [...world.cars.values()].filter((c) => startingIds.has(c.id) && c.destinationId);
  assert.ok(travelled.length > 10, `only ${travelled.length} left their stall`);
  assert.equal(world.cars.size, startingIds.size, 'cars should stay in the city');
});

test('a parked car can be driven: it pulls out, then obeys the keyboard', () => {
  const world = new World(city, 23, null);
  const car = world.parkCarInStall(city.stalls[5], 0, '#c62828', true)!;
  assert.ok(world.takeControl(car));
  run(world, 6);
  assert.equal(car.phase, 'drive');
  assert.ok(car.control);
  assert.equal(world.stallOwner.has(city.stalls[5].id), false);
});

test('a car drives into a garage, rides up, parks, and later leaves', () => {
  const world = new World(city, 24, null);
  const hero = world.addHero();
  const stall = city.stalls.find((s) => s.garageId === 'GA' && s.level === 2)!;
  world.targetStall(hero, stall.id);
  let last = { ...hero.pos };
  let peakLevel = 0;
  for (let t = 0; t < 200 && hero.phase !== 'parked'; t += 1 / 20) {
    world.tick(1 / 20);
    const jump = Math.hypot(hero.pos.x - last.x, hero.pos.z - last.z);
    assert.ok(jump < 2, `jumped ${jump.toFixed(1)} m at t=${t.toFixed(1)}`);
    last = { ...hero.pos };
    peakLevel = Math.max(peakLevel, hero.level);
  }
  assert.equal(hero.stallId, stall.id);
  assert.equal(peakLevel, 2);
  assert.equal(world.stallOwner.get(stall.id), hero.id);

  // leaveAt for the hero is 40 s after parking.
  for (let t = 0; t < 120 && hero.insideGarage; t += 1 / 20) world.tick(1 / 20);
  assert.equal(hero.insideGarage, false);
  assert.equal(hero.level, 0);
  assert.equal(world.stallOwner.has(stall.id), false);
  assert.ok(world.isDrivable(hero.pos));
});

test('a driver can ride the transporter by hand, and only on the pad', () => {
  const world = new World(city, 25, null);
  const g = city.garages[0];
  const hero = world.addHero();
  world.takeControl(hero);
  assert.equal(world.useTransporter(hero, 1), false);
  hero.pos = { x: g.pad.x, z: g.pad.z };
  hero.speed = 0;
  assert.equal(world.useTransporter(hero, 2), true);
  run(world, 3);
  assert.equal(hero.level, 2);
  assert.equal(world.isDrivable({ x: g.door.x, z: g.door.z - 4 }, 2), false, 'no driveway on upper floors');
});

test('a mixed city with garages stays free of same-level crashes', async () => {
  let world: World | undefined;
  const service = new DelayedMapService(city, () => world!, 20);
  world = new World(city, 26, service);
  world.keepCarsInCity = true;
  world.populateParked(0.7);
  world.addScouts(6);
  world.setDemand(World.makeDemand(city, 27, 40, 150, 0.7));
  const seen = new Set<string>();
  for (let t = 0; t < 400; t += 1 / 20) {
    world.tick(1 / 20);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const moving = [...world.cars.values()].filter((c) => c.phase === 'drive' && c.liftT <= 0);
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i];
        const b = moving[j];
        if (a.level !== b.level || isMerging(a, world) || isMerging(b, world)) continue;
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < CRASH_DISTANCE) seen.add([a.id, b.id].sort().join('+'));
      }
    }
  }
  assert.equal(seen.size, 0);
  assert.ok(world.parkedLog.length > 20, `parked ${world.parkedLog.length}`);
});

test('good samaritans only go to litter the network has pinned, and earn karma', () => {
  const world = new World(city, 28, null);
  world.addWalkers(30, 0, 12);
  world.scatterLitter(10);
  run(world, 60);
  assert.equal(world.litter.size, 10, 'nobody should know about unpinned litter');
  world.litterPins = [...world.litter.values()].map((l) => ({ id: l.id, x: l.pos.x, z: l.pos.z }));
  run(world, 300);
  assert.ok(world.litter.size < 10, `still ${world.litter.size} left`);
  assert.equal(world.cleanupKarma, (10 - world.litter.size) * 10);
});

test('self-routed drivers use garages once they give up on the street', () => {
  const world = new World(city, 29, null);
  // Streets full, garages empty: the only way to park is a garage.
  for (const stall of city.stalls) if (!stall.garageId) world.parkCarInStall(stall, 0, '#555555', true);
  world.setDemand(World.makeDemand(city, 30, 15, 60, 0));
  run(world, 400);
  const inGarage = [...world.stallOwner.keys()].filter((id) => world.stalls.get(id)?.garageId).length;
  assert.ok(inGarage >= 5, `only ${inGarage} used a garage`);
});

test('a person on foot can walk to trash and pick it up', () => {
  const world = new World(city, 31, null);
  world.addWalkers(5, 0, 0);
  const walker = world.takeWalker()!;
  world.tick(0.05);
  world.addLitter({ x: walker.pos.x + walker.heading.x * 1.5, z: walker.pos.z + walker.heading.z * 1.5 });
  assert.equal(world.pickUpLitter(walker), 10);
  assert.equal(world.litter.size, 0);
  assert.equal(world.cleanupKarma, 10);
  walker.input!.forward = 1;
  const start = { ...walker.pos };
  run(world, 2);
  assert.notDeepEqual(walker.pos, start);
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
