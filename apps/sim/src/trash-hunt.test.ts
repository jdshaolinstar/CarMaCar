import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCity } from '@carmacar/shared';
import { HUNT_POINTS, ROUND_SECONDS, TrashHunt } from './trash-hunt';
import { World } from './world';

const city = generateCity();

function setup() {
  const world = new World(city, 5);
  world.addWalkers(12, 0, 4);
  const walker = world.takeWalker()!;
  return { world, walker, hunt: new TrashHunt(world, walker, 9) };
}

const ahead = (walker: { pos: { x: number; z: number } }) => ({ x: walker.pos.x + 0.5, z: walker.pos.z });

test('points depend on what you find, and a quick streak multiplies them', () => {
  const { world, walker, hunt } = setup();
  world.litter.clear();
  world.addLitter(ahead(walker), 'can');
  world.pickUpLitter(walker);
  assert.equal(hunt.players[0].score, HUNT_POINTS.can);
  hunt.tick(5);
  world.addLitter(ahead(walker), 'bag');
  world.pickUpLitter(walker);
  assert.equal(hunt.combo, 2);
  assert.equal(hunt.players[0].score, HUNT_POINTS.can + HUNT_POINTS.bag * 2);
  hunt.tick(20);
  assert.equal(hunt.combo, 1);
});

test('rivals pick up trash they can see, and earn points for it', () => {
  const { world, hunt } = setup();
  world.litter.clear();
  const rival = world.walkers.find((w) => w.id === hunt.players[1].id)!;
  world.addLitter({ x: rival.pos.x + 3, z: rival.pos.z }, 'box');
  for (let t = 0; t < 20; t += 1 / 20) world.tick(1 / 20);
  assert.equal(hunt.players[1].score, HUNT_POINTS.box);
  assert.equal(world.litter.size, 0);
});

test('the treasure hint warms up as you get close', () => {
  const { world, walker, hunt } = setup();
  world.litter.clear();
  assert.equal(hunt.treasureHint(), 'gone');
  world.addLitter({ x: walker.pos.x + 200, z: walker.pos.z }, 'treasure');
  assert.equal(hunt.treasureHint(), 'cold');
  world.litter.clear();
  world.addLitter({ x: walker.pos.x + 50, z: walker.pos.z }, 'treasure');
  assert.equal(hunt.treasureHint(), 'warm');
  world.litter.clear();
  world.addLitter({ x: walker.pos.x + 10, z: walker.pos.z }, 'treasure');
  assert.equal(hunt.treasureHint(), 'hot');
});

test('a finished round puts everything back', () => {
  const { world, hunt } = setup();
  world.samaritansEnabled = true;
  hunt.tick(ROUND_SECONDS + 1);
  assert.ok(hunt.over);
  assert.equal(world.rivalSight, 0);
  assert.equal(world.onLitterPicked, null);
  assert.ok(![...world.litter.values()].some((l) => l.kind === 'treasure'));
  const score = hunt.players[0].score;
  world.addLitter(world.walkers[0].pos, 'bag');
  hunt.tick(1);
  assert.equal(hunt.players[0].score, score);
});

test('without a round, nobody knows about trash no camera has reported', () => {
  const world = new World(city, 5);
  world.addWalkers(12, 0, 4);
  assert.equal(world.rivalSight, 0);
  const rival = world.walkers.find((w) => w.role === 'samaritan')!;
  world.addLitter({ x: rival.pos.x + 3, z: rival.pos.z }, 'box');
  for (let t = 0; t < 10; t += 1 / 20) world.tick(1 / 20);
  assert.equal(world.litter.size, 1);
});

test('a round does not change traffic', () => {
  const play = (hunting: boolean) => {
    const world = new World(city, 21);
    world.addWalkers(20, 3, 4);
    world.setDemand(World.makeDemand(city, 22, 30, 60, { guided: 0, autopilot: 0, gps: 0 }));
    if (hunting) new TrashHunt(world, world.takeWalker()!, 9);
    for (let t = 0; t < 60; t += 1 / 20) world.tick(1 / 20);
    return [...world.cars.values()].map((c) => `${c.id}:${c.pos.x.toFixed(3)},${c.pos.z.toFixed(3)}`).sort();
  };
  const plain = play(false);
  assert.ok(plain.length > 0);
  assert.deepEqual(play(true), plain);
});
