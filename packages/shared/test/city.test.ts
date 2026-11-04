import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { buildCity, distance, generateCity, highwayLayout, HighwayShape, pinhole, RoadGraph } from '../src/index';

const city = generateCity();
const graph = new RoadGraph(city);

test('city size matches the plan', () => {
  assert.equal(city.nodes.length, 12);
  assert.equal(city.segments.length, 17);
  const street = city.stalls.filter((s) => !s.garageId);
  assert.ok(street.length >= 80 && street.length <= 150, `street stalls: ${street.length}`);
  assert.equal(city.garages.length, 2);
  assert.equal(new Set(city.stalls.map((s) => s.id)).size, city.stalls.length);
});

test('every stall can be reached from every edge, always on the right', () => {
  const start = graph.next(city.nodes[0].id)[0];
  for (const stall of city.stalls) {
    const approach = graph.approachEdge(stall);
    const chain = graph.route(start, approach);
    const last = chain[chain.length - 1];
    assert.deepEqual(last, approach);
    if (stall.garageId) {
      const g = graph.garage(stall.garageId);
      const dir = graph.edgeDir(approach);
      assert.ok(dir.z * g.inward.x - dir.x * g.inward.z > 0, `${g.id} door should be on the right`);
      continue;
    }
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

test('the highway ring closes, stays outside the town, and turns right toward it', () => {
  const layout = highwayLayout();
  const shape = new HighwayShape(layout);
  const town = generateCity().bounds;
  let previous = shape.at(0);
  for (let s = 1; s <= layout.length; s += 1) {
    const p = shape.at(s);
    assert.ok(Math.hypot(p.x - previous.x, p.z - previous.z) < 1.5, `jump at ${s}`);
    assert.ok(p.x > town.maxX || p.x < town.minX || p.z > town.maxZ || p.z < town.minZ, `inside town at ${s}`);
    const inward = shape.at(s, 10);
    assert.ok(Math.hypot(inward.x, inward.z) < Math.hypot(p.x, p.z), `right is not toward town at ${s}`);
    previous = p;
  }
  const end = shape.at(layout.length - 0.01);
  const start = shape.at(0);
  assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 0.1);
});

test('ramps end near their junction', () => {
  const layout = highwayLayout();
  const shape = new HighwayShape(layout);
  const town = generateCity().bounds;
  for (const ic of layout.interchanges) {
    const s = shape.interchange(ic, town);
    const end = s.offRamp[s.offRamp.length - 1];
    assert.ok(Math.hypot(end.x - s.junction.x, end.z - s.junction.z) < 12);
    assert.ok(Math.hypot(s.onRamp[0].x - s.junction.x, s.onRamp[0].z - s.junction.z) < 12);
  }
});

test('the demo town never changes, so measured results stay valid', () => {
  const text = JSON.stringify(generateCity());
  assert.equal(createHash('sha256').update(text).digest('hex').slice(0, 16), 'e69f013430b8cb98');
});

test('a layout with uneven blocks gives a connected city with stalls on every street', () => {
  const made = buildCity({
    xs: [-120, -40, 70],
    zs: [-90, 35],
    rowStreets: ['South St', 'North St'],
    columnStreets: ['West Ave', 'Middle Ave', 'East Ave'],
    garages: [],
    destinations: [{ name: 'Test Cinema', kind: 'cinema', segment: 'H0-1', along: 0.5, side: 1 }],
    buildings: [{ x: 0, z: 0, w: 20, d: 20, h: 90 }],
  });
  assert.equal(made.nodes.length, 6);
  assert.equal(made.segments.length, 7);
  assert.ok(made.segments.every((seg) => made.stalls.some((stall) => stall.segmentId === seg.id)));
  assert.equal(made.segments.find((seg) => seg.id === 'H0-0')?.length, 80);
  assert.equal(made.bounds.maxX, 130);
  assert.equal(made.buildings?.[0].h, 90);
});

