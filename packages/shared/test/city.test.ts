import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distance, generateCity, pinhole, RoadGraph } from '../src/index';

const city = generateCity();
const graph = new RoadGraph(city);

test('city size matches the plan', () => {
  assert.equal(city.nodes.length, 12);
  assert.equal(city.segments.length, 17);
  assert.ok(city.stalls.length >= 80 && city.stalls.length <= 150, `stalls: ${city.stalls.length}`);
  assert.equal(new Set(city.stalls.map((s) => s.id)).size, city.stalls.length);
});

test('every stall can be reached from every edge, always on the right', () => {
  const start = graph.next(city.nodes[0].id)[0];
  for (const stall of city.stalls) {
    const approach = graph.approachEdge(stall);
    const chain = graph.route(start, approach);
    const last = chain[chain.length - 1];
    assert.deepEqual(last, approach);
    const lane = graph.lanePoint(approach, graph.alongApproach(stall));
    assert.ok(distance(lane, stall.center) < 4, `${stall.id} is ${distance(lane, stall.center)} from its lane`);
  }
});

test('routes contain no U-turns and join up', () => {
  const start = { from: 'n0_0', to: 'n1_0' };
  const chain = graph.route(start, { from: 'n3_2', to: 'n2_2' });
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].from, chain[i - 1].to);
    assert.notEqual(chain[i].to, chain[i - 1].from);
  }
});

test('routing back to the current edge loops around the block', () => {
  const start = { from: 'n0_0', to: 'n1_0' };
  const chain = graph.route(start, start);
  assert.ok(chain.length >= 4, `chain length ${chain.length}`);
  assert.deepEqual(chain[0], start);
  assert.deepEqual(chain[chain.length - 1], start);
});

test('paths are continuous', () => {
  const chain = graph.route({ from: 'n0_0', to: 'n1_0' }, { from: 'n1_1', to: 'n2_1' });
  const path = graph.buildPath(chain, 10, 40);
  for (let i = 1; i < path.points.length; i++) {
    assert.ok(distance(path.points[i - 1], path.points[i]) < 90);
  }
  assert.ok(path.length > 100);
});

test('camera projection and ground back-projection are inverses', () => {
  const cam = pinhole({ position: [0, 1.4, 0], target: [16, 1.2, 4], fovY: 0.9, width: 1280, height: 720 });
  for (const p of [{ x: 12, z: 5 }, { x: 20, z: 2 }, { x: 9, z: 6.5 }]) {
    const px = cam.project([p.x, 0, p.z])!;
    const back = cam.toGround(px[0], px[1])!;
    assert.ok(distance(p, back) < 1e-6);
  }
});
