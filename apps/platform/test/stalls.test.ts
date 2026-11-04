import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinhole, type CameraPose, type Stall } from '@carmacar/shared';
import { Twin } from '../src/twin';
import { generateCity } from '@carmacar/shared';
import { analyzeFrame, lowerHull } from '../src/vision/stalls';
import type { VehicleMask } from '../src/vision/provider';

const stall = (id: string, cx: number): Stall => ({
  id,
  segmentId: 's',
  center: { x: cx, z: 7.2 },
  axis: { x: 1, z: 0 },
  normal: { x: 0, z: 1 },
  length: 6,
  width: 2.4,
  along: 0,
});

const stalls = [stall('S1', 8), stall('S2', 14), stall('S3', 20)];
const pose: CameraPose = { position: [0, 1.4, 2.5], target: [16, 1.2, 7], fovY: 0.9, width: 1280, height: 720 };

/** A filled mask whose bottom edge sits on the ground along a car's street side. */
function carMask(id: string, x1: number, x2: number): VehicleMask {
  const cam = pinhole(pose);
  const a = cam.project([x1, 0, 6.1])!;
  const b = cam.project([x2, 0, 6.1])!;
  const left = Math.floor(Math.min(a[0], b[0]));
  const right = Math.ceil(Math.max(a[0], b[0]));
  const bottom = Math.ceil(Math.max(a[1], b[1]));
  const top = bottom - 60;
  const width = right - left;
  const height = bottom - top;
  const raster = new Uint8Array(width * height);
  for (let col = 0; col < width; col++) {
    const floor = Math.floor(a[1] + (b[1] - a[1]) * ((left + col - a[0]) / (b[0] - a[0] || 1)) - top);
    for (let row = 0; row <= Math.min(floor, height - 1); row++) raster[row * width + col] = 1;
  }
  return { objectId: id, box: [left, top, right, bottom], raster, width, height, svgPath: '' };
}

test('a car in a stall marks that stall, and only that stall, occupied', () => {
  const { observations, assignments } = analyzeFrame([carMask('1', 12, 16)], pose, stalls);
  const byId = Object.fromEntries(observations.map((o) => [o.stallId, o.state]));
  assert.equal(byId.S2, 'occupied');
  assert.equal(assignments.get('1'), 'S2');
  assert.notEqual(byId.S1, 'occupied');
  assert.notEqual(byId.S3, 'occupied');
});

test('the ground line runs between the wheels, not along the raised body', () => {
  // Rows grow downward. Wheels reach row 100 at columns 10 and 90; the body stops at row 80.
  const contour = [];
  for (let col = 0; col <= 100; col++) {
    contour.push({ col, row: col === 10 || col === 90 ? 100 : 80 });
  }
  const hull = lowerHull(contour);
  assert.equal(hull.length, 101);
  assert.equal(hull.find((p) => p.col === 50)?.row, 100);
  assert.equal(hull.find((p) => p.col === 10)?.row, 100);
});

test('a trash pin needs a sighting, and only clears after cameras see the spot empty twice', () => {
  const twin = new Twin(generateCity());
  twin.observeTrash([{ x: 5, z: 5 }], () => true);
  twin.observeTrash([{ x: 5.5, z: 5 }], () => true);
  assert.equal(twin.snapshot(0, false).trashPins.length, 1, 'repeat sightings are one pin');
  twin.observeTrash([], () => false);
  assert.equal(twin.snapshot(0, false).trashPins.length, 1, 'out of view says nothing');
  twin.observeTrash([], () => true);
  assert.equal(twin.snapshot(0, false).trashPins.length, 1);
  twin.observeTrash([], () => true);
  assert.equal(twin.snapshot(0, false).trashPins.length, 0);
});

test('an empty view reports fully visible stalls as free', () => {
  const { observations } = analyzeFrame([], pose, stalls);
  assert.ok(observations.some((o) => o.state === 'free'));
  assert.ok(observations.every((o) => o.state === 'free'));
});

test('a street camera never reads garage stalls, and a garage camera only reads its own level', () => {
  const inGarage = (level: number): Stall => ({ ...stall(`G${level}`, 14), garageId: 'GA', level });
  const garageStalls = [inGarage(0), inGarage(1)];
  assert.equal(analyzeFrame([], pose, garageStalls).observations.length, 0);
  const upstairs: CameraPose = { ...pose, position: [0, 5, 2.5], target: [16, 3.8, 7], garageId: 'GA', level: 1, floorY: 3.6 };
  const ids = analyzeFrame([], upstairs, garageStalls).observations.map((o) => o.stallId);
  assert.deepEqual(ids, ['G1']);
});

test('stalls beyond trust range produce no observation', () => {
  const far = [stall('FAR', 60)];
  assert.equal(analyzeFrame([], pose, far).observations.length, 0);
});

test('the same input gives the same answer', () => {
  const masks = [carMask('1', 12, 16)];
  assert.deepEqual(analyzeFrame(masks, pose, stalls).observations, analyzeFrame(masks, pose, stalls).observations);
});

test('a stall flips on a new pass once old evidence fades', () => {
  const city = generateCity();
  const twin = new Twin(city);
  const id = city.stalls[0].id;
  const t0 = 1_000_000;
  twin.observe([{ stallId: id, state: 'free', weight: 0.1 }], t0);
  twin.observe([{ stallId: id, state: 'free', weight: 0.1 }], t0 + 1000);
  assert.equal(twin.stall(id)?.state, 'free');
  const changed = twin.observe([{ stallId: id, state: 'occupied', weight: 0.1 }], t0 + 40_000);
  assert.equal(twin.stall(id)?.state, 'occupied');
  assert.deepEqual(changed, [{ stallId: id, from: 'free', to: 'occupied' }]);
});

test('reservations stop two cars getting the same stall', () => {
  const city = generateCity();
  const twin = new Twin(city);
  const d = city.destinations[0];
  for (const s of city.stalls) twin.observe([{ stallId: s.id, state: 'free', weight: 0.1 }], Date.now());
  const first = twin.findParking(d)!;
  assert.ok(twin.reserve(first.stall.id, 'car1'));
  const second = twin.findParking(d)!;
  assert.notEqual(second.stall.id, first.stall.id);
  assert.equal(twin.reserve(first.stall.id, 'car2'), false);
});
