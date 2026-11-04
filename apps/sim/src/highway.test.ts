import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HighwayTes, highwayLayout, MPH, ringAhead, surfaceSeconds, type HighwayTesOptions } from '@carmacar/shared';
import { HighwaySim, makeHighwayDemand, type HighwayConfig } from './highway';

const layout = highwayLayout();
const allOff: HighwayTesOptions = { cameras: false, prepare: false, keepLeft: false, rebalance: false, smartSignals: false, harmonize: false };

function config(perHour: number, seconds: number, extra: Partial<HighwayConfig> = {}): HighwayConfig {
  return {
    speedLimit: 65 * MPH,
    demand: makeHighwayDemand(layout, 3, perHour, seconds, [1, 1, 1, 1, 1]),
    mix: { guidedShare: 0, autopilotShare: 0 },
    tes: null,
    horizonSeconds: seconds + 400,
    crossRate: 0.1,
    cameraRecall: 0.97,
    seed: 3,
    ...extra,
  };
}

test('ring distances wrap', () => {
  assert.equal(ringAhead(layout, layout.length - 10, 15), 25);
  assert.equal(ringAhead(layout, 100, 100), 0);
});

test('the home exit has the shortest surface trip', () => {
  for (let exit = 1; exit < layout.interchanges.length; exit++) assert.ok(surfaceSeconds(layout, 0, 0) < surfaceSeconds(layout, 0, exit));
});

test('light traffic flows near the limit with no overlaps', () => {
  const result = new HighwaySim(layout, config(600, 300)).run();
  assert.equal(result.finished, result.trips);
  assert.equal(result.overlaps, 0);
  assert.ok(result.meanMainlineMph > 50, `speed ${result.meanMainlineMph}`);
  assert.ok(result.missedExits / result.trips < 0.1, `missed ${result.missedExits}`);
});

test('the same seed gives the same run', () => {
  const a = new HighwaySim(layout, config(1800, 200)).run();
  const b = new HighwaySim(layout, config(1800, 200)).run();
  assert.deepEqual(a, b);
});

test('heavy traffic never overlaps cars and no car is lost', () => {
  const sim = new HighwaySim(layout, config(3600, 240));
  const result = sim.run();
  assert.equal(result.overlaps, 0);
  assert.equal(sim.cars.length, result.trips);
});

test('a driver keeps their identity across adoption levels', () => {
  const a = new HighwaySim(layout, config(1800, 120, { mix: { guidedShare: 0.2, autopilotShare: 0 } }));
  const b = new HighwaySim(layout, config(1800, 120, { mix: { guidedShare: 0.6, autopilotShare: 0 } }));
  while (a.time < 120) a.step();
  while (b.time < 120) b.step();
  const guidedA = a.cars.filter((c) => c.driver === 'guided').map((c) => c.id);
  const guidedB = new Set(b.cars.filter((c) => c.driver === 'guided').map((c) => c.id));
  assert.ok(guidedA.length > 0);
  for (const id of guidedA) assert.ok(guidedB.has(id));
});

test('TES knows nothing it was not told', () => {
  const tes = new HighwayTes(layout, { ...allOff, cameras: true }, () => 30);
  assert.ok(tes.estimates(10).every((e) => e.queue === 0 && e.arriving === 0));
  assert.equal(tes.advise(10).size, 0);
});

test('a ramp camera reveals cars that are not reporting', () => {
  const tes = new HighwayTes(layout, { ...allOff, cameras: true }, () => 30);
  for (let t = 0; t < 100; t += 5) {
    // Three of twelve cars on the ramp report GPS. The camera sees all twelve.
    for (let i = 0; i < 3; i++) tes.reportCar({ carId: `c${i}`, place: 'offramp', s: 0, lane: 0, speed: 0, exit: 1, zone: 1 }, t);
    tes.reportRampCamera(1, 12, 0, t);
    tes.estimates(t);
  }
  assert.ok(Math.abs(tes.reportingShare - 0.25) < 0.05, `share ${tes.reportingShare}`);
  assert.equal(tes.estimates(100)[1].queue, 12);
});

test('without cameras TES leaves the signal timing alone', () => {
  const tes = new HighwayTes(layout, { ...allOff, smartSignals: true }, () => 30);
  tes.reportCar({ carId: 'a', place: 'offramp', s: 0, lane: 0, speed: 0, exit: 0, zone: 0 }, 1);
  assert.equal(tes.rampGreen(0, 1), layout.baseRampGreen);
});

test('exit choice moves cars away from a full ramp, one at a time', () => {
  const tes = new HighwayTes(layout, { ...allOff, cameras: true, rebalance: true }, () => 30);
  tes.reportRampCamera(2, 20, 0, 1);
  const before = layout.interchanges[2].offAt - 900;
  for (let i = 0; i < 40; i++) tes.reportCar({ carId: `c${i}`, place: 'main', s: (before + layout.length + i * 3) % layout.length, lane: 1, speed: 28, exit: 2, zone: 2 }, 1);
  const advice = [...tes.advise(1).values()];
  const moved = advice.filter((a) => a.exit !== 2).length;
  assert.ok(moved > 0, 'some cars switch exits');
  assert.ok(moved < advice.length, 'not all of them herd to the same place');
});
