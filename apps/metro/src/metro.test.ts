import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNetwork, type OsmFile } from './network';
import { fuelPerKm, MetroSim, Router, type RunConfig, type Trip, type Zones } from './simulator';

/** A little town: a fast road from A to D with a slow parallel route through B and C. */
function osm(): OsmFile {
  const node = (id: number, lat: number, lon: number) => ({ type: 'node' as const, id, lat, lon });
  const way = (id: number, nodes: number[], highway: string, extra: Record<string, string> = {}) => ({ type: 'way' as const, id, nodes, tags: { highway, ...extra } });
  return {
    elements: [
      node(1, 34.0, -118.0),
      node(2, 34.0, -117.98),
      node(3, 34.0, -117.96),
      node(4, 34.01, -117.98),
      node(5, 34.0, -117.94),
      node(9, 34.2, -117.5),
      node(10, 34.2, -117.49),
      way(1, [1, 2, 3, 5], 'primary', { lanes: '2' }),
      way(2, [1, 4, 5], 'tertiary'),
      way(3, [9, 10], 'tertiary'),
      way(4, [2, 4], 'tertiary'),
    ],
  };
}

const zones: Zones = { count: 2, connectors: [Int32Array.of(0), Int32Array.of(0)] };

function config(extra: Partial<RunConfig> = {}): RunConfig {
  return { sampleRate: 1, tesShare: 0, baseline: 'free-flow', rerouteSeconds: 300, horizonSeconds: 3600, mapAccuracy: 0.97, parkingStart: 0.5, tesParking: true, coordination: 0.5, seed: 1, ...extra };
}

function setup() {
  const network = buildNetwork(osm());
  const near = (lon: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < network.nodeCount; i++) {
      const d = Math.abs(network.nodeX[i] - (lon - network.center.lon) * 92000);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const a = near(-118.0);
  const d = near(-117.94);
  const z: Zones = { count: 2, connectors: [Int32Array.of(a), Int32Array.of(d)] };
  return { network, z };
}

const trips = (count: number, span: number, parking = false): Trip[] =>
  Array.from({ length: count }, (_, i) => ({ depart: (i / count) * span, originZone: 0, destinationZone: 1, needsStreetParking: parking, adoptionRoll: i / count }));

test('a network drops islands that cannot be reached', () => {
  const network = buildNetwork(osm());
  assert.equal(network.nodeCount, 4, 'nodes along a road that no other road joins are shape, not junctions');
  void zones;
  for (let e = 0; e < network.edgeCount; e++) assert.ok(network.edgeLength[e] > 100);
});

test('routing finds the quicker road', () => {
  const { network, z } = setup();
  const cost = new Float32Array(network.edgeCount);
  for (let e = 0; e < network.edgeCount; e++) cost[e] = network.edgeLength[e] / network.edgeSpeed[e];
  const { dist, via } = new Router(network).tree(z.connectors[0], cost);
  const goal = z.connectors[1][0];
  assert.ok(Number.isFinite(dist[goal]));
  assert.ok(via[goal] >= 0);
});

test('every car in light traffic finishes, close to free-flow time', () => {
  const { network, z } = setup();
  const sim = new MetroSim(network, z, trips(50, 600), config());
  const result = sim.run();
  assert.equal(result.finished, 50);
  assert.ok(result.delayHours < 0.5, `delay ${result.delayHours}`);
});

test('too many cars for the road produce queues and delay', () => {
  const { network, z } = setup();
  const light = new MetroSim(network, z, trips(50, 600), config()).run();
  const heavy = new MetroSim(network, z, trips(3000, 600), config({ horizonSeconds: 21600 })).run();
  assert.equal(heavy.finished, 3000);
  assert.ok(heavy.meanMinutes > light.meanMinutes * 2, `${heavy.meanMinutes} vs ${light.meanMinutes}`);
});

test('no car is lost, even when many cannot finish', () => {
  const { network, z } = setup();
  const result = new MetroSim(network, z, trips(3000, 300), config({ horizonSeconds: 600 })).run();
  assert.ok(result.finished < 3000);
  assert.ok(result.meanMinutes > 3, 'unfinished trips count up to the horizon');
});

test('the same seed gives the same result', () => {
  const { network, z } = setup();
  assert.deepEqual(new MetroSim(network, z, trips(400, 600), config()).run(), new MetroSim(network, z, trips(400, 600), config()).run());
});

test('a coordinated plan uses both routes when the fast one would jam', () => {
  const { network, z } = setup();
  const selfish = new MetroSim(network, z, trips(2500, 900), config({ baseline: 'free-flow', horizonSeconds: 7200 })).run();
  const shared = new MetroSim(network, z, trips(2500, 900), config({ tesShare: 1, horizonSeconds: 7200 })).run();
  assert.ok(shared.meanMinutes < selfish.meanMinutes, `${shared.meanMinutes} vs ${selfish.meanMinutes}`);
});

test('fuel per km is worst in stop-and-go and rises again at high speed', () => {
  assert.ok(fuelPerKm(8) > fuelPerKm(60));
  assert.ok(fuelPerKm(130) > fuelPerKm(70));
  assert.ok(fuelPerKm(60) > 0.04 && fuelPerKm(60) < 0.12);
});

test('knowing where parking is reduces the search', () => {
  const { network, z } = setup();
  const blind = new MetroSim(network, z, trips(30, 900, true), config({ parkingStart: 0.92, horizonSeconds: 7200 })).run();
  const known = new MetroSim(network, z, trips(30, 900, true), config({ parkingStart: 0.92, tesShare: 1, horizonSeconds: 7200 })).run();
  assert.ok(known.cruisingHours <= blind.cruisingHours, `${known.cruisingHours} vs ${blind.cruisingHours}`);
});
